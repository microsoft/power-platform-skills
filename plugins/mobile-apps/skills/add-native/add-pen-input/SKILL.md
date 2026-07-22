---
name: add-pen-input
description: Internal implementation skill invoked by /add-native for pen, signature, ink, drawing, and handwriting capture workflows using @microsoft/power-apps-native-pen-input.
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../../shared/shared-instructions.md)** — read first.

# Add Pen Input

**Internal helper.** Users should invoke `/add-native pen-input`, `/add-native signature`, or `/add-native @microsoft/power-apps-native-pen-input`; `/add-native` routes here after resolving the capability.

Generate or verify the native pen input wrapper and show how to call its **native React Native API**. Do not use the HostingSDK / PCF path from the package README; that is for a different use case.

## Steps

### 1. Verify app

```bash
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src
```

If this fails, tell the user to run `/create-mobile-app` first and STOP.

### 2. Verify package is already present

```bash
node -e "const p=require('./package.json'); const m='@microsoft/power-apps-native-pen-input'; if (!p.dependencies?.[m]) { console.error('MISSING: ' + m + ' is not in package.json. The template/app must already ship this native extension. This skill will not install it or edit native config.'); process.exit(1); } console.log('OK: pen input package present');"
```

If the check fails, STOP. Do not run `npm install`, `npx expo install`, `pod install`, or edit `app.config.js`. This package contains native iOS/Android code and must already be part of the app's native build.

### 3. Write or verify `src/native/penInput.ts`

Create `src/native/penInput.ts` if it does not exist. If it already exists, inspect it and patch only if cancellation is treated as an error or the wrapper can throw.

The wrapper MUST:

- Return a discriminated union and never throw.
- Return `{ ok: false, reason: 'USER_CANCELLED' }` for user cancellation; this is a non-error path.
- Return `NATIVE_MODULE_MISSING` when the extension is installed in JS but unavailable in the native build.
- Return a PNG data URI (`data:image/png;base64,...`) on success.

```ts
// src/native/penInput.ts
import {
  PenInputNative,
  PenInputStatus,
  PenInputErrorCode,
} from '@microsoft/power-apps-native-pen-input';

export type PenInputResult =
  | { ok: true; dataUri: string }
  | { ok: false; reason: 'USER_CANCELLED' | 'NATIVE_MODULE_MISSING' | 'CAPTURE_FAILED'; message?: string };

export async function captureSignature(options?: {
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
}): Promise<PenInputResult> {
  if (!PenInputNative?.capturePenInput) {
    return { ok: false, reason: 'NATIVE_MODULE_MISSING', message: 'Pen input module is not available in this build.' };
  }

  try {
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
- Use `@microsoft/power-apps-native-pen-input` only for native freehand drawing, ink, handwriting, and signature capture. For unrelated native use cases, use the relevant Expo module or other dependency already present in `package.json`.

### 5. Optional Dataverse save

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
npx tsc --noEmit
```

Fix any TypeScript errors before rebuilding.

### 7. Native rebuild note

This skill does not install native code. If the package was just added outside the skill, the app needs a native rebuild outside this workflow. If the package was already in the build, Metro hot reload is enough for wrapper edits.

### 8. Do not use HostingSDK / PCF

Do not import or register:

```ts
import { PenInputExtension } from "@microsoft/power-apps-native-pen-input";
```

Do not wire Companion PCF or `PenInputExtension`. In Power Apps native code apps, use the native React Native API above.

### 9. Summary

Tell the user:

```text
Pen input added
Package present   : @microsoft/power-apps-native-pen-input
Wrapper           : src/native/penInput.ts
Output            : PNG data URI
Type-check        : PASS
Native rebuild    : not performed by this skill
Usage             : captureSignature(...)
HostingSDK / PCF  : not used
```

Update `memory-bank.md` under `Controls`:

```text
- Pen input added — @microsoft/power-apps-native-pen-input (<ISO date>)
```
