# Validation Workflow

The orchestrator owns compilation, evidence-based functional acceptance, and the final
summary. Completion is fail-closed: the final successful compile must occur after the last
app-YAML mutation.

## Contents

- Section 0 — Compile gates: when to compile, and why gate 3 exists
- Section 1 — Compile: diagnostic tiers, parse-error coordinates, version conflicts,
  reading diagnostics, liveness, the convergence budget, repair ownership, and verifying
  before summarizing
- Section 2 — Functional conformance: post-compile transition and scenario gate
- Section 3 — Summary: the CREATE, EDIT, and unresolved report formats

## 0. Compile Gates

Compilation is not a final step. Four gates precede completion:

1. The planner compiles `[working directory]/App.pa.yaml` immediately after writing it.
2. The orchestrator confirms that result before dispatching builders.
3. The orchestrator compiles after each **wave** of builders returns, before dispatching
   the next wave.
4. After functional and layout repairs, the orchestrator compiles once more and makes no
   further app-YAML mutation before the summary.

Gate 3 exists because builders work from a shared plan. A defect in the first wave is
almost certainly repeated in every later screen. Catching it after three files is cheap;
repairing it across six finished files is not.

When gate 3 reveals a systemic defect:

- Repair the files that already exist in place, with targeted `edit` calls.
- Correct the shared plan and the briefs for rows **not yet dispatched**, so the next wave
  does not repeat the defect.
- Never re-dispatch a builder whose file already exists. A regenerated screen discards the
  repairs you just made. The only exception is a builder that returned `Status: Blocked`.

A between-wave compile only sees the screens written so far, so a `Navigate` to a screen
scheduled for a later wave reports `Name isn't recognized: '<ScreenName>'`. That is
expected. Confirm the name matches a remaining dispatch row and leave it alone — deleting
the navigation to satisfy an intermediate compile breaks the finished app.

## 1. Compile

Call `compile_canvas`.


If compilation fails, fix diagnostics in this order:

1. `YamlInvalidSyntax` parse errors
2. Control template version conflicts — `Control type '...@X' has a version that is newer
   than the current version of 'Y'` and `Another instance of control type '...' has
   already been referenced using a different version`
3. `An entity with name '...' already exists` duplicate-name errors
4. `Unknown property ...` errors
5. `[Control 'App', Property '...']` errors
6. Remaining diagnostics

For each tier:

1. Read every referenced file under `[working directory]`.
2. Fix all diagnostics in the tier.
3. Re-run `compile_canvas` before moving to the next tier.

Repeat until compilation succeeds. Do not chase cascading screen errors before earlier
tiers are clean.

### Parse errors carry coordinates — use them

`YamlInvalidSyntax` reasons report `Line`, `Col`, and for duplicate keys the location of
the first use. Open that exact line. A parse failure is always one wrong character — a
missing `=`, an unquoted `: `, a mis-indented key, a `Children:` entry without its `- `,
or a repeated property key. It is never a reason to rewrite a screen, and re-reading the
whole file instead of jumping to the reported line is the slowest possible response.

`${PLUGIN_ROOT}/references/YamlSyntax.md` maps every reason string to its cause.

**Sweep the file before you re-compile.** A parse error aborts the file, so the compiler
reports only the _first_ one it meets — the second instance of the identical mistake is
invisible until you fix the first. After correcting an unquoted `: ` in a formula, a
mis-indented `Children:` entry, or a duplicate property key, read the rest of that file and
fix every other occurrence of the same pattern in the same pass. Otherwise each one costs a
full compile cycle and burns the convergence budget on a single defect.

### Creation-keyword conflicts masquerade as unknown properties

Tier 2 sits above `Unknown property` for a reason. When instances of a control type use
creation keywords that disagree with the current `describe_control` response, the app may
bind to a different template version and report every property that exists only in the
other version as
`Unknown property 'P' for control type 'T'` — where `T` is the internal control name, not
the name you wrote. The properties are fine; the version pin is not.

Symptoms of this exact failure:

- Dozens of `Unknown property` errors naming common properties (`Color`, `FontWeight`,
  `Default`, `Font`, `Fill`) on modern controls.
- A control type in the message that does not match what you wrote — `'Text'` when your
  YAML says `ModernText`.
- One or two version diagnostics buried in the same compile output.

