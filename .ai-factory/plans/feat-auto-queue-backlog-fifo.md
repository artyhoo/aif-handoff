# Implementation Plan: Auto-Queue Backlog FIFO Ordering

Branch: feat/auto-queue-backlog-fifo
Created: 2026-06-23 09:09

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: Current roadmap milestones are already completed; this plan is a post-delivery correctness fix for backlog ordering and legacy backlog data.

## Overview

Issue `#133` is the remaining root-cause fix after the ROADMAP-specific patch from `#108`.

Current `upstream/main` behavior is internally inconsistent:

- `nextBacklogTaskByPosition()` correctly advances the backlog task with the smallest `position`
- ordinary `createTask()` inserts new backlog tasks with `min(position) - 100`
- the default create flow therefore behaves like LIFO instead of FIFO
- the default position query is also global across all backlog tasks, so one project's backlog can influence another project's newly created task positions

There is one important constraint: backlog order is now user-editable via manual reorder APIs/UI. Because of that, a blanket migration that rewrites every existing backlog task by `createdAt` risks destroying intentional operator ordering. Legacy cleanup should therefore be an explicit, opt-in remediation path rather than an automatic migration.

### Key Decisions

- Keep Auto-Queue semantics unchanged: the coordinator should continue to pick the smallest backlog `position`.
- Fix the source of the bug in `createTask()` by appending ordinary backlog tasks to the tail of their own project's backlog.
- Preserve explicit `position` overrides for special callers such as roadmap import.
- Make `nextBacklogTaskByPosition()` deterministic for tied positions by ordering on `position`, `createdAt`, then `id`.
- Do not add a schema/data migration just to rewrite existing backlog positions; the schema is unchanged and legacy ordering remediation should stay operator-invoked.
- Treat legacy backlog normalization as an operator action, not an automatic schema/data migration.
- Preserve the current ROADMAP import special-case ordering unless product requirements explicitly change it in a separate issue.
- Treat the UI/API ordering change for ordinary newly created backlog tasks as intentional: after this fix, normal task creation should place new items at the backlog tail instead of the head.

### Expected Change Surface

- `packages/data/src/index.ts`
- `packages/data/src/__tests__/index.test.ts`
- `packages/data/src/normalizeBacklogPositions.ts` or `packages/data/src/tools/normalizeBacklogPositions.ts` (new helper/utility logic)
- `packages/data/src/__tests__/normalizeBacklogPositions.test.ts` (new)
- `packages/agent/src/__tests__/autoQueue.test.ts`
- `packages/api/src/__tests__/tasks.test.ts`
- `packages/api/src/__tests__/roadmapGeneration.test.ts`
- `packages/api/src/services/roadmapGeneration.ts` (only if comments or helper usage need alignment)
- `packages/data/package.json` and/or root `package.json` (launcher wiring only if needed)
- `scripts/normalize-backlog-positions.mjs` (optional thin launcher only if implementation chooses a root entrypoint)
- `docs/architecture.md`
- `docs/api.md`
- `docs/configuration.md` or another operator-facing doc only if the normalization utility introduces operator-facing flags/env beyond the invocation itself

### Risks / Open Questions

- Rewriting existing backlog positions automatically would clobber manual reorder state; the implementation should avoid hidden rewrites.
- ROADMAP import currently uses explicit front-of-queue positioning to preserve phase/sequence semantics. This plan assumes that special behavior stays in place.
- If maintainers want "every creation path appends to backlog tail" with no special cases, that is a separate product decision and should not be silently bundled into this fix.
- The implementation should choose a runtime path for the remediation utility that does not rely on plain Node importing workspace TypeScript source directly; if a launcher is added, it must either execute built `dist` output or opt into a supported TS runtime explicitly.

## Commit Plan

- **Commit 1** (after tasks 1-2): `fix(data): append new backlog tasks per project`
- **Commit 2** (after tasks 3-5): `test(queue): cover backlog ordering regressions`
- **Commit 3** (after tasks 6-8): `docs: add backlog ordering remediation guidance`

## Tasks

### Phase 1: Correct Backlog Ordering Semantics

- [x] Task 1: Fix ordinary backlog task creation to append within the owning project
  - Files: `packages/data/src/index.ts`
  - Deliverable: change the default `createTask()` position path from global `min(position) - 100` to project-scoped tail insertion (preferably `max(position) + 100` scoped by `projectId`), while preserving explicit `position` overrides for callers that intentionally manage queue placement.
  - Include/consider: whether to add a symmetric helper such as `getMaxBacklogPosition(projectId)` alongside `getMinBacklogPosition(projectId)` to keep the intent explicit and testable.
  - Logging requirements: do not add noisy per-task creation logs on the hot path; if helper-level diagnostics are needed, keep them `DEBUG` only and consistent with existing `@aif/data` logging patterns.

- [x] Task 2: Make backlog selection deterministic without changing coordinator semantics
  - Files: `packages/data/src/index.ts`
  - Deliverable: update `nextBacklogTaskByPosition(projectId)` to order by `asc(position)`, `asc(createdAt)`, `asc(id)` so tied positions are stable and reproducible. Review adjacent position-sorted queries for semantic consistency, but do not broaden the change beyond backlog selection unless a concrete bug is found.
  - Logging requirements: preserve existing coordinator/data logging behavior; any touched log lines must remain concise and at current levels unless a new failure mode requires explicit `WARN`/`ERROR`.

