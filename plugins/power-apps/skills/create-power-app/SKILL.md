---
name: create-power-app
description: Creates Power Apps code apps using React and Vite. Use when building code apps, scaffolding projects, or deploying to Power Platform.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill, EnterPlanMode, ExitPlanMode
model: opus
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

**References:**

- [prerequisites-reference.md](./references/prerequisites-reference.md) - Prerequisites and required permissions
- [troubleshooting.md](./references/troubleshooting.md) - Common issues, npm scripts, resources

# Create Power Apps Code App

## Workflow

1. Prerequisites → 2. Gather Requirements → 3. Plan → 4. Auth & Select Environment → 5. Scaffold → 6. Initialize → 7. Build & Deploy (baseline) → 8. Add Data Sources → 9. Implement App → 10. Final Build & Deploy → 11. Summary

---

### Step 0: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md). Skip completed steps.

### Step 1: Validate Prerequisites

Run prerequisite checks **first** -- no point gathering requirements if the environment isn't ready. See [prerequisites-reference.md](./references/prerequisites-reference.md) for details.

Check Node.js, the npm CLI package, and Git (runs natively in bash):

```bash
node --version                         # Must be v22+
git --version                          # Optional but recommended
```

Check `pac` CLI via PowerShell — it's a Windows executable not on the bash PATH:

```bash
pwsh -NoProfile -Command "pac"  # Used for auth, env selection, code commands
```

- **Missing Node.js**: Report "Install Node.js v22+ from https://nodejs.org/" and STOP.
- **Node.js below v22**: Report "Node.js 22+ is required. Please upgrade or switch with `nvm use 22`." and STOP.
- **Missing pac**: Report "Install Power Platform CLI from https://aka.ms/PowerAppsCLI" and STOP.
- **Missing Git**: Report "Recommended but optional." Continue if approved.
- **All present**: Report versions and proceed.


### Step 2: Gather Requirements

**Skip questions the user already answered in their initial instruction.**

**If the user has not described what they want to build** (i.e., `/create-power-app` was invoked with no arguments or a vague prompt), start with a single open-ended question before asking anything else:

> "What would you like to build? Describe it in your own words — what it does, who uses it, and what problem it solves."

Wait for their answer. Use it to frame all follow-up questions. Do NOT present a multiple-choice list of app types before the user has described their idea.

Once you have their description:

1. Confirm the app name and clarify the purpose if needed
2. Ask about data -- focus on **what the app needs to do**, not specific technologies:
   - "What data does your app need to work with?" (e.g., company emails, project tasks, custom business records)
   - "Does your app need to search existing information, manage its own data, or both?"
   - Based on their answers, recommend the best approach:
     - **Store and manage custom business data** (tables, forms, CRUD) → Dataverse (`/add-dataverse`)
     - **Interact with specific services** (send emails, post messages, manage files) → the appropriate connector
   - If they mention existing Dataverse tables, SharePoint lists, or connectors by name, use those directly
3. Ask about UI requirements: key screens, layout, interactions, theme preference
4. Ask any clarifying questions now -- resolve all ambiguity before entering plan mode

### Step 3: Plan

1. Enter plan mode with `EnterPlanMode`
2. Design the full implementation approach:
   - Which `/add-*` skills to run for data sources
   - App architecture: components, pages, state management
   - Feature list with priority order
3. Present plan for approval, include `allowedPrompts` from [prerequisites-reference.md](./references/prerequisites-reference.md)
4. Exit plan mode with `ExitPlanMode` when approved

### Step 4: Auth & Select Environment

```bash
pwsh -NoProfile -Command "pac auth list"
```

If empty, proceed since the command will use system credentials. If profiles are listed, check which environment they target.

**If multiple profiles are listed:** Notify the user that using Microsoft tenant credentials requires clearing all profiles first, then run:

```bash
pwsh -NoProfile -Command "pac auth clear"
```

After clearing, there is no need to run `auth create`. The tool picks up the system login automatically.

`pwsh -NoProfile -Command "pac auth list"` shows the active auth profile with its environment. Check which environment it targets.

