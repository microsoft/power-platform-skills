---
name: test-native-extension
description: "Validate a third-party control repo across four automated layers plus one printed manual recipe. Layer 1 asserts native-source structure (Android getName() and iOS +moduleName to manifest nativeModule; @ReactMethod / RCT_EXPORT_METHOD to methods; no @ReactModule) plus load/init readiness (ReactPackage public no-arg constructor, iOS [cls new] no-arg init, requiresMainQueueSetup NO, non-throwing eager construction), so launch-time crashes surface before any build. Layer 2 validates the committed `./manifest.json` against the ppmplugin-format rules. Layer 3 asserts request/response/error-code agreement across native and PCF. Layer 4 compiles the PCF (auto-skipped if absent). Layer 5 prints a device end-to-end recipe. Native compile belongs to /build-android-binary and /build-ios-binary — this is the cheap structural pre-flight before those slow builds. Reports pass/fail per layer with a fix hint and updates .extension-state.md."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill
model: opus
---

# /test-native-extension

Runs the 4-layer validation ladder for a third-party control repo — the one that ships as a `.ppmplugin` binary bundle, not as a TypeScript extension. Layers 1–4 are automated; Layer 5 is interactive (requires a real device or simulator and the Companion PCF deployed to a test environment).

| Layer | What | Mode | Speed | Requires |
|---|---|---|---|---|
| 0 | Holistic contract consistency (native ↔ manifest ↔ PCF cross-check) | Automated, **warn-only** | seconds | at least a native module on disk |
| 1 | Native-source structure asserts (Android `getName()` ↔ iOS `+moduleName` ↔ manifest) | Automated, grep/parse | seconds | `android/` and/or `ios/` |
| 2 | Manifest validation (`ppmplugin-format §4` rules) | Automated | seconds (skipped only if no manifest on disk) | `./manifest.json` (committed; else staged copy) |
| 3 | Native-source contract asserts (request/response/error grep cross-check) | Automated | seconds | native module(s) |
| 4 | PCF compile (`npm run build` in `pcf/<Pascal>PCF/`) | Automated | seconds (after first install) | `pcf/<Pascal>PCF/` must exist (skipped otherwise) |
| 5 | Manual device / simulator end-to-end | **Recipe-only — skill prints, user runs on own time** | 5–10m, off-skill | `pcf/` must exist + PCF deployed |

Run order is layer-by-layer for Layers 1–4. **Stop on the first failure** in the automated layers. Layer 5 is **not** gated by the skill — it prints the device recipe and exits; the user runs it on their own time and updates `.extension-state.md` manually.

> **What this skill does NOT validate:** native code compilation into a loadable DEX / framework. That's the job of [`/build-android-binary`](../build-android-binary/SKILL.md) and [`/build-ios-binary`](../build-ios-binary/SKILL.md) — they run the real Gradle / xcodebuild toolchain against the pinned RN version and surface the real compiler error. Standalone `pod lib lint` and `./gradlew assembleDebug` from this skill would give false-confidence (they resolve dependencies from public CDN/maven, not against the wrap host's pinned versions). This skill is the **structural** pre-flight that runs in seconds with no toolchain — it asserts the native source is *shaped* correctly (right base class, right symbols, the Android `getName()` ↔ iOS `+moduleName` ↔ manifest agreement) so the build skills don't fail late on a fixable-in-seconds mistake. There is **no TypeScript / `INativeExtension` layer** in this track to type-check — a native-only `.ppmplugin` bundle dispatches straight to `NativeModules.<nativeModule>.<method>` ([`ppmplugin-format §2`](../../shared/ppmplugin-format.md) — *Runtime dispatch contract*).

---

