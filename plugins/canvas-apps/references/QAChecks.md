# Canvas App YAML — QA Self-Check Guide

This guide lists runtime layout issues that `compile_canvas` does NOT catch. The
compiler validates syntax and property names. It cannot tell you that your
scrollable container will never scroll, that a transparent overlay button
will collapse its siblings to zero height, that a gallery row is frozen at desktop
width, or that a dropdown will render every option blank.

## Contents

- How to run the checks

**Run first — these invalidate the whole file or the whole compile:**

- Check 1 — `@version` suffix on a `Control:` value
- Check 2 — property value without the `=` prefix
- Check 3 — same property key twice in one `Properties:` block
- Check 4 — enum qualifier or member written incorrectly
- Check 5 — control that declares variants written without one

**Then, in order:**

- Check 6 — `LayoutMinWidth` / `LayoutMinHeight` on every `GroupContainer`
- Check 7 — container `LayoutAlignItems` and child `AlignInContainer`
- Check 8 — missing `FillPortions` on an AutoLayout child
- Check 9 — `FillPortions: =1` inside a scroll container
- Check 10 — single-line label without `Wrap: =false`
- Check 11 — `FillPortions: =0` without an explicit `Height`
- Check 12 — `ModernText` / `Label` padding defaults to 5
- Check 13 — `FillPortions` and `Height` both set
- Check 14 — `FillPortions` and `Width` both set
- Check 15 — absolutely positioned gallery rows
- Check 16 — hard-coded pixel width on a layout container
- Check 17 — quoted column name instead of a per-item formula
- Check 18 — control with no `AccessibleLabel`
- Check 19 — horizontal row with no narrow-width strategy
- Check 20 — screen content taller than the viewport cannot be reached
- Check 21 — text colour not set against a coloured background
- Check 22 — light foreground on a variant-supplied surface
- Check 23 — `ModernCard` slot left unset
- Check 24 — gallery `TemplateSize` smaller than its row template
- Check 25 — GridLayout axes, row count or height disagree
- Check 26 — duplicate search UI around `ModernDataGrid`
- Check 27 — responsive screen content outside its root container
- Check 28 — timer has no automatic start/reset edge
- Check 29 — interactive control under a read-only ancestor
- Check 30 — small bounded gallery hidden in nested scrolling
- Check 31 — semantic display control missing its visible value binding
- Check 32 — multiword action label does not fit its control

Agents that write `.pa.yaml` files MUST run these checks against their own
output before returning, and fix every issue inline. Report the outcome of
**every** check by number in the result summary, as described below.

---

## How to run the checks

1. Read the `.pa.yaml` file you just wrote
2. Apply the checks in order. Checks 1-5 come first because each one invalidates the
   whole file or the whole compile, and the flood of misleading diagnostics that follows
   hides every other problem
3. For every issue found: apply the fix directly using `Edit`
4. Record an outcome for **every** check, by number — not a total
5. Do NOT re-run `compile_canvas` here — the orchestrator does that

All checks are safe: they tighten existing YAML, never delete semantic content.

### Reporting

A count of fixes is not evidence that a check ran. Report one line per check, using
exactly these outcomes:

```text
QA: 1 PASS · 2 PASS · 3 PASS · 4 FIXED(7) · 5 PASS · 6 FIXED(2) · 7 FIXED(30) ·
    8 PASS · 9 PASS · 10 PASS · 11 PASS · 12 PASS · 13 PASS · 14 PASS · 15 PASS ·
    16 PASS · 17 PASS · 18 FIXED(4) · 19 PASS · 20 PASS · 21 PASS · 22 FIXED(3) ·
    23 FIXED(4) · 24 PASS · 25 N/A · 26 N/A · 27 PASS · 28 N/A · 29 PASS ·
    30 N/A · 31 PASS · 32 PASS
```

- `PASS` — you inspected every control the check applies to and found nothing.
- `FIXED(n)` — you found and repaired `n` occurrences.
- `N/A` — the construct the check targets does not appear on this screen (no gallery, no
  `ModernCard`). Use this honestly; it is not a synonym for "did not check".

Checks 7, 18 and 21 apply frequently, but their outcomes still depend on the file:

- Check 7 is `N/A` when the changed scope has no children of an AutoLayout container.
- Check 18 is `N/A` when the changed scope contains only decorative controls.
- Check 21 is `N/A` when the changed scope has no non-default coloured surface.
- Check 27 is `N/A` only when the brief explicitly requires fixed ManualLayout with
  deliberate screen-level overlays.

`PASS` is valid when every applicable control was inspected and no defect was found.
Never infer that a check was skipped solely from the number of controls on the screen.

---

## Check 1 — CONTROL-VERSION-SUFFIX (`Control:` value contains `@version`)

**Problem:** Every control type resolves to exactly one template version per app. A single
`Control: ModernText@1.5.0` anywhere in the app pins every `ModernText` instance to one
version and reports every property belonging to the other version as unknown:

```text
Another instance of control type 'ModernText' has already been referenced using a
different version '1.0.0'.
Unknown property 'Color' for control type 'Text'.
Unknown property 'FontWeight' for control type 'Text'.
```