- **Environment matches user's target**: Confirm and proceed.
- **On a different environment or no target set**: Run `pwsh -NoProfile -Command "pac env list"`, show up to 10 options, let the user pick, and run `pwsh -NoProfile -Command "pac env select --environment <id>"`.

See [preferred-environment.md](${CLAUDE_PLUGIN_ROOT}/shared/preferred-environment.md) for details.

**Critical:** Capture the environment ID for Step 7.

### Step 5: Scaffold

Ask the user for a folder name. Default to `powerapps-{app-name-slugified}-{timestamp}` if they don't have a preference.

**IMPORTANT: Use `npx degit` to download the template. Do NOT use `git clone`, do NOT manually create files, do NOT download from GitHub UI. `degit` downloads the template without git history.**

```powershell
npx degit microsoft/PowerAppsCodeApps/templates/vite {folder} --force
cd {folder}
npm install
```

**Notes:**

- Use `--force` to overwrite if the directory already has files (e.g., `.claude` from a planning session)
- If targeting an existing directory, use `.` as the folder name: `npx degit microsoft/PowerAppsCodeApps/templates/vite . --force`
- If `npx degit` fails (network issues, npm not found), retry once, then ask the user to run manually

Verify: `package.json` exists, `node_modules/` created.

### Step 6: Initialize

```bash
pwsh -NoProfile -Command "pac code init --displayName '{user-provided-app-name}' -e <environment-id>"
```

**`pac code init` failure:**

- Non-zero exit: Report the exact output and STOP. Do not continue to Step 7.
- "environmentId not found": Confirm the environment ID from Step 4 and retry with the correct `-e` value.
- Example: _"The `pac code init` command failed: `[error text]`. Please check that environment ID `32a51012-...` is correct and that you have maker permissions in that environment."_

**Critical:** Read `power.config.json` and verify `environmentId` matches Step 4. Update if mismatched (common issue).

### Step 7: Build & Deploy (baseline)

> **Pre-approved**: This baseline deploy is part of the scaffold flow and does not require a separate confirmation prompt.

Build and deploy the bare template to verify the pipeline works before adding data sources.

```powershell
npm run build
```

Verify `dist/` folder created with `index.html` and `assets/`.

```bash
pwsh -NoProfile -Command "pac code push"
```

**Capture app URL** from output: `https://apps.powerapps.com/play/e/{env-id}/app/{app-id}`

**Common deploy errors:** See [troubleshooting.md](./references/troubleshooting.md).

**Create or update `memory-bank.md` in the project root now** -- don't wait until the end. Include:

- Project path, app name, environment ID, app URL
- Completed steps: scaffold, init, baseline deploy
- Data sources planned (from Step 2)
- Version: v1.0.0

This ensures progress is saved even if the session ends unexpectedly.

### Step 8: Add Data Sources

Invoke the `/add-*` skills identified in the plan (Step 3). Run each in sequence. **Pass context as arguments** so sub-skills skip redundant questions (project path, connector name, etc.):

| App needs to...                            | Invoke             |
| ------------------------------------------ | ------------------ |
| Store/manage custom business data          | `/add-dataverse`   |
| Track work items, bugs, pipelines          | `/add-azuredevops` |
| Send or read Teams messages                | `/add-teams`       |
| Read/write Excel spreadsheet data          | `/add-excel`       |
| Upload, download, or manage files          | `/add-onedrive`    |
| Work with SharePoint lists or docs         | `/add-sharepoint`  |
| Send emails, read inbox, manage calendar   | `/add-office365`   |
| Invoke a Copilot Studio agent              | `/add-mcscopilot`  |
| Connect to another service                 | `/add-connector`   |

Each `/add-*` skill runs `npm run build` to catch errors. Do NOT deploy yet.

**If no data sources needed:** Skip to Step 9.

### Step 9: Implement App

**This is the core step.** Build the actual app features described in the plan from Step 3.

