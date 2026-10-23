'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sitemapGenPages, sitemapGenPageIds, navigationGenPageIds, liveNavEntries, fetchSitemap, fetchAppsForPages, decodeXmlEntities, appNavigationMatchesSitemap, navigationProof } = require('../lib/sitemap-pages.js');

const GP_OVERVIEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_DETAIL   = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const APP_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SITEMAP_ID  = '5111e0f2-0000-4000-8000-0000000000aa';
// The answer to the list of apps that were never published when there are none (see the scanEnv section below).
const NO_DRAFT_APPS = { status: 200, body: { value: [] } };

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

test('decodeXmlEntities: predefined entities and numeric references, in one pass', () => {
  assert.strictEqual(decodeXmlEntities('Orders &amp; Overview &lt;b&gt; &quot;q&quot; &apos;a&apos;'), 'Orders & Overview <b> "q" \'a\'');
  // A serializer may spell any character as a numeric reference, decimal or hex.
  assert.strictEqual(decodeXmlEntities('?a=1&#38;b=2&#x26;c=3&#39;'), "?a=1&b=2&c=3'");
  assert.strictEqual(decodeXmlEntities('&#x1F600;'), '\u{1F600}');
  // One pass: a double-encoded sequence decodes once, never twice.
  assert.strictEqual(decodeXmlEntities('a &amp;lt; b &amp;#38; c'), 'a &lt; b &#38; c');
  // A reference to no character, or not a reference at all, is left as written.
  assert.strictEqual(decodeXmlEntities('&#xD800; &#1114112; &nbsp; & alone'), '&#xD800; &#1114112; &nbsp; & alone');
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

const navigationCases = [
  { kind: 'entity', sub: { type: 'Entity', entity: 'ACCOUNT' }, xml: '<SubArea Entity="account"/>' },
  { kind: 'generative page', sub: { type: 'GenPage', genPageId: GP_OVERVIEW }, xml: `<SubArea GenPageId="${GP_OVERVIEW}"/>` },
  { kind: 'URL', sub: { type: 'URL', url: 'HTTPS://CONTOSO.EXAMPLE/Help?a=1&b=2' }, xml: '<SubArea Url="https://contoso.example/Help?a=1&amp;b=2"/>' },
  { kind: 'dashboard', sub: { type: 'DashBoard', dashboardId: GP_DETAIL }, xml: `<SubArea DefaultDashboard="{${GP_DETAIL.toUpperCase()}}" Url="/workplace/home_dashboards.aspx"/>` },
  { kind: 'custom page', sub: { type: 'CustomPage', page: 'CONTOSO_DETAILS' }, xml: '<SubArea Page="contoso_details"/>' },
];
const navigationApp = (subAreas) => ({ siteMap: { areas: [{ groups: [{ subAreas }] }] } });
const navigationXml = (entries) => `<SiteMap><Area><Group>${entries}</Group></Area></SiteMap>`;

for (const { kind, sub, xml } of navigationCases) {
  test(`navigation multiset preserves ${kind} occurrence counts in both directions`, () => {
    assert.equal(appNavigationMatchesSitemap(navigationApp([sub]), navigationXml(xml)), true);
    assert.equal(appNavigationMatchesSitemap(navigationApp([sub, sub]), navigationXml(xml + xml)), true);
    assert.equal(appNavigationMatchesSitemap(navigationApp([sub]), navigationXml(xml + xml)), false, 'one SDK entry cannot replace two current entries');
    assert.equal(appNavigationMatchesSitemap(navigationApp([sub, sub]), navigationXml(xml)), false, 'an extra SDK occurrence is a different snapshot');
  });
}

test('navigation comparison includes changed URL, dashboard and custom-page targets', () => {
  for (const [sub, xml] of [
    [{ type: 'URL', url: 'https://contoso.example/OldHelp' }, '<SubArea Url="https://contoso.example/Help"/>' ],
    [{ type: 'DashBoard', dashboardId: GP_OVERVIEW }, `<SubArea DefaultDashboard="${GP_DETAIL}"/>`],
    [{ type: 'CustomPage', page: 'contoso_old' }, '<SubArea Page="contoso_details"/>' ],
  ]) {
    assert.equal(appNavigationMatchesSitemap(navigationApp([sub]), navigationXml(xml)), false);
  }
});

test('consistent mixed, URL-only, dashboard and opaque-container navigation remains accepted', () => {
  const subAreas = navigationCases.map(({ sub }) => sub);
  const entries = navigationCases.map(({ xml }) => xml).reverse().join('');
  assert.equal(appNavigationMatchesSitemap(navigationApp(subAreas), navigationXml(entries)), true, 'order and normalized spellings do not change targets');
  const app = { siteMap: { areas: [{ groups: [] }, { groups: [{ subAreas: [] }, { subAreas }] }] } };
  const xml = `<SiteMap><Area/><Area><Group/><Group>${entries}</Group></Area><Opaque><SubArea Url="https://contoso.example/Decoy"/></Opaque></SiteMap>`;
  assert.equal(appNavigationMatchesSitemap(app, xml), true, 'only real navigation is counted across empty/multiple areas and groups');
  for (const entry of navigationCases.filter(({ kind }) => ['URL', 'dashboard'].includes(kind))) {
    assert.equal(appNavigationMatchesSitemap(navigationApp([entry.sub]), navigationXml(entry.xml)), true);
  }
  assert.equal(appNavigationMatchesSitemap(navigationApp([]), navigationXml('')), true);
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

test('fetchSitemap: a supplied current layer reads unpublished XML without falling back to published navigation', async () => {
  const calls = [];
  const sdk = {
    queryRecords: async (entity, opts) => {
      calls.push({ entity, opts });
      assert.equal(entity, 'appmodulecomponent');
      assert.ok(opts.filter.includes(APP_UNIQUE_VALUE));
      return [{ objectid: SITEMAP_ID, componenttype: 62 }];
    },
    dataverse: { get: async (url) => {
      calls.push({ url });
      assert.ok(url.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'));
      assert.ok(url.includes(`sitemapid eq ${SITEMAP_ID}`));
      return { status: 200, body: { value: [{ sitemapxml: XML, componentstate: 1 }] } };
    } },
  };
  const result = await fetchSitemap(sdk, 'contoso_app', { currentLayer: { ok: true, appModuleIdUnique: APP_UNIQUE_VALUE } });
  assert.deepStrictEqual(result, { ok: true, xml: XML, ids: [GP_OVERVIEW, GP_DETAIL].sort() });
  assert.equal(calls.length, 2);
});

test('fetchSitemap: an unreadable current layer cannot be replaced with a readable published one', async () => {
  const sdk = { queryRecords: async () => assert.fail('no published fallback is allowed') };
  const result = await fetchSitemap(sdk, 'contoso_app', { currentLayer: { ok: false, reason: 'current layer is unreadable' } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /current layer is unreadable/);
});

test('fetchSitemap: current XML reads fail closed on HTTP, malformed or ambiguous responses', async () => {
  for (const [response, reason] of [
    [{ status: 403, body: {} }, 'sitemap-query-failed'],
    [{ status: 200, body: {} }, 'sitemap-query-failed'],
    [{ status: 200, body: { value: [] } }, 'sitemap-xml-unreadable'],
    [{ status: 200, body: { value: [{ sitemapxml: '<SiteMap' }] } }, 'malformed'],
    [{ status: 200, body: { value: [{ componentstate: 0, sitemapxml: XML }, { componentstate: 0, sitemapxml: XML }] } }, 'sitemap-query-failed'],
  ]) {
    const sdk = {
      queryRecords: async (entity) => {
        assert.equal(entity, 'appmodulecomponent', 'a current read must never fall back to published XML');
        return [{ objectid: SITEMAP_ID, componenttype: 62 }];
      },
      dataverse: { get: async () => response },
    };
    const result = await fetchSitemap(sdk, 'contoso_app', { currentLayer: { ok: true, appModuleIdUnique: APP_UNIQUE_VALUE } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  }
});

test('fetchSitemap: multiple sitemap rows select the single unpublished XML, never the old published one', async () => {
  const sdk = {
    queryRecords: async () => [{ objectid: SITEMAP_ID, componenttype: 62 }],
    dataverse: { get: async () => ({ status: 200, body: { value: [
      { componentstate: 0, sitemapxml: '<SiteMap><Area/></SiteMap>' },
      { componentstate: 1, sitemapxml: XML },
    ] } }) },
  };
  const result = await fetchSitemap(sdk, 'contoso_app', { currentLayer: { ok: true, appModuleIdUnique: APP_UNIQUE_VALUE } });
  assert.deepStrictEqual(result.ids, [GP_OVERVIEW, GP_DETAIL].sort());
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

// MALFORMED detection — a truncated or structurally invalid XML that is PRESENT must NOT be
// treated as { ok:true, ids:[] }. Truncation is the most common form: the string ends mid-attribute.
test('fetchSitemap: truncated / malformed XML → { ok:false, reason:"malformed" }', async () => {
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

test('fetchAppsForPages: an id in TWO apps sitemaps is reported under both (shared detection)', async () => {
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
    // The saved layer of every sitemap, in one read: nothing is pending here, so each app's current row is its published one. No app has never been published.
    dataverse: { get: async (url) => (url.startsWith('/appmodules/') ? NO_DRAFT_APPS : { status: 200, body: { value: Object.entries(smXmlById).map(([sitemapid, sitemapxml]) => ({ sitemapid, sitemapxml, componentstate: 0 })) } }) },
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
    dataverse: { get: async (url) => (url.startsWith('/appmodules/') ? NO_DRAFT_APPS : { status: 200, body: { value: [{ sitemapid: 'sm', sitemapxml: `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}"/></Group></Area></SiteMap>`, componentstate: 0 }] } }) },
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
    // The only Dataverse read left is the list of apps that were never published: there are none, and the saved layer has nobody to be joined to.
    dataverse: { get: async (url) => { assert.ok(url.startsWith('/appmodules/'), url); return NO_DRAFT_APPS; } },
  };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unreadable, ['app-b']);
  assert.strictEqual(r.byId.size, 0);
});

// ── The other apps' SAVED (current, unpublished) navigation ───────────────────────────────────────────────────────────────────
// A page another app has saved into its navigation but not published is that app's page as much as one it published: the shared-page
// scan has to see it, or an UPDATE rewrites a page the other app is about to show. The saved layer is read for ALL other apps in ONE
// request — the `sitemap` collection's RetrieveUnpublishedMultiple, https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublishedmultiple —
// and matched to each app by the sitemap id its published read found. Unreadable means unproven: the scan fails closed exactly as the published read does.
const SAVED_URL = '/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid,sitemapxml,componentstate,sitemapnameunique';
// The list of apps that were never published: the `appmodule` collection's RetrieveUnpublishedMultiple, one request. It answers with every app's CURRENT layer — a published app with nothing
// pending has one row (componentstate 0), one with a pending edit has two (the published row, and the draft with a layer key of its own), and an app that was never published has one
// (componentstate 1) — and the published `appmodule` list has no row for that last kind at all.
const APPS_URL = '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,appmoduleidunique,uniquename,componentstate';
const smId = (i) => `5111e0f2-0000-4000-8000-${String(i).padStart(12, '0')}`;
const layerKey = (i) => `c0ffee00-0000-4000-8000-${String(i).padStart(12, '0')}`;
const withPage = (...ids) => `<SiteMap><Area><Group>${ids.map((id, i) => `<SubArea Id="p${i}" GenPageId="${id}" Title="Page ${i}"/>`).join('')}</Group></Area></SiteMap>`;

// An environment of `apps` ([{ name, published, saved }]): `published` is the app's published sitemap XML; `saved` is its saved layer —
// undefined when nothing is pending (the platform answers with the one published row), an XML string for a pending draft (it answers
// with both layers), or `{ rows }` for rows given verbatim. `savedPages(url)` overrides the response to the saved read, whole, and `appList(url)` the one to the
// list of apps that were never published.
// `drafts` ([{ name, saved }]) are apps that were NEVER published: the published list has no row for them, the list of apps has one, their sitemap component hangs off their layer key
// and their saved sitemap is `saved`. A draft may set `rows` (its rows in the list of apps, verbatim), `noSitemapComponent` (its component read finds none), `componentRows` (its component
// rows, verbatim), `savedRows` (its saved rows, verbatim — to leave them out, say) or `sitemapName` (the `sitemapnameunique` of its sitemap, which is its own name unless said: the SDK
// names an app's sitemap after the app, and links the two by that name). Every saved row carries its sitemap's `sitemapnameunique`, as the platform's rows do.
function scanEnv(apps, { drafts = [], savedPages, appList, noDataverse } = {}) {
  const calls = { queries: [], gets: [] };
  const all = apps.map((a, i) => ({ appmoduleid: `app-${i}`, uniquename: a.name, appmoduleidunique: layerKey(i) }));
  const draftAt = (j) => 100 + j; // a draft's index in the sitemap and layer-key numbering, apart from the published apps'
  const sdk = {
    queryRecords: async (entity, o) => {
      calls.queries.push(entity);
      const filter = (o && o.filter) || '';
      if (entity === 'appmodule') {
        const m = filter.match(/uniquename eq '([^']+)'/);
        return m ? all.filter((a) => a.uniquename === m[1]) : all;
      }
      if (entity === 'appmodulecomponent') {
        const i = Number(filter.match(/_appmoduleidunique_value eq \S+?(\d{12})\b/)[1]);
        if (i >= 100 && drafts[i - 100].noSitemapComponent) return [];
        if (i >= 100 && drafts[i - 100].componentRows) return drafts[i - 100].componentRows;
        return [{ objectid: smId(i), componenttype: 62 }];
      }
      if (entity === 'sitemap') {
        const i = Number(filter.match(/sitemapid eq \S+?(\d{12})\b/)[1]);
        return [{ sitemapxml: apps[i].published }];
      }
      return [];
    },
  };
  if (!noDataverse) {
    sdk.dataverse = {
      get: async (url) => {
        calls.gets.push(url);
        if (url.startsWith('/appmodules/')) {
          if (appList) return appList(url);
          const rows = [];
          apps.forEach((a, i) => {
            rows.push({ appmoduleid: `app-${i}`, appmoduleidunique: layerKey(i), uniquename: a.name, componentstate: 0 });
            if (typeof a.saved === 'string') rows.push({ appmoduleid: `app-${i}`, appmoduleidunique: layerKey(1000 + i), uniquename: a.name, componentstate: 1 });
          });
          drafts.forEach((d, j) => (d.rows ? rows.push(...d.rows) : rows.push({ appmoduleid: `draft-${j}`, appmoduleidunique: layerKey(draftAt(j)), uniquename: d.name, componentstate: 1 })));
          return { status: 200, body: { value: rows } };
        }
        if (savedPages) return savedPages(url);
        const rows = [];
        apps.forEach((a, i) => {
          const sitemapnameunique = a.name;
          if (a.saved && a.saved.rows) rows.push(...a.saved.rows.map((r) => ({ sitemapid: smId(i), sitemapnameunique, ...r })));
          else if (typeof a.saved === 'string') rows.push({ sitemapid: smId(i), sitemapnameunique, sitemapxml: a.published, componentstate: 0 }, { sitemapid: smId(i), sitemapnameunique, sitemapxml: a.saved, componentstate: 1 });
          else rows.push({ sitemapid: smId(i), sitemapnameunique, sitemapxml: a.published, componentstate: 0 });
        });
        drafts.forEach((d, j) => {
          const sitemapnameunique = d.sitemapName === undefined ? d.name : d.sitemapName;
          if (d.savedRows) rows.push(...d.savedRows.map((r) => ({ sitemapid: smId(draftAt(j)), sitemapnameunique, ...r })));
          else rows.push({ sitemapid: smId(draftAt(j)), sitemapnameunique, sitemapxml: d.saved, componentstate: 1 });
        });
        return { status: 200, body: { value: rows } };
      },
    };
  }
  return { sdk, calls };
}

test('fetchAppsForPages: a page only in another app\'s SAVED navigation is a shared page, and says it is not published', async () => {
  const { sdk } = scanEnv([
    { name: 'app-a', published: withPage() },
    { name: 'app-b', published: withPage(GP_DETAIL), saved: withPage(GP_DETAIL, GP_OVERVIEW) },
  ]);
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-b'], 'the page another app saved into its navigation is found');
  assert.deepStrictEqual(r.savedOnly.get(GP_OVERVIEW), ['app-b'], 'and reported as saved but not published');
  assert.deepStrictEqual(r.unreadable, []);
  // Control: the same environment with nothing saved is clean, so the finding above is the saved layer's alone.
  const clean = scanEnv([{ name: 'app-a', published: withPage() }, { name: 'app-b', published: withPage(GP_DETAIL) }]);
  const none = await fetchAppsForPages(clean.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.strictEqual(none.byId.size, 0);
  assert.strictEqual(none.savedOnly.size, 0);
});

test('fetchAppsForPages: a page in an app\'s published AND saved navigation is listed once; a draft that drops it does not clear it', async () => {
  const { sdk } = scanEnv([
    { name: 'app-a', published: withPage() },
    { name: 'app-b', published: withPage(GP_OVERVIEW), saved: withPage(GP_OVERVIEW, GP_DETAIL) },
    // app-c's draft REMOVED the page, but its published navigation — what its users see — still has it.
    { name: 'app-c', published: withPage(GP_OVERVIEW), saved: withPage(GP_DETAIL) },
  ]);
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW, GP_DETAIL], { excludeAppUnique: 'app-a' });
  assert.deepStrictEqual((r.byId.get(GP_OVERVIEW) || []).sort(), ['app-b', 'app-c'], 'each app once, whichever layers hold the page');
  assert.deepStrictEqual(r.byId.get(GP_DETAIL).sort(), ['app-b', 'app-c']);
  assert.deepStrictEqual(r.savedOnly.get(GP_OVERVIEW), undefined, 'the published layer holds it, so it is not saved-only');
  assert.deepStrictEqual(r.savedOnly.get(GP_DETAIL).sort(), ['app-b', 'app-c']);
});

test('fetchAppsForPages: the saved layer of every other app is ONE request, however many apps there are', async () => {
  for (const others of [1, 3, 12]) {
    const apps = [{ name: 'app-self', published: withPage() }];
    for (let i = 0; i < others; i += 1) apps.push({ name: `app-${i}`, published: withPage(), saved: i === others - 1 ? withPage(GP_OVERVIEW) : undefined });
    const { sdk, calls } = scanEnv(apps);
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
    assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), [`app-${others - 1}`], `${others} other app(s)`);
    assert.deepStrictEqual(calls.gets, [APPS_URL, SAVED_URL], `${others} other app(s): the list of never-published apps, then exactly one saved-layer read, unfiltered by app`);
    // The published layer is unchanged: one app list, then an app row, its sitemap component and its sitemap per OTHER app.
    assert.strictEqual(calls.queries.length, 1 + 3 * others, `${others} other app(s): the published reads are as they were`);
  }
});

test('fetchAppsForPages: a single-app environment reads no other app\'s navigation: the one list of never-published apps, and no sitemap', async () => {
  const { sdk, calls } = scanEnv([{ name: 'app-self', published: withPage(GP_OVERVIEW) }]);
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.byId.size, 0);
  assert.deepStrictEqual(calls.gets, [APPS_URL], 'one small request — the apps that were never published — and no saved-layer request');
  assert.deepStrictEqual(calls.queries, ['appmodule'], 'only the app list: no component, no sitemap');
  // And with no page to look for there is nothing to read at all.
  const idle = scanEnv([{ name: 'app-self', published: withPage() }, { name: 'app-b', published: withPage() }]);
  await fetchAppsForPages(idle.sdk, [], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual([idle.calls.gets, idle.calls.queries], [[], []]);
});

test('fetchAppsForPages: when the saved layer cannot be read at all, the scan FAILS CLOSED (never "no pages saved")', async () => {
  const apps = [{ name: 'app-a', published: withPage() }, { name: 'app-b', published: withPage() }];
  const failures = {
    'an HTTP error': () => ({ status: 503, body: null }),
    'a body that is no result set': () => ({ status: 200, body: {} }),
    'a thrown transport error': () => { throw new Error('socket hang up'); },
    'a repeated @odata.nextLink': () => ({ status: 200, body: { value: [], '@odata.nextLink': SAVED_URL } }),
    'a malformed @odata.nextLink': () => ({ status: 200, body: { value: [], '@odata.nextLink': 42 } }),
  };
  for (const [what, savedPages] of Object.entries(failures)) {
    const { sdk } = scanEnv(apps, { savedPages });
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
    assert.strictEqual(r.ok, false, what);
    assert.match(r.error, /saved \(unpublished\) navigation/, what);
  }
  const { sdk } = scanEnv(apps, { noDataverse: true });
  const noClient = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.strictEqual(noClient.ok, false, 'no client to read the saved layer with is not an empty saved layer');
  assert.match(noClient.error, /never been published[\s\S]*no Dataverse client/, 'it is the first Dataverse read, and it already needs the client');
});

test('fetchAppsForPages: an app whose saved navigation is missing, ambiguous or malformed is listed unreadable', async () => {
  const published = withPage();
  const cases = {
    'no saved row for its sitemap': { rows: [] },
    'two rows and neither is the saved layer': { rows: [{ sitemapxml: published, componentstate: 0 }, { sitemapxml: published, componentstate: 0 }] },
    'two saved layers': { rows: [{ sitemapxml: published, componentstate: 1 }, { sitemapxml: published, componentstate: 1 }] },
    'empty XML': { rows: [{ sitemapxml: '', componentstate: 1 }] },
    'XML cut short': { rows: [{ sitemapxml: '<SiteMap><Area><Group><SubArea GenPageId="13ecbc57-a3a4-4132-b0a2', componentstate: 1 }] },
    'a page id that is no GUID': { rows: [{ sitemapxml: '<SiteMap><Area><Group><SubArea GenPageId="not-a-guid"/></Group></Area></SiteMap>', componentstate: 1 }] },
  };
  for (const [what, saved] of Object.entries(cases)) {
    const { sdk } = scanEnv([{ name: 'app-a', published }, { name: 'app-b', published, saved }, { name: 'app-c', published, saved: withPage(GP_OVERVIEW) }], {});
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
    assert.strictEqual(r.ok, true, what);
    assert.deepStrictEqual(r.unreadable, ['app-b'], what);
    assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-c'], `${what}: the readable app is still scanned`);
  }
});

test('fetchAppsForPages: the saved read follows @odata.nextLink to completion', async () => {
  const apps = [{ name: 'app-a', published: withPage() }, { name: 'app-b', published: withPage() }, { name: 'app-c', published: withPage() }];
  const second = `${SAVED_URL}&$skiptoken=2`;
  const savedPages = async (url) => (url === SAVED_URL
    ? { status: 200, body: { value: [{ sitemapid: smId(1), sitemapxml: withPage(), componentstate: 0 }], '@odata.nextLink': second } }
    : { status: 200, body: { value: [{ sitemapid: smId(2), sitemapxml: withPage(), componentstate: 0 }, { sitemapid: smId(2), sitemapxml: withPage(GP_OVERVIEW), componentstate: 1 }] } });
  const { sdk, calls } = scanEnv(apps, { savedPages });
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.deepStrictEqual(calls.gets, [APPS_URL, SAVED_URL, second]);
  assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-c'], 'an app on the second page is scanned too');
  assert.deepStrictEqual(r.unreadable, []);
});

// ── Apps that were NEVER published ────────────────────────────────────────────────────────────────────────────────────────────
// An app saved in the maker and never published has no row in the published `appmodule` list, so the scan above — which starts from that list — never read its navigation, and a page
// it holds was updated without a word. Its saved sitemap IS in the saved-layer read; what was missing is the app it belongs to. They are listed by the same collection's
// RetrieveUnpublishedMultiple (one request, whatever the number of apps), and each one's sitemap is found through its layer key's sitemap component and joined from the saved read.
test('fetchAppsForPages: a page only in a NEVER-PUBLISHED app\'s saved navigation is a shared page, reported as saved but not published', async () => {
  const { sdk } = scanEnv([{ name: 'app-a', published: withPage() }, { name: 'app-b', published: withPage(GP_DETAIL) }], {
    drafts: [{ name: 'app-draft', saved: withPage(GP_OVERVIEW) }],
  });
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-draft'], 'the page a draft app holds is found');
  assert.deepStrictEqual(r.savedOnly.get(GP_OVERVIEW), ['app-draft'], 'and it has no published layer, so it is saved only');
  assert.deepStrictEqual(r.unreadable, []);
  // Controls: the same environment without the draft is clean, and a draft that does not hold the page is not a finding.
  const without = scanEnv([{ name: 'app-a', published: withPage() }, { name: 'app-b', published: withPage(GP_DETAIL) }]);
  assert.strictEqual((await fetchAppsForPages(without.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' })).byId.size, 0);
  const elsewhere = scanEnv([{ name: 'app-a', published: withPage() }], { drafts: [{ name: 'app-draft', saved: withPage(GP_DETAIL) }] });
  const other = await fetchAppsForPages(elsewhere.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.strictEqual(other.ok, true);
  assert.strictEqual(other.byId.size, 0);
  assert.deepStrictEqual(other.unreadable, []);
});

test('fetchAppsForPages: the page of a never-published app is found when it is the ONLY other app, beside several published ones, and next to a draft of a published app', async () => {
  // Only other app: a single published app (self) and a draft. The published reads find no other app, and the saved layer is read all the same, for the draft.
  const alone = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [{ name: 'app-draft', saved: withPage(GP_OVERVIEW) }] });
  const r = await fetchAppsForPages(alone.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-draft']);
  assert.deepStrictEqual(alone.calls.gets, [APPS_URL, SAVED_URL]);
  // Several published apps — one with a pending edit of its own — and two drafts: every app holding the page is named once, in either layer.
  const many = scanEnv([
    { name: 'app-self', published: withPage() },
    { name: 'app-pub', published: withPage(GP_OVERVIEW) },
    { name: 'app-pending', published: withPage(), saved: withPage(GP_OVERVIEW) },
  ], { drafts: [{ name: 'app-draft-1', saved: withPage(GP_OVERVIEW, GP_DETAIL) }, { name: 'app-draft-2', saved: withPage(GP_DETAIL) }] });
  const all = await fetchAppsForPages(many.sdk, [GP_OVERVIEW, GP_DETAIL], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual(all.byId.get(GP_OVERVIEW).sort(), ['app-draft-1', 'app-pending', 'app-pub']);
  assert.deepStrictEqual(all.byId.get(GP_DETAIL).sort(), ['app-draft-1', 'app-draft-2']);
  assert.deepStrictEqual(all.savedOnly.get(GP_OVERVIEW).sort(), ['app-draft-1', 'app-pending'], 'saved only: the pending edit of a published app, and the draft; not the published page');
  assert.deepStrictEqual(all.unreadable, []);
  // A published app with a pending edit has two rows in the list of apps and is not a never-published app: no component read is made for its draft layer.
  const layerKeysRead = [];
  const spy = scanEnv([{ name: 'app-self', published: withPage() }, { name: 'app-pending', published: withPage(), saved: withPage(GP_OVERVIEW) }]);
  const queryRecords = spy.sdk.queryRecords;
  spy.sdk.queryRecords = async (entity, o) => { if (entity === 'appmodulecomponent') layerKeysRead.push(o.filter.match(/_appmoduleidunique_value eq (\S+)/)[1]); return queryRecords(entity, o); };
  await fetchAppsForPages(spy.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual(layerKeysRead, [layerKey(1)], 'only the published layer of the published app — the pending layer key is never taken for a never-published app');
});

// The id of an app is what a command that acts on it takes (genpage.js remove-from-app --app-id), and the scan keys its answers by unique name: so the ids the rows it already read carry — the published
// list, and the list of never-published apps — are handed on, by lower-cased unique name, at no request of their own.
test('fetchAppsForPages: the scan carries the id of every app it read, published or never published, by lower-cased unique name — the app being built, which it does not read, is not among them', async () => {
  const { sdk } = scanEnv([
    { name: 'App-Self', published: withPage() },
    { name: 'App-B', published: withPage(GP_OVERVIEW) },
    { name: 'app-c', published: withPage(), saved: withPage(GP_OVERVIEW) },
  ], { drafts: [{ name: 'App-Draft', saved: withPage(GP_OVERVIEW) }] });
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual([...r.appIds].sort(), [['app-b', 'app-1'], ['app-c', 'app-2'], ['app-draft', 'draft-0']]);
  const none = await fetchAppsForPages(sdk, []);
  assert.deepStrictEqual([none.ok, none.appIds.size], [true, 0], 'no page asked for: nothing is read, and no id is known');
});

test('fetchAppsForPages: the list of never-published apps is ONE request however many there are, and each draft costs its sitemap component read and nothing else', async () => {
  for (const drafts of [0, 1, 4]) {
    const list = Array.from({ length: drafts }, (_, j) => ({ name: `app-draft-${j}`, saved: j === drafts - 1 ? withPage(GP_OVERVIEW) : withPage(GP_DETAIL) }));
    const { sdk, calls } = scanEnv([{ name: 'app-self', published: withPage() }, { name: 'app-b', published: withPage() }], { drafts: list });
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
    assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), drafts ? [`app-draft-${drafts - 1}`] : undefined, `${drafts} draft app(s)`);
    assert.deepStrictEqual(calls.gets, [APPS_URL, SAVED_URL], `${drafts} draft app(s): one list of apps and one saved-layer read, shared by the published app and the drafts`);
    // The published app costs its app row, component and sitemap (3); each draft one component read (the app list already has its layer key, the saved read its sitemap).
    assert.strictEqual(calls.queries.length, 1 + 3 + drafts, `${drafts} draft app(s): the published reads are as they were, plus one read per draft`);
    assert.strictEqual(calls.queries.filter((q) => q === 'appmodulecomponent').length, 1 + drafts);
  }
  // Without any other published app the saved layer is still read — once — because of the draft.
  const only = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [{ name: 'app-draft', saved: withPage() }, { name: 'app-draft-2', saved: withPage() }] });
  await fetchAppsForPages(only.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual(only.calls.gets, [APPS_URL, SAVED_URL]);
  assert.deepStrictEqual(only.calls.queries, ['appmodule', 'appmodulecomponent', 'appmodulecomponent']);
});

test('fetchAppsForPages: the app itself is never scanned as a never-published app, whatever its rows say', async () => {
  // A draft row named like self (matched by name, as published apps are) is skipped: self cannot share a page with itself, and is not unreadable either.
  const { sdk, calls } = scanEnv([{ name: 'app-self', published: withPage() }], {
    drafts: [{ name: 'App-Self', saved: withPage(GP_OVERVIEW) }, { name: 'app-other', saved: withPage(GP_DETAIL) }],
  });
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW, GP_DETAIL], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual([...r.byId], [[GP_DETAIL, ['app-other']]], 'only the other draft app holds a page');
  assert.deepStrictEqual(r.unreadable, []);
  assert.strictEqual(calls.queries.filter((q) => q === 'appmodulecomponent').length, 1, 'self\'s layer was not read');
});

test('fetchAppsForPages: when the list of never-published apps cannot be read, the scan FAILS CLOSED before reading any sitemap', async () => {
  const apps = [{ name: 'app-self', published: withPage() }, { name: 'app-b', published: withPage() }];
  const failures = {
    'an HTTP error': () => ({ status: 503, body: null }),
    'a forbidden read': () => ({ status: 403, body: { error: { message: 'no privilege' } } }),
    'a body that is no result set': () => ({ status: 200, body: {} }),
    'a thrown transport error': () => { throw new Error('socket hang up'); },
    'a repeated @odata.nextLink': () => ({ status: 200, body: { value: [], '@odata.nextLink': APPS_URL } }),
    'a malformed @odata.nextLink': () => ({ status: 200, body: { value: [], '@odata.nextLink': 42 } }),
    'a row with no appmoduleid': () => ({ status: 200, body: { value: [{ uniquename: 'app-x', componentstate: 1 }] } }),
    'a null row': () => ({ status: 200, body: { value: [null] } }),
  };
  for (const [what, appList] of Object.entries(failures)) {
    const { sdk, calls } = scanEnv(apps, { appList });
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
    assert.strictEqual(r.ok, false, what);
    assert.match(r.error, /could not list the apps that have never been published/, what);
    assert.deepStrictEqual(calls.queries, ['appmodule'], `${what}: nothing else was read — no sitemap, no component`);
  }
  // Also with a single app, where it is the only read there is.
  const single = scanEnv([{ name: 'app-self', published: withPage() }], { appList: () => ({ status: 503, body: null }) });
  assert.strictEqual((await fetchAppsForPages(single.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' })).ok, false, 'a single-app environment is not exempt: it cannot be told that no draft app exists');
});

test('fetchAppsForPages: the list of never-published apps follows @odata.nextLink to completion', async () => {
  const second = `${APPS_URL}&$skiptoken=2`;
  const appList = (url) => (url === APPS_URL
    ? { status: 200, body: { value: [{ appmoduleid: 'app-0', appmoduleidunique: layerKey(0), uniquename: 'app-self', componentstate: 0 }], '@odata.nextLink': second } }
    : { status: 200, body: { value: [{ appmoduleid: 'draft-0', appmoduleidunique: layerKey(100), uniquename: 'app-draft', componentstate: 1 }] } });
  const { sdk, calls } = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [{ name: 'app-draft', saved: withPage(GP_OVERVIEW) }], appList });
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual(calls.gets.slice(0, 2), [APPS_URL, second]);
  assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-draft'], 'a draft app on the second page is scanned too');
});

test('fetchAppsForPages: a never-published app whose layer, sitemap component or saved sitemap cannot be read is listed unreadable, and the other apps are still scanned', async () => {
  const draft = (extra) => ({ name: 'app-broken', saved: withPage(), ...extra });
  const row = (over) => ({ appmoduleid: 'draft-0', appmoduleidunique: layerKey(100), uniquename: 'app-broken', componentstate: 1, ...over });
  const cases = {
    'no saved row for its sitemap': draft({ savedRows: [] }),
    'two saved layers': draft({ savedRows: [{ sitemapxml: withPage(), componentstate: 1 }, { sitemapxml: withPage(), componentstate: 1 }] }),
    'empty XML': draft({ savedRows: [{ sitemapxml: '', componentstate: 1 }] }),
    'XML cut short': draft({ savedRows: [{ sitemapxml: '<SiteMap><Area><Group><SubArea GenPageId="13ecbc57-a3a4-4132-b0a2', componentstate: 1 }] }),
    'a page id that is no GUID': draft({ savedRows: [{ sitemapxml: '<SiteMap><Area><Group><SubArea GenPageId="not-a-guid"/></Group></Area></SiteMap>', componentstate: 1 }] }),
    // A sitemap component that is there but names no sitemap is an answer that cannot be read — unlike no component at all (the next test).
    'a sitemap component that names no sitemap': draft({ componentRows: [{ componenttype: 62 }] }),
    'a sitemap component with an empty id': draft({ componentRows: [{ objectid: '', componenttype: 62 }] }),
    'two current layers': draft({ rows: [row({}), row({ appmoduleidunique: layerKey(101) })] }),
    'no authored layer among several': draft({ rows: [row({ componentstate: 0 }), row({ appmoduleidunique: layerKey(101), componentstate: 0 })] }),
    'a layer key that is no GUID': draft({ rows: [row({ appmoduleidunique: 'not-a-guid' })] }),
    'no layer key': draft({ rows: [row({ appmoduleidunique: undefined })] }),
  };
  for (const [what, d] of Object.entries(cases)) {
    const { sdk } = scanEnv([{ name: 'app-self', published: withPage() }, { name: 'app-pub', published: withPage(GP_OVERVIEW) }], { drafts: [d] });
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
    assert.strictEqual(r.ok, true, what);
    assert.deepStrictEqual(r.unreadable, ['app-broken'], what);
    assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-pub'], `${what}: the readable app is still scanned`);
  }
  // A failed component read is unreadable too, not a thrown error and not "no sitemap, no page".
  const { sdk } = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [draft({})] });
  const queryRecords = sdk.queryRecords;
  sdk.queryRecords = async (entity, o) => { if (entity === 'appmodulecomponent') throw new Error('socket hang up'); return queryRecords(entity, o); };
  const failed = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.strictEqual(failed.ok, true);
  assert.deepStrictEqual(failed.unreadable, ['app-broken']);
  // A draft row that names no app is listed by its id, so the halt can still say which one.
  const nameless = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [draft({ rows: [row({ uniquename: undefined, appmoduleidunique: undefined })] })] });
  assert.deepStrictEqual((await fetchAppsForPages(nameless.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' })).unreadable, ['draft-0']);
});

// A never-published app saved in the maker with nothing but a name has no sitemap component in its layer, and no sitemap of its name: it has no navigation, so it holds no page. A read that
// SUCCEEDS and finds no component, with no sitemap of the app's name to be found in the saved layer, shows that — it is not "unreadable", and one such app must not stop every page update in
// the environment. Only a read that FAILS, or a component that names no sitemap, proves nothing (the test above). The saved-layer read is what rules a sitemap linked by name out, so it is made.
test('fetchAppsForPages: a never-published app with no sitemap component and no sitemap of its name holds no page — it is skipped, not listed unreadable', async () => {
  // No sitemap row carries its name; another app's sitemap, which does name the page, is nothing to do with it.
  const bare = { name: 'app-bare', saved: withPage(), savedRows: [], noSitemapComponent: true };
  // Beside a published app that holds the page: the page is found there, and nothing is unreadable.
  const beside = scanEnv([{ name: 'app-self', published: withPage() }, { name: 'app-pub', published: withPage(GP_OVERVIEW) }], { drafts: [bare] });
  const r = await fetchAppsForPages(beside.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unreadable, []);
  assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-pub']);
  // The only other app: its component read, and the one saved-layer read that shows no sitemap carries its name.
  const alone = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [bare] });
  const only = await fetchAppsForPages(alone.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.strictEqual(only.ok, true);
  assert.deepStrictEqual(only.unreadable, []);
  assert.strictEqual(only.byId.size, 0);
  assert.deepStrictEqual(alone.calls.gets, [APPS_URL, SAVED_URL], 'the list of apps and the one saved-layer read, which is how the app is shown to have no sitemap');
  assert.deepStrictEqual(alone.calls.queries, ['appmodule', 'appmodulecomponent']);
  // Beside a draft app that does hold the page, the bare one changes nothing: the other is still found, and only it is named.
  const mixed = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [bare, { name: 'app-draft', saved: withPage(GP_OVERVIEW) }] });
  const both = await fetchAppsForPages(mixed.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual(both.byId.get(GP_OVERVIEW), ['app-draft']);
  assert.deepStrictEqual(both.savedOnly.get(GP_OVERVIEW), ['app-draft']);
  assert.deepStrictEqual(both.unreadable, []);
  assert.deepStrictEqual(mixed.calls.gets, [APPS_URL, SAVED_URL], 'the one saved-layer read serves both');
});

// The vendored SDK ties an app to its sitemap BY NAME: it looks the sitemap up by `sitemapnameunique` equal to the app's unique name and takes a sitemap for the app only while that column holds the
// name (so does this plugin's own ensureSitemapInSolution). An app whose layer has no sitemap component — a half-made or broken one — can therefore still hold a sitemap, and pages in it,
// that only its name links to it; skipping it would let the update through.
test('fetchAppsForPages: a never-published app with no sitemap component whose sitemap is linked to it by NAME holds that sitemap\'s pages', async () => {
  const linked = { name: 'app-linked', saved: withPage(GP_OVERVIEW), noSitemapComponent: true };
  // The app's name and the sitemap's are compared in lower case: a maker-made unique name usually has capitals (`contoso_SalesHub`), and the sitemap row may carry it in any case.
  const cases = [
    ['the same case', 'app-linked', 'app-linked'],
    ['another case — Dataverse compares names without regard to case', 'app-linked', 'APP-Linked'],
    ['an app name with capitals, against a sitemap of the same name in lower case', 'App-Linked', 'app-linked'],
  ];
  for (const [what, appName, sitemapName] of cases) {
    const { sdk, calls } = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [{ ...linked, name: appName, sitemapName }] });
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
    assert.strictEqual(r.ok, true, what);
    assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), [appName], `${what}: the page its sitemap holds is found`);
    assert.deepStrictEqual(r.savedOnly.get(GP_OVERVIEW), [appName], `${what}: and it has no published layer, so it is saved only`);
    assert.deepStrictEqual(r.unreadable, [], what);
    // No request beyond the ones a draft app costs anyway: the list of apps, its component read, and the one saved-layer read, which carries the name.
    assert.deepStrictEqual(calls.gets, [APPS_URL, SAVED_URL], what);
    assert.deepStrictEqual(calls.queries, ['appmodule', 'appmodulecomponent'], what);
  }
  // A sitemap that holds some other page is not a finding, and a sitemap of ANOTHER name is not this app's whatever it holds.
  const other = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [{ ...linked, saved: withPage(GP_DETAIL) }] });
  const elsewhere = await fetchAppsForPages(other.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.strictEqual(elsewhere.byId.size, 0);
  assert.deepStrictEqual(elsewhere.unreadable, []);
  const named = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [{ ...linked, sitemapName: 'app-someone-else' }] });
  const unrelated = await fetchAppsForPages(named.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.strictEqual(unrelated.byId.size, 0, 'a sitemap that carries another app\'s name is that app\'s');
  assert.deepStrictEqual(unrelated.unreadable, []);
  // Beside a published app and a draft app whose component names its sitemap, the same single saved-layer read serves all of them.
  const together = scanEnv([{ name: 'app-self', published: withPage() }, { name: 'app-pub', published: withPage(GP_DETAIL) }], { drafts: [linked, { name: 'app-draft', saved: withPage(GP_DETAIL) }] });
  const all = await fetchAppsForPages(together.sdk, [GP_OVERVIEW, GP_DETAIL], { excludeAppUnique: 'app-self' });
  assert.deepStrictEqual(all.byId.get(GP_OVERVIEW), ['app-linked']);
  assert.deepStrictEqual(all.byId.get(GP_DETAIL).sort(), ['app-draft', 'app-pub']);
  assert.deepStrictEqual(together.calls.gets, [APPS_URL, SAVED_URL]);
});