Those properties are valid. Nothing is wrong with them. One stray suffix can produce
hundreds of phantom diagnostics, and they name an internal control type (`'Text'`) that
appears nowhere in the YAML — so they are extremely hard to diagnose after the fact. This
check is cheap; run it first.

**Detect:** For every `Control:` property, flag any value that contains an `@` character
(e.g. `Control: Text@2.0.0`).

**Fix:** Strip the `@…` suffix, keeping only the bare control name (`Control: Text`).

**Exception:** None. Always use the bare name that `list_controls` returned.

---

## Check 2 — MISSING-FORMULA-PREFIX (property value without `=`)

**Problem:** Every `.pa.yaml` property value is a Power Fx expression. A value without the
`=` prefix fails the whole file at parse time, and a file that does not parse reports no
other diagnostics — so this one mistake hides every other problem in the screen:

```text
An error occurred while parsing PaYaml. Error code: YamlInvalidSyntax;
Reason: Power Fx expressions must start with '='.
```

**Detect:** For every entry under a `Properties:` mapping, check that the value starts
with `=`, or is a `|-` block whose first content line starts with `=`. Flag bare literals
such as `Text: Weekly Timesheet`, `Width: 320`, or `Visible: true`.

**Fix:** Add the `=` prefix, quoting literal text:

```yaml
# Before:
Text: Weekly Timesheet
Width: 320
# After:
Text: ="Weekly Timesheet"
Width: =320
```

Then check the same values for a colon followed by a space. Any plain scalar containing
`: ` breaks the parser with
`While scanning a plain scalar value, found invalid mapping` — this includes ordinary
caption formatting, not just record literals:

```yaml
# Before:
Text: ="Location: " & ThisItem.Location
Default: ={Value: "Tab1"}
# After:
Text: '="Location: " & ThisItem.Location'
Default: '={Value: "Tab1"}'
```

**Exception:** Structural keys (`Control:`, `Variant:`, `Children:`, control names) are
not Power Fx and take no `=`.

---

## Check 3 — DUPLICATE-PROPERTY-KEY (same key twice in one `Properties:` block)

**Problem:** YAML rejects the whole file, and because it is a parse failure no other
diagnostic in that screen is reported:

```text
Reason: Duplicate name 'LayoutMinWidth' used at Scalar [...].
First use is located at PaYamlLocation { Line = 119, Column = 31 }.
```

It happens most often after editing a control twice — appending `LayoutMinWidth`,
`FillPortions` or `AlignInContainer` that were already set higher up in the same block.

**Detect:** For every `Properties:` mapping, check that no key appears twice.

**Fix:** Keep the intended value and delete the other occurrence. The message reports the
first use's line and column — go there directly.

---

## Check 4 — ENUM-LITERAL (enum qualifier or member written incorrectly)

An enum literal has two parts and each fails differently. Check both.

### 4a — the qualifier

**Problem:** Enum type names cannot be derived from control names, and a guessed name
fails with `Name isn't recognized`. The same property name maps to different enum types on
different controls:

| Control | Property | Correct enum name |
|---------|----------|-------------------|
| `ModernDropdown` / `ModernTextInput` / `ModernNumberInput` | `Appearance` | `Appearance` |
| `ModernButton` | `Appearance` | `ButtonAppearance` |
| `Badge` | `Appearance` / `Shape` / `ThemeColor` | `BadgeCanvas.Appearance` / `BadgeCanvas.Shape` / `BadgeCanvas.ThemeColor` |
| `Progress` | `Shape` / `Thickness` / `ProgressColor` | `Progress.Shape` / `Progress.Thickness` / `Progress.ProgressColor` |

**Detect:** For every property you set to an enum value, find that property in the control
definition in your screen brief and compare your qualifier against its `Enum name:` line.
Flag any mismatch, and flag any bare value such as `ThemeColor: =Subtle`.

**Fix:** Use the `Enum name:` verbatim, wrapped in `'` when it contains a dot or a space:

```yaml
# Before:
Appearance: ='BadgeAppearance'.Tint
ThemeColor: =Subtle
# After:
Appearance: ='BadgeCanvas.Appearance'.Tint
ThemeColor: ='BadgeCanvas.ThemeColor'.Subtle
```

**Exception:** None. Never remove the qualifier to "fix" an unrecognized enum name — a
bare member name fails the same way.

### 4b — the member

**Problem:** An enum member that is not a valid unquoted Power Fx identifier must be
quoted. The most common case is a member that starts with a digit. The control definition
in your brief lists numeric members bare (`values: 0, 1, 2, 3, 4, 5, Auto`), but that
listing is not the literal you write. Unquoted, Power Fx reads the digit as the start of a
new number:

```text
[Control 'HoursInput', Property 'Precision'] Expected operator.
[Control 'HoursInput', Property 'Precision'] Expected an operand.
```

Two messages, one property, and **neither says `Name isn't recognized` or mentions an
enum** — which is why this is routinely misread as a formula bug. Seven such properties
produce twenty-one errors.

**Detect:** For every enum property you set, inspect the member after the `.`. Wrap it in
`'` when it starts with a digit or contains spaces or other characters that prevent it
from being used as an unquoted identifier.

