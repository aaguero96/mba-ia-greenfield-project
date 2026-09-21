import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

function buildClient(
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client {
  return new S3Client({
    region: config.region,
    endpoint,
    // MinIO serves buckets as a path segment, not as a subdomain.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    // Since v3.729 the SDK attaches CRC32 checksum headers by default. For a
    // pre-signed request that bakes the checksum of an empty body into the
    // signature, and S3-compatible stores reject the headers outright — the
    // client then fails with SignatureDoesNotMatch when it uploads real bytes.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: S3_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config, config.endpoint),
    },
    {
      provide: S3_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config, config.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
