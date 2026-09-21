import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Exercises the real MinIO service from the Compose stack — no mocks. The point
 * of these tests is precisely the parts that a mock would hide: whether a
 * pre-signed URL is actually accepted by the store, and whether a range request
 * returns the exact bytes.
 */
describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    // init() triggers onModuleInit, which provisions the buckets.
    await moduleRef.init();
    storage = moduleRef.get(StorageService);
  }, 30_000);

  afterAll(async () => {
    for (const key of createdKeys) {
      try {
        await storage.deleteObject(key);
      } catch {
        // already gone
      }
    }
    await moduleRef.close();
  });

  function uniqueKey(suffix = 'source.bin'): string {
    const key = `videos/${randomUUID()}/${randomUUID()}/${suffix}`;
    createdKeys.push(key);
    return key;
  }

  describe('bucket bootstrap', () => {
    it('should have created both buckets on module init', async () => {
      // A bucket that does not exist makes headObject on any key fail with
      // NoSuchBucket rather than NotFound, so a successful "missing object"
      // probe proves the bucket is there.
      await expect(storage.objectExists('definitely-missing')).resolves.toBe(
        false,
      );
      await expect(
        storage.objectExists('definitely-missing', storage.thumbnailsBucket),
      ).resolves.toBe(false);
    });

    it('should be idempotent when run a second time', async () => {
      await expect(storage.ensureBuckets()).resolves.toBeUndefined();
    });
  });

  describe('multipart upload lifecycle', () => {
    it('should complete a multipart upload through pre-signed part URLs', async () => {
      const key = uniqueKey();
      // Two parts: the first must be at least 5MiB, the last may be smaller.
      const firstPart = Buffer.alloc(5 * 1024 * 1024, 0x41);
      const secondPart = Buffer.from('tail-bytes');

      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const uploaded = await Promise.all(
        [firstPart, secondPart].map(async (body, index) => {
          const partNumber = index + 1;
          const url = await storage.signUploadPart(
            key,
            uploadId,
            partNumber,
            900,
          );

          // Deliberately a plain fetch, with no AWS SDK on the client side —
          // this is what a browser does, and it is what breaks when the SDK
          // signs checksum headers the client cannot reproduce.
          const response = await fetch(url, { method: 'PUT', body });
          expect(response.status).toBe(200);

          const etag = response.headers.get('etag');
          expect(etag).toBeTruthy();

          return { partNumber, etag: etag as string };
        }),
      );

      const listed = await storage.listParts(key, uploadId);
      expect(listed).toHaveLength(2);
      expect(listed.map((part) => part.partNumber)).toEqual([1, 2]);
      expect(listed[0].size).toBe(firstPart.length);

      await storage.completeMultipartUpload(key, uploadId, uploaded);

      const head = await storage.headObject(key);
      expect(head.contentLength).toBe(firstPart.length + secondPart.length);
      expect(head.contentType).toBe('video/mp4');
    }, 60_000);

    it('should sort parts before completing even when given out of order', async () => {
      const key = uniqueKey();
      const first = Buffer.alloc(5 * 1024 * 1024, 0x42);
      const second = Buffer.from('second');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const parts: { partNumber: number; etag: string }[] = [];
      for (const [index, body] of [first, second].entries()) {
        const partNumber = index + 1;
        const url = await storage.signUploadPart(
          key,
          uploadId,
          partNumber,
          900,
        );
        const response = await fetch(url, { method: 'PUT', body });
        parts.push({
          partNumber,
          etag: response.headers.get('etag') as string,
        });
      }

      // Reversed on purpose: S3 rejects an unsorted part list.
      await storage.completeMultipartUpload(key, uploadId, parts.reverse());

      const head = await storage.headObject(key);
      expect(head.contentLength).toBe(first.length + second.length);
    }, 60_000);

    it('should free the parts when a multipart upload is aborted', async () => {
      const key = uniqueKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const url = await storage.signUploadPart(key, uploadId, 1, 900);
      await fetch(url, { method: 'PUT', body: Buffer.alloc(1024, 0x43) });

      expect(await storage.listParts(key, uploadId)).toHaveLength(1);

      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listParts(key, uploadId)).rejects.toThrow();
      await expect(storage.objectExists(key)).resolves.toBe(false);
    }, 30_000);
  });

  describe('object reads', () => {
    const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    let key: string;

    beforeAll(async () => {
      key = uniqueKey('range.bin');
      await storage.putObject(key, payload, 'application/octet-stream');
    });

    async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      return Buffer.concat(chunks);
    }

    it('should return the whole object when no range is given', async () => {
      const result = await storage.getObjectRange(key);
      expect(result.contentLength).toBe(payload.length);
      expect(await readStream(result.stream)).toEqual(payload);
    });

    it('should return exactly the requested byte range', async () => {
      const result = await storage.getObjectRange(key, 'bytes=10-19');

      expect(result.contentLength).toBe(10);
      expect(result.contentRange).toBe(`bytes 10-19/${payload.length}`);
      expect(await readStream(result.stream)).toEqual(payload.subarray(10, 20));
    });

    it('should support an open-ended range', async () => {
      const result = await storage.getObjectRange(key, 'bytes=30-');

      expect(await readStream(result.stream)).toEqual(payload.subarray(30));
    });

    it('should report the head of an object', async () => {
      const head = await storage.headObject(key);
      expect(head.contentLength).toBe(payload.length);
    });
  });

  describe('pre-signed GET URLs', () => {
    let key: string;
    const payload = Buffer.from('downloadable-content');

    beforeAll(async () => {
      key = uniqueKey('download.bin');
      await storage.putObject(key, payload, 'video/mp4');
    });

    it('should produce a fetchable URL carrying a content disposition', async () => {
      const url = await storage.signGetObject(key, 300, {
        responseContentDisposition: 'attachment; filename="holiday.mp4"',
      });

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="holiday.mp4"',
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    });

    it('should sign client and worker URLs for different hosts', async () => {
      // A SigV4 signature binds the Host header, so which client signs decides
      // which host the recipient must resolve (TD-10). Built with a deliberately
      // distinct public endpoint so the split is visible; no fetch here, because
      // the point being asserted is the signed host, not reachability.
      const previous = process.env.S3_PUBLIC_ENDPOINT;
      process.env.S3_PUBLIC_ENDPOINT = 'http://cdn.example.test:9000';

      const isolated = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [storageConfig],
            ignoreEnvFile: true,
          }),
          StorageModule,
        ],
      }).compile();

      try {
        const isolatedStorage = isolated.get(StorageService);

        const clientUrl = await isolatedStorage.signGetObject(key, 300);
        const workerUrl = await isolatedStorage.signInternalGetObject(key, 300);

        expect(clientUrl).toContain('cdn.example.test:9000');
        expect(workerUrl).toContain('minio:9000');
        expect(clientUrl).not.toContain('minio:9000');
      } finally {
        await isolated.close();
        process.env.S3_PUBLIC_ENDPOINT = previous;
      }
    }, 30_000);

    it('should produce an internal URL the worker can actually fetch', async () => {
      // The test process runs inside the Compose network, exactly like the worker.
      const url = await storage.signInternalGetObject(key, 300);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    });
  });

  describe('thumbnails bucket', () => {
    it('should store and read back an object in the thumbnails bucket', async () => {
      const key = `thumbnails/${randomUUID()}/thumb.jpg`;
      const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      await storage.putObject(
        key,
        body,
        'image/jpeg',
        storage.thumbnailsBucket,
      );

      const head = await storage.headObject(key, storage.thumbnailsBucket);
      expect(head.contentLength).toBe(body.length);
      expect(head.contentType).toBe('image/jpeg');

      await storage.deleteObject(key, storage.thumbnailsBucket);
      await expect(
        storage.objectExists(key, storage.thumbnailsBucket),
      ).resolves.toBe(false);
    });
  });
});
