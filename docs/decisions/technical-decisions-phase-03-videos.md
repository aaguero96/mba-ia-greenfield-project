---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-20
scope_description: "Backend foundation for large-file video ingestion and processing: message queue technology, 10GB upload strategy, object storage layout, unique public video identifier, worker runtime topology, FFmpeg metadata/thumbnail extraction, streaming and download delivery, video status lifecycle, and job payload/idempotency."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video module (upload initiation, multipart part signing, upload completion, streaming, download, video metadata), the video worker that consumes the processing queue, and the new infrastructure services (object storage, queue) in Docker Compose.
- `next-frontend/` — Frontend deferred: the video upload and playback UI is out of scope for this phase (Fase 05 — Página de Visualização do Vídeo covers the player). No open decision in this document.

_Given by the project (not an open decision):_ the object storage is S3-compatible — MinIO locally in Docker, swappable for AWS S3 in production. This is fixed by `docs/diagrams/software-arch.mermaid` (`ContainerDb(storage, "Object Storage", "S3 or MinIO")`) and by the root `CLAUDE.md`. What TD-03 decides is *how* to use it, not *which* storage.

---

## TD-01: Message Queue Technology

**Scope:** Backend / Infrastructure

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram declares the queue container as `TBD` — this is the single genuinely open stack decision of the phase. The queue receives one job per uploaded video and delivers it to the video worker. The workload profile is specific: **low message volume** (one job per upload), **very long job duration** (FFmpeg on a multi-GB file can take minutes), **failure is expected and must be retried with backoff**, and the job must survive an API or worker restart. There is no fan-out, no routing topology, and no event-sourcing requirement — Fase 03 has exactly one producer (the API) and one consumer (the worker).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue. `@nestjs/bullmq@12` is the official NestJS wrapper (peer range `@nestjs/core ^10 || ^11 || ^12`, `bullmq ^3 || ^4 || ^5 || ^6`), providing `BullModule.registerQueue()`, the `@Processor()` / `WorkerHost` decorator pair, and DI-aware workers. Redis runs as one extra Compose service (`redis:8-alpine`).
- **Pros:** Retries with exponential backoff, per-job timeouts, concurrency control, delayed jobs, `jobId`-based deduplication, and a durable failed-jobs set are all built in — exactly the primitives a long video job needs, with no custom plumbing. Official NestJS integration means the worker is a normal Nest provider with full DI (repositories, config, storage service) instead of a hand-rolled consumer loop. `worker.stalled` detection recovers jobs whose worker died mid-processing, which matters when a job runs for minutes. Single small container; Redis is also reusable in later phases for caching (Fase 07 listings) without adding another dependency.
- **Cons:** Adds Redis to the stack — a second datastore to run and operate. At-least-once delivery, so the consumer must be idempotent (addressed in TD-09). Not a broker: no exchanges, routing keys, or multi-consumer topologies if the project later needs event fan-out.

### Option B: RabbitMQ + `@nestjs/microservices`
- A real AMQP broker. NestJS ships an RMQ transport; the worker would be a microservice app with `@MessagePattern`/`@EventPattern` handlers.
- **Pros:** True message broker with exchanges, routing keys, and dead-letter exchanges. Battle-tested durability and a mature management UI. Scales naturally if later phases need multiple independent consumers of the same event (e.g., notifications + transcoding + analytics).
- **Cons:** No native retry-with-backoff — delayed retries require a dead-letter-exchange + TTL topology hand-built per queue, which is exactly the plumbing BullMQ gives for free. The NestJS RMQ transport is request/response-oriented; long-running consumers need explicit `noAck` and manual channel acknowledgement, and the default consumer timeout has to be raised for multi-minute jobs. Heavier container (Erlang VM) for a workload of a handful of messages per day. Significantly more concepts for a single producer/single consumer pipeline.

### Option C: PostgreSQL-backed queue (`pg-boss` / `graphile-worker`)
- The queue lives in the database already in the stack — no new infrastructure container at all.
- **Pros:** Zero new infrastructure. Enqueue can share the same transaction as the video row update, giving exactly-once semantics between "video marked as processing" and "job enqueued" — impossible with an external broker. Operationally the simplest thing to back up and reason about.
- **Cons:** Couples the video-processing workload to the primary OLTP database: long-polling consumers and job churn add load to the same Postgres instance that serves user requests. No official NestJS integration — the worker wiring would be custom. The architecture diagram explicitly models the queue as a **separate container** from the database; collapsing them contradicts the target architecture the project committed to. Job visibility tooling is weaker than Bull's.

### Option D: Apache Kafka
- Distributed commit log.
- **Pros:** Extreme throughput, replayable log, consumer groups.
- **Cons:** Wildly disproportionate for one job per upload — Kafka is a streaming platform for high-volume event pipelines, not a task queue with per-job retry and backoff. Heaviest operational footprint of all options (broker + coordination). Retry/DLQ semantics must be built by hand. Rejected on cost/benefit grounds without further analysis.

**Recommendation:** **Option A (BullMQ + Redis)** — the job characteristics of this phase (few messages, long duration, retry-on-failure, stall recovery, idempotent consumer) map one-to-one onto BullMQ's built-in primitives, while Option B would require rebuilding retry/backoff on top of dead-letter exchanges and Option C would push a CPU-adjacent workload onto the transactional database the architecture deliberately keeps separate. The official `@nestjs/bullmq` package keeps the worker a first-class Nest provider, so the worker reuses the project's existing config, entity, and repository wiring instead of a parallel bootstrap path. Redis is a single lightweight container and is a natural fit for the caching needs of later phases. The at-least-once caveat is real but cheap to absorb — TD-09 makes the consumer idempotent.

