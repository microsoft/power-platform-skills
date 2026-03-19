# Connector Reference

Applies to all connector skills (`/add-azuredevops`, `/add-teams`, `/add-excel`, `/add-onedrive`, `/add-sharepoint`, `/add-office365`, `/add-mcscopilot`, `/add-connector`). Does NOT apply to Dataverse (`/add-dataverse`).

## Connection ID (Required)

All non-Dataverse connectors require a **connection ID** (`-c`) when adding via `pac code add-data-source`. Without it, the command fails with: `CONNECTION_ID argument is required for connector data sources`.

### Step 1: List Existing Connections

Run the `/list-connections` skill. It uses the Power Platform REST API (Azure CLI auth) to return a table of connection IDs and connector names — no pac CLI or npm package needed.

Look for the connector in the output. Note the **ConnectionId** column value.

### Step 2: If No Connection Exists

The user must create one first:

1. Construct the direct Connections URL using the active environment ID from context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections`
2. Share this link with the user and ask them to click **+ New connection**
3. Search for and create the connector (e.g., "Office 365 Outlook", "Azure DevOps", "Teams")
4. Complete the sign-in/consent flow
5. Re-run `/list-connections` to get the new connection ID

### Step 3: Use Connection ID

Always pass `-c <connection-id>` when adding a connector:

```bash
# Non-tabular connectors
pwsh -NoProfile -Command "pac code add-data-source -a <api-name> -c <connection-id>"

# Tabular connectors (also need -d and -t)
pwsh -NoProfile -Command "pac code add-data-source -a <api-name> -c <connection-id> -d '<dataset>' -t '<table>'"
```


## Inspecting Large Generated Files

Generated service files (e.g., `Office365OutlookService.ts`) can be thousands of lines. **Do NOT read the entire file.** Instead:

1. **List available methods** with Grep:
   ```
   Grep pattern="async \w+" path="src/generated/services/<Connector>Service.ts"
   ```

2. **Find a specific method** and read just that section:
   ```
   Grep pattern="async GetEventsCalendarViewV2" path="src/generated/services/Office365OutlookService.ts" -A 20
   ```

3. **Find parameter types** in the models file:
   ```
   Grep pattern="interface CalendarEventHtmlClient" path="src/generated/models/Office365OutlookModel.ts" -A 30
   ```

This avoids context window bloat and is much faster than reading entire generated files.

## Sub-Skill Invocation

When a connector skill is invoked from another skill (e.g., `/create-power-app` calls `/add-office365`):

- **Check `$ARGUMENTS`** -- if provided, use it as the connector name or configuration
- **Skip redundant questions** -- don't re-ask things the caller already provided (connector name, project path, etc.)
- **Memory bank is still read** -- but skip the summary if the caller just updated it