**Fix:**

```yaml
# Before:
Precision: =DecimalPrecision.1
# After:
Precision: =DecimalPrecision.'1'

# A member containing a space must also stay quoted:
Font: =Font.'Open Sans'
```

**Exception:** A simple identifier such as `Rounded` does not need member quotes:
`'BadgeCanvas.Shape'.Rounded`. Do not remove required quotes from members such as
`'Open Sans'` merely because they start with a letter.

---

## Check 5 — MISSING-VARIANT (control that declares variants written without one)

**Problem:** A control whose template declares variants has no default. Omitting the key
fails the whole compile with a message that names neither file nor control:

```text
The keyword 'Variant' is required but is missing or empty.
```

**Detect:** For every `Control: GroupContainer` and `Control: Gallery` — and any control
whose definition in your brief includes a `Variants` section — check that a sibling
`Variant:` key is present and non-empty.

**Fix:** Add the variant that matches the intent:

```yaml
- [Prefix]Row:
    Control: GroupContainer
    Variant: AutoLayout       # AutoLayout | GridLayout | ManualLayout

- [Prefix]List:
    Control: Gallery
    Variant: Vertical         # Vertical | Horizontal | VariableHeight
```

**Exception:** Controls with no `Variants` section take no `Variant` key.

---

## Check 6 — LayoutMinWidth / LayoutMinHeight on every GroupContainer

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

## Check 7 — CROSS-AXIS-ALIGNMENT (container `LayoutAlignItems` and child `AlignInContainer`)

Cross-axis sizing is decided in two places. Check the container first — one container fix
replaces a fix on every one of its children.

### 7a — the container

**Problem:** A container whose `LayoutAlignItems` is `Start`, `Center` or `End` sizes each
child to its **intrinsic** cross-axis dimension instead of the container's. In a vertical
container that means text is laid out at some default width and everything past it is
**clipped, not wrapped** — a heading reading `"PROJECT PULSE"` renders as `PROJECT`, and
`="Estimated budget  $" & Text(total)` renders as `Estimated budget` with the figure gone.
`compile_canvas` sees nothing wrong: the `Text` formula is perfectly valid.

**Detect:** For every container with `LayoutDirection: =LayoutDirection.Vertical`, read its
`LayoutAlignItems`. If it is `Start`, `Center` or `End` and any descendant is a text
control whose content can be long, flag it.

**Fix:** Use `Stretch` on the container:

```yaml
LayoutDirection: =LayoutDirection.Vertical
LayoutAlignItems: =LayoutAlignItems.Stretch
```

**Exception:** A vertical container holding only fixed-size chrome — icons, avatars,
steppers — may keep `Center`. Text panels, headings, form fields and card bodies may not.

### 7b — the child

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

⚠️ This check is per-control and there is no compile diagnostic behind it. A screen where
`AlignInContainer` appears on *none* of its controls has not had this check run — say so
in your report rather than claiming a clean pass.

---

## Check 8 — FILLPORTIONS-DEFAULT (missing `FillPortions` on AutoLayout child)

**Problem:** Children of an AutoLayout container inherit a PA-chosen default for
`FillPortions` that varies by control type, so the intent isn't clear.

**Detect:** For every control whose parent has a `LayoutDirection` property
(i.e., it is an AutoLayout child), check whether `FillPortions` is explicitly
set in `Properties:`. Flag any that are missing.

**Fix:** Add `FillPortions` explicitly:

- `FillPortions: =0` — the child keeps a constant size (its `Height` or `Width`
  is set explicitly).
- `FillPortions: =1` — the child proportionally fills the remaining available
  space in the container.

```yaml
# Fixed size child:
FillPortions: =0

# Proportional fill child:
FillPortions: =1
```

**Exception:** None. Always set `FillPortions` on every AutoLayout child so the
layout intent is explicit.

---

## Check 9 — SCROLL-TRAP (`FillPortions: =1` inside scroll container)

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

## Check 10 — WRAP-MISSING (single-line label without `Wrap: =false`)

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

## Check 11 — NO-HEIGHT-TRAP (`FillPortions: =0` without explicit `Height`)

**Problem:** When an AutoLayout child has `FillPortions: =0` (or `FillPortions`
is absent, which defaults to 0) and no explicit `Height`, Power Apps defaults
its height to 200px. This pushes surrounding controls around and produces
inexplicable gaps or clipping.

**Detect:** For every `GroupContainer` whose parent has `LayoutDirection`
(AutoLayout child), check:
- Is the parent's `LayoutDirection` **Vertical**? This check applies to the parent's main
  axis only. In a horizontal parent, `FillPortions` governs width, so apply the same test
  to `Width` instead of `Height`.
- Is `FillPortions` absent or `=0`?
- Is `Height` absent (vertical parent) or `Width` absent (horizontal parent)?
- If all → flag it.

**Fix:** Add an explicit `Height` formula that sums child heights + gaps +
padding, writing the padding and gap as the **literal numbers you set on this
container**:

```yaml
# This container sets PaddingTop: =12, LayoutGap: =8, PaddingBottom: =12
Height: =12 + child1.Height + 8 + child2.Height + 12
```

