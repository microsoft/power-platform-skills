---
name: ensure-pipelines-host
description: >-
  Ensures the tenant has a usable Power Platform Pipelines host environment
  before any pipeline operation runs. Detects host state via the same
  resolution order as the Power Apps UI (org-db setting → BAP env metadata →
  default-custom-host setting); if any existing host (Platform or Custom) is
  found, uses it. If no host is bound to the source env, provisions a new
  **Custom Host** via the BAP env-create API with the `D365_ProjectHost`
  template (fast path), or guides the user through PPAC install / `New custom
  host` (manual fallbacks). Platform-Environment auto-provisioning is
  **deferred** — see `PowerPipelines/ensure-pipelines-host-PLAN.md` for the
  follow-up spec. Polls lifecycle operations,
  verifies the host responds to Pipelines API calls, writes a host-check
  artifact other ALM skills consume. Use when asked to: "set up pipelines
  host", "ensure pipelines host", "no pipelines host", "install pipelines",
  "create pipelines host", "provision custom host". Also invoked transparently
  by /power-pages:setup-pipeline when its host discovery step finds nothing.
user-invocable: true
argument-hint: "Optional: 'detect-only' to skip provisioning paths and report state; 'auto-custom' to run the Custom-Host fast-path without the path-decision prompt (still gated by tenant + admin-role + pre-call-echo prompts)"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# ensure-pipelines-host

> **Scope (this iteration):** When no host is bound to the source env, this skill detects any existing host (Custom or PE) for reuse, or — in `NoHost` state — provisions a new **Custom Host** via the BAP env-create API with the `D365_ProjectHost` template. Platform-Environment auto-provisioning is deferred to a follow-up iteration; existing PEs are still detected and used when found. The follow-up spec lives in `PowerPipelines/ensure-pipelines-host-PLAN.md` § *Deferred — Platform Host provisioning*.

Power Platform Pipelines need a **host environment** — a Dataverse environment with the *Power Platform Pipelines* managed solution installed, where pipelines, stages, run history, and artifacts live. The existing `setup-pipeline` and `deploy-pipeline` skills assume a host is already configured. This skill closes that gap.

## What we know (sources of truth)

This plan is grounded in three primary sources, in priority order:

1. **`useGetOrCreatePlatformEnvironment.v4.ts`** (Microsoft-internal client source — `power-platform-ux/packages/powerapps-appdeployment-ux/src/hooks/v4/`). Defines the exact HTTP contract for Platform Environment provisioning: endpoint, body, headers, polling.
2. **`ProjectHostProvider.tsx`** (same repo, `src/components/ProjectHostProvider/`). Defines the exact resolution order the Power Apps UI uses to determine which environment is the project host for a source environment. We mirror that order so this skill agrees with the UI.
3. **eng.ms `createcustompipelineshost`** (Microsoft-internal). Documents the Custom Host fast-path: a `D365_ProjectHost` org template that ships the Pipelines app pre-installed, callable through the standard environment-creation API.

Public Microsoft Learn (`learn.microsoft.com/power-platform/alm/{platform-host-pipelines, custom-host-pipelines, set-a-default-pipelines-host}`) is the user-facing description of the same flows; we cite it for behaviors users will recognize. HARs in `PipelinesDeployScenario.har` and `Pipelines.har` confirm the read-side calls.

## Three host shapes the tenant can be in

| Shape | How it got there | Where it lives | Org template |
|---|---|---|---|
| **Platform Host (PE)** | Auto-provisioned by `getOrCreate` BAP call (or as a side-effect of first navigation to the Pipelines page in `make.powerapps.com`). Hidden from the env picker. One per tenant. | Microsoft-managed Dataverse env in tenant's home geo | `D365_1stPartyAdminApps` |
| **Custom Host** | Created by an admin via PPAC `Deployments → New custom host`, or via the standard env-create API with the `D365_ProjectHost` template, or by installing the Power Platform Pipelines app on an existing Dataverse env. | A regular Dataverse env in the tenant | `D365_ProjectHost` (or app-installed-onto-existing-env) |
| **No host bound to source env** | Tenant has not used Pipelines from this env. | — | — |

The current `discover-pipelines-host.js` only checks the tenant-level `DefaultCustomPipelinesHostEnvForTenant` setting. That's one signal of many. This skill implements the full resolution order.

## Resolution order (mirrors `ProjectHostProvider.tsx`)

This is the load-bearing decision tree. It is what the Power Apps UI does. We replicate it so the skill agrees with the UI.

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. GetOrgDbOrgSetting('ProjectHostEnvironmentId') on source env     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
            ┌──────────────┴───────────────┐
            │ value present                │ value empty
            ▼                              ▼
