'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { verifySpec, hasElement } = require('../lib/verify-spec.js');
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
