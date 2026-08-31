'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createDataverseRequestExecutor,
  metadataRequestIdentity,
} = require('../dataverse-request');

test('metadata request identity classifies paths without retaining query values', () => {
  assert.deepEqual(
    metadataRequestIdentity(
      "EntityDefinitions(LogicalName='new_item')/Attributes/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=LogicalName,MaxLength",
    ),
    {
      category: 'typed-attribute-metadata',
      table: 'new_item',
      metadataType: 'StringAttributeMetadata',
    },
  );
  assert.deepEqual(metadataRequestIdentity('EntityDefinitions?$select=LogicalName'), {
    category: 'table-inventory',
    table: null,
    metadataType: null,
  });
  assert.deepEqual(metadataRequestIdentity(
    "EntityDefinitions(LogicalName='new_item')?$select=LogicalName&$expand=Attributes($select=LogicalName)",
  ), {
    category: 'combined-base-metadata',
    table: 'new_item',
    metadataType: null,
  });
});

test('request telemetry reports retries, bytes, and auth counts without sensitive data', async () => {
  const events = [];
  let tokenCalls = 0;
  let requests = 0;
  let clock = 100;
  const request = createDataverseRequestExecutor({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    getToken: async () => {
      tokenCalls += 1;
      return tokenCalls === 1 ? 'initial-secret-token' : 'refreshed-secret-token';
    },
    sendRequest: async () => {
      requests += 1;
      return requests === 1
        ? { statusCode: 401, body: '{"error":"expired"}', headers: {} }
        : { statusCode: 200, body: '{"value":[]}', headers: {} };
    },
    nowMs: () => {
      clock += 5;
      return clock;
    },
    onTelemetry: (event) => events.push(event),
  });

  const result = await request(
    'GET',
    "EntityDefinitions(LogicalName='new_item')/Attributes?$select=LogicalName",
  );

  assert.equal(result.status, 200);
  assert.equal(requests, 2);
  assert.equal(tokenCalls, 2);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    method: 'GET',
    category: 'attributes',
    table: 'new_item',
    metadataType: null,
    status: 200,
    durationMs: 15,
    responseBytes: 31,
    attempts: 2,
    retryCount: 1,
    rateLimited: false,
    tokenAcquisitionCount: 1,
    tokenRefreshCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(events), /secret-token|Authorization/i);
});

test('concurrent 401 responses share one token refresh', async () => {
  const events = [];
  let tokenCalls = 0;
  const attempts = new Map();
  const request = createDataverseRequestExecutor({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    getToken: async () => {
      tokenCalls += 1;
      return tokenCalls === 1 ? 'initial' : 'refreshed';
    },
    sendRequest: async (_envUrl, _method, apiPath, _body, token) => {
      const count = (attempts.get(apiPath) || 0) + 1;
      attempts.set(apiPath, count);
      await Promise.resolve();
      return token === 'initial'
        ? { statusCode: 401, body: '', headers: {} }
        : { statusCode: 200, body: '{"value":[]}', headers: {} };
    },
    onTelemetry: (event) => events.push(event),
  });

  await Promise.all([
    request('GET', "EntityDefinitions(LogicalName='new_a')/Attributes"),
    request('GET', "EntityDefinitions(LogicalName='new_b')/Attributes"),
  ]);

  assert.equal(tokenCalls, 2);
  assert.equal(request.getAuthStats().tokenRefreshCount, 1);
  assert.equal(events.length, 2);
  assert.equal(events.reduce((total, event) => total + event.retryCount, 0), 2);
  assert.equal(events.reduce(
    (total, event) => total + event.tokenAcquisitionCount,
    0,
  ), 1);
  assert.equal(events.reduce((total, event) => total + event.tokenRefreshCount, 0), 1);
});

test('telemetry callback failure does not change request success', async () => {
  const request = createDataverseRequestExecutor({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    getToken: async () => 'token',
    sendRequest: async () => ({ statusCode: 200, body: '{"value":[]}', headers: {} }),
    onTelemetry: () => {
      throw new Error('telemetry sink failed');
    },
  });

  assert.equal((await request('GET', 'EntityDefinitions')).status, 200);
});