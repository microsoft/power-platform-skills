---
name: genpage
version: 1.0.0
description: Creates, updates, and deploys Power Apps generative pages for model-driven apps using React v17, TypeScript, and Fluent UI V9. Completes workflow from requirements to deployment. Uses PAC CLI to deploy the page code. Use it when user asks to build, retrieve, or update a page in an existing Microsoft Power Apps model-driven app. Use it when user mentions "generative page", "page in a model-driven", or "genux".
author: Microsoft Corporation
argument-hint: "[optional: page description or 'deploy' or 'update']"
user-invocable: true
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
---

# Power Apps Generative Pages Builder

**Triggers:** genpage, generative page, create genpage, genux page, build genux, power apps page, model page
**Keywords:** power apps, generative pages, genux, model-driven, dataverse, react, fluent ui, pac cli
**Aliases:** /genpage, /gen-page, /genux

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

Follow these steps in order for every `/genpage` invocation.

### Step 1: Validate Prerequisites

Run these checks (first invocation per session only). Run each command separately — do not chain with `&&`:

```powershell
node --version
```

```powershell
pac help
```

`pac help` output includes the version number. Verify the version is **>= 2.3.1**. If the version is older, instruct the user to update: `dotnet tool update --global Microsoft.PowerApps.CLI.Tool`.

If either command fails, inform the user and provide installation instructions. Do NOT proceed until prerequisites are met. See [troubleshooting.md](../../references/troubleshooting.md) if issues arise.

### Step 2: Authenticate and Select Environment

Check PAC CLI authentication:

```powershell
pac auth list
```

**If no profiles:** Ask user to authenticate:
```powershell
pac auth create --environment https://your-env.crm.dynamics.com
```
Wait for user to complete browser sign-in, then re-verify.

**If one profile:** Confirm it's active (has `*` marker). If not, activate it:
```powershell
pac auth select --index 1
```

**If multiple profiles:** Show the list, ask which environment to use, then:
```powershell
pac auth select --index <user-chosen-index>
```

Report: "Working with environment: [name]" and proceed.

#### Detect Configured Languages

After confirming the active environment, detect configured languages:

```powershell
pac model list-languages
```

Note the output. If multiple languages are configured (or any non-English language), localization will be included in the generated code. Include the detected languages when reporting the environment to the user, e.g.:
> "Working with environment: [name] — Languages: English (1033), Arabic (1025), French (1036)"

### Step 3: Gather Requirements (Interactive)

Ask these questions one at a time:

1. **"Create a new generative page or edit an existing one?"** (use `AskUserQuestion`)
   - If new: continue to next question
   - If edit: ask for the app and page to edit, download it with `pac model genpage download --app-id <app-id> --page-id <page-id> --output-directory ./output-dir`, then ask what changes to make
2. **"Describe the page you'd like to build"** (use `AskUserQuestion`) — present two example descriptions as options and let the user type their own via the "Other" option:
   - **Option 1:** "Build a page showing Account records as a gallery of cards using modern look & feel. All cards should have fixed size and tall enough to fit 4 lines of titles. Include name, entityimage on the top and, website, email, phone number. Make the component fill 100% of the space. Make the gallery scrollable. Use data from the Account table. Make each card clickable to open the Account record in a new window. The target URL should be current location path with following query string parameters: pagetype=entityrecord&etn=[entityname]&id=[recordid] where entityname is account and id is accountid."
   - **Option 2:** "Design a vertically scrollable checklist interface for Task records using a clean, flat layout. Each task should be a row with a left-aligned checkbox, subject in bold and right-aligned due date and priority. Use neutral tones for background and soft color tags for priority (e.g., red for High, gray for Low). Completed tasks should show a strikethrough and reduced opacity. Allow inline editing of due date with a date picker. On hover, rows should highlight with another background. Clicking a task opens the Task record in a new window using: pagetype=entityrecord&etn=[entityname]&id=[recordid] where entityname is task and id is related record id."
   - **Other (Recommended):** User types their own description
3. **"Will the page use Dataverse entities or mock data?"** (use `AskUserQuestion`)
   - If entities: ask which entities and fields (use logical names — singular, lowercase)
   - If mock data: confirm you'll generate realistic sample data
