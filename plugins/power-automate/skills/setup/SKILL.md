---
name: setup
description: Set up Power Automate CLI prerequisites. Use when the user is new, something isn't working, or they need help getting started.
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion, mcp__flowagent__*
model: opus
---

# First-Time Setup Guide

You are helping a non-technical user get the Power Automate plugin working for the first time. Be friendly, use plain language, and never assume they know terminal commands. Walk them through each step one at a time.

## Step 1: Check Node.js

Run silently:
```bash
node --version 2>&1
```

- **If it works** (prints something like `v18.x.x` or higher): Tell them "Node.js is installed" and move on.
- **If it fails or version is below 18**: Tell them they need Node.js 18 or newer. Ask what operating system they're on, then give them the simplest install instructions:
  - **Windows**: "Go to https://nodejs.org, download the LTS version, and run the installer. Click Next through everything."
  - **Mac**: "Open Terminal and run: `brew install node`" (or direct them to nodejs.org)
  - After they've installed it, re-check with `node --version`.

## Step 2: Check Azure CLI

Run silently:
```bash
az --version 2>&1
```

- **If it works**: Tell them "Azure CLI is installed" and move on.
- **If it fails**: Tell them they need the Azure CLI. Ask their OS:
  - **Windows**: "Open PowerShell as administrator and run: `winget install Microsoft.AzureCLI`" or direct them to https://aka.ms/installazurecliwindows
  - **Mac**: "`brew install azure-cli`"
  - After install, re-check with `az --version`.

## Step 3: Azure Login

Check if they're already logged in:
```bash
az account show --output json 2>&1
```

- **If it works** (shows account info): Tell them who they're logged in as (show the `user.name` field) and ask if that's the right account.
- **If it fails**: Tell them "Let's sign you into Azure." Then run:
  ```bash
  az login
  ```
  This will open their browser. Tell them: "A browser window should open. Sign in with your work account — the one you use for Power Automate."
  After login completes, confirm it worked by running `az account show` again.

**Verify token access** — this catches permission issues early.

First find out which Azure cloud they're on, because the Power Automate
resource URL differs per cloud and the commercial one cannot be assumed
(GCC High / DoD tenants will fail against it):
```bash
az cloud show --query name -o tsv
```

| `az cloud show` | Power Automate resource |
|---|---|
| `AzureCloud` (commercial) | `https://service.flow.microsoft.com` |
| `AzureCloud` + GCC tenant | `https://gov.service.flow.microsoft.us` |
| `AzureUSGovernment` (GCC High) | `https://high.service.flow.microsoft.us` |
| `AzureUSGovernment` (DoD) | `https://dod.service.flow.microsoft.us` |

`az cloud show` cannot distinguish commercial from GCC, or GCC High from DoD —
for those, set `PA_CLOUD=gcc` / `PA_CLOUD=dod` explicitly.

Then request a token for the matching resource, e.g. for commercial:
```bash
az account get-access-token --resource https://service.flow.microsoft.com --output json 2>&1
```
FlowAgent itself auto-detects the cloud the same way; you can override the
detection with `PA_CLOUD=commercial|gcc|gcchigh|dod`.
- **If it works**: Move on.
- **If it fails with "AADSTS"**: The user's account may not have Power Automate access. Tell them: "Your Azure account doesn't seem to have access to Power Automate. Check with your IT admin that you have a Power Automate license."
- **If it fails with other errors**: Show the error and suggest they contact IT support.
- **If they're on a sovereign cloud and connection-management commands fail**: the
  PAC CLI app registration isn't preauthorized in those tenants. They need to
  register their own Azure AD app with Power Platform Connectivity scopes and set
  `PA_CLIENT_ID=<app-id>`. Flow management (list/create/run) works without it.

## Step 4: Check the FlowAgent tools are wired

The plugin talks to Power Automate through the **FlowAgent MCP server**, which is
launched automatically from the plugin's `.mcp.json` (via `npx @microsoft/power-automate-mcp`).

- **If `flowagent-*` / `mcp__flowagent__*` tools appear in your tool list**: tell
  them "The Power Automate tools are connected" and move on.
- **If they're missing**: the MCP server isn't wired up yet. Tell them to make
  sure the plugin is installed (`/plugin install power-automate@power-platform-skills`) and
  restart the agent. If they're running from a local clone instead of the
  published package, point their client's `.mcp.json` at
  `node <repo>/packages/cli/dist/bin/mcp-stdio.js` (after `npm install && npm run build`).

## Step 5: Smoke Test

Verify everything works end-to-end by listing the user's environments:

- **Preferred**: call the `list_environments` tool.
- **If MCP tools aren't available**: run `npx -y @microsoft/power-automate-mcp@latest list-environments` (or, from a local clone, `node dist/cli.js list-environments`).

- **If it returns environments**: Success! Tell them:
  - "Everything is working! Here are your Power Automate environments:"
  - Show the environments in a simple table (name, location).
  - If there are multiple, ask which one they mainly use and suggest setting it
    as the default (the `set_current_env` tool, or ask "set my default
    environment to <name>").
  - Tell them about the available skills:
    - **`/browse-flows`** — Browse your flows
    - **`/create-flow`** — Create a new flow
    - **`/debug-flow`** — Fix a broken flow
- **If it fails**: Check the error. Common issues:
  - Auth error → go back to Step 3
  - Tools not found → go back to Step 4
  - Network error → ask if they're behind a corporate proxy/VPN

## Tone Guidelines

- Use "we" language: "Let's check if Node.js is installed"
- Celebrate small wins: "Great, Node.js is ready!"
- Don't dump all steps at once — do one at a time and confirm before moving on
- If something fails, don't panic — explain what went wrong in plain English and what to do
- Never show raw JSON errors to the user without explaining what they mean
