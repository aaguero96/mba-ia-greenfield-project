import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_JOB_ATTEMPTS,
  VIDEO_JOB_BACKOFF_DELAY_MS,
  VIDEO_QUEUE,
} from '../queue/queue.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

@Injectable()
export class VideoQueueService {
  private readonly logger = new Logger(VideoQueueService.name);

  constructor(
    @InjectQueue(VIDEO_QUEUE) private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * The payload carries only the id: the database stays the single source of
   * truth, so a retry minutes later operates on current state rather than on a
   * snapshot taken at enqueue time. `jobId` is the video id, which makes a
   * duplicate enqueue a no-op while the job is waiting or active (see TD-09).
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        jobId: videoId,
        attempts: VIDEO_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: VIDEO_JOB_BACKOFF_DELAY_MS },
        removeOnComplete: true,
        // Kept so a definitive failure can be inspected.
        removeOnFail: false,
      },
    );

    this.logger.log(`Enqueued processing for video ${videoId}`);
  }
}
