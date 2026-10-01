# PCF Plugin Development Guide

This plugin ships the preview `/pcf:pcf` skill for Power Apps component framework (PCF) code components.

`/pcf` builds, tests, diagnoses, upgrades, deploys, verifies and inventories PCF components for model-driven apps and Power Pages. The authoring flow runs in the main conversation loop, not a `Task` subagent, because plan approval, environment consent, binding choices and runtime-verification choices are interactive. Unattended mode uses `scripts/resolve-interaction-mode.js`; suppressing a prompt never authorizes an environment write. The public design record is [`docs/pcf-design.md`](docs/pcf-design.md).

Primary references: [`references/pcf-hosts.md`](references/pcf-hosts.md), [`references/pcf-best-practices.md`](references/pcf-best-practices.md), [`references/pcf-testing.md`](references/pcf-testing.md), [`references/pcf-deploy.md`](references/pcf-deploy.md), [`references/pcf-power-pages.md`](references/pcf-power-pages.md), [`references/pcf-recipes.md`](references/pcf-recipes.md), [`references/pcf-troubleshooting.md`](references/pcf-troubleshooting.md), and [`docs/pcf-capabilities.md`](docs/pcf-capabilities.md).

## Layout

- `.plugin/plugin.json` and `.claude-plugin/plugin.json` — plugin metadata and legacy mirror.
- `compatibility-matrix.json` — PCF toolchain, host and dependency source of truth.
- `lock/standard` and `lock/virtual` — committed dependency snapshots used by scaffolds and CI.
- `templates/`, `shared/`, `recipes/` and `pipelines/` — generated-project source material.
- `scripts/` and `scripts/lib/` — PCF CLIs and shared helpers.
- `scripts/vendor/cds-maker-sdk.cjs` — self-contained vendored SDK bundle copied from model-apps.
- `hooks/` — lifecycle hook registration and the PCF write-safety guard.
- `skills/pcf/` — skill workflow files.
- `skills/report-issue/` — bundled shared bug-report workflow.
- `references/`, `docs/pcf-design.md`, and `docs/pcf-capabilities.md` — user-facing guidance, the shipped design record, and capability evidence.
- `evals/pcf/` — offline structural and generated-project eval fixtures.

## Behavioral spec per script

