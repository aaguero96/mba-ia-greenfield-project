---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-20T22:07:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T22:35:48-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-20T22:08:20-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-20T22:08:20-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-09-20T22:08:20-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** edição das informações do vídeo, categorias, visibilidade pública/unlisted, fluxo de publicação e painel do canal (Fase 04); página de visualização e player (Fase 05); likes, comentários e inscrições (Fase 06); home, busca e paginação (Fase 07).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de upload e o player de vídeo não fazem parte desta fase; a UI de vídeo começa na Fase 05.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta. Videos belong to a `Channel`, which Fase 02 creates one-to-one with each `User` at registration; the ownership check for every write operation in this phase resolves through that relation.

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend / Infrastructure | Message Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | @nestjs/bullmq@^12.x, bullmq@^6.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Large File Upload Strategy (10GB) | decided | C (pre-signed S3 multipart, 64MB parts) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend / Infrastructure | Object Storage Layout | decided | B (two buckets, `{channel_id}/{video_id}/` keys) | @aws-sdk/client-s3@^3.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Unique Public Video Identifier | decided | B (11-char `public_id` via `crypto.randomBytes`) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend / Infrastructure | Video Worker Runtime Topology | decided | A (shared codebase, separate entrypoint + container) | @nestjs/bullmq@^12.x |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Metadata Extraction and Thumbnail Generation | decided | B+2 (`execFile` of ffprobe/ffmpeg over pre-signed URL) | — (system binaries: ffmpeg/ffprobe) |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Streaming and Download Delivery | decided | C (proxied `206` streaming, redirected download) | @aws-sdk/client-s3@^3.x |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Failure Handling | decided | A+2 (4 states, 3 retries w/ backoff, reason persisted) | bullmq@^6.x |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Job Payload and Consumer Idempotency | decided | B (thin payload, idempotent consumer) | bullmq@^6.x |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend / Infrastructure | Storage Endpoint Duality | decided | B (internal + public endpoints, two clients, path-style) | @aws-sdk/client-s3@^3.x |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Backend | Upload Constraint Enforcement | decided | B (validate at initiation, `HeadObject` at completion) | @aws-sdk/client-s3@^3.x |
| phase-03-videos/TD-12 | technical-decisions-phase-03-videos.md | Backend | Thumbnail Frame Selection and Output Format | decided | B (10% of duration clamped, JPEG 1280w) | — |
| phase-03-videos/TD-13 | technical-decisions-phase-03-videos.md | Backend | Public Access Boundary for Phase 03 | decided | B (public reads gated by `ready`, owner-scoped writes) | — |
| phase-03-videos/TD-14 | technical-decisions-phase-03-videos.md | Backend | Pre-signed URL Lifetimes | decided | B (6h parts / 1h probe / 15min download, re-signable) | @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-15 | technical-decisions-phase-03-videos.md | Backend | Representation of the Unique Video URL | decided | B (`public_id` + derived absolute URLs) | — |

_TD-10 through TD-15 were added by `plan-resolve` in response to `validation.md` findings; see the "Resolved Issues" section there._

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05, phase-03-videos/TD-09 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-14 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-08, phase-03-videos/TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-06, phase-03-videos/TD-12 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04, phase-03-videos/TD-15 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-13 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-10, phase-03-videos/TD-13, phase-03-videos/TD-14 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — the job characteristics of this phase (few messages, long duration, retry-on-failure, stall recovery, idempotent consumer) map one-to-one onto BullMQ's built-in primitives, while RabbitMQ would require rebuilding retry/backoff on dead-letter exchanges and a Postgres-backed queue would push a CPU-adjacent workload onto the transactional database the architecture deliberately keeps separate. `@nestjs/bullmq@12` supports `@nestjs/core ^11` and `bullmq ^6`.

**Libraries:** `@nestjs/bullmq@^12.x`, `bullmq@^6.x`

### phase-03-videos/TD-02

