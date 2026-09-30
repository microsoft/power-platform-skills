# /pcf design record

This document records the `/pcf:pcf` skill as it ships in the pcf plugin. It is a contributor-facing design record; user workflow details live in [`../skills/pcf/SKILL.md`](../skills/pcf/SKILL.md), host policy in [`../references/pcf-hosts.md`](../references/pcf-hosts.md), deployment guidance in [`../references/pcf-deploy.md`](../references/pcf-deploy.md), and troubleshooting in [`../references/pcf-troubleshooting.md`](../references/pcf-troubleshooting.md).

## Purpose and scope

`/pcf` builds, tests, diagnoses, upgrades, deploys, verifies and inventories Power Apps component framework (PCF) code components for model-driven apps and Power Pages.

This release covers:

- Model-driven app and Power Pages host guidance.
- Standard and virtual PCF controls.
- Four scaffold templates: `field-standard`, `dataset-standard`, `field-virtual`, and `dataset-virtual`.
- Six recipes: `star-rating`, `hierarchy-tree`, `lookup-dropdown`, `contextual-grid`, `grid-customizer`, and `attachment-uploader`.
- Intent capture, plan rendering, scaffold, doctor, upgrade, manifest/source/build gates, deploy, binding verification, inventory, and offline evals.
- Developer registration through `pac pcf push` with an explicit `--environment` and skill-recorded consent.

Canvas apps and mobile offline are not covered by this skill. Registration uses `pac pcf push` in this release. Power Pages runtime certification is shown per recipe only when a recipe records runtime evidence.

## Architecture

The skill runs in the main conversation loop because design choices, plan approval, deploy consent and binding decisions require the user or an explicit unattended default. Deterministic work is delegated to dependency-free CommonJS Node scripts under `../scripts/`.

```text
intent/request
  -> skills/pcf/SKILL.md routes new | existing | doctor | upgrade | deploy | bind | verify | inventory
  -> scripts/pcf-doctor.js checks local tooling/project health; check-auth.js runs when an env is involved
  -> pcf-intent.json + scripts/write-pcf-plan.js render pcf-plan.md
  -> scripts/pcf-scaffold.js writes a matrix-pinned template/recipe
  -> implementation uses references/pcf-*.md + recipe README
  -> scripts/pcf-gates.js runs manifest/source/lint/test/build gates
  -> Pages compatibility gate for Pages targets: standard field only + pcf-gates.js --hosts pages
  -> scripts/pcf-push.js --env <url> runs pac pcf push --environment <url>
  -> scripts/verify-pcf.js checks registration and FormXML binding evidence
  -> Pages site configuration guidance and runtime evidence if a target site is reachable
  -> scripts/pcf-inventory.js lists registered controls and where-used dependencies
```

The main route list is intentionally explicit in the skill because prompts never authorize writes by themselves. Deploy, binding, and runtime verification remain decision points in the conversation loop; deterministic scripts provide evidence but do not infer consent.

Libraries are split by concern:

- `pcf-matrix.js` owns version and host policy from `compatibility-matrix.json`.
- `pcf-manifest.js` parses manifests, lints host rules and diffs breaking changes.
- `pcf-code-gate.js` scans source for unsupported host/runtime patterns.
- `pcf-scaffold.js` renders templates and recipes from `templates/`, `shared/`, and `recipes/`.
- `pcf-build.js` executes the project-local `pcf-scripts` binary through `process.execPath`.
- `pcf-dataverse.js` performs read-only verification/inventory through the vendored SDK plus documented raw Dataverse reads for surfaces the SDK does not model.
- `pcf-binding-verify.js` validates model-driven FormXML binding shape.
- `pcf-intent.js` validates the skill's machine-readable intent and renders the plan.
- `pcf-doctor.js` and `pcf-upgrade.js` diagnose and repair common project drift.

## Compatibility matrix

`compatibility-matrix.json` is the only source for PCF toolchain, host, platform-library and dependency-set facts. The committed lockfiles under `lock/standard/` and `lock/virtual/` are the only dependency snapshots used by scaffolds and CI.

Consumers:

- `pcf-scaffold.js` reads dependency sets and host compatibility.
- `pcf-doctor.js` checks Node, npm, PAC, .NET and project dependency drift.
- `pcf-manifest.js` and `pcf-code-gate.js` enforce host and platform-library policy.
- `pcf-ci-build.js` builds templates/recipes and probes published-package drift.
- `references/pcf-hosts.md` renders contributor/user-facing host and platform-library tables.

## Compatibility matrix update procedure

