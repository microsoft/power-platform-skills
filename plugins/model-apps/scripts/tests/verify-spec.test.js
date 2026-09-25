'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { verifySpec, hasElement, parseFetchXml } = require('../lib/verify-spec.js');
const { sitemapXmlFor } = require('../verify-model-app.js');
const { SDK_ROLE_MARKER } = require('../lib/app-spec.js');

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

test('verifySpec reports missing entities without propagating dependent Dataverse read errors', async () => {
  const spec = {
    entities: [{ schemaName: 'new_missing', columns: [] }],
    views: [{ entity: 'new_missing', name: 'Missing View' }],
    appShell: { areas: [] },
  };
  const read = {
    findTable: async () => null,
    findColumns: async () => [],
    queryRecords: async () => {
      throw new Error('HTTP 400 metadata cache: entity was not found');
    },
    sitemapXml: async () => '',
  };

  const r = await verifySpec(spec, read);

  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.kind === 'entity'));
  assert.ok(r.missing.some((m) => m.kind === 'view'));
});

test('verifySpec: a Main form check is type-scoped — a same-named Quick View sibling does NOT satisfy it', async () => {
  const spec = { entities: [], views: [], charts: [], forms: [{ entity: 'zava_javavendor', name: 'Information', formType: 'Main' }], appShell: { areas: [] } };
  let captured;
  const read = {
    findTable: async () => null, findColumns: async () => [],
    // Only a same-named Quick View exists; the type-scoped Main (type 2) query must find nothing.
    queryRecords: async (set, opts) => { if (set === 'systemform') { captured = opts.filter; return /type eq 2/.test(opts.filter) ? [] : [{ formid: 'qv-1' }]; } return []; },
    sitemapXml: async () => '',
  };
  const r = await verifySpec(spec, read);
  assert.match(captured, /objecttypecode eq 'zava_javavendor' and name eq 'Information' and type eq 2/, 'verify scopes the Main form query by type');
  assert.ok(r.missing.some((m) => m.kind === 'form'), 'the Main form is correctly reported MISSING — a same-named Quick View does not count (no false pass)');
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

// ── Content-level verify (F5 scoped): catch a build that reports success while the deployed artifact
// DIFFERS from the spec (edits silently not applied). All best-effort + ADDITIVE — a check only fires
// when the reader supplies the data, so existing existence-only readers are unaffected. ────────────

test('verifySpec: view-columns — a spec view column missing from the deployed layoutxml FAILS (F5)', async () => {
  const spec = { entities: [], charts: [], forms: [],
    views: [{ entity: 'new_o', name: 'V', columns: ['new_name', 'new_status'] }], appShell: { areas: [] } };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    // Deployed view exists but its layoutxml is MISSING new_status (an unapplied column edit).
    queryRecords: async (set) => (set === 'savedquery'
      ? [{ savedqueryid: 'v1', layoutxml: '<grid><row><cell name="new_name"/></row></grid>' }]
      : []),
  };
  const r = await verifySpec(spec, read);
  assert.ok(r.checks.some((c) => c.kind === 'view' && c.present), 'the view exists (existence check still passes)');
  const vc = r.checks.find((c) => c.kind === 'view-columns');
  assert.ok(vc && !vc.present, 'view-columns FAILS because new_status is not in the deployed layoutxml');
  assert.strictEqual(r.ok, false);
});

test('verifySpec: view-columns — passes when every spec column is in the layoutxml (extra deployed cols OK)', async () => {
  const spec = { entities: [], charts: [], forms: [],
    views: [{ entity: 'new_o', name: 'V', columns: ['new_name'] }], appShell: { areas: [] } };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'savedquery'
      ? [{ savedqueryid: 'v1', layoutxml: '<grid><row><cell name="new_name"/><cell name="createdon"/></row></grid>' }]
      : []),
  };
  const r = await verifySpec(spec, read);
  const vc = r.checks.find((c) => c.kind === 'view-columns');
  assert.ok(vc && vc.present, 'all spec columns present -> view-columns passes (a deployed extra column is fine — additive)');
});

test('verifySpec: view-columns check is SKIPPED when the reader gives no layoutxml (existence-only readers unaffected)', async () => {
  const spec = { entities: [], charts: [], forms: [],
    views: [{ entity: 'new_o', name: 'V', columns: ['new_name'] }], appShell: { areas: [] } };
  const read = { findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'savedquery' ? [{ savedqueryid: 'v1' }] : []) };
  const r = await verifySpec(spec, read);
  assert.ok(r.checks.some((c) => c.kind === 'view' && c.present));
  assert.ok(!r.checks.some((c) => c.kind === 'view-columns'), 'no layoutxml -> no view-columns check (best-effort)');
});

// Sort PRECEDENCE decides what a view returns, so proving each authored order merely EXISTS
// somewhere is not proof: a deployed [name asc, createdon desc] would satisfy an authored
// [createdon desc, name asc] under a per-order membership test.
test('verifySpec: view-sort fails when the deployed sort has the authored orders in the WRONG precedence', async () => {
  const spec = { solution: { publisherPrefix: 'new' }, entities: [], charts: [], appShell: { areas: [] }, forms: [],
    views: [{ entity: 'new_ticket', name: 'Ordered', columns: ['new_name'], activeOnly: false,
      sort: [{ attr: 'createdon', dir: 'desc' }, { attr: 'new_name', dir: 'asc' }] }] };
  const fetchxml = '<fetch><entity name="new_ticket">'
    + '<order attribute="new_name" descending="false"/>'
    + '<order attribute="createdon" descending="true"/>'
    + '</entity></fetch>';
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'savedquery'
      ? [{ savedqueryid: 'v1', layoutxml: '<grid><row><cell name="new_name"/></row></grid>', fetchxml }]
      : []),
  };

  const r = await verifySpec(spec, read);
  const c = r.checks.find((x) => x.kind === 'view-sort');
  assert.ok(c, 'a view-sort check must be emitted');
  assert.strictEqual(c.present, false, 'reversed precedence must not pass');
  assert.match(c.detail, /precedence/i);
});

test('verifySpec: view-sort passes when the authored orders keep their relative order among extras', async () => {
  const spec = { solution: { publisherPrefix: 'new' }, entities: [], charts: [], appShell: { areas: [] }, forms: [],
    views: [{ entity: 'new_ticket', name: 'Ordered', columns: ['new_name'], activeOnly: false,
      sort: [{ attr: 'createdon', dir: 'desc' }, { attr: 'new_name', dir: 'asc' }] }] };
  // A platform-owned order appended after the authored ones must still pass (subset semantics).
  const fetchxml = '<fetch><entity name="new_ticket">'
    + '<order attribute="createdon" descending="true"/>'
    + '<order attribute="new_name" descending="false"/>'
    + '<order attribute="modifiedon" descending="true"/>'
    + '</entity></fetch>';
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'savedquery'
      ? [{ savedqueryid: 'v1', layoutxml: '<grid><row><cell name="new_name"/></row></grid>', fetchxml }]
      : []),
  };

  const r = await verifySpec(spec, read);
  const c = r.checks.find((x) => x.kind === 'view-sort');
  assert.ok(c && c.present === true, `authored precedence preserved must pass; got ${JSON.stringify(c)}`);
});

test('verifySpec: default-form — the selected Main form must read back systemform.isdefault=true', async () => {
  // The owning table must be declared, and declared as one this solution OWNS: the build only
  // promotes a default form for its own custom tables, so verify only asserts it for those.
  const spec = { solution: { publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket', columns: [] }], views: [], charts: [], appShell: { areas: [] },
    forms: [
      { entity: 'new_ticket', name: 'Agent Form', formType: 'Main' },
      { entity: 'new_ticket', name: 'Manager Form', formType: 'Main', isDefault: true },
    ] };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set, opts) => {
      if (set !== 'systemform') return [];
      if (/name eq 'Agent Form'/.test(opts.filter)) return [{ formid: 'agent-form-id' }];
      if (/name eq 'Manager Form'/.test(opts.filter)) return [{ formid: 'manager-form-id' }];
      return [];
    },
    formDefaultState: async (entity, formId) => ({ isDefault: formId === 'agent-form-id' }),
  };

  const r = await verifySpec(spec, read);

  assert.ok(r.checks.some((c) => c.kind === 'form' && c.name === 'Manager Form' && c.present), 'the selected form exists');
  const c = r.checks.find((x) => x.kind === 'form-default' && x.name === 'new_ticket.Manager Form');
  assert.ok(c && c.present === false, 'the actual isdefault flag, not form existence, decides the default-form check');
  assert.match(c.detail, /isdefault is false/);
  assert.strictEqual(r.ok, false);
});

// The build refuses to re-point the default form of a reused or stock table (sdk-build.js
// `isOwnCustomTable`) because that is an environment-wide side effect on a table the spec does not
// own. A verifier that asserts `isdefault` anyway makes --verify permanently unsatisfiable: the
// author is told the build failed to do something it deliberately never attempts.
test('verifySpec: no default-form check is emitted for a reused or stock table the build never promotes', async () => {
  const spec = { solution: { publisherPrefix: 'new' },
    entities: [{ schemaName: 'account', existing: true, columns: [] }, { schemaName: 'new_ticket', columns: [] }],
    views: [], charts: [], appShell: { areas: [] },
    forms: [
      { entity: 'account', name: 'Account Main', formType: 'Main' },
      { entity: 'new_ticket', name: 'Ticket Main', formType: 'Main' },
    ] };
  const read = {
    findTable: async (l) => ({ logicalName: l }), findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set, opts) => {
      if (set !== 'systemform') return [];
      if (/name eq 'Account Main'/.test(opts.filter)) return [{ formid: 'account-form-id' }];
      if (/name eq 'Ticket Main'/.test(opts.filter)) return [{ formid: 'ticket-form-id' }];
      return [];
    },
    // Dataverse's own stock Account form holds the default slot, so the reused table reads false.
    formDefaultState: async (entity, formId) => ({ isDefault: formId === 'ticket-form-id' }),
  };

  const r = await verifySpec(spec, read);

  assert.ok(!r.checks.some((c) => c.kind === 'form-default' && /^account\./.test(c.name)),
    'a reused table must not be asserted to hold the default form');
  assert.ok(r.checks.some((c) => c.kind === 'form-default' && c.name === 'new_ticket.Ticket Main' && c.present),
    "the solution's own custom table is still checked");
});

