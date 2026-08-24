---
name: build-android-binary
description: "Compile a PAM control's Android Kotlin module into the runtime-loadable DEX for a `.ppmplugin`. Creates a staged Gradle build with the pinned wrapper and `react-android` compile dependency, verifies manifest/module/package alignment and runtime-loading constraints, builds the release AAR, then runs `d8 --min-api 24`. Writes `ppmplugin/staging/android/<PascalName>Plugin.dex` and surfaces actionable Gradle or d8 failures. Requires JDK 17+ and Android SDK Build-Tools 35.0.0; `d8` is located from the SDK and system Gradle is optional. Run after /generate-ppmplugin-manifest and before /assemble-ppmplugin."
---

# /build-android-binary

Turns the extension's Android **source** (`android/.../<Pascal>Module.kt` + `<Pascal>Package.kt`) into the **DEX binary** that the wrap runtime loads at runtime via `DexClassLoader`. This is the heavyweight, toolchain-dependent step of producing a `.ppmplugin`: source code in, a runnable `<Pascal>Plugin.dex` out.

> Naming note: this skill runs Gradle's `assembleRelease` task internally. Don't confuse that with [`/assemble-ppmplugin`](../assemble-ppmplugin/SKILL.md), which zips the final bundle — different layers. This skill produces a *binary*; that one produces the *bundle*.

> **Cross-platform:** runs on macOS, Linux, **and** Windows — the Android path has no Mac-only step (JDK 17, Gradle, and Android SDK `d8` exist on all three). Every shell command below is given in both bash and PowerShell forms per shared-instructions §5.

Read [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md) §5 — the Android binary requirements this skill enforces.

## What this skill does NOT do
- Does not author `manifest.json` (run [`/generate-ppmplugin-manifest`](../generate-ppmplugin-manifest/SKILL.md) first — this skill reads it for cross-checks).
- Does not zip the `.ppmplugin` — that's [`/assemble-ppmplugin`](../assemble-ppmplugin/SKILL.md).
- Does not build iOS — that's `/build-ios-binary` (Mac-only).
- Does not modify the canonical `android/` — all standalone adjustments are made to a throwaway copy under `ppmplugin/staging/android-build/` (Step 2). The source the engineer maintains is never touched.

---

