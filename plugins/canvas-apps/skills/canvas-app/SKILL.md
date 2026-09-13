---
name: canvas-app
version: 3.0.12
description: Creates or edits a Power Apps Canvas App through the Canvas Authoring MCP coauthoring session. Handles new app generation, direct targeted edits, complex multi-screen changes, responsive layout, per-screen self-QA, and compile-error convergence. Trigger on requests to create, build, generate, modify, update, change, fix, or edit a Canvas App or .pa.yaml files.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Read, Write, Edit, apply_patch, Bash, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, EnterPlanMode, ExitPlanMode, mcp__canvas-authoring__sync_canvas, mcp__canvas-authoring__compile_canvas, mcp__canvas-authoring__describe_control

---



# Create or Edit a Canvas App

Create or edit a Power Apps canvas app for:

$ARGUMENTS

## Establish the Workspace

Canvas Authoring tools operate on a local directory containing the app YAML.

1. Treat `${PLUGIN_ROOT}` as immutable runtime provenance. Never derive it from the
   current directory, app workspace, repository root, or a sibling worktree.
2. Read `${PLUGIN_ROOT}/skills/canvas-app/SKILL.md` and require `version: 3.0.12`.
   Read `${PLUGIN_ROOT}/references/QAChecks.md` and require
   `QACHK-SHARED-SOURCE-DERIVATION`. If either check fails, stop with the expected and
   observed paths and versions; do not mix prompt generations.
3. Reuse the current directory when it already contains `App.pa.yaml` and every existing
   file in that directory is a `.pa.yaml` file.
4. Otherwise, reuse the single immediate child directory containing `App.pa.yaml`, when
   exactly one exists and every existing file in it is a `.pa.yaml` file.
5. Otherwise, derive a short kebab-case folder name from the app name or requirements,
   create a new empty directory with `Bash`, and resolve its absolute path. If that name
   already exists and contains non-YAML files, choose a fresh suffixed name rather than
   synchronizing into it.
6. Call `sync_canvas` with that absolute working directory before reading or editing app
   files. The directory must be dedicated to this app and contain no non-`.pa.yaml` files
   when synchronization starts; never pass the repository root or `${PLUGIN_ROOT}`. Do not
   call `sync_canvas` against the working directory again after planning or acceptance
   documents have been created there. Do not proceed if the initial sync fails.

Always use absolute paths for app files.


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
3. When the app contains record cards, rows, lists, or details, verify its
   `## Required Record Fields` table has one stable key for the canonical identity and
   every field the requirements say users must see. Reject a time-only, identity-only, or
   action-only surface when additional title, person, time, description, status, or other
   values are requested.
4. Verify its `## Action Contracts` table:
    - Every requested or approved action has its own row and reachable entry point.
    - Create, edit, delete, search, filter, approve, reject, period, and export behaviors
      are not collapsed into vague combined rows.
    - When review distinguishes approved and rejected outcomes, Approve and Reject/Decline
      have separate contracts owned by the same eligible record surface.
    - Opposing transitions such as Receive/Issue, Increase/Decrease, Credit/Debit,
      Allocate/Release, Check-in/Check-out, and Enable/Disable have separate contracts even
      when one shared form implements both.
    - When opposing actions use a shared-operation flow — directional selector events
      commit operation state and a distinct guarded event consumes that state to mutate —
      each selector is selection-only and that distinct event is the single mutation entry
      point, regardless of control name or label. Both contracts name that same mutation
      event and operation state; a
      selector that calls `Patch`, `SubmitForm`, `Collect`, `Remove`, `RemoveIf`,
      `UpdateIf`, or a connector mutation is invalid. Separate direct-action controls
      remain valid when no distinct shared mutation event exists and each action has its
      own selected-ID and amount eligibility gates. Their control identity commits
      direction, so they need no shared operation variable/reset.
    - Every mutation names an observable bound result, not only a confirmation message.
    - Every mutation declares a write set and receipt proof set. For create/edit, reject the
      plan when any user-entered or user-selected write-set field is absent from the proof set.
    - Supporting setup actions exist when required to exercise an explicitly requested
      lifecycle, relationship, comparison, or ranking.
    - Role-scoped management of all primary records includes separate visible select/edit/save
      and remove/cancel paths, not only review or status controls.
    - Create/edit contracts define required inputs, directly selectable finite choices,
      stable identity, edit prepopulation, cancel/reset behavior, and post-save evidence.
    - Every row names a precondition, source and stable identity, exact transition and
      postcondition, observer reading that source, and visible evidence.
