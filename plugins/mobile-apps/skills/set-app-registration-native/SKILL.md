---
name: set-app-registration-native
description: Use when the user wants to create or update an Entra ID app registration for a Power Apps Wrap mobile app. Wraps the bundled `scripts/register-aad-app.js` to register all 7 Power Platform resource permissions (6 core + PPAPI prod), build broker redirect URIs from the bundle ID, ensure resource service principals, and write the resulting `clientId` into `auth.config.json`. Idempotent — re-running detects existing apps and patches only what's missing.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Set Up Authentication (Native Code App)

Create or update an Entra ID app registration that grants the mobile app access to the full Power Platform resource set (Dynamics CRM, Azure API Connections, Microsoft Graph, Power Apps Service, MS Mobile Management, Power BI Service, and PPAPI prod — all 7 always registered), then write the resulting `clientId` into `auth.config.json`.

This skill is a thin wrapper around [scripts/register-aad-app.js](${CLAUDE_SKILL_DIR}/../../scripts/register-aad-app.js). The script does all the Graph API work; this skill handles defaults from project config, capture stdout, and edits `auth.config.json`.

## Core Principles

- **Create-only** — The script always creates a new registration. To patch an existing one, use the Azure portal or Graph API directly.
- **Self-sufficient** — Works standalone; does not depend on `/create-mobile-app`.
- **JSON output** — The script always prints final JSON to stdout and progress to stderr. Capture stdout for parsing.
- **Public client only** — Mobile apps cannot keep a secret. Created with `signInAudience: AzureADMultipleOrgs` (hardcoded by the script — single-tenant requires manual portal change).
- **Manual admin consent** — Step 4 (admin consent) must be performed by a tenant admin in the Azure portal or via `az ad app permission admin-consent`. The script cannot complete this automatically.
- **Fail-safe** — If the script exits non-zero (insufficient privileges, blocked SP creation, network failure), the skill prints a clear error and stops. `auth.config.json` is left unchanged. The user must resolve the issue and re-run, or create the app registration manually in the Azure portal.

## Script flag surface

The script accepts only one flag. The skill reads `app.config.js` to supply the default.

| Flag | Required | Skill default | Purpose |
|---|---|---|---|
| `--name "<display name>"` | Yes | `<expo.name>` from `app.config.js` | App registration display name. |

All other behavior is fixed: all 7 resource permissions always included, default redirect URIs always registered, JSON always output to stdout.

### Skill-only flags (consumed by the skill, not forwarded)

| Flag | Behavior |
|---|---|
| `--customize` | Open interactive `AskUserQuestion` to override the display name before running. |

## Workflow

1. **Phase 1** — Check Prerequisites (project files, `az` CLI, script presence).
2. **Phase 2** — Plan (read `--name` from `app.config.js`, confirm or customize).
3. **Phase 3** — Run the script (create only).
4. **Phase 3.5** — BLOCKING admin-consent gate.
5. **Phase 4** — Parse JSON, write `auth.config.json`.
6. **Phase 5** — Verify + final summary.

---

## Phase 1 — Check Prerequisites

### 1.1 Locate project

Look from the current directory:
```text
**/auth.config.json
**/app.config.js
```

If neither found, stop and tell the user to scaffold a mobile app first (`/create-mobile-app`).

### 1.2 Read existing auth.config.json (optional)

```bash
cat auth.config.json
```

Capture any existing `msal.clientId` — shown in the Phase 2 confirmation for context only. The script always creates a new registration; the existing value does not affect the run.

### 1.3 Read app.config.js

Read the literal exported config object (CommonJS module). Capture:
- `name` — passed as `--name` unless overridden.

### 1.4 Verify script + Azure CLI

```bash
test -f "${CLAUDE_SKILL_DIR}/../../scripts/register-aad-app.js" && echo script-ok
az account show --query "{tenantId:tenantId, tenantDomain:user.name}" -o json
```

If `az account show` fails → tell the user to run `az login` and stop. (The script also auto-prompts `az login` if the token is expired, but verifying upfront gives a cleaner error.)

Capture the active tenant (used in admin-consent reminder).

---

