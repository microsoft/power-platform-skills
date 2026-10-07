# Native controls in a verified release

Read the [release lifecycle](../../../shared/references/mobile-release-lifecycle.md)
first. Resolve the existing app, not the newest plugin template:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"
```

The explicit local diagnostic path may carry `--diagnostic-artifacts` through
this check, as documented by the lifecycle. It still requires the exact control
in the verified installed inventory and actual selected Android player metadata.
It cannot admit an absent aggregate/leaf or claim iOS/device validation.

Missing/unknown release records block native mutations. A package manifest,
successful import, or successful TypeScript check does not prove that a player
or wrapped base contains matching native code. Do not install the aggregate to
fix older binaries. Upgrade only through a separately approved, exact verified
release migration.

## Public imports are release-conditional

`@microsoft/power-apps-native-controls` at the root is metadata, not a runtime
barrel. When the resolved release includes the aggregate, use these subpaths:

| Capability | Public subpath | Runtime exports |
|---|---|---|
| PDF viewer | `@microsoft/power-apps-native-controls/pdf` | `NativePdfViewer` |
| Pen/signature | `@microsoft/power-apps-native-controls/pen` | `PenInputNative`, `PenInputStatus`, `PenInputErrorCode` |
| Geolocation | `@microsoft/power-apps-native-controls/geolocation` | `BgLocationClient`, `geoService`, `AuthMethod`, `ConnectionType` |

There is no barcode subpath. Barcode/QR scanning stays with the resolved
release's `expo-camera` wrapper.

Controls **0.2.0** corresponds to PDF **0.2.9**, pen **0.1.9**, background
location **0.2.3**, and extension SDK **0.4.2**, with an **Expo 55 /
React Native 0.83.6** baseline. These are package facts, not a claim that a
verified player/base is available, and not evidence of Expo 57 compatibility.
Read the installed public README, exports, and types for the selected version;
do not infer newer method signatures or copy a different library's examples.

Legacy leaf imports are allowed only when the resolved release actually includes
the matching leaf and version:

- `@microsoft/power-apps-native-pdf-viewer`
- `@microsoft/power-apps-native-pen-input`
- `@microsoft/power-apps-native-bglocation`

Choose one literal module specifier at generation time. Do not emit a dynamic
package-name import, import both paths, or try the aggregate and fall back to a
leaf at runtime. Metro must resolve imports even when an execution branch is
not taken. Native wrappers must guard `Platform.OS` for `ios` / `android`
**before** lazy `import(...)` inside `try`/`catch`. Return explicit unsupported
or failure results; no fake native implementation.

## Native configuration is host/base owned

`enableNativeControls` is host-owned plugin registration, not a consumer
workaround. Use it only on a **verified host release** that supports it, and
only as part of that release's migration. Published host **0.4.0 lacks it**.
Never inject it into an older host or copy native config into an app.

Keep these separate:

1. Package inclusion in JS and the native binary.
2. OS declarations built into the base.
3. Runtime permission grants on the device.
4. Whether the app actually invokes a capability.

Removing controls dependencies, disabling controls, or not calling them does
**not** remove unused default Android permissions. The customer uses a fixed
capability base. Different declarations need another verified base; optional
per-customer permission wrapping is deferred. Missing declarations cannot be
repaired by a runtime permission request.

## Location modes and ownership

A one-shot read uses `new BgLocationClient().getCurrentLocation()` and requires
no `app_id`, data source, target table, or `startTracking`. It still requires a
matching native binary and the appropriate device location grant.

Continuous tracking is a separate workflow. For background-location **0.2.3**,
`startTracking` requests background permissions even with
`trackInBackground: false`; do not advertise a foreground-only permission mode.
Tracking is shared: `stopTracking()` and `isTracking()` have no `app_id`
parameter. Coordinate a single owner across screens/consumers; never stop a
session merely because an unrelated screen unmounts. Do not promise per-app
isolation.

Read that installed version's full `geoService(dataSource, app_id)` contract,
permission behavior, persistence options, and MSAL/Dataverse mapping before
implementing tracking. Do not substitute `configureSync`, `HttpSyncContract`,
or APIs from the unrelated `powerapps-geolocation-control` library.
