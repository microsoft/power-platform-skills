'use strict';
// A Main form whose create COMMITTED but whose answer was lost converges instead of halting the build.
//
// How the situation arises in this plugin: the HTTP client (lib/sdk-http-client.js) re-sends a POST that got no
// answer — a dropped connection, or the 5-minute write timeout — and the SDK mints a form's id itself, so the
// re-send meets the row the first attempt already created and Dataverse answers 412 ("a record with matching
// key values already exists"). Without `createRecovery` the SDK reports that as ARTIFACT_ALREADY_EXISTS, and
// the build halts asking for a manual workspace reset. With `createRecovery: 'adoptExact'` the SDK reads the
// row and, only when it is exactly what the retry sent, adopts it locally and writes nothing.
//
// These tests drive the REAL bundle through the plugin's REAL HTTP client over a fake Dataverse that models
// the lost answer at the transport. The SDK is built from the options the build's own `makeSdk` passes (captured
// below), so a build that stops asking for the recovery fails here, rather than a test constructing its own SDK
// and proving only the bundle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { pushFailed, requireSuccessfulPush, reportPartialPush } = require('../lib/entity-provision.js');

const scriptsDir = path.join(__dirname, '..');
const BUNDLE = path.join(scriptsDir, 'vendor', 'cds-maker-sdk.cjs');
const ENV = 'https://contoso.crm.dynamics.com';
const SENTINEL = new Error('stop after construction');

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// The two option bags build-model-app.js's makeSdk hands `createMakerSdk` — [header-carrying `sdk`, `provisionSdk`] —
// captured by running its main() against a bundle that records them and then stops.
async function buildOptions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-app-'));
  tempDirs.push(dir);
  fs.copyFileSync(path.join(scriptsDir, '..', 'samples', 'app-spec.support-desk.json'), path.join(dir, 'app-spec.json'));
  const authCli = loadCli(path.join(scriptsDir, 'lib', 'dataverse-auth.js'));
  const captured = [];
  const cli = loadCli(path.join(scriptsDir, 'build-model-app.js'), {
    argv: ['--env', ENV, '--spec', `@${path.join(dir, 'app-spec.json')}`, '--no-live-plan'],
    requires: {
      './lib/dataverse-auth.js': authCli.exports,
      './lib/sdk-http-client.js': { createAzHttpClient: () => ({}), SQL_DEADLOCK_VICTIM: /Sql Number: 1205/ },
      './vendor/cds-maker-sdk.cjs': {
        createNodeWorkspaceStorage: (d) => ({ dir: d }),
        createMakerSdk: (options) => { captured.push(options); return { initWorkspace: async () => { throw SENTINEL; } }; },
      },
    },
  });
  await assert.rejects(cli.main(), (err) => err === SENTINEL);
  assert.strictEqual(captured.length, 2, 'the build constructs the header-carrying SDK and the workspace-owning one');
  return { sdk: captured[0], provision: captured[1] };
}

// A Dataverse that holds `systemforms` rows and loses the answer to the first create it receives. `answerForDuplicate`
// is what it says when a create names an id that exists: 412 0x80040237 (measured on production builds) or 404
// 0x80040217 (measured on a test build, where the SDK never adopts).
function fakeOrg({ loseFirstAnswer = true, answerForDuplicate = 412, editAfterCommit } = {}) {
  const rows = new Map();
  const requests = [];
  let lost = false;
  const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  async function request({ url, method, body }) {
    const u = new URL(url);
    requests.push({ method, path: decodeURIComponent(u.pathname + u.search) });
    if (method === 'POST' && /\/systemforms$/.test(u.pathname)) {
      const sent = JSON.parse(body);
      if (rows.has(sent.formid)) {
        return answerForDuplicate === 404
          ? json(404, { error: { code: '0x80040217', message: `Entity 'systemform' With Id = ${sent.formid} Does Not Exist` } })
          : json(412, { error: { code: '0x80040237', message: 'A record with matching key values already exists.' } });
      }
      const row = { formid: sent.formid, name: sent.name, objecttypecode: sent.objecttypecode, type: sent.type, formxml: sent.formxml, formpresentation: 0, formactivationstate: 1 };
      rows.set(sent.formid, row);
      if (editAfterCommit) editAfterCommit(row);
      if (loseFirstAnswer && !lost) {
        lost = true;
        // No status line ever arrives: the transport reports the request failed (makeRequest's `{ error }`).
        return { error: 'socket hang up' };
      }
      return { statusCode: 204, headers: { 'odata-entityid': `${ENV}/api/data/v9.0/systemforms(${sent.formid})` }, body: '' };
    }
    const read = /systemforms\(([0-9a-f-]+)\)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublished/i.exec(u.pathname + u.search);
    if (method === 'GET' && read && rows.has(read[1])) {
      return json(200, { ...rows.get(read[1]), '@odata.etag': 'W/"1001"' }, { etag: 'W/"1001"' });
    }
    return json(200, { value: [] });
  }
  return { request, requests, rows, writes: () => requests.filter((r) => r.method !== 'GET') };
}

