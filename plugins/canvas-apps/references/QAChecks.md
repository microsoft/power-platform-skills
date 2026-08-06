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

## Check 11 — EMPTY-NAV-TARGET (navigation to screen with no content)

**Problem:** A `Navigate()` call points to a screen that exists but contains only empty
containers — no leaf controls, no data bindings, no meaningful content. Users can navigate
to the screen but see nothing useful. This is a symptom of incomplete screen generation,
not a layout issue.

**Detect:** For each `.pa.yaml` file in the working directory:

1. Extract all `Navigate()` calls (may appear in `OnSelect`, `OnVisible`, or other handlers).
   Handle multiline formulas, conditional navigation (`If(..., Navigate(...))`), and
   transition arguments (`Navigate(Screen, ScreenTransition.Fade)`).

2. For each unique target screen name found in `Navigate()` calls, locate the corresponding
   `.pa.yaml` file.

3. Read the target screen's `.pa.yaml` and check whether it contains at least one **leaf
   control** — any control that is not a container (`GroupContainer`, `Screen`). Examples
   of leaf controls: `Button`, `ModernText`, `Label`, `Gallery`, `DataTable`, `Form`,
   `TextInput`, `Image`, `ModernCard`, etc.

4. Flag any navigation target that:
   - Has no controls at all (only the screen definition), OR
   - Has only `GroupContainer` controls with no children, OR
   - Has only `GroupContainer` controls whose children are also empty containers

**Fix:** This check **does not fix automatically**. Empty navigation targets indicate the
screen builder failed to implement the screen's planned content.

1. **Report the violation** with the source control, the `Navigate()` formula, and the
   empty target screen name.

2. **Do not remove the navigation.** The navigation was planned and approved — removing it
   silently violates the user's requirements.

3. **Escalate to the skill's Phase 7 contract verification**, which will reinvoke
   the screen builder with explicit repair instructions.

**Exception:** A confirmation screen or transition screen that intentionally shows only a
brief message (e.g., "Saving..." spinner, "Success!" acknowledgment) before auto-navigating
elsewhere is valid. If the screen's plan contract explicitly states it is a transient screen
with no primary content, do not flag it.

**Note:** This is a syntactic guard, not a functional completeness check. A screen with one
button satisfies this check even if that button does nothing. Full functional verification
is handled by Phase 7's plan contract verification, not by this QA check.

---

## Plan-Contract QA Checks

The following checks compare the generated `.pa.yaml` files against `canvas-app-plan.md`.
They run before and after compilation during Phase 7.

These checks require access to both the plan document and the YAML files. They do NOT use
arbitrary control-count heuristics — they verify specific planned elements exist.

---

## Check 12 — MISSING-PLANNED-CONTROL

**Problem:** A control specified in the plan's Per-Screen Specification (Primary Content,
Primary Interaction, or Key Controls) does not exist in the screen's `.pa.yaml` file.

**Detect:** For each screen in the plan:

1. Extract control names from:
   - Primary Content (e.g., "Gallery named `TaskList`" → look for `TaskList`)
   - Primary Interaction (e.g., "Button named `SubmitBtn`" → look for `SubmitBtn`)
   - Key Controls list
   - Required Handlers (e.g., "SaveBtn.OnSelect" → look for `SaveBtn`)

2. Read the screen's `.pa.yaml` and search for each control name.

3. Flag any control name from the plan that does not appear in the YAML.

**Fix:** This check does not auto-fix. Report the violation to the skill's contract
verification phase, which will reinvoke the screen builder with repair instructions.

**Report format:**

```
MISSING-PLANNED-CONTROL: [ScreenName].pa.yaml
  Missing: [ControlName] (specified in [Primary Content / Primary Interaction / Key Controls])
  Plan requirement: "[exact text from plan]"
```

---

## Check 13 — EMPTY-OR-PLACEHOLDER-HANDLER

**Problem:** A handler listed in the plan's Required Handlers section exists but contains
a placeholder value instead of actual logic.

**Detect:** For each Required Handler in the plan (format: `ControlName.HandlerProperty`):

1. Locate the control in the `.pa.yaml` file.
2. Find the handler property (OnSelect, OnChange, OnVisible, etc.).
3. Check if the handler value matches any placeholder pattern:
   - Empty: `=` (nothing after the equals sign)
   - Boolean placeholder: `=false` or `=true` (when used as a stub)
   - Comment only: `=// TODO`, `=// FIXME`, `=// not implemented`
   - Stub string: `="TODO"`, `="not implemented"`, `="placeholder"`
   - Semicolon only: `=;`

4. Flag any handler that matches a placeholder pattern.

**Fix:** This check does not auto-fix. Report the violation to contract verification.

**Report format:**

```
EMPTY-OR-PLACEHOLDER-HANDLER: [ScreenName].pa.yaml
  Control: [ControlName]
  Handler: [HandlerProperty]
  Current value: [the placeholder value]
  Plan requirement: "[what the handler must do, from Required Handlers]"
```

---

## Check 14 — INVALID-NAVIGATION-TARGET

**Problem:** A `Navigate()` call references a screen that either:

