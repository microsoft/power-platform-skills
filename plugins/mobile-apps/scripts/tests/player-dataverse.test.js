'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { playerDataverse, PlayerDataverse, applyBrokerArtifacts } = require('../lib/player-dataverse');
const { protocolHash } = require('../lib/mobile-authoring-context');
const { artifactBinding, prepareQuestion, questionDigest } = require('../lib/mobile-authoring-decisions');
const { canonicalJson, digest } = require('../lib/mobile-authoring-files');
const { resolveEnvironment } = require('../resolve-environment');
const { createCliRequest } = require('../create-dataverse-snapshot');
const { createDataverseRequestExecutor } = require('../dataverse-request');
const { executeManifest } = require('../execute-dataverse-operation-manifest');
const { generateDataverseServices } = require('../generate-dataverse-services');
const { sha256, stableJson } = require('../build-dataverse-operation-manifest');
const { approvedSchema, write } = require('./helpers/dataverse-broker-fixture');
const protocol = require('../lib/authoring-protocol');

const ENVIRONMENT = {
  environmentId: '11111111-1111-4111-8111-111111111111',
  environmentUrl: 'https://contoso.crm.dynamics.com',
  tenantId: '22222222-2222-4222-8222-222222222222',
  publisherPrefix: 'new', solutionUniqueName: 'Default',
};

