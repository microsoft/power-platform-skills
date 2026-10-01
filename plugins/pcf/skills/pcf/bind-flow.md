# /pcf bind flow

Binding places a registered PCF control on a model-driven form, grid or Power Apps grid configuration. Microsoft Learn documents code components at https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview and grid customizers at https://learn.microsoft.com/en-us/power-apps/developer/component-framework/customize-editable-grid-control.

## Modern designer field binding

1. Open the table form in the modern designer.
2. Select the target column.
3. Open **Components** → **+ Component**.
4. Pick the PCF component.
5. Map bound/input properties.
6. Choose clients.
7. Select **Done**, then **Save** and **Publish**.

## Classic designer field binding

1. Open the field properties.
2. Open **Controls**.
3. Select **Add Control…** and choose the PCF.
4. Map properties, choose web/phone/tablet clients, save and publish.

## Sub-grid and dataset binding

- Modern designer: select the sub-grid, open **Components**, add the dataset control, map property sets, save and publish.
- Classic designer: select the sub-grid or table-wide control surface, open the **Controls** tab, add the dataset control, map property sets, save and publish.

## Power Apps grid customizer

For the Power Apps grid, configure the grid's **Customizer control** property with the full control name, for example `<publisher prefix>_Contoso.Controls.GridCustomizer`. Each grid can have one customizer control. Use the `grid-customizer` recipe README for the supported bridge pattern.

## Verify binding

Run after saving and again after publishing:

```powershell
node "${PLUGIN_ROOT}/scripts/verify-pcf.js" --env <url> --control <prefix_ns.ctor> [--version <x.y.z>] --table <logical> --form <name|guid> (--column <col>|--control-id <id>) [--clients web,phone,tablet] [--param name=column:<col>] [--param name=static:<value>[:<type>]] [--workspace <dir>]
node "${PLUGIN_ROOT}/scripts/verify-pcf.js" --env <url> --control <prefix_ns.ctor> [--version <x.y.z>] --intent @pcf-intent.json [--workspace <dir>]
```

Two checks are distinct and must not be conflated:

- **Clients**: `--clients` names clients that must use this control. Default is web. Intent `clients` arrays must contain at least one of `web`, `phone` or `tablet` after trimming. If a requested client does not use the control, verifier reports `PCF_BIND_CLIENT_MISSING`.
- **Form factors**: every FormXML binding must declare all three factors: phone `0`, tablet `1`, web `2`. A test-environment probe on 2026-09-29 observed the platform reject a web-only declaration with `Custom control declaration for form factor(s) 0,1 is missing`. Verifier reports `PCF_BIND_FACTOR_UNDECLARED` as an error. This is separate from runtime `context.client.getFormFactor()` values documented at https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/client/getformfactor.

## Unbind and teardown

Before deleting or replacing a control, remove it from every form/grid or reset to the default control, save and publish, then verify again. Observed behavior on 2026-09-29: deleting a bound control failed until unbind → publish → delete. Use `pcf-inventory.js --where-used` as a dependency hint, not as proof that Liquid/text references do not exist.
