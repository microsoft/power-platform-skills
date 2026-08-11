'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'list-custom-apis.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

// --- Source-shape guards (cheap contract checks) ---------------------------

test('queries the customapi + customapirequestparameter Dataverse tables', () => {
  assert.match(scriptSrc, /customapis\?\$select=customapiid,uniquename,name,displayname,isfunction,bindingtype,boundentitylogicalname/);
  assert.match(scriptSrc, /customapirequestparameters\?\$select=uniquename,type,isoptional,_customapiid_value/);
});

test('gates fail-closed via exitIfCustomApiDisabled before any query', () => {
  assert.match(scriptSrc, /exitIfCustomApiDisabled\(\)/);
});

// --- Feature gate + arg validation (spawned CLI) ---------------------------

test('exits 3 with a disabled message when the custom-api flag is OFF', () => {
  // The gate runs before any Dataverse call, so a valid-looking env URL still bails.
  const res = spawnSync(process.execPath, [scriptPath, 'https://example.crm.dynamics.com'], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CUSTOM_API: '0' },
  });
  assert.equal(res.status, 3);
  assert.match(res.stderr, /disabled/i);
});

test('missing args exits 1 with usage (when the flag is ON)', () => {
  // Enable the flag so the run reaches arg validation instead of the feature gate.
  const res = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CUSTOM_API: '1' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

// --- Unit tests for the pure helpers (require.main guard keeps main() from running) ---
const {
  bindingTypeLabel,
  mapParameterKind,
  buildCustomApiFilter,
  groupParameterKinds,
  toCustomApiEntry,
} = require(scriptPath);

test('mapParameterKind maps the customapirequestparameter Type option set to DataverseParameterKind', () => {
  assert.equal(mapParameterKind(10), 'String');
  assert.equal(mapParameterKind(7), 'Integer');
  assert.equal(mapParameterKind(2), 'Decimal');
  assert.equal(mapParameterKind(12), 'Guid');
  assert.equal(mapParameterKind(11), 'StringArray');
  assert.equal(mapParameterKind(5), 'EntityReference');
  // Unknown/absent types are dropped (undefined), never guessed.
  assert.equal(mapParameterKind(999), undefined);
  assert.equal(mapParameterKind(undefined), undefined);
});

test('bindingTypeLabel maps the option set and defaults to Global', () => {
  assert.equal(bindingTypeLabel(0), 'Global');
  assert.equal(bindingTypeLabel(1), 'Entity');
  assert.equal(bindingTypeLabel(2), 'EntityCollection');
  assert.equal(bindingTypeLabel(undefined), 'Global');
});

test('buildCustomApiFilter includes Global plus the page tables, escaping quotes', () => {
  const none = buildCustomApiFilter([]);
  assert.match(none, /bindingtype eq 0/);

  const scoped = buildCustomApiFilter(['account', 'contact']);
  assert.match(scoped, /bindingtype eq 0/);
  assert.match(scoped, /boundentitylogicalname eq 'account'/);
  assert.match(scoped, /boundentitylogicalname eq 'contact'/);

  // A single quote in a table name is doubled per OData string-literal escaping.
  const escaped = buildCustomApiFilter(["o'brien"]);
  assert.match(escaped, /boundentitylogicalname eq 'o''brien'/);
});

test('groupParameterKinds groups by parent API and drops unknown types', () => {
  const grouped = groupParameterKinds([
    { _customapiid_value: 'A', uniquename: 'Comment', type: 10 },
    { _customapiid_value: 'A', uniquename: 'Amount', type: 2 },
    { _customapiid_value: 'A', uniquename: 'Mystery', type: 999 }, // unknown → dropped
    { _customapiid_value: 'B', uniquename: 'OrderId', type: 12 },
    { _customapiid_value: null, uniquename: 'Orphan', type: 10 }, // no parent → dropped
  ]);
  assert.deepEqual(grouped.A, { Comment: 'String', Amount: 'Decimal' });
  assert.deepEqual(grouped.B, { OrderId: 'Guid' });
});

test('toCustomApiEntry omits boundEntityLogicalName for a Global API', () => {
  const entry = toCustomApiEntry(
    { uniquename: 'new_NoOp', isfunction: false, bindingtype: 0 },
    {}
  );
  assert.equal(entry.name, 'new_NoOp');
  assert.equal(entry.displayName, 'new_NoOp'); // falls back to uniquename
  assert.equal(entry.isFunction, false);
  assert.equal(entry.bindingType, 'Global');
  assert.deepEqual(entry.parameterKinds, {});
  assert.equal('boundEntityLogicalName' in entry, false);
});

test('toCustomApiEntry sets boundEntityLogicalName for an entity-bound Function and coerces isFunction', () => {
  const entry = toCustomApiEntry(
    { uniquename: 'new_GetOrderSummary', displayname: 'Get Order Summary', isfunction: true, bindingtype: 1, boundentitylogicalname: 'salesorder' },
    { OrderId: 'Guid' }
  );
  assert.equal(entry.isFunction, true);
  assert.equal(entry.bindingType, 'Entity');
  assert.equal(entry.boundEntityLogicalName, 'salesorder');
  assert.equal(entry.displayName, 'Get Order Summary');
  assert.deepEqual(entry.parameterKinds, { OrderId: 'Guid' });
});