test('fetchAppsForPages: a name-linked sitemap that cannot be read — two sitemaps of the name, ambiguous or malformed rows — lists the app unreadable', async () => {
  const linked = { name: 'app-linked', saved: withPage(), noSitemapComponent: true };
  const cases = {
    'two saved layers': { ...linked, savedRows: [{ sitemapxml: withPage(), componentstate: 1 }, { sitemapxml: withPage(), componentstate: 1 }] },
    'empty XML': { ...linked, savedRows: [{ sitemapxml: '', componentstate: 1 }] },
    'XML cut short': { ...linked, savedRows: [{ sitemapxml: '<SiteMap><Area><Group><SubArea GenPageId="13ecbc57-a3a4-4132-b0a2', componentstate: 1 }] },
  };
  for (const [what, draft] of Object.entries(cases)) {
    const { sdk } = scanEnv([{ name: 'app-self', published: withPage() }, { name: 'app-pub', published: withPage(GP_OVERVIEW) }], { drafts: [draft] });
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
    assert.strictEqual(r.ok, true, what);
    assert.deepStrictEqual(r.unreadable, ['app-linked'], what);
    assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-pub'], `${what}: the readable app is still scanned`);
  }
  // Two different sitemaps with the app's name: which one is the app's cannot be told, and either may hold the page.
  const twice = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [linked] });
  const get = twice.sdk.dataverse.get;
  twice.sdk.dataverse.get = async (url) => {
    const res = await get(url);
    if (url.startsWith('/sitemaps/')) res.body.value.push({ sitemapid: smId(900), sitemapnameunique: 'app-linked', sitemapxml: withPage(GP_OVERVIEW), componentstate: 1 });
    return res;
  };
  const r = await fetchAppsForPages(twice.sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unreadable, ['app-linked']);
  assert.strictEqual(r.byId.size, 0);
});