- Does not exist as a `.pa.yaml` file, or
- Is not listed in the plan's Screens table

**Detect:** For each `.pa.yaml` file:

1. Extract all `Navigate()` calls from all handler properties.
2. Parse the target screen name (first argument to Navigate).
3. Check if a corresponding `.pa.yaml` file exists in the working directory.
4. Check if the target screen is listed in the plan's Screens table.

5. Flag any navigation target that fails either check.

**Fix:** This check does not auto-fix. Invalid navigation targets indicate either:

- A typo in the Navigate() call (fix in the source screen)
- A missing screen (the target screen builder failed)

Report to contract verification for repair.

**Report format:**

```
INVALID-NAVIGATION-TARGET: [SourceScreen].pa.yaml
  Control: [ControlName]
  Handler: [HandlerProperty]
  Navigate target: [TargetScreenName]
  Issue: [File does not exist / Not in plan]
```

---

## Check 15 — MISSING-REQUIRED-DATA-OPERATION

**Problem:** A handler that the plan specifies must perform a data operation (Patch, Remove,
Collect, ClearCollect, SubmitForm, UpdateContext, Set) does not contain that operation.

**Detect:** For each Required Handler in the plan:

1. Parse the requirement text for data operation keywords:
   - "must call Patch()" → look for `Patch(`
   - "must call Remove()" → look for `Remove(`
   - "must call Collect()" → look for `Collect(`
   - "must call ClearCollect()" → look for `ClearCollect(`
   - "must call SubmitForm()" → look for `SubmitForm(`
   - "must set [variable]" → look for `Set([variable]` or `UpdateContext({[variable]`

2. Locate the handler in the `.pa.yaml` file.
3. Check if the handler formula contains the required pattern.

4. Flag any handler missing its required data operation.

**Fix:** This check does not auto-fix. Report to contract verification.

**Report format:**

```
MISSING-REQUIRED-DATA-OPERATION: [ScreenName].pa.yaml
  Control: [ControlName]
  Handler: [HandlerProperty]
  Required operation: [Patch / Remove / etc.]
  Plan requirement: "[exact text from Required Handlers]"
  Current formula: [first 100 chars of handler]
```

---

## Check 16 — MISSING-VALIDATION-BEHAVIOR

**Problem:** The plan's Outcome Handling specifies validation behavior, but the screen
does not implement input validation.

**Detect:** If the plan's Contract → Outcome Handling → Validation is non-empty:

1. Identify the form or input controls mentioned in the validation requirement.
2. Check for validation patterns in the submit handler:
   - `If(IsBlank(` or `If(!IsBlank(`
   - `IsMatch(`
   - `Len(` comparisons
   - Form validation: `Form.Valid` or `EditForm.Valid`

3. Flag if no validation pattern is found in the submit handler.

**Fix:** This check does not auto-fix. Report to contract verification.

**Report format:**

```
MISSING-VALIDATION-BEHAVIOR: [ScreenName].pa.yaml
  Plan requirement: "[validation requirement from Outcome Handling]"
  Submit handler: [ControlName.OnSelect]
  Issue: No validation pattern found
```

---

## Check 17 — MISSING-SUCCESS-BEHAVIOR

**Problem:** The plan's Outcome Handling specifies success feedback, but the screen
does not implement it after data operations.

**Detect:** If the plan's Contract → Outcome Handling → Success feedback is non-empty:

1. Locate the handler that performs the data operation (from Required Handlers).
2. Check for success feedback patterns:
   - `Notify(` with success message
   - `Navigate(` after the data operation (if the requirement specifies navigation)
   - `Set(` to a success state variable
   - Conditional logic that handles the success case

3. Flag if no success feedback pattern is found after the data operation.

**Fix:** This check does not auto-fix. Report to contract verification.

**Report format:**

```
MISSING-SUCCESS-BEHAVIOR: [ScreenName].pa.yaml
  Plan requirement: "[success feedback requirement from Outcome Handling]"
  Data operation handler: [ControlName.OnSelect]
  Issue: No success feedback pattern found after [Patch/Remove/etc.]
```

---

## Check 18 — MISSING-FAILURE-BEHAVIOR

**Problem:** The plan's Outcome Handling specifies failure/error feedback, but the screen
does not implement error handling.

**Detect:** If the plan's Contract → Outcome Handling → Failure feedback is non-empty:

1. Locate the handler that performs the data operation.
2. Check for error handling patterns:
   - `IfError(` wrapper around the data operation
   - `IsError(` check after the operation
   - `Errors(` function reference
   - `Set(` to an error state variable within error handling

3. Flag if no error handling pattern is found around the data operation.

**Fix:** This check does not auto-fix. Report to contract verification.

**Report format:**

```
MISSING-FAILURE-BEHAVIOR: [ScreenName].pa.yaml
  Plan requirement: "[failure feedback requirement from Outcome Handling]"
  Data operation handler: [ControlName.OnSelect]
  Issue: No error handling pattern (IfError/IsError) found
```

---

## Check 19 — UNIMPLEMENTED-JOURNEY-STEP

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
