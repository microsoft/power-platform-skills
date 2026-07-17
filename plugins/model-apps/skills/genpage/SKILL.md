---
name: genpage
version: 2.2.0
description: Creates, updates, and deploys Power Apps generative pages for model-driven apps using React v17, TypeScript, and Fluent UI V9. Orchestrates specialist agents for planning, entity creation, and code generation. Use it when user asks to build, retrieve, or update a page in an existing Microsoft Power Apps model-driven app. Use it when user mentions "generative page", "page in a model-driven", or "genux".
author: Microsoft Corporation
argument-hint: "<page description> | edit"
user-invocable: true
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
---

# Power Apps Generative Pages Builder

**Triggers:** genpage, generative page, create genpage, genux page, build genux, power apps page, model page
**Keywords:** power apps, generative pages, genux, model-driven, dataverse, react, fluent ui, pac cli
**Aliases:** /genpage, /gen-page, /genux

## Overview

This skill orchestrates four specialist agents across the create and edit flows:

**Create flow:**
1. **`genpage-planner`** — validates prerequisites, gathers requirements, detects what
   entities and apps exist, presents a plan for approval, writes `genpage-plan.md`
2. **`genpage-entity-builder`** — creates Dataverse entities (tables, columns,
   relationships, choices, sample data) via the plugin's Node.js Web API scripts
3. **`genpage-page-builder`** — generates one complete `.tsx` file per page; multiple
   builders run in parallel for multi-page requests

**Edit flow:**

4. **`genpage-edit-planner`** — reads the downloaded page artifacts, gathers change
   requirements, presents an edit plan, writes `genpage-edit-plan.md`

You (the skill) coordinate the agents and own app creation, RuntimeTypes generation,
deployment, browser verification, and the inline application of planned edits.

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
3. Create the folder: `mkdir -p <folder-name>`
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

> **⚠️ CRITICAL — you MUST invoke `genpage-planner` via the `Task` tool. You MUST
> NOT inline the planner's questions yourself with `AskUserQuestion`.**
>
> The planner is not optional or skippable. It runs:
> 1. Prerequisite validation (`node --version`, `pac help` version >= 2.7.0)
> 2. Auth verification (`pac auth list`, environment selection)
> 3. The structured "Create new / Edit existing" question (via `AskUserQuestion`
>    inside the planner subagent, not here)
> 4. Language detection (`pac model list-languages`) — only on new-page path
> 5. Entity existence detection (`pac model list-tables --search`)
> 6. App detection (`pac model list`) with proper selection prompts
> 7. Plan-mode presentation and approval
> 8. Writes `genpage-plan.md` to the working directory
>
> Reasons to **NEVER** ask "new or edit?" yourself before invoking the planner:
> - You would skip prereq + auth (the planner is the only thing that runs them)
> - The structured question gives the user labeled options; an inline free-text
>   prompt forces them to guess
> - The planner returns `{ "action": "edit" }` as a contract — your inline
>   question can't produce that signal cleanly
>
> Even if `$ARGUMENTS` looks like it tells you the intent, **still invoke the
> planner**. Pass the intent in the prompt — the planner uses it to skip its
> own Question 1 if appropriate, but the prereq/auth/env steps still run.

#### Steps

1. Invoke `genpage-planner` via `Task` with the prompt below.
2. Wait for it to finish (it returns a summary).
3. If the return includes `{ "action": "edit" }`, jump to the **Edit Flow** section.
4. Otherwise the planner has written `genpage-plan.md`. Proceed to Phase 2.

#### Invocation prompt

Pass a prompt that includes:

- The user's requirements: `$ARGUMENTS`
- The working directory (absolute path from Phase 0)
- The plugin root path: `${PLUGIN_ROOT}`

Example:

