import queueConfig from './queue.config';

describe('queueConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should default to the Compose service name and the standard port', () => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;

    const config = queueConfig();

    expect(config.host).toBe('redis');
    expect(config.port).toBe(6379);
  });

  it('should read host and port from the environment', () => {
    process.env.REDIS_HOST = 'cache';
    process.env.REDIS_PORT = '6380';

    const config = queueConfig();

    expect(config.host).toBe('cache');
    expect(config.port).toBe(6380);
  });

  it('should leave the producer connection on the default retry budget', () => {
    // A queue used from an HTTP request path must fail fast when Redis is down,
    // so it must NOT carry maxRetriesPerRequest: null.
    const config = queueConfig();

    expect(config.producerConnection).toEqual({
      host: config.host,
      port: config.port,
    });
    expect(config.producerConnection).not.toHaveProperty(
      'maxRetriesPerRequest',
    );
  });

  it('should set maxRetriesPerRequest to null on the worker connection', () => {
    // Required by BullMQ for workers: a background process waits for Redis to
    // come back instead of crashing.
    expect(queueConfig().workerConnection.maxRetriesPerRequest).toBeNull();
  });

  it('should point both connections at the same Redis instance', () => {
    process.env.REDIS_HOST = 'cache';
    process.env.REDIS_PORT = '6390';

    const { producerConnection, workerConnection } = queueConfig();

    expect(producerConnection.host).toBe(workerConnection.host);
    expect(producerConnection.port).toBe(workerConnection.port);
  });
});
