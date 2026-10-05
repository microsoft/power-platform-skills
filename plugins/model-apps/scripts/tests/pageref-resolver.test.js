'use strict';
// Tests for the single structural nav oracle (pageref-resolver.js).
// All tests must pass for every nav-related change — this module is the correctness spine
// of forward resolution (Task 8), reverse-normalization (Task 11), and verification (Task 10).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { loadTypescriptOracle } = require('./helpers/typescript-oracle.js');
const { OBJECT_DIVISION_PAGE, MISREAD_PAGES, HIDDEN_CALL_PAGE, PREFIX_INCREMENT_PAGE, TEMPLATE_LINE_PAGE, JSX_TEXT_PAGE, ELEMENT_AFTER_OPERATOR_PAGES, ELEMENT_LOOKALIKE_PAGES, ELEMENT_PAGE_TOKEN_LINE, FUNCTION_TYPE_PAGES, FUNCTION_TYPE_CALL_LINE, LONG_KEY, lookBehindPage, runnable } = require('./helpers/misread-page.js');
const { AMBIGUITY_KINDS } = require('../lib/source-literals.js');
const { pageStructureProblems } = require('../lib/page-structure.js');
const {
  extractNavTargets,
  navReferencedKeys,
  navMalformedRefs,
  resolvePageRefs,
  reverseResolveNavIds,
  reverseResolveNavIdsReport,
  navTargetParity,
  strayPageRefs,
  describePageRefLocations,
  pageRefAdvice,
  navigationFrontier,
  frontierNote,
  PAGEREF_RULE,
} = require(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'));

// Helper: produces a realistic generative navigateTo call with a given pageId token.
const NAV = (id) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: ${id}, data: {} });`;

// A navigation call on its own, and a division after an object literal — which the lexer reads as a regex right after a `}` (the second `/`
// on the line ends it, so the read is complete — and wrong). Shared by the sections on the trust frontier and on reverse resolution.
const DETAIL_CALL = 'navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});';
const OBJECT_DIVISION = 'const count = {valueOf(){return 12;}}/2; const half = total / 2;';
const positionOf = (code, offset) => {
  const before = code.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: before.length, column: before[before.length - 1].length + 1 };
};
const resolveOne = (code, ids = [['detail', 'gp-detail'], ['other', 'gp-other']]) => resolvePageRefs(new Map([['x', { code }]]), new Map(ids));

// ─── extractNavTargets ────────────────────────────────────────────────────────

test('extractNavTargets classifies a canonical PAGEREF nav pageId (structural — real call site only)', () => {
  const t = extractNavTargets(NAV('"PAGEREF_detail"'));
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'pageref');
  assert.strictEqual(t[0].key, 'detail');
});

test('extractNavTargets IGNORES a decoy "PAGEREF_" string that is NOT a nav pageId', () => {
  const code = `const label = "PAGEREF_detail"; // decoy, not navigation\n${NAV('"PAGEREF_gallery"')}`;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'only the real nav call site counts');
  assert.strictEqual(t[0].key, 'gallery');
  assert.deepStrictEqual(navReferencedKeys(code), ['gallery'], 'the decoy "detail" is not a referenced key');
});

test('extractNavTargets classifies a resolved GUID literal, and a dynamic (variable) pageId', () => {
  assert.strictEqual(extractNavTargets(NAV('"5d29d8ce-1111-2222-3333-444455556666"'))[0].kind, 'literal');
  assert.strictEqual(extractNavTargets(NAV('targetPageId'))[0].kind, 'dynamic');
});

test('extractNavTargets only counts pageType:"generative" call sites', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "entityrecord", pageId: "PAGEREF_detail" });';
  assert.deepStrictEqual(extractNavTargets(code), []);
});

test('extractNavTargets handles pageId BEFORE pageType and a nested data:{} object', () => {
  const code = 'navigateTo({ pageId: "PAGEREF_detail", pageType: "generative", data: { recordId: "PAGEREF_notakey", nested: { x: 1 } } });';
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'pageref');
  assert.strictEqual(t[0].key, 'detail', 'the top-level pageId is the target — a PAGEREF-looking string inside data:{} is NOT');
});


test('extractNavTargets supports quoted property keys and preserves value offsets', () => {
  const calls = [
    'Xrm.Navigation.navigateTo({"pageType":"generative","pageId":"PAGEREF_detail"});',
    "Xrm.Navigation.navigateTo({ 'pageType': 'generative', 'pageId': \"PAGEREF_gallery\" });",
  ];
  const code = calls.join('\n');
  const t = extractNavTargets(code);
  assert.deepStrictEqual(t.map((target) => [target.kind, target.key]), [['pageref', 'detail'], ['pageref', 'gallery']]);
  for (const target of t) {
    const literal = `\"PAGEREF_${target.key}\"`;
    assert.strictEqual(code.slice(target.valueStart, target.valueEnd), literal, `${target.key} value span maps to the original source`);
  }
});

test('extractNavTargets ignores quoted value text named like a key', () => {
  const code = 'Xrm.Navigation.navigateTo({ "pageType": "generative", label: "pageId", "pageId": "PAGEREF_detail" });';
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].key, 'detail');
  assert.strictEqual(code.slice(t[0].valueStart, t[0].valueEnd), '"PAGEREF_detail"');
});

test('extractNavTargets keeps quoted-key offsets exact after a leading emoji comment', () => {
  const code = '// 🔎 inspect navigation\nXrm.Navigation.navigateTo({"pageType":"generative","pageId":"PAGEREF_detail"});';
  const [target] = extractNavTargets(code);
  assert.strictEqual(target.key, 'detail');
  assert.strictEqual(target.valueStart, code.indexOf('"PAGEREF_detail"'));
  assert.strictEqual(target.valueEnd, target.valueStart + '"PAGEREF_detail"'.length);
});

test('extractNavTargets supports mixed quoted and bare keys', () => {
  const code = 'Xrm.Navigation.navigateTo({ "pageType": "generative", pageId: "PAGEREF_detail" });';
  assert.deepStrictEqual(navReferencedKeys(code), ['detail']);
});

test('extractNavTargets ignores quoted pageId text in a ternary value and uses the real key', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", foo: c ? "pageId" : "PAGEREF_wrong", pageId: "PAGEREF_detail" });';
  const [target] = extractNavTargets(code);
  assert.strictEqual(target.key, 'detail');
  assert.strictEqual(code.slice(target.valueStart, target.valueEnd), '"PAGEREF_detail"');
});

test('extractNavTargets ignores bare pageId identifiers in a ternary value and uses the real key', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", foo: c ? pageId : other, pageId: "PAGEREF_detail" });';
  const [target] = extractNavTargets(code);
  assert.strictEqual(target.key, 'detail');
  assert.strictEqual(code.slice(target.valueStart, target.valueEnd), '"PAGEREF_detail"');
});

test('a ternary decoy AFTER the real key is not read as a later, overriding key', () => {
  // The last occurrence of a key takes effect, so a decoy that followed the real key and was taken for
  // a key would silently win. Only a boundary rule keeps it out: a key must follow `{` or `,`.
  for (const decoy of ['c ? "pageId" : "PAGEREF_wrong"', 'c ? pageId : other']) {
    const code = `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", label: ${decoy} });`;
    const [target] = extractNavTargets(code);
    assert.strictEqual(target.key, 'detail', decoy);
    assert.strictEqual(code.slice(target.valueStart, target.valueEnd), '"PAGEREF_detail"', decoy);
  }
});

test('extractNavTargets matches keys after comments, newlines, and spreads', () => {
  const cases = [
    '{ /* note */ "pageId": "PAGEREF_detail", pageType: "generative" }',
    '{\n  "pageId": "PAGEREF_detail", pageType: "generative" }',
    '{ ...base, "pageId": "PAGEREF_detail", pageType: "generative" }',
  ];
  for (const obj of cases) {
    const code = `Xrm.Navigation.navigateTo(${obj});`;
    const [target] = extractNavTargets(code);
    assert.strictEqual(target.key, 'detail', obj);
    assert.strictEqual(code.slice(target.valueStart, target.valueEnd), '"PAGEREF_detail"', obj);
  }
});

test('extractNavTargets does not match pageId inside a longer bare identifier', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", myPageId: "PAGEREF_wrong", pageId: "PAGEREF_detail" });';
  const [target] = extractNavTargets(code);
  assert.strictEqual(target.key, 'detail');
  assert.strictEqual(code.slice(target.valueStart, target.valueEnd), '"PAGEREF_detail"');
});

test('extractNavTargets treats later runtime pageId overrides as dynamic', () => {
  const cases = [
    'Xrm.Navigation.navigateTo({ pageType: "generative", "pageId": "PAGEREF_detail", ...options });',
    'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", ...options });',
    'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", [name]: other });',
  ];
  for (const code of cases) {
    const [target] = extractNavTargets(code);
    assert.strictEqual(target.kind, 'dynamic', code);
    assert.strictEqual(code.slice(target.valueStart, target.valueEnd), '"PAGEREF_detail"', code);
  }
});

test('extractNavTargets treats a later runtime pageType override as dynamic', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", ...options });';
  const [target] = extractNavTargets(code);
  assert.strictEqual(target.kind, 'dynamic');
  assert.strictEqual(code.slice(target.valueStart, target.valueEnd), '"PAGEREF_detail"');
});

// ─── Comment and template-literal stripping ──────────────────────────────────
//
// A navigateTo inside a comment or template literal is NOT a real call site.  The
// stripping pass blanks those regions (same-length space substitution) before the
// NAV_CALL regex runs, so an in-comment or in-template navigateTo is invisible to
// the oracle.

test('extractNavTargets IGNORES a navigateTo inside a // line comment', () => {
  const real = NAV('"PAGEREF_real"');
  const code = `// ${NAV('"PAGEREF_commented"')}\n${real}`;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'only the real call site counts; the commented-out one is ignored');
  assert.strictEqual(t[0].key, 'real');
  assert.deepStrictEqual(navReferencedKeys(code), ['real'], 'the commented navigateTo is not a referenced key');
});

test('extractNavTargets IGNORES a navigateTo inside a /* */ block comment', () => {
  const real = NAV('"PAGEREF_real"');
  const code = `/* ${NAV('"PAGEREF_block"')} */\n${real}`;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'block-commented call site is ignored');
  assert.strictEqual(t[0].key, 'real');
  assert.deepStrictEqual(navReferencedKeys(code), ['real'], 'the block-commented navigateTo is not a referenced key');
});

test('extractNavTargets IGNORES a navigateTo inside a backtick template literal', () => {
  const real = NAV('"PAGEREF_real"');
  // The backtick string contains the navigateTo as template-literal TEXT, not a real call.
  // eslint-disable-next-line no-template-curly-in-string
  const code = 'const s = `template ' + NAV('"PAGEREF_templ"') + ' body`;\n' + real;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'template-literal call site is ignored');
  assert.strictEqual(t[0].key, 'real');
  assert.deepStrictEqual(navReferencedKeys(code), ['real'], 'the template-literal navigateTo is not a referenced key');
});

test('extractNavTargets IGNORES navigateTo prose inside ordinary quoted strings', () => {
  const code = [
    'const help = \'navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" })\';',
    'const label = "Use Xrm.Navigation.navigateTo({ pageType: \\"generative\\", pageId: \\"PAGEREF_gallery\\" }) from a button.";'
  ].join('\n');
  assert.deepStrictEqual(extractNavTargets(code), [], 'ordinary string text is inert and must not satisfy navigation parity');
  assert.deepStrictEqual(navReferencedKeys(code), [], 'declared edges cannot be satisfied by help text');
});

test('extractNavTargets ignores navigateTo text inside regex literals after arrows', () => {
  const code = 'const pattern = count<limit ? () => /navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" })/ : () => /none/;';
  assert.deepStrictEqual(navReferencedKeys(code), []);
  const { deployment, unresolved } = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']]));
  assert.deepStrictEqual(unresolved, []);
  assert.strictEqual(deployment.get('x'), code);
});

test('extractNavTargets does not join separate template substitutions into a fake navigateTo call', () => {
  const code = 'const hint = `${Xrm.Navigation.navigateTo} is a function; input: ${({ pageType: "generative", pageId: "PAGEREF_detail" })}`;';
  assert.deepStrictEqual(navReferencedKeys(code), []);
  const { deployment, unresolved } = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']]));
  assert.deepStrictEqual(unresolved, []);
  assert.strictEqual(deployment.get('x'), code);
});

test('extractNavTargets INSPECTS executable template expressions while ignoring template text', () => {
  const guid = '11111111-2222-3333-4444-555555555555';
  const code = [
    'const textOnly = `navigateTo({ pageType: "generative", pageId: "PAGEREF_text" })`;',
    'const rendered = `${Xrm.Navigation.navigateTo({',
    '  pageType: "generative",',
    `  pageId: "${guid}"`,
    '})}`;',
  ].join('\n');
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'template text is inert, but JavaScript inside ${...} is executable');
  assert.strictEqual(t[0].kind, 'literal');
  assert.strictEqual(t[0].pageId, guid);
  assert.deepStrictEqual(navReferencedKeys(code), [], 'hard-coded targets inside ${...} must still fail portability parity');
});

test('extractNavTargets finds real navigateTo calls in TSX-shaped executable positions', () => {
  const code = [
    'const arrow = () => Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_arrow" });',
    'export default function P(){',
    '  return <button onClick={() => Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_attr" })}>',
    '    {`${Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_template" })}`}',
    '  </button>;',
    '}',
  ].join('\n');
  assert.deepStrictEqual(navReferencedKeys(code), ['arrow', 'attr', 'template']);
});

// The shapes inside `${...}` the expression scanner must tell apart. Inert text in a string, a regex
// or a comment inside an expression must not count, and a `}` inside one must not end the expression
// early — that would expose the rest of the template TEXT as code. Nested templates recurse: their
// own text is inert, their own expressions are executable.
test('extractNavTargets handles strings, regexes, comments and nested templates inside ${...}', () => {
  const call = (key) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_${key}" })`;
  const cases = [
    ['a string holding the call text', '`${"' + 'navigateTo({ pageType: \\"generative\\", pageId: \\"PAGEREF_str\\" })' + '"}`', []],
    ['a regex holding the call text', '`${/navigateTo\\({ pageId: "PAGEREF_re" }\\)/.source}`', []],
    ['a block comment holding the call', '`${/* ' + call('cmt') + ' */ label}`', []],
    ['a line comment, then a real call', '`${// ' + call('line') + '\n' + call('after') + '}`', ['after']],
    ['a "}" inside a string does not end the expression', '`${"}" + ' + call('brace') + '} tail navigateTo({ pageType: "generative", pageId: "PAGEREF_tail" })`', ['brace']],
    ['a "}" inside a comment does not end the expression', '`${/* first line\n } */ ' + call('cmtbrace') + '} tail navigateTo({ pageType: "generative", pageId: "PAGEREF_tail2" })`', ['cmtbrace']],
    ['a nested template: text inert, expression live', '`outer ${`inner ' + call('innertext').replace('Xrm.Navigation.', '') + ' ${' + call('nested') + '}`}`', ['nested']],
    ['an escaped backtick in template text', '`a \\` b ' + call('esc').replace('Xrm.Navigation.', '') + '`', []],
    // The everyday shape: an interpolated template (a className, a label) and then a real call. The
    // expression must end at its own `}` — run it to the end of the file and the template's closing
    // backtick opens a phantom template that hides every call after it.
    ['a real call after an interpolated template', 'const label = `Hello ${name}`;\n' + call('after'), ['after']],
    // Call sites and objects come from the lexer's mask, values from the source at the same offsets,
    // so the two must agree on every offset. An emoji is two UTF-16 units; split by code point, one
    // blanked in a comment shortened a copy by one and the next call was looked for one character off.
    ['a call after an emoji in a comment', call('first') + ';\n// 📌 pinned\n' + call('second'), ['first', 'second']],
    ['a call after an emoji in template text', call('first') + ';\nconst banner = `🔥 ${count} hot leads`;\n' + call('second'), ['first', 'second']],
    ['a call after a nested template with braces in its text', call('first') + ';\nconst j = `[${rows.map((r) => `{"id":"${r.id}"}`).join(",")}]`;\n' + call('second'), ['first', 'second']],
    // The `/` of `</span>` inside `${…}`, and the `/` after `counts.new` or `closed!`, divide or
    // close a tag; read as a regex opener, each hid every call after it.
    ['a call after JSX inside a template expression', call('first') + ';\nconst t = `${<span>Save</span>}`;\n' + call('second'), ['first', 'second']],
    ['a call after a keyword-named property divided', call('first') + ';\nconst el = <Text>{counts.new / total}</Text>;\n' + call('second'), ['first', 'second']],
    ['a call after a non-null assertion divided', call('first') + ';\nconst el = <Text>{closed! / total}</Text>;\n' + call('second'), ['first', 'second']],
    // A regex holding `/*`, `//` or a backtick is a regex. A copy that knew no regexes opened a
    // comment or a template there, blanked every later call, and left its PAGEREF unresolved.
    ['a call after a regex holding /*', call('first') + ';\nconst clean = (u: string) => u.replace(/\\/*$/, "");\n' + call('second'), ['first', 'second']],
    ['a call after a regex holding a backtick', call('first') + ';\nconst unquote = (s: string) => s.replace(/`/g, "");\n' + call('second'), ['first', 'second']],
    ['a call on the line of a regex holding //', call('first') + ';\nconst u = x.replace(/\\/\\//g, "/"); ' + call('second'), ['first', 'second']],
    ['a "}" in a regex inside the call object', 'Xrm.Navigation.navigateTo({ pageType: "generative", data: { re: /}/ }, pageId: "PAGEREF_inside" });', ['inside']],
  ];
  for (const [what, code, keys] of cases) {
    assert.deepStrictEqual(navReferencedKeys(code), keys, what);
  }
});

// Truncated worker output ends mid-template or mid-expression. That must not throw, and a real call
// before the truncation must still be found; nothing after it is code.
test('extractNavTargets survives a template or ${...} left open at end of file', () => {
  const call = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_before" });';
  assert.deepStrictEqual(navReferencedKeys(`${call}\nconst t = \`unterminated navigateTo({ pageId: "PAGEREF_x" })`), ['before']);
  assert.deepStrictEqual(navReferencedKeys(`${call}\nconst t = \`\${foo(`), ['before']);
});

// ─── navMalformedRefs ─────────────────────────────────────────────────────────

test('navMalformedRefs flags a single-quoted PAGEREF_ used as a nav pageId', () => {
  const code = "Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: 'PAGEREF_detail' });";
  assert.deepStrictEqual(navMalformedRefs(code), ['PAGEREF_detail']);
  assert.deepStrictEqual(navReferencedKeys(code), [], 'a malformed ref is NOT a valid canonical reference');
});

test('navMalformedRefs flags a backtick-quoted PAGEREF_ used as a nav pageId (a backtick cannot be resolved)', () => {
  // A backtick-quoted PAGEREF cannot be substituted by the resolver (only the canonical
  // double-quoted token is substitutable), so it is malformed and must HALT.
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: `PAGEREF_detail` });';
  assert.deepStrictEqual(navMalformedRefs(code), ['PAGEREF_detail']);
  assert.deepStrictEqual(navReferencedKeys(code), [], 'a backtick-quoted PAGEREF is NOT a valid canonical reference');
});

// ─── navReferencedKeys + navTargetParity ─────────────────────────────────────

test('navReferencedKeys returns [] for a literal GUID pageId; parity flags declared edge as unreferenced', () => {
  // A deployed/stale GUID in the source is not a canonical PAGEREF, so it is not a referenced
  // key and parity correctly reports the declared edge as unreferenced.
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "5d29d8ce-1111-2222-3333-444455556666" });';
  assert.deepStrictEqual(navReferencedKeys(code), [], 'a GUID literal is not a canonical PAGEREF key');
  assert.deepStrictEqual(
    navTargetParity(['detail'], navReferencedKeys(code)).declaredNotReferenced,
    ['detail'],
    'the declared "detail" edge is unreferenced because the source holds a resolved GUID, not PAGEREF_detail'
  );
});

test('extractNavTargets classifies a "a" + "b" concat pageId as dynamic, not literal', () => {
  // A string concat is not a single literal — the tightened QUOTED regex excludes cross-quote spans
  // and the value is read as the whole expression, up to the `,` or `}` that ends the property.
  const code = NAV('"a" + "b"');
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'dynamic', 'a string concat is not a single literal');
});

// ─── resolvePageRefs ──────────────────────────────────────────────────────────

test('resolvePageRefs replaces each canonical nav pageId with the quoted genPageId (span-based, no partial collide)', () => {
  const sources = new Map([['x', { code: `${NAV('"PAGEREF_pet"')}\n${NAV('"PAGEREF_pet-gallery"')}` }]]);
  const keyToId = new Map([['pet', 'id-pet'], ['pet-gallery', 'id-gallery']]);
  const { deployment, unresolved } = resolvePageRefs(sources, keyToId);
  assert.ok(deployment.get('x').includes('pageId: "id-pet"'));
  assert.ok(deployment.get('x').includes('pageId: "id-gallery"'));
  assert.deepStrictEqual(unresolved, []);
});


test('resolvePageRefs rewrites only the PAGEREF literal inside a quoted-key call', () => {
  const code = [
    'const decoy = "PAGEREF_detail";',
    'Xrm.Navigation.navigateTo({"pageType":"generative","pageId":"PAGEREF_detail", data: { label: "pageId" }});',
  ].join('\n');
  const expected = [
    'const decoy = "PAGEREF_detail";',
    'Xrm.Navigation.navigateTo({"pageType":"generative","pageId":"gp-detail", data: { label: "pageId" }});',
  ].join('\n');
  const { deployment, unresolved } = resolvePageRefs(new Map([['overview', { code }]]), new Map([['detail', 'gp-detail']]));
  assert.deepStrictEqual(unresolved, []);
  assert.strictEqual(deployment.get('overview'), expected);
});

