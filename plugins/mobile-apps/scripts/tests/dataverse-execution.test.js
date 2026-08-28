'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  executeValidatedManifest,
} = require('../execute-dataverse-plan');

function manifest() {
  const operations = [
    { id: 'create-table:new_item', index: 0, phase: 'tableCreates', method: 'POST', apiPath: 'EntityDefinitions' },
    { id: 'publish-customizations', index: 1, phase: 'publish', method: 'POST', apiPath: 'PublishXml' },
  ];
  return {
    integritySha256: 'a'.repeat(64),
    binding: {
      environmentUrl: 'https://example.crm.dynamics.com',
      solutionUniqueName: 'Default',
      reconciliationSha256: 'b'.repeat(64),
    },
    execution: {
      phases: [
        { name: 'tableCreates', operations: operations.slice(0, 1) },
        { name: 'extensions', operations: [] },
        { name: 'relationships', operations: [] },
        { name: 'alternateKeys', operations: [] },
        { name: 'publish', operations: operations.slice(1) },
      ],
    },
  };
}

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-execution-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checkpointPath = path.join(directory, 'publish.json');
  const journalPath = path.join(directory, 'journal.json');
  const outcomePath = path.join(directory, 'outcome.json');
  const timingsPath = path.join(directory, 'timings.json');
  fs.writeFileSync(checkpointPath, '{}');
  return { checkpointPath, journalPath, outcomePath, timingsPath };
}

test('validated manifest phases execute sequentially and invalidate cache after publish', async (context) => {
  const files = fixture(context);
  const calls = [];
  let invalidations = 0;
  const result = await executeValidatedManifest({
    manifest: manifest(),
    manifestPath: '/manifest.json',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    solution: 'Default',
    journalPath: files.journalPath,
    checkpointPath: files.checkpointPath,
    outcomePath: files.outcomePath,
    timingsPath: files.timingsPath,
    getToken: async () => 'token',
    runPhase: async (_url, operations) => {
      calls.push(operations[0].phase);
      return {
        failed: false,
        results: operations.map((operation) => ({
          index: operation.index,
          status: 204,
          operationId: operation.id,
          operationClass: operation.phase === 'publish' ? 'publish' : 'table-write',
          requestedTimeoutMs: 120000,
          durationMs: 1,
        })),
      };
    },
    invalidateCache: () => { invalidations += 1; },
  });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(calls, ['tableCreates', 'publish']);
  assert.equal(invalidations, 1);
  assert.equal(fs.existsSync(files.checkpointPath), false);
  assert.equal(JSON.parse(fs.readFileSync(files.outcomePath, 'utf8')).status, 'DONE');
  const timings = JSON.parse(fs.readFileSync(files.timingsPath, 'utf8'));
  assert.equal(timings.stages.metadataWrite.history.length, 1);
  assert.equal(timings.stages.publish.history.length, 1);
});

test('uncertain mutation stops later phases and requires fresh reconciliation', async (context) => {
  const files = fixture(context);
  const calls = [];
  const result = await executeValidatedManifest({
    manifest: manifest(),
    manifestPath: '/manifest.json',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    solution: 'Default',
    journalPath: files.journalPath,
    checkpointPath: files.checkpointPath,
    outcomePath: files.outcomePath,
    getToken: async () => 'token',
    runPhase: async (_url, operations) => {
      calls.push(operations[0].phase);
      return {
        failed: true,
        results: [{ index: 0, status: 0, uncertain: true, error: 'timeout' }],
      };
    },
    readJournal: () => ({ inFlight: { failure: { uncertain: true } } }),
  });
  assert.equal(result.status, 'UNCERTAIN_RECONCILIATION_REQUIRED');
  assert.deepEqual(calls, ['tableCreates']);
  assert.equal(fs.existsSync(files.checkpointPath), true);
});

test('hidden collision returns bounded immutable adaptation evidence', async (context) => {
  const files = fixture(context);
  const result = await executeValidatedManifest({
    manifest: manifest(),
    manifestPath: '/manifest.json',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    solution: 'Default',
    journalPath: files.journalPath,
    checkpointPath: files.checkpointPath,
    outcomePath: files.outcomePath,
    getToken: async () => 'token',
    runPhase: async () => ({
      failed: true,
      results: [{ index: 0, status: 400, error: '0x80044363' }],
    }),
    readJournal: () => ({
      inFlight: {
        operationId: 'create-table:new_item',
        fingerprint: 'c'.repeat(64),
        manifestHash: 'a'.repeat(64),
        reconciliationHash: 'b'.repeat(64),
        failure: {
          collision: true,
          status: 400,
          error: null,
          collisionCode: '0x80044363',
          recordedAt: '2026-08-29T00:00:00.000Z',
        },
      },
    }),
  });
  assert.equal(result.status, 'COLLISION_ADAPTATION_REQUIRED');
  assert.deepEqual(result.collisionEvidence, {
    code: '0x80044363',
    operationId: 'create-table:new_item',
    operationFingerprint: 'c'.repeat(64),
    priorManifestSha256: 'a'.repeat(64),
    priorReconciliationSha256: 'b'.repeat(64),
    observedAt: '2026-08-29T00:00:00.000Z',
  });
});

test('publish failure retains checkpoint and does not invalidate cache', async (context) => {
  const files = fixture(context);
  let invalidations = 0;
  const result = await executeValidatedManifest({
    manifest: manifest(),
    manifestPath: '/manifest.json',
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    solution: 'Default',
    journalPath: files.journalPath,
    checkpointPath: files.checkpointPath,
    outcomePath: files.outcomePath,
    getToken: async () => 'token',
    runPhase: async (_url, operations) => operations[0].phase === 'publish'
      ? { failed: true, results: [{ index: 1, status: 500, error: 'publish failed' }] }
      : { failed: false, results: [{ index: 0, status: 204 }] },
    invalidateCache: () => { invalidations += 1; },
    readJournal: () => ({ inFlight: { failure: { status: 500 } } }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.stage, 'publish');
  assert.equal(invalidations, 0);
  assert.equal(fs.existsSync(files.checkpointPath), true);
});

test('add-dataverse valid path delegates all phases to deterministic execution', () => {
  const skill = fs.readFileSync(path.resolve(
    __dirname,
    '../../skills/add-dataverse/SKILL.md',
  ), 'utf8');
  const start = skill.indexOf('#### Valid operation-manifest execution branch');
  const end = skill.indexOf('**Print before starting:**', start);
  const validPath = skill.slice(start, end);
  assert.match(validPath, /execute-dataverse-plan\.js/);
  assert.match(validPath, /UNCERTAIN_RECONCILIATION_REQUIRED/);
  assert.match(validPath, /COLLISION_ADAPTATION_REQUIRED/);
    assert.doesNotMatch(validPath, /dataverse-request\.js.*BATCH-METADATA/s);
});

  test('add-dataverse valid path uses targeted post-publish verification', () => {
    const skill = fs.readFileSync(path.resolve(
      __dirname,
      '../../skills/add-dataverse/SKILL.md',
    ), 'utf8');
    assert.match(skill, /verify-dataverse-post-publish\.js/);
    assert.match(skill, /DONE_WITH_PENDING_ACTIVATIONS/);
    assert.match(skill, /checks\s+only changed tables, columns, relationships/s);
    assert.match(skill, /DATAVERSE_TIMINGS_PATH/);
    assert.equal((skill.match(/--timings-output/g) || []).length >= 2, true);
    assert.match(skill, /--stage uncertainRecovery/);
    assert.match(skill, /--stage collisionAdaptation/);
  });
