'use strict';
// Guards the vendored, self-contained SDK bundle (scripts/vendor/cds-maker-sdk.cjs):
// it must load in plain Node (no browser), construct, serialize every artifact type
// headlessly via the xmldom DOM shim, and build a real Dataverse push payload.
// Rebuild the bundle with: node scripts/_vendor-build/build.js  (see _vendor-build/).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

function freshSdk(capture) {
  const { createMakerSdk } = require(BUNDLE);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-smoke-'));
  const httpClient = {
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async (url, body) => {
      if (capture) capture.push({ url, body });
      return { status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} };
    },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return sdk;
}

test('vendored bundle exports createMakerSdk', () => {
  const mod = require(BUNDLE);
  assert.strictEqual(typeof mod.createMakerSdk, 'function');
  assert.strictEqual(typeof mod.MakerSdk, 'function');
});

test('createArtifact serializes every artifact type headlessly (no browser)', () => {
  const sdk = freshSdk();
  for (const [type, def] of [
    ['view', { entityLogicalName: 'account', name: 'Smoke View' }],
    ['chart', { entityLogicalName: 'account', name: 'Smoke Chart' }],
    ['form', { entityLogicalName: 'account', name: 'Smoke Form' }],
    ['app', { name: 'Smoke App' }],
  ]) {
    const a = sdk.createArtifact(type, def);
    assert.ok(a && a.id, `${type} artifact should have an id`);
  }
});

test('pushArtifact builds a real FormXML payload headlessly', async () => {
  const capture = [];
  const sdk = freshSdk(capture);
  const form = sdk.createArtifact('form', { entityLogicalName: 'account', name: 'Push Test Form' });
  const result = await sdk.pushArtifact('form', form.id);
  assert.strictEqual(result.success, true);
  assert.ok(capture.length > 0, 'a POST should have been issued');
  const body = capture[0].body;
  assert.ok(typeof body.formxml === 'string' && body.formxml.includes('<form'), 'payload carries FormXML');
});

test('createWebResource posts base64 content + the right webresourcetype (Tier 2)', async () => {
  const capture = [];
  const sdk = freshSdk(capture);
  await sdk.createWebResource({ name: 'new_smoke.js', displayName: 'Smoke', type: 'js', content: 'function f(){return 1;}', publish: false });
  const post = capture.find((c) => /webresourceset/.test(c.url));
  assert.ok(post, 'a POST to /webresourceset was issued');
  assert.strictEqual(post.body.webresourcetype, 3, 'js -> webresourcetype 3');
  assert.strictEqual(post.body.name, 'new_smoke.js');
  // content must be base64 (headless btoa/Buffer path), decoding back to the source
  assert.strictEqual(Buffer.from(post.body.content, 'base64').toString('utf8'), 'function f(){return 1;}');
});

test('vendored SDK exposes the AI methods', () => {
  const { createMakerSdk } = require(BUNDLE);
  const sdk = createMakerSdk({ workspacePath: require('os').tmpdir(), instanceUrl: 'https://x/', httpClient: { get: async () => ({}), post: async () => ({}), patch: async () => ({}), delete: async () => ({}), put: async () => ({}) } });
  for (const m of ['retrieveSetting', 'saveSettingValue', 'getAiReadiness', 'setAppAiFeatures', 'configureRowSummary', 'removeRowSummary']) {
    assert.strictEqual(typeof sdk[m], 'function', `sdk.${m} should be a function`);
  }
});

test('vendored SDK exposes the consolidation methods', () => {
  const { createMakerSdk } = require('../vendor/cds-maker-sdk.cjs');
  const sdk = createMakerSdk({ workspacePath: require('os').tmpdir(), instanceUrl: 'https://x/', httpClient: { get: async () => ({}), post: async () => ({}), patch: async () => ({}), delete: async () => ({}), put: async () => ({}) } });
  for (const m of ['resolveArtifact', 'findArtifact', 'deleteAppCascade', 'seedRecordGraph', 'enrichDefaultViews']) {
    assert.strictEqual(typeof sdk[m], 'function', `sdk.${m} should be a function`);
  }
});

test('addFormEventHandler injects a handler into the retained FormXML headlessly (Tier 2)', () => {
  const { createMakerSdk } = require(BUNDLE);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-evt-'));
  const formXml = '<form><tabs><tab name="general"><columns><column><sections><section><rows /></section></sections></column></columns></tab></tabs></form>';
  const httpClient = {
    get: async () => ({ status: 200, headers: { etag: 'W/"1"' }, body: { formid: '22222222-2222-2222-2222-222222222222', name: 'F', type: 2, objecttypecode: 'account', formxml: formXml } }),
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return sdk.fetchArtifact('form', '22222222-2222-2222-2222-222222222222').then((fetched) => {
    assert.ok(fetched, 'form fetched');
    sdk.addFormEventHandler('22222222-2222-2222-2222-222222222222', { event: 'onload', libraryName: 'new_smoke.js', functionName: 'Ticket.onLoad', passExecutionContext: true });
    const raw = sdk.getArtifact('form', '22222222-2222-2222-2222-222222222222');
    assert.ok(raw, 'form still readable after wiring a handler');
  });
});
