'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { queryCustomUnmanagedTables } = require('../lib/query-metadata');

function fakeRequestReturning(rows, { paginate = false } = {}) {
  let served = false;
  return async ({ url }) => {
    if (paginate && !served && !/page2/.test(url)) {
      served = true;
      return {
        statusCode: 200,
        body: JSON.stringify({ value: rows.slice(0, 1), '@odata.nextLink': 'https://x/page2' }),
      };
    }
    const body = paginate ? { value: rows.slice(1) } : { value: rows };
    return { statusCode: 200, body: JSON.stringify(body) };
  };
}

test('queryCustomUnmanagedTables keeps only custom + unmanaged tables (with schema/display)', async () => {
  const req = fakeRequestReturning([
    { LogicalName: 'bp_permit', MetadataId: 'm1', SchemaName: 'bp_Permit', DisplayName: { UserLocalizedLabel: { Label: 'Permit' } }, IsCustomEntity: true, IsManaged: false },
    { LogicalName: 'bp_managed', MetadataId: 'm2', IsCustomEntity: true, IsManaged: true },   // managed -> dropped
    { LogicalName: 'account', MetadataId: 'm3', IsCustomEntity: false, IsManaged: false },    // system -> dropped (not custom)
    { LogicalName: 'bp_inspection', MetadataId: 'm4', SchemaName: 'bp_Inspection', IsCustomEntity: true, IsManaged: false }, // no DisplayName -> falls back to SchemaName
  ]);
  const out = await queryCustomUnmanagedTables('https://org.crm.dynamics.com/', 'tok', req);
  assert.deepEqual(out, [
    { logicalName: 'bp_permit', metadataId: 'm1', schemaName: 'bp_Permit', displayName: 'Permit' },
    { logicalName: 'bp_inspection', metadataId: 'm4', schemaName: 'bp_Inspection', displayName: 'bp_Inspection' },
  ]);
});

test('queryCustomUnmanagedTables paginates via @odata.nextLink', async () => {
  const req = fakeRequestReturning([
    { LogicalName: 'a_one', MetadataId: 'm1', IsCustomEntity: true, IsManaged: false },
    { LogicalName: 'a_two', MetadataId: 'm2', IsCustomEntity: true, IsManaged: false },
  ], { paginate: true });
  const out = await queryCustomUnmanagedTables('https://org.crm.dynamics.com', 'tok', req);
  assert.deepEqual(out.map((t) => t.logicalName), ['a_one', 'a_two']);
});
