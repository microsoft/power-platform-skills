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
// Page branch tests (Task 10, C1/C6)
// ---------------------------------------------------------------------------

// Minimal read mock: satisfies entity/column/sitemap reads + the new page reader. Sitemap binds pages via
// the GenPageId attribute (the real SDK attribute, vendor cds-maker-sdk.cjs:50).
function pageRead({ live, code, sitemap }) {
  return {
    findTable: async () => ({ logicalName: 'contoso_item' }),
    findColumns: async () => [],
    queryRecords: async () => [],
    sitemapXml: async () => sitemap || '',
    pages: async () => live,
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
const SITEMAP_OK = '<SiteMap><Area><Group><SubArea Id="s1" GenPageId="gp-overview"/><SubArea Id="s2" GenPageId="gp-detail"/></Group></Area></SiteMap>';
const NAV_TO = (id) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "${id}", data: {} });`;

test('verifySpec pages: present + GenPageId-bound + nav edge resolves to the actual target id → ok', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const read = pageRead({ live, sitemap: SITEMAP_OK, code: { 'gp-overview': NAV_TO('gp-detail') } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && c.present));
  assert.ok(r.checks.some((c) => c.kind === 'page-subarea' && c.name === 'Overview' && c.present));
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present));
  assert.ok(r.checks.filter((c) => c.kind.startsWith('page')).every((c) => c.present), 'all page checks present');
});

test('verifySpec pages: a WRONG deployed GUID in the nav literal FAILS the nav check (C1 wrong-GUID)', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const read = pageRead({ live, sitemap: SITEMAP_OK, code: { 'gp-overview': NAV_TO('00000000-dead-beef-0000-000000000000') } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && !c.present), 'nav edge must resolve to the ACTUAL target id');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: the correct target id only in a COMMENT (not a nav call site) FAILS the edge (C1 structural oracle)', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const read = pageRead({ live, sitemap: SITEMAP_OK, code: { 'gp-overview': `// go to gp-detail\n${NAV_TO('some-other-id')}` } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && !c.present), 'a decoy id in a comment does not satisfy the edge');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a residual PAGEREF_ in deployed nav code FAILS the no-pageref check', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const read = pageRead({ live, sitemap: SITEMAP_OK, code: { 'gp-overview': NAV_TO('PAGEREF_detail') } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-no-pageref' && !c.present));
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a page missing from the live enumeration FAILS the page check', async () => {
  const read = pageRead({ live: [{ pageId: 'gp-detail', name: 'Detail' }], sitemap: '', code: {} });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && !c.present));
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: the sitemap subarea check matches the GenPageId attribute ONLY (a decoy attr does not satisfy it)', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  // gp-overview appears in a DECOY attribute, not GenPageId → the subarea binding must be reported missing.
  const sitemap = '<SiteMap><Area><Group><SubArea Id="s1" Url="gp-overview"/><SubArea Id="s2" GenPageId="gp-detail"/></Group></Area></SiteMap>';
  const read = pageRead({ live, sitemap, code: { 'gp-overview': NAV_TO('gp-detail') } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-subarea' && c.name === 'Overview' && !c.present), 'only a GenPageId="…" binding counts');
});

test('verifySpec pages: FAIL-CLOSED + unableToRun when the reader cannot enumerate pages (C6)', async () => {
  // A reader without pages() means the verifier is unable to run — this must yield
  // r.unableToRun===true (distinct from a reader that enumerates and finds a page missing).
  const read = { findTable: async () => ({ logicalName: 'contoso_item' }), findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '' }; // NO pages()
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-verify' && !c.present), 'a page-bearing spec with no page reader must fail, not silently pass');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.unableToRun, true, 'unableToRun must be true for reader-incapacity (distinct from ordinary miss)');
});

test('verifySpec pages: ordinary miss (reader enumerates but page not found) has unableToRun falsy', async () => {
  // Distinct from reader-incapacity: the reader CAN enumerate but the page is missing from live.
  // ok:false but unableToRun is NOT set (it is an ordinary failed check, not a capacity gap).
  const read = pageRead({ live: [], sitemap: '', code: {} });
  const r = await verifySpec(pageSpec(), read);
  assert.strictEqual(r.ok, false);
  assert.ok(!r.unableToRun, 'ordinary miss (enumerable but absent) must NOT set unableToRun');
});
