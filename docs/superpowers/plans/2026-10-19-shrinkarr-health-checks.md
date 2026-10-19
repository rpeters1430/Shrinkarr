# Shrinkarr Health Check Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure health checks only report confirmed media damage as corruption, wait for files to settle, and expose unverifiable outcomes clearly.

**Architecture:** Extend the persisted health state with `unverifiable`, add conservative FFmpeg error classification, and gate health workers on the shared stability check. Preserve existing health history and enrich its corrupt counter to count only confirmed-corruption entries. Update library UI/API types and tests.

**Tech Stack:** TypeScript, Fastify, SQLite, React, Vitest.

---

### Task 1: Define health verdict classification

**Files:** `server/src/media/healthCheck.ts`, `server/test/healthAndHistory.test.ts`

- [ ] Add test cases for known decoder/demux corruption, non-monotonic null output noise, and environmental/unsupported-codec failures.
- [ ] Replace the boolean health result with `healthy | corrupt | unverifiable`; default unrecognized FFmpeg failures to unverifiable.
- [ ] Keep quick sampling and thorough decode semantics unchanged.

### Task 2: Persist and expose unverifiable state

**Files:** `server/src/db/filesRepo.ts`, `server/src/db/migrations.ts`, `server/src/db/historyRepo.ts`, `server/test/healthAndHistory.test.ts`

- [ ] Add `unverifiable` to the health status type and verify older status values are preserved by migration.
- [ ] Make default library health checks include unchecked and unverifiable records.
- [ ] Count only health history failures prefixed as confirmed corruption in `corruptFound`.
- [ ] Add repository and history tests.

### Task 3: Guard health workers against unstable files

**Files:** `server/src/queue/worker.ts`, `server/test/healthAndHistory.test.ts`

- [ ] Reuse configured stability delay and lock behavior before health probe/decode.
- [ ] Mark unstable/missing inputs unverifiable and finish the health job without invoking FFmpeg.
- [ ] Mark probe failures and runtime/tool failures unverifiable; only classified input damage is corrupt.
- [ ] Preserve cancellation semantics and history/log details.

### Task 4: Surface verdicts in the API and UI

**Files:** `web/src/api/client.ts`, `web/src/pages/Library.tsx`, related components/styles

- [ ] Expose unverifiable status and reason in library rows and a separate tab/count.
- [ ] Provide a recheck action for unverifiable entries and distinguish it from confirmed corruption.
- [ ] Keep confirmed corruption excluded from automatic optimize flows.

### Task 5: Verify and document

**Files:** `README.md`, `docs/superpowers/specs/2026-10-19-shrinkarr-health-checks-design.md`

- [ ] Document what quick and thorough checks prove and why a result may be unverifiable.
- [ ] Run server tests, web build, root build, and lint.
- [ ] Review migration compatibility and inspect the final diff.

## Completion record

- [x] Health verdict classification defaults uncertain FFmpeg outcomes to unverifiable.
- [x] Health worker waits for file stability and records missing/probe/runtime failures as unverifiable.
- [x] Default library checks include unverifiable files; explicit recheck still covers all non-ignored files.
- [x] UI separates unverifiable status and displays the reason; corrupt remains gated from optimization.
- [x] History corrupt count now counts confirmed `Corrupt:` outcomes only.
- [x] README and tests updated; full build, lint, and test suite pass.

Final review follow-ups: stability polling now responds immediately to job cancellation, cancelled health checks persist their running logs, and outside-library preview rows include a zero savings value for the UI. Regression tests cover each path. The reviewer found no remaining concrete issues; focused and full validation passed.
