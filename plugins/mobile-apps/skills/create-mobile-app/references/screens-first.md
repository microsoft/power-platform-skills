# Screens first - Phase A of `/create-mobile-app`

Read this file in full when Step 0 of [`SKILL.md`](../SKILL.md) chooses the **screens first** build order.
`SKILL.md` has already routed the request, confirmed a fresh template, gathered the requirements into `.tmp/requirements.json`, and had the brief confirmed by the build-order answer; its Step 0 output (`PA_KIND` and `ENV`) feeds Step 3 here.

## Workflow

The run is **preview-first**: the user tries their app in the build plan's phone before any step that the screens do not need.

**Phase A - get the app on screen (this file, Steps 1-8)**

Startup checks, the setup question, and the build-order choice ([`SKILL.md`](../SKILL.md) Step 0) → scaffold, `pa app init`, and the preview server, then you draft the screen graph → **screen graph gate** → navigation shell → screens built in parallel, data layer written alongside → the phone goes live with the first finished screen → whole-app checks → **preview gate**.

**Phase B - make it real ([`make-it-real.md`](make-it-real.md), Steps 9-17)**

Design system (the live preview restyles itself) → **architecture gate** (native capabilities, connectors, data platform) → **data model gate** when Dataverse is selected → auth → Dataverse materialization, sample data, and the Mobile Offline Profile offer → native capabilities and connectors → connect real data → quality sweep → Metro QR and summary.

The four approval gates are named, not numbered, because their order is the point: screen graph, preview, architecture, data model.

## Phase A is a sprint

The first finished screen reaches the phone within about five minutes of the prompt, plus the time the user spends answering.
Every model turn re-reads the whole conversation, so each turn costs seconds, and each large file read makes every later turn slower.
Phase A keeps both small:

- **Read only what a step names.** Agents read their own instructions; leave `agents/*.md`, design references, samples, and Phase B to the agents and steps that use them.
- **Batch.** Run each step's commands as the single shell command it gives, and send independent tool calls in one message.
- **Delegate the screens, draft the graph.** You hold the brief already, so you draft the screen graph yourself in one write and a script renders it; one `preview-screen-builder` per screen builds in parallel while you write the data layer.
- **Ask twice at most after the build order:** the screen graph gate and the preview gate. A Power Apps CLI sign-in is the only other interruption. Repair TypeScript errors yourself, without asking how.
- **Wait on files, not notices.** Each builder writes a done file as it finishes, and the go-live command waits on the entry screen's; a background completion notice can arrive up to a minute later.
- **Trust the checks.** `check-web-preview.js` proves the app bundles, and the user looks at the phone. Leave the browser to them: no opening, screenshotting, or driving it to inspect the preview.
- **Record later.** A script fills the memory bank's facts at Step 3; Step 9.0 records the rest and writes the per-screen specs from the built screens.

## Sub-agent return status

Every `Task` return in this skill follows the plugin-wide protocol in [`AGENTS.md`](${PLUGIN_ROOT}/AGENTS.md) rule #12.
`DONE` continues after output validation.
`DONE_WITH_CONCERNS:` surfaces the concerns and holds them for Step 9.0, which appends them to `memory-bank.md` `## Concerns`.
`NEEDS_CONTEXT:` re-dispatches with the missing non-Dataverse context, capped at 2 retries.
`BLOCKED:` reports the blocker.
Unknown first lines are malformed.
Recoverable artifact or input failures return to their owning phase for repair; they never authorize skipping an applicable gate.

Step 10.0 in [`references/make-it-real.md`](make-it-real.md) adds the architecture-phase and Dataverse-specific signals on top of this protocol.

## TypeScript in Phase A

`tsc` is a phase gate, not a reflex after every edit, and Phase A runs it three times: the scaffold gate (Step 3.4), the data layer's own files (Step 6.2), and the whole app (Step 7).
When a gate fails, capture the full output once, group errors by root cause, repair them in one batch, and rerun the gate once.
Repair without asking: report what changed at the preview gate.
The phone goes live (Step 6.3) before every screen type-checks, because Metro bundles without type checks and one screen's error should not hide another's progress; the preview gate waits for Step 7 to be clean.
Do not satisfy `tsc` with a mock or TODO: sample data belongs only in a `preview` data-layer block.

## Build plan

This protocol applies after Step 0 selects fresh creation or an approved
creation continuation. Routing an existing-app request elsewhere, asking for
unclear intent, or declining creation does not create, reopen, or reset the
creation plan or change its phase status.

