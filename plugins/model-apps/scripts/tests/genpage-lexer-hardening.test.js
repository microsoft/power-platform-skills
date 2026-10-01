'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { blankNonCodePreservingTemplateExpressions, hasDefaultExport } = require(path.join(__dirname, '..', 'lib', 'source-literals.js'));
const { pageStructureProblems } = require(path.join(__dirname, '..', 'lib', 'page-structure.js'));
const { extractNavTargets, navReferencedKeys } = require(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'));

function runNavigationSnippet(code) {
  const calls = [];
  const record = (name) => (arg) => calls.push({ name, pageType: arg && arg.pageType, pageId: arg && arg.pageId, pageIdType: typeof (arg && arg.pageId) });
  const sandbox = {
    calls,
    navigateTo: record('navigateTo'),
    notnavigateTo: record('notnavigateTo'),
    $navigateTo: record('$navigateTo'),
    αnavigateTo: record('αnavigateTo'),
    Xrm: { Navigation: { navigateTo: record('Xrm.Navigation.navigateTo') } },
    base: {},
    name: 'pageId',
    pageId: 'runtime',
    pageType: 'entityrecord',
  };
  vm.runInNewContext(code, sandbox, { timeout: 1000 });
  return calls;
}

function canonicalCalls(calls) {
  return calls.filter((call) => /(?:^|\.)navigateTo$/.test(call.name) && call.pageType === 'generative' && call.pageIdType === 'string' && /^PAGEREF_[A-Za-z0-9_-]+$/.test(call.pageId));
}

test('execution oracle: resolver agrees with JavaScript calls and object-literal runtime values', () => {
  const cases = [
    ['bare', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})', true],
    ['member', 'Xrm.Navigation.navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})', true],
    ['member optional', 'Xrm.Navigation.navigateTo?.({pageType:"generative",pageId:"PAGEREF_detail"})', true],
    ['chain optional', 'Xrm?.Navigation?.navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})', true],
    ['escaped navigateTo', 'navigate\\u0054o({pageType:"generative",pageId:"PAGEREF_detail"})', true],
    ['not same identifier', 'notnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"})', false],
    ['dollar prefix', '$navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})', false],
    ['unicode prefix', 'αnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"})', false],
    ['method override', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",pageId(){return "runtime";}})', false],
    ['getter override', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",get pageId(){return "runtime";}})', false],
    ['setter override', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",set pageId(v){}})', false],
    ['shorthand override', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",pageId})', false],
    ['computed override', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",[name]:"runtime"})', false],
    ['spread override', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",...{pageId:"runtime"}})', false],
    ['later literal wins', 'navigateTo({pageType:"generative",pageId(){return "runtime";},pageId:"PAGEREF_detail"})', true],
    ['pageType method override', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",pageType(){return "entityrecord";}})', false],
    ['pageType later literal wins', 'navigateTo({pageType(){return "entityrecord";},pageType:"generative",pageId:"PAGEREF_detail"})', true],
    ['comment decoy', '// navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})\nnavigateTo({pageType:"generative",pageId:"PAGEREF_real"})', true],
    ['comment naming the key', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",/* keep pageId */data:"x"})', true],
    ['line comment naming the key', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail", // pageId stays\n data:"x"})', true],
    ['comment naming pageType', 'navigateTo({pageId:"PAGEREF_detail",pageType:"generative",/* pageType */ data:1})', true],
    ['string decoy', 'const s = "navigateTo({pageType:\\"generative\\",pageId:\\"PAGEREF_detail\\"})"; navigateTo({pageType:"generative",pageId:"PAGEREF_real"})', true],
  ];
  for (const [label, code, expectCanonical] of cases) {
    const executed = canonicalCalls(runNavigationSnippet(code));
    const targets = extractNavTargets(code).filter((target) => target.kind === 'pageref');
    assert.strictEqual(targets.length > 0, expectCanonical, label);
    assert.strictEqual(executed.length > 0, expectCanonical, label);
    if (expectCanonical) assert.deepStrictEqual(targets.map((target) => `PAGEREF_${target.key}`), executed.map((call) => call.pageId), label);
  }
});

// A quoted key is the string JavaScript reads, escapes included: `"page\u{49}d"` IS `pageId` at runtime, and `"page\tId"`
// is not. Each case runs in JavaScript too, so the resolver is judged against the real object.
test('execution oracle: quoted keys are read with JavaScript escape semantics', () => {
  const cases = [
    ['unicode escapes', 'navigateTo({"page\\u0054ype":"generative","page\\u{49}d":"PAGEREF_detail"})', true],
    ['hex escape', 'navigateTo({"pageType":"generative",\'page\\x49d\':"PAGEREF_detail"})', true],
    ['identity escape', 'navigateTo({"pageType":"generative","pageI\\d":"PAGEREF_detail"})', true],
    ['astral code point', 'navigateTo({"pageType":"generative","pageId":"PAGEREF_detail","\\u{1F600}":1})', true],
    ['tab in the key', 'navigateTo({"pageType":"generative","page\\tId":"PAGEREF_detail"})', false],
    ['NUL in the key', 'navigateTo({"pageType":"generative","pageId\\0":"PAGEREF_detail"})', false],
    ['escaped quote', 'navigateTo({"pageType":"generative","pageId\\"":"PAGEREF_detail"})', false],
    ['escaped backslash', 'navigateTo({"pageType":"generative","pageId\\\\":"PAGEREF_detail"})', false],
  ];
  for (const [label, code, expectCanonical] of cases) {
    const executed = canonicalCalls(runNavigationSnippet(code));
    const targets = extractNavTargets(code).filter((target) => target.kind === 'pageref');
    assert.strictEqual(executed.length > 0, expectCanonical, `${label}: JavaScript`);
    assert.strictEqual(targets.length > 0, expectCanonical, `${label}: resolver`);
  }
  // A malformed escape, which JavaScript refuses to compile, never names a key — and neither does an unclosed
  // computed key, which leaves the literal before it unresolvable.
  for (const code of [
    'navigateTo({"pageType":"generative","page\\u{110000}Id":"PAGEREF_detail"})',
    'navigateTo({"pageType":"generative","page\\u{zz}Id":"PAGEREF_detail"})',
    'navigateTo({"pageType":"generative","page\\u00GId":"PAGEREF_detail"})',
    'navigateTo({"pageType":"generative","page\\u{49":"PAGEREF_detail"})',
    'navigateTo({"pageType":"generative","page\\x4":"PAGEREF_detail"})',
    'navigateTo({"pageType":"generative","pageId\\',
    'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",[name})',
  ]) {
    assert.throws(() => runNavigationSnippet(code), { name: 'SyntaxError' }, code);
    assert.deepStrictEqual(extractNavTargets(code).filter((target) => target.kind === 'pageref'), [], code);
  }
});

test('lexer and resolver handle ECMAScript line terminators in comments and structure gate', () => {
  for (const term of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
    const code = `// inert${term}navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})`;
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], `navigation after ${JSON.stringify(term)}`);
    assert.deepStrictEqual(pageStructureProblems(`// header${term}export default function Page() { return null; }\n`), [], `structure after ${JSON.stringify(term)}`);
  }
});

function nestedTemplate(depth) {
  return 'export default ()=>null;\nconst x=' + '`${'.repeat(depth) + '1' + '}`'.repeat(depth) + ';';
}

function measure(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

test('performance: nested templates are linear and stack-safe', () => {
  const code = nestedTemplate(1000);
  assert.ok(measure(() => blankNonCodePreservingTemplateExpressions(code)) < 500, 'mask depth 1000');
  assert.ok(measure(() => extractNavTargets(code)) < 500, 'nav extraction depth 1000');
  assert.ok(measure(() => pageStructureProblems(code)) < 500, 'structure gate depth 1000');
  assert.doesNotThrow(() => blankNonCodePreservingTemplateExpressions(nestedTemplate(10000)));
});

test('performance: malformed and dense navigation scans remain linear', () => {
  const malformed = 'export default ()=>null;\n' + 'navigateTo({'.repeat(Math.ceil((64 * 1024) / 'navigateTo({'.length));
  assert.ok(measure(() => extractNavTargets(malformed)) < 300, '64 KiB unclosed navigateTo calls');
  const denseCall = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});';
  const dense = denseCall.repeat(Math.ceil((512 * 1024) / denseCall.length));
  const ms = measure(() => extractNavTargets(dense));
  assert.ok(ms < 1500, `512 KiB dense valid calls took ${ms.toFixed(1)} ms`);
});

// A comment inside a navigation call is blank in the mask, and the property scan once looked back across the whole
// blank run from every character of it: 2,000 / 4,000 / 8,000 / 16,000 characters took about 0.4 / 1.3 / 4.4 / 19 s.
test('performance: a long comment inside a navigation call stays linear', () => {
  const call = (n) => `navigateTo({pageType:"generative",/* ${'c'.repeat(n)} */pageId:"PAGEREF_detail"});`;
  const best = (code) => Math.min(measure(() => extractNavTargets(code)), measure(() => extractNavTargets(code)), measure(() => extractNavTargets(code)));
  extractNavTargets(call(1000)); // warm up
  const [tSmall, tLarge] = [best(call(16000)), best(call(64000))];
  assert.deepStrictEqual(extractNavTargets(call(64000)).map((t) => [t.kind, t.key]), [['pageref', 'detail']]);
  assert.ok(tLarge < 500, `a 64,000-character comment took ${tLarge.toFixed(1)} ms`);
  assert.ok(tLarge / Math.max(tSmall, 1) < 9, `4x the comment took ${(tLarge / Math.max(tSmall, 1)).toFixed(1)}x the time (${tSmall.toFixed(1)} -> ${tLarge.toFixed(1)} ms)`);
});
test('lexer keeps LS and PS legal inside string literals while comments still terminate on them', () => {
  assert.equal(hasDefaultExport('const s = "a\u2028b";\nexport default function Page() { return null; }\n'), true);
  assert.equal(hasDefaultExport('const s = "a\u2029b";\nexport default function Page() { return null; }\n'), true);
  assert.deepStrictEqual(navReferencedKeys('const s = "a\u2028navigateTo({pageType:\"generative\",pageId:\"PAGEREF_detail\"})";'), []);
  assert.deepStrictEqual(navReferencedKeys('const s = "a\u2029navigateTo({pageType:\"generative\",pageId:\"PAGEREF_detail\"})";'), []);
});

function nestedFamily(kind, depth) {
  if (kind === 'digit') return 'export default ()=>null;\nconst x=' + '`${'.repeat(depth) + '1' + '}`'.repeat(depth) + ';';
  if (kind === 'ident') return 'export default ()=>null;\nconst x=' + '`${'.repeat(depth) + 'y' + '}`'.repeat(depth) + ';';
  if (kind === 'text') return 'export default ()=>null;\nconst x=' + '`a${'.repeat(depth) + 'y' + '}b`'.repeat(depth) + ';';
  if (kind === 'call') return 'export default ()=>null;\nconst x=' + '`${f('.repeat(depth) + 'y' + ')}`'.repeat(depth) + ';';
  if (kind === 'jsx') return 'export default ()=>null;\nconst x=' + '`${'.repeat(depth) + '<span>{y}</span>' + '}`'.repeat(depth) + ';';
  if (kind === 'arrow-object') return 'export default ()=>null;\nconst x=' + '`${'.repeat(depth) + '(() => ({ y }))()' + '}`'.repeat(depth) + ';';
  if (kind === 'object-braces') return 'export default ()=>null;\nconst x=' + '`${'.repeat(depth) + '({ a: { b: y } }).a.b' + '}`'.repeat(depth) + ';';
  throw new Error(kind);
}

test('performance: nested template families scale through the general scanner', () => {
  for (const kind of ['digit', 'ident', 'text', 'call', 'jsx', 'arrow-object', 'object-braces']) {
    const code = nestedFamily(kind, 1000);
    assert.ok(measure(() => blankNonCodePreservingTemplateExpressions(code)) < 250, `${kind}: template-preserving mask`);
    assert.ok(measure(() => extractNavTargets(code)) < 250, `${kind}: nav extraction`);
    assert.ok(measure(() => pageStructureProblems(code)) < 250, `${kind}: structure gate`);
  }
});

// Ordinary pages hold MANY shallow templates rather than one deep one, and a fix for depth must not tax
// them: an earlier attempt re-walked every template seen so far for each `${…}` body, and a 154 KB page
// of plain one-line templates took 18 seconds. Both views now come from one lexing pass, so time grows
// with size — about 4x for 4x the source; quadratic growth would be about 16x.
function shallowPage(lines) {
  return 'import * as React from "react";\n'
    + Array.from({ length: lines }, (_, i) => `const v${i} = \`a\${b(${i})}c\${\`d\${e}\`}\`; const s${i} = "t" + f(${i});`).join('\n')
    + '\nexport default function Page() { return <div className={`x ${v0}`}>{s0}</div>; }\n';
}

test('performance: many shallow templates stay linear', () => {
  const all = (code) => {
    blankNonCodePreservingTemplateExpressions(code);
    extractNavTargets(code);
    pageStructureProblems(code);
  };
  const best = (code) => Math.min(measure(() => all(code)), measure(() => all(code)), measure(() => all(code)));
  const small = shallowPage(1000);
  const large = shallowPage(4000);
  all(small); // warm up
  const [tSmall, tLarge] = [best(small), best(large)];
  assert.ok(tLarge < 1500, `${(large.length / 1024).toFixed(0)} KB of shallow templates took ${tLarge.toFixed(1)} ms`);
  assert.ok(tLarge / Math.max(tSmall, 1) < 9, `4x the source took ${(tLarge / Math.max(tSmall, 1)).toFixed(1)}x the time (${tSmall.toFixed(1)} -> ${tLarge.toFixed(1)} ms)`);
});

// Page source is untrusted, so its nesting may not decide whether the lexer finishes: the lexer keeps
// its frames on the heap, and a template nested 50,000 deep is read like any other.
test('lexer finishes at any template nesting depth', () => {
  const code = nestedFamily('ident', 50000);
  const mask = blankNonCodePreservingTemplateExpressions(code);
  assert.strictEqual(mask.length, code.length);
  assert.strictEqual(hasDefaultExport(code), true);
  assert.deepStrictEqual(pageStructureProblems(code), []);
});
