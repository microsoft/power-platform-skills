---
name: add-pdf-viewer
description: Internal implementation skill invoked by /add-native for native PDF control workflows. Handles HTTPS-only PDF viewing with @microsoft/power-apps-native-pdf-viewer.
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../../shared/shared-instructions.md)** — read first.

# Add PDF Viewer

**Internal helper.** Users should invoke `/add-native pdf-viewer`, `/add-native pdf-control`, or `/add-native @microsoft/power-apps-native-pdf-viewer`; `/add-native` routes here after resolving the capability.

Generate or verify the native PDF viewer wrapper and show how to call its **native React Native API**. This skill supports HTTPS PDF URLs only. Do not use the HostingSDK / PCF path from the package README; that is for a different use case.

## Steps

### 1. Verify app

```bash
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src
```

If this fails, tell the user to run `/create-mobile-app` first and STOP.

### 2. Verify package is already present

```bash
node -e "const p=require('./package.json'); const m='@microsoft/power-apps-native-pdf-viewer'; if (!p.dependencies?.[m]) { console.error('MISSING: ' + m + ' is not in package.json. The template/app must already ship this native extension. This skill will not install it or edit native config.'); process.exit(1); } console.log('OK: native PDF viewer package present');"
```

If the check fails, STOP. Do not run `npm install`, `npx expo install`, `pod install`, or edit `app.config.js`. This package contains native iOS/Android code and must already be part of the app's native build.

### 3. Write or verify `src/native/pdfViewer.ts`

Create `src/native/pdfViewer.ts` if it does not exist. If it already exists, inspect it and patch only if it violates the HTTPS-only rule or throws instead of returning a result.

The wrapper MUST:

- Accept only `https://` URLs.
- Reject `file://`, `content://`, `blob:`, `http://`, empty, and malformed URLs before calling native code.
- Return a discriminated union and never throw.
- Return `NATIVE_MODULE_MISSING` when the extension is installed in JS but unavailable in the native build.
- Surface viewer action results (`shared`, `printed`, `dismissed`) when available.
- Return `VIEWER_FAILED` for native errors not covered by validation/module checks.

```ts
// src/native/pdfViewer.ts
import { NativePdfViewer } from '@microsoft/power-apps-native-pdf-viewer';

export type PdfViewerResult =
  | { ok: true; action?: 'shared' | 'printed' | 'dismissed' }
  | { ok: false; reason: 'INVALID_URL' | 'NATIVE_MODULE_MISSING' | 'VIEWER_FAILED'; message?: string };

export async function openHttpsPdf(
  url: string,
  options?: { title?: string; maxFileSizeMb?: number; cacheEnabled?: boolean },
): Promise<PdfViewerResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'INVALID_URL', message: 'PDF URL must be a valid HTTPS URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'INVALID_URL', message: 'Native PDF viewer supports HTTPS PDF URLs only.' };
  }

  if (!NativePdfViewer?.openPdf) {
    return { ok: false, reason: 'NATIVE_MODULE_MISSING', message: 'Native PDF viewer module is not available in this build.' };
  }

  try {
    const response = await NativePdfViewer.openPdf(url, {
      maxFileSizeMb: 50,
      cacheEnabled: true,
      ...options,
    });

    if (response.status === 'ok') {
      return { ok: true, action: response.result?.action };
    }

    return { ok: false, reason: 'VIEWER_FAILED', message: response.message ?? response.error };
  } catch (error: any) {
    return { ok: false, reason: 'VIEWER_FAILED', message: error?.message ?? String(error) };
  }
}
```

### 4. Use the wrapper

Screens import the wrapper, not the native package directly:

```ts
import { openHttpsPdf } from '@/native/pdfViewer';

const response = await openHttpsPdf('https://example.com/report.pdf', {
  title: "Inspection report",
});

if (response.ok) {
  switch (response.action) {
    case "shared":
      // User completed native Share.
      break;
    case "printed":
      // User completed native Print.
      break;
    case "dismissed":
      // User closed the viewer.
      break;
  }
} else {
  console.warn("Failed to open PDF:", response.reason, response.message);
}
```

Notes:
- URLs must be `https://`. Local `file://`, `content://`, and `blob:` URIs are not supported by this skill.
- Use `@microsoft/power-apps-native-pdf-viewer` only for this native HTTPS PDF viewing use case.
- Use `expo-document-picker` for picking/importing/uploading a local PDF or document.
- Use `/add-native pdf-report` for generated local PDFs. That helper requires `expo-print` and adds local share/open behavior only when `expo-sharing` is already present.
- Generated local PDFs from `expo-print` must either open through the `pdfReport` share wrapper when `expo-sharing` is present, or be uploaded to Dataverse File storage first and viewed later through a supported HTTPS URL if one is available.
- Share and Print are built into the native viewer; there are no separate JS share/print calls.
- The wrapper returns `{ ok: true } | { ok: false }`; handle every non-ok reason in UI.

### 5. Type-check

```bash
npx tsc --noEmit
```

Fix any TypeScript errors before rebuilding.

### 6. Native rebuild note

This skill does not install native code. If the package was just added outside the skill, the app needs a native rebuild outside this workflow. If the package was already in the build, Metro hot reload is enough for wrapper edits.

### 7. Do not use HostingSDK / PCF

Do not import or register:

```ts
import NativePdfViewerExtension from "@microsoft/power-apps-native-pdf-viewer";
```

Do not wire Companion PCF or `NativePdfViewerExtension`. In Power Apps native code apps, use the native React Native API above.

### 8. Summary

Tell the user:

```text
PDF viewer added
Package present   : @microsoft/power-apps-native-pdf-viewer
Wrapper           : src/native/pdfViewer.ts
URL support       : HTTPS only
Type-check        : PASS
Native rebuild    : not performed by this skill
Usage             : openHttpsPdf(...)
HostingSDK / PCF  : not used
```

Update `memory-bank.md` under `Controls`:

```text
- PDF viewer added — @microsoft/power-apps-native-pdf-viewer (<ISO date>)
```
