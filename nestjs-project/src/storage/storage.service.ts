import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import {
  ABORT_INCOMPLETE_MULTIPART_DAYS,
  ABORT_INCOMPLETE_MULTIPART_RULE_ID,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType?: string;
}

export interface RangedObject {
  stream: Readable;
  contentLength: number;
  contentRange?: string;
  contentType?: string;
}

/**
 * The single gateway to object storage. No other module talks to the AWS SDK
 * directly, which is what keeps TD-10's endpoint duality in one place.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBuckets();
  }

  get videosBucket(): string {
    return this.config.videosBucket;
  }

  get thumbnailsBucket(): string {
    return this.config.thumbnailsBucket;
  }

  /**
   * Idempotent: creates both buckets only if missing, so the Compose stack is
   * self-provisioning and a restart is a no-op.
   */
  async ensureBuckets(): Promise<void> {
    await this.ensureBucket(this.config.videosBucket);
    await this.ensureBucket(this.config.thumbnailsBucket);
    await this.ensureAbortIncompleteMultipartRule(this.config.videosBucket);
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch {
      // HeadBucket throws for a missing bucket; fall through and create it.
    }

    try {
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: bucket }),
      );
      this.logger.log(`Created bucket "${bucket}"`);
    } catch (error) {
      // A concurrent starter (API and worker boot together) may have won the race.
      const name = (error as { name?: string }).name;
      if (
        name !== 'BucketAlreadyOwnedByYou' &&
        name !== 'BucketAlreadyExists'
      ) {
        throw error;
      }
    }
  }

  /**
   * Incomplete multipart uploads never expire on their own and are billed for the
   * storage their parts occupy, so the videos bucket asks the store to reap them.
   *
   * AWS S3 honours this. MinIO (verified on RELEASE.2025-09-07T16-13-09Z) does not:
   * it rejects a rule whose only action is AbortIncompleteMultipartUpload with
   * InvalidArgument, and when the action is paired with an Expiration it accepts
   * the request but silently stores only the Expiration. Because a store without
   * lifecycle support must not stop the application from booting, the rule is
   * best-effort: it is written, read back, and a warning is logged when the store
   * did not keep it. Orphan parts are covered in that case by the explicit
   * abortMultipartUpload calls on every failure path and by DELETE /videos/:id/upload.
   */
  private async ensureAbortIncompleteMultipartRule(
    bucket: string,
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: ABORT_INCOMPLETE_MULTIPART_RULE_ID,
                Status: 'Enabled',
                Filter: { Prefix: '' },
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: ABORT_INCOMPLETE_MULTIPART_DAYS,
                },
              },
            ],
          },
        }),
      );

      const stored = await this.internalClient.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      );

      const kept = (stored.Rules ?? []).some(
        (rule) => rule.AbortIncompleteMultipartUpload !== undefined,
      );

      if (!kept) {
        this.logger.warn(
          `Storage accepted but did not persist the "${ABORT_INCOMPLETE_MULTIPART_RULE_ID}" ` +
            `lifecycle rule on "${bucket}". Orphan multipart parts rely on explicit aborts.`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Storage rejected the "${ABORT_INCOMPLETE_MULTIPART_RULE_ID}" lifecycle rule on ` +
          `"${bucket}" (${(error as { name?: string }).name ?? 'unknown error'}). ` +
          `Orphan multipart parts rely on explicit aborts.`,
      );
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!response.UploadId) {
      throw new Error(`Storage did not return an UploadId for key "${key}"`);
    }

    return response.UploadId;
  }

  /** Signed with the public client — the client uploading the part is external. */
  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.videosBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;

    do {
      const response = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.config.videosBucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );

      for (const part of response.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          size: part.Size ?? 0,
          etag: part.ETag ?? '',
        });
      }

      partNumberMarker = response.IsTruncated
        ? response.NextPartNumberMarker
        : undefined;
    } while (partNumberMarker);

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    // S3 assembles parts in ascending part-number order and rejects an unsorted list.
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.videosBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.videosBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string, bucket?: string): Promise<ObjectHead> {
    const response = await this.internalClient.send(
      new HeadObjectCommand({
        Bucket: bucket ?? this.config.videosBucket,
        Key: key,
      }),
    );

    return {
      contentLength: Number(response.ContentLength ?? 0),
      contentType: response.ContentType,
    };
  }

  async objectExists(key: string, bucket?: string): Promise<boolean> {
    try {
      await this.headObject(key, bucket);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads the object (optionally a byte range) through the internal client and
   * hands back the raw stream, so the caller can pipe it with backpressure
   * instead of buffering.
   */
  async getObjectRange(
    key: string,
    range?: string,
    bucket?: string,
  ): Promise<RangedObject> {
    const response = await this.internalClient.send(
      new GetObjectCommand({
        Bucket: bucket ?? this.config.videosBucket,
        Key: key,
        Range: range,
      }),
    );

    return {
      stream: response.Body as Readable,
      contentLength: Number(response.ContentLength ?? 0),
      contentRange: response.ContentRange,
      contentType: response.ContentType,
    };
  }

  /** Signed with the public client — handed to a browser following a redirect. */
  async signGetObject(
    key: string,
    expiresIn: number,
    options: {
      bucket?: string;
      responseContentDisposition?: string;
      responseContentType?: string;
    } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: options.bucket ?? this.config.videosBucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
        ResponseContentType: options.responseContentType,
      }),
      { expiresIn },
    );
  }

  /**
   * Signed with the internal client — consumed by the worker, which resolves the
   * storage host over the Compose network.
   */
  async signInternalGetObject(
    key: string,
    expiresIn: number,
    bucket?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({
        Bucket: bucket ?? this.config.videosBucket,
        Key: key,
      }),
      { expiresIn },
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    bucket?: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: bucket ?? this.config.videosBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string, bucket?: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({
        Bucket: bucket ?? this.config.videosBucket,
        Key: key,
      }),
    );
  }
}
