import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import appConfig from '../config/app.config';
import videoConfig from '../config/video.config';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  PartCountExceededException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { VideoQueueService } from './video-queue.service';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VIDEO_MAX_PARTS, VIDEO_PART_SIZE_BYTES } from './videos.constants';

const CHANNEL = {
  id: 'ch-1',
  nickname: 'tester',
  user_id: 'user-1',
} as Channel;

function uniqueViolation(detail: string): QueryFailedError {
  const error = new QueryFailedError('insert', [], new Error(detail));
  (error as unknown as { driverError: unknown }).driverError = {
    code: '23505',
    detail,
  };
  return error;
}

describe('VideosService — initiateUpload', () => {
  let service: VideosService;
  let videoRepository: { create: jest.Mock; save: jest.Mock };
  let channelRepository: { findOne: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };

  const dto = {
    title: 'A video',
    filename: 'holiday.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
  };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
      save: jest.fn((video: Video) =>
        Promise.resolve({
          ...video,
          created_at: new Date('2026-01-01T00:00:00Z'),
          updated_at: new Date('2026-01-01T00:00:00Z'),
          description: null,
          duration_seconds: null,
          metadata: null,
          processing_error: null,
          thumbnail_key: null,
        }),
      ),
    };
    channelRepository = { findOne: jest.fn().mockResolvedValue(CHANNEL) };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        {
          provide: DataSource,
          useValue: { getRepository: () => channelRepository },
        },
        { provide: StorageService, useValue: storage },
        { provide: VideoQueueService, useValue: { enqueueProcessing: jest.fn() } },
        { provide: videoConfig.KEY, useValue: videoConfig() },
        { provide: appConfig.KEY, useValue: { url: 'http://localhost:3000' } },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  it('should reject a user without a channel', async () => {
    channelRepository.findOne.mockResolvedValueOnce(null);

    await expect(service.initiateUpload('user-1', dto)).rejects.toBeInstanceOf(
      ChannelNotFoundException,
    );
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should round the part count up so the tail byte gets a part', async () => {
    const result = await service.initiateUpload('user-1', {
      ...dto,
      size_bytes: VIDEO_PART_SIZE_BYTES + 1,
    });

    expect(result.upload.part_count).toBe(2);
    expect(result.upload.part_size).toBe(VIDEO_PART_SIZE_BYTES);
  });

  it('should require exactly one part for a file smaller than the part size', async () => {
    const result = await service.initiateUpload('user-1', dto);
    expect(result.upload.part_count).toBe(1);
  });

  it('should reject an upload that would exceed the part limit', async () => {
    await expect(
      service.initiateUpload('user-1', {
        ...dto,
        size_bytes: VIDEO_PART_SIZE_BYTES * (VIDEO_MAX_PARTS + 1),
      }),
    ).rejects.toBeInstanceOf(PartCountExceededException);

    // The check runs before any storage call, so nothing is left to clean up.
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should open the multipart upload under a channel-scoped key', async () => {
    await service.initiateUpload('user-1', dto);

    const [key, contentType] = storage.createMultipartUpload.mock.calls[0];
    expect(key).toMatch(/^videos\/ch-1\/[0-9a-f-]{36}\/source\.mp4$/);
    expect(contentType).toBe('video/mp4');
  });

  it('should persist the video as a draft', async () => {
    const result = await service.initiateUpload('user-1', dto);

    expect(result.video.status).toBe('draft');
    expect(videoRepository.save).toHaveBeenCalledTimes(1);
  });

  it('should retry with a fresh public id when one collides', async () => {
    videoRepository.save.mockRejectedValueOnce(
      uniqueViolation('Key (public_id)=(AbCdEfGhIjK) already exists.'),
    );

    const result = await service.initiateUpload('user-1', dto);

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(result.video.id).toBeDefined();
    // The abandoned attempt must not leave an open multipart upload behind.
    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it('should not retry on a unique violation from another column', async () => {
    videoRepository.save.mockRejectedValue(
      uniqueViolation('Key (storage_key)=(x) already exists.'),
    );

    await expect(service.initiateUpload('user-1', dto)).rejects.toBeInstanceOf(
      QueryFailedError,
    );
    expect(videoRepository.save).toHaveBeenCalledTimes(1);
  });

  it('should abort the multipart upload when persisting fails', async () => {
    videoRepository.save.mockRejectedValue(new Error('db down'));

    await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
      'db down',
    );
    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it('should not surface an abort failure over the original error', async () => {
    videoRepository.save.mockRejectedValue(new Error('db down'));
    storage.abortMultipartUpload.mockRejectedValue(new Error('storage down'));

    await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
      'db down',
    );
  });

  it('should return the derived absolute URLs', async () => {
    const result = await service.initiateUpload('user-1', dto);
    const { video } = result;

    expect(video.url).toBe(`http://localhost:3000/videos/${video.id}`);
    expect(video.stream_url).toBe(`${video.url}/stream`);
    expect(video.download_url).toBe(`${video.url}/download`);
    expect(video.thumbnail_url).toBeNull();
  });

  it('should expose the size as a string to preserve precision', async () => {
    const result = await service.initiateUpload('user-1', {
      ...dto,
      size_bytes: 10_737_418_240,
    });

    expect(result.video.size_bytes).toBe('10737418240');
  });
});