**Recommendation:** Option C (pre-signed multipart upload) — the only option satisfying both hard requirements: a single pre-signed `PUT` caps at 5GB and streaming through the API fails both "sem travar o sistema" and resumability. The API stays on the control plane (sign + complete). Part size 64MB — above the 5MB S3 minimum, and 160 parts for 10GB, well inside the 10,000-part limit.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Option B (two buckets by content class) — `streamtube-videos` and `streamtube-thumbnails` have opposite access and lifecycle profiles (private + multipart reaping vs. small, cacheable, eventually public). Keys `videos/{channel_id}/{video_id}/source{ext}` and `thumbnails/{channel_id}/{video_id}/thumb.jpg` make ownership legible in the key and per-channel operations a prefix scan. Buckets are created idempotently at bootstrap so the Compose stack is self-provisioning.

**Libraries:** `@aws-sdk/client-s3@^3.x`

### phase-03-videos/TD-04

**Recommendation:** Option B (short random slug in a unique column) — satisfies "curta, única, sem conflito" with a database-enforced unique constraint plus bounded retry, and decouples the public URL from the primary key. Generated with `crypto.randomBytes(8).toString('base64url')` (11 URL-safe chars, 64 bits). `nanoid@6` is deliberately avoided: it ships ESM-only (`"type": "module"`) and this project compiles to CommonJS (`module: nodenext`, no `"type": "module"`), so it would fail at runtime.

**Libraries:** — (Node built-in `crypto`)

### phase-03-videos/TD-05

**Recommendation:** Option A (shared codebase, separate entrypoint and container) — delivers the isolation the architecture diagram calls for (own container, own image with FFmpeg, independently scalable) without duplicating entities and config. The worker's job is to update the same `videos` rows the API created, so sharing the entity/repository layer removes an entire class of drift bugs. Bootstrapped with `NestFactory.createApplicationContext` (no HTTP listener).

**Libraries:** `@nestjs/bullmq@^12.x`

### phase-03-videos/TD-06

**Recommendation:** Option B + Option 2 (direct `execFile` of `ffprobe`/`ffmpeg`, source read through a pre-signed GET URL) — avoids depending on the effectively unmaintained `fluent-ffmpeg` for the phase's core capability, and `execFile` with an argument array spawns no shell. Reading via HTTP Range keeps the "no full 10GB transfer anywhere it is not needed" principle consistent: FFmpeg fetches the container header and the target frame region only, with no temp file and no local disk requirement.

**Libraries:** — (system binaries `ffmpeg` / `ffprobe` in the worker image)

### phase-03-videos/TD-07

**Recommendation:** Option C (proxied streaming, redirected download) — streaming moves in bounded chunks and keeps per-request authorization plus the hook Fase 05 needs for view counting, so it is proxied with `206 Partial Content`; download is the one genuinely large transfer, so it is a `302` to a short-lived pre-signed URL and never touches the API. A request without a `Range` header is answered `200` with `Accept-Ranges: bytes`.

**Libraries:** `@aws-sdk/client-s3@^3.x`

### phase-03-videos/TD-08

**Recommendation:** Option A + Option 2 (`draft` → `processing` → `ready` | `failed`; 3 attempts with exponential backoff) — the four states are exactly the cycle the phase requires and every one of them is server-observable, unlike a client-driven `uploading` state that can lie. Bounded retry respects the asymmetry of the workload: the user already paid a very expensive upload, so three attempts to separate a transient fault from a real one is cheap. The failure reason is persisted on the row and the source object is retained so re-processing never costs another upload.

**Libraries:** `bullmq@^6.x`

### phase-03-videos/TD-09

**Recommendation:** Option B (thin payload `{ videoId }`, idempotent consumer) — at-least-once delivery makes re-execution normal, so carrying a stale row snapshot in the message buys nothing and couples the message contract to the schema. `jobId = videoId` deduplicates enqueues, the worker re-reads the row and early-returns when already `ready`, and the deterministic thumbnail key makes a re-run overwrite instead of accumulating garbage — covering all three duplication paths.

**Libraries:** `bullmq@^6.x`

### phase-03-videos/TD-10

**Recommendation:** Option B (two endpoints, two `S3Client` instances) — a SigV4 signature commits the host it was signed for, and this stack has two views of the same storage: `minio:9000` over the Compose network for the API and the worker, and an externally resolvable host for upload clients and download redirects. `S3_ENDPOINT` signs for internal consumers, `S3_PUBLIC_ENDPOINT` for external ones. `forcePathStyle: true` on both, which MinIO requires.

