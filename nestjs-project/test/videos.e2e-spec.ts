import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_MAX_SIZE_BYTES, VIDEO_PART_SIZE_BYTES } from '../src/videos/videos.constants';
import { createVideoTestApp, registerAndLogin } from './video-test-client';
import type { AuthenticatedUser } from './video-test-client';

describe('Videos (e2e)', () => {
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

  describe('POST /videos', () => {
    it('returns 201 with a draft video and an upload plan', async () => {
      const res = await initiate(validBody).expect(201);

      const body = res.body as {
        video: Record<string, unknown>;
        upload: Record<string, unknown>;
      };

      expect(body.video.status).toBe('draft');
      expect(body.video.title).toBe(validBody.title);
      expect(body.video.size_bytes).toBe(String(validBody.size_bytes));
      expect(body.upload.upload_id).toEqual(expect.any(String));
      expect(body.upload.part_size).toBe(VIDEO_PART_SIZE_BYTES);
      expect(body.upload.part_count).toBe(1);
    }, 30_000);

    it('generates a short unique public id and the derived URLs', async () => {
      const res = await initiate(validBody).expect(201);
      const video = (res.body as { video: Record<string, string | null> }).video;

      expect(video.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(video.url).toContain(`/videos/${video.id}`);
      expect(video.stream_url).toBe(`${video.url}/stream`);
      expect(video.download_url).toBe(`${video.url}/download`);
      // No thumbnail exists until the worker has processed the video.
      expect(video.thumbnail_url).toBeNull();
    }, 30_000);

    it('gives two videos different public ids', async () => {
      const first = await initiate(validBody).expect(201);
      const second = await initiate(validBody).expect(201);

      expect((first.body as { video: { id: string } }).video.id).not.toBe(
        (second.body as { video: { id: string } }).video.id,
      );
    }, 30_000);

    it('computes the part count from the declared size', async () => {
      const res = await initiate({
        ...validBody,
        size_bytes: VIDEO_PART_SIZE_BYTES * 3 + 1,
      }).expect(201);

      expect((res.body as { upload: { part_count: number } }).upload.part_count).toBe(4);
    }, 30_000);

    it('accepts a declared size of exactly 10GiB', async () => {
      const res = await initiate({
        ...validBody,
        size_bytes: VIDEO_MAX_SIZE_BYTES,
      }).expect(201);

      // 10GiB at 64MiB parts is 160 parts — far below the 10,000 limit.
      expect((res.body as { upload: { part_count: number } }).upload.part_count).toBe(160);
    }, 30_000);

    it('returns 400 when the declared size exceeds 10GiB', async () => {
      const res = await initiate({
        ...validBody,
        size_bytes: VIDEO_MAX_SIZE_BYTES + 1,
      }).expect(400);

      expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for a content type outside the allowlist', async () => {
      await initiate({ ...validBody, content_type: 'application/zip' }).expect(400);
    });

    it('returns 400 when the title is missing', async () => {
      const { title, ...withoutTitle } = validBody;
      await initiate(withoutTitle).expect(400);
    });

    it('returns 400 for unknown extra fields', async () => {
      await initiate({ ...validBody, channel_id: randomUUID() }).expect(400);
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validBody)
        .expect(401);
    });

    it('assigns the video to the caller own channel, never to a supplied one', async () => {
      const res = await initiate(validBody).expect(201);
      const video = (res.body as { video: { id: string; channel: { id: string } } }).video;

      const rows = await dataSource.query<{ channel_id: string; user_id: string }[]>(
        `SELECT v.channel_id, c.user_id FROM videos v
         JOIN channels c ON c.id = v.channel_id
         WHERE v.public_id = $1`,
        [video.id],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].channel_id).toBe(video.channel.id);
    }, 30_000);

    it('persists the draft row with an open multipart upload', async () => {
      const res = await initiate(validBody).expect(201);
      const { video, upload } = res.body as {
        video: { id: string };
        upload: { upload_id: string };
      };

      const rows = await dataSource.query<
        { status: string; upload_id: string; storage_key: string }[]
      >(`SELECT status, upload_id, storage_key FROM videos WHERE public_id = $1`, [
        video.id,
      ]);

      expect(rows[0].status).toBe('draft');
      expect(rows[0].upload_id).toBe(upload.upload_id);
      expect(rows[0].storage_key).toMatch(/^videos\/.+\/source\.mp4$/);
    }, 30_000);
  });
});
