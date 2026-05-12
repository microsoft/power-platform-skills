---
name: genpage
version: 2.0.0
description: Creates, updates, and deploys Power Apps generative pages for model-driven apps using React v17, TypeScript, and Fluent UI V9. Orchestrates specialist agents for planning, entity creation, and code generation. Use it when user asks to build, retrieve, or update a page in an existing Microsoft Power Apps model-driven app. Use it when user mentions "generative page", "page in a model-driven", or "genux".
author: Microsoft Corporation
argument-hint: "[optional: page description or 'deploy' or 'update']"
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
   relationships, choices, sample data) using the Dataverse Skills plugin
3. **`genpage-page-builder`** — generates one complete `.tsx` file per page; multiple
   builders run in parallel for multi-page requests

**Edit flow:**

4. **`genpage-edit-planner`** — reads the downloaded page artifacts, gathers change
   requirements, presents an edit plan, writes `genpage-edit-plan.md`

You (the skill) coordinate the agents and own app creation, RuntimeTypes generation,
deployment, browser verification, and the inline application of planned edits.

## References

- **Code generation rules**: [genpage-rules-reference.md](../../references/genpage-rules-reference.md)
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

### Phase 1: Plan

Invoke the `genpage-planner` agent using the `Task` tool. The planner asks the user
whether they want to create new pages or edit an existing one — **do NOT pre-infer
the intent from the prompt**. The planner is the single source of truth for new/edit
disambiguation.

If the planner returns `{ "action": "edit" }`, skip Phases 2-8 and go directly to
the **Edit Flow** section below.

Pass a prompt that includes:

- The user's requirements: `$ARGUMENTS`
- The working directory (absolute path from Phase 0)
- The plugin root path: `${CLAUDE_PLUGIN_ROOT}`

Example prompt:

