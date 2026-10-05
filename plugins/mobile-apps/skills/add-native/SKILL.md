---
name: add-native
description: Public entry point for native device capabilities and native controls — camera, image picker, barcode/QR scanner, document picker, file picker, secure storage, file system, sharing, haptic feedback, PDF generation/viewing, pen/signature capture, background GPS/geolocation tracking, or supported local file workflows — in a Power Apps mobile app. Also owns routing to internal camera/PDF/pen/geolocation implementation helpers and the guidance boundary between native wrappers and Dataverse File/Image host controls.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

# Add Native Capability

Generate a typed wrapper under `src/native/` for a native capability in the app's
[verified release context](../../shared/references/mobile-release-lifecycle.md).
Screens import the wrapper instead of touching native packages directly.
Read [native controls](references/native-controls.md) for conditional aggregate
adoption, legacy imports, permission boundaries, and location ownership.

## Hard rules — do NOT cross these lines

1. **Never run `npx expo install`, `npm install`, or `yarn add` for a native module.** Native support is fixed by the app-matched verified release and selected player/base, not the newest bundled template or the customer's manifest.
2. **Never edit `app.config.js`** — plugins, `ios.infoPlist`, `android.permissions`, or anything else. Native config belongs to the verified fixed-capability base; arbitrary additions cannot be honored at rewrap time.
3. **Never edit `package.json` `dependencies` for native modules.** Native means the package ships platform source/projects, a podspec, codegen, an Expo module/config plugin, or `react-native.config.js`; a package-name prefix alone is not proof. Pure-JavaScript dependencies are out of scope for `/add-native` and are installed from an approved `JavaScript Dependencies` plan by `/create-mobile-app` or `/edit-app`.
4. **If release resolution fails, or package/version/native inventory disagree — STOP before native mutation.** A dependency being present is necessary, not sufficient. Do not install the controls aggregate or newer leaf to repair an older binary.
5. **Keep inclusion, declarations, grants, and usage separate.** The base owns OS declarations. Dependency/config toggles do not remove unused default Android permissions; different declarations require another verified base. Optional permission wrapping is deferred.

## Routing — `/add-native` is the public entry point

Some capabilities have a dedicated implementation helper that does more than a plain wrapper (camera writes scanner/upload helpers; PDF report/viewer helpers enforce local-vs-HTTPS boundaries; pen has native-control-specific validation). Users should still call `/add-native <capability>` for native controls. When a dedicated implementation exists, **run it internally and do not ask the user to run that helper directly**.

**Lookup convention:** after normalizing the capability, first check the internal-helper map below. For `camera`, `image-picker`, `barcode-scanner`, and `qr-scanner`, read and execute `${PLUGIN_ROOT}/skills/add-native/add-camera/SKILL.md` inside this `/add-native` invocation. For `pdf-report`, read and execute `${PLUGIN_ROOT}/skills/add-native/add-pdf-report/SKILL.md`. For `pdf-viewer`, read and execute `${PLUGIN_ROOT}/skills/add-native/add-pdf-viewer/SKILL.md`. For `pen-input`, read and execute `${PLUGIN_ROOT}/skills/add-native/add-pen-input/SKILL.md`. For `geolocation`, read and execute `${PLUGIN_ROOT}/skills/add-native/add-geolocation/SKILL.md`. If no helper exists, fall through to this skill's inline wrapper flow.

Current dedicated implementations:

