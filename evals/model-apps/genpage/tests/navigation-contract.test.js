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
      '// const label = "pet"; a page key in a comment is help text, not a target',
      '// Xrm.Navigation.navigateTo({pageType:"generative",pageId:"commented-out"});',
      'xrm?.Navigation?.navigateTo?.({pageType:"generative",pageId:"early-value",pageId:"PAGEREF_pet-gallery",data:{pageId:"nested-value"}});',
      'xrm?.Navigation?.navigateTo({"page\\u0054ype":"generative","page\\u{49}d":"PAGEREF_pet"});',
    ].join('\n'),
    pet: 'xrm?.Navigation?.navigateTo?.({...base,pageType:"generative",/* pageId comment */pageId:"PAGEREF_pet-gallery"});',
    'pet-gallery': '// const label = "pet"; display data, not a target',
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
  assert.equal(score(make(call('pageId:"early-value",pageId:"PAGEREF_pet"'))).status, 'pass', 'last literal wins');
  assert.equal(score(make(call('...base,pageType:"generative",pageId:"PAGEREF_pet"'))).status, 'pass', 'literal after spread wins');
});

// The build refuses a page holding a PAGEREF_ token that no navigation rewrite resolves — in a string, a template, a variable, a
// spread or nested value, a call spelled some other way, or a comment — because it would ship as literal text. A captured or constructed
// page is held to the same rule, so a fixture cannot represent a page the build would not accept. There is no comment exemption: a
// comment may say what a call looks like, with no token in it.
test('a PAGEREF_ token no navigation rewrite resolves fails the contract in either phase, a comment included', () => {
  const make = (code, phase) => ({
    contractVersion: 2,
    manifest: { navigationPhase: phase, pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  const call = {
    authored: 'xrm?.Navigation?.navigateTo?.({pageType:"generative",pageId:"PAGEREF_pet"});',
    resolved: `xrm?.Navigation?.navigateTo?.({pageType:"generative",pageId:"${IDS.pet}"});`,
  };
  const decoys = {
    'a string': 'const help = "PAGEREF_pet-gallery is help text";',
    'a single-quoted string': "const help = 'PAGEREF_pet-gallery is help text';",
    'template text': 'const help = `see PAGEREF_pet-gallery`;',
    'a variable a call could read': 'const target = "PAGEREF_pet-gallery";',
    'a nested value that is not a call\'s own pageId': 'const options = { data: { pageId: "PAGEREF_pet-gallery" } };',
    'a call spelled a way the resolver does not read': 'navigateTo.call(null, {pageType:"generative",pageId:"PAGEREF_pet-gallery"});',
  };
  for (const phase of ['authored', 'resolved']) {
    assert.equal(score(make(call[phase], phase)).status, 'pass', `${phase}: the control page is accepted`);
    for (const [what, decoy] of Object.entries(decoys)) {
      const result = score(make(`${decoy}\n${call[phase]}`, phase));
      assert.equal(result.status, 'fail', `${phase}: ${what}`);
      assert.match(result.reason, /^overview\.tsx: PAGEREF_ token\(s\) no navigation rewrite resolves: PAGEREF_pet-gallery \(line 1, column \d+\)$/, `${phase}: ${what}`);
    }
    // A comment may say what a call looks like, with no token in it, and is inert.
    const inert = '// a page key in a comment is help text, not a target\n// navigateTo({pageType:"generative",pageId:"help-text"})\n/* xrm.Navigation.navigateTo({pageType:"generative",pageId:"commented-out"}) */';
    assert.equal(score(make(`${inert}\n${call[phase]}`, phase)).status, 'pass', `${phase}: comments with no token are inert`);
    for (const commented of [
      '// PAGEREF_pet-gallery is help text, not a target',
      '    // PAGEREF_pet-gallery is help text, not a target',
      'const help = "plain"; // PAGEREF_pet-gallery is help text',
      'const help = "plain"; /* PAGEREF_pet-gallery */',
      `${call[phase]} // PAGEREF_pet-gallery`,
      '/* PAGEREF_pet-gallery is help text */',
      '/**\n * PAGEREF_pet-gallery is help text\n */',
      '// Xrm.Navigation.navigateTo({pageType:"generative",pageId:"PAGEREF_pet-gallery"});',
    ]) {
      const result = score(make(`${commented}\n${call[phase]}`, phase));
      assert.equal(result.status, 'fail', `${phase}: ${commented}`);
      assert.match(result.reason, /^overview\.tsx: PAGEREF_ token\(s\) no navigation rewrite resolves: PAGEREF_pet-gallery \(line \d+, column \d+\)$/, `${phase}: ${commented}`);
    }
  }
});

// The misread pages (tests/helpers/misread-page.js): JavaScript makes the calls, and each page is a way the lexer hides one or reads
// text as one. A fixture holding one is not a page the build would accept, so it fails the contract, the first guess named; with the
// object literal in parentheses the first is read right and passes.
test('a page the lexer could misread fails the contract, naming the guess, and the parenthesised page passes', () => {
  const { OBJECT_DIVISION_PAGE, MISREAD_PAGES } = require('../../../../plugins/model-apps/scripts/tests/helpers/misread-page.js');
  const make = (code) => ({
    contractVersion: 2,
    manifest: { navigationPhase: 'authored', pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  const page = OBJECT_DIVISION_PAGE.replaceAll('PAGEREF_detail', 'PAGEREF_pet');
  const refused = score(make(page));
  assert.equal(refused.status, 'fail');
  assert.match(refused.reason, /^overview\.tsx: PAGEREF_ token\(s\) no navigation rewrite resolves: PAGEREF_pet \(line 5, column \d+, after the "brace" ambiguity at line 4, column \d+\)$/);
  const fixed = page.replace('{valueOf(){return 12;}, ...extras}/2', '({valueOf(){return 12;}, ...extras})/2');
  assert.notEqual(fixed, page);
  assert.equal(score(make(fixed)).status, 'pass');
  for (const [name, { kind, frontier, code, reaching }] of Object.entries(MISREAD_PAGES)) {
    const source = code.replaceAll('PAGEREF_detail', 'PAGEREF_pet');
    const at = frontier(source);
    const where = (offset) => {
      const lines = source.slice(0, offset).split('\n');
      return `line ${lines.length}, column ${lines[lines.length - 1].length + 1}`;
    };
    const result = score(make(source));
    assert.equal(result.status, 'fail', name);
    // A call that reaches the guess is untrusted whole, so its token is named though it lies before the guess.
    const token = source.indexOf('PAGEREF_pet', reaching ? 0 : at);
    assert.ok(result.reason.startsWith(`overview.tsx: PAGEREF_ token(s) no navigation rewrite resolves: PAGEREF_pet (${where(token)}, ${reaching ? 'in a call that reaches' : 'after'} the "${kind}" ambiguity at ${where(at)})`), `${name}: ${result.reason}`);
  }
});

// A resolved page is judged on the same view of the source as the build and verification. An id that lies in a call at or after the first place
// the lexer guessed — or in a call that runs through it — is no evidence of navigation, though it is a deployed id from the page map: the
// source there is not read for certain, and what the call does is not known.
test('a resolved page whose page id lies in a call the lexer reads only by guess is refused, as verification refuses it', () => {
  const { MISREAD_PAGES } = require('../../../../plugins/model-apps/scripts/tests/helpers/misread-page.js');
  const make = (code) => ({
    contractVersion: 2,
    manifest: { navigationPhase: 'resolved', pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  const call = `navigateTo({pageType:"generative", pageId:"${IDS.pet}"});`;
  const guess = 'const count = {valueOf(){return 12;}}/2; const half = total / 2;';
  const refusal = (frontierKind, line) => new RegExp(`^overview\\.tsx: navigation page id ${IDS.pet} is in a call that is not trusted: part of it lies at or after the "${frontierKind}" ambiguity at line ${line}, column \\d+, which this check cannot read for certain$`);
  const after = score(make(`${guess}\n${call}\n`));
  assert.equal(after.status, 'fail');
  assert.match(after.reason, refusal('brace', 1));
  // The call is before the guess in the source, and its object runs through it.
  const through = score(make(`navigateTo({pageType:"generative", pageId:"${IDS.pet}", data: type/2}); const re = /x/;\n`));
  assert.equal(through.status, 'fail');
  assert.match(through.reason, refusal('keyword', 1));
  const page = MISREAD_PAGES['inside an options object'];
  const review = score(make(page.code.replace('"PAGEREF_detail"', `"${IDS.pet}"`)));
  assert.equal(review.status, 'fail');
  assert.match(review.reason, refusal('brace', 4));
  // Closed before the guess, the same call is evidence as it was, and a guess after it changes nothing.
  assert.equal(score(make(`${call}\n${guess}\n`)).status, 'pass');
  assert.equal(score(make(`${call}\n`)).status, 'pass');
});

// Pages the lexer reads right after a line break (ASI): the text of a call in a regex after a prefix `++` is a token no rewrite resolves, so a
// fixture holding it fails the contract, wherever the token sits and with no guess named; a call in a template line that starts with `//` runs,
// so it passes in both phases.
test('a regex after a prefix "++" holds a token the contract refuses, and a call in a template line that starts with // passes', () => {
  const { PREFIX_INCREMENT_PAGE, TEMPLATE_LINE_PAGE } = require('../../../../plugins/model-apps/scripts/tests/helpers/misread-page.js');
  const make = (code, phase) => ({
    contractVersion: 2,
    manifest: { navigationPhase: phase, pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  const authored = (code) => code.replaceAll('PAGEREF_detail', 'PAGEREF_pet');
  const refused = score(make(authored(PREFIX_INCREMENT_PAGE), 'authored'));
  assert.equal(refused.status, 'fail');
  assert.match(refused.reason, /^overview\.tsx: PAGEREF_ token\(s\) no navigation rewrite resolves: PAGEREF_pet \(line 6, column \d+\)$/);
  assert.equal(score(make(authored(TEMPLATE_LINE_PAGE), 'authored')).status, 'pass');
  assert.equal(score(make(TEMPLATE_LINE_PAGE.replace('"PAGEREF_detail"', `"${IDS.pet}"`), 'resolved')).status, 'pass');
});

// JSX text that looks like a parameter list is text: the scorer judges the page on the same view of the source as the build, so the regex after
// the next arrow is data and the token in it is a token no rewrite resolves, in the authored phase, with no guess named.
test('JSX text that looks like parameters leaves a token in a regex that the contract refuses', () => {
  const { JSX_TEXT_PAGE } = require('../../../../plugins/model-apps/scripts/tests/helpers/misread-page.js');
  const make = (code, phase) => ({
    contractVersion: 2,
    manifest: { navigationPhase: phase, pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  const refused = score(make(JSX_TEXT_PAGE.replaceAll('PAGEREF_detail', 'PAGEREF_pet'), 'authored'));
  assert.equal(refused.status, 'fail');
  assert.match(refused.reason, /^overview\.tsx: PAGEREF_ token\(s\) no navigation rewrite resolves: PAGEREF_pet \(line 5, column \d+\)$/);
  // Resolved as the build would resolve it (the real call only), the token is still there and is refused again.
  const resolved = score(make(JSX_TEXT_PAGE.replaceAll('PAGEREF_detail', 'PAGEREF_pet').replace('"PAGEREF_pet"', `"${IDS.pet}"`), 'resolved'));
  assert.equal(resolved.status, 'fail');
  assert.match(resolved.reason, /PAGEREF_pet \(line 5, column \d+\)/);
});

// After a unary or binary operator a `<` opens an element whatever follows its name (`a === <T extends X>text</T>`), so the regex after it is data: the scorer judges
// the page on the same view of the source as the build, and the token in the regex is a token no rewrite resolves, in both phases, with no guess named.
test('an element after a unary or binary operator leaves a token in a regex that the contract refuses', () => {
  const { ELEMENT_AFTER_OPERATOR_PAGES, ELEMENT_PAGE_TOKEN_LINE } = require('../../../../plugins/model-apps/scripts/tests/helpers/misread-page.js');
  const make = (code, phase) => ({
    contractVersion: 2,
    manifest: { navigationPhase: phase, pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  for (const { name, code } of ELEMENT_AFTER_OPERATOR_PAGES) {
    const authored = code.replaceAll('PAGEREF_detail', 'PAGEREF_pet');
    const refused = score(make(authored, 'authored'));
    assert.equal(refused.status, 'fail', name);
    assert.match(refused.reason, new RegExp(`^overview\\.tsx: PAGEREF_ token\\(s\\) no navigation rewrite resolves: PAGEREF_pet \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)$`), name);
    // Resolved as the build would resolve it (the real call only), the token is still there and is refused again.
    const resolved = score(make(authored.replace('"PAGEREF_pet"', `"${IDS.pet}"`), 'resolved'));
    assert.equal(resolved.status, 'fail', name);
    assert.match(resolved.reason, new RegExp(`PAGEREF_pet \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)`), name);
  }
});

// JSX that holds what looks like a function type's parameter list compiles as an element, so the regex after it is data: the scorer judges the page on the same view of the
// source as the build, and the token in the regex is a token no rewrite resolves, in both phases, with no guess named.
test('an element whose text looks like a parameter list leaves a token in a regex that the contract refuses', () => {
  const { ELEMENT_LOOKALIKE_PAGES, ELEMENT_PAGE_TOKEN_LINE } = require('../../../../plugins/model-apps/scripts/tests/helpers/misread-page.js');
  const make = (code, phase) => ({
    contractVersion: 2,
    manifest: { navigationPhase: phase, pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  for (const { name, code } of ELEMENT_LOOKALIKE_PAGES) {
    const authored = code.replaceAll('PAGEREF_detail', 'PAGEREF_pet');
    const refused = score(make(authored, 'authored'));
    assert.equal(refused.status, 'fail', name);
    assert.match(refused.reason, new RegExp(`^overview\\.tsx: PAGEREF_ token\\(s\\) no navigation rewrite resolves: PAGEREF_pet \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)$`), name);
    const resolved = score(make(authored.replace('"PAGEREF_pet"', `"${IDS.pet}"`), 'resolved'));
    assert.equal(resolved.status, 'fail', name);
    assert.match(resolved.reason, new RegExp(`PAGEREF_pet \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)`), name);
  }
});

// A generic function type whose parameter list holds a type argument or an object type is a type, for certain: the scorer reads the page as the build does, so the call after it is
// navigation evidence in both phases, and a fixture holding one is a page the build accepts.
test('a generic function type with a type argument or an object type in its parameter list is a type: the contract passes the page in both phases', () => {
  const { FUNCTION_TYPE_PAGES } = require('../../../../plugins/model-apps/scripts/tests/helpers/misread-page.js');
  const make = (code, phase) => ({
    contractVersion: 2,
    manifest: { navigationPhase: phase, pageMap: IDS },
    files: [{ name: 'overview.tsx', content: code }, { name: 'pet.tsx', content: '' }, { name: 'pet-gallery.tsx', content: '' }],
  });
  for (const { name, code } of FUNCTION_TYPE_PAGES) {
    const authored = code.replaceAll('PAGEREF_detail', 'PAGEREF_pet');
    assert.equal(score(make(authored, 'authored')).status, 'pass', `${name}: authored`);
    assert.equal(score(make(authored.replace('"PAGEREF_pet"', `"${IDS.pet}"`), 'resolved')).status, 'pass', `${name}: resolved`);
  }
});

test('navigation ignores inert text but sees executable calls after Unicode comment terminators', () => {
  for (const terminator of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
    const content = `// inert navigateTo({pageType:"generative",pageId:"wrong"})${terminator}`
      + 'xrm?.Navigation?.navigateTo?.({"page\\x54ype":"generative","page\\u0049d":"PAGEREF_pet"});';
    const fixture = {
      manifest: { navigationPhase: 'authored' },
      files: [{ name: 'overview.tsx', content }, { name: 'pet.tsx', content: '// const help = "absent"; display text for a page that is not a sibling' }],
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