test('verifySpec: default-form check is reader-gated for existence-only callers', async () => {  const spec = { entities: [], views: [], charts: [], appShell: { areas: [] },
    forms: [{ entity: 'new_ticket', name: 'Agent Form', formType: 'Main', isDefault: true }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'systemform' ? [{ formid: 'agent-form-id' }] : []),
  };

  const r = await verifySpec(spec, read);

  assert.ok(r.checks.some((c) => c.kind === 'form' && c.present));
  assert.ok(!r.checks.some((c) => c.kind === 'form-default'), 'no formDefaultState reader -> no content check');
  assert.strictEqual(r.ok, true);
});

test('verifySpec: view-filters — every authored condition must be present in deployed fetchxml', async () => {
  const spec = { entities: [], charts: [], forms: [], appShell: { areas: [] },
    views: [{ entity: 'new_ticket', name: 'My Open', columns: ['new_subject'], activeOnly: true,
      filters: [
        { attr: 'ownerid', op: 'eq-userid' },
        { attr: 'new_priority', op: 'not-in', values: ['100000000'] },
        { attr: 'modifiedon', op: 'this-week' },
      ],
      sort: [{ attr: 'createdon', dir: 'desc' }] }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'savedquery' ? [{
      savedqueryid: 'v1',
      layoutxml: '<grid><row><cell name="new_subject"/></row></grid>',
      fetchxml: '<fetch><entity name="new_ticket"><attribute name="new_subject"/>' +
        '<filter type="and"><condition attribute="statecode" operator="eq" value="0"/>' +
        '<condition attribute="ownerid" operator="eq-userid"/>' +
        '<condition attribute="modifiedon" operator="this-week"/>' +
        '<filter type="and"><condition attribute="new_priority" operator="ne" value="100000000"/></filter>' +
        '</filter><order attribute="createdon" descending="true"/></entity></fetch>',
    }] : []),
  };

  const r = await verifySpec(spec, read);

  assert.ok(r.checks.some((c) => c.kind === 'view-filters' && c.present), JSON.stringify(r.missing));
  assert.ok(r.checks.some((c) => c.kind === 'view-sort' && c.present), JSON.stringify(r.missing));
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
});

test('verifySpec: view-filters — value-less operators missing value are correct, missing operator is a failure', async () => {
  const spec = { entities: [], charts: [], forms: [], appShell: { areas: [] },
    views: [{ entity: 'new_ticket', name: 'This Week', columns: ['new_subject'], activeOnly: false,
      filters: [{ attr: 'modifiedon', op: 'this-week' }] }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'savedquery' ? [{
      savedqueryid: 'v1',
      layoutxml: '<grid><row><cell name="new_subject"/></row></grid>',
      fetchxml: '<fetch><entity name="new_ticket"><filter><condition attribute="createdon" operator="this-week"/></filter></entity></fetch>',
    }] : []),
  };

  const r = await verifySpec(spec, read);

  const c = r.checks.find((x) => x.kind === 'view-filters');
  assert.ok(c && c.present === false, 'omitting value is fine; the wrong attribute is not');
  assert.match(c.detail, /modifiedon this-week/);
  assert.strictEqual(r.ok, false);
});

test('verifySpec: view-sort — a missing authored order fails without demanding FetchXML byte equality', async () => {
  const spec = { entities: [], charts: [], forms: [], appShell: { areas: [] },
    views: [{ entity: 'new_ticket', name: 'Sorted', columns: ['new_subject'], activeOnly: false,
      sort: [{ attr: 'createdon', dir: 'desc' }] }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'savedquery' ? [{
      savedqueryid: 'v1',
      layoutxml: '<grid><row><cell name="new_subject"/></row></grid>',
      fetchxml: '<fetch><entity name="new_ticket"><filter><condition attribute="ownerid" operator="eq-userid"/></filter><order attribute="new_subject" descending="false"/></entity></fetch>',
    }] : []),
  };

  const r = await verifySpec(spec, read);

  assert.ok(!r.checks.some((c) => c.kind === 'view-filters'), 'platform-added undeclared filters are tolerated');
  const c = r.checks.find((x) => x.kind === 'view-sort');
  assert.ok(c && c.present === false);
  assert.match(c.detail, /createdon desc/);
  assert.strictEqual(r.ok, false);
});

test('verifySpec: view-filters fail closed when the reader supplied an unreadable fetchxml value', async () => {
  const spec = { entities: [], charts: [], forms: [], appShell: { areas: [] },
    views: [{ entity: 'new_ticket', name: 'Mine', columns: ['new_subject'], activeOnly: false,
      filters: [{ attr: 'ownerid', op: 'eq-userid' }] }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'savedquery' ? [{
      savedqueryid: 'v1',
      layoutxml: '<grid><row><cell name="new_subject"/></row></grid>',
      fetchxml: null,
    }] : []),
  };

  const r = await verifySpec(spec, read);

  const c = r.checks.find((x) => x.kind === 'view-filters');
  assert.ok(c && c.present === false);
  assert.match(c.detail, /could not read deployed savedquery.fetchxml/);
  assert.strictEqual(r.ok, false);
});

test('verifySpec: app-role association — app access personas must be linked to the app module', async () => {
  const spec = {
    entities: [{ schemaName: 'new_ticket', columns: [] }],
    views: [], charts: [], forms: [], appShell: { areas: [] },
    personas: [
      { persona: 'Agent', jobs: [{ name: 'work', privileges: [{ entity: 'new_ticket', access: ['read'] }] }] },
      { persona: 'Auditor', appAccess: false, jobs: [{ name: 'audit', privileges: [{ entity: 'new_ticket', access: ['read'] }] }] },
    ],
  };
  const read = {
    findTable: async () => ({ logicalName: 'new_ticket' }),
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set, opts) => {
      if (set === 'businessunit') return [{ businessunitid: '00000000-0000-0000-0000-000000000001' }];
      if (set === 'role' && /Agent/.test(opts.filter)) return [{ roleid: 'role-agent', description: SDK_ROLE_MARKER, ismanaged: false }];
      if (set === 'role' && /Auditor/.test(opts.filter)) return [{ roleid: 'role-auditor', description: SDK_ROLE_MARKER, ismanaged: false }];
      return [];
    },
    appRoleIds: async () => ({ ok: true, roleIds: ['role-other'] }),
  };

  const r = await verifySpec(spec, read);

  const c = r.checks.find((x) => x.kind === 'app-role' && x.name === 'Agent');
  assert.ok(c && c.present === false, 'existing role is not enough; the actual association row must exist');
  assert.ok(!r.checks.some((x) => x.kind === 'app-role' && x.name === 'Auditor'), 'appAccess:false personas should not require an app association');
  assert.strictEqual(r.ok, false);
});

test('verifySpec: app-role association read failures fail closed', async () => {
  const spec = {
    entities: [{ schemaName: 'new_ticket', columns: [] }],
    views: [], charts: [], forms: [], appShell: { areas: [] },
    personas: [{ persona: 'Agent', jobs: [{ name: 'work', privileges: [{ entity: 'new_ticket', access: ['read'] }] }] }],
  };
  const read = {
    findTable: async () => ({ logicalName: 'new_ticket' }),
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'businessunit'
      ? [{ businessunitid: '00000000-0000-0000-0000-000000000001' }]
      : [{ roleid: 'role-agent', description: SDK_ROLE_MARKER, ismanaged: false }]),
    appRoleIds: async () => ({ ok: false, reason: 'HTTP 403' }),
  };

  const r = await verifySpec(spec, read);

  const c = r.checks.find((x) => x.kind === 'app-role');
  assert.ok(c && c.present === false);
  assert.match(c.detail, /could not read.*403/);
  assert.strictEqual(r.ok, false);
});

