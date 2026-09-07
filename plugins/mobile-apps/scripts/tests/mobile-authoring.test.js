'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const protocol = require('../lib/authoring-protocol');
const { canonicalJson, digest, readJson, exists, journalPath } = require('../lib/mobile-authoring-files');
const { protocolHash, readDescriptor, validateContext } = require('../lib/mobile-authoring-context');
const {
  artifactBinding, gateBinding, prepareQuestion, questionDigest, validateAnswer, verifyDecision,
} = require('../lib/mobile-authoring-decisions');
const {
  createClient, MAX_CONNECTOR_METADATA_BYTES, MAX_DATAVERSE_BYTES, DATAVERSE_EXECUTION_TIMEOUT_MS,
} = require('../lib/mobile-authoring-transport');
const { capabilities, parseArgs } = require('../mobile-authoring');

process.env.POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT = '1';
const CLI = path.resolve(__dirname, '../mobile-authoring.js');

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return file;
}

function signed(question, descriptor, privateKey, changes = {}) {
  const value = {
    protocolVersion: 2, issuer: protocol.PROTOCOL_ID,
    appInstanceId: descriptor.appInstanceId, jobId: descriptor.jobId, attemptId: descriptor.attemptId,
    approvalId: question.id, approvalRevision: 1, gateId: question.gateId,
    sourceRevision: question.sourceRevision, questionDigest: questionDigest(question),
    action: 'approve', answer: {}, issuedAt: new Date().toISOString(), ...changes,
  };
  value.signature = crypto.sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64');
  return value;
}

