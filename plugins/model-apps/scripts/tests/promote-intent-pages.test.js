'use strict';
// Contract tests for the transactional intent -> tsx promotion (scripts/promote-intent-pages.js).
//
// The property under test is ATOMICITY: /app-builder Phase 1.5 dispatches N page workers and any
// subset can fail, so a partial promotion would leave app-spec.json claiming a `.tsx` that was
// never written. These tests drive the real CLI in a child process (not the exported functions), so
// the exit code + on-disk spec are asserted exactly as the skill will observe them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'promote-intent-pages.js');
const { OBJECT_DIVISION_PAGE, MISREAD_PAGES, HIDDEN_CALL_PAGE, PREFIX_INCREMENT_PAGE, TEMPLATE_LINE_PAGE, JSX_TEXT_PAGE, ELEMENT_AFTER_OPERATOR_PAGES, ELEMENT_LOOKALIKE_PAGES, ELEMENT_PAGE_TOKEN_LINE, FUNCTION_TYPE_PAGES } = require('./helpers/misread-page.js');

const GOOD = 'export default function P() { return <div>ok</div>; }\n';

function makeWorkspace(spec, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-'));
  fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify(spec, null, 2), 'utf8');
  for (const [name, code] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, name), code, 'utf8');
  return dir;
}

function run(dir) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, '--spec', '@' + path.join(dir, 'app-spec.json'), '--working-dir', dir], { encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' } });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

const readSpec = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'app-spec.json'), 'utf8'));

const twoPageSpec = () => ({
  app: { name: 'A' },
  pages: [
    { key: 'overview', name: 'Overview', source: { kind: 'intent' } },
    { key: 'detail', name: 'Detail', source: { kind: 'intent' } },
  ],
});

test('promotes every page in one write when all pass', () => {
  const dir = makeWorkspace(twoPageSpec(), { 'overview.tsx': GOOD, 'detail.tsx': GOOD });
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  const after = readSpec(dir);
  assert.deepEqual(after.pages.map((p) => p.source), [
    { kind: 'tsx', codeFile: 'overview.tsx' },
    { kind: 'tsx', codeFile: 'detail.tsx' },
  ]);
});

test('ONE failing page aborts the whole promotion and leaves the spec byte-identical', () => {
  // This is the regression the script exists for: page 1 succeeded, page 2 never got written.
  const dir = makeWorkspace(twoPageSpec(), { 'overview.tsx': GOOD });
  const before = fs.readFileSync(path.join(dir, 'app-spec.json'), 'utf8');
  const r = run(dir);
  assert.equal(r.code, 3, 'fail-closed exit code');
  assert.match(r.stderr, /detail\.tsx: file was never written/);
  assert.equal(fs.readFileSync(path.join(dir, 'app-spec.json'), 'utf8'), before, 'spec untouched');
});

test('rejects prose that only LOOKS like a module', () => {
  // A plain `export default` substring search — even over a copy that keeps ordinary string
  // bodies — accepted every one of these, promoting prose as a page.
  for (const [name, code, expected] of [
    ['empty', '   \n', /file is empty/],
    ['no default export', 'export function P() {}\n', /no real `export default/],
    ['fenced prose', '```tsx\nexport default function P(){}\n```\n', /markdown code fence/],
    ['tilde-fenced prose', '~~~tsx\nexport default function P(){}\n~~~\n', /markdown code fence/],
    ['commented-out export', '/* export default */\nThis is prose\n', /no real `export default/],
    ['export default in a string', 'const bait = "export default GeneratedComponent";\n', /no real `export default/],
    ['export default in a template', 'const t = `\nexport default Foo\n`;\n', /no real `export default/],
    ['line-commented export', '// export default function P(){}\nThis is prose\n', /no real `export default/],
    ['empty default export', 'export default;\n', /no real `export default/],
    ['truncated write', 'export default function P() {\n  return <div>\n', /truncated/],
    // Cut right after a complete statement: it ends in plain code, so only the bracket count sees it.
    ['truncated after a complete statement', 'export default function P() {\n  const a = 1;\n  return null;\n', /unbalanced brackets/],
    // Cut inside the export statement itself: nothing is left open, so brackets balance.
    ['write cut after the export header', 'import * as React from "react";\nexport default function P(props: Props)', /no real `export default/],
    ['write cut mid-name', 'const GeneratedComponent = () => <div/>;\nexport default GeneratedComp', /no real `export default/],
    // Every bracket balances and the export is intact, but the write stopped mid-statement.
    ['write cut inside JSX', 'export default () => <div>Loading', /stops mid-statement/],
    // Elided code fails promotion as it fails the worker gate: the shared elision rule.
    ['a TODO elision', 'export default function P() {\n  // TODO: render the rest\n  return null;\n}\n', /incomplete/],
    ['an elided block', 'export default function P() {\n  // ...\n  return null;\n}\n', /incomplete/],
    ['omitted for brevity', 'export default function P() {\n  /* omitted for brevity */\n  return null;\n}\n', /incomplete/],
  ]) {
    const dir = makeWorkspace(
      { app: { name: 'A' }, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }] },
      { 'overview.tsx': code },
    );
    const r = run(dir);
    assert.equal(r.code, 3, `${name} should fail`);
    assert.match(r.stderr, expected, name);
  }
});

