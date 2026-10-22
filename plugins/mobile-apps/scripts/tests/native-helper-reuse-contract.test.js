'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
// Contracts are prose, so Git's LF/CRLF checkout setting must not change their meaning.
const normalize = (text) => text.replace(/\r\n?/g, '\n');
const read = (file) => normalize(fs.readFileSync(path.join(pluginRoot, file), 'utf8'));
const referencePath = 'shared/references/native-artifact-compatibility.md';
const reference = read(referencePath);
const native = read('skills/add-native/SKILL.md');
const helpers = [
  {
    name: 'add-camera',
    reconcile: '### Step 2a — Reconcile requested artifacts',
    writes: [
      '### Step 3 — Write camera wrapper',
      '### Step 3b — Write barcode/QR scanner control when requested',
      '### Step 5 — Write image upload helper',
    ],
    verify: '### Step 6 — Type-check',
    summary: '### Step 7 — Summary',
    files: ['camera.ts', 'barcodeScanner.tsx', 'cameraUpload.ts'],
  },
  ...[
    ['add-pdf-report', 'pdfReport.ts', 6, 8],
    ['add-pdf-viewer', 'pdfViewer.ts', 5, 8],
    ['add-pen-input', 'penInput.ts', 6, 9],
  ].map(([name, file, verify, summary]) => ({
    name,
    reconcile: '### 2a. Reconcile requested artifacts',
    writes: [`### 3. Write or verify \`src/native/${file}\``],
    verify: `### ${verify}. Type-check`,
    summary: `### ${summary}. Summary`,
    files: [file],
  })),
  {
    name: 'add-geolocation',
    reconcile: '## 2a. Reconcile requested artifacts',
    writes: ['## 3. Write `src/native/geolocation.ts`'],
    verify: '## 5. Type-check and summary',
    files: ['geolocation.ts'],
  },
];
const skill = (name) => read(`skills/add-native/${name}/SKILL.md`);

