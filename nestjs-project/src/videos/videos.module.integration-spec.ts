import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { ALL_ENTITIES } from '../database/entities';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VideosModule } from './videos.module';

/**
 * Compiles the real module against the real infrastructure. It is an integration
 * test rather than a unit one because the module now wires a database, a queue
 * and object storage — the project's rule is that the suffix follows what the
 * test actually does.
 */
describe('VideosModule (integration)', () => {
  it('should compile with its repository, controller, service and queue producer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            appConfig,
            databaseConfig,
            queueConfig,
            storageConfig,
            videoConfig,
          ],
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
        VideosModule,
      ],
    }).compile();

    await moduleRef.init();

    try {
      expect(moduleRef.get(getRepositoryToken(Video))).toBeDefined();
      expect(moduleRef.get(VideosService)).toBeInstanceOf(VideosService);
      expect(moduleRef.get(VideoQueueService)).toBeInstanceOf(
        VideoQueueService,
      );
      expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
    } finally {
      await moduleRef.close();
    }
  }, 60_000);
});
