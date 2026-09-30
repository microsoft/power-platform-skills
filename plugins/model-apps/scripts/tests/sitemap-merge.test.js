'use strict';
// Unit tests for lib/sitemap-merge.js (AB#6726727). The end-to-end behaviour through the real SDK is in
// sitemap-adopt-real-bundle.test.js; these pin the correspondence rules one at a time.
const { test } = require('node:test');
const assert = require('node:assert');
const { adoptLiveSitemap, chromeByTargetKey, describeSitemapNotes, subAreaTargetKey, isDashboardLauncherUrl, DASHBOARD_LAUNCHER_URL } = require('../lib/sitemap-merge.js');

const bag = (id, extra = []) => ({ a: [['Id', id], ...extra], c: [] });
const entitySub = (id, entity, title, b) => ({ id, type: 'Entity', entity, title, ...(b ? { bag: b } : {}) });
const tree = (areas) => ({ areas });

test('a subarea corresponds by its navigation target, compared the way it resolves', () => {
  assert.strictEqual(subAreaTargetKey({ type: 'Entity', entity: ' New_Order ' }), 'Entity:new_order');
  assert.strictEqual(subAreaTargetKey({ type: 'DashBoard', dashboardId: '{280948EC-7BBB-5279-B106-2BDD09451A3A}' }), 'DashBoard:280948ec-7bbb-5279-b106-2bdd09451a3a');
  assert.strictEqual(subAreaTargetKey({ type: 'GenPage', genPageId: 'ABC' }), 'GenPage:abc');
  // Scheme and host fold; a path or query value can be case-sensitive, so it does not.
  assert.strictEqual(subAreaTargetKey({ type: 'URL', url: 'HTTPS://Contoso.example/Help?key=AbC' }), 'URL:https://contoso.example/Help?key=AbC');
  // A web-resource reference names a case-insensitive web resource.
  assert.strictEqual(subAreaTargetKey({ type: 'URL', url: '$webresource:New_Home.html' }), 'URL:$webresource:new_home.html');
  assert.strictEqual(subAreaTargetKey({ type: 'Entity' }), undefined, 'no target, no identity');
  assert.strictEqual(subAreaTargetKey(null), undefined);
});

test('a URL whose case changed in the spec is a new entry, written as the spec spells it', () => {
  const live = tree([{ id: 'a', title: 'M', groups: [{ id: 'g', title: 'G', subAreas: [{ id: 'help', type: 'URL', url: 'https://contoso.example/help?key=abc', title: 'Help', bag: bag('help') }] }] }]);
  const desired = tree([{ id: 'area_0', title: 'M', groups: [{ id: 'group_0_0', title: 'G', subAreas: [{ id: 'sub_0_0_0', type: 'URL', url: 'https://contoso.example/help?key=AbC', title: 'Help' }] }] }]);
  const sub = adoptLiveSitemap(desired, live).siteMap.areas[0].groups[0].subAreas[0];
  assert.strictEqual(sub.url, 'https://contoso.example/help?key=AbC', 'the spec\u2019s token, not the live one');
  const sameHostCase = tree([{ id: 'area_0', title: 'M', groups: [{ id: 'group_0_0', title: 'G', subAreas: [{ id: 'sub_0_0_0', type: 'URL', url: 'HTTPS://CONTOSO.example/help?key=abc', title: 'Help' }] }] }]);
  const adopted = adoptLiveSitemap(sameHostCase, live).siteMap.areas[0].groups[0].subAreas[0];
  assert.strictEqual(adopted.id, 'help', 'only the scheme and host differ: the same entry');
  assert.strictEqual(adopted.url, 'HTTPS://CONTOSO.example/help?key=abc', 'and the spec\u2019s spelling is still what is written');
});

test('an adopted subarea keeps the live id, bag and target spelling; the spec sets only what it describes', () => {
  const live = tree([{ id: 'a1', title: 'Main', bag: bag('a1'), groups: [{ id: 'g1', title: 'G', bag: bag('g1'), subAreas: [
    { id: 'ops', type: 'DashBoard', dashboardId: '{280948EC-7BBB-5279-B106-2BDD09451A3A}', dashboardUrl: '/workplace/home_dashboards.aspx', title: 'Ops', bag: bag('ops', [['Client', 'All,Web']]) },
  ] }] }]);
  const desired = tree([{ id: 'area_0', title: 'Main', groups: [{ id: 'group_0_0', title: 'G', subAreas: [
    { id: 'sub_0_0_0', type: 'DashBoard', dashboardId: '280948ec-7bbb-5279-b106-2bdd09451a3a', dashboardUrl: DASHBOARD_LAUNCHER_URL, title: 'Ops' },
  ] }] }]);
  const { siteMap } = adoptLiveSitemap(desired, live);
  const sub = siteMap.areas[0].groups[0].subAreas[0];
  assert.strictEqual(sub.id, 'ops');
  assert.strictEqual(sub.dashboardId, '{280948EC-7BBB-5279-B106-2BDD09451A3A}', 'the live spelling, so the XML does not change for nothing');
  assert.strictEqual(sub.dashboardUrl, '/workplace/home_dashboards.aspx');
  assert.deepStrictEqual(sub.bag.a, bag('ops', [['Client', 'All,Web']]).a);
  assert.notStrictEqual(sub.bag, live.areas[0].groups[0].subAreas[0].bag, 'a copy — never aliases the workspace copy');
  assert.ok(!('__adopted' in sub) && !('__adopted' in siteMap.areas[0]), 'no bookkeeping leaks to the SDK');
});

