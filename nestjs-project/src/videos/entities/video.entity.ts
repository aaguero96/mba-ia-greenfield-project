import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  VIDEO_PUBLIC_ID_LENGTH,
  VIDEO_STATUS_ENUM_NAME,
  VIDEO_STATUSES,
} from '../videos.constants';
import type { VideoStatus } from '../videos.constants';

export interface VideoMetadata {
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  formatName: string | null;
}

@Entity('videos')
@Index(['channel_id', 'status'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Short opaque handle used in every public URL (see TD-04). */
  @Column({ type: 'varchar', length: VIDEO_PUBLIC_ID_LENGTH, unique: true })
  public_id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  /** Reserved for Fase 04, which introduces video editing. */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: VIDEO_STATUSES,
    enumName: VIDEO_STATUS_ENUM_NAME,
    default: 'draft',
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  /**
   * PostgreSQL `bigint` exceeds JavaScript's safe integer range, so TypeORM maps
   * it to `string`. Every consumer must treat it as such — coercing to a number
   * would silently lose precision above 2^53.
   */
  @Column({ type: 'bigint' })
  size_bytes: string;

  @Column({ type: 'varchar', length: 512 })
  storage_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** S3 multipart UploadId; cleared once the upload is completed or aborted. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'integer' })
  part_size_bytes: number;

  @Column({ type: 'integer' })
  part_count: number;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value === null ? null : Number(value)),
    },
  })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  /** Why processing failed, kept so `failed` is actionable rather than opaque. */
  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
