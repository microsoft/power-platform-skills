# Connector Reference

Applies to non-Dataverse connector skills such as `/add-connector` and `/add-sharepoint`.

Does NOT apply to `/add-dataverse` — Dataverse uses the runtime's built-in executor and doesn't need a separate connection ID.

## Connection ID or reference (required)

All non-Dataverse connectors require either a **connection ID** (`--connection-id` / `-c`) or a **connection reference** (`--connection-ref` / `-cr`) when adding via `npx power-apps add-data-source`. Without one, the command fails with:

```
CONNECTION_ID argument is required for connector data sources
```

### Step 1 — Get a connection

Use one of these supported paths:

- If the caller already has an existing connection ID, use it directly with `--connection-id`.
- If the app is solution-aware and the caller has a solution ID, run `list-connection-references` and use the returned connection reference name with `--connection-ref`.
- Otherwise create a connection with `create-connection` and use the returned `connectionId`.

```bash
npx power-apps create-connection --api-id <apiId> --json
npx power-apps list-connection-references --solution-id <solutionId> --json
```

With `--json`, `create-connection` prints `{ "connectionId": "...", "displayName": "..." }` on success. Browser-based connection creation is disabled by default in the CLI; if a connector is not SSO-eligible and interactive browser creation is required, set `POWERAPPS_CLI_ENABLE_BROWSER_CONNECTION=true` before running the command, or create the connection in the maker portal.

### Step 2 — If no connection exists

If `create-connection` fails because browser-based connection creation is disabled or the connector needs interactive auth, use the maker portal:

1. Construct the URL using the active environment ID from `power.config.json`:
   `https://make.powerapps.com/environments/<environment-id>/connections`
2. Direct the user to **+ New connection** → search for the connector → sign in / consent.
3. Capture the connection ID from the portal or rerun `npx power-apps create-connection --api-id <apiId> --json` if the connector can now complete.

### Step 3 — Add the data source

Use long-form flags. Run from the app root after `power.config.json` exists, and use the exact `apiId` plus either a `connectionId` from `create-connection`/the portal or a `connectionRef` from `list-connection-references`:

```bash
# Non-tabular connectors (Teams, Office 365 Users, Azure DevOps, etc.)
npx power-apps add-data-source --api-id <apiId> --connection-id <connectionId>

# Tabular connectors (SharePoint, Excel, SQL, etc.) — also need dataset and resource name
npx power-apps add-data-source --api-id <apiId> --connection-id <connectionId> --dataset '<dataset>' --resource-name '<table>'

# SQL stored procedures
npx power-apps add-data-source --api-id shared_sql --connection-id <connectionId> --dataset '<database>' --sql-stored-procedure '<procedure>'
```

**Dataverse is different** — never needs a connection ID:
```bash
npx power-apps add-data-source --api-id dataverse --org-url <environmentUrl> --resource-name <table-logical-name>
```

## Common connector apiId values

These are common connector API IDs you may see in connection output:

| Connector | apiId | Type |
|---|---|---|
| SharePoint Online | `shared_sharepointonline` | tabular |
| Microsoft Teams | `shared_teams` | non-tabular |
| Office 365 Users | `shared_office365users` | non-tabular |
| Office 365 Outlook | `shared_office365` | non-tabular |
| Excel Online (Business) | `shared_excelonlinebusiness` | tabular |
| OneDrive for Business | `shared_onedriveforbusiness` | tabular |
| Azure DevOps | `shared_visualstudioteamservices` | non-tabular |
| Azure Blob Storage | `shared_azureblob` | tabular |
| SQL Server | `shared_sql` | tabular |

## Discovering datasets and tables (tabular connectors)

```bash
npx power-apps list-datasets --api-id <apiId> --connection-id <connectionId> --json
npx power-apps list-tables --api-id <apiId> --connection-id <connectionId> --dataset '<dataset>' --json
npx power-apps list-sqlStoredProcedures --connection-id <connectionId> --dataset '<database>' --json
```

For SharePoint, the **dataset** is the site URL (e.g., `https://contoso.sharepoint.com/sites/sales`). The **table** is the list display name.

## Other Power Apps CLI discovery commands

Use these instead of hand-rolled discovery when they match the user's goal:

```bash
npx power-apps list-connection-references --solution-id <solutionId> --json
npx power-apps list-environment-variables --json
npx power-apps list-flows --search '<flow-name-or-keyword>' --json
npx power-apps find-dataverse-api --search '<operation-name>' --json
npx power-apps create-connection --api-id <apiId> --json
```

Cloud flows are added with `add-flow`, not `add-data-source`:

```bash
npx power-apps add-flow --flow-id <flow-guid> --non-interactive
npx power-apps remove-flow --flow-id <flow-guid> --non-interactive
```

For local Power Apps player testing after the Expo web server is running, use `run` from the app root. It serves `power.config.json` and prints a play URL with local app and connection configuration:

```bash
npx power-apps run --local-app-url http://localhost:<expo-web-port> --port 8080
```

## Inspecting large generated files

Generated service files (e.g., `Office365OutlookService.ts`) can be thousands of lines. **Do NOT read the entire file.** Instead:

1. **List available methods**:
   ```text
   Grep pattern="async \w+" path="src/generated/services/<Connector>Service.ts"
   ```
2. **Find a specific method**:
   ```text
   Grep pattern="async getMyProfile" path="src/generated/services/Office365UsersService.ts" -A 20
   ```
3. **Find parameter types** in the models file:
   ```text
   Grep pattern="interface UserProfile" path="src/generated/models/Office365UsersModel.ts" -A 30
   ```

This avoids context window bloat and is much faster than reading entire generated files.

## Connector routing (runtime)

`PowerAppsHostProvider` in `app/_layout.tsx` handles all connector routing at runtime — both Dataverse and non-Dataverse connectors use the same unified pipeline. No separate executor or provider wiring is needed.

When a screen calls a generated service method:
1. `PowerAppsHostProvider` resolves the connection from `connectionReferences` in `power.config.json`
2. If the connection requires setup (missing or expired), `ConnectionSetupScreen` is shown automatically
3. `NativePowerAppsBridge` dispatches the call with the correct auth token

## OAuth consent (runtime, first call)

The first call to a non-Dataverse service triggers OAuth consent. The native player opens a system browser; the user signs in; the redirect comes back via the app's `<scheme>://oauth-callback` deep link. The connection is then bound to that user's identity in the env.

Subsequent calls reuse the connection silently until the refresh token expires (~90 days for most M365 connectors). When that happens, calls return `401` and the user must re-bind via the maker portal, then rerun `/list-connections` or provide the updated connection ID/reference.
