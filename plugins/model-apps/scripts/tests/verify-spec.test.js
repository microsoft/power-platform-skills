'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { verifySpec, hasElement } = require('../lib/verify-spec.js');
const { sitemapXmlFor } = require('../verify-model-app.js');

const idFor = (set) => ({ savedquery: 'savedqueryid', savedqueryvisualization: 'savedqueryvisualizationid', systemform: 'formid' }[set] || 'id');

test('verifySpec: everything present -> ok', async () => {
  const spec = {
    entities: [{ schemaName: 'new_o', columns: [{ schemaName: 'new_s' }] }],
    views: [{ entity: 'new_o', name: 'V' }],
    charts: [{ entity: 'new_o', name: 'C' }],
    forms: [{ entity: 'new_o', name: 'F' }],
    appShell: { areas: [{ label: 'Main', icon: 'a.png', groups: [{ subAreas: [{ entity: 'new_o', title: 'O', icon: 'ic.png' }] }] }] },
  };
  const read = {
    findTable: async () => ({ logicalName: 'new_o' }),
    findColumns: async () => [{ logicalName: 'new_s' }],
    queryRecords: async (set) => [{ [idFor(set)]: 'id-1' }],
    sitemapXml: async () => '<SiteMap><Area Icon="a.png"><SubArea Entity="new_o" Icon="ic.png"/></Area></SiteMap>',
  };
  const r = await verifySpec(spec, read);
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.ok(r.checks.some((c) => c.kind === 'subarea-icon' && c.present));
});

test('verifySpec: flags a missing column, view, and subarea icon', async () => {
  const spec = {
    entities: [{ schemaName: 'new_o', columns: [{ schemaName: 'new_s' }] }],
    views: [{ entity: 'new_o', name: 'V' }],
    forms: [],
    charts: [],
    appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'new_o', title: 'O', icon: 'ic.png' }] }] }] },
  };
  const read = {
    findTable: async () => ({ logicalName: 'new_o' }),
    findColumns: async () => [], // column missing
    queryRecords: async () => [], // view missing
    sitemapXml: async () => '<SiteMap><SubArea Entity="new_o"/></SiteMap>', // icon missing (subarea present)
  };
  const r = await verifySpec(spec, read);
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.some((m) => m.kind === 'column'));
  assert.ok(r.missing.some((m) => m.kind === 'view'));
  assert.ok(r.missing.some((m) => m.kind === 'subarea-icon'));
  assert.ok(r.checks.some((c) => c.kind === 'subarea' && c.present), 'the subarea itself is present');
});

test('verifySpec: a missing entity skips its column checks', async () => {
  const spec = { entities: [{ schemaName: 'new_o', columns: [{ schemaName: 'new_s' }] }], appShell: { areas: [] } };
  const read = { findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '' };
  const r = await verifySpec(spec, read);
  assert.ok(r.missing.some((m) => m.kind === 'entity'));
  assert.ok(!r.checks.some((c) => c.kind === 'column'), 'no column checks when the entity is absent');
});

test('verifySpec: an icon present only on a different element does not satisfy the check (scoped)', async () => {
  const spec = {
    entities: [], views: [], charts: [], forms: [],
    appShell: { areas: [{ label: 'Main', icon: 'shared.png', groups: [{ subAreas: [{ entity: 'new_o', title: 'O', icon: 'shared.png' }] }] }] },
  };
  const read = {
    findTable: async () => null,
    findColumns: async () => [],
    queryRecords: async () => [],
    // 'shared.png' appears ONLY on the SubArea, never on the Area.
    sitemapXml: async () => '<SiteMap><Area Icon="area-only.png"><SubArea Entity="new_o" Icon="shared.png"/></Area></SiteMap>',
  };
  const r = await verifySpec(spec, read);
  assert.ok(r.missing.some((m) => m.kind === 'area-icon'), 'area icon missing even though the same icon exists on a subarea');
  assert.ok(r.checks.some((c) => c.kind === 'subarea-icon' && c.present), 'subarea icon correctly matched on its own SubArea');
});

