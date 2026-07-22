'use strict';

// Tests for offline-profile-delta.js — the LOCAL schema ↔ offline-profile coverage
// diff. Run with: node --test plugins/mobile-apps/scripts/tests/
//
// Covers the pure comparison (computeOfflineProfileDelta) plus the CLI's file-location
// and status routing (no-manifest / no-profile / delta / in-sync) via temp fixtures.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  computeOfflineProfileDelta,
  manifestColumnNames,
} = require('../offline-profile-delta');

const SCRIPT = path.join(__dirname, '..', 'offline-profile-delta.js');

function runCli(projectRoot, extraArgs = []) {
  // The CLI exits 0 for any comparison that ran and 1 only on fatal errors, so capture
  // both the parsed JSON and the exit code to assert the exit-code contract too.
  try {
    const stdout = execFileSync('node', [SCRIPT, '--project-root', projectRoot, ...extraArgs], {
      encoding: 'utf8',
    });
    return { code: 0, json: JSON.parse(stdout.trim()) };
  } catch (e) {
    return {
      code: e.status,
      json: e.stdout ? JSON.parse(e.stdout.toString().trim()) : null,
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'offline-delta-'));
}

// ── Pure function ────────────────────────────────────────────────────────────

test('in-sync when every manifest table is covered and no new columns', () => {
  const manifest = {
    tables: [{ logicalName: 'cr123_order', columns: [{ logicalName: 'cr123_total' }] }],
  };
  const profile = {
    profileId: 'p1',
    tables: [{ logicalName: 'cr123_order', schemaColumns: ['cr123_total'], selectedColumns: ['cr123_total'] }],
  };
  const delta = computeOfflineProfileDelta(manifest, profile);
  assert.strictEqual(delta.status, 'in-sync');
  assert.strictEqual(delta.summary.missingTableCount, 0);
  assert.strictEqual(delta.summary.newColumnCount, 0);
});

test('flags a table present in the manifest but missing from the profile', () => {
  const manifest = {
    tables: [
      { logicalName: 'cr123_order', displayName: 'Order', status: 'new', columns: [] },
      { logicalName: 'cr123_case', displayName: 'Case', status: 'new', columns: [] },
    ],
  };
  const profile = { profileId: 'p1', tables: [{ logicalName: 'cr123_order', schemaColumns: [] }] };
  const delta = computeOfflineProfileDelta(manifest, profile);
  assert.strictEqual(delta.status, 'delta');
  assert.deepStrictEqual(
    delta.missingTables.map((t) => t.logicalName),
    ['cr123_case'],
  );
  assert.strictEqual(delta.missingTables[0].displayName, 'Case');
});

test('flags new columns added to a table since its reconciliation baseline', () => {
  const manifest = {
    tables: [
      {
        logicalName: 'cr123_order',
        columns: [{ logicalName: 'cr123_total' }, { logicalName: 'cr123_priority' }],
      },
    ],
  };
  const profile = {
    profileId: 'p1',
    tables: [{ logicalName: 'cr123_order', itemId: 'i1', schemaColumns: ['cr123_total'] }],
  };
  const delta = computeOfflineProfileDelta(manifest, profile);
  assert.strictEqual(delta.status, 'delta');
  assert.strictEqual(delta.tablesWithNewColumns.length, 1);
  assert.deepStrictEqual(delta.tablesWithNewColumns[0].newColumns, ['cr123_priority']);
  assert.strictEqual(delta.tablesWithNewColumns[0].itemId, 'i1');
});

test('does NOT flag columns as new when they predate the baseline (deliberate exclusions)', () => {
  // cr123_notes is in the schema baseline but intentionally not in selectedColumns —
  // that is a curated exclusion, NOT a delta. The gate must stay quiet about it.
  const manifest = {
    tables: [
      {
        logicalName: 'cr123_order',
        columns: [{ logicalName: 'cr123_total' }, { logicalName: 'cr123_notes' }],
      },
    ],
  };
  const profile = {
    profileId: 'p1',
    tables: [
      {
        logicalName: 'cr123_order',
        schemaColumns: ['cr123_total', 'cr123_notes'],
        selectedColumns: ['cr123_total'],
      },
    ],
  };
  const delta = computeOfflineProfileDelta(manifest, profile);
  assert.strictEqual(delta.status, 'in-sync');
});

test('reports columnBaselineMissing (not a delta) for legacy snapshots without schemaColumns', () => {
  const manifest = {
    tables: [{ logicalName: 'cr123_order', columns: [{ logicalName: 'cr123_total' }] }],
  };
  const profile = {
    profileId: 'p1',
    tables: [{ logicalName: 'cr123_order', selectedColumns: ['cr123_total'] }], // no schemaColumns
  };
  const delta = computeOfflineProfileDelta(manifest, profile);
  assert.strictEqual(delta.status, 'in-sync');
  assert.deepStrictEqual(delta.columnBaselineMissing, ['cr123_order']);
});