async function fixture(t, overrides = {}) {
  const base = path.join(__dirname, `.mobile-authoring-work-${crypto.randomUUID()}`);
  const root = path.join(base, 'candidate');
  fs.mkdirSync(root, { recursive: true });
  const keys = crypto.generateKeyPairSync('ed25519');
  const token = crypto.randomBytes(32).toString('base64url');
  const descriptor = {
    protocolVersion: 2, protocolHash: protocolHash(), bridgeUrl: '',
    appInstanceId: 'test-app', jobId: 'test-job', attemptId: 'attempt-1', operation: 'edit',
    baseRevision: 'a'.repeat(64), workspaceDir: root,
    decisionPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ...(overrides.descriptor || {}),
  };
  const state = {
    requests: [], questions: new Map(), receipts: new Map(), posts: 0, decisions: 0,
    pending: false, status: 200, postFailures: 0, action: 'approve', answer: {},
    metadataStatus: 200, metadataFailures: 0, metadataData: { schema: 'fixture' },
    dataverseStatus: 200, dataverseFailures: 0, dataverseResponse: { ok: true, artifacts: [] },
    ...overrides,
  };
  const server = http.createServer(async (request, response) => {
    let content = '';
    for await (const chunk of request) content += chunk;
    const payload = content ? JSON.parse(content) : null;
    state.requests.push({ method: request.method, url: request.url, token: request.headers['x-runner-token'], raw: content, payload });
    response.setHeader('content-type', 'application/json');
    if (request.headers['x-runner-token'] !== token) {
      response.writeHead(401).end(JSON.stringify({ error: token }));
      return;
    }
    if (state.status !== 200) {
      if (state.location) response.setHeader('location', state.location);
      response.writeHead(state.status).end(JSON.stringify({ error: token }));
      return;
    }
    if (request.url.endsWith('/verify')) {
      response.end(JSON.stringify({
        ...descriptor, protocolId: protocol.PROTOCOL_ID, workspaceKind: 'candidate', active: true,
        ...(state.handshake || {}),
      }));
      return;
    }
    if (request.url.endsWith('/connector-metadata')) {
      if (state.metadataFailures-- > 0) { response.writeHead(503).end('{}'); return; }
      if (state.metadataStatus !== 200) {
        response.writeHead(state.metadataStatus).end(JSON.stringify({ error: token }));
        return;
      }
      response.end(JSON.stringify(state.metadataResponse || { status: 200, data: state.metadataData }));
      return;
    }
    if (request.url.endsWith('/dataverse')) {
      if (state.dataverseDisconnect) { response.destroy(); return; }
      if (state.dataverseFailures-- > 0) { response.writeHead(503).end('{}'); return; }
      if (state.dataverseStatus !== 200) {
        if (state.dataverseLocation) response.setHeader('location', state.dataverseLocation);
        response.writeHead(state.dataverseStatus).end(JSON.stringify({ error: token }));
        return;
      }
      response.end(JSON.stringify(state.dataverseResponse));
      return;
    }
    if (request.method === 'POST' && request.url.endsWith('/questions')) {
      state.posts += 1;
      const question = protocol.assertQuestion(payload);
      state.questions.set(question.id, question);
      if (state.onQuestion) state.onQuestion(question);
      if (state.postFailures-- > 0) {
        response.writeHead(503).end('{}');
        return;
      }
      response.end(JSON.stringify({
        approvalId: question.id, approvalRevision: 1, questionDigest: questionDigest(question),
      }));
      return;
    }
    if (request.method === 'GET' && request.url.includes('/decision?')) {
      state.decisions += 1;
      if (state.pending) { response.end('{"pending":true}'); return; }
      const id = decodeURIComponent(request.url.split('/questions/')[1].split('/')[0]);
      const question = state.questions.get(id);
      let receipt = state.receipts.get(id);
      if (!receipt) {
        receipt = signed(question, descriptor, keys.privateKey, { action: state.action, answer: state.answer, ...(state.receiptChanges || {}) });
        if (state.tamper) receipt = state.tamper(receipt);
        state.receipts.set(id, receipt);
      }
      response.end(JSON.stringify(receipt));
      return;
    }
    response.end('{"accepted":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  descriptor.bridgeUrl = `http://127.0.0.1:${server.address().port}`;
  const descriptorFile = write(base, 'issuer/attempt.json', descriptor);
  fs.chmodSync(descriptorFile, 0o444);
  write(root, 'canonical.json', { revision: 1, setting: 'original' });
  const question = {
    gateId: 'nested-design-scope', kind: 'clarification', title: 'Choose the style scope',
    summary: 'Keep this answer in the existing Player job.',
    fields: [
      { id: 'scope', label: 'Scope', type: 'select', choices: ['App', 'Selection'] },
      { id: 'preserve', label: 'Preserve behavior', type: 'boolean' },
      { id: 'detail', label: 'Detail', type: 'text' },
    ],
  };
  write(root, '.devplayer-builder/logs/input/question.json', question);
  const env = {
    ...process.env, MOBILE_AUTHORING_CONTEXT: descriptorFile, MOBILE_AUTHORING_RUNNER_TOKEN: token,
    POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.chmodSync(descriptorFile, 0o600);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return {
    root, base, descriptor, descriptorFile, token, keys, env, state, question,
    client: (options = {}) => createClient({ env, cwd: root, ...options }),
    updateDescriptor: (changes) => {
      Object.assign(descriptor, changes);
      fs.chmodSync(descriptorFile, 0o600);
      fs.writeFileSync(descriptorFile, JSON.stringify(descriptor));
      fs.chmodSync(descriptorFile, 0o444);
    },
    cli: (args, script = CLI) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    }),
  };
}

function expected(f, question) {
  return { descriptor: f.descriptor, question, approvalId: question.id, approvalRevision: 1 };
}

test('capabilities pin the exact protocol bytes and do not require a Player secret', () => {
  assert.equal(capabilities().protocolHash, digest(fs.readFileSync(path.resolve(__dirname, '../lib/authoring-protocol.js'))));
  assert.deepEqual(protocol.assertCapabilities(capabilities()).operations, capabilities().operations);
  assert.equal(JSON.stringify(capabilities()).includes('MOBILE_AUTHORING_RUNNER_TOKEN'), false);
  assert.equal(capabilities().connectorMetadataTransport, 'scoped-sdk-get-v1');
  assert.equal(capabilities().nativeCatalog, true);
  assert.equal(capabilities().connectorCatalog, true);
  assert.throws(() => parseArgs(['node', 'helper', 'event', '--input', 'a', '--input', 'b']), /Duplicate/);
  assert.throws(() => parseArgs(['node', 'helper', 'event', '--token', 'secret']), /Unsupported/);
});

test('catalogue negotiation requires actual listing adapters, independently of optional execution dependencies', (t) => {
  const root = path.resolve(__dirname, '../..');
  const existsSync = fs.existsSync;
  const unavailable = new Set();
  t.mock.method(fs, 'existsSync', (file) => !unavailable.has(file) && existsSync(file));
  const complete = capabilities();
  for (const [missing, nativeCatalog, connectorCatalog] of [
    ['scripts/list-native-capabilities.js', false, true],
    ['scripts/lib/native-capability-catalog.js', false, true],
    ['scripts/native-capabilities.json', false, true],
    ['template/package.json', false, true],
    ['scripts/list-prototype-connections.js', true, false],
    ['scripts/lib/prototype-connections.js', true, false],
    ['scripts/lib/validation-helpers.js', true, false],
    ['scripts/resolve-environment.js', true, false],
    ['skills/list-connections/SKILL.md', true, false],
    ['scripts/lib/prototype-files.js', false, false],
    ['scripts/lib/json-schema-lite.js', false, false],
    ['skills/add-native/SKILL.md', true, true],
    ['scripts/verify-prototype-native.js', true, true],
    ['scripts/stage-prototype-connector.js', true, true],
    ['skills/add-connector/SKILL.md', true, true],
    ['scripts/configure-prototype-authoring.js', true, true],
    ['scripts/lib/prototype-screen-authoring.js', true, true],
    ['scripts/lib/authoring-edit-registration.js', true, true],
    ['scripts/lib/mobile-authoring-transport.js', true, true],
  ]) {
    unavailable.clear();
    unavailable.add(path.join(root, missing));
    const manifest = capabilities();
    assert.equal(manifest.nativeCatalog, nativeCatalog, missing);
    assert.equal(manifest.connectorCatalog, connectorCatalog, missing);
    assert.notEqual(manifest.buildIdentity, complete.buildIdentity);
    if (missing === 'scripts/lib/prototype-connections.js') {
      assert.equal(manifest.connectorMetadataTransport, 'scoped-sdk-get-v1');
    }
    if (missing === 'scripts/lib/mobile-authoring-transport.js') {
      assert.equal(manifest.questions, false);
      assert.equal(manifest.contextualEditing, false);
      assert.equal(manifest.connectorMetadataTransport, null);
    }
    if (missing === 'scripts/lib/prototype-screen-authoring.js') assert.equal(manifest.candidates, false);
  }
  unavailable.clear();
  unavailable.add(path.join(root, 'scripts/lib/player-dataverse.js'));
  const withoutBroker = capabilities();
  assert.equal(withoutBroker.dataverseConversion, false);
  assert.equal(withoutBroker.operations.includes('connect'), false);
  assert.equal(withoutBroker.nativeCatalog, true);
  assert.equal(withoutBroker.connectorCatalog, true);
});

test('a read-only bundle can negotiate and list template workflows without a transport, SDK metadata, or Add adapter', (t) => {
  const source = path.resolve(__dirname, '../..');
  const root = path.join(__dirname, `.mobile-authoring-work-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    'scripts/mobile-authoring.js', 'scripts/lib/authoring-protocol.js',
    'scripts/lib/mobile-authoring-context.js', 'scripts/lib/mobile-authoring-files.js',
    'scripts/lib/mobile-authoring-errors.js', 'scripts/lib/product-experience-contracts.js',
    'scripts/lib/json-schema-lite.js', 'scripts/lib/prototype-files.js',
    'scripts/list-native-capabilities.js', 'scripts/lib/native-capability-catalog.js',
    'scripts/native-capabilities.json', 'template/package.json',
    'scripts/list-prototype-connections.js', 'scripts/lib/prototype-connections.js',
    'scripts/lib/validation-helpers.js', 'scripts/resolve-environment.js',
    'skills/list-connections/SKILL.md', 'skills/list-connections/references/existing-selection.md',
    'scripts/lib/authoring-edit-integration.js',
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(root, file));
  }
  const env = { ...process.env };
  delete env.MOBILE_AUTHORING_CONTEXT;
  delete env.MOBILE_AUTHORING_RUNNER_TOKEN;
  const negotiated = spawnSync(process.execPath, [path.join(root, 'scripts/mobile-authoring.js'), 'capabilities'], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(negotiated.status, 0, negotiated.stderr);
  const manifest = JSON.parse(negotiated.stdout);
  assert.equal(manifest.nativeCatalog, true);
  assert.equal(manifest.connectorCatalog, true);
  assert.equal(manifest.questions, false);
  assert.equal(manifest.contextualEditing, false);
  assert.equal(manifest.connectorMetadataTransport, null);
  assert.deepEqual(manifest.operations, []);
  const app = path.join(root, 'app-fixture');
  fs.mkdirSync(app);
  fs.copyFileSync(path.join(root, 'template/package.json'), path.join(app, 'package.json'));
  const listed = spawnSync(process.execPath, [
    path.join(root, 'scripts/list-native-capabilities.js'), '--project-root', app,
  ], { cwd: app, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(listed.status, 0, listed.stderr);
  const camera = JSON.parse(listed.stdout).items.find((item) => item.id === 'camera');
  assert.equal(camera.availability, 'available');
  assert.equal(camera.title, 'Camera');
  const isolated = require(path.join(root, 'scripts/lib/authoring-edit-integration.js'));
  for (const route of [
    { kind: 'native', skill: 'add-native', selection: { capabilityId: 'camera' } },
    { kind: 'connector', skill: 'add-connector', selection: { apiId: 'shared_office365' } },
  ]) assert.throws(() => isolated.assertIntegrationWorkflow(route), /execution workflow is not installed/);
  assert.throws(() => isolated.assertIntegrationWorkflow({
    kind: 'connector', skill: 'add-native', selection: { apiId: 'shared_office365' },
  }), /fixed owning workflow/);
});

test('descriptor identity, read-only issuer, project boundaries, and loopback origin fail closed', async (t) => {
  const f = await fixture(t);
  assert.equal(readDescriptor({ env: f.env, cwd: f.root }).descriptor.jobId, f.descriptor.jobId);
  assert.throws(() => readDescriptor({ env: f.env, cwd: f.base }), /selected project/);
  fs.chmodSync(f.descriptorFile, 0o644);
  assert.throws(() => readDescriptor({ env: f.env, cwd: f.root }), /runner-writable/);
  fs.chmodSync(f.descriptorFile, 0o444);
  assert.throws(() => readDescriptor({ env: { MOBILE_AUTHORING_RUNNER_TOKEN: f.token }, cwd: f.root }), /descriptor/);
  const original = fs.readFileSync(f.descriptorFile);
  for (const mutation of [
    { protocolHash: 'b'.repeat(64) }, { bridgeUrl: 'https://example.com' },
    { bridgeUrl: 'http://localhost/?token=forbidden' },
    { decisionPublicKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    { ignoredMetadata: f.token },
  ]) {
    fs.chmodSync(f.descriptorFile, 0o600);
    fs.writeFileSync(f.descriptorFile, JSON.stringify({ ...f.descriptor, ...mutation }));
    fs.chmodSync(f.descriptorFile, 0o444);
    assert.throws(() => readDescriptor({ env: f.env, cwd: f.root }));
  }
  fs.chmodSync(f.descriptorFile, 0o600);
  fs.writeFileSync(f.descriptorFile, original);
  fs.chmodSync(f.descriptorFile, 0o444);
  const link = path.join(f.root, 'alias.json');
  fs.symlinkSync(path.join(f.root, 'canonical.json'), link);
  assert.throws(() => artifactBinding(f.root, ['alias.json']), /unaliased|links/);
});

test('runtime context accepts minimal record references and rejects raw fields, stale IDs, and escapes', async (t) => {
  const f = await fixture(t);
  const context = {
    protocolVersion: 2, appInstanceId: f.descriptor.appInstanceId, jobId: f.descriptor.jobId,
    previewRevision: f.descriptor.baseRevision, scope: 'target',
    screenId: 'work-list', route: '/work', targetId: 'work-list.collection',
    recordRef: { conceptId: 'work', recordId: 'record-1' },
  };
  assert.deepEqual(validateContext(context, f.descriptor), context);
  for (const mutation of [
    { previewRevision: 'b'.repeat(64) }, { appInstanceId: 'other-app' },
    { route: '/work?id=private' }, { fields: { sensitive: true } },
    { recordRef: { ...context.recordRef, photo: 'file:///private/photo.jpg' } },
    { callbackUrl: 'https://example.com' },
  ]) assert.throws(() => validateContext({ ...context, ...mutation }, f.descriptor));
});

test('scoped verification preserves the base origin job and rejects missing, swapped, or candidate-replaced context', async (t) => {
  const f = await fixture(t);
  const context = {
    protocolVersion: 2, appInstanceId: f.descriptor.appInstanceId, jobId: 'published-preview-origin',
    previewRevision: f.descriptor.baseRevision, scope: 'target', screenId: 'work-list',
    route: '/work', targetId: 'work-list.collection', recordRef: { conceptId: 'work', recordId: 'record-1' },
  };
  f.updateDescriptor({ context });
  const verified = await f.cli(['verify']);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).context.jobId, 'published-preview-origin');
  assert.equal(JSON.parse(verified.stdout).jobId, f.descriptor.jobId);
  for (const changed of [
    null, undefined, { ...context, jobId: f.descriptor.jobId }, { ...context, jobId: 'unverified-origin' },
    { ...context, targetId: 'another-target' }, { ...context, route: '/other' },
    { ...context, recordRef: { ...context.recordRef, recordId: 'another-record' } },
    { ...context, hasUnsavedChanges: true },
  ]) {
    f.state.handshake = { context: changed };
    await assert.rejects(f.client().verify(), /captured context/);
  }
  f.state.handshake = { context };
  const contextFile = '.devplayer-builder/logs/input/captured-context.json';
  write(f.root, contextFile, context);
  f.updateDescriptor({ context: undefined, contextFile });
  assert.equal((await f.client().verify()).context.jobId, context.jobId);
  write(f.root, contextFile, { ...context, targetId: 'candidate-controlled-target' });
  await assert.rejects(f.client().verify(), /captured context/);
  f.updateDescriptor({ contextFile: undefined });
  await assert.rejects(f.client().verify(), /captured context/);
  assert.equal(f.state.posts, 0);
});

test('catalogue descriptors are edit-only, strictly typed, and exactly echoed by the scoped handshake', async (t) => {
  const selection = {
    kind: 'connector', apiId: 'shared_office365', environmentId: 'environment-fixture',
    connectionId: 'connection-fixture', catalogRevision: 'b'.repeat(64),
  };
  const f = await fixture(t, { descriptor: { integration: selection } });
  assert.deepEqual(readDescriptor({ env: f.env, cwd: f.root }).descriptor.integration, protocol.assertIntegrationSelection(selection));
  assert.deepEqual((await f.client().verify()).integration, selection);
  const verified = await f.cli(['verify']);
  assert.equal(verified.code, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout).integration, protocol.assertIntegrationSelection(selection));
  assert.ok(!verified.stdout.includes(f.token));
  for (const integration of [
    null, undefined, { ...selection, catalogRevision: 'c'.repeat(64) },
    { ...selection, apiId: 'shared_office365users' }, { ...selection, environmentId: 'wrong-environment' },
    { ...selection, connectionId: 'another-connection' },
  ]) {
    f.state.handshake = { integration };
    await assert.rejects(f.client().verify(), /catalogue selection/);
  }
  f.state.handshake = {};
  for (const integration of [
    { ...selection, connectionRef: 'extra-reference' },
    { ...selection, connectionId: undefined },
    { ...selection, apiId: 'https://example.com/api' },
    { ...selection, connectionId: 'https://example.com/connection' },
    { ...selection, command: 'not-permitted' },
    { kind: 'native', capabilityId: 'camera', catalogRevision: 'not-a-hash' },
  ]) {
    f.updateDescriptor({ integration });
    assert.throws(() => readDescriptor({ env: f.env, cwd: f.root }));
  }
  for (const operation of ['prototype', 'teach', 'connect']) {
    f.updateDescriptor({ integration: selection, operation });
    assert.throws(() => readDescriptor({ env: f.env, cwd: f.root }), /explicit edit/);
  }
  f.updateDescriptor({ integration: undefined, operation: 'edit' });
  f.state.handshake = { integration: selection };
  await assert.rejects(f.client().verify(), /catalogue selection/);
});

test('SDK metadata uses only the fixed scoped runner broker and retries the same bounded GET intent', async (t) => {
  const integration = {
    kind: 'connector', apiId: 'shared_office365', environmentId: 'environment-fixture',
    connectionId: 'connection-fixture', catalogRevision: 'b'.repeat(64),
  };
  const f = await fixture(t, { descriptor: { integration }, metadataFailures: 1 });
  const input = {
    url: 'https://metadata.invalid/environments/environment-fixture/apis/shared_office365/schema',
    authResource: 'https://service.powerapps.com/',
  };
  f.state.metadataData = { schema: 'x'.repeat(300 * 1024) };
  const client = f.client({
    delay: async () => {},
    fetch: (url, options) => {
      assert.ok(url.startsWith(f.descriptor.bridgeUrl + '/runner/jobs/'));
      return fetch(url, options);
    },
  });
  const result = await client.connectorMetadata(input);
  assert.equal(result.status, 200);
  assert.equal(result.data.schema.length, 300 * 1024);
  const requests = f.state.requests.filter((request) => request.url.endsWith('/connector-metadata'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].raw, requests[1].raw);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].payload, { attemptId: f.descriptor.attemptId, ...input });
  assert.ok(!requests[0].raw.includes(f.token));
  for (const mutation of [
    { url: 'http://metadata.invalid/schema' }, { url: 'https://user:secret@metadata.invalid/schema' },
    { url: `${input.url}#fragment` }, { method: 'POST' }, { headers: { authorization: 'not-permitted' } },
    { authResource: f.token },
  ]) await assert.rejects(client.connectorMetadata({ ...input, ...mutation }));
  f.updateDescriptor({ integration: { kind: 'native', capabilityId: 'camera', catalogRevision: 'c'.repeat(64) } });
  await assert.rejects(f.client().connectorMetadata(input), /selected connector edit/);
  f.updateDescriptor({ operation: 'connect', integration: undefined });
  await assert.rejects(f.client().connectorMetadata(input), /selected connector edit/);
});

test('SDK metadata grant refusal, invalid/oversized responses and credentials never become a fallback fetch', async (t) => {
  const f = await fixture(t, { descriptor: { integration: {
    kind: 'connector', apiId: 'shared_office365', environmentId: 'environment-fixture',
    connectionRef: 'reference-fixture', catalogRevision: 'c'.repeat(64),
  } } });
  const input = { url: 'https://metadata.invalid/schema', authResource: 'https://service.powerapps.com/' };
  for (const status of [401, 403, 409, 410]) {
    f.state.metadataStatus = status;
    const before = f.state.requests.filter((request) => request.url.endsWith('/connector-metadata')).length;
    await assert.rejects(f.client().connectorMetadata(input), (error) => {
      assert.ok(!error.message.includes(f.token));
      return /revoked|stale|cancelled/.test(error.message);
    });
    assert.equal(f.state.requests.filter((request) => request.url.endsWith('/connector-metadata')).length, before + 1);
  }
  f.state.metadataStatus = 200;
  for (const metadataResponse of [
    { status: 201, data: {} }, { status: 200 }, { status: 200, data: {}, execute: 'not-permitted' },
    { status: 200, data: { credential: f.token } },
  ]) {
    f.state.metadataResponse = metadataResponse;
    await assert.rejects(f.client().connectorMetadata(input), (error) => !error.message.includes(f.token));
  }
  f.state.metadataResponse = undefined;
  f.state.metadataData = { schema: 'x'.repeat(MAX_CONNECTOR_METADATA_BYTES) };
  await assert.rejects(f.client().connectorMetadata(input), /response exceeded its bound/);
  assert.ok(f.state.requests.every((request) => request.url.startsWith(`/runner/jobs/${f.descriptor.jobId}/`)));
  assert.equal(f.state.posts, 0);
});

test('Dataverse transport binds the explicit conversion job and returns bounded official artifacts without installing them', async (t) => {
  const f = await fixture(t, { descriptor: { operation: 'connect' } });
  const environmentUrl = 'https://contoso.crm.dynamics.com';
  const client = f.client({
    fetch: (url, options) => {
      assert.ok(url.startsWith(f.descriptor.bridgeUrl + `/runner/jobs/${f.descriptor.jobId}/`));
      assert.equal(options.redirect, 'manual');
      return fetch(url, options);
    },
  });
  await client.verify();
  const inputs = [
    { operation: 'resolve-environment', target: '11111111-1111-4111-8111-111111111111' },
    { operation: 'metadata', environmentUrl, method: 'GET', apiPath: "/api/data/v9.2/EntityDefinitions?$select=LogicalName" },
    { operation: 'init', environmentUrl },
    { operation: 'execute-manifest', environmentUrl, manifestHash: 'b'.repeat(64) },
    { operation: 'generate-services', environmentUrl, manifestHash: 'b'.repeat(64) },
  ];
  for (const input of inputs) {
    assert.deepEqual(await client.dataverse(input), f.state.dataverseResponse);
    const request = f.state.requests.at(-1);
    assert.equal(request.url, `/runner/jobs/${f.descriptor.jobId}/dataverse`);
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.payload, {
      attemptId: f.descriptor.attemptId, appInstanceId: f.descriptor.appInstanceId, ...input,
    });
    assert.ok(!request.raw.includes(f.token));
    assert.ok(f.state.requests.at(-2).url.endsWith('/verify'));
  }
  assert.equal(f.state.requests.filter((request) => request.url.endsWith('/verify')).length, inputs.length + 1);
  const content = 'x'.repeat(MAX_CONNECTOR_METADATA_BYTES + 1024);
  f.state.dataverseResponse = {
    ok: false, state: 'execution-failed',
    artifacts: [{ path: 'src/generated/services/FixtureService.ts', content, sha256: digest(content), previousSha256: null }],
  };
  const result = await client.dataverse(inputs.at(-1));
  assert.deepEqual(result, f.state.dataverseResponse);
  assert.equal(fs.existsSync(path.join(f.root, result.artifacts[0].path)), false);
  assert.equal(f.state.posts, 0);
});

