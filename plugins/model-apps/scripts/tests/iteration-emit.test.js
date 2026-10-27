'use strict';
// What the page compiler does with iteration, and the teaching that answers it (references/rules.md, Critical Rule 24 and
// Common Errors > 5. Iteration that compiles to nothing).
//
// The bundled SDK compiles a page with TypeScript's `transpileModule` and `{ target: ES5, module: ES2020, jsx: React }`
// (scripts/lib/typescript-compiler.js keeps the compiler the maker portal uses). Without `downlevelIteration`, ES5 emit
// reads an iterable by `length` and index: a spread becomes `__spreadArray([], value, true)`, a `for...of` becomes an
// indexed `for` loop, and an array destructure reads `value[0]` (and calls `value.slice` for a rest element). A Map, a Set,
// their iterators, a generator, a native `matchAll` result, URLSearchParams, FormData and Headers have no `length`, so the
// spread contributes nothing, the loop runs zero times, an element is undefined, a default replaces the real value and a
// rest element throws. `transpileModule` reports syntax only, so the TS2802 error a type check would give never appears.
//
// Every case here is compiled by the vendored compiler with exactly those options and run in a fresh vm context; the
// expected values are what that emit does, never what modern JavaScript would do. Results cross the context boundary as
// JSON (undefined and thrown errors are compared separately), so nothing depends on another realm's prototypes. The host's
// own URLSearchParams, FormData and Headers are handed in for their cases: nothing is fetched and no DOM is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'rules.md'), 'utf8').replace(/\r\n?/g, '\n');
const HEADING = '### 5. Iteration that compiles to nothing';

let typescript;
const ts = () => (typescript ||= loadVendoredTypeScript());
// The SDK's options, exactly. A test here is never fixed by changing the target or adding downlevelIteration.
function compile(source) {
  const { outputText, diagnostics } = ts().transpileModule(source, {
    compilerOptions: { target: ts().ScriptTarget.ES5, module: ts().ModuleKind.ES2020, jsx: ts().JsxEmit.React },
    reportDiagnostics: true,
  });
  return { outputText, codes: (diagnostics || []).map((d) => d.code) };
}

