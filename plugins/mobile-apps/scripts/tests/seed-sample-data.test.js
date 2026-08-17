'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  businessKeyFilter,
  executeSeedPlan,
  stableKey,
  validatePlan,
} = require('../seed-sample-data');

function basePlan() {
  return {
    runId: 'test-run',
    tables: [{
      logicalName: 'cr1_product',
      entitySetName: 'cr1_products',
      primaryIdColumn: 'cr1_productid',
      tier: 0,
      requiredColumns: ['cr1_sku', 'cr1_name'],
      choiceColumns: ['cr1_status'],
      rows: [{
        businessKey: { cr1_sku: 'SKU-001' },
        body: { cr1_sku: 'SKU-001', cr1_name: 'Cola', cr1_status: 7 },
      }],
    }],
  };
}

function journal() {
  return { records: {}, environmentUrl: 'https://example.crm.dynamics.com', solution: 'sample' };
}

function withBatchReads(handler) {
  return async (method, apiPath, operations) => {
    if (method !== 'BATCH-READS') return handler(method, apiPath, operations);
    const data = await Promise.all(operations.map(async (operation) => ({
      index: operation.index,
      ...await handler('GET', operation.apiPath),
    })));
    const failed = data.some((result) => result.status < 200 || result.status >= 300);
    return { status: failed ? 207 : 200, data };
  };
}

test('escapes string business keys for OData filters', () => {
  assert.strictEqual(businessKeyFilter({ cr1_code: "A'1", cr1_active: true }), "cr1_code eq 'A''1' and cr1_active eq true");
});

test('requires a stable business key and required columns', () => {
  const plan = basePlan();
  plan.tables[0].rows[0].businessKey = {};
  assert.throws(() => validatePlan(plan), /non-empty businessKey/);
});

test('requires business-key values to be inserted unchanged', () => {
  const plan = basePlan();
  delete plan.tables[0].rows[0].body.cr1_sku;
  assert.throws(() => validatePlan(plan), /business-key column cr1_sku must be present/);
});

test('reuses a live business-key match instead of inserting by row count', async () => {
  const calls = [];
  const result = await executeSeedPlan(basePlan(), {
    journal: journal(),
    allowPartial: false,
    persist: () => {},
    request: withBatchReads(async (method, apiPath) => {
      calls.push([method, apiPath]);
      if (apiPath.includes('PicklistAttributeMetadata')) {
        return { status: 200, data: { OptionSet: { Options: [{ Value: 7 }] } } };
      }
      return { status: 200, data: { value: [{ cr1_productid: 'existing-id', cr1_sku: 'SKU-001' }] } };
    }),
  });
  assert.strictEqual(result.status, 'DONE');
  assert.deepStrictEqual(result.summary, { requested: 1, created: 0, reused: 1, failed: 0, blocked: 0, skipped: 0 });
  assert.ok(calls.some(([, apiPath]) => apiPath.includes('$filter=cr1_sku%20eq%20')));
});

test('batches choice and business-key discovery instead of issuing per-row GETs', async () => {
  const plan = basePlan();
  plan.tables[0].rows.push(
    {
      businessKey: { cr1_sku: 'SKU-002' },
      body: { cr1_sku: 'SKU-002', cr1_name: 'Water', cr1_status: 7 },
    },
    {
      businessKey: { cr1_sku: 'SKU-003' },
      body: { cr1_sku: 'SKU-003', cr1_name: 'Juice', cr1_status: 7 },
    },
  );
  const calls = [];
  const result = await executeSeedPlan(plan, {
    journal: journal(),
    allowPartial: false,
    persist: () => {},
    request: async (method, label, operations) => {
      calls.push({ method, label, count: operations?.length || 0 });
      if (method === 'BATCH-READS' && label === 'Sample choice metadata') {
        return {
          status: 200,
          data: operations.map((operation) => ({
            index: operation.index,
            status: 200,
            data: { OptionSet: { Options: [{ Value: 7 }] } },
          })),
        };
      }
      if (method === 'BATCH-READS') {
        return {
          status: 200,
          data: operations.map((operation) => ({
            index: operation.index,
            status: 200,
            data: { value: [] },
          })),
        };
      }
      return {
        status: 200,
        data: operations.map((operation) => ({
          index: operation.index,
          status: 204,
          recordId: `created-${operation.index}`,
        })),
      };
    },
  });

  assert.strictEqual(result.status, 'DONE');
  assert.deepStrictEqual(
    calls.map(({ method, count }) => ({ method, count })),
    [
      { method: 'BATCH-READS', count: 1 },
      { method: 'BATCH-READS', count: 3 },
      { method: 'BATCH-RECORDS', count: 3 },
    ],
  );
});

