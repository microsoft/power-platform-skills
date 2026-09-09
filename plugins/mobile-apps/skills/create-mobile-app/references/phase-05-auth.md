# Phase 5 of 10 — Authentication

**Steps:** 7. **Previous:** [4 — Design](phase-04-design.md). **Next:** [6 — Data](phase-06-data.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Advance only after this phase's exit condition passes or its explicit auth deferral is recorded.

### Step 7 — Auth config

**Telemetry checkpoint: `configure_native_authentication`**

The template ships blank `msal.clientId`/`msal.tenantId`. Never reuse baked-in registration IDs.
Use the selected Power Platform environment's resolved tenant: `ACTIVE_TENANT_ID`, then matching
`.resolved-environment.json`, then matching `auth.config.json.environment.tenantId`.
The old `msal.tenantId` is not authoritative. If absent, rerun `scripts/resolve-environment.js`
using the approved environment ID in `power.config.json`; stop if still unresolved.

Keep the non-secret sibling `environment` object (`environmentId`, `environmentUrl`, `tenantId`,
`cachedAt`) when editing auth config. Never add tokens, secrets or current-user Dataverse identity.

## 7.2 — Foreground registration choice

Ask through the foreground question interface:

1. Paste an existing Entra app registration client ID for the resolved tenant.
2. Create one from the environment's Power Apps Wrap page, then paste its client ID.
3. Skip for now; configure auth later.

Do not silently default: registration ownership varies by tenant/admin role.
For paste, validate GUID format. For creation, print:
`https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration`.
The user creates/configures it there and returns the client ID or chooses skip.
Do not direct them to manual Entra redirect URI, delegated permission or tenant-wide admin-consent
setup; the Wrap experience configures the native registration for this flow.

## 7.3–7.5 — Write chosen IDs or explicit deferral

Edit only `auth.config.json`:

- Accepted GUID: set `msal.clientId` to that value and `msal.tenantId` to the resolved tenant.
- Skip: set `msal.clientId` to `""` and `msal.tenantId` to the resolved tenant.
- Preserve the sibling `environment` block, or add the matching resolved environment object.

Never create/modify the registration on the user's behalf or touch `src/playerConfig.ts`.
On skip, warn that sign-in will fail until configured, and record the deferral:
`/set-app-registration-native` is the later manual helper. Continue to Step 8.