test('tolerates bare-string manifest column entries', () => {
  assert.deepStrictEqual(
    manifestColumnNames({ columns: ['cr123_total', { logicalName: 'cr123_priority' }, null] }),
    ['cr123_total', 'cr123_priority'],
  );
});

test('missing table + new column combine into one delta', () => {
  const manifest = {
    tables: [
      { logicalName: 'cr123_order', columns: [{ logicalName: 'cr123_total' }, { logicalName: 'cr123_priority' }] },
      { logicalName: 'cr123_case', displayName: 'Case', status: 'new', columns: [] },
    ],
  };
  const profile = {
    profileId: 'p1',
    tables: [{ logicalName: 'cr123_order', schemaColumns: ['cr123_total'] }],
  };
  const delta = computeOfflineProfileDelta(manifest, profile);
  assert.strictEqual(delta.status, 'delta');
  assert.strictEqual(delta.summary.missingTableCount, 1);
  assert.strictEqual(delta.summary.newColumnCount, 1);
});

// ── CLI + file location ──────────────────────────────────────────────────────

test('CLI returns no-manifest when there is no data model', () => {
  const dir = tmpProject();
  const res = runCli(dir);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.json.status, 'no-manifest');
});

test('CLI returns no-profile when a manifest exists but no offline profile', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, '.datamodel-manifest.json'),
    JSON.stringify({ tables: [{ logicalName: 'cr123_order' }, { logicalName: 'cr123_case' }] }),
  );
  const res = runCli(dir);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.json.status, 'no-profile');
  assert.deepStrictEqual(res.json.tables, ['cr123_order', 'cr123_case']);
});

test('CLI locates the manifest under docs/plan-artifacts/', () => {
  const dir = tmpProject();
  const artifactsDir = path.join(dir, 'docs', 'plan-artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, '.datamodel-manifest.json'),
    JSON.stringify({ tables: [{ logicalName: 'cr123_order', columns: [{ logicalName: 'cr123_total' }] }] }),
  );
  fs.writeFileSync(
    path.join(dir, 'offline-profile.json'),
    JSON.stringify({ profileId: 'p1', tables: [{ logicalName: 'cr123_order', schemaColumns: ['cr123_total'] }] }),
  );
  const res = runCli(dir);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.json.status, 'in-sync');
  assert.ok(res.json.manifestPath.includes(path.join('docs', 'plan-artifacts')));
});

test('CLI reports delta end-to-end', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, '.datamodel-manifest.json'),
    JSON.stringify({
      tables: [
        { logicalName: 'cr123_order', columns: [{ logicalName: 'cr123_total' }] },
        { logicalName: 'cr123_case', displayName: 'Case', status: 'new', columns: [] },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'offline-profile.json'),
    JSON.stringify({ profileId: 'p1', tables: [{ logicalName: 'cr123_order', schemaColumns: ['cr123_total'] }] }),
  );
  const res = runCli(dir);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.json.status, 'delta');
  assert.deepStrictEqual(res.json.missingTables.map((t) => t.logicalName), ['cr123_case']);
});

test('CLI exits 1 on invalid JSON', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, '.datamodel-manifest.json'), '{ not valid json');
  fs.writeFileSync(path.join(dir, 'offline-profile.json'), JSON.stringify({ profileId: 'p1', tables: [] }));
  const res = runCli(dir);
  assert.strictEqual(res.code, 1);
  assert.strictEqual(res.json.status, 'error');
});

test('CLI exits 1 when an explicit --manifest path does not exist (not silently no-manifest)', () => {
  const dir = tmpProject();
  const res = runCli(dir, ['--manifest', path.join(dir, 'does-not-exist.json')]);
  assert.strictEqual(res.code, 1);
  // Usage errors go to stderr, not the JSON stdout contract.
  assert.strictEqual(res.json, null);
  assert.match(res.stderr, /--manifest path not found/);
});

test('CLI exits 1 when an explicit --profile path does not exist (not silently no-profile)', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, '.datamodel-manifest.json'),
    JSON.stringify({ tables: [{ logicalName: 'cr123_order' }] }),
  );
  const res = runCli(dir, ['--profile', path.join(dir, 'nope.json')]);
  assert.strictEqual(res.code, 1);
  assert.strictEqual(res.json, null);
  assert.match(res.stderr, /--profile path not found/);
});
