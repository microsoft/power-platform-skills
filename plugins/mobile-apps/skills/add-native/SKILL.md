---
name: add-native
description: Public entry point for native device capabilities and native controls — camera, image picker, barcode/QR scanner, document picker, file picker, secure storage, file system, sharing, PDF generation/viewing, pen/signature capture, background GPS/geolocation tracking, or supported local file workflows — in a Power Apps mobile app. Also owns routing to internal camera/PDF/pen/geolocation implementation helpers and the guidance boundary between native wrappers and Dataverse File/Image host controls.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Add Native Capability

Generate a one-file typed wrapper under `src/native/` for a native device capability that the upstream template already ships. Screens import the wrapper instead of touching Expo modules directly, so the discriminated-union result contract stays consistent across the app.

## Hard rules — do NOT cross these lines

1. **Never run `npx expo install`, `npm install`, or `yarn add` for a native module.** The set of native modules in `package.json` is fixed by the upstream template. Adding a new one breaks the rewrap pipeline (the customer's binary is built from a pre-built base, not from their `package.json`).
2. **Never edit `app.config.js`** — plugins, `ios.infoPlist`, `android.permissions`, or anything else. All native config the template ships is intentional and signed off; arbitrary additions cannot be honored at rewrap time.
3. **Never edit `package.json` `dependencies` for native modules** (anything starting with `expo-`, `react-native-`, or that ships an iOS/Android folder). Generic JS-only libraries (e.g., `date-fns`, `zod`, `@tanstack/react-query`) are not native modules and remain fine to install via `npx expo install <pkg>` from other skills — this rule scopes only to packages with a config plugin or native code.
4. **If the requested module isn't actually present in `package.json` — STOP.** That means the upstream template hasn't shipped it yet; do not work around by installing it.

## Routing — `/add-native` is the public entry point

Some capabilities have a dedicated implementation helper that does more than a plain wrapper (camera writes scanner/upload helpers; PDF report/viewer helpers enforce local-vs-HTTPS boundaries; pen has native-control-specific validation). Users should still call `/add-native <capability>` for native controls. When a dedicated implementation exists, **run it internally and do not ask the user to run that helper directly**.

**Lookup convention:** after normalizing the capability, first check the internal-helper map below. For `camera`, `image-picker`, `barcode-scanner`, and `qr-scanner`, read and execute `${CLAUDE_SKILL_DIR}/add-camera/SKILL.md` inside this `/add-native` invocation. For `pdf-report`, read and execute `${CLAUDE_SKILL_DIR}/add-pdf-report/SKILL.md`. For `pdf-viewer`, read and execute `${CLAUDE_SKILL_DIR}/add-pdf-viewer/SKILL.md`. For `pen-input`, read and execute `${CLAUDE_SKILL_DIR}/add-pen-input/SKILL.md`. For `geolocation`, read and execute `${CLAUDE_SKILL_DIR}/add-geolocation/SKILL.md`. If no helper exists, fall through to this skill's inline wrapper flow.

Current dedicated implementations:

| Capability | Dedicated skill | Why dedicated |
|---|---|---|
| `camera`, `take-photo`, `photo`, `expo-camera`, `image-picker`, `gallery`, `expo-image-picker`, `barcode-scanner`, `qr-scanner`, `scanner` | [`add-camera`](add-camera/SKILL.md) internal helper | Owns photo capture, gallery image picking, and barcode/QR scanner controls backed by `expo-camera` / `expo-image-picker` |
| `pdf-report`, `pdf-export`, `generate-pdf`, `print-report`, `evidence-packet` | [`add-pdf-report`](add-pdf-report/SKILL.md) internal helper | Generates app-owned local PDFs with `expo-print` and shares them only when `expo-sharing` is present |
| `pdf-viewer`, `native-pdf-viewer`, `pdf-control`, `open-pdf`, `@microsoft/power-apps-native-pdf-viewer` | [`add-pdf-viewer`](add-pdf-viewer/SKILL.md) internal helper | Enforces HTTPS-only viewer URLs and native viewer result handling |
| `pen-input`, `signature`, `ink`, `draw`, `@microsoft/power-apps-native-pen-input` | [`add-pen-input`](add-pen-input/SKILL.md) internal helper | Captures PNG data URI and documents Dataverse Image/File persistence |
| `geolocation`, `location-tracking`, `background-location`, `gps-tracking`, `geo-tracking`, `@microsoft/power-apps-native-bglocation` | [`add-geolocation`](add-geolocation/SKILL.md) internal helper | Native background GPS tracking with durable storage and inline Dataverse sync; distinct from one-shot `expo-location` |

For every other capability listed below, this skill writes the wrapper directly.

## Native capability gate

Before adding any native control or wrapper, apply every gate: classify the intent, resolve the exact package/control from the live `package.json`, confirm it is not runtime-banned, confirm the input/output/storage constraints, then use the matching route below. If any gate fails, the native functionality is not supported for this app version — do not install packages, edit native config, or create fake wrappers.

| User intent | Add/use | Required package or control | Do not use / fallback |
|---|---|---|---|
| Form field bound to a Dataverse File column | Host `<FilePicker>` in screen JSX | `power-apps-native-host` host control | Do not generate document-picker/file-system/sharing wrappers for this field |
| Form field bound to a Dataverse Image column | Host `<ImagePicker>` in screen JSX | `power-apps-native-host` host control | Do not use camera/image-picker wrappers for normal form-bound image fields |
| Dedicated photo/gallery/scanner workflow | `/add-native camera`, `image-picker`, or `barcode-scanner` | `expo-camera` and/or `expo-image-picker` present | If packages are absent, stop with missing-package guidance |
| Pick/import/upload a user-selected PDF/document | `/add-native document-picker`, or host `<FilePicker>` for Dataverse File fields | `expo-document-picker` present, or host File control | Do not treat this as `pdf-report` or native PDF viewer |
| Generate/export/print an app-owned report PDF | `/add-native pdf-report` | `expo-print` present | If `expo-print` is absent, do not add PDF report capability |
| Share/open a generated local PDF | `pdfReport.ts` share helper | `expo-sharing` present | If `expo-sharing` is absent, allow Dataverse upload only; do not render local share/open UI |
| Open/preview an existing PDF URL | `/add-native pdf-viewer` | `@microsoft/power-apps-native-pdf-viewer` present and URL is `https://` | Do not pass `file://`, `content://`, `blob:`, `http://`, or generated local URIs to the viewer |
| Capture signature, ink, drawing, or sign-off | `/add-native pen-input` | `@microsoft/power-apps-native-pen-input` present | If persisted, plan Dataverse Image/File/child Evidence target first |
| Continuous/background GPS tracking with durable Dataverse upload | `/add-native geolocation` | `@microsoft/power-apps-native-bglocation` present | Do not use one-shot `expo-location` for background tracking; do not use the `GeolocationExtension`/HostingSDK path |
| Store generated PDF/signature artifact | Generated Dataverse services after parent row exists | File/Image column or child Evidence/Attachment table exists | Never put File bytes in create/update JSON |
| Native capability not listed in this table | Resolve from `package.json`, then add an inline wrapper only when the matching package is present and not runtime-banned | Exact relevant package present in `package.json` | If no relevant package exists, or the package is runtime-banned, add a transparency note and stop |

Handle multi-part requests row-by-row. Example: "capture signature and attach signed report PDF" requires `pen-input`, `pdf-report`, Dataverse artifact storage, and possibly `sharing`; do not add only the native capability while leaving storage or screen states undefined. The map is not closed: for new shipped packages, resolve by capability semantics, use the directly matching package when safe, and ask once only if multiple installed packages plausibly match.

## File/Image Picker Ownership

This skill owns native file capability mechanics. Screen builders own only the final JSX placement.

There are two different cases:

| Case | Correct implementation | Owner |
|---|---|---|
| Dataverse `File` column | Use `<FilePicker>` from `power-apps-native-host` | screen-builder JSX rule, documented here |
| Dataverse `Image` column | Use `<ImagePicker>` from `power-apps-native-host` | screen-builder JSX rule, documented here |
| Local device document/file workflow not bound to a Dataverse column | Generate/use `src/native/documentPicker.ts`, `src/native/fileSystem.ts`, and/or `src/native/sharing.ts` wrappers | `/add-native` |
| App-generated PDF report workflow | `/add-native` routes internally to `add-pdf-report`; uses `expo-print` and optionally `expo-sharing` only if present | `/add-native` |
| Camera capture, gallery image selection, barcode scanner, or QR scanner workflow | `/add-native` routes internally to `add-camera` | `/add-native` |

**Dataverse File/Image columns use host controls, not raw Expo modules and not app-specific native wrappers.** When a form field binds to a Dataverse **File** column (`FileAttributeMetadata`), render `<FilePicker>` from `power-apps-native-host`. When it binds to a Dataverse **Image** column (`ImageAttributeMetadata`), render `<ImagePicker>` from `power-apps-native-host`. These controls read accent, surface, and text colors from `PowerAppsProvider` / `ThemeProvider` and produce Dataverse-compatible payloads.

```tsx
import { FilePicker, ImagePicker } from 'power-apps-native-host';
import type { PickedFileInfo, PickedImageInfo } from 'power-apps-native-host';

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

Apply the Native capability gate above. This table is a known capability-to-package map, not a guarantee that every listed package exists in every template version.

| Capability | Module | Wrapper to generate | Notes |
|---|---|---|---|
| `camera`, `take-photo`, `photo`, `expo-camera` | `expo-camera` | `src/native/camera.ts` | `/add-native` routes internally to `add-camera` |
| `image-picker`, `gallery`, `expo-image-picker` | `expo-image-picker` | `src/native/imagePicker.ts` | `/add-native` routes internally to `add-camera` |
| `barcode-scanner`, `qr-scanner`, `scanner`, `barcode`, `qr` | `expo-camera` | `src/native/barcodeScanner.tsx` | `/add-native` routes internally to `add-camera` |
| `document-picker` | `expo-document-picker` | `src/native/documentPicker.ts` | Picks/imports user-selected files (PDF, docs, etc.) from the device |
| `pdf-viewer`, `native-pdf-viewer`, `pdf-control`, `open-pdf`, `@microsoft/power-apps-native-pdf-viewer` | `@microsoft/power-apps-native-pdf-viewer` | `src/native/pdfViewer.ts` | `/add-native` routes internally to `add-pdf-viewer`; opens HTTPS PDF URLs only |
| `pdf-report`, `pdf-export`, `generate-pdf`, `print-report`, `evidence-packet` | `expo-print` (+ optional `expo-sharing`) | `src/native/pdfReport.ts` | `/add-native` routes internally to `add-pdf-report`; generated local files are shared only when `expo-sharing` is present, or uploaded to Dataverse |
| `pen-input`, `signature`, `ink`, `draw`, `@microsoft/power-apps-native-pen-input` | `@microsoft/power-apps-native-pen-input` | `src/native/penInput.ts` | `/add-native` routes internally to `add-pen-input`; captures PNG data URI |
| `geolocation`, `location-tracking`, `background-location`, `gps-tracking`, `geo-tracking`, `@microsoft/power-apps-native-bglocation` | `@microsoft/power-apps-native-bglocation` | `src/native/geolocation.ts` | `/add-native` routes internally to `add-geolocation`; native background tracking + durable Dataverse sync. Distinct from one-shot `location` below |
| `secure-store` | `expo-secure-store` | `src/native/secureStore.ts` | |
| `file-system` | `expo-file-system` | `src/native/fileSystem.ts` | |
| `sharing` | `expo-sharing` | `src/native/sharing.ts` | |
| `calendar-management-view` | `react-native-calendars` | None | UI library for calendar/agenda screens. No wrapper, no permissions, no `/add-native` execution; screen-builder imports directly when present in `package.json`. |
| `location` | `expo-location` | `src/native/location.ts` | One-shot/foreground fix only. For continuous background tracking with Dataverse sync, use `geolocation` (`@microsoft/power-apps-native-bglocation`). Use only when the current template package contains `expo-location` |
| `biometrics`, `local-authentication` | `expo-local-authentication` | `src/native/biometrics.ts` | Use only when the current template package contains `expo-local-authentication` |
| `clipboard` | `expo-clipboard` | `src/native/clipboard.ts` | Use only when the current template package contains `expo-clipboard` |
| `mail-composer`, `email-draft` | `expo-mail-composer` | `src/native/mailComposer.ts` | Opens native mail compose when the package is present; connectors still own server-side email sends |
| `media-library` | `expo-media-library` | `src/native/mediaLibrary.ts` | Use for device media-library access only when package is present |
| `audio` | `expo-audio` | `src/native/audio.ts` | Use for audio recording/playback only when package is present |
| `video` | `expo-video` | `src/native/video.ts` | Use for video playback only when package is present |
| `sensors` | `expo-sensors` | `src/native/sensors.ts` | Use only for sensor APIs exposed by the installed package |
| `screen-orientation` | `expo-screen-orientation` | `src/native/screenOrientation.ts` | Use only when package is present; do not edit native config |
| `device-info` | `expo-device` / `expo-application` / `expo-cellular` | `src/native/deviceInfo.ts` | Read-only device/app/cellular metadata wrappers |
| `date-time-picker` | `@react-native-community/datetimepicker` | screen-level component usage | Use directly in form screens per screen-builder rules; no `/add-native` wrapper required |
| `calendar-ui` | `react-native-calendars` | screen-level component usage | JS calendar UI only; not a native permissioned capability |

### PDF / pen routing rules

- Do not treat every PDF request as `document-picker`.
- Use `document-picker` when the user wants to pick, import, or upload a local PDF/document. This remains supported and should still be used for that use case.
- Use `pdf-report` when the app generates a PDF from records, evidence, inspection data, certificates, receipts, or reports, but only if `expo-print` is present in `package.json`.
- Use `native-pdf-viewer` / `pdf-control` only when the app opens/previews an HTTPS PDF URL with `@microsoft/power-apps-native-pdf-viewer`. Local `file://`, `content://`, and `blob:` URIs are unsupported by the native viewer path.
- If a request says "view/open PDF" but the Power Apps viewer package is absent, fall back to `pdf-report` only when the app is generating its own report and `expo-print` is present. Do not claim generic PDF viewing support through `expo-print`; it generates local files, it does not view arbitrary PDFs.
- Use `pen-input` only for signatures, drawn approvals, ink notes, sketches, and handwritten sign-off with `@microsoft/power-apps-native-pen-input`.
- For other use cases, use the relevant Expo module or other dependency already present in `package.json`; do not force the Power Apps extensions into unrelated flows.
- For generated local PDFs from `expo-print`, use `expo-sharing` for local share/open behavior only if `expo-sharing` is present. If `expo-sharing` is absent, generated PDFs can still be uploaded to Dataverse File storage; otherwise do not add local share/open behavior.
- Host `FilePicker` and `ImagePicker` are still correct for user-selected Dataverse File/Image form fields. Generated PDFs and pen captures use native wrappers first, then Dataverse persistence helpers.

### Dataverse artifact persistence rules

- Pen input returns a PNG data URI like `data:image/png;base64,...`.
- For Dataverse Image columns, normalize the data URI to the generated service payload shape. If raw base64 is required, strip the `data:image/png;base64,` prefix.
- For Dataverse File columns, convert the generated PDF or signature PNG into upload bytes/File, save or update the parent row first, then upload through the generated service helper.
- Never put File column bytes in the create/update JSON body. File bytes are uploaded only after the parent row ID exists.
- Screens must handle unsupported, cancelled, upload failed, and viewer failed states explicitly. Pen cancellation is a non-error result that screens can ignore.

**Missing or banned packages:** `package.json` plus the runtime-ban list is authoritative. If the relevant package/control is absent, or the package is runtime-banned, stop with a transparency note. `expo-haptics` remains banned unless the screen-builder hard rule is explicitly removed; use visual-only feedback instead.

## Workflow

1. Verify project → 2. Resolve capability → 3. Auto-route to dedicated skill if one exists → 4. Verify module is template-shipped → 5. Write wrapper → 6. Type-check → 7. Summary

---

### Step 1 — Verify project

```bash
test -f app.config.js && test -f power.config.json && test -f package.json
```

### Step 2 — Resolve capability

If `$ARGUMENTS` includes a capability name, package name, or control name, use it. Otherwise look for a `## Native Capabilities` section in `native-app-plan.md` and present the planned capabilities for confirmation. If neither exists, prompt the user with the supported-capabilities list above plus any relevant installed package from `package.json` that directly matches their request.

Normalize the capability name to lowercase, hyphenated form (e.g., `Camera` → `camera`, `ImagePicker` → `image-picker`, `SecureStore` → `secure-store`). Also normalize aliases: `take-photo` / `photo` / `camera-control` / `expo-camera` → `camera`; `gallery` / `pick-image` / `expo-image-picker` → `image-picker`; `scanner` / `barcode` / `qr` → `barcode-scanner`; `open-pdf` / `view-pdf` / `pdf-control` / `pdf-viewer-control` / `@microsoft/power-apps-native-pdf-viewer` → `pdf-viewer`; `native-pdf-viewer` → `pdf-viewer`; `generate-pdf` / `pdf-export` → `pdf-report`; `signature` / `sign-off` / `ink` / `draw` / `pen-control` / `@microsoft/power-apps-native-pen-input` → `pen-input`; `location-tracking` / `background-location` / `gps-tracking` / `geo-tracking` / `track-location` / `power-apps-native-bglocation` / `@microsoft/power-apps-native-bglocation` → `geolocation`.

When the user asks for "location" or "GPS", disambiguate by intent: continuous/background tracking or durable Dataverse upload → `geolocation` (`@microsoft/power-apps-native-bglocation`); a single foreground coordinate read → `location` (`expo-location`). If the intent is unclear, ask once before routing.

If the user names something not in the supported table, apply the Native capability gate: resolve the relevant package from `package.json`, continue only when present and not runtime-banned, otherwise stop with a transparency note.

If the resolved capability is `calendar-management-view`, STOP after verifying `react-native-calendars` is present in `package.json`: no wrapper is generated because it is a UI library, not a device API. The screen-builder owns importing `Calendar`, `CalendarProvider`, `ExpandableCalendar`, `AgendaList`, `Agenda`, or `CalendarList` directly from `react-native-calendars` based on the approved screen spec.

### Step 3 — Route to nested helpers or inline wrappers

For normalized `camera`, `image-picker`, `barcode-scanner`, `qr-scanner`, `pdf-report`, `pdf-viewer`, `pen-input`, or `geolocation`, do not fall through to the generic wrapper flow and do not tell the user to run another slash command. Read the nested helper and follow its steps inside this `/add-native` invocation:

```bash
case "<capability>" in
  camera|image-picker|barcode-scanner|qr-scanner) test -f "${CLAUDE_SKILL_DIR}/add-camera/SKILL.md" && echo "INTERNAL_HELPER:add-camera" ;;
  pdf-report) test -f "${CLAUDE_SKILL_DIR}/add-pdf-report/SKILL.md" && echo "INTERNAL_HELPER:add-pdf-report" ;;
  pdf-viewer) test -f "${CLAUDE_SKILL_DIR}/add-pdf-viewer/SKILL.md" && echo "INTERNAL_HELPER:add-pdf-viewer" ;;
  pen-input) test -f "${CLAUDE_SKILL_DIR}/add-pen-input/SKILL.md" && echo "INTERNAL_HELPER:add-pen-input" ;;
  geolocation) test -f "${CLAUDE_SKILL_DIR}/add-geolocation/SKILL.md" && echo "INTERNAL_HELPER:add-geolocation" ;;
  *) echo "INLINE" ;;
esac
```

- **INTERNAL_HELPER:** read the printed helper file, execute its workflow with the same `--working-dir` and forwarded arguments, then STOP. `/add-native` remains the only user-facing command for these controls.
- **INLINE:** continue to Step 4.

### Step 4 — Verify module is template-shipped

Confirm the underlying native-capability package is actually present in the project's `package.json` (catches the case where the user hand-removed it or the template version is older than expected):

```bash
node -e "const p = require('./package.json'); const m = '<expo-module-name>'; if (!p.dependencies?.[m]) { console.error('MISSING: ' + m + ' is not in package.json. The template should ship it. Re-scaffold via /create-mobile-app, restore it from upstream, or wait for the template release that adds it — this skill will not install it.'); process.exit(1); }"
```

If the check fails, STOP. Do not run `npx expo install`. Print the error verbatim.

### Step 5 — Write wrapper

**Print before starting:**
> "→ Writing src/native/<wrapper>.ts (typed wrapper with discriminated-union result + iOS/Android platform guards)…"

Create `src/native/<wrapper-filename>.ts` (per the supported-capabilities table). If the file already exists, **do NOT overwrite** — append a comment noting "regeneration skipped — wrapper already exists" and skip to Step 6.

Each wrapper exports:

- `request<Capability>Permission(): Promise<boolean>` — only when the underlying API has a permission model (location, biometrics, notifications). Skip for capabilities without one (secure-store, file-system, sharing, clipboard).
- One or two domain methods returning typed results.

**The contract `screen-builder` agents rely on:**
- All wrappers return a discriminated-union result (`{ ok: true, ... } | { ok: false, reason, message? }`) — **never throw**
- Unsupported runtime/platform states gracefully degrade or return `{ ok: false, reason: 'unsupported' }` — **never crash**
- Branch by supported native platform when a capability differs between iOS and Android
- Screens import these wrappers only for non-Dataverse native workflows. Dataverse File/Image fields use `power-apps-native-host` controls from the File/Image Picker Ownership section above.

**Coding the wrapper:** consult the module's published API docs (linked from its npm page) for method signatures and permission patterns. Use the secure-store skeleton below as the canonical example of the discriminated-union shape — then translate to the target module's API.

Secure-store canonical skeleton:

```ts
// src/native/secureStore.ts
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type SecureResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unsupported' | 'not-found' | 'error'; message?: string };

export async function getSecret(key: string): Promise<SecureResult<string>> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { ok: false, reason: 'unsupported', message: 'SecureStore is not available on this platform.' };
  }
  try {
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
    await SecureStore.setItemAsync(key, value);
    return { ok: true, value: true };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message };
  }
}
```

### Step 6 — Type-check

**Print before starting:**
> "→ Running tsc to verify wrapper compiles (~10–20 seconds)."

```bash
npx tsc --noEmit
```

Fix any wrapper-side errors. Do NOT run platform-specific native build commands here — and you should not need to, because no native config changed.

### Step 7 — Summary

```
✅ Native wrapper generated: <capability>
─────────────────────────────────────────────
Module (template-shipped) : <expo-module>@<version-from-package.json>
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

⚠️  No native rebuild required. Wrappers are pure JS — Metro hot-reload picks them up.
    The underlying native module was already linked when the template was scaffolded.
─────────────────────────────────────────────
```

## Notes

- This skill never modifies `package.json`, `app.config.js`, `src/playerConfig.ts`, `src/generated/`, or any screen file.
- For capabilities not in the supported table (`expo-notifications`, Bluetooth, NFC, BLE, AR — until the template adds them), tell the user the template doesn't ship them yet — file a request at the upstream template repo. Do NOT attempt to install or configure anything yourself.
- Generic JS-only libraries (`date-fns`, `zod`, `@tanstack/react-query`, etc.) are out of scope for this skill but remain fine to install via `npx expo install <pkg>` in other contexts — the prohibition above applies only to native modules with a config plugin or platform code.