1. **Review generated services**: Use `Grep` to find methods in generated service files (they can be very large -- see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)). Do NOT read entire generated files.
2. **Build components**: Create React components for each screen/feature in the plan
3. **Connect data**: Wire components to generated services (use `*Service.getAll()`, `*Service.create()`, etc.)
4. **Apply theme**: Use the user's theme preference (default: dark theme per development standards)
5. **Add version display**: Show app version in the UI (per development standards)
6. **Iterate with user**: Show progress, ask for feedback, adjust as needed

**Key rules:**

- Use generated services for all data access -- never use fetch/axios directly
- Read [dataverse-reference.md](${CLAUDE_PLUGIN_ROOT}/skills/add-dataverse/references/dataverse-reference.md) if working with Dataverse (picklist fields, virtual fields, lookups have critical gotchas)
- Remove unused imports before building (TS6133 strict mode)
- Don't edit files in `src/generated/` unless fixing known issues

### Step 10: Final Build & Deploy

```powershell
npm run build
```

Fix any TypeScript errors. Verify `dist/` contains the updated app.

Ask the user: _"Ready to deploy to [environment name]? This will update the live app."_ Wait for explicit confirmation before proceeding.

```bash
pwsh -NoProfile -Command "pac code push"
```

Increment version (e.g., v1.0.0 → v1.1.0) and update version display in the app.

### Step 11: Summary

Provide:

- App name, environment, app URL, project location
- Version deployed
- What was built: features, data sources, components
- Next steps: how to iterate (`npm run build && pac code push`), how to add more data sources
- Suggest what else the app could do:
  - `/add-datasource` -- add another data source (describe what you need, and the plugin will recommend the best approach)
  - `/add-dataverse` -- store and manage custom business data
  - `/add-azuredevops` -- track work items, bugs, and pipelines
  - `/add-teams` -- send and read Teams messages
  - `/add-sharepoint` -- work with SharePoint lists or documents
  - `/add-office365` -- send emails, manage calendar
  - `/add-connector` -- connect to any other service
- Manage at https://make.powerapps.com/environments/<environment-id>/home

### Update Memory Bank

Update the memory bank (created in Step 7) with final state:

- All completed steps (scaffold, data sources, implementation, deploy)
- Features implemented and components created
- Data sources connected
- Current version
- Suggested next steps

---

## Example Walkthroughs

These walkthroughs show the full sequence from user request to final output — commands run, files changed, and the verbatim summary format the assistant should use.

---

### Example 1: Create a Task Tracker App with Dataverse

**User request:**

> "Build me a simple task tracker that stores tasks in Dataverse. I want to add tasks, mark them complete, and see a list."

**Commands run (in order):**

```bash
# Step 1: Prerequisites
node --version                                    # → v22.4.0
pwsh -NoProfile -Command "pac"          # verify installed

# Step 4: Auth
pwsh -NoProfile -Command "pac auth list"          # → verify active environment

# Step 5: Scaffold
npx degit microsoft/PowerAppsCodeApps/templates/vite powerapps-task-tracker-20260302 --force
cd powerapps-task-tracker-20260302
npm install

# Step 6: Initialize
pwsh -NoProfile -Command "pac code init --displayName 'Task Tracker' -e <environment-id>"

# Step 7: Baseline deploy (pre-approved as part of scaffold flow)
npm run build
pwsh -NoProfile -Command "pac code push"
# → App URL: https://apps.powerapps.com/play/e/32a51012-.../app/<app-id>

# Step 8: Add Dataverse (via /add-dataverse)
pwsh -NoProfile -Command "pac code add-data-source -a dataverse -t cr123_task"
npm run build   # verify connector — no deploy yet

# Step 10: Final deploy (requires user confirmation)
npm run build
pwsh -NoProfile -Command "pac code push"
```

**Files changed:**

| File                                          | Change                                                |
| --------------------------------------------- | ----------------------------------------------------- |
| `power.config.json`                           | Created by `pac code init` — contains `environmentId` |
| `src/generated/models/Cr123_taskModel.ts`     | Generated by `pac code add-data-source`               |
| `src/generated/services/Cr123_taskService.ts` | Generated by `pac code add-data-source`               |
| `src/components/TaskList.tsx`                 | Created — renders task list with status filter        |
| `src/components/AddTaskForm.tsx`              | Created — form to add new tasks                       |
| `src/App.tsx`                                 | Updated — wires components to `Cr123_taskService`     |
| `memory-bank.md`                              | Created in Step 7, updated in Step 11                 |