function work(t) {
  const root = path.join(__dirname, `.player-dataverse-work-${crypto.randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function signed(question, descriptor, privateKey) {
  const receipt = {
    protocolVersion: 2, issuer: protocol.PROTOCOL_ID,
    appInstanceId: descriptor.appInstanceId, jobId: descriptor.jobId, attemptId: descriptor.attemptId,
    approvalId: question.id, approvalRevision: 1, gateId: question.gateId,
    sourceRevision: question.sourceRevision, questionDigest: questionDigest(question),
    action: 'approve', answer: {}, issuedAt: new Date().toISOString(),
  };
  return { receipt, signature: crypto.sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString('base64') };
}

test('Player selection validates the immutable descriptor before reaching any desktop adapter', async (t) => {
  const root = work(t);
  const candidate = path.join(root, 'candidate');
  fs.mkdirSync(candidate);
  const keys = crypto.generateKeyPairSync('ed25519');
  const descriptor = {
    protocolVersion: 2, protocolHash: protocolHash(), bridgeUrl: 'http://127.0.0.1:5177',
    appInstanceId: crypto.randomUUID(), jobId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
    operation: 'connect', baseRevision: 'a'.repeat(64), workspaceDir: candidate,
    decisionPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const file = path.join(root, 'descriptor.json');
  fs.writeFileSync(file, JSON.stringify(descriptor), { mode: 0o444 });
  const env = { MOBILE_AUTHORING_CONTEXT: file, MOBILE_AUTHORING_RUNNER_TOKEN: crypto.randomBytes(32).toString('base64url') };
  let calls = 0;
  const client = { descriptor };
  const options = { env, projectRoot: candidate, cwd: candidate, createPlayerClient: () => { calls += 1; return client; } };
  assert.ok(playerDataverse(options) instanceof PlayerDataverse);
  assert.equal(calls, 1);
  assert.equal(playerDataverse({ env: {} }), null);
  assert.throws(() => playerDataverse({ ...options, projectRoot: root }), /does not match/);
  fs.chmodSync(file, 0o644);
  assert.throws(() => playerDataverse(options), /must not be runner-writable/);
  assert.equal(calls, 1);
  await assert.rejects(resolveEnvironment(ENVIRONMENT.environmentId, options), /must not be runner-writable/);
});

test('metadata and resolver adapters avoid all ordinary auth paths and enforce GET-only execution', async () => {
  const requests = [];
  const client = {
    descriptor: { operation: 'connect', workspaceDir: process.cwd() },
    dataverse: async (input) => { requests.push(input); return { status: 200, data: { value: [] } }; },
  };
  const broker = new PlayerDataverse(client);
  for (const request of [
    createCliRequest({ 'env-url': ENVIRONMENT.environmentUrl }, () => { throw new Error('ordinary executor called'); }, { playerBroker: broker }),
    createDataverseRequestExecutor({
      environmentUrl: ENVIRONMENT.environmentUrl, playerBroker: broker,
      getToken: () => { throw new Error('ordinary auth called'); },
    }),
  ]) {
    await request('GET', 'EntityDefinitions?$select=LogicalName');
    await assert.rejects(request('POST', 'EntityDefinitions', '{}'), /GET-only/);
  }
  assert.equal(requests.length, 2);
  let resolved = false;
  const result = await resolveEnvironment(ENVIRONMENT.environmentId, {
    noCache: true, playerBroker: { resolveEnvironment: async (target, options) => {
      assert.equal(target, ENVIRONMENT.environmentId);
      assert.equal(options.noCache, true);
      resolved = true;
      return ENVIRONMENT;
    } },
  });
  assert.equal(resolved, true);
  assert.equal(result.environmentUrl, ENVIRONMENT.environmentUrl);
});

test('new attempts reacquire discovery consent for the same target without discarding earlier remote evidence', async (t) => {
  const root = work(t);
  const descriptor = {
    operation: 'connect', workspaceDir: root, appInstanceId: crypto.randomUUID(), jobId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
  };
  let questions = 0;
  const client = {
    descriptor, verify: async () => descriptor,
    requestQuestion: async () => { questions += 1; return { receipt: { action: 'approve' } }; },
  };
  write(root, '.tmp/prototype-dataverse-remote-journal.json', '{"retained":"remote evidence"}');
  await new PlayerDataverse(client).discovery(ENVIRONMENT.environmentId);
  const first = fs.readFileSync(path.join(root, '.tmp/dataverse-discovery-target.json'), 'utf8');
  descriptor.attemptId = crypto.randomUUID();
  await new PlayerDataverse(client).discovery(ENVIRONMENT.environmentId);
  assert.equal(questions, 2);
  assert.notEqual(fs.readFileSync(path.join(root, '.tmp/dataverse-discovery-target.json'), 'utf8'), first);
  assert.equal(fs.readFileSync(path.join(root, '.tmp/prototype-dataverse-remote-journal.json'), 'utf8'), '{"retained":"remote evidence"}');
  await assert.rejects(new PlayerDataverse(client).discovery('https://another.crm.dynamics.com'), /target changed/);
});

test('skill-owned discovery and schema questions do not execute, sign the app in, Apply, or import samples', async (t) => {
  const root = work(t);
  const questions = [];
  const descriptor = {
    operation: 'connect', workspaceDir: root, appInstanceId: crypto.randomUUID(),
    jobId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
  };
  const manifest = { binding: ENVIRONMENT, execution: { phases: [] } };
  write(root, '.tmp/dataverse-operation-manifest.json', JSON.stringify(manifest));
  const client = {
    descriptor, verify: async () => descriptor,
    requestQuestion: async (question) => { questions.push(question); return { receipt: { action: 'approve' } }; },
    dataverse: () => assert.fail('Approving a question must not invoke privileged execution or Apply'),
  };
  const adapter = new PlayerDataverse(client);
  await adapter.discovery(ENVIRONMENT.environmentId);
  await adapter.schema(manifest);
  assert.deepEqual(questions.map(({ gateId }) => gateId), ['dataverse-discovery', 'dataverse-schema']);
  assert.match(questions[0].summary, /desktop CLI sign-in/);
  assert.match(questions[0].items.join(' '), /separate from the app’s existing native Microsoft sign-in/);
  assert.match(questions[1].items.join(' '), /No sample records/);
  assert.match(questions[1].items.join(' '), /Apply and preview record-write grants remain separate/);
});

test('artifact installation preserves source/native auth/dependencies and rejects stale or secret-bearing output', (t) => {
  const root = work(t);
  write(root, 'package.json', '{"name":"keep-me","scripts":{"prepare":"never run"}}');
  write(root, 'auth.config.json', '{"msal":{"clientId":"existing-native-registration"}}');
  write(root, 'app/index.tsx', 'export const existingScreen = true;\n');
  write(root, '.tmp/dataverse-schema-contract.json', '{"immutable":true}');
  const baseline = Object.fromEntries(['package.json', 'auth.config.json', 'app/index.tsx', '.tmp/dataverse-schema-contract.json']
    .map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const content = 'export const officialFixture = true;\n';
  const entry = { path: 'src/generated/services/NewItemsService.ts', content, sha256: digest(content), previousSha256: null };
  applyBrokerArtifacts(root, { ok: true, artifacts: [entry] });
  assert.equal(fs.readFileSync(path.join(root, entry.path), 'utf8'), content);
  assert.throws(() => applyBrokerArtifacts(root, { artifacts: [entry] }), /changed while the broker/);
  for (const file of ['package.json', 'auth.config.json', 'app/index.tsx', '.tmp/dataverse-schema-contract.json', 'src/generated/../../package.json']) {
    assert.throws(() => applyBrokerArtifacts(root, { artifacts: [{ ...entry, path: file }] }));
  }
  assert.throws(() => applyBrokerArtifacts(root, { artifacts: [], accessToken: 'private-token' }), /unsafe response/);
  const secretContent = '{"access_token":"another-private-token"}';
  assert.throws(() => applyBrokerArtifacts(root, { artifacts: [{ ...entry, content: secretContent, sha256: digest(secretContent) }] }), /unsafe response/);
  const previousJournal = '{"schemaVersion":1,"completed":{"older":"retained"},"inFlight":null}';
  write(root, '.tmp/prototype-dataverse-remote-journal.json', previousJournal);
  const nextJournal = '{"schemaVersion":1,"completed":{"new":"recorded"},"inFlight":null}';
  applyBrokerArtifacts(root, { artifacts: [{
    path: '.tmp/prototype-dataverse-remote-journal.json', content: nextJournal, sha256: digest(nextJournal), previousSha256: null,
  }] });
  assert.equal(fs.readFileSync(path.join(root, `.tmp/prototype-dataverse-remote-history/${digest(previousJournal)}.json`), 'utf8'), previousJournal);
  for (const [file, before] of Object.entries(baseline)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), before);
});

const brokerModule = process.env.DEV_PLAYER_BROKER_MODULE;

async function integration(t, { failPublish = false } = {}) {
  const { DataverseBroker } = require(path.resolve(brokerModule));
  const { DesktopAuthentication } = require(path.join(path.dirname(path.resolve(brokerModule)), 'authoring-desktop-auth.js'));
  const root = work(t);
  const candidate = path.join(root, 'candidate');
  fs.mkdirSync(candidate);
  const keys = crypto.generateKeyPairSync('ed25519');
  const descriptor = {
    appInstanceId: crypto.randomUUID(), jobId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
    workspaceDir: candidate, operation: 'connect',
  };
  write(candidate, 'package.json', '{"name":"unchanged","scripts":{"prepare":"do-not-run"}}');
  write(candidate, 'app.json', JSON.stringify({ expo: {
    name: 'Existing mobile prototype', extra: { telemetry: { appInstanceId: descriptor.appInstanceId } },
  } }));
  write(candidate, 'auth.config.json', '{"msal":{"clientId":"existing-native-registration"}}');
  write(candidate, 'app/index.tsx', 'export const existingScreen = true;\n');
  const calls = [];
  const official = [];
  let tokenNumber = 0;
  let refreshFirstMutation = true;
  let stopped = false;
  const broker = new DataverseBroker({
    root: path.join(root, 'broker'), pluginDir: path.resolve(__dirname, '../..'), decisionPublicKey: keys.publicKey,
    validateGrant: async (grant) => !stopped && grant.appInstanceId === descriptor.appInstanceId && grant.attemptId === descriptor.attemptId,
    authProvider: new DesktopAuthentication({
      runHelper: async (input) => input.operation === 'environment' ? { ok: true, environment: ENVIRONMENT }
        : { ok: true, token: `private-approved-cli-token-${++tokenNumber}`, tenantId: ENVIRONMENT.tenantId },
    }),
    sendRequest: async (url, token, options) => {
      calls.push({ url: url.href, token, method: options.method || 'GET', body: options.body });
      if (url.hostname === 'api.bap.microsoft.com') return {
        statusCode: 200, data: { name: ENVIRONMENT.environmentId, properties: {
          tenantId: ENVIRONMENT.tenantId, linkedEnvironmentMetadata: { instanceUrl: ENVIRONMENT.environmentUrl },
        } },
      };
      if (!options.method || options.method === 'GET') return { statusCode: 200, data: { value: [] } };
      if (refreshFirstMutation) { refreshFirstMutation = false; return { statusCode: 401 }; }
      if (failPublish && url.pathname.endsWith('/PublishXml')) return { statusCode: 0, error: `raw failure includes ${token}` };
      return { statusCode: 204 };
    },
    runOfficial: async (operation, input) => {
      official.push({ operation, cwd: input.cwd, logicalNames: input.logicalNames });
      assert.notEqual(input.cwd, candidate);
      assert.equal(fs.existsSync(path.join(input.cwd, 'package.json')), false);
      assert.equal(fs.existsSync(path.join(input.cwd, 'auth.config.json')), false);
      assert.equal(input.displayName, 'Existing mobile prototype');
      const config = { environmentId: ENVIRONMENT.environmentId, appType: 'MobileApp' };
      if (operation === 'services') {
        config.databaseReferences = { 'default.cds': { dataSources: {
          new_item: { logicalName: 'new_item', entitySetName: 'new_items' },
        } } };
        write(input.cwd, 'src/generated/services/New_itemsService.ts', 'export class New_itemsService {}\n');
        write(input.cwd, '.power/schemas/new_item.json', '{"fixture":"official output"}');
      }
      write(input.cwd, 'power.config.json', JSON.stringify(config));
      return { ok: true };
    },
  });
  t.after(() => broker.close());
  const client = {
    descriptor,
    verify: async () => {
      assert.equal(stopped, false, 'current attempt required');
      return descriptor;
    },
    requestQuestion: async (input, options) => {
      const binding = artifactBinding(candidate, options.bind);
      const question = prepareQuestion(input, binding, descriptor);
      const approval = signed(question, descriptor, keys.privateKey);
      const plan = signed({ ...question, id: crypto.randomUUID(), gateId: 'gate4', kind: 'plan' }, descriptor, keys.privateKey);
      await broker.grant({
        scope: input.gateId === 'dataverse-discovery' ? 'discovery' : 'schema',
        appInstanceId: descriptor.appInstanceId, jobId: descriptor.jobId, attemptId: descriptor.attemptId,
        workspaceDir: candidate, approval, question: { ...question, revision: 1 }, binding, planApproval: plan,
      });
      return { receipt: approval.receipt };
    },
    dataverse: async (input) => broker.request(descriptor.jobId, { ...input, appInstanceId: descriptor.appInstanceId, attemptId: descriptor.attemptId }),
  };
  const player = new PlayerDataverse(client);
  await resolveEnvironment(ENVIRONMENT.environmentId, { playerBroker: player });
  const metadata = createCliRequest({ 'env-url': ENVIRONMENT.environmentUrl }, undefined, { playerBroker: player });
  const manifest = await approvedSchema(candidate, ENVIRONMENT, metadata);
  assert.equal(manifest.executable, true);
  const schemaBefore = fs.readFileSync(path.join(candidate, '.tmp/dataverse-schema-contract.json'));
  return { root, candidate, descriptor, broker, player, manifest, schemaBefore, calls, official,
    stop() { stopped = true; broker.revoke(descriptor.jobId); } };
}

test('offline cross-repository chain performs consent, discovery, exact execution, auth refresh and official artifact installation', { skip: !brokerModule }, async (t) => {
  const h = await integration(t);
  const untouched = ['package.json', 'auth.config.json', 'app.json', 'app/index.tsx'].map((file) => [file, fs.readFileSync(path.join(h.candidate, file))]);
  await h.player.initialize(h.manifest);
  const result = await executeManifest({
    projectRoot: h.candidate, manifest: h.manifest, environmentUrl: ENVIRONMENT.environmentUrl,
    tenantId: ENVIRONMENT.tenantId, solution: 'Default', playerBroker: h.player,
    getToken: () => { throw new Error('runner must not acquire a token'); },
  });
  assert.equal(result.ok, true);
  const services = await generateDataverseServices({
    projectRoot: h.candidate, manifest: h.manifest, environmentUrl: ENVIRONMENT.environmentUrl,
    tenantId: ENVIRONMENT.tenantId, solution: 'Default', playerBroker: h.player,
    runCommand: () => { throw new Error('runner must not run authenticated CLI'); },
  });
  assert.equal(services.ok, true);
  assert.equal(services.count, 1);
  const resolvedAgain = await resolveEnvironment(ENVIRONMENT.environmentId, { playerBroker: h.player });
  assert.equal(resolvedAgain.environmentUrl, ENVIRONMENT.environmentUrl);
  assert.deepEqual(h.official.map(({ operation }) => operation), ['init', 'services']);
  const mutations = h.calls.filter((call) => call.method === 'POST');
  assert.equal(mutations.length, result.counts.operations + 1, 'only the authenticated 401 retry repeats a request');
  assert.equal(mutations[0].url, mutations[1].url);
  assert.notEqual(mutations[0].token, mutations[1].token);
  assert.ok(h.calls.slice(0, h.calls.indexOf(mutations[0])).every((call) => call.method === 'GET'));
  const journal = fs.readFileSync(path.join(h.candidate, '.tmp/prototype-dataverse-remote-journal.json'), 'utf8');
  assert.doesNotMatch(JSON.stringify([result, services, journal]), /private-approved-cli-token|raw failure/);
  assert.equal(Object.keys(JSON.parse(journal).completed).length, result.counts.operations);
  assert.deepEqual(fs.readFileSync(path.join(h.candidate, '.tmp/dataverse-schema-contract.json')), h.schemaBefore);
  for (const [file, bytes] of untouched) assert.deepEqual(fs.readFileSync(path.join(h.candidate, file)), bytes);
  h.stop();
  await assert.rejects(h.player.request({ operation: 'generate-services', environmentUrl: ENVIRONMENT.environmentUrl, manifestHash: h.manifest.integritySha256 }), /Approve separate/);
});

test('offline cross-repository interruption preserves real remote journal and rejects an unreconciled retry', { skip: !brokerModule }, async (t) => {
  const h = await integration(t, { failPublish: true });
  await assert.rejects(executeManifest({
    projectRoot: h.candidate, manifest: h.manifest, environmentUrl: ENVIRONMENT.environmentUrl,
    tenantId: ENVIRONMENT.tenantId, solution: 'Default', playerBroker: h.player,
  }), /Preserve the remote journal/);
  const file = path.join(h.candidate, '.tmp/prototype-dataverse-remote-journal.json');
  const journal = JSON.parse(fs.readFileSync(file));
  assert.equal(journal.inFlight.failure.uncertain, true);
  assert.ok(Object.keys(journal.completed).length > 0);
  const count = h.calls.filter((call) => call.method === 'POST').length;
  fs.unlinkSync(file);
  h.player.schemaPromise = null;
  await assert.rejects(executeManifest({
    projectRoot: h.candidate, manifest: h.manifest, environmentUrl: ENVIRONMENT.environmentUrl,
    tenantId: ENVIRONMENT.tenantId, solution: 'Default', playerBroker: h.player,
  }), /Preserve the remote journal/);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, count);
  assert.deepEqual(fs.readFileSync(path.join(h.candidate, '.tmp/dataverse-schema-contract.json')), h.schemaBefore);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-approved-cli-token|raw failure/);
});

test('offline signed manifest tampering still fails deterministic schema reconstruction before any mutation or generation', { skip: !brokerModule }, async (t) => {
  const h = await integration(t);
  const changed = structuredClone(h.manifest);
  changed.execution.phases[0].operations[0].body.SchemaName = 'new_not_approved';
  delete changed.integritySha256;
  changed.integritySha256 = sha256(stableJson(changed));
  write(h.candidate, '.tmp/dataverse-operation-manifest.json', stableJson(changed));
  await assert.rejects(h.player.initialize(changed), /deterministic execution validation/);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(h.official.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(h.candidate, '.tmp/dataverse-schema-contract.json')), h.schemaBefore);
});

test('offline revoked attempt cannot race a successor privileged operation against the same app', { skip: !brokerModule }, async (t) => {
  const h = await integration(t);
  const original = h.broker.runOfficial;
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  h.broker.runOfficial = async (...args) => {
    entered();
    await blocked;
    return original(...args);
  };
  const inFlight = h.player.initialize(h.manifest);
  const rejected = assert.rejects(inFlight, /stale or revoked/);
  await started;
  h.broker.revoke(h.descriptor.jobId);
  h.descriptor.attemptId = crypto.randomUUID();
  h.player.schemaPromise = null;
  await h.player.schema(h.manifest);
  await assert.rejects(h.player.request({ operation: 'init', environmentUrl: ENVIRONMENT.environmentUrl }), /already in flight/);
  release();
  await rejected;
  assert.equal(fs.existsSync(path.join(h.candidate, 'power.config.json')), false);
  h.broker.runOfficial = original;
  await h.player.initialize(h.manifest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.candidate, 'power.config.json'))).environmentId, ENVIRONMENT.environmentId);
});
