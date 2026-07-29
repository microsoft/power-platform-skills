# Scan Code — Commands

Reference for the helper scripts under `scripts/`. All scripts output JSON to stdout and support `--help`.

## Table of contents

- [`check-tools.js`](#check-toolsjs)
- [`run-opengrep.js`](#run-opengrepjs)
- [`run-trivy.js`](#run-trivyjs)
- [`transform-scan-code.js`](#transform-scan-codejs)

---

## `check-tools.js`

Checks whether opengrep and trivy are installed and returns their versions.

```bash
node "${PLUGIN_ROOT}/skills/scan-code/scripts/check-tools.js"
```

Exit 0 = both available. Exit 1 = at least one missing. If missing, tell the user and stop.

---

## `run-opengrep.js`

Runs opengrep static analysis and emits the tool's **raw** JSON to stdout. Use `transform-scan-code.js` to normalize.

```bash
node "${PLUGIN_ROOT}/skills/scan-code/scripts/run-opengrep.js" --projectRoot "<project-root>"
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--projectRoot` | Yes | — | Directory to scan. Must be a Power Pages site project root (`powerpages.config.json` or `.powerpages-site/`); any other directory is refused with exit 1. |
| `--rulesets` | No | `p/default,p/owasp-top-ten` | Comma-separated list of rulesets. Accepts registry packs and local paths. |
| `--include` | No | — | Optional glob narrowing the file set. |

### Response (stdout)

Raw opengrep JSON — the same shape opengrep produces on the command line. Pass the captured stdout to `transform-scan-code.js --opengrepFile` to convert it to the unified findings shape.

---

## `run-trivy.js`

Runs trivy dependency/secret/license scanning and emits the tool's **raw** JSON to stdout. Use `transform-scan-code.js` to normalize.

```bash
node "${PLUGIN_ROOT}/skills/scan-code/scripts/run-trivy.js" --projectRoot "<project-root>"
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--projectRoot` | Yes | — | Directory to scan. Must be a Power Pages site project root (`powerpages.config.json` or `.powerpages-site/`); any other directory is refused with exit 1. |
| `--severity` | No | `LOW,MEDIUM,HIGH,CRITICAL` | Severity floor for vulnerability findings. |
| `--scanners` | No | `vuln,secret,license` | Comma-separated scanner list. |
| `--secretConfig` | No | Auto-detected | Path to custom secret rules file. Auto-detects `trivy-secret.yaml` in the project root. |
| `--ignoreFile` | No | Auto-detected | Path to ignore file. Auto-detects `.trivyignore.yaml` or `.trivyignore` in the project root. |
| `--trivyConfig` | No | Auto-detected | Path to config file. Auto-detects `trivy.yaml` in the project root. |
| `--no-licenseFull` | No | — | Disable source-level license scanning for faster runs. |

### Response (stdout)

Raw trivy JSON — the same shape trivy produces on the command line. Pass the captured stdout to `transform-scan-code.js --trivyFile` to convert it to the unified findings shape.

---

## `transform-scan-code.js`

Reads raw opengrep and/or trivy JSON and emits the unified findings shape.

```bash
node "${PLUGIN_ROOT}/skills/scan-code/scripts/transform-scan-code.js" \
  --opengrepFile "<opengrep-file>" \
  --trivyFile "<trivy-file>" \
  --projectRoot "<project-root>"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--opengrepFile` | At least one of these two | Path to raw opengrep JSON output. |
| `--trivyFile` | At least one of these two | Path to raw trivy JSON output. |
| `--projectRoot` | No | Project root used to relativize file paths in `location`. |

### Response (stdout)

```json
{ "status": "ok", "findings": [ ] }
```

Each finding: `{ id, severity, category?, confidence?, title, tag, location, details, fix? }`. `severity` is one of `critical|high|warning|medium|info|low|pass`. `category` is one of `vulnerability|secret|license` (trivy) or the opengrep rule category. `confidence` is opengrep-only.
