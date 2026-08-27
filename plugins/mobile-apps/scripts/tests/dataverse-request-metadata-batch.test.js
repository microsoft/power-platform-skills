const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(__dirname, '..', 'dataverse-request.js');
const fakeAzPreload = path.join(__dirname, 'helpers', 'fake-az-preload.js');
const {
  createDataverseRequestExecutor,
  looksLikeDuplicate,
  operationFingerprint,
  prepareMetadataJournal,
  retryAfterDelayMs,
  runMetadataBatch,
  runOneMetadataOperation,
  validateManifestExecutionBinding,
  validateJournalOperations,
} = require('../dataverse-request');

function manifestStableJson(value) {
  function clone(item) {
    if (Array.isArray(item)) return item.map(clone);
    if (!item || typeof item !== 'object') return item;
    return Object.keys(item).sort().reduce((result, key) => {
      result[key] = clone(item[key]);
      return result;
    }, {});
  }
  return `${JSON.stringify(clone(value), null, 2)}\n`;
}

function executionManifest(phaseOperations, {
  environmentUrl = 'https://example.crm.dynamics.com',
  solutionUniqueName = null,
  reconciliationSha256 = 'b'.repeat(64),
} = {}) {
  const phaseNames = [
    'tableCreates',
    'extensions',
    'relationships',
    'alternateKeys',
    'publish',
  ];
  const manifest = {
    schemaVersion: 2,
    executable: true,
    binding: {
      environmentUrl,
      solutionUniqueName,
      reconciliationSha256,
    },
    execution: {
      executor: 'BATCH-METADATA',
      odataBatch: false,
      parallelWrites: false,
      phases: phaseNames.map((name) => ({
        name,
        operations: phaseOperations[name] || [],
      })),
    },
  };
  manifest.integritySha256 = crypto.createHash('sha256')
    .update(manifestStableJson(manifest))
    .digest('hex');
  return manifest;
}

test('Retry-After supports delta-seconds and HTTP-date with a safe fallback', () => {
  assert.equal(retryAfterDelayMs('7', 30000), 7000);
  assert.equal(
    retryAfterDelayMs('Wed, 19 Aug 2026 00:00:05 GMT', 30000, Date.parse(
      'Wed, 19 Aug 2026 00:00:00 GMT',
    )),
    5000,
  );
  assert.equal(retryAfterDelayMs('invalid', 30000), 30000);
  assert.equal(retryAfterDelayMs(undefined, 5000), 5000);
  assert.equal(retryAfterDelayMs('invalid', -1), 30000);
  const offlineUpdater = fs.readFileSync(path.join(
    __dirname,
    '../update-entity-offline-flags.js',
  ), 'utf8');
  assert.match(offlineUpdater, /require\('\.\/dataverse-request'\)/);
  assert.match(
    offlineUpdater,
    /await new Promise\(\(r\) => setTimeout\(r, delayMs\)\)/,
  );
});

test('hidden Dataverse metadata collision signatures require regeneration', () => {
  assert.equal(looksLikeDuplicate({
    error: {
      code: '0x80044363',
      message: 'The schema name new_Table is not unique',
    },
  }), true);
  assert.equal(looksLikeDuplicate({
    error: {
      code: '0x80060890',
      message: 'An object with same name exists in solution',
    },
  }), true);
});

test('operation fingerprints ignore reindexing while order is validated separately', () => {
  const operation = {
    id: 'create-table:cr1_item',
    index: 4,
    method: 'POST',
    apiPath: 'EntityDefinitions',
    body: { SchemaName: 'cr1_Item' },
  };
  assert.equal(
    operationFingerprint(operation, 'Default'),
    operationFingerprint({ ...operation, index: 0 }, 'Default'),
  );
  assert.throws(
    () => validateJournalOperations([
      { ...operation, index: 0 },
      { ...operation, index: 1 },
    ], 'Default'),
    /duplicate stable operation identity/,
  );
  assert.throws(
    () => validateJournalOperations([
      { ...operation, index: 1 },
    ], 'Default'),
    /indexes must be unique and ordered from zero/,
  );
});

