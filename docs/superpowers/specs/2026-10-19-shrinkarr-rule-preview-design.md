# Shrinkarr Rule Builder and Preview Design

- **Status:** Draft for review
- **Date:** 2026-10-19
- **Repository:** [rpeters1430/Shrinkarr](https://github.com/rpeters1430/Shrinkarr)
- **Project:** 1 of 4 in the Tdarr-inspired improvement sequence

## Purpose

Give users control over which files Shrinkarr recommends for optimization, explain every decision, and show the likely effect before jobs are queued. Keep Shrinkarr's current preset-based transcoding and safety checks as the execution path.

## Current behavior

- Each library selects one preset.
- The scanner calls the policy engine to decide whether a file should be transcoded or remuxed, and records a reason and estimated savings.
- Users can create and edit presets, and can enable automatic optimization.
- The policy is deterministic but its matching logic is code-defined rather than user-authored.

## User-facing behavior

1. A user creates or edits ordered rules for a library.
2. Each rule has a name, enabled state, conditions, and one action.
3. Conditions are combined with AND. Rules are evaluated in order; the first matching rule wins.
4. Initial actions are **Use preset** (select an existing video or audio preset) and **Keep** (do not optimize). A library's existing preset and current policy remain the fallback when no user rule matches.
5. The rule editor previews a library without changing files or queue state. It reports files matched per rule, each file's reason, recommended action, and estimated savings.
6. The user must explicitly confirm queueing previewed work. Existing auto-optimize remains opt-in and may queue only files whose resolved rule action selects a preset.
7. Existing ignore rules, file stability checks, health gating, minimum savings, free-space protections, verification, and atomic replacement continue to apply.

## Initial condition fields

Expose only fields the scanner already probes or stores:

- Media type, file size, video codec, container, width/height or resolution, bitrate, bit depth, HDR status, audio codec/channels, and subtitle count.
- Path or filename pattern, using the existing library exclusion matching approach where suitable.

The condition editor should provide type-appropriate comparisons (equals, one-of, greater/less than, range, and path contains/pattern) and reject invalid field/operator/value combinations through the existing Zod configuration validation. No user-provided JavaScript or shell commands are accepted.

## Decision and preview model

- Extend the policy decision path with a pure rule-resolution function. Inputs are the current scanned file record/probe, library, rules, and existing preset catalog; output includes selected action, rule ID/name, human-readable reason, preset if selected, and current savings estimate.
- Use the same resolver for scanner recommendations, preview output, and automatic queue eligibility so the UI cannot preview one decision while the queue executes another.
- Preview is read-only. It does not enqueue jobs, write file records, or change library configuration.
- Saving a rule set and queueing work are separate actions. Jobs store the selected preset ID as they do today.
- Existing configs without rules retain their current behavior and are valid without migration.

## UI and API

- Add per-library rule management to the existing Library workflow.
- Add a preview endpoint that accepts a library ID and returns summary counts plus paginated file-level decisions. It must not accept arbitrary filesystem paths outside configured libraries.
- Provide reorder, enable/disable, edit, delete, save, and preview actions. Show rule priority and the fallback behavior.
- Apply the same path-guard and validation conventions as current library, preset, and file APIs.

## Safety and compatibility

- Rules can select an existing preset or Keep; they cannot bypass output verification or cause direct file operations.
- Rule evaluation must be deterministic, bounded in work, and independent of UI ordering after save.
- Preserve backward compatibility for existing YAML configuration and existing preset behavior.
- A rule that references a missing preset is rejected when saved.
- Preview must not disclose paths outside configured libraries and must not change files or jobs.
- When auto-optimize is enabled, Keep decisions never queue. User-authored rules do not make auto-optimize opt-in by themselves.

## Acceptance criteria

- Existing installations with no rules produce the same decisions as the current policy.
- A rule set with overlapping conditions resolves using first-match order and returns the winning rule's explanation.
- Invalid conditions, duplicate IDs, invalid order values, or missing presets are rejected with actionable validation errors.
- Preview reports deterministic rule matches, per-file reasons, and estimated savings without changing the database or queue.
- Explicit queueing uses the same resolved preset as preview; existing transcode verification and replacement protections remain active.
- Auto-optimize queues preset-selected matches only when the library's existing auto-optimize option is enabled.
- Unit tests cover every condition operator and rule precedence; API tests cover validation, pagination, path boundaries, and preview read-only behavior; UI tests or component-level checks cover rule editing and preview feedback.

## Out of scope for this project

- Arbitrary executable plugins or user-authored code.
- New FFmpeg actions beyond selecting an existing preset or keeping the file.
- Remote worker scheduling, quality metrics, and health-check workflow improvements; these have separate design and implementation cycles.
