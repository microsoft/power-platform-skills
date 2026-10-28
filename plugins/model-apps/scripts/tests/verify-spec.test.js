'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { verifySpec, hasElement, parseFetchXml, liveNavEntries, subareaDashboardHasLauncher } = require('../lib/verify-spec.js');
const { sitemapXmlFor } = require('../verify-model-app.js');
const { SDK_ROLE_MARKER } = require('../lib/app-spec.js');
const { parseTranslationWorkbook, readTranslationLabels } = require('../lib/translation-labels.js');
const { workbookXml, exportZip, exportAnswer } = require('./helpers/translation-export.js');
const { OBJECT_DIVISION_PAGE, MISREAD_PAGES, TEMPLATE_LINE_PAGE, JSX_TEXT_PAGE, ELEMENT_AFTER_OPERATOR_PAGES, ELEMENT_LOOKALIKE_PAGES, ELEMENT_PAGE_TOKEN_LINE, FUNCTION_TYPE_PAGES } = require('./helpers/misread-page.js');
// What a guess costs a page where the TypeScript parser does not settle it (lib/typescript-views.js): these tests read the page with the lexer alone.
// parser-check.test.js holds what the parser settles.
const { setParserCheck } = require('../lib/typescript-views.js');
const lexerAlone = (t) => { setParserCheck(false); t.after(() => setParserCheck(true)); };

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
    formTopology: async () => '<form><DisplayConditions Order="0"/></form>',
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

// AB#6726727: an entry wired to the dashboard but without the launcher Url shows a placeholder icon, and
// the designer does not treat it as a dashboard entry. That is the shape earlier builds wrote over
// designer-made entries, and the wiring check alone passed it.
test('verifySpec: a dashboard nav entry must carry the launcher Url', async () => {
  const DASH = 'aaaa1111-2222-3333-4444-555566667777';
  const spec = { entities: [], views: [], charts: [], forms: [], appShell: { areas: [{ groups: [{ subAreas: [{ dashboard: 'Ops', title: 'Ops' }] }] }] } };
  const reader = (tag) => ({
    findTable: async () => null, findColumns: async () => [],
    queryRecords: async (set, opts) => (set === 'systemform' && /name eq 'Ops'/.test(opts.filter) ? [{ formid: DASH }] : []),
    sitemapXml: async () => `<SiteMap><Area><Group>${tag}</Group></Area></SiteMap>`,
  });
  const launcher = (r) => r.checks.find((c) => c.kind === 'subarea-dashboard-launcher');
  const damaged = await verifySpec(spec, reader(`<SubArea Id="sub_0_0_0" DefaultDashboard="${DASH}" ResourceId="SitemapDesigner.NewSubArea" />`));
  assert.strictEqual(launcher(damaged).present, false);
  assert.match(launcher(damaged).detail, /placeholder icon/);
  // Attribute order and GUID spelling are Dataverse's to choose.
  const designer = await verifySpec(spec, reader(`<SubArea DefaultDashboard="{${DASH.toUpperCase()}}" Id="ops" Url="/workplace/home_dashboards.aspx" Client="All,Web" />`));
  assert.strictEqual(launcher(designer).present, true);
  // Only the entry for THIS dashboard counts: another entry's launcher Url proves nothing.
  const elsewhere = await verifySpec(spec, reader(`<SubArea Id="x" DefaultDashboard="${DASH}" /><SubArea Id="y" Url="/workplace/home_dashboards.aspx" DefaultDashboard="99999999-0000-0000-0000-000000000000" />`));
  assert.strictEqual(launcher(elsewhere).present, false);
  // Only the exact launcher satisfies both consumers: the runtime's glyph test is case-sensitive, and
  // the designer compares the whole Url.
  for (const url of ['/WorkPlace/Home_Dashboards.aspx', '/workplace/home_dashboards.aspx?pagetype=dashboard']) {
    const near = await verifySpec(spec, reader(`<SubArea Id="ops" Url="${url.replace(/&/g, '&amp;')}" DefaultDashboard="${DASH}" />`));
    assert.strictEqual(launcher(near).present, false, url);
  }
  // Not wired at all: the wiring check fails, and there is no second check to double-count it.
  const unwired = await verifySpec(spec, reader('<SubArea Id="x" Entity="account" />'));
  assert.strictEqual(launcher(unwired), undefined);
});

// Only a real nav entry — a SubArea directly under SiteMap/Area/Group — can carry the launcher Url for its
// dashboard. A `<SubArea …>` in a comment, a CDATA section, a processing instruction or anywhere else is
// no entry, so a decoy there carrying the Url must not pass the real entry that lacks it.
test('verifySpec: a SubArea that is no nav entry cannot satisfy the dashboard launcher check', async () => {
  const DASH = 'aaaa1111-2222-3333-4444-555566667777';
  const spec = { entities: [], views: [], charts: [], forms: [], appShell: { areas: [{ groups: [{ subAreas: [{ dashboard: 'Ops', title: 'Ops' }] }] }] } };
  const readerOf = (xml) => ({
    findTable: async () => null, findColumns: async () => [],
    queryRecords: async (set, opts) => (set === 'systemform' && /name eq 'Ops'/.test(opts.filter) ? [{ formid: DASH }] : []),
    sitemapXml: async () => xml,
  });
  const launcher = (r) => r.checks.find((c) => c.kind === 'subarea-dashboard-launcher');
  const decoy = `<SubArea Id="decoy" Url="/workplace/home_dashboards.aspx" DefaultDashboard="${DASH}" />`;
  const damaged = `<SubArea Id="ops" DefaultDashboard="{${DASH.toUpperCase()}}" />`;
  for (const xml of [
    `<SiteMap><Area><Group>${damaged}<!-- ${decoy} --></Group></Area></SiteMap>`,
    `<SiteMap><Area><Group>${damaged}<![CDATA[${decoy}]]></Group></Area></SiteMap>`,
    `<?decoy ${decoy}?><SiteMap><Area><Group>${damaged}</Group></Area></SiteMap>`,
    `<SiteMap>${decoy}<Area><Group>${damaged}</Group></Area></SiteMap>`,
    `<SiteMap><Area>${decoy}<Group>${damaged}</Group></Area></SiteMap>`,
    `<SiteMap><Area><Group><SubArea Id="outer" Entity="account">${decoy}</SubArea>${damaged}</Group></Area></SiteMap>`,
  ]) {
    const r = await verifySpec(spec, readerOf(xml));
    assert.strictEqual(launcher(r).present, false, xml);
    assert.match(launcher(r).detail, /placeholder icon/, xml);
    assert.strictEqual(subareaDashboardHasLauncher(xml, DASH), false, xml);
  }
  // Only a decoy wires it, or the walk cannot read the sitemap at all: no nav entry to fault for a missing
  // Url, so the check fails with what is actually wrong.
  for (const xml of [
    `<SiteMap><Area><Group><!-- ${decoy} --></Group></Area></SiteMap>`,
    `<SiteMap><Area>${decoy}</Area></SiteMap>`,
    `<!DOCTYPE SiteMap><SiteMap><Area><Group>${decoy}</Group></Area></SiteMap>`,
  ]) {
    const r = await verifySpec(spec, readerOf(xml));
    assert.strictEqual(launcher(r).present, false, xml);
    assert.match(launcher(r).detail, /no nav entry points at it/, xml);
  }
  // The real entry passes with children of its own and its Url read XML-decoded, as the runtime reads it.
  const real = `<SiteMap><Area><Group><SubArea Id="ops" Url="&#47;workplace/home_dashboards.aspx" DefaultDashboard="{${DASH.toUpperCase()}}"><Titles><Title LCID="1033" Title="Ops" /></Titles></SubArea></Group></Area></SiteMap>`;
  assert.strictEqual(launcher(await verifySpec(spec, readerOf(real))).present, true);
  assert.strictEqual(subareaDashboardHasLauncher(real, DASH), true);
});

test('verifySpec: a pinned dashboardId verifies a dashboard renamed since the download', async () => {
  const PIN = 'aaaa1111-2222-3333-4444-555566667777';
  const spec = { entities: [], views: [], charts: [], forms: [],
    dashboards: [{ name: 'Command Center - Event operations', dashboardId: PIN, tiles: [{ type: 'list', entity: 'account', viewId: 'v1' }] }],
    appShell: { areas: [{ groups: [{ subAreas: [{ dashboard: 'Command Center - Event operations', title: 'Event operations' }] }] }] } };
  const read = {
    findTable: async () => null, findColumns: async () => [],
    queryRecords: async (set, opts) => {
      if (set !== 'systemform') return [];
      if (opts.filter === `formid eq ${PIN}`) return [{ formid: PIN, name: 'Event operations', type: 0 }];
      return []; // the stale name finds nothing
    },
    sitemapXml: async () => `<SiteMap><Area><Group><SubArea Id="ops" Url="/workplace/home_dashboards.aspx" DefaultDashboard="{${PIN.toUpperCase()}}" /></Group></Area></SiteMap>`,
  };
  const r = await verifySpec(spec, read);
  for (const kind of ['dashboard', 'subarea', 'subarea-dashboard-launcher']) {
    const chk = r.checks.find((c) => c.kind === kind);
    assert.ok(chk && chk.present, `${kind}: ${JSON.stringify(chk)}`);
  }
});

// The build KEEPS a nav entry's icon that was changed in the designer since the spec's baseline when
// the spec still has the baseline's value (sitemap-merge.js), so verify must accept exactly that case —
// or the build's own --verify fails on a value it deliberately left alone.
test('verifySpec: an icon the build kept from the designer passes only in the case the build keeps it', async () => {
  const spec = { entities: [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }], views: [], charts: [], forms: [],
    appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'new_order', title: 'Orders', vectorIcon: '$webresource:new_old.svg' }] }] }] } };
  const read = {
    findTable: async () => ({ logicalName: 'new_order' }), findColumns: async () => [{ logicalName: 'new_name' }],
    sitemapXml: async () => '<SiteMap><Area><Group><SubArea Id="o" Entity="new_order" VectorIcon="$webresource:new_designer.svg" /></Group></Area></SiteMap>',
  };
  const vec = (r) => r.checks.find((c) => c.kind === 'subarea-vectorIcon');
  assert.strictEqual(vec(await verifySpec(spec, read)).present, false, 'no baseline: the spec value is required');
  const kept = vec(await verifySpec(spec, read, { baselineSpec: JSON.parse(JSON.stringify(spec)) }));
  assert.strictEqual(kept.present, true, 'the spec still has the baseline value: the designer\u2019s is kept');
  assert.match(kept.detail, /changed in the designer since the spec\u2019s baseline/);
  // The SPEC changed it since the baseline: the build writes it, so it must be there.
  const baseline = JSON.parse(JSON.stringify(spec));
  baseline.appShell.areas[0].groups[0].subAreas[0].vectorIcon = '$webresource:new_older.svg';
  assert.strictEqual(vec(await verifySpec(spec, read, { baselineSpec: baseline })).present, false, 'an edit the spec made is still verified');
});

// The exemption is for a value the build KEPT on an entry that is there — never for a missing entry,
// whose icon check is the one thing that fails when a URL entry is gone (there is no separate check).
test('verifySpec: a nav entry missing from the sitemap fails its icon check, baseline or not', async () => {
  const spec = { entities: [], views: [], charts: [], forms: [],
    appShell: { areas: [{ groups: [{ subAreas: [{ url: 'https://contoso.example/help?a=1&b=2', title: 'Help', vectorIcon: '$webresource:new_help.svg' }] }] }] } };
  const baselineSpec = JSON.parse(JSON.stringify(spec));
  const vec = (r) => r.checks.find((c) => c.kind === 'subarea-vectorIcon');
  for (const xml of ['<SiteMap />', '', null]) {
    const read = { findTable: async () => null, findColumns: async () => [], sitemapXml: async () => xml };
    assert.strictEqual(vec(await verifySpec(spec, read, { baselineSpec })).present, false, JSON.stringify(xml));
  }
  // The same entry present with a designer icon IS kept — its URL matched after the XML escaping is read.
  const read = { findTable: async () => null, findColumns: async () => [],
    sitemapXml: async () => '<SiteMap><Area><Group><SubArea Id="h" Url="https://contoso.example/help?a=1&amp;b=2" VectorIcon="$webresource:new_designer.svg" /></Group></Area></SiteMap>' };
  assert.strictEqual(vec(await verifySpec(spec, read, { baselineSpec })).present, true);
  // Two live entries for the same target: which one the build kept cannot be told, so nothing is.
  const twice = { ...read, sitemapXml: async () => '<SiteMap><Area><Group><SubArea Id="h" Url="https://contoso.example/help?a=1&amp;b=2" VectorIcon="$webresource:new_designer.svg" /><SubArea Id="h2" Url="https://contoso.example/help?a=1&amp;b=2" /></Group></Area></SiteMap>' };
  assert.strictEqual(vec(await verifySpec(spec, twice, { baselineSpec })).present, false);
});

// Only real elements are navigation, and their values are read the way an XML parser reads them.
test('verifySpec: a kept icon is judged on real SubArea elements, fully XML-decoded', async () => {
  const spec = { entities: [], views: [], charts: [], forms: [],
    appShell: { areas: [{ groups: [{ subAreas: [{ url: 'https://contoso.example/help?a=1&b=2', title: 'Help', vectorIcon: '$webresource:new_help.svg' }] }] }] } };
  const baselineSpec = JSON.parse(JSON.stringify(spec));
  const vec = (r) => r.checks.find((c) => c.kind === 'subarea-vectorIcon');
  const liveOf = (inner) => ({ findTable: async () => null, findColumns: async () => [], sitemapXml: async () => `<SiteMap><Area><Group>${inner}</Group></Area></SiteMap>` });
  // `extra` goes FIRST: an attribute holding a raw `>` must come before the ones the match needs.
  const entry = (url, extra = '') => `<SubArea Id="h"${extra} Url="${url}" VectorIcon="$webresource:new_designer.svg" />`;
  // Commented out, or inside CDATA or a processing instruction, an entry is text — nothing was kept.
  for (const wrapped of [`<!-- ${entry('https://contoso.example/help?a=1&amp;b=2')} -->`, `<![CDATA[${entry('https://contoso.example/help?a=1&amp;b=2')}]]>`, `<?note ${entry('https://contoso.example/help?a=1&amp;b=2')} ?>`]) {
    assert.strictEqual(vec(await verifySpec(spec, liveOf(wrapped), { baselineSpec })).present, false, wrapped);
  }
  // Nor is an element the SDK does not model as navigation: another name that starts the same way, or a
  // SubArea anywhere but directly under SiteMap/Area/Group (the SDK keeps those as opaque XML).
  const url = 'https://contoso.example/help?a=1&amp;b=2';
  for (const other of [
    `<SubArea-Archived Id="h" Url="${url}" VectorIcon="$webresource:new_designer.svg" />`,
    `<SubArea:Archived Id="h" Url="${url}" VectorIcon="$webresource:new_designer.svg" />`,
    `<SubAreaÜ Id="h" Url="${url}" VectorIcon="$webresource:new_designer.svg" />`,
    `<保存>${entry(url)}</保存>`,
    `<Descriptions>${entry(url)}</Descriptions>`,
    `<SubArea Id="outer" Entity="account">${entry(url)}</SubArea>`,
  ]) {
    assert.strictEqual(vec(await verifySpec(spec, liveOf(other), { baselineSpec })).present, false, other);
  }
  // A document the walk cannot account for completely grants no exemption at all: a document type
  // declaration, a `<` that starts no tag, a closing tag out of order.
  for (const xml of [
    `<!DOCTYPE SiteMap><SiteMap><Area><Group>${entry(url)}</Group></Area></SiteMap>`,
    `<SiteMap><Area><Group>${entry(url)} a < b</Group></Area></SiteMap>`,
    `<SiteMap><Area><Group>${entry(url)}</Area></Group></SiteMap>`,
    `<SiteMap><Area><Group>${entry(url)}`,
  ]) {
    const read = { findTable: async () => null, findColumns: async () => [], sitemapXml: async () => xml };
    assert.strictEqual(vec(await verifySpec(spec, read, { baselineSpec })).present, false, xml);
    assert.strictEqual(liveNavEntries(xml), null, `unreadable: ${xml}`);
  }
  // ...while the real entry after such a sibling is still found: the walk returns to the Group level.
  assert.strictEqual(vec(await verifySpec(spec, liveOf(`<Descriptions><Description LCID="1033" Description="x" /></Descriptions>${entry(url)}`), { baselineSpec })).present, true);
  // A numeric reference, either quote style, and a raw `>` inside a value are all the same live entry.
  for (const live of [
    entry('https://contoso.example/help?a=1&#38;b=2'),
    entry('https://contoso.example/help?a=1&#x26;b=2'),
    "<SubArea Id='h' Url='https://contoso.example/help?a=1&amp;b=2' VectorIcon='$webresource:new_designer.svg' />",
    entry('https://contoso.example/help?a=1&amp;b=2', ' Description="a > b"'),
  ]) {
    assert.strictEqual(vec(await verifySpec(spec, liveOf(live), { baselineSpec })).present, true, live);
  }
});

