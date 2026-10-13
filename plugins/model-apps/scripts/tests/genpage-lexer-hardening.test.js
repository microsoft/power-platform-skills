'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const v8 = require('node:v8');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { blankNonCodePreservingTemplateExpressions, hasDefaultExport } = require(path.join(__dirname, '..', 'lib', 'source-literals.js'));
const { pageStructureProblems } = require(path.join(__dirname, '..', 'lib', 'page-structure.js'));
const { extractNavTargets, navReferencedKeys, navMalformedRefs, navigationFrontier, resolvePageRefs, strayPageRefs } = require(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'));
const { OBJECT_DIVISION_PAGE_RUNNABLE, MISREAD_PAGES, runnable } = require('./helpers/misread-page.js');

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

// `navigateTo((OBJECT).pageId.length === 14 ? a : b)` reads the object for its pageId, so swapping the 14-character token for a page id
// changes which branch runs; `factory(navigateTo)(OBJECT)` hands the object to whatever factory returns. Neither hands it to
// navigateTo as the argument, so neither is rewritten — while the same navigation written plainly is, and receives the page id.
test('execution oracle: only a call that hands the object to navigateTo is rewritten', () => {
  const OBJECT = '{ pageType: "generative", pageId: "PAGEREF_detail" }';
  const PAGE_ID = '11111111-1111-4111-8111-111111111111';
  const resolved = (code) => resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', PAGE_ID]])).deployment.get('x');
  const run = (code) => {
    const seen = [];
    vm.runInNewContext(code, {
      navigateTo: (arg) => seen.push(arg),
      factory: () => (arg) => seen.push(['factory', arg && arg.pageId]),
      tag: () => (fn) => (arg) => seen.push(['tag', arg && arg.pageId]),
      f: (arg) => seen.push(['f', arg && arg.pageId]),
      a: 'first',
      b: 'second',
    }, { timeout: 1000 });
    return seen;
  };
  const untouched = {
    'a condition on the object': `navigateTo((${OBJECT}).pageId.length === 14 ? a : b)`,
    'a callee that is an argument': `factory(navigateTo)(${OBJECT})`,
    'a callee after a tagged template': `tag\`x\`(navigateTo)(${OBJECT})`,
    'a callee after a function expression': `const g = function () { return f; }(navigateTo)(${OBJECT})`,
    'the object read for another member': `navigateTo(${OBJECT}.pageId)`,
    'a comma expression': `navigateTo((${OBJECT}, a))`,
  };
  for (const [what, code] of Object.entries(untouched)) {
    assert.strictEqual(resolved(code), code, `${what}: not rewritten`);
    assert.deepStrictEqual(run(resolved(code)), run(code), `${what}: the page does what it did`);
    assert.deepStrictEqual(strayPageRefs(code).map((r) => r.token), ['PAGEREF_detail'], `${what}: reported, so the build stops`);
  }
  assert.deepStrictEqual(run(untouched['a condition on the object']), ['first'], 'the branch the token selects');
  for (const code of [`navigateTo(${OBJECT})`, `navigateTo((${OBJECT}))`, `(navigateTo)(${OBJECT})`, `x = 1; (navigateTo)(${OBJECT}, 2)`, `navigateTo?.((${OBJECT}))`]) {
    const [call] = run(resolved(code));
    assert.strictEqual(call.pageId, PAGE_ID, `${code}: the call receives the page id`);
    assert.strictEqual(call.pageType, 'generative', code);
  }
});

// The misread pages. JavaScript navigates twice in the first (to the token both times), and the lexer reads the `/` after the object
// literal as a regex that ends at the real regex's opening `/`, and the `/*` in `/\/*$/` as a comment over the second call. Resolving the
// call the oracle sees leaves a page that navigates to [page id, "PAGEREF_detail"] — a dead link — with parity, promotion and the residue
// check all passing. In the others the lexer reads the TEXT of a regex or a string as a call, and a rewrite would change what the regex
// matches or what the string says. The invariant, run in a JavaScript engine: whatever the resolver rewrites leaves every regex and string
// as it was, and a page that still hands a token to navigateTo is refused, the first guess named.
test('execution oracle: a page the lexer reads wrongly cannot hide a navigation call, or have the text of a regex or string rewritten as one', () => {
  const PAGE_ID = '11111111-1111-4111-8111-111111111111';
  const exec = (code) => {
    const calls = [];
    const tested = [];
    const context = vm.createContext({ navigateTo: (options) => calls.push(options.pageId), __tested: tested });
    vm.runInContext('RegExp.prototype.test = function () { __tested.push(this.source); return false; };', context);
    vm.runInContext(code, context, { timeout: 1000 });
    return { calls, tested };
  };
  const pageIds = (code) => exec(code).calls;
  assert.deepStrictEqual(pageIds(OBJECT_DIVISION_PAGE_RUNNABLE), ['PAGEREF_detail', 'PAGEREF_detail'], 'JavaScript navigates twice');
  const { deployment, residual } = resolvePageRefs(new Map([['page', { code: OBJECT_DIVISION_PAGE_RUNNABLE }]]), new Map([['detail', PAGE_ID]]));
  assert.deepStrictEqual(pageIds(deployment.get('page')), [PAGE_ID, 'PAGEREF_detail'], 'the resolver alone leaves the page half resolved');
  assert.deepStrictEqual(residual.map((r) => [r.token, r.line, r.frontier.kind, r.frontier.line]), [['PAGEREF_detail', 5, 'brace', 4]], 'and the residue names the call it could not see');
  assert.deepStrictEqual(strayPageRefs(OBJECT_DIVISION_PAGE_RUNNABLE).map((r) => [r.token, r.line, r.frontier.kind, r.frontier.line]), [['PAGEREF_detail', 5, 'brace', 4]]);
  for (const name of ['brace', 'paren', 'keyword']) {
    const page = runnable(MISREAD_PAGES[name].code);
    const before = exec(page);
    const resolved = resolvePageRefs(new Map([['page', { code: page }]]), new Map([['detail', PAGE_ID]]));
    const after = exec(resolved.deployment.get('page'));
    assert.deepStrictEqual(after.tested, before.tested, `${name}: no regex is rewritten`);
    assert.ok(after.calls.length === before.calls.length, `${name}: the page still makes every call it made`);
    const refused = strayPageRefs(page);
    assert.ok(refused.length > 0 && refused.every((r) => r.frontier.kind === name), `${name}: refused, naming the guess`);
    assert.ok(!after.calls.includes('PAGEREF_detail') || resolved.residual.length > 0, `${name}: a token that still ships is in the residue`);
    assert.deepStrictEqual(resolved.residual.map((r) => r.line), refused.map((r) => r.line), `${name}: the residue is what the report names`);
  }
  // With the operand in parentheses the page is read as JavaScript reads it: both calls are found and resolved, and nothing is left.
  const fixed = OBJECT_DIVISION_PAGE_RUNNABLE.replace('{valueOf(){return 12;}, ...extras}/2', '({valueOf(){return 12;}, ...extras})/2');
  assert.notStrictEqual(fixed, OBJECT_DIVISION_PAGE_RUNNABLE);
  assert.deepStrictEqual(strayPageRefs(fixed), []);
  const clean = resolvePageRefs(new Map([['page', { code: fixed }]]), new Map([['detail', PAGE_ID]]));
  assert.deepStrictEqual(pageIds(clean.deployment.get('page')), [PAGE_ID, PAGE_ID]);
  assert.deepStrictEqual(clean.residual, []);
});

test('lexer and resolver handle ECMAScript line terminators in comments and structure gate', () => {
  for (const term of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
    const code = `// inert${term}navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})`;
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], `navigation after ${JSON.stringify(term)}`);
    assert.deepStrictEqual(pageStructureProblems(`// header${term}export default function Page() { return null; }\n`), [], `structure after ${JSON.stringify(term)}`);
  }
});

