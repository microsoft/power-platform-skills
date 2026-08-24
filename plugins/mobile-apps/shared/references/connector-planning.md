# Connector Planning Reference

Human-readable connector policy. The foreground preflight uses the versioned
`scripts/mobile-plan-preflight-catalog.json`; the final execution authority is
`.tmp/mobile-plan-execution-contract.json → connectorOperations[]`. Used by
`native-app-planner` and `setup-datamodel` to render and review those facts.

---

## Step 1 — Infer Connectors from Requirements

Scan the requirements text and wizard answers for keywords. Map matches to connectors. Do NOT ask the user yet — propose first.

| If requirements mention… | Infer this connector | API name | Skill |
|---|---|---|---|
| email, inbox, send email, outlook, calendar, meeting, appointment | Office 365 Outlook | `office365` | `/add-connector office365` |
| SharePoint, SP list, document library, site, .sharepoint.com | SharePoint Online | `sharepointonline` | `/add-sharepoint` |
| Teams, channel, post message, Teams chat, @mention | Microsoft Teams | `teams` | `/add-connector teams` |
| Excel, spreadsheet, workbook, .xlsx | Excel Online (Business) | `excelonlinebusiness` | `/add-connector excelonlinebusiness` |
| OneDrive, file upload, file download, file storage | OneDrive for Business | `onedriveforbusiness` | `/add-connector onedriveforbusiness` |
| Azure DevOps, work item, bug, sprint, pipeline, ADO | Azure DevOps | `azuredevops` | `/add-connector azuredevops` |
| Copilot Studio, copilot agent, chatbot, bot, MCS | Copilot Studio | `mcscopilot` | `/add-connector mcscopilot` |
| SQL, database, Azure SQL, SQL Server | SQL Server | `sql` | `/add-connector sql` |

If a requirement is vague (e.g., "external data", "third-party API") but no keyword matches, do not infer a connector — flag it as "unknown, will need /add-connector at runtime."

**Important:** Dataverse is NOT listed here. If the requirements need custom business data / tables, that is handled by `/add-dataverse` and captured in the `## Data Model` section, not the `## Connectors` section.

---

## Step 2 — Present to User for Confirmation

After inferring, present using `AskUserQuestion`:

> "Based on your requirements, I think your app needs these external connectors:
>
> | Connector | Why |
> |---|---|
> | Office 365 Outlook | [specific requirement that triggered this] |
> | SharePoint Online | [specific requirement] |
>
> Does this look right? Select all that apply, or tell me if I missed any."

Provide a multi-select with:
- Each inferred connector as a pre-selected option
- "Add another connector" as a free-text option
- "No connectors needed" to opt out entirely

If no connectors were inferred from requirements, still ask:

> "Does your app need to connect to any external services? For example: SharePoint, Teams, email, Excel, OneDrive, Azure DevOps."

Give the user a multi-select of the full connector list (none pre-selected).

---

## Step 3 — Build the Connector Plan Section

For each confirmed connector, record:

```markdown
## Connectors

| Connector | API name | Why needed | Skill |
|---|---|---|---|
| Office 365 Outlook | `office365` | Send task completion notifications | `/add-connector` |
| SharePoint Online | `sharepointonline` | Read project milestones list | `/add-connector` |
```

If no connectors: write "None — this app uses only Dataverse and/or device-native capabilities."

---

## Step 4 — Pass structured operations to Screen Planner

When spawning the screen-planner agent, include the resolved execution-contract
rows, not only the display list:

```
Connector operations confirmed:
- id, API name, generated service, exact method
- typed input/output and failure state
- requirement/screen consumers

Schema-v3 per-screen operations reference the correct generated service for each data access:
- Dataverse tables → use Cr123_<Table>Service from src/generated/services/
- Connectors → use <ConnectorName>Service from src/generated/services/
```

The execution-contract validator rejects unresolved connector methods before
approval, and the build-pack validator rejects service drift before builders.

---

## Execution Mapping

At execution time, each confirmed connector maps to a skill invocation:

| Connector | Invocation |
|---|---|
| SharePoint Online | `/add-sharepoint` |
| Any other non-Dataverse connector | `/add-connector <api-name>` |

`/add-connector` owns the `npx power-apps add-data-source` call for its connector. The orchestrator never calls `npx power-apps add-data-source` directly.