// Verify must line the baseline up the way the build does: by the id each dashboard and page resolves
// to here. A pin the author dropped, while the name still finds the same dashboard, is the same entry.
test('verifySpec: an icon kept on a dashboard or page entry is judged by the ids resolved here', async () => {
  const A = 'aaaa1111-2222-3333-4444-555566667777';
  const P = 'bbbb1111-2222-3333-4444-555566667777';
  const spec = { schemaVersion: 2, entities: [], views: [], charts: [], forms: [],
    dashboards: [{ name: 'Ops', tiles: [{ type: 'list', entity: 'account', viewId: 'v1' }] }],
    pages: [{ key: 'home', name: 'Home', source: { kind: 'tsx', codeFile: 'home.tsx' } }],
    appShell: { areas: [{ groups: [{ subAreas: [
      { dashboard: 'Ops', title: 'Ops', vectorIcon: '$webresource:new_old.svg' },
      { page: 'home', title: 'Home', vectorIcon: '$webresource:new_oldpage.svg' },
    ] }] }] } };
  const baselineSpec = JSON.parse(JSON.stringify(spec));
  baselineSpec.dashboards[0].dashboardId = A; // downloaded pinned; the author has since dropped the pin
  baselineSpec.__deployedIds = { dashboards: { Ops: A }, pages: { home: P } };
  const read = {
    findTable: async () => null, findColumns: async () => [],
    queryRecords: async (set, opts) => (set === 'systemform' && /name eq 'Ops'/.test(opts.filter) ? [{ formid: A, name: 'Ops' }] : []),
    manifest: async () => ({ pages: [{ key: 'home', pageId: P }] }),
    sitemapPageIds: async () => [P], existenceIds: async () => [P],
    sitemapXml: async () => '<SiteMap><Area><Group>'
      + `<SubArea Id="ops" Url="/workplace/home_dashboards.aspx" DefaultDashboard="{${A.toUpperCase()}}" VectorIcon="$webresource:new_designer.svg" />`
      + `<SubArea Id="home" GenPageId="${P}" VectorIcon="$webresource:new_designerpage.svg" />`
      + '</Group></Area></SiteMap>',
  };
  const icons = (r) => r.checks.filter((c) => c.kind === 'subarea-vectorIcon').map((c) => [c.name, c.present]);
  assert.deepStrictEqual(icons(await verifySpec(spec, read, { baselineSpec })), [['Ops', true], ['Home', true]]);
  // Without the ids a dashboard or page resolves to here, nothing lines up and both are required again.
  const unresolved = { ...read, queryRecords: async () => [], manifest: async () => ({ pages: [] }) };
  assert.deepStrictEqual(icons(await verifySpec(spec, unresolved, { baselineSpec })), [['Ops', false], ['Home', false]]);
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
// Page branch tests — three-authority (IDENTITY+EXISTENCE+MEMBERSHIP)
// ---------------------------------------------------------------------------
// Real 36-char GUIDs in every mock.
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

test('verifySpec pages: a WRONG deployed GUID in the nav literal FAILS the nav check (wrong-GUID)', async () => {
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

test('verifySpec pages: the correct target id only in a COMMENT (not a nav call site) FAILS the edge (structural oracle)', async () => {
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

// Verification reads a deployed page with the reader the build uses, and trusts it no further than the build does. An id in a "call" that
// the lexer read only by guess proves no edge: after `of/2` it reads a regex up to the next `/`, and the `/*` inside it opens a comment that
// ends inside a string, so the string's text — here a navigation call to the target — is read as code.
test('verifySpec pages: an id in a call the lexer reads only by guess does not prove the nav edge', async () => {
  const forgery = ['const of = 12;', 'const count = of/2; const re = /\\/*$/;', `const note = "*/ navigateTo({pageType:'generative', pageId:'${GP_DETAIL}'}) /*";`, ''].join('\n');
  const verify = async (code) => verifySpec(pageSpec(), pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: code } }));
  const forged = await verify(forgery);
  assert.ok(forged.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && !c.present), 'the string is not a navigation');
  assert.strictEqual(forged.ok, false);
  // The same call, with nothing read by guess before it, proves the edge.
  const real = await verify(`${forgery.split('\n')[0]}\n${NAV_TO(GP_DETAIL)}\n`);
  assert.ok(real.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present));
  assert.strictEqual(real.ok, true, JSON.stringify(real.missing));
});

// A PAGEREF_ token the lexer hides is still a token that shipped: this page was resolved the way a build resolved it, and its second call
// sits behind a false comment, so the oracle finds no target for it and the old check passed.
test('verifySpec pages: a PAGEREF_ token the lexer hid in deployed code FAILS the no-pageref check, naming where', async (t) => {
  lexerAlone(t);
  const deployed = OBJECT_DIVISION_PAGE.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`);
  assert.strictEqual(deployed.split('PAGEREF_detail').length - 1, 1, 'one call resolved, one left');
  const read = pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: deployed } });
  const r = await verifySpec(pageSpec(), read);
  const check = r.checks.find((c) => c.kind === 'page-no-pageref');
  assert.ok(check && !check.present);
  assert.match(check.detail, /PAGEREF_detail \(line 5, column \d+, after the "brace" ambiguity at line 4, column \d+\)/);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.present), 'the call before the guess still proves the edge');
  assert.strictEqual(r.ok, false);
  // No comment is exempt: a token in one is a token that shipped. A comment with none is not a leftover.
  const withComment = (comment) => verifySpec(pageSpec(), pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: `${comment}\n${NAV_TO(GP_DETAIL)}` } }));
  const commented = await withComment('// PAGEREF_detail was resolved at deploy');
  const leftover = commented.checks.find((c) => c.kind === 'page-no-pageref');
  assert.ok(leftover && !leftover.present, 'a token in a // comment on its own line is a leftover');
  assert.match(leftover.detail, /PAGEREF_detail \(line 1, column 4\)/);
  assert.strictEqual(commented.ok, false);
  const clean = await withComment('// the link was resolved at deploy');
  assert.ok(clean.checks.some((c) => c.kind === 'page-no-pageref' && c.present));
  assert.strictEqual(clean.ok, true, JSON.stringify(clean.missing));
});

// The same page, read as the TypeScript parser reads it where the lexer guessed (lib/typescript-views.js): the second call is seen, so its token is the token of a call
// that the resolve step left — with no guess to name — and the check still fails.
test('verifySpec pages: a PAGEREF_ token left in a call the lexer misreads FAILS the no-pageref check, read as TypeScript parses the page', async () => {
  const deployed = OBJECT_DIVISION_PAGE.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`);
  const read = pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: deployed } });
  const r = await verifySpec(pageSpec(), read);
  const check = r.checks.find((c) => c.kind === 'page-no-pageref');
  assert.ok(check && !check.present);
  assert.doesNotMatch(check.detail, /ambiguity/);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.present), 'the resolved call proves the edge');
  assert.strictEqual(r.ok, false);
});

// A call is trusted only if all of it lies before the first place the lexer guessed. The members of an options object after a guess are
// not read for certain, and a getter or a computed key there can make the call something else — here the call is
// `{ pageType: "entityrecord", … }` when it runs — so an id in a call whose object runs through a guess proves no edge.
test('verifySpec pages: an id in a call whose options object reaches a guess does not prove the nav edge, and one closed before it does', async () => {
  const verify = (code) => verifySpec(pageSpec(), pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: code } }));
  const reaching = await verify(MISREAD_PAGES['inside an options object'].code.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`));
  assert.ok(!reaching.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present), 'the edge is never reported present');
  assert.ok(reaching.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && !c.present));
  assert.strictEqual(reaching.ok, false);
  // The same guess after a call that is closed before it changes nothing about that call.
  const closed = await verify(`${NAV_TO(GP_DETAIL)}\nconst count = {valueOf(){return 12;}}/2; const half = total / 2;\n`);
  assert.ok(closed.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present));
  assert.strictEqual(closed.ok, true, JSON.stringify(closed.missing));
});

// Every misread page (tests/helpers/misread-page.js), as the build would deploy it: only what the reader trusts is
// resolved. Verification must not pass it — a token that lies at or after the first guess is still in the page, and an id in a call that
// reaches the guess proves no edge — and a call in a template line that starts with `//`, which runs, is evidence like any other.
test('verifySpec pages: a misread page deployed as far as the reader trusts it FAILS, and a call in a template line that starts with // proves the edge', async () => {
  const verify = (code) => verifySpec(pageSpec(), pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: code } }));
  for (const [name, { code }] of Object.entries(MISREAD_PAGES)) {
    const r = await verify(code.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`));
    assert.strictEqual(r.ok, false, name);
  }
  // JSX text that looks like parameters is text: the regex after the next arrow holds a token that no rewrite resolved, and verification says so.
  const text = await verify(JSX_TEXT_PAGE.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`));
  const leftover = text.checks.find((c) => c.kind === 'page-no-pageref');
  assert.ok(leftover && !leftover.present);
  assert.match(leftover.detail, /PAGEREF_detail \(line 5, column \d+\)/);
  assert.strictEqual(text.ok, false);
  const ok = await verify(TEMPLATE_LINE_PAGE.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`));
  assert.ok(ok.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present));
  assert.ok(ok.checks.some((c) => c.kind === 'page-no-pageref' && c.present));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.missing));
});

// After a unary or binary operator a `<` opens an element whatever follows its name (`a === <T extends X>text</T>`), so the regex after it is data. Deployed as the build
// resolves it — the real call only — the token in the regex is still in the page, and verification says so with no guess named; the real call still proves the edge.
test('verifySpec pages: a regex after an element that follows a unary or binary operator leaves a token that shipped, and FAILS the no-pageref check', async () => {
  const verify = (code) => verifySpec(pageSpec(), pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: code } }));
  for (const { name, code } of ELEMENT_AFTER_OPERATOR_PAGES) {
    const r = await verify(code.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`));
    const leftover = r.checks.find((c) => c.kind === 'page-no-pageref');
    assert.ok(leftover && !leftover.present, name);
    assert.match(leftover.detail, new RegExp(`PAGEREF_detail \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)`), name);
    assert.doesNotMatch(leftover.detail, /ambiguity/, name);
    assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present), `${name}: the real call still proves the edge`);
    assert.strictEqual(r.ok, false, name);
  }
});

// JSX that holds what looks like a function type's parameter list compiles as an element, so the regex after it is data. Deployed as the build resolves it — the real call only —
// the token in the regex is still in the page, and verification says so with no guess named; the real call still proves the edge.
test('verifySpec pages: a regex after an element whose text looks like a parameter list leaves a token that shipped, and FAILS the no-pageref check', async () => {
  const verify = (code) => verifySpec(pageSpec(), pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: code } }));
  for (const { name, code } of ELEMENT_LOOKALIKE_PAGES) {
    const r = await verify(code.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`));
    const leftover = r.checks.find((c) => c.kind === 'page-no-pageref');
    assert.ok(leftover && !leftover.present, name);
    assert.match(leftover.detail, new RegExp(`PAGEREF_detail \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)`), name);
    assert.doesNotMatch(leftover.detail, /ambiguity/, name);
    assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present), `${name}: the real call still proves the edge`);
    assert.strictEqual(r.ok, false, name);
  }
});

// A generic function type whose parameter list holds a type argument or an object type is a type, for certain: a page deployed with it is read as it is, the call after it proves the
// edge, and no token or guess is left. (A rule that took each for a guess at the `<` trusted nothing after it, so the edge was never proved.)
test('verifySpec pages: a call after a generic function type with a type argument or an object type in its parameter list proves the nav edge', async () => {
  const verify = (code) => verifySpec(pageSpec(), pageRead({ sitemapIds: [GP_OVERVIEW, GP_DETAIL], existenceIds: [GP_OVERVIEW, GP_DETAIL], manifest: BOTH_MANIFEST, sitemap: SITEMAP_OK, code: { [GP_OVERVIEW]: code } }));
  for (const { name, code } of FUNCTION_TYPE_PAGES) {
    const r = await verify(code.replace('"PAGEREF_detail"', `"${GP_DETAIL}"`));
    assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present), `${name}: the edge is proved`);
    assert.ok(r.checks.some((c) => c.kind === 'page-no-pageref' && c.present), `${name}: no token is left`);
    assert.strictEqual(r.ok, true, `${name}: ${JSON.stringify(r.missing)}`);
  }
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

test('verifySpec pages: FAIL-CLOSED + unableToRun when the reader lacks page-authority methods', async () => {
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
// Name≠title match, page-not-in-existence, page-not-in-sitemap,
// empty manifest → unableToRun, page-extra set-equality, caching.
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

test('verifySpec pages: empty/absent manifest on a page-bearing spec → unableToRun (NOT all-missing)', async () => {
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

test('verifySpec pages: an extra live sitemap page not in the spec → page-extra (set-equality)', async () => {
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

test('verifySpec pages: each reader method called exactly once (caching)', async () => {
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

// ── Content-level verify (scoped): catch a build that reports success while the deployed artifact
// DIFFERS from the spec (edits silently not applied). All best-effort + ADDITIVE — a check only fires
// when the reader supplies the data, so existing existence-only readers are unaffected. ────────────

test('verifySpec: view-columns — a spec view column missing from the deployed layoutxml FAILS', async () => {
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

test('verifySpec: default-form flag check remains reader-gated with readable form identities', async () => {  const spec = { entities: [], views: [], charts: [], appShell: { areas: [] },
    forms: [{ entity: 'new_ticket', name: 'Agent Form', formType: 'Main', isDefault: true }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'systemform' ? [{ formid: 'agent-form-id' }] : []),
    formTopology: async () => '<form><DisplayConditions Order="0"/></form>',
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

test('verifySpec: relationship existence — a declared relationship absent from the child metadata FAILS', async () => {
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

test('verifySpec: command existence — a declared command bar with no deployed appaction FAILS', async () => {
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

// --- Security persona roles ---------------------------------------------------

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
// Every per-app AI setting is a tri-state, not 1/0, and On is '2' for all of them: most use
// 0 = Default, 1 = Off, 2 = On, while NL charts use 0 = Off, 1 = Auto, 2 = On (the platform's own
// settings UI; AB#6714731). An ENABLED override therefore holds '2'.
const ALL_SETTINGS_ON = {
  FormFillBarUXEnabled: '2',
  NLGridSearchSetting: '2',
  NLChartDataVisualizationSetting: '2',
  m365copilotmodelappenabled: '2',
};
// The overrides a DEFAULT build writes: `resolveAiFlags` seeds formFill/nlSearch/nlChart on and
// leaves m365 at its platform default ('0') for any spec carrying `ai`, and verify reconciles that
// whole set — so a test focusing on ONE feature must still satisfy the other three or it is
// asserting on unrelated misses.
const DEFAULT_SETTINGS = {
  FormFillBarUXEnabled: '2',
  NLGridSearchSetting: '2',
  NLChartDataVisualizationSetting: '2',
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

test('verifySpec: an explicit OFF request is verified against the setting\u2019s Off value, not treated as dont-care', async () => {
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: { formFill: false } } }, aiRead({ ...DEFAULT_SETTINGS, FormFillBarUXEnabled: '2' }));
  assert.strictEqual(r.ok, false);
  // An explicit disable is still WRITTEN (disabling is never gated), so the override must hold Off.
  // OFF for this family is '1' (DISABLED). '0' would be the platform default — deliberately NOT
  // accepted as off, because it defers to the platform rather than turning the feature off.
  const ok = await verifyAi({ ...AI_BASE, ai: { appFeatures: { formFill: false } } }, aiRead({ ...DEFAULT_SETTINGS, FormFillBarUXEnabled: '1' }));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.missing));
});

test('verifySpec: Off is each setting\u2019s own value \u2014 1 for grid search and M365, 0 for charts (AB#6714731)', async () => {
  const spec = { ...AI_BASE, ai: { appFeatures: { formFill: true, nlSearch: false, nlChart: false, m365: false } } };
  const ok = await verifyAi(spec, aiRead({ FormFillBarUXEnabled: '2', NLGridSearchSetting: '1', NLChartDataVisualizationSetting: '0', m365copilotmodelappenabled: '1' }));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.missing));
  // What earlier builds wrote for `false` was '0' everywhere: Off for charts, but only Default for grid
  // search and M365, which defers to the platform rather than turning the feature off.
  const old = await verifyAi(spec, aiRead({ FormFillBarUXEnabled: '2', NLGridSearchSetting: '0', NLChartDataVisualizationSetting: '0', m365copilotmodelappenabled: '0' }));
  assert.deepStrictEqual(old.missing.filter((m) => m.kind === 'ai-feature').map((m) => m.name).sort(), ['m365', 'nlSearch']);
});

test('verifySpec: the values earlier builds wrote for ON do not verify as on (AB#6714731)', async () => {
  // `true` used to be written as '1' outside the form-fill family — Off for grid search and M365,
  // Auto for charts — and verify expected the same '1', so the build and its check agreed on it.
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: ALL_ON } }, aiRead({ FormFillBarUXEnabled: '2', NLGridSearchSetting: '1', NLChartDataVisualizationSetting: '1', m365copilotmodelappenabled: '1' }));
  assert.deepStrictEqual(r.missing.filter((m) => m.kind === 'ai-feature').map((m) => m.name).sort(), ['m365', 'nlChart', 'nlSearch']);
  assert.match(aiMissing(r, 'nlSearch').detail, /requested '2'/);
  assert.match(aiMissing(r, 'nlChart').detail, /holds '1'/);
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
  const r = await verifyAi(spec, aiRead({ m365copilotmodelappenabled: '2' }));
  assert.strictEqual(r.checks.filter((c) => c.kind === 'ai-feature').length, 4);
  assert.ok(!aiMissing(r, 'm365'), 'the declared feature itself is in place');
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

test('verifySpec: an override row that stays absent is read three times before it is called absent — the budget the build\u2019s own proof shares', async () => {
  // The build re-proves a feature after its publish with the same reads (AI_PROOF_BUDGET), so the two cannot disagree
  // about one row for want of a second look. Counted per setting: every feature the build writes is checked.
  const reads = new Map();
  const base = aiRead({});
  const read = {
    ...base,
    queryRecords: async (set, o) => {
      if (set === 'appsetting') reads.set(o.filter, (reads.get(o.filter) || 0) + 1);
      return base.queryRecords(set, o);
    },
  };
  const r = await verifyAi({ ...AI_BASE, ai: { appFeatures: { formFill: true } } }, read);
  assert.strictEqual(r.ok, false);
  assert.ok(reads.size > 0 && [...reads.values()].every((n) => n === 3), JSON.stringify([...reads]));
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
  // No per-app AI setting is Boolean today — all of them store 0/1/2 — so this guards the
  // normalisation itself: a Boolean spelling means the feature's OWN on/off value ('true' is '2'),
  // never the generic '1', which for grid search is Off. Mapping it to '1' would let a stored
  // 'true' satisfy an explicit OFF request.
  const spec = { ...AI_BASE, ai: { appFeatures: { nlSearch: true } } };
  return verifyAi(spec, aiRead({ ...DEFAULT_SETTINGS, NLGridSearchSetting: 'true' })).then(async (on) => {
    assert.strictEqual(on.ok, true, JSON.stringify(on.missing));
    const off = await verifyAi(spec, aiRead({ ...DEFAULT_SETTINGS, NLGridSearchSetting: 'false' }));
    assert.strictEqual(off.ok, false, 'a Boolean-spelled setting reading false must still fail');
    const wantOff = { ...AI_BASE, ai: { appFeatures: { nlSearch: false } } };
    const inverted = await verifyAi(wantOff, aiRead({ ...DEFAULT_SETTINGS, NLGridSearchSetting: 'true' }));
    assert.ok(aiMissing(inverted, 'nlSearch'), "a stored 'true' must not satisfy an explicit OFF ('1') request");
    const offOk = await verifyAi(wantOff, aiRead({ ...DEFAULT_SETTINGS, NLGridSearchSetting: 'false' }));
    assert.ok(!aiMissing(offOk, 'nlSearch'), "a stored 'false' is this setting's Off");
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
// A deployed tab or section always carries its `<labels>`: `<label description="…" languagecode="…"/>`, one per language. A layout that
// authors a label is held to the one published in the build's language (labelProblem), and no label published is no proof of it, so a
// fixture that stands for a deployed form carries the labels its spec authors. `labelsOf` writes them: a string is a label in 1033, a
// { text, lcid } entry one in another language, a list several; `null` and `undefined` are a container with no `<labels>` at all.
const lbl = (description, languagecode = 1033) => `<label description="${description}" languagecode="${languagecode}"/>`;
const labelsOf = (labels) => (labels === undefined || labels === null ? '' : `<labels>${[].concat(labels).map((l) => (typeof l === 'string' ? lbl(l) : lbl(l.text, l.lcid))).join('')}</labels>`);
const topoXml = (placement) => `<form><tabs><tab name="tab_overview">${labelsOf('Overview')}<columns>`
  + `<column width="60%"><sections><section name="sec_left">${labelsOf('L')}<rows><row>`
  + (placement.left || []).map((f) => `<cell><control datafieldname="${f}" /></cell>`).join('')
  + `</row></rows></section></sections></column>`
  + `<column width="40%"><sections><section name="sec_right">${labelsOf('R')}<rows><row>`
  + (placement.right || []).map((f) => `<cell><control datafieldname="${f}" /></cell>`).join('')
  + `</row></rows></section></sections></column>`
  + `</columns></tab></tabs></form>`;

const topoRead = (xml, over) => Object.assign({
  // Enough of the reader surface for verifySpec to run end to end; only the form checks matter here. An organization always reports its base
  // language, which `--verify` asks for when a layout authors a string label and nothing else says which language the build wrote it in.
  findTable: async () => ({ logicalName: 'new_ticket' }),
  findColumns: async () => [],
  sitemapXml: async () => '',
  queryRecords: async (set) => {
    if (set === 'organization') return [{ languagecode: 1033 }];
    return set === 'systemform' ? [{ formid: 'f1', name: 'Ticket Main', objecttypecode: 'new_ticket', type: 2, isdefault: true }] : [];
  },
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
  const xml = `<form><tabs><tab name="tab_overview">${labelsOf('Overview')}<columns>`
    + `<column width="60%"><sections>`
    + `<section name="sec_left">${labelsOf('L')}<rows><row><cell><control datafieldname="new_name" /></cell></row></rows></section>`
    + `<section name="section_grid_new_note"><rows><row><cell><control id="g" /></cell></row></rows></section>`
    + `</sections></column>`
    + `<column width="40%"><sections><section name="sec_right">${labelsOf('R')}<rows><row>`
    + `<cell><control datafieldname="new_notes" /></cell><cell><control datafieldname="new_makeradded" /></cell>`
    + `</row></rows></section></sections></column>`
    + `</columns></tab></tabs></form>`;
  const chk = await topoCheck(xml);
  assert.strictEqual(chk.present, true, `extras must not fail the authored subset; got ${chk && chk.detail}`);
});

// An authored section may share the name the engine gives its timeline host. Verify matches containers
// the way the BUILD does, and the build never lets an authored section take an engine host by name —
// so neither may verify, or it grades the author's fields against the timeline section.
test('verify never matches an authored section to an engine host that shares its name', async () => {
  const xml = `<form><tabs><tab name="tab_overview">${labelsOf('Overview')}<columns>`
    + `<column width="60%"><sections><section name="sec_left">${labelsOf('L')}<rows><row><cell><control datafieldname="new_name" /></cell></row></rows></section></sections></column>`
    + `<column width="40%"><sections>`
    + `<section name="section_notes"><rows><row><cell><control id="notescontrol" classid="{06375649-c143-495e-a496-c962e5b4488e}" /></cell></row></rows></section>`
    + `<section name="section_notes">${labelsOf('R')}<rows><row><cell><control datafieldname="new_notes" /></cell></row></rows></section>`
    + `</sections></column>`
    + `</columns></tab></tabs></form>`;
  const chk = await topoCheck(xml, (spec) => { spec.forms[0].tabs[0].columns[1].sections[0].name = 'section_notes'; });
  assert.strictEqual(chk.present, true, `the authored section is the one holding its field; got ${chk && chk.detail}`);
});

// A host a maker added a bound field to is no longer engine-owned by structure, yet it still holds the
// timeline — and verify reads FormXML, so it must see the control's classid to know. The build skips such a
// host by name, label and position, so verify must too, or it grades the author's fields against it.
test('verify never matches an authored section to an engine host a maker added a field to', async () => {
  const host = `<section name="section_notes"><labels><label description="Notes" languagecode="1033" /></labels><rows>`
    + `<row><cell><control id="notescontrol" classid="{06375649-C143-495E-A496-C962E5B4488E}" /></cell></row>`
    + `<row><cell><control id="new_x" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="new_x" /></cell></row></rows></section>`;
  const xml = (second) => `<form><tabs><tab name="tab_overview">${labelsOf('Overview')}<columns>`
    + `<column width="60%"><sections><section name="sec_left">${labelsOf('L')}<rows><row><cell><control datafieldname="new_name" /></cell></row></rows></section></sections></column>`
    + `<column width="40%"><sections>${host}${second}</sections></column>`
    + `</columns></tab></tabs></form>`;
  // By name: the author's own section_notes sits after the host.
  const byName = await topoCheck(xml(`<section name="section_notes">${labelsOf('R')}<rows><row><cell><control datafieldname="new_notes" /></cell></row></rows></section>`),
    (spec) => { spec.forms[0].tabs[0].columns[1].sections[0].name = 'section_notes'; });
  assert.strictEqual(byName.present, true, `by name; got ${byName && byName.detail}`);
  // By label: the author's section was deployed under another name, and carries the host's label.
  const byLabel = await topoCheck(xml(`<section name="section_x"><labels><label description="Notes" languagecode="1033" /></labels><rows><row><cell><control datafieldname="new_notes" /></cell></row></rows></section>`),
    (spec) => Object.assign(spec.forms[0].tabs[0].columns[1].sections[0], { name: 'sec_renamed', label: 'Notes' }));
  assert.strictEqual(byLabel.present, true, `by label; got ${byLabel && byLabel.detail}`);
});

// Engine-owned is a STRUCTURE (only unbound controls), which cannot say who laid a section out: an
// authored section declared with no fields that a maker filled with a web resource looks the same. Its
// authored name is the evidence it is the author's, so verify finds it by that name — as the build does —
// instead of reporting it absent.
test('verify finds an authored section a maker filled with a control by its name', async () => {
  const xml = `<form><tabs><tab name="tab_overview">${labelsOf('Overview')}<columns>`
    + `<column width="60%"><sections>`
    + `<section name="sec_left">${labelsOf('L')}<rows><row><cell><control datafieldname="new_name" /></cell></row></rows></section>`
    + `<section name="sec_related">${labelsOf('Related')}<rows><row><cell><control id="WebResource_banner" classid="{9FDF5F91-88B1-47f4-AD53-C11EFC01A01D}" /></cell></row></rows></section>`
    + `</sections></column>`
    + `<column width="40%"><sections><section name="sec_right">${labelsOf('R')}<rows><row><cell><control datafieldname="new_notes" /></cell></row></rows></section></sections></column>`
    + `</columns></tab></tabs></form>`;
  const chk = await topoCheck(xml, (spec) => { spec.forms[0].tabs[0].columns[0].sections.push({ name: 'sec_related', label: 'Related', fields: [] }); });
  assert.strictEqual(chk.present, true, `the maker's control does not hide the authored section; got ${chk && chk.detail}`);
});

