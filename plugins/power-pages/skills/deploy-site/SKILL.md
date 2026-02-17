---
name: deploy-power-pages-site
description: This skill should be used when the user asks to "deploy to power pages", "upload site", "publish site", "deploy site", "push to power pages", "upload code site", or wants to deploy/upload an existing Power Pages code site to a Power Pages environment using PAC CLI.
user-invocable: true
allowed-tools: ["Read", "Bash", "AskUserQuestion", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskList"]
model: opus
---

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
1. Create todo list with all 5 phases (see [Progress Tracking](#progress-tracking) table)
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

      - If `dotnet` is also not available, direct the user to https://aka.ms/PowerPlatformCLI for full installation instructions including .NET SDK setup.

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

2. **If authenticated**: Extract the current environment name and URL from the output. Proceed to Phase 3.

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

### 4.2 Build the Site

Before uploading, ensure the site is built:

```powershell
cd "<PROJECT_ROOT>"
npm run build
```

If the build fails, stop and help the user fix the build errors before retrying.

### 4.3 Upload to Power Pages

Run the upload command:

```powershell
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

**If the upload succeeds**:

1. Inform the user that the site has been deployed successfully. Share the environment URL where they can view their site.
2. Commit the changes:

   ```powershell
   git add -A
   git commit -m "Deploy site to Power Pages"
   ```

3. Ask the user if they want to activate the site using `AskUserQuestion`:

   | Question | Header | Options |
   |----------|--------|---------|
   | Site deployed successfully! Would you like to activate (provision) the site now so it gets a live URL? | Activate | Activate now (Recommended) — Provision the site with a subdomain and make it live, Skip for now — I'll activate later |

4. **If "Activate now"**: Invoke the `/power-pages:activate-site` skill.
5. **If "Skip for now"**: Suggest next steps (see [Suggest Next Steps](#suggest-next-steps)).

**If the upload fails**: Check the error message and proceed to Phase 5 if the failure is related to blocked JavaScript attachments. For other errors, present the error to the user and help them troubleshoot.

**Output**: Site built, uploaded to Power Pages, changes committed, and activation offered

---

## Phase 5: Handle Blocked JavaScript

**Goal**: Resolve blocked JavaScript attachment errors and retry deployment

**Actions**:

### 5.1 Explain the Issue

Tell the user:
> "The upload failed because JavaScript (.js) file attachments are blocked in your Power Pages environment. This is a security setting that prevents uploading .js files. To deploy a code site, this restriction needs to be relaxed for .js files."

### 5.2 Ask for Permission

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Would you like to remove the JavaScript (.js) block from the environment's blocked attachments list? This is required to deploy code sites. | Unblock JS | Yes, remove the .js block (Recommended), No, do not change environment settings |

**If "No"**: Stop and inform the user that the deployment cannot proceed without unblocking `.js` attachments.

**If "Yes"**: Proceed to 5.3.

### 5.3 Update Blocked Attachments

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

### 5.4 Retry Upload

Run the upload command again:

```powershell
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

If it succeeds:

1. Inform the user that the deployment is complete.
2. Commit the changes:

   ```powershell
   git add -A
   git commit -m "Deploy site to Power Pages"
   ```

3. Ask the user about activation (same `AskUserQuestion` as Phase 4 step 3).
4. **If "Activate now"**: Invoke the `/power-pages:activate-site` skill.
5. **If "Skip for now"**: Suggest next steps (see [Suggest Next Steps](#suggest-next-steps)).

If it fails again with a different error, present the error to the user and help troubleshoot.

**Output**: JavaScript unblocked, site deployed successfully, changes committed, and activation offered

---

## Suggest Next Steps

If the user skips activation (or after activation completes), suggest:
- `/power-pages:activate-site` — Provision the site with a subdomain and make it live (if not already activated)
- `/power-pages:setup-datamodel` — Create Dataverse tables for dynamic content
- `/power-pages:add-seo` — Add meta tags, robots.txt, sitemap.xml, favicon

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points (see list below)
- **Present errors clearly** — when a command fails, show the user the relevant error output and explain what went wrong before suggesting fixes

### Key Decision Points (Wait for User)

1. After Phase 2: If not authenticated, get environment URL from user
2. At Phase 3: Confirm or switch the target environment
3. At Phase 4: If multiple `powerpages.config.json` found, ask which project to deploy
4. At Phase 5: Get permission before modifying blocked attachments setting

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify PAC CLI installation | Verifying PAC CLI | Check if PAC CLI is installed, install if missing |
| Verify authentication | Verifying authentication | Check current auth status, authenticate if needed |
| Confirm target environment | Confirming environment | Show current environment, let user confirm or switch |
| Deploy the code site | Deploying site | Locate project root, build, and upload via pac pages upload-code-site |
| Handle blocked JavaScript | Resolving JS block | If upload fails due to blocked JS, offer to unblock and retry |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. Phase 5 may be marked `completed` immediately if no JavaScript blocking issue is encountered. This gives the user visibility into progress and keeps the workflow deterministic.

---

**Begin with Phase 1: Verify PAC CLI**
