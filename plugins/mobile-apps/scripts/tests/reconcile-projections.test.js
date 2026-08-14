'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { reconcileProjection, validateProjection } = require('../reconcile-projections');

const projection = {
  name: 'product-name',
  sourceEntitySet: 'cr1_products',
  sourcePrimaryId: 'cr1_productid',
  sourceColumn: 'cr1_name',
  targetEntitySet: 'cr1_movements',
  targetPrimaryId: 'cr1_movementid',
  targetLookupValueColumn: '_cr1_productid_value',
  targetColumn: 'cr1_productname',
  refreshOwner: 'client-write-through',
};

test('reconciles stale copied values from authoritative source records', async () => {
  let updates;
  const result = await reconcileProjection(projection, async (method, apiPath, operations) => {
    if (method === 'BATCH-METADATA') {
      updates = operations;
      return { status: 200, data: operations.map((_, index) => ({ index, status: 204 })) };
    }
    if (apiPath.startsWith('cr1_products?')) {
      return { status: 200, data: { value: [{ cr1_productid: 'p1', cr1_name: 'New name' }] } };
    }
    return {
      status: 200,
      data: { value: [{ cr1_movementid: 'm1', _cr1_productid_value: 'p1', cr1_productname: 'Old name' }] },
    };
  });
  assert.strictEqual(result.updated, 1);
  assert.deepStrictEqual(updates[0], {
    method: 'PATCH',
    apiPath: 'cr1_movements(m1)',
    body: { cr1_productname: 'New name' },
  });
});

test('existing cloud-flow ownership requires a verified flow ID', () => {
  assert.throws(() => validateProjection({ ...projection, refreshOwner: 'existing-cloud-flow' }), /verified GUID flowId/);
  assert.throws(() => validateProjection({
    ...projection,
    refreshOwner: 'existing-cloud-flow',
    flowId: 'InventoryProjectionReconcile',
  }), /verified GUID flowId/);
});

test('follows OData next links for complete reconciliation', async () => {
  const calls = [];
  const result = await reconcileProjection(projection, async (method, apiPath, operations) => {
    calls.push(apiPath);
    if (method === 'BATCH-METADATA') {
      return { status: 200, data: operations.map((_, index) => ({ index, status: 204 })) };
    }
    if (apiPath === 'cr1_products?$skiptoken=next') {
      return { status: 200, data: { value: [{ cr1_productid: 'p2', cr1_name: 'Two' }] } };
    }
    if (apiPath.startsWith('cr1_products?')) {
      return {
        status: 200,
        data: {
          value: [{ cr1_productid: 'p1', cr1_name: 'One' }],
          '@odata.nextLink': 'https://example.crm.dynamics.com/api/data/v9.2/cr1_products?$skiptoken=next',
        },
      };
    }
    return {
      status: 200,
      data: {
        value: [
          { cr1_movementid: 'm1', _cr1_productid_value: 'p1', cr1_productname: 'Old' },
          { cr1_movementid: 'm2', _cr1_productid_value: 'p2', cr1_productname: 'Old' },
        ],
      },
    };
  });
  assert.strictEqual(result.updated, 2);
  assert.ok(calls.includes('cr1_products?$skiptoken=next'));
});

test('validate-only does not select or update the future target column', async () => {
  const calls = [];
  const result = await reconcileProjection(projection, async (method, apiPath) => {
    calls.push([method, apiPath]);
    return { status: 200, data: { value: [] } };
  }, null, { validateOnly: true });
  assert.strictEqual(result.status, 'VALID');
  assert.ok(calls.every(([method]) => method === 'GET'));
  const targetCall = calls.find(([, apiPath]) => apiPath.startsWith('cr1_movements?'))[1];
  assert.doesNotMatch(targetCall, /cr1_productname/);
});

test('chunks large projection updates to keep command arguments bounded', async () => {
  const batchSizes = [];
  const targets = Array.from({ length: 205 }, (_, index) => ({
    cr1_movementid: `m${index}`,
    _cr1_productid_value: 'p1',
    cr1_productname: 'Old',
  }));
  const result = await reconcileProjection(projection, async (method, apiPath, operations) => {
    if (method === 'BATCH-METADATA') {
      batchSizes.push(operations.length);
      return { status: 200, data: operations.map((_, index) => ({ index, status: 204 })) };
    }
    if (apiPath.startsWith('cr1_products?')) {
      return { status: 200, data: { value: [{ cr1_productid: 'p1', cr1_name: 'New' }] } };
    }
    return { status: 200, data: { value: targets } };
  });
  assert.strictEqual(result.updated, 205);
  assert.deepStrictEqual(batchSizes, [100, 100, 5]);
});
