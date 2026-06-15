---
name: diagnose-git-integration
description: >-
  Pattern-matches Inner Dev Loop failure symptoms against the 18 known patterns
  in inner-loop-error-catalog.md (Managed Env disabled, BYOK encryption, repo
  not initialized, missing sys-admin role, ADO PAT scope, 17 MB cap,
  unsupported types, Default-solution binding, shared-object overlap, blocking
  conflicts, stale binding metadata, upload-code-site race, cross-tenant
  consent, powerpagecomponent pull bug, ResolveGitConflict API absence,
  gitupdatefiles/gitconflictfiles false-negative, CommitToGit 400 false-failure,
  portal Pull 404 stale cache).
  Renders a findings report and offers per-finding auto-fix
  consent for fixable patterns. Read-mostly; no destructive actions without
  explicit user approval.
  Writes docs/inner-loop/diagnosis.html and docs/inner-loop/last-diagnosis.json.
  Use when asked: "diagnose git integration", "something's broken with git",
  "git sync isn't working", "why did commit-to-git fail", "help me debug
  connect-to-git", "inner-loop error", "investigate git failure",
  "run diagnose-git-integration".
user-invocable: true
argument-hint: "Optional: error message in quotes to seed the diagnosis"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Diagnose Git Integration

Investigates Inner Dev Loop failures by pattern-matching observed symptoms against the 18 known patterns in `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` (IL-001 through IL-018). Renders an HTML diagnosis report with findings classified by severity and offers per-finding auto-fix consent for fixable Error patterns.

## Overview

This is the inner-loop counterpart of `/power-pages:diagnose-deployment` for the outer (ALM) loop — same loop-style auto-fix pattern, same one-marker-covers-all-findings discipline, same read-mostly bias (no destructive actions without explicit user approval).

The skill runs in three modes (chosen at the Phase 1 intent gate):
1. **Paste an error** — the user pastes a raw error string; the skill pattern-matches against the catalog regex set.
2. **Describe symptoms** — the user picks symptoms from a checklist (e.g. "commit-to-git failed", "binding looks wrong", "files not appearing in ADO"); the skill maps each to candidate patterns.
3. **Full scan** — the skill runs every pattern's detector script in parallel; useful when the user doesn't have a specific error but knows "something is off".

No artifacts are mutated without per-finding consent. The `auto-fix` consent gate is a single loop-style marker (`diagnose-git-integration:5.auto-fix`) reused for each fixable Error finding — same loop-style pattern as `diagnose-deployment:6.auto-fix`. Answers are Yes / No / Skip-all-remaining.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` (18 patterns IL-001–IL-018)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md` §3 (Broken state — this skill is the recommended remediation)
- `${CLAUDE_PLUGIN_ROOT}/references/conflict-resolution-patterns.md` (Pattern IL-010 fix dispatches to `resolve-conflicts`; IL-015 covers tenants where the API is absent)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- A Power Pages project root (`powerpages.config.json` or `.powerpages-site/` present)
- An ADO PAT recommended for patterns that probe ADO directly (IL-003, IL-005) — best-effort otherwise

**Initial request:** $ARGUMENTS

---

## Phase 1 — Gather Symptoms

**Goal:** Choose one of three diagnostic modes and capture the input that drives pattern matching.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

1. Verify PAC CLI auth and acquire an env-scoped token:

   ```bash
   pac env who --json
   az account get-access-token --resource <envUrl> --query expiresOn -o tsv
   ```

   Soft-fail OK — diagnosis can run partially offline; patterns that need Dataverse / ADO probes will be marked `skipped` rather than failing the whole skill.