function section(text, heading) {
  const start = text.indexOf(`${heading}\n`);
  assert.ok(start >= 0, `Missing section: ${heading}`);
  const rest = text.slice(start + heading.length + 1);
  const next = rest.search(/^#{2,3} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

function prose(text) {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
}

// These are instruction-contract regressions, not model runs or native-runtime tests.
// Check the invoked preflight, each actual write branch, and the postflight together:
// a correct outer paragraph must not mask an unchecked nested implementation.
function assertHelperContract(raw, helper) {
  const text = normalize(raw);
  const gate = section(text, helper.reconcile);
  assert.match(gate, /Read and execute \[native-artifact-compatibility\.md\]/);
  assert.ok(gate.includes(`(\${PLUGIN_ROOT}/${referencePath})`));
  assert.match(gate, /Steps 1–3/);
  assert.match(gate, /before any writes or reuse/);
  assert.match(gate, /do not repeat a valid scoped approval/);
  assert.match(gate, /`NEEDS_CONTEXT` to\s+the owner/);
  assert.match(gate, /asks standalone/);
  for (const file of helper.files) {
    assert.ok(gate.includes(`src/native/${file}`), `${helper.name} must inventory ${file}`);
  }
  for (const heading of helper.writes) {
    assert.ok(text.indexOf(helper.reconcile) < text.indexOf(heading), 'Reconcile before each write');
    const write = prose(section(text, heading));
    assert.match(write, /Apply Step 2a's (?:independent )?decision/);
    assert.match(write, /reuse unchanged only if compatible/);
    assert.match(write, /approved scoped\s+update/);
  }
  assert.doesNotMatch(
    prose(text),
    /If (?:the (?:file|wrapper)|it) (?:already )?exists[^\n]*(?:skip|do not overwrite|do NOT overwrite|patch only if)/i,
  );
  assert.doesNotMatch(prose(text), /append a comment noting|Create or patch `src\/native\//);
  const verification = section(text, helper.verify);
  assert.match(verification, /shared compatibility contract's\s+Step 4/);
  assert.match(verification, /Type-check success alone is insufficient/);
  assert.match(verification, /do not fix screen\/generated\s+files/i);
  const result = helper.summary ? section(text, helper.summary) : verification;
  assert.match(result, /shared compatibility result/);
  assert.match(result, /created\/updated\/reused paths/);
}

for (const helper of helpers) {
  const content = skill(helper.name);
  for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`${helper.name} reconciles every output before writes and success (${name})`, () => {
      assertHelperContract(content.replace(/\n/g, eol), helper);
    });
  }

  test(`${helper.name} rejects bypasses and restored existence-only branches`, () => {
    assert.throws(() => assertHelperContract(
      content.replace('Read and execute [native-artifact-compatibility.md]', 'Optionally read the reference'),
      helper,
    ));
    const gate = `${helper.reconcile}\n${section(content, helper.reconcile)}`;
    assert.throws(() => assertHelperContract(
      content.replace(gate, '') + `\n${gate}`,
      helper,
    ), 'A check moved after generation must not count as preflight');
    for (const write of helper.writes) {
      assert.throws(() => assertHelperContract(
        content.replace(`${write}\n`, `${write}\nIf the file already exists, skip this step.\n`),
        helper,
      ), `Existence-only reuse in ${write} must be rejected`);
      assert.throws(() => assertHelperContract(
        content.replace(section(content, write), 'Create or patch the file.\n\n'),
        helper,
      ), `The actual ${write} branch must apply reconciliation`);
    }
    assert.throws(() => assertHelperContract(
      content.replace("shared compatibility contract's Step 4", 'type-check only')
        .replace("shared compatibility contract's\nStep 4", 'type-check only'),
      helper,
    ), 'Compilation alone must not satisfy the result gate');
  });
}

test('dedicated dispatch forwards scope and returns failures instead of falling through', () => {
  const dispatch = section(native, '### Step 3 — Route to nested helpers or inline wrappers');
  assert.match(dispatch, /working_dir.*arguments, supplied answers, mode flags/s);
  assert.match(dispatch, /current owner\/phase\/`approved_scope`/);
  assert.match(dispatch, /Each helper must execute/);
  assert.match(dispatch, /before its writes\/reuse and before its success summary/);
  assert.match(dispatch, /outer Step 5 is not\s+reached/);
  assert.match(dispatch, /Propagate `NEEDS_CONTEXT`\/`BLOCKED`/);
  assert.match(dispatch, /STOP this leaf, not the owning workflow/);
  assert.match(dispatch, /Do not\s+fall through to inline generation or report success for a partial helper result/);
  const inline = section(native, '### Step 5 — Write wrapper');
  assert.match(inline, /Read and execute \[native-artifact-compatibility\.md\]/);
  assert.match(inline, /scoped update without re-asking when already approved/);
  assert.match(inline, /`NEEDS_CONTEXT` to the owner \(or ask standalone\)/);
});

function decision(text, label) {
  const decisions = section(text, '## 3. Apply the reconciliation decisions');
  const start = decisions.indexOf(`- **${label}:**`);
  assert.ok(start >= 0, `Missing decision: ${label}`);
  const rest = decisions.slice(start);
  const end = rest.indexOf('\n- **', 1);
  return end < 0 ? rest : rest.slice(0, end);
}

function assertDecisions(text) {
  const compatible = decision(text, 'Compatible');
  assert.match(compatible, /reuse unchanged, including custom code/);
  assert.match(compatible, /do not append a\s+regeneration comment or rewrite/);
  const missing = decision(text, 'Missing and in scope');
  assert.match(missing, /create only that requested artifact/);
  assert.match(missing, /partial set,\s+keep compatible siblings unchanged/);
  assert.match(missing, /missing scanner\/upload helper does not\s+authorize regenerating/);
  const approved = decision(text, 'Incompatible and update already approved');
  assert.match(approved, /smallest scoped update/);
  assert.match(approved, /preserving unrelated custom behavior, exports, and callers/);
  assert.match(approved, /Proceed without another approval question/);
  const unresolved = decision(text, 'Incompatible/unknown and not safely covered by approval');
  assert.match(unresolved, /stop before writes/);
  assert.match(unresolved, /`NEEDS_CONTEXT: <artifact, mismatch, required scoped decision>`/);
  assert.match(unresolved, /owner, or ask standalone/);
  assert.match(unresolved, /caller changes,[\s\S]*replacement of custom code, unapproved storage, or a new capability/);
  assert.match(unresolved, /Do not\s+delete, rename, replace wholesale, or silently skip/);
  assert.match(decision(text, 'Unrequested'), /leave untouched/);
}

for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`reconciliation branches preserve scoped approval and partial sets (${name})`, () => {
    assertDecisions(normalize(reference.replace(/\n/g, eol)));
  });
}

test('decision regressions cannot silently widen scope, overwrite, skip, or re-prompt', () => {
  const heading = '## 3. Apply the reconciliation decisions';
  const decisions = section(reference, heading);
  for (const [before, after] of [
    ['reuse unchanged, including custom code', 'overwrite from the example'],
    ['keep compatible siblings unchanged', 'regenerate all siblings'],
    ['Proceed without another approval question', 'Ask again before any approved update'],
    ['stop before writes', 'continue and report success'],
    ['owner, or ask standalone', 'start /edit-app automatically'],
    ['leave untouched', 'generate every optional companion'],
  ]) {
    assert.ok(decisions.includes(before));
    assert.throws(() => assertDecisions(`${heading}\n${decisions.replace(before, after)}`), before);
  }
});

test('full versus implementation-only and planning paths retain current request boundaries', () => {
  const context = section(reference, '## 1. Resolve the current request');
  for (const field of ['working_dir', 'orchestrator', 'phase', 'approved_scope', '--implementation-only', '--plan-only']) {
    assert.ok(context.includes(`\`${field}\``));
  }
  assert.match(context, /existing plan, memory-bank entry, environment\s+flag, or filename alone is not approval/);
  assert.match(context, /never start `\/edit-app` from a helper/);
  assert.match(context, /bounded request, not every capability\s+in an older plan/);
  assert.match(context, /Cancellation\/dismissal stops without writes/);
  assert.match(context, /ambiguous answer is not approval/);
  assert.match(context, /Planning \/ `--plan-only`.*proposal only, without writes/);
  assert.match(context, /memory-bank entry marked complete must pass this reconciliation/);
});

