# PCF best practices

Use this reference when designing or reviewing Power Apps component framework (PCF) controls for model-driven apps and supported Power Pages surfaces. The baseline platform guidance is Microsoft Learn: [overview](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview), [best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices), [limitations](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/limitations), and the [manifest schema](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/).

## Non-negotiables

| Practice | Why it matters | Source |
| --- | --- | --- |
| Ship production bundles, not development bundles. | Learn warns development builds hurt performance and can be blocked because of size. This plugin also checks that `PcfBuildMode` is effective, not merely present. | [Best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices#avoid-deploying-development-builds-to-dataverse) |
| Use documented PCF APIs and documented Microsoft extension patterns only. | Internal `context`, host DOM, `Xrm`, parent window and storage shortcuts can break without notice and are blocked by gates. | [Best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices#avoid-using-unsupported-framework-methods), [limitations](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/limitations) |
| Request network and metadata resources in `init`, render loading states in `updateView`. | `updateView` can run before asynchronous data is ready. | [Best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices#use-init-method-to-request-network-required-resources) |
| Clean up in `destroy`. | Hosts can remove and reload controls; leaked handlers and sockets become runtime bugs. | [Best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices#clean-up-resources-inside-the-destroy-method) |
| Treat null and missing values as normal. | Learn states `updateView` may receive null before data is ready. Unsaved records also have no record id. | [updateView](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/updateview) |
| Minimize `notifyOutputChanged`. | Per-keystroke output notifications can flood the host. Notify on committed edits or debounced changes. | [Best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices#minimize-calls-to-notifyoutputchanged) |

## Manifest and versioning

- The manifest is the contract that filters where the component can be configured and how properties are exposed. Keep namespace, constructor and property names stable after first deployment; the skill gates removals and required-property additions because existing bindings can break.
- Use exact toolchain and package versions from `compatibility-matrix.json` and the committed lockfiles. Do not copy versions from a fresh `pac pcf init` without checking the matrix.
- Virtual controls use platform libraries in model-driven apps only. Use the rendered host and platform-library tables in `pcf-hosts.md` for the current baselines, documented declaration ranges, tooling-accepted ranges and observed exclusions.
- Power Pages targets in this release must be standard field controls with no platform-library declarations. This release supports Power Pages only for standard field controls: the form-field journey and the standalone Liquid journey (`{% codecomponent %}`), both guided. Dataset controls on Pages (form sub-grid and list) are not supported in this release. Learn says React controls and platform libraries are not supported in Power Pages: [React controls FAQ](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries#faq).
- Run `node "${PLUGIN_ROOT}/scripts/pcf-gates.js" --project <dir>` before deploy. Do not weaken gates to pass; fix the manifest, source, tests or version matrix.

## Lifecycle and rendering

- Keep `init` small: cache callbacks, create the root, start safe asynchronous reads, and call `context.mode.trackContainerResize(true)` only when the layout needs allocated dimensions. Learn documents host-specific width/height behavior and test-harness differences: [trackContainerResize](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/mode/trackcontainerresize).
- Keep `updateView` idempotent. It can be called for value changes, layout changes, metadata, read-only state, visibility and offline changes.
- Render null-first: show empty, loading, disabled or permission-denied states instead of throwing. The shipped templates check missing parameter objects and `security.readable` / `security.editable`.
- Scope CSS under the generated root class. Never rely on host DOM selectors.
- Avoid `100vh` / `100vw` inside model-driven forms; prefer `width: 100%`, content-driven height for field controls and `height: 100%` for dataset containers when the host provides it.

## Dataset controls

- Dataset paging APIs are serial. Learn states `loadExactPage`, `loadNextPage` and `loadPreviousPage` do not support parallel execution: [Paging](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/paging).
- Latch before each void-returning paging call and disable both paging buttons immediately. Release the latch on the first subsequent `updateView` where `dataset.loading !== true`, or on an error; do not require an intermediate loading update. Keep buttons disabled while latched or while the dataset is loading: [Paging](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/paging), [loading](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/dataset#loading).
- `dataset.refresh()` reloads data and resets paging to page 1; do not call it unguarded from `updateView`: [refresh](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/dataset/refresh).
- Preserve user context. If sorting, filtering or search changes, reset intentionally and announce it in UI; otherwise keep the current page where the API allows it.
- Use `openDatasetItem` only for hosts where Learn marks it available, and treat it as model-driven/canvas behavior, not a Power Pages navigation promise: [openDatasetItem](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/dataset/opendatasetitem).
- Grid customizers are a documented Microsoft extension pattern. Keep the bridge isolated, use the `EventName` property from the official pattern, return `null`/`undefined` to fall back to the internal renderer, and never mutate grid data from a renderer. Learn says each grid can have a single customizer control: [editable grid customization](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/customize-editable-grid-control).

## Data access and host features

- Prefer `context.webAPI` for Dataverse data in model-driven apps and Power Pages. Learn marks WebAPI available for model-driven apps and portals: [WebAPI](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/webapi).
- Guard optional host methods at the method level, for example `typeof context.device?.captureImage === 'function'`. A namespace object existing does not prove the method is callable. Put the call inside the `if` block that performs the check: the source gate doesn't recognize early-return guards or aliases, and reports those calls.
- Do not use browser storage for business data. Learn says `localStorage` and `sessionStorage` are not secure or reliably available for PCF data: [limitations](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/limitations).
- External service calls can make the control premium when declared in the manifest. Keep domains explicit and explain the licensing impact: [overview licensing](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview#licensing).

## Form interaction

PCF controls should not directly use `formContext`. Learn recommends a bound column plus a form `OnChange` handler when model-driven form logic needs to react to a control: [best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices#dont-interact-directly-with-formcontext).

- For value output, update the bound property in `getOutputs()` and call `notifyOutputChanged()` only when the value is actually changed. Learn documents that `getOutputs()` returns values for bound properties: [getOutputs](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/getoutputs).
- For validation and save coordination, make the control write a clear bound value or status column and let a form `OnChange` / business rule / command bar validation own save blocking. Do not call undocumented form APIs from PCF.
- For sibling refresh, have the sibling depend on the bound output or a supported event route; avoid reaching across the host DOM.
- Preview event routes such as manifest events, `context.events` and `addEventHandler` must be treated as preview. Keep a bound-output fallback until current Microsoft Learn marks the event route available for the target host.
- Handle two instances on one form: no module-global mutable state, no hard-coded element ids, no singleton event subscriptions.

## Accessibility, localization and theming

- Use semantic HTML, keyboard support and ARIA names for custom interactions.
- Use manifest resources (`resx`) for user-visible strings where the control will ship broadly; the manifest schema includes `resx` resources for model-driven and canvas apps: [manifest schema](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/).
- Respect host disabled, visible and security states. Show a non-sensitive message when a user cannot read a value; do not leak raw values.
- Map maker-configurable theme inputs to Fluent tokens or CSS variables. Virtual controls should align with the host Fluent design system when platform libraries are used: [React controls](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries).

## Performance and bundle size

- Keep controls small and focused. Oversized bundles slow import and can hit platform upload limits.
- Avoid repeated metadata and Web API calls from `updateView`. Cache per control instance and invalidate intentionally.
- Budget for deployed verification, not just harness success. Learn lists harness limitations for WebAPI, paging, sorting, filtering, model-driven security and navigation APIs: [debugging](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/debugging-custom-controls#common-limitations-when-using-the-test-harness).

## Public-repo hygiene

Use placeholders such as `https://contoso.crm.dynamics.com`, `contoso` and `{…}` in examples. Do not record real environment URLs, tenant ids, organization names, internal hosts or links to issue trackers in reference docs.
