---
name: genpage
version: 2.3.1
description: Creates, updates, and deploys Power Apps generative pages for model-driven apps using React v17, TypeScript, and Fluent UI V9. Orchestrates specialist agents for planning, entity creation, and code generation. Use it when user asks to build, retrieve, or update a page in an existing Microsoft Power Apps model-driven app. Use it when user mentions "generative page", "page in a model-driven", or "genux". This skill stands alone and does not require /app-builder — but if the user wants a whole app built (tables, forms, views, sitemap) rather than pages for an app that already exists, use /app-builder instead.
author: Microsoft Corporation
argument-hint: "<page description> | edit"
user-invocable: true
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate, TaskList, read, edit, execute, search, web, agent, todo
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Power Apps Generative Pages Builder

**Triggers:** genpage, generative page, create genpage, genux page, build genux, power apps page, model page
**Keywords:** power apps, generative pages, genux, model-driven, dataverse, react, fluent ui, pac cli
**Aliases:** /genpage, /gen-page, /genux

## Overview

This skill orchestrates specialist agents across the create and edit flows:

**Create flow:**
1. **`genpage-planner`** — validates prerequisites, gathers requirements, detects what
   entities and apps exist, and returns a proposed plan for the orchestrator to present.
   Writes `genpage-plan.md` once the orchestrator re-invokes it with the approval outcome.
   May pause and return `connector_discovery_required` (see 2).
2. **`genpage-connector-builder`** — top-level orchestrator dispatch for connector
   feature-gating and discovery; writes `connector-bindings.md` + `connectors.json`.
   Runs **after** the planner has resolved create-vs-edit and the target environment
   (discovery is mutating), then the planner is re-invoked with its contract.
   **`genpage-customapi-builder`** — the same top-level dispatch for server-side
   Custom API (Action/Function) needs; writes `custom-api-bindings.md` + `actions.json`.
3. **`genpage-entity-builder`** — creates Dataverse entities (tables, columns,
   relationships, choices, sample data) via the plugin's Node.js Web API scripts
4. **`genpage-page-builder`** — generates one complete `.tsx` file per page; multiple
   builders run in parallel for multi-page requests

**Edit flow:**

5. **`genpage-connector-builder`** — top-level orchestrator dispatch when an edit adds,
   replaces, discovers, removes, or clears connector bindings; preserves unchanged bindings
   when the edit does not touch them, or when the `connectors` rollback gate is off.
   **`genpage-customapi-builder`** — the same top-level dispatch when an edit adds, replaces,
   discovers, removes, or clears Custom API bindings.
6. **`genpage-edit-planner`** — reads the downloaded page artifacts, gathers change
   requirements, presents an edit plan, writes `genpage-edit-plan.md`

You (the skill) coordinate the agents and own connector and Custom API dispatch, app
creation, RuntimeTypes generation, deployment, browser verification, and the inline
application of planned edits.

## References

- **Code generation rules**: [rules.md](../../references/rules.md)
- **Troubleshooting**: [troubleshooting.md](../../references/troubleshooting.md)
- **Sample pages**: [samples/](../../samples/)

## Development Standards

- **React 17 + TypeScript** — all generated code
- **Fluent UI V9** — `@fluentui/react-components` exclusively (DatePicker from `@fluentui/react-datepicker-compat`, TimePicker from `@fluentui/react-timepicker-compat`)
- **Single file architecture** — all components, utilities, styles in one `.tsx` file
- **No external libraries** — only React, Fluent UI V9, approved Fluent icons, D3.js for charts
- **Type-safe DataAPI** — use RuntimeTypes when Dataverse entities are involved
- **Responsive design** — flexbox, relative units, never `100vh`/`100vw`
- **Accessibility** — WCAG AA, ARIA labels, keyboard navigation, semantic HTML
- **Complete code** — no placeholders, TODOs, or ellipses in final output

---

## Instructions

Follow these phases in order for every `/genpage` invocation.

### Phase 0: Create Working Directory

Derive a short folder name from the user's requirements:

1. Extract the page name or a 2-4 word summary from `$ARGUMENTS`
2. Convert to kebab-case (e.g., "Candidate Tracker" → `candidate-tracker`)
3. Create the folder: `mkdir -p <folder-name>` (bash/PowerShell; on cmd use `mkdir <folder-name>`,
   which has no `-p` and errors if the folder exists)
4. Resolve its absolute path — this is the **working directory** for all subsequent phases

### Phase 0.5: Initialize Local-Dev Manifest

Write `package.json` and `genpage.d.ts` into the working directory so the
developer can `npm install` and get IntelliSense, type-checking, and "go to
definition" in their editor. Versions come from
`references/supported-dependencies.md` (single source of truth:
`scripts/lib/supported-dependencies.js`).

```bash
node "${PLUGIN_ROOT}/scripts/generate-page-manifest.js" <working-dir> <kebab-slug>
```

- `<kebab-slug>` is the same slug used for the working directory.
- Add `--features charts,datepicker,timepicker` (comma-separated) only when
  the requirements clearly call for them; otherwise omit and keep the
  manifest lean.
- The script is **idempotent** — it skips files that already exist. Pass
  `--force` to overwrite (used in regeneration flows when versions drift).
- Output is a JSON summary on stdout; pipe to stderr for visibility but do
  not block the workflow if the script returns non-zero — the manifest is a
  dev-ergonomics aid, not part of the deployed artifact.

### Phase 1: Plan

