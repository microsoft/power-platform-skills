# Shared Plan Artifact

Project the validated shared PlanModel fields into `[working directory]/canvas-app-shared.md`. Include only cross-screen contracts and shared values.

## Shared Plan

```markdown
# Canvas App Shared Plan

## Aesthetic Direction

- Palette: [description]
- Primary background: RGBA([...])
- Accent: RGBA([...])
- Text primary: RGBA([...])
- Text secondary: RGBA([...])
- Typography: [scale and weights]

## Visual Contract

- Type roles: [exact title, section-heading, body, caption sizes and weights]
- Spacing scale: [approved gap and padding values]
- Surfaces: [page, panel, card, border, and shadow treatment]
- Actions: [exact primary, secondary, destructive, and disabled treatment]
- Density: [desktop, tablet, and phone composition rules]

## Layout Strategy

[Named policies from `${PLUGIN_ROOT}/references/LayoutPolicies.md` plus target-device rationale.
Record breakpoint formulas and the narrowest supported local/root rendered width. Do not
restate policy arithmetic. Do not equate `App.Width` with an embedded or letterboxed
viewport.]


## Named State

[Variables, named formulas, collections, and ownership]

## Control Naming

[Standard control-type abbreviations followed by the per-screen namespace, such as
`conDiscNavBar` and `btnDetailBack`, plus the rule that repeated UI blocks are
instantiated under each screen's own namespace]

## Cross-Screen Contracts

[Navigation targets and shared state expectations. For repeated navigation blocks, list
the exact items in order and prohibit extra screen-specific children. Use ModernButtons
for cross-screen navigation; reserve ModernTabList for panels within one screen.]

## YAML Conventions

- Formula prefix
- Multi-line formula syntax
- String and record-literal quoting
- Enum escaping
- App-specific conventions
```