test('verifySpec: relationship existence — a declared relationship absent from the child metadata FAILS (F5)', async () => {
  const spec = { entities: [{ schemaName: 'new_o' }], views: [], charts: [], forms: [], appShell: { areas: [] },
    relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_o', lookup: { schemaName: 'new_CustomerId' } }] };
  const read = {
    findTable: async () => ({ logicalName: 'new_o' }), findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '',
    // Child entity metadata has NO relationships -> the declared relationship silently didn't build.
    entityRelationships: async () => [],
  };
  const r = await verifySpec(spec, read);
  const rc = r.checks.find((c) => c.kind === 'relationship');
  assert.ok(rc && !rc.present, 'relationship existence FAILS when absent from child metadata');
  assert.strictEqual(r.ok, false);
});

test('verifySpec: relationship check is SKIPPED when the reader cannot list relationships (best-effort)', async () => {
  const spec = { entities: [], views: [], charts: [], forms: [], appShell: { areas: [] },
    relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_o', lookup: { schemaName: 'new_CustomerId' } }] };
  const read = { findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '' };
  const r = await verifySpec(spec, read);
  assert.ok(!r.checks.some((c) => c.kind === 'relationship'), 'no entityRelationships reader -> no relationship check');
});

test('verifySpec: command existence — a declared command bar with no deployed appaction FAILS (F5)', async () => {
  const spec = { entities: [{ schemaName: 'new_o' }], views: [], charts: [], forms: [], appShell: { areas: [] },
    commands: [{ entity: 'new_o', label: 'Escalate', library: 'new_o.js', function: 'X.y' }] };
  const read = {
    findTable: async () => ({ logicalName: 'new_o' }), findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '',
    commandBar: async () => false, // no command bar deployed for the entity
  };
  const r = await verifySpec(spec, read);
  const cc = r.checks.find((c) => c.kind === 'command');
  assert.ok(cc && !cc.present, 'command existence FAILS when no appaction bar exists for the entity');
  assert.strictEqual(r.ok, false);
});

test('verifySpec: command check is SKIPPED when the reader cannot resolve a command bar (best-effort)', async () => {
  const spec = { entities: [], views: [], charts: [], forms: [], appShell: { areas: [] },
    commands: [{ entity: 'new_o', label: 'Escalate', library: 'new_o.js', function: 'X.y' }] };
  const read = { findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '' };
  const r = await verifySpec(spec, read);
  assert.ok(!r.checks.some((c) => c.kind === 'command'), 'no commandBar reader -> no command check');
});

// --- Security persona roles (Group N P1) ---------------------------------------------------

test('verifySpec: an SDK-authored persona role present -> ok', async () => {
  const spec = { entities: [{ schemaName: 'new_o', columns: [] }], personas: [{ persona: 'Agent', jobs: [{ name: 'w', privileges: [{ entity: 'new_o', access: ['read'] }] }] }] };
  const read = {
    findTable: async () => ({ logicalName: 'new_o' }),
    findColumns: async () => [],
    queryRecords: async (set) => (set === 'role' ? [{ roleid: 'r1', description: SDK_ROLE_MARKER, ismanaged: false }] : set === 'businessunit' ? [{ businessunitid: '00000000-0000-0000-0000-000000000001' }] : []),
    sitemapXml: async () => '',
  };
  const r = await verifySpec(spec, read);
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.ok(r.checks.some((c) => c.kind === 'role' && c.name === 'Agent' && c.present));
});

test('verifySpec: a missing persona role (or a foreign same-name role) is a loud fail', async () => {
  const spec = { entities: [{ schemaName: 'new_o', columns: [] }], personas: [{ persona: 'Agent', jobs: [{ name: 'w', privileges: [{ entity: 'new_o', access: ['read'] }] }] }] };
  const read = {
    findTable: async () => ({ logicalName: 'new_o' }),
    findColumns: async () => [],
    // A same-name role NOT authored by the SDK must not satisfy the check (it is not the role we built).
    queryRecords: async (set) => (set === 'businessunit' ? [{ businessunitid: '00000000-0000-0000-0000-000000000001' }] : [{ roleid: 'r2', description: 'hand-built by an admin', ismanaged: false }]),
    sitemapXml: async () => '',
  };
  const r = await verifySpec(spec, read);
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.some((m) => m.kind === 'role' && m.name === 'Agent'));
});


// ── AI app features (ADO 6603383 / 6560699) ────────────────────────────────────────────────────
// verifySpec had NO awareness of spec.ai, so a build whose every requested AI feature was skipped
// (admin gate off) or silently not persisted still reported a clean PASS.
//
// The oracle is the APP-SCOPE OVERRIDE ROW in `appsettings`, NOT the effective value:
// `RetrieveSetting(name, { appUniqueName })` falls back to the ENVIRONMENT value when the app has no
// override, so an effective-value compare passes whenever the environment happens to already hold the
// requested value — a false PASS for an app that was never configured. This mirrors the oracle the
// SDK's own `setAppAiFeatures` uses to populate its `applied` bucket.

const AI_BASE = {
  solution: { uniqueName: 'S', publisherPrefix: 'co' },
  app: { name: 'A', uniqueName: 'co_a' },
  entities: [], views: [], charts: [], forms: [], appShell: { areas: [] },
};
// `overrides` maps the PER-APP setting name -> the value held by its APP-SCOPE override row (present
// key == a row exists). `effective` maps setting name -> what RetrieveSetting reports for the app,
// which includes environment fallback; it defaults to `overrides` and is context only. Note these are
// the app settings, NOT the org readiness gates: nlSearch's gate is the boolean `EnableNLGridSearch`
// but its per-app setting is the numeric `NLGridSearchSetting` — conflating them is what made NL grid
// search silently no-op.
const aiRead = (overrides, effective, opts = {}) => {
  const eff = effective || overrides;
  return {
    findTable: async () => null,
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set, o) => {
      const filter = (o && o.filter) || '';
      if (set === 'appmodule') return opts.noApp ? [] : [{ appmoduleid: 'APPID' }];
      if (set === 'settingdefinition') {
        if (opts.noDef) return [];
        const m = /uniquename eq '([^']+)'/.exec(filter);
        return [{ settingdefinitionid: `DEF-${m && m[1]}` }];
      }
      if (set === 'appsetting') {
        if (opts.proofThrows) throw new Error('403 forbidden');
        const m = /_settingdefinitionid_value eq DEF-(.+)$/.exec(filter);
        const name = m && m[1];
        return Object.prototype.hasOwnProperty.call(overrides, name) ? [{ value: overrides[name] }] : [];
      }
      return [];
    },
    retrieveSetting: async (name) => ({ value: eff[name], dataType: opts.dataType }),
  };
};
const ALL_ON = { formFill: true, nlSearch: true, nlChart: true, m365: true };
// The AI form-fill family does not use 1/0: 0 = platform default, 1 = DISABLED, 2 = ENABLED
// (SDK SETTING_CODEC, mirroring the admin UI). An ENABLED override therefore holds '2'.
const ALL_SETTINGS_ON = {
  FormFillBarUXEnabled: '2',
  NLGridSearchSetting: '1',
  NLChartDataVisualizationSetting: '1',
  m365copilotmodelappenabled: '1',
};
// The overrides a DEFAULT build writes: `resolveAiFlags` seeds formFill/nlSearch/nlChart on and
// m365 off for any spec carrying `ai`, and verify reconciles that whole set — so a test focusing on
// ONE feature must still satisfy the other three or it is asserting on unrelated misses.
const DEFAULT_SETTINGS = {
  FormFillBarUXEnabled: '2',
  NLGridSearchSetting: '1',
  NLChartDataVisualizationSetting: '1',
  m365copilotmodelappenabled: '0',
};
const aiMissing = (r, feature) => r.missing.find((m) => m.kind === 'ai-feature' && m.name === feature);
// The override proof retries the ABSENT case with real backoff; these tests drive that path
// constantly, so they opt out of the delay. Retry BEHAVIOUR has its own dedicated test below.
const verifyAi = (spec, read) => verifySpec(spec, read, { proofDelayMs: 0 });

test('verifySpec: requested AI features that are NOT in effect fail verify (no more false PASS)', async () => {
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: ALL_ON } }, aiRead({}));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.missing.filter((m) => m.kind === 'ai-feature').length, 4);
});

test('verifySpec: AI features in effect verify clean', async () => {
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: ALL_ON } }, aiRead(ALL_SETTINGS_ON));
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.strictEqual(r.checks.filter((c) => c.kind === 'ai-feature' && c.present).length, 4);
});

test('verifySpec: an ENV-fallback value that matches the request is NOT a pass (no app override)', async () => {
  // The regression this oracle exists for: RetrieveSetting at app scope returns the ENVIRONMENT value
  // when the app has no override. Every requested feature reads back exactly as requested, yet the app
  // itself was never configured — an effective-value compare reported PASS for a build the SDK itself
  // classified as notPersisted/skipped.
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: ALL_ON } }, aiRead({}, ALL_SETTINGS_ON));
  assert.strictEqual(r.ok, false, 'env fallback must not satisfy an app-scope request');
  assert.strictEqual(r.missing.filter((m) => m.kind === 'ai-feature').length, 4);
  assert.match(r.missing.find((m) => m.kind === 'ai-feature').detail, /NO app-scope override/);
  // The effective value is still reported, as context for the maker.
  assert.match(r.missing.find((m) => m.kind === 'ai-feature').detail, /environment fallback/);
});

test('verifySpec: reads the PER-APP setting, not the org readiness gate, for nlSearch', async () => {
  // Only the ORG gate is on; the per-app setting has no override. Verify must NOT pass.
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: { nlSearch: true } } }, aiRead({ ...DEFAULT_SETTINGS, NLGridSearchSetting: undefined, EnableNLGridSearch: 'true' }));
  assert.strictEqual(r.ok, false);
  assert.match(aiMissing(r, 'nlSearch').detail, /NLGridSearchSetting/);
});

test('verifySpec: an explicit numeric AI value (2 = on for everyone) is compared verbatim', async () => {
  const want2 = { ...AI_BASE, ai: { appFeatures: { formFill: 2 } } };
  const mismatch = await verifyAi(want2, aiRead({ ...DEFAULT_SETTINGS, FormFillBarUXEnabled: '1' }));
  assert.strictEqual(mismatch.ok, false, 'requested 2 but the override holds 1 must fail');
  assert.match(aiMissing(mismatch, 'formFill').detail, /requested '2'/);
  const match = await verifyAi(want2, aiRead({ ...DEFAULT_SETTINGS, FormFillBarUXEnabled: '2' }));
  assert.strictEqual(match.ok, true, JSON.stringify(match.missing));
});

test('verifySpec: an explicit OFF request is verified against 0, not treated as dont-care', async () => {
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: { formFill: false } } }, aiRead({ ...DEFAULT_SETTINGS, FormFillBarUXEnabled: '2' }));
  assert.strictEqual(r.ok, false);
  // An explicit disable is still WRITTEN (disabling is never gated), so the override must hold '0'.
  // OFF for this family is '1' (DISABLED). '0' would be the platform default — deliberately NOT
  // accepted as off, because it defers to flighting rather than turning the feature off.
  const ok = await verifyAi({ ...AI_BASE, ai: { appFeatures: { formFill: false } } }, aiRead({ ...DEFAULT_SETTINGS, FormFillBarUXEnabled: '1' }));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.missing));
});

test('verifySpec: an unreadable override row fails CLOSED (cannot prove => not present)', async () => {
  // We could look and looking failed, so we must not claim PASS on the strength of an effective value
  // that may simply be the environment default — even though it matches the request here.
  const read = aiRead({ FormFillBarUXEnabled: '1' }, { FormFillBarUXEnabled: '1' }, { proofThrows: true });
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: { formFill: true } } }, read);
  assert.strictEqual(r.ok, false);
  assert.match(r.missing.find((m) => m.kind === 'ai-feature').detail, /could not prove/);
  assert.match(r.missing.find((m) => m.kind === 'ai-feature').detail, /403 forbidden/);
});

test('verifySpec: an unresolvable app module fails CLOSED rather than proving against the wrong app', async () => {
  const read = aiRead(ALL_SETTINGS_ON, ALL_SETTINGS_ON, { noApp: true });
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: { formFill: true } } }, read);
  assert.strictEqual(r.ok, false);
  assert.match(r.missing.find((m) => m.kind === 'ai-feature').detail, /no app module with unique name 'co_a'/);
});

test('verifySpec: a spec with ai but NO appFeatures still verifies every feature the build writes', async () => {
  // DR-P1-SK-001 / DR-P1-AR-001: the build seeds a default for EVERY feature whenever `spec.ai`
  // exists, but verify used to iterate `spec.ai.appFeatures` — so `{ ai: { summaries: {...} } }`
  // had three features written and ZERO verified, and `--verify` reported a clean PASS for features
  // the platform may never have stored. That is ADO 6603383 surviving in the shipped artifact.
  const spec = { ...AI_BASE, ai: { summaries: { default: 'auto' } } };
  const none = await verifyAi(spec, aiRead({}));
  assert.strictEqual(none.checks.filter((c) => c.kind === 'ai-feature').length, 4, 'all four defaults are reconciled');
  assert.strictEqual(none.ok, false, 'unwritten defaults must fail verify');
  // ...and the same spec passes once the defaults really are in place (m365 defaults OFF).
  const ok = await verifyAi(spec, aiRead(DEFAULT_SETTINGS));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.missing));
});