test('resolvePageRefs rewrites the real quoted-key pageId after a ternary decoy', () => {
  const code = 'Xrm.Navigation.navigateTo({"pageType":"generative", foo: c ? "pageId" : "PAGEREF_wrong", "pageId":"PAGEREF_detail"});';
  const expected = 'Xrm.Navigation.navigateTo({"pageType":"generative", foo: c ? "pageId" : "PAGEREF_wrong", "pageId":"gp-detail"});';
  const { deployment, unresolved } = resolvePageRefs(new Map([['overview', { code }]]), new Map([['detail', 'gp-detail'], ['wrong', 'gp-wrong']]));
  assert.deepStrictEqual(unresolved, []);
  assert.strictEqual(deployment.get('overview'), expected);
});

test('resolvePageRefs rewrites a key after an earlier spread but not before a later spread', () => {
  const safe = 'Xrm.Navigation.navigateTo({ ...base, pageType: "generative", "pageId": "PAGEREF_detail" });';
  const unsafe = 'Xrm.Navigation.navigateTo({ pageType: "generative", "pageId": "PAGEREF_detail", ...base });';
  const { deployment, unresolved } = resolvePageRefs(new Map([['safe', { code: safe }], ['unsafe', { code: unsafe }]]), new Map([['detail', 'gp-detail']]));
  assert.deepStrictEqual(unresolved, []);
  assert.strictEqual(deployment.get('safe'), 'Xrm.Navigation.navigateTo({ ...base, pageType: "generative", "pageId": "gp-detail" });');
  assert.strictEqual(deployment.get('unsafe'), unsafe);
});

test('resolvePageRefs rewrites the last duplicate pageId key only', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_a", pageId: "PAGEREF_b" });';
  const expected = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_a", pageId: "gp-b" });';
  const { deployment, unresolved } = resolvePageRefs(new Map([['overview', { code }]]), new Map([['a', 'gp-a'], ['b', 'gp-b']]));
  assert.deepStrictEqual(unresolved, []);
  assert.strictEqual(deployment.get('overview'), expected);
});

test('resolvePageRefs leaves navigateTo text inside a string inert and unchanged', () => {
  const code = 'const help = \'navigateTo({"pageType":"generative","pageId":"PAGEREF_detail"})\';';
  const { deployment, unresolved } = resolvePageRefs(new Map([['help', { code }]]), new Map([['detail', 'gp-detail']]));
  assert.deepStrictEqual(unresolved, []);
  assert.strictEqual(deployment.get('help'), code);
});

test('resolvePageRefs collects dangling targets (sorted, unique) and leaves them verbatim', () => {
  const sources = new Map([
    ['a', { code: `${NAV('"PAGEREF_missing"')}\n${NAV('"PAGEREF_gone"')}` }],
    ['b', { code: NAV('"PAGEREF_gone"') }],
  ]);
  const { deployment, unresolved } = resolvePageRefs(sources, new Map());
  assert.deepStrictEqual(unresolved, ['gone', 'missing']);
  assert.ok(deployment.get('a').includes('"PAGEREF_missing"'), 'a dangling ref must not be dropped or mangled — the caller halts on it');
});

test('resolvePageRefs is idempotent — resolved code has no canonical nav PAGEREF left', () => {
  const once = resolvePageRefs(new Map([['x', { code: NAV('"PAGEREF_detail"') }]]), new Map([['detail', 'gp-1']])).deployment.get('x');
  assert.deepStrictEqual(navReferencedKeys(once), []);
});

// ─── reverseResolveNavIds ─────────────────────────────────────────────────────

test('reverseResolveNavIds rewrites ONLY the nav pageId literal back to "PAGEREF_<key>" (case-insensitive), never a recordId', () => {
  const idToKey = new Map([['5d29d8ce-1111-2222-3333-444455556666', 'detail']]);
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "5D29D8CE-1111-2222-3333-444455556666", recordId: "5d29d8ce-1111-2222-3333-444455556666" });';
  const out = reverseResolveNavIds(code, idToKey);
  assert.ok(out.includes('pageId: "PAGEREF_detail"'), 'nav pageId reversed');
  assert.ok(out.includes('recordId: "5d29d8ce-1111-2222-3333-444455556666"'), 'the SAME guid used as a recordId is NOT reversed (scoped to nav pageId)');
});


test('reverseResolveNavIds maps a quoted-key literal id back to a PAGEREF token', () => {
  const code = 'Xrm.Navigation.navigateTo({"pageType":"generative","pageId":"gp-detail"});';
  const out = reverseResolveNavIds(code, new Map([['gp-detail', 'detail']]));
  assert.strictEqual(out, 'Xrm.Navigation.navigateTo({"pageType":"generative","pageId":"PAGEREF_detail"});');
});

test('reverseResolveNavIds rewrites only the last duplicate pageId key', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "gp-a", pageId: "gp-b" });';
  const out = reverseResolveNavIds(code, new Map([['gp-a', 'a'], ['gp-b', 'b']]));
  assert.strictEqual(out, 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "gp-a", pageId: "PAGEREF_b" });');
});

test('resolve then reverse round-trips the navigation literal', () => {
  const original = NAV('"PAGEREF_detail"');
  const resolved = resolvePageRefs(new Map([['x', { code: original }]]), new Map([['detail', 'gp-42']])).deployment.get('x');
  assert.ok(resolved.includes('pageId: "gp-42"'));
  assert.strictEqual(reverseResolveNavIds(resolved, new Map([['gp-42', 'detail']])), original);
});

// Reverse resolution writes a token where forward resolution wrote an id, and must change nothing else. So it replaces only a DOUBLE-quoted
// id literal — the one the forward pass writes — and only where the lexer's reading of the page can be trusted. Every known id that is
// still in the result is reported (`left`), each with its place in the result, so a download says what it did not turn back into a token
// instead of corrupting a string, guessing, or staying silent.
const GUID = '11111111-1111-4111-8111-111111111111';
const REVERSE_IDS = new Map([[GUID, 'detail']]);
const reverseCall = (literal) => `navigateTo({ pageType: "generative", pageId: ${literal} });`;

test('reverse resolution replaces only a double-quoted id literal: a single-quoted or back-ticked one is left as the id, and reported', () => {
  assert.deepStrictEqual(reverseResolveNavIdsReport(reverseCall(`"${GUID}"`), REVERSE_IDS), { code: reverseCall('"PAGEREF_detail"'), left: [] });
  assert.deepStrictEqual(reverseResolveNavIdsReport(reverseCall(`"${GUID.toUpperCase()}"`), REVERSE_IDS), { code: reverseCall('"PAGEREF_detail"'), left: [] }, 'the case of the id does not matter');
  for (const [what, literal] of [['single-quoted', `'${GUID}'`], ['back-ticked', `\`${GUID}\``]]) {
    const code = reverseCall(literal);
    const report = reverseResolveNavIdsReport(code, REVERSE_IDS);
    assert.strictEqual(report.code, code, `${what}: the quoting is never changed`);
    assert.deepStrictEqual(report.left, [{ id: GUID, key: 'detail', line: 1, column: code.indexOf(GUID) + 1, why: 'quote' }], what);
    assert.strictEqual(reverseResolveNavIds(code, REVERSE_IDS), code, `${what}: the string form says the same`);
  }
  // One of each: the double-quoted one is turned back, the others are not, and each is reported once, in source order.
  const mixed = [reverseCall(`'${GUID}'`), reverseCall(`"${GUID}"`), reverseCall(`\`${GUID}\``)].join('\n');
  const report = reverseResolveNavIdsReport(mixed, REVERSE_IDS);
  assert.strictEqual(report.code, mixed.replace(`"${GUID}"`, '"PAGEREF_detail"'));
  assert.deepStrictEqual(report.left.map((l) => [l.line, l.why]), [[1, 'quote'], [3, 'quote']]);
  // An id that is not a known page is no business of reverse resolution, in any quotes: nothing is rewritten, nothing is reported.
  assert.deepStrictEqual(reverseResolveNavIdsReport(reverseCall(`'${GUID.replace('1111', '2222')}'`), REVERSE_IDS), { code: reverseCall(`'${GUID.replace('1111', '2222')}'`), left: [] });
});

test('reverse resolution writes no token at or after a frontier: the id stays, and is reported with the frontier', () => {
  const code = `${reverseCall(`"${GUID}"`)}\n${OBJECT_DIVISION}\n${reverseCall(`"${GUID}"`)}\n`;
  const report = reverseResolveNavIdsReport(code, REVERSE_IDS);
  assert.strictEqual(report.code, code.replace(`"${GUID}"`, '"PAGEREF_detail"'), 'before the frontier it is reversed as ever; after it, not');
  assert.deepStrictEqual(report.left, [{
    id: GUID,
    key: 'detail',
    line: 3,
    column: reverseCall(`"${GUID}"`).indexOf(GUID) + 1,
    why: 'frontier',
    frontier: { kind: 'brace', line: 2, column: OBJECT_DIVISION.indexOf('}/') + 2 },
  }]);
  assert.strictEqual(reverseResolveNavIds(code, REVERSE_IDS), report.code);
});

// The check is on the RESULT, as text, for every known id — not on the calls the lexer recognised. A frontier can hide a call: its id stays,
// and a report built from the recognised calls was empty, so a download that left a dead hardcoded id said nothing.
test('reverse resolution reports every known id left in the result, a call the lexer hid included', () => {
  const deployed = OBJECT_DIVISION_PAGE.replaceAll('"PAGEREF_detail"', `"${GUID}"`);
  assert.deepStrictEqual(extractNavTargets(deployed).map((t) => t.kind), ['literal'], 'the lexer sees one of the two calls');
  const report = reverseResolveNavIdsReport(deployed, REVERSE_IDS);
  assert.strictEqual(report.code, deployed.replace(`"${GUID}"`, '"PAGEREF_detail"'), 'the call before the guess is turned back');
  const lines = deployed.split('\n');
  assert.deepStrictEqual(report.left, [{
    id: GUID,
    key: 'detail',
    line: 5,
    column: lines[4].indexOf(GUID) + 1,
    why: 'frontier',
    frontier: { kind: 'brace', line: 4, column: lines[3].indexOf('}/') + 2 },
  }]);
});

test('reverse resolution reports an id that stays as data, text or a comment, with its place in the result, and no id that is only part of a longer one', () => {
  const upper = GUID.toUpperCase();
  const code = [
    `navigateTo({ pageType: "generative", pageId: "${GUID}", recordId: "${upper}" }); const note = "go to ${GUID}"; // ${GUID}`,
    `const near = ["${GUID}0", "x${GUID}", "${GUID}-2"];`,
    '',
  ].join('\n');
  const report = reverseResolveNavIdsReport(code, REVERSE_IDS);
  assert.strictEqual(report.code, code.replace(`"${GUID}"`, '"PAGEREF_detail"'));
  // Places are in the result, where the id before them on the line was replaced by a shorter token.
  const places = [...report.code.matchAll(new RegExp(`(?<![0-9a-z_-])${GUID}(?![0-9a-z_-])`, 'gi'))].map((m) => ({ id: m[0], ...positionOf(report.code, m.index) }));
  assert.strictEqual(places.length, 3);
  assert.deepStrictEqual(report.left, places.map((p) => ({ id: p.id, key: 'detail', line: p.line, column: p.column, why: 'text' })));
  assert.ok(report.left.some((l) => l.id === upper), 'the id is reported as it is written');
  // The ids it leaves are not the call it was sure of, and a page with none says nothing.
  assert.deepStrictEqual(reverseResolveNavIdsReport(reverseCall(`"${GUID}"`), REVERSE_IDS).left, []);
  assert.deepStrictEqual(reverseResolveNavIdsReport('const x = 1;', REVERSE_IDS).left, []);
  assert.deepStrictEqual(reverseResolveNavIdsReport(reverseCall(`'${GUID}'`), new Map()).left, [], 'no known ids: nothing to look for');
});

test('reverse resolution reports an id in a call that reaches a frontier, though the id lies before it', () => {
  const page = MISREAD_PAGES['inside an options object'];
  const deployed = page.code.replace('"PAGEREF_detail"', `"${GUID}"`);
  const report = reverseResolveNavIdsReport(deployed, REVERSE_IDS);
  assert.strictEqual(report.code, deployed, 'a call that is not trusted is not turned back');
  const lines = deployed.split('\n');
  assert.deepStrictEqual(report.left, [{
    id: GUID,
    key: 'detail',
    line: 3,
    column: lines[2].indexOf(GUID) + 1,
    why: 'frontier',
    frontier: { kind: 'brace', line: 4, column: lines[3].indexOf('}/') + 2, reaches: true },
  }]);
});

// The corruption this guards against. The lexer reads the regex after `of/2` as ending at the `/` of `/\/*$/`, and the `/*` after it opens a
// comment that ends at the `*/` inside the string on the next line: the rest of that DOUBLE-quoted string is then read as code — a call, whose
// single-quoted id was rewritten as "PAGEREF_detail", quotes and all, inside a string that the new quotes then ended.
test('a single-quoted id inside a string the lexer read as code is not turned into a token', () => {
  const code = ['const of = 12;', 'const count = of/2; const re = /\\/*$/;', `const note = "*/ navigateTo({pageType:'generative', pageId:'${GUID}'}) /*";`, ''].join('\n');
  assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.quote, t.afterFrontier]), [['literal', "'", true]], 'the lexer does read the call out of the string');
  const report = reverseResolveNavIdsReport(code, REVERSE_IDS);
  assert.strictEqual(report.code, code, 'the string is intact');
  assert.deepStrictEqual(report.left.map((l) => [l.id, l.line, l.why, l.frontier.kind]), [[GUID, 3, 'frontier', 'keyword']]);
  // The same string with the id double-quoted would be corrupted too, were it not for the frontier.
  const doubled = code.replace(`'${GUID}'`, `"${GUID}"`).replace("pageType:'generative'", 'pageType:"generative"');
  assert.strictEqual(reverseResolveNavIdsReport(doubled, REVERSE_IDS).code, doubled);
});

// ─── reverse resolution is checked against the forward path ───────────────────

// An id is shorter than most tokens: `"<36 characters>"` becomes `"PAGEREF_<key>"`, and the code after it moves. The lexer looks back a bounded
// stretch for the `(` of an `if` head, so a head just inside that window with ids is one just outside it with tokens — a `paren` ambiguity, after
// which no call is trusted, and a page that promotion and the build refuse. A download that wrote it said nothing. Reverse resolution reads
// what it would write the way the forward path will, and writes nothing the forward path would refuse: the ids stay, and are reported.
const LONG_IDS = new Map([[GUID, LONG_KEY]]);
const swapIds = (code) => code.replaceAll(GUID, `PAGEREF_${LONG_KEY}`);
// What the build does with a page of tokens: each is a refusal unless it is the canonical pageId of a call it trusts.
function forwardOutcome(code, keyToId) {
  const { deployment, unresolved, residual } = resolvePageRefs(new Map([['page', { code }]]), keyToId);
  return { stray: strayPageRefs(code), malformed: navMalformedRefs(code), unresolved, residual, resolved: deployment.get('page') };
}
const FORWARD_IDS = new Map([[LONG_KEY, GUID]]);

test('reverse resolution that would push a statement head past the look-behind keeps the ids, and reports each with the frontier', () => {
  const original = lookBehindPage(GUID, 20);
  const naive = swapIds(original);
  assert.strictEqual(navigationFrontier(original), null, 'premise: with ids the page is read for certain');
  assert.strictEqual(navigationFrontier(naive).kind, 'paren', 'premise: with tokens the head is past the look-behind');
  assert.ok(forwardOutcome(naive, FORWARD_IDS).stray.length > 0, 'premise: the forward path refuses the page that swapping would write');

  const report = reverseResolveNavIdsReport(original, LONG_IDS);
  assert.strictEqual(report.code, original, 'the page is exactly as it was: no token is written');
  assert.strictEqual(reverseResolveNavIds(original, LONG_IDS), original, 'the string form says the same');
  const lines = original.split('\n');
  // The frontier is where the page would have it, written as the page is: line 2, at the `/` that follows the head — a column of the ORIGINAL line.
  const slash = lines[1].indexOf(') /abc/') + 3;
  const places = [...original.matchAll(new RegExp(GUID, 'g'))].map((m) => positionOf(original, m.index));
  assert.strictEqual(places.length, 21, 'twenty calls in the head and one after the statement');
  assert.deepStrictEqual(report.left, places.map((p) => ({
    id: GUID, key: LONG_KEY, line: p.line, column: p.column, why: 'would-not-rebuild', frontier: { kind: 'paren', line: 2, column: slash },
  })));
  // The frontier is told in the coordinates of the page the person has: the shifted column of the swapped page is not what is reported.
  const shifted = navigationFrontier(naive);
  assert.strictEqual(shifted.line, 2);
  assert.ok(shifted.column > slash, 'the swapped page has the same construct further along its line');
});

// Whatever reverse resolution writes, the forward path takes unchanged: each token it wrote is the canonical pageId of a call it trusts, none is
// stray or malformed or unresolved, and resolving the result gives the page back. Where the ids are shorter than the tokens, the length of a
// head crosses the look-behind at some point, so the sweep covers every length around it, with each outcome met — one written, one kept.
test('whatever reverse resolution writes, the forward path accepts unchanged: a sweep across the look-behind boundary', () => {
  const calls = 3;
  const headDistance = (code) => code.indexOf(') /abc/') - code.indexOf('(');
  const base = headDistance(lookBehindPage(GUID, calls));
  const delta = `PAGEREF_${LONG_KEY}`.length - GUID.length;
  const lower = 2000 - base - calls * delta - 12;
  const upper = 2000 - base + 12;
  let written = 0;
  let kept = 0;
  for (let pad = lower; pad <= upper; pad += 1) {
    const original = lookBehindPage(GUID, calls, pad);
    const report = reverseResolveNavIdsReport(original, LONG_IDS);
    const swappedOutcome = forwardOutcome(swapIds(original), FORWARD_IDS);
    const swappable = swappedOutcome.stray.length === 0 && swappedOutcome.malformed.length === 0 && swappedOutcome.unresolved.length === 0 && swappedOutcome.residual.length === 0;
    if (report.code === original) {
      kept += 1;
      assert.ok(!swappable, `pad ${pad}: a page the forward path takes is not kept`);
      assert.deepStrictEqual([...new Set(report.left.map((l) => l.why))], ['would-not-rebuild'], `pad ${pad}`);
      assert.strictEqual(report.left.length, calls + 1, `pad ${pad}: every id is reported`);
    } else {
      written += 1;
      const outcome = forwardOutcome(report.code, FORWARD_IDS);
      assert.deepStrictEqual([outcome.stray, outcome.malformed, outcome.unresolved, outcome.residual], [[], [], [], []], `pad ${pad}: what is written is accepted`);
      assert.strictEqual(outcome.resolved, original, `pad ${pad}: and resolving it gives the page back`);
      // What stays is only what a guess the page already had hides: the call after the statement, when its head was already past the window.
      assert.deepStrictEqual(report.left.map((l) => l.why), navigationFrontier(original) ? ['frontier'] : [], `pad ${pad}`);
    }
  }
  assert.ok(written > 0 && kept > 0, `the sweep meets both outcomes (written ${written}, kept ${kept})`);
});

// A token the forward path cannot read back whole is one it would refuse: a key with a `.` is read as the token `PAGEREF_my` and then text.
test('reverse resolution keeps the id where the token it would write cannot be read back whole, and names no frontier', () => {
  const code = reverseCall(`"${GUID}"`);
  const report = reverseResolveNavIdsReport(code, new Map([[GUID, 'my.detail']]));
  assert.strictEqual(report.code, code);
  assert.deepStrictEqual(report.left, [{ id: GUID, key: 'my.detail', line: 1, column: code.indexOf(GUID) + 1, why: 'would-not-rebuild' }]);
});

// A key that closes the string it is written into would make the forward path read a shorter token and then more code: `"PAGEREF_a",x:"y"` is
// a call with the key `a` and a member `x`. The key the forward path reads is not the key that was written, so the token is not taken.
test('reverse resolution keeps the id where the key would close the string, and the forward path would read another key', () => {
  const code = reverseCall(`"${GUID}"`);
  const key = 'a",x:"y';
  assert.deepStrictEqual(navReferencedKeys(code.replace(`"${GUID}"`, `"PAGEREF_${key}"`)), ['a'], 'premise: the forward path reads the key `a`');
  const report = reverseResolveNavIdsReport(code, new Map([[GUID, key]]));
  assert.strictEqual(report.code, code);
  assert.deepStrictEqual(report.left, [{ id: GUID, key, line: 1, column: code.indexOf(GUID) + 1, why: 'would-not-rebuild' }]);
});