test('fails when a body contains a choice value absent from live metadata', async () => {
  let persisted;
  await assert.rejects(() => executeSeedPlan(basePlan(), {
    journal: journal(),
    allowPartial: false,
    persist: (value) => { persisted = JSON.parse(JSON.stringify(value)); },
    request: withBatchReads(async () => ({ status: 200, data: { OptionSet: { Options: [{ Value: 8 }] } } })),
  }), /not present in live metadata/);
  const record = persisted.records[stableKey('cr1_product', { cr1_sku: 'SKU-001' })];
  assert.strictEqual(record.status, 'blocked');
  assert.match(record.error, /not present in live metadata/);
});

test('persists business-key query errors as blocked before throwing', async () => {
  let persisted;
  await assert.rejects(() => executeSeedPlan(basePlan(), {
    journal: journal(),
    allowPartial: false,
    persist: (value) => { persisted = JSON.parse(JSON.stringify(value)); },
    request: withBatchReads(async (method, apiPath) => {
      if (apiPath.includes('PicklistAttributeMetadata')) {
        return { status: 200, data: { OptionSet: { Options: [{ Value: 7 }] } } };
      }
      return { status: 503, error: 'metadata service unavailable' };
    }),
  }), /Business-key lookup failed/);
  const record = persisted.records[stableKey('cr1_product', { cr1_sku: 'SKU-001' })];
  assert.strictEqual(record.status, 'blocked');
  assert.match(record.error, /metadata service unavailable/);
});

test('persists partial insert failures and returns BLOCKED by default', async () => {
  const saved = [];
  const result = await executeSeedPlan(basePlan(), {
    journal: journal(),
    allowPartial: false,
    persist: (value) => saved.push(JSON.parse(JSON.stringify(value))),
    request: withBatchReads(async (method, apiPath) => {
      if (apiPath.includes('PicklistAttributeMetadata')) {
        return { status: 200, data: { OptionSet: { Options: [{ Value: 7 }] } } };
      }
      if (method === 'GET') return { status: 200, data: { value: [] } };
      return { status: 200, data: [{ index: 0, status: 400, error: 'invalid row' }] };
    }),
  });
  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.summary.failed, 1);
  assert.strictEqual(saved.at(-1).records[stableKey('cr1_product', { cr1_sku: 'SKU-001' })].status, 'failed');
});

test('persists batch-level failures as blocked before throwing', async () => {
  let persisted;
  await assert.rejects(() => executeSeedPlan(basePlan(), {
    journal: journal(),
    allowPartial: false,
    persist: (value) => { persisted = JSON.parse(JSON.stringify(value)); },
    request: withBatchReads(async (method, apiPath) => {
      if (apiPath.includes('PicklistAttributeMetadata')) {
        return { status: 200, data: { OptionSet: { Options: [{ Value: 7 }] } } };
      }
      if (method === 'GET') return { status: 200, data: { value: [] } };
      return { status: 503, error: 'batch service unavailable' };
    }),
  }), /batch service unavailable/);
  const record = persisted.records[stableKey('cr1_product', { cr1_sku: 'SKU-001' })];
  assert.strictEqual(record.status, 'blocked');
  assert.match(record.error, /batch service unavailable/);
});

