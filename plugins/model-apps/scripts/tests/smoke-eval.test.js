'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSmokeSpec, runSmokeAssertions, subAreaTag, hasSitemapAttr } = require('../smoke-eval.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { appDef } = require('../lib/sdk-build.js');

// Render the sitemap XML the platform returns for a built spec, FROM the definition the builder
// actually emits (including the parent <Area> icon and the nested <Titles> the real SDK writes).
// This is a faithful stand-in for the org, not a statement of what we want to see: the live
// assertions carry their own expectations, so if appDef stops emitting a value this XML stops
// containing it and the assertion FAILS — which is how the offline suite now catches, before a live
// run, the class of defect that previously only showed up against a real org.
function sitemapXmlFor(spec) {
  const def = appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {}, pages: {} });
  const area = def.siteMap.areas[0];
  const subs = area.groups[0].subAreas.map((s) => {
    const attrs = [
      `Id="${s.id}"`,
      s.entity ? `Entity="${s.entity}"` : '',
      s.icon !== undefined ? `Icon="${s.icon}"` : '',
      s.vectorIcon !== undefined ? `VectorIcon="${s.vectorIcon}"` : '',
    ].filter(Boolean);
    return `<SubArea ${attrs.join(' ')}><Titles><Title LCID="1033" Title="${s.title}" /></Titles></SubArea>`;
  });
  return `<SiteMap><Area Id="${area.id}"${area.icon ? ` Icon="${area.icon}"` : ''}><Titles><Title LCID="1033" Title="${area.title}" /></Titles>`
    + `<Group Id="${area.groups[0].id}">${subs.join('')}</Group></Area></SiteMap>`;
}

const enrichedViews = async () => [{ name: 'Active t Orders', layoutxml: '<grid><row><cell name="new_name"/><cell name="new_status"/></row></grid>' }];
const runAgainst = (spec, xml) => runSmokeAssertions(spec, 'app-1', { queryRecords: enrichedViews, sitemapXml: async () => xml });

test('buildSmokeSpec produces a valid spec that exercises icons + default-view enrichment', () => {
  const spec = buildSmokeSpec('t');
  const r = validateAppSpec(spec);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(spec.entities[0].columns.length, 2, 'has extra columns so default views enrich');
  assert.ok(spec.appShell.areas[0].groups[0].subAreas[0].icon, 'subarea has a raster icon');
  assert.ok(spec.webResources.some((w) => w.type === 'svg'), 'declares an SVG web resource for the vector nav icon');
});

// The roles the live assertions depend on. If these two subareas are ever reordered or reshaped, the
// live eval starts asserting the wrong thing, so pin them here rather than in a comment.
test('the smoke spec fixes subarea 0 as the platform-ref case and subarea 1 as the bare-token case', () => {
  const [refSub, tokenSub] = buildSmokeSpec('t').appShell.areas[0].groups[0].subAreas;
  assert.strictEqual(refSub.vectorIcon, '/WebResources/new_tvec.svg');
  assert.strictEqual(tokenSub.vectorIcon, 'Grid');
  assert.ok(refSub.entity && tokenSub.entity, 'both are ENTITY subareas — that is the case the drop rule is about');
  assert.notStrictEqual(refSub.title, tokenSub.title, 'titles must differ; they are how the sitemap subareas are located');
});

// The regression this file exists to prevent: a vectorIcon the smoke spec DECLARES on subarea 0 must
// be one the builder actually EMITS, or the live assertion is unsatisfiable. A bare Fluent token
// fails this, which is why "Grid" alone could never pass live.
test('the smoke spec asks for a vectorIcon the builder actually emits', () => {
  const spec = buildSmokeSpec('t');
  const emitted = appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {}, pages: {} }).siteMap.areas[0].groups[0].subAreas;
  assert.strictEqual(emitted[0].vectorIcon, '/WebResources/new_tvec.svg', 'platform-ref vectorIcon survives appDef on an Entity subarea');
  assert.strictEqual(emitted[0].icon, 'new_ticon.png');
  assert.strictEqual(emitted[1].vectorIcon, undefined, 'the bare token is dropped from the emitted definition');
});

// The negative control is deliberate, not an authoring mistake: validateAppSpec must WARN about the
// bare token rather than reject the spec, or the smoke build would refuse to run at all.
test('a bare Fluent token on an entity subarea is warned about, not rejected', () => {
  const r = validateAppSpec(buildSmokeSpec('t'));
  assert.strictEqual(r.ok, true, 'a dropped vectorIcon is a warning, never a build-blocking error');
  assert.strictEqual((r.warnings || []).filter((w) => /vectorIcon 'Grid' is a bare token/.test(w)).length, 1);
});

test('runSmokeAssertions passes against the sitemap the builder actually produces', async () => {
  const spec = buildSmokeSpec('t');
  const results = await runAgainst(spec, sitemapXmlFor(spec));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results, null, 1));
});

test('runSmokeAssertions fails when enrichment or icons are missing', async () => {
  const spec = buildSmokeSpec('t');
  const results = await runSmokeAssertions(spec, 'app-1', {
    queryRecords: async () => [{ name: 'Active t Orders', layoutxml: '<grid><row><cell name="new_name"/></row></grid>' }],
    sitemapXml: async () => '<SiteMap><SubArea/></SiteMap>',
  });
  assert.ok(results.some((r) => !r.ok && /enriched/.test(r.name)), 'enrichment assertion should fail');
  assert.ok(results.some((r) => !r.ok && /Icon/.test(r.name)), 'icon assertion should fail');
});

