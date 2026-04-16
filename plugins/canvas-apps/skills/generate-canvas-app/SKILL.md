---
name: generate-canvas-app
description: Generate a complete, visually distinctive Power Apps canvas app with YAML. USE WHEN the user wants to create, build, or generate a Canvas App or pa.yaml files.
---

# Generate a Canvas App

Generate a complete Power Apps canvas app for the following requirements:

$ARGUMENTS

## Overview

This skill runs as a single Codex workflow. Plan the app, write the `.pa.yaml` files directly,
compile them with `compile_canvas`, and iterate until the app validates cleanly.

---

## Phase 0 — Create App Folder

Before planning, derive a short folder name from the user's requirements:

1. Extract the app name or a 2–4 word summary from `$ARGUMENTS`
2. Convert to kebab-case (e.g., "Expense Tracker" → `expense-tracker`, "my travel planner" → `my-travel-planner`)
3. Create the folder using `Bash`: `mkdir -p <folder-name>`
4. Resolve its absolute path — this is the **working directory** for all subsequent phases

---

## Phase 1 — Plan

Read these references before planning:

- `plugins/canvas-apps/references/TechnicalGuide.md`
- `plugins/canvas-apps/references/DesignGuide.md`

Then do the planning work directly:

1. Inspect available building blocks with MCP tools as needed:
   - `list_controls` for control availability
   - `list_data_sources` and `list_apis` for available data
   - `describe_control`, `describe_api`, or `get_data_source_schema` for anything you intend to use
2. Create a short implementation plan with `update_plan`
3. Produce a concrete screen plan in the conversation:
   - screen name
   - purpose
   - important controls
   - data sources or collections
   - notable formulas or interactions
4. If the requirements are ambiguous or the app has meaningful product choices, ask the user to approve or adjust the screen plan before writing files
5. Write `App.pa.yaml` and one `.pa.yaml` file per screen into the working directory

Do not depend on planner or builder sub-agents.

---

## Phase 2 — Build

Implement the app directly in the working directory:

1. Create `App.pa.yaml`
2. Create the planned screen files
3. Keep formulas, control names, and properties consistent with the technical reference
4. Reuse a small number of layout patterns instead of inventing incompatible YAML shapes
5. If the user asked for a distinctive visual treatment, reflect it with control hierarchy, spacing, color, and typography choices that are valid for Canvas Apps

---

## Phase 3 — Validate and Fix

After writing the app files, call `compile_canvas` on the working directory.

**On success:** Proceed to Phase 4.

**On failure:** Read every error in the output. Errors will reference specific files and
line numbers. For each error:

1. `Read` the referenced `.pa.yaml` file
2. Fix the error using `Edit`
3. After fixing all errors from this pass, call `compile_canvas` again

Repeat until `compile_canvas` reports no errors. Do not give up after a single fix attempt —
iterate until the entire directory compiles clean.

Track how many `compile_canvas` passes were needed.

---

## Phase 4 — Summary

Present a final summary:

> **App generation complete.**
>
> | Screen | File | Status |
> |--------|------|--------|
> | [Screen Name] | [filename].pa.yaml | Written |
>
> **Compiled clean** after [N] pass(es). | **Screens:** [N] | **Data:** [source or collections]

If any errors remain after exhausting fixes, report them explicitly so the user knows what
needs manual attention.
