import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  VIDEO_MAX_SIZE_BYTES,
} from '../videos.constants';

export class InitiateUploadDto {
  /** Title shown for the video. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  /** Original filename; only its extension reaches the storage key. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /** MIME type of the file about to be uploaded. */
  @IsIn([...ALLOWED_VIDEO_CONTENT_TYPES])
  content_type: string;

  /**
   * Declared size in bytes, up to 10GiB. It is verified against the stored
   * object once the upload completes — a client cannot be trusted with it.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_SIZE_BYTES)
  size_bytes: number;
}
