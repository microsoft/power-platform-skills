'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', 'validate-datamodel-manifest.js');

function run(t, manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'datamodel-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, '.datamodel-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = spawnSync(process.execPath, [script, manifestPath, '--json'], { encoding: 'utf8' });
  return { result, report: JSON.parse(result.stdout) };
}

function validManifest() {
  return {
    environmentUrl: 'https://example.crm.dynamics.com',
    tables: [{
      logicalName: 'cr1_inspection',
      entitySetName: 'cr1_inspections',
      primaryIdAttribute: 'cr1_inspectionid',
      primaryNameAttribute: 'cr1_name',
      dependencyTier: 1,
      status: 'new',
      columns: [
        { logicalName: 'cr1_name', schemaName: 'cr1_Name', type: 'String' },
        { logicalName: 'cr1_siteid', schemaName: 'cr1_Site', type: 'Lookup', target: 'cr1_site', targetEntitySetName: 'cr1_sites' },
        { logicalName: 'cr1_status', schemaName: 'cr1_Status', type: 'Choice', options: [{ value: 10, label: 'Draft' }, { value: 20, label: 'Complete' }] },
      ],
    }],
  };
}

test('accepts the rich manifest required by conversion and sample migration', (t) => {
  const { result, report } = run(t, validManifest());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.valid, true);
  assert.equal(report.tableCount, 1);
});

test('rejects missing entity-set, lookup-target, and choice metadata', (t) => {
  const manifest = validManifest();
  delete manifest.tables[0].entitySetName;
  delete manifest.tables[0].columns[1].targetEntitySetName;
  manifest.tables[0].columns[2].options = [];
  const { result, report } = run(t, manifest);
  assert.equal(result.status, 1);
  assert.match(report.errors.join('\n'), /entitySetName is required/);
  assert.match(report.errors.join('\n'), /targetEntitySetName is required/);
  assert.match(report.errors.join('\n'), /options must contain live integer\/label pairs/);
});

test('rejects duplicate tables, columns, and option integers', (t) => {
  const manifest = validManifest();
  manifest.tables.push(structuredClone(manifest.tables[0]));
  manifest.tables[0].columns.push(structuredClone(manifest.tables[0].columns[0]));
  manifest.tables[0].columns[2].options.push({ value: 20, label: 'Done again' });
  const { result, report } = run(t, manifest);
  assert.equal(result.status, 1);
  const errors = report.errors.join('\n');
  assert.match(errors, /logicalName duplicates cr1_inspection/);
  assert.match(errors, /logicalName duplicates cr1_name/);
  assert.match(errors, /duplicate value 20/);
});