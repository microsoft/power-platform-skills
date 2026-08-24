---
name: audit-ppmplugin
description: "Statically audit a built `.ppmplugin` before wrap testing. Checks archive layout, manifest compatibility, bundle consistency, Android DEX integrity and SDK leakage, iOS framework structure, native source-to-receiver alignment, and the PCF composite-key/sendAsync transport contract. Reports CRITICAL, WARNING, and INFO findings with fixes routed to the owning stage; never modifies the archive. Requires `jar`; `dexdump` or `strings` improves DEX inspection. Run after /assemble-ppmplugin or standalone on an existing bundle."
---

# /audit-ppmplugin

The verification gate. `/assemble-ppmplugin` proves the bundle is *well-formed*; this skill proves it will *actually load and dispatch* on the wrap runtime. Most `.ppmplugin` failures are silent — the bundle uploads fine, then a method returns `native module 'X' not loaded`, the runtime cannot instantiate the package class, or the upload is rejected with `0x80040265` (canonical-prefix violation). Those cost a full wrap-build round-trip to discover. This skill surfaces them in seconds, on disk.

It is **read-only on the bundle** — it unzips to a temp dir for inspection and never mutates the `.ppmplugin`. Fixes route back upstream (`/generate-ppmplugin-manifest` for manifest issues, the build skills for binary issues), then re-assemble + re-audit.

Read [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md) §1 (layout), §3 (canonical-prefix), §4 (validator rules), §5 (Android DEX requirements) — this skill enforces all four against the *built artifact*.

## What this skill does NOT do
- Does not build, zip, or author anything — it inspects a finished `.ppmplugin`. Fixes are made upstream and re-assembled.
- Does not patch the zip in place — a bundle is an immutable deliverable; mutating it would desync it from the staged sources. It points at the upstream skill instead.
- Does not upload to Dataverse / wire into a canvas app (Stage 3 — deferred). "READY TO UPLOAD"
  means *passes local verification*, not *uploaded*.

---

## Step 1 — Read shared docs + resolve the artifact + prereqs

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md) and [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md).
2. **Resolve the bundle to audit:**
   - If the user passed a path, use it. If it's a directory, look for `<dir>/*.ppmplugin` (prompt if multiple).
   - Else default to the assemble output: the single `ppmplugin/<name>.ppmplugin` at the repo root (the most-recently-built if several).
   - If none found, STOP with `NEEDS_CONTEXT: no .ppmplugin to audit — run /assemble-ppmplugin first, or pass a path`.
3. Prereq block (shared-instructions §9.2). **Policy: resolve, don't punt** (§1.5) — locate a tool by path before failing:

| Check | Verify | If missing |
|---|---|---|
| `jar` (JDK) | `jar --version` — used to list + extract the bundle | STOP `BLOCKED: jar not found — install a JDK (JDK 17)` |
| DEX scanner | `dexdump` (preferred — locate in Android SDK `build-tools/*/dexdump` like `/build-android-binary` resolves `$D8`); else `strings` (mac/linux ships it) | If neither: the DEX **string** checks degrade to WARNING ("DEX scan skipped — no dexdump/strings"); structural checks (magic, size) still run. On Windows without either, note the gap. |

4. **Extract** the bundle to a fresh temp dir for inspection (read-only on the original):
   ```bash
   work=$(mktemp -d); ( cd "$work" && jar xf "<abs path to .ppmplugin>" )
   ```
   ```powershell
   $work = New-Item -ItemType Directory -Force (Join-Path $env:TEMP "ppm-audit"); Push-Location $work; jar xf "<abs path>"; Pop-Location
   ```

Each subsequent step appends findings to a running list as `[SEVERITY] <check-id>: <result>`. Don't stop at the first CRITICAL — collect everything so the user fixes in one pass. Severities: **CRITICAL** (will fail at upload or on device — blocks), **WARNING** (likely-wrong, may still work), **INFO** (style / advisory).

---

## Step 2 — Category A: Zip structure