> **⚠️ CRITICAL — the interactive steps run HERE, in the main conversation loop.
> You MUST NOT dispatch them to a `Task` subagent.**
>
> A `Task` subagent is **headless**: `AskUserQuestion`, `EnterPlanMode` and
> `ExitPlanMode` never reach the user from inside one. A flow that specifies them
> there cannot complete — the question is never answered and the approval never
> given. This is the same rule `/app-builder` follows, and the reason its
> subagents are headless workers only.
>
> `genpage-planner` is therefore a **headless discovery agent**. It runs the
> read-only work and returns what it found; **you** ask the questions and present
> the plan.
>
> Run in the main loop (never delegated):
> 1. Prerequisite validation (`node --version`, `pac help` version > 2.10.0)
> 2. Auth verification (`pac auth list`, environment selection)
> 3. The structured "Create new / Edit existing" question (`AskUserQuestion`)
> 4. Language detection (`pac model list-languages`) — only on new-page path
> 5. Entity existence detection (`pac model list-tables --search`)
> 6. App detection (`pac model list`) with proper selection prompts
> 7. Plan-mode presentation and approval (`EnterPlanMode` / `ExitPlanMode`)
> 8. Telling `genpage-planner` the approval outcome — it writes `genpage-plan.md`
>    itself — and confirming the file exists before Phase 2
>
> Steps 1, 2, 4, 5, 6 are read-only discovery and **may** be delegated to
> `genpage-planner`; steps 3, 7 and 8 never can. Delegating the discovery is an
> optimisation, not a requirement — running it inline is equally correct, but
> `genpage-plan.md` is still written by the planner either way (see step 6 of the
> Steps list): its section headings are a machine-readable contract every
> downstream phase parses by name, so it has exactly one author. If you ran the
> discovery inline, dispatch the planner once with what you found, so it has the
> context to produce the plan without repeating your reads.
>
> **Never skip the prereq/auth steps**, even when `$ARGUMENTS` already states the
> intent. A stated intent lets you skip *question 3*; it does not establish that
> the CLI is present, authenticated, or pointed at the right environment.
>
> **Whoever runs a step records it in `workflow-log.md`** in the documented
> format — `AskUserQuestion: <question> → <answer>`, `EnterPlanMode called`
> followed by the response. The log is the contract the eval harness reads, and
> it does not care which loop made the call.

#### Unattended runs (Copilot autopilot / Claude auto-accept)

Copilot CLI autopilot and Claude Code auto-accept drive this skill with **no user
watching**. Every gate below is written as "ask the user", and in those modes
there is nobody to answer: the run either stalls on a question no one sees or,
worse, records an answer nobody gave. Resolve the mode **once, at the start of
Phase 1**, and carry it through every gate:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-interaction-mode.js"
```

One JSON line, always exit 0 — "there is no user" is a fact about the run, not a
failure of it:

```json
{ "ok": true, "interactive": false, "reason": "POWER_PLATFORM_SKILLS_NONINTERACTIVE is set" }
```

A run is unattended when `--non-interactive` is passed or
`POWER_PLATFORM_SKILLS_NONINTERACTIVE` is `1`/`true` — the same switch
`/app-builder` already uses, so one setting covers both skills.

When `interactive` is `false`, do not call `AskUserQuestion`, `EnterPlanMode` or
`ExitPlanMode` at all. Take the documented default and record it in
`workflow-log.md` as `Unattended default: <question> → <answer> (<reason>)`, so
the log still shows what decided the run:

| Gate | Attended | Unattended |
| --- | --- | --- |
| Recording the resolved mode | Nothing to record | Write the mode itself as `Unattended default: interaction mode → unattended (<reason>)` before the first gate. Record it with this marker, not as free prose such as `Interaction mode: unattended` — the evaluator keys on the marker, and prose forms are indistinguishable from an attended log that merely mentions the word (`Mode: unattended = false`, `not unattended`). |
| Create new / edit existing (step 2) | `AskUserQuestion` | Whatever `$ARGUMENTS` states. With nothing stated, **create new** — the only additive choice. |
| An agent returns `needs_input` (step 4) | Ask, then re-invoke | Re-invoke with the option the agent marked `"default": true`. If it marked none, **halt**. |
| Plan approval (step 5) | `EnterPlanMode` / `ExitPlanMode` | Treat the plan as approved and continue to step 6, which still writes `genpage-plan.md` through the planner. The plan is recorded, just not presented. Log this gate as `Unattended default: plan approval → approved (<reason>)` — the evaluator looks for the plan/approval wording and `approved` on that one line, so a paraphrase such as `→ auto-approve` is read as a missing approval record. |
| Browser verification (Phase 7) | Offer it | Skip it. |

**Suppressing a prompt never authorizes destructive work.** Editing an existing
page overwrites source nobody reviewed, so on the **edit** path an unattended run
requires the page to be named explicitly in `$ARGUMENTS`. Do not infer the target
from a search result and do not fall back to "the only page that matched". If the
target is ambiguous, **halt and say so** — an unattended run that guesses which
page to overwrite is the one failure this table exists to prevent.

Halting is a normal outcome here, not an error to route around: report what was
missing and stop, so the run can be re-driven with the decision supplied.

#### Steps

1. Run the prerequisite, auth and discovery steps (inline, or via
   `genpage-planner` as a headless worker). Connector discovery has **not** run
   yet, so the contract is the literal `No connector bindings.`, with discovery
   available on request (see 1a). Custom API discovery is likewise orchestrator-
   owned and has not run either, so its contract starts as the literal
   `No custom API bindings.`, with discovery available on request (see 1b).
2. Ask question 3 (**create new / edit existing**) with `AskUserQuestion`, unless
   `$ARGUMENTS` already settles it. On **edit**, jump to the **Edit Flow** section.
3. If discovery reports `{ "action": "connector_discovery_required" }`, invoke
   `genpage-connector-builder` with the intent — **Mode: `create`** for a new
   page, **Mode: `edit`** for an edit — using the resolved environment URL, then
   re-run discovery with the builder's `## Connector Bindings` contract and
   `connectors.json` status. If it instead reports
   `{ "action": "custom_api_discovery_required" }`, invoke `genpage-customapi-builder`
   the same way (same mode, resolved environment URL, plus the returned `pageTables`),
   then re-run the planner with the builder's `## Custom API Bindings` contract and
   `actions.json` status (see 1b).
   If `genpage-connector-builder` or `genpage-customapi-builder` instead reports
   that its declared file or process-execution tools are unavailable, do **not**
   retry the same worker. Record the worker failure, read that worker's agent
   file, and run the discovery-builder workflow inline in this orchestrator
   using the same resolved mode, environment, intent, and safety gates. This
   inline fallback is recovery from task-runtime tool exposure only; it does not
   bypass connector/custom-API feature gates or user decisions.