The fix is always the same: re-run `describe_control`, copy its complete creation-keyword
block to every instance of that type, then re-compile once. Do not edit a single property
until you have done that, and do not independently add or strip an `@version` suffix.

### Reading diagnostics

`compile_canvas` output is repetitive: one root cause emits a near-identical message for
every control that touches it. A single bad collection field name can produce hundreds of
lines. Reading all of them wastes the context you need to fix them.

- Collapse the diagnostic list to **distinct messages** before reasoning about it. Ten
  occurrences of `[Control 'X', Property 'Items'] ... invalid arguments` are one problem,
  not ten.
- Never read more than the first ~30 distinct diagnostics before re-compiling.
- If the result is spilled to a temp file because it is too large, that is itself a signal
  that you are looking at cascading symptoms. Fix the highest tier present and re-compile
  rather than paging through the whole dump.
- Fix by root cause, not by occurrence. One `App.pa.yaml` correction routinely clears
  several hundred downstream errors.

### Liveness

Every turn in the repair phase must end in an `edit` or a `compile_canvas`. Those are the
only two actions that change the outcome.

After **two consecutive turns** containing neither, stop and emit the unresolved-diagnostics
report in section 2. Do not spend a third. A repair phase that has stopped writing and
stopped compiling is not thinking — it is searching for a capability that does not exist,
and it will not recover on its own.


Reading a file, planning an approach, or delegating is not progress on its own. If you find
yourself unable to express a fix with `edit`, return to the named file and diagnostic
location. Repeated identical lines need separate targeted edits with enough surrounding
context to make each match unique.


### Convergence budget

Track the count of **distinct** diagnostics after every compile.

- Allow at most 5 compile-and-fix cycles. A cycle is one failed compile followed by your
  repair; the planner's `App.pa.yaml` gate does not count.
- Compare counts within the same tier. Clearing a parse error or a version conflict
  **reveals** diagnostics that were previously suppressed, so the total can legitimately
  rise — that is progress, not regression. Reset your baseline whenever a higher tier is
  cleared.
- Within one tier, if the distinct count does not strictly decrease across two consecutive
  cycles, stop. You are guessing, not converging.
- If two consecutive compiles return the _same_ distinct diagnostic set, your last edit
  changed nothing that mattered. Do not compile a third time hoping for a different
  answer. Re-read the exact file and line the diagnostic names, and fix that text.
- On stopping, report the remaining diagnostics explicitly as described in section 2.
  Never loop indefinitely and never claim success you have not observed.

### Repair ownership

You repair the app yourself. You already hold the plan, the dispatch table, and the
diagnostic history, and a fresh agent would have to rediscover all of it.

- Fix compile diagnostics with targeted `edit` calls against the named file. This is
  always the correct response to a diagnostic.
- Do not spawn a general-purpose agent to "fix compilation." That restarts discovery from
  zero and has no shared budget with you.
- **Do not re-invoke `canvas-app-planner` and re-dispatch builders to regenerate screens
  because the app failed to compile.** A regenerated screen is a new screen: the fixes you
  already landed are gone and a new set of defects arrives in their place. That loop does
  not converge; a handful of targeted edits does.
- The only sanctioned re-delegation is back to `canvas-app-planner` when a builder
  returned `Status: Blocked` because its brief was genuinely missing a definition or an
  assignment field — never for a diagnostic on a file that already exists.
- Modify `[working directory]/_EditorState.pa.yaml` when a diagnostic identifies it or when the requested
  screen or component-definition order requires correction. Preserve valid names and
  repair only the affected order entries.

### Establish a clean candidate

Before functional conformance:

1. Confirm every delegated builder and self-QA follow-up has returned. Do not begin
   completion checks while a worker can still write to the workspace.
2. Call `compile_canvas`, even when an earlier compile was clean.
3. If the compile fails or another repair is necessary, repair and repeat this gate.

This compile establishes a clean candidate. It is not the final generation-proof compile
because functional conformance still writes the acceptance artifact.

## 2. Functional Conformance

A clean compile proves syntax and formula binding, not that named actions change the
state users observe. After the final clean compile, read the plan index and generated
files and evaluate every `## Functional Test Matrix` row.

For each scenario, record one result:

- `PASS` only when the Given state establishes eligibility, the When interaction reaches
  the named event, the event reads or writes the named source and stable ID, the Then
  postcondition follows from the formula, and the evidence surface observes that same
  source/post-state.
