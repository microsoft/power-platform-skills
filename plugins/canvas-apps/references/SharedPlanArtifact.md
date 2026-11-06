# Shared Plan Artifact

Project the validated shared PlanModel fields into `[working directory]/canvas-app-shared.md`. Include only cross-screen contracts and shared values.

Follow `${PLUGIN_ROOT}/references/PlanModel.md` for exact-syntax boundaries. Shared interfaces need stable names, types, ownership, and producer/consumer expectations; this file is not a recipe for each screen's local formulas or geometry.

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
Record shared breakpoint contracts, preserved layout constraints, and the narrowest supported local/root rendered width when known; builders choose file-local sizing and prove final budgets. Do not
restate policy arithmetic. Do not equate `App.Width` with an embedded or letterboxed
viewport.]

## Imagery

### Asset Pool

| Asset ID | Title                                        | Concrete URL or media asset name | Intended use                   |
| -------- | -------------------------------------------- | -------------------------------- | ------------------------------ |
| [img-01] | [search result title or existing media name] | [https://... or media name]      | [hero/card/background purpose] |

[Include only assets required by approved new or changed imagery, discovered before their component specifications. Preserve existing assignments outside the delta. Write "None" when no imagery changes are required; there is no minimum asset quota.]

### Screen Assignments

| Screen           | Target control or purpose                   | Asset ID | Fit/crop intent               | Accessible label                 |
| ---------------- | ------------------------------------------- | -------- | ----------------------------- | -------------------------------- |
| [Logical screen] | [hero, card, thumbnail, avatar, background] | [img-01] | [Fit/Fill and focal guidance] | [meaningful label or decorative] |

## Named State

[Stable variable, named-formula, collection and field names; data types; owners; producers/consumers; initialization/reset semantics; and exact shared interface bindings]

For EDIT, include only affected shared contracts: canonical filter values and typed semantics, state producers/consumers, navigation return context, record-bound feedback and reset behavior. For affected lists, record source class, justified maximum or unknown, invariant and invalidation conditions. Reconcile with actual initialization and growth operations; never use a seed count as a cap. Preserve existing contracts outside the approved delta.

## Control Naming

[Preserve existing names unless a rename/migration is approved. For new controls, use standard control-type abbreviations followed by the per-screen namespace, such as
`conDiscNavBar` and `btnDetailBack`, plus the rule that repeated UI blocks are
instantiated under each screen's own namespace]

## Cross-Screen Contracts

[Exact navigation targets, shared state/interface names and types, dependencies, and return-context contracts. For new repeated navigation blocks, list the required destinations/order and shared visual behavior; builders own local child structure. Preserve existing control families and navigation bindings unless their change is approved. Prefer ModernButtons for new cross-screen navigation; reserve newly introduced ModernTabList controls for panels within one screen.]

## YAML Conventions

- Formula prefix
- Multi-line formula syntax
- String and record-literal quoting
- Enum escaping
- App-specific conventions
```
