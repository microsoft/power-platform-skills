# Repo Layout — Third-Party Control Repos

What the scaffold writes into the working directory for a **third-party PAM control** — a control that ships as a compiled **`.ppmplugin`** binary (a `manifest.json` plus a precompiled Android **DEX** and/or a flat iOS **`.framework`**), uploaded to the `msdyn_nativeextension` Dataverse table and bundled into the wrap APK at build time.

This is the **native-only** model. There is **no TypeScript contract layer** in the repo and **nothing is published to an npm feed** — the deliverable is the binary bundle, not a source package. The repo holds the native sources the binaries are compiled from, a companion PCF that dispatches to them, and the design/state notebooks. Deviations from this layout break the downstream `/generate-ppmplugin` build skills.

> The bundle format, the `ppmplugin/` staging convention, and the manifest schema are owned by [`./ppmplugin-format.md`](./ppmplugin-format.md). This doc defers all binary/bundle detail there (§1) and describes only the **source repo**.

---

## Full tree

```
<repo-root>/                                  ← plain working directory; nothing is published from here
│
├── .extension-state.md                       ← resume-on-failure notebook (identity + build state)
├── .gitignore                                ← MUST include `ppmplugin/` (gitignored build staging) but NOT `manifest.json` — see ./ppmplugin-format.md §1
├── PRD.md                                     ← contract; written by the design skill
├── ARCHITECTURE.md                            ← native module + receiver design, permissions, build settings
├── README.md                                  ← one-page user-facing guide (optional)
│
├── manifest.json                             ← COMMITTED dispatch-contract source of truth (name + receivers[] + entrypoints);
│                                                 written by /generate-native-extension, read by the PCF + the build stage
├── package.json                              ← DEV-ONLY (see below) — NOT published; no publishConfig, no feed, no `files`
│
├── android/
│   ├── build.gradle                          ← com.android.library; namespace com.powerapps.<lowername>
│   ├── src/main/
│   │   ├── AndroidManifest.xml               ← minimal: <manifest package="com.powerapps.<lowername>"/>
│   │   └── java/com/powerapps/<lowername>/
│   │       ├── <PascalName>Module.kt         ← ReactContextBaseJavaModule; getName() = "<PascalName>Module"
│   │       └── <PascalName>Package.kt        ← ReactPackage registering the module
│   └── (compiled by /build-android-binary → ppmplugin/staging/android/<PascalName>Plugin.dex)
│
├── ios/
│   ├── RCT<PascalName>Module.h
│   ├── RCT<PascalName>Module.m               ← + (NSString *)moduleName returns "<PascalName>Module"  (NOT RCT_EXPORT_MODULE — see note below)
│   └── <PascalName>Plugin.podspec            ← OPTIONAL — declares iOS system frameworks for the build ONLY
│   │                                            (NOT an npm-autolink podspec; there is no npm package to autolink)
│   └── (compiled by /build-ios-binary → ppmplugin/staging/ios/<PascalName>Plugin.framework/ — Mac-only)
│
├── pcf/                                       ← Dispatcher PCF — drives the control on a Power Apps screen
│   ├── README.md                             ← build + pac pcf push instructions
│   └── <PascalName>PCF/                       ← output of `pac pcf init`
│       ├── <PascalName>PCF.pcfproj
│       ├── package.json                       ← uses npm (PCF tooling convention)
│       ├── pcfconfig.json
│       ├── tsconfig.json
│       ├── eslint.config.mjs
│       └── <PascalName>PCF/                    ← pac pcf scaffold puts the control source one level deeper
│           ├── ControlManifest.Input.xml
│           ├── index.ts                       ← dispatches via window.PowerApps.NativeExtension.sendAsync('<name>/<receiver>', { method, args:[request] })
│           ├── PowerAppsNativeExtension.d.ts   ← ambient decl for the host sendAsync global (keeps the PCF host-agnostic)
│           └── (control assets)
│
└── ppmplugin/                                 ← GITIGNORED build staging (STAGED manifest copy + binaries + final bundle)
                                                  written by /generate-ppmplugin; schema in ./ppmplugin-format.md §1
```