- `FAIL` when any link is missing, contradictory, stale, bound to another source or field,
  dependent on an unstated runtime assumption, or supported only by navigation,
  notification, input text, or static copy.

Write the result to `[working directory]/canvas-app-acceptance.md`:

```markdown
Runtime evaluation: NOT RUN


Plugin root: [exact plugin root]
Skill contract version: [version read from SKILL.md]
Source revision: [git revision, package version, or "unavailable"]


## Action Contract Acceptance

| Action   | Entry control | Event formula   | Source / stable ID    | Observer formula | Reachability      | Result |
| -------- | ------------- | --------------- | --------------------- | ---------------- | ----------------- | ------ |
| [action] | [control]     | [exact final-YAML `Control.Property: =formula` binding(s)] | [source and identity] | [exact formula]  | [path and bounds] | PASS   |

## Required Record Field Evidence

| Field key | Bound control | Exact formula | Record hierarchy | Visibility and layout evidence | Result |
| --------- | ------------- | ------------- | ---------------- | ------------------------------ | ------ |
| [key]     | [control]     | [formula]     | [card/row/detail path] | [normal-state bounds and text fit] | PASS |

## Data Entry Label Evidence

| Control | Visible label binding | Shared layout region |
| ------- | --------------------- | -------------------- |
| [required input] | [exact `lblField.Text` binding, unless a supported native visible Label is used] | [field row/group shared by label and input] |

## Functional Test Matrix Results

| Scenario   | Static trace result | Evidence                       |
| ---------- | ------------------- | ------------------------------ |
| [scenario] | PASS                | [Action Contract and observer] |

## Directional Mutation Evidence

| Pair | Selected-record expression | Operation-state reset binding | Invalid-submit gate | Receive/increase mutation | Issue/decrease mutation | Canonical-source observer | Receipt bindings | Result |
| ---- | -------------------------- | ----------------------------- | ------------------- | ------------------------- | ----------------------- | ------------------------- | ---------------- | ------ |
| [Receive/Issue] | [nullable selected ID; final YAML must blank-reset, row-assign, and consistently consume it] | [operation state plus exact entry/success `Blank()` reset event] | [exact `Control.Property: =formula`] | [exact `Control.Property: =formula`] | [exact `Control.Property: =formula`] | [exact `Control.Property: =formula`] | [five `<br>`-separated bindings: `operation`, `old`, `amount`, `expected`, `actual`] | PASS |

## Compound Sequence Evidence

[Include only when both directions of the pair act on the same record type. One row per pair.]

| Pair | Same-record ID expression | Sequence (start -> op1 amount -> mid -> op2 amount -> end) | Second-op old-value binding (reads mutated canonical source) | Result |
| ---- | ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| [Receive/Issue] | [exact selected ID expression] | [e.g. `Qty 10 -> Receive 3 -> 13 -> Issue 2 -> 11`] | [exact `Control.Property: =formula` sourcing the old value from the canonical collection] | PASS |

## Screen QA Evidence

| Screen   | Coverage      | Repairs                        | N/A                    |
| -------- | ------------- | ------------------------------ | ---------------------- |
| [screen] | 1-44 COMPLETE | [defined QACHK identifier followed by FIXED(n), or none] | [QACHK names, or none] |

## Layout Budget Evidence

| Screen / container | QACHK | Branch / width source | Available size | Required-size arithmetic | Protected controls | Result |
| ------------------ | ------ | --------------------- | -------------- | ------------------------ | ------------------ | ------ |
| [screen / control] | [QACHK-NO-HEIGHT-TRAP / QACHK-GALLERY-ROW-FITS-CONTENT / QACHK-HORIZONTAL-BUDGET / QACHK-PRIMARY-ACTION-REACHABILITY] | [screen-level expression and branch] | [total numeric container/root width or height] | [numeric child widths/heights + gaps + padding] | [amount, Save/Apply, receipt fields, etc.] | PASS |
```


Record the exact `${PLUGIN_ROOT}`, the verified skill version, and the plugin repository's
short Git revision. If the installed plugin is not in a Git worktree, record source
revision `unavailable`; never substitute the app workspace revision.


