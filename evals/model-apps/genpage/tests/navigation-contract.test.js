'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ASSERTIONS } = require('../lib/assertions-layer-2.js');
const { PHASE_EXPECTATIONS } = require('../lib/assertions-layer-1.js');
const { loadFixtures } = require('../lib/fixture-loader.js');

const NAV = 'For multi-page builds, cross-page navigation uses quoted `"PAGEREF_<filename>"` placeholders that the orchestrator\'s Phase 6.5 resolves to real GUIDs';
const FIXUP = 'Phase 6.5: Every effective navigation target resolves against the deployed page map; exact substitutions preserve non-navigation bytes and only affected pages reupload';
const IDS = {
  overview: '22222222-2222-4222-8222-222222222222',
  pet: '33333333-3333-4333-8333-333333333333',
  'pet-gallery': '44444444-4444-4444-8444-444444444444',
};
const ev = { id: 22, expectations: [] };

function navigationFixture() {
  const before = {
    overview: [
      'const label = "PAGEREF_pet";',
      '// Xrm.Navigation.navigateTo({pageType:"generative",pageId:"PAGEREF_comment"});',
      'xrm?.Navigation?.navigateTo?.({pageType:"generative",pageId:"PAGEREF_unknown",pageId:"PAGEREF_pet-gallery",data:{pageId:"PAGEREF_data"}});',
      'xrm?.Navigation?.navigateTo({"page\\u0054ype":"generative","page\\u{49}d":"PAGEREF_pet"});',
    ].join('\n'),
    pet: 'xrm?.Navigation?.navigateTo?.({...base,pageType:"generative",/* pageId comment */pageId:"PAGEREF_pet-gallery"});',
    'pet-gallery': 'const label = "PAGEREF_pet";',
  };
  const after = {
    overview: before.overview
      .replace('pageId:"PAGEREF_pet-gallery",data', `pageId:"${IDS['pet-gallery']}",data`)
      .replace('"page\\u{49}d":"PAGEREF_pet"', `"page\\u{49}d":"${IDS.pet}"`),
    pet: before.pet.replace('pageId:"PAGEREF_pet-gallery"', `pageId:"${IDS['pet-gallery']}"`),
    'pet-gallery': before['pet-gallery'],
  };
  const events = Object.keys(IDS).map((key) => ({
    id: `${key}-create`,
    command: `node scripts\\genpage-upload.js --code-file before/${key}.tsx --add-to-sitemap`,
    result: { ok: true, pageId: IDS[key] },
  }));
  for (const key of ['overview', 'pet']) events.push({
    id: `${key}-fixup`,
    command: `node scripts\\genpage-upload.js --page-id ${IDS[key]} --code-file ${key}.tsx --prompt-file fixup.txt`,
    result: { ok: true, pageId: IDS[key], updated: true },
  });
  return {
    contractVersion: 2,
    files: Object.entries(after).map(([key, content]) => ({ name: `${key}.tsx`, content })),
    artifacts: { ...Object.fromEntries(Object.entries(before).map(([key, text]) => [`before/${key}.tsx`, text])), 'fixup.txt': 'Resolve cross-page navigation placeholders to real page GUIDs (post-deploy fix-up)' },
    events,
    manifest: {
      contractVersion: 2, provenance: 'synthetic',
      navigation: {
        pageMap: { ...IDS },
        sources: Object.keys(IDS).map((key) => ({ key, file: `${key}.tsx`, before: `before/${key}.tsx` })),
        expectedTargets: { overview: ['pet', 'pet-gallery'], pet: ['pet-gallery'], 'pet-gallery': [] },
      },
    },
  };
}

const score = (fixture) => ASSERTIONS.get(NAV)({ fixture, files: fixture.files, eval: ev });

test('every effective navigation target resolves and only affected pages reupload', () => {
  const good = navigationFixture();
  assert.equal(score(good).status, 'pass');
  const bad = structuredClone(good);
  bad.files[0].content = bad.files[0].content.replace(IDS.pet, 'not-a-page-id');
  assert.equal(score(bad).status, 'fail', 'optional-call literals must be GUIDs from the map');
  const unknown = structuredClone(good);
  unknown.artifacts['before/overview.tsx'] = unknown.artifacts['before/overview.tsx'].replace('"page\\u{49}d":"PAGEREF_pet"', '"page\\u{49}d":"PAGEREF_absent-sibling"');
  assert.equal(score(unknown).status, 'fail', 'a valid sibling elsewhere cannot authorize an unknown target');
  const wrongMap = structuredClone(good);
  wrongMap.manifest.navigation.pageMap.pet = 'not-a-guid';
  assert.equal(score(wrongMap).status, 'fail');
});

