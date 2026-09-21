---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-20T22:07:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T04:46:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-09-21T04:48:00-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-09-21T05:02:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-21T05:20:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file video ingestion end to end: a video is pre-registered as a draft the
moment an upload starts, its bytes travel directly from the client to object storage as a
resumable multipart upload of up to 10GB without passing through the API, a background
worker then extracts duration and metadata and cuts a thumbnail, and the finished video
becomes reachable through a short unique URL that supports both range-based streaming and
download — establishing the storage, queue, and worker infrastructure that Fases 04–07
build on.

---

## Step Implementations

### SI-03.1 — Baseline Repairs (inherited test defects)

**Description:** The inherited suite is red before any Phase 03 code exists, for two
reasons that Phase 03 would otherwise inherit and amplify. Fix both first so every later
SI runs against a trustworthy baseline. Recorded as `DG-02` and `DG-04` in `validation.md`.

**Technical actions:**

- `src/database/migrations.integration-spec.ts` — extend the `beforeAll` cleanup to drop
  PostgreSQL **enum types** in addition to tables. The spec currently drops the four
  managed tables but leaves `verification_tokens_type_enum` behind; an earlier suite
  running with `synchronize: true` creates that type, so the migration's `CREATE TYPE`
  fails with `type "verification_tokens_type_enum" already exists`. Introduce a
  `MANAGED_ENUMS` list alongside `MANAGED_TABLES` and `DROP TYPE IF EXISTS ... CASCADE`
  for each.
- `package.json` — add `--runInBand` to the `test:e2e` script. `nestjs-project/CLAUDE.md`
  already documents the script as "already configured" with the flag, but the script is a
  plain `jest --config`; the three e2e suites share one database and corrupt each other in
  parallel.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/database/migrations.integration-spec.ts` | Integration | Existing two tests now pass inside a **full** `npm test -- --runInBand` run, not only in isolation |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose exec nestjs-api npm test -- --runInBand` reports 0 failures (was 1 failure / 5 in the unrepaired baseline)
- `docker compose exec nestjs-api npm run test:e2e` passes without manually adding `--runInBand` (was 47 failures of 52)
- Running `npm test -- --runInBand` twice in a row is green both times — the suite is idempotent against a already-migrated database

---

### SI-03.2 — Dependencies, Config Namespaces, and Docker Compose Infrastructure

**Description:** Install the Phase 03 dependencies, add the `storage`, `queue` and `video`
config namespaces following the Fase 01 `registerAs` pattern, extend the Joi schema, and
bring up the three new infrastructure pieces — MinIO, Redis and the video worker — in
Docker Compose. Resolves `DG-05`.

**Technical actions:**