test('fetchAppsForPages: when the saved layer cannot be read at all, a never-published app does not make the scan pass — whether or not its layer has a sitemap component', async () => {
  for (const noSitemapComponent of [false, true]) {
    const { sdk } = scanEnv([{ name: 'app-self', published: withPage() }], { drafts: [{ name: 'app-draft', saved: withPage(), noSitemapComponent }], savedPages: () => ({ status: 503, body: null }) });
    const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-self' });
    assert.strictEqual(r.ok, false, `noSitemapComponent=${noSitemapComponent}`);
    assert.match(r.error, /saved \(unpublished\) navigation/);
  }
});

test('fetchSitemap: includeSitemapId adds the sitemap id the read resolved, and nothing else changes', async () => {
  const sdk = sdkWith({
    apps:  [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }],
    comps: [{ objectid: `{${SITEMAP_ID.toUpperCase()}}`, componenttype: 62 }],
    sms:   [{ sitemapxml: XML }],
  });
  const plain = await fetchSitemap(sdk, 'contoso_app');
  assert.deepStrictEqual(plain, { ok: true, xml: XML, ids: [GP_OVERVIEW, GP_DETAIL].sort() }, 'the default result has no sitemapId');
  const withId = await fetchSitemap(sdk, 'contoso_app', { includeSitemapId: true });
  assert.deepStrictEqual(withId, { ...plain, sitemapId: SITEMAP_ID }, 'lower-cased, without braces, so it matches a row of the saved read');
});

