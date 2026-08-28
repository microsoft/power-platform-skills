'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createDataverseRequestExecutor,
  metadataRequestIdentity,
  metadataOperationClass,
  operationTimeoutMs,
} = require('../dataverse-request');

test('metadata operation classes own bounded timeout defaults', () => {
  assert.equal(metadataOperationClass('GET', 'EntityDefinitions'), 'read');
  assert.equal(metadataOperationClass('POST', 'EntityDefinitions'), 'table-write');
  assert.equal(
    metadataOperationClass('POST', "EntityDefinitions(LogicalName='new_item')/Attributes"),
    'column-write',
  );
  assert.equal(
    metadataOperationClass('POST', 'RelationshipDefinitions'),
    'relationship-or-key-write',
  );
  assert.equal(
    metadataOperationClass('POST', "EntityDefinitions(LogicalName='new_item')/Keys"),
    'relationship-or-key-write',
  );
  assert.equal(metadataOperationClass('POST', 'PublishXml'), 'publish');
  assert.equal(operationTimeoutMs('GET', 'EntityDefinitions'), 60000);
  assert.equal(operationTimeoutMs('POST', 'EntityDefinitions'), 120000);
  assert.equal(operationTimeoutMs('POST', 'RelationshipDefinitions'), 90000);
  assert.equal(operationTimeoutMs('POST', 'PublishXml'), 120000);
  assert.equal(operationTimeoutMs('POST', 'EntityDefinitions', 45000), 45000);
  for (const value of [0, 999, 600001, 1.5, 'invalid']) {
    assert.throws(
      () => operationTimeoutMs('GET', 'EntityDefinitions', value),
      /timeout must be an integer from 1000 to 600000 milliseconds/,
    );
  }
});

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
    sendRequest: async (...args) => {
      requests += 1;
      assert.equal(args[7], 60000);
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
    operationClass: 'read',
    requestedTimeoutMs: 60000,
  });
  assert.doesNotMatch(JSON.stringify(events), /secret-token|Authorization/i);
});

test('request executor applies a bounded timeout override', async () => {
  const timeouts = [];
  const request = createDataverseRequestExecutor({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    timeoutMs: 45000,
    getToken: async () => 'token',
    sendRequest: async (...args) => {
      timeouts.push(args[7]);
      return { statusCode: 204, body: '', headers: {} };
    },
  });
  assert.equal((await request('POST', 'EntityDefinitions', {})).status, 204);
  assert.deepEqual(timeouts, [45000]);
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