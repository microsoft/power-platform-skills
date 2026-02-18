# Power Pages Plugin

Create and deploy Power Pages code sites using modern frontend frameworks. This plugin provides a complete workflow — from scaffolding a new site to deploying it, setting up data models, authentication, and Web API integrations — all through conversational AI skills.

**Supported frameworks**: React, Angular, Vue, Astro (static SPAs)

## Installation

### From the marketplace

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install power-pages@power-platform-skills
```

### From a local clone

```bash
claude --plugin-dir /path/to/power-platform-skills/plugins/power-pages
```

## Prerequisites

| Prerequisite | Required for | Install |
|---|---|---|
| [Node.js](https://nodejs.org/) (LTS) | All skills | `winget install OpenJS.NodeJS.LTS` |
| [PAC CLI](https://learn.microsoft.com/en-us/power-platform/developer/cli/introduction) | Deploy, activate, data model | `dotnet tool install -g Microsoft.PowerApps.CLI.Tool` |
| [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) | Data model, sample data, activation | `winget install Microsoft.AzureCLI` |

## Skills

The plugin provides 9 skills that cover the full lifecycle of a Power Pages code site. Each skill is invoked conversationally — just describe what you want to do.

### `/create-site`

> "Create a Power Pages site with React for a job board"

Scaffolds a complete code site from a framework template, applies your design direction (fonts, colors, layout), builds out pages and components, and provides a live preview in the browser throughout development.

- Choose from React, Vue, Angular, or Astro
- Real images from Unsplash (no placeholders)
- Live browser preview during development
- Git commits at each milestone

### `/deploy-site`

> "Deploy my site to Power Pages"

Builds your project and uploads it to your Power Pages environment using `pac pages upload-code-site`. Handles common blockers like JavaScript attachment restrictions.

- Verifies PAC CLI installation and authentication
- Confirms target environment before deploying
- Creates `.powerpages-site` folder with deployment artifacts

### `/activate-site`

> "Activate my site"

Provisions a website record in your Power Platform environment so your site is accessible at a public URL.

- Generates a subdomain suggestion (you choose the final name)
- Polls provisioning status until the site is live
- Provides the final site URL

### `/setup-datamodel`

> "Create Dataverse tables for my site"

Analyzes your site's requirements and creates Dataverse tables, columns, and relationships via OData API calls.

- Spawns a **Data Model Architect** agent that proposes tables based on your site's code
- Alternatively, you can upload an ER diagram
- Generates a `.datamodel-manifest.json` used by downstream skills
- Visualizes the data model as a Mermaid ER diagram

### `/add-sample-data`

> "Add sample data to my tables"

Populates your Dataverse tables with realistic, contextually appropriate records.

- Reads table definitions from `.datamodel-manifest.json` or queries OData metadata
- Generates values that match column types and names (emails, dates, currencies, etc.)
- Inserts records in dependency order (parent tables first)

### `/integrate-webapi`

> "Connect my site to the Dataverse tables"

Creates production-ready Web API integration code for your frontend, including a shared API client, typed services, and framework-specific hooks or composables.

- Shared `powerPagesApi.ts` client with anti-forgery token management and retry logic
- TypeScript entity types and CRUD service layer per table
- Framework-specific patterns: React hooks, Vue composables, Angular services
- Updates existing components to use real data (replaces mock data)
- Configures table permissions and site settings for Web API access

### `/setup-auth`

> "Set up authentication for my site"

Adds login/logout functionality and role-based authorization to your site.

- Auth service with anti-forgery token handling
- Login/logout UI component
- Role-based UI patterns (show/hide elements by role)
- Framework-specific implementation (hooks, composables, services)

### `/create-webroles`

> "Create web roles for my site"

Generates web role YAML files in your `.powerpages-site` directory for managing user access.

- Discovers existing roles before creating new ones
- Generates proper UUIDs for each role
- Enforces uniqueness constraints (one anonymous role, one authenticated role)

### `/add-seo`

> "Add SEO to my site"

Adds search engine optimization artifacts: `robots.txt`, `sitemap.xml`, and meta tags (Open Graph, Twitter Cards).

- Auto-discovers routes from your framework's router
- Generates sitemap with production URLs
- Adds viewport, charset, description, and social sharing meta tags

## Agents

The plugin includes 3 specialized agents that are spawned automatically by skills when needed:

| Agent | Purpose | Triggered by |
|---|---|---|
| **Data Model Architect** | Analyzes your site and proposes a Dataverse data model with an ER diagram | `/setup-datamodel` |
| **Web API Integration** | Creates typed API client, services, and hooks for a Dataverse table | `/integrate-webapi` |
| **Web API Permissions** | Proposes table permissions and site settings for Web API access | `/integrate-webapi` |

The Data Model Architect and Web API Permissions agents are **read-only** — they analyze and propose but never create or modify resources directly. You review and approve their proposals before any changes are made.

## Typical Workflow

A common end-to-end workflow looks like this:

```
1. /create-site       →  Scaffold + design + build pages
2. /deploy-site       →  Upload to Power Pages environment
3. /activate-site     →  Provision a public URL
4. /setup-datamodel   →  Create Dataverse tables
5. /add-sample-data   →  Populate tables with test records
6. /integrate-webapi  →  Connect frontend to Dataverse
7. /create-webroles   →  Define access roles
8. /setup-auth        →  Add login/logout + role-based UI
9. /add-seo           →  Search engine optimization
10. /deploy-site      →  Push final changes live
```

Steps can be run independently — you don't need to follow this exact order. Each skill checks its own prerequisites and will tell you if something is missing.

## Running Without Interruption

The plugin invokes multiple tools during a session. To reduce approval prompts:

**Option 1 — Permission mode (recommended)**

```jsonc
// .claude/settings.json
{
  "defaultMode": "acceptEdits",
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(git *)",
      "Bash(pac *)",
      "Bash(az *)",
      "Bash(node *)"
    ]
  }
}
```

**Option 2 — Auto-accept all**

```bash
claude --dangerously-skip-permissions
```

## Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
- [Power Pages REST API](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites)
- [Dataverse Web API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview)

## License

[MIT](../../LICENSE)

