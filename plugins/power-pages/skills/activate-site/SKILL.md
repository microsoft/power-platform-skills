---
name: activate-power-pages-site
description: >
  This skill should be used when the user asks to "activate site",
  "provision website", "activate a Power Pages website", "activate portal",
  "provision portal", "turn on my site", "enable website",
  or wants to activate/provision a Power Pages website in their
  Power Platform environment via the Power Platform REST API.
user-invocable: true
allowed-tools: ["Read", "Bash", "Glob", "Grep", "AskUserQuestion"]
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/activate-site/scripts/validate-activation.js"'
          timeout: 30
        - type: prompt
          prompt: >
            If a Power Pages website was being activated in this session (via /power-pages:activate-site),
            verify before allowing stop: 1) Prerequisites were verified (PAC CLI auth + Azure CLI token),
            2) Site name and subdomain were determined, 3) The user confirmed activation parameters,
            4) The POST to the websites API was made, 5) Provisioning status was polled to completion,
            6) A summary with the site URL was presented.
            If incomplete, return { "ok": false, "reason": "<specific issues>" }. Otherwise return { "ok": true }.
          timeout: 30
---

# Activate Power Pages Site

Provision a new Power Pages website in a Power Platform environment via the Power Platform REST API.

> **Prerequisite:** This skill expects an existing Power Pages code site created via `/power-pages:create-site`. Run that skill first if the site does not exist yet.

## Workflow

1. **Verify Prerequisites** → PAC CLI auth + Azure CLI token for the Power Platform API
2. **Gather Parameters** → Site name, subdomain, website record ID
3. **Confirm** → Present all parameters to user for approval
4. **Activate** → POST to the Power Platform websites API
5. **Poll Status** → Poll provisioning status until completion
6. **Present Summary** → Show site URL, suggest next steps

---

## Step 1: Verify Prerequisites

### 1.1 Verify PAC CLI

Run `pac help` to check if the PAC CLI is installed and available on the system PATH.

```powershell
pac help
```

**If the command fails** (command not found / not recognized):

1. Tell the user: "PAC CLI is not installed. You can install it by running:"

   ```powershell
   dotnet tool install --global Microsoft.PowerApps.CLI.Tool
   ```

2. If `dotnet` is also not available, direct the user to https://aka.ms/PowerPlatformCLI for full installation instructions.
3. After installation, verify by running `pac help` again.

### 1.2 Check Authentication

Run `pac auth who` to check current authentication status.

```powershell
pac auth who
```

**If authenticated**: Extract these values from the output:
- **Environment ID** — the GUID after `Environment ID:`
- **Organization ID** — the GUID after `Organization ID:` (this is the Dataverse org ID)
- **Cloud** — the value after `Cloud:` (e.g., `Public`, `UsGov`, `UsGovHigh`, `UsGovDod`, `China`)

**If not authenticated**: Follow the same authentication flow as `deploy-site` — ask the user for their environment URL and run `pac auth create --environment "<URL>"`.

### 1.3 Resolve Power Platform API Base URL

Map the **Cloud** value from `pac auth who` to the correct Power Platform API base URL. **CRITICAL: Never hardcode the base URL — always derive it from the Cloud value.**

| Cloud value | PP API Base URL |
|---|---|
| `Public` | `https://api.powerplatform.com` |
| `UsGov` | `https://api.gov.powerplatform.microsoft.us` |
| `UsGovHigh` | `https://api.high.powerplatform.microsoft.us` |
| `UsGovDod` | `https://api.appsplatform.us` |
| `China` | `https://api.powerplatform.partner.microsoftonline.cn` |

Store the resolved URL as `$ppApiBaseUrl`.

### 1.4 Acquire Azure CLI Token

Get an access token scoped to the Power Platform API base URL:

```powershell
$token = az account get-access-token --resource "$ppApiBaseUrl" --query accessToken -o tsv
```

**If `az` is not installed or not logged in**: Instruct the user to install Azure CLI and run `az login`.

### 1.5 Verify Token

Make a lightweight GET to verify the token works:

```powershell
$headers = @{ Authorization = "Bearer $token"; Accept = "application/json" }
Invoke-RestMethod -Uri "$ppApiBaseUrl/powerpages/environments/$environmentId/websites?api-version=2022-03-01-preview" -Headers $headers
```

**If 401/403**: The token may not have the right scope. Ask the user to verify they have the Power Platform admin or website creator role.

**If successful**: Proceed to Step 2.

---

## Step 2: Gather Parameters

### 2.1 Read Site Name

Look for `powerpages.config.json` in the current directory or one level of subdirectories using `Glob`:

```text
**/powerpages.config.json
```

Read the file and extract the `siteName` field. If not found, ask the user for the site name using `AskUserQuestion`.

### 2.2 Generate Subdomain Suggestion

