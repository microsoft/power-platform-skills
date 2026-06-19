# Scan Site — Commands

Reference for the helper scripts under `scripts/`. Every script is non-interactive, accepts flags only, and prints a JSON object on stdout. All scripts support `--help` to display usage, flags, examples, and exit codes. The first stage is always context resolution from the shared `power-platform-api` client, so every script can fail with exit code `2` ("sign-in required") before doing any work.

## Shared exit codes

Every script in this skill can exit with the following codes. Script-specific codes are documented in their own sections.

| Code | Meaning |
|------|---------|
| `0`  | Success. For `website.js`, a `null` response is still exit code 0 — the caller decides how to handle it. For `start-deep-scan.js`, a scan-already-running outcome (`Z003` / HTTP 204) is also exit 0 with `{ "status": "already-running" }`. |
| `1`  | General failure. Covers service errors, bad requests, authorization failures, and any other non-success response. The error message on stderr contains the HTTP status code and service error code. |
| `2`  | Sign-in required. Fix with `pac auth create` or `az login`. |
| `3`  | Polling timed out (`poll-deep-scan.js` only). |

## Table of contents

- [Identifiers — websiteId vs. portalId](#identifiers--websiteid-vs-portalid)
- [Resolving the website — `website.js`](#resolving-the-website--websitejs)
- [`start-deep-scan.js`](#start-deep-scanjs)
- [`poll-deep-scan.js`](#poll-deep-scanjs)
- [`get-latest-report.js`](#get-latest-reportjs)
- [`transform-report.js`](#transform-reportjs)
- [Common error catalogue](#common-error-catalogue)
- [Operating notes](#operating-notes)

---

## Identifiers — websiteId vs. portalId

Two different GUIDs identify a Power Pages site. Keep them straight:

| Identifier | Where it comes from | What it is |
|------------|---------------------|------------|
| `websiteId` | `.powerpages-site/website.yml` (`id` field), `pac pages list` ("Website Record ID") | Dataverse website record primary key. The user-facing identifier. |
| `portalId` | `Id` field on the `/websites` Power Platform API response | The `{id}` segment in Power Platform API URL paths such as `/websites/{id}/scan/...`. |

These are **not** the same value. The skill resolves `websiteId` → `portalId` once during prerequisites (using `website.js --websiteId <guid>`) and reuses the resolved `portalId` for the rest of the run. The consumer scripts in this folder accept `--portalId` only — they never look up the site themselves.

---

## Resolving the website — `website.js`

The shared `scripts/website.js` resolves a Dataverse `websiteId` (read from `.powerpages-site/website.yml`) to its full website record, which includes the `Id` field — the portalId.

A missing `.powerpages-site/website.yml` means the site has not been deployed yet — direct the user to `/deploy-site`.

### Usage

```bash
node "${PLUGIN_ROOT}/scripts/website.js" --websiteId <guid>
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--websiteId`  | Yes      | Dataverse website record id to resolve. |

The field projection includes `Id`, `Name`, `WebsiteRecordId`, `WebsiteUrl`, `Type`, `status`, `Subdomain`, `SiteVisibility`, `PortalWAFStatus`, `PortalAFDStatus`, and `TrialExpiringInDays`.

### Response (stdout)

A single matching website record (or `null` when no record matches). Pass the `Id` field as `--portalId` to every consumer script in this skill.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success (`null` is also success — caller decides what to do). |
| `2`  | Sign-in required. |
| `1`  | Service error. |

---

## `start-deep-scan.js`

Triggers an asynchronous deep scan. The service runs the scan in the background; use `poll-deep-scan.js` to wait for completion.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/start-deep-scan.js" --portalId <portal-id>
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--portalId`   | Yes      | Power Platform API portalId resolved during prerequisites |

### Response (stdout)

```json
{ "status": "started" }
```

…or, when a scan is already running:

```json
{ "status": "already-running" }
```

### Errors

| Status / `code`     | Meaning |
|---------------------|---------|
| `204` or `400 / Z003` | A scan is already running for this site. Treated as success (exit 0). |
| `400 / A019`        | Invalid portalId format. |
| `404 / A001`        | Site not found in this environment. |
| `401 / D004`        | Caller not authorized. |

---

## `poll-deep-scan.js`

Polls the scan-status endpoint until the scan finishes or the timeout elapses.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/poll-deep-scan.js" --portalId <portal-id> [--timeoutMinutes <n>] [--intervalSeconds <n>]
node "${PLUGIN_ROOT}/skills/scan-site/scripts/poll-deep-scan.js" --portalId <portal-id> --once
```

### Parameters

| Flag                  | Required | Default | Description |
|-----------------------|----------|---------|-------------|
| `--portalId`          | Yes      | —       | Power Platform API portalId resolved during prerequisites |
| `--timeoutMinutes`    | No       | `20`    | Maximum time to wait. |
| `--intervalSeconds`   | No       | `60`    | Pause between status checks. |
| `--once`              | No       | —       | Single status check, no polling. Exits 0 with `{ "status": "ongoing" \| "idle" }`. |

### Response (stdout)

Polling mode:

```json
{ "status": "done", "elapsedSeconds": "<count>" }
```

…or, when the timeout passes:

```json
{ "status": "timeout", "elapsedSeconds": "<count>" }
```

Single-shot (`--once`) mode:

```json
{ "status": "<ongoing|idle>" }
```

The script also accepts `"true"` (string) and `1` (integer) as truthy variants of the status field. See `scan-reference.md` § "Scan progress" for the endpoint shape.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Scan finished. |
| `3`  | Timeout. |
| `2`  | Sign-in required. |
| `1`  | Service error. |

### Notes

- Run with `run_in_background: true` so the user can keep working.
- Progress lines are written to **stderr** every minute for monitoring; they are not user-facing.

---

## `get-latest-report.js`

Fetches the latest completed deep-scan report. Outputs the full report JSON to stdout.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/get-latest-report.js" --portalId <portal-id>
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--portalId`   | Yes      | Power Platform API portalId resolved during prerequisites |

### Response (stdout)

On success:

```json
{ "status": "ok", "body": { /* deep-scan report */ } }
```

When no scan has completed yet (HTTP 204 / `Z003`):

```json
{ "status": "empty" }
```

Treat `empty` as an `info` finding rather than an error.

See `scan-reference.md` for the full field-level schema of the report body.

### Errors

| Status / `code`     | Meaning |
|---------------------|---------|
| `204`               | No completed scan exists yet — a scan may be running. Returns `{ "status": "empty" }` (exit 0). |
| `400 / A001`        | Site not found. |
| `400 / A010`        | Invalid input. |
| `500 / A009`        | Service-side failure. |

---

## `transform-report.js`

Transforms a deep-scan report into the unified findings shape used by the consolidated security review.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/transform-report.js" --portalId <portal-id>
node "${PLUGIN_ROOT}/skills/scan-site/scripts/transform-report.js" --reportFile <report-file>
```

### Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--portalId` | One of the two | Power Platform API portalId. Fetches the latest report directly. |
| `--reportFile` | One of the two | Path to a previously saved raw report JSON. Skips the API call. |

### Response (stdout)

Normal report:

```json
{ "status": "ok", "findings": [ ], "details": { "kind": "kv", "label": "Scan details", "entries": [ ] } }
```

No completed scan exists for this site (fresh site, or current scan still running). The script emits a single `info` finding so review-mode output never produces an empty section:

```json
{ "status": "empty", "findings": [{ "id": "scan-site-empty", "severity": "info", "title": "No completed scan report available", "details": "..." }], "details": {} }
```

API returned a response missing the `Rules` array — the report cannot be parsed. The script emits a single `warning` finding so the orchestrator can surface the failure:

```json
{ "status": "malformed", "findings": [{ "id": "scan-site-malformed", "severity": "warning", "title": "Scan report could not be parsed", "details": "..." }], "details": {} }
```

Each finding: `{ id, severity, category?, title, tag, location?, details, fix? }`. See `scan-reference.md` § "Severity mapping" for how `Risk` and `RuleStatus` map to `severity`.

---

## Common error catalogue

These error codes appear in service responses. Map them to friendly messages before showing them to the user.

| Code   | Meaning                               | Exit code | Friendly message |
|--------|---------------------------------------|-----------|------------------|
| `A001` | Site does not exist                   | `1`       | "I could not find that site in this environment." |
| `A009` | Service-side failure                  | `1`       | "Something went wrong on the service side. Try again in a few minutes." |
| `A010` | Required value is missing or empty    | `1`       | "Some required value was missing — try again or pick the site again." |
| `A019` | Site id is not a valid identifier     | `1`       | "The site identifier is not in the right format." |
| `A033` | Tenant mismatch                       | `1`       | "The signed-in account does not belong to the same tenant as the site." |
| `D004` | Caller is not authorized              | `1`       | "Your account does not have permission to run this. Ask an admin." |
| `Z003` | Scan already running                  | `0`       | "A scan is already running for this site." |

When `website.js --websiteId` returns `null`, the skill stops with a local error before any consumer script runs.

## Operating notes

- Only one scan per site at a time. Running two starts in quick succession returns `Z003`; treat that as a normal "already running" outcome.
- When the scan finishes, the service sends an email notification to the admin. The report summary is also available in the Security workspace and can be downloaded as a PDF. Report summaries are supported in English (US) only.
- Resolution is a single Power Platform API call during prerequisites. The rest of the workflow uses the cached portalId.