> **Two manifests, deliberately.** `./manifest.json` (repo root, **committed**) is the dispatch-contract source of truth — authored by `/generate-native-extension`, read by the PCF and humans. `ppmplugin/staging/manifest.json` (**gitignored**) is the build copy `/generate-ppmplugin-manifest` produces from it (same contract, `entrypoints` trimmed to the shipped target) and `/assemble-ppmplugin` zips. Edit the root file; never hand-edit the staged copy.

There is **no** `src/` TypeScript layer, **no** published-package config (`lib/`, a publishable `tsconfig.json`, a registry/`files` manifest), and **no** CI: the artifact is the `.ppmplugin` binary, distributed by uploading it to the wrap pipeline, not by publishing a source package.

---

## Files the scaffold writes

| File | Purpose | Notes |
|---|---|---|
| `manifest.json` | **Committed dispatch-contract source of truth** | Authored by `/generate-native-extension` from the names it emits — `name` (kebab of the class), `receivers[]` (`name`, `nativeModule` = `getName()`, `methods` = the `@ReactMethod` set), `entrypoints` for every generated platform. Read by `/generate-pcf-companion` (composite key) and `/generate-ppmplugin-manifest` (which validates + stages it). **Tracked** — distinct from the gitignored staged copy under `ppmplugin/`. Schema in [`./ppmplugin-format.md`](./ppmplugin-format.md) §2. |
| `package.json` | Dev-only manifest | Plain local name (e.g. `<kebab>-control`). Exists so the iOS build can resolve React Native headers (the `react-native` devDep) and the Android build can resolve the `react-android` coordinate. **Not published** — no `publishConfig`, no feed registry, no `files` array. See shape below. |
| `android/build.gradle` | Android library | `com.android.library` plugin. namespace `com.powerapps.<lowername>`. JDK 17. Consumed by `/build-android-binary` (which copies it into a throwaway Gradle project to emit the DEX). |
| `android/src/main/AndroidManifest.xml` | Manifest | Minimal `<manifest package="com.powerapps.<lowername>"/>`. Add `<uses-permission>` entries from ARCHITECTURE §1.4. |
| `android/src/main/java/.../`<br>`<PascalName>Module.kt` | Native Android module | Extends `ReactContextBaseJavaModule`. `getName()` returns **`<PascalName>Module`** (this is the `receivers[].nativeModule` the manifest declares). `@ReactMethod`-annotated functions are the dispatchable methods. |
| `android/src/main/java/.../`<br>`<PascalName>Package.kt` | `ReactPackage` registration | Registers `<PascalName>Module`. (Used at compile time; the DEX is loaded at runtime via `DexClassLoader`.) |
| `ios/RCT<PascalName>Module.h` + `.m` | Native iOS module | Conforms to `<RCTBridgeModule>`. Exports its JS name via **`+ (NSString *)moduleName { return @"<PascalName>Module"; }`** — registering it as `NativeModules.<PascalName>Module` for the wrap host. **Do NOT use `RCT_EXPORT_MODULE`** — its `+load`/`_RCTRegisterModule` is invisible to `dlopen`'s flat namespace, so the module never loads on device (`native module 'X' not loaded`). The Obj-C class name (`RCT<PascalName>Module`) equals `entrypoints.ios.moduleClass` and may keep the `RCT` prefix even though `+moduleName` does not. `RCT_EXPORT_METHOD` names ⊆ the manifest's `methods`. |
| `ios/<PascalName>Plugin.podspec` | iOS framework decls (optional) | If present, declares the iOS **system frameworks** the module links (e.g. `s.frameworks = "PencilKit"`). Used only to feed `/build-ios-binary`'s Xcode project — it is **not** an RN-autolink podspec and there is no npm package referencing it. |
| `pcf/<PascalName>PCF/` | Dispatcher PCF | Scaffolded via `pac pcf init --namespace PowerApps --name <PascalName>PCF --template field --framework none`. Dispatches to the control through the host-injected global `window.PowerApps.NativeExtension.sendAsync('<name>/<receiver>', { method, args: [request] })` — `<name>` is the manifest's plugin name, `<receiver>` is a `receivers[].name`. The PCF must NEVER call `cordova.exec` directly (not exposed to the PCF sandbox — fails silently on device). Ships a local `PowerAppsNativeExtension.d.ts` ambient decl. |
| `.extension-state.md` | Resume notebook | Identity + ppmplugin build state. See template below. |
| `.gitignore` | | `node_modules/`, Android/iOS build dirs, `pcf/**/{out,Solutions,node_modules,obj,bin,generated}/`, and **`ppmplugin/`** (build staging — never committed; see [`./ppmplugin-format.md`](./ppmplugin-format.md) §1). Does **not** ignore `manifest.json` — the root file is committed source. |

