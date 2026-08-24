# Naming Conventions — Derived Names

Every third-party control has **two independent root names**. Every other identifier in the `.ppmplugin` bundle is mechanically derived from one of them. The PRD MUST capture both; the scaffold MUST NOT guess.

The bundle ships native binaries only — `manifest.json` + `android/<Pascal>Plugin.dex` + a flat `ios/<Pascal>Plugin.framework/`. There is **no TypeScript layer, no `src/<Pascal>Extension.ts`, no `INativeExtension`, and no npm package**. What remains is the native module symbol, the bundle `name`, and the PCF/host-side identifiers.

---

## The two root names

| Root | Form | Used by | Example |
|---|---|---|---|
| **Capability name** | kebab-case | Design discussions, broader product taxonomy | `pdf-control` |
| **Class name** | PascalCase | Native module symbol, DEX/framework filenames, PCF folder | `PdfViewer` |

They are deliberately separable. The capability name groups related work in the broader product taxonomy ("the PDF control"); the class name is the engineering symbol that the bundle's binaries and the `name` field derive from.

Common case: they're the same word in different cases (e.g. capability `barcode-scanner` → class `BarcodeScanner`). Different case: capability `pdf-control` → class `PdfViewer`.

> **The bundle `name` derives from the CLASS name, not the capability name** — `kebab(<className>)`, with a hyphen at every camelCase boundary (`PdfViewer` → `pdf-viewer`). This is required by the canonical-prefix rule: the validator PascalCases the `name` segments back into a prefix that every `nativeModule` must start with. See `./ppmplugin-format.md` §3. (For the common case where capability and class are the same word, this is moot; it only matters when they diverge.)

---

## Derived identifier table

Given a PRD with `capability: pdf-control` and `className: PdfViewer`, every other name is mechanical:

| Identifier | Derived from | Pattern | Example |
|---|---|---|---|
| Bundle `name` (manifest) | className | `kebab(<PascalName>)` | `pdf-viewer` |
| Native module JS symbol (`NativeModules.<X>`) | className | `<PascalName>Module` — **WITH** a `Module` suffix | `PdfViewerModule` |
| Android `getName()` return | className | `<PascalName>Module` (== the JS symbol) | `PdfViewerModule` |
| iOS `+ (NSString *)moduleName` return | className | `<PascalName>Module` (== the JS symbol; NOT `RCT_EXPORT_MODULE`) | `PdfViewerModule` |
| `receivers[].nativeModule` (manifest) | className | `<PascalName>Module` (== the JS symbol) | `PdfViewerModule` |
| Android DEX filename | className | `android/<PascalName>Plugin.dex` | `android/PdfViewerPlugin.dex` |
| iOS framework | className | `ios/<PascalName>Plugin.framework/` (flat, no `Versions/`) | `ios/PdfViewerPlugin.framework/` |
| Android namespace | className → lowercased, no separators | `com.powerapps.<lowercaseclassname>` | `com.powerapps.pdfviewer` |
| PCF folder | className | `pcf/<PascalName>PCF/` | `pcf/PdfViewerPCF/` |
| PCF control name | className | `<PascalName>PCF` | `PdfViewerPCF` |
| PCF namespace | constant | `PowerApps` | `PowerApps` |
| `pac pcf init` invocation | className | `pac pcf init --namespace PowerApps --name <PascalName>PCF --template field --framework none` | — |
| PCF transport (host global) | constant | `window.PowerApps.NativeExtension.sendAsync` | — (the PCF calls this; NEVER `cordova.exec`) |
| Host bridge service (internal to `sendAsync`) | constant | `'SendMessagePlugin'` | — (host-side only; the PCF does not reference it) |
| Receiver / routing name | design contract | pinned in the PRD (NOT derived) | `viewer` |
| Composite routing key (PCF dispatch) | name + receiver | `<name>/<receiver>` | `pdf-viewer/viewer` |

---

## The `Module` suffix — where it does and doesn't go

In the SDK-era first-party model the native module's JS-visible symbol was the *bare* class name (`PdfViewer`) and a separate `Extension`-suffixed name lived on the TS contract layer. **Neither of those applies here.** There is no TS class, no `INativeExtension.name`, and no podspec-for-npm-autolink — so there is no `Extension` suffix anywhere in the bundle.

Instead, the **native module name carries a `Module` suffix**:

- The Android `getName()` return value, the iOS `+ (NSString *)moduleName` return value, the JS-side `NativeModules.<X>` lookup, and the manifest's `receivers[].nativeModule` are **one and the same value**: `<PascalName>Module`. (iOS wrap plugins do **NOT** use `RCT_EXPORT_MODULE` — see the iOS registration note in [`repo-layout.md`](./repo-layout.md) / [`ppmplugin-format.md §5`](./ppmplugin-format.md).)
- The `Module` suffix is not cosmetic — it keeps the symbol **out of the bare-name namespace** that the validator's exact-match denylist guards (see Reserved-name rule below). A bare `DeviceInfo` is reserved by Microsoft; `DeviceInfoModule` is not.

If in doubt: there is exactly one native module symbol per receiver, it ends in `Module`, and the same string appears in Android, iOS, and the manifest.

---

## Reserved-name and generic-noun avoidance

The native module symbol lands in a namespace shared with Microsoft's own modules and with every other loaded `.ppmplugin`, so the name must be both **non-reserved** and **non-generic**:

1. **Reserved prefixes + exact-match denylist.** `nativeModule` must not start with a reserved prefix (`Microsoft`, `MS`, `PowerApps`, `Dataverse`, `Teams`, `Graph`, …) and must not match the ~100-name Microsoft-owned exact-match denylist. The validator enforces both; a known subset is checked locally as a pre-flight block. See `./ppmplugin-format.md` §4 (reserved-prefix list + known reserved-name subset) and the canonical-prefix algorithm in §3.
2. **Generic-noun heuristic.** The denylist holds **bare, generic** names (`DeviceInfo`, `NetworkClient`, …) — exactly what an author reaches for first. Avoid the whole class by (a) keeping the `Module` suffix and (b) preferring a specific, capability-flavored class name over a generic noun. See the generic-noun heuristic in `./ppmplugin-format.md` §4.
3. **`NativeModules` is a shared runtime namespace across all loaded plugins.** Two plugins that both register `DeviceInfo` (or any identical `nativeModule`) **collide at runtime** — the later registration wins or the lookup is ambiguous. A distinctive, suffixed name (`ContosoDeviceInfoModule`) is the only safe form. The validator cannot see other vendors' bundles, so this is the author's responsibility — flag it during PRD review.

---

## Validation

Before scaffolding, check the derived native module symbol:

1. **Reserved-name check.** Verify `nativeModule` (`<PascalName>Module`) does not start with a reserved prefix and is not in the known reserved-name subset. If it is, rename the class (or add a vendor prefix) and re-derive — do not strip the `Module` suffix. See `./ppmplugin-format.md` §4.
2. **`NativeModules`-collision check.** `<PascalName>Module` MUST be distinctive enough not to collide with another vendor's loaded plugin in the shared `NativeModules` namespace. The bundle cannot enumerate other loaded plugins — flag to the user during PRD review if the name is generic (a bare noun + `Module`, e.g. `ScannerModule`).
