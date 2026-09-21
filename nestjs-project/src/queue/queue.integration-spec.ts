import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { PROCESS_VIDEO_JOB, VIDEO_QUEUE } from './queue.constants';

/**
 * Runs against the real Redis service from the Compose stack. The behaviour
 * being verified — jobId deduplication and durability of queued jobs — is
 * implemented by Redis and BullMQ, so a mocked queue would assert nothing.
 */
describe('Video processing queue (integration)', () => {
  let moduleRef: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    await moduleRef.init();
    queue = moduleRef.get(getQueueToken(VIDEO_QUEUE));
  }, 30_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should connect to the real Redis instance', async () => {
    await expect(queue.getJobCounts()).resolves.toBeDefined();
  });

  it('should store a queued job retrievable by its job id', async () => {
    const videoId = randomUUID();

    await queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId });

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId });
  });

  it('should deduplicate a second enqueue with the same job id', async () => {
    const videoId = randomUUID();

    await queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId });
    await queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId });

    const waiting = await queue.getWaiting();
    expect(waiting.filter((job) => job.id === videoId)).toHaveLength(1);
  });

  it('should keep distinct videos as distinct jobs', async () => {
    const first = randomUUID();
    const second = randomUUID();

    await queue.add(PROCESS_VIDEO_JOB, { videoId: first }, { jobId: first });
    await queue.add(PROCESS_VIDEO_JOB, { videoId: second }, { jobId: second });

    expect(await queue.getWaitingCount()).toBe(2);
  });

  it('should persist the retry policy on the stored job', async () => {
    const videoId = randomUUID();

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        jobId: videoId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );

    const job = await queue.getJob(videoId);
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });

  it('should survive a reconnection, since jobs live in Redis not in the process', async () => {
    const videoId = randomUUID();
    await queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId });

    // A second, independent module connecting to the same Redis sees the job.
    const other = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    await other.init();

    try {
      const otherQueue: Queue = other.get(getQueueToken(VIDEO_QUEUE));
      expect(await otherQueue.getJob(videoId)).toBeDefined();
    } finally {
      await other.close();
    }
  }, 30_000);
});