The run writes a plan the user can read while it happens and keep afterwards:
`<working_dir>/docs/create-app-plan.html`, rendered by
[`scripts/app-docs.js`](${PLUGIN_ROOT}/scripts/app-docs.js) in the same Fluent format the
Power Pages `/create-site` plan uses. It is the record of *why* the app looks the way it does,
so a teammate opening the repo months later can see the environment, the approved data model,
and the screen plan without re-reading a transcript.
Its phone frame is also the preview: the running app appears there and nowhere else.

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' <command>
```

| Command | Use |
|---|---|
| `init --json-file <path>` | Once, at Step 3, with `{"appName","dataPlatform","buildOrder":"screens-first"}`. Safe to re-run: a resume keeps recorded progress. The display name is user text, so it travels in the file, never as an argument. |
| `step --id <phase> --status <pending\|active\|done\|skipped\|failed> [--note "<text>"]` | At every phase boundary. Marking a phase `active` closes any previous one. |
| `set --section <name> --json '<object>'` or `--json-file <path>` | When a decision is made. Merges, so a later step can add to a section. |
| `step --id <phase> --status failed --note "<what stopped it>"` | Before surfacing any unrecoverable STOP. Best-effort like the rest: if it fails, still stop. |
| `phone --stage building\|live\|qr [--preview-url <url>]` | Moves the plan's phone through its stages: the building animation, the live web preview from Step 6.3 (`--preview-url http://localhost:<port>`), the building animation again while Step 14 connects real data, and the Metro QR at Step 16. |

**Open the plan in the user's browser as soon as `init` creates it**, with the host's file opener
or `open` / `xdg-open` / `cmd /c start ""` on the quoted path. A plan the user never sees is a plan
that only ever existed as terminal text, and terminal text scrolls away during a long run. Opening
it once is enough: the page reloads itself whenever the plan changes.

**Phases** (`--id`), in run order: `requirements`, `scaffold`, `screen-plan`, `screens`, `preview`,
`design`, `architecture`, `data-model`, `auth`, `dataverse`, `capabilities`, `wiring`, `run`.
Any other id is rejected by name.

**Write each gated section into the plan *before* asking for approval**, with `--state proposed`,
then flip it to `--state approved` once the user says yes. The plan is already open in their
browser, so a rendered screen graph or ER diagram is what they answer the gate against.

**Raise every gate in the plan as you present it, and take it down as soon as it is answered**,
in every revision loop and inline fallback too. A `--note` on an `active` step raises the
waiting-for-input banner, so the user can tell the run is waiting on them rather than still
working. Pass a fresh `--note` when you close a gate, or the old one is cleared rather than kept.

| Gate | Step | `--id` | Section written first, `--state proposed` | Once approved |
|---|---|---|---|---|
| Screen graph | 4.2 | `screen-plan` | `screens` | `screen-plan` done, note "Screen graph approved - <n> screens" |
| Preview | 8.1 | `preview` | none; the live app in the phone frame is what the user reviews | `preview` done |

Phase B's architecture and data model gates follow the same pattern; [`references/make-it-real.md`](make-it-real.md#build-plan-in-phase-b) lists them.

**Record each section as soon as it is known.** Phase A writes three:

| Section | Written at | Contents |
|---|---|---|
| `requirements` | Step 3 | `appName`, `slug`, `platforms`, `aesthetic`, `industry`, `brief`, `features[]` |
| `environment` | Step 3.3 | `environmentId`; Step 9.0 adds `displayName`, `environmentUrl`, and `tenantId`, and Step 10 adds `publisherPrefix` |
| `screens` | Screen graph gate (Step 4.2) | `navigation`, `list[]` with `name`, `route`, `file`, `presentation`, `purpose`, `data`, `capabilities[]` |

**Use `--json-file` for anything the user wrote.** Size is not the test — an app called
`Dave's Rounds` is enough. A value interpolated into a single-quoted shell argument ends that
quoting at the first apostrophe, which at best corrupts the JSON and at worst leaves whatever
follows to the shell. Write such values to a file with the `Write` tool and pass it by path.

**Every one of these calls is best-effort.** If `app-docs.js` fails, say nothing and carry on:
the documentation must never gate, retry, or fail a build.

**Mark the active creation phase `failed` before stopping on a creation error.**
Step 0 routing exits leave existing creation history untouched. Once creation is
underway, a STOP is a terminal state the user has to act on, and the plan is
probably still open in their browser. Without this the last
phase stays `active`, so the page keeps reloading and keeps reporting work in progress on a run
that ended. A failed phase settles the page, so the final thing it shows names what stopped.

