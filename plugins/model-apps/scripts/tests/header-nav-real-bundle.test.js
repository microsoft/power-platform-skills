'use strict';
// REAL BUNDLE: the header/navigation refresh VALUE ENCODING.
//
// `app.headerNavigationRefresh` delegates to the SDK's `setHeaderAndNavigationRefresh` precisely
// because the encoding is a trap: it is a `datatype = 0` (Number) TRI-STATE where ON is '2', not
// '1'. Of the nine Number settings with rows in a live org, eight use '1' for on and only this one
// uses '2' — and writing '1' is ACCEPTED by the API and then silently fails to enable the feature.
//
// The plugin's own tests stub `setHeaderAndNavigationRefresh` and assert delegation, which is the
// right thing to test on that side. But delegation only protects us if the BUNDLE gets the encoding
// right, and a re-vendor could flip it with every plugin test still green: the plugin would report
// `created.headerNavigationRefresh: true` while the setting quietly did nothing.
//
// So this pins the wire payload against the real bundle, the same way lcid-real-bundle.test.js pins
// the language option.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const APP_ID = '11111111-1111-1111-1111-111111111111';
// Every app the PLUGIN creates carries an icon (`ensureAppIcon` -> `appDef.iconWebResourceId`), and
// the SDK now REQUIRES one: it auto-resolves an IMAGE web resource and throws `APP_ICON_UNRESOLVED`
// when the org has none. It used to fall back to ANY unmanaged web resource, which on an org whose
// images are all managed returned a JAVASCRIPT file and made the platform reject the create with an
// opaque error. These tests drive the SDK directly, so they must pass an icon like production does.
const APP_ICON_ID = '11111111-2222-3333-4444-555555555555';
const dirs = [];

// The setting write is an upsert keyed by (settingdefinitionid, parentappmoduleid), so the SDK first
// looks the definition up and probes for an existing row. Answer both, then record the write.
function sdkWithCapture({ existingRow = null } = {}) {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrnav-'));
  dirs.push(dir);
  const writes = [];
  const httpClient = {
    get: async (url) => {
      const u = String(url);
      if (/settingdefinition/i.test(u)) {
        return { status: 200, headers: {}, body: { value: [{ settingdefinitionid: '22222222-2222-2222-2222-222222222222', uniquename: 'HeaderAndNavigationRefresh', datatype: 0 }] } };
      }
      if (/appsetting/i.test(u)) {
        return { status: 200, headers: {}, body: { value: existingRow ? [existingRow] : [] } };
      }
      return { status: 200, headers: {}, body: {} };
    },
    post: async (url, body) => { writes.push({ verb: 'post', url: String(url), body }); return { status: 204, headers: { 'odata-entityid': 'https://x/appsettings(33333333-3333-3333-3333-333333333333)' }, body: {} }; },
    patch: async (url, body) => { writes.push({ verb: 'patch', url: String(url), body }); return { status: 204, headers: {}, body: {} }; },
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, writes };
}

const settingValueOf = (writes) => {
  const w = writes.find((x) => x.body && typeof x.body.value === 'string');
  return w ? w.body.value : undefined;
};

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('REAL BUNDLE: enabling the header/navigation refresh writes the tri-state ON value "2"', async () => {
  const { sdk, writes } = sdkWithCapture();
  const outcome = await sdk.setHeaderAndNavigationRefresh(APP_ID, true);
  assert.ok(['created', 'updated', 'unchanged'].includes(outcome), `unexpected outcome: ${JSON.stringify(outcome)}`);
  const value = settingValueOf(writes);
  assert.strictEqual(value, '2',
    'ON must be "2". "1" is accepted by the API and then silently fails to enable the feature, so a '
    + 'bundle that wrote "1" would produce a green build with the feature off.');
});

test('REAL BUNDLE: disabling writes "1", and ON/OFF are not the same value', async () => {
  const { sdk, writes } = sdkWithCapture();
  await sdk.setHeaderAndNavigationRefresh(APP_ID, false);
  const off = settingValueOf(writes);
  assert.strictEqual(off, '1', 'OFF is "1"');

  const on = sdkWithCapture();
  await on.sdk.setHeaderAndNavigationRefresh(APP_ID, true);
  // The guard that matters if the constants are ever swapped or collapsed: if ON and OFF serialized
  // identically, every single-value assertion above could still pass on one branch.
  assert.notStrictEqual(settingValueOf(on.writes), off, 'ON and OFF must not serialize to the same value');
});