test('Dataverse requests are typed, read-only metadata is bounded, and invalid or credential-bearing responses fail closed', async (t) => {
  const f = await fixture(t, { descriptor: { operation: 'connect' } });
  const environmentUrl = 'https://contoso.crm.dynamics.com';
  const input = { operation: 'metadata', environmentUrl, method: 'GET', apiPath: 'EntityDefinitions?$select=LogicalName' };
  const client = f.client({ delay: async () => {} });
  for (const [index, invalid] of [
    { ...input, operation: 'run-command' }, { ...input, method: 'POST' },
    { ...input, target: 'unrelated-target' }, { ...input, body: {} }, { ...input, command: 'not-permitted' },
    { ...input, headers: { authorization: 'not-permitted' } }, { ...input, appInstanceId: 'another-app' },
    { ...input, attemptId: 'another-attempt' }, { ...input, environmentUrl: 'http://contoso.crm.dynamics.com' },
    { ...input, environmentUrl: `${environmentUrl}/api/data/v9.2` },
    { ...input, environmentUrl: 'https://user:password@contoso.crm.dynamics.com' },
    { ...input, environmentUrl: `${environmentUrl}?access_token=forbidden` },
    { ...input, apiPath: 'https://outside.invalid/api/data/v9.2/EntityDefinitions' },
    { ...input, apiPath: '//outside.invalid/EntityDefinitions' }, { ...input, apiPath: 'EntityDefinitions#fragment' },
    { ...input, apiPath: 'EntityDefinitions\n' }, { ...input, apiPath: 'x'.repeat(16_001) },
    { operation: 'resolve-environment' }, { operation: 'resolve-environment', target: 'Bearer forbidden' },
    { operation: 'resolve-environment', target: f.token }, { operation: 'resolve-environment', target: 'file:///not-permitted' },
    { operation: 'execute-manifest', environmentUrl, manifestHash: 'b'.repeat(64) + '\n' },
    { operation: 'generate-services', environmentUrl }, { operation: 'init', environmentUrl, manifestHash: 'b'.repeat(64) },
  ].entries()) await assert.rejects(client.dataverse(invalid), (error) => !error.message.includes(f.token), `Invalid Dataverse input ${index}`);
  assert.equal(f.state.requests.length, 0);
  f.state.dataverseFailures = 1;
  assert.deepEqual(await client.dataverse(input), f.state.dataverseResponse);
  const reads = f.state.requests.filter((request) => request.url.endsWith('/dataverse'));
  assert.equal(reads.length, 2);
  assert.equal(reads[0].raw, reads[1].raw);
  for (const response of [
    null, [], 'unexpected',
    { accessToken: 'provider-secret' }, { message: 'Bearer provider-secret' }, { message: f.token },
  ]) {
    f.state.dataverseResponse = response;
    await assert.rejects(client.dataverse(input), (error) => !error.message.includes(f.token) && !error.message.includes('provider-secret'));
  }
  f.state.dataverseResponse = { artifacts: [{ content: 'x'.repeat(MAX_DATAVERSE_BYTES) }] };
  await assert.rejects(client.dataverse(input), /response exceeded its bound/);
  for (const operation of ['prototype', 'edit', 'teach']) {
    f.updateDescriptor({ operation });
    await assert.rejects(f.client().dataverse(input), /explicit conversion job/);
  }
});