- Install production dependencies: `@nestjs/bullmq@^12`, `bullmq@^6`,
  `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3` (versions and peer
  compatibility confirmed in `library-refs.md`)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading
  `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default
  `http://localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY`,
  `S3_SECRET_KEY`, `S3_VIDEOS_BUCKET` (default `streamtube-videos`),
  `S3_THUMBNAILS_BUCKET` (default `streamtube-thumbnails`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST`
  (default `redis`) and `REDIS_PORT` (default `6379`), exposing **two** connection
  builders: the producer connection (default retry budget) and the worker connection with
  `maxRetriesPerRequest: null`, as the BullMQ guide requires (`library-refs.md`)
- Create `src/config/video.config.ts` — `registerAs('video', ...)` holding the constants
  from TD-02, TD-11 and TD-14: `partSizeBytes` (64MiB), `maxSizeBytes` (10GiB),
  `maxParts` (10000), `allowedContentTypes`, `uploadUrlTtl` (21600), `probeUrlTtl` (3600),
  `downloadUrlTtl` (900), `thumbnailPercent` (0.1)
- Extend `src/config/env.validation.ts` with every new variable (`S3_ACCESS_KEY` and
  `S3_SECRET_KEY` required, the rest with defaults) and mirror them in `.env.example`
- Add to `nestjs-project/compose.yaml`:
  - `minio` — `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`, command
    `server /data --console-address ":9001"`, ports `9000`/`9001`, named volume for
    `/data`, healthcheck on `/minio/health/live`
  - `redis` — `redis:8-alpine` with `--appendonly yes`, port `6379`, named volume,
    healthcheck `redis-cli ping`
  - `video-worker` — built from `Dockerfile.worker`, same bind mount as the API,
    `depends_on` db/redis/minio (healthy), command running the worker entrypoint
  - `nestjs-api` gains `depends_on` on `minio` and `redis` (healthy)
- Create `nestjs-project/Dockerfile.worker` — `FROM node:25.6.0-slim`, `apt-get install -y
  ffmpeg` (Debian 12 candidate `7:5.1.9-0+deb12u1`), same `WORKDIR` and `USER node` as
  `Dockerfile.dev`. FFmpeg is installed **only** here, never in the API image (TD-05)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Integration | New variables validated; missing `S3_ACCESS_KEY`/`S3_SECRET_KEY` aborts bootstrap |
| `src/config/storage.config.spec.ts` | Unit | Defaults and overrides for every storage key |
| `src/config/queue.config.spec.ts` | Unit | Producer connection keeps the default retry budget; worker connection sets `maxRetriesPerRequest: null` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose ps` shows `minio`, `redis` and `video-worker` running alongside `db`, `mailpit` and `nestjs-api`
- `docker compose exec video-worker ffprobe -version` and `ffmpeg -version` both succeed; the same commands **fail** in `nestjs-api`
- MinIO console answers on `localhost:9001` and the S3 API on `localhost:9000`
- `docker compose exec redis redis-cli ping` returns `PONG`
- Starting the API without `S3_ACCESS_KEY` fails at bootstrap with a Joi validation error

---

### SI-03.3 — Storage Module (S3 clients, bucket bootstrap, pre-signing)

**Description:** Encapsulate every object-storage interaction behind a single
`StorageService` so no other module talks to the AWS SDK directly. This is where TD-10's
endpoint duality and TD-14's lifetimes live. Resolves `MD-01` and part of `MD-05`.

**Technical actions:**

- Create `src/storage/storage.module.ts` providing two `S3Client` instances under distinct
  tokens (`S3_INTERNAL_CLIENT`, `S3_PUBLIC_CLIENT`), both built with
  `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` and
  `responseChecksumValidation: 'WHEN_REQUIRED'` — the last two are mandatory for
  pre-signed URLs against MinIO (`library-refs.md`). Export `StorageService`
- Create `src/storage/storage.constants.ts` with the injection tokens (`as const`)
- Create `src/storage/storage.service.ts` exposing:
  - `ensureBuckets()` — idempotent `HeadBucket`/`CreateBucket` for both buckets plus the
    `AbortIncompleteMultipartUpload` lifecycle rule on the videos bucket (TD-03)
  - `createMultipartUpload(key, contentType)` → `uploadId`
  - `signUploadPart(key, uploadId, partNumber)` → URL signed with the **public** client, TTL `uploadUrlTtl`
  - `listParts(key, uploadId)` → parts already stored, for resume
  - `completeMultipartUpload(key, uploadId, parts)`
  - `abortMultipartUpload(key, uploadId)`
  - `headObject(key)` → `{ contentLength, contentType }`
  - `getObjectRange(key, range?)` → `{ stream, contentLength, contentRange, contentType }` using the **internal** client
  - `signGetObject(key, ttl, options?)` — `options.responseContentDisposition` for the download redirect (public client); a separate `signInternalGetObject` for the worker's probe URL (internal client, TTL `probeUrlTtl`)
  - `putObject(key, body, contentType)` — used by the worker for the thumbnail
- Call `ensureBuckets()` on module init (`OnModuleInit`) so the Compose stack is
  self-provisioning and no manual MinIO console step is needed
- Create `src/storage/storage.keys.ts` — pure helpers building
  `videos/{channelId}/{videoId}/source{ext}` and `thumbnails/{channelId}/{videoId}/thumb.jpg` (TD-03)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.keys.spec.ts` | Unit | Key shape, extension handling, no path traversal from the original filename |
| `src/storage/storage.service.integration-spec.ts` | Integration | Against **real MinIO**: buckets created idempotently (twice is a no-op), full multipart round-trip (create → sign → PUT the part via the signed URL → complete → head), `listParts` reports uploaded parts, `abortMultipartUpload` frees them, range `GET` returns the exact byte slice, pre-signed GET URL is fetchable and honours `ResponseContentDisposition` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Both buckets exist after the app starts, and a second start does not error
- A part uploaded through a pre-signed URL with a plain HTTP `PUT` (no AWS SDK on the client side) succeeds — proving the signature works without SDK-injected checksum headers
- `getObjectRange(key, 'bytes=10-19')` returns exactly 10 bytes and a `contentRange` of `bytes 10-19/<total>`
- Signed part URLs carry the **public** endpoint host; the worker probe URL carries the **internal** one

---

### SI-03.4 — Video Entity, Migration, and Unique Public Identifier

**Description:** Create the `Video` entity tied to `Channel`, its migration, and the
`public_id` generator with the URL derivation from TD-15. Resolves `AMB-01` and `DG-03`.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns in
  the Data Model below. `status` is a PostgreSQL enum (`videos_status_enum`) defaulting to
  `draft`; `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`, and the
  matching `@OneToMany` added on `Channel`
- Create `src/videos/video-public-id.util.ts` — `generatePublicId()` returning
  `crypto.randomBytes(8).toString('base64url')` (11 URL-safe chars, TD-04)
- Create `src/videos/video-urls.util.ts` — builds `url`, `stream_url`, `download_url` and
  `thumbnail_url` from `APP_URL` and `public_id` (TD-15)
- Create `src/videos/videos.module.ts` with `TypeOrmModule.forFeature([Video])` — required
  or the entity is silently absent from migrations (`.claude/rules/nestjs-modules.md`)
- Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos`
  and review the SQL for the enum type, the FK, and the indexes
- Register the new migration class and the `videos` table/enum in
  `src/database/migrations.integration-spec.ts` (`MANAGED_TABLES`, `MANAGED_ENUMS`, migration array)
- Add `videos` to `cleanAllTables()` in `src/test/create-test-data-source.ts`, **before**
  `channels`, or every e2e suite fails on the foreign key

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-public-id.util.spec.ts` | Unit | 11 characters, URL-safe alphabet only, no collision across a large sample |
| `src/videos/video-urls.util.spec.ts` | Unit | All four URLs derived from `APP_URL` + `public_id`, no double slashes |
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `public_id`, FK to channel enforced, `status` defaults to `draft`, nullable columns accept null, `size_bytes` round-trips a value above 2³¹ |
| `src/database/migrations.integration-spec.ts` | Integration | Three migrations apply and revert, creating and dropping `videos` and its enum |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `forFeature` wiring |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table, the `videos_status_enum` type, the unique index on `public_id` and the FK to `channels`
- Inserting two videos with the same `public_id` raises a unique violation
- Deleting a channel that still has videos is refused by the FK
- A video stored with `size_bytes = 10737418240` reads back exactly (TypeORM maps `bigint` to `string` — the entity and every consumer must treat it as such)

---

### SI-03.5 — Upload Initiation (pre-registration as draft)

**Description:** `POST /videos` — the "pré-cadastro automático do vídeo como rascunho ao
iniciar o upload". Validates the declared constraints, creates the draft row, opens the
S3 multipart upload, and returns the upload plan. Resolves `MD-02` (initiation half) and
`MD-04` (write side).

**Technical actions:**

- Create `src/videos/dto/initiate-upload.dto.ts` — `title` (string, 1–255), `filename`
  (string, 1–255), `content_type` (`@IsIn` over the allowlist), `size_bytes`
  (`@Type(() => Number)`, `@IsInt`, `@Min(1)`, `@Max(10737418240)`). Only
  `class-validator` decorators plus JSDoc — the Swagger plugin derives the schema
- Create `src/videos/videos.service.ts` with `initiateUpload(userId, dto)`:
  resolve the caller's channel (`ChannelNotFoundException` if absent), derive
  `partCount = ceil(size_bytes / partSizeBytes)` and reject above `maxParts`
  (`PartCountExceededException`), generate `public_id` with a bounded retry on unique
  violation, build the storage key, `createMultipartUpload`, and persist the row with
  `status: 'draft'` and the returned `upload_id` — inside a `dataSource.transaction` so a
  failure to persist does not leave an orphan multipart upload (the catch aborts it)
- Create `src/videos/videos.controller.ts` with `POST /videos` (authenticated; no
  `@Public()`), `@CurrentUser()` for the caller
- Create `src/videos/dto/video-response.dto.ts` — response DTO with explicit
  `@ApiProperty` on every field (response DTOs have no validators for the plugin to read)
- Add the new domain exceptions to `src/common/exceptions/domain.exception.ts`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Part-count arithmetic, allowlist rejection, `public_id` retry on collision, multipart aborted when the row fails to persist |
| `src/videos/videos.service.integration-spec.ts` | Integration | Draft row persisted with real DB + real MinIO multipart opened; rollback path leaves no orphan upload (`listMultipartUploads` empty) |
| `test/videos.e2e-spec.ts` | E2E | 201 with the video payload and upload plan; 401 without a token; 400 on oversized `size_bytes`, unknown `content_type`, missing `title` |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` with a valid body returns 201, a video in `draft` status, a `public_id`, and `upload.part_size` / `upload.part_count` / `upload.upload_id`
- `size_bytes` of 10737418241 (one byte over 10GiB) returns 400
- A `content_type` outside the allowlist returns 400
- An unauthenticated request returns 401
- The created row's `channel_id` is the caller's channel — never a channel supplied by the client

---

### SI-03.6 — Part Signing and Resume

**Description:** `POST /videos/:public_id/upload/parts` returns fresh pre-signed URLs for
the requested part numbers, and `GET /videos/:public_id/upload` reports which parts are
already stored so an interrupted client resumes instead of restarting. Resolves the
re-signing half of `MD-05`.

**Technical actions:**

- Create `src/videos/dto/sign-parts.dto.ts` — `part_numbers: number[]`
  (`@ArrayNotEmpty`, `@ArrayMaxSize(1000)`, each `@IsInt` `@Min(1)` `@Max(10000)`)
- `VideosService.signUploadParts(userId, publicId, dto)` — load the video scoped to the
  caller's channel (`VideoNotOwnedException`), require `status === 'draft'` and a non-null
  `upload_id` (`InvalidUploadStateException`), reject part numbers above the stored
  `part_count`, and return one signed URL per requested part with `expires_in`
- `VideosService.getUploadStatus(userId, publicId)` — `listParts` mapped to
  `{ part_number, size, etag }`, so a resuming client can skip completed parts
- Controller endpoints, both authenticated and owner-scoped

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Ownership rejection, state rejection, out-of-range part numbers |
| `src/videos/videos.service.integration-spec.ts` | Integration | Signed URLs against real MinIO accept a real `PUT`; `listParts` reflects exactly what was uploaded |
| `test/videos.e2e-spec.ts` | E2E | 200 with one URL per requested part; 403 for a non-owner; 409 once the upload is completed |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- Requesting URLs for parts 1..3 returns three distinct URLs whose `expires_in` is 21600
- Uploading a part with a plain `PUT` to the returned URL succeeds and its ETag appears in `GET /videos/:public_id/upload`
- Another user's video returns 403; a completed upload returns 409
- Requesting the same part number twice returns a usable URL both times (re-signing works)

---

### SI-03.7 — Upload Completion and Size Verification

**Description:** `POST /videos/:public_id/upload/complete` assembles the object, verifies
its real size against the declared one, flips the video to `processing`, and enqueues the
job. This is the enforcement point of TD-11 and completes `MD-02`.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `parts: { part_number, etag }[]`
  (`@ValidateNested({ each: true })`, `@Type(() => CompletedPartDto)`, non-empty)
- `VideosService.completeUpload(userId, publicId, dto)`:
  1. load owner-scoped, require `draft` + `upload_id`
  2. `completeMultipartUpload` with the parts sorted ascending by `part_number`
  3. `headObject` — if `contentLength !== size_bytes`, delete the object, set the video to
     `failed` with `processing_error`, and throw `UploadSizeMismatchException` (422)
  4. otherwise set `status: 'processing'`, clear `upload_id`, save
  5. enqueue the job (SI-03.8) **after** the transaction commits, so a rolled-back
     completion never leaves a job pointing at a non-`processing` video
- Add `DELETE /videos/:public_id/upload` — aborts the multipart upload and deletes the
  draft row, the clean way to cancel

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Parts sorted before completion; mismatch path aborts, marks `failed`, and does **not** enqueue |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real multipart completed against MinIO; status becomes `processing` and `upload_id` is cleared; a deliberately under-sized upload produces 422 and no queued job |
| `test/videos.e2e-spec.ts` | E2E | Full upload cycle returns 200 with `status: "processing"`; 409 when completing twice |

**Dependencies:** SI-03.6, SI-03.8

**Acceptance criteria:**

- Completing with correct parts returns the video in `processing` status with `upload_id` null
- Declaring 10MB and uploading 5MB returns 422 `UPLOAD_SIZE_MISMATCH`, the stored object is deleted, and the video is `failed`
- Completing an already-completed upload returns 409
- Exactly one job is queued per successful completion

---

### SI-03.8 — Queue Module, Job Production, and Worker Bootstrap

**Description:** Wire BullMQ on both sides: the API produces jobs, and a separate worker
process consumes them. Implements TD-01, TD-05 and TD-09.

**Technical actions:**

- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` with the producer
  connection from `queue.config.ts`, and `BullModule.registerQueue({ name: 'video-processing' })`; export `BullModule`
- Create `src/queue/queue.constants.ts` — `VIDEO_QUEUE = 'video-processing'`,
  `PROCESS_VIDEO_JOB = 'process-video'` (`as const`)
- Create `src/videos/video-queue.service.ts` — `@InjectQueue(VIDEO_QUEUE)`, exposing
  `enqueueProcessing(videoId)` with `jobId: videoId`, `attempts: 3`,
  `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: true`,
  `removeOnFail: false` (TD-08, TD-09)
- Create `src/worker/worker.module.ts` — imports `ConfigModule`, `TypeOrmModule`
  (same `forRootAsync` as `AppModule`), `StorageModule`, `VideosModule` and the BullMQ
  registration using the **worker** connection (`maxRetriesPerRequest: null`)
- Create `src/main.worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, with
  `enableShutdownHooks()` so a `SIGTERM` lets in-flight jobs finish
- Add `worker:dev` and `worker:prod` scripts to `package.json` and point the
  `video-worker` Compose service at `worker:dev`
- Register `VideosModule` and `QueueModule` in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-queue.service.spec.ts` | Unit | Job name, payload shape, and every option from TD-08/TD-09 passed to `queue.add` |
| `src/queue/queue.integration-spec.ts` | Integration | Against **real Redis**: a job added to the queue is retrievable by `jobId`; adding the same `jobId` twice while waiting yields one job |
| `src/worker/worker.module.spec.ts` | Unit | Worker module compiles with its full dependency graph |

**Dependencies:** SI-03.2, SI-03.4

**Acceptance criteria:**

- `docker compose logs video-worker` shows the worker started and connected to Redis
- Enqueuing the same `videoId` twice produces exactly one waiting job
- Stopping the worker container and restarting it leaves queued jobs intact (Redis `appendonly`)
- The worker process exposes no HTTP port

---

### SI-03.9 — Video Processing Consumer (metadata, thumbnail, status)

**Description:** The consumer that turns a `processing` video into a `ready` one:
`ffprobe` for duration and metadata, `ffmpeg` for the thumbnail, both reading the source
through a pre-signed URL. Implements TD-06, TD-08, TD-09 and TD-12; resolves `MD-03`.

**Technical actions:**

- Create `src/worker/ffmpeg.service.ts`:
  - `probe(url)` — `execFile('ffprobe', ['-v','quiet','-print_format','json','-show_format','-show_streams', url])`, parsed into a typed `VideoMetadata` (`durationSeconds`, `width`, `height`, `codec`, `bitrate`, `formatName`)
  - `extractThumbnail(url, offsetSeconds)` — `execFile('ffmpeg', ['-ss', offset, '-i', url, '-frames:v','1','-vf','scale=1280:-2','-q:v','3','-f','image2', tmpPath])`, returning the JPEG buffer
  - both with an explicit timeout that kills the child process
- Create `src/worker/thumbnail-offset.util.ts` — `computeOffset(duration)` implementing
  TD-12's clamp: `duration < 1 ? 0 : max(1, min(0.1 * duration, duration - 0.1))`
- Create `src/worker/video-processing.consumer.ts` — `@Processor(VIDEO_QUEUE)` extending
  `WorkerHost`:
  1. re-read the video by id; return immediately if missing or already `ready` (TD-09)
  2. sign an internal GET URL (TTL `probeUrlTtl`)
  3. `probe` → duration + metadata
  4. `computeOffset` → `extractThumbnail` → `putObject` at the deterministic thumbnail key
  5. save `duration_seconds`, `metadata`, `thumbnail_key`, `status: 'ready'`, clear `processing_error`
  - `@OnWorkerEvent('failed')` — when `job.attemptsMade` has reached `attempts`, set
    `status: 'failed'` and persist the reason; the source object is **kept** so the video
    can be reprocessed without re-uploading (TD-08)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/thumbnail-offset.util.spec.ts` | Unit | 10% rule; clamped to ≥1s; never beyond `duration − 0.1`; 0 for sub-second videos |
| `src/worker/ffmpeg.service.spec.ts` | Unit | Exact argument arrays (`-ss` **before** `-i`); `ffprobe` JSON mapped to `VideoMetadata`; non-zero exit surfaces as an error |
| `src/worker/ffmpeg.service.integration-spec.ts` | Integration | **Real `ffprobe`/`ffmpeg`** against a small generated fixture: duration within tolerance, real JPEG bytes produced with width 1280 |
| `src/worker/video-processing.consumer.integration-spec.ts` | Integration | Real Redis + MinIO + DB: a `processing` video becomes `ready` with duration, metadata and a thumbnail object present; re-running the same job is a no-op; a corrupt source ends as `failed` with a reason and the source object still present |

**Dependencies:** SI-03.8, SI-03.3

**Acceptance criteria:**

- After completing a real upload, the video reaches `ready` without any manual step
- `duration_seconds` matches the fixture's real duration within 0.1s
- A thumbnail object exists at `thumbnails/{channel_id}/{video_id}/thumb.jpg` and is a valid JPEG 1280px wide
- Processing the same job twice leaves exactly one thumbnail and does not change `ready`
- A deliberately corrupt file ends in `failed` with `processing_error` populated, after 3 attempts, with the source object retained

---

### SI-03.10 — Video Metadata and Range Streaming

**Description:** `GET /videos/:public_id` and `GET /videos/:public_id/stream` — the
anonymous read surface. Implements TD-07's proxy half, TD-13 and TD-15; resolves `DG-01`.

**Technical actions:**

- Create `src/videos/range.util.ts` — parse `Range: bytes=start-end`, supporting
  open-ended (`bytes=500-`) and suffix (`bytes=-500`) forms, clamping to the object size
  and returning `null` for an unsatisfiable range
- `VideosService.findPublic(publicId, currentUserId?)` — returns the video when `ready`,
  or when the caller is the owner (any status); otherwise `VideoNotFoundException` (404,
  not 403 — a non-ready video must not be distinguishable from a missing one)
- `GET /videos/:public_id` — `@Public()`, returns the response DTO with the four derived
  URLs (TD-15)
- `GET /videos/:public_id/stream` — `@Public()` **and `@SkipThrottle()`** (DG-01):
  require `ready` (`VideoNotReadyException`), `headObject` for the size, parse the range;
  with a range reply `206` with `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`
  and the piped stream; without one reply `200` with the full body and `Accept-Ranges`;
  on an unsatisfiable range reply `416` with `Content-Range: bytes */<size>`
- `GET /videos/:public_id/thumbnail` — `@Public()`, pipes the thumbnail object (404 when
  the video has none yet)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/range.util.spec.ts` | Unit | All three range forms, clamping, unsatisfiable detection, malformed headers |
| `test/videos.e2e-spec.ts` | E2E | 206 with a correct `Content-Range` and exactly the requested bytes; 200 + `Accept-Ranges` without a range; 416 on an out-of-bounds range; 404 for a draft video requested anonymously; 200 for the owner on the same draft; many consecutive range requests never return 429 |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `GET /videos/:id/stream` with `Range: bytes=0-1023` returns 206, `Content-Length: 1024` and `Content-Range: bytes 0-1023/<size>`
- The bytes returned for a range equal the same slice of the original file
- No `Range` header returns 200 with `Accept-Ranges: bytes`
- 30 consecutive range requests from one IP all succeed — the throttler does not fire
- A `draft` or `failed` video returns 404 anonymously, and 200 for its owner via the metadata endpoint

---

### SI-03.11 — Download via Redirect

**Description:** `GET /videos/:public_id/download` — the one genuinely large transfer,
handed off to storage so it never touches the API. Implements TD-07's redirect half and
TD-14's download TTL.

**Technical actions:**

- `VideosService.buildDownloadUrl(publicId, currentUserId?)` — same visibility gate as
  streaming, then `signGetObject` on the **public** client with TTL `downloadUrlTtl` and
  `ResponseContentDisposition: attachment; filename="<original_filename>"`
- `GET /videos/:public_id/download` — `@Public()`, replies `302` with the `Location`
  header; the controller must not pipe any bytes

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Disposition header built from `original_filename`, quotes escaped |
| `src/videos/videos.service.integration-spec.ts` | Integration | The signed URL is fetchable against real MinIO and returns the full object with `Content-Disposition: attachment` |
| `test/videos.e2e-spec.ts` | E2E | 302 with a `Location` pointing at the public endpoint; 404 for a non-ready video; the response body is empty |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- `GET /videos/:id/download` returns 302 and a `Location` containing `X-Amz-Signature` and the public endpoint host
- Following the `Location` downloads the complete file with `Content-Disposition: attachment`
- The API transfers no video bytes on this endpoint

---

### SI-03.12 — Full-Cycle E2E Hardening

**Description:** One end-to-end test that exercises the entire phase as a user would —
register → initiate → upload parts through pre-signed URLs → complete → wait for the
worker → stream → download — with no mocks anywhere in the path. This is the test that
proves the deliverables rather than asserting them.

**Technical actions:**

- Add `test/videos-full-cycle.e2e-spec.ts` driving the real stack: a generated fixture
  video, real MinIO, real Redis, the real consumer (instantiated in the test's Nest
  context so no separate container is needed for the assertion), real `ffmpeg`
- Add `src/test/video-fixture.ts` — generates a deterministic test video with
  `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=10`, cached under the OS temp
  directory so the suite does not regenerate it per test
- Poll the video status with a bounded timeout instead of a fixed sleep

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos-full-cycle.e2e-spec.ts` | E2E | draft → processing → ready transitions observed in the database; thumbnail present; streamed bytes match the uploaded file; download redirect resolves to the complete object |

**Dependencies:** SI-03.11

**Acceptance criteria:**

- The full cycle completes with zero mocked collaborators
- The status column is observed passing through `draft`, `processing`, and `ready` in that order
- The concatenation of ranged stream responses reproduces the uploaded file byte for byte

---

### SI-03.13 — OpenAPI Regeneration and AI Documentation Update

**Description:** Bring the repository's published contract and its AI documentation back
in line with the code. Resolves `INC-02` and satisfies the phase's documentation
requirement.

**Technical actions:**

- Run `npm run openapi:export` and commit the regenerated `nestjs-project/openapi.json`
- Run `scripts/sync-openapi.sh` to mirror it into `next-frontend/openapi.json`
- Update the root `CLAUDE.md`: replace the architecture placeholders with the real
  containers (`Message Queue (TBD)` → Redis + BullMQ), and add the video module, its
  endpoints, the worker and the storage layout
- Update `nestjs-project/CLAUDE.md`: the new Compose services and their verification
  commands, the worker entrypoint and how to run it, the FFmpeg dependency, and the
  storage/queue environment variables
- Update `docs/diagrams/software-arch.mermaid` — the queue container is no longer `TBD`

**Tests:** no automated tests — verified by `src/openapi-export.integration-spec.ts`
continuing to pass and by reviewing that every documented path exists in the code.

**Dependencies:** SI-03.12

**Acceptance criteria:**

- `openapi.json` contains every `/videos` path with summaries and the `access-token` security requirement on the authenticated ones
- `next-frontend/openapi.json` is byte-identical to the backend's
- No file or behaviour named in either `CLAUDE.md` is absent from the code
- `software-arch.mermaid` names Redis/BullMQ instead of `TBD`

---

### SI-03.14 — Inherited Lint Debt

**Description:** `npm run lint` exits 1 with 150 errors inherited from Fases 01/02,
which blocks the Definition of Done. Fixed in a **separate commit** so pre-existing debt
never mixes with Phase 03 feature commits, per `CLAUDE.md` → "Scope Limits". Resolves
`INC-01`.

**Technical actions:**

- Type the supertest response bodies in the e2e and integration specs instead of reading
  `.body.x` off `any` (`no-unsafe-member-access`, `no-unsafe-assignment`,
  `no-unsafe-return`, `no-unsafe-argument`)
- Replace unbound method references passed to matchers with arrow wrappers or
  `jest.spyOn` handles (`unbound-method`)
- Drop `async` from functions that never await (`require-await`), remove unused bindings
  (`no-unused-vars`), and replace `Function` with a precise signature
  (`no-unsafe-function-type`) in `src/test/create-test-data-source.ts`
- Do **not** weaken the ESLint configuration — the rules stay as they are

**Tests:** no new tests — the full suite must stay green after the retyping.

**Dependencies:** None (independent of the feature chain; runs at closure)

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint` exits 0
- `docker compose exec nestjs-api npx tsc --noEmit` still exits 0
- The full unit + integration and e2e suites remain green
- `eslint.config.mjs` is unchanged

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; never exposed in URLs |
| public_id | varchar(11) | unique, not null | TD-04 — `crypto.randomBytes(8).toString('base64url')` |
| channel_id | uuid | FK → channels.id, not null | Owner; resolved from the authenticated user |
| title | varchar(255) | not null | Supplied at initiation |
| description | text | nullable | Reserved for Fase 04 |
| status | `videos_status_enum` | not null, default `'draft'` | `draft` \| `processing` \| `ready` \| `failed` (TD-08) |
| original_filename | varchar(255) | not null | Used for the download `Content-Disposition` |
| content_type | varchar(100) | not null | Validated against the allowlist (TD-11) |
| size_bytes | bigint | not null | Declared at initiation, verified at completion. **TypeORM maps `bigint` to `string`** |
| storage_key | varchar(512) | not null | `videos/{channel_id}/{video_id}/source{ext}` (TD-03) |
| thumbnail_key | varchar(512) | nullable | `thumbnails/{channel_id}/{video_id}/thumb.jpg`; set by the worker |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; cleared at completion |
| part_size_bytes | integer | not null | 64MiB; stored so re-signing stays consistent |
| part_count | integer | not null | `ceil(size_bytes / part_size_bytes)` |
| duration_seconds | numeric(10,3) | nullable | From `ffprobe` (TD-06) |
| metadata | jsonb | nullable | `{ width, height, codec, bitrate, formatName }` |
| processing_error | text | nullable | Reason recorded on `failed` (TD-08) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`); Channel → Video (one-to-many)
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK; `(channel_id, status)` — for Fase 04's channel panel

