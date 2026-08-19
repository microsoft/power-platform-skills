'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runOneOperation } = require('../dataverse-request');

const operation = {
  index: 7,
  entitySet: 'cr1_inspections',
  body: {
    cr1_inspectionid: '22222222-2222-2222-2222-222222222222',
    cr1_name: 'Opening audit',
  },
};

test('record POST transport loss is uncertain and is not retried', async () => {
  let calls = 0;
  const result = await runOneOperation(
    'https://example.crm.dynamics.com',
    operation,
    'token',
    'Solution',
    'tenant',
    {
      sendRequest: async () => {
        calls += 1;
        return { error: 'socket closed after write' };
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.status, 0);
  assert.equal(result.uncertain, true);
  assert.match(result.error, /socket closed/);
});

test('record POST server failure is uncertain and is not retried', async () => {
  let calls = 0;
  const result = await runOneOperation(
    'https://example.crm.dynamics.com',
    operation,
    'token',
    'Solution',
    'tenant',
    {
      sendRequest: async () => {
        calls += 1;
        return { statusCode: 503, headers: {}, body: '' };
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.status, 503);
  assert.equal(result.uncertain, true);
});

test('record POST safely retries a throttled request', async () => {
  let calls = 0;
  const result = await runOneOperation(
    'https://example.crm.dynamics.com',
    operation,
    'token',
    'Solution',
    'tenant',
    {
      sendRequest: async () => {
        calls += 1;
        if (calls === 1) return { statusCode: 429, headers: { 'retry-after': '0' }, body: '' };
        return {
          statusCode: 204,
          headers: {
            'odata-entityid': 'https://example.crm.dynamics.com/api/data/v9.2/cr1_inspections(22222222-2222-2222-2222-222222222222)',
          },
          body: '',
        };
      },
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.status, 204);
  assert.equal(result.recordId, '22222222-2222-2222-2222-222222222222');
  assert.equal(result.uncertain, undefined);
});