| Capability | Dedicated skill | Why dedicated |
|---|---|---|
| `camera`, `take-photo`, `photo`, `expo-camera`, `image-picker`, `gallery`, `expo-image-picker`, `barcode-scanner`, `qr-scanner`, `scanner` | [`add-camera`](add-camera/SKILL.md) internal helper | Owns photo capture, gallery image picking, and barcode/QR scanner controls backed by `expo-camera` / `expo-image-picker` |
| `pdf-report`, `pdf-export`, `generate-pdf`, `print-report`, `evidence-packet` | [`add-pdf-report`](add-pdf-report/SKILL.md) internal helper | Generates app-owned local PDFs with `expo-print` and shares them only when `expo-sharing` is present |
| `pdf-viewer`, `native-pdf-viewer`, `pdf-control`, `open-pdf`, `@microsoft/power-apps-native-pdf-viewer` | [`add-pdf-viewer`](add-pdf-viewer/SKILL.md) internal helper | Enforces `https://` / `file://` viewer inputs and native viewer result handling |
| `pen-input`, `signature`, `ink`, `draw`, `@microsoft/power-apps-native-pen-input` | [`add-pen-input`](add-pen-input/SKILL.md) internal helper | Captures PNG data URI and documents Dataverse Image/File persistence |
| `location`, `geolocation`, `location-tracking`, `background-location`, `gps-tracking`, `geo-tracking`, `@microsoft/power-apps-native-bglocation` | [`add-geolocation`](add-geolocation/SKILL.md) internal helper | Separate one-shot coordinate reads from continuous tracking and durable Dataverse sync |

For every other capability listed below, this skill writes the wrapper directly.

## Native capability gate

For an explicitly approved local diagnostic, append `--diagnostic-artifacts
"<manifest.json>"` to the resolver and changed-file validator below, and carry
that selection into every internal helper. Follow the lifecycle reference:
online-only Android test inventory only, iOS untested, no deployment. Do not
install a missing control or infer support from a source profile.

Before adding any native control or wrapper, run:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"
```

Use its sanitized tuple as the shared resolved context for helpers/planners/builders.
Unknown/missing records block native mutations; the initially empty policy is
intentional, not permission to assume a release. Classify the intent, resolve
the exact package and version from this app's inventory, confirm it is not
runtime-banned, and verify input/output/storage constraints. The newest bundled
template is never a runtime allowlist. Every “present” requirement below means
present in both this release context and the installed app, with compatible
native support; manifest presence alone cannot pass the gate.

For controls, select aggregate subpaths or legacy leaves using the
[version-conditional import contract](references/native-controls.md).
`enableNativeControls` is permitted only on a verified supporting host release;
published host 0.4.0 lacks it. No root barrel or barcode subpath is available.

| User intent | Add/use | Required package or control | Do not use / fallback |
|---|---|---|---|
| Form field bound to a Dataverse File column | Host `<FilePicker>` in screen JSX | `@microsoft/power-apps-native-host` host control | Do not generate document-picker/file-system/sharing wrappers for this field |
| Form field bound to a Dataverse Image column | Host `<ImagePicker>` in screen JSX | `@microsoft/power-apps-native-host` host control | Do not use camera/image-picker wrappers for normal form-bound image fields |
| Dedicated photo/gallery/scanner workflow | `/add-native camera`, `image-picker`, or `barcode-scanner` | `expo-camera` and/or `expo-image-picker` present | If packages are absent, stop with missing-package guidance |
| Pick/import/upload a user-selected PDF/document | `/add-native document-picker`, or host `<FilePicker>` for Dataverse File fields | `expo-document-picker` present, or host File control | Do not treat this as `pdf-report` or native PDF viewer |
| Generate/export/print an app-owned report PDF | `/add-native pdf-report` | `expo-print` present | If `expo-print` is absent, do not add PDF report capability |
| Share a generated local PDF | `pdfReport.ts` share helper | `expo-sharing` present | If `expo-sharing` is absent, do not render sharing UI |
| Open/preview an HTTPS or local file PDF | `/add-native pdf-viewer` | Resolved controls `/pdf` or matching legacy PDF leaf with file URI support (0.2.9+) | Do not pass `content://`, `blob:`, or `http://` URIs to the viewer |
| Capture signature, ink, drawing, or sign-off | `/add-native pen-input` | Resolved controls `/pen` or matching legacy pen leaf | If persisted, plan Dataverse Image/File/child Evidence target first |
| One-shot foreground coordinate | `/add-native location` | Resolved controls `/geolocation` or matching background-location leaf; `expo-location` only if independently verified | No `app_id`, data source, target table, or `startTracking` for `BgLocationClient.getCurrentLocation()` |
| Continuous/background GPS tracking with durable Dataverse upload | `/add-native geolocation` | Resolved controls `/geolocation` or matching legacy background-location leaf | Do not use a one-shot read for tracking; background-location 0.2.3 tracking uses background permissions even with `trackInBackground: false` |
| Tactile feedback for presses, selections, and operation results | `/add-native haptics` | `expo-haptics` present | Use the typed wrapper and pair every haptic with visible UI feedback |
| Store generated PDF/signature artifact | Generated Dataverse services after parent row exists | File/Image column or child Evidence/Attachment table exists | Never put File bytes in create/update JSON |
| Native capability not listed in this table | Resolve from the app-matched native inventory, then add an inline wrapper only when installed and not runtime-banned | Exact relevant package/version in the verified release | If no relevant package exists, or the package is runtime-banned, add a transparency note and stop |