test('manifest execution requires exact phase membership and completed predecessors', () => {
  const first = {
    id: 'create-table:cr1_item',
    index: 0,
    phase: 'tableCreates',
    method: 'POST',
    apiPath: 'EntityDefinitions',
    body: { SchemaName: 'cr1_Item' },
    solution: 'Default',
  };
  const second = {
    id: 'extend-column:cr1_item:cr1_code',
    index: 1,
    phase: 'extensions',
    method: 'POST',
    apiPath: "EntityDefinitions(LogicalName='cr1_item')/Attributes",
    body: { SchemaName: 'cr1_Code' },
    solution: 'Default',
  };
  const manifest = executionManifest({
    tableCreates: [first],
    extensions: [second],
  }, {
    solutionUniqueName: 'Default',
  });
  assert.throws(
    () => validateManifestExecutionBinding({
      manifest,
      manifestHash: manifest.integritySha256,
      selectedOperations: [{ ...second, body: { SchemaName: 'cr1_Tampered' } }],
      completeOperations: [first, second],
      defaultSolution: 'Default',
      environmentUrl: 'https://example.crm.dynamics.com',
      reconciliationHash: 'b'.repeat(64),
      journal: { completed: {} },
    }),
    /not an exact manifest phase/,
  );
  assert.throws(
    () => validateManifestExecutionBinding({
      manifest,
      manifestHash: manifest.integritySha256,
      selectedOperations: [second],
      completeOperations: [first, second],
      defaultSolution: 'Default',
      environmentUrl: 'https://example.crm.dynamics.com',
      reconciliationHash: 'b'.repeat(64),
      journal: { completed: {} },
    }),
    /predecessor create-table:cr1_item is not journal-complete/,
  );
  assert.doesNotThrow(() => validateManifestExecutionBinding({
    manifest,
    manifestHash: manifest.integritySha256,
    selectedOperations: [second],
    completeOperations: [first, second],
    defaultSolution: 'Default',
    environmentUrl: 'https://example.crm.dynamics.com',
    reconciliationHash: 'b'.repeat(64),
    journal: {
      completed: {
        [operationFingerprint(first, 'Default')]: { operationId: first.id },
      },
    },
  }));
  assert.throws(
    () => validateManifestExecutionBinding({
      manifest,
      manifestHash: 'a'.repeat(64),
      selectedOperations: [first],
      completeOperations: [first, second],
      defaultSolution: 'Default',
      environmentUrl: 'https://example.crm.dynamics.com',
      reconciliationHash: 'b'.repeat(64),
      journal: { completed: {} },
    }),
    /binding hash does not match/,
  );
});

function makeTempDir(t) {
  const tempDir = fs.mkdtempSync(path.join(__dirname, '.metadata-batch-scratch-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return tempDir;
}

function fakeAzEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_OPTIONS: `--require=${fakeAzPreload}`,
    FAKE_AZ_STATIC_TOKEN: 'test-token',
    ...overrides,
  };
}