**Libraries:** `@aws-sdk/client-s3@^3.x`

### phase-03-videos/TD-11

**Recommendation:** Option B (validate at initiation, verify at completion) — the declared `size_bytes` is client-supplied and therefore cannot be the enforcement point; the authoritative source is the stored object, read with a single `HeadObject` metadata call at completion. Bounds `1 ≤ size_bytes ≤ 10 GiB` (10,737,418,240), an explicit `content_type` allowlist, and a part count of `ceil(size_bytes / 64MiB)` rejected above 10,000. A size mismatch aborts the upload and fails the request before any job is enqueued.

**Libraries:** `@aws-sdk/client-s3@^3.x`

### phase-03-videos/TD-12

**Recommendation:** Option B (10% of duration, clamped) — deterministic and total over all durations, which is what TD-09's overwrite-on-rerun assumes; a fixed opening offset is a known way to ship black thumbnails and scene detection would require the full-file read the phase avoids everywhere else. `-ss` before `-i` for keyframe seek, JPEG at `scale=1280:-2` and `-q:v 3`.

**Libraries:** — (system binaries `ffmpeg` / `ffprobe`)

### phase-03-videos/TD-13

**Recommendation:** Option B (public reads gated by status, owner-scoped authenticated writes) — the project plan grants anonymous viewing, and the `ready` gate is a condition Fase 04's visibility rules will compose with rather than reverse. `@SkipThrottle()` is scoped to the streaming endpoint alone, whose Range-request pattern is structurally incompatible with a per-minute limit designed for login attempts.

**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** Option B (per-purpose TTLs with re-signing) — part URLs 6h, worker probe URL 1h, download redirect 15min. Re-signable part URLs remove the pressure to size the upload TTL for the worst imaginable connection, which is what would otherwise push all three values toward the longest one. All are well inside the 7-day SigV4 maximum.

**Libraries:** `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-15

**Recommendation:** Option B (`public_id` plus derived absolute URLs) — the phase's stated deliverable is "URLs únicas geradas", so the API returns `url`, `stream_url`, `download_url` and `thumbnail_url` built from the existing `APP_URL` config, generated in exactly one place, with `public_id` still exposed for clients that build their own routes.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only — a global `JwtAuthGuard` registered as `APP_GUARD` protects every endpoint by default, with `@Public()` as the explicit opt-out. Every video endpoint in this phase inherits this posture: write operations are authenticated by default, and the anonymous-access endpoints (streaming, download, public metadata) must be marked `@Public()` deliberately.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** `class-validator` + `class-transformer` with the global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`). All Phase 03 request DTOs follow this; the `@nestjs/swagger` CLI plugin derives OpenAPI schemas from the validators, so request DTOs carry no manual `@ApiProperty`.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom domain exception filter — every error is `{ statusCode, error, message }` where `error` is a machine-readable domain code. Phase 03 adds its video error codes as `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`; no new filter or envelope is introduced.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** `@nestjs/throttler` registered as a module-level `APP_GUARD`. It is already global via `AuthModule`, so video endpoints are rate-limited by the same policy; the streaming endpoint is a documented exception (a player issues many range requests per playback) and must opt out with `@SkipThrottle()`.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-01-configuracao-base/TD-01, TD-03

**Recommendation:** `@nestjs/config` with namespaced `registerAs` factories, one file per domain in `src/config/`, injected via `ConfigType<typeof xxxConfig>`. Phase 03 adds `storage.config.ts`, `queue.config.ts`, and `video.config.ts` following the same pattern.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi validation schema in `src/config/env.validation.ts`, wired through `ConfigModule.forRoot({ validationSchema })`. Every new Phase 03 environment variable is added to this schema.