// A `>` in JSX text does not compile (TS1382), so `<Name>(…) =>` is no element: a generic function type is a type wherever it stands. A page that holds
// one is as complete to the structure gate as it was before the rule for a `<` was TypeScript's own — read as the start of a JSX element it made the
// rest of the file its text, and the page "truncated" — and the call after it is a call, and resolves.
test('a page that holds a generic function type passes the structure gate, and the call after it resolves', () => {
  const component = [
    'export default function Page() {',
    '  const go = () => navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});',
    '  return <div onClick={go}>x</div>;',
    '}',
    '',
  ].join('\n');
  for (const [what, type] of [
    ['an annotation', 'const handler: <T>(x: T) => void = () => {};'],
    ['an interface member', 'interface Props { onPick: <K>(key: K) => void; }'],
    ['a parameter type', 'function run(cb: <U>(x: U) => void) { cb(1); }'],
    ['the right side of an alias with type parameters', 'type Handler<A> = <T>(x: T) => A;'],
    ['an alias head', 'type Handler = <T>(x: T) => void;'],
    ['an exported alias head', 'export type Handler = <T>(x: T) => void;'],
    ['a member of a type literal', 'let holder: { cb: <T>(x: T) => void };'],
  ]) {
    const code = `${type}\n${component}`;
    assert.deepStrictEqual(pageStructureProblems(code), [], `${what}: a complete page`);
    assert.strictEqual(navigationFrontier(code), null, `${what}: no guess`);
    assert.deepStrictEqual(strayPageRefs(code), [], what);
    const resolved = resolvePageRefs(new Map([['page', { code }]]), new Map([['detail', 'gp-detail']]));
    assert.strictEqual(resolved.deployment.get('page'), code.replace('"PAGEREF_detail"', '"gp-detail"'), `${what}: the call resolves`);
    assert.deepStrictEqual([resolved.unresolved, resolved.residual], [[], []], what);
    assert.deepStrictEqual(pageStructureProblems(resolved.deployment.get('page')), [], `${what}: and so does what is deployed`);
  }
  // JSX text that starts with a parenthesis and a colon is read right, as the element it is: the page is complete — and the call after it, which is
  // after the guess, is refused, naming it.
  const label = 'export default function Page() {\n  const label = <span>(required): Name</span>;\n  navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});\n  return label;\n}\n';
  assert.deepStrictEqual(pageStructureProblems(label), []);
  assert.deepStrictEqual(strayPageRefs(label).map((r) => [r.token, r.frontier.kind]), [['PAGEREF_detail', 'generic']]);
  // A call signature is the other reading of the same shape. It is read as an element whose text runs on, so the structure gate finds the page
  // incomplete — fail-closed, as it has always been for a call signature — and the call after it is refused, naming the guess.
  const signature = `interface Callable { <T>(x: T): T }\n${component}`;
  assert.ok(pageStructureProblems(signature).length > 0, 'refused as truncated');
  assert.deepStrictEqual(strayPageRefs(signature).map((r) => [r.token, r.frontier.kind]), [['PAGEREF_detail', 'generic']]);
});

