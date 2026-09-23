# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shrinkarr is a self-hosted media library optimizer: it scans video libraries, decides which files are worth re-encoding (via ffprobe analysis + preset rules), transcodes them with hardware acceleration when available, verifies the output, and atomically replaces the original file in place. It's an npm workspaces monorepo with two packages: `server` (Fastify API + CLI, TypeScript/Node ESM) and `web` (React + Vite UI).

## Commands

Run from the repo root unless noted.

```bash
npm install                     # install all workspace deps
npm run build                   # builds server then web (tsc + vite build)
npm test                        # runs server test suite only (vitest run) — web has no tests
npm run dev:server              # tsc --watch for the server package

# Server-specific (from server/, or via -w server)
npm test -w server -- --watch   # vitest watch mode
npx vitest run test/policy.test.ts -w server   # run a single test file (cd into server/ first, or use -w)

# Web-specific
npm run dev -w web              # Vite dev server
npm run build -w web            # tsc -b && vite build

# CLI (after build)
node server/dist/cli/index.js start --port 3000   # API server + queue processor together
node server/dist/cli/index.js serve --port 3000   # API server only
node server/dist/cli/index.js run                 # queue processor only (foreground daemon)
node server/dist/cli/index.js scan                # scan libraries, report/enqueue candidates
```

Server tests live in `server/test/*.test.ts` (vitest). `server/vitest.config.ts` marks `node:sqlite` as external — the server uses Node's built-in `node:sqlite`, not a driver package, so no DB setup is needed for tests beyond Node itself.

The `--config <path>` CLI flag (or `SHRINKARR_CONFIG` env var) points at a YAML config file; defaults to `config/config.yaml`. `config/config.example.yaml` is the annotated template.

## Architecture

### Config-driven, not database-driven for settings
All user-facing settings (libraries, presets, integrations, queue behavior, watcher behavior) live in one YAML file validated by a single Zod schema tree (`server/src/config/schema.ts`). `server/src/config/loader.ts` reads/writes it; `server/src/config/index.ts` exposes `getConfig()`. The SQLite DB (`data/shrinkarr.db`, opened in `server/src/db/client.ts`) only stores derived/runtime state: discovered file metadata (`filesRepo`) and transcode job records (`jobsRepo`). When adding a new configurable option, it goes in the Zod schema + YAML, not a DB table.

### Request/job flow
1. **Scan** (`scanner/walk.ts` walks the filesystem, `scanner/policy.ts::decide()` applies a preset's rules against an `ffprobe` result to decide whether a file should be transcoded and estimates savings) populates `filesRepo` with per-file metadata and a `needsTranscode`/`recommendedAction` verdict.
2. **Watcher** (`scanner/watcher.ts`, a `LibraryWatcher` class) runs the scan on an interval per library, with a "settle guard" that tracks file size across polls so in-progress downloads aren't probed mid-copy. If `autoOptimize` is on for a library (or globally), files that need transcoding are auto-enqueued as jobs.
3. **Queue processor** (`queue/processor.ts::startProcessor`) polls `jobsRepo` for pending jobs up to `queue.concurrency` and hands each to `queue/worker.ts::processJob`.
4. **Worker** does: re-probe source → `transcode/runner.ts::runTranscodeWithFallback` (tries the preset's chosen hwaccel encoder, falls back through the encoder chain / to CPU on failure, reports progress via callback) → write to a temp file (`<name><queue.tempSuffix><ext>`, same directory as original) → `transcode/verify.ts::verifyOutput` (duration/size/stream sanity checks against the original probe) → `queue/atomicReplace.ts::replaceOriginal` (rename original to `.shrinkarr.bak`, rename temp into place, then delete or move the backup to `queue.recycleBinPath`) → update `filesRepo` with the new file's stats → `queue/postJobHooks.ts` notifies configured integrations (Jellyfin/Emby/Plex/Sonarr/Radarr).

`atomicReplace.ts` refuses to replace a file with a temp file from a different directory — this is a deliberate safety check against cross-volume rename issues, not incidental.

### Hardware acceleration
`transcode/hardware.ts::detectHardware()` runs at server startup (non-blocking) to probe available encoders (AMF/QSV/NVENC/VAAPI/VideoToolbox/CPU). `transcode/ffmpegArgs.ts` builds the actual ffmpeg argument list per preset + detected hardware; `transcode/simulator.ts` runs a short sample encode to estimate real-world savings before committing a library to a full job run (exposed via the `simulate` CLI-adjacent API route).

### API server wiring
`server/src/api/server.ts::createServer()` builds a single `AppContext` (config, configPath, filesRepo, jobsRepo, watcher) decorated onto the Fastify instance (`fastify.ctx`, typed in `api/context.ts`) and shared across all route modules in `api/routes/`. The queue processor is started separately (see `cli/startCommand.ts` vs `cli/runCommand.ts`) — `serve` runs the API without the processor, `run` runs the processor without the API, `start` runs both in one process. In production the server also serves the built `web/dist` static assets directly (see the `candidateDirs` search in `server.ts`) and falls back to a "build not found" placeholder page if it's missing.

### Web UI
Plain React + react-router (no state management library). `web/src/api/client.ts` is the sole HTTP client to the Fastify API. Pages under `web/src/pages/` correspond roughly 1:1 to API route modules (Library ↔ libraries.ts, Queue ↔ jobs.ts, HardwareAndPresets ↔ hardware.ts/presets.ts, Settings ↔ config.ts).

<!-- antislop:start -->
## antislop
For UI, copy, people, mobile layout, or code comments work, read `antislop.md` (core) and then the skill for the task:
- UI / visual: `skills/antislop-ui/SKILL.md`
- Copy & text: `skills/antislop-copywriting/SKILL.md`
- People: `skills/antislop-human/SKILL.md`
- Mobile / responsive: `skills/antislop-layoutmobile/SKILL.md`
- Code comments: `skills/antislop-code/SKILL.md`
Before starting, ask the user when antislop applies: during the work, or after it is done.
<!-- antislop:end -->
