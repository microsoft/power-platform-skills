'use strict';
// REAL-BUNDLE contract tests for app deletion (teardown's primary destructive step).
//
// An app is TWO rows: an `appmodule` and a `sitemaps` row, with NO lookup between them and no
// server-side cascade — the only link is `sitemap.sitemapnameunique === appmodule.uniquename`.
// Deleting just the appmodule strands the sitemap forever AND, because `sitemapnameunique` is
// unique-constrained, permanently BURNS that unique name: a later build of an app with the same
// name fails with "The name <x> is already in use by an existing site map", which the user cannot
// act on. `teardown-model-app.js` drives this entirely through the vendored SDK's
// `deleteAppCascade`, and every other teardown test uses a hand-written mock — so a re-vendored
// SDK that regressed this would leave those tests green while teardown silently burned names.
//
// The SDK now deletes both rows in ONE atomic OData `$batch` change set, so it requires an
// `HttpClient.postRaw` and refuses (APP_DELETE_NOT_ATOMIC) without one. It also fails closed on
// every read it cannot trust: the app must carry an ETag (so the DELETE can be conditional on the
// row actually inspected) and the sitemap must still carry the app's `sitemapnameunique` (so a
// row re-pointed between read and delete is not destroyed).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');

const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE_ID = '22222222-2222-2222-2222-222222222222';
const SITEMAP_ID = '33333333-3333-3333-3333-333333333333';
const APP_UNIQUE = 'co_supportdesk';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * Build the multipart/mixed response Dataverse returns for a `$batch` change set.
 *
 * Correlation is by `Content-ID`, which Dataverse echoes; the change-set BOUNDARY is not echoed —
 * the server mints its own and announces it in the nested `Content-Type` header — so this mints a
 * fresh one too rather than reusing the request's. `statusFor` lets a test fail one operation.
 *
 *   --batchresponse_x
 *   Content-Type: multipart/mixed; boundary=changesetresponse_x
 *
 *   --changesetresponse_x
 *   Content-Type: application/http
 *   Content-ID: 1
 *
 *   HTTP/1.1 204 No Content
 *   ...
 *   --changesetresponse_x--
 *   --batchresponse_x--
 */
function batchResponseFor(requestBody, statusFor = () => 204) {
  const ids = [...String(requestBody).matchAll(/^Content-ID:\s*(\S+)/gim)].map((m) => m[1]);
  const lines = ['--batchresponse_x', 'Content-Type: multipart/mixed; boundary=changesetresponse_x', ''];
  for (const id of ids) {
    const status = statusFor(id);
    lines.push(
      '--changesetresponse_x',
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      `Content-ID: ${id}`,
      '',
      `HTTP/1.1 ${status} ${status === 204 ? 'No Content' : 'Error'}`,
      ''
    );
  }
  lines.push('--changesetresponse_x--', '--batchresponse_x--', '');
  return lines.join('\r\n');
}

/** The rows a fake Dataverse hands back, shared by the injected-client and real-transport fakes. */
function appRow(opts = {}) {
  const row = { appmoduleid: APP_ID, appmoduleidunique: APP_UNIQUE_ID, uniquename: APP_UNIQUE, name: 'Support Desk' };
  if (!opts.noAppEtag) row['@odata.etag'] = 'W/"1001"';
  return row;
}
function sitemapRow(opts = {}) {
  return {
    '@odata.etag': 'W/"2002"',
    sitemapid: SITEMAP_ID,
    sitemapnameunique: opts.foreignSitemap ? 'co_someotherapp' : APP_UNIQUE,
    sitemapxml: '<SiteMap></SiteMap>',
  };
}

