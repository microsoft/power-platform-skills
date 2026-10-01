# App-Builder Offline Structural Eval Harness — Guide

> Companion to `evals/model-apps/genpage/EVAL_GUIDE.md`.  
> Source of truth: `plugins/model-apps/docs/app-builder-design.md` §13.

## What we evaluate

**Offline per-stage facts**, not live Dataverse state or execution of the skill's prompts. Each fixture contains an App Spec (`app-spec.json`); some also contain baseline specs, hand-authored deployed FormXML, downloaded PAC page files, or before/after `.tsx` bytes. The runner computes deterministic facts using the current plugin helpers and grades them against independent expectations in `evals.json`.

### Stage → oracle table

| Stage | Oracle | Plugin primitive |
|---|---|---|
| **author** | `validateAppSpec(plan profile)` passes · no lint errors · artifact names are table/type-scoped · ASCII page-quote warnings stay visible without changing approved names. Other advisories remain non-fatal. | `app-spec.js`, `spec-lint.js` |
| **plan** | Every planned item targets a known engine phase | `sdk-build.js` `planFor` + `PHASES` |
| **data** | Normalized data-model facts match the `expect.tables/relationships` block | `schema-facts.js` `schemaFacts` |
| **ui** | View/chart names match `expect.views/charts` · explicit tab/section names, topology, percentage widths, display flags, field state and spans match authored input · enriched **default views** keep parent lookups (#2) and drop `createdon` (#7) · each **sub-grid** is a full-width 1-column section titled by the child display name (#5) | `sdk-build.js` `viewDef` / `chartDef` / `compileFormIntent` / `defaultViewColumns` / `subgridLabel` · `artifact-intent.js` `subgridSectionIntent` |
| **app** | Every sitemap subarea resolves to a concrete target · no dangling `navigatesTo` keys | `sdk-build.js` `appDef` |
| **security** | Each declared persona maps to exactly one role · the role **injects** `appmodule` read for app-access personas (and only those) · every persona privilege on an **app-owned** table (the app's own publisher prefix) resolves to a provisioned entity (JTBD coverage) · the role grants **exactly** its jobs' declared privileges — no extra entity, access token, or inflated scope beyond the declared union + the documented `appmodule` injection (least privilege) | `sdk-build.js` `personaRoleSpecFor` |
| **verify** | Required verification succeeds, reports no missing artifacts, and actually runs each applicable check kind. Fixture 7 supplies independent deployed XML and served Main form order instead of compiler-rendered XML. | `verify-spec.js` `verifySpec` |
| **process** | Declarative logic binds real columns — every business-rule clause/action and every BPF step resolves to a column the spec creates (or a lookup its relationships create) | `sdk-build.js` `businessRuleDef` + `bpfDef` |
| **generate-pages** | Declared navigation edges resolve in canonical synthesized call sites; this does not inspect a page's actual source. See compatibility skips below. | `pageref-resolver.js` `resolvePageRefs` |
| **teardown** | The reverse-of-build delete plan is dependency-safe (solution last · web resources after tables · every table, business rule and process flow has a step) | `sdk-teardown.js` `planTeardown` |
| **round-trip** | The compared hydration subset preserves solution identity, table names, page keys/names/models, authored direct-entry behavior and ordered sitemap target references. Fixture 8 also reads PAC page/config files, unescapes names and diagnoses an omitted invalid model. | `hydrate-spec.js` `hydrateSpec` · `download-model-app.js` `parseDownloadedPages` / `assignPageKeys` · `genpage-cli.js` `unescapePacName` |
| **changed-only** | Real source-byte hashes and an eligible serialized snapshot produce exactly the expected `fast`, `full` or `noop` verdict, changed phases, page identities and full-build reasons. | `content-hash.js`, `apply-snapshot.js`, `classify-changes.js` |

These are **bounded helper-level oracles**, not proof that download followed by rebuild is lossless.
Most readers are synthetic; views, charts, forms and commands are not structurally reconstructed by
the hydrator, and entity column fidelity is checked separately by the metadata projection. Fixture 7
checks a declared before/after layout and its independently authored deployed evidence; it does not
run SDK reconciliation. Fixture 9 exercises the real decision core and pure snapshot lifecycle, not
the build CLI's flag handoff, workspace lease, live identity discovery or partial-apply side effects.

The **process** oracle exists because both surfaces share a failure mode nothing downstream detects:
the platform *accepts* a definition whose column bindings are wrong or missing, and the artifact then
does nothing. A business rule with a mis-shaped condition tree deploys, activates and never fires; a
BPF step with no bound field is refused only at push time, on a live environment. Counting artifacts
would stay green through both, so the assertions grade the **bindings** the pure def builders emit.

## Fixtures

Each fixture lives in `fixtures/<id>-<slug>/` and contains `app-spec.json`.  
Naming is numeric-prefix; `fixture-loader.js` matches `^(\d+)(?:-(.+))?$`.
Optional `evidence.json` selects fixture evidence, `baseline-app-spec.json` supplies the prior spec,
and `entity-edit-app-spec.json` supplies fixture 9's schema-only edit. FormXML file references are
confined to the fixture directory, including when the fixtures root is a junction or symlink.

| # | Slug | What it tests |
|---|---|---|
| 1 | `1-support-desk` | Full data/ui/app/verify oracle (no pages) · two **personas** (Support Agent, Support Lead) exercise the **security** oracle — one role each, app-module read injected, JTBD coverage + least-privilege |
| 2 | `2-orders-multipage` | Page intents + navigation + design contract; page-key round-trip |
| 3 | `3-assets-dashboard` | Global choice + column binding, on-click command, and a classic **dashboard** pinned to the nav — exercises teardown (dashboard/command/web-resource/global-choice steps) + the dashboard round-trip |
| 4 | `4-hardening` | The 2026-07-15 review fixes: a lookup-heavy child (8 scalars + a 1:N parent lookup) proves the default view keeps the lookup (#2) and drops `createdon` (#7); an N:N proves the alphabetically-sorted schema name `new_tag_new_ticket` (#3); a no-label sub-grid proves the own-section + pluralName title (#5); relational sample data proves `validateAppSpec` accepts a resolvable `$parent` match and declared Choice labels (#1/#4) |
| 5 | `5-process-logic` | The two declarative-logic surfaces: a 3-stage **business process flow** whose steps bind both the table's own columns and a **relationship lookup** (`new_customerid`, which is absent from `columns[]`), plus two **business rules** — one multi-action, one multi-condition including a value-less presence operator. Grades stage order, step bindings, clause/action survival, and one teardown step each |
| 6 | `6-form-layout` | Fresh explicit forms: 65/35 form-column widths, grid columns, spans, collapsed tab, read-only reviewer and a polymorphic Customer lookup. Authored shape/state facts are independent of compiler output. |
| 7 | `7-form-reconcile` | Before/desired specs plus independent FormXML: inserted/reordered tabs, reordered sections, hidden tab/section/field, suppressed labels, read-only fields, 50/50 default widths, spans, Quick View binding and stored/served Main form order. |
| 8 | `8-page-roundtrip` | PAC-stored escaped own name differs from navigation title; actual downloaded files preserve a valid model, keep an absent model absent, and omit an invalid one with loss diagnostics. |
| 9 | `9-changed-only` | Baseline and edited `.tsx` bytes: only `overview` is a page-content fast change; adding a column is full with a data-model reason; identical spec and bytes are noop. Real hash, snapshot and classifier helpers run offline. |
| 10 | `10-name-scope` | The same form/view/chart names on two tables do not collide. A straight double quote warns without a rename; apostrophe and typographic-quote controls do not. Same-table duplicates and missing/spurious warnings are negative unit probes, not red corpus fixtures. |

> **Fixture 2 note:** `appShell.subAreas[].page` references use the page's **key** (e.g. `"overview"`), not its display name (`"Overview"`). The v2 validator requires keys, and the linter accepts valid key references; `key === name` is neither required nor used by this fixture.

## `evals.json`

- `skill_name` — identifies this suite.
- `eval_instructions` — description used by eval runners.
- `common_stage_assertions` — run for every fixture; registered in `lib/assertions.js`.
- `evals[].expect` — independent per-eval counts/names plus form-edit, rejected-model, changed-only and name-scope contracts.
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

Keep positive fixtures green. Demonstrate each new or strengthened check with a passing control and
a failing mutation in `tests/facts.test.js`. Do not derive an expected value from the compiler output
being graded. The unit suite also checks fixture/manifest IDs and registered assertion texts, and
`evals/model-apps/tests/eval-coverage-contract.test.js` fails when an assertion returns SKIP on every
fixture it runs on (so it verifies nothing) or when this guide's fixture table misses a fixture.

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

## Failures, skips and advisories

An unexpected verifier exception is a **FAIL**, never a skip. A successful `ok` flag without the
required check kinds is also a failure. Topology reads are required for explicit layouts; a throwing
or missing topology reader cannot certify them.

The optional `servedMainForms` capability is named explicitly: when absent, its own assertion skips;
when present, its checks must run and failures remain failures. Checks with no applicable artifact
also emit a named skip. The legacy PAGEREF compatibility path can skip a resolver that an older
plugin does not supply; the current verifier itself requires that module, so it is not optional on
current plugin versions.

Lint warnings are printed as TAP comments without blanket-failing legitimate advisories. Assertions
check page-quote warning coverage, and fixture 10 rejects wrong name-scope warnings. Invalid downloaded
models are also printed as omission diagnostics. Failing assertions or stage-fact computation return
exit 1; malformed fixtures and argument errors return exit 2.

## Live evals

The live smoke (`plugins/model-apps/scripts/smoke-eval.js`) grades actual Dataverse provisioning.
These offline evals complement it; they do not certify live deployment, SDK serialization or runtime UI behavior.

## Cross-links

- Plugin `AGENTS.md` → *Eval Suite*
- `plugins/model-apps/docs/app-builder-design.md` §13 — structural eval oracles
- `evals/model-apps/genpage/EVAL_GUIDE.md` — the parallel eval suite for `/genpage`
