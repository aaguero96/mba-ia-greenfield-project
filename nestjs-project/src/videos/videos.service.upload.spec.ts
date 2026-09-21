import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import appConfig from '../config/app.config';
import videoConfig from '../config/video.config';
import {
  InvalidUploadStateException,
  PartNumberOutOfRangeException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VideosService } from './videos.service';

const OWNER = 'user-1';

function draft(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-uuid',
    public_id: 'AbCdEfGhIjK',
    channel_id: 'ch-1',
    title: 'A video',
    description: null,
    status: 'draft',
    original_filename: 'holiday.mp4',
    content_type: 'video/mp4',
    size_bytes: '1024',
    storage_key: 'videos/ch-1/video-uuid/source.mp4',
    thumbnail_key: null,
    upload_id: 'upload-1',
    part_size_bytes: 67_108_864,
    part_count: 2,
    duration_seconds: null,
    metadata: null,
    processing_error: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    channel: { id: 'ch-1', nickname: 'tester', user_id: OWNER },
    ...overrides,
  } as Video;
}

describe('VideosService — upload lifecycle', () => {
  let service: VideosService;
  let videoRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };
  let storage: {
    signUploadPart: jest.Mock;
    listParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
  };
  let queue: { enqueueProcessing: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      findOne: jest.fn().mockResolvedValue(draft()),
      save: jest.fn((video: Video) => Promise.resolve(video)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      signUploadPart: jest
        .fn()
        .mockImplementation((_key, _upload, partNumber: number) =>
          Promise.resolve(`https://storage.test/part-${partNumber}`),
        ),
      listParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 1024 }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    queue = { enqueueProcessing: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: DataSource, useValue: { getRepository: jest.fn() } },
        { provide: StorageService, useValue: storage },
        { provide: VideoQueueService, useValue: queue },
        { provide: videoConfig.KEY, useValue: videoConfig() },
        { provide: appConfig.KEY, useValue: { url: 'http://localhost:3000' } },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  describe('ownership and state guards', () => {
    it('should reject an unknown video', async () => {
      videoRepository.findOne.mockResolvedValueOnce(null);

      await expect(
        service.signUploadParts(OWNER, 'missing', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject a video owned by another user', async () => {
      videoRepository.findOne.mockResolvedValueOnce(
        draft({ channel: { id: 'ch-2', nickname: 'x', user_id: 'other' } as never }),
      );

      await expect(
        service.signUploadParts(OWNER, 'AbCdEfGhIjK', [1]),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);
    });

    it('should reject a video whose upload is already closed', async () => {
      videoRepository.findOne.mockResolvedValueOnce(
        draft({ status: 'processing', upload_id: null }),
      );

      await expect(
        service.signUploadParts(OWNER, 'AbCdEfGhIjK', [1]),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);
    });
  });

  describe('signUploadParts', () => {
    it('should return one URL per requested part with the configured TTL', async () => {
      const result = await service.signUploadParts(OWNER, 'AbCdEfGhIjK', [1, 2]);

      expect(result.parts).toHaveLength(2);
      expect(result.parts[0]).toEqual({
        part_number: 1,
        url: 'https://storage.test/part-1',
        expires_in: videoConfig().uploadUrlTtl,
      });
    });

    it('should reject a part number beyond the upload plan', async () => {
      await expect(
        service.signUploadParts(OWNER, 'AbCdEfGhIjK', [3]),
      ).rejects.toBeInstanceOf(PartNumberOutOfRangeException);

      expect(storage.signUploadPart).not.toHaveBeenCalled();
    });
  });

  describe('getUploadStatus', () => {
    it('should report the parts storage already holds', async () => {
      storage.listParts.mockResolvedValueOnce([
        { partNumber: 1, size: 100, etag: 'etag-1' },
      ]);

      const result = await service.getUploadStatus(OWNER, 'AbCdEfGhIjK');

      expect(result.uploaded_parts).toEqual([
        { part_number: 1, size: 100, etag: 'etag-1' },
      ]);
      expect(result.part_count).toBe(2);
    });
  });

  describe('completeUpload', () => {
    const parts = [{ part_number: 1, etag: 'etag-1' }];

    it('should complete the upload, clear the upload id and enqueue processing', async () => {
      const result = await service.completeUpload(OWNER, 'AbCdEfGhIjK', parts);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/ch-1/video-uuid/source.mp4',
        'upload-1',
        [{ partNumber: 1, etag: 'etag-1' }],
      );
      expect(result.status).toBe('processing');
      expect(queue.enqueueProcessing).toHaveBeenCalledWith('video-uuid');
    });

    it('should verify the stored size against the declared one', async () => {
      await service.completeUpload(OWNER, 'AbCdEfGhIjK', parts);

      // The declared size is client-supplied, so the stored object is the only
      // authority — this is the enforcement point of the 10GB limit.
      expect(storage.headObject).toHaveBeenCalledWith(
        'videos/ch-1/video-uuid/source.mp4',
      );
    });

    it('should reject a size mismatch, delete the object and not enqueue', async () => {
      storage.headObject.mockResolvedValueOnce({ contentLength: 999 });

      await expect(
        service.completeUpload(OWNER, 'AbCdEfGhIjK', parts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      expect(storage.deleteObject).toHaveBeenCalledTimes(1);
      expect(queue.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('should mark the video failed with a reason on a size mismatch', async () => {
      storage.headObject.mockResolvedValueOnce({ contentLength: 999 });

      await expect(
        service.completeUpload(OWNER, 'AbCdEfGhIjK', parts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      const saved = videoRepository.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe('failed');
      expect(saved.processing_error).toContain('does not match');
      expect(saved.upload_id).toBeNull();
    });

    it('should enqueue only after the row has been saved', async () => {
      const order: string[] = [];
      videoRepository.save.mockImplementation((video: Video) => {
        order.push('save');
        return Promise.resolve(video);
      });
      queue.enqueueProcessing.mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve();
      });

      await service.completeUpload(OWNER, 'AbCdEfGhIjK', parts);

      // A job must never point at a video that is not yet `processing`.
      expect(order).toEqual(['save', 'enqueue']);
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and remove the draft row', async () => {
      await service.abortUpload(OWNER, 'AbCdEfGhIjK');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/ch-1/video-uuid/source.mp4',
        'upload-1',
      );
      expect(videoRepository.remove).toHaveBeenCalledTimes(1);
    });

    it('should still remove the row when the storage abort fails', async () => {
      storage.abortMultipartUpload.mockRejectedValueOnce(new Error('gone'));

      await expect(
        service.abortUpload(OWNER, 'AbCdEfGhIjK'),
      ).resolves.toBeUndefined();
      expect(videoRepository.remove).toHaveBeenCalledTimes(1);
    });
  });
});
