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
| [PAC CLI](https://learn.microsoft.com/en-us/power-platform/developer/cli/introduction) >= 2.3.1 | Schema generation, deployment | `dotnet tool install -g Microsoft.PowerApps.CLI.Tool` |

## Skills

The plugin provides a single skill that covers the full lifecycle of a generative page.

### `/genpage`

Creates, updates, and deploys generative pages for model-driven Power Apps. Handles the complete workflow in a single session:

1. **Validate prerequisites** — checks Node.js and PAC CLI version
2. **Authenticate** — verifies PAC CLI auth and environment selection
3. **Gather requirements** — asks about page type, data source, and specific features
4. **Generate schema** — runs `pac model genpage generate-types` for Dataverse entity pages
5. **Generate code** — produces a complete single-file `.tsx` component
6. **Deploy** — uploads via `pac model genpage upload` to the selected app
7. **Verify** — optionally opens the page in Playwright for interactive testing

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
      "Bash(powershell *)"
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

- [Power Apps Model-Driven Apps](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/model-driven-app-overview)
- [Generative Pages Overview](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/generative-pages)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/model)

## License

[MIT](../../LICENSE)