> You are the genpage-planner agent. Plan generative page(s) for the following requirements:
>
> [paste $ARGUMENTS here verbatim, or "no arguments provided — gather from user"]
>
> Working directory: [absolute path from Phase 0]
> Plugin root: ${PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Validate prereqs, confirm auth, ask
> the new/edit question via AskUserQuestion, then proceed accordingly. Write
> genpage-plan.md to the working directory if creating. Return the page list,
> entity status, app selection, and any `{ "action": "edit" }` signal when complete.

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
node "${PLUGIN_ROOT}/scripts/check-auth.js"
```

It returns a single JSON object:

```json
{
  "ok": true | false,
  "blocker": null | "az_missing" | "az_not_logged_in" | "pac_not_logged_in"
                 | "no_env_url" | "whoami_403" | "whoami_401" | "whoami_error",
  "message": "human-readable next step",
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
`<working-dir>/entity-creation-log.md` for recovery on failure.

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

**Re-probe the feature gate here — do not rely on the plan content alone.** A plan
authored while the flag was ON must not deploy connectors after it is turned OFF:

```powershell
node "${PLUGIN_ROOT}/scripts/lib/feature-flags.js" connectors
```

**If it prints `disabled`:** connectors are OFF. Skip this phase entirely — do not
create or pass `connectors.json`, and never add `--connectors` on upload —
**regardless of what the plan's `## Connector Bindings` section says**. (Backstop:
`list-connections.js` / `create-connection-reference.js` also fail closed with
exit 3 if invoked while OFF.)

**If it prints `enabled`:** read the plan's `## Connector Bindings` section and
treat it as bindings **only when it contains an actual binding table** (a
`| Logical Name | …` header with at least one data row). If the section is
`No connector bindings.`, empty, missing, or malformed, treat the page as having
no connectors and skip this phase.

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
3. Only when the plan's `## Connector Bindings` section contains an **actual
   binding table** (a `| Logical Name | …` header with at least one data row),
   also read `${PLUGIN_ROOT}/references/connectors.md`. Treat a
   `No connector bindings.` sentinel, or an empty/missing/malformed section, as
   having no connectors (same contract as Phase 4.5 and genpage-page-builder).
4. If the plan's Per-Page Specification has `Needs caching: true`, also read
   `${PLUGIN_ROOT}/references/data-caching.md`
5. If the plan's `## Environment` indicates non-English languages, also read
   `${PLUGIN_ROOT}/references/localization.md`
6. Read `genpage-plan.md` (already in working directory) and `RuntimeTypes.ts`
   if Data mode is dataverse
7. Write the `.tsx` file to `<working-dir>/<filename>.tsx` following all rules
8. After writing, Grep every named import from `@fluentui/react-icons` against
   `${PLUGIN_ROOT}/references/verified-icons.txt` (one Grep per name).
   Rewrite any unverified names with the closest verified alternative; do not
   load the full icon list into context
9. Proceed to Phase 6

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
- Working directory
- Plugin root: `${PLUGIN_ROOT}`

**For Dataverse pages**, include the RuntimeTypes line:

> You are the genpage-page-builder agent. Generate the **[Page Name]** page.
>
> - Target file: [filename].tsx
> - Plan document: [absolute path to genpage-plan.md]
> - Data mode: **dataverse**
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
> - Working directory: [absolute path from Phase 0]
> - Plugin root: ${PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Write [filename].tsx and return your
> result when done.

Wait for all page-builder tasks to complete before proceeding.

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

**Copy the upload commands below exactly — `--app-id`, `--code-file`, `--prompt`, `--agent-message` are all required and must use these exact flag names.**

**Log the full command verbatim into `workflow-log.md` under a `## Phase 6 — Deploy` section before invoking it.** Including `--prompt` and all other flags. The eval harness greps the log for these tokens — a terse summary like `Command: pac model genpage upload --add-to-sitemap` will fail the `--prompt scoping` assertion. Format:

```markdown
## Phase 6 — Deploy
- Command: `pac model genpage upload --app-id <id> --code-file <path> --data-sources '<entities>' --prompt "<full prompt>" --model <model-id> --name "<page name>" --agent-message "<description>" --add-to-sitemap`
- Result: page-id = <returned-id>, status = success
```

When connector bindings are present, the logged command must also include
`--connectors "<working-dir>/connectors.json"`.

#### `--prompt` semantics

- **First upload** (`--add-to-sitemap`, no `--page-id`): full page description
  from plan's `## User Requirements`.
- **Any subsequent upload** (`--page-id`, no `--add-to-sitemap`): delta only —
  the changes in this upload, written like a commit message, never a
  re-statement of the original.

Applies in Phase 6 updates, Phase 6.5 PAGEREF re-uploads, Phase 7.5 fix
re-deploys, and the entire edit flow.

#### For Dataverse entity pages (first upload — create):

```powershell
pac model genpage upload `
  --app-id <app-id> `
  --code-file <working-dir>/<file>.tsx `
  --name "Page Display Name" `
  --data-sources "entity1,entity2" `
  --connectors "<working-dir>/connectors.json" `
  --prompt "<Full page description from plan's ## User Requirements>" `
  --model "<current-model-id>" `
  --agent-message "Description of what was built and any relevant details" `
  --add-to-sitemap
```

Omit the `--connectors` line when Phase 4.5 did not write `connectors.json`.

**For mock data pages:** Same but omit `--data-sources`.

#### For updating existing pages (subsequent upload):

Use `--page-id`, omit `--add-to-sitemap`, and **scope `--prompt` to the delta only**:

```powershell
pac model genpage upload `
  --app-id <app-id> `
  --page-id <page-id> `
  --code-file <working-dir>/<file>.tsx `
  --data-sources "entity1,entity2" `
  --connectors "<working-dir>/connectors.json" `
  --prompt "<Only the changes in this upload, e.g. 'Add a search box and sort by company name'>" `
  --model "<current-model-id>" `
  --agent-message "Description of what was changed in this upload"
```

For updates, include the `--connectors` line only when this upload intentionally
replaces or clears connector bindings; otherwise omit it to preserve the
deployed page's current bindings.

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
   of `pac model genpage upload` (`--page-id`, no `--add-to-sitemap`). Per the
   "`--prompt` semantics" rule in Phase 6, this is an **update**, so `--prompt`
   describes the delta only — not the original page description:

   ```powershell
   pac model genpage upload `
     --app-id <app-id> `
     --page-id <page-id-from-Phase-6> `
     --code-file <working-dir>/<file>.tsx `
     --data-sources "entity1,entity2" `
     --prompt "Resolve cross-page navigation placeholders to real page GUIDs (post-deploy fix-up)" `
     --model "<current-model-id>" `
     --agent-message "Replaced PAGEREF_<name> tokens with actual page IDs returned by Phase 6"
   ```

Pages with no `PAGEREF_` strings need no second upload.

### Phase 6.7: Solution Packaging (ALM, optional)

Runs only when the plan's `## Solution Packaging` has `Package into solution: true`.
Adds the deployed app, the GenPage(s), and any connection references to the
target solution so they travel cross-environment.

1. Ensure the solution exists (create via `scripts/create-solution.js` if needed).
2. Add the app + GenPage(s) + connection references (pass the page-id(s) returned
   by Phase 6 as `--page-ids` — the GenPage is added explicitly, it does NOT travel
   with the app on its own):
   `node ${PLUGIN_ROOT}/scripts/add-page-to-solution.js <envUrl> <solutionUniqueName> <app-id> --page-ids "<page-id1,page-id2>" --connection-refs "<logicalName1,logicalName2>"`
3. Log the command + result to `workflow-log.md`.

Cross-env note (verified 2026-07-10): the app (80) pulls the sitemap (62); the
GenPage `uxagentproject` (10372) is added explicitly and pulls its
`uxagentprojectfile` rows (10373, incl. `config.json` with `connectorBindings`);
each `connectionreference` (10158) is added so bindings resolve. At import the
deployer supplies env-specific `ConnectionId` per connection reference via
`pac solution create-settings` + `pac solution import --settings-file`.

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
