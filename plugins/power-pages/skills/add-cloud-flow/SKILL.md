---
name: add-cloud-flow
description: >-
  Integrates Power Automate cloud flows into a Power Pages site. Lists available flows,
  suggests relevant ones based on intent, identifies scenarios and web roles, creates metadata
  files, and generates client-side code to call flows. Handles both new flow registration and
  adding already-registered flows to additional pages without re-creating metadata. Use when
  the user wants to add, connect, register, or link a Power Automate cloud flow to their site.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Skill, Task, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Add Cloud Flow

Connect one or more Power Automate cloud flows to a Power Pages code site, or wire already-registered flows into additional pages/components. For new flows this skill:
- Creates the `adx_cloudflowconsumer` metadata YAML in `.powerpages-site/cloud-flow-consumer/`
- Assigns web roles based on the flow's scenario and target audience
- Generates client-side TypeScript/JavaScript service code to trigger the flow with CSRF authentication

For already-registered flows, the skill skips metadata and role creation and goes straight to client-side integration — wiring the existing flow into new UI locations.

## Core Principles

- **Multiple flows in one run**: The user can add several flows at once. All flows are planned together and implemented together before asking for deployment.
- **Ask before acting**: Present a full HTML plan (all flows, roles, reasoning) before creating any files.
- **Web roles drive access**: Every flow must have at least one web role. Anonymous Users role is valid but must be confirmed.
- **Scenario determines roles**: Understand what each flow does and who triggers it before picking roles.
- **Use TaskCreate/TaskUpdate**: Track all phases upfront before starting any work.

> **Prerequisites:**
> - An existing Power Pages code site with `.powerpages-site` deployed
> - PAC CLI authenticated (`pac auth who` must succeed)
> - Azure CLI authenticated (`az login`)

**Initial request:** $ARGUMENTS

---

## Workflow

1. **Verify Prerequisites** — Locate the project, confirm `.powerpages-site` exists, inventory web roles and existing flows
2. **List Available Flows** — Fetch flows from the Power Automate Flow RP API
3. **Select Flows & Understand Scenarios** — User picks one or more flows; determine scenario and audience for each
4. **Determine Web Roles** — Propose minimum roles per flow with reasoning
5. **Review Plan** — Render HTML plan for all flows; get user approval
6. **Create Metadata** — Write `.cloudflowconsumer.yml` for each flow; create missing web roles first
7. **Client-Side Integration** — Generate typed service code to call each flow from the frontend
8. **Verify & Summarize** — Validate all YAMLs, record skill usage, offer deployment

---

## Phase 1: Verify Prerequisites

**Goal**: Locate the Power Pages project and confirm all prerequisites are met

**Actions**:

