# Power Platform Skills

Plugins from Microsoft that teach AI assistants, such as GitHub Copilot and Claude Code, to build on Power Platform.

**[Browse the plugins and install them with one click](https://microsoft.github.io/power-platform-skills/)**

You describe what you want in your own words, such as "Create a Power Pages site with React for a job board" or "Why did the last run of my approval flow fail?".
Your assistant asks follow-up questions, shows you what it plans to do, and asks before it runs commands or changes files.
Then it does the work, from creating tables to publishing the result to your Power Platform environment.

## What can I build?

| I want to... | Plugin | Try asking |
| --- | --- | --- |
| Build a website | [Power Pages](plugins/power-pages/README.md) | "Create a Power Pages site with React for a job board" |
| Build a business app | [Model-driven apps](plugins/model-apps/README.md) | "Build an app for tracking service requests" |
| Build or change a canvas app | [Canvas apps](plugins/canvas-apps/README.md) | "Edit my Canvas App to add a new screen for reports" |
| Build a web app with code | [Code apps](plugins/code-apps/README.md) (preview) | "Create a code app for tracking customer requests" |
| Build a phone app | [Mobile apps](plugins/mobile-apps/README.md) (private preview) | "Build me a small notes app" |
| Add native phone features to a canvas app | [Power Apps Mobile extensions](plugins/power-apps-mobile-extension/README.md) (preview) | "Design a native barcode scanning feature for my wrapped canvas app" |
| Automate work | [Power Automate](plugins/power-automate/README.md) | "Create a flow that emails me when a new item is added to my SharePoint list" |
| Work with Dataverse data | [Dataverse](https://github.com/microsoft/Dataverse-skills) | "Import this CSV into the contacts table" |
| Find where a process slows down | [Process Intelligence](plugins/process-intelligence/README.md) | "Which steps cause the most waiting in this process?" |
| Build custom controls for forms and views | [PCF](plugins/pcf/README.md) (preview) | "Create a PCF star rating control for a model-driven form" |
| Build tools and widgets for AI assistants | [MCP Apps](plugins/mcp-apps/README.md) | "Show account revenue as a bar chart" |

The [plugin website](https://microsoft.github.io/power-platform-skills/) shows what each plugin needs and more things to ask.

## Before you start

- **An AI assistant:** [Claude Code](https://code.claude.com/docs/en/setup), the [GitHub Copilot app](https://github.com/features/ai/github-app), or [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli).
- **A Power Platform environment you can build in.** A [developer environment](https://learn.microsoft.com/power-platform/developer/create-developer-environment) is free and the safest place to try things.
- **[Node.js](https://nodejs.org/en/download)**, which the installer and most plugins need.

Some plugins need more tools, such as the Azure CLI or the .NET SDK.
Each plugin's page lists them, and your assistant tells you when something is missing.

## Installation

### Quick install (recommended)

Open a terminal and run one command.
It installs every plugin into Claude Code and GitHub Copilot CLI, whichever you have.

**Windows (PowerShell)**:

```powershell
iwr https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js -OutFile install.js; node install.js; del install.js
```

**macOS, Linux, or Windows (cmd)**:

```bash
curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node
```

The installer:

- Installs the Power Platform CLI (`pac`) if it is missing
- Finds Claude Code and GitHub Copilot CLI on your computer
- Adds this plugin marketplace and installs every plugin except `dataverse`
- Turns on automatic updates, so your plugins stay current

To also install the [Dataverse](#dataverse-external) plugin, pass `--include-dataverse`:

```powershell
iwr https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js -OutFile install.js; node install.js --include-dataverse; del install.js
```

```bash
curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node - --include-dataverse
```

The `-` tells Node to read the piped script, so the arguments after it reach the installer.

### Install one plugin with a click

The **Claude Code** links open a terminal with the install command already typed.
Press Enter to install.
If nothing happens, open Claude Code once and send any message, then try the link again.

For the **GitHub Copilot app**, [add the Power Platform marketplace](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Fmarketplace%2Fadd%3Fsource%3Dmicrosoft%252Fpower-platform-skills) first.
You only do this once.
The app asks you to confirm each step.

| Plugin | Claude Code | GitHub Copilot app |
| --- | --- | --- |
| Power Pages | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=power-pages) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dpower-pages%2540power-platform-skills) |
| Model-driven apps | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=model-apps) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dmodel-apps%2540power-platform-skills) |
| Canvas apps | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=canvas-apps) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dcanvas-apps%2540power-platform-skills) |
| Code apps | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=code-apps-preview) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dcode-apps-preview%2540power-platform-skills) |
| Mobile apps | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=mobile-app) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dmobile-app%2540power-platform-skills) |
| Power Apps Mobile extensions | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=power-apps-mobile-extension) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dpower-apps-mobile-extension%2540power-platform-skills) |
| Power Automate | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=power-automate) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dpower-automate%2540power-platform-skills) |
| Process Intelligence | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=process-intelligence) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dprocess-intelligence%2540power-platform-skills) |
| Dataverse | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=dataverse) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Ddataverse%2540power-platform-skills) |
| PCF code components | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=pcf) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dpcf%2540power-platform-skills) |
| MCP Apps | [Install in Claude Code](https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=mcp-apps) | [Install in GitHub Copilot app](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dmcp-apps%2540power-platform-skills) |