// A real SDK with the build's own options, over the plugin's own HTTP client talking to `org`.
async function buildSdk(options, org, { withRecovery = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-ws-'));
  tempDirs.push(dir);
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const client = createAzHttpClient(ENV, { getToken: () => 'token', request: org.request, sleep: async () => {} });
  const { createRecovery, ...rest } = options;
  const sdk = createMakerSdk({ ...rest, ...(withRecovery && createRecovery ? { createRecovery } : {}), workspaceStorage: createNodeWorkspaceStorage(dir), httpClient: client });
  await sdk.initWorkspace();
  return sdk;
}

const mainForm = { name: 'Account form', entityLogicalName: 'account', formType: 'Main', status: 'Active' };

// --- the option, as the build passes it ---------------------------------------------------------------

test('the build asks for the recovery on the SDK that creates forms, and on no other', async () => {
  const { sdk, provision } = await buildOptions();
  assert.strictEqual(provision.createRecovery, 'adoptExact', 'the workspace-owning SDK pushes every form');
  assert.strictEqual(sdk.createRecovery, undefined, 'the header-carrying SDK creates no artifact');
  // With a solution configured the SDK would also have to PROVE membership before adopting, and the plugin adds
  // a form to its solution after the push — a create lost without the header is never a member (the SDK measured
  // this). This SDK is header-less on purpose, so the recovery is judged on the row alone.
  assert.strictEqual(provision.solutionUniqueName, undefined);
});

// --- the convergence ----------------------------------------------------------------------------------

test('a lost-answer create is adopted: the retry\u2019s 412 is read, judged exact, and nothing is written again', async () => {
  const { provision } = await buildOptions();
  const org = fakeOrg();
  const sdk = await buildSdk(provision, org);
  const art = await sdk.createArtifact('form', mainForm);

  const result = await sdk.pushArtifact('form', art.id);

  assert.strictEqual(result.adoptedExisting, true);
  assert.strictEqual(result.saved, false, 'nothing was written by this attempt — the SDK says so with saved:false');
  assert.strictEqual(pushFailed(result), false, 'an adoption is not a failure, whatever its saved flag says');
  const warnings = [];
  assert.strictEqual(requireSuccessfulPush(result, 'form Account form', (m) => warnings.push(m)), result, 'the build goes on');
  assert.strictEqual(warnings.length, 1, 'and says what happened');
  assert.match(warnings[0], /form Account form/);
  assert.match(warnings[0], /already created.*adopted|adopted.*already created/i);

  const creates = org.requests.filter((r) => r.method === 'POST');
  assert.strictEqual(creates.length, 2, 'the lost create and the client\u2019s one re-send — no third write from the recovery');
  assert.deepStrictEqual(org.writes().map((r) => r.method), ['POST', 'POST'], 'the recovery issues no PATCH, DELETE or publish');
  assert.strictEqual(org.requests.filter((r) => /RetrieveUnpublished/.test(r.path)).length, 1, 'one exact read by id decided it');
  assert.strictEqual(org.rows.size, 1, 'and no duplicate form exists');
});

test('without the recovery the same lost answer halts the build, as it did before', async () => {
  // The control: it is the option that makes the difference, not the fake.
  const { provision } = await buildOptions();
  const org = fakeOrg();
  const sdk = await buildSdk(provision, org, { withRecovery: false });
  const art = await sdk.createArtifact('form', mainForm);
  const result = await sdk.pushArtifact('form', art.id);
  assert.strictEqual(result.error && result.error.code, 'ARTIFACT_ALREADY_EXISTS');
  assert.strictEqual(pushFailed(result), true);
  assert.throws(() => requireSuccessfulPush(result, 'form Account form'), (err) => err.code === 'already-exists');
});

// --- the refusals, exactly as before -----------------------------------------------------------------

test('a row that is not what was sent is refused: the build still halts, and says why it was not adopted', async () => {
  const { provision } = await buildOptions();
  // Someone edited the form between the commit and the retry.
  const org = fakeOrg({ editAfterCommit: (row) => { row.formxml += '<!-- edited elsewhere -->'; } });
  const sdk = await buildSdk(provision, org);
  const art = await sdk.createArtifact('form', mainForm);
  const result = await sdk.pushArtifact('form', art.id);

  assert.strictEqual(result.adoptedExisting, undefined);
  assert.strictEqual(pushFailed(result), true);
  assert.throws(() => requireSuccessfulPush(result, 'form Account form'), (err) => {
    assert.strictEqual(err.code, 'already-exists');
    assert.match(err.message, /did not adopt it: the existing row is not what this create wrote \(it differs in formxml\)/);
    assert.match(err.message, /delete everything in it except last-applied\.json/, 'the plugin\u2019s own workspace-reset advice is unchanged');
    return true;
  });
  assert.deepStrictEqual(org.writes().map((r) => r.method), ['POST', 'POST']);
});

test('the build that answers a replayed create with 404 never adopts — the halt is the same', async () => {
  const { provision } = await buildOptions();
  const org = fakeOrg({ answerForDuplicate: 404 });
  const sdk = await buildSdk(provision, org);
  const art = await sdk.createArtifact('form', mainForm);
  const result = await sdk.pushArtifact('form', art.id);
  assert.strictEqual(result.error && result.error.code, 'ARTIFACT_ALREADY_EXISTS');
  assert.throws(() => requireSuccessfulPush(result, 'form Account form'), (err) => err.code === 'already-exists');
});

test('only a Main form is adopted: a Quick Create form that lost its answer halts as before', async () => {
  const { provision } = await buildOptions();
  const org = fakeOrg();
  const sdk = await buildSdk(provision, org);
  const art = await sdk.createArtifact('form', { ...mainForm, name: 'Account quick create', formType: 'QuickCreate' });
  const result = await sdk.pushArtifact('form', art.id);
  assert.strictEqual(result.adoptedExisting, undefined);
  assert.throws(() => requireSuccessfulPush(result, 'form Account quick create'), (err) => err.code === 'already-exists' && /only a Main form is adopted/.test(err.message));
});

// --- the plugin's reading of a push result ------------------------------------------------------------

test('pushFailed: an adoption is the one saved:false that is not a failure', () => {
  assert.strictEqual(pushFailed({ saved: false, adoptedExisting: true }), false);
  // Everything that WAS a failure still is — including a result that claims adoption but carries an error.
  assert.strictEqual(pushFailed({ saved: false, error: { code: 'VERSION_CONFLICT' } }), true);
  assert.strictEqual(pushFailed({ saved: false }), true);
  assert.strictEqual(pushFailed({ success: false }), true);
  assert.strictEqual(pushFailed({ saved: false, adoptedExisting: true, error: new Error('x') }), true);
  assert.strictEqual(pushFailed({ saved: false, adoptedExisting: 'true' }), true, 'only the boolean the SDK sets counts');
  assert.strictEqual(pushFailed({ saved: true }), false);
  assert.strictEqual(pushFailed(undefined), false);
});

test('reportPartialPush tells the operator an adoption happened, and stays silent for an ordinary push', () => {
  const said = [];
  reportPartialPush({ saved: false, adoptedExisting: true }, 'form Contact', (m) => said.push(m));
  assert.strictEqual(said.length, 1);
  assert.match(said[0], /form Contact/);
  reportPartialPush({ saved: true, publish: { kind: 'notRequested' } }, 'form Contact', (m) => said.push(m));
  assert.strictEqual(said.length, 1);
});