// A token reverse resolution writes can sit inside ANOTHER call's value: `pageId: pick(navigateTo({ … "<id>" }))`. That value is not a literal, so
// it was `dynamic` with ids; with a token in it the forward path calls it malformed and the build halts on it (navMalformedRefs), though the
// token is the canonical pageId of a call it trusts. The token is not taken: it is part of a value the forward path refuses.
test('reverse resolution keeps the id where the token would sit inside a value the forward path reports as malformed', () => {
  const code = `navigateTo({ pageType: "generative", pageId: pick(navigateTo({ pageType: "generative", pageId: "${GUID}" })) });\n`;
  assert.deepStrictEqual(extractNavTargets(code).map((t) => t.kind).sort(), ['dynamic', 'literal'], 'premise: the outer value is an expression');
  const naive = code.replace(`"${GUID}"`, '"PAGEREF_detail"');
  assert.deepStrictEqual(navMalformedRefs(naive), ['PAGEREF_detail'], 'premise: the forward path halts on the page that swapping would write');
  const report = reverseResolveNavIdsReport(code, REVERSE_IDS);
  assert.strictEqual(report.code, code);
  assert.deepStrictEqual(report.left, [{ id: GUID, key: 'detail', line: 1, column: code.indexOf(GUID) + 1, why: 'would-not-rebuild' }]);
  // The same call on its own is turned back as ever, and the pair is not what decides: only a token inside a malformed value does.
  const alone = `navigateTo({ pageType: "generative", pageId: "${GUID}" });\n`;
  assert.strictEqual(reverseResolveNavIdsReport(alone, REVERSE_IDS).code, alone.replace(`"${GUID}"`, '"PAGEREF_detail"'));
  const inData = `navigateTo({ pageType: "generative", pageId: "${GUID}", data: { next: () => navigateTo({ pageType: "generative", pageId: "${GUID}" }) } });\n`;
  assert.strictEqual(reverseResolveNavIdsReport(inData, REVERSE_IDS).code, inData.replaceAll(`"${GUID}"`, '"PAGEREF_detail"'), 'a call in the data of another is not in its pageId value');
});

// A frontier the page has that is not the cause is not named: the token is refused for its key, and the guess is after it.
test('a frontier the page has that is not the cause is not named', () => {
  const code = `${reverseCall(`"${GUID}"`)}\n${OBJECT_DIVISION}\n`;
  assert.strictEqual(navigationFrontier(code).kind, 'brace', 'premise: the page has a frontier');
  const report = reverseResolveNavIdsReport(code, new Map([[GUID, 'my.detail']]));
  assert.strictEqual(report.code, code);
  assert.deepStrictEqual(report.left.map((l) => [l.why, 'frontier' in l]), [['would-not-rebuild', false]]);
});

// The swap can also move a guess into a call from before it: the outer call's token lies before the `/`, but its object runs through it, and a
// call that reaches a frontier is not trusted. The group that the `/` divides holds the inner call, so it is the inner token that lengthens it.
// (A `/` with no second `/` after it on its line can only divide, so there is nothing to guess: the line ends `/ 2 / 1`.)
test('a token in a call that reaches the frontier the swap creates is not written, though the token lies before it', () => {
  const build = (id, pad) => `navigateTo({ pageType: "generative", pageId: "${id}", data: (navigateTo({ pageType: "generative", pageId: "${id}" }) && /*${'x'.repeat(pad)}*/ 1) / 2 / 1 });\n`;
  const probe = build(GUID, 0);
  const pad = 1990 - (probe.indexOf(') / 2 / 1') - probe.indexOf('(', probe.indexOf('data: ')));
  const original = build(GUID, pad);
  const naive = swapIds(original);
  assert.strictEqual(navigationFrontier(original), null, 'premise: with ids the group is read for certain');
  assert.strictEqual(navigationFrontier(naive).kind, 'paren', 'premise: with tokens the group is past the look-behind');
  const strays = strayPageRefs(naive);
  assert.deepStrictEqual(strays.map((r) => [r.line, 'reaches' in r.frontier]), [[1, true]], 'premise: the outer token is refused for reaching it; the inner one is not');
  assert.ok(strays[0].start < strays[0].frontier.start, 'premise: and it lies before it');

  const report = reverseResolveNavIdsReport(original, LONG_IDS);
  assert.strictEqual(report.code, original);
  const slash = original.indexOf(') / 2 / 1') + 3;
  assert.deepStrictEqual(report.left.map((l) => [l.why, l.frontier.kind, l.frontier.line, l.frontier.column]), [
    ['would-not-rebuild', 'paren', 1, slash],
    ['would-not-rebuild', 'paren', 1, slash],
  ]);
});

// A guess the swap creates can hide a call as well as distrust it: here the head read by guess takes `/\/*$/` for a division and a comment, and
// the comment covers the call after the statement. No call is read there, so nothing recognised holds its token — and it is still the guess's doing.
test('a call the frontier the swap creates hides is not written for, and the frontier is named', () => {
  const original = lookBehindPage(GUID, 20, 0, { regex: '/\\/*$/', after: '/* regular comment */\n' });
  const naive = swapIds(original);
  assert.strictEqual(navigationFrontier(original), null, 'premise: with ids the page is read for certain');
  assert.strictEqual(extractNavTargets(original).length, 21, 'premise: and all 21 calls are read');
  assert.strictEqual(navigationFrontier(naive).kind, 'paren', 'premise: with tokens the head is past the look-behind');
  assert.strictEqual(extractNavTargets(naive).filter((t) => t.kind === 'pageref').length, 20, 'premise: and the call after the statement is hidden by a comment that is not one');

  const report = reverseResolveNavIdsReport(original, LONG_IDS);
  assert.strictEqual(report.code, original);
  assert.strictEqual(report.left.length, 21);
  const slash = original.split('\n')[1].indexOf(') /\\/*$/') + 3;
  assert.ok(report.left.every((l) => l.why === 'would-not-rebuild' && l.frontier.kind === 'paren' && l.frontier.line === 2 && l.frontier.column === slash));
});

// Only a token reverse resolution writes decides: one the page already had is not its doing, and the forward path refuses it whatever happens.
test('a token the page already held does not keep reverse resolution from writing its own', () => {
  const code = `${reverseCall(`"${GUID}"`)}\nconst stray = "PAGEREF_other";\n`;
  const report = reverseResolveNavIdsReport(code, REVERSE_IDS);
  assert.strictEqual(report.code, code.replace(`"${GUID}"`, '"PAGEREF_detail"'));
  assert.deepStrictEqual(report.left, []);
});

// A guess the page already had, after every call written, is not the swap's doing and does not hold it back.
test('a frontier that comes after every token written does not keep reverse resolution from writing them', () => {
  const code = `${reverseCall(`"${GUID}"`)}\n${OBJECT_DIVISION}\n`;
  const report = reverseResolveNavIdsReport(code, LONG_IDS);
  assert.strictEqual(report.code, code.replace(`"${GUID}"`, `"PAGEREF_${LONG_KEY}"`));
  assert.deepStrictEqual(report.left, []);
  assert.deepStrictEqual(forwardOutcome(report.code, FORWARD_IDS).stray, [], 'the forward path takes it');
});

// ─── navTargetParity ──────────────────────────────────────────────────────────

test('navTargetParity reports declared-not-referenced and referenced-not-declared (both directions)', () => {
  assert.deepStrictEqual(navTargetParity(['detail', 'ghost'], ['detail', 'extra']), { declaredNotReferenced: ['ghost'], referencedNotDeclared: ['extra'] });
  assert.deepStrictEqual(navTargetParity(['a'], ['a']), { declaredNotReferenced: [], referencedNotDeclared: [] });
});

test('DECOY end-to-end: declared "detail" but the real nav points at "wrong" — parity REJECTS it', () => {
  const code = `const decoy = "PAGEREF_detail";\n${NAV('"PAGEREF_wrong"')}`;
  assert.deepStrictEqual(navTargetParity(['detail'], navReferencedKeys(code)), { declaredNotReferenced: ['detail'], referencedNotDeclared: ['wrong'] });
});

test('extractNavTargets respects JavaScript identifier boundaries and optional-call syntax', () => {
  const negatives = [
    'notnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
    '$navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
    'αnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
    '_navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
    'navigateTox({pageType:"generative",pageId:"PAGEREF_detail"})',
    'x\\u0041navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
    'x\\u{41}navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
    'x\u200CnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
    'x\u200DnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
  ];
  for (const code of negatives) assert.deepStrictEqual(navReferencedKeys(code), [], code);

  const positives = [
    'navigateTo?.({pageType:"generative",pageId:"PAGEREF_detail"})',
    'navigateTo /* comment */ ?. /* comment */ ({pageType:"generative",pageId:"PAGEREF_detail"})',
    'Xrm.Navigation.navigateTo?.({pageType:"generative",pageId:"PAGEREF_detail"})',
    'Xrm?.Navigation?.navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})',
    'navigate\\u0054o({pageType:"generative",pageId:"PAGEREF_detail"})',
  ];
  for (const code of positives) assert.deepStrictEqual(navReferencedKeys(code), ['detail'], code);
});

test('extractNavTargets follows object-literal last-write wins for runtime pageId and pageType overrides', () => {
  const dynamicPageId = [
    'pageId(){return "runtime";}',
    'get pageId(){return "runtime";}',
    'set pageId(v){}',
    'async pageId(){return "runtime";}',
    '*pageId(){yield "runtime";}',
    'async *pageId(){yield "runtime";}',
    '"pageId"(){return "runtime";}',
    "get 'pageId'(){return 'runtime';}",
    'pageId',
    'page\\u0049d(){return "runtime";}',
  ];
  for (const override of dynamicPageId) {
    const code = `const pageId = "runtime"; navigateTo({pageType:"generative",pageId:"PAGEREF_detail",${override}})`;
    const [target] = extractNavTargets(code);
    assert.strictEqual(target && target.kind, 'dynamic', override);
  }

  const dynamicPageType = [
    'pageType(){return "entityrecord";}',
    'get pageType(){return "entityrecord";}',
    'set pageType(v){}',
    'async pageType(){return "entityrecord";}',
    '*pageType(){yield "entityrecord";}',
    'async *pageType(){yield "entityrecord";}',
    '"pageType"(){return "entityrecord";}',
    "get 'pageType'(){return 'entityrecord';}",
    'pageType',
    'page\\u0054ype(){return "entityrecord";}',
  ];
  for (const override of dynamicPageType) {
    const code = `const pageType = "entityrecord"; navigateTo({pageType:"generative",pageId:"PAGEREF_detail",${override}})`;
    const [target] = extractNavTargets(code);
    assert.strictEqual(target && target.kind, 'dynamic', override);
  }

  assert.deepStrictEqual(navReferencedKeys('navigateTo({pageType:"generative",pageId(){return "runtime";},pageId:"PAGEREF_detail"})'), ['detail']);
  assert.deepStrictEqual(navReferencedKeys('navigateTo({pageType(){return "entityrecord";},pageType:"generative",pageId:"PAGEREF_detail"})'), ['detail']);
  assert.deepStrictEqual(navReferencedKeys('navigateTo({pageType:"generative",data:{pageId(){return "nested";}},pageId:"PAGEREF_detail"})'), ['detail']);
});

test('resolvePageRefs changes only real navigation pageId spans', () => {
  const code = [
    'notnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"});',
    '$navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});',
    'Xrm.Navigation.navigateTo?.({pageType:"generative",pageId:"PAGEREF_detail"});',
  ].join('\n');
  const { deployment, unresolved } = resolvePageRefs(new Map([['overview', { code }]]), new Map([['detail', 'gp-detail']]));
  assert.deepStrictEqual(unresolved, []);
  assert.strictEqual(deployment.get('overview'), code.replace('Xrm.Navigation.navigateTo?.({pageType:"generative",pageId:"PAGEREF_detail"});', 'Xrm.Navigation.navigateTo?.({pageType:"generative",pageId:"gp-detail"});'));
});

test('extractNavTargets treats modifier-computed keys as runtime overrides', () => {
  const cases = [
    'get ["pageId"](){return "runtime";}',
    'set [k](v){}',
    'async [k](){return "runtime";}',
    '*[k](){yield "runtime";}',
    'async *[k](){yield "runtime";}',
  ];
  for (const override of cases) {
    const code = `const k = "pageId"; navigateTo({pageType:"generative",pageId:"PAGEREF_a",${override}})`;
    assert.strictEqual(extractNavTargets(code)[0].kind, 'dynamic', override);
  }
});

test('extractNavTargets keeps astral and private identifiers out of navigateTo matches', () => {
  assert.deepStrictEqual(navReferencedKeys('𝑥navigateTo({pageType:"generative",pageId:"PAGEREF_a"})'), []);
  assert.deepStrictEqual(navReferencedKeys('this.#navigateTo({pageType:"generative",pageId:"PAGEREF_a"})'), []);
});

test('quoted property names decode escapes without executing source text', () => {
  assert.deepStrictEqual(navReferencedKeys('navigateTo({pageType:"generative",page\\u0049d:"PAGEREF_a"})'), ['a']);
  assert.deepStrictEqual(navReferencedKeys('navigateTo({pageType:"generative",\'pageI\\x64\':"PAGEREF_b"})'), ['b']);
});