1. Create todo list with all 8 phases (see [Progress Tracking](#progress-tracking) table)

### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories.

**If not found**: Tell the user to create a site first with `/create-site`.

### 1.2 Read Config

Read `powerpages.config.json` to get the `siteName` (used for display and plan rendering).

### 1.3 Check `.powerpages-site` Exists

Look for the `.powerpages-site` folder in the project root.

**If not found**:

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| `.powerpages-site` is required to add cloud flows. Would you like to deploy the site now? | Yes, deploy now (Required), Cancel |

**If "Yes, deploy now"**: Invoke `/deploy-site` first, then continue to Phase 2.
**If "Cancel"**: Stop.

### 1.4 Read Existing Web Roles

Read all `.webrole.yml` files from `.powerpages-site/web-roles/` to inventory available roles. Note each role's `id`, `name`, `adx_anonymoususersrole`, and `adx_authenticatedusersrole`.

### 1.5 Check Existing Cloud Flows

Check `.powerpages-site/cloud-flow-consumer/` for existing `.cloudflowconsumer.yml` files. For each file, read:
- `processid` — the flow's `workflowEntityId`
- `name` — the flow's display name
- `adx_CloudFlowConsumer_adx_webrole` — assigned web role UUIDs

Store these as the **already-registered flows** list. These flows already have metadata and web roles configured but may need additional frontend integration on other pages or components.

### 1.6 Detect Frontend Framework

Read `package.json` to detect the framework (React, Vue, Angular, Astro). Note the framework and its conventions for Phase 7. See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the detection mapping.

**Output**: Project root, site name, framework, available web roles, already-registered flows (with processid, name, and web roles)

---

## Phase 2: List Available Flows

**Goal**: Fetch all Power Automate cloud flows that have a PowerPages trigger

**Actions**:

Run the list-cloud-flows script (reads environment from `pac auth who` internally):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/add-cloud-flow/scripts/list-cloud-flows.js"
```

This calls the **Power Automate Flow RP API** with the filter `properties/definitionSummary/triggers/any(t: t/kind eq 'powerpages')`. Results include:

| Field | Source | Used for |
|-------|--------|----------|
| `id` | `properties.workflowEntityId` | `processid` in YAML; URL in client-side API call |
| `flowRpName` | `flow.name` | Flow RP identifier |
| `displayName` | `properties.displayName` | Shown to user; written as `name` in YAML |
| `description` | `properties.description` | Shown to user |
| `state` | `properties.state` | Shown to user (Active/Draft) |

**Separate into two lists**:
- **Unregistered flows**: Flows whose `id` does NOT match any `processid` from Phase 1.5 — these need full setup (metadata + roles + client-side)
- **Already-registered flows**: Flows whose `id` matches a `processid` from Phase 1.5 — these already have metadata and roles but can be integrated into additional pages/components

**Handle errors**:
- Exit code 1 with auth message → prompt the user to run `az login`
- Zero flows from API (no flows with a PowerPages trigger exist at all) → tell the user that no Power Automate flows with a PowerPages trigger were found in this environment. Guide them to create a flow first:

  > "No Power Automate cloud flows with a PowerPages trigger were found in this environment. To use this skill, you first need to create a flow in [Power Automate](https://make.powerautomate.com) with the **"When a Power Pages flow step is run"** trigger, then run this skill again to connect it to your site."

  **Stop the workflow** — do not continue to Phase 3.

- Zero unregistered flows but already-registered flows exist → do **not** stop. Continue to Phase 3 with only the already-registered flows available (for additional frontend integration).

**Output**: List of unregistered flows and list of already-registered flows

---

## Phase 3: Select Flows & Understand Scenarios

**Goal**: Understand the user's intent, suggest the most relevant flows (including already-registered ones for additional integration), let the user confirm or adjust, and determine the scenario for each selected flow

**Actions**:

### 3.1 Analyze User Intent & Suggest Flows

Before showing the full list, analyze the user's initial request (`$ARGUMENTS`) against **both** the unregistered flows and the already-registered flows. Match the user's described need to specific flows using display name, description, and scenario inference.

When matching intent, check already-registered flows first — the user may be asking to wire an existing flow into a new page or component, not register a new one.

- **If the user described a specific need** (e.g., "add automation for the contact form", "connect the email notification flow"): Identify flows whose name or description closely match the request and present them as **recommended** picks, explaining why each is a good match. Also show the remaining flows as additional options in case the suggestion is wrong.

  ```
  Based on your request, I recommend:
    ⭐ 1. Contact Form Submission — Sends an email when a contact form is submitted (Active)
         → Matches your request to add automation for the contact form

  Other available flows:
    2. Support Ticket Handler — Creates a case record from user input (Active)
    3. Newsletter Signup — Adds the user's email to a mailing list (Draft)
  ```

- **If the user's request is generic** (e.g., "add a cloud flow", "connect some flows"): Fall back to presenting the full list without recommendations.

  ```
  Available flows:
    1. Contact Form Submission — Sends an email when a contact form is submitted (Active)
    2. Support Ticket Handler — Creates a case record from user input (Active)
    3. Newsletter Signup — Adds the user's email to a mailing list (Draft)
  ```

Present both categories clearly when both exist:

```
New flows (not yet registered):
  1. Newsletter Signup — Adds the user's email to a mailing list (Active)

Already registered (available for additional frontend integration):
  2. Contact Form Submission — Already connected, can be wired into more pages
  3. Support Ticket Handler — Already connected, can be wired into more pages
```

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Which flows would you like to add or integrate? You can select from both new and already-registered flows. | (list or multi-select of flow names, with recommended flows pre-highlighted if applicable) |

If more than 10 flows are available, ask the user to type names or numbers (comma-separated for multiple).

### 3.2 Tag Selected Flows

For each selected flow, tag it based on its source:

| Tag | Meaning | Phases to execute |
|-----|---------|-------------------|
| **`new`** | Unregistered flow — needs full setup | Phases 4 → 5 → 6 → 7 (metadata + roles + client-side) |
| **`integration-only`** | Already registered — metadata and roles exist | Skip to Phase 7 (client-side integration only) |

### 3.3 Determine Scenario Per Flow

For each selected flow, identify its scenario from the name and description:

| Scenario type | Examples | Who triggers it |
|--------------|----------|-----------------|
| **Form submission** | Contact form, feedback, survey | Authenticated or anonymous visitors |
| **User self-service** | Profile update, request, leave application | Authenticated users only |
| **Admin action** | Bulk processing, content approval, data export | Admins / specific roles only |
| **Background / system** | Scheduled sync, enrichment | Not triggered by portal users directly |

If a flow's scenario is unclear, use `AskUserQuestion` per flow:

| Question | Context |
|----------|---------|
| What does "[flow name]" do on your site? Who triggers it? | Needed for role assignment |

For **`integration-only`** flows, the scenario is still needed to guide where and how the flow is wired into the frontend (Phase 7).

### 3.4 Determine Client-Side Function Name Per Flow

For each flow, derive a camelCase function name for the client-side service:
- Strip special characters and connector words from the display name
- Example: "PowerPages -> Send an email notification (V3)" → `sendEmailNotification`
- Example: "Contact Form Submission" → `submitContactForm`

For **`integration-only`** flows, check whether a trigger function already exists in the codebase (from a previous run of this skill). If it does, reuse that function name — do not create a duplicate. Only create a new function if one doesn't exist yet.

**Output**: Selected flows list, each with tag (`new` or `integration-only`), scenario, target audience, and client-side function name

---

## Phase 4: Determine Web Roles

**Goal**: Propose the minimum set of web roles for each **`new`** flow based on its scenario

> **Skip for `integration-only` flows** — these already have web roles assigned in their `.cloudflowconsumer.yml`. Do not re-propose or modify roles for them.

**Actions**:

### 4.1 Analyze Role Requirements Per Flow (New Flows Only)

| Scenario | Recommended roles |
|----------|-------------------|
| Any visitor (including unauthenticated) | `Anonymous Users` (confirm — security implication) |
| Only logged-in users | `Authenticated Users` |
| Only specific groups | Custom role(s) matching the group |

**Do NOT assign all roles by default.** Use the minimum set per flow. Different flows in the same batch can have different role sets.

### 4.2 Match Against Existing Roles

For each proposed role across all flows, check whether it exists in `.powerpages-site/web-roles/`. Mark roles as **existing** or **proposed/new**.

### 4.3 Compose Per-Role Reasoning

For each role assigned to each flow, write one sentence explaining why:

- `Authenticated Users` on a profile form: "Only logged-in users can update their profile."
- `Anonymous Users` on a contact form: "Unauthenticated visitors must be able to submit a contact request."
- `Blog Authors` on an email flow: "Blog Authors are the primary actors who submit posts triggering this notification."

### 4.4 Flag Anonymous Roles

If any flow has `Anonymous Users` assigned, note this — the HTML plan renders a warning banner and the confirm step must explicitly surface it.

**Output**: Per-flow role sets with reasoning, list of roles that need creating

---

## Phase 5: Review Plan

**Goal**: Render the HTML plan for all flows and get user approval before writing any files

**Actions**:

### 5.1 Build Plan Data

Assemble the plan JSON (kept in memory — not written to disk). Include all selected flows in `CLOUD_FLOWS_DATA`, distinguishing `new` from `integration-only`:

```json
{
  "SITE_NAME": "<site name>",
  "PLAN_TITLE": "Cloud Flow Integration Plan",
  "SUMMARY": "<N new flows + M integration-only flows, scenarios, key role assignments>",
  "WEB_ROLES_DATA": [
    {
      "id": "<uuid or temp-id>",
      "name": "<role name>",
      "desc": "<description>",
      "builtin": false,
      "isNew": true,
      "isAnonymous": false,
      "color": "#0078d4"
    }
  ],
  "CLOUD_FLOWS_DATA": [
    {
      "flowId": "<workflowEntityId>",
      "name": "<flow display name>",
      "displayName": "<flow display name>",
      "description": "<flow description>",
      "state": "Active",
      "tag": "new | integration-only",
      "scenario": "<scenario type>",
      "rationale": "<why this flow is being added or where it will be additionally integrated>",
      "webRoles": [
        { "id": "<role-uuid>", "reasoning": "<why this role>" }
      ]
    }
  ],
  "RATIONALE_DATA": [
    { "icon": "⚡", "title": "<title>", "desc": "<reasoning>" }
  ]
}
```

For **`integration-only`** flows, `webRoles` should reflect the existing roles from the `.cloudflowconsumer.yml` (read-only — not being changed). The `rationale` should describe where the flow will be additionally integrated (e.g., "Wiring existing Contact Form flow into the support page").
```

### 5.2 Render HTML Plan

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-cloudflow-plan.js" \
  --output "<PROJECT_ROOT>/docs/cloud-flow-plan.html" \
  --data-inline '<json>'
```

The render script refuses to overwrite existing files. Before calling it, check if the default output path (`<PROJECT_ROOT>/docs/cloud-flow-plan.html`) already exists. If it does, choose a new descriptive filename based on context — e.g., `cloud-flow-plan-contact-form.html`, `cloud-flow-plan-apr-2026.html`. Pass the chosen name via `--output`.

Open the rendered file in the default browser (`open` on macOS, `start` on Windows, `xdg-open` on Linux).

### 5.3 Confirm with User

Give a brief CLI summary: number of flows, scenarios, role count, any anonymous-role warnings.

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Review the cloud flow plan in the browser. Does it look correct? | Approve and implement (Recommended), Request changes, Cancel |

**If "Request changes"**: Ask what to change, update, re-render, and present again.
**If "Cancel"**: Stop.

**Output**: User-approved plan for all flows

---

## Phase 6: Create Metadata

**Goal**: Create web roles (if any are new) then write a `.cloudflowconsumer.yml` for every **`new`** flow in the approved plan

> **Skip for `integration-only` flows** — these already have `.cloudflowconsumer.yml` and web roles. Do not recreate or modify their metadata. They will be handled in Phase 7 (client-side integration only).

If the approved plan contains **only** `integration-only` flows (no `new` flows), skip this entire phase and proceed to Phase 7.

**Actions**:

### 6.1 Create Missing Web Roles

If the approved plan includes roles that do not yet exist (for `new` flows), invoke `/create-webroles` now.

After it completes, re-read `.powerpages-site/web-roles/` to collect `id` values for all new roles.

### 6.2 Process Each New Flow

Repeat steps 6.3–6.4 for every **`new`** flow in the approved plan.

### 6.3 Determine Flow API URL

```
/_api/cloudflow/v1.0/trigger/<workflowEntityId>
```

### 6.4 Run the Create Metadata Script

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/add-cloud-flow/scripts/create-cloud-flow-metadata.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --fileSlug "<url-safe-slug>" \
  --flowName "<flow-display-name>" \
  --flowId "<workflowEntityId>" \
  --flowTriggerUrl "" \
  --flowApiUrl "/_api/cloudflow/v1.0/trigger/<workflowEntityId>" \
  --webRoleIds "<uuid1>,<uuid2>" \
  --metadata "<flow-display-name>"
```

`--fileSlug`: lowercase display name, special characters replaced with hyphens, max 50 chars.
`--flowName`: display name written as-is into the `name` YAML field.

The generated YAML (PAC CLI code-site git format):
- `adx_*` scalar prefix stripped: `adx_flowapiurl` → `flowapiurl`, `adx_processid` → `processid`
- `adx_cloudflowconsumerid` → `id`; `adx_websiteid` omitted
- M2M key `adx_CloudFlowConsumer_adx_webrole` kept as-is
- `statecode`/`statuscode` defaults omitted; empty strings written as `''`
- Fields alphabetically sorted

### 6.5 Git Commit

After all YAML files (and any new web roles) are created, do a single git commit. Include the HTML plan file (use the actual output path from the render script's JSON response).

**Output**: One `.cloudflowconsumer.yml` per `new` flow, committed (skipped for `integration-only` flows)

---

## Phase 7: Client-Side Integration

**Goal**: Generate typed service code that calls each registered flow from the site's frontend

Cloud flows are invoked via an authenticated POST to `/_api/cloudflow/v1.0/trigger/<workflowEntityId>`. The request must include a CSRF token fetched from `/_layout/tokenhtml`, and the payload must be wrapped in an `eventData` key as a JSON-stringified string.

**Actions**:

### 7.1 Discover Existing Frontend Patterns

Use the Explore agent to scan the site:

> "Check the Power Pages site frontend for existing patterns. Look for:
> 1. Any existing API service files in `src/shared/`, `src/services/`, `src/api/`, or similar
> 2. Existing CSRF token handling (`__RequestVerificationToken`, `_layout/tokenhtml`)
> 3. The framework (React / Vue / Angular / Astro) and its conventions (hooks, composables, services)
> 4. Any existing cloud flow calls (`/_api/cloudflow/`) already in the codebase — note which flows are already called and from which pages/components
> Report all findings."

For **`integration-only`** flows, the Explore agent's findings in point 4 are critical — they reveal where the flow is already wired in, so the new integration targets a different page/component without duplicating existing call sites.

### 7.2 Create or Update the Cloud Flow Service

> **Do not use the site's existing OData fetch wrapper for cloud flow triggers.**
>
> If the site has a centralized API client (e.g. `powerPagesFetch`) that targets the Dataverse Web API, do not use it here. Cloud flow trigger URLs (`/_api/cloudflow/v1.0/trigger/...`) are a different endpoint that does not accept OData-specific request headers. Using an OData wrapper will cause the request to fail.
>
> Use direct `fetch` or an equivalent low-level HTTP client (for example, Angular's `HttpClient`) for cloud flow calls. Do not use any OData-specific wrappers or helpers that automatically add Dataverse Web API headers. You may reuse the site's existing CSRF token helper if one is exported — but perform the HTTP request via `fetch` or the chosen low-level client directly.

Based on the framework and existing patterns:

**If the site already has an API service layer**: add the new flow functions to it.
**If no service layer exists**: create `src/services/cloudFlowService.{ts,js}` (or framework equivalent).

For **`integration-only`** flows: if a trigger function already exists in the service file, do **not** create a duplicate — reuse it. Only add a new trigger function if the flow has no existing function in the codebase.

#### Service structure

> **REQUIRED for every flow trigger call — without these headers the request returns a 500 error:**
> - `__RequestVerificationToken`: CSRF token fetched from `/_layout/tokenhtml`
> - `X-Requested-With`: `XMLHttpRequest`

> **The payload must be wrapped in `eventData` as a JSON-stringified string** — this is the shape the Power Pages cloud flow endpoint expects:
> ```json
> { "eventData": "{\"Email\":\"abc@contoso.com\"}" }
> ```

The service file must contain a `getCsrfToken` helper and one trigger function per flow. If a `getCsrfToken` helper already exists in the codebase, reuse it; otherwise create it. Either way, every trigger function **must** call it and include both headers shown above.

**CSRF helper** (reuse existing or create):

```typescript
async function getCsrfToken(): Promise<string> {
  const res = await fetch('/_layout/tokenhtml');
  const html = await res.text();
  const match = html.match(/value="([^"]+)"/);
  if (!match) throw new Error('CSRF token not found');
  return match[1];
}
```

**Per-flow trigger function** (one per registered flow):

```typescript
// Trigger: <flow display name>
// API: /_api/cloudflow/v1.0/trigger/<workflowEntityId>
export async function <camelCaseFunctionName>(payload: Record<string, unknown> = {}): Promise<unknown> {
  const token = await getCsrfToken();
  const response = await fetch('/_api/cloudflow/v1.0/trigger/<workflowEntityId>', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      '__RequestVerificationToken': token,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({ eventData: JSON.stringify(payload) }),
  });
  if (!response.ok) {
    throw new Error(`Cloud flow trigger failed: ${response.status} ${response.statusText}`);
  }
  // 202 Accepted = flow has no Response action (fire-and-forget); 200 OK = flow returns data
  if (response.status === 202) return null;
  return response.json();
}
```

**Framework-specific patterns:**

| Framework | Convention | Output |
|-----------|-----------|--------|
| React | Custom hook `useCloudFlow<Name>()` wrapping the service function with loading/error state | `src/hooks/useCloudFlow.ts` |
| Vue | Composable `useCloudFlow<Name>()` with `ref` for loading/error | `src/composables/useCloudFlow.ts` |
| Angular | Injectable `CloudFlowService` that wraps the same raw `fetch` trigger function shown above (do not switch to `HttpClient` unless you preserve the exact headers and `eventData` payload shape) | `src/app/services/cloud-flow.service.ts` |
| Astro | Plain async utility functions (no framework wrapper needed) | `src/utils/cloudFlow.ts` |

Group all flow functions together in one file. Do not create a separate file per flow.

### 7.3 Wire into UI

Read the relevant pages/components, add call sites, loading states, success/error feedback. Replace any placeholder or mock handlers that are meant to be backed by the flows.

For **`integration-only`** flows, this is the primary deliverable of the entire skill run. Identify the **new** target page or component where the flow should be integrated (based on the user's request and the scenario from Phase 3.3), import the existing trigger function, and wire it in with proper loading/error handling. Do **not** modify existing call sites that already work.

### 7.4 Git Commit

Commit service file and any UI changes.

**Output**: `cloudFlowService.{ts,js}` (or equivalent) created/updated, UI wired

---

## Phase 8: Verify & Summarize

**Goal**: Validate all created YAMLs, record skill usage, present summary, offer deployment

**Actions**:

### 8.1 Validate Each YAML

> **Skip for `integration-only` flows** — their YAML was not created or modified by this run. Only validate YAMLs for `new` flows.

For each created `.cloudflowconsumer.yml`, verify:

- [ ] `id` is a valid UUID
- [ ] `processid` matches the flow's `workflowEntityId`
- [ ] `adx_CloudFlowConsumer_adx_webrole` is non-empty
- [ ] All role UUIDs in the array correspond to existing `.webrole.yml` files
- [ ] `name` equals the flow's display name
- [ ] No `adx_`-prefixed scalar fields (no `adx_processid`, `adx_websiteid`, `adx_name`)
- [ ] `statecode` and `statuscode` are absent

### 8.1b Validate Client-Side Integration

Read the service file created in Phase 7 and verify:

- [ ] Service file exists at the expected path (e.g. `src/services/cloudFlowService.ts` or framework equivalent)
- [ ] A `getCsrfToken` helper is present — either defined in the file or imported from another module
- [ ] Every registered flow has a corresponding exported trigger function
- [ ] Each trigger function calls `getCsrfToken()` and sets **both** required headers:
  - `__RequestVerificationToken` set to the CSRF token value
  - `X-Requested-With: XMLHttpRequest`
- [ ] Each trigger function's fetch URL exactly matches `/_api/cloudflow/v1.0/trigger/<workflowEntityId>` for the correct flow
- [ ] The request body wraps the payload as `JSON.stringify({ eventData: JSON.stringify(payload) })` — not a bare `JSON.stringify(payload)`
- [ ] No OData-specific wrapper (e.g. `powerPagesFetch`) is used — raw `fetch` only
- [ ] At least one UI component or page imports and calls the trigger function(s)

If any check fails, fix the issue in the service file or UI before continuing.

### 8.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Use `--skillName "AddCloudFlow"`.

### 8.3 Present Summary

| Step | Status | Details |
|------|--------|---------|
| New flows added | Done / N/A | List each `new` flow name (or "N/A" if all were integration-only) |
| Integration-only flows | Done / N/A | List each `integration-only` flow name and target page/component |
| Scenarios | Identified | One line per flow |
| Web roles | Created/Existing/Skipped | List role names (skipped for integration-only) |
| Metadata files | Created/Skipped | List each `.cloudflowconsumer.yml` path (skipped for integration-only) |
| Client service | Created/Updated | Path to service file |
| UI integration | Done | Components/pages updated (new call sites for all flows) |
| HTML Plan | Created | Actual path from render script output |

### 8.4 Ask to Deploy

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Everything is ready. Deploy the site to make the flows live? | Yes, deploy now (Recommended), No, I'll deploy later |

**If "Yes"**: Invoke `/deploy-site`. After it succeeds, use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Would you like to run `/test-site` to verify the cloud flow integration end-to-end? | Yes, run tests, No, I'll test manually |

**If "Yes, run tests"**: Invoke `/test-site` with context: test the scenario where the flow API is triggered — perform the action on the site (e.g. submit the form, click the button) that calls `/_api/cloudflow/v1.0/trigger/<workflowEntityId>`, confirm the request returns 202 Accepted or 200 OK, and check Power Automate run history to confirm the flow executed.

**If "No"**: Remind the user that flows and client-side calls won't work until deployed, and suggest running `/test-site` later to validate the flow trigger works correctly in the deployed environment.

### 8.5 Post-Deploy Notes

- **Flow trigger URL**: Populated automatically by the portal runtime after deploy. Check Power Pages design studio to confirm.
- **Testing**: Use `/test-site` to verify the integration. Sign in as a user with the assigned role, trigger the flow action, confirm `/_api/cloudflow/v1.0/trigger/<id>` returns 202/200, and check Power Automate run history.
- **Anonymous flows**: Test in an incognito window.
- **Role changes**: Edit `adx_CloudFlowConsumer_adx_webrole` in the YAML, then redeploy.
- **Adding more flows later**: Run this skill again — new flows are available for full setup, and already-registered flows are available for additional frontend integration on other pages.

---

## Important Notes

### Throughout All Phases

- **Multiple flows**: Process all flows in the approved plan before committing or moving to Phase 7
- **Minimum roles**: Never assign all roles by default; use only what the scenario requires
- **Anonymous Users**: Always surface explicitly in plan and confirm step
- **Trigger URL blank at creation**: Expected — set by the portal runtime at deploy time
- **fileSlug vs flowName**: `--fileSlug` is the filename only; `--flowName` is the `name` YAML field
- **Client service file**: Group all flows into one service file, not one file per flow; always wire into the UI without asking
- **CSRF headers are mandatory**: Every flow trigger function must call `getCsrfToken()` and send both `__RequestVerificationToken` and `X-Requested-With: XMLHttpRequest` — omitting either causes a 500 error
- **Payload shape**: The request body must be `JSON.stringify({ eventData: JSON.stringify(payload) })` — the cloud flow endpoint expects the payload nested under an `eventData` key as a double-stringified JSON string
- **Integration-only flows**: Already-registered flows skip Phases 4–6 (roles and metadata). Their primary deliverable is new frontend call sites in Phase 7. Do not modify existing `.cloudflowconsumer.yml` files or web role assignments for these flows. Reuse existing trigger functions when they already exist in the service file — only add new UI call sites.
- **No flows available**: When no flows with a PowerPages trigger exist in the environment (zero results from API), stop the workflow and direct the user to create a flow in Power Automate with the "When a Power Pages flow step is run" trigger first.

### Key Decision Points (Wait for User)

1. Phase 1.3: Deploy now or cancel (if `.powerpages-site` missing)
2. Phase 3.1: Which flows to add or integrate (new and/or already-registered)
3. Phase 3.3: Clarify scenario / audience per flow (if unclear)
4. Phase 5.3: Approve HTML plan before writing any files
5. Phase 8.4: Deploy now or later

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify prerequisites | Verifying prerequisites | Locate project, confirm .powerpages-site, read web roles and existing flows, detect framework |
| List available flows | Fetching cloud flows | Call Flow RP API to get flows with PowerPages trigger |
| Select flows and understand scenarios | Gathering scenario details | User picks one or more flows; determine scenario and function names |
| Determine web roles | Analyzing role requirements | Propose minimum roles per flow with per-role reasoning |
| Review plan | Reviewing plan with user | Render HTML plan for all flows and get approval |
| Create metadata | Writing cloud flow metadata | Create missing web roles then write YAML for each flow |
| Client-side integration | Generating client-side code | Create typed service functions and wire into UI |
| Verify and summarize | Validating and summarizing | Validate YAMLs, record skill usage, present summary, offer deployment |

Mark each task `in_progress` when starting and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Prerequisites**
