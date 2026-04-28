# Canvas App YAML — QA Self-Check Guide

This guide lists runtime layout issues that `compile_canvas` does NOT catch. The
compiler validates syntax and property names. It cannot tell you that your
scrollable container will never scroll, or that a transparent overlay button
will collapse its siblings to zero height.

Agents that write `.pa.yaml` files MUST run these checks against their own
output before returning, and fix every issue inline. Report the total number of
fixes applied in the result summary.

---

## How to run the checks

1. Read the `.pa.yaml` file you just wrote
2. Apply each check below in order
3. For every issue found: apply the fix directly using `Edit`
4. Track the count and a one-line description of each fix
5. Do NOT re-run `compile_canvas` here — the orchestrating skill does that

All checks are safe: they tighten existing YAML, never delete semantic content.

---

## Check 1 — LayoutMinWidth / LayoutMinHeight on every GroupContainer

**Problem:** Power Apps defaults `LayoutMinWidth` to 250 and `LayoutMinHeight` to
100 on `GroupContainer`. In a sidebar, header, or narrow cell, these defaults
silently push the container wider/taller than intended and clip siblings.

**Detect:** For every control with `Control: GroupContainer`, check whether
`LayoutMinWidth: =0` and `LayoutMinHeight: =0` are present in `Properties:`.

**Fix:** Add either property if missing:

```yaml
LayoutMinWidth: =0
LayoutMinHeight: =0
```

**Exception:** None. Always set both on every GroupContainer.

---

## Check 2 — AlignInContainer on every AutoLayout child

**Problem:** Children of an AutoLayout container (any container that sets
`LayoutDirection`) have unpredictable cross-axis alignment when
`AlignInContainer` is omitted. PA picks a default that depends on control type.

**Detect:** For every control, check whether its parent has a `LayoutDirection`
property. If yes, check whether the child has `AlignInContainer` set. If not,
it's missing.

**Fix:** Add `AlignInContainer: =AlignInContainer.Stretch` to the child. This
is the correct default for labels, inputs, buttons, and generic content — the
child fills the parent's cross-axis dimension.

```yaml
AlignInContainer: =AlignInContainer.Stretch
```

**Exception:** If the child has an explicit smaller-than-parent cross-axis
dimension (e.g., a 28px circular avatar inside a 44px horizontal row), use
`AlignInContainer: =AlignInContainer.Center` instead, so the child keeps its
natural size and is centered.

---

## Check 3 — SCROLL-TRAP (`FillPortions: =1` inside scroll container)

**Problem:** When a container has `LayoutOverflowY: =LayoutOverflow.Scroll` and
its direct child has `FillPortions: =1`, the child is pinned to the viewport
height. Content that exceeds the viewport is clipped, not scrolled — the whole
point of the scroll container is defeated.

**Detect:** For every container with `LayoutOverflowY: =LayoutOverflow.Scroll`
inspect its direct children. Flag any direct child that has `FillPortions: =1`.

**Fix:** Change the child's `FillPortions` to `=0`.

```yaml
# Before:
FillPortions: =1
# After:
FillPortions: =0
```

---

## Check 4 — WRAP-MISSING (single-line label without `Wrap: =false`)

**Problem:** Power Apps defaults `Wrap` to `true` on `Label` controls. A narrow
nav item, breadcrumb, badge, or KPI value will wrap its text onto two lines and
break the intended layout.

**Detect:** For every `Label` (including `ModernText`), check whether
`Wrap: =false` is set. Flag any label that looks like a single-line UI element:

- Nav/menu item labels (inside a navigation gallery or sidebar)
- Tab labels
- Logo text labels
- Column headers in tables or galleries
- Status badges / pill text
- KPI metric values and card titles
- Breadcrumb text
- Button-adjacent short descriptors

**Fix:** Add `Wrap: =false` to the label's Properties.

```yaml
Wrap: =false
```

**Exception:** Do NOT add `Wrap: =false` to labels that intentionally display
multi-line content — description paragraphs, body copy, notes fields, long
comment text. These should keep the default wrapping behavior.