## Step 1 — Read shared docs + prereq block

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md) and [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md).
2. Read `ppmplugin/staging/manifest.json`. If absent, STOP with `NEEDS_CONTEXT: manifest.json missing — run /generate-ppmplugin-manifest first` (the build cross-checks against it).
2b. Read the `## ppmplugin (third-party controls)` block in `.extension-state.md`. **If a DEX already exists** at `ppmplugin/staging/android/<dex>`, do NOT silently overwrite it — surface it (with its build timestamp) and ask via `AskUserQuestion` whether to **replace** it:
   - Source + `manifest.json` **unchanged** since the recorded `Android DEX: built` timestamp → recommend **Keep existing (reuse)** [default]; also offer **Replace (rebuild)**.
   - Source or manifest **changed** → recommend **Replace (rebuild)** [default]; also offer **Keep existing** (note: stale — won't match current source).
   On **Keep**, skip straight to Step 6 (report) using the existing DEX. On **Replace**, continue the rebuild. Building is always safe to repeat — this gate just respects an artifact you may have produced on purpose.
3. Run prereq checks and print the visible block (shared-instructions §9.2). **Policy: resolve, don't punt.** Each check first tries to *satisfy itself* — locate a tool by its standard install path (not just PATH), or offer to run a safe install and execute it on `yes` (§1.5 auto-fix flow). A check only hard-BLOCKs when it needs something genuinely un-resolvable without a human (e.g. a role grant). "Found but not on PATH" is NOT a block — use the absolute path. Checks:

| Check | Verify | Auto-fix |
|---|---|---|
| JDK 17 | `java -version` (17+) | OS-aware install per shared-instructions §1.5 (offer; user confirms) |
| Gradle (bootstrap only) | `gradle --version` — **any** version is fine; it only generates the pinned wrapper (Step 2.3). A system Gradle isn't used for the build, so don't flag its version here. | install Gradle (OS-aware) if absent |
| Android SDK Build-Tools 35 + `d8` | **Locate `d8`, don't require it on PATH** (see below) | If found anywhere, PASS. Only if no `d8` exists at all → auto-fix-on-confirm `<sdkmanager> "build-tools;35.0.0"`. |
| **Android platform 35** | `<sdkmanager> --list_installed` includes `platforms;android-35`, or `$ANDROID_HOME/platforms/android-35/` exists | **Auto-fix on confirm:** run it (see below). |

**Locating `d8` (do NOT block just because it's not on PATH).** A user with Android Studio has `d8` installed but rarely on PATH. Resolve it to an absolute path and *use that path* in Step 5:
1. `command -v d8` / `where d8.bat` — if on PATH, use it.
2. Else search the SDK root (`$ANDROID_HOME`, else `$ANDROID_SDK_ROOT`, else mac default `~/Library/Android/sdk`, win default `%LOCALAPPDATA%\Android\Sdk`): pick `build-tools/35*/d8` (mac/linux) or `build-tools\35*\d8.bat` (win). Prefer a 35.x build-tools; fall back to the highest available.
3. Record the absolute path as **`$D8`** and PASS the check with a note: `✓ d8 found at <path> (will invoke by absolute path)`. **Do not require a PATH edit.**
4. BLOCK only if no `d8` exists anywhere → offer to install via `<sdkmanager> "build-tools;35.0.0"` (`<sdkmanager>` resolved the same way — search `$ANDROID_HOME/cmdline-tools/*/bin/sdkmanager` and `$ANDROID_HOME/tools/bin/sdkmanager`, not just PATH).

**Installing platform 35 (auto-fix on confirm).** When the platform-35 check fails, OFFER to run the install and wait for `yes` (shared-instructions §1.5 — execute, don't just print):
```bash
# if sdkmanager is missing entirely (mac):
brew install --cask android-commandlinetools
# then (yes | …  auto-accepts the SDK licenses):
yes | <sdkmanager> "platforms;android-35"
```
Re-verify after, then proceed. Only STOP if the user declines or the install fails.

**Why platform 35 specifically:** the standalone build compiles against `compileSdk 35` (Step 2), because RN 0.79's `react-android` AAR is built against compileSdk 35 and AGP forces consumers to `compileSdk ≥ 35`. That requires `platforms;android-35` and AGP 8.x (7.x can't compile against android-35). So **35 is the floor**, not "34 or newer."

---

## Step 2 — Stage a standalone build copy (canonical `android/` stays pristine)

The repo's `android/` is a bare library module meant to be consumed by **the managed host build's** Gradle: it relies on the host to supply `rootProject.ext` values (`compileSdkVersion`, `minSdkVersion`, `kotlin_version`, read via `safeExtGet(...)`) **and** to put React Native on the classpath. Standalone, none of that exists — so the `safeExtGet` fallbacks apply and React doesn't resolve. Rather than mutate the canonical `android/build.gradle` (which would degrade the real source to satisfy a throwaway build), **build from a copy.**

1. **Copy** `android/` → `ppmplugin/staging/android-build/`. Delete + recopy fresh on every run so it never drifts from canonical. Apply these standalone adjustments to the **COPY only**:

   a. **Pin React Native.** The generator now writes `compileOnly "com.facebook.react:react-android:<rnVersion>"` directly, so on a freshly scaffolded control this is already correct and the step is a no-op — verify and move on. Older controls carry the legacy `implementation 'com.facebook.react:react-native:+'` (or the `compileOnly` variant of it); rewrite those in the copy to `compileOnly "com.facebook.react:react-android:<rnVersion>"` (`<rnVersion>` from `package.json` devDependencies, e.g. `0.79.7`). Standalone, the host doesn't supply React, and the modern Android coordinate is `react-android` (resolves from `mavenCentral()`). `compileOnly` so it is never bundled — RN is provided at runtime by the wrap shell. If you had to rewrite, say so: the canonical source is drifting and `/debug-extension` should fix it there.

   b. **Pin compileSdk to 35.** The standalone build has no managed host build `rootProject.ext`, so `safeExtGet('compileSdkVersion', …)` uses the control's own fallback (older controls default to 33) — which may be too low: RN 0.79's `react-android` AAR is built against **compileSdk 35**, and AGP refuses to let a `compileSdk < 35` module compile against it. Set the copy's `compileSdkVersion` to **35** (and ensure `minSdkVersion` is **≥ 24**, the AAR's floor). This requires AGP 8.x (7.x can't compile against android-35). See [`ppmplugin-format.md §5`](../../shared/ppmplugin-format.md). Leave `targetSdkVersion` as-is if already ≥ 35.

   c. Ensure both `google()` and `mavenCentral()` are in `repositories`.

2. **Add `settings.gradle`** in the copy declaring the library as its own root project:
   ```gradle
   rootProject.name = "<lower>plugin"
   ```
3. **Add a Gradle wrapper pinned to the version RN 0.79 uses with AGP 8.8.2.** RN 0.79 pairs AGP 8.8.2 with Gradle **8.13**. The wrapper MUST pin **8.13** (AGP 8.8 needs Gradle 8.10.2+; older Gradle fails).

   **Preferred — write a pre-generated wrapper, skip the bootstrap.** Write `gradle/wrapper/gradle-wrapper.properties` directly into the staging copy, pinning **both** the distribution URL and its checksum, plus the `gradle-wrapper.jar` + `gradlew`/`gradlew.bat` scripts:

   ```properties
   distributionUrl=https\://services.gradle.org/distributions/gradle-8.13-bin.zip
   distributionSha256Sum=20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78
   ```

   `distributionSha256Sum` is mandatory, not optional. The first `./gradlew` invocation downloads and then **executes** that archive; HTTPS alone authenticates the host, not the bytes. With the pin, Gradle verifies the distribution and aborts on mismatch — fail-closed. The value above is the SHA-256 Gradle publishes at `https://services.gradle.org/distributions/gradle-8.13-bin.zip.sha256`; it is a constant of the 8.13 pin, so re-derive it from that endpoint whenever the Gradle version in [`shared-instructions.md §0`](../../shared/shared-instructions.md) moves, and never hand-edit it to make a failing build pass.

   **Verify the wrapper JAR before the first `./gradlew`.** `gradle-wrapper.jar` is executed by `gradlew`, so it needs the same treatment as the distribution: copy it only from a trusted source — the control's own committed `android/gradle/wrapper/` or a verified Gradle install — and verify it against the **official Gradle 8.13 wrapper JAR SHA-256** published at `https://downloads.gradle.org/distributions/gradle-8.13-wrapper.jar.sha256`.

   Official checksum (8.13):

   ```text
   81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f
   ```

   Fail closed:

   ```bash
   cd ppmplugin/staging/android-build
    EXPECTED_WRAPPER_SHA256=81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f
    ACTUAL=$(shasum -a 256 gradle/wrapper/gradle-wrapper.jar | cut -d' ' -f1)
    [ "$ACTUAL" = "$EXPECTED_WRAPPER_SHA256" ] || {
       echo "BLOCKED: gradle-wrapper.jar SHA-256 mismatch — expected $EXPECTED_WRAPPER_SHA256, got $ACTUAL"; exit 1; }
   ```

   Never fetch either artifact from an unpinned third-party mirror, and never skip the check because the build is "just a throwaway staging copy" — the staging copy runs on the same machine with the same privileges.

   **Fallback — if you must run `gradle wrapper`** and the system Gradle is too old for AGP 8.8.2: temporarily move `build.gradle` aside so the wrapper task has nothing to evaluate, generate the wrapper, then restore:
   ```bash
   cd ppmplugin/staging/android-build
   mv build.gradle build.gradle.tmp
   gradle wrapper --gradle-version 8.13 --distribution-type bin \
     --gradle-distribution-sha256-sum 20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78
   mv build.gradle.tmp build.gradle
   ```
   Either way, verify `gradle/wrapper/gradle-wrapper.properties` ends with `gradle-8.13-bin.zip` **and** carries the `distributionSha256Sum` line. Builds in Step 5 always invoke `./gradlew` (the pinned wrapper), never the system `gradle`.

4. **Generate `gradle.properties`** in the staging copy (the managed host build supplies these ambiently; standalone has none). **Without `android.useAndroidX=true` the androidx deps (appcompat, core-ktx) fail resource linking** — this is the single thing that turns the Android build from flaky to one-shot:
   ```properties
   android.useAndroidX=true
   android.enableJetifier=false
   org.gradle.jvmargs=-Xmx2048m
   ```

No confirmation gate is needed for edits to the throwaway copy (the canonical source is untouched). Just **report the standalone adjustments applied** (the React coordinate swap + compileSdk 35 + generated `gradle.properties`) so the user knows how the build env differs from the managed host build's.

---

## Step 3 — Assert DexClassLoader constraints

If the expected Android module / `ReactPackage` `.kt` files don't exist where `manifest.entrypoints.android.packageClass` implies, STOP with `NEEDS_CONTEXT: Android module structure missing — see shared/repo-layout.md` rather than letting Gradle fail cryptically (the manifest skill's structure preflight normally catches this first; this is the backstop if it was skipped).

Before building, verify the source satisfies the runtime-load constraints (ppmplugin-format §5). Read the Kotlin files and check:

- **No `@ReactModule` annotation** anywhere in the module — it needs static symbols `DexClassLoader` can't see. If present, STOP with `BLOCKED: remove @ReactModule annotation (incompatible with DexClassLoader)`.
- **`getName()`** return value equals `manifest.json` `receivers[].nativeModule`.
- **ReactPackage FQN** equals `manifest.json` `entrypoints.android.packageClass`.
- **The `ReactPackage` (packageClass) has a public no-arg constructor.** The wrap runtime instantiates it via `getDeclaredConstructor().newInstance()` — if the class declares only an arg-ed constructor, the plugin silently fails to load at runtime (`Loaded 0 plugin package(s)`), which no build error catches. Read the `<Pascal>Package.kt`: a bare `class <Pascal>Package : ReactPackage` is fine (implicit no-arg ctor); a `class <Pascal>Package(...)` with a primary-constructor parameter list is NOT. If it has parameters, STOP with `BLOCKED: ReactPackage <Pascal>Package must have a public no-arg constructor`.
- **Each `@ReactMethod` takes exactly one `ReadableMap` request param** (then `Promise`) — the wrap proxy spreads the PCF's `args: [request]` positionally, so a method that expands the request into multiple positional params won't receive its data. If a `@ReactMethod`'s signature isn't `(request: ReadableMap, promise: Promise)`-shaped, surface a WARNING (it may be intentional for a no-arg op like `getStatus()` → `(promise: Promise)`, but a multi-positional-param method is almost always a dispatch-contract mistake — [ppmplugin-format §2](../../shared/ppmplugin-format.md)).
- **No SDK-era imports** — the module source carries none of `INativeExtension`, `INativeOperation`, `INativeExtensionContext`, `sendAsync`, `handleMessageAsync`, `HermesBytecodeLoader`, or a `powerapps-native-extension` import. The bundle is native-only; the wrap host dispatches straight to `NativeModules.<nativeModule>.<method>` ([ppmplugin-format §2](../../shared/ppmplugin-format.md) — *Runtime dispatch contract*), so an SDK symbol here is leakage that `/audit-ppmplugin`'s DEX scan will reject downstream. Catch it at the source: if present, STOP with `BLOCKED: SDK-era symbol '<sym>' in module source — the .ppmplugin is native-only (no INativeExtension/sendAsync layer)`.

A mismatch here means the manifest and the binary disagree — the call won't reach the module on device. STOP with the specific mismatch rather than building a broken pair.

---

## Step 4 — Pre-flight cleanup

Stale outputs cause confusing collisions. Before building:
- Remove any prior `ppmplugin/staging/android/<Pascal>Plugin.dex`.
- The staging copy `ppmplugin/staging/android-build/` was recopied fresh in Step 2, so any `build/` inside it is gone. The canonical `android/build/` (from prior host builds) is irrelevant now — we never build there.

---

## Step 5 — Build AAR → DEX

Run the build for real and surface output location, not the streaming log (shared-instructions §9):

1. **Assemble the release AAR** from the staging copy — OS-aware wrapper invocation per shared-instructions §5:
   ```bash
   cd ppmplugin/staging/android-build && ./gradlew :assembleRelease       # macOS / Linux
   ```
   ```powershell
   cd ppmplugin\staging\android-build; .\gradlew.bat :assembleRelease     # Windows
   ```
   Output: `ppmplugin/staging/android-build/build/outputs/aar/<module>-release.aar`. On failure, print the failing task + the most relevant Gradle error line and STOP with `BLOCKED: gradle assembleRelease failed — <line>` (per the dogfooding lesson: surface the real error, don't swallow it). Common standalone failures and their fixes are pinned in [`ppmplugin-format.md §5`](../../shared/ppmplugin-format.md) (compileSdk too low → missing platform 35; React unresolved → wrong coordinate). Also recognize `Cannot add extension with name 'kotlin'` → the copy's Kotlin-plugin application conflicts with its AGP (AGP 9.x bundles Kotlin; manual `kotlin-android` then collides). Rare here since we pin AGP 8.8.2 (which *needs* explicit `kotlin-android`) and build from the control's own gradle — but if it surfaces, align the copy's Kotlin-plugin application with AGP 8.8.2.

2. **Extract `classes.jar` and compile to DEX** — OS-aware per shared-instructions §5 (`d8` on macOS/Linux, `d8.bat` on Windows; the Windows SDK `build-tools/<ver>/` folder must be on PATH):

   macOS / Linux (bash):
   Invoke `d8` by the **absolute path `$D8` resolved in Step 1** (it is usually not on PATH) — do not assume a bare `d8` works.

   ```bash
   mkdir -p ppmplugin/staging/android
   work=$(mktemp -d)
   cp ppmplugin/staging/android-build/build/outputs/aar/<module>-release.aar "$work/"
   ( cd "$work" && jar xf <module>-release.aar classes.jar && "$D8" --min-api 24 --output . classes.jar )
   cp "$work/classes.dex" ppmplugin/staging/android/<Pascal>Plugin.dex
   ```

   Windows (PowerShell): `$D8` is the resolved `…\build-tools\35.0.0\d8.bat`.
   ```powershell
   New-Item -ItemType Directory -Force ppmplugin\staging\android | Out-Null
   $work = New-Item -ItemType Directory -Force (Join-Path $env:TEMP "ppm-dex")
   Copy-Item ppmplugin\staging\android-build\build\outputs\aar\<module>-release.aar $work
   Push-Location $work
   jar xf <module>-release.aar classes.jar
   & $D8 --min-api 24 --output . classes.jar
   Pop-Location
   Copy-Item (Join-Path $work classes.dex) ppmplugin\staging\android\<Pascal>Plugin.dex
   ```

   `d8` warnings of the form `Type com.facebook.react.* was not found` are **expected and benign** (RN is `compileOnly`) — say so explicitly so the user doesn't read them as errors. Any *error* (non-warning) from `d8` → STOP with the line.

3. Verify `ppmplugin/staging/android/<Pascal>Plugin.dex` exists and is non-empty.

4. **Optional — native `.so` libraries.** If the module has JNI dependencies, the release AAR carries them under `jni/<abi>/*.so`. Extract those into `ppmplugin/staging/android/lib/<abi>/*.so` (`<abi>` ∈ `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`) so `/assemble-ppmplugin` zips them under `android/lib/` — the wrap injector copies each ABI dir into the APK's `lib/<abi>/` ([`ppmplugin-format §5`](../../shared/ppmplugin-format.md)). Check with `jar tf <module>-release.aar | grep '^jni/'`; if there are none (the common case — a pure-Kotlin control), skip this step.

---

## Step 6 — Report + next step

Update the `## ppmplugin (third-party controls)` block in `.extension-state.md`: `Android DEX: built <ISO timestamp> (<dex name>)`. Print a fenced summary with the DEX path and size, then offer next steps via `AskUserQuestion` (shared-instructions §9.1):

- **Run /assemble-ppmplugin** (recommended next — zip the manifest + DEX into the `.ppmplugin`)
- **Re-run /generate-ppmplugin-manifest** (if the method list or names changed)
- **Stay — I'll inspect the DEX first**

**When the user picks a `Run /…` option, immediately invoke that skill via the `Skill` tool in the same turn** (sub-skill invocation, shared-instructions §8 + §9.1 "Execute, don't describe"). Do NOT print a "run it when ready" instruction and stop. Only "Stay" ends the run.

Return `DONE` with the DEX path, or `DONE_WITH_CONCERNS` if the `@ReactMethod` count diverged from the documented operations (Step 1 of the manifest skill flags this).
