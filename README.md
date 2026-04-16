# Power Platform Skills

Official Power Platform development workflows by Microsoft, adapted for Codex while preserving the original Claude Code / GitHub Copilot plugin packaging.

This repository began as a plugin marketplace for Claude Code and GitHub Copilot. It now also supports **Codex-native skill usage**, where the primary unit of reuse is an individual `skills/<skill>/` folder containing a `SKILL.md`.

---

## Status

- **Codex support:** active
- **Legacy Claude Code / GitHub Copilot packaging:** still present
- **Repository layout:** still grouped by plugin
- **Primary Codex execution unit:** one skill folder

In practice, this means:

- For **Codex**, you usually use a specific skill folder such as:
  - `plugins/power-pages/skills/create-site`
  - `plugins/code-apps/skills/add-dataverse`
  - `plugins/model-apps/skills/genpage`
  - `plugins/canvas-apps/skills/generate-canvas-app`
- For **legacy plugin consumers**, `.claude-plugin/` manifests and plugin folders remain available.

---

## What Changed From Claude Code To Codex

The repo still carries historical Claude-oriented structure and vocabulary, but the skill documents have been updated so they can be followed naturally in Codex.

### High-level shift

| Before | Now |
|---|---|
| Plugin-centric install and execution | Skill-centric install and execution |
| Claude-specific orchestration terms in workflows | Codex-native guidance in `SKILL.md` plus plugin `AGENTS.md` |
| Marketplace/plugin install was the main path | Symlinking or copying skills into Codex is the main path |
| Some workflows assumed special question/task tools | Workflows now describe normal Codex conversation and `update_plan` usage |

### Translation rules used in this repo

Many legacy docs originally assumed Claude-specific concepts. In Codex, interpret them like this:

| Legacy concept | Codex interpretation |
|---|---|
| `AskUserQuestion` | Ask the user directly in normal chat |
| `TaskCreate` / `TaskUpdate` / `TaskList` | Use `update_plan` |
| `EnterPlanMode` / `ExitPlanMode` | Present a plan in normal conversation, get approval, continue |
| `/skill-name` | Run the corresponding sibling skill workflow |
| `${CLAUDE_PLUGIN_ROOT}` | The plugin root directory containing the current skill |
| Specialist agent / Task tool instructions | Usually do the work in the main Codex agent unless explicit delegation is desired |

### What was intentionally kept

Some Claude/Copilot-oriented artifacts still remain because they are still useful or required:

- `.claude-plugin/marketplace.json`
- `plugins/*/.claude-plugin/plugin.json`
- legacy install instructions for Claude Code / GitHub Copilot
- multi-tool support in some skills, especially:
  - `plugins/canvas-apps/skills/configure-canvas-mcp`

These are **not** errors; they are compatibility surfaces.

---

## What Is In This Repository

This repo covers four Power Platform areas:

### 1. Power Pages — `plugins/power-pages`

Build, deploy, activate, test, and secure modern Power Pages **code sites**.

Typical skills:

- `create-site`
- `deploy-site`
- `activate-site`
- `test-site`
- `setup-datamodel`
- `setup-auth`
- `integrate-webapi`
- `add-server-logic`

### 2. Power Apps Code Apps — `plugins/code-apps`

Build React + Vite + TypeScript code apps and connect them to Power Platform connectors.

Typical skills:

- `create-code-app`
- `deploy`
- `list-connections`
- `add-dataverse`
- `add-sharepoint`
- `add-office365`
- `add-teams`

### 3. Model Apps / Generative Pages — `plugins/model-apps`

Generate and deploy model-driven app generative pages.

Typical skill:

- `genpage`

### 4. Canvas Apps — `plugins/canvas-apps`

Generate or edit Canvas App YAML, and configure the Canvas Authoring MCP server.

Typical skills:

- `configure-canvas-mcp`
- `generate-canvas-app`
- `edit-canvas-app`
- `add-data-source`

---

## Repository Structure

```text
power-platform-skills/
├── .claude-plugin/
│   └── marketplace.json          # Legacy marketplace manifest
├── plugins/
│   ├── power-pages/
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json       # Legacy plugin metadata
│   │   ├── AGENTS.md             # Plugin-specific guidance
│   │   ├── commands/             # Legacy command entry points
│   │   ├── shared/               # Shared references/scripts/docs
│   │   ├── scripts/              # Plugin scripts
│   │   └── skills/
│   │       └── <skill>/SKILL.md
│   ├── code-apps/
│   ├── model-apps/
│   └── canvas-apps/
├── AGENTS.md                     # Repository-wide guidance
└── README.md
```

### Important layout note for Codex users

Many skills reference files outside the skill folder, such as:

- `../../shared/...`
- `../../references/...`
- `../../scripts/...`
- `../../samples/...`

Because of that:

- **Symlinking is the safest installation method**
- If you **copy** a skill folder out of the repo, you may also need to copy supporting files it references

---

## Using These Skills With Codex

## 1. Clone the repository

```bash
git clone https://github.com/microsoft/power-platform-skills.git
cd power-platform-skills
```

## 2. Choose the skills you want

Examples:

- Power Pages site creation:
  - `plugins/power-pages/skills/create-site`
- Dataverse integration for code apps:
  - `plugins/code-apps/skills/add-dataverse`
- Model-driven generative pages:
  - `plugins/model-apps/skills/genpage`
- Canvas app generation:
  - `plugins/canvas-apps/skills/generate-canvas-app`

## 3. Install them into Codex

### Recommended: symlink

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"

ln -s /absolute/path/to/power-platform-skills/plugins/power-pages/skills/create-site \
  "${CODEX_HOME:-$HOME/.codex}/skills/power-pages-create-site"