test('lexer and resolver source do not evaluate page source while scanning', () => {
  const fs = require('node:fs');
  const resolver = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'), 'utf8');
  const lexer = fs.readFileSync(path.join(__dirname, '..', 'lib', 'source-literals.js'), 'utf8');
  for (const [file, text] of [['pageref-resolver.js', resolver], ['source-literals.js', lexer]]) {
    assert.doesNotMatch(text, /\bFunction\s*\(|\beval\s*\(|new\s+Function\b|\bvm\./, file);
  }
});

// ─── A property value is a literal only when it is exactly ONE string literal ─────────────────────────────────
//
// `"PAGEREF_detail".slice(8)` evaluates to "detail", yet the reader stopped at the literal as soon as the next
// token was not `+`, called it the canonical pageId, and rewrote just the quoted text — so the call received
// "<id-minus-8-characters>" instead. The value is the COMPLETE expression: a literal is exactly one string
// literal followed (past comments and whitespace) by `,` or the object's `}`. Anything else is not a literal
// value — it is never rewritten, and a PAGEREF_ token inside it is reported as malformed, as any other
// non-canonical form is, so the build stops instead of shipping it.
const callWith = (pageId, pageType = '"generative"') => `Xrm.Navigation.navigateTo({ pageType: ${pageType}, pageId: ${pageId}, data: {} });`;

const EXPRESSION_TAILS = {
  '&&': '"PAGEREF_detail" && "runtime"',
  '||': '"PAGEREF_detail" || "runtime"',
  '??': '"PAGEREF_detail" ?? "runtime"',
  'conditional, token as the test': '"PAGEREF_detail" ? "runtime" : "other"',
  'conditional, token in a branch': 'flag ? "PAGEREF_detail" : "other"',
  'conditional, tokens in both branches': 'flag ? "PAGEREF_edit" : "PAGEREF_view"',
  'method call': '"PAGEREF_detail".slice(8)',
  'method call, spaced': '"PAGEREF_detail" .toLowerCase()',
  'property': '"PAGEREF_detail".length',
  'index': '"PAGEREF_detail"[0]',
  'call': '"PAGEREF_detail"()',
  'optional chain': '"PAGEREF_detail"?.length',
  'concatenation': '"PAGEREF_detail" + suffix',
  'comparison': '"PAGEREF_detail" === other',
  'in': '"PAGEREF_detail" in lookup',
  'non-null assertion': '"PAGEREF_detail"!',
  'comma operator': '("PAGEREF_detail", "runtime")',
  'tagged template': '"PAGEREF_detail"`x`',
  'a comment inside the expression': '"PAGEREF_detail" /* keep */ + "x"',
  // A cast is type-only (TYPE_ONLY_TAILS below), but it does not make what comes AFTER it a literal.
  'a member of a parenthesised cast': '("PAGEREF_detail" as const).slice(1)',
  'a member after a const assertion': '"PAGEREF_detail" as const.slice(1)',
  'concatenation after a cast': '"PAGEREF_detail" as const + "x"',
  '|| after a cast': '"PAGEREF_detail" as string || "runtime"',
  '&& after a cast': '"PAGEREF_detail" as string && "runtime"',
  '?? after a cast': '"PAGEREF_detail" as string ?? "runtime"',
  'conditional after a cast': '"PAGEREF_detail" as const ? "a" : "b"',
  'comparison after a cast': '"PAGEREF_detail" as string < 5',
  'in after a cast': '"PAGEREF_detail" as string in lookup',
  'call after a cast': '"PAGEREF_detail" as const()',
  'tagged template after a cast': '"PAGEREF_detail" as const`x`',
  'index after a cast, on the next line': '"PAGEREF_detail" as string\n[0]',
  'comparison after a cast, on the next line': '"PAGEREF_detail" as Key\n< 5',
  'concatenation after the second of two casts': '"PAGEREF_detail" as unknown as string + "x"',
  // TypeScript reads `as true < limit > [false][0]` as a comparison, then a comparison with an index — an expression,
  // although every word of it could pass for a type.
  'a chain of casts ending in a comparison and an index': '"PAGEREF_detail" as unknown as true < limit > [false][0]',
  // TypeScript reads `as` and `satisfies` as operators only on the line of what they cast; on the next line the value has ended.
  'a cast on the next line': '"PAGEREF_detail"\nas const',
  'a second cast on the next line': '"PAGEREF_detail" as string\nsatisfies string',
  'a cast of a non-literal': 'String("PAGEREF_detail") as string',
};

test('a string literal followed by an expression tail is not a standalone literal value', () => {
  for (const [what, value] of Object.entries(EXPRESSION_TAILS)) {
    const code = callWith(value);
    const targets = extractNavTargets(code);
    assert.strictEqual(targets.length, 1, what);
    assert.strictEqual(targets[0].kind, 'pageref-malformed', `${what}: reported like any other non-canonical reference`);
    assert.strictEqual(targets[0].raw, value, `${what}: the value is the whole expression`);
    assert.strictEqual(code.slice(targets[0].valueStart, targets[0].valueEnd), value, `${what}: the span is the whole expression`);
    assert.deepStrictEqual(navReferencedKeys(code), [], what);
    // Every token in the value is named, not only the first: a conditional between two pages holds two.
    assert.deepStrictEqual(navMalformedRefs(code), [...new Set(value.match(/PAGEREF_[A-Za-z0-9_-]+/g))].sort(), what);
    const { deployment, unresolved } = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail'], ['edit', 'gp-edit'], ['view', 'gp-view']]));
    assert.strictEqual(deployment.get('x'), code, `${what}: never rewritten`);
    assert.deepStrictEqual(unresolved, [], what);
  }
});

test('an expression tail on a value with no PAGEREF token is dynamic, and a resolved id with a tail is not reversed', () => {
  const guid = '11111111-1111-4111-8111-111111111111';
  for (const value of ['"abc".slice(1)', '"abc" && "def"', 'flag ? "a" : "b"', 'key', '"PAGEREF_" + "detail"', `"${guid}".toLowerCase()`, `"${guid}" || fallback`]) {
    const [target] = extractNavTargets(callWith(value));
    assert.strictEqual(target.kind, 'dynamic', value);
    assert.strictEqual(target.raw, value, value);
  }
  const code = callWith(`"${guid}".toUpperCase()`);
  assert.strictEqual(reverseResolveNavIds(code, new Map([[guid, 'detail']])), code, 'a literal with a tail is not the id');
});

test('control: a literal stays one with a comment, whitespace or newline around it', () => {
  const literal = '"PAGEREF_detail"';
  const calls = [
    `navigateTo({ pageType: "generative", pageId: ${literal} /* note */, data: 1 })`,
    `navigateTo({ pageType: "generative", pageId: /* note */ ${literal} // note\n, data: 1 })`,
    `navigateTo({ pageType: "generative", pageId: ${literal} // last property\n})`,
    `navigateTo({ pageType: "generative", pageId: ${literal} /* last property */ })`,
    `navigateTo({ pageType: "generative",\n  pageId:\n    ${literal}\n    ,\n})`,
    `navigateTo({ pageType: "generative", pageId: ${literal},})`,
    `navigateTo({ pageId: ${literal}, pageType: "generative" })`,
    `navigateTo({ pageId: ${literal}, pageType: /* c */ "generative" /* c */ })`,
    `navigateTo({ pageId: ${literal}, pageType: "generative" // c\n})`,
  ];
  for (const code of calls) {
    const [target] = extractNavTargets(code);
    assert.strictEqual(target && target.kind, 'pageref', code);
    assert.strictEqual(code.slice(target.valueStart, target.valueEnd), literal, code);
    assert.deepStrictEqual(navMalformedRefs(code), [], code);
    assert.strictEqual(resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']])).deployment.get('x'), code.replace(literal, '"gp-detail"'), code);
  }
});

test('a pageType that is not exactly one string literal is not a generative navigation target', () => {
  const pageTypes = {
    '&&': '"generative" && "entityrecord"',
    '||': '"generative" || "entityrecord"',
    '??': '"generative" ?? "entityrecord"',
    'conditional': 'flag ? "generative" : "entityrecord"',
    'conditional, the other way': 'flag ? "entityrecord" : "generative"',
    'method call': '"generative".toString()',
    'concatenation': '"gener" + "ative"',
    'variable': 'kind',
    'a member of a parenthesised const assertion': '("generative" as const).toString()',
    'concatenation after a const assertion': '"generative" as const + ""',
    'another literal under a const assertion': '"entityrecord" as const',
    'comma operator': '("entityrecord", "generative")',
  };
  for (const [what, pageType] of Object.entries(pageTypes)) {
    const code = callWith('"PAGEREF_detail"', pageType);
    assert.deepStrictEqual(extractNavTargets(code), [], `${what}: the call is not provably generative, so nothing is rewritten`);
    assert.deepStrictEqual(navReferencedKeys(code), [], what);
    assert.strictEqual(resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']])).deployment.get('x'), code, `${what}: never rewritten`);
    // ...and its token does not pass in silence: nothing resolves it, so it is stray.
    assert.deepStrictEqual(strayPageRefs(code).map((r) => r.token), ['PAGEREF_detail'], what);
  }
  // Controls: a literal 'generative' with a comment or in single quotes or a template is still a generative call.
  for (const pageType of ['"generative"', "'generative'", '/* c */ "generative" /* c */', '`generative`']) {
    assert.deepStrictEqual(navReferencedKeys(callWith('"PAGEREF_detail"', pageType)), ['detail'], pageType);
  }
});

test('a template literal with a substitution is an expression, not a literal value', () => {
  for (const value of ['`PAGEREF_${key}`', '`${prefix}detail`', '`a${`b${c}`}d`']) {
    const [target] = extractNavTargets(callWith(value));
    assert.strictEqual(target.kind, 'dynamic', value);
  }
  // A template with nothing substituted is a string, and keeps its classification: a PAGEREF in one is malformed.
  assert.strictEqual(extractNavTargets(callWith('`PAGEREF_detail`'))[0].kind, 'pageref-malformed');
  assert.strictEqual(extractNavTargets(callWith('`11111111-1111-4111-8111-111111111111`'))[0].kind, 'literal');
});

// ─── Static call spellings ────────────────────────────────────────────────────────────────────────────────────
//
// A call is found by its callee's NAME and its first argument, so the spellings below — a parenthesised callee, a
// parenthesised argument, a computed member named by a string literal — went unseen: extraction returned no target,
// resolution left the symbolic token in the deployed page, and verification (which asks the same oracle) passed.
//
// A spelling counts only when it IS a navigateTo call whose WHOLE first argument is the object literal, because rewriting a
// token inside anything else changes what the page does:
//   navigateTo(({ … }).pageId.length === 14 ? a : b)    the object is read for its pageId; which branch runs depends on it
//   factory(navigateTo)({ … })                          `(navigateTo)` is an argument list: the callee is what factory returns
// So a parenthesised callee wraps exactly the callee (`navigateTo`, or a member chain ending in it) and stands where a call cannot
// continue an expression — not after an identifier, `)`, `]`, `.` or `?.`. A parenthesised argument is closed straight after the
// object (type-only casts may come first), and then the argument ends: at a `,` or at the call's `)`.
const OBJ = '{pageType:"generative",pageId:"PAGEREF_detail"}';

const NAVIGATION_SPELLINGS = {
  'parenthesised callee': `(navigateTo)(${OBJ})`,
  'parenthesised callee, spaced and commented': `( navigateTo /* c */ ) /* c */ ( ${OBJ} )`,
  'parenthesised member callee': `(Xrm.Navigation.navigateTo)(${OBJ})`,
  'parenthesised optional member callee': `(xrm?.Navigation?.navigateTo)(${OBJ})`,
  'doubly parenthesised callee': `((navigateTo))(${OBJ})`,
  'optional call of a parenthesised callee': `(navigateTo)?.(${OBJ})`,
  'parenthesised argument': `navigateTo((${OBJ}))`,
  'parenthesised argument, spaced': `navigateTo( ( ${OBJ} ) )`,
  'doubly parenthesised argument': `navigateTo(((${OBJ})))`,
  'parenthesised argument, optional call': `Xrm.Navigation.navigateTo?.((${OBJ}))`,
  'parenthesised argument with a second argument': `navigateTo((${OBJ}), { target: 2 })`,
  'a second argument': `navigateTo(${OBJ}, { target: 2 })`,
  'a trailing comma': `navigateTo(${OBJ},)`,
  'an object with a const assertion': `navigateTo(${OBJ} as const)`,
  'an object with satisfies': `navigateTo(${OBJ} satisfies NavigateOptions)`,
  'a cast, then a second argument': `navigateTo(${OBJ} as const, { target: 2 })`,
  'a cast inside a parenthesised argument': `navigateTo((${OBJ} as const))`,
  'computed member, double-quoted': `Xrm.Navigation["navigateTo"](${OBJ})`,
  'computed member, single-quoted': `Xrm.Navigation['navigateTo'](${OBJ})`,
  'computed member, back-ticked': `Xrm.Navigation[\`navigateTo\`](${OBJ})`,
  'computed optional member and call': `Xrm.Navigation?.["navigateTo"]?.(${OBJ})`,
  'computed member, spaced and commented': `Xrm.Navigation ?. [ /* c */ "navigateTo" /* c */ ] ?. ( ${OBJ} )`,
  'computed member with an escape': `Xrm.Navigation["navigate\\u0054o"](${OBJ})`,
  'computed member, then a parenthesised argument': `Xrm.Navigation?.["navigateTo"]?.((${OBJ}))`,
  'computed member of a computed member': `Xrm["Navigation"]["navigateTo"](${OBJ})`,
  'computed member after a call': `getXrm()["navigateTo"](${OBJ})`,
  'parenthesised computed callee': `(Xrm.Navigation["navigateTo"])(${OBJ})`,
  'parenthesised callee with a computed chain': `(Xrm["Navigation"]?.["navigateTo"])?.(${OBJ})`,
};

test('static spellings of a navigation call are recognised and resolved', () => {
  for (const [what, code] of Object.entries(NAVIGATION_SPELLINGS)) {
    const targets = extractNavTargets(code);
    assert.deepStrictEqual(targets.map((t) => [t.kind, t.key]), [['pageref', 'detail']], what);
    assert.strictEqual(code.slice(targets[0].valueStart, targets[0].valueEnd), '"PAGEREF_detail"', what);
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], what);
    const { deployment, unresolved } = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']]));
    assert.deepStrictEqual(unresolved, [], what);
    assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'), what);
    assert.deepStrictEqual(strayPageRefs(code), [], `${what}: nothing is left for the stray check`);
  }
});

// Each of these has the token of a generative navigation and none of them is a call that hands the object to navigateTo as its
// whole argument. They are not rewritten — resolving the token would change what the page does — and not silent either: the
// token is reported, so the build stops and the author writes the call out.
const UNRECOGNISED_CALLS = {
  // The reproductions.
  'an object read for its pageId in a condition': `navigateTo((${OBJ}).pageId.length === 14 ? a : b)`,
  'a callee that is the argument of another call': `factory(navigateTo)(${OBJ})`,
  // A callee group after a token that can END a callable operand: the group is then an argument list, whatever the callee in it.
  'after a non-null assertion': `factory!(navigateTo)(${OBJ})`,
  'after a generic instantiation': `factory<unknown>(navigateTo)(${OBJ})`,
  'after a tagged template': `tag\`x\`(navigateTo)(${OBJ})`,
  'after a function expression': `const g = function () { return f; }(navigateTo)(${OBJ})`,
  // A parenthesised callee that is not exactly the callee.
  'a callee in a comma expression': `(0, navigateTo)(${OBJ})`,
  'a callee in a logical expression': `(flag || navigateTo)(${OBJ})`,
  'a callee in a conditional': `(flag ? other : navigateTo)(${OBJ})`,
  'a member chain with a call in it': `(getXrm().navigateTo)(${OBJ})`,
  'a callee cast': `(navigateTo as Navigate)(${OBJ})`,
  'an argument list that closes a longer group': `factory((navigateTo))(${OBJ})`,
  // A parenthesised callee where a call or a member access would continue the expression.
  'after an identifier': `use(navigateTo)(${OBJ})`,
  'after a member': `Xrm.Navigation.wrap(navigateTo)(${OBJ})`,
  'after a call': `factory()(navigateTo)(${OBJ})`,
  'after an index': `handlers[0](navigateTo)(${OBJ})`,
  'after an optional call': `maybe?.(navigateTo)(${OBJ})`,
  'after new': `new (navigateTo)(${OBJ})`,
  'after await': `await (navigateTo)(${OBJ})`,
  'after a statement keyword': `if (navigateTo)(${OBJ})`,
  'after a number': `1(navigateTo)(${OBJ})`,
  // An object that is not the whole argument.
  'an object followed by a member': `navigateTo(${OBJ}.pageId)`,
  'an object followed by an index': `navigateTo(${OBJ}["pageId"])`,
  'an object followed by a call': `navigateTo(${OBJ}.toString())`,
  'an object in a conditional': `navigateTo(${OBJ} ? a : b)`,
  'an object in a binary expression': `navigateTo(${OBJ} + suffix)`,
  'an object in a logical expression': `navigateTo(${OBJ} || fallback)`,
  'an object with a tagged template': `navigateTo(${OBJ}\`x\`)`,
  'a parenthesised object followed by a member': `navigateTo((${OBJ}).pageId)`,
  'a parenthesised object in a conditional': `navigateTo((${OBJ}) ? a : b)`,
  'a parenthesised object, then a cast': `navigateTo((${OBJ}) as NavigateOptions)`,
  'an object in a comma expression, as its first operand': `navigateTo((${OBJ}, other))`,
  'a doubly parenthesised object followed by a member': `navigateTo(((${OBJ}).pageId))`,
};

test('a navigateTo spelling whose callee is not the callee, or whose object is not the whole argument, is not a call', () => {
  for (const [what, code] of Object.entries(UNRECOGNISED_CALLS)) {
    assert.deepStrictEqual(extractNavTargets(code), [], what);
    assert.deepStrictEqual(navReferencedKeys(code), [], what);
    assert.strictEqual(resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']])).deployment.get('x'), code, `${what}: never rewritten`);
    assert.deepStrictEqual(strayPageRefs(code).map((r) => r.token), ['PAGEREF_detail'], `${what}: reported as stray`);
  }
});

// The `(` that opens a parenthesised callee begins a navigation call only after a token that cannot END a callable operand. The
// tokens that can are many and easy to miss — `!` (a non-null assertion), `>` (a generic instantiation), a back-tick (a tagged
// template), `}` (a function expression) — so the tokens that may stand there are listed, and everything else is refused:
//   the start of the source   ;  {  (  [  ,  :  ?  (a ternary)   any operator ending in =   =>   &&   ||   ??
// What a call or a member access would continue is then refused whether or not anyone thought of it.
test('a parenthesised callee is a call only after a token on the allowlist', () => {
  const callee = `(navigateTo)(${OBJ})`;
  // [text before, text after] — each puts the callee where an expression, or a statement, begins.
  const allowed = [['', ''], [';', ''], ['a();\n', ''], ['{ ', ' }'], ['function f() { ', ' }'], ['foo(', ')'], ['if (', ') {}'], ['foo(a, ', ')'], ['[', ']'], ['[a, ', ']'],
    ['{ a: ', ' }'], ['cond ? a : ', ''], ['switch (x) { case 1: ', ' }'], ['cond ? ', ' : 0'],
    ['x = ', ';'], ['x == ', ''], ['x === ', ''], ['x != ', ''], ['x !== ', ''], ['x += ', ''], ['x -= ', ''], ['x *= ', ''], ['x /= ', ''], ['x %= ', ''],
    ['x <= ', ''], ['x >= ', ''], ['x **= ', ''], ['x <<= ', ''], ['x >>= ', ''], ['x >>>= ', ''], ['x &= ', ''], ['x |= ', ''], ['x ^= ', ''],
    ['x &&= ', ''], ['x ||= ', ''], ['x ??= ', ''], ['() => ', ''], ['async (x) => ', ''], ['a && ', ''], ['a || ', ''], ['a ?? ', ''],
    ['\n', ''], ['/* c */ ', ''], ['// c\n', ''], ['void 0, ', '']];
  for (const [before, after] of allowed) {
    const code = `${before}${callee}${after}`;
    assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']], JSON.stringify(code));
    assert.deepStrictEqual(strayPageRefs(code), [], JSON.stringify(code));
  }
  // Everything else: what a call, an index or a member would continue, and every token that can end a callable operand — a name or
  // keyword, `)`, `]`, `.`, `?.`, `}` (also at the end of a block), `!`, a `>` that is not `=>`, a quote or a back-tick, `++`/`--`,
  // and the operators that are not on the list.
  const refused = ['x', 'x ', 'foo', 'foo(a)', 'foo[0]', 'foo.', 'foo?.', 'foo?. ', '1', '$', '_', 'αβ', 'a)', 'a]',
    'new ', 'await ', 'return ', 'typeof ', 'void ', 'while ', 'else ', 'in ', 'of ', 'delete ', 'throw ', 'yield ', 'case ', 'do ', 'instanceof ',
    '{}', 'x = {}', '{ a(); }\n', 'function f() {}\n', 'if (a) { }\n', 'function () { return f; }',
    'a!', 'a! ', 'factory!', 'a<unknown>', 'factory<unknown>', 'a > ', 'a >> ', 'a >>> ',
    '`tag`', '`x${y}`', 'tag`x`', '"s"', "'s'", 'a++', 'a--', 'a++ ', 'a-- ',
    'a + ', 'a - ', 'a * ', 'a / ', 'a % ', 'a ** ', 'a < ', 'a << ', 'a & ', 'a | ', 'a ^ ', '~', '-', '+', '!', '!!', '...', '[...'];
  for (const before of refused) {
    const code = `${before}${callee}`;
    assert.deepStrictEqual(extractNavTargets(code), [], JSON.stringify(code));
    assert.deepStrictEqual(strayPageRefs(code).map((r) => r.token), ['PAGEREF_detail'], JSON.stringify(code));
    assert.strictEqual(resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']])).deployment.get('x'), code, `${JSON.stringify(code)}: never rewritten`);
  }
  // The opening back-tick of a template expression is a back-tick too: the mask cannot tell it from the closing one of a tagged template, so
  // a parenthesised callee at the start of a `${…}` is refused. The plain call there is a call.
  const inTemplate = (call) => '`${' + call + '}`';
  assert.deepStrictEqual(extractNavTargets(inTemplate(callee)), []);
  assert.deepStrictEqual(strayPageRefs(inTemplate(callee)).map((r) => r.token), ['PAGEREF_detail']);
  assert.deepStrictEqual(extractNavTargets(inTemplate(`navigateTo(${OBJ})`)).map((t) => [t.kind, t.key]), [['pageref', 'detail']]);
  assert.deepStrictEqual(extractNavTargets(inTemplate(`x = ${callee}`)).map((t) => [t.kind, t.key]), [['pageref', 'detail']], 'after an `=` inside the body it is a call again');
});

test('spellings that are not a navigateTo call with an object literal are not mistaken for one', () => {
  const notCalls = {
    'a different member name': `Xrm.Navigation["navigateToX"](${OBJ})`,
    'a different member name, prefixed': `Xrm.Navigation["xnavigateTo"](${OBJ})`,
    'an escaped different name': `Xrm.Navigation["navigate\\u0055o"](${OBJ})`,
    'an array literal, called': `["navigateTo"](${OBJ})`,
    'a computed key in an object literal': `const o = { ["navigateTo"]: (${OBJ}) };`,
    'a list of names': `const names = ["navigateTo", ${OBJ}];`,
    'a template with a substitution': `Xrm.Navigation[\`navigate\${"To"}\`](${OBJ})`,
    'a name that only mentions it': `Xrm.Navigation["navigateTo is a method"](${OBJ})`,
    'a parenthesised different callee': `(go)(${OBJ})`,
    'the callee not called': `const f = (navigateTo); const o = ${OBJ};`,
    'a call with a variable': `navigateTo((target))`,
    'a string holding the spelling': `const s = '(navigateTo)(${OBJ})';`,
    'a comment holding the spelling': `// Xrm.Navigation["navigateTo"](${OBJ})\n`,
  };
  for (const [what, code] of Object.entries(notCalls)) {
    assert.deepStrictEqual(extractNavTargets(code), [], what);
  }
});

// ─── TypeScript type-only tails ───────────────────────────────────────────────────────────────────────────────
//
// `"PAGEREF_detail" as const` is the string "PAGEREF_detail" when the page runs: `as`, `as const` and `satisfies` are
// erased by the compiler and never change a value. Generated TSX plausibly writes the const assertion, and refusing it
// would halt a valid build — so the value of a `pageId` (or a `pageType`) is still a literal when ONE string literal is
// followed by casts and nothing else, in a SMALL grammar:
//   literal  ( `as const`  |  `as` Name  |  `satisfies` Name )*   and then the `,` or `}` that ends the value
//   Name     a plain or dotted identifier — `string`, `PageKey`, `Pages.Key`; `true` and `this` are only identifiers here —
//            with no type arguments, suffixes, unions or literal types
// The literal alone is what a rewrite replaces; the casts stay as written:
//   pageId: "PAGEREF_detail" as const   →   pageId: "<page id>" as const
// Anything outside the grammar is not a literal. It is reported like any other non-canonical reference and never rewritten,
// whether TypeScript would erase it (a union, a generic, a string-literal type: DECLINED_TYPE_TAILS) or not (what follows a
// cast is an expression: `("PAGEREF_detail" as const).slice(1)`, `"PAGEREF_detail" as const + "x"`: EXPRESSION_TAILS).
const TYPE_ONLY_TAILS = {
  'const assertion': '"PAGEREF_detail" as const',
  'type assertion': '"PAGEREF_detail" as string',
  'satisfies': '"PAGEREF_detail" satisfies string',
  'a named type': '"PAGEREF_detail" as PageKey',
  'a qualified type name': '"PAGEREF_detail" as Pages.Key',
  'a deeply qualified type name': '"PAGEREF_detail" as App.Pages.Key',
  'a name with $ and _': '"PAGEREF_detail" as $Page_Key',
  'two casts': '"PAGEREF_detail" as unknown as string',
  'a const assertion, then satisfies': '"PAGEREF_detail" as const satisfies string',
  'a keyword type': '"PAGEREF_detail" as never',
  'true, which is an identifier here': '"PAGEREF_detail" as true',
  'this, which is an identifier here': '"PAGEREF_detail" as this',
  'comments between the tokens': '"PAGEREF_detail" /* a */ as /* b */ const /* c */',
  'a line comment after the type': '"PAGEREF_detail" as const // the literal type\n',
  'a line break after the keyword': '"PAGEREF_detail" as\n    PageKey',
};

test('a literal followed only by type-only casts is still a literal, and a rewrite keeps the casts', () => {
  for (const [what, value] of Object.entries(TYPE_ONLY_TAILS)) {
    const code = callWith(value);
    const targets = extractNavTargets(code);
    assert.deepStrictEqual(targets.map((t) => [t.kind, t.key]), [['pageref', 'detail']], what);
    assert.strictEqual(code.slice(targets[0].valueStart, targets[0].valueEnd), '"PAGEREF_detail"', `${what}: the span is the literal alone`);
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], what);
    assert.deepStrictEqual(navMalformedRefs(code), [], what);
    assert.deepStrictEqual(strayPageRefs(code), [], what);
    const { deployment, unresolved, residual } = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']]));
    assert.deepStrictEqual([unresolved, residual], [[], []], what);
    assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'), `${what}: only the literal is rewritten`);
    assert.strictEqual(reverseResolveNavIds(deployment.get('x'), new Map([['gp-detail', 'detail']])), code, `${what}: the download inverse keeps the casts too`);
  }
});

test('type-only casts are accepted wherever the literal sits in the call, and on the pageType and the whole object', () => {
  const calls = [
    'navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" as const })',
    'navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" as const, })',
    'navigateTo({ pageType: "generative" as const, pageId: "PAGEREF_detail" as const })',
    'navigateTo({ pageId: "PAGEREF_detail" as const, pageType: "generative" as const })',
    'navigateTo({ pageId: "PAGEREF_detail" satisfies string, pageType: \'generative\' satisfies string, data: 1 })',
    'navigateTo({ pageType: "generative" as const, pageId: "PAGEREF_detail" as const, data: { next: "x" as const } } as const)',
    'navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" } satisfies NavigateOptions)',
    'navigateTo({\n  pageType: "generative",\n  pageId:\n    "PAGEREF_detail" as\n      const,\n})',
    'navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" as const // note\n})',
  ];
  for (const code of calls) {
    assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']], code);
    assert.deepStrictEqual(strayPageRefs(code), [], code);
    const { deployment } = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']]));
    assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'), code);
  }
  // A pageType with a cast is still `generative`; one that is another value, or an expression, is not.
  assert.deepStrictEqual(navReferencedKeys(callWith('"PAGEREF_detail"', '"generative" satisfies string')), ['detail']);
  assert.deepStrictEqual(extractNavTargets(callWith('"PAGEREF_detail"', '"entityrecord" as const')), []);
});

// Valid TypeScript outside the grammar above. Each is NOT a literal: reported like any other non-canonical reference and never
// rewritten — a string-literal type that holds a PAGEREF_ token included, which the compiler erases but this check, reading the
// source, does not: a token is allowed only as the double-quoted pageId literal of a navigateTo call, and nowhere else, a comment included.
const DECLINED_TYPE_TAILS = {
  'a string-literal type': '"PAGEREF_detail" as "overview"',
  'a union of string-literal types': '"PAGEREF_detail" as "overview" | "detail"',
  'a string-literal type holding another token': '"PAGEREF_detail" as "PAGEREF_other"',
  'a string-literal type holding the same token': '"PAGEREF_detail" as "PAGEREF_detail"',
  'a union of names': '"PAGEREF_detail" as PageKey | Other',
  'a union with a leading bar, over several lines': '"PAGEREF_detail" as\n    | "overview"\n    | "detail"',
  'an intersection': '"PAGEREF_detail" as string & Brand',
  'type arguments': '"PAGEREF_detail" as Readonly<string>',
  'nested type arguments': '"PAGEREF_detail" as Brand<Readonly<string>>',
  'type arguments separated by a comma': '"PAGEREF_detail" as Extract<keyof Pages, string>',
  'a function type inside type arguments': '"PAGEREF_detail" as Brand<() => void>',
  'type arguments that never close': '"PAGEREF_detail" as Brand<string',
  'an array type': '"PAGEREF_detail" as string[]',
  'an indexed access type': '"PAGEREF_detail" as Pages["detail"]',
  'a parenthesised type': '"PAGEREF_detail" as (string | undefined)',
  'keyof typeof': '"PAGEREF_detail" as keyof typeof PAGES',
  'a function type': '"PAGEREF_detail" as () => string',
  'a conditional type': '"PAGEREF_detail" as Key extends string ? Key : never',
  'a template literal type': '"PAGEREF_detail" as `page-${string}`',
  'a numeric literal type': '"PAGEREF_detail" as 5',
  'a cast with no type': '"PAGEREF_detail" as',
  'const as the type of satisfies': '"PAGEREF_detail" satisfies const',
  'const with a qualifier': '"PAGEREF_detail" as const.x',
  'a name with a space before its dot': '"PAGEREF_detail" as Pages .Key',
  'a non-ASCII type name': '"PAGEREF_detail" as Página',
};

test('a cast outside the small grammar fails closed: reported, never rewritten', () => {
  for (const [what, value] of Object.entries(DECLINED_TYPE_TAILS)) {
    const code = callWith(value);
    assert.deepStrictEqual(extractNavTargets(code).map((t) => t.kind), ['pageref-malformed'], what);
    // The tokens of the whole value — the type's too — are the ones reported.
    assert.deepStrictEqual(navMalformedRefs(code), [...new Set(value.match(/PAGEREF_[A-Za-z0-9_-]+/g))].sort(), what);
    assert.deepStrictEqual(navReferencedKeys(code), [], what);
    assert.deepStrictEqual(strayPageRefs(code), [], `${what}: the malformed report names it`);
    assert.strictEqual(resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail'], ['other', 'gp-other']])).deployment.get('x'), code, `${what}: never rewritten`);
  }
});

// A string-literal type is erased by the compiler, so a token in one ships nowhere — but the build reads the source. It reports
// the token (a second one beside the literal included) rather than let one hide in an erased span, where stray detection and the
// download inverse could not see it.
test('a PAGEREF_ token in a type is reported, never erased: stray detection and reverse resolution still see it', () => {
  const guid = '11111111-1111-4111-8111-111111111111';
  assert.deepStrictEqual(navMalformedRefs(callWith('"PAGEREF_detail" as "PAGEREF_other"')), ['PAGEREF_detail', 'PAGEREF_other']);
  // A resolved id with a type holding a token is not a literal, so it is not reversed: the token stays visible to the report.
  const resolved = callWith(`"${guid}" as "PAGEREF_other"`);
  assert.deepStrictEqual(extractNavTargets(resolved).map((t) => [t.kind, t.key]), [['pageref-malformed', 'other']]);
  assert.strictEqual(reverseResolveNavIds(resolved, new Map([[guid, 'detail']])), resolved);
  // Outside a navigation pageId, a token in a type is stray like a token in any string.
  const code = 'type PageKey = "PAGEREF_a" | "PAGEREF_b";\nconst key = "x" as "PAGEREF_c";';
  assert.deepStrictEqual(strayPageRefs(code).map((r) => [r.token, r.line]), [['PAGEREF_a', 1], ['PAGEREF_b', 1], ['PAGEREF_c', 2]]);
});

test('a cast on a value that is not a canonical PAGEREF literal keeps that value\'s classification', () => {
  const guid = '11111111-1111-4111-8111-111111111111';
  const resolved = callWith(`"${guid}" as const`);
  const [literal] = extractNavTargets(resolved);
  assert.deepStrictEqual([literal.kind, literal.pageId, resolved.slice(literal.valueStart, literal.valueEnd)], ['literal', guid, `"${guid}"`]);
  assert.strictEqual(reverseResolveNavIds(resolved, new Map([[guid, 'detail']])), resolved.replace(`"${guid}"`, '"PAGEREF_detail"'));
  assert.strictEqual(extractNavTargets(callWith(`("${guid}" as const).toUpperCase()`))[0].kind, 'dynamic');
  assert.strictEqual(extractNavTargets(callWith('key as string'))[0].kind, 'dynamic');
  for (const value of ["'PAGEREF_detail' as const", '`PAGEREF_detail` as const']) {
    assert.strictEqual(extractNavTargets(callWith(value))[0].kind, 'pageref-malformed', `${value}: only the double-quoted token is canonical`);
  }
});

// The claim above, run rather than argued: TypeScript erases every tolerated tail, so the call receives the literal, and a
// rewritten page passes its page id; each expression that hides behind a cast really does hand the call another value.
test('TypeScript erases every tolerated tail, and runs the expressions it refuses as other values', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const receivedBy = (source) => {
    const { outputText, diagnostics } = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    assert.deepStrictEqual(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], source);
    let options;
    vm.runInNewContext(outputText, { Xrm: { Navigation: { navigateTo: (o) => { options = o; } } }, limit: 5 });
    return options;
  };
  for (const [what, value] of Object.entries(TYPE_ONLY_TAILS)) {
    const code = callWith(value);
    assert.strictEqual(receivedBy(code).pageId, 'PAGEREF_detail', `${what}: the casts leave the literal`);
    const resolved = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']])).deployment.get('x');
    const options = receivedBy(resolved);
    assert.deepStrictEqual([options.pageType, options.pageId], ['generative', 'gp-detail'], `${what}: the rewritten page passes the page id`);
  }
  // Expressions behind a cast chain really do hand the call another value. The last one is a comparison, not a cast: read as a cast it would
  // be rewritten, and the page would then compare a page id where it compared the token.
  for (const value of ['("PAGEREF_detail" as const).slice(1)', '"PAGEREF_detail" as const + "x"', '"PAGEREF_detail" as string && "runtime"', '"PAGEREF_detail" as const ? "a" : "b"', '"PAGEREF_detail" as unknown as true < limit > [false][0]']) {
    assert.notStrictEqual(receivedBy(callWith(value)).pageId, 'PAGEREF_detail', `${value}: not the literal, so not rewritten as one`);
  }
  // Valid TypeScript that the grammar declines still erases to the literal — it is declined for being outside the grammar, not
  // because the compiler keeps it.
  for (const value of ['"PAGEREF_detail" as "overview" | "detail"', '"PAGEREF_detail" as Readonly<string>', '"PAGEREF_detail" as string[]']) {
    assert.strictEqual(receivedBy(callWith(value)).pageId, 'PAGEREF_detail', `${value}: erased by TypeScript`);
    assert.strictEqual(extractNavTargets(callWith(value))[0].kind, 'pageref-malformed', `${value}: declined by the grammar`);
  }
  // The refused spellings that are not even TypeScript: a cast keyword on the next line is a syntax error.
  for (const value of ['"PAGEREF_detail"\nas const', '"PAGEREF_detail" as string\nsatisfies string']) {
    assert.ok(ts.transpileModule(callWith(value), { reportDiagnostics: true }).diagnostics.length > 0, `${JSON.stringify(value)} is not valid TypeScript`);
  }
});

// SOUNDNESS against TypeScript's own parser, not argued: every sequence of up to four tokens from a small alphabet — casts, names,
// the operators that would continue an expression after one, a line break — follows the literal of a `pageId`, and then of a
// `pageType`. Whenever the oracle calls the result a literal AND TypeScript parses the call without a syntax error, TypeScript must
// see exactly the bare literal once the casts are peeled off, with the next member intact. A value TypeScript rejects cannot be a
// page, so what the oracle does with it is not judged here; one the oracle declines is only incomplete, never unsound.
test('every value the oracle calls a literal is the bare literal to TypeScript, over every short cast-and-operator sequence', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const alphabet = ['as', 'satisfies', 'const', 'T', 'true', '<', '>', '[0]', '(', '+', '||', '.x', '\n'];
  // The text of the literal TypeScript reads as `member`'s value once as/satisfies are peeled; null when it is anything else
  // (or the next member is not intact); undefined when the call is not valid TypeScript.
  const literalTypeScriptSees = (code, member) => {
    const file = ts.createSourceFile('sweep.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (file.parseDiagnostics.length) return undefined;
    const members = new Map(file.statements[0].expression.arguments[0].properties.map((p) => [p.name && p.name.getText(), p.initializer]));
    if (!members.get('data') || members.get('data').getText() !== '1') return null;
    let value = members.get(member);
    while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
    return ts.isStringLiteral(value) ? value.text : null;
  };
  const callWithTail = { pageId: (tail) => `navigateTo({ pageType: "generative", pageId: "PAGEREF_x"${tail}, data: 1 });`, pageType: (tail) => `navigateTo({ pageType: "generative"${tail}, pageId: "PAGEREF_x", data: 1 });` };
  const expected = { pageId: 'PAGEREF_x', pageType: 'generative' };
  const unsound = [];
  const accepted = { pageId: 0, pageType: 0 };
  const sequence = [];
  const visit = (depth) => {
    if (depth > 0) {
      const tail = sequence.map((token) => (token === '\n' ? token : ` ${token}`)).join('');
      for (const member of ['pageId', 'pageType']) {
        const code = callWithTail[member](tail);
        const targets = extractNavTargets(code);
        if (targets.length !== 1 || targets[0].kind !== 'pageref') continue;
        const seen = literalTypeScriptSees(code, member);
        if (seen === undefined) continue;
        accepted[member] += 1;
        if (seen !== expected[member]) unsound.push(`${member}${JSON.stringify(tail)}`);
      }
    }
    if (depth < 4) for (const token of alphabet) { sequence.push(token); visit(depth + 1); sequence.pop(); }
  };
  visit(0);
  assert.deepStrictEqual(unsound, []);
  // Not vacuous: the sweep reaches the accepting path for both members.
  assert.ok(accepted.pageId >= 40 && accepted.pageType >= 40, `the sweep accepted ${accepted.pageId} pageId and ${accepted.pageType} pageType tails`);
});

// The samples are the pages a builder is told to copy (page-plan.js points non-mock pages at samples/9), so a navigation they show
// has to be one the build accepts: a token in the double-quoted canonical form, at a call the resolver reads, and nowhere else outside
// a comment. A sample that spelled it another way gave every page built from it a halt before any upload.
test('every committed sample page uses PAGEREF_ tokens only in a form the build accepts', () => {
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  const samples = execFileSync('git', ['ls-files', '-z', 'plugins/model-apps/samples/*.tsx'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(samples.length >= 8, `expected the committed samples, found ${samples.length}`);
  const offenders = [];
  for (const file of samples) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    const problems = [...navMalformedRefs(code), ...strayPageRefs(code).map((r) => `${r.token} (line ${r.line})`)];
    if (problems.length) offenders.push(`${file}: ${problems.join(', ')}`);
  }
  assert.deepStrictEqual(offenders, []);
  // The two samples that show cross-page navigation point at each other.
  const read = (name) => fs.readFileSync(path.join(root, 'plugins', 'model-apps', 'samples', name), 'utf8');
  assert.deepStrictEqual(navReferencedKeys(read('9-list-with-caching.tsx')), ['10-detail-with-pageinput']);
  assert.deepStrictEqual(navReferencedKeys(read('10-detail-with-pageinput.tsx')), ['9-list-with-caching']);
});

// ─── Order of targets ─────────────────────────────────────────────────────────────────────────────────────────
//
// Resolution builds its output in one left-to-right pass, which is only correct when the targets come in source order.
// Calls are discovered in the order their callees appear, and an outer call's pageId may follow a call nested in its
// data — so it is the targets, not the discovery, that are put in order. Out of order, the second replacement
// landed at the first's old offsets and corrupted the source.
test('targets are in source order, so nested calls resolve and reverse without corrupting the source', () => {
  const inner = 'navigateTo({ pageType: "generative", pageId: "PAGEREF_inner" })';
  const code = `navigateTo({ pageType: "generative", data: ${inner}, pageId: "PAGEREF_outer" })`;
  const targets = extractNavTargets(code);
  assert.deepStrictEqual(targets.map((t) => t.key), ['inner', 'outer']);
  assert.ok(targets[0].valueStart < targets[1].valueStart);
  const keyToId = new Map([['inner', 'gp-inner-0123456789'], ['outer', 'gp-o']]);
  const { deployment } = resolvePageRefs(new Map([['x', { code }]]), keyToId);
  assert.strictEqual(deployment.get('x'), `navigateTo({ pageType: "generative", data: ${inner.replace('"PAGEREF_inner"', '"gp-inner-0123456789"')}, pageId: "gp-o" })`);
  const back = reverseResolveNavIds(deployment.get('x'), new Map([['gp-inner-0123456789', 'inner'], ['gp-o', 'outer']]));
  assert.strictEqual(back, code, 'resolve then reverse round-trips nested calls');
  // A nested call inside the OTHER property of the outer call, and three levels.
  const three = `navigateTo({ data: navigateTo({ data: navigateTo({ pageType: "generative", pageId: "PAGEREF_c" }), pageType: "generative", pageId: "PAGEREF_b" }), pageType: "generative", pageId: "PAGEREF_a" })`;
  assert.deepStrictEqual(extractNavTargets(three).map((t) => t.key), ['c', 'b', 'a']);
  const resolved = resolvePageRefs(new Map([['x', { code: three }]]), new Map([['a', 'A'], ['b', 'BB'], ['c', 'CCC']])).deployment.get('x');
  assert.strictEqual(resolved, three.replace('PAGEREF_a', 'A').replace('PAGEREF_b', 'BB').replace('PAGEREF_c', 'CCC'));
});

// ─── PAGEREF_ tokens nothing resolves ─────────────────────────────────────────────────────────────────────────
//
// A token the resolver does not rewrite ships as the literal string "PAGEREF_x" — a dead link when it is a page id
// the host later reads. The ways to leave one are many (a string, a template, a variable a call reads, a call spelled
// another way), so they are not enumerated: a token that is not the canonical pageId of a recognised call, not
// reported as malformed, and not in a comment is STRAY.
test('strayPageRefs reports every PAGEREF_ token no navigation rewrite or malformed-ref report covers', () => {
  const stray = (code) => strayPageRefs(code).map((r) => r.token);
  const cases = {
    'a string': ['const label = "PAGEREF_detail";', ['PAGEREF_detail']],
    'a single-quoted string': ["const label = 'PAGEREF_detail';", ['PAGEREF_detail']],
    'template text': ['const label = `see PAGEREF_detail`;', ['PAGEREF_detail']],
    'a template expression': ['const label = `${"PAGEREF_detail"}`;', ['PAGEREF_detail']],
    'a regex literal': ['const re = /PAGEREF_detail/;', ['PAGEREF_detail']],
    'JSX text': ['const el = <p>PAGEREF_detail</p>;', ['PAGEREF_detail']],
    'a JSX attribute': ['const el = <a data-page="PAGEREF_detail" />;', ['PAGEREF_detail']],
    'a variable the call reads': [`const target = "PAGEREF_detail";\nnavigateTo({ pageType: "generative", pageId: target });`, ['PAGEREF_detail']],
    'a lookup table': ['const routes = { a: "PAGEREF_a", b: "PAGEREF_b" };', ['PAGEREF_a', 'PAGEREF_b']],
    'a helper taking the token': ['openPage("PAGEREF_detail");', ['PAGEREF_detail']],
    'a call through .call': [`navigateTo.call(null, ${OBJ})`, ['PAGEREF_detail']],
    'a call of a variable': [`const o = ${OBJ};\nnavigateTo(o);`, ['PAGEREF_detail']],
    'a call with a type assertion': [`(navigateTo as Navigate)(${OBJ})`, ['PAGEREF_detail']],
    'a nested data value': [`navigateTo({ pageType: "generative", pageId: "PAGEREF_a", data: { next: "PAGEREF_b" } })`, ['PAGEREF_b']],
    'a later runtime override': [`navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", ...options })`, ['PAGEREF_detail']],
    'a getter override': [`navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", get pageId() { return "x"; } })`, ['PAGEREF_detail']],
    'a pageType that is not a literal': [`navigateTo({ pageType: kind, pageId: "PAGEREF_detail" })`, ['PAGEREF_detail']],
    'a non-generative pageType': [`navigateTo({ pageType: "entityrecord", pageId: "PAGEREF_detail" })`, ['PAGEREF_detail']],
    'a call with no pageType': [`navigateTo({ pageId: "PAGEREF_detail" })`, ['PAGEREF_detail']],
    'the longest key characters': ['const s = "PAGEREF_pet-gallery_2";', ['PAGEREF_pet-gallery_2']],
    'two on a line, in order': ['const s = ["PAGEREF_b", "PAGEREF_a"];', ['PAGEREF_b', 'PAGEREF_a']],
    'after an escaped quote': ['const s = "say \\"hi\\" PAGEREF_x";', ['PAGEREF_x']],
    'after a CRLF continuation': ['const s = "a\\\r\nPAGEREF_x";', ['PAGEREF_x']],
  };
  for (const [what, [code, expected]] of Object.entries(cases)) assert.deepStrictEqual(stray(code), expected, what);
});

test('strayPageRefs leaves canonical targets and malformed references to their own reports, and exempts nothing else', () => {
  const stray = (code) => strayPageRefs(code).map((r) => r.token);
  assert.deepStrictEqual(stray(NAV('"PAGEREF_detail"')), [], 'a canonical target is rewritten');
  assert.deepStrictEqual(stray(NAV('"PAGEREF_a"') + NAV('"PAGEREF_b"')), []);
  assert.deepStrictEqual(stray("Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: 'PAGEREF_detail' });"), [], 'a malformed one is navMalformedRefs\' to report');
  assert.deepStrictEqual(stray(callWith('"PAGEREF_detail".slice(8)')), [], 'so is a value with a tail');
  assert.deepStrictEqual(stray('// PAGEREF_detail is resolved at deploy\n// PAGEREF_other\nconst x = 1;'), ['PAGEREF_detail', 'PAGEREF_other'], 'a comment holds no token, whatever line it starts');
  assert.deepStrictEqual(stray('/* PAGEREF_other */\nconst x = 1;'), ['PAGEREF_other'], 'nor a block comment');
  assert.deepStrictEqual(stray('const t = `${\n  // PAGEREF_inside\n  1}`;\nconst u = <div\n  // PAGEREF_attr\n/>;'), ['PAGEREF_inside', 'PAGEREF_attr'], 'nor a comment inside a template body or a JSX tag');
  assert.deepStrictEqual(stray('const prefix = "PAGEREF_";\nconst ok = "PAGEREF";\nconst a = "pageref_x";'), [], 'the token is PAGEREF_ and at least one key character');
  assert.deepStrictEqual(stray(''), []);
  assert.deepStrictEqual(stray(undefined), []);
  // A canonical target beside a decoy: only the decoy is stray.
  assert.deepStrictEqual(stray(`const decoy = "PAGEREF_decoy";\n${NAV('"PAGEREF_real"')}`), ['PAGEREF_decoy']);
});

test('strayPageRefs names each token\'s line and column, whichever line terminator the file uses', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const code = ['const a = 1;', 'const decoy = "PAGEREF_detail";', '', '  const other = [1, "PAGEREF_gallery"];'].join(eol);
    const found = strayPageRefs(code);
    assert.deepStrictEqual(found.map((r) => [r.token, r.key, r.line, r.column]), [['PAGEREF_detail', 'detail', 2, 16], ['PAGEREF_gallery', 'gallery', 4, 22]], JSON.stringify(eol));
    for (const r of found) assert.strictEqual(code.slice(r.start, r.end), r.token);
    assert.strictEqual(describePageRefLocations(found), 'PAGEREF_detail (line 2, column 16), PAGEREF_gallery (line 4, column 22)');
  }
  assert.strictEqual(describePageRefLocations([]), '');
});