## Step 1 — Read the shared docs and PRD

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md), [`shared/naming-conventions.md`](../../shared/naming-conventions.md), [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md).
2. Apply the **per-skill minimal prereq policy** ([`shared-instructions.md §1.5`](../../shared/shared-instructions.md)). Layers 1–3 need **no toolchain** (pure read + grep + validate against the working tree). Layer 4 needs **Node + npm** only when a PCF is present — and only for the *first* run (to `npm install` the PCF's own deps from the public npm registry). This track is self-contained and requires no package-feed or source-control authentication ([`shared-instructions §0a`](../../shared/shared-instructions.md)). Run the **`/test-native-extension` check** from [`prereq-check.md`](../../shared/prereq-check.md) (Layers 0–3 need nothing; Node + npm only if a PCF is present for Layer 4 — there is no "baseline" check in this self-contained track).

   **Print the prereq status as a visible block per `shared-instructions.md §9.2`** before continuing:

   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Prereq check — /test-native-extension
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    🟢 ✓ git installed
    🟢 ✓ Node 20+ installed            (only needed for Layer 4 — PCF compile)
    🟢 ✓ npm installed                 (only needed for Layer 4 — PCF compile)

    🟢 3 checks passed. Ready to proceed.
   ```

   If no `pcf/` is present, Node/npm aren't needed at all — note them as `n/a (no PCF)` rather than failing. Layers 1–3 always run regardless. If any check fails, print the `→ Fix:` line for that check and STOP.
3. Read `./PRD.md`. If missing, the Layer 3 contract asserts fall back to the native source itself as source-of-truth (it's still useful) — note it and continue rather than STOP.
4. Read `./.extension-state.md`. If Phase is below `manifest` (no native module on disk yet), STOP — there's nothing scaffolded to test.

---

> **OS-neutral — run these checks with the built-in Read/Grep tools, not a shell.** Every extraction/assert in this skill (the `find` / `grep` / `sed` / `awk` snippets below) is shown in **bash for readability only** — it describes *what to match*, not a shell to execute. RUN them with the agent's built-in **Read** and **Grep** tools (plus your own parsing), which behave identically on macOS, Linux, and **Windows PowerShell**. Do **NOT** shell out to `grep`/`sed`/`awk`/`sort`/`find` — they aren't on a stock Windows box, and Layers 0–3 are deliberately pure read+parse (no toolchain) so they run everywhere. Layer 4's `npm run build` is the only real command, and npm is cross-platform.

## Step 2 — Confirm scope with the user

First, **auto-detect** whether the PCF companion is on disk — use the **Grep tool** (`glob: pcf/**/ControlManifest.Input.xml`) so case differences and minor layout variations don't trip the check. (Illustrative bash — *don't* run it verbatim on Windows):

```bash
PCF_MANIFEST=$(find pcf -type f -name "ControlManifest.Input.xml" 2>/dev/null | head -1)
[ -n "$PCF_MANIFEST" ] && PCF_PROJECT_ROOT=$(dirname $(dirname "$PCF_MANIFEST"))
```

If `$PCF_MANIFEST` is set, the PCF is scaffolded; use `$PCF_PROJECT_ROOT` (e.g. `pcf/<Pascal>PCF`) for Layer 4's build step. If empty, distinguish: no `pcf/` at all → "not yet scaffolded"; `pcf/` exists but no manifest → "scaffold appears incomplete; re-run /generate-pcf-companion or inspect the folder."

Also detect the manifest that drives Layer 2. Prefer the **committed `./manifest.json`** (the source of truth `/generate-native-extension` writes at scaffold time, so it normally exists here, right after scaffold) and fall back to the staged build copy:

```bash
MANIFEST=$( [ -f ./manifest.json ] && echo ./manifest.json || ls ppmplugin/staging/manifest.json 2>/dev/null )
```

If `$MANIFEST` is empty, Layer 2 is skipped (no manifest on disk yet — a hand-authored module that hasn't run `/generate-ppmplugin-manifest`; with the scaffold, `./manifest.json` is present from the start).

This drives Layer 4 (PCF compile) and Layer 5 (manual recipe — both require the PCF to exist).

| State | Default layer set |
|---|---|
| No `pcf/` folder (PCF not yet scaffolded) | Layers 1, 2, 3 run; Layers 4 and 5 marked **deferred — re-run after `/generate-pcf-companion`** |
| `pcf/` folder exists | Layers 1–4 run automated; Layer 5 prints the device recipe (no wait, no gate) |

Print:

```
Test plan
─────────
Repo: <cwd>
Extension: @powerapps/extension-<kebab>  (class <Pascal>Extension, module <Pascal>Module)
PCF companion: <found pcf/<Pascal>PCF/ | NOT yet scaffolded>
Manifest: <found ./manifest.json (committed) | ppmplugin/staging/manifest.json (staged) | NONE>

Automated layers (skill runs these and reports pass/fail):
  0. Holistic contract check — native ↔ manifest ↔ PCF cross-grep (warn-only)
  1. Native-source structure — getName()/+moduleName/@ReactMethod asserts + load/init readiness (no-arg package ctor, iOS [cls new]/requiresMainQueueSetup, non-throwing construction)
  2. Manifest validation     — <ppmplugin-format §4 rules | SKIPPED — no manifest>
  3. Native-source contract  — request/response/error grep cross-check
  4. PCF compile             — <npm run build in pcf/<Pascal>PCF | DEFERRED>

Manual layer (skill prints a recipe; you run it on a device on your own time):
  5. Device end-to-end       — <print recipe | DEFERRED>

Not validated by this skill: native iOS / Android compile into a loadable DEX / framework (run /build-android-binary // /build-ios-binary for that).

Stop on first failure: <yes by default>
```

Use `AskUserQuestion`:

> Run the test plan?
> - **Run the default set above** (recommended)
> - **Run only Layers 1–3** (skip PCF compile; skip the Layer 5 recipe)
> - **Run a single layer** (specify which)
> - **Cancel**

If the user picks a single layer, validate dependencies — e.g. "Layer 3 (contract asserts) is more useful after Layer 1 (structure asserts) has passed in this run or a recent run; do you want to skip the check and run anyway?". Don't enforce strictly; surface the implication and let the user decide.

---

## Step 2.5 — Layer 0: Holistic contract consistency

> **Diagnostic layer, not a hard gate.** Reports findings; downgrades to warnings rather than blocking. Useful for catching drift between native modules ↔ `manifest.json` ↔ PCF before the harder-to-debug runtime symptoms surface in Layer 5.

This layer **cross-checks the contracts** that flow across the native modules, the staged `manifest.json`, and the PCF. None of these checks compile or run code — they're all grep/parse-based. If any check finds a mismatch, the skill prints a numbered warning with the mismatched values + suggested fix, but **continues to Layer 1** unless the user opts to stop. The point is to surface inconsistencies early; the engineer decides which ones matter.

### What's checked

| # | Contract | Sources cross-checked | Mismatch surfaces |
|---|---|---|---|
| 1 | **Routing key** | manifest `receivers[].name` → `ROUTING_KEY` const in `pcf/<Pascal>PCF/<Pascal>PCF/index.ts` | Both must be the same receiver key (our scaffold uses `'<Pascal>Extension'`; any JS-identifier works — see `ppmplugin-format §2`). Mismatch = silent routing failure at runtime (the wrap bridge can't dispatch). |
| 1b | **PCF transport (wire format)** | the dispatch call in `index.ts`: it MUST call `window.PowerApps.NativeExtension.sendAsync("<key>", { method, args: [request] })` and MUST NOT call `cordova.exec` (or any `cordova.*`) directly; the `sendAsync` payload MUST be a **raw object** (not pre-`JSON.stringify`'d — `sendAsync` stringifies internally) and the inner `args` MUST be `[request]` (an array). Grep for `\.sendAsync\(` present AND `cordova\.exec` absent in the file. | **This is the one structural check that maps to a wire-format bug.** A direct `cordova.exec` call passes every other check (the array IS an array, the key IS aligned) and **fails only on the first device tap** — the raw `cordova` global is not in the PCF sandbox, so the tap does nothing (worst on Android). Likewise a pre-stringified payload double-encodes → `BRIDGE_FAILED`. If `sendAsync` is absent or `cordova.exec` is present → **flag prominently** (treat as the highest-priority Layer 0 finding) and point at `/generate-pcf-companion` and `ppmplugin-format §2`. |
| 2 | **Native module symbol** | iOS class name `RCT<Pascal>Module` == manifest `entrypoints.ios.moduleClass`; iOS `+moduleName` return → Android `override fun getName() = "<X>"` → manifest `receivers[].nativeModule` | `+moduleName`, `getName()`, and `receivers[].nativeModule` must use the same `'<Pascal>Module'` (the canonical-prefix rule, `ppmplugin-format §3`). The Obj-C class name is a separate value that must equal `entrypoints.ios.moduleClass`. Mismatch = JS-side dispatch finds nothing on one platform but works on the other; or the validator rejects the manifest. |
| 3 | **Operation method names** | PRD §4 table → `RCT_EXPORT_METHOD(<methodName>:...)` (iOS) → `@ReactMethod fun <methodName>(...)` (Android) → manifest `receivers[].methods[]` | All four must match. Catches typos that compile but route nowhere — and a method missing from `methods[]` that the host can never dispatch. |
| 4 | **Request field names** | ARCHITECTURE §4.1 → iOS parser (NSDictionary key reads in `.m`) → Android parser (ReadableMap key reads in `.kt`) → PCF payload build (`request.<field>` in `index.ts`) | All four must reference the same field names. Mismatch on iOS only / Android only = platform-specific INVALID_INPUT. |
| 5 | **Response field names** | ARCHITECTURE §4.2 → iOS JSON build (keys in `successJsonWith:`) → Android JSON build (keys in `successJson`) → PCF response read (`response.result.<field>` in `index.ts`) | All four must match. Catches "PCF reads undefined" issues. |
| 6 | **Error codes** | ARCHITECTURE §5 error code union → iOS `errorJsonWithCode:message:` argument strings → Android `errorJson(code, message)` argument strings → PCF `setError` case labels → ARCHITECTURE §8 row presence | Each code from §5 should appear in at least one native emit site AND the PCF `setError` should have a case (or default). Codes emitted by native but not listed in §5 → warn (PRD drift). Codes in §5 but not handled in PCF default → warn (incomplete coverage). |
| 6b | **Error MESSAGE plumbing** | native error helper signature carries a `message` (`errorJsonWithCode:message:` / `errorJson(code: String, message: String)`) → PCF `setError(code, message)` is two-arg and sets `this.errorMessage` → `ControlManifest.Input.xml` declares `Status` + `ErrorCode` + `ErrorMessage` `usage="output"` → `getOutputs()` returns all three | A native helper that still takes only a `code`, a one-arg `setError`, or a missing `ErrorMessage` output = **warn**: failures will reach the maker as a bare code (or nothing) with no human-readable reason — the on-device debug gap this check exists to close. |
| 7 | **PCF manifest properties ↔ index.ts** | `<property name="...">` in `pcf/<Pascal>PCF/<Pascal>PCF/ControlManifest.Input.xml` → `IInputs` / `IOutputs` references in `index.ts` (via `p.<Name>.raw` and `getOutputs()` return keys) | All manifest properties should be read; all `IOutputs` keys should appear in `getOutputs()`. Layer 4's tsc actually enforces this — Layer 0 surfaces it earlier with a more readable diff. |
| 8 | **Permissions ↔ §3.2** | ARCHITECTURE §1.4 → iOS Info.plist usage strings (e.g. `NSCameraUsageDescription`) → Android `<uses-permission>` entries in `AndroidManifest.xml` | Each ARCHITECTURE §1.4 row should have a matching native entry. Mismatch = OS denial at runtime with no user-visible message. |
| 9 | **RN pin** | the React Native pin in `package.json` devDependencies → `android/build.gradle` `compileOnly` RN line → manifest `abi` / build pins (`ppmplugin-format §0` constants) | All should match the wrap host's RN (`0.79.7`). Drift means the binary is compiled against a different RN than the host loads it into — silent ABI mismatch on device. |
| 10 | **Unresolved native references** (heuristic) | Scan `*.kt`, `*.m`, `*.swift` files in `ios/` and `android/`. For each function/method call site, verify it has a definition in the same file OR a matching `import` / `#import` at the top. | Flags `Unresolved reference` bugs BEFORE the `/build-android-binary` // `/build-ios-binary` compile catches them. Past regressions where helper methods were called but never emitted (e.g. `createTopNavBar()`) would surface here. |
| 11 | **No SDK-era leakage** (denylist mirror of `/audit-ppmplugin`) | Grep the **native source + `package.json`** (NOT the PCF) for symbols that belong to the retired TS extension model: an `INativeExtension` import / `implements INativeExtension`, a `sendAsync` transport call, a `handleMessageAsync` entrypoint, an `extensionClassName` / `jsLayer` field, or a `@ReactModule` annotation on the Android module. | The `.ppmplugin` ships native binaries only and dispatches straight to `NativeModules.<nativeModule>.<method>` — none of these symbols belong in the **shipped bundle**. Any hit **in native source / package.json** → WARN (it will be a hard CRITICAL at `/audit-ppmplugin` time, so fix it now). **NOTE: `sendAsync` in the PCF (`pcf/…/index.ts`) is CORRECT and required** — the leakage scan targets only the native/bundle sources, never the PCF. See `ppmplugin-format §6` (*What this format does NOT cover*). |
| 12 | **Constructor / `init{}` safety** (crash-at-launch lint) | **Scope the scan to the module's *construction closure*, not the whole file:** the primary/secondary constructor(s) + `init{}` block(s) + property initializers (`private val x = …` that run at construction), PLUS any private function they call (follow one level of `foo()` / `this.foo()`). Within that closure flag: `register*Callback(…, null)`, a bare `Handler()` / `Handler(...)` with no explicit `Looper`, and any side-effecting call (`register*`/`add*Listener`/`observe`/`getSystemService`+use/file or network I/O/`runBlocking`) **not** wrapped in `try { } catch`. `@ReactMethod` bodies are OUT of scope (they run per-call, not at construction). | The module is constructed **eagerly at bridge startup on a possibly Looper-less thread** — an uncaught throw there crashes the host at launch, before any UI ([`ppmplugin-format §5`](../../shared/ppmplugin-format.md)). Any hit → WARN: defer to lazy first-call init, pass `Handler(Looper.getMainLooper())`, wrap unavoidable init in try/catch. **iOS analogue:** the same rule applies to a throwing/heavy `init` (module instantiated eagerly via `[cls new]`, [`§5b`](../../shared/ppmplugin-format.md)). Heuristic here — the **definitive static** catch is now **Layer 1's Load & initialization readiness asserts** (which hard-gate the clear triggers + the `ReactPackage` no-arg-ctor / iOS `[cls new]` / `requiresMainQueueSetup` load checks); mirrored as `/audit-ppmplugin` `src-ctor-no-throwable-sideeffects`; the **runtime** catch is the Layer 5 launch crash-scan. |
| 13 | **PCF unwraps the response container** | In `pcf/<Pascal>PCF/<Pascal>PCF/index.ts`, the `invokeBridge` / `sendAsync` success path must run an `extractResponse`-style unwrap (parse `result.data` + probe the `message` container), NOT a bare single `JSON.parse`. Pattern-match for an `extractResponse(` call (or an inline `"message" in` unwrap) on the `sendAsync` result path. | The wrap transport nests the module's JSON under a `message` key (`{isUpdate, message}`); a PCF that only single-parses lands on the container and fails **every** call with `UNEXPECTED_PAYLOAD` though native succeeded ([`ppmplugin-format §2`](../../shared/ppmplugin-format.md)). Missing unwrap → WARN. Mirrored as `/audit-ppmplugin` Category F `pcf-response-unwraps-message`. |
| 14 | **Listener / resource leak** (register without release) | For each `register*` / `add*Listener` / `observe` / `getSystemService`-acquired resource in the module, check for a matching release (`unregister*` / `remove*Listener` / `.close()` / `.release()`) in `invalidate()` / `onCatalystInstanceDestroy()` / a teardown path. | A registered callback or acquired manager with no release **leaks** across the module's lifecycle and can fire into a dead module. Missing release → WARN: unregister in `invalidate()`. |
| 15 | **Promise always settled** (hang guard) | Each `@ReactMethod` (Android) / `RCT_EXPORT_METHOD` (iOS) that takes a `Promise` / resolver+rejecter must contain at least one `promise.resolve` / `promise.reject` (or `resolve(...)` / `reject(...)`) on a reachable path. | A method that returns without ever settling its Promise leaves the maker with a **hung control** and no code/message. A Promise-taking method with zero resolve/reject sites → WARN (guaranteed hang). |
| 16 | **Dangerous permission declared but unchecked** | If `AndroidManifest.xml` declares a dangerous permission (`CAMERA`, `RECORD_AUDIO`, `ACCESS_FINE/COARSE_LOCATION`, `READ/WRITE_EXTERNAL_STORAGE`, `READ_CONTACTS`, …), the module source must reference `checkSelfPermission` / `ContextCompat.checkSelfPermission` / a permission request. | On API 23+ a manifest grant is not enough — calling the API without a runtime check throws `SecurityException`. Declared-but-unchecked → WARN: check the permission and resolve `PERMISSION_DENIED` on denial. |
| 17 | **`currentActivity` null-guard** | Every `currentActivity` use in the module must be null-guarded (`currentActivity ?: return …` / `currentActivity?.` / an explicit `== null` check) — flag a bare `currentActivity!!` or `currentActivity.<member>` deref. | `currentActivity` is `null` when the app is backgrounded; an unguarded deref NPE-crashes the host. Unguarded → WARN: guard and resolve `NO_ACTIVITY`. |

### How it runs

For each check, the skill does a series of grep / read / compare ops:

```bash
# Example for check #1 (routing key)
PRD_CLASS=$(grep -oE "Class name \(Pascal\) \| .+" PRD.md | sed 's/.* | //')
MANIFEST_KEY=$(grep -oE '"name"\s*:\s*"[^"]+"' "$MANIFEST" | head -1)  # first receiver name ($MANIFEST = ./manifest.json or staged copy)
PCF_KEY=$(grep -oE 'ROUTING_KEY = "[^"]+"' pcf/${PRD_CLASS}PCF/${PRD_CLASS}PCF/index.ts)
# Compare; if mismatch, print:
#   ⚠️  Layer 0 check 1 (Routing key): manifest says '<X>', PCF says '<Z>'
#       Fix: align both to '<expected>'
```

For check #10 (unresolved native references), a heuristic grep flow:

```bash
# For each .kt file in android/, build the set of in-file definitions + imports,
# then for each call site, check membership.
for kt in $(find android/src -name "*.kt"); do
  IN_FILE_FUNS=$(grep -oE 'fun\s+[a-zA-Z_][a-zA-Z0-9_]*' "$kt" | awk '{print $2}' | sort -u)
  IMPORTS=$(grep -oE '^import\s+[a-zA-Z0-9_.]+(\.[a-zA-Z0-9_*]+)?$' "$kt" | awk '{print $2}' | awk -F. '{print $NF}' | sort -u)
  # Call sites: identifiers followed by `(`, excluding keywords + same-line definitions
  CALL_SITES=$(grep -oE '\b[a-zA-Z_][a-zA-Z0-9_]*\(' "$kt" \
               | sed 's/($//' \
               | grep -vE '^(if|when|while|for|return|require|listOf|arrayOf|mapOf|setOf|Pair|Triple|let|run|with|apply|also|takeIf|takeUnless)$' \
               | sort -u)
  # Flag any call site not in IN_FILE_FUNS or IMPORTS or known Android/Kotlin builtins
  ...
done
```

(Same pattern for `.m` / `.swift` with adjusted regexes for Obj-C selectors / Swift function declarations.) This is heuristic — won't perfectly distinguish member calls on imported types from undefined function calls — but catches the headline case (`createTopNavBar()` invoked with no `fun createTopNavBar` anywhere and no import that could provide it).

The skill runs all seventeen checks; aggregates findings; prints them as a numbered list at the end of the layer.

### Pass

All checks agree across the native modules, the manifest, and the PCF. Print `✓ Layer 0 (contract consistency): pass — <ISO time>`.

### Warn (continues to Layer 1, doesn't fail the run)

One or more checks found mismatches. Print:

```
⚠️  Layer 0 (contract consistency): <N> warning(s)

1. Routing key mismatch:
   - manifest receivers[].name: '<Pascal>Extension'  ✓
   - pcf/.../index.ts uses: '<Pascal>'                ✗ — fix this
   Suggested fix: in pcf/<Pascal>PCF/<Pascal>PCF/index.ts line N, change ROUTING_KEY to "<Pascal>Extension"

2. Response field name mismatch:
   - ARCHITECTURE §4.2 expects: 'signatureBase64'
   - ios/.../Module.m emits key: 'result'  ✗ — should be 'signatureBase64'
   - android/.../Module.kt emits key: 'result'  ✗
   - pcf/.../index.ts reads: response.result.signatureBase64
   Suggested fix: ARCHITECTURE §4.2 and the native emit sites disagree. Either update the native modules to emit 'signatureBase64', or update ARCHITECTURE §4.2 + the PCF read to use 'result'.

...
```

The user decides whether to fix before continuing (re-run after fixing) or proceed to Layer 1 (acknowledging the drift). Use `AskUserQuestion`:

> Layer 0 found <N> contract inconsistencies. Proceed?
> - **Continue to Layer 1** — warnings recorded in `.extension-state.md` but don't block
> - **Stop here, fix the warnings first** — exit; user re-runs after fixing

### Fail (stops the run)

The hard-fail case is when a source file referenced by the check is missing entirely (e.g. no `<Pascal>Module.kt` under `android/`, no `RCT<Pascal>Module.m` under `ios/`). That's not contract drift — that's a missing artifact. Print `❌ Layer 0 (contract consistency): cannot proceed — <missing file>` and STOP.

---

## Step 3 — Layer 1: Native-source structure asserts

No `tsc` to run in this track — the control ships as a native binary, not a TS extension. Instead, grep/parse the native module source and assert it is shaped for the wrap runtime and the plugin's upload-compatibility checks. These are the same conformance asserts `/build-android-binary` and `/build-ios-binary` run before they compile (`ppmplugin-format §5`, §5b) — running them here surfaces a fixable-in-seconds mistake before a minutes-long build.

For **Android** (`android/.../<Pascal>Module.kt`):

- the module class **extends `ReactContextBaseJavaModule`** (the host loads it as a React Native module).
- `override fun getName()` returns the **canonical-prefixed** `'<Pascal>Module'` (`ppmplugin-format §3`) — and it MUST equal the manifest `receivers[].nativeModule` if a manifest is staged.
- **at least one `@ReactMethod fun <m>(...)`** is declared (a module with no `@ReactMethod` dispatches nothing).
- a **`ReactPackage`** is present (the `createNativeModules` registration the DEX needs — its FQN becomes `entrypoints.android.packageClass`).
- **no `@ReactModule` annotation** (that's the SDK-era registration path; the wrap host registers via the `ReactPackage`, not the annotation — its presence is SDK leakage that `/audit-ppmplugin` rejects).

For **iOS** (`ios/RCT<Pascal>Module.h` / `.m`):

- the header class **declares `<RCTBridgeModule>`**.
- **No `RCT_EXPORT_MODULE(...)` macro is present**; the `.m` declares `+ (NSString *)moduleName` and its return string equals Android `getName()` and the manifest `receivers[].nativeModule`. The Obj-C class name equals `entrypoints.ios.moduleClass`.
- **at least one `RCT_EXPORT_METHOD(<m>:...)`** is declared, and the method names are a subset of the manifest `receivers[].methods[]`.

#### Load & initialization readiness (crash-at-launch / won't-load asserts) — HARD gate

The single most-reported field failure is **"the app doesn't install or crashes on launch"** — and its root cause is almost always the plugin failing to **load** or the module **throwing during eager construction**, before any UI. Those are knowable from the source, so assert them **here** (Layer 1 stops on failure) rather than leaving them to the warn-only Layer 0 sweep or the post-build audit. Grounded in [`ppmplugin-format §5`](../../shared/ppmplugin-format.md) (Android DEX load + eager construction) and [`§5b`](../../shared/ppmplugin-format.md) (iOS `dlopen` + `[cls new]`).

**Android** (`android/.../<Pascal>Package.kt` + the module):
- the **`ReactPackage` class has a public no-arg constructor** — NOT `class <Pascal>Package(...)` with a parameter list. The wrap runtime instantiates it via `getDeclaredConstructor().newInstance()`; an arg-ed constructor throws `NoSuchMethodException` and the plugin **silently fails to load** (`Loaded 0 plugin package(s)`). (The module itself may take `ReactApplicationContext`; the **package** must be no-arg.)
- the **construction closure does not throw** — scan the module constructor(s), `init{}` block(s), and property initializers (plus one level of private fns they call) for the definitive crash triggers: a bare `Handler()` / `register*Callback(…, null)` on a possibly Looper-less thread, or uncaught I/O / hardware acquisition. A throw here **crashes the host at launch**. (This is the elevated, hard-gated form of the Layer 0 #12 heuristic — Layer 0 warns broadly; Layer 1 blocks on the clear triggers.)

**iOS** (`ios/RCT<Pascal>Module.{h,m}`):
- the module class **instantiates via `[cls new]`** — no custom initializer that takes arguments (the player does `NSClassFromString(moduleClass)` → `[cls new]`; an arg-ed-only initializer means the module is **skipped at load**).
- **`+ (BOOL)requiresMainQueueSetup` returns `NO`** (if declared). Returning `YES` forces main-thread setup at launch and, combined with any heavy/throwing `init`, stalls or crashes startup.
- **`init` / `+load` do no throwing or heavy work** — same eager-construction rule as Android; defer hardware/listeners to the first method call.

### Pass

Print `🟢 ✓ Layer 1 (native-source structure): pass — <ISO time>`. Continue to Layer 2.

### Fail

An assert above fails. Surface the **first 3** mismatches — each as `<file>:<line> — <what's wrong>`. Common classes + fixes:

1. Capture the relevant grep hits / misses.
2. Print the **first 3 mismatches** (most relevant) — not every grep line.
3. Suggest a fix per class:
   - Android `getName()` returns `'<X>'` but iOS `+moduleName` / manifest `nativeModule` is `'<Y>'` → the runtime symbols disagree. Align all three to the canonical-prefixed `'<Pascal>Module'` (`ppmplugin-format §3`). When the derived name hits a reserved prefix / denylist, rename per `ppmplugin-format §4`. If the Obj-C class name differs from `entrypoints.ios.moduleClass`, align the class or manifest entrypoint separately.
   - module does not `extends ReactContextBaseJavaModule` (Android) / does not declare `<RCTBridgeModule>` (iOS) → it won't register as a native module. Fix the class declaration.
   - no `@ReactMethod` / `RCT_EXPORT_METHOD` found → the module exposes nothing the host can call. Add the operation method(s) per ARCHITECTURE §4.
   - a `@ReactModule` annotation is present on the Android module → SDK-era leakage; remove it (the wrap host registers via the `ReactPackage`). This is a hard CRITICAL at `/audit-ppmplugin` time.
   - **`ReactPackage` has an arg-ed constructor** (`class <Pascal>Package(...)`) → the plugin loads 0 packages on device. Give it a public no-arg constructor (`ppmplugin-format §5`).
   - **construction closure throws** (Looper-less `Handler()`, `register*(…, null)`, uncaught I/O in the ctor / `init{}`) → crashes the host at launch. Defer to lazy first-call init, pass `Handler(Looper.getMainLooper())`, wrap unavoidable init in `try/catch`.
   - **iOS module has no no-arg init / `requiresMainQueueSetup` returns `YES` / `init` does heavy or throwing work** → the module is skipped at `dlopen` load or stalls launch. Instantiate via `[cls new]`, return `NO` from `+requiresMainQueueSetup`, and keep `init` cheap (`ppmplugin-format §5b`).
4. Update `.extension-state.md`: `Native-source structure (Layer 1): fail — <timestamp>`; `Status: blocked`; `Blocked reason: <first mismatch>`.
5. STOP. Do not run subsequent layers.

---

## Step 4 — Layer 2: Manifest validation

> **Auto-skip only if no manifest was found** (`$MANIFEST` empty per the detection in Step 2 — neither `./manifest.json` nor a staged copy). Print `⊝ Layer 2 (manifest validation): SKIPPED — no manifest on disk (hand-authored module). Run /generate-ppmplugin-manifest first.` Mark state as `n/a`. Continue to Layer 3. (With the scaffold, `./manifest.json` exists from native-gen, so this layer normally runs right here.)

When a manifest is on disk (`$MANIFEST` — the committed `./manifest.json` or the staged copy), re-run the plugin-maintained upload-compatibility checks **locally** against it — the same checks [`/generate-ppmplugin-manifest`](../generate-ppmplugin-manifest/SKILL.md) runs (`ppmplugin-format §4`). This cheap pre-flight catches common upload failures such as a mis-shaped `name` or `nativeModule` before any build. This layer **defers to `/generate-ppmplugin-manifest`** as the source of the rule set — it does not re-author the manifest, only validates the one on disk and points back at that skill to fix.

### Pass

Print `✓ Layer 2 (manifest validation): pass — <ISO time>`. Continue to Layer 3.

### Fail

A rule in `ppmplugin-format §4` is violated. Common classes + fixes:

| Class | Action |
|---|---|
| `name` regex / not kebab-of-class | `name` must be the kebab-case of the CLASS name (`ppmplugin-format §3`). Re-run `/generate-ppmplugin-manifest` to re-derive it. |
| Canonical-prefix violation | each `receivers[].nativeModule` must start with the canonical prefix of `name` (split on `-`/`_`, PascalCase each, join). Rename the module's `getName()` or fix `name`. |
| Reserved-prefix / denylist | `nativeModule` uses a reserved prefix or a Microsoft-owned bare name (`ppmplugin-format §4`). Rename to a non-reserved form (add a `Module` suffix or a vendor prefix). |
| `methods[]` ↔ source mismatch | a method in `methods[]` has no `@ReactMethod` / `RCT_EXPORT_METHOD` in the module, or vice versa. Re-run `/generate-ppmplugin-manifest` to re-derive `methods` from source. |

Update state: `Manifest validation (Layer 2): fail — <timestamp>`; `Status: blocked`. STOP.

> **Scope note:** this layer validates `manifest.json` only. The native source's *shape* is Layer 1; whether the binary it declares actually exists is `/assemble-ppmplugin`'s reconcile gate; whether the built `.ppmplugin` loads on device is `/audit-ppmplugin`.

---

## Step 5 — Layer 3: Native-source contract asserts

No `tsc --noEmit` fixtures to run in this track — there's no TS `src/` and no `src/types.ts` whose shape a type-fixture could pin. Instead, this layer grep-cross-checks the **request / response / error-code contract** between the two native parsers (iOS `.m`, Android `.kt`) and the PCF, deriving the expected field set from ARCHITECTURE §4 (or, if no PRD, treating the native source as the source-of-truth). It's the deeper sibling of Layer 0's checks 4–6 — Layer 0 surfaces them warn-only as part of the holistic sweep; Layer 3 gates on them.

For each operation:

- **request fields** — the NSDictionary key reads in the iOS parser, the ReadableMap key reads in the Android parser, and the PCF's `request.<field>` build must reference the same field names (ARCHITECTURE §4.1). A field read on one platform but not the other = platform-specific INVALID_INPUT.
- **response fields** — the keys in the iOS `successJsonWith:` build, the Android `successJson` build, and the PCF's `response.result.<field>` reads must match (ARCHITECTURE §4.2).
- **error codes** — every code in ARCHITECTURE §5 must be emitted by at least one native site (iOS `errorJsonWithCode:message:`, Android `errorJson(code, message)`) and handled by the PCF `setError` (case or default).
- **error message plumbing** — the native error helpers must carry a `message` argument, the PCF's `setError(code, message)` must be two-arg and assign `this.errorMessage`, and the ControlManifest must declare the three standard diagnostic outputs (`Status`, `ErrorCode`, `ErrorMessage`) with `getOutputs()` returning them. This is what makes a field failure debuggable from Power Fx with no native console.

### Pass

Print `✓ Layer 3 (native-source contract): pass — <ISO time>`. Continue to Layer 4 (if running).

### Fail

The most common failures here are a field read/emitted on one platform but not the other, or an error code declared in §5 that no native site emits.

| Error class | Likely fix |
|---|---|
| Field present in one parser but missing in the other | The iOS and Android parsers drifted. Add the missing key read (or remove the spurious one) so both reference the same field names per ARCHITECTURE §4.1. |
| Response key in native but not read by the PCF (or vice versa) | Native emits a key the PCF never reads, or the PCF reads `response.result.<x>` that no native site emits. Align the native build site and the PCF read. |
| Error code in §5 with no native emit site | A declared code is unreachable. Either emit it from the relevant native error path, or drop it from §5 (PRD drift). |

Update state: `Native-source contract (Layer 3): fail — <timestamp>`; `Status: blocked`. STOP. Do not run Layer 4.

---

## Step 5.5 — Layer 3.5: Mock-context runtime contract

> **No analogue in this track — always `n/a`.** The mock-context runtime layer instantiated the TS extension class (`new <Pascal>Extension(ctx)`) and drove `handleMessageAsync` against minimal/full host-context shapes. The `.ppmplugin` ships **no TS extension class, no `handleMessageAsync`, and no host `INativeExtensionContext`** — dispatch goes straight to `NativeModules.<nativeModule>.<method>` over the wrap bridge (`ppmplugin-format §2`, §6). There is nothing to instantiate off-device.

The equivalent "does it actually run?" assurance for a native-only bundle lives in two places, neither of which this skill can do off-toolchain:

- **does the native code compile into a loadable binary** → `/build-android-binary` // `/build-ios-binary` (real Gradle / xcodebuild).
- **does the built `.ppmplugin` load + dispatch on the wrap runtime** → `/audit-ppmplugin` (the byte-scan + structure gate) and the Layer 5 device recipe.

Print `⊝ Layer 3.5 (mock-context runtime): n/a — native-only track has no TS extension class to instantiate (see /audit-ppmplugin + Layer 5).` and continue to Layer 4.

---

## Step 6 — Layer 4: PCF compile

> **Auto-skip if no `ControlManifest.Input.xml` was found under `pcf/`** (per the `find`-based detection in Step 2). Print `⊝ Layer 4 (PCF compile): SKIPPED — PCF not yet scaffolded. Run /generate-pcf-companion first.` Mark state as `n/a`. Continue to Layer 5.

This layer compiles the Companion PCF — manifest XML + `index.ts` + any engineer customizations. Catches:

- TS errors in `index.ts` (introduced by hand-edits after scaffold)
- Property name mismatches between `ControlManifest.Input.xml` and `index.ts` (e.g. manifest declares `PenColor` but the code references `p.penColor`)
- Missing output property declarations (e.g. §8.3 was edited but the PCF wasn't regenerated)
- Broken `pcf-scripts` deps

The PCF tooling uses **npm**, not pnpm — this is a PCF ecosystem convention. Do not unify.

### Run

From the repo root:

**macOS / Linux / Windows (same command):**

```bash
cd "$PCF_PROJECT_ROOT"   # from the find-based detection in Step 2
[ -d node_modules ] || npm install --no-audit --no-fund   # first time only; ~30s
npm run build --silent
```

Notes:
- `npm install` only runs on first invocation (or if `node_modules/` was wiped). Subsequent runs are seconds because `pcf-scripts build` is fast on warm caches.
- `--silent` keeps the output tight; errors still print.
- `npm run build` runs `pcf-scripts build`, which:
  1. Regenerates `pcf/<Pascal>PCF/<Pascal>PCF/generated/ManifestTypes.d.ts` from the manifest XML.
  2. Type-checks `index.ts` against the regenerated `ManifestTypes.d.ts`.
  3. Bundles output to `pcf/<Pascal>PCF/out/`.

### Pass

`npm run build` exits 0 and emits `out/` artifacts. Print `✓ Layer 4 (PCF compile): pass — <ISO time>`.

### Fail

`npm run build` exits non-zero. Common error classes:

| Error class | Likely fix |
|---|---|
| `Property '<X>' does not exist on type 'IInputs'` | Manifest declares one name, `index.ts` references another. Open `ControlManifest.Input.xml` and `index.ts` side-by-side; align the property name (case-sensitive). |
| `Property '<X>' is missing in type` (on `getOutputs()` return) | An output was added to the manifest but not returned by `getOutputs()`, or vice versa. Either add the missing field to `getOutputs()` or remove the spurious manifest entry. |
| `Cannot find module 'pcf-scripts'` | First-run hasn't completed `npm install`. The skill should have run it; re-run `npm install` manually if needed. |
| `XML parsing failed at line <n>` | Manifest XML is malformed. Most often an unclosed tag or a `default-value` attribute on a property that doesn't allow defaults (e.g. `usage="output"` properties can't have defaults). |
| Standard `tsc` errors in `index.ts` | Engineer-introduced regression. Read the line:col, fix the source. |

Update state: `PCF build (Layer 4): fail — <timestamp>`; `Status: blocked`. STOP. Do not run Layer 5.

---

## Step 6.5 — Layer 4.5: Android lint

> **Catches the "the Android build rejects this module on lint" class of bug locally.** Real cost on pen-input: 8 Android lint warnings surfaced only when the integration build ran, forcing a patch round-trip. Each could have been caught here.

Android Studio's lint rules are stricter than a quick grep (it checks call patterns, resource references, deprecated APIs, accessibility). `/build-android-binary` compiles the staging-copy module against the pinned AGP; running `./gradlew lint` here first surfaces the same warnings before that build.

### How it runs

```bash
# Detect whether gradle wrapper is present
if [ -f android/gradlew ]; then
  cd android && ./gradlew lint --warning-mode=summary
fi
```

If `android/gradlew` is NOT present (extension scaffolded before this layer became standard) → skip with `Layer 4.5 (Android lint): skipped (no gradle wrapper at android/gradlew — hand-add the gradle wrapper to `android/`).` Don't fail the run; just note the gap.

If gradle wrapper is present but `./gradlew lint` exits non-zero → parse the report at `android/build/reports/lint-results-debug.html` (or stderr) and surface the warnings as a numbered list.

### Pass

Print `✓ Layer 4.5 (Android lint): pass — <ISO time>`. Continue to Layer 5.

### Warn (continues to Layer 5, doesn't fail the run)

```
⚠️  Layer 4.5 (Android lint): <N> warning(s) — the Android build may reject these

1. NewApi at <file>:<line>
   Call requires API level X (current min is Y). Either bump minSdk, gate the call,
   or suppress with @TargetApi(X) annotation.

2. UnusedResources at res/drawable/ic_unused.png
   Drawable not referenced; safe to remove.

... etc.
```

Then `AskUserQuestion`:

```
Question: "Android lint found <N> warning(s). What now?"
Header:   "Lint warnings"
Options:
  1. "Continue to Layer 5"        description: "Warnings noted in .extension-state.md. Fix later; not all warnings block /build-android-binary."
  2. "Stop, I'll fix first"       description: "Skill exits. Address the warnings (typically straightforward), then re-run /test-native-extension."
  3. "Show me the full lint report"  description: "Print the full HTML report path + key offending lines, then re-ask."
```

### Fail

`./gradlew lint` errors (not warnings — actual failures: gradle daemon crash, dependency resolution, etc.). Surface the error tail and STOP with `Layer 4.5: fail — <one-line cause>`. The user fixes the gradle setup before retrying.

### Skip

If the project has no `android/` folder at all (TS-only or iOS-only extension — rare) → `Layer 4.5: skipped (no android/ in repo).` Continue to Layer 5.

---

## Step 7 — Layer 5: Manual device / simulator guidance

This layer is **interactive and outside the scope of automation** — it requires a built + audited `.ppmplugin`, the wrap host that loads it, a device or simulator, and the Companion PCF deployed to a test environment. The skill prints a copy-pasteable recipe; the engineer runs it; the skill records the outcome.

> **Why Layer 5 is NOT redundant after Layers 0–4 all pass.** Layers 0–4 verify **structure** — the symbols line up, the key matches, the manifest is aligned, the PCF compiles. **Layer 5 is the first time the actual bytes move over the wire.** Wire-format and runtime bugs that every structural layer is blind to — a direct `cordova.exec` call instead of `sendAsync` (→ nothing dispatches, silent on Android), the host's re-stringification of the response, the wrap `{message}` response container the PCF must unwrap, a native-module constructor that throws at startup (→ crash on launch, before any UI), a permission denied at runtime — only surface here. An all-green Layers 0–4 means "the shapes are right," NOT "it dispatches on device." Do not treat a green automated run as end-to-end confidence; the first launch + first tap are the real tests. (Layer 0 checks 1b/12/13 grep for the `sendAsync` transport, the constructor crash pattern, and the response-unwrap pre-device; the Layer 5 crash-scan below is the definitive catch.)

Print:

```
Layer 5 — Manual end-to-end validation (interactive)
─────────────────────────────────────────────────────

This validates the full path: Canvas formula → PCF → SendMessagePlugin bridge → NativeModules.<nativeModule>.<method> → response back to Canvas.

PREREQUISITES (one-time per machine):
  • A built + audited bundle: run /generate-ppmplugin (or the stage skills) so ppmplugin/<name>.ppmplugin exists and passed /audit-ppmplugin
  • A wrap host configured to side-load the .ppmplugin (the wrap shell from the wrap pipeline — its load/upload flow is owned there)
  • Active pac auth profile against your test environment (`pac auth list` — star should be on the test env)
  • For iOS device: a provisioning profile that allows running the wrap app on your device
  • For Android device: USB debugging enabled + `adb devices` shows your device

BUILD & AUDIT THE BUNDLE (each iteration of the control):

  # 1. From the control repo, produce a verified bundle:
  cd <this repo>
  /generate-ppmplugin
  # → drives manifest → build-android/ios → assemble → audit; lands ppmplugin/<name>.ppmplugin

  # 2. Confirm it's READY TO UPLOAD:
  /audit-ppmplugin
  # → CRITICAL-free verdict before you side-load it

LOAD INTO THE WRAP HOST:

  # Side-load ppmplugin/<name>.ppmplugin into the wrap host per the wrap pipeline' load flow.
  # The host runtime registers the DEX's ReactPackage / the iOS framework's moduleClass +moduleName;
  # the manifest's receivers[] become the routing keys the SendMessagePlugin bridge dispatches to.

DEPLOY THE PCF (if not already done):

  # Easiest: use the dedicated skill — it handles prefix selection + env confirmation:
  /publish-pcf-companion

  # Manual equivalent (substitute a 2–8 char prefix):
  cd pcf/<Pascal>PCF
  pac pcf push --publisher-prefix pamext
  # The control appears in Canvas Studio under Custom controls > PowerApps namespace.

RUN ON DEVICE:

  # iOS: build & run the wrap app on simulator or device (Xcode).
  # Android: install the wrap app on connected device / running emulator.

RUNTIME CRASH-SCAN (Android — the DEFINITIVE catch for the launch-crash + response-shape classes
that every static layer is blind to; run right after launching the wrap app):

  # A) CONSTRUCTION CRASH — a native-module constructor / init{} that throws at bridge startup
  #    takes down the host BEFORE any UI (e.g. registerTorchCallback(cb, null) on a Looper-less
  #    thread → "Can't create handler…"). Launch the app, then scan logcat for the signatures:
  adb logcat -c
  adb shell monkey -p <wrap-package> -c android.intent.category.LAUNCHER 1 >/dev/null
  sleep 8
  if adb logcat -d | grep -iE "Looper\.prepare|Can't create handler|Loaded 0 plugin package|UnsatisfiedLinkError|FATAL EXCEPTION"; then
    echo "✗ LAUNCH CRASH / plugin-load failure — see the matched line (fix: defer ctor side-effects to lazy init, Handler(Looper.getMainLooper()), try/catch)"
  else
    echo "✓ no launch crash / plugin-load failure in the first 8s"
  fi

  # B) RESPONSE ROUND-TRIP — a PCF that only deepParses misses the wrap {isUpdate, message:"<json>"}
  #    container and fails EVERY call with UNEXPECTED_PAYLOAD though native succeeded. On the canvas
  #    screen bind a label to Self.<name>Json, tap the control once, and read it:
  #      ✓ shows the module's own {"status":"ok",…}                     → PCF unwraps correctly
  #      ✗ shows {"isUpdate":…,"message":"{\"status\"…"}               → PCF isn't unwrapping the
  #        container (fix: extractResponse, not a bare deepParse — /generate-pcf-companion + §2)
  #      ✗ Status=error, ErrorCode=UNEXPECTED_PAYLOAD                    → same root cause

INSTALL-FAILURE SCAN (run if the wrap app won't install at all — before the launch scan):

  # Android — a failed `adb install` prints the reason; the common ones map to a fix:
  #   INSTALL_FAILED_INSUFFICIENT_STORAGE  → free space / wipe the emulator
  #   INSTALL_FAILED_UPDATE_INCOMPATIBLE / signatures do not match  → uninstall the old app first:
  #       adb uninstall <wrap-package>
  #   INSTALL_FAILED_NO_MATCHING_ABIS      → the .so / ABI in android/lib/<abi> doesn't match the device
  #   INSTALL_FAILED_OLDER_SDK             → device OS below the wrap app minSdk
  # iOS — install/launch failing before any JS runs is usually signing, not your module:
  #   "Unable to install" / codesign / provisioning  → the wrap app's profile doesn't allow this device
  #   dyld: Library not loaded / @rpath …<Name>.framework  → the framework wasn't embedded by the wrap
  #     pipeline (a packaging issue, not a source bug) — re-check /assemble-ppmplugin + /audit-ppmplugin.

RUNTIME CRASH-SCAN (iOS — the analogue of the Android scan; run right after launching the wrap app on
a simulator/device. A throwing/heavy init or a module that won't load surfaces in the device log):

  # Stream the wrap app's log and scan for the iOS launch/init + load-failure signatures:
  xcrun simctl spawn booted log stream --level=default --predicate 'processImagePath CONTAINS "<wrap-app>"' &
  # (device: use Console.app filtered to the app, or `idevicesyslog`.) Then launch the app and watch for:
  #   ✗ "Native module '<X>' not loaded" / NSClassFromString → nil   → +moduleName / dead-code-stripping / used RCT_EXPORT_MODULE (§5b)
  #   ✗ dyld: Symbol not found / @rpath …React                       → React linked strongly, or RN pin ≠ host RN
  #   ✗ *** Terminating app due to uncaught exception … in -[<Module> init]  → throwing init (defer to lazy first call)
  #   ✓ no such lines in the first ~8s after launch                  → no iOS launch/init crash

WHAT TO VERIFY (per ARCHITECTURE §8 Edge cases — copy into a checklist):

  [ ] Happy path: <one-line happy-path scenario>
       Expected: <Pascal>PCF1.<OutputName> = '<value>' per ARCHITECTURE §8
  [ ] Error case <CODE_1>: <how to trigger>
       Expected: <Pascal>PCF1.<OutputName> = 'error: <CODE_1>'
  [ ] Error case <CODE_2>: <how to trigger>
       Expected: <Pascal>PCF1.<OutputName> = 'error: <CODE_2>'
  ... (one row per error code in ARCHITECTURE §5)

TROUBLESHOOTING:

  • Bridge resolves "NOT_IN_PAM" → opening in Studio preview (no bridge). Open in the wrap app on a device.
  • "native module '<nativeModule>' not loaded" → the .ppmplugin didn't register. Re-run /audit-ppmplugin (catches the DEX/framework structure + SDK-leakage causes on disk) and re-side-load.
  • Bridge times out → check Logs via Xcode Console (iOS) or `adb logcat` (Android) filtered to `<nativeModule>` or `SendMessagePlugin`.
```

Tailor each `<...>` to the docs. Pull the happy-path scenario from ARCHITECTURE §6.2 (Bridge wiring trigger) + PRD §1 (Summary). Pull each error row from ARCHITECTURE §8.

**Print and move on. Do NOT wait for the user to run the recipe and report back** — manual device testing can take 5–10 minutes; making the skill block on it makes the iteration loop awkward. The recipe is *next-steps guidance*, not a gated layer.

The skill's job at Layer 5 ends here. The user runs the recipe on their own time. To record the outcome later, the user can either:

- **Edit `.extension-state.md` directly** — under "Validation history", update the `Manual / device (Layer 5):` line with `pass | partial | fail | manual` + an ISO timestamp + (optionally) a note about which rows failed.
- **Re-run `/test-native-extension`** — Layers 1–4 are cheap; the Layer 5 recipe re-prints and the user can update state manually after running it again.

The skill's responsibility is to make sure the recipe is correct and tailored to the current PRD. The execution and result-recording are the user's.

---

## Step 7.5 — Layer 6 (optional): Deep `.ppmplugin` audit pointer

> **Pointer-only — routes to [`/audit-ppmplugin`](../audit-ppmplugin/SKILL.md). Not run here.** Only relevant once a built bundle exists on disk.

If a built `ppmplugin/*.ppmplugin` is present (this skill's structural layers run on *source*; they don't unzip a bundle), point at the dedicated deep-verification gate rather than re-implementing it:

```bash
BUILT_BUNDLE=$(ls ppmplugin/*.ppmplugin 2>/dev/null | head -1)
```

If `$BUILT_BUNDLE` is set, print:

```
ⓘ Layer 6 (deep bundle audit): a built bundle exists (<path>).
   Run /audit-ppmplugin for the byte-level verification this skill can't do on source:
   zip structure, manifest↔bundle consistency, DEX SDK-leakage byte-scan, iOS framework
   structure — the gate that proves it will actually load + dispatch on the wrap runtime.
```

If no built bundle exists, omit this layer silently (nothing to audit yet — the build skills haven't run).

---

## Step 7.6 — Layer 7 (opt-in): Deep runtime-safety reasoning review

> **Opt-in, advisory, whole-repo. The reasoning counterpart to the fast deterministic greps in Layer 0.** Layer 0 (checks 12–17) and `/audit-ppmplugin` Category F catch the *deterministic subset* of the runtime-safety class — a Looper-less constructor `Handler`, an un-unwrapped `{message}` response, a Promise-taking method with zero settle sites, a declared-but-unchecked dangerous permission, an unguarded `currentActivity`. They're fast and false-positive-light *because* they're narrow. This layer is the broad reasoning pass that catches what a grep can't: a resource released on only *some* paths, a Promise double-settled under an error branch, UI presented off the main thread three calls deep, a manager acquired in a helper and never torn down.

**When to offer it.** After the automated layers pass, if the control has native modules (`ios/` or `android/` present), offer it via the Step 8.1 next-step gate as one option — **never run it by default**. It reasons over the whole tree (slower) and is **advisory**: it returns `DONE_WITH_CONCERNS`, it does **not** flip `Overall` to blocked. A broad reasoning pass must not false-positive-gate a working control.

**What it runs.** Read `shared/self-critique-protocol.md` and run it in **holistic review mode** (see that file's *Run modes*) — i.e. enumerate **every** source file in the control (`ios/`, `android/`, `pcf/`, `manifest.json`, `AndroidManifest.xml` / `Info.plist`, `build.gradle` / podspec), not just files touched this run — with emphasis on **Gate 9 (Runtime safety & resource lifecycle)**. Gates 1–8 also apply, but Gate 9 is the reason this layer exists as a device-independent complement to the Layer 5 on-device crash-scan.

**Output.** Per-module findings table (`Item | Question | Finding | Severity | Fix`). Print `ⓘ Layer 7 (deep runtime-safety review): <N> concern(s) — advisory, not blocking` and list them. Record the count in `.extension-state.md` under Validation history as `Deep review (Layer 7): <N> concerns — <timestamp>`. If the user wants any concern fixed, route to `/debug-extension`.

---

## Step 8 — Final report and state update

Build a summary table:

```
Test summary
────────────
Layer 0 (contract check):       <pass | warn-N | skip> — <time>
Layer 1 (native structure):     <pass | fail | skip> — <time>
Layer 2 (manifest validation):  <pass | fail | n/a — no manifest> — <time>
Layer 3 (native contract):      <pass | fail | skip> — <time>
Layer 4 (PCF compile):          <pass | fail | n/a — PCF not scaffolded> — <time>
Layer 5 (manual E2E):           recipe printed (run on device when ready)
Layer 7 (deep runtime review):  <N concerns | not run — opt-in>

Overall (automated): <pass | blocked>

Note: native iOS / Android compile into a loadable DEX / framework is NOT validated by this skill — run /build-android-binary // /build-ios-binary.
```

**The skill's `Overall` reflects only the automated layers (1–4).** Layer 5 is recipe-only — its execution and result-recording are the user's responsibility. The user updates `.extension-state.md` manually after running the recipe on a device.

Update `./.extension-state.md`:
- `Validation history` block: write one line per **automated** layer (1–4) with the result + ISO timestamp. The Layer 5 line is left as `manual / device (Layer 5): recipe printed at <timestamp>` — the user updates it manually after running on device.
- `Phase`: if all **automated** layers (1–4) that were run passed, set `Last completed: tested` and `Next: /generate-ppmplugin or /audit-ppmplugin or /publish-pcf-companion` (whichever applies for the user's next intent). Otherwise keep `Status: blocked` with the first-failing-layer reason.

### 8.1 Next-step gate

Per `shared/shared-instructions.md §9.1` and the feedback memory `[[feedback-skills-execute-not-describe]]`: when there are real next-step choices, present them via `AskUserQuestion` with **context-aware options** — not a plain-text bullet list, and not a fixed list that ignores what's possible from here.

**On failure (any automated layer failed):**

Do NOT use AskUserQuestion — there's only one rational next step (fix and re-run). Print:

```
Fix the <failing layer> error above (most relevant log line surfaced in Step 8 summary),
then re-run /test-native-extension. Re-runs are idempotent — pass-through to the failing layer.
```

**On success (all automated layers passed):**

First, scan the repo + state file to determine which options are *applicable*. This is the "figure out what skills could be triggered after that in scenarios" part — don't show options that can't succeed from here.

| Detector | Implies |
|---|---|
| `./manifest.json` present but nothing built (`ppmplugin/` empty) | `/generate-ppmplugin` is the canonical next step — it validates + stages `./manifest.json`, then drives build → assemble → audit and lands the verified bundle. |
| no `./manifest.json` at all (hand-authored module) | `/generate-ppmplugin-manifest` (or `/generate-ppmplugin`, which runs it as a stage) authors the manifest from source first. |
| a built `ppmplugin/*.ppmplugin` exists | `/audit-ppmplugin` is the natural follow-up — the deep verification gate this skill's source-only layers can't do. |
| `pcf/` folder exists with a `ControlManifest.Input.xml` | PCF is scaffolded; `/publish-pcf-companion` is unlocked. |
| `pcf/` is absent | `/generate-pcf-companion` is relevant; `/publish-pcf-companion` is not applicable yet. |
| `.extension-state.md` has a `## PCF deployments` entry | PCF has been deployed at least once; `/publish-pcf-companion` re-runs are just version bumps + push. |
| `ios/` or `android/` present and Layer 7 not yet run this session | offer **Deep runtime-safety review (Layer 7)** — the opt-in whole-repo reasoning pass (Gate 9) that catches the multi-path resource/Promise/thread/permission bugs the Layer 0 greps can't. Advisory, never a default. |

Then call `AskUserQuestion` with the 3–4 most relevant options + a "Stay" escape hatch. Order: most-canonical-next first; alternatives by priority; escape-hatch last (per the multi-option rule in `§9.1`).

**Worked example option sets** (the actual options must be derived from the detectors above per-run):

| Repo state | Question options |
|---|---|
| `./manifest.json` present, nothing built | `/generate-ppmplugin` (Recommended) / `/generate-pcf-companion` / `/debug-extension` / Stay |
| No `./manifest.json` (hand-authored module) | `/generate-ppmplugin` (Recommended) / `/generate-ppmplugin-manifest` / `/debug-extension` / Stay |
| Built bundle exists, not yet audited | `/audit-ppmplugin` (Recommended) / `/publish-pcf-companion` / `/debug-extension` / Stay |
| Bundle audited, PCF deployed | `/publish-pcf-companion` (Recommended) / `/audit-ppmplugin` (re-verify) / `/debug-extension` / Stay |
| Re-running after `/debug-extension` (incremental) | `/generate-ppmplugin` (Recommended) / `/debug-extension` / Stay (drop publish until user explicitly wants release) |

The header descriptions should call out what makes each option appropriate for the current state — e.g. for `/generate-ppmplugin`: "Drives manifest → build-android/ios → assemble → audit and lands a *verified* `.ppmplugin` on disk — the binary this structural pre-flight is clearing the way for." This way the user understands WHY each option is being offered.

**Question template:**

```
Question: "What would you like to do next?"
Header:   "Next step"

Options:
  1. "Run /<recommended>"   description: <what it does in this state>
  2. "Run /<alternate-1>"   description: <…>
  3. "Run /<alternate-2>"   description: <…>
  4. "Stay — I'll review the test report"
     description: "Skill exits. Inspect Layers 1–5 output above; decide what to run next yourself."
```

Always include `/generate-ppmplugin` (when no verified bundle exists) or `/audit-ppmplugin` (when one does) as one of the options whenever Layers 1–4 passed — building/verifying the `.ppmplugin` is the natural follow-up to a clean structural pre-flight regardless of repo state.

---

## Return-status protocol

The literal first line of your final message MUST be one of:

| Code | Meaning |
|---|---|
| `DONE` | All automated layers (1–4) that were applicable passed. State updated to Phase=tested. (The Layer 5 device recipe was printed; the user runs it separately.) |
| `DONE_WITH_CONCERNS: <list>` | All automated layers passed but with caveats — typically Layer 4 deferred (PCF not yet scaffolded), so the engineer should run `/generate-pcf-companion` before considering tests complete. |
| `NEEDS_CONTEXT: <missing>` | Couldn't run because a required input was missing (e.g. ARCHITECTURE §8 empty so the Layer 5 recipe checklist can't be built — but the rest of the run still completed; this is a soft NEEDS_CONTEXT). |
| `BLOCKED: <reason>` | An automated layer failed and was not auto-fixable. State marked blocked with the first failing layer's error message. |

After the first line, blank line, then the human-readable summary.

---

## Hard rules

- **Stop on first failure (automated layers only).** Don't run Layer 2 if Layer 1 failed, etc. Wasted compute and confusing reports.
- **Layer 5 is print-only.** Do NOT ask the user "Did it pass?" — don't gate the skill on a manual device test that takes 5–10 minutes. Print the recipe, finalize Layers 1–4 results, exit. The user runs the recipe on their own time and updates state manually.
- **Don't run native compile here.** Native compilation into a loadable DEX / framework is [`/build-android-binary`](../build-android-binary/SKILL.md) // [`/build-ios-binary`](../build-ios-binary/SKILL.md) — they build the staging-copy module against the pinned AGP / xcodebuild settings (`ppmplugin-format §5`, §5b). A bare `pod lib lint` / `./gradlew assembleDebug` from this skill would give false-confidence (it resolves deps from public CDN/maven, not against the wrap host's pinned RN). If a previous version of this skill emitted `.test/ios/` or `.test/android/` scaffolding, those directories should be deleted — they're not part of the current flow.
- **No `--force` flags to make a layer "pass".** Fix the source — don't disable strict mode, suppress warnings, or skip dependency resolution.
- **Don't write to .extension-state.md mid-layer.** Update once at the end with all layers' results, or update incrementally with `Status: blocked` on each failure — but never leave the file in a half-updated state if you stop mid-run (Crashed-Claude problem).
- **Don't run npm publish / pnpm publish / pac pcf push.** Those belong to the publish skills.