// ── navigationProof: this app's navigation as ownership proof for page ids ─────────────────────────────────────────────────────
// `published` is the fetchSitemap result for the PUBLISHED app. The saved layer is read when it can prove something the published one did not — a candidate that is not among its ids — and for an app with NO published
// layer at all: `app-not-found` is how a plain read answers for an app that was never published, and for one that is gone. A never-published app's navigation exists only in its saved layer, so the SDK's own lookup of the
// app, which reads that layer, says which of the two it is: an app it does not find is in neither layer, and the published answer stands.
const PROOF_APP = '9d1b0a52-0000-4000-8000-000000000001';
const PROOF_LAYER = '9d1b0a52-0000-4000-8000-000000000002';
const PROOF_SITEMAP = '9d1b0a52-0000-4000-8000-000000000003';
const NOT_PUBLISHED = { ok: false, reason: 'app-not-found' };
const BOTH_PAGES = [GP_OVERVIEW, GP_DETAIL].sort();

// What a teardown hands it: the SDK's app resolver (the SAVED layer), its plain reads (the PUBLISHED layer) and its Dataverse client (RetrieveUnpublishedMultiple). `calls` is every request it made, in order.
//   publishedApps   what the plain read of the app returns (nothing, for an app that was never published)
//   layer, sitemap, saved   the answers of the three RetrieveUnpublishedMultiple reads — the app's layers, a sitemap by id, and every sitemap — each `{ status, body }`
function proofEnv({ apps = [{ id: PROOF_APP, name: 'Contoso App', appModuleIdUnique: PROOF_LAYER }], publishedApps = [], resolveError, components, componentError, layer, sitemap, saved, noDataverse } = {}) {
  const calls = { resolved: [], queries: [], gets: [] };
  const rows = (value) => ({ status: 200, body: { value } });
  const sdk = {
    resolveArtifact: async (kind, identity) => {
      calls.resolved.push(`${kind}:${identity.uniqueName}`);
      if (resolveError) throw new Error(resolveError);
      return apps;
    },
    queryRecords: async (entity, opts) => {
      calls.queries.push({ entity, filter: opts && opts.filter });
      if (entity === 'appmodule') return publishedApps;
      if (entity === 'appmodulecomponent') {
        if (componentError) throw new Error(componentError);
        return components !== undefined ? components : [{ objectid: PROOF_SITEMAP, componenttype: 62 }];
      }
      return [];
    },
  };
  if (!noDataverse) {
    sdk.dataverse = {
      get: async (url) => {
        calls.gets.push(url);
        if (url.startsWith('/appmodules/')) return layer || rows([{ appmoduleid: PROOF_APP, appmoduleidunique: PROOF_LAYER, componentstate: 1 }]);
        if (url.includes('sitemapnameunique')) return saved || rows([{ sitemapid: PROOF_SITEMAP, sitemapnameunique: 'contoso_app', sitemapxml: XML, componentstate: 1 }]);
        if (url.startsWith('/sitemaps/')) return sitemap || rows([{ sitemapxml: XML, componentstate: 1 }]);
        throw new Error(`unexpected read ${url}`);
      },
    };
  }
  return { sdk, calls };
}

test('navigationProof: a published app whose navigation names every candidate is answered as it is, with no read at all', async () => {
  const published = { ok: true, xml: XML, ids: BOTH_PAGES };
  const { sdk, calls } = proofEnv();
  assert.strictEqual(await navigationProof(sdk, 'contoso_app', published, [GP_OVERVIEW.toUpperCase()]), published);
  assert.strictEqual(await navigationProof(sdk, 'contoso_app', published, []), published);
  assert.deepStrictEqual(calls, { resolved: [], queries: [], gets: [] });
});