test('resolvePageRefs reports the tokens that remain in each resolved source, with the source key', () => {
  const clean = resolvePageRefs(new Map([['x', { code: NAV('"PAGEREF_detail"') }]]), new Map([['detail', 'gp-detail']]));
  assert.deepStrictEqual(clean.residual, [], 'a fully resolved source leaves nothing');
  const code = `const decoy = "PAGEREF_decoy";\n${NAV('"PAGEREF_detail"')}\n(navigateTo as Nav)(${OBJ.replace('PAGEREF_detail', 'PAGEREF_viaCast')});`;
  const { deployment, residual, unresolved } = resolvePageRefs(new Map([['overview', { code }], ['other', { code: 'export default 1;' }]]), new Map([['detail', 'gp-detail']]));
  assert.deepStrictEqual(unresolved, []);
  assert.deepStrictEqual(residual.map((r) => [r.page, r.token, r.line]), [['overview', 'PAGEREF_decoy', 1], ['overview', 'PAGEREF_viaCast', 3]]);
  assert.strictEqual(deployment.get('overview').includes('"gp-detail"'), true);
  // A dangling target is left verbatim, so it is in the residue as well as in `unresolved`.
  const dangling = resolvePageRefs(new Map([['x', { code: NAV('"PAGEREF_ghost"') }]]), new Map());
  assert.deepStrictEqual(dangling.unresolved, ['ghost']);
  assert.deepStrictEqual(dangling.residual.map((r) => [r.page, r.token]), [['x', 'PAGEREF_ghost']]);
});

