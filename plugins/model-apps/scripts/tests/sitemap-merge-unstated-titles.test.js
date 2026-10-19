'use strict';
// Unit tests for what a rebuild does with the title of a navigation node the spec gives none (lib/sitemap-merge.js). The same rules end to end, through the real SDK, are in
// nav-titles-base-language-real-bundle.test.js and sitemap-adopt-real-bundle.test.js.
//
// A spec's empty label or title says nothing, it does not ask for none: the download of an environment whose base language is not 1033 once wrote every label empty, and
// the spec an author leaves a title out of has not asked for the title to go either. So a title the live node holds is kept — unless the spec's baseline shows the author took
// the title of an ENTRY out of a spec that had stated it, which is an edit and is applied. Areas and groups have no target to find a baseline by, so they are always kept.
const { test } = require('node:test');
const assert = require('node:assert');
const { adoptLiveSitemap, chromeByTargetKey, describeSitemapNotes } = require('../lib/sitemap-merge.js');

const bag = (id, children = []) => ({ a: [['Id', id]], c: children });
const titlesChild = (i, byLanguage) => ({ i, node: { n: 'Titles', a: [], c: Object.entries(byLanguage).map(([lcid, title]) => ({ n: 'Title', a: [['LCID', lcid], ['Title', title]], c: [] })) } });
const tree = (areas) => ({ areas });
const entry = (id, entity, title, b) => ({ id, type: 'Entity', entity, title, ...(b ? { bag: b } : {}) });
const live = () => tree([{ id: 'area_0', title: 'Trabajo', bag: bag('area_0', [titlesChild(0, { 3082: 'Trabajo' })]), groups: [
  { id: 'group_0_0', title: 'Casos', bag: bag('group_0_0', [titlesChild(0, { 3082: 'Casos' })]), subAreas: [
    entry('sub_0_0_0', 'contoso_case', 'Expedientes', bag('sub_0_0_0', [titlesChild(0, { 3082: 'Expedientes' })])),
  ] },
] }]);
const desired = ({ area, group, title }) => tree([{ id: 'area_0', title: area, groups: [{ id: 'group_0_0', title: group, subAreas: [entry('sub_0_0_0', 'contoso_case', title)] }] }]);
const specOf = (label, groupLabel, title) => ({ appShell: { areas: [{ label, groups: [{ label: groupLabel, subAreas: [{ entity: 'contoso_case', ...(title === undefined ? {} : { title }) }] }] }] } });
const kinds = (notes) => notes.map((n) => [n.kind, n.node, n.field, n.unspecified === true]);

test('an area or group the spec gives no label keeps the title it has, whether the label is empty, blank or absent', () => {
  for (const nothing of ['', '  ', undefined, null]) {
    const { siteMap, notes } = adoptLiveSitemap(desired({ area: nothing, group: nothing, title: 'Expedientes' }), live(), { lcid: 3082 });
    const area = siteMap.areas[0];
    assert.strictEqual(area.title, 'Trabajo', JSON.stringify(nothing));
    assert.strictEqual(area.groups[0].title, 'Casos', JSON.stringify(nothing));
    assert.deepStrictEqual(area.bag.c.map((e) => e.node.n), ['Titles'], 'and its titles are still there to be written back');
    assert.deepStrictEqual(kinds(notes), [['kept', 'area', 'title', true], ['kept', 'group', 'title', true]], JSON.stringify(nothing));
  }
});

test('the notes for a title kept because the spec gives none say so, once per node, and name what a spec can do about it', () => {
  const { notes } = adoptLiveSitemap(desired({ area: '', group: '', title: '' }), live(), { lcid: 3082 });
  assert.deepStrictEqual(describeSitemapNotes(notes), [
    'area "Trabajo": kept the environment\'s title \'Trabajo\' \u2014 the spec has none for it, so it is left as it is. State one in the spec to change it.',
    'group "Casos": kept the environment\'s title \'Casos\' \u2014 the spec has none for it, so it is left as it is. State one in the spec to change it.',
    'nav entry "Expedientes": kept the environment\'s title \'Expedientes\' \u2014 the spec has none for it, so it is left as it is. State one in the spec to change it.',
  ]);
});

test('a node the spec gives no title and the environment holds none for says nothing and changes nothing', () => {
  const untitled = tree([{ id: 'area_0', title: '', bag: bag('area_0'), groups: [{ id: 'group_0_0', title: '', bag: bag('group_0_0'), subAreas: [entry('sub_0_0_0', 'contoso_case', '', bag('sub_0_0_0'))] }] }]);
  const { siteMap, notes } = adoptLiveSitemap(desired({ area: '', group: '', title: '' }), untitled, { lcid: 3082 });
  assert.deepStrictEqual(notes, []);
  assert.deepStrictEqual(siteMap.areas[0].bag.c, [], 'no empty <Titles> is invented for it');
  assert.strictEqual(siteMap.areas[0].title, '');
});