test('Dataverse execution never blindly retries a write, follows redirects, or continues after a revoked grant', async (t) => {
  const f = await fixture(t, { descriptor: { operation: 'connect' } });
  const input = { operation: 'execute-manifest', environmentUrl: 'https://contoso.crm.dynamics.com', manifestHash: 'c'.repeat(64) };
  const client = f.client({ delay: async () => assert.fail('A Dataverse write must not retry') });
  for (const status of [401, 403, 409, 410, 503]) {
    f.state.dataverseStatus = status;
    const before = f.state.requests.filter((request) => request.url.endsWith('/dataverse')).length;
    await assert.rejects(client.dataverse(input), (error) => {
      assert.ok(!error.message.includes(f.token));
      return /revoked|stale|cancelled|outcome is unknown/.test(error.message);
    });
    assert.equal(f.state.requests.filter((request) => request.url.endsWith('/dataverse')).length, before + 1);
  }
  f.state.dataverseStatus = 200;
  f.state.dataverseDisconnect = true;
  const beforeDisconnect = f.state.requests.filter((request) => request.url.endsWith('/dataverse')).length;
  await assert.rejects(client.dataverse(input), /outcome is unknown/);
  assert.equal(f.state.requests.filter((request) => request.url.endsWith('/dataverse')).length, beforeDisconnect + 1);
  f.state.dataverseDisconnect = false;
  f.state.dataverseStatus = 307;
  f.state.dataverseLocation = `${f.descriptor.bridgeUrl}/forbidden-redirect`;
  await assert.rejects(client.dataverse(input), /redirects are forbidden/);
  assert.equal(f.state.requests.some((request) => request.url === '/forbidden-redirect'), false);
  f.state.dataverseStatus = 200;
  f.state.handshake = { active: false };
  const beforeStale = f.state.requests.filter((request) => request.url.endsWith('/dataverse')).length;
  await assert.rejects(client.dataverse(input), /active bridge attempt/);
  assert.equal(f.state.requests.filter((request) => request.url.endsWith('/dataverse')).length, beforeStale);
});