// ─── PAGEREF_ tokens in comments ──────────────────────────────────────────────────────────────────────────────
//
// There is no comment exemption. A comment is inert JavaScript, but the checker is a lexer and not a parser, and every rule about where
// comments are has been wrong somewhere. The `/*` inside a regex opens a false block comment (`const re = /\/*$/;`), and a line that starts
// with `//` can sit inside a template literal that holds code that runs:
//   const message = `
//   // ${navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" })}
//   `;
// A token there was exempt as "a comment on its own line" by the lexer and by the line check alike, and shipped. So a PAGEREF_<key> token is
// allowed ONLY as the double-quoted pageId literal of a navigateTo call whose options object is written inline, and nowhere else: not in a
// string, a template or a variable, and not in any comment. A comment may say what a call looks like — with no token in it.
test('a PAGEREF_ token is allowed nowhere but a navigation pageId: no comment holds one', () => {
  const where = (code) => {
    const lines = code.slice(0, code.lastIndexOf('PAGEREF_detail')).split(/\r\n|\r|\n/);
    return ['PAGEREF_detail', lines.length, lines[lines.length - 1].length + 1];
  };
  const reported = {
    'a line comment': '// PAGEREF_detail',
    'an indented line comment': '    // PAGEREF_detail',
    'a triple-slash comment': '/// PAGEREF_detail',
    'a line comment with no space': '//PAGEREF_detail',
    'a comment on the line after a statement': 'const x = 1;\n// PAGEREF_detail',
    'after CRLF': 'const x = 1;\r\n  // PAGEREF_detail',
    'after a lone CR': 'const x = 1;\r// PAGEREF_detail',
    'after a line separator': 'const x = 1;\u2028// PAGEREF_detail',
    'after a paragraph separator': 'const x = 1;\u2029  // PAGEREF_detail',
    'after a byte order mark': '\uFEFF// PAGEREF_detail',
    'after a no-break space': 'const x = 1;\n\u00A0// PAGEREF_detail',
    'on its own line inside a call': 'foo(\n  // PAGEREF_detail\n  1,\n);',
    'on its own line inside a template body': 'const t = `${\n  // PAGEREF_detail\n  1}`;',
    'on its own line inside a JSX tag': 'const u = <div\n  // PAGEREF_detail\n/>;',
    'on its own line beside a recognised call': `${NAV('"PAGEREF_detail"')}\n// PAGEREF_detail`,
    'a trailing line comment': 'const x = 1; // PAGEREF_detail',
    'a trailing block comment': 'const x = 1; /* PAGEREF_detail */',
    'a block comment on its own line': '/* PAGEREF_detail */',
    'a tabbed block comment on its own line': '\t/* PAGEREF_detail */',
    'a block comment with code after it': '/* PAGEREF_detail */ const x = 1;',
    'a doc block': '/**\n * PAGEREF_detail\n */\nconst x = 1;',
    'a block comment after a paragraph separator': 'const x = 1;\u2029  /* PAGEREF_detail */',
    'a line that starts with // inside a block comment': '/* start\n// PAGEREF_detail\n*/',
    'a line that starts with // inside a template literal': 'const t = `\n// PAGEREF_detail\n`;',
    'a line that starts with // inside a string continued over a line': 'const s = "a\\\n// PAGEREF_detail";',
    'a block comment on its own line inside a call': 'foo(\n  /* PAGEREF_detail */\n  1,\n);',
    'a block comment on its own line inside a template body': 'const t = `${\n  /* PAGEREF_detail */\n  1}`;',
    'a block comment on its own line inside a JSX tag': 'const u = <div\n  /* PAGEREF_detail */\n/>;',
    'a block comment after another on its line': '/* a */ /* PAGEREF_detail */',
    'a line comment after a comment and code': '/* a */ foo(); // PAGEREF_detail',
    'a comment inside a call': 'foo(/* PAGEREF_detail */ 1);',
    'a JSX comment': 'const u = <div>{/* PAGEREF_detail */}</div>;',
    'a trailing comment in a JSX tag': 'const u = <div // PAGEREF_detail\n/>;',
    'a comment after the opener of a template body': 'const t = `${/* PAGEREF_detail */ 1}`;',
    'a block comment that starts mid-line and runs on': 'const x = 1; /* start\n  PAGEREF_detail\n*/',
    'a trailing comment after a CRLF line': 'a;\r\nb(); // PAGEREF_detail',
    'a trailing comment after a line separator': 'a;\u2028b(); // PAGEREF_detail',
    'a trailing comment beside a recognised call': `${NAV('"PAGEREF_detail"')} // PAGEREF_detail`,
  };
  for (const [what, code] of Object.entries(reported)) {
    assert.deepStrictEqual(strayPageRefs(code).map((r) => [r.token, r.line, r.column]), [where(code)], what);
    assert.deepStrictEqual(navMalformedRefs(code), [], `${what}: a stray token, not a malformed value`);
    // The residue of a resolved page names it too, and the rewrite leaves the comment as it was.
    const { deployment, residual } = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']]));
    assert.deepStrictEqual(residual.map((r) => [r.token, r.line, r.column]), [where(deployment.get('x'))], `${what}: residue`);
  }
});

test('a comment may say what a call looks like, with no token in it, and is inert', () => {
  for (const code of [
    '// navigateTo({ pageType: "generative", pageId: "detail" });',
    '/* Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "not-a-token" }) */',
    'const t = 1; // navigateTo({ pageType: "generative", pageId: "x" })',
    'foo(/* navigateTo({ pageType: "generative", pageId: "x" }) */ 1);',
    '/** @example navigateTo({ pageType: "generative", pageId: "<key>" }) */',
    '// pageId: "PAGEREF_<key>" is replaced at deploy',
    '// a PAGEREF_ token is replaced at deploy',
    '/* PAGEREF_ */',
  ]) {
    assert.deepStrictEqual(strayPageRefs(code), [], code);
    assert.deepStrictEqual(extractNavTargets(code), [], `${code}: a call in a comment is not a call`);
    const resolved = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', 'gp-detail']]));
    assert.deepStrictEqual(resolved.residual, [], code);
    assert.strictEqual(resolved.deployment.get('x'), code, `${code}: left as it was`);
  }
});

test('PAGEREF_RULE says where a token may be, and that it may be nowhere else — a comment included', () => {
  assert.match(PAGEREF_RULE, /allowed only as the double-quoted pageId literal of a pageType:"generative" navigateTo call/);
  assert.match(PAGEREF_RULE, /the options object written inline in the call/);
  assert.match(PAGEREF_RULE, /, and nowhere else — not in a comment$/);
  assert.ok(!/starts its own line/.test(PAGEREF_RULE), 'there is no comment exemption to word');
});

// The residual net has no exemption and no lexer. After forward resolution the resolved page holds NO raw PAGEREF_ token at all, so every
// one that is left is reported — whatever the lexer believed about it, and wherever it sits: a comment, a string, a template line that starts
// with `//`, a regex, JSX text, or a call the lexer could not see.
test('the residual net: a resolved page holds no PAGEREF_ at all, and every raw token left is reported, wherever it sits', () => {
  const pages = {
    'a // comment on its own line': 'foo();\n// PAGEREF_a',
    'a block comment': '/* PAGEREF_a */',
    'a trailing comment': 'foo(); // PAGEREF_a',
    'a // line inside a template': 'const t = `\n// PAGEREF_a\n`;',
    'a string': 'const s = "PAGEREF_a";',
    'a single-quoted string': "const s = 'PAGEREF_a';",
    'a regex': 'const r = /PAGEREF_a/;',
    'JSX text': 'const e = <p>PAGEREF_a</p>;',
    'a JSX attribute': 'const e = <p title="PAGEREF_a" />;',
    'a template substitution': 'const t = `${"PAGEREF_a"}`;',
    'a call spelled a way nothing reads': 'navigateTo.call(null, { pageType: "generative", pageId: "PAGEREF_a" });',
    'a call the lexer cannot see': `${OBJECT_DIVISION}\n${DETAIL_CALL.replace('detail', 'a')}`,
    'a line separator inside a comment': '// x\u2028PAGEREF_a',
    'text with no lexical context at all': 'PAGEREF_a ) ] } ` " \' /*',
  };
  for (const [what, code] of Object.entries(pages)) {
    const { deployment, residual } = resolveOne(code, [['a', 'gp-a']]);
    const text = deployment.get('x');
    const raw = [...text.matchAll(/PAGEREF_[A-Za-z0-9_-]+/g)].map((m) => [m[0], m.index]);
    assert.ok(raw.length > 0, `${what}: a token is left`);
    assert.deepStrictEqual(residual.map((r) => [r.token, r.start]), raw, `${what}: every raw token left is in the residue`);
    for (const r of residual) assert.strictEqual(text.slice(r.start, r.end), r.token, what);
  }
  // A page the rewrite did reach leaves nothing; the token in a recognised call goes, and any other stays and is reported.
  const both = resolveOne(`${NAV('"PAGEREF_a"')}\n// PAGEREF_a is the link`, [['a', 'gp-a']]);
  assert.deepStrictEqual(both.residual.map((r) => [r.token, r.line]), [['PAGEREF_a', 2]], 'the call is rewritten, the comment is not exempt');
  assert.deepStrictEqual(resolveOne(NAV('"PAGEREF_a"'), [['a', 'gp-a']]).residual, []);
});

test('there is no exemption to disagree about: the lexer\'s comment ranges play no part in what counts', () => {
  // A token a comment range seems to cover counts all the same, because nothing reads comment ranges for it any more.
  for (const code of ['// PAGEREF_detail', '/* PAGEREF_detail */', '/*\n// PAGEREF_detail\n*/', 'x; // PAGEREF_detail', 'const re = /\\/*$/;\n// PAGEREF_detail\n/* c */']) {
    assert.deepStrictEqual(strayPageRefs(code).map((r) => r.token), ['PAGEREF_detail'], JSON.stringify(code));
  }
});

// ─── The trust frontier ───────────────────────────────────────────────────────────────────────────────────────
//
// The lexer decides some things by guess: whether a `/` is a regex or a division, whether a `<` opens an element, how a JSX tag with type
// arguments is scanned (source-literals.js, `onAmbiguity`). Where a guess is wrong it blanks real code, or reads text as code, and from there
// on the mask is not what the page means. Nothing short of a parser can tell, so the navigation reader takes the EARLIEST such offset as a
// FRONTIER and does not trust a PAGEREF_ token at or after it: every raw occurrence from there on is reported — whether or not a call
// accounts for it, in a comment or not — naming the frontier's kind and position, is never rewritten, and is left as an id by reverse
// resolution. The page is refused rather than half resolved.
test('a PAGEREF_ token at or after the frontier is stray, naming the frontier, and nothing there is rewritten', () => {
  const code = `${OBJECT_DIVISION}\n${DETAIL_CALL}\n`;
  const slashColumn = OBJECT_DIVISION.indexOf('}/') + 2;
  const tokenColumn = DETAIL_CALL.indexOf('PAGEREF_') + 1;
  const found = strayPageRefs(code);
  assert.deepStrictEqual(
    found.map((r) => [r.token, r.line, r.column, r.frontier.kind, r.frontier.start, r.frontier.line, r.frontier.column]),
    [['PAGEREF_detail', 2, tokenColumn, 'brace', code.indexOf('}/') + 1, 1, slashColumn]],
  );
  assert.strictEqual(code[found[0].frontier.start], '/');
  assert.strictEqual(describePageRefLocations(found), `PAGEREF_detail (line 2, column ${tokenColumn}, after the "brace" ambiguity at line 1, column ${slashColumn})`);
  // The oracle still recognises the call, so parity and the key list are as they were: it is the report that refuses the page.
  assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']]);
  assert.deepStrictEqual(navReferencedKeys(code), ['detail']);
  const { deployment, residual, unresolved } = resolveOne(code);
  assert.strictEqual(deployment.get('x'), code, 'never rewritten');
  assert.deepStrictEqual(unresolved, []);
  assert.deepStrictEqual(residual.map((r) => [r.page, r.token, r.line, r.frontier.kind, r.frontier.line, r.frontier.column]), [['x', 'PAGEREF_detail', 2, 'brace', 1, slashColumn]]);
});

test('only what lies at or after the earliest frontier is distrusted, and the earliest is the one named', () => {
  // Before it: resolved, and nothing reported.
  const before = `${DETAIL_CALL}\n${OBJECT_DIVISION}\n`;
  assert.deepStrictEqual(strayPageRefs(before), []);
  assert.strictEqual(resolveOne(before).deployment.get('x'), before.replace('"PAGEREF_detail"', '"gp-detail"'));
  // A call on each side: the one before is resolved, the one after is left as it was and reported.
  const both = `${DETAIL_CALL}\n${OBJECT_DIVISION}\n${DETAIL_CALL.replace('detail', 'other')}\n`;
  const resolved = resolveOne(both);
  assert.deepStrictEqual(resolved.residual.map((t) => [t.token, t.line]), [['PAGEREF_other', 3]]);
  assert.strictEqual(resolved.deployment.get('x'), both.replace('"PAGEREF_detail"', '"gp-detail"'));
  // Whatever the lexer takes a raw occurrence for after it: an own-line comment, a string, a regex, JSX text.
  for (const after of ['// PAGEREF_detail', '/* PAGEREF_detail */', 'const s = "PAGEREF_detail";', 'const re = /PAGEREF_detail/;', 'const el = <p>PAGEREF_detail</p>;']) {
    assert.deepStrictEqual(strayPageRefs(`${OBJECT_DIVISION}\n${after}\n`).map((r) => r.token), ['PAGEREF_detail'], after);
  }
  // However many frontiers follow, every report names the first.
  const twice = `${OBJECT_DIVISION}\n${DETAIL_CALL}\n${OBJECT_DIVISION}\n${DETAIL_CALL.replace('detail', 'other')}\n`;
  assert.deepStrictEqual(strayPageRefs(twice).map((r) => [r.token, r.frontier.kind, r.frontier.line]), [['PAGEREF_detail', 'brace', 1], ['PAGEREF_other', 'brace', 1]]);
  // The earliest by OFFSET, not the first kind found or the commonest one.
  const keywordFirst = `const of = 12; const count = of/2; const re = /x/;\n${OBJECT_DIVISION}\n${DETAIL_CALL}\n`;
  assert.deepStrictEqual(strayPageRefs(keywordFirst).map((r) => [r.frontier.kind, r.frontier.line]), [['keyword', 1]]);
  const braceFirst = `${OBJECT_DIVISION}\nconst of = 12; const count = of/2; const re = /x/;\n${DETAIL_CALL}\n`;
  assert.deepStrictEqual(strayPageRefs(braceFirst).map((r) => [r.frontier.kind, r.frontier.line]), [['brace', 1]]);
});

// One snippet per kind the lexer reports: a call after it is stray, naming the kind. Each is the smallest raw example of what makes the
// reading a guess (see the table at the top of source-literals.js).
const FRONTIER_SNIPPETS = {
  brace: OBJECT_DIVISION,
  paren: `if (true /*${'x'.repeat(2100)}*/) /abc/.test(text);`,
  keyword: 'const of = 12; const count = of/2; const re = /x/;',
  angle: 'const half = total as Types . Alias<number> / 2; const re = /x/;',
  identifier: 'var Al\\u0069as = 12;',
  operator: 'const m = [.../a/.exec("a")]; const n = /b/;',
  // The guess is on the line after the operand, so it is the last line of the snippet.
  newline: 'type Value = number\n/abc/.test(text);',
  generic: 'const a = <span>(a): Title</span>;',
  'jsx-type-arguments': 'const a = <Foo<"a"> b={1} />;',
  // TypeScript reads `'\'/>;const b = 1;//'` as one string, the other compilers end it at the second quote and find a closing `/>` after it.
  'jsx-attribute': "const a = <C x= '\\'/>;const b = 1;//' />;",
  'jsx-open': 'const a = < div>x</div>;',
  fallback: "const a = 'unterminated",
};

test('every kind of ambiguity makes a call after it stray, naming the kind, and nothing there is rewritten', () => {
  assert.deepStrictEqual(Object.keys(FRONTIER_SNIPPETS).sort(), [...AMBIGUITY_KINDS].sort(), 'a snippet for every kind the lexer reports');
  for (const [kind, snippet] of Object.entries(FRONTIER_SNIPPETS)) {
    const guessLine = snippet.split('\n').length;
    const code = `${snippet}\n${DETAIL_CALL}\n`;
    const found = strayPageRefs(code);
    assert.deepStrictEqual(found.map((r) => [r.token, r.line, r.frontier.kind, r.frontier.line]), [['PAGEREF_detail', guessLine + 1, kind, guessLine]], kind);
    assert.match(describePageRefLocations(found), new RegExp(`^PAGEREF_detail \\(line ${guessLine + 1}, column \\d+, after the "${kind}" ambiguity at line ${guessLine}, column \\d+\\)$`), kind);
    const resolved = resolveOne(code);
    assert.strictEqual(resolved.deployment.get('x'), code, `${kind}: never rewritten`);
    assert.deepStrictEqual(resolved.residual.map((r) => [r.token, r.frontier.kind]), [['PAGEREF_detail', kind]], `${kind}: the residue names it too`);
    // A call BEFORE the frontier is resolved as ever.
    const earlier = `${DETAIL_CALL}\n${code}`;
    assert.deepStrictEqual(strayPageRefs(earlier).map((r) => [r.line, r.frontier.kind]), [[earlier.split('\n').length - 1, kind]], `${kind}: only the later call is stray`);
    assert.strictEqual(resolveOne(earlier).deployment.get('x'), earlier.replace('"PAGEREF_detail"', '"gp-detail"'), `${kind}: the earlier call is resolved`);
  }
});

test('certain code is no frontier: a call after it resolves', () => {
  for (const snippet of [
    'const half = total / 2; const re = /x/;',
    'const count = ({valueOf(){return 12;}}) / 2; const half = total / 2;',
    'const n = {a: 1}/2;',
    'if (ok) { go(); };\n/abc/.test(text);',
    'if (ok) { go(); }\n(/abc/).test(text);',
    'if (x) /re/.test(y);',
    'const a = <DataGridBody<Account>>{x}</DataGridBody>;',
    'const a = <p>{x}/{y}</p>;',
    'const f = () => /x/.test(s);',
    'const a = i++ / 2 / 3;',
    'const s = "\\u0069 and a \\\\ backslash";',
    'const t = `\\u0069`;',
    'a.of / 2 / 3; a.type / 2 / 3;',
    'const f = <T,>(x: T) => x;',
  ]) {
    const code = `${snippet}\n${DETAIL_CALL}\n`;
    assert.deepStrictEqual(strayPageRefs(code), [], JSON.stringify(snippet));
    assert.strictEqual(resolveOne(code).deployment.get('x'), `${snippet}\n${DETAIL_CALL.replace('"PAGEREF_detail"', '"gp-detail"')}\n`, JSON.stringify(snippet));
  }
});

test('a navigation target at or after the frontier says so, and one before it does not', () => {
  const before = extractNavTargets(`${DETAIL_CALL}\n${OBJECT_DIVISION}\n`);
  assert.deepStrictEqual(before.map((t) => 'afterFrontier' in t), [false], 'only when true');
  assert.deepStrictEqual(extractNavTargets(`${DETAIL_CALL}\n`).map((t) => 'afterFrontier' in t), [false], 'no frontier at all');
  const kinds = extractNavTargets([OBJECT_DIVISION, NAV('"PAGEREF_a"'), NAV("'PAGEREF_b'"), NAV('"gp-literal"'), NAV('someVariable')].join('\n'));
  assert.deepStrictEqual(kinds.map((t) => [t.kind, t.afterFrontier]), [['pageref', true], ['pageref-malformed', true], ['literal', true], ['dynamic', true]]);
  // A call that begins before the frontier but whose pageId lies after it is after it. (`type/2` is read as a division here, the lexer
  // reads on as code, and a later `/` on the line is what makes it a guess: it could have been a regex.)
  const spanning = 'navigateTo({ pageType: "generative", data: type/2, pageId: "PAGEREF_detail" }); const re = /x/;';
  assert.deepStrictEqual(extractNavTargets(spanning).map((t) => [t.kind, t.afterFrontier]), [['pageref', true]]);
  assert.deepStrictEqual(strayPageRefs(spanning).map((r) => r.frontier.kind), ['keyword']);
  assert.strictEqual(resolveOne(spanning).deployment.get('x'), spanning);
});

test('a "/" after a "}" is a frontier wherever the lexer reads it as a regex: after a block, and in a template body', () => {
  const afterBlock = `if (ok) { go(); }\n/abc/.test(text);\n${DETAIL_CALL}\n`;
  assert.deepStrictEqual(strayPageRefs(afterBlock).map((r) => [r.token, r.line, r.frontier.kind, r.frontier.line, r.frontier.column]), [['PAGEREF_detail', 3, 'brace', 2, 1]]);
  const inBody = 'const s = `${ {a:1}/2; /x/ }`;\n' + `${DETAIL_CALL}\n`;
  assert.deepStrictEqual(strayPageRefs(inBody).map((r) => [r.token, r.line, r.frontier.kind, r.frontier.line]), [['PAGEREF_detail', 2, 'brace', 1]]);
});

test('a "/" that is read as a division, or follows no "}", or has no token after it, is not a frontier', () => {
  for (const code of [
    // No second `/` on the line, so it is not read as a regex at all.
    `const n = {a: 1}/2;\n${DETAIL_CALL}\n`,
    `const half = total / 2; const re = /x/;\n${DETAIL_CALL}\n`,
    `const a = <p>{x}/{y}</p>;\n${DETAIL_CALL}\n`,
    // The `/` is there, and nothing that matters follows.
    `${OBJECT_DIVISION}\n`,
    `${OBJECT_DIVISION}\nconst x = 1;\n`,
    // The ways out: parentheses make the `/` follow a `)` or a `(`, and a `;` ends the block.
    `const count = ({valueOf(){return 12;}}) / 2; const half = total / 2;\n${DETAIL_CALL}\n`,
    `if (ok) { go(); }\n(/abc/).test(text);\n${DETAIL_CALL}\n`,
    `if (ok) { go(); };\n/abc/.test(text);\n${DETAIL_CALL}\n`,
  ]) {
    assert.deepStrictEqual(strayPageRefs(code), [], JSON.stringify(code));
  }
});

