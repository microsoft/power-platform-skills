'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  adaptiveReadRequest,
  createSnapshot,
  mapWithConcurrency,
  parseReadConcurrency,
} = require('../create-dataverse-snapshot');
const { createDataverseRequestExecutor } = require('../dataverse-request');

function label(value) {
  return { UserLocalizedLabel: { Label: value } };
}

function entity(logicalName) {
  const displayName = logicalName.replace(/^new_/, '');
  return {
    LogicalName: logicalName,
    SchemaName: logicalName,
    EntitySetName: `${logicalName}s`,
    DisplayName: label(displayName),
    DisplayCollectionName: label(`${displayName}s`),
    Description: label(`${displayName} records`),
    PrimaryIdAttribute: `${logicalName}id`,
    PrimaryNameAttribute: 'new_name',
    OwnershipType: 'UserOwned',
    IsCustomEntity: true,
    IsManaged: false,
    IsCustomizable: { Value: true },
    CanCreateAttributes: { Value: true },
  };
}

test('mapWithConcurrency preserves input order and respects its cap', async () => {
  let active = 0;
  let maximumActive = 0;
  const result = await mapWithConcurrency([3, 2, 1, 0], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 2;
  });
  assert.equal(maximumActive, 2);
  assert.deepEqual(result, [6, 4, 2, 0]);
});

test('mapWithConcurrency honors a reduced dynamic cap before dispatching more work', async () => {
  let cap = 2;
  let releaseSecond;
  const secondBlocked = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const started = [];
  const execution = mapWithConcurrency([0, 1, 2], 2, async (value) => {
    started.push(value);
    if (value === 0) {
      cap = 1;
      return value;
    }
    if (value === 1) await secondBlocked;
    return value;
  }, { currentConcurrency: () => cap });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  releaseSecond();
  assert.deepEqual(await execution, [0, 1, 2]);
});

test('adaptive reads halve the cap after rate limiting', async () => {
  let calls = 0;
  const adaptive = adaptiveReadRequest(async () => {
    calls += 1;
    return { status: 200, rateLimited: calls <= 2 };
  }, 4);
  await adaptive.request('GET', 'one');
  assert.equal(adaptive.currentConcurrency(), 2);
  await adaptive.request('GET', 'two');
  assert.equal(adaptive.currentConcurrency(), 1);
  await adaptive.request('GET', 'three');
  assert.equal(adaptive.currentConcurrency(), 1);
});

test('adaptive reads reduce the cap before a throttled retry sleeps', async () => {
  let requestCount = 0;
  let releaseSleep;
  const sleeping = new Promise((resolve) => {
    releaseSleep = resolve;
  });
  const request = createDataverseRequestExecutor({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    getToken: async () => 'token',
    sendRequest: async () => {
      requestCount += 1;
      return requestCount === 1
        ? { statusCode: 429, body: '', headers: { 'retry-after': '1' } }
        : { statusCode: 200, body: '{"value":[]}', headers: {} };
    },
    sleep: () => sleeping,
  });
  const adaptive = adaptiveReadRequest(request, 4);
  const pending = adaptive.request('GET', 'EntityDefinitions');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adaptive.currentConcurrency(), 2);
  releaseSleep();
  await pending;
  assert.equal(adaptive.currentConcurrency(), 2);
  adaptive.dispose();
});

test('read concurrency rejects invalid values and defaults to one', () => {
  assert.equal(parseReadConcurrency(undefined), 1);
  assert.equal(parseReadConcurrency('4'), 4);
  for (const value of [0, -1, 1.5, 9, 'invalid']) {
    assert.throws(() => parseReadConcurrency(value), /integer from 1 to 8/);
  }
});

test('concurrency one and four produce identical normalized snapshot evidence', async () => {
  const entities = ['new_alpha', 'new_beta', 'new_gamma', 'new_delta'].map(entity);
  const request = async (_method, apiPath) => {
    if (apiPath.startsWith('EntityDefinitions?')) {
      return { status: 200, data: { value: entities } };
    }
    if (apiPath.includes('/Attributes?$select=')) {
      return { status: 200, data: { value: [{
        MetadataId: 'name-id',
        LogicalName: 'new_name',
        SchemaName: 'new_Name',
        AttributeType: 'String',
        AttributeTypeName: { Value: 'StringType' },
        IsPrimaryName: true,
        SourceType: 0,
      }] } };
    }
    if (apiPath.includes('StringAttributeMetadata')) {
      return { status: 200, data: { value: [{ LogicalName: 'new_name', MaxLength: 100 }] } };
    }
    return { status: 200, data: { value: [] } };
  };
  const options = {
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    concepts: ['alpha', 'beta', 'gamma', 'delta'],
    nowIso: () => '2026-08-28T00:00:00.000Z',
    request,
  };
  const sequential = await createSnapshot({ ...options, readConcurrency: 1 });
  const concurrent = await createSnapshot({ ...options, readConcurrency: 4 });
  assert.deepEqual(concurrent.tables, sequential.tables);
  assert.deepEqual(concurrent.candidateRanking, sequential.candidateRanking);
  assert.deepEqual(concurrent.selectedCandidateEvidence, sequential.selectedCandidateEvidence);
  assert.equal(concurrent.detailLoadSummary.readConcurrency, 4);
  assert.equal(concurrent.detailLoadSummary.finalReadConcurrency, 4);
});

test('concurrent advisory failures are recorded and all pooled requests are GET-only', async () => {
  const entities = ['new_alpha', 'new_beta'].map(entity);
  const methods = [];
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    concepts: [
      { phrase: 'alpha', kind: 'entity', discoverTable: true, evidence: 'alpha' },
      { phrase: 'beta', kind: 'entity', discoverTable: true, evidence: 'beta' },
    ],
    readConcurrency: 2,
    request: async (method, apiPath) => {
      methods.push(method);
      if (apiPath.startsWith('EntityDefinitions?')) {
        return { status: 200, data: { value: entities } };
      }
      if (apiPath.includes("LogicalName='new_beta'") && apiPath.includes('/Attributes?')) {
        return { status: 500, error: 'planned advisory failure' };
      }
      return { status: 200, data: { value: [] } };
    },
  });
  assert.deepEqual(snapshot.tables.map((table) => table.logicalName), ['new_alpha']);
  assert.deepEqual(
    snapshot.detailLoadFailures.map((failure) => failure.logicalName),
    ['new_beta'],
  );
  assert.deepEqual(new Set(methods), new Set(['GET']));
});

test('concurrent required detail failures remain explicit and non-executable', async () => {
  const entities = ['new_alpha', 'new_beta'].map(entity);
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    tableNames: ['new_beta'],
    readConcurrency: 2,
    request: async (method, apiPath) => {
      assert.equal(method, 'GET');
      if (apiPath.startsWith('EntityDefinitions?')) {
        return { status: 200, data: { value: entities } };
      }
      if (apiPath.includes("LogicalName='new_beta'") && apiPath.includes('/Attributes?')) {
        return { status: 500, error: 'planned required failure' };
      }
      return { status: 200, data: { value: [] } };
    },
  });

  assert.deepEqual(snapshot.tables, []);
  assert.deepEqual(snapshot.detailLoadFailures, [{
    logicalName: 'new_beta',
    selectionReasons: ['explicit-table'],
    status: 500,
    error: 'planned required failure',
    required: true,
  }]);
  assert.deepEqual(snapshot.exactNameResolution.loadedTables, ['new_beta']);
});