Handle multi-part requests row-by-row. Example: "capture signature and attach signed report PDF" requires `pen-input`, `pdf-report`, Dataverse artifact storage, and possibly `sharing`; do not add only the native capability while leaving storage or screen states undefined. The map is not closed: for new shipped packages, resolve by capability semantics, use the directly matching package when safe, and ask once only if multiple installed packages plausibly match.

## File/Image Picker Ownership

This skill owns native file capability mechanics. Screen builders own only the final JSX placement.

There are two different cases:

| Case | Correct implementation | Owner |
|---|---|---|
| Dataverse `File` column | Use `<FilePicker>` from `@microsoft/power-apps-native-host` | screen-builder JSX rule, documented here |
| Dataverse `Image` column | Use `<ImagePicker>` from `@microsoft/power-apps-native-host` | screen-builder JSX rule, documented here |
| Local device document/file workflow not bound to a Dataverse column | Generate/use `src/native/documentPicker.ts`, `src/native/fileSystem.ts`, and/or `src/native/sharing.ts` wrappers | `/add-native` |
| App-generated PDF report workflow | `/add-native` routes internally to `add-pdf-report`; uses `expo-print` and optionally `expo-sharing` only if present | `/add-native` |
| Camera capture, gallery image selection, barcode scanner, or QR scanner workflow | `/add-native` routes internally to `add-camera` | `/add-native` |

**Dataverse File/Image columns use host controls, not raw Expo modules and not app-specific native wrappers.** When a form field binds to a Dataverse **File** column (`FileAttributeMetadata`), render `<FilePicker>` from `@microsoft/power-apps-native-host`. When it binds to a Dataverse **Image** column (`ImageAttributeMetadata`), render `<ImagePicker>` from `@microsoft/power-apps-native-host`. These controls read accent, surface, and text colors from `PowerAppsProvider` / `ThemeProvider` and produce Dataverse-compatible payloads.

```tsx
import { FilePicker, ImagePicker } from '@microsoft/power-apps-native-host';
import type { PickedFileInfo, PickedImageInfo } from '@microsoft/power-apps-native-host';

// Image column — seed preview from Dataverse bytes/base64 and capture upload-ready payload.
<ImagePicker
  label="Site Photo"
  initialBase64={imageBase64}
  onImageChange={(image: PickedImageInfo | null) => { /* store image for upload */ }}
/>

// File column — edit-only pick/replace.
<FilePicker
  label="Specification Sheet"
  fileName={record.cr123_specsheet_name}
  onChange={(file: PickedFileInfo) => { /* store file for save */ }}
/>

// File column — view + replace.
<FilePicker
  label="Specification Sheet"
  fileName={record.cr123_specsheet_name}
  onDownload={() => Cr123_inspectionService.downloadFile(id, 'cr123_specsheet')}
  onChange={(file: PickedFileInfo) => { /* store file for save */ }}
/>
```

Save/read pattern for host picker-bound Dataverse columns:

```ts
// FILE/IMAGE columns: do not include picker bytes in the PATCH body.
// Save normal fields first, then upload through generated service helpers.
await Cr123_inspectionService.update(id, { cr123_name: name.trim() });
await Cr123_inspectionService.upload(id, 'cr123_specsheet', file.file, file.name);
await Cr123_inspectionService.upload(id, 'cr123_sitephoto', image.file, image.name);

// Download helpers are used for read/view scenarios.
const fileBytes = await Cr123_inspectionService.downloadFile(id, 'cr123_specsheet');
const imageBytes = await Cr123_inspectionService.downloadImage(id, 'cr123_sitephoto');
```

Use host `ImagePicker` / `FilePicker` with generated `upload(...)` for persistence and `downloadFile(...)` / `downloadImage(...)` for read/view. Do not use `Service.update(...{ <imageColumn>: base64 })` for picker-driven image/file persistence.

Do not use raw `expo-document-picker`, `expo-image-picker`, `expo-file-system`, or `expo-sharing` to build custom UI for Dataverse File/Image columns. Host `FilePicker` and `ImagePicker` already handle permissions, reading, sharing/download affordances, and Dataverse-compatible payload shape.

Use `/add-native` wrappers only when the workflow is not a Dataverse File/Image column, for example importing a local PDF for offline parsing, exporting a generated report, saving a local draft packet, or opening a share sheet for an app-generated summary.

## Supported capabilities

Apply the Native capability gate above. This is a capability map, not release
evidence. Legacy leaf names below are aliases only; use aggregate subpaths when
the resolved release includes controls, and keep a leaf import only when that
release includes the matching leaf. Read installed public docs/types first.

| Capability | Module | Wrapper to generate | Notes |
|---|---|---|---|
| `camera`, `take-photo`, `photo`, `expo-camera` | `expo-camera` | `src/native/camera.ts` | `/add-native` routes internally to `add-camera` |
| `image-picker`, `gallery`, `expo-image-picker` | `expo-image-picker` | `src/native/imagePicker.ts` | `/add-native` routes internally to `add-camera` |
| `barcode-scanner`, `qr-scanner`, `scanner`, `barcode`, `qr` | `expo-camera` | `src/native/barcodeScanner.tsx` | `/add-native` routes internally to `add-camera` |
| `document-picker` | `expo-document-picker` | `src/native/documentPicker.ts` | Picks/imports user-selected files (PDF, docs, etc.) from the device |
| `pdf-viewer`, `native-pdf-viewer`, `pdf-control`, `open-pdf`, `@microsoft/power-apps-native-pdf-viewer` | Controls `/pdf` or verified legacy PDF leaf | `src/native/pdfViewer.ts` | `/add-native` routes internally to `add-pdf-viewer`; require the resolved contract's HTTPS/file URI support |
| `pdf-report`, `pdf-export`, `generate-pdf`, `print-report`, `evidence-packet` | `expo-print` (+ optional `expo-sharing`) | `src/native/pdfReport.ts` | `/add-native` routes internally to `add-pdf-report`; generated local files are shared only when `expo-sharing` is present, or uploaded to Dataverse |
| `pen-input`, `signature`, `ink`, `draw`, `@microsoft/power-apps-native-pen-input` | Controls `/pen` or verified legacy pen leaf | `src/native/penInput.ts` | `/add-native` routes internally to `add-pen-input`; captures PNG data URI |
| `geolocation`, `location-tracking`, `background-location`, `gps-tracking`, `geo-tracking`, `@microsoft/power-apps-native-bglocation` | Controls `/geolocation` or verified background-location leaf | `src/native/geolocation.ts` | `/add-native` routes internally to `add-geolocation`; tracking + durable Dataverse sync, distinct from one-shot `location` |
| `secure-store` | `expo-secure-store` | `src/native/secureStore.ts` | |
| `file-system` | `expo-file-system` | `src/native/fileSystem.ts` | |
| `sharing` | `expo-sharing` | `src/native/sharing.ts` | |
| `location` | Resolved controls `/geolocation` or matching leaf; independently verified `expo-location` if applicable | `src/native/location.ts` | One-shot only; geolocation helper skips tracking/table setup |
| `biometrics`, `local-authentication` | `expo-local-authentication` | `src/native/biometrics.ts` | Use only when included in the app's verified release |
| `clipboard` | `expo-clipboard` | `src/native/clipboard.ts` | Use only when included in the app's verified release |
| `mail-composer`, `email-draft` | `expo-mail-composer` | `src/native/mailComposer.ts` | Opens native mail compose when the package is present; connectors still own server-side email sends |
| `audio` | `expo-audio` | `src/native/audio.ts` | Use for audio recording/playback only when package is present |
| `video` | `expo-video` | `src/native/video.ts` | Use for video playback only when package is present |
| `sensors` | `expo-sensors` | `src/native/sensors.ts` | Use only for sensor APIs exposed by the installed package |
| `screen-orientation` | `expo-screen-orientation` | `src/native/screenOrientation.ts` | Use only when package is present; do not edit native config |
| `haptics`, `vibration-feedback`, `impact-feedback`, `selection-feedback`, `notification-feedback` | `expo-haptics` | `src/native/haptics.ts` | Impact, selection, and success/warning/error notification feedback |
| `device-info` | `expo-device` / `expo-application` / `expo-cellular` | `src/native/deviceInfo.ts` | Read-only device/app/cellular metadata wrappers |
| `date-time-picker` | `@react-native-community/datetimepicker` | screen-level component usage | Use directly in form screens per screen-builder rules; no `/add-native` wrapper required |