5. Verify its `## Functional Test Matrix`:
    - Every Action Contract has at least one deterministic Given/When/Then success row.
    - Every required invalid, blocked, empty, clear/reset, or boundary path has a row.
    - Every direction of an opposing pair has its own concrete scenario with explicit old
      value/state, selected operation, amount when applicable, and expected new value/state.
    - Every `Then` names a source postcondition and an evidence surface that reads it.
    - Local/mock scenarios use concrete seeded IDs and values. Filter scenarios include at
      least two matching records and one non-matching record.
    - EDIT scenarios cover existing behavior touched by changed sources, fields, controls,
      or observer formulas.
6. When the plan contains an opposing directional pair, require `## Directional Mutation
   Evidence` before dispatch. It must state a nullable selected-ID state with blank reset
   and row assignment, the actual operation state with an entry/success `Blank()` reset
   event, representable blank/non-positive amount bindings, a disabled invalid submission
   gate, exact final formulas for both directions, a canonical-source observer, and receipt bindings for
   operation, old value, amount, expected value, and actual persisted value. For a
   shared-operation flow, the plan must also identify each selection-only binding, the
   common guarded mutation event, and their common operation state.
7. Verify its `## Dispatch` table:
    - Every row has `Action`, `Screen`, `Target File`, `YAML Key`, `Name Prefix`, and
      `Screen Brief`.
    - CREATE rows use `Create`; EDIT rows use `Modify` or `Create`.
    - Target files and screen briefs are absolute paths under `[working directory]`.
    - No two rows target the same file.
    - No two rows share a `Name Prefix`.
    - In CREATE mode the first row targets `[working directory]/Screen1.pa.yaml` with YAML key `Screen1`.
    - `## Editor State Changes` exists and contains exact final order lists or `None`.
7. Confirm `[working directory]/canvas-app-shared.md` and every dispatch row's `Screen Brief` exists.
   Verify each brief's assignment matches its dispatch row and includes every Action
   Contract owned by that screen under `## Required Actions` and every scenario it
   exercises under `## Functional Test Scenarios`. It also includes every
   `## Required Record Fields` row owned by that screen with an exact bound control,
   formula, hierarchy, visibility rule, and layout budget.
8. Before dispatch, read every brief and reject it when:
    - a used control lacks its exact creation keywords, supported input-property names, or
      the full `Enum name:` and compile-ready enum literal required by discovery;
    - a Required Action is only an identifier or summary instead of its complete
      precondition, event, source/stable identity, postcondition, observer, and evidence;
    - a Functional Test Scenario is only an identifier instead of complete
      Given/When/Then text, boundary conditions, and expected evidence; or
    - it contains an unresolved placeholder or delegates discovery to the builder.
9. In EDIT mode, apply the `### Before builders` group of `## App Changes` to
   `[working directory]/App.pa.yaml` now. Screens bind to those collections, formulas and variables, and
   compiling them against a stale `App.pa.yaml` produces a flood of false name errors.
10. Confirm the planner reported a clean `compile_canvas` for `[working directory]/App.pa.yaml`. If it
   did not, compile now and resolve every `App`-level diagnostic before dispatching.
    For EDIT mode, compile after applying the before-builder app changes and resolve
    App-level diagnostics before dispatching.
11. Invoke one general-purpose agent with `Task` per dispatch row and instruct it to read
   and follow `${PLUGIN_ROOT}/agents/canvas-screen-builder.md` using the supplied
   assignment. Run these workers in waves of **at most three**. Fire each wave together,
   wait for it to return, then dispatch the next.

Never dispatch more than three builders at once. Larger fan-outs have hung without
returning, and waves of three get you the first compile sooner, which is where systemic
defects surface.

If any pre-dispatch check fails, do not start builders. Re-invoke the planner with the
specific defects and repeat the checks on the corrected artifacts.


If the planner reports that writing is unavailable or denied, or returns without the
required artifacts for that reason, write the planner's complete inline artifact payloads
verbatim with `apply_patch`; do not redesign or rediscover them. If any payload is absent
or cannot be written, stop and report the tooling failure.
If the planner returns `Status: Provenance Blocked`, stop without a fallback; mixed prompt
generations cannot produce trustworthy artifacts.


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

