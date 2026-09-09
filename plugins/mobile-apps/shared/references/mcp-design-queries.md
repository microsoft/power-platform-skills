# MCP Design Queries

Optional Microsoft Learn query templates for a supplied Microsoft-platform brand
source or an unresolved platform-schema question. Load only the matching section
when that input mode needs it. No-brand design and ordinary Tamagui composition
do not run enrichment queries.

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
1. Query Microsoft Learn with the one relevant template only when needed
2. Parse response for token values, schema info, or validation rules
3. Apply to the current extraction/generation step
4. If MCP unavailable, use the applicable official documentation link or report the unresolved fact
5. If results are empty, do not invent schema or substitute unrelated cached values
6. If articles conflict, use the applicable product/version contract rather than publication date alone
```

## Caching policy

- Reuse already-verified values and citations for the same source/product version.
- If caching is useful, keep it project-local and record provenance; never rewrite
  the installed plugin's reference files as a per-project cache.
- Refresh only when the selected source or required platform contract changes.

## Cost

No query cost on the ordinary no-import design path. Keep optional lookups bounded
to the unresolved source fact instead of loading every query set.
