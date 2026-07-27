# App-Builder Offline Structural Eval Harness — Guide

> Companion to `evals/model-apps/genpage/EVAL_GUIDE.md`.  
> Source of truth: `plugins/model-apps/docs/app-builder-staged-flow-design.md` §13.

## What we evaluate

**Structural per-stage facts** — not `.tsx` snapshots, not live Dataverse state. Each fixture is an App Spec (`app-spec.json`); the runner loads it offline, computes deterministic facts for every build stage, and grades them against assertions in `evals.json`.

### Stage → oracle table

| Stage | Oracle | Plugin primitive |
|---|---|---|
| **author** | `validateAppSpec(plan profile)` passes · spec-lint clean | `app-spec.js`, `spec-lint.js` |
| **plan** | Every planned item targets a known engine phase | `sdk-build.js` `planFor` + `PHASES` |
| **data** | Normalized data-model facts match the `expect.tables/relationships` block | `schema-facts.js` `schemaFacts` |
| **ui** | Normalized view/chart/form facts match the `expect.views/charts` block · enriched **default views** keep parent lookups (#2) and drop `createdon` (#7) · each **sub-grid** is a full-width 1-column section titled by the child display name (#5) | `sdk-build.js` `viewDef` / `chartDef` / `compileFormIntent` / `defaultViewColumns` / `subgridLabel` · `artifact-intent.js` `subgridSectionIntent` |
| **app** | Every sitemap subarea resolves to a concrete target · no dangling `navigatesTo` keys | `sdk-build.js` `appDef` |
| **verify** | Reconcile against a synthetic all-present reader returns `ok: true` | `verify-spec.js` `verifySpec` |
| **generate-pages** | No `PAGEREF_` nav targets unresolved (Plan 3 — degrades to SKIP if absent) | `pageref-resolver.js` `resolvePageRefs` |
| **teardown** | The reverse-of-build delete plan is dependency-safe (solution last · web resources after tables · every table has a step) | `sdk-teardown.js` `planTeardown` |
| **round-trip** | The download→rebuild is lossless — a synthetic deployed read hydrates back the same solution / tables / page-keys / sitemap subareas (incl. classic dashboards) | `hydrate-spec.js` `hydrateSpec` |

## Fixtures

Each fixture lives in `fixtures/<id>-<slug>/` and contains `app-spec.json`.  
Naming is numeric-prefix; `fixture-loader.js` matches `^(\d+)(?:-(.+))?$`.

| # | Slug | What it tests |
|---|---|---|
| 1 | `1-support-desk` | Full data/ui/app/verify oracle (no pages) |
| 2 | `2-orders-multipage` | Page intents + navigation + design contract; page-key round-trip |
| 3 | `3-assets-dashboard` | Global choice + column binding, on-click command, and a classic **dashboard** pinned to the nav — exercises teardown (dashboard/command/web-resource/global-choice steps) + the dashboard round-trip |
| 4 | `4-hardening` | The 2026-07-15 review fixes: a lookup-heavy child (8 scalars + a 1:N parent lookup) proves the default view keeps the lookup (#2) and drops `createdon` (#7); an N:N proves the alphabetically-sorted schema name `new_tag_new_ticket` (#3); a no-label sub-grid proves the own-section + pluralName title (#5); relational sample data proves `validateAppSpec` accepts a resolvable `$parent` match and declared Choice labels (#1/#4) |

> **Fixture 2 note:** `appShell.subAreas[].page` references use the page's **key** (e.g. `"overview"`). For `schemaVersion: 2`, `validateAppSpec` validates `sa.page` against `pages[].key`, while `lintAppSpec` validates against `pages[].name`. Setting `p.key === p.name` (lowercase identifiers) satisfies both validators without modifying plugin code.

## `evals.json`

- `skill_name` — identifies this suite.
- `eval_instructions` — description used by eval runners.
- `common_stage_assertions` — run for every fixture; registered in `lib/assertions.js`.
- `evals[].expect` — per-eval expected counts/names (tables, rels, views, charts, pages).
- `evals[].expectations` — additional per-eval assertion texts (can be empty).
- `evals[].tier` — `smoke` (fast subset) or `full`.

## Running

From the **repo root** (`evals/` lives there, sibling to `plugins/`):

```bash
# All fixtures, TAP v13 output; exit 0 = all pass, 1 = fail, 2 = harness error
node evals/model-apps/app-builder/run-app-builder.js

# Specific fixture
node evals/model-apps/app-builder/run-app-builder.js --eval 1

# Smoke tier only
node evals/model-apps/app-builder/run-app-builder.js --tier smoke

# Unit + e2e tests (node:test, NOT part of the plugin run-tests.js)
node --test evals/model-apps/app-builder/tests/*.test.js
```

## TAP output

```
TAP version 13
1..2
# Subtest: 1-support-desk
    ok 1 - author: validateAppSpec(plan profile) passes with no errors
    ok 2 - author: spec-lint reports no errors
    ...
ok 1 - 1-support-desk
# Subtest: 2-orders-multipage
    ...
ok 2 - 2-orders-multipage
# tests 20
# pass  20
# fail  0
# skip  0
# fixtures 2 (pass 2, fail 0)
```

## Adding an eval

1. Create `fixtures/<N>-<slug>/app-spec.json`.
2. Add an entry to `evals.json` with matching `id`, an `expect` block, and any extra `expectations`.
3. If you need a new assertion, add it to `lib/assertions.js` (text must match exactly).

## Adding an assertion

Register the check in `lib/assertions.js`:

```javascript
ASSERTIONS.set('my-stage: my assertion text', ({ facts, spec, eval: ev }) => {
  if (someConditionNotMet) return { status: 'fail', reason: 'explains why' };
  if (notApplicable) return { status: 'skip', reason: 'explains why skipped' };
  return { status: 'pass' };
});
```

Then add the text to `evals.json` `common_stage_assertions` (applies to all) or `evals[].expectations` (per-eval).

## Page oracle graceful degrade

`pageref-resolver.js` (Plan 3) is loaded inside a `try/catch`. If it's absent:
- `pageFacts(spec)` returns `null`.
- The `'generate-pages: …'` assertion emits `SKIP` for all fixtures.
- No other assertion is affected.

## Live evals

The live tier (`plugins/model-apps/scripts/smoke-eval.js`) is the thin live smoke; a multi-page live eval case is a follow-up. These offline evals are complementary: they grade structural facts (no live env needed) while the live smoke grades real Dataverse provisioning.

## Cross-links

- Plugin `AGENTS.md` → *Eval Suite*
- `plugins/model-apps/docs/app-builder-staged-flow-design.md` §13 — structural eval oracles
- `evals/model-apps/genpage/EVAL_GUIDE.md` — the parallel eval suite for `/genpage`
