---
name: add-barcode-scanner
description: Internal helper for an explicitly requested Microsoft native barcode or QR scanner using @microsoft/power-apps-native-barcode-scanner. Generic scanner requests keep the Expo camera flow.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - read first.

# Add Microsoft Barcode Scanner

Internal helper for `/add-native native-barcode-scanner`, `/add-native microsoft-barcode-scanner`, or `/add-native @microsoft/power-apps-native-barcode-scanner`.

Use only when the user explicitly requests the Microsoft control. Generic `barcode-scanner` / `qr-scanner`, embedded camera previews, and existing `BarcodeScannerView` screens remain on the camera helper. Do not replace that flow implicitly.

## 1. Verify app

```bash
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src
```

If this fails, stop and tell the user to initialize the app with `/create-mobile-app` first.

## 2. Ensure the app dependency

Read [Microsoft OOB controls](${PLUGIN_ROOT}/skills/add-native/references/oob-controls.md) for the allowed use case, package, and dependency spec. Run its dependency setup for `@microsoft/power-apps-native-barcode-scanner` only when the explicit request or approved plan selects this control. Add a missing package to runtime `dependencies` and update the lockfile with the listed spec. Reuse an existing compatible installation without upgrading it. Stop on dependency verification failure before generating imports.

## 3. Write or verify `src/native/nativeBarcodeScanner.ts`

Inspect the installed package's README and exported declarations before generating the wrapper. For the `1.1.4` API, use the named `BarcodeScannerNative.scan(request)` React Native API with `BarcodeScannerRequest`, `BarcodeScannerResponse`, `BarcodeOutput`, and `BarcodeScannerErrorCode` types. Do not use the default export, `NativeBarcodeScannerExtension`, HostingSDK, or PCF adapter.

Generate a typed app wrapper rather than importing the package from screens:

- Preserve an existing wrapper and patch only the required behavior.
- The API opens its own native scanner and returns a response; it is not a drop-in React component for the Expo `BarcodeScannerView`.
- Map `status: 'ok'` with nonempty `result.barcodes` to `{ ok: true, barcodes }`. Treat a missing or empty result as an explicit error, not successful scanning.
- Preserve typed error codes in `{ ok: false, reason }`. Treat `USER_CANCELLED` as a non-error cancellation. Handle `CAMERA_PERMISSION_DENIED`, `DEVICE_INCOMPATIBLE`, `UNSUPPORTED_PLATFORM`, `NATIVE_MODULE_MISSING`, `INVALID_INPUT`, and `INTERNAL_ERROR` explicitly. Unexpected thrown errors must become an error result with a useful message, never a silent success.
- Use request options from the installed types. Do not invent properties or assume every barcode format is equally supported on iOS and Android.
- Do not attach a telemetry callback or log decoded barcode values by default. Existing opt-in Application Insights rules still apply.

Describe button-triggered invocation for screen integration. Disable repeated launches while a scan is in flight, surface errors, and feed successful values into the approved lookup/save workflow. Scan-result-driven Dataverse writes still require a separate in-flight guard; do not auto-create records or apply business logic not in the plan.

## 4. Validate and report

Run `npx tsc --noEmit` and the changed-file gate. Fix app-owned wrapper errors before reporting completion; do not patch package source or edit `app.config.js`, platform projects, or permissions. npm installation does not add native code to a running player/rewrap binary. Preserve missing-module/unsupported handling and require a compatible player/runtime outside this workflow when native support is absent.

Report:

```text
Microsoft barcode scanner wrapper: src/native/nativeBarcodeScanner.ts
Package/version    : @microsoft/power-apps-native-barcode-scanner@<resolved version>
Dependency action  : <added / moved to runtime dependencies / already present>
Manifest/lockfile  : <changed files / unchanged>
Type-check         : <PASS / failure>
Native runtime     : <verified separately / not verified>
Native config      : unchanged
```

Record the control, saved spec, resolved version, and verification limits under `Controls` in `memory-bank.md`. Do not claim device scanning was tested unless it was.