test('navigationProof: a published app is read in its saved layer, through its own id, for the candidates the published navigation does not name — and is never asked whether it was published', async () => {
  const published = { ok: true, xml: withPage(GP_OVERVIEW), ids: [GP_OVERVIEW] };
  const { sdk, calls } = proofEnv({ publishedApps: [{ appmoduleid: PROOF_APP }] });
  const r = await navigationProof(sdk, 'contoso_app', published, [GP_OVERVIEW, GP_DETAIL]);
  assert.deepStrictEqual(r, { ...published, ids: BOTH_PAGES, currentNavigation: { ok: true, ids: BOTH_PAGES } });
  assert.deepStrictEqual(calls.resolved, [], 'the published read found it: nothing asks whether it was ever published');
  assert.deepStrictEqual(calls.queries.map((q) => q.entity), ['appmodule', 'appmodulecomponent']);
  assert.ok(calls.gets[0].includes(`appmoduleid eq ${PROOF_APP}`));
  // A saved layer that cannot be read proves nothing more: the published proof stands, and says why.
  const refused = proofEnv({ publishedApps: [{ appmoduleid: PROOF_APP }], layer: { status: 503, body: null } });
  const unread = await navigationProof(refused.sdk, 'contoso_app', published, [GP_OVERVIEW, GP_DETAIL]);
  assert.deepStrictEqual(unread.ids, [GP_OVERVIEW]);
  assert.strictEqual(unread.ok, true);
  assert.strictEqual(unread.currentNavigation.ok, false);
  assert.match(unread.currentNavigation.reason, /appmodule-query-failed|saved|503/);
});

test('navigationProof: an app with no published layer is proven by its saved navigation — the sitemap its saved layer holds, found through its own id and layer key', async () => {
  const { sdk, calls } = proofEnv();
  const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW.toUpperCase()]);
  assert.deepStrictEqual(r, { ok: true, neverPublished: true, ids: BOTH_PAGES, currentNavigation: { ok: true, ids: BOTH_PAGES } });
  assert.deepStrictEqual(calls.resolved, ['app:contoso_app']);
  assert.deepStrictEqual(calls.queries.map((q) => q.entity), ['appmodulecomponent'], 'never the published app or sitemap, which are not there');
  assert.ok(calls.queries[0].filter.includes(PROOF_LAYER), 'the component hangs off the layer key of the saved layer');
  assert.strictEqual(calls.gets.length, 2);
  assert.ok(calls.gets[0].startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()') && calls.gets[0].includes(`appmoduleid eq ${PROOF_APP}`));
  assert.ok(calls.gets[1].startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()') && calls.gets[1].includes(`sitemapid eq ${PROOF_SITEMAP}`));
});

test('navigationProof: an app that is in neither layer is answered as the published read said — one look for it, and no read of any navigation', async () => {
  const { sdk, calls } = proofEnv({ apps: [] });
  assert.strictEqual(await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]), NOT_PUBLISHED);
  assert.deepStrictEqual(calls, { resolved: ['app:contoso_app'], queries: [], gets: [] });
});

test('navigationProof: every answer that is not "app not found", and a proof with nothing to prove, are returned as they are, with no read', async () => {
  const { sdk, calls } = proofEnv();
  for (const published of [
    { ok: false, reason: 'appmodule-query-failed', detail: 'HTTP 503' },
    { ok: false, reason: 'sitemap-component-not-found' },
    { ok: false, reason: 'sitemap-xml-unreadable' },
    { ok: false, reason: 'malformed' },
    { ok: false, reason: 'app identity unavailable' },
    undefined,
  ]) {
    assert.strictEqual(await navigationProof(sdk, 'contoso_app', published, [GP_OVERVIEW]), published, JSON.stringify(published));
  }
  assert.strictEqual(await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, []), NOT_PUBLISHED, 'no candidate, nothing to prove');
  assert.deepStrictEqual(calls, { resolved: [], queries: [], gets: [] });
});

test('navigationProof: a saved navigation of an app with no published layer that cannot be read is { ok:false, neverPublished:true } with the reason — never "no pages"', async () => {
  const two = [{ appmoduleid: PROOF_APP, appmoduleidunique: PROOF_LAYER, componentstate: 1 }, { appmoduleid: PROOF_APP, appmoduleidunique: '9d1b0a52-0000-4000-8000-000000000004', componentstate: 1 }];
  const cases = [
    ['the layer read is refused', { layer: { status: 503, body: null } }, 'appmodule-query-failed', /HTTP 503/],
    ['the layer is two current rows', { layer: { status: 200, body: { value: two } } }, 'appmodule-query-failed', /no single current layer among 2 app row\(s\)/],
    ['the sitemap component read fails', { componentError: 'socket hang up' }, 'sitemap-component-query-failed', /socket hang up/],
    ['its sitemap component is there and names no sitemap', { components: [{ componenttype: 62 }] }, 'sitemap-component-not-found', /names no sitemap/],
    ['the sitemap read is refused', { sitemap: { status: 403, body: {} } }, 'sitemap-query-failed', /HTTP 403/],
    ['the sitemap has no row', { sitemap: { status: 200, body: { value: [] } } }, 'sitemap-xml-unreadable', undefined],
    ['the sitemap XML is cut short', { sitemap: { status: 200, body: { value: [{ sitemapxml: '<SiteMap', componentstate: 1 }] } } }, 'malformed', undefined],
    ['a page id in it is no GUID', { sitemap: { status: 200, body: { value: [{ sitemapxml: '<SiteMap><Area><Group><SubArea GenPageId="not-a-guid"/></Group></Area></SiteMap>', componentstate: 1 }] } } }, 'malformed', undefined],
  ];
  for (const [what, setup, reason, detail] of cases) {
    const { sdk } = proofEnv(setup);
    const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]);
    assert.strictEqual(r.ok, false, what);
    assert.strictEqual(r.neverPublished, true, `${what}: the app was found in its saved layer, so this is the navigation of an app that was never published`);
    assert.strictEqual(r.reason, reason, what);
    if (detail) assert.match(r.detail, detail, what);
    assert.strictEqual(r.ids, undefined, `${what}: no page is proven by a read that failed`);
  }
});

test('navigationProof: an app that cannot be looked up in its saved layer is an unreadable answer that does not claim it was never published', async () => {
  const noLookup = proofEnv();
  delete noLookup.sdk.resolveArtifact;
  const noClient = proofEnv({ noDataverse: true });
  for (const [what, sdk, reason, detail] of [
    ['the SDK cannot look the app up', proofEnv({ resolveError: 'Contoso app lookup unavailable' }).sdk, 'appmodule-query-failed', /Contoso app lookup unavailable/],
    ['the SDK has no app lookup', noLookup.sdk, 'appmodule-query-failed', /no lookup of an app/],
    ['there is no Dataverse client', noClient.sdk, 'no Dataverse client to read it', undefined],
  ]) {
    const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]);
    assert.strictEqual(r.ok, false, what);
    assert.strictEqual(r.neverPublished, undefined, `${what}: the app was not found there, so nothing says it was never published`);
    assert.strictEqual(r.reason, reason, what);
    if (detail) assert.match(r.detail, detail, what);
    assert.strictEqual(r.ids, undefined, what);
  }
});

test('navigationProof: a sitemap component that is found missing and then cannot be read again is an unreadable navigation — never "no navigation"', async () => {
  const { sdk } = proofEnv({ components: [] });
  const queryRecords = sdk.queryRecords;
  let componentReads = 0;
  sdk.queryRecords = async (entity, opts) => {
    // The first read finds no component (fetchSitemap's); the second is the one that tells "none" from "one that names nothing".
    if (entity === 'appmodulecomponent' && (componentReads += 1) === 2) throw new Error('socket hang up');
    return queryRecords(entity, opts);
  };
  const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]);
  assert.strictEqual(componentReads, 2);
  assert.deepStrictEqual([r.ok, r.neverPublished, r.reason], [false, true, 'sitemap-component-query-failed']);
  assert.match(r.detail, /socket hang up/);
});

test('navigationProof: an app that was never published whose sitemap component is there costs no second read of the components, and one with none costs exactly one more', async () => {
  const linked = proofEnv();
  await navigationProof(linked.sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]);
  assert.strictEqual(linked.calls.queries.filter((q) => q.entity === 'appmodulecomponent').length, 1);
  const bare = proofEnv({ components: [] });
  await navigationProof(bare.sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]);
  assert.strictEqual(bare.calls.queries.filter((q) => q.entity === 'appmodulecomponent').length, 2);
});

// The vendored SDK ties an app to its sitemap by NAME, and an app whose layer has no sitemap component can still hold a sitemap — and pages in it — that only its name links to it. The scan of the OTHER apps follows that link,
// so the teardown of THIS one does too: skipping it would prove none of an app's pages, and the teardown would still delete the app and the sitemap that holds them.
test('navigationProof: an app with no published layer and no sitemap component is read through the sitemap that carries its name, in any case', async () => {
  for (const name of ['contoso_app', 'CONTOSO_App']) {
    const { sdk, calls } = proofEnv({ components: [], saved: { status: 200, body: { value: [
      { sitemapid: '9d1b0a52-0000-4000-8000-0000000000aa', sitemapnameunique: 'contoso_other', sitemapxml: withPage(GP_OVERVIEW), componentstate: 1 },
      { sitemapid: PROOF_SITEMAP, sitemapnameunique: name, sitemapxml: XML, componentstate: 1 },
    ] } } });
    const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]);
    assert.deepStrictEqual(r, { ok: true, neverPublished: true, ids: BOTH_PAGES, currentNavigation: { ok: true, ids: BOTH_PAGES } }, name);
    assert.deepStrictEqual(calls.gets.map((u) => u.split('?')[0]), [
      '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()',
      '/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()',
    ], 'the layer, and the one read of the saved sitemaps — no read of the sitemap by id, which no component names');
  }
});

test('navigationProof: an app with no published layer, no sitemap component and no sitemap of its name has no navigation: a valid proof of no pages, not an error', async () => {
  const { sdk } = proofEnv({ components: [], saved: { status: 200, body: { value: [{ sitemapid: PROOF_SITEMAP, sitemapnameunique: 'contoso_other', sitemapxml: XML, componentstate: 1 }] } } });
  assert.deepStrictEqual(await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]), { ok: true, neverPublished: true, ids: [], currentNavigation: { ok: true, ids: [] } });
});

test('navigationProof: a sitemap linked by name that cannot be told, or read, is an unreadable navigation', async () => {
  const mine = (over) => ({ sitemapid: PROOF_SITEMAP, sitemapnameunique: 'contoso_app', sitemapxml: XML, componentstate: 1, ...over });
  const cases = [
    ['two sitemaps carry the name', { status: 200, body: { value: [mine(), mine({ sitemapid: '9d1b0a52-0000-4000-8000-0000000000bb' })] } }, 'sitemap-query-failed', /more than one sitemap/],
    ['two current rows of the one sitemap', { status: 200, body: { value: [mine(), mine()] } }, 'sitemap-query-failed', undefined],
    ['the sitemap has no XML', { status: 200, body: { value: [mine({ sitemapxml: '' })] } }, 'sitemap-xml-unreadable', undefined],
    ['the XML is cut short', { status: 200, body: { value: [mine({ sitemapxml: '<SiteMap><Area><Group><SubArea GenPageId="13ecbc57' })] } }, 'malformed', undefined],
    ['the read is refused', { status: 503, body: null }, 'sitemap-query-failed', /HTTP 503/],
  ];
  for (const [what, saved, reason, detail] of cases) {
    const { sdk } = proofEnv({ components: [], saved });
    const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]);
    assert.strictEqual(r.ok, false, what);
    assert.strictEqual(r.neverPublished, true, what);
    assert.strictEqual(r.reason, reason, what);
    if (detail) assert.match(r.detail, detail, what);
  }
});

test('navigationProof: the saved sitemap of an app with no published layer, when a pending edit makes the platform answer with both layers, is the authored one', async () => {
  const { sdk } = proofEnv({ sitemap: { status: 200, body: { value: [
    { componentstate: 0, sitemapxml: withPage(GP_OVERVIEW) },
    { componentstate: 1, sitemapxml: withPage(GP_DETAIL) },
  ] } } });
  const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_DETAIL]);
  assert.deepStrictEqual(r.ids, [GP_DETAIL]);
});

// ── navigationGenPageIds: the pages the NAVIGATION of a sitemap holds ───────────────────────────────────────────────────────────
// The teardown deletes a page by what this says, so it reads the navigation ELEMENTS — a SubArea directly under SiteMap/Area/Group, in either quote style — and not the text of the XML. sitemapGenPageIds is that text:
// it sees a `GenPageId="…"` inside a comment, a CDATA section or another attribute's value, and misses a single-quoted one. That is enough to REFUSE (the scan of the other apps says "another app has the page") or to
// REPORT, and not to decide that a page is the app's and delete it.
const navXml = (...entries) => `<SiteMap><Area Id="a"><Group Id="g">${entries.join('')}</Group></Area></SiteMap>`;
const subArea = (attrs) => `<SubArea Id="s" ${attrs}/>`;
const pageAttr = (id, quote = '"') => `GenPageId=${quote}${id}${quote}`;
// What fetchSitemap answers for the XML of a published sitemap: the XML and the ids the TEXT reader finds in it.
const publishedOf = (xml) => ({ ok: true, xml, ids: sitemapGenPageIds(xml) });

