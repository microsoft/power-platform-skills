---
name: genpage
version: 2.1.0
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
- The plugin root path: `${CLAUDE_PLUGIN_ROOT}`

Example:

> You are the genpage-planner agent. Plan generative page(s) for the following requirements:
>
> [paste $ARGUMENTS here verbatim, or "no arguments provided — gather from user"]
>
> Working directory: [absolute path from Phase 0]
> Plugin root: ${CLAUDE_PLUGIN_ROOT}
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

#### 2a. Verify az auth + Dataverse connectivity

Entity creation runs through the plugin's Node.js Web API scripts using `az` for
auth. Verify both pieces before invoking the builder:

```bash
az account show --query user.name -o tsv
```

If that fails (no `az`, not logged in, etc.), stop and tell the user:
> "Entity creation requires Azure CLI. Run `az login` with the same account
> as your active `pac auth` profile, then retry."

Then probe the env with a `WhoAmI` call (extract the env URL from `pac org who`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET WhoAmI
```

- **Status 200** with a `UserId`: connectivity OK, proceed to 2b.
- **Status 401**: token didn't mint — bad `az login` state.
- **Status 403** with `"The user is not a member of the organization"`: the `az`
  identity differs from the env's user list. Tell the user:
  > "Your `az` account does not have access to this Dataverse environment.
  > Run `az login --username <user>@<tenant>` with the same identity that
  > `pac auth who` shows, then retry."
  Stop the workflow.
- **Network / other error**: report and stop.

#### 2b. Invoke entity-builder

Invoke the `genpage-entity-builder` agent via the `Task` tool. Pass in the prompt:
- Path to `genpage-plan.md`
- Working directory (absolute path)
- Plugin root: `${CLAUDE_PLUGIN_ROOT}`
- Dataverse env URL (from `pac org who`)
- Solution unique name (optional — if the plan calls one out)

Wait for completion. The builder writes a transactional log at
`<working-dir>/entity-creation-log.md` for recovery on failure.

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

#### 5b. Single-page fast path (skip Task dispatch when N=1)

**If the plan's Pages table contains exactly one row**, do NOT dispatch a Task
subagent. Inline the page-builder workflow directly in the orchestrator:

1. Read `${CLAUDE_PLUGIN_ROOT}/references/verified-icons.txt`
2. Read `${CLAUDE_PLUGIN_ROOT}/references/genpage-rules-reference.md`
3. Read the sample listed in the plan's `## Relevant Samples`
4. If the plan's Per-Page Specification has `Needs caching: true`, also read
   `${CLAUDE_PLUGIN_ROOT}/references/data-caching-pattern.md`
5. If the plan's `## Environment` indicates non-English languages, also read
   `${CLAUDE_PLUGIN_ROOT}/references/genpage-localization-reference.md`
6. Read `genpage-plan.md` (already in working directory) and `RuntimeTypes.ts`
   if Data mode is dataverse
7. Write the `.tsx` file to `<working-dir>/<filename>.tsx` following all rules
8. Grep your own output for every named import from `@fluentui/react-icons` and
   verify each appears in `verified-icons.txt`; rewrite if any are missing
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

### Phase 6.5: Navigation Fix-Up (Multi-Page Only)

**Only runs when the plan has 2+ pages** AND any built `.tsx` contains a `PAGEREF_`
token. Skip entirely for single-page builds.

Page-builders write `"PAGEREF_<filename-without-tsx>"` as a placeholder wherever they
navigate to a sibling generative page (see Rule 13 / Generative Page Navigation in
genpage-rules-reference.md) — because GUIDs don't exist until after first upload.
This phase replaces all placeholders with the real GUIDs returned by Phase 6.

**Why a second pass is required:** Pages are built in parallel before any GUIDs exist.
The placeholders let code generation proceed correctly; this phase resolves them.

#### Steps

1. Build a map of `filename-without-tsx → page-id` from the Phase 6 upload output:
   ```
   pet-gallery  → 3643e240-b589-4862-bf37-8347f388044b
   pet-detail   → 8dab5cd4-c861-40a8-a970-291e4f047eb7
   pet          → 12fa8b16-...  (always include — substring of pet-gallery)
   ```

2. **Sort the map keys by length, descending.** This prevents shorter names from
   matching inside longer names (e.g., `PAGEREF_pet` partially matching
   `PAGEREF_pet-gallery`).

3. For each `.tsx` file in `<working-dir>/*.tsx` (top level only — do NOT recurse into
   subfolders), scan for any quoted `"PAGEREF_<name>"` token. **The placeholder
   MUST be inside double quotes** (page-builders emit `pageId: "PAGEREF_pet"`).

4. For each match, perform an exact-string replacement of `"PAGEREF_<name>"` with
   `"<page-id-guid>"`. Use word-boundary-safe substitution: match the full token
   `"PAGEREF_<name>"` including surrounding quotes, not a substring of it.

5. If a placeholder is found that does NOT match any key in the map (e.g., a typo),
   surface this to the user explicitly — do NOT silently leave the literal string
   in the deployed code. Stop and report which file and which placeholder.

6. Re-upload only the files that had at least one replacement. Use the full update
   form of `pac model genpage upload` from Phase 6 — include `--app-id`, `--page-id`,
   `--code-file`, `--data-sources` (if Dataverse), `--prompt`, `--model`,
   `--agent-message`. Omit `--add-to-sitemap` (the page already exists). Example:

   ```powershell
   pac model genpage upload `
     --app-id <app-id> `
     --page-id <page-id-from-Phase-6> `
     --code-file <working-dir>/<file>.tsx `
     --data-sources "entity1,entity2" `
     --prompt "User's original request summary" `
     --model "<current-model-id>" `
     --agent-message "Resolved cross-page navigation placeholders"
   ```

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

For the edit flow (triggered when the `genpage-planner` returns
`{ "action": "edit" }`), see [edit-flow.md](edit-flow.md) in this folder.

The edit flow has its own 8 phases (Edit Phase 1-8): discover and select target
app + page via `pac model list` + `pac model genpage list`, download, generate
RuntimeTypes if needed, invoke `genpage-edit-planner`, apply the edit inline,
deploy, verify, summarize.
