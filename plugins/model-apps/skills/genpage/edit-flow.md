# Edit Flow

The orchestrator follows this flow when the `genpage-planner` returns
`{ "action": "edit" }` in Phase 1 of the create flow. The skill delegates planning
to `genpage-edit-planner`, then applies the edit inline.

> **⚠️ CRITICAL — do NOT hallucinate app or page names.** App names and page
> names are discovered by running `pac model list` and `pac model genpage list
> --app-id <id>`. Never guess them from the repo, the conversation context,
> sample app names, or anywhere else. Always run the commands first, then
> present what the commands returned to the user.

## Edit Phase 1: Discover and Select Target App + Page

The planner has already validated prereqs and confirmed auth.

**CRITICAL — never guess or invent app names or page names.** You must discover
them by running the PAC CLI commands below. Hallucinating page names from context
(repo names, prior conversation, sample apps) is wrong and confuses the user.

### 1a. Discover available apps

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

### 1b. Discover existing pages in the selected app

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

### 1c. Confirm selection

Restate the selection to the user before proceeding:

> "Editing **[page display name]** in app **[app display name]**.
> Continuing to download the existing page code…"

No `AskUserQuestion` here — this is a status update before the next phase.

## Edit Phase 2: Download Existing Page

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

## Edit Phase 3: Generate RuntimeTypes (Conditional)

Read `<working-dir>/<page-id>/config.json`. If `dataSources` is non-empty, the
page uses Dataverse entities — generate the schema:

```powershell
pac model genpage generate-types `
  --data-sources "entity1,entity2" `
  --output-file <working-dir>/RuntimeTypes.ts
```

Pass the exact entity list from `config.json.dataSources`. If `dataSources` is an
empty array, the page is mock-data only — skip this phase.

## Edit Phase 4: Plan the Edit

Invoke the `genpage-edit-planner` agent via the `Task` tool. Pass:

- The user's edit intent: `$ARGUMENTS`
- The working directory (absolute path)
- The plugin root: `${CLAUDE_PLUGIN_ROOT}`
- The app-id and page-id
- The download directory: `<working-dir>/<page-id>/`

The planner reads `page.tsx`, `config.json`, and `prompt.txt` for context, gathers
any clarification from the user, presents the edit plan via plan mode, and writes
`<working-dir>/genpage-edit-plan.md` on approval. Wait for it to finish.

## Edit Phase 5: Apply the Edit

Read `<working-dir>/genpage-edit-plan.md` for the approved change list and
preservation constraints.

Also read:
- `${CLAUDE_PLUGIN_ROOT}/references/rules.md` — all code-gen
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

## Edit Phase 6: Deploy Updated Page

This is an **update** (existing page-id), so `--prompt` must describe the
**delta of changes only** — not a re-statement of the original page description.
See SKILL.md Phase 6 "`--prompt` semantics".

```powershell
pac model genpage upload `
  --app-id <app-id> `
  --page-id <page-id> `
  --code-file <working-dir>/<page-id>/page.tsx `
  --data-sources "entity1,entity2" `
  --prompt "<User's edit request — only the changes, not the full page>" `
  --model "<current-model-id>" `
  --agent-message "Description of what was changed in this upload"
```

Use `--page-id` for updates. Omit `--add-to-sitemap` (the page is already in
the sitemap).
Omit `--data-sources` when `config.json.dataSources` was empty.

## Edit Phase 7: Verify (Optional)

Offer browser verification via `AskUserQuestion` (same flow as Phase 7 in the create flow — see SKILL.md).

## Edit Phase 8: Summary

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
