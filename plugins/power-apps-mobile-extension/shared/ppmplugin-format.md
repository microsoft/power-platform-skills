# `.ppmplugin` Bundle Format — Reference

> The `.ppmplugin` is the **binary distribution** of a PAM native extension for the **wrap** runtime: a zip containing a `manifest.json` plus prebuilt native binaries. It ships a precompiled Android **DEX** (loaded at runtime via `DexClassLoader`) and/or an iOS **framework**, and is uploaded for validation before the wrap build bundles it into the mobile app.
>
> **Compatibility authority.** This file defines the plugin's public bundle contract and local
> compatibility checks. The live upload service remains authoritative and can apply additional
> validation; if an upload error conflicts with this document, preserve the error and update these
> checks rather than bypassing it.

This file is the single source of truth for the third-party-control track. The **only entry point is [`/generate-ppmplugin`](../skills/generate-ppmplugin/SKILL.md)** — it drives the five stages below in order; the user never invokes a stage directly:
- [`/generate-ppmplugin-manifest`](../skills/generate-ppmplugin-manifest/SKILL.md) — validates the committed `./manifest.json` + stages a build copy (authors from source only as a fallback for hand-authored modules).
- [`/build-android-binary`](../skills/build-android-binary/SKILL.md) — compiles the Kotlin module to `<Pascal>Plugin.dex`.
- [`/build-ios-binary`](../skills/build-ios-binary/SKILL.md) — compiles the Obj-C module to a flat `<Pascal>Plugin.framework` (Mac-only).
- [`/assemble-ppmplugin`](../skills/assemble-ppmplugin/SKILL.md) — zips the manifest + binaries into the final `.ppmplugin` and verifies its layout.
- [`/audit-ppmplugin`](../skills/audit-ppmplugin/SKILL.md) — verifies the built bundle against the wrap-runtime contract (validator rules + DEX SDK-leakage scan + source-to-receiver contract); the final upload-readiness gate.

---

## 1. Bundle layout

```
<name>.ppmplugin              ← a zip (built with `jar cMf`)
├── manifest.json
├── android/                            ← present iff `entrypoints.android` is declared
│   └── <PascalName>Plugin.dex
└── ios/                                ← present iff `entrypoints.ios` is declared
    └── <PascalName>Plugin.framework/   ← FLAT device-slice framework — NOT .xcframework (see §5b)
        ├── <PascalName>Plugin          ← Mach-O dynamic binary (named exactly == framework; dlopen target) — REQUIRED
        ├── Info.plist                          ← REQUIRED — wrap codesign rejects a framework with no Info.plist
        ├── Headers/<PascalName>Plugin.h        ← umbrella header — build-hygiene only (player dlopens, doesn't import)
        └── Modules/module.modulemap            ← optional — NOT needed at runtime (see §5b)
```

> **iOS ships a FLAT `.framework`, not an `.xcframework`.** The wrap pipeline expects `ios/<Name>.framework` and does **not** descend into an `.xcframework` — shipping an `.xcframework` fails with *"Framework '<Name>.framework' not found in plugin."* Ship the **device slice** (`ios-arm64`) as a flat `<Name>.framework/` at `ios/`. See §5b.

**The bundle is native-only:** `manifest.json` plus the per-platform binaries — no TypeScript / JavaScript layer is shipped.
- `android/` ships the **DEX** (via `/build-android-binary`) — present iff the manifest declares `entrypoints.android`.
- `ios/` ships the flat **`.framework`** (via `/build-ios-binary`) — present iff the manifest declares `entrypoints.ios`.

The manifest declares the native platform(s) targeted; at least one must be present (a manifest-only bundle has nothing for the wrap runtime to load). `/assemble-ppmplugin` zips the native slice(s) actually built and reconciles the manifest against them.

> **Filename convention — no version in the filename.** The bundle is named `<name>.ppmplugin` (e.g. `pen-input.ppmplugin`), **not** `<name>-<version>.ppmplugin`. The version lives only in the manifest's `version` field; the wrap pipeline reads `name` + `version` from `manifest.json` on ingest, not from the filename. (This matches the wrap reference's `dist/<name>.ppmplugin` convention.) Keep the version out of both the `name` field *and* the filename — putting it in `name` also breaks the name regex (no dots allowed) and the canonical-prefix rule.

### Source manifest vs staged manifest

There are **two** `manifest.json` files, deliberately:

- **`./manifest.json`** (repo root, **committed**) — the **dispatch-contract source of truth**. Authored by [`/generate-native-extension`](../skills/generate-native-extension/SKILL.md) at scaffold time, from the names the native modules expose. It declares *every platform the module supports*. The PCF reads it for the composite key; humans read it as the contract. This is the file you edit.
- **`ppmplugin/staging/manifest.json`** (gitignored) — the **build copy**. [`/generate-ppmplugin-manifest`](../skills/generate-ppmplugin-manifest/SKILL.md) produces it *from* `./manifest.json` (validate + reconcile `entrypoints` down to the shipped target); [`/assemble-ppmplugin`](../skills/assemble-ppmplugin/SKILL.md) zips it into the bundle. Never hand-edit it. (For a hand-authored module with no `./manifest.json`, the manifest stage authors both.)

