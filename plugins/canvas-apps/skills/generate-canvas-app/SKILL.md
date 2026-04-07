---
name: generate-canvas-app
version: 2.0.0
description: Generate a complete, visually distinctive Power Apps canvas app with YAML. USE WHEN the user wants to create, build, or generate a Canvas App or pa.yaml files.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Task, TaskCreate, TaskUpdate, TaskList, mcp__canvas-authoring__compile_canvas
---

# Generate a Canvas App

Generate a complete Power Apps canvas app for the following requirements:

$ARGUMENTS

## Overview

This skill orchestrates two specialist agents:

1. **`canvas-app-planner`** — discovers available controls and data sources, designs the app,
   presents a screen plan for your approval, then writes a shared plan document
2. **`canvas-screen-builder`** — writes exactly one screen's YAML; multiple builders run in
   parallel after the plan is approved

You (the skill) coordinate the agents and own the compilation + error-fixing loop after all
screens are written.

---

## Phase 0 — Create App Folder

Before planning, derive a short folder name from the user's requirements:

1. Extract the app name or a 2–4 word summary from `$ARGUMENTS`
2. Convert to kebab-case (e.g., "Expense Tracker" → `expense-tracker`, "my travel planner" → `my-travel-planner`)
3. Create the folder using `Bash`: `mkdir -p <folder-name>`
4. Resolve its absolute path — this is the **working directory** for all subsequent phases

Pass this absolute path as the working directory in every agent prompt below.

---

## Phase 1 — Plan

Invoke the `canvas-app-planner` agent using the `Task` tool.

Pass a prompt that includes:

- The user's requirements: `$ARGUMENTS`
- The working directory (the absolute path resolved in Phase 0)
- The plugin root path: `${CLAUDE_PLUGIN_ROOT}`

Example prompt:

> You are the canvas-app-planner agent. Plan a Canvas App for the following requirements:
>
> [paste $ARGUMENTS here]
>
> Working directory: [absolute path from Phase 0]
> Plugin root: ${CLAUDE_PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Write canvas-app-plan.md and App.pa.yaml to
> the working directory. Return the screen list and plan document path when complete.

**Wait for the planner to finish.** The planner will present the screen plan to the user via
plan mode and wait for approval before returning. Do not proceed to Phase 2 until the planner
task completes successfully.

---

## Phase 2 — Build

After the planner completes, read `canvas-app-plan.md` from the working directory.

Extract the screen list from the `## Screens` table — collect each screen name and its
target file name.

Invoke one `canvas-screen-builder` agent per screen. **Fire all invocations in a single
message** (parallel execution) — do not wait for one screen to finish before starting the next.

For each screen, pass a prompt that includes:

- Screen name (e.g., "Home")
- Target file name (e.g., "Home.pa.yaml")
- Absolute path to `canvas-app-plan.md`
- Working directory

Example prompt per screen:

> You are the canvas-screen-builder agent. Implement the **[Screen Name]** screen.
>
> - Target file: [ScreenName].pa.yaml
> - Plan document: [absolute path to canvas-app-plan.md]
> - Working directory: [absolute path from Phase 0]
>
> Follow the instructions in your agent file. Write [ScreenName].pa.yaml and return your
> result when done. Do not call compile_canvas — validation is handled by the skill.

Wait for all screen-builder tasks to complete before proceeding.

---

## Phase 3 — Validate and Fix

After all screen-builders have finished writing their files, call `compile_canvas` on the
working directory.

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