2. <!-- gate: diagnose-git-integration:1.symptoms | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · diagnose-git-integration:1.symptoms):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | What's broken? | Diagnosis input | Paste an error message (I'll pattern-match against the catalog), Describe the symptoms (I'll surface a checklist), Run the full 13-pattern scan, Cancel |

   - **Paste an error** → collect the raw error text via a follow-up `AskUserQuestion`. The text becomes `symptomInput`.
   - **Describe symptoms** → present a multi-select checklist of common symptoms (e.g. *"commit-to-git failed"*, *"git-configure setup failed"*, *"binding looks wrong"*, *"files I committed aren't in ADO"*, *"sync-from-git keeps reporting conflicts"*). The selected items become `symptomInput`.
   - **Full scan** → set `symptomInput = "*"` (matches every pattern's detector).
   - **Cancel** → exit cleanly.

3. If the user passed an error message via the skill argument, pre-populate "Paste an error" with it.

**Output:** A `symptomInput` (raw text, selected symptoms, or `"*"` for full scan).

---

## Phase 2 — Run Pattern Detectors

**Goal:** For each pattern in `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md`, run its detector against the current env / project state. Capture per-pattern `{ detected, severity, evidence, autoFixAvailable }`.

Tasks to create (`TaskCreate`):

1. Run pattern detectors (IL-001 through IL-018)
2. Aggregate findings by severity
3. Render `docs/inner-loop/diagnosis.html`
4. Per-finding auto-fix loop
5. Write `last-diagnosis.json` marker

Steps:

1. For each pattern IL-001 … IL-018:

   - Read the pattern's section in `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` to determine the detector approach. Detectors typically re-use existing helpers (e.g. IL-001 → `verify-managed-env.js`; IL-003 → `verify-repo-initialized.js`; IL-005 → `verify-ado-permissions.js`; IL-006 → `validate-file-sizes.js`; IL-007 → `validate-supported-object-types.js`; IL-009 → cross-check `gitintegrations` overlap; IL-010 → `list-conflicts.js`; IL-011 → `detect-git-binding.js` cross-checked against `.git-integration-manifest.json`; IL-014 → solution-component histogram probe: `GET /api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq <solutionId> and componenttype eq 10429&$count=true` returns > 0 AND `PullChangesFromGit` on that solution returns `0x80072033`; IL-015 → `GET /api/data/v9.2/ResolveGitConflict` → 404 probe; IL-016 → `GET /api/data/v9.2/gitupdatefiles` and `gitconflictfiles` → 404 probe; IL-017 → re-read pending count after a recent non-2xx commit attempt; IL-018 → portal Pull `404 Item with Id <guid> no longer exists` correlated with the GUID being absent from ADO repo grep AND `sourcecontrolcomponentpayloads(<guid>)` returning `0x80040216` restricted-API error).

   - For paste-an-error mode, gate on regex match between the error text and the pattern's known signature strings before running the detector — patterns whose signature doesn't match are skipped.

   - For describe-symptoms mode, map each selected symptom to its candidate pattern set (e.g. *"sync-from-git keeps reporting conflicts"* → only run IL-010, IL-011 detectors).

   - For full-scan mode, run every detector in parallel.

   Manifest reconcile (B3): whenever a detector calls `detect-git-binding.js`, compare `.git-integration-manifest.json` against that server truth using `reconcileManifest({ manifest, serverBinding })` from `${CLAUDE_PLUGIN_ROOT}/scripts/lib/reconcile-manifest.js`; see `${CLAUDE_PLUGIN_ROOT}/references/manifest-contract.md` for the full contract.
   <!-- gate: diagnose-git-integration:1.manifest-stale | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · diagnose-git-integration:1.manifest-stale):** When `aligned:false`, surface the divergence and let the user choose from the helper's returned `options` (`overwrite-from-server`, `rebind-old-coords`, `clear-local`) before proceeding; cancellation leaves the manifest untouched.

2. Record per-pattern:

   ```json
   {
     "patternId":         "IL-003",
     "patternName":       "ADO repo not initialized",
     "detected":          true|false,
     "severity":          "Error"|"Warning"|"Info",
     "evidence":          "<short detector output>",
     "autoFixAvailable":  true|false,
     "fixDelegate":       "/power-pages:git-configure"  // null if manual
   }
   ```

3. Soft-fail per detector: if a detector throws (auth gone, network down), record `detected: null` with `evidence: "Detector failed: <reason>"` and continue. Do NOT abort the whole skill.

**Output:** A `findings[]` array, one entry per IL-NNN pattern that was probed.

---

## Phase 3 — Aggregate + Render Diagnosis Report

**Goal:** Sort findings by severity, render the HTML report so the user can open it in a browser.

Steps:

1. Bucket findings:
   - `errors` (severity = Error, detected = true) — these are the candidates for the Phase 4 auto-fix loop.
   - `warnings` (severity = Warning, detected = true) — surfaced for visibility but not auto-fixable in v1.
   - `info` (severity = Info, detected = true) — typically environmental notes (e.g. "Managed Env on" is good news).
   - `skipped` (detected = null) — detector errored; the user may need to re-run after fixing auth.

2. Write `docs/inner-loop/diagnosis.html` — a self-contained HTML report (no external CDN):

   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head><meta charset="UTF-8"><title>Inner-loop diagnosis — {envHost}</title>
   <style>
     body { font-family: 'Segoe UI', sans-serif; padding: 24px; max-width: 1000px; margin: 0 auto; }
     h1 { font-size: 1.4rem; }
     .row-error   { background: #fde7e9; }
     .row-warning { background: #fff4ce; }
     .row-info    { background: #dff6dd; }
     .row-skipped { background: #f3f3f3; color: #666; }
     table { border-collapse: collapse; width: 100%; margin-top: 16px; }
     th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; vertical-align: top; }
     th { background: #f3f3f3; }
     .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: .8rem; font-weight: 600; }
     .badge-error { background: #c50f1f; color: #fff; }
     .badge-warning { background: #f7630c; color: #fff; }
     .badge-info { background: #107c10; color: #fff; }
     .badge-skipped { background: #888; color: #fff; }
   </style></head>
   <body>
     <h1>Inner-loop diagnosis</h1>
     <p>Generated: <strong>__GENERATED_AT__</strong> &nbsp;|&nbsp; Env: <strong>__ENV_URL__</strong></p>
     <p>Findings: __ERROR_COUNT__ error(s), __WARNING_COUNT__ warning(s), __INFO_COUNT__ info, __SKIPPED_COUNT__ skipped</p>
     __FINDINGS_TABLE__
   </body></html>
   ```

   For each finding row: `Pattern ID | Name | Severity badge | Evidence | Auto-fix available?`

3. Tell the user the absolute path so they can open it in a browser.

**Output:** `docs/inner-loop/diagnosis.html` written.

---

## Phase 4 — Per-Finding Auto-Fix Loop

**Goal:** For every Error-severity finding with `autoFixAvailable === true`, gate on per-finding consent and either dispatch the corresponding fix skill or surface the manual remediation.

Steps:

1. If `errors.length === 0`: skip Phase 4 entirely — the diagnosis is informational only. Proceed to Phase 5.

2. For each error finding, iterate:

   <!-- gate: diagnose-git-integration:5.auto-fix | category=consent | cancel-leaves=varies-per-fix -->
   > 🚦 **Gate (consent · diagnose-git-integration:5.auto-fix):** **Loop-style** — same marker fires once per fixable Error finding. Surface `AskUserQuestion` per finding:

   | Question | Header | Options |
   |---|---|---|
   | Finding {i}/{N}: **{patternId} — {patternName}** ({severity}). Evidence: `{evidence}`. Auto-fix dispatches to `{fixDelegate}`. Apply now? | Per-finding auto-fix | Yes — apply this fix (Recommended), No — skip this finding, Skip ALL remaining auto-fixes |

3. Branch on each answer:

   - **Yes** → dispatch the `fixDelegate` skill (e.g. IL-003 → `/power-pages:git-configure`; IL-010 → `/power-pages:resolve-conflicts`; IL-011 → re-run `/power-pages:plan-inner-loop` to refresh manifest). Wait for the dispatched skill to return, then continue the loop with the next finding. Record outcome on the finding (`autoFix.status`).
   - **No** → record `autoFix.status: "skipped-by-user"`; continue.
   - **Skip ALL** → set a `skipAll` flag; for this and every remaining auto-fixable finding, record `autoFix.status: "skipped-by-user-bulk"`; exit the loop.

4. For non-fixable Error findings (`autoFixAvailable === false`): do NOT prompt — surface the manual remediation text from the catalog entry in the final summary instead.

**Output:** Updated `findings[]` with per-finding `autoFix.status` (`"applied"`, `"skipped-by-user"`, `"skipped-by-user-bulk"`, or absent for non-fixable / non-error findings).

---

## Phase 5 — Write `last-diagnosis.json` Marker

**Goal:** Persist the machine-readable marker for audit + so downstream skills can reason about diagnosis outcomes.

Steps:

1. Write `docs/inner-loop/last-diagnosis.json`:

   ```json
   {
     "skill":           "diagnose-git-integration",
     "diagnosedAt":     "<ISO>",
     "envUrl":          "<envUrl>",
     "mode":            "paste-error|describe-symptoms|full-scan",
     "symptomInput":    "<raw text or selected-symptom-list or '*'>",
     "patternsCovered": ["IL-001", "IL-003", ...],
     "errorCount":      N,
     "warningCount":    M,
     "infoCount":       K,
     "skippedCount":    S,
     "findings": [
       {
         "patternId":   "IL-003",
         "patternName": "ADO repo not initialized",
         "detected":    true,
         "severity":    "Error",
         "evidence":    "...",
         "autoFixAvailable": true,
         "fixDelegate": "/power-pages:git-configure",
         "autoFix":     { "status": "applied" }
       }
     ],
     "reportPath":      "docs/inner-loop/diagnosis.html",
     "status":          "succeeded"
   }
   ```

   `status` is always `"succeeded"` for this skill — diagnosis itself rarely fails. If most detectors errored (e.g. all auth gone), set `status: "partial"` and surface that in the closing summary.

   The path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastDiagnosis`.

**Output:** `docs/inner-loop/last-diagnosis.json` written.

---

## Phase 6 — Surface Summary

**Goal:** Print a concise summary of what was diagnosed + applied + skipped, and suggest the next concrete step.

Steps:

1. Print:

   ```
   Diagnosis summary
     Mode:     <mode>
     Patterns: <patternsCovered.length>
     Findings: <errorCount> error(s), <warningCount> warning(s), <infoCount> info, <skippedCount> skipped
     Auto-fixes applied:        <count where autoFix.status === "applied">
     Auto-fixes skipped by user: <count of "skipped-by-user" + "skipped-by-user-bulk">
     Non-fixable errors:        <count of errors with autoFixAvailable === false>

   Open the full report: docs/inner-loop/diagnosis.html
   ```

2. Suggest the next step:
   - If any auto-fix was applied → suggest the user re-run the originally-failing skill (e.g. `/power-pages:commit-to-git`).
   - If only non-fixable errors remain → suggest the manual remediation from the catalog.
   - If errors = 0 and warnings = 0 → suggest `/power-pages:plan-inner-loop` to confirm the env is back to a known-good state.

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "DiagnoseGitIntegration"`.

**Output:** Summary printed; user routed to the appropriate next action.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `diagnosis.html` | `docs/inner-loop/` | Human-readable findings report with severity badges; open in a browser. |
| `last-diagnosis.json` | `docs/inner-loop/` | Machine-readable marker (mode + findings + auto-fix outcomes); validated by `validate-diagnose-git-integration.js`. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Run pattern detectors (IL-001 through IL-013) | Running pattern detectors | Probe each catalog pattern using its detector helper; soft-fail per pattern |
| Aggregate findings by severity | Aggregating findings | Bucket detected findings into errors / warnings / info / skipped |
| Render `docs/inner-loop/diagnosis.html` | Rendering diagnosis report | Self-contained HTML with severity badges + per-pattern evidence |
| Per-finding auto-fix loop | Auto-fixing findings | Iterate Error findings; per-finding consent gate; dispatch fix-delegate skill or skip |
| Write `last-diagnosis.json` marker | Writing diagnosis marker | Persist mode + findings + auto-fix outcomes for audit |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: Choose diagnostic mode — paste error, describe symptoms, full scan, or cancel (gate `diagnose-git-integration:1.symptoms`).
2. **Phase 4** (loop): Per-finding auto-fix consent — Yes / No / Skip-all (gate `diagnose-git-integration:5.auto-fix`, fires once per Error finding with `autoFixAvailable: true`).

---

## Error Handling

- **All detectors fail** (e.g. PAC CLI auth lost mid-skill): write the marker with `status: "partial"` + `findings[]` populated with `detected: null` and `evidence: "Detector failed: <reason>"` for each skipped pattern. Surface a clear suggestion to fix auth and re-run.
- **A pattern detector script is missing** (catalog references a helper that doesn't exist yet): record `detected: null` with `evidence: "Detector not implemented yet"`; continue with the remaining patterns. Do NOT fail the skill.
- **A dispatched auto-fix skill returns an error**: record the finding's `autoFix.status` as `"failed"` with the dispatched skill's error message; continue the loop. The user can re-run this skill after addressing the failure.
- **The user cancels mid-loop (Phase 4)** by closing the prompt: treat as `Skip ALL remaining auto-fixes`; write the marker with the partial outcomes and exit cleanly.
- **`docs/inner-loop/` write fails**: hard stop — the marker is load-bearing. Surface the OS error and the in-memory findings so the user can inspect them in chat.

---

**Begin with Phase 1: Gather Symptoms**