For custom workflows outside Dataverse File/Image form fields, use the `image-picker` capability via `/add-native image-picker` for user-selected photos and videos, or the `document-picker` capability via `/add-native document-picker` for documents and other files. These wrappers use scoped system-picker flows. Dataverse File/Image form fields remain the exception: use host `<FilePicker>` / `<ImagePicker>` controls as described above, not `/add-native` wrappers or raw Expo module imports.

### PDF / pen routing rules

- Do not treat every PDF request as `document-picker`.
- Use `document-picker` when the user wants to pick, import, or upload a local PDF/document. This remains supported and should still be used for that use case.
- Use `pdf-report` when the app generates a PDF from records, evidence, inspection data, certificates, receipts, or reports, but only if `expo-print` is present in `package.json`.
- Use `native-pdf-viewer` / `pdf-control` for HTTPS or local `file://` PDFs using the resolved `/pdf` or matching legacy contract (PDF 0.2.9+ file support). `content://`, `blob:`, and `http://` URIs are unsupported.
- If a request says "view/open PDF" but the Power Apps viewer package is absent, fall back to `pdf-report` only when the app is generating its own report and `expo-print` is present. Do not claim generic PDF viewing support through `expo-print`; it generates local files, it does not view arbitrary PDFs.
- Use `pen-input` only for signatures, drawn approvals, ink notes, sketches, and handwritten sign-off through the resolved `/pen` or matching legacy contract.
- For other use cases, use the relevant Expo module or other dependency already present in `package.json`; do not force the Power Apps extensions into unrelated flows.
- For generated local PDFs from `expo-print`, use native PDF viewer 0.2.9+ for open/preview, `expo-sharing` for sharing, and Dataverse File storage for retention. Do not require `expo-sharing` merely to preview a local PDF.
- Host `FilePicker` and `ImagePicker` are still correct for user-selected Dataverse File/Image form fields. Generated PDFs and pen captures use native wrappers first, then Dataverse persistence helpers.

### Dataverse artifact persistence rules

- Pen input returns a PNG data URI like `data:image/png;base64,...`.
- For Dataverse Image columns, normalize the data URI to the generated service payload shape. If raw base64 is required, strip the `data:image/png;base64,` prefix.
- For Dataverse File columns, convert the generated PDF or signature PNG into upload bytes/File, save or update the parent row first, then upload through the generated service helper.
- Never put File column bytes in the create/update JSON body. File bytes are uploaded only after the parent row ID exists.
- Screens must handle unsupported, cancelled, upload failed, and viewer failed states explicitly. Pen cancellation is a non-error result that screens can ignore.