test('accepts the legitimate default-export forms a worker really emits', () => {
  for (const [name, code] of [
    ['function declaration', 'export default function P() { return <div/>; }\n'],
    ['arrow const', 'const P = () => <div/>;\nexport default P;\n'],
    ['wrapped in memo', 'import { memo } from "react";\nexport default memo(function P(){ return <div/>; });\n'],
    ['object-ish default', 'export default {\n  render() { return null; }\n};\n'],
    ['after a doc comment mentioning export default', '/**\n * export default is required\n */\nexport default function P(){ return <div/>; }\n'],
    ['aliased default export', 'function P(){ return <div/>; }\nexport { P as default };\n'],
    ['JSX text with an apostrophe', "export default function P(){ return <p>it's fine</p>; }\n"],
    // A `/` after a property named like a keyword, or after a non-null assertion, divides.
    ['a keyword-named property divided', 'export default function P(){ const c = { new: 3 }; return <p>{c.new / 8}</p>; }\n'],
    ['a non-null assertion divided', 'export default function P(){ const n: number | null = 3; return <p>{n! / 8}</p>; }\n'],
    ['JSX inside a template expression', 'const x = `${<span>Save</span>}`;\nexport default function P(){ return <div/>; }\n'],
    // …and data or prose that only resembles what the gate refuses: a fence inside a template literal, UI copy
    // that says "Loading…", and a comment ABOUT a todo list — the same reading the worker gate gives them.
    ['a markdown fence inside a template', 'const help = `\n\\`\\`\\`tsx\nconst a = 1;\n\\`\\`\\`\n`;\nexport default function P(){ return <pre>{help}</pre>; }\n'],
    ['a markdown fence inside a block comment', '/* usage:\n```\n<Page />\n```\n*/\nexport default function P(){ return null; }\n'],
    ['UI copy that says Loading…', 'export default function P(){ return <div>Loading\u2026</div>; }\n'],
    ['a comment about the todo list', '// Renders the todo list.\nexport default function P(){ return null; }\n'],
  ]) {
    const dir = makeWorkspace(
      { app: { name: 'A' }, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }] },
      { 'overview.tsx': code },
    );
    assert.equal(run(dir).code, 0, `${name} should be accepted`);
  }
});

test('holds cross-page navigation to the spec before promoting', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];

  // (a) declared edge the code never navigates -> abort
  let dir = makeWorkspace(spec, { 'overview.tsx': GOOD, 'detail.tsx': GOOD });
  let r = run(dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /declares detail but the code never navigates there/);

  // (b) the canonical double-quoted PAGEREF literal -> promotes
  const nav = `export default function P(){ navigateTo({ pageType: 'generative', pageId: "PAGEREF_detail" }); return <div/>; }\n`;
  dir = makeWorkspace(spec, { 'overview.tsx': nav, 'detail.tsx': GOOD });
  r = run(dir);
  assert.equal(r.code, 0, r.stderr);

  // (c) single-quoted token is malformed — the build would deploy a dead link, so abort here
  const bad = `export default function P(){ navigateTo({ pageType: 'generative', pageId: 'PAGEREF_detail' }); return <div/>; }\n`;
  dir = makeWorkspace(spec, { 'overview.tsx': bad, 'detail.tsx': GOOD });
  r = run(dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /malformed nav pageref/);
});

