---
name: set-app-registration-native
description: Use when the user wants to wire a Power Apps Wrap mobile app to an Entra ID app registration by opening the Power Apps Wrap app-registration page, pasting the resulting client ID, and updating auth.config.json.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

# Set App Registration Native

Wire `auth.config.json` to an Entra ID app registration for a Power Apps Wrap mobile app.

This skill is manual by design:
- Do **not** create or patch app registrations from this skill.
- Use the public Power Apps Wrap app-registration page and then write the pasted client ID into `auth.config.json`.

## Workflow

1. Verify app root -> 2. Resolve environment + tenant -> 3. Open Wrap registration URL -> 4. Capture client ID -> 5. Write `auth.config.json` -> 6. Validate JSON -> 7. Summary

---

## Step 1 — Verify app root

From the current directory, verify a generated mobile app root:

```bash
test -f auth.config.json && test -f app.config.js && test -f power.config.json
```

If this fails, stop and tell the user to run `/create-mobile-app` first or open the generated app folder.

## Step 2 — Resolve environment + tenant

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

## Step 3 — Open Wrap app-registration page

Print the public Power Apps Wrap URL for the active environment:

```text
https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration
```

Tell the user:

```text
Open the Power Apps Wrap app-registration page for this environment:
https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration

Create/register the app there, then paste the Application (client) ID here.
If you already have a client ID, paste it directly.
If you cannot configure auth now, type skip.
```

## Step 4 — Capture client ID

Ask:

```text
Paste the Entra ID app registration client ID for tenant <tenant-guid> (GUID format), or type skip:
```

- If the user enters `skip`, leave `msal.clientId` blank, ensure `msal.tenantId` is set to the resolved tenant, preserve/add the `environment` cache, print the skip warning in Step 7, and stop.
- Otherwise validate GUID format before editing.

## Step 5 — Write `auth.config.json`

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
Config    : auth.config.json
```

If skipped:

```text
Auth client ID was not configured.
Tenant was preserved in auth.config.json: <tenant-guid>
The app will fail to sign in until a client ID is added.
Run /set-app-registration-native later, or paste a client ID into auth.config.json.
```
