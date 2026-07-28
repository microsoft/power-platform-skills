'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sitemapGenPages, sitemapGenPageIds, fetchSitemap, fetchAppsForPages } = require('../lib/sitemap-pages.js');

const GP_OVERVIEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_DETAIL   = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const APP_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SITEMAP_ID  = '5111e0f2-0000-4000-8000-0000000000aa';

// A realistic sitemap: two GenPage subareas (one Title carries an XML entity), an entity subarea, a Url decoy GUID.
const XML = [
  '<SiteMap>',
  '  <Area Id="Sales" Title="Sales">',
  '    <Group Id="Work" Title="Work">',
  `      <SubArea Id="s1" GenPageId="${GP_OVERVIEW}" Title="Orders &amp; Overview" />`,
  '      <SubArea Id="s2" Entity="new_liveorder" Title="Orders" />',
  `      <SubArea Id="s3" GenPageId="${GP_DETAIL.toUpperCase()}" Title="Order Detail" />`,
  '      <SubArea Id="s4" Url="https://x/00000000-0000-0000-0000-000000000000" Title="Decoy" />',
  '    </Group>',
  '  </Area>',
  '</SiteMap>',
].join('\n');

test('sitemapGenPages: one entry per GenPage subarea, XML-entity-decoded title, decoys ignored', () => {
  const rows = sitemapGenPages(XML);
  assert.strictEqual(rows.length, 2, 'only the two GenPageId subareas count');
  const byId = new Map(rows.map((r) => [r.pageId.toLowerCase(), r.title]));
  assert.strictEqual(byId.get(GP_OVERVIEW), 'Orders & Overview', 'title entity-decoded (&amp; → &)');
  assert.strictEqual(byId.get(GP_DETAIL), 'Order Detail');
});

test('sitemapGenPageIds: sorted-unique lower-cased ids; a page attached twice is deduped', () => {
  const twice = XML.replace('</Group>', `      <SubArea Id="s5" GenPageId="${GP_OVERVIEW.toUpperCase()}" Title="dup" />\n    </Group>`);
  assert.deepStrictEqual(sitemapGenPageIds(twice), [GP_OVERVIEW, GP_DETAIL].sort());
});

test('empty / malformed / no-genpage sitemap → []', () => {
  assert.deepStrictEqual(sitemapGenPages(''), []);
  assert.deepStrictEqual(sitemapGenPageIds('<SiteMap><Area><Group><SubArea Entity="x"/></Group></Area></SiteMap>'), []);
  assert.deepStrictEqual(sitemapGenPageIds(null), []);
});

// fetchSitemap mocks the THREE queryRecords calls it actually makes, not a fake fetchArtifact().siteMap.
function sdkWith({ apps, comps, sms } = {}) {
  return {
    queryRecords: async (entity) => {
      if (entity === 'appmodule')         return apps;
      if (entity === 'appmodulecomponent') return comps;
      if (entity === 'sitemap')           return sms;
      return [];
    },
  };
}

test('fetchSitemap: a valid sitemap with genpages → { ok:true, ids }', async () => {
  const sdk = sdkWith({
    apps:  [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }],
    comps: [{ objectid: SITEMAP_ID, componenttype: 62 }],
    sms:   [{ sitemapxml: XML }],
  });
  const r = await fetchSitemap(sdk, 'contoso_app');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, [GP_OVERVIEW, GP_DETAIL].sort());
});

test('fetchSitemap: a VALID sitemap with ZERO genpages → { ok:true, ids:[] } (distinct from a read failure)', async () => {
  const noGenXml = '<SiteMap><Area><Group><SubArea Entity="x"/></Group></Area></SiteMap>';
  const sdk = sdkWith({
    apps:  [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }],
    comps: [{ objectid: SITEMAP_ID }],
    sms:   [{ sitemapxml: noGenXml }],
  });
  const r = await fetchSitemap(sdk, 'contoso_app');
  assert.deepStrictEqual(r, { ok: true, xml: noGenXml, ids: [] });
});

test('fetchSitemap is FAIL-CLOSED & DISCRIMINATED: missing app / component / xml each yield a distinct reason (never [])', async () => {
  assert.deepStrictEqual(
    await fetchSitemap(sdkWith({ apps: [] }), 'x'),
    { ok: false, reason: 'app-not-found' });
  assert.deepStrictEqual(
    await fetchSitemap(sdkWith({ apps: [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }], comps: [] }), 'x'),
    { ok: false, reason: 'sitemap-component-not-found' });
  assert.deepStrictEqual(
    await fetchSitemap(sdkWith({ apps: [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }], comps: [{ objectid: SITEMAP_ID }], sms: [{ sitemapxml: '' }] }), 'x'),
    { ok: false, reason: 'sitemap-xml-unreadable' });
});

