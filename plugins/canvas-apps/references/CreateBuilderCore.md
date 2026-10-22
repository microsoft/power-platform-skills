# CREATE Implementation Core

Implement the approved composition and bindings; do not redesign or write another plan. This file owns CREATE control authority, YAML syntax and layout defaults. `${PLUGIN_ROOT}/references/CreateConformance.md` owns inspection, repair and reporting. Read each once per valid context.

## Rule ownership

Read only the topic modules needed by the assigned work. Their rules are complete for routine CREATE; do not also read the QAChecks index or legacy versions of the same checks.

| Work | Canonical reference |
|---|---|
| Choices, filters, selection/default/reset behavior | `${PLUGIN_ROOT}/references/CreateSelectionControls.md` |
| Galleries, repeated record surfaces and dataset bounds | `${PLUGIN_ROOT}/references/CreateGalleryLayout.md` |
| Cross-screen context, shared state and derived data; always for the coordinator | `${PLUGIN_ROOT}/references/CreateNavigationState.md` |
| Mutations or persisted-data initialization/restoration | `${PLUGIN_ROOT}/references/CreateMutations.md` |

Conformance routes uncommon features to bounded specialist sections. For an unresolved implementation question, read only the relevant section of `${PLUGIN_ROOT}/references/YamlSyntax.md`, `${PLUGIN_ROOT}/references/ControlGuide.md`, `${PLUGIN_ROOT}/references/LayoutGuide.md` or `${PLUGIN_ROOT}/references/PowerFxGuide.md`. These are technical help, not additional routine QA or legacy artifact prerequisites.

## Control authority

`QACHK-CONTROL-CREATION-KEYWORDS`, `QACHK-MISSING-VARIANT`: call `describe_control` for each selected type before configuration, once per valid context. Copy its complete creation keywords, including version, required `Variant`/`Layout`, component and library identity. Query identities are not necessarily YAML `Control` values. Do not invent or normalize keywords; controls without variants take no invented variant.

Use the direct response for properties, types, enums, defaults and containment. Set only inputs; read only exposed outputs. Respect immediate-child versus descendant restrictions. Slots are not child control types, unresolved internal names are not creation keywords, and empty restrictions do not establish universal nesting support. Discovery summaries and saved snapshots are not metadata authority.

Reuse a fully read description for implementation and repair. Refresh document-dependent descriptions when relevant changes invalidate them; a resumed context must actually retain the response to reuse it. A failed description is a blocker. A missing candidate/resource contract or disproved feasibility goes back through discovery; it is not permission to weaken the experience or switch controls by guesswork.

`QACHK-ENUM-LITERAL`: use the returned enum name, not a remembered alias. It is metadata, not an already escaped expression. Quote the WHOLE name when dotted or otherwise non-simple: `='ButtonCanvas.Appearance'.Primary`, never `=ButtonCanvas.Appearance.Primary`. Quote non-simple members separately: `=DecimalPrecision.'1'` or `=Font.'Open Sans'`. Never remove the qualifier or change control families to evade a quoting error.

## YAML and formulas

`QACHK-DUPLICATE-PROPERTY-KEY`: screen files use `Screens:` with a named screen mapping, `Children:` as a named-control sequence, and `Properties:` as a mapping. Use the assigned globally unique prefix. Never duplicate mapping keys, child names or scaffold roots.

`QACHK-MISSING-FORMULA-PREFIX`: every property expression starts with `=`; structural keywords do not. Use `|-` for multiline formulas, with `=` on the first content line and semicolons between statements. Quote an entire single-line expression containing `: ` or a record literal at the YAML level; inner string quotes do not protect YAML syntax.

```yaml
Text: '="Status: " & varStatus'
OnSelect: |-
  =UpdateContext({locExpanded: true});
  Set(varStatus, "Ready")
```

These illustrate serialization, not shared-state ownership. Use source/schema types and stable identities from bindings. Settable layout inputs are not global variables or necessarily readable through `Self`; use supported qualified outputs or the configured literal padding/gap values in budget formulas.

## Shell and scrolling

`QACHK-ROOT-CONTAINMENT`: a responsive or unknown-device screen has exactly one full-viewport AutoLayout root with `Width: =Parent.Width`, `Height: =Parent.Height`, and both layout minimums zero. All visible/conditional surfaces belong beneath it, not beside it as screen-level siblings. Only an explicitly approved fixed ManualLayout composition permits a different root arrangement.

`QACHK-ROOT-NOT-SCROLLABLE`: implement discovery's shell mode. In page-flow mode the root owns vertical scrolling. In fixed-chrome mode the root is stationary and a bounded content viewport scrolls beside/between fixed rails and bars. Budget chrome and remaining space explicitly; never place supposedly fixed navigation inside scrolling content. Non-scrolling content must fit the shortest supported viewport.