### Staging convention (shared by all third-party-control skills)

Work happens under a gitignored `ppmplugin/` directory at the repo root:

```
ppmplugin/
├── staging/
│   ├── manifest.json                       ← STAGED copy: /generate-ppmplugin-manifest produces it from ./manifest.json (target-aware: only the shipped platforms)
│   ├── android-build/                      ← /build-android-binary's throwaway Gradle copy (NOT zipped)
│   ├── android/
│   │   └── <PascalName>Plugin.dex          ← /build-android-binary (zipped)
│   ├── ios-build/                          ← /build-ios-binary's throwaway Xcode project (NOT zipped)
│   └── ios/
│       └── <PascalName>Plugin.framework/   ← /build-ios-binary (zipped, flat device slice) [Mac-only]
└── <name>.ppmplugin              ← /assemble-ppmplugin (zips manifest + only the staged platform slices)
```

`/assemble-ppmplugin` zips **only** `manifest.json` + the `android/` and/or `ios/` slices that are present — never the `*-build/` working dirs — and reconciles the manifest's `entrypoints` against which slices actually exist (gating on any declared-but-not-built platform).

**Replace-existing gate (every third-party-control build/assemble skill).** When a staged binary (`android/<…>.dex`, `ios/<…>.framework`) or the final `.ppmplugin` already exists, the skill MUST surface it and ask **Replace vs Keep** before overwriting — never silently clobber an artifact the user may have produced deliberately (shared-instructions §7.1). This applies to `/build-android-binary`, `/build-ios-binary`, and `/assemble-ppmplugin` alike.

Each skill MUST ensure `ppmplugin/` is in the repo's `.gitignore` (add the line if missing) — build artifacts never get committed.

---

## 2. `manifest.json` schema

```json
{
  "name": "<kebab>",
  "version": "<semver from package.json>",
  "abi": {
    "compatibleShells": ">=1.0.0",
    "builtAgainst": "1.0.0"
  },
  "entrypoints": {
    "ios": {
      "framework": "<PascalName>Plugin",
      "moduleClass": "RCT<PascalName>Module"
    },
    "android": {
      "dex": "<PascalName>Plugin.dex",
      "packageClass": "com.powerapps.<lower>.<PascalName>Package"
    }
  },
  "receivers": [
    {
      "name": "<PascalName>Extension",
      "nativeModule": "<PascalName>Module",
      "methods": ["<@ReactMethod name>", "..."]
    }
  ]
}
```

**`entrypoints.android` / `entrypoints.ios` are per-target** — declare only for the native platform(s) the bundle ships; at least one is required. The validator requires an entrypoint for every shipped native platform. An Android-only bundle omits `entrypoints.ios`; an iOS-only bundle omits `entrypoints.android`; a Both bundle carries both. `/generate-ppmplugin-manifest` is target-aware; `/assemble-ppmplugin` reconciles declared entrypoints against the binaries actually staged.

### Field derivation (mechanical — never guessed)

All names derive from the extension's **class name** (PascalCase) per [`naming-conventions.md`](./naming-conventions.md), with one ppmplugin-specific rule:

| Field | Derived from | Pen-input example |
|---|---|---|
| `name` | **kebab-case of the CLASS name** (see §3 — NOT the capability name) | `pen-input` |
| `version` | `package.json` `version` | `0.1.4` |
| `entrypoints.android.dex` | `<PascalName>Plugin.dex` | `PenInputPlugin.dex` |
| `entrypoints.android.packageClass` | FQN of the `ReactPackage` (read from the `.kt` file: `package` line + class name) | `com.powerapps.peninput.PenInputPackage` |
| `entrypoints.ios.framework` | `<PascalName>Plugin` | `PenInputPlugin` |
| `entrypoints.ios.moduleClass` | `RCT<PascalName>Module` | `RCTPenInputModule` |
| `receivers[].name` | the receiver's **routing-key suffix** (see *Runtime dispatch contract* below) — our scaffold uses `<PascalName>Extension`; any JS-identifier works, and it need not carry a suffix (the wrap reference uses bare `Battery`) | `PenInputExtension` |
| `receivers[].nativeModule` | the module's `getName()` return value (read from the `.kt` file) = `<PascalName>Module` (the `Module` suffix avoids the reserved-name denylist — §3/§4) — what the wrap host resolves as `NativeModules.<nativeModule>` | `PenInputModule` |
| `receivers[].methods` | every `@ReactMethod fun <m>(` name in the module — the set of `Method` values the host may dispatch | `["capturePenInput"]` |

### Runtime dispatch contract (how the host calls the bundle)

The **shipped `.ppmplugin` bundle** is **native-only** — there is no TS `INativeExtension` / `handleMessageAsync` / `sendAsync` layer *inside the bundle*. (That bundle rule is unchanged and enforced by `/audit-ppmplugin`.) The **companion PCF**, however, is deployed separately (via `pac pcf push`, NOT part of the bundle) and dispatches into the native module through the **host-injected `window.PowerApps.NativeExtension.sendAsync` global** — NOT `cordova.exec`.

At boot, the wrap runtime reads every injected `manifest.json` and, for each `receivers[]` entry, registers a proxy under the composite key `<name>/<receiver.name>`. When the PCF calls `sendAsync(key, …)`, the host global carries the message into the host context and the proxy dispatches into the customer's native module:

