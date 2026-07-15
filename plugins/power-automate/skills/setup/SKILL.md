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

**Detect Azure cloud** — check if the user is on a sovereign cloud:
```bash
az cloud show --query name -o tsv 2>&1
```
- **If it returns `AzureCloud`**: Commercial cloud, proceed normally.
- **If it returns `AzureUSGovernment`**: GCC High / US Government cloud. Tell the user:
  "You're on Azure US Government. I'll configure the plugin for GCC High endpoints."
  Then set the sovereign cloud env vars for the session:
  ```bash
  export PA_FLOW_RESOURCE="https://service.flow.microsoft.us"
  export PA_BASE_URL="https://gov.api.flow.microsoft.us"
  export PA_PPAPI_SUFFIX="environment.api.gov.powerplatform.us"
  export PA_AUTHORITY_HOST="https://login.microsoftonline.us"
  export PA_CONNECTIVITY_RESOURCE="https://api.gov.powerplatform.us"
  ```
  Tell the user: "For permanent configuration, add these to your shell profile or set them in `~/.power-automate-cli/config.json`."
- **If it returns something else** (e.g. `AzureChinaCloud`): Tell them sovereign cloud support is limited and they may need to set `PA_FLOW_RESOURCE` and `PA_BASE_URL` manually for their cloud.

**Verify token access** — this catches permission issues early. Use the correct resource for the detected cloud:
```bash
az account get-access-token --resource "${PA_FLOW_RESOURCE:-https://service.flow.microsoft.com}" --output json 2>&1
```
- **If it works**: Move on.
- **If it fails with "AADSTS"**: The user's account may not have Power Automate access. Tell them: "Your Azure account doesn't seem to have access to Power Automate. Check with your IT admin that you have a Power Automate license."
- **If it fails with other errors**: Show the error and suggest they contact IT support.

## Step 4: Check the FlowAgent tools are wired

The plugin talks to Power Automate through the **FlowAgent MCP server**, which is
launched automatically from the plugin's `.mcp.json` via
`node ${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs`.

- **If `flowagent-*` / `mcp__flowagent__*` tools appear in your tool list**: tell
  them "The Power Automate tools are connected" and move on.
- **If they're missing**: the MCP server isn't registered. Fix it automatically:

  1. **Locate the installed plugin's MCP bundle.** Run:
     ```bash
     node -e "const fs=require('fs'),p=require('path'),d=p.join(process.env.HOME||process.env.USERPROFILE,'.copilot','installed-plugins');try{const find=(dir)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=p.join(dir,e.name);if(e.isDirectory())try{const r=find(f);if(r)return r}catch{}if(e.name==='mcp.mjs')return dir}return null};const r=find(d);if(r)console.log(JSON.stringify({found:true,serverDir:r,mcpMjs:p.join(r,'mcp.mjs')}));else console.log(JSON.stringify({found:false}))}catch(e){console.log(JSON.stringify({found:false,error:e.message}))}"
     ```

  2. **If found**, read `~/.copilot/mcp-config.json`, add the `flowagent` MCP
     entry, and write it back:
     ```bash
     node -e "const fs=require('fs'),p=require('path');const cfgPath=p.join(process.env.HOME||process.env.USERPROFILE,'.copilot','mcp-config.json');let cfg;try{cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'))}catch{cfg={mcpServers:{}}};if(!cfg.mcpServers)cfg.mcpServers={};if(cfg.mcpServers.flowagent){console.log('already registered');process.exit(0)}const pluginDir=p.join(process.env.HOME||process.env.USERPROFILE,'.copilot','installed-plugins');const find=(dir)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=p.join(dir,e.name);if(e.isDirectory())try{const r=find(f);if(r)return r}catch{}if(e.name==='mcp.mjs')return dir}return null};const srvDir=find(pluginDir);if(!srvDir){console.log('mcp.mjs not found');process.exit(1)}const mcpPath=p.join(srvDir,'mcp.mjs');cfg.mcpServers.flowagent={command:'node',args:[mcpPath]};fs.writeFileSync(cfgPath,JSON.stringify(cfg,null,2)+'\n');console.log('registered flowagent MCP at '+mcpPath)"
     ```

  3. **Tell the user** to restart the agent (Copilot CLI: `/restart`, Claude Code:
     restart the process). After restart, `flowagent-*` tools should appear.

  4. **If not found** (plugin not installed at all): tell them to install the
     plugin first:
     ```
     /plugin marketplace add microsoft/power-platform-skills
     ```
     Then select `power-automate` and run `/setup` again.

## Step 5: Smoke Test

Verify everything works end-to-end by listing the user's environments:

- **Preferred**: call the `list_environments` tool.
- **If MCP tools aren't available**: run `node <path-to-plugin>/server/mcp.mjs`
  to confirm the bundled MCP server starts cleanly, then fix the plugin install
  or `.mcp.json` wiring before retrying.

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