4. **"Any specific requirements?"** (use `AskUserQuestion`) — styling, features (search, filtering, sorting), accessibility, responsive behavior, interactions

If the user provided a description with the `/genpage` command, acknowledge it and skip question 2. If the selected description already specifies a data source (e.g., Option 1 mentions Account table, Option 2 mentions Task records), skip question 3 as well.

### Step 4: Plan and Confirm

Present a clear plan:

```
I'll create a [page type] with:
- Data: [entities or mock data with specifics]
- Features: [list key features]
- Components: [Fluent UI components to use]
- Layout: [responsive design approach]
- Localization: [list detected languages] (translations, RTL support if applicable, user format settings)

Does this plan look good? Any changes needed?
```

Only include the Localization line when multiple languages were detected in Step 2, or any non-English language was configured.

Wait for confirmation before proceeding. If changes requested, revise and re-confirm.

### Step 5: Generate Schema and Verify Columns (Dataverse Pages Only)

**CRITICAL — DO THIS BEFORE WRITING ANY CODE.** Column name hallucination is the #1 source of runtime errors. Never guess column names.

If the page uses Dataverse entities, generate the TypeScript schema NOW:

```powershell
pac model genpage generate-types --data-sources "entity1,entity2" --output-file RuntimeTypes.ts
```

> **Windows + Bash**: Always use forward slashes in file paths (e.g., `D:/temp/RuntimeTypes.ts`). Backslashes like `\t` or `\R` are consumed as escape sequences by bash, producing wrong paths.

After generating, **read the RuntimeTypes.ts file** and:
1. Identify the actual column names available on each entity
2. Note which columns are readonly vs writable
3. Note the enum/choice set names and values
4. Use ONLY these verified column names when generating code in the next step

> **NEVER guess or assume column names.** Custom entities (e.g., `cr69c_candidate`) have unpredictable column names (e.g., `cr69c_fullname` not `cr69c_name`). The only way to know the real names is to read them from the generated schema.

If schema generation fails, see [troubleshooting.md](../../references/troubleshooting.md). Do NOT generate code with guessed column names.

**For mock data pages:** Skip this step.

### Step 6: Read Code Generation Rules and Samples

Before generating code, read the comprehensive rules reference:

**[genpage-rules-reference.md](../../references/genpage-rules-reference.md)** — Full code generation rules, DataAPI types, layout patterns, common errors.

Also read a relevant sample for reference:

| Sample | Use When |
|--------|----------|
| [1-account-grid.tsx](../../samples/1-account-grid.tsx) | DataGrid with Dataverse entities |
| [2-wizard-multi-step.tsx](../../samples/2-wizard-multi-step.tsx) | Multi-step wizard flow |
| [3-poa-revocation-wizard.tsx](../../samples/3-poa-revocation-wizard.tsx) | Complex wizard with forms |
| [4-account-crud-dataverse.tsx](../../samples/4-account-crud-dataverse.tsx) | Full CRUD operations |
| [5-file-upload.tsx](../../samples/5-file-upload.tsx) | File upload pattern |
| [6-navigation-sidebar.tsx](../../samples/6-navigation-sidebar.tsx) | Sidebar navigation layout |
| [7-comprehensive-form.tsx](../../samples/7-comprehensive-form.tsx) | Complex form with validation |
| [8-responsive-cards.tsx](../../samples/8-responsive-cards.tsx) | Card-based responsive layout |

### Step 7: Generate Code

Generate complete TypeScript following ALL rules in [genpage-rules-reference.md](../../references/genpage-rules-reference.md). **For Dataverse pages, use ONLY the column names verified from RuntimeTypes.ts in Step 5.** Output in this format:

**Agent Thoughts:** Step-by-step reasoning and approach
**Summary:** Non-technical bulleted list of what was built
**Final Code:** Complete, ready-to-run TypeScript (no placeholders)

**Localization:** If multiple languages were detected in Step 2, the generated code **must** follow the Localization rules in [genpage-rules-reference.md](../../references/genpage-rules-reference.md). This includes language detection boilerplate, a translations dictionary for all detected languages, a `translate()` helper for all user-visible text, RTL support if any RTL languages (Arabic, Hebrew) were detected, and user formatting settings from `usersettings`.