function row(name) {
  const value = reference.split('\n').find((line) => line.startsWith(`| ${name} |`));
  assert.ok(value, `Missing artifact contract: ${name}`);
  return value;
}

test('camera inventory covers the actual gallery export and independent scanner/upload artifacts', () => {
  const camera = row('Camera / gallery / scanner');
  for (const api of ['camera.ts', 'pickImage', 'PhotoResult', 'barcodeScanner.tsx',
    'BarcodeScannerView', 'BarcodeScannerViewProps', 'ScannerResult', 'onScanned',
    'paused', 'resetKey', 'barcodeTypes', 'cameraUpload.ts',
    'uploadPhotoToImageColumn', 'ImageUpdateService', 'UploadResult']) {
    assert.ok(camera.includes(api), api);
  }
  assert.match(camera, /one-shot lock, permission fallback, and sibling overlay/);
  assert.match(camera, /installed `expo-file-system` API \(or `\/legacy`\)/);
  assert.match(camera, /truthy generated-service `success`/);
  assert.match(camera, /Image `update\(\)` helper is not a File upload implementation/);
  const galleryRow = native.split('\n').find((line) => line.startsWith('| `image-picker`, `gallery`'));
  assert.match(galleryRow, /src\/native\/camera\.ts` \(`pickImage`\)/);
  assert.doesNotMatch(galleryRow, /src\/native\/imagePicker\.ts/);
});

test('camera does not turn missing requested storage into capture-only success', () => {
  const camera = skill('add-camera');
  const storage = section(camera, '### Step 4 — Detect Dataverse image/file columns');
  assert.match(storage, /requested Dataverse Image target is missing\/unverified/);
  assert.match(storage, /`NEEDS_CONTEXT` to the owner/);
  assert.match(storage, /blocker applies only to\nthe Dataverse Image-helper branch/);
  assert.match(storage, /File target is not supported by the Image\s+`update\(\)` example/);
  assert.match(storage, /Mere presence of generated columns does\s+not authorize an upload helper/);
  assert.doesNotMatch(prose(camera), /If no matches[^\n]*skip Step 5\./);
  const gate = section(camera, helpers[0].reconcile);
  assert.match(gate, /current approved request\/scope/);
  assert.match(gate, /not unrelated\s+matches in an older plan/);
  assert.match(section(camera, helpers[0].writes[2]),
    /explicit implementation-only upload-helper request; a screen plan is not required/);
});

test('approved connector retention does not require Dataverse columns or an Image helper', () => {
  const camera = skill('add-camera');
  const storage = section(camera, '### Step 4 — Detect Dataverse image/file columns');
  const connector = storage.split('\n').find((line) => line.startsWith('| Non-Dataverse retention'));
  assert.ok(connector);
  assert.match(connector, /SharePoint document library/);
  assert.match(connector, /Skip the Dataverse search and Step 5/);
  assert.match(connector, /Missing Dataverse columns are not an error/);
  assert.match(connector, /return the connector\/local persistence work to the owner/);
  assert.match(connector, /Do not generate `cameraUpload\.ts`/);
  assert.doesNotMatch(connector, /NEEDS_CONTEXT/);
  assert.doesNotMatch(storage, /If retention is required, return `NEEDS_CONTEXT`/);
  assert.ok(storage.indexOf('| Non-Dataverse retention') < storage.indexOf('Grep pattern='));
  assert.match(section(camera, helpers[0].reconcile), /non-Dataverse retention must not\nrequire Dataverse columns/);
  assert.match(reference, /known approved\nconnector\/local destination does not require Dataverse columns/);
  assert.match(reference, /For approved Dataverse retention, inspect the actual generated target column/);
});

test('PDF generation does not mistake generate-only output or package presence for share/upload support', () => {
  const pdf = row('PDF report');
  for (const api of ['createPdfReport', 'wrapPdfDocument', 'escapePdfHtml',
    'PdfReportResult', 'includeBase64', 'sharePdfReport', 'PdfShareResult']) {
    assert.ok(pdf.includes(api), api);
  }
  assert.match(pdf, /Package presence alone does not authorize adding sharing/);
  const report = skill('add-pdf-report');
  assert.match(section(report, '### 2. Verify packages are already present'),
    /requirement specifically includes sharing, STOP/);
  assert.match(section(report, helpers[1].reconcile), /Generate-only\s+compatibility does not satisfy a share\/upload request/);
  assert.match(section(report, helpers[1].writes[0]), /Do not\s+remove compatible existing share exports/);
  assert.match(section(report, '### 5. Optional Dataverse upload'), /Optional means unrequested, not skippable/);
});

test('PDF viewer compares URI behavior and installed version, not just an export name', () => {
  const viewer = row('PDF viewer');
  for (const input of ['openHttpsPdf', 'PdfViewerResult', '0.2.9+', 'file://',
    'https://', 'content://', 'blob:', 'http://', 'INVALID_URL',
    'NATIVE_MODULE_MISSING', 'VIEWER_FAILED']) {
    assert.ok(viewer.includes(input), input);
  }
  assert.match(viewer, /HTTPS-only old wrapper is incompatible with a local PDF request/);
  const versionGate = section(skill('add-pdf-viewer'), '### 2. Verify package is already present');
  assert.match(versionGate, /node_modules/);
  assert.match(versionGate, /UNSUPPORTED_VERSION/);
  assert.match(versionGate, /If the check fails, STOP/);
});

test('pen capture-only reuse cannot conceal required Image/File normalization', () => {
  const pen = row('Pen input');
  for (const api of ['captureSignature', 'stripDataUriPrefix', 'PenInputResult',
    'data:image/png;base64,', 'USER_CANCELLED', 'NATIVE_MODULE_MISSING', 'CAPTURE_FAILED']) {
    assert.ok(pen.includes(api), api);
  }
  assert.match(pen, /capture-only wrapper is insufficient.*storage contract.*prefix normalization/);
  assert.match(section(skill('add-pen-input'), '### 5. Optional Dataverse save'),
    /Optional means unrequested, not skippable/);
});

test('geolocation rejects one-shot or unverified storage substitutes', () => {
  const geo = row('Geolocation');
  for (const api of ['startTracking', 'stopTracking', 'isTracking', 'getPermissionStatus',
    'getCurrentLocation', 'GeoTrackingTarget', 'GeoResult', 'LocationData', 'PermissionStatus',
    'geoService', 'BgLocationClient', 'connectionUrl', 'trackInBackground', 'persistAcrossRestarts']) {
    assert.ok(geo.includes(api), api);
  }
  assert.match(geo, /MSAL-only/);
  assert.match(geo, /one-shot `expo-location` wrapper is not equivalent/);
  assert.match(geo, /msdyn_locationrecords.*every default `msdyn_\*` mapped column/);
  const verification = section(skill('add-geolocation'), '## 2. Verify the Dataverse target table first');
  assert.match(verification, /Empty `value: \[\]`: stop.*BLOCKED/);
  assert.match(verification, /Auth\/environment error: stop.*UNVERIFIED/);
  assert.match(verification, /If any active `fieldMap` column is missing, stop/);
  assert.match(verification, /Do not create the table, do not route to `\/add-dataverse`/);
});

test('storage comparison protects generated outputs and does not implement owner-side screens', () => {
  const inventory = section(reference, '## 2. Inventory and compare the actual output set');
  assert.match(inventory, /Follow re-exports to their implementation/);
  assert.match(inventory, /Do not create a duplicate wrapper/);
  assert.match(inventory, /Image.*supported image\s+payload/);
  assert.match(inventory, /File.*parent row, verifies success and its ID/);
  assert.match(inventory, /Never put File bytes in create\/update JSON or assume an upload accepts\s+a URI/);
  assert.match(inventory, /screen-side save examples are integration guidance, not helper-owned\s+upload implementations/);
  assert.match(inventory, /Missing\/unknown required storage targets, generated signatures, or payload\s+support are unresolved requirements/);
  assert.match(inventory, /Do not create\s+schema, refresh services, or hand-edit `src\/generated\/`/);
  const decisions = section(reference, '## 3. Apply the reconciliation decisions');
  assert.match(decisions, /No branch permits installs, dependency\s+or native-config edits, native builds, screen edits, or hand-editing generator-owned\s+output/);
});

test('success requires fulfilled requested artifacts, not type-checks or one compatible sibling', () => {
  const result = section(reference, '## 4. Verify and return');
  assert.match(result, /After scoped edits \(or a reuse-only run\), recheck every requested artifact and\s+storage requirement/);
  assert.match(result, /negative\s+paths when native execution is unavailable and report that limitation/);
  assert.match(result, /Type-check success alone is insufficient/);
  assert.match(result, /one\s+compatible sibling cannot stand in for an unfulfilled requested artifact/);
  assert.match(result, /Return `DONE` only when all requested helper-owned artifacts and their API\/behavior\/\s+storage obligations are fulfilled/);
  assert.match(result, /Otherwise return `NEEDS_CONTEXT` or `BLOCKED`/);
  assert.match(result, /not a success summary or completed memory-bank entry/);
  assert.match(result, /`writtenFiles` \(only actual helper-owned edits\)/);
  assert.match(result, /Report no generator-owned changes/);
  assert.match(result, /implementation-only\s+reports that UI integration was intentionally not performed/);
});
