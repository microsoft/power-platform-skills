---
name: create-mobile-app
description: Use when the user wants to start a new Power Apps mobile app (Expo / React Native / TypeScript, targeting iOS and Android) from scratch.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill, Task, EnterPlanMode, ExitPlanMode
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - read first, once. Covers workflow checkpoints, safety guardrails, CLI resolution, OS-aware shell rules, and command-failure handling. Read it in the same message as Step 0's command, and do not read it again unless it has left your context.

# Create Power Apps Code App (Native)

Top-level orchestrator. Owns the user-visible flow, its approval gates, and the build plan, and delegates screens, planning, and per-domain changes to agents and the `/add-*` skills.
This file routes the request and chooses the **build order** at Step 0; the chosen flow file holds every step after that.

For every child skill handoff, pass the invocation-scoped
[app-edit-routing.md](../../shared/references/app-edit-routing.md) context:
`MOBILE_APP_ORCHESTRATING=1`, `orchestrator: create-mobile-app`, the absolute
`working_dir`, current `phase`, and the exact approved scope/answers for
implementation. Forward it through routers and native helpers; do not persist it
or rely on an earlier shell export. The plan exists before the app is fully built,
so children must use this context rather than mistake creation for a standalone
edit. Design/configuration children still own any approval explicitly delegated
to their phase; this marker never skips those gates.

## Build orders

Both build orders make the same app to the same quality bar, and in both the user approves the screens, the architecture, and the data model before they are built. They differ in what is built first and when the app first runs.

| Build order | Flow | What the user sees |
|---|---|---|
| **Screens first** (recommended) | [`references/screens-first.md`](references/screens-first.md) (Steps 1-8), then [`references/make-it-real.md`](references/make-it-real.md) (Steps 9-17) | The screens are planned and built on sample data, and the app runs live in the build plan's phone within minutes, each screen appearing as it finishes. The design system, architecture, data model, sign-in, and connections follow, and the screens switch to real data before the device QR. |
| **Data model first** | [`references/data-model-first.md`](references/data-model-first.md) (Steps 1-13) | The architecture, data model, and screen specifications are approved up front, and the tables, connectors, and services exist before any screen is written. The app first runs at the end, on real data. |

Read only the chosen flow. The other flow's steps, phases, and gates never apply to the run, even where their step numbers match.

## Fresh-template working-directory mode

This skill assumes the user already has a **fresh** `microsoft/power-platform-skills/plugins/mobile-apps/template#main` template materialized with `degit` in the target working directory and has already run `npm install` there. The skill turns that fresh template into an app; it does not clone, degit, or copy a template itself.

**Fresh template required for creation.** If the working directory is not a fresh
template, STOP creation and follow the state-specific routing below. Do not send
an existing-app edit request to a new folder. Missing generated markers alone do
not prove freshness: if the template is customized or its state is unclear, ask
before proceeding. Only a request for a new app requires a fresh template folder.

Resolve the original request before classifying project state. Apply this
state-routing table once in Step 0, in the order below; file markers are
supporting evidence, not user intent or approval.

| State | Detection | Action |
|---|---|---|
| Creation continuation | Explicit creation-continuation intent or a valid current create handoff for this app, not a request to edit an existing app | Use Step 0's continuation path. Require matching unfinished creation progress and confirm the next phase before continuing; missing or conflicting progress requires clarification, not fresh scaffolding. |
| Already-created app | Existing-app intent or confirmed app customizations/materialized state, even when generated markers are missing. `memory-bank.md`, `.datamodel-manifest.json`, and `src/generated/services/*.ts` can corroborate state, but do not select creation resume | STOP creation: never re-scaffold it. If the request changes this app, preserve the original request and execute the shared existing-app entry routing; invoke `/edit-app` only after **Full app integration**. If the user wants a separate new app, ask for a fresh template folder. |
| Fresh template | Confirmed new-app intent and a confirmed uncustomized starter; `package.json`, `app.config.js`, `auth.config.json`, and `tamagui.config.ts` exist; `node_modules/expo` exists; no materialized app bindings, `memory-bank.md`, `.datamodel-manifest.json`, or generated Dataverse services. An approved creation plan and its planning artifacts are allowed | Choose the build order, then proceed to the flow's Step 1 only when every condition is satisfied. Missing generated markers alone do not establish freshness. |
| Template not installed | Confirmed new-app intent and a confirmed uncustomized starter with the required template files, but `node_modules/expo` is absent | STOP: ask user to run `npm install` in the template folder, then rerun. Do not provision ADO npm tokens here. |
| Not template | Confirmed new-app intent in a new/unsupported directory, after excluding existing-app work and creation continuation | STOP: ask user to materialize `microsoft/power-platform-skills/plugins/mobile-apps/template#main` into a new or empty folder with `degit` and run `npm install`; never overwrite existing work. |
| Unclear state or intent | New-app versus edit intent, customization, or creation progress cannot be established | Ask before selecting a workflow. Preserve the directory, plan, and history; do not default to fresh creation or resume. |