┌───────────────────────┐         ┌────────────────────────────┐
│ 2. Resolve env via    │         │ 5a. Tenant-wide search:    │
│    BAP GET            │         │   list envs + per-env      │
│    /environments/{id} │         │   /deploymentpipelines     │
└───────┬───────────────┘         │   probe.                   │
        │                         │                            │
   environmentSku?                │   - 1 Custom Host found →  │
        │                         │     AvailableUnboundCustom │
   ┌────┴────────────┐            │     (3.C-pre)              │
   │ Platform        │            │   - >1 Custom Hosts →      │
   │                 │            │     MultipleUnboundCustom  │
   │                 │            │     (3.C-pre')             │
   │                 │            │   - PE only →              │
   │                 │            │     PlatformHostExists-    │
   │                 │            │     Unbound (3.C-pre'')    │
   │                 │            │   - none → NoHost (3.C)    │
   │                 │            │                            │
   │                 │            │ 5b. Decision tree paths    │
   │                 │            │   for create-new (3.C):    │
   │                 │            │   - Custom D365_ProjectHost│
   │                 │            │     (fast-path, admin)     │
   │                 │            │   - Manual app install     │
   │                 │            │   - Manual PPAC create     │
   │                 │            │   Platform getOrCreate     │
   │                 │            │   is DEFERRED.             │
   │                 │            └────────────────────────────┘
   ▼                 │
┌──────────────┐     │
│ 3. Check     │     │ environmentSku ≠ Platform (Custom Host)
│  Default-    │     ▼
│  Custom-     │   ┌──────────────────────────────┐
│  Pipelines-  │   │ 4. Use the Custom Host       │
│  HostEnv-    │   │    directly. Skip default-   │
│  ForTenant   │   │    custom check.             │
└──────┬───────┘   └──────────────────────────────┘
       │
   ┌───┴────────────────────────┐
   │ admin set a custom default │
   │                            │
   ▼                            ▼
┌─────────────────┐  ┌─────────────────────────┐
│ default ==      │  │ default !=              │
│ org setting?    │  │ org setting             │
│                 │  │                         │
│ → use default   │  │ → CannotRedirect ERROR  │
│   custom        │  │   (user locked to PE    │
└─────────────────┘  │   but admin overrode    │
                     │   at tenant scope)      │
                     └─────────────────────────┘

   if no admin default → use PE
```

Source: `ProjectHostProvider.tsx` lines 100–213 (orgSetting fetch → defaultCustomPipelinesHost fetch → finalProjectHostEnvironmentId resolution).

## What this skill does NOT do

These are deliberate non-goals (each based on a hard constraint, a destructive blast-radius, or a deferred-scope decision — see *Design Constraints* below and `PowerPipelines/ensure-pipelines-host-PLAN.md` for the deferred PE-provisioning spec):

- **Does not silently provision anything.** Any action that creates an env or binds the source env to a host requires explicit user confirmation, with the tenant ID echoed back.
- **Does not provision a Platform Environment in this iteration.** Existing PEs are detected and used (Phase 2.3 → Phase 3.A); creation is deferred. Rationale: PE is tenant-singleton, irreversible (admins cannot delete it), and its `getOrCreate` API is undocumented externally. Custom Host gives equivalent capability with a documented template (`D365_ProjectHost`) and a documented PPAC fallback. We can revisit PE auto-provisioning once the Custom Host path is shipped and stable.
- **Does not call `Force Link`** to rebind an environment to a different host. Force Link is destructive (makers lose access to existing pipelines in the previous host) and is hidden behind a separate confirmation gate, only reachable when the user explicitly says "rebind".
- **Does not change the tenant-level `DefaultCustomPipelinesHostEnvForTenant` setting.** That setting is irreversible-adjacent (existing pipelines in the previous default become inaccessible — see `learn.microsoft.com/power-platform/alm/set-a-default-pipelines-host`). Out of scope.
- **Does not delete environments.**
- **Does not write `ProjectHostEnvironmentId` directly.** Binding is established through the documented Pipelines flow (creating a `deploymentenvironment` record in the host); writing the org setting directly bypasses validation.

## Auth strategy: PAC-first with BAP fallback (`--source auto`)

Read-side detection (Phase 2 resolution order, env list, env-by-id) defaults to `--source auto`:
1. If a BAP token is provided, **try BAP env-list / env-GET first** (richer data including `lastModifiedTime`, `permissions`, `tenantId`).
2. **On HTTP 401 or 403, fall back to `pac admin list --json`** via `pac-bap-shim.js`. PAC has its own first-party client-ID grants on BAP that Az CLI doesn't always inherit (verified 2026-04-28: `D365DemoTSCE53051106` demo tenant rejects Az tokens for BAP even with correct audience claims).
3. If no BAP token is provided at all, go straight to PAC.

The PAC shim returns BAP-shaped data; downstream code (sku filter, ranking, classification) is unchanged. Fields not provided by PAC (`tenantId`, `lastModifiedTime`, `permissions`, `isManaged`) come back as `null` — none are critical for host detection. PAC also doesn't surface Platform Hosts (PE) since `pac admin list` doesn't include Platform-sku envs; PE detection requires `--source bap` with a working BAP token.

**Write-side actions** (env-create POST in `provision-custom-host.js`, lifecycle op polling) still require BAP. Az CLI tokens with the right audience usually work for these even when env-list calls fail, because the BAP RP enforces different policy on actions than reads. If `provision-custom-host.js` returns 401, the user must register a service principal in the target tenant (or use the PPAC UI fallback path 4.C).

## Design Constraints

1. **JIT provisioning is required when an existing PE is selected.** From `ProjectHostProvider.tsx` (line 232–240 comment): *"In the Platform Environment case, the user may not already be provisioned there, so BAP cannot discover it. So we'll use the org URL we retrieve from the getOrCreate call to make this first request so that user JIT can be triggered."* When Phase 2 detects an existing PE and the user accepts it (Phase 3.A), Phase 5's `WhoAmI` call against `instanceApiUrl` triggers JIT before any subsequent host op. (For Custom Host paths the caller has access by construction.)
2. **`CannotRedirect` is a real terminal state**, not a theoretical edge case. It happens when `ProjectHostEnvironmentId` (org setting on source env) points at PE but `DefaultCustomPipelinesHostEnvForTenant` (admin tenant setting) points elsewhere. The skill must detect this and surface it as a specific error — falling through silently would route pipeline ops at the wrong host.
3. **Admin-only Custom Host fast-path.** PPAC's `New custom host` flow is gated by `DeploymentHubCreatePipelinesHostForAdminsOnly` and shows only for Global / Power Platform / Dynamics admins (eng.ms doc). The BAP env-create API also needs the equivalent privilege. Non-admins get 403; the skill preflight-attestation-prompts and gracefully falls back to manual paths.
4. **404 from BAP env GET is ambiguous.** Returns 404 for *deleted*, *disabled*, *no-PE*, and *no-access* without distinguishing (`PowerPipelines_PE_Knowledge.md` §6.A). We never treat a single 404 as "no host exists" — we corroborate via list-environments and the org setting before acting.
5. **Each environment is bound to only one host at a time.** Rebinding requires Force Link, which is destructive in the previous host. Out of scope (see non-goals).
6. **The skill runs in user OAuth context** — same scope and audience the Power Apps UI uses. BAP calls use `https://service.powerapps.com/` audience.

> **Idempotency of `getOrCreate`** — the BAP `getOrCreate` endpoint is idempotent (existing PE returns with `provisioningState === 'Succeeded'`; new PE returns 202 + lifecycle op). This is the key property that would make PE provisioning safe in a future iteration. See `PowerPipelines/ensure-pipelines-host-PLAN.md` § *Deferred — Platform Host provisioning* for the full follow-up spec.

## Prerequisites

- PAC CLI logged in (`pac env who` succeeds)
- Azure CLI logged in (`az account show` succeeds)
- A source Dataverse environment URL (read from `powerpages.config.json` if invoked from a Power Pages project; passed as arg otherwise)
- For Phase 4 admin-only paths: caller has Global / Power Platform / Dynamics admin (skill detects and surfaces 403 cleanly if missing)

## Phases

### Phase 1 — Detect prerequisites and gather tenant context

**Create all tasks upfront at the start of this phase.**

Tasks to create:

1. "Check local cache and detect prerequisites"
2. "Run resolution order to find host"
3. "Confirm action with user"
4. "Execute chosen path"
5. "JIT-provision and verify host"
6. "Write host-check artifact"

Steps:

0. **Local cache fast-path.** If `.last-host-check.json` exists in the project root AND `Date.now() - Date.parse(checkedAt) < cacheMaxAgeMs` (default 24h; configurable via `--cacheMaxAgeHours`):
   - Acquire `HOST_TOKEN` for the cached `finalHostEnvUrl` origin.
   - One cheap probe: `GET {finalHostEnvUrl}/api/data/v9.0/solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$select=version&$top=1` (proves Pipelines is installed AND captures version in one round-trip)
     - 200 → cache is valid. Set `RESOLUTION` from the cached file. Set `ACTION_TAKEN = "none"`. Skip Phases 2–5; jump to Phase 6 with a "reused cached host" summary.
     - 404 / 403 / timeout / network → cache is stale or no longer accessible. Continue to Step 1 (full resolution). Do NOT fail — stale cache is expected after env deletion or permission changes.
   - If the file is missing, malformed, older than `cacheMaxAgeMs`, or contains `ready: false` → continue to Step 1.
   - **Skip this step entirely** if `--no-cache` is passed (used in CI / smoke tests).

1. Run `verify-alm-prerequisites.js`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js"
   ```
   Capture `.envUrl` (`devEnvUrl`), `.token` (`DEV_TOKEN`), `.userId`, `.tenantId`, `.organizationId`. Stop on auth failure with the script's remediation message.

2. Run `detect-project-context.js` (non-fatal — skill is also valid outside a Power Pages project):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-project-context.js"
   ```
   Capture `.siteName` and `.solutionManifest` for messaging.

3. Acquire BAP token (different audience than Dataverse):
   ```bash
   az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv
   ```
   Store as `BAP_TOKEN`. This is used by all BAP `/providers/Microsoft.BusinessAppPlatform/...` calls in Phases 2 and 4.

4. **Tenant identity confirmation gate.** Echo back via `AskUserQuestion`:

   > "About to inspect Pipelines host configuration for tenant `{tenantId}` (org `{organizationId}`, dev env `{devEnvUrl}`). Continue? 1. Yes / 2. Cancel"

   First of the consent gates that guard against wrong-tenant operations.

### Phase 2 — Run resolution order to find host

This phase is read-only. It produces a `RESOLUTION` object the user-confirm phase branches on.

The phase mirrors `ProjectHostProvider.tsx` exactly. The `useState` variables in that hook map to fields in our `RESOLUTION`:

| TS variable | Our field |
|---|---|
| `orgSetting.orgDbOrgSettingValue` | `orgSettingHostEnvId` |
| `initialProjectHostEnvironmentId` | (same) |
| `isInitialHostPlatformEnvironment` | `isPlatform` |
| `defaultCustomPipelinesHost` | `tenantDefaultCustomHostEnvId` |
| `finalProjectHostEnvironmentId` | `finalHostEnvId` |
| `projectHostStatus` | `status` |

Steps:

1. **Org-setting probe** (mirrors `useGetOrgDbOrgSetting('ProjectHostEnvironmentId')` line 103 in tsx). New helper `check-env-host-binding.js`:

   ```
   POST {devEnvUrl}/api/data/v9.0/GetOrgDbOrgSetting
   Authorization: Bearer {DEV_TOKEN}
   Body: { "SettingName": "ProjectHostEnvironmentId" }
   ```
   - Empty `SettingValue` → no current binding. Skip to Step 4.
   - Non-empty → store as `orgSettingHostEnvId`. Continue to Step 2.

2. **Resolve env via BAP** (mirrors `useGetEnvironmentByName(initialProjectHostEnvironmentId)` line 483 in tsx). New helper `resolve-env-by-id.js`:

   ```
   GET https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/{envId}?api-version=2020-06-01&$expand=properties.linkedEnvironmentMetadata,properties.permissions
   Authorization: Bearer {BAP_TOKEN}
   ```
   - 200 → capture `environmentSku`, `displayName`, `linkedEnvironmentMetadata.instanceApiUrl`, `linkedEnvironmentMetadata.instanceUrl`. Set `RESOLUTION.isPlatform = (environmentSku === 'Platform')`.
   - 404 → **disambiguate before acting** (Constraint 5). Run `list-tenant-envs.js` (Step 5) and check whether the env is in the list:
     - If listed → user lacks access → set `RESOLUTION.status = "PermissionDenied"`, surface to user, stop.
     - If not listed → env is genuinely deleted/disabled → set `RESOLUTION.status = "OrgSettingStale"`, recommend the user clear `ProjectHostEnvironmentId` and re-run, stop.
   - 403 → set `RESOLUTION.status = "PermissionDenied"`, stop.

3. **If `isPlatform === true`**, mirror the default-custom-tenant-setting check (lines 148–213 in tsx). Reuse the existing `discover-pipelines-host.js`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-pipelines-host.js" \
     --envUrl "{devEnvUrl}" --token "{DEV_TOKEN}" --userId "{userId}"
   ```
   - `found: false` → tenant has no admin default custom host. `finalHostEnvId = orgSettingHostEnvId` (the PE). Set `RESOLUTION.status = "AvailableUsingPlatformHost"`.
   - `found: true` AND `hostEnvUrl` matches `orgSettingHostEnvId` → admin-default agrees with org setting. `finalHostEnvId = orgSettingHostEnvId`. Set `RESOLUTION.status = "AvailableUsingCustomHostByAdminDefault"`.
   - `found: true` AND `hostEnvUrl` does NOT match `orgSettingHostEnvId` → **`CannotRedirect`** (Constraint 3). Set `RESOLUTION.status = "CannotRedirect"`, capture both URLs. Stop with the specific error message — only an admin can resolve this.

   **If `isPlatform === false`** (Custom Host): use directly. `finalHostEnvId = orgSettingHostEnvId`. Set `RESOLUTION.status = "AvailableUsingCustomHost"`. Skip Step 4–5; jump to Step 6.

4. **No org setting → tenant-wide search before declaring NoHost.** Source env isn't bound, but a usable Custom Host may already exist in the tenant (admin-created, or created by a prior run of this skill in another project). Always inventory before offering to create.

5. **Tenant env inventory + Pipelines-presence probe** (decisional — feeds `RESOLUTION.status`). New helper `list-tenant-envs.js`:

   **Step 5a — list envs:**
   ```
   GET https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2020-06-01&$expand=properties.linkedEnvironmentMetadata
   Authorization: Bearer {BAP_TOKEN}
   ```
   For each env capture `{ envId, displayName, environmentSku, instanceApiUrl, isManaged, hasDataverse: !!instanceApiUrl }`.

   **Step 5b — Pipelines-presence probe per env** (parallel, max 10 concurrent; bounded by sku filter + maxEnvsToProbe cap):

   **Pre-filter** (avoid probing every env in large tenants — recon found tenants with 1000+ envs):
   - Skip envs without Dataverse (`linkedEnvironmentMetadata.instanceApiUrl == null`).
   - Skip envs not in `--skus` (default: `Production` only — covers Custom Hosts and PE; can pass `Production,Sandbox` to widen). PE always reports `environmentSku === 'Platform'` and is included regardless.
   - Sort remaining by `lastModifiedTime` desc.
   - Cap at `--maxEnvsToProbe` (default 50; covers the typical-tenant 80% case in <5s with 10-concurrent).
   - If cap is reached and no host found, surface a warning: `"Scanned N of M envs (filter: Production, sorted by lastModifiedTime). Pass --maxEnvsToProbe N+ or --skus Production,Sandbox to widen."`

   **Probe query** (single query covers presence-check AND version-capture):
   ```
   GET {instanceApiUrl}/api/data/v9.0/solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$select=uniquename,version&$top=1
   Authorization: Bearer {HOST_TOKEN-per-env}
   OData-Version: 4.0
   OData-MaxVersion: 4.0
   ```
   - 200 with `value.length === 1` → Pipelines installed. Capture `value[0].version` as `pipelinesSolutionVersion`. **Mark as Custom Host candidate** (or PE if `environmentSku === 'Platform'`).
   - 200 with `value.length === 0` → no Pipelines. If Dataverse + caller has access, mark `eligible-for-app-install`.
   - 404 → entity exists but Dataverse unreachable / wrong URL; treat as not-a-candidate.
   - 403 → caller cannot access; do NOT count as a host candidate. Add to `inaccessibleEnvs[]` for warnings only.
   - timeout / 5xx → log to warnings, treat as not-a-candidate; do not retry.

   > **Why not `deploymentpipelines?$top=0`?** Dataverse rejects `$top=0` on `deploymentpipelines` with HTTP 400 "Invalid value for $top query option" even on a properly installed host (verified against `pascalepipelineshost.crm.dynamics.com` 2026-04-28). The `solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'` query is the correct cheap probe — single round-trip, no rate-limit concerns at $top=1, and it returns the version we need anyway.

   **Token strategy for 5b**: acquire one HOST_TOKEN per distinct env origin via `az account get-access-token --resource "{origin}"`, cached in-memory for the run. Token acquisition itself shouldn't fail unless the resource doesn't exist (deleted env), in which case skip.

   **Output of step 5** (`RESOLUTION.candidates`):
   ```js
   {
     existingCustomHosts: [{ envId, instanceApiUrl, displayName, environmentSku, pipelinesSolutionVersion }, ...],
     existingPlatformHost: { envId, instanceApiUrl, displayName, ... } | null,  // at most one
     eligibleForAppInstall: [{ envId, instanceApiUrl, displayName }, ...],
     inaccessibleEnvs: [{ envId, displayName, reason: "403" | "timeout" }, ...]
   }
   ```

   **Decision logic** (sets `RESOLUTION.status`):
   - `existingCustomHosts.length === 1` → `RESOLUTION.status = "AvailableUnboundCustomHost"`. Set `finalHostEnvId / finalHostEnvUrl` provisionally to that host (Phase 3.C-pre will confirm).
   - `existingCustomHosts.length > 1` → `RESOLUTION.status = "MultipleUnboundCustomHosts"`. Phase 3.C-pre' will ask user to pick.
   - `existingCustomHosts.length === 0` AND `existingPlatformHost !== null` → `RESOLUTION.status = "PlatformHostExistsUnbound"`. Phase 3.C-pre'' offers PE-use (no creation needed; a PE already lives in the tenant). Note: actual binding of source env to PE happens through the documented Pipelines flow when `setup-pipeline` registers source env in `deploymentenvironments`, same as Custom Host.
   - All zero → `RESOLUTION.status = "NoHost"`. Phase 3.C decision tree (create-new).

   > **Self-detection note:** Custom Hosts created by previous runs of this skill (Phase 4.A `D365_ProjectHost` template) install the Pipelines solution as part of the template. They surface in `existingCustomHosts` on the *exact same signal* as admin-created hosts. We do not need a marker on hosts we created ourselves — the Pipelines-solution-installed signal is sufficient.

6. **Pipelines solution version probe** (only when `finalHostEnvId` is known and not already populated by step 5b). On the resolved host instanceUrl:

   ```
   GET {hostEnvUrl}/api/data/v9.0/solutions?$filter=uniquename eq '{PIPELINES_SOLUTION_UNIQUE_NAME}'&$select=version,installedon
   Authorization: Bearer {HOST_TOKEN}
   ```

   Where `HOST_TOKEN` is acquired against `{hostEnvUrl origin}` via `az account get-access-token --resource`.

   The solution's exact unique name is an open item — see *Open Items*. Working hypothesis: `msdyn_AppDeploymentAnchor`. Capture `PIPELINES_SOLUTION_VERSION`. If query returns empty (solution missing on a non-PE host) → `RESOLUTION.status = "HostWithoutPipelines"` — Phase 3.D path.

Report findings to user:

> "Tenant `{tenantId}` host status: **{RESOLUTION.status}**. {Status-specific summary line.}"

### Phase 3 — Confirm action with user

Branches by `RESOLUTION.status`. Each branch ends with either *"proceed to Phase 5"* (host already usable) or *"Phase 4 with chosen path"*.

#### 3.A — Status `AvailableUsingCustomHost` / `AvailableUsingCustomHostByAdminDefault` / `AvailableUsingPlatformHost`

Host is established. Confirm and skip ahead.

> "Found existing host: `{finalHostEnvUrl}` (`{RESOLUTION.status}`, Pipelines solution v`{PIPELINES_SOLUTION_VERSION}`). Use this host?
> 1. Yes — proceed to verification
> 2. Cancel"

- Yes → set `ACTION_TAKEN = "none"`, jump to Phase 5.
- Cancel → exit.

#### 3.B — Status `CannotRedirect`

Locked state. Cannot proceed.

> "Cannot proceed: `ProjectHostEnvironmentId` on `{devEnvUrl}` points at the Platform Host (`{orgSettingHostEnvId}`), but the tenant admin set `DefaultCustomPipelinesHostEnvForTenant` to a different env (`{tenantDefaultCustomHostEnvId}`). The Pipelines UI cannot redirect this env to the admin's choice. Resolution requires a Power Platform admin to either (a) clear the tenant default, or (b) update the org setting on this env. Exiting."

Stop.

#### 3.C-pre — Status `AvailableUnboundCustomHost` (single existing Custom Host found)

Tenant already has exactly one Custom Host with Pipelines installed. Source env isn't bound to it yet, but binding happens automatically when `setup-pipeline` registers the source env in the host's `deploymentenvironments` table. **Reusing avoids creating duplicate hosts.**

> "Found an existing Custom Host in tenant `{tenantId}`:
> - **Display name:** `{displayName}`
> - **URL:** `{instanceApiUrl}`
> - **Pipelines solution:** v`{pipelinesSolutionVersion}`
>
> Source env `{devEnvUrl}` is not yet bound to it — that will happen automatically the first time `setup-pipeline` runs against this host. Use this host?
> 1. Yes — use existing host (recommended; avoids duplicates)
> 2. No — show me the create-new decision tree (Phase 3.C)
> 3. Cancel"

- Yes → set `finalHostEnvUrl/Id`, `ACTION_TAKEN = "reuse-existing-custom"`, jump to Phase 5.
- No → fall through to Phase 3.C `NoHost` decision tree (still allows creating another).
- Cancel → exit.

#### 3.C-pre' — Status `MultipleUnboundCustomHosts` (multiple existing Custom Hosts found)

> "Found {N} existing Custom Hosts in tenant `{tenantId}` with Pipelines installed. Pick one to use, or create new:
>
> 1. `{host[0].displayName}` (`{host[0].instanceApiUrl}`, Pipelines v`{host[0].pipelinesSolutionVersion}`)
> 2. `{host[1].displayName}` (...)
> ...
> N. ...
> N+1. **Create new Custom Host instead** — go to Phase 3.C decision tree
> N+2. Cancel"

- Selection 1..N → set `finalHostEnvUrl/Id` from picked host, `ACTION_TAKEN = "reuse-existing-custom"`, jump to Phase 5.
- N+1 → fall through to Phase 3.C `NoHost` decision tree.
- N+2 → exit.

#### 3.C-pre'' — Status `PlatformHostExistsUnbound` (PE already exists, no Custom Host)

A PE already exists in the tenant (one is provisioned automatically the first time anyone navigated to the Pipelines page). Per scope decision, this iteration does NOT auto-provision a PE, but if one already exists, we offer to use it.

> "Tenant `{tenantId}` already has a Platform Host (`{instanceApiUrl}`, Pipelines v`{pipelinesSolutionVersion}`). Source env is not yet bound to it. Use this host?
> 1. Yes — use existing PE (free, no admin role required to use)
> 2. No — create a Custom Host instead (Phase 3.C decision tree)
> 3. Cancel"

- Yes → set `finalHostEnvUrl/Id` from PE, `ACTION_TAKEN = "reuse-existing-pe"`, jump to Phase 5. (Phase 5's WhoAmI call triggers JIT — Constraint 1.)
- No → fall through to Phase 3.C `NoHost` decision tree (admin-created Custom Host preferred for governance).
- Cancel → exit.

#### 3.C — Status `NoHost` (decision tree)

Present three paths plus cancel. Order: automated fast-path first; manual fallbacks second.

> "No Pipelines host bound to this dev env. Pick a path:
>
> 1. **Provision new Custom Host (recommended)** — automated env-create with template `D365_ProjectHost`. Pipelines app pre-installed. Requires Global / Power Platform / Dynamics admin. ~5–10 min. *(eng.ms-documented; same template PPAC `New custom host` uses.)*
> 2. **Install Pipelines app on an existing env** (guided manual) — pick an env with Dataverse + system-admin role; install via PPAC → Resources → Dynamics 365 apps. Use this if you don't have tenant-admin role but do have system-admin on an existing env. *(Public-docs path.)*
> 3. **Create new Custom Host via PPAC UI** (guided manual) — fallback if path 1 fails. *(Public-docs path.)*
> 4. **Cancel** — exit.
>
> *Note: Platform-Environment auto-provisioning is intentionally not offered in this iteration. If you'd prefer the free Platform Host, navigate to `make.powerapps.com` → any solution → Pipelines page in the browser; PE auto-provisions on first navigation, then re-run this skill — it will detect and use the new PE.*"

- Option 1 → `ACTION_TAKEN = "fast-path-custom-d365projecthost"`, Phase 4.A (sub-prompts: name, region)
- Option 2 → `ACTION_TAKEN = "user-installed-app"`, Phase 4.B (sub-prompt: which env)
- Option 3 → `ACTION_TAKEN = "user-created-custom-ppac"`, Phase 4.C
- Option 4 → exit

For path 1, a **second confirmation gate** echoes the exact API call about to be made (URL, body, tenant) before firing.

#### 3.D — Status `HostWithoutPipelines` (rare)

Host env exists but Pipelines solution is missing.

> "Found host environment `{finalHostEnvUrl}` but the Pipelines solution is not installed. Install it now via PPAC?
> 1. Yes — open PPAC and install (guided manual)
> 2. No — exit"

- Yes → Phase 4.C with pre-selected env.
- No → exit.

#### 3.E — Status `OrgSettingStale` / `PermissionDenied`

Surface the specific failure to the user. Out of automated remediation scope. Recommend manual cleanup.

### Phase 4 — Execute chosen path

#### 4.A — Fast-path: Custom Host via `D365_ProjectHost` template

Standard env-create API with the `D365_ProjectHost` template (eng.ms-documented; same template PPAC `New custom host` uses internally). New helper `provision-custom-host.js`.

**Sub-prompts (collected before the API call):**

1. Display name (default suggestion: `"{tenant displayName} Pipelines Host"`)
2. Region (default: tenant home geo from BAP `tenant` endpoint; offer override)
3. Confirm caller is admin — single AskUserQuestion *"Are you a Global / Power Platform / Dynamics admin in this tenant? Yes / No / Not sure"*. If No or Not sure, recommend Path 4.B/4.C and fall back.

**Pre-call confirmation (second consent gate):**

> "About to call `POST https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2021-04-01` for tenant `{tenantId}` with body:
> ```json
> {
>   "location": "{region}",
>   "properties": {
>     "displayName": "{display name}",
>     "environmentSku": "Production",
>     "databaseType": "CommonDataService",
>     "linkedEnvironmentMetadata": { "templates": ["D365_ProjectHost"] }
>   }
> }
> ```
> Provisions a Custom Host with the Pipelines app pre-installed (~5–10 min). Proceed? 1. Yes / 2. Cancel"

**Call:**

```
POST https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2021-04-01
Authorization: Bearer {BAP_TOKEN}
Content-Type: application/json
x-ms-correlation-id: {uuid v4}

{
  "location": "{region}",
  "properties": {
    "displayName": "{display name}",
    "environmentSku": "Production",
    "databaseType": "CommonDataService",
    "linkedEnvironmentMetadata": { "templates": ["D365_ProjectHost"] }
  }
}
```

**Response handling:**

- `202` + `Location` header + `Retry-After` header → poll the Location URL until lifecycle op completes.
- `200` + immediate body (rare for env-create) → capture URLs.
- `403` from initial POST → stop with *"Custom Host fast-path requires Global / Power Platform / Dynamics admin. Suggest Path 2 (Pipelines app on existing env) if you have system-admin on a Dataverse env, or Path 3 (PPAC UI) if you can request admin assistance."* Offer seamless fallback to 4.B / 4.C.
- 4xx / 5xx other → surface error, ask user to retry or switch path.

**Polling:**

```
GET {Location}
Authorization: Bearer {BAP_TOKEN}
```

Interval = `Retry-After` seconds (default 10s). Timeout = 15min (configurable). On each response, read `provisioningState` (and/or operation `state` field — confirm during execution):
- `Creating` / `InProgress` → continue polling
- `Succeeded` → done; capture `instanceApiUrl`, `name` (env GUID), `displayName`
- `Failed` / `Canceled` → surface error, stop

**On success:** set `RESOLUTION.finalHostEnvUrl`, `finalHostEnvId`, `instanceApiUrl`, `actionTaken = "fast-path-custom-d365projecthost"`. Proceed to Phase 5.

#### 4.B — Guided manual: Install Pipelines app on an existing env

1. Sub-prompt: *"Which env will host Pipelines? (Auto-detected envs from Phase 2 inventory):"* with the eligible-for-app-install list as choices, plus "Other (paste URL)".
2. Print PPAC URL: `https://admin.powerplatform.microsoft.com/manage/environments/{envId}/dynamics365apps` and instructions: *"Click 'Install app' → 'Power Platform Pipelines' → Next → accept terms → Install. Wait until the app shows 'Installed'."*
3. Two-option AskUserQuestion: *"Done — proceed"* / *"Cancel"*.
4. After confirmation, poll `verify-host-readiness.js` (Phase 5) against the chosen env URL. On Pipelines tables present, capture URLs, `actionTaken = "user-installed-app"`. Proceed to Phase 5.

#### 4.C — Guided manual: PPAC `New custom host`

1. Print: `https://admin.powerplatform.microsoft.com/deployments` and instructions: *"Click 'New custom host' → fill name (suggested: '{tenant} Pipelines Host') → choose Production environment in tenant home region → Create. Provisioning takes 5–10 min."*

   > Per eng.ms doc: *"the panel will default to the Production environment type. Adding Dataverse is also required... template and sample apps options are hidden here, as we use a specific organization template for this scenario."* (The template is `D365_ProjectHost` — same one Path 4.A automates.)

2. Two-option AskUserQuestion: *"Done — provisioning kicked off"* / *"Cancel"*.
3. After confirmation, poll BAP `list-tenant-envs.js` every 15s looking for a new env with the Pipelines marker. On detection, capture URLs, `actionTaken = "user-created-custom-ppac"`. Proceed to Phase 5.

#### Common: Timeout handling

15-min default per path (configurable). On timeout: ask user to extend (another 15min), switch path, or exit.

### Phase 5 — JIT-provision (PE-detected only) and verify host

Always runs, regardless of how `finalHostEnvUrl` was obtained.

**JIT step (only when an existing PE was detected and selected — `RESOLUTION.isPlatform === true`):** Per Constraint 2, the calling user may have been JIT-provisioned in the PE long ago, or never. To ensure auth works on the host before we hand off, we issue one `WhoAmI` against `instanceApiUrl`. (The same step is required for Custom Host paths but is naturally satisfied by `verify-host-readiness.js` step 1 below — admin who created the env has access by construction; for `user-installed-app` the user already had access to the env.)

```
GET {instanceApiUrl}/api/data/v9.0/WhoAmI
Authorization: Bearer {HOST_TOKEN}
```

Where `HOST_TOKEN = az account get-access-token --resource "{instanceApiUrl origin}"`.

Expected: 200 with `UserId`. If 404 / 403 on first call: retry every 5s up to 60s — JIT propagation is sometimes async.

**Verification (`verify-host-readiness.js`)** — checks in order:

1. `WhoAmI` returns `UserId` (proves auth — and triggers JIT for PE detection case).
2. `GET {hostEnvUrl}/api/data/v9.0/solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$select=version&$top=1` returns one row → capture `PIPELINES_SOLUTION_VERSION`. (One query covers both Pipelines-installed check AND version capture; `deploymentpipelines?$top=0` rejected by Dataverse with 400.)

Compare against `MIN_PIPELINES_VERSION` (constant in `scripts/lib/alm-thresholds.js`).

- All checks pass → `READY = true`.
- Solution version below minimum → emit a warning (non-fatal).
- Any check fails → stop with check-specific remediation.

### Phase 6 — Write host-check artifact

Write `.last-host-check.json` to the project root (or `--outputPath` if invoked outside a project):

```json
{
  "schemaVersion": 2,
  "checkedAt": "2026-04-28T...",
  "tenantId": "...",
  "sourceEnvUrl": "{devEnvUrl}",
  "sourceEnvId": "...",
  "resolutionStatus": "AvailableUsingPlatformHost" | "AvailableUsingCustomHost" | "AvailableUsingCustomHostByAdminDefault" | "AvailableUnboundCustomHost" | "MultipleUnboundCustomHosts" | "PlatformHostExistsUnbound" | "CannotRedirect" | "NoHost" | "OrgSettingStale" | "PermissionDenied" | "HostWithoutPipelines",
  "finalHostEnvUrl": "...",
  "finalHostEnvId": "...",
  "finalHostInstanceApiUrl": "...",
  "isPlatformHost": true | false,
  "tenantDefaultCustomHostEnvId": "...",
  "actionTaken": "none" | "reuse-existing-custom" | "reuse-existing-pe" | "fast-path-custom-d365projecthost" | "user-installed-app" | "user-created-custom-ppac",
  "pipelinesSolutionVersion": "9.x.y.z",
  "ready": true,
  "warnings": [
    "Pipelines solution version 9.0.0.1 is below recommended 9.1.0.0 — RetrieveDeploymentPipelineInfo may not be available."
  ],
  "candidates": {
    "existingCustomHosts": [
      { "envId": "...", "instanceApiUrl": "...", "displayName": "...", "pipelinesSolutionVersion": "..." }
    ],
    "existingPlatformHost": null,
    "eligibleForAppInstall": [
      { "envId": "...", "instanceApiUrl": "...", "displayName": "..." }
    ],
    "inaccessibleEnvs": [
      { "envId": "...", "displayName": "...", "reason": "403" }
    ]
  },
  "telemetry": {
    "correlationId": "{uuid passed to env-create, if applicable}"
  }
}
```

> **Schema version bump (1 → 2):** added `candidates.*` block to record the tenant-wide enumeration result. Cache fast-path (Phase 1 step 0) reads `finalHostEnvUrl` regardless of schemaVersion; the candidates block is informational and helps debug / re-run decisions. Old v1 files remain readable — any missing field is treated as "not yet enumerated".

This file is consumed by `setup-pipeline` and `deploy-pipeline`.

Record skill usage:

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "EnsurePipelinesHost"`.

Present summary table:

| Field | Value |
|---|---|
| Tenant | `{tenantId}` |
| Source env | `{devEnvUrl}` |
| Resolution status | `{resolutionStatus}` |
| Final host | `{finalHostEnvUrl}` |
| Host type | `Platform` / `Custom` |
| Action taken | `{actionTaken}` |
| Pipelines version | `{pipelinesSolutionVersion}` |
| Warnings | `{warnings}` |

If `actionTaken !== "none"`:

> "**Next:** Run `/power-pages:setup-pipeline` to create your first pipeline against this host."

## Integration with existing skills

### setup-pipeline (✅ wired)

`setup-pipeline/SKILL.md` Phase 1 step 4 calls `ensure-pipelines-host-detect.js` (the orchestrator wrapper) and branches on `resolutionStatus`:
- `AvailableUsing*` → use `finalHostEnvUrl` directly, continue.
- `*Unbound*` / `NoHost` → delegate to `/power-pages:ensure-pipelines-host` (this skill) for reuse-or-provision; resume after `.last-host-check.json` shows `ready: true`.
- `CannotRedirect` / `OrgSettingStale` / `PermissionDenied` → stop with the specific admin-resolution message.

The old "ask user for host URL manually" fallback in Phase 3 has been removed — `HOST_ENV_URL` is always populated by Phase 1, or the skill stops before Phase 3.

### deploy-pipeline

No change. `deploy-pipeline` reads `hostEnvUrl` from `.last-pipeline.json` written by `setup-pipeline`.

### plan-alm (✅ wired)

`plan-alm` Phase 1 step 12 invokes `ensure-pipelines-host-detect.js` and stores the result as `HOST_RESOLUTION` (skipped when `PIPELINE_DONE = true`). Phase 2 Q4 branches on `HOST_RESOLUTION.status`. The generated `docs/alm-plan.html` includes a "Pipelines Host" card and (when `willEnsureDuringExecution: true`) a sub-bullet under the "Setup pipeline" checklist step. See `references/cicd-pipeline-patterns.md` and the `plan-alm-update-PLAN.md` spec.

## Threat model — built-in mitigations

| Risk | Mitigation in this skill |
|---|---|
| Confused-deputy / silent provisioning | Phase 1.4 tenant identity gate + Phase 3 explicit choice + Phase 4.A pre-call confirmation echoing the exact request body |
| Duplicate host creation | Phase 2.5 tenant-wide enumeration finds any existing Custom Host before Phase 3 offers to create. Phase 3.C-pre / 3.C-pre' surface existing hosts for reuse. User must explicitly decline reuse (option "No") to reach the create-new tree. |
| Stale local cache → using a deleted host | Phase 1.0 cache fast-path validates with a live `solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$top=1` probe before reusing — 404/403/timeout falls through to full Phase 2 |
| 404 ambiguity → unintended action | Phase 2.2 disambiguation rule — never act on a single 404; corroborate with list-tenant-envs |
| Wrong-tenant provisioning | Phase 1.4 echoes tenantId, organizationId, and dev env URL; Phase 4.A echoes tenantId in the pre-call body |
| `CannotRedirect` masked | Phase 2.3 explicitly detects this and stops with a specific error rather than continuing into a wrong-host write |
| JIT-provisioning miss → silent 404 chains | Phase 5 makes WhoAmI call against `instanceApiUrl` before any other host op (relevant when an existing PE was detected) |
| Stale solution → silent failure | Phase 5 reads `PIPELINES_SOLUTION_VERSION` and warns if below `MIN_PIPELINES_VERSION` |
| Non-admin tries Custom Host fast-path | Phase 4.A pre-prompts for admin role; gracefully falls back to Phase 4.B / 4.C on 403 |
| Tenant-singleton PE created accidentally | Out of scope this iteration — PE provisioning deferred. We only *detect* PEs, never create them. |
| Telemetry leakage | All probe results stay in `.last-host-check.json`; correlation ID is the standard `x-ms-correlation-id` UUID we generated; `update-skill-tracking.js` writes only counters + authoring-tool name |
| Privilege boundary | All paths run in user OAuth context; 403/401 surfaces as a stop with "this requires X admin role" message; no escalation attempted |
| Rate-limit | 15-min total timeout per path; respect `Retry-After` from BAP; minimum 10s poll interval |
| Force-link irreversibility | Out of scope — see *What this skill does NOT do* |

## Key decision points (wait for user)

1. **Phase 1.4** — Tenant identity confirmation (read-only intent)
2. **Phase 3.A/B/C-pre/C-pre'/C-pre''/C/D/E** — Branch decision based on `RESOLUTION.status`
3. **Phase 3.C-pre** — Reuse single existing Custom Host (Y/N/Cancel)
4. **Phase 3.C-pre'** — Pick from multiple existing Custom Hosts or create new
5. **Phase 3.C-pre''** — Use existing PE or create Custom Host instead
6. **Phase 3.C** — Create-new path selection (4 options: Custom-fast, app-install, PPAC-UI, cancel)
7. **Phase 4.A** — Admin-role self-attestation (No / Not sure → fall back to 4.B / 4.C)
8. **Phase 4.A** — Pre-call confirmation echoing exact API request body
9. **Phase 4.B/C** — User performs UI step → confirms back via "Done — proceed"
10. **Phase 5** — Warning acknowledgement if Pipelines solution version is below minimum

## Error handling

- `verify-alm-prerequisites.js` fails → stop with remediation (`az login`, `pac auth create`)
- BAP token acquisition fails → stop; suggest `az logout && az login`
- BAP env GET returns 404 → run disambiguation (Phase 2.2 fallback)
- BAP env GET returns 403 → `RESOLUTION.status = "PermissionDenied"`, surface tenant ID + env ID, stop
- Custom Host env-create returns 403 → seamless fallback to 4.B (app install) or 4.C (PPAC UI)
- Custom Host env-create returns 4xx other → log status + body, ask user to retry or switch path
- Lifecycle-op polling timeout (15 min default) → ask: extend (another 15min) / switch path / exit
- `RetrieveSetting` returns 404 → treated as "no admin default custom host" (current `discover-pipelines-host.js` behavior)
- `GetOrgDbOrgSetting` returns 404 → treated as "not bound" (matches UI behavior)
- WhoAmI on host returns 403 after JIT retries → likely `CannotRedirect` race or genuine perm issue; stop with both error message
- `verify-host-readiness.js` reports `Pipelines tables not found` after user-claimed install (4.C) → ask user to recheck PPAC or extend polling

## Progress tracking table

| Task subject | activeForm | Description |
|---|---|---|
| Check local cache and detect prerequisites | Checking cache and detecting prerequisites | Phase 1.0 read .last-host-check.json; if fresh probe finalHostEnvUrl with solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$top=1 — on 200 reuse and skip to Phase 6. Otherwise run verify-alm-prerequisites.js + detect-project-context.js; acquire BAP_TOKEN; tenant identity confirmation gate |
| Run resolution order to find host | Running resolution order | GetOrgDbOrgSetting('ProjectHostEnvironmentId'); BAP env GET; if Platform check tenant default custom host; detect CannotRedirect; if no org binding run tenant-wide list+probe via list-tenant-envs.js (parallel max 10) to find existing Custom Hosts and PE; classify into AvailableUnboundCustomHost / MultipleUnboundCustomHosts / PlatformHostExistsUnbound / NoHost |
| Confirm action with user | Confirming action with user | Branch by resolutionStatus; for AvailableUnboundCustomHost / MultipleUnboundCustomHosts / PlatformHostExistsUnbound surface reuse prompt FIRST; only fall through to NoHost create-new tree if user declines reuse; collect explicit consent for Phase 4.A with pre-call body echo |
| Execute chosen path | Executing chosen path | Run path A (Custom D365_ProjectHost env-create)/B (manual app install)/C (PPAC New custom host); poll lifecycle ops at Retry-After interval; honor 15-min timeout |
| JIT-provision and verify host | Verifying host | WhoAmI against instanceApiUrl (triggers JIT only when existing PE was detected); deploymentpipelines table probe; Pipelines solution version probe; READY flag |
| Write host-check artifact | Writing host-check artifact | Write .last-host-check.json with full RESOLUTION + actionTaken + correlationId; update skill tracking; present summary; suggest /power-pages:setup-pipeline next |

## Open items (resolve during execution phase)

These need real-environment validation:

1. ~~**Pipelines solution `uniquename`.**~~ ✅ **RESOLVED 2026-04-28**: confirmed `msdyn_AppDeploymentAnchor` v9.1.2026034.260325188 via live query against SIP host (`pascalepipelineshost.crm.dynamics.com`). Stored as `PIPELINES_SOLUTION_UNIQUE_NAME` constant.
2. **`MIN_PIPELINES_VERSION`.** Set after testing which Pipelines features fail on the lowest in-the-wild solution version. Initial conservative guess: `"9.0.0.0"`.
3. ~~**Custom Host detection marker in `list-tenant-envs.js`.**~~ ✅ **RESOLVED 2026-04-28**: confirmed via live BAP env-list query (1000 envs in test tenant) — `linkedEnvironmentMetadata.templates` is **never returned** even with `$expand=properties.linkedEnvironmentMetadata`. Per-env Dataverse probe is mandatory. Probe query corrected to `solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$select=version&$top=1` (covers presence + version in one call). PE detection still straightforward via `environmentSku === 'Platform'`.
4. **`BapApiVersion` value for env-create.** The `D365_ProjectHost` template was onboarded for Pegasus / BAP-RP / Neptune (per eng.ms PR list). The PPAC UI uses `2021-04-01` for env operations. Confirm during execution by capturing a fresh HAR from `New custom host`.
5. **Lifecycle-op response shape.** Need to confirm whether the Location URL returns `{ properties: { provisioningState } }` or `{ state }` or both. To be HAR'd.
6. **Tenant home geo discovery.** Default region for 4.A. Options: `BAP_TOKEN` claims (`tid`, `xms_tcdt`?), BAP `/tenant?api-version=2021-04-01` endpoint, or `properties.azureRegionHint` from existing envs. Pick one during execution.
7. **Cold-tenant test env.** Need a tenant with no prior Pipelines usage to validate end-to-end. A personal MSDN tenant works.
8. **BAP env-list filter on `linkedEnvironmentMetadata.templates`?** If supported, we can pre-filter to envs created with `D365_ProjectHost` and skip the per-env Dataverse probe in Phase 2.5b. To be tested. If unsupported, the per-env probe with bounded concurrency stands.
9. **Does env-list response actually include `linkedEnvironmentMetadata.templates`?** If yes, even without server-side filter we can client-filter cheaply. If no, the per-env Dataverse probe is the only signal. Verify by capturing a fresh BAP env-list HAR including the `$expand=properties.linkedEnvironmentMetadata` query parameter (already used by `resolve-env-by-id.js`).
10. ~~**Per-env probe rate-limit budget.**~~ ✅ **PARTIALLY RESOLVED 2026-04-28**: Microsoft-internal test tenant has 1000 envs (526 Production sku, 453 Sandbox). Naïve probe-all is too slow even with 10-concurrent. Adopted multi-tier filter:
    - Pre-filter envs without Dataverse (recovers ~3 envs in test tenant — minor)
    - Filter by `--skus` (default `Production`; PE always included)
    - Sort by `lastModifiedTime` desc
    - Cap at `--maxEnvsToProbe` (default 50; ~5s wall time at 10-concurrent)
    - Surface "scanned N of M (filter: ...)" warning when cap is hit and no host found
    Remaining: validate cap defaults against typical customer tenants (5–50 envs) — should be no-op overhead there.
11. **`cacheMaxAgeMs` default.** 24h is a starting guess. May need tightening if hosts change frequently in dev tenants. Make it configurable via `--cacheMaxAgeHours` and document.

## Scripts

All shipped under `plugins/power-pages/scripts/lib/` (or as noted). Each is single-purpose Node, parses argv, uses `validation-helpers.js` for HTTPS, prints JSON to stdout.

| Script | Purpose | Args | Output |
|---|---|---|---|
| `check-env-host-binding.js` | `POST GetOrgDbOrgSetting('ProjectHostEnvironmentId')` on the source env | `--envUrl`, `--token` | `{ bound, hostEnvId }` |
| `resolve-env-by-id.js` | BAP env GET with `$expand=properties.linkedEnvironmentMetadata,properties.permissions`, with PAC shim fallback on 401/403. | `--source` (`auto`\|`bap`\|`pac`; default `auto`), `--bapToken` (required for `bap`), `--envId` | `{ found, envId, instanceUrl, instanceApiUrl, displayName, environmentSku, isManaged, permissions, sourceUsed, fallbackReason, ... }`; on 404 returns `{ found: false, reason: "404-ambiguous" }`; on PAC-not-listed returns `{ found: false, reason: "not-in-pac-list" }` |
| `pac-bap-shim.js` | Wraps `pac admin list --json` into a BAP-shaped env-list. Used as fallback when Az→BAP returns 401 (some tenants reject Az CLI's first-party client ID for BAP). Derives `instanceApiUrl` from `EnvironmentUrl`; maps PAC's `Type` → BAP's `environmentSku`. Cannot surface PE (PAC doesn't list Platform-sku envs); BAP-only fields (`tenantId`, `lastModifiedTime`, `permissions`) are returned as `null`. | n/a (CLI prints all envs) | BAP-shaped env array |
| `list-tenant-envs.js` | List + per-env Pipelines-presence probe (`solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$select=version&$top=1`), parallel max 10 concurrent. Pre-filter: sku + has-Dataverse + optional `--includeName`. Ranking: name-hint pattern + admin-perms + recency. Cap: `--maxEnvsToProbe` (default 30). | `--source` (`auto`\|`bap`\|`pac`; default `auto`), `--bapToken` (required for `bap`), `--skus` (default `Production`; PE always included), `--maxEnvsToProbe`, `--maxConcurrency`, `--probeTimeoutMs`, `--includeName`, `--firstHitWins` | `{ existingCustomHosts[], existingPlatformHost, eligibleForAppInstall[], inaccessibleEnvs[], inaccessibilityBreakdown, totalEnvsInTenant, envsAfterFilter, envsProbed, hitProbeCap, earlyExitOnFirstHit, probeDurationMs, sourceUsed, fallbackReason }` |
| `verify-host-readiness.js` | `WhoAmI` (proves auth + triggers JIT in PE-detection path) → solutions filter for `msdyn_AppDeploymentAnchor` (one call covers presence + version) | `--hostEnvUrl`, `--hostToken`, `--skipWhoAmI` (opt), `--minPipelinesVersion` (opt) | `{ ready, pipelinesSolutionVersion, checks: { whoami, solutions }, warnings[] }` |
| `provision-custom-host.js` | POST BAP env-create with `D365_ProjectHost` template + `Production` sku + `CommonDataService` databaseType. Polls lifecycle op via `Location` header at `Retry-After` interval. Handles `properties.provisioningState` / `state` / `status.code` shapes. 5xx-transient retry. 401/403 with explicit guidance. | `--bapToken`, `--displayName`, `--region`, `--correlationId` (opt), `--timeoutSec` (opt, default 900), `--apiVersion` (opt, default 2021-04-01) | `{ status, envId, instanceUrl, instanceApiUrl, displayName, environmentSku, provisioningState, durationSec, correlationId, pollAttempts, locationHeader }` |
| `ensure-pipelines-host-detect.js` | Detection-only orchestrator wrapper. Runs Phase 1.0 (cache fast-path) + Phase 2 (resolution order including tenant-wide enumeration) + Phase 5 (verify if host found). Always emits `actionTaken: "none"`. Used by `plan-alm` Phase 1 and `setup-pipeline` Phase 1. **`--source auto` (default) tries BAP first; on 401/403 falls back to PAC CLI shim** — works in tenants where Az CLI tokens are rejected by BAP. | `--envUrl`, `--token`, `--userId`, `--bapToken` (optional with `--source auto` or `pac`), `--source` (`auto`\|`bap`\|`pac`), `--projectRoot`, `--cacheMaxAgeHours` (opt), `--no-cache`, `--includeName`, `--maxEnvsToProbe`, `--skus`, `--minPipelinesVersion` | `.last-host-check.json` schema (with `sourceUsed`, `fallbackReason`) |
| `validate-ensure-host.js` (skill `scripts/`) | PostToolUse Stop-hook validator. Schema v1+v2 forward-compat. Treats `CannotRedirect` / `OrgSettingStale` / `PermissionDenied` as documented terminal-error states (skill ran successfully even if host isn't usable). | n/a (reads stdin JSON `{cwd}`) | exit 0 (approve) or exit 2 (block) |

**Deferred** (will ship when PE provisioning is added):
- `provision-platform-host.js` — calls `getOrCreate` BAP endpoint with `D365_1stPartyAdminApps` + `Platform` body. Full spec in `PowerPipelines/ensure-pipelines-host-PLAN.md` § *Deferred — Platform Host provisioning*.

Existing helpers reused (no changes):
- `verify-alm-prerequisites.js`
- `detect-project-context.js`
- `discover-pipelines-host.js` (the tenant-default-custom-host probe; called from Phase 2 step 3 inside the wrapper)
- `update-skill-tracking.js`

## Deferred — Platform Host provisioning

Platform Environment auto-provisioning via the internal `getOrCreate` BAP API is **not implemented in this iteration**. Existing PEs are still detected and used (Phase 2.3 → Phase 3.A); only *creation* is out of scope here.

The full follow-up plan — `getOrCreate` contract, polling rules, JIT step, decision-tree path, threat-model row, and outstanding open items — lives in the design doc and is the source of truth for the next iteration:

> **`PowerPipelines/ensure-pipelines-host-PLAN.md` § "Deferred — Platform Host provisioning"**

Why deferred at a glance: PE is tenant-singleton and admin-non-deletable; the `getOrCreate` endpoint is internal/undocumented. Custom Host gives equivalent capability for Power Pages ALM via the documented `D365_ProjectHost` template, so we ship that path first and revisit PE auto-provisioning once Custom Host is stable in production. See the plan doc for the full rationale.

## Validation script

`skills/ensure-pipelines-host/scripts/validate-ensure-host.js` (PostToolUse Stop hook, registered via `TRACKED_SKILLS` in `scripts/lib/powerpages-hook-utils.js`):

- If no `.last-host-check.json` in cwd → exit 0 (not an ensure-host session).
- If present: validate `schemaVersion === 1` or `2` (forward-compatible); required fields populated (`tenantId`, `sourceEnvUrl`, `resolutionStatus`); `ready === true` for non-terminal-error statuses; `finalHostEnvUrl` populated when `ready === true`.
- Terminal-error statuses (`CannotRedirect` / `OrgSettingStale` / `PermissionDenied`) are accepted with `ready: false` — the skill ran successfully and surfaced a state requiring manual / admin resolution.
- The `candidates` block (v2) is optional — its absence does not fail validation.

The companion prompt-hook checks:
1. Either (a) Phase 1.0 cache fast-path succeeded and we reused the cached host, OR (b) the full flow ran:
   - Tenant identity gate was confirmed.
   - `RESOLUTION.status` was determined via the full resolution order including tenant-wide enumeration when source env was unbound.
   - If status was `AvailableUnbound*`, `MultipleUnboundCustomHosts`, or `PlatformHostExistsUnbound`, the user explicitly chose reuse-or-create-new.
   - If status indicated provisioning was needed (`NoHost`), an explicit user-chosen path completed (`actionTaken !== "none"` and not `"reuse-existing-*"`).
2. `verify-host-readiness.js` reported `ready: true` (or a documented terminal-error state was reached).
3. `.last-host-check.json` was written with `schemaVersion: 2` and the `candidates` block populated when tenant-wide enumeration ran.
4. Summary was presented.
