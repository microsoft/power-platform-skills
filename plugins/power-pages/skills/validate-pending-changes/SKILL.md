---
name: validate-pending-changes
description: >-
  Pre-commit dry run: lists all pending Changes in the bound Dataverse environment
  and runs 5 validators (17 MB file-size cap, unsupported object types, large Canvas App
  warning, PCF binary duplication, dependency integrity). Renders a
  docs/inner-loop/pre-commit-report.html findings report and writes
  docs/inner-loop/last-validation.json.
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

Pre-commit dry run that lists every pending Change in the bound Dataverse environment and runs 5 pre-flight validators against them. Hard-stops on blockers (e.g. 17 MB file-size cap) and surfaces warnings (e.g. large Canvas Apps, PCF binary duplication) for the user to acknowledge before committing.

## Overview

This skill is the safety net between an in-progress edit and a `commit-to-git` invocation. `commit-to-git` calls this skill implicitly in its own Phase 3 — invoking it standalone is useful when the user wants to know whether their pending changes are commit-ready without committing yet.

Output:
- `docs/inner-loop/pre-commit-report.html` — human-readable findings
- `docs/inner-loop/last-validation.json` — machine-readable marker (read by the `commit-to-git` hook validator)

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

**Goal:** Enumerate every uncommitted Change in the bound environment and short-circuit if the workspace is clean.

**Create the task list now** (binding is confirmed, scope is known):

Tasks to create (`TaskCreate`):

1. List pending Changes
2. Run 5 pre-flight validators
3. Render pre-commit report HTML
4. Write `last-validation.json` marker
5. Surface results

Steps:

1. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" --envUrl "<envUrl>"
   ```

   Expected: `{ changes: [{ objectId, name, objectType, changeType }], count: N }`.

2. If `count === 0`: workspace is clean. Write `last-validation.json` with `status: "clean"` and exit cleanly — there is no gate; a clean workspace is success.

3. Otherwise display a friendly summary of the pending Changes (e.g. `"2 modified web templates, 1 new web page"`) and continue.

**Output:** A list of N pending Changes ready for validation.

---

## Phase 3 — Run 5 Pre-flight Validators

**Goal:** Run every pre-flight validator against the pending Changes and bucket the findings into blockers vs warnings.

Steps:

1. Run all 5 validators sequentially — each is lightweight and fast:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/validate-file-sizes.js"                  --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/validate-supported-object-types.js"      --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-large-canvas-warning.js"           --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-code-first-binary-duplication.js"  --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/validate-dependencies.js"                --envUrl "<envUrl>"
   ```

2. Aggregate findings by severity:

   | Bucket | Severity | Block commit? | Examples |
   |---|---|---|---|
   | `blockers` | Error | Yes — `CommitToGit` would fail | File > 17 MB, unsupported object type |
   | `warnings` | Warning | No — user should review | Large Canvas App (> 5 MB), PCF binary duplication, missing optional dependency |

**Output:** Two arrays: `blockers[]` and `warnings[]`.

---

## Phase 4 — Render Pre-commit Report

**Goal:** Persist a human-readable HTML report so the user can drill into each finding outside the chat.

Steps:

1. Compose `reportData`:

   ```json
   {
     "skill":               "validate-pending-changes",
     "generatedAt":         "<ISO>",
     "envUrl":              "<envUrl>",
     "pendingChangesCount": N,
     "blockers":            [ { "validator": "validate-file-sizes", "component": "...", "detail": "..." } ],
     "warnings":            [ { "validator": "check-large-canvas-warning", "component": "...", "detail": "..." } ],
     "status":              "blocked" | "warnings" | "passed"
   }
   ```

2. Write `docs/inner-loop/pre-commit-report.html` — a simple self-contained HTML table (no external CDN):

   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head><meta charset="UTF-8"><title>Pre-commit validation report</title>
   <style>
     body { font-family: 'Segoe UI', sans-serif; padding: 24px; max-width: 900px; margin: 0 auto; }
     h1 { font-size: 1.4rem; }
     table { border-collapse: collapse; width: 100%; margin-top: 16px; }
     th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
     th { background: #f3f3f3; }
     .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: .8rem; font-weight: 600; }
     .badge-blocker { background: #c50f1f; color: #fff; }
     .badge-warning { background: #f7630c; color: #fff; }
     .badge-passed  { background: #107c10; color: #fff; }
   </style></head>
   <body>
     <h1>Pre-commit validation report</h1>
     <p>Generated: <strong>__GENERATED_AT__</strong> &nbsp;|&nbsp; Env: <strong>__ENV_URL__</strong></p>
     <p>Pending changes: <strong>__CHANGES_COUNT__</strong> &nbsp;|&nbsp;
        Status: <span class="badge badge-__STATUS_CLASS__">__STATUS_LABEL__</span></p>
     __FINDINGS_TABLE__
   </body></html>
   ```

   Replace `__*__` tokens with actual values. If no findings, render a single green "All checks passed" row.

**Output:** `docs/inner-loop/pre-commit-report.html` written.

---

## Phase 5 — Write `last-validation.json` Marker

**Goal:** Persist the machine-readable marker that the PostToolUse validator and downstream skills (e.g. `commit-to-git`) read.

Steps:

1. Ensure `docs/inner-loop/` exists, then write `docs/inner-loop/last-validation.json`:

   ```json
   {
     "skill":               "validate-pending-changes",
     "validatedAt":         "<ISO>",
     "envUrl":              "<envUrl>",
     "pendingChangesCount": N,
     "blockers":            [...],
     "warnings":            [...],
     "reportPath":          "docs/inner-loop/pre-commit-report.html",
     "status":              "blocked" | "warnings" | "passed" | "clean"
   }
   ```

   The path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastValidation` — programmatic consumers should resolve via `innerLoopPath(projectRoot, 'lastValidation')`.

**Output:** `docs/inner-loop/last-validation.json` written.

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

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| List pending Changes | Listing pending changes | Query the bound env via `list-pending-changes.js`; short-circuit if workspace is clean |
| Run 5 pre-flight validators | Running pre-flight validators | Sequentially run file-size, supported-types, large-canvas, PCF-duplication, and dependency validators |
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
- **A validator script exits non-zero**: surface the script's stderr verbatim, mark that finding as `{ severity: "error", validator, detail: "<stderr>" }`, and continue with the remaining validators — partial findings are still useful.
- **`docs/inner-loop/` write fails** (permission/full disk): surface the error and stop; the marker file is load-bearing for `commit-to-git`.
- **17 MB cap detected**: flag as blocker; remediation is to delete or split the oversized file (no workaround exists at the platform layer).

---

**Begin with Phase 1: Binding Check**