> You are the genpage-planner agent. Plan generative page(s) for the following requirements:
>
> [paste $ARGUMENTS here]
>
> Working directory: [absolute path from Phase 0]
> Plugin root: ${CLAUDE_PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Write genpage-plan.md to the working
> directory. Return the page list, entity status, and app selection when complete.

**Wait for the planner to finish.** The planner will present the plan to the user via
plan mode and wait for approval before returning. Do not proceed to Phase 2 until the
planner task completes successfully.

**If the planner returns `{ "action": "edit" }`:** The user chose to edit an existing
page. Skip to the **Edit Flow** section below.

### Phase 2: Create Entities (Conditional)

Read `genpage-plan.md` from the working directory. Check the **Entity Creation Required**
section.

**If the section literally says "No entity creation required — all entities already exist":**
Skip to Phase 3.

**If entities need creating:**

#### 2a. Probe Dataverse plugin availability

Before invoking the entity-builder, verify the Dataverse Skills plugin is both
**installed** AND **connected**. Try calling the Dataverse MCP `list_tables` tool:

- **If the tool is not available** (not installed): Tell the user exactly this:
  > "Entity creation requires the Dataverse Skills plugin. Install it from
  > `microsoft/Dataverse-skills`, then retry."
  Stop the workflow — do NOT invoke the entity-builder.

- **If the tool is available but call fails with auth/connection error** (installed but not connected):
  > "The Dataverse Skills plugin is installed but not connected to this environment.
  > Run `/dv-connect` to configure authentication, then retry."
  Stop the workflow — do NOT invoke the entity-builder.

- **If the call succeeds:** The plugin is installed and connected. Proceed to 2b.

#### 2b. Invoke entity-builder

Invoke the `genpage-entity-builder` agent via the `Task` tool. Pass:
- Path to `genpage-plan.md`
- Working directory

Wait for completion.

### Phase 3: App Creation/Selection

Read `genpage-plan.md` for the app decision:

**If "create new":**
```powershell
pac model create --name "App Name"
```
Store the new app-id for Phase 6.

**If existing app-id:** Use it directly.

### Phase 4: Generate RuntimeTypes (Conditional)

If any page uses Dataverse entities, generate the TypeScript schema:

```powershell
pac model genpage generate-types --data-sources "entity1,entity2,..." --output-file <working-dir>/RuntimeTypes.ts
```

> **Windows + Bash**: Always use forward slashes in file paths (e.g., `D:/temp/RuntimeTypes.ts`).

After generating, read the RuntimeTypes.ts file to verify it generated correctly.

**For mock data pages only:** Skip this phase.

<!-- Phase 4.5 (npm install + extract icon list) has been removed.
     A pre-generated `references/verified-icons.txt` ships with the plugin.
     Page-builders read it directly from ${CLAUDE_PLUGIN_ROOT}/references/verified-icons.txt — no runtime install needed.
     To refresh after bumping @fluentui/react-icons: run scripts/regenerate-verified-icons.js. -->


### Phase 5: Build Pages (Parallel)

Read `genpage-plan.md` and extract the pages table.

#### 5a. Validate the plan before dispatch

Before invoking any builders, verify:
- At least one page exists in the `## Pages` table
- Every page has a `### [Page Name]` subsection in `## Per-Page Specifications`
- **All filenames in the `## Pages` table are unique.** If any are duplicated,
  rewrite the plan appending `-1`, `-2`, etc. before dispatch. Duplicate filenames
  cause silent last-writer-wins data loss under parallel execution.

See `${CLAUDE_PLUGIN_ROOT}/references/genpage-plan-schema.md` for the full contract.

#### 5b. Invoke page-builders in parallel

For each page, invoke a `genpage-page-builder` agent via the `Task` tool. **Fire all
invocations in a single message** for parallel execution.

For each page, pass a prompt that includes:

- Page name (e.g., "Candidate Tracker")
- Target file name (e.g., "candidate-tracker.tsx")
- Absolute path to `genpage-plan.md`
- Data mode (see below) — either a RuntimeTypes path or an explicit mock flag
- Working directory
- Plugin root: `${CLAUDE_PLUGIN_ROOT}`

**For Dataverse pages**, include the RuntimeTypes line:

> You are the genpage-page-builder agent. Generate the **[Page Name]** page.
>
> - Target file: [filename].tsx
> - Plan document: [absolute path to genpage-plan.md]
> - Data mode: **dataverse**
> - RuntimeTypes: [absolute path to RuntimeTypes.ts]
> - Working directory: [absolute path from Phase 0]
> - Plugin root: ${CLAUDE_PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Write [filename].tsx and return your

**For mock data pages**, omit the RuntimeTypes line and set `Data mode: mock`:

> You are the genpage-page-builder agent. Generate the **[Page Name]** page.
>
> - Target file: [filename].tsx
> - Plan document: [absolute path to genpage-plan.md]
> - Data mode: **mock**
> - Working directory: [absolute path from Phase 0]
> - Plugin root: ${CLAUDE_PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Write [filename].tsx and return your
> result when done.

Wait for all page-builder tasks to complete before proceeding.

### Phase 6: Deploy

For each `.tsx` file produced, deploy to Power Apps.

**Copy the upload commands below exactly — `--app-id`, `--code-file`, `--prompt`, `--agent-message` are all required and must use these exact flag names.**

**For Dataverse entity pages:**

```powershell
pac model genpage upload `
  --app-id <app-id> `
  --code-file <working-dir>/<file>.tsx `
  --name "Page Display Name" `
  --data-sources "entity1,entity2" `
  --prompt "User's original request summary" `
  --model "<current-model-id>" `
  --agent-message "Description of what was built and any relevant details" `
  --add-to-sitemap
```

**For mock data pages:** Same but omit `--data-sources`.

**For updating existing pages:** Use `--page-id`, omit `--add-to-sitemap`:

```powershell
pac model genpage upload `
  --app-id <app-id> `
  --page-id <page-id> `
  --code-file <working-dir>/<file>.tsx `
  --data-sources "entity1,entity2" `
  --prompt "User's original request summary" `
  --model "<current-model-id>" `
  --agent-message "Description of what was built and any relevant details"
```

### Phase 6.5: Navigation Fix-Up

Page-builders write `PAGEREF_<filename-without-tsx>` as a placeholder wherever they
navigate to a sibling generative page — because GUIDs don't exist until after first
upload. This phase replaces all placeholders with the real GUIDs returned by Phase 6.

**Why a second pass is required:** Pages are built in parallel before any GUIDs exist.
The placeholders let code generation proceed correctly; this phase resolves them.

1. Build a map of `filename-without-tsx → page-id` from the Phase 6 upload output:
   ```
   pet-gallery  → 3643e240-b589-4862-bf37-8347f388044b
   pet-detail   → 8dab5cd4-c861-40a8-a970-291e4f047eb7
   ...
   ```

2. For each `.tsx` file in the working directory, scan for any `"PAGEREF_<name>"` string.

3. For each match, replace with the corresponding real GUID from the map.

4. Re-upload only the files that had at least one replacement, using `--page-id`
   (update, not create) and omitting `--add-to-sitemap`.

Pages with no `PAGEREF_` strings need no second upload.

### Phase 7: Verify in Browser (Optional)

After successful deployment, ask the user (use `AskUserQuestion`):
> "Would you like to verify the page(s) in the browser using Playwright?"

Options: **Yes, verify in browser** / **Skip verification**

If the user chooses to skip, go directly to Phase 8.

If the user chooses to verify:

#### 7.1 Navigate and Authenticate

Construct the URL from the environment base URL, app-id, and page-id returned by upload:

```
https://<env>.crm.dynamics.com/main.aspx?appid=<app-id>&pagetype=genux&id=<page-id>
```

1. Use `browser_navigate` to open the constructed URL
2. If you get a "page closed" or "browser closed" error, retry navigation once
3. Use `browser_snapshot` to capture the page state. Always snapshot before any clicks
4. If a sign-in page appears, use `browser_click` on the sign-in option, then `browser_wait_for`
5. Use `browser_wait_for` for the genux page content to render

#### 7.2 Structural Verification (Including Below-the-Fold Content)

Take an initial `browser_snapshot` to capture above-the-fold content.

**Check whether the page extends beyond the viewport:**

```javascript
browser_evaluate(() => ({
  scrollHeight: document.documentElement.scrollHeight,
  clientHeight: document.documentElement.clientHeight
}))
```

**If `scrollHeight > clientHeight`, the page has content below the fold.** Scroll
through to verify all sections render:

1. Scroll to the bottom:
   ```javascript
   browser_evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
   ```
2. Take a fresh `browser_snapshot` to capture below-the-fold content
3. For very tall pages (e.g., long lists, multi-section dashboards), scroll
   incrementally and snapshot each section:
   ```javascript
   browser_evaluate(() => window.scrollBy(0, window.innerHeight))
   ```
4. Use `browser_take_screenshot` at each scroll position if you want visual capture
   of the full page

Verify that all expected DOM elements (per the table below) are present somewhere
on the page — not just in the initial above-the-fold snapshot.

| Page Type | Expected Elements |
|-----------|-------------------|
| Data Grid | Table/grid element with column headers and data rows |
| Form / Wizard | Form fields (inputs, dropdowns) and Next/Back buttons |
| CRUD | Data grid + action buttons (Add, Edit, Delete) |
| Dashboard | Multiple sections/panels with headings |
| Card Layout | Card containers with content |
| File Upload | File input or drop zone element |
| Navigation Sidebar | Nav element with menu items |

**Scroll back to the top before interactive testing:**
```javascript
browser_evaluate(() => window.scrollTo(0, 0))
```

#### 7.3 Interactive Testing

Test interactions based on the page type. **Always take a fresh `browser_snapshot` before each click.** Move on after 2 failed attempts per interaction.

| Page Type | Test Action | Expected Result |
|-----------|-------------|-----------------|
| Data Grid | Click a column header | Sort order changes |
| Form / Wizard | Click Next button | Step advances |
| CRUD | Click Add/New button | Form or dialog appears |
| Dashboard | Click a tab or section toggle | Content area updates |
| Card Layout | Click a card action button | Card responds |
| Navigation Sidebar | Click a menu item | Content area updates |

**Skip these:** Dataverse data mutations, file upload dialogs, complex form validation, pagination.

#### 7.4 Visual Confirmation

Use `browser_take_screenshot` to capture the page in its final verified state.

For pages taller than the viewport, capture multiple screenshots by scrolling:
take one at the top (`window.scrollTo(0, 0)`), one or more at intermediate scroll
positions for long pages, and one at the bottom
(`window.scrollTo(0, document.documentElement.scrollHeight)`). This gives a complete
visual record for the deployment summary.

#### 7.5 Fix and Re-deploy

If issues are found: fix the code, re-deploy (Phase 6), repeat verification.

**Common Playwright issues:**
- "Target page, context or browser has been closed" → retry the navigation
- "Ref not found" → take a fresh `browser_snapshot` before clicking any element
- Sign-in required → user must sign in manually first

### Phase 8: Summary

Write a `workflow-log.md` file to the working directory summarizing the run:
agents invoked, commands executed, decisions made, files produced. This log is
useful for debugging and required by the eval harness.

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

Triggered when the `genpage-planner` returns `{ "action": "edit" }` in Phase 1.
The edit flow delegates planning to `genpage-edit-planner`, then applies the
edit inline.

> **⚠️ CRITICAL — do NOT hallucinate app or page names.** App names and page
> names are discovered by running `pac model list` and `pac model genpage list
> --app-id <id>`. Never guess them from the repo, the conversation context,
> sample app names, or anywhere else. Always run the commands first, then
> present what the commands returned to the user.

### Edit Phase 1: Discover and Select Target App + Page

The planner has already validated prereqs and confirmed auth.

**CRITICAL — never guess or invent app names or page names.** You must discover
them by running the PAC CLI commands below. Hallucinating page names from context
(repo names, prior conversation, sample apps) is wrong and confuses the user.

#### 1a. Discover available apps

```powershell
pac model list
```

This returns the list of model-driven apps in the active environment. Parse the
output for **App ID**, **Display Name**, and **Unique Name** fields.

Behavior by app count:
- **0 apps:** Tell the user "No model-driven apps found in this environment.
  You can't edit a page that doesn't exist — would you like to create one
  instead?" and stop the edit flow.
- **1 app:** Confirm with the user: "Found app **[Display Name]** ([app-id]).
  Use this one?" via `AskUserQuestion` with Yes / Cancel options.
- **N apps:** Present a multi-choice question via `AskUserQuestion`. Each option's
  label is the app's **Display Name** (truncate to <50 chars). The description
  includes the app-id GUID. Always include an "Other" option for the user to
  type an app-id or name directly.

Record the selected `<app-id>`.

#### 1b. Discover existing pages in the selected app

```powershell
pac model genpage list --app-id <app-id>
```

This returns the list of generative pages already deployed in the selected app,
including **Page ID** and display name.

Behavior by page count:
- **0 pages:** Tell the user "This app has no generative pages to edit. Did
  you mean to create a new page?" and stop the edit flow.
- **1+ pages:** Present them via `AskUserQuestion`. Each option's label is the
  page's display name; the description includes the page-id GUID.

Record the selected `<page-id>`.

#### 1c. Confirm selection

Restate the selection to the user before proceeding:

> "Editing **[page display name]** in app **[app display name]**.
> Continuing to download the existing page code…"

No `AskUserQuestion` here — this is a status update before the next phase.

### Edit Phase 2: Download Existing Page

```powershell
pac model genpage download `
  --app-id <app-id> `
  --page-id <page-id> `
  --output-directory <working-dir>
```

The download creates a `<working-dir>/<page-id>/` folder with fixed filenames:
`page.tsx` (source), `config.json` (entity list + model), `prompt.txt` (original
prompt). Downstream phases operate on `<working-dir>/<page-id>/page.tsx` for
editing and uploading, and read `config.json.dataSources` in Phase 3.

### Edit Phase 3: Generate RuntimeTypes (Conditional)

Read `<working-dir>/<page-id>/config.json`. If `dataSources` is non-empty, the
page uses Dataverse entities — generate the schema:

```powershell
pac model genpage generate-types `
  --data-sources "entity1,entity2" `
  --output-file <working-dir>/RuntimeTypes.ts
```

Pass the exact entity list from `config.json.dataSources`. If `dataSources` is an
empty array, the page is mock-data only — skip this phase.

### Edit Phase 4: Plan the Edit

Invoke the `genpage-edit-planner` agent via the `Task` tool. Pass:

- The user's edit intent: `$ARGUMENTS`
- The working directory (absolute path)
- The plugin root: `${CLAUDE_PLUGIN_ROOT}`
- The app-id and page-id
- The download directory: `<working-dir>/<page-id>/`

The planner reads `page.tsx`, `config.json`, and `prompt.txt` for context, gathers
any clarification from the user, presents the edit plan via plan mode, and writes
`<working-dir>/genpage-edit-plan.md` on approval. Wait for it to finish.

### Edit Phase 5: Apply the Edit

Read `<working-dir>/genpage-edit-plan.md` for the approved change list and
preservation constraints.

Also read:
- `${CLAUDE_PLUGIN_ROOT}/references/genpage-rules-reference.md` — all code-gen
  rules still apply to edits (Fluent UI V9 only, makeStyles with tokens, WCAG AA,
  no `100vh`/`100vw`, etc.)
- `<working-dir>/RuntimeTypes.ts` — if generated in Edit Phase 3, for verified
  column names
- `<working-dir>/<page-id>/page.tsx` — the current source

Apply each change from the edit plan using targeted `Edit` operations on
`<working-dir>/<page-id>/page.tsx`. **Preserve the functionality** listed under
"Preservation Constraints" in the plan. Use ONLY verified column names from
RuntimeTypes.ts when the edit touches data access.

Do NOT rewrite the entire file. Use the minimum necessary `Edit` operations.

### Edit Phase 6: Deploy Updated Page

```powershell
pac model genpage upload `
  --app-id <app-id> `
  --page-id <page-id> `
  --code-file <working-dir>/<page-id>/page.tsx `
  --data-sources "entity1,entity2" `
  --prompt "User's edit request summary" `
  --model "<current-model-id>" `
  --agent-message "Description of what was changed"
```

Use `--page-id` for updates. Omit `--add-to-sitemap` (the page is already in the sitemap).
Omit `--data-sources` when `config.json.dataSources` was empty.

### Edit Phase 7: Verify (Optional)

Offer browser verification via `AskUserQuestion` (same flow as Phase 7 in the create flow).

### Edit Phase 8: Summary

Write a `workflow-log.md` file to the working directory (same purpose as Phase 8 in
the create flow).

Then present a summary to the user:

```
## Edit Complete

| File | Changes | Status |
|------|---------|--------|
| <page-id>/page.tsx | <N changes> | Deployed |

App: [app name] ([app-id])
Page ID: [page-id]
```