/**
 * A real SDK over a fake Dataverse that models the two-row app. `opts`:
 *   appReadStatus       - HTTP status for GET /appmodules(<id>)  (models a transient read failure)
 *   sitemapLookupStatus - HTTP status for the sitemaps lookup
 *   noSitemap           - the app owns no sitemap row
 *   noAppEtag           - the app read returns no ETag (delete cannot be made conditional)
 *   foreignSitemap      - the sitemap no longer carries this app's unique name
 *   omitPostRaw         - the injected HttpClient does not support atomic $batch
 *   batchStatusFor      - per-Content-ID status override for the batch response
 *   batchBody           - replace the batch response body entirely (models an unparseable answer)
 */
function freshSdk(opts = {}) {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appdel-'));
  tempDirs.push(dir);
  const calls = [];
  const httpClient = {
    get: async (url) => {
      calls.push({ method: 'GET', url });
      // Entity-set name resolution: `queryRecords` resolves a LOGICAL name to its entity set via
      // metadata before querying, so this must answer or every cascade lookup fails as an invalid
      // argument. e.g. /EntityDefinitions(LogicalName='appmodulecomponent')?$select=EntitySetName
      const meta = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (meta) return { status: 200, headers: {}, body: { LogicalName: meta[1], EntitySetName: `${meta[1]}s` } };
      // By-id app retrieve — the source of the `uniquename` the sitemap is linked by, and of the
      // ETag the conditional delete is issued against.
      if (/\/appmodules\([^)]+\)/.test(url)) {
        const status = opts.appReadStatus || 200;
        if (status !== 200) return { status, headers: {}, body: null };
        return { status, headers: {}, body: appRow(opts) };
      }
      // Sitemaps are read UNPUBLISHED (RetrieveUnpublishedMultiple) so a newly authored sitemap is
      // visible before its app is published.
      if (url.includes('/sitemaps')) {
        const status = opts.sitemapLookupStatus || 200;
        if (status !== 200) return { status, headers: {}, body: null };
        return { status, headers: {}, body: { value: opts.noSitemap ? [] : [sitemapRow(opts)] } };
      }
      // Cascade component / generative-page lookups: nothing extra to clean up here.
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => { calls.push({ method: 'POST', url, body }); return { status: 204, headers: {}, body: {} }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async (url) => { calls.push({ method: 'DELETE', url }); return { status: 204, headers: {}, body: {} }; },
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  if (!opts.omitPostRaw) {
    httpClient.postRaw = async (url, body) => {
      calls.push({ method: 'POST_RAW', url, body });
      const respBody = opts.batchBody !== undefined ? opts.batchBody : batchResponseFor(body, opts.batchStatusFor);
      return { status: 200, headers: {}, body: respBody };
    };
  }
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, calls };
}

const deletes = (calls) => calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
const batches = (calls) => calls.filter((c) => c.method === 'POST_RAW');
/** Every row the delete actually targeted, whether via a $batch change set or a bare DELETE. */
function deletedPaths(calls) {
  const urls = deletes(calls);
  for (const b of batches(calls)) {
    for (const m of String(b.body).matchAll(/^DELETE\s+(\S+)/gim)) urls.push(m[1]);
  }
  return urls;
}

test('REAL BUNDLE: deleting an app also deletes its sitemap row (the unique name is not burned)', async () => {
  const { sdk, calls } = freshSdk();
  const r = await sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID);
  const urls = deletedPaths(calls);
  assert.ok(urls.some((u) => u.includes(`/appmodules(${APP_ID})`)), `app not deleted: ${JSON.stringify(urls)}`);
  assert.ok(urls.some((u) => u.includes(SITEMAP_ID)), `sitemap not deleted: ${JSON.stringify(urls)}`);
  assert.ok(r.success, `cascade reported failure: ${JSON.stringify(r.failures)}`);
});