**Status transitions (TD-08):**

```
draft ──complete+verified──> processing ──worker ok───> ready
  │                              │
  │                              └──worker exhausted──> failed
  └──size mismatch / abort──> (row deleted or failed)
```

Every other transition is rejected with `INVALID_UPLOAD_STATE`.

---

### API Contracts

#### POST /videos (SI-03.5)

**Auth:** required (Bearer access token)

**Request body:**
- title: string, required — 1–255 chars
- filename: string, required — 1–255 chars
- content_type: string, required — one of `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`
- size_bytes: integer, required — 1 … 10737418240

**Response 201:**
- video: the Video representation (see below)
- upload: `{ upload_id: string, part_size: integer, part_count: integer }`

**Error responses:**
- 400 validation error — body fails schema validation (includes size above 10GiB and content type outside the allowlist)
- 400 PART_COUNT_EXCEEDED — derived part count above 10,000
- 401 — missing or invalid access token
- 404 CHANNEL_NOT_FOUND — the authenticated user has no channel

---

#### POST /videos/:public_id/upload/parts (SI-03.6)

**Auth:** required · owner only

**Request body:**
- part_numbers: integer[], required — 1–1000 entries, each 1 … part_count

**Response 200:**
- parts: `{ part_number: integer, url: string, expires_in: integer }[]` — `expires_in` is 21600