const HOST_GLOBALS = { URLSearchParams, FormData, Headers };
// Compiles `source`, runs it in a fresh context (plus `prelude`, plain JavaScript run first in the same context) and reads the
// named top-level values back. A value is JSON-normalized; `undefined` stays undefined; a throw is { threw: <error name> }.
function run(source, names, { prelude = '', after = '' } = {}) {
  const { outputText, codes } = compile(source);
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

test('a spread of each native collection, iterator, generator and host iterable contributes no element; Array.from reads them all', () => {
  for (const [label, body, values] of FAMILIES) {
    const { values: got, outputText } = run(`function make(): any { ${body} }\nconst wrong = [0, ...make()];\nconst right = [0, ...Array.from(make())];\n`, ['wrong', 'right']);
    assert.match(outputText, /__spreadArray\(\[0\], make\(\), true\)/, `${label}: ES5 emit copies it as an array-like`);
    assert.deepEqual(got.wrong, [0], `${label}: the spread adds nothing, and the elements around it survive`);
    assert.deepEqual(got.right, [0, ...values], `${label}: converted first, every value arrives in order`);
  }
});

test('a call or constructor argument spread of an iterable passes no argument; spreading Array.from passes them all', () => {
  const source = `function make(): any { return new Set(["a", "b"]); }
function collect(...items: string[]) { return items; }
function Collect(this: any, ...items: string[]) { this.items = items; }
const wrongCall = collect("x", ...make());
const rightCall = collect("x", ...Array.from(make()));
const wrongNew = new (Collect as any)(...make()).items;
const rightNew = new (Collect as any)(...Array.from(make())).items;
`;
  const { values } = run(source, ['wrongCall', 'rightCall', 'wrongNew', 'rightNew']);
  assert.deepEqual(values, { wrongCall: ['x'], rightCall: ['x', 'a', 'b'], wrongNew: [], rightNew: ['a', 'b'] });
});

test('a for...of over a Map runs zero times, pair binding included; looping over Array.from keeps the loop and its pairs', () => {
  const source = `const m = new Map([["a", 1], ["b", 2]]);
const wrong: Array<[string, number]> = [];
for (const [k, v] of m) wrong.push([k, v]);
const right: Array<[string, number]> = [];
for (const [k, v] of Array.from(m)) right.push([k, v]);
let early = "";
for (const [k] of Array.from(m)) { if (k === "b") { early = k; break; } }
`;
  const { values } = run(source, ['wrong', 'right', 'early']);
  assert.deepEqual(values, { wrong: [], right: [['a', 1], ['b', 2]], early: 'b' });
});

test('array destructuring of a Set reads indices: an element is undefined, a default replaces the value, a rest element throws', () => {
  const element = run('const [first] = new Set([1, 2]);\nconst [second] = Array.from(new Set([1, 2]));\n', ['first', 'second']);
  assert.equal(element.values.first, undefined);
  assert.equal(element.values.second, 1);
  const fallback = run('const [first = "fallback"] = new Set(["actual"]);\nconst [second = "fallback"] = Array.from(new Set(["actual"]));\n', ['first', 'second']);
  assert.deepEqual(fallback.values, { first: 'fallback', second: 'actual' });
  // A hole moves the index the element is read from; it is still not the iterator's value.
  const hole = run('const [, b] = new Set(["x", "y"]);\nconst [, c] = Array.from(new Set(["x", "y"]));\n', ['b', 'c']);
  assert.deepEqual(hole.values, { b: undefined, c: 'y' });
  const rest = run('const [...rest] = new Set([1, 2]);\n', ['rest']);
  assert.equal(rest.threw, 'TypeError', 'the emitted rest element calls slice, which a Set does not have');
  assert.match(rest.outputText, /\.slice\(0\)/);
  assert.deepEqual(run('const [...rest] = Array.from(new Set([1, 2]));\n', ['rest']).values.rest, [1, 2]);
  const assigned = run('let first: any = "before";\n([first] = new Set([1]) as any);\nlet second: any;\n([second] = Array.from(new Set([1])));\n', ['first', 'second']);
  assert.deepEqual(assigned.values, { first: undefined, second: 1 });
});

test('the unique-value idiom and a Set-based selection append lose every value; Array.from and a native Set copy keep them', () => {
  const unique = run('const xs = [1, 1, 2];\nconst wrong = [...new Set(xs)];\nconst right = Array.from(new Set(xs));\n', ['wrong', 'right']);
  assert.deepEqual(unique.values, { wrong: [], right: [1, 2] });
  const source = `const prev = new Set(["a"]);
const appended = new Set([...prev, "b"]);
const copied = new Set(prev);
copied.add("b");
const wrong = Array.from(appended);
const right = Array.from(copied);
`;
  assert.deepEqual(run(source, ['wrong', 'right']).values, { wrong: ['b'], right: ['a', 'b'] }, 'the prior selection is lost, then kept');
});

// ── Neighbours: what keeps working, and the distinct string and array-like behaviours the teaching states ───────────────────────

test('ordinary arrays, Object helpers, array-likes, arguments and native constructor copies are unaffected', () => {
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
  const { values } = run(source, ['spread', 'looped', 'head', 'keys', 'entries', 'fromLike', 'fromArguments', 'copiedSet', 'copiedMap', 'objectSpread']);
  assert.deepEqual(values, {
    spread: [1, 2, 3], looped: 3, head: 1, keys: ['a', 'b'], entries: [['a', 1]], fromLike: ['x', 'y'], fromArguments: [1, 2],
    copiedSet: [1, 2], copiedMap: [['k', 1]], objectSpread: { a: 1, b: 2 },
  });
});

test('a string spread throws, an ES5 string loop visits UTF-16 code units, and Array.from reads code points', () => {
  assert.equal(run('const name = "A😀";\nconst chars = [...name];\n', ['chars']).threw, 'TypeError');
  const { values } = run('const name = "A😀";\nconst units: string[] = [];\nfor (const c of name) units.push(c);\nconst points = Array.from(name);\nconst [first] = name;\n', ['units', 'points', 'first']);
  assert.equal(values.units.length, 3, 'the astral character is two units');
  assert.deepEqual(values.points, ['A', '😀']);
  assert.equal(values.first, 'A', 'a first-element binding reads the indexed UTF-16 element');
});

test('a rest destructure of an array-like without slice throws; a custom Symbol.matchAll that returns an array spreads fine', () => {
  assert.equal(run('const like: any = { length: 1, 0: "x" };\nconst [...rest] = like;\n', ['rest']).threw, 'TypeError');
  const source = `const matcher: any = { [Symbol.matchAll](text: string) { return [text.length]; } };
const hits = [..."abc".matchAll(matcher)];
`;
  assert.deepEqual(run(source, ['hits']).values.hits, [3], 'the string method delegates to the matcher, which may return an array');
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

// What each pair is taught to do: the WRONG example's emitted result, then the CORRECT one's.
const TAUGHT = {
  'Map values': { name: 'choices', wrong: [], right: [1, 2] },
  'Unique values': { name: 'unique', wrong: [], right: [1, 2] },
  'Map pairs': { name: 'rows', wrong: [], right: [['a', 1], ['b', 2]] },
  'Native matchAll result': { name: 'hits', wrong: [], right: ['1', '2'] },
  'String spread — a separate throw, not an empty iterable result': { name: 'chars', wrong: 'throws', right: ['A', '😀'] },
};

test('Common Errors §5 holds separate WRONG and CORRECT fences, and each compiles under the SDK options and does what it says', () => {
  const { examples } = teaching();
  assert.ok(examples.length >= 16, 'the pairs are there');
  for (const example of examples) {
    assert.ok(example.role, `every fence in the section opens with // WRONG or // CORRECT (${example.label})`);
    assert.equal((example.code.match(/\/\/ (?:WRONG|CORRECT)\b/g) || []).length, 1, `one role per fence, never a WRONG and a CORRECT in one scope (${example.label})`);
    assert.deepEqual(compile(example.code).codes, [], `${example.label} ${example.role} compiles`);
  }
  for (const [label, { name, wrong, right }] of Object.entries(TAUGHT)) {
    const pair = examples.filter((example) => example.label === label);
    assert.deepEqual(pair.map((example) => example.role), ['WRONG', 'CORRECT'], `${label}: one WRONG, then one CORRECT`);
    const [bad, good] = pair.map((example) => run(example.code, [name]));
    if (wrong === 'throws') assert.equal(bad.threw, 'TypeError', `${label}: the WRONG example throws`);
    else assert.deepEqual(bad.values[name], wrong, `${label}: the WRONG example loses the values`);
    assert.deepEqual(good.values[name], right, `${label}: the CORRECT example keeps them`);
  }
});

test('the destructuring pairs: an undefined element, a default that replaces the value, and a rest element that throws', () => {
  const pairs = teaching().examples.filter((example) => example.label === 'Destructuring');
  assert.deepEqual(pairs.map((example) => example.role), ['WRONG', 'CORRECT', 'WRONG', 'CORRECT', 'WRONG', 'CORRECT']);
  const [elementBad, elementGood, defaultBad, defaultGood, restBad, restGood] = pairs.map((example) => run(example.code, /\.\.\.rest/.test(example.code) ? ['rest'] : ['first']));
  assert.equal(elementBad.values.first, undefined);
  assert.equal(elementGood.values.first, 1);
  assert.equal(defaultBad.values.first, 'fallback');
  assert.equal(defaultGood.values.first, 'actual');
  assert.equal(restBad.threw, 'TypeError');
  assert.deepEqual(restGood.values.rest, [1, 2]);
});

// The selection examples are component-body code: they run here under a controlled `React.useState` whose state already holds a
// prior selection, and the handler is called as an event would call it — never a setter called unconditionally during render.
test('the selection-state pair: the WRONG updater loses the prior ids and its render read loses every value; the CORRECT one keeps them', () => {
  const pair = teaching().examples.filter((example) => /^Selection state/.test(example.label || ''));
  assert.deepEqual(pair.map((example) => example.role), ['WRONG', 'CORRECT']);
  const prelude = `var __state = new Set(["a"]);
var React = { useState: function () { return [__state, function (next) { __state = typeof next === "function" ? next(__state) : next; }]; } };`;
  const after = 'addSelected("b"); var __after = Array.from(__state); var __render = chosen;';
  const [bad, good] = pair.map((example) => {
    assert.doesNotMatch(example.code, /^set[A-Z]\w*\(/m, 'no setter is called at the top level of the render');
    return run(example.code, ['__after', '__render'], { prelude, after });
  });
  assert.deepEqual(bad.values, { __after: ['b'], __render: [] }, 'the updater keeps only the new id, and the render read is empty');
  assert.deepEqual(good.values, { __after: ['a', 'b'], __render: ['a'] }, 'the native copy keeps the prior id, and Array.from reads the selection');
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
  assert.match(rule[1], /See \*\*Common Errors > 5\. Iteration that compiles to nothing\*\*\.$/);
  assert.equal(RULES.split(`\n${HEADING}\n`).length, 2, 'one canonical section');
});
