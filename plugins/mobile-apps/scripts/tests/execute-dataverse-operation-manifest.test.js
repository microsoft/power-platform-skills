'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  executeManifest,
  executionCounts,
  validateExecutableManifest,
} = require('../execute-dataverse-operation-manifest');
const { sha256, stableJson } = require('../build-dataverse-operation-manifest');

const ENVIRONMENT_URL = 'https://example.crm.dynamics.com';
const RECONCILIATION_HASH = 'b'.repeat(64);

function operation(index, phase, id) {
  return {
    index,
    id,
    phase,
    method: 'POST',
    apiPath: phase === 'publish' ? 'PublishXml' : 'EntityDefinitions',
    body: { id },
    solution: 'Default',
  };
}

function manifest() {
  const phases = [
    { name: 'tableCreates', operations: [operation(0, 'tableCreates', 'table')] },
    { name: 'extensions', operations: [operation(1, 'extensions', 'column')] },
    { name: 'relationships', operations: [operation(2, 'relationships', 'relationship')] },
    { name: 'alternateKeys', operations: [operation(3, 'alternateKeys', 'key')] },
    { name: 'publish', operations: [operation(4, 'publish', 'publish')] },
  ];
  const value = {
    schemaVersion: 2,
    executable: true,
    binding: {
      environmentUrl: ENVIRONMENT_URL,
      tenantId: 'tenant-1',
      solutionUniqueName: 'Default',
      reconciliationSha256: RECONCILIATION_HASH,
    },
    execution: {
      executor: 'BATCH-METADATA',
      parallelWrites: false,
      odataBatch: false,
      phases,
    },
  };
  value.integritySha256 = sha256(stableJson(value));
  return value;
}