⚠️ **Never write `PaddingTop`, `PaddingBottom`, `LayoutGap`, `PaddingLeft` or
`PaddingRight` as bare names in a formula.** They are properties of a container,
not global names, and Power Fx resolves them against nothing:

```yaml
# WRONG — every bare name here fails with `Name isn't recognized`
Height: =PaddingTop + child1.Height + LayoutGap + child2.Height + PaddingBottom
```

One such formula emits a `Name isn't recognized` error for every bare name it
contains, on a control that is otherwise correct. There is no `Self.LayoutGap`
form to reach for either — substitute the literal value.

If the children's heights are unknown at write time, use a safe static value
(e.g., `Height: =44` for a single row, `=200` for a card panel) and note it in
the fix log so the user can refine.

After confirming a fixed size exists, verify that it fits. For every fixed-height
vertical section, evaluate each responsive branch and sum direct child heights, nested
minimum content heights, gaps and padding. Include wrapped or `AutoHeight` text at its
expected narrow-width line count. Flag any branch where the section height is smaller
than that budget. Do not mark this check `PASS` merely because `Height` is present.

Avoid parent-height formulas that depend on descendant control `.Height` values when
those descendants also size from their parent. Use collection counts and literal content
budgets directly; layout feedback loops can collapse to the platform's default 100px
height while compiling cleanly.

**Exception:** The screen root container uses `Width: =Parent.Width` and
`Height: =Parent.Height` — not an AutoLayout child. Do NOT flag it.

Also do NOT flag controls where `FillPortions > 0` — PA computes the main-axis size
proportionally and the explicit size should be absent. Do not add a cross-axis size to a
child that uses `AlignInContainer: =AlignInContainer.Stretch`; the parent already sets it.

---

## Check 12 — TEXT-PADDING (ModernText, Label padding defaults to 5)

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

Then check vertical fit. Prefer `AutoHeight: =true`. When a fixed height is required,
set `PaddingTop: =0`, `PaddingBottom: =0`, and make `Height` at least `Size * 1.5`.
Also ensure a fixed-height parent band can hold every wrapped text child plus its own
padding and gaps.

---

## Check 13 — FILLPORTIONS-HEIGHT-CONFLICT (both set on the same control)

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

## Check 14 — FILLPORTIONS-WIDTH-CONFLICT (both set on the same control)

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

## Check 15 — GALLERY-TEMPLATE-LAYOUT (absolutely positioned gallery rows)

**Problem:** `Gallery` is a Classic control with no AutoLayout variant. Controls placed
directly in its template are positioned with absolute `X`/`Y`/`Width`, so the row is
frozen at whatever width you authored. At phone width the right-hand columns run off
screen and inputs shrink to a few pixels. `compile_canvas` reports nothing.

**Detect:** For every control with `Control: Gallery`, inspect its direct `Children`. Flag
the gallery if it has more than one direct child, or if any direct child sets `X` or `Y`.

**Fix:** Give the gallery exactly one direct child — an AutoLayout `GroupContainer` sized
to the template — and move the row content inside it:

```yaml
Children:
  - [Prefix]RowShell:
      Control: GroupContainer
      Variant: AutoLayout
      Properties:
        LayoutDirection: =LayoutDirection.Horizontal
        LayoutGap: =8
        LayoutMinWidth: =0
        LayoutMinHeight: =0
        Width: =Parent.TemplateWidth
        Height: =Parent.TemplateHeight
```

Then size the row content with `FillPortions` and drop every `X`/`Y` inside the template.

Set `Parent.TemplateWidth`/`Parent.TemplateHeight` **only on the shell**, which is the
gallery's direct child. Deeper descendants must use `FillPortions`, `Parent.Width` or
`Parent.Height`; `Parent` there means the shell, which has no `TemplateWidth`, and the
compile fails with `Name isn't recognized: 'TemplateWidth'`.

**Exception:** A single-column gallery whose template holds exactly one full-width control
needs no shell.

---

## Check 16 — FIXED-LAYOUT-WIDTH (hard-coded pixel width on a layout container)

**Problem:** A container with `Width: =1120` renders 1120px wide inside a 1024px viewport
and clips its right edge. The screen looks correct only at the width it was authored at.

**Detect:** For every `GroupContainer` and `Gallery`, flag a `Width` set to a numeric
literal greater than 400 that does not reference `Parent`, `Self`, or `App`.

**Fix:** Replace with a responsive expression, or delete it and let the parent size the
control:

```yaml
# Before:
Width: =1120
# After:
Width: =Parent.Width
# or, as a child of an AutoLayout container:
FillPortions: =1
```

**Exception:** Genuinely fixed-size elements — icon boxes, avatars, stepper buttons,
fixed-width sidebars. Keep interactive ones at 44px or larger so they remain tappable.

---

## Check 17 — ITEM-DISPLAY-TEXT (quoted column name instead of a per-item formula)

**Problem:** `ItemDisplayText` and `ItemKey` are evaluated per row with `ThisItem` in
scope. `ItemDisplayText: ="Value"` is a constant string, not a field reference, and the
dropdown renders every option blank. `compile_canvas` accepts it.