An approved `native-app-plan.md` alone is not a created-app marker. Creation
writes it before template preparation, and `assertFreshTemplate` intentionally
allows it. A plan alone also does not identify a safe resume phase: use current
caller context and saved creation progress, or ask. Do not treat an unrelated or
stale plan as approved for this request.

`/create-mobile-app` creates from a confirmed fresh starter or continues an
explicitly requested unfinished creation. It does not adopt, repair, overwrite,
or resume a completed app just because a bank or plan exists.

An already-created app is a routing boundary, not a reason to discard the
user's edit request. Do not merely suggest `/edit-app` or ask the user to repeat
the request. For a current-app feature request, execute
[app-edit-routing.md](../../shared/references/app-edit-routing.md), then invoke
`/edit-app` with the original request, absolute `working_dir`, and
`entry_choice: full-integration` only when that choice is approved. Reported
problems still route to `/debug-app`; dependency/template upgrades route to
`/check-updates`.

---

### Step 0 — Intent routing + creation-state gate

**Telemetry checkpoint: `validate_fresh_template`**

Before project reads or commands, bind the absolute `working_dir` through
[app-working-directory.md](../../shared/references/app-working-directory.md).
Apply the state-routing table above once. Classify the original request before
considering a creation resume or testing freshness; do not derive the requested
operation from the presence or absence of `memory-bank.md`.

**Existing-app changes leave this skill before resume handling.** Follow the
table's existing-app handoff, preserving the original request and root, then
return without entering Step 1 or modifying creation progress. Reported problems
and dependency/template upgrades retain their matching workflows. If intent or
customization is unclear, ask and wait; do not offer a creation resume merely
because a bank exists.

Only a confirmed **Fresh template** or explicit **Creation continuation**
enters the creation workflow below. All other table outcomes stop or hand off
without re-scaffolding, overwriting history, or running template preparation.