```
PCF (Canvas WebView sandbox)
  → window.PowerApps.NativeExtension.sendAsync("<name>/<receiver>", { method, args: [request] })
     → host global (runs INSIDE the host context): cordova.exec("SendMessagePlugin", "<name>/<receiver>",
                                                    [JSON.stringify({ method, args }), corrId])
        → proxy: JSON.parse(body) → NativeModules[<nativeModule>][<method>].apply(mod, parsed.args)
```

> **⚠️ The PCF must NOT call `cordova.exec` directly.** The raw `cordova` global is **not exposed to the PCF sandbox** — `cordova` is `undefined` there, so a direct `cordova.exec(...)` throws a `ReferenceError` that the control's own try/catch swallows: the tap does nothing, with no error on screen (worst on **Android**, where the global is absent entirely). `cordova.exec("SendMessagePlugin", …)` is the real underlying transport, but it only works **inside the host's own JS context** — which is exactly what `sendAsync` bridges to. **One PCF drives both iOS and Android** through this same global; there is no platform branch.

> *Verified end-to-end on a physical iOS device (Face ID unlock) and with the DeviceTools sample on Android. The dispatch contract in this section is the public reference for the companion PCF and bundle.*

- **Composite routing key** = `<manifest.name>/<receivers[].name>` (e.g. `pen-input/PenInputExtension`). The PCF binds this as its `ReceiverKey`. `name` must be **globally unique across every plugin in the wrapped app** — the injector keys the manifest into `plugins/<name>/`, so two plugins sharing a `name` clobber each other.
- **Envelope (the `sendAsync` payload) = a RAW `{ method: string, args: unknown[] }` object** — the PCF does **NOT** stringify it. `sendAsync` performs the `JSON.stringify` internally (inside the host context) before handing it to the proxy, which reads it back via `JSON.parse(...)`. **A PCF that pre-stringifies the payload double-encodes it → the proxy `JSON.parse` yields a string, not `{method,args}` → `BRIDGE_FAILED`.** After parsing, the proxy runs `Array.isArray(parsed.args) ? parsed.args : []`, then `fn.apply(mod, args)`, spreading the inner array as **positional arguments** to the native method.
  - **⚠️ Inner `args` MUST be a JSON array.** If `args` is a bare object, `Array.isArray` fails, drops it to `[]`, and the method is called with **no request data** — silent payload loss. **Our convention: `args: [request]`** — a single-element array carrying one request object, and the native method takes exactly one `ReadableMap` (Android) / `NSDictionary` (iOS) first parameter (then the `Promise`/resolver). A no-arg op uses `args: [{}]`.
  - **⚠️ Two distinct, equally-fatal PCF mistakes:** (a) calling `cordova.exec` directly instead of `sendAsync` → nothing dispatches (silent, esp. Android); (b) inner `args` **not an array** → silent empty call. Both pass every structural check and only surface on the first device tap. The PCF skeleton in `/generate-pcf-companion` and the `/audit-ppmplugin` PCF-transport checks guard these.
- **Method** = `envelope.method` — must be the name of a real `@ReactMethod` (Android) / `RCT_EXPORT_METHOD` (iOS) on the module (unknown → `method '<m>' not found`). Note the proxy does **not** consult `receivers[].methods` at runtime; `methods[]` is the upload allowlist and is still required in the manifest (see §4).
- **nativeModule** = `receivers[].nativeModule` = the module's registered name (Android `getName()` / iOS `+moduleName`); `NativeModules[<nativeModule>]` missing → `native module '<x>' not loaded` (DEX/framework didn't load, or iOS used `RCT_EXPORT_MODULE` instead of `+moduleName` — see §5/§5b).
- **Return** = the native method resolves a value; the proxy returns a **string** as-is and **`JSON.stringify`s** anything else, then the bridge transport re-serializes. So resolve a **scalar string** or a **JSON string** (`promise.resolve(json.toString())`). `sendAsync` resolves `{ status, data?, error? }`: on `status === "ok"`, `data` is that native string; the host parses one layer, but the wrap host both **re-stringifies** it and **nests it in a `{ isUpdate, message }` transport container**, so the PCF peels it with `extractResponse` (below) — which parses AND unwraps the `message` container — not a single bare parse.
- **Response shape (convention).** The module resolves a two-level object `{ status, result?, error?, message? }`:
  - `status` — `"ok"` | `"error"`.
  - `result` — the success payload (present when `status === "ok"`).
  - `error` — a **machine-readable** code string (present when `status === "error"`); the PCF branches on it.
  - **`message` — a human-readable failure reason** (present when `status === "error"`): the exception text, the offending field, the denied permission. The PCF surfaces it as its `ErrorMessage` output. This is **critical for a third-party control**: the binary runs inside the customer's wrap shell with no logcat / Xcode console / native debugger reachable, so a bare code with no message is undebuggable in the field. The native `errorJson(code, message)` helper builds this via the platform JSON serializer (`NSJSONSerialization` / `JSONObject`) so a message containing quotes/newlines can't corrupt the JSON (which would surface as a misleading `PARSE`). Every native error path resolves with BOTH a code and a message.

