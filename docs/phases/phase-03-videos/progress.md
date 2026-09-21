# phase-03-videos — Progress

**Status:** in progress
**SIs:** 13/14 completed

### Baseline (before SI-03.1)

Measured on the inherited `dev` branch before any Phase 03 work, inside the Compose stack:

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | exit 0 |
| `npm test -- --runInBand` | 143/144 — 1 failure (`migrations.integration-spec.ts`, leaked enum type) |
| `npm run test:e2e -- --runInBand` | 52/52 |
| `npm run test:e2e` (no flags) | 5/52 — suites collide on the shared database |
| `npm run lint` | exit 1 — 150 errors, 40 warnings across 11 files |

Both failures are pre-existing defects of the base repository, recorded as `DG-02`,
`DG-04` and `INC-01` in `validation.md` and repaired by SI-03.1 and SI-03.14.

### SI-03.1 — Baseline Repairs (inherited test defects)
- **Status:** completed
- **Tests:** 144/144 unit+integration passing (was 143/144), twice in a row; 52/52 e2e passing via plain `npm run test:e2e` (was 5/52)
- **Observations:** The enum leak was the whole failure. `DROP TABLE ... CASCADE` does not remove a PostgreSQL enum type, and any suite running with `synchronize: true` recreates `verification_tokens_type_enum` before the migration suite runs — so `CREATE TYPE` in `CreateAuthTokens` failed. Enums are now dropped sequentially **after** the tables (concurrently with them in the same `Promise.all` races against the CASCADE). Confirmed the suite is now idempotent: two consecutive full runs are green against an already-migrated database.

### SI-03.2 — Dependencies, Config Namespaces, and Docker Compose Infrastructure
- **Status:** completed
- **Tests:** 29/29 config tests (storage.config.spec: 7 unit, queue.config.spec: 6 unit, env.validation.integration-spec: +10 new cases); full suite 166/166, e2e 52/52, `tsc --noEmit` exit 0
- **Observations:** `docker.io/minio/minio` is no longer pullable anonymously (`pull access denied … repository does not exist`); pinned `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` instead. MinIO's healthcheck uses `mc ready local` — recent images ship `mc` but no `curl`. Adding `S3_ACCESS_KEY`/`S3_SECRET_KEY` as Joi-required broke every existing case in `env.validation.integration-spec.ts` until they were added to its `requiredEnv` fixture. Verified `ffprobe`/`ffmpeg` 5.1.9 exist in `video-worker` and are absent from `nestjs-api`, as TD-05 requires.

### SI-03.3 — Storage Module (S3 clients, bucket bootstrap, pre-signing)
- **Status:** completed
- **Tests:** 24/24 (storage.keys.spec: 11 unit, storage.service.integration-spec: 13 integration against real MinIO); full suite 190/190, e2e 52/52, `tsc --noEmit` exit 0
- **Observations:** Three findings, all confirmed empirically rather than assumed.
  (1) `requestChecksumCalculation: 'WHEN_REQUIRED'` is mandatory — the integration test uploads parts with a plain `fetch` PUT and no AWS SDK, which is what a browser does and what breaks under the SDK's default checksum headers.
  (2) MinIO `RELEASE.2025-09-07T16-13-09Z` does not support `AbortIncompleteMultipartUpload` lifecycle rules: a rule with only that action is rejected with `InvalidArgument`, and pairing it with an `Expiration` makes MinIO accept the request but persist only the `Expiration` — verified by reading the rule back. The call is now best-effort: written, read back, and a warning logged when the store did not keep it. Orphan parts are covered by the explicit aborts on every failure path.
  (3) Tests run inside the API container, where `S3_PUBLIC_ENDPOINT=http://localhost:9000` points at the container itself, so a test cannot fetch a public-signed URL — and SigV4 binds the Host header, so the URL cannot be rewritten after signing. Added `test/setup-test-env.ts` (a `setupFiles` entry in both Jest configs) which applies `S3_PUBLIC_ENDPOINT_TEST` over it. The public/internal split is still asserted directly, by signing through a module built with a deliberately distinct public endpoint.