- **`scripts/write-pcf-plan.js` → `scripts/lib/pcf-intent.js`** — validates `pcf-intent.json`, lints binding intent (`PCF_INTENT_*`) and renders `pcf-plan.md`. Schema-invalid shapes fail with structured JSON before rendering. It is the only writer for the readable PCF summary; do not hand-author that summary after the intent changes.
- **`scripts/pcf-scaffold.js` → `scripts/lib/pcf-scaffold.js`** — lists templates/recipes and renders selected projects from `templates/`, `shared/`, `recipes/`, the compatibility matrix and committed lock sets. Generated `package.json` files include the `pcf-scripts` npm commands `build`, `clean`, `rebuild`, `lint`, `lint:fix`, `start`, `start:watch`, `refreshTypes` and `test`, including the build/clean hooks that `pac pcf push` expects. It validates namespace/name/path containment before writing, optionally runs `npm install`, and emits JSON. Before any emptiness or project check, and before every write, it resolves the physical output path: realpath of the nearest existing ancestor (`fs.realpathSync.native` where available) plus the remaining segments. Links are allowed. JSON includes the requested `outDir` and `resolvedOutDir`; when they differ it emits warning `PCF_SCAFFOLD_OUT_REDIRECTED`.
- **`scripts/lint-pcf.js` → `scripts/lib/pcf-manifest.js` + `pcf-matrix.js`** — parses `ControlManifest.Input.xml`, enforces manifest and host policy (`PCF_*`, `PCF_PAGES_*`, `PCF_PLATFORM_LIB_*`, `PCF_FLUENT_*`), and optionally diffs against a previous manifest (`PCF_DIFF_*`). Project lint fails when no manifest is discovered.
- **`scripts/pcf-gates.js`** — one-command gate: manifest, source, lint, test and production build. Gate finding families include manifest/source codes above plus `PCF_TEST_*` and `PCF_BUILD_*`; `--skip` is only for an explicitly irrelevant gate and must be explained by the skill.
- **`scripts/pcf-build.js` → `scripts/lib/pcf-build.js`** — finds one `.pcfproj`, cleans by default, invokes the project-local `pcf-scripts` bin through `process.execPath`, checks `PcfBuildMode`, bundle size and unexplained outputs (`PCF_BUILD_*`, `PCF_BUNDLE_*`, `PCF_OUT_*`). `PcfBuildMode` only takes effect after the `Microsoft.Common.props` import.
- **`scripts/pcf-doctor.js` → `scripts/lib/pcf-doctor.js`** — checks local tools and project health for the requested needs. `--needs` accepts only `build,push`, and `--hosts` accepts only `model,pages`; unknown or empty selections fail before probing. Finding ids use `TOOL_*` and `PROJ_*`, plus matrix/host findings reused from manifest policy. The `.pcfproj` import scan is quote-aware, so a `Condition` containing a quoted `>` does not hide `Microsoft.Common.props` whether that attribute comes before or after `Project`.
- **`scripts/pcf-upgrade.js` → `scripts/lib/pcf-upgrade.js`** — plans and optionally applies bounded repairs: dependency alignment, build-mode placement and platform-library declaration alignment. Each replacement is written to a temp file in the same directory and renamed over the target, so a throw cannot truncate the project file. On any write failure every attempted target, including the one that threw, is restored from its in-memory original bytes; the result reports nothing applied and lists what was restored. Step ids include `DEPS_TO_MATRIX`, `REINSTALL`, `BUILDMODE_PRODUCTION`, `PLATFORM_LIB_VERSION`, and manual migration ids for non-automatic changes. `REINSTALL` is selectable whenever the plan contains it. Each plan step has `requiresStep`; `DEPS_TO_MATRIX` requires `REINSTALL` because pinning `package.json` without reinstalling leaves a stale lockfile, and selecting `DEPS_TO_MATRIX` includes that step. `--steps` errors list every selectable id, including `REINSTALL`. It validates `--hosts`, refuses dirty trees unless `--allow-dirty` is explicit, and applies relative to the discovered PCF project root.
- **`scripts/pcf-push.js`** — wraps `pac pcf push --environment` for developer verification. The skill must obtain consent before calling it because PAC publishes all pending customizations. It validates solution/publisher/control names before passing values to PAC, allows dev bundles only with bare `--allow-dev-bundle`, and verifies registration unless bare `--no-verify` is explicit.
- **`scripts/verify-pcf.js` → `scripts/lib/pcf-dataverse.js` + `pcf-binding-verify.js`** — reads registration and FormXML metadata, then reports metadata evidence (`registered`, `bound(draft)`, `bound(published)`). `--intent` reads the canonical binding target from `bindings[].target` (`column` or `controlId`), with compatibility handling for older flat fields. The `/pcf` skill reports `runtime-not-checked` when no browser or manual runtime check was run. Binding findings use `PCF_BIND_*`; semantic clients are `phone`, `tablet`, `web`, mapped to FormXML factors only in `pcf-binding-verify.js`; explicit intent client arrays must normalize to at least one client.
- **`scripts/pcf-inventory.js` → `scripts/lib/pcf-dataverse.js`** — lists registered controls and optional where-used dependencies such as the bound `SystemForm` rows returned by Dataverse dependency APIs. It warns that dependency results are registered solution dependencies only and are not proof of Liquid or arbitrary text references.
- **`scripts/pcf-ci-build.js`** — generated-project CI helper. `--all` scaffolds templates and available recipes, runs installs and gates; `--templates` does the same for the templates only; `--latest` probes published dependency drift and keeps those resolved versions even when gates fail; `--package` builds a small package smoke through PAC solution packaging. Gate success requires exactly one JSON result whose records are manifest, code, lint, test and build, each `ok`. Package smoke parses every `<code path>` with the quote-aware XML reader, requires those files in the control folder, and compares them to bundle bytes snapshotted immediately after each build.

## Agent-safety rules

- Every CLI starts with `parseArgs(argv)` and `validateFlags(argv, { known, needValue, hints })`. Usage errors print `USAGE`; non-usage failures exit 1 and emit one JSON result object on stdout so callers can parse failures consistently.
- Scripts are dependency-free CommonJS and run on Node 20 and 22 across the CI matrix.
- Named external CLIs (`az`, `pac`, `npm`/`npx` shims, `git`, `dotnet`) go through `scripts/lib/process-runner.js`, which resolves them to absolute executables and starts them with `shell:false`; Windows batch shims such as `pac.cmd` run under checked `cmd.exe` arguments inside that runner. Resolved JavaScript entry points (for example `npm-cli.js`, `pcf-scripts`, and Jest) run under the current Node as `process.execPath <file>` with an argv array and `shell:false` via `scripts/lib/node-tool.js`; never use `npm run` or `npx` when the JS entry point is known. PCF's `pac-exec.js` is only a result-shape adapter over the runner.
- Versions come only from `compatibility-matrix.json` and lockfiles under `lock/`; no other PCF toolchain version source is allowed.
- Dataverse write surfaces use documented APIs. The `customcontrol` table is never written; Learn marks it internal-use only.
- Raw Dataverse reads are allowed only where the vendored SDK has no modeled method, with a WHY comment naming the missing method such as `RetrieveUnpublished` or `RetrieveDependentComponents`.

