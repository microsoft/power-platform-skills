'use strict';
// What the page compiler does with iteration, and the teaching that answers it (references/rules.md, Critical Rule 24 and
// Common Errors > 5. Iteration that another page compiler can lose).
//
// The bundled SDK compiles a page with TypeScript's `transpileModule` and `{ target: ES5, module: ES2020, jsx: React,
// downlevelIteration: true }` — its default iteration profile, 'iterator', which is what the maker portal's page compiler source
// sets too (scripts/lib/typescript-compiler.js keeps the compiler the portal uses). Under it the inlined helpers follow
// `Symbol.iterator`: a spread becomes `__spreadArray([], __read(value), false)`, a `for...of` loop walks `__values(value)`, and an
// array destructure reads `__read(value, n)`, so a Map, a Set, their iterators, a generator, a native `matchAll` result,
// URLSearchParams, FormData, Headers and a string iterate as modern JavaScript does.
//
// The bundles before model-apps 2.20.5 compiled WITHOUT `downlevelIteration` (the 'legacy' profile, which an older maker portal and
// `pac` still use): ES5 emit then reads an iterable by `length` and index, so the spread contributes nothing, the loop runs zero
// times, an element is undefined, a default replaces the real value and a rest element throws — with a clean compile, since
// `transpileModule` reports syntax only. A page compiled again by such a tool loses those values, which is why the teaching keeps
// `Array.from`: it is correct under both profiles. Every case here is compiled by the vendored compiler under the profile it names
// and run in a fresh vm context; the expected values are what that emit does. The last test holds the 'iterator' options to what
// the real SDK bundle stores for a page, so an SDK that compiles pages another way — the legacy emit included — fails there first.
// Results cross the context boundary as JSON (undefined and thrown errors are compared separately), so nothing depends on another
// realm's prototypes. The host's own URLSearchParams, FormData and Headers are handed in for their cases: nothing is fetched and no
// DOM is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'rules.md'), 'utf8').replace(/\r\n?/g, '\n');
const HEADING = '### 5. Iteration that another page compiler can lose';

let typescript;
const ts = () => (typescript ||= loadVendoredTypeScript());
// The two emit profiles, exactly: 'iterator' is what the bundled SDK stores (held to it by the last test), 'legacy' what a compiler
// without iterator support stores. 'legacy' OMITS the key, as such a compiler's options do.
const PROFILES = {
  iterator: () => ({ target: ts().ScriptTarget.ES5, module: ts().ModuleKind.ES2020, jsx: ts().JsxEmit.React, downlevelIteration: true }),
  legacy: () => ({ target: ts().ScriptTarget.ES5, module: ts().ModuleKind.ES2020, jsx: ts().JsxEmit.React }),
};
function compile(source, profile = 'iterator') {
  const { outputText, diagnostics } = ts().transpileModule(source, { compilerOptions: PROFILES[profile](), reportDiagnostics: true });
  return { outputText, codes: (diagnostics || []).map((d) => d.code) };
}

