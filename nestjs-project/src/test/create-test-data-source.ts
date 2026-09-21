import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';
import { ALL_ENTITIES } from '../database/entities';

export { ALL_ENTITIES };

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

export function createTestDataSource(
  entities: (Function | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

/**
 * Wipes every table in one statement.
 *
 * A sequence of DELETEs is sensitive to ordering and to anything else holding a
 * connection — an e2e suite that also boots the worker context has two pools
 * against the same database, and a delete that lands out of order fails with a
 * foreign-key violation. TRUNCATE ... CASCADE is atomic and order-independent.
 */
export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    'TRUNCATE TABLE "videos", "refresh_tokens", "verification_tokens", "channels", "users" CASCADE',
  );
}