// A token the build would not resolve — in a string, behind an expression tail, in a call spelled a way the resolver does not
// read, in a comment — would deploy as literal text. It aborts promotion here, naming where it is; a page whose only token is a
// recognised spelling still promotes, and so does one whose comments say what a call looks like with no token in them.
test('refuses a page holding a PAGEREF_ token no navigation rewrite resolves, and names where', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  const page = (...lines) => `export default function P(){\n${lines.map((l) => `  ${l}`).join('\n')}\n  return <div/>;\n}\n`;
  const real = `navigateTo({ pageType: 'generative', pageId: "PAGEREF_detail" });`;
  for (const [what, code, expected] of [
    ['a string', page('const route = "PAGEREF_detail";', real), /PAGEREF_ token\(s\) no navigation rewrite will resolve: PAGEREF_detail \(line 2, column 18\)/],
    ['an expression tail', page(`navigateTo({ pageType: 'generative', pageId: "PAGEREF_detail".slice(8) });`, real), /malformed nav pageref\(s\): PAGEREF_detail/],
    ['a call through a cast', page(real, `(navigateTo as Navigate)({ pageType: 'generative', pageId: "PAGEREF_other" });`), /PAGEREF_other \(line 3, column /],
    ['a pageType that is not a literal', page(real, `navigateTo({ pageType: kind, pageId: "PAGEREF_other" });`), /PAGEREF_other \(line 3, column /],
    ['a member of a cast literal', page(`navigateTo({ pageType: 'generative', pageId: ("PAGEREF_detail" as const).slice(1) });`, real), /malformed nav pageref\(s\): PAGEREF_detail/],
    ['a cast outside the small grammar', page(`navigateTo({ pageType: 'generative', pageId: "PAGEREF_detail" as Readonly<string> });`, real), /malformed nav pageref\(s\): PAGEREF_detail/],
    ['a token in a type position, which the compiler erases but the check reads', page('const key = "detail" as "PAGEREF_viaType";', real), /PAGEREF_ token\(s\) no navigation rewrite will resolve: PAGEREF_viaType \(line 2, column \d+\)/],
    ['a callee that is the argument of another call', page(real, `factory(navigateTo)({ pageType: 'generative', pageId: "PAGEREF_other" });`), /PAGEREF_other \(line 3, column /],
    ['a callee after a non-null assertion', page(real, `factory!(navigateTo)({ pageType: 'generative', pageId: "PAGEREF_other" });`), /PAGEREF_other \(line 3, column /],
    ['a callee after a generic instantiation', page(real, `factory<unknown>(navigateTo)({ pageType: 'generative', pageId: "PAGEREF_other" });`), /PAGEREF_other \(line 3, column /],
    ['a callee after a tagged template', page(real, 'tag`x`(navigateTo)({ pageType: \'generative\', pageId: "PAGEREF_other" });'), /PAGEREF_other \(line 3, column /],
    ['a callee after a function expression', page(real, `const g = function () { return f; }(navigateTo)({ pageType: 'generative', pageId: "PAGEREF_other" });`), /PAGEREF_other \(line 3, column /],
    ['a token in a trailing comment, beside the real call', page(`${real} // PAGEREF_detail`), /PAGEREF_ token\(s\) no navigation rewrite will resolve: PAGEREF_detail \(line 2, column \d+\)/],
    ['a token in a block comment after code', page(real, 'const label = 1; /* PAGEREF_detail */'), /PAGEREF_detail \(line 3, column \d+\)/],
    ['a token in a block comment on its own line', page('/* PAGEREF_detail is resolved at deploy */', real), /PAGEREF_detail \(line 2, column \d+\)/],
    ['a token in a doc block', page('/**\n   * PAGEREF_detail is resolved at deploy\n   */', real), /PAGEREF_detail \(line 3, column \d+\)/],
    ['a token in a // comment on its own line', page('// PAGEREF_detail is resolved at deploy', real), /PAGEREF_ token\(s\) no navigation rewrite will resolve: PAGEREF_detail \(line 2, column 6\)/],
    ['a token in a // comment on its own line, after code', page(real, '// PAGEREF_detail is resolved at deploy'), /PAGEREF_detail \(line 3, column 6\)/],
    ['a call written out in a comment', page('// navigateTo({ pageType: "generative", pageId: "PAGEREF_other" });', real), /PAGEREF_other \(line 2, column /],
    ['a template line that starts with // holding a token', page('const help = `\n// PAGEREF_viaTemplate\n`;', real), /PAGEREF_viaTemplate \(line 3, column 4\)/],
    ['an options object built in a variable', page(real, `const options = { pageType: 'generative', pageId: "PAGEREF_other" };`, 'navigateTo(options);'), /PAGEREF_other \(line 3, column /],
  ]) {
    const dir = makeWorkspace(spec, { 'overview.tsx': code, 'detail.tsx': GOOD });
    const r = run(dir);
    assert.equal(r.code, 3, what);
    assert.match(r.stderr, expected, what);
    assert.match(r.stderr, /allowed only as the double-quoted pageId literal of a pageType:"generative" navigateTo call[\s\S]*and nowhere else — not in a comment/, `${what}: the report states the rule`);
    assert.deepEqual(readSpec(dir).pages.map((p) => p.source && p.source.kind), spec.pages.map((p) => p.source && p.source.kind), `${what}: the spec is untouched`);
  }
  for (const [what, code] of [
    ['a parenthesised callee', page(`(navigateTo)({ pageType: 'generative', pageId: "PAGEREF_detail" });`)],
    ['a computed optional member', page(`Xrm.Navigation?.["navigateTo"]?.({ pageType: 'generative', pageId: "PAGEREF_detail" });`)],
    ['type-only casts on the pageType and the pageId', page(`navigateTo({ pageType: 'generative' as const, pageId: "PAGEREF_detail" as const });`)],
    ['a comment that says what a call looks like, with no token', page('// navigateTo({ pageType: "generative", pageId: "help-text" });', real)],
    ['a comment about the link, with no token', page(real, '// The page key is replaced at deploy.')],
  ]) {
    const dir = makeWorkspace(spec, { 'overview.tsx': code, 'detail.tsx': GOOD });
    const r = run(dir);
    assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  }
});

// A page whose `/` after an object literal hides a call: JavaScript makes both navigations, but the lexer reads the `/` after the object literal on line 4 as a regex
// and the `/*` in `/\/*$/` as a comment over the second call. Promotion used to pass it, and the build then shipped the second
// token unresolved. The token is refused here — where the page can be regenerated — naming it and the `/`.
test('refuses the page whose "/" after an object literal hides a navigation call, naming the call and the "/"', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  const dir = makeWorkspace(spec, { 'overview.tsx': OBJECT_DIVISION_PAGE, 'detail.tsx': GOOD });
  const r = run(dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /PAGEREF_detail \(line 5, column \d+, after the "brace" ambiguity at line 4, column \d+\)/);
  assert.match(r.stderr, /may be a division or comparison after an object literal, or a regex or JSX element after a block[\s\S]*parentheses/);
  assert.deepEqual(readSpec(dir).pages.map((p) => p.source && p.source.kind), spec.pages.map((p) => p.source && p.source.kind), 'the spec is untouched');
  // The same page with the object literal in parentheses is read right, and promotes.
  const fixed = OBJECT_DIVISION_PAGE.replace('{valueOf(){return 12;}, ...extras}/2', '({valueOf(){return 12;}, ...extras})/2');
  assert.notEqual(fixed, OBJECT_DIVISION_PAGE);
  const ok = run(makeWorkspace(spec, { 'overview.tsx': fixed, 'detail.tsx': GOOD }));
  assert.equal(ok.code, 0, ok.stderr);
});

// Every misread page (tests/helpers/misread-page.js) is refused at its first guess, naming each token after it
// and the kind and position of the guess, and the spec is left as it was. A page regenerated here costs a retry; one that reached the
// build would ship a dead link.
test('refuses each misread page, naming the token and the guess', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  for (const [name, { kind, frontier, code, reaching }] of Object.entries(MISREAD_PAGES)) {
    const at = frontier(code);
    const where = (offset) => {
      const lines = code.slice(0, offset).split('\n');
      return `line ${lines.length}, column ${lines[lines.length - 1].length + 1}`;
    };
    const dir = makeWorkspace(spec, { 'overview.tsx': code, 'detail.tsx': GOOD });
    const r = run(dir);
    assert.equal(r.code, 3, name);
    // A call that reaches the guess is untrusted whole, so its token is named though it lies before the guess.
    assert.ok(r.stderr.includes(`PAGEREF_detail (${where(code.indexOf('PAGEREF_detail', reaching ? 0 : at))}, ${reaching ? 'in a call that reaches' : 'after'} the "${kind}" ambiguity at ${where(at)})`), `${name}: ${r.stderr}`);
    assert.match(r.stderr, /this check cannot tell for certain how the code after it is read/, name);
    assert.deepEqual(readSpec(dir).pages.map((p) => p.source && p.source.kind), spec.pages.map((p) => p.source && p.source.kind), `${name}: the spec is untouched`);
  }
});

// A declared call the lexer cannot see is reported as one the code "never navigates" to, which is not so: the author can see it. The guess is
// named once. When the call is hidden its token lies after the guess, and the report of that token names it. When the page has a guess and no
// call at all, nothing else would, so the parity problem does. A page with no guess is told only what is missing.
// Pages the lexer reads right after a line break (ASI): a regex after a prefix `++` holds text, a token no rewrite resolves, so promotion refuses
// it where the page can be regenerated; a call in a template line that starts with `//` runs, so it promotes.
test('refuses a token in a regex after a prefix "++", and promotes a call in a template line that starts with //', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  const refused = run(makeWorkspace(spec, { 'overview.tsx': PREFIX_INCREMENT_PAGE, 'detail.tsx': GOOD }));
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /PAGEREF_detail \(line 6, column \d+\)/);
  assert.doesNotMatch(refused.stderr, /ambiguity/);
  const ok = run(makeWorkspace(spec, { 'overview.tsx': TEMPLATE_LINE_PAGE, 'detail.tsx': GOOD }));
  assert.equal(ok.code, 0, ok.stderr);
});

// JSX text that looks like a parameter list is text (TypeScript reads `<div data-active={e}>` as an element): the regex after the next arrow is
// data, and the token in it is refused where the page can be regenerated.
test('refuses a token in the regex after JSX text that looks like parameters', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  const refused = run(makeWorkspace(spec, { 'overview.tsx': JSX_TEXT_PAGE, 'detail.tsx': GOOD }));
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /PAGEREF_detail \(line 5, column \d+\)/);
  assert.doesNotMatch(refused.stderr, /ambiguity/);
});

// After a unary or binary operator a `<` opens an element whatever follows its name (`a === <T extends X>text</T>`), so the regex after it is data and the token
// in it is a token no rewrite resolves: promotion refuses it where the page can be regenerated, with no guess named and the spec left as it was.
test('refuses a token in the regex after an element that follows a unary or binary operator', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  for (const { name, code } of ELEMENT_AFTER_OPERATOR_PAGES) {
    const dir = makeWorkspace(spec, { 'overview.tsx': code, 'detail.tsx': GOOD });
    const refused = run(dir);
    assert.equal(refused.code, 3, `${name}: ${refused.stderr}`);
    assert.match(refused.stderr, new RegExp(`PAGEREF_detail \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)`), name);
    assert.doesNotMatch(refused.stderr, /ambiguity/, name);
    assert.deepEqual(readSpec(dir).pages.map((p) => p.source && p.source.kind), spec.pages.map((p) => p.source && p.source.kind), `${name}: the spec is untouched`);
  }
});

// A generic function type whose parameter list holds a type argument, an object type or a comma between type arguments compiles, and no element does, so it is a type and
// the page is complete: promotion accepts it. (A rule that took each for a guess at the `<` read an element whose text ran on, and refused the page as truncated.)
test('promotes a page that holds a generic function type with a type argument or an object type in its parameter list', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  for (const { name, code } of FUNCTION_TYPE_PAGES) {
    const dir = makeWorkspace(spec, { 'overview.tsx': code, 'detail.tsx': GOOD });
    const r = run(dir);
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
  }
});

