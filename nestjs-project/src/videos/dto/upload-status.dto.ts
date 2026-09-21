import { ApiProperty } from '@nestjs/swagger';

export class SignedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Pre-signed URL the client PUTs the part to' })
  url: string;

  @ApiProperty({ description: 'Lifetime of the URL in seconds', example: 21600 })
  expires_in: number;
}

export class SignPartsResponseDto {
  @ApiProperty({ type: [SignedPartDto] })
  parts: SignedPartDto[];
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 67108864 })
  size: number;

  @ApiProperty({ example: '"9b2cf5…"' })
  etag: string;
}

export class UploadStatusResponseDto {
  @ApiProperty()
  upload_id: string;

  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 160 })
  part_count: number;

  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Parts already stored, so a resuming client can skip them',
  })
  uploaded_parts: UploadedPartDto[];
}