test('navigationGenPageIds: the GenPageId of every navigation element, in either quote style — sorted, unique and lower-cased; an entry that names no page adds nothing', () => {
  const xml = navXml(
    subArea(pageAttr(GP_DETAIL.toUpperCase())), subArea(pageAttr(GP_OVERVIEW, "'")), subArea(pageAttr(GP_OVERVIEW.toUpperCase())),
    subArea('Entity="account"'), subArea('GenPageId=""'), subArea('Url="https://contoso.example/"'));
  assert.deepStrictEqual(navigationGenPageIds(xml), { ok: true, ids: [GP_OVERVIEW, GP_DETAIL].sort() });
  assert.deepStrictEqual(navigationGenPageIds(navXml(subArea('Entity="account"'))), { ok: true, ids: [] }, 'a navigation with no page is a readable one');
  assert.deepStrictEqual(navigationGenPageIds(XML), { ok: true, ids: [GP_OVERVIEW, GP_DETAIL].sort() }, 'the realistic sitemap of this file');
});

test('navigationGenPageIds: text is not navigation — a page named in a comment, a CDATA section, a processing instruction or the value of another attribute is not held', () => {
  const hidden = subArea(pageAttr(GP_DETAIL));
  for (const [what, text] of [['a comment', `<!-- ${hidden} -->`], ['a CDATA section', `<![CDATA[${hidden}]]>`], ['a processing instruction', `<?hidden ${hidden}?>`]]) {
    assert.deepStrictEqual(navigationGenPageIds(navXml(subArea(pageAttr(GP_OVERVIEW)), text)), { ok: true, ids: [GP_OVERVIEW] }, what);
  }
  // The decoy comes first, in the value of another attribute of the entry that holds the page — in the other quote style.
  assert.deepStrictEqual(navigationGenPageIds(navXml(`<SubArea Id="s" Title='see GenPageId="${GP_DETAIL}"' ${pageAttr(GP_OVERVIEW)}/>`)), { ok: true, ids: [GP_OVERVIEW] });
  assert.deepStrictEqual(navigationGenPageIds(navXml(`<SubArea Id="s" Title="see GenPageId='${GP_DETAIL}'" ${pageAttr(GP_OVERVIEW, "'")}/>`)), { ok: true, ids: [GP_OVERVIEW] });
  // A comment can hold a '>' and a quote without ending anything.
  assert.deepStrictEqual(navigationGenPageIds(navXml(`<!-- a > b " c ' d ${hidden} -->`, subArea(pageAttr(GP_OVERVIEW)))), { ok: true, ids: [GP_OVERVIEW] });
});

test('navigationGenPageIds: a page id spelled with XML character references is the id it spells', () => {
  const decimal = `&#49;${GP_OVERVIEW.slice(1)}`; // '1' is &#49;
  const hex = GP_DETAIL.replace('-', '&#x2D;');
  assert.deepStrictEqual(navigationGenPageIds(navXml(subArea(pageAttr(decimal)), subArea(pageAttr(hex, "'")))), { ok: true, ids: [GP_OVERVIEW, GP_DETAIL].sort() });
});

test('navigationGenPageIds: a page id is a GUID, or a GUID in braces, exactly as the SDK reads it — any other value is a navigation that cannot be read, in either quote style', () => {
  assert.deepStrictEqual(navigationGenPageIds(navXml(subArea(pageAttr(`{${GP_OVERVIEW.toUpperCase()}}`, "'")))), { ok: true, ids: [GP_OVERVIEW] });
  for (const bad of ['not-a-guid', ` ${GP_OVERVIEW}`, `${GP_OVERVIEW} `, `{${GP_OVERVIEW}`, `${GP_OVERVIEW}}`, GP_OVERVIEW.slice(1), `${GP_OVERVIEW}0`, `{${GP_OVERVIEW}} `, `z${GP_OVERVIEW.slice(1)}`]) {
    for (const quote of ['"', "'"]) {
      const r = navigationGenPageIds(navXml(subArea(pageAttr(GP_DETAIL)), subArea(pageAttr(bad, quote))));
      assert.deepStrictEqual([r.ok, r.reason], [false, 'malformed'], `${quote}${bad}${quote}`);
      assert.match(r.detail, /not a GUID/, `${quote}${bad}${quote}`);
      assert.strictEqual(r.ids, undefined, 'a navigation that cannot be read names no page, not even the ones it read before it failed');
    }
  }
});

test('navigationGenPageIds: only a SubArea directly under SiteMap/Area/Group is navigation — the same attribute anywhere else, or on an element of another name, is not', () => {
  const page = pageAttr(GP_DETAIL);
  for (const [what, xml] of [
    ['a SubArea directly under an Area', `<SiteMap><Area Id="a"><SubArea Id="s" ${page}/></Area></SiteMap>`],
    ['a SubArea directly under the SiteMap', `<SiteMap><SubArea Id="s" ${page}/></SiteMap>`],
    ['a SubArea inside another element of a group', `<SiteMap><Area Id="a"><Group Id="g"><Other><SubArea Id="s" ${page}/></Other></Group></Area></SiteMap>`],
    ['elements whose names only start like SubArea', `<SiteMap><Area Id="a"><Group Id="g"><SubArea-Archived Id="s" ${page}/><SubAreaX Id="t" ${page}/></Group></Area></SiteMap>`],
    ['a document that is not a sitemap', `<Other><Area Id="a"><Group Id="g"><SubArea Id="s" ${page}/></Group></Area></Other>`],
  ]) {
    assert.deepStrictEqual(navigationGenPageIds(xml), { ok: true, ids: [] }, what);
  }
});

test('navigationGenPageIds: markup it cannot account for is { ok:false, reason:"malformed" } with a detail — never "no pages"', () => {
  const entry = subArea(pageAttr(GP_OVERVIEW));
  for (const [what, xml] of [
    ['an element that is never closed', `${navXml(entry)}<Dangling>`],
    ['a closing tag that matches nothing', `<SiteMap><Area Id="a"><Group Id="g">${entry}</Area></Group></SiteMap>`],
    ['a "<" that opens no tag', `<SiteMap><Area Id="a"><Group Id="g">${entry}</Group></Area> a < b </SiteMap>`],
    ['an entry whose start tag names GenPageId twice', navXml(entry, `<SubArea Id="t" ${pageAttr(GP_OVERVIEW)} ${pageAttr(GP_DETAIL, "'")}/>`)],
    ['a document type declaration, whose entities could expand into elements', `<!DOCTYPE SiteMap [<!ENTITY p "x">]>${navXml(entry)}`],
    ['no text at all', ''],
    ['no XML', undefined],
  ]) {
    const r = navigationGenPageIds(xml);
    assert.deepStrictEqual([r.ok, r.reason], [false, 'malformed'], what);
    assert.match(r.detail, /well-formed/, what);
    assert.strictEqual(r.ids, undefined, what);
  }
});

// ── ONE strict reader for the navigation (strict-xml.js) ─────────────────────────────────────────────────────────────────────────────
// The elements of a sitemap are read in ONE pass by a strict XML reader, never by passes that each take one kind of construct out of the text (a delimiter of one kind inside another kind then changed what was left),
// and a document that is not exactly one well-formed XML document is read as nothing at all — so that no page is ever proven, or recorded as the app's, by a part of a document that does not read.
const entryA = subArea(pageAttr(GP_OVERVIEW));
const entryB = subArea(pageAttr(GP_DETAIL));
// A processing instruction that holds "<!--", then a CDATA section that holds "-->" and "?>" and an entry for B: B is text.
const DATA_B = navXml(entryA, `<?p <!-- ?><![CDATA[ --> ?> ${entryB} ]]>`);
// Two processing instructions that hold the "<![CDATA[" and the "]]>" of a CDATA section, with an entry between them and one after: both are entries.
const ENTRIES_BETWEEN_PI_MARKERS = navXml('<?note <![CDATA[ ?>', entryA, '<?note ]]> ?>', entryB);
// Two CDATA sections that hold the "<!--" and the "-->" of a comment, with an entry between them and one after: both are entries.
const ENTRIES_BETWEEN_CDATA_MARKERS = navXml('<![CDATA[ <!-- ]]>', entryA, '<![CDATA[ --> ]]>', entryB);

test('navigationGenPageIds: a delimiter of one kind of construct inside another kind is data — the pages of the entries are those the elements name, however the delimiters of comments, CDATA sections and processing instructions interleave', () => {
  const only = (ids) => ({ ok: true, ids });
  for (const [what, xml, ids] of [
    ['a PI that holds "<!--" and a CDATA section that holds "-->" and "?>": the entry inside the CDATA section is text', DATA_B, [GP_OVERVIEW]],
    ['PIs that hold the markers of a CDATA section: the entry between them is an entry', ENTRIES_BETWEEN_PI_MARKERS, BOTH_PAGES],
    ['CDATA sections that hold the markers of a comment: the entry between them is an entry', ENTRIES_BETWEEN_CDATA_MARKERS, BOTH_PAGES],
    ['a comment that holds "<![CDATA[", "<?" and "]]>"', navXml(entryA, `<!-- <![CDATA[ <? ]]> ${entryB} -->`), [GP_OVERVIEW]],
    ['a PI that holds "-->" and "]]>"', navXml(entryA, `<?p --> ]]> ${entryB} ?>`), [GP_OVERVIEW]],
    ['a CDATA section that holds "<?" and "<!--" and no end of either', navXml(entryA, `<![CDATA[ <? <!-- ${entryB} ]]>`), [GP_OVERVIEW]],
    ['a CDATA section, then a comment, then a PI, each holding an entry', navXml(entryA, `<![CDATA[${entryB}]]><!-- ${entryB} --><?p ${entryB}?>`), [GP_OVERVIEW]],
    ['an attribute value that holds the delimiters of every construct (">" and "]]>" are legal there; "<" is escaped)', navXml(`<SubArea Id="s" Title="--> ?> ]]> &lt;!-- &lt;![CDATA[ &lt;?" ${pageAttr(GP_OVERVIEW)}/>`, entryB), BOTH_PAGES],
    ['an attribute value in single quotes that holds a double-quoted GenPageId, and the other way round', navXml(`<SubArea Id="s" Title='GenPageId="${GP_DETAIL}"' ${pageAttr(GP_OVERVIEW)}/>`, `<SubArea Id="t" Title="GenPageId='${GP_DETAIL}'" ${pageAttr(GP_OVERVIEW, "'")}/>`), [GP_OVERVIEW]],
    ['markers around the root element: a PI that holds "<!--" before it, a comment and a PI that holds "-->" after it', `<?p <!-- ?>${navXml(entryA, entryB)}<!-- a --><?q --> ?>`, BOTH_PAGES],
  ]) {
    assert.deepStrictEqual(navigationGenPageIds(xml), only(ids), what);
  }
});