**Missing or gated packages:** the resolved release, installed versions, and
matching native runtime are authoritative together. If any evidence is missing,
stop with a transparency note; never claim native readiness from TypeScript alone.

## Workflow

1. Verify project → 2. Resolve release and capability → 3. Auto-route to dedicated skill if one exists → 4. Verify package in resolved release → 5. Write wrapper → 6. Type-check → 7. Summary

---

### Step 1 — Verify project

```bash
test -f app.config.js && test -f power.config.json && test -f package.json
```

### Step 2 — Resolve capability

**Telemetry checkpoint: `resolve_native_capability`**

If `$ARGUMENTS` includes a capability name, package name, or control name, use it. Otherwise look for a `## Native Capabilities` section in `native-app-plan.md` and present the planned capabilities for confirmation. If neither exists, prompt the user with the supported-capabilities list above plus any relevant installed package from `package.json` that directly matches their request.

Normalize the capability name to lowercase, hyphenated form (e.g., `Camera` → `camera`, `ImagePicker` → `image-picker`, `SecureStore` → `secure-store`). Also normalize aliases: `take-photo` / `photo` / `camera-control` / `expo-camera` → `camera`; `gallery` / `pick-image` / `expo-image-picker` → `image-picker`; `scanner` / `barcode` / `qr` → `barcode-scanner`; `open-pdf` / `view-pdf` / `pdf-control` / `pdf-viewer-control` / `@microsoft/power-apps-native-pdf-viewer` → `pdf-viewer`; `native-pdf-viewer` → `pdf-viewer`; `generate-pdf` / `pdf-export` → `pdf-report`; `signature` / `sign-off` / `ink` / `draw` / `pen-control` / `@microsoft/power-apps-native-pen-input` → `pen-input`; `location-tracking` / `background-location` / `gps-tracking` / `geo-tracking` / `track-location` / `power-apps-native-bglocation` / `@microsoft/power-apps-native-bglocation` → `geolocation`; `vibration` / `vibration-feedback` / `impact-feedback` / `selection-feedback` / `notification-feedback` / `expo-haptics` → `haptics`.

When the user asks for "location" or "GPS", disambiguate by intent:
continuous/background tracking or durable Dataverse upload → `geolocation`;
a single foreground coordinate read → `location`. Both route to the geolocation
helper with the mode preserved. The one-shot path has no `app_id`, data source,
table verification, or tracking startup. If the intent is unclear, ask once.
Normalize `@microsoft/power-apps-native-controls/pdf`, `/pen`, and `/geolocation`
to their matching capability; resolve location mode separately.

If the user names something not in the supported table, apply the Native capability gate: resolve the relevant package from `package.json`, continue only when present and not runtime-banned, otherwise stop with a transparency note.

### Step 3 — Route to nested helpers or inline wrappers

**Telemetry checkpoint: `dispatch_native_capability`**

For normalized `camera`, `image-picker`, `barcode-scanner`, `qr-scanner`, `pdf-report`, `pdf-viewer`, `pen-input`, `location`, or `geolocation`, do not fall through to the generic wrapper flow and do not tell the user to run another slash command. Read the nested helper and follow its steps inside this `/add-native` invocation:

```bash
case "<capability>" in
  camera|image-picker|barcode-scanner|qr-scanner) test -f "${PLUGIN_ROOT}/skills/add-native/add-camera/SKILL.md" && echo "INTERNAL_HELPER:add-camera" ;;
  pdf-report) test -f "${PLUGIN_ROOT}/skills/add-native/add-pdf-report/SKILL.md" && echo "INTERNAL_HELPER:add-pdf-report" ;;
  pdf-viewer) test -f "${PLUGIN_ROOT}/skills/add-native/add-pdf-viewer/SKILL.md" && echo "INTERNAL_HELPER:add-pdf-viewer" ;;
  pen-input) test -f "${PLUGIN_ROOT}/skills/add-native/add-pen-input/SKILL.md" && echo "INTERNAL_HELPER:add-pen-input" ;;
  location|geolocation) test -f "${PLUGIN_ROOT}/skills/add-native/add-geolocation/SKILL.md" && echo "INTERNAL_HELPER:add-geolocation" ;;
  *) echo "INLINE" ;;
esac
```