### Phase 2: Lock In the New Semantics with Regression Tests

- [x] Task 3: Rewrite the data-layer ordering tests around FIFO creation semantics
  - Files: `packages/data/src/__tests__/index.test.ts`
  - Deliverable: replace the current assertion that documents decreasing default positions with coverage for:
    - tasks `A`, `B`, `C` created in one project receive increasing default positions
    - another project's backlog does not influence those positions
    - explicit `position` overrides still win
    - `nextBacklogTaskByPosition(projectId)` returns the oldest effective backlog task under the new default semantics
    - tied backlog positions resolve deterministically by `createdAt`, then `id`
  - Logging requirements: no new runtime logs; encode the intended behavior clearly in test names and comments so future regressions are obvious.

- [x] Task 4: Add end-to-end regression coverage for the normal task creation path
  - Files: `packages/agent/src/__tests__/autoQueue.test.ts`, `packages/api/src/__tests__/tasks.test.ts`
  - Deliverable: add regression coverage for the user-facing path that originally exposed the bug. At minimum, prove that tasks created through the ordinary create flow are advanced by Auto-Queue in FIFO backlog order (`A`, then `B`, then `C`) and that API-visible backlog ordering matches the new append-to-tail semantics for ordinary creation. Keep scheduled-task and paused-task behavior unchanged.
  - Include/consider: prefer using the existing API test harness for `POST /tasks` plus an agent/coordinator regression where ordinary `createTask()` defaults, not hand-seeded positions, drive the queue result.
  - Logging requirements: preserve current test-only logging behavior; no new production logs are needed unless a touched boundary gains a new failure mode.

- [x] Task 5: Preserve the ROADMAP import regression guarantees from `#108`
  - Files: `packages/api/src/__tests__/roadmapGeneration.test.ts`, `packages/api/src/services/roadmapGeneration.ts` (if needed)
  - Deliverable: ensure the generic `createTask()` fix does not regress the roadmap import flow that already assigns explicit positions to preserve phase/sequence order. Keep this task narrow: the goal is regression protection and comment alignment, not re-designing roadmap import queue policy.
  - Logging requirements: keep roadmap import logs accurate to the final behavior; if comments or debug messages describe queue placement, update them so they no longer imply the old default insertion rule.

### Phase 3: Safe Remediation for Existing Backlog Data

- [x] Task 6: Add a tested, opt-in backlog normalization utility for legacy data
  - Files: `packages/data/src/normalizeBacklogPositions.ts` or `packages/data/src/tools/normalizeBacklogPositions.ts` (new), `packages/data/src/__tests__/normalizeBacklogPositions.test.ts` (new), `packages/data/package.json` and/or root `package.json`, optional `scripts/normalize-backlog-positions.mjs`
  - Deliverable: implement an operator-invoked remediation tool that can inspect and optionally rewrite backlog positions per project (or all projects) into a stable ascending sequence. The utility must default to a safe preview/dry-run mode and clearly warn that applying it overwrites existing manual backlog order.
  - Suggested behavior: separate pure/testable normalization planning logic from the CLI/launcher layer; support project scoping, dry-run vs apply, summary counts, and stable ordering rules for regeneration (for example `createdAt`, then `id`) only when the operator explicitly confirms the rewrite.
  - Execution constraint: do not depend on plain Node importing workspace TypeScript source. If the utility is launched from a script, use either a supported TS runtime explicitly or compiled `dist` artifacts.
  - Logging requirements: `INFO` summary output for inspected/changed task counts, `WARN` before destructive apply, `ERROR` on DB/argument failures. No silent mutations.

- [x] Task 7: Document the new queue semantics and the remediation workflow
  - Files: `docs/architecture.md`, `docs/api.md`, `docs/configuration.md` or another operator-facing doc chosen during implementation
  - Deliverable: document that:
    - ordinary backlog task creation appends to the project backlog tail
    - Auto-Queue consumes the smallest `position`
    - roadmap import is an explicit ordering path
    - legacy backlog normalization is opt-in because manual reorder exists
    - ordinary newly created backlog tasks now appear at the backlog tail in UI/API ordering instead of jumping to the top
    - if a remediation utility ships, its invocation path and dry-run/apply contract are documented exactly as implemented
  - Logging requirements: none beyond keeping any CLI/script usage examples accurate to actual script output and flags.

### Phase 4: Verification and Merge Readiness

- [x] Task 8: Run focused regression checks, then workspace validation
  - Files: no source changes expected unless failures require follow-up fixes
  - Deliverable: run targeted tests for `@aif/data`, ordinary task creation/API ordering, coordinator auto-queue coverage, and roadmap import coverage first, then run the full project-mandated validation path with `npm run ai:validate`. If the remediation utility lands in a new package file set, include its package-level tests in the focused pass and confirm coverage remains above the required threshold for affected packages.
  - Logging requirements: keep command output visible in the implementation session; do not add application logging solely for validation.
