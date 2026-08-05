'use strict';
// REAL-BUNDLE contract tests for `setAppAiFeatures` (ADO 6603383 / 6560699).
//
// The plugin's build engine branches on the SHAPE of this result — `applied` is the only success
// bucket, and `notPersisted` / `unverified` / `failed` each have to reach the user. Every other test
// of that branching drives a hand-written mock, so if a re-vendored SDK changed the bucket semantics
// the mocks would stay green while the real bundle behaved differently. That is exactly how the
// original false PASS shipped, so these drive the REAL vendored bundle over a fake httpClient and
// assert the semantics the engine relies on.
//
// The SDK's own Jest suite cannot run here (its `canvas` native module is built for the Node-20 ABI),
// which makes this the only executable check of the shipped bundle's behavior on this path.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

const APP = 'co_supportdesk';
const APP_ID = '11111111-1111-1111-1111-111111111111';
// The PER-APP setting for formFill. Note it doubles as its own org gate in the SDK's AI_GATE map,
// which is why the gate is deliberately read at ORG scope (an app-scope 0 must not look like "the
// environment forbids this" and permanently block re-enabling).
const SETTING = 'FormFillBarUXEnabled';
const DEF_ID = '22222222-2222-2222-2222-222222222222';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * A real SDK over a fake Dataverse. `opts`:
 *   overrideRows  - value[] returned by the /appsettings proof query. A FUNCTION is called with the
 *                   1-based attempt number so a test can model eventual consistency (empty, then
 *                   the row appears). An array is returned verbatim every attempt.
 *   effective     - what RetrieveSetting reports at APP scope (the environment-fallback value).
 *   gate          - what RetrieveSetting reports at ORG scope (the readiness gate).
 *   failProof     - throw from the /appsettings query (models missing read access).
 *   failWrite     - throw from POST /SaveSettingValue.
 */
function freshSdk(opts = {}) {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-real-'));
  tempDirs.push(dir);
  const calls = [];
  let proofAttempts = 0;
  const httpClient = {
    get: async (url) => {
      calls.push({ method: 'GET', url });
      // /RetrieveSetting(SettingName='X')            -> ORG scope (the readiness gate)
      // /RetrieveSetting(SettingName='X',AppUniqueName='Y') -> APP scope (effective, may fall back)
      if (url.includes('/RetrieveSetting(')) {
        const scoped = url.includes('AppUniqueName=');
        const value = scoped ? opts.effective : opts.gate;
        return { status: 200, headers: {}, body: { SettingDetail: { Value: value, DataType: 0 } } };
      }
      if (url.includes('/appmodules')) {
        return { status: 200, headers: {}, body: { value: opts.noApp ? [] : [{ appmoduleid: APP_ID }] } };
      }
      if (url.includes('/settingdefinitions')) {
        return { status: 200, headers: {}, body: { value: [{ settingdefinitionid: DEF_ID }] } };
      }
      if (url.includes('/appsettings')) {
        proofAttempts += 1;
        if (opts.failProof) throw new Error('403 forbidden');
        const rows = typeof opts.overrideRows === 'function' ? opts.overrideRows(proofAttempts) : (opts.overrideRows || []);
        return { status: 200, headers: {}, body: { value: rows } };
      }
      return { status: 200, headers: {}, body: {} };
    },
    post: async (url, body) => {
      calls.push({ method: 'POST', url, body });
      if (url.includes('/SaveSettingValue') && opts.failWrite) throw new Error('boom from SaveSettingValue');
      return { status: 204, headers: {}, body: {} };
    },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, calls, proofCount: () => proofAttempts };
}
// `verifyDelayMs: 0` keeps the retry budget instant — the real default backs off up to ~3s.
const FAST = { verifyDelayMs: 0 };

test('REAL BUNDLE: a proven app-scope override row is the only thing that yields `applied`', async () => {
  const { sdk } = freshSdk({ gate: '1', effective: '1', overrideRows: [{ value: '1' }] });
  const r = await sdk.setAppAiFeatures(APP, { formFill: true }, FAST);
  assert.deepStrictEqual(r.applied, ['formFill']);
  assert.deepStrictEqual([r.notPersisted, r.unverified, r.failed], [[], [], []]);
  assert.strictEqual(r.outcomes[0].appOverrideExists, true);
});

test('REAL BUNDLE: an ENV-fallback match with NO override row is notPersisted, not applied', async () => {
  // The false PASS the plugin's verify oracle also had to fix: RetrieveSetting at app scope returns
  // the ENVIRONMENT value, so the write reads back as requested while `appsettings` holds no row.
  const { sdk } = freshSdk({ gate: '1', effective: '1', overrideRows: [] });
  const r = await sdk.setAppAiFeatures(APP, { formFill: true }, FAST);
  assert.deepStrictEqual(r.applied, [], 'an env-fallback read must never count as applied');
  assert.deepStrictEqual(r.notPersisted, ['formFill']);
  assert.strictEqual(r.outcomes[0].status, 'notPersisted');
});

test('REAL BUNDLE: a write that becomes visible late is retried and reported applied', async () => {
  // Eventual consistency: an immediate read can miss a write that DID land. Reporting that as failed
  // produced a false `notPersisted` on first apply (a re-run then looked clean).
  const { sdk, proofCount } = freshSdk({ gate: '1', effective: '1', overrideRows: (n) => (n >= 3 ? [{ value: '1' }] : []) });
  const r = await sdk.setAppAiFeatures(APP, { formFill: true }, FAST);
  assert.deepStrictEqual(r.applied, ['formFill'], 'the retry budget must absorb read lag');
  assert.strictEqual(proofCount(), 3, 'stops as soon as the override is observed');
});

