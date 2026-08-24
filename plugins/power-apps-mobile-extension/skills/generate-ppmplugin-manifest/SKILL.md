---
name: generate-ppmplugin-manifest
description: "Validate, reconcile to the chosen target(s), and stage the `manifest.json` for a `.ppmplugin` bundle. In the normal flow the committed `./manifest.json` already exists (authored by /generate-native-extension), so this stage reads it, runs the plugin's upload-compatibility checks locally as a pre-flight gate (name regex, canonical prefix, known incompatible names, method and identifier shapes), reconciles `entrypoints` down to the platform(s) you ship, and writes the gitignored staged copy `ppmplugin/staging/manifest.json` that /assemble-ppmplugin zips. If no committed manifest exists (a hand-authored module) it falls back to deriving every field from the class name and Android module source, writing both the committed file and the staged copy. No toolchain — pure read, validate, write. Target-aware. Run after the native module exists, before the build skills."
---

# /generate-ppmplugin-manifest

Stages the `manifest.json` that goes inside a `.ppmplugin` bundle — the small descriptor the wrap runtime and upload service read to identify the plugin and route calls into it. In the normal flow the **committed `./manifest.json` already exists** (authored by [`/generate-native-extension`](../generate-native-extension/SKILL.md) next to the code it describes); this stage's job is to **validate it, reconcile its `entrypoints` to the shipped target(s), and write the staged build copy** `ppmplugin/staging/manifest.json`. It is the "get the strings right" gate: it runs instantly, needs no build tools, and catches common upload failures before any Android build. If the repo has no `./manifest.json` (a hand-authored native module that skipped the scaffold), this stage **authors it from source** as a fallback — see Step 2.

Read [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md) — it is the source of truth for the schema, the derivation table, and the validation rules this skill enforces.

**Two manifests, one contract.** `./manifest.json` (repo root, **committed**) is the source-of-truth contract — it declares *every platform the module supports*. `ppmplugin/staging/manifest.json` (gitignored) is the **build copy** this stage produces — same contract, but `entrypoints` trimmed to the platform(s) actually being shipped. The build/assemble skills only ever read the staged copy; the committed root file is what the PCF and humans read.

## What this skill does NOT do
- Does not compile anything — no Gradle, no DEX. That's [`/build-android-binary`](../build-android-binary/SKILL.md).
- Does not zip the bundle — that's [`/assemble-ppmplugin`](../assemble-ppmplugin/SKILL.md).
- Does not verify a declared platform's binary actually exists — it stages the *intended* `entrypoints`; [`/assemble-ppmplugin`](../assemble-ppmplugin/SKILL.md) reconciles them against the binaries actually staged and gates on any mismatch.
- Does not rewrite the committed `./manifest.json` on the normal path — it reads it. It only *writes* `./manifest.json` in the fallback case (no committed manifest existed). It never touches `src/`, `ios/`, `android/`, PRD, or `package.json` beyond reading them.

---

## Step 1 — Read shared docs + prereq block

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md), [`shared/naming-conventions.md`](../../shared/naming-conventions.md), and [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md).
2. This skill does no installs / auth / network. Print the zero-prereq block (per shared-instructions §9.2):

```
Prereq check — /generate-ppmplugin-manifest: skipped (skill does no installs / auth / network — failures surface at validation).
```

3. Confirm the working directory is a third-party-control repo: a `package.json` (the **dev-only, private, plain `<kebab>-control`** name — NOT a published `@powerapps/extension-*` scope; this track ships a binary, not an npm package — see [`repo-layout.md`](../../shared/repo-layout.md)) **and** an `android/` and/or `ios/` native module exist. If not, STOP with `NEEDS_CONTEXT: not a third-party-control repo (no package.json / native module)`.
4. Read `.extension-state.md` — if it carries a `## ppmplugin (third-party controls)` block, note the last **target** choice and last manifest write (the re-run mode below uses them).

---

## Step 1.5 — Locate the source manifest (which mode are we in?)

This stage has two modes, decided by whether the committed `./manifest.json` exists:

