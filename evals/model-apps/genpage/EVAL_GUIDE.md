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
9. [Quick start — manual capture and offline replay](#quick-start)
10. [Reading runner output (TAP)](#reading-runner-output)
11. [Manual grep patterns (Layer 2 fallback)](#manual-grep-patterns)
12. [Pass / fail summary](#pass-fail-summary)
13. [Diagnosing failures (which agent owns what)](#diagnosing-failures)
14. [Capturing real fixtures from `/genpage`](#capturing-real-fixtures)
15. [Adding a new eval](#adding-a-new-eval)
16. [Adding a new assertion](#adding-a-new-assertion)
17. [Expected refusals and corpus gating](#expected-refusals-and-corpus-gating)

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

`/genpage` is a multi-phase skill: orchestrator → planner → optional entity-builder → page-builder(s) → deploy → optional verify. Each phase has rules (auth must precede entity creation, plans must follow a schema, generated code must follow rules.md, etc.). These runners **replay stored artifacts** against selected contracts; they do not launch agents, answer questions, run logged commands, or deploy anything. A green replay is not end-to-end evidence of current agent or platform behavior.

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

**Input:** `workflow-log.md`, `genpage-plan.md`, optionally `genpage-edit-plan.md` and `genpage-entity-creation-log.md` (legacy `entity-creation-log.md` remains supported). Current synthetic fixtures also supply `fixture.json`, ordered `tool-results.json` and the declared JSON/text/source snapshots.

**What it checks:**
- Prereq commands are recorded (`node --version`, `pac help` with version **> 2.10.0**)
- `pac auth list` ran and the active env was reported
- `AskUserQuestion` was used (or new-page intent was inferable from a `## Pages` section in the plan)
- Plan was presented via `EnterPlanMode` and approved
- Plan conforms to `references/plan-schema.md` (required headings, safe targets and matching Pages-table/per-page File values)
- `## Environment` contains `Solution:` and `Publisher Prefix:` lines
- Solution-selection question runs when (and only when) metadata work is needed
- Auth results belong to their commands; the latest successful applicable gate precedes mutations, final failures halt, and timeout retry/advice is bounded
- Failed connection discovery is not an empty success and cannot authorize setup
- Current upload commands use `genpage-upload.js` with file transport; the preservation fixture compares exact approved/forwarded text and before/after name, model and binding sets
- Custom API discovery/gates/bindings/runtime/update stages agree; optional packaging names every deployed page and preserves failures/read-back evidence
- Prefix discipline holds across plan, entity-creation log, and resolved names

**Runner:** `evals/model-apps/genpage/run-layer-1.js`
**Library:** `lib/assertions-layer-1.js` (one check function per assertion text)

### Layer 2 — Code-quality assertions

**Input:** every top-level `.tsx` file in the fixture (excluding `RuntimeTypes.ts`), plus declared before/after source and lifecycle evidence where applicable.

**What it checks** (against `common_code_assertions` in `evals.json`):
- Single file with `export default GeneratedComponent`
- `pageInput` is destructured from props (even on mock pages)
- Either `./RuntimeTypes` import (Dataverse) or realistic inline mock data
- `makeStyles` presence (the existing heuristic does not prove tokens or prohibit every inline style)
- **No** `100vh` / `100vw` / `createTheme` / `mergeThemes` / `useTheme` / `<FluentProvider>`
- **No** `window.location` / `react-router` / raw `pagetype=` URLs
- `Xrm.Navigation.navigateTo` (or `xrm?.Navigation?.navigateTo` via a typed `(window as any).Xrm` alias) for in-app nav
- Unsized Fluent icons only (e.g., `AddRegular`, not `Add24Regular`)
- Every icon name in `@fluentui/react-icons` imports appears in `references/verified-icons.txt`
- A `try`/`catch` marker for Dataverse awaits (not proof that every await is enclosed)
- No `TODO`/`FIXME`/`...` placeholders
- Lookup fields use `@OData.Community.Display.V1.FormattedValue` annotations
- `<DataGrid>` usage imports `createTableColumn` + configures `columnSizingOptions` or `resizableColumns`
- Every effective navigation target is checked with the production resolver; current before/after snapshots must differ by exact substitutions only, and only affected pages reupload
- The production `pageStructureProblems` gate rejects truncated modules, including unfinished statements after valid exports
- The Custom API lifecycle grades actual saved TSX, method/parameter/bound-record parity, sanitized result handling and preservation versus explicit clear

Plus per-eval `expectations` for **Phase 5, 5a, 5b and 5c**. `Edit Phase 5` entries remain Layer-1 expectations. The registered Phase-5b column checker now executes; its existing `column-name verification requires RuntimeTypes.ts fixture` SKIP is explicit, not silently excluded by routing. Column/schema verification itself remains unimplemented. Other unregistered/AST-dependent expectations are reported as skips, not claimed as coverage. The API request scorer supports literal request objects in named helpers and scalar annotations; it is not a TypeScript compiler or a runtime execution oracle.

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

- `common_workflow_assertions`: **19** registered workflow checks, each passed or explicitly skipped when inapplicable.
- `common_code_assertions`: **21** registered code checks.
- `evals`: **25** prompt definitions, each with `id`, `tier`, `prompt`, `data`, and per-eval `expectations`.

The `data` field specifies scenario assumptions for a manual capture or constructed fixture. The offline harness does not provide responses to `AskUserQuestion` or verify every recorded answer. The corpus contains **20 fixture directories / 26 top-level TSX files**, representing 18 prompt IDs. IDs **3, 6, 8, 9, 12, 14, 16** have no fixture and are not executed.

### Enumerating registered and unmatched checks

The assertion modules export four iterable Maps: Layer 1's `WORKFLOW_ASSERTIONS` and
`PHASE_EXPECTATIONS`, and Layer 2's `ASSERTIONS` and `PHASE5_EXPECTATIONS`. Iterate their
entries to inventory every registered text and callback. Use the matching common Map
for `common_workflow_assertions` / `common_code_assertions`.

For **per-eval expectations**, both runner modules export `getExpectationCheck(text)`,
returning the actual routed callback or `undefined`. They also export their predicates:
Layer 1 `isPhaseExpectation(text)` and Layer 2 `isPhase5Expectation(text)`. The scoring
loops use these same functions. A cross-runner contract test can list unmatched entries
without reimplementing the routing expressions (paths below are relative to this directory):

```javascript
const data = require('./evals.json');
const workflow = require('./run-layer-1.js');
const code = require('./run-layer-2.js');
const unmatched = data.evals.flatMap(({ id, expectations }) =>
  expectations
    .filter((text) => !workflow.getExpectationCheck(text) && !code.getExpectationCheck(text))
    .map((text) => ({ id, text }))
);
```

A matched callback can still intentionally return SKIP; matching is not proof of an
implemented oracle. The Phase-5b routing test also injects a failing result at the real
registry entry and requires runner exit 1, proving the callback executes.

### The coverage contract

`evals/model-apps/tests/eval-coverage-contract.test.js` (run by CI with the other eval unit
tests) grades through each runner's exported `gradeFixture`, so it sees exactly what the runners
report, and fails when:

- a prompt has no fixture and no recorded reason, or a fixture has no prompt;
- an expectation is routed by neither runner (it would be dropped without even a SKIP), or a
  common assertion has no check;
- an expectation has no check and is not recorded as `deferred` (an offline check could grade
  it) or `manual` (a person judges the generated page);
- a registered check returns SKIP on every fixture it runs on and is not recorded with its reason;
- the counts and missing prompt IDs this guide and `fixtures/README.md` state disagree with the
  registries, or the loader's entity-log name differs from the one the skill writes.

Today's gaps are recorded in `evals/model-apps/tests/eval-coverage-baseline.json`. Every list in
it is a ratchet: when you capture a missing prompt, add a check or make a placeholder grade, the
contract fails until you remove the entry, so the baseline only shrinks.

---

## Eval tiers

Each eval in `evals.json` has a `tier` field for selective execution.

| Tier | Count | When to run | Eval IDs |
|------|------|-------------|----------|
| `smoke` | 5 | **Every PR** that touches the skill, agents, rules, or evals | 1, 2, 3, 16, 17 |
| `full` | 17 | Nightly or pre-release; covers core workflows | 4, 5, 6, 7, 8, 9, 11, 13, 15, 18–25 |
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

Hand-built artifacts for specific contracts, not captured agent runs. The seven current additions declare `provenance: "synthetic"`, `contractVersion: 2` and the public skill/reference sections they exercise. They serve as deterministic positive/rejection/recovery controls. Historical synthetics retain their compatibility contract rather than being advertised as current compliant output.

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
| 2 | `2-mock-dashboard` | `2-mock-dashboard-real` (historical compatibility replay) |
| 4 | `4-case-wizard` | — |
| 5 | — | `5-kanban-task-board` (historical compatibility replay) |
| 7 | `7-job-candidates-new-entities` | — |
| 11 | `11-recruitment-multi-page` (historical) | `11-recruitment-pages-real` (historical, green) |
| 13 | `13-contact-localization` | — |
| 15 | — | `15-support-tickets-real` (historical, green) |
| 17 | `17-weather-mock-data` (historical) | — |
| 18 | `18-sharepoint-connectors` (historical) | — |
| 19 | `19-add-weather-connector` (historical edit) | — |
| 10 | `10-auth-timeout-halt` (current refusal) | — |
| 20 | `20-upload-preservation` (current create/edit/refusal) | — |
| 21 | `21-discovery-failure` (current refusal) | — |
| 22 | `22-navigation-contract` (current before/after) | — |
| 23 | `23-worker-completeness` (current rejection/recovery) | — |
| 24 | `24-custom-api-lifecycle` (current create/preserve/clear) | — |
| 25 | `25-solution-package` (current packaging/refusal) | — |

The mix gives:
- A **green baseline** to catch runner regressions (synthetics)
- **Drift detection** against real agent output (real captures)
- **Compatibility evidence**, not proof that the current skill produces current-compliant captures

---

### Versioned evidence and discrimination

`fixtures/contracts.json` explicitly labels the 13 existing directories as historical contract 1, without rewriting captured content. Raw PAC transport, legacy navigation spelling and missing transport/read-back artifacts are **not** certified as current compliant. Contract 2 uses a per-directory `fixture.json` and `tool-results.json`: one ordered record per command with its own result, plus `artifacts` listing the exact files to load. Artifact paths must stay inside the fixture and be plain files.

The seven new fixtures exercise these current contracts:

| Fixture | Evidence/check | Negative control in scorer tests |
|---------|----------------|----------------------------------|
| `10-auth-timeout-halt` | One timeout retry, original advice, no provisioning/upload | Failed auth followed by unrelated `ok:true`; malformed result or wrong environment |
| `20-upload-preservation` | Wrapper/name/prompt/message files; separate own-name/config snapshots | Inline/rewritten approved text; dropped name/model/bindings; hidden shim/read warnings |
| `21-discovery-failure` | Unreadable discovery returns `needs_input`, no setup | Failed discovery followed by connection/reference creation or upload |
| `22-navigation-contract` | Actual before/after TSX and deployed ID map | Unknown/optional-call non-GUID target, runtime override, collateral edit or extra reupload |
| `23-worker-completeness` | Failed production gate, fresh regeneration, then upload | Valid export plus unfinished statement, stale/missing write or upload before acceptance |
| `24-custom-api-lifecycle` | Discovery, re-probe, bare actions, runtime and config stages | Disabled/unreadable gate, invented kind/name/parameter, wrong method/bound record, unsafe response or lost bindings |
| `25-solution-package` | Explicit page IDs, dynamic types, app-first writes and read-back | Omitted page/wrong solution/type/order; invalid ID writes; partial failure reported as success |

Expected refusals are green **only when the recorded refusal contract is satisfied**. Fixtures 10 and 21 legitimately contain no generated TSX; Layer 2 grades their failed gate and absence of generation/mutations rather than manufacturing a page. Fixture 23's rejected snapshot is nested evidence; the top-level page is the accepted regeneration. Expected-failure mutations live in unit tests, never unexplained red corpus directories.

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
node run-layer-1.js --tier smoke    # 4 stored fixtures, 5 prompt definitions
node run-layer-1.js --tier full     # 15 stored fixtures, 17 prompt definitions
node run-layer-1.js --tier stress   # 1 stored fixture (id 10), 3 prompt definitions
```

A tier runs only existing fixtures, not every prompt definition. An empty selection reports
`no fixtures matched the filter` and exits 2. The stress tier now replays the synthetic auth-timeout
refusal; plan-revision and filename-collision prompts still have no fixture.

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

Example summary (counts come from the selected stored corpus):
```
# tests 530
# pass  267
# fail  0
# skip  263
# fixtures 20 (pass 20, fail 0)
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

The runners emit TAP v13. Each fixture is a subtest; each assertion is one `ok` / `not ok` line. The following is illustrative failure output, not the current corpus result.

```
TAP version 13
1..2
# Subtest: 1-account-card-gallery
    ok 1 - Generated .tsx is a single file with `export default GeneratedComponent`
    ok 2 - Generated .tsx destructures props including `pageInput`
    ok 3 - Generated .tsx imports types from `./RuntimeTypes` ...
    ...
    1..21
ok 1 - 1-account-card-gallery
# Subtest: 11-recruitment-pages-real
    ...
    not ok 18 - For Dataverse list/detail pages, the inline IIFE + window cache pattern is used
      ---
      reason: "candidate-list.tsx: missing window cache or uses useCallback for fetch"
      ...
not ok 2 - 11-recruitment-pages-real
...
# tests 42
# pass  39
# fail  1
# skip  2
# fixtures 2 (pass 1, fail 1)
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
| No placeholders | `node plugins/model-apps/scripts/genpage-worker-output.js --file <page>.tsx` — its elision check is the Layer 2 rule. A bare `grep -E '(TODO\|FIXME\|\.\.\.)'` over-matches spreads, `'TODO'` status values and "Loading…" |
| FormattedValue for lookups | Any `_xxx_value` in a select must be paired with a FormattedValue access |
| `createTableColumn` import | If `<DataGrid>` is used, must import `createTableColumn` |

---

## Pass / fail summary

An eval run passes when:

- **Layer 1:** no executed workflow assertion fails
- **Layer 2:** no executed code/lifecycle assertion fails (or the declared source-free refusal is verified)
- **Layer 3:** average UX score ≥ 8.5, no page below 7

An offline replay fails if any executed assertion fails. Skips are visible but do not fail the run: they can be inapplicable, manual/AST-dependent or unregistered. Green therefore does not imply complete prompt coverage, a TypeScript build, React execution, live upload/download, or a browser/UX result.

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

1. **Run `/genpage` manually with the plugin loaded.** Use the eval's prompt and role-play its `data.question_answers`; offline runners do not emit or supply those answers.

2. **After completion, run the capture script:**

   ```bash
   node plugins/model-apps/scripts/capture-fixture.js \
     --working-dir <path-to-/genpage-working-dir> \
     --eval <id> \
     --slug <kebab-slug>
   ```

3. **Inspect the JSON summary** the script prints. Each layer reports its counts, the runner's `exitCode` and a `failures` list. If `layer1.failures` and `layer2.failures` are both empty, the fixture is good to commit. A runner that exits with an error but reports no failing assertion, or reports no assertions at all, is listed as a failure too: nothing was verified, even though the process itself exits 0. If there are failures, decide:
   - **Real agent drift** → file an issue or tighten the spec (don't doctor the fixture)
   - **Runner false positive** → relax the assertion regex to accept the functionally-equivalent alternative pattern
   - **Historical contract** → label/version the evidence and capture a new directory under a fresh slug, rather than rewriting an old transcript

### What the script copies (allowlist)

- `*.tsx` (each page produced)
- `*.md` (workflow-log, genpage-plan, genpage-entity-creation-log, genpage-edit-plan)
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

Prefer a fresh slug for historical captures; do not use `--force` to make old evidence resemble today's workflow. The capture helper's allowlist does not collect the new JSON/text transport and lifecycle evidence. Constructed contract-2 fixtures explicitly package those snapshots and associated results themselves.

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

5. **Add a versioned synthetic fixture** for a new contract, or rely on existing evidence when it genuinely covers it. Do not alter captured directories. Include a positive control and a negative mutation proving the scorer rejects the precise regression.

6. **Run the full test + runner sweep:**

   ```bash
   node --test plugins/model-apps/scripts/tests/*.test.js evals/model-apps/genpage/tests/*.test.js
   node evals/model-apps/genpage/run-layer-1.js
   node evals/model-apps/genpage/run-layer-2.js
   ```

---

## Expected refusals and corpus gating

Currently red: **none**. Every fixture — synthetic and real capture alike — is green under both
runners, and CI runs both runners on every PR that touches `evals/model-apps/**`
(`.github/workflows/model-apps-script-tests.yml`, job `test-model-apps-evals`).

**Aggregate state for CI gating:** every stored fixture must pass. Expected rejection is an explicit
outcome with associated failed-gate/no-mutation evidence, not an excuse for a red fixture. Put bad
inputs and ignored-failure mutations in scorer unit tests. Historical captures use their labelled
compatibility contract; newer requirements need new evidence rather than rewritten history or a
broader skip. CI green covers these replays and units, not unrepresented prompts or live behavior.