**No argument switches this protocol off.** `--no-design` skips the design system, and no flag
skips the build plan. The plan is how an abandoned or failed run explains itself, so it is written
on every creation path after Step 0's routing decision.

## Continuing a creation

[`SKILL.md`](../SKILL.md) Step 0 verifies the unfinished phase, gets the user's approval, and reopens the plan.
Continue with the values in the memory bank, `.tmp/requirements.json`, and `power.config.json`:
`requirements` → Step 2, `scaffold` → Step 3, `screen-plan` → Step 4, `screens` → Step 5 (its scripts skip finished work), `preview` → Step 7, and anything later → [`make-it-real.md`](make-it-real.md).

## Phase A — Get the app on screen

### Step 1 — Prerequisites and environment

**Telemetry checkpoint: `validate_development_toolchain`**

Step 0 has already checked Node, and the setup question settled the environment in `.tmp/requirements.json`, so send this checkpoint's command in the same message as Step 2's writes.

npm feed sign-in and Power Apps CLI sign-in are separate accounts; a Power Apps CLI browser sign-in later in the run is expected and unrelated to the npm feed.
Phase A does not use Azure CLI: Step 9.0 resolves the environment's Dataverse URL and tenant, after the preview.
Do not probe Xcode, Java, Android Studio, or CocoaPods: native builds are the user's own step, outside this skill.

### Step 2 — The plan files

The requirements and the brief come from [`SKILL.md`](../SKILL.md) Step 0, and the user confirmed the brief by choosing this order; ask nothing here.
The screen graph gate is where the user reviews what gets built.

Set tentative defaults:

- `<visual_companion> = yes` — governs static HTML previews: `/preview-screens` wherever it runs, and a later `/edit-app` re-plan. **A create run opens exactly one browser surface, whatever this is set to:** the build plan at Step 3. The live web preview at Step 6.3 runs inside the plan's phone frame instead of a tab of its own. Every opener in `/design-system` and its style picker is gated on `CODE_APPS_NATIVE_ORCHESTRATING=1`, which this skill passes, and Step 9 tells `/design-system` to skip its static screen mockups because the live preview supersedes them. `/design-system` may change the flag to `no`; persist the final value to memory-bank for future runs.
- `<design_vibe_opt_in> = deferred` — Step 9 sets the real value. While `deferred`, nothing asks for a direction: the plan keeps a placeholder `## Design Direction: <deferred — set by /design-system>` block, and screens use the look's defaults.

**`--no-design` escape hatch.** For headless / token-constrained runs, set `--no-design` in `$ARGUMENTS`. It forces `<visual_companion> = no`, which Step 3.4 records in the memory bank, and short-circuits Step 9 to a no-op (the preview keeps the template's default theme, and screens keep the look's defaults).

Then write two files with the `Write` tool, in one message. The app name came from the user, so it does not go through a shell argument:

- `<working_dir>/.tmp/plan-init.json`: `{"appName","dataPlatform":"unknown","buildOrder":"screens-first"}`. The build order selects this flow's phases in the plan, and a continued run reads it back.
- `<working_dir>/native-app-plan.md`, the plan skeleton in Step 4.1.

### Step 3 — Scaffold the app

Send one message with three tool calls: the command below, a read of [`references/screen-graph.md`](screen-graph.md), which Step 4 follows, and a read of [`preview-data-layer.md`](${PLUGIN_ROOT}/shared/references/preview-data-layer.md), which Step 6.2 follows.

**Print before starting:**
> "→ [Step 3/17] Setting up the app and planning your screens at the same time (~1 minute)."

Run it with the telemetry calls for Steps 3.1-3.4 around their parts:

