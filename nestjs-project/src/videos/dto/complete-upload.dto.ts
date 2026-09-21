import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { VIDEO_MAX_PARTS } from '../videos.constants';

export class CompletedPartDto {
  /** Part number as sent to storage. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_PARTS)
  part_number: number;

  /** ETag returned by storage for that part. */
  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  /** Every part that was uploaded, with the ETag storage returned. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