1. Review the linked Microsoft Learn pages and public package metadata named in `compatibility-matrix.json`.
2. Bump the lock sets with `npm install` in each changed lock directory, for example `plugins/pcf/lock/standard` and `plugins/pcf/lock/virtual`.
3. Run `node plugins/pcf/scripts/pcf-ci-build.js --all` from the repository root.
4. Update the matrix `reviewed` date and any changed source/evidence fields.
5. Run the pcf plugin suite with `cd plugins/pcf; node scripts/run-tests.js`.

The weekly drift workflow [`.github/workflows/pcf-matrix-drift.yml`](../../../.github/workflows/pcf-matrix-drift.yml) points maintainers back to this section.

## Templates and recipes

Templates are minimal, tested PCF project families:

| Template | Control kind | React/platform library | Hosts |
| --- | --- | --- | --- |
| `field-standard` | Field | Bundled | Model-driven apps, Power Pages |
| `dataset-standard` | Dataset | Bundled | Model-driven apps, Power Pages guidance |
| `field-virtual` | Field | Platform libraries | Model-driven apps |
| `dataset-virtual` | Dataset | Platform libraries | Model-driven apps |

Scaffolds include the `pcf-scripts` npm commands `build`, `clean`, `rebuild`, `lint`, `lint:fix`, `start`, `start:watch`, `refreshTypes` and `test`. The build/clean hooks are part of the generated contract because `pac pcf push` invokes the project package scripts during developer registration.

Recipes overlay a template with task-focused behavior. The recipe catalog in [`../references/pcf-recipes.md`](../references/pcf-recipes.md) is rendered from `recipes/*/recipe.json` and separates **designed for** hosts from **certified** runtime evidence. Current recipes are available but not certified in this release unless that rendered catalog names a certification date.

## Quality gates and evidence levels

`pcf-gates.js` is the release gate for generated or edited projects:

1. Manifest parse/host/diff checks (`PCF_*` and `PCF_DIFF_*` findings).
2. Source checks for host DOM, `Xrm`, unsupported internal context access, undeclared features and virtual-root ownership (`PCF_CODE_*`, `PCF_VIRTUAL_*`).
3. Project lint.
4. Unit tests.
5. Production build and bundle findings (`PCF_BUILD_*`, `PCF_BUNDLE_*`, `PCF_OUT_*`).

Evidence levels are defined in [`../references/pcf-testing.md`](../references/pcf-testing.md): `built`, `gated`, `registered`, `bound(draft)`, `bound(published)`, `runtime-verified`, and `runtime-not-checked`. A run may honestly end at `runtime-not-checked` when no browser or target site was checked.

## Deploy

`pcf-push.js` deploys by wrapping `pac pcf push --environment <url>`. The skill, not the script, obtains consent before this write and records the target environment origin, solution or publisher prefix, and the publish-all side effect. The script validates PCF names before passing values to PAC and can verify registration afterward.

Release packaging guidance lives in [`../references/pcf-deploy.md`](../references/pcf-deploy.md). Example CI/CD files are under `../pipelines/` and intentionally use placeholders such as `https://contoso.crm.dynamics.com`.

Live-verified deploy facts carried into this design:

- `pac pcf push` registers a control and removes its temporary solution afterward.
- A trivial push can take around two minutes, so scripts and docs budget for a long-running deploy step.
- The platform rejected a stock React template declaring Fluent 9.68.0 with `platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform.` Fluent 9.46.2 was accepted and is the matrix baseline.
- Control web resources are named `cc_<namespace>.<constructor>/<file>` without the publisher prefix.

## Binding and verification

Model-driven binding verification is metadata-first. `verify-pcf.js` reads the registered control, form metadata, draft FormXML and published FormXML, then calls `pcf-binding-verify.js` for field/control placement, client factors and parameter bindings.

Live-verified binding facts:

- A designer-shaped FormXML binding with a custom-control cell class id, matching `uniqueid`/`forControl`, a fallback `<customControl id>`, and all three client factors survived draft and published reads after targeted publish.
- A web-only declaration (`formFactor="2"`) was rejected at form write with `Custom control declaration for form factor(s) 0,1 is missing...`; `PCF_BIND_FACTOR_UNDECLARED` is an error and every binding must declare phone, tablet and web factors.
- A bound control cannot be deleted until the binding is removed and the artifact is published.
- Registered where-used dependencies can be read through `RetrieveDependentComponents(ObjectId, ComponentType=66)`, including the bound `SystemForm` dependency row for a form-bound control. `pcf-inventory.js --where-used` reports only these registered rows; it does not search form or Liquid text. Its output warns that registered dependencies are not proof of Liquid or arbitrary text references, and that an empty result is not "safe to delete".

## Power Pages journeys

Power Pages support is guided by [`../references/pcf-power-pages.md`](../references/pcf-power-pages.md) and host rules in [`../references/pcf-hosts.md`](../references/pcf-hosts.md). This release supports standard controls only for Pages guidance. Virtual controls, platform libraries, unsupported property types, required feature declarations and unguarded host APIs fail or warn before deploy.

