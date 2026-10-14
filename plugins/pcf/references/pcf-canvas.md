# PCF in canvas apps

This reference supports the `/pcf` canvas mode. It covers guided setup, the environment feature an admin must enable, and the limits the skill reviews by hand.

Primary Learn sources: [Code components for canvas apps](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/component-framework-for-canvas-apps) and [Limitations](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/limitations).

## Support boundary

- Canvas support is guided in this release. Build and gate a canvas-targeted control with the model-driven profile. For a canvas-only target, `pcf-gates.js` without `--hosts` defaults to `model`; record `hosts` as `["model"]` in `pcf-intent.json` and leave model-driven form bindings empty. If the control also targets Power Pages, keep `pages` in `hosts` and gate with `--hosts model,pages` so the Pages rules still apply.
- That profile covers standard and virtual controls. Learn's [React controls FAQ](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries#faq) says React controls and platform libraries are supported in canvas and model-driven apps.
- `canvas` is not a `--hosts` or intent host value in this release. The automated hosts remain `model` and `pages`; the compatibility matrix is unchanged.
- Canvas API limits are not checked automatically. Review them by hand with the user, deploy through the normal push flow, then guide the environment setting and Studio steps below.
- A canvas gate profile, reading the environment setting and automated runtime evidence are not implemented in this release. A green model-driven gate is not proof of canvas API compatibility or runtime behavior.

## Turn on the feature

Code components work in canvas apps only after **Power Apps component framework for canvas apps** is turned on in each environment that uses them. By default, the feature is enabled only for model-driven apps.

System administrator privileges are required to turn it on, and a Power Apps license is required. Guide an admin through the setting; the skill does not read or change it automatically.

Power Platform admin center → **Environments** → select the environment → **Settings** → expand **Product** → **Features** → turn on **Power Apps component framework for canvas apps** → **Save**.

## Add the control in Studio

The component's solution must already be in Dataverse; the normal `pac pcf push` flow registers the control for the environment.

1. In Power Apps Studio, open the app → **Add** (+) on the left pane → **Get more components** → the **Code** tab → select the component → **Import**.
2. Then **+** → expand **Code components** → select the component to add it.

The **Insert → Custom → Import component** path is deprecated.

## Updates

- Change the manifest `version` for every change. Publish all customizations first, or the update does not appear.
- Studio updates an existing code component only when the app is closed and reopened; it then asks to update.
- To make re-imported properties appear on the default **Properties** tab, update the manifest version; they stay available on the **Advanced** properties tab.
- Deleting the component and adding it again doesn't update it; close and reopen the app instead.

## API limits

- Microsoft Dataverse-dependent APIs, including WebAPI, are not available in canvas apps yet. Do not design a canvas control around `context.webAPI`; check each API's availability in the [API reference](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/).
- Custom auth in code components is not supported in canvas apps; use connectors instead.

## Security

Studio shows a warning about potentially unsafe code when an app contains code components. The `Default` publisher appears for code components imported in an unmanaged solution or installed with `pac pcf push`. Admins should review code components before making them available.

## What to tell the user

- Name the model-driven gate profile and the manual canvas API review separately; do not report a canvas-specific automated gate.
- Report whether the admin confirmed the environment feature and whether the user completed the Studio import/setup steps. If not checked, say so.
- Report `runtime-not-checked` unless the user checks the control in Power Apps Studio. Record only the behavior the user observed; registration or import alone is not runtime verification. Use the evidence vocabulary in [pcf-testing.md](pcf-testing.md).

## Troubleshooting

If the component is missing from **Get more components → Code**, or Studio still shows an old version, use the canvas entries in [pcf-troubleshooting.md](pcf-troubleshooting.md).
