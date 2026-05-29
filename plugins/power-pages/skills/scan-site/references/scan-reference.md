# Scan Reference

Field-level schema for the scan report returned by `get-latest-report.js`. Use this when normalizing alerts into the unified report findings.

> **Terminology**: the API returns **alerts** at the rule level. The skill normalizes them into **findings** in the unified report.

## Table of contents

- [Report envelope](#report-envelope)
- [Rule](#rule)
- [Alert](#alert)
- [Risk values](#risk-values)
- [Rule statuses](#rule-statuses)
- [Severity mapping](#severity-mapping)
- [Scan progress](#scan-progress)

---

## Report envelope

The scan report returned by `get-latest-report.js` (under `body`). Field keys use **PascalCase**.

```json
{
  "TotalRuleCount": <count>,
  "FailedRuleCount": <count>,
  "TotalAlertCount": <count>,
  "UserName": "<account-or-null>",
  "StartTime": "<iso-8601-utc>",
  "EndTime": "<iso-8601-utc>",
  "Rules": [ ]
}
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `TotalRuleCount` | integer | Yes | Total number of rules evaluated. |
| `FailedRuleCount` | integer | Yes | Rules that produced one or more alerts. |
| `TotalAlertCount` | integer | Yes | Total number of alerts across all rules. |
| `UserName` | string \| null | No | Account that started the scan. `null` for anonymous scans. |
| `StartTime` | string | Yes | ISO 8601 UTC timestamp (suffixed with `Z`). |
| `EndTime` | string | Yes | ISO 8601 UTC timestamp (suffixed with `Z`). |
| `Rules` | array | Yes | Per-rule results. See [Rule](#rule). May be empty. |

---

## Rule

Each object in the `Rules` array. Field keys use **PascalCase**.

```json
{
  "RuleId": "<id>",
  "RuleName": "<name>",
  "RuleStatus": "<RulePassed|RuleFailed|RuleNotRun|RuleTimedOut>",
  "AlertsCount": <count>,
  "Alerts": [ ]
}
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `RuleId` | string | Yes | Stable rule identifier. |
| `RuleName` | string | Yes | Human-readable rule name. |
| `RuleStatus` | string | Yes | See [Rule statuses](#rule-statuses). |
| `AlertsCount` | integer | Yes | Number of alerts produced by this rule. `0` when the rule passed or did not run. |
| `Alerts` | array | Yes | Findings produced by the rule. Empty array when `RuleStatus` is `RulePassed`, `RuleNotRun`, or `RuleTimedOut`. See [Alert](#alert). |

---

## Alert

Each object in the `Alerts` array. Field keys use **PascalCase**.

```json
{
  "AlertId": "<id>",
  "AlertName": "<name>",
  "Description": "<plain-language>",
  "Mitigation": "<plain-language>",
  "Risk": <0-3>,
  "RuleId": "<id>",
  "LearnMoreLink": [ ],
  "CallToAction": [ ]
}
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `AlertId` | string | Yes | Stable alert identifier. |
| `AlertName` | string | Yes | Short title for the finding. |
| `Description` | string | Yes | What was detected, in plain language. |
| `Mitigation` | string | Yes | Suggested fix, in plain language. |
| `Risk` | integer | Yes | Severity as a numeric code. See [Risk values](#risk-values). |
| `RuleId` | string | Yes | Identifier of the rule that produced this alert. |
| `LearnMoreLink` | array of strings | No | URLs with background reading. May be absent or empty. |
| `CallToAction` | array of strings | No | Suggested follow-up actions. May be absent or empty. |

---

## Risk values

| Value | Meaning |
|-------|---------|
| `0` | Informational |
| `1` | Low |
| `2` | Medium |
| `3` | High |

There is no `Critical` value — `3` (High) is the maximum severity returned.

## Rule statuses

| Value | Meaning |
|-------|---------|
| `RulePassed` | Rule ran and produced no alerts. |
| `RuleFailed` | Rule ran and produced one or more alerts. |
| `RuleNotRun` | Rule did not run (e.g., not applicable to the site). |
| `RuleTimedOut` | Rule started but did not finish within the time budget. |

## Severity mapping

`transform-report.js` maps each alert `Risk` to a finding `severity`, mirroring the Power Pages Studio classification:

| Risk value | Studio label | `severity` |
|------------|--------------|------------|
| `3` (High) | Critical | `critical` |
| `2` (Medium) | Warning | `warning` |
| `1` (Low) | Warning | `warning` |
| `0` (Informational) | Info | `info` |
| missing | Warning | `warning` |

`RulePassed` → `pass`. `RuleNotRun` / `RuleTimedOut` → `warning`.

## Scan progress

The scan-status check (used by `poll-deep-scan.js`) returns:

```json
{ "status": <true|false> }
```

| Field | Type | Required | Valid values / format |
|-------|------|----------|----------------------|
| `status` | boolean | Yes | `true` while a scan is running. `false` when idle. |