test('in-process request executor reuses one token across sequential metadata reads', async () => {
  let tokenCalls = 0;
  const requests = [];
  const request = createDataverseRequestExecutor({
    environmentUrl: 'https://example.crm.dynamics.com/',
    tenantId: 'tenant-1',
    getToken: async () => {
      tokenCalls += 1;
      return 'shared-token';
    },
    sendRequest: async (_envUrl, method, apiPath, _body, token) => {
      requests.push({ method, apiPath, token });
      return {
        statusCode: 200,
        body: JSON.stringify({ value: [] }),
        headers: {},
      };
    },
  });

  await request('GET', 'EntityDefinitions');
  await request('GET', "EntityDefinitions(LogicalName='contact')/Attributes");
  await request('GET', "EntityDefinitions(LogicalName='contact')/Keys");

  assert.equal(tokenCalls, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(new Set(requests.map((item) => item.token)), new Set(['shared-token']));
});

test('metadata transport loss is uncertain and mutation is not retried', async () => {
  let requests = 0;
  const result = await runOneMetadataOperation(
    'https://example.crm.dynamics.com',
    'POST',
    'EntityDefinitions',
    JSON.stringify({ SchemaName: 'cr1_Item' }),
    'token',
    false,
    'Default',
    'tenant-1',
    async () => 'refreshed-token',
    async () => {
      requests += 1;
      return { error: 'socket closed before response' };
    },
  );
  assert.equal(requests, 1);
  assert.equal(result.status, 0);
  assert.equal(result.uncertain, true);
  assert.match(result.error, /socket closed/);

  let reads = 0;
  const readResult = await runOneMetadataOperation(
    'https://example.crm.dynamics.com',
    'GET',
    'EntityDefinitions',
    null,
    'token',
    false,
    'Default',
    'tenant-1',
    async () => 'refreshed-token',
    async () => {
      reads += 1;
      return reads === 1
        ? { error: 'temporary read transport loss' }
        : { statusCode: 200, body: '{"value":[]}', headers: {} };
    },
  );
  assert.equal(reads, 2);
  assert.equal(readResult.status, 200);
});

test('journal preserves inFlight uncertainty after metadata transport loss', async (t) => {
  const directory = makeTempDir(t);
  const journalPath = path.join(directory, 'metadata-journal.json');
  let requests = 0;
  const server = http.createServer((req) => {
    requests += 1;
    req.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const envUrl = `http://127.0.0.1:${server.address().port}`;
  const operation = {
    id: 'create-table:cr1_item',
    index: 0,
    phase: 'tableCreates',
    method: 'POST',
    apiPath: 'EntityDefinitions',
    body: { SchemaName: 'cr1_Item' },
    solution: null,
  };
  const reconciliationHash = 'b'.repeat(64);
  const manifest = executionManifest({ tableCreates: [operation] }, {
    environmentUrl: envUrl,
    reconciliationSha256: reconciliationHash,
  });
  const result = await runMetadataBatch(
    envUrl,
    [operation],
    'token',
    null,
    'tenant-1',
    false,
    {
      journalPath,
      manifestHash: manifest.integritySha256,
      reconciliationHash,
      allOperations: [operation],
      manifest,
    },
  );
  assert.equal(result.failed, true);
  assert.equal(result.results[0].uncertain, true);
  assert.equal(requests, 1);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.inFlight.operationId, operation.id);
  assert.equal(journal.inFlight.failure.uncertain, true);
});

test('BATCH-METADATA reuses auth, preserves order, and stops on first failure', async (t) => {
  const tempDir = makeTempDir(t);
  const azLog = path.join(tempDir, 'az.log');

  const requests = [];
  let active = 0;
  let maxActive = 0;
  const server = http.createServer((req, res) => {
    active++;
    maxActive = Math.max(maxActive, active);
    requests.push(req.url);
    const finish = () => {
      active--;
      if (req.url.endsWith('/two')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'planned failure' } }));
        return;
      }
      res.writeHead(204);
      res.end();
    };
    setTimeout(finish, 25);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const envUrl = `http://127.0.0.1:${server.address().port}`;
  const operations = [
    { index: 10, method: 'POST', apiPath: 'one', body: { value: 1 } },
    { index: 20, method: 'POST', apiPath: 'two', body: { value: 2 } },
    { index: 30, method: 'POST', apiPath: 'three', body: { value: 3 } },
  ];
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      envUrl,
      'BATCH-METADATA',
      'test',
      '--operations',
      JSON.stringify(operations),
      '--tenant-id',
      'explicit-tenant',
    ],
    {
      env: fakeAzEnv({
        FAKE_AZ_LOG: azLog,
      }),
    },
  );

  const output = JSON.parse(stdout);
  assert.equal(output.status, 207);
  assert.deepEqual(
    output.data.map(({ index, status }) => ({ index, status })),
    [
      { index: 10, status: 204 },
      { index: 20, status: 400 },
    ],
  );
  assert.equal(requests.length, 2);
  assert.match(requests[0], /\/api\/data\/v9\.2\/one$/);
  assert.match(requests[1], /\/api\/data\/v9\.2\/two$/);
  assert.equal(maxActive, 1);

  const authCalls = fs.readFileSync(azLog, 'utf8').trim().split('\n');
  assert.equal(authCalls.length, 1);
  assert.match(authCalls[0], /--tenant explicit-tenant/);
});

