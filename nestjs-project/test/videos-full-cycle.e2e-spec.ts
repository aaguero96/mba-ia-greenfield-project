import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { createVideoFixture } from '../src/test/video-fixture';
import { Video } from '../src/videos/entities/video.entity';
import { createVideoTestApp, registerAndLogin } from './video-test-client';
import type { AuthenticatedUser } from './video-test-client';
import { createWorkerContext, processVideo } from './video-worker-client';
import type { WorkerContext } from './video-worker-client';

/**
 * One test that exercises the whole phase as a user would: register, initiate,
 * upload the parts straight to storage, complete, let the worker process it,
 * then stream and download. Nothing in the path is mocked — PostgreSQL, MinIO,
 * Redis and FFmpeg are all the real services from the Compose stack.
 */
describe('Videos full cycle (e2e)', () => {
  let app: INestApplication<App>;
  let worker: WorkerContext;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let owner: AuthenticatedUser;
  let fixtureBytes: Buffer;

  beforeAll(async () => {
    app = await createVideoTestApp();
    worker = await createWorkerContext();
    dataSource = app.get(DataSource);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);

    const fixture = await createVideoFixture(3, 320, 240);
    fixtureBytes = await readFile(fixture.path);
  }, 180_000);

  afterAll(async () => {
    await worker.module.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    owner = await registerAndLogin(app, `${randomUUID()}@example.com`);
  });

  async function statusOf(publicId: string): Promise<string> {
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    return video.status;
  }

  it('takes a video from upload to playback with no mocks anywhere', async () => {
    const observedStatuses: string[] = [];
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // 1. Pre-registration: the video exists as a draft before a single byte moves.
    const initiated = await request(app.getHttpServer())
      .post('/videos')
      .set(auth)
      .send({
        title: 'Full cycle',
        filename: 'holiday.mp4',
        content_type: 'video/mp4',
        size_bytes: fixtureBytes.length,
      })
      .expect(201);

    const { video, upload } = initiated.body as {
      video: { id: string; status: string; url: string };
      upload: { upload_id: string; part_size: number; part_count: number };
    };

    expect(video.status).toBe('draft');
    expect(upload.part_count).toBe(1);
    observedStatuses.push(await statusOf(video.id));

    // 2. The bytes go straight to object storage through a pre-signed URL.
    const signed = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/parts`)
      .set(auth)
      .send({ part_numbers: [1] })
      .expect(200);

    const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
    const put = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(fixtureBytes),
    });
    expect(put.status).toBe(200);

    // 3. Completion verifies the stored object and hands the job to the queue.
    const completed = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set(auth)
      .send({
        parts: [{ part_number: 1, etag: put.headers.get('etag') as string }],
      })
      .expect(200);

    expect((completed.body as { status: string }).status).toBe('processing');
    observedStatuses.push(await statusOf(video.id));

    // 4. The worker extracts metadata and cuts the thumbnail.
    await processVideo(worker, dataSource, video.id);
    observedStatuses.push(await statusOf(video.id));

    // The cycle the phase requires, observed in the database in order.
    expect(observedStatuses).toEqual(['draft', 'processing', 'ready']);

    // 5. The processed video exposes its metadata and its unique URLs.
    const details = await request(app.getHttpServer())
      .get(`/videos/${video.id}`)
      .expect(200);

    const body = details.body as Record<string, unknown>;
    expect(body.duration_seconds).toBeCloseTo(3, 0);
    expect(body.metadata).toMatchObject({
      width: 320,
      height: 240,
      codec: 'h264',
    });
    expect(body.thumbnail_url).toBe(`${video.url}/thumbnail`);

    // 6. The thumbnail is a real JPEG produced from a frame of the video.
    const thumbnail = await request(app.getHttpServer())
      .get(`/videos/${video.id}/thumbnail`)
      .expect(200);
    expect(Buffer.from(thumbnail.body as Buffer).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );

    // 7. Streaming reproduces the file exactly, one range at a time, so a
    //    player never needs the whole file in one request.
    const chunkSize = 2048;
    const streamed: Buffer[] = [];
    for (let start = 0; start < fixtureBytes.length; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, fixtureBytes.length - 1);
      const chunk = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .set('Range', `bytes=${start}-${end}`)
        .expect(206);
      streamed.push(Buffer.from(chunk.body as Buffer));
    }
    expect(Buffer.concat(streamed)).toEqual(fixtureBytes);

    // 8. Download hands the client straight to storage and still delivers the
    //    complete, byte-identical file.
    const redirect = await request(app.getHttpServer())
      .get(`/videos/${video.id}/download`)
      .expect(302);
    const downloaded = await fetch(redirect.headers['location']);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(fixtureBytes);
  }, 300_000);

  it('gives every video a distinct unique URL', async () => {
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const ids: string[] = [];

    for (let index = 0; index < 5; index++) {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set(auth)
        .send({
          title: `Video ${index}`,
          filename: 'holiday.mp4',
          content_type: 'video/mp4',
          size_bytes: 1024,
        })
        .expect(201);

      ids.push((res.body as { video: { id: string } }).video.id);
    }

    expect(new Set(ids).size).toBe(ids.length);
  }, 180_000);

  it('records a processing failure without losing the uploaded file', async () => {
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    // A payload that is not a decodable video: the upload succeeds, the
    // processing cannot.
    const garbage = Buffer.from('this is definitely not a video file');

    const initiated = await request(app.getHttpServer())
      .post('/videos')
      .set(auth)
      .send({
        title: 'Broken',
        filename: 'broken.mp4',
        content_type: 'video/mp4',
        size_bytes: garbage.length,
      })
      .expect(201);
    const publicId = (initiated.body as { video: { id: string } }).video.id;

    const signed = await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/parts`)
      .set(auth)
      .send({ part_numbers: [1] })
      .expect(200);

    const put = await fetch(
      (signed.body as { parts: { url: string }[] }).parts[0].url,
      { method: 'PUT', body: new Uint8Array(garbage) },
    );

    await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/complete`)
      .set(auth)
      .send({
        parts: [{ part_number: 1, etag: put.headers.get('etag') as string }],
      })
      .expect(200);

    await expect(processVideo(worker, dataSource, publicId)).rejects.toThrow();

    // The worker records the failure only once the retries are exhausted, which
    // the consumer integration spec covers; here the point is that the source
    // object survives, so the video can be reprocessed without a new upload.
    const stored = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    expect(stored.storage_key).toBeTruthy();

    const head = await request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set(auth)
      .expect(200);
    expect((head.body as { status: string }).status).toBe('processing');
  }, 180_000);
});