const HOST_GLOBALS = { URLSearchParams, FormData, Headers };
// Compiles `source` under `profile`, runs it in a fresh context (plus `prelude`, plain JavaScript run first in the same context) and
// reads the named top-level values back. A value is JSON-normalized; `undefined` stays undefined; a throw is { threw: <error name> }.
function run(source, names, { profile = 'iterator', prelude = '', after = '' } = {}) {
  const { outputText, codes } = compile(source, profile);
  assert.deepEqual(codes, [], 'the compile reports nothing — not even TS2802, which only a type check gives');
  const context = vm.createContext({ ...HOST_GLOBALS });
  try {
    vm.runInContext(`${prelude}\n${outputText}\n${after}`, context, { filename: 'iteration-case.js' });
  } catch (error) {
    return { threw: error && error.name, outputText };
  }
  const values = {};
  for (const name of names) {
    const value = context[name];
    values[name] = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  return { values, outputText };
}

// ── The emit itself ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Each family the teaching names, made fresh for each arm (an iterator is spent once read).
const FAMILIES = [
  ['a Map', 'return new Map([["a", 1], ["b", 2]]);', [['a', 1], ['b', 2]]],
  ['a Set', 'return new Set([1, 2]);', [1, 2]],
  ['a Map\'s keys()', 'return new Map([["a", 1], ["b", 2]]).keys();', ['a', 'b']],
  ['a Map\'s values()', 'return new Map([["a", 1], ["b", 2]]).values();', [1, 2]],
  ['a Map\'s entries()', 'return new Map([["a", 1]]).entries();', [['a', 1]]],
  ['a Set\'s values()', 'return new Set([1, 2]).values();', [1, 2]],
  ['an array\'s values()', 'return [1, 2].values();', [1, 2]],
  ['an array\'s entries()', 'return ["x"].entries();', [[0, 'x']]],
  ['a generator', 'return (function* () { yield 1; yield 2; })();', [1, 2]],
  ['a native matchAll result', 'var text = "a1 b2"; var re = /\\d/g; return text.matchAll(re);', [['1'], ['2']]],
  ['URLSearchParams', 'return new URLSearchParams("a=1&b=2");', [['a', '1'], ['b', '2']]],
  ['FormData', 'var form = new FormData(); form.append("a", "1"); return form;', [['a', '1']]],
  ['Headers', 'return new Headers([["a", "1"]]);', [['a', '1']]],
];

test('a spread of each native collection, iterator, generator and host iterable reads every element under iterator support, none without it; Array.from reads them all under both', () => {
  for (const [label, body, values] of FAMILIES) {
    const source = `function make(): any { ${body} }\nconst direct = [0, ...make()];\nconst converted = [0, ...Array.from(make())];\n`;
    const iterator = run(source, ['direct', 'converted']);
    assert.match(iterator.outputText, /__spreadArray\(\[0\], __read\(make\(\)\), false\)/, `${label}: the iterator emit reads it through Symbol.iterator`);
    assert.deepEqual(iterator.values, { direct: [0, ...values], converted: [0, ...values] }, `${label}: every value arrives in order`);
    const legacy = run(source, ['direct', 'converted'], { profile: 'legacy' });
    assert.match(legacy.outputText, /__spreadArray\(\[0\], make\(\), true\)/, `${label}: the legacy emit copies it as an array-like`);
    assert.deepEqual(legacy.values, { direct: [0], converted: [0, ...values] }, `${label}: without iterator support the spread adds nothing; converted first, it is whole`);
  }
});

test('a call or constructor argument spread of an iterable passes every argument under iterator support and none without it; spreading Array.from passes them all under both', () => {
  const source = `function make(): any { return new Set(["a", "b"]); }
function collect(...items: string[]) { return items; }
function Collect(this: any, ...items: string[]) { this.items = items; }
const directCall = collect("x", ...make());
const convertedCall = collect("x", ...Array.from(make()));
const directNew = new (Collect as any)(...make()).items;
const convertedNew = new (Collect as any)(...Array.from(make())).items;
`;
  const names = ['directCall', 'convertedCall', 'directNew', 'convertedNew'];
  assert.deepEqual(run(source, names).values, { directCall: ['x', 'a', 'b'], convertedCall: ['x', 'a', 'b'], directNew: ['a', 'b'], convertedNew: ['a', 'b'] });
  assert.deepEqual(run(source, names, { profile: 'legacy' }).values, { directCall: ['x'], convertedCall: ['x', 'a', 'b'], directNew: [], convertedNew: ['a', 'b'] });
});

test('a for...of over a Map walks its pairs under iterator support and closes the iterator on break; without it the loop runs zero times; looping over Array.from works under both', () => {
  const source = `const m = new Map([["a", 1], ["b", 2]]);
const direct: Array<[string, number]> = [];
for (const [k, v] of m) direct.push([k, v]);
const converted: Array<[string, number]> = [];
for (const [k, v] of Array.from(m)) converted.push([k, v]);
let early = "";
for (const [k] of Array.from(m)) { if (k === "b") { early = k; break; } }
`;
  const iterator = run(source, ['direct', 'converted', 'early']);
  assert.match(iterator.outputText, /__values\(m\)/, 'the loop walks the iterator');
  assert.deepEqual(iterator.values, { direct: [['a', 1], ['b', 2]], converted: [['a', 1], ['b', 2]], early: 'b' });
  assert.deepEqual(run(source, ['direct', 'converted', 'early'], { profile: 'legacy' }).values, { direct: [], converted: [['a', 1], ['b', 2]], early: 'b' });
  const closing = `let closed = false;
const it: any = { [Symbol.iterator]() { let i = 0; return { next: () => ({ value: i++, done: i > 5 }), return: () => { closed = true; return { done: true }; } }; } };
for (const v of it) { if (v === 1) break; }
`;
  assert.equal(run(closing, ['closed']).values.closed, true, 'a break closes the iterator, as modern JavaScript does');
});

test('array destructuring of a Set reads its elements under iterator support; without it an element is undefined, a default replaces the value and a rest element throws', () => {
  const cases = [
    ['const [first] = new Set([1, 2]);\n', 'first', 1, undefined],
    ['const [first = "fallback"] = new Set(["actual"]);\n', 'first', 'actual', 'fallback'],
    ['const [, second] = new Set(["x", "y"]);\n', 'second', 'y', undefined],
    ['let first: any = "before";\n([first] = new Set([1]) as any);\n', 'first', 1, undefined],
  ];
  for (const [source, name, withSupport, without] of cases) {
    assert.equal(run(source, [name]).values[name], withSupport, source);
    assert.equal(run(source, [name], { profile: 'legacy' }).values[name], without, source);
    assert.equal(run(source.replace(/= (new Set\([^)]*\))/, '= Array.from($1)'), [name], { profile: 'legacy' }).values[name], withSupport, `Array.from: ${source}`);
  }
  const rest = 'const [...rest] = new Set([1, 2]);\n';
  assert.match(run(rest, ['rest']).outputText, /__read\(new Set\(\[1, 2\]\)\)/);
  assert.deepEqual(run(rest, ['rest']).values.rest, [1, 2]);
  const legacy = run(rest, ['rest'], { profile: 'legacy' });
  assert.equal(legacy.threw, 'TypeError', 'without iterator support the emitted rest element calls slice, which a Set does not have');
  assert.match(legacy.outputText, /\.slice\(0\)/);
  assert.deepEqual(run('const [...rest] = Array.from(new Set([1, 2]));\n', ['rest'], { profile: 'legacy' }).values.rest, [1, 2]);
});

