# Rule Cookbook

Copy-paste rule shapes for the most common things users want to add. Every example uses generic names — never reference a real organization, country, or person.

## Table of contents

- [Block specific IP addresses](#block-specific-ip-addresses)
- [Allow trusted IP addresses through](#allow-trusted-ip-addresses-through)
- [Block by request path](#block-by-request-path)
- [Block traffic from selected countries](#block-traffic-from-selected-countries)
- [Slow down repeated requests from one visitor](#slow-down-repeated-requests-from-one-visitor)
- [Match variables](#match-variables)
- [Add a managed rule set](#add-a-managed-rule-set)
- [Bot protection](#bot-protection)
- [Priority guidance](#priority-guidance)
- [Propagation delay](#propagation-delay)

---

## Block specific IP addresses

```json
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
```

The `matchValue` accepts both individual IPv4 / IPv6 addresses and CIDR ranges. To extend the list later, run `get-rules.js`, edit this rule's `matchValue`, and call `set-rules.js` with the updated payload.

## Allow trusted IP addresses through

Use a **lower** priority number so the allow rule wins over later block rules.

```json
{
  "name": "Allow-Office-IPs",
  "priority": 100,
  "enabledState": "Enabled",
  "ruleType": "MatchRule",
  "matchConditions": [
    {
      "matchVariable": "RemoteAddr",
      "operator": "IPMatch",
      "matchValue": ["192.0.2.0/24"]
    }
  ],
  "action": "Allow"
}
```

## Block by request path

Match on a request URI to block requests targeting specific URL patterns.

```json
{
  "name": "Block-Admin-Paths",
  "priority": 1500,
  "enabledState": "Enabled",
  "ruleType": "MatchRule",
  "matchConditions": [
    {
      "matchVariable": "RequestUri",
      "operator": "Contains",
      "matchValue": ["/admin", "/_services"]
    }
  ],
  "action": "Block"
}
```

Supported operators for URI matching include `Contains`, `BeginsWith`, `EndsWith`, and `RegEx`. The `matchValue` accepts multiple patterns.

## Block traffic from selected countries

Match on the `RemoteAddr` variable using the `GeoMatch` operator. Use ISO 3166-1 alpha-2 codes — leave the example values as placeholders the user can edit.

```json
{
  "name": "Block-Selected-Countries",
  "priority": 2000,
  "enabledState": "Enabled",
  "ruleType": "MatchRule",
  "matchConditions": [
    {
      "matchVariable": "RemoteAddr",
      "operator": "GeoMatch",
      "matchValue": ["XX", "YY"]
    }
  ],
  "action": "Block"
}
```

To allow traffic only from specific countries, combine an allow rule for those countries (lower priority) with a catch-all block rule for everything else (higher priority number).

## Slow down repeated requests from one visitor

Use a `RateLimitRule`. The example below blocks any single client IP that makes more than 100 requests in one minute.

```json
{
  "name": "Rate-Limit-Per-IP",
  "priority": 3000,
  "enabledState": "Enabled",
  "ruleType": "RateLimitRule",
  "rateLimitDurationInMinutes": 1,
  "rateLimitThreshold": 100,
  "matchConditions": [
    {
      "matchVariable": "RemoteAddr",
      "operator": "IPMatch",
      "matchValue": ["0.0.0.0/0"]
    }
  ],
  "action": "Block"
}
```

The `rateLimitDurationInMinutes` accepts values between **1** and **5**. The `0.0.0.0/0` match applies the rate limit across every visitor. Tune the threshold and duration based on legitimate traffic patterns.

---

## Match variables

| Variable | Use when |
|----------|----------|
| `RemoteAddr` | The original client IP address — use this for most rules. Sourced from the `X-Forwarded-For` header when the client is behind a proxy. |
| `SocketAddr` | The direct-connection IP address at the firewall edge — use when matching the proxy or load balancer's address rather than the end user. |
| `RequestUri` | The requested path and query string — use for path-based blocking. |

---

## Add a managed rule set

Managed rule sets pull from a subset of Azure-managed rules relevant to Power Pages, updated automatically for new attack signatures. When the firewall is enabled, these managed rules are turned on by default. Individual rules can be enabled or disabled. Choose conservative defaults and add overrides only when a specific rule causes false positives.

The API payload for managed rules uses Azure Front Door rule set identifiers. The specific `RuleSetType` and `RuleSetVersion` values come from the underlying Azure Front Door service — retrieve the current values from `get-rules.js` rather than hard-coding them.

```json
{
  "RuleSetType": "<from get-rules.js output>",
  "RuleSetVersion": "<from get-rules.js output>",
  "RuleSetAction": "Block",
  "Exclusions": [],
  "RuleGroupOverrides": []
}
```

To disable a noisy rule, add an entry to `RuleGroupOverrides` rather than disabling the entire rule set.

Managed rules configuration is not available in GCC, GCC High, DoD, China, or UAE regions.

## Bot protection

Bot protection is a managed rule category that classifies automated traffic into three groups:

| Group | Description |
|-------|-------------|
| Good bots | Search engine crawlers and known-friendly automation |
| Bad bots | Known malicious scrapers, spam bots, and attack tools |
| Unknown bots | Visitors that do not identify themselves |

Bot protection rules are configured alongside the default managed rule set. Use `RuleGroupOverrides` to change the action for individual bot categories when the default is too strict or too lenient.

## Priority guidance

Lower number = higher priority. Use these bands so rules layer predictably:

| Range        | Purpose                                  |
|--------------|------------------------------------------|
| `11`-`499`   | Allow rules for trusted traffic          |
| `500`-`999`  | Reserved                                 |
| `1000`-`1999`| IP and country block rules               |
| `2000`-`2999`| Pattern / signature / URI rules          |
| `3000`-`3999`| Rate-limit rules                         |

When inserting a new rule, reuse the next free slot in the matching band rather than re-numbering existing rules.

## Propagation delay

After creating or updating firewall rules, changes may take **up to one hour** to propagate to all edge locations worldwide. Factor this delay into the user's expectations when confirming rule changes.
