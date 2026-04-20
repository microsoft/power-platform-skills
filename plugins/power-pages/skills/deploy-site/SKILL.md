---
name: deploy-site
description: >-
  Deploys an existing Power Pages code site to a Power Pages environment using PAC CLI.
  Handles tooling verification, authentication, environment confirmation, building, and
  uploading. Use when the user wants to deploy, upload, or publish their code site.
user-invocable: true
allowed-tools: Read, Bash, AskUserQuestion, Glob, Grep, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Deploy Power Pages Code Site

Guide the user through deploying an existing Power Pages code site to a Power Pages environment using PAC CLI. Follow a systematic approach: verify tooling, authenticate, confirm the target environment, build and upload the site, and handle any blockers.

## Core Principles

- **Verify before acting**: Always confirm PAC CLI availability, authentication status, and the target environment before attempting any deployment.
- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases — create the todo list upfront with all phases before starting any work.
- **Never change environment settings without consent**: If deployment requires modifying environment configuration (e.g., unblocking JavaScript attachments), always explain the change and get explicit user permission first.

**Initial request:** $ARGUMENTS

---

## Phase 1: Verify PAC CLI

**Goal**: Ensure PAC CLI is installed and available on the system PATH

**Actions**:

1. Create todo list with all 6 phases (see [Progress Tracking](#progress-tracking) table)
2. Run `pac help` to check if the PAC CLI is installed and available on the system PATH.

   ```powershell
   pac help
   ```

3. **If the command succeeds**: PAC CLI is installed. Proceed to Phase 2.

4. **If the command fails** (command not found / not recognized):

   1. Inform the user that PAC CLI is required but not installed.
   2. Fetch installation instructions from `https://aka.ms/PowerPlatformCLI` using the following approach:
      - Tell the user: "PAC CLI is not installed. You can install it by running:"

        ```powershell
        dotnet tool install --global Microsoft.PowerApps.CLI.Tool
        ```

      - If `dotnet` is also not available, direct the user to <https://aka.ms/PowerPlatformCLI> for full installation instructions including .NET SDK setup.

   3. After installation, verify by running `pac help` again.
   4. If it still fails, stop and ask the user to resolve the installation manually.

**Output**: PAC CLI installed and verified

---

## Phase 2: Verify Authentication

**Goal**: Ensure the user is authenticated with PAC CLI and has a valid session

**Actions**:

1. Run `pac auth who` to check the current authentication status.

   ```powershell
   pac auth who
   ```

2. **If authenticated**: Extract the following values from the output:
   - **Environment name** and **URL**
   - **Environment ID** — the GUID after `Environment ID:`
   - **Cloud** — the value after `Cloud:` (e.g., `Public`, `UsGov`, `UsGovHigh`, `UsGovDod`, `China`)

   Proceed to Phase 3.

3. **If not authenticated**:

   1. Inform the user they are not authenticated with PAC CLI.
   2. Use `AskUserQuestion` to ask for the environment URL:

      | Question | Header | Options |
      |----------|--------|---------|
      | You are not authenticated with PAC CLI. Please provide your Power Pages environment URL (e.g., `https://org12345.crm.dynamics.com`) so I can authenticate you. | Auth | *(free text input via "Other")* |

      Provide two placeholder options to guide the user:
      - "I'll paste the URL" (description: "Select 'Other' below and paste your environment URL")
      - "I don't know my URL" (description: "You can find it in the Power Platform admin center under Environments > your environment > Environment URL")

   3. Once the user provides the URL, run the authentication command:

      ```powershell
      pac auth create --environment "<USER_PROVIDED_URL>"
      ```

      This will open a browser window for the user to sign in.

   4. After the command completes, verify by running `pac auth who` again.
   5. If authentication succeeds, proceed to Phase 3.
   6. If authentication fails, present the error to the user and help them troubleshoot.

**Output**: Authenticated PAC CLI session with environment name and URL extracted

---

## Phase 3: Confirm Environment

**Goal**: Ensure the user is deploying to the correct target environment

**Actions**:

1. Present the current environment information to the user and ask them to confirm.

   Use `AskUserQuestion` with the following structure:

   | Question | Header | Options |
   |----------|--------|---------|
   | You are currently connected to environment: **<ENV_NAME>** (<ENV_URL>). Do you want to deploy to this environment? | Environment | Yes, use this environment, No, let me choose a different one |

2. **If "Yes, use this environment"**: Proceed to Phase 4.

3. **If "No, let me choose a different one"**:

   1. Run `pac org list` to retrieve all available environments:

      ```powershell
      pac org list
      ```

   2. Parse the output to extract environment names and URLs.
   3. Use `AskUserQuestion` to present the available environments as options (pick up to 4 most relevant, or let user specify).
   4. Once the user selects an environment, switch to it:

      ```powershell
      pac org select --environment "<SELECTED_ENV_ID_OR_URL>"
      ```

   5. Verify the switch by running `pac auth who` again.

**Output**: Confirmed target environment for deployment

---

## Phase 4: Deploy the Code Site

**Goal**: Locate the project, build it, and upload to Power Pages

**Actions**:

### 4.1 Locate the Project Root

Determine the project root directory. The project root is the directory containing `powerpages.config.json`. Use `Glob` to search for it:

```text
**/powerpages.config.json
```

If found in the current working directory or a subdirectory, use that directory as `PROJECT_ROOT`. If multiple are found, ask the user which one to deploy using `AskUserQuestion`.

If not found, ask the user to provide the path to the project root.

### 4.2 Offer Permissions Audit (Redeployments Only)

If `.powerpages-site` already exists (i.e., this is not the first deployment), table permissions and site settings may have drifted from the code since the last deployment. Offer to audit before deploying.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| This site has been deployed before. Would you like to run a permissions audit to verify table permissions match your current code before deploying? | Audit | Yes, audit permissions (Recommended), Skip — permissions are up to date |

**If "Yes"**: Invoke `/audit-permissions` to run the audit. After the audit completes, resume with Step 4.3.
**If "Skip"**: Proceed to Step 4.3.

If `.powerpages-site` does **not** exist (first deployment), skip this step — there are no existing permissions to audit.

### 4.3 Build the Site

Before uploading, ensure the site is built:

```powershell
cd "<PROJECT_ROOT>"
npm run build
```

If the build fails, stop and help the user fix the build errors before retrying.

### 4.4 Upload to Power Pages

Run the upload command:

```powershell
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

**If the upload succeeds**: Proceed to Phase 5 to verify the deployment.

**If the upload fails**: Check the error message:

- If the failure is related to **blocked JavaScript** (`.js`) attachments → proceed to **Phase 6**
- If the failure mentions **`.html` type attachments are currently blocked** → this is a **misleading error**. See [Troubleshooting: HTML Blocked Attachment Error](#troubleshooting-html-blocked-attachment-error) below
- For other errors → present the error to the user and help them troubleshoot

**Output**: Site built and uploaded to Power Pages

---

## Phase 5: Verify Deployment

**Goal**: Confirm the deployment was successful and handle post-deployment steps

**Actions**:

### 5.1 Verify `.powerpages-site` Folder

Confirm `.powerpages-site` exists and list its contents (`web-roles/`, `site-settings/`, `table-permissions/`).

### 5.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "DeploySite"`.

### 5.3 Confirm Upload Output

Review the output from the `pac pages upload-code-site` command in Phase 4 (or Phase 6 retry). Verify it reported a successful upload with no errors.

### 5.4 Commit Changes

Stage and commit deployment artifacts:

```powershell
git add -A
git commit -m "Deploy site to Power Pages"
```

### 5.5 Check Activation Status

Run the activation status check:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "<PROJECT_ROOT>"
```

Evaluate the JSON result:

- **If `activated` is `true`**: Inform the user their site is already activated (show `websiteUrl` if present). Proceed to step 5.6, then skip to [Suggest Next Steps](#suggest-next-steps). Do NOT ask about activation.
- **If `activated` is `false`**: Proceed to step 5.5.1.
- **If `error` is present**: Fall back to step 5.5.1. Do not block the deployment flow.

#### 5.5.1 Ask About Activation (only if site is NOT already activated)

Ask the user if they want to activate the site using `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Site deployed successfully! Would you like to activate (provision) the site now so it gets a live URL? | Activate | Activate now (Recommended) — Provision the site with a subdomain and make it live, Skip for now — I'll activate later |

**If "Activate now"**: Invoke the `/activate-site` skill. After activation completes, proceed to step 5.6 to clear the site cache.
**If "Skip for now"**: Suggest next steps (see [Suggest Next Steps](#suggest-next-steps)).

### 5.6 Clear Site Cache (Only If Activated)

After confirming the site is activated (either it was already activated in step 5.5, or the user just activated it in step 5.5.1), offer to clear the runtime cache so the deployed changes are immediately visible.

**Prerequisites**: The site must be activated and the project root must be known (from Phase 4.1).

Use `AskUserQuestion` to confirm before proceeding:

| Question | Header | Options |
|----------|--------|---------|
| Would you like to restart the site so your latest changes are immediately visible? This may cause a brief downtime (a few seconds). | Restart | Yes, restart site (Recommended), Skip — I'll restart later |

**If "Skip"**: Skip to [Suggest Next Steps](#suggest-next-steps).

**If "Yes"**: Run the cache-clearing script, passing the project root:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/clear-site-cache.js" --projectRoot "<PROJECT_ROOT>"
```

The script reads `siteName` from `powerpages.config.json`, looks up the website via the Power Platform admin API, and restarts it to flush the runtime cache.

Evaluate the result:

- **If `success` is `true`**: Inform the user: "Site cache cleared — your latest changes should now be visible at **<websiteUrl>**."
- **If `success` is `false`**: Warn the user that cache clearing failed and show the error, but do not block the deployment flow. The deployment itself succeeded; cache will eventually refresh on its own. Suggest the user can manually clear cache from the Power Pages admin center if needed.

**Output**: Deployment verified, changes committed, activation offered, cache cleared

---

## Phase 6: Handle Blocked JavaScript

**Goal**: Resolve blocked JavaScript attachment errors and retry deployment

**Actions**:

### 6.1 Explain the Issue

Tell the user:
> "The upload failed because JavaScript (.js) file attachments are blocked in your Power Pages environment. This is a security setting that prevents uploading .js files. To deploy a code site, this restriction needs to be relaxed for .js files."

### 6.2 Ask for Permission

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Would you like to remove the JavaScript (.js) block from the environment's blocked attachments list? This is required to deploy code sites. | Unblock JS | Yes, remove the .js block (Recommended), No, do not change environment settings |

**If "No"**: Stop and inform the user that the deployment cannot proceed without unblocking `.js` attachments.

**If "Yes"**: Proceed to 6.3.

### 6.3 Update Blocked Attachments

1. Run `pac env list-settings` to retrieve the current environment settings:

   ```powershell
   pac env list-settings
   ```

2. Find the `blockedattachments` property in the output. It will contain a semicolon-separated list of file extensions (e.g., `ade;adp;app;asa;ashx;asmx;asp;bas;bat;cdx;cer;chm;class;cmd;com;config;cnt;cpl;crt;csh;der;dll;exe;fxp;hlp;hta;htr;htw;ida;idc;idq;inf;ins;isp;its;js;jse;ksh;lnk;mad;maf;mag;mam;maq;mar;mas;mat;mau;mav;maw;mda;mdb;mde;mdt;mdw;mdz;msc;msh;msh1;msh1xml;msh2;msh2xml;mshxml;msi;msp;mst;ops;pcd;pif;prf;prg;printer;pst;reg;rem;scf;scr;sct;shb;shs;shtm;shtml;soap;stm;tmp;url;vb;vbe;vbs;vsmacros;vss;vst;vsw;ws;wsc;wsf;wsh`).

3. Remove `js` from the list. Parse the semicolon-separated values, filter out `js`, and rejoin with semicolons.

4. Update the setting:

   ```powershell
   pac env update-settings --name blockedattachments --value "<UPDATED_LIST_WITHOUT_JS>"
   ```

5. Confirm the update was successful.

### 6.4 Retry Upload

Run the upload command again:

```powershell
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

If it succeeds: Proceed to Phase 5 to verify the deployment.

If it fails again with a different error, present the error to the user and help troubleshoot.

**Output**: JavaScript unblocked and site deployed successfully

---

## Troubleshooting: HTML Blocked Attachment Error

If the upload fails with an error like:

```
Error: Unable to upload webfile name 'index.html' with record Id <GUID> as '.html' type attachments are currently blocked on this environment.
```

**This error is misleading.** The `.html` extension is not actually blocked — the real cause is a stale environment manifest file in the `.powerpages-site` folder. This manifest maps local files to Dataverse record IDs from a previous upload. When the mapping becomes outdated (e.g., after environment changes or record deletions), the upload fails with this confusing error.

### Fix

1. Locate the environment-specific manifest file in the `.powerpages-site` folder. It follows the naming pattern `<environment-host>-manifest.yml` (e.g., `demo1.crm.dynamics.com-manifest.yml`). List the folder contents to find it:

   ```powershell
   Get-ChildItem -Path "<PROJECT_ROOT>/.powerpages-site" -Filter "*-manifest.yml"
   ```

2. Delete the manifest file:

   ```powershell
   Remove-Item -Path "<PROJECT_ROOT>/.powerpages-site/<environment-host>-manifest.yml"
   ```

3. Retry the upload:

   ```powershell
   pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
   ```

If the retry succeeds, proceed to Phase 5. If it fails with a different error, present the error to the user and help them troubleshoot.

> **Important**: Do NOT attempt to unblock `.html` in the environment's blocked attachments list — the error is not caused by the attachment block setting.

---

## Suggest Next Steps

If the user skips activation (or after activation completes), suggest:

- `/activate-site` — Provision the site with a subdomain and make it live (if not already activated)
- `/test-site` — Test the deployed site in the browser (verify pages load, check API calls)
- `/audit-permissions` — Audit table permissions against current code (recommended after redeployments)
- `/setup-datamodel` — Create Dataverse tables for dynamic content
- `/add-seo` — Add meta tags, robots.txt, sitemap.xml, favicon

---

## Important Notes

### NEVER Use `pac pages upload`

Always use `pac pages upload-code-site` — **never** use `pac pages upload`. The `pac pages upload` command is designed for portal-studio-style sites and will corrupt code site metadata if used on a code site project. This applies to every upload step in this skill (Phase 4.4, Phase 6.4, and troubleshooting retries).

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points (see list below)
- **Present errors clearly** — when a command fails, show the user the relevant error output and explain what went wrong before suggesting fixes

### Key Decision Points (Wait for User)

1. After Phase 2: If not authenticated, get environment URL from user
2. At Phase 3: Confirm or switch the target environment
3. At Phase 4.1: If multiple `powerpages.config.json` found, ask which project to deploy
4. At Phase 4.2: Audit permissions now or skip (redeployments only)
5. At Phase 5.5: Activate site now or later
6. At Phase 6: Get permission before modifying blocked attachments setting

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify PAC CLI installation | Verifying PAC CLI | Check if PAC CLI is installed, install if missing |
| Verify authentication | Verifying authentication | Check current auth status, authenticate if needed |
| Confirm target environment | Confirming environment | Show current environment, let user confirm or switch |
| Deploy the code site | Deploying site | Locate project root, build, and upload via pac pages upload-code-site |
| Verify deployment | Verifying deployment | Confirm .powerpages-site folder exists, review upload output, commit changes, offer activation |
| Handle blocked JavaScript | Resolving JS block | If upload fails due to blocked JS, offer to unblock and retry |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. Phase 6 may be marked `completed` immediately if no JavaScript blocking issue is encountered. This gives the user visibility into progress and keeps the workflow deterministic.

---

**Begin with Phase 1: Verify PAC CLI**