test('the unique-value idiom and a Set-based selection append keep every value under iterator support and lose them without it; Array.from and a native Set copy keep them under both', () => {
  const unique = 'const xs = [1, 1, 2];\nconst direct = [...new Set(xs)];\nconst converted = Array.from(new Set(xs));\n';
  assert.deepEqual(run(unique, ['direct', 'converted']).values, { direct: [1, 2], converted: [1, 2] });
  assert.deepEqual(run(unique, ['direct', 'converted'], { profile: 'legacy' }).values, { direct: [], converted: [1, 2] });
  const source = `const prev = new Set(["a"]);
const appended = new Set([...prev, "b"]);
const copied = new Set(prev);
copied.add("b");
const direct = Array.from(appended);
const native = Array.from(copied);
`;
  assert.deepEqual(run(source, ['direct', 'native']).values, { direct: ['a', 'b'], native: ['a', 'b'] });
  assert.deepEqual(run(source, ['direct', 'native'], { profile: 'legacy' }).values, { direct: ['b'], native: ['a', 'b'] }, 'without iterator support the prior selection is lost');
});

// ── Neighbours: what keeps working, and the string, array-like and destructuring behaviours the teaching states ─────────────────

test('ordinary arrays, Object helpers, array-likes, arguments and native constructor copies work alike under both profiles', () => {
  const source = `const rows = [1, 2];
const spread = [...rows, 3];
let looped = 0;
for (const row of rows) looped += row;
const [head] = rows;
const keys = [...Object.keys({ a: 1, b: 2 })];
const entries: Array<[string, number]> = [];
for (const [k, v] of Object.entries({ a: 1 })) entries.push([k, v]);
const like: any = { length: 2, 0: "x", 1: "y" };
const fromLike = [...like];
function args(..._: any[]) { return [...(arguments as any)]; }
const fromArguments = args(1, 2);
const copiedSet = Array.from(new Set(new Set([1, 2])));
const copiedMap = Array.from(new Map(new Map([["k", 1]])));
const objectSpread = { ...{ a: 1 }, b: 2 };
`;
  const names = ['spread', 'looped', 'head', 'keys', 'entries', 'fromLike', 'fromArguments', 'copiedSet', 'copiedMap', 'objectSpread'];
  const expected = {
    spread: [1, 2, 3], looped: 3, head: 1, keys: ['a', 'b'], entries: [['a', 1]], fromLike: ['x', 'y'], fromArguments: [1, 2],
    copiedSet: [1, 2], copiedMap: [['k', 1]], objectSpread: { a: 1, b: 2 },
  };
  assert.deepEqual(run(source, names).values, expected);
  assert.deepEqual(run(source, names, { profile: 'legacy' }).values, expected);
});