> **The PCF transport is `sendAsync`, the same on both platforms.** The companion PCF calls `window.PowerApps.NativeExtension.sendAsync("<name>/<receiver>", { method, args: [request] })`. The `.ppmplugin` has no TypeScript layer; the host proxy spreads `args` positionally into the native module. **The wrap PCF is NOT platform-specific** — one PCF drives iOS and Android, while the host provides the platform-specific bridge and React Native module resolution.

#### Wrap-bridge response quirks the PCF must handle (learned)

- **`result.data` is re-stringified AND wrapped in a transport container — unwrap it, don't just parse once.** On `status === "ok"`, `result.data` is the native method's resolved value, but two things happen to it on the way back through the wrap `SendMessagePlugin` transport: (1) it may be **re-stringified** once, and (2) the module's JSON is **nested (still stringified) under a `message` key**. The confirmed on-device raw response for a *successful* call was:
  ```json
  {"isUpdate":false,"message":"{\"status\":\"ok\",\"result\":{\"isOn\":false,\"isAvailable\":true}}"}
  ```
  A single bare `JSON.parse` (or a bare multi-layer `deepParse`) lands on `{isUpdate, message}` — an object with **no top-level `status`** → the PCF falls through to `UNEXPECTED_PAYLOAD` even though native succeeded. The real `{status, result}` is *still stringified* under `message`. **The PCF must unwrap the container** with `extractResponse` — parse `result.data`, and if the parsed object has no top-level `status`, probe `message` first (the confirmed key) then defensive fallbacks, deep-parsing the nested value and accepting the first that has a top-level `status`:
  ```ts
  function extractResponse(raw: unknown): unknown {
    const top = deepParse(raw);
    if (top && typeof top === "object" && "status" in top) return top;
    if (top && typeof top === "object") {
      for (const k of ["message", "result", "data", "value", "response", "body", "payload"]) {
        if (k in (top as Record<string, unknown>)) {
          const inner = deepParse((top as Record<string, unknown>)[k]);
          if (inner && typeof inner === "object" && "status" in inner) return inner;
        }
      }
    }
    return top;   // fall through — UNEXPECTED_PAYLOAD surfaces the raw string for diagnosis
  }
  ```
  `deepParse` here is a **bounded** parse-if-string helper (a few passes), NOT the retired blind 4-layer transport walk — `extractResponse`'s job is the container unwrap, and it **returns `result.data` directly when it already has a top-level `status`** (the simple already-unwrapped case the Face ID PCF hit), so it is a strict superset of a single guarded parse. The `/generate-pcf-companion` skeleton emits `extractResponse` as the standard success handler, and `/audit-ppmplugin` (`pcf-response-unwraps-message`) checks a sibling PCF uses it (not a bare parse).
- **Handle `NOT_IN_WRAP`.** If `window.PowerApps?.NativeExtension` is missing (Studio preview, non-PAM host, or CordovaV2 disabled), reject with a clear `NOT_IN_WRAP` rather than a raw `undefined` access — this is expected in the Studio designer and should show a friendly state, not a crash.
- **Provide an on-device diagnostic.** On a release wrap build the WebView console is not reachable from logcat / `chrome://inspect`. So a wrap PCF should always expose **one `usage="bound"` text output** that surfaces the raw bridge response (e.g. `Self.<name>Json`) — the maker can drop it on a Power Fx label and read what actually came back without a connected debugger. (This is the one legitimate use of `usage="bound"` in an otherwise output-only control.)

#### Diagnosing `BRIDGE_FAILED` on device (deobfuscation recipe)

When a release-mode WebView suppresses `console.log` and the app isn't debuggable (`run-as` fails), confirm the exact dispatch shape the wrap shell uses — and that *your* bundle loaded — by reading the installed APK directly. This pinpointed the raw-object-envelope bug above in ~10 minutes:

```bash
PKG=<wrap-package>                                   # e.g. com.microsoft.…
adb shell pm path "$PKG"                             # → APK path on device
adb pull <that-path> wrap.apk
unzip -l wrap.apk | grep '\.js$'                     # find the host bridge bundle
unzip -p wrap.apk <bundle.js> > bundle.js
grep -oE 'cordova\.exec\([^)]*"SendMessagePlugin"[^)]*' bundle.js   # confirm the host-side transport
grep -oE 'PowerApps[^;]*NativeExtension[^;]*sendAsync' bundle.js    # confirms the host injects the sendAsync global your PCF calls
unzip -l wrap.apk | grep 'assets/plugins/<name>/'    # confirms YOUR manifest.json + DEX were injected/loaded
```

The `cordova.exec("SendMessagePlugin", …)` line lives **in the host bundle** (that's where the transport legitimately runs) — it must NOT appear in your **PCF** bundle. If your PCF did nothing on device, confirm (a) the host injects `window.PowerApps.NativeExtension.sendAsync` (grep above), (b) your PCF calls that global and does **not** call `cordova.*` directly, and (c) your manifest+DEX were injected. *(This is documented here rather than as a skill; if the adb→grep flow becomes routine it's a good candidate for a future `/diagnose-wrap-bridge` helper.)*

---

## 3. The canonical-prefix rule — why `name` comes from the CLASS name