```bash
DOCS="${PLUGIN_ROOT}/scripts/app-docs.js"
# The requirements were gathered before the plan existed, so it opens with the brief already recorded.
node "$DOCS" --working-dir '<working_dir>' init --json-file '<working_dir>/.tmp/plan-init.json'
node "$DOCS" --working-dir '<working_dir>' set --section requirements --json-file '<working_dir>/.tmp/requirements.json'
node "$DOCS" --working-dir '<working_dir>' step --id requirements --status done --note "Brief ready"
node "$DOCS" --working-dir '<working_dir>' step --id scaffold --status active --note "Setting up the app"
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
open docs/create-app-plan.html   # xdg-open on Linux; cmd /c start "" on Windows
PA="npx --no-install pa"   # Step 0's PA_KIND
# User-authored values come from the file as data; "$NAME" is never re-parsed by the shell.
req() { node -e "process.stdout.write(String(require('./.tmp/requirements.json')[process.argv[1]] ?? ''))" "$1"; }
NAME=$(req appName); SLUG=$(req slug); ENV_ID=$(req environmentId)

# 3.2 Prepare the template
node "${PLUGIN_ROOT}/scripts/prepare-mobile-template.js" --working-dir . --display-name "$NAME" --slug "$SLUG" --screens-first > .tmp/prepare.json || exit 34

# 3.3 Initialize
$PA app init -t MobileApp --display-name "$NAME" --environment-id "$ENV_ID" --non-interactive || exit 35
node -e "const c=require('./power.config.json'); process.exit(c.environmentId===process.argv[1] && c.appDisplayName===process.argv[2] ? 0 : 1)" "$ENV_ID" "$NAME" || exit 36
node -e "process.stdout.write(JSON.stringify({environmentId: require('./power.config.json').environmentId}))" > .tmp/environment.json
node "$DOCS" --working-dir . set --section environment --json-file .tmp/environment.json

# 3.4 Scaffold gate, schema map, memory bank
npx --no-install tsc --noEmit || exit 37
npm run generate-schemas || exit 38
node "${PLUGIN_ROOT}/scripts/seed-memory-bank.js" --working-dir . --requirements .tmp/requirements.json --environment .tmp/environment.json --cli-binary pa --visual-companion '<visual_companion>' || echo "WARN memory bank not seeded"
node "$DOCS" --working-dir . step --id scaffold --status done
node "${PLUGIN_ROOT}/scripts/find-free-port.js" --start 19006
```

The command is done when it exits 0 and prints a free port.
On a non-zero exit, handle the code below, then rerun from the failed part; never rerun 3.3 once `power.config.json` holds an environment.

| Exit | Meaning | Action |
|---|---|---|
| 34 | Preparation refused the folder | Report its exact error and STOP. [`references/template-preparation.md`](template-preparation.md) explains every check; never fall back to rewriting files by hand. |
| 35 | `init` failed | `Environment '<id>' not found`: ask for the environment ID again, from the maker portal URL segment `/environments/<ID>/`, write it to `.tmp/requirements.json`, and rerun from 3.2. Sign-in or tenant errors follow the `$PA` failure handling in shared-instructions `## Command Failure Handling`, which asks before opening a browser sign-in. Otherwise report the exact error and STOP. |
| 36 | `power.config.json` does not match | STOP and report both values. |
| 37 | The scaffold does not type-check | Batch-fix the template-level cause per `references/template-preparation.md`, keeping its `@ts-ignore` generation boundaries, and rerun from 3.4. |
| 38 | Schema generation failed | Report the exact error and STOP. |

#### 3.1 — Confirm the environment

**Telemetry checkpoint: `select_app_environment`**

The setup question picked the environment; `pa app init` (3.3) proves it exists and that the Power Apps CLI can reach it, with its own sign-in.
Nothing in Phase A needs the environment's Dataverse URL or tenant, so Step 9.0 resolves them with Azure CLI, after the preview.
There is no app-name collision check: `pa app list` returns only code apps, so it cannot see a mobile app of the same name, and `init` creates nothing in the environment.

#### 3.2 — Prepare the template

**Telemetry checkpoint: `prepare_template_files`**

`prepare-mobile-template.js` owns every change to the template before `init`: identity, the web-preview output override (Step 3.5), shared helpers including `src/hooks/data/core.ts`, the root provider contract, and removing an empty placeholder `power.config.json`.
`.tmp/prepare.json` keeps its `writtenFiles` for Step 7's changed-file gate. Nothing writes under `src/generated/`, which only Power Apps generation commands own.

#### 3.3 — Initialize

**Telemetry checkpoint: `initialize_power_apps_project`**

`pa app init` writes `power.config.json`, which the web preview needs: without an `environmentId`, the native host shows "Environment ID is missing" instead of the app.
The file is CLI-generated: verify it, never hand-edit it, and leave it out of the changed-file gate.

#### 3.4 — Scaffold gate

**Telemetry checkpoint: `validate_scaffold_typescript`**

