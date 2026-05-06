# Manage HTTP Headers — Commands

Reference for the helper scripts the skill uses. The skill also reuses the shared `create-site-setting.js` helper at the plugin root for writing changes.

## Table of contents

- [`inspect-headers.js`](#inspect-headersjs)
- [`scan-external-urls.js`](#scan-external-urlsjs)
- [`create-site-setting.js`](#create-site-settingjs)
- [Shared exit codes](#shared-exit-codes)

---

## `inspect-headers.js`

Reads every YAML file under `.powerpages-site/site-settings/` and emits a normalized inventory of the security-header-related settings.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-headers/scripts/inspect-headers.js" \
  --projectRoot <path> \
  --output <file>
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--projectRoot`| Yes      | Project root containing `.powerpages-site/`. |
| `--output`     | Yes      | Path for the inventory JSON. |
| `--help`       | No       | Show usage, flags, and exit codes. |

### Response (written to `--output`)

```json
{
  "settings": [
    {
      "name": "HTTP/Content-Security-Policy",
      "value": "script-src 'self' content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn 'nonce'; style-src 'unsafe-inline' https:",
      "filePath": "<projectRoot>/.powerpages-site/site-settings/http-content-security-policy.sitesetting.yml",
      "category": "csp"
    },
    {
      "name": "HTTP/X-Frame-Options",
      "value": "SAMEORIGIN",
      "filePath": "<projectRoot>/.powerpages-site/site-settings/http-x-frame-options.sitesetting.yml",
      "category": "frame"
    }
  ],
  "missing": [
    "HTTP/X-Content-Type-Options"
  ]
}
```

### Stdout summary

On success the script also prints a one-line JSON summary to stdout:

```json
{ "status": "ok", "count": 2, "missing": 1, "output": "<path>" }
```

### Categories

| Category | Settings included |
|----------|--------------------|
| `csp`        | `HTTP/Content-Security-Policy`, `HTTP/Content-Security-Policy-Report-Only` |
| `frame`      | `HTTP/X-Frame-Options` |
| `cors`       | `HTTP/Access-Control-*` (Allow-Origin, Allow-Methods, Allow-Headers, Allow-Credentials, Expose-Headers, Max-Age) |
| `cookie`     | `HTTP/SameSite/*` (Default, per-cookie overrides) |
| `advanced`   | `HTTP/X-Content-Type-Options`, other `HTTP/*` settings |

### Usage notes

- The script ignores YAML files that cannot be parsed and continues — it logs each skipped file to stderr.
- Settings not matching any `HTTP/` prefix are silently excluded.

---

## `scan-external-urls.js`

Scans the project for external URLs referenced in HTML, CSS, and JavaScript. Produces a structured allowlist keyed by CSP directive plus the cloud-agnostic Power-Pages-runtime dependencies. The cloud-specific `content.powerapps.*` host is intentionally omitted — compose it separately after detecting the site's cloud via `pac auth who` (see the cloud host table in `references/header-rules.md`).

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-headers/scripts/scan-external-urls.js" \
  --projectRoot <path> \
  [--exclude <comma-separated directory names>] \
  [--output <file>]
```

### Parameters

| Flag           | Required | Description |
|----------------|----------|-------------|
| `--projectRoot`| Yes      | The code-site directory. |
| `--exclude`    | No       | Extra directory names to skip. Added on top of the default exclusions (`node_modules`, `.git`, `dist`, `build`, `.powerpages-site`, etc.). |
| `--output`     | No       | Write the JSON result to a file instead of stdout. Use on large sites where `bySourceFile` would exceed the agent harness buffer; stdout then prints only a one-line summary pointer with directive counts. |
| `--help`       | No       | Show usage, flags, and exit codes. |

### Response (stdout, default)

```json
{
  "byDirective": {
    "script-src":  ["<hosts>"],
    "style-src":   ["<hosts>"],
    "img-src":     ["<hosts>"],
    "font-src":    ["<hosts>"],
    "connect-src": ["<hosts>"],
    "frame-src":   ["<hosts>"],
    "media-src":   ["<hosts>"],
    "object-src":  ["<hosts>"],
    "form-action": ["<hosts>"]
  },
  "runtimeDependencies": {
    "script-src": ["'self'", "'nonce'"],
    "style-src": ["'self'", "'unsafe-inline'", "https:"],
    "img-src": ["'self'", "data:", "https:"],
    "font-src": ["'self'", "https:", "data:"],
    "connect-src": ["'self'", "https:"],
    "frame-ancestors": ["'self'"]
  },
  "bySourceFile": [
    { "file": "src/components/widget.tsx", "urls": ["https://..."] }
  ]
}
```

### Response (stdout, with `--output`)

```json
{
  "written": "<absolute path>",
  "summary": {
    "byDirectiveCounts": { "<directive>": 3 },
    "totalSourceFiles": 12
  }
}
```

### Usage notes

- Read-only. Walks the project tree, excluding `node_modules`, `.git`, `.powerpages-site`, and similar build directories by default.
- `byDirective` only contains directives for which at least one external host was detected. Directives with no hits are omitted from the object entirely — do not assume all nine keys are present.
- URL extraction is pattern-based and intentionally conservative — dynamic URLs built at runtime from template strings or computed hostnames will not be caught. Review the `bySourceFile` list and cross-check any gaps before promoting a CSP to enforcement.

---

## `create-site-setting.js`

The shared helper at `${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js` creates new site-setting YAML files. Use it for settings that do not already exist. For updating an existing setting's value, edit the YAML file directly (preserving the `id` field).

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot <path> \
  --name "<setting name>" \
  --value "<value>" \
  --description "<short description>"
```

### Behavior

- **Not idempotent** — when a setting with the same name already exists, the script exits with an error. Delete or manually update the existing file before re-running.
- Naming — the filename is derived from the setting name (slashes replaced with hyphens, `.sitesetting.yml` suffix).
- Output — prints `{ "id": "<uuid>", "filePath": "<path>" }` on success.

### Usage notes

The shared helper exits non-zero on validation errors and writes an actionable message to stderr. The skill should record failures per setting and continue with the rest of the accepted changes.

---

## Shared exit codes

`scan-external-urls.js` uses three exit codes (`0`, `1`, `2`). `inspect-headers.js` and `create-site-setting.js` use only `0` and `1` (they exit `1` for both invocation errors and I/O failures).

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | Unknown or I/O failure (file read/write error, YAML parse error, etc.). `inspect-headers.js` and `create-site-setting.js` also use `1` for missing or invalid CLI arguments. |
| `2`  | Invalid or missing CLI arguments (`scan-external-urls.js` only) |
