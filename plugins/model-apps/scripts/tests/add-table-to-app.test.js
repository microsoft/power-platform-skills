'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'add-table-to-app.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('add-table-to-app.js: missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('add-table-to-app.js: invalid appId rejected (not a GUID)', () => {
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://example.crm.dynamics.com', 'not-a-guid', 'account'],
    { encoding: 'utf8' },
  );
  // emitResult(false, ...) exits 1; capture stderr or stdout for the message
  assert.notEqual(res.status, 0);
  const out = (res.stderr || '') + (res.stdout || '');
  assert.match(out, /appId must be a GUID/);
});

test('add-table-to-app.js: invalid entityLogicalName rejected', () => {
  const res = spawnSync(
    process.execPath,
    [
      scriptPath,
      'https://example.crm.dynamics.com',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'BadName!',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(res.status, 0);
  const out = (res.stderr || '') + (res.stdout || '');
  assert.match(out, /entityLogicalName must be a Dataverse logical name/);
});

test('add-table-to-app.js: queries EntityDefinitions for MetadataId', () => {
  assert.match(scriptSrc, /EntityDefinitions\(LogicalName='/);
  assert.match(scriptSrc, /MetadataId/);
});

test('add-table-to-app.js: queries existing appmodulecomponents before insert', () => {
  assert.match(scriptSrc, /appmodulecomponents\?\$filter=/);
  assert.match(scriptSrc, /_appmoduleidunique_value eq/);
  assert.match(scriptSrc, /componenttype eq 1/);
});

test('add-table-to-app.js: posts to appmodulecomponents with correct lookup binding', () => {
  assert.match(scriptSrc, /'appmoduleidunique@odata\.bind': `\/appmodules\(/);
  assert.match(scriptSrc, /componenttype: 1/);
  assert.match(scriptSrc, /objectid: metadataId/);
});

test('add-table-to-app.js: returns action=skipped on duplicate component', () => {
  // The skip branch returns this exact action string and avoids the POST.
  assert.match(scriptSrc, /action: 'skipped'/);
  assert.match(scriptSrc, /already an app component/);
});

test('add-table-to-app.js: returns action=added with appComponentId on success', () => {
  assert.match(scriptSrc, /action: 'added'/);
  assert.match(scriptSrc, /appComponentId,/);
});
