import { ApiProperty } from '@nestjs/swagger';
import { VIDEO_STATUSES } from '../videos.constants';
import type { VideoStatus } from '../videos.constants';

export class VideoChannelDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'streamtube_user' })
  nickname: string;
}

export class VideoMetadataDto {
  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ nullable: true, example: 'h264' })
  codec: string | null;

  @ApiProperty({ nullable: true, example: 4500000 })
  bitrate: number | null;

  @ApiProperty({ nullable: true, example: 'mov,mp4,m4a' })
  formatName: string | null;
}

export class VideoResponseDto {
  @ApiProperty({ description: 'Short unique public identifier', example: 'AbCdEfGhIjK' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ required: false, nullable: true })
  description: string | null;

  @ApiProperty({ enum: VIDEO_STATUSES })
  status: VideoStatus;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty({ required: false, nullable: true, example: 128.4 })
  duration_seconds: number | null;

  @ApiProperty({
    description:
      'Size in bytes. A string because the value can exceed the safe integer range.',
    example: '10737418240',
  })
  size_bytes: string;

  @ApiProperty()
  content_type: string;

  @ApiProperty({ type: VideoMetadataDto, required: false, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ required: false, nullable: true })
  processing_error: string | null;

  @ApiProperty({ description: 'Unique URL of the video' })
  url: string;

  @ApiProperty()
  stream_url: string;

  @ApiProperty()
  download_url: string;

  @ApiProperty({ required: false, nullable: true })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}

export class UploadPlanDto {
  @ApiProperty({ description: 'S3 multipart upload identifier' })
  upload_id: string;

  @ApiProperty({ description: 'Size of every part but the last, in bytes', example: 67108864 })
  part_size: number;

  @ApiProperty({ description: 'Number of parts the client must upload', example: 160 })
  part_count: number;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}
