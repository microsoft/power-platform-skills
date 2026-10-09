'use strict';
// Two layers re-send a request that failed for a reason the platform says is transient: the plugin's HTTP client
// (lib/sdk-http-client.js) and the vendored SDK itself. They sit one above the other, so what a request costs when
// BOTH apply is the product of their attempts — which is why each layer's trigger is pinned here against the real
// bundle, driven through the plugin's real client over a fake transport, with the requests counted.
//
// What the bundle re-sends: a request that lost a SQL deadlock, for reads, an app create,
// PublishXml, a form create and a publisher create; and an app DELETE that raced the platform's search-index
// insert (SQL 547 on the AppModule_DVTableSearch_M365AppModuleId constraint). What the client re-sends: any
// request answered 429/5xx that is neither a record delete nor a $batch, and — for a record delete or a
// conditional-delete $batch only — a deadlock victim or a throttle.
//
//   - A DELETE has two disjoint triggers: the client re-sends 500/1205, the SDK re-sends 400/547. No single
//     answer is both, so they add; they cannot multiply on one condition.
//   - A create POST is re-sent by the client first (it re-sends every 5xx), so the SDK's own deadlock re-send
//     never fires for a deadlock the client clears: one deadlock costs one re-send in all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { KIND_HANDLERS, deleteStep, runTeardown } = require('../lib/sdk-teardown.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ENV = 'https://contoso.crm.dynamics.com';
const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE_ID = '22222222-2222-2222-2222-222222222222';
const SITEMAP_ID = '33333333-3333-3333-3333-333333333333';
const APP_UNIQUE = 'co_supportdesk';
const FORM_ID = '44444444-4444-4444-4444-444444444444';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// The change-set answers the platform gives to the app delete's `$batch` (the SDK sends the appmodule and its
// sitemap as one atomic change set; only a FAILED operation is answered when it rolls back):
//   --batchresponse_x
//   Content-Type: multipart/mixed; boundary=changesetresponse_x
//
//   --changesetresponse_x
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//
//   HTTP/1.1 400 Bad Request
//   Content-Type: application/json; odata.metadata=minimal
//
//   {"error":{"code":"0x80048d21","message":"… REFERENCE constraint \"AppModule_DVTableSearch_M365AppModuleId\" … Sql Number: 547"}}
//   --changesetresponse_x--
//   --batchresponse_x--
const REASONS = { 204: 'No Content', 400: 'Bad Request', 500: 'Internal Server Error' };
function changeSet(parts) {
  const lines = ['--batchresponse_x', 'Content-Type: multipart/mixed; boundary=changesetresponse_x', ''];
  for (const part of parts) {
    lines.push('--changesetresponse_x', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${part.id}`, '', `HTTP/1.1 ${part.status} ${REASONS[part.status]}`);
    if (part.error) lines.push('Content-Type: application/json; odata.metadata=minimal', '', JSON.stringify({ error: part.error }));
    else lines.push('');
  }
  lines.push('--changesetresponse_x--', '--batchresponse_x--', '');
  return lines.join('\r\n');
}
const SEARCH_INDEX_RACE = { code: '0x80048d21', message: 'The DELETE statement conflicted with the REFERENCE constraint "AppModule_DVTableSearch_M365AppModuleId". The conflict occurred in database "org", table "dbo.DVTableSearchBase", column \'M365AppModuleId\'. Sql Number: 547' };
const DEADLOCK = { code: '0x80044150', message: ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205' };
const raced = () => ({ statusCode: 400, headers: {}, body: changeSet([{ id: 1, status: 400, error: SEARCH_INDEX_RACE }]) });
const deadlocked = () => ({ statusCode: 500, headers: {}, body: changeSet([{ id: 1, status: 500, error: DEADLOCK }]) });
const deleted = () => ({ statusCode: 200, headers: {}, body: changeSet([{ id: 1, status: 204 }, { id: 2, status: 204 }]) });

const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// A transport that models the two-row app for deleteAppCascade, and answers each `$batch` from `script` in turn
// (the last entry repeats). `sleeps` records the client's own back-off waits.
function appOrg(script) {
  const requests = [];
  let batches = 0;
  async function request({ url, method }) {
    const u = new URL(url);
    const where = decodeURIComponent(u.pathname + u.search);
    requests.push({ method, path: where });
    if (method === 'POST' && /\/\$batch$/.test(u.pathname)) {
      const answer = script[Math.min(batches, script.length - 1)];
      batches += 1;
      return typeof answer === 'function' ? answer() : answer;
    }
    const meta = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(where);
    if (meta) return json(200, { LogicalName: meta[1], EntitySetName: `${meta[1]}s` });
    if (/\/appmodules\([^)]+\)/.test(where)) return json(200, { appmoduleid: APP_ID, appmoduleidunique: APP_UNIQUE_ID, uniquename: APP_UNIQUE, name: 'Support Desk', '@odata.etag': 'W/"1001"' }, { etag: 'W/"1001"' });
    if (/\/sitemaps\([^)]+\)/.test(where)) return json(200, { '@odata.etag': 'W/"2002"', sitemapid: SITEMAP_ID }, { etag: 'W/"2002"' });
    if (where.includes('/sitemaps')) return json(200, { value: [{ '@odata.etag': 'W/"2003"', sitemapid: SITEMAP_ID, sitemapnameunique: APP_UNIQUE, sitemapxml: '<SiteMap></SiteMap>' }] });
    return json(200, { value: [] });
  }
  return { request, requests, batchPosts: () => requests.filter((r) => r.method === 'POST' && /\$batch/.test(r.path)).length };
}

async function sdkOver(request, sleeps = []) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resend-'));
  tempDirs.push(dir);
  const client = createAzHttpClient(ENV, { getToken: () => 'token', request, sleep: async (ms) => { sleeps.push(ms); } });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ENV, httpClient: client });
  await sdk.initWorkspace();
  return sdk;
}

// The bundle waits between its own re-sends with setTimeout (1 s, 2 s, 4 s). Mocked, so a persistent failure
// costs the test no real seconds; the plugin's client waits through the `sleep` it was handed. The loop is bounded
// by wall time, not by turns of the event loop: the local file writes that follow a request take real time, and a
// fixed number of `setImmediate` turns can pass before they finish.
async function settle(t, promise) {
  let state = 'pending';
  let value;
  let error;
  promise.then((v) => { state = 'resolved'; value = v; }, (e) => { state = 'rejected'; error = e; });
  const deadline = Date.now() + 20000;
  while (state === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10000);
  }
  if (state === 'pending') throw new Error('the call never settled');
  if (state === 'rejected') throw error;
  return value;
}

// --- an app delete -----------------------------------------------------------------------------------

test('an app delete that races the search-index insert is re-sent by the SDK once, and the client adds nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sleeps = [];
  const org = appOrg([raced, deleted]);
  const sdk = await sdkOver(org.request, sleeps);
  const result = await settle(t, sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID));
  assert.ok(result.success, JSON.stringify(result.failures));
  assert.strictEqual(org.batchPosts(), 2, 'the refused change set and its one re-send');
  assert.deepStrictEqual(sleeps, [], 'the client re-sends neither the race (a 400) nor anything else here');
});

test('a persistent search-index race costs four change sets in all — the SDK\u2019s three re-sends, never four times four', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sleeps = [];
  const org = appOrg([raced]);
  const sdk = await sdkOver(org.request, sleeps);
  await assert.rejects(settle(t, sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID)));
  assert.strictEqual(org.batchPosts(), 4);
  assert.deepStrictEqual(sleeps, []);
});

test('a deadlock on the same change set is the client\u2019s to re-send: the SDK never sees it, and it is re-sent once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sleeps = [];
  const org = appOrg([deadlocked, deleted]);
  const sdk = await sdkOver(org.request, sleeps);
  const result = await settle(t, sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID));
  assert.ok(result.success);
  assert.strictEqual(org.batchPosts(), 2);
  assert.deepStrictEqual(sleeps, [1000], 'the client\u2019s own first back-off, and no SDK wait on top of it');
});

test('a persistent deadlock costs four change sets: the client\u2019s three re-sends, and the SDK adds none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sleeps = [];
  const org = appOrg([deadlocked]);
  const sdk = await sdkOver(org.request, sleeps);
  await assert.rejects(settle(t, sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID)));
  assert.strictEqual(org.batchPosts(), 4);
  assert.deepStrictEqual(sleeps, [1000, 2000, 4000]);
});

test('the two triggers add: a race, then a deadlock, then success is three change sets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const org = appOrg([raced, deadlocked, deleted]);
  const sdk = await sdkOver(org.request);
  const result = await settle(t, sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID));
  assert.ok(result.success);
  assert.strictEqual(org.batchPosts(), 3);
});

// --- a create ----------------------------------------------------------------------------------------

// A form create is POSTed to /systemforms. The client re-sends any 5xx on it, so a deadlock the client clears
// never reaches the SDK's own re-send.
function formOrg(answers) {
  const requests = [];
  let posts = 0;
  async function request({ url, method, body }) {
    const u = new URL(url);
    requests.push({ method, path: u.pathname });
    if (method === 'POST' && /\/systemforms$/.test(u.pathname)) {
      const answer = answers[Math.min(posts, answers.length - 1)];
      posts += 1;
      if (answer === 'deadlock') return json(500, { error: DEADLOCK });
      return { statusCode: 204, headers: { 'odata-entityid': `${ENV}/api/data/v9.0/systemforms(${JSON.parse(body).formid})` }, body: '' };
    }
    return json(200, { value: [] });
  }
  return { request, posts: () => requests.filter((r) => r.method === 'POST').length };
}

const mainForm = { name: 'Account form', entityLogicalName: 'account', formType: 'Main', status: 'Active' };

test('one deadlock on a form create costs one re-send in all: the client\u2019s, not the SDK\u2019s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sleeps = [];
  const org = formOrg(['deadlock', 'ok']);
  const sdk = await sdkOver(org.request, sleeps);
  const art = await sdk.createArtifact('form', mainForm);
  const pushed = await settle(t, sdk.pushArtifact('form', art.id));
  assert.strictEqual(pushed.saved, true);
  assert.strictEqual(org.posts(), 2);
  assert.strictEqual(sleeps.length, 1, 'one client back-off; the SDK\u2019s 1 s wait never happened');
});

test('a form create that deadlocks every time stays bounded: the client\u2019s attempts times the SDK\u2019s, and no more', async (t) => {
  // The layers do stack here — the client re-sends every 5xx, and the SDK re-sends a deadlock on this POST — so a
  // deadlock that never clears is attempted up to (client attempts 6) x (SDK attempts 4). It is a ceiling on a
  // pathological case, not what a deadlock costs: one that clears is the previous test.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const org = formOrg(['deadlock']);
  const sdk = await sdkOver(org.request);
  const art = await sdk.createArtifact('form', mainForm);
  await settle(t, sdk.pushArtifact('form', art.id)).catch(() => undefined);
  assert.ok(org.posts() <= 6 * 4, `${org.posts()} attempts`);
  assert.ok(org.posts() > 6, 'and the SDK\u2019s re-send is what takes it past the client\u2019s own six');
});

// --- the SDK's kind check on a form or dashboard delete ----------------------------------------------

// `deleteRemoteArtifact('form' | 'dashboard')` reads the row's type before it deletes, and refuses another kind:
//   GET /systemforms(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=type
function typeOrg(type) {
  const requests = [];
  async function request({ url, method }) {
    const u = new URL(url);
    const where = decodeURIComponent(u.pathname + u.search);
    requests.push({ method, path: where });
    if (method === 'GET' && /\/systemforms\([^)]+\)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublished\(\)/.test(where)) return json(200, { formid: FORM_ID, type });
    if (method === 'DELETE') return { statusCode: 204, headers: {}, body: '' };
    return json(200, { value: [] });
  }
  return { request, requests, deletes: () => requests.filter((r) => r.method === 'DELETE') };
}

test('a form delete reads the row\u2019s kind first — one extra GET — and then deletes it', async () => {
  const org = typeOrg(2);
  const sdk = await sdkOver(org.request);
  await sdk.deleteRemoteArtifact('form', FORM_ID);
  assert.deepStrictEqual(org.requests.map((r) => r.method), ['GET', 'DELETE']);
  assert.match(org.requests[0].path, /RetrieveUnpublished\(\)\?\$select=type/);
});

test('teardown reports a refused kind as a failed step with the SDK\u2019s own words, and deletes nothing', async () => {
  // The plugin resolves a form by (table, name, TYPE) and a pinned dashboard by type, so a wrong kind should
  // not reach the SDK; this is the second line, for an id that changed kind or was pinned wrongly. The step
  // must fail loudly (not skip, not read as already gone) so the operator sees which id to correct.
  const org = typeOrg(5);
  const sdk = await sdkOver(org.request);
  const hybrid = {
    resolveArtifact: async () => [],
    queryRecords: async (set) => (set === 'systemform' ? [{ formid: FORM_ID }] : []),
    deleteRemoteArtifact: (type, id) => sdk.deleteRemoteArtifact(type, id),
    deleteSolution: async () => {},
  };
  const spec = {
    solution: { uniqueName: 'Contoso', publisherPrefix: 'co' },
    app: { name: 'Support Desk' },
    entities: [{ schemaName: 'account', primaryAttribute: { schemaName: 'name' }, columns: [], existing: true }],
    forms: [{ entity: 'account', name: 'Mobile', formType: 'Main' }],
  };
  const events = [];
  const result = await runTeardown(spec, { apply: true }, { sdk: hybrid, emit: (e) => events.push(e) });

  assert.strictEqual(result.ok, false);
  const failure = result.errors.find((e) => /^form /.test(e.step));
  assert.ok(failure, JSON.stringify(result.errors));
  assert.match(failure.message, /Refusing to delete systemform '4{8}-4{4}-4{4}-4{4}-4{12}' as a form: it is a mobile express form \(type 5\)\. Nothing was changed\. Check the id\./);
  assert.ok(events.some((e) => e.status === 'error' && /^form /.test(e.label) && /Refusing to delete systemform/.test(e.detail)), 'the step prints it, where the operator reads the run');
  assert.deepStrictEqual(org.deletes(), [], 'no DELETE was sent for the row');
  assert.ok(!(result.deleted.form || []).length);
});

test('a refused kind is a failure for dashboards too, and is never read as "already gone"', async () => {
  const org = typeOrg(2); // a Main form's id, pinned as a dashboard
  const sdk = await sdkOver(org.request);
  await assert.rejects(
    () => deleteStep(sdk, KIND_HANDLERS.dashboard, [{ id: FORM_ID, name: 'Operations' }]),
    (err) => {
      assert.strictEqual(err.code, 'SYSTEMFORM_KIND_MISMATCH');
      assert.match(err.message, /as a dashboard: it is a Main form \(type 2\)/);
      return true;
    }
  );
  assert.deepStrictEqual(org.deletes(), []);
});