**Error responses:**
- 400 validation error — empty array, out-of-range part number
- 403 VIDEO_NOT_OWNED — the video belongs to another channel
- 404 VIDEO_NOT_FOUND
- 409 INVALID_UPLOAD_STATE — the video is not `draft` or has no open upload

---

#### GET /videos/:public_id/upload (SI-03.6)

**Auth:** required · owner only

**Response 200:**
- upload_id: string
- part_size: integer
- part_count: integer
- uploaded_parts: `{ part_number: integer, size: integer, etag: string }[]`

**Error responses:** 403 VIDEO_NOT_OWNED · 404 VIDEO_NOT_FOUND · 409 INVALID_UPLOAD_STATE

---

#### POST /videos/:public_id/upload/complete (SI-03.7)

**Auth:** required · owner only

**Request body:**
- parts: `{ part_number: integer, etag: string }[]`, required — non-empty

**Response 200:** the Video representation with `status: "processing"`

**Error responses:**
- 400 validation error
- 403 VIDEO_NOT_OWNED · 404 VIDEO_NOT_FOUND
- 409 INVALID_UPLOAD_STATE — already completed
- 422 UPLOAD_SIZE_MISMATCH — the stored object's size differs from the declared `size_bytes`

---

#### DELETE /videos/:public_id/upload (SI-03.7)

