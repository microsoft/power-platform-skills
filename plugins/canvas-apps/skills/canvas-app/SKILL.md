---
name: canvas-app
version: 3.0.4
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

Inspect the synced `.pa.yaml` files before choosing a workflow. A blank app normally
contains `App.pa.yaml`, `Screen1.pa.yaml`, and `_EditorState.pa.yaml`.

Treat the app as empty when it has no screens with meaningful leaf controls. Containers
without leaf controls do not make the app non-empty.

- **Empty app:** read `${PLUGIN_ROOT}/references/CreateWorkflow.md` and follow it.
- **Existing app:** read `${PLUGIN_ROOT}/references/EditWorkflow.md` and follow it.

Do not load both workflow documents.

## Planned Build Handoff

CREATE and complex EDIT workflows return here after the planner finishes.

1. Read the absolute `canvas-app-plan.md` path returned by the planner.
2. Verify its `## Requirement Coverage` table maps every concrete requested noun and
   interaction to a visible affordance. Any approximation must be explicit and must not
   use UI copy that claims the unavailable interaction is exact.
3. Verify its `## Action Contracts` table:
   - Every concrete requested or approved-plan action has its own row.
   - Each row names a visible entry point, owner screen, control event, required behavior,
     and observable result.
   - Broad words such as "manage" have not been expanded into universal CRUD across every
     entity. A role-scoped requirement to manage all primary records still includes
     reachable list/detail, correction/update, and remove/cancel paths unless narrowed by
     the request or prohibited by the domain.
   - A review or approval workflow that distinguishes final approved records includes
     both approve and reject/decline outcomes unless explicitly defined as one-way.
   - Temporal program requirements and explicit export/report requests have operational
     contracts, shared source fields or predicates, and visible evidence.
   - Every Exact interaction in Requirement Coverage maps to at least one Action Contract.
4. Verify its `## Dispatch` table:
   - Every row has `Action`, `Screen`, `Target File`, `YAML Key`, `Name Prefix`, and
     `Screen Brief`.
   - CREATE rows use `Create`; EDIT rows use `Modify` or `Create`.
   - Target files and screen briefs are absolute paths under the working directory.
   - No two rows target the same file.
   - No two rows share a `Name Prefix`.
   - In CREATE mode the first row targets `Screen1.pa.yaml` with YAML key `Screen1`.
5. Confirm `canvas-app-shared.md` and every dispatch row's screen brief exist. Verify each
   brief's assignment matches its dispatch row and contains every Action Contract owned
   or affected by that screen.
6. In EDIT mode, apply the `### Before builders` group of `## App Changes` to
   `App.pa.yaml` now. Screens bind to those collections, formulas and variables, and
   compiling them against a stale app file produces false name errors.
7. Confirm the planner reported a clean `compile_canvas` for CREATE-mode `App.pa.yaml`.
   If it did not, compile now and resolve every App-level diagnostic before dispatching.
   For EDIT mode, compile after applying the before-builder app changes and resolve
   App-level diagnostics before dispatching.
8. Invoke `canvas-screen-builder` once per dispatch row, in parallel waves of at most
   three. Wait for the whole wave to return before dispatching the next.

Never dispatch more than three builders at once. Larger fan-outs can hang, and waves of
three expose systemic defects before every screen repeats them.

If any pre-dispatch check fails, do not start builders. Re-invoke `canvas-app-planner`
with the specific defects and repeat the checks on the corrected artifacts.

Pass each builder only:

```text
Action: [Create / Modify]
Screen: [logical screen name]
Target file: [absolute .pa.yaml path]
YAML screen key: [key from dispatch row]
Control name prefix: [prefix from dispatch row]
Shared plan: [absolute canvas-app-shared.md path]
Screen brief: [absolute screen-plan.md path]
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

- Verify every Action Contract against the generated YAML:
  - the entry control exists and is not permanently hidden, disabled, zero-sized, or
    trapped behind an entry point that does not exist;
  - the named event is non-empty and contains the required navigation, search/filter
    binding, data operation, or state transition;
  - the observable-result control reads from the source or state changed by the action,
    with refresh or collection update where required.
  A screen or entity existing is not evidence that its actions work. Return only the
  owning screen to its builder to repair a failed contract in place.
- Verify every responsive screen's sole root has exact full-screen sizing:
  `Width: =Parent.Width`, `Height: =Parent.Height`, `LayoutMinWidth: =0`, and
  `LayoutMinHeight: =0`. Reject any breakpoint, fixed width, or child-control width on a
  root even when the screen compiles.
- Verify bounded Gallery height and empty-state formulas count the same source/filter used
  by `Items`. Reject `Self.AllItems`, `Self.AllItemsCount`, or rendered
  `AllItemsCount` dependencies that can keep a populated gallery at zero height.
- Verify every mutation's observable result is visible in the immediate post-action state
  or reached by explicit navigation in the handler. A changed row hidden below a long
  form does not satisfy the contract.
- For reordering, constraints, metrics, versions, categories, and rankings, verify every
  success, boundary, rejection, persistence, and recalculation path named by the planner.
  Confirm all paths use the same shared source of truth as their visible evidence.
- For role-scoped record management, verify the primary-record list exposes reachable
  detail, update, and remove/cancel controls and that review workflows expose every planned
  decision. Verify period fields and export predicates read the same source as the lists
  and statuses shown to the user.
- Verify that local/mock-data apps include the minimum supporting setup actions needed to
  exercise requested mutations, relationships, metrics, comparisons, and rankings. This
  is not universal CRUD: require only records and fields that the requested behavior needs.
- Reject a named core visualization when its region has no bound populated-state controls,
  meaningful first-render data, relationship/comparison encoding, or truthful empty state.
- For side-by-side comparison requirements, verify two distinct labeled snapshot sources
  render simultaneously and that highlighted differences derive from stable entity IDs.
- Check each builder's `QA:` line. It must list an outcome for every check in
  `${PLUGIN_ROOT}/references/QAChecks.md`. Treat these as unrun and return the existing
  screen to the builder for self-QA only:
  - a missing or truncated line, a line omitting any check listed in
    `${PLUGIN_ROOT}/references/QAChecks.md`, or a bare fix count;
  - an outcome contradicted by the screen structure, such as
    `QACHK-CROSS-AXIS-ALIGNMENT` `N/A` despite AutoLayout children,
    `QACHK-ACCESSIBLE-LABEL-MISSING` `N/A` despite content controls,
    `QACHK-LOW-CONTRAST-TEXT` `N/A` despite a coloured surface, or
    `QACHK-ROOT-CONTAINMENT` `PASS` while a responsive root has screen-level siblings;
  - `QACHK-ROOT-CONTAINMENT` `PASS` while the root does not use exact full-screen width,
    height, and zero minimum-size formulas;
  - `QACHK-GALLERY-ROW-FITS-CONTENT` `N/A` despite the screen containing a Gallery;
  - `QACHK-ACTION-LABEL-FIT` `PASS` while a multiword action directly under vertical
    AutoLayout lacks `Width: =Parent.Width`;
  - `QACHK-HORIZONTAL-BUDGET` `PASS` without per-branch width arithmetic for a
    horizontal row;
  - `QACHK-MANUAL-BOUNDS` `N/A` despite simultaneously visible ManualLayout children;
  - `QACHK-TEXT-CONTENT-FIT` `PASS` without checking the longest planned or bound value;
  - `QACHK-VISUAL-CONTRACT` `PASS` when the screen introduces values outside the shared
    typography, spacing, surface, or action system;
  - `QACHK-CORE-VISUALIZATION` `PASS` when a named visualization has no bound
    populated-state controls or a comparison renders fewer than two labeled sources.
- Reject viewport-fit QA when a horizontal row's minimum widths, gaps, and padding exceed
  its parent in any supported branch, or when simultaneously visible ManualLayout bounds
  intersect.
- Compare each screen against the shared Visual Contract and return only divergent screens
  for repair. Typography roles, spacing scale, surfaces, and action styling must remain
  consistent across the app.
- A self-QA follow-up is not a rebuild. Ask the builder to inspect and repair the existing
  target file, then return the corrected `QA:` line.
- Compare every repeated navigation block against `canvas-app-shared.md`: same items,
  order, wordmark, colours, and narrow-width behavior. Builders cannot perform this
  app-wide comparison because each sees only one screen.
- Reject `QACHK-CARD-PLACEHOLDER` `PASS` when a `ModernCard` displays Title, Subtitle and
  Description with `Height < 180`; return that screen for self-QA.
- If a builder returns `Status: Blocked`, re-invoke the planner to repair only that screen
  brief, then rerun only that builder.
- `Status: Blocked` is the only reason to rerun screen generation. Repair compile
  diagnostics in place; regeneration discards fixes and does not converge.
- In EDIT mode, apply the `### After builders` group of `## App Changes` to `App.pa.yaml`.
  The orchestrator is the sole owner of EDIT changes to that file.
- Read `${PLUGIN_ROOT}/references/ValidationWorkflow.md` and follow it.

## Shared Invariants

1. Never guess control properties. Use `describe_control`; only write properties returned
   for that exact control type or already present on that exact existing control.
2. Use exact RGBA values and shared variable names from approved plans.
3. Control names are unique across the entire app, not per screen. Every new control uses
   the standard control-type abbreviation followed by the screen prefix, such as
   `conDiscNavBar` or `btnDetailBack`, especially for repeated nav bars, headers,
   toolbars, and badges.
4. Never write a version suffix on `Control:`. Write `Control: ModernText`, never
   `Control: ModernText@1.5.0`. One suffixed instance can produce hundreds of false
   `Unknown property` diagnostics throughout the app.
5. Never invent an enum type name. Copy the exact `Enum name:` from `describe_control`.
   Quote enum members that start with a digit:
   `DecimalPrecision.'1'`, not `DecimalPrecision.1`.
6. In CREATE mode, reuse `Screen1.pa.yaml` for the landing screen and set
   `App.StartScreen` to `=Screen1`.
7. Never navigate from `App.OnStart` or the start screen's `OnVisible`.
8. Keep mock data compact: roughly 5-8 short rows per collection.
9. Builders own exactly one screen file. The planner owns CREATE-mode `App.pa.yaml`; the
   orchestrator owns EDIT-mode `App.pa.yaml`.
10. Compile early and after each builder wave. Never defer the first compile until every
    file is written.
11. Do not report completion until the workspace compiles clean or remaining diagnostics
    are explicitly reported.
12. Require only prompt- or approved-plan-derived actions. Never add universal CRUD across
    every entity as a default. Treat role-scoped management of all primary records as a
    lifecycle requirement, and never omit or hide an action once it is included in an
    Action Contract.