test('a string spreads, loops and destructures by code point under iterator support; without it a spread throws and a loop visits UTF-16 code units; Array.from reads code points under both', () => {
  const source = 'const name = "😀A";\nconst chars = [...name];\nconst units: string[] = [];\nfor (const c of name) units.push(c);\nconst points = Array.from(name);\nconst [first] = name;\n';
  assert.deepEqual(run(source, ['chars', 'units', 'points', 'first']).values, { chars: ['😀', 'A'], units: ['😀', 'A'], points: ['😀', 'A'], first: '😀' });
  assert.equal(run(source, ['chars'], { profile: 'legacy' }).threw, 'TypeError');
  const legacy = run(source.replace('const chars = [...name];\n', ''), ['units', 'points', 'first'], { profile: 'legacy' });
  assert.equal(legacy.values.units.length, 3, 'the astral character is two units');
  assert.deepEqual(legacy.values.points, ['😀', 'A']);
  assert.equal(legacy.values.first.length, 1, 'a first-element binding reads the indexed UTF-16 element');
});

test('a rest destructure of an array-like without slice throws under both profiles; a custom Symbol.matchAll that returns an array spreads fine under both', () => {
  for (const profile of ['iterator', 'legacy']) {
    assert.equal(run('const like: any = { length: 1, 0: "x" };\nconst [...rest] = like;\n', ['rest'], { profile }).threw, 'TypeError', profile);
    const source = `const matcher: any = { [Symbol.matchAll](text: string) { return [text.length]; } };
const hits = [..."abc".matchAll(matcher)];
`;
    assert.deepEqual(run(source, ['hits'], { profile }).values.hits, [3], `${profile}: the string method delegates to the matcher, which may return an array`);
  }
});

test('the one disclosed difference of iterator support: a destructuring default that writes a later element of the same array is not seen by that element', () => {
  const source = 'const values: any[] = [undefined, 2];\nconst [a = (values[1] = 3), b] = values;\nconst pair = [a, b];\n';
  assert.deepEqual(run(source, ['pair']).values.pair, [3, 2], 'the elements were copied before the default ran');
  assert.deepEqual(run(source, ['pair'], { profile: 'legacy' }).values.pair, [3, 3], 'modern JavaScript and the legacy emit read the element after the default');
});

// skills/genpage/edit-flow.md: converting an existing form is not always neutral — `Array.from` reads the whole iterable, where a destructure or a loop that stops early reads a prefix.
test('under iterator support a destructure or a loop that stops early reads only a prefix of a generator, and Array.from reads all of it — converting such a form runs the rest of the generator', () => {
  const source = `let directReads = 0;
let convertedReads = 0;
let loopReads = 0;
function* values(counter: () => void) { counter(); yield 1; counter(); yield 2; counter(); yield 3; }
const [direct] = values(() => { directReads++; });
const [converted] = Array.from(values(() => { convertedReads++; }));
for (const v of values(() => { loopReads++; })) { if (v === 1) break; }
`;
  assert.deepEqual(run(source, ['direct', 'converted', 'directReads', 'convertedReads', 'loopReads']).values, { direct: 1, converted: 1, directReads: 1, convertedReads: 3, loopReads: 1 });
});

