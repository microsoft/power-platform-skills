# Power Pages Extraction (`--from-url --power-pages-mode` / `--stylesheet --power-pages-mode`)

Extracts palette, typography, and component conventions from a Microsoft Power Pages site.

## Detection

Power Pages sites are detected by:
- URL pattern: `*.powerappsportals.com` or `*.microsoftcrmportals.com`
- HTML marker: `<meta name="generator" content="Microsoft Power Pages">`
- CSS class presence: `.entity-form`, `.entity-grid`, `.entitylist`, `.section`

## Pipeline — URL mode (`--from-url --power-pages-mode`)

```
1. Fetch site HTML (same as generic --from-url: curl HEAD + GET, 10s timeout)
2. Detect Power Pages markers (URL pattern or meta generator tag)
3. Fetch <site>/theme.css from well-known path
4. Fetch <site>/bootstrap.min.css from well-known path
5. Parse Bootstrap variable overrides in theme.css
6. Call MS Learn MCP for schema mapping (Bootstrap vars → our tokens)
7. Cross-validate user theme against MS Learn published Power Pages base
8. Extract component conventions from Power Pages CSS classes
9. Emit ## Design Direction block
```

## Pipeline — Stylesheet mode (`--stylesheet --power-pages-mode`)

```
1. Read CSS file (200 KB cap)
2. Detect Power Pages markers (class patterns: .entity-form, .entity-grid, etc.)
3. Parse Bootstrap variable overrides
4. Parse Power Pages-specific selectors
5. Call MS Learn MCP to interpret class semantics
6. Map customizations to our Component section
7. Populate Negatives with Power Pages conventions
8. Emit ## Design Direction block
```

## Bootstrap variable mapping

| Bootstrap variable | Our token |
|---|---|
| `--bs-primary` | palette.primary |
| `--bs-secondary` | palette.accent |
| `--bs-success` | status.success |
| `--bs-warning` | status.warning |
| `--bs-danger` | status.danger |
| `--bs-info` | status.info |
| `--bs-body-bg` | palette.bg |
| `--bs-body-color` | palette.text |
| `--bs-body-font-family` | typography.body.family |
| `--bs-body-font-size` | typography.body.size |
| `--bs-border-color` | palette.border |
| `--bs-border-radius` | radius policy (infer tight/medium/loose) |
| `--bs-border-radius-lg` | radius.lg |

## Power Pages CSS class mapping

| Power Pages class | Interpretation | Maps to component |
|---|---|---|
| `.entity-form` | Dataverse entity form | Form component spec |
| `.entity-grid` | Dataverse entity list/grid | List component spec |
| `.entitylist` | Entity list container | List row patterns |
| `.section` | Page section wrapper | Card / section spacing |
| `.btn-primary` | Primary action button | Button primary variant |
| `.panel` / `.card` | Content container | Card component spec |

## MS Learn MCP queries

| Query | Purpose |
|---|---|
| `"Power Pages Bootstrap variables list"` | Get official variable schema |
| `"Power Pages default theme palette"` | Compare user overrides against Microsoft baseline |
| `"Power Pages entity-form CSS classes"` | Interpret what extracted classes represent |
| `"Power Pages theming customization best practices"` | Populate References section |
| `"Power Apps WCAG color contrast guidance"` | Validate extracted palette pairs |

## Negatives auto-populated from Power Pages conventions

When Power Pages mode detects standard patterns, auto-populate Negatives:

```markdown
## Negatives (Power Pages conventions)
- ✗ No border-radius > 8px (Bootstrap standard)
- ✗ No flat buttons without borders (accessibility requirement)
- ✗ No custom scrollbars (Power Pages uses native)
- ✗ No fixed headers (Power Pages uses sticky with JS)
```

These are soft defaults — user can override at the confirmation gate.

## Bootstrap version handling

Power Pages sites may use Bootstrap v4 or v5:

| Version | Detection | Variable prefix |
|---|---|---|
| v4 | `bootstrap.min.css` contains `--blue`, `--primary` (no `bs-` prefix) | `--primary` |
| v5 | `bootstrap.min.css` contains `--bs-primary` | `--bs-primary` |

If version mismatch between what MCP returns and what we detect → ask MCP for the correct version documentation, retry once.

## Failure modes

| Condition | Action |
|---|---|
| Power Pages site requires auth | STOP — ask for `--stylesheet` with exported theme |
| Site on private VNet | STOP — suggest `--stylesheet` |
| `theme.css` returns 404 | Fall back to generic `--from-url` with warning |
| Bootstrap version mismatch | Ask MCP for correct version, retry once |
| Stylesheet has no Power Pages markers | Fall back to generic `--stylesheet` mode with warning |
| MS Learn MCP unavailable | Skip enrichment, parse CSS variables directly |

## Cost

~8-10k tokens (CSS parse + MCP schema lookup).