// The misread pages (tests/helpers/misread-page.js): JavaScript makes every call, and each is a way the lexer hid one, or read text as
// code. The oracle sees fewer calls than there are, so parity passes — and the token in the others must not ship.
test('the page whose "/" after an object literal hid a call is refused, naming the call and the "/"', () => {
  assert.deepStrictEqual(extractNavTargets(OBJECT_DIVISION_PAGE).map((t) => t.kind), ['pageref'], 'the lexer sees one call');
  const found = strayPageRefs(OBJECT_DIVISION_PAGE);
  assert.deepStrictEqual(found.map((r) => [r.token, r.line, r.frontier.kind, r.frontier.line]), [['PAGEREF_detail', 5, 'brace', 4]]);
  const lines = OBJECT_DIVISION_PAGE.split('\n');
  assert.strictEqual(found[0].column, lines[4].indexOf('PAGEREF_') + 1);
  assert.strictEqual(found[0].frontier.column, lines[3].indexOf('}/') + 2);
  const { deployment, residual } = resolveOne(OBJECT_DIVISION_PAGE);
  assert.deepStrictEqual(residual.map((r) => [r.token, r.line, r.frontier.kind, r.frontier.line]), [['PAGEREF_detail', 5, 'brace', 4]], 'the residue names the call the lexer could not see');
  assert.strictEqual(deployment.get('x').split('"PAGEREF_detail"').length - 1, 1, 'one call is resolved and one is not: a half-resolved page, which the report refuses');
});

test('each misread page is refused at its first guess: every token at or after it, or in a call that reaches it, is stray, and nothing there is rewritten', () => {
  assert.deepStrictEqual(Object.keys(MISREAD_PAGES), [
    'brace', 'paren', 'keyword', 'identifier', 'angle', 'jsx-type-arguments', 'newline', 'generic', 'generic, in JSX text', 'generic, in a nested element',
    'generic, in a nested element, with white space beyond ASCII before an attribute value', 'generic, with await', 'generic, with yield', 'operator, after ">="',
    'operator, after ">>=" that ends type arguments', 'operator, after ">>>=" that ends nested type arguments', 'operator, after ">>=" that ends the type arguments of satisfies', 'jsx-attribute',
    'inside an options object',
  ]);
  for (const [name, { kind, frontier, code, reaching }] of Object.entries(MISREAD_PAGES)) {
    const at = frontier(code);
    const tokenOffsets = [...code.matchAll(/PAGEREF_detail/g)].map((m) => m.index);
    // A call that reaches the frontier is untrusted with the token it holds, wherever in the call the token lies.
    const expected = tokenOffsets.filter((offset, i) => offset >= at || (reaching && i === 0));
    assert.ok(expected.length > 0, `${name}: a token is refused`);
    const found = strayPageRefs(code);
    assert.deepStrictEqual(found.map((r) => r.start), expected, `${name}: exactly the tokens the checker does not trust`);
    for (const r of found) assert.deepStrictEqual([r.frontier.kind, r.frontier.start, r.frontier.line, r.frontier.column], [kind, at, positionOf(code, at).line, positionOf(code, at).column], name);
    for (const t of extractNavTargets(code)) assert.strictEqual(Boolean(t.afterFrontier), Boolean(reaching) || t.valueStart >= at, `${name}: a target says whether it reaches the frontier`);
    assert.deepStrictEqual(navMalformedRefs(code), [], `${name}: stray, not malformed`);
    const { deployment, residual, unresolved } = resolveOne(code);
    assert.strictEqual(deployment.get('x'), reaching ? code : code.slice(0, at).replace('"PAGEREF_detail"', '"gp-detail"') + code.slice(at), `${name}: only what the checker trusts is rewritten`);
    assert.deepStrictEqual(unresolved, [], name);
    assert.deepStrictEqual(residual.map((r) => r.line), found.map((r) => r.line), `${name}: the residue is the same tokens`);
    if (!reaching) assert.ok(residual.every((r) => r.frontier.kind === kind && r.frontier.line === positionOf(code, at).line), `${name}: and names the same frontier`);
  }
});

// ─── A call is trusted only if all of it lies before the frontier ─────────────────────────────────────────────
//
// What a call means is read from its whole options object, from the open brace to the close brace the lexer found: the members after the
// `pageId` can make `pageType` something else (a getter, a computed key, a spread) or replace the `pageId`. So a call is trusted only when
// ALL of it — the object, and the call that holds it — lies before the first place the lexer guessed. Deciding it by where the pageId lies
// rewrote a call whose object ran through a guess, whose later members the guess hid:
//   navigateTo({ pageType: "generative", pageId: "PAGEREF_detail",
//     data: {valueOf(){return 12;}, ...extras}/2, r: /\/*$/,
//     get [typeKey]() { return flag ? "generative" : "entityrecord"; }
//     /* regular comment */ });
test('a call whose options object reaches the frontier is untrusted: refused and never rewritten, though its pageId lies before it', () => {
  const page = MISREAD_PAGES['inside an options object'];
  const at = page.frontier(page.code);
  const [target] = extractNavTargets(page.code);
  assert.deepStrictEqual([target.kind, target.key, target.valueStart < at, target.afterFrontier], ['pageref', 'detail', true, true], 'the pageId lies before the frontier, but its call reaches it');
  const found = strayPageRefs(page.code);
  assert.deepStrictEqual(found.map((r) => [r.token, r.line, r.frontier.kind, r.frontier.reaches, r.frontier.line]), [['PAGEREF_detail', 3, 'brace', true, 4]]);
  assert.match(describePageRefLocations(found), /^PAGEREF_detail \(line 3, column \d+, in a call that reaches the "brace" ambiguity at line 4, column \d+\)$/);
  assert.match(pageRefAdvice(found), /does not trust a navigation call that reaches it/);
  const { deployment, residual } = resolveOne(page.code);
  assert.strictEqual(deployment.get('x'), page.code, 'never rewritten');
  assert.deepStrictEqual(residual.map((r) => [r.token, r.line]), [['PAGEREF_detail', 3]]);
  // At run time the getter makes this call something else, which is why a rewrite of it was wrong.
  const calls = [];
  vm.runInNewContext(runnable(page.code), { navigateTo: (options) => calls.push([options.pageType, options.pageId]) });
  assert.deepStrictEqual(calls, [['entityrecord', 'PAGEREF_detail']]);
});

test('a call that ends before the frontier is trusted and one that reaches it is not, side by side and nested', () => {
  const ids = [['inner', 'gp-inner'], ['outer', 'gp-outer'], ['before', 'gp-before'], ['after', 'gp-after']];
  const call = (key, extra = '') => `navigateTo({ pageType: "generative", pageId: "PAGEREF_${key}"${extra} });`;
  // `type/2` is read as a division, and the second "/" on the line could have made it a regex: the lexer reports the guess and reads on, so
  // the brackets after it still match and the call is recognised.
  const guess = ', data: type/2';
  const rest = ' const re = /x/;\n';
  // Side by side: the first call is closed before the guess in the second one's options object.
  const side = `${call('before')}\n${call('after', guess)}${rest}`;
  assert.deepStrictEqual(extractNavTargets(side).map((t) => [t.key, Boolean(t.afterFrontier)]), [['before', false], ['after', true]]);
  assert.deepStrictEqual(strayPageRefs(side).map((r) => [r.token, r.frontier.reaches]), [['PAGEREF_after', true]]);
  assert.strictEqual(resolveOne(side, ids).deployment.get('x'), side.replace('"PAGEREF_before"', '"gp-before"'));
  // Nested: the inner call is closed before the guess, the outer one's object runs through it. The inner one is trusted and resolved; the
  // outer one — whose pageId is earlier still — is not.
  const nested = `navigateTo({ pageType: "generative", pageId: "PAGEREF_outer", data: ${call('inner').replace(/;$/, '')}, more: type/2 });${rest}`;
  assert.deepStrictEqual(extractNavTargets(nested).map((t) => [t.key, Boolean(t.afterFrontier)]), [['outer', true], ['inner', false]]);
  assert.deepStrictEqual(strayPageRefs(nested).map((r) => [r.token, r.frontier.reaches]), [['PAGEREF_outer', true]]);
  assert.strictEqual(resolveOne(nested, ids).deployment.get('x'), nested.replace('"PAGEREF_inner"', '"gp-inner"'));
  // Closed before the guess, a call is as trusted as it was: a guess after it changes nothing about it.
  const closed = `${call('before')}\n${OBJECT_DIVISION}\n`;
  assert.deepStrictEqual(strayPageRefs(closed), []);
  assert.strictEqual(resolveOne(closed, ids).deployment.get('x'), closed.replace('"PAGEREF_before"', '"gp-before"'));
  // The call's own parentheses count, not only its object: a guess between the object and the `)` is in the call.
  const tail = `navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" }, type/2);${rest}`;
  assert.deepStrictEqual(extractNavTargets(tail).map((t) => [t.key, Boolean(t.afterFrontier)]), [['detail', true]]);
  assert.deepStrictEqual(strayPageRefs(tail).map((r) => [r.token, r.frontier.reaches]), [['PAGEREF_detail', true]]);
  assert.strictEqual(resolveOne(tail).deployment.get('x'), tail);
});

// ─── Pages the lexer reads RIGHT after a line break: ASI and the restricted productions ──────────────────────────
//
// After a line break a `!` is a prefix operator and a `++` is a prefix increment (ECMA-262 §12.10.1; TypeScript's parseMemberExpressionRest and
// parseUpdateExpression), so the `/` after either is a regex. Neither page involves a guess, so what the reader does with each is exact: the
// text in a regex is never a call, and a call in a template substitution — on a line that starts with `//` or not — is.
test('a "++" on the line after its operand is a prefix increment: the regex after it holds text, which is stray with no guess named, and never rewritten', () => {
  const code = PREFIX_INCREMENT_PAGE;
  assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']], 'one real call; the regex is not a call');
  assert.strictEqual(navigationFrontier(code), null, 'no guess is involved');
  const found = strayPageRefs(code);
  assert.deepStrictEqual(found.map((r) => [r.token, r.line, 'frontier' in r]), [['PAGEREF_detail', 6, false]]);
  assert.strictEqual(found[0].column, code.split('\n')[5].indexOf('PAGEREF_') + 1);
  assert.strictEqual(pageRefAdvice(found), `${PAGEREF_RULE}; remove it or move it there`);
  const { deployment, residual } = resolveOne(code);
  assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'), 'only the real call is rewritten; the regex is as written');
  assert.deepStrictEqual(residual.map((r) => [r.token, r.line]), [['PAGEREF_detail', 6]]);
});

test('a template line that starts with // and holds a call is code, read right: the call is rewritten and the page does what it did', () => {
  const code = TEMPLATE_LINE_PAGE;
  assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']]);
  assert.strictEqual(navigationFrontier(code), null);
  assert.deepStrictEqual(strayPageRefs(code), []);
  const { deployment, residual } = resolveOne(code);
  assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'));
  assert.deepStrictEqual(residual, []);
  const calls = (source) => {
    const found = [];
    vm.runInNewContext(runnable(source), { navigateTo: (options) => found.push(options.pageId) });
    return found;
  };
  assert.deepStrictEqual(calls(code), ['PAGEREF_detail'], 'the page navigates from its template');
  assert.deepStrictEqual(calls(deployment.get('x')), ['gp-detail'], 'and does the same once resolved');
  // The same line with the token as template TEXT, outside the `${}`, is data that ships: stray, whatever starts the line.
  const text = code.replace('${navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})}', 'PAGEREF_detail');
  assert.notStrictEqual(text, code);
  assert.deepStrictEqual(strayPageRefs(text).map((r) => [r.token, r.line]), [['PAGEREF_detail', 6]]);
});

// An element is told from a generic arrow's type parameters by TypeScript's own rule (source-literals.js, opensTypeParameters): `<div …>` is an
// element, so `(a): Title` is text, and the regex after the later arrow is data. The page of the report took the text for parameters.
test('JSX text that looks like parameters is text: the regex after the next arrow is data, its token is stray with no guess named, and nothing there is rewritten', () => {
  const code = JSX_TEXT_PAGE;
  assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']], 'one real call; the regex is not a call');
  assert.strictEqual(navigationFrontier(code), null, 'no guess is involved');
  const found = strayPageRefs(code);
  assert.deepStrictEqual(found.map((r) => [r.token, r.line, 'frontier' in r]), [['PAGEREF_detail', 5, false]]);
  assert.strictEqual(found[0].column, code.split('\n')[4].indexOf('PAGEREF_') + 1);
  const { deployment, residual } = resolveOne(code);
  assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'), 'only the real call is rewritten; the regex is as written');
  assert.deepStrictEqual(residual.map((r) => [r.token, r.line]), [['PAGEREF_detail', 5]]);
  // The page after a generic arrow and a generic function type reads the same: calls after them are calls.
  const generic = 'const id = <T,>(x: T) => x;\ntype Fn = <T>(x: T) => T;\n' + `${DETAIL_CALL}\n`;
  assert.strictEqual(navigationFrontier(generic), null);
  assert.deepStrictEqual(strayPageRefs(generic), []);
  assert.strictEqual(resolveOne(generic).deployment.get('x'), generic.replace('"PAGEREF_detail"', '"gp-detail"'));
});

// TypeScript asks the arrow question only where an assignment expression starts. After a unary or binary operator — `a === <T extends X>text</T>`, `typeof <…>`,
// `a <= <…>`, `a << <…>`, `void <…>` — a `<` and a name begin an element whatever follows the name, so the regex after it is data, and the lexer reads that right:
// the token in it is stray with no guess named, and never rewritten. (A lexer that applied the rule there read `T extends X` as type parameters, the element's
// text and the regex after it as code, and rewrote the token.)
test('a "<" after a unary or binary operator opens an element whatever follows its name: the regex after it is data, its token stray with no guess named, and never rewritten', () => {
  assert.strictEqual(ELEMENT_AFTER_OPERATOR_PAGES.length, 17);
  for (const { name, code } of ELEMENT_AFTER_OPERATOR_PAGES) {
    assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']], `${name}: one real call; the regex is not a call`);
    assert.strictEqual(navigationFrontier(code), null, `${name}: no guess is involved`);
    const found = strayPageRefs(code);
    assert.deepStrictEqual(found.map((r) => [r.token, r.line, 'frontier' in r]), [['PAGEREF_detail', ELEMENT_PAGE_TOKEN_LINE, false]], name);
    assert.strictEqual(found[0].column, code.split('\n')[ELEMENT_PAGE_TOKEN_LINE - 1].indexOf('PAGEREF_') + 1, name);
    assert.strictEqual(pageRefAdvice(found), `${PAGEREF_RULE}; remove it or move it there`, name);
    const { deployment, residual } = resolveOne(code);
    assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'), `${name}: only the real call is rewritten; the regex is as written`);
    assert.deepStrictEqual(residual.map((r) => [r.token, r.line]), [['PAGEREF_detail', ELEMENT_PAGE_TOKEN_LINE]], name);
  }
});

// Where the arrow rule alone cannot settle a `<`, the lexer reads the element and says it is guessing, and nothing after the `<` is trusted: a `<Name>` and a
// parameter list and an arrow that holds a `<` or `{` (the arrow may be in a nested element), `<await …>` and `<yield …>` (an identifier or
// not, by the function around them), and a `<` after the cut `>=` whose head has a constraint and a parameter list that a `:` follows (a comparison and an element whose text
// starts with a parenthesis, or the end of type arguments and an initialiser that is an arrow with a return type).
// In each page the regex after the element holds a token, and so does a real call after it: both are refused, naming the guess, and neither is rewritten.
test('a "<" the arrow rule cannot settle is a guess that names itself: the regex after it keeps its token and no call after it is rewritten', () => {
  for (const [name, kind] of [
    ['generic, in a nested element', 'generic'], ['generic, with await', 'generic'], ['generic, with yield', 'generic'],
    ['operator, after ">="', 'operator'], ['operator, after ">>=" that ends type arguments', 'operator'], ['operator, after ">>>=" that ends nested type arguments', 'operator'],
    ['operator, after ">>=" that ends the type arguments of satisfies', 'operator'],
  ]) {
    const { frontier, code } = MISREAD_PAGES[name];
    const at = frontier(code);
    assert.deepStrictEqual(navigationFrontier(code), { start: at, kind, ...positionOf(code, at) }, name);
    const found = strayPageRefs(code);
    assert.deepStrictEqual(found.map((r) => [r.token, r.frontier.kind, r.frontier.start]), [['PAGEREF_detail', kind, at], ['PAGEREF_detail', kind, at]], `${name}: the token in the regex and the real call after it`);
    assert.match(describePageRefLocations(found), new RegExp(`after the "${kind}" ambiguity at line ${positionOf(code, at).line}, column ${positionOf(code, at).column}\\)`), name);
    const { deployment, residual } = resolveOne(code);
    assert.strictEqual(deployment.get('x').split('PAGEREF_detail').length - 1, 2, `${name}: both tokens at or after the guess are left as written`);
    assert.strictEqual(deployment.get('x').split('gp-detail').length - 1, 1, `${name}: the call before the guess is resolved`);
    assert.strictEqual(residual.length, 2, name);
    assert.deepStrictEqual(navMalformedRefs(code), [], `${name}: stray, not malformed`);
  }
});

// A `>` in JSX text does not compile (TS1382), so `<Name>(…) =>` is never an element in a page that compiles: it is a generic function type, certain
// wherever it stands (source-literals.js, genericFunctionTypeFollows), and a call after it is a call. A `:` after the parameter list is both a call
// signature and JSX text, and only a parser can tell which, so that is the `generic` guess: the element is read, and nothing after the `<` is trusted.
test('a generic function type is a type wherever it stands: a call after it is accepted and resolved', () => {
  for (const [what, type] of [
    ['directly after the head of a type alias', 'type F = <T>(x: T) => T;'],
    ['an annotation', 'const a: <T>(x: T) => T = f;'],
    ['an interface member', 'interface P { onPick: <K>(key: K) => void; }'],
    ['a parameter type', 'function g(cb: <U>(x: U) => void) {}'],
    ['the right side of an alias with type parameters', 'type H<A> = <T>(x: T) => T;'],
    ['a class property', 'class C { handler: <T>(x: T) => void = f; }'],
    ['a member of a type literal', 'let m: { cb: <T>(x: T) => void };'],
    ['with a constraint and a default', 'type H<A, B = A> = <T extends A>(x: T) => B;'],
    ['with const', 'const a: <const T>(x: T) => T = f;'],
  ]) {
    const code = `${type}\n${DETAIL_CALL}\n`;
    assert.strictEqual(navigationFrontier(code), null, `${what}: no guess is involved`);
    assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key, 'afterFrontier' in t]), [['pageref', 'detail', false]], what);
    assert.deepStrictEqual(strayPageRefs(code), [], what);
    const { deployment, unresolved, residual } = resolveOne(code);
    assert.strictEqual(deployment.get('x'), `${type}\n${DETAIL_CALL.replace('"PAGEREF_detail"', '"gp-detail"')}\n`, `${what}: resolved`);
    assert.deepStrictEqual([unresolved, residual], [[], []], what);
  }
});

// A generic function type whose parameter list holds a type argument (`Array<T>`), an object type (`{ label: T }`) or a comma between type arguments (`Record<string, T>`)
// compiles, and no element does: TypeScript reports a parse error for the element reading of each (TS1382, TS1005, TS1003). A rule that asked only whether a `<` or `{` stood
// between the `>` of `<Name>` and the arrow took each for a guess, and every page that held one was refused as truncated, with a guess named at the `<`. Each is a type, for certain:
// the page is read as it is, a call after the declaration is accepted and resolved, and no guess is involved.
test('a generic function type with a type argument or an object type in its parameter list is a type: a call after it is accepted and resolved, with no guess named', () => {
  assert.strictEqual(FUNCTION_TYPE_PAGES.length, 12);
  for (const { name, code } of FUNCTION_TYPE_PAGES) {
    assert.strictEqual(navigationFrontier(code), null, `${name}: no guess is involved`);
    assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key, 'afterFrontier' in t]), [['pageref', 'detail', false]], name);
    assert.deepStrictEqual(strayPageRefs(code), [], name);
    assert.deepStrictEqual(navMalformedRefs(code), [], name);
    assert.strictEqual(code.split('\n')[FUNCTION_TYPE_CALL_LINE - 1].includes('PAGEREF_detail'), true, `${name}: the call is where the fixture says`);
    const { deployment, unresolved, residual } = resolveOne(code);
    assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'), `${name}: resolved`);
    assert.deepStrictEqual([unresolved, residual], [[], []], name);
  }
});

