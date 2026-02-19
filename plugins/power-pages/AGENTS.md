# AGENTS.md — Power Pages Plugin

This file provides guidance to AI Agents when working with the **power-pages** plugin.

## What This Plugin Is

A plugin for creating, deploying, and managing Power Pages code sites. Supports static SPA frameworks (React, Vue, Angular, Astro) with Dataverse integration, Web API access, and browser-based previews via Playwright.

## Local Development

Test this plugin locally:

```bash
claude --plugin-dir /path/to/plugins/power-pages
```

Each framework template under `skills/create-site/assets/{react,vue,angular,astro}/` has its own `package.json` with `dev`, `build`, and `preview` scripts (Vite for React/Vue, Angular CLI for Angular, Astro CLI for Astro).

## Architecture

```
.claude-plugin/plugin.json     ← Plugin metadata (name, version, keywords)
.mcp.json                      ← MCP server config (Playwright for browser automation)
agents/
  data-model-architect.md      ← Agent: proposes Dataverse data models (read-only)
  webapi-integration.md        ← Agent: implements Web API integration in frontend code
  webapi-permissions.md        ← Agent: proposes Web API permissions plan (read-only)
scripts/
  generate-uuid.js             ← Shared UUID v4 generator (used by multiple skills)
  check-activation-status.js   ← Checks if site is already activated (used by deploy-site, activate-site)
references/                    ← Shared reference docs used by multiple skills
  odata-common.md              ← Auth headers, token refresh, error handling, retry patterns
  dataverse-prerequisites.md   ← PAC CLI check, Azure CLI token, API access verification
  framework-conventions.md     ← Framework detection, paths, route discovery
  datamodel-manifest-schema.md ← .datamodel-manifest.json format spec
skills/
  create-site/
    SKILL.md                   ← Skill definition with frontmatter (model, allowed-tools, hooks)
    assets/{react,vue,angular,astro}/  ← Framework templates with __PLACEHOLDER__ tokens
    references/design-aesthetics.md  ← Design principles, font/color/motion guidance for inline design step
    scripts/validate-site.js   ← Node script validating generated sites
  deploy-site/
    SKILL.md                   ← Deployment skill definition
  setup-datamodel/
    SKILL.md                   ← Dataverse data model creation skill definition
    references/odata-api-patterns.md  ← OData API body templates for table/column/relationship creation
    scripts/validate-datamodel.js ← Node script validating Dataverse data model creation
  add-sample-data/
    SKILL.md                   ← Sample data insertion skill definition
    references/odata-record-patterns.md  ← OData API patterns for record creation and lookups
  add-seo/
    SKILL.md                   ← SEO essentials skill definition (robots.txt, sitemap.xml, meta tags)
    scripts/validate-seo.js    ← Node script validating SEO assets (robots.txt, sitemap.xml, meta tags)
  activate-site/
    SKILL.md                   ← Site activation/provisioning skill definition
    scripts/activate-site.js   ← Activates a site via PP API + polls status
    scripts/generate-subdomain.js  ← Random subdomain suggestion generator
    scripts/validate-activation.js ← Validates site was provisioned via PP API
  create-webroles/
    SKILL.md                   ← Web roles creation skill definition
    scripts/validate-webroles.js ← Node script validating web role YAML files were created
  integrate-webapi/
    SKILL.md                   ← Web API integration skill definition
    scripts/validate-webapi-integration.js ← Node script validating Web API integration code
  setup-auth/
    SKILL.md                   ← Authentication & authorization skill definition
    references/authentication-reference.md ← Login/logout flow, auth service, framework patterns
    references/authorization-reference.md  ← Role-based access control, guards, directives
    scripts/validate-auth.js   ← Node script validating auth service and authorization code
```

## Plugin Components

### Agents

Auto-triggered by the main conversation when relevant:

- `data-model-architect`: Read-only agent that analyzes site requirements, discovers existing Dataverse tables via OData API, and proposes a data model (new/modified/reused tables + Mermaid ER diagram). Uses `pac env who` + Azure CLI auth to query Dataverse. Renders the ER diagram visually in the browser via Playwright (writes a temp HTML file with Mermaid.js CDN, navigates to it, takes a screenshot) before entering plan mode. Does NOT create, modify, or delete any tables — purely advisory. The main conversation uses its output to create tables.
- `webapi-integration`: Implementation agent that creates production-ready Web API integration code for a single Dataverse table in a Power Pages code site. Detects the frontend framework (React/Vue/Angular/Astro), creates a shared `powerPagesApi.ts` client (token management, retry logic, OData URL builder) if one doesn't exist, then generates TypeScript entity types, a domain mapper, and a CRUD service layer for the target table. Also creates framework-specific hooks (React), composables (Vue), or injectable services (Angular). Follows Power Pages Web API best practices: `/_api/` endpoints, dual token headers, `@odata.bind` for lookups, explicit `$select` (never `*`), formatted value annotations, exponential backoff retry, and 8-minute token TTL. Handles one table per invocation — invoke separately for multiple tables.
- `webapi-permissions`: Read-only agent that analyzes site code, discovers existing web roles and table permissions, queries Dataverse for table columns, and proposes a complete Web API permissions plan (table permissions + site settings). Checks for `.powerpages-site` folder to verify site deployment. Renders a Mermaid flowchart showing web roles → table permissions → tables visually in the browser via Playwright. Never uses `*` for Web API field settings — always lists specific columns. Does NOT create any YAML files — purely advisory. The main conversation uses its output to create table permission and site setting files.

### Skills

User-invocable via `/power-pages:<skill-name>`:

- `create-site`: 6-step workflow — gather requirements (including design direction), plan (with explicit scaffold prerequisites), scaffold from template, build pages/components/routing with design applied from the start using `skills/create-site/references/design-aesthetics.md` and live Playwright preview, review, deploy
- `deploy-site`: 6-step workflow — verify PAC CLI, authenticate, confirm environment, upload via `pac pages upload-code-site`, verify deployment (confirm `.powerpages-site` folder, commit, offer activation), handle blocked JS attachments
- `setup-datamodel`: 7-step workflow — verify prerequisites, invoke data-model-architect agent, review proposal, pre-creation checks, create tables & columns via OData API, create relationships, publish & verify. Writes `.datamodel-manifest.json` for hook validation.
- `add-sample-data`: 6-step workflow — verify prerequisites, discover tables (from `.datamodel-manifest.json` or OData API), select tables & configure record count, generate & review sample data plan, insert records via OData API with relationship handling, verify & summarize.
- `activate-site`: 5-step workflow — verify prerequisites (PAC CLI auth + Azure CLI token + cloud-aware API URL resolution + activation status check via shared script), gather parameters (site name, subdomain, website record ID), confirm with user, activate & poll via `skills/activate-site/scripts/activate-site.js`, present summary with site URL.
- `add-seo`: 7-step workflow — verify site exists, gather SEO config (production URL, exclusions, meta description), plan & approve, create robots.txt, generate sitemap.xml from discovered routes, add meta tags (title, description, viewport, Open Graph, Twitter Card, favicon) to index.html, verify via Playwright & commit.
- `create-webroles`: 6-step workflow — verify `.powerpages-site/web-roles/` exists (redirect to deploy-site if missing), discover existing roles, determine new roles needed, create web role YAML files with UUIDs from shared `scripts/generate-uuid.js`, verify web roles (validate files, UUIDs, uniqueness constraints), review & prompt deployment via deploy-site skill.
- `integrate-webapi`: 7-step workflow — verify site exists, use Explore agent to analyze code and identify tables needing Web API integration, review plan with user, invoke `webapi-integration` agent per table to create API client/types/services/hooks, verify integrations (validate all files exist, project builds), invoke `webapi-permissions` agent to configure table permissions and site settings, review & deploy via `deploy-site` skill.
- `setup-auth`: 8-step workflow — verify prerequisites (site deployed + web roles), gather auth requirements and plan, create auth service with Entra ID login/logout (anti-forgery token + form POST), create authorization utilities (role checking), create auth UI (AuthButton component), apply role-based access control to components, verify auth setup (validate files, build, auth UI renders), create `ProfileRedirectEnabled` site setting and deploy.

Skills are defined in `SKILL.md` files with YAML frontmatter (name, description, allowed-tools, model, hooks).

### Hooks

Defined in each skill's SKILL.md frontmatter:

- Stop hooks run when a skill session ends. Each skill defines its own hooks so validation only runs in the correct context:
  - `create-site`: command hook runs `validate-site.js` + prompt hook checks site completeness
  - `setup-datamodel`: command hook runs `validate-datamodel.js` + prompt hook checks data model completeness
  - `add-sample-data`: prompt hook checks sample data insertion completeness
  - `activate-site`: command hook runs `validate-activation.js` + prompt hook checks activation completeness
  - `add-seo`: command hook runs `validate-seo.js` + prompt hook checks SEO asset completeness
  - `create-webroles`: command hook runs `validate-webroles.js` + prompt hook checks web role creation completeness
  - `integrate-webapi`: command hook runs `validate-webapi-integration.js` + prompt hook checks integration completeness
  - `setup-auth`: command hook runs `validate-auth.js` + prompt hook checks auth setup completeness
