---
name: canvas-app
version: 2.0.0
description: Creates or edits a Power Apps Canvas App through the Canvas Authoring MCP coauthoring session. Handles new app generation from requirements, simple inline edits, and complex multi-screen changes with parallel screen builders. Triggers on requests to create, build, generate, modify, update, change, or edit a Canvas App or .pa.yaml files.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, EnterPlanMode, ExitPlanMode, mcp__canvas-authoring__sync_canvas, mcp__canvas-authoring__compile_canvas
---

# Create or Edit a Canvas App

Create or edit a Power Apps canvas app for the following requirements:

$ARGUMENTS

## Overview

This skill handles both **creating** and **editing** canvas apps through a unified workflow.
It syncs the current app state to detect whether the app has existing content, then routes
accordingly:

- **CREATE mode** — the app is empty or has no meaningful content; a new app is generated
  from scratch using a preferences wizard and parallel screen builders.
- **EDIT mode (simple)** — the app has existing content and the requested changes are small;
  edits are applied inline without planning agents.
- **EDIT mode (complex)** — the app has existing content and the requested changes are
  substantial; a planner designs the changes and parallel screen builders execute them.

Two specialist agents are used for planned work:

1. **`canvas-app-planner`** — discovers available controls, APIs, and data sources; gathers
   control property definitions; and writes the shared plan document (`canvas-app-plan.md`)
   and `App.pa.yaml`. Receives the approved plan from the skill.
2. **`canvas-screen-builder`** — writes or modifies exactly one screen's YAML; multiple
   builders run in parallel after the plan is approved

You (the skill) coordinate the agents, detect mode, design and present the plan for user
approval, and own the compilation + error-fixing loop after all screens are written.

---

## Phase 0 — Create App Folder

Before syncing or editing, create a subfolder to contain the app's YAML files:

1. Extract the app name or a 2–4 word summary from `$ARGUMENTS`
2. Convert to kebab-case (e.g., "Expense Tracker" → `expense-tracker`, "my travel planner" →
   `my-travel-planner`)
3. Create the folder using `Bash`: `mkdir -p <folder-name>`
4. Resolve its absolute path — this is the **working directory** for all subsequent phases

Pass this absolute path as the working directory in every agent prompt below.

---

## Phase 1 — Sync

Call the `sync_canvas` MCP tool targeting the working directory. This pulls the current app
state from the coauthoring session into local `.pa.yaml` files. Only proceed after
`sync_canvas` completes successfully.

---

## Phase 2 — Detect Mode

After `sync_canvas` completes, read the synced `.pa.yaml` files and check whether the app
has meaningful content. An app is considered **empty** if:

- No `.pa.yaml` files were written, or
- The only files present contain no screens, or
- Every screen present has no controls (only bare screen-level YAML with no children), or
- Every screen's controls consist solely of containers (e.g., `GroupContainer`) with no
  leaf controls inside them

**If the app is empty → CREATE mode.** Proceed to Phase 3.

**If the app has meaningful content → EDIT mode.** Skip Phase 3 and proceed to Phase 4.

---

## Phase 3 — Gather Preferences (CREATE mode only)

Use `AskUserQuestion` to collect design preferences that cannot be reliably inferred from
`$ARGUMENTS`. **Parse `$ARGUMENTS` first** to determine which questions to skip — but a
short request like "visitor check-in app" or "expense tracker" leaves most preferences
unspecified and you MUST ask.

Call `AskUserQuestion` with the applicable questions from the table below (include only the
ones that need answers):

| Question | Header | When to Ask | Options |
|----------|--------|-------------|---------|
| Who will primarily use this app, and on what device? | Target Users & Device | Only if not clear from `$ARGUMENTS` | *(3–4 dynamically inferred options that combine the user role with their likely device, e.g., for "visitor check-in": Front desk staff on desktop/tablet, Security team on tablet, Self-service kiosk on tablet, Visitors on their phone)* |
| Do you have a screenshot or mockup for reference? (paste an image or provide a file path) | Reference | Only if user has NOT already attached/pasted an image with their request | Yes I'll share one now, No just pick a direction for me |
| What aesthetic direction? | Aesthetic | Only if not clear from `$ARGUMENTS` (skip if user already described a visual direction like "dark themed", "minimal", "corporate style", or provided a reference image) | Clean & Professional (Recommended), Bold & High-Contrast, Soft & Approachable, Dense & Utilitarian |
| Which features do you need? (multi-select) | Features | Only if `$ARGUMENTS` is vague on features | *(3–4 dynamically inferred options based on app purpose + target users)* |

**Rules:**