## Phase 2 — Plan

### 2.1 Read display name

Source priority: `$ARGUMENTS --name` → `app.config.js` `name`.

### 2.2 Confirm (silent default path)

Print one line and proceed:

> `→ create mode: name="<name>". All 7 resource permissions included. Default redirect URIs registered. Pass --customize to override the display name.`

### 2.3 Customize path

If `--customize` was passed, ask only:

| Header | Question | Default |
|---|---|---|
| Display name | What should the app registration be called? | `<expo.name>` |

After the answer, print the same one-line confirmation and proceed.

---

## Phase 3 — Run the Script

### 3.1 Build command

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/register-aad-app.js" \
  --name "<name>" \
  > /tmp/aad-result.json 2> /tmp/aad-progress.log
```

Capture exit code: `EXIT=$?`.

### 3.2 On non-zero exit

Read `/tmp/aad-progress.log` and surface the last error line. Common causes are listed in the Failure Modes table below. Then **fall through to Phase 3.4** to print the failure summary and stop.

### 3.3 On zero exit but empty `/tmp/aad-result.json`

Means the script crashed silently between steps. Read the full progress log; the last `console.error` call typically identifies the failed step (Step 1 create, Step 2 SP, Step 3 resource SPs). Then **fall through to Phase 3.4** to print the failure summary and stop.

### 3.4 Failure — print error and stop

When Phase 3.2 or 3.3 fires, do **not** modify `auth.config.json`. Print the failure summary below and stop. The user must resolve the underlying issue and re-run the skill, or create the app registration manually.

#### Failure summary (use INSTEAD of the regular Phase 5 summary)

```
✗  AAD app registration FAILED. auth.config.json was not modified.

Failure   : <last error line from /tmp/aad-progress.log>
Name tried: <name>

To resolve:
  1. Check the error above (typically: insufficient privileges or blocked SP creation).
  2. Ask a tenant admin to grant 'Application Developer' role, or have them run the
     skill directly, then copy the resulting clientId into auth.config.json manually.
  3. Or create the app registration manually in the Azure portal:
       https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview

Full progress log: /tmp/aad-progress.log
```

---

## Phase 4 — Parse JSON + Write auth.config.json

> **Skip this phase entirely if Phase 3.4 fired** (script failure — `auth.config.json` was not modified). Jump straight to Phase 5.2's **failure summary**.

### 4.1 Read `/tmp/aad-result.json`

The script's output schema:

```json
{
  "displayName": "...",
  "objectId": "...",
  "clientId": "...",
  "signInAudience": "AzureADMultipleOrgs",
  "redirectUris": ["https://login.microsoftonline.com/common/oauth2/nativeclient", "msauth.com.microsoft.PreviewApp://auth"],
  "permissionsConfigured": [{ "name": "...", "resourceAppId": "...", "scopeCount": 1 }, ...],
  "resourceServicePrincipals": [{ "name": "...", "appId": "...", "ok": true }, ...]
}
```

### 4.2 Edit auth.config.json

Two string-replace edits — do not rewrite the file or run it through a JSON parser/serializer (preserves formatting):

```json
"clientId": "<clientId from script>"
"tenantId": "<active az tenantId from Phase 1.4>"
```

Preserve any top-level `environment` object in `auth.config.json`. It is a non-secret cache written by `scripts/resolve-environment.js` (`environmentUrl`, `environmentId`, `tenantId`, `cachedAt`) so later skills can avoid re-running the environment API. Do not delete it when changing `msal.clientId` / `msal.tenantId`.

**Why both fields:** the script creates the new app reg in whatever tenant `az` is currently logged into. If `auth.config.json` keeps a stale `tenantId` from a previous registration, runtime sign-in is sent to the WRONG tenant — causing `AADSTS700016 Application not found in directory`.

If the active az tenant matches the existing `tenantId` already in the file, the edit is a no-op — apply it anyway; the string-replace is idempotent.

**Multi-tenant audience caveat:** the script hardcodes `signInAudience: AzureADMultipleOrgs`. Pinning `tenantId` to a GUID restricts runtime sign-in to that one tenant (typical org case). To open sign-in to any tenant, manually change `tenantId` to `"common"` or `"organizations"` in `auth.config.json` after the skill completes.

**Single-tenant audience (rare):** change `Supported account types` in the Azure portal.

### 4.3 Resource SP failures

If any entry in `resourceServicePrincipals` has `ok: false`, mention it in the Phase 5 summary. Only `Azure API Connections` is `critical: true` and aborts the script run.

---

## Phase 5 — Verify + Final Summary

### 5.1 Type-check

```bash
npm run type-check
```

If errors surface, re-read `auth.config.json` to confirm the JSON is still valid (no trailing commas, quotes intact).

### 5.2 Print summary

```
Entra ID app registration created.

