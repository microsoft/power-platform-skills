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