test('hasElement scopes attribute matching to the named element start-tag', () => {
  const xml = '<SiteMap><Area Icon="a.png"><SubArea Entity="new_o" Icon="ic.png"/></Area></SiteMap>';
  assert.strictEqual(hasElement(xml, 'Area', { Icon: 'a.png' }), true);
  assert.strictEqual(hasElement(xml, 'Area', { Icon: 'ic.png' }), false, 'a SubArea icon must not match an Area check');
  assert.strictEqual(hasElement(xml, 'SubArea', { Entity: 'new_o', Icon: 'ic.png' }), true, 'both attrs on the same SubArea');
  assert.strictEqual(hasElement(xml, 'SubArea', { Entity: 'new_o', Icon: 'a.png' }), false, 'icon lives on the Area, not this SubArea');
});

test('verifySpec: dashboard subarea resolves the dashboard id and matches the sitemap DefaultDashboard', async () => {
  const DASH = 'AAaa1111-2222-3333-4444-555566667777';
  const spec = {
    entities: [], views: [], charts: [], forms: [],
    appShell: { areas: [{ groups: [{ subAreas: [{ dashboard: 'Ops', title: 'Ops' }] }] }] },
  };
  const present = {
    findTable: async () => null, findColumns: async () => [],
    queryRecords: async (set, opts) => (set === 'systemform' && /name eq 'Ops'/.test(opts.filter) ? [{ formid: DASH }] : []),
    // Sitemap points a SubArea at the resolved dashboard id (Dataverse upper-cases + brace-wraps it).
    sitemapXml: async () => `<SiteMap><Area><SubArea Id="s" DefaultDashboard="{${DASH.toUpperCase()}}"/></Area></SiteMap>`,
  };
  const ok = await verifySpec(spec, present);
  assert.ok(ok.checks.some((c) => c.kind === 'subarea' && c.present), 'dashboard subarea matched by resolved id (brace/case-insensitive)');

  // A different dashboard id in the sitemap must NOT satisfy the check.
  const wrong = { ...present, sitemapXml: async () => '<SiteMap><Area><SubArea Id="s" DefaultDashboard="99999999-0000-0000-0000-000000000000"/></Area></SiteMap>' };
  const bad = await verifySpec(spec, wrong);
  assert.ok(bad.missing.some((m) => m.kind === 'subarea'), 'a different dashboard id does not satisfy the check');
});

test('sitemapXmlFor resolves appmodule -> component 62 -> sitemap', async () => {
  const sdk = {
    queryRecords: async (set) => {
      if (set === 'appmodule') return [{ appmoduleid: 'a', appmoduleidunique: 'u-1' }];
      if (set === 'appmodulecomponent') return [{ objectid: 'sm-1', componenttype: 62 }];
      if (set === 'sitemap') return [{ sitemapxml: '<SiteMap/>' }];
      return [];
    },
  };
  assert.strictEqual(await sitemapXmlFor(sdk, 'new_app'), '<SiteMap/>');
});

test('sitemapXmlFor returns empty when the app is not found', async () => {
  const sdk = { queryRecords: async () => [] };
  assert.strictEqual(await sitemapXmlFor(sdk, 'new_missing'), '');
});

// ---------------------------------------------------------------------------
// Page branch tests — Task 7: three-authority (IDENTITY+EXISTENCE+MEMBERSHIP)
// ---------------------------------------------------------------------------
// Plan 5 GUIDs (Imp9): real 36-char GUIDs in every mock.
const GP_OVERVIEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_DETAIL   = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const GP_EXTRA    = '9f2b1a3c-77de-4a10-8b6e-2c4d5e6f7a8b';

// Reader mock: supplies all three authorities (sitemapPageIds/existenceIds/manifest) + pageCode.
// Tests set each authority independently to exercise specific check paths.
function pageRead({ sitemapIds, existenceIds, manifest, code, sitemap }) {
  return {
    findTable: async () => ({ logicalName: 'contoso_item' }),
    findColumns: async () => [],
    queryRecords: async () => [],
    sitemapXml: async () => sitemap || '',
    sitemapPageIds: async () => sitemapIds || [],
    existenceIds: async () => existenceIds || [],
    manifest: async () => manifest || null,
    pageCode: async (id) => (code && code[String(id).toLowerCase()]) || '',
  };
}