**Auth:** required · owner only

**Response 204:** No content. Aborts the multipart upload and removes the draft row.

**Error responses:** 403 VIDEO_NOT_OWNED · 404 VIDEO_NOT_FOUND · 409 INVALID_UPLOAD_STATE

---

#### GET /videos/:public_id (SI-03.10)

**Auth:** public. An authenticated owner additionally sees their own non-`ready` videos.

**Response 200:** the Video representation.

**Error responses:** 404 VIDEO_NOT_FOUND — unknown id, or a non-`ready` video requested by anyone but its owner

---

#### GET /videos/:public_id/stream (SI-03.10)

**Auth:** public · rate limiting skipped (`@SkipThrottle()`)

**Request headers:**
- Range: optional — `bytes=start-end`, `bytes=start-`, or `bytes=-suffix`

**Response 206** (with `Range`): binary body, headers `Content-Range: bytes <start>-<end>/<size>`, `Content-Length`, `Accept-Ranges: bytes`, `Content-Type`
**Response 200** (without `Range`): full body, headers `Accept-Ranges: bytes`, `Content-Length`, `Content-Type`

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY — the video exists and belongs to the caller but is not `ready`
- 416 — unsatisfiable range; replies `Content-Range: bytes */<size>`

---

#### GET /videos/:public_id/download (SI-03.11)

