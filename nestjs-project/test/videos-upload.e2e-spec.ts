import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PART_SIZE_BYTES } from '../src/videos/videos.constants';
import { createVideoTestApp, registerAndLogin } from './video-test-client';
import type { AuthenticatedUser } from './video-test-client';

/**
 * The upload lifecycle end to end: sign parts, PUT the bytes straight to
 * storage, complete, cancel. The bytes never pass through the API — the test
 * uploads them with a plain `fetch`, exactly as a browser would.
 */
describe('Videos upload lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let owner: AuthenticatedUser;

  const validBody = {
    title: 'Holiday recap',
    filename: 'holiday.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
  };

  beforeAll(async () => {
    app = await createVideoTestApp();
    dataSource = app.get(DataSource);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    owner = await registerAndLogin(app, `${randomUUID()}@example.com`);
  });

  function initiate(body: Record<string, unknown>, token = owner.accessToken) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function signParts(
    publicId: string,
    partNumbers: number[],
    token = owner.accessToken,
  ) {
    return request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers });
  }

  /** Initiates and uploads a single part directly to storage. */
  async function startUpload(
    payload = Buffer.from('a-small-video-payload'),
  ): Promise<{ publicId: string; payload: Buffer; etag: string }> {
    const res = await initiate({
      ...validBody,
      size_bytes: payload.length,
    }).expect(201);
    const publicId = (res.body as { video: { id: string } }).video.id;

    const signed = await signParts(publicId, [1]).expect(200);
    const url = (signed.body as { parts: { url: string }[] }).parts[0].url;

    const put = await fetch(url, { method: 'PUT', body: payload });
    expect(put.status).toBe(200);

    return { publicId, payload, etag: put.headers.get('etag') as string };
  }

  describe('POST /videos/:id/upload/parts', () => {
    it('returns one signed URL per requested part', async () => {
      const res = await initiate({
        ...validBody,
        size_bytes: VIDEO_PART_SIZE_BYTES * 2,
      }).expect(201);
      const publicId = (res.body as { video: { id: string } }).video.id;

      const signed = await signParts(publicId, [1, 2]).expect(200);
      const parts = (
        signed.body as {
          parts: { part_number: number; url: string; expires_in: number }[];
        }
      ).parts;

      expect(parts).toHaveLength(2);
      expect(parts.map((part) => part.part_number)).toEqual([1, 2]);
      expect(new Set(parts.map((part) => part.url)).size).toBe(2);
      expect(parts[0].expires_in).toBe(21600);
    }, 30_000);

    it('accepts a real PUT to the signed URL and reports the part as uploaded', async () => {
      const started = await startUpload();

      const status = await request(app.getHttpServer())
        .get(`/videos/${started.publicId}/upload`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      const body = status.body as {
        uploaded_parts: { part_number: number; size: number }[];
      };
      expect(body.uploaded_parts).toHaveLength(1);
      expect(body.uploaded_parts[0].part_number).toBe(1);
      expect(body.uploaded_parts[0].size).toBe(started.payload.length);
    }, 30_000);

    it('can re-sign the same part, which is what makes an upload resumable', async () => {
      const res = await initiate(validBody).expect(201);
      const publicId = (res.body as { video: { id: string } }).video.id;

      for (let attempt = 0; attempt < 2; attempt++) {
        const signed = await signParts(publicId, [1]).expect(200);
        expect((signed.body as { parts: unknown[] }).parts).toHaveLength(1);
      }
    }, 30_000);

    it('returns 400 for a part number beyond the upload plan', async () => {
      const res = await initiate(validBody).expect(201);
      const publicId = (res.body as { video: { id: string } }).video.id;

      const failed = await signParts(publicId, [2]).expect(400);
      expect((failed.body as { error: string }).error).toBe(
        'PART_NUMBER_OUT_OF_RANGE',
      );
    }, 30_000);

    it('returns 400 for an empty part list', async () => {
      const res = await initiate(validBody).expect(201);
      const publicId = (res.body as { video: { id: string } }).video.id;

      await signParts(publicId, []).expect(400);
    }, 30_000);

    it('returns 403 when another user asks to sign parts', async () => {
      const res = await initiate(validBody).expect(201);
      const publicId = (res.body as { video: { id: string } }).video.id;

      const intruder = await registerAndLogin(
        app,
        `${randomUUID()}@example.com`,
      );

      const failed = await signParts(
        publicId,
        [1],
        intruder.accessToken,
      ).expect(403);
      expect((failed.body as { error: string }).error).toBe('VIDEO_NOT_OWNED');
    }, 30_000);

    it('returns 404 for an unknown video', async () => {
      await signParts('DoesNotExi1', [1]).expect(404);
    }, 30_000);
  });

  describe('POST /videos/:id/upload/complete', () => {
    it('completes the upload and moves the video to processing', async () => {
      const started = await startUpload();

      const res = await request(app.getHttpServer())
        .post(`/videos/${started.publicId}/upload/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ parts: [{ part_number: 1, etag: started.etag }] })
        .expect(200);

      expect((res.body as { status: string }).status).toBe('processing');

      const rows = await dataSource.query<
        { status: string; upload_id: string | null }[]
      >(`SELECT status, upload_id FROM videos WHERE public_id = $1`, [
        started.publicId,
      ]);
      expect(rows[0].status).toBe('processing');
      expect(rows[0].upload_id).toBeNull();
    }, 60_000);

    it('returns 422 and fails the video when the stored size differs from the declared one', async () => {
      // Declares more than it uploads. The API never sees the bytes, so the
      // mismatch can only be caught by reading the stored object back.
      const res = await initiate({ ...validBody, size_bytes: 9999 }).expect(
        201,
      );
      const publicId = (res.body as { video: { id: string } }).video.id;

      const signed = await signParts(publicId, [1]).expect(200);
      const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
      const put = await fetch(url, { method: 'PUT', body: Buffer.alloc(100) });
      const etag = put.headers.get('etag') as string;

      const failed = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(422);

      expect((failed.body as { error: string }).error).toBe(
        'UPLOAD_SIZE_MISMATCH',
      );

      const rows = await dataSource.query<
        { status: string; processing_error: string }[]
      >(`SELECT status, processing_error FROM videos WHERE public_id = $1`, [
        publicId,
      ]);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].processing_error).toContain('does not match');
    }, 60_000);

    it('returns 409 when completing an already completed upload', async () => {
      const started = await startUpload();
      const parts = [{ part_number: 1, etag: started.etag }];

      await request(app.getHttpServer())
        .post(`/videos/${started.publicId}/upload/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ parts })
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(`/videos/${started.publicId}/upload/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ parts })
        .expect(409);

      expect((second.body as { error: string }).error).toBe(
        'INVALID_UPLOAD_STATE',
      );
    }, 60_000);

    it('returns 400 for an empty part list', async () => {
      const started = await startUpload();

      await request(app.getHttpServer())
        .post(`/videos/${started.publicId}/upload/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ parts: [] })
        .expect(400);
    }, 60_000);
  });

  describe('DELETE /videos/:id/upload', () => {
    it('cancels the draft and removes the row', async () => {
      const started = await startUpload();

      await request(app.getHttpServer())
        .delete(`/videos/${started.publicId}/upload`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(204);

      const rows = await dataSource.query<unknown[]>(
        `SELECT 1 FROM videos WHERE public_id = $1`,
        [started.publicId],
      );
      expect(rows).toHaveLength(0);
    }, 60_000);

    it('returns 403 when another user tries to cancel', async () => {
      const started = await startUpload();
      const intruder = await registerAndLogin(
        app,
        `${randomUUID()}@example.com`,
      );

      await request(app.getHttpServer())
        .delete(`/videos/${started.publicId}/upload`)
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .expect(403);
    }, 60_000);
  });
});
