---
name: add-pen-input
description: Internal implementation skill invoked by /add-native for pen, signature, ink, drawing, and handwriting capture using release-matched controls or legacy pen APIs.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Working directory:** before any project read or command, execute
[native-artifact-compatibility.md Step 0](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md#0-bind-every-operation-to-the-app-root).
Inherit `/add-native`'s resolved absolute `working_dir`; bind every shell call and
file tool to it, even when this helper starts from another directory.

# Add Pen Input

**Internal helper.** Users should invoke `/add-native pen-input`, `/add-native signature`, or `/add-native @microsoft/power-apps-native-pen-input`; `/add-native` routes here after resolving the capability.

Generate or verify the native pen input wrapper and show how to call its **native React Native API**. Do not use the HostingSDK / PCF path from the package README; that is for a different use case.

## Steps

### 1. Verify app

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src || { echo "BLOCKED: working_dir is not an initialized app" >&2; exit 1; }
```

If this fails, tell the user to run `/create-mobile-app` first and STOP.

### 2. Verify the app-matched release and import path

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root '<working_dir>'
```

If the parent explicitly selected local diagnostic artifacts, append the same
`--diagnostic-artifacts '<manifest.json>'` to resolution and package validation.
Keep the lifecycle reference's Android-artifact/no-deployment limits and preserve offline configuration.

Read [release lifecycle](../../../shared/references/mobile-release-lifecycle.md)
and [native controls](../references/native-controls.md). Unknown/missing release
records STOP native mutation. Match installed public docs/types and native
inventory before using the example. Do not install packages or edit native config.

The example uses `@microsoft/power-apps-native-controls/pen` only when the
verified release contains it. A verified legacy release may instead use the
literal `@microsoft/power-apps-native-pen-input` import if the matching leaf
is included. Never import both, the aggregate root, or a runtime fallback.

### 2a. Reconcile requested artifacts

Read and execute [native-artifact-compatibility.md](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md)
Steps 1–3 for the pen input row before any writes or reuse. Inherit the current
approval/mode from `/add-native`; do not repeat a valid scoped approval.
Inspect `src/native/penInput.ts` for `captureSignature`, `stripDataUriPrefix`,
`PenInputResult`, requested options, PNG data URI output, and non-error
`USER_CANCELLED`. Check approved Image/File payload requirements as well as
capture: a missing normalizer or unknown required generated service signature
cannot be ignored. Missing required storage or an incompatible artifact outside
approval returns `NEEDS_CONTEXT` to the owner, or asks standalone.

### 3. Write or verify `src/native/penInput.ts`

Apply Step 2a's decision for `src/native/penInput.ts`: create when requested and
missing, reuse unchanged only if compatible, or make only the approved scoped
update. Preserve custom code, exports, and callers; do not overwrite from the example.

The wrapper MUST:

- Return a discriminated union and never throw.
- Return `{ ok: false, reason: 'USER_CANCELLED' }` for user cancellation; this is a non-error path.
- Return `NATIVE_MODULE_MISSING` when the extension is installed in JS but unavailable in the native build.
- Return a PNG data URI (`data:image/png;base64,...`) on success.

```ts
// src/native/penInput.ts
import { Platform } from 'react-native';

export type PenInputResult =
  | { ok: true; dataUri: string }
  | { ok: false; reason: 'UNSUPPORTED_PLATFORM' | 'USER_CANCELLED' | 'NATIVE_MODULE_MISSING' | 'CAPTURE_FAILED'; message?: string };

export async function captureSignature(options?: {
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
}): Promise<PenInputResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { ok: false, reason: 'UNSUPPORTED_PLATFORM' };
  }

  try {
    const { PenInputNative, PenInputStatus, PenInputErrorCode } =
      await import('@microsoft/power-apps-native-controls/pen');
    if (!PenInputNative?.capturePenInput) {
      return { ok: false, reason: 'NATIVE_MODULE_MISSING' };
    }
    const result = await PenInputNative.capturePenInput({
      backgroundColor: '#ffffff',
      strokeColor: '#0078d4',
      strokeWidth: 2,
      ...options,
    });

    if (result.status === PenInputStatus.Ok && result.result) {
      return { ok: true, dataUri: result.result };
    }

    if (result.error === PenInputErrorCode.UserCancelled) {
      return { ok: false, reason: 'USER_CANCELLED' };
    }

    if (result.error === PenInputErrorCode.NativeModuleMissing) {
      return { ok: false, reason: 'NATIVE_MODULE_MISSING' };
    }
    return { ok: false, reason: 'CAPTURE_FAILED', message: result.error };
  } catch (error: any) {
    return { ok: false, reason: 'CAPTURE_FAILED', message: error?.message ?? String(error) };
  }
}

export function stripDataUriPrefix(dataUri: string): string {
  return dataUri.replace(/^data:image\/png;base64,/, '');
}
```

### 4. Use the wrapper

Integration guidance for the owner; do not edit screens in this helper.

Screens import the wrapper, not the native package directly:

```ts
import { captureSignature } from '@/native/penInput';

const result = await captureSignature({
  backgroundColor: "#ffffff",
  strokeColor: "#0078d4",
  strokeWidth: 2,
});

if (result.ok) {
  setSignatureUri(result.dataUri);
} else if (result.reason === 'USER_CANCELLED') {
  // User cancelled; do not show this as an app error.
} else {
  console.warn("Failed to capture pen input:", result.reason, result.message);
}
```

Display the captured PNG with a normal React Native image:

```tsx
{signatureUri ? (
  <Image
    source={{ uri: signatureUri }}
    style={{ width: "100%", height: 160 }}
    resizeMode="contain"
  />
) : null}
```

Notes:
- The result is a PNG data URI: `data:image/png;base64,...`.
- Color inputs support `#RGB` and `#RRGGBB`.
- Cancel is normal and returns `USER_CANCELLED`; screens should leave current state unchanged and avoid failure banners.
- Use the selected `/pen` or verified legacy pen import only for freehand drawing, ink, handwriting, and signatures. Other native use cases require their own resolved package/version and installed public contract.

### 5. Optional Dataverse save

Optional means unrequested, not skippable when retention is approved. Step 2a
verifies wrapper payload support and the generated signature; the owner supplies
the screen-side save/upload below. Return missing helper-owned support or unknown
required storage as `NEEDS_CONTEXT`, not a capture-only success.

If the user wants to save the signature to a Dataverse Image/File column, use generated services only. Do not write direct Dataverse Web API calls.

Image column pattern: normalize the data URI to the generated service's expected image payload. If raw base64 is required, strip the prefix.

```ts
import { stripDataUriPrefix } from '@/native/penInput';

const signatureBase64 = stripDataUriPrefix(result.dataUri);

const update = await Cr123_evidenceService.update(id, {
  cr123_signatureimage: signatureBase64,
  cr123_signedat: new Date().toISOString(),
});

if (!update.success) {
  showError(update.error?.message ?? 'Signature was not saved.');
}
```

File column pattern: save or update the parent row first, then upload the PNG bytes/File through the generated service helper. Never put File column bytes in the create/update JSON body.

### 6. Type-check

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
npx --no-install tsc --noEmit
```

Fix only in-scope helper errors, then execute the shared compatibility contract's
Step 4. Recheck requested capture/normalization/storage behavior, including user
cancellation, missing native module, capture failure, and Image versus File payloads.
Type-check success alone is insufficient; do not fix screen/generated files.

This does not constitute native device validation.

### 7. Native rebuild note

This skill does not install native code or run local native builds. An
out-of-band package addition is a compatibility block. Use a separately approved
verified-release migration; Metro updates only JavaScript, not native modules.

### 8. Do not use HostingSDK / PCF

Do not import or register:

```ts
import { PenInputExtension } from "@microsoft/power-apps-native-pen-input";
```

Do not wire Companion PCF or `PenInputExtension`. In Power Apps native code apps, use the native React Native API above.

### 9. Summary

Return the shared compatibility result and actual created/updated/reused paths
before this summary. Report owner-side save/integration separately; update
memory-bank only after success, and leave final updates to the owner when orchestrated.

Tell the user:

```text
Pen input added
Release / package : <resolved release and selected package/version>
Wrapper           : src/native/penInput.ts
Output            : PNG data URI
Type-check        : PASS
Native rebuild    : not performed by this skill
Usage             : captureSignature(...)
HostingSDK / PCF  : not used
```

Update `memory-bank.md` under `Controls`:

```text
- Pen input wrapper added — <resolved release + selected import/version> (<ISO date>); native device validation: <performed / not performed>
```
