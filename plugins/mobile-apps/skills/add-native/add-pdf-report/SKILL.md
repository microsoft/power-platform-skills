---
name: add-pdf-report
description: Internal implementation skill invoked by /add-native for app-generated PDF report workflows using expo-print and, when present, expo-sharing.
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../../shared/shared-instructions.md)** - read first.

# Add PDF Report

**Internal helper.** Users should invoke `/add-native pdf-report`, `/add-native generate-pdf`, or `/add-native pdf-export`; `/add-native` routes here after resolving the capability.

Generate or verify a local PDF report wrapper for app-owned PDFs created from records, evidence, certificates, receipts, or summaries. This helper uses `expo-print` to create a local PDF file URI. It may use `expo-sharing` only when that package is already present. It never installs packages and never routes local PDF URIs to the native PDF viewer.

## Capability boundaries

| User need | Correct path |
|---|---|
| Generate/export/print a report from app data | This helper: `expo-print` -> local PDF URI |
| Share/open the generated local PDF from the device | Add share method only if `expo-sharing` is already in `package.json` |
| Retain the generated PDF in Dataverse | Create/update parent row first, then upload to a Dataverse File column with generated services |
| Open an existing HTTPS PDF URL in the Power Apps native viewer | `/add-native pdf-viewer`, only if `@microsoft/power-apps-native-pdf-viewer` is already present |
| Pick/import/upload a user-selected PDF | `/add-native document-picker` or host `<FilePicker>` for Dataverse File columns |

Local generated PDFs are usually `file://` URIs. They are not valid input for `openHttpsPdf(...)` and must not be passed to `@microsoft/power-apps-native-pdf-viewer`.

## Steps

### 1. Verify app

```bash
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src
```

If this fails, tell the user to run `/create-mobile-app` first and STOP.

### 2. Verify packages are already present

`expo-print` is required. `expo-sharing` is optional unless the plan specifically needs local share/open behavior.

```bash
node -e "const p=require('./package.json'); const deps={...p.dependencies,...p.devDependencies}; const required='expo-print'; if (!deps[required]) { console.error('MISSING: expo-print is not in package.json. The template/app must already ship it for /add-native pdf-report. This skill will not install it or edit native config. Capability not added.'); process.exit(1); } console.log('OK: expo-print package present'); console.log(deps['expo-sharing'] ? 'OK: expo-sharing package present' : 'OPTIONAL_MISSING: expo-sharing is not in package.json; generated PDFs can be created/uploaded, but local share/open helpers must not be generated.');"
```

If `expo-print` is missing, STOP. Do not run `npm install`, `npx expo install`, `pod install`, or edit `app.config.js`. Do not add `pdf-report` to the plan or generated wrappers for this app.

If `expo-sharing` is missing:

- Continue only for generate-only or Dataverse-upload flows.
- Do not import `expo-sharing`.
- Do not generate `sharePdfReport(...)`.
- If the user's requirement is specifically local share/open and there is no Dataverse upload alternative, STOP and say the requested share/open behavior is not supported by this template.

### 3. Write or verify `src/native/pdfReport.ts`

Create `src/native/pdfReport.ts` if it does not exist. If it already exists, inspect it and patch only if it throws instead of returning a result, imports missing packages, or routes local URIs to the native PDF viewer.

The wrapper MUST:

- Import `expo-print` only after Step 2 confirms it is present.
- Import `expo-sharing` only when Step 2 confirms it is present.
- Return discriminated unions and never throw.
- Treat generated local PDFs as local files for share/upload only.
- Never call `openHttpsPdf(...)` or import `@microsoft/power-apps-native-pdf-viewer`.
- Keep HTML generation deterministic and app-owned; do not fetch remote HTML inside the wrapper.

Base wrapper when `expo-sharing` is present:

```ts
// src/native/pdfReport.ts
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

export type PdfReportResult =
  | { ok: true; uri: string; numberOfPages?: number; base64?: string }
  | { ok: false; reason: 'EMPTY_HTML' | 'PRINT_FAILED'; message?: string };

export type PdfShareResult =
  | { ok: true }
  | { ok: false; reason: 'INVALID_URI' | 'SHARING_UNAVAILABLE' | 'SHARE_FAILED'; message?: string };

export function escapePdfHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function wrapPdfDocument(input: { title: string; bodyHtml: string; styles?: string }): string {
  const title = escapePdfHtml(input.title.trim() || 'Report');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #111827; }
      h1, h2, h3 { margin: 0 0 12px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; }
      ${input.styles ?? ''}
    </style>
  </head>
  <body>${input.bodyHtml}</body>
</html>`;
}