**Decision:** A (BullMQ + Redis, via `@nestjs/bullmq`)

---

## TD-02: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The phase requires uploading files of up to 10GB without degrading the API. `docs/project-plan.md` → "Pontos de Atenção" adds a second requirement: the upload must be **resumable** on connection failure. The decision is where the bytes physically flow: through the Node.js API process, or straight from the client to object storage.

**Options:**

### Option A: Stream through the API (`multipart/form-data` + Busboy → S3 upload)
- The client POSTs the file to the API, which pipes the incoming stream directly into the storage SDK's upload.
- **Pros:** One endpoint, no client-side orchestration. All access control happens naturally in the request path. Storage credentials never leave the server.
- **Cons:** A single request occupies an API connection for the entire transfer — minutes to hours for 10GB — and Node's event loop must shuttle every byte. Concurrent uploads multiply memory pressure and socket exhaustion. Any proxy in front of the API (nginx, ALB) imposes body-size and timeout limits that a 10GB body will hit. **No resumability:** a dropped connection restarts from byte zero. This is the failure mode the enunciado lists under "Reprova automática" — passing the 10GB file through the API in a way that stalls the system.

### Option B: Single pre-signed `PUT`
- The API returns one pre-signed URL; the client `PUT`s the whole file directly to storage.
- **Pros:** Bytes never touch the API. Trivial to implement — one `getSignedUrl` call.
- **Cons:** The S3 `PutObject` API caps a single upload at **5GB**, so it cannot satisfy the 10GB requirement at all. Still not resumable — one failed request means restarting the whole transfer. No parallelism, so wall-clock time is bounded by a single TCP stream.

### Option C: Pre-signed **multipart** upload (`CreateMultipartUpload` → pre-signed `UploadPart` URLs → `CompleteMultipartUpload`)
- Three API calls bracket the transfer: the API creates the multipart upload and hands back pre-signed URLs for each part; the client uploads parts directly to storage (in parallel, retrying individual parts); the API then completes the upload and enqueues processing.
- **Pros:** Supports objects up to 5TB — 10GB is well inside the envelope. **Natively resumable:** a failed part is retried in isolation, and `ListParts` lets a client resume an interrupted session. Parts upload in parallel, so throughput is not capped by one connection. The API handles only small JSON requests — signing and completion — so a 10GB upload costs the API three cheap round-trips regardless of file size. Pre-signed URLs are scoped to one key and expire, so storage credentials are never exposed. Supported identically by MinIO and AWS S3, preserving the "swap MinIO for S3 in production" property.
- **Cons:** The client must orchestrate part splitting, parallelism, and retries — more complex than a single `PUT` (mitigated here: this is a backend-only phase, and the flow is exercised by integration/e2e tests that act as the reference client). Requires bookkeeping of the `upload_id` between initiation and completion. Abandoned multipart uploads leave orphan parts in the bucket until a lifecycle rule reaps them.

### Option D: Resumable upload protocol (tus) via a `tus` server
- A dedicated resumable-upload protocol with a server component in front of storage.
- **Pros:** Protocol-level resumability with mature client libraries; a single well-defined upload contract.
- **Cons:** Introduces a fourth infrastructure container and a protocol that is not S3-native — the tus server becomes the byte path, reintroducing the very bottleneck Option C removes (unless configured with an S3 store, which is essentially Option C with extra hops). Redundant with capability that S3 multipart already provides.

**Recommendation:** **Option C (pre-signed multipart upload)** — it is the only option that satisfies both hard requirements simultaneously: 10GB exceeds Option B's 5GB ceiling, and Option A fails the "sem travar o sistema" and resumability requirements outright. Keeping the API on the control plane (sign, complete) and off the data plane is the architectural point of the phase, and it is the same mechanism the AWS SDK's own `Upload` helper uses internally, so nothing exotic is being invented. Part size is fixed at **64MB**: S3 allows at most 10,000 parts, so 10GB requires parts of at least ~1.05MB; 64MB keeps a 10GB upload at 160 parts — comfortably inside the limit — while staying above the 5MB minimum part size that S3 enforces for every part except the last.

**Decision:** C (pre-signed multipart upload, 64MB parts)

---

## TD-03: Object Storage Layout (buckets, key scheme, access)

**Scope:** Backend / Infrastructure

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage engine is given (S3-compatible, MinIO locally). What must be decided is the bucket topology and key naming, because both are effectively immutable once objects exist: renaming a key scheme later means rewriting every stored object and every database reference.

**Options:**

### Option A: One bucket, separated by key prefix (`streamtube/videos/...`, `streamtube/thumbnails/...`)
- **Pros:** One bucket to create and configure. Simplest bootstrap.
- **Cons:** Videos and thumbnails have opposite access and lifecycle profiles — thumbnails are small, cacheable and eventually public; source videos are large, private and expensive to store. A single bucket forces one policy, one lifecycle configuration and one CORS rule for both. Prefix-scoped IAM policies exist but are more error-prone than bucket-scoped ones.

### Option B: Two buckets by content class (`streamtube-videos`, `streamtube-thumbnails`)
- Key scheme: `videos/{channel_id}/{video_id}/source{ext}` and `thumbnails/{channel_id}/{video_id}/thumb.jpg`.
- **Pros:** Each bucket carries its own policy and lifecycle: the videos bucket stays private with an abort-incomplete-multipart-upload rule to reap orphan parts, while the thumbnails bucket can be made public-read or CDN-fronted in a later phase without touching video access. Including `channel_id` in the key makes per-channel storage accounting and bulk deletion a prefix operation. Including `video_id` (a UUID) guarantees key uniqueness without coordination and makes an object trivially traceable back to its row.
- **Cons:** Two buckets to create at bootstrap instead of one — handled by an idempotent ensure-buckets routine on startup.