test('REAL BUNDLE: both rows are deleted in ONE atomic $batch change set, never as two calls', async () => {
  // The whole point of the atomic path: two sequential DELETEs can strand the sitemap if the
  // process dies (or the second call fails) between them, which burns the unique name forever.
  const { sdk, calls } = freshSdk();
  await sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID);
  const b = batches(calls);
  assert.strictEqual(b.length, 1, `expected exactly one $batch, got ${b.length}`);
  assert.match(b[0].url, /\/\$batch$/, 'the atomic write must go to the OData $batch endpoint');
  const targets = [...String(b[0].body).matchAll(/^DELETE\s+(\S+)/gim)].map((m) => m[1]);
  assert.strictEqual(targets.length, 2, `both rows must be in the SAME change set: ${JSON.stringify(targets)}`);
  assert.ok(targets.some((u) => u.includes(`/appmodules(${APP_ID})`)));
  assert.ok(targets.some((u) => u.includes(SITEMAP_ID)));
  assert.ok(
    !deletes(calls).some((u) => u.includes('/appmodules(') || u.includes(SITEMAP_ID)),
    'neither row may ALSO be deleted by a bare, non-atomic DELETE'
  );
});

test('REAL BUNDLE: the sitemap is resolved BEFORE the app delete, never after', async () => {
  // Afterwards the `uniquename` -> sitemap link is unrecoverable, so ordering is the whole
  // guarantee: read first, then destroy.
  const { sdk, calls } = freshSdk();
  await sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID);
  const sitemapLookup = calls.findIndex((c) => c.method === 'GET' && c.url.includes('/sitemaps'));
  const appDelete = calls.findIndex(
    (c) => (c.method === 'POST_RAW' && /\/appmodules\(/.test(String(c.body))) || (c.method === 'DELETE' && c.url.includes('/appmodules('))
  );
  assert.ok(sitemapLookup > -1, 'the sitemap must be looked up');
  assert.ok(appDelete > -1, 'the app must be deleted');
  assert.ok(sitemapLookup < appDelete, 'the sitemap lookup must precede the app delete');
});

test('REAL BUNDLE: an INCONCLUSIVE sitemap lookup refuses to delete the app (fails CLOSED)', async () => {
  // The dangerous case: the lookup fails transiently. Deleting anyway strands the sitemap and burns
  // the name permanently, so the delete must not run on a guess. Teardown surfaces the rejection.
  for (const opts of [{ appReadStatus: 503 }, { sitemapLookupStatus: 503 }]) {
    const { sdk, calls } = freshSdk(opts);
    await assert.rejects(() => sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID), `expected a rejection for ${JSON.stringify(opts)}`);
    assert.ok(
      !deletedPaths(calls).some((u) => u.includes('/appmodules(')),
      `the app must NOT be deleted when the sitemap is unresolved: ${JSON.stringify(opts)}`
    );
  }
});

test("REAL BUNDLE: a sitemap that no longer carries this app's unique name is NOT deleted", async () => {
  // Ownership is name equality only. If the row was re-pointed between the read and the delete it
  // belongs to a different app now, and destroying it would be cross-app data loss.
  const { sdk, calls } = freshSdk({ foreignSitemap: true });
  await assert.rejects(() => sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID), /no longer this app|APP_SITEMAP_UNRESOLVED/);
  assert.strictEqual(deletedPaths(calls).length, 0, 'nothing may be deleted when ownership cannot be proven');
});

test('REAL BUNDLE: an app read with no ETag refuses to delete (the DELETE cannot be made conditional)', async () => {
  // Without an If-Match the delete is unconditional, so a row renamed or re-pointed between the
  // read and the delete would be destroyed anyway. Refuse instead.
  const { sdk, calls } = freshSdk({ noAppEtag: true, noSitemap: true });
  await assert.rejects(() => sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID), /ETag|APP_SITEMAP_UNRESOLVED/);
  assert.strictEqual(deletedPaths(calls).length, 0, 'nothing may be deleted without a concurrency token');
});