// Verify matches containers exactly as the build does, and the build no longer lets a label or
// position match take a section ANOTHER authored section owns by name (it moves that section to where
// its own want places it). Here the section NAMED sec_wide sits in tab_one holding sec_main's field,
// and an unnamed one in tab_two holds sec_wide's: every field is in the right tab, but a form script
// that addresses sec_wide by name reaches tab_one. Matching sec_main to it by label passed that form.
test('verify: the label pass skips a section another authored section owns by name', async () => {
  const section = (name, label, field) => `<section${name ? ` name="${name}"` : ''}><labels><label description="${label}" languagecode="1033"/></labels>`
    + `<rows><row><cell><control datafieldname="${field}" /></cell></row></rows></section>`;
  const tab = (name, label, sections) => `<tab name="${name}"><labels><label description="${label}" languagecode="1033"/></labels>`
    + `<columns><column width="100%"><sections>${sections}</sections></column></columns></tab>`;
  const twoTabs = (spec) => {
    spec.forms[0].tabs = [
      { name: 'tab_one', label: 'One', columns: [{ width: '100%', sections: [{ name: 'sec_main', label: 'Main', columns: 1, fields: ['new_name'] }] }] },
      { name: 'tab_two', label: 'Two', columns: [{ width: '100%', sections: [{ name: 'sec_wide', label: 'Wide', columns: 1, fields: ['new_notes'] }] }] },
    ];
  };
  const misnamed = `<form><tabs>${tab('tab_one', 'One', section('sec_wide', 'Main', 'new_name'))}${tab('tab_two', 'Two', section(null, 'Wide', 'new_notes'))}</tabs></form>`;
  const chk = await topoCheck(misnamed, twoTabs);
  assert.strictEqual(chk.present, false, 'a form whose sec_wide is in the wrong tab must not verify');
  assert.match(chk.detail, /section 'sec_main' is absent from tab 'tab_one'/);
  // Control: the shape the build produces for that spec verifies.
  const built = `<form><tabs>${tab('tab_one', 'One', section('sec_main', 'Main', 'new_name'))}${tab('tab_two', 'Two', section('sec_wide', 'Wide', 'new_notes'))}</tabs></form>`;
  const ok = await topoCheck(built, twoTabs);
  assert.strictEqual(ok.present, true, `got ${ok.detail}`);
});
// --- the verifier must match containers the way the BUILD does ------------------------------
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




// --- Label/exclusion tests, built so the LABEL pass is the only route to the right answer ------
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

const identityXml = (secondCellId, secondControlId, suffix = '') =>
  `<form><DisplayConditions Order="0"/><tabs><tab name="tab_overview"><labels><label description="Overview" languagecode="1033"/></labels><columns>`
  + `<column width="100%"><sections><section name="sec_left" columns="11"><labels><label description="L" languagecode="1033"/></labels><rows>`
  + `<row><cell id="00000000-0000-4000-8000-000000000001"><control id="new_name" datafieldname="new_name"/></cell>`
  + `<cell id="${secondCellId}"><control id="${secondControlId}" datafieldname="new_notes"/></cell></row>`
  + `</rows></section></sections></column></columns></tab></tabs>${suffix}</form>`;

for (const [what, cellId, controlId, detail] of [
  ['cell', '00000000-0000-4000-8000-000000000001', 'new_notes', /duplicate cell id/i],
  ['brace-wrapped cell', '{00000000-0000-4000-8000-000000000001}', 'new_notes', /duplicate cell id/i],
  ['control', '00000000-0000-4000-8000-000000000002', 'new_name', /duplicate control id/i],
]) {
  for (const explicit of [true, false]) {
    test(`form identities: duplicate ${what} ids fail ${explicit ? 'explicit' : 'auto'} verification`, async () => {
      const spec = TOPO_SPEC();
      if (explicit) shapeSpec(['new_name', 'new_notes'])(spec);
      else spec.forms = [{ entity: 'new_ticket', name: 'Ticket Main' }];
      const result = await verifySpec(spec, topoRead(identityXml(cellId, controlId)));
      assert.strictEqual(result.ok, false, 'field membership and occupancy cannot excuse a duplicated identity');
      assert.ok(result.missing.some((c) => detail.test(c.detail)), JSON.stringify(result.checks));
    });
  }
}

test('form identities: header and body controls share the form-wide uniqueness scope', async () => {
  const spec = TOPO_SPEC();
  shapeSpec(['new_name', 'new_notes'])(spec);
  const result = await verifySpec(spec, topoRead(identityXml('00000000-0000-4000-8000-000000000002', 'new_notes',
    '<header><control id="new_name" datafieldname="new_name"/></header>')));
  assert.strictEqual(result.ok, false);
  assert.ok(result.missing.some((c) => /duplicate control id.*new_name/i.test(c.detail)));
});

test('form identities: repeated field bindings with distinct ids and XML trivia are not duplicates', async () => {
  const spec = TOPO_SPEC();
  shapeSpec(['new_name', 'new_notes'])(spec);
  const xml = identityXml('00000000-0000-4000-8000-000000000002', 'new_notes',
    '<header><control id="header_new_name" datafieldname="new_name"/></header>'
    + '<!-- <cell id="00000000-0000-4000-8000-000000000001"><control id="new_name"/></cell> -->'
    + '<opaque><![CDATA[<control id="new_name"/>]]></opaque>');
  const result = await verifySpec(spec, topoRead(xml));
  assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
});

test('form identities: an auto form without a readable XML source cannot claim verified identities', async () => {
  const spec = TOPO_SPEC();
  spec.forms = [{ entity: 'new_ticket', name: 'Ticket Main' }];
  const read = topoRead(null);
  delete read.formTopology;
  const result = await verifySpec(spec, read);
  assert.strictEqual(result.ok, false);
  assert.ok(result.missing.some((c) => /identit|layout.*unverified/i.test(c.detail)));
});

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

// --- a span the COMPILER clamps must verify against its effective value --------------------
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

// --- a same-named section in ANOTHER tab must not satisfy the placement --------------------
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

// --- Verify proves the ORDER, form-column WIDTHS and display STATE a layout declares ------------------
//
// Each of these deployed wrong and verified PASS: a form-column's width, a tab's or section's visibility,
// expansion or label display, a field's hidden or read-only state, and the order of tabs and of the
// sections in a form-column. The build converges every one of them, so each is now proven — against what
// the COMPILER emits, so an undeclared width is the equal split and an undeclared flag is `true`.
const attrsOf = (o) => Object.entries(o || {}).map(([k, v]) => ` ${k}="${v}"`).join('');
const layoutXml = (tabs) => '<form><tabs>' + tabs.map((t) => `<tab name="${t.name}"${attrsOf(t.attrs)}>${labelsOf(t.label)}<columns>`
  + t.columns.map((c) => `<column width="${c.width}"><sections>`
    + c.sections.map((s) => `<section name="${s.name}" columns="1"${attrsOf(s.attrs)}>${labelsOf(s.label)}<rows>`
      + (s.cells || []).map((cell) => `<row><cell${attrsOf(cell.attrs)}><control datafieldname="${cell.field}"${attrsOf(cell.control)} /></cell></row>`).join('')
      + '</rows></section>').join('')
    + '</sections></column>').join('')
  + '</columns></tab>').join('') + '</tabs></form>';
// TOPO_SPEC's form as deployed — tab_overview at 60%/40%, sec_left holding new_name, sec_right new_notes, each labelled as the spec
// authors it (Overview / L / R, in 1033) — with every display flag absent unless a test sets it. `tabLabel`, `leftLabel` and `rightLabel`
// say what a test publishes instead (see labelsOf; `null` publishes none).
const overview = (over = {}) => ({ name: 'tab_overview', attrs: over.tab, label: 'tabLabel' in over ? over.tabLabel : 'Overview', columns: [
  { width: over.leftWidth || '60%', sections: [{ name: 'sec_left', attrs: over.left, label: 'leftLabel' in over ? over.leftLabel : 'L', cells: [{ field: 'new_name', attrs: over.nameCell, control: over.nameControl }] }] },
  { width: over.rightWidth || '40%', sections: [{ name: 'sec_right', attrs: over.right, label: 'rightLabel' in over ? over.rightLabel : 'R', cells: [{ field: 'new_notes' }] }] },
] });

test('verify FAILS a form-column deployed at a width the spec does not declare', async () => {
  const chk = await topoCheck(layoutXml([overview({ leftWidth: '10%', rightWidth: '90%' })]));
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /tab_overview' form-column 1 is deployed 10% wide, the spec declares 60%/);
  assert.match(chk.detail, /tab_overview' form-column 2 is deployed 90% wide, the spec declares 40%/);
  const same = await topoCheck(layoutXml([overview()]));
  assert.strictEqual(same.present, true, same.detail);
});

test('verify expects the compiler\'s equal split for a width the spec leaves out', async () => {
  const undeclared = (spec) => { for (const c of spec.forms[0].tabs[0].columns) delete c.width; };
  const split = await topoCheck(layoutXml([overview({ leftWidth: '50%', rightWidth: '50%' })]), undeclared);
  assert.strictEqual(split.present, true, split.detail);
  const chk = await topoCheck(layoutXml([overview()]), undeclared);
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /form-column 1 is deployed 60% wide, the spec declares 50%/);
});

test('verify FAILS a tab or section whose display state differs from the spec', async () => {
  const hideAll = (spec) => {
    const t = spec.forms[0].tabs[0];
    Object.assign(t, { visible: false, expanded: false });
    Object.assign(t.columns[0].sections[0], { visible: false, showLabel: false });
  };
  // Every flag absent — the attributes a form nobody set them on carries — reads as the rendered default.
  const chk = await topoCheck(layoutXml([overview()]), hideAll);
  assert.strictEqual(chk.present, false);
  for (const re of [
    /tab 'tab_overview' is deployed with expanded="true" \(absent, the default\), the spec declares expanded: false/,
    /tab 'tab_overview' is deployed with visible="true" \(absent, the default\), the spec declares visible: false/,
    /section 'sec_left' is deployed with visible="true" \(absent, the default\), the spec declares visible: false/,
    /section 'sec_left' is deployed with showlabel="true" \(absent, the default\), the spec declares showLabel: false/,
  ]) assert.match(chk.detail, re);
  const applied = await topoCheck(layoutXml([overview({ tab: { expanded: 'false', visible: 'false' }, left: { visible: 'false', showlabel: 'false' } })]), hideAll);
  assert.strictEqual(applied.present, true, applied.detail);
  // …and a spec that declares none of them expects a shown, expanded, labelled layout (xs:boolean "0" too).
  const hidden = await topoCheck(layoutXml([overview({ tab: { visible: 'false' }, right: { showlabel: '0' } })]));
  assert.strictEqual(hidden.present, false);
  assert.match(hidden.detail, /tab 'tab_overview' is deployed with visible="false", the spec declares visible: true/);
  assert.match(hidden.detail, /section 'sec_right' is deployed with showlabel="false", the spec declares showLabel: true/);
});

// FormXML booleans are xs:boolean — "1" and "0" are as valid as "true" and "false", and Dataverse writes either.
test('verify reads xs:boolean "1" and "0" in a control\'s disabled state', async () => {
  const readOnly = (spec) => { spec.forms[0].fieldOptions = { new_name: { readOnly: true } }; };
  const one = await topoCheck(layoutXml([overview({ nameControl: { disabled: '1' } })]), readOnly);
  assert.strictEqual(one.present, true, one.detail);
  const zero = await topoCheck(layoutXml([overview({ nameControl: { disabled: '0' } })]), readOnly);
  assert.strictEqual(zero.present, false);
  assert.match(zero.detail, /field 'new_name' is deployed with disabled="false", the spec declares readOnly: true/);
});

