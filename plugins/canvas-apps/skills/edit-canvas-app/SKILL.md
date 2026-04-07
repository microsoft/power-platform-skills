---
name: edit-canvas-app
version: 2.0.0
description: Edit an existing Power Apps canvas app. USE WHEN the user wants to modify, update, change, or edit an existing Canvas App or pa.yaml files.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Task, TaskCreate, TaskUpdate, TaskList, mcp__canvas-authoring__sync_canvas, mcp__canvas-authoring__compile_canvas
---

# Edit a Canvas App

Make the following changes to the existing Canvas App:

$ARGUMENTS

## Overview

This skill uses two paths depending on edit complexity:

- **Simple edits** (single control/property changes, formula tweaks) — handled inline
- **Complex edits** (multiple screens, new screens, structural changes, new data sources) —
  orchestrated via specialist agents: `canvas-edit-planner` + parallel `canvas-screen-editor`

---

## Phase 0 — Create App Folder

Before syncing or editing, create a subfolder to contain the app's YAML files:

1. Derive a short folder name from `$ARGUMENTS` — extract the app name if present, otherwise
   use a 2–3 word summary of what is being edited
2. Convert to kebab-case (e.g., "Expense Tracker" → `expense-tracker`)
3. Create the folder using `Bash`: `mkdir -p <folder-name>`
4. Resolve its absolute path — this is the **working directory** for all subsequent phases

All file reads, writes, and syncs operate in this folder.

---

## Phase 1 — Sync and Check

**Sync the canvas app:**

Call the `sync_canvas` MCP tool targeting the working directory. This pulls the current app
state from the coauthoring session into local `.pa.yaml` files. Only proceed after
`sync_canvas` completes successfully.

**Check for meaningful content:**

After `sync_canvas` completes, read the synced `.pa.yaml` files and check whether the app
has meaningful content. An app is considered **empty** if:

- No `.pa.yaml` files were written, or
- The only files present contain no screens, or
- Every screen present has no controls (only bare screen-level YAML with no children), or
- Every screen's controls consist solely of containers (e.g., `GroupContainer`) with no
  leaf controls inside them

If the app is empty, **do not proceed with the edit workflow**. Instead, inform the user:

> **The synced app appears to be empty — no existing screens or controls were found.**
> Switching to app generation mode to build the app from scratch.

Then follow the full **generate-canvas-app** workflow, using the user's original request as
the generation requirements.

If the app has meaningful content, proceed to Phase 2.

---

## Phase 2 — Assess Complexity

Read all synced `.pa.yaml` files. Based on `$ARGUMENTS` and the current app state, determine
whether this is a **simple** or **complex** edit:

**Simple** — all of the following are true:
- Changes affect ≤ 2 controls or properties
- Changes are confined to ≤ 1 screen
- No new screens are being added
- No new data sources or connectors are needed
- No structural layout changes (e.g., not changing ManualLayout to AutoLayout)

Examples: change a button color, update label text, fix a formula, adjust a control size.

**Complex** — any of the following are true:
- Changes span multiple screens
- One or more new screens need to be created
- New data sources or connectors are required
- Structural layout changes are involved
- Significant visual redesign of a screen

Examples: add a settings screen, redesign the home screen layout, integrate a new connector,
change the navigation flow across the app.

- If **simple**: proceed to Phase 3a.
- If **complex**: proceed to Phase 3b.

---

## Phase 3a — Simple: Direct Edit

Read `${CLAUDE_PLUGIN_ROOT}/references/TechnicalGuide.md` before making changes.

Apply the changes directly:

1. **Edit** the relevant `.pa.yaml` files with the required changes, following conventions
   from TechnicalGuide.md.

2. **Validate** by calling `compile_canvas` on the working directory after making changes.
   On failure, read the errors, fix with `Edit`, and re-compile. Iterate until clean.

3. Present a brief summary:
   > **Edit complete.** [1-2 sentence description of what was changed.] Compiled clean after [N] pass(es).

---

## Phase 3b — Complex: Plan

Invoke the `canvas-edit-planner` agent using the `Task` tool.

Pass a prompt that includes:

- The user's edit requirements: `$ARGUMENTS`
- The working directory (absolute path where `.pa.yaml` files were synced)
- The plugin root path: `${CLAUDE_PLUGIN_ROOT}`
- The list of synced `.pa.yaml` files found in the working directory

Example prompt:

> You are the canvas-edit-planner agent. Plan the following edits to an existing Canvas App:
>
> [paste $ARGUMENTS here]
>
> Working directory: [absolute working directory path]
> Plugin root: ${CLAUDE_PLUGIN_ROOT}
> Synced files: [list of .pa.yaml filenames]
>
> Follow the instructions in your agent file. Write canvas-edit-plan.md to the working
> directory. Return the list of screens to modify/add and the plan document path when complete.

**Wait for the planner to finish.** The planner will present the edit plan to the user via
plan mode and wait for approval before returning. Do not proceed to Phase 4 until the planner
task completes successfully.

---

## Phase 4 — Edit (Complex path only)

After the planner completes, read `canvas-edit-plan.md` from the working directory.

Extract the list of screens to modify and screens to add from the plan's tables.

Invoke one `canvas-screen-editor` agent per affected screen. **Fire all invocations in a
single message** (parallel execution) — do not wait for one editor to finish before starting
the next.

For each screen, pass a prompt that includes:

- Screen name (e.g., "Home")
- Target file name (e.g., "Home.pa.yaml")
- Action: "Modify" (existing screen) or "Add" (new screen)
- Absolute path to `canvas-edit-plan.md`
- Working directory

Example prompt per screen:

> You are the canvas-screen-editor agent. [Modify / Add] the **[Screen Name]** screen.
>
> - Action: [Modify / Add]
> - Target file: [ScreenName].pa.yaml
> - Plan document: [absolute path to canvas-edit-plan.md]
> - Working directory: [absolute working directory path]
>
> Follow the instructions in your agent file. [Edit / Write] [ScreenName].pa.yaml and return
> your result when done. Do not call compile_canvas — validation is handled by the skill.

Wait for all screen-editor tasks to complete before proceeding.

---

## Phase 5 — Validate and Fix (Complex path only)

After all screen-editors have finished, call `compile_canvas` on the working directory.

**On success:** Proceed to Phase 6.

**On failure:** Read every error in the output. Errors will reference specific files and
line numbers. For each error:

1. `Read` the referenced `.pa.yaml` file
2. Fix the error using `Edit`
3. After fixing all errors from this pass, call `compile_canvas` again

Repeat until `compile_canvas` reports no errors. Do not give up after a single fix attempt —
iterate until the entire directory compiles clean.

Track how many `compile_canvas` passes were needed.

---

## Phase 6 — Summary

Present a final summary:

> **Edit complete.**
>
> | Action | Screen | File | Status |
> |--------|--------|------|--------|
> | [Modify / Add] | [Screen Name] | [filename].pa.yaml | Done |
>
> **Compiled clean** after [N] pass(es).

If any errors remain after exhausting fixes, report them explicitly so the user knows what
needs manual attention.