Pages outcomes must state whether the journey was runtime-verified. Recipes and the SKILL label uncertified Pages claims as not certified in this release until runtime evidence is recorded in recipe metadata.

## Testing, evals and CI

Automated coverage ships at three levels:

- Unit tests under `scripts/tests/pcf-*.test.js` cover matrix validation, manifest lint/diff, source gates, scaffolding, build orchestration, doctor, upgrade, push, binding verification, inventory and CLI behavior.
- The offline eval harness under `evals/pcf/` grades intent, manifest, source, FormXML, doctor, upgrade and generated-project facts. See [`../../../evals/pcf/EVAL_GUIDE.md`](../../../evals/pcf/EVAL_GUIDE.md).
- CI includes the PCF script-test workflow [`.github/workflows/pcf-script-tests.yml`](../../../.github/workflows/pcf-script-tests.yml), the PCF generated-project workflow [`.github/workflows/pcf-projects.yml`](../../../.github/workflows/pcf-projects.yml), and the matrix drift workflow [`.github/workflows/pcf-matrix-drift.yml`](../../../.github/workflows/pcf-matrix-drift.yml).

The generated-project workflow builds all templates and available recipes on Ubuntu and Windows, with Node 20. On Windows the projects are generated on the runner's local temporary disk, because installs on the OS disk were several times slower. It also runs a packaging smoke that requires PAC CLI plus .NET SDK. Each job has a time limit, so a hung install fails the check instead of holding a runner.

## Status

All shipped components in this release are checked below.

- [x] Skill orchestrator and flows — `skills/pcf/SKILL.md`, `create-flow.md`, `deploy-flow.md`, `bind-flow.md`, `pages-flow.md`, `upgrade-flow.md`; covered by `scripts/tests/pcf-skill-docs.test.js` and the offline eval harness.
- [x] Compatibility matrix and lock sets — `compatibility-matrix.json`, `lock/standard/`, `lock/virtual/`; covered by `scripts/tests/pcf-matrix.test.js` and `pcf-ci-build.js --all`.
- [x] Templates — `templates/field-standard`, `dataset-standard`, `field-virtual`, `dataset-virtual`; covered by `scripts/tests/pcf-scaffold.test.js`, `pcf-gates.test.js`, and generated-project CI.
- [x] Recipes — `recipes/star-rating`, `hierarchy-tree`, `lookup-dropdown`, `contextual-grid`, `grid-customizer`, `attachment-uploader`; covered by `scripts/tests/pcf-scaffold.test.js`, recipe unit-template tests, and generated-project CI.
- [x] Manifest, source and build gates — `scripts/lint-pcf.js`, `scripts/pcf-gates.js`, `scripts/pcf-build.js`, `scripts/lib/pcf-manifest.js`, `pcf-code-gate.js`, `pcf-build.js`; covered by `pcf-manifest.test.js`, `pcf-lint-cli.test.js`, `pcf-code-gate.test.js`, `pcf-gates.test.js`, and `pcf-build.test.js`.
- [x] Doctor and upgrade — `scripts/pcf-doctor.js`, `scripts/pcf-upgrade.js`, `scripts/lib/pcf-doctor.js`, `pcf-upgrade.js`; covered by `pcf-doctor.test.js` and `pcf-upgrade.test.js`.
- [x] Deploy, verify and inventory — `scripts/pcf-push.js`, `scripts/verify-pcf.js`, `scripts/pcf-inventory.js`, `scripts/lib/pcf-dataverse.js`, `pcf-binding-verify.js`; covered by `pcf-push.test.js`, `pcf-verify-cli.test.js`, `pcf-inventory.test.js`, `pcf-dataverse*.test.js`, and `pcf-binding-verify.test.js`.
- [x] Public references — `references/pcf-best-practices.md`, `pcf-deploy.md`, `pcf-hosts.md`, `pcf-power-pages.md`, `pcf-recipes.md`, `pcf-testing.md`, `pcf-troubleshooting.md`; covered by `pcf-skill-docs.test.js` and repository metadata validators.
- [x] Eval harness — `evals/pcf/`; covered by `node evals/pcf/run-pcf.js --tier smoke`, `--tier full`, and `node --test evals/pcf/tests/*.test.js`.
- [x] Drift guard for copied model-apps and shared-skill sources — `scripts/tests/model-apps-copies.test.js`; covered by the plugin suite and by CI path filters that include the model-apps sources pcf bundles.
- [x] Write-safety hook and markers — `hooks/hooks.json`, `hooks/validate-write-safety.js`; covered by `scripts/tests/validate-write-safety.test.js` and `node scripts/validate-hooks-manifests.js`.