- Confirm every dispatched builder and every targeted self-QA follow-up has returned before
  final validation begins. Do not leave a worker running or queued that can write after the
  final compile.
- Treat final validation as a one-way barrier. Before crossing it, finish every `Task`,
  `read_agent`, builder repair, QA follow-up, inspection, and evidence update that could
  require another workspace change. Once final validation begins, do not launch or resume
  an agent.
- Check each builder's `Functional:` section before accepting its QA report. It must
  contain exactly one `PASS` trace per Required Action in that screen's brief, and each
  trace must name the precondition, control event, source/stable-ID operation,
  postcondition, and observer/evidence. A missing link, generic claim, or `BLOCKED` result
  sends that screen back for targeted repair and a corrected trace; do not accept
  checklist `PASS` as a substitute.
- Check each builder's QA coverage, repairs, and N/A lines. Treat these as unrun and send
  the screen back for self-QA only — not a rebuild — before you compile:
    - missing `QA coverage: 1-44 COMPLETE`, repair, or N/A lines;
    - any legacy `QA: 1 PASS` checklist or repair entry that does not use
      a defined `QACHK-*` identifier followed by `FIXED(n)`;
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
    For `QACHK-NO-HEIGHT-TRAP`, `QACHK-GALLERY-ROW-FITS-CONTENT`,
    `QACHK-HORIZONTAL-BUDGET`, and `QACHK-PRIMARY-ACTION-REACHABILITY`, reject bare PASS
    claims without numeric branch evidence.
    This costs one cheap turn. The defects these checks catch — clipped headings, invisible
    buttons, placeholder cards — are invisible to `compile_canvas`, so if you skip this the
    app ships broken while reporting clean.
- If any builder says checks 42-44 are undefined, stop instead of rerunning self-QA.
Report the guide path and highest defined check as `Status: Provenance Blocked`.
- A self-QA follow-up is not a rebuild or a screen-generation re-dispatch. Tell the
  builder to inspect and repair the existing target file, then return the corrected QA
  coverage, repairs, and N/A lines without regenerating the screen.
- Compare every repeated navigation block against `[working directory]/canvas-app-shared.md`: same
  destination items, same order, no extra brand/label injected into one screen's nav,
  and width formulas that fit the narrowest target. This is an app-wide check builders
  cannot perform because each sees only one screen.
- In CREATE mode, inspect every planned screen file and reject a root-only screen. Each
  screen must contain at least one meaningful visible leaf control beneath its screen root;
  the screen root and layout containers do not count. Repair any missing screen content
  before entering final validation. A clean compile alone does not prove that the generated
  controls reached the coauthoring session.
- Verify each `## Action Contracts` row end to end against the generated files: the entry
  point is reachable, the named event is wired, and the observable result is visible
  immediately after the action. For mutations, require an in-viewport receipt bound to the
  returned record, changed stable ID, or deletion snapshot. Compare the handler formula,
  declared write set, declared proof set, and receipt controls one-for-one. For create/edit,
  every user-entered or user-selected field written by the handler needs a readable labeled
  receipt binding. Navigation, a notification, hidden state, or a row somewhere in a longer
  list cannot replace it. Compile success does not prove runtime usability.
- For a shared-operation flow, inspect the final YAML and verify selectors only set the
  declared operation state plus optional receipt/display state, never mutate, while the
  distinct event that performs the guarded mutation is the only mutation entry point. The
  actual operation state is the one this mutation event consumes. Both directional
  contracts must resolve to that exact event and state. Verify an event-bearing selector
  can assign that state, the invalid gate blank-checks it, and the gated control owns or
  routes to the mutation. Reject a dead gated control beside selector buttons that mutate
  directly. Verify each `+`/`-` expression is inside the branch for its selected operation,
  not merely present elsewhere in the handler. Preserve independently gated direct-action
  implementations when no distinct shared mutation event exists.
- Verify shared operation state resets to `Blank()` on action-screen entry and/or after a
  successful Apply. `App.OnStart`-only blanking is stale-state risk, and an amount
  control's blank `Default` is not operation-reset evidence.
- When a classic Dropdown with nonempty `Items` supplies operation state, require
  `AllowEmptySelection: =true` before its blank default/reset proves no operation. For a
  Combo box require `DefaultSelectedItems: =[]`; do not assign `AllowEmptySelection`, and
  do not prescribe unsupported empty-selection properties for a List box. Prefer explicit
  operation state when discovered control semantics are uncertain.