**Auth:** public

**Response 302:** empty body, `Location` is a pre-signed GET URL (TTL 900s) carrying
`Content-Disposition: attachment; filename="<original_filename>"`.

**Error responses:** 404 VIDEO_NOT_FOUND · 409 VIDEO_NOT_READY

---

#### GET /videos/:public_id/thumbnail (SI-03.10)

**Auth:** public

**Response 200:** `image/jpeg` body.

**Error responses:** 404 VIDEO_NOT_FOUND — unknown video, or no thumbnail generated yet

---

#### Video representation (shared response shape, TD-15)

```
{
  id: string (public_id),
  title: string,
  description: string | null,
  status: "draft" | "processing" | "ready" | "failed",
  channel: { id: string, nickname: string },
  duration_seconds: number | null,
  size_bytes: string,
  content_type: string,
  metadata: { width, height, codec, bitrate, formatName } | null,
  processing_error: string | null,
  url: string,
  stream_url: string,
  download_url: string,
  thumbnail_url: string | null,
  created_at: string (ISO 8601),
  updated_at: string (ISO 8601)
}
```

`size_bytes` is a string because PostgreSQL `bigint` exceeds JavaScript's safe integer
range and TypeORM returns it as a string; serialising it as a number would silently lose
precision above 2⁵³.

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner only | Notes |
|----------|--------|---------------|------------|-------|
| POST /videos | | ✓ | — | Channel resolved from the token, never from the body |
| POST /videos/:id/upload/parts | | ✓ | ✓ | |
| GET /videos/:id/upload | | ✓ | ✓ | |
| POST /videos/:id/upload/complete | | ✓ | ✓ | |
| DELETE /videos/:id/upload | | ✓ | ✓ | |
| GET /videos/:id | ✓ | | | `ready` only; the owner also sees their own drafts |
| GET /videos/:id/stream | ✓ | | | `ready` only · `@SkipThrottle()` (DG-01) |
| GET /videos/:id/download | ✓ | | | `ready` only |
| GET /videos/:id/thumbnail | ✓ | | | `ready` only |