test('navigationGenPageIds: a document that is not exactly one well-formed XML document is unreadable — no page, not even the ones that read before the fault', () => {
  const root = navXml(entryA, entryB);
  for (const [what, xml, detail] of [
    ['two document roots', navXml(entryA) + navXml(entryB), /second root element/],
    ['two document roots with a comment between them', `${navXml(entryA)}<!-- between -->${navXml(entryB)}`, /second root element/],
    ['text after the root element', `${root} trailing`, /text after the root element/],
    ['text before the root element', `leading ${root}`, /text before the root element/],
    ['a CDATA section outside the root element', `<![CDATA[x]]>${root}`, /CDATA section outside the root element/],
    ['a closing tag with no element open', `${root}</SiteMap>`, /closing tag/],
    ['a closing tag out of order', `<SiteMap><Area Id="a"><Group Id="g">${entryA}</Area></Group></SiteMap>`, /closing tag <\/Area> where <\/Group> is expected/],
    ['a closing tag that differs in case only', `<SiteMap><Area Id="a"><Group Id="g">${entryA}</group></Area></SiteMap>`, /closing tag <\/group> where <\/Group> is expected/],
    ['a closing tag with attributes', `<SiteMap><Area Id="a"><Group Id="g">${entryA}</Group bad="yes"></Area></SiteMap>`, /closing tag that holds more than the element name/],
    ['an element that is never closed', `<SiteMap><Area Id="a"><Group Id="g">${entryA}`, /element <Group> is never closed/],
    ['a start tag that is never closed', `<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="s" ${pageAttr(GP_OVERVIEW)}`, /tag that is never closed/],
    ['an attribute value that is never closed', `<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="s" GenPageId="${GP_OVERVIEW}`, /attribute value that is never closed/],
    ['an unquoted attribute value', navXml(`<SubArea Id=s ${pageAttr(GP_OVERVIEW)}/>`, entryB), /not in quotes/],
    ['an attribute with no value', navXml(`<SubArea Id ${pageAttr(GP_OVERVIEW)}/>`, entryB), /no value/],
    ['attributes with no white space between them', navXml(`<SubArea Id="s"${pageAttr(GP_OVERVIEW)}/>`, entryB), /not separated by white space/],
    ['an attribute named twice (an entry)', navXml(`<SubArea Id="s" ${pageAttr(GP_OVERVIEW)} ${pageAttr(GP_DETAIL, "'")}/>`), /GenPageId twice/],
    ['an attribute named twice (an element that is no entry)', `<SiteMap><Area Id="a" Id="b"><Group Id="g">${entryA}${entryB}</Group></Area></SiteMap>`, /Id twice/],
    ['a "<" in an attribute value', navXml(`<SubArea Id="s" Title="a < b" ${pageAttr(GP_OVERVIEW)}/>`, entryB), /"<" inside an attribute value/],
    ['an entity that is not declared', navXml(`<SubArea Id="s" Title="&unknown;" ${pageAttr(GP_OVERVIEW)}/>`, entryB), /predefined entities or a character reference/],
    ['an HTML entity, which XML does not declare', navXml(`<SubArea Id="s" Title="&nbsp;" ${pageAttr(GP_OVERVIEW)}/>`, entryB), /predefined entities or a character reference/],
    ['a bare "&" in text', navXml(entryA, 'a & b'), /predefined entities or a character reference/],
    ['a character reference to a character XML does not allow', navXml(`<SubArea Id="s" Title="&#0;" ${pageAttr(GP_OVERVIEW)}/>`), /reference to a character that XML does not allow/],
    ['"]]>" in character data', navXml(entryA, 'a ]]> b'), /\]\]> in character data/],
    ['"--" inside a comment', navXml(entryA, '<!-- a -- b -->'), /'--' inside a comment/],
    ['a comment that never ends', navXml(entryA, '<!-- a'), /comment that is never closed/],
    ['a CDATA section that never ends', navXml(entryA, '<![CDATA[ a'), /CDATA section that is never closed/],
    ['a processing instruction that never ends', navXml(entryA, '<?p a'), /processing instruction that is never closed/],
    ['a document type declaration', `<!DOCTYPE SiteMap>${root}`, /document type declaration/],
    ['a document type declaration with entities', `<!DOCTYPE SiteMap [<!ENTITY p "x">]>${root}`, /document type declaration/],
    ['an XML declaration that is not at the start', ` <?xml version="1.0"?>${root}`, /named "xml"/],
    ['a character XML does not allow', navXml(entryA, 'a \u0001 b'), /character that XML does not allow/],
    ['no text at all', '', /no XML text|no root element/],
    ['only a comment', '<!-- x -->', /no root element/],
  ]) {
    const r = navigationGenPageIds(xml);
    assert.deepStrictEqual([r.ok, r.reason], [false, 'malformed'], what);
    assert.match(r.detail, /not well-formed/, what);
    assert.match(r.detail, detail, what);
    assert.match(r.detail, /line \d+, column \d+|no (root element|XML text)/, `${what}: it says where`);
    assert.strictEqual(r.ids, undefined, what);
  }
});

test('navigationGenPageIds: an entry nested anywhere else, with a GenPageId that is no GUID, is unreadable too — the SDK\u2019s own reader takes a SubArea at any depth and refuses one, so the proof and the delete agree on what the document says', () => {
  const nested = `<SiteMap><Area Id="a"><Group Id="g">${entryA}</Group><SubArea Id="s" GenPageId='not-a-guid'/></Area></SiteMap>`;
  const r = navigationGenPageIds(nested);
  assert.deepStrictEqual([r.ok, r.reason], [false, 'malformed']);
  assert.match(r.detail, /not a GUID/);
  // A nested entry with a page id that IS a GUID names no page here (it is not navigation), and does not stop the reading.
  assert.deepStrictEqual(navigationGenPageIds(`<SiteMap><Area Id="a"><Group Id="g">${entryA}</Group><SubArea Id="s" ${pageAttr(GP_DETAIL)}/></Area></SiteMap>`), { ok: true, ids: [GP_OVERVIEW] });
});

test('navigationGenPageIds: element and attribute names are exact, as XML and the platform write them — a differently-cased element or attribute is another one, and names no page', () => {
  for (const [what, xml] of [
    ['an attribute spelled genpageid', navXml(`<SubArea Id="s" genpageid="${GP_DETAIL}"/>`)],
    ['an element spelled subarea', navXml(`<subarea Id="s" ${pageAttr(GP_DETAIL)}/>`)],
    ['an area spelled in lower case', `<SiteMap><area Id="a"><Group Id="g">${entryB}</Group></area></SiteMap>`],
    ['a prefixed SubArea', navXml(`<m:SubArea Id="s" ${pageAttr(GP_DETAIL)}/>`)],
    ['a prefixed SiteMap', `<m:SiteMap xmlns:m="urn:contoso:sitemap"><m:Area Id="a"><m:Group Id="g">${entryB}</m:Group></m:Area></m:SiteMap>`],
  ]) {
    assert.deepStrictEqual(navigationGenPageIds(xml), { ok: true, ids: [] }, what);
  }
  // A default namespace does not prefix anything: the elements are still SiteMap, Area, Group and SubArea.
  assert.deepStrictEqual(navigationGenPageIds(navXml(entryA, entryB).replace('<SiteMap>', '<SiteMap xmlns="urn:contoso:sitemap">')), { ok: true, ids: BOTH_PAGES });
});

const XML_PIN = [
  '<SiteMap>',
  '  <Area Id="Sales" Title="Sales">',
  '    <Group Id="Work" Title="Work">',
  `      <SubArea Id="s1" GenPageId="${GP_OVERVIEW}" Title="Orders &amp; Overview" />`,
  '      <SubArea Id="s2" Entity="new_liveorder" Title="Orders" Icon="$webresource:new_icon.png" />',
  `      <SubArea Id="s3" GenPageId="${GP_DETAIL.toUpperCase()}" Title="Order Detail" />`,
  '      <SubArea Id="s4" Url="https://x/00000000-0000-0000-0000-000000000000" Title="Decoy" VectorIcon="$webresource:new_v.svg" />',
  '      <SubArea Id="s5" Url="/workplace/home_dashboards.aspx" DefaultDashboard="{280948EC-0000-4000-8000-000000000001}" />',
  '      <SubArea Id="s6" Page="contoso_details" />',
  '    </Group>',
  '  </Area>',
  '</SiteMap>',
].join('\n');

test('liveNavEntries: the entries of an ordinary sitemap are read as they always were — one per target, in document order, with the icon, vector icon and Url of each', () => {
  assert.strictEqual(JSON.stringify([...liveNavEntries(XML_PIN)]), JSON.stringify([
    [`GenPage:${GP_OVERVIEW}`, [{}]],
    ['Entity:new_liveorder', [{ icon: '$webresource:new_icon.png' }]],
    [`GenPage:${GP_DETAIL}`, [{}]],
    ['URL:https://x/00000000-0000-0000-0000-000000000000', [{ vectorIcon: '$webresource:new_v.svg', url: 'https://x/00000000-0000-0000-0000-000000000000' }]],
    ['DashBoard:280948ec-0000-4000-8000-000000000001', [{ url: '/workplace/home_dashboards.aspx' }]],
    ['CustomPage:contoso_details', [{}]],
  ]));
});

test('liveNavEntries: it is the same reader — the markers of one construct inside another hide no entry from it, and add none, and a document that is not one well-formed document is null', () => {
  const keys = (xml) => [...liveNavEntries(xml).keys()];
  assert.deepStrictEqual(keys(DATA_B), [`GenPage:${GP_OVERVIEW}`]);
  assert.deepStrictEqual(keys(ENTRIES_BETWEEN_PI_MARKERS), [`GenPage:${GP_OVERVIEW}`, `GenPage:${GP_DETAIL}`]);
  assert.deepStrictEqual(keys(ENTRIES_BETWEEN_CDATA_MARKERS), [`GenPage:${GP_OVERVIEW}`, `GenPage:${GP_DETAIL}`]);
  for (const xml of [navXml(entryA) + navXml(entryB), `${navXml(entryA)} trailing`, navXml(`<SubArea Id=s ${pageAttr(GP_OVERVIEW)}/>`), `<!DOCTYPE SiteMap>${navXml(entryA)}`, `<SiteMap><Area><Group>${entryA}`, '', undefined, null]) {
    assert.strictEqual(liveNavEntries(xml), null, String(xml));
  }
  assert.strictEqual(liveNavEntries('<SiteMap />').size, 0, 'a sitemap with no entry is a readable one');
});

// ── navigationProof reads the pages of a navigation as navigation, in whichever layer it reads ──────────────────────────────────

test('navigationProof: a published app is proven by the navigation elements of its published sitemap — a page that only a comment or a CDATA section names is not proven, and the saved layer is asked about it', async () => {
  for (const hide of [(s) => `<!-- ${s} -->`, (s) => `<![CDATA[${s}]]>`]) {
    const xml = navXml(subArea(pageAttr(GP_OVERVIEW)), hide(subArea(pageAttr(GP_DETAIL))));
    const published = publishedOf(xml);
    assert.deepStrictEqual(published.ids, BOTH_PAGES, 'the text reader of fetchSitemap names both pages');
    const { sdk, calls } = proofEnv({ publishedApps: [{ appmoduleid: PROOF_APP }], sitemap: { status: 200, body: { value: [{ sitemapxml: xml, componentstate: 1 }] } } });
    const r = await navigationProof(sdk, 'contoso_app', published, [GP_OVERVIEW, GP_DETAIL]);
    assert.deepStrictEqual(r.ids, [GP_OVERVIEW], 'the page in the comment is in the navigation of neither layer');
    assert.deepStrictEqual(r.currentNavigation, { ok: true, ids: [GP_OVERVIEW] });
    assert.ok(calls.gets.length > 0, 'the saved layer was read, for the page the published navigation does not prove');
  }
});

test('navigationProof: a published app whose navigation names its pages in single quotes has them proven by the published layer, with no read of the saved one', async () => {
  const { sdk, calls } = proofEnv();
  const r = await navigationProof(sdk, 'contoso_app', publishedOf(navXml(subArea(pageAttr(GP_OVERVIEW, "'")), subArea(pageAttr(GP_DETAIL, "'")))), [GP_OVERVIEW, GP_DETAIL]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, BOTH_PAGES);
  assert.deepStrictEqual(calls, { resolved: [], queries: [], gets: [] });
});

test('navigationProof: the saved layer of a published app is read as navigation too — a page only a comment names is not proven by it, a single-quoted one is', async () => {
  const published = publishedOf(withPage(GP_OVERVIEW));
  const saved = (xml) => proofEnv({ publishedApps: [{ appmoduleid: PROOF_APP }], sitemap: { status: 200, body: { value: [{ sitemapxml: xml, componentstate: 1 }] } } });
  const hidden = await navigationProof(saved(navXml(subArea(pageAttr(GP_OVERVIEW)), `<!-- ${subArea(pageAttr(GP_DETAIL))} -->`)).sdk, 'contoso_app', published, [GP_OVERVIEW, GP_DETAIL]);
  assert.deepStrictEqual(hidden.ids, [GP_OVERVIEW]);
  assert.deepStrictEqual(hidden.currentNavigation, { ok: true, ids: [GP_OVERVIEW] });
  const quoted = await navigationProof(saved(navXml(subArea(pageAttr(GP_OVERVIEW)), subArea(pageAttr(GP_DETAIL, "'")))).sdk, 'contoso_app', published, [GP_OVERVIEW, GP_DETAIL]);
  assert.deepStrictEqual(quoted.ids, BOTH_PAGES);
  assert.deepStrictEqual(quoted.currentNavigation, { ok: true, ids: BOTH_PAGES });
  // A saved navigation that cannot be read as navigation proves nothing more, and says why — as one the platform refuses to answer does.
  const unread = await navigationProof(saved(`${navXml(subArea(pageAttr(GP_OVERVIEW)))}<Dangling>`).sdk, 'contoso_app', published, [GP_OVERVIEW, GP_DETAIL]);
  assert.deepStrictEqual(unread.ids, [GP_OVERVIEW]);
  assert.strictEqual(unread.ok, true);
  assert.strictEqual(unread.currentNavigation.ok, false);
  assert.match(unread.currentNavigation.reason, /malformed.*well-formed/);
});