Listing comes from `jar tf "<.ppmplugin>"`. The bundle is **native-only** ([format §1](../../shared/ppmplugin-format.md)): `manifest.json` at root + only the declared `android/` / `ios/` slices.

| Check | Asserts | Severity |
|---|---|---|
| `zip-manifest-at-root` | `manifest.json` is at the archive root | CRITICAL |
| `zip-only-native-slices` | top-level entries ⊆ { `manifest.json`, `android/`, `ios/` } | CRITICAL |
| `zip-no-ts-js-layer` | NO `src/`, `*.ts`, `*.tsx`, `*.js`, `extension.js`, `extension.hbc` anywhere — the bundle ships no TS/JS layer | CRITICAL |
| `zip-no-build-dirs` | NO `android-build/`, `ios-build/`, `node_modules/`, `dist/`, `build/` leaked in | CRITICAL |
| `zip-no-stray-files` | NO `META-INF/`, `.DS_Store`, dotfiles, nested `*.zip`/`*.ppmplugin` | WARNING |
| `zip-reasonable-size` | bundle < 50 MB (a larger one usually means React or node_modules got swept in) | WARNING |

A `src/` tree, an `extension.js`/`.hbc`, or any `*.ts` is **SDK-era / JS-layer leakage** — flag CRITICAL and point at [format §6](../../shared/ppmplugin-format.md) (the bundle is native binaries only).

---

## Step 3 — Category B: Manifest schema, validator rules + field leakage

Read the extracted `manifest.json`. Re-run **every** [`ppmplugin-format §4`](../../shared/ppmplugin-format.md) rule against the *built artifact* (defense in depth — the manifest may have been hand-edited after `/generate-ppmplugin-manifest`):

| Check | Asserts | Severity |
|---|---|---|
| `mf-name-shape` | `name` matches `^[a-z0-9][a-z0-9-]{0,63}$` | CRITICAL |
| `mf-canonical-prefix` | each `receivers[].nativeModule` starts with the canonical prefix of `name` (split on `-`/`_`, PascalCase each segment, join — [§3](../../shared/ppmplugin-format.md)) (Ordinal, case-sensitive) | CRITICAL |
| `mf-reserved-prefix` | no `nativeModule` starts with a reserved prefix (case-insensitive list in §4: `Microsoft`, `MS`, `Intune`, `Wrap`, `Pcf`, `PowerApps`, …) | CRITICAL |
| `mf-reserved-exact-known` | no `nativeModule` matches the locally checked incompatible-name subset (§4: `DeviceInfo`, `AuthenticationHelper`, `NetworkClient`, `DataverseOfflineProvider`, `IntuneMAM`). **Non-exhaustive**; fix = rename `getName()` to a non-reserved form (add `Module` suffix or a vendor prefix) and re-derive | CRITICAL |
| `mf-nativeModule-generic-noun` | `nativeModule` does NOT match the generic-platform-noun heuristic `^(Device\|Network\|File\|Audio\|Camera\|Sensor\|Location\|Storage\|Notification\|Bluetooth\|Wifi\|Media\|Photo\|Contact\|Calendar\|Battery)` — these bare names are both denylist-prone and collision-prone in the shared `NativeModules` namespace. (Heuristic, not the real list — `DeviceInfo` returned READY locally yet was server-rejected; this would have warned.) | WARNING |
| `mf-methods` | every `receivers[].methods` is present, non-empty, ≤32, each matches `^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$` | CRITICAL |
| `mf-receiver-name` | each `receivers[].name` matches the JS-identifier regex | CRITICAL |
| `mf-version-present` | `version` is a non-empty string | WARNING |
| `mf-no-sdk-fields` | NO `entrypoints.js`, `entrypoints.ts`, `extension.js`, `extension.hbc`, `extensionClassName`, `jsLayer` fields in the manifest. **Our native-only policy, NOT a server gate** — the wrap injector treats `entrypoints.js` as *optional* and accepts it; we flag it so the native-only bundle stays unambiguous. WARNING, not a block. | WARNING |

