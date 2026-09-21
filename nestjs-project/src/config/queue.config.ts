import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => {
  const host = process.env.REDIS_HOST || 'redis';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);

  return {
    host,
    port,
    /**
     * Redis key prefix for every queue. Tests override it (see
     * `test/setup-test-env.ts`) so the worker running in its own container never
     * consumes jobs a test enqueued, which would make queue assertions flaky.
     */
    prefix: process.env.QUEUE_PREFIX || 'streamtube',
    /**
     * Producer side (HTTP request path): keep ioredis' default retry budget so a
     * request fails fast when Redis is down instead of hanging the caller.
     */
    producerConnection: { host, port },
    /**
     * Worker side: BullMQ's connection guide requires `maxRetriesPerRequest: null`
     * for workers — a background process should wait for Redis to come back
     * rather than crash. The two connections must not be shared.
     */
    workerConnection: { host, port, maxRetriesPerRequest: null },
  };
});