The artifact is authoritative over builder summaries. `Runtime evaluation: NOT RUN`
means this static acceptance validation ran, but browser/runtime evaluation did not.
It does not mean acceptance was skipped. Replace it only when a
fresh runtime evaluator returns a recorded result for this generated app.
Even a recorded runtime success for directional arithmetic (for example,
`10 + 3 = 13`, then `13 - 2 = 11`) proves only those executed transitions. It does not
prove blank-selection, blank-operation, zero/non-positive amount, reset, cross-branch
layout, or downstream visibility scenarios that were not executed and evidenced.

The first line of the file must be exactly `Runtime evaluation: NOT RUN`; do not place a
heading before it. The Action Contract table has exactly one row per Action Contract. When
the plan contains `## Required Record Fields`, the field-evidence table has exactly one
row per field key. `PASS` requires a final-YAML control inside the declared record surface,
an exact formula that reads every required source field assigned to it, and normal-state
evidence that the value is visible, non-zero-sized, readable, and inside the card or row.
Missing, hidden, blank, clipped, displaced, tooltip-only, accessible-label-only, or
time-only substitutes fail. The scenario table separately records every Functional Test
Matrix row. The Screen QA table has one row per dispatch screen and preserves each
worker's coverage, repairs, and N/A results. Copy formulas verbatim from final YAML. In
every Gallery, compare the breakpoint scope used by `TemplateSize` with the direct row
child's `LayoutDirection`: the row child's `Parent.Width` is gallery/template-scoped and
can differ from the outer parent used by the Gallery. Require the same deliberate
breakpoint source or evaluate every reachable cross-branch pair. Preserve a numeric height
budget for every case covering padding, gaps, every child, required quantity/status
fields, badges, actions, and wrapping. A required field that can clip fails even when its
control and formula exist. For horizontal budgets, a `FillPortions > 0` child contributes
its explicit numeric `LayoutMinWidth`; absent or zero contributes zero without requiring
`Width`. Non-fill children need numeric `Width`; use the greater of it and numeric
`LayoutMinWidth`, because a positive minimum cannot upper-bound a symbolic width. For
fixed-height, non-scrolling vertical budgets, unresolved container or child heights fail
until numeric container/child `Height` evidence is present, with numeric
`LayoutMinHeight` as a floor. Exempt the canonical `Height: =Parent.Height` screen root
and deliberate vertical-scroll containers only when no direct child has
`FillPortions > 0`; a direct fill child is the documented scroll trap. `AutoHeight` text
inside a fixed-height panel still needs numeric `Height`/`LayoutMinHeight` evidence or
relocation into an intentionally scrolling/viewport-root layout. Accept horizontal scroll
escape only for exact `Scroll`/`LayoutOverflow.Scroll`, never a conditional formula that
contains a scroll branch. Never correlate `Parent.Width` conditions across nesting
scopes; evaluate their cross-branch maximums, while matching `App.Width` conditions may
correlate.
In tables, preserve quoted and block-scalar formula content,
normalize formula newlines to
`<br>`, and escape `|` as `\|`; do not assume a one-line plain scalar or paraphrase an
exact formula into an action summary. A phrase such as “Action uses Patch” is not an event
formula. Record the exact final-YAML event binding for every event-bearing control involved
in selection or mutation; do not add passive value inputs that have no relevant event.
For a shared-operation flow — selector events commit operation state and a distinct guarded
event consumes it to mutate — each directional Action Contract row must contain its exact
selector event binding and the exact common mutation event binding. The two rows must name
the same mutation `Control.Property` and operation state; control names and labels do not
establish ownership. Selector bindings may set that state plus receipt/display UI state,
but must not mutate; the actual operation state is the one the mutation event consumes.
An event-bearing selector must assign it, the invalid gate must blank-check it, and the
gated control must own or route to the mutation. A dead gated control beside
direct-mutation buttons fails. When direct actions own their mutations instead,
independently gated handlers remain valid and each row records its own exact event binding.
Those independent action controls commit direction by identity and require no shared
operation variable/reset, but each still needs selected-ID and amount gates.
When a classic Dropdown with nonempty `Items` supplies operation state,
`AllowEmptySelection: =true` is required before its blank default/reset proves no
operation. For a Combo box use `DefaultSelectedItems: =[]`; do not assign
`AllowEmptySelection`, and do not prescribe unsupported empty-selection properties for a
List box. Otherwise use explicit operation state. For record selection, one nullable
selected ID is the default incomplete-state proof. `Control.Selected` / `.Selected.*` on a
Gallery, Dropdown, List box, or Combo box with nonempty `Items` does not prove no selection
unless empty-selection semantics are explicitly configured and evidenced.
Omit
`## Required Record Field Evidence` only when the plan omits
`## Required Record Fields`.

