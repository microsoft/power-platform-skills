# Figma Extraction (`--from-figma`)

Extracts palette, typography, spacing, and component tokens from a Figma file via the REST API.

## Prerequisites

- `FIGMA_TOKEN` environment variable must be set (Personal Access Token or OAuth token)
- File key from the Figma URL: `https://www.figma.com/file/<FILE_KEY>/...`
- Path-safety hook scans for accidental commit of `FIGMA_TOKEN`

## Pipeline

```
1. Validate FIGMA_TOKEN env var exists (STOP with clear error + docs link if missing)
2. Validate file-key format (alphanumeric string)
3. Call GET /v1/files/<file-key>/styles (10s timeout)
4. Call GET /v1/files/<file-key>/variables/local (10s timeout)
5. Extract FILL styles → palette tokens
6. Extract TEXT styles → typography tokens (family, weight, size, lineHeight)
7. Extract EFFECT styles → shadow tokens
8. Extract variable collections → semantic tokens (color/primary/default)
9. Handle variable modes (light/dark/density) — ask user which is canonical
10. Optional: call /v1/images for logo node if --figma-logo-node flag provided
11. Emit ## Design Direction block with provenance
```

## API calls

### Styles endpoint

```
GET https://api.figma.com/v1/files/<file-key>/styles
Headers: X-Figma-Token: <FIGMA_TOKEN>
```

Response contains style metadata. For each style, we need the node to get actual values:

```
GET https://api.figma.com/v1/files/<file-key>/nodes?ids=<style-node-ids>
```

### Variables endpoint

```
GET https://api.figma.com/v1/files/<file-key>/variables/local
Headers: X-Figma-Token: <FIGMA_TOKEN>
```

Returns variable collections with modes and values.

## Style type mapping

| Figma style type | Extraction |
|---|---|
| `FILL` | Color hex from `fills[0].color` (r,g,b → #RRGGBB) |
| `TEXT` | `fontFamily`, `fontWeight`, `fontSize`, `lineHeightPx`, `letterSpacing` |
| `EFFECT` | Shadow: `offset`, `radius`, `color` → elevation token |

## Variable mapping

| Variable collection pattern | Maps to |
|---|---|
| `color/primary/*` | palette.primary scale |
| `color/background/*` | palette.bg / surface ramp |
| `color/text/*` | palette.text / text-muted |
| `color/border/*` | palette.border |
| `color/status/*` | status palette (success/warning/danger/info) |
| `spacing/*` | space tokens |
| `radius/*` | radius policy tokens |
| `typography/*` | font family / size / weight |

## Mode handling

Figma variables support multiple modes (e.g., Light / Dark / High-contrast).

- If single mode → use directly
- If multiple modes → ask user: "Figma file has modes: Light, Dark, High-contrast. Which is your canonical (primary) mode?"
- Default to `Mode 1` (first mode) if user doesn't answer
- Store non-canonical modes as candidates for `--add-dark-mode` later

## Color conversion

Figma uses 0-1 float RGB:
```
{ r: 0.0, g: 0.47, b: 0.83, a: 1.0 } → #0078D4
```

Formula: `Math.round(channel * 255).toString(16).padStart(2, '0')`

Non-sRGB color spaces (Display P3, Lab): convert to sRGB hex with notice.

## Output

```markdown
## Design Direction
source: Figma file <key> (fetched <ISO date>)

## Palette
| Token | Hex | Usage |
| bg | #FFFFFF | from variable color/background/default |
| primary | #0078D4 | from variable color/primary/default |
...

## Typography
| Role | Family | Size | Weight | Line | Tracking |
| Heading | Inter | 24 | 600 | 32 | -0.5 |
...
```

## Rate limiting

- Figma rate limit: 30 requests/minute for Personal Access Tokens
- If 429 response → wait `Retry-After` header seconds (or 60s default), retry once
- If retry also fails → STOP with clear error

## Failure modes

| Condition | Action |
|---|---|
| `FIGMA_TOKEN` not set | STOP with error + link to Figma token docs |
| File key invalid / 403 | STOP — ask user to verify access + file sharing |
| File has 0 published styles AND 0 variables | Suggest Tokens Studio plugin export → use `--design-spec` |
| File uses unpublished local styles only | Extract anyway with warning "using local styles — may drift from team library" |
| Rate limited (429) | Retry once after backoff, else STOP |
| File > 50 MB equivalent (massive component library) | Fetch styles + variables only, skip components |
| Non-sRGB color spaces (P3, Lab) | Convert to sRGB hex with notice |
| Variable modes present | Ask user which is canonical, default Mode 1 |
| Component sets present but design-spec preferred | Surface count, suggest `--design-spec` for richer extraction |

## Cost

~5-10k tokens (REST calls + JSON parse + Sonnet for ambiguous variable namespaces).