`QACHK-SCROLL-TRAP`: direct content-sized children of a vertical scroll owner use zero fill portions and sufficient explicit heights. The fixed-chrome shell's remaining-space viewport instead uses deliberate proportional sizing in its stationary parent. Each independent scroll region needs an approved contract and visible affordance. Outer scrolling cannot reveal inner clipping; hiding a scrollbar does not remove a scroll owner.

## AutoLayout defaults and budgets

`QACHK-CONTAINER-MIN-SIZE`: explicitly set every GroupContainer's `LayoutMinWidth` and `LayoutMinHeight` to zero. Inspect leaf minimums too; a nominal 300px Width does not override a 320px minimum inside a 311px region.

`QACHK-CROSS-AXIS-ALIGNMENT`: set container `LayoutAlignItems` and every AutoLayout child's `AlignInContainer` intentionally. Stretch text panels, fields and generic content; Start/Center/End can leave text at an intrinsic width and clip it. Deliberately smaller fixed chrome may be centered. Do not impose a conflicting cross-axis size on stretched content, except where the described control requires explicit sizing.

`QACHK-FILLPORTIONS-DEFAULT`, `QACHK-NO-HEIGHT-TRAP`: explicitly set each AutoLayout child's `FillPortions`. Zero preserves main-axis size, not automatic content sizing. A fixed/content-sized container needs sufficient Height in a vertical parent or Width in a horizontal parent; omitted container height can default to 200px.

`QACHK-FILLPORTIONS-HEIGHT-CONFLICT`, `QACHK-FILLPORTIONS-WIDTH-CONFLICT`: proportional children consume remaining main-axis space. Remove competing explicit main-axis sizes rather than pretending both control layout. Their descendants still need space; proportional sizing is not proof of content fit.

For a vertical section, required height is padding + child fixed/minimum content heights + gaps. For a horizontal row, use padding + tallest child, including wrapping. Count conditional regions and longest text. Avoid parent/descendant sizing feedback loops and arbitrarily oversized fixed panels.

`QACHK-FIXED-LAYOUT-WIDTH`, `QACHK-HORIZONTAL-BUDGET`, `QACHK-NO-REFLOW`: size content from its available local width, not a large fixed desktop width. Subtract ancestor padding, rails, siblings and gaps exactly once. Include each child's effective fixed width/minimum before distributing flexible space; evaluate every wrapped row or stacked branch. Keep deliberate fixed chrome only when it fits.

Use live local geometry, not OnVisible width state. Coordinated width, direction and height branches must share a deliberate measurement or accommodate all reachable combinations. Embedded/scale-to-fit hosts may retain logical wide dimensions while rendering narrowly: required content must still fit, wrap/stack or have approved visible scrolling. A breakpoint alone does not prove device responsiveness.

## Text, labels and targets

`QACHK-WRAP-MISSING`, `QACHK-TEXT-PADDING`, `QACHK-TEXT-CONTENT-FIT`: explicitly disable wrapping for intended single-line navigation, badges and headers; retain it for multiline content. Set all four supported text padding inputs deliberately (normally zero, not the 5px default). Use supported AutoHeight or enough height for every line, at least `Size * 1.5` per line plus vertical padding. The ancestor must fit that height too. Do not shrink body text below 14px to conceal clipping. Ellipsis is only for an approved secondary preview with immediately reachable full detail.

`QACHK-ACTION-LABEL-FIT`: budget the longest full action label at each branch, not a short placeholder. Multiword labels need explicit sufficient Width or minimum width; for ModernButton in a vertical parent, use explicit `Width: =Parent.Width` when full-width behavior is intended rather than trusting Stretch alone. Keep navigation labels on one line where possible; intentional wrapping needs matching height. Interactive targets are at least 44px by 44px.

`QACHK-ACCESSIBLE-LABEL-MISSING`: give content-bearing and interactive controls their supported accessible name, contextual to the record when repeated. Do not label purely decorative spacers/dividers. Every input also needs its own persistent visible label in the immediate field region: a supported native visible label or sibling Text/Label. Placeholders, accessible names and combined captions do not replace it. A declared conditional surface may gate input and label together; the label must not independently disappear while the input remains visible. Preserve logical keyboard order, visible focus and text feedback. Interactive galleries have a tab stop as specified by the gallery module.

`QACHK-LOW-CONTRAST-TEXT`, `QACHK-VARIANT-SURFACE-CONTRAST`: when choosing a background, explicitly choose contrasting supported foregrounds for its text. Assess the actual variant/palette surface in every dynamic branch, not just Fill: Secondary/Outline/Subtle/Transparent buttons and tinted badges can retain light surfaces despite a dark Fill. Never assume an appearance enum guarantees contrast. Color alone cannot communicate status or eligibility.