test('REAL BUNDLE: an HttpClient without postRaw REFUSES the delete rather than doing it non-atomically', async () => {
  // This is why lib/sdk-http-client.js must implement postRaw: the SDK does NOT silently degrade
  // to two sequential deletes. A plugin transport missing postRaw breaks teardown outright.
  const { sdk, calls } = freshSdk({ omitPostRaw: true });
  await assert.rejects(() => sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID), /APP_DELETE_NOT_ATOMIC|atomic/);
  assert.strictEqual(deletedPaths(calls).length, 0, 'a non-atomic fallback delete must never happen');
});

test('REAL BUNDLE: a failed operation INSIDE the change set is not reported as a successful delete', async () => {
  // The batch envelope can return 200 while an embedded operation failed; reading only the outer
  // status would report a delete that never happened.
  const { sdk } = freshSdk({ batchStatusFor: (id) => (id === '2' ? 400 : 204) });
  await assert.rejects(() => sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID));
});

test('REAL BUNDLE: an unparseable batch response is treated as UNKNOWN, not as success', async () => {
  // A 200 with a body that is not a multipart envelope proves nothing about what the server did.
  const { sdk } = freshSdk({ batchBody: 'OK' });
  await assert.rejects(() => sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID));
});

test('REAL BUNDLE: an app that owns no sitemap still deletes cleanly', async () => {
  const { sdk, calls } = freshSdk({ noSitemap: true });
  const r = await sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID);
  assert.ok(deletedPaths(calls).some((u) => u.includes(`/appmodules(${APP_ID})`)), 'the app is still deleted');
  assert.ok(r.success, `cascade reported failure: ${JSON.stringify(r.failures)}`);
  assert.ok(!(r.deleted || []).some((d) => d.type === 'sitemap'), 'no phantom sitemap is reported');
});

// --- the PLUGIN's own transport, end to end -------------------------------------------------
// The tests above inject a hand-written postRaw. This one drives the REAL createAzHttpClient the
// plugin ships, so a transport bug (re-serializing the payload, JSON-parsing the response, or
// dropping the boundary Content-Type) fails HERE instead of live during a teardown.
test('REAL BUNDLE + REAL TRANSPORT: the plugin HttpClient satisfies the SDK atomic-delete contract', async () => {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appdel-'));
  tempDirs.push(dir);
  const wire = [];
  // Speaks HTTP at the wire level: the SDK's URLs in, raw response strings out.
  const request = async ({ url, method, body, headers }) => {
    wire.push({ url, method, body, headers });
    const meta = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
    if (meta) return { statusCode: 200, headers: {}, body: JSON.stringify({ LogicalName: meta[1], EntitySetName: `${meta[1]}s` }) };
    if (/\/\$batch$/.test(url)) return { statusCode: 200, headers: {}, body: batchResponseFor(body) };
    if (/\/appmodules\([^)]+\)/.test(url)) return { statusCode: 200, headers: {}, body: JSON.stringify(appRow()) };
    if (url.includes('/sitemaps')) return { statusCode: 200, headers: {}, body: JSON.stringify({ value: [sitemapRow()] }) };
    return { statusCode: 200, headers: {}, body: JSON.stringify({ value: [] }) };
  };
  const httpClient = createAzHttpClient('https://example.crm.dynamics.com', { getToken: () => 'TOK', request });
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();

  const r = await sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID);
  assert.ok(r.success, `cascade reported failure: ${JSON.stringify(r.failures)}`);
  const batch = wire.find((w) => /\/\$batch$/.test(w.url));
  assert.ok(batch, 'the atomic delete must reach the $batch endpoint through the real transport');
  assert.match(batch.headers['Content-Type'], /^multipart\/mixed;\s*boundary=/, 'the boundary Content-Type must survive the transport');
  assert.ok(batch.body.startsWith('--batch_'), 'the multipart payload must be sent verbatim, not JSON-serialized');
  assert.strictEqual([...String(batch.body).matchAll(/^DELETE\s+/gim)].length, 2, 'both rows travel in one change set');
});