```

You can repeat that for as many skills as you want.

### Alternative: copy

Copying can work, but be careful: a copied skill folder may no longer be able to find sibling `shared/`, `references/`, `scripts/`, or `samples/` content unless you copy those dependencies too.

## 4. Use the skill in Codex

Once the skill is installed, invoke it by name or ask for the workflow it describes.

Examples:

- “Create a Power Pages site for an HR dashboard”
- “Add Dataverse to my code app”
- “Generate a model-driven generative page for Accounts”
- “Configure the Canvas Authoring MCP server for Codex”

### How Codex should interpret the repo

- `AGENTS.md` files define project and plugin behavior
- Each `SKILL.md` defines the workflow itself
- `references/`, `shared/`, `scripts/`, and `samples/` are supporting assets
- Slash-style references inside docs usually point to **sibling skills**, not literal shell commands

---

## Codex Usage Patterns

### Prefer a skill over ad hoc prompting

If a request clearly matches a skill, use the skill workflow instead of improvising from scratch.

### Read only the references you need

Skills often point at shared references. In Codex, load only the files needed for the current task rather than bulk-loading everything.

### Use `update_plan` for multi-phase skills

Many workflows were originally written with explicit task-management tools in mind. In Codex, the intended equivalent is `update_plan`.

### Ask users directly in normal chat

Where older docs mention structured question tools, Codex should simply ask concise questions in the conversation.

---

## Common Prerequisites

The exact requirements depend on the plugin, but common tooling includes:

- **Node.js**
- **Power Platform CLI (`pac`)**
- **Git**
- **PowerShell / `pwsh`** for workflows that call Windows-oriented CLI surfaces from bash

Additional plugin-specific requirements:

### Power Pages

- PAC CLI authentication
- Azure CLI authentication for some Dataverse / Power Platform REST operations
- A previously created or deployed code site for certain workflows

### Code Apps

- Node.js
- PAC CLI
- Power Platform environment access

### Model Apps

- PAC CLI with model app / genpage support
- Access to the target Dataverse environment

### Canvas Apps

- **.NET 10 SDK**
- Canvas Authoring MCP server setup
- A compatible Studio / coauthoring workflow

---

## Local Development

There is **no root-level universal build or test command** for the entire repository.

Instead:

- inspect the relevant plugin folder
- follow its `AGENTS.md`
- run only the commands needed for the skill or script you are editing

Typical local workflow:

1. Clone the repo
2. Edit a skill under `plugins/<plugin>/skills/<skill>/`
3. Update adjacent references/scripts if needed
4. Symlink the skill into Codex
5. Test the workflow from Codex against the intended scenario

### Important development conventions

- Prefer **small, reviewable diffs**
- Reuse shared scripts and references rather than duplicating logic
- Keep plugin-specific conventions in the plugin's `AGENTS.md`
- If a skill references shared scripts or reference docs, keep those links accurate

---

## Legacy Claude Code / GitHub Copilot Packaging

The original plugin packaging is still available.

### Marketplace manifest

The legacy marketplace definition lives at:

- `.claude-plugin/marketplace.json`

Current legacy plugin entries include:

- `power-pages`
- `model-apps`
- `canvas-apps`
- `code-apps-preview`

### Quick install for legacy plugin consumers

**Windows (PowerShell):**

```powershell
iwr https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js -OutFile install.js; node install.js; del install.js
```

**macOS / Linux / Windows (cmd-compatible shell):**

```bash
curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node
```

### Manual legacy install

Inside Claude Code or GitHub Copilot CLI:

1. Add the marketplace

   ```bash
   /plugin marketplace add microsoft/power-platform-skills
   ```

2. Install the desired plugin

   ```bash
   /plugin install power-pages@power-platform-skills
   /plugin install model-apps@power-platform-skills
   /plugin install code-apps@power-platform-skills
   /plugin install canvas-apps@power-platform-skills
   ```

### Why these instructions remain

Because the repo is in a transition state:

- Codex users consume **skills**
- Legacy plugin users consume **plugins**

Both entrypoints remain useful, so this README documents both.

---

## Known Migration Notes

These are intentional and useful to know when reading the repo:

1. **Plugin naming is historical**
   - For example, the legacy marketplace entry is `code-apps-preview`, while the repo folder is `plugins/code-apps`.

2. **Some docs still mention slash commands**
   - In Codex, these usually mean “run the sibling skill workflow”.

3. **Some skills are multi-tool by design**
   - `configure-canvas-mcp` still includes Codex, Claude Code, and Copilot branches.

4. **The repo is Codex-adapted, not fully Claude-erased**
   - Legacy manifests and compatibility docs intentionally remain.

5. **Symlinking beats copying**
   - Because many skills depend on sibling references/scripts.

---

## Recommended Starting Points

If you're new to this repo, these are good entry skills:

### Power Pages

- `plugins/power-pages/skills/create-site`
- `plugins/power-pages/skills/deploy-site`

### Code Apps

- `plugins/code-apps/skills/create-code-app`
- `plugins/code-apps/skills/add-datasource`

### Model Apps

- `plugins/model-apps/skills/genpage`

### Canvas Apps

- `plugins/canvas-apps/skills/configure-canvas-mcp`
- `plugins/canvas-apps/skills/generate-canvas-app`

---

## Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Power Pages REST API](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites)
- [Generative Pages with External Tools](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/generative-page-external-tools)
- [Power Apps Code Apps](https://learn.microsoft.com/power-apps/developer/code-apps/)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

When contributing:

- update the relevant `SKILL.md`
- update plugin `AGENTS.md` if conventions changed
- update this `README.md` if the Codex vs legacy usage model changes

---

## License

The code in this repo is licensed under the [MIT](LICENSE) license.

---

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).

Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos are subject to those third-party's policies.
