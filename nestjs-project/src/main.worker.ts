import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

/**
 * Entrypoint of the video worker container.
 *
 * `createApplicationContext` boots the DI graph without an HTTP listener — the
 * worker consumes from the queue and exposes no web surface.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // Lets an in-flight FFmpeg job finish instead of being cut off on SIGTERM.
  app.enableShutdownHooks();

  new Logger('VideoWorker').log('Video worker started');
}

void bootstrap();
