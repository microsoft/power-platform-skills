'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { checkDataLayer, classifyImport, resolveSpecifier } = require('../check-data-layer');

const SCRIPT = path.join(__dirname, '..', 'check-data-layer.js');

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-layer-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return root;
}

const PREVIEW_ENTITY = [
  "import { createMockSource } from './core';",
  "import { inspectionFixtures } from './fixtures/inspections';",
  '// DATA SOURCE START - preview',
  'const source = createMockSource(inspectionFixtures);',
  '// DATA SOURCE END',
].join('\n');

const WIRED_ENTITY = [
  "import { Cr123_inspectionsService } from '@/generated/services/Cr123_inspectionsService';",
  '// DATA SOURCE START - dataverse cr123_inspection',
  'const source = { list: () => Cr123_inspectionsService.getAll() };',
  '// DATA SOURCE END',
].join('\n');

const PREVIEW_DEVICE = [
  '// DEVICE ACTION START - preview capturePhoto',
  'export const capturePhoto = () => null;',
  '// DEVICE ACTION END',
].join('\n');

const BASE = {
  'src/hooks/data/core.ts': 'export {};',
  'src/hooks/data/index.ts': "export * from './inspections';",
  'src/hooks/data/fixtures/inspections.ts': 'export const inspectionFixtures = [];',
  'app/_layout.tsx': "import { schemaMap } from '../src/generated/connectorSchemas';",
  'app/(app)/inspections/index.tsx': "import { useInspectionList } from '@/hooks/data';",
};

test('an app without a data layer is reported as absent, not as a failure', () => {
  const root = project({ 'app/(app)/home.tsx': "import { XService } from '@/generated/services/XService';" });
  const result = checkDataLayer(root);
  assert.equal(result.status, 'absent');
  assert.deepEqual(result.violations, []);
});

test('preview sources and device actions are listed, and allowed while the app is in preview', () => {
  const root = project({
    ...BASE,
    'src/hooks/data/inspections.ts': PREVIEW_ENTITY,
    'src/hooks/data/device.ts': PREVIEW_DEVICE,
  });
  const result = checkDataLayer(root);
  assert.equal(result.status, 'ok', JSON.stringify(result.violations));
  assert.deepEqual(result.previewBound, ['src/hooks/data/inspections.ts:3', 'src/hooks/data/device.ts#capturePhoto']);
  assert.equal(result.deviceActions[0].name, 'capturePhoto');
});

test('--require-wired fails on anything still serving sample data', () => {
  const root = project({
    ...BASE,
    'src/hooks/data/inspections.ts': PREVIEW_ENTITY,
    'src/hooks/data/device.ts': PREVIEW_DEVICE,
  });
  const result = checkDataLayer(root, { requireWired: true });
  assert.equal(result.status, 'violations');
  const rules = result.violations.map((violation) => violation.rule);
  assert.equal(rules.filter((rule) => rule === 'still-preview').length, 2);
  // A module still on sample data legitimately needs its fixtures.
  assert.ok(!rules.includes('wired-module-imports-fixtures'));
});

test('a wired module that still imports fixtures would ship fake records', () => {
  const root = project({
    ...BASE,
    'src/hooks/data/inspections.ts': `import { inspectionFixtures } from './fixtures/inspections';\n${WIRED_ENTITY}`,
  });
  const result = checkDataLayer(root, { requireWired: true });
  assert.deepEqual(result.violations.map((violation) => violation.rule), ['wired-module-imports-fixtures']);
});

test('a fully wired data layer passes --require-wired, and its binding is recorded', () => {
  const root = project({ ...BASE, 'src/hooks/data/inspections.ts': WIRED_ENTITY });
  const result = checkDataLayer(root, { requireWired: true });
  assert.equal(result.status, 'ok', JSON.stringify(result.violations));
  assert.equal(result.sources[0].binding, 'dataverse');
  assert.equal(result.sources[0].target, 'cr123_inspection');
});

test('screens and components may not reach past the data layer', () => {
  const root = project({
    ...BASE,
    'src/hooks/data/inspections.ts': WIRED_ENTITY,
    'app/(app)/inspections/[id].tsx': [
      "import { Cr123_inspectionsService } from '@/generated/services/Cr123_inspectionsService';",
      "import type { Cr123_inspections } from '../../../src/generated/models/Cr123_inspectionsModel';",
      "import { takePhoto } from '@/native/camera';",
      "// import { old } from '@/generated/services/Old'; a comment is not an import",
    ].join('\n'),
    'src/components/InspectionRow.tsx': "import { inspectionFixtures } from '@/hooks/data/fixtures/inspections';",
  });
  const result = checkDataLayer(root);
  assert.equal(result.status, 'violations');
  const found = result.violations.map((violation) => `${violation.file}:${violation.line}:${violation.rule}`);
  assert.deepEqual(found.sort(), [
    'app/(app)/inspections/[id].tsx:1:imports-generated',
    'app/(app)/inspections/[id].tsx:2:imports-generated',
    'app/(app)/inspections/[id].tsx:3:imports-native',
    'src/components/InspectionRow.tsx:1:imports-fixtures',
  ].sort());
});

test('the root layout may import the generated connector schema map', () => {
  assert.equal(classifyImport(resolveSpecifier('../src/generated/connectorSchemas', 'app/_layout.tsx')), null);
  assert.equal(classifyImport(resolveSpecifier('@/generated/services/X', 'app/x.tsx')), 'imports-generated');
});

test('the wired barcode scanner view is the one native import a screen may make', () => {
  assert.equal(classifyImport(resolveSpecifier('@/native/barcodeScanner', 'app/(app)/scan.tsx')), null);
  assert.equal(classifyImport(resolveSpecifier('@/native/camera', 'app/(app)/scan.tsx')), 'imports-native');
  assert.equal(classifyImport(resolveSpecifier('@/native/barcodeScannerHelpers', 'app/x.tsx')), 'imports-native');
});

test('malformed markers are reported', () => {
  const root = project({
    ...BASE,
    'src/hooks/data/inspections.ts': [
      '// DATA SOURCE START - mock',
      'const a = 1;',
      '// DATA SOURCE START - preview',
      'const b = 2;',
    ].join('\n'),
    'src/hooks/data/device.ts': '// DEVICE ACTION END',
  });
  const rules = checkDataLayer(root).violations.map((violation) => violation.rule).sort();
  assert.deepEqual(rules, ['unclosed-marker', 'unclosed-marker', 'unknown-binding', 'unmatched-marker']);
});

test('the CLI exits 1 on violations, 0 when clean, and 2 on bad arguments', () => {
  const clean = project({ ...BASE, 'src/hooks/data/inspections.ts': WIRED_ENTITY });
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  assert.equal(run(['--project-root', clean, '--require-wired']).status, 0);
  const preview = project({ ...BASE, 'src/hooks/data/inspections.ts': PREVIEW_ENTITY });
  const failed = run(['--project-root', preview, '--require-wired']);
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).status, 'violations');
  assert.equal(run(['--nope']).status, 2);
});
