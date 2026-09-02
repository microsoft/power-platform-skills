# Connector Planning Reference

Shared logic for inferring and confirming Power Platform connectors from app requirements. Used by foreground `/create-mobile-app`, `/edit-app`, and `/setup-datamodel` planning.

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

Connector inference and confirmation are side-effect-free architecture inputs.
Do not query a publisher prefix, Dataverse snapshot/cache/schema, or create a
data source while planning this list.

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

Confirmation means the app may integrate with that connector; it does not make
the connector the persistence owner of every related concept. After Product
Scope exists, `.tmp/architecture-decisions.json` assigns exactly one owner to
each `dataEntities` concept. `compile-persistence-contract.js` is the sole
authority that derives system-of-record ownership and mode.

Mode rules:

- `connector-only`: every durable concept is owned by an approved
	`connector:<api-name>`; no Dataverse planning, schema, services, seed, or
	Mobile Offline Profile artifact may be created.
- `local-prototype`: durable concepts are local (with optional transient UI
	state); no Dataverse or connector-owned persistence is implied and no
	Dataverse artifact may be created.
- `mixed`: only `persistence.dataverseConceptIds` may enter Dataverse planning;
	connector/local concepts remain with their declared owners and must never be
	duplicated as convenience tables.

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

If no connectors: write "None — this app uses only its approved Dataverse,
local, transient, and/or device-native architecture."

---

## Step 4 — Pass to foreground screen planning

When authoring Workflow Journey and screen build packs, include both the
confirmed connector list and the compiled concept owners in the planning
context:

```
Connectors confirmed:
- Office 365 Outlook (office365) — send task completion notifications
- SharePoint Online (sharepointonline) — read project milestones list

Per-screen specs must reference the correct generated service for each data access:
- Dataverse tables → use Cr123_<Table>Service from src/generated/services/
- Connectors → use <ConnectorName>Service from src/generated/services/
- Local concepts → use the approved local/package adapter
- Transient concepts → use view-model state only
```

Every read/write/sync/upload/download operation must name its `conceptId` and
the exact compiled owner. A confirmed connector with no owned concept may still
perform an integration action; it is not a system of record by implication.

---

## Execution Mapping

At execution time, each confirmed connector maps to a skill invocation:

| Connector | Invocation |
|---|---|
| SharePoint Online | `/add-sharepoint` |
| Any other non-Dataverse connector | `/add-connector <api-name>` |

`/add-connector` owns the `npx power-apps add-data-source` call for its connector. The orchestrator never calls `npx power-apps add-data-source` directly.