// A quick view binds a lookup's datafieldname too, but it is not that field. Read as the field, it lent the field its
// state and its section: a quick view placed FIRST made a correctly deployed form fail, and the opposite flags would
// have passed a wrong one. Verify skips it, as the build does when it picks the cell to patch.
test('verify reads a field\'s state and placement from the field, never from a quick view bound to it', async () => {
  const QV = '{5C5600E0-1D6E-4205-A272-BE80DA87FD42}';
  const form = (realName) => layoutXml([{ name: 'tab_overview', label: 'Overview', columns: [
    { width: '60%', sections: [{ name: 'sec_left', label: 'L', cells: [
      { field: 'new_notes', control: { classid: QV } },
      { field: 'new_name', control: { classid: QV } },
      { field: 'new_name', control: realName },
    ] }] },
    { width: '40%', sections: [{ name: 'sec_right', label: 'R', cells: [{ field: 'new_notes' }] }] },
  ] }]);
  const readOnly = (spec) => { spec.forms[0].tabs[0].columns[0].sections[0].fields = [{ name: 'new_name', readOnly: true }]; };
  const ok = await topoCheck(form({ disabled: 'true' }), readOnly);
  assert.strictEqual(ok.present, true, ok.detail);
  // CONTROL — the real field still decides: editable, it fails, whatever the quick view says.
  const bad = await topoCheck(form({ disabled: 'false' }), readOnly);
  assert.strictEqual(bad.present, false);
  assert.match(bad.detail, /field 'new_name' is deployed with disabled="false", the spec declares readOnly: true/);
  assert.doesNotMatch(bad.detail, /new_notes/, 'the quick view bound to new_notes does not place new_notes in sec_left');
  // An auto layout's field state is read the same way.
  const auto = TOPO_SPEC();
  auto.forms = [{ entity: 'new_ticket', name: 'Ticket Main', fieldOptions: { new_name: { readOnly: true } } }];
  const state = async (xml) => ((await verifySpec(auto, topoRead(xml))).checks || []).find((c) => c.kind === 'form-field-state');
  assert.strictEqual((await state(form({ disabled: 'true' }))).present, true);
  assert.strictEqual((await state(form({ disabled: 'false' }))).present, false);
});

test('verify FAILS a field the spec declares hidden and read-only that deployed shown and editable', async () => {
  const flagged = (spec) => { spec.forms[0].tabs[0].columns[0].sections[0].fields = [{ name: 'new_name', hidden: true, readOnly: true }]; };
  const chk = await topoCheck(layoutXml([overview()]), flagged);
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /field 'new_name' is deployed with visible="true" \(absent, the default\), the spec declares hidden: true/);
  assert.match(chk.detail, /field 'new_name' is deployed with disabled="false" \(absent, the default\), the spec declares readOnly: true/);
  const applied = await topoCheck(layoutXml([overview({ nameCell: { visible: 'false' }, nameControl: { disabled: 'true' } })]), flagged);
  assert.strictEqual(applied.present, true, applied.detail);
});

test('verify proves a read-only flag declared through form-level fieldOptions on a plain entry', async () => {
  const viaOptions = (spec) => { spec.forms[0].fieldOptions = { new_name: { readOnly: true } }; };
  const chk = await topoCheck(layoutXml([overview()]), viaOptions);
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /field 'new_name' .*readOnly: true/);
  const applied = await topoCheck(layoutXml([overview({ nameControl: { disabled: 'true' } })]), viaOptions);
  assert.strictEqual(applied.present, true, applied.detail);
});

test('verify FAILS tabs, or the sections of a form-column, deployed out of the layout\'s order', async () => {
  const twoTabs = (spec) => { spec.forms[0].tabs.push({ name: 'tab_more', label: 'More', sections: [{ name: 'sec_more', label: 'M', fields: [] }] }); };
  const more = { name: 'tab_more', label: 'More', columns: [{ width: '100%', sections: [{ name: 'sec_more', label: 'M' }] }] };
  const chk = await topoCheck(layoutXml([more, overview()]), twoTabs);
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /the tabs are deployed in the order tab_more, tab_overview; the spec orders them tab_overview, tab_more/);
  const maker = { name: 'tab_maker', columns: [{ width: '100%', sections: [{ name: 'sec_maker' }] }] };
  const inOrder = await topoCheck(layoutXml([overview(), maker, more]), twoTabs);
  assert.strictEqual(inOrder.present, true, `a maker's own tab between them is not disorder; got ${inOrder.detail}`);

  const twoSections = (spec) => { spec.forms[0].tabs[0].columns[0].sections.push({ name: 'sec_left2', label: 'L2', fields: [] }); };
  const swapped = overview();
  swapped.columns[0].sections.unshift({ name: 'sec_left2', label: 'L2' });
  const secChk = await topoCheck(layoutXml([swapped]), twoSections);
  assert.strictEqual(secChk.present, false);
  assert.match(secChk.detail, /the sections of tab 'tab_overview' form-column 1 are deployed in the order sec_left2, sec_left; the spec orders them sec_left, sec_left2/);
  const ordered = overview();
  ordered.columns[0].sections.push({ name: 'sec_left2', label: 'L2' });
  const secOrdered = await topoCheck(layoutXml([ordered]), twoSections);
  assert.strictEqual(secOrdered.present, true, secOrdered.detail);
});

// An AUTO layout has no shape to prove, but its fieldOptions flags are asserted by the build on every
// apply — so they are proven on their own, and an unreadable form is not proven.
test('verify proves the read-only and hidden flags an AUTO layout declares in fieldOptions', async () => {
  // new_notes is a declared column, so the auto layout places it — and the build asserts its flag.
  const autoForm = (flags) => (spec) => {
    spec.entities[0].columns = [{ schemaName: 'new_notes', displayName: 'Notes', type: 'Text' }];
    spec.forms = [{ entity: 'new_ticket', name: 'Ticket Main', fieldOptions: flags }];
  };
  const checks = async (xml, mutate, over) => {
    const spec = TOPO_SPEC();
    mutate(spec);
    const res = await verifySpec(spec, topoRead(xml, over));
    return { state: (res.checks || []).filter((c) => c.kind === 'form-field-state'), topo: (res.checks || []).filter((c) => c.kind === 'form-topology') };
  };
  const flags = autoForm({ new_name: { readOnly: true }, new_notes: { hidden: true } });
  const bare = await checks(layoutXml([overview()]), flags);
  assert.strictEqual(bare.topo.length, 0, 'an auto layout still has no topology to prove');
  assert.strictEqual(bare.state.length, 1);
  assert.strictEqual(bare.state[0].present, false);
  assert.match(bare.state[0].detail, /field 'new_name' .*readOnly: true/);
  assert.match(bare.state[0].detail, /field 'new_notes' .*hidden: true/);
  const appliedXml = layoutXml([overview({ nameControl: { disabled: 'true' } })])
    .replace('<cell><control datafieldname="new_notes"', '<cell visible="false"><control datafieldname="new_notes"');
  const applied = await checks(appliedXml, flags);
  assert.strictEqual(applied.state[0].present, true, applied.state[0].detail);
  assert.strictEqual((await checks(layoutXml([overview()]), autoForm({ new_name: { after: 'new_notes' } }))).state.length, 0, 'nothing to prove without a flag');
  const unreadable = await checks(null, flags, { formTopology: async () => { throw new Error('boom'); } });
  assert.strictEqual(unreadable.state[0].present, false);
  assert.match(unreadable.state[0].detail, /could not read/);
});

// The auto layout places every field it flags, so a flagged field the deployed form does not carry is a mismatch —
// skipping it passed a form whose read-only field a maker had removed. A flag on a field the auto layout never
// places is never written by the build, so it is not proven: checking it failed a stock field the build never touched.
test('verify FAILS an auto layout\'s flagged field that is missing, and ignores a flag the build never writes', async () => {
  const spec = (fieldOptions) => {
    const s = TOPO_SPEC();
    s.entities[0].columns = [{ schemaName: 'new_notes', displayName: 'Notes', type: 'Text' }];
    s.forms = [{ entity: 'new_ticket', name: 'Ticket Main', fieldOptions }];
    return s;
  };
  const stateOf = async (s, xml) => ((await verifySpec(s, topoRead(xml))).checks || []).filter((c) => c.kind === 'form-field-state');
  // new_notes is flagged and placed by the layout, but the deployed form only carries new_name.
  const onlyName = layoutXml([{ name: 'tab_overview', columns: [{ width: '100%', sections: [{ name: 'sec_left', cells: [{ field: 'new_name', control: { disabled: 'true' } }] }] }] }]);
  const missing = await stateOf(spec({ new_name: { readOnly: true }, new_notes: { hidden: true, readOnly: true } }), onlyName);
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].present, false);
  assert.match(missing[0].detail, /field 'new_notes' is not on the deployed form, so its readOnly: true and hidden: true is not deployed/);
  assert.doesNotMatch(missing[0].detail, /new_name/, 'the field that is there and locked passes');

  // ownerid is not a field the auto layout places (not the primary, not a declared column, not a lookup), so the
  // build never writes its flag: it is not proven — present and editable, or absent — and alone it adds no check.
  const withOwner = layoutXml([overview({ nameControl: { disabled: 'true' } })]).replace('</rows></section></sections></column></columns>',
    '<row><cell><control datafieldname="ownerid" /></cell></row></rows></section></sections></column></columns>');
  const stock = await stateOf(spec({ new_name: { readOnly: true }, ownerid: { readOnly: true } }), withOwner);
  assert.deepStrictEqual(stock.map((c) => c.present), [true], stock.map((c) => c.detail).join(' | '));
  assert.deepStrictEqual(await stateOf(spec({ ownerid: { readOnly: true } }), withOwner), [], 'no flag the build writes, no check');

  // A spec validation would refuse (a table with no primary column) cannot say which fields the layout places:
  // reported as unverified, never a crash and never a pass.
  const noPrimary = spec({ new_notes: { hidden: true } });
  delete noPrimary.entities[0].primaryAttribute;
  const unverified = await stateOf(noPrimary, withOwner);
  assert.deepStrictEqual(unverified.map((c) => c.present), [false]);
  assert.match(unverified[0].detail, /could not compile the layout to tell which fields the build places[\s\S]*unverified, not proven correct/);
});

// --- A form's LABELS are proven too: a relabel that never reached the published form is not a pass --------------------
//
// The build converges a matched tab's and section's label to the one the layout declares, and --verify matched containers by it
// without ever comparing the result: a form whose relabel was saved but never went live (live-measured: a form's labels keep their
// published text through a publish of the app that runs before the table's own) matched by NAME, kept the old label and verified PASS.
// The published form is compared language by language. A label is a (languagecode, description) pair, so the spec's text is the spec's
// only in the language it is declared in — the build's authoring language for a string, each entry's own LCID for a localized label (a
// map keyed by LCID) — and a translation a maker added beside it neither satisfies nor fails it. Only a label the spec AUTHORS is held
// (a container it leaves unlabelled gets the compiler's default from the build, which the spec never asked for); and one the published
// container does not carry in that language, or at all, is a mismatch: nothing published is no proof of the caption.
const relabelled = (spec) => { // TOPO_SPEC's layout, with the tab and the left section renamed in the spec
  Object.assign(spec.forms[0].tabs[0], { label: 'Summary' });
  Object.assign(spec.forms[0].tabs[0].columns[0].sections[0], { label: 'Left' });
};
const authoredTab = (label) => (spec) => { spec.forms[0].tabs[0].label = label; };
const unlabelled = (spec) => { // a layout that authors no label at all
  delete spec.forms[0].tabs[0].label;
  for (const column of spec.forms[0].tabs[0].columns) delete column.sections[0].label;
};
const FORM_ROW = [{ formid: 'f1', name: 'Ticket Main', objecttypecode: 'new_ticket', type: 2, isdefault: true }];
// A reader whose organization answers `languagecode` — what the build resolves a string label's language from when the spec pins none
// (an absent one answers no row) — and which records each such read.
const inOrg = (languagecode, seen = []) => ({ queryRecords: async (set, o) => {
  if (set === 'organization') { seen.push(o); return languagecode === undefined ? [] : [{ languagecode }]; }
  return set === 'systemform' ? FORM_ROW : [];
} });
const topoCheckIn = async (xml, mutate, over) => {
  const spec = TOPO_SPEC();
  if (mutate) mutate(spec);
  return (await verifySpec(spec, topoRead(xml, over))).checks.find((c) => c.kind === 'form-topology');
};

test('verify FAILS a tab and a section the spec relabelled that the published form still labels as before', async () => {
  const chk = await topoCheck(layoutXml([overview()]), relabelled);
  assert.strictEqual(chk.present, false, 'a relabel that never went live must not verify');
  assert.match(chk.detail, /tab 'tab_overview' is deployed with label "Overview" in language 1033, the spec declares label: "Summary" in language 1033/);
  assert.match(chk.detail, /section 'sec_left' is deployed with label "L" in language 1033, the spec declares label: "Left" in language 1033/);
  assert.doesNotMatch(chk.detail, /sec_right/, 'the section the spec did not relabel is not reported');
});

test('verify PASSES once the published labels are the spec\'s, and for a layout that never relabelled anything', async () => {
  const live = await topoCheck(layoutXml([overview({ tabLabel: 'Summary', leftLabel: 'Left' })]), relabelled);
  assert.strictEqual(live.present, true, live.detail);
  const untouched = await topoCheck(layoutXml([overview()]));
  assert.strictEqual(untouched.present, true, untouched.detail);
});

test('verify holds only a label the spec AUTHORS: a tab or section it leaves unlabelled keeps whatever caption the published form has', async () => {
  // The compiler's `General` / `Details` default is what the build writes on create and fills in on a rebuild, but the spec
  // never asked for it — and a maker's own caption on such a container is not a relabel that failed to land.
  const customised = await topoCheck(layoutXml([overview({ tabLabel: 'Maker caption', leftLabel: 'Maker left' })]), unlabelled);
  assert.strictEqual(customised.present, true, customised.detail);
  // …even a container with no label published at all.
  const bare = await topoCheck(layoutXml([overview({ tabLabel: null, leftLabel: null, rightLabel: null })]), unlabelled);
  assert.strictEqual(bare.present, true, bare.detail);
  // An empty label is "none", exactly as the compiler reads it.
  const blank = (spec) => { spec.forms[0].tabs[0].label = ''; spec.forms[0].tabs[0].columns[0].sections[0].label = ''; spec.forms[0].tabs[0].columns[1].sections[0].label = ''; };
  assert.strictEqual((await topoCheck(layoutXml([overview({ tabLabel: 'Maker caption', leftLabel: 'Maker left' })]), blank)).present, true);
  // The label the spec DOES author on the other section is still held to.
  const oneAuthored = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].columns[1].sections[0].label = 'Right'; };
  const chk = await topoCheck(layoutXml([overview()]), oneAuthored);
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /section 'sec_right' is deployed with label "R" in language 1033, the spec declares label: "Right" in language 1033/);
  assert.doesNotMatch(chk.detail, /sec_left/);
});

test('verify FAILS a label the spec declares in the build\'s language when only ANOTHER language carries that text', async () => {
  // The wanted caption exists — in French. The English relabel the build was asked for is not the French one that happened to match.
  const xml = layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Summary', lcid: 1036 }] })]);
  const chk = await topoCheck(xml, (spec) => { spec.languageCode = 1033; authoredTab('Summary')(spec); });
  assert.strictEqual(chk.present, false, 'the text is deployed, but not in the language the build writes');
  assert.match(chk.detail, /tab 'tab_overview' is deployed with label "Overview" in language 1033, the spec declares label: "Summary" in language 1033/);
  // The French one is right when it is the build's language.
  const french = await topoCheck(xml, (spec) => { spec.languageCode = 1036; authoredTab('Summary')(spec); delete spec.forms[0].tabs[0].columns[0].sections[0].label; delete spec.forms[0].tabs[0].columns[1].sections[0].label; });
  assert.strictEqual(french.present, true, french.detail);
});

test('verify tolerates a translation a maker added beside the spec\'s label — in any order — and does not require one', async () => {
  const inOrder = layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Uebersicht', lcid: 1031 }, { text: 'Apercu', lcid: 1036 }] })]);
  const reversed = layoutXml([overview({ tabLabel: [{ text: 'Apercu', lcid: 1036 }, { text: 'Uebersicht', lcid: 1031 }, { text: 'Overview', lcid: 1033 }] })]);
  for (const xml of [inOrder, reversed]) {
    const chk = await topoCheck(xml);
    assert.strictEqual(chk.present, true, chk.detail);
  }
  const alone = await topoCheck(layoutXml([overview()]));
  assert.strictEqual(alone.present, true, 'one language is all a string label asks for');
});

test('verify holds a string label to the language the SPEC pins — not to whichever language carries the text', async () => {
  const xml = layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Uebersicht', lcid: 1031 }] })]);
  const german = (label) => (spec) => { spec.languageCode = 1031; unlabelled(spec); spec.forms[0].tabs[0].label = label; };
  assert.strictEqual((await topoCheck(xml, german('Uebersicht'))).present, true, 'the build writes 1031: that label is the spec\'s');
  const chk = await topoCheck(xml, german('Overview'));
  assert.strictEqual(chk.present, false, 'the English caption is a translation beside the German one the build writes');
  assert.match(chk.detail, /tab 'tab_overview' is deployed with label "Uebersicht" in language 1031, the spec declares label: "Overview" in language 1031/);
});

test('verify holds a string label to the ORGANIZATION\'s base language when the spec pins none — the build\'s own resolution — read once', async () => {
  const xml = layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Apercu', lcid: 1036 }], leftLabel: { text: 'L', lcid: 1036 }, rightLabel: { text: 'R', lcid: 1036 } })]);
  const seen = [];
  assert.strictEqual((await topoCheckIn(xml, authoredTab('Apercu'), inOrg(1036, seen))).present, true, 'a French organization: the build wrote 1036');
  assert.strictEqual(seen.length, 1, 'one read of the organization, for the three labels this layout authors');
  assert.deepStrictEqual(seen[0], { select: ['languagecode'], top: 1 });
  const chk = await topoCheckIn(xml, authoredTab('Overview'), inOrg(1036));
  assert.strictEqual(chk.present, false, 'the English caption is not the one written in the French organization\'s language');
  assert.match(chk.detail, /tab 'tab_overview' is deployed with label "Apercu" in language 1036, the spec declares label: "Overview" in language 1036/);
  // An organization that answers no language is NOT taken for an English one — see the unverified tests below.
});

test('verify reads the organization only when a form authors a STRING label and the spec pins no language', async () => {
  const seen = [];
  const pinned = await topoCheckIn(layoutXml([overview()]), (spec) => { spec.languageCode = 1033; }, inOrg(1036, seen));
  assert.strictEqual(pinned.present, true, 'the spec\'s languageCode is the build\'s language, whatever the organization says');
  const onlyMaps = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 1033: 'Overview' }; };
  await topoCheckIn(layoutXml([overview()]), onlyMaps, inOrg(1036, seen));
  await topoCheckIn(layoutXml([overview()]), unlabelled, inOrg(1036, seen));
  assert.strictEqual(seen.length, 0, 'no read for a pinned language, for localized labels alone, or for a layout with no labels');
});

