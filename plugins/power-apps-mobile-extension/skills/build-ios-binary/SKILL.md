---
name: build-ios-binary
description: "Compile a PAM control's iOS Obj-C/Swift module into the FLAT device-slice `.framework` for a `.ppmplugin` bundle (never an `.xcframework` — the wrap CI won't descend into one). Mac-only (Xcode). Builds from a throwaway staged copy so canonical `ios/` and the podspec stay untouched, references React-Core headers only (React is weak-linked and provided by the wrap host at runtime, no CocoaPods), generates the required umbrella header, module map and Info.plist, sets the critical build settings, asserts manifest conformance, then runs a device-only `xcodebuild archive` and copies out the flat framework to `ppmplugin/staging/ios/`. Known limitation — the React weak-link flags aren't yet validated against a live wrap host and the RN pin must match the host's. Run after /generate-ppmplugin-manifest for an iOS or Both target, before /assemble-ppmplugin."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill
model: sonnet
---

# /build-ios-binary

Turns the extension's iOS **source** (`ios/RCT<Pascal>Module.{h,m}`) into the **flat `<Pascal>Plugin.framework/`** (device slice) that the wrap runtime loads. iOS analogue of [`/build-android-binary`](../build-android-binary/SKILL.md): source in, a prebuilt framework out.

> **Ship a FLAT `.framework`, NOT an `.xcframework`.** The wrap pipeline expects `ios/<Name>.framework` and does not descend into an `.xcframework` — shipping one fails with *"Framework '<Name>.framework' not found in plugin."* This skill builds the **device archive only** and copies out the flat `.framework`. See [`ppmplugin-format §5b`](../../shared/ppmplugin-format.md).

> **Mac-only.** Requires Xcode. On Linux/Windows this skill BLOCKs — Android-only contributors can't produce the iOS slice.
>
> **KNOWN LIMITATION — read this.** The single hard part is **React-Core**: the framework compiles against React's headers (`#import <React/RCTBridgeModule.h>`) from the control repo's own pinned `react-native` devDep, while **never embedding React** — the wrap host provides it at runtime (weak-link). The coupling that matters is the **RN version pin** (`0.79.7`): it must match the RN the wrap host ships. The exact weak-link flags / header-search-path setup aren't yet validated against a live wrap host — that's the main risk area. React symbol/header errors mean the RN pin diverged from the host's RN, not a code bug.

Read [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md) §5b (iOS binary requirements) and the [`naming-conventions.md`](../../shared/naming-conventions.md) iOS rows.

## What this skill does NOT do
- Does not author `manifest.json` (run [`/generate-ppmplugin-manifest`](../generate-ppmplugin-manifest/SKILL.md) first — this skill reads it for cross-checks and the framework/moduleClass names).
- Does not zip the `.ppmplugin` — that's [`/assemble-ppmplugin`](../assemble-ppmplugin/SKILL.md).
- Does not build Android — that's `/build-android-binary`.
- Does not modify the canonical `ios/` or the podspec — all adjustments live in a throwaway copy under `ppmplugin/staging/ios-build/`.
- Does not sign the framework — the wrap pipeline signs at packaging time (given `BUILD_LIBRARY_FOR_DISTRIBUTION=YES SKIP_INSTALL=NO`). No signing skill needed.

---

## Step 1 — Read shared docs + prereq block

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md) and [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md).
2. Read `ppmplugin/staging/manifest.json`. If absent, STOP with `NEEDS_CONTEXT: manifest.json missing — run /generate-ppmplugin-manifest first`. If it has no `entrypoints.ios`, STOP with `NEEDS_CONTEXT: manifest targets Android-only — re-run /generate-ppmplugin-manifest and choose iOS/Both`.
3. Read the `## ppmplugin (third-party controls)` block in `.extension-state.md`. **Replace-existing gate:** if `ppmplugin/staging/ios/<framework>.framework` already exists, surface it (with its build timestamp) and ask via `AskUserQuestion` — **Keep existing** (skip to Step 6) vs **Replace (rebuild)**. Default Keep if source + manifest unchanged since the recorded build, else Replace (note Keep is stale). Per [`ppmplugin-format §1`](../../shared/ppmplugin-format.md) replace-existing rule.
4. Run prereq checks and print the visible block (shared-instructions §9.2). **Policy: resolve, don't punt** (locate tools by path; offer + run safe installs):

