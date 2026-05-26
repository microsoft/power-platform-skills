---
name: activate-site
description: >-
  Activates and provisions a Power Pages website in a Power Platform environment
  via the Power Platform REST API. Use when the user wants to activate, provision,
  turn on, or enable a Power Pages website or portal.
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Activate Power Pages Site

Provision a new Power Pages website in a Power Platform environment via the Power Platform REST API.

> **Prerequisite:** This skill expects an existing Power Pages code site created via `/create-site`. Run that skill first if the site does not exist yet.

## Core Principles

- **Cloud-aware URL resolution** — Never hardcode API base URLs or site URL domains. Always derive them from the Cloud value returned by `pac auth who`.
- **Token handling** — Scripts acquire and refresh Azure CLI tokens internally. The agent only needs to verify the user is logged in to Azure CLI.
- **Confirm before mutating** — Always present the full activation parameters to the user and get explicit approval before POSTing to the websites API.

**Initial request:** $ARGUMENTS

## Workflow

1. **Phase 1: Verify Prerequisites** — PAC CLI auth + Azure CLI login + activation status check
2. **Phase 2: Gather Parameters** — Site name, subdomain, website record ID
3. **Phase 3: Confirm** — Present all parameters to user for approval
4. **Phase 4: Activate & Poll** — Run activation script (POST + poll provisioning status)
5. **Phase 5: Present Summary** — Show site URL, suggest next steps

---

## Phase 1: Verify Prerequisites

**Goal:** Ensure PAC CLI is installed and authenticated, and verify the user is logged in to Azure CLI (scripts handle token acquisition internally).

### Actions

#### 1.1 Verify PAC CLI

Run `pac help` to check if the PAC CLI is installed and available on the system PATH.

```bash
pac help
```

**If the command fails** (command not found / not recognized):

1. Tell the user: "PAC CLI is not installed. You can install it by running:"

   ```bash
   dotnet tool install --global Microsoft.PowerApps.CLI.Tool
   ```

2. If `dotnet` is also not available, direct the user to <https://aka.ms/PowerPlatformCLI> for full installation instructions.
3. After installation, verify by running `pac help` again.

#### 1.2 Check Authentication

Run `pac auth who` to check current authentication status.

```bash
pac auth who
```

**If authenticated**: Extract these values from the output:

- **Environment ID** — the GUID after `Environment ID:`
- **Organization ID** — the GUID after `Organization ID:` (this is the Dataverse org ID)
- **Cloud** — the value after `Cloud:` (e.g., `Public`, `UsGov`, `UsGovHigh`, `UsGovDod`, `China`)

**If not authenticated**: Follow the same authentication flow as `deploy-site` — ask the user for their environment URL and run `pac auth create --environment "<URL>"`.

#### 1.3 Verify Azure CLI Login

Verify the user is logged in to Azure CLI (the activation scripts acquire tokens internally):

```bash
az account show
```

**If `az` is not installed or not logged in**: Instruct the user to install Azure CLI and run `az login --allow-no-subscriptions` (this form works whether or not the user has an Azure subscription — the activation flow only needs an AAD token).

#### 1.4 Check If Already Activated

Before gathering parameters, check whether the site is already activated by running the shared activation status script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "<PROJECT_ROOT>"
```

Where `<PROJECT_ROOT>` is the directory containing `powerpages.config.json` or `.powerpages-site` folder.
Evaluate the JSON result:

- **If `activated` is `true`**: Inform the user their site is already activated at `websiteUrl`. Suggest next steps (Phase 5.3) and stop — do NOT proceed to Phase 2.
- **If `activated` is `false`**: Proceed to Phase 2.
- **If `error` is present**: Proceed to Phase 2 (do not block the activation flow).

### Output

- PAC CLI installed and authenticated
- Environment ID, Organization ID, and Cloud value extracted
- Azure CLI login confirmed
- Activation status checked (already activated → stop early, not activated → continue)

---

## Phase 2: Gather Parameters

**Goal:** Determine the site name, generate or accept a subdomain, and look up the website record ID needed for the activation API call.

### Actions

#### 2.1 Read Site Name

Look for `powerpages.config.json` in the current directory or one level of subdirectories using `Glob`:

```text
**/powerpages.config.json
```

Read the file and extract the `siteName` field. If not found, ask the user for the site name using `AskUserQuestion`.

#### 2.2 Generate Subdomain Suggestion

> **CRITICAL — This step is MANDATORY. You MUST ask the user about the subdomain before proceeding. Do NOT skip this step or auto-select a subdomain without user input.**

Run the subdomain generator script to create a random suggestion:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/activate-site/scripts/generate-subdomain.js"
```

This outputs a string like `site-a3f2b1`. Resolve the correct site URL domain from the **Cloud** value obtained in Phase 1.2:

| Cloud | Site URL Domain |
|---|---|
| `Public` | `powerappsportals.com` |
| `UsGov` | `powerappsportals.us` |
| `UsGovHigh` | `high.powerappsportals.us` |
| `UsGovDod` | `appsplatform.us` |
| `China` | `powerappsportals.cn` |

<!-- gate: activate-site:2.2.subdomain | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · activate-site:2.2.subdomain):** Confirm or override the generated subdomain. Subdomain is part of the resulting site URL; Cancel exits before any provisioning call.

Present the generated subdomain to the user and ask them to accept or enter their own using `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Your site subdomain will be: **`<suggestion>`** (full URL: `https://<suggestion>.<siteUrlDomain>`). Would you like to use this subdomain or enter your own? | Subdomain | Use `<suggestion>` (Recommended), Enter a custom subdomain |

**If custom**: The user provides their own subdomain via "Other" free text input. Validate it is lowercase, alphanumeric with hyphens only, and 3-50 characters.

#### 2.3 Get Website Record ID

Run `pac pages list` to get the website record ID:

```bash
pac pages list
```

Parse the output to find the website record that matches the site name. Extract the `Website Record ID` (GUID). If `pac pages list` returns no results or the command is not available, set `websiteRecordId` to `$null` — the API will create a new website record.

### Output

- Site name determined (from config file or user input)
- Subdomain chosen (generated or custom)
- Website record ID resolved (GUID or null)

---

## Phase 3: Confirm

**Goal:** Present all activation parameters to the user and get explicit approval before making the API call.

### Actions

<!-- gate: activate-site:3.confirm | category=final | cancel-leaves=nothing -->
> 🚦 **Gate (final · activate-site:3.confirm):** Last-call before the activation API call. All activation parameters echoed back; Cancel exits cleanly before provisioning. **Fires fresh on every skill invocation.** When `plan-alm` orchestrates multi-stage activation (Staging + Production), it invokes `activate-site` **once per stage** — each invocation hits this gate fresh with its own `siteName`, `subdomain`, and target env. The Staging activation consent does NOT cover Production. Each stage's site URL is a separate go-live decision (different audiences, different timing).

Present all activation parameters to the user using `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Ready to activate your Power Pages site with these settings:\n\n- **Site name**: `<siteName>`\n- **Subdomain**: `<subdomain>.powerappsportals.com`\n- **Environment ID**: `<environmentId>`\n\nProceed with activation? | Activate | Yes, activate the site (Recommended), No, cancel |

**If "No"**: Stop the skill and inform the user they can re-run it later.

**If "Yes"**: Proceed to Phase 4.

### Output

- User has explicitly approved the activation parameters

---

## Phase 4: Activate & Poll

**Goal:** POST to the Power Platform websites API to start provisioning, poll until completion, and report the result.

### Actions

#### 4.1 Run Activation Script

Run the shared activation script, passing all parameters gathered in Phases 1–2:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/activate-site/scripts/activate-site.js" --siteName "<siteName>" --subdomain "<subdomain>" --organizationId "<organizationId>" --environmentId "<environmentId>" --cloud "<cloud>" --websiteRecordId "<websiteRecordId>"
```

Omit `--websiteRecordId` if it is null/empty.

The script acquires an Azure CLI token, POSTs to the websites API, extracts the `Operation-Location` header, and polls every 10 seconds for up to 5 minutes (refreshing the token periodically). It outputs a JSON result to stdout.

> **Note:** This script may run for up to 5 minutes while polling. Use a Bash timeout of at least 360 seconds (6 minutes).

#### 4.2 Handle Results

Evaluate the JSON output:

| `status` value | `statusCode` / `errorCode` | Action |
|---|---|---|
| **`Succeeded`** | — | Provisioning complete. The result includes `siteUrl`. Proceed to Phase 5. |
| **`Failed`** | `400` + `SubdomainConflict` (or error message mentions subdomain) | Subdomain already taken. Loop back to Phase 2 action 2.2 for a new subdomain, then re-run the script. |
| **`Failed`** | `401` | Token expired. Ask the user to run `az login --allow-no-subscriptions` and retry. |
| **`Failed`** | `403` | Insufficient permissions. Inform user they need the "Power Pages site creator" or "System Administrator" role. |
| **`Failed`** | `409` | Website already exists. Inform user and suggest using `/deploy-site` instead. |
| **`Failed`** | `429` or `5xx` | Throttling or server error. Wait 5 seconds and re-run the script once. |
| **`Failed`** | other | Present the error to the user and help troubleshoot. |
| **`Running`** | — | Provisioning still in progress after 5 minutes. Inform the user it may take up to 15 minutes and suggest checking the Power Platform admin center. |
| `error` field | — | Prerequisite failure (missing args, no token). Present the error and help troubleshoot. |

### Output

