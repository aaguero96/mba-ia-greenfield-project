---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    source: "https://docs.nestjs.com/techniques/queues"
    fetched_at: "2026-09-21T05:10:00-03:00"
  bullmq:
    version: "^6.3.8"
    source: "https://docs.bullmq.io/guide/connections"
    fetched_at: "2026-09-21T05:10:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1136.0"
    source: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html"
    fetched_at: "2026-09-21T05:12:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1136.0"
    source: "https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/"
    fetched_at: "2026-09-21T05:12:00-03:00"
infra:
  redis:
    image: "redis:8-alpine"
    resolved_version: "8.10.1"
    verified_at: "2026-09-21T05:15:00-03:00"
  minio:
    image: "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z"
    resolved_version: "RELEASE.2025-09-07T16-13-09Z"
    verified_at: "2026-09-21T05:16:00-03:00"
    note: "docker.io/minio/minio is no longer pullable anonymously; quay.io is the working registry."
  ffmpeg:
    image_base: "node:25.6.0-slim (Debian 12.13 bookworm)"
    resolved_version: "7:5.1.9-0+deb12u1"
    verified_at: "2026-09-21T05:18:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T04:46:00-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries and infrastructure images decided in this phase.

> **Note on provenance.** The project's `CLAUDE.md` mandates Context7 (MCP) for library
> documentation lookup. The repository's `.mcp.json` registers only the `postgres` MCP
> server, and no Context7 server is available in this environment, so documentation was
> pulled from each library's **official documentation site** instead and every version was
> **verified empirically** against the actual registry/image (`npm view`, `docker run
> <image> --version`, `apt-cache policy`). The resolved versions recorded in the
> frontmatter are observed values, not assumptions. Re-fetch when the underlying TD changes.

---

## @nestjs/bullmq

**Source:** <https://docs.nestjs.com/techniques/queues> — official NestJS documentation. Maps to `phase-03-videos/TD-01` Decision A and `TD-05` Decision A.

**Peer compatibility (verified via `npm view @nestjs/bullmq@12.0.0 peerDependencies`):**

```
bullmq:          ^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0
@nestjs/core:    ^10.0.0 || ^11.0.0 || ^12.0.0
@nestjs/common:  ^10.0.0 || ^11.0.0 || ^12.0.0
```

The project runs NestJS 11 and will install `bullmq@^6`, so both peers are satisfied.

### Root registration (async, with the project's `registerAs` config pattern)

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
});
```

Options accepted by `forRoot`/`forRootAsync`: `connection` (ioredis `ConnectionOptions`),
`prefix`, `defaultJobOptions`, `settings`.

### Queue registration and injection

```typescript
BullModule.registerQueue({ name: 'video-processing' });