Public endpoints carry `@Public()` explicitly — the global `JwtAuthGuard` from Fase 02
denies everything else by default. A non-`ready` video is reported as **404** to
non-owners rather than 403, so its existence is not disclosed.

---

### Error Catalog

**Error response format:** unchanged from Fase 02 — `{ statusCode, error, message }`,
where `error` is the domain code. New codes added by this phase:

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown `public_id`, or a non-`ready` video requested by anyone but its owner |
| VIDEO_NOT_OWNED | 403 | Video belongs to another channel | An owner-only operation on someone else's video |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | Stream/download/thumbnail on a video the caller owns that is not `ready` |
| CHANNEL_NOT_FOUND | 404 | Channel not found for the current user | `POST /videos` by a user with no channel |
| INVALID_UPLOAD_STATE | 409 | Upload is not in a valid state for this operation | Signing parts, completing, or aborting outside `draft` + open `upload_id` |
| PART_COUNT_EXCEEDED | 400 | Upload would exceed the maximum number of parts | `ceil(size_bytes / 64MiB)` above 10,000 |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | `HeadObject` `ContentLength` ≠ `size_bytes` at completion (TD-11) |

416 (Range Not Satisfiable) is produced directly by the streaming controller rather than
through a domain exception, because it must carry a `Content-Range: bytes */<size>` header
that the standard envelope does not model.

