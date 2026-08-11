# Validation Workflow

The orchestrator owns compilation of the finished workspace and the final summary.

## Contents

- Section 0 — Compile gates: when to compile, and why gate 3 exists
- Section 1 — Compile: diagnostic tiers, parse-error coordinates, version conflicts,
  reading diagnostics, liveness, the convergence budget, repair ownership, and verifying
  before summarizing
- Section 2 — Summary: the CREATE, EDIT, and unresolved-diagnostics report formats

## 0. Compile Gates

Compilation is not a final step. Three gates precede this workflow:

1. The planner compiles `[working directory]/App.pa.yaml` immediately after writing it.
2. The orchestrator confirms that result before dispatching builders.
3. The orchestrator compiles after each **wave** of builders returns, before dispatching
   the next wave.

Gate 3 exists because builders work from a shared plan. A defect in the first wave is
almost certainly repeated in every later screen. Catching it after three files is cheap;
repairing it across six finished files is not.

When gate 3 reveals a systemic defect:

- Repair the files that already exist in place, with targeted `Edit` calls.
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

1. Read every referenced absolute path in the working directory.
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
reports only the *first* one it meets — the second instance of the identical mistake is
invisible until you fix the first. After correcting an unquoted `: ` in a formula, a
mis-indented `Children:` entry, or a duplicate property key, read the rest of that file and
fix every other occurrence of the same pattern in the same pass. Otherwise each one costs a
full compile cycle and burns the convergence budget on a single defect.

### Version conflicts masquerade as unknown properties

Tier 2 sits above `Unknown property` for a reason. When any `Control:` value carries an
`@version` suffix, the whole app binds to one template version, and every property that
exists only in the *other* version is then reported as
`Unknown property 'P' for control type 'T'` — where `T` is the internal control name, not
the name you wrote. The properties are fine; the version pin is not.

Symptoms of this exact failure:

- Dozens of `Unknown property` errors naming common properties (`Color`, `FontWeight`,
  `Default`, `Font`, `Fill`) on modern controls.
- A control type in the message that does not match what you wrote — `'Text'` when your
  YAML says `ModernText`.
- One or two version diagnostics buried in the same compile output.

The fix is always the same: strip every `@version` suffix from every `Control:` value in
every file, then re-compile once. Do not edit a single property until you have done that.

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

Every turn in the repair phase must end in an `Edit` or a `compile_canvas`. Those are the
only two actions that change the outcome.

After **two consecutive turns** containing neither, stop and emit the unresolved-diagnostics
report in section 2. Do not spend a third. A repair phase that has stopped writing and
stopped compiling is not thinking — it is searching for a capability that does not exist,
and it will not recover on its own.

Reading a file, planning an approach, or delegating is not progress on its own. If you find
yourself unable to express a fix with `Edit`, return to the named file and diagnostic
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
- If two consecutive compiles return the *same* distinct diagnostic set, your last edit
  changed nothing that mattered. Do not compile a third time hoping for a different
  answer. Re-read the exact file and line the diagnostic names, and fix that text.
- On stopping, report the remaining diagnostics explicitly as described in section 2.
  Never loop indefinitely and never claim success you have not observed.

### Repair ownership

You repair the app yourself. You already hold the plan, the dispatch table, and the
diagnostic history, and a fresh agent would have to rediscover all of it.

- Fix compile diagnostics with targeted `Edit` calls against the named file. This is
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

Never modify `[working directory]/_EditorState.pa.yaml` while repairing diagnostics.

### Verify before you summarize

The summary must describe a compile you actually observed. Before writing it, confirm that
**no `.pa.yaml` file has been edited since the last successful `compile_canvas`.** If one
has, compile again — a clean result from before your last edit says nothing about what you
shipped.

Edits to non-compiled artifacts do not invalidate the result: `canvas-app-plan.md`,
`canvas-app-shared.md` and `*.screen-plan.md` are planning documents, and updating one
after the final compile is fine.

## 2. Summary

For CREATE:

```markdown
**App generation complete.**

| Screen | File | Status |
|--------|------|--------|
| [Screen] | [file].pa.yaml | Created |

**Compiled clean** after [N] pass(es).
```

For EDIT:

```markdown
**Edit complete.**

| Action | Screen | File | Status |
|--------|--------|------|--------|
| [Create / Modify] | [Screen] | [file].pa.yaml | Done |

**Compiled clean** after [N] pass(es).
```

If diagnostics remain after the convergence budget is exhausted, report them explicitly
instead of claiming completion:

```markdown
**App generated with unresolved diagnostics.**

| Screen | File | Status |
|--------|------|--------|
| [Screen] | [file].pa.yaml | Created |

**Compile status:** [N] distinct diagnostics remain after [M] pass(es).

| Diagnostic | Occurrences | File |
|------------|-------------|------|
| [message] | [count] | [file] |

[One line on what was tried and what is likely blocking.]
```