The Claude desktop app's Code tab and the Claude Code extension for VS Code use the plugins you install in Claude Code.
VS Code also picks up plugins you install with GitHub Copilot CLI.

### Manual installation

To install from inside a GitHub Copilot CLI or Claude Code session, run these commands:

1. Add the marketplace

    ```bash
    /plugin marketplace add microsoft/power-platform-skills
    ```

2. Install the plugins you want

    ```bash
    /plugin install power-pages@power-platform-skills
    /plugin install model-apps@power-platform-skills
    /plugin install canvas-apps@power-platform-skills
    /plugin install code-apps-preview@power-platform-skills
    /plugin install mobile-app@power-platform-skills
    /plugin install power-apps-mobile-extension@power-platform-skills
    /plugin install power-automate@power-platform-skills
    /plugin install process-intelligence@power-platform-skills
    /plugin install dataverse@power-platform-skills
    /plugin install pcf@power-platform-skills
    /plugin install mcp-apps@power-platform-skills
    ```

## Your first request

1. Open a terminal, make an empty folder for your project, and go into it:

    ```bash
    mkdir my-first-site
    cd my-first-site
    ```

2. Start your assistant by typing `claude` or `copilot`.
   In the GitHub Copilot app, add the folder and start a session instead.
3. Describe what you want, for example "Create a Power Pages site with React for a job board".
4. Answer its questions.
   It may ask you to sign in to Power Platform in your browser and to pick an environment.
5. Read each permission request before you approve it.
   When it finishes, it tells you what it created.

## Questions

### Do I need to know how to code?