test('a node whose live title is in another language only is the spec\u2019s to title, and nothing of the other language is touched', () => {
  const onlyFrench = tree([{ id: 'area_0', title: '', bag: bag('area_0', [titlesChild(0, { 1036: 'Travail' })]), groups: [{ id: 'group_0_0', title: '', bag: bag('group_0_0'), subAreas: [] }] }]);
  const { siteMap, notes } = adoptLiveSitemap(tree([{ id: 'area_0', title: 'Work', groups: [{ id: 'group_0_0', title: '', subAreas: [] }] }]), onlyFrench, { lcid: 1033 });
  assert.deepStrictEqual(notes.map((n) => [n.kind, n.live, n.spec]), [['changed', '', 'Work']]);
  assert.deepStrictEqual(siteMap.areas[0].bag.c[0].node.c.map((t) => t.a[0][1]), ['1036'], 'the French title is as it was; the SDK adds the English one beside it');
});

test('a title the spec states is applied, with a note, as before', () => {
  const { siteMap, notes } = adoptLiveSitemap(desired({ area: 'Operaciones', group: 'Expedientes', title: 'Casos' }), live(), { lcid: 3082 });
  assert.strictEqual(siteMap.areas[0].title, 'Operaciones');
  assert.strictEqual(siteMap.areas[0].groups[0].title, 'Expedientes');
  assert.strictEqual(siteMap.areas[0].groups[0].subAreas[0].title, 'Casos');
  assert.deepStrictEqual(kinds(notes), [['changed', 'area', 'title', false], ['changed', 'group', 'title', false], ['changed', 'subArea', 'title', false]]);
});

test('an entry the spec gives no title keeps its own when no baseline says the spec ever stated one', () => {
  for (const [what, opts] of [['no baseline', {}], ['a baseline that does not list the entry', { baseChrome: chromeByTargetKey({ appShell: { areas: [] } }) }]]) {
    const { siteMap, notes } = adoptLiveSitemap(desired({ area: 'Trabajo', group: 'Casos', title: undefined }), live(), { lcid: 3082, ...opts });
    const sub = siteMap.areas[0].groups[0].subAreas[0];
    assert.strictEqual(sub.title, 'Expedientes', what);
    assert.deepStrictEqual(kinds(notes), [['kept', 'subArea', 'title', true]], what);
  }
});

test('an entry the spec and its baseline both give no title keeps the title the environment gained, as it did, and says so as it did', () => {
  const baseline = specOf('Trabajo', 'Casos');
  const { siteMap, notes } = adoptLiveSitemap(desired({ area: 'Trabajo', group: 'Casos', title: undefined }), live(), { lcid: 3082, baseChrome: chromeByTargetKey(baseline) });
  assert.strictEqual(siteMap.areas[0].groups[0].subAreas[0].title, 'Expedientes');
  assert.deepStrictEqual(kinds(notes), [['kept', 'subArea', 'title', false]]);
  assert.match(describeSitemapNotes(notes)[0], /^nav entry "Expedientes": kept the environment's title 'Expedientes' \u2014 it changed there after this spec was last applied or downloaded, and the spec still has \(none\)\./);
});

test('an entry whose title the spec\u2019s baseline states and the spec now leaves out loses it: an author\u2019s edit, applied, with the other languages kept', () => {
  const both = live();
  both.areas[0].groups[0].subAreas[0].bag = bag('sub_0_0_0', [titlesChild(0, { 1033: 'Cases', 3082: 'Expedientes' }), { i: 1, node: { n: 'Privilege', a: [['Entity', 'contoso_case']], c: [] } }]);
  const baseline = specOf('Trabajo', 'Casos', 'Expedientes');
  const { siteMap, notes } = adoptLiveSitemap(desired({ area: 'Trabajo', group: 'Casos', title: undefined }), both, { lcid: 3082, baseChrome: chromeByTargetKey(baseline) });
  const sub = siteMap.areas[0].groups[0].subAreas[0];
  assert.ok(!sub.title, 'no typed title: the SDK is not asked to write one');
  assert.deepStrictEqual(sub.bag.c.map((e) => [e.i, e.node.n]), [[0, 'Titles'], [1, 'Privilege']]);
  assert.deepStrictEqual(sub.bag.c[0].node.c.map((t) => t.a[0][1]), ['1033'], 'only the title at the build\u2019s language goes');
  assert.deepStrictEqual(kinds(notes), [['changed', 'subArea', 'title', false]]);
  assert.strictEqual(notes[0].intended, true);
  assert.deepStrictEqual(describeSitemapNotes(notes), [], 'an edit the author made is not repeated back');
});

test('removing an entry\u2019s last title keeps its other children where the schema wants them', () => {
  const only = live();
  only.areas[0].groups[0].subAreas[0].bag = bag('sub_0_0_0', [titlesChild(0, { 3082: 'Expedientes' }), { i: 1, node: { n: 'Privilege', a: [['Entity', 'contoso_case']], c: [] } }]);
  const baseline = specOf('Trabajo', 'Casos', 'Expedientes');
  const { siteMap } = adoptLiveSitemap(desired({ area: 'Trabajo', group: 'Casos', title: undefined }), only, { lcid: 3082, baseChrome: chromeByTargetKey(baseline) });
  assert.deepStrictEqual(siteMap.areas[0].groups[0].subAreas[0].bag.c.map((e) => [e.i, e.node.n]), [[0, 'Privilege']], 'the wrapper goes with its last title and the next child moves up');
  assert.deepStrictEqual(only.areas[0].groups[0].subAreas[0].bag.c.map((e) => e.i), [0, 1], 'the live bag is not touched');
});
