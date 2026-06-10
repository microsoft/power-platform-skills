# Manage Web Application Firewall — Commands

Reference for the helper scripts under `scripts/`. All scripts use the shared power-platform-api client, share the same authentication failure mode (exit code `2`), and support `--help` to display usage, flags, and exit codes.

## Table of contents

- [Identifiers — websiteId vs. portalId](#identifiers--websiteid-vs-portalid)
- [`get-status.js`](#get-statusjs)
- [`get-rules.js`](#get-rulesjs)
- [`enable.js`](#enablejs)
- [`disable.js`](#disablejs)
- [`set-rules.js`](#set-rulesjs)
- [`delete-rules.js`](#delete-rulesjs)
- [`transform-firewall.js`](#transform-firewalljs)
- [Common error catalogue](#common-error-catalogue)
- [Body schema](#body-schema)

---

## Identifiers — websiteId vs. portalId

Two different GUIDs identify a Power Pages site:

| Identifier | Where it comes from | What it is |
|------------|---------------------|------------|
| `websiteId` | `.powerpages-site/website.yml` (`id` field), `pac pages list` ("Website Record ID") | Dataverse website record primary key. The user-facing identifier. |
| `portalId` | `Id` field on the `/websites` Power Platform API response | The `{id}` segment in Power Platform API URL paths such as `/websites/{id}/enableWaf`. |

The skill resolves `websiteId` → `portalId` once during prerequisites by reading `.powerpages-site/website.yml` and calling `${PLUGIN_ROOT}/scripts/website.js --websiteId <guid>`. It reuses the resolved `portalId` for the rest of the run. The consumer scripts in this folder accept `--portalId` only — they never look up the site themselves.

If `.powerpages-site/website.yml` does not exist, the site has not been deployed yet. The skill does **not** try to identify the site by name or URL (two sites in the same environment can share a name, and the URL changes when the subdomain is updated) — it directs the user to `/deploy-site` and stops.

Run `node "${PLUGIN_ROOT}/scripts/website.js" --help` for the full contract.

---

## `get-status.js`

Returns the current firewall status (None/ Enabling / Created / Disabled / Disabling / Failed). **Only `Created` indicates the firewall is active/ enabled**.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/manage-firewall/scripts/get-status.js" --portalId <portal-id>
```

### Response (stdout)

```json
{ "status": "ok", "value": "<status>" }
```

…or, when the feature is unavailable for this site:

```json
{ "status": "unsupported", "message": "Power Pages built-in WAF feature is not supported in <region>" }
```

The response JSON is written to stdout.

### Errors

| Status / `code` | Meaning |
|-----------------|---------|
| `400 / B022`    | Region does not offer the firewall |
| `400 / B023`    | Trial site — convert to production first |
| `400 / A001`    | Site not found |

---

## `get-rules.js`

Returns the full firewall configuration (managed rule sets and custom rules).

### Usage

> **Important:** call `get-status.js` first and only invoke this script when the WAF is enabled (i.e. `Created`). When `get-status.js` returns `Disabled`, `None`, or `Failed`, no policy is provisioned and this endpoint will return a 500. Treat that case as "no rules configured" without calling this script.

```bash
node "${PLUGIN_ROOT}/skills/manage-firewall/scripts/get-rules.js" --portalId <portal-id> [--ruleType <name>]
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--portalId`   | Yes      | Power Platform API portalId resolved during prerequisites |
| `--ruleType`   | No       | Optional filter — `Custom` or `Managed`. Omit for both. |

### Response (stdout)

```json
{ "status": "ok", "body": { "CustomRules": [...], "ManagedRules": [...] } }
```

---

## `enable.js`

Turns the firewall on. The underlying operation is asynchronous — the script polls the status endpoint until the value becomes `Created` (the only "enabled" terminal state — see [`get-status.js`](#get-statusjs)) or the timeout elapses.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/manage-firewall/scripts/enable.js" --portalId <portal-id> [--timeoutMinutes <n>]
```

### Parameters

| Flag                  | Required | Default | Description |
|-----------------------|----------|---------|-------------|
| `--portalId`          | Yes      | —       | Power Platform API portalId resolved during prerequisites |
| `--timeoutMinutes`    | No       | `15`    | Maximum time to wait for the operation to complete. |

### Response (stdout)

```json
{ "status": "enabled", "attempts": "<count>" }
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

Mirror of `enable.js` — turns the firewall off and polls until status is `Disabled`. Same parameters and exit codes; stdout reports `{ "status": "disabled", "attempts": "<count>" }`.

---

## `set-rules.js`

Creates or updates firewall rules. Send only the rules being added or modified. Existing rules not included in the payload are left untouched.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/manage-firewall/scripts/set-rules.js" --portalId <portal-id> --data-inline '<json>'
```

### Parameters

| Flag             | Required | Description |
|------------------|----------|-------------|
| `--portalId`     | Yes      | Power Platform API portalId resolved during prerequisites |
| `--data-inline`  | Yes      | JSON string with `CustomRules` and/or `ManagedRules` arrays. |

### Payload shape

The JSON MUST be an object with `CustomRules` and/or `ManagedRules` arrays. Do NOT pass a bare array.

Both arrays are optional — omit one to leave that part of the configuration untouched. Within each array, include only the rules being created or updated; existing rules not in the payload are preserved by the service.

See `rule-reference.md` for the full field-level schema: custom rules, match conditions, managed rule sets, and rule group overrides.

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
| `409 / B003`    | Another operation is in progress — wait and retry after the in-flight operation completes |
| `0` (no response) | Request timed out — retry after a delay |

---

## `delete-rules.js`

Deletes one or more **custom** rules by name. Managed rule sets are not affected.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/manage-firewall/scripts/delete-rules.js" --portalId <portal-id> --names <name1,name2,...>
```

### Response (stdout)

```json
{ "status": "accepted", "deleted": ["<rule-name>"] }
```

The deletion is asynchronous; the response is `202 Accepted`. To confirm the change, re-run `get-rules.js` after a short delay.

---

## `transform-firewall.js`

Transforms `get-status.js` and `get-rules.js` stdout into the unified findings shape used by the consolidated security review. Read-only — does not call the service.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/manage-firewall/scripts/transform-firewall.js" --statusFile <status-file> --rulesFile <rules-file>
```

### Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--statusFile` | Yes | Path to a saved `get-status.js` stdout JSON file. |
| `--rulesFile` | Yes | Path to a saved `get-rules.js` stdout JSON file. |

### Response (stdout)

```json
{ "status": "ok", "findings": [ ] }
```

…or, when the firewall is not available for the site:

```json
{ "status": "unsupported", "findings": [ ] }
```

Each finding has the inventory shape `{ id, title, tag, details }` — no `severity` (the section is informational; the orchestrator does not roll these up into severity totals).

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
| `B001` | `1`         | Edge infrastructure not provisioned                                   | "The site does not have the front-door routing required for the firewall." |
| `B003` | `1` *       | Another WAF operation in progress                                     | "Your last change is still being applied. I will wait and check again shortly." |
| `B022` | `4` **      | Region not supported                                                  | "The firewall feature is not available in your region yet." |
| `B023` | `4` **      | Trial portal — production required                                    | "Your site needs to be a production site before you can turn on the firewall." |
| `D004` | `1`         | Caller not authorized                                                 | "Your account does not have permission for this. Ask an admin." |

\* `B003` handling varies by script. `enable.js` and `disable.js` treat 409/B003 as "wait and poll" (no hard failure — the script continues to poll status until the in-flight operation settles). Other scripts (including `set-rules.js` and `delete-rules.js`) exit `1` — should wait and retry manually.

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

When `website.js --websiteId` returns `null` during prerequisites, the skill stops with a local error before any consumer script runs.

---

## Body schema

> **Case sensitivity:** custom rule fields use **camelCase**. Managed rule fields use **PascalCase**.

See `rule-reference.md` for the full field-level schema: custom rules, match conditions, managed rule sets, and rule group overrides.
