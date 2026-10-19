# Shrinkarr Health Check Reliability Design

## Goal

Health checks must only label media corrupt when FFmpeg produces evidence of corrupt input data. Files that are changing, inaccessible, unsupported by the installed FFmpeg, or blocked by an environment problem must remain distinguishable as unverifiable. Health checks must never mutate media.

## Existing behavior

- Quick checks decode start, middle, and end samples; short media is decoded completely.
- Thorough checks decode the complete file.
- Health jobs run in their own queue pool and health history is already recorded.
- Unlike transcode jobs, health jobs do not use the file stability guard.
- `probeFile` failures and most `runHealthCheck` failures currently set `health_status = corrupt`.
- The database stores a free-form health status, while the API and UI currently expose `unchecked`, `healthy`, and `corrupt`.

## Requirements

1. A health job must wait for the same stability and lock conditions as a transcode before probing or decoding. An unstable or missing file is unverifiable, not corrupt.
2. Health verdicts are `unchecked`, `healthy`, `corrupt`, or `unverifiable`. Probe, process, permission, missing dependency, unsupported decoder, cancellation, and stability failures must never become corrupt verdicts.
3. Decoder/demuxer errors that identify damaged input can mark a file corrupt. Unclassified FFmpeg failures default to unverifiable.
4. Store a concise reason and timestamp for healthy, corrupt, and unverifiable results. Existing corrupt/healthy rows and history survive upgrades.
5. Library health checks include unchecked and unverifiable files by default; an explicit recheck includes all non-ignored files. Confirmed corrupt files remain excluded from automatic optimization.
6. The UI distinguishes corrupt from unverifiable, displays the reason, and lets users recheck unverifiable files. Thorough selected-file checks and quick library checks continue to work.
7. History reports confirmed corrupt results separately from other failed health jobs.
8. Quick and thorough decode sampling behavior remains unchanged. Health checks do not write or replace media.

## Non-goals

- Automatic recurring health-check schedules.
- Remote workers or external ingest integrations.
- Hashing or bit-for-bit media validation.
- Treating a successful decode sample as proof that every part of a long file is healthy.

## Acceptance

- Tests cover stable-file gating, corruption classification, unverifiable probe/spawn/runtime failures, queue selection and history summaries.
- Full server and web build, tests, and lint pass.