export async function createPdfReport(
  html: string,
  options?: { includeBase64?: boolean },
): Promise<PdfReportResult> {
  if (!html.trim()) {
    return { ok: false, reason: 'EMPTY_HTML', message: 'PDF report HTML is empty.' };
  }

  try {
    const result = await Print.printToFileAsync({
      html,
      base64: options?.includeBase64 ?? false,
    });

    return {
      ok: true,
      uri: result.uri,
      numberOfPages: result.numberOfPages,
      base64: result.base64,
    };
  } catch (error: any) {
    return { ok: false, reason: 'PRINT_FAILED', message: error?.message ?? String(error) };
  }
}

export async function sharePdfReport(uri: string, options?: { dialogTitle?: string }): Promise<PdfShareResult> {
  if (!uri || !uri.startsWith('file://')) {
    return { ok: false, reason: 'INVALID_URI', message: 'Generated PDF reports must be shared from a local file URI.' };
  }

  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      return { ok: false, reason: 'SHARING_UNAVAILABLE', message: 'Sharing is not available on this platform.' };
    }

    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: options?.dialogTitle ?? 'Share PDF report',
    });

    return { ok: true };
  } catch (error: any) {
    return { ok: false, reason: 'SHARE_FAILED', message: error?.message ?? String(error) };
  }
}
```

When `expo-sharing` is absent, generate the same file without the `expo-sharing` import, without `PdfShareResult`, and without `sharePdfReport(...)`. Keep `createPdfReport(...)`, `wrapPdfDocument(...)`, and `escapePdfHtml(...)`.

### 4. Use the wrapper

Screens import the wrapper, not Expo modules directly:

```ts
import { createPdfReport, escapePdfHtml, sharePdfReport, wrapPdfDocument } from '@/native/pdfReport';

const html = wrapPdfDocument({
  title: 'Inspection report',
  bodyHtml: `<h1>Inspection report</h1><p>${escapePdfHtml(summary)}</p>`,
});

const report = await createPdfReport(html);
if (!report.ok) {
  showError(report.message ?? 'Report PDF was not generated.');
  return;
}

const share = await sharePdfReport(report.uri, { dialogTitle: 'Share inspection report' });
if (!share.ok) {
  showError(share.message ?? 'Report PDF was generated but could not be shared.');
}
```

If `expo-sharing` is absent, screens may still call `createPdfReport(...)` and then upload the generated PDF to a Dataverse File column through generated services. They must not render a local Share/Open button unless another supported app-specific path exists.

### 5. Optional Dataverse upload

Retained PDFs use Dataverse File columns. Save or update the parent row first, verify `success`, then upload a payload compatible with the generated service's `upload(id, columnName, file, fileDisplayName?)` signature. Never put File column bytes in create/update JSON.

```ts
const save = await Cr123_inspectionService.update(inspectionId, {
  cr123_reportgeneratedat: new Date().toISOString(),
});

if (!save.success) {
  showError(save.error?.message ?? 'Inspection was not saved.');
  return;
}

const report = await createPdfReport(html, { includeBase64: true });
if (!report.ok) {
  showError(report.message ?? 'Report PDF was not generated.');
  return;
}

if (!report.base64) {
  showError('Report PDF was generated but could not be prepared for upload.');
  return;
}

// Convert report.base64 into the File/blob/picked-file shape expected by the generated service.
// Do not pass report.uri unless the generated service explicitly documents URI support.
const reportFile = createUploadFileFromBase64(report.base64, 'inspection-report.pdf', 'application/pdf');

const upload = await Cr123_inspectionService.upload(
  inspectionId,
  'cr123_reportfile',
  reportFile,
  'inspection-report.pdf',
);
if (!upload.success) {
  showError(upload.error?.message ?? 'Report PDF was not uploaded.');
}
```

`createUploadFileFromBase64(...)` is intentionally app-specific because generated upload helpers may expect a browser `File`, a host `PickedFileInfo`, bytes, or another service-specific payload shape. Use the model/service types generated for that table and do not edit generated services.

### 6. Type-check

```bash
npx tsc --noEmit
```

Fix any TypeScript errors before rebuilding.

### 7. Native rebuild note

This skill does not install native code. If `expo-print` or `expo-sharing` was just added outside the skill, the app needs a native rebuild outside this workflow. If the packages were already in the build, Metro hot reload is enough for wrapper edits.

### 8. Summary

Tell the user:

```text
PDF report helper added
Required package : expo-print
Optional share   : expo-sharing <present | absent>
Wrapper          : src/native/pdfReport.ts
Output           : local PDF file URI
Native viewer    : not used; generated local URIs are not HTTPS viewer input
Type-check       : PASS
Native rebuild   : not performed by this skill
```

Update `memory-bank.md` under `Controls`:

```text
- PDF report helper added - expo-print local generation, expo-sharing <present|absent> (<ISO date>)
```