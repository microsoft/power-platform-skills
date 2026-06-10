# Eval Guide — Model Apps `/genpage`

Comprehensive guide to the `/genpage` evaluation suite. **What evals exist, how they're structured, how to run them, how to interpret results, and how to extend them.** Companion to the plugin's `docs/architecture.md` (system overview).

## Table of contents

1. [Related files](#related-files)
2. [What we evaluate](#what-we-evaluate)
3. [The three-layer grading model](#the-three-layer-grading-model)
4. [Eval data — `evals.json` structure](#eval-data)
5. [Eval tiers (smoke / full / stress)](#eval-tiers)
6. [Fixture types (synthetic vs real captures)](#fixture-types)
7. [Running the suite](#running-the-suite)
8. [Cadence — when to run](#cadence)
9. [Quick start — running one eval end-to-end](#quick-start)
10. [Reading runner output (TAP)](#reading-runner-output)
11. [Manual grep patterns (Layer 2 fallback)](#manual-grep-patterns)
12. [Pass / fail summary](#pass-fail-summary)
13. [Diagnosing failures (which agent owns what)](#diagnosing-failures)
14. [Capturing real fixtures from `/genpage`](#capturing-real-fixtures)
15. [Adding a new eval](#adding-a-new-eval)
16. [Adding a new assertion](#adding-a-new-assertion)
17. [Known-red fixtures and why they're allowed](#known-red-fixtures)

---

## Related files

- **Skill definition:** `plugins/model-apps/skills/genpage/SKILL.md`
- **Specialist agents:**
  - `plugins/model-apps/agents/genpage-planner.md`
  - `plugins/model-apps/agents/genpage-entity-builder.md`
  - `plugins/model-apps/agents/genpage-page-builder.md`
  - `plugins/model-apps/agents/genpage-edit-planner.md`
- **References:**
  - `plugins/model-apps/references/rules.md`
  - `plugins/model-apps/references/plan-schema.md`
  - `plugins/model-apps/references/troubleshooting.md`
- **Sample pages:** `plugins/model-apps/samples/1-account-grid.tsx` through `11-kanban-with-dnd.tsx`

---

## What we evaluate

`/genpage` is a multi-phase skill: orchestrator → planner → optional entity-builder → page-builder(s) → deploy → optional verify. Each phase has rules (auth must precede entity creation, plans must follow a schema, generated code must follow rules.md, etc.). The eval suite checks that the agent honors those rules end-to-end.

Three kinds of failure we want to catch:

| Failure class | Example | Where it shows up |
|---|---|---|
| **Workflow drift** | Planner skipped the AskUserQuestion for new-vs-edit | Layer 1 (workflow-log + plan grading) |
| **Code-gen drift** | Generated `.tsx` uses `<FluentProvider>` wrapper or `100vh` | Layer 2 (`.tsx` static analysis) |
| **UX drift** | Layout cramped, lookups show raw GUIDs instead of names | Layer 3 (manual UX rubric) |

Layers 1 and 2 are automated. Layer 3 is human judgment by design — visual quality is genuinely hard to grade with regex.

---

## The three-layer grading model

### Layer 1 — Workflow assertions

**Input:** `workflow-log.md`, `genpage-plan.md`, optionally `genpage-edit-plan.md` and `entity-creation-log.md`.

**What it checks:**
- Prereq commands ran (`node --version`, `pac help` with version ≥ 2.7.0)
- `pac auth list` ran and the active env was reported
- `AskUserQuestion` was used (or new-page intent was inferable from a `## Pages` section in the plan)
- Plan was presented via `EnterPlanMode` and approved
- Plan conforms to `references/plan-schema.md` (all required `##` headings)
- `## Environment` contains `Solution:` and `Publisher Prefix:` lines
- Solution-selection question runs when (and only when) metadata work is needed
- `check-auth.js` runs before `entity-builder` when entities need creating
- `pac model genpage upload` invocations include `--prompt` with correct scoping
- Prefix discipline holds across plan, entity-creation log, and resolved names

**Runner:** `evals/model-apps/genpage/run-layer-1.js`
**Library:** `lib/assertions-layer-1.js` (one check function per assertion text)

### Layer 2 — Code-quality assertions

**Input:** every `.tsx` file in the fixture (excluding `RuntimeTypes.ts`).

**What it checks** (against `common_code_assertions` in `evals.json`):
- Single file with `export default GeneratedComponent`
- `pageInput` is destructured from props (even on mock pages)
- Either `./RuntimeTypes` import (Dataverse) or realistic inline mock data
- `makeStyles` + `tokens` (no inline styles for static values)
- **No** `100vh` / `100vw` / `createTheme` / `mergeThemes` / `useTheme` / `<FluentProvider>`
- **No** `window.location` / `react-router` / raw `pagetype=` URLs
- `Xrm.Navigation.navigateTo` (or `xrm?.Navigation?.navigateTo` via a typed `(window as any).Xrm` alias) for in-app nav
- Unsized Fluent icons only (e.g., `AddRegular`, not `Add24Regular`)
- Every icon name in `@fluentui/react-icons` imports appears in `references/verified-icons.txt`
- `try`/`catch` around `await dataApi.*` (Dataverse pages)
- No `TODO`/`FIXME`/`...` placeholders
- Lookup fields use `@OData.Community.Display.V1.FormattedValue` annotations
- `<DataGrid>` usage imports `createTableColumn` + configures `columnSizingOptions` or `resizableColumns`
- Multi-page builds use quoted `"PAGEREF_<filename>"` placeholders for cross-page nav

Plus per-eval `expectations` whose text starts with `Phase 5` (page-builder-specific).

**Runner:** `evals/model-apps/genpage/run-layer-2.js`
**Library:** `lib/assertions-layer-2.js`

### Layer 3 — UX rubric (manual)

**Input:** the deployed page rendered in the browser.

**What it checks** (against a 5-category, 2-point-each rubric):

| Category | 2 points | 1 point | 0 points |
|----------|----------|---------|----------|
| Workflow | All phases ran correctly | Minor deviation | Phase skipped |
| Code | Clean, all rules followed | 1-2 minor violations | JS errors or major rule violations |
| Visual | Polished, good spacing, Fluent tokens | Decent but cramped or inconsistent | Broken layout |
| Data | All fields correct, lookups resolved | Some missing or showing raw IDs | Blank or wrong data |
| Design | Right visual for the data, accessible | Reasonable but suboptimal | Wrong visual type |

**Pass criteria:** average score ≥ 8.5/10 across pages; no page below 7.

**Not automated** — visual regression testing is a separate, expensive problem and out of scope for v2.2.

---

## Eval data

All eval definitions live in `evals.json` alongside this file. The file contains:

- `common_workflow_assertions`: 15 workflow checks every run must pass (prereqs, auth, solution selection gating, check-auth pre-flight, plan creation, workflow log, `--prompt` scoping, prefix discipline at plan-format / resolved-names / solution-alignment).
- `common_code_assertions`: 18 code-quality checks the generated `.tsx` must pass (Fluent UI V9 only, no forbidden patterns, etc.).
- `evals`: 16 test cases — each with `id`, `tier`, `prompt`, `data`, and per-eval `expectations`.

The `data` field specifies the user answers and environment state the eval assumes. During manual eval runs, the human grader role-plays this data. During automated runs, the eval harness provides these responses to `AskUserQuestion`.

---

## Eval tiers

Each eval in `evals.json` has a `tier` field for selective execution.

| Tier | Count | When to run | Eval IDs |
|------|------|-------------|----------|
| `smoke` | 4 | **Every PR** that touches the skill, agents, rules, or evals | 1, 2, 3, 16 |
| `full` | 9 | Nightly or pre-release; covers core workflows | 4, 5, 6, 7, 8, 9, 11, 13, 15 |
| `stress` | 3 | With full suite; edge cases (auth blockers, plan revisions, filename collisions) | 10, 12, 14 |

**Recommended cadence:**

- Smoke tier on every PR (~30 seconds)
- Full + smoke nightly (~2 minutes)
- All three tiers before bumping the plugin version (`v2.x.0` release)

Run a single tier:

```bash
node run-layer-1.js --tier smoke
node run-layer-2.js --tier smoke
```

---

## Fixture types

A fixture is a folder under `fixtures/<eval-id>-<slug>/` containing the artifacts a `/genpage` run would produce. The runner doesn't drive `/genpage` itself — it grades pre-captured outputs.

### Synthetic fixtures

Hand-built v2.x-compliant artifacts. Built from samples + hand-crafted workflow-log + plan. They serve as **green-path regression tests** — if a runner change accidentally rejects a known-good fixture, we know the change is wrong.

Pros: deterministic, fast to build, no Dataverse dependency, fully under our control.
Cons: can't catch agent drift (the synthetic fixture is what we *want* the agent to produce, not what it *does*).

### Real captures

Output from real `/genpage` sessions, captured via `scripts/capture-fixture.js`. These validate the runner against actual agent behavior.

Pros: catch agent drift, validate that the spec produces the expected output, surface edge cases the synthetic fixtures missed.
Cons: require a working Dataverse env + interactive session, slower to produce, can become stale when rules tighten.

### Both together

The suite ships both kinds:

| Eval | Synthetic fixture | Real capture |
|-----:|-------------------|---------------|
| 1 | `1-account-card-gallery` | — |
| 2 | `2-mock-dashboard` | `2-mock-dashboard-real` (pre-v2.2-spec — see [known-red](#known-red-fixtures)) |
| 4 | `4-case-wizard` | — |
| 5 | — | `5-kanban-task-board` (pre-v2.2-spec — see [known-red](#known-red-fixtures)) |
| 7 | `7-job-candidates-new-entities` | — |
| 11 | `11-recruitment-multi-page` | `11-recruitment-pages-real` (v2.2-spec, ✓ green) |
| 13 | `13-contact-localization` | — |
| 15 | — | `15-support-tickets-real` (v2.2-spec, ✓ green) |

The mix gives:
- A **green baseline** to catch runner regressions (synthetics)
- **Drift detection** against real agent output (real captures)
- **Proof of life** that the current spec produces green captures (the two v2.2-spec captures)

---

## Running the suite

### One-shot — all fixtures, both layers

```bash
node evals/model-apps/genpage/run-layer-1.js
node evals/model-apps/genpage/run-layer-2.js
```

Exit codes:
- `0` — every fixture passed
- `1` — at least one fixture has a failing assertion
- `2` — runner error (missing fixtures dir, bad args, malformed `evals.json`)

### Filter by tier

```bash
node run-layer-1.js --tier smoke    # 4 smoke evals
node run-layer-1.js --tier full     # 9 full evals
node run-layer-1.js --tier stress   # 3 stress evals
```

### Filter by eval id (debugging)

```bash
node run-layer-1.js --eval 11   # only fixtures under eval id 11
node run-layer-2.js --eval 15
```

Returns matching fixtures regardless of name slug. So `--eval 2` runs both `2-mock-dashboard/` and `2-mock-dashboard-real/`.

### Custom fixture directory

For a side-by-side comparison or trial run:

```bash
node run-layer-1.js --fixtures /path/to/alternate/fixtures
```

### CI-style summary

The runner emits TAP v13 — pipe through any TAP consumer for nice reporting:

```bash
node run-layer-1.js | tap-spec
node run-layer-1.js | tap-summary
```

For raw counts:

```bash
node run-layer-1.js 2>&1 | tail -6
```

Prints:
```
# tests 261
# pass  124
# fail  10
# skip  127
# fixtures 10 (pass 8, fail 2)
```

---

## Cadence

When to run which tier:

- **Smoke tier:** on every PR that touches the skill, agents, or rules reference.
- **Full + smoke:** nightly, or before merging a significant change.
- **Stress tier:** with the full suite, or when changing the orchestrator probe logic, filename validation, or plan-mode handling.
- **All tiers:** before bumping the plugin version (any 2.x.0 release).

---

## Quick start

Example using eval id 1 (account gallery) — manual fixture capture if you don't have one yet:

1. Open Claude Code with the `model-apps` plugin loaded.
2. Send:
   > /genpage Build a page showing Account records as a gallery of cards. Include name, website, email, phone number. Make the gallery scrollable and each card clickable to open the Account record.
3. As the planner asks questions, answer per the eval's `data.question_answers` field.
4. When the planner enters plan mode, approve it (or reject per the stress eval's `plan_revision_scenario`).
5. Save the generated `workflow-log.md`, `genpage-plan.md`, and the produced `.tsx` files into a new `fixtures/1-<slug>/` folder. Use `scripts/capture-fixture.js` for this — it skips Phase 0.5 scaffolding automatically.
6. **Layer 1 check:** `node run-layer-1.js --eval 1` grades the workflow-log + plan.
7. **Layer 2 check:** `node run-layer-2.js --eval 1` grades the `.tsx`.
8. **Layer 3 check:** Open the deployed page in the browser and score it against the UX rubric (manual).

---

## Reading runner output

The runners emit TAP v13. Each fixture is a subtest; each assertion is one `ok` / `not ok` line.

```
TAP version 13
1..10
# Subtest: 1-account-card-gallery
    ok 1 - Generated .tsx is a single file with `export default GeneratedComponent`
    ok 2 - Generated .tsx destructures props including `pageInput`
    ok 3 - Generated .tsx imports types from `./RuntimeTypes` ...
    ...
    1..18
ok 1 - 1-account-card-gallery
# Subtest: 11-recruitment-pages-real
    ...
    not ok 17 - For Dataverse list/detail pages, the inline IIFE + window cache pattern is used
      ---
      reason: "candidate-list.tsx: missing window cache or uses useCallback for fetch"
      ...
ok 2 - 11-recruitment-pages-real
...
# tests 187
# pass  98
# fail  6
# skip  92
# fixtures 7 (pass 6, fail 1)
```

Read this output as:

- **Top of each subtest:** `# Subtest: <fixture-folder-name>` — which fixture is being graded.
- **Per-assertion line:** `ok N - <assertion text>` (pass) or `not ok N - <assertion text>` (fail) or `ok N - <text> # SKIP <reason>` (not applicable).
- **YAML block under `not ok`:** the `reason` field names the offending file and what specifically violated the assertion.
- **Aggregate:** `ok N - <fixture-name>` (all assertions passed) or `not ok N - <fixture-name>` (at least one fail).
- **Final summary:** `# tests <N>` / `# pass <N>` / `# fail <N>` / `# skip <N>` / `# fixtures <N> (pass X, fail Y)`.

**Skipped vs failed:**
- `# SKIP <reason>` — the assertion doesn't apply (e.g., "no Dataverse files in this fixture" for a mock-data assertion, or "Rule 14 batched-setState requires AST analysis" for an assertion the runner doesn't implement). **Does not fail the fixture.**
- `not ok` — actual failure. Fixture fails. Exit code becomes 1.

**Three common skip reasons in our suite:**
1. `no Dataverse files / no <feature> detected` — the fixture doesn't exercise this code path
2. `requires AST analysis (not implemented)` — assertion needs more than regex; left as manual check until a parser-based implementation lands
3. `no check registered for this expectation` — the assertion text in `evals.json` doesn't have a corresponding check in the runner library. Either add the check or accept the skip as documentation-only.

---

## Manual grep patterns

For ad-hoc verification or assertions the Layer 2 runner currently skips, grep the source directly. Useful when you don't have a fixture yet or want to spot-check a single file before capturing.

| Assertion | Grep pattern |
|-----------|--------------|
| Single file + default export | `^export default GeneratedComponent` |
| Destructures `pageInput` | `const.*\{.*pageInput.*\}.*=.*props` |
| Uses `makeStyles` | `makeStyles` |
| No `100vh`/`100vw` | `grep -E '100v[hw]'` should return nothing |
| No forbidden theme functions | `grep -E '(createTheme\|mergeThemes\|useTheme)'` should return nothing |
| No `<FluentProvider>` wrapper | `grep '<FluentProvider'` should return nothing (except in Dark Mode Toggle pattern) |
| No raw URL navigation | `grep -E '(window\.location\|href=.*pagetype=)'` should return nothing |
| `Xrm.Navigation.navigateTo` | If navigation is used, must appear (literal or via `xrm?.Navigation?.navigateTo` alias) |
| Unsized icons | `grep -E '\w+(16\|20\|24\|28\|32)(Regular\|Filled)\b'` should return nothing |
| try-catch on dataApi | Each `await dataApi\.` must be inside a try block |
| No placeholders | `grep -E '(TODO\|FIXME\|\.\.\..*$)'` should not match in function bodies |
| FormattedValue for lookups | Any `_xxx_value` in a select must be paired with a FormattedValue access |
| `createTableColumn` import | If `<DataGrid>` is used, must import `createTableColumn` |

---

## Pass / fail summary

An eval run passes when:

- **Layer 1:** 100% of workflow assertions pass
- **Layer 2:** 100% of code assertions pass on every `.tsx`
- **Layer 3:** average UX score ≥ 8.5, no page below 7

An eval run fails if any layer's criteria isn't met. Skipped assertions never count as failures — they're either inapplicable to the fixture or pending AST-based implementation.

---

## Diagnosing failures

When the runner reports a `not ok`, file the issue against the agent that owns the concern:

| Failure type | Likely owner |
|--------------|--------------|
| Missed agent invocation, wrong phase order | Orchestrator (`SKILL.md`) |
| Plan document missing sections or wrong structure | `genpage-planner.md` or `plan-schema.md` |
| Entity created in wrong order or missing columns | `genpage-entity-builder.md` |
| Generated code violates a `common_code_assertion` | `genpage-page-builder.md` or `rules.md` |
| Edit modified the wrong thing or broke existing behavior | `genpage-edit-planner.md` or orchestrator edit flow |

Use the failure's `reason` field (in the TAP YAML block) to find the offending file and pattern; cross-reference with the agent file to identify which rule the agent diverged from.

---

## Capturing real fixtures

Use `scripts/capture-fixture.js`. The helper copies the right files (excluding local-dev scaffolding) and immediately runs both layers against the result.

### Steps

1. **Run `/genpage` in a regular interactive Claude Code session.** Use the eval's exact prompt from `evals.json`. Answer each `AskUserQuestion` per the eval's `data.question_answers` (the runner emits these as the canonical answers).

2. **After completion, run the capture script:**

   ```bash
   node plugins/model-apps/scripts/capture-fixture.js \
     --working-dir <path-to-/genpage-working-dir> \
     --eval <id> \
     --slug <kebab-slug>
   ```

3. **Inspect the JSON summary** the script prints. If `layer1.failures` and `layer2.failures` are both empty, the fixture is good to commit. If there are failures, decide:
   - **Real agent drift** → file an issue or tighten the spec (don't doctor the fixture)
   - **Runner false positive** → relax the assertion regex to accept the functionally-equivalent alternative pattern
   - **Stale fixture from before a spec change** → mark as known-red with a fixture-local README (see `15-support-tickets-real/README.md` for the template)

### What the script copies (allowlist)

- `*.tsx` (each page produced)
- `*.md` (workflow-log, genpage-plan, entity-creation-log, edit-plan)
- `RuntimeTypes.ts`

### What it skips (denylist)

- `package.json` and `genpage.d.ts` — Phase 0.5 local-dev scaffolding, not agent output
- `node_modules/`, `dist/`, `build/`, `.cache/`, `.tmp/`, `.next/`
- `*.log`, `.DS_Store`, `Thumbs.db`

### Flags

| Flag | Purpose |
|------|---------|
| `--force` | Overwrite an existing fixture with the same slug |
| `--skip-verify` | Capture without running the layers (rare; use when you just want to inspect the artifacts) |

---

## Adding a new eval

When the skill grows a new capability (new sample pattern, new agent flow, etc.), add an eval to cover it.

1. **Append a new entry** to the `evals` array in `evals.json`:

   ```json
   {
     "id": <next-available>,
     "tier": "smoke" | "full" | "stress",
     "prompt": "<exact /genpage prompt>",
     "data": {
       "question_answers": { "new_or_edit": "...", "data_source": "...", ... },
       "app_selection": "...",
       "sample_data_response": "..."   // if applicable
     },
     "expectations": [
       "Phase 1 (Planner): <eval-specific check>",
       "Phase 5 (Page Builder): <code-quality check>",
       ...
     ]
   }
   ```

2. **Pick a tier:**
   - `smoke` if it covers a major shape and is fast (no entity creation)
   - `full` if it covers a core scenario but has setup cost (entity creation, new app)
   - `stress` if it's an edge case (auth blocker, plan revision, collision)

3. **Write `expectations`** as exact-text assertions starting with `Phase` (the runner matches by exact string against checks in `assertions-layer-1.js` / `assertions-layer-2.js`).

4. **Build at least one fixture** under `fixtures/<eval-id>-<slug>/`. Synthetic is fine to start; capture a real one when you can.

5. **Run both runners:**

   ```bash
   node run-layer-1.js --eval <id>
   node run-layer-2.js --eval <id>
   ```

6. **Register any unregistered assertion texts.** If you see `# SKIP no check registered for this expectation`, decide:
   - If the text is checkable → add the function to `assertions-layer-{1,2}.js`
   - If it's subjective → leave skipped and rely on Layer 3 (manual)

---

## Adding a new assertion

When a new rule is added to `rules.md` or a new phase requirement lands in `SKILL.md`:

1. **Add the assertion text** to `common_code_assertions` (Layer 2) or `common_workflow_assertions` (Layer 1) in `evals.json`. Use natural language; this is the human-readable rule statement.

2. **Register a check function** in `lib/assertions-layer-1.js` or `lib/assertions-layer-2.js`:

   ```js
   ASSERTIONS.set(
     'Your exact assertion text from evals.json',
     ({ files, eval: ev, fixture }) => {
       // Inspect files / workflow-log / plan
       // Return { status: 'pass' | 'fail' | 'skip', reason: '...' }
       const offender = files.find((f) => /forbidden-pattern/.test(stripComments(f.content)));
       return offender
         ? { status: 'fail', reason: `${offender.name}: contains forbidden-pattern` }
         : { status: 'pass', reason: '' };
     }
   );
   ```

3. **Use the right relaxations.** The runner accepts functionally-equivalent alternatives — e.g., `xrm?.Navigation?.navigateTo` and `xrm.Navigation.navigateTo` both pass the Xrm.Navigation check because they call the same API. When you find a real agent output that uses a valid alternative pattern, relax the regex; don't tighten the spec to forbid the alternative.

4. **Add unit tests** in `tests/assertions-layer-{1,2}.test.js` covering pass / fail / skip cases.

5. **Update at least one fixture** to exercise the assertion. If existing fixtures naturally cover it, you're done; otherwise edit a synthetic fixture's `.tsx` or workflow-log to include the pattern.

6. **Run the full test + runner sweep:**

   ```bash
   node --test plugins/model-apps/scripts/tests/*.test.js evals/model-apps/genpage/tests/*.test.js
   node evals/model-apps/genpage/run-layer-1.js
   node evals/model-apps/genpage/run-layer-2.js
   ```

---

## Known-red fixtures

A fixture can be **intentionally red** if:

- It documents real agent drift (the runner is catching a legitimate violation)
- It was captured before a spec change and predates the current rules
- It serves as historical reference

In all cases, the fixture must have a **`README.md` inside the fixture directory** documenting:
- What's failing and why
- Whether the failures are runner false-positives (would be fixed) or real-but-pre-spec drift (would be replaced)
- When the fixture should be replaced

Currently red:

| Fixture | Why | Action |
|---------|-----|--------|
| `2-mock-dashboard-real/` | Pre-v2.2-spec workflow-log compactness + `void props;` instead of `pageInput` destructure | Re-capture under v2.2 spec to replace |
| `5-kanban-task-board/` | Pre-v2.2-spec workflow-log compactness (Layer 2 is fully green; only Layer 1 affected) | Re-capture under v2.2 spec to replace |

Both will go green when their `/genpage` sessions are re-run after the v2.2 planner-spec tightening propagates. See each fixture's README for the specific failing assertions and remediation path.

**Aggregate state for CI gating:** A passing build is one where every **synthetic** fixture is green. Real captures may be red while documented; their failures count as known-signal, not regressions. (You can adjust this policy if you want CI to gate on real captures too — see the runner's `--eval` filter for narrowing.)
