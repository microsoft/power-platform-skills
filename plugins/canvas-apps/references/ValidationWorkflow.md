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
Source revision: [git revision, package version, or "unavailable"]


## Action Contract Acceptance

| Action   | Entry control | Event formula   | Source / stable ID    | Observer formula | Reachability      | Result |
| -------- | ------------- | --------------- | --------------------- | ---------------- | ----------------- | ------ |
| [action] | [control]     | [exact formula] | [source and identity] | [exact formula]  | [path and bounds] | PASS   |

## Functional Test Matrix Results

| Scenario   | Static trace result | Evidence                       |
| ---------- | ------------------- | ------------------------------ |
| [scenario] | PASS                | [Action Contract and observer] |

## Screen QA Evidence

| Screen   | Coverage      | Repairs                        | N/A                    |
| -------- | ------------- | ------------------------------ | ---------------------- |
| [screen] | 1-44 COMPLETE | [QACHK-NAME FIXED(n), or none] | [QACHK names, or none] |
```


Record the exact `${PLUGIN_ROOT}` and the plugin repository's short Git revision. If the
installed plugin is not in a Git worktree, record source revision `unavailable`; never
substitute the app workspace revision.


The artifact is authoritative over builder summaries. `Runtime evaluation: NOT RUN` is
required because symbolic inspection is not browser execution. Replace it only when a
fresh runtime evaluator returns a recorded result for this generated app.

The first line of the file must be exactly `Runtime evaluation: NOT RUN`; do not place a
heading before it. The Action Contract table has exactly one row per Action Contract. The
scenario table separately records every Functional Test Matrix row. The Screen QA table
has one row per dispatch screen and preserves each worker's coverage, repairs, and N/A
results. Copy event and observer formulas verbatim from final YAML. In the table, replace
formula newlines with `<br>` and escape `|` as `\|`; do not paraphrase an exact formula
into an action summary.

Do not replace `NOT RUN` with another value unless a runtime evaluator actually executed
against this app and the artifact records its run ID or result URL and score.


After writing the artifact, run:

```text
dotnet run --file "${PLUGIN_ROOT}/scripts/validate-canvas-acceptance.cs" -- \
  "/app" "${PLUGIN_ROOT}"
```

The validator compares the acceptance rows with the plan's Action Contracts, Functional
Test Matrix, and dispatch screens. A nonzero exit blocks completion. Repair the artifact
and rerun the validator until it passes; never summarize success without its `PASS`
result.


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

1. Confirm `[working directory]/canvas-app-acceptance.md` has one evidence row for every Action Contract,
   no failed row, and has passed its required validation.
2. Confirm no delegated agent remains running or queued, every app, planning, and
   acceptance-artifact write is complete, and the coauthoring round-trip check above has
   passed when that check is available.
3. Cross the finalization barrier: from this point onward, do not invoke `Task`, resume an
   agent, request another QA pass, or perform another inspection. If any of those are still
   needed, remain before the barrier and complete them first.
4. Call `compile_canvas`, even when the clean-candidate compile succeeded.
5. After it succeeds, make no further tool call. Return the summary immediately. In
   particular, do not call `Task`, `read_agent`, `edit`, `create`, `apply_patch`,
   `sync_canvas`, `view`, `glob`, `rg`, `Bash`, or another MCP tool.
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
