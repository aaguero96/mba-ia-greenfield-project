import { randomUUID } from 'node:crypto';
import type { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { User } from '../../users/entities/user.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
} from '../videos.constants';
import { Video } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channels: Repository<Channel>;
  let users: Repository<User>;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource([
      User,
      Channel,
      RefreshToken,
      VerificationToken,
      Video,
    ]);
    await dataSource.initialize();

    videos = dataSource.getRepository(Video);
    channels = dataSource.getRepository(Channel);
    users = dataSource.getRepository(User);
  }, 30_000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await users.save(
      users.create({
        email: `${randomUUID()}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'Test Channel',
        nickname: randomUUID().slice(0, 20),
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  function build(overrides: Partial<Video> = {}): Video {
    return videos.create({
      public_id: randomUUID().slice(0, 11),
      channel_id: channelId,
      title: 'A video',
      original_filename: 'holiday.mp4',
      content_type: 'video/mp4',
      size_bytes: String(1024),
      storage_key: `videos/${channelId}/${randomUUID()}/source.mp4`,
      part_size_bytes: VIDEO_PART_SIZE_BYTES,
      part_count: 1,
      ...overrides,
    });
  }

  it('should default a new video to draft status', async () => {
    const saved = await videos.save(build());

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(reloaded.status).toBe('draft');
  });

  it('should auto-populate the timestamps', async () => {
    const saved = await videos.save(build());

    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('should reject a duplicate public_id', async () => {
    const publicId = 'DuplicateId';
    await videos.save(build({ public_id: publicId }));

    await expect(videos.save(build({ public_id: publicId }))).rejects.toThrow(
      /duplicate key|unique/i,
    );
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videos.save(build({ channel_id: randomUUID() })),
    ).rejects.toThrow(/foreign key/i);
  });

  it('should refuse to delete a channel that still owns videos', async () => {
    await videos.save(build());

    await expect(channels.delete({ id: channelId })).rejects.toThrow(
      /foreign key/i,
    );
  });

  it('should round-trip a size above the 32-bit range without losing precision', async () => {
    // 10GiB does not fit in an int4 and is beyond what a float can hold exactly,
    // which is why the column is bigint and the property is a string.
    const saved = await videos.save(
      build({ size_bytes: String(VIDEO_MAX_SIZE_BYTES) }),
    );

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(reloaded.size_bytes).toBe('10737418240');
    expect(typeof reloaded.size_bytes).toBe('string');
  });

  it('should leave the optional processing columns null until the worker runs', async () => {
    const saved = await videos.save(build());

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(reloaded.duration_seconds).toBeNull();
    expect(reloaded.metadata).toBeNull();
    expect(reloaded.thumbnail_key).toBeNull();
    expect(reloaded.processing_error).toBeNull();
    expect(reloaded.description).toBeNull();
  });

  it('should store the duration as a number, not a string', async () => {
    const saved = await videos.save(build({ duration_seconds: 12.345 }));

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(typeof reloaded.duration_seconds).toBe('number');
    expect(reloaded.duration_seconds).toBeCloseTo(12.345, 3);
  });

  it('should persist structured metadata as JSON', async () => {
    const metadata = {
      width: 1920,
      height: 1080,
      codec: 'h264',
      bitrate: 4_500_000,
      formatName: 'mov,mp4,m4a',
    };

    const saved = await videos.save(build({ metadata }));

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(reloaded.metadata).toEqual(metadata);
  });

  it('should accept every status in the lifecycle', async () => {
    for (const status of ['draft', 'processing', 'ready', 'failed'] as const) {
      const saved = await videos.save(build({ status }));
      const reloaded = await videos.findOneByOrFail({ id: saved.id });
      expect(reloaded.status).toBe(status);
    }
  });

  it('should reject a status outside the enum', async () => {
    await expect(
      dataSource.query(
        `UPDATE "videos" SET "status" = 'archived' WHERE "id" = $1`,
        [(await videos.save(build())).id],
      ),
    ).rejects.toThrow();
  });

  it('should load the owning channel through the relation', async () => {
    const saved = await videos.save(build());

    const reloaded = await videos.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(reloaded.channel.id).toBe(channelId);
  });

  it('should expose the videos of a channel through the inverse relation', async () => {
    await videos.save(build());
    await videos.save(build());

    const reloaded = await channels.findOneOrFail({
      where: { id: channelId },
      relations: ['videos'],
    });

    expect(reloaded.videos).toHaveLength(2);
  });
});
