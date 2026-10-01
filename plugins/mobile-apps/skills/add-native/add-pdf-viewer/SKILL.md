---
name: add-pdf-viewer
description: Internal implementation skill invoked by /add-native for native PDF viewing through release-matched controls or legacy PDF leaf APIs.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

# Add PDF Viewer

**Internal helper.** Users should invoke `/add-native pdf-viewer`, `/add-native pdf-control`, or `/add-native @microsoft/power-apps-native-pdf-viewer`; `/add-native` routes here after resolving the capability.

Generate or verify the native PDF viewer wrapper and show how to call its **native React Native API**. Version 0.2.9 and later support HTTPS PDF URLs and local `file://` URIs. Do not use the HostingSDK / PCF path from the package README; that is for a different use case.

## Steps

### 1. Verify app

```bash
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src
```

If this fails, tell the user to run `/create-mobile-app` first and STOP.

### 2. Verify the app-matched release and import path

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"
```

Read [release lifecycle](../../../shared/references/mobile-release-lifecycle.md)
and [native controls](../references/native-controls.md). If resolution fails,
STOP before writing wrappers. Do not install packages, run local native builds,
or edit native config. Check installed docs/types against the resolved native
inventory; file URI support requires the PDF 0.2.9+ contract in the binary.

The example below is conditional on a verified release containing
`@microsoft/power-apps-native-controls/pdf`. For a verified legacy release,
replace only the literal import with `@microsoft/power-apps-native-pdf-viewer`
after confirming that exact leaf/version is included. Do not import the root
aggregate or emit a runtime fallback between packages.

### 3. Write or verify `src/native/pdfViewer.ts`

Create `src/native/pdfViewer.ts` if it does not exist. If it already exists, inspect it and patch only if it violates the supported URI rules or throws instead of returning a result.

The wrapper MUST:

- Accept `https://` URLs and `file://` URIs.
- Reject `content://`, `blob:`, `http://`, empty, and malformed URLs before calling native code.
- Return a discriminated union and never throw.
- Return `NATIVE_MODULE_MISSING` when the extension is installed in JS but unavailable in the native build.
- Surface viewer action results (`shared`, `printed`, `dismissed`) when available.
- Return `VIEWER_FAILED` for native errors not covered by validation/module checks.

```ts
// src/native/pdfViewer.ts
import { Platform } from 'react-native';

export type PdfViewerResult =
  | { ok: true; action?: 'shared' | 'printed' | 'dismissed' }
  | { ok: false; reason: 'UNSUPPORTED_PLATFORM' | 'INVALID_URL' | 'NATIVE_MODULE_MISSING' | 'VIEWER_FAILED'; message?: string };

export async function openHttpsPdf(
  url: string,
  options?: { title?: string; maxFileSizeMb?: number; cacheEnabled?: boolean },
): Promise<PdfViewerResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { ok: false, reason: 'UNSUPPORTED_PLATFORM' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'INVALID_URL', message: 'PDF location must be a valid https:// URL or file:// URI.' };
  }

  const isHttpsUrl = parsed.protocol === 'https:';
  const isFileUri = parsed.protocol === 'file:' && url.startsWith('file://') && parsed.pathname !== '/';
  if (!isHttpsUrl && !isFileUri) {
    return { ok: false, reason: 'INVALID_URL', message: 'Native PDF viewer supports https:// and file:// inputs only.' };
  }

  try {
    const { NativePdfViewer } = await import('@microsoft/power-apps-native-controls/pdf');
    if (!NativePdfViewer?.openPdf) {
      return { ok: false, reason: 'NATIVE_MODULE_MISSING' };
    }
    const response = await NativePdfViewer.openPdf(url, {
      maxFileSizeMb: 50,
      cacheEnabled: true,
      ...options,
    });

    if (response.status === 'ok') {
      return { ok: true, action: response.result?.action };
    }

    if (response.error === 'NATIVE_MODULE_MISSING') {
      return { ok: false, reason: 'NATIVE_MODULE_MISSING' };
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
- URLs must use `https://` or a non-empty `file://` URI. `content://`, `blob:`, and `http://` are not supported by this skill.
- Use the selected `/pdf` or verified legacy PDF import only for native PDF viewing.
- Use `expo-document-picker` for picking/importing/uploading a local PDF or document.
- Use `/add-native pdf-report` for generated local PDFs. That helper requires `expo-print` and adds sharing behavior only when `expo-sharing` is already present.
- Generated local PDFs from `expo-print` may be opened by native PDF viewer 0.2.9+ as `file://` URIs.
- Share and Print are built into the native viewer; there are no separate JS share/print calls.
- The wrapper returns `{ ok: true } | { ok: false }`; handle every non-ok reason in UI.

### 5. Type-check

```bash
npx --no-install tsc --noEmit
```

Fix wrapper TypeScript errors; this is not native device validation.

### 6. Native rebuild note

This skill does not install native code or run local native builds. An
out-of-band package addition is a compatibility block, not proof of support.
Use a separately approved verified-release migration; Metro updates only JS.

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
Release / package : <resolved release and selected package/version>
Wrapper           : src/native/pdfViewer.ts
URL support       : HTTPS and file:// (0.2.9+)
Type-check        : PASS
Native rebuild    : not performed by this skill
Usage             : openHttpsPdf(...)
HostingSDK / PCF  : not used
```

Update `memory-bank.md` under `Controls`:

```text
- PDF viewer wrapper added — <resolved release + selected import/version> (<ISO date>); native device validation: <performed / not performed>
```