// A generic function type whose parameter list holds what the element reading cannot be shown to reject — an optional or generic quoted method, a call signature with an object type in
// it, a comment after a member — is still a valid type, and is read as one: the guess `generic` is reported at its `<`, so the page is complete to the structure
// gate (it was read as an element whose text ran on, and refused as truncated), a call after it is refused and never rewritten, naming the kind, and a call before it is trusted as
// ever. (A call signature, a computed method, an optional method, a quoted method, a destructured parameter, an index signature, a readonly member, a number key, a default value and an
// empty object type are decided: a container with nothing in it that could hide a `}` is skipped, and a quoted name that a call or a colon follows fails, so they are types for certain,
// as the test above shows.)
test('a generic function type the element reading cannot rule out is a guess read as a type: the page is complete, and only a call after it is refused', () => {
  for (const type of [
    "let m: <T>(x: { 'a'?(y: T): T }) => T;", 'let m: <T>(x: { (y: { a: T }): T }) => T;', 'let m: <T>(x: { "a"<U>(y: T): T }) => T;',
  ]) {
    const after = `${type}\n${DETAIL_CALL}\n`;
    const at = after.indexOf('<T>');
    assert.deepStrictEqual(navigationFrontier(after), { start: at, kind: 'generic', ...positionOf(after, at) }, type);
    assert.deepStrictEqual(pageStructureProblems(`${after}export default function Page() { return null; }\n`), [], `${type}: the page is complete`);
    assert.deepStrictEqual(extractNavTargets(after).map((t) => [t.kind, t.key, t.afterFrontier]), [['pageref', 'detail', true]], `${type}: the call is seen, after the guess`);
    const found = strayPageRefs(after);
    assert.deepStrictEqual(found.map((r) => [r.token, r.line, r.frontier.kind]), [['PAGEREF_detail', 2, 'generic']], type);
    assert.strictEqual(resolveOne(after).deployment.get('x'), after, `${type}: never rewritten`);
    // Put before it, the call is as trusted as any.
    const before = `${DETAIL_CALL}\n${type}\n`;
    assert.deepStrictEqual(strayPageRefs(before), [], type);
    assert.strictEqual(resolveOne(before).deployment.get('x'), before.replace('"PAGEREF_detail"', '"gp-detail"'), type);
  }
});

// JSX that holds what looks like a function type's parameter list compiles as an element (an expression container that holds an arrow; a container, and a colon in the
// text after it): the lexer reads it right, so the regex after it is data, its token is stray with no guess named, and it is never rewritten; the real call before it is.
test('an element whose text looks like a parameter list is read right: the regex after it is data, its token stray with no guess named, and never rewritten', () => {
  assert.strictEqual(ELEMENT_LOOKALIKE_PAGES.length, 6);
  for (const { name, code } of ELEMENT_LOOKALIKE_PAGES) {
    assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']], `${name}: one real call; the regex is not a call`);
    assert.strictEqual(navigationFrontier(code), null, `${name}: no guess is involved`);
    const found = strayPageRefs(code);
    assert.deepStrictEqual(found.map((r) => [r.token, r.line, 'frontier' in r]), [['PAGEREF_detail', ELEMENT_PAGE_TOKEN_LINE, false]], name);
    assert.strictEqual(pageRefAdvice(found), `${PAGEREF_RULE}; remove it or move it there`, name);
    const { deployment, residual } = resolveOne(code);
    assert.strictEqual(deployment.get('x'), code.replace('"PAGEREF_detail"', '"gp-detail"'), `${name}: only the real call is rewritten; the regex is as written`);
    assert.deepStrictEqual(residual.map((r) => [r.token, r.line]), [['PAGEREF_detail', ELEMENT_PAGE_TOKEN_LINE]], name);
  }
});

// The colon form compiles as JSX text (`<span>(required): Name</span>`) and as a call signature (`{ <T>(x: T): T }`). It raises `generic` at the `<`
// either way. Read as an element, which is what the first is, the page after it is read right and the call is seen — but it lies after the guess, so it
// is refused, naming the kind, and not rewritten. As a call signature the element's text runs on over the call, which is not seen; its token is refused too.
test('the colon form is the `generic` guess: a call after it is refused, naming the kind, and never rewritten', () => {
  const label = `const label = <span>(required): Name</span>;\n${DETAIL_CALL}\n`;
  const signature = `interface Callable { <T>(x: T): T }\n${DETAIL_CALL}\n`;
  for (const [what, code, at, seen] of [['JSX text', label, label.indexOf('<span>'), true], ['a call signature', signature, signature.indexOf('<T>'), false]]) {
    assert.deepStrictEqual(navigationFrontier(code), { start: at, kind: 'generic', line: 1, column: at + 1 }, what);
    assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.afterFrontier]), seen ? [['pageref', true]] : [], `${what}: the call is ${seen ? 'seen, and after the guess' : 'not seen'}`);
    const found = strayPageRefs(code);
    const column = code.split('\n')[1].indexOf('PAGEREF_') + 1;
    assert.deepStrictEqual(found.map((r) => [r.token, r.line, r.column, r.frontier.kind, r.frontier.line, r.frontier.column]), [['PAGEREF_detail', 2, column, 'generic', 1, at + 1]], what);
    assert.strictEqual(describePageRefLocations(found), `PAGEREF_detail (line 2, column ${column}, after the "generic" ambiguity at line 1, column ${at + 1})`, what);
    assert.match(pageRefAdvice(found), /a "<Name>" followed by a parameter list and a ":" may be the type parameters of a call signature or an element whose text starts with a parenthesis/, what);
    assert.match(pageRefAdvice(found), /move the navigation call above it/, what);
    const { deployment, residual, unresolved } = resolveOne(code);
    assert.strictEqual(deployment.get('x'), code, `${what}: never rewritten`);
    assert.deepStrictEqual(residual.map((r) => [r.token, r.line, r.frontier.kind]), [['PAGEREF_detail', 2, 'generic']], what);
    assert.deepStrictEqual([unresolved, navMalformedRefs(code)], [[], []], `${what}: stray, not malformed`);
    // A call before it is as trusted as ever, and the call after is refused all the same.
    const earlier = `${DETAIL_CALL}\n${code}`;
    assert.deepStrictEqual(strayPageRefs(earlier).map((r) => [r.line, r.frontier.kind]), [[3, 'generic']], what);
    assert.strictEqual(resolveOne(earlier).deployment.get('x'), earlier.replace('"PAGEREF_detail"', '"gp-detail"'), what);
  }
  // Moved above it, the call is as trusted as any: the way out is to put it before the construct.
  const above = `${DETAIL_CALL}\n${label.split('\n')[0]}\n`;
  assert.deepStrictEqual(strayPageRefs(above), []);
  assert.strictEqual(resolveOne(above).deployment.get('x'), above.replace('"PAGEREF_detail"', '"gp-detail"'));
});

// A call or construct signature with no return type — `interface I { <T>(x) }` — compiles, and its text up to its end is also the text of an element that starts with a parenthesis. A lexer that took it for
// the element read the rest of the type as text up to a closing tag in a string after it, and the text of a call in that string as a real one, whose token was rewritten. The two are told apart
// (source-literals.js, callSignatureOrElement): the signature is code, the token in the string after it is stray, and the call that follows the page is the one that is rewritten.
test('a call or construct signature with no return type is code: the token in the string after it is never rewritten, and the call after it is', () => {
  const decoy = `const s = '</T>;navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});//';`;
  const lastToken = (code) => code.lastIndexOf('"PAGEREF_detail"');
  for (const signature of ['interface I { <T>(x) }', 'interface I { <T>(x); }', 'type L = { <T>(x) };', 'interface C { new <T>(x) }', 'interface I { <T>(x); m: { a: string } }', 'interface I { <T>(x)\n  <U>(y) }']) {
    const code = `${signature}\n${decoy}\n${DETAIL_CALL}\n`;
    assert.strictEqual(navigationFrontier(code), null, signature);
    const { deployment, residual, unresolved } = resolveOne(code);
    const at = lastToken(code);
    assert.strictEqual(deployment.get('x'), `${code.slice(0, at)}"gp-detail"${code.slice(at + '"PAGEREF_detail"'.length)}`, `${signature}: only the real call is rewritten`);
    assert.deepStrictEqual(residual.map((r) => [r.token, r.line, r.frontier]), [['PAGEREF_detail', signature.split('\n').length + 1, undefined]], `${signature}: the token in the string is left as it was, stray, with no guess before it`);
    assert.deepStrictEqual(unresolved, [], signature);
  }
  // Where the type holds its own closing tag in a string, a template or a comment, the signature may be the element that ends there: the guess is named, and nothing after it is rewritten.
  for (const signature of ["interface I { <T>(x); m: '</T>' }", 'interface I { <T>(x); m: `</T>` }', 'interface I { <T>(x); /* </T> */ }']) {
    const code = `${signature}\n${decoy}\n${DETAIL_CALL}\n`;
    assert.deepStrictEqual(navigationFrontier(code), { start: code.indexOf('<T>'), kind: 'generic', line: 1, column: code.indexOf('<T>') + 1 }, signature);
    assert.strictEqual(resolveOne(code).deployment.get('x'), code, `${signature}: nothing is rewritten`);
    assert.deepStrictEqual(resolveOne(code).residual.map((r) => r.frontier.kind), ['generic', 'generic'], signature);
  }
  // JSX text that starts with a parenthesis is the element it is, wherever the lexer can read it to its closing tag: no guess, and the call after it is rewritten.
  for (const element of ['<b>(optional)</b>', '<span>(total: {count})</span>', '<Text>({items.length} items)</Text>', '<p>({formatDate(d)})</p>', '<p>({t("label")})</p>', '<div><b>(x)</b></div>', '<p>(a),\n  <b x={1}>y</b>\n</p>']) {
    const code = `const e = ${element};\n${decoy.replace("'</T>;", "'")}\n${DETAIL_CALL}\n`;
    assert.strictEqual(navigationFrontier(code), null, element);
    const at = lastToken(code);
    assert.strictEqual(resolveOne(code).deployment.get('x'), `${code.slice(0, at)}"gp-detail"${code.slice(at + '"PAGEREF_detail"'.length)}`, `${element}: the call after the element is rewritten, and the string's token is not`);
  }
});

// A refusal the author can act on names the construct. The page of a live run declared a navigation call that the lexer could not see — `of/2`
// is read as the start of a regex, whose `/*` opens a comment over the call — and the build said only "declared-but-absent: [detail]".
test('navigationFrontier and frontierNote name the first place the lexer guessed, and are empty for a page with none', () => {
  const { code, frontier } = HIDDEN_CALL_PAGE;
  const at = frontier(code);
  assert.deepStrictEqual(navigationFrontier(code), { start: at, kind: 'keyword', ...positionOf(code, at) });
  assert.deepStrictEqual(extractNavTargets(code), [], 'the call is not seen');
  const note = frontierNote(code);
  assert.ok(note.includes(`the page has a "keyword" ambiguity at line ${positionOf(code, at).line}, column ${positionOf(code, at).column}`), note);
  assert.match(note, /a navigation call written after it may not be seen/);
  assert.match(note, /a "\/" or "<" right after a word that is a keyword in some places and a name in others/);
  assert.match(note, /this check cannot tell for certain how the code after it is read/);
  assert.match(note, /parentheses/);
  assert.strictEqual(navigationFrontier(`${DETAIL_CALL}\n`), null);
  assert.strictEqual(frontierNote(`${DETAIL_CALL}\n`), '');
  assert.strictEqual(frontierNote(''), '');
  assert.strictEqual(frontierNote(undefined), '');
  // The earliest guess is the one named, whatever follows.
  const twice = `${OBJECT_DIVISION}\n${HIDDEN_CALL_PAGE.code}`;
  assert.strictEqual(navigationFrontier(twice).kind, 'brace');
  assert.strictEqual(navigationFrontier(twice).line, 1);
});

test('the report says what to change: a stray token is removed or moved; code a guess hides is made unambiguous', () => {
  const plain = strayPageRefs('const s = "PAGEREF_detail";');
  assert.strictEqual(pageRefAdvice(plain), `${PAGEREF_RULE}; remove it or move it there`);
  const guessed = strayPageRefs(`${OBJECT_DIVISION}\n${DETAIL_CALL}\n`);
  const advice = pageRefAdvice(guessed);
  assert.match(advice, /a "\/" or "<" right after a "\}" may be a division or comparison after an object literal, or a regex or JSX element after a block/);
  assert.match(advice, /this check cannot tell for certain how the code after it is read/);
  assert.match(advice, /does not trust a navigation call that reaches it, or a PAGEREF_ token at or after it/);
  assert.match(advice, /parentheses/);
  assert.match(advice, /";"/, 'a semicolon is the other way out');
  assert.match(advice, /move the navigation call above it/);
  assert.match(advice, /avoid the construct/);
  assert.ok(!advice.includes('remove it or move it there'), 'the call is where it belongs: the construct before it is what to change');
  const both = pageRefAdvice([...plain, ...guessed]);
  assert.ok(both.includes('remove it or move it there') && both.includes('division or comparison after an object literal'), both);
  assert.strictEqual(pageRefAdvice([]), '');
});

test('every kind of ambiguity has its own wording in the report, and a report of two names both', () => {
  const wording = new Map();
  for (const kind of AMBIGUITY_KINDS) {
    const advice = pageRefAdvice([{ token: 'PAGEREF_x', line: 3, column: 1, frontier: { kind, start: 0, line: 1, column: 1 } }]);
    assert.ok(!/undefined|\[object/.test(advice), `${kind}: ${advice}`);
    assert.match(advice, /this check cannot tell for certain how the code after it is read/, kind);
    // A kind with no description of its construct would leave only the remedy, which says nothing of what it is for.
    assert.ok(advice.split(' — this check cannot tell')[0].length > 30, `${kind}: the construct is described: ${advice}`);
    wording.set(advice, kind);
  }
  assert.strictEqual(wording.size, AMBIGUITY_KINDS.length, 'no two kinds share their wording');
  const two = pageRefAdvice([
    { token: 'PAGEREF_a', frontier: { kind: 'brace', start: 0, line: 1, column: 1 } },
    { token: 'PAGEREF_b', frontier: { kind: 'identifier', start: 0, line: 1, column: 1 } },
    { token: 'PAGEREF_c', frontier: { kind: 'brace', start: 0, line: 1, column: 1 } },
  ]);
  assert.match(two, /right after a "\}"/);
  assert.match(two, /\\u escape/);
  assert.strictEqual(two.split('right after a "}"').length - 1, 1, 'a kind is worded once however many tokens follow it');
});

// The guesses about a `<` say what the construct could be: the report is what an author reads, and tells which edit makes the code unambiguous.
test('the wording of the "operator", "generic" and "newline" guesses names the constructs a "<" may open', () => {
  const advice = (kind) => pageRefAdvice([{ token: 'PAGEREF_x', line: 3, column: 1, frontier: { kind, start: 0, line: 1, column: 1 } }]);
  assert.match(advice('operator'), /a "<" that could open a generic right after ">=", ">>=" or ">>>=" \(the first ">" may end type arguments\), after a "<", after "in" or after "yield \*" may be an element in a comparison, a test or a product, or the type parameters of an arrow or a function type/);
  assert.match(advice('operator'), /a "\/" right after "\.\.\."/, 'the earlier constructs are still worded');
  assert.match(advice('generic'), /one followed by a parameter list and "=>" is a function type unless a nested tag, an attribute string or an expression container in the list holds the arrow, and this check cannot rule that out for every "<" or "\{" there/);
  assert.match(advice('generic'), /"<await" and "<yield" may be type parameters or an element, by whether the function around them is async or a generator/);
  assert.match(advice('generic'), /a "<Name>" followed by a parameter list and a ":" may be the type parameters of a call signature or an element whose text starts with a parenthesis/);
  assert.match(advice('generic'), /and so may one followed by a parameter list and no return type when a string, a template, a comment or a regex after it could hold its closing tag "<\/Name>" or the text after it cannot be read to the end of an element/);
  assert.match(advice('newline'), /a "<" after "void" and a line break/);
});

// ─── The reading the resolver gets from each fix ──────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Each page is valid to TypeScript, holds the text of a navigation call as data — in a string, a regex — and then the real call. The decoy's token is stray and never rewritten, the real call is rewritten, and no guess is
// named: the lexer read the page as TypeScript does.
const TS_DECOY_STRING = (name) => `const s = '</${name}>;${DETAIL_CALL}//';`;
const DECOY_REGEX_STATEMENT = `const re = /${DETAIL_CALL.replace(/;$/, '')}/;`;
test('a self-closing tag with trivia between its "/" and its ">", a regex whose flags spell a word, a closing tag with a spaced name, a cast, and a comment in a container: the decoy is data and the real call is rewritten', () => {
  const pages = [
    ['a tag with a space before the `>`', `const e = <B / >;\n${TS_DECOY_STRING('B')}\n${DETAIL_CALL}`],
    ['a tag with a line break before the `>`', `const e = <B /\n>;\n${TS_DECOY_STRING('B')}\n${DETAIL_CALL}`],
    ['a tag with an attribute and a space', `const e = <B x="1" / >;\n${TS_DECOY_STRING('B')}\n${DETAIL_CALL}`],
    ['a tag with a comment before the `>`', `const e = <B / /* c */ >;\n${TS_DECOY_STRING('B')}\n${DETAIL_CALL}`],
    ['a tag with U+0085 before the `>`', `const e = <B /\u0085>;\n${TS_DECOY_STRING('B')}\n${DETAIL_CALL}`],
    ['a tag with U+2028 before the `>`', `const e = <B /\u2028>;\n${TS_DECOY_STRING('B')}\n${DETAIL_CALL}`],
    ['an attribute value that is a tag with a space before its `>`', `const e = <A x=<B / >/>;\nconst s = '</B>></A>;${DETAIL_CALL}//';\n${DETAIL_CALL}`],
    ['a nested tag with a line break before its `>`', `const e = <A><B /\n></A>;\n${TS_DECOY_STRING('B')}\n${DETAIL_CALL}`],
    ['a regex whose flags spell `in`', `const n = /x/in /2; ${DECOY_REGEX_STATEMENT}\n${DETAIL_CALL}`],
    ['a regex whose flags spell `is`, then a division on the next line', `const n = /x/is\n/2; ${DECOY_REGEX_STATEMENT}\n${DETAIL_CALL}`],
    ['a regex with a flag, then a comparison on the next line', `const n = /x/g\n< 2; ${DECOY_REGEX_STATEMENT}\n${DETAIL_CALL}`],
    ['a closing tag with a space before its colon', `const e = <a:b>x</a :b>;\n${TS_DECOY_STRING('a:b')}\n${DETAIL_CALL}`],
    ['a closing tag with a comment before its colon', `const e = <a:b>x</a/*c*/:b>;\n${TS_DECOY_STRING('a:b')}\n${DETAIL_CALL}`],
    ['a closing tag with a comment after its colon', `const e = <a:b>x</a:/*c*/b>;\n${TS_DECOY_STRING('a:b')}\n${DETAIL_CALL}`],
    ['a closing tag with spaces around its dot', `const e = <a.b>x</a . b>;\n${TS_DECOY_STRING('a.b')}\n${DETAIL_CALL}`],
    ['a cast, then a division', `const n = x as A<B> /2; ${DECOY_REGEX_STATEMENT}\n${DETAIL_CALL}`],
    ['a satisfies cast, then a division', `const n = x satisfies A<B> / 2; ${DECOY_REGEX_STATEMENT}\n${DETAIL_CALL}`],
    ['a cast with an array type, then a comparison and a regex', `const n = x as A<B>[] > /y/.test(z); ${DECOY_REGEX_STATEMENT}\n${DETAIL_CALL}`],
    ['a comment in the object type of a function type', `const f: <T>(x: { /* c */ readonly a: T }) => T = g;\n${TS_DECOY_STRING('T')}\n${DETAIL_CALL}`],
    ['a signature with no return type and a closing tag after it', `interface I { <T>(x) }\n${TS_DECOY_STRING('T')}\n${DETAIL_CALL}`],
    ['text that starts with a parenthesis and holds a slash', `const e = <p>(a), 1/2 done</p>;\n${TS_DECOY_STRING('p')}\n${DETAIL_CALL}`],
    ['text that starts with a parenthesis and a URL', `const e = <p>(a), see https://x.y</p>;\n${TS_DECOY_STRING('p')}\n${DETAIL_CALL}`],
  ];
  for (const [what, code] of pages) {
    assert.strictEqual(navigationFrontier(code), null, `${what}: no guess is involved`);
    assert.deepStrictEqual(extractNavTargets(code).map((t) => [t.kind, t.key]), [['pageref', 'detail']], `${what}: one real call`);
    const resolved = resolveOne(code);
    // Only the real call, the last token, is rewritten: the decoy's is as written.
    const real = code.lastIndexOf('"PAGEREF_detail"');
    assert.strictEqual(resolved.deployment.get('x'), `${code.slice(0, real)}"gp-detail"${code.slice(real + '"PAGEREF_detail"'.length)}`, what);
    assert.ok(strayPageRefs(code).every((found) => !('frontier' in found)), `${what}: the data's token is stray with no guess named`);
  }
});

// A page with a guess before a call refuses the call, and a page with the same text that TypeScript reads the other way is refused too: the closing tag in a string of a type, and the text of an element that a comment hides.
test('a signature whose parameter list or text holds its closing tag in a string or a comment is a guess, and the call after it is refused; the element with the same text is refused too', () => {
  for (const code of [
    `interface I { <T>(x: "</T>") }\n${TS_DECOY_STRING('T')}\n${DETAIL_CALL}`,
    `type L = { <T>(x: '</T>'); m: 1 };\n${TS_DECOY_STRING('T')}\n${DETAIL_CALL}`,
    `interface I { <T>(x /* </T> */) }\n${TS_DECOY_STRING('T')}\n${DETAIL_CALL}`,
    `const e = <p>(a); // c </p>;\n${TS_DECOY_STRING('p')}\n${DETAIL_CALL}`,
  ]) {
    const frontier = navigationFrontier(code);
    assert.ok(frontier && frontier.kind === 'generic', JSON.stringify(code));
    assert.strictEqual(resolveOne(code).deployment.get('x'), code, 'nothing is rewritten after the guess');
  }
});
