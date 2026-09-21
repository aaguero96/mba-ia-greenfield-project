# phase-03-videos — Progress

**Status:** in progress
**SIs:** 2/14 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.4 — Video Entity, Migration, and Unique Public Identifier
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.5 — Upload Initiation (pre-registration as draft)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.6 — Part Signing and Resume
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.7 — Upload Completion and Size Verification
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.8 — Queue Module, Job Production, and Worker Bootstrap
- **Status:** pending
- **Tests:** —
- **Observations:** —

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
