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
- [`list-envs.js`](#list-envsjs)
- [`list-portals.js`](#list-portalsjs)
- [`set-governance.js`](#set-governancejs)
- [`get-status.js`](#get-statusjs)
- [`get-env.js`](#get-envjs)
- [`get-portal.js`](#get-portaljs)
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

The nine `Enable*` authentication policies (`EnableProtocol*`, `EnableIdp*`,
`EnableAuthenticationLocalLogin`, `EnableExternalAuthProviders`) share the
**same configuration and API contract** as `EnableMakerCopilotForExistingSites`:
uniform governance with the canonical `policyValue` vocabulary
(`All` / `None` / `Include` / `Exclude`) on read/normalize and the env-level
`applyTo` (`*Sites`) enum vocabulary on write.

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
> code path use the canonical `All` / `None` / `Include` / `Exclude` strings,
> but for env-level (`uniformGovernance`) policies the gateway does NOT accept
> those short forms on WRITE — it silently rejects `policyValue:"All"` with the
> plain body `Website id cannot be null or empty` and leaves the env unchanged.
> `set-governance.js buildPolicyPayload` therefore forward-maps the canonical
> value to the `applyTo` enum vocabulary via `policies.js toWritePolicyValue()`
> right before the POST:
>
> | Canonical (`--policyValue`) | Wire value (env-level policies) |
> |-----------------------------|---------------------------------|
> | `All`     | `AllSites` |
> | `Include` | `IncludeSites` |
> | `Exclude` | `ExcludeSites` |
> | `None`    | `None` (disable is conveyed by the value itself) |
>
> The `None` wire value conveys disable by the value itself rather than an
> `applyTo` enum form. This mirrors the read side, where env-level policies
> return `*Sites` which `policies.js normalizeEnvValue()` folds back to the
> canonical form.
> Verified empirically against Preprod (2024-10-01 gateway): POSTing
> `policyValue:"AllSites"` for `EnableMakerCopilotForExistingSites` returns
> `200 "Policy upserts accepted."` and flips the env `None` → `AllSites`;
> `policyValue:"IncludeSites"` + `ToBeAdded:[siteIds]` returns `200` and the env
> reads back `IncludeSites` with those sites on the inclusion list — whereas the
> short forms (`All` / `Include` / `Exclude`) are rejected.

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
acquired a token. The token itself is cloud-scoped, not env-scoped, so the
same token works against any env in the same cloud.

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
  [--timeoutMinutes <n>] \
  [--useAdminPortal --token <bearer>]
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
| `--useAdminPortal` | No | off | Switch to the admin-portal transport. |
| `--token` | No | — | Bearer token for the admin portal (required with `--useAdminPortal`). |

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