// --- The language a string label is held to is the one the BUILD wrote it in — which verify has to be TOLD, or establish ---------------------------
//
// The build resolves its authoring language from the `--language-code` flag, else the spec's `languageCode`, else the organization's base
// language; its SDK is made for the result, and every label it writes is in it. A build run with the flag in an organization whose base
// language is another one published its captions in the flag's language, so verify, holding them to the organization's, called the correct
// caption missing. `--verify` takes the same options the build does (verifySpec's `languageCode`, and `preResolvedLanguageCode` — what the
// build's SDK was made for) and uses them first. And when the language cannot be established at all — the organization does not answer —
// it says so: a language it had to guess would pass a stale caption as readily as it would fail a correct one.
const checkWith = async (xml, mutate, over, opts) => {
  const spec = TOPO_SPEC();
  mutate(spec);
  const res = await verifySpec(spec, topoRead(xml, over), opts);
  return { res, chk: res.checks.find((c) => c.kind === 'form-topology') };
};
// TOPO_SPEC's three captions, written in French by the spec (the tab, and the section on each side).
const inFrench = (spec) => {
  authoredTab('Apercu')(spec);
  spec.forms[0].tabs[0].columns[0].sections[0].label = 'Gauche';
  spec.forms[0].tabs[0].columns[1].sections[0].label = 'Droite';
};
const publishedInFrench = () => layoutXml([overview({ tabLabel: { text: 'Apercu', lcid: 1036 }, leftLabel: { text: 'Gauche', lcid: 1036 }, rightLabel: { text: 'Droite', lcid: 1036 } })]);

test('verify holds a string label to the language the BUILD was run in — the options carry it, and it outranks the spec and the organization', async () => {
  const seen = [];
  for (const [what, opts, mutate] of [
    ['the --language-code the build was given', { languageCode: 1036 }, inFrench],
    ['the language the build resolved, which its SDK was made for', { preResolvedLanguageCode: 1036 }, inFrench],
    ['both, as the build hands them over', { languageCode: 1036, preResolvedLanguageCode: 1036 }, inFrench],
    ['the flag, as the build\'s override of the spec\'s own languageCode', { languageCode: 1036 }, (spec) => { inFrench(spec); spec.languageCode = 1033; }],
    ['the resolved language, above the flag it came from', { languageCode: 1033, preResolvedLanguageCode: 1036 }, inFrench],
    ['a numeric string, as a CLI hands it over', { languageCode: '1036' }, inFrench],
  ]) {
    const { chk } = await checkWith(publishedInFrench(), mutate, inOrg(1033, seen), opts);
    assert.strictEqual(chk.present, true, `${what}: ${chk.detail}`);
  }
  assert.strictEqual(seen.length, 0, 'the organization is not read when the build\'s own language is known');
});

test('verify keeps the language strict when the build\'s language is known and the read carries it — a caption in another language never stands in for it', async () => {
  // The published form carries French on its sections and only the English caption on the tab: the tab's French caption is missing, and the English one is not it.
  const english = layoutXml([overview({ leftLabel: { text: 'Gauche', lcid: 1036 }, rightLabel: { text: 'Droite', lcid: 1036 } })]);
  const { chk } = await checkWith(english, inFrench, inOrg(1033), { languageCode: 1036 });
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /tab 'tab_overview' is deployed with no label in language 1036 \(it has "Overview" in 1033\), the spec declares label: "Apercu" in language 1036/);
  assert.doesNotMatch(chk.detail, /compared in the organization's base language/, 'the language was given, not guessed from the organization: no hint to give it');
  // …and a wrong text in the given language is a mismatch like any other.
  const stale = layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Ancien', lcid: 1036 }] })]);
  const wrong = await checkWith(stale, inFrench, inOrg(1033), { languageCode: 1036 });
  assert.strictEqual(wrong.chk.present, false);
  assert.match(wrong.chk.detail, /tab 'tab_overview' is deployed with label "Ancien" in language 1036, the spec declares label: "Apercu" in language 1036/);
});

test('verify tells a maker what to do when the labels were compared in the ORGANIZATION\'s language and that is not the language they are in', async () => {
  // Nothing says the build used another language, so the organization's is the build's — and a build that did leaves captions this cannot match. Where the
  // read carries no label in that language at all, they are listed unverified, with the flag that settles it …
  const french = await checkWith(publishedInFrench(), inFrench, inOrg(1033));
  assert.strictEqual(french.chk.present, true, french.chk.detail);
  assert.strictEqual(french.res.unverified.length, 1, JSON.stringify(french.res.unverified));
  assert.match(french.res.unverified[0], /in language 1033 were not compared: the environment's form read returns labels only in 1036, so labels written in 1033 cannot be read back from it\./);
  assert.match(french.res.unverified[0], /\(verify used the organization's base language, because it was told no other: if the build was run with --language-code, give verify the same flag, or pin "languageCode" in the spec\)\)$/);
  // … and where it carries that language elsewhere in the form, the mismatch is a failure, which carries the same advice.
  const frenchTab = layoutXml([overview({ tabLabel: { text: 'Apercu', lcid: 1036 } })]);
  const { chk } = await checkWith(frenchTab, (spec) => { unlabelled(spec); authoredTab('Apercu')(spec); }, inOrg(1033));
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /tab 'tab_overview' is deployed with no label in language 1033 \(it has "Apercu" in 1036\), the spec declares label: "Apercu" in language 1033/);
  assert.match(chk.detail, /the labels were compared in the organization's base language \(1033\), because verify was told no other: if the build was run with --language-code, give verify the same flag \(or pin "languageCode" in the spec\)/);
  // A spec that pins the language is verified in it, with no such advice.
  const pinned = await checkWith(publishedInFrench(), (spec) => { inFrench(spec); spec.languageCode = 1036; }, inOrg(1033));
  assert.strictEqual(pinned.chk.present, true, pinned.chk.detail);
  assert.strictEqual(pinned.res.unverified, undefined, 'a language that is known is not a guess to warn about');
});

test('verify ignores an option that is no LCID, as the build does: the spec\'s language, then the organization\'s, decide', async () => {
  for (const bad of ['de-DE', true, 0, 65536, [1036], '1e3']) {
    const { chk } = await checkWith(publishedInFrench(), inFrench, inOrg(1036), { languageCode: bad });
    assert.strictEqual(chk.present, true, `${JSON.stringify(bad)} is not a language: the organization's 1036 decides — ${chk.detail}`);
  }
});

test('verify reports the labels UNVERIFIED — neither passed nor failed — when the language the build wrote them in cannot be established', async () => {
  const failures = [
    ['the organization read fails', { queryRecords: async (set) => { if (set === 'organization') throw new Error('HTTP 503 reading organization'); return set === 'systemform' ? FORM_ROW : []; } }, /\(the organization read failed: HTTP 503 reading organization\)/],
    ['the organization answers no row', inOrg(undefined), /\(organization\.languagecode was missing or not a valid LCID\)/],
    ['the organization answers a language that is no LCID', inOrg('not-a-language'), /\(organization\.languagecode was missing or not a valid LCID\)/],
  ];
  const baseline = await checkWith(layoutXml([overview()]), () => {}, inOrg(1033));
  for (const [what, over, reason] of failures) {
    const { res, chk } = await checkWith(layoutXml([overview()]), () => {}, over);
    assert.strictEqual(chk.present, true, `${what}: the rest of the layout is right and nothing says the labels are wrong: ${chk.detail}`);
    // The fixture has one unrelated failure of its own (it publishes no form order): unverified neither adds to the failures nor takes one away.
    assert.deepStrictEqual(res.missing, baseline.res.missing, `${what}: unverified is not a failure`);
    assert.strictEqual(res.ok, baseline.res.ok, what);
    assert.ok(Array.isArray(res.unverified) && res.unverified.length === 1, `${what}: ${JSON.stringify(res.unverified)}`);
    const [entry] = res.unverified;
    assert.match(entry, /^form-labels:new_ticket\.Ticket Main \(the labels of tab 'tab_overview', section 'sec_left', section 'sec_right' were not compared: the language the build wrote them in could not be established /, what);
    assert.match(entry, reason, `${what}: the reason is given`);
    assert.match(entry, /\. Pass --language-code <lcid> \(the one the build was run with\) or set "languageCode" in the spec to compare them\)$/, `${what}: and what to do`);
    assert.ok(!res.checks.some((c) => /label/i.test(c.kind)), `${what}: no label check was recorded as passed or failed`);
  }
});

test('verify no longer passes a STALE caption when the organization cannot be read — and no longer fails a CORRECT one', async () => {
  // The form holds the right text in 1033 and a stale one in 1036: held to French (the organization's language, once known) it fails; with
  // the language unknown it is not judged — it used to PASS on a guessed 1033.
  const tabOnly = (label) => (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = label; };
  const stale = layoutXml([overview({ tabLabel: [{ text: 'Apercu', lcid: 1033 }, { text: 'Ancien', lcid: 1036 }], leftLabel: null, rightLabel: null })]);
  const known = await checkWith(stale, tabOnly('Apercu'), inOrg(1036));
  assert.strictEqual(known.chk.present, false, 'held to 1036, the stale caption fails');
  const unreadable = { queryRecords: async (set) => { if (set === 'organization') throw new Error('503'); return set === 'systemform' ? FORM_ROW : []; } };
  const unknown = await checkWith(stale, tabOnly('Apercu'), unreadable);
  assert.strictEqual(unknown.res.unverified.length, 1, 'neither a pass nor a fail of that caption: it is reported unverified');
  assert.match(unknown.res.unverified[0], /\(the label of tab 'tab_overview' was not compared: the language the build wrote it in could not be established \(the organization read failed: 503\)\. Pass --language-code/);
  // A correct French caption fails on a guessed English language no more: it is unverified, and verifies once the language is given.
  const french = publishedInFrench();
  const correct = await checkWith(french, inFrench, unreadable);
  assert.strictEqual(correct.chk.present, true, correct.chk.detail);
  assert.strictEqual(correct.res.unverified.length, 1);
  const given = await checkWith(french, inFrench, unreadable, { languageCode: 1036 });
  assert.strictEqual(given.chk.present, true, given.chk.detail);
  assert.strictEqual(given.res.unverified, undefined, 'told the language, verify has nothing left it cannot tell');
  const pinned = await checkWith(french, (spec) => { inFrench(spec); spec.languageCode = 1036; }, unreadable);
  assert.strictEqual(pinned.chk.present, true, pinned.chk.detail);
  assert.strictEqual(pinned.res.unverified, undefined, 'a language the spec pins needs no organization read');
});

test('verify still holds every other part of the layout — and every label map — while the language of the string labels is unknown', async () => {
  const unreadable = { queryRecords: async (set) => { if (set === 'organization') throw new Error('503'); return set === 'systemform' ? FORM_ROW : []; } };
  // A form-column at the wrong width fails, whatever the labels' language.
  const wide = await checkWith(layoutXml([overview({ leftWidth: '10%', rightWidth: '90%' })]), () => {}, unreadable);
  assert.strictEqual(wide.chk.present, false);
  assert.match(wide.chk.detail, /form-column 1 is deployed 10% wide, the spec declares 60%/);
  assert.strictEqual(wide.res.unverified.length, 1, 'and the labels are still reported unverified');
  // A label map is compared at the LCIDs it declares, which need no organization: a wrong entry fails, a right one passes, and neither is "unverified".
  const declared = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 1033: 'Overview', 1036: 'Apercu' }; };
  const right = await checkWith(layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Apercu', lcid: 1036 }] })]), declared, unreadable);
  assert.strictEqual(right.chk.present, true, right.chk.detail);
  assert.strictEqual(right.res.unverified, undefined, 'no string label, nothing it cannot tell');
  const wrong = await checkWith(layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Old', lcid: 1036 }] })]), declared, unreadable);
  assert.strictEqual(wrong.chk.present, false);
  assert.match(wrong.chk.detail, /tab 'tab_overview' is deployed with label "Old" in language 1036, the spec declares label: "Apercu" in language 1036/);
  // A map beside a string label: the map is compared, the string is unverified.
  const mixed = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 1033: 'Overview' }; spec.forms[0].tabs[0].columns[0].sections[0].label = 'Left'; };
  const both = await checkWith(layoutXml([overview({ leftLabel: 'Left' })]), mixed, unreadable);
  assert.strictEqual(both.chk.present, true, both.chk.detail);
  assert.strictEqual(both.res.unverified.length, 1);
  assert.match(both.res.unverified[0], /\(the label of section 'sec_left' was not compared: the language the build wrote it in could not be established/);
  assert.doesNotMatch(both.res.unverified[0], /tab 'tab_overview'/, 'only the string label is unverified: the tab\'s is a map');
});

test('verify reports nothing unverified on the normal path — a known language, or no string label — so its result keeps its shape', async () => {
  for (const [what, mutate, over, opts] of [
    ['an organization that answers', () => {}, inOrg(1033), undefined],
    ['a language pinned by the spec', (spec) => { spec.languageCode = 1033; }, inOrg(undefined), undefined],
    ['a language the build handed over', () => {}, inOrg(undefined), { languageCode: 1033 }],
    ['a layout that authors no label', unlabelled, inOrg(undefined), undefined],
  ]) {
    const { res } = await checkWith(layoutXml([overview()]), mutate, over, opts);
    assert.ok(!('unverified' in res), `${what}: ${JSON.stringify(res.unverified)}`);
  }
});

// --- A language the form READ does not carry is one it cannot show: the labels in it are unverified, never missing ---------------------------------
//
// Which languages' labels go into the FormXML a caller reads is the platform's decision, not the form's. Measured live: a form built and published with
// Spanish (3082) captions in an organization whose base language is English (1033), the Spanish captions confirmed stored by a translation export, reads
// back — published, and with an Accept-Language of es-ES — with its labels in 1033 ONLY. A caption the read does not carry in a language is then absent
// from the READ, which says nothing about the form, and verify listed it missing where the build that wrote it had verified clean. When no label of the
// form's FormXML — on any element of it — is in the language a label is compared in, that language is one the read cannot show, and the labels compared
// in it are reported UNVERIFIED (the third outcome, as for a language that cannot be established), with what the read does carry and what to do. A label
// map is compared at the languages the read carries and the others are listed the same way. A language the read carries is compared exactly as before.
const inSpanish = (spec) => { // TOPO_SPEC's three captions, written in Spanish by the spec
  authoredTab('Resumen')(spec);
  spec.forms[0].tabs[0].columns[0].sections[0].label = 'Izquierda';
  spec.forms[0].tabs[0].columns[1].sections[0].label = 'Derecha';
};
// The form as the live read shows it: every caption in English, none in Spanish.
const readsOnlyEnglish = () => layoutXml([overview()]);
// …and a form whose read carries the Spanish captions beside the English ones (`over` swaps what a test publishes instead, as `overview` does).
const readsSpanishToo = (over = {}) => layoutXml([overview({
  tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Resumen', lcid: 3082 }],
  leftLabel: [{ text: 'L', lcid: 1033 }, { text: 'Izquierda', lcid: 3082 }],
  rightLabel: [{ text: 'R', lcid: 1033 }, { text: 'Derecha', lcid: 3082 }],
  ...over,
})]);
const SPANISH_STRINGS_ENTRY = 'form-labels:new_ticket.Ticket Main (the labels of tab \'tab_overview\', section \'sec_left\', section \'sec_right\' in language 3082 were not compared: '
  + 'the environment\'s form read returns labels only in 1033, so labels written in 3082 cannot be read back from it. Check them in Power Apps with that language, or verify in a language the read carries)';

test('verify reports the labels UNVERIFIED — not missing — when the form read carries no label in the language the build wrote them in', async () => {
  // The English build, compared in 1033, is what the fixture reports by itself (it publishes no form order): unverified neither adds to it nor takes from it.
  const baseline = await checkWith(readsOnlyEnglish(), () => {}, inOrg(1033));
  for (const [what, mutate, opts] of [
    ['the --language-code the build was given (the flag verify takes, in either spelling)', inSpanish, { languageCode: 3082 }],
    ['the language the build\'s SDK was made for', inSpanish, { preResolvedLanguageCode: 3082 }],
    ['both, as the build\'s own verify is handed them', inSpanish, { languageCode: 3082, preResolvedLanguageCode: 3082 }],
    ['a languageCode the spec pins', (spec) => { inSpanish(spec); spec.languageCode = 3082; }, undefined],
  ]) {
    const { res, chk } = await checkWith(readsOnlyEnglish(), mutate, inOrg(1033), opts);
    assert.strictEqual(chk.present, true, `${what}: nothing the read carries says a Spanish caption is missing: ${chk.detail}`);
    assert.deepStrictEqual(res.missing, baseline.res.missing, `${what}: unverified is not a failure`);
    assert.strictEqual(res.ok, baseline.res.ok, what);
    assert.deepStrictEqual(res.unverified, [SPANISH_STRINGS_ENTRY], what);
    assert.ok(!res.checks.some((c) => /label/i.test(c.kind)), `${what}: no label check was recorded as passed or failed`);
  }
});

test('verify says which languages the form read DOES carry, and names a single label in the singular', async () => {
  const german = layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Uebersicht', lcid: 1031 }] })]);
  const tabOnly = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = 'Resumen'; };
  const { res, chk } = await checkWith(german, tabOnly, inOrg(1033), { languageCode: 3082 });
  assert.strictEqual(chk.present, true, chk.detail);
  assert.deepStrictEqual(res.unverified, ['form-labels:new_ticket.Ticket Main (the label of tab \'tab_overview\' in language 3082 was not compared: '
    + 'the environment\'s form read returns labels only in 1031, 1033, so labels written in 3082 cannot be read back from it. Check it in Power Apps with that language, or verify in a language the read carries)']);
});

test('verify compares a language the form read DOES carry exactly as before — a right caption passes, a wrong or a missing one fails', async () => {
  const opts = { languageCode: 3082 };
  const right = await checkWith(readsSpanishToo(), inSpanish, inOrg(1033), opts);
  assert.strictEqual(right.chk.present, true, right.chk.detail);
  assert.strictEqual(right.res.unverified, undefined, 'nothing is left that the read cannot tell');
  // A stale caption in the language the read carries is a mismatch, as ever.
  const stale = await checkWith(readsSpanishToo({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Antiguo', lcid: 3082 }] }), inSpanish, inOrg(1033), opts);
  assert.strictEqual(stale.chk.present, false);
  assert.match(stale.chk.detail, /tab 'tab_overview' is deployed with label "Antiguo" in language 3082, the spec declares label: "Resumen" in language 3082/);
  assert.strictEqual(stale.res.unverified, undefined);
  // The read carries Spanish on the sections, not on the tab: the tab's Spanish caption is missing from a read that can show it, and the English one is not it.
  const lacking = await checkWith(readsSpanishToo({ tabLabel: { text: 'Overview', lcid: 1033 } }), inSpanish, inOrg(1033), opts);
  assert.strictEqual(lacking.chk.present, false);
  assert.match(lacking.chk.detail, /tab 'tab_overview' is deployed with no label in language 3082 \(it has "Overview" in 1033\), the spec declares label: "Resumen" in language 3082/);
  assert.doesNotMatch(lacking.chk.detail, /sec_left|sec_right/, 'the sections carry theirs');
  assert.strictEqual(lacking.res.unverified, undefined);
});

test('verify takes a language as carried when ANY label of the form is in it — a field\'s too — and compares a form that carries no label at all as ever', async () => {
  const opts = { languageCode: 3082 };
  // A field label alone in Spanish: the read can show Spanish, so the tab's missing Spanish caption is a mismatch.
  const fieldOnly = readsOnlyEnglish().replace('<cell><control datafieldname="new_name"', `<cell>${labelsOf({ text: 'Nombre', lcid: 3082 })}<control datafieldname="new_name"`);
  const field = await checkWith(fieldOnly, inSpanish, inOrg(1033), opts);
  assert.strictEqual(field.chk.present, false);
  assert.match(field.chk.detail, /tab 'tab_overview' is deployed with no label in language 3082 \(it has "Overview" in 1033\), the spec declares label: "Resumen" in language 3082/);
  assert.strictEqual(field.res.unverified, undefined);
  // A label that names no language shows none: the read still carries no Spanish.
  const nameless = readsOnlyEnglish().replace('<cell><control datafieldname="new_name"', '<cell><labels><label description="Nombre"/></labels><control datafieldname="new_name"');
  assert.deepStrictEqual((await checkWith(nameless, inSpanish, inOrg(1033), opts)).res.unverified, [SPANISH_STRINGS_ENTRY]);
  // A form that publishes no label at all names no language: nothing published is no proof of a caption, and a spec that authors one is failed on it.
  const bare = await checkWith(layoutXml([overview({ tabLabel: null, leftLabel: null, rightLabel: null })]), inSpanish, inOrg(1033), opts);
  assert.strictEqual(bare.chk.present, false);
  assert.match(bare.chk.detail, /tab 'tab_overview' is deployed with no label, the spec declares label: "Resumen" in language 3082/);
  assert.strictEqual(bare.res.unverified, undefined);
});

test('verify compares a label MAP at the languages the read carries and lists the others unverified — a {1033, 3082} map over a read that carries English only', async () => {
  const declared = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 1033: 'Overview', 3082: 'Resumen' }; };
  // A map names its own languages, so there is no language to choose: the entry says to check Power Apps, and not to verify in another language.
  const MAP_ENTRY = 'form-labels:new_ticket.Ticket Main (the label of tab \'tab_overview\' in language 3082 was not compared: '
    + 'the environment\'s form read returns labels only in 1033, so labels written in 3082 cannot be read back from it. Check it in Power Apps with that language)';
  const right = await checkWith(readsOnlyEnglish(), declared, inOrg(1033));
  assert.strictEqual(right.chk.present, true, right.chk.detail);
  assert.deepStrictEqual(right.res.unverified, [MAP_ENTRY], 'the English caption was compared and is right; the Spanish one is listed');
  // The English caption is compared strictly: a stale one fails, and the Spanish one is not reported missing beside it.
  const stale = await checkWith(layoutXml([overview({ tabLabel: { text: 'Old', lcid: 1033 } })]), declared, inOrg(1033));
  assert.strictEqual(stale.chk.present, false);
  assert.match(stale.chk.detail, /tab 'tab_overview' is deployed with label "Old" in language 1033, the spec declares label: "Overview" in language 1033/);
  assert.doesNotMatch(stale.chk.detail, /3082/, 'a language the read cannot show is not reported missing');
  assert.deepStrictEqual(stale.res.unverified, [MAP_ENTRY], 'and it is still listed');
  // A language the map does not declare is nobody's business: nothing to list.
  const englishOnly = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 1033: 'Overview' }; };
  const only = await checkWith(readsOnlyEnglish(), englishOnly, inOrg(1033));
  assert.strictEqual(only.chk.present, true, only.chk.detail);
  assert.strictEqual(only.res.unverified, undefined);
  // Each declared language the read cannot show is listed on its own, in LCID order.
  const three = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 3082: 'Resumen', 1033: 'Overview', 1036: 'Apercu' }; };
  const many = await checkWith(readsOnlyEnglish(), three, inOrg(1033));
  assert.strictEqual(many.chk.present, true, many.chk.detail);
  assert.deepStrictEqual(many.res.unverified.map((u) => /in language (\d+)/.exec(u)[1]), ['1036', '3082']);
});

