import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('should compile with the Video repository and the queue producer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideosModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      // Stubbed so this stays a unit test — the real queue is exercised in
      // queue.integration-spec.ts against Redis.
      .overrideProvider(getQueueToken(VIDEO_QUEUE))
      .useValue({ add: jest.fn() })
      .compile();

    expect(moduleRef.get(getRepositoryToken(Video))).toBeDefined();
    expect(moduleRef.get(VideoQueueService)).toBeInstanceOf(VideoQueueService);

    await moduleRef.close();
  });
});
