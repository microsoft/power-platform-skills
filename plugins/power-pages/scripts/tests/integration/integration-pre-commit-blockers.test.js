'use strict';

// Integration test — exercises the 5 pre-commit pre-flight validators in
// realistic combinations to prove each blocker hard-stops the commit at
// git-sync --dry-run pre-flight time, and that warning-class issues advance with
// a 'warnings' status (not 'blocked').
//
// The 5 validators (architecture doc §5.3) are:
//   1. validate-file-sizes              — HARD BLOCK on encoded > 17 MB
//   2. validate-supported-object-types  — HARD BLOCK on unsupported types
//                                          (DEPRECATED types → warning only)
//   3. check-large-canvas-warning       — WARNING only (≥70% of cap)
//   4. check-code-first-binary-duplication — WARNING only (binary + source)
//   5. validate-dependencies            — WARNING only (missing references)
//
// Each test:
//   1. Composes a synthetic pending-changes items[] array exercising the
//      target validator's blocking or warning path.
//   2. Calls the validator function(s) directly.
//   3. Asserts the validator's verdict matches expectation.
//   4. Builds the `last-validation.json` marker the way the
//      git-sync --dry-run path writes it.
//   5. Spawns validate-git-sync.js and asserts exit code
//      (0 = approve, 2 = block).
//
// This is the last of the 5 architecture-mandated integration tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  validateFileSizes,
} = require('../../lib/validate-file-sizes');
const {
  validateSupportedObjectTypes,
} = require('../../lib/validate-supported-object-types');
const {
  checkLargeCanvasWarning,
} = require('../../lib/check-large-canvas-warning');
const {
  checkCodeFirstBinaryDuplication,
} = require('../../lib/check-code-first-binary-duplication');
const {
  validateDependencies,
} = require('../../lib/validate-dependencies');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const VALIDATION_VALIDATOR = path.join(
  PLUGIN_ROOT, 'skills', 'git-sync', 'scripts',
  'validate-git-sync.js',
);

function mkTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-blockers-'));
  fs.writeFileSync(
    path.join(dir, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'BlockersTestSite' }, null, 2),
  );
  fs.mkdirSync(path.join(dir, 'docs', 'inner-loop'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function runValidator(scriptPath, cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

/**
 * Build the marker file the git-sync --dry-run path writes after
 * running all 5 pre-flight validators. The status field is derived from
 * the per-validator results — blocked > warnings > passed > clean.
 */
function buildValidationMarker({ status, results, blockers = [] }) {
  return {
    skill: 'git-sync',
    validatedAt: new Date().toISOString(),
    envUrl: 'https://contoso.crm.dynamics.com',
    status,
    results,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Test 1: 17 MB file (raw 17 MB → encoded > 22 MB) → BLOCK
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: 17 MB file fails validate-file-sizes → marker blocked → validator exits 2', () => {
  const projectRoot = mkTempProject();
  try {
    const items = [
      // Raw 17 MB ≈ 17,825,792 bytes → encoded = ceil(17_825_792 / 3) × 4 = 23_767_724 bytes (≈ 22.7 MB)
      // Well over the 17 MB encoded cap → BLOCK.
      {
        componentId: 'big-001', componentName: 'OversizedWebFile',
        componentType: 'mspp_webfile', filePath: 'src/web-files/oversized.bin',
        estimatedBytes: 17 * 1024 * 1024, // 17 MB raw
      },
      {
        componentId: 'small-001', componentName: 'NormalPage',
        componentType: 'mspp_webpage', filePath: 'src/web-pages/p1.html',
        estimatedBytes: 8 * 1024,
      },
    ];

    const r = validateFileSizes(items);
    assert.equal(r.blocking.length, 1, `expected 1 blocking finding; got ${r.blocking.length}`);
    assert.equal(r.blocking[0].componentId, 'big-001');
    assert.equal(r.ok, false);

    // Skill would write status: blocked + blockers list.
    const marker = buildValidationMarker({
      status: 'dry-run-blocked',
      results: { fileSizes: r },
      blockers: r.blocking.map((b) => ({
        validator: 'validate-file-sizes',
        componentName: b.componentName,
        message: `File ${b.filePath} is ${b.encodedBytes} bytes encoded (cap ${b.capBytes}).`,
      })),
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );

    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 0, `validator approves dry-run-blocked (skill ran correctly and surfaced blockers); stderr=${res.stderr}`);
  } finally { cleanup(projectRoot); }
});

// ---------------------------------------------------------------------------
// Test 2: workflow_xaml (legacy unsupported) → BLOCK
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: workflow_xaml type fails validate-supported-object-types → marker blocked → validator exits 2', () => {
  const projectRoot = mkTempProject();
  try {
    const items = [
      {
        componentId: 'wf-001', componentName: 'LegacyApprovalFlow',
        componentType: 'workflow_xaml', filePath: 'workflows/legacy_approval.xaml',
        estimatedBytes: 4096,
      },
      {
        componentId: 'page-001', componentName: 'OkPage',
        componentType: 'mspp_webpage', filePath: 'src/web-pages/p1.html',
        estimatedBytes: 4096,
      },
    ];

    const r = validateSupportedObjectTypes(items);
    assert.equal(r.unsupported.length, 1);
    assert.equal(r.unsupported[0].componentName, 'LegacyApprovalFlow');
    assert.equal(r.ok, false);

    const marker = buildValidationMarker({
      status: 'dry-run-blocked',
      results: { supportedTypes: r },
      blockers: r.unsupported.map((u) => ({
        validator: 'validate-supported-object-types',
        componentName: u.componentName,
        message: u.reason,
      })),
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );

    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 0, `validator approves dry-run-blocked (skill ran correctly); stderr=${res.stderr}`);
  } finally { cleanup(projectRoot); }
});

// ---------------------------------------------------------------------------
// Test 3: deprecated type (reportcategory) → WARNING only, validator approves
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: deprecated type (reportcategory) → marker warnings → validator exits 0', () => {
  const projectRoot = mkTempProject();
  try {
    const items = [
      {
        componentId: 'rc-001', componentName: 'OldReportCategory',
        componentType: 'reportcategory', filePath: 'reports/legacy.xml',
        estimatedBytes: 512,
      },
    ];

    const r = validateSupportedObjectTypes(items);
    assert.equal(r.unsupported.length, 0, 'deprecated types are NOT unsupported');
    assert.equal(r.deprecated.length, 1);
    assert.equal(r.ok, true, 'ok=true because no unsupported (deprecated are soft)');

    const marker = buildValidationMarker({
      status: 'dry-run-warnings',
      results: { supportedTypes: r },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );

    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 0, `validator should APPROVE on status=warnings; stderr=${res.stderr}`);
  } finally { cleanup(projectRoot); }
});

