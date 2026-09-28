# Canvas App YAML - Responsive GridLayout

Read this guide only when a screen uses `GroupContainer` with
`Variant: GridLayout`. The planner turns these rules into exact formulas in the screen
brief; the builder does not read this file.

## Contents

- Core invariants
- Responsive defaults
- Cards-only grid pattern
- Mixed section grid pattern
- Grid troubleshooting

## Core invariants

1. **Derive layout from size, not state.** Grid columns, rows, gaps and heights must read
   `App.Width`, `Parent.Width` or `Self.Width` directly. Do not set `varIsMobile`,
   `varColumns` or similar values in `OnVisible`; Studio and preview can evaluate the
   layout before that event runs, and the values become stale after a resize.
2. **Set both axes.** Every GridLayout sets `LayoutGridColumns`,
   `LayoutGridRows`, `LayoutGridColumnMinWidth` and `LayoutGridRowMinHeight`. A stale or
   omitted row count can silently force the wrong placement.
3. **Use one column expression.** Reuse the same breakpoint expression in
   `LayoutGridColumns`, row-count math, child positions and `Height`. Two almost-identical
   expressions drift into different layouts.
4. **Derive height from rows.** For `rows`, row height `h`, gap `g`, and vertical padding
   `pt`/`pb`, use `Height: =rows * h + Max(rows - 1, 0) * g + pt + pb`.
5. **Keep grids focused.** Put cards and their section labels in GridLayout. Keep nav,
   breadcrumb, filters, search and data grids in AutoLayout sections unless the approved
   design explicitly requires one flat grid.
6. **Use semantic card controls.** Use `ModernCard` for card cells, not a stretched
   `GroupContainer`. Set `Image: =Blank()` for text-only cards and set every visible text
   slot.
7. **Protect shadows.** Give card grids at least 8px padding on every side where a shadow
   can render.
8. **Position consistently.** Auto-flow is fine for a uniform card set. If any child uses
   `LayoutGridColumnStart`, `LayoutGridColumnEnd`, `LayoutGridRowStart` or
   `LayoutGridRowEnd`, position every child explicitly; mixing positioned and auto-flow
   children is unreliable.

## Responsive defaults

Use the approved plan's breakpoints. When none are specified, use these app-level
defaults:

```powerfx
cols = If(App.Width < 640, 1, If(App.Width < 1024, 2, 3))
pad = If(App.Width < 640, 16, 40)
cardHeight = If(App.Width < 640, 160, 180)
gap = 16
```

`640` separates phone layouts from larger widths; `1024` separates tablet from desktop.
For a reusable nested component, use its available `Parent.Width` instead of `App.Width`.

## Cards-only grid pattern

For three cards:

```yaml
- [Prefix]CardGrid:
    Control: GroupContainer
    Variant: GridLayout
    Properties:
      DropShadow: =DropShadow.None
      FillPortions: =0
      LayoutGap: =16
      LayoutGridColumns: =If(App.Width < 640, 1, If(App.Width < 1024, 2, 3))
      LayoutGridRows: =RoundUp(3 / If(App.Width < 640, 1, If(App.Width < 1024, 2, 3)), 0)
      LayoutGridRowMinHeight: =If(App.Width < 640, 160, 180)
      LayoutGridColumnMinWidth: =(Parent.Width - 2 * If(App.Width < 640, 16, 40) - (If(App.Width < 640, 1, If(App.Width < 1024, 2, 3)) - 1) * 16) / If(App.Width < 640, 1, If(App.Width < 1024, 2, 3))
      PaddingTop: =8
      PaddingBottom: =48
      PaddingLeft: =If(App.Width < 640, 16, 40)
      PaddingRight: =If(App.Width < 640, 16, 40)
      Height: =RoundUp(3 / If(App.Width < 640, 1, If(App.Width < 1024, 2, 3)), 0) * If(App.Width < 640, 160, 180) + Max(RoundUp(3 / If(App.Width < 640, 1, If(App.Width < 1024, 2, 3)), 0) - 1, 0) * 16 + 8 + 48
      Width: =Parent.Width
```

Replace every `3` with the actual card count. Do not change only
`LayoutGridColumns`; rows and height must change with it.

## Mixed section grid pattern

Use one flat grid only when the approved design requires labelled sections in a single
GridLayout. Direct children are section-label `ModernText` controls and `ModernCard`
controls.

- Give every child explicit responsive column and row start/end formulas.
- Make a section label span the full grid:
  `LayoutGridColumnStart: =1` and
  `LayoutGridColumnEnd: =If(App.Width < 640, 2, If(App.Width < 1024, 3, 4))`
  for a 1/2/3-column grid.
- For variable visual heights, use fine row tracks. With track height `8` and gap `16`,
  a child of desired height `height` spans
  `Round((height + 16) / 24, 0)` tracks. The rendered height is
  `tracks * 8 + (tracks - 1) * 16`.
- Walk the fixed child sequence separately at phone, tablet and desktop widths, then
  write responsive start/end formulas from those positions.
- Compute `LayoutGridRows` from the last occupied track and derive `Height` from that
  same value.

This pattern is fragile. The brief must provide the exact positions and formulas; do not
ask the builder to invent the track map.

## Grid troubleshooting

- **Cards overlap or jump columns:** `LayoutGridRows` does not match the row-count
  expression, or positioned and auto-flow children were mixed.
- **Large empty area below the grid:** `Height` uses a larger per-row multiplier than
  `LayoutGridRowMinHeight`, or adds padding twice.
- **Card shadows are clipped:** add at least 8px padding on the clipped sides.
- **Text clips inside a card:** use `AutoHeight: =true`, or set zero vertical text padding
  and make fixed text height at least `Size * 1.5`.
- **Grid responds only after navigation:** a layout property depends on a variable set in
  `OnVisible`; replace it with a direct width expression.