- For every opposing mutation pair, verify both contracts and both concrete scenarios.
  The operation control is visible and pointer-selectable; submission is disabled while
  operation or required amount/value is hidden, clipped, blank, invalid, unset, or
  unreachable; and the handler reads the current explicit selection rather than stale or
  default state. For arithmetic pairs, substitute the scenario values and verify increase
  uses `old + amount`, decrease uses `old - amount`, and the receipt shows operation, old
  value, amount, expected new value, and actual persisted new value.
- Verify one nullable selected ID is initialized/reset blank, assigned from the row event,
  and consumed consistently by selected-item display, gate, mutation, receipt, and
  compound evidence. This is the default incomplete-state proof. Reject
  `Control.Selected` / `.Selected.*` from a Gallery, Dropdown, List box, or Combo box as
  no-selection proof when nonempty `Items` may auto/default-select, unless empty-selection
  semantics are configured and evidenced.
  Reject acceptance prose that disagrees with final code.
- For required NumberInput amounts, verify `Default`, `Min`, `Value`, `ValidationState`,
  and `Reset` together permit both blank and non-positive test states while visibly
  rejecting them. `Min: =1` cannot support a scenario that enters `0`; `Default: =0`
  is valid with `Min <= 0`, a rejecting gate, and Reset that restores zero. Apply the same
  validity checks when `OnChange` stages the amount.
- Accept either supported non-positive gate spelling, `value <= 0` or
  `Not(value > 0)`; do not rewrite it into a form the acceptance validator does not
  recognize.
- Require a separate literal guard for each directional branch. An `else` or default
  `Switch` arm does not prove a direction because blank or unexpected operation state can
  fall through to it.
- Treat global `var*` and screen-context `loc*` operands alike: a reachable event must
  assign them from live input with `Set(...)` or `UpdateContext({...})` before `Patch`, or
  the mutation must read the input inline. `App.OnStart`/`Screen.OnVisible`-only and
  after-`Patch` assignments are not live evidence.
- Execute every `## Functional Test Matrix` row symbolically against the final formulas.
  Confirm the Given state makes the entry point eligible, the When event targets the
  declared source and stable ID, the Then values follow from the operation, and the
  evidence formula reads that post-state. Repair the owning file when any link depends on
  an unstated assumption or a different source/field.
- For every primary-record list, verify each row or its immediately reachable detail renders
  the canonical human-readable identity as full visible text. Avatar initials, icons,
  record IDs, accessible labels, or evaluator inference cannot replace the identity.
- Verify every `## Required Record Fields` row against final YAML. The named control must
  exist inside the declared record surface, bind the current record's required source
  field, and remain visible, non-zero-sized, readable, and inside the card or row in the
  normal desktop and phone layouts. Repair missing, hidden, blank, clipped, or displaced
  fields, then compile and repeat this field check before writing acceptance evidence.
- For every Gallery, confirm row `LayoutDirection` and Gallery `TemplateSize` use the same
  breakpoint source or evaluate every reachable cross-branch pair. A row child's
  `Parent.Width` is gallery/template-scoped and may differ from the outer parent used by
  `TemplateSize`. Require numeric vertical budgets including padding, gaps, all children,
  required quantity/status fields, badges, and actions; clipped required fields fail.
- For all nested AutoLayout containers, use one screen-level width source for coordinated
  parent `Height`, child `LayoutDirection`, and related branches. Do not independently use
  each nesting level's `Parent.Width`, because padding changes scope. Otherwise enumerate
  and numerically budget every reachable cross-branch combination.
- Numerically verify every horizontal branch: container content width after padding must
  fit child fixed/`LayoutMinWidth` totals plus gaps. A `FillPortions > 0` child contributes
  its explicit numeric `LayoutMinWidth`, with absent/zero contributing zero; do not require
  `Width` for that child. Require every non-fill child to have numeric `Width`, and use the
  greater of it and numeric `LayoutMinWidth`; a positive minimum does not bound a symbolic
  width. Require wrapping, visible horizontal scrolling, vertical layout, or a higher
  threshold when the total does not fit. Protect the amount control and primary mutation
  action. Only exact `Scroll` or `LayoutOverflow.Scroll` escapes the horizontal budget;
  a conditional formula containing `Scroll` does not exempt non-scroll branches.