**Final assistant summary (verbatim format):**

```
Task Tracker is live.

App: Task Tracker v1.0.0
Environment: <your-environment-name> (<environment-id>)
URL: https://apps.powerapps.com/play/e/<environment-id>/app/<app-id>
Project: ~/powerapps-task-tracker-20260302/

What was built:
- Task list view with Active / Completed filter
- Add task form (title, description, due date)
- Mark complete / delete actions
- Dataverse table `cr123_task` (Title, Description, DueDate, IsComplete)

To redeploy: npm run build && pac code push (from the project folder)

What you can add next:
- /add-teams — post task updates to a Teams channel
- /add-office365 — send email notifications on completion
```

**What to record in `memory-bank.md`:**

```markdown
# Task Tracker — Memory Bank

## Project

- Path: ~/powerapps-task-tracker-20260302/
- App name: Task Tracker
- Environment: <your-environment-name> (<environment-id>)
- App URL: https://apps.powerapps.com/play/e/<environment-id>/app/<app-id>
- Version: v1.0.0

## Completed Steps

- [x] Prerequisites validated
- [x] Scaffold (npx degit)
- [x] Initialize (pac code init)
- [x] Baseline deploy
- [x] Add Dataverse (cr123_task)
- [x] Implement app (TaskList, AddTaskForm)
- [x] Final deploy

## Data Sources

- Dataverse: cr123_task (Title, Description, DueDate, IsComplete)

## Components

- TaskList.tsx — filtered list, mark complete, delete
- AddTaskForm.tsx — create new tasks

## Next Steps

- Consider /add-teams for task assignment notifications
```

---

### Example 2: Add SharePoint Connector to an Existing App

**User request:**

> "My app already exists. Add SharePoint so I can read items from a list called 'Project Milestones'."

**Commands run (in order):**

```bash
# Step 6: Get connection ID (via /list-connections)
pwsh -NoProfile -Command "pac connection list"
# → ConnectionId: conn-sp-xyz789  (SharePoint Online)

# Step 7: Discover sites
pwsh -NoProfile -Command "pac code list-datasets -a sharepointonline -c conn-sp-xyz789"
# → https://contoso.sharepoint.com/sites/Projects

# Step 8: Discover tables
pwsh -NoProfile -Command "pac code list-tables -a sharepointonline -c conn-sp-xyz789 -d 'https://contoso.sharepoint.com/sites/Projects'"
# → Project Milestones, Documents, Team Wiki

# Step 9: Add connector
pwsh -NoProfile -Command "pac code add-data-source -a sharepointonline -c conn-sp-xyz789 -d 'https://contoso.sharepoint.com/sites/Projects' -t 'Project Milestones'"

# Step 11: Build to verify
npm run build   # → success
```

**Files changed:**

| File                                                | Change                                            |
| --------------------------------------------------- | ------------------------------------------------- |
| `src/generated/services/SharePointOnlineService.ts` | Generated — contains `GetItems`, `PostItem`, etc. |
| `src/generated/models/SharePointOnlineModel.ts`     | Generated — TypeScript interfaces                 |
| `.power/schemas/sharepointonline/`                  | Generated schema files                            |
| `memory-bank.md`                                    | Updated — connector recorded                      |

**Final assistant summary (verbatim format):**

```
SharePoint Online connector added.

Connector: SharePoint Online
Site: https://contoso.sharepoint.com/sites/Projects
List: Project Milestones
Build: Passed ✓

Usage:
  const result = await SharePointOnlineService.GetItems({
    dataset: "https://contoso.sharepoint.com/sites/Projects",
    table: "Project Milestones"
  });
  const milestones = result.data?.value || [];

Next: Implement your UI components using the generated service, then run /deploy when ready.
```
