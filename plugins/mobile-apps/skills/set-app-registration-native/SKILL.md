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
- Use the public Power Apps Wrap app-registration page to create/configure the
  registration, then write the pasted client ID into `auth.config.json`.
- Do not direct the user to add redirect URIs or API permissions manually.
  Tenant-wide admin consent is not required for this Wrap registration flow.

## Workflow

1. Verify app root -> 2. Resolve environment + tenant -> 3. Open Wrap registration URL -> 4. Capture client ID -> 5. Write `auth.config.json` -> 6. Validate JSON -> 7. Revalidate login / repair invalid resource -> 8. Summary

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

## Step 3 — Open Wrap app-registration page

**Telemetry checkpoint: `open_wrap_app_registration`**

Print the public Power Apps Wrap URL for the active environment:

```text
https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration
```

Tell the user:

```text
Open the Power Apps Wrap app-registration page for this environment:
https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration

Create/register the app there, then paste the Application (client) ID here.
The Wrap page configures the native registration. Do not add redirect URIs or
API permissions manually; tenant-wide admin consent is not required.
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

## Step 7 — Revalidate login and diagnose invalid resource

After writing the client ID, have the user restart/reload the app and attempt a fresh sign-in. Do not treat valid JSON or a GUID-shaped client ID as proof that the registration is correctly configured.

If login succeeds, continue to Step 8.

If login fails with `AADSTS650057: Invalid resource` (or text saying the client requested access to a resource that is not listed in the app registration's required resource access), diagnose it as a **Wrap registration configuration mismatch**, not a tenant-ID formatting problem and not a reason to guess API permissions.

Repair flow:

1. Confirm the app is using the environment ID and tenant resolved in Step 2.
2. Re-open the exact environment's Wrap page:

   ```text
   https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration
   ```

3. Ask the user to repair/reconfigure the registration there. If the Wrap page cannot repair the existing registration, create a replacement registration through that page and paste the new Application (client) ID.
4. Do **not** add guessed Dynamics CRM, Dataverse, Power Apps, Microsoft Graph, or custom API permissions in Entra. Do not invent resource/application IDs, redirect URIs, scopes, or admin-consent steps. The Wrap page is the authority for this registration shape.
5. If a replacement client ID is supplied, repeat GUID validation and Step 5's structured JSON update.
6. Restart/reload the app and perform a fresh login again. Do not report the registration as wired until login succeeds.

If the repaired/recreated Wrap registration still returns `AADSTS650057`, stop with the environment ID, tenant ID, client ID, and exact error text (no tokens) so the user can escalate. Do not continue cycling through guessed permissions.

If the user stops before a successful login, report `DONE_WITH_CONCERNS` and state that the config was updated but authentication remains unverified; do not use the success summary below.

## Step 8 — Summary

If a client ID was written:

```text
App registration wired.
Client ID : <client-id>
Tenant    : <tenant-guid>
Config    : auth.config.json
Login     : revalidated
```

If skipped:

```text
Auth client ID was not configured.
Tenant was preserved in auth.config.json: <tenant-guid>
The app will fail to sign in until a client ID is added.
Run /set-app-registration-native later, or paste a client ID into auth.config.json.
```
