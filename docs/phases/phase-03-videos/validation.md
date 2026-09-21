---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
rounds: 2
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-21T04:48:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T04:46:00-03:00"
issues: []
advisories:
  - "Streaming is proxied through the API (TD-07). Bandwidth scales with concurrent viewers; the documented production evolution is to front the stream endpoint with a CDN. Not a blocker for this phase."
  - "@SkipThrottle() on the streaming endpoint (TD-13) removes rate limiting from a bandwidth-heavy route. Acceptable while the endpoint is not yet CDN-fronted; revisit in the production phase (Fase 07)."
---

# phase-03-videos — Validation

Two rounds were run. Round 1 found 14 issues against `context.md` and
`technical-decisions-phase-03-videos.md`; `plan-resolve` addressed all of them by
adding TD-10 through TD-15 to the decisions document and by pinning the remaining
items to concrete Step Implementations in the plan. Round 2 found no new issues.

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ `next-frontend/` is explicitly out of scope for this phase; the upload UI and the
player are recorded as deferred capabilities in `context.md`.

## Resolved Issues

### MD-01 — Pre-signed URLs had no defined signing endpoint

**Severity:** blocker · **Round:** 1

TD-02, TD-03 and TD-07 each hand a pre-signed URL to a consumer, but none stated
which storage endpoint is used at signing time. A SigV4 signature commits the host
it was signed for, and this stack has two views of the same MinIO: `minio:9000` on
the Compose network (API, worker) and an externally resolvable host (upload client,
download redirect). Signing everything internally produces URLs no external client
can use; signing everything externally breaks the worker.

**Resolution:** TD-10 added — `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` with two
`S3Client` instances, `forcePathStyle: true` on both. Implemented in SI-03.3.

---

### MD-02 — No enforcement point for the 10GB limit

**Severity:** blocker · **Round:** 1

TD-02 removes the file bytes from the API's path, which also removes the API's
ability to observe what was actually uploaded. The capability states a 10GB
ceiling, but nothing in the design enforced it, and a client could declare one
size and upload another.

**Resolution:** TD-11 added — bounds and content-type allowlist validated at
initiation, part count derived and capped at 10,000, and the stored object's real
`ContentLength` verified with `HeadObject` at completion, aborting on mismatch.
Implemented in SI-03.5 and SI-03.7.

---

### MD-03 — Thumbnail frame selection undefined

**Severity:** major · **Round:** 1

TD-06 settled how FFmpeg is invoked but not which frame is captured, at what size
or format, nor the behaviour for videos shorter than the chosen offset. TD-09
requires a retry to reproduce the same output at the same key, which is impossible
without a deterministic rule.

**Resolution:** TD-12 added — frame at 10% of duration clamped to
`[1s, duration − 0.1s]`, `-ss` before `-i`, JPEG `scale=1280:-2` at `-q:v 3`.
Implemented in SI-03.9.

---

### MD-04 — Anonymous access boundary unstated

**Severity:** blocker · **Round:** 1

`docs/project-plan.md` grants anonymous users the right to watch, while Fase 02
left a global `JwtAuthGuard` that denies anything not marked `@Public()`. Without
a stated boundary the Authorization Matrix could not be written, and the phase
risked shipping a streaming endpoint that cannot be exercised anonymously.

**Resolution:** TD-13 added — metadata, streaming and download are `@Public()` and
gated on `ready` status; upload initiation, part signing and completion are
authenticated and owner-scoped. Implemented in SI-03.5, SI-03.10 and SI-03.11.

---

### MD-05 — Pre-signed URL lifetimes unspecified

**Severity:** major · **Round:** 1

Three distinct pre-signed URLs exist (part upload, worker probe, download
redirect), each with a different consumer and time budget. A 10GB upload can
outlive a short TTL, while a long-lived download link is a bearer capability that
stays shareable.

**Resolution:** TD-14 added — 6h for part URLs (re-signable on demand), 1h for the
worker probe URL, 15min for the download redirect. Implemented in SI-03.3,
SI-03.6 and SI-03.11.

---

### AMB-01 — "URL única por vídeo" left the response shape undefined

**Severity:** minor · **Round:** 1

TD-04 decided how the identifier is generated but not whether the API returns a
bare identifier or ready-made absolute URLs. The API Contracts section could not
be written without it, and Fase 05's player consumes whichever is chosen.

**Resolution:** TD-15 added — the video representation carries `public_id` plus
`url`, `stream_url`, `download_url` and `thumbnail_url`, derived from the existing
`APP_URL` config. Implemented in SI-03.4 and SI-03.10.