The validator (§4) computes the canonical prefix **precisely** as:

> **Split `name` on `-` and `_`; PascalCase each segment (uppercase its first character); join.** That's the **canonical prefix**. Every `receivers[].nativeModule` MUST start with it (Ordinal, case-sensitive).

The separators matter: `hello-world` → `HelloWorld`, `contoso-camera` → `ContosoCamera`, but **`helloworld` (no separator = one segment) → `Helloworld`** — lowercase `w`, so a `nativeModule` of `HelloWorld` would be **rejected**. Hyphens/underscores in `name` are what produce the internal capitals.

The native module's `nativeModule` is `<className>Module` — the **`Module` suffix dodges the reserved-name denylist** (bare generic names like `DeviceInfo` are Microsoft-reserved; `DeviceInfoModule` is not — see §4). The canonical prefix must be a **prefix** of `nativeModule`, which is guaranteed when `name` is derived from the **class name**, kebab-cased:

```
name = kebab(className)     canonicalPrefix(name) === className,  nativeModule = className + "Module" starts with it  ✓
```

**`kebab()` MUST insert a hyphen at every camelCase boundary** (`PenInput` → `pen-input`, *not* `peninput`). Otherwise the round-trip breaks: `peninput` → canonical prefix `Peninput` ≠ `PenInput` → validator rejects it.

- `PenInput`  → `name: pen-input`  → prefix `PenInput`  → `nativeModule PenInputModule` starts with `PenInput`  ✓
- `PdfViewer` → `name: pdf-viewer` → prefix `PdfViewer` → `nativeModule PdfViewerModule` starts with `PdfViewer` ✓
- ❌ Using the **capability** name `pdf-control` → prefix `PdfControl`, which is NOT a prefix of `PdfViewerModule` → **validator rejects the upload.**

`/generate-ppmplugin-manifest` MUST derive `name` from the class name and, if the capability name (repo/npm name) differs from `kebab(className)`, surface a one-line note so the user understands the `.ppmplugin` name won't match the repo name.

---

## 4. Upload compatibility checks

`/generate-ppmplugin-manifest` runs these plugin-maintained checks **locally as a pre-flight gate**
so common manifest failures surface before a build. The upload service can apply additional checks.

| Rule | Check | Failure message |
|---|---|---|
| `name` shape | `^[a-z0-9][a-z0-9-]{0,63}$` — lower-case kebab | "must be a lower-case vendor-style identifier" |
| Canonical-prefix | each `receivers[].nativeModule` starts with the canonical prefix of `name` (split on `-`/`_`, PascalCase each segment, join — see §3) (Ordinal, case-sensitive) | "nativeModule '…' must start with the plugin's canonical prefix '…'" |
| Reserved prefixes | `nativeModule` must NOT start with (case-insensitive): `Microsoft`, `MS`, `Intune`, `MAM`, `Adal`, `Msal`, `Wrap`, `Pcf`, `PowerApps`, `Dataverse`, `MDL`, `Office`, `OneDrive`, `Teams`, `Sharepoint`, `SharePoint`, `Exchange`, `AzureAD`, `AAD`, `Graph` | "uses reserved prefix '…'" |
| Known incompatible names | `nativeModule` does not match the locally maintained subset below. A match is rejected before build. This subset is non-exhaustive, so the upload service may still reject another conflicting name. | "uses a known incompatible native module name" |
| Methods required | `receivers[].methods` present + non-empty | "must declare a non-empty 'methods' array" |
| Method-name shape | `^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$`, ≤32 per receiver | "is not a valid method-name identifier" / "exceeds the maximum" |
| Receiver-name shape | same JS-identifier regex as methods | "receivers[i].name is missing or contains unsafe characters" |
| No SDK-era / JS-layer fields **(local policy, NOT a server rule)** | the manifest carries NONE of `entrypoints.js`, `entrypoints.ts`, `extension.js`, `extension.hbc`, `extensionClassName`, `jsLayer`. The server **accepts** `entrypoints.js` (the injector treats it as optional); we reject it so the native-only bundle stays unambiguous — a WARNING, not an upload blocker | "manifest carries SDK-era field '…' — the .ppmplugin is native-only" |

> These checks intentionally avoid claiming complete parity with the upload service. Treat the
> reserved-prefix list as authoritative for this plugin and the exact-name subset as a fast local
> collision check.

#### Known reserved-name subset (checked locally)

These known incompatible bare names are checked **locally as a hard pre-flight block** so common
collisions surface before a build (the list is **non-exhaustive**):

```
DeviceInfo, AuthenticationHelper, NetworkClient, DataverseOfflineProvider, IntuneMAM
```

> **Why `DeviceInfo` collides — and how to avoid the whole class.** The denylist holds **bare, generic** names (`DeviceInfo`, `NetworkClient`, …) — exactly what a third-party author reaches for first. The structural fix the wrap reference uses is a **`Module` suffix** on the `nativeModule` (`DeviceInfo` → `DeviceInfoModule`): the suffixed name isn't in the bare-name namespace, so it sidesteps the denylist entirely. When a derived `nativeModule` matches a reserved name, the fix is to rename the module's registered name (Android `getName()` / iOS `+moduleName`) to a non-reserved form — adding `Module`, or a vendor prefix (`ContosoDeviceInfo`) — and update `receivers[].nativeModule` to match.