- **Validate-and-stage mode (the normal flow).** `./manifest.json` exists at the repo root (authored by `/generate-native-extension`). This is the source of truth — **do not re-author it**. Read it, validate it (Step 3), reconcile its `entrypoints` to the chosen target (Step 2 → *Target* only), and write the staged copy (Step 4). Step 2's field-derivation is **skipped** — the contract is already authored; you're verifying and staging it, not regenerating it. (Optionally re-derive `methods` from the Android module source and, if they've drifted from `./manifest.json` — e.g. a `@ReactMethod` was added by hand after scaffold — surface the diff and offer to update the committed file; never silently rewrite it.)

- **Author-from-source mode (fallback).** No `./manifest.json` exists — a hand-authored native module that skipped the scaffold. Derive every field mechanically from source (Step 2 in full), then write **both** the committed `./manifest.json` and the staged copy (Step 4).

**Re-run within a build session.** If the *staged* copy `ppmplugin/staging/manifest.json` already exists from a prior run, don't blindly overwrite — diff the target/entrypoints against the committed source and ask via `AskUserQuestion`: **Update** (re-stage from the current `./manifest.json` + target) / **Keep as-is** (report and stop). Default the target to the prior choice in `.extension-state.md`; don't re-ask an answered question.

---

## Step 2 — Determine target(s); derive fields only in author-from-source mode

The structure preflight + target selection below run in **both** modes (you always need to know which platforms are viable and which to ship). The **field-derivation** sub-section (items 1–6 + the compute block) runs **only in author-from-source mode** (Step 1.5) — in the normal validate-and-stage mode the fields already live in `./manifest.json`; read them from there and skip derivation, keeping only the *target* choice.

**First, run a structure preflight.** The ppmplugin path expects the canonical PAM-extension layout — the shape `/generate-native-extension` produces (see [`shared/repo-layout.md`](../../shared/repo-layout.md)). A hand-rolled, foreign, or drifted repo may be missing pieces; flag exactly *what*, here and now, rather than failing later with a cryptic Gradle/Xcode error or a silently-wrong manifest. Print a visible ✓/✗ block:

- **Common:** `package.json` (dev-only `<kebab>-control` name — there is **no** `@powerapps/extension-*` scope and **no** `src/` TS layer in this track); class name resolvable from the **native module** (`android/.../<Pascal>Module.kt` / `ios/RCT<Pascal>Module.m`), `./manifest.json`, or `.extension-state.md`.
- **Android** (if `android/` present): `android/build.gradle`; a Kotlin module class extending `ReactContextBaseJavaModule` with an `override fun getName()`; a `ReactPackage` class; ≥1 `@ReactMethod`.
- **iOS** (if `ios/` present): `ios/RCT<Pascal>Module.h` declaring `<RCTBridgeModule>`; `.m` with `+ (NSString *)moduleName` (**NOT** `RCT_EXPORT_MODULE`) and ≥1 `RCT_EXPORT_METHOD`.

A platform whose structure is **incomplete is not a valid target** — exclude it and say which element is missing. If neither platform is structurally complete, STOP with `NEEDS_CONTEXT: repo doesn't match the expected PAM-extension layout — missing <list>` pointing at `shared/repo-layout.md`. (Working on a staged copy protects the *source*; it does NOT make a missing module appear — that's what this preflight is for.)

**Then determine which platform(s) this bundle targets** (only from the structurally-complete ones) — it controls which `entrypoints` get declared:
- Confirm via `AskUserQuestion`: **Android-only** / **iOS-only** / **Both** — offer only the targets that passed the preflight. Default to what's present, or — on a re-run in **Update** mode — to the prior target recorded in `.extension-state.md`.
- Note availability: `/build-android-binary` is stable; `/build-ios-binary` is **v0** (Mac-only; **known limitation:** its React-Core weak-link config still needs validation against a live PAM/wrap shell). If the user targets iOS/Both, the manifest declares `entrypoints.ios`; `/assemble-ppmplugin` will still gate if the iOS binary isn't staged at packaging time.

**Then derive fields from the actual files, not from assumptions** *(author-from-source mode only — in validate-and-stage mode skip to Step 3 with the fields read from `./manifest.json`)*:

1. **Class name** `<Pascal>` — from the **native module** (the Android `<Pascal>Module.kt` filename / its `getName()` = `"<Pascal>Module"`, or the iOS `RCT<Pascal>Module`), or the `.extension-state.md` Identity block. There is **no** `src/<Pascal>Extension.ts` in this track. This is the basis for `name`, `nativeModule`, `receivers[].name`.
2. **`version`** — `package.json` `version`.
3. **`nativeModule`** — read the Android module's `override fun getName(): String = "<X>"`. Use `<X>` verbatim.
4. **`packageClass`** — read the `ReactPackage` `.kt` file: combine its `package <...>` line with the class name → FQN (e.g. `com.powerapps.peninput.PenInputPackage`).
5. **`methods`** — scan the Android module (via the Read/Grep tools, not a shell-specific command — this skill is OS-neutral) for `@ReactMethod` and collect each annotated function name. Cross-check the count against the operations in `ARCHITECTURE.md §3` / `PRD §4`; if a documented operation has no matching `@ReactMethod`, surface it as a warning (the manifest reflects what the binary actually exposes, but the mismatch usually means an operation wasn't wired).

6. **iOS entrypoint fields** *(only when targeting iOS / Both)* — read `ios/RCT<Pascal>Module.h` for the class name (`@interface RCT<Pascal>Module : NSObject <RCTBridgeModule>`) → that is `entrypoints.ios.moduleClass`. Read `ios/RCT<Pascal>Module.m` for `+ (NSString *)moduleName { return @"<X>"; }` and **assert `<X>` equals the `nativeModule` from step 3** — it's the same bridge symbol on both platforms; a mismatch means the iOS and Android modules disagree. (The `.m` must **not** use `RCT_EXPORT_MODULE` — that macro's `+load` registration is invisible to the framework's `dlopen` flat namespace, so the module never loads on device.)

Then compute, per [`ppmplugin-format.md §3`](../../shared/ppmplugin-format.md):

- `name = kebab(className)` — **from the class name, not the capability/repo name.** If `kebab(className)` differs from the repo's capability kebab (e.g. repo `powerapps-pdf-control` but class `PdfViewer` → `name: pdf-viewer`), print a one-line note so the user knows the `.ppmplugin` filename won't match the repo name. This is required for the canonical-prefix rule to pass.
- **`receivers[].name` — take it from the PCF if one exists, do NOT blindly default.** If a sibling PCF is present (`pcf/<…>/index.ts`), grep it for the dispatch key — `COMPOSITE_KEY = "<name>/<receiver>"` (or the `ReceiverKey` it binds) — and use **that** `<receiver>` value, because the PCF already dispatches to it; a manifest that registers a different receiver name will fail on first dispatch (real bug: PCF dispatched to `Snapshot` while the manifest defaulted to `DeviceInfoExtension`). Only if no PCF exists, fall back to `<Pascal>Extension`. **Either way, surface the chosen value as a confirmation point:** *"PCF dispatches to `<name>/<receiver>`; the manifest will register receiver `<receiver>` — confirm?"* (Audit re-checks this — see `/audit-ppmplugin` `pcf-composite-key-matches-receiver`.)

> **`receivers[]` IS the runtime dispatch contract** ([ppmplugin-format §2](../../shared/ppmplugin-format.md) — *Runtime dispatch contract*). The wrap host routes a call by the composite key `<name>/<receivers[].name>` to `NativeModules.<nativeModule>.<method>` — there is no TS `handleMessageAsync` / `sendAsync` layer in a native-only bundle. So `nativeModule` must equal the module's `getName()`, and every entry in `methods` must be a real `@ReactMethod` / `RCT_EXPORT_METHOD` name (the host calls it directly; an absent method = `method '<m>' not found` on device). Derive `methods` from the module source, never guess.
- **`entrypoints` — declare ONLY the chosen target(s):**
  - Android / Both → `entrypoints.android = { dex: "<Pascal>Plugin.dex", packageClass: "<FQN from step 4>" }`
  - iOS / Both → `entrypoints.ios = { framework: "<Pascal>Plugin", moduleClass: "RCT<Pascal>Module" }`

---

## Step 3 — Validate locally (pre-flight gate)

Run **every** rule from [`ppmplugin-format.md §4`](../../shared/ppmplugin-format.md) against the derived manifest. For each, pass or fail with the exact rule:

- `name` matches `^[a-z0-9][a-z0-9-]{0,63}$`
- each `nativeModule` starts with the **canonical prefix** of `name` — computed precisely as *split `name` on `-`/`_`, PascalCase each segment, join* (ppmplugin-format §3), Ordinal/case-sensitive. (Note the `helloworld` → `Helloworld` subtlety; `kebab(className)` must hyphenate at camelCase boundaries so the round-trip holds.)
- no `nativeModule` starts with a reserved prefix (case-insensitive list in §4)
- **no `nativeModule` is a known incompatible exact name** — block (Ordinal, case-sensitive) if it matches the locally checked subset in [§4](../../shared/ppmplugin-format.md) (`DeviceInfo`, `AuthenticationHelper`, `NetworkClient`, `DataverseOfflineProvider`, `IntuneMAM`). The subset is **non-exhaustive**: passing it locally does not guarantee the upload service will accept the name. Rename the module's `getName()` (and iOS `+moduleName`) to a non-reserved form — add a `Module` suffix (`DeviceInfo` → `DeviceInfoModule`) or a vendor prefix (`ContosoDeviceInfo`) — and re-derive `nativeModule` to match.
- **`nativeModule` looks like a generic platform noun → WARNING.** If `nativeModule` matches `^(Device|Network|File|Audio|Camera|Sensor|Location|Storage|Notification|Bluetooth|Wifi|Media|Photo|Contact|Calendar|Battery)`, warn that generic single-noun names are both upload-conflict-prone and collision-prone (`NativeModules` is a shared namespace across every plugin the wrap host loads). Recommend a `Module` suffix or vendor prefix. Surface it; let the user proceed if deliberate.
- `methods` non-empty; ≤32; each matches `^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$`
- each `receivers[].name` matches the same JS-identifier regex
- **no SDK-era / JS-layer fields** — the manifest carries none of `entrypoints.js`, `entrypoints.ts`, `extension.js`, `extension.hbc`, `extensionClassName`, `jsLayer` (the bundle is native-only; these are leakage the wrap runtime no longer reads — §4). Since this skill authors the manifest it won't emit them, but the re-run mode reads an existing manifest, so assert it.

Print the result as a visible block:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 manifest.json validation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🟢 ✓ name 'pen-input' — valid kebab identifier
 🟢 ✓ nativeModule 'PenInputModule' starts with canonical prefix 'PenInput'
 🟢 ✓ nativeModule 'PenInputModule' — no reserved prefix
 🟢 ✓ nativeModule 'PenInputModule' — not a known reserved name
 🟢 ✓ methods ['capturePenInput'] — non-empty, valid identifiers
 🟢 ✓ receiver name 'PenInputExtension' — valid identifier
 🟢 ✓ no SDK-era / JS-layer fields (native-only manifest)
 🟢 7 checks passed, 0 failed.
 ⓘ Known incompatible-name subset checked locally; the upload service may apply additional checks.
```

If any check **fails**, STOP with `BLOCKED: manifest validation — <rule>` and the concrete fix (e.g. "rename the Kotlin module's `getName()` so it starts with `PenInput`"). Do NOT write an invalid manifest.

---

## Step 4 — Confirmation gate + write

Show the manifest (the validated source + the target-reconciled `entrypoints`) and wait for confirmation (shared-instructions §7.1). On approval:

1. Ensure `ppmplugin/` is in `.gitignore` (append the line if absent). Do **not** add `manifest.json` (the committed root file stays tracked).
2. **Write the staged build copy** `ppmplugin/staging/manifest.json` — the contract with `entrypoints` trimmed to the chosen target(s). This is what `/assemble-ppmplugin` zips.
3. **Author-from-source mode only:** also write the committed `./manifest.json` at the repo root (the full contract, all viable platforms) — this is the source of truth the scaffold would normally have produced. In validate-and-stage mode, leave `./manifest.json` untouched (it's already the source) unless the user accepted a drift-update offer in Step 1.5.
4. Update the `## ppmplugin (third-party controls)` block in `.extension-state.md` (create it if absent — schema in [`repo-layout.md`](../../shared/repo-layout.md)): set `Target`, `Manifest: staged <ISO timestamp>`. This is what the re-run mode (Step 1.5) and the build/assemble skills read for state.

Return `DONE` with the manifest path. Then surface next steps via `AskUserQuestion` (shared-instructions §9.1), **offering the build skill(s) for the chosen target(s)**:

- **Run /build-android-binary** — if target is Android or Both (compile the Kotlin module → DEX)
- **Run /build-ios-binary** — if target is iOS or Both (compile the Obj-C module → framework; Mac-only)
- **Run /assemble-ppmplugin** — only if the binary/binaries already exist
- **Stay — I'll review the manifest first**

(For a Both target, list both build skills. Cap at 4 options per `AskUserQuestion`.)

**When the user picks a `Run /…` option, immediately invoke that skill via the `Skill` tool in the same turn** (sub-skill invocation, shared-instructions §8 + §9.1 "Execute, don't describe"). Do NOT print a "run it when ready" instruction and stop — selecting the option IS the request to run it. Only "Stay" ends the run.

---

## Worked example (pen-input)

```json
{
  "name": "pen-input",
  "version": "0.1.4",
  "abi": { "compatibleShells": ">=1.0.0", "builtAgainst": "1.0.0" },
  "entrypoints": {
    "android": { "dex": "PenInputPlugin.dex", "packageClass": "com.powerapps.peninput.PenInputPackage" }
  },
  "receivers": [
    { "name": "PenInputExtension", "nativeModule": "PenInputModule", "methods": ["capturePenInput"] }
  ]
}
```

(This example targets **Android-only**, so `entrypoints.ios` is omitted. For a **Both** target it would also carry `"ios": { "framework": "PenInputPlugin", "moduleClass": "RCTPenInputModule" }`. `name` = `pen-input` = kebab of class `PenInput`; `nativeModule` = `PenInputModule` (the `Module` suffix avoids reserved bare names) and starts with canonical prefix `PenInput` ✓; not a reserved prefix ✓.)
