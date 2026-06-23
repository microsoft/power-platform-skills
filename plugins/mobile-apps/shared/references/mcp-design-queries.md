# MCP Design Queries

Reusable MS Learn MCP query templates for design contexts. Used by `/design-system` Sub-step 1.6 (always-on enrichment) and by brand input modes that need schema validation.

---

## Power Pages queries

| Purpose | Query | Expected response |
|---|---|---|
| Variable schema | `"Power Pages Bootstrap variables list default theme"` | List of CSS custom properties Power Pages exposes |
| Default palette | `"Power Pages default theme palette colors"` | Microsoft's published base color values |
| Component classes | `"Power Pages entity-form entity-grid CSS classes structure"` | What `.entity-form`, `.entity-grid`, `.entitylist` represent |
| Typography | `"Power Pages default font family typography settings"` | Font stack and size scale |
| Accessibility | `"Power Pages WCAG accessibility color contrast requirements"` | Contrast ratio requirements for Power Pages sites |
| Best practices | `"Power Pages theming customization best practices"` | Recommended patterns for theme customization |

## Canvas App queries

| Purpose | Query | Expected response |
|---|---|---|
| Theme variables | `"Canvas app theme variable structure Power Fx Set varTheme"` | How `Set(varTheme, {...})` works in `OnStart` |
| Default colors | `"Canvas app default colors theme RGBA"` | Microsoft's default Canvas app color scheme |
| Color functions | `"Power Fx ColorValue RGBA function reference"` | How `ColorValue()` and `RGBA()` map to hex |
| Control properties | `"Canvas app button control Fill Color properties"` | Which properties control appearance per control |

## Fluent UI queries

| Purpose | Query | Expected response |
|---|---|---|
| Brand variants | `"Fluent UI React BrandVariants createLightTheme"` | How to define a brand scale (steps 10-160) |
| Token structure | `"Fluent UI design tokens color typography spacing"` | Token taxonomy and naming convention |
| Semantic colors | `"Fluent UI semantic color tokens meaning"` | What `colorNeutralBackground1` etc. mean semantically |

## Accessibility queries

| Purpose | Query | Expected response |
|---|---|---|
| WCAG AA | `"Power Apps WCAG color contrast guidance AA"` | 4.5:1 for normal text, 3:1 for large text |
| Touch targets | `"Power Apps mobile touch target size accessibility"` | Minimum 44×44pt tap targets |
| Color blindness | `"accessible color palette design color blindness"` | Patterns that work across color vision deficiencies |

## Usage pattern

```
1. Query MS Learn MCP with the relevant template
2. Parse response for token values, schema info, or validation rules
3. Apply to the current extraction/generation step
4. If MCP unavailable → skip silently, no degradation
5. If MCP returns empty → use cached values with date notice
6. If MCP returns conflicting articles → use most recently dated
```

## Caching policy

- Results cached per-project in `shared/references/power-pages-defaults.md` (for Power Pages queries)
- Cache validity: 30 days (after which re-query on next invocation)
- Force refresh: `/design-system --refresh-cache`
- Cache miss: query live, write result, continue

## Cost

~3-8k tokens per project (one-time; cached after first run per query set).
