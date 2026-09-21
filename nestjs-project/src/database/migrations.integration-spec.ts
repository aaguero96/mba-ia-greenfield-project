import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1789976416136 } from './migrations/1789976416136-CreateVideos';
import { Video } from '../videos/entities/video.entity';
import { createTestDataSource } from '../test/create-test-data-source';

// Reverse dependency order: a dependent table is dropped before the table it
// references. `CASCADE` would remove the constraints anyway, but dropping these
// concurrently (as this list previously was, via Promise.all) races on the shared
// locks and can leave a table behind — which then fails the migration with
// `relation "channels" already exists`.
const MANAGED_TABLES = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
];

// Dropping the tables is not enough: a PostgreSQL enum type outlives its table and
// is also created by any suite running with `synchronize: true`. Leaving one behind
// makes the next `CREATE TYPE` inside a migration fail with
// `type "..." already exists` — which is why this suite passed in isolation but
// failed inside a full run.
const MANAGED_ENUMS = ['verification_tokens_type_enum', 'videos_status_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1789976416136,
        ],
      },
    );

    await dataSource.initialize();

    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // Enum types must be dropped after their tables, never concurrently with them.
    for (const enumName of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "${enumName}" CASCADE`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the videos table and its enum', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(tables).toHaveLength(0);

    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typtype = 'e' AND typname = $1`,
      ['videos_status_enum'],
    );
    expect(enums).toHaveLength(0);
  });

  it('should revert the auth token migration as well', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