@Injectable()
export class VideosService {
  constructor(
    @InjectQueue('video-processing') private readonly queue: Queue,
  ) {}
}
```

### Producing a job with the retry policy from TD-08 and the idempotency key from TD-09

```typescript
await this.queue.add(
  'process-video',
  { videoId },                       // TD-09: thin payload
  {
    jobId: videoId,                  // TD-09: dedupes double enqueue
    attempts: 3,                     // TD-08: bounded retry
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,             // keep the failed job for inspection
  },
);
```

### Consuming — `@Processor` + `WorkerHost`

`WorkerHost` is an abstract class; the consumer extends it and implements `process`.
Being a normal Nest provider, it takes constructor injection (repositories, config,
storage service) — the property TD-05 relies on.

```typescript
@Processor('video-processing')
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // ...
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    // job.attemptsMade tells "retrying" apart from "exhausted" (TD-08)
  }
}
```

`@OnWorkerEvent` accepts `'active' | 'completed' | 'failed' | 'progress' | 'stalled'`.

---

## bullmq

**Source:** <https://docs.bullmq.io/guide/connections> — official BullMQ guide. Maps to `phase-03-videos/TD-01`, `TD-08`, `TD-09`.

### Connection setting that matters for this phase

The guide is explicit that **workers** must be created with:

```typescript
connection: { host, port, maxRetriesPerRequest: null }
```

> "maxRetriesPerRequest: null" — because a worker "is expected to happen in the
> background", it can retry indefinitely until Redis is restored.

It contrasts this with producer-side `Queue` instances used from an HTTP request path,
where a **low** `maxRetriesPerRequest` (default 20, or even 1) is preferred so the user
gets a fast error instead of a hanging request.

**Consequence for the implementation:** the API and the worker must not share one
connection configuration. The API's queue connection keeps the default retry budget;
the worker's connection sets `maxRetriesPerRequest: null`. This is wired in
`queue.config.ts` as two distinct option builders.

### Redis

Pinned to `redis:8-alpine`, resolved to **Redis 8.10.1** (verified with
`docker run --rm redis:8-alpine redis-server --version`). This is far above any version
BullMQ 6 requires and supports every command BullMQ's Lua scripts use.

### Delivery semantics

BullMQ is **at-least-once**. A job can be delivered more than once — on retry
(`attempts`), and on stall recovery when a worker dies mid-job. TD-09's idempotency
measures (`jobId`, status early-return, deterministic thumbnail key) exist precisely
for this.

---

## @aws-sdk/client-s3

**Source:** <https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html> — official S3 multipart upload documentation. Maps to `phase-03-videos/TD-02`, `TD-03`, `TD-10`, `TD-11`.

### Multipart limits (quoted from the official documentation)

- Part numbers: "You can choose any part number between **1 and 10,000**."
- "It's a best practice to use multipart upload for objects that are **100 MB or larger**."
- "After you initiate a multipart upload, there is **no expiry**; you must explicitly complete or stop the multipart upload."
- "To minimize your storage costs, we recommend that you configure a lifecycle rule to delete incomplete multipart uploads … by using the `AbortIncompleteMultipartUpload` action."

**Consequence for TD-02/TD-11:** with 64MiB parts, a 10GiB object needs 160 parts —
well inside the 10,000 limit. The part count is validated at initiation so an oversized
declaration fails with a clear `400` rather than at completion.

**Consequence for TD-03:** because incomplete multipart uploads never expire on their own
and are billed, the videos bucket gets an `AbortIncompleteMultipartUpload` lifecycle rule.

### ⚠️ Checksum defaults break pre-signed URLs against MinIO

Since **v3.729** the SDK enables request checksums by default
(`requestChecksumCalculation: "WHEN_SUPPORTED"`), attaching
`x-amz-sdk-checksum-algorithm: CRC32` and an `x-amz-trailer` header. For a **pre-signed**
request this is fatal in two ways: the checksum of an empty body gets baked into the
signature, and S3-compatible stores such as MinIO reject or mis-handle the headers —
surfacing as `SignatureDoesNotMatch` when the client uploads the real bytes.

Both S3 clients in this phase must therefore be constructed with:

```typescript
new S3Client({
  region,
  endpoint,                                   // TD-10: internal or public
  forcePathStyle: true,                       // required by MinIO
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

References: [minio/minio#19067 — `getPresignedUrl` fails with `SignatureDoesNotMatch`](https://github.com/minio/minio/issues/19067), [minio/minio#20845 — Support AWS S3 new checksums](https://github.com/minio/minio/issues/20845).

### Commands used in this phase

| Command | Where | Purpose |
|---------|-------|---------|
| `CreateBucketCommand` / `HeadBucketCommand` | API bootstrap | Idempotent bucket provisioning (TD-03) |
| `PutBucketLifecycleConfigurationCommand` | API bootstrap | `AbortIncompleteMultipartUpload` rule on the videos bucket |
| `CreateMultipartUploadCommand` | Upload initiation | Returns `UploadId` (TD-02) |
| `UploadPartCommand` | Part signing | Pre-signed, never executed server-side (TD-02) |
| `CompleteMultipartUploadCommand` | Upload completion | Takes `{ Parts: [{ PartNumber, ETag }] }` (TD-02) |
| `AbortMultipartUploadCommand` | Failure paths | Frees part storage on size mismatch (TD-11) |
| `HeadObjectCommand` | Upload completion | Reads real `ContentLength` (TD-11) |
| `GetObjectCommand` | Streaming, worker probe, download | `Range` for `206`; pre-signed for worker/download (TD-06, TD-07) |
| `PutObjectCommand` | Worker | Writes the generated thumbnail (TD-12) |

### Range reads for streaming (TD-07)

`GetObjectCommand` accepts a `Range: 'bytes=start-end'` string and the response carries
`ContentLength`, `ContentRange` and `Body` as a `Readable`. The stream is piped to the
Express response, so backpressure is preserved and the API never buffers a whole part.

---

## @aws-sdk/s3-request-presigner

**Source:** <https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/> — official package reference. Maps to `phase-03-videos/TD-02`, `TD-06`, `TD-07`, `TD-10`, `TD-14`.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(client, command, { expiresIn: seconds });
```

- `expiresIn` is in **seconds**, and SigV4 caps it at **604800** (7 days). All three TTLs
  from TD-14 are inside that: parts `21600` (6h), worker probe `3600` (1h), download
  `900` (15min).
- The signature binds the endpoint host, which is why TD-10 requires signing with the
  client whose `endpoint` matches what the consumer resolves.
- `ResponseContentDisposition` on a `GetObjectCommand` is honoured in the pre-signed URL,
  which is how the download redirect forces `attachment` without proxying bytes.

---

## FFmpeg / ffprobe (system binaries)

**Source:** Debian package index of the project's Node base image. Maps to `phase-03-videos/TD-05`, `TD-06`, `TD-12`.

Verified with `docker run --rm node:25.6.0-slim sh -c 'apt-get update && apt-cache policy ffmpeg'`:

```
base image:   node:25.6.0-slim  →  Debian 12.13 (bookworm)
ffmpeg:       candidate 7:5.1.9-0+deb12u1
```

Installed **only in `Dockerfile.worker`** — the API image must not carry the layer (TD-05).
The `ffmpeg` Debian package provides both `ffmpeg` and `ffprobe`.

### Metadata extraction (TD-06)

```
ffprobe -v quiet -print_format json -show_format -show_streams <url>
```

Relevant JSON fields: `format.duration` (seconds, string), `format.format_name`,
`format.size`, `format.bit_rate`, and for the first `codec_type: "video"` stream:
`width`, `height`, `codec_name`, `avg_frame_rate`.

### Thumbnail extraction (TD-12)

```
ffmpeg -ss <offset> -i <url> -frames:v 1 -vf scale=1280:-2 -q:v 3 -f image2 <out.jpg>
```

`-ss` **before** `-i` makes FFmpeg seek by keyframe before decoding instead of decoding
forward from the start — on a multi-GB source this is the difference between a sub-second
operation and minutes. `scale=1280:-2` keeps the aspect ratio and forces an even height,
which the JPEG encoder requires.

### Reading from storage over HTTP (TD-06)

FFmpeg 5.1's HTTP protocol issues Range requests, so passing a pre-signed GET URL as the
input makes it fetch only the container header and the frames around the seek offset.
For MP4s without `faststart` the `moov` atom is at the end of the file, costing one extra
range read of the tail — still kilobytes, not the whole object.

Both invocations run through `child_process.execFile` with an **argument array**, so no
shell is spawned and no URL can be interpreted as shell syntax.

---

## Infrastructure images

| Service | Image | Resolved version | Notes |
|---------|-------|------------------|-------|
| Object storage | `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` | `RELEASE.2025-09-07T16-13-09Z` | `docker.io/minio/minio` is **no longer pullable anonymously** — verified: `pull access denied … repository does not exist`. `quay.io` is the registry that works. Ports `9000` (S3 API) and `9001` (console). |
| Queue | `redis:8-alpine` | `8.10.1` | Port `6379`. `--appendonly yes` so queued jobs survive a container restart. |
| Video worker base | `node:25.6.0-slim` + `ffmpeg` | Debian 12.13, ffmpeg 5.1.9 | Same Node base as the API image so the compiled output is identical. |