// JSX that holds what looks like a function type's parameter list compiles as an element, so the regex after it is data and the token in it is a token no rewrite
// resolves: promotion refuses it where the page can be regenerated, with no guess named and the spec left as it was.
test('refuses a token in the regex after an element whose text looks like a parameter list', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  for (const { name, code } of ELEMENT_LOOKALIKE_PAGES) {
    const dir = makeWorkspace(spec, { 'overview.tsx': code, 'detail.tsx': GOOD });
    const refused = run(dir);
    assert.equal(refused.code, 3, `${name}: ${refused.stderr}`);
    assert.match(refused.stderr, new RegExp(`PAGEREF_detail \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)`), name);
    assert.doesNotMatch(refused.stderr, /ambiguity/, name);
    assert.deepEqual(readSpec(dir).pages.map((p) => p.source && p.source.kind), spec.pages.map((p) => p.source && p.source.kind), `${name}: the spec is untouched`);
  }
});

test('names the guess when a declared call is absent, once, and only a guess the page has', () => {
  const spec = twoPageSpec();
  spec.pages[0].navigatesTo = [{ targetKey: 'detail' }];
  const { code, frontier } = HIDDEN_CALL_PAGE;
  const before = code.slice(0, frontier(code)).split('\n');
  const where = `"keyword" ambiguity at line ${before.length}, column ${before[before.length - 1].length + 1}`;
  const hidden = run(makeWorkspace(spec, { 'overview.tsx': code, 'detail.tsx': GOOD }));
  assert.equal(hidden.code, 3);
  assert.ok(hidden.stderr.includes('navigatesTo declares detail but the code never navigates there'), hidden.stderr);
  assert.match(hidden.stderr, /PAGEREF_detail \(line 4, column \d+, after the "keyword" ambiguity at line 3, column \d+\)/);
  assert.equal(hidden.stderr.split(where).length - 1, 1, `named once: ${hidden.stderr}`);
  const guessed = 'const type = 4;\nconst half = type/2; const re = /x/;\nexport default function Overview() { return null; }\n';
  const none = run(makeWorkspace(spec, { 'overview.tsx': guessed, 'detail.tsx': GOOD }));
  assert.equal(none.code, 3);
  const column = guessed.split('\n')[1].indexOf('/') + 1;
  assert.ok(none.stderr.includes(`navigatesTo declares detail but the code never navigates there — the page has a "keyword" ambiguity at line 2, column ${column}, so a navigation call written after it may not be seen`), none.stderr);
  assert.match(none.stderr, /this check cannot tell for certain how the code after it is read[\s\S]*parentheses/);
  const bare = run(makeWorkspace(spec, { 'overview.tsx': 'export default function Overview() { return null; }\n', 'detail.tsx': GOOD }));
  assert.equal(bare.code, 3);
  assert.match(bare.stderr, /navigatesTo declares detail but the code never navigates there/);
  assert.doesNotMatch(bare.stderr, /ambiguity/);
});

