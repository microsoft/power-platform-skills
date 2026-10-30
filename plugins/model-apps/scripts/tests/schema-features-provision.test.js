'use strict';
// The data-model build with the 2.21.0 schema fields: explicit choice option values, dateTimeBehavior, isSecured and the table
// flags, driven through provisionDataModel with an SDK double that records every call it is given.
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeRunner, provisionDataModel, localizedLabelLcidsInSpec } = require('../lib/entity-provision.js');

function mockSdk({ existing = {}, columns = [], dataverseGet } = {}) {
  const calls = [];
  const gets = [];
  return {
    calls,
    gets,
    sdk: {
      createTable: async (o) => { calls.push(['createTable', o]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
      updateTable: async (l, o) => { calls.push(['updateTable', l, o]); return {}; },
      createColumn: async (l, o) => { calls.push(['createColumn', l, o]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      updateColumn: async (l, c, o) => { calls.push(['updateColumn', l, c, o]); return {}; },
      createCustomerColumn: async (l, o) => { calls.push(['createCustomerColumn', l, o]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      createRelationship: async (o) => { calls.push(['createRelationship', o]); return { schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }; },
      createGlobalOptionSet: async (o) => { calls.push(['createGlobalOptionSet', o]); return { metadataId: `gc-${o.name}` }; },
      insertStatusValue: async () => 100000000,
      createAlternateKey: async () => ({}),
    },
    provision: Object.assign({
      findTables: async (s) => (existing[s.toLowerCase()] ? [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }] : []),
      findColumns: async () => columns,
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    }, dataverseGet ? { dataverse: { get: async (p) => { gets.push(p); return dataverseGet(p); } } } : {}),
  };
}

function specOf(columns, extra = {}) {
  return Object.assign({
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns }],
    relationships: [],
  }, extra);
}

async function run(m, spec, opts = {}) {
  const runner = makeRunner({ emit: () => {}, total: 50 });
  return provisionDataModel(Object.assign({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, preResolvedLanguageCode: 1033, warn: () => {}, inlineColumns: false }, opts));
}

// ------------------------------------------------------------------------------------------------ explicit option values (L01)

test('an explicit { value, label } option reaches createColumn as that value and label', async () => {
  const m = mockSdk();
  await run(m, specOf([{ schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: [{ value: 1, label: 'Low' }, 'Medium', { value: 9, label: 'High' }] }]));
  const call = m.calls.find((c) => c[0] === 'createColumn' && c[2].schemaName === 'new_priority');
  assert.deepEqual(call[2].options, [{ value: 1, label: 'Low' }, { value: 100000001, label: 'Medium' }, { value: 9, label: 'High' }]);
});

test('an explicit { value, label } option reaches createGlobalOptionSet as that value and label', async () => {
  const m = mockSdk();
  await run(m, specOf([], { globalChoices: [{ name: 'new_region', displayName: 'Region', options: [{ value: 10, label: 'North' }, { value: 20, label: 'South' }] }] }));
  const call = m.calls.find((c) => c[0] === 'createGlobalOptionSet');
  assert.deepEqual(call[1].options, [{ value: 10, label: 'North' }, { value: 20, label: 'South' }]);
});

test('plain and localized options keep the positional numbering they always had', async () => {
  const m = mockSdk();
  await run(m, specOf([{ schemaName: 'new_state', displayName: 'State', type: 'MultiChoice', options: ['Open', { 1033: 'Closed', 3082: 'Cerrado' }] }],
    { globalChoices: [{ name: 'new_g', options: ['A', 'B'] }] }));
  assert.deepEqual(m.calls.find((c) => c[0] === 'createColumn')[2].options, [{ value: 100000000, label: 'Open' }, { value: 100000001, label: { 1033: 'Closed', 3082: 'Cerrado' } }]);
  assert.deepEqual(m.calls.find((c) => c[0] === 'createGlobalOptionSet')[1].options, [{ value: 100000000, label: 'A' }, { value: 100000001, label: 'B' }]);
});

test('the language check sees the languages an explicit option\'s localized label names', () => {
  const lcids = localizedLabelLcidsInSpec(specOf([{ schemaName: 'new_p', type: 'Choice', options: [{ value: 1, label: { 1033: 'Low', 1036: 'Bas' } }] }]));
  assert.deepEqual(lcids.map((x) => x.lcid), [1033, 1036]);
  assert.match(lcids[1].where, /column new_p option/);
});