| Check | Verify | Auto-fix |
|---|---|---|
| **macOS** | `uname` = Darwin | NOT fixable — STOP with `BLOCKED: /build-ios-binary is Mac-only (iOS needs Xcode)` on Linux/Windows |
| Xcode 16+ (26.2+ recommended) | `xcodebuild -version` | NOT auto-fixable — print: install Xcode from the App Store / xcodes; STOP if missing |
| React-Core headers present | `node_modules/react-native/React/Base/RCTBridgeModule.h` exists (the `react-native` devDep, in the control repo) | if the devDep isn't installed: `pnpm install` in the repo |
| CocoaPods (**optional** — fallback path only) | `pod --version` | Not required for the recommended header-only build (Step 2). Only needed if you fall back to the Podfile path; `brew install cocoapods` on confirm. |

---

## Step 2 — React-Core source (self-contained) + confirm the config

The framework needs React's headers at compile time. **The source is the control repo's own `node_modules/react-native`** — the pinned `react-native` devDep (`0.79.7` for pen-input), which ships the React headers (`React/Base/RCTBridgeModule.h`). The build is fully self-contained in the control repo. If the devDep isn't installed, run `pnpm install`; only if it's genuinely absent, ask the user for a `react-native` path.

**Recommended: header-only React (no CocoaPods).** Aggregate the React headers into a flat include dir in the staging copy and point the framework target at it — cleaner and faster than the Pod chain, and it avoids the CocoaPods/React-Codegen failures that bite under recent Xcode (see [`ppmplugin-format §5b`](../../shared/ppmplugin-format.md)):
```bash
mkdir -p ppmplugin/staging/ios-build/include/React
# copy the RN headers the module imports (Base + the Libraries it uses):
cp node_modules/react-native/React/Base/*.h        ppmplugin/staging/ios-build/include/React/
cp -R node_modules/react-native/React/Base node_modules/react-native/Libraries  ppmplugin/staging/ios-build/include/React/ 2>/dev/null || true
```
Then set on the framework target: `HEADER_SEARCH_PATHS = $(inherited) $(SRCROOT)/include` and `OTHER_LDFLAGS = -undefined dynamic_lookup` (weak-links React's symbols — the host provides them at runtime). **`-undefined dynamic_lookup` is deprecated by Apple** (works today, may break in a future Xcode — known caveat).

**Fallback: CocoaPods** — only if the header-only path doesn't suffice. A Podfile referencing the devDep (`pod 'React-Core', :path => '<repo>/node_modules/react-native'`) gives CocoaPods the header map, but on recent Xcode/RN-0.79 you'll need `post_install` patches (boost URL, Yoga `_pt`, RCT-Folly `clockid_t`, boost `std::unary_function`) and may still hit the React-Codegen sandbox failure — all documented in ppmplugin-format §5b.

What matters either way is that the **pinned RN version** (`0.79.7`) matches the RN the wrap host ships at runtime (React is weak-linked, host-provided). Print the detected RN version and ask via `AskUserQuestion` to **confirm / override** the source + version before building. State plainly: *"React is provided by the wrap host at runtime; React symbol/header errors at build or load mean the RN pin has diverged from the host's RN version."*

---

## Step 3 — Stage a standalone Xcode framework project (canonical `ios/` stays pristine)

Like the Android build, work from a throwaway copy so the source the engineer maintains is never touched.

1. **Copy** `ios/*.{h,m}` → `ppmplugin/staging/ios-build/Sources/` (fresh each run).
2. **Generate the umbrella header** `ppmplugin/staging/ios-build/<Pascal>Plugin.h` and mark it a **Public** header (**build hygiene, not runtime-required** — the wrap player `dlopen`s the binary and uses `NSClassFromString`, it never `import`s the module, so the framework loads fine without a module map; the umbrella just silences the `DEFINES_MODULE` warning. Generate it anyway for a clean build). Minimal contents:
   ```objc
   #import <Foundation/Foundation.h>
   FOUNDATION_EXPORT double <Pascal>PluginVersionNumber;
   FOUNDATION_EXPORT const unsigned char <Pascal>PluginVersionString[];
   ```
3. **Generate a standalone Xcode framework project** `ppmplugin/staging/ios-build/<Pascal>Plugin.xcodeproj`, product/target name `<Pascal>Plugin` (= `entrypoints.ios.framework`), compiling the copied sources, with the umbrella as the Public header. Derive from the canonical podspec:
   - **System frameworks** to link: from the podspec `s.frameworks` (e.g. pen-input → `PencilKit, UIKit, CoreGraphics, QuartzCore`).
   - **Deployment target**: from `s.platform` (e.g. `:ios, "14.0"`) — but floor it at the supported PAM shell minimum **iOS 16.0**.
   - **xcodeproj-gem trap** (if generating via the `xcodeproj` gem): when a group already carries its path (e.g. `Sources`), add file refs **filename-only** — `new_group('Sources','Sources')` + `new_reference("Sources/<file>")` doubles to `Sources/Sources/<file>` → file-not-found. Pin a known-good `gen_project.rb` rather than re-deriving it each run.
4. **Set the build settings** (each maps to a documented wrap/on-device failure — see [`ppmplugin-format §5b`](../../shared/ppmplugin-format.md)):

   | Setting | Value |
   |---|---|
   | Mach-O Type | **Dynamic Library** (NOT Static) |
   | Dead Code Stripping | **NO** (preserves the `+moduleName` class method and `RCT_EXPORT_METHOD` metadata the host reads after `dlopen`) |
   | Defines Module | **YES** |
   | Enable Bitcode | **NO** |
   | `HEADER_SEARCH_PATHS` | `$(inherited) $(SRCROOT)/include` (header-only React from Step 2) |
   | `OTHER_LDFLAGS` | `-undefined dynamic_lookup` (weak-link React; host-provided at runtime) |
   | `BUILD_LIBRARY_FOR_DISTRIBUTION` | **YES** |
   | `SKIP_INSTALL` | **NO** |
   | `GENERATE_INFOPLIST_FILE` | **YES** (REQUIRED — a framework with no Info.plist is rejected by the wrap codesign step) |
   | `INFOPLIST_KEY_CFBundleDisplayName` | `<Pascal>Plugin` |
   | `MARKETING_VERSION` | `<version from manifest>` |
   | `CURRENT_PROJECT_VERSION` | `1` |
   | `PRODUCT_BUNDLE_IDENTIFIER` | `com.powerapps.<lowername>` |

The canonical `ios/` + podspec are never modified — report the staging adjustments applied.

---

## Step 4 — Assert manifest conformance

Before building, verify the source matches the manifest (the iOS analogue of the Android DexClassLoader asserts):
- Class name in `ios/RCT<Pascal>Module.h` == `manifest.entrypoints.ios.moduleClass`.
- Class name in the `.m` == `manifest.entrypoints.ios.moduleClass`, and `+ (NSString *)moduleName` returns `manifest.receivers[].nativeModule`.
- Each `RCT_EXPORT_METHOD(<name>:…)` name is on `manifest.receivers[].methods`.
- **The module class instantiates via no-arg `[cls new]`** — the runtime resolves `moduleClass` after loading the framework and constructs it with `[cls new]`. A custom designated initializer that takes arguments breaks instantiation → the plugin is skipped at load. If the `.m` declares an `- (instancetype)initWith…` and no plain `init`, STOP with `BLOCKED: <moduleClass> must support no-arg initialization`.
- **Each `RCT_EXPORT_METHOD` takes one `NSDictionary *request` first param** (then resolver/rejecter) — the wrap proxy spreads the PCF's `args: [request]` positionally. A method expanding the request into multiple positional params won't receive its data; surface a WARNING (a no-arg op like `getStatus` taking only resolver/rejecter is fine — [ppmplugin-format §2](../../shared/ppmplugin-format.md)).

A mismatch means the manifest and the binary disagree — the call won't reach the module on device. STOP with the specific mismatch rather than building a broken pair.

---

## Step 5 — Build the flat `.framework` (device slice only)

Run for real; surface the artifact path, not the streaming log. **Archive the DEVICE slice only** (the wrap CI wants a flat `<Name>.framework`, not an `.xcframework` — see §5b), then copy the framework straight out. **No `-create-xcframework` step.**

```bash
cd ppmplugin/staging/ios-build
# device archive only:
xcodebuild archive -project <Pascal>Plugin.xcodeproj -scheme <Pascal>Plugin \
  -destination "generic/platform=iOS" \
  -archivePath build/<Pascal>Plugin-device.xcarchive \
  SKIP_INSTALL=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES

# copy the flat framework out (NO xcframework wrapper):
rm -rf ../ios/<Pascal>Plugin.framework
cp -R build/<Pascal>Plugin-device.xcarchive/Products/Library/Frameworks/<Pascal>Plugin.framework ../ios/<Pascal>Plugin.framework

strip -x ../ios/<Pascal>Plugin.framework/<Pascal>Plugin   # optional, if size matters
```

(If you built with CocoaPods instead of header-only, archive the `.xcworkspace` scheme rather than the `.xcodeproj` — otherwise identical: still device-only, still copy the flat framework.)

On failure, print the failing step + the most relevant `xcodebuild` error line and STOP with `BLOCKED: xcodebuild failed — <line>`. The likely standalone failures (and where they come from) are pinned in ppmplugin-format §5b — most route back to **React linking** (Step 2): symbol-not-found at link → React not weak-linked (`-undefined dynamic_lookup` missing); `<React/…>` not found → `HEADER_SEARCH_PATHS` wrong; symbol *mismatch* → the RN pin doesn't match the host's RN. Surface these as React/RN-version coupling issues, not extension-code bugs.

**Verify the framework.** `ppmplugin/staging/ios/<Pascal>Plugin.framework/` MUST contain the two runtime-required items:
- `<Pascal>Plugin` — the Mach-O binary, named exactly `<Pascal>Plugin` (the player `dlopen`s `Frameworks/<Pascal>Plugin.framework/<Pascal>Plugin`; a differently-named binary won't load). REQUIRED.
- `Info.plist` — REQUIRED (a framework bundle without it is invalid and fails the wrap codesign step).

If either is missing, STOP with `BLOCKED: framework incomplete — missing <X>` and the §5b fix (`GENERATE_INFOPLIST_FILE=YES` / the binary name == framework name). The umbrella header + `Modules/module.modulemap` are build hygiene — note them if absent, but do NOT block on them (the `dlopen` loader doesn't use them — §5b).

---

## Step 6 — Report + next step

Update the `## ppmplugin (third-party controls)` block in `.extension-state.md`: `iOS framework: built <ISO timestamp> (<Pascal>Plugin.framework, device slice)`. Print a fenced summary with the `.framework` path (and note it carries umbrella + module.modulemap + Info.plist), then offer next steps via `AskUserQuestion` (shared-instructions §9.1 — **invoke the chosen skill via the Skill tool; execute, don't describe**):

- **Run /assemble-ppmplugin** (recommended — zip the manifest + binaries into the `.ppmplugin`)
- **Run /build-android-binary** (if you also need the Android slice for a Both bundle)
- **Stay — I'll inspect the framework first**

Return `DONE` with the `.framework` path, or `BLOCKED` with the failing `xcodebuild` line (most often React linking / an RN-version mismatch with the host — not an extension-code fix).