test('REAL BUNDLE: an unreadable override row is `unverified`, never applied and never notPersisted', async () => {
  const { sdk } = freshSdk({ gate: '1', effective: '1', failProof: true });
  const r = await sdk.setAppAiFeatures(APP, { formFill: true }, FAST);
  assert.deepStrictEqual(r.unverified, ['formFill']);
  assert.deepStrictEqual([r.applied, r.notPersisted], [[], []]);
  assert.strictEqual(r.outcomes[0].appOverrideExists, undefined, 'no stale existence flag when we could not look');
});

test('REAL BUNDLE: a throwing write lands in `failed` and does not abort the batch', async () => {
  const { sdk } = freshSdk({ gate: '1', effective: '1', failWrite: true });
  const r = await sdk.setAppAiFeatures(APP, { formFill: true, nlChart: true }, FAST);
  assert.deepStrictEqual(r.failed.sort(), ['formFill', 'nlChart'], 'every feature still reports');
  assert.deepStrictEqual(r.applied, []);
  assert.match(r.outcomes[0].reason, /boom from SaveSettingValue/);
});

test('REAL BUNDLE: an org gate that is off yields `skipped` and issues no write', async () => {
  const { sdk, calls } = freshSdk({ gate: '0', effective: '0', overrideRows: [] });
  const r = await sdk.setAppAiFeatures(APP, { formFill: true }, FAST);
  assert.deepStrictEqual(r.skipped, ['formFill']);
  assert.strictEqual(calls.filter((c) => c.method === 'POST' && c.url.includes('SaveSettingValue')).length, 0);
});

test('REAL BUNDLE: disabling is never gated — it writes even when the org gate is off', async () => {
  const { sdk, calls } = freshSdk({ gate: '0', effective: '0', overrideRows: [{ value: '0' }] });
  const r = await sdk.setAppAiFeatures(APP, { formFill: false }, FAST);
  assert.deepStrictEqual(r.applied, ['formFill'], 'an explicit disable must always be applied');
  const write = calls.find((c) => c.method === 'POST' && c.url.includes('SaveSettingValue'));
  assert.strictEqual(write.body.Value, '0');
});

test('REAL BUNDLE: an explicit integer value (2 = on for everyone) is written verbatim', async () => {
  // The plugin's spec schema allows this precisely because the SDK does; a boolean-only contract made
  // the platform's documented `2` inexpressible (ADO 6560699).
  const { sdk, calls } = freshSdk({ gate: '1', effective: '2', overrideRows: [{ value: '2' }] });
  const r = await sdk.setAppAiFeatures(APP, { formFill: 2 }, FAST);
  assert.deepStrictEqual(r.applied, ['formFill']);
  assert.strictEqual(calls.find((c) => c.method === 'POST' && c.url.includes('SaveSettingValue')).body.Value, '2');
});

test('REAL BUNDLE: an out-of-range or non-numeric value throws BEFORE any write is issued', async () => {
  // The plugin's validateAppSpec bound mirrors this, so a spec never reaches a half-applied batch.
  for (const bad of [-1, 1.5, 1000001, 'off']) {
    const { sdk, calls } = freshSdk({ gate: '1', effective: '1', overrideRows: [{ value: '1' }] });
    await assert.rejects(() => sdk.setAppAiFeatures(APP, { formFill: bad }, FAST), /must be a boolean or an integer/, `expected ${bad} to be rejected`);
    assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 0, `no write may be issued for ${bad}`);
  }
});

test('REAL BUNDLE: an empty appUniqueName throws rather than writing at ORGANIZATION scope', async () => {
  // Silently omitting AppUniqueName changes the feature for the WHOLE environment. The plugin always
  // passes appUniqueName(spec), but this is the backstop that makes a regression there loud.
  const { sdk, calls } = freshSdk({ gate: '1', effective: '1', overrideRows: [{ value: '1' }] });
  await assert.rejects(() => sdk.setAppAiFeatures('', { formFill: true }, FAST), /non-empty appUniqueName/);
  assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 0);
});

test('REAL BUNDLE: the override proof is scoped to THIS app and THIS setting', async () => {
  const { sdk, calls } = freshSdk({ gate: '1', effective: '1', overrideRows: [{ value: '1' }] });
  await sdk.setAppAiFeatures(APP, { formFill: true }, FAST);
  const proof = calls.find((c) => c.url.includes('/appsettings'));
  assert.ok(proof, 'the override row must actually be queried');
  // GUID lookup values are compared UNQUOTED in an OData $filter.
  assert.ok(proof.url.includes(`_parentappmoduleid_value%20eq%20${APP_ID}`) || proof.url.includes(`_parentappmoduleid_value eq ${APP_ID}`), `app not scoped: ${proof.url}`);
  assert.ok(proof.url.includes(DEF_ID), `setting not scoped: ${proof.url}`);
  // ...and the app id came from THIS app's unique name.
  assert.ok(calls.some((c) => c.url.includes('/appmodules') && c.url.includes(APP)), 'app module resolved by unique name');
});