### SI-03.4 — Video Entity, Migration, and Unique Public Identifier
- **Status:** completed
- **Tests:** 26/26 (video-public-id.util.spec: 4 unit, video-urls.util.spec: 5 unit, videos.module.spec: 1 unit, video.entity.integration-spec: 13 integration, migrations.integration-spec: 3 integration); full suite 214/214, e2e 52/52, `tsc --noEmit` exit 0
- **Observations:** Adding the `Channel.videos` inverse relation broke ten inherited suites with `Entity metadata for Channel#videos was not found` — a test DataSource must register the whole entity graph, not just the entities the suite touches. Each of those specs declared its own copy of `const ALL_ENTITIES = [...]`, so the list is now exported once from `src/test/create-test-data-source.ts` and imported everywhere; the next entity will not break them again. Separately, the migration spec's `beforeAll` dropped tables concurrently via `Promise.all`, which started failing with `relation "channels" already exists` once `videos` referenced `channels` — the drops are now sequential and in reverse dependency order. `duration_seconds` uses a numeric column with a transformer because TypeORM returns `numeric` as a string; `size_bytes` stays a string on purpose, since 10GiB is beyond the range where a JS number is exact.

### SI-03.5 — Upload Initiation (pre-registration as draft)
- **Status:** completed
- **Tests:** 30/30 (videos.service.spec: 12 unit, videos.service.integration-spec: 5 integration with real DB + MinIO, videos.module.integration-spec: 1, videos.e2e-spec: 12 e2e); full suite 245/245, e2e 64/64, `tsc --noEmit` exit 0
- **Observations:** The row id has to exist before the storage key can be built (the key embeds it), so the id is generated with `randomUUID()` rather than waiting for the insert. A `public_id` collision is handled by a bounded retry that also aborts the multipart upload opened by the abandoned attempt — verified by an integration test that forces the insert to fail and then asserts no orphan upload and no row remain. `videos.module.spec.ts` was converted to `videos.module.integration-spec.ts`: once the module wired a database, a queue and storage, a "unit" module test was no longer honest under the project's own suffix rule.

### SI-03.6 — Part Signing and Resume
- **Status:** completed
- **Tests:** 6 unit (videos.service.upload.spec: guards + signing) and 7 e2e (videos-upload.e2e-spec: signing, real PUT to the signed URL, resume via `GET /upload`, out-of-range part, ownership, unknown video); full suite 258/258, e2e 77/77
- **Observations:** The e2e uploads real bytes with a plain `fetch` PUT, never through the API — the same shape a browser uses, and the path that breaks under the SDK's default checksum headers. Re-signing the same part number is explicitly covered, because that is what makes the 6h TTL sufficient rather than a hard deadline.

### SI-03.7 — Upload Completion and Size Verification
- **Status:** completed
- **Tests:** 7 unit (completion, size mismatch, enqueue ordering, abort) and 6 e2e (completion → `processing`, 422 on mismatch, 409 on double completion, cancel); full suite 258/258, e2e 77/77, `tsc --noEmit` exit 0
- **Observations:** The size mismatch path is the one that proves the 10GB ceiling is actually enforced: the e2e declares 9999 bytes, uploads 100, and asserts 422 plus a `failed` row with a reason — something no mocked storage could demonstrate. Enqueueing happens strictly after the row is saved, asserted by an ordering test, so a job can never point at a video that is not yet `processing`. Both `videos.service.integration-spec` and the e2e app needed `QueueModule` registered once the service took the queue as a dependency.

### SI-03.8 — Queue Module, Job Production, and Worker Bootstrap
- **Status:** completed
- **Tests:** 15/15 (video-queue.service.spec: 6 unit, queue.integration-spec: 6 integration against real Redis, worker.module.spec: 2, videos.module.spec: 1); full suite 228/228, e2e 52/52, `tsc --noEmit` exit 0
- **Observations:** Two library surprises, both found by running the worker rather than by reading docs.
  (1) `@nestjs/bullmq@12` is ESM-only (`"type": "module"`). Node 25 loads it in production via `require(esm)`, so the container ran — but ts-jest's CommonJS runtime fails with `SyntaxError: Unexpected token 'export'` on every spec that transitively imports it, which would have included all three e2e suites via `AppModule → QueueModule`. Pinned to `@nestjs/bullmq@^11` + `bullmq@^5`, the CJS line, consistent with this project's CommonJS target.
  (2) BullMQ no longer bundles `ioredis`; it is an optional peer that must be installed explicitly, and `typeorm@0.3.28` pins it to `^5`, so `ioredis@^6` fails `npm install` with ERESOLVE. `^5` satisfies both.
  Also: `autoLoadEntities` does not work for the worker, which imports only `VideosModule` — `Video#channel` metadata failed until the entity list was made explicit. The list now lives in `src/database/entities.ts` and is consumed by both the worker and the test helper.

