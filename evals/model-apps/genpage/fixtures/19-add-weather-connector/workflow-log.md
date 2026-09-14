# Workflow Log — Eval 19: adding a connector to an existing page (edit flow)

## Phase 0 — Working directory setup
- Working directory created: `seattle-weather-edit/` (kebab-case derived from "Seattle weather page edit")
- Plugin root: `D:\Projects\power-platform-skills\plugins\model-apps`

## Phase 1 — Planner (genpage-planner agent invoked via Task)

### Prereq checks
- `node --version` → v20.11.0
- `pac help` → PAC CLI Version 2.11.0 (> 2.10.0 verified)
- (Commands run separately, not chained with &&)

### Auth check
- `pac auth list` → active profile `maker@contoso.onmicrosoft.com`
- Active environment: https://contoso-dev.crm10.dynamics.com/ (reported to user)

### Discovery questions (AskUserQuestion)
- Question 1 (new or edit): user answered "Edit existing"
- Planner returned `{ "action": "edit" }` — Phases 2-8 of the create flow are skipped

## Edit Phase 1 — App and page selection

### 1a. App discovery
- `pac model list` → 2 apps found:
  - Operations Hub — `aa112233-1122-1122-1122-aabbccdd1234`
  - Field Service Lite — `cc334455-3344-3344-3344-ccddeeff3456`
- Apps presented via AskUserQuestion using the actual Display Name + app-id from that output
- User selected "Operations Hub" (`aa112233-1122-1122-1122-aabbccdd1234`)

### 1b. Page discovery
- `pac model genpage list --app-id aa112233-1122-1122-1122-aabbccdd1234` → 2 pages found:
  - Seattle Weather — `bb223344-2233-2233-2233-bbccddee2345`
  - SharePoint Documents — `dd445566-4455-4455-4455-ddeeff004567`
- Pages presented via AskUserQuestion using the actual names + page-id GUIDs
- User selected "Seattle Weather" (`bb223344-2233-2233-2233-bbccddee2345`)

### 1c. Selection restated
- "Editing page **Seattle Weather** (`bb223344-…`) in app **Operations Hub** (`aa112233-…`)." — confirmed before download

## Edit Phase 2 — Download
- `pac model genpage download --app-id aa112233-1122-1122-1122-aabbccdd1234 --page-id bb223344-2233-2233-2233-bbccddee2345 --path seattle-weather-edit`
- Produced `seattle-weather-edit/bb223344-2233-2233-2233-bbccddee2345/` with page.tsx, page.js, config.json, prompt.txt

## Edit Phase 3 — Schema generation
- `config.json` read: `dataSources` is absent and `connectorBindings` is absent → page is mock-data with no connectors
- RuntimeTypes generation SKIPPED (no Dataverse data sources)

## Edit Phase 3.5 — Connector edit (delegated to genpage-connector-builder)
- Edit intent mentions a real weather source → orchestrator dispatches `genpage-connector-builder` via the Task tool with **Mode: `edit`**, the working directory, `${PLUGIN_ROOT}`, the envUrl, and the EXISTING bindings (none — the page had no `connectorBindings`)
- `node "${PLUGIN_ROOT}/scripts/list-connections.js" "https://contoso-dev.crm10.dynamics.com/"` → 2 connections found:
  - MSN Weather: logical name `new_uxtest_msnweather`, connectorId `/providers/Microsoft.PowerApps/apis/shared_msnweather`, readyToBind true
  - SharePoint Online: logical name `new_uxtest_sharepoint`, connectorId `/providers/Microsoft.PowerApps/apis/shared_sharepointonline`
- Selected MSN Weather (best match for "real weather"): `new_uxtest_msnweather`
- Agent wrote `connector-bindings.md` (binding table) and `connectors.json`
- `connectors.json` written to seattle-weather-edit/connectors.json as a BARE JSON ARRAY (not the config.json `{ "connectorBindings": [...] }` wrapper): [{ "logicalName": "new_uxtest_msnweather", "connectorId": "/providers/Microsoft.PowerApps/apis/shared_msnweather", "dataset": "", "operations": ["CurrentWeather"] }]

## Edit Phase 4 — Edit planning
- `genpage-edit-planner` agent invoked via Task tool
- edit-planner read page.tsx, config.json and prompt.txt from the `bb223344-…/` folder
- `genpage-edit-plan.md` written to the working directory root (not inside `bb223344-…/`)
- Plan records `## Connector Changes` = add `new_uxtest_msnweather`, and `## Preservation Constraints` = keep the five-day forecast sample data

## Edit Phase 5 — Apply edits
- Orchestrator read genpage-edit-plan.md, references/rules.md, references/connectors.md and page.tsx
- Read `${PLUGIN_ROOT}/references/verified-icons.txt` before editing
- Edits applied inline with the Edit tool on `seattle-weather-edit/bb223344-2233-2233-2233-bbccddee2345/page.tsx`
- MSN Weather is a REST connector → used `executeConnectorOperation('new_uxtest_msnweather', 'CurrentWeather', { Location: 'Seattle', units: 'I' })`, NOT queryConnectorTable
- Presence-checked the method, checked `response.ok` before reading `response.body`, and kept the inline sample conditions as the fallback
- Five-day forecast left untouched per the plan's Preservation Constraints
- Post-edit icon verification: grep `from "@fluentui/react-icons"` → `TemperatureRegular`, `WeatherSunnyRegular`, `WaterRegular` all verified against verified-icons.txt

## Edit Phase 6 — Deployment
- `pac model genpage upload --app-id aa112233-1122-1122-1122-aabbccdd1234 --page-id bb223344-2233-2233-2233-bbccddee2345 --code-file seattle-weather-edit/bb223344-2233-2233-2233-bbccddee2345/page.tsx --connectors "seattle-weather-edit/connectors.json" --prompt "Bind the current conditions card to the MSN Weather connector; leave the five-day forecast as sample data." --model claude-sonnet`
- `--add-to-sitemap` omitted (page already in the sitemap)
- `--prompt` is the DELTA of this edit only, not a restatement of the original page description
- Upload succeeded

## Phase 8 — Summary
- 1 page updated: Seattle Weather in Operations Hub
- Connector binding added: `new_uxtest_msnweather` (MSN Weather, CurrentWeather operation)
- Five-day forecast preserved as sample data