### Option C: One bucket per channel
- **Pros:** Hard isolation per channel; per-channel quotas map to bucket quotas.
- **Cons:** S3 caps accounts at 100 buckets by default and bucket creation is a slow, globally-namespaced operation — creating one per signup does not scale and couples user registration to a storage control-plane call. Rejected.

**Recommendation:** **Option B (two buckets by content class)** — the cost is one extra `CreateBucket` call at bootstrap, and the benefit is that the two objects with genuinely different access, size, and lifecycle profiles can be governed independently from day one. The `{channel_id}/{video_id}/` key prefix keeps ownership legible directly in the key, which makes the Fase 04 channel-management work (bulk listing, deletion) a prefix scan rather than a database join against storage. Buckets are created idempotently at application bootstrap so the Compose stack is self-provisioning and no manual MinIO console step is required.

**Decision:** B (two buckets: `streamtube-videos`, `streamtube-thumbnails`; keys `videos/{channel_id}/{video_id}/source{ext}` and `thumbnails/{channel_id}/{video_id}/thumb.jpg`)

---

## TD-04: Unique Public Video Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a public identifier that is unique platform-wide, short enough to live in a shareable URL, and impossible to enumerate — `docs/project-plan.md` → "Pontos de Atenção" specifies "uma URL curta e única que nunca conflite com outro vídeo". The internal primary key stays a UUID; this decision is about the *public* handle used in `/videos/{id}` routes.

**Options:**

### Option A: Expose the UUID primary key
- **Pros:** Zero extra columns or code; uniqueness guaranteed by the PK.
- **Cons:** 36 characters of hyphenated hex is not a "URL curta". Exposing the primary key leaks internal identifiers into public URLs, coupling the public contract to the storage layer.

### Option B: Short random slug in a dedicated unique column
- An 11-character URL-safe random string (the YouTube-style handle), stored in a `public_id` column with a unique constraint; collisions are impossible in practice but structurally impossible thanks to the constraint plus a bounded retry.
- **Pros:** Short, shareable, opaque, and non-enumerable. Decouples the public URL from the primary key. The unique constraint makes "nunca conflite" a database guarantee rather than a probabilistic argument. 64 bits of entropy makes a collision negligible even at billions of videos, and the retry on constraint violation closes the remaining gap deterministically.
- **Cons:** One extra indexed column and a generation helper.