No.
You describe what you want in your own words.
You run a few commands to install things, and some plugins are aimed at developers.
The [plugin website](https://microsoft.github.io/power-platform-skills/) says who each plugin is for.

### What does it cost?

The plugins are free and open source under the [MIT](LICENSE) license.
You need your own AI assistant, such as GitHub Copilot or Claude, and a Power Platform environment, which can need Power Platform licenses.

### Can it break something?

Your assistant asks before it runs commands or changes files.
Many plugins also show you a plan or confirm the environment before they publish.
Try things in a [developer environment](https://learn.microsoft.com/power-platform/developer/create-developer-environment) first.
It's free and separate from your organization's live apps.

### Why does my assistant keep asking for permission?

Plugins edit files, run commands, and call MCP servers, and your assistant asks before each one by default.
Read what it wants to do before you approve it.
If you trust the work and want fewer prompts, see [Running Without Interruption](#running-without-interruption).

### What data is collected?

Some plugins send usage data to Microsoft by default, and each one has a command to turn it off.
See [Telemetry](#telemetry) for what is collected.

### How do I update or remove a plugin?

The quick install turns on automatic updates.
Otherwise, run `claude plugin update <name>` or `copilot plugin update <name>`.
To remove a plugin, run `claude plugin uninstall <name>` or `copilot plugin uninstall <name>`.

### Where do I get help?

Most plugins include a `report-issue` skill that drafts a bug report for you.
You can also [open an issue](https://github.com/microsoft/power-platform-skills/issues) or read [SUPPORT.md](SUPPORT.md).

## Words you'll see

For plugins and skills in action, watch the 35-second video [What are plugins and skills?](https://microsoft.github.io/power-platform-skills/#questions) on the plugin website.

| Word | What it means |
| --- | --- |
| AI assistant | An AI tool that can work on your computer, such as Claude Code or GitHub Copilot. |
| Plugin | A package that teaches your assistant a set of jobs. |
| Skill | Instructions for one job, such as creating a site. Your assistant picks one from your request, or you can type its name, such as `/create-site`. |
| Marketplace | A list of plugins your assistant can install. This repository is one. |
| Environment | A space in Power Platform that holds your apps, flows, and data. |
| Dataverse | The database behind Power Apps and Power Automate. |
| PAC CLI | The Power Platform command-line tool. Plugins use it to sign in and publish. |
| Azure CLI | Microsoft's command-line tool for Azure. Some plugins use it to sign in. |
| MCP server | A small program that gives your assistant extra tools, such as access to a service. |

## Available Plugins

### [Power Pages](plugins/power-pages/README.md) (`plugins/power-pages`)

Create and deploy Power Pages sites using modern development approaches.

**Currently supported**: Code Sites (SPAs) with React, Angular, Vue, or Astro

### [Model Apps](plugins/model-apps/README.md) (`plugins/model-apps`)

Build model-driven Power Apps end to end, and the generative pages that go in them.

**Skills**: `/app-builder` builds and edits a whole app — tables, relationships, forms,
views, charts, security roles, app + sitemap — from a natural-language intent; `/genpage` builds
generative pages for an app that already exists. Use either independently — neither requires the other

**Stack**: React + TypeScript + Fluent, deployed through the headless `cds-maker-sdk` (PAC CLI signs you in and chooses the environment)

### [PCF](plugins/pcf/README.md) (`plugins/pcf`)

Build, test, diagnose, upgrade, deploy, verify and inventory Power Apps component framework (PCF) code components for model-driven apps, with guided setup for Power Pages field controls and canvas apps. Canvas apps need an admin to turn on **Power Apps component framework for canvas apps** in each environment.

**Skills**: `/pcf:pcf` scaffolds Microsoft-maintained PCF templates and recipes, runs gates, deploys with PAC, and verifies registration and bindings.

**Status**: Preview — see [capabilities](plugins/pcf/docs/pcf-capabilities.md)

**Stack**: Node.js 20+, Power Apps component framework, PAC CLI, .NET SDK, and Azure CLI for verification/inventory

### [MCP Apps](plugins/mcp-apps/README.md) (`plugins/mcp-apps`)

Generate self-contained JavaScript server runtimes, JSON Schema registration metadata,
and interactive single-file MCP App widgets for codeful MCP tools.

**Skills**: `/generate-codeful-mcp-tool` creates a named `runTool` server entry point plus
its description, MCP behavior annotations, input schema, and structured output schema,
with verified Dataverse access; `/generate-mcp-app-ui` creates an HTML widget that embeds
its runtime by default for hosts that block public URLs, while retaining an opt-in CDN
mode. It can consume model-visible content, structured output, and widget-private
metadata.

**Stack**: JavaScript codeful tools + HTML widgets using the MCP Apps protocol

### [Code Apps](plugins/code-apps/AGENTS.md) (`plugins/code-apps`)

Build and deploy Power Apps code apps connected to Power Platform via connectors.

**Stack**: React + Vite + TypeScript, deployed via PAC CLI

### [Mobile Apps](plugins/mobile-apps/README.md) (`plugins/mobile-apps`)

Build and deploy Power Apps code apps for mobile with native device capabilities.

**Stack**: Expo + React Native + TypeScript, deployed via Power Apps Wrap

### [Power Apps Mobile Extension](plugins/power-apps-mobile-extension/README.md) (`plugins/power-apps-mobile-extension`)

Build third-party native controls for wrapped Canvas apps and package them as verified
`.ppmplugin` bundles with matching dispatcher PCF controls.

**Stack**: Kotlin + Objective-C, Power Apps component framework, and Power Apps Wrap

### [Canvas Apps](plugins/canvas-apps/AGENTS.md) (`plugins/canvas-apps`)

Author Power Apps Canvas Apps using the Canvas Authoring MCP server.

**Stack**: PA YAML (`.pa.yaml`) authored via `CanvasAuthoringMcpServer`, requires .NET 10 SDK

### [Power Automate](plugins/power-automate/README.md) (`plugins/power-automate`)

Build, edit, run, and debug Power Automate cloud flows via the FlowAgent MCP server.

**Stack**: Node.js 18+, Azure CLI (`az login`), self-contained MCP bundle

### [Process Intelligence](plugins/process-intelligence/README.md) (`plugins/process-intelligence`)

Analyze Power Automate Process Mining data, including bottlenecks, variants,
cohorts, rework and object-centric executions through guided MCP workflows.

**Skills**: `/analytics` and `/investigate-process` guide analysis;
`/analyze-performance`, `/analyze-variants`, `/analyze-drivers`, `/compare-cohorts`,
`/derive-metric` and `/analyze-objects` answer focused questions.
`/setup` and `/report-issue` handle connection setup and support drafts.
See the [skill catalog](plugins/process-intelligence/README.md#skills).

**Stack**: Node.js 22+ (maintained LTS recommended), Azure CLI, self-contained MCP bundle

GCC, GCC High, DoD and Mooncake are not supported yet.

### [Dataverse](https://github.com/microsoft/Dataverse-skills) (external)

Work with Microsoft Dataverse: connect to an environment, query and change records, manage tables and columns, and handle security, administration, and solutions.

**Stack**: Dataverse MCP server, Dataverse CLI, Python SDK, and PAC CLI

This plugin is maintained in [microsoft/Dataverse-skills](https://github.com/microsoft/Dataverse-skills), and this marketplace installs it straight from that repository's default branch.
Report issues and send changes there.
If you already installed `dataverse` from the `dataverse-skills` marketplace, keep only one of the two installs so its skills are not loaded twice.

## Running Without Interruption

Plugins in this repo may invoke multiple tools (file edits, shell commands, MCP servers) during a session, which can result in frequent approval prompts. Use the options below to reduce or eliminate these interruptions.

> **Warning**: Auto-approval options give the agent the same access you have on your machine. Only use these in trusted or sandboxed environments.

### GitHub Copilot CLI

#### Option 1 — Allow specific tools (recommended)

Pre-approve only the tools your workflow needs:

```bash
copilot --allow-tool 'write' --allow-tool 'shell(npm run build)' --allow-tool 'shell(pac *)'
```

#### Option 2 — Allow all tools in Copilot

```bash
copilot --allow-all-tools
```

To allow everything except dangerous commands:

```bash
copilot --allow-all-tools --deny-tool 'shell(rm)' --deny-tool 'shell(git push)'
```

See the [Copilot CLI docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli) for the full reference.

### Claude Code

#### Option 1 — Permission mode (recommended)

Set the `acceptEdits` mode to auto-approve file edits while still prompting for shell commands:

```jsonc
// .claude/settings.json (project-level) or ~/.claude/settings.json (user-level)
{
  "defaultMode": "acceptEdits",
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(git *)",
      "Bash(pac *)"
      // add other commands your workflow needs
    ]
  }
}
```

#### Option 2 — Allow all tools

Press <kbd>Shift</kbd>+<kbd>Tab</kbd> during a session to cycle to **auto-accept** mode, or launch with:

```bash
claude --dangerously-skip-permissions
```

See the [Claude Code permissions docs](https://code.claude.com/docs/en/permissions) for the full reference.

## Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Power Pages REST API](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites)
- [Generative Pages with External Tools](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/generative-page-external-tools)
- [Build Model-Driven Apps with External Tools](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/model-driven-app-external-tools)
- [Power Apps Code Apps](https://learn.microsoft.com/power-apps/developer/code-apps/)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference)

## Contributing

To work on the plugins, see [CONTRIBUTING.md](CONTRIBUTING.md) and the [developer guide](docs/development.md).
The developer guide covers loading a plugin from a local checkout and how the repository fits together.

## License

The code in this repo is licensed under the [MIT](LICENSE) license.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.

## Telemetry

Some plugins send usage data to Microsoft to help improve them: Power Pages, Model-driven apps, PCF, Mobile apps, Power Apps Mobile extensions, and Power Automate.
It is on by default.

- **What's sent:** which skill ran, the plugin version, your AI assistant, and your operating system, and for some skills whether they succeeded and how long they took.
  When you're signed in to Power Platform, it can also include your organization and tenant IDs, and for some plugins your Microsoft Entra user ID.
- **What's never sent:** what you type, file paths, site or app names, error messages, or usernames.
- **To turn it off** for a plugin, ask your assistant to "turn off telemetry", or run the plugin's telemetry skill, such as `/power-pages:telemetry off`.
  In scripts and CI, set the plugin's environment variable instead, such as `POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT=1`.
  Turning it off stops sending; the plugin still keeps a local log, so you can see what would have been sent.

Each plugin's README lists exactly what it sends, and the [telemetry guide](shared/telemetry/README.md) has the full details.
See also the [Microsoft Privacy Statement](https://www.microsoft.com/privacy/privacystatement).
