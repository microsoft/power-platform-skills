'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeRunner, provisionDataModel } = require(path.join(__dirname, '..', 'lib', 'entity-provision.js'));

function mockSdk(existing = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      createTable: async (o) => { calls.push(['createTable', o.schemaName]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
      createColumn: async (l, o) => { calls.push(['createColumn', l, o.schemaName]); return { logicalName: o.schemaName.toLowerCase() }; },
      createCustomerColumn: async () => ({}),
      createRelationship: async (o) => { calls.push(['createRelationship', o.schemaName]); return { schemaName: o.schemaName }; },
      createGlobalOptionSet: async (o) => { calls.push(['createGlobalOptionSet', o.name]); return { metadataId: `gc-${o.name}` }; },
      insertStatusValue: async () => 100000000,
      createAlternateKey: async () => ({}),
    },
    provision: {
      findTables: async (s) => (existing[s.toLowerCase()] ? [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }] : []),
      findColumns: async () => [],
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    },
  };
}

test('provisionDataModel creates missing tables + columns and captures entitySetName', async () => {
  const m = mockSdk();
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Choice', options: ['Low', 'High'] }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });
  assert.ok(dm.entities['new_ticket'], 'new_ticket entity present');
  assert.strictEqual(dm.entities['new_ticket'].entitySetName, 'new_tickets');
  assert.ok(m.calls.some((c) => c[0] === 'createTable' && c[1] === 'new_ticket'), 'createTable called');
  assert.ok(m.calls.some((c) => c[0] === 'createColumn' && c[2] === 'new_priority'), 'createColumn called');
});

test('provisionDataModel skips an existing table (idempotent)', async () => {
  const m = mockSdk({ new_ticket: true });
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });
  assert.ok(!m.calls.some((c) => c[0] === 'createTable'), 'existing table not re-created');
});
