# Implementation plan: Optional video quality gate

> **Goal:** Check encoded video quality with SSIM before replacing the source, behind an opt-in queue setting.

**Design:** `docs/superpowers/specs/2026-10-19-shrinkarr-quality-gate-design.md`

## Tasks

1. **Config and UI** — add disabled-by-default queue settings, bounds and defaults; expose a toggle and SSIM threshold under Settings; add schema tests.
2. **Metric runner** — implement a cancellable low-priority FFmpeg SSIM comparison; parse the final score strictly; fail closed on absent/malformed metrics; test the args/parser/error paths.
3. **Replacement guard** — call the gate after current output verification and before atomic replacement for video re-encodes only; preserve the source and clean the temporary output on failure; test pass/reject/cancel paths.
4. **Docs and verification** — document cost/limits, run build/lint/full tests and a tiny local FFmpeg comparison, then request read-only review.

## Guardrails

- Keep the gate opt-in for existing and new installations.
- Never replace the original when enabled but unable to measure quality.
- Do not run for audio-only outputs or remuxes that copy video.
- Do not change the existing health-check or size-reduction semantics.

## Completion record

- Added a disabled-by-default queue setting and Settings controls for the minimum SSIM threshold.
- Added a cancellable FFmpeg comparison that scales the output to source dimensions, verifies video-stream duration coverage within two frames or 100 ms, and fails closed when duration or score data is absent or malformed.
- The queue preserves the original and cleans the temporary output on threshold failure or cancellation; audio-only jobs and video remuxes are skipped.
- Added schema, parser, worker replacement-safety, and cancellation regression tests.
- Local FFmpeg smoke test passed against a 320×240 source and 160×120 re-encode (SSIM 0.915367).
- Review follow-ups added cancellation checks around asynchronous verification/stat operations and anchored SSIM parsing to actual SSIM summary lines.
- Final read-only review found no remaining issues.
- Final verification passed: build, lint, 43 server test files/406 tests, 3 web tests, and local FFmpeg smoke test (SSIM 0.915367 after scaling 160×120 output to the 320×240 source dimensions).
