# Connector Reference

Applies to non-Dataverse connector skills such as `/add-connector` and `/add-sharepoint`.

Does NOT apply to `/add-dataverse` — Dataverse uses the runtime's built-in executor and doesn't need a separate connection ID.

## Connection ID or reference (required)

All non-Dataverse connectors require either a **connection ID** (`--connection-id` / `-c`) or a **connection reference** (`--connection-ref` / `-cr`) when adding via `npx pa app add data-source --non-interactive`. Without one, the command fails with:

```
CONNECTION_ID argument is required for connector data sources
```

### Step 1 — Get a connection

Use one of these supported paths:

- If the caller already has an existing connection ID, use it directly with `--connection-id`.
- If the app is solution-aware and the caller has a solution ID, run `connection list-references` and use the returned connection reference name with `--connection-ref`.
- Otherwise create a connection with `connection create` and use the returned `connectionId`.

```bash
npx pa connection create --connector <apiId> --json --non-interactive
npx pa connection list-references --solution-id <solutionId> --non-interactive
```

With `--json`, `connection create` prints `{ "connectionId": "...", "displayName": "..." }` on success. Browser-based connection creation is disabled by default in the CLI; if a connector is not SSO-eligible and interactive browser creation is required, set `POWERAPPS_CLI_ENABLE_BROWSER_CONNECTION=true` before running the command, or create the connection in the maker portal.

### Step 2 — If no connection exists

If `connection create` fails because browser-based connection creation is disabled or the connector needs interactive auth, use the maker portal:

1. Construct the URL using the active environment ID from `power.config.json`:
   `https://make.powerapps.com/environments/<environment-id>/connections`
2. Direct the user to **+ New connection** → search for the connector → sign in / consent.
3. Capture the connection ID from the portal or rerun `npx pa connection create --connector <apiId> --json --non-interactive` if the connector can now complete.

### Step 3 — Add the data source

Use long-form flags. Run from the app root after `power.config.json` exists, and use the exact `apiId` plus either a `connectionId` from `connection create`/the portal or a `connectionRef` from `connection list-references`:

```bash
# Non-tabular connectors (Teams, Office 365 Users, Azure DevOps, etc.)
npx pa app add data-source --connector <apiId> --connection-id <connectionId> --non-interactive

# Tabular connectors (SharePoint, Excel, SQL, etc.) — also need dataset and resource name
npx pa app add data-source --connector <apiId> --connection-id <connectionId> --dataset '<dataset>' --table '<table>' --non-interactive

# SQL stored procedures
npx pa app add data-source --connector shared_sql --connection-id <connectionId> --dataset '<database>' --procedure '<procedure>' --non-interactive
```

**Dataverse is different** — never needs a connection ID:
```bash
npx pa app add data-source --connector dataverse --table <table-logical-name> --non-interactive
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
npx pa connection list-datasets --connector <apiId> --connection-id <connectionId> --non-interactive
npx pa connection list-tables --connector <apiId> --connection-id <connectionId> --dataset '<dataset>' --non-interactive
npx pa connection list-procedures --connection-id <connectionId> --dataset '<database>' --non-interactive
```

For SharePoint, the **dataset** is the site URL (e.g., `https://contoso.sharepoint.com/sites/sales`). The **table** is the list display name.

## Other Power Apps CLI discovery commands

Use these instead of hand-rolled discovery when they match the user's goal:

```bash
npx pa connection list-references --solution-id <solutionId> --non-interactive
npx pa app list-environment-variables --non-interactive
npx pa app list-flows --search '<flow-name-or-keyword>' --non-interactive
npx pa app find-dataverse-api --search '<operation-name>' --json --non-interactive
npx pa connection create --connector <apiId> --json --non-interactive
```

Cloud flows are added with `app add flow`, not `app add data-source`:

```bash
npx pa app add flow --flow-id <flow-guid> --non-interactive
npx pa app remove flow --flow-id <flow-guid> --force --non-interactive
```

Do not use local Expo web-player testing from mobile-app skills. Mobile-app runtime diagnosis uses the native dev-client flow and `/debug-app` reading Metro terminal output.

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

`PowerAppsProvider` in `app/_layout.tsx` handles all connector routing at runtime — both Dataverse and non-Dataverse connectors use the same unified pipeline. No separate executor or provider wiring is needed.

When a screen calls a generated service method:
1. `PowerAppsProvider` resolves the connection from `connectionReferences` in `power.config.json`
2. If the connection requires setup (missing or expired), `ConnectionSetupScreen` is shown automatically
3. `NativePowerAppsBridge` dispatches the call with the correct auth token

## OAuth consent (runtime, first call)

The first call to a non-Dataverse service triggers OAuth consent. The native player opens a system browser; the user signs in; the redirect comes back via the app's `<scheme>://oauth-callback` deep link. The connection is then bound to that user's identity in the env.

Subsequent calls reuse the connection silently until the refresh token expires (~90 days for most M365 connectors). When that happens, calls return `401` and the user must re-bind via the maker portal, then rerun `/list-connections` or provide the updated connection ID/reference.