function pageSpec(navTargets = [{ targetKey: 'detail' }]) {
  return {
    entities: [{ schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    schemaVersion: 2,
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo: navTargets, source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
  };
}

// Sitemap XML binding both pages by real GUIDs in the GenPageId attribute.
const SITEMAP_OK = `<SiteMap><Area><Group><SubArea Id="s1" GenPageId="${GP_OVERVIEW}"/><SubArea Id="s2" GenPageId="${GP_DETAIL}"/></Group></Area></SiteMap>`;
const NAV_TO = (id) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "${id}", data: {} });`;
// Standard manifest with both pages having real GUIDs.
const BOTH_MANIFEST = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_OVERVIEW }, { key: 'detail', name: 'Detail', pageId: GP_DETAIL }] };

test('verifySpec pages: present + GenPageId-bound + nav edge resolves to the actual target id → ok', async () => {
  const read = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL],
    existenceIds: [GP_OVERVIEW, GP_DETAIL],
    manifest: BOTH_MANIFEST,
    sitemap: SITEMAP_OK,
    code: { [GP_OVERVIEW]: NAV_TO(GP_DETAIL) },
  });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && c.present));
  assert.ok(r.checks.some((c) => c.kind === 'page-subarea' && c.name === 'Overview' && c.present));
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present));
  assert.ok(r.checks.filter((c) => c.kind.startsWith('page')).every((c) => c.present), 'all page checks present');
});

test('verifySpec pages: a WRONG deployed GUID in the nav literal FAILS the nav check (C1 wrong-GUID)', async () => {
  const read = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL],
    existenceIds: [GP_OVERVIEW, GP_DETAIL],
    manifest: BOTH_MANIFEST,
    sitemap: SITEMAP_OK,
    code: { [GP_OVERVIEW]: NAV_TO('00000000-dead-beef-0000-000000000000') },
  });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && !c.present), 'nav edge must resolve to the ACTUAL target id');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: the correct target id only in a COMMENT (not a nav call site) FAILS the edge (C1 structural oracle)', async () => {
  const read = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL],
    existenceIds: [GP_OVERVIEW, GP_DETAIL],
    manifest: BOTH_MANIFEST,
    sitemap: SITEMAP_OK,
    // GP_DETAIL appears in a comment, the actual nav call has a wrong id → edge fails.
    code: { [GP_OVERVIEW]: `// go to ${GP_DETAIL}\n${NAV_TO('00000000-0000-4000-8000-000000000000')}` },
  });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && !c.present), 'a decoy id in a comment does not satisfy the edge');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a residual PAGEREF_ in deployed nav code FAILS the no-pageref check', async () => {
  const read = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL],
    existenceIds: [GP_OVERVIEW, GP_DETAIL],
    manifest: BOTH_MANIFEST,
    sitemap: SITEMAP_OK,
    code: { [GP_OVERVIEW]: NAV_TO('PAGEREF_detail') },
  });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-no-pageref' && !c.present));
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a page missing from existence FAILS the page check', async () => {
  const read = pageRead({
    sitemapIds: [GP_DETAIL],       // GP_OVERVIEW not in sitemap
    existenceIds: [GP_DETAIL],     // GP_OVERVIEW not in existence
    manifest: BOTH_MANIFEST,
    sitemap: `<SiteMap><Area><Group><SubArea GenPageId="${GP_DETAIL}"/></Group></Area></SiteMap>`,
    code: {},
  });
  const r = await verifySpec(pageSpec([]), read); // no nav to keep test focused
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && !c.present));
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: the sitemap subarea check matches the GenPageId attribute ONLY (a decoy attr does not satisfy it)', async () => {
  // GP_OVERVIEW is in sitemapIds (membership says it is placed) but the raw XML has it only in a
  // DECOY Url attribute, not a GenPageId attribute — subareaHasGenPage(xml, GP_OVERVIEW) fails.
  const sitemap = `<SiteMap><Area><Group><SubArea Id="s1" Url="${GP_OVERVIEW}"/><SubArea Id="s2" GenPageId="${GP_DETAIL}"/></Group></Area></SiteMap>`;
  const read = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL],
    existenceIds: [GP_OVERVIEW, GP_DETAIL],
    manifest: BOTH_MANIFEST,
    sitemap,
    code: { [GP_OVERVIEW]: NAV_TO(GP_DETAIL) },
  });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-subarea' && c.name === 'Overview' && !c.present), 'only a GenPageId="…" binding counts');
});