- Hooks are defined in SKILL.md frontmatter (not a global hooks.json) so they only fire for the relevant skill session

### Shared Scripts

Shared utility scripts live at `scripts/` and are referenced by multiple skills and agents via `${CLAUDE_PLUGIN_ROOT}/scripts/`.

- `generate-uuid.js`: Generates a random UUID v4. Self-contained, no dependencies. Used by `create-webroles` and the main agent when creating table permission / site setting files from the `webapi-permissions` agent plan.
- `update-skill-tracking.js`: Updates skill usage tracking site settings. Takes `--projectRoot`, `--skillName`, and `--authoringTool` args. The agent passes its own name as `--authoringTool` (e.g., `ClaudeCode`, `GitHubCopilot`). Creates/increments a per-skill counter (`Site-AI-<SkillName>.sitesetting.yml`) and records the authoring tool (`Site-AI-AuthoringTool.sitesetting.yml`). Exits silently if `.powerpages-site/site-settings/` does not exist. Used by all 9 skills.
- `check-activation-status.js`: Checks whether a Power Pages site is already activated (provisioned) in the environment. Takes `--projectRoot` arg. Reads `siteName` from `powerpages.config.json`, looks up `websiteRecordId` via `pac pages list`, queries the Power Platform GET websites API, and matches by both `websiteRecordId` and `name`. Outputs JSON: `{ activated: true/false, siteName, websiteRecordId, websiteUrl }` or `{ error }`. Used by `deploy-site` and `activate-site`.

### Shared References

Shared reference documents live at `references/` and are referenced by multiple skills via relative paths (e.g., `../../references/odata-common.md`). This avoids duplicating common patterns across skill-specific reference docs and SKILL.md files.

- `odata-common.md`: Auth headers, PowerShell token helper, token refresh cadence, HTTP status codes, Dataverse error codes, retry pattern. Used by `setup-datamodel` and `add-sample-data`.
- `dataverse-prerequisites.md`: PAC CLI auth check (`pac env who`), Azure CLI token acquisition, API access verification (`WhoAmI`). Used by `setup-datamodel` and `add-sample-data`.
- `framework-conventions.md`: Supported frameworks, framework → build tool / router / build output / public dir / index HTML mapping, framework detection via `package.json`, route discovery patterns. Used by `create-site` and `add-seo`.
- `datamodel-manifest-schema.md`: Schema spec for `.datamodel-manifest.json` (fields, types, usage). Written by `setup-datamodel`, read by `add-sample-data`, validated by `validate-datamodel.js`.
- `skill-tracking-reference.md`: Skill usage tracking instructions — script invocation syntax, skill name mapping table, and YAML format. Referenced by all 9 skills to record usage via `update-skill-tracking.js`.

Skill-specific reference docs (e.g., `skills/setup-datamodel/references/odata-api-patterns.md`) contain only patterns unique to that skill and point to the shared docs via `${CLAUDE_PLUGIN_ROOT}/references/` paths for common content.

### MCP Integration

Playwright MCP server for browser automation and live site previews during development.

## Template System

Framework templates use `__PLACEHOLDER__` tokens (e.g., `__SITE_NAME__`, `__PRIMARY_COLOR__`, `__BG_COLOR__`) that get replaced during site scaffolding. The `gitignore` file is stored without the dot prefix to avoid git interference in the plugin repo — it gets renamed to `.gitignore` during scaffolding.

## Validation Scripts

### `create-site/scripts/validate-site.js`

Checks generated sites for: required files (`package.json`, `.gitignore`, `powerpages.config.json`), config schema fields (`$schema`, `compiledPath`, `siteName`, `defaultLandingPage`), build/dev scripts in package.json, unreplaced `__PLACEHOLDER__` tokens, git initialization, and `src/` directory existence.

### `setup-datamodel/scripts/validate-datamodel.js`

