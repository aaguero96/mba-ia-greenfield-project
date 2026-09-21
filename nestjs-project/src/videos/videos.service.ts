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
  PartCountExceededException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { videoSourceKey } from '../storage/storage.keys';
import { Video } from './entities/video.entity';
import { generatePublicId } from './video-public-id.util';
import { buildVideoUrls } from './video-urls.util';
import { VIDEO_PUBLIC_ID_MAX_ATTEMPTS } from './videos.constants';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type {
  InitiateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
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
