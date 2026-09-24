# Canvas App YAML Compact QA Contract

Use this compact contract to inspect every generated or modified screen. It defines the
complete 44-check coverage contract without the examples and repair explanations in
`${PLUGIN_ROOT}/references/QAChecks.md`.

Read `${PLUGIN_ROOT}/references/QAChecks.md` only when an applicable check finds a defect or the compact
rule is insufficient to decide or repair it. Do not read the full guide preemptively, and
do not reread it after a successful full return in the same context.

## Execution

1. Inspect the persisted `.pa.yaml` file, not only the composed text.
2. Apply checks 1-44 in order. For Modify, inspect changed and added content plus the
   existing parents, sources, and observers whose behavior the change relies on.
3. Fix every applicable defect before returning.
4. Record complete coverage, repairs, non-applicable checks, numeric layout evidence, and
   one transition trace per Required Action.
5. Do not call `compile_canvas`; the orchestrator owns compilation.

## Checks

| # | Identifier | Compact rule |
|---|---|---|
| 1 | `QACHK-CONTROL-CREATION-KEYWORDS` | Every creation keyword exactly matches `describe_control`. |
| 2 | `QACHK-MISSING-FORMULA-PREFIX` | Every property value uses the required leading `=`. |
| 3 | `QACHK-DUPLICATE-PROPERTY-KEY` | A `Properties:` block contains each property at most once. |
| 4 | `QACHK-ENUM-LITERAL` | Enum qualifier and member use the discovered type and compile-ready quoting. |
| 5 | `QACHK-MISSING-VARIANT` | Every control whose schema declares variants has the exact required `Variant`. |
| 6 | `QACHK-CONTAINER-MIN-SIZE` | Every `GroupContainer` has deliberate `LayoutMinWidth` and `LayoutMinHeight`. |
| 7 | `QACHK-CROSS-AXIS-ALIGNMENT` | AutoLayout parent alignment and child `AlignInContainer` are compatible. |
| 8 | `QACHK-FILLPORTIONS-DEFAULT` | Every AutoLayout child has deliberate fixed or proportional sizing. |
| 9 | `QACHK-SCROLL-TRAP` | A scroll container has no direct fill child that prevents overflow. |
| 10 | `QACHK-WRAP-MISSING` | Single-line text explicitly uses `Wrap: =false`; wrapping text has a valid height strategy. |
| 11 | `QACHK-NO-HEIGHT-TRAP` | Fixed-height vertical content fits its numeric height budget and non-fill children have height. |
| 12 | `QACHK-TEXT-PADDING` | `ModernText` and classic `Label` padding is intentional, normally zero for aligned text. |
| 13 | `QACHK-FILLPORTIONS-HEIGHT-CONFLICT` | A vertically allocated child does not combine conflicting `FillPortions` and `Height`. |
| 14 | `QACHK-FILLPORTIONS-WIDTH-CONFLICT` | A horizontally allocated child does not combine conflicting `FillPortions` and `Width`. |
| 15 | `QACHK-GALLERY-TEMPLATE-LAYOUT` | Gallery row children use a deliberate template layout and valid template-scoped dimensions. |
| 16 | `QACHK-FIXED-LAYOUT-WIDTH` | Responsive layout containers do not use unjustified fixed pixel widths. |
| 17 | `QACHK-ITEM-DISPLAY-TEXT` | Item display properties bind to per-item fields rather than quoted field names. |
| 18 | `QACHK-ACCESSIBLE-LABEL-MISSING` | Content and input controls have supported, meaningful accessible labels. |
| 19 | `QACHK-NO-REFLOW` | Horizontal content wraps, stacks, scrolls deliberately, or has a proven narrow-width fit. |
| 20 | `QACHK-ROOT-NOT-SCROLLABLE` | Content taller than the viewport remains reachable through the intended root strategy. |
| 21 | `QACHK-LOW-CONTRAST-TEXT` | Foreground and explicit background colors form a readable pair. |
| 22 | `QACHK-VARIANT-SURFACE-CONTRAST` | Foreground color remains readable on the surface implied by appearance or theme enums. |
| 23 | `QACHK-CARD-PLACEHOLDER` | Every rendered ModernCard slot is intentionally populated or blanked. |
| 24 | `QACHK-GALLERY-ROW-FITS-CONTENT` | Numeric `TemplateSize` fits every required row child, gap, padding, and wrapped value. |
| 25 | `QACHK-GRID-CONTRACT` | Grid axes, positions, row count, minimums, and height formulas agree. |
| 26 | `QACHK-DUPLICATE-GRID-SEARCH` | A data grid does not duplicate search or filtering UI without a requirement. |
| 27 | `QACHK-ROOT-CONTAINMENT` | A responsive generated screen has one root and all visible content is inside it. |
| 28 | `QACHK-TIMER-LIFECYCLE` | A timer has a reachable automatic start and reset lifecycle. |
| 29 | `QACHK-READ-ONLY-ANCESTOR` | Interactive controls are not placed beneath an ancestor that blocks interaction. |
| 30 | `QACHK-HIDDEN-BOUNDED-LIST` | A Gallery has bounded deterministic height, positive template size, padding, items, and visible rows. |
| 31 | `QACHK-SEMANTIC-VALUE-BINDING` | Semantic controls bind their visible value property to the intended source. |
| 32 | `QACHK-ACTION-LABEL-FIT` | Multiword action labels fit or wrap within their rendered control. |
| 33 | `QACHK-ACTION-CONTRACT` | Every required action, record field, and declared state surface is reachable and wired. |
| 34 | `QACHK-MUTATION-OUTCOME` | Every mutation has a live input, stable target, visible receipt, and observer of the written source. |
| 35 | `QACHK-BEHAVIOR-ACCEPTANCE` | Every advanced behavior has a deterministic success path and required boundary paths. |
| 36 | `QACHK-HORIZONTAL-BUDGET` | Numeric child widths, minimums, gaps, and padding fit the available width in every reachable branch. |
| 37 | `QACHK-MANUAL-BOUNDS` | Visible ManualLayout controls do not overlap and remain inside the parent. |
| 38 | `QACHK-TEXT-CONTENT-FIT` | Visible text can render its longest required value without clipping. |
| 39 | `QACHK-VISUAL-CONTRACT` | Changed visual regions preserve the approved shared palette, typography, and hierarchy. |
| 40 | `QACHK-EXCESS-WHITESPACE` | Layout sizing does not create unintended empty regions. |
| 41 | `QACHK-CORE-VISUALIZATION` | Required charts, comparisons, boards, timelines, maps, or hierarchies are data-bound and complete. |
| 42 | `QACHK-PRIMARY-ACTION-REACHABILITY` | Required actions remain visible, enabled when eligible, at least 44px, and unobscured. |
| 43 | `QACHK-LIFECYCLE-IDENTITY` | Selected-record mutations use one stable raw identity with no transformed or phantom lookup key. |
| 44 | `QACHK-SHARED-SOURCE-DERIVATION` | Derived UI reads the same canonical source that mutations update. |