Save the code to a `.tsx` file (e.g., `account-dashboard.tsx`).

### Component Template

```typescript
import {useEffect, useState} from 'react';
import type {
    TableRow,
    DataColumnValue,
    RowKeyDataColumnValue,
    QueryTableOptions,
    ReadableTableRow,
    ExtractFields,
    GeneratedComponentProps
} from "./RuntimeTypes";

// Additional imports: @fluentui/react-components, @fluentui/react-icons, d3, etc.

// Utility functions as separate top-level functions

// Sub-components as separate top-level functions

const GeneratedComponent = (props: GeneratedComponentProps) => {
  const { dataApi } = props;
  // Component implementation
}

export default GeneratedComponent;
```

### DataAPI Quick Reference

```typescript
// Query with pagination
const result = await dataApi.queryTable("account", {
  select: ["name", "revenue"],
  filter: `contains(name,'test')`,
  orderBy: `name asc`,
  pageSize: 50
});

// Load more rows
if (result.hasMoreRows && result.loadMoreRows) {
  const nextPage = await result.loadMoreRows();
}

// Create, Update, Retrieve
await dataApi.createRow("account", { name: "New Account" });
await dataApi.updateRow("account", "record-id", { name: "Updated" });
const row = await dataApi.retrieveRow("account", { id: "record-id", select: ["name"] });

// Access formatted values (for enums, lookups, dates, etc.)
const formatted = row["status@OData.Community.Display.V1.FormattedValue"];

// Lookup fields: raw value is a GUID — use formatted value for display name
const contactGuid = row._primarycontactid_value;                                           // GUID
const contactName = row["_primarycontactid_value@OData.Community.Display.V1.FormattedValue"]; // Display name

// Get enum choices
const choices = await dataApi.getChoices("account-statecode");
```

**DataAPI Rules:**
- ONLY use `dataApi` when TableRegistrations are provided — never assume tables/fields exist
- **NEVER guess column names** — always verify from RuntimeTypes.ts generated in Step 5
- **Lookup fields** (e.g., `_primarycontactid_value`) return a GUID. Always use the `@OData.Community.Display.V1.FormattedValue` annotation for display
- Use entity logical names — singular lowercase (e.g., `"account"`)
- Only reference columns that exist in the generated schema
- If no types provided, use mocked sample data
- Always wrap async `dataApi` calls in try-catch
- DataGrid: use `createTableColumn`, enable sorting by default

See [genpage-rules-reference.md](../../references/genpage-rules-reference.md) for full DataAPI type definitions and examples.

### Step 8: Save and Deploy

After showing code, ALWAYS ask:
> "Would you like to publish this page to Power Apps?"

If yes, follow this deployment workflow. **Copy the upload commands below exactly — `--app-id`, `--code-file`, `--prompt`, `--agent-message` are all required and must use these exact flag names.**

**For Dataverse entity pages** (schema already generated in Step 5):

```powershell
pac model list
```

**CRITICAL:** Ask the user: "Which app would you like to publish this page to? Please provide the app-id or app name from the list above."
- **NEVER** choose a default app or assume an app-id
- **ACCEPT BOTH** app-id (GUID) or app name — if user provides an app name, run `pac model list` to look up the corresponding app-id
- **WAIT** for user response before proceeding

```powershell
pac model genpage upload `
  --app-id <user-provided-app-id-or-name> `
  --code-file page-name.tsx `
  --name "Page Display Name" `
  --data-sources "entity1,entity2" `
  --prompt "User's original request summary" `
  --model "<current-model-id>" `
  --agent-message "The agent's response message describing what was built and any relevant details" `
  --add-to-sitemap
```

**For mock data pages** (skip schema generation):

```powershell
pac model list
# Ask user for app selection, then:
pac model genpage upload `
  --app-id <user-provided-app-id-or-name> `
  --code-file page-name.tsx `
  --name "Page Display Name" `
  --prompt "User's original request summary" `
  --model "<current-model-id>" `
  --agent-message "The agent's response message describing what was built and any relevant details" `
  --add-to-sitemap
