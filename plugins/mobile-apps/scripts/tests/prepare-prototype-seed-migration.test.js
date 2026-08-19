'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const script = path.resolve(__dirname, '..', '..', 'skills', 'add-sample-data', 'scripts', 'prepare-prototype-seed-migration.js');

function write(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function project(t, { omitNotesMapping = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-seed-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  write(root, 'src/generated/.prototype-manifest.json', {
    schemaVersion: 1,
    tableSchemas: [{
      logicalName: 'cr_site',
      seedFile: 'src/generated/services/Cr_site.seed.json',
      primaryKey: 'cr_siteid',
      dependencyTier: 0,
      fields: [{ name: 'cr_name', type: 'string', options: [] }],
    }, {
      logicalName: 'cr_inspection',
      seedFile: 'src/generated/services/Cr_inspection.seed.json',
      primaryKey: 'cr_inspectionid',
      dependencyTier: 1,
      fields: [
        { name: 'cr_name', type: 'string', options: [] },
        { name: 'cr_siteid', type: 'lookup', lookupTarget: 'cr_site', options: [] },
        { name: 'cr_status', type: 'choice', options: [{ value: 1, label: 'Draft' }, { value: 2, label: 'Complete' }] },
        { name: 'cr_notes', type: 'memo', options: [] },
        { name: 'cr_photo', type: 'image', options: [] },
      ],
    }],
  });
  write(root, 'src/generated/services/Cr_site.seed.json', [{
    cr_siteid: '11111111-1111-1111-1111-111111111111',
    cr_name: 'North Dock',
  }]);
  write(root, 'src/generated/services/Cr_inspection.seed.json', [{
    cr_inspectionid: '22222222-2222-2222-2222-222222222222',
    cr_name: 'Opening audit',
    cr_siteid: '11111111-1111-1111-1111-111111111111',
    cr_status: 1,
    cr_notes: 'Evidence required',
    cr_photo: 'https://example.invalid/photo.jpg',
  }]);

  write(root, 'native-app-plan.md', '# Approved plan\n');
  write(root, '.tmp/prototype-plan-artifacts/dataverse-schema-contract.json', {
    schemaVersion: 1,
    planningMode: 'prototype',
    executionEligible: false,
  });
  write(root, '.datamodel-manifest.json', {
    environmentUrl: 'https://example.crm.dynamics.com',
    tables: [{
      logicalName: 'cr1_site',
      entitySetName: 'cr1_sites',
      primaryIdAttribute: 'cr1_siteid',
      primaryNameAttribute: 'cr1_name',
      dependencyTier: 0,
      customEntity: true,
      columns: [{ logicalName: 'cr1_name', schemaName: 'cr1_Name', type: 'String' }],
    }, {
      logicalName: 'cr1_inspection',
      entitySetName: 'cr1_inspections',
      primaryIdAttribute: 'cr1_inspectionid',
      primaryNameAttribute: 'cr1_name',
      dependencyTier: 1,
      customEntity: true,
      columns: [
        { logicalName: 'cr1_name', schemaName: 'cr1_Name', type: 'String' },
        { logicalName: 'cr1_siteid', schemaName: 'cr1_Site', type: 'Lookup', target: 'cr1_site' },
        { logicalName: 'cr1_status', schemaName: 'cr1_Status', type: 'Choice', options: [{ value: 10, label: 'Draft' }, { value: 20, label: 'Complete' }] },
        { logicalName: 'cr1_notes', schemaName: 'cr1_Notes', type: 'Memo' },
        { logicalName: 'cr1_photo', schemaName: 'cr1_Photo', type: 'Image' },
      ],
    }],
  });
  const hash = (relativePath) => crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, relativePath)))
    .digest('hex');
  write(root, '.tmp/prototype-plan-artifacts/live-name-map.json', {
    schemaVersion: 1,
    approvedPlanSha256: hash('native-app-plan.md'),
    prototypeContractSha256: hash('.tmp/prototype-plan-artifacts/dataverse-schema-contract.json'),
    dataverseManifestSha256: hash('.datamodel-manifest.json'),
    environment: { id: 'environment-1', url: 'https://example.crm.dynamics.com' },
    tables: {
      cr_site: {
        logicalName: 'cr1_site',
        decision: 'create',
        columns: { cr_name: 'cr1_name' },
      },
      cr_inspection: {
        logicalName: 'cr1_inspection',
        decision: 'create',
        columns: {
          cr_name: 'cr1_name',
          cr_siteid: 'cr1_siteid',
          cr_status: 'cr1_status',
          ...(omitNotesMapping ? {} : { cr_notes: 'cr1_notes' }),
          cr_photo: 'cr1_photo',
        },
      },
    },
  });
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
}

test('maps prototype IDs, choices, lookups, and media concerns deterministically', (t) => {
  const root = project(t);
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  const outputPath = path.join(root, '.tmp/prototype-seed-migration.json');
  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(output.summary.tableCount, 2);
  assert.equal(output.summary.rowCount, 2);
  assert.equal(output.summary.lookupCount, 1);
  assert.equal(output.summary.blockerCount, 0);
  assert.equal(output.summary.concernCount, 1);

  const inspection = output.tables.find((table) => table.prototypeLogicalName === 'cr_inspection');
  const row = inspection.rows[0];
  assert.equal(row.seedId, '22222222-2222-2222-2222-222222222222');
  assert.equal(row.body.cr1_inspectionid, row.seedId);
  assert.equal(row.body.cr1_name, 'Opening audit');
  assert.equal(row.body.cr1_status, 10);
  assert.equal(row.body.cr1_notes, 'Evidence required');
  assert.deepEqual(row.lookups, [{
    property: 'cr1_Site@odata.bind',
    targetPrototypeTable: 'cr_site',
    targetRealLogicalName: 'cr1_site',
    targetEntitySetName: 'cr1_sites',
    targetSeedId: '11111111-1111-1111-1111-111111111111',
  }]);
  assert.equal(row.mediaJobs.length, 0);
  assert.match(row.skippedFields[0].reason, /no local bytes/);

  const before = fs.readFileSync(outputPath, 'utf8');
  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), before);
});

test('fails closed when an approved live column mapping is missing', (t) => {
  const root = project(t, { omitNotesMapping: true });
  const result = run(root);
  assert.equal(result.status, 2);
  const output = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-seed-migration.json'), 'utf8'));
  assert.equal(output.summary.blockerCount, 1);
  assert.match(output.blockers[0], /cr_inspection\.cr_notes has no approved live column mapping/);
});

test('fails closed on malformed prototype identifiers', (t) => {
  const root = project(t);
  const seedPath = path.join(root, 'src/generated/services/Cr_site.seed.json');
  const rows = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  rows[0].cr_siteid = 'not-a-guid';
  fs.writeFileSync(seedPath, JSON.stringify(rows));
  const result = run(root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /BLOCKED/);
});

test('rejects a stale live name map before planning inserts', (t) => {
  const root = project(t);
  fs.appendFileSync(path.join(root, 'native-app-plan.md'), 'changed after approval\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /approvedPlanSha256 does not match current artifact/);
});