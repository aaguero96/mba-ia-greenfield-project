import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_JOB_ATTEMPTS,
  VIDEO_JOB_BACKOFF_DELAY_MS,
  VIDEO_QUEUE,
} from '../queue/queue.constants';
import { VideoQueueService } from './video-queue.service';

describe('VideoQueueService', () => {
  const videoId = '11111111-1111-1111-1111-111111111111';
  let service: VideoQueueService;
  let add: jest.Mock;

  beforeEach(async () => {
    add = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoQueueService,
        { provide: getQueueToken(VIDEO_QUEUE), useValue: { add } },
      ],
    }).compile();

    service = moduleRef.get(VideoQueueService);
  });

  /** mock.calls is any[][]; naming the shape keeps the assertions checked. */
  function addCall(): [string, { videoId: string }, Record<string, unknown>] {
    return add.mock.calls[0] as [
      string,
      { videoId: string },
      Record<string, unknown>,
    ];
  }

  it('should enqueue under the documented job name', async () => {
    await service.enqueueProcessing(videoId);

    expect(add).toHaveBeenCalledTimes(1);
    expect(addCall()[0]).toBe(PROCESS_VIDEO_JOB);
  });

  it('should send only the video id as the payload', async () => {
    await service.enqueueProcessing(videoId);

    // A thin payload keeps the database as the single source of truth, so a
    // retry minutes later does not act on a stale snapshot.
    expect(addCall()[1]).toEqual({ videoId });
  });

  it('should use the video id as the job id to deduplicate enqueues', async () => {
    await service.enqueueProcessing(videoId);

    expect(addCall()[2]).toMatchObject({ jobId: videoId });
  });

  it('should apply the bounded retry policy with exponential backoff', async () => {
    await service.enqueueProcessing(videoId);

    expect(addCall()[2]).toMatchObject({
      attempts: VIDEO_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: VIDEO_JOB_BACKOFF_DELAY_MS },
    });
  });

  it('should keep failed jobs and discard completed ones', async () => {
    await service.enqueueProcessing(videoId);

    expect(addCall()[2]).toMatchObject({
      removeOnComplete: true,
      removeOnFail: false,
    });
  });

  it('should propagate a queue failure to the caller', async () => {
    add.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.enqueueProcessing(videoId)).rejects.toThrow(
      'redis down',
    );
  });
});