### Option C: Encoded sequential ID (`hashids` / `sqids`)
- **Pros:** Guaranteed collision-free by construction, since it is a reversible encoding of a unique counter. Compact.
- **Cons:** Requires a sequential numeric column alongside the UUID PK — a second identity source for every row. The encoding is reversible, so the sequence (and therefore the platform's total video count and creation order) leaks publicly. Adds a dependency for something `crypto` already does.

**Recommendation:** **Option B (short random slug in a unique column)** — it satisfies "curta, única, sem conflito" with a database-enforced guarantee rather than a probabilistic one, and keeps the public contract independent of the primary key. The slug is generated with Node's built-in `crypto.randomBytes(8).toString('base64url')`, which yields exactly 11 URL-safe characters and 64 bits of entropy — the same shape and entropy as `nanoid`'s default, with no dependency. Avoiding `nanoid` here is not merely a preference: `nanoid@6` is published as ESM-only (`"type": "module"`), and this project compiles with `module: nodenext` and no `"type": "module"` in `package.json`, so it emits CommonJS — importing `nanoid@6` would fail at runtime and pinning `nanoid@3` would mean adopting a deliberately outdated major. `crypto` sidesteps the incompatibility entirely.

**Decision:** B (11-char `public_id` from `crypto.randomBytes(8).toString('base64url')`, unique column + bounded retry on collision)

---

## TD-05: Video Worker Runtime Topology

**Scope:** Backend / Infrastructure

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram models the Video Worker as its own container. FFmpeg is CPU-bound and processes files for minutes at a time. The decision is how the worker process relates to the API codebase and container.

**Options:**

### Option A: Same codebase, separate entrypoint and container
- A second bootstrap file (`main.worker.ts`) starts a standalone Nest application context (`NestFactory.createApplicationContext`) loading a `WorkerModule` that registers the BullMQ processor. The Compose file runs it as a `video-worker` service from a dedicated image that also installs `ffmpeg`.
- **Pros:** Entities, config namespaces, the storage service, and repository wiring are shared verbatim — no duplicated data model, no drift between what the API writes and what the worker reads. FFmpeg's CPU load is isolated in its own container and can be scaled (replicas) independently of the API. `createApplicationContext` boots DI without an HTTP listener, so the worker carries no web surface. The heavy `ffmpeg` apt layer lives only in the worker image, keeping the API image small. Both binaries come from a single `npm run build`.
- **Cons:** Two Dockerfiles and two entrypoints in one project; a developer must remember that a change to a shared service affects both processes.

### Option B: Processor inside the API process
- Register the BullMQ `@Processor` in the API's own module graph.
- **Pros:** Simplest possible setup — one container, one entrypoint.
- **Cons:** FFmpeg saturates CPU in the same container that must stay responsive to HTTP requests, so processing a video directly degrades API latency. API and processing capacity can no longer be scaled independently. Contradicts the architecture diagram, which models the worker as a separate container — and the enunciado requires a real worker service in Compose.

### Option C: Standalone worker project (separate `package.json`)
- **Pros:** Hard separation of dependencies; the worker image carries nothing from the API.
- **Cons:** The TypeORM entities and config would have to be duplicated or extracted into a shared package — a monorepo tooling problem this project has not taken on. Entity drift between the two projects becomes a live risk the moment the video schema changes. Disproportionate for one worker.

**Recommendation:** **Option A (same codebase, separate entrypoint and container)** — it delivers the isolation the architecture calls for (own container, own image with FFmpeg, independently scalable) without paying the duplication cost of Option C. The decisive factor is the shared data model: the worker's whole job is to update the same `videos` rows the API created, so sharing the entity and repository layer eliminates an entire class of drift bugs. `createApplicationContext` is the documented NestJS pattern for non-HTTP applications and keeps the worker's DI identical to the API's.

**Decision:** A (shared codebase, `main.worker.ts` + `WorkerModule` via `createApplicationContext`, dedicated `video-worker` Compose service built from `Dockerfile.worker` with `ffmpeg` installed)

---

## TD-06: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must read duration, resolution, codec, and container metadata from the uploaded file, and cut one frame into a JPEG thumbnail. Two sub-questions: which interface to FFmpeg, and how the tool reads a file that lives in object storage and may be 10GB.

**Options — FFmpeg interface:**

### Option A: `fluent-ffmpeg`
- A chainable JavaScript wrapper around the FFmpeg CLI.
- **Pros:** Readable fluent API (`ffmpeg(input).screenshots({...})`). `ffprobe` results arrive as a parsed object. Widely used in tutorials.
- **Cons:** The package has been effectively unmaintained for years (last release 2.1.3), its types live in a separate `@types/fluent-ffmpeg` package that lags the runtime, and its callback-based API must be promisified at every call site anyway. It shells out to the same binaries the project would call directly, so the abstraction buys formatting sugar at the cost of a stale dependency in the critical path.

### Option B: Direct `child_process.execFile` of `ffprobe` / `ffmpeg`
- `ffprobe -v quiet -print_format json -show_format -show_streams <input>` returns metadata as JSON; `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale=... -f image2 <out>` writes the thumbnail.
- **Pros:** No dependency, and no dependency that can go stale in the one code path the phase exists to deliver. `execFile` (as opposed to `exec`) passes arguments as an array, so no shell is spawned and no input can be interpreted as shell syntax. The JSON output of `ffprobe` is a documented, stable contract that can be typed exactly as the project needs. Full control over timeouts and process termination — essential for a job that must be killable.
- **Cons:** The argument arrays and the `ffprobe` JSON shape must be written by hand; errors surface as exit codes and stderr text that the worker has to interpret.

**Options — how FFmpeg reads the source:**

### Option 1: Download the object to a temp file first
- **Pros:** Local file access is fully seekable, so every container format probes reliably.
- **Cons:** Requires up to 10GB of free disk in the worker container per concurrent job, plus the wall-clock and bandwidth cost of a full download — to read a header and one frame.

### Option 2: Pass a pre-signed GET URL as the FFmpeg input
- FFmpeg's HTTP protocol issues HTTP Range requests, and both MinIO and S3 honour them.
- **Pros:** FFmpeg fetches only the bytes it actually needs — the container header and the region around the target frame — instead of the whole object. A 10GB source costs a few MB of transfer and no local disk. No temp-file lifecycle to manage or clean up on crash.
- **Cons:** For MP4s written without `faststart`, the `moov` atom sits at the end of the file, so FFmpeg must additionally range-read the tail — still kilobytes, not gigabytes, but it makes probing two round-trips instead of one. Depends on the storage endpoint being reachable from the worker container (it is, over the Compose network) and on the pre-signed URL outliving the job (TTL is sized accordingly).

**Recommendation:** **Option B + Option 2** — calling the binaries directly avoids taking a dependency on an unmaintained wrapper for the phase's core capability, and `execFile` with an argument array is both safer and more controllable than a shell invocation. Reading through a pre-signed URL is the decision that keeps the phase's "no 10GB through anything that does not need it" principle consistent end to end: having removed the full file from the API's upload path in TD-02, it would be incoherent to reintroduce a full 10GB download in the worker just to read a header. Range-based probing is a standard, documented FFmpeg capability, and the `moov`-at-the-end case degrades to an extra range request rather than a failure.

**Decision:** B + 2 (direct `execFile` of `ffprobe`/`ffmpeg`, reading the source through a pre-signed GET URL with HTTP Range)

---

## TD-07: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Two distinct delivery needs share one stored object. **Streaming** must let a player start instantly and seek — HTTP Range requests answered with `206 Partial Content` — and must respect per-video access rules (a video that is not `ready`, or that is unlisted in a later phase, must not be served). **Download** hands the user the entire file, which for a 10GB video is precisely the transfer the phase's architecture works to keep off the API.

**Options:**

### Option A: Everything through the API
- The API answers both streaming and download by piping the storage object to the client.
- **Pros:** One code path; access control applies uniformly; `Range` handling is fully under the project's control and directly testable with supertest.
- **Cons:** A full 10GB download would occupy an API connection for the entire transfer — the same failure mode TD-02 rejects for uploads, arriving through the back door.

### Option B: Everything redirected to pre-signed GET URLs
- Both endpoints return `302` to a short-lived pre-signed URL; storage serves the bytes, including Range handling.
- **Pros:** Zero media bytes through the API. S3/MinIO already implement Range and `206` correctly, so seeking works for free. Best scalability, and the natural path to a CDN.
- **Cons:** The access check happens only once, at redirect time — the resulting URL is then a bearer capability valid for its whole TTL and shareable out of band, which is a poor fit for the per-request access rules the next phases add (unlisted, private, future geo/age gating). The API also loses the ability to observe playback, which Fase 05's view counting will need.

### Option C: Split by transfer profile — proxy streaming, redirect download
- `GET /videos/:public_id/stream` reads the client's `Range` header, issues the same range to storage, and pipes back `206 Partial Content` with `Content-Range` / `Accept-Ranges`. `GET /videos/:public_id/download` returns `302` to a short-lived pre-signed GET URL with a `Content-Disposition: attachment` response header override.
- **Pros:** Each transfer takes the path that fits it. Streaming moves in bounded chunks — a player requests a few MB at a time, which Node pipes with backpressure and which never resembles a 10GB transfer — so the API keeps per-request authorization and a natural hook for Fase 05's view counting. Download, the one genuinely large transfer, never touches the API. The `206` path is exercisable end-to-end by supertest, so "streaming funcionando" is a verifiable test assertion rather than a claim. Access control is enforced on every streaming request, not once per session.
- **Cons:** Two delivery mechanisms to understand and document. Streaming still consumes API bandwidth proportional to concurrent viewers — acceptable at this stage, and the documented production evolution is to front the stream endpoint with a CDN or move it to signed cookies.

**Recommendation:** **Option C (proxy streaming, redirect download)** — the two operations have genuinely different profiles and forcing them onto one mechanism sacrifices something real either way. Option A reintroduces multi-gigabyte transfers through the API; Option B gives up per-request authorization on the exact endpoint that later phases will need to gate and instrument. Splitting costs one extra endpoint and buys correct behaviour on both axes: the big transfer bypasses the API, and the controlled transfer stays controllable. Ranges are validated and clamped server-side, and a request without a `Range` header is answered `200` with the full body and `Accept-Ranges: bytes` so that clients negotiate normally.

**Decision:** C (streaming proxied with `206 Partial Content`; download via `302` to a pre-signed URL)

---

## TD-08: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload

**Context:** The enunciado fixes the shape of the cycle — `rascunho → processando → pronto/erro` — and requires it to be reflected in the database. What remains to decide is the exact state set, which transitions are legal, and what happens when FFmpeg fails on a file the user already spent an hour uploading.

**Options — state set:**

### Option A: Four states — `draft`, `processing`, `ready`, `failed`
- `draft` is written at upload initiation (the pre-cadastro) and persists for the whole upload; `processing` is set when the upload is completed and the job enqueued; the worker lands on `ready` or `failed`.
- **Pros:** Maps exactly onto the cycle the enunciado states, with no state the requirements do not ask for. Each state answers a question a client actually asks: can I still upload to it, is it being worked on, can it be played.
- **Cons:** `draft` covers both "row created, no bytes yet" and "upload in flight", so progress within the upload is not visible from the status column alone (it is observable from storage via `ListParts`).

### Option B: Five states — adds an explicit `uploading`
- **Pros:** Distinguishes an abandoned pre-cadastro from an upload in progress, which helps a future cleanup job.
- **Cons:** Introduces a state the stated cycle does not contain, and the transition into it is driven by the client rather than by a server-side event — so it is advisory and can be wrong (a client that crashes leaves a permanent `uploading`). The same cleanup question is answered more reliably by the row's `created_at` plus the multipart upload's own state in storage.

**Options — failure handling:**

### Option 1: Fail fast — one attempt, then `failed`
- **Pros:** Simple and immediate.
- **Cons:** Transient causes (storage hiccup, worker restart mid-job) are indistinguishable from real ones like a corrupt file, so a recoverable blip permanently burns a 10GB upload.

### Option 2: Bounded retry with exponential backoff, then `failed` with a recorded reason
- BullMQ retries the job 3 times with exponential backoff; `failed` is written only after the final attempt, together with an error message on the row. The source object is retained so the video can be re-processed without re-uploading.
- **Pros:** Absorbs transient infrastructure failures without user-visible impact, while still terminating on genuinely bad input. Persisting the reason makes support and debugging possible instead of guesswork. Keeping the source object means recovery never costs the user another 10GB upload. `attemptsMade` in the final handler distinguishes "failed once, retrying" from "exhausted".
- **Cons:** A permanently-bad file takes the full backoff window before reaching `failed`, so the user waits longer for a definitive error than they would under Option 1.

**Recommendation:** **Option A + Option 2** — the four-state set is exactly what the requirement states and every state is server-observable, whereas a client-driven `uploading` state would be a status column that can lie. On failure, bounded retry is the option that respects the asymmetry of this workload: the user has already paid a very expensive upload, so spending three attempts to distinguish a transient fault from a real one is cheap by comparison, and retaining the source object keeps recovery free. Recording the failure reason on the row is what makes `failed` actionable instead of a dead end.

**Decision:** A + 2 (`draft` → `processing` → `ready` | `failed`; 3 attempts with exponential backoff; failure reason persisted; source object retained)

---

## TD-09: Job Payload and Consumer Idempotency

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload

**Context:** BullMQ delivers at-least-once (TD-01), and stall recovery can re-deliver a job whose worker died mid-processing. The job payload and the consumer's re-entrancy must therefore be decided together, not left implicit.

**Options:**

### Option A: Fat payload — the job carries the video's fields (storage key, channel, title, …)
- **Pros:** The worker starts without a database read.
- **Cons:** The payload is a snapshot taken at enqueue time and can be stale by the time a retried job runs minutes later. It duplicates the data model into the queue, so every schema change must be mirrored in the message contract — and old messages sitting in Redis still carry the old shape.

### Option B: Thin payload — `{ videoId }` only, worker re-reads the row
- Job id is set to the `videoId`, so BullMQ deduplicates a double-enqueue for the same video while the job is active or waiting. The processor re-reads the video row on every attempt and returns early if it is already `ready`.
- **Pros:** The database stays the single source of truth; a retry always operates on current state rather than a stale snapshot. The message contract is one field and effectively never changes, so queued messages cannot go out of sync with the schema. `jobId = videoId` makes duplicate enqueues a no-op at the queue level, and the early-return on `ready` makes redelivery a no-op at the consumer level — the two together cover both duplication paths that at-least-once delivery creates. Writing the thumbnail to a deterministic key means a re-run overwrites rather than accumulating garbage.
- **Cons:** One extra database read per attempt — negligible against a job that runs for minutes.

**Recommendation:** **Option B (thin payload, idempotent consumer)** — at-least-once delivery makes re-execution a normal occurrence rather than an edge case, so the consumer has to be safe to run twice regardless; given that, carrying a stale copy of the row in the message buys nothing and costs contract coupling. `jobId = videoId` plus the status early-return plus deterministic thumbnail keys make every one of the three duplication paths (double enqueue, retry, stall redelivery) harmless. This is the concession that TD-01 assumed when accepting BullMQ's at-least-once semantics.

**Decision:** B (payload `{ videoId }`, `jobId = videoId`, worker re-reads state and early-returns when already `ready`, deterministic thumbnail key)

---

## TD-10: Storage Endpoint Duality (internal vs. client-reachable)

**Scope:** Backend / Infrastructure

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB; Download do vídeo pelo usuário

**Context:** Raised by `plan-validate` as a missing decision. A SigV4 pre-signed URL commits the host it was signed for into the signature, so the endpoint used at signing time must be the endpoint the recipient actually resolves. In this stack there are two different recipients with two different views of the same storage: the API and the worker reach MinIO over the Compose network as `minio:9000`, while an upload client or a browser following a download redirect resolves it from outside Docker. Signing every URL with the internal host silently produces URLs that no external client can use; signing everything with the external host breaks the worker, which cannot resolve it. TD-02, TD-03 and TD-07 all hand pre-signed URLs to someone, and none of them said which endpoint signs.

**Options:**

### Option A: Single endpoint, expose MinIO under one hostname reachable from both sides
- Requires the same name to resolve inside and outside Docker (host-file entries, or an extra DNS/proxy layer).
- **Pros:** One `S3Client`, one configuration value, no duality to reason about.
- **Cons:** Pushes an environment requirement onto every developer machine and onto CI (editing `hosts`, or adding a reverse proxy container). Fragile and invisible — the failure mode is a signature mismatch that gives no hint about DNS.

### Option B: Two configured endpoints and two `S3Client` instances
- `S3_ENDPOINT` (`http://minio:9000`) for control-plane calls and for URLs consumed by the worker; `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`) used exclusively to sign URLs handed to external clients.
- **Pros:** Each URL is signed for the host its consumer actually resolves, with no environment surgery. The split is explicit in config, so the reason a URL is signed one way or the other is readable in code. Maps cleanly to production, where the public endpoint becomes the CDN or S3 hostname and the internal one stays the VPC endpoint. `forcePathStyle: true` is set on both, which MinIO requires because it serves buckets as path segments rather than subdomains.
- **Cons:** Two client instances to construct and inject; a developer must pick the right one when adding a new signing call.