test('verify lists a form\'s two kinds of unverified labels apart, and judges what each form\'s read carries on its own', async () => {
  // A string label whose language cannot be established, and a map entry the read cannot show: two reasons, two entries, the older one first.
  const unreadable = { queryRecords: async (set) => { if (set === 'organization') throw new Error('503'); return set === 'systemform' ? FORM_ROW : []; } };
  const mixed = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = 'Overview'; spec.forms[0].tabs[0].columns[0].sections[0].label = { 1033: 'L', 3082: 'Izquierda' }; };
  const both = await checkWith(readsOnlyEnglish(), mixed, unreadable);
  assert.strictEqual(both.chk.present, true, both.chk.detail);
  assert.strictEqual(both.res.unverified.length, 2, JSON.stringify(both.res.unverified));
  assert.match(both.res.unverified[0], /^form-labels:new_ticket\.Ticket Main \(the label of tab 'tab_overview' was not compared: the language the build wrote it in could not be established /);
  assert.match(both.res.unverified[1], /^form-labels:new_ticket\.Ticket Main \(the label of section 'sec_left' in language 3082 was not compared: the environment's form read returns labels only in 1033, /);
  // Two forms of one spec, one read that carries Spanish and one that does not: the one that carries it is compared (and fails on a stale caption), the other
  // is listed — each form's read is judged on its own, whichever comes first.
  const spec = TOPO_SPEC();
  inSpanish(spec);
  spec.forms.push({ ...JSON.parse(JSON.stringify(spec.forms[0])), name: 'Ticket Second' });
  const reads = (main) => topoRead(null, {
    queryRecords: async (set, o) => {
      if (set === 'organization') return [{ languagecode: 1033 }];
      if (set !== 'systemform') return [];
      const asked = /name eq '([^']*)'/.exec((o && o.filter) || '');
      const name = asked ? asked[1] : 'Ticket Main';
      return [{ formid: name === 'Ticket Main' ? 'f1' : 'f2', name, objecttypecode: 'new_ticket', type: 2, isdefault: false }];
    },
    formTopology: async (_entity, id) => (id === 'f1' ? main : readsOnlyEnglish()),
  });
  const topologies = (res) => res.checks.filter((c) => c.kind === 'form-topology').map((c) => [c.name, c.present]);
  const passing = await verifySpec(spec, reads(readsSpanishToo()), { languageCode: 3082 });
  assert.deepStrictEqual(topologies(passing), [['new_ticket.Ticket Main', true], ['new_ticket.Ticket Second', true]]);
  assert.strictEqual(passing.unverified.length, 1, JSON.stringify(passing.unverified));
  assert.match(passing.unverified[0], /^form-labels:new_ticket\.Ticket Second \(/, 'the form whose read cannot show Spanish');
  const failing = await verifySpec(spec, reads(readsSpanishToo({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Antiguo', lcid: 3082 }] })), { languageCode: 3082 });
  assert.deepStrictEqual(topologies(failing), [['new_ticket.Ticket Main', false], ['new_ticket.Ticket Second', true]]);
  assert.strictEqual(failing.unverified.length, 1);
  assert.match(failing.unverified[0], /^form-labels:new_ticket\.Ticket Second \(/);
});

test('verify holds a LOCALIZED label to every language it declares — and only those', async () => {
  const declared = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 1033: 'Overview', 1036: 'Apercu' }; };
  // Both declared languages published, with an undeclared translation beside them: the label is deployed.
  const both = layoutXml([overview({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Apercu', lcid: 1036 }, { text: 'Uebersicht', lcid: 1031 }] })]);
  assert.strictEqual((await topoCheck(both, declared)).present, true);
  // One declared language missing: a mismatch that names it, though the other is right. (The read carries French on a section, so it can show it:
  // a form whose read carries no French at all is the next block's.)
  const missing = await topoCheck(layoutXml([overview({ tabLabel: { text: 'Overview', lcid: 1033 }, leftLabel: [{ text: 'L', lcid: 1033 }, { text: 'G', lcid: 1036 }] })]), declared);
  assert.strictEqual(missing.present, false);
  assert.match(missing.detail, /tab 'tab_overview' is deployed with no label in language 1036 \(it has "Overview" in 1033\), the spec declares label: "Apercu" in language 1036/);
  assert.doesNotMatch(missing.detail, /language 1033, the spec/, 'the declared language that is right is not reported');
  // A wrong text in a declared language.
  const wrong = await topoCheck(layoutXml([overview({ tabLabel: [{ text: 'Old', lcid: 1033 }, { text: 'Apercu', lcid: 1036 }] })]), declared);
  assert.strictEqual(wrong.present, false);
  assert.match(wrong.detail, /tab 'tab_overview' is deployed with label "Old" in language 1033, the spec declares label: "Overview" in language 1033/);
  assert.doesNotMatch(wrong.detail, /language 1036, the spec/);
  // None of the declared captions published: every one is reported.
  const none = await topoCheck(layoutXml([overview({ tabLabel: [{ text: 'Old', lcid: 1033 }, { text: 'Ancien', lcid: 1036 }] })]), declared);
  assert.strictEqual(none.present, false);
  assert.match(none.detail, /"Old" in language 1033, the spec declares label: "Overview" in language 1033/);
  assert.match(none.detail, /"Ancien" in language 1036, the spec declares label: "Apercu" in language 1036/);
});

test('verify declares nothing for a localized label entry that is no LCID or has no text, and decodes its XML entities', async () => {
  const sloppy = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { en: 'English', 1033: 'R & D', 1036: '', 1031: 7 }; };
  const chk = await topoCheck(layoutXml([overview({ tabLabel: 'R &amp; D' })]), sloppy);
  assert.strictEqual(chk.present, true, chk.detail);
  const wrong = await topoCheck(layoutXml([overview({ tabLabel: 'R and D' })]), sloppy);
  assert.strictEqual(wrong.present, false, 'the one valid entry is still held');
  assert.doesNotMatch(wrong.detail, /English|1036|1031/);
});

test('verify FAILS a label the published container does not carry — at all, or in the language the spec declares — and never passes it', async () => {
  // No `<labels>` on the tab or either section.
  const bare = await topoCheck(layoutXml([overview({ tabLabel: null, leftLabel: null, rightLabel: null })]));
  assert.strictEqual(bare.present, false, 'no label published is no proof of the caption the spec authors');
  assert.match(bare.detail, /tab 'tab_overview' is deployed with no label, the spec declares label: "Overview" in language 1033/);
  assert.match(bare.detail, /section 'sec_left' is deployed with no label, the spec declares label: "L" in language 1033/);
  assert.match(bare.detail, /section 'sec_right' is deployed with no label, the spec declares label: "R" in language 1033/);
  // …including a relabel the spec authors over a form that publishes none.
  assert.strictEqual((await topoCheck(layoutXml([overview({ tabLabel: null, leftLabel: null, rightLabel: null })]), relabelled)).present, false);
  // Labels published, but none in the language the spec declares.
  const other = await topoCheck(layoutXml([overview({ tabLabel: { text: 'Overview', lcid: 1036 } })]));
  assert.strictEqual(other.present, false);
  assert.match(other.detail, /tab 'tab_overview' is deployed with no label in language 1033 \(it has "Overview" in 1036\), the spec declares label: "Overview" in language 1033/);
  // A label that names no language is the spec's in none.
  const noLanguage = layoutXml([overview()]).replace('<label description="Overview" languagecode="1033"/>', '<label description="Overview"/>');
  const nameless = await topoCheck(noLanguage);
  assert.strictEqual(nameless.present, false);
  assert.match(nameless.detail, /tab 'tab_overview' is deployed with no label in language 1033 \(it has "Overview" in no language\)/);
  // …and a CELL's label is never taken for its section's.
  const cellOnly = layoutXml([overview({ leftLabel: null })]).replace('<cell><control datafieldname="new_name"', `<cell>${labelsOf('L')}<control datafieldname="new_name"`);
  const section = await topoCheck(cellOnly);
  assert.strictEqual(section.present, false, 'the section has no label of its own');
  assert.match(section.detail, /section 'sec_left' is deployed with no label, the spec declares label: "L" in language 1033/);
});

test('verify decodes the XML entities in a published label before comparing it', async () => {
  const rd = (spec) => { spec.forms[0].tabs[0].columns[0].sections[0].label = 'R & D <1>'; };
  const chk = await topoCheck(layoutXml([overview({ leftLabel: 'R &amp; D &lt;1&gt;' })]), rd);
  assert.strictEqual(chk.present, true, chk.detail);
});

test('verify holds a container matched by POSITION to the spec\'s label too — the build relabels it', async () => {
  // Deployed under other names AND other labels, so only the position pass can pair them with the spec's containers;
  // the build then converges their labels while keeping their names. A relabel that did not land is reported.
  const xml = layoutXml([{ name: 'zz_tab', label: 'Old tab', columns: [
    { width: '60%', sections: [{ name: 'zz_a', label: 'Old left', cells: [{ field: 'new_name' }] }] },
    { width: '40%', sections: [{ name: 'zz_b', label: 'R', cells: [{ field: 'new_notes' }] }] },
  ] }]);
  const chk = await topoCheck(xml);
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /tab 'tab_overview' is deployed with label "Old tab" in language 1033, the spec declares label: "Overview" in language 1033/);
  assert.match(chk.detail, /section 'sec_left' is deployed with label "Old left" in language 1033, the spec declares label: "L" in language 1033/);
  const relabelledLive = xml.replace('Old tab', 'Overview').replace('Old left', 'L');
  assert.strictEqual((await topoCheck(relabelledLive)).present, true, 'once the labels are the spec\'s the same positional match verifies');
});

test('verify reports a label problem alongside the form\'s other layout problems, in one check', async () => {
  const flattened = layoutXml([{ name: 'tab_overview', label: 'Overview', columns: [
    { width: '60%', sections: [{ name: 'sec_left', label: 'Left', cells: [{ field: 'new_name' }, { field: 'new_notes' }] }] },
    { width: '40%', sections: [{ name: 'sec_right', label: 'R', cells: [] }] },
  ] }]);
  const chk = await topoCheck(flattened, relabelled);
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /^deployed layout does not match the authored one — /);
  assert.match(chk.detail, /label "Overview" in language 1033, the spec declares label: "Summary" in language 1033/);
  assert.match(chk.detail, /field 'new_notes' is deployed in section 'sec_left'/);
});

// --- A field held more than once is judged on every cell that holds it ---------------------------------------------
// The build asserts a read-only or hidden field on every cell of it (a maker can place the field in a second section),
// so verify proves every one of them: a second placement left editable or visible is a mismatch, as the first is.
const twice = (secondCell) => layoutXml([{ name: 'tab_overview', label: 'Overview', columns: [
  { width: '60%', sections: [{ name: 'sec_left', label: 'L', cells: [{ field: 'new_name', control: { disabled: 'true' }, attrs: { visible: 'false' } }] }] },
  { width: '40%', sections: [{ name: 'sec_right', label: 'R', cells: [{ field: 'new_notes' }, secondCell] }] },
] }]);
const lockedAndHidden = (spec) => { spec.forms[0].tabs[0].columns[0].sections[0].fields = [{ name: 'new_name', readOnly: true, hidden: true }]; };

test('verify FAILS a second placement of a read-only or hidden field that deployed editable or visible', async () => {
  const chk = await topoCheck(twice({ field: 'new_name' }), lockedAndHidden);
  assert.strictEqual(chk.present, false, 'the first cell is right; the second is not');
  assert.match(chk.detail, /field 'new_name' \(another placement, in section 'sec_right'\) is deployed with visible="true" \(absent, the default\), the spec declares hidden: true/);
  assert.match(chk.detail, /field 'new_name' \(another placement, in section 'sec_right'\) is deployed with disabled="false" \(absent, the default\), the spec declares readOnly: true/);
  const both = await topoCheck(twice({ field: 'new_name', control: { disabled: 'true' }, attrs: { visible: 'false' } }), lockedAndHidden);
  assert.strictEqual(both.present, true, both.detail);
  // A field the spec does not flag has no state to prove on any of its cells.
  const unflagged = await topoCheck(twice({ field: 'new_name' }));
  assert.strictEqual(unflagged.present, true, unflagged.detail);
});

test('verify names the second placement of a field whose first cell is the one that is wrong, once each', async () => {
  const wrongFirst = twice({ field: 'new_name', control: { disabled: 'true' }, attrs: { visible: 'false' } })
    .replace('<control datafieldname="new_name" disabled="true" />', '<control datafieldname="new_name" />');
  const chk = await topoCheck(wrongFirst, lockedAndHidden);
  assert.strictEqual(chk.present, false);
  assert.strictEqual((chk.detail.match(/field 'new_name' is deployed with disabled="false"/g) || []).length, 1, 'the first cell keeps its own wording');
  assert.doesNotMatch(chk.detail, /another placement/, 'the second cell is right and is not reported');
});

test('verify proves the flags of an AUTO layout on every cell of the field too', async () => {
  const auto = TOPO_SPEC();
  auto.forms = [{ entity: 'new_ticket', name: 'Ticket Main', fieldOptions: { new_name: { readOnly: true } } }];
  const stateOf = async (xml) => ((await verifySpec(auto, topoRead(xml))).checks || []).find((c) => c.kind === 'form-field-state');
  const second = await stateOf(twice({ field: 'new_name' }));
  assert.strictEqual(second.present, false);
  assert.match(second.detail, /field 'new_name' \(another placement, in section 'sec_right'\) is deployed with disabled="false" \(absent, the default\), the spec declares readOnly: true/);
  assert.strictEqual((await stateOf(twice({ field: 'new_name', control: { disabled: 'true' } }))).present, true);
});

// --- The form's HEADER and FOOTER hold cells too ---------------------------------------------------------------------
// A maker can place a field there as well as in a section, and the build flags that cell like any other of the field (the SDK keeps
// the two parts as raw XML, outside the tabs the body checks walk). Verify reads them, so a field left editable or visible in the
// header or the footer is a mismatch — not a pass because only the body was looked at.
const outerPart = (part, cells) => `<${part} id="${part}-id" columns="1"><rows><row>${cells.join('')}</row></rows></${part}>`;
const outerCell = (field, { cell, control, label = 'Code', extra = '' } = {}) => `<cell id="c-${field}"${attrsOf(cell)}>${labelsOf(label)}<control id="o-${field}" datafieldname="${field}"${attrsOf(control)} />${extra}</cell>`;
const withOuter = (xml, parts) => xml.replace('</form>', `${parts.join('')}</form>`);
const flagged = { control: { disabled: 'true' }, cell: { visible: 'false' } };
const lockedName = (spec) => { spec.forms[0].tabs[0].columns[0].sections[0].fields = [{ name: 'new_name', readOnly: true, hidden: true }]; };
const autoLockedName = () => {
  const auto = TOPO_SPEC();
  auto.forms = [{ entity: 'new_ticket', name: 'Ticket Main', fieldOptions: { new_name: { readOnly: true, hidden: true } } }];
  return auto;
};

test('verify FAILS a header or footer cell of a read-only or hidden field that deployed editable or visible, and names where it is', async () => {
  const body = layoutXml([overview({ nameCell: { visible: 'false' }, nameControl: { disabled: 'true' } })]);
  const chk = await topoCheck(withOuter(body, [outerPart('header', [outerCell('new_name')]), outerPart('footer', [outerCell('new_name')])]), lockedName);
  assert.strictEqual(chk.present, false, 'the body is right; the header and the footer are not');
  for (const part of ['header', 'footer']) {
    assert.match(chk.detail, new RegExp(`field 'new_name' \\(another placement, in the form ${part}\\) is deployed with visible="true" \\(absent, the default\\), the spec declares hidden: true`));
    assert.match(chk.detail, new RegExp(`field 'new_name' \\(another placement, in the form ${part}\\) is deployed with disabled="false" \\(absent, the default\\), the spec declares readOnly: true`));
  }
  // Only the cell that is wrong is named.
  const footerOnly = await topoCheck(withOuter(body, [outerPart('header', [outerCell('new_name', flagged)]), outerPart('footer', [outerCell('new_name')])]), lockedName);
  assert.strictEqual(footerOnly.present, false);
  assert.match(footerOnly.detail, /in the form footer/);
  assert.doesNotMatch(footerOnly.detail, /in the form header/);
  const both = await topoCheck(withOuter(body, [outerPart('header', [outerCell('new_name', flagged)]), outerPart('footer', [outerCell('new_name', flagged)])]), lockedName);
  assert.strictEqual(both.present, true, both.detail);
});

test('verify proves the flags of an AUTO layout on the header and footer cells of the field too', async () => {
  const stateOf = async (xml) => ((await verifySpec(autoLockedName(), topoRead(xml))).checks || []).find((c) => c.kind === 'form-field-state');
  const body = layoutXml([overview({ nameCell: { visible: 'false' }, nameControl: { disabled: 'true' } })]);
  const wrong = await stateOf(withOuter(body, [outerPart('header', [outerCell('new_name')])]));
  assert.strictEqual(wrong.present, false);
  assert.match(wrong.detail, /field 'new_name' \(another placement, in the form header\) is deployed with disabled="false" \(absent, the default\), the spec declares readOnly: true/);
  assert.strictEqual((await stateOf(withOuter(body, [outerPart('header', [outerCell('new_name', flagged)]), outerPart('footer', [outerCell('new_name', flagged)])]))).present, true);
  // A field only the header holds is not on the layout the build places: the body is what it asserts.
  const headerOnly = await stateOf(withOuter(layoutXml([overview()]).replace('<control datafieldname="new_name" />', '<control datafieldname="new_other" />'), [outerPart('header', [outerCell('new_name', flagged)])]));
  assert.strictEqual(headerOnly.present, false);
  assert.match(headerOnly.detail, /field 'new_name' is not on the deployed form/);
});

test('verify ignores a header or footer cell that is not the field — another field, a spacer, a quick view bound to it — and keeps the labels of the body', async () => {
  const QV = '{5C5600E0-1D6E-4205-A272-BE80DA87FD42}';
  const body = layoutXml([overview({ nameCell: { visible: 'false' }, nameControl: { disabled: 'true' } })]);
  const parts = [
    outerPart('header', [outerCell('new_other'), '<cell id="spacer" />', outerCell('new_name', { control: { classid: QV } })]),
    outerPart('footer', [outerCell('new_notes', { label: 'Notes' })]),
  ];
  const chk = await topoCheck(withOuter(body, parts), lockedName);
  assert.strictEqual(chk.present, true, chk.detail);
  // The labels of a header cell are the cell's, never the tab's or a section's: this tab's own label is what is held.
  const relabel = await topoCheck(withOuter(layoutXml([overview({ tabLabel: 'Old' })]), [outerPart('header', [outerCell('new_other', { label: 'Overview' })])]));
  assert.strictEqual(relabel.present, false);
  assert.match(relabel.detail, /tab 'tab_overview' is deployed with label "Old" in language 1033/);
  // A self-closing part holds nothing.
  assert.strictEqual((await topoCheck(withOuter(body, ['<header id="h" />', '<footer id="f"/>']), lockedName)).present, true);
});

test('verify: header and footer cells are not counted in a section\'s rows or fields', async () => {
  // The header holds new_name and new_notes in a row of its own: the layout\'s sections must be exactly as they were.
  const xml = withOuter(layoutXml([overview()]), [outerPart('header', [outerCell('new_name'), outerCell('new_notes')])]);
  const chk = await topoCheck(xml);
  assert.strictEqual(chk.present, true, chk.detail);
  const swapped = withOuter(layoutXml([overview()]).replace('new_name', 'new_zzz'), [outerPart('header', [outerCell('new_name')])]);
  const misplaced = await topoCheck(swapped);
  assert.strictEqual(misplaced.present, false, 'a field only the header holds is not placed in the section the layout names');
  assert.match(misplaced.detail, /new_name/);
});

// A TAB has a header and a footer of its own (`<tabheader>` / `<tabfooter>`, after the tab's labels and before its columns, the same markup
// as the form's), which the SDK keeps raw in the tab's bag. A field placed there is a placement as much as a section's, so verify reads it.
test('verify proves the cells of a tab\'s own header and footer too — naming the tab — and keeps them out of the tab\'s label and sections', async () => {
  const body = layoutXml([overview({ nameCell: { visible: 'false' }, nameControl: { disabled: 'true' } })]);
  const inTab = (xml, parts) => xml.replace(/(<tab\b[^>]*\bname="tab_overview"[^>]*>(?:<labels>[\s\S]*?<\/labels>)?)/, `$1${parts.join('')}`);
  const wrong = await topoCheck(inTab(body, [outerPart('tabheader', [outerCell('new_name')]), outerPart('tabfooter', [outerCell('new_name')])]), lockedName);
  assert.strictEqual(wrong.present, false, 'the body is right; the tab\'s header and footer are not');
  for (const [part, word] of [['tabheader', 'header'], ['tabfooter', 'footer']]) {
    assert.match(wrong.detail, new RegExp(`field 'new_name' \\(another placement, in the ${word} of tab 'tab_overview'\\) is deployed with visible="true" \\(absent, the default\\), the spec declares hidden: true`));
    assert.match(wrong.detail, new RegExp(`field 'new_name' \\(another placement, in the ${word} of tab 'tab_overview'\\) is deployed with disabled="false" \\(absent, the default\\), the spec declares readOnly: true`));
  }
  const right = await topoCheck(inTab(body, [outerPart('tabheader', [outerCell('new_name', flagged)]), outerPart('tabfooter', [outerCell('new_name', flagged)])]), lockedName);
  assert.strictEqual(right.present, true, right.detail);
  // The auto layout proves them too.
  const auto = await verifySpec(autoLockedName(), topoRead(inTab(body, [outerPart('tabheader', [outerCell('new_name')])])));
  const state = (auto.checks || []).find((c) => c.kind === 'form-field-state');
  assert.strictEqual(state.present, false);
  assert.match(state.detail, /in the header of tab 'tab_overview'/);
  // The tab's own label and sections are not what the header's cells are: a self-closing part, and a part with another field's cell, change nothing.
  assert.strictEqual((await topoCheck(inTab(layoutXml([overview()]), ['<tabheader id="h" />', outerPart('tabfooter', [outerCell('new_other', { label: 'Overview' })])]))).present, true);
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

// A pinned dashboardId is what the build binds first, so a read of it that FAILS leaves the dashboard
// unverified — it must not fall through to the name (which may find another app's namesake) or pass.
test('verifySpec: a pinned dashboardId whose read fails is reported unverified, not proven', async () => {
  const PIN = 'aaaa1111-2222-3333-4444-555566667777';
  const spec = { entities: [], views: [], charts: [], forms: [],
    dashboards: [{ name: 'Operations', dashboardId: PIN, tiles: [{ type: 'list', entity: 'account', viewId: 'v1' }] }],
    appShell: { areas: [{ groups: [{ subAreas: [{ dashboard: 'Operations', title: 'Operations' }] }] }] } };
  let byName = 0;
  const read = {
    findTable: async () => null, findColumns: async () => [],
    queryRecords: async (set, opts) => {
      if (set !== 'systemform') return [];
      if (opts.filter === `formid eq ${PIN}`) throw new Error('read refused (403)');
      byName += 1;
      return [{ formid: 'bbbb1111-2222-3333-4444-555566667777', name: 'Operations', type: 0 }];
    },
    sitemapXml: async () => '<SiteMap><Area><Group><SubArea Id="ops" Url="/workplace/home_dashboards.aspx" DefaultDashboard="{BBBB1111-2222-3333-4444-555566667777}" /></Group></Area></SiteMap>',
  };
  const r = await verifySpec(spec, read);
  const chk = r.checks.find((c) => c.kind === 'dashboard');
  assert.ok(chk && !chk.present, JSON.stringify(chk));
  assert.match(chk.detail, /its dashboardId could not be resolved \(read refused \(403\)\) — unverified, not proven correct/);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(byName, 0, 'the name is not tried after the pinned read failed — it could find another app\u2019s namesake');
});

test('verify ignores non-chart tiles when proving a dashboard', async () => {
  const chk = await dashCheck({ components: [{ type: 'list', name: 'L', parameters: { TargetEntityType: 'new_ticket', ViewId: DASH_VIEW } }, { type: 'iframe', name: 'I', parameters: { Url: 'https://x' } }] });
  assert.strictEqual(chk.present, true, chk.detail);
});

test('verifySpec: a plain-string relationship list stays name-only', async () => {
  const spec = { solution: { publisherPrefix: 'contoso' }, entities: [], views: [], charts: [], forms: [], appShell: { areas: [] },
    relationships: [{ type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_task', lookup: { schemaName: 'contoso_ProjectId' } }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '',
    entityRelationships: async () => ['contoso_project_contoso_task'],
  };
  const r = await verifySpec(spec, read);
  const rc = r.checks.find((c) => c.kind === 'relationship');
  assert.strictEqual(rc && rc.present, true, JSON.stringify(rc));
});

test('verifySpec: a 1:N passes only when the name and both endpoints match', async () => {
  const spec = { solution: { publisherPrefix: 'contoso' }, entities: [], views: [], charts: [], forms: [], appShell: { areas: [] },
    relationships: [{ type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_task', lookup: { schemaName: 'contoso_ProjectId' } }] };
  const row = { schemaName: 'CONTOSO_PROJECT_CONTOSO_TASK', type: 'OneToMany', referencedEntity: 'contoso_project', referencingEntity: 'contoso_task', referencingAttribute: 'contoso_projectid' };
  const read = {
    findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '',
    entityRelationships: async () => [row],
  };
  const ok = await verifySpec(spec, read);
  assert.strictEqual(ok.checks.find((c) => c.kind === 'relationship').present, true);

  const wrongLookup = await verifySpec(spec, { ...read, entityRelationships: async () => [{ ...row, referencingAttribute: 'contoso_ownerid' }] });
  const bad = wrongLookup.checks.find((c) => c.kind === 'relationship');
  assert.strictEqual(bad.present, false);
  assert.match(bad.detail, /exists as 1:N/);
  assert.match(bad.detail, /contoso_ownerid/);
});

test('verifySpec: an N:N passes on an unordered pair and fails when the name is a different relationship', async () => {
  const spec = { solution: { publisherPrefix: 'contoso' }, entities: [], views: [], charts: [], forms: [], appShell: { areas: [] },
    relationships: [{ type: 'ManyToMany', entity1: 'contoso_task', entity2: 'contoso_project' }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '',
    entityRelationships: async () => [{
      schemaName: 'contoso_project_contoso_task', type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_task',
      intersectEntityName: 'contoso_project_contoso_task', entity1IntersectAttribute: 'contoso_projectid', entity2IntersectAttribute: 'contoso_taskid',
    }],
  };
  const ok = await verifySpec(spec, read);
  assert.strictEqual(ok.checks.find((c) => c.kind === 'relationship').present, true);

  const other = await verifySpec(spec, {
    ...read,
    entityRelationships: async () => [{ schemaName: 'contoso_project_contoso_task', type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_tag' }],
  });
  const bad = other.checks.find((c) => c.kind === 'relationship');
  assert.strictEqual(bad.present, false);
  assert.match(bad.detail, /exists as N:N contoso_project <-> contoso_tag/);
});

test('verifySpec: when the typed read cannot see the holder, relationshipHolder names it', async () => {
  const spec = { solution: { publisherPrefix: 'contoso' }, entities: [], views: [], charts: [], forms: [], appShell: { areas: [] },
    relationships: [{ type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_task' }] };
  const read = {
    findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '',
    entityRelationships: async () => [],
    relationshipHolder: async (name, candidates) => {
      assert.strictEqual(name, 'contoso_project_contoso_task');
      assert.ok(candidates.map((c) => String(c).toLowerCase()).includes('contoso_project'));
      return { found: true, holder: { schemaName: 'contoso_project_contoso_task', type: 'OneToMany', referencedEntity: 'contoso_project', referencingEntity: 'contoso_task', referencingAttribute: 'contoso_projectid' } };
    },
  };
  const r = await verifySpec(spec, read);
  const rc = r.checks.find((c) => c.kind === 'relationship');
  assert.strictEqual(rc.present, false);
  assert.match(rc.detail, /contoso_project_contoso_task exists as 1:N contoso_project -> contoso_task \(lookup contoso_projectid\), not as the declared N:N/);
});

// --- A language the form READ does not carry is read from ONE translation export of the app's solution ---------------------------------------------
//
// The form reads cannot show a caption in a language their FormXML does not carry, and a translation export can: it holds every provisioned language,
// the published layer, one row per tab or section keyed by the `id` the element has in the FormXML. So the captions compared in such a language are
// compared there — by the id of the tab or section the form's read matched — and are reported like any other: a right one passes, a stale or an
// empty one is a mismatch. An export that cannot be used, or that cannot say, leaves them UNVERIFIED as they were: never a pass. The export is one
// request, made when some caption needs it and not otherwise, and shared by every form of the pass.
const TAB_ID = '0a0a0a0a-0000-4000-8000-000000000001';
const LEFT_ID = '0a0a0a0a-0000-4000-8000-000000000002';
const RIGHT_ID = '0a0a0a0a-0000-4000-8000-000000000003';
// The form as the live read shows it — every caption in English, none in Spanish — with the ids a platform form's tabs and sections have.
const readsEnglishWithIds = (over = {}) => layoutXml([overview({ tab: { id: TAB_ID }, left: { id: LEFT_ID }, right: { id: RIGHT_ID }, ...over })]);
// What the export holds for TOPO_SPEC's three containers: the English captions the form read shows and the Spanish ones `inSpanish` asks for. `over` replaces
// the texts of a row by its id, and drops the row when it is `null`.
const spanishRows = (over = {}) => [
  { entity: 'new_ticket', id: TAB_ID, texts: { 1033: 'Overview', 3082: 'Resumen' } },
  { entity: 'new_ticket', id: LEFT_ID, texts: { 1033: 'L', 3082: 'Izquierda' } },
  { entity: 'new_ticket', id: RIGHT_ID, texts: { 1033: 'R', 3082: 'Derecha' } },
].filter((row) => over[row.id] !== null).map((row) => (over[row.id] ? { ...row, texts: over[row.id] } : row));
const exportOf = (captions = spanishRows(), languages = [1033, 3082]) => {
  const read = parseTranslationWorkbook(workbookXml({ languages, captions }));
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  return read;
};
// A reader that can ask for the export: it answers `answer` (or what a function of the solution's name answers) a moment later, and records the solution asked for.
const asking = (answer, seen = []) => ({ translationLabels: async (solution) => {
  seen.push(solution);
  await new Promise((resolve) => setImmediate(resolve));
  return typeof answer === 'function' ? answer(solution) : answer;
} });
const inOrgAsking = (answer, seen, languagecode = 1033) => ({ ...inOrg(languagecode), ...asking(answer, seen) });
const SOLUTION_EXPORT = 'the translation export of solution \'s\'';

test('verify compares the captions a form read does not carry with ONE translation export of the app\'s solution — the right ones pass and nothing is left unverified', async () => {
  // The English build, compared in 1033, is what the fixture reports by itself (it publishes no form order): the export neither adds to it nor takes from it.
  const baseline = await checkWith(readsOnlyEnglish(), () => {}, inOrg(1033));
  for (const [what, mutate, opts] of [
    ['the --language-code the build was given', inSpanish, { languageCode: 3082 }],
    ['the language the build\'s SDK was made for', inSpanish, { preResolvedLanguageCode: 3082 }],
    ['both, as the build\'s own verify is handed them', inSpanish, { languageCode: 3082, preResolvedLanguageCode: 3082 }],
    ['a languageCode the spec pins', (spec) => { inSpanish(spec); spec.languageCode = 3082; }, undefined],
  ]) {
    const seen = [];
    const { res, chk } = await checkWith(readsEnglishWithIds(), mutate, inOrgAsking(exportOf(), seen), opts);
    assert.strictEqual(chk.present, true, `${what}: ${chk.detail}`);
    assert.strictEqual(res.unverified, undefined, `${what}: the export settled all three captions`);
    assert.deepStrictEqual(res.missing, baseline.res.missing, `${what}: nothing is added to the failures the fixture has by itself`);
    assert.strictEqual(res.ok, baseline.res.ok, what);
    assert.deepStrictEqual(seen, ['s'], `${what}: one export, of the spec's solution`);
    assert.ok(!res.checks.some((c) => /label/i.test(c.kind)), `${what}: no label check of its own is recorded`);
  }
});

test('verify reports a caption the translation export shows differently, or not at all — by the id of its tab or section, and only that one', async () => {
  const opts = { languageCode: 3082 };
  const baseline = await checkWith(readsEnglishWithIds(), () => {}, inOrg(1033));
  assert.strictEqual(baseline.chk.present, true, 'the English build of the same form is right');
  // A stale caption in the tab: the section captions are right, and are not mentioned.
  const stale = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows({ [TAB_ID]: { 1033: 'Overview', 3082: 'Antiguo' } }))), opts);
  assert.strictEqual(stale.chk.present, false);
  assert.match(stale.chk.detail, new RegExp(`tab 'tab_overview' is deployed with label "Antiguo" in language 3082 \\(${SOLUTION_EXPORT} shows it; the form read does not carry language 3082\\), the spec declares label: "Resumen" in language 3082`));
  assert.doesNotMatch(stale.chk.detail, /sec_left|sec_right/);
  assert.strictEqual(stale.res.unverified, undefined, 'a caption the export settled is no longer unverified, right or wrong');
  assert.ok(stale.res.missing.some((m) => m.kind === 'form-topology'), 'it is a failure of the form, as any wrong caption is');
  // An empty cell is a caption that is not there; what the row holds in other languages is said.
  const empty = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows({ [LEFT_ID]: { 1033: 'L' } }))), opts);
  assert.strictEqual(empty.chk.present, false);
  assert.match(empty.chk.detail, new RegExp(`section 'sec_left' is deployed with no label in language 3082 \\(${SOLUTION_EXPORT} has none, only "L" in 1033; the form read does not carry language 3082\\), the spec declares label: "Izquierda" in language 3082`));
  assert.doesNotMatch(empty.chk.detail, /tab 'tab_overview'|sec_right/);
  const bare = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows({ [RIGHT_ID]: {} }))), opts);
  assert.match(bare.chk.detail, new RegExp(`section 'sec_right' is deployed with no label in language 3082 \\(${SOLUTION_EXPORT} has none; the form read does not carry language 3082\\), the spec declares label: "Derecha" in language 3082`));
  // Every wrong caption is reported, each once.
  const all = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows({ [TAB_ID]: { 3082: 'a' }, [LEFT_ID]: { 3082: 'b' }, [RIGHT_ID]: { 3082: 'c' } }))), opts);
  assert.strictEqual((all.chk.detail.match(/in language 3082 \(/g) || []).length, 3, all.chk.detail);
  // Text is compared exactly: the case of a letter is a different caption.
  const cased = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows({ [TAB_ID]: { 1033: 'Overview', 3082: 'resumen' } }))), opts);
  assert.strictEqual(cased.chk.present, false);
});

test('verify makes ONE translation export for every form and every caption — forms that ask at the same moment share it', async () => {
  const spec = TOPO_SPEC();
  inSpanish(spec);
  spec.forms.push({ ...JSON.parse(JSON.stringify(spec.forms[0])), name: 'Ticket Second' });
  const SECOND = { tab: 'a1b2c3d4-0000-4000-8000-000000000001', left: 'a1b2c3d4-0000-4000-8000-000000000002', right: 'a1b2c3d4-0000-4000-8000-000000000003' };
  const secondRows = (tabText) => [
    { entity: 'new_ticket', id: SECOND.tab, texts: { 1033: 'Overview', 3082: tabText } },
    { entity: 'new_ticket', id: SECOND.left, texts: { 1033: 'L', 3082: 'Izquierda' } },
    { entity: 'new_ticket', id: SECOND.right, texts: { 1033: 'R', 3082: 'Derecha' } },
  ];
  const reads = (answer, seen) => topoRead(null, {
    ...asking(answer, seen),
    queryRecords: async (set, o) => {
      if (set === 'organization') return [{ languagecode: 1033 }];
      if (set !== 'systemform') return [];
      const asked = /name eq '([^']*)'/.exec((o && o.filter) || '');
      const name = asked ? asked[1] : 'Ticket Main';
      return [{ formid: name === 'Ticket Main' ? 'f1' : 'f2', name, objecttypecode: 'new_ticket', type: 2, isdefault: false }];
    },
    formTopology: async (_entity, id) => (id === 'f1' ? readsEnglishWithIds() : readsEnglishWithIds({ tab: { id: SECOND.tab }, left: { id: SECOND.left }, right: { id: SECOND.right } })),
  });
  const topologies = (res) => res.checks.filter((c) => c.kind === 'form-topology').map((c) => [c.name, c.present]);
  const seen = [];
  const passing = await verifySpec(spec, reads(exportOf([...spanishRows(), ...secondRows('Resumen')]), seen), { languageCode: 3082 });
  assert.deepStrictEqual(topologies(passing), [['new_ticket.Ticket Main', true], ['new_ticket.Ticket Second', true]]);
  assert.strictEqual(passing.unverified, undefined);
  assert.deepStrictEqual(seen, ['s'], 'six captions of two forms, one export');
  // Each form is judged by its own rows: the second form\'s stale caption fails it, and the first stays right.
  const again = [];
  const failing = await verifySpec(spec, reads(exportOf([...spanishRows(), ...secondRows('Antiguo')]), again), { languageCode: 3082 });
  assert.deepStrictEqual(topologies(failing), [['new_ticket.Ticket Main', true], ['new_ticket.Ticket Second', false]]);
  assert.strictEqual(again.length, 1);
  // …and an export of another pass is another export: the answer is kept for ONE pass, as a form read is.
  const passes = [];
  const reader = reads(exportOf([...spanishRows(), ...secondRows('Resumen')]), passes);
  await verifySpec(spec, reader, { languageCode: 3082 });
  await verifySpec(spec, reader, { languageCode: 3082 });
  assert.strictEqual(passes.length, 2);
});

test('verify asks for no translation export when every caption can be compared from the form read, or none can be compared at all', async () => {
  const seen = [];
  const reader = inOrgAsking(exportOf(), seen);
  // The read carries the Spanish captions: they are compared there, as before — a wrong one fails, with no export.
  const carried = await checkWith(readsSpanishToo(), inSpanish, reader, { languageCode: 3082 });
  assert.strictEqual(carried.chk.present, true, carried.chk.detail);
  const wrong = await checkWith(readsSpanishToo({ tabLabel: [{ text: 'Overview', lcid: 1033 }, { text: 'Antiguo', lcid: 3082 }] }), inSpanish, reader, { languageCode: 3082 });
  assert.strictEqual(wrong.chk.present, false);
  assert.doesNotMatch(wrong.chk.detail, /translation export/);
  // The English build: the language is one the read carries.
  assert.strictEqual((await checkWith(readsEnglishWithIds(), () => {}, reader)).chk.present, true);
  // A layout that authors no caption has nothing to look up.
  assert.strictEqual((await checkWith(readsEnglishWithIds(), unlabelled, reader)).chk.present, true);
  // A form that publishes no label at all names no language that is missing from the read: what it lacks is a caption, and a mismatch as ever.
  const none = layoutXml([overview({ tabLabel: null, leftLabel: null, rightLabel: null, tab: { id: TAB_ID }, left: { id: LEFT_ID }, right: { id: RIGHT_ID } })]);
  const bare = await checkWith(none, inSpanish, reader, { languageCode: 3082 });
  assert.strictEqual(bare.chk.present, false);
  assert.match(bare.chk.detail, /tab 'tab_overview' is deployed with no label, the spec declares label: "Resumen" in language 3082/);
  // A string caption whose language cannot be established is not compared in any: there is nothing to look up.
  const unreadable = { ...asking(exportOf(), seen), queryRecords: async (set) => { if (set === 'organization') throw new Error('503'); return set === 'systemform' ? FORM_ROW : []; } };
  const unknown = await checkWith(readsEnglishWithIds(), () => {}, unreadable);
  assert.strictEqual(unknown.res.unverified.length, 1);
  assert.match(unknown.res.unverified[0], /the language the build wrote them in could not be established/);
  assert.deepStrictEqual(seen, [], 'no export was asked for');
});

test('verify compares a label MAP language by language — the languages the read carries in the read, the others in the export', async () => {
  const declared = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 1033: 'Overview', 3082: 'Resumen' }; };
  const seen = [];
  const right = await checkWith(readsEnglishWithIds(), declared, inOrgAsking(exportOf(), seen));
  assert.strictEqual(right.chk.present, true, right.chk.detail);
  assert.strictEqual(right.res.unverified, undefined);
  assert.deepStrictEqual(seen, ['s']);
  // The English caption is held strictly by the read, the Spanish one by the export, and each is reported by itself.
  const both = await checkWith(readsEnglishWithIds({ tabLabel: { text: 'Old', lcid: 1033 } }), declared, inOrgAsking(exportOf(spanishRows({ [TAB_ID]: { 1033: 'Overview', 3082: 'Antiguo' } }))));
  assert.strictEqual(both.chk.present, false);
  assert.match(both.chk.detail, /tab 'tab_overview' is deployed with label "Old" in language 1033, the spec declares label: "Overview" in language 1033/);
  assert.match(both.chk.detail, /tab 'tab_overview' is deployed with label "Antiguo" in language 3082 \(the translation export of solution 's' shows it; /);
  // Only the language the read lacks goes to the export: an English-only map has none, and asks for none.
  const englishOnly = (spec) => { unlabelled(spec); spec.forms[0].tabs[0].label = { 1033: 'Overview' }; };
  const before = [];
  assert.strictEqual((await checkWith(readsEnglishWithIds(), englishOnly, inOrgAsking(exportOf(), before))).chk.present, true);
  assert.deepStrictEqual(before, []);
});

test('verify leaves the captions UNVERIFIED — as before, with the reason — when the translation export cannot be used, and never passes them', async () => {
  const baseline = await checkWith(readsOnlyEnglish(), () => {}, inOrg(1033));
  const opts = { languageCode: 3082 };
  const entry = (why) => SPANISH_STRINGS_ENTRY.replace('from it. Check', `from it. A translation export of solution 's' could not be read (${why}). Check`);
  for (const [what, answer, why] of [
    ['an export the platform refused', { ok: false, reason: 'HTTP 403: Principal user is missing prvExportTranslation privilege' }, 'HTTP 403: Principal user is missing prvExportTranslation privilege'],
    ['a reader that throws', () => { throw new Error('socket hang up'); }, 'socket hang up'],
    ['a reader that answers nothing', undefined, 'the reader gave no answer'],
    ['an answer that is neither a failure nor an export', { ok: true }, 'the reader\'s answer is not an export'],
    ['a failure with no reason', { ok: false }, 'no reason was given'],
  ]) {
    const { res, chk } = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(answer), opts);
    assert.strictEqual(chk.present, true, `${what}: nothing says a caption is wrong: ${chk.detail}`);
    assert.deepStrictEqual(res.missing, baseline.res.missing, `${what}: unverified is not a failure`);
    assert.strictEqual(res.ok, baseline.res.ok, what);
    assert.deepStrictEqual(res.unverified, [entry(why)], what);
    assert.ok(!res.checks.some((c) => /label/i.test(c.kind)), `${what}: no label check was recorded as passed`);
  }
});