test('verifySpec: an undeclared feature is still checked when the spec declares only one', async () => {
  // The partial-declaration half of the same hole: `{ appFeatures: { m365: true } }` still causes
  // the build to write formFill/nlSearch/nlChart.
  const spec = { ...AI_BASE, ai: { appFeatures: { m365: true } } };
  const r = await verifyAi(spec, aiRead({ m365copilotmodelappenabled: '1' }));
  assert.strictEqual(r.checks.filter((c) => c.kind === 'ai-feature').length, 4);
  assert.ok(aiMissing(r, 'formFill'), 'the undeclared formFill default is reconciled');
  assert.strictEqual(r.ok, false);
});

test('verifySpec: an override row that appears late is retried, not reported as a false FAIL', async () => {
  // Observed live: an override row can lag briefly behind the write that created it (the SDK
  // reported a feature not persisted on first apply and clean on a re-run, with the value correct
  // all along). Verify gates the build's exit code, so a single read would turn that lag into a
  // false FAIL. Only the ABSENT case is retried — a read ERROR is a different condition.
  let attempts = 0;
  const base = aiRead(DEFAULT_SETTINGS);
  const read = {
    ...base,
    queryRecords: async (set, o) => {
      if (set === 'appsetting') { attempts += 1; if (attempts < 2) return []; }
      return base.queryRecords(set, o);
    },
  };
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: { formFill: true } } }, read);
  assert.ok(attempts > 1, 'the absent read must be retried');
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
});

test('verifySpec: the AI check is reader-gated and absent-spec-safe (existing callers unaffected)', async () => {
  // No ai block at all -> no ai checks.
  const noAi = await verifyAi(AI_BASE, aiRead(ALL_SETTINGS_ON));
  assert.strictEqual(noAi.checks.filter((c) => c.kind === 'ai-feature').length, 0);
  // ai requested but the reader cannot read settings -> skipped, not a false failure.
  const noSupport = { findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '' };
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: ALL_ON } }, noSupport);
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.strictEqual(r.checks.filter((c) => c.kind === 'ai-feature').length, 0);
  // ...and equally when it can read settings but cannot run the override PROOF: the check needs both
  // capabilities, and degrading to the unsound effective-value compare is exactly the false PASS.
  const noQuery = { findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '', retrieveSetting: async () => ({ value: '1' }) };
  const r2 = await verifyAi({ ...AI_BASE, ai: { appFeatures: ALL_ON } }, noQuery);
  assert.strictEqual(r2.checks.filter((c) => c.kind === 'ai-feature').length, 0);
});

test('verifySpec: AI settings are read at the APP scope the BUILD wrote under, not the env scope', () => {
  // Regression guard for a false PASS: when a spec carries no explicit app.uniqueName (neither shipped
  // sample does), reading `spec.app.uniqueName` yields undefined, the SDK then omits the AppUniqueName
  // path segment, and RetrieveSetting returns the ENVIRONMENT value. Comparing that against the request
  // can pass while the app itself has the feature off. The identity must be `appUniqueName(spec)`.
  const seen = [];
  const appFilters = [];
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'Project Tracker' },            // <- no uniqueName, like the real samples
    entities: [], views: [], charts: [], forms: [], appShell: { areas: [] },
    ai: { appFeatures: { formFill: true } },
  };
  const base = aiRead(DEFAULT_SETTINGS);
  const read = {
    ...base,
    queryRecords: async (set, o) => {
      if (set === 'appmodule') appFilters.push(o.filter);
      return base.queryRecords(set, o);
    },
    retrieveSetting: async (name, opts) => { seen.push({ name, opts }); return { value: '1' }; },
  };
  return verifyAi(spec, read).then((r) => {
    assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
    // Every feature the BUILD writes is reconciled, not only the one the spec named — the build
    // seeds defaults for all four, so checking fewer would leave the rest silently unverified.
    assert.strictEqual(seen.length, 4);
    for (const s of seen) {
      // Same derivation the build uses for setAppAiFeatures: `<publisherPrefix>_<app.name>` sanitized.
      assert.strictEqual(s.opts.appUniqueName, 'new_projecttracker');
    }
    // ...and the override proof must resolve THE SAME app, or it would prove against another app.
    assert.ok(appFilters.length >= 1);
    for (const f of appFilters) assert.strictEqual(f, "uniquename eq 'new_projecttracker'");
  });
});

test('verifySpec: a Boolean-spelled override value compares as on/off, independent of any dataType read', () => {
  // Dataverse dataType 2 == Boolean, whose value is the string 'true'/'false'. An exact '1' compare
  // would report a genuinely-enabled feature as not-in-effect (a false FAIL on a correct build).
  // The normalization is deliberately UNCONDITIONAL: branching on a `dataType` read made the
  // authoritative comparison depend on a second request that can fail independently, so a transport
  // error on that read silently flipped a correctly-applied feature to FAIL.
  // Requested on nlSearch, not formFill: this asserts that a Boolean SPELLING of the stored value is
  // reconciled with the requested one, and that only makes sense for a setting whose on/off really
  // is 1/0. The form-fill family is a 0/1/2 enum (0 = platform default, 1 = disabled, 2 = enabled)
  // and never stores 'true'/'false', so pointing this at formFill would assert a shape the platform
  // cannot produce — and, with the request and the stub naming different settings, it could pass or
  // fail for reasons unrelated to the normalisation under test.
  const spec = { ...AI_BASE, ai: { appFeatures: { nlSearch: true } } };
  return verifyAi(spec, aiRead({ ...DEFAULT_SETTINGS, NLGridSearchSetting: 'true' })).then(async (on) => {
    assert.strictEqual(on.ok, true, JSON.stringify(on.missing));
    const off = await verifyAi(spec, aiRead({ ...DEFAULT_SETTINGS, NLGridSearchSetting: 'false' }));
    assert.strictEqual(off.ok, false, 'a Boolean-spelled setting reading false must still fail');
  });
});

test('verifySpec: a failing context read cannot flip a proven feature to FAIL', () => {
  // Regression guard: `retrieveSetting` is context only. When the override row proves the feature,
  // a throwing context read must not change the verdict (it previously supplied `dataType`, which
  // silently decided the comparison).
  const spec = { ...AI_BASE, ai: { appFeatures: { formFill: true } } };
  const read = { ...aiRead({ ...DEFAULT_SETTINGS }), retrieveSetting: async () => { throw new Error('429 too many requests'); } };
  return verifyAi(spec, read).then((r) => {
    assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  });
});

// #583: the routing description is asserted only when the spec sets one, against the row's own
// `appmodule.aiappdescription`, found by the identity the build wrote under.
test('#583 verify checks the deployed routing description when the spec sets one', async () => {
  const base = { solution: { publisherPrefix: 'new' }, app: { name: 'Ops', uniqueName: 'new_ops' } };
  const withRouting = { ...base, app: { ...base.app, aiDescription: 'Route ops work here.' } };
  const reader = (rows, fail) => ({
    sitemapXml: async () => '',
    queryRecords: async (set, o) => {
      if (set !== 'appmodule') return [];
      if (fail) throw new Error('read denied');
      assert.match(o.filter, /uniquename eq 'new_ops'/, 'read by the identity the build wrote under');
      return rows;
    },
  });
  const check = async (spec, read) => (await verifySpec(spec, read)).checks.find((c) => c.kind === 'app-ai-description');

  assert.strictEqual((await check(withRouting, reader([{ aiappdescription: 'Route ops work here.' }]))).present, true);
  for (const [what, read, re] of [
    ['a different value', reader([{ aiappdescription: 'Other text' }]), /differs from the spec/],
    ['no value', reader([{ aiappdescription: null }]), /no routing description/],
    ['no app', reader([]), /no app module with unique name 'new_ops'/],
    ['an unreadable row', reader([], true), /could not read the app's routing description: read denied/],
  ]) {
    const c = await check(withRouting, read);
    assert.strictEqual(c.present, false, what);
    assert.match(c.detail, re, what);
  }
  assert.strictEqual(await check(base, reader([{ aiappdescription: 'Written by the platform.' }])), undefined,
    'nothing is asserted when the spec leaves it to the platform');
});

// ---------------------------------------------------------------------------
// App-module TABLE (type-1) membership.
// ---------------------------------------------------------------------------

// A spec whose sitemap shows two tables.
function membershipSpec() {
  return {
    entities: [{ schemaName: 'new_order', columns: [] }, { schemaName: 'new_line', columns: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'R', subAreas: [
      { entity: 'new_order', title: 'Orders' },
      { entity: 'new_line', title: 'Lines' },
    ] }] }] },
  };
}
function membershipRead(appEntityComponents) {
  return {
    findTable: async (l) => ({ logicalName: l }),
    findColumns: async () => [],
    queryRecords: async () => [],
    sitemapXml: async () => '<SiteMap><Area><Group><SubArea Entity="new_order"/><SubArea Entity="new_line"/></Group></Area></SiteMap>',
    ...(appEntityComponents ? { appEntityComponents } : {}),
  };
}
const checkFor = (res, name) => res.checks.find((c) => c.kind === 'app-table-component' && c.name === name);

test('app table membership: verify FAILS when a sitemap-visible table is absent from the app module components', async () => {
  // The reported failure was invisible precisely because verify passed: it confirmed the table
  // EXISTS and that the sitemap names it, but never that the app module actually CONTAINS it. An app
  // can show a table in navigation while omitting it from its Tables list, which is an internally
  // inconsistent definition and breaks consumers that read app-module membership.
  const res = await verifySpec(membershipSpec(), membershipRead(async () => ({ ok: true, present: ['new_order'] })));
  assert.strictEqual(checkFor(res, 'new_order').present, true);
  const missing = checkFor(res, 'new_line');
  assert.ok(missing && missing.present === false, 'the absent table must be reported by name');
  assert.strictEqual(res.ok, false, 'verify must NOT pass while a sitemap table is missing from the app');
});

test('app table membership: verify passes when every sitemap table is a real app component', async () => {
  const res = await verifySpec(membershipSpec(), membershipRead(async () => ({ ok: true, present: ['new_order', 'NEW_LINE'] })));
  // Case-insensitive: Dataverse does not guarantee the casing of a resolved logical name.
  assert.strictEqual(checkFor(res, 'new_line').present, true);
  assert.ok(res.checks.filter((c) => c.kind === 'app-table-component').every((c) => c.present));
});

test('app table membership: an invalid `entity` placeholder component is reported', async () => {
  // The known corruption: a table pinned as an `entity` INSTANCE pins the `entity` metadata table
  // itself, so the component resolves to the logical name `entity` rather than to a real table.
  // Those rows are junk and accumulate, so name them even when every declared table is present.
  const res = await verifySpec(membershipSpec(), membershipRead(async () => ({ ok: true, present: ['new_order', 'new_line'], placeholder: true })));
  const bad = res.checks.find((c) => c.kind === 'app-table-component' && /placeholder/i.test(c.name));
  assert.ok(bad && bad.present === false, 'the `entity` placeholder must be reported');
  assert.strictEqual(res.ok, false);
});