- Numerically verify every fixed-height vertical branch: child fixed/minimum heights,
  wrapped text, gaps, and padding must fit `Height`. In non-scrolling fixed sections, an
  unresolved container or child height fails until numeric container/child `Height`
  evidence is present; apply numeric `LayoutMinHeight` as a floor. Exempt the canonical
  `Height: =Parent.Height` screen root and deliberate vertical-scroll containers only when
  no direct child has `FillPortions > 0`. `AutoHeight` text in a fixed-height panel still
  needs a numeric `Height`/`LayoutMinHeight` budget or relocation into an intentionally
  scrolling/viewport-root layout. Protect Save/actions and keep all five visibly labeled
  receipt fields—operation, old, amount, expected, actual—together.
- Treat every layout budget as static formula/bounds evidence, never as proof that the
  running browser rendered, scrolled, or exposed the control. Runtime reachability still
  requires browser evidence.
- When Approve and Reject/Decline are paired contracts, verify every eligible pending record
  exposes both decisions on the same row or the same immediately reachable detail at phone
  width. Send the owning screen back when either decision is missing; never accept a
  single-sided review queue as a density tradeoff.
- For every create/edit lifecycle, verify short static choices use radio buttons, visible
  choice buttons, or a dropdown that commits by click or tap without typed filtering, then
  trace create → bound mutation receipt → visible Edit → prepopulated form → stable-ID save
  → bound mutation receipt with updated values. At phone width, verify identity,
  status, and required lifecycle actions remain visible or have an immediately visible
  overflow/detail entry. Send only the owning screen back for self-QA when any link is
  missing.
- Reject `QACHK-CARD-PLACEHOLDER` `PASS` when a ModernCard displays Title, Subtitle and
  Description with `Height < 180`; send that screen back for self-QA.
- If a builder returns `Status: Blocked`, re-invoke the planner to correct that screen
  brief, then rerun only the affected builder. Never ask a builder to guess missing
  definitions.
- If a general-purpose screen worker cannot write its target, stop and report the exact
  tooling failure. Do not retry with a custom screen builder whose write restriction is
  already known.
- If a builder returns `Status: Provenance Blocked`, stop the wave without a fallback and
  report the mismatched plugin root or contract version.
- `Status: Blocked` is the **only** reason to repair a brief and rerun its specialist
generation. Tooling failures stop the run. Compile diagnostics trigger neither path.
Once a screen file exists, repair it in place with targeted edits; regenerating it
discards prior fixes and does not converge.
- In EDIT mode, apply the `### After builders` group of `## App Changes` in
  `[working directory]/canvas-app-plan.md` to `[working directory]/App.pa.yaml`. The `### Before builders` group was
  already applied at pre-dispatch. If a group says `None`, do not edit the file for it.
- The orchestrator is the sole owner of EDIT changes to `[working directory]/App.pa.yaml`.
- Apply `## Editor State Changes` from `[working directory]/canvas-app-plan.md` to
  `[working directory]/_EditorState.pa.yaml` after all builders finish. If it says `None`, leave the
  file unchanged.
- Read `${PLUGIN_ROOT}/references/ValidationWorkflow.md` and follow it.
- Complete every app, planning, and acceptance-artifact write before the final compile.
  The final successful `compile_canvas` must occur after the last `edit`, `create`, or
  `apply_patch` and must be the final tool call before the summary. After
  `compile_canvas` succeeds, return immediately without making another tool call. If any
  later tool call, delegation, write, inspection, or repair occurs, the compile is no
  longer final: finish that work, wait for every agent, and repeat the final
  generation-proof gate.

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
4. **Copy control creation keywords from `describe_control`.** `list_controls` provides
   the name used to query `describe_control`; it is not the authority for authored YAML.
   Copy the returned `Control:` value and every required `ComponentName`,
   `ComponentLibraryUniqueName`, `Variant`, and `Layout` keyword verbatim. Never strip,
   normalize, or reconstruct those values.
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
11. Compile after each builder wave.
12. Do not report completion until the workspace compiles clean, every Action Contract has
   a passing evidence row in `[working directory]/canvas-app-acceptance.md`, and no app YAML mutation
   occurred after the final successful compile.
13. Require only prompt- or approved-plan-derived actions. Treat role-scoped management of
   primary records as a lifecycle requirement, but do not add universal CRUD to every
   entity.