### SI-03.9 — Video Processing Consumer (metadata, thumbnail, status)
- **Status:** completed
- **Tests:** 38/38 (thumbnail-offset.util.spec: 9 unit, ffmpeg.service.spec: 9 unit, ffmpeg.service.integration-spec: 9 integration against the real binaries, video-processing.consumer.integration-spec: 11 integration against real DB + MinIO + FFmpeg); full suite 297/297, e2e 77/77, `tsc --noEmit` exit 0
- **Observations:** Three things the plan did not anticipate.
  (1) The worker's specs need `ffprobe`/`ffmpeg`, which by TD-05 live only in the worker image — so `Dockerfile.dev` now installs them too, with a comment that this is the **development/test** image and that a production API image must not carry the layer. The architectural separation (own container, own runtime image, independent scaling) is unaffected.
  (2) Once the worker container was running a real consumer, `queue.integration-spec.ts` started failing: the live worker drained the jobs the test had just enqueued. Queues now take a Redis key `prefix` from config, and `test/setup-test-env.ts` forces a distinct one for tests, so the running worker and the suite never share keys.
  (3) `await import(...)` inside a spec fails under ts-jest without `--experimental-vm-modules`; the dynamic imports were made static.
  The fixture video is generated with FFmpeg's `testsrc` and cached in the OS temp dir, so no binary asset is committed. Thumbnail extraction is asserted to be byte-identical for the same offset, which is what makes a retry overwrite rather than accumulate.

### SI-03.10 — Video Metadata and Range Streaming
- **Status:** completed
- **Tests:** 20 unit (range.util.spec: 15, content-disposition.util.spec: 5) + 3 new guard unit tests + 13 e2e (videos-playback.e2e-spec: metadata visibility, 206 with exact bytes, middle range, full body with `Accept-Ranges`, whole file reassembled from consecutive ranges, 416, 25 unthrottled requests, thumbnail); full suite 320/320, e2e 93/93
- **Observations:** The inherited `@Public()` decorator short-circuited the guard **before** attaching the caller, so "the owner sees their own unprocessed video" would silently never work. The guard now treats a public route as *optional* authentication: a valid token attaches the user, an absent or invalid one is ignored and never turns a public request into a 401. The playback e2e does not fake the `ready` state — it boots the real worker context and runs the actual consumer, so streaming is asserted against a genuinely processed video.

### SI-03.11 — Download via Redirect
- **Status:** completed
- **Tests:** 3 e2e (302 to a pre-signed URL, the complete file served as an attachment when the redirect is followed, 404 for a non-ready video); full suite 320/320, e2e 93/93, `tsc --noEmit` exit 0
- **Observations:** `res.redirect()` writes a short courtesy body, so "the API moves no bytes" is asserted as the body being bounded by the URL length and independent of the file size, rather than empty. Two unrelated fixes fell out of this SI: `cleanAllTables` became a single `TRUNCATE ... CASCADE`, because a sequence of DELETEs raced with the second connection pool that this suite opens for the worker context; and `fetch(..., { body })` needed a `Uint8Array` rather than Node's `Buffer` subtype to satisfy `BodyInit`.

### SI-03.12 — Full-Cycle E2E Hardening
- **Status:** completed
- **Tests:** 3 e2e (videos-full-cycle.e2e-spec: the whole cycle with no mocks, distinct unique URLs across videos, a processing failure that keeps the uploaded file)
- **Observations:** The status column is observed passing through `draft → processing → ready` in that order, and the file streamed back in 2KB ranges is compared byte for byte against what was uploaded — the deliverables are asserted rather than claimed. The fixture is generated by FFmpeg's `testsrc`, so the repository carries no binary asset.

### SI-03.13 — OpenAPI Regeneration and AI Documentation Update
- **Status:** completed
- **Tests:** no new tests — `openapi-export.integration-spec.ts` (9) still passes and `cmp` confirms the two `openapi.json` files are byte-identical
- **Observations:** `openapi.json` regenerated with all 8 video paths and mirrored into `next-frontend/` via `scripts/sync-openapi.sh`. Root `CLAUDE.md` gained a Video Module section (upload flow, processing, playback, status lifecycle, unique URL, storage layout) and the queue is no longer `TBD` there or in `software-arch.mermaid`. The backend `CLAUDE.md` documents the three new Compose services, their readiness probes, the worker entrypoint, and the three environment caveats that cost real debugging time: the endpoint duality, the test-time overrides, and the SDK checksum setting.

### SI-03.14 — Inherited Lint Debt
- **Status:** pending
- **Tests:** —
- **Observations:** —