test('navigationProof: a published sitemap whose markup cannot be read as navigation is an unreadable answer — not a navigation without pages, and not the pages its text names', async () => {
  const published = publishedOf(`${navXml(subArea(pageAttr(GP_OVERVIEW)))}<Dangling>`);
  assert.deepStrictEqual(published.ids, [GP_OVERVIEW], 'fetchSitemap accepts it: its text is a sitemap that ends with ">"');
  const { sdk, calls } = proofEnv();
  for (const candidates of [[GP_OVERVIEW], []]) {
    const r = await navigationProof(sdk, 'contoso_app', published, candidates);
    assert.deepStrictEqual([r.ok, r.reason], [false, 'malformed']);
    assert.match(r.detail, /well-formed/);
    assert.strictEqual(r.ids, undefined);
  }
  assert.deepStrictEqual(calls, { resolved: [], queries: [], gets: [] });
});

// An app with no published layer is read through the sitemap its saved layer holds: found through its sitemap component, or through the unique name that its sitemap carries when its layer has no sitemap component.
const NEVER_PUBLISHED_ROUTES = [
  ['its sitemap component', undefined],
  ['the unique name its sitemap carries', []],
];
const savedSitemapOf = (xml) => ({
  saved: { status: 200, body: { value: [{ sitemapid: PROOF_SITEMAP, sitemapnameunique: 'contoso_app', sitemapxml: xml, componentstate: 1 }] } },
  sitemap: { status: 200, body: { value: [{ sitemapxml: xml, componentstate: 1 }] } },
});

test('navigationProof: an app with no published layer is proven by the navigation elements of its saved sitemap — a comment or a CDATA section names no page, a single-quoted attribute does — by its component or by its name', async () => {
  for (const [route, components] of NEVER_PUBLISHED_ROUTES) {
    for (const [what, xml, ids] of [
      ['a comment', navXml(subArea(pageAttr(GP_OVERVIEW)), `<!-- ${subArea(pageAttr(GP_DETAIL))} -->`), [GP_OVERVIEW]],
      ['a CDATA section', navXml(subArea(pageAttr(GP_OVERVIEW)), `<![CDATA[${subArea(pageAttr(GP_DETAIL))}]]>`), [GP_OVERVIEW]],
      ['single quotes', navXml(subArea(pageAttr(GP_OVERVIEW, "'")), subArea(pageAttr(GP_DETAIL, "'"))), BOTH_PAGES],
    ]) {
      const { sdk } = proofEnv({ components, ...savedSitemapOf(xml) });
      const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW, GP_DETAIL]);
      assert.deepStrictEqual(r, { ok: true, neverPublished: true, ids, currentNavigation: { ok: true, ids } }, `${route}: ${what}`);
    }
  }
});

test('navigationProof: a saved sitemap of an app with no published layer whose markup cannot be read as navigation, or that holds a page id that is no GUID in single quotes, is unreadable — never "no pages"', async () => {
  for (const [route, components] of NEVER_PUBLISHED_ROUTES) {
    for (const [what, xml, detail] of [
      ['an element that is never closed', `${navXml(subArea(pageAttr(GP_OVERVIEW)))}<Dangling>`, /well-formed/],
      ['a single-quoted page id that is no GUID', navXml(subArea(pageAttr(GP_OVERVIEW)), subArea(pageAttr('not-a-guid', "'"))), /not a GUID/],
    ]) {
      const { sdk } = proofEnv({ components, ...savedSitemapOf(xml) });
      const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW]);
      assert.deepStrictEqual([r.ok, r.neverPublished, r.reason], [false, true, 'malformed'], `${route}: ${what}`);
      assert.match(r.detail, detail, `${route}: ${what}`);
      assert.strictEqual(r.ids, undefined, `${route}: ${what}`);
    }
  }
});

// The sitemap of an app whose layer has no sitemap component is found by the unique name its rows carry. A sitemap with a pending edit answers with the rows of both its layers, and the row whose navigation is read is the
// CURRENT one: so it is the current row that has to carry the app's name — not some other row of the sitemap that happens to — and a sitemap whose rows do not agree on whose it is leaves it unknown whose navigation it is.
const namedRow = (name, pages, componentstate) => ({ sitemapid: PROOF_SITEMAP, sitemapnameunique: name, sitemapxml: withPage(...pages), componentstate });

test('navigationProof: the current row of a sitemap found by name must carry the app\'s unique name itself — a name on another row is no proof whose navigation it is, whichever row is listed first', async () => {
  for (const [what, rows] of [
    ['the name is on the older row only, and the current row is another app\'s', [namedRow('contoso_app', [GP_OVERVIEW], 0), namedRow('contoso_foreign', [GP_DETAIL], 1)]],
    ['the name is on the current row only, and the older row is another app\'s', [namedRow('contoso_foreign', [GP_OVERVIEW], 0), namedRow('contoso_app', [GP_DETAIL], 1)]],
    ['the name is on the current row, and the older row carries none', [namedRow(null, [GP_OVERVIEW], 0), namedRow('contoso_app', [GP_DETAIL], 1)]],
    ['the name is on the older row, and the current row carries none', [namedRow('contoso_app', [GP_OVERVIEW], 0), namedRow('', [GP_DETAIL], 1)]],
  ]) {
    for (const listed of [rows, [...rows].reverse()]) {
      const { sdk } = proofEnv({ components: [], saved: { status: 200, body: { value: listed } } });
      const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW, GP_DETAIL]);
      assert.deepStrictEqual([r.ok, r.neverPublished, r.reason], [false, true, 'sitemap-query-failed'], `${what}, listed ${listed[0].componentstate === 0 ? 'older' : 'current'} first`);
      assert.match(r.detail, /unique name/, what);
      assert.strictEqual(r.ids, undefined, `${what}: not one page is proven`);
    }
  }
});

test('navigationProof: every row of a sitemap found by name that carries the app\'s unique name — in any case, with stray spaces — gives the navigation of its current row, whichever row is listed first', async () => {
  for (const names of [['contoso_app', 'contoso_app'], ['CONTOSO_APP', 'Contoso_App'], [' contoso_app', 'contoso_app ']]) {
    const rows = [namedRow(names[0], [GP_OVERVIEW], 0), namedRow(names[1], [GP_DETAIL], 1)];
    for (const listed of [rows, [...rows].reverse()]) {
      const { sdk } = proofEnv({ components: [], saved: { status: 200, body: { value: listed } } });
      const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_DETAIL]);
      assert.deepStrictEqual(r, { ok: true, neverPublished: true, ids: [GP_DETAIL], currentNavigation: { ok: true, ids: [GP_DETAIL] } }, JSON.stringify(names));
    }
  }
});

test('navigationProof: the markers of one construct inside another make a page of no navigation, and hide none — in the published layer, the saved layer of a published app, and the saved layer of an app that was never published', async () => {
  const documents = [
    ['a PI that holds "<!--" and a CDATA section that holds "-->" and "?>" around an entry for B', DATA_B, [GP_OVERVIEW]],
    ['PIs that hold the markers of a CDATA section around an entry', ENTRIES_BETWEEN_PI_MARKERS, BOTH_PAGES],
    ['CDATA sections that hold the markers of a comment around an entry', ENTRIES_BETWEEN_CDATA_MARKERS, BOTH_PAGES],
  ];
  for (const [what, xml, ids] of documents) {
    // The published layer, which the teardown reads first: the answer of fetchSitemap carries the ids of its text reader (all of them here), and the proof is the elements'.
    const published = publishedOf(xml);
    const { sdk } = proofEnv({ publishedApps: [{ appmoduleid: PROOF_APP }], sitemap: { status: 200, body: { value: [{ sitemapxml: navXml(entryA), componentstate: 1 }] } } });
    assert.deepStrictEqual((await navigationProof(sdk, 'contoso_app', published, [GP_OVERVIEW, GP_DETAIL])).ids, ids, `published: ${what}`);
    // The saved layer of a published app, which names more than the published layer does.
    const supplement = proofEnv({ publishedApps: [{ appmoduleid: PROOF_APP }], sitemap: { status: 200, body: { value: [{ sitemapxml: xml, componentstate: 1 }] } } });
    const added = await navigationProof(supplement.sdk, 'contoso_app', publishedOf(navXml(entryA)), [GP_OVERVIEW, GP_DETAIL]);
    assert.deepStrictEqual(added.ids, ids, `saved layer of a published app: ${what}`);
    assert.deepStrictEqual(added.currentNavigation, { ok: true, ids }, `saved layer of a published app: ${what}`);
    // The saved layer of an app that was never published, by its sitemap component and by its unique name.
    for (const [route, components] of NEVER_PUBLISHED_ROUTES) {
      const { sdk: draft } = proofEnv({ components, ...savedSitemapOf(xml) });
      assert.deepStrictEqual(await navigationProof(draft, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW, GP_DETAIL]), { ok: true, neverPublished: true, ids, currentNavigation: { ok: true, ids } }, `${route}: ${what}`);
    }
  }
});

test('navigationProof: a sitemap that is not one well-formed document is unreadable in every layer — nothing is proven by it, and a published one is not followed by a single further read', async () => {
  for (const [what, xml] of [
    ['two document roots', navXml(entryA) + navXml(entryB)],
    ['text after the root element', `${navXml(entryA, entryB)} trailing <!-- end -->`],
    ['an unquoted attribute value', navXml(`<SubArea Id=s ${pageAttr(GP_OVERVIEW)}/>`, entryB)],
    ['an entity that is not declared', navXml(`<SubArea Id="s" Title="&nope;" ${pageAttr(GP_OVERVIEW)}/>`, entryB)],
    ['a closing tag with attributes', `<SiteMap><Area Id="a"><Group Id="g">${entryA}${entryB}</Group bad="yes"></Area></SiteMap>`],
  ]) {
    const published = proofEnv();
    const unread = await navigationProof(published.sdk, 'contoso_app', publishedOf(xml), [GP_OVERVIEW, GP_DETAIL]);
    assert.deepStrictEqual([unread.ok, unread.reason], [false, 'malformed'], `published: ${what}`);
    assert.match(unread.detail, /not well-formed/, what);
    assert.strictEqual(unread.ids, undefined, what);
    assert.deepStrictEqual(published.calls, { resolved: [], queries: [], gets: [] }, `published: ${what}: no read follows`);

    const supplement = proofEnv({ publishedApps: [{ appmoduleid: PROOF_APP }], sitemap: { status: 200, body: { value: [{ sitemapxml: xml, componentstate: 1 }] } } });
    const added = await navigationProof(supplement.sdk, 'contoso_app', publishedOf(navXml(entryA)), [GP_OVERVIEW, GP_DETAIL]);
    assert.deepStrictEqual(added.ids, [GP_OVERVIEW], `saved layer of a published app: ${what}: the published proof stands, and nothing is added`);
    assert.strictEqual(added.currentNavigation.ok, false, what);
    assert.match(added.currentNavigation.reason, /malformed: .*not well-formed/, what);

    for (const [route, components] of NEVER_PUBLISHED_ROUTES) {
      const { sdk } = proofEnv({ components, ...savedSitemapOf(xml) });
      const r = await navigationProof(sdk, 'contoso_app', NOT_PUBLISHED, [GP_OVERVIEW, GP_DETAIL]);
      assert.deepStrictEqual([r.ok, r.neverPublished, r.reason], [false, true, 'malformed'], `${route}: ${what}`);
      assert.match(r.detail, /not well-formed/, `${route}: ${what}`);
      assert.strictEqual(r.ids, undefined, `${route}: ${what}`);
    }
  }
});

// The scan of the OTHER apps (fetchAppsForPages) reads text, and keeps it: what it finds can only REFUSE an update ("another app holds this page"), and never makes a page one that is deleted, so a page that another
// app's sitemap names only in a comment is still reported — a refusal that is not needed costs a message, and a reference that is missed costs another app's page.
test('fetchAppsForPages: a page that another app\'s sitemap names only in a comment is still reported as shared — the scan only ever refuses, and reads text', async () => {
  const commented = `<SiteMap><Area><Group><!-- <SubArea Id="p" GenPageId="${GP_OVERVIEW}"/> --></Group></Area></SiteMap>`;
  const { sdk } = scanEnv([{ name: 'app-a', published: withPage() }, { name: 'app-b', published: commented }]);
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.byId.get(GP_OVERVIEW), ['app-b']);
});