// A `>` in the text of an element's children does not compile (TS1382), and neither do the other things TypeScript rejects in an element: a `}`, a container that starts with a
// name and a colon, two names, a bracket and a colon, a call and a colon, a quoted name and a colon or a call, a `<` and a character that cannot start a tag, a tag name and a token that
// is no attribute (source-literals.js, elementFailsAt). A function type whose parameter list holds a type argument (`<T>(x: Array<T>) => void`), an object type with named, readonly,
// indexed or method members (a quoted method name included), a destructured parameter or a comma between type arguments is therefore a type, for certain, wherever it stands: the page is
// complete and the call after it resolves. What the reading cannot show to fail — a generic or optional quoted method, a call signature with an object type in it, a comment after a
// member — is read as a type and reported (`generic`): the page is still complete, and the call after it is refused, naming the guess. (It was read as an element whose text ran on, and
// every page that held one was refused as truncated.)
test('a function type whose parameter list holds a "<" or "{" is certain where an element could not parse it, and a guess read as a type where it could', () => {
  const component = [
    'export default function Page() {',
    '  const go = () => navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});',
    '  return <div onClick={go}>x</div>;',
    '}',
    '',
  ].join('\n');
  for (const [what, type] of [
    ['an annotation with a type argument', 'const handler: <T>(x: Array<T>) => void = () => {};'],
    ['an annotation with an object type', 'const handler: <T>(o: { a: T }) => void = () => {};'],
    ['an interface member', 'interface Props { onPick: <K>(items: Array<K>) => void; }'],
    ['an alias with type parameters', 'type Handler<A> = <T>(x: Array<T>) => A;'],
    ['a comma between type arguments', 'const handler: <T>(m: Record<string, T>) => void = () => {};'],
    ['nested type arguments', 'const handler: <T>(x: Promise<Array<T>>) => void = () => {};'],
    ['an alias head', 'type Handler = <T>(x: Array<T>) => void;'],
    ['an exported alias head with an object type', 'export type Handler = <T>(o: { a: T }) => void;'],
    ['a constraint', 'const handler: <T extends object>(x: Array<T>) => void = () => {};'],
    ['a list with neither character', 'const handler: <T>(x: T[]) => void = () => {};'],
    ['a destructured parameter', 'const handler: <T>({ a }: P) => void = () => {};'],
    ['an index signature', 'interface Props { onPick: <K>(items: { [key: string]: K }) => void; }'],
    ['a readonly member', 'type Handler<A> = <T>(x: { readonly a: T }) => A;'],
    ['an empty object type', 'const handler: <T>(x: {}) => void = () => {};'],
    ['a method signature', 'const handler: <T>(x: { m(y: T): T }) => void = () => {};'],
    ['a quoted key', "const handler: <T>(x: { 'a': T }) => void = () => {};"],
    ['a number key', 'const handler: <T>(x: { 1: T }) => void = () => {};'],
    ['a call signature', 'const handler: <T>(x: { (y: T): T }) => void = () => {};'],
    ['a computed method', 'interface Props { onPick: <K>(items: { [Symbol.iterator](): K }) => void; }'],
    ['an optional method', 'type Handler<A> = <T>(x: { m?(y: T): T }) => A;'],
    ['a default value', 'const handler: <T>({ a = 1 }: P) => void = () => {};'],
    ['a quoted method name', "const handler: <T>(x: { 'a'(y: T): T }) => void = () => {};"],
    ['a string in a method name', 'interface Props { onPick: <K>(items: { "a"(y: K): K }) => void; }'],
    ['a quoted method name with an escape', "const handler: <T>(x: { 'a\\'b'(y: T): T }) => void = () => {};"],
    ['a quoted method with no parameter', 'type Handler = <T>(x: { "m"(): T }) => void;'],
    ['a quoted method with two parameters', "const handler: <T>(x: { 'm'(a, b): T }) => void = () => {};"],
    ['a comment in an object type', 'type Handler<A> = <T>(x: { /* c */ a: T }) => A;'],
    ['a line comment in an object type', 'type Handler<A> = <T>(x: { // c\n a: T }) => A;'],
    ['a comment before a modifier', 'const handler: <T>(x: { /* c */ readonly a: T }) => void = () => {};'],
    ['a comment after a call signature', 'type Handler<A> = <T>(x: { (y: T): T /* c */ }) => A;'],
  ]) {
    const code = `${type}\n${component}`;
    assert.deepStrictEqual(pageStructureProblems(code), [], `${what}: a complete page`);
    assert.deepStrictEqual(strayPageRefs(code), [], `${what}: the call after it resolves`);
  }
  for (const [what, type] of [
    ['an optional quoted method', "const handler: <T>(x: { 'a'?(y: T): T }) => void = () => {};"],
    ['a call signature with an object type in it', 'const handler: <T>(x: { (y: { a: T }): T }) => void = () => {};'],
    ['a generic quoted method', 'interface Props { onPick: <K>(items: { "a"<U>(y: K): K }) => void; }'],
  ]) {
    const code = `${type}\n${component}`;
    assert.deepStrictEqual(pageStructureProblems(code), [], `${what}: still a complete page`);
    assert.deepStrictEqual(strayPageRefs(code).map((r) => r.frontier && r.frontier.kind), ['generic'], `${what}: the call after it is refused, naming the guess`);
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

// The token before a `<` is read from the run of sign characters that ends there, and in `<></>=<></>=…` every character is one, so a scan that went back over the whole
// run before each `<` was quadratic (15 seconds for 5,000 groups). It reads the last RUN_LIMIT characters.
test('performance: the token before a "<" is read in constant time, however long the run of sign characters before it', () => {
  const code = 'export default ()=>null;\nconst x=' + '<></>='.repeat(5000) + '1;';
  assert.ok(measure(() => blankNonCodePreservingTemplateExpressions(code)) < 2000, 'mask, 5,000 fragments');
  assert.ok(measure(() => extractNavTargets(code)) < 2000, 'nav extraction, 5,000 fragments');
  const long = 'x ' + '='.repeat(1e6) + '<T extends X>MARK</T>;';
  assert.ok(measure(() => blankNonCodePreservingTemplateExpressions(long)) < 2000, 'mask, a million equals signs before one `<`');
});

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

// The same holds for a run of operators the position table reads through: each `!`, and each `++` or `--`, takes its meaning from what stands
// before it (postfix after an operand, prefix after a line break or where an expression starts), so the table walks back over the whole
// run. It did that by calling itself once per operator, which overflowed the call stack a few thousand operators in — on source nobody wrote.
test('lexer finishes at any length of a run of "!", "++" and "--", and reads the end of the run as the grammar does', () => {
  const N = 50000;
  const mask = (code) => blankNonCodePreservingTemplateExpressions(code);
  const runs = {
    'bangs': '!'.repeat(N),
    'spaced bangs': ' !'.repeat(N),
    'increments': ' ++'.repeat(N),
    'decrements': ' --'.repeat(N),
    'bangs and increments': ' ! ++ --'.repeat(N),
  };
  for (const [name, run] of Object.entries(runs)) {
    // On the line of an operand each is postfix, so the `/` after the run divides: its operands are code.
    const postfix = `const q = a${run} /navigateTo({pageId:"PAGEREF_x"})/ 3;`;
    assert.ok(mask(postfix).includes('navigateTo'), `${name}: a division after an operand, whose operands are code`);
    // After a line break the first operator is a prefix one, and so is every one after it: the `/` is a regex.
    const prefix = `const q = a\n${run} /navigateTo({pageId:"PAGEREF_x"})/.test(y);`;
    assert.ok(!mask(prefix).includes('navigateTo'), `${name}: a regex after a prefix operator, whose body is not code`);
    assert.strictEqual(mask(prefix).length, prefix.length);
    assert.strictEqual(hasDefaultExport(`${prefix}\nexport default function P() { return null; }\n`), true, `${name}: the rest of the page is read`);
  }
});

// The resolver is judged against JavaScript itself: a rewrite may change the pageId of a call JavaScript really makes
// with pageType "generative" and the string "PAGEREF_<key>", and nothing else. A value with an expression tail
// (`"PAGEREF_detail".slice(8)` is "detail") or a pageType that is an expression (`"generative" && "entityrecord"` is
// "entityrecord") is not that call, and rewriting its literal changed what the page navigates to.
test('execution oracle: a rewrite changes only the calls JavaScript makes with a canonical pageref, and finds every spelling', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const obj = '{pageType:"generative",pageId:"PAGEREF_detail"}';
  // [label, source, does JavaScript call navigateTo with pageType "generative" and a PAGEREF_ string,
  //  does the resolver rewrite it]. Where the resolver cannot be sure of a value it leaves the source alone and
  // reports the token (malformed or stray), even when JavaScript would have used it: `"PAGEREF_detail" || "x"`.
  const cases = [
    ['plain', `navigateTo(${obj})`, true, true],
    ['&&', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail" && "runtime"})', false, false],
    ['||', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail" || "runtime"})', true, false],
    ['??', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail" ?? "runtime"})', true, false],
    ['conditional', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail" ? "runtime" : "other"})', false, false],
    ['slice', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail".slice(8)})', false, false],
    ['toLowerCase', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail".toLowerCase()})', false, false],
    ['index', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"[0]})', false, false],
    ['concatenation', 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail" + "x"})', true, false],
    ['pageType &&', 'navigateTo({pageType:"generative" && "entityrecord",pageId:"PAGEREF_detail"})', false, false],
    ['pageType ||', 'navigateTo({pageType:"generative" || "entityrecord",pageId:"PAGEREF_detail"})', true, false],
    ['pageType conditional', 'navigateTo({pageType:true ? "entityrecord" : "generative",pageId:"PAGEREF_detail"})', false, false],
    ['pageType concatenation', 'navigateTo({pageType:"gener" + "ative",pageId:"PAGEREF_detail"})', true, false],
    ['parenthesised callee', `(navigateTo)(${obj})`, true, true],
    ['parenthesised argument', `navigateTo((${obj}))`, true, true],
    ['doubly parenthesised', `((navigateTo))(((${obj})))`, true, true],
    ['computed member', `Xrm.Navigation["navigateTo"](${obj})`, true, true],
    ['computed optional member', `Xrm.Navigation?.["navigateTo"]?.(${obj})`, true, true],
    ['computed escaped member', `Xrm.Navigation["navigate\\u0054o"](${obj})`, true, true],
    ['computed optional member, parenthesised argument', `Xrm.Navigation?.['navigateTo']?.((${obj}))`, true, true],
  ];
  for (const term of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    // The key is `pageType` once the continuation is read; the value is "PAGEREF_detail", but spelled across the line
    // terminator it is not the canonical literal, so it is reported rather than rewritten.
    cases.push([`key continued across ${JSON.stringify(term)}`, `navigateTo({"page\\${term}Type":"generative",pageId:"PAGEREF_detail"})`, true, true]);
    cases.push([`value continued across ${JSON.stringify(term)}`, `navigateTo({pageType:"generative",pageId:"PAGEREF_det\\${term}ail"})`, true, false]);
  }
  for (const [label, code, javascriptCalls, rewrites] of cases) {
    const before = runNavigationSnippet(code);
    const rewritten = resolvePageRefs(new Map([['x', { code }]]), new Map([['detail', id]])).deployment.get('x');
    const after = runNavigationSnippet(rewritten);
    const executed = canonicalCalls(before);
    const targets = extractNavTargets(code).filter((target) => target.kind === 'pageref');
    assert.strictEqual(executed.length > 0, javascriptCalls, `${label}: JavaScript`);
    assert.strictEqual(targets.length > 0, rewrites, `${label}: resolver`);
    if (rewrites) {
      // The resolver and JavaScript agree on which calls are canonical, and the rewrite changes only their pageId.
      assert.strictEqual(targets.length, executed.length, `${label}: calls found`);
      const expected = before.map((call) => (canonicalCalls([call]).length ? { ...call, pageId: id } : call));
      assert.deepStrictEqual(after, expected, `${label}: what navigateTo receives`);
    } else {
      assert.strictEqual(rewritten, code, `${label}: left alone`);
      assert.deepStrictEqual(after, before, `${label}: what navigateTo receives`);
      assert.ok(navMalformedRefs(code).length + strayPageRefs(code).length > 0, `${label}: the token is reported, not shipped in silence`);
    }
  }
});

test('performance: resolving a page with thousands of calls is linear', (t) => {
  const call = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});';
  const page = (calls) => 'export default ()=>null;' + call.repeat(calls);
  const keyToId = new Map([['detail', '11111111-2222-4333-8444-555555555555']]);
  const resolve = (code) => resolvePageRefs(new Map([['x', { code }]]), keyToId);
  const small = page(2048);
  const large = page(8192);
  resolve(small); // warm up
  if (medianMs(() => resolve(small), 3) > 1500) { t.skip('host too slow to judge scaling'); return; }
  // The right-to-left rewrite copied the whole page once per call: 2,048 calls took 0.3 s and 8,192 took 3 s.
  let ratio = Infinity;
  let timings = '';
  for (let attempt = 0; attempt < 3 && !(ratio < 7); attempt += 1) {
    const [tSmall, tLarge] = [medianMs(() => resolve(small), 5), medianMs(() => resolve(large), 5)];
    ratio = tLarge / Math.max(tSmall, 5);
    timings = `${tSmall.toFixed(1)} -> ${tLarge.toFixed(1)} ms`;
  }
  assert.ok(ratio < 7, `4x the calls took ${ratio.toFixed(1)}x the time (${timings})`);
  const { deployment, unresolved, residual } = resolve(large);
  assert.deepStrictEqual([unresolved, residual], [[], []]);
  assert.strictEqual(deployment.get('x'), large.replace(/"PAGEREF_detail"/g, '"11111111-2222-4333-8444-555555555555"'));
});

// A call nested in another's data is the shape of a wizard or a chain of deep links. Each call used to copy and scan
// its whole nested object, once per key, so doubling the depth quadrupled the time: depth 512 took about 0.7 s and
// depth 1,024 several seconds. The shared indexes are built once per source now, and a call reads only its own members.
// The checks are the ratio of two sizes, which a slow host scales equally, and a ceiling far above the measured time.
function nestedNavigation(depth, kind) {
  const head = 'export default ()=>null;\n';
  if (kind === 'valid') return head + 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail",data:'.repeat(depth) + '0' + '})'.repeat(depth) + ';';
  if (kind === 'valid, pageId last') return head + 'navigateTo({pageType:"generative",data:'.repeat(depth) + '0' + ',pageId:"PAGEREF_detail"})'.repeat(depth) + ';';
  if (kind === 'balanced but malformed') return head + 'navigateTo({'.repeat(depth) + 'pageType:"generative",pageId:"PAGEREF_detail"' + '})'.repeat(depth) + ';';
  if (kind === 'pageId expression') return head + 'navigateTo({pageType:"generative",pageId:'.repeat(depth) + '"PAGEREF_detail"' + '})'.repeat(depth) + ';';
  throw new Error(kind);
}

function medianMs(fn, runs) {
  const times = [];
  for (let i = 0; i < runs; i += 1) times.push(measure(fn));
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
}

test('performance: nested navigation objects scale linearly with depth', (t) => {
  extractNavTargets(nestedNavigation(128, 'valid')); // warm up the JIT before anything is timed
  const calibration = medianMs(() => extractNavTargets(nestedNavigation(64, 'valid')), 3);
  // A host so slow that a 4 KB page takes 300 ms cannot say anything about scaling: say so rather than fail on noise.
  if (calibration > 300) { t.skip(`host too slow to judge scaling (64 nested calls took ${calibration.toFixed(0)} ms)`); return; }
  for (const kind of ['valid', 'valid, pageId last', 'balanced but malformed', 'pageId expression']) {
    const small = nestedNavigation(256, kind);
    const large = nestedNavigation(2048, kind);
    // Linear growth is 8x for 8x the depth (measured: 2.5x to 4x for 4x); the quadratic scan measured about 20x for 4x, so about 80x
    // here. The wide factor keeps the two far apart on a busy host — a CI runner runs other test files beside this one — where a
    // 4x step left too little room. The floor keeps a sub-millisecond small case from turning timer noise into a ratio, and a pause
    // (GC, another process) that lands on one of the runs gets two more tries: a real regression fails every one.
    let ratio = Infinity;
    let tLarge = Infinity;
    let timings = '';
    for (let attempt = 0; attempt < 3 && !(ratio < 20); attempt += 1) {
      const [tSmall, big] = [medianMs(() => extractNavTargets(small), 7), medianMs(() => extractNavTargets(large), 7)];
      ratio = big / Math.max(tSmall, 2);
      tLarge = big;
      timings = `${tSmall.toFixed(2)} -> ${big.toFixed(2)} ms`;
    }
    assert.ok(ratio < 20, `${kind}: 8x the depth took ${ratio.toFixed(1)}x the time (${timings})`);
    assert.ok(tLarge < 1000, `${kind}: depth 2048 took ${tLarge.toFixed(1)} ms`);
    // The ceiling the quadratic scan broke at 512 (about 0.7 s), far above the linear time (about 10 ms) on any host
    // that passed the calibration above.
    const medium = nestedNavigation(512, kind);
    const t512 = medianMs(() => extractNavTargets(medium), 5);
    assert.ok(t512 < 400, `${kind}: depth 512 took ${t512.toFixed(1)} ms`);
  }
  // The result is the same at any depth: every call is a target (the malformed family has one real call at the bottom).
  const targets = extractNavTargets(nestedNavigation(512, 'valid'));
  assert.strictEqual(targets.length, 512);
  assert.ok(targets.every((target) => target.kind === 'pageref' && target.key === 'detail'));
  assert.deepStrictEqual(extractNavTargets(nestedNavigation(512, 'balanced but malformed')).map((target) => target.kind), ['pageref']);
  assert.strictEqual(extractNavTargets(nestedNavigation(512, 'valid, pageId last')).length, 512);
  // Resolving the deepest chain is as linear as extracting it: no replacement lands on an earlier one's offsets.
  const source = nestedNavigation(512, 'valid, pageId last');
  const resolved = resolvePageRefs(new Map([['x', { code: source }]]), new Map([['detail', 'gp']])).deployment.get('x');
  assert.strictEqual(resolved, source.replace(/"PAGEREF_detail"/g, '"gp"'));
});

// Every level of this chain is a malformed value holding the token of every level below it: n values, n tokens, and each value's
// tokens a range of the one sorted list. Copying each value's tokens would grow as n²/2 (n = 8,192: 33.5 million entries, 256 MiB) and
// make the report that reads them quadratic too, so a value holds two indexes into the shared list and the report reads each token
// once.
function nestedMalformed(depth) {
  return 'export default ()=>null;\n' + 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail" + '.repeat(depth) + '0' + '})'.repeat(depth) + ';';
}

// The own enumerable values reachable from `value`, each object or array counted once (a string counts as one value however long it
// is): what a result keeps alive, measured the same on any engine.
function retainedValues(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return 1;
  if (seen.has(value)) return 0;
  seen.add(value);
  let count = 1;
  for (const inner of Object.values(value)) count += retainedValues(inner, seen);
  return count;
}

test('performance: nested malformed values hold two indexes each, not copies of their tokens', (t) => {
  // Correct first, at a size where every value can be checked against its own text.
  const small = nestedMalformed(48);
  const found = extractNavTargets(small);
  assert.strictEqual(found.length, 48);
  for (const target of found) {
    assert.strictEqual(target.kind, 'pageref-malformed');
    assert.strictEqual(target.tokenTo - target.tokenFrom, (target.raw.match(/PAGEREF_detail/g) || []).length, 'the range holds exactly the tokens of the value');
  }
  assert.deepStrictEqual(navMalformedRefs(small), ['PAGEREF_detail']);
  assert.strictEqual(strayPageRefs(small).length, 0);

  // The size is the point. n values keep O(n); copies of their tokens would be 2.1 million entries at n = 2,048.
  const n = 2048;
  const big = extractNavTargets(nestedMalformed(n));
  assert.strictEqual(big.length, n);
  assert.ok(retainedValues(big) <= 16 * n, `${retainedValues(big)} values kept alive by ${n} targets`);
  assert.ok(big.every((target) => Object.values(target).every((value) => !Array.isArray(value))), 'no target keeps a list');

  const diagnose = (code) => { extractNavTargets(code); navMalformedRefs(code); strayPageRefs(code); };
  diagnose(nestedMalformed(128)); // warm up
  const calibration = medianMs(() => diagnose(nestedMalformed(64)), 3);
  if (calibration > 300) { t.skip(`host too slow to judge scaling (64 nested values took ${calibration.toFixed(0)} ms)`); return; }
  // 8x the depth is 8x the time when linear, and was about 32x to 64x when quadratic (8x to 16x for 4x); the wide factor keeps the two apart on a busy
  // host, where a 4x step left too little room. A pause on one run gets two more tries.
  const smallCode = nestedMalformed(256);
  const largeCode = nestedMalformed(2048);
  let ratio = Infinity;
  let timings = '';
  for (let attempt = 0; attempt < 3 && !(ratio < 20); attempt += 1) {
    const [tSmall, tLarge] = [medianMs(() => diagnose(smallCode), 7), medianMs(() => diagnose(largeCode), 7)];
    ratio = tLarge / Math.max(tSmall, 2);
    timings = `${tSmall.toFixed(1)} -> ${tLarge.toFixed(1)} ms`;
  }
  assert.ok(ratio < 20, `8x the depth took ${ratio.toFixed(1)}x the time (${timings})`);
  const t4096 = medianMs(() => diagnose(nestedMalformed(4096)), 3);
  assert.ok(t4096 < 1500, `depth 4096 took ${t4096.toFixed(0)} ms (about 2.4 s when quadratic, about 0.3 s linear)`);

  // What the result keeps alive, measured by the engine: copying each value's tokens would keep about 64 MiB alive at n = 4,096. Skipped where
  // the collector cannot be asked for (it needs --expose-gc, which this enables at run time).
  let collect = null;
  try { v8.setFlagsFromString('--expose-gc'); collect = vm.runInNewContext('gc'); } catch { collect = null; }
  if (typeof collect === 'function') {
    const code = nestedMalformed(4096);
    collect();
    const before = process.memoryUsage().heapUsed;
    const kept = extractNavTargets(code);
    collect();
    const grown = process.memoryUsage().heapUsed - before;
    assert.strictEqual(kept.length, 4096);
    assert.ok(grown < 24 * 1024 * 1024, `the result keeps ${(grown / 1048576).toFixed(1)} MiB alive for 4,096 nested malformed values`);
  }
});
