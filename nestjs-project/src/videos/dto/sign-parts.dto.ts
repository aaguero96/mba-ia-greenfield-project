import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';
import {
  VIDEO_MAX_PARTS,
  VIDEO_MAX_PARTS_PER_SIGN_REQUEST,
} from '../videos.constants';

export class SignPartsDto {
  /**
   * Part numbers to sign. A client resuming an upload asks only for the parts
   * it still has to send.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(VIDEO_MAX_PARTS_PER_SIGN_REQUEST)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(VIDEO_MAX_PARTS, { each: true })
  part_numbers: number[];
}