A clean `tsc` here proves preparation and `init` left a buildable app.
`generate-schemas` writes the connector schema map the root layout imports; Metro cannot bundle the app without it.
`seed-memory-bank.js` fills the bank's fact rows it knows now and records `<visual_companion>` as the `visual_companion:` line `/preview-screens` reads; a seeding warning does not stop the run, and Step 9.0 seeds it again with the resolved environment, keeping the creation date, the creating plugin version, and the recorded preference.

#### 3.5 — Start the preview server

As soon as the command prints the port, send one message with three tool calls: start the template's dev server as a long-running process, in a background terminal held only for its lifetime (do not persist or depend on the terminal ID); warm its bundle; and write Step 4's screen graph:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
POWER_APPS_WEB_PREVIEW=1 npm run dev -- --port <port> < /dev/null
```

```bash
node "${PLUGIN_ROOT}/scripts/check-web-preview.js" --url "http://localhost:<port>"
```

- `npm run dev` is the template's own development command, the one the run ends on. Its `predev` regenerates the connector schema map, and `power-apps-dev` starts one Metro server for both targets: the web app at `http://localhost:<port>`, which the build plan's phone frame shows, and the native app at this machine's LAN address, which Power Apps Mobile Preview opens from the QR code at the preview gate. The same server runs to the end of the run, so every edit hot-reloads into the plan and onto a phone, and connecting real data later switches the app in place instead of restarting anything.
- Before Metro starts it prints `LAN development server: http://<lan-ip>:<port>/`. Keep that address: it is the `<lan-url>` the preview gate turns into a QR code. Like any `npm run dev`, the server answers on the local network; the build plan frames only its loopback address.
- No `--web`: Metro serves the web app on this port either way, and in Expo SDK 55 the flag only adds opening it in a new browser tab. The preview runs in the build plan's phone frame, so the plan stays the one page the user watches; do not open the preview URL yourself.
- Input from `/dev/null` runs Expo non-interactively with file watching on, so every later edit hot-reloads into the preview. Leave `CI` unset: CI mode turns file watching off.
- `POWER_APPS_WEB_PREVIEW=1` switches the app to client-rendered web output for this server only (Step 3.2 added the override to `app.config.js`). The host default server-renders every page request in development, and the dev server keeps about 30 MB per render; with the build plan's phone frame reloading when the plan changes, that exhausts the heap over a long run. If `.tmp/prepare.json` reports `webPreviewOutput: unsupported`, the preview still works but grows in memory: restart it if it stops answering.
- If it exits with `Expo port <port> is already in use` or `EADDRINUSE`, run `find-free-port.js` again and restart once.
- If it exits with `Could not determine a LAN address`, the machine has no local network to offer a phone. Restart it once with `--localhost` after the port (`npm run dev -- --port <port> --localhost`): the web preview works the same, and the phone's QR code waits for the dev server step at the end of the run.

`check-web-preview.js` waits for the server, then compiles the page and its whole route graph, so the first real bundle at Step 6.3 is incremental.
`ok` means every route bundled. `bundle-error` names the module and cause; `unreachable` means the server never answered, so read Expo's output and restart.
The phone keeps its building animation until Step 6.3.

### Step 4 — Plan the screens

**Telemetry checkpoint: `plan_app_screens`**

Screens come first because they are what the preview shows, and the data model is later derived from what they show.

#### 4.1 — The plan skeleton

Written at Step 2, before the scaffold.
`<working_dir>/native-app-plan.md` holds these headings, filled with only what is known:

- `# <App Name> — Native App Plan`
- `## Overview`: app name, target users, iOS and Android, the look, and the environment ID.
- `## App Requirements`: the brief, verbatim.
- `## Design`: `Look: <look>`, then `## Design Direction: <deferred — set by /design-system>`. Builders fall back to industry defaults until Step 9.
- `## Data Model`, `## Native Capabilities`, and `## Connectors`: each the single line `Pending - derived from the approved screens at the architecture gate (Step 10).`
- `## Screens`: empty.
- `## Approvals`: `Screen graph approved`, `Preview approved`, `Architecture approved`, and `Data model approved`, each unchecked.

#### 4.2 — Screen graph and the screen graph gate

Draft the graph yourself, in the Step 3.5 message: you already hold the prompt, the setup answers, and the brief, so one write is faster than briefing an agent to rediscover them.
Follow [`references/screen-graph.md`](screen-graph.md), which Step 3 read, and write `<working_dir>/.tmp/screens.json` with the `Write` tool.
The graph describes data only through its Data Contract, never as tables, columns, connectors, or services: none exist yet.

**Present the screen graph gate** once the Step 3 command and the write have finished:

```bash
node "${PLUGIN_ROOT}/scripts/render-screen-graph.js" --working-dir '<working_dir>' && {
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' set --section screens --json-file '<working_dir>/.tmp/screens.json' --state proposed
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screen-plan --status active --note "Screen graph gate - awaiting your approval"
}
```

`render-screen-graph.js` checks routes, params, and the Data Contract, then writes the plan's `## Screens` section from the JSON.
On `status: "blocked"`, fix every problem it lists in one edit of `screens.json` and rerun the block; address any `warnings`.

Print the navigation pattern, each screen with its purpose, and the Data Contract (each entity with its fields, plus device actions), then ask with `AskUserQuestion`:

> **Question header:** `Screen graph`
>
> **Question body:** "These are the screens I will build and run in the phone in your build plan, and the data each one shows (sample data for now). Approve, or tell me what to change: add or remove screens, rename routes, change what a screen shows."
>
> **Options:** `Approve and build the preview` · `Change something` (free text)

On a change request, edit `screens.json` with the user's words, rerun the block above, and present the gate again.
On approval, go straight to Step 5: its message also ticks `Screen graph approved` in `## Approvals` with the timestamp.

The approval covers the screens and their Data Contract.
Nothing outside `<working_dir>` changes until the architecture gate.

### Step 5 — Write the navigation shell

**Telemetry checkpoint: `wire_app_navigation`**

Layouts and placeholders follow mechanically from the approved graph, so a script writes them.
Run this in the same message as Step 6.1's spawns: it finishes in a second, long before any builder writes a file.

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' set --section screens --json-file '<working_dir>/.tmp/screens.json' --state approved
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screen-plan --status done --note "Screen graph approved - <n> screens"
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screens --status active --note "Building <n> screens"
node "${PLUGIN_ROOT}/scripts/scaffold-preview-screens.js" --working-dir '<working_dir>' --screens-file '<working_dir>/.tmp/screens.json'
```

It writes the outer Tabs or Drawer layout from the template's protected layout, one inner `Stack` per folder with each child's presentation, and a placeholder at every planned screen's **File**, leaving `template (keep)` routes alone.
It prints one line of JSON:

- `status: "ok"`: keep `writtenFiles` for Step 7 and `entry`, the screen the preview opens on, for Step 6.
  Address any `warnings` it names.
- `status: "blocked"`: `reason` names what Expo Router cannot serve (a folder without `index.tsx`, a duplicate route, a missing `home.tsx`). Fix `screens.json`, rerun Step 4.2's block, and present the screen graph gate again.

Rerunning it after a graph change rewrites only its own files: a finished screen is never overwritten.

### Step 6 — Build the screens

**Telemetry checkpoint: `build_and_validate_screens`**

One `preview-screen-builder` per planned screen, all at once, with the entry screen first.
It reads only what one screen needs and builds a correct screen rather than a polished one; Phase B's Step 9.3 brings every screen to `screen-builder`'s full checklist once the design system exists.
While they build, you write the data layer (6.2); the phone goes live as soon as the entry screen and the data layer are both ready (6.3).

#### 6.1 — Spawn the builders

**Print before starting:**
> "→ [Step 6/17] Building <N> screens in parallel, <entry screen> first. Each one appears in the phone in your build plan as soon as it is ready."

Spawn one `mobile-app:preview-screen-builder` per screen the shell gave a placeholder, in the Step 5 message, in the background (`run_in_background: true` in Claude Code, `mode: "background"` in GitHub Copilot CLI), at most 5 at once with `entry` in the first group; start the next as a slot frees.
In a host whose `Task` only runs in the foreground, write the data layer (6.2) first, then spawn the builders.

```
Spawn agent: mobile-app:preview-screen-builder

Prompt:
  working_dir: <working_dir>
  screen_name: <name>
  route: <route>
  target_file: <working_dir>/<file from screens.json>
  screens_file: <working_dir>/.tmp/screens.json
  done_file: <working_dir>/.tmp/built/<screen name, kebab-case>.done
  plugin_root: ${PLUGIN_ROOT}

  Build this screen per preview-screen-builder.md. Return per AGENTS.md rule #12.