4. If any agent returns `{ "action": "needs_input", … }`, ask its questions here
   with `AskUserQuestion`, record them in `workflow-log.md`, and re-invoke that
   agent with the answers. Agents never prompt; they request.
5. Present the plan with `EnterPlanMode` and get approval via `ExitPlanMode`.
   On a revision request, re-invoke the planner with the requested revisions and
   present the revised plan again.
6. **On approval, re-invoke `genpage-planner` with the approval outcome _plus
   the plan body it returned and everything it already discovered_.** The planner
   writes `genpage-plan.md` in its own final step, and it only reaches that step
   when it is told the plan was approved — a `Task` subagent is headless, so it
   cannot see the `ExitPlanMode` result any other way. A re-invocation is a fresh
   run with no memory of the last one: carry the state forward or it will re-ask
   questions the user has already answered, or re-derive a plan that is not the
   one they approved. Same rule as Phase 2b. Do not write the file yourself — its
   section headings are a machine-readable contract that every downstream phase
   parses by name.

   If `genpage-planner` reports that the file tools needed to write the approved
   `genpage-plan.md` are unavailable, do not retry it and do not write the plan
   inline. **Halt** with the approved plan body and failure recorded. Planner
   authorship is the provenance gate for every downstream phase.
7. Confirm `<working-dir>/genpage-plan.md` exists before starting Phase 2.
   Reaching Phase 2 without it means building from a plan nobody approved, and
   Phase 2 reads that file as its first action.

   **If it is missing, do not proceed and do not write it yourself.** Re-invoke
   the planner once more with the approval outcome and the plan body. If it is
   still missing, stop and tell the user what was approved and what failed to be
   written — a hand-written substitute is a plan with no provenance, and every
   later phase will treat it as approved.

#### 1a. Connector discovery is orchestrator-owned and never speculative

`genpage-connector-builder` is dispatched only by this top-level orchestrator,
not by `genpage-planner`. This keeps connector discovery and its rollback gate in one
agent while avoiding nested `Task` calls from the planner.

**Never run discovery before the planner returns** — not even when `$ARGUMENTS`
obviously mentions SharePoint, Teams, Office 365 or a custom REST source.
Discovery is a **mutating** operation: it can create a connection reference. The
planner is what resolves (a) create vs. edit and (b) which environment, and it may
resolve either differently from the active `pac auth` profile. A connection
reference created in the wrong environment, or in create mode for what turns out
to be an edit, **cannot be undone** by discarding the local outputs.

So the sequence is always: plan first, then discover, then re-plan.

- Every first planner invocation gets the literal contract `No connector bindings.`
  and is told discovery has not run.
- When the planner determines connector-backed data is needed — from `$ARGUMENTS`
  or from its own user clarification — it returns
  `{ "action": "connector_discovery_required", "intent": "..." }` **together with
  the resolved action and environment URL**.
- Only then dispatch `genpage-connector-builder` with that mode, that environment
  URL, the working directory and `${PLUGIN_ROOT}`. Read
  `<working-dir>/connector-bindings.md` and verify `<working-dir>/connectors.json`
  is a bare JSON array, then re-run the planner with the refreshed contract.

The builder remains the single owner of connector discovery and of the `connectors`
rollback gate: it probes first, writes `No connector bindings.` + `[]` when the gate
is off or the page needs no connector, and performs all connection discovery only
when one is required.

#### 1b. Custom API discovery is orchestrator-owned too

`genpage-customapi-builder` is likewise dispatched only by this top-level orchestrator,
not by `genpage-planner` — the planner has no `Task` tool, and the builder may need to ask
the user which Custom API to bind, which only the main loop can do. Custom API discovery is
**read-only** (a Web API query over the Custom API tables), so unlike connector discovery it
carries no "wrong environment / wrong mode cannot be undone" hazard. It still runs after the
planner so it targets the environment the planner resolved and binds to the page tables it
detected.

- Every first planner invocation gets the literal contract `No custom API bindings.` and is
  told discovery has not run.
- When the planner determines a server-side Custom API (Action/Function) is needed — from
  `$ARGUMENTS` or from its own user clarification — it returns
  `{ "action": "custom_api_discovery_required", "intent": "...", "resolvedAction": "create",
  "envUrl": "...", "pageTables": "..." }`.
- Only then dispatch `genpage-customapi-builder` with that mode, environment URL, page tables,
  the working directory and `${PLUGIN_ROOT}`. Read `<working-dir>/custom-api-bindings.md` and
  verify `<working-dir>/actions.json` is a bare JSON array, then re-run the planner with the
  refreshed contract.

The builder remains the single owner of the `custom-api` feature gate: it probes first, writes
`No custom API bindings.` + `[]` when the gate is off or the page needs no Custom API, and
performs discovery only when one is required.

#### Invocation prompt

Pass a prompt that includes:

- The user's requirements: `$ARGUMENTS`
- The working directory (absolute path from Phase 0)
- The plugin root path: `${PLUGIN_ROOT}`
- The connector contract: the full body of `<working-dir>/connector-bindings.md`,
  or the literal `No connector bindings.` when discovery was not needed
- The connector upload file status: `<working-dir>/connectors.json` exists and is
  a bare JSON array, or `no connectors.json; omit --connectors`
- The Custom API contract: the full body of `<working-dir>/custom-api-bindings.md`,
  or the literal `No custom API bindings.` when discovery was not needed
- The Custom API upload file status: `<working-dir>/actions.json` exists and is
  a bare JSON array, or `no actions.json; omit --actions`

Example:

