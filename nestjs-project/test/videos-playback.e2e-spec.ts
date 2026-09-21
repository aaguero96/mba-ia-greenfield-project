import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { createVideoFixture } from '../src/test/video-fixture';
import { createVideoTestApp, registerAndLogin } from './video-test-client';
import type { AuthenticatedUser } from './video-test-client';
import { createWorkerContext, processVideo } from './video-worker-client';
import type { WorkerContext } from './video-worker-client';

/**
 * Playback end to end: a real upload, real processing by the worker's consumer,
 * then streaming with Range and downloading by redirect. Nothing about the
 * "ready" state is faked.
 */
describe('Videos playback (e2e)', () => {
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

  /** Uploads the fixture through the real API flow and returns its public id. */
  async function uploadFixture(): Promise<string> {
    const initiated = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Playable video',
        filename: 'fixture.mp4',
        content_type: 'video/mp4',
        size_bytes: fixtureBytes.length,
      })
      .expect(201);

    const publicId = (initiated.body as { video: { id: string } }).video.id;

    const signed = await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/parts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ part_numbers: [1] })
      .expect(200);

    const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
    // Buffer is a Uint8Array at runtime; fetch's BodyInit type wants the
    // view, not Node's Buffer subtype.
    const put = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(fixtureBytes),
    });

    await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        parts: [{ part_number: 1, etag: put.headers.get('etag') as string }],
      })
      .expect(200);

    return publicId;
  }

  /** Uploads and then runs the real processing pipeline. */
  async function readyVideo(): Promise<string> {
    const publicId = await uploadFixture();
    await processVideo(worker, dataSource, publicId);
    return publicId;
  }

  describe('GET /videos/:id', () => {
    it('returns a ready video anonymously, with its unique URLs', async () => {
      const publicId = await readyVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      const body = res.body as Record<string, string | number | null>;
      expect(body.status).toBe('ready');
      expect(body.id).toBe(publicId);
      expect(body.url).toContain(`/videos/${publicId}`);
      expect(body.thumbnail_url).toBe(`${body.url as string}/thumbnail`);
      expect(body.duration_seconds).toBeCloseTo(3, 0);
    }, 180_000);

    it('hides a draft from anonymous callers as 404, not 403', async () => {
      const publicId = await uploadFixture();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(404);

      // 403 would confirm the id exists.
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    }, 120_000);

    it('shows the owner their own unprocessed video', async () => {
      const publicId = await uploadFixture();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect((res.body as { status: string }).status).toBe('processing');
    }, 120_000);

    it('hides another user unprocessed video', async () => {
      const publicId = await uploadFixture();
      const other = await registerAndLogin(app, `${randomUUID()}@example.com`);

      await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
    }, 120_000);

    it('returns 404 for an unknown id', async () => {
      await request(app.getHttpServer()).get('/videos/DoesNotExi1').expect(404);
    });
  });

  describe('GET /videos/:id/stream', () => {
    it('returns 206 with the exact requested bytes', async () => {
      const publicId = await readyVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=0-1023')
        .expect(206);

      expect(res.headers['content-range']).toBe(
        `bytes 0-1023/${fixtureBytes.length}`,
      );
      expect(res.headers['content-length']).toBe('1024');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.from(res.body as Buffer)).toEqual(
        fixtureBytes.subarray(0, 1024),
      );
    }, 180_000);

    it('serves a middle range correctly', async () => {
      const publicId = await readyVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=100-199')
        .expect(206);

      expect(Buffer.from(res.body as Buffer)).toEqual(
        fixtureBytes.subarray(100, 200),
      );
    }, 180_000);

    it('returns 200 with the full body and Accept-Ranges when no range is sent', async () => {
      const publicId = await readyVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(200);

      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(fixtureBytes.length));
      expect(Buffer.from(res.body as Buffer)).toEqual(fixtureBytes);
    }, 180_000);

    it('reassembles the whole file from consecutive ranges', async () => {
      const publicId = await readyVideo();
      const chunkSize = 4096;
      const chunks: Buffer[] = [];

      for (let start = 0; start < fixtureBytes.length; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, fixtureBytes.length - 1);
        const res = await request(app.getHttpServer())
          .get(`/videos/${publicId}/stream`)
          .set('Range', `bytes=${start}-${end}`)
          .expect(206);
        chunks.push(Buffer.from(res.body as Buffer));
      }

      // Streaming really delivers the file, chunk by chunk, without ever
      // requiring a full download in one request.
      expect(Buffer.concat(chunks)).toEqual(fixtureBytes);
    }, 300_000);

    it('returns 416 with a Content-Range for an unsatisfiable range', async () => {
      const publicId = await readyVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', `bytes=${fixtureBytes.length + 10}-${fixtureBytes.length + 20}`)
        .expect(416);

      expect(res.headers['content-range']).toBe(`bytes */${fixtureBytes.length}`);
    }, 180_000);

    it('is not rate limited, unlike the throttled auth endpoints', async () => {
      const publicId = await readyVideo();

      // Well beyond the 10 requests/minute the global throttler allows.
      for (let index = 0; index < 25; index++) {
        await request(app.getHttpServer())
          .get(`/videos/${publicId}/stream`)
          .set('Range', 'bytes=0-99')
          .expect(206);
      }
    }, 300_000);

    it('returns 404 for a video that is not ready', async () => {
      const publicId = await uploadFixture();

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(404);
    }, 120_000);
  });

  describe('GET /videos/:id/thumbnail', () => {
    it('serves the JPEG the worker generated', async () => {
      const publicId = await readyVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/thumbnail`)
        .expect(200);

      expect(res.headers['content-type']).toContain('image/jpeg');
      const body = Buffer.from(res.body as Buffer);
      expect(body[0]).toBe(0xff);
      expect(body[1]).toBe(0xd8);
    }, 180_000);
  });

  describe('GET /videos/:id/download', () => {
    it('redirects to a pre-signed URL instead of serving the bytes', async () => {
      const publicId = await readyVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);

      const location = res.headers['location'] as string;
      expect(location).toContain('X-Amz-Signature');

      // Express writes a short courtesy body with the redirect; what matters is
      // that the API did not move the file. The response is orders of magnitude
      // smaller than the video, and carries none of its bytes.
      // The redirect body is bounded by the length of the URL and does not grow
      // with the file: it would be the same handful of bytes for a 10GB video.
      const bodyLength = Number(res.headers['content-length'] ?? 0);
      expect(bodyLength).toBeLessThan(2048);
      expect(bodyLength).toBeLessThan(fixtureBytes.length);
      expect(res.text).toContain('Redirecting to');
    }, 180_000);

    it('serves the complete file as an attachment when the redirect is followed', async () => {
      const publicId = await readyVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);

      const downloaded = await fetch(res.headers['location'] as string);

      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(fixtureBytes);
    }, 180_000);

    it('returns 404 for a video that is not ready', async () => {
      const publicId = await uploadFixture();

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(404);
    }, 120_000);
  });
});