```

Each spawn answers that you will be notified when it completes. Keep working in this turn: write the data layer (6.2), then run 6.3's command, which waits on the entry screen's `done_file`.
A completion notice can arrive up to a minute after a builder finishes; the done file lands the moment it does.

**`target_file` is the screen's `file`** prefixed with `<working_dir>/`, nested path included (`app/(app)/inspections/[id]/index.tsx`); a flat `app/(app)/<screen-name>.tsx` would add a phantom tab.

If `Task` cannot spawn `mobile-app:preview-screen-builder` (`Agent type … not found`, tool unavailable, or a nested-Task failure), print once: "→ Parallel screen builders are unavailable in this host - building the screens one at a time." Then write the data layer and build each screen yourself, entry screen first, following `agents/preview-screen-builder.md`; Step 6.3 still goes live after the first one.
Builders spawn no agents of their own; a builder that needs help returns `NEEDS_CONTEXT:`.

#### 6.2 — Write the data layer while they build

**Telemetry checkpoint: `generate_preview_data_layer`**

Write `src/hooks/data/` from the contract in `screens.json`, which you wrote and still hold, in the message right after Step 5's, exactly as [`preview-data-layer.md`](${PLUGIN_ROOT}/shared/references/preview-data-layer.md) (read at Step 3) specifies.
Its entity module is the complete pattern, so `core.ts` and the hook sources stay closed, and the builders need nothing from you while they run: the first screen is waiting on this write.

- one entity module per contract entity, with its domain types, its source in a `DATA SOURCE START - preview` block, and its hooks;
- `device.ts` with one `DEVICE ACTION START - preview <name>` block per contract device action, when the contract lists any;
- `fixtures/<entity>.ts` with the contract's sample record count, using `daysFromToday` for dates;
- the `index.ts` barrel.

`src/hooks/data/core.ts` came from template preparation; leave it unchanged.
Hook, type, and device-action names follow the contract exactly, because the builders import them by those names.

Then check your own files:

```bash
cd -- '<working_dir>' || exit 1
npx --no-install tsc --noEmit
node "${PLUGIN_ROOT}/scripts/check-data-layer.js" --project-root '<working_dir>'
```

The data layer is done when `tsc` reports no error under `src/hooks/data/` and the checker lists every source and device action as `preview`.
Errors in screen files belong to Step 7: builders may still be writing.
Once the data layer is done, run 6.3's command at once.

#### 6.3 — Show the first finished screen

**Telemetry checkpoint: `launch_web_preview`**

Wait for the entry screen's builder, then put the app in the phone, in one command:

```bash
cd -- '<working_dir>' || exit 1
for i in $(seq 1 150); do [ -f '.tmp/built/<entry>.done' ] && break; sleep 2; done
cat '.tmp/built/<entry>.done' || { echo "the entry screen is still building"; exit 1; }
node "${PLUGIN_ROOT}/scripts/check-web-preview.js" --url "http://localhost:<port>" || exit 1
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' phone --stage live --preview-url "http://localhost:<port>"
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screens --status active --note "<entry screen> is ready - building the rest"
```

`<entry>` is the entry screen's kebab-case name, as in its `done_file`; the file holds the builder's status line.
On `bundle-error`, fix the module it names and rerun the check before going live; on `unreachable`, read Expo's output and restart it per Step 3.5.
Then print:

> "✓ <entry screen> is running in the phone in your build plan, on sample data. The other screens replace their 'Building this screen' placeholders as they finish."

If the done file holds `NEEDS_CONTEXT:` or `BLOCKED:`, go live with the next screen whose done file lands; the entry route shows its placeholder meanwhile.

#### 6.4 — Collect the rest

Collect the other builders as their completion notices arrive. As each returns, print one line and keep the plan's count honest:

```
  ✓ [3/5] Inspection detail — DONE
  ✓ [4/5] Profile — DONE_WITH_CONCERNS (1 contract gap)
```

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screens --status active --note "<k> of <N> screens built"
```

The phone hot-reloads each finished screen; nothing else needs doing.
`NEEDS_CONTEXT:` re-spawns that builder with the missing context appended (2 retries, then `BLOCKED`), printed as `↻ [k/N] <name> — retrying (missing: <missing>)`.
`BLOCKED:` prints `✗ [k/N] <name> — BLOCKED (<reason>)` and asks whether to fix and retry, keep the placeholder and continue, or stop.
Hold every `DONE_WITH_CONCERNS:` for the preview gate.
Step 6 is done when every builder has returned.

### Step 7 — Check the whole app