---

### DG-01 — Global ThrottlerGuard collides with streaming

**Severity:** blocker · **Round:** 1

`AuthModule` registers `ThrottlerGuard` as a global `APP_GUARD` at 10 requests per
minute per IP. A video player issues many Range requests during a single playback,
so the streaming endpoint would begin returning 429 mid-video. No decision
addressed the exemption.

**Resolution:** folded into TD-13 — `@SkipThrottle()` scoped to the streaming
endpoint only, with every other inherited protection left intact. Recorded as an
advisory for the production phase. Implemented in SI-03.10.

---

### DG-02 — `migrations.integration-spec.ts` must be extended, and leaks enum types

**Severity:** blocker · **Round:** 1

The inherited spec enumerates managed tables and migration classes explicitly, so
Phase 03's third migration and `videos` table must be added to it. More seriously,
its `beforeAll` drops tables but not PostgreSQL enum types: the suite already fails
in a full run because an earlier `synchronize: true` spec creates
`verification_tokens_type_enum` before the migration's `CREATE TYPE` runs. Phase 03
introduces `videos_status_enum` and would reproduce the same defect.

**Resolution:** pinned to SI-03.1 — the spec's cleanup drops managed enum types as
well as managed tables, and both the new migration and the `videos` table are
registered in its lists. Verified against the existing failure before the phase's
own work begins.

---

### DG-03 — `cleanAllTables` does not know about `videos`

**Severity:** major · **Round:** 1

The shared e2e helper `src/test/create-test-data-source.ts` deletes a fixed list of
tables in foreign-key order. Once `videos` references `channels`, deleting
`channels` without first deleting `videos` raises a foreign-key violation in every
e2e suite.

**Resolution:** pinned to SI-03.4 — `videos` added to the helper ahead of
`channels`.

---

### DG-04 — `npm run test:e2e` lacks `--runInBand`

**Severity:** blocker · **Round:** 1

`nestjs-project/CLAUDE.md` states the e2e script is "already configured" with
`--runInBand`, but `package.json` defines it as a plain `jest --config`. The three
existing e2e suites share one database; run in parallel they corrupt each other.
Phase 03 adds a fourth suite, making the collision certain. Confirmed empirically:
the e2e suite fails 47/52 without the flag and passes 52/52 with it.

**Resolution:** pinned to SI-03.1 — `--runInBand` added to the `test:e2e` script,
aligning the code with the documented behaviour.

---

### DG-05 — No worker image, and FFmpeg version unpinned

**Severity:** major · **Round:** 1

TD-05 states the worker container carries FFmpeg, but no Dockerfile existed for it
and no version was pinned. The API image must not grow the FFmpeg layer.

**Resolution:** pinned to SI-03.2 (`Dockerfile.worker` derived from the same Node
base, installing `ffmpeg` from the Debian repository) with the resolved version
recorded in `library-refs.md`.

---

### INC-01 — Inherited lint baseline fails the Definition of Done

**Severity:** blocker · **Round:** 1

`npm run lint` exits 1 with 150 errors across eleven files, ten of which are Fase
01/02 specs (`no-unsafe-member-access`, `no-unsafe-assignment`, `unbound-method`,
`no-unsafe-return`, `require-await`). The Definition of Done in the root
`CLAUDE.md` requires lint to pass, so the phase cannot be declared done while the
inherited baseline is red.

**Resolution:** pinned to SI-03.14 as a dedicated, separately-committed step so the
pre-existing debt does not mix with Phase 03 feature commits, per the
`CLAUDE.md` → "Scope Limits" rule.

---

### INC-02 — Committed `openapi.json` drifts once endpoints are added

**Severity:** minor · **Round:** 1

`nestjs-project/openapi.json` is a committed artifact and is mirrored into
`next-frontend/openapi.json` by `scripts/sync-openapi.sh`. Adding video endpoints
without regenerating leaves the repository's published API contract inconsistent
with the code. (`src/metadata.ts` is a hand-written stub, not generated, so it
needs no regeneration.)

**Resolution:** pinned to SI-03.13 — regenerate via `npm run openapi:export` and
mirror with `scripts/sync-openapi.sh` as part of phase closure.

---

### UQ-01 — Redis version not pinned

**Severity:** minor · **Round:** 1

TD-01 selects Redis without pinning a version, while BullMQ 6 requires a minimum
Redis version for the commands it uses.

**Resolution:** resolved in `library-refs.md` — the Compose service pins a Redis
image tag verified against BullMQ 6's documented minimum.
