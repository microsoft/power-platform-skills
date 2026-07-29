# Manage Power Pages Governance — Commands

Reference for the helper scripts under `scripts/`. Every script uses the
shared `power-platform-api` client from the plugin root, so they share the
same auth/context resolution, exit-code conventions, and the
`Authorization: Bearer <token>` + `api-version=2022-03-01-preview` headers
the Power Platform API expects.

All scripts accept `--help` to print full usage.

## Table of contents

- [Supported policies](#supported-policies)
- [Assumed API contract](#assumed-api-contract)
- [Environment override](#environment-override)
- [Ring selection (TIP vs Prod) and token generation](#ring-selection-tip-vs-prod-and-token-generation)
- [`list-envs.js`](#list-envsjs)
- [`list-portals.js`](#list-portalsjs)
- [`set-governance.js`](#set-governancejs)
- [`get-status.js`](#get-statusjs)
- [`get-env.js`](#get-envjs)
- [`get-portal.js`](#get-portaljs)
- [`get-details.js`](#get-detailsjs)
- [`resolve-portal-availability.js`](#resolve-portal-availabilityjs)
- [`get-effective-status.js`](#get-effective-statusjs)
- [`render-status-table.js`](#render-status-tablejs)
- [`parse-portal-input.js`](#parse-portal-inputjs)
- [Common error catalogue](#common-error-catalogue)

---

## Supported policies

The skill only accepts these policy strings today (single source of truth
in `scripts/policies.js`):

| Policy string | Plain-language meaning |
|---------------|------------------------|
| `EnableMakerCopilotForExistingSites` | Turns Maker Copilot on for existing Power Pages sites in the environment. |
| `EnableProtocolOpenIdConnect` | Enables/disables the OpenID Connect sign-in protocol on Power Pages sites. |
| `EnableProtocolSAML20` | Enables/disables the SAML 2.0 sign-in protocol on Power Pages sites. |
| `EnableProtocolWsFederation` | Enables/disables the WS-Federation sign-in protocol on Power Pages sites. |
| `EnableProtocolOpenAuth` | Enables/disables the OAuth 2.0 sign-in protocol on Power Pages sites. |
| `EnableIdpOAuthFacebook` | Enables/disables Facebook sign-in on Power Pages sites. |
| `EnableIdpOAuthGoogle` | Enables/disables Google sign-in on Power Pages sites. |
| `EnableIdpOAuthMicrosoft` | Enables/disables Microsoft sign-in on Power Pages sites. |
| `EnableAuthenticationLocalLogin` | Enables/disables local (username & password) sign-in on Power Pages sites. |
| `EnableExternalAuthProviders` | Enables/disables all external (social / federated) identity providers on Power Pages sites. |
| `PowerPages_AllowMakerCopilotsForNewSites` | Allows/blocks Maker Copilots on newly created Power Pages sites. |
| `PowerPages_AllowMakerCopilotsForExistingSites` | Allows/blocks Maker Copilots on existing Power Pages sites. |
| `PowerPages_AllowProDevCopilotsForSites` | Allows/blocks pro-developer Copilots on Power Pages sites. |
| `PowerPages_AllowSiteCopilotForSites` | Allows/blocks the site Copilot on Power Pages sites. |
| `PowerPages_AllowSearchSummaryCopilotForSites` | Allows/blocks the search-summary Copilot on Power Pages sites. |
| `PowerPages_AllowListSummaryCopilotForSites` | Allows/blocks the list-summary Copilot on Power Pages sites. |
| `PowerPages_AllowIntelligentFormsCopilotForSites` | Allows/blocks the intelligent-forms Copilot on Power Pages sites. |
| `PowerPages_AllowSummarizationAPICopilotForSites` | Allows/blocks the summarization-API Copilot on Power Pages sites. |
| `PowerPages_AllowProDevCopilotsForEnvironment` | Allows/blocks pro-developer Copilots for the Power Pages environment. |
| `PowerPages_AllowNonProdPublicSites` | Allows/blocks non-production public Power Pages sites. |
| `PowerPages_DisableExtSvcCallsFromServerLogic` | Controls external service calls from Power Pages server-side logic. |

The nine `Enable*` authentication policies (`EnableProtocol*`, `EnableIdp*`,
`EnableAuthenticationLocalLogin`, `EnableExternalAuthProviders`) and the eleven
`PowerPages_*` Copilot / site-control policies share the
**same configuration and API contract** as `EnableMakerCopilotForExistingSites`:
uniform governance with the canonical `policyValue` vocabulary
(`All` / `None` / `Include` / `Exclude`) on read/normalize and the env-level
`applyTo` (`*Sites`) enum vocabulary on write. The eleven `PowerPages_*`
policies are **independent leaves** — no parent/child availability gate and no
cascade, so effective state equals own state.

A new policy is added by appending its string to `SUPPORTED_POLICIES` in
`scripts/policies.js` — every script validates against that list before
calling the API.

> **Read-value vocabulary.** The nine auth `Enable*` policies report their
> environment-level state on read using the
> canonical `policyValue` strings (`All` / `None` / `Include` / `Exclude`).
> Only `EnableMakerCopilotForExistingSites` instead reports the `applyTo` enum
> form (e.g. `AllSites`). `get-env.js` normalizes this via `normalizeEnvValue()`
> and returns a canonical `value` field alongside the raw `body`; the alias
> table lives in `scripts/policies.js` (`ENV_VALUE_ALIASES`) and mirrors
> `readValueAliases` in `references/governance-mapping.json`.

---

## Assumed API contract

The skill was authored against the existing Power Pages Power Platform API
pattern (same base URL the `manage-firewall` skill uses). The exact request
and response shapes for the governance endpoints are documented here as
**assumptions** — patch the scripts in this folder if the real contract
differs:

| Operation | Method | Path | Body | Polled by |
|-----------|--------|------|------|-----------|
| Apply env-wide or portal-scoped | `POST` | `/governance` | Array — see below | `set-governance.js` polls `GET /governance/status/{policy}` |
| Status snapshot | `GET` | `/governance/status/{policy}` | — | `get-status.js`, plus `set-governance.js` polling |
| Env-level read | `GET` | `/governance/{policy}` | — | `get-env.js` |
| Portal-level read | `GET` | `/websites/{portalId}/governance/{policy}` | — | `get-portal.js` |
| Env-level membership read (inclusion/exclusion lists) | `GET` | `/governance/{policy}/details` | — | `get-details.js` |

POST body shape (from the PowerApps-CoreServicesGateway gateway config — verified 2026-06-06):

```json
[
  {
    "policyName": "EnableProtocolOpenIdConnect",
    "policyValue": "All",
    "ToBeAdded": [],
    "ToBeRemoved": []
  }
]
```

Field semantics encoded by `set-governance.js`:

| Field | Env-wide call | Portal-scoped call |
|-------|---------------|--------------------|
| `policyName` | the policy string | the policy string |
| `policyValue` | `"All"` | `"Include"` |
| `ToBeAdded` | `[]` | `[ "<portalId>" ]` |
| `ToBeRemoved` | `[]` | `[]` |

`policyValue` is one of `All`, `None`, `Include`, `Exclude`:

| Value | Effect on the env |
|-------|-------------------|
| `All` | Apply the policy to every portal in the env. |
| `None` | Apply to no portals. Clears any inclusion/exclusion lists. |
| `Include` | Allow-list mode — apply only to portals named in `ToBeAdded`. |
| `Exclude` | Block-list mode — apply to every portal EXCEPT those in `ToBeAdded`. |

The default `set-governance.js` mapping is `All` for env-wide calls and
`Include` for portal-scoped calls; pass `--policyValue <name>` to override.
The script always wraps the policy object in a single-element array, but the
body is an array on purpose — the gateway accepts multiple policy objects in
one POST.

> **Write vocabulary (canonical → wire).** `--policyValue` and every internal
> code path use the canonical `All` / `None` / `Include` / `Exclude` strings.
> As of the **2026-07 A059 gateway shift** these short canonical forms ARE the
> wire vocabulary — the older `applyTo` `*Sites` enums are now rejected. So
> `set-governance.js buildPolicyPayload` → `policies.js toWritePolicyValue()`
> forward-maps each canonical value to itself (an identity map, kept as a seam
> in case the wire vocabulary shifts again):
>
> | Canonical (`--policyValue`) | Wire value (env-level policies) |
> |-----------------------------|---------------------------------|
> | `All`     | `All` |
> | `Include` | `Include` |
> | `Exclude` | `Exclude` |
> | `None`    | `None` (disable is conveyed by the value itself) |
>
> **History:** originally (2024-10-01 gateway) env-level policies REQUIRED the
> `applyTo` `*Sites` enums on write (`AllSites` / `IncludeSites` /
> `ExcludeSites`) and rejected the short forms with the plain body
> `Website id cannot be null or empty`. As of 2026-07 the gateway inverted that
> contract for the sign-in protocol policies: it now rejects the `*Sites` forms
> with HTTP 400 `{ "error": { "code": "A059", "message": "The provided policy
> value is not a valid governance policy value." } }` and accepts the short
> forms. The READ side still normalizes `*Sites` → canonical via
> `policies.js normalizeEnvValue()` because the env can still read those back.
> Verified empirically against Preprod on `EnableProtocolOpenAuth` (2026-07):
> `AllSites`/`IncludeSites`/`ExcludeSites` → `400 A059`; `All`/`Include`/`Exclude`
> → `200 "Policy upserts accepted."` (a short-form POST during an in-flight
> rollout returns code `D006` with an empty message — a concurrency lock, not
> value rejection; retry once `GET /governance/status` reports `Succeeded`).

All paths are appended to the base URL:
`https://api.powerplatform.com/powerpages/environments/{envId}` (or the
cloud-specific equivalent — see `validation-helpers.js` for the mapping).

The `set-governance.js` polling helper treats the following case-insensitive
status values as terminal:

- **Success**: `Succeeded`, `Completed`, `Created`, `OK`.
- **Failure**: `Failed`, `Error`.

Any other value is treated as in-progress. Update `TERMINAL_SUCCESS` /
`TERMINAL_FAILURE` in `scripts/policies.js` if the real API uses different
keywords.

---

## Environment override

Each script accepts an optional `--envId <guid>`. Without it the script
addresses whatever env the PAC CLI is currently signed into (`pac auth who`).
With it, the env id segment of the base URL is rewritten before the request
goes out — letting a tenant admin run the skill against any env they have
admin access to without re-running `pac auth select`.

The override is implemented in `scripts/governance-context.js`. It replaces
the `…/environments/<id>/…` segment after the shared `resolveContext()` has
acquired a token.

---

## Ring selection (TIP vs Prod) and token generation

`governance-context.js` resolves both the **gateway host** and the **bearer
token** per ring. **TIP/Preprod is the default ring**; Prod is opt-out.

### Ring flag

| Env var | Effect |
|---------|--------|
| *(unset)* | **TIP** ring (default) → host `https://api.preprod.powerplatform.com`. |
| `PP_GOV_RING=prod` | Prod ring → host from the signed-in cloud (`api.powerplatform.com`, gov clouds, …). |
| `PP_GOV_PROD=1` | Legacy escape hatch, equivalent to `PP_GOV_RING=prod`. `PP_GOV_RING` wins if both are set. |
| `PP_GOV_TIP_HOST=<url>` | Override the default TIP host (e.g. a different pre-production ring). |
| `PP_GOV_API_HOST=<url>` | Pin an **arbitrary** host; outranks the ring entirely. |

> The TIP host is `api.preprod.powerplatform.com`. `api.tip.powerplatform.com`
> does **not** resolve in DNS and is not the Preprod gateway.

### Token generation

The governance gateway requires the delegated scopes
`PowerPages.Websites.Read` / `PowerPages.Websites.Write`. The Azure CLI
first-party client is **not** authorized for these and cannot be granted them,
so an az-minted token 403s (`InsufficientDelegatedPermissions`). Token
resolution precedence:

1. **`PP_GOV_TOKEN`** — an explicit bearer always wins. Paste a scoped token
   (e.g. from the admin portal, or one you minted yourself).
2. **TIP ring → custom-app device-code flow.** `governance-context.js` runs
   `tip-auth.js` (OAuth 2.0 device-code + silent refresh) to mint a token that
   actually carries the PowerPages scopes. It defaults to the shipped
   `pp-governance-cli` app (`c5ae9f06-f0bb-4ef6-9ee4-c7a3803da37a`) and the
   `organizations` authority, so **no env vars are required** — the first run
   prompts for an interactive browser sign-in; subsequent runs renew silently
   from the cached refresh token. Override `PP_GOV_TIP_CLIENT_ID` /
   `PP_GOV_TIP_TENANT` to point at a different registration.
3. **Fallback** — if the device-code flow fails, it falls back to an az mint
   (which will 403 on governance calls) and prints guidance.

| Env var | Purpose |
|---------|---------|
| `PP_GOV_TIP_CLIENT_ID` | *(optional)* Public-client app id for the device-code flow. Defaults to the shipped `pp-governance-cli` app. |
| `PP_GOV_TIP_TENANT` | *(optional)* Tenant id (or `organizations`) for the device-code authority. Defaults to `organizations`. |
| `PP_GOV_TOKEN` | Explicit bearer token; overrides all generation. |
| `PP_GOV_TOKEN_RESOURCE` | Override the token audience when it differs from the host. |

The shipped app id is a **public identifier, not a secret** (the flow still
requires an interactive user sign-in and uses no client secret), so it is safe
to ship as a default. To use your own app instead, register a public-client
app, add `PowerPages.Websites.Read` + `PowerPages.Websites.Write` as delegated
permissions on the Power Platform API resource, grant consent, then:

```bash
export PP_GOV_TIP_CLIENT_ID="<app-id>"
export PP_GOV_TIP_TENANT="<tenant-id>"
```

With the defaults, TIP works with no setup — just run any governance script:

```bash
# TIP is the default ring:
node get-env.js --policy EnableProtocolSAML20 --envId <guid>
```

---

## `list-envs.js`

Lists Power Platform environments the signed-in PAC profile can administer.
Backed by `pac admin list --json` via the shared `pac-bap-shim.js`.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-envs.js" \
  [--type <Production|Sandbox|Trial|Developer|Default>]
```

### Response (stdout)

```json
{
  "status": "ok",
  "envs": [
    { "envId": "<guid>", "displayName": "<name>", "envUrl": "<url>",
      "type": "Production", "domain": "<domain>" }
  ]
}
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success (including empty result) |
| `2`  | PAC CLI sign-in required (`pac auth create`) |
| `1`  | Any other failure |

---

## `list-portals.js`

Lists Power Pages portals in an environment. Paginates over `/websites` and
emits a flat list.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" \
  [--envId <guid>]
```

### Response (stdout)

```json
{
  "status": "ok",
  "portals": [
    { "portalId": "<guid>", "name": "<portal name>",
      "websiteUrl": "<url>", "websiteRecordId": "<guid>",
      "type": "Production", "status": "StateConfigured",
      "createdOn": "2026-07-19T07:30:42" }
  ]
}
```

The user-facing identifier is `portalId` — that is what the governance
endpoints accept. `websiteRecordId` is shown for cross-reference with PAC
and the Dataverse website record. `type` (`Production` / `Trial`), `status`
(e.g. `StateConfigured`), and `createdOn` drive the display ordering below.

### Display ordering (picker cap)

The script always returns **every** portal in the environment (unbounded) so
name/id resolution and the Fetch-Env site tables stay complete. The
**orchestrator caps the rendered picker to 10 rows**. When an environment has
more than 10 portals, render the top 10 using `orderPortalsForDisplay()`
(exported from `list-portals.js`), which prioritizes:

1. `type === "Production"` first,
2. then `status === "StateConfigured"`,
3. then oldest-first by `createdOn` (ascending).

When there are 10 portals or fewer, the original order is preserved (no
re-sort). The helper returns `{ shown, total, truncated, limit }`; when
`truncated` is true, note "showing 10 of `total`" to the user. Because
`parse-portal-input.js` validates against the full list, the user can still
pick a site that isn't among the visible 10 by typing its name or id.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success (including empty result) |
| `2`  | Sign-in required |
| `1`  | Any other failure |

---

## `set-governance.js`

Applies a governance policy and polls until the roll-out reports a terminal
state. The POST body shape (policyValue + ToBeAdded list) is built from
`--policyValue`, `--portalIds`, and `--portalId`.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/set-governance.js" \
  --policy <name> [--envId <guid>] \
  [--policyValue All|None|Include|Exclude] \
  [--portalIds "<id>,<id>,…"] [--portalId <guid>] \
  [--timeoutMinutes <n>]
```

### Parameters

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--policy` | Yes | — | One of the strings listed in [Supported policies](#supported-policies). |
| `--policyValue` | No | derived | Explicit value (`All` / `None` / `Include` / `Exclude`). When omitted, defaults to `Include` if any portal ids are passed, else `All`. |
| `--portalIds` | No | — | Comma- or whitespace-separated list of portal ids. Use for `Include` / `Exclude` scopes with multiple portals. |
| `--portalId` | No | — | Legacy single-portal flag. Equivalent to `--portalIds <id>`. |
| `--envId` | No | current PAC env | Target environment id. |
| `--timeoutMinutes` | No | `15` | How long to poll before giving up. Polls every 30 seconds. |

### Response (stdout)

On success:

```json
{ "status": "applied", "policy": "<name>", "envId": "<guid>",
  "portalIds": [ "<guid>", ... ], "transport": "...",
  "attempts": <n>, "finalValue": "<state>" }
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Roll-out reached a success terminal state. |
| `2`  | Sign-in required. |
| `3`  | Polling timed out — last seen status is in the stderr message. |
| `4`  | Terminal state reached, but it was a failure value. |
| `1`  | Any other failure (POST rejected, network error, etc.). |

The skill orchestrator runs this script with `run_in_background: true` so the
polling does not block the conversation. Progress lines are written to
`stderr` ("Applying \<policy\>...") at start and at every poll attempt.

---

## `get-status.js`

One-shot read of `GET /governance/status/{policy}`.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-status.js" \
  --policy <name> [--envId <guid>]
```

### Response (stdout)

```json
{ "status": "ok", "policy": "<name>", "value": "<state>", "body": <raw> }
```

`value` is a best-effort top-level extract — either the bare body string,
or `body.status` / `body.state` / `body.value` when the API returns an
object. Callers can branch on `value` without re-parsing.

### Exit codes

Same as `get-env.js`.

---

## `get-env.js`

Reads `GET /governance/{policy}`.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-env.js" \
  --policy <name> [--envId <guid>]
```

### Response (stdout)

```json
{ "status": "ok", "policy": "<name>", "envId": "<guid>",
  "value": "All"|"None"|"Include"|"Exclude", "body": <raw> }
```

The skill orchestrator renders `value` (the canonical, normalized state) in
plain language for the user. `body` is the raw API value, left untouched on
purpose so updates to the API contract do not require a script change — for
env-level policies it may be an `applyTo` enum string (e.g. `AllSites`) that
`value` has already normalized.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `2`  | Sign-in required |
| `1`  | Any other failure |

---

## `get-portal.js`

Reads `GET /websites/{portalId}/governance/{policy}`.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-portal.js" \
  --policy <name> --portalId <guid> [--envId <guid>]
```

### Response (stdout)

```json
{ "status": "ok", "policy": "<name>", "envId": "<guid>",
  "portalId": "<guid>", "body": <raw> }
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `2`  | Sign-in required |
| `1`  | Any other failure |

---

## `get-details.js`

Reads `GET /governance/{policy}/details` — the policy's **env-level** per-site
membership (inclusion/exclusion portal lists) in a **single call**, regardless of
how many portals the environment has.

### Why (kills the per-portal read loop)

`get-portal.js` (`GET /websites/{portalId}/governance/{policy}`) is **per-portal**
— one boolean per call — so reading N portals costs N cold-started calls and N
chances at a transient "PAC not signed in". It also **404s on a dummy/non-existent
portalId** (`Website with the given id does not exist`), so the old "call
`get-portal.js` with `00000000-…` to fetch the env lists" trick never worked.
`get-details.js` returns the whole membership once; combine it with `get-env.js`
(the `All`/`None`/`Include`/`Exclude` env value) and resolve every portal's state
**locally** via `resolvePortalStates()` (see `resolve-portal-availability.js`).
That is **2 network calls per policy**, flat — vs `1 + N` for the loop.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-details.js" \
  --policy <name> [--envId <guid>]
```

### Response (stdout)

```json
{ "status": "ok", "policy": "<name>", "envId": "<guid>", "transport": "gateway",
  "includedSites": ["<portalId>", ...],
  "excludedSites": ["<portalId>", ...],
  "body": { "IncludedSites": ["<portalId>", ...], "ExcludedSites": null } }
```

`includedSites` / `excludedSites` are the normalized (lowercased) id arrays
parsed from `body` by `extractLists()` — tolerant of the several field spellings
observed across rings (`InclusionList` / `IncludedSites`, camel/Pascal, bare id
or object). Skip this call when the env value is `All` / `None` — the lists are
irrelevant there (every site's state is decided by the env value alone).

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `2`  | Sign-in required |
| `1`  | Any other failure |

---

## `resolve-portal-availability.js`

Computes, for a **child** authentication policy, which portals are **available**
to configure it on based on the live state of its **parent** policies, and which
are **unavailable** (a required parent is Disabled). Used by the scope pickers
(SKILL.md Phase 4.2.1 Step B.1 / Phase 4.2.2) — which render it with
`--available-only` so **only the eligible portals are listed** (with a
parent-disabled message when none qualify).

### Availability contract

The dependency tree is data-driven from
`references/governance-mapping.json` — each policy's `availabilityDependsOn`
array plus the top-level `policyAvailabilityDependencies` block:

| Child policy | Requires (all must be Enabled) |
|--------------|--------------------------------|
| `EnableProtocolOpenIdConnect` | `EnableExternalAuthProviders` |
| `EnableProtocolSAML20` | `EnableExternalAuthProviders` |
| `EnableProtocolWsFederation` | `EnableExternalAuthProviders` |
| `EnableProtocolOpenAuth` | `EnableExternalAuthProviders` |
| `EnableIdpOAuthFacebook` | `EnableExternalAuthProviders`, `EnableProtocolOpenAuth` |
| `EnableIdpOAuthGoogle` | `EnableExternalAuthProviders`, `EnableProtocolOpenAuth` |
| `EnableIdpOAuthMicrosoft` | `EnableExternalAuthProviders`, `EnableProtocolOpenAuth` |

A portal is **available** iff **every** parent in the list is Enabled on that
portal (computed from each parent's env value + inclusion/exclusion lists via
the Phase 4.4.3 site-state rules). Policies with no `availabilityDependsOn`
(Maker Copilot, local login, and External Auth itself — the only pure root)
report all portals available. Note `EnableProtocolOpenAuth` (OAuth 2.0) is
**not** dependency-free — it is both a child of External Auth and the parent of
the three social providers.

**Fail-open posture.** A parent whose state cannot be read (transient error,
missing record) is recorded in `unreadParents` and does **not** hide the portal
— a read failure never removes options from the admin.

**List-read source.** Parent inclusion/exclusion lists are read via the
env-level **`getDetails`** op (`GET /governance/{policy}/details`), which returns
the whole list as `{ "IncludedSites": [...], "ExcludedSites": [...] }`. Do **not**
use `getPortal` (`GET /websites/{portalId}/governance/{policy}`) for this — that
op is portal-scoped and returns only a single boolean for the one portal id, and
it 404s on a dummy/non-existent id ("Website with the given id does not exist").
The earlier dummy-all-zeros `getPortal` approach silently returned no list,
leaving the inclusion set empty and mis-reporting an `Include` parent (enabled on
a subset) as Disabled env-wide — so every eligible site was wrongly hidden.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/resolve-portal-availability.js" \
  --policy <childPolicy> --portalsFile <path-to-list-portals-json> \
  [--envId <guid>] [--markdown] [--available-only]
```

`--portalsFile` is required (the script does not re-page `/websites`). With
`--markdown`, it prints the site table with available rows first and unavailable
rows below (blocking parent named); without it, prints the JSON below.

**`--available-only`** (the scope picker used by SKILL.md Phase 4.2.1 Step B.1)
changes the `--markdown` render so **only the available portals** are listed:

- **Some available** — a table of just the eligible portals (`# | Portal Name |
  Portal URL | Portal ID`). When only a subset qualifies, an info line follows
  in plain "Governance setting" language: *"Showing N of M site(s) — the
  &lt;child&gt; Governance setting can only be configured on sites where the
  &lt;parent&gt; Governance setting is on. K site(s) are hidden because the
  &lt;parent&gt; Governance setting is off on them, so the &lt;child&gt;
  Governance setting can't apply there."* For a two-parent **social IdP** the
  line names both, using **"and"** for the requirement and **"or"** for the
  block: *"…the &lt;child&gt; Governance setting can only be configured on sites
  where **both** the External authentication providers **and** OAuth 2.0 sign-in
  Governance settings **are on**. K site(s) are hidden because the External
  authentication providers **or** OAuth 2.0 sign-in Governance setting is off on
  them, so the &lt;child&gt; Governance setting can't apply there."*
- **None available** — no table; a single message: *"The &lt;parent&gt;
  Governance setting is off for this environment. No sites are available to
  configure &lt;child&gt; here — turn on the &lt;parent&gt; Governance setting
  first, then try again."* For a two-parent **social IdP**
  the message names both — *"The External authentication providers **or** OAuth
  2.0 sign-in Governance setting is off for this environment … turn on **both**
  … Governance settings first"*. The orchestrator surfaces this and does not
  prompt for a scope.

### Response (stdout, JSON mode)

```json
{
  "policy": "EnableIdpOAuthGoogle",
  "dependencies": ["EnableExternalAuthProviders", "EnableProtocolOpenAuth"],
  "available": [ { "portalId": "…", "name": "…", "url": "…" } ],
  "unavailable": [
    { "portalId": "…", "name": "…", "url": "…",
      "blockingParents": ["EnableExternalAuthProviders"],
      "blockedBy": ["External authentication providers"],
      "unreadParents": [] }
  ]
}
```

### Exported helper: `resolvePortalStates(envValue, detailsBody, portals)`

The batch, network-free classifier that makes the getDetails fast path work.
Given a policy's **env value** (`get-env.js`) and its **getDetails body**
(`get-details.js`), it resolves **every** portal's own state locally — the batch
form of the Phase 4.4.3 site-state table — so no per-portal `get-portal.js` call
is needed. `portals` accepts bare id strings **or** portal objects
(`{ portalId|id|Id, name, url|websiteUrl }`); objects pass their `name`/`url`
through. Returns `[{ portalId, state, name?, url? }]` where `state` is
`Enabled` / `Disabled` / `Unknown`. Membership tests are case-insensitive; an
env value that can't be canonicalized yields `Unknown` (never a guess). This is
what the orchestrator uses in Fetch Env (4.3.1), the effective-status build
(4.4.4), the consent-gate Current State (4.2.3), and the post-Set verify (4.2.5).

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `2`  | Sign-in required |
| `1`  | Any other failure |

---

## `get-effective-status.js`

Computes the **effective** governance state of a policy for **every** portal in
an environment in **ONE parallel batch** of reads. This is the canonical
state-read for every SKILL.md status path — Fetch Env portal table (4.3.1),
Fetch Site (4.4.3), the effective status for gated children (4.4.4), the post-Set
verify (4.2.5), and the consent-gate Current State (4.2.3). It replaces the old
sequential `get-env.js` → `get-details.js` → `resolvePortalStates` hand-issued
loop, so the orchestrator MUST route per-site state through this script and
**never** hand-issue `get-env.js` / `get-details.js` / `get-portal.js` per
policy or per portal.

### Why (kills the sequential per-policy reads)

A gated child method is only live on a portal when the child's OWN setting **and**
every gating parent are Enabled there. Reading that needs `getEnv` + `getDetails`
for the child **and** each parent — 4 calls for a protocol (child + External
Auth), 6 for a social IdP (child + External Auth + OAuth 2.0). The previous flow
issued those reads **sequentially** (a `for … await` loop), so a social-IdP
status took 6 serial round-trips. Every call is independent, so this script fires
**all** of them concurrently with a single `Promise.all` and only then assembles
the report — collapsing 4–6 serial round-trips into one parallel wave (wall-clock
≈ one round-trip regardless of parent count). Leaf policies with no parents
(Maker Copilot, local login, External Auth) report their own state as the
effective state (2 calls).

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
  --policy <name> \
  --portalsFile <path-to-list-portals-output> \
  [--envId <guid>]
```

- `--policy` — any of the twenty-one governance policy names.
- `--portalsFile` — path to `list-portals.js` output (`{ portals: [...] }` or a
  bare array). Required — this script does **not** re-page `/websites`.
- `--envId` — optional; falls back to the current PAC env.

### Response (stdout, JSON)

The shape is what `render-portal-table.js` consumes directly (it reads
`.portals`), so pipe this straight into it:

```json
{
  "status": "ok",
  "policy": "<name>",
  "dependencies": ["<parent>", "..."],
  "apiCalls": 6,
  "effectiveEnabledCount": 2,
  "portals": [
    { "name": "Portal_4", "url": "https://…", "portalId": "<guid>",
      "state": true,
      "own": true,
      "parents": { "EnableExternalAuthProviders": true, "EnableProtocolOpenAuth": true } }
  ]
}
```

- `state` — the **effective** boolean (own AND every parent) — the value the
  5-column Unicode status box renders.
- `own` — the child's own setting on that portal.
- `parents` — each gating parent's state on that portal.
- `apiCalls` — policies × 2, **all issued in parallel**.

Pipe `.portals` into the status render:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
  --policy "<POLICY>" --envId "<ENV_ID>" --portalsFile <list-portals-output> \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --unicode --no-color
```

Fail-closed posture: a failed `getDetails` degrades to an empty membership list;
a failed `getEnv` is fatal (cannot classify without the env value). A parent
whose state can't be read makes the site's effective state `Unknown`.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `2`  | Sign-in required |
| `1`  | Other failure |

---

## `render-status-table.js`

Renders the per-site **effective** governance-status Markdown table for a
**gated child** policy — the child's own state plus a column for each gating
parent, and a final **Effective Status** column. Used by the status-display
paths (SKILL.md Phase 4.4.4, referenced from Fetch Env 4.3.1, Fetch Site 4.4.3,
and the post-Set verify 4.2.5).

### Effective-status contract

A child method's own setting being Enabled is necessary but **not** sufficient —
it is effectively Enabled on a portal only when **every** gating parent is also
Enabled there (data-driven from `governance-mapping.json` — each child's
`availabilityDependsOn`, and the readable `effectiveStatusRules` block):

| Child policy | Parent context columns shown |
|--------------|------------------------------|
| `EnableProtocolOpenIdConnect` | External Auth |
| `EnableProtocolSAML20` | External Auth |
| `EnableProtocolWsFederation` | External Auth |
| `EnableProtocolOpenAuth` | External Auth |
| `EnableIdpOAuthFacebook` | External Auth, OpenAuth Protocol |
| `EnableIdpOAuthGoogle` | External Auth, OpenAuth Protocol |
| `EnableIdpOAuthMicrosoft` | External Auth, OpenAuth Protocol |

`Effective = Enabled` iff own **and** every parent are Enabled; `Disabled` iff no
state is Unknown and at least one is Disabled; `Unknown` otherwise (an own/parent
state could not be read — fail visible, never claim a state on a partial read).
Non-gated policies (Maker Copilot, local login, External Auth) have no parents —
use the plain `render-portal-table.js` table instead.

### Usage

```bash
echo '<JSON>' | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-status-table.js" [--no-icons]
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-status-table.js" --file <path>
```

### Input JSON

```json
{
  "policy": "EnableIdpOAuthGoogle",
  "portals": [
    { "name": "Portal_4", "url": "https://…", "portalId": "<guid>",
      "own": true,
      "parents": { "EnableExternalAuthProviders": true, "EnableProtocolOpenAuth": true } }
  ]
}
```

`own` and each `parents` value accept `true|false|"Enabled"|"Disabled"|null`. A
`null`/unreadable state renders `Unknown` and forces `Effective = Unknown`.
Include the `EnableProtocolOpenAuth` parent key only for the social IdPs. The
orchestrator assembles the live own/parent states via
[`get-effective-status.js`](#get-effective-statusjs) — a **single parallel batch**
that fires `getEnv` + `getDetails` for the child and every gating parent
concurrently and returns the effective per-portal state — **never** a sequential
per-policy loop and **never** a per-portal `get-portal.js` loop. This helper
itself is network-free.

### Response (stdout)

A GitHub-flavored Markdown table (emit un-fenced as a rendered table). Columns:
`# | Name | URL | Site ID | <parents…> | Effective <child> Status` — parents
first in dependency order (External Auth → OpenAuth Protocol), then a single
net-result column. The net-result header is `Effective <statusColumnLabel>
Status` by default, but a policy may override the whole string via
`effectiveStatusLabel` in `governance-mapping.json` (OpenAuth Protocol →
`Effective OpenAuth State`; Google → `Effective Google idp State`). The child's
own state gates that column but has no column of its own.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | Could not parse the JSON input |

---

## `parse-portal-input.js`

Parses the user's free-text portal selection in Phase 4.2.1 into a structured
spec the orchestrator can hand to `set-governance.js`. Accepts shortcuts so
admins don't have to paste full UUIDs for common cases.

### Accepted input

| User types | Maps to |
|------------|---------|
| `all` (case-insensitive) | `policyValue=All`, no portal list |
| `none` | `policyValue=None`, no portal list |
| `<id>` or `<id>, <id>, …` | `policyValue=Include`, `portalIds=[…]` |
| `not <id>, <id>` (also `except <id>`) | `policyValue=Exclude`, `portalIds=[…]` |

Separator can be commas, newlines, or both.

### Usage

Pipe the user's reply to stdin and reference the `list-portals.js` output for
validation:

```bash
echo "<USER_REPLY>" | \
  node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/parse-portal-input.js" \
    --portalsFile <path-to-list-portals-json>
```

Or use it programmatically:

```js
const { parsePortalInput } = require('./parse-portal-input');
const result = parsePortalInput(userInput, { validIds: portals });
```

### Response (stdout)

```json
{
  "policyValue": "Include",
  "portalIds": ["3e13d603-…", "ea51fc54-…"],
  "resolvedNames": ["Site 1", "Site 2"],
  "errors": []
}
```

- `policyValue` is `null` when parsing fails.
- `resolvedNames` is populated only when `validIds` was provided as `{portalId, name}` objects.
- `errors` lists every problem found — show them to the user and reprompt.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Parsed successfully |
| `1`  | One or more `errors` entries — orchestrator should reprompt |

### When to use

Called by the orchestrator inside Phase 4.2.1 of the manage-governance skill,
after `list-portals.js` returns the portal table. Bypass it when the caller is
non-interactive and is supplying `--policyValue` and `--portalIds` directly to
`set-governance.js`.

---

## Common error catalogue

| HTTP / signal | Likely cause | What the skill should do |
|---------------|--------------|--------------------------|
| `401` | Token expired between resolve and request. | Tell the user to re-run `az login`; the script exits 2. |
| `403` | Signed-in user is not a tenant / env admin. | Surface the message; do not retry. |
| `404` on `/governance/{policy}` | Policy has never been applied in this env. | Render as "no governance setting on record" instead of an error. |
| `400 / "Unsupported policy"` | Policy string is misspelled or new. | Skill rejects unknown policies before the call; this should not surface unless `policies.js` is patched without the API. |
| `409` during POST | A roll-out is already in progress. | Skip the POST, just poll the existing roll-out (future enhancement — today the script surfaces the error and stops). |
| Timeout (exit `3`) | Roll-out exceeded `--timeoutMinutes`. | Tell the user the roll-out is still in flight; suggest running `get-status.js` later. |
