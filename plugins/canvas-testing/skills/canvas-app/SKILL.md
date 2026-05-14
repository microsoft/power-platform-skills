---
name: canvas-app
version: 3.0.0
description: Creates or edits a Power Apps Canvas App through the Canvas Authoring MCP coauthoring session. Handles new app generation from requirements, simple inline edits, and complex multi-screen changes. Triggers on requests to create, build, generate, modify, update, change, or edit a Canvas App or .pa.yaml files.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, EnterPlanMode, ExitPlanMode, mcp__canvas-authoring__sync_canvas, mcp__canvas-authoring__compile_canvas, mcp__canvas-authoring__list_controls, mcp__canvas-authoring__list_apis, mcp__canvas-authoring__list_data_sources, mcp__canvas-authoring__describe_control, mcp__canvas-authoring__describe_api, mcp__canvas-authoring__get_data_source_schema
---

# Create or Edit a Canvas App

Create or edit a Power Apps canvas app for the following requirements:

$ARGUMENTS

## Overview

This skill handles both **creating** and **editing** canvas apps through a unified workflow.
It syncs the current app state to detect whether the app has existing content, then routes
accordingly:

- **CREATE mode** — the app is empty or has no meaningful content; a new app is generated
  from scratch using a preferences wizard, resource discovery, and sequential screen building.
- **EDIT mode (simple)** — the app has existing content and the requested changes are small;
  edits are applied inline without a planning phase.
- **EDIT mode (complex)** — the app has existing content and the requested changes are
  substantial; a plan is designed, resources are discovered, and screens are built/edited
  sequentially.

All work is performed directly by this skill — there are no sub-agents. The skill discovers
MCP resources, gathers control definitions, writes plan documents, builds each screen
sequentially, and owns the compilation + error-fixing loop.

---

## Phase 0 — Create App Folder

Before syncing or editing, create a subfolder to contain the app's YAML files:

1. Extract the app name or a 2–4 word summary from `$ARGUMENTS`
2. Convert to kebab-case (e.g., "Expense Tracker" → `expense-tracker`, "my travel planner" →
   `my-travel-planner`)
3. Create the folder using `Bash`: `mkdir -p <folder-name>`
4. Resolve its absolute path — this is the **working directory** for all subsequent phases

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
4. Store all answers for use in the planning phase below.

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

## Phase 5 — Plan and Approve

You own plan design and user approval. After approval, you proceed to discover resources
and write the plan document yourself (no sub-agents).

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

### Step 5.4 — Discover Resources

After approval, discover available MCP resources to enrich the plan with real data.

#### CREATE mode

1. Call `list_controls`, `list_apis`, and `list_data_sources`. Note which are most relevant
   to the approved plan's screens.
2. Call `describe_api` for each connector the app will use — collect the full output.
3. Call `get_data_source_schema` for each data source the app will use — collect the full output.

#### EDIT mode

1. Read all `.pa.yaml` files in the working directory. Extract all screens, controls, layout
   strategies, formulas, exact RGBA color values, variable names, and data bindings.
2. If the edit adds **new controls or data sources** not already in the app, call the relevant
   list discovery tools (`list_controls`, `list_apis`, `list_data_sources`). Skip list calls
   for edits that only modify existing controls or formulas.
3. Call `describe_api` and `get_data_source_schema` for any APIs or data sources involved in
   the edit — collect the full output.

### Step 5.5 — Gather Control Property Definitions

#### CREATE mode

Call `describe_control` for **every control type** in the approved plan.
Do not skip seemingly obvious ones — property names differ significantly between Classic
and FluentV9 control families. Never assume.

#### EDIT mode

Call `describe_control` only for **new control types** being added that are not already in
the existing `.pa.yaml` files. Do not call `describe_control` for controls already present
in the existing app — their property names can be read directly from the existing YAML files.

#### Both modes

Collect the full output of each `describe_control` call for embedding in the plan document.

### Step 5.6 — Write App.pa.yaml (CREATE Mode Only)

> **EDIT mode:** Skip this step entirely. The existing `App.pa.yaml` is already in the
> working directory and will be modified in Phase 6 only if needed.

Write the app-level YAML file (`App.pa.yaml`) to the working directory. This file is shared
across all screens — do not write screen-level content here. Follow TechnicalGuide.md
conventions for app-level properties.

### Step 5.7 — Write canvas-app-plan.md

Write `canvas-app-plan.md` to the working directory. This document is the **single source of
truth** for the screen-building phase — it must be fully self-contained.