**Recommendation:** **Option B (two endpoints, two clients)** — the duality is real and environmental, so making it explicit in configuration is better than hiding it behind a DNS requirement that every machine must reproduce. Naming the clients by audience (internal vs. public) makes the choice at each call site obvious, and the same split is what a production deployment needs anyway once the public side becomes a CDN hostname.

**Decision:** B (`S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`, two `S3Client` instances, `forcePathStyle: true`)

---

## TD-11: Upload Constraint Enforcement (size, type, part count)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Raised by `plan-validate` as a missing decision. TD-02 deliberately removes the file bytes from the API's path — which also removes the API's ability to observe what was actually uploaded. The capability states a 10GB ceiling, but with direct-to-storage uploads nothing in the request path can enforce it, and a client is free to declare one size and upload another.

**Options:**

### Option A: Trust the declared size
- The client declares `size_bytes` at initiation; the API validates it against the limit and never re-checks.
- **Pros:** Zero additional storage calls.
- **Cons:** The limit becomes advisory — a client that declares 1GB and uploads 50GB is never caught, and the platform pays for the storage. The only enforcement point is the one the client controls.

### Option B: Validate at initiation and verify at completion
- `size_bytes` and `content_type` are validated at initiation (bounds + allowlist), and the derived part count is rejected if it would exceed S3's 10,000-part limit. At completion, after `CompleteMultipartUpload`, a `HeadObject` reads the object's real `ContentLength`; a mismatch aborts the upload, deletes the object, and fails the request.
- **Pros:** Catches both the honest error (a client miscomputing parts) and the dishonest one (a client lying about size), because the final check reads storage rather than the request. `HeadObject` is a metadata call — it costs one round-trip and transfers no content, so the verification does not reintroduce the data-plane cost TD-02 removed. Validating the part count up front turns S3's 10,000-part limit into a clear `400` at initiation instead of an opaque failure at completion.
- **Cons:** One extra storage round-trip per completed upload, and a failure path that must clean up both the object and the pre-registered row.