Run the subdomain generator script to create a random suggestion:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/activate-site/scripts/generate-subdomain.js"
```

This outputs a string like `site-a3f2b1`. Present it to the user and ask them to accept or customize:

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Your site subdomain will be: **`<suggestion>`** (full URL: `<suggestion>.powerappsportals.com`). Would you like to use this subdomain or enter a custom one? | Subdomain | Use `<suggestion>` (Recommended), Enter a custom subdomain |

**If custom**: The user provides their own subdomain via "Other" free text input. Validate it is lowercase, alphanumeric with hyphens only, and 3-50 characters.

### 2.3 Get Website Record ID

Run `pac pages list` to get the website record ID:

```powershell
pac pages list
```

Parse the output to find the website record that matches the site name. Extract the `Website Record ID` (GUID). If `pac pages list` returns no results or the command is not available, set `websiteRecordId` to `$null` — the API will create a new website record.

---

## Step 3: Confirm

Present all activation parameters to the user using `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Ready to activate your Power Pages site with these settings:\n\n- **Site name**: `<siteName>`\n- **Subdomain**: `<subdomain>.powerappsportals.com`\n- **Environment ID**: `<environmentId>`\n- **Template**: DefaultPortalTemplate\n- **Language**: English (1033)\n\nProceed with activation? | Activate | Yes, activate the site (Recommended), No, cancel |

**If "No"**: Stop the skill and inform the user they can re-run it later.

**If "Yes"**: Proceed to Step 4.

---

## Step 4: Activate

### 4.1 Refresh Token

Re-acquire the Azure CLI token in case it has expired since Step 1:

```powershell
$token = az account get-access-token --resource "$ppApiBaseUrl" --query accessToken -o tsv
```

### 4.2 Build Request Body

Construct the JSON body for the activation API call:

```json
{
  "name": "<siteName>",
  "subdomain": "<subdomain>",
  "templateName": "DefaultPortalTemplate",
  "dataverseOrganizationId": "<organizationId>",
  "selectedBaseLanguage": 1033,
  "websiteRecordId": "<websiteRecordId or null>"
}
```

If `websiteRecordId` is null/empty, **omit** the field from the body entirely (do not send `null`).

### 4.3 POST to Websites API

Use `Invoke-WebRequest` (NOT `Invoke-RestMethod`) to capture response headers — specifically the `Operation-Location` header needed for polling:

```powershell
$body = @{
  name = "$siteName"
  subdomain = "$subdomain"
  templateName = "DefaultPortalTemplate"
  dataverseOrganizationId = "$organizationId"
  selectedBaseLanguage = 1033
} | ConvertTo-Json

$response = Invoke-WebRequest -Method Post `
  -Uri "$ppApiBaseUrl/powerpages/environments/$environmentId/websites?api-version=2022-03-01-preview" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json"; Accept = "application/json" } `
  -Body $body

$response.StatusCode
$response.Headers["Operation-Location"]
```

Add the `websiteRecordId` field to the `$body` hashtable only if it is not null.

### 4.4 Handle Responses

| Status Code | Meaning | Action |
|---|---|---|
| **202 Accepted** | Provisioning started | Extract `Operation-Location` header, proceed to Step 5 |
| **400 Bad Request** | Likely subdomain already taken | Parse error message. If subdomain conflict, loop back to Step 2.2 for a new subdomain |
| **401 Unauthorized** | Token expired or invalid | Refresh token and retry once |
| **403 Forbidden** | Insufficient permissions | Inform user they need the "Power Pages site creator" or "System Administrator" role |
| **409 Conflict** | Website already exists | Inform user a site already exists in this environment and suggest using `/power-pages:deploy-site` instead |
| **429 / 5xx** | Throttling or server error | Wait 5 seconds and retry once |

---

## Step 5: Poll Status

### 5.1 Poll Operation-Location

The `Operation-Location` header from Step 4 contains a URL to poll for provisioning status. Poll every 10 seconds for up to 5 minutes (30 polls max):

```powershell
$operationUrl = $response.Headers["Operation-Location"]
$maxAttempts = 30
$attempt = 0

do {
  Start-Sleep -Seconds 10
  $attempt++

  # Refresh token every ~60 seconds (every 6 polls)
  if ($attempt % 6 -eq 0) {
    $token = az account get-access-token --resource "$ppApiBaseUrl" --query accessToken -o tsv
  }

  $status = Invoke-RestMethod -Uri $operationUrl -Headers @{ Authorization = "Bearer $token"; Accept = "application/json" }
  $status.status
} while ($status.status -eq "Running" -and $attempt -lt $maxAttempts)
```

### 5.2 Handle Poll Results

| Status | Action |
|---|---|
| **Succeeded** | Provisioning complete — proceed to Step 6 |
| **Failed** | Report the error from `$status.error` to the user. Suggest checking the Power Platform admin center for details. |
| **Running (timeout)** | After 5 minutes, inform the user that provisioning is still in progress. It may take up to 15 minutes. Suggest they check the Power Platform admin center for status. |

---

## Step 6: Present Summary

### 6.1 Show Results

Present the activation summary to the user:

```
Power Pages site activated successfully!

  Site Name:  <siteName>
  Site URL:   https://<subdomain>.powerappsportals.com
  Environment: <environmentName> (<environmentId>)
  Status:     Provisioned
```

**Note:** The site URL domain varies by cloud:

| Cloud | Site URL Domain |
|---|---|
| `Public` | `powerappsportals.com` |
| `UsGov` | `powerappsportals.us` |
| `UsGovHigh` | `high.powerappsportals.us` |
| `UsGovDod` | `appsplatform.us` |
| `China` | `powerappsportals.cn` |

### 6.2 Suggest Next Steps

After the summary, suggest:
- Set up the data model: `/power-pages:setup-datamodel`
- Add sample data: `/power-pages:add-sample-data`
- View the site in the browser at the provisioned URL (note: it may take a few minutes for DNS to propagate)