test('already-built pages are left alone and are not required to exist', () => {
  const dir = makeWorkspace({
    app: { name: 'A' },
    pages: [{ key: 'built', name: 'Built', source: { kind: 'tsx', codeFile: 'pages/9f2c/page.tsx' } }],
  }, {});
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no intent pages to promote/);
  assert.deepEqual(readSpec(dir).pages[0].source, { kind: 'tsx', codeFile: 'pages/9f2c/page.tsx' });
});

test('promotes a spec whose pages have no explicit key (key is derived from name)', () => {
  // Regression: the raw spec is what gets rewritten, and `key` is OPTIONAL there — migrateAppSpec
  // derives it by slugifying `name`. Matching raw pages BY KEY threw on exactly these specs.
  const dir = makeWorkspace(
    { app: { name: 'A' }, pages: [{ name: 'Supplier Detail' }, { name: 'Overview' }] },
    { 'supplier-detail.tsx': GOOD, 'overview.tsx': GOOD },
  );
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  const after = readSpec(dir);
  assert.deepEqual(after.pages.map((p) => p.source), [
    { kind: 'tsx', codeFile: 'supplier-detail.tsx' },
    { kind: 'tsx', codeFile: 'overview.tsx' },
  ]);
  assert.ok(after.pages.every((p) => p.key === undefined), 'derived keys are not persisted into the spec');
});

