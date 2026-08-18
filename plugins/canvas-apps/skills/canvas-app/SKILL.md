---
name: canvas-app
version: 3.0.1
description: Creates or edits a Power Apps Canvas App through the Canvas Authoring MCP coauthoring session. Handles new app generation, direct targeted edits, complex multi-screen changes, responsive layout, per-screen self-QA, and compile-error convergence. Trigger on requests to create, build, generate, modify, update, change, fix, or edit a Canvas App or .pa.yaml files.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, EnterPlanMode, ExitPlanMode, mcp__canvas-authoring__sync_canvas, mcp__canvas-authoring__compile_canvas, mcp__canvas-authoring__describe_control
---

# Create or Edit a Canvas App

Create or edit a Power Apps canvas app for:

$ARGUMENTS

## Establish the Workspace

Canvas Authoring tools operate on a local directory containing the app YAML.

1. Reuse the current directory when it already contains `App.pa.yaml`.
2. Otherwise, reuse the single immediate child directory containing `App.pa.yaml`, when
   exactly one exists.
3. Otherwise, derive a short kebab-case folder name from the app name or requirements,
   create it with `Bash`, and resolve its absolute path.
4. Call `sync_canvas` with that absolute working directory before reading or editing app
   files. Do not proceed if sync fails.

Always use absolute paths for app files. Never edit `_EditorState.pa.yaml`; Studio owns it.

## Route the Request

Inspect the synced `.pa.yaml` files before choosing a workflow. A blank app normally contains
`App.pa.yaml`, `Screen1.pa.yaml`, and `_EditorState.pa.yaml`.

Treat the app as empty when it has no screens with meaningful leaf controls. Containers
without leaf controls do not make the app non-empty.

- **Empty app:** read `${PLUGIN_ROOT}/references/CreateWorkflow.md` and follow it.
- **Existing app:** read `${PLUGIN_ROOT}/references/EditWorkflow.md` and follow it.

Do not load both workflow documents.

## Planned Build Handoff

CREATE and complex EDIT workflows return here after the planner finishes.

1. Read `[working directory]/canvas-app-plan.md` returned by the planner.
2. Verify its `## Requirement Coverage` table maps every concrete requested noun and
   interaction to a visible affordance. Any approximation must be explicit and must not
   use UI copy that claims the unavailable interaction is exact.
3. Verify its `## Dispatch` table:
   - Every row has `Action`, `Screen`, `Target File`, `YAML Key`, `Name Prefix`, and
     `Screen Brief`.
   - CREATE rows use `Create`; EDIT rows use `Modify` or `Create`.
   - Target files and screen briefs are absolute paths under `[working directory]`.
   - No two rows target the same file.
   - No two rows share a `Name Prefix`.
   - In CREATE mode the first row targets `[working directory]/Screen1.pa.yaml` with YAML key `Screen1`.
4. Confirm `[working directory]/canvas-app-shared.md` and every dispatch row's `Screen Brief` exists.
   Verify each brief's assignment matches its dispatch row.
5. In EDIT mode, apply the `### Before builders` group of `## App Changes` to
   `[working directory]/App.pa.yaml` now. Screens bind to those collections, formulas and variables, and
   compiling them against a stale `App.pa.yaml` produces a flood of false name errors.
6. Confirm the planner reported a clean `compile_canvas` for `[working directory]/App.pa.yaml`. If it
   did not, compile now and resolve every `App`-level diagnostic before dispatching.
   For EDIT mode, compile after applying the before-builder app changes and resolve
   App-level diagnostics before dispatching.
7. Invoke `canvas-screen-builder` once per dispatch row, in waves of
   **at most three**. Fire the wave's invocations together in one message, wait for that
   wave to return, then dispatch the next.

Never dispatch more than three builders at once. Larger fan-outs have hung without
returning, and waves of three get you the first compile sooner, which is where systemic
defects surface.

If any pre-dispatch check fails, do not start builders. Re-invoke the planner with the
specific defects and repeat the checks on the corrected artifacts.

Pass each builder only:

```text
Action: [Create / Modify]
Screen: [logical screen name]
Target file: `[working directory]/[file].pa.yaml`
YAML screen key: [key from dispatch row]
Control name prefix: [prefix from dispatch row]
Shared plan: `[working directory]/canvas-app-shared.md`
Screen brief: `[working directory]/[file-base].screen-plan.md`
Plugin root: ${PLUGIN_ROOT}
```

The target file, YAML key, and name prefix are authoritative. Modify actions preserve the
key already present in the target file.

Compile after each wave returns, before dispatching the next. A systemic mistake in the
first wave is usually repeated in every later screen. Repair files that already exist in
place; only rows still waiting for dispatch receive corrected briefs.

A between-wave compile can report a `Navigate` target that belongs to a later wave as
unrecognized. Confirm it matches a remaining dispatch row and leave it in place.

After all builders finish:

- Check each builder's `QA:` line. It must list an outcome for every check in
  `${PLUGIN_ROOT}/references/QAChecks.md`. Treat these as unrun and send the screen back for self-QA
  only — not a rebuild — before you compile:
  - a missing or truncated `QA:` line, a line that omits any check listed in
    `${PLUGIN_ROOT}/references/QAChecks.md`, or a bare fix count;
  - an outcome that contradicts the screen structure — for example,
    `QACHK-CROSS-AXIS-ALIGNMENT` is `N/A` despite AutoLayout children,
    `QACHK-ACCESSIBLE-LABEL-MISSING` is `N/A` despite content or input controls,
    `QACHK-LOW-CONTRAST-TEXT` is `N/A` despite a non-default coloured surface, or
    `QACHK-ROOT-CONTAINMENT` is `PASS` while a responsive root has screen-level siblings;
  - `QACHK-GALLERY-ROW-FITS-CONTENT` is `N/A` despite the screen containing a Gallery;
  - `QACHK-ACTION-LABEL-FIT` is `PASS` while a multiword action directly under vertical
    AutoLayout lacks `Width: =Parent.Width`;
  `PASS` is valid after a complete inspection finds no defect; never reject it solely
  because the screen has many controls.
  This costs one cheap turn. The defects these checks catch — clipped headings, invisible
  buttons, placeholder cards — are invisible to `compile_canvas`, so if you skip this the
  app ships broken while reporting clean.
- A self-QA follow-up is not a rebuild or a screen-generation re-dispatch. Tell the
  builder to inspect and repair the existing target file, then return the corrected
  `QA:` line without regenerating the screen.
- Compare every repeated navigation block against `[working directory]/canvas-app-shared.md`: same
  destination items, same order, no extra brand/label injected into one screen's nav,
  and width formulas that fit the narrowest target. This is an app-wide check builders
  cannot perform because each sees only one screen.
- Reject `QACHK-CARD-PLACEHOLDER` `PASS` when a ModernCard displays Title, Subtitle and
  Description with `Height < 180`; send that screen back for self-QA.
- If a builder returns `Status: Blocked`, re-invoke the planner to correct that screen
  brief, then rerun only the affected builder. Never ask a builder to guess missing
  definitions.
- `Status: Blocked` is the **only** reason to rerun screen generation from a brief.
  Compile diagnostics are not. Once a screen file exists you repair it in place with
  targeted edits. Re-running generation rewrites the whole screen from scratch, discards
  the fixes already applied, and produces a fresh crop of defects. That loop does not
  converge.
- In EDIT mode, apply the `### After builders` group of `## App Changes` in
  `[working directory]/canvas-app-plan.md` to `[working directory]/App.pa.yaml`. The `### Before builders` group was
  already applied at pre-dispatch. If a group says `None`, do not edit the file for it.
- The orchestrator is the sole owner of EDIT changes to `[working directory]/App.pa.yaml`.
- Read `${PLUGIN_ROOT}/references/ValidationWorkflow.md` and follow it.

## Shared Invariants

1. Never guess control properties. Use `describe_control`; only use properties returned
   for that exact control type.
2. Use exact RGBA values and shared variable names from approved plans.
3. **Control names are unique across the entire app, not per screen.** Two screens may
   not both contain a control named `NavBar` or `btnBack`; the compiler rejects the
   second with `An entity with name '...' already exists`. Every control a builder
   writes uses the standard control-type abbreviation followed by that screen's assigned
   name prefix, such as `conDiscNavBar` or `btnDetailBack`. This applies especially to UI
   blocks repeated on many screens — nav bars, headers, toolbars, badges.
4. **Never write a version suffix on `Control:`.** Write `Control: ModernText`, never
   `Control: ModernText@1.5.0`. One suffixed instance pins the whole app to a single
   template version, and every property that exists only in the other version then fails
   with `Unknown property '...' for control type '...'` — on controls that are perfectly
   correct. One stray suffix can produce hundreds of them.
5. **Never invent an enum type name.** `describe_control` prints the exact name on the
   `Enum name:` line of each enum property. Copy it verbatim. Enum names do not follow
   from control names: `Badge.Appearance` is `BadgeCanvas.Appearance`, `Progress.Shape`
   is `Progress.Shape`, and `ModernDropdown.Appearance` is just `Appearance`. An enum
   **member** that starts with a digit must be quoted too — `DecimalPrecision.'1'`, never
   `DecimalPrecision.1`, which fails with `Expected operator` and `Expected an operand`
   rather than `Name isn't recognized`.
6. In CREATE mode, reuse `[working directory]/Screen1.pa.yaml` for the landing screen and set
   `App.StartScreen` to `=Screen1`.
7. Never navigate from `App.OnStart` or the start screen's `OnVisible`.
8. Keep mock data compact: roughly 5-8 short rows per collection.
9. Builders own exactly one screen file. The planner owns CREATE-mode `App.pa.yaml`.
   The orchestrator owns EDIT-mode `App.pa.yaml`.
10. Compile early and often. `App.pa.yaml` is validated before builders are dispatched,
    and again as soon as the first builder returns. Never defer the first compile until
    every file is written.
11. Do not report completion until the workspace compiles clean or remaining diagnostics
    are explicitly reported.