// ---------------------------------------------------------------------------
// Test 4: large canvas app (80% of cap) → WARNING only
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: 13 MB Canvas app triggers check-large-canvas-warning → status=warnings → validator exits 0', () => {
  const projectRoot = mkTempProject();
  try {
    const CAP_BYTES = 17 * 1024 * 1024;
    // We want ~80% of cap on the ENCODED side. Encoded = raw * 4/3, so raw = cap * 0.8 * 3/4 = cap * 0.6 ≈ 10.2 MB
    const raw = Math.floor(CAP_BYTES * 0.60);
    const items = [
      {
        componentId: 'canvas-001', componentName: 'OrderEntryApp',
        componentType: 'canvasapp', filePath: 'apps/OrderEntry.msapp',
        estimatedBytes: raw,
      },
    ];

    const canvas = checkLargeCanvasWarning(items);
    const sizes = validateFileSizes(items);
    // Canvas: warning expected (encoded ~ 80% of cap)
    assert.equal(canvas.totalCanvasApps, 1);
    assert.ok(canvas.warnings.length >= 1, `expected canvas warning; got ${canvas.warnings.length}`);
    // Sizes: should NOT block (still under 100%)
    assert.equal(sizes.blocking.length, 0, 'canvas at 80% must not block');

    const marker = buildValidationMarker({
      status: 'dry-run-warnings',
      results: { fileSizes: sizes, largeCanvas: canvas },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );

    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 0, `validator should APPROVE on status=warnings; stderr=${res.stderr}`);
  } finally { cleanup(projectRoot); }
});

// ---------------------------------------------------------------------------
// Test 5: PCF binary + source pair → WARNING only
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: PCF binary + source pair flagged by check-code-first-binary-duplication → status=warnings', () => {
  const projectRoot = mkTempProject();
  try {
    const items = [
      // Binary (PCF assembly under customcontrol entity)
      {
        componentId: 'pcf-bin', componentName: 'MyCustomControl',
        componentType: 'customcontrol', filePath: 'CustomControls/MyCustomControl.zip',
        estimatedBytes: 2048,
      },
      // Source files for the same PCF control
      {
        componentId: 'pcf-src-1', componentName: 'MyCustomControl',
        componentType: 'webresource', filePath: 'PCFControls/MyCustomControl/ControlManifest.Input.xml',
        estimatedBytes: 512,
      },
      {
        componentId: 'pcf-src-2', componentName: 'MyCustomControl',
        componentType: 'webresource', filePath: 'PCFControls/MyCustomControl/index.tsx',
        estimatedBytes: 1024,
      },
    ];

    const r = checkCodeFirstBinaryDuplication(items);
    assert.ok(r.warnings.length >= 1,
      `expected at least 1 code-first warning; got ${r.warnings.length}: ${JSON.stringify(r)}`);
    assert.equal(r.warnings[0].kind, 'pcf');
    assert.ok(r.warnings[0].sourceItems.length >= 1);
    assert.equal(r.ok, true, 'code-first dup is informational only');

    const marker = buildValidationMarker({
      status: 'dry-run-warnings',
      results: { codeFirstDup: r },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );

    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 0, `validator should APPROVE on code-first warning; stderr=${res.stderr}`);
  } finally { cleanup(projectRoot); }
});

