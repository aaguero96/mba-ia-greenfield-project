# phase-03-videos — Progress

**Status:** in progress
**SIs:** 6/14 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.7 — Upload Completion and Size Verification
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.8 — Queue Module, Job Production, and Worker Bootstrap
- **Status:** completed
- **Tests:** 15/15 (video-queue.service.spec: 6 unit, queue.integration-spec: 6 integration against real Redis, worker.module.spec: 2, videos.module.spec: 1); full suite 228/228, e2e 52/52, `tsc --noEmit` exit 0
- **Observations:** Two library surprises, both found by running the worker rather than by reading docs.
  (1) `@nestjs/bullmq@12` is ESM-only (`"type": "module"`). Node 25 loads it in production via `require(esm)`, so the container ran — but ts-jest's CommonJS runtime fails with `SyntaxError: Unexpected token 'export'` on every spec that transitively imports it, which would have included all three e2e suites via `AppModule → QueueModule`. Pinned to `@nestjs/bullmq@^11` + `bullmq@^5`, the CJS line, consistent with this project's CommonJS target.
  (2) BullMQ no longer bundles `ioredis`; it is an optional peer that must be installed explicitly, and `typeorm@0.3.28` pins it to `^5`, so `ioredis@^6` fails `npm install` with ERESOLVE. `^5` satisfies both.
  Also: `autoLoadEntities` does not work for the worker, which imports only `VideosModule` — `Video#channel` metadata failed until the entity list was made explicit. The list now lives in `src/database/entities.ts` and is consumed by both the worker and the test helper.

### SI-03.9 — Video Processing Consumer (metadata, thumbnail, status)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.10 — Video Metadata and Range Streaming
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.11 — Download via Redirect
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.12 — Full-Cycle E2E Hardening
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.13 — OpenAPI Regeneration and AI Documentation Update
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.14 — Inherited Lint Debt
- **Status:** pending
- **Tests:** —
- **Observations:** —