1. If the user provides a screenshot (either attached with their original request or via the
   wizard), examine it to extract structural cues (layout, navigation pattern) and visual cues
   (color palette, density, typography). Use these to inform the aesthetic direction — do not
   ask the aesthetic question separately.
2. **If all questions are already answered by `$ARGUMENTS` and any attached images, skip the
   wizard entirely** and proceed directly to Phase 5.
3. Ask all applicable questions in a single `AskUserQuestion` call — do not ask them one at a time.
4. Store all answers for use in the planner prompt below.

**Target users & device influence design decisions:**
- **Desktop users** → data-dense layouts, tables, keyboard-friendly, multi-column. ManualLayout acceptable for pixel-perfect dashboards.
- **Tablet users** → touch-friendly targets, medium density, AutoLayout (responsive) so the app adapts to landscape/portrait.
- **Phone users** → large touch targets, single-column, simplified navigation, AutoLayout (responsive), minimal typing.
- **Multi-device / unknown** → AutoLayout (responsive) required.

After collecting preferences, proceed to Phase 5 (Plan).

---

## Phase 4 — Assess Complexity (EDIT mode only)

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

- If **simple**: proceed to Phase 4a.
- If **complex**: proceed to Phase 5 (Plan).

### Phase 4a — Simple: Direct Edit

Read `${CLAUDE_PLUGIN_ROOT}/references/TechnicalGuide.md` before making changes.

Apply the changes directly:

1. **Edit** the relevant `.pa.yaml` files with the required changes, following conventions
   from TechnicalGuide.md.

2. **Validate** by calling `compile_canvas` on the working directory after making changes.
   On failure, read the errors, fix with `Edit`, and re-compile. Iterate until clean.

3. Present a brief summary:
   > **Edit complete.** [1-2 sentence description of what was changed.] Compiled clean after [N] pass(es).

**Stop here.** The simple edit path is complete — do not continue to Phase 5 or beyond.

---

## Phase 5 — Plan

You (the skill) own plan design and user approval. After approval, invoke the
`canvas-app-planner` agent to discover resources, gather control definitions, and write the
plan document.

### Step 5.1 — Read Reference Documents

Read both reference documents before designing the plan:

- `${CLAUDE_PLUGIN_ROOT}/references/TechnicalGuide.md`
- `${CLAUDE_PLUGIN_ROOT}/references/DesignGuide.md`

Internalize both. These govern every design decision you will make.

### Step 5.2 — Design the Plan

#### CREATE mode

Based on the user preferences from Phase 3 and the user's requirements, reason through:

- How many screens are needed and what each does
- Which controls will drive each screen's layout
- What aesthetic direction fits the app's purpose
- How data will flow (data sources, collections, or mock data)
- **Layout strategy** — follow the layout decision rules in TechnicalGuide.md

#### EDIT mode

Read all `.pa.yaml` files in the working directory (you may have already read them in
Phase 4). Based on the current app state and the user's edit requirements, reason through:

- Which screens need to be modified and what specific changes are needed
- Whether any new screens need to be created
- How changes can be made while preserving the existing app's aesthetic and layout consistency
- Any new controls, data sources, or variables required

### Step 5.3 — Present Plan for Approval

Enter plan mode (`EnterPlanMode`) and present the plan.

#### CREATE mode

```
## Canvas App Plan

### Screens ([N] total)

| Screen | File | Purpose | Key Controls |
|--------|------|---------|--------------|
| [Name] | [Name].pa.yaml | [one-line description] | [2-3 controls] |

### Data Strategy
[How data will be loaded — data sources used, or "collections/mock data"]

### Aesthetic Direction
[e.g., "Bold & editorial — high-contrast dark background, accent RGBA(255,90,60,1), card-based layout, strong typographic hierarchy"]
```

#### EDIT mode

```
## Canvas Edit Plan

### Screens to Modify ([N] total)

| Screen | File | Summary of Changes |
|--------|------|--------------------|
| [Name] | [Name].pa.yaml | [one-line description of changes] |

### Screens to Add ([N] total, if any)

| Screen | File | Purpose |
|--------|------|---------|
| [Name] | [Name].pa.yaml | [one-line description] |

### Approach
[e.g., "Preserving existing dark theme — updating button palette on Home screen and adding a
new Settings screen with consistent RGBA values extracted from existing files"]
```

#### Both modes

Then call `ExitPlanMode` to request user approval.

- If approved: proceed to Step 5.4.
- If changes requested: revise the plan and re-enter plan mode with the updated version.

### Step 5.4 — Invoke Planner Agent

After approval, invoke the `canvas-app-planner` agent using the `Task` tool. The agent
will discover available resources, gather control property definitions, write `App.pa.yaml`
(CREATE only), and write `canvas-app-plan.md`.

