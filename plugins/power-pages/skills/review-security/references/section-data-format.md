# Section Data Format

Every JSON file under `.security-review-tmp/<skill-name>.json` follows the same shape so the master report can render them uniformly.

## Top-level shape

```json
{
  "id": "code-scan",
  "label": "Code & Packages",
  "icon": "▦",
  "description": "<one-sentence plain-language description>",
  "findings": [ <findingObj>, ... ],
  "details": { ... }
}
```

| Key | Required | Description |
|-----|----------|-------------|
| `id` | Yes | Stable identifier used by the master template's sidebar — kebab-case. |
| `label` | Yes | Plain-language label shown in the sidebar (e.g., "Browser headers"). |
| `icon` | No | One-character glyph for the sidebar; defaults to `▦`. |
| `description` | No | One short sentence shown under the section title. |
| `findings` | Yes | Array of finding objects (see below). May be empty. |
| `details` | No | Optional details block — table, key-value, or raw HTML. |

A sub-skill that fails or is skipped writes:

```json
{ "status": "skipped", "reason": "<plain-language reason>" }
```

The orchestrator translates that into a single `info` finding for the section.

## Finding object

```json
{
  "id": "code-scan-1",
  "severity": "critical|warning|info|pass",
  "title": "<short, plain-language title>",
  "tag": "<optional rule id, advisory id, or setting name>",
  "location": "<optional file:line / url / setting name>",
  "details": "<optional one-sentence detail>",
  "reasoning": "<plain-language explanation of why this matters>",
  "fix": "<optional concrete fix instruction>"
}
```

Severity buckets used by the master report:

| Bucket | Meaning |
|--------|---------|
| `critical` | Must be addressed before publishing or shortly after. |
| `warning`  | Should be fixed but not blocking. |
| `info`     | Worth knowing — improvements or context. |
| `pass`     | A check that passed cleanly. Surface a few of these so the report does not look unbalanced. |

Each sub-skill is responsible for translating its native severity values into this bucket set before writing the file.

## Details block

Three shapes are supported:

### Table

```json
{
  "kind": "table",
  "label": "Settings",
  "columns": ["Setting", "Current", "Recommended", "Status"],
  "rows": [
    ["HTTP/Content-Security-Policy", "default-src 'self'", "Configured", "pass"],
    ["HTTP/X-Frame-Options", null, "SAMEORIGIN", "critical"]
  ]
}
```

### Key/value

```json
{
  "kind": "kv",
  "label": "Scan details",
  "entries": [
    { "key": "Score", "value": "82 / 100" },
    { "key": "Pages checked", "value": "117" }
  ]
}
```

### Raw HTML (use sparingly)

```json
{
  "kind": "html",
  "label": "Endpoint coverage",
  "html": "<p>...</p>"
}
```

Only use the `html` kind when the skill genuinely needs a custom structure — keep markup minimal so it inherits the shared template's typography.
