import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { WorkerHost } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { videoThumbnailKey } from '../storage/storage.keys';
import { Video } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../videos/video-queue.service';
import { FfmpegService } from './ffmpeg.service';
import { computeThumbnailOffset } from './thumbnail-offset.util';

@Processor(VIDEO_QUEUE)
export class VideoProcessingConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {
    super();
  }

  /**
   * Extracts duration and metadata, cuts the thumbnail, and marks the video
   * ready.
   *
   * Delivery is at-least-once, so this must be safe to run twice: the row is
   * re-read on every attempt (never trusting a snapshot in the payload), an
   * already-`ready` video returns immediately, and the thumbnail key is
   * deterministic so a re-run overwrites instead of accumulating (see TD-09).
   */
  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      this.logger.warn(`Video ${videoId} no longer exists; dropping the job`);
      return;
    }

    if (video.status === 'ready') {
      this.logger.log(`Video ${videoId} is already ready; nothing to do`);
      return;
    }

    const sourceUrl = await this.storage.signInternalGetObject(
      video.storage_key,
      this.config.probeUrlTtl,
    );

    const probe = await this.ffmpeg.probe(sourceUrl);

    const offset = computeThumbnailOffset(
      probe.durationSeconds,
      this.config.thumbnailPercent,
    );
    const thumbnail = await this.ffmpeg.extractThumbnail(sourceUrl, offset);

    const thumbnailKey = videoThumbnailKey(video.channel_id, video.id);
    await this.storage.putObject(
      thumbnailKey,
      thumbnail,
      'image/jpeg',
      this.storage.thumbnailsBucket,
    );

    video.duration_seconds = probe.durationSeconds;
    video.metadata = {
      width: probe.width,
      height: probe.height,
      codec: probe.codec,
      bitrate: probe.bitrate,
      formatName: probe.formatName,
    };
    video.thumbnail_key = thumbnailKey;
    video.status = 'ready';
    video.processing_error = null;

    await this.videoRepository.save(video);

    this.logger.log(
      `Video ${videoId} is ready (${probe.durationSeconds.toFixed(3)}s)`,
    );
  }

  /**
   * Only the **final** attempt marks the video as failed — earlier failures are
   * transient by assumption and are still being retried with backoff. The source
   * object is deliberately kept, so reprocessing never costs another upload.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;

    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `Processing of video ${job.data.videoId} failed (attempt ${job.attemptsMade}/${attempts}), retrying: ${error.message}`,
      );
      return;
    }

    this.logger.error(
      `Processing of video ${job.data.videoId} failed permanently: ${error.message}`,
    );

    await this.videoRepository.update(
      { id: job.data.videoId },
      { status: 'failed', processing_error: error.message },
    );
  }
}
