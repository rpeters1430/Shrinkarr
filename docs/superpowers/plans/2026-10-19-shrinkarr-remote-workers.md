# Implementation plan: Remote workers

> **Goal:** Add pull-based FFmpeg workers that use mapped shared media paths while the coordinator owns queue state and file replacement.

**Design:** `docs/superpowers/specs/2026-10-19-shrinkarr-remote-workers-design.md`

## Tasks

1. **Worker registry and auth** — add additive DB storage for hashed one-time tokens, named workers, heartbeat/capabilities, and route tests for create/list/revoke/auth.
2. **Path mapping and worker CLI** — add `shrinkarr worker` arguments for coordinator URL, token, and library mount maps; normalize mappings, resolve paths safely, and report capabilities/heartbeat.
3. **Atomic leases and local fallback** — extend job persistence with lease ownership/expiry; make local claims atomic; add pull, heartbeat/cancel, completion and failure endpoints; reclaim expired leases.
4. **Remote encoding and coordinator finalization** — execute the selected preset to an attempt-specific temp file using existing FFmpeg fallback logic; have the coordinator validate and atomically replace, update DB/history/hooks, and reject late/stale completions.
5. **Settings UI and documentation** — add token management and worker status, document shared-mount setup and limitations, and expose relevant API types.
6. **Full verification and review** — add failure-path coverage, run full build/lint/tests and a local two-process protocol smoke test, then request read-only review.

## Guardrails

- Never send or accept admin session tokens for worker authentication.
- Never give workers authority to select queue entries, presets, output destinations outside a mapped library, or replace originals.
- Every attempt writes a unique temp filename and is tied to a current lease ID.
- If routing or validation fails, preserve the original and leave the job retryable by the coordinator's local queue.
- Keep health-check jobs local and avoid remote assignment when the required media mount or execution capability is missing.