**Libraries:** `joi@^17.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; every entity must also be registered in its owning module via `TypeOrmModule.forFeature([Entity])`, or it is silently missing from migrations. _(from phase 01 / `.claude/rules/nestjs-modules.md`)_
- Entities use `@Entity('table_name')` with an explicit table name, `@PrimaryGeneratedColumn('uuid')`, and `@CreateDateColumn()` / `@UpdateDateColumn()`. Both sides of every relation are declared. _(from phase 02 / `.claude/rules/nestjs-entities.md`)_
- Migrations are generated via the TypeORM CLI (`npm run migration:generate`), never hand-written, and never edited after being executed. Test data sources import migration classes directly instead of using globs. _(from phase 02 / `.claude/rules/typeorm-migrations.md`)_
- Errors are `DomainException` subclasses carrying `errorCode` + `httpStatus`, rendered by the global `DomainExceptionFilter` as `{ statusCode, error, message }`. _(from phase 02)_
- All endpoints are protected by the global `JwtAuthGuard`; anonymous access requires an explicit `@Public()` decorator. The authenticated user arrives via `@CurrentUser()` as a `JwtPayload` (`{ sub, email }`). _(from phase 02)_
- Controllers are thin and delegate to services; business rules live only in services. Guards/filters/pipes inject services when they need a domain decision. _(from `.claude/rules/nestjs-layer-separation.md`)_
- Request DTOs carry only `class-validator` decorators and JSDoc comments — the `@nestjs/swagger` CLI plugin generates the schema. Response DTOs need explicit `@ApiProperty`. _(from phase 02 / `.claude/rules/nestjs-dtos.md`)_
- Every service runs in Docker and addresses other services by Compose service name (`db`, `mailpit`), never `localhost`. _(from phase 01 / root `CLAUDE.md`)_
- Test suffixes: `*.spec.ts` (unit, all collaborators mocked), `*.integration-spec.ts` (real DB/services, next to the source), `*.e2e-spec.ts` (full HTTP via supertest, in `nestjs-project/test/`). Integration and e2e run with `--runInBand`. _(from phase 02 / `nestjs-project/CLAUDE.md`)_
- Jest config requires `setupFiles: ["dotenv/config"]` in both `package.json` and `test/jest-e2e.json`, otherwise container-to-container DNS breaks. _(from phase 02)_
- Non-TypeScript runtime assets must be declared in `nest-cli.json` → `compilerOptions.assets`, or they are missing from `dist/`. _(from phase 02)_
- `.env` values containing shell-special characters (`<`, `>`, spaces) must be quoted — the file is parsed by both Docker Compose and `dotenv`. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Origin | Status |
|------------|--------|--------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | phase-02-auth | Delivered later in `phase-02-auth-frontend`; not re-opened here. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de upload de vídeo | deferred | This phase is backend-only; the upload UI is not part of the Fase 03 scope. The multipart client flow is exercised by integration and e2e tests, which act as the reference client. | phase-03-videos/TD-02 |
| Player de vídeo | deferred | The player is a Fase 05 capability (Página de Visualização do Vídeo). Phase 03 delivers the streaming endpoint the player will consume. | phase-03-videos/TD-07 |

## Open Questions

_None._ All decisions required by the phase capabilities are resolved in `technical-decisions-phase-03-videos.md`.

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces the first infrastructure-integrating services (object storage, queue) and the first non-HTTP process (the worker), so the pyramid extends accordingly:

- **Unit** — pure logic with all collaborators mocked: `public_id` generation, range-header parsing, status transition rules, `ffprobe` JSON→metadata mapping, controller wiring.
- **Integration** — real infrastructure from the Compose stack, never mocked: MinIO (bucket bootstrap, multipart lifecycle, pre-signed URL round-trip), Redis/BullMQ (enqueue + processor execution), PostgreSQL (entity constraints, migration apply/revert), and the real `ffprobe`/`ffmpeg` binaries against a fixture video.
- **E2E** — the full HTTP cycle via supertest: upload initiation, part signing, completion, the `206 Partial Content` response with a correct `Content-Range`, the `302` download redirect, ownership enforcement, and anonymous access to public endpoints.

Per `.claude/rules/nestjs-testing.md` and the enunciado, services that exist in the Compose stack (MinIO, Redis, FFmpeg) are exercised for real; mocking is reserved for unit tests. Specific layer coverage by SI is recorded in `progress.md`.
