'use strict';
// lib/sitemap-pages.js reports a read that failed BY VALUE ({ ok: false, reason, detail } and { ok: false, error }), as a check that decides whether the build may go on has to be able to tell "the app is not
// there" from "the service did not answer". The words of such a result are the error's message, which opens with the url the SDK asked — where what the maker named can be — so a caller that has to decide
// whether to run the build again must not read them. The error itself rides along as `cause`, not enumerable: the result prints and compares as it always did, and the halt raised around it decides from the
// error's structure (lib/retry-policy.js: its HTTP status, its type).
const { test } = require('node:test');
const assert = require('node:assert');
const { fetchSitemap, fetchAppsForPages } = require('../lib/sitemap-pages.js');
const { judgeFailure } = require('../lib/retry-policy.js');
const { connectionError } = require('./helpers/fake-genpage-sdk.js');

const LAYER = 'c0ffee00-0000-4000-8000-00000000dddd';
const SITEMAP = '5111e0f2-0000-4000-8000-0000000000aa';
const EMPTY = '<SiteMap><Area><Group></Group></Area></SiteMap>';

// An SDK whose three reads of an app's sitemap answer as a deployed app's do, except `failing`, which throws `failure`.
function sdkFailingAt(failing, failure) {
  const answer = {
    appmodule: [{ appmoduleid: 'a', appmoduleidunique: LAYER }],
    appmodulecomponent: [{ objectid: SITEMAP, componenttype: 62 }],
    sitemap: [{ sitemapxml: EMPTY }],
  };
  return { queryRecords: async (entity) => { if (entity === failing) throw failure; return answer[entity] || []; } };
}

test('fetchSitemap: a read that throws carries the error itself as a `cause` that is not enumerable — at each of its three reads — beside the words in `detail`', async () => {
  for (const [step, reason] of [['appmodule', 'appmodule-query-failed'], ['appmodulecomponent', 'sitemap-component-query-failed'], ['sitemap', 'sitemap-query-failed']]) {
    const failure = connectionError(503, 'The service is unavailable.');
    const result = await fetchSitemap(sdkFailingAt(step, failure), 'contoso_app');
    assert.strictEqual(result.ok, false, step);
    assert.strictEqual(result.reason, reason, step);
    assert.strictEqual(result.detail, failure.message, `${step}: the words, as they were`);
    assert.strictEqual(result.cause, failure, `${step}: the error itself`);
    assert.deepStrictEqual(Object.keys(result), ['ok', 'reason', 'detail'], `${step}: the result keeps its shape — it prints and compares as it always did`);
    assert.strictEqual(judgeFailure(result.cause).transientStatus, true, `${step}: and what it says to a caller is the status the service answered`);
  }
});

test('fetchSitemap: a result that is not the failure of a read — an app that is not there, a sitemap that is malformed, one that was read — carries no cause', async () => {
  const none = await fetchSitemap({ queryRecords: async () => [] }, 'contoso_app');
  assert.deepStrictEqual(none, { ok: false, reason: 'app-not-found' });
  assert.strictEqual(none.cause, undefined);
  const malformed = await fetchSitemap({ queryRecords: async (e) => (e === 'sitemap' ? [{ sitemapxml: '<SiteMap><Area' }] : e === 'appmodule' ? [{ appmoduleid: 'a', appmoduleidunique: LAYER }] : [{ objectid: SITEMAP }]) }, 'contoso_app');
  assert.deepStrictEqual(malformed, { ok: false, reason: 'malformed' });
  const read = await fetchSitemap(sdkFailingAt('nothing'), 'contoso_app');
  assert.strictEqual(read.ok, true);
  assert.strictEqual(read.cause, undefined);
});

test('fetchAppsForPages: a failure of the app list, of the list of never-published apps or of the saved layer carries the error itself as a `cause` — and a scan that stops for another reason carries none', async () => {
  // The list of apps.
  const listing = connectionError(429, 'Too many requests.');
  const first = await fetchAppsForPages({ queryRecords: async (entity) => { if (entity === 'appmodule') throw listing; return []; } }, ['11111111-0000-4000-8000-000000000001']);
  assert.deepStrictEqual([first.ok, first.error], [false, listing.message]);
  assert.strictEqual(first.cause, listing);
  assert.ok(!Object.keys(first).includes('cause'));

  // The list of apps that were never published, and the saved layer: the two reads the scan makes through the client.
  const apps = [{ appmoduleid: 'a', uniquename: 'app-a', appmoduleidunique: 'ua' }, { appmoduleid: 'b', uniquename: 'app-b', appmoduleidunique: 'ub' }];
  const sdkWith = (get) => ({
    queryRecords: async (entity, o) => {
      if (entity === 'appmodule') {
        const m = ((o && o.filter) || '').match(/uniquename eq '([^']+)'/);
        return m ? apps.filter((a) => a.uniquename === m[1]) : apps;
      }
      if (entity === 'appmodulecomponent') return [{ objectid: SITEMAP, componenttype: 62 }];
      if (entity === 'sitemap') return [{ sitemapxml: EMPTY }];
      return [];
    },
    dataverse: { get },
  });
  const drafts = connectionError(503, 'The service is unavailable.');
  const second = await fetchAppsForPages(sdkWith(async () => { throw drafts; }), ['11111111-0000-4000-8000-000000000001'], { excludeAppUnique: 'app-a' });
  assert.strictEqual(second.ok, false);
  assert.match(second.error, /^could not list the apps that have never been published: /);
  assert.strictEqual(second.cause, drafts);

  const saved = connectionError(503, 'The service is unavailable.');
  const third = await fetchAppsForPages(sdkWith(async (url) => { if (url.startsWith('/appmodules/')) return { status: 200, body: { value: [] } }; throw saved; }), ['11111111-0000-4000-8000-000000000001'], { excludeAppUnique: 'app-a' });
  assert.strictEqual(third.ok, false);
  assert.match(third.error, /^could not read the other apps' saved \(unpublished\) navigation: /);
  assert.strictEqual(third.cause, saved);

  // A scan that stops because the answer was empty has no error to carry.
  const empty = await fetchAppsForPages({ queryRecords: async () => [] }, ['11111111-0000-4000-8000-000000000001']);
  assert.strictEqual(empty.reason, 'apps-enumeration-empty');
  assert.strictEqual(empty.cause, undefined);
});