test('Dataverse initialization, execution and generation have a bounded 120-second timeout with no write retry', async (t) => {
  const f = await fixture(t, { descriptor: { operation: 'connect' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const operation of ['init', 'execute-manifest', 'generate-services']) {
    let requests = 0;
    let requestSignal;
    let sent;
    const started = new Promise((resolve) => { sent = resolve; });
    const client = f.client({
      delay: async () => assert.fail('A timed-out Dataverse write must not retry'),
      fetch: async (url, options) => {
        if (url.endsWith('/verify')) return new Response(JSON.stringify({
          ...f.descriptor, protocolId: protocol.PROTOCOL_ID, workspaceKind: 'candidate', active: true,
        }));
        assert.ok(url.endsWith('/dataverse'));
        requests += 1;
        requestSignal = options.signal;
        sent();
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted fixture transport')), { once: true });
        });
      },
    });
    const input = {
      operation, environmentUrl: 'https://contoso.crm.dynamics.com',
      ...(operation === 'init' ? {} : { manifestHash: 'd'.repeat(64) }),
    };
    const pending = assert.rejects(client.dataverse(input), /outcome is unknown/);
    await started;
    t.mock.timers.tick(DATAVERSE_EXECUTION_TIMEOUT_MS - 1);
    assert.equal(requestSignal.aborted, false);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(requests, 1);
  }
});