### Option C: Enforce with a bucket policy / quota
- **Pros:** Enforcement lives in the storage layer, independent of application code.
- **Cons:** S3 has no per-object size policy; MinIO quotas are per-bucket, not per-object, so they cannot express "each video ≤ 10GB". Does not address the requirement.

**Recommendation:** **Option B (validate at initiation, verify at completion)** — the declared size is useful for computing parts and for failing fast, but it is client-supplied and therefore cannot be the enforcement point; the only authoritative source is the stored object itself, and reading it costs one metadata call. Verifying at completion also lands the check exactly where the phase already has a transactional boundary (mark `processing`, enqueue), so a mismatch aborts cleanly before any job is queued. Limits: `1 ≤ size_bytes ≤ 10 GiB` (10,737,418,240), `content_type` restricted to an explicit video allowlist, part count `ceil(size_bytes / 64MiB)` rejected above 10,000.

**Decision:** B (bounds + allowlist + part-count validation at initiation; `HeadObject` size verification at completion, aborting on mismatch)

---

## TD-12: Thumbnail Frame Selection and Output Format

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Raised by `plan-validate` as a missing decision. TD-06 settles how FFmpeg is invoked but not which frame is captured, at what size, or what happens when the video is shorter than the chosen offset — all of which the worker must decide deterministically for the output to be reproducible across retries (TD-09 requires a re-run to overwrite the same key with the same content).

