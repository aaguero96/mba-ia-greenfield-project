import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage', () => {
  it('should reject a missing S3_ACCESS_KEY', () => {
    const { S3_ACCESS_KEY, ...withoutAccessKey } = requiredEnv;
    const { error } = envValidationSchema.validate(withoutAccessKey, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY');
  });

  it('should reject a missing S3_SECRET_KEY', () => {
    const { S3_SECRET_KEY, ...withoutSecretKey } = requiredEnv;
    const { error } = envValidationSchema.validate(withoutSecretKey, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should default both endpoints to the Compose service and the host', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
  });

  it('should default both bucket names', () => {
    const { value } = validate({});
    expect(value.S3_VIDEOS_BUCKET).toBe('streamtube-videos');
    expect(value.S3_THUMBNAILS_BUCKET).toBe('streamtube-thumbnails');
  });

  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'not-a-uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});

describe('envValidationSchema — queue', () => {
  it('should default REDIS_HOST to the Compose service name', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should reject a REDIS_PORT outside the valid port range', () => {
    const { error } = validate({ REDIS_PORT: '99999' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});

describe('envValidationSchema — video', () => {
  it('should apply the TD-14 default TTLs', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.VIDEO_UPLOAD_URL_TTL).toBe(21600);
    expect(value.VIDEO_PROBE_URL_TTL).toBe(3600);
    expect(value.VIDEO_DOWNLOAD_URL_TTL).toBe(900);
  });

  it('should reject a TTL beyond the SigV4 maximum of 7 days', () => {
    const { error } = validate({ VIDEO_UPLOAD_URL_TTL: '604801' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_URL_TTL');
  });

  it('should reject a thumbnail percent outside [0, 1]', () => {
    const { error } = validate({ VIDEO_THUMBNAIL_PERCENT: '1.5' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_THUMBNAIL_PERCENT');
  });
});
