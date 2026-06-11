---
name: validate-pending-changes
description: >-
  Pre-commit dry run: lists all pending Changes in the bound Dataverse environment,
  invokes the run-prevalidators.js orchestrator (12 validators in parallel —
  file-size cap, unsupported object types, large Canvas warnings, PCF binary
  duplication, dependency integrity, orphan source-control rows, action=3
  conflicts, shared components, Default-Solution binding, version-bump check,
  IsCustomizable=false metadata, blocked attachments), and writes a delta-aware
  docs/inner-loop/pre-commit-report.html plus docs/inner-loop/last-validation.json
  (optionally last-validation.junit.xml or .sarif for CI ingestion).
  Use when asked: "validate before commit", "check pending changes", "pre-flight check",
  "will this commit work", "check for issues before pushing to git",
  "dry run", "run validate-pending-changes", "any blockers before I commit".
user-invocable: true
argument-hint: ""
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Validate Pending Changes

Pre-commit dry run that lists every pending Change in the bound Dataverse environment and runs **12 pre-flight validators in parallel** via the `run-prevalidators.js` orchestrator. Hard-stops on blockers (e.g. 17 MB file-size cap, orphan source-control rows, action=3 conflicts, shared components), surfaces warnings (e.g. large Canvas Apps, PCF binary duplication, version-bump checks, IsCustomizable=false metadata), and emits a delta-aware HTML report alongside JSON + optional JUnit/SARIF artifacts for CI.

## Overview

This skill is the safety net between an in-progress edit and a `commit-to-git` invocation. `commit-to-git` calls this skill implicitly in its own Phase 3 — invoking it standalone is useful when the user wants to know whether their pending changes are commit-ready without committing yet.

Output:
- `docs/inner-loop/pre-commit-report.html` — human-readable findings (with V-14 delta badge, V-15 components-by-type breakdown, V-17 IL-NNN hyperlinks, V-18 per-validator timings)
- `docs/inner-loop/last-validation.json` — machine-readable marker (read by the `commit-to-git` hook validator)
- `docs/inner-loop/last-validation.junit.xml` — only when invoked with `--format junit`; consumable by ADO Pipelines / GitHub Actions `dorny/test-reporter`
- `docs/inner-loop/last-validation.sarif` — only when invoked with `--format sarif`; consumable by GitHub Code Scanning

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §9 (17 MB cap)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` (blocker + warning classification)

## Prerequisites

- PAC CLI installed and authenticated (`pac env who` succeeds)
- Azure CLI installed and logged in (`az account get-access-token` succeeds)
- A Git binding already established (run `/power-pages:setup-git-integration` first if needed)

**Initial request:** $ARGUMENTS

---

## Phase 1 — Binding Check

**Goal:** Confirm the environment is bound to a Git repository — without a binding there is nothing to validate.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

1. Verify PAC CLI auth and acquire an env-scoped token:

   ```bash
   pac env who --json
   az account get-access-token --resource <envUrl> --query expiresOn -o tsv
   ```

   Surface any failure verbatim and stop.

2. Check the Git binding state:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>"
   ```

   If `bound === false`, there are no pending Changes to validate.

   <!-- gate: validate-pending-changes:1.no-binding | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · validate-pending-changes:1.no-binding):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | No Git binding found for this environment. Set one up first? | Not bound to Git | Run /power-pages:setup-git-integration, Cancel |

   Do NOT proceed past Phase 1 without a confirmed binding.

**Output:** Confirmed binding to org/project/repo/branch.

---

## Phase 2 — List Pending Changes

**Goal:** Enumerate every uncommitted Change in the bound environment and short-circuit if the workspace is clean. Use the cross-run cache to skip the full Dataverse fetch when nothing has changed since the previous run.

**Create the task list now** (binding is confirmed, scope is known):

Tasks to create (`TaskCreate`):

1. List pending Changes
2. Persist pending-changes snapshot
3. Run 5 pre-flight validators (in parallel)
4. Render pre-commit report HTML
5. Write `last-validation.json` marker
6. Surface results

Steps:

1. **Probe** the Dataverse for the current pending-changes count — a fast count-only round-trip (~50ms) used as the cache-key input. Pass `--solutionUniqueName` whenever `bindingType === 'solution'` in `.git-integration-manifest.json`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" \
       --envUrl "<envUrl>" --probe \
       [--solutionUniqueName "<solutionUniqueName from manifest>"]
   ```

   Expected: `{ count: N, scope: {...}, probe: true }`. If `count === 0`: workspace is clean. Write `last-validation.json` with `status: "clean"` and exit cleanly — there is no gate; a clean workspace is success.

2. **Check the cache.** Look up the cached items[] using `boundSyncedCommitId` (from Phase 1's `detect-git-binding.js` output) + the probed `pendingChangesCount` + the bound `solutionUniqueName`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/pending-changes-cache.js" \
       --load \
       --projectRoot "<projectRoot>" \
       --boundSyncedCommitId "<sha from detect-git-binding>" \
       --pendingChangesCount <N> \
       [--solutionUniqueName "<name>"]
   ```

   - On `{ hit: true, items: [...] }`: cache is fresh (≤60s) and matches — load `items` from the result, mention "Reusing cached snapshot from Ns ago" in your progress message, and skip step 3 below.
   - On `{ hit: false, reason: "..." }`: continue to step 3. The cache is best-effort; treat any miss reason (`no-file`, `key-mismatch`, `expired`, `corrupt-*`, etc.) as a normal miss and move on.

3. **Full list** (only if cache missed). Fetch the materialised pending Changes:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" \
       --envUrl "<envUrl>" \
       [--solutionUniqueName "<solutionUniqueName from manifest>"]
   ```

   Expected: `{ count: N, scope: {...}, items: [{ componentId, componentName, componentType, changeType, action, filePath, ... }] }`.

4. **Save the cache** for the next run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/pending-changes-cache.js" \
       --save \
       --projectRoot "<projectRoot>" \
       --boundSyncedCommitId "<sha>" \
       --pendingChangesCount <N> \
       [--solutionUniqueName "<name>"] \
       --itemsFile "<temp file containing items[] JSON>"
   ```

   Cache write failures are non-fatal — log them and continue.

5. Display a friendly summary of the pending Changes (e.g. `"2 modified web templates, 1 new web page"`) and continue.

**Output:** A list of N pending Changes ready for validation, either fetched fresh or restored from cache.

---

## Phase 2.5 — Persist Pending-Changes Snapshot

**Goal:** Write the `items[]` array to a temporary file on disk so the 5 pre-flight validators (which are pure consumers, no Dataverse calls) can read it via `--pending-file` without re-fetching.

Steps:

1. Resolve the snapshot path via the shared helper (`scripts/lib/inner-loop-paths.js`):

   ```
   <projectRoot>/docs/inner-loop/pending-changes-snapshot.json
   ```

   The key registered in `FILE_NAMES` is `pendingChangesSnapshot`. Programmatic consumers should resolve via `innerLoopPath(projectRoot, 'pendingChangesSnapshot')`.

