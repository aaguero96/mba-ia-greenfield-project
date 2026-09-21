import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { WorkerModule } from './worker.module';

/**
 * Compiles the worker's full dependency graph. This is the test that catches a
 * missing entity or a missing module import before the container crash-loops.
 */
describe('WorkerModule', () => {
  it('should compile with storage, queue and database wiring', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(StorageService)).toBeDefined();
    expect(moduleRef.get(getQueueToken(VIDEO_QUEUE))).toBeDefined();
    expect(moduleRef.get(DataSource)).toBeDefined();

    await moduleRef.close();
  }, 30_000);

  it('should resolve the Video relation metadata, including the owning channel', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    try {
      const dataSource = moduleRef.get(DataSource);
      const metadata = dataSource.getMetadata('Video');

      // The worker imports only VideosModule; without the explicit entity list
      // this relation fails with "Entity metadata for Video#channel not found".
      expect(
        metadata.relations.some((relation) => relation.propertyName === 'channel'),
      ).toBe(true);
    } finally {
      await moduleRef.close();
    }
  }, 30_000);
});