Every screen now exists, so check them together in one command:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
npx --no-install tsc --noEmit
node "${PLUGIN_ROOT}/scripts/check-routes.js"
node "${PLUGIN_ROOT}/scripts/check-data-layer.js" --project-root '<working_dir>'
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" --project-root '<working_dir>' --file '<each file Phase A wrote>'
node "${PLUGIN_ROOT}/scripts/check-web-preview.js" --url "http://localhost:<port>"
```

Pass `validate-mobile-files.js` one exact `--file` per file this run wrote: `.tmp/prepare.json`'s `writtenFiles`, `memory-bank.md`, `native-app-plan.md`, Step 5's `writtenFiles`, every file under `src/hooks/data/`, and every screen file. Build the list from those records; never rebuild it from `git status` or a directory scan, which would pull in files the run did not write. `power.config.json` and `src/generated/` are CLI-generated and stay out, and preparation's `removedPowerConfig` and `removedLegacyFiles` are removals, not `--file` targets.
`check-routes.js` catches duplicate routes and sender/destination parameter drift; `check-data-layer.js` catches a screen importing a generated service, native wrapper, or fixture directly.

When anything fails, repair the whole batch yourself, editing the screen files directly, and rerun the command once: a builder that has returned is finished.
Re-spawn a screen's builder, with the consolidated findings appended, only when the fix needs that screen redesigned rather than corrected.
Step 7 is done when every check is clean:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screens --status done --note "<N> screens built"
```

### Step 8 — The preview gate

#### 8.1 — The preview gate

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id preview --status active --note "Preview gate - waiting for you to try the app"
```

Put the app on the user's phone too. The dev server from Step 3.5 already serves it there, so this only draws the code; skip it when Step 3.5 fell back to `--localhost`:

```bash
cd -- '<working_dir>' || exit 1
METRO_QR='<working_dir>/.expo/metro-qr.png'
npx --no-install qrcode -o "$METRO_QR" "<lan-url>" \
  && node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' phone --qr-image "$METRO_QR" --qr-url "<lan-url>"
```

Without `--stage` the phone frame keeps the browser preview, and the plan draws the code under it.
The template pins `qrcode`, so this never downloads; if it fails, continue without the code and never retry with `--yes` or a bare `npx qrcode`.
Show the PNG in chat the way the dev server step does: base64-encode it with Node and embed it as a `data:image/png;base64,` markdown image. Where the host cannot render that, point at the plan instead of opening the file.

Print:

> "✓ Your app is running in the build plan's phone frame (`docs/create-app-plan.html`), served from `http://localhost:<port>`.
> It shows sample data and the default theme; your design system and real data come next.
> Try it right in the phone: move between screens, search, open a record, fill in a form.
> 📱 To try it on your phone, scan the QR code (above, and under the plan's phone) with Power Apps Mobile Preview on the same network. Confirmation dialogs and the date picker are native controls, so the browser shows a stand-in and your phone shows the real thing.
> Device features such as the camera return sample results on both until they are wired after you approve the architecture; then they work on your phone as it reloads."

Leave out the 📱 line when no QR code was drawn.

Under it, list the builders' concerns and any Step 7 repairs, one line each.
Then ask with `AskUserQuestion`:

> **Question header:** `Preview`
>
> **Question body:** "Does the app look and work the way you want?"
>
> **Options:** `Looks good - continue` · `Change screens` (free text)

**On `Change screens`,** classify each requested change and route it to its owner:

| The change | Route |
|---|---|
| Layout, copy, field order, or a new action on data the Data Contract already has | Update that screen's `layout` in `screens.json`, then rebuild only that screen with `preview-screen-builder` (Step 6.1 prompt, plus the user's words). |
| A new field, operation, query, or device action on an existing entity | Add it to the contract in `screens.json`, rerun `render-screen-graph.js`, update the data layer (Step 6.2 pattern), then rebuild the screens that use it. |
| A new, removed, or renamed screen or route, a new entity, or a navigation change | Edit `screens.json` with the user's words, rerun Step 4.2's block, and present the screen graph gate again, then Steps 5 and 6 for the changed screens only. |

After the change, run Step 7 again, then ask the preview question again.
The phone hot-reloads; if it shows a stale screen, ask the user to reload the build plan.
Repeat until the user picks `Looks good - continue`.

**On `Looks good - continue`,** tick `Preview approved` in `## Approvals` with the timestamp and close the phase:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id preview --status done --note "Preview approved"
```

Leave the server running.
The design system in Step 9 restyles this same preview, on the plan and on a scanned phone, and the architecture and data model gates are easier to answer with the app in view.

**Continue with Phase B:** read [`references/make-it-real.md`](make-it-real.md) in full now, then start at its Step 9.0.
