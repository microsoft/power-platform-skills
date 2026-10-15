---
name: pcf
version: 1.0.0
description: Builds, tests, diagnoses, upgrades, deploys and verifies Power Apps component framework (PCF) code components for model-driven apps and Power Pages — field and dataset controls, standard and virtual (React) — from Microsoft-maintained templates and recipes pinned to a tested version matrix. Runs quality gates (manifest and host lint, source checks, lint, unit tests, production build), deploys with pac pcf push, verifies registration and form bindings, and guides Power Pages enablement, with guided setup for canvas apps. Use when the user wants to build, fix, upgrade, deploy or check a PCF control or code component, or asks why one fails to build, import, update or render. For a whole page use /model-apps:genpage; for a whole app use /model-apps:app-builder.
author: Microsoft Corporation
argument-hint: "<control description> | doctor | upgrade | verify | inventory"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate, TaskList, read, edit, execute, search, web, todo
---
> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# PCF skill

Build, repair, upgrade, deploy, bind, verify and inventory Power Apps component framework controls. Run the work in the main conversation loop. Do not dispatch interactive authoring, approval, deploy consent, binding choices or browser-verification choices to a subagent.

## Critical startup

1. Set `PLUGIN_ROOT` to the installed `plugins/pcf` directory.
2. Resolve interaction once:
   ```powershell
   node "${PLUGIN_ROOT}/scripts/resolve-interaction-mode.js"
   # Optional for automation: --non-interactive
   ```
3. In unattended mode, do not call `AskUserQuestion`, `EnterPlanMode` or `ExitPlanMode`. Use explicit request details and documented non-destructive defaults only; write `Unattended default: <question> → <answer> (<reason>)` to `workflow-log.md` in the session working directory; halt on ambiguous environment, app/form/control identity or destructive choices. `pcf-intent.json`, `pcf-plan.md` and `workflow-log.md` live in that working directory. `hooks/validate-write-safety.js` detects a pcf session only from `pcf-intent.json` or `pcf-plan.md` at or one level under the cwd; `workflow-log.md` is not a session marker. `--out` must be a new, empty subdirectory. Never write those session files into `--out` before scaffold runs — a non-empty directory is refused.
4. Suppressing a prompt never authorizes an environment write. `pcf-push.js` still requires an explicit `--env` and prior consent recorded by the user or automation.

## Routing

| User intent | Route |
| --- | --- |
| Build, fix, upgrade, deploy, bind, verify, inventory a PCF code component | Stay in `/pcf:pcf`. |
| Why a PCF control will not build, import, update or render | Stay in `/pcf:pcf`; start with [../../references/pcf-troubleshooting.md](../../references/pcf-troubleshooting.md) and the doctor output. |
| Whole custom page / generative page | Use `/model-apps:genpage`. |
| Whole model-driven app with tables/forms/views/pages | Use `/model-apps:app-builder`. |
| Use an existing control without code changes | Guide Maker binding and verification; do not scaffold. |

## Modes — detect, then confirm