// A regression that started writing bare tokens onto entity subareas again would still satisfy every
// positive assertion, so the negative control has to be the thing that fails.
test('runSmokeAssertions fails when the bare token reappears in the deployed sitemap', async () => {
  const spec = buildSmokeSpec('t');
  const xml = sitemapXmlFor(spec).replace(/(<SubArea\b[^>]*Id="sub_0_0_1"[^>]*?)>/, '$1 VectorIcon="Grid">');
  assert.match(xml, /VectorIcon="Grid"/, 'the fixture must actually contain the regressed value');
  const results = await runAgainst(spec, xml);
  const control = results.find((r) => /bare token VectorIcon="Grid" is absent/.test(r.name));
  assert.ok(control && !control.ok, 'negative control must fail when the bare token is emitted again');
});

// THE key guard. The eval's expectations must NOT be derived from appDef: if they were, a builder
// that stopped emitting the vectorIcon would flip "must be present" into "must be absent" and the
// live run would report PASS while shipping apps with no nav glyph.
test('runSmokeAssertions FAILS when the builder stops emitting the platform-ref vectorIcon', async () => {
  const spec = buildSmokeSpec('t');
  // A deployed sitemap exactly as a regressed builder (one that drops ALL entity vectorIcons) leaves it.
  const xml = sitemapXmlFor(spec).replace(/ VectorIcon="[^"]*"/g, '');
  const results = await runAgainst(spec, xml);
  const positive = results.find((r) => /carries VectorIcon="\/WebResources\/new_tvec\.svg"/.test(r.name));
  assert.ok(positive && !positive.ok, 'the missing platform-ref vectorIcon must be reported as a FAILURE');
  assert.ok(!results.every((r) => r.ok), 'the eval as a whole must fail');
});

// A nav that collapses to nothing must fail loudly rather than vacuously satisfy every check.
test('runSmokeAssertions fails when the deployed sitemap has no subareas at all', async () => {
  const spec = buildSmokeSpec('t');
  const results = await runAgainst(spec, '<SiteMap><Area Id="area_0" Icon="new_ticon.png"><Group Id="group_0_0"></Group></Area></SiteMap>');
  assert.ok(results.some((r) => !r.ok && /contains subarea "Orders"/.test(r.name)), 'a missing subarea must be reported');
  assert.ok(!results.every((r) => r.ok));
});

// The smoke spec reuses one raster icon on the AREA and both subareas, so a document-wide scan would
// let <Area Icon="…"> alone satisfy every per-subarea icon assertion.
test('a subarea icon assertion is not satisfied by the parent Area icon', async () => {
  const spec = buildSmokeSpec('t');
  // Strip Icon from the SubArea elements only; the Area keeps its identical icon.
  const xml = sitemapXmlFor(spec).replace(/(<SubArea\b[^>]*?) Icon="[^"]*"/g, '$1');
  assert.match(xml, /<Area\b[^>]*Icon="new_ticon\.png"/, 'the Area still carries the same icon value');
  const results = await runAgainst(spec, xml);
  const iconChecks = results.filter((r) => /carries Icon=/.test(r.name));
  assert.strictEqual(iconChecks.length, 2, 'both subareas are icon-checked');
  assert.ok(iconChecks.every((r) => !r.ok), 'neither may be satisfied by the Area-level icon');
});

test('subAreaTag returns only the matching SubArea open tag', () => {
  const xml = '<SiteMap><Area Id="area_0" Icon="area.png"><Titles><Title Title="Main" /></Titles>'
    + '<SubArea Id="a" Icon="one.png"><Titles><Title LCID="1033" Title="Orders" /></Titles></SubArea>'
    + '<SubArea Id="b" Icon="two.png" VectorIcon="Grid"><Titles><Title LCID="1033" Title="Orders (token)" /></Titles></SubArea>'
    + '</Area></SiteMap>';
  assert.match(subAreaTag(xml, 'Orders'), /Id="a"/);
  // "Orders" must not match the LATER "Orders (token)" subarea, and vice versa — parentheses in the
  // title are regex metacharacters and must be escaped.
  assert.match(subAreaTag(xml, 'Orders (token)'), /Id="b"/);
  assert.ok(!/Id="b"/.test(subAreaTag(xml, 'Orders')), 'the lazy scan must stop at the next <SubArea>');
  assert.strictEqual(subAreaTag(xml, 'Nope'), '', 'absent title yields no tag');
  // Only the OPEN tag is returned, so a nested <Title Title="…"> can never satisfy an attribute check.
  assert.ok(!/<Titles>/.test(subAreaTag(xml, 'Orders')));
});

test('hasSitemapAttr matches whole attribute names and escapes path values', () => {
  const tag = '<SubArea Id="a" Icon="new_ticon.png" VectorIcon="/WebResources/new_tvec.svg">';
  assert.strictEqual(hasSitemapAttr(tag, 'VectorIcon', '/WebResources/new_tvec.svg'), true);
  assert.strictEqual(hasSitemapAttr(tag, 'Icon', 'new_ticon.png'), true);
  // `Icon` must not match inside `VectorIcon` — a substring check would conflate the two.
  assert.strictEqual(hasSitemapAttr(tag, 'Icon', '/WebResources/new_tvec.svg'), false);
  // `.` and `/` in a platform ref must stay literal, not act as regex metacharacters.
  assert.strictEqual(hasSitemapAttr(tag, 'VectorIcon', '/WebResources/new_tvecXsvg'), false);
});