**Detect:** For every control setting `ItemDisplayText` or `ItemKey`, flag a value that is
a quoted literal rather than an expression referencing `ThisItem`.

**Fix:**

```yaml
# Before:
ItemDisplayText: ="Value"
# After:
ItemDisplayText: =ThisItem.Value
```

**Exception:** When `Items` is already a single-column table, omit the property entirely.

---

## Check 18 — ACCESSIBLE-LABEL-MISSING (control with no `AccessibleLabel`)

**Problem:** A control that renders content or accepts input without an `AccessibleLabel`
is unusable with a screen reader, and an interactive gallery without `TabIndex` cannot be
reached from the keyboard. `compile_canvas` reports neither. A screen authored without
them needs dozens of labels retrofitted into a file that was otherwise finished. Writing
them as you go costs nothing.

**Detect:** For every control that renders content or accepts input — `ModernText`,
`ModernCard`, `Badge`, `Gallery`, `Image`, `Icon`, buttons, and every input control —
check that `AccessibleLabel` is present. For every `Gallery` a user selects from, check
that `TabIndex` is present.

**Fix:** Add a label derived from the control's content, and a tab stop on interactive
galleries:

```yaml
AccessibleLabel: ="Filtered inventory list"
TabIndex: =0
```

Inside a gallery template, make it row-specific:

```yaml
AccessibleLabel: ="Quantity on hand for " & ThisItem.Name
```

**Exception:** Purely decorative controls — spacer containers, background rectangles,
divider lines. Do not label those.

---

## Check 19 — NO-REFLOW (horizontal row with no narrow-width strategy)

**Problem:** A horizontal AutoLayout row authored at desktop width does not reflow. At
phone width its children squeeze to a few pixels, run off the right edge, or collapse to
zero height. This is the most common defect in generated apps, and nothing in
`compile_canvas` reports it.

**Detect:** For every container with a horizontal branch and more than two substantive
children:

1. Confirm it wraps or changes direction at a width breakpoint.
2. Evaluate the horizontal branch's width budget: fixed `Width` and `LayoutMinWidth`
   values, gaps and horizontal padding must fit the available parent width. A breakpoint
   formula is not a pass when the desktop branch still places ten 100-170px fields in one
   row.
3. Evaluate the vertical branch's height budget. Sum fixed child heights, nested
   content heights, gaps and vertical padding. A child with `FillPortions: =1` still needs
   enough remaining height for its descendants; otherwise its labels collapse to zero
   height.

**Fix:** Add one of the two strategies:

```yaml
# Wrap onto more lines:
LayoutWrap: =true

# Or stack below a breakpoint:
LayoutDirection: =If(Parent.Width < 640, LayoutDirection.Vertical, LayoutDirection.Horizontal)
```

If the horizontal width budget still does not fit, wrap it or group each label/input pair
inside a vertical field container so the parent row has fewer substantive children. If
the vertical height budget does not fit, raise the containing height or the gallery
`TemplateSize`; do not rely on `FillPortions` to create space that is not available.

**Exception:** A two-child row of a label and a fixed icon, or a row whose children all
carry `FillPortions` and remain legible when proportionally narrowed.

---

## Check 20 — ROOT-NOT-SCROLLABLE (screen content taller than the viewport cannot be reached)

**Problem:** A canvas screen does not scroll by itself. If the root container is not a
scroll container, everything below the viewport is unreachable — no scrollbar, no wheel
response, and the user never learns the content exists.

**Detect:** Find the screen's root container. Flag it if it does not set
`LayoutOverflowY: =LayoutOverflow.Scroll` while its children include a gallery, a form, or
more than about three stacked sections.

**Fix:**

```yaml
LayoutDirection: =LayoutDirection.Vertical
LayoutOverflowY: =LayoutOverflow.Scroll
```

Then re-run Check 9: a **direct** child of a scroll container must use `FillPortions: =0`,
or it is pinned to the viewport height and the content is clipped rather than scrolled.

**Exception:** A screen whose content is genuinely fixed and fits the shortest supported
viewport.

---

## Check 21 — LOW-CONTRAST-TEXT (text colour not set against a coloured background)

**Problem:** Text controls do not inherit a contrasting colour from their container. A
container with a dark `Fill` whose child text controls omit `Color` renders near-black on
near-black. `compile_canvas` passes it.

**Detect:** For every container that sets a non-default `Fill`, check every descendant
text control (`ModernText`, `Badge`, and any control with a `Text` or `Content` property)
for an explicit colour — `Color` on the modern React controls, `FontColor` on `Badge`,
`TitleColor`/`SubtitleColor`/`DescriptionColor` on `ModernCard`.

**Fix:** Set the colour explicitly wherever the background was set:

```yaml
Color: =RGBA(239, 246, 250, 1)
```

**Exception:** None. If you chose the background, choose the foreground.

---

## Check 22 — VARIANT-SURFACE-CONTRAST (light foreground on a variant-supplied surface)