## Applicability

- Checks 1-5 apply to every written control and run first.
- Checks 6-16, 19-20, 24-25, 27, 30, 36-37, and 40 apply only when the named
  layout construct exists in the changed scope.
- Check 18 is non-applicable only when changed content is purely decorative.
- Checks 21-22 apply when a changed region uses an explicit or variant-supplied colored
  surface.
- Check 23 applies only to ModernCard.
- Check 26 applies only to ModernDataGrid with separate search or filter UI.
- Check 28 applies only to Timer.
- Check 31 applies to semantic display controls.
- Check 33 applies when the brief contains Required Actions, Required Record Fields, or
  state-driven surfaces.
- Checks 34 and 43 apply to record mutation. Check 34 also applies when a local-state
  mutation drives visible behavior.
- Check 35 applies to advanced behavior named by the brief.
- Check 38 applies whenever visible text changes.
- Check 39 applies to every created screen and every visually changed region.
- Check 41 applies only when the brief names a core visualization.
- Check 42 applies to every screen that owns a Required Action entry point.
- Check 44 applies to mutation, search, filter, ordering, alert, KPI, dashboard,
  visualization, or report bindings.

For `QACHK-NO-HEIGHT-TRAP`, `QACHK-GALLERY-ROW-FITS-CONTENT`,
`QACHK-HORIZONTAL-BUDGET`, and `QACHK-PRIMARY-ACTION-REACHABILITY`, PASS requires numeric
branch calculations in `QA layout evidence`. Static calculations do not prove rendered
runtime reachability.

## Reporting

```text
QA coverage: 1-44 COMPLETE
QA repairs: QACHK-MISSING-FORMULA-PREFIX FIXED(2) · QACHK-TEXT-PADDING FIXED(1)
QA N/A: QACHK-GRID-CONTRACT · QACHK-TIMER-LIFECYCLE
QA layout evidence: [numeric applicable checks, or N/A only when genuinely inapplicable]
```

`COMPLETE` means the persisted YAML was inspected against every compact rule. Do not emit
44 self-asserted PASS entries. If a defect or ambiguity requires detailed examples, read
only the needed material from `${PLUGIN_ROOT}/references/QAChecks.md`, repair the file, and retain the
same stable `QACHK-*` identifier in the report.
