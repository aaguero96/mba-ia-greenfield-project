import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { ALL_ENTITIES } from '../database/entities';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

/**
 * Real PostgreSQL and real MinIO. The behaviour under test is the interaction
 * between the row and the multipart upload — exactly what a mocked storage
 * client would make untestable.
 */
describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let userId: string;
  let channelId: string;

  const dto = {
    title: 'Holiday recap',
    filename: 'holiday.mp4',
    content_type: 'video/mp4',
    size_bytes: 2048,
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, databaseConfig, queueConfig, storageConfig, videoConfig],
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
        TypeOrmModule.forFeature([Video, Channel, User]),
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();

    await moduleRef.init();

    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videos = dataSource.getRepository(Video);
  }, 60_000);

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
    userId = user.id;

    const channel = await dataSource.getRepository(Channel).save({
      name: 'Test Channel',
      nickname: randomUUID().slice(0, 20),
      user_id: user.id,
    });
    channelId = channel.id;
  });

  it('should persist a draft row and open a real multipart upload', async () => {
    const result = await service.initiateUpload(userId, dto);

    const row = await videos.findOneByOrFail({ public_id: result.video.id });
    expect(row.status).toBe('draft');
    expect(row.channel_id).toBe(channelId);
    expect(row.upload_id).toBe(result.upload.upload_id);

    // The upload really exists in storage: listing its parts succeeds.
    await expect(
      storage.listParts(row.storage_key, row.upload_id as string),
    ).resolves.toEqual([]);

    await storage.abortMultipartUpload(row.storage_key, row.upload_id as string);
  }, 30_000);

  it('should build a storage key scoped to the channel and the video', async () => {
    const result = await service.initiateUpload(userId, dto);
    const row = await videos.findOneByOrFail({ public_id: result.video.id });

    expect(row.storage_key).toBe(`videos/${channelId}/${row.id}/source.mp4`);

    await storage.abortMultipartUpload(row.storage_key, row.upload_id as string);
  }, 30_000);

  it('should leave no open multipart upload when persisting fails', async () => {
    const abortSpy = jest.spyOn(storage, 'abortMultipartUpload');
    jest
      .spyOn(videos, 'save')
      .mockRejectedValueOnce(new Error('simulated write failure'));

    await expect(service.initiateUpload(userId, dto)).rejects.toThrow(
      'simulated write failure',
    );

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(await videos.count()).toBe(0);

    abortSpy.mockRestore();
    jest.restoreAllMocks();
  }, 30_000);

  it('should store a 10GiB declared size without losing precision', async () => {
    const result = await service.initiateUpload(userId, {
      ...dto,
      size_bytes: 10_737_418_240,
    });

    const row = await videos.findOneByOrFail({ public_id: result.video.id });
    expect(row.size_bytes).toBe('10737418240');
    expect(row.part_count).toBe(160);

    await storage.abortMultipartUpload(row.storage_key, row.upload_id as string);
  }, 30_000);

  it('should give concurrent initiations distinct public ids and keys', async () => {
    const [first, second] = await Promise.all([
      service.initiateUpload(userId, dto),
      service.initiateUpload(userId, dto),
    ]);

    expect(first.video.id).not.toBe(second.video.id);

    const rows = await videos.find();
    expect(new Set(rows.map((row) => row.storage_key)).size).toBe(2);

    for (const row of rows) {
      await storage.abortMultipartUpload(row.storage_key, row.upload_id as string);
    }
  }, 30_000);
});