Require `## Layout Budget Evidence` with numeric rows for every applicable
`QACHK-NO-HEIGHT-TRAP`, `QACHK-GALLERY-ROW-FITS-CONTENT`,
`QACHK-HORIZONTAL-BUDGET`, and `QACHK-PRIMARY-ACTION-REACHABILITY` PASS. For horizontal
branches, record total available container/root width and compare it with left/right
padding + child fixed/minimum widths + gaps. For fixed-height vertical branches, record child fixed/minimum heights, wrapped text,
gaps, and padding against `Height`. Enumerate every reachable cross-branch combination.
Logical `App.Width`, named-root width, and root `Parent.Width` are not rendered-host
viewport evidence in embedded or scale-to-fit hosts. Record narrowest-host arithmetic
when known, but never use that self-reported row to prove the narrow branch activates.
Repeat a container in separate rows for each axis or responsive branch as needed; identify
the applicable `QACHK` and branch in each row. `Available size` is the total width/height
for that row, not a post-padding value.
Evidence must show amount controls and Save/primary mutation actions remain reachable and
all five labeled receipt fields fit together. These calculations are static evidence only;
a browser evaluation remains necessary to prove rendered reachability.

Include `## Data Entry Label Evidence` for every required classic or modern TextInput,
NumberInput, Radio, DropDown, and ComboBox consumed by accepted action formulas,
including `ModernTextInput`, `ModernNumberInput`, `ModernRadio`, `ModernDropdown`, and
`ModernCombobox`. Name the exact visible label binding and immediate shared parent/field
region. `AccessibleLabel` and `HintText` do not count. Only a `ModernNumberInput` with a
native visible `Label` may omit the row; every other type needs a sibling label.
Logical canvas width evidence is never proof that a narrow branch activates in an
embedded or scale-to-fit host; without settings exposed in `.pa.yaml`, require wrapping,
always-stacked fields, deliberate scrolling, or a statically bounded wide/default branch.

For list-driven requirements, post-export/runtime proof must include a screenshot with at
least one real data row visibly rendered and its required row action reachable. A runtime
probe reporting only four interactive descendants is hard-fail evidence for an expected
multi-control/list screen, not support for static success. Keep these claims labeled
runtime/post-export: the local static validator can reject risky Gallery shapes but cannot
prove that a host rendered rows.

When the plan contains an opposing directional pair, include `## Directional Mutation
Evidence` with exactly one row per pair. This is an executable gate, not a self-reported
trace: copy final-YAML formulas exactly. The validator independently requires one nullable
selected ID initialized/reset blank and assigned by row selection, consistent consumers,
an actual operation-state reset event, representable blank/non-positive amount states, a
gate that rejects them, plus/minus arithmetic, one canonical source
read by the observer, and five receipt bindings including an actual persisted `Patch`
result. The operation selector, amount, submit, and validation/status surface must remain
visible in invalid states; the submit may be disabled but neither it nor a required
ancestor may be gated to the selected/valid state. A gallery-only selected-ID event also
requires bounded Gallery `Height`, explicit positive `TemplateSize`, numeric
`TemplatePadding`, `Items`, and row controls.
For the amount rejection, accept either supported equivalent spelling in final YAML:
`value <= 0` or `Not(value > 0)`; do not prescribe a third form unsupported by the
validator.

Receipt controls may include visible label text. Static evidence still has to expose one
unambiguous underlying value expression for each required receipt field. A direct value
formula is valid, as is literal label decoration around exactly one dynamic value
expression after quoted/block-scalar normalization. When multiple dynamic expressions
could be the field value, fail with a dedicated ambiguous-receipt-expression error; do not
guess an operand or accept the visible text alone.

During final validation, cross-check the Action Contract cells against final YAML and
against `## Directional Mutation Evidence`; do not allow either table to contradict the
other. For a shared-operation flow, trace every exact selector binding into the same
operation state and the same exact distinct mutation event, then verify only that event
contains the mutation. Verify an event-bearing selector assigns that exact state, the
invalid gate blank-checks it, the gated control owns or routes to the mutation, and the
mutation consumes it. Reject a dead gated control beside direct-mutation buttons. For
arithmetic pairs, associate the operation values with their
specific branches and prove increase reaches `old + amount` while decrease reaches
`old - amount`; the mere presence of both expressions is insufficient. Require a literal
guard for each direction; an `else` or default arm is not directional proof. Perform these
comparisons on normalized formula content so quoted and block-scalar YAML forms are
equivalent after newlines are represented as `<br>`. Static text/formula checks establish
conformance, not runtime pointer reachability or event execution: a live browser
evaluation must still prove that each selector and the distinct mutation control can be
reached and clicked in the stated Given state.

