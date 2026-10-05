---
name: set-app-registration-native
description: Use when the user wants to discover and verify available Entra ID app registrations, wire one to a Power Apps Wrap mobile app, or create one through the Wrap page and update auth.config.json.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

# Set App Registration Native

Wire `auth.config.json` to an Entra ID app registration for a Power Apps Wrap mobile app.

This skill is read-only against Entra ID:
- Do **not** create or patch app registrations from this skill.
- Discover all tenant app registrations visible to the signed-in Azure CLI user
  and verify the applicable native runtime permission profile before writing
  `auth.config.json`.
- Use the public Power Apps Wrap app-registration page to create, repair, or
  complete verification. Some permission repairs require an Azure tenant admin.
- Do not direct the user to add redirect URIs or API permissions manually.

## Workflow

1. Verify app root -> 2. Resolve environment + tenant -> 3. Discover + check registrations -> 4. Select or create -> 5. Write `auth.config.json` -> 6. Validate JSON -> 7. Summary

---

## Step 1 — Verify app root

From the current directory, verify a generated mobile app root:

```bash
test -f auth.config.json && test -f app.config.js && test -f power.config.json
```

If this fails, stop and tell the user to run `/create-mobile-app` first or open the generated app folder.

## Step 2 — Resolve environment + tenant

**Telemetry checkpoint: `resolve_registration_environment`**

Use the same environment selected by the generated app. Prefer `.resolved-environment.json`, then `auth.config.json.environment`, then `power.config.json` + resolver:

```bash
ENV_ID=$(node -e "console.log(require('./power.config.json').environmentId || '')")
TENANT_ID=$(node -e "try { const j=require('./.resolved-environment.json'); console.log(j.tenantId || '') } catch { console.log('') }" 2>/dev/null)
if [ -z "$TENANT_ID" ]; then
  TENANT_ID=$(node -e "try { const j=require('./auth.config.json'); console.log((j.environment && j.environment.tenantId) || '') } catch { console.log('') }" 2>/dev/null)
fi
if [ -z "$TENANT_ID" ] && [ -n "$ENV_ID" ]; then
  node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ENV_ID" > .resolved-environment.json
  TENANT_ID=$(node -e "const j=require('./.resolved-environment.json'); console.log(j.tenantId || '')")
fi
echo "$ENV_ID"
echo "$TENANT_ID"
```

If `ENV_ID` is empty, stop: `power.config.json` is not initialized.

If `TENANT_ID` is empty, stop: environment resolution failed. Do not guess the tenant and do not use a stale `msal.tenantId` as the authority source.

## Step 3 — Determine the profile, discover, and check registrations

Use the connector profile when either condition is true:

1. `native-app-plan.md` has a `## Connectors` section containing a
   non-Dataverse Power Platform connector.
2. `power.config.json.connectionReferences` is an object with one or more keys.

Dataverse entries in `databaseReferences` are part of the baseline and do not
activate connector checks. When the connector profile applies, set
`CONNECTOR_PERMISSION_ARG=--include-connectors`; otherwise set it to an empty
string. Existing configuration is authoritative for this standalone skill: an
empty `connectionReferences` object and no planned connectors means baseline
checking only.

### Discover and check registrations

**Telemetry checkpoint: `discover_native_app_registrations`**

Run:

```bash
node "${PLUGIN_ROOT}/scripts/discover-app-registrations.js" --tenant-id "$TENANT_ID" $CONNECTOR_PERMISSION_ARG
```

The command is read-only and lists every tenant app registration that Microsoft
Graph allows the signed-in Azure CLI user to read. Discovery is best-effort.
Treat any nonzero exit, Azure CLI or Microsoft
Graph error, tenant mismatch, malformed/unusable JSON, permission-resolution
failure, or empty registration list as a discovery failure. Do not retry or ask
the user to repair Azure CLI authentication. Immediately use the original flow:

```text
App registration discovery was unavailable. Paste the Entra ID app registration
client ID for tenant <tenant-guid> (GUID format), or type skip:
```

Validate a pasted GUID and continue with permission check `unavailable`. If the
user enters `skip`, use the existing skip path. Never report an unavailable check
as passed. The environment-specific Wrap URL in Step 4 remains available if the user
needs to create a registration before pasting its client ID.

The script returns one boolean, `passesRequiredPermissions`, per registration.
Registrations that pass sort first, followed by failures; each group is sorted by
display name. Preserve that order and show up to 10 registrations per page.

Render each page as ordinary response text before calling `AskUserQuestion`; do
not pass registrations or pagination commands through the structured `choices`
field. Only the create and skip actions use choices, as specified below. Number
registrations globally using their 1-based position in the full sorted result,
so numbering does not restart on later pages:

```text
App registrations — showing <start>–<end> of <total>

<global-number>. <displayName> (Client ID: <short-client-id>...)
   <✓ All required permissions configured|✗ Missing required permissions>
```

