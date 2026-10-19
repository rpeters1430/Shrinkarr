# Implementation Plan: Library Rule Preview

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This plan has not been executed; begin only after user review.

**Goal:** Add ordered, per-library optimization rules, a read-only paginated preview, and an explicit queue action that uses the same rule resolver as scanning.

**Architecture:** Keep rule matching pure and shared across full scans, watcher scans, preview, and queueing. Persist only ffprobe metadata used by policy but absent from the current file row in a nullable JSON column, then refresh legacy rows when scanned. Keep the current library preset as the fallback, and preserve existing job/path guards and automatic-optimization opt-in behavior.

**Stack:** TypeScript, Zod, Fastify, SQLite, React, Vite, Vitest.

**Approved design:** `docs/superpowers/specs/2026-10-19-shrinkarr-rule-preview-design.md`

## Guardrails

- Do not evaluate user-provided JavaScript, shell, or arbitrary expressions. Rules are typed data with the operators and fields in the approved spec.
- Preview reads indexed rows only. It must not probe files, mutate state, or enqueue jobs.
- Queue requests re-resolve using saved rules and presets on the server; never trust preview decisions supplied by the browser.
- Files with missing policy metadata are marked `needsScan` in preview and are skipped by rule-based queueing until scanned. Scans re-probe them even if size and mtime are unchanged.
- Existing manual job guards, active-job deduplication, ignored/corrupt-file eligibility, and auto-optimize opt-in remain in force.
- Queue only actionable Optimize decisions; Keep, no-match fallback when fallback policy says no optimization, stale/missing rows, and files needing a scan are not queued.
- Treat `mediaKind` in supplemental metadata as authoritative for indexed rule preview. Write it on every successful probe and refresh it on worker output upserts.

## Task 1: Define rule schemas and persist policy metadata

