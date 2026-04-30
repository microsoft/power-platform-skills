# Manage Web Application Firewall — Commands

Reference for the helper scripts under `scripts/`. All scripts use the shared admin-api client, share the same authentication failure mode (exit code `2`), and support `--help` to display usage, flags, and exit codes.

## Table of contents

- [Identifiers — websiteId vs. portalId](#identifiers--websiteid-vs-portalid)
- [`get-status.js`](#get-statusjs)
- [`get-rules.js`](#get-rulesjs)
- [`enable.js`](#enablejs)
- [`disable.js`](#disablejs)
- [`set-rules.js`](#set-rulesjs)
- [`delete-rules.js`](#delete-rulesjs)
- [Common error catalogue](#common-error-catalogue)
- [Body schema — custom rules](#body-schema--custom-rules)
- [Body schema — managed rules](#body-schema--managed-rules)

---

## Identifiers — websiteId vs. portalId

Two different GUIDs identify a Power Pages site:

| Identifier | Where it comes from | What it is |
|------------|---------------------|------------|
| `websiteId` | `.powerpages-site/website.yml` (`id` field), `pac pages list` ("Website Record ID") | Dataverse website record primary key. The user-facing identifier. |
| `portalId` | `Id` field on the `/websites` admin-API response | The `{id}` segment in admin-API URL paths such as `/websites/{id}/enableWaf`. |

The skill resolves `websiteId` → `portalId` once during Phase 1 by reading `.powerpages-site/website.yml` and calling `${CLAUDE_PLUGIN_ROOT}/scripts/website.js --websiteId <guid>`. It reuses the resolved `portalId` for the rest of the run. The consumer scripts in this folder accept `--portalId` only — they never look up the site themselves.

If `.powerpages-site/website.yml` does not exist, the site has not been deployed yet. The skill does **not** try to identify the site by name or URL (two sites in the same environment can share a name, and the URL changes when the subdomain is updated) — it directs the user to `/deploy-site` and stops.

See the resolution helper section in `manage-site-scan/references/commands.md` for the full `website.js` contract.

---

## `get-status.js`

Returns the current firewall status (Enabled / Disabled / Enabling / Disabling).

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/get-status.js" \
  --portalId <guid> \
  --output <file>
```

### Response (stdout)

```json
{ "status": "ok", "value": "Enabled", "output": "<file>" }
```

…or, when the feature is unavailable for this site:

```json
{ "status": "unsupported", "message": "Power Pages built-in WAF feature is not supported in <region>", "output": "<file>" }
```

The matching JSON is also written to `--output` so the caller can pass it into the report renderer.

### Errors

| Status / `code` | Meaning |
|-----------------|---------|
| `400 / B022`    | Region does not offer the firewall |
| `400 / B023`    | Trial site — convert to production first |
| `400 / A001`    | Site not found |
| `401 / D004`    | Caller not authorized |

---

## `get-rules.js`

Returns the full firewall configuration (managed rule sets and custom rules).

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/get-rules.js" \
  --portalId <guid> \
  --output <file> \
  [--ruleType <name>]
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--portalId`   | Yes      | Admin-API portalId resolved during Phase 1. |
| `--output`     | Yes      | Path for the response JSON. |
| `--ruleType`   | No       | Optional filter — `Custom` or `Managed`. Omit for both. |

### Response (stdout summary)

```json
{ "status": "ok", "customRules": 3, "managedRules": 2, "output": "<file>" }
```

The full response is written to `--output` as `{ "status": "ok", "body": { "CustomRules": [...], "ManagedRules": [...] } }`.

---

## `enable.js`

Turns the firewall on. The underlying operation is asynchronous — the script polls the status endpoint until the value becomes `Enabled` or the timeout elapses.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/enable.js" \
  --portalId <guid> \
  [--timeoutMinutes <n>]
```

### Parameters

| Flag                  | Required | Default | Description |
|-----------------------|----------|---------|-------------|
| `--portalId`          | Yes      | —       | Admin-API portalId resolved during Phase 1. |
| `--timeoutMinutes`    | No       | `15`    | Maximum time to wait for the operation to complete. |

### Response (stdout)

```json
{ "status": "enabled", "attempts": 6 }
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Enabled |
| `2`  | Sign-in required |
| `3`  | Polling timed out |
| `4`  | Unsupported (trial / region) |
| `1`  | Service or network failure |

### Notes

- The service may return `409 / B003` if a previous operation is still in progress. The script treats that as "wait and poll" rather than a hard failure.

---

## `disable.js`

Mirror of `enable.js` — turns the firewall off and polls until status is `Disabled`. Same parameters and exit codes; stdout reports `{ "status": "disabled", "attempts": <n> }`.

---

## `set-rules.js`

Creates or updates the full set of firewall rules. The service replaces the existing configuration with the payload.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/set-rules.js" \
  --portalId <guid> \
  --rules <json-file>
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--portalId`   | Yes      | Admin-API portalId resolved during Phase 1. |
| `--rules`      | Yes      | Path to a JSON file containing the desired rule configuration (see shape below). |

### Rule file shape

```json
{
  "CustomRules": [
    {
      "name": "Block-Malicious-IPs",
      "priority": 1000,
      "enabledState": "Enabled",
      "ruleType": "MatchRule",
      "matchConditions": [
        {
          "matchVariable": "RemoteAddr",
          "operator": "IPMatch",
          "matchValue": ["203.0.113.5", "198.51.100.0/24"]
        }
      ],
      "action": "Block"
    }
  ],
  "ManagedRules": [
    {
      "RuleSetType": "<from get-rules.js — Azure Front Door rule set identifier>",
      "RuleSetVersion": "<from get-rules.js — current version>",
      "RuleSetAction": "Block",
      "Exclusions": [],
      "RuleGroupOverrides": []
    }
  ]
}
```

`CustomRules` and `ManagedRules` are both optional — omit one to leave that part of the configuration unchanged at the caller's discretion (the skill always reads existing rules before writing, so it never accidentally drops them).

### Response (stdout)

```json
{ "status": "ok", "body": { /* updated rule configuration */ } }
```

### Errors

| Status / `code` | Meaning |
|-----------------|---------|
| `400 / B022`    | Feature unavailable in region |
| `400 / B023`    | Trial site |
| `400 / A010`    | Invalid rule shape — service rejects payload |
| `404 / A001`    | Site not found |

---

## `delete-rules.js`

Deletes one or more **custom** rules by name. Managed rule sets are not affected.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/delete-rules.js" \
  --portalId <guid> \
  --names <name1,name2,...>
```

### Response (stdout)

```json
{ "status": "accepted", "deleted": ["Block-Malicious-IPs"] }
```

The deletion is asynchronous; the response is `202 Accepted`. To confirm the change, re-run `get-rules.js` after a short delay.

---

## Common error catalogue

These error codes appear across the firewall scripts. Map them to friendly messages before showing them to the user.

| Code   | Script exit | Meaning                                                               | Friendly message |
|--------|-------------|-----------------------------------------------------------------------|------------------|
| `A001` | `1`         | Portal not found                                                      | "I could not find that site." |
| `A009` | `1`         | Service-side failure                                                  | "Something went wrong on the service side. Try again in a few minutes." |
| `A010` | `1`         | Invalid input / schema validation failure                             | "Some part of the rule was not in the expected shape — try again." |
| `A019` | `1`         | Portal id is not a valid GUID                                         | "The site identifier is not in the expected format." |
| `A033` | `1`         | Tenant mismatch                                                       | "The site belongs to a different tenant than your current session." |
| `B001` | `1`         | Edge infrastructure not provisioned                                   | "The site does not have the front-door routing required for the shield." |
| `B003` | `1` *       | Another WAF operation in progress                                     | "Your last change is still being applied. I will wait and check again shortly." |
| `B022` | `4` **      | Region not supported (Singapore Local, China, UAE)                    | "The shield is not available in your region yet." |
| `B023` | `4` **      | Trial portal — production required                                    | "Your site needs to be a production site before you can turn on the shield." |
| `D004` | `1`         | Caller not authorized                                                 | "Your account does not have permission for this. Ask an admin." |

\* `B003` handling varies by script. `enable.js` and `disable.js` treat 409/B003 as "wait and poll" (no hard failure — the script continues to poll status until the in-flight operation settles). Other scripts exit `1`.

\** `B022`/`B023` handling varies by script. `get-status.js` and `get-rules.js` return exit `0` with `{ "status": "unsupported" }` in the output (so the caller can include the finding in the report). `enable.js`, `disable.js`, `set-rules.js`, and `delete-rules.js` exit `4`.

All scripts also share these exit codes:

| Exit | Meaning |
|------|---------|
| `0`  | Success |
| `2`  | Sign-in required (auth token missing or expired) |
| `3`  | Polling timed out (enable / disable only) |

### Regional availability

| Operation | Unavailable in |
|-----------|----------------|
| Enable / disable firewall | Singapore Local, China, UAE |
| Managed rule configuration | GCC, GCC High, DoD, China, UAE |
| Custom rule configuration  | GCC, GCC High, DoD, China, UAE |

When `website.js --websiteId` returns `null` during Phase 1, the skill stops with a local error before any consumer script runs.

---

## Body schema — custom rules

> **Case sensitivity:** custom rule fields use **camelCase**. Managed rule fields use **PascalCase**. Mixing cases causes `A010` rejections.

> **Priority minimum:** custom rules must use priority **>= 11**. Values 1-10 are reserved for platform-managed rules and will be rejected.

Each object in the `CustomRules` array follows this schema:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique rule name. Use descriptive names like `Block-Countries`, `Allow-Office-IP`. |
| `priority` | integer | Yes | Evaluation order (first-match-wins). Must be >= 11. Lower numbers evaluate first. |
| `enabledState` | string | Yes | `"Enabled"` or `"Disabled"`. |
| `ruleType` | string | Yes | `"MatchRule"` (standard) or `"RateLimitRule"` (rate limiting). |
| `action` | string | Yes | `"Allow"`, `"Block"`, `"Log"`, or `"Redirect"`. |
| `matchConditions` | array | Yes | One or more match condition objects (see below). All conditions must match for the rule to fire (AND logic). |
| `rateLimitThreshold` | integer | Only for `RateLimitRule` | Number of requests allowed within the duration window before the action fires. |
| `rateLimitDurationInMinutes` | integer | Only for `RateLimitRule` | Duration window: `1` or `5`. |

### Match condition object

Each entry in `matchConditions`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `matchVariable` | string | Yes | What to inspect. One of: `RemoteAddr`, `SocketAddr`, `RequestMethod`, `RequestHeader`, `RequestUri`, `QueryString`, `RequestBody`, `Cookies`, `PostArgs`. |
| `selector` | string | Only when variable needs it | The specific header name, cookie name, or post-arg name (e.g., `"User-Agent"` when `matchVariable` is `RequestHeader`). |
| `operator` | string | Yes | Comparison operator. One of: `IPMatch`, `GeoMatch`, `Equal`, `Contains`, `LessThan`, `GreaterThan`, `LessThanOrEqual`, `GreaterThanOrEqual`, `BeginsWith`, `EndsWith`, `RegEx`, `Any`. |
| `negateCondition` | boolean | No | Default `false`. Set to `true` to invert the match (e.g., "NOT in this country list"). |
| `matchValue` | array of strings | Yes | Values to match against. For `GeoMatch`, use ISO 3166-1 alpha-2 country codes. For `IPMatch`, use CIDR notation or single IPs. |
| `transforms` | array of strings | No | Transformations applied before matching. One or more of: `Lowercase`, `Uppercase`, `Trim`, `UrlDecode`, `UrlEncode`, `RemoveNulls`, `HtmlEntityDecode`. |

---

## Body schema — managed rules

Each object in the `ManagedRules` array follows this schema:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `RuleSetType` | string | Yes | The managed rule set identifier (copy from `get-rules.js` output). |
| `RuleSetVersion` | string | Yes | The rule set version (copy from `get-rules.js` output). |
| `RuleSetAction` | string | Yes | Default action for matched rules: `"Block"`, `"Log"`, or `"Redirect"`. |
| `Exclusions` | array | No | Global exclusions that apply to all rule groups in this set (see exclusion object below). |
| `RuleGroupOverrides` | array | No | Per-group overrides to disable specific rules or change their action (see rule group override object below). |

### Rule group override object

Each entry in `RuleGroupOverrides`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `RuleGroupName` | string | Yes | The rule group to override (e.g., `"SQLI"`, `"XSS"`, `"RFI"`). |
| `Rules` | array | No | Individual rule overrides within this group (see rule override object below). |
| `Exclusions` | array | No | Exclusions scoped to this rule group only. |

### Rule override object

Each entry in `Rules` within a `RuleGroupOverrides` entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `RuleId` | string | Yes | The specific rule id to override. |
| `EnabledState` | string | No | `"Enabled"` or `"Disabled"`. Set to `"Disabled"` to suppress a false-positive managed rule. |
| `Action` | string | No | Override the action for this rule: `"Block"`, `"Log"`, `"Redirect"`, or `"AnomalyScoring"`. |
| `Exclusions` | array | No | Exclusions scoped to this specific rule only. |

### Exclusion object

Each exclusion (at any level — rule set, rule group, or individual rule):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `MatchVariable` | string | Yes | `"RequestHeaderNames"`, `"RequestCookieNames"`, `"QueryStringArgNames"`, or `"RequestBodyPostArgNames"`. |
| `SelectorMatchOperator` | string | Yes | `"Equals"`, `"Contains"`, `"StartsWith"`, or `"EndsWith"`. |
| `Selector` | string | Yes | The name to match (e.g., a header name like `"X-Custom-Token"`). |