- **INTERNAL_HELPER:** read the printed helper file, execute its workflow with the same `--working-dir` and forwarded arguments, then STOP. `/add-native` remains the only user-facing command for these controls.
- **INLINE:** continue to Step 4.

### Step 4 — Verify module in the resolved release

Require a successful release resolution before this installed-manifest check.
Confirm the exact installed version against the resolved inventory and read its
public docs/types. A matching package name alone does not prove compatibility.

```bash
node -e "const p = require('./package.json'); const m = '<resolved-package-name>'; if (!p.dependencies?.[m]) { console.error('MISSING: ' + m + '. Stop and reconcile the app with its verified release; do not install native packages or re-scaffold an existing app.'); process.exit(1); }"
```

If the check fails, STOP. Do not run `npx expo install`. Print the error verbatim.

### Step 5 — Write wrapper

**Telemetry checkpoint: `generate_native_wrapper`**

**Print before starting:**
> "→ Writing src/native/<wrapper>.ts (typed wrapper with discriminated-union result + iOS/Android platform guards)…"

Create `src/native/<wrapper-filename>.ts` (per the supported-capabilities table). If the file already exists, **do NOT overwrite** — append a comment noting "regeneration skipped — wrapper already exists" and skip to Step 6.

Each wrapper exports:

- `request<Capability>Permission(): Promise<boolean>` — only when the underlying API has a permission model (location, biometrics, notifications). Skip for capabilities without one (secure-store, file-system, sharing, clipboard).
- One or two domain methods returning typed results.

**The contract `screen-builder` agents rely on:**
- All wrappers return a discriminated-union result (`{ ok: true, ... } | { ok: false, reason, message? }`) — **never throw**
- Unsupported runtime/platform states gracefully degrade or return `{ ok: false, reason: 'unsupported' }` — **never crash**
- Native controls guard the native platform before a lazy import inside `try`/`catch`; never eagerly evaluate controls in web. Expo APIs with documented web implementations retain their supported platform behavior.
- Screens import these wrappers only for non-Dataverse native workflows. Dataverse File/Image fields use `@microsoft/power-apps-native-host` controls from the File/Image Picker Ownership section above.

#### Haptics wrapper

For normalized capability `haptics`, generate `src/native/haptics.ts` with this contract:

```ts
import { Platform } from 'react-native';

export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid';
export type HapticNotificationType = 'success' | 'warning' | 'error';
export type HapticResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'error'; message: string };

async function runHaptic(
  effect: (haptics: typeof import('expo-haptics')) => Promise<void>,
): Promise<HapticResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Haptic feedback is available only on iOS and Android.',
    };
  }

  try {
    const Haptics = await import('expo-haptics');
    await effect(Haptics);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : 'The native haptic call failed.',
    };
  }
}

export function triggerImpact(style: HapticImpactStyle = 'medium'): Promise<HapticResult> {
  return runHaptic((Haptics) => {
    const impactStyles = {
      light: Haptics.ImpactFeedbackStyle.Light,
      medium: Haptics.ImpactFeedbackStyle.Medium,
      heavy: Haptics.ImpactFeedbackStyle.Heavy,
      soft: Haptics.ImpactFeedbackStyle.Soft,
      rigid: Haptics.ImpactFeedbackStyle.Rigid,
    };
    return Haptics.impactAsync(impactStyles[style]);
  });
}

export function triggerNotification(
  type: HapticNotificationType = 'success'
): Promise<HapticResult> {
  return runHaptic((Haptics) => {
    const notificationTypes = {
      success: Haptics.NotificationFeedbackType.Success,
      warning: Haptics.NotificationFeedbackType.Warning,
      error: Haptics.NotificationFeedbackType.Error,
    };
    return Haptics.notificationAsync(notificationTypes[type]);
  });
}

export function triggerSelection(): Promise<HapticResult> {
  return runHaptic((Haptics) => Haptics.selectionAsync());
}
```

