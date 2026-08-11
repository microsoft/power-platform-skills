# Canvas App YAML — Layout and Responsive Behaviour

Sizing, positioning, scrolling, and the narrow-width behaviour that decides whether a
screen works on a phone. The defects in this guide are invisible at the width you author
and are reported by no compile diagnostic.

## Contents

- Manual layout
- Auto layout
- Keep responsive layout out of state
- Grid layout
- Galleries are Classic — their rows do not reflow
- Horizontal rows must reflow at narrow widths
- Give labelled controls room for their longest value
- Text colour must be set wherever you set a background
- Never hard-code a layout width
- The screen root must be able to scroll
- Layout rules of thumb
- Troubleshooting

## Manual layout

For precise control (game boards, fixed dashboards):

```yaml
- Container:
    Control: GroupContainer
    Variant: ManualLayout
    Properties:
      X: =100
      Y: =100
      Width: =300
      Height: =300
    Children:
      - Button1:
          Control: Button
          Properties:
            X: =0
            Y: =0
            Width: =90
            Height: =90
```

**Pattern:** calculate positions as `(size * index) + (spacing * index)`.

Responsive expressions work in ManualLayout too:

```yaml
X: =(Parent.Width - Self.Width) / 2    # Center horizontally
Width: =Parent.Width                    # Full width
Height: =Parent.Height - Self.Y         # Fill remaining height
```

## Auto layout

For flexible, responsive designs:

```yaml
- Container:
    Control: GroupContainer
    Variant: AutoLayout
    Properties:
      LayoutDirection: =LayoutDirection.Horizontal
      LayoutAlignItems: =LayoutAlignItems.Center
      LayoutJustifyContent: =LayoutJustifyContent.SpaceBetween
      LayoutGap: =16
      PaddingTop: =8
      PaddingBottom: =8
    Children:
      - Button1:
          Properties:
            FillPortions: =1    # Proportional share of the remaining space
```

1. **Dynamic gallery height:** `Height: =CountRows(Self.AllItems) * Self.TemplateHeight`
2. **Container scrolling:** `LayoutOverflowY: =LayoutOverflow.Scroll`
3. **AutoLayout child properties:** `AlignInContainer`, `FillPortions`,
   `LayoutMinWidth/Height`, `LayoutMaxWidth/Height`
4. **Pure AutoLayout:** don't mix ManualLayout inside AutoLayout containers
5. **`FillPortions` is required for fixed-size children:** every child of an AutoLayout
   container must set `FillPortions: =0` if it has a fixed `Width`/`Height`. Without it,
   the container silently overrides the size you set.

## Keep responsive layout out of state

Layout must react to the current size, not to a variable captured during navigation.
Write breakpoints directly in layout properties:

```yaml
LayoutDirection: =If(Parent.Width < 640, LayoutDirection.Vertical, LayoutDirection.Horizontal)
```

Do not set `varIsMobile`, `varColumns`, `varPageWidth` or similar values in `OnVisible`
and then read them from `Width`, `Height`, grid, visibility or direction properties.
Studio can render before `OnVisible` runs, and resizing does not re-run the event. Use
`App.Width` for app-level breakpoints and `Parent.Width` or `Self.Width` for nested
layout scopes.

## Grid layout

GridLayout needs coordinated column, row and height math; a stale row count can produce a
valid but visibly wrong screen. When planning a `GroupContainer` with
`Variant: GridLayout`, use `${PLUGIN_ROOT}/references/GridLayoutGuide.md` and put its exact
formulas in the screen brief. Builders do not read that conditional reference.

## Galleries are Classic — their rows do not reflow

`Gallery` belongs to the Classic control family. It has no AutoLayout variant, so every
control placed directly in its template is positioned absolutely with `X`, `Y`, `Width`
and `Height`. Those coordinates are frozen: the row renders identically at 1440px and at
390px, so columns run off-screen and controls shrink to unusable sizes on phones.

Give the gallery exactly one child — an AutoLayout `GroupContainer` filling the template —
and build the row inside it:

```yaml
- RowGallery:
    Control: Gallery
    Variant: Vertical
    Properties:
      Items: =colDraftRows
      TemplateSize: =68
      Width: =Parent.Width
    Children:
      - RowShell:
          Control: GroupContainer
          Variant: AutoLayout
          Properties:
            LayoutDirection: =LayoutDirection.Horizontal
            LayoutGap: =8
            LayoutMinWidth: =0
            LayoutMinHeight: =0
            Width: =Parent.TemplateWidth
            Height: =Parent.TemplateHeight
          Children:
            # Row content: size with FillPortions, never with X/Y.
```

`Parent.TemplateWidth` and `Parent.TemplateHeight` are gallery output properties, so they
resolve only on a **direct child of the gallery** — the shell container itself. `Parent`
always means the immediate parent, so deeper inside the row it refers to the shell, not
the gallery, and `Parent.TemplateWidth` fails with:

```text
[Control 'X', Property 'Width'] Name isn't recognized: 'TemplateWidth'.
```

Inside the shell, size children with `FillPortions`, or with `Parent.Width` and
`Parent.Height`. Use `Parent.TemplateWidth` exactly once per gallery.

## Horizontal rows must reflow at narrow widths

A horizontal AutoLayout row that looks correct at 1440px will, at 390px, either squeeze
its children to a few pixels, push them off the right edge, or collapse them to zero
height.

Every horizontal container holding more than two substantive children needs an explicit
reflow strategy. Pick one:

```yaml
# 1. Wrap: children flow onto additional lines when they no longer fit.
LayoutDirection: =LayoutDirection.Horizontal
LayoutWrap: =true

# 2. Stack: the row becomes a column below a breakpoint.
LayoutDirection: =If(Parent.Width < 640, LayoutDirection.Vertical, LayoutDirection.Horizontal)
```

Every property is a formula, so a breakpoint can drive sizing and visibility too:

```yaml
Width: =If(Parent.Width < 640, Parent.Width, 320)
Visible: =Parent.Width >= 640
```

Whichever you choose, keep interactive controls at 44px or larger in both states — a
stepper that becomes 14x9px is not usable, and a status badge narrower than its own text
is not readable.

Give multiword actions an explicit width budget. A ModernButton with only
`AlignInContainer.Stretch` can still render at its small default width. In a vertical
parent, set `Width: =Parent.Width`; otherwise set a `LayoutMinWidth` that fits the longest
label. Four-item phone navigation must remain one row or intentionally switch to a
different mobile navigation pattern—do not wrap one tab onto a second row.

A breakpoint formula is only the start of the check. Evaluate both branches:

- In the horizontal branch, fixed widths/minimum widths plus gaps and padding must fit
  the available width. If they do not, group label/input pairs or wrap.
- In the vertical branch, the container height must be the sum of child content, gaps and
  padding. Do not use `2 * Max(child heights)` for two stacked panels or leave
  content-sized panels at `FillPortions: =1`; both create large blank regions and can
  push the next panel far below the expected scroll position.
- For a row that changes axis inside a gallery, include the minimum content height of
  nested `FillPortions` children when choosing `TemplateSize`.
- Keep each visible label and its input/dropdown inside one vertical field container
  before stacking the row. Separate label and control siblings can reorder visually at a
  breakpoint and make a Facility label appear beside the Status dropdown.

For fixed-height sections, calculate the complete content budget at every breakpoint:
child heights, wrapped text lines, gaps and padding. `AutoHeight` does not make its fixed
parent grow. Avoid parent `Height` formulas that read descendant `.Height` values when
those descendants also size from the parent; use collection counts and constants
directly.

Small bounded lists should not create a second hidden scroll region. For a local roster
of roughly ten or fewer rows inside a scrollable root, set gallery height from
`CountRows(Self.AllItems) * Self.TemplateSize` and let the root scroll.

## Give labelled controls room for their longest value

A `Badge`, status pill, or KPI value sized for `"New"` clips `"Implemented"`. When such a
control sits in a horizontal row, set `FillPortions: =0` plus a `Width` (or
`LayoutMinWidth`) that fits the longest value it can display, and set `Wrap: =false` on
single-line text so it cannot silently become two lines.

## Text colour must be set wherever you set a background

Text controls do not inherit a contrasting colour from their container. A dark `Fill` with
an unset `Color` renders near-black text on a near-black surface — technically valid and
completely unreadable:

```yaml
# WRONG — dark row, default (dark) text
Fill: =RGBA(20, 45, 61, 1)
# ...child ModernText with no Color

# RIGHT — set both together
Fill: =RGBA(20, 45, 61, 1)
# ...child ModernText:
Color: =RGBA(239, 246, 250, 1)
```

Whenever you choose a container `Fill`, set `Color` explicitly on every text control
inside it. Do this for gallery rows especially — they are the easiest place to forget and
the most damaging place to get wrong.

## Never hard-code a layout width

`Width: =1120` on a container renders 1120px wide in a 1024px viewport and clips whatever
sits on the right. Size layout containers with `=Parent.Width`, or with `FillPortions`
inside an AutoLayout parent. Reserve fixed pixel sizes for genuinely fixed things: icon
boxes, avatars, and stepper buttons — and keep those at 44px or larger so they stay
tappable.

## The screen root must be able to scroll

A canvas screen does not scroll by itself. Content taller than the viewport is simply
unreachable — there is no browser scrollbar, the wheel does nothing, and the user never
learns the rest of the screen exists. A layout that fits at 900px tall silently loses its
gallery and its action buttons on a 390x844 phone.

Give the screen one root AutoLayout container that scrolls:

```yaml
- [Prefix]Root:
    Control: GroupContainer
    Variant: AutoLayout
    Properties:
      LayoutDirection: =LayoutDirection.Vertical
      LayoutOverflowY: =LayoutOverflow.Scroll
      LayoutMinWidth: =0
      LayoutMinHeight: =0
      Width: =Parent.Width
      Height: =Parent.Height
```

For a responsive screen, that root must contain every visible section. The screen's
top-level `Children:` list contains the root and nothing else; a header or panel aligned
as the root's sibling is outside AutoLayout and can overlap or cover the rest of the
screen while still compiling cleanly.

A **direct** child of a scroll container must use `FillPortions: =0`, or it is pinned to
the viewport height and the content is clipped rather than scrolled. Give stacked sections
explicit heights, or let them size to content.

## Layout rules of thumb

- ✅ AutoLayout for responsive and scrollable screens; ManualLayout only for fixed layouts
- ✅ `LayoutOverflowY: =LayoutOverflow.Scroll` on scrollable containers
- ✅ `AutoHeight: =true` on most text labels so they expand with content — or, for
  deliberately single-line text, so they don't show scrollbars
- ✅ When text must have a fixed height, set `PaddingTop: =0`, `PaddingBottom: =0` and
  `Height` to at least `Size * 1.5`; make the containing band tall enough for wrapped text
- ✅ `LayoutMinWidth: =0` and `LayoutMinHeight: =0` on every `GroupContainer`; the
  defaults are 250 and 100 and silently push containers wider than intended
- ❌ Don't mix ManualLayout inside AutoLayout containers
- ❌ Don't create nested scrollbars

## Troubleshooting

- **Layout doesn't look right:** check whether you are mixing ManualLayout and AutoLayout.
- **A fixed `Width`/`Height` is ignored:** the control is an AutoLayout child without
  `FillPortions: =0`.
- **Content below the fold is unreachable:** the root container is not a scroll container,
  or its direct child does not set `FillPortions: =0`.
- **A gallery row is unreadable on a phone:** the row was built directly in the gallery
  template with `X`/`Y` instead of inside an AutoLayout shell.
- **`Name isn't recognized: 'LayoutGap'` — or `'PaddingTop'`, `'PaddingBottom'`,
  `'PaddingLeft'`, `'PaddingRight'` — in a `Height`, `Width`, `X` or `Y` formula:** these
  are container layout *properties*, not global names, and a bare reference resolves
  against nothing. Substitute the literal number the container sets, or give the control a
  static size. There is no `Self.LayoutGap` form to fall back on.
- **A heading or label is cut off horizontally although its `Text` is complete:** its
  parent is a vertical AutoLayout using `LayoutAlignItems: =LayoutAlignItems.Start` (or
  `.Center`/`.End`), which sizes children to their intrinsic width instead of the
  container width. Set `LayoutAlignItems: =LayoutAlignItems.Stretch` on the container, or
  `AlignInContainer: =AlignInContainer.Stretch` on the child.