Read `${CLAUDE_PLUGIN_ROOT}/references/PlanTemplates.md` for the mode-appropriate document
structure (CREATE or EDIT). Follow the template exactly — fill in every section with real
content from the approved plan, discovery results, and control definitions. Do not omit
sections unless the template says to.

**Critical requirements for the plan document:**
- **Embed full `describe_control` output** — never summarize property names. The screen-
  building phase must be able to write correct YAML from the plan document alone.
- **Embed exact RGBA values** from the approved plan — not prose color descriptions.
  Consistent visual design across screens depends on exact values.
- **Embed full `describe_api` and `get_data_source_schema` output** for all data resources.

---

## Phase 6 — Build / Edit Screens

Read `canvas-app-plan.md` from the working directory.

Extract the screen list from the `## Screens` table — collect each screen name, its target
file name, and its action (Create or Modify).

**Process each screen sequentially.** For each screen:

### Step 6.1 — Extract Screen Context from Plan

Read `canvas-app-plan.md` and extract the context needed for this screen:

**For a Create action**, extract:
- The **Per-Screen Specification** for this screen (purpose, layout, controls, data bindings, images, navigation, state)
- The **Aesthetic Direction** section (exact RGBA values, layout strategy, typography scale)
- The **Named Variables and Shared State** section (variable names to use for consistency)
- The **Control Definitions** for every control type this screen uses (full `describe_control` output embedded in the plan)
- The **TechnicalGuide Key Conventions** section (YAML syntax rules)

**For a Modify action**, extract:
- The **Per-Screen Edit Specification** for this screen
- The **Current App Summary** section (palette, layout strategy, variables, data sources)
- The **Control Definitions** for any new control types this screen uses (full `describe_control` output embedded in the plan)
- The **TechnicalGuide Key Conventions** section (YAML syntax rules)

### Step 6.2 — Write or Edit the Screen

#### Create action — Write the screen from scratch

Write `[ScreenName].pa.yaml` to the working directory.

Follow the conventions from the plan document's TechnicalGuide Key Conventions section:

- All formulas must start with `=`
- Multi-line formulas use `|-` block scalar syntax
- String values that are not formulas must be quoted
- Use `OnVisible` for state initialization
- Use guard clauses in event handlers
- Use exact property names from the Control Definitions in the plan — never guess property names
- Use exact RGBA values from the Aesthetic Direction — never substitute similar colors
- Use exact variable names from the Named Variables section — consistency across screens is required

Write the simplest working version of each formula. The compiler will catch syntax errors —
reserve your reasoning for logic correctness that the compiler cannot catch.

#### Modify action — Apply targeted changes to the existing screen

Read the current `[ScreenName].pa.yaml` from the working directory. Then apply each change
listed in the Per-Screen Edit Specification:

- For each **property to update**: use `Edit` to change the specific value
- For each **control to add**: use `Edit` to insert the new control YAML in the correct location
- For each **control to remove**: use `Edit` to delete the control's YAML block

Follow the conventions from the plan document's TechnicalGuide Key Conventions section:

- All formulas must start with `=`
- Multi-line formulas use `|-` block scalar syntax
- String values that are not formulas must be quoted
- Use exact property names from the Control Definitions — never guess property names
- Use exact RGBA values from the Current App Summary palette — never substitute similar colors
- Use exact variable names from the Current App Summary — consistency across screens is required

Write the simplest working version of each formula. The compiler will catch syntax errors —
reserve your reasoning for logic correctness that the compiler cannot catch.

### Step 6.3 — Self-QA

After writing or editing the screen file, run the runtime anti-pattern checks that
`compile_canvas` does not catch.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/QAChecks.md` (only needs to be read once — reuse
   on subsequent screens)
2. Re-read the `.pa.yaml` file you just wrote or edited
3. Apply each check in order; for every issue found, fix it inline using `Edit`
4. Track the count and a one-line description of every fix applied

**Scope for Create actions:** apply all checks to the full new screen.

**Scope for Modify actions:** focus QA checks on controls and containers you changed or added.
Do not rewrite pre-existing issues that are unrelated to this edit — the user did not ask for
them. If a check matches a control you did not touch, skip it.

**After completing Step 6.3, move to the next screen in the list and repeat from Step 6.1.**

---

## Phase 7 — Validate and Fix

After all screens have been written/edited, call `compile_canvas` on the working directory.

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