> The composite routing key `<name>/<receiver>` and the `nativeModule` → `NativeModules.<nativeModule>.<method>` dispatch are defined by the **Runtime dispatch contract** in [`./ppmplugin-format.md`](./ppmplugin-format.md) §2. Android `module.getName()` / iOS `+ (NSString *)moduleName` MUST equal the manifest's `receivers[].nativeModule` — here, `<PascalName>Module`.

---

## `package.json` shape (dev-only)

A minimal manifest whose only job is to pin the React Native version the native builds compile against. It is **never published**: no `publishConfig`, no feed registry, no `files` array, no `.npmrc`.

```json
{
  "name": "<kebab>-control",
  "version": "0.1.0",
  "private": true,
  "description": "<from PRD>",
  "devDependencies": {
    "react": "18.2.0",
    "react-native": "0.79.7"
  }
}
```

- `name` is a plain local name — it is **not** an `@powerapps/...` feed package and never reaches a registry.
- `private: true` makes the no-publish intent explicit.
- The `react-native` devDep supplies the iOS headers (`/build-ios-binary`) and pins the `react-android` coordinate the Android build resolves (`/build-android-binary`); add any other build-time devDeps the native modules need.

---

## `.extension-state.md` template

The scaffold writes this at the end of its run. Every downstream `/generate-ppmplugin` build skill reads + updates it.

```markdown
# Extension State

## Identity
- Capability: <kebab>
- Class: <PascalName>
- Native module: <PascalName>Module
- Android package: com.powerapps.<lowername>
- PRD: ./PRD.md (sha: <git-sha-of-PRD-at-scaffold>)

## ppmplugin (third-party controls)
<!-- Compiled-binary build state. Written by /generate-ppmplugin and its stage skills
     (/generate-ppmplugin-manifest, /build-android-binary, /build-ios-binary,
     /assemble-ppmplugin); read on re-run for idempotent update mode. Schema details
     defer to ./ppmplugin-format.md §1. Empty until a build runs. -->
- Target: <android-only | ios-only | both | unset>
- Manifest: written <ISO timestamp> | not written
- Android DEX: built <ISO timestamp> (<PascalName>Plugin.dex) | not built
- iOS framework: built <ISO timestamp> (<PascalName>Plugin.framework) | not built
- Bundle: <name>.ppmplugin assembled <ISO timestamp> (v<version>, platforms: <list>) | not assembled
```

> The native module name in the identity block (`<PascalName>Module`) IS the manifest's `receivers[].nativeModule`. The Android `module.getName()` / iOS `+moduleName` symbol, the manifest, and this line MUST all agree (see [`./ppmplugin-format.md`](./ppmplugin-format.md) §2–§3).

---

## Naming rules (HARD — every downstream skill derives paths from these)

See [`./naming-conventions.md`](./naming-conventions.md) for the full mapping. The minimum invariants for the third-party-control track:

- iOS / Android native module name (Android `getName()` / iOS `+moduleName`, and the manifest's `receivers[].nativeModule`) = `<PascalName>Module`.
- Android namespace = `com.powerapps.<lowercasename>` (no separators, lowercased).
- PCF folder = `pcf/<PascalName>PCF/`; the PCF dispatches on the composite key `<name>/<receiver>`.
- The plugin `name` in `manifest.json` and the canonical-prefix rule it must satisfy are owned by [`./ppmplugin-format.md`](./ppmplugin-format.md) §2–§3.

The capability name (kebab) and class name (Pascal) are independent inputs in the PRD — e.g. `pdf-control` (capability) → `PdfViewer` (class) → `PdfViewerModule` (native module) is valid.