Screens call the wrapper only when haptics appear in the approved native-capabilities and per-screen plan. Choose feedback by semantics:

- `triggerImpact('light' | 'medium' | 'heavy' | 'soft' | 'rigid')` for deliberate presses or physical-feeling actions.
- `triggerSelection()` when a picker, segmented control, or other selection changes.
- `triggerNotification('success' | 'warning' | 'error')` after the corresponding outcome is known.
- Keep visual feedback as the primary signal. Inspect non-OK results and log them, but do not turn an otherwise successful business operation into a failure because tactile feedback is unavailable.

Screen usage after a successful operation:

```ts
setSaveState({ kind: 'success', message: 'Saved' });
const hapticResult = await triggerNotification('success');
if (!hapticResult.ok) {
  console.warn('[haptics] success feedback unavailable', hapticResult);
}
```

No permission request or `app.config.js` change is required for `expo-haptics`.

#### Other inline wrappers

Consult the module's published API docs (linked from its npm page) for method signatures and permission patterns. Use the secure-store skeleton below as the canonical example of the discriminated-union shape, then translate it to the target module's API.

Secure-store canonical skeleton:

```ts
// src/native/secureStore.ts
import { Platform } from 'react-native';

export type SecureResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unsupported' | 'not-found' | 'error'; message?: string };

export async function getSecret(key: string): Promise<SecureResult<string>> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { ok: false, reason: 'unsupported', message: 'SecureStore is not available on this platform.' };
  }
  try {
    const SecureStore = await import('expo-secure-store');
    const value = await SecureStore.getItemAsync(key);
    if (value === null) return { ok: false, reason: 'not-found' };
    return { ok: true, value };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message };
  }
}

export async function setSecret(key: string, value: string): Promise<SecureResult<true>> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { ok: false, reason: 'unsupported', message: 'SecureStore is not available on this platform.' };
  }
  try {
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(key, value);
    return { ok: true, value: true };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message };
  }
}
```

### Step 6 — Type-check

**Telemetry checkpoint: `validate_native_wrapper`**

**Print before starting:**
> "→ Running tsc to verify wrapper compiles (~10–20 seconds)."

```bash
npx --no-install tsc --noEmit
```

Fix wrapper-side errors only. Do not run local native builds. A package/version
change requires a maintainer-verified Android/iOS release, not customer-side
linking. Type-check success is not a native device validation pass.

### Step 7 — Summary

```
✅ Native wrapper generated: <capability>
─────────────────────────────────────────────
Module (release-matched)  : <package>@<resolved-version>
Release context          : <verified-release-id>
Wrapper created           : src/native/<capability>.ts
package.json              : unchanged ✓
app.config.js             : unchanged ✓

Type-check: PASS

Sample usage:

  import { takePhoto } from '../../src/native/camera';

  const result = await takePhoto();
  if (result.ok) {
    setPhotoUri(result.uri);
  } else if (result.reason === 'permission-denied') {
    showToast('Camera permission required');
  }

⚠️  No local native build performed. Wrapper edits use the matching verified
    player/base; package changes require a verified release migration.
    Type-check alone does not prove native execution or permission grants.
─────────────────────────────────────────────
```

## Notes

- This skill never modifies `package.json`, `app.config.js`, `src/playerConfig.ts`, `src/generated/`, or any screen file.
- For unlisted capabilities, resolve against the app's verified native inventory.
  Missing support requires another verified release, not a new dependency or
  configuration toggle. Do NOT install or configure native modules yourself.
- Pure-JavaScript libraries are out of scope for this skill. `/create-mobile-app` or `/edit-app` selects and installs them through [`shared/references/javascript-dependency-planning.md`](${PLUGIN_ROOT}/shared/references/javascript-dependency-planning.md); no native wrapper or Android/iOS rebuild is needed. The prohibition above applies only to packages with native source/config.
