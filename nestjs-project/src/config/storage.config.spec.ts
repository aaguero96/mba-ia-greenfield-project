import storageConfig from './storage.config';

describe('storageConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should default the internal endpoint to the Compose service name', () => {
    delete process.env.S3_ENDPOINT;
    expect(storageConfig().endpoint).toBe('http://minio:9000');
  });

  it('should default the public endpoint to a host-resolvable address', () => {
    delete process.env.S3_PUBLIC_ENDPOINT;
    expect(storageConfig().publicEndpoint).toBe('http://localhost:9000');
  });

  it('should keep the two endpoints independent', () => {
    process.env.S3_ENDPOINT = 'http://minio:9000';
    process.env.S3_PUBLIC_ENDPOINT = 'https://cdn.example.com';

    const config = storageConfig();

    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.publicEndpoint).toBe('https://cdn.example.com');
  });

  it('should read credentials from the environment', () => {
    process.env.S3_ACCESS_KEY = 'my-access';
    process.env.S3_SECRET_KEY = 'my-secret';

    const config = storageConfig();

    expect(config.accessKey).toBe('my-access');
    expect(config.secretKey).toBe('my-secret');
  });

  it('should default both bucket names', () => {
    delete process.env.S3_VIDEOS_BUCKET;
    delete process.env.S3_THUMBNAILS_BUCKET;

    const config = storageConfig();

    expect(config.videosBucket).toBe('streamtube-videos');
    expect(config.thumbnailsBucket).toBe('streamtube-thumbnails');
  });

  it('should override bucket names from the environment', () => {
    process.env.S3_VIDEOS_BUCKET = 'custom-videos';
    process.env.S3_THUMBNAILS_BUCKET = 'custom-thumbs';

    const config = storageConfig();

    expect(config.videosBucket).toBe('custom-videos');
    expect(config.thumbnailsBucket).toBe('custom-thumbs');
  });

  it('should default the region', () => {
    delete process.env.S3_REGION;
    expect(storageConfig().region).toBe('us-east-1');
  });
});