// C4 (addenda): MALFORMED detection — a truncated or structurally invalid XML that is PRESENT must NOT be
// treated as { ok:true, ids:[] }. Truncation is the most common form: the string ends mid-attribute.
test('fetchSitemap: truncated / malformed XML → { ok:false, reason:"malformed" } (C4 addenda)', async () => {
  // Truncated in the middle of the Title attribute — no closing > on the SubArea
  const truncated = `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}" Title="Ove`;
  const sdk = sdkWith({
    apps:  [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }],
    comps: [{ objectid: SITEMAP_ID }],
    sms:   [{ sitemapxml: truncated }],
  });
  const r = await fetchSitemap(sdk, 'contoso_app');
  assert.deepStrictEqual(r, { ok: false, reason: 'malformed' });
});

test('fetchSitemap: XML with no <SiteMap or <Area root marker → { ok:false, reason:"malformed" }', async () => {
  // Garbage or wrong-entity XML (no structural root)
  const garbage = '{"error":"not xml"}';
  const sdk = sdkWith({
    apps:  [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }],
    comps: [{ objectid: SITEMAP_ID }],
    sms:   [{ sitemapxml: garbage }],
  });
  const r = await fetchSitemap(sdk, 'contoso_app');
  assert.deepStrictEqual(r, { ok: false, reason: 'malformed' });
});

test('fetchSitemap: XML with a GenPageId whose value is not a valid 36-char GUID → { ok:false, reason:"malformed" }', async () => {
  const badGuid = '<SiteMap><Area><Group><SubArea GenPageId="not-a-guid" Title="Bad"/></Group></Area></SiteMap>';
  const sdk = sdkWith({
    apps:  [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }],
    comps: [{ objectid: SITEMAP_ID }],
    sms:   [{ sitemapxml: badGuid }],
  });
  const r = await fetchSitemap(sdk, 'contoso_app');
  assert.deepStrictEqual(r, { ok: false, reason: 'malformed' });
});

test('fetchAppsForPages: an id in TWO apps sitemaps is reported under both (Imp5 shared detection)', async () => {
  // app-a (unique 'app-a') → sitemap SITEMAP_ID = XML (has GP_OVERVIEW); app-b (unique 'app-b') → sitemap 'sm-2'
  // (also has GP_OVERVIEW). Both apps appear in the unfiltered appmodule list.
  const smXmlById = {
    [SITEMAP_ID]: XML,
    'sm-2': `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}" Title="Reused"/></Group></Area></SiteMap>`,
  };
  const smIdByAppUnique = { ua: SITEMAP_ID, ub: 'sm-2' };
  const sdk = {
    queryRecords: async (entity, o) => {
      const filter = (o && o.filter) || '';
      if (entity === 'appmodule') {
        const all = [
          { appmoduleid: 'a', uniquename: 'app-a', appmoduleidunique: 'ua' },
          { appmoduleid: 'b', uniquename: 'app-b', appmoduleidunique: 'ub' },
        ];
        const m = filter.match(/uniquename eq '([^']+)'/);
        return m ? all.filter((a) => a.uniquename === m[1]) : all;
      }
      if (entity === 'appmodulecomponent') {
        const u = filter.match(/_appmoduleidunique_value eq (\S+)/)[1];
        return [{ objectid: smIdByAppUnique[u], componenttype: 62 }];
      }
      if (entity === 'sitemap') {
        const smId = filter.match(/sitemapid eq (\S+)/)[1];
        return [{ sitemapxml: smXmlById[smId] }];
      }
      return [];
    },
  };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual((r.byId.get(GP_OVERVIEW) || []).sort(), ['app-a', 'app-b']);
  assert.deepStrictEqual(r.unreadable, [], 'both sitemaps readable → no partial coverage');
  // excludeAppUnique skips self so a build doesn't count its own app (single-app env reads 0 sitemaps).
  const excl = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.deepStrictEqual((excl.byId.get(GP_OVERVIEW) || []), ['app-b'], 'self (app-a) excluded');
});