Pass a prompt that includes the **approved plan**. The agent does NOT redesign the plan or
interact with the user — it discovers resources, enriches the plan with control definitions,
and writes the output files.

#### CREATE mode

Example prompt:

> You are the canvas-app-planner agent. Write the plan document for a Canvas App.
>
> Mode: CREATE
>
> Requirements: [paste $ARGUMENTS here]
>
> Approved plan:
> [paste the full plan you presented in Step 5.3 — screens, data strategy, aesthetic
> direction, all RGBA values]
>
> User preferences (from wizard):
> - Target users & device: [answer]
> - Aesthetic direction: [answer]
> - Features: [answer]
> - Reference image: [observations, or "none provided"]
>
> Working directory: [absolute path from Phase 0]
> Plugin root: ${CLAUDE_PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Discover resources, gather control
> definitions, write App.pa.yaml and canvas-app-plan.md to the working directory. Return
> the screen list and plan document path when complete.

#### EDIT mode (complex)

Example prompt:

> You are the canvas-app-planner agent. Write the plan document for edits to a Canvas App.
>
> Mode: EDIT
>
> Edit requirements: [paste $ARGUMENTS here]
>
> Approved plan:
> [paste the full plan you presented in Step 5.3 — screens to modify/add, approach,
> all RGBA values]
>
> Current app state:
> - Palette: [exact RGBA values extracted from existing files]
> - Variables: [variable names found in existing files]
> - Layout strategy: [AutoLayout / ManualLayout as found in existing files]
> - Screens: [list of existing screens and their key controls]
>
> Working directory: [absolute working directory path]
> Plugin root: ${CLAUDE_PLUGIN_ROOT}
> Synced files: [list of .pa.yaml filenames]
>
> Follow the instructions in your agent file. Discover resources for new controls, gather
> control definitions, write canvas-app-plan.md to the working directory. Return the list
> of screens and the plan document path when complete.

**Wait for the planner to finish.** Do not proceed to Phase 6 until the planner task
completes successfully.

---

## Phase 6 — Build / Edit

After the planner completes, read `canvas-app-plan.md` from the working directory.

Extract the screen list from the `## Screens` table — collect each screen name, its target
file name, and its action (Create or Modify).

Invoke one `canvas-screen-builder` agent per screen. **Fire all invocations in a single
message** (parallel execution) — do not wait for one screen to finish before starting the
next.

For each screen, pass a prompt that includes:

- Screen name (e.g., "Home")
- Target file name (e.g., "Home.pa.yaml")
- Action: "Create" (new screen) or "Modify" (existing screen being edited)
- Absolute path to `canvas-app-plan.md`
- Working directory

Example prompt per screen:

> You are the canvas-screen-builder agent. [Create / Modify] the **[Screen Name]** screen.
>
> - Action: [Create / Modify]
> - Target file: [ScreenName].pa.yaml
> - Plan document: [absolute path to canvas-app-plan.md]
> - Working directory: [absolute path from Phase 0]
>
> Follow the instructions in your agent file. [Write / Edit] [ScreenName].pa.yaml and return
> your result when done. Do not call compile_canvas — validation is handled by the skill.

Wait for all screen-builder tasks to complete before proceeding.

---

## Phase 7 — Validate and Fix

After all screen-builders have finished writing their files, call `compile_canvas` on the
working directory.

**On success:** Proceed to Phase 8.

**On failure:** Read every error in the output. Errors will reference specific files and
line numbers. For each error:

1. `Read` the referenced `.pa.yaml` file
2. Fix the error using `Edit`
3. After fixing all errors from this pass, call `compile_canvas` again

Repeat until `compile_canvas` reports no errors. Do not give up after a single fix attempt —
iterate until the entire directory compiles clean.

Track how many `compile_canvas` passes were needed.

---

## Phase 8 — Summary

Delete `canvas-app-plan.md` from the working directory using `Bash`:
`rm <working-directory>/canvas-app-plan.md`

Present a final summary based on the mode:

**CREATE mode:**

> **App generation complete.**
>
> | Screen | File | Status |
> |--------|------|--------|
> | [Screen Name] | [filename].pa.yaml | Created |
>
> **Compiled clean** after [N] pass(es). | **Screens:** [N] | **Data:** [source or collections]

**EDIT mode (complex):**

> **Edit complete.**
>
> | Action | Screen | File | Status |
> |--------|--------|------|--------|
> | [Create / Modify] | [Screen Name] | [filename].pa.yaml | Done |
>
> **Compiled clean** after [N] pass(es).

If any errors remain after exhausting fixes, report them explicitly so the user knows what
needs manual attention.