- **new**: no PCF project exists or the user asks to create one. Follow [create-flow.md](create-flow.md).
- **existing project**: one `*.pcfproj` found. Iterate, gates, deploy-only or bind as requested. If several are found, ask which unless unattended supplied a path.
- **verify**: existing control already registered/bound. Run `verify-pcf.js` or `pcf-inventory.js` as appropriate.
- **pages**: user targets Power Pages. This release supports Power Pages only for standard field controls: the form-field journey and the standalone Liquid journey (`{% codecomponent %}`), both guided. Dataset controls on Pages (form sub-grid and list) are not supported in this release. Run the Pages compatibility gate before deploy or acceptance, then guide site configuration after deploy. Follow [pages-flow.md](pages-flow.md).
- **canvas**: user targets canvas apps. Setup is guided only: gate with the model-driven profile (`model` in the intent and `--hosts`, the gates' default; never `canvas`), keep `pages` as well when the control also targets Power Pages, and review canvas API limits by hand with the user. After the normal push flow, guide the environment setting and Studio setup using [../../references/pcf-canvas.md](../../references/pcf-canvas.md). A canvas gate profile, reading the environment setting and automated runtime evidence are not implemented.
- **doctor**: run `pcf-doctor.js` and stop with fixes unless user asked to apply a repair.
- **upgrade**: follow [upgrade-flow.md](upgrade-flow.md).
- **inventory / "is this control still used?"**: run `pcf-inventory.js --env <url> --where-used`; always include the where-used warning from `pcf-testing.md` because dependency results are registered solution dependencies only, not proof of Liquid or arbitrary text references.

## Phase 0 — preflight

Run the smallest doctor for the requested work:

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-doctor.js" [--project <dir>] [--hosts model,pages] [--needs build,push]
```

When an environment is involved, also run:

```powershell
node "${PLUGIN_ROOT}/scripts/check-auth.js" --env <envUrl> [--require-pac]
```

Use `--require-pac` only for push/package paths and any other path that invokes PAC. Verification and inventory use Azure CLI plus Dataverse reads, so they require `az` auth but not PAC. If auth or tools block, report the script's JSON message and stop.

For repair work, read [../../references/pcf-troubleshooting.md](../../references/pcf-troubleshooting.md) before choosing fixes. It maps build/import/update/render symptoms to the checks and scripts that produce actionable evidence.

## Phase 1 — design → intent → plan approval

Ask only the missing decisions: host(s), field vs dataset, template family, properties, required features, target solution/publisher, binding target, clients, Pages journey, and guided canvas setup. For new controls follow [create-flow.md](create-flow.md).

Write `pcf-intent.json` with schema version 1, then render the plan:

```powershell
node "${PLUGIN_ROOT}/scripts/write-pcf-plan.js" --intent @pcf-intent.json [--manifest ControlManifest.Input.xml] [--out pcf-plan.md]
```

In attended mode, show the rendered plan in plan mode and continue only after approval. In unattended mode, treat a green plan plus explicit non-destructive defaults as approved and log that default.

## Phase 2 — scaffold

For new work, list templates and recipes first:

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-scaffold.js" --list
```

Then scaffold exactly what the approved intent names:

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-scaffold.js" --template <id> --namespace <Namespace> --name <ControlName> --out <dir> [--hosts model,pages] [--recipe <id>] [--display-name <text>] [--description <text>] [--install] [--npm-cli <path>]
```

If the scaffold JSON includes the `PCF_SCAFFOLD_OUT_REDIRECTED` note, tell the user the files were written to `resolvedOutDir`. That note is an `info` finding, not a warning, and appears only when `--out` resolved through a symlink or junction. Checks and writes used that physical path; `outDir` is only the path that was requested.

Do not hand-copy template files. Recipes are routing aids; each current recipe is designed for its listed hosts but **not certified in this release** unless `pcf-recipes.md` shows a certification date.

## Phase 3 — implement

Read [../../references/pcf-best-practices.md](../../references/pcf-best-practices.md), [../../references/pcf-hosts.md](../../references/pcf-hosts.md), [../../references/pcf-testing.md](../../references/pcf-testing.md), and the selected recipe's README, if a recipe was selected (`recipes/<id>/README.md`). Keep versions from the matrix and lockfiles only. Add or preserve tests for null-first rendering, missing parameters, field security, permission failures, two instances and dataset paging where applicable.

## Phase 4 — gates loop

Run gates until green:

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-gates.js" --project <dir> [--hosts model,pages] [--skip lint,test,build]
```

Use `--skip` only for an explicitly irrelevant gate, and explain why. Never weaken a gate, delete a test, remove deployed-only code, or switch hosts just to pass. For a build-only check:

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-build.js" --project <dir> [--mode production|development] [--no-clean]
```

Before redeploying an existing control, compare the current manifest with the previous manifest when a baseline is available:

```powershell
git show <ref>:<path>/ControlManifest.Input.xml > <temp-old-manifest>
node "${PLUGIN_ROOT}/scripts/lint-pcf.js" --manifest <current manifest> --against <temp-old-manifest> [--hosts model,pages] [--strict]
```

If no previous manifest is available, state that compatibility was not compared; do not claim the redeploy is backwards-compatible from gates alone.

## Phase 5 — Pages compatibility gate

For controls targeting Power Pages, run the pre-deploy Pages gate before `pcf-push.js`:

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-gates.js" --project <dir> --hosts pages
```

This release supports Power Pages only for standard field controls: the form-field journey and the standalone Liquid journey (`{% codecomponent %}`), both guided. Dataset controls on Pages (form sub-grid and list) are not supported in this release. Reject dataset Pages targets, unsupported control types, unsupported manifest features and source patterns documented in [../../references/pcf-power-pages.md](../../references/pcf-power-pages.md) before deploy. Keep the field and Liquid site-configuration journeys for after deployment.

## Phase 6 — deploy

Follow [deploy-flow.md](deploy-flow.md). Before running `pcf-push.js`, obtain and record consent naming: environment origin, solution or publisher prefix, and the fact that `pac pcf push` publishes all pending customizations in that environment.

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-push.js" --project <dir> --env <url> (--solution <uniqueName> | --publisher-prefix <p>) [--incremental] [--verbosity minimal|normal|detailed|diagnostic] [--allow-dev-bundle] [--no-verify]
```

## Phase 7 — bind

For model-driven targets and Power Pages form-field journeys, follow [bind-flow.md](bind-flow.md). Use Maker for binding unless the user explicitly brought their own binding automation. Publish after binding before claiming a published level. For canvas-only targets, skip model-driven form binding and follow the canvas setup below.

## Phase 8 — verify and optional runtime check

For canvas-only targets, use the push registration read-back or `pcf-inventory.js` for registration evidence, not FormXML verification. For model-driven targets and Power Pages form-field journeys, verify metadata:

```powershell
node "${PLUGIN_ROOT}/scripts/verify-pcf.js" --env <url> --control <prefix_ns.ctor> [--version <x.y.z>] --table <logical> --form <name|guid> (--column <col>|--control-id <id>) [--clients web,phone,tablet] [--param name=column:<col>] [--param name=static:<value>[:<type>]] [--workspace <dir>]
node "${PLUGIN_ROOT}/scripts/verify-pcf.js" --env <url> --control <prefix_ns.ctor> [--version <x.y.z>] --intent @pcf-intent.json [--workspace <dir>]
```

For model-driven apps and Pages sites, offer a browser runtime check with Playwright MCP when a reachable target exists. If skipped or unavailable, report `runtime-not-checked` honestly. Canvas runtime checks are manual in Power Apps Studio.

## Phase 9 — Pages site configuration and canvas setup

For Power Pages targets after deployment, follow [pages-flow.md](pages-flow.md), [../../references/pcf-power-pages.md](../../references/pcf-power-pages.md), and the host matrix to guide site configuration. This release supports Power Pages only for standard field controls: the form-field journey and the standalone Liquid journey (`{% codecomponent %}`), both guided. Dataset controls on Pages (form sub-grid and list) are not supported in this release. Do not claim Pages runtime certification without opening the site and recording behavior.

For canvas targets after a successful push, follow [../../references/pcf-canvas.md](../../references/pcf-canvas.md) to guide an admin through **Power Apps component framework for canvas apps** and the user through Studio import/setup. Do not read or change the setting automatically. Report `runtime-not-checked` unless the user checks the control in Power Apps Studio; registration and import are not runtime evidence.

## Upgrade and inventory shortcuts

- Upgrade: [upgrade-flow.md](upgrade-flow.md), then gates, redeploy and verify.
- Inventory:
  ```powershell
  node "${PLUGIN_ROOT}/scripts/pcf-inventory.js" --env <url> [--control <name>] [--include-managed] [--where-used] [--workspace <dir>]
  ```
- Lint a manifest directly:
  ```powershell
  node "${PLUGIN_ROOT}/scripts/lint-pcf.js" (--manifest <file> | --project <dir>) [--hosts model,pages] [--against <old manifest>] [--strict]
  ```

## Reporting and evidence levels

| Level | What you may claim | Script or proof |
| --- | --- | --- |
| `built` | Production build completed locally. | `pcf-build.js --project <dir> --mode production` or `pcf-gates.js --project <dir>` build phase. |
| `gated` | Manifest, host, source, lint, tests and build passed. | `pcf-gates.js` green. |
| `registered` | Dataverse has the expected control/version. | `pcf-push.js` verification or `verify-pcf.js`. |
| `bound(draft)` | Draft form/grid metadata uses the control. | `verify-pcf.js` draft read. |
| `bound(published)` | Published metadata uses the control. | `verify-pcf.js` published read after publish. |
| `runtime-verified` | Target host loaded and journey worked. | Browser/Playwright/manual smoke evidence. |
| `runtime-not-checked` | Metadata was checked but runtime was not. | State explicitly; do not round up. |

Final report: control identity, hosts, version, gates, deploy target as a safe placeholder such as `https://contoso.crm.dynamics.com`, evidence level, runtime status, Pages status, canvas status, and inventory warning.
