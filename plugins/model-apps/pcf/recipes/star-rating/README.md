# Star rating PCF recipe

`star-rating` is a compact standard field control that lets users choose a whole-number rating with stars. It is the smallest end-to-end PCF recipe: a manifest patch, localized strings, accessible DOM, styles, and unit tests.

## Template

- Template: `field-standard`
- Control type: standard
- Intended field type: `Whole.None`

## Host support

| Host | Designed for | Certified |
| --- | --- | --- |
| Model-driven apps | Yes | Not certified in this release |
| Power Pages | Yes | Not certified in this release |

`recipe.json` intentionally keeps `certified` empty for both hosts. Certification dates should be added only after live host evidence is recorded.

## Configuration

The recipe patches these manifest properties:

| Property | Type | Usage | Required | Notes |
| --- | --- | --- | --- | --- |
| `value` | `Whole.None` | `bound` | Yes | Stores the selected rating. A `null` raw value selects no star. |
| `max` | `Whole.None` | `input` | No | Defaults to `5`; the control clamps maker input to `1..10`. |

A maker can bind it in either designer path:

1. Modern form designer: select the whole-number column, open the **Components** pane, add the control, then bind `value` to the column and optionally set `max`.
2. Classic form designer: open the column's **Controls** tab, add the control, then configure the same `value` and `max` properties.

## Behavior

- Renders a localized ARIA `radiogroup` with one `role="radio"` item per star.
- Uses `aria-checked` and a roving `tabindex` so keyboard focus stays on the active option.
- Supports Arrow keys plus Home and End.
- Respects `context.mode.isControlDisabled`, `security.readable`, and `security.editable`.
- Calls `notifyOutputChanged` only when the selected rating actually changes.
- Returns the chosen whole number from `getOutputs()` for the bound `value` property.
- Keeps state per control instance; no module-global mutable state or hard-coded element ids.

## Limits

- No half-star ratings; this recipe is intentionally `Whole.None` only.
- No network, file, or navigation APIs are used.
- No runtime offline behavior is claimed beyond rendering the current bound value.
- Power Pages support is designed-for but not certified in this release.

## Microsoft Learn references confirmed

- Standard control lifecycle: [`init`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/init), [`updateView`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/updateview), [`getOutputs`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/getoutputs), and [`destroy`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/destroy).
- Bound outputs: Learn states `getOutputs()` returns values for properties with `usage="bound"`, including a property named `value`.
- Manifest properties and resources: [`property`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/property) and [`resources`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/resources).
- Localized strings: [`context.resources.getString`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/resources) reads strings from manifest `.resx` resources.
- Disabled and layout context: [`mode`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/mode) and [`trackContainerResize`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/mode/trackcontainerresize).
- PCF support boundaries: [Code components best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices).
