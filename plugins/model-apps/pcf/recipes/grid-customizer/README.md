# Grid customizer PCF recipe

`grid-customizer` is a virtual PCF control that registers Power Apps grid cell renderer and editor overrides. It follows the Microsoft Learn grid customizer pattern: the control reads the grid-supplied `EventName` property, raises that event with a customizer object, and then lets the Power Apps grid own all cell rendering.

## Template

- Template: `field-virtual`
- Control type: virtual / React
- Hosts: model-driven apps only
- Extension point: Power Apps grid customizer

## Host support

| Host | Designed for | Certified |
| --- | --- | --- |
| Model-driven apps | Yes | Not certified in this release |
| Power Pages | No | Not certified in this release |

`recipe.json` intentionally keeps `certified` empty. Add certification dates only after live host evidence is recorded.

## Configuration

The recipe patches this manifest property:

| Property | Type | Usage | Required | Notes |
| --- | --- | --- | --- | --- |
| `EventName` | `SingleLine.Text` | `bound` | Yes | Required by the official grid customizer template. The Power Apps grid supplies the event name used to register renderer/editor overrides. |

A maker configures it after the control is packaged and imported:

1. Add the **Power Apps grid control** to the target table/grid.
2. Set the grid's **Customizer control** property to this component's full logical name, for example `<publisher prefix>_Contoso.Controls.GridCustomizer`.
3. Save and publish the table/grid customizations.
4. Open the grid and verify the text-cell renderer/editor behavior.

Microsoft Learn states that multiple customizer controls can exist in an environment, but each grid can have only one customizer control assigned. Use a separate customizer component when two grids need incompatible renderer/editor behavior.

Designer paths:

- Modern form designer: select the grid, open the **Components** pane, add/configure the Power Apps grid control, then set the **Customizer control** property.
- Classic designer: select the table or subgrid **Controls** tab, add/configure the Power Apps grid control, then set the same **Customizer control** property.

## Behavior

- Registers a `PAOneGridCustomizer` in `init` through `EventName`.
- Keeps the documented `factory.fireEvent(eventName, customizer)` call isolated in `customizerBridge.ts`, which carries the `pcf-extension-pattern: grid-customizer` marker accepted by the code gate.
- Supplies `Text` cell renderer and editor overrides as a minimal, accessible starting point.
- Returns `null` for `null` or `undefined` text values so the Power Apps grid uses its internal renderer fallback.
- Does not mutate grid row data, column definitions, or renderer/editor params.
- Keeps state per control instance; there is no module-global mutable state and no hard-coded element id.

## Limits

- Model-driven apps only; Power Pages does not support virtual controls.
- This recipe customizes text cells only. Add more data types in `customizers/CellRendererOverrides.tsx` and `customizers/CellEditorOverrides.tsx`.
- The customizer functions must stay pure and lightweight because the grid can call them repeatedly and can dispose rendered elements at any time.
- Renderers and editors must not write grid data directly. Use the editor callbacks supplied by the grid and normal platform save behavior.
- No network, file, navigation, or Dataverse Web API calls are used.

## Microsoft Learn references confirmed

- Grid customizer pattern, `EventName`, renderer/editor override contracts, `null`/`undefined` fallback, one customizer per grid, and best practices: [Customize the editable grid control](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/customize-editable-grid-control).
- Official template linked by Learn: [PowerApps-Samples GridCustomizerControlTemplate](https://github.com/microsoft/PowerApps-Samples/tree/master/component-framework/resources/GridCustomizerControlTemplate).
- React virtual controls and platform libraries: [React controls & platform libraries](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries).
- Standard control lifecycle used by the generated component: [`init`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/init), [`updateView`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/updateview), [`getOutputs`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/getoutputs), and [`destroy`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/destroy).
- Manifest properties and localized resources: [`property`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/property), [`resources`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/resources), and [`platform-library`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/platform-library).
- PCF support boundaries: [Code components best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices) and [limitations](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/limitations).
