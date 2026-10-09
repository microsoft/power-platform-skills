# Layout Policies

Reusable layout contracts. Plans, briefs, and direct structural edits name the policy plus
only instance-specific measurements. Do not repeat cosmetic arithmetic that the named
policy already fixes.

Apply `${PLUGIN_ROOT}/references/LayoutGuide.md` for property mechanics. This file is the named-policy
layer those workflows should cite.

## ResponsiveRoot

For phone, tablet, multi-device, or unknown targets, every newly generated screen has one
responsive root container. Invariant:

- sole top-level visible child
- Width =Parent.Width
- Height =Parent.Height
- LayoutMinWidth =0
- LayoutMinHeight =0
- LayoutDirection Vertical
- LayoutAlignItems Stretch
- LayoutOverflowY Scroll

```yaml
Screens:
  ScreenName:
    Children:
      - conScreenNameRoot:
          Control: GroupContainer
          Variant: AutoLayout
          Properties:
            Width: =Parent.Width
            Height: =Parent.Height
            LayoutMinWidth: =0
            LayoutMinHeight: =0
            LayoutDirection: =LayoutDirection.Vertical
            LayoutAlignItems: =LayoutAlignItems.Stretch
            LayoutOverflowY: =LayoutOverflow.Scroll
          Children:
            # Visible controls belong here.
```

Alignment, justification, gap, and padding may vary by experience. The hierarchy and
sizing properties above do not. Breakpoint sizing belongs only on descendants.

Preserve a valid existing responsive root. Preserve a deliberately fixed desktop
ManualLayout. Do not add top-level visible siblings to a malformed generated hierarchy.

## NestedVisibleChildren

Every visible control is nested inside the screen root. The screen-level `Children:` list
contains only that root. Headers, galleries, forms, and panels are root descendants, not
siblings. Direct children of a scroll root use `FillPortions: =0` so content can scroll.

## TouchTarget44

Interactive controls have a minimum height of 44 pixels. Icon-only buttons, steppers, and
tappable badges also meet 44px in each interactive dimension. Primary actions stay visible,
enabled when preconditions hold, inside parent bounds, and unobscured.

## HorizontalReflow

Horizontal AutoLayout rows remain reachable at the supported narrow width. Wrap, stack,
deliberately scroll, or fit the entire wide branch within a statically proven bound. Do
not rely on `App.Width`, a named root's `Width`, or root-level `Parent.Width` alone to
activate a narrow branch. Record only the instance-specific available width, child
minimums, gaps, padding, and protected controls.

## FieldGroups

Keep each visible label with its input in one field container before a row stacks. Required
classic or modern TextInput, NumberInput, Radio, DropDown, and ComboBox controls have a
persistent human-readable visible label in that same region. `AccessibleLabel` and
`HintText` do not replace the visible field name.

## GalleryRows

A list-driven Gallery has a conservative viewport-bounded numeric `Height`, explicit
positive `TemplateSize`, numeric `TemplatePadding`, nonempty `Items`, and concrete row
controls. Do not self-size `Height` from `CountRows(...)` and `Self.TemplateHeight` or
`Self.TemplatePadding`. Row `LayoutDirection` and `TemplateSize` share one breakpoint
source, or every reachable branch has a numeric height budget. Phone rows keep canonical
identity text, status, and required actions reachable.

## ScrollableRoot

A canvas screen does not scroll by itself. The responsive root is the scroll container.
Content taller than the viewport remains reachable through `LayoutOverflowY: =LayoutOverflow.Scroll`.
Do not create nested scrollbars unless a named inner region must scroll independently.

## LongestLabelFit

Status badges, KPI values, and multiword actions fit their longest visible label. In a
vertical AutoLayout parent, a multiword ModernButton or link sets `Width: =Parent.Width`.
Otherwise set a `Width` or `LayoutMinWidth` that fits the longest label, with `Wrap: =false`
on single-line values. Prefer modern controls when they satisfy the requirement.

## ContrastPairs

Whenever a surface `Fill` is set, set an explicit contrasting `Color` or `FontColor` on
every text control inside it. Never pair light text with an `Appearance` or `ThemeColor`
enum unless `Fill` or `BasePaletteColor` is also set. Name the instance palette pair; do
not restate the contrast rule.

## Citing policies

In `PlanModel.layout`, shared `## Layout Strategy`, screen-brief layout sections, and
direct-edit notes, write the policy names and only the measurements unique to that
screen: available width, longest label, protected controls, gallery `Height` /
`TemplateSize`, and named color pairs.