test('actual edit CLI keeps catalogue preparation and canonical gate decisions in one runner job before fixed handoff', async (t) => {
  const f = await fixture(t, {
    descriptor: { integration: { kind: 'native', capabilityId: 'camera', catalogRevision: 'd'.repeat(64) } },
  });
  const editCli = path.resolve(__dirname, '../authoring-edit.js');
  write(f.root, 'package.json', { name: 'fixture-app', dependencies: { 'expo-camera': '1.0.0', 'expo-image-picker': '1.0.0' } });
  write(f.root, '.tmp/persistence-contract.json', { mode: 'local-prototype' });
  write(f.root, '.tmp/compiled-screen-build-pack.json', { contractType: 'compiled-screen-build-pack', screens: [] });
  write(f.root, '.tmp/product-experience-contract.json', { fixture: 'experience' });
  write(f.root, '.tmp/product-scope-contract.json', { fixture: 'scope' });
  write(f.root, '.tmp/navigation-manifest.json', { fixture: 'navigation' });
  write(f.root, '.tmp/architecture-decisions.json', { nativeCapabilities: [], connectors: [] });
  f.updateDescriptor({ baseRevision: require('../lib/authoring-source').captureSource(f.root).revision });
  write(f.root, '.devplayer-builder/logs/input/edit.json', {
    schemaVersion: 1, kind: 'integration', summary: 'Prepare the selected camera wrapper.',
    screenIds: [], allowedFiles: ['src/native/camera.ts', '.tmp/architecture-decisions.json'],
  });
  const proposal = await f.cli(['prepare', '--input', '.devplayer-builder/logs/input/edit.json'], editCli);
  assert.equal(proposal.code, 0, proposal.stderr);
  const { planId } = JSON.parse(proposal.stdout);
  const approved = await f.cli(['authorize', '--plan', planId], editCli);
  assert.equal(approved.code, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).applied, false);
  assert.equal(exists(f.root, 'src/native/camera.ts'), false);
  const preparation = [...f.state.questions.values()][0];
  assert.equal(preparation.kind, 'plan');
  assert.match(preparation.gateId, /^prepare-edit-/);
  write(f.root, '.tmp/architecture-decisions.json', { nativeCapabilities: [{ id: 'camera', approved: true }], connectors: [] });
  const gate = await f.client().requestQuestion({
    gateId: 'gate1', kind: 'plan', title: 'Approve camera capability',
    summary: 'The selected shipped control needs no package or data changes.', fields: [],
  }, { recordGate: 1 });
  const handoff = await f.cli(['integration', '--plan', planId, '--gate-receipt', gate.receiptPath], editCli);
  assert.equal(handoff.code, 0, handoff.stderr);
  assert.equal(JSON.parse(handoff.stdout).status, 'authorized-handoff');
  assert.equal(JSON.parse(handoff.stdout).skill, 'add-native');
  assert.deepEqual(JSON.parse(handoff.stdout).selection, protocol.assertIntegrationSelection(f.descriptor.integration));
  write(f.root, 'src/native/camera.ts', 'export const fixtureOnly = true;\n');
  const checked = await f.cli(['check', '--plan', planId], editCli);
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).status, 'scope-checked');
  assert.equal(f.state.questions.size, 2);
  assert.ok(f.state.requests.every((request) => request.url.startsWith(`/runner/jobs/${f.descriptor.jobId}/`)));
  assert.ok(f.state.requests.every((request) => !request.raw.includes(f.token) && !request.url.includes(f.token)));
  assert.ok(!f.state.requests.some((request) => /\/(?:apply|publish|catalog)/.test(request.url)));
});