// The workbook is read whole or not at all: a reader that picked rows out by name passed over a conflicting caption row written `<ss:Row>` (the
// spreadsheet's own Row, under the root's prefix for its namespace), and over a sheet that declares another namespace, and settled the caption from
// what was left. Through the real reader of the export, each of these now leaves the captions unverified, with the reason — never a pass.
test('verify never settles a caption from a translation workbook it cannot read whole — a conflicting row written with a prefix, a sheet of another namespace, a Number caption', async () => {
  const baseline = await checkWith(readsOnlyEnglish(), () => {}, inOrg(1033));
  const opts = { languageCode: 3082 };
  const good = workbookXml({ captions: spanishRows() });
  const conflicting = `<ss:Row>${['new_ticket', TAB_ID, 'displayname', 'Overview', 'Antiguo'].map((text) => `<ss:Cell><ss:Data ss:Type="String">${text}</ss:Data></ss:Cell>`).join('')}</ss:Row>`;
  const readerOf = async (xml) => readTranslationLabels({ post: async () => exportAnswer(exportZip(xml)) }, 's');
  // The control: the workbook as the platform writes it settles all three captions.
  const control = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(await readerOf(good)), opts);
  assert.strictEqual(control.chk.present, true, control.chk.detail);
  assert.strictEqual(control.res.unverified, undefined);
  for (const [what, xml, why] of [
    ['a conflicting caption row written <ss:Row>', good.replace(/(<Worksheet ss:Name="Localized Labels"[\s\S]*?)(<\/Table>)/, `$1${conflicting}$2`), /has an element <ss:Row>/],
    ['the sheet declared in another namespace', good.replace('<Worksheet ss:Name="Localized Labels"', '<Worksheet xmlns="urn:example:not-spreadsheet" ss:Name="Localized Labels"'), /worksheet with the attribute xmlns,/],
    ['a caption typed as a Number', good.replace('<Data ss:Type="String">Resumen</Data>', '<Data ss:Type="Number">Resumen</Data>'), /has a Number cell/],
  ]) {
    const { res, chk } = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(await readerOf(xml)), opts);
    assert.strictEqual(chk.present, true, `${what}: nothing says a caption is wrong: ${chk.detail}`);
    assert.deepStrictEqual(res.missing, baseline.res.missing, `${what}: unverified is not a failure`);
    assert.strictEqual(res.ok, baseline.res.ok, what);
    assert.strictEqual((res.unverified || []).length, 1, `${what}: the captions stay unverified`);
    assert.match(res.unverified[0], /A translation export of solution 's' could not be read \(the workbook of the export is not readable: /, what);
    assert.match(res.unverified[0], why, what);
  }
});

