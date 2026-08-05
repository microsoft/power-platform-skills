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
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE_ID = '22222222-2222-2222-2222-222222222222';
const SITEMAP_ID = '33333333-3333-3333-3333-333333333333';
const APP_UNIQUE = 'co_supportdesk';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * A real SDK over a fake Dataverse that models the two-row app. `opts`:
 *   appReadStatus  - HTTP status for GET /appmodules(<id>)  (models a transient read failure)
 *   sitemapLookupStatus - HTTP status for the /sitemaps?$filter=sitemapnameunique lookup
 *   noSitemap      - the app owns no sitemap row
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
      // By-id app retrieve — the source of the `uniquename` the sitemap is linked by.
      if (/\/appmodules\([^)]+\)/.test(url)) {
        const status = opts.appReadStatus || 200;
        return { status, headers: {}, body: status === 200 ? { appmoduleid: APP_ID, appmoduleidunique: APP_UNIQUE_ID, uniquename: APP_UNIQUE, name: 'Support Desk' } : null };
      }
      if (url.includes('/sitemaps')) {
        const status = opts.sitemapLookupStatus || 200;
        return { status, headers: {}, body: status === 200 ? { value: opts.noSitemap ? [] : [{ sitemapid: SITEMAP_ID }] } : null };
      }
      // Cascade component / generative-page lookups: nothing extra to clean up here.
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => { calls.push({ method: 'POST', url, body }); return { status: 204, headers: {}, body: {} }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async (url) => { calls.push({ method: 'DELETE', url }); return { status: 204, headers: {}, body: {} }; },
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, calls };
}
const deletes = (calls) => calls.filter((c) => c.method === 'DELETE').map((c) => c.url);

test('REAL BUNDLE: deleting an app also deletes its sitemap row (the unique name is not burned)', async () => {
  const { sdk, calls } = freshSdk();
  const r = await sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID);
  const urls = deletes(calls);
  assert.ok(urls.some((u) => u.includes(`/appmodules(${APP_ID})`)), `app not deleted: ${JSON.stringify(urls)}`);
  assert.ok(urls.some((u) => u.includes(SITEMAP_ID)), `sitemap not deleted: ${JSON.stringify(urls)}`);
  assert.ok(r.success, `cascade reported failure: ${JSON.stringify(r.failures)}`);
  assert.ok((r.deleted || []).some((d) => d.type === 'sitemap'), 'the sitemap delete must be REPORTED, not silent');
});

test('REAL BUNDLE: the sitemap is resolved BEFORE the app delete, never after', async () => {
  // Afterwards the `uniquename` -> sitemap link is unrecoverable, so ordering is the whole
  // guarantee: read first, then destroy.
  const { sdk, calls } = freshSdk();
  await sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID);
  const sitemapLookup = calls.findIndex((c) => c.method === 'GET' && c.url.includes('sitemapnameunique'));
  const appDelete = calls.findIndex((c) => c.method === 'DELETE' && c.url.includes('/appmodules('));
  assert.ok(sitemapLookup > -1, 'the sitemap must be looked up by unique name');
  assert.ok(appDelete > -1, 'the app must be deleted');
  assert.ok(sitemapLookup < appDelete, 'the sitemap lookup must precede the app delete');
});

test('REAL BUNDLE: an INCONCLUSIVE sitemap lookup refuses to delete the app (fails CLOSED)', async () => {
  // The dangerous case: the lookup fails transiently. Deleting anyway strands the sitemap and burns
  // the name permanently, so the delete must not run on a guess. Teardown surfaces the rejection.
  for (const opts of [{ appReadStatus: 503 }, { sitemapLookupStatus: 503 }]) {
    const { sdk, calls } = freshSdk(opts);
    await assert.rejects(() => sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID), `expected a rejection for ${JSON.stringify(opts)}`);
    assert.ok(!deletes(calls).some((u) => u.includes('/appmodules(')), `the app must NOT be deleted when the sitemap is unresolved: ${JSON.stringify(opts)}`);
  }
});

test('REAL BUNDLE: an app that owns no sitemap still deletes cleanly', async () => {
  const { sdk, calls } = freshSdk({ noSitemap: true });
  const r = await sdk.deleteAppCascade(APP_ID, APP_UNIQUE_ID);
  assert.ok(deletes(calls).some((u) => u.includes(`/appmodules(${APP_ID})`)), 'the app is still deleted');
  assert.ok(r.success, `cascade reported failure: ${JSON.stringify(r.failures)}`);
  assert.ok(!(r.deleted || []).some((d) => d.type === 'sitemap'), 'no phantom sitemap is reported');
});