## Finding-id families

| Family | Owner | Meaning |
| --- | --- | --- |
| `PCF_INTENT_*` | `pcf-intent.js` | Skill intent and binding-plan errors. |
| `PCF_*`, `PCF_PAGES_*` | `pcf-manifest.js` | Manifest, host and compatibility policy. |
| `PCF_DIFF_*` | `pcf-manifest.js` | Breaking or risky manifest changes. |
| `PCF_PLATFORM_LIB_*`, `PCF_FLUENT_*` | `pcf-matrix.js` | Platform-library declaration policy. |
| `PCF_CODE_*`, `PCF_VIRTUAL_*` | `pcf-code-gate.js` | Source patterns that are unsupported or require declaration. Optional Pages APIs need a positive dominating `typeof` guard; a negated check, an unrelated `||`, or the else branch is unguarded. |
| `PCF_CODE_FIXED_ELEMENT_ID` | `pcf-code-gate.js` | Warning: a string-literal element id is shared by every instance, so two instances on one form collide. Derive ids per instance (React `useId` or an instance counter). |
| `PCF_BUILD_*`, `PCF_BUNDLE_*`, `PCF_OUT_*` | `pcf-build.js` | Build mode, bundle and output hygiene. |
| `PCF_BIND_*` | `pcf-binding-verify.js` | FormXML binding, client factor and parameter evidence. |
| `TOOL_*`, `PROJ_*` | `pcf-doctor.js` | Local toolchain and project-health diagnostics. |
| `DEPS_TO_MATRIX`, `BUILDMODE_PRODUCTION`, `PLATFORM_LIB_VERSION`, etc. | `pcf-upgrade.js` | Upgrade plan steps. |
| `PCF_SCAFFOLD_OUT_REDIRECTED` | `pcf-scaffold.js` | Requested `--out` resolved through a link to a different physical path. |

## PCF standards

- **Versions only from the matrix** — update `compatibility-matrix.json` and `lock/<set>/` together; do not hard-code PCF toolchain versions in scripts, templates or docs.
- **Gates before deploy** — `pcf-gates.js` must pass before `pcf-push.js` unless the user explicitly accepts a scoped skip and the final report names it.
- **Documented APIs only** — no host DOM shortcuts, raw `window.parent`, undeclared feature use, or undocumented `context` internals.
- **Grid customizer marker** — the Power Apps grid customizer extension pattern may call `fireEvent` only from `customizerBridge.ts(x)` carrying `pcf-extension-pattern: grid-customizer`.
- **Record context through inputs** — do not use `Xrm`, `context.page`, or `context.mode.contextInfo`; pass `entityId` and `entityName` as maker-configured properties when a recipe needs the current record.
- **Template/recipe health** — every committed PCF template and available recipe must pass `pcf-gates.js` through `pcf-ci-build.js --all`.
- **Power Pages claims** — label designed-for vs certified separately; do not claim Pages runtime certification without runtime evidence recorded in recipe metadata.

## CLI argument contract

**Every `scripts/*.js` entry point declares its flags and validates them up front.** `parseArgs` accepts any `--name`, and an unrecognised flag is both dropped silently and swallows the token after it, so a typo does not fail: it quietly changes what the command does.

So a `main()` starts with:

```js
const argv = process.argv.slice(2);
const { positional, flags } = parseArgs(argv);
const flagError = validateFlags(argv, {
  known: ['env', 'project', 'apply'],
  needValue: ['env', 'project'],
  hints: { project: 'path to a PCF project' },
});
if (flagError) { process.stderr.write(`✗ ${flagError}\n${USAGE}\n`); process.exit(1); }
```

`validateFlags` (`scripts/lib/dataverse-auth.js`) rejects unknown flags with a single-edit "did you mean" (via `scripts/lib/nearest-name.js`) and rejects a value-bearing flag passed bare or empty. It reads flag names from `argv` rather than the parsed object, because `--__proto__` goes through the inherited setter and never becomes an own property.