test('verify leaves a caption unverified, and says why, when the export cannot settle it — no id, no row, a row twice, no column — and settles the others', async () => {
  const opts = { languageCode: 3082 };
  const settles = (res) => (res.unverified || []).join(' | ');
  // The FormXML gives its tab and sections no id: nothing to look them up by.
  const noIds = await checkWith(readsOnlyEnglish(), inSpanish, inOrgAsking(exportOf()), opts);
  assert.strictEqual(noIds.chk.present, true, noIds.chk.detail);
  assert.strictEqual(noIds.res.unverified.length, 1);
  assert.match(noIds.res.unverified[0], /^form-labels:new_ticket\.Ticket Main \(the labels of tab 'tab_overview', section 'sec_left', section 'sec_right' in language 3082 were not compared: the environment's form read returns labels only in 1033, so labels written in 3082 cannot be read back from it\. A translation export of solution 's' was read, but it cannot settle them: the form's FormXML gives a tab or section no id to look it up by\. Check them in Power Apps with that language, or verify in a language the read carries\)$/);
  // The export has no row for the tab: it stays unverified, and the sections are compared — a right one passes, a stale one fails.
  const noTab = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows({ [TAB_ID]: null }))), opts);
  assert.strictEqual(noTab.chk.present, true, noTab.chk.detail);
  assert.strictEqual(noTab.res.unverified.length, 1);
  assert.match(noTab.res.unverified[0], new RegExp(`the label of tab 'tab_overview' in language 3082 was not compared: .*it cannot settle it: the export has no caption row for tab 'tab_overview' \\(id ${TAB_ID}, table new_ticket\\)\\. Check it in Power Apps`));
  assert.doesNotMatch(noTab.res.unverified[0], /sec_left|sec_right/);
  const noTabStale = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows({ [TAB_ID]: null, [LEFT_ID]: { 1033: 'L', 3082: 'Viejo' } }))), opts);
  assert.strictEqual(noTabStale.chk.present, false);
  assert.match(noTabStale.chk.detail, /section 'sec_left' is deployed with label "Viejo" in language 3082/);
  assert.strictEqual(noTabStale.res.unverified.length, 1, 'the tab is still unverified');
  // The id of another table\'s form is not this form\'s.
  const otherTable = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows().map((row) => ({ ...row, entity: 'new_other' })))), opts);
  assert.strictEqual(otherTable.res.unverified.length, 1);
  assert.match(otherTable.res.unverified[0], /the export has no caption row for tab 'tab_overview' \(id [0-9a-f-]+, table new_ticket\)/);
  // Two rows for one id: the export cannot say which is the form\'s.
  const twice = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf([...spanishRows(), { entity: 'new_ticket', id: TAB_ID, texts: { 1033: 'Overview', 3082: 'Otro' } }])), opts);
  assert.strictEqual(twice.chk.present, true, twice.chk.detail);
  assert.match(settles(twice.res), new RegExp(`the export has more than one caption row for tab 'tab_overview' \\(id ${TAB_ID}, table new_ticket\\)`));
  // The export has no column for the language: it cannot show it either.
  const noColumn = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(spanishRows(), [1033])), opts);
  assert.strictEqual(noColumn.chk.present, true, noColumn.chk.detail);
  assert.match(settles(noColumn.res), /it cannot settle them: the export has no column for language 3082\. Check them/);
});

test('verify tells a maker what the flag is for when a string caption is compared in the ORGANIZATION\'s language and the export shows others', async () => {
  // A French build in a Spanish-language organization, verified with no flag: the captions are held to the organization's Spanish, which the read does not
  // carry, and the export has no Spanish caption — the French ones are in 1036. The detail carries the advice a read-carried mismatch carries.
  const french = exportOf([
    { entity: 'new_ticket', id: TAB_ID, texts: { 1033: 'Overview', 1036: 'Apercu' } },
    { entity: 'new_ticket', id: LEFT_ID, texts: { 1033: 'L', 1036: 'Gauche' } },
    { entity: 'new_ticket', id: RIGHT_ID, texts: { 1033: 'R', 1036: 'Droite' } },
  ], [1033, 1036, 3082]);
  const told = await checkWith(readsEnglishWithIds(), inFrench, inOrgAsking(french, undefined, 3082));
  assert.strictEqual(told.chk.present, false);
  assert.match(told.chk.detail, /tab 'tab_overview' is deployed with no label in language 3082 \(the translation export of solution 's' has none, only "Overview" in 1033, "Apercu" in 1036; the form read does not carry language 3082\), the spec declares label: "Apercu" in language 3082/);
  assert.match(told.chk.detail, /the labels were compared in the organization's base language \(3082\), because verify was told no other: if the build was run with --language-code, give verify the same flag \(or pin "languageCode" in the spec\)/);
  // Told the language the build was run in, the export settles them.
  const given = await checkWith(readsEnglishWithIds(), inFrench, inOrgAsking(french, undefined, 3082), { languageCode: 1036 });
  assert.strictEqual(given.chk.present, true, given.chk.detail);
  assert.strictEqual(given.res.unverified, undefined);
  // A right caption in the organization\'s language is not blamed on a guess.
  const spanish = await checkWith(readsEnglishWithIds(), inSpanish, inOrgAsking(exportOf(), undefined, 3082));
  assert.strictEqual(spanish.chk.present, true, spanish.chk.detail);
  assert.strictEqual(spanish.res.unverified, undefined);
});
