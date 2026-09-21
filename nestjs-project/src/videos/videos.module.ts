import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), QueueModule],
  providers: [VideoQueueService],
  exports: [TypeOrmModule, VideoQueueService],
})
export class VideosModule {}