The directional gate also checks the two static shapes behind QAChecks Check 34
"staging-variable liveness" and Check 43 "LookUp key integrity." A receipt old/amount
operand that is a global `var*` or screen-context `loc*` staging variable must be assigned
from a live `.Selected`, `.Text`, or `.Value` expression before `Patch`, either through
`Set(...)`/`UpdateContext({...})` in the mutation prelude or through a reachable
event-bearing input/selector control. An `App.OnStart` or `Screen.OnVisible` seed alone
fails, and an assignment after `Patch` is too late. The `LookUp`/`Filter` key used by the
mutation must use the raw selected-record expression with no concatenation or arithmetic
suffix. These checks prove that the final YAML contains a live-input assignment and an
untransformed key; they cannot prove that the running app actually fires the event, that
the control is pointer-reachable, or that the data source accepts the write. Preserve the
manual QAChecks inspection and live browser evaluation for those runtime properties.
For an `OnChange`-staged amount, liveness proves only that the variable receives an input
value. Separately verify compatible `Default`/`Min`, current-value rejection, visible
validation, and Reset restoring the chosen invalid default (`Blank()` or `0`).

When both directions of that pair act on the same record type, also include `## Compound
Sequence Evidence` with one row per same-record pair. It records the same-record ID, the
`start -> op1 -> mid -> op2 -> end` sequence, and the exact final-YAML binding that sources
the second operation's old value from the canonical collection (e.g. a `LookUp` over the
patched source), proving the second operation reads the already-mutated value, not the
original. Unlike the directional table, the validator does not machine-check this table —
no static check can prove the running app's submit button becomes clickable or that the
second read observes the mutated value; that remains the live browser evaluation's job — so
copy the formulas exactly and treat it as a required authoring/reviewer proof.

Do not replace `NOT RUN` with another value unless a runtime evaluator actually executed
against this app and the artifact records its run ID or result URL and score.


After writing the artifact, run:

```text
dotnet run --file "${PLUGIN_ROOT}/scripts/validate-canvas-acceptance.cs" -- \
  "[absolute working directory]" "${PLUGIN_ROOT}"
```

The validator compares the acceptance rows with the plan's Action Contracts, Functional
Test Matrix, and dispatch screens. A nonzero exit blocks completion. Repair the artifact
and rerun the validator until it passes; never summarize success without its `PASS`
result.

The validator itself is regression-tested. `scripts/tests/` drives it against the
`receive-issue` fixture (a correctly-signed Receive/Issue workspace must `PASS`; a
reversed-sign one must fail on the directional check) via `node scripts/run-tests.js`,
which the `canvas-apps-script-tests` CI workflow runs on every change under
`plugins/canvas-apps/**`. This is a static conformance gate only — it does not execute the
app, and a live browser evaluation remains the authority for the runtime functional grade.


For mutations, also compare the handler, write set, proof set, receipt bindings, and
downstream observer one-for-one. For filters, verify the concrete selector value is
pointer-committed into the target `Items` predicate, preserves both matching seeded
records, excludes the non-match, shows the active criterion, and clears deterministically.

Calculate:

`Functional readiness = PASS scenarios / total scenarios * 100`

The internal ship gate is **100%**, not 80%. The external goal above 80 is a measurement
target, not permission to omit one fifth of the approved behavior. If any scenario fails,
repair the owning `.pa.yaml` file with a targeted edit, compile again, and rerun all
scenarios affected by that source, field, or observer. Do not add static confirmation copy
to make a failed transition appear complete.

This is a deterministic static conformance gate because the prompt environment has no
runtime interaction tool. Report it as functional readiness, not as proof of runtime
execution. A fresh browser evaluation remains the authority for the external functional
grade.

Never report an unqualified percentage such as `100% functional` or `18/18 (100%)`.
Always include `static conformance` in the same sentence and immediately state the runtime
evaluation status.


### Verify the coauthoring round trip

