# Make it real - Phase B of `/create-mobile-app`, screens first

Read this file in full at Step 9 of the **screens first** build order, once the user has approved the preview.
[`screens-first.md`](screens-first.md) holds Phase A and the rules both phases share: [sub-agent return status](screens-first.md#sub-agent-return-status), the [build plan](screens-first.md#build-plan) commands and Phase A gates.
[`SKILL.md`](../SKILL.md) holds the child-skill handoff context and the fresh-template states.

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - Phase B follows it too. You read it at the start of the run; read it again now only if it is no longer in your context.
Phase A needed only three of its sections, because it changed nothing outside the working directory except initializing the app.
Phase B creates Dataverse tables, app registrations, connections, and packages, so every guardrail applies from here on.

Phase B restyles and rewires the screens the user approved at the preview gate.
When a Phase B decision changes what a screen shows (a declined capability, a field the data model cannot hold), rebuild that screen with `screen-builder` and let the preview reload before continuing.

## TypeScript gates in Phase B

`tsc` stays a phase gate, not a reflex after every edit.
Phase B adds three gates to Phase A's:

- **Dataverse/generated-services gate:** immediately after Step 12 returns and generated services/models are refreshed.
- **Wiring gate:** Step 14.3 after the data layer is rewired to real sources.
- **Final gate:** before Step 16 starts the dev server.

When a gate fails, capture the full `tsc --noEmit` output once, group errors by root cause (generated model names, service option shapes, invalid UI props, typed percentage values, create/update payload typing, missing imports), repair them in one batch, and rerun the same gate once.
Continue only when it is clean.
Do not hide an approved capability's failure behind a mock or TODO to satisfy `tsc`: sample data is legitimate only in a `preview` data-layer block, and Step 14 reports every one that remains.

## Build plan in Phase B

[screens-first.md](screens-first.md#build-plan) covers the commands, banners, and Phase A gates.
Phase B adds two gates:

| Gate | Step | `--id` | Section written first, `--state proposed` | Once approved |
|---|---|---|---|---|
| Architecture | 10 | `architecture` | `architecture` | `data-model`, note "Designing the data model" (`connector-only`: nothing; Step 10.9 closes the phase) |
| Data model, `required` only | 10 | `data-model` | `dataModel`, and `offline` when the plan has one | nothing; Step 10.9 closes the phase |

The data model gate's calls are the pattern each gate follows:

```bash
DOCS="${PLUGIN_ROOT}/scripts/app-docs.js"
# 1. propose - the tab shows "Proposed - review this, then answer the prompt in your terminal"
node "$DOCS" --working-dir '<working_dir>' set --section dataModel --json-file <tmp>/data-model.json --state proposed
node "$DOCS" --working-dir '<working_dir>' step --id data-model --status active --note "Data model gate - awaiting your approval"
# 2. point the user at that tab, then ask the gate question
# 3. on approval
node "$DOCS" --working-dir '<working_dir>' set --section dataModel --json-file <tmp>/data-model.json --state approved
node "$DOCS" --working-dir '<working_dir>' step --id data-model --status done --note "Data model gate - approved"
```

Pass a fresh `--note` when you close a gate. A note belongs to the status it was written with, so
changing status without one clears it rather than leaving "awaiting your approval" under a step the
user has already approved.

If the user asks for changes, rewrite the section with `--state proposed` again and re-ask. The
page reloads itself, so they see the revision without touching anything.

**Record each other section as soon as it is known** — not in a batch at the end, or an abort
leaves a plan that explains nothing:

| Section | Written at | Contents |
|---|---|---|
| `design` | Step 9 | `direction`, `headingFont`, `bodyFont`, `darkMode`, `palette[]` (`name`, `value` as `#rrggbb`). Use the real family names from [`typography-and-tone.md`](${PLUGIN_ROOT}/shared/references/typography-and-tone.md) (`Inter`, `JetBrains Mono`, …) — the plan renders each name in the typeface it names, so a label that is not a real family shows as the fallback. |
| `architecture` | Architecture gate (Step 10) | `dataPlatform`, `nativeCapabilities[]` and `connectors[]` as `{ name, reason }` — a bare name cannot be approved or rejected, the reason is the decision |
| `dataModel` | Data model gate (Step 10) | `connectorOnly` when there are no tables; otherwise `tables[]` with `logicalName`, `displayName`, `status` (`new`/`reused`/`modified`, or the plan's `create`/`reuse`/`extend`), `purpose` (what it holds), **`reason` (why it is created, reused or extended)**, `columns[]` (`logicalName`, `displayName`, `type`, `key: PK\|FK`), `relationships[]` (`relatedTable`, `name`, `cardinality`) |
| `offline` | Data model gate (Step 10) | `enabled`, `mode`, `tables[]`, `rationale` |
| `auth` | Step 11 | `status` |
| `trust` | Step 13, after capabilities and connectors are wired | `permissions[]` (`name`, `status` as one of the acquisition patterns below, **`detail`: when access is requested and why**), `handles[]`, `notCollected[]`, `battery[]` (`name`, `detail`) |

The ER diagram is **built from `dataModel.tables`**, so populate the structured fields rather
than only a Mermaid string — that is what makes the diagram, the column tables, and the
new/reused/extended colouring agree with each other.

**Every reuse, create and extend decision needs a `reason`.** "Reusing `account`" is not
reviewable; "Reusing `account` — sites are already maintained there by the service desk, and a
second Site table would drift" is. Write the reason the architect actually used, including what
was rejected, since that is what the user is being asked to approve at the data model gate.

## Inputs the architecture gate needs

Step 10 uses these. Both run there, not earlier: Phase A never needs a Dataverse fact.

### Dataverse planning mode

Before spawning the planner at Step 10, read the provisional Dataverse planning mode from `dataPlanningMode` in `.tmp/requirements.json`.
[`SKILL.md`](../SKILL.md) Step 0 classified it while gathering the requirements, applying
[`shared/references/connectivity-intent-ownership.md`](${PLUGIN_ROOT}/shared/references/connectivity-intent-ownership.md),
and it is always `required` here: a `connector-only` brief builds data model first.
The approved Data Contract does not change the recommendation; only the user's answer at the architecture gate does.

Store it as `<recommended_dataverse_planning_mode>`. The first
user-visible data-platform choice happens in the planner's architecture gate
after native capabilities and connectors have been presented. Dataverse
discovery does not run before that gate.

Also stash `<exact_target_facts_required> = yes` when planning depends on any
existing/standard/managed table, reuse or extension decision, proposed-name
collision decision, relationship target, computed column, or target
customizability fact. Otherwise set it to `no`. This flag controls only safe
planning degradation; it never relaxes `/add-dataverse` reconciliation.

### Step 1.7 — Detect publisher prefix

**Shared step:** read [`publisher-prefix.md`](publisher-prefix.md) and follow it in full.

## Phase B — Make it real

### Step 9.0 — Record the preview

Phase A kept the environment details, the memory bank, and the per-screen specs out of the preview's way; record them now.

Resolve the environment first. Phase B is where Azure CLI tokens are first needed:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
ENV_ID=$(node -e "process.stdout.write(require('./power.config.json').environmentId || '')")
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ENV_ID" > .resolved-environment.json || exit 1
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir . set --section environment --json-file .resolved-environment.json
node "${PLUGIN_ROOT}/scripts/seed-memory-bank.js" --working-dir . --requirements .tmp/requirements.json --environment .resolved-environment.json --cli-binary pa --visual-companion '<visual_companion>'
```

`.resolved-environment.json` holds the Dataverse URL and tenant that Steps 10-12 use.
On failure, read the error: with no Azure CLI sign-in or no token for the environment's tenant, ask the user to run `az login --tenant <tenant>` (the tenant from the maker portal's environment details) in the foreground, then rerun; for any other error, report it and STOP.

Then, in one message:

1. Append to `memory-bank.md`: the screens as built under `## Screens (live inventory)` (route, archetype, `screen-builder`), every concern held since Step 0 under `## Concerns` (append-only), any TypeScript repairs Step 7 made, and `Preview approved <ISO timestamp>` under `## Build history`.
2. Spawn the specs phase below, in the background where the host allows. The screens already exist at their **File** paths, so each spec records the screen as built: it is what Step 10's architects, Step 14 rebuilds, and a later `/edit-app` read. Handle its return before Step 10's planner spawn; it never changes a screen file.
3. Run the shared changed-file gate on `memory-bank.md`.

```
Spawn agent: mobile-app:screen-planner

Prompt:
  phase: specs
  data_mode: preview
  built_screens: true
  plan_path: <working_dir>/native-app-plan.md
  skip_preview: true

  The screen graph, shared conventions, and Data Contract are locked in plan_path's ## Screens
  section. Treat them as immutable; a missing requirement returns
  NEEDS_CONTEXT: graph missing <thing>. Replace only the specs-owned subsections in plan_path
  (screen-planner Step 5). Every screen is already built at its **File**: read it and specify
  what it does. Express every **Data** field as @/hooks/data hooks and device actions from the
  Data Contract.

  Requirements brief: <requirements_brief>
  Design: <the ## Design section, verbatim>
  Connectivity intent policy: follow `${PLUGIN_ROOT}/shared/references/connectivity-intent-ownership.md`
  Working directory: <absolute path of <working_dir>>
  Plugin root: ${PLUGIN_ROOT}

  Apply the canonical JavaScript dependency workflow; research read-only and do not install.
  Return per AGENTS.md rule #12.
```

The specs have no gate of their own: the user already reviewed these screens working, at the preview gate.
On `NEEDS_CONTEXT: graph missing <thing>`, leave the specs uncommitted, add the missing items to `.tmp/screens.json`, rerun Step 4.2's block, and present the screen graph gate again; build the new screens with Steps 5-7 and confirm them at the preview gate before retrying specs.

### JavaScript dependencies

**Telemetry checkpoint: `install_approved_javascript_dependencies`**

Builders use only installed packages. When a builder's `DONE_WITH_CONCERNS` or the Step 9.0 specs name a pure-JavaScript package a screen would genuinely need, or a preview-gate change calls for one, list each package with its exact version and the screen that needs it, raise the banner, and ask one `AskUserQuestion` to install exactly that set:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status active --note "Waiting for your approval of JavaScript packages"
```

Approval is consent for exactly those packages and versions.
Install them with the Installation Contract in [`javascript-dependency-planning.md`](${PLUGIN_ROOT}/shared/references/javascript-dependency-planning.md) before the screen that imports them is rebuilt: validate `package.json` and the lockfile, and verify module resolution.
Keep every package exactly as approved, and route JS-only packages through this contract rather than `/add-native`.
If final inspection finds native code or config, or incompatible runtime dependencies, remove only the newly added package and STOP with the exact failed criterion.
If the user declines, record `JavaScript dependencies: declined <names>` in `## Screens` so later rebuilds use existing primitives.

### Step 9 — Design system

**Print before starting:**
> "→ [Step 9/17] Locking your design system. The live preview restyles itself as soon as it is applied."

**Skip this step if `--no-design` is in `$ARGUMENTS`** — record it as skipped rather than leaving
it open, because this branch never reaches the `done` call in Step 9.2:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status skipped
```

Marking it `active` here instead would leave it active through the architecture gate, until
opening the next phase auto-closed it as `done` — reporting a design system that was never built.
On the skip branch the preview keeps the template's default theme, the `## Design` section from
Step 4.1 stays as written, and later screen rebuilds fall back to industry-inferred defaults from
`universal-patterns.md`.

**Otherwise**, open the phase and invoke `/design-system` (ships with this plugin). `/design-system`
asks for brand inputs, a cost choice and a style pick, so the phase opens as waiting:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status active --note "Waiting for your brand and design choices"
```

```
Invoke skill: /design-system

Environment:
  CODE_APPS_NATIVE_ORCHESTRATING=1

Context:
  MOBILE_APP_ORCHESTRATING=1
  orchestrator: create-mobile-app
  working_dir: <working_dir>
  phase: design
  live_preview: http://localhost:<port>
  approved_scope: <confirmed app intent; design-system owns its design approval>

Arguments:
  --working-dir '<working_dir>'
```

The `Environment` block is load-bearing, and follows the nested-skill handoff `/edit-app` already
uses. `/design-system` and its style picker gate every browser opener on that variable; without it
they detect a standalone run and open tabs over the build plan.

The scoped `MOBILE_APP_ORCHESTRATING=1` context identifies the owner and approval
boundary; `CODE_APPS_NATIVE_ORCHESTRATING=1` separately suppresses nested browser
openers. `live_preview` tells `/design-system` that the real app is already on screen, so it skips
its static HTML screen mockups (Sub-step 6.5 and the defaults-path mini-preview): Step 9.2 applies
the tokens to the running app, which is the truer preview. The skill collects brand inputs,
presents the cost picker (a/b/c/d), runs the internal style picker, writes approved brand
artifacts, and returns with status.

As soon as `/design-system` returns, replace the note — the user has answered and the run is
working again:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status active --note "Applying your design system"
```

Handle the return per [Sub-agent return status](screens-first.md#sub-agent-return-status):
- `DONE` → continue to Step 9.2. Record `brand_path`, `tokens_path`, `direction` in memory-bank.
- `DONE_WITH_CONCERNS` → surface concerns, ask user, continue.
- `NEEDS_CONTEXT` → surface question, re-invoke with answer.
- `BLOCKED` → surface error, STOP.

If the user picked path (c) Skip in the cost picker, the skill returns `DONE` with no `brand/` files; Step 9.2 then verifies the host defaults and the preview keeps its current look.

Screen layouts are not rebuilt here.
Brand tokens restyle every screen through the semantic tokens the builders used (`$surface*`, `$accent*`, `$text*`, radius and space scales).
When the user asks for layout changes after seeing the restyled preview, route them through the preview gate's change table (Step 8.1) before continuing.

Offline profile setup is intentionally deferred until after the approved
Dataverse model has been materialized. Follow the shared connectivity-intent
ownership contract during this phase.

### Step 9.2 — Apply the design system to the app

This runs on every path. Under `--no-design` it only verifies the host factory (the `add-aliases` row below) and skips the closing record, because the design phase is already `skipped`.

`/design-system` owns user-facing brand/design choices. The native-host
`createPowerAppsTamaguiConfig` factory owns the baseline semantic aliases,
contrast handling, animations, and font fallback. This step applies generated
brand tokens without copying that host logic into the app.

Read the `## Design` section from `native-app-plan.md` and follow the execution mapping in [`shared/references/design-planning.md`](${PLUGIN_ROOT}/shared/references/design-planning.md):

| Condition | Action |
|---|---|
| `brand/tokens.ts` exists | **Highest priority.** Apply [`../design-system/references/tamagui-integration.md`](../../design-system/references/tamagui-integration.md) in brand-import mode, export the resolved app light/dark themes, then wire matching `ThemeTokens` into `app/_layout.tsx`. |
| `## Design` says `required` | Apply the same reference using the approved `## Design` section. Builds custom token system + aliases. |
| `## Design` says `add-aliases` | Verify `tamagui.config.ts` uses `createPowerAppsTamaguiConfig`; the host already provides the semantic aliases. |
| Custom font only | `npx --no-install expo install expo-font` + `useFonts()` in `_layout.tsx`; preserve the host config factory. |

**No unchecked path.** Screen-builders require `$surface0`–`$surface3` and
`$accent*` aliases. On the default path, verify the host factory rather than
rewriting the config. Pass the complete `## Design` section verbatim — not a
summary. Re-run `npx --no-install tsc --noEmit` after Tamagui config changes.

**Brand-token wiring** — when `brand/tokens.ts` exists, the Tamagui integration
exports `appLightTheme` and `appDarkTheme`. Map those resolved semantic values
into the host themes so `useTheme()` and `useThemeTokens()` cannot drift:

If the approved design includes a custom dark palette, apply the reference's
**Approved dark palette** branch first: import `darkTokens` from
`brand/tokens.dark.ts` in `tamagui.config.ts` and derive `appDarkTheme` from
`darkTokens.color`. The provider mapping below then consumes that resolved theme;
do not leave the base accent-only dark declaration in place.

```tsx
import {
  PowerAppsProvider,
  lightTheme as hostLightTheme,
  darkTheme as hostDarkTheme,
} from '@microsoft/power-apps-native-host';
import type { ThemeTokens } from '@microsoft/power-apps-native-host';
import tamaguiConfig, {
  appDarkTheme,
  appLightTheme,
} from '../tamagui.config';

const brandedLightTheme: ThemeTokens = {
  ...hostLightTheme,
  surface0: appLightTheme.surface0,
  surface1: appLightTheme.surface1,
  surface2: appLightTheme.surface2,
  surface3: appLightTheme.surface3,
  surface4: appLightTheme.color6,
  text0: appLightTheme.text0,
  text1: appLightTheme.text1,
  text2: appLightTheme.text2,
  text3: appLightTheme.text3,
  accentDeep: appLightTheme.accentDeep,
  accentBase: appLightTheme.accentBase,
  accentSoft: appLightTheme.accentSoft,
  accentOnAccent: appLightTheme.accentOnAccent,
};
const brandedDarkTheme: ThemeTokens = {
  ...hostDarkTheme,
  surface0: appDarkTheme.surface0,
  surface1: appDarkTheme.surface1,
  surface2: appDarkTheme.surface2,
  surface3: appDarkTheme.surface3,
  surface4: appDarkTheme.color6,
  text0: appDarkTheme.text0,
  text1: appDarkTheme.text1,
  text2: appDarkTheme.text2,
  text3: appDarkTheme.text3,
  accentDeep: appDarkTheme.accentDeep,
  accentBase: appDarkTheme.accentBase,
  accentSoft: appDarkTheme.accentSoft,
  accentOnAccent: appDarkTheme.accentOnAccent,
};

// In RootLayout:
<PowerAppsProvider ... theme={brandedLightTheme} darkTheme={brandedDarkTheme}>
```

Without an approved custom dark palette, the exported dark app theme retains
Config v5 dark surfaces and text while carrying brand accents and statuses.
With an approved custom dark palette, `appDarkTheme` instead resolves the full
`darkTokens.color` palette, including its surfaces and text, and the provider
mapping above uses that same resolved theme. For runtime theme switching, use `useThemeControl()` from
`@microsoft/power-apps-native-host`.

**Confirm the preview picked it up.** Re-run `check-web-preview.js` from Step 6.3; the open preview reloads with the new tokens.
If the user is looking at the preview, point them at it: "Your design is applied to the live preview."

**Record the design** once the tokens are applied, taking the palette from `brand/tokens.ts`.
Write `<tmp>/design.json` with the `Write` tool — the direction is free text the user chose, so it
goes to a file rather than through the shell:

```json
{"direction":"<direction>","headingFont":"<font>","bodyFont":"<font>","darkMode":"<enabled|disabled>","palette":[{"name":"Primary","value":"#rrggbb"}]}
```


```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' set --section design --json-file <tmp>/design.json
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status done
```

Only `#rrggbb` literals render as swatches; any other value is shown as text rather than
becoming an arbitrary CSS value.

### Step 9.3 — Bring every screen to the full checklist

The preview's screens were built for speed by `preview-screen-builder`, from the graph alone.
Now that the specs (Step 9.0) and the design system (Step 9.2) exist, `screen-builder` brings each one to its full Hard Rules and Quality checklist, in place, keeping the layout and behaviour the user approved.
This runs on every path, `--no-design` included.

Spawn one `mobile-app:screen-builder` per built screen, in one message, in the background (`run_in_background: true` in Claude Code, `mode: "background"` in GitHub Copilot CLI), at most 5 at once:

```
Spawn agent: mobile-app:screen-builder

Prompt:
  working_dir: <working_dir>
  screen_name: <name>
  route: <route>
  target_file: <working_dir>/<file>
  plan_path: <working_dir>/native-app-plan.md
  data_mode: preview
  spec_source: built
  plugin_root: ${PLUGIN_ROOT}

  Follow screen-builder.md's Quality pass; ${PLUGIN_ROOT} in it means plugin_root. Return per
  AGENTS.md rule #12.
```

Continue to Step 10 while they run: the architecture and data model gates need the user, and the phone hot-reloads each screen as its pass lands.
Collect every builder before Step 11 starts, blocking on each (GitHub Copilot CLI: `read_agent` with `wait: true`), and handle each return per [Sub-agent return status](screens-first.md#sub-agent-return-status).
Then run Step 7's whole-app check once more; it is clean before Step 11.
If `Task` cannot spawn `mobile-app:screen-builder`, apply the pass yourself, one screen at a time, following `agents/screen-builder.md`'s Quality pass.

### Step 10 — Plan the architecture and data model

**Telemetry checkpoint: `plan_app_architecture`**

**Print before starting:**
> "→ [Step 10/17] Deciding what the app needs underneath: device features, connectors, and where its data lives. Your approved screens drive every choice."

The approved screens are now the main planning input.
Every device action in the Data Contract needs a native capability, every entity needs a home (a Dataverse table or a connector), and the data model is shaped by the fields the screens actually show.
The web preview stays running, so the user can check a screen while answering.

### Architecture gate

Planning is now the live phase. Open it with what the run is doing rather than with a question:
between gates the agents work for minutes, and the plan must not tell the user the run is waiting
on them while it is not.

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id architecture --status active --note "Planning the architecture"
```

Raise and take down the architecture and data model gates exactly as the
[gate table](#build-plan-in-phase-b) lists them. Flip each section to `approved` when its
gate is answered, not later in the Step 10.9 batch: a section left `proposed` while the next
phase works reads as a question nobody is asking. The architecture-only planner pass does nothing
but present the architecture gate, so raise that gate before dispatching it. When the planner's
completion pass presents the data model gate itself, the plan cannot see inside it and keeps its
progress note until the result comes back.

Run the planner once in architecture-only mode before any Dataverse discovery.
It does nothing but present the architecture gate, so raise the gate first:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id architecture --status active --note "Architecture gate - awaiting your approval"
```

```
Spawn agent: mobile-app:architecture-planner

Prompt:
  Plan and approve architecture inputs for a Power Apps mobile app.
  Architecture phase: gate-only
  Requirements brief: <requirements_brief>
  Plan document: <working_dir>/native-app-plan.md (approved ## Screens, including the Data Contract;
    every device action and entity there must be covered by the architecture you propose)
  Original prompt: <full $ARGUMENTS verbatim>
  Wizard answers: <Step 2 answers>
  Target platforms: iOS and Android
  Recommended Dataverse planning mode: <recommended_dataverse_planning_mode>
  Working directory: <absolute path>
  Plugin root: ${PLUGIN_ROOT}
  Dataverse planning snapshot: NOT SUPPLIED
  Dataverse planning evidence: NOT SUPPLIED
```

The planner presents native capabilities, then connectors, then the
data-platform choice in the architecture gate. On approval it writes
`<working_dir>/.tmp/approved-architecture.md` and returns exactly
`NEEDS_CONTEXT: dataverse-planning-mode:<required|connector-only>`.

Treat that signal as the successful architecture result, set
`<dataverse_planning_mode>` only after the architecture-result checks in the
canonical status switch below pass, and continue. Any other terminal status
follows that switch. If the nested planner is unavailable, prepare and approve
all three architecture decisions inline: native capabilities, connectors, and
the data-platform choice. Use the planner's architecture-gate dependency checks, write
the same approved artifact, and continue without adding another approval.

Now execute the deferred Step 1.7 publisher-prefix detection for `required`.
For `connector-only`, set `$DETECTED_PUBLISHER_PREFIX = ""`, print
`↷ Publisher-prefix discovery skipped — connector-only planning.`, and do not
call `detect-publisher-prefix.js`.

### Foreground Dataverse planning snapshot and evidence

**Shared step:** read [`dataverse-planning-snapshot.md`](dataverse-planning-snapshot.md) and follow it in full.

**Hard rule — planner writes are restricted during Step 10.** The planner (and any sub-agents it spawns) is permitted to write to **only**:

- `<working_dir>/native-app-plan.md`, and only its `## Data Model`, `## Native Capabilities`, `## Connectors`, and `## Approvals` sections; `## Screens` was approved at the screen graph and preview gates and stays as it is
- `<working_dir>/.tmp/*`

All other paths in `<working_dir>/` (notably `app/`, `src/`, `package.json`, `power.config.json`, `tamagui.config.ts`, `tsconfig.json`, `node_modules/`, `memory-bank.md`) are owned by the foreground phases. Do not mutate them during planning.

When the planner returns `DONE_WITH_CONCERNS`, append its concerns to `memory-bank.md` `## Concerns`; the planner itself never writes that file.

**Resume-from-draft check.** Before spawning, read `## Data Model`, `## Native Capabilities`, and `## Connectors` in `native-app-plan.md`. Step 4.1 left each with the single `Pending` line. If any holds more than that but `## Approvals` records no architecture approval (for example, an earlier planner run in a degraded context returned `BLOCKED: tool surface missing` after drafting), pass `resume_from_draft: true` and the plan path so the planner loads the draft as baseline instead of regenerating from scratch.

**Planner preflight (silent).** Before the full Task spawn, do a no-op `Task` probe for `mobile-app:architecture-planner` (a one-off agent spawn that returns `DONE` at once). If the probe fails with `Agent type … not found`, `tool unavailable`, or the host clearly cannot route nested agents, fall through to **inline-gate mode** (described below) without prompting. The orchestrator has the full tool surface itself — it can run the gates directly. Do not retry, do not ask the user.

**Announce the handoff before the Task call** (so the user isn't staring at a blank screen while the planner spins up):
- `required`: > "→ Spawning planner agent from the verified foreground planning snapshot. Data-model readiness is quality-first with a 10–15 minute target. I will print each factual `data-model-planning-status.json` milestone and elapsed count as it lands."
- `connector-only`: > "→ Spawning planner agent in connector-only mode; a foreground planning snapshot and data-model mutation are not required."

Then spawn the `mobile-app:architecture-planner` agent via `Task` (the plugin name `mobile-app:` prefix is required — without it `Task` returns `Agent type not found`):

```
Spawn agent: mobile-app:architecture-planner

Prompt:
  Plan the data model for a Power Apps mobile app whose screens are already approved.

  Requirements brief (confirmed with user):
  <requirements_brief — the `brief` in `.tmp/requirements.json`>

  Plan document: <working_dir>/native-app-plan.md
  Approved screens: the plan's ## Screens section, including ### Data Contract. The data model
    maps every Data Contract entity and field; it is the input, not a suggestion.
  Design vibe opt-in: <design_vibe_opt_in — "done" after Step 9, or "skip" with --no-design. Never invent other values.>

  Original prompt: <full $ARGUMENTS verbatim>
  Wizard answers: <Step 2 answers>
  Target platforms: iOS and Android (fixed; no platform question)
  Working directory: <absolute path of <working_dir>>
  Plugin root: ${PLUGIN_ROOT}
  Architecture phase: complete
  Approved architecture artifact:
  <working_dir>/.tmp/approved-architecture.md
  Dataverse planning mode: <required | connector-only>
  Dataverse planning failure reason: none
  Normalized Dataverse foreground planning snapshot: <absolute SNAPSHOT_PATH verbatim for required; otherwise NOT SUPPLIED>
  Compact Dataverse architect evidence: <absolute ARCHITECT_EVIDENCE_PATH verbatim for required; otherwise NOT SUPPLIED>
  Structured schema contract: <absolute
  `<working_dir>/.tmp/dataverse-schema-contract.json` for required; otherwise
  NOT SUPPLIED>
  Publisher prefix (detected from env): <DETECTED_PUBLISHER_PREFIX from Step 1.7, e.g. "cr8142a" — use literally as `<prefix>_<entity>` in all logical names. If empty/NOT DETECTED, fall back to `cr` placeholder and surface a `DONE_WITH_CONCERNS` note that Dataverse will normalize at create time.>

  Follow architecture-planner.md. Restore the approved architecture without
  re-asking the architecture gate, then run conditional Dataverse modeling and
  the data model gate. On terminal return, emit one of
  `DONE` / `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:` as the literal
  first line per AGENTS.md rule #12.
```

The planner restores the approved architecture, runs the conditional data model
and its gate, and fills the pending sections of `<working_dir>/native-app-plan.md`.
Wait for it to return before continuing — do not proceed on a
partially-approved plan.
On a successful `required` return, require both
`.tmp/dataverse-schema-contract.json` and `.tmp/mobile-plan-status.json`
before continuing. If the receipt is missing, STOP as `BLOCKED`; this
orchestrator must not synthesize it after the planner has returned.

#### 10.0a — Inline-gate fallback (planner unavailable OR returned `BLOCKED: tool surface missing`)

When the preflight fails OR the planner returns `BLOCKED: tool surface missing <…>`, the orchestrator runs all applicable gates inline. Do NOT re-spawn the planner — it cannot succeed in this host. Print **once**:

> "→ Planner agent unavailable in this host — running approval gates inline. (No action needed; this is automatic.)"

Then execute, in order, using your own `EnterPlanMode` + `AskUserQuestion`:

1. Read `<working_dir>/.tmp/approved-architecture.md`. If it is missing or malformed, return to the Architecture gate
  above and recover the artifact from recorded user acceptance, or run that
  gate inline when approval is absent. Do not invent approval or infer the
  data platform from missing artifacts. Only then perform the conditional
  foreground snapshot step and resume here; retain a valid existing approval
  without re-asking it.
2. Restore the approved native capabilities, connectors, and data-platform
   mode without re-presenting the architecture gate:
   - In `connector-only`, write an explicit zero-table/no-Dataverse
     `## Data Model` section and no schema contract or data-model approval
     receipt.
   - In `required`, spawn `mobile-app:data-model-architect` directly via
     `Task`, passing `Approved native capabilities:` and
     `Approved connectors:` verbatim along with the foreground
     snapshot/evidence paths, plus the approved `## Screens` section with its
     Data Contract. Present its result as the data model gate and require
     approval before Step 11.

  **MUST forward the approved architecture in the direct architect prompt.**
  Include the exact native capabilities and connectors approved at the
  architecture gate, and the approved screens with their Data Contract. In
  `required`, pass `Dataverse planning mode: required` and forward
  `SNAPSHOT_PATH` and `ARCHITECT_EVIDENCE_PATH` verbatim. The full snapshot is
  validator input only; read only the compact evidence. Do not resolve the
  environment or run Dataverse discovery again. A
  `connector-only` run never dispatches this architect.

  **MUST forward `$DETECTED_PUBLISHER_PREFIX` from Step 1.7 in the architect prompt:** *"Publisher prefix (detected from env): `<DETECTED_PUBLISHER_PREFIX>` — use literally as `<prefix>_<entity>` in all logical names. If empty/NOT DETECTED, fall back to `cr` placeholder and surface a `DONE_WITH_CONCERNS` note that Dataverse will normalize at create time."* Without this, the architect defaults to `cr_` and the whole plan needs a post-hoc sweep when the real prefix is something else (e.g. `cr3e9`).

  In `required`, also require the direct architect to write and normalize
  `<working_dir>/.tmp/dataverse-schema-contract.json` per its agent contract.
  A draft Markdown section without that sidecar is not an executable data
  model gate result.

  Before presenting the data model gate, run
  `validate-dataverse-planning-decisions.js --contract <contract> --snapshot <snapshot>`,
  then propose the section and raise the gate:

  ```bash
  node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' set --section dataModel --json-file <tmp>/data-model.json --state proposed
  node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id data-model --status active --note "Data model gate - awaiting your approval"
  ```

  Apply the native planner's Step 5 decision-validation handling: preserve the
  exact metadata signal on exit `3`, revise against the same compact evidence
  on exit `4`, and permit approval only on exit `0`. This check also applies to
  every direct revision and the fully-inline fallback; architecture approval
  never substitutes for data-model approval.

   **Why this works even though the planner just returned BLOCKED for tool surface:** the orchestrator (this skill, running in the user's slash-command session) always has the full tool surface — Task, EnterPlanMode, ExitPlanMode, AskUserQuestion, Read, Write, Bash. What's missing is the surface inside *nested* agent contexts (the `architecture-planner` agent runs in a sandbox without EnterPlanMode/AskUserQuestion, which is why its Step 0 preflight returned BLOCKED). The leaf agent `data-model-architect` only needs Read/Write/Bash to draft markdown — they don't need EnterPlanMode/AskUserQuestion themselves. Spawn them; the orchestrator owns the gates.

3. **Finalize the existing `native-app-plan.md`.** Fill only `## Data Model`,
   `## Native Capabilities`, and `## Connectors`, replacing their Step 4.1
   `Pending` lines; `## Screens` and `## Design` stay as approved. Update
   `## Approvals` with each actual user acceptance and timestamp. Follow the
   planner's [plan structure](${PLUGIN_ROOT}/agents/architecture-planner.md#plan-structure)
   for headings, the verbatim App Requirements cap, where discovery-failure
   notes go (`memory-bank.md` `## Discovery Notes`), and the single `### Notes`
   subsection in `## Data Model`.

4. **Add the Data Contract mapping.** In `required`, `## Data Model` ends with
   `### Data Contract Mapping`, mapping every Data Contract entity to its table
   and every field to its column, choice value, or lookup, as
   `agents/data-model-architect.md` specifies. Step 14 wires the data layer from
   this table. In `connector-only`, map each entity to its connector operation
   instead.

5. **Record the same structured approval receipt as the planner path in
  `required` mode only.** At data-model acceptance, initialize
   `<working_dir>/.tmp/mobile-plan-status.json` with the exact normalized
   contract content/hash, the screen-plan approval already recorded at the
   screen graph and preview gates, and the architecture approvals. Record the
   final structured service dependencies (every table a Data Contract entity
   maps to, with the screens that use it as consumers) and the integrity hash.
   Follow the receipt section of `agents/architecture-planner.md` exactly. Never call the operation
   manifest builder to create or restamp this receipt. A changed approved
   section invalidates its record until the existing inline gate approves it
   again.

  In `connector-only`, do not create `.tmp/mobile-plan-status.json` or any
  Dataverse schema/approval artifact.

If the orchestrator's OWN `Task` tool is unavailable (rare — would mean even
leaf agents cannot be spawned), fall further to fully-inline mode. Draft and
approve native capabilities, connectors, and data platform first. In
`required`, then draft the data model from `ARCHITECT_EVIDENCE_PATH`, using
`SNAPSHOT_PATH` only through deterministic validation. With no live OData probe,
write/normalize the same structured schema
contract required by `agents/data-model-architect.md`. In `connector-only`,
write an explicit zero-table/no-Dataverse `## Data Model` section and no
contract or data model gate. This is the last-resort path -
functional but slower because the orchestrator does work the architects
normally perform.

**Hard rule:** never silently skip an applicable gate just because the planner
could not run. Connector-only intentionally skips the non-applicable data model
gate; every other section must be approved before mutation starts.

The architecture-only pass is the sole owner of the
`NEEDS_CONTEXT: dataverse-planning-mode:<required|connector-only>` signal.
During the completion pass, receiving that signal again is malformed and must
be treated as `BLOCKED`.

#### 10.0 — Architecture and Dataverse return signals

**Architecture-gate result (handle before generic retries).** Only a planner
dispatched with `Architecture phase: gate-only` may return exactly
`NEEDS_CONTEXT: dataverse-planning-mode:required` or
`NEEDS_CONTEXT: dataverse-planning-mode:connector-only` as success. Read
`.tmp/approved-architecture.md`: its mode must match the returned value, it
must contain the exact approved Native Capabilities and Connectors sections,
the data-platform choice, and a user-approval timestamp. A missing or malformed
artifact returns to the Architecture gate recovery path, not to metadata
discovery. On success, restore those inputs, set `<dataverse_planning_mode>`,
and continue to deferred publisher/snapshot work only for `required`. This
does not consume the generic retry budget and must not re-present the
architecture gate.
In `complete` phase or from any other agent, that signal is malformed; do not
let it change an already approved data platform.

**Screen changes requested during planning.** If the user asks to change a
screen while answering the architecture or data model gate, finish or pause the
gate, then route the change through the preview gate's change table (Step 8.1).
A Data Contract change re-dispatches the data model with the updated contract;
it never edits `## Screens` from inside the planner.

For all other first lines, apply [Sub-agent return status](screens-first.md#sub-agent-return-status).

#### Dataverse planning recovery

**Shared step:** read [`dataverse-planning-recovery.md`](dataverse-planning-recovery.md) and follow it in full.

#### Post-plan publisher-prefix gate

**Shared step:** read [`post-plan-publisher-prefix.md`](post-plan-publisher-prefix.md) and follow it in full.

### Step 10.9 — Confirm the approved plan

Each gated section was written `proposed` before its gate and flipped to `approved` when the user
answered it (the [gate table](#build-plan-in-phase-b)). The screens section was approved at
Step 4.2, so only the Step 10 sections are restated. Restate them here, before any mutation
starts, so a call missed at a gate cannot leave a proposal on record and an abort still leaves a
document explaining what was agreed:

```bash
DOCS="${PLUGIN_ROOT}/scripts/app-docs.js"
node "$DOCS" --working-dir '<working_dir>' set --section architecture --json-file <tmp>/architecture.json --state approved
node "$DOCS" --working-dir '<working_dir>' step --id architecture --status done --note "Architecture gate - approved"
node "$DOCS" --working-dir '<working_dir>' set --section trust --json-file <tmp>/trust.json --state proposed
node "$DOCS" --working-dir '<working_dir>' set --section dataModel --json-file <tmp>/data-model.json --state approved
node "$DOCS" --working-dir '<working_dir>' step --id data-model --status done --note "Data model gate - <n> tables approved"
```

**Write a first-pass trust report here.** The architecture gate settles the device capabilities and connectors,
which is everything the `permissions[]` and `battery[]` lists are derived from, so the Trust report
tab fills as soon as the user approves rather than staying empty for most of the run. Mark it
`proposed`: it states what the approved plan intends, and Step 13.1 rewrites it as `approved` once
the capabilities are actually wired. Leave `handles[]` and `notCollected[]` out for now — those
depend on the data model and offline profile, which are not settled yet.

Build each JSON from the approved `native-app-plan.md` using the shapes in the
[Build documentation protocol](#build-plan-in-phase-b). Populate `dataModel.tables[]`
structurally — `logicalName`, `status`, `columns[]` with `key: PK|FK`, `relationships[]` — because
the ER diagram, the column tables, and the new/reused/extended colours are all derived from it.

**Connector-only apps:** mark both Dataverse phases as not applicable rather than leaving them
pending, or the plan never reaches 100%:

```bash
node "$DOCS" --working-dir '<working_dir>' step --id data-model --status skipped
node "$DOCS" --working-dir '<working_dir>' step --id dataverse --status skipped
```

### Step 11 — Auth config

**Telemetry checkpoint: `configure_native_authentication`**

**Shared step:** read [`auth-config.md`](auth-config.md) and follow it in full.

### Step 12 — Apply data model

**Telemetry checkpoint: `apply_dataverse_data_model`**

**Shared step:** read [`apply-data-model.md`](apply-data-model.md) and follow it in full.

### Step 12.5 — Seed sample data (approved scope)

**Shared step:** read [`seed-sample-data.md`](seed-sample-data.md) and follow it in full.

### Offline profile (Dataverse-backed apps)

**Shared step:** read [`offline-profile.md`](offline-profile.md) and follow it in full.

### Step 13 — Apply native capabilities

**Telemetry checkpoint: `configure_native_capabilities`**

**Shared step:** read [`native-capabilities.md`](native-capabilities.md) and follow it in full.

### Step 13.1 — Add connectors

**Telemetry checkpoint: `generate_connector_data_sources`**

**Shared step:** read [`connectors.md`](connectors.md) and follow it in full.

### Step 14 — Connect real data

**Telemetry checkpoint: `connect_real_data_sources`**

**Print before starting:**
> "→ [Step 14/17] Connecting your screens to real data. Only the data layer changes; the screens you approved stay as they are."

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id wiring --status active
```

**Move the plan's phone to the QR code.**
From here the data layer calls real services, which need a signed-in Power Apps host.
The browser frame has none, so the wired app would only show errors there; Power Apps Mobile Preview is one, and the dev server from Step 3.5 keeps serving it.
Keep that server running, and switch the plan's phone from the browser preview to the code the preview gate drew:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' phone --stage qr
```

When the preview gate drew no QR code (the server fell back to `--localhost`), use `--stage building` instead; the dev server step draws the code.
Tell the user once:

> "→ Your app now reads real data, which needs a signed-in host, so the build plan's phone shows the QR code instead of the browser preview. A phone that already scanned it keeps running the app: it may show errors for a moment while the data layer switches over, then reloads with your live data, and device features such as the camera use the real hardware. Sign in when it asks. After the run, `npm run web` opens the same app signed in, with live data, in your browser."

Without a QR code, say instead:

> "→ Your app now reads real data, which needs a signed-in host, so the build plan's phone stops showing the browser preview. The app opens on your phone at the dev server step, and after the run `npm run web` opens it signed in, with live data, in your browser."

#### 14.1 — Snapshot generated services into the plan

Probe `src/generated/services/` once and record what exists, so every adapter uses the same exact service names and methods:

```bash
cd <working_dir>
for svc in $(ls -1 src/generated/services/*.ts 2>/dev/null); do
  name=$(basename "$svc" .ts)
  methods=$(grep -oE 'static async [a-zA-Z_]+' "$svc" | sed 's/static async //' | tr '\n' ',' | sed 's/,$//')
  echo "| \`$name\` | \`src/generated/services/$name.ts\` | $methods |"
done
```

Write the result into `native-app-plan.md` as a section immediately after `## Screens`, replacing any earlier snapshot (services come and go as `/add-dataverse`, `/add-sharepoint`, and `/add-connector` run):

```markdown
## Generated Services (snapshot at <ISO timestamp>)

| Service | Path | Methods present |
|---|---|---|
| `Cr3e9_projectsService` | `src/generated/services/Cr3e9_projectsService.ts` | `getAll, get, create, update, delete` |

Data-layer adapters import these exact names and methods. Screens reach them only through `@/hooks/data`; in an app without `src/hooks/data/`, screen-builders import them directly.
```

When the directory is empty, write the section with an empty table and the line "No generated services yet."

#### 14.2 — Rewire the data layer

Follow the **Wiring** section of [`preview-data-layer.md`](${PLUGIN_ROOT}/shared/references/preview-data-layer.md) for every `preview` block that `check-data-layer.js` lists.
The mapping comes from `## Data Model → ### Data Contract Mapping` (entity to table or connector, field to column, choice value, or lookup), checked against the generated models.
Entity modules are independent files; write them as one batch.

- **Dataverse and connector entities** get adapters over the generated services from 14.1.
- **Device actions** call the `src/native/` wrappers Step 13 created.
- **A device action whose capability was declined** at the architecture gate is removed together with its control: rebuild the affected screens with `screen-builder` (Step 9.3's prompt with `data_mode: wired` in place of `spec_source`, naming the declined action), then remove the action.
- **An embedded native view** (the barcode scanner) replaces its preview placeholder: rebuild that screen with `screen-builder` and `data_mode: wired`.
- **A field mapped to `Defer`** (for example one that needs an external projection) has no real value: make it optional in the domain type, rebuild each screen that shows it with `screen-builder` (`data_mode: wired`, naming the deferred field) so the screen stops depending on it, and record it in `memory-bank.md` `## Concerns`.
- **An entity the user deferred** (a skipped connector or a deferred table) keeps its `preview` block. Record it in `memory-bank.md` `## Concerns` as `<Entity> still serves sample data - <reason>`, and carry it to the summary.

#### 14.3 — Wiring gate

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
npm run generate-schemas
npx --no-install tsc --noEmit
node "${PLUGIN_ROOT}/scripts/check-data-layer.js" --project-root '<working_dir>' --require-wired
node "${PLUGIN_ROOT}/scripts/check-routes.js"
```

This is the **Wiring gate**.
TypeScript and routes must be clean.
`check-data-layer.js --require-wired` must exit `0`, or report `still-preview` only for the entities recorded as deferred above; any other violation is repaired in one batch and the gate rerun.
A TypeScript error in a screen file means an adapter changed a domain type or hook shape: fix the adapter, and change the screen only when the real source genuinely needs a different shape.
Delete fixture files nothing imports, then run the shared changed-file gate on every file this step wrote.

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id wiring --status done
```

### Step 15 — Stylistic fix sweep (parallel)

**Telemetry checkpoint: `validate_screen_design_quality`**

Open the final phase; Step 17 marks it done:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id run --status active --note "Final checks"
```

**Shared step:** read [`stylistic-sweep.md`](stylistic-sweep.md) and follow it in full.

### Step 16 — Start the native dev server (Metro writes project-local logs)

**Telemetry checkpoint: `launch_metro_dev_server`**

**Shared step:** read [`dev-server.md`](dev-server.md) and follow it in full.

### Step 16.5 — Optional debug handoff

**Shared step:** read [`debug-handoff.md`](debug-handoff.md) and follow it in full.

### Step 17 — Summary

**Shared step:** read [`summary.md`](summary.md) and follow it in full.

## Notes

- This skill is the only entry point for new project creation. Do not invoke `/add-*` skills directly during a fresh-project flow — they don't know how to read the plan and would re-prompt the user.
- Each approval gate has exactly one owner, so no question is asked twice: this skill asks the screen graph and preview gates with `AskUserQuestion`; the planner agent asks the architecture and data model gates.
- For mid-project changes after Step 17, the user should run individual `/add-*` skills, or `/edit-app` for plan-backed app iteration.

## Reference

- [shared/shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)
- [shared/references/screen-templates.md](${PLUGIN_ROOT}/shared/references/screen-templates.md)
- [agents/architecture-planner.md](${PLUGIN_ROOT}/agents/architecture-planner.md)
- [shared/references/preview-data-layer.md](${PLUGIN_ROOT}/shared/references/preview-data-layer.md)

