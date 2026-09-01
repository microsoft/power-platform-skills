'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { revisionOf } = require('../lib/mobile-build-plan');
const {
  MAX_BODY_BYTES,
  SERVER_ARTIFACT,
  startBuildPlanServer,
} = require('../lib/mobile-build-plan-server');
const { cleanup, runCli } = require('./helpers/contract-cli');

const TOKEN = 'a'.repeat(64);

function makeProjectDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function rawRequest(origin, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, origin);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function writeJson(projectRoot, relativePath, value) {
  const file = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function contract() {
  return {
    schemaVersion: 1,
    publisherPrefix: 'ct',
    tables: [{
      logicalName: 'ct_workitem',
      schemaName: 'ct_workitem',
      displayName: 'Work item',
      displayCollectionName: 'Work items',
      plannedDecision: 'create',
      dependencyTier: 0,
      serviceRequired: true,
      ownershipType: 'UserOwned',
      columns: [{
        logicalName: 'ct_name',
        schemaName: 'ct_name',
        displayName: 'Name',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
      }],
      relationships: [],
      alternateKeys: [],
    }],
  };
}

test('loopback server authenticates reads and enforces same-origin edits', async (testContext) => {
  const projectRoot = makeProjectDir('mobile-build-plan-server');
  testContext.after(() => cleanup(projectRoot));
  const schema = contract();
  writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', schema);
  const instance = await startBuildPlanServer({
    projectRoot,
    token: TOKEN,
    pollIntervalMs: 25,
  });
  try {
    const denied = await fetch(`${instance.origin}/`);
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.headers.get('x-frame-options'), 'DENY');

    const page = await fetch(instance.launchUrl);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), new RegExp(TOKEN));
    const snapshot = fs.readFileSync(path.join(projectRoot, '_build_plan.html'), 'utf8');
    assert.doesNotMatch(snapshot, new RegExp(TOKEN));
    assert.strictEqual(
      fs.statSync(path.join(projectRoot, SERVER_ARTIFACT)).mode & 0o777,
      0o600,
    );

    const wrongHost = await rawRequest(
      instance.origin,
      `/api/model?token=${TOKEN}`,
      { headers: { host: 'attacker.example' } },
    );
    assert.strictEqual(wrongHost.status, 403);

    const modelResponse = await fetch(`${instance.origin}/api/model?token=${TOKEN}`);
    const initial = await modelResponse.json();
    assert.strictEqual(initial.ok, true);
    assert.strictEqual(initial.model.dataModelRevision, revisionOf(schema));

    const command = {
      type: 'add-column',
      expectedRevision: initial.model.dataModelRevision,
      tableLogicalName: 'ct_workitem',
      column: {
        logicalName: 'ct_dueat',
        schemaName: 'ct_dueat',
        displayName: 'Due at',
        type: 'datetime',
        plannedDecision: 'create',
        requiredLevel: 'None',
      },
    };
    const crossOrigin = await fetch(`${instance.origin}/api/data-model`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-build-plan-token': TOKEN,
        origin: 'http://example.test',
      },
      body: JSON.stringify(command),
    });
    assert.strictEqual(crossOrigin.status, 403);

    const edited = await fetch(`${instance.origin}/api/data-model`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-build-plan-token': TOKEN,
        origin: instance.origin,
      },
      body: JSON.stringify(command),
    });
    assert.strictEqual(edited.status, 200);
    assert.strictEqual((await edited.json()).requiresReapproval, true);
    const saved = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/dataverse-schema-contract.json'),
      'utf8',
    ));
    assert.ok(saved.tables[0].columns.some((column) => column.logicalName === 'ct_dueat'));

    const stale = await fetch(`${instance.origin}/api/data-model`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-build-plan-token': TOKEN,
        origin: instance.origin,
      },
      body: JSON.stringify(command),
    });
    assert.strictEqual(stale.status, 409);
    assert.match((await stale.json()).currentRevision, /^[a-f0-9]{64}$/);

    const oversizedBody = JSON.stringify({ padding: 'x'.repeat(MAX_BODY_BYTES) });
    const oversized = await rawRequest(instance.origin, '/api/data-model', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(oversizedBody),
        host: `${instance.host}:${instance.port}`,
        origin: instance.origin,
        'x-build-plan-token': TOKEN,
      },
      body: oversizedBody,
    });
    assert.strictEqual(oversized.status, 413);
    assert.match(oversized.body, /exceeds 128 KiB/);
  } finally {
    await instance.close();
  }
});

test('server opens an SSE stream and leaves a standalone snapshot on close', async (testContext) => {
  const projectRoot = makeProjectDir('mobile-build-plan-sse');
  testContext.after(() => cleanup(projectRoot));
  writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract());
  const instance = await startBuildPlanServer({
    projectRoot,
    token: TOKEN,
    pollIntervalMs: 25,
  });

  const controller = new AbortController();
  const response = await fetch(`${instance.origin}/events?token=${TOKEN}`, {
    signal: controller.signal,
  });
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const first = await response.body.getReader().read();
  assert.match(Buffer.from(first.value).toString('utf8'), /event: ready/);
  controller.abort();

  assert.strictEqual(fs.existsSync(path.join(projectRoot, SERVER_ARTIFACT)), true);
  await instance.close();
  assert.strictEqual(fs.existsSync(path.join(projectRoot, SERVER_ARTIFACT)), false);
  assert.strictEqual(fs.existsSync(path.join(projectRoot, '_build_plan.html')), true);
  const html = fs.readFileSync(path.join(projectRoot, '_build_plan.html'), 'utf8');
  assert.doesNotMatch(html, new RegExp(TOKEN));
});

test('CLI renders and updates progress without starting a server', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-cli');
  try {
    const progress = runCli('mobile-build-plan.js', [
      'progress',
      '--project-root', projectRoot,
      '--phase', 'requirements',
      '--status', 'complete',
      '--detail', 'Brief confirmed',
    ]);
    assert.strictEqual(progress.code, 0, progress.stderr);
    assert.strictEqual(progress.json.ok, true);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '_build_plan.html')), true);

    const render = runCli('mobile-build-plan.js', ['render', '--project-root', projectRoot]);
    assert.strictEqual(render.code, 0, render.stderr);
    assert.match(render.json.revision, /^[a-f0-9]{64}$/);
  } finally {
    cleanup(projectRoot);
  }
});