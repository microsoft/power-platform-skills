# GI-004 Screen Completeness Testing Guide

## Overview

This evaluation tests **GI-004: Verify complete core functional journeys after compilation**.

The observable symptom is shell navigation generating without destination screen content, but the actual bug is incomplete functional journeys — screens that exist in the navigation structure but lack the content and controls needed to complete the workflow.

From the Canvas Eval Analysis Report:

- **Affected trains:** 53/103 (51%)
- **Severity:** Critical
- **Category:** Skill fix required

## Current Status: READY (Pending CLI Build)

**EvalCLI Canvas support is implemented** in branch `users/maasadiz/evalcli-canvas-external-apps`.

### To Run This Evaluation

1. **Build EvalCLI** from the feature branch (using the monorepo dev environment):

   ```powershell
   cd C:\PARepos\power-apps-ds-ml
   git checkout users/maasadiz/evalcli-canvas-external-apps
   
   # Activate the monorepo venv (includes all dependencies)
   .\.venv\Scripts\Activate.ps1
   
   # Build using the existing build script or PyInstaller
   cd runewald\packages\app_gen
   python -m PyInstaller --onedir src/app_gen/cli/main.py --name evals --noconfirm
   ```

   **Alternative:** Run directly with Python (no build needed):
   ```powershell
   cd C:\PARepos\power-apps-ds-ml\runewald\packages\app_gen
   $env:PYTHONPATH = "src"
   python -m app_gen.cli.main run <config.yaml>
   ```

2. **Create apps.json** from template:

   ```powershell
   cp apps.json.template apps.json
   # Edit apps.json with actual Player URLs from nightly Canvas runs
   ```

3. **Rename config and run**:
   ```powershell
   mv future-config.yaml.example static.yaml
   evals run static.yaml
   ```

### Why Canvas Apps Are Different

| Aspect            | WorkIQ/Horizon Apps                   | Canvas Apps                                                                                   |
| ----------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Code artifacts    | `App_Definition` in Eval blob storage | `.pa.yaml` source synced locally, but no `App_Definition` artifact registered in Eval storage |
| JudgeKit input    | tsx/ts/css from blob storage          | Not applicable (no registered artifact)                                                       |
| Evaluation method | Static code analysis via JudgeKit     | CUA against Player URL                                                                        |
| App source        | Appgen recipe generates code          | External Player URLs from JSON                                                                |

### Implemented EvalCLI Features

1. **`external-apps` recipe** — Loads apps from JSON file containing Player URLs.
   - Creates `AppGenRunResults` with `app_url` set (no `app_definition`)
   - CUA uses URL directly without deployment

2. **`local-user-journeys` recipe** — Loads journeys from local YAML files.
   - Creates `UserJourneyGenRunResults` for CUA consumption
   - Assigns all journeys to all apps

3. **CUA integration** — Runs against external Player URLs.
   - Detects `app_url` in results and uses it directly
   - No container deployment needed

## Pipeline Configuration

```yaml
steps:
  - external-apps
  - local-user-journeys
  - cua
  - grade-functionality

external-apps:
  apps-file: apps.json

local-user-journeys:
  files:
    - journeys/core-lifecycle.yaml
    - journeys/validation-guards.yaml

cua:
  concurrency: 1 # Canvas apps require concurrency=1
  timeout_seconds: 1800
  max_turns: 80

grade-functionality:
  model: gpt-4o
```

## GI-004 Journeys

Two journeys are defined in `journeys/`:

### 1. Core Lifecycle (`core-lifecycle.yaml`)

Tests the complete device procurement flow:

1. Browse catalog
2. Select device and open request form
3. Submit valid procurement request
4. Verify request in My Orders
5. Approve request (as approver)
6. Verify Approved status

**Pass criteria:** Complete procurement journey completes end-to-end with functional screens at each step.

### 2. Validation Guards (`validation-guards.yaml`)

Tests form validation behavior semantically (not exact strings):

1. Empty justification → blocked with field-specific feedback
2. Invalid quantity → blocked with constraint feedback
3. Over-stock quantity → blocked with limit feedback
4. Valid request → succeeds

**Pass criteria:** Validation enforces constraints with meaningful, field-specific feedback.

## Files in This Directory

| File                              | Purpose                                       |
| --------------------------------- | --------------------------------------------- |
| `future-config.yaml.example`      | EvalCLI config (rename to static.yaml to use) |
| `apps.json.template`              | Template for external app URLs                |
| `journeys/core-lifecycle.yaml`    | Core procurement flow journey                 |
| `journeys/validation-guards.yaml` | Form validation journey                       |
| `TESTING.md`                      | This guide                                    |

## Quick Start

1. **Build EvalCLI** from feature branch (see above)
2. **Create `apps.json`** from template with Player URLs
3. **Rename config**: `mv future-config.yaml.example static.yaml`
4. **Run**: `evals run static.yaml`

## Build Verification

After building EvalCLI, verify the new steps are registered:

```powershell
# Check that external-apps and local-user-journeys appear in help
evals --help

# Verify the schema includes new steps
evals schema show | Select-String "external-apps|local-user-journeys"
```

## Authentication (Optional)

If your Canvas apps require authentication:

1. **Export Playwright storage state** from an authenticated browser session:
   ```powershell
   # Run Playwright codegen to capture auth state
   npx playwright codegen --save-storage auth/storage-state.json
   ```

2. **Provide storage state** via:
   - **Config**: Add `player-storage-state: auth/storage-state.json` to `external-apps` section
   - **Environment variable**: `$env:CANVAS_PLAYER_STORAGE_STATE = "auth/storage-state.json"`

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `step not found: external-apps` | Using old EvalCLI binary | Rebuild from feature branch |
| `apps file not found` | apps.json not created | Copy from template, add URLs |
| `CUA timeout` | App loading slowly | Increase `timeout_seconds` in cua config |
| `Login required` | No storage state | Provide Playwright storage state |
| `concurrency error` | Multiple browsers | Ensure `concurrency: 1` in cua config |

## Related Issues

| Issue ID | Title                                | Relationship        |
| -------- | ------------------------------------ | ------------------- |
| GI-004   | Screen completeness                  | **This evaluation** |
| GI-10    | Missing screen content — blank panes | Same root cause     |
| GI-11    | Data binding failure                 | Often co-occurs     |
| GI-12    | Missing/incomplete app screens       | Related pattern     |

## Baseline Metrics

From CANVAS_EVAL_ANALYSIS_REPORT.md (2026-07-14):

| Metric            | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| Trains with issue | 53/103 (51%)                                                 |
| Apps affected     | ~72                                                          |
| Example failures  | batch2_012, batch2_013                                       |
| CUA findings      | "My Orders shows nothing", "no interactive controls visible" |