**Options:**

### Option A: Fixed offset (e.g. always 1 second in)
- **Pros:** Trivial, and fast to seek.
- **Cons:** For a video that opens on a fade-in, a black frame becomes the platform's thumbnail. Requires a special case for videos shorter than the offset.

### Option B: Percentage of duration (10%), clamped
- The worker already ran `ffprobe`, so duration is known; the frame is taken at `max(1s, min(0.1 × duration, duration − 0.1s))`, falling back to offset 0 for videos under one second.
- **Pros:** Scales with content — a 10-second clip and a two-hour film both get a frame from a representative point rather than from the opening. The clamp makes the behaviour total: every duration, including degenerate ones, maps to a valid offset. Deterministic, so a retry reproduces the same frame, which is what TD-09's overwrite-on-rerun assumes.
- **Cons:** Still arbitrary — it makes no claim about the frame being visually interesting.

### Option C: Scene-detection to pick a "good" frame
- **Pros:** Best visual result.
- **Cons:** Requires decoding a large portion of the video to score frames, which for a 10GB source is exactly the full-file read the phase avoids everywhere else. Non-deterministic across FFmpeg versions, breaking reproducibility on retry. Fase 04 lets the user upload a custom thumbnail anyway, which is the real answer to "the automatic one is ugly".

**Recommendation:** **Option B (10% of duration, clamped)** — it is deterministic, total over all durations, and costs one seek, while Option A's opening frame is a well-known way to ship black thumbnails and Option C's cost profile contradicts the rest of the phase. `-ss` is placed **before** `-i` so FFmpeg seeks by keyframe before decoding rather than decoding forward to the offset — the difference between a sub-second operation and minutes on a large file. Output is JPEG, scaled to width 1280 with `scale=1280:-2` so the height stays even (required by the encoder) and aspect ratio is preserved, at quality `-q:v 3`.

**Decision:** B (frame at 10% of duration clamped to `[1s, duration − 0.1s]`, `-ss` before `-i`, JPEG `scale=1280:-2` at `-q:v 3`)

---

## TD-13: Public Access Boundary for Phase 03

**Scope:** Backend

**Capability:** Reprodução via streaming; Download do vídeo pelo usuário; URL única por vídeo

**Context:** Raised by `plan-validate` as a missing decision. `docs/project-plan.md` grants anonymous users the right to watch, and Fase 02 left a global `JwtAuthGuard` that denies everything not explicitly marked `@Public()`. Fase 04 owns real visibility rules (public vs. unlisted), so Phase 03 must state a boundary that is correct now and does not have to be undone later. A second inherited constraint applies at the same place: `AuthModule` registers `ThrottlerGuard` globally at 10 requests per minute per IP, and a video player issues many Range requests during a single playback.

**Options:**

### Option A: Everything authenticated in this phase, open it up in Fase 04
- **Pros:** Strictest default; no chance of exposing an unfinished video.
- **Cons:** Contradicts a capability this phase is required to deliver — "acesso anônimo" is in the project plan, and Fase 05's player consumes exactly these endpoints. Deferring means shipping a streaming endpoint that cannot be demonstrated anonymously.

### Option B: Read endpoints public and gated by status; write endpoints authenticated and owner-scoped
- `GET /videos/:public_id`, `/stream` and `/download` are `@Public()` and serve only videos in `ready` status; the owner, when authenticated, additionally sees their own non-`ready` videos through the metadata endpoint. Upload initiation, part signing and completion require authentication and operate only on the caller's own channel. The streaming endpoint carries `@SkipThrottle()`.
- **Pros:** Delivers anonymous viewing exactly as the project plan states while keeping every mutation owner-scoped. Gating on `ready` means a draft or failed video is never publicly reachable, which is the property Fase 04's visibility rules will refine rather than replace — the status gate and a future visibility gate compose. Exempting only the streaming endpoint from throttling keeps the auth and upload endpoints protected, while preventing a player's normal Range traffic from tripping a limit designed for login attempts.
- **Cons:** `@SkipThrottle()` removes a protection from a bandwidth-heavy endpoint; the documented mitigation is that this endpoint belongs behind a CDN in production.

**Recommendation:** **Option B (public reads gated by status, authenticated owner-scoped writes)** — it is the only option that delivers the anonymous-viewing capability the phase inherits from the project plan, and the `ready` gate is a condition Fase 04 will add to rather than reverse. The throttle exemption is scoped to the single endpoint whose access pattern is structurally incompatible with a per-minute request limit, leaving every other inherited protection intact.

**Decision:** B (`@Public()` + `ready` gate on metadata/stream/download, owner-scoped authenticated writes, `@SkipThrottle()` on streaming)

