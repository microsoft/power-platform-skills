# How `manage-governance` Works

A brief guide to the Power Pages **Manage Governance Policies** skill — what it
does, how a request flows through it, and which pieces do what.

## What it does

Applies and inspects **tenant-level Power Pages governance policies** against any
environment the signed-in admin has access to. Ten policies are supported today
(sign-in protocols, social identity providers, local login, external providers,
and Maker Copilot). Each policy can be turned on/off for **every site**, **no
sites**, **only specific sites**, or **all except specific sites**.

It is an **admin-only, tenant-scoped** skill — it does **not** need a
`powerpages.config.json` project root.

## The three operations

| Operation | Intent | What it does |
|-----------|--------|--------------|
| **Set** (`apply`) | "Enable/Disable X …" | POST the policy, poll to a terminal state, then verify. |
| **Fetch Env** (`fetchEnv`) | "Show/Is X … in \<env\>" | Read the env-wide value and render every site's state. |
| **Fetch Portal** (`fetchSite`) | "Is X on \<site\>?" | Read one site's state. |

## Request flow

```
User free-text intent
      │
      ▼
[2.1] Parse intent  ──►  { policy, direction, envId, scope, siteIds, … }
      │                  (policy shorthands + intent→policyValue from JSON)
      ▼
[2.2] Validate + fill gaps
      │   • Env picker  → render-env-table.js (full list, default flagged)
      │   • Scope       → list-portals.js  (all / specific sites)
      ▼
[4.2.3 Step 1b] Redundant-op guard (if already in requested state)
      │   → ask "Keep" vs "Enforce only on <sites>"  (before Impact Summary)
      ▼
[4.2.3] Impact Summary + consent gate  ──►  render-impact-summary.js
      │   (boxed Sites table, Current → New State, "Apply now" required)
      ▼
[4.2.4] Apply  ──►  set-governance.js  (POST + poll /governance/status)
      ▼
[4.2.5] Verify  ──►  get-env.js / get-portal.js  +  render-portal-table.js
      ▼
[5] Loop: re-prompt for the next request, or exit
```

## Policy value semantics (uniform across all policies)

| `policyValue` | Meaning |
|---------------|---------|
| `All` | Enable on every site |
| `None` | Disable on every site |
| `Include` | Enable only on the listed sites |
| `Exclude` | Disable only on the listed sites |

The verb attaches to the **governance setting**, not the underlying protocol.
`All`/`Include` = **Enable**; `None`/`Exclude` = **Disable**. Plain-English
meaning per policy comes from each policy's `subject` in the mapping JSON.

### Include/Exclude list deltas (`ToBeAdded` vs `ToBeRemoved`)

For `Include`/`Exclude`, the gateway applies the POST body as a **delta**, not a
replacement:

- `ToBeAdded` is **additive** — re-posting `Include` with a *shorter*
  `ToBeAdded` does **not** shrink the existing list; the previously-listed sites
  stay on it.
- `ToBeRemoved` is the **only** way to take a site off an existing allow-/block-
  list without clearing the whole policy. `set-governance.js --removePortalIds`
  populates it.

This is why the redundant-op guard's **"Enforce only on \<sites\>"** path and any
list-shrink operation route removals through `--removePortalIds` (`ToBeRemoved`)
rather than a smaller `ToBeAdded`.

## Key rules

- **Always show the full env list** (`render-env-table.js --markdown`) on every
  new operation — the previously-used env is only pre-flagged, never auto-used.
- **Redundant-operation guard (before the Impact Summary)** — if the requested
  op is a no-op for the named site(s) (enable while already `All`/`Include`, or
  disable while already `None`/`Exclude`), first ask **Keep** vs **Enforce only
  on \<sites\>**. `Keep` = no change; `Enforce only` restricts the policy to an
  `Include`/`Exclude` list (surfacing any collateral flip on other sites) before
  the consent gate.
- **Consent gate before every POST** — render the Impact Summary, then require an
  explicit free-text **`Apply now`** (not `yes`/`all`).
- **Always verify after Set** — re-read state with `get-env.js` / `get-portal.js`;
  never trust the poll outcome alone.
- **Set is async** — `set-governance.js` polls `/governance/status/{env}/{policy}`
  until `Succeeded`/`Failed` or timeout.
- **Sign-out side-effect** — disabling any auth policy signs current users out of
  affected sites; this is surfaced at the consent gate.

## Files

### Scripts (`scripts/`)

| File | Role |
|------|------|
| `list-envs.js` | List all environments the admin can access. |
| `render-env-table.js` | Render the env picker table (Markdown or ASCII box). |
| `list-portals.js` | List the sites in an environment. |
| `parse-portal-input.js` | Resolve free-text site names/IDs to portal IDs. |
| `render-impact-summary.js` | Render the boxed consent-gate Impact Summary. |
| `set-governance.js` | POST the policy + poll to a terminal state. Supports `--portalIds` (`ToBeAdded`) and `--removePortalIds` (`ToBeRemoved`) to grow/shrink an Include/Exclude list. |
| `get-env.js` | Read the env-wide policy value. |
| `get-portal.js` | Read a single site's inclusion/exclusion state. |
| `get-status.js` | Read the last rollout status for a policy. |
| `render-portal-table.js` | Render the fixed-width site state table (🟢/🔴). |
| `policies.js` | Frozen `SUPPORTED_POLICIES` list + write-vocabulary mapping. |
| `governance-context.js` | Resolves the API context; applies `--envId` override. |
| `governance-route.js` | Builds URL/headers/body per transport (gateway vs admin-portal). |
| `governance-transport.js` | Single network entry-point; branches transport. |
| `colors.js` | ANSI green/red helpers for state cells. |

### References (`references/`)

| File | Role |
|------|------|
| `governance-mapping.json` | **Single source of truth** — policies, shorthands, intent→policyValue, cascade data, effect-line templates, state colors/paraphrases. |
| `commands.md` | Script flags, response shapes, exit codes, polling semantics. |
| `intent-training-cases.json` | Parser training/validation cases. |

### `SKILL.md`

The orchestrator spec — drives the whole workflow (phases, prompts, env-picker
and consent-gate rules). Reads all mappings from `governance-mapping.json`.

## Transports

- **gateway** (default): `https://api.powerplatform.com/powerpages/environments/{envId}`,
  Azure CLI bearer (needs `PowerPages.Websites.*` admin consent).
- **admin-portal** (TIP testing only): portal-infra host with a browser-copied
  bearer + `x-ms-client-*` headers, for tenants not yet admin-consented for the
  gateway scopes.

## Exit codes (`set-governance.js`)

| Code | Meaning |
|------|---------|
| `0` | Rollout reached success. |
| `2` | Sign-in required (`pac auth create` / `az login`). |
| `3` | Polling timed out. |
| `4` | Terminal state reached but `Failed`. |
| `1` | Other failure. |
