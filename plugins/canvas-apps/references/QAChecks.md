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

## Check 1 — LayoutMinWidth / LayoutMinHeight on every AutoLayout child

**Problem:** Power Apps defaults `LayoutMinWidth` to 250 and `LayoutMinHeight` to
100 on children of an AutoLayout `GroupContainer` (any container that sets
`LayoutDirection`). In a sidebar, header, or narrow cell, these defaults
silently push the child wider/taller than intended and clip its siblings.

**Detect:** For every control whose parent has a `LayoutDirection` property
(i.e., it is a child of an AutoLayout `GroupContainer`), check whether
`LayoutMinWidth: =0` and `LayoutMinHeight: =0` are present in `Properties:`.

**Fix:** Add either property if missing:

```yaml
LayoutMinWidth: =0
LayoutMinHeight: =0
```

**Exception:** None. Always set both on every child of an AutoLayout
`GroupContainer`.

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

## Check 3 — FILLPORTIONS-DEFAULT (missing `FillPortions` on AutoLayout child)

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

## Check 4 — SCROLL-TRAP (`FillPortions: =1` inside scroll container)

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

## Check 5 — WRAP-MISSING (single-line label without `Wrap: =false`)

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

## Check 6 — NO-HEIGHT-TRAP (`FillPortions: =0` without explicit `Height`)

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

## Check 7 — TEXT-PADDING (ModernText, Label padding defaults to 5)

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

## Check 8 — FILLPORTIONS-HEIGHT-CONFLICT (both set on the same control)

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

## Check 9 — FILLPORTIONS-WIDTH-CONFLICT (both set on the same control)

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

## Check 10 — CONTROL-VERSION-SUFFIX (`Control:` value contains `@version`)

**Detect:** For every `Control:` property, flag any value that contains an `@` character (e.g. `Control: Text@2.0.0`).

**Fix:** Strip the `@…` suffix, keeping only the bare control name (`Control: Text`).

---

## Plan-Contract QA Checks (Phase 7 only)

The orchestrating skill runs the following checks before and after compilation. Screen builders
must not run them during parallel self-QA.

These checks require access to both the plan document and the YAML files. They do NOT use
arbitrary control-count heuristics — they verify specific planned elements exist.

---

## Check 11 — MISSING-PLANNED-CONTROL

**Problem:** A control required by the plan does not exist in the screen's `.pa.yaml` file.

**Detect:** Collect the exact control names from the screen's Key Controls and Contract and
from journey steps assigned to that screen. Flag each name that is absent from the YAML.

**Fix:** Report the missing control and its plan requirement to Phase 7 for repair.

---

## Check 12 — EMPTY-OR-PLACEHOLDER-HANDLER

**Problem:** A handler listed in the plan's Required Handlers section exists but contains
a placeholder value instead of actual logic.

**Detect:** For each Required Handler, verify the control and event property exist and reject
empty, boolean-only, comment-only, semicolon-only, or stub-text formulas.

**Fix:** Report the handler's current value and required behavior to Phase 7.

---

## Check 13 — INVALID-NAVIGATION-TARGET

**Problem:** A `Navigate()` call targets a screen that is missing or absent from the plan.

**Detect:** For every `Navigate()` call, verify its first argument names both an existing
`.pa.yaml` screen and a screen in the plan's Screens table.

**Fix:** Report the source control and event, target name, and missing file or plan entry to
Phase 7.

---

## Check 14 — MISSING-REQUIRED-FORMULA-BEHAVIOR

**Problem:** A Required Handler exists but omits behavior specified by its Contract.

**Detect:** For each Required Handler, verify its formula contains the concrete function,
target, variable, or other verifiable pattern named by the requirement.

**Fix:** Report the handler, expected behavior, and actual formula to Phase 7.

---

## Check 15 — MISSING-OUTCOME-BEHAVIOR

**Problem:** A screen omits validation, success, failure, refresh, or empty-state behavior
required by its Contract.

**Detect:** For each applicable Outcome Handling requirement, verify the named control,
handler, condition, and formula behavior exist in the YAML.

**Fix:** Report the outcome type, expected behavior, and actual YAML to Phase 7.

---

## Check 16 — UNIMPLEMENTED-JOURNEY-STEP

**Problem:** A journey step from the plan's Journey Step Mapping table is not implemented
in the specified screen/control/handler.

**Detect:** For each row in each Journey Step Mapping table:

1. Extract: Step description, Screen, Control, Event Property, Formula Must Include.

2. Locate the Screen's `.pa.yaml` file.

3. Locate the Control within that screen.

4. Find the Event Property (OnSelect, OnChange, etc.) on that control.

5. Check if the formula contains the required pattern from "Formula Must Include".

6. Flag if:
   - The screen doesn't exist
   - The control doesn't exist
   - The event property is missing or empty
   - The formula doesn't contain the required pattern

**Fix:** This check does not auto-fix. Report to contract verification with the specific
journey step that failed.

**Report format:**

```
UNIMPLEMENTED-JOURNEY-STEP: Journey "[JourneyName]", Step [N]
  Step: "[Step description]"
  Expected: [Screen].[Control].[EventProperty] must include "[Formula pattern]"
  Actual: [What was found, or "control missing" / "handler empty"]
```
