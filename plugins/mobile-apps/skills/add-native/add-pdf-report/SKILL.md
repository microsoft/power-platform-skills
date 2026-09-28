---
name: add-pdf-report
description: Internal implementation skill invoked by /add-native for app-generated PDF report workflows using expo-print and, when present, expo-sharing.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - read first.

**Working directory:** before any project read or command, execute
[native-artifact-compatibility.md Step 0](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md#0-bind-every-operation-to-the-app-root).
Inherit `/add-native`'s resolved absolute `working_dir`; bind every shell call and
file tool to it, even when this helper starts from another directory.

# Add PDF Report

**Internal helper.** Users should invoke `/add-native pdf-report`, `/add-native generate-pdf`, or `/add-native pdf-export`; `/add-native` routes here after resolving the capability.

Generate or verify a local PDF report wrapper for app-owned PDFs created from records, evidence, certificates, receipts, or summaries. This helper uses `expo-print` to create a local PDF file URI. It may use `expo-sharing` only when that package is already present. It never installs packages or imports the native PDF viewer directly.

## Capability boundaries

| User need | Correct path |
|---|---|
| Generate/export/print a report from app data | This helper: `expo-print` -> local PDF URI |
| Share the generated local PDF from the device | Add share method only if `expo-sharing` is already in `package.json` |
| Retain the generated PDF in Dataverse | Create/update parent row first, then upload to a Dataverse File column with generated services |
| Open an existing HTTPS or local file PDF in the Power Apps native viewer | `/add-native pdf-viewer`, only if `@microsoft/power-apps-native-pdf-viewer` 0.2.9+ is already present |
| Pick/import/upload a user-selected PDF | `/add-native document-picker` or host `<FilePicker>` for Dataverse File columns |

Local generated PDFs are usually `file://` URIs and can be passed to `openHttpsPdf(...)` with `@microsoft/power-apps-native-pdf-viewer` 0.2.9+.

## Steps

### 1. Verify app

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src || { echo "BLOCKED: working_dir is not an initialized app" >&2; exit 1; }
```

If this fails, tell the user to run `/create-mobile-app` first and STOP.

### 2. Verify packages are already present

`expo-print` is required. `expo-sharing` is optional unless the plan specifically needs sharing behavior.

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node -e "const p=require('./package.json'); const deps={...p.dependencies,...p.devDependencies}; const required='expo-print'; if (!deps[required]) { console.error('MISSING: expo-print is not in package.json. The template/app must already ship it for /add-native pdf-report. This skill will not install it or edit native config. Capability not added.'); process.exit(1); } console.log('OK: expo-print package present'); console.log(deps['expo-sharing'] ? 'OK: expo-sharing package present' : 'OPTIONAL_MISSING: expo-sharing is not in package.json; generated PDFs can be created/viewed/uploaded, but sharing helpers must not be generated.');"
```

If `expo-print` is missing, STOP. Do not run `npm install`, `npx expo install`, `pod install`, or edit `app.config.js`. Do not add `pdf-report` to the plan or generated wrappers for this app.

If `expo-sharing` is missing:

- Continue for generate-only, native-viewer preview, or Dataverse-upload flows.
- Do not import `expo-sharing`.
- Do not generate `sharePdfReport(...)`.
- If the user's requirement specifically includes sharing, STOP and say sharing is not supported by this template.

### 2a. Reconcile requested artifacts

Read and execute [native-artifact-compatibility.md](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md)
Steps 1–3 for the PDF report row before any writes or reuse. Inherit the current
approval/mode from `/add-native`; do not repeat a valid scoped approval.
Inspect `src/native/pdfReport.ts` for the full requested API: `createPdfReport`,
`wrapPdfDocument`, `escapePdfHtml`, requested `includeBase64` output for retention,
and `sharePdfReport`/`PdfShareResult` when sharing is approved. Generate-only
compatibility does not satisfy a share/upload request. Verify local-file and
generated File-service payload requirements; missing required storage or an
incompatible artifact outside approval returns `NEEDS_CONTEXT` to the owner, or
asks standalone.

### 3. Write or verify `src/native/pdfReport.ts`

Apply Step 2a's decision for `src/native/pdfReport.ts`: create when requested and
missing, reuse unchanged only if compatible, or make only the approved scoped
update. Preserve custom HTML logic and existing exports; the example is not an
overwrite template.

The wrapper MUST:

- Import `expo-print` only after Step 2 confirms it is present.
- Import `expo-sharing` only when Step 2 confirms it is present.
- Return discriminated unions and never throw.
- Treat generated local PDFs as local files for view/share/upload flows.
- Never import `@microsoft/power-apps-native-pdf-viewer` directly from this wrapper.
- Keep HTML generation deterministic and app-owned; do not fetch remote HTML inside the wrapper.

Base wrapper when sharing is requested and `expo-sharing` is present:

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

For a new generate-only wrapper (or when `expo-sharing` is absent), omit the
`expo-sharing` import, `PdfShareResult`, and `sharePdfReport(...)`. Keep
`createPdfReport(...)`, `wrapPdfDocument(...)`, and `escapePdfHtml(...)`. Do not
remove compatible existing share exports merely because sharing is not requested
this time; any incompatible existing import follows Step 2a's scoped-update gate.

### 4. Use the wrapper

Integration guidance for the owner, not instructions to edit screens here.
Screens import the wrapper, not Expo modules directly. This example includes
sharing only when approved and available:

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

If `expo-sharing` is absent, screens may still call `createPdfReport(...)`, preview the returned `file://` URI through native PDF viewer 0.2.9+, or upload it to a Dataverse File column through generated services. They must not render a Share button.

### 5. Optional Dataverse upload

Optional means unrequested, not skippable when retention is approved. Step 2a
verifies wrapper payload support and the generated signature; the owner supplies
the app-specific adapter/screen integration below. Return missing helper-owned
support or unknown required storage as `NEEDS_CONTEXT`, not a capture-only success.

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
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
npx tsc --noEmit
```

Fix only in-scope helper errors, then execute the shared compatibility contract's
Step 4. Recheck requested generation, sharing, and retention payloads, including
empty HTML, unavailable sharing, print/share failures, and absent required base64.
Type-check success alone is insufficient; do not fix screen/generated files.

### 7. Native rebuild note

This skill does not install native code. If `expo-print` or `expo-sharing` was just added outside the skill, the app needs a native rebuild outside this workflow. If the packages were already in the build, Metro hot reload is enough for wrapper edits.

### 8. Summary

Return the shared compatibility result and actual created/updated/reused paths
before this summary. Report owner-side upload/integration separately; update
memory-bank only after success, and leave final updates to the owner when orchestrated.

Tell the user:

```text
PDF report helper added
Required package : expo-print
Optional share   : expo-sharing <present | absent>
Wrapper          : src/native/pdfReport.ts
Output           : local PDF file URI
Native viewer    : optional; 0.2.9+ can open the generated file:// URI
Type-check       : PASS
Native rebuild   : not performed by this skill
```

Update `memory-bank.md` under `Controls`:

```text
- PDF report helper added - expo-print local generation, expo-sharing <present|absent> (<ISO date>)
```