test('app table membership: an unreadable component list FAILS CLOSED rather than passing silently', async () => {
  // "We could not look" must never read as "the app is fine" — that is the exact shape of the bug.
  const res = await verifySpec(membershipSpec(), membershipRead(async () => ({ ok: false, reason: 'HTTP 403' })));
  const c = res.checks.find((x) => x.kind === 'app-table-component');
  assert.ok(c && c.present === false && /403/.test(c.detail), 'the reason must travel with the failure');
  assert.strictEqual(res.ok, false);
});

test('app table membership: a reader without the capability is skipped, not crashed', async () => {
  // verify-spec is also used with minimal readers; an optional capability must never become a
  // TypeError for them (the established rule for columnVisualization).
  const res = await verifySpec(membershipSpec(), membershipRead(null));
  assert.deepStrictEqual(res.checks.filter((c) => c.kind === 'app-table-component'), []);
  assert.strictEqual(res.ok, true);
});

test('app table membership: only SITEMAP-visible tables are required to be components', async () => {
  // A spec entity with no subarea is a legitimate data-model-only table (the build does not pin it),
  // so requiring it would fail every app that declares a supporting table.
  const spec = membershipSpec();
  spec.entities.push({ schemaName: 'new_audit', columns: [] });
  const res = await verifySpec(spec, membershipRead(async () => ({ ok: true, present: ['new_order', 'new_line'] })));
  assert.strictEqual(checkFor(res, 'new_audit'), undefined, 'a table with no subarea must not be required');
  assert.ok(res.checks.filter((c) => c.kind === 'app-table-component').every((c) => c.present));
});

// --- parseFetchXml scoping and multi-operand conditions ---------------------------------------
//
// This parser is a verifier ORACLE, so a false PASS is its worst failure: it would report that a
// deployed view filters the way the spec says when it does not.

// FetchXML puts a joined table's predicates inside <link-entity>. Collecting conditions from the
// whole document let a condition on the JOINED table satisfy an authored base-entity condition by
// attribute/operator coincidence — the two read identically (`statecode eq 0`) but constrain
// different tables.
test('parseFetchXml ignores conditions and orders that belong to a link-entity', () => {
  const xml = `<fetch><entity name="account">`
    + `<link-entity name="contact"><filter><condition attribute="statecode" operator="eq" value="0"/></filter>`
    + `<order attribute="fullname"/></link-entity></entity></fetch>`;
  const r = parseFetchXml(xml);
  assert.deepStrictEqual(r.conditions, [], 'a linked table predicate is not the base entity one');
  assert.deepStrictEqual(r.orders, [], 'and a linked table sort is not the base entity one either');
});

// link-entities NEST, and a join used only for projection is self-closing. A non-greedy regex would
// stop at the first </link-entity> and let the outer subtree leak back in, so the scanner tracks
// depth. Base-entity content on BOTH sides of the subtree has to survive.
test('parseFetchXml keeps base-entity content around nested and self-closing link-entities', () => {
  const nested = `<fetch><entity name="a"><condition attribute="base" operator="eq" value="1"/>`
    + `<link-entity name="b"><link-entity name="c"><condition attribute="deep" operator="eq" value="9"/>`
    + `</link-entity></link-entity><order attribute="baseorder"/></entity></fetch>`;
  const n = parseFetchXml(nested);
  assert.deepStrictEqual(n.conditions.map((c) => c.attribute), ['base'], 'a doubly-nested condition must not leak');
  assert.deepStrictEqual(n.orders.map((o) => o.attribute), ['baseorder'], 'the base order after the subtree must survive');

  const selfClosing = `<fetch><entity name="a"><link-entity name="b" from="x" to="y" />`
    + `<condition attribute="base" operator="eq" value="1"/><order attribute="o1"/></entity></fetch>`;
  const s = parseFetchXml(selfClosing);
  assert.deepStrictEqual(s.conditions.map((c) => c.attribute), ['base'], 'a self-closing join opens no subtree');
  assert.deepStrictEqual(s.orders.map((o) => o.attribute), ['o1']);
});

// `in`/`not-in`/`between` serialize their operands as sibling <value> elements. Reading only the
// first made an authored `in 2` unprovable against a view that really does filter on it.
test('parseFetchXml reads every <value> of a multi-operand condition', () => {
  const xml = `<fetch><entity name="a"><filter><condition attribute="statuscode" operator="in">`
    + `<value>1</value><value>2</value><value>3</value></condition></filter></entity></fetch>`;
  assert.deepStrictEqual(parseFetchXml(xml).conditions.map((c) => c.value), ['1', '2', '3']);
});

// The single-operand shape (a `value` ATTRIBUTE) still wins over any child element, and an operator
// that takes no operand at all stays `undefined` — that is how conditionMatches knows the authored
// claim is just attribute+operator.
test('parseFetchXml keeps the value attribute authoritative, and no-operand operators undefined', () => {
  const attrWins = `<fetch><entity name="a"><condition attribute="x" operator="eq" value="7"><value>ignored</value></condition></entity></fetch>`;
  assert.deepStrictEqual(parseFetchXml(attrWins).conditions.map((c) => c.value), ['7']);

  const noOperand = `<fetch><entity name="a"><condition attribute="ownerid" operator="eq-userid"/></entity></fetch>`;
  assert.deepStrictEqual(parseFetchXml(noOperand).conditions, [{ attribute: 'ownerid', operator: 'eq-userid', value: undefined }]);
});