test('two pages cannot silently share a file', () => {
  // Upstream, migrateAppSpec de-duplicates slugified keys, so "Supplier Detail" and
  // "supplier-detail" become supplier-detail / supplier-detail-2 and get distinct files. Assert
  // that invariant here (it is what makes one-file-per-page true), and note the script keeps its
  // own same-file guard as a backstop if that ever changes.
  const dir = makeWorkspace({
    app: { name: 'A' },
    pages: [{ name: 'Supplier Detail' }, { name: 'supplier-detail' }],
  }, { 'supplier-detail.tsx': GOOD, 'supplier-detail-2.tsx': GOOD });
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readSpec(dir).pages.map((p) => p.source.codeFile), ['supplier-detail.tsx', 'supplier-detail-2.tsx']);
});

test('validatePage refuses a codeFile that escapes the working directory', () => {
  // Defence in depth: today `pageFile()` only returns a pinned codeFile for already-built pages
  // (which promotion skips), but codeFile is author-editable and download-derived, so the check
  // lives with the read rather than relying on that invariant holding forever.
  const { validatePage } = require('../promote-intent-pages.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-esc-'));
  fs.writeFileSync(path.join(dir, '..', 'outside.tsx'), GOOD, 'utf8');
  for (const codeFile of ['../outside.tsx', path.join(dir, '..', 'outside.tsx')]) {
    const r = validatePage({ key: 'evil', name: 'Evil', source: { kind: 'tsx', codeFile } }, dir);
    assert.deepEqual(r.problems.length, 1, codeFile);
    assert.match(r.problems[0], /escapes the working directory/, codeFile);
  }
});

