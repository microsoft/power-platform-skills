// Unit tests for the pure bridge logic (no `vscode` dependency).
// Run with: npm run test:unit   (tsc -p tsconfig.test.json && node --test out-test/**/*.test.js)

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadManifest, hasConflictMarkers, inspectUnit, buildCompletion,
  parseLaunchQuery, resultAbsPath, buildMergeEditorInput, checkSchemaCompatibility,
  MIN_SUPPORTED_SCHEMA, MAX_SUPPORTED_SCHEMA, CONFLICT_START, BridgeManifest, MergeUnit,
} from '../mergeRun';

function tmpRun(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-merge-'));
  fs.mkdirSync(path.join(dir, 'units', 'Search__source'), { recursive: true });
  return dir;
}

function unit(overrides: Partial<MergeUnit> = {}): MergeUnit {
  return {
    unitId: 'Search__source',
    conflictId: 'g1',
    componentId: 'c1',
    componentName: 'Search',
    componentType: 8,
    typeLabel: 'Web Template',
    field: 'source',
    adoPath: '/x/Search.webtemplate.source.html',
    status: 'mergeable',
    hasConflicts: false,
    conflictCount: 0,
    files: {
      base: 'units/Search__source/base.txt',
      ours: 'units/Search__source/ours.txt',
      theirs: 'units/Search__source/theirs.txt',
      result: 'units/Search__source/result.txt',
    },
    labels: { ours: 'OURS', theirs: 'THEIRS' },
    ...overrides,
  };
}

function writeManifest(dir: string, units: MergeUnit[]): BridgeManifest {
  const manifest: BridgeManifest = {
    schemaVersion: 1, runId: 'run-1', generatedAt: new Date().toISOString(),
    binding: null, unitCount: units.length, units, binaryComponents: [],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return manifest;
}

test('hasConflictMarkers detects markers', () => {
  assert.equal(hasConflictMarkers(`${CONFLICT_START} ours\nX\n`), true);
  assert.equal(hasConflictMarkers('clean text\n'), false);
});

test('parseLaunchQuery extracts runId and dir', () => {
  const q = 'runId=run-9&dir=' + encodeURIComponent('C:\\proj\\docs\\inner-loop\\merge\\run-9');
  const r = parseLaunchQuery(q);
  assert.equal(r.runId, 'run-9');
  assert.equal(r.dir, 'C:\\proj\\docs\\inner-loop\\merge\\run-9');
});

test('loadManifest reads and validates', () => {
  const dir = tmpRun();
  writeManifest(dir, [unit()]);
  const m = loadManifest(dir);
  assert.equal(m.units.length, 1);
  assert.equal(m.units[0].componentName, 'Search');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadManifest throws on invalid manifest', () => {
  const dir = tmpRun();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: 'x' }), 'utf8');
  assert.throws(() => loadManifest(dir), /units/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectUnit: clean result → resolved', () => {
  const dir = tmpRun();
  const u = unit();
  fs.writeFileSync(resultAbsPath(dir, u), 'final merged\n', 'utf8');
  const v = inspectUnit(dir, u);
  assert.equal(v.resolved, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectUnit: leftover markers → unresolved', () => {
  const dir = tmpRun();
  const u = unit({ hasConflicts: true, conflictCount: 1 });
  fs.writeFileSync(resultAbsPath(dir, u), `${CONFLICT_START} ours\nX\n=======\nY\n>>>>>>> theirs\n`, 'utf8');
  const v = inspectUnit(dir, u);
  assert.equal(v.resolved, false);
  assert.match(v.reason!, /conflict markers/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectUnit: missing result → unresolved', () => {
  const dir = tmpRun();
  const v = inspectUnit(dir, unit());
  assert.equal(v.resolved, false);
  assert.match(v.reason!, /missing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildCompletion: all resolved → done', () => {
  const dir = tmpRun();
  const u = unit();
  const m = writeManifest(dir, [u]);
  fs.writeFileSync(resultAbsPath(dir, u), 'merged\n', 'utf8');
  const c = buildCompletion(m, dir);
  assert.equal(c.status, 'done');
  assert.equal(c.units[0].resolved, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildCompletion: some unresolved → partial', () => {
  const dir = tmpRun();
  const u = unit({ hasConflicts: true });
  const m = writeManifest(dir, [u]);
  fs.writeFileSync(resultAbsPath(dir, u), `${CONFLICT_START}\nstuff\n`, 'utf8');
  const c = buildCompletion(m, dir);
  assert.equal(c.status, 'partial');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildCompletion: explicit cancelled status honored', () => {
  const dir = tmpRun();
  const u = unit();
  const m = writeManifest(dir, [u]);
  fs.writeFileSync(resultAbsPath(dir, u), 'merged\n', 'utf8');
  const c = buildCompletion(m, dir, 'cancelled');
  assert.equal(c.status, 'cancelled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildMergeEditorInput: maps base/ours/theirs/output paths + labelled Dataverse/Azure DevOps titles', () => {
  const dir = tmpRun();
  const u = unit({ hasConflicts: true, conflictCount: 2 });
  const m = buildMergeEditorInput(dir, u);
  assert.equal(m.basePath, path.join(dir, 'units/Search__source/base.txt'));
  assert.equal(m.oursPath, path.join(dir, 'units/Search__source/ours.txt'));
  assert.equal(m.theirsPath, path.join(dir, 'units/Search__source/theirs.txt'));
  assert.equal(m.outputPath, path.join(dir, 'units/Search__source/result.txt'));
  assert.match(m.input1Title, /Dataverse — your environment · Search \(source\)/);
  assert.match(m.input2Title, /Azure DevOps — incoming · Search \(source\)/);
  assert.match(m.description, /Web Template · 2 conflict\(s\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkSchemaCompatibility — current schema is accepted', () => {
  const v = checkSchemaCompatibility(MAX_SUPPORTED_SCHEMA);
  assert.equal(v.ok, true);
  assert.equal(v.action, undefined);
});

test('checkSchemaCompatibility — newer manifest asks to update the extension', () => {
  const v = checkSchemaCompatibility(MAX_SUPPORTED_SCHEMA + 1);
  assert.equal(v.ok, false);
  assert.equal(v.action, 'update-extension');
  assert.match(v.message ?? '', /newer Power Pages plugin/);
});

test('checkSchemaCompatibility — older manifest asks to update the plugin', () => {
  const v = checkSchemaCompatibility(MIN_SUPPORTED_SCHEMA - 1);
  assert.equal(v.ok, false);
  assert.equal(v.action, 'update-plugin');
});

test('checkSchemaCompatibility — missing/legacy schema is best-effort (not blocked)', () => {
  assert.equal(checkSchemaCompatibility(undefined).ok, true);
  assert.equal(checkSchemaCompatibility('nope').ok, true);
});
