---
name: add-camera
description: Internal implementation skill invoked by /add-native for camera, image picker, barcode scanner, QR scanner, and camera/gallery Dataverse artifact workflows.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Working directory:** before any project read or command, execute
[native-artifact-compatibility.md Step 0](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md#0-bind-every-operation-to-the-app-root).
Inherit `/add-native`'s resolved absolute `working_dir`; bind every shell call and
file tool to it, even when this helper starts from another directory.

**References:**

- [dataverse-reference.md](${PLUGIN_ROOT}/skills/add-dataverse/references/dataverse-reference.md) — File/image column upload patterns (Step 7–8)

# Add Camera

**Internal helper.** Users should invoke `/add-native camera`, `/add-native image-picker`, `/add-native barcode-scanner`, or `/add-native qr-scanner`; `/add-native` routes here after resolving the capability.

Generate typed camera + image-picker wrappers, an optional barcode/QR scanner control, and optional custom-upload guidance for Dataverse image/file workflows.

This skill **only writes JS files under `src/native/`**. It does not install
modules or touch `package.json` / `app.config.js`. Only the modules required by
the approved artifact set below must already ship in the template/native build;
if a required module is missing, STOP. Do not require unrelated capture packages
for a scanner-only or upload-only request.

Why: customer binaries are built from a pre-built rewrap base, not from the customer's `package.json`. Adding a native module here would compile against modules the binary doesn't actually contain, causing runtime crashes after rewrap. See [`/add-native`](../SKILL.md) for the same hard rules.

Required modules depend on the approved artifact set (all must already be in
`package.json`):

| Requested artifact key | Required module | Output |
|---|---|---|
| `photo` / `gallery` | `expo-image-picker` | `camera.ts` capture/picker APIs |
| `scanner` | `expo-camera` | `barcodeScanner.tsx` live scanner |
| `upload` | `expo-file-system` | `cameraUpload.ts` custom Image helper |

Use the union for combined requests. A scanner-only request does not require
`expo-image-picker` or `camera.ts`; an upload-only request does not require a
capture/scanner package.

**Dataverse File/Image boundary:** for normal Dataverse File/Image form fields, screens should use `FilePicker` / `ImagePicker` from `@microsoft/power-apps-native-host` (see [`/add-native` File/Image Picker Ownership](../SKILL.md#fileimage-picker-ownership)). `/add-native camera` owns custom camera/gallery/scanner workflows, such as a dedicated evidence-capture screen, barcode/QR scan gate, or gallery-selected image that is transformed before saving.

**Pen/signature boundary:** signature, sign-off, ink, drawing, or pen capture belongs to `/add-native pen-input` (which routes internally to the pen helper). Both camera photos and pen signatures can persist to Dataverse Image/File columns, but the capture wrappers are separate.

## Workflow

1. Verify project → 2. Verify modules are template-shipped → 2a. Reconcile requested artifacts → 3. Apply camera decision → 3b. Apply scanner decision → 4. Confirm storage decision → 5. Apply upload decision → 6. Verify → 7. Summary

---

### Step 1 — Verify project

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
test -f app.config.js && test -f power.config.json && test -f package.json || { echo "BLOCKED: working_dir is not an initialized app" >&2; exit 1; }
```

If any file is missing, report and STOP — this skill requires an initialized Power Apps mobile app.

### Step 2 — Verify modules are template-shipped

Resolve the approved artifact keys before this check. Missing/ambiguous intent
returns to the owner (ask standalone); do not assume all artifacts. Substitute
the exact JSON list, e.g. `["scanner"]` or `["photo","upload"]`, below:

Use the owner's normalized public capability to resolve those keys:

| Public capability | Artifact keys |
|---|---|
| `camera` | `["photo"]` |
| `image-picker` | `["gallery"]` |
| `barcode-scanner` | `["scanner"]` |
| `qr-scanner` | `["scanner"]` |

For combined approved capabilities use the union. Add `upload` only for an
explicitly approved custom Dataverse Image-upload helper, not automatically for
capture or scanning. The checker accepts artifact-key JSON, not raw `$ARGUMENTS`
or a public capability string. Missing/ambiguous intent still returns to the owner.

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node - '<approved-artifact-keys-json>' <<'NODE'
const p = require('./package.json');
const modules = {
  photo: 'expo-image-picker',
  gallery: 'expo-image-picker',
  scanner: 'expo-camera',
  upload: 'expo-file-system',
};
const artifacts = JSON.parse(process.argv[2]);
if (!Array.isArray(artifacts) || artifacts.length === 0
    || artifacts.some(key => typeof key !== 'string' || !Object.hasOwn(modules, key))) {
  throw new Error('Expected a nonempty approved artifact list: photo, gallery, scanner, upload');
}
const need = [...new Set(artifacts.map(key => modules[key]))];
const missing = need.filter(name => !p.dependencies?.[name]);
if (missing.length) {
  console.error('MISSING from package.json: ' + missing.join(', ') + '. Do not install native modules.');
  process.exit(1);
}
console.log('OK: requested modules present');
NODE
```

If the check fails, STOP. Print the error verbatim. Do not run `npx expo install`. Do not edit `app.config.js`. Tell the user which requested modules the template lacks; they need template support, not an app-local native-package install.

### Step 2a — Reconcile requested artifacts

Read and execute [native-artifact-compatibility.md](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md)
Steps 1–3 for the camera/gallery/scanner row before any writes or reuse. Inherit
the current approval/mode from `/add-native`; do not repeat a valid scoped approval.

Inventory `src/native/camera.ts` (including gallery `pickImage`, not a required
`imagePicker.ts`), requested `src/native/barcodeScanner.tsx`, and requested
`src/native/cameraUpload.ts` independently. Check requested exports, options,
failure paths, scanner lock/reset/overlay behavior, and any requested Dataverse
Image-upload payload semantics. Resolve the approved storage platform and Step 4
requirements read-only now, before writes; non-Dataverse retention must not
require Dataverse columns or `cameraUpload.ts`.
Missing required storage or an incompatible artifact outside approval returns
`NEEDS_CONTEXT` to the owner, or asks standalone; it is not a successful skip.

Set `SCANNER_NEEDED=yes` only for scanning in the current approved request/scope
(`barcode`, `QR`, scanner, or a supplied scan-gate requirement), not unrelated
matches in an older plan. A compatible camera file cannot satisfy a missing
scanner or upload helper. Preserve compatible files unchanged in partial sets.

### Step 3 — Write camera wrapper

**Print only when creating/updating the requested camera wrapper:**
> "→ Writing src/native/camera.ts wrapper (takePhoto + pickImage with discriminated-union results)…"

Apply Step 2a's decision for `src/native/camera.ts`: create if requested and
missing, reuse unchanged only if compatible, or make only the approved scoped
update. Scanner-only requests do not require this file. Preserve custom code and
existing exports; do not append regeneration comments or replace it with the example.

```typescript
// src/native/camera.ts
// Camera capture and image picker wrapper for Power Apps mobile apps.
// Uses expo-image-picker for both camera capture and gallery selection.
// Capture/pick functions return discriminated results; permission helpers retain boolean APIs.

import * as ImagePicker from 'expo-image-picker';

// --- Result types ---

export type PhotoResult =
  | { ok: true; uri: string; width: number; height: number; mimeType?: string; fileSize?: number }
  | { ok: false; reason: 'permission-denied' | 'cancelled' | 'unsupported' | 'error'; message?: string };

// --- Permission ---

type PermissionResult =
  | { ok: true }
  | { ok: false; reason: 'permission-denied' | 'unsupported' | 'error'; message?: string };

async function requestPermission(
  request?: () => Promise<{ status: string }>,
): Promise<PermissionResult> {
  if (typeof request !== 'function') {
    return { ok: false, reason: 'unsupported', message: 'Permission API is unavailable.' };
  }
  try {
    const { status } = await request();
    return status === 'granted'
      ? { ok: true }
      : { ok: false, reason: 'permission-denied' };
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : 'Permission request failed.',
    };
  }
}

async function permissionGranted(
  request?: () => Promise<{ status: string }>,
): Promise<boolean> {
  const permission = await requestPermission(request);
  if (!permission.ok && permission.reason !== 'permission-denied') {
    // Preserve the public boolean API without silently hiding a failed native request.
    console.warn(`Device permission request failed (${permission.reason}).`);
  }
  return permission.ok;
}

export async function requestCameraPermission(): Promise<boolean> {
  return permissionGranted(ImagePicker.requestCameraPermissionsAsync);
}

export async function requestMediaLibraryPermission(): Promise<boolean> {
  return permissionGranted(ImagePicker.requestMediaLibraryPermissionsAsync);
}

// --- Capture ---

/**
 * Launch the device camera and capture a photo.
 * Missing APIs return 'unsupported'; rejected native calls return 'error'.
 */
export async function takePhoto(options?: {
  quality?: number;
  allowsEditing?: boolean;
}): Promise<PhotoResult> {
  try {
    if (typeof ImagePicker.launchCameraAsync !== 'function') {
      return { ok: false, reason: 'unsupported', message: 'Camera API is unavailable.' };
    }
    const permission = await requestPermission(ImagePicker.requestCameraPermissionsAsync);
    if (!permission.ok) return permission;

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: options?.quality ?? 0.8,
      allowsEditing: options?.allowsEditing ?? false,
      exif: false,
    });

    if (result.canceled) return { ok: false, reason: 'cancelled' };

    const asset = result.assets[0];
    return {
      ok: true,
      uri: asset.uri,
      width: asset.width ?? 0,
      height: asset.height ?? 0,
      mimeType: asset.mimeType ?? undefined,
      fileSize: asset.fileSize ?? undefined,
    };
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Camera capture failed.' };
  }
}

/**
 * Open the device photo gallery and pick an image.
 * Works on all platforms including web (uses native file picker).
 */
export async function pickImage(options?: {
  quality?: number;
  allowsEditing?: boolean;
  allowsMultipleSelection?: boolean;
}): Promise<PhotoResult> {
  try {
    if (typeof ImagePicker.launchImageLibraryAsync !== 'function') {
      return { ok: false, reason: 'unsupported', message: 'Image picker API is unavailable.' };
    }
    const permission = await requestPermission(ImagePicker.requestMediaLibraryPermissionsAsync);
    if (!permission.ok) return permission;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: options?.quality ?? 0.8,
      allowsEditing: options?.allowsEditing ?? false,
      allowsMultipleSelection: options?.allowsMultipleSelection ?? false,
      exif: false,
    });

    if (result.canceled) return { ok: false, reason: 'cancelled' };

    const asset = result.assets[0];
    return {
      ok: true,
      uri: asset.uri,
      width: asset.width ?? 0,
      height: asset.height ?? 0,
      mimeType: asset.mimeType ?? undefined,
      fileSize: asset.fileSize ?? undefined,
    };
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Image selection failed.' };
  }
}
```

### Step 3b — Write barcode/QR scanner control when requested

**Skip this step unless `SCANNER_NEEDED=yes`.** Photo-only and gallery-only flows do not need a live `CameraView`.

**Print before starting:**
> "→ Writing src/native/barcodeScanner.tsx (CameraView barcode/QR scanner control)…"

Apply Step 2a's independent decision for `src/native/barcodeScanner.tsx`: create
when requested and missing, reuse unchanged only if compatible, or make only the
approved scoped update. Existence alone does not verify `BarcodeScannerView`,
`onScanned`, `paused`, `resetKey`, or the requested barcode types.

```tsx
// src/native/barcodeScanner.tsx
// Barcode / QR scanner control for Power Apps mobile apps.
// Uses expo-camera CameraView. Never throws; permission state is rendered inline.

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult, BarcodeType } from 'expo-camera';

export type ScannerResult = {
  ok: true;
  data: string;
  type: string;
  raw: BarcodeScanningResult;
};

export type BarcodeScannerViewProps = {
  onScanned: (result: ScannerResult) => void;
  paused?: boolean;
  resetKey?: unknown;
  barcodeTypes?: BarcodeType[];
  style?: StyleProp<ViewStyle>;
  overlay?: React.ReactNode;
  children?: React.ReactNode;
};

const DEFAULT_BARCODE_TYPES = [
  'aztec',
  'qr',
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'datamatrix',
  'code39',
  'code93',
  'code128',
  'pdf417',
  'itf14',
  'codabar',
] as BarcodeType[];

export function BarcodeScannerView({
  onScanned,
  paused = false,
  resetKey,
  barcodeTypes = DEFAULT_BARCODE_TYPES,
  style,
  overlay,
  children,
}: BarcodeScannerViewProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [permissionError, setPermissionError] = React.useState<string | null>(null);
  const permissionAttemptedRef = React.useRef(false);
  const scanLockedRef = React.useRef(false);

  React.useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain && !permissionAttemptedRef.current) {
      permissionAttemptedRef.current = true;
      async function requestScannerPermission() {
        try {
          await requestPermission();
        } catch {
          setPermissionError('Camera permission request failed. Check device settings and reopen the scanner.');
        }
      }
      void requestScannerPermission();
    }
  }, [permission, requestPermission]);

  React.useEffect(() => {
    if (!paused) {
      scanLockedRef.current = false;
    }
  }, [paused, resetKey]);

  const handleBarcodeScanned = React.useCallback((event: BarcodeScanningResult) => {
    if (paused || scanLockedRef.current) return;
    scanLockedRef.current = true;
    onScanned({ ok: true, data: event.data, type: event.type, raw: event });
  }, [onScanned, paused]);

  if (permissionError) {
    return <View style={[styles.fallback, style]}><Text>{permissionError}</Text></View>;
  }

  if (!permission) {
    return <View style={[styles.fallback, style]}><Text>Checking camera permission...</Text></View>;
  }

  if (!permission.granted) {
    return <View style={[styles.fallback, style]}><Text>Camera permission is required to scan codes.</Text></View>;
  }

  return (
    <View style={[styles.container, style]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        active={!paused}
        barcodeScannerSettings={{ barcodeTypes }}
        onBarcodeScanned={paused ? undefined : handleBarcodeScanned}
      />
      {overlay || children ? <View pointerEvents="box-none" style={styles.overlay}>{overlay ?? children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden', position: 'relative' },
  overlay: { ...StyleSheet.absoluteFillObject },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
});
```

Scanner rendering rule: do **not** put overlay UI as `CameraView` children. Expo Camera can render incorrectly when React children are nested inside the native camera preview. The generated control renders the camera as one layer and renders `overlay` / `children` as a sibling absolute layer above it.

Scan mutation rule: the generated control has an internal one-shot scan lock so rapid `onBarcodeScanned` callbacks cannot double-submit. Screens should still set `paused=true` before navigating or mutating data, then reset `paused=false` and change `resetKey` when the screen regains focus. This makes returning to the scanner reliable after a successful scan.

Scan-gate business rule: for QR lookup flows, resolve the scanned code against the target entity first (for example, `Test Item`). If the lookup misses, show a clear inline `Item does not exist` message and keep scanner flow in-place. Do not auto-create `Unknown` scan rows unless the approved plan explicitly requires that fallback behavior.

Scanner loading UI rule: when scan processing takes time (lookup/create mutation), render a spinner-only overlay inside the scanner preview via the `overlay` prop. Do not render a separate loading card/panel above the camera preview.

### Step 4 — Detect Dataverse image/file columns

Reuse Step 2a's read-only storage findings; repeat the check only if those files
changed. Classify the approved storage destination before searching Dataverse:

| Approved storage scope | Helper action |
|---|---|
| No retention / local preview only | Skip the Dataverse search and Step 5; fulfill the requested capture/scanner artifacts. |
| Non-Dataverse retention (for example an existing SharePoint document library) or approved local-file retention | Skip the Dataverse search and Step 5. Validate the required capture output/payload against the approved destination contract, then return the connector/local persistence work to the owner. Missing Dataverse columns are not an error on this path. Do not generate `cameraUpload.ts` or claim persistence is implemented by capture alone. |
| Dataverse File retention or a normal host File/Image field | Apply the shared storage checks and return the File/host-control integration to the owner; do not use the custom Image `update()` helper. A File target is not supported by the Image `update()` example. |
| Custom Dataverse Image upload helper requested | Inspect the actual approved Image column and generated service signature below, then apply Step 5. |
| Destination or required payload contract is unknown | Return `NEEDS_CONTEXT` to the owner (ask standalone); do not assume Dataverse or silently drop retention. |

Only the custom Dataverse Image-helper branch requires this column search:

```text
Grep pattern="ImageColumnName|FileColumnName|UploadColumnName" path="src/generated/"
```

**If matches found:** verify the approved target, column type, payload, and write
result contract. Continue to Step 5 only for requested custom camera/gallery
**Image** retention outside host controls. Mere presence of generated columns does
not authorize an upload helper. If the matched target is File rather than the
approved Image target, return the mismatch to the owner without generating an
Image helper or claiming File persistence is implemented.

File/Image host-control safety: this skill does not replace normal Dataverse form controls. Keep host `ImagePicker` / `FilePicker` for standard Dataverse form-bound Image/File fields.

**If the requested Dataverse Image target is missing/unverified:** return
`NEEDS_CONTEXT` to the owner, or ask standalone; do not silently deliver a
capture-only success for that requested helper. This blocker applies only to
the Dataverse Image-helper branch, not an approved connector/local destination.
Do not generate schema/services or hand-edit `src/generated/`.

### Step 5 — Write image upload helper

**Print before starting:**
> "→ Writing src/native/cameraUpload.ts (Dataverse image column base64 patch helper)…"

Apply Step 2a's independent decision for `src/native/cameraUpload.ts`: create
when requested and missing, reuse unchanged only if compatible with the approved
Image target and installed file API, or make only the approved scoped update.
An existing Image helper cannot satisfy File retention.

Do **not** generate this helper for normal Dataverse File/Image form fields. Those
use host `FilePicker` / `ImagePicker` controls. Generate it only when the current
approved scope requests custom camera/gallery Image retention, including an
explicit implementation-only upload-helper request; a screen plan is not required
for that bounded operation.

This helper does not change host `ImagePicker` / `FilePicker` behavior. It only covers custom photo-capture flows where the app receives a camera URI and then updates a Dataverse Image column explicitly.

This helper is for **Dataverse Image columns** in native apps. It reads the local photo URI using Expo file APIs, converts it to base64, then calls the generated service `update()` with `{ [imageColumnName]: base64 }`.

Do **not** convert camera URIs into browser-style `File` / `Blob` objects for this path. That pattern is fragile in RN/Expo runtimes and causes upload failures like `arrayBuffer is not a function`.

```typescript
// src/native/cameraUpload.ts
// Bridges camera/gallery photo output to Dataverse Image column updates.
// Reads local image URI as base64 and PATCHes the image column via service.update().

import * as FileSystem from 'expo-file-system';

export type UploadResult =
  | { ok: true }
  | { ok: false; reason: 'read-failed' | 'update-failed' | 'error'; message?: string };

export type ImageUpdateService = {
  update: (id: string, body: any) => Promise<{ success: boolean; error?: { message?: string } }>;
};

/**
 * Upload a photo from takePhoto() / pickImage() to a Dataverse Image column.
 *
 * @param uri             - Photo URI from the camera wrapper result
 * @param service         - Generated Dataverse service with update()
 * @param recordId        - The Dataverse record GUID to patch
 * @param imageColumnName - Dataverse Image column logical name
 */
export async function uploadPhotoToImageColumn(
  uri: string,
  service: ImageUpdateService,
  recordId: string,
  imageColumnName: string,
): Promise<UploadResult> {
  try {
    const base64 = await readUriAsBase64(uri);
    if (!base64) {
      return { ok: false, reason: 'read-failed', message: 'Could not read the image URI as base64.' };
    }

    // Dataverse Image columns expect base64 payload value (without data URI prefix).
    const result = await service.update(recordId, { [imageColumnName]: base64 });

    if (!result.success || result.error) {
      return { ok: false, reason: 'update-failed', message: result.error?.message ?? 'Dataverse image update failed.' };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Unable to upload image.' };
  }
}

/**
 * Read a local photo URI to a base64 string using Expo file APIs.
 */
async function readUriAsBase64(uri: string): Promise<string | null> {
  try {
    const fsAny = FileSystem as any;
    if (typeof fsAny.readAsStringAsync !== 'function') {
      return null;
    }

    const normalizedUri = uri.startsWith('file://') ? uri : `file://${uri}`;
    const base64 = await fsAny.readAsStringAsync(normalizedUri, {
      encoding: fsAny.EncodingType?.Base64 ?? 'base64',
    });
    if (typeof base64 !== 'string' || base64.length === 0) {
      return null;
    }

    return base64;
  } catch {
    return null;
  }
}
```

**Important:** The `service` parameter is typed loosely (`ImageUpdateService`) so it works with any generated service that has `update()`. The caller passes the concrete service — this avoids importing a specific generated service in the helper.

**Write contract:** the helper must treat any non-truthy `result.success` as failure even when `result.error` is missing. Generated services return `IOperationResult`, and native app screens must not show success or navigate after any Dataverse write unless `success` is truthy.

**Template/API note:** if `readAsStringAsync` is not available from `expo-file-system` in your template version, import from `expo-file-system/legacy` and keep the same base64 behavior.

### Step 6 — Type-check

**Print before starting:**
> "→ Running tsc to verify the requested native artifacts compile (~10–20 seconds)."

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
npx tsc --noEmit
```

Fix only in-scope helper errors. Common issues:
- `readAsStringAsync` not found on `expo-file-system` — switch import to `expo-file-system/legacy` for this helper.
- Import path mismatches — verify `src/native/` is reachable from screen components.

Execute the shared compatibility contract's Step 4 after type-checking. Recheck
every requested camera/scanner/upload artifact and storage obligation, including
permission failures, repeated scan callbacks, URI reads, and false write results.
Type-check success alone is insufficient; return unresolved requirements rather
than marking a partial output set complete. Do not fix screen/generated files.

### Step 7 — Summary

Return the shared compatibility result and actual created/updated/reused paths.
Show only applicable usage examples; no upload success claim when retention is
unresolved, and no full-feature claim for implementation-only work.

```
Requested native artifacts ready
---
Capabilities               : <fulfilled requested capabilities only>
Modules (template-shipped) : <required modules for those capabilities only>
package.json               : unchanged ✓
app.config.js              : unchanged ✓
Artifacts                  : <one row per requested path: created / updated / reused>

Type-check                 : <actual result>
UI integration             : <returned to owner / intentionally not performed>
---
```

Do not list `camera.ts` for scanner-only or upload-only results. Do not list
unrequested companion paths as generated, even if they already existed.

**Include this usage only when capture and custom Image upload were fulfilled:**

```text
  import { takePhoto } from '../native/camera';
  import { uploadPhotoToImageColumn } from '../native/cameraUpload';
  import { Cr123_inspectionService } from '../generated/services/Cr123_inspectionService';

  const result = await takePhoto();
  if (result.ok) {
    const upload = await uploadPhotoToImageColumn(
      result.uri,
      Cr123_inspectionService,
      recordId,
      'cr123_sitephoto'  // Dataverse Image column logical name
    );
    if (upload.ok) {
      showToast('Photo attached to record');
    }
  }
```

**Include this usage only when gallery picking was fulfilled:**

```text
  import { pickImage } from '../native/camera';

  const result = await pickImage();
  if (result.ok) {
    setPreviewUri(result.uri);
  }
```

**Include this usage only when scanner support was fulfilled:**

```text
  import { BarcodeScannerView } from '../native/barcodeScanner';
  import { useFocusEffect } from 'expo-router';

  const [paused, setPaused] = useState(false);
  const [scanResetKey, setScanResetKey] = useState(0);

  useFocusEffect(
    React.useCallback(() => {
      setPaused(false);
      setScanResetKey((value) => value + 1);
      return () => setPaused(true);
    }, [])
  );

  <BarcodeScannerView
    paused={paused}
    resetKey={scanResetKey}
    barcodeTypes={['qr', 'ean13', 'code128']}
    overlay={
      <>
        <ScannerFrame />
        {isScanning ? <ScannerOverlaySpinner /> : null}
      </>
    }
    onScanned={({ data, type }) => {
      setPaused(true);
      handleCode(data, type);
    }}
  />
```

No native rebuild or permission/config change is performed. These are JS
wrapper/control changes over template-shipped native modules.

## Notes

- This skill never modifies `src/playerConfig.ts`, `src/generated/`, or any screen file.
- `takePhoto()` returns `unsupported` for missing APIs and `error` for rejected native calls; neither rejects its promise.
- Barcode/QR scanning is handled here via `src/native/barcodeScanner.tsx` when requested. Use it for scan gates and lookup flows; do not use it as a replacement for Dataverse File/Image host controls.
- `cameraUpload.ts` in this skill targets custom Dataverse Image-column capture flows only. It does not replace host `ImagePicker` / `FilePicker` controls for standard Dataverse forms.
- If Dataverse tables are added later (via `/add-dataverse`), re-run `/add-native camera` with the approved custom Image-retention requirement. Reconcile all requested artifacts again, reuse compatible wrappers unchanged, and create/update `cameraUpload.ts` only within that scope. This never installs modules.