test('navigation fix-up rejects collateral edits, missing replacements and redundant uploads', () => {
  const check = PHASE_EXPECTATIONS.get(FIXUP);
  assert.equal(typeof check, 'function', 'navigation lifecycle scorer must be registered');
  const good = navigationFixture();
  assert.equal(check({ fixture: good, eval: ev }).status, 'pass');
  for (const mutate of [
    (fixture) => { fixture.files[0].content = fixture.files[0].content.replace('const label', 'let label'); },
    (fixture) => { fixture.files[0].content = fixture.files[0].content.replace(IDS.pet, 'PAGEREF_pet'); },
    (fixture) => { fixture.events.pop(); },
    (fixture) => { fixture.events.push({ id: 'redundant', command: `node genpage-upload.js --page-id ${IDS['pet-gallery']} --code-file pet-gallery.tsx --prompt-file fixup.txt`, result: { ok: true, pageId: IDS['pet-gallery'] } }); },
    (fixture) => { fixture.events.at(-1).command += ' --add-to-sitemap'; },
    (fixture) => { fixture.events.at(-1).result.pageId = IDS.overview; },
    (fixture) => { fixture.manifest.navigation.expectedTargets.overview = ['pet']; },
    (fixture) => { fixture.artifacts['fixup.txt'] = 'Build the full original page again.'; },
    (fixture) => { fixture.events[0].command = fixture.events[0].command.replace('before/overview.tsx', 'overview.tsx'); },
    (fixture) => { const update = fixture.events.pop(); fixture.events.unshift(update); },
  ]) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.equal(check({ fixture: bad, eval: ev }).status, 'fail');
  }
});

test('navigation phases reject dynamic overrides and invented literal identities', () => {
  const make = (code, phase = 'authored') => ({
    contractVersion: 2,
    manifest: { navigationPhase: phase, pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  const call = (body) => `xrm?.Navigation?.navigateTo?.({pageType:"generative",${body}});`;
  assert.equal(score(make(call('pageId:"PAGEREF_pet"'))).status, 'pass');
  assert.equal(score(make(call(`pageId:"${IDS.pet}"`), 'resolved')).status, 'pass');
  assert.equal(score(make(call(`pageId:"${IDS.pet}"`))).status, 'fail', 'GUIDs belong to the resolved phase only');
  assert.equal(score(make(call('pageId:"PAGEREF_pet"'), 'resolved')).status, 'fail');
  for (const override of ['...base', 'get pageId(){return "runtime";}', 'pageId', '["pageId"]: value', 'pageType(){return "entityrecord";}']) {
    assert.equal(score(make(call(`pageId:"PAGEREF_pet",${override}`))).status, 'fail', override);
  }
  assert.equal(score(make(call('pageId:"PAGEREF_unknown",pageId:"PAGEREF_pet"'))).status, 'pass', 'last literal wins');
  assert.equal(score(make(call('...base,pageType:"generative",pageId:"PAGEREF_pet"'))).status, 'pass', 'literal after spread wins');
});

test('navigation ignores inert text but sees executable calls after Unicode comment terminators', () => {
  for (const terminator of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
    const content = `// inert navigateTo({pageType:"generative",pageId:"PAGEREF_wrong"})${terminator}`
      + 'xrm?.Navigation?.navigateTo?.({"page\\x54ype":"generative","page\\u0049d":"PAGEREF_pet"});';
    const fixture = {
      manifest: { navigationPhase: 'authored' },
      files: [{ name: 'overview.tsx', content }, { name: 'pet.tsx', content: 'const help = "PAGEREF_absent";' }],
    };
    assert.equal(score(fixture).status, 'pass', JSON.stringify(terminator));
    fixture.files[0].content = content.replace('"PAGEREF_pet"', '"PAGEREF_missing"');
    assert.equal(score(fixture).status, 'fail', JSON.stringify(terminator));
  }
});

test('historical navigation still rejects the audit unknown-sibling and optional-call probes', () => {
  const fixtures = loadFixtures(path.join(__dirname, '..', 'fixtures'));
  const authored = fixtures.find((fixture) => fixture.dirName === '11-recruitment-multi-page');
  const resolved = fixtures.find((fixture) => fixture.dirName === '11-recruitment-pages-real');
  assert.equal(score(authored).status, 'pass');
  assert.equal(score(resolved).status, 'pass');
  const badAuthored = structuredClone(authored);
  badAuthored.files[0].content = badAuthored.files[0].content.replace('PAGEREF_interview-schedule', 'PAGEREF_absent-sibling');
  assert.equal(score(badAuthored).status, 'fail');
  const badResolved = structuredClone(resolved);
  for (const file of badResolved.files) {
    file.content = file.content.replace(/pageId:\s*"[^"]+"/g, 'pageId: "not-a-page-id"');
  }
  assert.equal(score(badResolved).status, 'fail');
});

test('a navigation-shaped record call cannot hide an executable PAGEREF sibling target', () => {
  const good = navigationFixture();
  assert.equal(score(good).status, 'pass');
  good.artifacts['before/overview.tsx'] = good.artifacts['before/overview.tsx'].replace('navigateTo?.({pageType:"generative"', 'navigateTo?.({pageType:"custom"');
  good.files[0].content = good.files[0].content.replace('navigateTo?.({pageType:"generative"', 'navigateTo?.({pageType:"custom"');
  assert.equal(score(good).status, 'fail', 'current contract cannot silently treat a legacy custom-page target as compliant');
});