Before crossing the finalization barrier, prove that the coauthoring session returns the
authored app rather than the original blank shell:

1. Use `Bash` to create a fresh empty temporary directory outside `[working directory]`.
   Do not place planning, acceptance, or other non-YAML files in it.
2. Call `sync_canvas` with that temporary directory.
3. Inspect the synchronized `App.pa.yaml` and every screen named by the plan's dispatch
   table. Every expected file must exist. In CREATE mode, every screen must contain at
   least one meaningful visible leaf control beneath its screen root; the root Screen and
   layout-only containers do not count.
4. If a screen is missing, root-only, or does not contain the controls present in the
   authored working copy, delete the temporary directory, call `compile_canvas` again,
   wait for it to succeed, and repeat the synchronization once with a new empty directory.
   If the second server snapshot is still missing or stale, stop with
   `Status: Coauthoring Sync Blocked`; do not claim generation succeeded.
5. Delete the temporary verification directory before crossing the finalization barrier.
   Never copy the synchronized snapshot over `[working directory]`.

This round trip is server-state evidence. `compile_canvas` success alone proves validation,
not that a nonblank app is observable when the browser joins the coauthoring session.


### Final generation-proof gate

Immediately before the summary:

1. Confirm `[working directory]/canvas-app-acceptance.md` has one evidence row for every
   Action Contract and every Required Record Fields key, no failed row, and has passed its
   required validation.
2. Confirm no delegated agent remains running or queued, every app, planning, and
   acceptance-artifact write is complete, and the coauthoring round-trip check above has
   passed when that check is available.
3. Cross the finalization barrier: from this point onward, do not invoke `Task`, resume an
   agent, request another QA pass, or perform another inspection. If any of those are still
   needed, remain before the barrier and complete them first.
4. Call `compile_canvas`, even when the clean-candidate compile succeeded.
5. After `compile_canvas` succeeds, return the summary immediately without making another
   tool call.
6. If any later tool call, delegation, write, inspection, or repair occurs, the compile is
   no longer final. Finish that work, confirm every agent has returned, and repeat this
   entire gate. A compile predating later activity is not final proof.

The final successful `compile_canvas` must be the final tool call. This ordering prevents
late agent waves from changing the workspace and lets external generation proof
distinguish a completed app from an app changed after validation.

## 3. Summary

For CREATE:

```markdown
**App generation complete.**

| Screen   | File           | Status  |
| -------- | -------------- | ------- |
| [Screen] | [file].pa.yaml | Created |

**Compiled clean** after [N] pass(es).
**Functional readiness:** [passed]/[total] scenarios passed static conformance.
**Acceptance evidence:** `[working directory]/canvas-app-acceptance.md`.
**Runtime evaluation:** NOT RUN.


**Plugin provenance:** [exact plugin root] · version [version] · revision [revision or unavailable].

```

For EDIT:

```markdown
**Edit complete.**

| Action            | Screen   | File           | Status |
| ----------------- | -------- | -------------- | ------ |
| [Create / Modify] | [Screen] | [file].pa.yaml | Done   |

**Compiled clean** after [N] pass(es).
**Functional readiness:** [passed]/[total] scenarios passed static conformance.
**Acceptance evidence:** `[working directory]/canvas-app-acceptance.md`.
**Runtime evaluation:** NOT RUN.


**Plugin provenance:** [exact plugin root] · version [version] · revision [revision or unavailable].

```

If diagnostics remain after the convergence budget is exhausted, report them explicitly
instead of claiming completion:

```markdown
**App generated with unresolved diagnostics.**

| Screen   | File           | Status  |
| -------- | -------------- | ------- |
| [Screen] | [file].pa.yaml | Created |

**Compile status:** [N] distinct diagnostics remain after [M] pass(es).

| Diagnostic | Occurrences | File   |
| ---------- | ----------- | ------ |
| [message]  | [count]     | [file] |

[One line on what was tried and what is likely blocking.]
```

If compilation is clean but functional scenarios remain unresolved, report them instead
of claiming completion:

```markdown
**App compiled with unresolved functional defects.**

**Functional readiness:** [passed]/[total] scenarios passed static conformance.

| Scenario   | Failed link                                                           | Owner file |
| ---------- | --------------------------------------------------------------------- | ---------- |
| [scenario] | [eligibility / event / source-ID / postcondition / observer-evidence] | [file]     |
```
