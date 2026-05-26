# Eval Runbook for `genpage`

How to evaluate the `genpage` skill. Three layers, run in order.

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
- **Sample pages:** `plugins/model-apps/samples/1-account-grid.tsx` through `10-detail-with-pageinput.tsx`

## Eval data

All eval definitions live in `evals.json` alongside this file. The file contains:

- `common_workflow_assertions`: 15 workflow checks every run must pass (prereqs, auth, solution selection gating, check-auth pre-flight, plan creation, workflow log, --prompt scoping, prefix discipline at plan-format / resolved-names / solution-alignment)
- `common_code_assertions`: 18 code-quality checks the generated `.tsx` must pass (Fluent UI V9 only, no forbidden patterns, etc.)
- `evals`: 16 test cases — each with `id`, `tier`, `prompt`, `data`, and per-eval `expectations`

The `data` field specifies the user answers and environment state the eval assumes. During manual eval runs, the human grader role-plays this data. During automated runs, the eval harness provides these responses to `AskUserQuestion`.

### Tiers

Each eval has a `tier` for selective running:

| Tier | Count | Purpose |
|------|-------|---------|
| `smoke` | 4 | Diverse representatives (Dataverse page, mock page, edit, plan-schema compliance). Run on every PR. |
| `full` | 9 | All core scenarios (wizard, kanban, analytics, entity creation, app creation, multi-page, localization, choices). Run nightly or pre-release. |
| `stress` | 3 | Edge cases (az not logged in / not member of org, filename collision, plan revision loop). Run with full suite. |

## Quick start: running one eval

Example using eval id 1 (account gallery).

1. Open Claude Code with the `model-apps` plugin loaded.
2. Send:
   > /genpage Build a page showing Account records as a gallery of cards. Include name, website, email, phone number. Make the gallery scrollable and each card clickable to open the Account record.
3. As the planner asks questions, answer per the eval's `data.question_answers` field.
4. When the planner enters plan mode, approve it (or reject per the stress eval's `plan_revision_scenario`).
5. Save the generated `workflow-log.md` and the produced `.tsx` files.
6. **Layer 1 check:** Grade the workflow-log against the eval's `expectations` and the `common_workflow_assertions`.
7. **Layer 2 check:** Grep the generated `.tsx` against `common_code_assertions`.
8. **Layer 3 check:** Score the generated page against the UX rubric.

## How to run evals

### Step 1: Execute each eval's prompt

Invoke `/genpage` with the eval's `prompt` as the user message. For each user question the planner asks (`AskUserQuestion`), respond per the eval's `data.question_answers`. For edit evals, provide the stated app-id and page-id when asked.

For stress evals with specific scenarios (e.g., eval 12's plan-revision-scenario or eval 14's filename-collision), follow the scripted behavior in the `data` field.

Save for each run:
- `workflow-log.md` (required output, per `eval_instructions`)
- Every `.tsx` file produced in the working directory
- Any plan documents (`genpage-plan.md`, `genpage-edit-plan.md`)

To run only a subset, filter by `tier` (e.g., `smoke`-only for quick validation).

### Step 2: Layer 1 — Workflow assertions

For each eval, verify:
- All 15 `common_workflow_assertions` — generic workflow guarantees that every run must satisfy
- All of the eval's own `expectations` — the eval-specific workflow checks

These are checked against the `workflow-log.md` and the files in the working directory. No browser or deployment needed for this layer.

**Pass criteria:** Every assertion passes. Zero missed agent invocations, zero skipped phases, zero misordered operations.

### Step 3: Layer 2 — Code quality

For every generated `.tsx` file, check against the 18 `common_code_assertions`.

These can be verified with grep / regex against the source:

| Assertion | Grep pattern |
|-----------|--------------|
| Single file + default export | `^export default GeneratedComponent` |
| Destructures `pageInput` | `const.*\{.*pageInput.*\}.*=.*props` |
| Uses `makeStyles` | `makeStyles` |
| No `100vh`/`100vw` | `grep -E '100v[hw]'` should return nothing |
| No forbidden theme functions | `grep -E '(createTheme\|mergeThemes\|useTheme)'` should return nothing |
| No `<FluentProvider>` wrapper | `grep '<FluentProvider'` should return nothing (except in Dark Mode Toggle pattern) |
| No raw URL navigation | `grep -E '(window\.location\|href=.*pagetype=)'` should return nothing |
| `Xrm.Navigation.navigateTo` | If navigation is used, must appear |
| Unsized icons | `grep -E '\w+(16\|20\|24\|28\|32)(Regular\|Filled)\b'` should return nothing |
| try-catch on dataApi | Each `await dataApi\.` must be inside a try block |
| No placeholders | `grep -E '(TODO\|FIXME\|\.\.\..*$)'` should not match in function bodies |
| FormattedValue for lookups | Any `_xxx_value` in a select must be paired with a FormattedValue access |
| `createTableColumn` import | If `<DataGrid>` is used, must import `createTableColumn` |

**Pass criteria:** Every generated `.tsx` passes all 18 code assertions. Regressions here indicate the page-builder agent drifted from the rules.

### Step 4: Layer 3 — UX rubric

Review each deployed page visually (screenshot or live in the browser) against this rubric:

| Category | 2 (Full) | 1 (Partial) | 0 (Fail) |
|----------|----------|-------------|----------|
| **Workflow** | All phases ran correctly, all agents invoked as expected | Minor deviation (e.g., wrong Phase order) | Phase skipped or wrong agent invoked |
| **Code** | Clean code, all rules followed, no placeholders, good naming | Minor issues (1-2 rule violations) | Code has JS errors, broken logic, or major rule violations |
| **Visual** | Polished layout, good spacing, Fluent tokens, consistent hierarchy | Decent but cramped, misaligned, or inconsistent | Broken layout or no visible content |
| **Data** | All data fields populated correctly, real data shown, lookups resolved | Some fields missing or showing IDs instead of names | Blank page or wrong data |
| **Design** | Right visual for the data (grid vs cards vs dashboard), compact, no clutter, accessible | Reasonable but suboptimal choice | Wrong visual type for the data |

Max score: **10 per page** (5 categories × 2 points).

**Pass criteria:** Average score ≥ 8.5/10 across all pages, no individual page below 7/10.

## Pass / fail summary

An eval run passes when:
- **Layer 1:** 100% of workflow assertions pass
- **Layer 2:** 100% of code assertions pass on every `.tsx`
- **Layer 3:** Average UX score ≥ 8.5, no page below 7

An eval run fails if any layer's criteria is not met. Failures should be filed against the specific agent that owns the concern:

| Failure type | Likely owner |
|--------------|--------------|
| Missed agent invocation, wrong phase order | Orchestrator (`SKILL.md`) |
| Plan document missing sections or wrong structure | `genpage-planner.md` or `plan-schema.md` |
| Entity created in wrong order or missing columns | `genpage-entity-builder.md` |
| Generated code violates a common_code_assertion | `genpage-page-builder.md` or `rules.md` |
| Edit modified the wrong thing or broke existing behavior | `genpage-edit-planner.md` or orchestrator edit flow |

## When to run evals

- **Smoke tier:** on every PR that touches the skill, agents, or rules reference
- **Full + smoke:** nightly, or before merging a significant change
- **Stress tier:** with the full suite, or when changing the orchestrator probe logic, filename validation, or plan-mode handling
- **All tiers:** before bumping the plugin version (any 2.x.0 release)