```

**For updating existing pages** (use `--page-id`, omit `--add-to-sitemap`):

```powershell
pac model genpage upload `
  --app-id <app-id-or-name> `
  --page-id <page-id> `
  --code-file page-name.tsx `
  --data-sources "entity1,entity2" `
  --prompt "User's original request summary" `
  --model "<current-model-id>" `
  --agent-message "The agent's response message describing what was built and any relevant details"
```

### Step 9: Verify in Browser

After successful deployment, ask the user (use `AskUserQuestion`):
> "Would you like to verify the page in the browser using Playwright? This will open the page and test interactive elements."

Options: **Yes, verify in browser** / **Skip verification**

If the user chooses to skip, go directly to Step 10.

If the user chooses to verify, open the page in the browser using Playwright to verify it works and interactive elements function correctly.

#### 9.1 Navigate and Authenticate

Construct the URL from the environment base URL, app-id, and page-id returned by the upload command:

```
https://<env>.crm.dynamics.com/main.aspx?appid=<app-id>&pagetype=genux&id=<page-id>
```

1. Use `browser_navigate` to open the constructed URL
2. If you get a "page closed" or "browser closed" error, retry navigation once — Playwright sessions can expire
3. Use `browser_snapshot` to capture the page state. Always snapshot before any clicks — stale refs cause "Ref not found" errors
4. If a sign-in page appears, use `browser_click` on the sign-in option, then `browser_wait_for` for the page to load
5. Use `browser_wait_for` to wait for the genux page content to render (may take a few seconds)

#### 9.2 Structural Verification

Use `browser_snapshot` to take an accessibility snapshot and verify the expected DOM elements are present based on the page type built:

| Page Type | Expected Elements |
|-----------|-------------------|
| Data Grid | Table/grid element with column headers and data rows |
| Form / Wizard | Form fields (inputs, dropdowns) and Next/Back buttons |
| CRUD | Data grid + action buttons (Add, Edit, Delete) |
| Dashboard | Multiple sections/panels with headings |
| Card Layout | Card containers with content |
| File Upload | File input or drop zone element |
| Navigation Sidebar | Nav element with menu items |

If expected elements are missing, note the issue for the fix step (9.5).

#### 9.3 Interactive Testing

Test functional interactions based on the page type. **Always take a fresh `browser_snapshot` before each click** to get current element refs. Move on after 2 failed attempts per interaction.

**All page types:**
- Verify at least one button or control responds to a click

**Page-type-specific tests:**

| Page Type | Test Action | Expected Result |
|-----------|-------------|-----------------|
| Data Grid | Click a column header | Sort order changes (arrow indicator appears or flips) |
| Form / Wizard | Click Next button | Step advances to next section |
| Form / Wizard | Click Back button | Returns to previous section |
| CRUD | Click Add/New button | Form or dialog appears |
| Dashboard | Click a tab or section toggle | Content area updates |
| Card Layout | Click an action button on a card | Card responds (expand, navigate, etc.) |
| Navigation Sidebar | Click a menu item | Content area updates to show selected section |

**What NOT to test** (skip these):
- Dataverse data mutations (create/update/delete records) — modifies real data
- File upload dialogs — Playwright cannot interact with native OS file dialogs
- Complex form validation — fragile, requires realistic test data
- Pagination — requires actual Dataverse data to be present

#### 9.4 Visual Confirmation

Use `browser_take_screenshot` to capture a final screenshot for the deployment summary. This screenshot should show the page in its final verified state.

#### 9.5 Fix and Re-deploy

If structural or interactive issues are found:
1. Analyze the snapshot and screenshot for error details
2. Fix the code
3. Re-deploy using Step 8
4. Repeat verification (Steps 9.1–9.4) until the page works correctly

**Common Playwright issues:**
- "Target page, context or browser has been closed" → retry the navigation
- "Ref not found" → take a fresh `browser_snapshot` before clicking any element
- Sign-in required → Playwright uses the system browser session; if not authenticated, the user must sign in manually first

### Step 10: Final Summary

After deployment and verification, provide:
- Confirmation of successful upload
- Screenshot of the page (if browser verification was done)
- How to find the page in the app
- Next steps (share with team, iterate on design)
- Offer to make updates or create additional pages