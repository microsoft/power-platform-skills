# Rule Reference

All values are placeholders — populate from the user's input, the site's existing rules, and `get-rules.js` output. Never hardcode IPs, countries, paths, or thresholds.

## Table of contents

- [Custom rule](#custom-rule)
- [Match condition](#match-condition)
- [Match variables](#match-variables)
- [Operators](#operators)
- [Managed rule set](#managed-rule-set)
- [Rule group override](#rule-group-override)
- [Rule override](#rule-override)
- [Bot protection](#bot-protection)
- [Priority guidance](#priority-guidance)
- [Propagation delay](#propagation-delay)

---

## Custom rule

One shape covers both standard and rate-limit rules. Set `ruleType` to `RateLimitRule` and add the two rate-limit fields when needed. Field **keys** use **camelCase**. The `name` field **value** must be PascalCase.

```json
{
  "name": "<PascalCase-name>",
  "priority": "<11–65000>",
  "enabledState": "<Enabled|Disabled>",
  "ruleType": "<MatchRule|RateLimitRule>",
  "rateLimitDurationInMinutes": "<1|5>",
  "rateLimitThreshold": "<integer-min-10>",
  "matchConditions": [
    {
      "matchVariable": "<variable>",
      "selector": "<when-required>",
      "operator": "<operator>",
      "negateCondition": false,
      "matchValue": ["<value>"]
    }
  ],
  "action": "<Allow|Block|Log|Redirect>"
}
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `name` | string | Yes | Letters and numbers only, starts with a letter, PascalCase. Case-insensitive unique — submitting an existing name replaces that rule. |
| `priority` | integer | Yes | 11–65000. Lower = higher priority (first-match-wins). Auto-increments on conflict. |
| `enabledState` | string | Yes | `"Enabled"`, `"Disabled"` |
| `ruleType` | string | Yes | `"MatchRule"`, `"RateLimitRule"` |
| `rateLimitDurationInMinutes` | integer | Only for `RateLimitRule` | `1` or `5` (no other values). |
| `rateLimitThreshold` | integer | Only for `RateLimitRule` | Minimum 10. Requests per client in the duration window before the action fires. |
| `matchConditions` | array | Yes | One or more match condition objects. All must match for the rule to fire (AND logic). |
| `action` | string | Yes | `"Allow"`, `"Block"`, `"Log"`, `"Redirect"` |

- Allow rules MUST use a lower priority number than the block rules they need to bypass.
- Omit `rateLimitDurationInMinutes` and `rateLimitThreshold` for `MatchRule` — they are ignored.
- To extend an existing rule's match values, submit the same rule name with the updated `matchValue` — only include that rule in the payload.

---

## Match condition

Each object in the `matchConditions` array. Field keys use **camelCase**.

```json
{
  "matchVariable": "<variable>",
  "selector": "<header-or-param-name>",
  "operator": "<operator>",
  "negateCondition": false,
  "matchValue": ["<value>"]
}
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `matchVariable` | string | Yes | See [Match variables](#match-variables). |
| `selector` | string | Only for `RequestHeader`, `Cookies`, `PostArgs`, `QueryString` | Names which header, cookie, field, or parameter to inspect. Omit for other variables. |
| `operator` | string | Yes | See [Operators](#operators). |
| `negateCondition` | boolean | No | `true` or `false`. Default `false`. Set to `true` to invert the match. |
| `matchValue` | array of strings | Yes | Format depends on operator: ISO 3166-1 alpha-2 codes for `GeoMatch`, CIDR notation or single IPs for `IPMatch`, strings for others. |

- **`transforms` is not supported** The field exists in the schema but is not persisted when creating or updating rules. Do not include it in the payload.

---

## Match variables

| Value | Requires `selector` | Description |
|-------|---------------------|-------------|
| `RemoteAddr` | No | Original client IP. Sourced from `X-Forwarded-For` when behind a proxy. |
| `SocketAddr` | No | Direct-connection IP at the firewall edge — matches the proxy/load balancer, not the end user. |
| `RequestUri` | No | Requested path and query string. |
| `RequestHeader` | Yes | A specific HTTP request header. |
| `RequestMethod` | No | The HTTP method. |
| `QueryString` | Yes | A specific query string parameter. |
| `RequestBody` | No | The request body content. |
| `Cookies` | Yes | A specific cookie. |
| `PostArgs` | Yes | A specific POST form field. |

## Operators

| Value | Compatible with | Description |
|-------|-----------------|-------------|
| `IPMatch` | `RemoteAddr`, `SocketAddr` | Matches IPs and CIDR ranges. |
| `GeoMatch` | `RemoteAddr` | Matches ISO 3166-1 alpha-2 country codes. |
| `Contains` | String variables | Substring match. |
| `BeginsWith` | String variables | Prefix match. |
| `EndsWith` | String variables | Suffix match. |
| `RegEx` | String variables | Regular expression match. |
| `Equal` | Any | Exact match. |
| `LessThan` | Numeric comparisons | Less than. |
| `GreaterThan` | Numeric comparisons | Greater than. |
| `LessThanOrEqual` | Numeric comparisons | Less than or equal. |
| `GreaterThanOrEqual` | Numeric comparisons | Greater than or equal. |
| `Any` | Any | Matches everything — use for catch-all rules. |

---

## Managed rule set

Retrieve `RuleSetType` and `RuleSetVersion` from `get-rules.js` output — never hardcode them. Field keys use **PascalCase**.

```json
{
  "RuleSetType": "<from get-rules.js output>",
  "RuleSetVersion": "<from get-rules.js output>",
  "RuleGroupOverrides": []
}
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `RuleSetType` | string | Yes | Copy from `get-rules.js` output. |
| `RuleSetVersion` | string | Yes | Copy from `get-rules.js` output. |
| `RuleGroupOverrides` | array | No | Per-group overrides. See [Rule group override](#rule-group-override). |

The managed rule set action is always Block — this cannot be changed. To disable a noisy rule, add an entry to `RuleGroupOverrides` rather than disabling the entire set. Managed rules configuration is not available in all regions — see `commands.md` § "Regional availability".

## Rule group override

Each object in the `RuleGroupOverrides` array. Field keys use **PascalCase**.

```json
{
  "RuleGroupName": "<from get-rules.js output>",
  "Rules": []
}
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `RuleGroupName` | string | Yes | The rule group to override. Get available names from `get-rules.js` output. |
| `Rules` | array | No | Individual rule overrides. See [Rule override](#rule-override). |

## Rule override

Each object in the `Rules` array within a rule group override. Field keys use **PascalCase**.

```json
{
  "RuleId": "<from get-rules.js output>",
  "EnabledState": "<Enabled|Disabled>",
  "Action": "<Allow|Block|Log|Redirect|AnomalyScoring>"
}
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `RuleId` | string | Yes | The specific rule id to override. Get available ids from `get-rules.js` output. |
| `EnabledState` | string | No | `"Enabled"`, `"Disabled"`. Set to `"Disabled"` to suppress a false-positive managed rule. |
| `Action` | string | No | `"Allow"`, `"Block"`, `"Log"`, `"Redirect"`, `"AnomalyScoring"`. `AnomalyScoring` applies to managed rule overrides only, not custom rules. |

## Bot protection

Bot protection is a managed rule category classifying automated traffic:

| Group | Description |
|-------|-------------|
| Good bots | Search engine crawlers and known-friendly automation |
| Bad bots | Known malicious scrapers, spam bots, and attack tools |
| Unknown bots | Visitors that do not identify themselves |

Use `RuleGroupOverrides` to change the action for individual bot categories.

## Priority guidance

Lower number = higher priority. Valid range: **11–65000**. Use these bands so rules layer predictably:

| Range        | Purpose                                               |
|--------------|-------------------------------------------------------|
| `11`–`499`   | Allow rules for trusted traffic                       |
| `500`–`999`  | Keep empty — reserved by this skill's band allocation |
| `1000`–`1999`| IP and country block rules                            |
| `2000`–`2999`| Path / URI pattern rules                              |
| `3000`–`3999`| Rate-limit rules                                      |

When inserting a new rule, check existing rules and pick the next free slot in the matching band.

## Propagation delay

After creating or updating rules, changes may take **up to one hour** to propagate to all edge locations worldwide.