---

## TD-14: Pre-signed URL Lifetimes

**Scope:** Backend

**Capability:** Upload de vídeos de até 10GB; Processamento automático; Download do vídeo pelo usuário

**Context:** Raised by `plan-validate` as a missing decision. Three distinct pre-signed URLs exist in the design (TD-02 part uploads, TD-06 the worker's probe URL, TD-07 the download redirect), each handed to a different consumer with a different time budget. A pre-signed URL is a bearer capability, so a long TTL is a security cost; but a 10GB upload that outlives its URLs fails in the most expensive way possible.

**Options:**

### Option A: One TTL for all three
- **Pros:** One constant.
- **Cons:** Whatever value is chosen is wrong for two of the three: sized for the upload it leaves download links valid for hours; sized for the download it expires mid-upload.

### Option B: Per-purpose TTLs, with re-signing available for uploads
- Part URLs 6h; worker probe URL 1h; download redirect 15min. A client resuming an interrupted upload calls the part-signing endpoint again for fresh URLs.
- **Pros:** Each TTL is derived from its consumer's actual time budget. 6h covers a 10GB upload at roughly 4 Mbps and above, and the re-signing endpoint means even a slower or long-interrupted client recovers without restarting the transfer — so the TTL does not have to be sized for the worst imaginable connection. The download link is a one-shot handoff and expires quickly, limiting how long a shared URL stays live. The worker's URL only has to outlive a job measured in minutes.
- **Cons:** Three constants instead of one, each of which must be documented.

**Recommendation:** **Option B (per-purpose TTLs with re-signing)** — the three URLs have different consumers and different risk profiles, and re-signing removes the pressure to pick a pessimistic upload TTL "just in case", which is what would otherwise push all three toward the longest value. All three stay well inside the 7-day SigV4 maximum.

**Decision:** B (part URLs 6h, worker probe URL 1h, download redirect 15min; part URLs re-signable on demand)

---

## TD-15: Representation of the Unique Video URL

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Raised by `plan-validate` as an ambiguity. TD-04 decides how the unique identifier is generated, but not what the API returns: a bare identifier the caller must assemble into a URL, or ready-made absolute URLs. The API contract shape depends on the answer, and Fase 05's player will consume whichever is chosen.

**Options:**

### Option A: Return the identifier only
- **Pros:** Smallest payload; the client owns URL construction and can point at any host.
- **Cons:** Every consumer re-implements the same string concatenation, and each one can get it wrong. "URL única por vídeo" is stated as a delivered artifact of this phase, not as a client responsibility.

### Option B: Return the identifier plus absolute URLs derived from `APP_URL`
- The video representation carries `public_id` together with `url`, `stream_url`, `download_url` and `thumbnail_url`.
- **Pros:** The deliverable is literally a URL, which is what the requirement asks for, and it is generated in exactly one place. `APP_URL` is already an established config value from Fase 01, so no new configuration is introduced. Clients — including the Fase 05 player and the e2e tests that must prove streaming works — consume a link rather than a recipe.
- **Cons:** Slightly larger payload, and the absolute URLs depend on `APP_URL` being configured correctly per environment.

**Recommendation:** **Option B (identifier plus derived absolute URLs)** — the phase's stated deliverable is "URLs únicas geradas", so generating them server-side in one place is a closer reading of the requirement than returning a fragment each client assembles. `public_id` is still exposed for clients that want to build their own routes.

**Decision:** B (`public_id` plus `url`, `stream_url`, `download_url`, `thumbnail_url` derived from `APP_URL`)

---

## Decision Summary

| Ref | Topic | Decision | New libraries |
|-----|-------|----------|---------------|
| TD-01 | Message Queue Technology | A — BullMQ + Redis via `@nestjs/bullmq` | `@nestjs/bullmq`, `bullmq`, Redis (infra) |
| TD-02 | Large File Upload Strategy | C — pre-signed S3 multipart, 64MB parts | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| TD-03 | Object Storage Layout | B — two buckets, `{channel_id}/{video_id}/` keys | MinIO (infra) |
| TD-04 | Unique Public Identifier | B — 11-char `public_id` via `crypto.randomBytes` | — (Node built-in) |
| TD-05 | Worker Runtime Topology | A — shared codebase, separate entrypoint + container | FFmpeg (infra) |
| TD-06 | Metadata & Thumbnail | B+2 — `execFile` of `ffprobe`/`ffmpeg` over pre-signed URL | — (system binaries) |
| TD-07 | Streaming & Download | C — proxied `206` streaming, redirected download | — |
| TD-08 | Status Lifecycle & Failures | A+2 — 4 states, 3 retries w/ backoff, reason persisted | — |
| TD-09 | Job Payload & Idempotency | B — thin payload, idempotent consumer | — |
| TD-10 | Storage Endpoint Duality | B — internal + public endpoints, two clients, path-style | `@aws-sdk/client-s3` |
| TD-11 | Upload Constraint Enforcement | B — validate at initiation, `HeadObject` at completion | `@aws-sdk/client-s3` |
| TD-12 | Thumbnail Frame Selection | B — 10% of duration clamped, JPEG 1280w | — |
| TD-13 | Public Access Boundary | B — public reads gated by `ready`, owner-scoped writes | — |
| TD-14 | Pre-signed URL Lifetimes | B — 6h parts / 1h probe / 15min download, re-signable | — |
| TD-15 | Unique URL Representation | B — `public_id` + derived absolute URLs | — |

_TD-10 through TD-15 were added by `plan-resolve` in response to findings recorded in `docs/phases/phase-03-videos/validation.md`._
