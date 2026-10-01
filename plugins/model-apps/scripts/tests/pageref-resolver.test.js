'use strict';
// Tests for the single structural nav oracle (pageref-resolver.js).
// All tests must pass for every nav-related change — this module is the correctness spine
// of forward resolution (Task 8), reverse-normalization (Task 11), and verification (Task 10).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  extractNavTargets,
  navReferencedKeys,
  navMalformedRefs,
  resolvePageRefs,
  reverseResolveNavIds,
  navTargetParity,
} = require(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'));

// Helper: produces a realistic generative navigateTo call with a given pageId token.
const NAV = (id) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: ${id}, data: {} });`;

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
  // and topLevelValue detects the trailing '+' and widens the span to the full expression.
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

// ─── navTargetParity ──────────────────────────────────────────────────────────

test('navTargetParity reports declared-not-referenced and referenced-not-declared (both directions)', () => {
  assert.deepStrictEqual(navTargetParity(['detail', 'ghost'], ['detail', 'extra']), { declaredNotReferenced: ['ghost'], referencedNotDeclared: ['extra'] });
  assert.deepStrictEqual(navTargetParity(['a'], ['a']), { declaredNotReferenced: [], referencedNotDeclared: [] });
});

test('DECOY end-to-end: declared "detail" but the real nav points at "wrong" — parity REJECTS it', () => {
  const code = `const decoy = "PAGEREF_detail";\n${NAV('"PAGEREF_wrong"')}`;
  assert.deepStrictEqual(navTargetParity(['detail'], navReferencedKeys(code)), { declaredNotReferenced: ['detail'], referencedNotDeclared: ['wrong'] });
});
