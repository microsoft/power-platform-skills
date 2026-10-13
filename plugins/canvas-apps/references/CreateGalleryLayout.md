# CREATE Galleries and Record Surfaces

Describe Gallery and its chosen children before writing properties. Preserve the composition's record fields and action priorities; a repeating layout is not permission to flatten a requested relationship or visualization.

## Dataset bounds

Discovery classifies each list source as fixed mock, mutable local, or live/unbounded. Record an exact proposed/evidenced maximum only with its justification, source/subset invariants and invalidating changes; otherwise use unknown. A unique subset of an immutable six-record source cannot exceed six only while uniqueness and source immutability hold. A seed count is not a maximum if create/import or other operations can grow the source.

The coordinator reconciles those bounds with initialization and every growing operation, then carries them into bindings and affected assignments. Never truncate matching records, invent a display cap or drop requested actions to fit a layout. Do not treat an evidenced fixed source as unbounded either. Missing/invalidated bounds used by the approved layout go back for targeted discovery/layout reconciliation; unknown or growing sources need a supported scrolling/paging strategy.

## Viewport and row are different budgets

`QACHK-HIDDEN-BOUNDED-LIST`: give a list-driven Gallery a conservative bounded numeric Height, positive TemplateSize, numeric TemplatePadding, bound Items and meaningful row children. Do not combine `CountRows(...)` with `Self.TemplateHeight`, `Self.TemplateSize` or `Self.TemplatePadding` to derive viewport Height. Never drive Height or empty-state visibility from lazy `AllItems`/`AllItemsCount`; zero materialized rows can trap a populated gallery at zero height. Use the canonical filtered source for empty state and a supported reset-to-top path when entry could retain an internal scroll offset.

Resolve page-only scrolling versus a bounded list viewport in discovery; do not silently add a second scroll owner. If the approved design requires page-only scrolling, use a discovered supported strategy or return the conflict before writing. A bounded Gallery containing more rows than fit scrolls independently even with its scrollbar hidden. When independent list scrolling is approved, provide an obvious affordance, leave room for the first complete record/action and keep required surrounding controls reachable.

The dataset maximum is not automatically the maximum rendered height. Use the approved sizing strategy and actual content budget, not the cap as justification for permanent empty space. A bound does not authorize unsupported dynamic height or a change of scroll owner.

Size the containing section for its headings/status plus the gallery viewport, gaps and padding, or give that section deliberate independent scrolling. A 440px gallery inside a default-height 200px non-scrolling section cannot become reachable merely because the outer root scrolls.

`QACHK-GALLERY-TEMPLATE-LAYOUT`: gallery templates use local geometry, not AutoLayout flow. Use exactly one direct responsive AutoLayout row shell with supported containment, sized to `Parent.TemplateWidth`/`Parent.TemplateHeight`; move fields/actions inside it without absolute X/Y positioning. Those template outputs belong only to the gallery's direct child. Deeper descendants use supported parent dimensions or AutoLayout sizing, not `Parent.TemplateWidth`. A single full-width control may omit the shell.

`QACHK-GALLERY-ROW-FITS-CONTENT`: evaluate TemplateSize and row content at every reachable branch. A vertical row needs padding + all child/minimum content heights + gaps; a horizontal row needs padding + its tallest child plus wrapping. Include labels, status, action targets, conditional confirmation/receipt regions and any image band. A proportional-fill child still has nonzero content needs.

Use the same deliberate local breakpoint source for template size and row reflow, or evaluate cross-branch combinations. The gallery's Parent.Width and a nested row's Parent.Width can measure different regions. Check desktop as well as narrow layouts; a desktop template can be too short even when the phone branch fits.

## Bound information and actions

- Apply conformance's required-field/action contract to every row. Budget expanded confirmation/receipt states as well as the collapsed row.
- A row event consumes that row's stable identity, not a different Gallery.Selected record. Apply `${PLUGIN_ROOT}/references/CreateMutations.md` when it writes data.
- Provide a contextual AccessibleLabel and `TabIndex: =0` for an interactive Gallery. Use the core's labels/targets rules for descendants.
- Keep empty/unavailable overlays consistent with Items and operation state; they must not cover populated rows.

Use `${PLUGIN_ROOT}/references/CreateConformance.md` for inspection and evidence, including viewport/ancestor and template budgets.