test('BATCH-METADATA atomically journals each completed manifest operation', async (t) => {
  const directory = makeTempDir(t);
  const journalPath = path.join(directory, 'metadata-journal.json');
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const envUrl = `http://127.0.0.1:${server.address().port}`;
  const operations = [
    {
      id: 'create-table:one',
      index: 0,
      phase: 'tableCreates',
      method: 'POST',
      apiPath: 'one',
      body: { a: 1 },
    },
    {
      id: 'create-table:two',
      index: 1,
      phase: 'tableCreates',
      method: 'POST',
      apiPath: 'two',
      body: { a: 2 },
    },
  ];
  const manifest = executionManifest({ tableCreates: operations }, {
    environmentUrl: envUrl,
  });
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const manifestHash = manifest.integritySha256;
  const reconciliationHash = 'b'.repeat(64);
  const args = [
    scriptPath,
    envUrl,
    'BATCH-METADATA',
    'journal',
    '--operations',
    JSON.stringify(operations),
    '--tenant-id',
    'explicit-tenant',
    '--journal',
    journalPath,
    '--manifest-file',
    manifestPath,
    '--manifest-hash',
    manifestHash,
    '--reconciliation-hash',
    reconciliationHash,
    '--manifest-operations',
    JSON.stringify(operations),
  ];
  const first = await execFileAsync(process.execPath, args, { env: fakeAzEnv() });
  assert.equal(JSON.parse(first.stdout).status, 200);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.inFlight, null);
  assert.equal(Object.keys(journal.completed).length, 2);
  assert.equal(requestCount, 2);

  const second = await execFileAsync(process.execPath, args, { env: fakeAzEnv() });
  assert.deepEqual(
    JSON.parse(second.stdout).data.map((result) => result.journalStatus),
    ['already-completed', 'already-completed'],
  );
  assert.equal(requestCount, 2);
});

test('BATCH-METADATA requires fresh reconciliation before uncertain-operation resume', async (t) => {
  const directory = makeTempDir(t);
  const journalPath = path.join(directory, 'metadata-journal.json');
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const envUrl = `http://127.0.0.1:${server.address().port}`;
  const operation = {
    id: 'create-table:uncertain',
    index: 0,
    phase: 'tableCreates',
    method: 'POST',
    apiPath: 'EntityDefinitions',
    body: { SchemaName: 'cr1_uncertain' },
  };
  const oldManifest = executionManifest({ tableCreates: [operation] }, {
    environmentUrl: envUrl,
    reconciliationSha256: 'd'.repeat(64),
  });
  const oldManifestPath = path.join(directory, 'old-manifest.json');
  fs.writeFileSync(oldManifestPath, JSON.stringify(oldManifest));
  const oldManifestHash = oldManifest.integritySha256;
  const oldReconciliationHash = 'd'.repeat(64);
  const fingerprint = operationFingerprint(operation);
  fs.writeFileSync(journalPath, JSON.stringify({
    schemaVersion: 1,
    binding: { environmentUrl: envUrl, solution: null },
    completed: {},
    recoveries: [],
    inFlight: {
      index: 0,
      operationId: operation.id,
      fingerprint,
      manifestHash: oldManifestHash,
      reconciliationHash: oldReconciliationHash,
      startedAt: '2026-08-19T00:00:00.000Z',
    },
  }));

  const stale = await execFileAsync(process.execPath, [
    scriptPath,
    envUrl,
    'BATCH-METADATA',
    'resume',
    '--operations',
    JSON.stringify([operation]),
    '--tenant-id',
    'explicit-tenant',
    '--journal',
    journalPath,
    '--manifest-file',
    oldManifestPath,
    '--manifest-hash',
    oldManifestHash,
    '--reconciliation-hash',
    oldReconciliationHash,
    '--manifest-operations',
    JSON.stringify([operation]),
  ], { env: fakeAzEnv() });
  const staleOutput = JSON.parse(stale.stdout);
  assert.equal(staleOutput.status, 207);
  assert.match(staleOutput.data[0].error, /UNCERTAIN_METADATA_OPERATION/);
  assert.equal(requestCount, 0);

  const recoveredManifest = executionManifest({}, {
    environmentUrl: envUrl,
    reconciliationSha256: 'f'.repeat(64),
  });
  const recoveredManifestPath = path.join(directory, 'recovered-manifest.json');
  fs.writeFileSync(recoveredManifestPath, JSON.stringify(recoveredManifest));
  const recovered = await execFileAsync(process.execPath, [
    scriptPath,
    envUrl,
    'BATCH-METADATA',
    'resume',
    '--operations',
    '[]',
    '--tenant-id',
    'explicit-tenant',
    '--journal',
    journalPath,
    '--manifest-file',
    recoveredManifestPath,
    '--manifest-hash',
    recoveredManifest.integritySha256,
    '--reconciliation-hash',
    'f'.repeat(64),
  ], { env: fakeAzEnv() });
  const recoveredOutput = JSON.parse(recovered.stdout);
  assert.equal(recoveredOutput.status, 200);
  assert.equal(
    recoveredOutput.data[0].journalStatus,
    'fresh-reconciliation-confirmed-already-applied-or-superseded',
  );
  assert.equal(requestCount, 0);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.inFlight, null);
  assert.equal(journal.recoveries.length, 1);
});