// --- #584 item 6: --verify proves the deployed form TOPOLOGY, not just that a form exists ---------
//
// Form verification used to check (entity, name, type) identity and the default flag only, so every
// wrong-layout failure this plugin has hit — fields flattened into the first section, a tab appended
// on every rebuild, a relocated field piled into a full row — finished with an unqualified PASS.
const TOPO_SPEC = () => ({
  solution: { uniqueName: 's', publisherPrefix: 'new' },
  app: { name: 'A' },
  entities: [{ schemaName: 'new_ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
  forms: [{ entity: 'new_ticket', name: 'Ticket Main', layout: 'explicit', tabs: [
    { name: 'tab_overview', label: 'Overview', columns: [
      { width: '60%', sections: [{ name: 'sec_left', label: 'L', fields: ['new_name'] }] },
      { width: '40%', sections: [{ name: 'sec_right', label: 'R', fields: ['new_notes'] }] },
    ] },
  ] }],
});
const topoXml = (placement) => `<form><tabs><tab name="tab_overview"><columns>`
  + `<column width="60%"><sections><section name="sec_left"><rows><row>`
  + (placement.left || []).map((f) => `<cell><control datafieldname="${f}" /></cell>`).join('')
  + `</row></rows></section></sections></column>`
  + `<column width="40%"><sections><section name="sec_right"><rows><row>`
  + (placement.right || []).map((f) => `<cell><control datafieldname="${f}" /></cell>`).join('')
  + `</row></rows></section></sections></column>`
  + `</columns></tab></tabs></form>`;

const topoRead = (xml, over) => Object.assign({
  // Enough of the reader surface for verifySpec to run end to end; only the form checks matter here.
  findTable: async () => ({ logicalName: 'new_ticket' }),
  findColumns: async () => [],
  sitemapXml: async () => '',
  queryRecords: async (set) => (set === 'systemform' ? [{ formid: 'f1', name: 'Ticket Main', objecttypecode: 'new_ticket', type: 2, isdefault: true }] : []),
  formTopology: async () => xml,
}, over || {});

const topoCheck = async (xml, specMutator) => {
  const spec = TOPO_SPEC();
  if (specMutator) specMutator(spec);
  const res = await verifySpec(spec, topoRead(xml));
  return (res.checks || []).find((c) => c.kind === 'form-topology');
};

test('verify PASSES when the deployed layout matches the authored one', async () => {
  const chk = await topoCheck(topoXml({ left: ['new_name'], right: ['new_notes'] }));
  assert.ok(chk, 'a form-topology check must be produced for an explicit layout');
  assert.strictEqual(chk.present, true, `expected a pass; got ${chk && chk.detail}`);
});

// THE regression this exists for: the exact shape #575 deployed — everything flattened into the
// first section. The field list is complete, so every pre-existing check still passes.
test('verify FAILS when fields are flattened into the first section', async () => {
  const chk = await topoCheck(topoXml({ left: ['new_name', 'new_notes'], right: [] }));
  assert.strictEqual(chk.present, false, 'a flattened layout must not verify');
  assert.match(chk.detail, /new_notes/, `the offending field should be named; got ${chk.detail}`);
  assert.match(chk.detail, /sec_left/, 'and where it actually landed');
});

test('verify FAILS when an authored section is absent from the deployed form', async () => {
  const xml = `<form><tabs><tab name="tab_overview"><columns>`
    + `<column width="60%"><sections><section name="sec_left"><rows><row><cell><control datafieldname="new_name" /></cell></row></rows></section></sections></column>`
    + `</columns></tab></tabs></form>`;
  const chk = await topoCheck(xml);
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /sec_right/, `the missing section should be named; got ${chk.detail}`);
});

// Fail-closed: an unreadable layout is UNVERIFIED, which must never read as correct.
test('verify reports a form whose layout cannot be read as NOT proven, rather than skipping it', async () => {
  const spec = TOPO_SPEC();
  const res = await verifySpec(spec, topoRead(null, { formTopology: async () => { throw new Error('boom'); } }));
  const chk = (res.checks || []).find((c) => c.kind === 'form-topology');
  assert.ok(chk, 'the check must still be produced');
  assert.strictEqual(chk.present, false, 'an unreadable layout is not a passing layout');
  assert.match(chk.detail, /unverified|could not read/i);
});

// An `auto` layout declares no shape, so there is nothing to prove and no check is emitted — this
// keeps the oracle from inventing a topology expectation the author never stated.
test('verify emits no topology check for an auto layout', async () => {
  const spec = TOPO_SPEC();
  spec.forms = [{ entity: 'new_ticket', name: 'Ticket Main' }];
  const res = await verifySpec(spec, topoRead(topoXml({ left: ['new_name'], right: [] })));
  assert.strictEqual((res.checks || []).filter((c) => c.kind === 'form-topology').length, 0);
});

// The engine appends sub-grid and notes sections the spec never declares, and a maker may add their
// own fields. The oracle grades the AUTHORED subset, so extras must not fail it.
test('verify tolerates deployed sections and fields the spec never declared', async () => {
  const xml = `<form><tabs><tab name="tab_overview"><columns>`
    + `<column width="60%"><sections>`
    + `<section name="sec_left"><rows><row><cell><control datafieldname="new_name" /></cell></row></rows></section>`
    + `<section name="section_grid_new_note"><rows><row><cell><control id="g" /></cell></row></rows></section>`
    + `</sections></column>`
    + `<column width="40%"><sections><section name="sec_right"><rows><row>`
    + `<cell><control datafieldname="new_notes" /></cell><cell><control datafieldname="new_makeradded" /></cell>`
    + `</row></rows></section></sections></column>`
    + `</columns></tab></tabs></form>`;
  const chk = await topoCheck(xml);
  assert.strictEqual(chk.present, true, `extras must not fail the authored subset; got ${chk && chk.detail}`);
});
// --- #N3: the verifier must match containers the way the BUILD does ------------------------------
// LIVE-REPRODUCED: reshaping an auto-built form to an explicit layout succeeds — the build reuses
// the existing containers and deliberately does NOT rename them, because form scripts and business
// rules reference a section by name — and then verify failed the very build it had just done,
// because it looked the section up by the AUTHORED name only.
const migratedXml = () => `<form><tabs><tab name="section_0_0_tab"><labels><label description="Overview" languagecode="1033"/></labels><columns>`
  + `<column width="60%"><sections><section name="section_0_0"><labels><label description="L" languagecode="1033"/></labels><rows><row>`
  + `<cell><labels><label description="Name" languagecode="1033"/></labels><control datafieldname="new_name" /></cell>`
  + `</row></rows></section></sections></column>`
  + `<column width="40%"><sections><section name="section_0_1_0"><labels><label description="R" languagecode="1033"/></labels><rows><row>`
  + `<cell><control datafieldname="new_notes" /></cell>`
  + `</row></rows></section></sections></column>`
  + `</columns></tab></tabs></form>`;

test('verify PASSES an auto-to-explicit migration where containers kept their deployed names', async () => {
  const chk = await topoCheck(migratedXml());
  assert.ok(chk, 'a form-topology check must be produced');
  assert.strictEqual(chk.present, true,
    `a reshape the build performed correctly must verify; got ${chk && chk.detail}`);
});

// The position fallback must not become a rubber stamp: a genuinely WRONG placement still fails,
// even though every container matches positionally. The fields are SWAPPED rather than removed, so
// this cannot pass merely because a field is absent — both are present, in the wrong sections.
test('verify still FAILS a wrong placement when containers matched by position', async () => {
  const swapped = migratedXml()
    .replace('datafieldname="new_name"', 'datafieldname="__TMP__"')
    .replace('datafieldname="new_notes"', 'datafieldname="new_name"')
    .replace('datafieldname="__TMP__"', 'datafieldname="new_notes"');
  const chk = await topoCheck(swapped);
  assert.strictEqual(chk.present, false, 'two fields swapped between sections must fail');
  assert.match(chk.detail, /new_name|new_notes/, `the offending field should be named; got ${chk.detail}`);
});




// --- N3 label/exclusion tests, built so the LABEL pass is the only route to the right answer ------
// A fixture whose authored name matches a deployed name is resolved by the NAME pass and proves
// nothing about labels, exclusions or defaults. In each test below the authored name matches
// NOTHING and the positional slot points at the WRONG container, so only the behaviour under test
// can produce a pass.

// One tab, two sections; `fields` is placed in the section named by `inSection`.
const twoSectionXml = ({ s0, s1, tabLabel = 'Overview', tabName = 'zz_tab' }) =>
  `<form><tabs><tab name="${tabName}"><labels><label description="${tabLabel}" languagecode="1033"/></labels><columns>`
  + `<column width="100%"><sections>${s0}${s1}</sections></column>`
  + `</columns></tab></tabs></form>`;
const sectionXml = (name, label, field, opts = {}) =>
  `<section name="${name}">`
  + (label === null ? '' : `<labels><label description="${label}" languagecode="1033"/></labels>`)
  + `<rows><row><cell>`
  + (opts.cellLabel ? `<labels><label description="${opts.cellLabel}" languagecode="1033"/></labels>` : '')
  + (field ? `<control datafieldname="${field}" />` : '<control id="notescontrol" classid="{06375649}" />')
  + `</cell></row></rows></section>`;
// Authored: ONE section with no name (so the generated name matches nothing deployed).
const oneAuthoredSection = (label, fields) => (spec) => {
  spec.forms[0].tabs = [{ columns: [{ width: '100%', sections: [{ label, fields }] }] }];
};

test('container labels are XML-decoded before matching', async () => {
  // The target is at index 1; the positional slot is index 0. Only a DECODED label resolves it.
  const xml = twoSectionXml({
    s0: sectionXml('zz_other', 'Other', 'new_name'),
    s1: sectionXml('zz_rnd', 'R &amp; D', 'new_notes'),
  });
  const chk = await topoCheck(xml, oneAuthoredSection('R & D', ['new_notes']));
  assert.strictEqual(chk.present, true, `an encoded label must still match; got ${chk && chk.detail}`);
});

test('an engine-owned section is not claimed by the label pass', async () => {
  // Both sections carry label 'L'. The first is the NOTES host (a control with no datafieldname);
  // only the engine-owned exclusion keeps the label pass off it.
  const xml = twoSectionXml({
    s0: sectionXml('zz_notes', 'L', null),
    s1: sectionXml('zz_real', 'L', 'new_name'),
  });
  const chk = await topoCheck(xml, oneAuthoredSection('L', ['new_name']));
  assert.strictEqual(chk.present, true,
    `the engine-owned section must be skipped so the author's section matches; got ${chk && chk.detail}`);
});

test('a cell label is not mistaken for its section label', async () => {
  // Section 0 has NO label of its own but contains a cell labelled 'Right'. If that leaked, the
  // label pass would claim section 0 and the field check would fail.
  const xml = twoSectionXml({
    s0: sectionXml('zz_a', null, 'new_name', { cellLabel: 'Right' }),
    s1: sectionXml('zz_b', 'Right', 'new_notes'),
  });
  const chk = await topoCheck(xml, oneAuthoredSection('Right', ['new_notes']));
  assert.strictEqual(chk.present, true, `a cell label must not claim a section; got ${chk && chk.detail}`);
});

test('an omitted section label matches the compiler default the deployed form carries', async () => {
  // `compileFormIntent` labels an unlabelled section 'Details', so the DEPLOYED section says
  // 'Details'. Passing the raw (undefined) label would skip the label pass and take index 0.
  const xml = twoSectionXml({
    s0: sectionXml('zz_other', 'Other', 'new_name'),
    s1: sectionXml('zz_details', 'Details', 'new_notes'),
  });
  const chk = await topoCheck(xml, oneAuthoredSection(undefined, ['new_notes']));
  assert.strictEqual(chk.present, true,
    `an unlabelled section must match the compiler's 'Details' default; got ${chk && chk.detail}`);
});

test('an omitted TAB label matches the compiler default the deployed form carries', async () => {
  // Two deployed tabs; the authored (unnamed, unlabelled) tab belongs to the SECOND, which carries
  // the compiler's 'General' default. Index 0 is the wrong tab.
  const xml = `<form><tabs>`
    + `<tab name="zz_other"><labels><label description="Other" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections>${sectionXml('zz_s0', 'Details', 'new_name')}</sections></column></columns></tab>`
    + `<tab name="zz_general"><labels><label description="General" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections>${sectionXml('zz_s1', 'Details', 'new_notes')}</sections></column></columns></tab>`
    + `</tabs></form>`;
  const chk = await topoCheck(xml, (spec) => {
    spec.forms[0].tabs = [{ columns: [{ width: '100%', sections: [{ fields: ['new_notes'] }] }] }];
  });
  assert.strictEqual(chk.present, true,
    `an unlabelled tab must match the compiler's 'General' default; got ${chk && chk.detail}`);
});

// --- PR review: a missing CAPABILITY is not a verified layout ------------------------------------
// Gating the whole oracle on `typeof read.formTopology === 'function'` meant a reader without that
// capability skipped EVERY layout check, so an explicit form passed verify on identity and default
// checks alone — no layout proof at all. Same fail-open shape as gating a guard on a method's
// existence elsewhere in this PR.
test('verify reports an explicit layout as UNVERIFIED when the reader cannot read layouts', async () => {
  const spec = TOPO_SPEC();
  const read = topoRead(null);
  delete read.formTopology; // a reader that simply does not expose the capability
  const res = await verifySpec(spec, read);
  const chk = (res.checks || []).find((c) => c.kind === 'form-topology');
  assert.ok(chk, 'an explicit layout must still produce a form-topology check');
  assert.strictEqual(chk.present, false, 'no layout source means UNVERIFIED, not verified');
  assert.match(chk.detail, /no deployed-layout source|UNVERIFIED/);
});

// A FAILED form-id resolution is not the same as a form that does not exist: the form may be there
// and correct, and skipping the check let a transient read failure pass as a verified layout.
test('verify reports UNVERIFIED when the deployed form id cannot be resolved', async () => {
  const spec = TOPO_SPEC();
  const res = await verifySpec(spec, topoRead(topoXml({ left: ['new_name'], right: ['new_notes'] }), {
    queryRecords: async (set) => {
      if (set === 'systemform') throw new Error('transient systemform read failure');
      return [];
    },
  }));
  const chk = (res.checks || []).find((c) => c.kind === 'form-topology');
  assert.ok(chk, 'a resolution FAILURE must be reported, not silently skipped');
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /could not resolve the deployed form id/);
});

// --- PR review: the oracle must prove SHAPE, not just field-to-section membership ---------------
// Comparing only "is each field in the right section" meant the exact regression this branch fixes
// — a field piled into an already-full row, or a widened span overflowing one — still produced a
// PASSING form-topology check. Occupancy and authored spans are now proven.
const shapeXml = ({ cells, columns = '11' }) =>
  `<form><tabs><tab name="tab_overview"><labels><label description="Overview" languagecode="1033"/></labels><columns>`
  + `<column width="100%"><sections><section name="sec_left" columns="${columns}">`
  + `<labels><label description="L" languagecode="1033"/></labels><rows><row>`
  + cells.map((c) => `<cell colspan="${c.span}"${c.rows ? ` rowspan="${c.rows}"` : ''}><control datafieldname="${c.f}" /></cell>`).join('')
  + `</row></rows></section></sections></column>`
  + `</columns></tab></tabs></form>`;