---

## Check 5 — NO-HEIGHT-TRAP (`FillPortions: =0` without explicit `Height`)

**Problem:** When an AutoLayout child has `FillPortions: =0` (or `FillPortions`
is absent, which defaults to 0) and no explicit `Height`, Power Apps defaults
its height to 200px. This pushes surrounding controls around and produces
inexplicable gaps or clipping.

**Detect:** For every `GroupContainer` whose parent has `LayoutDirection`
(AutoLayout child), check:
- Is `FillPortions` absent or `=0`?
- Is `Height` absent?
- If both → flag it.

**Fix:** Add an explicit `Height` formula that sums child heights + gaps +
padding:

```yaml
Height: =PaddingTop + child1.Height + LayoutGap + child2.Height + PaddingBottom
```

If the children's heights are unknown at write time, use a safe static value
(e.g., `Height: =44` for a single row, `=200` for a card panel) and note it in
the fix log so the user can refine.

**Exception:** The screen root container uses `Width: =Parent.Width` and
`Height: =Parent.Height` — not an AutoLayout child. Do NOT flag it.

Also do NOT flag controls where `FillPortions > 0` — PA computes the height
proportionally and `Height` should be absent.

---

## Check 6 — TEXT-PADDING (ModernText, Label padding defaults to 5)

**Problem:** `ModernText` and `Label` controls default `PaddingTop`, `PaddingBottom`,
`PaddingLeft`, and `PaddingRight` to `5`. In most UI contexts (labels in a
table row, card header text, inline metadata, KPI values), the 5px default is
unintended and breaks alignment with adjacent controls or adds stray visual
space in tight layouts.

**Detect:** For every control with `Control: ModernText` or `Control: Label`, check whether all
four padding properties — `PaddingTop`, `PaddingBottom`, `PaddingLeft`, and
`PaddingRight` — are explicitly set in `Properties:`. Flag any that are
absent.

**Fix:** For each of the four properties that is absent, add it with value
`=0`:

```yaml
PaddingTop: =0
PaddingBottom: =0
PaddingLeft: =0
PaddingRight: =0
```

**Exception:** If the design explicitly requires internal padding on a
`ModernText` (e.g., a status pill or badge where inset text is intended), set
the intended non-zero value explicitly. The rule is **never leave any of the
four padding properties absent on a `ModernText`** — always set all four so the
PA default of 5 cannot creep in.

---

## Check 7 — FILLPORTIONS-HEIGHT-CONFLICT (both set on the same control)

**Problem:** Setting both `FillPortions: =N` (where `N > 0`) and an explicit
`Height: =value` on the same control within a vertical AutoLayout container confuses the layout engine.
The container renders one size at design time and another at runtime.

**Detect:** For every control, check whether it has both:
- `FillPortions` with a value greater than 0, AND
- An explicit `Height` (any non-formula numeric or a formula that doesn't
  reference Parent)

**Fix:** Remove the `Height` property. PA computes it from `FillPortions`
against the parent's available space.

---

## Check 8 — FILLPORTIONS-WIDTH-CONFLICT (both set on the same control)

**Problem:** Setting both `FillPortions: =N` (where `N > 0`) and an explicit
`Width: =value` on the same control within a horizontal AutoLayout container
confuses the layout engine. The container renders one size at design time and
another at runtime.

**Detect:** For every control, check whether it has both:
- `FillPortions` with a value greater than 0, AND
- An explicit `Width` (any non-formula numeric or a formula that doesn't
  reference Parent)

**Fix:** Remove the `Width` property. PA computes it from `FillPortions`
against the parent's available space.

---

## Check 9 — CONTROL-VERSION-SUFFIX (`Control:` value contains `@version`)

**Detect:** For every `Control:` property, flag any value that contains an `@` character (e.g. `Control: Text@2.0.0`).

**Fix:** Strip the `@…` suffix, keeping only the bare control name (`Control: Text`).