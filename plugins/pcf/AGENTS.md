# PCF Plugin Development Guide

This plugin ships the `/pcf:pcf` skill for Power Apps component framework (PCF) code components.

## Layout

- `compatibility-matrix.json` — PCF toolchain, host and dependency source of truth.
- `lock/standard` and `lock/virtual` — committed dependency snapshots used by scaffolds and CI.
- `templates/`, `shared/`, `recipes/` and `pipelines/` — generated-project source material.
- `scripts/` and `scripts/lib/` — PCF CLIs and shared helpers.
- `skills/pcf/` — skill workflow files.
- `references/` and `docs/pcf-design.md` — user-facing guidance and the shipped design record.
- `evals/pcf/` — offline structural and generated-project eval fixtures.

## PCF standards

- **Versions only from the matrix** — update `compatibility-matrix.json` and `lock/<set>/` together; do not hard-code PCF toolchain versions in scripts, templates or docs.
- **Gates before deploy** — `pcf-gates.js` must pass before `pcf-push.js` unless the user explicitly accepts a scoped skip and the final report names it.
- **Documented APIs only** — no host DOM shortcuts, raw `window.parent`, undeclared feature use, or undocumented `context` internals.
- **Grid customizer marker** — the Power Apps grid customizer extension pattern may call `fireEvent` only from `customizerBridge.ts(x)` carrying `pcf-extension-pattern: grid-customizer`.
- **Record context through inputs** — do not use `Xrm`, `context.page`, or `context.mode.contextInfo`; pass `entityId` and `entityName` as maker-configured properties when a recipe needs the current record.
- **Template/recipe health** — every committed PCF template and available recipe must pass `pcf-gates.js` through `pcf-ci-build.js --all`.
- **Power Pages claims** — label designed-for vs certified separately; do not claim Pages runtime certification without runtime evidence recorded in recipe metadata.

## Script contracts

Every CLI starts with `parseArgs(argv)` and `validateFlags(argv, { known, needValue, hints })`. Usage errors print `USAGE`; non-usage failures exit 1 and emit one JSON result object on stdout. Scripts are dependency-free CommonJS and run on Node 20 and 22 across CI.

Named external CLIs go through `scripts/lib/process-runner.js` with `shell:false`. Resolved JavaScript entry points run under `process.execPath <file>` with an argv array via `scripts/lib/node-tool.js`.

## Code copied from model-apps

Marketplace installs copy only one plugin directory, so pcf carries physical copies of model-apps helpers needed by PCF scripts: `process-runner.js`, `sdk-http-client.js`, `odata.js`, `source-literals.js`, `interaction-mode.js`, `nearest-name.js`, `utf8-stream.js`, `check-auth.js`, `resolve-interaction-mode.js`, and the vendored SDK bundle in `scripts/vendor/`. It also carries a documented subset of `dataverse-auth.js` whose retained function bodies match model-apps except for the PCF-specific `emitResult` JSON error contract.

Run `node --test scripts/tests/model-apps-copies.test.js` after changing any copied source. Refresh verbatim copies with `Copy-Item` from `plugins/model-apps`; refresh the SDK by re-vendoring it in model-apps first, then copying the resulting bundle into pcf. Do not copy model-apps telemetry into pcf.

## Working with /model-apps:app-builder

Cross-plugin integration is a hand-off at the skill level. When the pcf plugin is installed, a model-apps agent invokes `/pcf:pcf` and passes a `pcf-intent.json`; otherwise it tells the user to install the pcf plugin. There is never a script-level call because plugins install separately. Binding a registered control from an App Spec goes through the Dataverse SDK by control name, which both plugins vendor.

## Testing commands

- `cd plugins/pcf; node scripts/run-tests.js`.
- `node plugins/pcf/scripts/pcf-ci-build.js --all`.
- `node plugins/pcf/scripts/pcf-ci-build.js --package`.
- `node plugins/pcf/scripts/pcf-ci-build.js --all --latest`.
- `node --test evals/pcf/tests/*.test.js` and `node evals/pcf/run-pcf.js --tier full`.

PCF generated-project CI lives in `.github/workflows/pcf-projects.yml`; weekly matrix drift lives in `.github/workflows/pcf-matrix-drift.yml`. The script-test workflow also watches the model-apps source files that pcf copies so drift failures happen in the same PR as the source edit.
