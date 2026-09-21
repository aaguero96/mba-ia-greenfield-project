import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { ALL_ENTITIES } from '../database/entities';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { videoSourceKey, videoThumbnailKey } from '../storage/storage.keys';
import { cleanAllTables } from '../test/create-test-data-source';
import { createVideoFixture } from '../test/video-fixture';
import { Video } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../videos/video-queue.service';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingConsumer } from './video-processing.consumer';

/**
 * Exercises the consumer against real PostgreSQL, real MinIO and the real
 * FFmpeg binaries — everything the Compose stack provides. Only the BullMQ `Job`
 * is a stand-in, because the queue mechanics are covered by
 * `queue.integration-spec.ts` and what matters here is what the consumer does.
 */
describe('VideoProcessingConsumer (integration)', () => {
  let moduleRef: TestingModule;
  let consumer: VideoProcessingConsumer;
  let storage: StorageService;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channelId: string;
  let fixtureBytes: Buffer;

  function job(videoId: string, attemptsMade = 0): Job<ProcessVideoJobData> {
    return {
      data: { videoId },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<ProcessVideoJobData>;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, databaseConfig, storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'db',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'streamtube',
          password: process.env.DB_PASSWORD ?? 'streamtube',
          database: process.env.DB_NAME ?? 'streamtube',
          entities: ALL_ENTITIES,
          synchronize: false,
        }),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessingConsumer],
    }).compile();

    await moduleRef.init();

    consumer = moduleRef.get(VideoProcessingConsumer);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videos = dataSource.getRepository(Video);

    const fixture = await createVideoFixture(3, 320, 240);
    fixtureBytes = await readFile(fixture.path);
  }, 180_000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save({
      email: `${randomUUID()}@example.com`,
      password: 'hashed',
      is_confirmed: true,
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Test Channel',
      nickname: randomUUID().slice(0, 20),
      user_id: user.id,
    });
    channelId = channel.id;
  });

  /** Stores a source object and the matching `processing` row. */
  async function givenProcessingVideo(
    body: Buffer = fixtureBytes,
  ): Promise<Video> {
    const id = randomUUID();
    const key = videoSourceKey(channelId, id, 'fixture.mp4');

    await storage.putObject(key, body, 'video/mp4');

    return videos.save(
      videos.create({
        id,
        public_id: randomUUID().slice(0, 11),
        channel_id: channelId,
        title: 'Fixture',
        original_filename: 'fixture.mp4',
        content_type: 'video/mp4',
        size_bytes: String(body.length),
        storage_key: key,
        part_size_bytes: 67_108_864,
        part_count: 1,
        status: 'processing',
      }),
    );
  }

  it('should take a processing video all the way to ready', async () => {
    const video = await givenProcessingVideo();

    await consumer.process(job(video.id));

    const reloaded = await videos.findOneByOrFail({ id: video.id });
    expect(reloaded.status).toBe('ready');
    expect(reloaded.processing_error).toBeNull();
  }, 120_000);

  it('should extract the real duration and metadata', async () => {
    const video = await givenProcessingVideo();

    await consumer.process(job(video.id));

    const reloaded = await videos.findOneByOrFail({ id: video.id });
    expect(reloaded.duration_seconds).toBeCloseTo(3, 1);
    expect(reloaded.metadata).toMatchObject({
      width: 320,
      height: 240,
      codec: 'h264',
    });
    expect(reloaded.metadata?.bitrate).toBeGreaterThan(0);
  }, 120_000);

  it('should write a thumbnail at the deterministic key', async () => {
    const video = await givenProcessingVideo();

    await consumer.process(job(video.id));

    const expectedKey = videoThumbnailKey(channelId, video.id);
    const reloaded = await videos.findOneByOrFail({ id: video.id });
    expect(reloaded.thumbnail_key).toBe(expectedKey);

    const head = await storage.headObject(
      expectedKey,
      storage.thumbnailsBucket,
    );
    expect(head.contentType).toBe('image/jpeg');
    expect(head.contentLength).toBeGreaterThan(0);
  }, 120_000);

  it('should read the source over HTTP rather than downloading it whole', async () => {
    const video = await givenProcessingVideo();
    const signSpy = jest.spyOn(storage, 'signInternalGetObject');

    await consumer.process(job(video.id));

    // The source is handed to FFmpeg as a pre-signed URL; there is no
    // getObject/download of the full file anywhere in the path.
    expect(signSpy).toHaveBeenCalledWith(video.storage_key, expect.any(Number));
    signSpy.mockRestore();
  }, 120_000);

  it('should be a no-op when the same job is delivered again', async () => {
    const video = await givenProcessingVideo();

    await consumer.process(job(video.id));
    const afterFirst = await videos.findOneByOrFail({ id: video.id });

    const probeSpy = jest.spyOn(moduleRef.get(FfmpegService), 'probe');
    await consumer.process(job(video.id));

    // Already ready: the consumer returns before touching FFmpeg at all.
    expect(probeSpy).not.toHaveBeenCalled();
    const afterSecond = await videos.findOneByOrFail({ id: video.id });
    expect(afterSecond.updated_at).toEqual(afterFirst.updated_at);
    probeSpy.mockRestore();
  }, 120_000);

  it('should overwrite rather than duplicate the thumbnail when reprocessed', async () => {
    const video = await givenProcessingVideo();
    await consumer.process(job(video.id));

    // Force a genuine re-run by putting the video back into processing.
    await videos.update({ id: video.id }, { status: 'processing' });
    await consumer.process(job(video.id));

    const key = videoThumbnailKey(channelId, video.id);
    await expect(
      storage.objectExists(key, storage.thumbnailsBucket),
    ).resolves.toBe(true);
  }, 120_000);

  it('should drop the job when the video no longer exists', async () => {
    await expect(consumer.process(job(randomUUID()))).resolves.toBeUndefined();
  }, 60_000);

  it('should fail on a source that is not a decodable video', async () => {
    const video = await givenProcessingVideo(Buffer.from('not a video at all'));

    await expect(consumer.process(job(video.id))).rejects.toThrow();
  }, 120_000);

  describe('failure handling', () => {
    it('should keep the video in processing while attempts remain', async () => {
      const video = await givenProcessingVideo();

      await consumer.onFailed(job(video.id, 1), new Error('transient'));

      const reloaded = await videos.findOneByOrFail({ id: video.id });
      expect(reloaded.status).toBe('processing');
      expect(reloaded.processing_error).toBeNull();
    }, 60_000);

    it('should mark the video failed with a reason once attempts are exhausted', async () => {
      const video = await givenProcessingVideo();

      await consumer.onFailed(job(video.id, 3), new Error('corrupt stream'));

      const reloaded = await videos.findOneByOrFail({ id: video.id });
      expect(reloaded.status).toBe('failed');
      expect(reloaded.processing_error).toBe('corrupt stream');
    }, 60_000);

    it('should keep the source object so reprocessing needs no re-upload', async () => {
      const video = await givenProcessingVideo();

      await consumer.onFailed(job(video.id, 3), new Error('corrupt stream'));

      await expect(storage.objectExists(video.storage_key)).resolves.toBe(true);
    }, 60_000);
  });
});