test('a malformed or missing spec fails closed with the same exit contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-bad-'));
  let r = run(dir);
  assert.equal(r.code, 3, 'missing spec');
  assert.match(r.stderr, /cannot read app spec/);

  fs.writeFileSync(path.join(dir, 'app-spec.json'), '{ not json', 'utf8');
  r = run(dir);
  assert.equal(r.code, 3, 'unparseable spec');

  fs.writeFileSync(path.join(dir, 'app-spec.json'), '{"app":{"name":"A"},"pages":"nope"}', 'utf8');
  r = run(dir);
  assert.equal(r.code, 3, 'pages not an array');
  assert.match(r.stderr, /"pages" must be an array/);
});

test('aborts if the spec changed while pages were being validated', () => {
  // Validation reads N page files, so a concurrent editor's save between our read and the rename
  // would otherwise be silently overwritten by our stale in-memory copy.
  //
  // Deterministic race: preload a module into the CLI's process that patches fs.readFileSync so the
  // FIRST .tsx read rewrites app-spec.json — exactly the window the compare-and-swap protects.
  const dir = makeWorkspace(twoPageSpec(), { 'overview.tsx': GOOD, 'detail.tsx': GOOD });
  const specFile = path.join(dir, 'app-spec.json');
  const hook = path.join(dir, 'race-hook.js');
  fs.writeFileSync(hook, `
    const fs = require('node:fs');
    const real = fs.readFileSync;
    let fired = false;
    fs.readFileSync = function (p, ...rest) {
      const out = real.call(this, p, ...rest);
      if (!fired && String(p).endsWith('.tsx')) {
        fired = true;
        real.call(fs, ${JSON.stringify(specFile)}, 'utf8');
        fs.writeFileSync(${JSON.stringify(specFile)}, JSON.stringify({ app: { name: 'Edited By Someone Else' }, pages: [] }, null, 2));
      }
      return out;
    };
  `, 'utf8');

  let r;
  try {
    execFileSync(process.execPath, ['--require', hook, CLI, '--spec', '@' + specFile, '--working-dir', dir], { encoding: 'utf8' });
    r = { code: 0 };
  } catch (e) {
    r = { code: e.status, stderr: String(e.stderr || '') };
  }
  assert.equal(r.code, 3, 'must fail closed on a concurrent edit');
  assert.match(r.stderr, /app spec changed while pages were being validated/);
  // The concurrent editor's content is intact — we did not overwrite it.
  assert.equal(readSpec(dir).app.name, 'Edited By Someone Else');
});

test('unrelated spec content survives the rewrite', () => {
  const spec = twoPageSpec();
  spec.entities = [{ logicalName: 'co_thing', columns: [{ logicalName: 'co_name', type: 'Text' }] }];
  spec.appShell = { areas: [{ title: 'Main' }] };
  const dir = makeWorkspace(spec, { 'overview.tsx': GOOD, 'detail.tsx': GOOD });
  assert.equal(run(dir).code, 0);
  const after = readSpec(dir);
  assert.deepEqual(after.entities, spec.entities);
  assert.deepEqual(after.appShell, spec.appShell);
});
