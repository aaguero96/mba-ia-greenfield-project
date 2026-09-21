import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Reachable from inside the Compose network: used for control-plane calls and
  // for URLs consumed by the worker.
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  // Reachable from outside Docker: used only to sign URLs handed to clients.
  // A SigV4 signature binds the host, so the two cannot be collapsed (see TD-10).
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  videosBucket: process.env.S3_VIDEOS_BUCKET || 'streamtube-videos',
  thumbnailsBucket: process.env.S3_THUMBNAILS_BUCKET || 'streamtube-thumbnails',
}));