Build `<short-client-id>` from the shortest unique client-ID prefix on the
current page, with a minimum of 4 characters. Show the full client ID only after
selection. Do not expose partial scores or individual permission details in the
listing.

After printing the page, call `AskUserQuestion` with the free-form input plus
exactly these two structured choices on every page:

1. `Create a new registration in Power Apps Wrap`
2. `Skip for now`

In the free-form question, advertise only navigation commands that are valid
for the current page:

```text
Enter a registration number, or type next, previous, or paste:
```

Trim free-form answers and match commands case-insensitively:
- A displayed global registration number selects that registration.
- `next` and `previous` move one page without rerunning discovery.
- `paste` asks for a client ID and follows the pasted-ID path below.
- The `Create a new registration in Power Apps Wrap` choice opens the Wrap
  creation path below.
- The `Skip for now` choice follows the existing skip path.

Omit `previous` on the first page and `next` on the last page. For an
unrecognized free-form command or a number outside the displayed page, explain
the valid numbers/actions, reprint the same page, and ask again. Every returned
registration must remain reachable; never truncate to the first page or silently
select a result, including when only one is returned.

The boolean checks the native runtime profile, not the Wrap deployment profile.
Every app requires Dynamics CRM `user_impersonation` and Power Platform API
`PowerApps.Apps.Read`. With `--include-connectors`, it also requires Azure API
Connections `Runtime.All` plus Power Platform API
`Connectivity.Connectors.Read`, `Connectivity.Connections.Read`,
`Connectivity.Connections.Write`, and
`Connectivity.Connections.UserConsent`. Do not require Microsoft Graph,
PowerApps Service, Power BI, Mobile Application Management, or unrelated Power
Platform API scopes. Wrap remains the final authority for redirect platforms,
packaging permissions, third-party-app allowlisting, and admin consent.

## Step 4 — Select, create, or verify

For a selected result, show the full client ID and the same self-contained
permission status used in the listing. For `✗ Missing required permissions`, show
`missingRequiredPermissions` and ask whether to open Wrap to repair it, choose
another registration, or continue anyway. For an unavailable check, show
`Permission status not verified`. Preserve any warning in the summary.

For `Create a new registration`, print:

```text
https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration
```

Tell the user to create it there and use Wrap's one-click repair for flagged
permissions. Some repairs require an Azure tenant admin. Then rerun Step 3 so the
new registration can be selected and checked.

For a pasted GUID, rerun the checker with:

```bash
node "${PLUGIN_ROOT}/scripts/discover-app-registrations.js" --tenant-id "$TENANT_ID" --client-id "<client-guid>" $CONNECTOR_PERMISSION_ARG
```

On any check failure or if it is not returned, accept the validated GUID and mark
the permission check `unavailable`; directory roles can limit discovery. Continue to the write
step without requiring discovery to succeed.

- If the user enters `skip`, leave `msal.clientId` blank, ensure `msal.tenantId` is set to the resolved tenant, preserve/add the `environment` cache, print the skip warning in Step 7, and stop.
- Otherwise validate the selected client ID's GUID format before editing.

## Step 5 — Write `auth.config.json`

**Telemetry checkpoint: `write_native_auth_configuration`**

Update `auth.config.json`:
- `msal.clientId` = pasted client ID
- `msal.tenantId` = resolved tenant ID from Step 2
- Preserve any top-level `environment` object.
- If `environment` is missing and `.resolved-environment.json` exists, copy the non-secret resolved environment fields into top-level `environment`.

Use structured JSON editing. Do not store tokens, secrets, or current-user Dataverse identity fields.

Example target shape:

```json
{
  "msal": {
    "clientId": "<client-id>",
    "tenantId": "<tenant-guid>"
  },
  "environment": {
    "environmentId": "<environment-id>",
    "environmentUrl": "https://org.crm.dynamics.com",
    "tenantId": "<tenant-guid>",
    "cachedAt": "<iso timestamp>"
  }
}
```

Do not touch `src/playerConfig.ts`; auth identifiers live in `auth.config.json` only.

## Step 6 — Validate JSON

**Telemetry checkpoint: `validate_native_auth_configuration`**

```bash
node -e "JSON.parse(require('fs').readFileSync('auth.config.json','utf8')); console.log('auth.config.json OK')"
```

If dependencies are installed, optionally run:

```bash
npx tsc --noEmit
```

Do not run npm install or native builds from this skill.

## Step 7 — Summary

If a client ID was written:

```text
App registration wired.
Client ID : <client-id>
Tenant    : <tenant-guid>
Permission status: <✓ All required permissions configured|✗ Missing required permissions|Not verified>
Wrap check: required
Config    : auth.config.json
```

If skipped:

```text
Auth client ID was not configured.
Tenant was preserved in auth.config.json: <tenant-guid>
The app will fail to sign in until a client ID is added.
Run /set-app-registration-native later, or paste a client ID into auth.config.json.
```