Gather the state evidence with one read-only command, with the run's `--begin` and this step's telemetry calls inside it:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/check-version.js"
for f in package.json app.config.js auth.config.json tamagui.config.ts; do [ -f "$f" ] || echo "MISSING $f"; done
[ -d node_modules/expo ] || echo "MISSING node_modules/expo"
for f in memory-bank.md native-app-plan.md docs/.run-plan.json .datamodel-manifest.json; do [ -e "$f" ] && echo "FOUND $f"; done
ls src/generated/services/*.ts >/dev/null 2>&1 && echo "FOUND src/generated/services"
if [ -e node_modules/.bin/pa ] || [ -e node_modules/.bin/pa.cmd ]; then echo "PA_KIND=pa"
elif [ -e node_modules/.bin/power-apps ] || [ -e node_modules/.bin/power-apps.cmd ]; then echo "PA_KIND=power-apps"
else echo "PA_KIND=none"; fi
node --version; npm --version
node -e "try { console.log('ENV=' + (require('./power.config.json').environmentId || '')) } catch { console.log('ENV=') }"
node -e "try { console.log('BUILD_ORDER=' + (require('./docs/.run-plan.json').buildOrder || 'data-model-first')) } catch { console.log('BUILD_ORDER=') }"
```

| Output | Evidence |
|---|---|
| A `check-version.js` message | Show it, then continue. |
| `MISSING` a template file | **Not template**, once new-app intent is confirmed. |
| `MISSING node_modules/expo` or `PA_KIND=none` | **Template not installed**, once new-app intent is confirmed. This skill never installs dependencies, provisions feed tokens, or rewrites registries. |
| `FOUND memory-bank.md`, `FOUND .datamodel-manifest.json`, or `FOUND src/generated/services` | Corroborates an already-created app or an initialized creation; it never selects resume by itself. |
| `FOUND native-app-plan.md` or `FOUND docs/.run-plan.json` alone | Creation's own planning artifacts, allowed on a fresh starter. |
| `BUILD_ORDER=<order>` | The build order an earlier creation recorded. Empty means no build plan exists yet. |

`PA_KIND=pa` means every Power Apps CLI command runs as `PA="npx --no-install pa"`. For `PA_KIND=power-apps`, use `npx --no-install power-apps` with the flat verbs from [cli-binary.md](${PLUGIN_ROOT}/shared/cli-binary.md): `pa app init` is `power-apps init`. `--no-install` is what stops `npx` from downloading an unrelated package of the same name. Record the result in the memory bank's `CLI Binary` row once the bank exists.

**Do not silently copy a bundled template over the user's folder.** A fresh `plugins/mobile-apps/template` template may contain placeholder `power.config.json` with an empty `environmentId`; the flow's template-preparation step removes that placeholder immediately before `pa app init`.

#### Fresh run

Require every condition in the Fresh-template row, including confirmed new-app
intent and an uncustomized starter. The template/dependency failure rows apply
only after that intent is established. An approved plan from the current
creation is allowed; template preparation stays in the chosen flow, not this
read-only entry gate. Then choose the build order.

#### Choose the build order

`--screens-first` or `--data-model-first` in `$ARGUMENTS` chooses without asking. Otherwise ask one `AskUserQuestion`:

| Header | Question | Options |
|---|---|---|
| `build order` | How should I build your app? | **Screens first (recommended)** - "Watch your screens get built and run live in the build plan's phone within minutes, on sample data. The data model, sign-in, and connections are set up afterwards while the app stays on screen." · **Data model first** - "Approve the architecture and data model first, create the tables and connections, then build the screens on real data. The app first runs at the end." |

Then read the chosen flow file and continue at its Step 1. The flow records the order in the build plan it creates, which is how a continuation finds it again.

#### Creation continuation

For an explicit request to continue this app's unfinished creation, inspect the
matching `memory-bank.md` when present, `docs/.run-plan.json` when present, the
approved creation plan, and any valid current create caller context. Establish
the unfinished creation phase and corroborate it against current app artifacts.
Do not infer the next phase from arbitrary completed entries belonging to edits,
deployment, or another workflow.

- **Missing or conflicting progress** — ask which creation phase is being
  continued or ask to restore its records, then stop. Do not guess a phase,
  restart creation, or classify the app as fresh.
- **Completed creation** — report that there is no unfinished creation to resume.
  Clarify whether the user wants an app edit or a separate new app and use the
  table's matching route.
- **Corrupt records** — report the error and ask to repair/restore them. Do not
  delete or overwrite history to make the directory pass a freshness check.
- **Verified unfinished phase** — show the phase, remaining scope, and target
  app, then obtain continuation approval unless that exact continuation already
  has current approval. Reuse only decisions approved for the same current
  scope; pending or changed decisions keep their owning approval gates.

Pre-initialization creation may have an approved plan and saved planning
progress without a memory bank. It stays on this continuation path when the
phase can be established; the plan's presence does not redirect it to editing.
For a post-initialization continuation, resume the verified phase directly; do
not rerun the fresh preparation or `pa app init` over the materialized app.

**Reopen the build plan only after continuation approval.** When
`<working_dir>/docs/create-app-plan.html` exists, reopen it. Inspect the existing
plan with the read-only
`node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' show`
command. If it reports a `failedPhase` matching the approved continuation,
reopen that phase before continuing:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id <failedPhase> --status active
```

Use only a validated phase ID from the recorded creation state. Do not skip
unresolved approval or validation gates merely because an older plan exists.

**Keep the recorded build order.** `BUILD_ORDER` names the flow this creation started in; its finished phases belong to that order, so never switch orders mid-creation.
Read that flow file and enter the verified phase at the first step its build-plan phase lists in `skillSteps` (the `phases` in `docs/.run-plan.json`).