---

## 5. Android binary requirements (DEX)

The runtime reads `entrypoints.android.{dex,packageClass}`, loads the DEX with `DexClassLoader`, then instantiates `packageClass` through a public no-argument constructor. That imposes constraints a standard linked React Native package does not:

- **No `@ReactModule` annotation** on the module — it requires static symbols not visible to `DexClassLoader`-loaded code. (The current scaffold already omits it; the build skill asserts it.)
- **The `ReactPackage` (`packageClass`) MUST have a public no-arg constructor.** The loader instantiates it via `getDeclaredConstructor().newInstance()` — a `ReactPackage` whose only constructor takes arguments throws `NoSuchMethodException` and the plugin silently fails to load (`Loaded 0 plugin package(s)`). The module itself may take `ReactApplicationContext` (the `ReactPackage.createNativeModules(reactContext)` supplies it) — but the **package** class must be no-arg. The build skill asserts this.
- **Module construction runs eagerly at bridge startup, on an arbitrary thread — it MUST NOT throw.** After `newInstance()`, the player calls `createNativeModules(reactContext)`, which constructs your module immediately — before any UI, before any method call — on whatever thread starts the bridge, **frequently one with no prepared `Looper`**. A module constructor / Kotlin `init{}` that does side-effecting work and throws does so *uncaught, inside a constructor* → the **whole host process crashes at launch**. Two classic triggers: (a) `register*Callback(cb, null)` or a bare `Handler()` — a `null`/implicit `Looper` makes Android throw `RuntimeException: Can't create handler inside thread that has not called Looper.prepare()`; (b) any un-try/caught I/O, file read, or hardware-manager acquisition in the constructor. **The scaffold's rules:** construct cheaply — defer listener/hardware registration to the first method call (lazy); pass an explicit `Handler(Looper.getMainLooper())`, never `null`; wrap any unavoidable constructor side-effect in try/catch so a subsystem hiccup can't take down the app. iOS analogue: keep `+requiresMainQueueSetup` = `NO` and do no throwing/heavy work in `init` (instantiated eagerly via `[cls new]`). `/generate-native-extension` generates modules this way; `/test-native-extension` Layer 0 + `/audit-ppmplugin` Category F lint for the crash pattern.
- React Native is **`compileOnly`** — resolved at runtime by the wrap shell, never bundled. Pin the coordinate: `compileOnly "com.facebook.react:react-android:<rnVersion>"` (read `<rnVersion>` from `package.json` devDependencies — pen-input pins `0.79.7`).
- `module.getName()` MUST equal `receivers[].nativeModule`.
- The `ReactPackage` FQN MUST equal `entrypoints.android.packageClass`.
- **Optional native `.so` libraries** — if the module has JNI dependencies, place them at `android/lib/<abi>/*.so` in the bundle (`<abi>` matching `^[a-z0-9]+(-[a-z0-9_]+)*$`, e.g. `arm64-v8a`). The injector copies each ABI dir to the APK's `lib/<abi>/`. Most controls have none.
- Build path: `./gradlew :<module>:assembleRelease` → AAR → extract `classes.jar` → `d8 --min-api 24` → `classes.dex` → rename to `<PascalName>Plugin.dex`. `d8` warnings of the form `Type com.facebook.react.* was not found` are **expected and benign** (RN is `compileOnly`).

### Standalone build environment (pinned) — and why it differs from the managed host build

Under the managed host build the extension is a **subproject**: the host supplies `rootProject.ext` (compileSdk, minSdk, kotlin_version) and React Native on the classpath. The standalone ppmplugin build has neither, so `/build-android-binary` **builds from a throwaway copy** (`ppmplugin/staging/android-build/`) with these pins — the canonical `android/build.gradle` is never edited:

| Setting | Pinned value | Why |
|---|---|---|
| `compileSdkVersion` | **35** | RN 0.79's `react-android` AAR is compiled against **compileSdk 35**, so anything that `compileOnly`-depends on it must compile against **≥35** (AGP errors otherwise). This also clears the `com.google.android.material:1.11.0` → v34-resources floor. |
| Android platform | **`platforms;android-35`** (must be installed) | compileSdk 35 needs the android-35 platform. Install via `sdkmanager "platforms;android-35"`. |
| Build-Tools | **35.0.0** | Provides `d8` + an aapt2 compatible with compileSdk 35. |
| AGP | **8.8.2** (canonical, matches RN 0.79) | RN 0.79's `react-android` AAR carries AGP-8 metadata that AGP 7.x cannot consume, and only AGP 8.x can compile against android-35. |
| Kotlin | **1.9.25** | The module applies `kotlin-android`, so the staging copy's plugin classpath must resolve **1.9.25** (align with AGP 8.8.2 — don't let a newer Kotlin bundled by a different AGP collide). |
| Gradle (wrapper) | **8.13** | The Gradle version RN 0.79 pairs with AGP 8.8.2. The staging copy's wrapper is pinned to 8.13 so the build never uses a too-old system `gradle`. **Preferred:** the skill **ships a pre-generated `gradle/wrapper/` (jar + properties pinned to 8.13) into the staging copy** so the first `./gradlew` invocation downloads 8.13 — no system-Gradle bootstrap needed. **The properties MUST also carry `distributionSha256Sum=20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78`** (the value Gradle publishes at `…/gradle-8.13-bin.zip.sha256`), and `gradle-wrapper.jar` MUST match **`81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f`** (the value Gradle publishes at `https://downloads.gradle.org/distributions/gradle-8.13-wrapper.jar.sha256`) before the first `./gradlew` — that archive and that jar are both *executed*, so HTTPS alone is not sufficient. Both checks are fail-closed. |
| `gradle.properties` (generated) | **`android.useAndroidX=true`, `android.enableJetifier=false`, `org.gradle.jvmargs=-Xmx2048m`** | the managed host build supplies these ambiently; standalone has none. **Without `useAndroidX=true` the androidx deps (appcompat, core-ktx) fail resource linking.** `/build-android-binary` generates this file in the staging copy. (Confirmed: the Android path is one-shot once `gradle.properties` is present.) |