Boolean switches are bare only. For example, use `--strict`, `--install`, `--no-clean`, `--allow-dev-bundle` and `--no-verify`; values such as `--strict=false` or `--no-verify=false` are usage errors, not false booleans.

When a CLI test harness maps `parseArgs` to a fixed result, use `scripts/tests/helpers/fake-auth.js` → `validateFlagsFromParsed` so the harness exercises the real validator instead of a hand-written copy that can drift from it. `scripts/tests/helpers/cli-harness.js` → `loadCli(scriptPath, { requires, argv })` loads an entry point with injectable module stubs and a shadowed `process`, so a test can drive `main()` and assert the wire calls it makes rather than regex-matching source.

## Code copied from model-apps

Marketplace installs copy only one plugin directory, so pcf carries physical copies of model-apps helpers needed by PCF scripts. `scripts/validate-plugin-copies.js` is the source of truth for the copy list and subset rules, including the PCF-specific `emitResult` JSON error contract in `dataverse-auth.js`. The subset check also requires every top-level declaration a retained function closes over, so deleting an import such as `nearestName` fails even when the function text still matches.

Run `node --test scripts/tests/model-apps-copies.test.js` after changing any copied source. Refresh verbatim copies with `Copy-Item` from `plugins/model-apps`; refresh the SDK by re-vendoring it in model-apps first, then copying the resulting bundle into pcf. Do not copy model-apps telemetry into pcf.

## Working with /model-apps:app-builder

Any integration with `/model-apps:app-builder` stays at the skill level. With both plugins installed, an agent can invoke `/pcf:pcf` and pass it a `pcf-intent.json`; when pcf is missing, it tells the user to install the pcf plugin. Never add a script-level call in either direction: plugins install separately, so neither can rely on the other's files. Anything model-apps needs to know about a registered control, such as its name for a binding, comes from Dataverse through the SDK both plugins vendor, not from pcf's scripts.

## Docs sync

| Change | Update together |
| --- | --- |
| Matrix versions, host support or platform-library rules | `compatibility-matrix.json`, matching `lock/<set>/`, `references/pcf-hosts.md`, `docs/pcf-design.md`, and generated-project CI evidence. |
| Template or recipe behavior | `templates/`, `shared/`, `recipes/`, recipe README, `references/pcf-recipes.md`, unit tests and eval fixtures when the contract changes. |
| Deploy, binding, verification or inventory behavior | `references/pcf-deploy.md`, `references/pcf-testing.md`, `docs/pcf-design.md`, relevant CLI tests and eval cases. |
| Copied model-apps helper behavior | Refresh the pcf copy and update `scripts/validate-plugin-copies.js`, `scripts/tests/model-apps-copies.test.js` or workflow path filters when the source list changes. |
| Capability evidence or preview status | `docs/pcf-capabilities.md`, `docs/pcf-design.md`, `README.md`, and `CHANGELOG.md`. |

## Testing commands

- `cd plugins/pcf; node scripts/run-tests.js`.
- `node plugins/pcf/scripts/pcf-ci-build.js --all`.
- `node plugins/pcf/scripts/pcf-ci-build.js --package`.
- `node plugins/pcf/scripts/pcf-ci-build.js --all --latest`.
- `node --test evals/pcf/tests/*.test.js` and `node evals/pcf/run-pcf.js --tier full`.

PCF generated-project CI lives in `.github/workflows/pcf-projects.yml`; weekly matrix drift lives in `.github/workflows/pcf-matrix-drift.yml`. The script-test workflow also watches the model-apps source files that pcf copies so drift failures happen in the same PR as the source edit.

## Eval harness

The `/pcf` eval harness lives under `evals/pcf/` and has two offline layers:

- **Layer S — structural facts** for intent, manifest, source, FormXML, doctor and upgrade cases.
- **Layer G — generated-output grading** that reuses the manifest/source gates against captured or synthetic projects. Build/lint/test are skipped unless dependencies are present.

Run from the repo root:

```bash
node evals/pcf/run-pcf.js --tier smoke
node evals/pcf/run-pcf.js --tier full
node --test evals/pcf/tests/*.test.js
```

See [`evals/pcf/EVAL_GUIDE.md`](../../evals/pcf/EVAL_GUIDE.md) for fixture rules, the captured-agent corpus procedure, and the stage-to-oracle table.
