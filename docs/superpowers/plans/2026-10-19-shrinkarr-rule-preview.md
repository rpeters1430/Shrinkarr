# Shrinkarr Rule Builder and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users define ordered per-library optimization rules, preview their decisions safely, and explicitly queue the matching preset jobs.

**Architecture:** Store a bounded, typed rule set in each library's existing YAML-backed configuration. A pure resolver applies first-match rules and falls back to today's policy; the scanner, watcher, preview API, and library queue action use that same resolver. Keep preview read-only and queue requests server-validated against the saved library rules.

**Tech Stack:** TypeScript 7, Zod 4, Fastify 5, Node SQLite, React 19, Vite 8, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-19-shrinkarr-rule-preview-design.md`

## Global Constraints

- Existing configurations without rules preserve current scanner decisions.
- Rules use only typed conditions and the built-in **Use preset** or **Keep** actions; no JavaScript, shell commands, or direct file operations.
- Conditions use AND; enabled rules evaluate in saved order and the first match wins.
- Supported fields, operators, units, unknown-value behavior, and path glob semantics match the approved spec.
- Preview does not mutate configuration, file rows, or jobs; explicit queueing is a separate user action.
- Keep existing auto-optimize opt-in, health gating, exclusions, path guards, stability checks, minimum savings, free-space checks, output verification, and atomic replacement.
- The chosen preset must match the rule's explicit `mediaKind` condition.
- Use current React/Vite/Fastify/Zod/Vitest dependencies unless implementation reveals a concrete need for another dependency.

## Review Focus

1. **Unknown or missing media metadata** — condition evaluation treats unknown values as non-matches; pin in resolver tests.
2. **Audio/video preset mismatch** — reject rule configuration and queue requests; pin in schema, API, and queue tests.
3. **Paths outside a library or stale paths** — preview only indexes the selected library, and queue requests reject/skip paths that do not belong to it; pin in route tests.
4. **Existing configs and rule fallbacks** — no-rule libraries preserve existing decisions and queue behavior; pin in config and scan tests.
5. **Rule or preset edits after preview** — queue recomputes against current saved rules and current preset catalog rather than trusting the browser's preview payload; pin in queue-route tests.

---

### Task 1: Rule schema and pure resolution

**Files:**
- Modify: `server/src/config/schema.ts`
- Create: `server/src/scanner/rules.ts`
- Modify: `server/test/configSchema.test.ts`
- Create: `server/test/rules.test.ts`

**Interfaces:**
- Produces `LibraryRule`, `RuleCondition`, and `RuleDecision` exported types from `config/schema.ts`.
- Produces `resolveLibraryRules(filePath: string, probe: MediaProbe, library: Library, presets: readonly Preset[]): RuleDecision` from `scanner/rules.ts`.
- `RuleDecision` includes the selected action, winning rule ID/name when present, explanation, selected preset ID/name when applicable, and the resulting existing `PolicyDecision`.

- [ ] **Step 1: Write failing schema tests** for valid typed rules, invalid operator/value pairings, duplicate IDs, missing presets, and required compatible `mediaKind` conditions.
- [ ] **Step 2: Run the focused test to verify failure.** Run: `npm test -w server -- --run test/configSchema.test.ts` and `npm test -w server -- --run test/rules.test.ts`. Expected: new schema exports and resolver behavior are missing.
- [ ] **Step 3: Implement typed rule schemas** in `config/schema.ts`. Add `rules: LibraryRule[]` to `LibrarySchema` with an empty default; validate duplicate IDs, condition compatibility, and referenced preset existence where the library and preset catalog are both available.
- [ ] **Step 4: Write and run resolver tests** for each operator, case-insensitive path matching, missing metadata, disabled rules, first-match precedence, explicit Keep, preset type mismatch, and legacy-policy fallback.
- [ ] **Step 5: Implement `resolveLibraryRules`** as a pure function over file path, media probe, library config, and preset catalog. Reuse `decide` for preset actions and the existing policy for no-match fallback.
- [ ] **Step 6: Run focused tests and commit.** Run: `npm test -w server -- --run test/configSchema.test.ts test/rules.test.ts`. Expected: all schema and resolver cases pass.

### Task 2: Use rule resolution during scans and automatic queueing

**Files:**
- Modify: `server/src/scanner/scan.ts`
- Modify: `server/src/scanner/watcher.ts`
- Modify: `server/src/api/routes/libraries.ts`
- Modify: `server/test/scan.test.ts`
- Modify: `server/test/watcherScan.test.ts`

**Interfaces:**
- Consumes `resolveLibraryRules` from Task 1.
- Existing `buildFileRecord` continues to persist the resolved recommendation and explanation through `recommendedAction` and `skipReason`.
- Auto-queued jobs use the resolved preset ID rather than always `library.presetId`.

- [ ] **Step 1: Add failing scan/watcher tests** showing rule-selected presets affect recommendations and auto-queue jobs, Keep rules never queue, and no-rule libraries retain their old behavior.
- [ ] **Step 2: Run focused tests to verify failure.** Run: `npm test -w server -- --run test/scan.test.ts test/watcherScan.test.ts`.
- [ ] **Step 3: Thread the preset catalog into scan and watcher decisions** and use `resolveLibraryRules` to build file rows and queue records.
- [ ] **Step 4: Run focused tests.** Expected: scan output, stored records, and queued preset IDs agree with rule resolution.
- [ ] **Step 5: Commit the scanner and watcher integration.**

### Task 3: Read-only preview and explicit rule-based queue API

**Files:**
- Create: `server/src/api/routes/libraryRules.ts`
- Modify: `server/src/api/server.ts`
- Modify: `server/src/db/filesRepo.ts` only if library-filtered pagination is not already available
- Modify: `server/src/api/routes/jobs.ts` or `server/src/api/routes/libraryRules.ts` for queue-by-rule
- Create: `server/test/libraryRulesRoute.test.ts`
- Modify: `server/test/jobsRoute.test.ts`

**Interfaces:**
- Adds `POST /api/libraries/:id/rules/preview` with `{ rules, offset?, limit? }`; returns summary counts and a page of per-file decisions.
- Adds `POST /api/libraries/:id/rules/queue` with `{ filePaths: string[] }`; returns `{ queued, skipped }`.
- Preview validates the draft rules with the same schema as saved configuration and reads indexed rows only.
- Queue recomputes decisions using the library's current saved rules and preset catalog, validates library membership, and stores the resulting preset IDs.

- [ ] **Step 1: Add failing API tests** for read-only preview, pagination, invalid rules, unknown library, path isolation, explicit queueing, duplicate active jobs, and changed rules/presets since preview.
- [ ] **Step 2: Run focused tests to verify failure.** Run: `npm test -w server -- --run test/libraryRulesRoute.test.ts test/jobsRoute.test.ts`.
- [ ] **Step 3: Implement preview and queue endpoints** with existing Fastify, config validation, and path-guard patterns. Preview must not write to SQLite or enqueue jobs.
- [ ] **Step 4: Run route tests.** Expected: responses are deterministic and queue decisions are recomputed server-side.
- [ ] **Step 5: Commit the API work.**

### Task 4: Library rule editor and preview UI

**Files:**
- Modify: `web/src/api/client.ts`
- Create: `web/src/components/LibraryRulesPanel.tsx`
- Create: `web/src/components/RulePreview.tsx`
- Modify: `web/src/pages/Library.tsx`
- Modify: `web/src/styles.css`
- Create: `web/vitest.config.ts`
- Create: `web/test/LibraryRulesPanel.test.tsx`
- Modify: `web/package.json` and root `package.json` only if needed to expose the UI test command

**Interfaces:**
- Adds client types for rules, conditions, preview rows, and queue results.
- Adds client functions for updating a library's rules, previewing draft rules, and queueing selected preview rows.
- The panel edits ordered rules, exposes supported fields/operators, validates obvious input errors, saves rules, previews, and queues selected rows after save.

- [ ] **Step 1: Add component tests** for adding/editing/reordering/disabling rules, showing preview explanations, saving before queueing, and displaying API validation errors.
- [ ] **Step 2: Run the focused component tests to verify failure.**
- [ ] **Step 3: Implement the typed API client and focused rule components**; keep rule editing out of the already large `Library.tsx` page.
- [ ] **Step 4: Integrate the panel** with the selected library and refresh recommendations after a save.
- [ ] **Step 5: Run the component tests and `npm run build -w web`.** Expected: tests pass and TypeScript/Vite build exits 0.
- [ ] **Step 6: Commit the UI work.**

### Task 5: Full verification and user-facing docs

**Files:**
- Modify: `README.md`
- Modify tests only if the preceding verification exposes a missing case.

- [ ] **Step 1: Run full server tests.** Run: `npm test -w server`. Expected: 0 failures.
- [ ] **Step 2: Run the complete build and lint.** Run: `npm run build && npm run lint`. Expected: both exit 0.
- [ ] **Step 3: Review the README** to document rule ordering, fields/operators, preview behavior, explicit queueing, fallback rules, and auto-optimize interaction.
- [ ] **Step 4: Commit documentation and any verification-driven fixes.**

---
