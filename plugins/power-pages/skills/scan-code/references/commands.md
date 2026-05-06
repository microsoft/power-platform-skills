# Scan Code — Commands

Reference for the helper scripts under `scripts/`. Each script is non-interactive, accepts flags only, prints structured JSON, and uses non-zero exit codes for invocation errors only — empty findings still exit zero. All scripts support `--help` to display usage, flags, and exit codes.

## Table of contents

- [`check-tools.js`](#check-toolsjs)
- [`run-opengrep.js`](#run-opengrepjs)
- [`run-trivy.js`](#run-trivyjs)
- [Severity mapping](#severity-mapping)

---

## `check-tools.js`

Detects whether `opengrep` and `trivy` are installed and on `PATH`.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/check-tools.js"
```

| Flag     | Required | Description |
|----------|----------|-------------|
| `--help` | No       | Show usage, flags, and exit codes. |

### Response

```json
{
  "opengrep": { "available": true, "version": "1.50.0", "error": null },
  "trivy":    { "available": false, "version": null, "error": "command not found" }
}
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Both tools available |
| `1`  | At least one tool missing — see `error` field per tool |

### Usage notes

- Run **before any other script** in this skill.
- When a tool is missing, do not attempt to install it. Show the matching install instructions from `references/tool-install.md`.

---

## `run-opengrep.js`

Runs `opengrep scan` against a project directory and writes a normalized findings file.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/run-opengrep.js" \
  --projectRoot <path> \
  --ruleset <ruleset> \
  --output <json-file> \
  [--include <glob>]
```

### Parameters

| Flag           | Required | Default     | Description |
|----------------|----------|-------------|-------------|
| `--projectRoot`| Yes      | —           | Directory to scan. |
| `--ruleset`    | No       | `p/owasp-top-ten` | Opengrep ruleset name or local rules file. Use `p/owasp-top-ten` for basic, `p/security-audit` for advanced. |
| `--output`     | Yes      | —           | Path for the normalized findings JSON. |
| `--include`    | No       | —           | Optional glob narrowing the file set. |
| `--help`       | No       | —           | Show usage, flags, and exit codes. |

### Response (written to `--output`)

```json
{
  "tool": "opengrep",
  "version": "1.50.0",
  "ruleset": "p/owasp-top-ten",
  "scanned": 184,
  "findings": [
    {
      "id": "opengrep-1",
      "severity": "ERROR",
      "title": "Untrusted input passed to dangerouslySetInnerHTML",
      "location": "src/components/PostBody.tsx:42",
      "tag": "javascript.react.security.audit.react-dangerouslysetinnerhtml-rule",
      "details": null
    }
  ]
}
```

### Errors

| Condition | Stderr | Exit |
|-----------|--------|------|
| Missing `--projectRoot` or `--output` | `Usage: …` | `1` |
| Project directory does not exist     | `Project root not found: <path>` | `1` |
| `opengrep --version` fails           | `opengrep is not installed or not on PATH.` | `1` |
| `opengrep scan` exits with status other than 0 or 1 | scan stderr | `1` |
| Output JSON cannot be parsed         | `Failed to parse opengrep JSON: …` | `1` |

`opengrep` exits `1` whenever it produces findings. The script treats this as success (matches the documented behavior) and only fails on other non-zero codes.

### Usage notes

- Output may be very large; the script writes to a file rather than streaming to stdout.
- Always run with `run_in_background: true` for non-trivial projects — large code bases can take minutes.

---

## `run-trivy.js`

Runs `trivy fs` against the project root, scanning for vulnerabilities in dependencies, hard-coded secrets in source files, and license compliance issues. Writes a normalized findings file.

### Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/run-trivy.js" \
  --projectRoot <path> \
  --severity <list> \
  --output <json-file> \
  [--scanners <list>]
```

### Parameters

| Flag           | Required | Default               | Description |
|----------------|----------|-----------------------|-------------|
| `--projectRoot`| Yes      | —                     | Directory to scan. |
| `--severity`   | No       | `HIGH,CRITICAL`       | Severity floor — comma-separated subset of `LOW,MEDIUM,HIGH,CRITICAL,UNKNOWN`. |
| `--scanners`   | No       | `vuln,secret,license` | Comma-separated scanner list. Valid values: `vuln` (dependency vulnerabilities), `secret` (hard-coded secrets), `license` (license compliance). |
| `--output`     | Yes      | —                     | Path for the normalized findings JSON. |
| `--help`       | No       | —                     | Show usage, flags, and exit codes. |

### Response (written to `--output`)

```json
{
  "tool": "trivy",
  "version": "0.52.0",
  "scanners": "vuln,secret,license",
  "severity": "HIGH,CRITICAL",
  "findings": [
    {
      "id": "trivy-1",
      "severity": "HIGH",
      "category": "vulnerability",
      "title": "axios@1.4.0",
      "tag": "GHSA-wf5p-g6vw-rhxx",
      "location": "package-lock.json",
      "details": "Server-Side Request Forgery in axios",
      "fix": "Upgrade axios to 1.6.0"
    },
    {
      "id": "trivy-2",
      "severity": "HIGH",
      "category": "secret",
      "title": "AWS Access Key ID",
      "tag": "aws-access-key-id",
      "location": "src/config.ts:14",
      "details": "AWS",
      "fix": "Remove the secret from source code and rotate it immediately"
    },
    {
      "id": "trivy-3",
      "severity": "LOW",
      "category": "license",
      "title": "some-package: GPL-3.0",
      "tag": "GPL-3.0",
      "location": "package-lock.json",
      "details": "Category: restricted",
      "fix": "Replace this package with one using a permissive license"
    }
  ]
}
```

Each finding includes a `category` field (`vulnerability`, `secret`, or `license`) so the caller can group and present them separately.

### Errors

| Condition | Stderr | Exit |
|-----------|--------|------|
| Missing `--projectRoot` or `--output` | `Usage: …` | `1` |
| Project directory does not exist     | `Project root not found: <path>` | `1` |
| `trivy --version` fails              | `trivy is not installed or not on PATH.` | `1` |
| Trivy returns non-zero               | trivy stderr | `1` |
| Output JSON cannot be parsed         | `Failed to parse trivy JSON: …` | `1` |

`--exit-code 0` is passed so trivy never returns 1 just because of findings — only invocation errors fail.

### Usage notes

- Trivy refreshes its vulnerability database on first run; allow a few minutes the first time.
- An empty `findings` array is a normal outcome — it does not mean the scan failed.
- Secret findings include the file and line number in `location` — never echo the secret value itself.

---

## Severity mapping

When merging findings across tools into the unified report, use this mapping (also defined in the SKILL.md):

| Unified bucket | opengrep severity | trivy severity |
|----------------|-------------------|----------------|
| `critical`     | `ERROR`           | `CRITICAL`     |
| `warning`      | `WARNING`         | `HIGH`         |
| `info`         | `INFO`            | `MEDIUM`, `LOW`, `UNKNOWN` |

The HTML template renders `critical`, `warning`, `info`, and `pass` consistently across all scan reports.
