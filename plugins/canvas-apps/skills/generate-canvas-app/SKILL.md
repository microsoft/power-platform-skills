---
name: generate-canvas-app
version: 2.0.0
description: Generate a complete, visually distinctive Power Apps canvas app with YAML. USE WHEN the user wants to create, build, or generate a Canvas App or pa.yaml files.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, mcp__canvas-authoring__compile_canvas
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

## Phase 1 — Gather Preferences (Wizard)

Before invoking the planner, use `AskUserQuestion` to collect design preferences that cannot
be reliably inferred from `$ARGUMENTS`. **Parse `$ARGUMENTS` first** to determine which
questions to skip — but a short request like "visitor check-in app" or "expense tracker"
leaves most preferences unspecified and you MUST ask.

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
   wizard entirely** and proceed directly to Phase 2.
3. Ask all applicable questions in a single `AskUserQuestion` call — do not ask them one at a time.
4. Store all answers for use in the planner prompt below.

**Target users & device influence design decisions:**
- **Desktop users** → data-dense layouts, tables, keyboard-friendly, multi-column. ManualLayout acceptable for pixel-perfect dashboards.
- **Tablet users** → touch-friendly targets, medium density, AutoLayout (responsive) so the app adapts to landscape/portrait.
- **Phone users** → large touch targets, single-column, simplified navigation, AutoLayout (responsive), minimal typing.
- **Multi-device / unknown** → AutoLayout (responsive) required.

**Layout strategy rule of thumb:** Default to **AutoLayout** (responsive) unless the user explicitly chose desktop-only or requested pixel-perfect positioning. AutoLayout uses `GroupContainer` with `Variant: Horizontal` or `Variant: Vertical` and `LayoutDirection`, which adapts to different screen sizes. ManualLayout uses fixed `X`/`Y`/`Width`/`Height` values that do not reflow.

---

## Phase 2 — Plan

Invoke the `canvas-app-planner` agent using the `Task` tool.

Pass a prompt that includes:

- The user's requirements: `$ARGUMENTS`
- The wizard answers collected in Phase 1 (target users & device, aesthetic direction, features, and any screenshot observations)
- The working directory (the absolute path resolved in Phase 0)
- The plugin root path: `${CLAUDE_PLUGIN_ROOT}`

Example prompt:

> You are the canvas-app-planner agent. Plan a Canvas App for the following requirements:
>
> [paste $ARGUMENTS here]
>
> User preferences (from wizard):
> - Target users & device: [answer or "not specified" — e.g., "Front desk staff on desktop/tablet"]
> - Aesthetic direction: [answer or "not specified"]
> - Features: [answer or "not specified"]
> - Reference image: [observations from screenshot, or "none provided"]
>
> Working directory: [absolute path from Phase 0]
> Plugin root: ${CLAUDE_PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Write canvas-app-plan.md and App.pa.yaml to
> the working directory. Return the screen list and plan document path when complete.

**Wait for the planner to finish.** The planner will present the screen plan to the user via
plan mode and wait for approval before returning. Do not proceed to Phase 3 until the planner
task completes successfully.

---

## Phase 3 — Build

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

## Phase 4 — Validate and Fix

After all screen-builders have finished writing their files, call `compile_canvas` on the
working directory.

**On success:** Proceed to Phase 5.

**On failure:** Read every error in the output. Errors will reference specific files and
line numbers. For each error:

1. `Read` the referenced `.pa.yaml` file
2. Fix the error using `Edit`
3. After fixing all errors from this pass, call `compile_canvas` again

Repeat until `compile_canvas` reports no errors. Do not give up after a single fix attempt —
iterate until the entire directory compiles clean.

Track how many `compile_canvas` passes were needed.

---

## Phase 5 — Summary

Delete `canvas-app-plan.md` from the working directory using `Bash`:
`rm <working-directory>/canvas-app-plan.md`

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