- Provisioning status resolved (Succeeded with `siteUrl`, Failed with error details, or Running with timeout advisory)

---

## Phase 5: Present Summary

**Goal:** Show the user the final site URL and suggest next steps.

### Actions

#### 5.1 Show Results

Present the activation summary using the `siteUrl` from the script output:

```
Power Pages site activated successfully!

  Site Name:  <siteName>
  Site URL:   <siteUrl>
  Environment: <environmentName> (<environmentId>)
  Status:     Provisioned
```

The script already resolves the correct cloud-specific site URL domain, so use the `siteUrl` value directly.

#### 5.1b Write `docs/alm/last-activate.json` Marker

For consumers like the rendered ALM plan (Manual path's per-target Activate steps), write a structured marker that captures the post-activation state. Ensure the `docs/alm/` directory exists first:

```bash
node -e "require('fs').mkdirSync('docs/alm',{recursive:true})"
# Determine the stage label this activation was for. plan-alm orchestration
# passes it via context (e.g. "Staging", "Production"); standalone invocations
# may leave it null — refreshActivateSite falls back to env-URL matching
# against planData.stages[].envUrl.
node -e "require('fs').writeFileSync('docs/alm/last-activate.json', JSON.stringify({
  stageName: <stageNameOrNull>,
  siteName: '<siteName>',
  siteUrl: '<siteUrl>',
  websiteRecordId: '<websiteRecordId>',
  environmentUrl: '<envUrl>',
  environmentId: '<environmentId>',
  activatedAt: new Date().toISOString(),
  status: 'Activated',
  cloud: '<cloud>',
}, null, 2))"
```

When the activation was an **already-activated** detection (Phase 1.4), still write the marker — the rendered plan should reflect "this stage is live at https://..." regardless of whether activation was performed this run or pre-existing. Set `status: 'AlreadyActivated'` and use the existing `siteUrl` from Phase 1.4's check.

#### 5.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "ActivateSite"`.

#### 5.2b Refresh the ALM plan (if one exists)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase activate-site \
  --stageName "{stageNameOrEmpty}" \
  --render
```

`{stageNameOrEmpty}` is the Manual-path target stage label (e.g. `Staging`, `Production`) the agent was activating — usually carried in by plan-alm Phase 7 orchestration. Pass an empty string when unknown; `refreshActivateSite` falls back to URL-matching `docs/alm/last-activate.json`'s `environmentUrl` against `planData.stages[].envUrl`, so standalone invocations still get captured.

The helper reads `docs/alm/last-activate.json`, writes a per-target entry into `planData.activations[stageName]` (siteUrl, status, activatedAt), and re-renders `docs/alm-plan.html` so the matching `Activate site in {stageName}` checklist step shows an `ACTIVATED` badge with the live site URL inline. When `docs/.alm-plan-data.json` is absent (standalone, not via plan-alm), the helper returns `ok:false` as a soft no-op.

#### 5.3 Suggest Next Steps

After the summary, suggest:

- Test the site: `/test-site` — Verify the site loads correctly and API calls are working
- Set up ALM: `/power-pages:plan-alm` — Set up ALM to promote this site to staging or production (creates a solution, configures a deployment pipeline or export/import strategy)
- Set up the data model: `/setup-datamodel`
- Add sample data: `/add-sample-data`
- View the site in the browser at the provisioned URL (note: it may take a few minutes for DNS to propagate)

### Output

- Activation summary presented with site URL
- Next steps suggested to the user

---

## Important Notes

### Progress Tracking

Use `TaskCreate` at the start to track progress through each phase:

| Task | Description |
|------|-------------|
| Phase 1 | Verify Prerequisites — PAC CLI auth, Cloud detection, Azure CLI login, activation status check |
| Phase 2 | Gather Parameters — site name, subdomain, website record ID |
| Phase 3 | Confirm — user approval of activation parameters |
| Phase 4 | Activate & Poll — run activation script, handle result |
| Phase 5 | Present Summary — show site URL and next steps |

Mark each task complete with `TaskUpdate` as you finish each phase.

### Key Decision Points

- **Phase 1.2**: If not authenticated, must authenticate before proceeding — cannot skip.
- **Phase 1.4**: If site is already activated, stop early — do NOT proceed to Phase 2.
- **Phase 2.2**: User may accept the generated subdomain or provide a custom one — validate custom input.
- **Phase 3**: User must explicitly approve activation. If declined, stop the skill entirely.
- **Phase 4.2**: On 400 (subdomain taken), loop back to Phase 2 action 2.2 and re-run the script — do not abort.
- **Phase 4.2**: On 409 (site already exists), redirect user to `/deploy-site` instead.
- **Phase 4.2**: On timeout (still Running after 5 minutes), do not treat as failure — advise user to check admin center.

**Begin with Phase 1: Verify Prerequisites**
