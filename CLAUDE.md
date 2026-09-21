# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — frontend application

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST; uploads video parts to and downloads from Object Storage through pre-signed URLs
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (Redis + BullMQ) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Video Module (Phase 03)

Video ingestion and playback live in `nestjs-project/src/videos/`, with the
background processing in `nestjs-project/src/worker/`. Full decisions in
`docs/decisions/technical-decisions-phase-03-videos.md`; the plan is in
`docs/phases/phase-03-videos/`.

**The file never passes through the API.** An upload is three cheap JSON calls
that bracket a direct transfer to object storage:

1. `POST /videos` pre-registers the video as a `draft` and opens an S3 multipart
   upload, returning the part size (64MiB) and part count.
2. `POST /videos/:publicId/upload/parts` returns pre-signed `UploadPart` URLs.
   The client `PUT`s the bytes straight to storage; re-signing is allowed, which
   is what makes an interrupted upload resumable.
   `GET /videos/:publicId/upload` lists the parts storage already holds.
3. `POST /videos/:publicId/upload/complete` assembles the object, verifies its
   real size with `HeadObject` against the declared one, moves the video to
   `processing` and enqueues the job. `DELETE /videos/:publicId/upload` cancels.

**Processing** happens in the `video-worker` container (`src/main.worker.ts` →
`WorkerModule`, started with `createApplicationContext`, no HTTP port). The
consumer reads the source through a pre-signed URL so FFmpeg range-reads only
what it needs, extracts duration and metadata with `ffprobe`, cuts a thumbnail at
10% of the duration with `ffmpeg`, and marks the video `ready`.

**Playback** is public and gated on `ready`:

- `GET /videos/:publicId` — metadata and the derived unique URLs. The owner also
  sees their own videos in any status.
- `GET /videos/:publicId/stream` — `206 Partial Content` for a `Range` request,
  `200` with `Accept-Ranges` otherwise. Exempt from the global throttler.
- `GET /videos/:publicId/download` — `302` to a short-lived pre-signed URL, so
  the large transfer bypasses the API.
- `GET /videos/:publicId/thumbnail` — the generated JPEG.

**Status lifecycle:** `draft → processing → ready | failed`. Failures retry three
times with exponential backoff; only the final attempt writes `failed`, the
reason is persisted, and the source object is kept so a video can be reprocessed
without re-uploading.

**Unique URL:** an 11-character `public_id` from
`crypto.randomBytes(8).toString('base64url')`, unique-constrained in the database
with a bounded retry on collision. `nanoid` is deliberately not used — it is
ESM-only and this project compiles to CommonJS.

**Storage layout:** two buckets, `streamtube-videos`
(`videos/{channel_id}/{video_id}/source{ext}`) and `streamtube-thumbnails`
(`thumbnails/{channel_id}/{video_id}/thumb.jpg`), created idempotently at
bootstrap. Two `S3Client` instances exist on purpose: a SigV4 signature binds the
host, so URLs for the worker are signed with the internal endpoint and URLs for
external clients with the public one.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.