// `cols` defaults to 2 to match `shapeXml`'s default ratio "11". A test that deploys a different
// grid must declare the SAME width here, or it is exercising the grid-width mismatch check rather
// than whatever it meant to test.
const shapeSpec = (fields, cols = 2) => (spec) => {
  spec.forms[0].tabs = [{ name: 'tab_overview', label: 'Overview', columns: [
    { width: '100%', sections: [{ name: 'sec_left', label: 'L', columns: cols, fields }] }] }];
};

test('verify FAILS when a deployed row carries more content than its grid', async () => {
  // Two colspan-1 cells plus a widened one: 2 + 1 = 3 columns of content in a 2-column section.
  const chk = await topoCheck(
    shapeXml({ cells: [{ f: 'new_name', span: 2 }, { f: 'new_notes', span: 1 }] }),
    shapeSpec([{ name: 'new_name', colspan: 2 }, 'new_notes']));
  assert.strictEqual(chk.present, false, 'an overflowing row must not verify');
  assert.match(chk.detail, /3 columns of content in a 2-column section/);
});

// A row-spanning cell also fills its column in the rows beneath it — FormXML rows follow HTML-table
// semantics — so a full row sitting under a rowspan carries one column more than its own cells.
// Counting a row's own cells alone verified that layout as PASS: live, a 2-column section holding
// `[name rowspan=2, tier] / [code, zeta]` passed, with row 2 needing three columns.
const rowsXml = (rows, columns = '11') =>
  `<form><tabs><tab name="tab_overview"><labels><label description="Overview" languagecode="1033"/></labels><columns>`
  + `<column width="100%"><sections><section name="sec_left" columns="${columns}">`
  + `<labels><label description="L" languagecode="1033"/></labels><rows>`
  + rows.map((cells) => `<row>${cells.map((c) => `<cell colspan="${c.span || 1}"${c.rows ? ` rowspan="${c.rows}"` : ''}>`
    + `<control datafieldname="${c.f}" /></cell>`).join('')}</row>`).join('')
  + `</rows></section></sections></column>`
  + `</columns></tab></tabs></form>`;

test('verify FAILS a full row sitting under a row-spanning cell — the reserved slot counts', async () => {
  const chk = await topoCheck(
    rowsXml([[{ f: 'new_name', rows: 2 }, { f: 'new_notes' }], [{ f: 'new_c' }, { f: 'new_d' }]]),
    shapeSpec(['new_notes', 'new_c', 'new_d', { name: 'new_name', rowspan: 2 }]));
  assert.strictEqual(chk.present, false, 'a row overfilled by a reservation must not verify');
  assert.match(chk.detail, /row 2 carries 3 columns of content \(1 reserved by a row-spanning cell above\) in a 2-column section/);
});

test('verify PASSES a rowspan whose reserved slot the row beneath leaves free, and a trailing one', async () => {
  const beside = await topoCheck(
    rowsXml([[{ f: 'new_name', rows: 2 }, { f: 'new_notes' }], [{ f: 'new_c' }]]),
    shapeSpec(['new_name', 'new_notes', 'new_c']));
  assert.strictEqual(beside.present, true, `a cell beside the reservation fits; got ${beside && beside.detail}`);
  const trailing = await topoCheck(
    rowsXml([[{ f: 'new_name' }, { f: 'new_notes' }], [{ f: 'new_c', rows: 2 }]]),
    shapeSpec(['new_name', 'new_notes', { name: 'new_c', rowspan: 2 }]));
  assert.strictEqual(trailing.present, true, `a trailing rowspan reserves nothing that is used; got ${trailing && trailing.detail}`);
});

test('verify FAILS when an AUTHORED span does not match the deployed one', async () => {
  const chk = await topoCheck(
    shapeXml({ cells: [{ f: 'new_name', span: 1 }] }),
    shapeSpec([{ name: 'new_name', colspan: 2 }]));
  assert.strictEqual(chk.present, false, 'a declared span that did not deploy must fail');
  assert.match(chk.detail, /colspan 1, the spec declares 2/);
});

// The counterpart rule the build itself follows: an UNDECLARED span is "no opinion", so a cell a
// maker widened by hand must survive both the rebuild and the verification.
test('verify TOLERATES a deployed span the spec never declared', async () => {
  const chk = await topoCheck(
    shapeXml({ cells: [{ f: 'new_name', span: 2 }], columns: '1111' }),
    shapeSpec(['new_name'], 4));
  assert.strictEqual(chk.present, true, `an undeclared span must not fail; got ${chk && chk.detail}`);
});

// --- review follow-up: a section deployed NARROWER than authored must not excuse its own span ----
// The expected span was clamped against the DEPLOYED width, so a section that came out too narrow
// lowered its own expectation: authored `columns: 4, colspan: 4` deployed as `columns: 1,
// colspan: 1` verified PASS. Both faults are now reported.
test('verify FAILS when a section is deployed narrower than authored', async () => {
  const chk = await topoCheck(
    shapeXml({ cells: [{ f: 'new_name', span: 1 }], columns: '1' }),
    shapeSpec([{ name: 'new_name', colspan: 4 }], 4));
  assert.strictEqual(chk.present, false,
    `a section narrower than authored must not excuse its own span; got ${chk && chk.detail}`);
  assert.match(chk.detail, /deployed 1 column\(s\) wide, the spec declares 4/,
    `the width fault must be named; got ${chk.detail}`);
  assert.match(chk.detail, /has colspan 1, the spec declares 4/,
    `and the span must still be judged against the AUTHORED width; got ${chk.detail}`);
});

// --- review follow-up: `rowspan` is NOT bounded by the grid ------------------------------------
// The clamp deliberately tests `key === 'colspan'`. Dropping that guard — clamping both spans
// against the section width — survived the whole suite, because nothing declared a rowspan at all.
// A 3-row-tall cell in a 2-column section is perfectly legal: rows are unbounded.
test('verify TOLERATES a rowspan larger than the section is wide', async () => {
  const chk = await topoCheck(
    shapeXml({ cells: [{ f: 'new_name', span: 1, rows: 3 }] }),
    shapeSpec([{ name: 'new_name', colspan: 1, rowspan: 3 }]));
  assert.strictEqual(chk.present, true,
    `rowspan must be compared as authored, never clamped by the column count; got ${chk && chk.detail}`);
});

// And the counterpart, so "tolerates" above cannot be satisfied by ignoring rowspan entirely.
test('verify FAILS when a declared rowspan did not deploy', async () => {
  const chk = await topoCheck(
    shapeXml({ cells: [{ f: 'new_name', span: 1 }] }),
    shapeSpec([{ name: 'new_name', colspan: 1, rowspan: 3 }]));
  assert.strictEqual(chk.present, false, 'a declared rowspan that did not deploy must fail');
  assert.match(chk.detail, /rowspan 1, the spec declares 3/,
    `the rowspan fault must be named exactly; got ${chk.detail}`);
});

// A section that declares no width cannot be checked for overflow — unknown is not "one column".
test('verify skips the occupancy check when the deployed section declares no width', async () => {
  const xml = `<form><tabs><tab name="tab_overview"><labels><label description="Overview" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections><section name="sec_left">`
    + `<labels><label description="L" languagecode="1033"/></labels><rows><row>`
    + `<cell><control datafieldname="new_name" /></cell><cell><control datafieldname="new_notes" /></cell>`
    + `</row></rows></section></sections></column></columns></tab></tabs></form>`;
  const chk = await topoCheck(xml, shapeSpec(['new_name', 'new_notes']));
  assert.strictEqual(chk.present, true, `unknown width must not invent an overflow; got ${chk && chk.detail}`);
});

// --- F1: a span the COMPILER clamps must verify against its effective value --------------------
// The schema documents that a span wider than its section is clamped, so `colspan: 4` in a
// one-column section deploys as 1. Comparing the RAW authored value failed a layout that had been
// built exactly as documented. Live-reproduced:
//   verify FAIL — field 'qa18a_name' has colspan 1, the spec declares 4
test('verify accepts a span the compiler CLAMPED to the section width', async () => {
  const xml = `<form><tabs><tab name="tab_overview"><labels><label description="Overview" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections><section name="sec_left" columns="1">`
    + `<labels><label description="L" languagecode="1033"/></labels><rows>`
    + `<row><cell colspan="1"><control datafieldname="new_name" /></cell></row>`
    + `</rows></section></sections></column></columns></tab></tabs></form>`;
  const chk = await topoCheck(xml, (spec) => {
    spec.forms[0].tabs = [{ name: 'tab_overview', label: 'Overview', columns: [
      { width: '100%', sections: [{ name: 'sec_left', label: 'L', columns: 1, fields: [{ name: 'new_name', colspan: 4 }] }] }] }];
  });
  assert.strictEqual(chk.present, true,
    `a correctly clamped span must verify; got ${chk && chk.detail}`);
});

test('verify STILL fails a span that is wrong after clamping', async () => {
  // Declared 4 in a 2-column section clamps to 2, but the cell deployed as 1 — a real mismatch.
  const xml = `<form><tabs><tab name="tab_overview"><labels><label description="Overview" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections><section name="sec_left" columns="11">`
    + `<labels><label description="L" languagecode="1033"/></labels><rows>`
    + `<row><cell colspan="1"><control datafieldname="new_name" /></cell></row>`
    + `</rows></section></sections></column></columns></tab></tabs></form>`;
  const chk = await topoCheck(xml, (spec) => {
    spec.forms[0].tabs = [{ name: 'tab_overview', label: 'Overview', columns: [
      { width: '100%', sections: [{ name: 'sec_left', label: 'L', columns: 2, fields: [{ name: 'new_name', colspan: 4 }] }] }] }];
  });
  assert.strictEqual(chk.present, false, `a genuine mismatch must still fail; got ${chk && chk.detail}`);
  assert.match(chk.detail, /clamped to 2/, `the message must explain the clamp; got ${chk.detail}`);
});