2. Ensure `docs/inner-loop/` exists, then write the snapshot file with the shape `{ "items": [ ... ] }` (matching `list-pending-changes.js` output so the validators' `--pending-file` mode parses it correctly).

3. The snapshot is transient — overwritten on every run. It is NOT a user-facing artifact; it exists solely to feed the parallel validators in Phase 3.

**Output:** `docs/inner-loop/pending-changes-snapshot.json` written with the materialised `items[]`.

---

## Phase 3 — Run Pre-flight Validators (orchestrator)

**Goal:** Run every pre-flight validator against the pending Changes, aggregate findings, capture per-validator timings, compute a delta vs the previous run, and emit the report (HTML + JSON, plus optional JUnit/SARIF/text).

This is a **single orchestrator call**. The orchestrator (`run-prevalidators.js`) discovers every validator from a single catalog array, runs them in parallel via child processes, and writes all artifacts. The agent does not enumerate validators here — it just runs the orchestrator and reports on its output.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/run-prevalidators.js" \
     --pending-file "<projectRoot>/docs/inner-loop/pending-changes-snapshot.json" \
     --envUrl "<envUrl>" \
     --solutionUniqueName "<solutionUniqueName>" \
     --env-friendly-name "<envFriendlyName>" \
     --format json
```

Optional flags:
- `--format json|junit|sarif|text` (default `json`; `text` is the right choice for terminal-only runs and prints a 5-line summary; `junit`/`sarif` additionally write `last-validation.junit.xml` / `last-validation.sarif` for CI ingestion)
- `--no-delta` to skip the prior-run comparison
- `--no-timings` to skip per-validator timing capture
- `--validator-timeout <ms>` per-validator hard timeout (default 60 000 ms)
- `--docs-base-url <url>` overrides the IL hyperlink base in the HTML report (env var `POWER_PAGES_DOCS_BASE_URL` also honored)

**Exit code:** `0` when all clean or warnings-only, `2` when blockers present, `1` on hard failure.

**Output (stdout):** the full report object in the chosen `--format`. The orchestrator ALWAYS also writes:
- `docs/inner-loop/last-validation.json` — canonical machine marker
- `docs/inner-loop/pre-commit-report.html` — human-readable report (with V-14 delta badge, V-15 components-by-type breakdown, V-17 IL-NNN hyperlinks, V-18 validator-timing table)

### What the orchestrator runs

The catalog currently dispatches 14 validators. Each validator independently returns the standard envelope `{ ok, blocking[], warnings[], info[] }`, which the orchestrator aggregates.

| # | Validator | Kind | Catches | Catalog ref |
|---|---|---|---|---|
| 1 | `validate-file-sizes` | pure | Files exceeding the 17 MB encoded cap | IL-006 |
| 2 | `validate-supported-object-types` | pure | Unsupported object types | IL-007 |
| 3 | `check-large-canvas-warning` | pure | Canvas apps in raw-byte warn (≥ 8 MB) / critical (≥ 11 MB) bands (V-12) | IL-006 |
| 4 | `check-code-first-binary-duplication` | pure | Duplicate PCF/binary content | — |
| 5 | `validate-dependencies` | pure | Missing referenced dependencies | — |
| 6 | `validate-no-orphan-source-control-rows` | http | `sourcecontrolcomponent` rows with null `_sourcecontrolcomponentpayloadid_value` → `CommitToGit → 0x80040217` | IL-019 |
| 7 | `validate-no-action-3-conflicts` | http | Any `action eq 3` (Conflict) row → `CommitToGit → 0x80098015` (authoritative; replaces the false-zeroing `list-conflicts.js`) | IL-010 |
| 8 | `validate-no-shared-components` | http | Components living in 2+ Git-bound solutions → `CommitToGit → 0x80040216` | IL-009 |
| 9 | `validate-not-default-solution` | pure (manifest) | Binding pinned to `Default` or `Active` solution | IL-008 |
| 10 | `validate-solution-version-bumped` | http (warn-only) | Solution version unchanged since last commit (downstream pipelines may skip install-on-version-bump) | IL-008 |
| 11 | `validate-no-iscustomizable-false-rows` | http (warn-only) | Entity metadata with `IsCustomizable.Value===false` — commits succeed but break Pull on downstream envs (Attribute metadata is reported as `info`/skipped because Dataverse exposes no top-level `AttributeDefinitions` set) | IL-007 |
| 12 | `validate-blocked-attachments` | http | Blocked-attachment site settings; wraps `fix-blocked-attachments.js --check-only` | IL-012 |
| 13 | `validate-publisher-prefix-consistency` | http (warn-only) | Pending Changes whose schema prefix doesn't match the bound solution's publisher prefix (cross-solution accidental edits) — V-10 | — |
| 14 | `validate-total-payload-size` | pure (warn-only) | Total encoded payload exceeds 100 MB → commit may take 5–15 min / trip throttles — V-13 | — |

The orchestrator surfaces a `validator-skipped` info finding for any validator whose required input (e.g. `--envUrl` or `--solutionUniqueName`) is missing.

**Adding a new validator:** append one entry to the `VALIDATORS` array in `scripts/lib/run-prevalidators.js`. No other edits are required.

---

## Phase 4 — Surface Orchestrator Output

**Goal:** Parse the orchestrator JSON, attach `last-validation.json` + `pre-commit-report.html` paths to the agent's next message, and decide which Phase 6 branch to take.

Steps:

1. Read `docs/inner-loop/last-validation.json` (or use the orchestrator's stdout JSON if you ran with `--format json`).
2. Capture: `status`, `blockers[]`, `warnings[]`, `infos[]`, `delta`, `validatorTimings`, `componentsByType`, `pendingChangesCount`, `elapsedMs`.
3. The orchestrator has already written the HTML report — no separate rendering pass is needed.

---

## Phase 5 — _(merged into Phase 3 — orchestrator writes the marker)_

---

## Phase 6 — Surface Results

**Goal:** Communicate the outcome clearly. Blockers hard-stop; warnings require explicit user acknowledgement; clean workspaces summarise quickly.

### 6a — Blockers present (hard stop, no gate)

If `blockers.length > 0`: output a clear table of every blocker with remediation steps from `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md`. **Do NOT ask the user to proceed** — a blocked commit always fails. Exit.

### 6b — Warnings only

<!-- gate: validate-pending-changes:6.warnings-only | category=final | cancel-leaves=nothing -->
> 🚦 **Gate (final · validate-pending-changes:6.warnings-only):** When there are no blockers but `warnings.length > 0`, surface `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Validation found N warning(s) but no blockers. You can still commit — the warnings won't cause a hard failure but may affect env behaviour. | Pre-commit warnings | Proceed to commit-to-git (Recommended), Show warning details first, Cancel |

### 6c — All clean

If `status === "passed"` or `status === "clean"`: output a one-line success summary and suggest `/power-pages:commit-to-git`.

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "ValidatePendingChanges"`.

**Output:** Findings surfaced; user routed to the appropriate next step.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `pre-commit-report.html` | `docs/inner-loop/` | Human-readable findings; open in a browser. |
| `last-validation.json` | `docs/inner-loop/` | Skill-run marker; validated by `validate-validate-pending-changes.js` and read by `commit-to-git` Phase 3. |
| `pending-changes-snapshot.json` | `docs/inner-loop/` | Transient: materialised `list-pending-changes` output that the 5 pre-flight validators consume via `--pending-file`. Overwritten each run. |
| `pending-changes-cache.json` | `docs/inner-loop/` | Transient: TTL-bounded (60s) memo keyed by `(boundSyncedCommitId, pendingChangesCount, solutionUniqueName)` so re-runs after fixing one blocker can skip the full Dataverse list call. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| List pending Changes | Listing pending changes | Probe the bound env, check the cross-run cache, and fetch the full items[] only on cache miss; short-circuit if workspace is clean |
| Persist pending-changes snapshot | Persisting snapshot | Write `docs/inner-loop/pending-changes-snapshot.json` so the parallel validators can consume one shared payload |
| Run 5 pre-flight validators (in parallel) | Running pre-flight validators | Fan out file-size, supported-types, large-canvas, PCF-duplication, and dependency validators against the snapshot in a single turn |
| Render pre-commit report HTML | Rendering pre-commit report | Compose findings into `docs/inner-loop/pre-commit-report.html` |
| Write `last-validation.json` marker | Writing validation marker | Persist findings + status to `docs/inner-loop/last-validation.json` for downstream skills |
| Surface results | Surfacing results | Print summary; hard-stop on blockers, gate on warnings, success on clean |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: If no Git binding exists → run `setup-git-integration` or cancel (gate `validate-pending-changes:1.no-binding`).
2. **Phase 6b**: Warnings only → proceed to commit, view details, or cancel (gate `validate-pending-changes:6.warnings-only`).

---

## Error Handling

- **Detect-binding query fails** (transient 5xx): retry once; if it fails again, surface the error and stop — do not assume "not bound" on an error.
- **Probe query fails** (Phase 2 step 1): surface the error and stop — without a count we cannot decide clean-vs-dirty or compute a cache key.
- **Cache load/save failure**: log the reason and continue. The cache is best-effort; a corrupt or missing cache file must never block the skill.
- **Snapshot write fails** (Phase 2.5): surface the error and stop — the 5 validators need the snapshot to run.
- **A validator script exits non-zero** (Phase 3): surface the script's stderr verbatim, mark that finding as `{ severity: "error", validator, detail: "<stderr>" }`, and continue with the remaining validators — partial findings are still useful.
- **`docs/inner-loop/` write fails** (permission/full disk): surface the error and stop; the marker file is load-bearing for `commit-to-git`.
- **17 MB cap detected**: flag as blocker; remediation is to delete or split the oversized file (no workaround exists at the platform layer).

---

**Begin with Phase 1: Binding Check**