**Problem:** Check 21 catches text that *omits* a colour. This is the opposite failure: the
colour is set, and it is set against a surface the control derives from a **Fluent enum**
rather than from `Fill`. The agent picks a near-white foreground for a dark theme, the
variant supplies a near-white surface, and the control renders white-on-white — a nav
button whose label is invisible, or a status badge that reads as an empty pill.

These are the enum values that produce a **light** surface:

| Property | Light-surface members |
|----------|----------------------|
| `Appearance` on `ModernButton` | `ButtonAppearance.Secondary`, `.Outline`, `.Subtle`, `.Transparent` |
| `Appearance` on inputs | `Appearance.Outline`, `.FilledLighter` |
| `Appearance` on `Badge` | `'BadgeCanvas.Appearance'.Tint`, `.Ghost`, `.Outline` |
| `ThemeColor` on `Badge` | `'BadgeCanvas.ThemeColor'.Informative`, `.Warning` |

**Detect:** For every control that sets `Color` or `FontColor` to a light value (any
channel triple averaging above ~180), check whether its surface comes from one of the enum
values above. If it does, flag it unless the chosen appearance is known to render a dark
surface with the supplied `BasePaletteColor`. A `Fill` property alone is not proof:
Fluent `Secondary`, `Outline`, `Subtle` and `Transparent` buttons can keep their
variant-supplied light surface and ignore that fill.

Check the dynamic case too: a `ThemeColor` driven by `If`/`Switch` will pass through light
members for some rows even when the branch you eyeballed was dark.

**Fix:** Pick a foreground that works against the variant surface, or switch to a dark
surface appearance and set its palette:

```yaml
# Before — Secondary is a light surface, so near-white text vanishes
Appearance: =ButtonAppearance.Secondary
Color: =RGBA(238, 243, 250, 1)
Fill: =RGBA(23, 37, 58, 1) # may be ignored

# After — keep Secondary and use dark text
Appearance: =ButtonAppearance.Secondary
Color: =RGBA(23, 37, 58, 1)

# Or use a palette-backed dark primary surface
Appearance: =ButtonAppearance.Primary
BasePaletteColor: =RGBA(23, 37, 58, 1)
Color: =RGBA(238, 243, 250, 1)
```

**Exception:** A control genuinely intended to sit on a light page background, where the
foreground is dark. The rule is that foreground and surface must be chosen together —
never one from your palette and the other from an enum default.

---

## Check 23 — CARD-PLACEHOLDER (`ModernCard` slot left unset)

**Problem:** `ModernCard` does not render unset slots as empty. It substitutes placeholder
content: a large stock photograph for `Image`, and the literal strings `Title`, `Subtitle`
and `Description` for the text slots. The photo takes most of the card's height, so the
value you *did* set is pushed out of view or clipped mid-glyph. Every card on the screen
looks identical and none of them shows its data. `compile_canvas` reports nothing.

**Detect:** For every `Control: ModernCard`, list the slots supported by the control
definition and the slots the YAML sets. Flag it when `Image` is absent. When the
definition includes `HeaderImage`, flag that when it is absent too. Flag any text slot
that the card's layout displays but the YAML leaves unset.

**Fix:** Set every slot, using `Blank()` for an image you do not want:

```yaml
- KpiOpenCard:
    Control: ModernCard
    Properties:
      Image: =Blank()
      HeaderImage: =Blank()
      Title: =CountRows(colOpenTasks) & ""
      Subtitle: ="Open tasks"
      Description: ="Across all projects"
```

If the control definition includes `ImageAccessibleLabel` or
`HeaderImageAccessibleLabel`, set those explicitly when the corresponding image is
blank. A text-only `ModernCard` inside AutoLayout must use explicit card dimensions and
`FillPortions: =0`; stretching it with `FillPortions: =1` can collapse every visual slot
while the accessibility tree still exposes the values. Use at least `Height: =150` and a
width that fits the intended card, or choose a custom AutoLayout KPI surface when the
card must fluidly fill available width. When Title, Subtitle and Description are all
visible, use at least `Height: =180`; anything below 180 is a failure, not a compact
variant. Do not force all
three text slots into a short fixed height.

**Exception:** None. If you chose `ModernCard`, you own all of its slots.

---

## Check 24 — GALLERY-ROW-FITS-CONTENT (`TemplateSize` smaller than the row template)

**Problem:** `TemplateSize` fixes the row height; the template's content does not
negotiate with it. A row sized for density — `TemplateSize: =If(Self.Width < 640, 320, 132)`
— clips whatever does not fit at the *desktop* branch, so the app looks correct on a phone
and loses its card titles on a laptop. It is easy to miss because the narrow branch, which
is the one usually eyeballed, is fine.

The trap is worst with a `ModernCard` row template, whose image band alone can exceed the
row height you chose.

**Detect:** For every `Gallery`, evaluate `TemplateSize` at **each** branch of its formula.
For each branch, add up the stacked heights of the row template's children plus their gaps
and padding — counting nested fixed-height descendants and a `ModernCard`'s image band.
When a vertical row contains a `FillPortions: =1` child, calculate the minimum height of
that child's descendants and include it in the sum; do not treat it as zero. Flag any
branch where the total exceeds `TemplateSize`.

**Fix:** Raise the branch to fit, or reduce what the row renders at that width:

```yaml
# Before — 132px cannot hold a card image plus a title
TemplateSize: =If(Self.Width < 640, 320, 132)
# After
TemplateSize: =If(Self.Width < 640, 320, 220)
```

**Exception:** A row that deliberately truncates a long free-text field, where the
truncation is visible and the row still shows its identifying label.

---

## Check 25 — GRID-CONTRACT (GridLayout axes, row count or height disagree)

**Problem:** GridLayout accepts incomplete or inconsistent sizing formulas. The app can
compile while cards overlap, jump columns, leave a large blank tail, or clip shadows.

**Detect:** For every `GroupContainer` with `Variant: GridLayout`:

1. Confirm it sets `LayoutGridColumns`, `LayoutGridRows`,
   `LayoutGridColumnMinWidth` and `LayoutGridRowMinHeight`.
2. Confirm `LayoutGridRows` uses the same column-count expression as
   `LayoutGridColumns`.
3. Confirm `Height` equals rows times row height, plus inter-row gaps and vertical
   padding.
4. If any child sets a `LayoutGrid*Start` or `LayoutGrid*End` property, confirm every
   child is explicitly positioned.
5. Confirm card shadows have at least 8px padding on the sides where they render.

**Fix:** Reapply the exact grid contract from the screen brief. If it is missing, return
`Status: Blocked`; do not invent a responsive track map.

**Exception:** None for steps 1-3. Step 4 is `N/A` for a uniform auto-flow card grid.

---

## Check 26 — DUPLICATE-GRID-SEARCH (`ModernDataGrid` plus separate search UI)

**Problem:** `ModernDataGrid.Searchable: =true` renders a built-in search box. If the
screen also provides a `ModernTextInput` or filter bar that filters the same rows, users
see two search affordances with unclear combined state.

**Detect:** For every `ModernDataGrid` with `Searchable: =true`, inspect the surrounding
section for a separate search input or filter formula targeting the same `Items`.

**Fix:** Keep the screen-level search/filter UI and set `Searchable: =false`, or remove
the property because false is the default.

**Exception:** A separate input that searches a different dataset or performs a different
action is not duplicate UI.

---

## Check 27 — ROOT-CONTAINMENT (responsive screen content outside its root container)

**Problem:** A responsive screen can compile with a correctly configured root AutoLayout
container while the actual header, sections and galleries are mis-indented as sibling
entries in the screen's top-level `Children:` list. The root is then empty. Those siblings
use screen-level positioning instead of AutoLayout, overlap one another, intercept pointer
events and leave large blank areas. Every property on the individual controls can be
valid, so no compile diagnostic reports the failure.

**Detect:** When the screen brief names a responsive root container, inspect the
`Children:` list directly under the screen key. It must contain exactly that root
container. Then confirm every visible section named in the brief is nested under the
root's `Children:` list. A root followed by another screen-level `- [Prefix]Header`,
`- [Prefix]Panel`, gallery or stage is a failure, not a second layout region.

**Fix:** Move every screen-level sibling under the root container's `Children:` key,
preserving their order and existing properties:

```yaml
Screens:
  Screen1:
    Children:
      - AppRoot:
          Control: GroupContainer
          Variant: AutoLayout
          Properties:
            Width: =Parent.Width
            Height: =Parent.Height
            LayoutDirection: =LayoutDirection.Vertical
          Children:
            - AppHeader:
                # ...
            - AppContent:
                # ...
```

After moving the controls, re-run Checks 8, 9, 13, 14 and 20 because their parent
AutoLayout context has changed.

**Exception:** A brief that explicitly requires a fixed ManualLayout screen with
deliberate screen-level overlays may use multiple top-level controls. Do not infer this
exception from the YAML; it must be stated in the brief.

---

## Check 28 — TIMER-LIFECYCLE (timer has no automatic start/reset edge)

**Problem:** A Timer with `AutoStart: =false` does not reliably start when its `Start`
variable was already set to true before navigation. It needs a false-to-true transition
after the timer exists. Toggling only `Reset` for the next speaker can leave the display
at `00:00` and the timer stopped until the user clicks it. Because Timer is clickable by
default, an accidental second click can pause it indefinitely and block the workflow.

**Detect:** For every `Control: Timer` used as an automatic countdown:

1. If `AutoStart: =false`, trace the `Start` formula. Flag it when the variable is set
   true before navigating to the timer screen and is never toggled false then true in
   `OnVisible`.
2. Trace every reset/next-item action. It must reset the timer and produce a new start
   edge for the next item.
3. Flag an interactive timer with no visible play/pause label when clicking it can pause
   a required workflow.
4. Inspect its `Text` formula. A countdown must display remaining time
   (`Duration - Value`) and explicitly show `00:00` after expiry. A formula based only on
   `Self.Value` counts upward and can show `01:00` beside a "Minute complete" message.

**Fix:** Prefer `AutoStart: =true` for a timer that must begin on screen entry. For each
new item, toggle `Reset` and restart explicitly:

```yaml
# Screen OnVisible
OnVisible: |-
  =Set(varTimerRunning, false);
  Set(varTimerReset, !varTimerReset);
  Set(varTimerRunning, true)

# Timer
AutoStart: =true
Start: =varTimerRunning
Reset: =varTimerReset
AutoPause: =false
Text: =If(varTimerFinished, "00:00", Text(Time(0, 0, Max(0, RoundUp((Self.Duration - Self.Value) / 1000, 0))), "mm:ss"))
```

Use the same false-reset-true sequence when advancing to the next item. If manual pause
is a requirement, provide a separate labelled button and visible state; do not use the
timer surface as an undisclosed toggle.

**Exception:** A timer explicitly requested as manual start/pause, with labelled controls
and a workflow that does not block while it is stopped.

---

## Check 29 — READ-ONLY-ANCESTOR (interactive control under a read-only ancestor)

**Problem:** `DisplayMode` is inherited. A Gallery or container set to
`DisplayMode.View` makes every descendant button, input and toggle non-interactive even
when the child sets `DisplayMode.Edit`. The controls can still look enabled, so Preview
shows a false affordance and clicks silently fail.

**Detect:** For every button, input, toggle, date picker or other interactive control,
walk its ancestors. Flag any ancestor that sets `DisplayMode: =DisplayMode.View` or
`Disabled`. This is especially common on a nonselectable Gallery that also contains Edit
or row-action buttons.

**Fix:** Leave the ancestor in `DisplayMode.Edit` and control selection separately:

```yaml
- EventGallery:
    Control: Gallery
    Variant: Vertical
    Properties:
      Selectable: =false
      DisplayMode: =DisplayMode.Edit
```

Set `DisplayMode` only on the individual action when it genuinely needs to be disabled.

**Exception:** A deliberately read-only subtree with no interactive descendants.

---

## Check 30 — HIDDEN-BOUNDED-LIST (small bounded gallery hidden in nested scrolling)

**Problem:** A short, known roster is placed in a fixed-height Gallery inside an already
scrollable screen. The Gallery creates a second scroll region and silently hides rows;
Studio may not render a visible scrollbar even when `ShowScrollbar: =true`. Users see
four of six people and have no cue that more exist.

**Detect:** For every Gallery inside a root scroll container:

1. If its Items source is a bounded local collection with roughly ten or fewer rows,
   compare `Height` with `CountRows(Items) * TemplateSize` plus template padding.
2. Flag it when the fixed height is smaller than the full list, regardless of
   `ShowScrollbar`.
3. Flag a list that can open at a non-zero internal scroll position without an explicit
   reset-to-top behavior.

**Fix:** Let small bounded lists grow and rely on the root scroll:

```yaml
Height: =CountRows(Self.AllItems) * Self.TemplateSize
ShowScrollbar: =false
```

For genuinely large or unbounded data, keep the internal scroll region but provide a
visible affordance and reset it to the first row on screen entry.

**Exception:** Large/unbounded datasets where virtualization and internal scrolling are
intentional and visibly discoverable.

---

## Check 31 — SEMANTIC-VALUE-BINDING (semantic display control missing its visible value)

**Problem:** Semantic controls can render sample placeholder text when the property that
drives their visible value is absent. A `Badge` with a correct `AccessibleLabel`,
`ThemeColor` and shape but no `Content` can display a literal placeholder such as `AB`
for every row while the accessibility tree announces the real status.

**Detect:** For every semantic display control, require its visible value property:

- `Badge`: `Content`
- `Avatar`: its name/text/image property from the exact control definition
- `ModernCard`: Title, Subtitle, Description and image slots per Check 23
- Any other semantic control: the content/value property returned by `describe_control`

An `AccessibleLabel` is not the visible value binding.

**Fix:** Bind the semantic content to the record:

```yaml
- StatusBadge:
    Control: Badge
    Properties:
      Content: =ThisItem.Status
      AccessibleLabel: ="Assignment status " & ThisItem.Status
```

**Exception:** A purely decorative semantic control explicitly intended to have no
visible value.

---

## Check 32 — ACTION-LABEL-FIT (multiword action label does not fit its control)

**Problem:** A multiword button or link with no explicit width uses a small platform
default. Labels such as `Add to my itinerary`, `Back to speakers`, or `CSV import setup`
wrap one word per line or clip inside a tiny square while the surrounding row is mostly
empty.

**Detect:** For every interactive control with a text label:

1. If the label has more than one word or more than about 12 characters, require an
   explicit `Width` or `LayoutMinWidth` that fits it at each breakpoint.
2. In a vertical AutoLayout parent, do not treat `AlignInContainer.Stretch` alone as
   proof that a ModernButton will fill the row. Require `Width: =Parent.Width`;
   `LayoutMinWidth` alone does not satisfy this case.
3. If the label intentionally wraps, confirm the control height fits every line plus
   padding. Navigation labels should normally remain one line.

**Fix:**

```yaml
Width: =If(Parent.Width < 640, Parent.Width, 220)
LayoutMinWidth: =160
Height: =48
```

For four-item phone navigation, allocate equal widths that fit the parent without
wrapping; shorten labels or use icons when the full labels cannot fit.

**Exception:** A deliberately compact icon-only action whose visible text is omitted.