test('verifySpec pages: FAIL-CLOSED + unableToRun when the reader lacks page-authority methods (C6/Imp7)', async () => {
  // A reader without sitemapPageIds/existenceIds/manifest means the verifier is unable to run — this
  // must yield r.unableToRun===true (distinct from a reader that has authorities but finds a page missing).
  const read = {
    findTable: async () => ({ logicalName: 'contoso_item' }),
    findColumns: async () => [],
    queryRecords: async () => [],
    sitemapXml: async () => '',
  }; // NO sitemapPageIds, existenceIds, manifest
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-verify' && !c.present), 'a page-bearing spec with no page reader must fail, not silently pass');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.unableToRun, true, 'unableToRun must be true for reader-incapacity (distinct from ordinary miss)');
});

test('verifySpec pages: ordinary miss (reader has authorities but page absent from existence) has unableToRun falsy', async () => {
  // Distinct from reader-incapacity: the reader CAN supply all three authorities but the pages are absent.
  // ok:false but unableToRun is NOT set (it is an ordinary failed check, not a capacity gap).
  const read = pageRead({
    sitemapIds: [],
    existenceIds: [],  // pages not in existence
    manifest: BOTH_MANIFEST,
    sitemap: '',
    code: {},
  });
  const r = await verifySpec(pageSpec([]), read);
  assert.strictEqual(r.ok, false);
  assert.ok(!r.unableToRun, 'ordinary miss (authorities available but pages absent) must NOT set unableToRun');
});

// ---------------------------------------------------------------------------
// NEW Task 7 tests: name≠title match, page-not-in-existence, page-not-in-sitemap,
// empty manifest → unableToRun, page-extra set-equality, caching (Imp7).
// ---------------------------------------------------------------------------

test('verifySpec pages: name≠title page matched by id (spec name does not need to match sitemap title)', async () => {
  // The spec names the page "My Orders Overview" but the sitemap title is "Overview Title Differs".
  // With three-authority id matching this is irrelevant — the manifest maps key→id and we match by id.
  const spec = {
    entities: [],
    schemaVersion: 2,
    pages: [{ key: 'overview', name: 'My Orders Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview Title Differs' }] }] }] },
  };
  const xml = `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}" Title="Overview Title Differs"/></Group></Area></SiteMap>`;
  const read = pageRead({
    sitemapIds: [GP_OVERVIEW],
    existenceIds: [GP_OVERVIEW],
    manifest: { schemaVersion: 1, pages: [{ key: 'overview', name: 'My Orders Overview', pageId: GP_OVERVIEW }] },
    sitemap: xml,
    code: { [GP_OVERVIEW]: 'export default 1;' },
  });
  const r = await verifySpec(spec, read);
  assert.ok(r.checks.find((c) => c.kind === 'page' && c.name === 'My Orders Overview' && c.present), 'page present by id despite spec name != sitemap title');
  assert.ok(r.checks.find((c) => c.kind === 'page-subarea' && c.name === 'My Orders Overview' && c.present), 'placement verified by id in GenPageId attr');
  assert.strictEqual(r.ok, true);
});

