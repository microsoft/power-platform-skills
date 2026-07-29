# Model Apps Plugin

Build and deploy generative pages (genux) for Power Apps model-driven apps. This plugin provides a complete workflow — from validating prerequisites and gathering requirements, through generating React + TypeScript + Fluent code, to deploying via PAC CLI and verifying in the browser.

## Installation

### From the marketplace

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install model-apps@power-platform-skills
```

### From a local clone

```bash
claude --plugin-dir /path/to/power-platform-skills/plugins/model-apps
```

## Prerequisites

| Prerequisite | Required for | Install |
|---|---|---|
| [Node.js](https://nodejs.org/) (LTS) | All skills | `winget install OpenJS.NodeJS.LTS` |
| [PAC CLI](https://learn.microsoft.com/en-us/power-platform/developer/cli/introduction) >= 2.7.0 | Schema generation, app creation, table listing, deployment | `dotnet tool install -g Microsoft.PowerApps.CLI.Tool` |
| [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`az`) | Dataverse Web API auth for entity creation | `winget install Microsoft.AzureCLI` |

After installing `az`, run `az login` with the same identity as your active `pac auth list` profile. Without `az`, the `/genpage` skill still works for pages over existing entities or mock data — it only fails when entity creation is needed.

## Feature flags (experimental & in-progress)

Some capabilities ship **OFF by default** while their cross-repo dependencies roll
out to production. With a flag OFF, the skill behaves as if the feature doesn't
exist and deployed pages are unchanged. Flags are catalogued (with lifecycle
status) in `scripts/lib/feature-flags.js`; their on/off value lives in
`feature-flags.json` at the plugin root.

| Flag | Status | Enables | Depends on |
|---|---|---|---|
| `connectors` | in-progress | GenPage connector authoring (SharePoint, weather, Office 365, SQL, custom REST) + ALM packaging of connection references | pac CLI connector verbs, the GenUX authoring control, and the maker/admin ECS setting — all live in PROD |

**See the current state** (status, whether each flag is on, and why):

```bash
node scripts/lib/feature-flags.js --list
```

**Enable a flag for a single run** via an environment variable (highest precedence):

```powershell
# Windows (PowerShell)
$env:GENPAGE_ENABLE_CONNECTORS = "1"
```

```bash
# macOS / Linux (bash)
export GENPAGE_ENABLE_CONNECTORS=1
```

**Enable it persistently** by flipping the value in `feature-flags.json`:

```json
{ "connectors": true }
```

Precedence is **env var → `feature-flags.json` → default OFF** (fail-closed). Only
turn a flag on once its "Depends on" items are actually available in your
environment — otherwise the feature's commands will fail with a clear "disabled" or
capability error. The env var name is always `GENPAGE_ENABLE_<FLAG>` (uppercased).

## Skills

The plugin provides a single skill that covers the full lifecycle of a generative page.

### `/genpage`

Creates, updates, and deploys generative pages for model-driven Power Apps. Handles the complete workflow in a single session:

1. **Validate prerequisites** — checks Node.js and PAC CLI version
2. **Authenticate** — verifies PAC CLI auth (and `az` if entity creation is needed)
3. **Gather requirements** — asks about page type, data source, and specific features
4. **Create entities** (optional) — uses the plugin's Node.js Web API scripts to create Dataverse tables, columns, relationships, and choice columns when the requested entities don't exist. Asks which solution to land them in
5. **Create app** (optional) — runs `pac model create` if no model-driven app is targeted
6. **Generate schema** — runs `pac model genpage generate-types` for Dataverse entity pages
7. **Generate code** — produces a complete single-file `.tsx` component (parallel page-builders for multi-page requests)
8. **Deploy** — uploads via `pac model genpage upload` to the selected app
9. **Verify** — optionally opens the page in Playwright for interactive testing

**Usage:** Invoke directly with `/genpage`, or use any of the keywords below to trigger the skill automatically:

- `Build a data grid page for my model-driven app`
- `Build a sortable contact dashboard with charts for my Power App`
- `I need a genux page to display account records with sorting and filtering`
- `Generate a CRUD page for managing custom entities in Power Apps`
- `Add a new page to my model-driven app that shows opportunity records as cards`

## Running Without Interruption

The plugin invokes multiple tools during a session. To reduce approval prompts:

**Option 1 — Permission mode (recommended)**

```jsonc
// .claude/settings.json
{
  "defaultMode": "acceptEdits",
  "permissions": {
    "allow": [
      "Bash(pac *)",
      "Bash(node *)",
      "Bash(powershell *)",
      "Bash(az *)"
    ]
  }
}
```

**Option 2 — Auto-accept all**

```bash
claude --dangerously-skip-permissions
```

## Hooks and guardrails

The plugin registers lifecycle hooks (in `hooks/hooks.json`) that run automatically
while it's loaded. They are **fail-open**: any internal error exits 0, so a hook can
never fail or abort a skill run. Because the plugin installs **globally**, the hooks
are scoped so they don't interfere with unrelated projects: the write-safety guard
only **flags** (never blocks) and only during an active genpage session, and the icon
validator only fires on genpage output. At most, the icon validator blocks a single
tool call (the agent reworks it) — never the whole skill.

| Hook | When | What it does |
|---|---|---|
| Write-safety | before Write/Edit/MultiEdit | **Flags (non-blocking)** writes outside the cwd — only during a genpage session (a `genpage-plan.md` at/under cwd). Never blocks; silent in unrelated projects. |
| Icon validator | after a genpage `.tsx` write | Blocks `@fluentui/react-icons` imports that aren't in the verified list. |
| Skill validator | after a skill runs | Runs the skill's `validate*.js` if it has one. |
| Telemetry | on skill start / prompt | Emits anonymous `skill_started` (see [Telemetry](#telemetry)). |

**Escape hatches** (environment variables — set to `1` or `true`):

| Variable | Effect |
|---|---|
| `MODEL_APPS_DISABLE_HOOKS` | Disables **all** model-apps hooks (validators + telemetry emit). |
| `MODEL_APPS_SKIP_WRITE_GUARD` | Disables **only** the write-safety guard (keeps the others). |

```powershell
# Windows (PowerShell)
$env:MODEL_APPS_DISABLE_HOOKS = "1"
```

```bash
# macOS / Linux (bash)
export MODEL_APPS_DISABLE_HOOKS=1
```

## Telemetry

model-apps ships anonymous, opt-out usage telemetry (1DS). The committed config ships
**disabled** (`disabled: true`) — it emits nothing until go-live, even though it now
carries the provisioned model-apps key + stream (staged, not yet enabled). `disabled:
true` is the active guard; the placeholder-key check is only a secondary guard for
un-provisioned copies. Once enabled it is **on by default** (you opt out).

- **What's collected:** skill name, plugin/PAC/agent versions, OS/Node versions, and
  Dataverse org/tenant GUIDs when signed in. **Never** file paths, prompts, tool
  inputs, entity/table names, URLs, credentials, usernames, hostnames, or any
  user-level identifier (no Entra object id).
- **Local diagnostic mirror:** every event is also written to
  `~/.power-platform-skills/telemetry/model-apps/sessions/<id>/events.jsonl` (even
  when you've opted out of transmission) — hand over that one file when filing an issue.
- **Opt out** per-user with `/model-apps:telemetry off` (re-enable with `on`, check
  with `status`), or for CI/automation set
  `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT=1` (highest precedence).

## Technology Stack

- **React 17 + TypeScript** — all generated page code
- **Fluent UI V9** — `@fluentui/react-components` for styling and components
- **Single file architecture** — each page is one `.tsx` file with `export default GeneratedComponent`
- **DataAPI** — typed CRUD operations against Dataverse tables via `props.dataApi`
- **PAC CLI** — schema generation (`generate-types`) and deployment (`upload`)
- **Playwright** — optional browser verification after deployment

## Documentation

- [Generative Pages with External Tools](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/generative-page-external-tools)
- [Generative Pages Overview](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/generative-pages)
- [Power Apps Model-Driven Apps](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/model-driven-app-overview)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/model)

## License

[MIT](../../LICENSE)