test('REAL BUNDLE: the setting row is bound to the app module id', async () => {
  // The row is keyed by (settingdefinitionid, parentappmoduleid). Binding the wrong id would write a
  // real row that simply governs nothing — a silent no-op with a success return.
  const { sdk, writes } = sdkWithCapture();
  await sdk.setHeaderAndNavigationRefresh(APP_ID, true);
  const body = writes.find((w) => w.body && typeof w.body.value === 'string')?.body || {};
  const bind = JSON.stringify(body);
  assert.match(bind, new RegExp(APP_ID), `the app module id must appear in the write; got ${bind}`);
  assert.match(bind, /appmodule/i, 'bound through an appmodule navigation property');
});

test('REAL BUNDLE: a non-boolean is rejected rather than coerced', async () => {
  // The plugin validates `app.headerNavigationRefresh` as a boolean, but the SDK is the last line of
  // defence for any other caller: a truthy string like "false" must not be read as ON.
  //
  // Wrapped in an async thunk because the SDK validates SYNCHRONOUSLY — it throws before returning a
  // promise, which `assert.rejects` alone does not treat as a rejection.
  const { sdk } = sdkWithCapture();
  for (const bad of ['true', 'false', 1, 0, null]) {
    await assert.rejects(
      async () => sdk.setHeaderAndNavigationRefresh(APP_ID, bad),
      `${JSON.stringify(bad)} must be rejected, not coerced`
    );
  }
  // And the happy path still works, so the guard is not simply rejecting everything.
  const ok = sdkWithCapture();
  await ok.sdk.setHeaderAndNavigationRefresh(APP_ID, true);
  assert.strictEqual(settingValueOf(ok.writes), '2');
});

test('REAL BUNDLE: a NEW app gets the header/navigation refresh ON by default', async () => {
  // The behaviour that made the plugin's original "opt-in, default off" documentation wrong, and
  // that made a `headerNavigationRefresh: false` in an App Spec a silent no-op.
  //
  // Pushing a brand-new app writes the setting UNPROMPTED. So the platform default is ON, and an
  // author who wants the classic header/navigation needs an ACTIVE off-write — which is why the
  // build honours `false` instead of skipping it. If a future SDK flips this default, this test is
  // what tells us before a user's app silently changes appearance.
  const { sdk, writes } = sdkWithCapture();
  const app = sdk.createArtifact('app', { name: 'Default App', uniqueName: 'cr_defaultapp', iconWebResourceId: APP_ICON_ID });
  assert.strictEqual(app.headerAndNavigationRefresh, true,
    'the SDK defaults the app artifact field to true');

  await sdk.pushArtifact('app', app.id);
  const setting = writes.find((w) => /appsetting/i.test(w.url) && w.body && typeof w.body.value === 'string');
  assert.ok(setting, 'pushing a new app writes an app setting unprompted; urls: ' + JSON.stringify(writes.map((w) => w.url)));
  assert.strictEqual(setting.body.value, '2',
    "the unprompted default write is the ON value '2'");
});

test('REAL BUNDLE: setting headerAndNavigationRefresh false on the app writes the OFF value', async () => {
  // The opt-out path. '1' is OFF for this tri-state; if this ever wrote '2' or nothing, an author
  // asking for the classic experience would silently get the new one.
  const { sdk, writes } = sdkWithCapture();
  const app = sdk.createArtifact('app', { name: 'Off App', uniqueName: 'cr_offapp', headerAndNavigationRefresh: false, iconWebResourceId: APP_ICON_ID });
  assert.strictEqual(app.headerAndNavigationRefresh, false, 'the explicit false survives onto the artifact');

  await sdk.pushArtifact('app', app.id);
  const setting = writes.find((w) => /appsetting/i.test(w.url) && w.body && typeof w.body.value === 'string');
  assert.ok(setting, 'an app setting is still written');
  assert.strictEqual(setting.body.value, '1', "OFF is '1' — and it must differ from the ON value");
});
