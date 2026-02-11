---
name: deploy-power-pages-site
description: This skill should be used when the user asks to "deploy to power pages", "upload site", "publish site", "deploy site", "push to power pages", "upload code site", or wants to deploy/upload an existing Power Pages code site to a Power Pages environment using PAC CLI.
user-invocable: true
allowed-tools: ["Read", "Bash", "AskUserQuestion", "Glob", "Grep"]
model: opus
---

# Deploy Power Pages Code Site

## Workflow

1. **Verify PAC CLI** → Check if PAC CLI is installed, install if missing
2. **Verify Authentication** → Check current auth and environment
3. **Confirm Environment** → Show current environment, let user confirm or switch
4. **Deploy** → Upload the code site to Power Pages
5. **Handle Blocked JavaScript** → If upload fails due to blocked JS, offer to unblock and retry

---

## Step 1: Verify PAC CLI

Run `pac help` to check if the PAC CLI is installed and available on the system PATH.

```powershell
pac help
```

**If the command succeeds**: PAC CLI is installed. Proceed to Step 2.

**If the command fails** (command not found / not recognized):

1. Inform the user that PAC CLI is required but not installed.
2. Fetch installation instructions from `https://aka.ms/PowerPlatformCLI` using the following approach:
   - Tell the user: "PAC CLI is not installed. You can install it by running:"

     ```powershell
     dotnet tool install --global Microsoft.PowerApps.CLI.Tool
     ```

   - If `dotnet` is also not available, direct the user to https://aka.ms/PowerPlatformCLI for full installation instructions including .NET SDK setup.

3. After installation, verify by running `pac help` again.
4. If it still fails, stop and ask the user to resolve the installation manually.

---

## Step 2: Verify Authentication

Run `pac auth who` to check the current authentication status.

```powershell
pac auth who
```

**If authenticated**: Extract the current environment name and URL from the output. Proceed to Step 3.

**If not authenticated**: Inform the user they need to authenticate first:

- Tell the user: "You are not authenticated with PAC CLI. Please run `pac auth create` to sign in, then invoke this skill again."
- Stop the skill execution.

---

## Step 3: Confirm Environment

Present the current environment information to the user and ask them to confirm.

Use `AskUserQuestion` with the following structure:

| Question | Header | Options |
|----------|--------|---------|
| You are currently connected to environment: **<ENV_NAME>** (<ENV_URL>). Do you want to deploy to this environment? | Environment | Yes, use this environment, No, let me choose a different one |

**If "Yes, use this environment"**: Proceed to Step 4.

**If "No, let me choose a different one"**:

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

---

## Step 4: Deploy the Code Site

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

**If the upload succeeds**: Inform the user that the site has been deployed successfully. Share the environment URL where they can view their site.

**If the upload fails**: Check the error message and proceed to Step 5 if the failure is related to blocked JavaScript attachments. For other errors, present the error to the user and help them troubleshoot.

---

## Step 5: Handle Blocked JavaScript

If the upload fails because JavaScript (`.js`) files are blocked as attachments in the environment, follow this procedure:

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

If it succeeds, inform the user that the deployment is complete.

If it fails again with a different error, present the error to the user and help troubleshoot.