> You are the genpage-planner agent. Plan generative page(s) for the following requirements:
>
> [paste $ARGUMENTS here verbatim, or "no arguments provided — gather from user"]
>
> Working directory: [absolute path from Phase 0]
> Plugin root: ${PLUGIN_ROOT}
>
> Connector discovery is orchestrator-owned. Do **not** invoke
> `genpage-connector-builder` from inside the planner. The `----- BEGIN/END
> CONNECTOR BINDINGS -----` lines below are delimiters for **this prompt only**:
> they mark where the contract starts and ends. Do **not** copy them into
> `genpage-plan.md`. The `## Connector Bindings` section of the plan is exactly
> the text between them:
>
> ----- BEGIN CONNECTOR BINDINGS -----
> [paste connector-bindings.md body, or `No connector bindings.`]
> ----- END CONNECTOR BINDINGS -----
>
> Connector upload file (orchestration metadata; not part of the
> `## Connector Bindings` section): [absolute path to connectors.json, or
> `none — omit --connectors`]
>
> If your clarification questions reveal connector-backed data that is not covered
> by the connector contract above, stop and return
> `{ "action": "connector_discovery_required", "intent": "<connector need>",
> "resolvedAction": "create" | "edit", "envUrl": "<the environment you resolved>" }`
> instead of trying to discover connectors yourself. `resolvedAction` and `envUrl`
> are required — discovery is dispatched against exactly those.
>
> Custom API discovery is orchestrator-owned too. Do **not** invoke
> `genpage-customapi-builder` from inside the planner. The `----- BEGIN/END
> CUSTOM API BINDINGS -----` lines below are delimiters for **this prompt only**:
> they mark where the contract starts and ends. Do **not** copy them into
> `genpage-plan.md`. The `## Custom API Bindings` section of the plan is exactly
> the text between them:
>
> ----- BEGIN CUSTOM API BINDINGS -----
> [paste custom-api-bindings.md body, or `No custom API bindings.`]
> ----- END CUSTOM API BINDINGS -----
>
> Custom API upload file (orchestration metadata; not part of the
> `## Custom API Bindings` section): [absolute path to actions.json, or
> `none — omit --actions`]
>
> If your clarification questions reveal a server-side Custom API (Action/Function)
> not covered by the Custom API contract above, stop and return
> `{ "action": "custom_api_discovery_required", "intent": "<operation>",
> "resolvedAction": "create" | "edit", "envUrl": "<the environment you resolved>",
> "pageTables": "<page tables or none>" }` instead of trying to discover it yourself.
>
> Follow the instructions in your agent file. Validate prereqs and confirm auth.
> The create/edit decision and the resolved environment are supplied to you by the
> orchestrator (it asks; you are headless) — use them rather than prompting. If you
> need any further decision, return `{ "action": "needs_input", … }`. Write
> genpage-plan.md to the working directory once the orchestrator reports the plan
> approved. Return the page list, entity status, app selection, and any
> `{ "action": "edit" }` signal when complete.

### Phase 2: Create Entities (Conditional)

Read `genpage-plan.md` from the working directory. Check the **Entity Creation Required**
section.

**If the section literally says "No entity creation required — all entities already exist":**
Skip to Phase 3.

**If entities need creating:**

#### 2a. Pre-flight: az + pac + Dataverse

Entity creation runs through the plugin's Node.js Web API scripts using `az` for
auth, and the `az` and `pac` identities should normally match. Run the
consolidated pre-flight:

```bash
node "${PLUGIN_ROOT}/scripts/check-auth.js" --require-pac
```

Genpage deploys pages via `pac model genpage`, so pass `--require-pac` to keep a missing pac login
a hard blocker (the app-builder skill omits the flag — its build path only needs the az token).
It returns a single JSON object:

```json
{
  "ok": true | false,
  "blocker": null | "az_missing" | "az_not_logged_in" | "pac_not_logged_in"
                 | "no_env_url" | "whoami_403" | "whoami_401" | "whoami_error",
  "message": "human-readable next step",
  "warnings": ["..."],
  "azUser": "...", "pacUser": "...", "envUrl": "...",
  "identitiesMatch": true | false,
  "whoAmI": { "ok": true, "userId": "...", "organizationId": "..." }
}
```

