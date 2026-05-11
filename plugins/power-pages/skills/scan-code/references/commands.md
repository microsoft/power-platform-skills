# Scan Code — Commands

Reference for the helper scripts under `scripts/`. All scripts output JSON to stdout and support `--help`.

## Table of contents

- [`check-tools.js`](#check-toolsjs)
- [`run-opengrep.js`](#run-opengrepjs)
- [`run-trivy.js`](#run-trivyjs)

---

## `check-tools.js`

Checks whether opengrep and trivy are installed and returns their versions.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/check-tools.js"
```

Exit 0 = both available. Exit 1 = at least one missing. If missing, tell the user and stop.

---

## `run-opengrep.js`

Runs opengrep static analysis and outputs normalized findings.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/run-opengrep.js" --projectRoot "<path>"
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--projectRoot` | Yes | — | Directory to scan. |
| `--rulesets` | No | `p/default,p/owasp-top-ten` | Comma-separated list of rulesets. Accepts registry packs and local paths. |
| `--include` | No | — | Optional glob narrowing the file set. |

### Response (stdout)

```json
{ "status": "ok", "tool": "opengrep", "version": "<version>", "rulesets": [...], "findings": [ ] }
```

Each finding: `{ id, severity, title, location, tag, details }`. Severity values come from the tool output directly.

---

## `run-trivy.js`

Runs trivy dependency/secret/license scanning and outputs normalized findings.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/run-trivy.js" --projectRoot "<path>"
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--projectRoot` | Yes | — | Directory to scan. |
| `--severity` | No | `LOW,MEDIUM,HIGH,CRITICAL` | Severity floor for vulnerability findings. |
| `--scanners` | No | `vuln,secret,license` | Comma-separated scanner list. |
| `--secretConfig` | No | Auto-detected | Path to custom secret rules file. Auto-detects `trivy-secret.yaml` in the project root. |
| `--ignoreFile` | No | Auto-detected | Path to ignore file. Auto-detects `.trivyignore.yaml` or `.trivyignore` in the project root. |
| `--trivyConfig` | No | Auto-detected | Path to config file. Auto-detects `trivy.yaml` in the project root. |
| `--no-licenseFull` | No | — | Disable source-level license scanning for faster runs. |

### Response (stdout)

```json
{ "status": "ok", "tool": "trivy", "version": "<version>", "findings": [ ] }
```

Each finding: `{ id, severity, category, title, tag, location, details, fix }`. Categories: `vulnerability`, `secret`, `license`. Severity values come from the tool output directly.