**Why `compileSdk 35` specifically (not arbitrary):** RN 0.79's `react-android` artifact is built against **compileSdk 35**, and AGP enforces that any module compiling against it uses **compileSdk ≥ 35** — anything lower is a hard build error. AGP 8.8.2 is the matching plugin (RN 0.79 ships it) and it's the first family that can compile against android-35. `compileSdk` is the **compile-against** level only; runtime floor is **`minSdk 24`** (`d8 --min-api 24`, matching the `react-android` AAR's own minSdk 24), so the plugin runs on Android 24+.
| React Native dep | `compileOnly "com.facebook.react:react-android:<rnVersion>"` | What `/generate-native-extension` now writes into the canonical `android/build.gradle`. The legacy `implementation "...:react-native:+"` form (still present in older controls) doesn't resolve standalone — it relied on the managed host build to supply React, the pre-0.73 coordinate is gone, and `implementation` would bundle RN instead of leaving it host-provided. Modern coordinate is `react-android`, on mavenCentral. `<rnVersion>` from `package.json`. |

**Do not** "fix" a standalone build failure by editing the canonical `build.gradle` (downgrading Material, pinning an older AGP, lowering compileSdk) — those degrade or destabilize the real source to satisfy a throwaway build. The copy-and-pin approach keeps the two concerns separate.

## 5b. iOS binary requirements (flat `.framework`)

Built by [`/build-ios-binary`](../skills/build-ios-binary/SKILL.md) — **Mac-only** (Xcode). Like Android, it builds from a throwaway staged Xcode project (`ppmplugin/staging/ios-build/`); the canonical `ios/` + podspec are never edited.

- **Output is a FLAT device-slice `<PascalName>Plugin.framework/`, NOT an `.xcframework`** (learned the hard way). The wrap pipeline expects `ios/<Name>.framework` and does not descend into an `.xcframework` — an `.xcframework` upload fails with *"Framework '<Name>.framework' not found in plugin."* Build the **device archive only** (`-destination "generic/platform=iOS"` → `ios-arm64`), then copy its `Products/Library/Frameworks/<Name>.framework` straight to `ppmplugin/staging/ios/<Name>.framework`. **Drop the `-create-xcframework` step.** (Tradeoff: no simulator slice → no iOS-Simulator testing; revisit if the wrap pipeline ever grows simulator support.)
- **How the runtime loads it:** `dlopen("Frameworks/<framework>.framework/<framework>", RTLD_NOW)` then `NSClassFromString(moduleClass)` → `[cls new]`. So:
  - The Mach-O binary inside the framework MUST be named exactly `<framework>` (= `entrypoints.ios.framework`) — `dlopen` opens that path.
  - **`moduleClass` MUST respond to a no-arg `[cls new]`** (the default `init`) and conform to `RCTBridgeModule`. A module whose only initializer takes arguments won't instantiate → the plugin is skipped at load.
  - Because the player **`dlopen`s the binary directly** (it does NOT `import` the module), a Swift/clang **module map and umbrella header are NOT required at runtime** — they're build-hygiene only (they silence the `DEFINES_MODULE` warning and let *other* code `import` the framework). Generate them if convenient, but their absence does **not** break loading. Do not treat them as upload blockers.
- **`Info.plist` IS required** — set `GENERATE_INFOPLIST_FILE=YES` plus `INFOPLIST_KEY_CFBundleDisplayName=<Name>`, `MARKETING_VERSION=<version>`, `CURRENT_PROJECT_VERSION=1`, `PRODUCT_BUNDLE_IDENTIFIER=com.powerapps.<lowername>`. **A framework bundle with no Info.plist is invalid and the wrap codesign step rejects it.** Required keys: `CFBundlePackageType=FMWK`, `CFBundleExecutable=<Name>`, `CFBundleIdentifier`, `CFBundleShortVersionString`, `MinimumOSVersion`.
- **Critical build settings** (each → a documented on-device failure): Mach-O **Dynamic Library** (Static → "module not found"); Dead Code Stripping **NO** (preserves the `+moduleName` class method + `RCT_EXPORT_METHOD` metadata the host reads after `dlopen`); Defines Module **YES**; Enable Bitcode **NO**; `BUILD_LIBRARY_FOR_DISTRIBUTION=YES`; `SKIP_INSTALL=NO`.
- **React-Core: headers only, NEVER embedded** — the framework compiles against React's headers (`#import <React/RCTBridgeModule.h>`) from the control repo's own pinned `react-native` devDep and links React weakly (the wrap host provides it at runtime; embedding duplicates symbols and crashes the host). **Recommended path — header-only, no CocoaPods:** aggregate the React headers into a flat `include/React/` from `node_modules/react-native/React/Base/` + `Libraries/`, set `HEADER_SEARCH_PATHS = $(inherited) $(SRCROOT)/include`, and `OTHER_LDFLAGS = -undefined dynamic_lookup` for the React-symbol weak-link. This is cleaner/faster than the Pod chain and avoids the CocoaPods failures below. The coupling that matters: **the RN pin (`0.79.7`) must match the wrap host's RN** — React symbol/header errors mean the pin diverged, not a code bug. (**Known limitation:** the weak-link config isn't yet validated against a live wrap host.)
  - **Caveat (`-undefined dynamic_lookup`)** is deprecated by Apple on iOS — works today, may break in a future Xcode. Long-term: a real `-weak_framework React` once there's a stable wrap-host RN to validate against.