test('every adopted dashboard entry gets exactly the launcher both its consumers accept', () => {
  // The designer recognizes a dashboard entry only when the whole Url equals the launcher; the
  // runtime's glyph test is a case-SENSITIVE substring match. Only the exact string passes both.
  const live = tree([{ id: 'a', title: 'M', groups: [{ id: 'g', title: 'G', subAreas: [
    { id: 'd', type: 'DashBoard', dashboardId: 'x', dashboardUrl: '/somewhere/else.aspx', title: 'D', bag: bag('d') },
    { id: 'e', type: 'DashBoard', dashboardId: 'y', title: 'E', bag: bag('e') },
    { id: 'f', type: 'DashBoard', dashboardId: 'z', dashboardUrl: '/WorkPlace/Home_Dashboards.aspx', title: 'F', bag: bag('f') },
    { id: 'h', type: 'DashBoard', dashboardId: 'w', dashboardUrl: '/workplace/home_dashboards.aspx?pagetype=dashboard', title: 'H', bag: bag('h') },
  ] }] }]);
  const desired = tree([{ id: 'area_0', title: 'M', groups: [{ id: 'group_0_0', title: 'G', subAreas: ['x', 'y', 'z', 'w'].map((id, i) => (
    { id: `s${i}`, type: 'DashBoard', dashboardId: id, dashboardUrl: DASHBOARD_LAUNCHER_URL, title: 'T' })) }] }]);
  const subs = adoptLiveSitemap(desired, live).siteMap.areas[0].groups[0].subAreas;
  assert.deepStrictEqual(subs.map((s) => [s.id, s.dashboardUrl]), [['d', DASHBOARD_LAUNCHER_URL], ['e', DASHBOARD_LAUNCHER_URL], ['f', DASHBOARD_LAUNCHER_URL], ['h', DASHBOARD_LAUNCHER_URL]]);
  assert.ok(isDashboardLauncherUrl('/workplace/home_dashboards.aspx'));
  for (const bad of ['/WorkPlace/Home_Dashboards.aspx', '/workplace/home_dashboards.aspx?x=1', '/main.aspx', undefined]) assert.ok(!isDashboardLauncherUrl(bad), String(bad));
});

test('a same-target twin in the entry\u2019s own group is preferred; each live node is adopted at most once', () => {
  const live = tree([{ id: 'a', title: 'M', groups: [
    { id: 'g1', title: 'One', subAreas: [entitySub('in_one', 'new_x', 'X', bag('in_one'))] },
    { id: 'g2', title: 'Two', subAreas: [entitySub('in_two', 'new_x', 'X', bag('in_two'))] },
  ] }]);
  const desired = tree([{ id: 'area_0', title: 'M', groups: [
    { id: 'group_0_0', title: 'Two', subAreas: [entitySub('sub_0_0_0', 'new_x', 'X'), entitySub('sub_0_0_1', 'new_x', 'X'), entitySub('sub_0_0_2', 'new_x', 'X')] },
  ] }]);
  const subs = adoptLiveSitemap(desired, live).siteMap.areas[0].groups[0].subAreas;
  assert.deepStrictEqual(subs.map((s) => s.id), ['in_two', 'in_one', 'sub_0_0_2'], 'own group first, then elsewhere, then new');
  assert.strictEqual(subs[2].bag, undefined, 'a new entry is built from scratch');
});

