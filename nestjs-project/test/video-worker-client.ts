import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { Job } from 'bullmq';
import { Video } from '../src/videos/entities/video.entity';
import type { ProcessVideoJobData } from '../src/videos/video-queue.service';
import { WorkerModule } from '../src/worker/worker.module';
import { VideoProcessingConsumer } from '../src/worker/video-processing.consumer';

export interface WorkerContext {
  module: TestingModule;
  consumer: VideoProcessingConsumer;
}

/**
 * Boots the real worker application context, so an e2e test can drive genuine
 * processing instead of faking a `ready` video.
 *
 * The worker container consumes from its own Redis key prefix and the suite uses
 * a different one (see `setup-test-env.ts`), so a test drives the consumer
 * directly rather than waiting for the container to pick the job up.
 */
export async function createWorkerContext(): Promise<WorkerContext> {
  const module = await Test.createTestingModule({
    imports: [WorkerModule],
  }).compile();

  await module.init();

  return { module, consumer: module.get(VideoProcessingConsumer) };
}

/** Runs the real processing pipeline for a video identified by its public id. */
export async function processVideo(
  context: WorkerContext,
  dataSource: DataSource,
  publicId: string,
): Promise<void> {
  const video = await dataSource
    .getRepository(Video)
    .findOneByOrFail({ public_id: publicId });

  await context.consumer.process({
    data: { videoId: video.id },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as Job<ProcessVideoJobData>);
}