Note in the report that only a **known subset** of incompatible exact names is checked locally
(`mf-reserved-exact-known`), so a clean local result does not guarantee the upload service will
accept the name.

---

## Step 4 — Category C: Manifest ↔ bundle consistency

The declared `entrypoints` must match the binaries actually in the zip — exactly. (`/assemble-ppmplugin` reconciles this at build time; auditing the *finished* bundle catches a hand-edited manifest or a hand-zipped bundle.)

| Check | Asserts | Severity |
|---|---|---|
| `consistency-has-native` | at least one of `entrypoints.android` / `entrypoints.ios` is declared (a manifest-only bundle has nothing to load) | CRITICAL |
| `consistency-android-dex` | if `entrypoints.android` declared → `android/<entrypoints.android.dex>` exists in the zip | CRITICAL |
| `consistency-ios-framework` | if `entrypoints.ios` declared → `ios/<entrypoints.ios.framework>.framework/` exists in the zip (flat framework — see `ios-flat-framework-not-xcframework` in Category E) | CRITICAL |
| `consistency-no-orphan` | every `android/` or `ios/` slice in the zip is backed by a matching declared entrypoint (no undeclared binary the runtime won't route) | WARNING |
| `consistency-packageClass-shape` | `entrypoints.android.packageClass` is a fully-qualified Java class name (`^([a-z][a-z0-9_]*\.)+[A-Z][A-Za-z0-9_]*$`) | CRITICAL |
| `dispatch-composite-key` | the composite routing key `<name>/<receivers[].name>` is well-formed (both segments present, JS-identifier-safe suffix) — this is what a dispatcher PCF binds as `ReceiverKey` to reach `NativeModules.<nativeModule>.<method>` ([format §2](../../shared/ppmplugin-format.md) — *Runtime dispatch contract*) | WARNING |

---

## Step 5 — Category D: DEX integrity + SDK-leakage byte-scan (Android)

Only if `entrypoints.android` is declared. The DEX is loaded via `DexClassLoader` ([format §5](../../shared/ppmplugin-format.md)); these confirm it's loadable and free of SDK-era leakage. Use `dexdump -l plain <dex>` if available, else `strings <dex>` — both expose the string/type pool the checks scan.

| Check | Asserts | Severity |
|---|---|---|
| `dex-magic` | first bytes are `dex\n03[5-9]` (valid DEX) | CRITICAL |
| `dex-has-packageClass` | the `entrypoints.android.packageClass` type descriptor (`Lcom/.../<Pascal>Package;`) is in the DEX — otherwise runtime class loading fails | CRITICAL |
| `dex-has-module-class` | the module class descriptor is in the DEX | CRITICAL |
| `dex-no-INativeExtension` | NO `INativeExtension`, `INativeOperation`, `INativeExtensionContext` strings — SDK-era symbols in a native-only bundle. **Cleanliness policy, not a server gate**: the player ignores them (an old-pattern plugin still dispatches if its `receivers[]` map to real native modules), so surface it but don't block. | WARNING |
| `dex-no-jslayer-loader` | NO `HermesBytecodeLoader`, `WrapPluginJsLayerLoader` strings — a JS-layer loader has no place in a native-only DEX (same: flagged, not blocking). | WARNING |
| `dex-no-sendAsync` | NO `sendAsync` symbol — possible SDK transport leak | WARNING |

These SDK-leakage checks are the heart of the native-only contract: a clean compile can still pull these symbols in transitively. Scanning the *built DEX* is the only place they're catchable.

---

## Step 6 — Category E: iOS framework structure (the wrap-CI gates)

Only if `entrypoints.ios` is declared. The CRITICAL set is exactly what the runtime's `dlopen` loading and wrap signing pipeline require. The umbrella header + module map are build hygiene only (the loader `dlopen`s the binary; it never `import`s the module), so they're INFO — **do not block a valid bundle on their absence.**

| Check | Asserts | Severity |
|---|---|---|
| `ios-flat-framework-not-xcframework` | the bundle ships `ios/<framework>.framework/` — **NOT** `ios/<framework>.xcframework/`. If an `.xcframework` is present, FAIL with the wrap-CI error verbatim (*"Framework '<Name>.framework' not found in plugin"*) and the fix: rebuild with `/build-ios-binary` (device slice, flat framework — drop `-create-xcframework`). | CRITICAL |
| `ios-binary-present` | `ios/<framework>.framework/<framework>` (the Mach-O binary, named **exactly** `<framework>`) exists — the loader `dlopen`s `Frameworks/<framework>.framework/<framework>`, so a missing or differently-named binary won't load | CRITICAL |
| `ios-framework-has-infoplist` | `ios/<framework>.framework/Info.plist` exists with `CFBundlePackageType=FMWK`, `CFBundleExecutable=<framework>`, `CFBundleIdentifier`, `CFBundleShortVersionString`, `MinimumOSVersion` — a framework bundle with no Info.plist is invalid and the wrap codesign step rejects it | CRITICAL |
| `ios-framework-has-umbrella` | `ios/<framework>.framework/Headers/<framework>.h` umbrella header present — **build hygiene only**; the `dlopen` loader does not `import` the module, so its absence does NOT break loading | INFO |
| `ios-framework-has-modulemap` | `ios/<framework>.framework/Modules/module.modulemap` present — **build hygiene only** (same reason); not runtime-required | INFO |
| `ios-moduleClass-match` | `entrypoints.ios.moduleClass` is the documented Obj-C class (`RCT<Pascal>Module`) and, when source is reachable, the `.h`/`.m` class name matches it | WARNING |
| `ios-moduleName-matches` | when source is reachable, the `.m` declares `+ (NSString *)moduleName` returning `receivers[].nativeModule` and does **not** use `RCT_EXPORT_MODULE(...)` (wrap plugins are registered by the runtime, not `+load`) | CRITICAL |

(Deep Mach-O introspection — Dynamic-vs-Static, dead-code-stripping, weak React link — is owned by `/build-ios-binary` at build time; here we verify the shipped framework is what the loader + wrap CI ingest.)

---

## Step 7 — Category F: Source-to-receiver contract (when the repo is reachable)

These need the extension source. If the audit runs in the control repo (the bundle's source tree is present), run them; else mark each `SKIPPED — source not reachable` and note that the build skills already asserted them at build time.

| Check | Asserts | Severity |
|---|---|---|
| `src-getName-matches` | the Kotlin module's `getName()` literal == `receivers[].nativeModule` — mismatch = `native module 'X' not loaded` on device (compiles fine; hardest to catch) | CRITICAL |
| `src-methods-annotated` | every `receivers[].methods[]` entry has a matching `@ReactMethod` (Android) / `RCT_EXPORT_METHOD` (iOS) | CRITICAL |
| `src-package-fqn-matches` | the `ReactPackage` FQN == `entrypoints.android.packageClass` | CRITICAL |
| `src-package-no-arg-ctor` | the `<Pascal>Package` (Android) has a public no-arg constructor — the runtime uses `getDeclaredConstructor().newInstance()`; a primary-constructor parameter list (`class <Pascal>Package(...)`) makes the plugin silently fail to load (`Loaded 0 plugin package(s)`). iOS analogue: the module class instantiates via `[cls new]` (no custom arg-ed initializer). | CRITICAL |
| `src-ios-module-no-arg-init` | (iOS) the module class has **no arg-ed-only initializer** — the player does `NSClassFromString(moduleClass)` → `[cls new]`, so a class whose only initializer takes arguments won't instantiate and is **skipped at load** ([§5b](../../shared/ppmplugin-format.md)). | CRITICAL |
| `src-ios-requires-main-queue` | (iOS) if `+ (BOOL)requiresMainQueueSetup` is declared, it returns **`NO`** (returning `YES` forces main-thread setup at launch and, with any heavy/throwing `init`, stalls or crashes startup — [§5b](../../shared/ppmplugin-format.md)). | WARNING |
| `src-method-single-map-param` | each `@ReactMethod` / `RCT_EXPORT_METHOD` takes **one** `ReadableMap`/`NSDictionary` request param (then the Promise/resolver) — the wrap proxy spreads the PCF's `args:[request]` positionally, so a method with multiple positional params won't receive its payload (a no-arg op taking only the Promise is fine). | WARNING |
| `pcf-composite-key-matches-receiver` | if a sibling PCF (`pcf/<…>/index.ts`) declares `COMPOSITE_KEY = "<name>/<receiver>"` (or binds a `ReceiverKey`), it MUST equal `<manifest.name>/<receivers[].name>` — a mismatch means the PCF dispatches to a receiver the manifest never registers, failing on first call (real bug: PCF→`Snapshot`, manifest→`DeviceInfoExtension`). | WARNING |
| `pcf-uses-sendasync` | **if a sibling PCF (`pcf/<…>/index.ts`) is present, it MUST dispatch via `window.PowerApps.NativeExtension.sendAsync(...)` and MUST NOT call `cordova.exec` (or any `cordova.*`) directly.** A direct `cordova.exec` call is the CRITICAL defect: the raw `cordova` global is not exposed to the PCF sandbox, so the call is a silent no-op on device (worst on Android) — it passes zip/manifest/DEX/key checks and only fails on-device. Fix: route through the host-injected `sendAsync` global ([format §2](../../shared/ppmplugin-format.md)). | **CRITICAL** |
| `pcf-envelope-is-raw-object` | if a sibling PCF is present, the `sendAsync` payload MUST be a **raw** `{ method, args: [...] }` object — the PCF must NOT pre-`JSON.stringify` it (`sendAsync` stringifies internally). A `sendAsync(key, JSON.stringify({...}))` double-encodes → the proxy `JSON.parse` yields a string, not `{method,args}` → **`BRIDGE_FAILED`**. Fix: pass the object literal, not a stringified one. | **CRITICAL** |
| `pcf-args-is-array` | if a sibling PCF is present, the inner `args` inside the `sendAsync` payload is a **JSON array** (`args: [request]`), not a bare object — after parsing, the wrap proxy does `Array.isArray(parsed.args) ? parsed.args : []` and drops a non-array, so the native method gets no payload ([format §2](../../shared/ppmplugin-format.md)). | WARNING |
| `pcf-has-ambient-dts` | if a sibling PCF is present, it ships a local `PowerAppsNativeExtension.d.ts` ambient declaration (typing `window.PowerApps.NativeExtension.sendAsync`) rather than importing a host SDK package — keeps the PCF host-agnostic. | INFO |
| `src-no-ReactModule-annotation` | the module has no `@ReactModule` annotation (incompatible with `DexClassLoader` — [format §5](../../shared/ppmplugin-format.md)) | CRITICAL |
| `src-ctor-no-throwable-sideeffects` | **Scope the scan to the module's *construction closure*, not the whole file** — the primary/secondary constructor(s), the Kotlin `init{}` block(s), property initializers that run at construction (`private val x = …`), PLUS any private function they call (follow one level of `foo()` / `this.foo()`). Within that closure, flag: (a) `register*Callback(…, null)` or a bare `Handler()` / `Handler(...)` with no explicit `Looper`; (b) any side-effecting call (`register*`/`add*Listener`/`observe`/`getSystemService`+use/file or network I/O/`runBlocking`) **not** inside a `try { } catch`. `@ReactMethod` bodies are OUT of scope (they run per-call, not at construction). The module is constructed **eagerly at bridge startup on a possibly Looper-less thread** — an uncaught throw crashes the host at launch, before any UI ([format §5](../../shared/ppmplugin-format.md)). Fix: defer to lazy first-call init, pass `Handler(Looper.getMainLooper())`, wrap unavoidable init in try/catch. **iOS analogue:** apply the same scan to a throwing/heavy `-init` (instantiated eagerly via `[cls new]`, §5b). Heuristic — the definitive catch is `/test-native-extension` Layer 1's load/init readiness asserts (static) + Layer 5's runtime launch crash-scan. | WARNING |
| `pcf-response-unwraps-message` | if a sibling PCF is present, its `sendAsync` success path unwraps the wrap **response container** (`{isUpdate, message:"<json>"}`) — i.e. calls an `extractResponse`-style helper (parse `result.data` + probe `message`), not a bare single `JSON.parse`. A single-parse-only handler lands on the container and fails every call with `UNEXPECTED_PAYLOAD` though native succeeded ([format §2](../../shared/ppmplugin-format.md)). | WARNING |
| `src-promise-always-settled` | each `@ReactMethod` / `RCT_EXPORT_METHOD` that takes a `Promise` / resolver+rejecter contains at least one `promise.resolve` / `promise.reject` (or `resolve(...)` / `reject(...)`) on a reachable path. A Promise-taking method that can return without settling leaves the maker with a **hung control** and no code/message. | WARNING |
| `src-listener-released` | each `register*` / `add*Listener` / `observe` / acquired manager in the module has a matching release (`unregister*` / `remove*Listener` / `.close()` / `.release()`) in `invalidate()` / `onCatalystInstanceDestroy()` / teardown. A registered callback with no release leaks and can fire into a dead module. | WARNING |

---

## Step 8 — Report + route fixes

Print the verdict as a visible fenced block (shared-instructions §9.1). Prefix each severity per `shared-instructions.md §9.3` — 🔴 CRITICAL, 🟡 WARNING, 🔵 INFO, 🟢 READY — keeping the word so meaning survives a no-emoji terminal:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 audit-ppmplugin — pen-input.ppmplugin
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Path: ppmplugin/pen-input.ppmplugin   (v0.1.4, Android-only, 3.4 KB)
 🔴 CRITICAL: 0   🟡 WARNING: 1   🔵 INFO: 0   SKIPPED: 4 (source not reachable)

 🟡 [WARNING] zip-no-stray-files: .DS_Store present in android/
   Fix: re-run /assemble-ppmplugin (it excludes dotfiles).

 ⓘ The upload service may apply additional name checks not represented locally.
 🟢 ✓ READY TO UPLOAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

(When there **are** CRITICALs, the verdict line reads 🔴 and the last line is `🔴 ✗ NOT READY — fix the CRITICAL findings above`.)

Each non-clean finding carries **`Fix:`** with the concrete next action, routed to the owning skill (never a zip patch):
- Manifest rule / leakage field → "edit + re-run `/generate-ppmplugin-manifest`, then `/assemble-ppmplugin`."
- DEX leakage / missing class → "the Android source pulled in SDK symbols — strip the import; re-run `/build-android-binary` then `/assemble-ppmplugin`."
- Zip stray-file / structure → "re-run `/assemble-ppmplugin`."

Then surface next steps via `AskUserQuestion` (shared-instructions §9.1):
- **Clean (0 CRITICAL):** offer **Re-run /generate-ppmplugin-manifest** (only if a WARNING points there) / **Stay — I'll upload manually** (Stage 3 is not yet a skill). When the user picks a `Run /…` option, invoke it via the Skill tool in the same turn (§8 + §9.1 "execute, don't describe").
- **Dirty (≥1 CRITICAL):** offer to jump to the owning skill of the first CRITICAL — **Run /generate-ppmplugin-manifest** or **Run /build-android-binary** — then re-assemble + re-audit. Invoke on selection.

Update the `## ppmplugin (third-party controls)` block in `.extension-state.md`: `Audit: <name>.ppmplugin <ISO timestamp> — <CRITICAL>C/<WARNING>W (READY | BLOCKED)`.

Return code:
- `DONE` — 0 CRITICAL (clean, or warnings only ⇒ note them). The bundle passes local verification.
- `BLOCKED: audit found <N> CRITICAL — see findings` — refuse the READY verdict; do not claim it's uploadable.