Display name  : <displayName>
Client ID     : <clientId>          (written to auth.config.json → msal.clientId)
Object ID     : <objectId>
Sign-in aud.  : AzureADMultipleOrgs
Tenant        : <tenant GUID from Phase 1.4>   (written to auth.config.json → msal.tenantId)

Redirect URIs registered:
  https://login.microsoftonline.com/common/oauth2/nativeclient
  msauth.com.microsoft.PreviewApp://auth

Permissions configured (delegated):
  ✓ Dynamics CRM            (1 scope)
  ✓ Azure API Connections   (1 scope)
  ✓ Microsoft Graph         (1 scope)
  ✓ Power Apps Service      (1 scope)
  ✓ MS Mobile Management    (1 scope)
  ✓ Power BI Service        (1 scope)
  ✓ PPAPI Prod              (24 scopes)

Resource service principals:
  ✓ <name>  (<appId>)        [✗ if ok=false]

auth.config.json updated.
```

If any resource SP failed (`ok: false`), append:

```
⚠ Some resource service principals could not be created automatically:
  ✗ <name>  (<appId>)
  A tenant admin must run: az ad sp create --id <appId>
```

---

## Failure Modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Script aborts — `Azure API Connections SP could not be created` | Tenant blocks first-party SP creation by non-admins | Phase 3.4 prints an error and stops; tenant admin must create the Azure API Connections service principal (appId shown in `/tmp/aad-progress.log`) then re-run the skill |
| Script exits with `Insufficient privileges to create app registration` | User lacks `Application Developer` role in tenant | Phase 3.4 prints an error and stops; tenant admin grants the role or runs the skill on user's behalf, then re-run |
| Sign-in fails with `AADSTS65001` (consent required) | Admin consent not yet granted | Tenant admin grants consent via portal or `az ad app permission admin-consent` |
| Sign-in fails with `AADSTS700016` (application not found in directory) | `tenantId` in `auth.config.json` does not match the tenant where the app reg lives | Verify the tenant by running `az account show` then re-run the skill (Phase 4.2 will re-pin `tenantId`) |
| `az account get-access-token` mid-script triggers browser login | Azure CLI session expired | Let it complete (script handles it), or run `az login` first |
| `node` exits 0 but `/tmp/aad-result.json` is empty | Script crashed before final JSON print | Read `/tmp/aad-progress.log` for the actual error |
| `npm run type-check` errors after writing config | `auth.config.json` JSON syntax broken | Re-read the file — trailing comma or stray quote |

---

## Notes

- **Resource permissions are hardcoded in the script** ([scripts/register-aad-app.js](${CLAUDE_SKILL_DIR}/../../scripts/register-aad-app.js) — `CORE_RESOURCES` constant + `PPAPI_RESOURCES.prod`, always all 7). To change permissions, edit the script directly.
- **Redirect URIs are fixed** — the script always registers `https://login.microsoftonline.com/common/oauth2/nativeclient` and `msauth.com.microsoft.PreviewApp://auth`. To add additional redirect URIs (e.g. for a custom bundle ID), register them manually in the Azure portal after the skill completes.
- **No user/role assignment** — This skill creates the app registration only. Power Platform connection access is governed by the user's existing tenant permissions.
- **Vendored from upstream** — The script lives at `pa-wrap-tools/templates/expo-app-standalone/scripts/register-aad-app.js`. Our copy has been simplified to create-only; it always outputs JSON to stdout and progress to stderr.
