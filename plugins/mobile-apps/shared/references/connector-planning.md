# Connector Planning Reference

Shared logic for inferring and confirming Power Platform connectors from app
requirements. `/create-mobile-app` shows the inferred connector interpretation
inside Gate 1 and approves the exact connector architecture at Gate 2.
`setup-datamodel` uses the same logic in its own planning phase.

---

## Step 1 — Infer Connectors from Requirements

Scan the requirements text and wizard answers for keywords. Map matches to connectors. Do NOT ask the user yet — propose first.

| If requirements mention… | Infer this connector | API name | Skill |
|---|---|---|---|
| email, inbox, send email, outlook, calendar, meeting, appointment | Office 365 Outlook | `office365` | `/add-connector office365` |
| SharePoint, SP list, document library, .sharepoint.com | SharePoint Online | `sharepointonline` | `/add-sharepoint` |
| Teams, channel, post message, Teams chat, @mention | Microsoft Teams | `teams` | `/add-connector teams` |
| Excel, spreadsheet, workbook, .xlsx | Excel Online (Business) | `excelonlinebusiness` | `/add-connector excelonlinebusiness` |
| OneDrive, OneDrive file, onedrive.com | OneDrive for Business | `onedriveforbusiness` | `/add-connector onedriveforbusiness` |
| Azure DevOps, work item, bug, sprint, pipeline, ADO | Azure DevOps | `azuredevops` | `/add-connector azuredevops` |
| Copilot Studio, copilot agent, chatbot, bot, MCS | Copilot Studio | `mcscopilot` | `/add-connector mcscopilot` |
| Azure SQL, SQL Server, explicit SQL database | SQL Server | `sql` | `/add-connector sql` |

If a requirement is vague (e.g., "external data", "third-party API") but no keyword matches, do not infer a connector — flag it as "unknown, will need /add-connector at runtime."

**Important:** Dataverse is NOT listed here. If the requirements need custom business data / tables, that is handled by `/add-dataverse` and captured in the `## Data Model` section, not the `## Connectors` section.

---

## Step 2 — Reconcile with the owning approval

### Inside `/create-mobile-app`

Gate 1 already contains the connector interpretation. Do not ask a separate
connector question. Treat explicitly named connectors as locked requirements
and strongly inferred connectors as approved interpretations unless the user
used Gate 1 `Edit` to remove them.

During architecture planning:

1. Read `Gate 1 capability interpretation` from the orchestrator prompt.
2. Reconcile the approved candidates against available connector discovery.
3. Record exact API names, authentication/readiness state, and screen/data
   consumers in `## Connectors`.
4. Surface unavailable or ambiguous approved connectors as Gate 2 concerns or
   blockers; never silently drop them.
5. Let the user confirm or revise the exact connector architecture only inside
   Gate 2.

If Gate 1 says `none inferred`, keep `## Connectors` explicit:
`None — this app uses only Dataverse and/or device-native capabilities.`
Do not ask a speculative connector question.

### Inside standalone `setup-datamodel`

Present inferred connectors as part of that skill's existing grouped planning
approval. Do not create an extra connector-only approval.

---

## Step 3 — Build the Connector Plan Section

For each approved and validated connector, record:

```markdown
## Connectors

| Connector | API name | Why needed | Skill |
|---|---|---|---|
| Office 365 Outlook | `office365` | Send task completion notifications | `/add-connector` |
| SharePoint Online | `sharepointonline` | Read project milestones list | `/add-connector` |
```

If no connectors: write "None — this app uses only Dataverse and/or device-native capabilities."

---

## Step 4 — Pass to Screen Planner

When spawning the screen-planner agent, include the Gate 2 connector list in
the prompt:

```
Connectors confirmed:
- Office 365 Outlook (office365) — send task completion notifications
- SharePoint Online (sharepointonline) — read project milestones list

Per-screen specs must reference the correct generated service for each data access:
- Dataverse tables → use Cr123_<Table>Service from src/generated/services/
- Connectors → use <ConnectorName>Service from src/generated/services/
```

This ensures every screen spec names the exact service the screen-builder agent will import.

---

## Execution Mapping

At execution time, each confirmed connector maps to a skill invocation:

| Connector | Invocation |
|---|---|
| SharePoint Online | `/add-sharepoint` |
| Any other non-Dataverse connector | `/add-connector <api-name>` |

`/add-connector` owns the `npx power-apps add-data-source` call for its connector. The orchestrator never calls `npx power-apps add-data-source` directly.