Checks created Dataverse data models by reading `.datamodel-manifest.json` (written by the `setup-datamodel` skill during table creation). Queries the Dataverse OData API to verify each table and column in the manifest actually exists in the environment. Gracefully exits 0 on auth errors (doesn't block if token expired) or when no manifest is found (not a data model session).

### `add-seo/scripts/validate-seo.js`

Checks SEO assets added to Power Pages sites: verifies `robots.txt` exists in `public/` with proper `User-agent` and `Sitemap` directives, `sitemap.xml` exists with `<urlset>` and `<loc>` entries (no unreplaced placeholders), and `index.html` has `meta description` and `viewport` tags. Only runs validation when at least one SEO file (robots.txt or sitemap.xml) is detected — gracefully exits 0 otherwise to avoid blocking non-SEO sessions.

### `create-webroles/scripts/validate-webroles.js`

Checks that web role YAML files were created in `.powerpages-site/web-roles/`. Validates each file has required `id` and `name` fields and that the `id` field contains a valid UUID v4 format. Gracefully exits 0 when no `.powerpages-site/web-roles/` directory is found (not a web roles session).

### `integrate-webapi/scripts/validate-webapi-integration.js`

Checks that Web API integration code was created for a Power Pages code site: verifies the shared API client (`src/shared/powerPagesApi.ts` or equivalent) exists, at least one service file exists in `src/shared/services/` or `src/services/` with `/_api/` endpoint references, and corresponding type definition files exist in `src/types/`. Gracefully exits 0 when no integration files are detected (not an integration session).

### `setup-auth/scripts/validate-auth.js`

Checks that authentication and authorization code was created: verifies auth service (`src/services/authService.ts` or equivalent) exists with login/logout/getCurrentUser functions and anti-forgery token handling, Power Pages type declarations (`src/types/powerPages.d.ts`) exist, authorization utilities (`src/utils/authorization.ts`) exist, and an auth UI component (AuthButton or equivalent) exists. Gracefully exits 0 when no auth files are detected (not an auth session).

## Skill Development Guide

All skills in this plugin follow a consistent set of patterns. When creating a new skill, follow every convention below to maintain consistency across the plugin.

### Phase-Wise Workflow

Every skill is structured as a sequence of **phases** (typically 5–8). Each phase has a single, clear goal and an explicit output statement describing what it delivers. Phases execute sequentially — never skip or reorder them.

A typical phase sequence looks like:

1. **Prerequisites / Verify** — Confirm tools, auth, project structure exist
2. **Discover / Gather** — Collect user input, analyze existing code/state
3. **Plan / Review** — Present a plan and get user approval before proceeding
4. **Implement / Create** — Do the actual work (create files, call APIs, scaffold)
5. **Verify** (**mandatory**) — Validate the output: confirm files exist, formats are correct, project builds, UI renders
6. **Deploy / Summarize** — Offer deployment and present a summary with next steps

**Every skill must have a dedicated verification phase.** This is not optional. The verification phase must be a standalone phase (not a substep buried inside another phase) and must appear after the implementation work is complete but before the final review/deploy phase. What verification checks depends on the skill:

- **File-creating skills**: Verify files exist, formats are valid, no unreplaced placeholders, project builds
- **API-calling skills**: Verify records/resources were created by querying them back, present success/failure counts
- **Deployment skills**: Verify deployment artifacts exist (e.g., `.powerpages-site` folder), confirm command output reported success
- **UI-creating skills**: Verify the project builds and the new UI renders correctly via Playwright

### Task Tracking (To Do List)

Every skill uses `TaskCreate`, `TaskUpdate`, and `TaskList` to track progress:

1. **Create all tasks upfront** — At the very start of Phase 1, before any work begins, create one task per phase using `TaskCreate`. The user sees the full scope immediately. Never add tasks incrementally mid-workflow.
2. **Task fields** — Each task must include:
   - `subject`: Imperative form (e.g., "Verify prerequisites")
   - `activeForm`: Present continuous form shown in spinner (e.g., "Verifying prerequisites")
   - `description`: Detailed description of what the phase does and its acceptance criteria
3. **Task lifecycle** — Mark each task `in_progress` via `TaskUpdate` when starting the phase, then `completed` when the phase finishes. Progress through tasks sequentially.
4. **Progress tracking table** — Include a table at the end of the SKILL.md listing all tasks with their `subject`, `activeForm`, and `description` fields. This serves as the reference for task creation.

Example:

```
| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Confirm PAC CLI auth, acquire Azure CLI token, verify API access |
| Gather configuration | Gathering configuration | Collect user input for site name, options, preferences |
| ... | ... | ... |
```

### SKILL.md Frontmatter

Every SKILL.md starts with YAML frontmatter following this structure:

```yaml
---
name: <skill-name>              # kebab-case identifier
description: >-                  # User-facing description listing trigger phrases
  <when to use this skill and synonym phrases>
user-invocable: true
argument-hint: <optional hint>   # Describes optional argument the user can pass
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate, TaskUpdate, TaskList, AskUserQuestion  # Comma-separated list (not JSON array or YAML list)
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/scripts/validate-<skill>.js"'
          timeout: 30
        - type: prompt
          prompt: "<completeness checklist — returns { ok: true } or { ok: false, reason }>"
          timeout: 30
---
```

### User Confirmation at Key Decision Points

Every skill must pause and wait for user input at critical junctures using `AskUserQuestion`. Document these decision points explicitly in the SKILL.md under a **"Key Decision Points (Wait for User)"** section. Common points:

- After gathering requirements — confirm understanding before planning
- After presenting a plan — get approval before implementation
- After implementation — accept results or request changes
- Before deployment — deploy now or later

### Deployment Prompt

Skills that create or modify site artifacts should end with a deployment prompt:

1. Announce completion: "The X has been created/configured locally."
2. Ask via `AskUserQuestion`: "Ready to deploy?" with options: "Yes, deploy now (Recommended)" / "No, I'll deploy later"
3. If "Yes" — invoke the `/power-pages:deploy-site` skill
4. If "No" — remind user: "Run `/power-pages:deploy-site` when ready"
5. Present a summary and suggest next steps

### Validation Hooks (Stop Hooks)

Every skill that creates files must define two Stop hooks in its frontmatter:

1. **Command hook** — A Node.js validation script (`scripts/validate-<skill>.js`) that verifies artifacts were created correctly (files exist, valid format, no unreplaced placeholders). Must import shared boilerplate from `scripts/lib/validation-helpers.js`. Must gracefully exit 0 when the session didn't involve this skill (e.g., no relevant files detected).
2. **Prompt hook** — A completeness checklist that returns `{ ok: true }` or `{ ok: false, reason: "..." }`. Lists 4–6 specific conditions that must all be true for the skill to be considered complete.

### Shared Resources (DRY)

Before writing any new logic, check for existing shared utilities and references:

- **Shared references** in `references/` at the plugin root — reuse via `${CLAUDE_PLUGIN_ROOT}/references/` paths
- **Shared scripts** in `scripts/` — e.g., `generate-uuid.js`, `scripts/lib/validation-helpers.js`
- **Skill-specific references** go in `skills/<skill-name>/references/` and must point to shared docs for common content rather than duplicating

### Graceful Failure (No Auto-Rollback)

Skills that make API calls must:

- Track each API call result (success/failure/skipped)
- **Never** attempt automated rollback on failure
- Report failures clearly and continue with remaining items
- Present a summary at the end showing what succeeded and what failed

### Token Refresh for Long Operations

Skills that make repeated Dataverse/API calls must refresh the Azure CLI access token periodically — every ~20 records, 3–4 tables, or ~60 seconds — to avoid expiration mid-workflow.

### Git Commits at Milestones

Skills that create or modify source files must commit after every significant milestone:

- After creating each page or component
- After applying design foundations
- After each phase that modifies files completes

Each commit should be focused with a clear message describing what was added or changed.

### Agent Spawning

Skills that delegate work to agents (via the `Task` tool) must:

- Process agent invocations **sequentially, not in parallel** — the first invocation may create shared files that subsequent ones depend on
- Wait for each agent to complete before invoking the next
- Present agent output to the user for approval before proceeding

## Key Constraint

Only static SPA frameworks are supported (React, Vue, Angular, Astro). Server-rendered frameworks (Next.js, Nuxt, Remix, SvelteKit) are **not** supported.

**DRY (Don't Repeat Yourself):** Never duplicate logic across files. Before writing new code, check for existing shared utilities and patterns:

- **Validation scripts** must import from `scripts/lib/validation-helpers.js` for boilerplate (`approve`, `block`, `runValidation`), path finders (`findPath`, `findProjectRoot`, `findPowerPagesSiteDir`), auth helpers (`getAuthToken`, `getEnvironmentUrl`, `getPacAuthInfo`), and constants (`UUID_REGEX`, `CLOUD_TO_API`). Do not re-implement these in individual scripts.
- **UUID generation** must use the shared `scripts/generate-uuid.js`. Do not copy it into skill-specific `scripts/` directories.
- **Reference docs** shared across skills live in `references/` at the plugin root. Do not duplicate OData patterns, prerequisite steps, or framework conventions in skill-specific files — reference the shared docs via `${CLAUDE_PLUGIN_ROOT}/references/`.
- When adding a new validation script, extend `validation-helpers.js` if the new helper would be useful to other scripts. Keep skill-specific logic in the individual script, shared logic in the library.

## Maintaining This File

When you make significant changes to this plugin (new skills, agents, hooks, templates, or architectural shifts), update this file to keep it accurate for future agents.