test('fetchAppsForPages is FAIL-CLOSED when the appmodule enumeration fails (cannot verify → ok:false)', async () => {
  const sdk = { queryRecords: async (e) => { if (e === 'appmodule') throw new Error('429 throttled'); return []; } };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /throttled/);
});

test('fetchAppsForPages enumerates with paginate:true and NO top — the complete app list, no single-page cap', async () => {
  // The vendored queryRecords now follows @odata.nextLink to completion when paginate:true, so the
  // membership scan verifies EVERY app in the env (no fail-closed-at-5000-cap). It must pass paginate
  // and must NOT pass a `top` (Dataverse honors $top as a hard cap and omits @odata.nextLink, which
  // would silently return one page — the SDK rejects paginate+top for that reason).
  let appOpts;
  const sdk = {
    queryRecords: async (entity, o) => {
      if (entity === 'appmodule') {
        const all = [
          { appmoduleid: 'a', uniquename: 'app-a', appmoduleidunique: 'ua' },
          { appmoduleid: 'b', uniquename: 'app-b', appmoduleidunique: 'ub' },
        ];
        // The top-level enumeration passes NO filter; per-app fetchSitemap passes a uniquename filter.
        // Capture only the enumeration's options (the one under test) and answer the per-app lookup exactly.
        if (!o.filter) { appOpts = o; return all; }
        const m = (o.filter || '').match(/uniquename eq '([^']+)'/);
        return m ? all.filter((a) => a.uniquename === m[1]) : all;
      }
      // Both apps' sitemaps reference the page so the scan resolves them (proves the full list is walked).
      if (entity === 'appmodulecomponent') return [{ objectid: 'sm', componenttype: 62 }];
      if (entity === 'sitemap') return [{ sitemapxml: `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}"/></Group></Area></SiteMap>` }];
      return [];
    },
  };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, true, 'a large/complete list no longer halts — pagination covers it');
  assert.strictEqual(appOpts.paginate, true, 'appmodule enumeration must request pagination');
  assert.strictEqual(appOpts.top, undefined, 'must NOT combine paginate with top (would cap at one page)');
  assert.deepStrictEqual((r.byId.get(GP_OVERVIEW) || []).sort(), ['app-a', 'app-b'], 'every app in the full list is scanned');
});

test('fetchAppsForPages FAILS CLOSED when pagination aborts (SDK repeated-nextLink guard) — cannot verify → ok:false', async () => {
  // paginate:true makes the SDK follow @odata.nextLink; if the server cycles it throws to avoid an
  // infinite loop. That fault must fail CLOSED (ok:false), never scan a partial list and fail open.
  const sdk = { queryRecords: async (e) => { if (e === 'appmodule') throw new Error('aborting pagination — the server returned a repeated @odata.nextLink'); return []; } };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, false, 'a pagination abort must fail closed');
  assert.match(r.error, /pagination/);
});

test('fetchAppsForPages FAILS CLOSED on an EMPTY enumeration (a malformed 2xx page the SDK treats as empty+complete)', async () => {
  // A live env ALWAYS has ≥1 appmodule (system apps + the app being built, which exists by the time we
  // scan to UPDATE a page). An empty paginated result therefore means the read returned no rows WITHOUT
  // throwing (e.g. a malformed 2xx page). Trusting it would fail OPEN (scan sees zero apps → misses a
  // shared page), so it must fail closed instead.
  const sdk = { queryRecords: async (e) => (e === 'appmodule' ? [] : []) };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, false, 'an empty app enumeration must fail closed');
  assert.strictEqual(r.reason, 'apps-enumeration-empty');
});

test('fetchAppsForPages records (does not fail on) an app whose sitemap is unreadable (best-effort partial)', async () => {
  const sdk = {
    queryRecords: async (entity, o) => {
      const filter = (o && o.filter) || '';
      if (entity === 'appmodule') {
        const all = [{ appmoduleid: 'b', uniquename: 'app-b', appmoduleidunique: 'ub' }];
        const m = filter.match(/uniquename eq '([^']+)'/);
        return m ? all.filter((a) => a.uniquename === m[1]) : all;
      }
      // app-b has no readable sitemap component → fetchSitemap returns ok:false → recorded in unreadable
      if (entity === 'appmodulecomponent') return [];
      return [];
    },
  };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unreadable, ['app-b']);
  assert.strictEqual(r.byId.size, 0);
});