// ── The teaching: Critical Rule 24 and Common Errors §5 ───────────────────────────────────────────────────────────────────────

// The section, its labelled fences in order, and each fence's role. Every fence is its own example: none shares a declaration
// with another, so each is compiled and run alone.
function teaching() {
  const at = RULES.indexOf(`\n${HEADING}\n`);
  assert.ok(at > 0, `rules.md has "${HEADING}"`);
  const rest = RULES.slice(at + 1);
  const next = rest.slice(HEADING.length).search(/\n#{2,3} /);
  const section = next < 0 ? rest : rest.slice(0, HEADING.length + next);
  const examples = [];
  let label = null;
  const pattern = /^\*\*(.+?)\*\*$|^```typescript\n([\s\S]*?)\n```$/gm;
  for (const match of section.matchAll(pattern)) {
    if (match[1] !== undefined) { label = match[1]; continue; }
    const code = match[2];
    const role = /^\/\/ (WRONG|CORRECT)\b/.exec(code);
    examples.push({ label, role: role && role[1], code });
  }
  return { section, examples };
}

// What each pair is taught to do: the right result, which every CORRECT example gives under both profiles and every WRONG example
// gives under iterator support — and what the WRONG example gives without it.
const TAUGHT = {
  'Map values': { name: 'choices', right: [1, 2], legacyWrong: [] },
  'Unique values': { name: 'unique', right: [1, 2], legacyWrong: [] },
  'Map pairs': { name: 'rows', right: [['a', 1], ['b', 2]], legacyWrong: [] },
  'Native matchAll result': { name: 'hits', right: ['1', '2'], legacyWrong: [] },
  'String spread — a separate throw, not an empty iterable result': { name: 'chars', right: ['A', '😀'], legacyWrong: 'throws' },
};
const EDGE = 'A default that writes the array it destructures — the one difference from modern JavaScript under iterator support';

test('Common Errors §5 holds separate WRONG and CORRECT fences; each compiles under both profiles, the CORRECT one is right under both, the WRONG one only with iterator support', () => {
  const { examples } = teaching();
  assert.ok(examples.length >= 18, 'the pairs are there');
  for (const example of examples) {
    assert.ok(example.role, `every fence in the section opens with // WRONG or // CORRECT (${example.label})`);
    assert.equal((example.code.match(/\/\/ (?:WRONG|CORRECT)\b/g) || []).length, 1, `one role per fence, never a WRONG and a CORRECT in one scope (${example.label})`);
    for (const profile of ['iterator', 'legacy']) assert.deepEqual(compile(example.code, profile).codes, [], `${example.label} ${example.role} compiles (${profile})`);
    if (example.role === 'WRONG' && example.label !== EDGE) assert.match(example.code, /^\/\/ WRONG — without iterator support /, `${example.label}: the WRONG comment says when it fails`);
  }
  for (const [label, { name, right, legacyWrong }] of Object.entries(TAUGHT)) {
    const pair = examples.filter((example) => example.label === label);
    assert.deepEqual(pair.map((example) => example.role), ['WRONG', 'CORRECT'], `${label}: one WRONG, then one CORRECT`);
    const [bad, good] = pair;
    assert.deepEqual(run(bad.code, [name]).values[name], right, `${label}: the WRONG example works in a page this plugin uploads`);
    const badLegacy = run(bad.code, [name], { profile: 'legacy' });
    if (legacyWrong === 'throws') assert.equal(badLegacy.threw, 'TypeError', `${label}: the WRONG example throws without iterator support`);
    else assert.deepEqual(badLegacy.values[name], legacyWrong, `${label}: the WRONG example loses the values without iterator support`);
    for (const profile of ['iterator', 'legacy']) assert.deepEqual(run(good.code, [name], { profile }).values[name], right, `${label}: the CORRECT example keeps them (${profile})`);
  }
});

test('the destructuring pairs: without iterator support an undefined element, a default that replaces the value and a rest element that throws; the CORRECT forms are right under both', () => {
  const pairs = teaching().examples.filter((example) => example.label === 'Destructuring');
  assert.deepEqual(pairs.map((example) => example.role), ['WRONG', 'CORRECT', 'WRONG', 'CORRECT', 'WRONG', 'CORRECT']);
  const names = (example) => (/\.\.\.rest/.test(example.code) ? ['rest'] : ['first']);
  const legacy = pairs.map((example) => run(example.code, names(example), { profile: 'legacy' }));
  assert.equal(legacy[0].values.first, undefined);
  assert.equal(legacy[2].values.first, 'fallback');
  assert.equal(legacy[4].threw, 'TypeError');
  const right = [1, 1, 'actual', 'actual', [1, 2], [1, 2]];
  pairs.forEach((example, i) => {
    const key = names(example)[0];
    assert.deepEqual(run(example.code, [key]).values[key], right[i], `${example.role} ${i} under iterator support`);
    if (example.role === 'CORRECT') assert.deepEqual(legacy[i].values[key], right[i], `CORRECT ${i} without iterator support`);
  });
});

// The selection examples are component-body code: they run here under a controlled `React.useState` whose state already holds a
// prior selection, and the handler is called as an event would call it — never a setter called unconditionally during render.
test('the selection-state pair: without iterator support the WRONG updater loses the prior ids and its render read loses every value; the CORRECT one keeps them under both', () => {
  const pair = teaching().examples.filter((example) => /^Selection state/.test(example.label || ''));
  assert.deepEqual(pair.map((example) => example.role), ['WRONG', 'CORRECT']);
  const prelude = `var __state = new Set(["a"]);
var React = { useState: function () { return [__state, function (next) { __state = typeof next === "function" ? next(__state) : next; }]; } };`;
  const after = 'addSelected("b"); var __after = Array.from(__state); var __render = chosen;';
  for (const example of pair) assert.doesNotMatch(example.code, /^set[A-Z]\w*\(/m, 'no setter is called at the top level of the render');
  const kept = { __after: ['a', 'b'], __render: ['a'] };
  const [bad, good] = pair;
  assert.deepEqual(run(bad.code, ['__after', '__render'], { prelude, after, profile: 'legacy' }).values, { __after: ['b'], __render: [] }, 'the updater keeps only the new id, and the render read is empty');
  assert.deepEqual(run(bad.code, ['__after', '__render'], { prelude, after }).values, kept, 'with iterator support it keeps them');
  for (const profile of ['iterator', 'legacy']) assert.deepEqual(run(good.code, ['__after', '__render'], { prelude, after, profile }).values, kept, `the native copy keeps the prior id (${profile})`);
});

test('the default-that-writes-the-array pair: the WRONG one differs from modern JavaScript under iterator support; the CORRECT one gives the modern answer under both', () => {
  const pair = teaching().examples.filter((example) => example.label === EDGE);
  assert.deepEqual(pair.map((example) => example.role), ['WRONG', 'CORRECT']);
  const [bad, good] = pair;
  assert.deepEqual(run(bad.code, ['a', 'b']).values, { a: 3, b: 2 });
  assert.deepEqual(run(bad.code, ['a', 'b'], { profile: 'legacy' }).values, { a: 3, b: 3 });
  for (const profile of ['iterator', 'legacy']) assert.deepEqual(run(good.code, ['a', 'b'], { profile }).values, { a: 3, b: 3 }, profile);
});

test('Critical Rule 24 names the forms, the conversion and the section, after Rule 23 and before the separator', () => {
  const critical = RULES.slice(RULES.indexOf('\n## Critical Rules\n'), RULES.indexOf('\n## Supported Libraries\n'));
  const rule = /\n24\. (\*\*Convert iterables to arrays\*\*: .*)\n/.exec(critical);
  assert.ok(rule, 'rules.md has Critical Rule 24');
  assert.ok(critical.indexOf('\n23. **Lookup identities**') < rule.index, 'it follows Rule 23');
  assert.match(critical.slice(rule.index), /^\n24\. [^\n]*\n\n---\n/, 'and is the last rule before the separator');
  for (const form of ['`[...new Set(xs)]`', '`[...m.values()]`', '`for (const [k, v] of m)`', '`new Set([...prev, id])`', '`[...selected]`', '`[...text.matchAll(re)]`', '`Array.from`']) {
    assert.ok(rule[1].includes(form), `Rule 24 names ${form}`);
  }
  assert.match(rule[1], /compile with iterator support/, 'it says what this plugin\'s pages compile with');
  assert.match(rule[1], /See \*\*Common Errors > 5\. Iteration that another page compiler can lose\*\*\.$/);
  assert.equal(RULES.split(`\n${HEADING}\n`).length, 2, 'one canonical section');
  assert.ok(!RULES.includes('Iteration that compiles to nothing'), 'the old heading is gone');
});

// ── The upgrade: pages an earlier release compiled without iterator support ─────────────────────────────────────────────────────

// A page uploaded by model-apps 2.20.4 or earlier holds the legacy emit: that bundle stored exactly what the legacy options emit for a
// page that reads no table (the sentinel this file held then). The SDK keeps a page's stored compiled output only when its source AND its data
// sources are unchanged and that output can be kept, so the first run of this release over such a page must neither rewrite nor republish it as
// "changed" for its new emit, nor report its published copy as different from the record a build kept of it: the page keeps the bytes it was
// published with until its source or its data sources change — and then it is compiled again, with iterator support.
test('a page stored with the legacy emit keeps it on an unchanged update, a rename and a published-copy check, and takes the iterator emit when its source changes', async () => {
  const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
  const { sha256 } = require('../lib/hash.js');
  const { FakeGenPageServer, INSTANCE } = require('./helpers/fake-genpage-server.js');
  const source = "import * as React from 'react';\nconst m = new Map<string, number>([['a', 1]]);\nexport default function Page() { return <div>{[...m.keys()].length}</div>; }\n";
  const legacy = compile(source, 'legacy').outputText;
  const pageId = '5e1f0000-0000-4000-8000-000000000001';
  const server = new FakeGenPageServer();
  server.seedPage(pageId, { name: 'Upgraded', source, compiled: legacy });
  server.otherWorkspacePublishes(pageId);
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  const content = { source, name: 'Upgraded', dataSources: [] };
  const changes = (from) => server.writes().slice(from).filter((w) => !/PublishXml/.test(w));
  try {
    const recorded = sha256(legacy);
    const check = await genpage.publishedDiffers(pageId, content, { runtimeSha256: recorded });
    assert.deepEqual(check.differing, [], 'the published copy matches the record an earlier build kept, compiled output included');
    let from = server.writes().length;
    const kept = await genpage.update(pageId, { ...content, prompt: 'p', agentMessage: 'a', publishedFingerprint: check.fingerprint });
    assert.equal(kept.unchanged, true);
    assert.equal(kept.publish.kind, 'skipped', 'the record still holds: nothing is written or published again');
    assert.deepEqual(server.writes().slice(from), []);
    from = server.writes().length;
    const unrecorded = await genpage.update(pageId, { ...content, prompt: 'p', agentMessage: 'a', runtimeEvidence: true });
    assert.equal(unrecorded.unchanged, true, 'the source is unchanged, whatever this release would compile it to');
    assert.deepEqual(changes(from), [], 'nothing is written');
    assert.equal(unrecorded.runtimeSha256, recorded, 'the runtime it publishes is the one it held');
    from = server.writes().length;
    const renamed = await genpage.update(pageId, { ...content, name: 'Upgraded again', prompt: 'p', agentMessage: 'a', runtimeEvidence: true });
    assert.ok(!changes(from).some((w) => /filecontent/.test(w)), 'a rename writes no file content');
    assert.equal(renamed.runtimeSha256, recorded);
    assert.equal(server.rowText(pageId, 'src/pages/page.compiled'), legacy, 'the stored output is the legacy emit still');
    const changed = await genpage.update(pageId, { ...content, name: 'Upgraded again', source: source.replace('<div>', '<div title="t">'), prompt: 'p2', agentMessage: 'a2', runtimeEvidence: true });
    assert.equal(changed.publish.kind, 'verified');
    assert.match(server.rowText(pageId, 'src/pages/page.compiled'), /__spreadArray\(\[\], __read\(m\.keys\(\)\), false\)/, 'a changed source is compiled with iterator support');
    assert.notEqual(changed.runtimeSha256, recorded);
  } finally {
    await genpage.dispose();
  }
});

test('a page stored with the legacy emit is compiled again when only its data sources change — the same source then reads the values the legacy emit lost', async () => {
  const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
  const { sha256 } = require('../lib/hash.js');
  const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');
  const source = "import * as React from 'react';\nconst m = new Map<string, number>([['a', 1]]);\nexport default function Page() { return <div>{[...m.keys()].length}</div>; }\n";
  const legacy = compile(source, 'legacy').outputText;
  const pageId = '5e1f0000-0000-4000-8000-000000000002';
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(pageId, { name: 'Upgraded', source, compiled: legacy });
  server.otherWorkspacePublishes(pageId);
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    const out = await genpage.update(pageId, { source, name: 'Upgraded', dataSources: ['account'], prompt: 'p', agentMessage: 'a', runtimeEvidence: true });
    assert.equal(out.unchanged, undefined, 'a data source was added: the page changed');
    assert.equal(out.publish.kind, 'verified');
    assert.equal(server.rowText(pageId, 'src/pages/page.tsx'), source, 'the source is the same bytes');
    const compiled = server.rowText(pageId, 'src/pages/page.compiled');
    assert.match(compiled, /__spreadArray\(\[\], __read\(m\.keys\(\)\), false\)/, 'compiled again, with iterator support');
    assert.notEqual(out.runtimeSha256, sha256(legacy));
  } finally {
    await genpage.dispose();
  }
});

// ── The contract these proofs assume, read from the real SDK ──────────────────────────────────────────────────────────────────────

// This pushes a page through the REAL vendored SDK bundle (over the stateful fake of the page tables, helpers/fake-genpage-server.js)
// and holds the compiled output it stores to exactly what the 'iterator' options emit. When an SDK uptake compiles pages another way —
// back to the legacy emit (a spread then reads `__spreadArray([], value, true)`, a loop indexes `length`), or an ES2015+ target
// (spreads and loops kept as written) — this fails first: then Critical Rule 24 and Common Errors §5 in references/rules.md, the
// skills that repeat the rule, and the expectations in this file are revised together.
test('the real SDK stores a page compiled exactly as these proofs compile it under iterator support: ES5 with downlevelIteration, never the legacy emit', async () => {
  const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
  const { FakeGenPageServer, INSTANCE } = require('./helpers/fake-genpage-server.js');
  const source = [
    "import * as React from 'react';",
    'const seen = new Map<string, number>([["a", 1]]);',
    'const values = [...seen.values()];',
    'const pairs: Array<[string, number]> = [];',
    'for (const [k, v] of seen) pairs.push([k, v]);',
    'const [first] = new Set(["x"]);',
    'export default function Page() { return <div>{values.length}{pairs.length}{first}</div>; }',
    '',
  ].join('\n');
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  let stored;
  try {
    const { pageId } = await genpage.create({ name: 'Emit', source, prompt: 'p', agentMessage: 'r' });
    stored = server.rowText(pageId, 'src/pages/page.compiled');
  } finally {
    await genpage.dispose();
  }
  const changed = 'the vendored SDK no longer compiles pages as these proofs assume: revise Critical Rule 24, Common Errors §5 and this file';
  assert.equal(stored, compile(source, 'iterator').outputText, `what the SDK stores is what the iterator options emit — ${changed}`);
  assert.notEqual(stored, compile(source, 'legacy').outputText, `not the legacy emit — ${changed}`);
  assert.match(stored, /__spreadArray\(\[\], __read\(seen\.values\(\)\), false\)/, 'a spread reads the iterator through Symbol.iterator');
  assert.match(stored, /__values\(seen\)/, 'a loop walks the iterator');
  assert.match(stored, /__read\(new Set\(\["x"\]\), 1\)/, 'a destructure reads the iterator');
  assert.doesNotMatch(stored, /__spreadArray\(\[\], seen\.values\(\), true\)|_i < seen_1\.length|new Set\(\["x"\]\)\[0\]/, `no legacy index emit — ${changed}`);
  assert.doesNotMatch(stored, /\[\.\.\.seen|for \(const/, `no ES2015 form left as written — ${changed}`);
});