- **`ok: true` and `identitiesMatch: true`** → proceed to 2b.
- **`ok: true` and `identitiesMatch: false`** → proceed to 2b but surface the
  `message` to the user as an inline warning ("az is X, pac is Y — WhoAmI works
  for now, but if entity creation later returns 403, run the suggested
  `az login --username` to align them").
- **`ok: false`** → show the `message` field to the user verbatim and
  **stop the workflow**. The script already includes a fix-it command for every
  blocker (run `az login`, etc.).

Capture `envUrl` from the result — Phase 2b passes it to the entity-builder.

#### 2b. Invoke entity-builder

Invoke the `genpage-entity-builder` agent via the `Task` tool. Pass in the prompt:
- Path to `genpage-plan.md`
- Working directory (absolute path)
- Plugin root: `${PLUGIN_ROOT}`
- Dataverse env URL (from `pac org who`)

The entity-builder reads `Solution` and `Publisher Prefix` directly from the
plan's `## Environment` — no need to re-thread them here.

Wait for completion. The builder writes a transactional log at
`<working-dir>/genpage-entity-creation-log.md` for recovery on failure.

**The builder is headless and will ask for the sample-data decision by returning
`{ "action": "needs_input", … }`** (it has no way to prompt). Handle it here, in
this loop, exactly as Phase 1 step 4 does:

- Ask each question with `AskUserQuestion`.
- Record every exchange in `workflow-log.md` as `AskUserQuestion: <question> → <answer>`.
- Re-invoke the builder with the answers plus everything it already returned, so
  it can carry out the step that depended on them (sample data is created by a
  second pass of its own CLI, not by anything here). A re-invocation restarts the
  agent at its first step, which is safe — `provision-entities.js` is idempotent
  and re-reports the existing tables rather than recreating them — but say which
  decision has now been answered so it goes on to the sample-data step instead of
  asking again.

Repeat until it returns a completion rather than a request. Proceeding to Phase 3
on a `needs_input` return silently drops the decision the user was asked to make.

### Phase 3: App Creation/Selection

Read `genpage-plan.md` for the app decision and the `Solution` line in
`## Environment`.

**If "create new":**

```powershell
pac model create --name "App Name" --solution "<Solution unique name>" --publish
```

**`--solution` is mandatory.** `pac model create` errors out with
`"The given solution name is not valid: ()"` if you omit it — its claimed
"active solution" fallback does not work in practice.

**`--publish` is mandatory.** Without it the new appmodule stays in draft and
the genux runtime URL errors with "app not published".

- Use the plan's `Solution` value verbatim. The planner always writes one
  (default fallback is literally `Default`).
- If the plan is somehow missing `Solution`, pass `--solution Default` —
  every Dataverse env has a built-in "Default Solution" by that unique name.

Store the new app-id for Phase 6.

**If existing app-id:** Use it directly. `pac model create` is not called, so
the `Solution` line is informational only for this phase.

### Phase 4: Generate RuntimeTypes (Conditional)

If any page uses Dataverse entities, generate the TypeScript schema:

```powershell
pac model genpage generate-types --data-sources "entity1,entity2,..." --output-file <working-dir>/RuntimeTypes.ts
```

> **Windows + Bash**: Always use forward slashes in file paths (e.g., `D:/temp/RuntimeTypes.ts`).

After generating, read the RuntimeTypes.ts file to verify it generated correctly.

**For mock data pages only:** Skip this phase.

### Phase 4.5: Connector Bindings (Conditional)

**Re-probe the rollback gate here — do not rely on the plan content alone.** Connectors
are GA and the flag ships ON, so this normally passes; it exists so a plan authored
while the feature was on cannot deploy connectors after it has been turned off:

```powershell
node "${PLUGIN_ROOT}/scripts/lib/feature-flags.js" connectors
```

**If it prints `disabled`:** the outcome is `Connectors: none` **regardless of what the
plan's `## Connector Bindings` section says**. Skip the rest of this phase — do not
create or pass `connectors.json`, and do not add `--connectors` on upload. (Backstop:
`list-connections.js` / `create-connection-reference.js` also fail closed with exit 3.)

**If it prints `enabled`:** read the plan's `## Connector Bindings` section and treat it
as bindings **only when it contains an actual binding table** (a `| Logical Name | …`
header with at least one data row). If the section is `No connector bindings.`, empty,
missing, or malformed, the page has no connectors: skip this phase entirely — do not
create or pass `connectors.json`, and do not add `--connectors` on upload.

**Carry this decision into code generation.** The outcome is `Connectors: <n>
binding(s)` or `Connectors: none` for the rest of the run, and Phase 5 **must** pass
it verbatim in every page-builder dispatch — otherwise the generated page could call
a connector this run never binds, and the page fails at runtime instead of simply
omitting the feature. Note the dispatch value is the **binding count**, not the flag
state: a disabled gate and an empty binding table both produce `none`, because the
page-builder only ever needs to know how many bindings it may call.

When there are real bindings, the `genpage-connector-builder` agent already wrote
`<working-dir>/connectors.json` during planning — verify it exists and matches the
plan table. If it is missing, derive it from the plan table as a **bare JSON
array** (never the `{ "connectorBindings": [...] }` object wrapper — that is the
deployed page `config.json` shape that `pac` writes):

```json
[
  {
    "logicalName": "new_uxtest_sharepoint",
    "connectorId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline",
    "dataset": "https://host.sharepoint.com/sites/x",
    "tables": ["5709dd6f-c73e-4079-ad23-2334e45e0e13"],
    "tableDisplayNames": ["Pet"]
  },
  {
    "logicalName": "new_uxtest_msnweather",
    "connectorId": "/providers/Microsoft.PowerApps/apis/shared_msnweather",
    "dataset": "",
    "operations": ["CurrentWeather"]
  }
]
```

Do **not** write connection IDs into `connectors.json` — the importing maker/admin
fills env-specific `ConnectionId` values through solution deployment settings.

### Phase 4.6: Custom API Bindings (Conditional)

**Re-probe the feature gate here — do not rely on the plan content alone.** A plan
authored while the flag was ON must not deploy Custom API bindings after it is turned OFF:

```powershell
node "${PLUGIN_ROOT}/scripts/lib/feature-flags.js" custom-api
```

**If it prints `disabled`:** Custom API support is OFF. Skip this phase entirely — do not
create or pass `actions.json`, and never add `--actions` on upload — **regardless of what the
plan's `## Custom API Bindings` section says**. (Backstop: `list-custom-apis.js` also fails
closed with exit 3 if invoked while OFF.)

**If it prints `enabled`:** read the plan's `## Custom API Bindings` section and treat it as
bindings **only when it contains an actual binding table** (a `| Name | Kind | …` header with
at least one data row). If the section is `No custom API bindings.`, empty, missing, or
malformed, treat the page as having no Custom APIs and skip this phase.

When there are real bindings, the `genpage-customapi-builder` agent already wrote
`<working-dir>/actions.json` during planning — verify it exists and matches the plan table. If
it is missing, derive it as a **bare JSON array** of
`{ name, isFunction, boundEntityLogicalName?, displayName, parameterKinds }` entries (Action row
`isFunction:false`, Function `true`; `boundEntityLogicalName` only for an entity-bound, non-
`(Global)`, row) — see `${PLUGIN_ROOT}/references/custom-api.md`. Never the
`{ "actionBindings": [...] }` object wrapper (the deployed `config.json` shape `pac` writes).

### Phase 4.7: Page Telemetry (Conditional)

**Re-probe the feature gate here — do not rely on the plan content alone.**

```powershell
node "${PLUGIN_ROOT}/scripts/lib/feature-flags.js" custom-telemetry
```

This phase has no bindings and no artifacts; it only decides whether page-builder is
permitted to instrument. **If it prints `disabled`**, generated pages contain no
telemetry calls at all — identical to before the feature existed.

**Carry this decision into code generation.** The probe result is `Telemetry:
disabled` / `Telemetry: enabled` for the rest of the run, and Phase 5 **must** pass it
verbatim in every page-builder dispatch.

`enabled` is permission, not instruction. Even when it is on, page-builder emits
telemetry **only** when the maker asked to measure or track something in their own
words; the default output is still a page with zero telemetry. See
`${PLUGIN_ROOT}/references/page-telemetry.md`.

### Phase 5: Build Pages (Parallel)