- **CocoaPods fallback + known Xcode-26 / RN-0.79 breakages** (only if you don't use the header-only path; all are environment-transient — versions will shift): boost podspec URL bitrot → point at `archives.boost.io`; Yoga `_pt` literal promoted to error → `-Wno-deprecated-literal-operator`; RCT-Folly `clockid_t` redefinition → `FOLLY_HAVE_CLOCK_GETTIME=1`; boost `std::unary_function` removed in C++17 → `-D_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION=1` on every Pods target. Apply these in a `post_install` hook. Under Xcode 26's tighter sandbox the **React-Codegen script phase** can also fail (`FBReactNativeSpec-generated.mm` not produced) — another reason to prefer the header-only path.
- **xcodeproj-gem trap (if generating the project programmatically):** `new_group('Sources','Sources')` + `new_reference("Sources/<file>")` yields a double path `Sources/Sources/<file>` → file-not-found. When the group already carries the path, add file refs **filename-only**.
- **Conformance** (asserted before build): `.h` class name == `entrypoints.ios.moduleClass`; the `.m` declares `+ (NSString *)moduleName` returning `nativeModule` (and does **NOT** use `RCT_EXPORT_MODULE`); `RCT_EXPORT_METHOD` names ⊆ `receivers[].methods`.
- **Build path:** generate the framework project → `xcodebuild archive` **device only** (`-destination "generic/platform=iOS"`, distribution flags) → copy `…/Products/Library/Frameworks/<Name>.framework` → `ppmplugin/staging/ios/<Name>.framework/`. Verify the two **required** items — the Mach-O binary named `<Name>` and `Info.plist` — are present (the umbrella header + `Modules/module.modulemap` are nice-to-have build hygiene, not required by the loader).
- **Signing:** none in this skill — the wrap pipeline signs at packaging time, *provided* the framework has an Info.plist and was built `BUILD_LIBRARY_FOR_DISTRIBUTION=YES SKIP_INSTALL=NO`.
- **On-device failure → cause:** "Native module not found" → static-not-dynamic / dead-code-stripping / used `RCT_EXPORT_MODULE` instead of `+ (NSString *)moduleName` (its `+load`/`_RCTRegisterModule` is invisible to `dlopen`'s flat namespace); `dyld @rpath … not loaded` → framework not embedded by the wrap pipeline; symbol-not-found at launch → React linked strongly instead of weakly.

---

## 6. What this format does NOT cover (yet)

- **iOS framework build** — now produced by [`/build-ios-binary`](../skills/build-ios-binary/SKILL.md) (Mac-only; **known limitation:** not yet validated against a live wrap host, and the RN pin must match the wrap host's RN). See §5b.
- **Upload / wire-into-canvas** (Stage 3 of the how-to: `msdyn_nativeextension` POST + blob PATCH, wrap wizard, PCF wiring) — deferred. The third-party-control build stops at a verified `.ppmplugin` file on disk.
- **Code signing** — Android DEX needs none. iOS may; TBD with the wrap pipeline.
- **No TS / JS layer in the bundle** — the `.ppmplugin` ships native binaries only (`manifest.json` + `android/` + `ios/`). The TS `INativeExtension` / `handleMessageAsync` layer is NOT shipped; dispatch is manifest-driven straight to `NativeModules.<nativeModule>.<method>` via the wrap proxy adapter (see *Runtime dispatch contract* in §2). **Our native-only policy** is to carry no TS/JS at all: `/audit-ppmplugin` flags `entrypoints.ts`/`extension.js`/`extension.hbc`/a `src/` tree/`jsLayer`/`extensionClassName` and `INativeExtension`/`sendAsync` symbols in the DEX. Note this is *our* cleanliness rule, **not** a server requirement — the wrap injector actually treats `entrypoints.js` as *optional* and the player *silently ignores* a stray JS layer or SDK symbols (an old-pattern plugin still dispatches if its `receivers[]` map to real native modules). We reject them to keep the bundle unambiguous, not because upload would fail.
