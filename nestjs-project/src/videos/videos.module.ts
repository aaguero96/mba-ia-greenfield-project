import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VideosController } from './videos.controller';
import { VideosPublicController } from './videos-public.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    QueueModule,
    StorageModule,
  ],
  controllers: [VideosController, VideosPublicController],
  providers: [VideoQueueService, VideosService],
  exports: [TypeOrmModule, VideoQueueService, VideosService],
})
export class VideosModule {}
