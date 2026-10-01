# /pcf Offline Eval Harness — Guide

## What we evaluate

This harness grades `/pcf:pcf` offline. It does not call Dataverse, PAC, npm, or an LLM. It has two layers:

- **Layer S — structural facts:** deterministic PCF facts are computed from small fixtures and checked against expectations written in `evals.json`.
- **Layer G — generated-output grading:** captured or synthetic control projects are graded by the same manifest and source gates the skill runs. Build, lint, and test are optional and skipped unless `node_modules` is present.

Assertions are fixed by contract. The pcf plugin `AGENTS.md` states that an expectation must come from the contract, independent of the code under test, while fixtures should come from real builder output where possible. Accordingly, `evals.json` names expected finding codes and upgrade step ids literally; the runner never derives expected codes from the plugin primitives it grades.

## Stage → oracle table

| Stage | Oracle | Plugin primitive |
|---|---|---|
| intent | schema validation, binding lint codes, chosen template/hosts, rendered plan sections | `pcf-intent.js` (`validateIntent`, `lintBindingIntent`, `renderPlanMarkdown`) |
| manifest | parse/lint codes per host and manifest-diff codes | `pcf-manifest.js` (`parseManifest`, `lintManifest`, `diffManifests`) |
| code | source and feature-use gate codes | `pcf-code-gate.js` (`gateSources`) |
| formxml | binding status and issue codes for field/control placement | `pcf-binding-verify.js` (`verifyBinding`) |
| doctor | project health finding ids | `pcf-doctor.js` (`collectProject`, `checkProject`) |
| upgrade | automatic step ids and manual step ids | `pcf-upgrade.js` (`planUpgrade`) |
| generated | manifest + code gate combined | `pcf-manifest.js` + `pcf-code-gate.js` |

## Fixtures

Fixture directories use the app-builder-compatible numeric loader shape `^(\d+)(?:-(.+))?$`.

| # | Family | Tier | Slug | What it tests |
|---|---|---|---|---|
| 1 | intent | smoke | `001-intent-field-clean` | Clean field-standard intent for model + Pages; plan sections render. |
| 2 | intent | smoke | `002-intent-pages-multi-field` | Pages multi-field binding is blocked. |
| 3 | intent | full | `003-intent-quickcreate-subgrid` | Quick-create dataset sub-grid binding is blocked. |
| 4 | intent | full | `004-intent-pages-virtual-list` | Virtual Pages target is blocked; list, form sub-grid and dataset journey values are schema-invalid without obsolete list warnings. |
| 5 | manifest | smoke | `005-manifest-field-clean` | Clean standard field manifest for model + Pages. |
| 6 | manifest | full | `006-manifest-pages-virtual` | Virtual control and platform-library policy for Pages. |
| 7 | manifest | full | `007-manifest-feature-policy` | Duplicate and required feature declarations. |
| 8 | manifest | full | `008-manifest-diff-removed` | Breaking property removal diff. |
| 9 | code | full | `009-source-clean-webapi` | Declared WebAPI use passes. |
| 10 | code | smoke | `010-source-xrm-webapi-undeclared` | `Xrm.` and undeclared WebAPI use fail. |
| 11 | code | full | `011-source-virtual-root` | Virtual control owning its React root fails. |
| 12 | code | full | `012-source-pages-unguarded-device` | Unguarded Pages device API call fails. |
| 13 | formxml | smoke | `013-formxml-bound-all-clients` | Round-tripped all-client field binding passes. |
| 14 | formxml | full | `014-formxml-web-only` | Missing form-factor declarations fail. |
| 15 | formxml | full | `015-formxml-default-control` | Non-custom default cell is not bound. |
| 16 | formxml | full | `016-formxml-duplicate-cells` | Ambiguous duplicate target cells fail. |
| 17 | doctor | smoke | `017-doctor-clean` | Matrix-aligned scaffold with install marker is clean. |
| 18 | doctor | full | `018-doctor-missing-install` | Missing lockfile and `node_modules` are reported. |
| 19 | doctor | full | `019-doctor-legacy-buildmode` | Legacy ESLint and development build mode are reported. |
| 20 | doctor | full | `020-doctor-virtual-pages` | Virtual project targeting Pages reports host conflict. |
| 21 | upgrade | smoke | `021-upgrade-clean` | Clean project has no upgrade steps. |
| 22 | upgrade | full | `022-upgrade-deps` | Drifted package versions plan `DEPS_TO_MATRIX` + `REINSTALL`. |
| 23 | upgrade | full | `023-upgrade-buildmode` | Development build mode plans `BUILDMODE_PRODUCTION`. |
| 24 | upgrade | smoke | `024-upgrade-virtual-pages-manual` | Virtual Pages migration is manual. |
| 25 | generated | full | `025-generated-good` | Synthetic good generated project passes. |
| 26 | generated | full | `026-generated-xrm-webapi` | Synthetic project with `Xrm.` + undeclared WebAPI fails. |
| 27 | generated | full | `027-generated-pages-virtual` | Synthetic virtual control targeting Pages fails. |
| 28 | intent | full | `028-intent-pages-liquid` | Standalone standard field Liquid intent is accepted without a model-driven form binding. |
| 29 | intent | full | `029-intent-pages-dataset` | Dataset control targeting Pages is blocked even with the allowed form-field journey and no binding. |
| 30 | intent | full | `030-intent-pages-list` | List journey is rejected by schema validation, not guided as an advisory configuration step. |

**Smoke subset:** 1, 2, 5, 10, 13, 17, 21, 24.

## How to add a case

1. Add a new `fixtures/<N>-<slug>/` directory. Prefer fixtures rendered by `plugins/pcf/scripts/lib/pcf-scaffold.js` or copied from plugin test fixtures when the shape corresponds to shipped artifacts.
2. Add a matching entry in `evals.json`. Write expected finding codes or upgrade ids literally from the contract.
3. Add or reuse assertion texts from `lib/assertions.js`.
4. Run `node evals/pcf/run-pcf.js --tier full`.

## Captured-agent corpus procedure

Layer G fixtures can be captured from live-lane agent-produced projects, including the first corpus entries from fresh control creation, repair of a seeded broken project, version migration, and a Pages incompatibility request.

1. Capture the project:
   ```powershell
   node evals/pcf/capture-pcf-fixture.js <projectDir> evals\pcf\fixtures\<N>-<slug>
   ```
   The capture tool excludes `node_modules`, `out`, `obj`, `bin`, and `generated`, and refuses paths outside `evals/pcf/fixtures/`.
2. Scrub the captured files: no real environment, tenant, or org identifiers; use `https://contoso.crm.dynamics.com` for examples.
3. Run `node scripts/validate-no-real-environments.js` from the repository root.
4. Write the Layer G expectations by contract in `evals.json`.
5. Run the full PCF eval harness.

## Running

From the repository root:

```powershell
node evals\pcf\run-pcf.js --tier smoke
node evals\pcf\run-pcf.js --tier full   # all cases
node --test evals\pcf\tests\*.test.js
```

Exit codes match app-builder: `0` all pass, `1` assertion failure, `2` harness or argument error.

## TAP output

```text
TAP version 13
1..8
# Subtest: 001-001-intent-field-clean
    ok 1 - contract: every expected code is present
    ok 2 - contract: every forbidden code is absent
    ...
ok 1 - 001-001-intent-field-clean
# tests 40
# pass  40
# fail  0
# skip  0
# fixtures 8 (pass 8, fail 0)
```
