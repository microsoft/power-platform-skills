'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchTableRelationships } = require('../lib/query-table-relationships');

function router(map) {
  // map: substring -> { statusCode, value } | throws if error:true
  return async ({ url }) => {
    for (const [needle, resp] of Object.entries(map)) {
      if (url.includes(needle)) {
        if (resp.error) return { error: resp.error };
        return { statusCode: resp.statusCode || 200, body: JSON.stringify({ value: resp.value || [] }) };
      }
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  };
}

test('fetchTableRelationships maps OneToMany + ManyToMany shapes', async () => {
  const req = router({
    'OneToManyRelationships': {
      value: [{ SchemaName: 'bp_permit_step', ReferencedEntity: 'bp_permit', ReferencingEntity: 'bp_step', ReferencingAttribute: 'bp_permitid' }],
    },
    'ManyToManyRelationships': {
      value: [{ SchemaName: 'bp_permit_tag', Entity1LogicalName: 'bp_permit', Entity2LogicalName: 'bp_tag' }],
    },
  });
  const out = await fetchTableRelationships('https://org.crm.dynamics.com/', 'bp_permit', 'tok', req);
  assert.deepEqual(out.oneToMany, [
    { schemaName: 'bp_permit_step', referencedEntity: 'bp_permit', referencingEntity: 'bp_step', referencingAttribute: 'bp_permitid' },
  ]);
  assert.deepEqual(out.manyToMany, [
    { schemaName: 'bp_permit_tag', entity1: 'bp_permit', entity2: 'bp_tag' },
  ]);
});

test('fetchTableRelationships swallows ManyToMany errors (best-effort)', async () => {
  const req = router({
    'OneToManyRelationships': { value: [] },
    'ManyToManyRelationships': { statusCode: 404, value: [] },
  });
  const out = await fetchTableRelationships('https://org.crm.dynamics.com', 'x_t', 'tok', req);
  assert.deepEqual(out.manyToMany, []);
  assert.deepEqual(out.oneToMany, []);
});

test('fetchTableRelationships propagates OneToMany errors', async () => {
  const req = router({ 'OneToManyRelationships': { statusCode: 404, value: [] } });
  await assert.rejects(() => fetchTableRelationships('https://org.crm.dynamics.com', 'missing', 'tok', req), /HTTP 404/);
});
