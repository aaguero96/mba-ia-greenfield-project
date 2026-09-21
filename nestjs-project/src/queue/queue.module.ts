import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE } from './queue.constants';

/**
 * Producer-side queue wiring, imported by the API. The worker registers the same
 * queue through `WorkerModule` with a different connection — see queue.config.ts
 * for why the two connections must not be shared.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: config.producerConnection,
        prefix: config.prefix,
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
