import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { envValidationSchema } from '../config/env.validation';
import { ALL_ENTITIES } from '../database/entities';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingConsumer } from './video-processing.consumer';

/**
 * Root module of the video worker process. It shares the entities, config and
 * storage layer with the API — the worker's whole job is to update the same
 * `videos` rows the API created — but runs in its own container with FFmpeg and
 * no HTTP surface (see TD-05).
 */
@Module({
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
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // The worker imports only VideosModule, so autoLoadEntities would miss
        // Channel and break Video's relation metadata. The list is explicit.
        entities: ALL_ENTITIES,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        // maxRetriesPerRequest: null — a background worker waits for Redis to
        // come back rather than crashing.
        connection: config.workerConnection,
        prefix: config.prefix,
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
    StorageModule,
    VideosModule,
  ],
  providers: [FfmpegService, VideoProcessingConsumer],
})
export class WorkerModule {}
