# Manage Site Scan — Commands

Reference for the helper scripts under `scripts/`. Every script is non-interactive, accepts flags only, and prints a JSON object on success. All scripts support `--help` to display usage, flags, and exit codes. The first stage is always `resolveContext()` from the shared admin-api client, so every script can fail with exit code `2` ("sign-in required") before doing any work.

## Shared exit codes

Every script in this skill can exit with the following codes. Script-specific codes are documented in their own sections.

| Code | Meaning |
|------|---------|
| `0`  | Success. The script completed normally. For `website.js`, a `null` response is still exit code 0 — the caller decides how to handle it. For `start-deep-scan.js`, a scan-already-running outcome (`Z003` / HTTP 204) is also exit 0 with `{ "status": "already-running" }`. |
| `1`  | General failure. Covers service errors, bad requests, authorization failures, and any other non-success response. The error message on stderr contains the HTTP status code and service error details (e.g., `A001`, `A009`, `A019`, `A033`, `D004`). |
| `2`  | Sign-in required. The authenticated session has expired or was never created. Fix with `pac auth create` or `az login`. |
| `3`  | Timeout. Used by `poll-deep-scan.js` when the scan does not complete within the configured window. |

## Table of contents

- [Identifiers — websiteId vs. portalId](#identifiers--websiteid-vs-portalid)
- [Resolving the website — `website.js`](#resolving-the-website--websitejs)
- [`start-deep-scan.js`](#start-deep-scanjs)
- [`poll-deep-scan.js`](#poll-deep-scanjs)
- [`get-latest-report.js`](#get-latest-reportjs)

- [Common error catalogue](#common-error-catalogue)
- [Operating notes](#operating-notes)

---

## Identifiers — websiteId vs. portalId

Two different GUIDs identify a Power Pages site. Keep them straight:

| Identifier | Where it comes from | What it is |
|------------|---------------------|------------|
| `websiteId` | `.powerpages-site/website.yml` (`id` field), `pac pages list` ("Website Record ID") | Dataverse website record primary key. The user-facing identifier. |
| `portalId` | `Id` field on the `/websites` admin-API response | The `{id}` segment in admin-API URL paths such as `/websites/{id}/scan/...`. |

These are **not** the same value. The skill resolves `websiteId` → `portalId` once during Phase 1 (using `website.js --websiteId <guid>`) and reuses the resolved `portalId` for the rest of the run. The consumer scripts in this folder accept `--portalId` only — they never look up the site themselves.

---

## Resolving the website — `website.js`

The shared `scripts/website.js` resolves a Dataverse `websiteId` (read from `.powerpages-site/website.yml`) to its full website record, which includes the `Id` field — the portalId. The skill calls it once during prerequisites and reuses the resolved portalId for every consumer script in the run.

The skill never identifies a site by name or URL: two sites in the same environment can share a name, and the URL changes when the subdomain is updated. A missing `.powerpages-site/website.yml` means the site has not been deployed yet — the correct response is to direct the user to `/deploy-site`.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/website.js" --websiteId <guid>
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--websiteId`  | Yes      | Dataverse website record id to resolve. |

The field projection is hardcoded to a safe shape that includes `Id`, `Name`, `WebsiteRecordId`, `WebsiteUrl`, `Type`, `status`, `Subdomain`, `SiteVisibility`, `PortalWAFStatus`, `PortalAFDStatus`, and `TrialExpiringInDays`.

### Response (stdout)

A single matching website record (or `null` when no record matches):

```json
{
  "Id": "11111111-2222-3333-4444-555555555555",
  "Name": "Contoso Customer Portal",
  "WebsiteRecordId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "WebsiteUrl": "https://contoso.powerappsportals.com/",
  "Type": "Production",
  "status": "Ready",
  "Subdomain": "contoso",
  "SiteVisibility": "public",
  "PortalWAFStatus": "Enabled",
  "PortalAFDStatus": "Associated"
}
```

`Id` is the **portalId** — pass it as `--portalId` to every consumer script in this skill. `WebsiteRecordId` echoes the Dataverse `websiteId` you sent in.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success (`null` is also success — caller decides what to do) |
| `2`  | Sign-in required |
| `1`  | Service error |

---

## `start-deep-scan.js`

Triggers a thorough scan asynchronously.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-site-scan/scripts/start-deep-scan.js" \
  --portalId <guid>
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--portalId`   | Yes      | Admin-API portalId resolved during Phase 1. |

### Response (stdout)

```json
{ "status": "started" }
```

…or, when the service indicates a scan is already running for this site:

```json
{ "status": "already-running" }
```

---

## `poll-deep-scan.js`

Polls the "is ongoing" endpoint until the scan finishes or the timeout elapses.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-site-scan/scripts/poll-deep-scan.js" \
  --portalId <guid> \
  [--timeoutMinutes <n>] \
  [--intervalSeconds <n>]
```

### Parameters

| Flag                  | Required | Default | Description |
|-----------------------|----------|---------|-------------|
| `--portalId`          | Yes      | —       | Admin-API portalId resolved during Phase 1. |
| `--timeoutMinutes`    | No       | `20`    | Maximum time to wait. |
| `--intervalSeconds`   | No       | `30`    | Pause between status checks. |

### Response (stdout)

```json
{ "status": "done", "elapsedSeconds": 612 }
```

…or, when the timeout passes without completion:

```json
{ "status": "timeout", "elapsedSeconds": 1200 }
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Scan finished |
| `3`  | Timeout |
| `2`  | Sign-in required |
| `1`  | Service error |

### Usage notes

- Always run with `run_in_background: true` and check the output file or status periodically.
- Progress lines on **stderr** every minute are intended for the agent's monitoring, not the user.

---

## `get-latest-report.js`

Fetches the latest completed deep-scan report and writes the response to a file.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-site-scan/scripts/get-latest-report.js" \
  --portalId <guid> \
  --output <file>
```

### Response (stdout summary)

On success:

```json
{ "status": "ok", "output": "<file>" }
```

The file holds the service-defined report envelope. When no scan has completed yet:

```json
{ "status": "empty", "output": "<file>" }
```

The file holds `{ "status": "empty" }`. Treat `empty` as an `info` finding rather than an error.

### Response shape — deep scan report

The deep scan report is a structured object with:

| Field | Type | Notes |
|---|---|---|
| `TotalRuleCount` | integer | Rules evaluated |
| `FailedRuleCount` | integer | Rules with alerts |
| `TotalAlertCount` | integer | Total findings |
| `UserName` | string | Account that started the scan |
| `StartTime` | string (date-time) | Scan start |
| `EndTime` | string (date-time) | Scan end |
| `Rules` | array | Per-rule results |

Each rule: `RuleId`, `RuleName`, `RuleStatus` (RulePassed/RuleFailed/RuleNotRun/RuleTimedOut), `AlertsCount`, `Alerts`.

Each alert: `AlertId`, `AlertName`, `Description`, `Mitigation`, `Risk` (0=Informational, 1=Low, 2=Medium, 3=High), `RuleId`, `LearnMoreLink` (string[]).

---

## Common error catalogue

These error codes appear in the service response body and are included in the stderr message when a script exits with code `1`. The exception is `Z003`, which `start-deep-scan.js` handles gracefully as exit `0` with `{ "status": "already-running" }`. Map the codes below to friendly messages before showing them to the user.

| Code   | Meaning                                                              | Exit code | Friendly message |
|--------|----------------------------------------------------------------------|-----------|------------------|
| `A001` | Site does not exist                                                  | `1`       | "I could not find that site in this environment." |
| `A009` | Service-side failure                                                 | `1`       | "Something went wrong on the service side. Try again in a few minutes." |
| `A010` | Required value is missing or empty                                   | `1`       | "Some required value was missing — try again or pick the site again." |
| `A019` | Site id is not a valid identifier                                    | `1`       | "The site identifier is not in the right format." |
| `A033` | Tenant mismatch                                                      | `1`       | "The signed-in account does not belong to the same tenant as the site." |
| `D004` | Caller is not authorized                                             | `1`       | "Your account does not have permission to run this. Ask an admin." |
| `Z003` | Scan already running                                                 | `0`       | "A scan is already running for this site. I will reuse that one." |

When `website.js --websiteId` returns `null`, the skill stops with a local error before any consumer script runs — the consumer scripts never see the websiteId.

## Operating notes

- The site must be running **Power Pages Core version 1.0.2403.84 or later** for scan features to be available.
- The scan is rate-limited per site. Running two starts in quick succession returns `Z003`; treat that as a normal "already running" outcome.
- When the scan finishes, the service sends an email notification to the admin. The report summary is available in the Security workspace and can be downloaded as a PDF. Report summaries are supported in English (US) only.
- Trial sites may have limited scan availability. Surface any limitations as an `info` finding rather than an error.
- Resolution is a single admin-API call during Phase 1. The rest of the workflow uses the cached portalId, so adding more scan steps later does not multiply the lookup cost.