test('resolves lookup dependencies before inserting a child tier', async () => {
  const plan = basePlan();
  plan.tables[0].choiceColumns = [];
  plan.tables.push({
    logicalName: 'cr1_line',
    entitySetName: 'cr1_lines',
    primaryIdColumn: 'cr1_lineid',
    tier: 1,
    requiredColumns: ['cr1_name', 'cr1_Product'],
    rows: [{
      businessKey: { cr1_name: 'LINE-001' },
      body: { cr1_name: 'LINE-001' },
      lookups: [{ property: 'cr1_Product', targetTable: 'cr1_product', businessKey: { cr1_sku: 'SKU-001' } }],
    }],
  });

  const batches = [];
  const result = await executeSeedPlan(plan, {
    journal: journal(),
    allowPartial: false,
    persist: () => {},
    request: withBatchReads(async (method, apiPath, operations) => {
      if (method === 'GET') return { status: 200, data: { value: [] } };
      batches.push(operations);
      return { status: 200, data: operations.map((operation) => ({ index: operation.index, status: 204, recordId: `id-${batches.length}` })) };
    }),
  });
  assert.strictEqual(result.status, 'DONE');
  assert.strictEqual(batches[1][0].body['cr1_Product@odata.bind'], '/cr1_products(id-1)');
});

test('resolves an external lookup target by business key', async () => {
  const plan = basePlan();
  plan.tables[0].choiceColumns = [];
  plan.tables[0].rows[0].lookups = [{
    property: 'cr1_OwnerContact',
    targetTable: 'contact',
    targetEntitySetName: 'contacts',
    targetPrimaryIdColumn: 'contactid',
    businessKey: { emailaddress1: 'owner@example.com' },
  }];
  const batches = [];
  const result = await executeSeedPlan(plan, {
    journal: journal(),
    allowPartial: false,
    persist: () => {},
    request: withBatchReads(async (method, apiPath, operations) => {
      if (method === 'GET' && apiPath.startsWith('contacts?')) {
        return { status: 200, data: { value: [{ contactid: 'contact-id' }] } };
      }
      if (method === 'GET') return { status: 200, data: { value: [] } };
      batches.push(operations);
      return { status: 200, data: [{ index: 0, status: 204, recordId: 'product-id' }] };
    }),
  });
  assert.strictEqual(result.status, 'DONE');
  assert.strictEqual(batches[0][0].body['cr1_OwnerContact@odata.bind'], '/contacts(contact-id)');
});

test('journal records later tiers as blocked after a fail-closed stop', async () => {
  const plan = basePlan();
  plan.tables[0].choiceColumns = [];
  plan.tables.push({
    logicalName: 'cr1_line',
    entitySetName: 'cr1_lines',
    primaryIdColumn: 'cr1_lineid',
    tier: 1,
    requiredColumns: ['cr1_name'],
    rows: [{ businessKey: { cr1_name: 'LINE-001' }, body: { cr1_name: 'LINE-001' } }],
  });
  let persisted;
  const result = await executeSeedPlan(plan, {
    journal: journal(),
    allowPartial: false,
    persist: (value) => { persisted = JSON.parse(JSON.stringify(value)); },
    request: withBatchReads(async (method) => {
      if (method === 'GET') return { status: 200, data: { value: [] } };
      return { status: 200, data: [{ index: 0, status: 400, error: 'bad parent' }] };
    }),
  });
  assert.strictEqual(result.summary.requested, 2);
  assert.strictEqual(result.summary.failed, 1);
  assert.strictEqual(result.summary.blocked, 1);
  assert.strictEqual(persisted.records[stableKey('cr1_line', { cr1_name: 'LINE-001' })].status, 'blocked');
});