// --- F4: a same-named section in ANOTHER tab must not satisfy the placement --------------------
// The builder can produce two sections called `sec_fields` in different tabs — one holding the
// fields, one empty in the tab that was requested. Keying placement by section NAME found the
// empty one equal to the real one and reported PASS while the relocation had not happened.
// Live-reproduced: verify PASS (28/28) against a form whose fields were in the wrong tab.
test('verify FAILS when the fields sit in a same-named section under a DIFFERENT tab', async () => {
  const xml = `<form><tabs>`
    + `<tab name="tab_source"><labels><label description="Source" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections><section name="sec_fields" columns="1">`
    + `<labels><label description="F" languagecode="1033"/></labels><rows>`
    + `<row><cell><control datafieldname="new_name" /></cell></row>`
    + `</rows></section></sections></column></columns></tab>`
    + `<tab name="tab_destination"><labels><label description="Destination" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections><section name="sec_fields" columns="1">`
    + `<labels><label description="F" languagecode="1033"/></labels><rows></rows></section>`
    + `</sections></column></columns></tab>`
    + `</tabs></form>`;
  // The spec asks for the field in the DESTINATION tab. The deployed form has an empty section of
  // that exact name there, and the real field still in the source tab.
  const chk = await topoCheck(xml, (spec) => {
    spec.forms[0].tabs = [{ name: 'tab_destination', label: 'Destination', columns: [
      { width: '100%', sections: [{ name: 'sec_fields', label: 'F', columns: 1, fields: ['new_name'] }] }] }];
  });
  assert.strictEqual(chk.present, false,
    'an empty same-named section must not stand in for the real one');
  assert.match(chk.detail, /under a different tab/,
    `the message must name the aliasing; got ${chk && chk.detail}`);
});

// The control: a correctly relocated field must still PASS, so the fix cannot be satisfied by
// failing every same-named section.
test('verify PASSES when the field really is in the requested tab', async () => {
  const xml = `<form><tabs>`
    + `<tab name="tab_source"><labels><label description="Source" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections><section name="sec_fields" columns="1">`
    + `<labels><label description="F" languagecode="1033"/></labels><rows></rows></section>`
    + `</sections></column></columns></tab>`
    + `<tab name="tab_destination"><labels><label description="Destination" languagecode="1033"/></labels><columns>`
    + `<column width="100%"><sections><section name="sec_fields" columns="1">`
    + `<labels><label description="F" languagecode="1033"/></labels><rows>`
    + `<row><cell><control datafieldname="new_name" /></cell></row>`
    + `</rows></section></sections></column></columns></tab>`
    + `</tabs></form>`;
  const chk = await topoCheck(xml, (spec) => {
    spec.forms[0].tabs = [{ name: 'tab_destination', label: 'Destination', columns: [
      { width: '100%', sections: [{ name: 'sec_fields', label: 'F', columns: 1, fields: ['new_name'] }] }] }];
  });
  assert.strictEqual(chk.present, true, `a real relocation must verify; got ${chk && chk.detail}`);
});

// --- #586 item 3: a deployed dashboard must be internally consistent, not merely present ----------
// A chart tile names a table, a view and a chart. The platform accepts and publishes a tile whose
// chart belongs to another table — and a same-named chart elsewhere made the build produce exactly
// that, live, while verify passed. So each chart tile's chart and view must both be on its table.
const DASH_VIEW = '{11111111-1111-1111-1111-111111111111}';
const DASH_CHART = '{22222222-2222-2222-2222-222222222222}';
const dashSpec = () => ({ solution: { uniqueName: 's', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [],
  dashboards: [{ name: 'Ops', tiles: [{ type: 'chart', name: 'By Priority', entity: 'new_ticket', viewId: 'v', visualizationId: 'c' }] }] });
const chartTile = (over) => ({ type: 'chart', name: 'By Priority', parameters: { TargetEntityType: 'new_ticket', ViewId: DASH_VIEW, VisualizationId: DASH_CHART, ...over } });
const dashRead = ({ dashboards = [{ formid: 'dash-1' }], chartTable = 'new_ticket', viewTable = 'new_ticket', components = [chartTile()], reader = {} } = {}) => Object.assign({
  findTable: async () => null,
  findColumns: async () => [],
  sitemapXml: async () => '',
  queryRecords: async (set, q) => {
    if (set === 'systemform') { if (dashboards instanceof Error) throw dashboards; return dashboards; }
    if (set === 'savedqueryvisualization') {
      if (chartTable instanceof Error) throw chartTable;
      assert.match(q.filter, /^savedqueryvisualizationid eq 22222222-2222-2222-2222-222222222222$/, 'the braced tile GUID is queried bare and unquoted');
      return chartTable ? [{ primaryentitytypecode: chartTable }] : [];
    }
    if (set === 'savedquery') return viewTable ? [{ returnedtypecode: viewTable }] : [];
    return [];
  },
  dashboardComponents: async () => { if (components instanceof Error) throw components; return components; },
}, reader);
const dashCheck = async (opts) => (await verifySpec(dashSpec(), dashRead(opts))).checks.find((c) => c.kind === 'dashboard');

test('verify PASSES a dashboard whose chart tile shows its own table\'s view and chart', async () => {
  const chk = await dashCheck();
  assert.strictEqual(chk.present, true, chk.detail);
});

test('verify FAILS a chart tile whose chart belongs to another table (the live cross-wiring)', async () => {
  const chk = await dashCheck({ chartTable: 'new_customer' });
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /chart tile 'By Priority' shows new_ticket, but its chart belongs to new_customer/);
});

test('verify FAILS a chart tile whose view belongs to another table, or whose chart no longer exists', async () => {
  assert.match((await dashCheck({ viewTable: 'new_customer' })).detail, /its view belongs to new_customer/);
  assert.match((await dashCheck({ chartTable: null })).detail, /its chart does not exist/);
});

test('verify FAILS a missing dashboard, and an ambiguous name it cannot identify', async () => {
  assert.strictEqual((await dashCheck({ dashboards: [] })).present, false);
  const ambiguous = await dashCheck({ dashboards: [{ formid: 'a' }, { formid: 'b' }] });
  assert.strictEqual(ambiguous.present, false);
  assert.match(ambiguous.detail, /2 dashboards share this name and this app's solution cannot say which is its own/);
});

// A name can also match another app's dashboard. The build reuses the one the app's solution holds, so
// verify checks THAT one — a namesake elsewhere must neither fail a correct app nor hide a broken one.
test('verify checks the dashboard the app\'s solution holds when a namesake exists elsewhere', async () => {
  const withSolution = (inSolution, onComponents) => ({
    reader: {
      queryRecords: async (set, q) => {
        if (set === 'systemform') return [{ formid: 'dash-foreign' }, { formid: 'dash-ours' }];
        if (set === 'solution') return [{ solutionid: 'sol-1' }];
        if (set === 'solutioncomponent') return inSolution.filter((id) => q.filter.includes(`objectid eq ${id}`)).map((objectid) => ({ objectid }));
        return dashRead().queryRecords(set, q);
      },
      dashboardComponents: async (id) => { onComponents.push(id); return [chartTile()]; },
    },
  });
  const read = [];
  const ok = await dashCheck(withSolution(['dash-ours'], read));
  assert.strictEqual(ok.present, true, ok.detail);
  assert.deepStrictEqual(read, ['dash-ours'], 'the tiles checked are the solution\'s dashboard, not the first match');
  const none = await dashCheck(withSolution([], []));
  assert.strictEqual(none.present, false);
  assert.match(none.detail, /none of them is in this app's solution/);
});

// The sitemap subarea check resolves its dashboard the SAME way. It used to take the first name match:
// live, another app's same-named dashboard sorted first and failed a correctly wired app's nav entry.
test('the dashboard subarea check follows the app\'s solution too, never the first name match', async () => {
  const OURS = 'aaaaaaaa-0000-0000-0000-000000000002';
  const FOREIGN = 'aaaaaaaa-0000-0000-0000-000000000001';
  const spec = { ...dashSpec(), appShell: { areas: [{ groups: [{ subAreas: [{ dashboard: 'Ops', title: 'Ops nav' }] }] }] } };
  const subarea = async (inSolution, sitemapPointsAt, systemforms = [{ formid: FOREIGN }, { formid: OURS }]) => {
    const lookups = [];
    const read = dashRead({ reader: {
      queryRecords: async (set, q) => {
        if (set === 'systemform') { lookups.push(q); if (systemforms instanceof Error) throw systemforms; return systemforms; }
        if (set === 'solution') return [{ solutionid: 'sol-1' }];
        if (set === 'solutioncomponent') {
          if (inSolution instanceof Error) throw inSolution;
          return inSolution.filter((id) => q.filter.includes(`objectid eq ${id}`)).map((objectid) => ({ objectid }));
        }
        return dashRead().queryRecords(set, q);
      },
      sitemapXml: async () => `<SiteMap><Area><SubArea Id="s" DefaultDashboard="{${sitemapPointsAt.toUpperCase()}}"/></Area></SiteMap>`,
    } });
    const r = await verifySpec(spec, read);
    return { chk: r.checks.find((c) => c.kind === 'subarea'), lookups };
  };
  const ok = await subarea([OURS], OURS);
  assert.strictEqual(ok.chk.present, true, `a nav entry wired to the app's own dashboard verifies; got ${ok.chk.detail}`);
  assert.strictEqual(ok.lookups.length, 1, 'the dashboard check and the subarea check share one lookup per name');
  assert.strictEqual(ok.lookups[0].paginate, true, 'read in full, not one page of ten the app\'s own could sort beyond');
  assert.strictEqual((await subarea([OURS], FOREIGN)).chk.present, false, 'a nav entry wired to another app\'s namesake does not');
  const unknown = (await subarea([], OURS)).chk;
  assert.strictEqual(unknown.present, false);
  assert.match(unknown.detail, /2 dashboards share this name and none of them is in this app's solution/);
  const cannotAsk = (await subarea(new Error('HTTP 503'), OURS)).chk;
  assert.strictEqual(cannotAsk.present, false, 'an unreadable solution proves nothing');
  assert.match(cannotAsk.detail, /this app's solution cannot say which is its own \(HTTP 503\)/);
  const unreadable = (await subarea([OURS], OURS, new Error('boom'))).chk;
  assert.strictEqual(unreadable.present, false);
  assert.match(unreadable.detail, /unverified, not proven correct/);
});

test('verify reports unreadable dashboards, tiles and tile targets as UNVERIFIED, never as correct', async () => {
  for (const opts of [{ dashboards: new Error('boom') }, { components: new Error('boom') }, { chartTable: new Error('boom') }]) {
    const chk = await dashCheck(opts);
    assert.strictEqual(chk.present, false, JSON.stringify(Object.keys(opts)));
    assert.match(chk.detail, /unverified, not proven correct/);
  }
});

test('verify checks dashboard EXISTENCE only when the reader cannot read tiles (additive, reader-gated)', async () => {
  const chk = await dashCheck({ reader: { dashboardComponents: undefined } });
  assert.strictEqual(chk.present, true);
});

test('verify ignores non-chart tiles when proving a dashboard', async () => {
  const chk = await dashCheck({ components: [{ type: 'list', name: 'L', parameters: { TargetEntityType: 'new_ticket', ViewId: DASH_VIEW } }, { type: 'iframe', name: 'I', parameters: { Url: 'https://x' } }] });
  assert.strictEqual(chk.present, true, chk.detail);
});