test('decisions are full canonical Ed25519 records with exact question/gate/action/answer bindings', async (t) => {
  const f = await fixture(t);
  const question = prepareQuestion(f.question, artifactBinding(f.root, ['canonical.json']), f.descriptor);
  const answer = { scope: 'App', preserve: true, detail: 'Keep existing behavior' };
  const receipt = signed(question, f.descriptor, f.keys.privateKey, { answer });
  assert.deepEqual(verifyDecision(receipt, expected(f, question)), receipt);
  assert.equal(question.id, prepareQuestion({ ...f.question, items: [] }, artifactBinding(f.root, ['canonical.json']), f.descriptor).id);
  for (const change of [
    { jobId: 'another-job' }, { attemptId: 'old-attempt' }, { appInstanceId: 'another-app' },
    { approvalRevision: 2 }, { approvalId: 'another-approval' },
    { gateId: 'wrong-gate' }, { sourceRevision: 'c'.repeat(64) },
    { questionDigest: 'd'.repeat(64) }, { issuer: 'forged-issuer' },
    { action: 'apply' }, { answer: { ...answer, scope: 'Invented' } },
    { answer: { ...answer, preserve: 'true' } }, { answer: { scope: 'App' } },
    { answer: { ...answer, unknown: 'extra' } },
  ]) {
    assert.throws(() => verifyDecision(signed(question, f.descriptor, f.keys.privateKey, change), expected(f, question)));
  }
  assert.throws(() => verifyDecision({ ...receipt, answer: { ...answer, detail: 'tampered' } }, expected(f, question)), /signature/);
  assert.throws(() => verifyDecision({ ...receipt, execute: 'forbidden' }, expected(f, question)), /shape/);
  const attacker = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => verifyDecision(signed(question, f.descriptor, attacker.privateKey, { answer }), expected(f, question)), /signature/);
  const apply = { ...question, kind: 'apply', fields: [] };
  assert.throws(() => validateAnswer(apply, 'approve', {}), /kind/);
  assert.deepEqual(validateAnswer(apply, 'discard', {}), {});
  assert.throws(() => prepareQuestion({
    ...f.question, fields: [{ id: 'environment', type: 'select', label: 'Environment', choices: ['Same name', 'Same name'] }],
  }, artifactBinding(f.root, ['canonical.json']), f.descriptor), /unambiguous/);
});

test('real helper CLI posts a nested typed question, blocks, and resumes the same job without duplicate questions', async (t) => {
  const f = await fixture(t, { answer: { scope: 'Selection', preserve: true, detail: 'Cards only' }, postFailures: 1 });
  const args = ['request-question', '--input', '.devplayer-builder/logs/input/question.json', '--bind', 'canonical.json', '--wait-ms', '2000'];
  const first = await f.cli(args);
  assert.equal(first.code, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.action, 'approve');
  assert.deepEqual(result.answer, f.state.answer);
  assert.equal(result.gateRecorded, false);
  assert.equal(readJson(f.root, result.receipt).receipt.attemptId, f.descriptor.attemptId);
  const second = await f.cli(args);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).receipt, result.receipt);
  assert.equal(f.state.questions.size, 1);
  const posts = f.state.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/questions'));
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((request) => request.raw)).size, 1);
  assert.ok(f.state.requests.every((request) => request.url.startsWith('/runner/jobs/test-job/')));
  assert.ok(f.state.requests.every((request) => !request.url.includes(f.token) && !request.raw.includes(f.token)));
  assert.ok(!first.stdout.includes(f.token) && !first.stderr.includes(f.token));
});

test('a bounded pending wait retains its exact question for resume and never asks on the CLI', async (t) => {
  const f = await fixture(t, { pending: true });
  const input = { ...f.question, fields: [] };
  await assert.rejects(f.client().requestQuestion(input, { bind: ['canonical.json'], waitMs: 100 }), /timed out/);
  assert.equal(f.state.questions.size, 1);
  f.state.pending = false;
  const result = await f.client().requestQuestion(input, { bind: ['canonical.json'], waitMs: 1000 });
  assert.equal(result.receipt.action, 'approve');
  assert.equal(f.state.questions.size, 1);
  const controller = new AbortController();
  f.state.pending = true;
  const waiting = f.client({ signal: controller.signal }).requestQuestion({ ...input, gateId: 'cancel-me' }, { bind: ['canonical.json'], waitMs: 1000 });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, /cancelled|aborted/);
});

test('stale/cancelled/unauthorized attempts fail immediately and error bodies never leak credentials', async (t) => {
  const f = await fixture(t);
  for (const status of [401, 403, 404, 409, 410]) {
    f.state.status = status;
    const before = f.state.requests.length;
    const result = await f.cli(['verify']);
    assert.equal(result.code, 2);
    assert.equal(f.state.requests.length, before + 1);
    assert.ok(!result.stdout.includes(f.token) && !result.stderr.includes(f.token));
    assert.equal(result.stdout, '');
  }
  f.state.status = 200;
  f.state.handshake = { workspaceDir: f.base };
  await assert.rejects(f.client().verify(), /another candidate workspace/);
});

test('redirects never forward a scoped token to another origin', async (t) => {
  const f = await fixture(t);
  let redirectedRequests = 0;
  const other = http.createServer((request, response) => { redirectedRequests += 1; response.end('{}'); });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  f.state.status = 307;
  f.state.location = `http://127.0.0.1:${other.address().port}/steal`;
  const result = await f.cli(['verify']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /redirect/i);
  assert.equal(redirectedRequests, 0);
});

test('invalid typed answers and receipt tampering never persist verified decisions', async (t) => {
  const f = await fixture(t, { answer: { scope: 'App', preserve: 'true', detail: '' } });
  const binding = artifactBinding(f.root, ['canonical.json']);
  const question = prepareQuestion(f.question, binding, f.descriptor);
  await assert.rejects(f.client().requestQuestion(f.question, { bind: ['canonical.json'] }), /wrong field type/);
  assert.equal(exists(f.root, journalPath(f.descriptor, `decisions/${digest(question.id)}.json`)), false);
  f.state.receipts.clear();
  f.state.answer = { scope: 'App', preserve: true, detail: '' };
  f.state.tamper = (receipt) => ({ ...receipt, answer: { ...receipt.answer, detail: 'tampered after signing' } });
  await assert.rejects(f.client().requestQuestion(f.question, { bind: ['canonical.json'] }), /signature/);
});

