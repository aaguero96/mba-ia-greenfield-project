import { randomUUID } from 'node:crypto';
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
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { videoSourceKey } from '../storage/storage.keys';
import { Video } from './entities/video.entity';
import { generatePublicId } from './video-public-id.util';
import { buildVideoUrls } from './video-urls.util';
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