test('areas and groups correspond by label, then by the id an earlier build gave them, then (unlabelled) in order', () => {
  const live = tree([
    { id: 'designer_area', title: 'Operations', bag: bag('designer_area'), groups: [] },
    { id: 'area_1', title: 'Renamed live', bag: bag('area_1'), groups: [] },
    { id: 'fr_only', title: '', bag: bag('fr_only'), groups: [] },
  ]);
  const desired = tree([
    { id: 'area_0', title: 'operations', groups: [] },
    { id: 'area_1', title: 'Spec label', groups: [] },
    { id: 'area_2', title: '', groups: [] },
  ]);
  const { siteMap, notes } = adoptLiveSitemap(desired, live);
  assert.deepStrictEqual(siteMap.areas.map((a) => a.id), ['designer_area', 'area_1', 'fr_only']);
  assert.ok(notes.some((n) => n.node === 'area' && n.live === 'Renamed live' && n.spec === 'Spec label'));
  assert.ok(describeSitemapNotes(notes).some((l) => /area "Renamed live": title changes from 'Renamed live' to the spec's 'Spec label'\.$/.test(l)));
});

test('a new node never takes an id an adopted node holds', () => {
  // appDef numbers by position, so a NEW first area is `area_0` — the id an adopted, moved area keeps.
  const live = tree([{ id: 'area_0', title: 'Existing', bag: bag('area_0'), groups: [{ id: 'group_0_0', title: 'G', bag: bag('group_0_0'), subAreas: [] }] }]);
  const desired = tree([
    { id: 'area_0', title: 'Brand new', groups: [{ id: 'group_0_0', title: 'New group', subAreas: [] }] },
    { id: 'area_1', title: 'Existing', groups: [{ id: 'group_1_0', title: 'G', subAreas: [] }] },
  ]);
  const ids = adoptLiveSitemap(desired, live).siteMap.areas.flatMap((a) => [a.id, ...a.groups.map((g) => g.id)]);
  assert.deepStrictEqual(ids, ['area_0_2', 'group_0_0_2', 'area_0', 'group_0_0']);
  assert.strictEqual(new Set(ids.map((i) => i.toLowerCase())).size, ids.length);
});

test('chrome the spec has not changed since the baseline, but the environment has, is kept', () => {
  const live = tree([{ id: 'a', title: 'M', groups: [{ id: 'g', title: 'G', subAreas: [
    { ...entitySub('s', 'new_x', 'Renamed in designer', bag('s')), icon: 'New_Icon.PNG', vectorIcon: '/WebResources/new_/x.svg' },
  ] }] }]);
  const desired = tree([{ id: 'area_0', title: 'M', groups: [{ id: 'group_0_0', title: 'G', subAreas: [
    { ...entitySub('sub', 'new_x', 'Original'), icon: 'new_icon.png', vectorIcon: '/WebResources/new_/y.svg' },
  ] }] }]);
  const baseSpec = { appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_x', title: 'Original', icon: 'new_icon.png', vectorIcon: '/WebResources/new_/x.svg' }] }] }] } };
  const { siteMap, notes } = adoptLiveSitemap(desired, live, { baseChrome: chromeByTargetKey(baseSpec) });
  const sub = siteMap.areas[0].groups[0].subAreas[0];
  assert.strictEqual(sub.title, 'Renamed in designer', 'kept: unchanged in the spec, changed live');
  assert.strictEqual(sub.icon, 'New_Icon.PNG', 'the same icon (case aside) is re-emitted as the live string');
  assert.strictEqual(sub.vectorIcon, '/WebResources/new_/y.svg', 'changed in the spec since the baseline: applied');
  assert.deepStrictEqual(notes.map((n) => [n.kind, n.field]), [['kept', 'title'], ['changed', 'vectorIcon']]);
  assert.deepStrictEqual(describeSitemapNotes(notes).length, 1, 'an edit the spec made is not repeated back');
});

test('a kept value that is absent live is removed from the typed node, not written as empty', () => {
  const live = tree([{ id: 'a', title: 'M', groups: [{ id: 'g', title: 'G', subAreas: [entitySub('s', 'new_x', 'X', bag('s'))] }] }]);
  const desired = tree([{ id: 'area_0', title: 'M', groups: [{ id: 'group_0_0', title: 'G', subAreas: [{ ...entitySub('sub', 'new_x', 'X'), icon: 'old.png' }] }] }]);
  const baseSpec = { appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_x', title: 'X', icon: 'old.png' }] }] }] } };
  const sub = adoptLiveSitemap(desired, live, { baseChrome: chromeByTargetKey(baseSpec) }).siteMap.areas[0].groups[0].subAreas[0];
  assert.ok(!('icon' in sub), 'the designer removed the icon; the stale spec does not put it back');
});

test('chromeByTargetKey resolves dashboards and pages through this build\u2019s ids and drops ambiguous targets', () => {
  const spec = { appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [
    { dashboard: 'Ops', title: 'Operations' },
    { page: 'home', title: 'Home' },
    { dashboard: 'Unbuilt', title: 'Nope' },
    { entity: 'new_x', title: 'X one' }, { entity: 'NEW_X', title: 'X two' },
    { url: 'https://contoso.example/help', title: 'Help' },
  ] }] }] } };
  const map = chromeByTargetKey(spec, { dashboards: { Ops: '{AAAAAAAA-0000-0000-0000-000000000001}' }, pages: { home: 'BBBBBBBB-0000-0000-0000-000000000002' } });
  assert.deepStrictEqual([...map.keys()].sort(), ['DashBoard:aaaaaaaa-0000-0000-0000-000000000001', 'GenPage:bbbbbbbb-0000-0000-0000-000000000002', 'URL:https://contoso.example/help']);
  assert.strictEqual(chromeByTargetKey(null).size, 0);
});

test('nothing live (a first write, or an unreadable copy) leaves the desired tree as it is', () => {
  const desired = tree([{ id: 'area_0', title: 'M', groups: [{ id: 'group_0_0', title: 'G', subAreas: [entitySub('sub_0_0_0', 'new_x', 'X')] }] }]);
  for (const live of [undefined, null, {}, { areas: 'nope' }]) {
    const { siteMap, notes } = adoptLiveSitemap(desired, live);
    assert.deepStrictEqual(siteMap, desired);
    assert.deepStrictEqual(notes, []);
  }
});
