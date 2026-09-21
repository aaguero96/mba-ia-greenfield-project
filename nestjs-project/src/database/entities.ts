import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { User } from '../users/entities/user.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';

/**
 * Every entity in the schema, in one place.
 *
 * TypeORM builds metadata for the whole graph at once, so a DataSource that
 * registers only part of it fails with "Entity metadata for X#y was not found"
 * as soon as an inverse relation points at a missing entity. `autoLoadEntities`
 * covers the API, where every entity is reachable through a module's
 * `forFeature`, but the worker and the test DataSources need the explicit list.
 */
export const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];