**Files:**
- Modify: `server/src/config/schema.ts`
- Modify: `server/src/media/types.ts`
- Modify: `server/src/db/schema.sql`
- Modify: `server/src/db/migrations.ts`
- Modify: `server/src/db/filesRepo.ts`
- Tests: `server/test/configSchema.test.ts`, `server/test/filesRepo.test.ts` (or the repository's existing DB test module)

1. Add failing schema tests for:
   - ordered optional rules on a library, with unique rule IDs;
   - enabled flag, typed conditions, and either `preset` or `keep` action;
   - operators/values constrained by field type;
   - invalid or duplicate rule IDs, empty conditions, bad ranges, unsupported values;
   - preset references and media-kind compatibility validated against the full ConfigSchema.
2. Add a typed policy-metadata structure for the missing policy inputs: `mediaKind`, fps, color transfer, lossless-audio status, audio tracks, and subtitle tracks. Keep it separate from file columns already present.
3. Add an optional `rules` array to the library schema. Validate cross references in ConfigSchema and repeat preset/media-kind validation at library update boundaries using the saved preset catalog.
4. Add a nullable `policy_metadata` JSON column and an additive migration. Bump the migration version without changing existing health columns or history.
5. Extend FileRecord/NewFileRecord and repository row conversion/UPSERT to parse and persist policy metadata. Ensure health reset behavior is still based only on size/mtime change.
6. Run focused schema and repository tests.

**Acceptance:** old databases migrate with null metadata and retain existing health data; malformed rules are rejected; round-trip repository tests preserve metadata.

## Task 2: Implement the pure resolver and indexed probe adapter

**Files:**
- Create: `server/src/scanner/rules.ts`
- Modify: `server/src/scanner/policy.ts` only if a small shared helper is needed
- Modify: `server/src/media/types.ts`
- Tests: `server/test/rules.test.ts`

1. Write failing tests for rule order, disabled rules, AND condition semantics, each supported operator, inclusive `between`, glob normalization/case-insensitivity for relative paths, absent metadata as non-match, first enabled match, Keep, compatible preset action, and fallback to existing library policy.
2. Implement a pure matcher over typed values. Normalize relative paths to forward slashes; use the existing fast-glob dependency's matching semantics without allowing paths outside the library root.
3. Return a structured resolution containing selected action, selected preset when applicable, matched rule ID/name, human-readable reason, whether it is fallback, and the existing policy decision where relevant.
4. Adapt FileRecord plus policy metadata into the same MediaProbe shape used by the scanner policy. If policy metadata is null, return `needsScan` without attempting an optimization decision.
5. Require every preset-selecting rule to contain a compatible mediaKind condition at config validation, and defensively reject an incompatible selection in resolver tests.

**Acceptance:** resolver tests are deterministic and filesystem-free; no I/O or queue side effects exist in the resolver.

## Task 3: Route full scans, watcher scans, and library optimization through the resolver

**Files:**
- Modify: `server/src/scanner/scan.ts`
- Modify: `server/src/scanner/coordinator.ts`
- Modify: `server/src/cli/scanCommand.ts`
- Modify: watcher incremental scan module under `server/src/scanner/`
- Modify: `server/src/worker/worker.ts`
- Modify: `server/src/api/routes/libraries.ts`
- Tests: `server/test/scan.test.ts`, `server/test/watcherScan.test.ts`, route tests as needed

1. Add failing tests proving scanner and watcher resolve the same ordered rules, queue the selected preset, honor Keep, and preserve fallback behavior when no rule matches.
2. Persist supplemental probe metadata on scan inserts and updates. When cached rows have null policy metadata, re-probe even when size and mtime are unchanged; update those rows without resetting their health state.
3. Update incremental watcher logic to refresh missing metadata and use the same rule resolver. Preserve its stability checks and avoid queuing a file if metadata could not be read.
4. Update worker output upserts to store fresh policy metadata and mediaKind so subsequent preview and scans see correct values.
5. Route library auto-optimize through the resolver, honoring current `autoOptimize`, min-size, ignore/health eligibility, active-job dedupe, and selected preset per file.
6. Keep CLI scan behavior aligned by loading the full config/preset catalog and passing rules through the shared scan path.
7. Run scan, watcher, worker, and library route tests.

**Acceptance:** all four entry points (full scan, watcher, preview later, queue later) call the same resolver; a legacy null-metadata row is re-probed once and not misclassified as corrupt if the probe fails.

## Task 4: Add bounded read-only preview and explicit queue APIs

**Files:**
- Modify: `server/src/db/filesRepo.ts`
- Modify: `server/src/api/routes/libraries.ts`
- Modify: `server/src/api/server.ts`
- Tests: `server/test/rulePreviewRoute.test.ts`, `server/test/jobsRoute.test.ts`

1. Add failing route tests for:
   - preview using submitted draft rules without persisting them;
   - paginated preview with a bounded limit (default 50, maximum 200) and stable ordering;
   - summary counts for Optimize, Keep, fallback, no match, and needsScan;
   - no ffprobe, DB writes, health writes, or job creation during preview;
   - queue endpoint resolving against saved rules, not client-supplied decisions;
   - rejection of unknown/out-of-library paths, invalid rules, missing presets, Keep/no-op decisions, needsScan rows, ignored/corrupt files, and active duplicates.
2. Add a repository query for one library page and total count, stable by normalized path then ID. Validate/clamp pagination at the API boundary.
3. Add a read-only `POST /api/libraries/:id/rules/preview` accepting draft rules plus offset/limit. Reuse resolver; return page decisions and overall summary without writing.
4. Add an explicit `POST /api/libraries/:id/rules/queue` accepting selected file IDs (or paths, consistent with current API conventions). Look up each row in that library and recompute from saved library rules and presets; enqueue each eligible Optimize result with its resolved preset.
5. Apply the same existing job safeguards: path containment, selected preset existence/type, ignored/corrupt eligibility, and active-job dedupe. Return per-file queued/skipped reasons.
6. Ensure existing optimize endpoint uses saved resolver rules from Task 3; do not persist draft preview rules until the library settings save endpoint is used.
7. Run the new route tests and existing job/library route suites.

**Acceptance:** preview is side-effect free and bounded; explicit queue uses current saved configuration and has no trust in preview payload decisions.

## Task 5: Add the library rules and preview UI

**Files:**
- Modify: `web/src/api/client.ts`
- Modify: `web/src/pages/Library.tsx`
- Create: `web/src/components/LibraryRulesPanel.tsx`
- Create: `web/src/ruleValidation.ts`
- Modify: `web/src/styles.css`
- Modify: `web/package.json` and root `package.json` to run web tests
- Tests: `web/test/ruleValidation.test.ts`

1. Add front-end rule validation tests for typed values, ordered numeric bounds, and preset/media-kind compatibility.
2. Add typed client models and functions for preview and queue APIs.
3. Add a focused rules panel to the library page. Support only the schema-defined fields/operators and presets available for that library media kind. Allow condition AND behavior to be clear in the UI.
4. Preview draft rules without saving them; label this state clearly. Show needsScan rows and explain that the next library scan is required.
5. Make queueing a separate deliberate button after preview. Show per-file queue/skipped results and never auto-queue from preview.
6. Preserve the current preset/fallback editor and expose ordered rules alongside it. Keep the page usable on narrow widths and keyboard-accessible.
7. Reuse the repository's existing Vitest install and add a web test command for rule validation.

**Acceptance:** UI cannot create invalid operator/value combinations; preview never saves or queues; queue action is explicit and reflects server response.

## Task 6: Full verification, docs, and review

**Files:**
- Modify: `README.md` or relevant docs
- Review all touched files

1. Document rule priority, AND semantics, fallback, supported fields/operators, metadata refresh behavior, preview pagination, and explicit queueing.
2. Run the full server test suite, web rule validation tests, `npm run lint`, and `npm run build`.
3. Inspect migration behavior on a temporary database and verify existing health state/history survives upgrade and null-metadata refresh.
4. Review all new endpoints for path and job safeguards and confirm preview has no mutation/probe code path.
5. Request code review before merging.

**Acceptance:** all test, lint, build, migration, API guard, and review checks pass.

## Follow-up phases already authorized by the product comparison

Implement these after this rule-preview project is complete, each with its own spec and reviewable plan:

1. **Health check correctness and usability:** add a worker-level stable-file guard; distinguish proven corruption from unavailable/unverifiable inputs (permissions, ffmpeg/environment failures); validate quick sample coverage and thorough decode behavior; expose clear states/reasons and health history; add scheduling/ingest integration only where supported by current architecture. Preserve the rule that health checks do not mutate media.
2. **Optional quality gate before replacement:** inspect current transcode verification and atomically enforce configured quality thresholds before replacing originals; opt-in and disabled by default; tests for missing metrics and failed thresholds.
3. **Remote workers:** design a mapped-path worker protocol and capability/health reporting, then implement with clear local fallback and job ownership rules.

Do not fold these follow-up changes into the rule-preview implementation.