---

### Events / Messages

**Transport:** Redis + BullMQ (TD-01) · **Queue:** `video-processing` · **Job name:** `process-video`

#### `process-video`

| Property | Value |
|----------|-------|
| Payload | `{ videoId: string }` — the internal uuid, not `public_id` (TD-09) |
| `jobId` | `videoId` — deduplicates concurrent enqueues for the same video |
| `attempts` | 3 (TD-08) |
| `backoff` | `{ type: 'exponential', delay: 2000 }` → retries at ~2s, ~4s, ~8s |
| `removeOnComplete` | `true` |
| `removeOnFail` | `false` — failed jobs are retained for inspection |
| Producer | `VideoQueueService.enqueueProcessing`, called by `VideosService.completeUpload` **after** the transaction commits (SI-03.7) |
| Consumer | `VideoProcessingConsumer` in the `video-worker` container (SI-03.9) |
| Preconditions | The video row exists and is `processing`; the source object is complete in the videos bucket |
| Effects on success | `duration_seconds`, `metadata`, `thumbnail_key` written; `status` → `ready`; `processing_error` cleared; thumbnail object written at the deterministic key |
| Effects on final failure | `status` → `failed`; `processing_error` set from the error; source object **retained** so reprocessing needs no re-upload |
| Delivery semantics | At-least-once. Re-delivery is safe: the consumer re-reads the row and returns early when already `ready`, and the thumbnail key is deterministic so a re-run overwrites rather than accumulating (TD-09) |

**Connection asymmetry (library-refs.md):** the producer connection keeps the default
`maxRetriesPerRequest` so an HTTP request fails fast when Redis is down; the worker
connection sets `maxRetriesPerRequest: null` so a background worker waits for Redis to
return instead of crashing.

---

## Dependency Map

```
SI-03.1 (no deps — baseline repairs)
└── SI-03.2
    ├── SI-03.3
    │   └── SI-03.5 ──> SI-03.6 ──> SI-03.7
    ├── SI-03.4
    │   └── SI-03.5
    └── SI-03.8
        ├── SI-03.7   (completion enqueues the job)
        └── SI-03.9
            └── SI-03.10
                └── SI-03.11
                    └── SI-03.12
                        └── SI-03.13

SI-03.14 (no deps — inherited debt, separate commit at closure)
```

Linearized implementation order:
SI-03.1 → SI-03.2 → SI-03.3, SI-03.4 (parallel) → SI-03.8 → SI-03.5 → SI-03.6 → SI-03.7
→ SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14

SI-03.8 is pulled ahead of SI-03.5 because SI-03.7 must enqueue into an existing queue;
SI-03.14 is independent and is applied last so the inherited-debt commit sits on top of a
complete, green phase.

## Deliverables

- [ ] Upload of files up to 10GB that never pass through the API — pre-signed S3 multipart with 64MiB parts
- [ ] Video pre-registered as `draft` the moment the upload is initiated
- [ ] Resumable upload — part re-signing and `ListParts`-based resume
- [ ] Declared size enforced against the stored object at completion (`HeadObject`), aborting on mismatch
- [ ] Automatic processing after upload: duration and metadata extracted with `ffprobe`
- [ ] Automatic thumbnail generated from a frame at 10% of the duration
- [ ] Unique public URL per video (11-char `public_id`, unique constraint) with derived absolute URLs
- [ ] Streaming with HTTP Range and `206 Partial Content`, without requiring a full download
- [ ] Download via `302` to a pre-signed URL — the large transfer never touches the API
- [ ] Video status cycle `draft → processing → ready | failed` reflected in the database
- [ ] Failure handling: 3 attempts with exponential backoff, reason persisted, source retained
- [ ] Object storage (MinIO), queue (Redis) and video worker running via `docker compose` alongside the backend
- [ ] `CreateVideos` migration creating the `videos` table and its enum, with the entity tied to `Channel`
- [ ] Video worker as a separate container with FFmpeg, sharing the codebase and entities
- [ ] Inherited test defects repaired: migration enum cleanup, `test:e2e` `--runInBand`
- [ ] Inherited lint debt cleared — `npm run lint` exits 0
- [ ] `openapi.json` regenerated and mirrored to `next-frontend/`
- [ ] Root and backend `CLAUDE.md` updated with the video module, worker, queue and storage
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