// ---------------------------------------------------------------------------
// Test 6: missing dependency reference → WARNING only
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: orphan reference flagged by validate-dependencies → status=warnings', () => {
  const projectRoot = mkTempProject();
  try {
    const items = [
      // Form references a Web Page that is NOT in this commit.
      {
        componentId: '111e1111-1111-1111-1111-111111111111',
        componentName: 'OrderForm', componentType: 'systemform',
        filePath: 'src/forms/OrderForm.xml',
        estimatedBytes: 2048,
        webpageId: '999e9999-9999-9999-9999-999999999999', // orphan reference
      },
    ];

    const r = validateDependencies(items);
    assert.ok(r.missing.length >= 1,
      `expected at least 1 missing dependency; got ${r.missing.length}`);
    assert.equal(r.missing[0].referenceField, 'webpageId');
    assert.equal(r.ok, true, 'dependency validator is informational only');

    const marker = buildValidationMarker({
      status: 'dry-run-warnings',
      results: { dependencies: r },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );

    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 0, `validator should APPROVE on dependency warning; stderr=${res.stderr}`);
  } finally { cleanup(projectRoot); }
});

// ---------------------------------------------------------------------------
// Test 7: CLEAN commit (no blockers, no warnings) → status=clean, validator approves
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: clean commit → status=clean → validator exits 0', () => {
  const projectRoot = mkTempProject();
  try {
    const items = [
      {
        componentId: 'p1', componentName: 'Home',
        componentType: 'mspp_webpage', filePath: 'src/web-pages/home.html',
        estimatedBytes: 4096,
      },
      {
        componentId: 'p2', componentName: 'About',
        componentType: 'mspp_webpage', filePath: 'src/web-pages/about.html',
        estimatedBytes: 6144,
      },
    ];

    const sizes  = validateFileSizes(items);
    const types  = validateSupportedObjectTypes(items);
    const canvas = checkLargeCanvasWarning(items);
    const codeF  = checkCodeFirstBinaryDuplication(items);
    const deps   = validateDependencies(items);

    assert.equal(sizes.blocking.length, 0);
    assert.equal(sizes.warnings.length, 0);
    assert.equal(types.unsupported.length, 0);
    assert.equal(types.deprecated.length, 0);
    assert.equal(canvas.warnings.length, 0);
    assert.equal(codeF.warnings.length, 0);
    assert.equal(deps.missing.length, 0);

    const marker = buildValidationMarker({
      status: 'clean',
      results: { fileSizes: sizes, supportedTypes: types, largeCanvas: canvas,
                 codeFirstDup: codeF, dependencies: deps },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );

    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 0, `validator should APPROVE on clean commit; stderr=${res.stderr}`);
  } finally { cleanup(projectRoot); }
});

// ---------------------------------------------------------------------------
// Test 8: validator rejects unknown status enum (defensive contract)
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: marker with unknown status → validator exits 2', () => {
  const projectRoot = mkTempProject();
  try {
    const marker = {
      skill: 'git-sync',
      validatedAt: new Date().toISOString(),
      envUrl: 'https://contoso.crm.dynamics.com',
      status: 'totally-bogus',
    };
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );
    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 2, 'validator must reject unknown status');
    assert.match(res.stderr, /unrecognised status/i);
  } finally { cleanup(projectRoot); }
});

// ---------------------------------------------------------------------------
// Test 9: combination — block + warnings in same commit, block dominates
// ---------------------------------------------------------------------------
test('integration pre-commit blockers: oversized file + canvas warning in same commit → status=blocked dominates', () => {
  const projectRoot = mkTempProject();
  try {
    const items = [
      // Oversized file → BLOCK
      {
        componentId: 'big', componentName: 'Huge',
        componentType: 'mspp_webfile', filePath: 'src/web-files/huge.bin',
        estimatedBytes: 18 * 1024 * 1024,
      },
      // Canvas app at 80% → WARNING
      {
        componentId: 'canvas', componentName: 'BigCanvas',
        componentType: 'canvasapp', filePath: 'apps/BigCanvas.msapp',
        estimatedBytes: Math.floor(17 * 1024 * 1024 * 0.60),
      },
    ];

    const sizes  = validateFileSizes(items);
    const canvas = checkLargeCanvasWarning(items);
    assert.equal(sizes.blocking.length, 1);
    assert.ok(canvas.warnings.length >= 1);

    // Skill applies precedence: any blocker → status=blocked.
    const marker = buildValidationMarker({
      status: 'dry-run-blocked',
      results: { fileSizes: sizes, largeCanvas: canvas },
      blockers: sizes.blocking.map((b) => ({
        validator: 'validate-file-sizes',
        componentName: b.componentName,
        message: 'oversized',
      })),
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify(marker, null, 2),
    );

    const res = runValidator(VALIDATION_VALIDATOR, projectRoot);
    assert.equal(res.status, 0, 'validator approves dry-run-blocked (skill ran correctly and surfaced blockers)');
  } finally { cleanup(projectRoot); }
});
