# Shrinkarr remote workers design

## Goal

Allow separate Shrinkarr worker processes to perform FFmpeg encoding on mapped media mounts while the coordinator remains the sole owner of queue state, verification, and original-file replacement.

## Protocol and ownership

- Workers pull work over authenticated HTTPS using individual bearer tokens. The admin creates a named worker token in Settings; the token is shown once and stored hashed by the coordinator.
- A worker reports its ID, FFmpeg version, video/audio support, available encoder families, mapped library IDs, and heartbeat. Health status shows online/stale/offline based on heartbeat age.
- The coordinator atomically leases one compatible queued transcode to one worker with a random lease ID and expiry. The existing local queue remains the fallback whenever no compatible worker claims a job.
- A lease includes only the selected job, preset, library-relative media path, and a unique attempt output name. Worker paths are resolved under an explicit per-library mount map; absolute paths and traversal are rejected.
- The worker runs the existing FFmpeg argument/fallback path and writes only a temporary file in the mapped media library. It cannot update queue state, mark files healthy/corrupt, choose a different preset, or replace the source.
- Completion is accepted only for the current worker/lease. The coordinator verifies that the source is still stable, verifies the temp output, runs the configured quality gate, atomically replaces the original, updates metadata/history, and fires existing post-job hooks.
- A failed or expired lease returns the job to pending for local fallback. Stale workers may leave only attempt-specific temp files; their late completions are rejected and cleaned up when safe.
- Cancellation revokes the lease; workers poll heartbeat/cancel state and terminate FFmpeg. Health jobs always remain on the coordinator until a separate remote-health design exists.

## Limits and safety

- Remote execution requires a shared filesystem mounted on both coordinator and worker, with identical file contents and writable adjacent temp files. The worker's configured map must cover the library; unmapped files remain local.
- Jobs using coordinator-local `tempDirectory` are not assigned remotely.
- Remote workers are trusted compute agents and receive a specific media path and preset. The API does not send admin session credentials or the full config.
- Tokens can be revoked individually. Tokens are never returned after initial creation and are redacted from logs/config responses.
- Local workers continue to process ineligible jobs. Atomic claims prevent local and remote workers from encoding the same job simultaneously.

## Acceptance

- Worker token create/list/revoke paths never expose stored token values; remote routes reject invalid/revoked tokens.
- Worker path maps are library scoped, normalized, and reject traversal or unmapped IDs.
- Job claim is atomic and lease-bound; local and remote claims cannot duplicate the same job.
- Heartbeat and capability reports control eligibility; expired leases return safely to the local queue; late completions cannot mutate completed/reassigned jobs.
- A remote output cannot replace the source without coordinator-side stability, structural, size, optional quality, and atomic-replacement checks.
- Unit/route tests cover auth, map guards, lease ownership, fallback, cancellation, and completion; full build/lint/test passes.
