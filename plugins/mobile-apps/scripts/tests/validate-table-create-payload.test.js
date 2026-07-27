'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateTableCreatePayload } = require('../validate-table-create-payload');

const SCRIPT = path.join(__dirname, '..', 'validate-table-create-payload.js');

function stringColumn(schemaName, extra = {}) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: schemaName,
    ...extra,
  };
}

test('accepts a complete new-table payload with all ordinary columns inline', () => {
  const payload = {
    PrimaryNameAttribute: 'cr123_name',
    Attributes: [
      stringColumn('cr123_name', { IsPrimaryName: true }),
      stringColumn('cr123_description'),
      {
        '@odata.type': 'Microsoft.Dynamics.CRM.ImageAttributeMetadata',
        SchemaName: 'cr123_photo',
      },
    ],
  };

  const result = validateTableCreatePayload(payload, [
    'cr123_name',
    'cr123_description',
    'cr123_photo',
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('rejects a payload that would create an incomplete table shell', () => {
  const payload = {
    PrimaryNameAttribute: 'cr123_name',
    Attributes: [stringColumn('cr123_name', { IsPrimaryName: true })],
  };

  const result = validateTableCreatePayload(payload, ['cr123_name', 'cr123_amount']);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingColumns, ['cr123_amount']);
});

test('rejects lookup attributes because relationships are a second pass', () => {
  const payload = {
    PrimaryNameAttribute: 'cr123_name',
    Attributes: [
      stringColumn('cr123_name', { IsPrimaryName: true }),
      {
        '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
        SchemaName: 'cr123_customerid',
      },
    ],
  };

  const result = validateTableCreatePayload(payload, ['cr123_name', 'cr123_customerid']);

  assert.equal(result.ok, false);
  assert.deepEqual(result.lookupColumns, ['cr123_customerid']);
});

test('normalizes schema-name casing while comparing sets', () => {
  const payload = {
    PrimaryNameAttribute: 'cr123_name',
    Attributes: [
      stringColumn('Cr123_Name', { IsPrimaryName: true }),
      stringColumn('Cr123_Amount'),
    ],
  };

  const result = validateTableCreatePayload(payload, ['cr123_name', 'cr123_amount']);

  assert.equal(result.ok, true);
});

test('rejects duplicate and unexpected inline attributes', () => {
  const payload = {
    PrimaryNameAttribute: 'cr123_name',
    Attributes: [
      stringColumn('cr123_name', { IsPrimaryName: true }),
      stringColumn('cr123_amount'),
      stringColumn('cr123_amount'),
      stringColumn('cr123_extra'),
    ],
  };

  const result = validateTableCreatePayload(payload, ['cr123_name', 'cr123_amount']);

  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicateColumns, ['cr123_amount']);
  assert.deepEqual(result.unexpectedColumns, ['cr123_extra']);
});

test('CLI reads @files when their paths contain spaces', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'table payload guard '));
  const bodyPath = path.join(fixtureDir, 'table create.json');
  const expectedPath = path.join(fixtureDir, 'expected columns.json');
  fs.writeFileSync(bodyPath, JSON.stringify({
    PrimaryNameAttribute: 'cr123_name',
    Attributes: [
      stringColumn('cr123_name', { IsPrimaryName: true }),
      stringColumn('cr123_amount'),
    ],
  }));
  fs.writeFileSync(expectedPath, JSON.stringify(['cr123_name', 'cr123_amount']));

  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--body',
    `@${bodyPath}`,
    '--expected',
    `@${expectedPath}`,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});