test('artifact changes during a question invalidate the exact approval, not remote evidence', async (t) => {
  const f = await fixture(t, { answer: { scope: 'App', preserve: true, detail: '' } });
  write(f.root, '.tmp/remote-execution-journal.json', { applied: ['keep-this'] });
  f.state.onQuestion = () => write(f.root, 'canonical.json', { revision: 2 });
  await assert.rejects(f.client().requestQuestion(f.question, { bind: ['canonical.json'] }), /artifacts changed/);
  assert.deepEqual(readJson(f.root, '.tmp/remote-execution-journal.json'), { applied: ['keep-this'] });
  assert.throws(() => artifactBinding(f.root, ['.tmp/remote-execution-journal.json']), /canonical/);
  assert.throws(() => artifactBinding(f.root, ['../escape.json']), /safe project-relative/);
});

test('gate receipts bind canonical gate artifacts, ignore mutable pipeline state, and are recorded only after maker verification', async (t) => {
  const f = await fixture(t);
  for (const [name, value] of Object.entries({
    'product-experience-contract': { contractType: 'product-experience', schemaVersion: 1 },
    'product-scope-contract': { contractType: 'product-scope', schemaVersion: 1 },
    'navigation-manifest': { navigationRevision: 'b'.repeat(64) },
    'architecture-decisions': { nativeCapabilities: [], connectors: [] },
    'persistence-contract': { mode: 'local-prototype', persistenceRevision: 'c'.repeat(64) },
  })) write(f.root, `.tmp/${name}.json`, value);
  const before = gateBinding(f.root, 1);
  write(f.root, '.tmp/pipeline-state.json', { changed: true });
  assert.equal(gateBinding(f.root, 1).sourceRevision, before.sourceRevision);
  write(f.root, '.devplayer-builder/logs/input/gate.json', {
    kind: 'plan', title: 'Approve architecture', summary: 'Approve the current product scope and local persistence.',
  });
  const result = await f.cli(['request-question', '--input', '.devplayer-builder/logs/input/gate.json', '--record-gate', '1']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).gateRecorded, true);
  assert.equal(readJson(f.root, '.tmp/mobile-plan-status.json').gates.gate1.status, 'approved');
  write(f.root, '.tmp/architecture-decisions.json', { nativeCapabilities: [{ id: 'camera' }], connectors: [] });
  const receiptPath = JSON.parse(result.stdout).receipt;
  await assert.rejects(f.client().verifySavedDecision(receiptPath, { gateId: 'gate1' }), /artifacts changed/);
  assert.throws(() => prepareQuestion({ kind: 'schema', title: 'bad', summary: 'bad' }, before, f.descriptor), /plan question/);
});

test('conditional data gates bind the entire local domain/rules contract, not a mutable execution journal', async (t) => {
  const f = await fixture(t);
  for (const name of [
    'product-experience-contract', 'product-scope-contract', 'navigation-manifest', 'architecture-decisions',
    'workflow-journey-contract', 'compiled-screen-build-pack', 'scenario-facts', 'data-model-usage',
  ]) write(f.root, `.tmp/${name}.json`, { schemaVersion: 1, fixture: name });
  write(f.root, '.tmp/persistence-contract.json', { mode: 'local-prototype' });
  write(f.root, 'native-app-plan.md', [
    'App Requirements', 'Product Experience', 'Product Scope', 'Native Capabilities',
    'Connectors', 'Persistence', 'Data Model', 'Screens',
  ].map((heading) => `## ${heading}\nReviewed content.\n`).join('\n'));
  write(f.root, '.tmp/prototype-domain.json', { schemaVersion: 1, domain: 'local' });
  assert.throws(() => gateBinding(f.root, 2), /complete domain/);
  write(f.root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [] });
  write(f.root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
  const before = gateBinding(f.root, 2);
  assert.ok(before.files.some((file) => file.path === '.tmp/prototype-domain.json'));
  write(f.root, '.tmp/pipeline-state.json', { mutable: 'does-not-authorize-an-edit' });
  assert.equal(gateBinding(f.root, 2).sourceRevision, before.sourceRevision);
  write(f.root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [{ id: 'new-conditional-rule' }] });
  assert.notEqual(gateBinding(f.root, 2).sourceRevision, before.sourceRevision);
});

test('progress and completion callbacks keep retry IDs and cannot claim ready or publish', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  await client.event({ kind: 'screen', screenId: 'work-list', state: 'building', message: 'Building work list' });
  await client.event({ kind: 'screen', screenId: 'work-list', state: 'building', message: 'Building work list' });
  const events = f.state.requests.filter((request) => request.url.endsWith('/events'));
  assert.equal(events[0].raw, events[1].raw);
  await assert.rejects(client.event({ kind: 'screen', screenId: 'work-list', state: 'ready' }), /bridge-published/);
  await assert.rejects(client.event({ kind: 'plan', screens: [{ id: 'work-list', title: 'Work', route: '/work', state: 'ready' }] }), /planned screens/);
  await assert.rejects(client.event({ kind: 'step', message: f.token }), /credentials/);
  await client.complete();
  await client.complete();
  const complete = f.state.requests.filter((request) => request.url.endsWith('/complete'));
  assert.equal(complete[0].raw, complete[1].raw);
  assert.ok(!f.state.requests.some((request) => /\/(?:apply|publish)/.test(request.url)));
});

test('all nested foreground questions inherit Player transport and standalone editing keeps its ordinary question tool', () => {
  const root = path.resolve(__dirname, '../..');
  const core = fs.readFileSync(path.join(root, 'shared/shared-instructions-core.md'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, 'skills/edit-app/SKILL.md'), 'utf8');
  const reference = fs.readFileSync(path.join(root, 'skills/edit-app/references/player-authoring.md'), 'utf8');
  const transport = fs.readFileSync(path.join(root, 'shared/references/mobile-authoring.md'), 'utf8');
  assert.match(core, /every foreground skill \(including nested and\s+direct-read helpers\)/);
  assert.match(core, /MUST follow \[Player question transport\]\(references\/mobile-authoring\.md\)/);
  assert.match(core, /Otherwise use ordinary `AskUserQuestion`/);
  assert.match(transport, /Do not also call `AskUserQuestion`/);
  assert.match(transport, /every nested foreground skill/);
  assert.match(workflow, /native-app-plan\.md` is their human projection/);
  assert.match(workflow, /invalidate --from-gate 1/);
  assert.match(reference, /All inspection[\s\S]*saves/);
  assert.match(reference, /do not issue a[\s\S]*second Apply question/);
  assert.doesNotMatch(workflow, /native-app-plan\.md` remains the source of truth/);
});
