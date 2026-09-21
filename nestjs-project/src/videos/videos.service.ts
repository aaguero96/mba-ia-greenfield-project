import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import appConfig from '../config/app.config';
import videoConfig from '../config/video.config';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidUploadStateException,
  PartCountExceededException,
  PartNumberOutOfRangeException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { videoSourceKey } from '../storage/storage.keys';
import { Video } from './entities/video.entity';
import { generatePublicId } from './video-public-id.util';
import { buildVideoUrls } from './video-urls.util';
import { buildAttachmentDisposition } from './content-disposition.util';
import {
  formatContentRange,
  parseRangeHeader,
  toRangeHeader,
} from './range.util';
import { VideoQueueService } from './video-queue.service';
import { VIDEO_PUBLIC_ID_MAX_ATTEMPTS } from './videos.constants';
import type { CompletedPartDto } from './dto/complete-upload.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type {
  InitiateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import type {
  SignPartsResponseDto,
  UploadStatusResponseDto,
} from './dto/upload-status.dto';

const UNIQUE_VIOLATION = '23505';

export type StreamResponse =
  | {
      kind: 'full';
      stream: Readable;
      contentLength: number;
      contentType: string;
    }
  | {
      kind: 'partial';
      stream: Readable;
      contentLength: number;
      contentRange: string;
      contentType: string;
    }
  | { kind: 'unsatisfiable'; size: number };

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly videoQueue: VideoQueueService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the multipart upload, so the
   * client can push bytes straight to storage. The API never sees the file.
   */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const channel = await this.dataSource
      .getRepository(Channel)
      .findOne({ where: { user_id: userId } });

    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const partSize = this.config.partSizeBytes;
    const partCount = Math.ceil(dto.size_bytes / partSize);

    if (partCount > this.config.maxParts) {
      throw new PartCountExceededException();
    }

    const video = await this.persistDraft(channel, dto, partSize, partCount);

    return {
      video: this.toResponse(video, channel),
      upload: {
        upload_id: video.upload_id as string,
        part_size: partSize,
        part_count: partCount,
      },
    };
  }

  /**
   * Creates the row and the multipart upload together. `public_id` is random, so
   * a collision is theoretically possible: the unique constraint is what
   * guarantees "sem conflito", and the retry is what turns that guarantee into a
   * successful request. The multipart upload is aborted if persisting fails, so
   * a failed initiation leaves no orphan upload behind.
   */
  private async persistDraft(
    channel: Channel,
    dto: InitiateUploadDto,
    partSize: number,
    partCount: number,
  ): Promise<Video> {
    let lastError: unknown;

    for (let attempt = 0; attempt < VIDEO_PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      const video = this.videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: dto.title,
        original_filename: dto.filename,
        content_type: dto.content_type,
        size_bytes: String(dto.size_bytes),
        part_size_bytes: partSize,
        part_count: partCount,
        status: 'draft',
        storage_key: '',
      });

      // The key embeds the row id, so it is only final once the id exists.
      video.id = randomUUID();
      video.storage_key = videoSourceKey(channel.id, video.id, dto.filename);

      const uploadId = await this.storage.createMultipartUpload(
        video.storage_key,
        dto.content_type,
      );
      video.upload_id = uploadId;

      try {
        return await this.videoRepository.save(video);
      } catch (error) {
        await this.safeAbort(video.storage_key, uploadId);

        if (!this.isPublicIdCollision(error)) {
          throw error;
        }

        lastError = error;
        this.logger.warn('public_id collision, retrying with a new identifier');
      }
    }

    throw lastError;
  }

  /**
   * Returns fresh pre-signed URLs for the requested parts. Re-signing is what
   * makes a 6h upload TTL enough: a client whose URLs expired mid-transfer asks
   * again instead of restarting the upload.
   */
  async signUploadParts(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<SignPartsResponseDto> {
    const video = await this.findOwnedUploadable(userId, publicId);

    const out_of_range = partNumbers.filter(
      (partNumber) => partNumber > video.part_count,
    );
    if (out_of_range.length > 0) {
      throw new PartNumberOutOfRangeException();
    }

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.signUploadPart(
          video.storage_key,
          video.upload_id as string,
          partNumber,
          this.config.uploadUrlTtl,
        ),
        expires_in: this.config.uploadUrlTtl,
      })),
    );

    return { parts };
  }

  /**
   * Reports which parts storage already holds, so an interrupted client resumes
   * rather than re-uploading what it already sent.
   */
  async getUploadStatus(
    userId: string,
    publicId: string,
  ): Promise<UploadStatusResponseDto> {
    const video = await this.findOwnedUploadable(userId, publicId);

    const uploaded = await this.storage.listParts(
      video.storage_key,
      video.upload_id as string,
    );

    return {
      upload_id: video.upload_id as string,
      part_size: video.part_size_bytes,
      part_count: video.part_count,
      uploaded_parts: uploaded.map((part) => ({
        part_number: part.partNumber,
        size: part.size,
        etag: part.etag,
      })),
    };
  }

  /**
   * Assembles the object, verifies it against the declared size, moves the video
   * to `processing` and enqueues the job.
   *
   * The size check is the enforcement point of the 10GB limit: `size_bytes` is
   * client-supplied, so the only authoritative source is the stored object, read
   * with a single `HeadObject` metadata call. A mismatch aborts everything before
   * any job is queued.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    parts: CompletedPartDto[],
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedUploadable(userId, publicId);
    const uploadId = video.upload_id as string;

    await this.storage.completeMultipartUpload(
      video.storage_key,
      uploadId,
      parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    const head = await this.storage.headObject(video.storage_key);

    if (String(head.contentLength) !== video.size_bytes) {
      await this.rejectSizeMismatch(video, head.contentLength);
      throw new UploadSizeMismatchException();
    }

    video.status = 'processing';
    video.upload_id = null;
    video.processing_error = null;
    const saved = await this.videoRepository.save(video);

    // Enqueued only after the row is committed, so a job never points at a
    // video that is not in `processing`.
    await this.videoQueue.enqueueProcessing(saved.id);

    return this.toResponse(saved, video.channel);
  }

  private async rejectSizeMismatch(
    video: Video,
    actualLength: number,
  ): Promise<void> {
    this.logger.warn(
      `Size mismatch for video ${video.public_id}: declared ${video.size_bytes}, stored ${actualLength}`,
    );

    try {
      await this.storage.deleteObject(video.storage_key);
    } catch (error) {
      this.logger.warn(`Failed to delete mismatched object: ${String(error)}`);
    }

    video.status = 'failed';
    video.upload_id = null;
    video.processing_error = `Uploaded size ${actualLength} does not match the declared size ${video.size_bytes}`;
    await this.videoRepository.save(video);
  }

  /**
   * Cancels a draft: aborts the multipart upload and removes the row. This is
   * the clean way to walk away from an upload, and it is what keeps orphan parts
   * from accumulating on a store without lifecycle support.
   */
  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedUploadable(userId, publicId);

    await this.safeAbort(video.storage_key, video.upload_id as string);
    await this.videoRepository.remove(video);
  }

  /**
   * Loads a video for a read operation.
   *
   * A video that is not `ready` is reported as **not found** to anyone but its
   * owner, rather than forbidden: a 403 would confirm that the id exists. The
   * owner sees their own videos in any status, which is what makes an upload
   * observable while it is still being processed.
   */
  async findPublic(publicId: string, currentUserId?: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner =
      currentUserId !== undefined && video.channel.user_id === currentUserId;

    if (video.status !== 'ready' && !isOwner) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  async getPublicVideo(
    publicId: string,
    currentUserId?: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findPublic(publicId, currentUserId);
    return this.toResponse(video, video.channel);
  }

  /** A playable video — the guard in front of streaming and download. */
  async findPlayable(
    publicId: string,
    currentUserId?: string,
  ): Promise<Video> {
    const video = await this.findPublic(publicId, currentUserId);

    if (video.status !== 'ready') {
      throw new VideoNotReadyException();
    }

    return video;
  }

  /**
   * Resolves a streaming request into what the controller has to send.
   *
   * Ranges are parsed and clamped server-side, then re-issued to storage, so the
   * API transfers only the requested slice — a player asking for a few MB never
   * causes a multi-gigabyte read.
   */
  async openStream(
    publicId: string,
    rangeHeader: string | undefined,
    currentUserId?: string,
  ): Promise<StreamResponse> {
    const video = await this.findPlayable(publicId, currentUserId);
    const head = await this.storage.headObject(video.storage_key);
    const parsed = parseRangeHeader(rangeHeader, head.contentLength);

    if (parsed.kind === 'unsatisfiable') {
      return { kind: 'unsatisfiable', size: head.contentLength };
    }

    if (parsed.kind === 'none') {
      const object = await this.storage.getObjectRange(video.storage_key);
      return {
        kind: 'full',
        stream: object.stream,
        contentLength: head.contentLength,
        contentType: video.content_type,
      };
    }

    const object = await this.storage.getObjectRange(
      video.storage_key,
      toRangeHeader(parsed.range),
    );

    return {
      kind: 'partial',
      stream: object.stream,
      contentLength: parsed.range.end - parsed.range.start + 1,
      contentRange: formatContentRange(parsed.range, head.contentLength),
      contentType: video.content_type,
    };
  }

  /**
   * Builds the download handoff.
   *
   * The full file is the one genuinely large transfer in the phase, so it is
   * served straight from storage through a short-lived pre-signed URL — the API
   * returns a redirect and moves no bytes (see TD-07).
   */
  async buildDownloadUrl(
    publicId: string,
    currentUserId?: string,
  ): Promise<string> {
    const video = await this.findPlayable(publicId, currentUserId);

    return this.storage.signGetObject(
      video.storage_key,
      this.config.downloadUrlTtl,
      {
        responseContentDisposition: buildAttachmentDisposition(
          video.original_filename,
        ),
        responseContentType: video.content_type,
      },
    );
  }

  /** Streams the generated thumbnail, once the worker has produced one. */
  async openThumbnail(
    publicId: string,
    currentUserId?: string,
  ): Promise<StreamResponse> {
    const video = await this.findPlayable(publicId, currentUserId);

    if (video.thumbnail_key === null) {
      throw new VideoNotFoundException();
    }

    const object = await this.storage.getObjectRange(
      video.thumbnail_key,
      undefined,
      this.storage.thumbnailsBucket,
    );

    return {
      kind: 'full',
      stream: object.stream,
      contentLength: object.contentLength,
      contentType: object.contentType ?? 'image/jpeg',
    };
  }

  /**
   * Loads a video the caller owns and whose upload is still open. Ownership is
   * resolved through the channel, never taken from the request.
   */
  private async findOwnedUploadable(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new VideoNotOwnedException();
    }

    if (video.status !== 'draft' || video.upload_id === null) {
      throw new InvalidUploadStateException();
    }

    return video;
  }

  private isPublicIdCollision(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string }).code === UNIQUE_VIOLATION &&
      String((error.driverError as { detail?: string }).detail ?? '').includes(
        'public_id',
      )
    );
  }

  private async safeAbort(key: string, uploadId: string): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(key, uploadId);
    } catch (error) {
      this.logger.warn(
        `Failed to abort multipart upload for "${key}": ${String(error)}`,
      );
    }
  }

  toResponse(video: Video, channel: Channel): VideoResponseDto {
    const urls = buildVideoUrls(
      this.app.url,
      video.public_id,
      video.thumbnail_key !== null,
    );

    return {
      id: video.public_id,
      title: video.title,
      description: video.description,
      status: video.status,
      channel: { id: channel.id, nickname: channel.nickname },
      duration_seconds: video.duration_seconds,
      size_bytes: video.size_bytes,
      content_type: video.content_type,
      metadata: video.metadata,
      processing_error: video.processing_error,
      url: urls.url,
      stream_url: urls.streamUrl,
      download_url: urls.downloadUrl,
      thumbnail_url: urls.thumbnailUrl,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }
}