test('verifySpec pages: a page whose manifest id is NOT in existence → missing', async () => {
  // GP_OVERVIEW is in the manifest and sitemapIds but NOT in existenceIds (e.g. page was deleted env-wide).
  const read = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL],
    existenceIds: [GP_DETAIL],  // GP_OVERVIEW missing from env-wide existence
    manifest: BOTH_MANIFEST,
    sitemap: SITEMAP_OK,
    code: {},
  });
  const r = await verifySpec(pageSpec([]), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && !c.present), 'page absent from existence → missing');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a page not in the sitemap → missing (placement check, id-based)', async () => {
  // GP_OVERVIEW exists env-wide (in existenceIds) but is NOT in sitemapIds (not placed in this app).
  const read = pageRead({
    sitemapIds: [GP_DETAIL],         // GP_OVERVIEW not placed
    existenceIds: [GP_OVERVIEW, GP_DETAIL],
    manifest: BOTH_MANIFEST,
    sitemap: `<SiteMap><Area><Group><SubArea GenPageId="${GP_DETAIL}"/></Group></Area></SiteMap>`,
    code: {},
  });
  const r = await verifySpec(pageSpec([]), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && !c.present), 'page not in sitemap → page check fails (not placed)');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: empty/absent manifest on a page-bearing spec → unableToRun (Imp7, NOT all-missing)', async () => {
  // Absent manifest (null) → cannot correlate any spec page to a deployed id → unableToRun.
  const readNull = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL],
    existenceIds: [GP_OVERVIEW, GP_DETAIL],
    manifest: null,  // absent
    sitemap: SITEMAP_OK,
    code: {},
  });
  const r = await verifySpec(pageSpec([]), readNull);
  assert.strictEqual(r.unableToRun, true, 'null manifest → unableToRun (page-identity)');
  assert.ok(!r.checks.some((c) => c.kind === 'page' && c.present === false), 'no false "page missing" checks when manifest absent');

  // Empty manifest (pages:[]) → no key→id mappings → same result.
  const readEmpty = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL],
    existenceIds: [GP_OVERVIEW, GP_DETAIL],
    manifest: { schemaVersion: 1, pages: [] },  // present but no entries
    sitemap: SITEMAP_OK,
    code: {},
  });
  const r2 = await verifySpec(pageSpec([]), readEmpty);
  assert.strictEqual(r2.unableToRun, true, 'empty manifest → unableToRun (page-identity)');
});

test('verifySpec pages: an extra live sitemap page not in the spec → page-extra (set-equality, Imp7)', async () => {
  // sitemapIds includes GP_EXTRA which is not referenced by any spec page → page-extra.
  const read = pageRead({
    sitemapIds: [GP_OVERVIEW, GP_DETAIL, GP_EXTRA],
    existenceIds: [GP_OVERVIEW, GP_DETAIL, GP_EXTRA],
    manifest: BOTH_MANIFEST,  // only overview and detail in spec/manifest
    sitemap: `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}"/><SubArea GenPageId="${GP_DETAIL}"/><SubArea GenPageId="${GP_EXTRA}"/></Group></Area></SiteMap>`,
    code: {},
  });
  const r = await verifySpec(pageSpec([]), read); // no nav to focus on page-extra
  assert.ok(r.checks.some((c) => c.kind === 'page-extra' && !c.present), 'the unmatched live page GP_EXTRA is reported');
  assert.ok(r.checks.some((c) => c.kind === 'page-extra' && !c.present && c.name === GP_EXTRA), 'extra page reported by id');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: each reader method called exactly once (caching, Imp7)', async () => {
  let sitemapCalls = 0;
  let existenceCalls = 0;
  let manifestCalls = 0;
  const read = {
    findTable: async () => ({ logicalName: 'contoso_item' }),
    findColumns: async () => [],
    queryRecords: async () => [],
    sitemapXml: async () => SITEMAP_OK,
    sitemapPageIds: async () => { sitemapCalls++; return [GP_OVERVIEW, GP_DETAIL]; },
    existenceIds: async () => { existenceCalls++; return [GP_OVERVIEW, GP_DETAIL]; },
    manifest: async () => { manifestCalls++; return BOTH_MANIFEST; },
    pageCode: async () => '',
  };
  // Two pages, no nav — verifySpec should call each authority method exactly once.
  await verifySpec(pageSpec([]), read);
  assert.strictEqual(sitemapCalls, 1, 'sitemapPageIds called exactly once');
  assert.strictEqual(existenceCalls, 1, 'existenceIds called exactly once');
  assert.strictEqual(manifestCalls, 1, 'manifest called exactly once');
});