test('collision recovery rejects the old operation array after a rename', (t) => {
  const directory = makeTempDir(t);
  const journalPath = path.join(directory, 'metadata-journal.json');
  const priorOperation = {
    id: 'create-table:old-name',
    index: 5,
    method: 'POST',
    apiPath: 'EntityDefinitions',
    body: { SchemaName: 'cr1_oldname' },
  };
  fs.writeFileSync(journalPath, JSON.stringify({
    schemaVersion: 1,
    binding: {
      environmentUrl: 'https://example.crm.dynamics.com',
      solution: 'Default',
    },
    completed: {},
    recoveries: [],
    inFlight: {
      index: priorOperation.index,
      operationId: priorOperation.id,
      fingerprint: operationFingerprint(priorOperation, 'Default'),
      manifestHash: '1'.repeat(64),
      reconciliationHash: '2'.repeat(64),
      failure: {
        status: 400,
        collision: true,
        recordedAt: '2026-08-19T00:00:00.000Z',
      },
    },
  }));

  assert.throws(
    () => prepareMetadataJournal({
      journalPath,
      environmentUrl: 'https://example.crm.dynamics.com',
      solution: 'Default',
      manifestHash: '3'.repeat(64),
      reconciliationHash: '4'.repeat(64),
      operations: [{ ...priorOperation, index: 0 }],
    }),
    /COLLISION_REQUIRES_REGENERATED_OPERATIONS/,
  );
});

test('superseded collision fingerprints remain recovery evidence, not completion', (t) => {
  const directory = makeTempDir(t);
  const journalPath = path.join(directory, 'metadata-journal.json');
  const priorOperation = {
    id: 'create-table:old-name',
    index: 2,
    phase: 'tableCreates',
    method: 'POST',
    apiPath: 'EntityDefinitions',
    body: { SchemaName: 'cr1_oldname' },
  };
  const fingerprint = operationFingerprint(priorOperation, 'Default');
  fs.writeFileSync(journalPath, JSON.stringify({
    schemaVersion: 1,
    binding: {
      environmentUrl: 'https://example.crm.dynamics.com',
      solution: 'Default',
    },
    completed: {},
    recoveries: [],
    inFlight: {
      index: priorOperation.index,
      operationId: priorOperation.id,
      fingerprint,
      manifestHash: '1'.repeat(64),
      reconciliationHash: '2'.repeat(64),
      failure: { status: 400, collision: true },
    },
  }));

  const prepared = prepareMetadataJournal({
    journalPath,
    environmentUrl: 'https://example.crm.dynamics.com',
    solution: 'Default',
    manifestHash: '3'.repeat(64),
    reconciliationHash: '4'.repeat(64),
    operations: [],
  });
  assert.equal(prepared.recoveryResults[0].journalStatus,
    'fresh-reconciliation-confirmed-superseded-collision');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(Object.hasOwn(journal.completed, fingerprint), false);
  assert.equal(journal.recoveries[0].fingerprint, fingerprint);
});

test('BATCH-METADATA does not turn a post-throttle collision into success', async (t) => {
  makeTempDir(t);

  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    if (requestCount === 1) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end();
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'object with same name already exists' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const envUrl = `http://127.0.0.1:${server.address().port}`;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      envUrl,
      'BATCH-METADATA',
      'collision',
      '--operations',
      JSON.stringify([{ method: 'POST', apiPath: 'EntityDefinitions', body: { value: 1 } }]),
      '--tenant-id',
      'explicit-tenant',
    ],
    { env: fakeAzEnv() },
  );

  const output = JSON.parse(stdout);
  assert.equal(output.status, 207);
  assert.equal(output.data[0].status, 400);
  assert.equal(output.data[0].rateLimited, true);
  assert.equal(requestCount, 2);
});

test('direct writes return post-throttle collisions for fresh reconciliation', async (t) => {
  makeTempDir(t);
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end();
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        code: '0x80044363',
        message: 'The schema name cr1_Item is not unique',
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    `http://127.0.0.1:${server.address().port}`,
    'POST',
    'EntityDefinitions',
    '--body',
    JSON.stringify({ SchemaName: 'cr1_Item' }),
    '--tenant-id',
    'explicit-tenant',
  ], { env: fakeAzEnv() });
  const output = JSON.parse(stdout);
  assert.equal(output.status, 400);
  assert.equal(output.rate_limited_during_request, true);
  assert.equal(requestCount, 2);
});
