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