Read `genpage-plan.md` and extract the pages table.

#### 5a. Validate the plan before dispatch

Before invoking any builders, verify:
- At least one page exists in the `## Pages` table
- Every page has a `### [Page Name]` subsection in `## Per-Page Specifications`
- **All filenames in the `## Pages` table are unique.** If any are duplicated,
  rewrite the plan appending `-1`, `-2`, etc. before dispatch. Duplicate filenames
  cause silent last-writer-wins data loss under parallel execution.

See `${PLUGIN_ROOT}/references/plan-schema.md` for the full contract.

#### 5b. Single-page fast path (skip Task dispatch when N=1)

**If the plan's Pages table contains exactly one row**, do NOT dispatch a Task
subagent. Inline the page-builder workflow directly in the orchestrator:

1. Read `${PLUGIN_ROOT}/references/rules.md`
2. Read the sample listed in the plan's `## Relevant Samples`
3. Only when the Phase 4.5 probe printed `enabled` **and** the plan's
   `## Connector Bindings` section contains an **actual binding table** (a
   `| Logical Name | …` header with at least one data row), also read
   `${PLUGIN_ROOT}/references/connectors.md`. Treat a `No connector bindings.`
   sentinel, an empty/missing/malformed section, **or a `disabled` probe** as
   having no connectors (same contract as Phase 4.5 and genpage-page-builder).
3b. Only when the plan's `## Custom API Bindings` section contains an **actual
   binding table** (a `| Name | Kind | …` header with at least one data row),
   also read `${PLUGIN_ROOT}/references/custom-api.md`. Treat a
   `No custom API bindings.` sentinel, or an empty/missing/malformed section, as
   having no Custom APIs (same contract as Phase 4.6 and genpage-page-builder).
4. If the plan's Per-Page Specification has `Needs caching: true`, also read
   `${PLUGIN_ROOT}/references/data-caching.md`
5. If the plan's `## Environment` indicates non-English languages, also read
   `${PLUGIN_ROOT}/references/localization.md`
5b. Only when the Phase 4.7 probe printed `enabled` **and** the maker's own request
   asks to measure, track, monitor, or diagnose something, also read
   `${PLUGIN_ROOT}/references/page-telemetry.md`. In every other case the page
   contains no telemetry calls — do not read it.
6. Read `genpage-plan.md` (already in working directory) and `RuntimeTypes.ts`
   if Data mode is dataverse
7. Write the `.tsx` file to `<working-dir>/<filename>.tsx` following all rules
8. After writing, Grep every named import from `@fluentui/react-icons` against
   `${PLUGIN_ROOT}/references/verified-icons.txt` (one Grep per name).
   Rewrite any unverified names with the closest verified alternative; do not
   load the full icon list into context
9. Grep the generated file with `['"]?borderWidth['"]?\s*:`. Griffel rejects
   that shorthand only at runtime; the regex catches unquoted, quoted, and
   whitespace-separated property syntax. Replace every match with the four
   explicit border-side widths before deployment.
10. Proceed to Phase 6

This saves ~5-15s of Task overhead and ~3K tokens that would otherwise be
duplicated in a subagent context.

#### 5c. Multi-page: invoke page-builders in parallel

**If the plan's Pages table contains 2+ rows**, invoke a `genpage-page-builder`
agent via the `Task` tool per page. **Fire all invocations in a single message**
for parallel execution.

For each page, pass a prompt that includes:

- Page name (e.g., "Candidate Tracker")
- Target file name (e.g., "candidate-tracker.tsx")
- Absolute path to `genpage-plan.md`
- Data mode (see below) — either a RuntimeTypes path or an explicit mock flag
- **Connectors: `none` or `<n> binding(s)`** — the Phase 4.5 outcome, verbatim
- **Telemetry: `enabled` or `disabled`** — the Phase 4.7 probe result, verbatim
- Working directory
- Plugin root: `${PLUGIN_ROOT}`

**For Dataverse pages**, include the RuntimeTypes line:

> You are the genpage-page-builder agent. Generate the **[Page Name]** page.
>
> - Target file: [filename].tsx
> - Plan document: [absolute path to genpage-plan.md]
> - Data mode: **dataverse**
> - Connectors: **[none|<n> binding(s) from Phase 4.5]**
> - Telemetry: **[enabled|disabled from Phase 4.7]**
> - RuntimeTypes: [absolute path to RuntimeTypes.ts]
> - Working directory: [absolute path from Phase 0]
> - Plugin root: ${PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Write [filename].tsx and return your
> result when done.

**For mock data pages**, omit the RuntimeTypes line and set `Data mode: mock`:

> You are the genpage-page-builder agent. Generate the **[Page Name]** page.
>
> - Target file: [filename].tsx
> - Plan document: [absolute path to genpage-plan.md]
> - Data mode: **mock**
> - Connectors: **[none|<n> binding(s) from Phase 4.5]**
> - Telemetry: **[enabled|disabled from Phase 4.7]**
> - Working directory: [absolute path from Phase 0]
> - Plugin root: ${PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Write [filename].tsx and return your
> result when done.

Wait for all page-builder tasks to complete before proceeding.

After the parallel workers return, confirm every target file exists. If a worker
reported missing declared file/process tools or produced no file, do not
re-dispatch that worker. Run the Phase 5b page-builder workflow inline for only
the failed page, preserving the same plan and dispatch inputs. Then Grep every
generated page with `['"]?borderWidth['"]?\s*:` and replace the unsupported
Griffel shorthand before Phase 6.

### Phase 6: Deploy

For each `.tsx` file produced, deploy to Power Apps.

If Phase 4.5 wrote `<working-dir>/connectors.json`, first pre-flight the active
PAC CLI:

```powershell
pac model genpage upload --help
```

The help output must contain `--connectors`. If it does not, stop and surface:
"connector deploy requires a pac build with `pac model genpage upload
--connectors` — build from PowerPlatform-Scale-AdminTools or update pac." Do
not silently drop bindings.

Connector deployment matrix:
- **Create (new page):** include `--connectors "<working-dir>/connectors.json"`
  with the first `upload --add-to-sitemap`.
- **Edit — connectors changed, added, or one removed:** write the full desired
  binding set to `connectors.json` and include `--connectors` with
  `upload --page-id <id>` (full replace).
- **Edit — no connector change:** omit `--connectors`; pac preserves existing
  bindings. Never pass a stale or empty file on an unrelated edit.
- **Delete all connectors:** write `[]` to `connectors.json` and pass
  `--connectors` so pac clears the page's `connectorBindings`.

If Phase 4.6 wrote `<working-dir>/actions.json`, pre-flight the same way — the upload `--help`
must contain `--actions`; if not, stop and surface "Custom API deploy requires a pac build with
`pac model genpage upload --actions` (PowerPlatform-Scale-AdminTools)." Don't silently drop bindings.

Custom API deployment follows the **identical matrix** as connectors, substituting
`--actions "<working-dir>/actions.json"` for `--connectors`: pass it on create; on an edit only
when bindings changed/added/removed (full replace); omit it on an unrelated edit (pac preserves
existing); write `[]` and pass it to clear all `actionBindings`.

**Deploy through `scripts/genpage-upload.js`, never by composing a raw `pac model genpage upload` command.** The script is a thin wrapper over the same upload path `/app-builder` uses: it hands the prompt and agent-message to pac **by file** (`--prompt-file`/`--agent-message-file`). A prompt is arbitrary user text — quotes, newlines, `%VAR%`, `&`, `|`, non-ASCII — and putting it on a command line means the shell gets to reinterpret it. That failed live with:

```text
Error: Not a valid command.
Parse failed on: Inspection
Was it quote wrapped? No, be sure to wrap values that contain spaces.
```

…for a prompt containing an ASCII-quoted multiword page name. **Never "fix" that by editing the approved prompt** (for example swapping in typographic quotes): the page would then be built from text the user never approved.

**Write the prompt and agent-message to files first**, then pass the paths:

```powershell
Set-Content -Path "<working-dir>/prompt.txt"        -Value $prompt        -Encoding UTF8 -NoNewline
Set-Content -Path "<working-dir>/agent-message.txt" -Value $agentMessage  -Encoding UTF8 -NoNewline
```

**Log the invocation into `workflow-log.md` under a `## Phase 6 — Deploy` section before running it.** Record the flags and the prompt-file path, plus the prompt's scope, so the approved text is preserved semantically without embedding arbitrary text as an executable command. Format:

```markdown
## Phase 6 — Deploy
- Command: `node scripts/genpage-upload.js --app-id <id> --code-file <path> --data-sources '<entities>' --prompt-file <working-dir>/prompt.txt --model <model-id> --name "<page name>" --agent-message-file <working-dir>/agent-message.txt --add-to-sitemap`
- Prompt scope: full page description from plan's `## User Requirements` (create) — or the delta only (update)
- Result: page-id = <returned-id>, status = success
```

When present, the logged command must also include `--connectors "<working-dir>/connectors.json"`
and/or `--actions "<working-dir>/actions.json"`.

#### Prompt semantics

- **First upload** (`--add-to-sitemap`, no `--page-id`): full page description
  from plan's `## User Requirements`.
- **Any subsequent upload** (`--page-id`, no `--add-to-sitemap`): delta only —
  the changes in this upload, written like a commit message, never a
  re-statement of the original.

`--add-to-sitemap` is refused together with `--page-id` by the wrapper itself, so an
update cannot add a second sitemap entry even if the flag is passed by mistake.

Applies in Phase 6 updates, Phase 6.5 PAGEREF re-uploads, Phase 7.5 fix
re-deploys, and the entire edit flow.

#### For Dataverse entity pages (first upload — create):

```powershell
node "${PLUGIN_ROOT}/scripts/genpage-upload.js" `
  --env <org-url> `
  --app-id <app-id> `
  --code-file <working-dir>/<file>.tsx `
  --name "Page Display Name" `
  --data-sources "entity1,entity2" `
  --connectors "<working-dir>/connectors.json" `
  --actions "<working-dir>/actions.json" `
  --prompt-file "<working-dir>/prompt.txt" `
  --model "<current-model-id>" `
  --agent-message-file "<working-dir>/agent-message.txt" `
  --add-to-sitemap
```

Omit the `--connectors` line when Phase 4.5 did not write `connectors.json`, and the
`--actions` line when Phase 4.6 did not write `actions.json`.

**For mock data pages:** Same but omit `--data-sources`.

#### For updating existing pages (subsequent upload):

Use `--page-id`, omit `--add-to-sitemap`, and **scope the prompt to the delta only**:

```powershell
node "${PLUGIN_ROOT}/scripts/genpage-upload.js" `
  --env <org-url> `
  --app-id <app-id> `
  --page-id <page-id> `
  --code-file <working-dir>/<file>.tsx `
  --data-sources "entity1,entity2" `
  --connectors "<working-dir>/connectors.json" `
  --actions "<working-dir>/actions.json" `
  --prompt-file "<working-dir>/prompt.txt" `
  --model "<current-model-id>" `
  --agent-message-file "<working-dir>/agent-message.txt"
```

For updates, include the `--connectors` line only when this upload intentionally
replaces or clears connector bindings; otherwise omit it to preserve the
deployed page's current bindings. The same rule applies to `--actions` for Custom
API bindings: include it only when this upload intentionally replaces or clears them.

### Phase 6.5: Navigation Fix-Up (Multi-Page Only)

Runs only when the plan has 2+ pages AND any built `.tsx` contains a `PAGEREF_`
token. Page-builders emit `pageId: "PAGEREF_<filename-without-tsx>"` as a
placeholder because GUIDs don't exist until after Phase 6 (see Rule 13). This
phase substitutes the real GUIDs.

#### Steps

1. Build `filename-without-tsx → page-id` map from Phase 6 upload output.
2. **Sort keys by length descending** so `PAGEREF_pet` can't match inside
   `PAGEREF_pet-gallery`.
3. For each `.tsx` in `<working-dir>/*.tsx` (top level only, no recursion),
   replace every quoted `"PAGEREF_<name>"` (must be in double quotes — that's
   the format page-builders emit) with `"<page-id-guid>"`.
4. If a placeholder doesn't match any map key (typo, missing sibling), stop
   and report — never silently ship the literal string.
5. Re-upload only the files that had at least one replacement. Use the update form
   of `scripts/genpage-upload.js` (`--page-id`, no `--add-to-sitemap`). Per the
   "Prompt semantics" rule in Phase 6, this is an **update**, so the prompt
   describes the delta only — not the original page description:

   ```powershell
   Set-Content -Path "<working-dir>/prompt.txt" -Encoding UTF8 -NoNewline `
     -Value "Resolve cross-page navigation placeholders to real page GUIDs (post-deploy fix-up)"
   Set-Content -Path "<working-dir>/agent-message.txt" -Encoding UTF8 -NoNewline `
     -Value "Replaced PAGEREF_<name> tokens with actual page IDs returned by Phase 6"

   node "${PLUGIN_ROOT}/scripts/genpage-upload.js" `
     --env <org-url> `
     --app-id <app-id> `
     --page-id <page-id-from-Phase-6> `
     --code-file <working-dir>/<file>.tsx `
     --data-sources "entity1,entity2" `
     --prompt-file "<working-dir>/prompt.txt" `
     --model "<current-model-id>" `
     --agent-message-file "<working-dir>/agent-message.txt"
   ```

Pages with no `PAGEREF_` strings need no second upload.

### Phase 6.7: Solution Packaging (ALM, optional)

Runs only when the plan's `## Solution Packaging` has `Package into solution: true`.
Adds the deployed app, the GenPage(s), and any connection references to the
target solution so they travel cross-environment.

1. Ensure the solution exists — create it only if it doesn't already exist:
   `node ${PLUGIN_ROOT}/scripts/provision-solution.js <envUrl> <solutionUniqueName> "<Friendly Name>" [--publisher <uniqueName>]`
   It prints `{ "ok": true, "solutionId": …, "uniqueName": …, "publisherPrefix": … }`;
   `uniqueName` must start with a letter and contain only letters, digits, and
   underscores. Without `--publisher` it resolves the environment's default publisher.
2. Add the app + GenPage(s) + connection references (pass the page-id(s) returned
   by Phase 6 as `--page-ids` — the GenPage is added explicitly, it does NOT travel
   with the app on its own):
   `node ${PLUGIN_ROOT}/scripts/add-page-to-solution.js <envUrl> <solutionUniqueName> <app-id> --page-ids "<page-id1,page-id2>" --connection-refs "<logicalName1,logicalName2>"`
3. Log the command + result to `workflow-log.md`.

Cross-env note: the app (80) pulls the sitemap (62); the GenPage
`uxagentproject` is added explicitly and pulls its `uxagentprojectfile` rows
(including `config.json` with `connectorBindings`); each `connectionreference`
is added so bindings resolve. The script discovers both custom-table component
types from `EntityDefinitions(...).ObjectTypeCode` in the target environment —
their numeric values are environment-specific and must never be hardcoded. At import the
deployer supplies env-specific `ConnectionId` per connection reference via
`pac solution create-settings` + `pac solution import --settings-file`.

Custom API bindings need **no** extra ALM step: `config.json`'s `actionBindings` travels
automatically in the `uxagentprojectfile` rows already pulled with the GenPage. The
referenced Custom APIs are a separate deployment prerequisite (bound by `name`), not added here.

### Phase 7: Verify in Browser (Optional)

After successful deployment, ask the user via `AskUserQuestion`:
> "Would you like to verify the page(s) in the browser using Playwright?"

Options: **Yes, verify in browser** / **Skip verification**

- If the user picks **Skip verification** → jump to Phase 8.
- If the user picks **Yes** → read `${PLUGIN_ROOT}/skills/genpage/verify-flow.md`
  for the full Playwright verification workflow (navigate, structural
  verification including below-the-fold, interactive testing, screenshots,
  fix-and-redeploy). The orchestrator only loads that file on demand to keep
  context lean when verification is skipped.

### Phase 8: Summary

By Phase 8 the `workflow-log.md` should already contain Phase 0 through Phase 7
sections written incrementally — the planner writes Phase 1 inside its agent
context, you (the orchestrator) write Phase 0 / 0.5 / 3 / 4 / 6 / 6.5 / 7 as
each runs, and the entity-builder and page-builder agents append their own
Phase 2 / 5 sections when invoked.

In Phase 8, append a final `## Phase 8 — Summary` section to the same file:

```markdown
## Phase 8 — Summary

| Page | File | Entities | Status |
|------|------|----------|--------|
| <Name> | <file>.tsx | <entities or "mock data"> | Deployed |

- App: <name> (<app-id>)
- Entities created: <list, or "none">
- Browser verification: <skipped | confirmed | failed: <reason>>
```

The log MUST contain command-level entries for every prereq / auth / question /
upload / script invocation — not just outcome summaries. The eval harness greps
the log for tokens like `node --version`, `pac auth list`, `AskUserQuestion`,
`EnterPlanMode`, `--prompt`, `check-auth.js`, etc. A decision-only log
(e.g., `Decision: new page` without the underlying `AskUserQuestion`) will
fail Layer 1 assertions even when the agent's behavior was correct.

Then present a final summary to the user:

```
## Genpage Complete

| Page | File | Entities | Status |
|------|------|----------|--------|
| [Name] | [file].tsx | [entities or "mock data"] | Deployed |

App: [app name] ([app-id])
Screenshots: [if verification was done]
Next steps: Share with team, iterate on design, create additional pages
```


---

## Edit Flow

For the edit flow (triggered when the `genpage-planner` returns
`{ "action": "edit" }`), see [edit-flow.md](edit-flow.md) in this folder.

The edit flow has its own 8 phases (Edit Phase 1-8): discover and select target
app + page via `pac model list` + `pac model genpage list`, download, generate
RuntimeTypes if needed, invoke `genpage-edit-planner`, apply the edit inline,
deploy, verify, summarize.