function scratch(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-executor-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('manifest validation rejects tampering and context drift before authentication', () => {
  const valid = manifest();
  assert.equal(validateExecutableManifest(valid, {
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
  }).valid, true);

  const tampered = structuredClone(valid);
  tampered.execution.phases[0].operations[0].body.id = 'tampered';
  assert.match(
    validateExecutableManifest(tampered, {
      environmentUrl: ENVIRONMENT_URL,
      solution: 'Default',
    }).errors.join('; '),
    /integrity hash/,
  );
  assert.match(
    validateExecutableManifest(valid, {
      environmentUrl: 'https://other.crm.dynamics.com',
      solution: 'Default',
    }).errors.join('; '),
    /environment URL/,
  );
});

test('zero-operation rerun completes without authentication or cleanup', async (context) => {
  const directory = scratch(context);
  const checkpoint = path.join(directory, 'publish.json');
  const cache = path.join(directory, 'inventory.json');
  fs.writeFileSync(checkpoint, '{}');
  fs.writeFileSync(cache, '{}');
  const value = manifest();
  value.execution.phases.forEach((phase) => { phase.operations = []; });
  delete value.integritySha256;
  value.integritySha256 = sha256(stableJson(value));
  let tokenCalls = 0;
  let phaseCalls = 0;

  const result = await executeManifest({
    manifest: value,
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
    journalPath: path.join(directory, 'journal.json'),
    publishCheckpointPath: checkpoint,
    inventoryCachePath: cache,
    getToken: async () => { tokenCalls += 1; return 'token'; },
    runPhase: async () => { phaseCalls += 1; return { failed: false, results: [] }; },
  });

  assert.equal(result.counts.operations, 0);
  assert.equal(tokenCalls, 0);
  assert.equal(phaseCalls, 0);
  assert.equal(fs.existsSync(checkpoint), true);
  assert.equal(fs.existsSync(cache), true);
});

test('executor runs complete phases sequentially with one token and success-only cleanup', async (context) => {
  const directory = scratch(context);
  const checkpoint = path.join(directory, 'publish.json');
  const cache = path.join(directory, 'inventory.json');
  fs.writeFileSync(checkpoint, '{}');
  fs.writeFileSync(cache, '{}');
  let tokenCalls = 0;
  const phaseCalls = [];
  const result = await executeManifest({
    manifest: manifest(),
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
    journalPath: path.join(directory, 'journal.json'),
    publishCheckpointPath: checkpoint,
    inventoryCachePath: cache,
    getToken: async () => {
      tokenCalls += 1;
      return 'token-0';
    },
    runPhase: async (_url, operations, token) => {
      phaseCalls.push({ phase: operations[0].phase, token });
      return {
        failed: false,
        token: `token-${phaseCalls.length}`,
        results: operations.map((item) => ({
          index: item.index,
          operationId: item.id,
          status: 204,
        })),
      };
    },
    nowMs: (() => {
      let value = 0;
      return () => value += 10;
    })(),
  });

  assert.equal(tokenCalls, 1);
  assert.deepEqual(phaseCalls, [
    { phase: 'tableCreates', token: 'token-0' },
    { phase: 'extensions', token: 'token-1' },
    { phase: 'relationships', token: 'token-2' },
    { phase: 'alternateKeys', token: 'token-3' },
    { phase: 'publish', token: 'token-4' },
  ]);
  assert.deepEqual(result.counts, {
    operations: 5,
    tableCreates: 1,
    extensions: 1,
    relationships: 1,
    alternateKeys: 1,
    publish: 1,
  });
  assert.equal(fs.existsSync(checkpoint), false);
  assert.equal(fs.existsSync(cache), false);
});

test('failed phase stops later operations and preserves publish and cache state', async (context) => {
  const directory = scratch(context);
  const checkpoint = path.join(directory, 'publish.json');
  const cache = path.join(directory, 'inventory.json');
  fs.writeFileSync(checkpoint, '{}');
  fs.writeFileSync(cache, '{}');
  const calls = [];

  await assert.rejects(() => executeManifest({
    manifest: manifest(),
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
    journalPath: path.join(directory, 'journal.json'),
    publishCheckpointPath: checkpoint,
    inventoryCachePath: cache,
    getToken: async () => 'token',
    runPhase: async (_url, operations) => {
      calls.push(operations[0].phase);
      if (operations[0].phase === 'extensions') {
        return {
          failed: true,
          token: 'token',
          results: [{ index: 1, operationId: 'column', status: 400, error: 'invalid' }],
        };
      }
      return { failed: false, token: 'token', results: [] };
    },
  }), /phase extensions failed at column: invalid/);

  assert.deepEqual(calls, ['tableCreates', 'extensions']);
  assert.equal(fs.existsSync(checkpoint), true);
  assert.equal(fs.existsSync(cache), true);
});

test('publish completion fails when inventory cache invalidation cannot be confirmed', async (context) => {
  const directory = scratch(context);
  const checkpoint = path.join(directory, 'publish.json');
  const cache = path.join(directory, 'inventory.json');
  fs.writeFileSync(checkpoint, '{}');
  fs.writeFileSync(cache, '{}');

  await assert.rejects(executeManifest({
    manifest: manifest(),
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
    journalPath: path.join(directory, 'journal.json'),
    publishCheckpointPath: checkpoint,
    inventoryCachePath: cache,
    getToken: async () => 'token',
    runPhase: async () => ({ failed: false, token: 'token', results: [] }),
    invalidateCache: () => false,
  }), /Failed to invalidate Dataverse inventory cache/);
  assert.equal(fs.existsSync(checkpoint), true);
  assert.equal(fs.existsSync(cache), true);
});

test('workload counts scale with actual operations rather than table count alone', () => {
  const value = manifest();
  value.execution.phases[1].operations.push(operation(5, 'extensions', 'column-2'));
  assert.deepEqual(executionCounts(value.execution.phases), {
    operations: 6,
    tableCreates: 1,
    extensions: 2,
    relationships: 1,
    alternateKeys: 1,
    publish: 1,
  });
});