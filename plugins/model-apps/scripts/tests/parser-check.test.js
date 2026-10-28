'use strict';
// The parser check (lib/typescript-views.js). The lexer (source-literals.js) has no parser, and where it guesses what a construct is it says so (`onAmbiguity`):
// the navigation oracle (pageref-resolver.js) then trusted nothing at or after the guess, and the structure gate (page-structure.js) read the page as the lexer
// guessed it — a generic call signature in an interface, read as an element whose text runs on, made a complete page look cut off. Now both ask the TypeScript
// compiler the pages are compiled with, where the lexer guessed, and read the page as it parses it. These tests hold three things:
//   - the views the parser's tokens are turned into are the lexer's own, character for character, on every page the lexer reads with no guess — the committed
//     pages and the generated valid pages — and the structure checks give the same answers from either, so the gates' rules read the parser's views as they read
//     the lexer's;
//   - with it, every valid page TypeScript parses resolves its navigation call, wherever the lexer guessed, and the data after it (a regex and a string that hold
//     the text of a call) is never rewritten;
//   - the shapes the lexer refused after a guess resolve, and pass the structure gate; and where the parser does not answer — a page it does not parse, or a JSX
//     attribute string after trivia, which other compilers read differently — the lexer's reading stands, as it did.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { blankLiterals, blankNonCodePreservingTemplateExpressions, commentRanges, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets } = require('../lib/source-literals.js');
const { typescriptViews, guessedPageViews, setParserCheck } = require('../lib/typescript-views.js');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');
const { resolvePageRefs, strayPageRefs, navigationFrontier } = require('../lib/pageref-resolver.js');
const { pageStructureProblems } = require('../lib/page-structure.js');
const { validPages, heldOpenLinePages, NAVIGATION_CALL } = require('./helpers/valid-pages.js');
const { loadBabelOracle } = require('./helpers/typescript-oracle.js');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const ID = '11111111-1111-4111-8111-111111111111';
const ts = loadVendoredTypeScript();
const parses = (code) => ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const navigationCalls = (source) => {
  let found = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') found += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};
// Whether the lexer guessed on the page, and the kinds it named.
const guesses = (code) => {
  const kinds = new Set();
  blankNonCodePreservingTemplateExpressions(code, { onAmbiguity: (at, kind) => kinds.add(kind) });
  return kinds;
};
// What the oracle does with a page: whether it resolves the page's call (and changes nothing else), and the guess it names where it does not.
const reading = (code) => {
  const deployed = resolvePageRefs(new Map([['page', { code }]]), new Map([['detail', ID]])).deployment.get('page');
  const frontier = navigationFrontier(code);
  return { deployed, resolves: deployed === code.replace('"PAGEREF_detail"', `"${ID}"`), kind: frontier ? frontier.kind : null };
};
const DECOY_REGEX = `  const decoyRegex = /${NAVIGATION_CALL.replace(/;$/, '')}/;`;
const DECOY_STRING = `  const decoyString = '</T></U></b></A></B></W></Cmp>;${NAVIGATION_CALL}//';`;
const withDecoys = (code) => code.replace(`  ${NAVIGATION_CALL}`, `${DECOY_REGEX}\n${DECOY_STRING}\n  ${NAVIGATION_CALL}`);
const decoysIntact = (deployed) => deployed.includes(DECOY_REGEX) && deployed.includes(DECOY_STRING);
const committedPages = () => execFileSync('git', ['-C', REPO, 'ls-files', '*.tsx'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .map((file) => [file, fs.readFileSync(path.join(REPO, file), 'utf8')]);

test('parser check: the views built from TypeScript\'s parse are the lexer\'s own on every page the lexer reads with no guess, and the structure checks agree on them', () => {
  const stats = { pages: 0, compared: 0, structure: 0 };
  const differ = [];
  const compare = (what, code, structure) => {
    stats.pages += 1;
    if (guesses(code).size > 0) return;
    const views = typescriptViews(code);
    if (views === null) return;
    stats.compared += 1;
    if (views.literal !== blankLiterals(code)) differ.push(`${what}: the literal view`);
    if (views.keep !== blankNonCodePreservingTemplateExpressions(code)) differ.push(`${what}: the executable view`);
    const comments = commentRanges(code).map(({ start, end }) => `${start}-${end}`).join(' ');
    if (views.comments.map(({ start, end }) => `${start}-${end}`).join(' ') !== comments) differ.push(`${what}: the comments`);
    if (!structure) return;
    stats.structure += 1;
    for (const [name, check] of [['hasDefaultExport', hasDefaultExport], ['hasUnbalancedBrackets', hasUnbalancedBrackets], ['endsMidStatement', endsMidStatement], ['findElisionMarker', findElisionMarker]]) {
      if (check(code, views) !== check(code)) differ.push(`${what}: ${name}`);
    }
  };
  // The structure checks, from either view: on every committed page, and on one generated page in five.
  for (const [file, code] of committedPages()) compare(file, code, true);
  let index = 0;
  for (const page of validPages()) compare(`${page.group}: ${page.name}`, page.code, index++ % 5 === 0);
  assert.deepEqual(differ.slice(0, 8), [], `${differ.length} differences`);
  assert.ok(stats.compared >= 25000 && stats.structure >= 5000, JSON.stringify(stats));
});

test('parser check: with the parser asked where the lexer guessed, every valid page TypeScript parses resolves its call, and the data after it is never rewritten', () => {
  const stats = { valid: 0, guessed: 0, resolved: 0, keptGuess: 0 };
  // The pages the lexer guessed on, by the first guess it named — each of them resolved now.
  const byKind = new Map();
  const refused = [];
  const unsound = [];
  for (const page of validPages()) {
    const source = parses(page.code);
    if (source.parseDiagnostics.length > 0 || navigationCalls(source) !== 1) continue;
    stats.valid += 1;
    const kinds = guesses(page.code);
    const here = reading(page.code);
    if (kinds.size > 0) {
      stats.guessed += 1;
      const first = [...kinds][0];
      if (here.resolves) byKind.set(first, (byKind.get(first) || 0) + 1);
    }
    if (here.resolves) stats.resolved += 1;
    else if (kinds.has('jsx-attribute')) stats.keptGuess += 1;
    else refused.push(`${page.group}: ${JSON.stringify(page.name)} (${here.kind})`);
    const decoyed = withDecoys(page.code);
    if (parses(decoyed).parseDiagnostics.length === 0 && !decoysIntact(reading(decoyed).deployed)) unsound.push(`${page.group}: ${JSON.stringify(page.name)}`);
  }
  assert.deepEqual(unsound.slice(0, 5), [], 'a page whose data is read as code and rewritten');
  assert.deepEqual(refused.slice(0, 8), [], `${refused.length} valid pages are refused`);
  // The pages the lexer guessed on are many, of each kind it names on the generated valid pages (`keyword`, `operator` and `brace` are met by the shapes below), and
  // all of them resolve now.
  assert.ok(stats.valid >= 25000 && stats.guessed >= 300, JSON.stringify(stats));
  for (const kind of ['angle', 'generic', 'newline']) assert.ok(byKind.get(kind) > 0, `${kind}: ${JSON.stringify([...byKind])}`);
});

// The shapes the lexer refused after a guess, each with a navigation call after it: the lexer names the guess, and with the parser asked the call resolves and the
// page passes the structure gate. [what, snippet, the guess the lexer names]
const WRAP = (snippet) => `import * as React from "react";\n${snippet}\nexport default function Page() {\n  ${NAVIGATION_CALL}\n  return null;\n}\n`;
const ELEMENT = 'void <span>(MARK); // note</span>;';
const GUESSED_SHAPES = [
  // A generic call signature in an interface: the lexer reads an element whose text runs to the end of the file, and the page as cut off.
  ['a generic call signature in an interface', 'interface Api { <U>(x: U): U; }', 'generic'],
  ['a generic construct signature in a type literal', 'type Make = { new <U>(x: U): U };', 'generic'],
  // A `>` before a `/` or a `<`, a `/` on a later line than its operand, and a `<` after the cut `>=`.
  ['type arguments and then a division', 'declare const f: <A>(x: number) => number; declare const x: number;\nconst v = f<number> / x / 2;', 'angle'],
  ['a comparison and then a regex', 'const a = 1;\nconst c = a > /re/.test("x") ? 1 : 2;', 'angle'],
  ['a division on the next line', 'declare const x: number;\nconst r5 = x\n/ 2 / 3;', 'newline'],
  ['the end of type arguments and an initializer that is a generic arrow', 'type X = unknown; type A<T> = T;\nlet x: A<number>= <T extends X>(y: T): T => y;', 'operator'],
  // Class heads the lexer does not read: a function expression or an object literal for the base, type arguments after a class expression.
  ['a function expression for a class\'s base', `const registry = { Adapter: class extends function () {} {}, render() { ${ELEMENT} } };`, 'generic'],
  ['an object literal for a class\'s base', `const registry = { Adapter: class extends {} {}, render() { ${ELEMENT} } };`, 'generic'],
  ['type arguments after a class expression', `const registry = { Adapter: class extends class {}<T> {}, render() { ${ELEMENT} } };`, 'brace'],
  // Type parameters on keyword-named methods.
  ['a method named `in` with type parameters', 'interface I { in<U>(y: U): void; }', 'generic'],
  ['a method named `new` with type parameters', 'interface I { new<U>(y: U): void; }', 'generic'],
  ['a method named `return` with type parameters', 'interface I { return<U>(y: U): void; }', 'generic'],
  ['`get` and `set` with type parameters', 'class C { get<T>(x: T) { return x; } set<T>(x: T) { return x; } }', 'keyword'],
  ['methods named `await` and `yield` with type parameters', 'interface I { await<U>(y: U): void; yield<U>(y: U): void; }', 'keyword'],
  ['an optional method named `delete` with type parameters', 'interface I { delete?<U>(y: U): void; }', 'generic'],
];

test('parser check: the shapes the lexer refused after a guess resolve their navigation call, and pass the structure gate', () => {
  for (const [what, snippet, kind] of GUESSED_SHAPES) {
    const code = WRAP(snippet);
    assert.equal(parses(code).parseDiagnostics.length, 0, `TypeScript parses ${what}`);
    assert.ok(guesses(code).has(kind), `${what}: the lexer guesses "${kind}" (${[...guesses(code)].join(', ')})`);
    assert.equal(reading(code).resolves, true, `${what}: the call resolves`);
    assert.deepEqual(strayPageRefs(code), [], `${what}: no token is stray`);
    assert.deepEqual(pageStructureProblems(code), [], `${what}: the page is complete`);
    // With the lexer alone the call is refused, as it was.
    setParserCheck(false);
    try {
      assert.equal(reading(code).resolves, false, `${what}: the lexer alone refuses it`);
    } finally {
      setParserCheck(true);
    }
  }
});

// JSX text with a `//` note on one line and a later line that starts with a `/`, where a member of a type may begin (valid-pages.js, heldOpenLinePages): the lexer
// cannot tell the element from the members of a type that hold the closing tag in the regex the `/` begins, and refuses the call after it; TypeScript reads the
// element, and with it asked the call resolves.
test('parser check: JSX text with a note and a later line that starts with a "/", where a member of a type may begin, resolves the call after it', () => {
  let valid = 0;
  const wrong = [];
  for (const page of heldOpenLinePages()) {
    const source = parses(page.code);
    if (source.parseDiagnostics.length > 0 || navigationCalls(source) !== 1) continue;
    valid += 1;
    if (!guesses(page.code).has('generic')) wrong.push(`${page.group} / ${page.name}: no guess`);
    if (!reading(page.code).resolves) wrong.push(`${page.group} / ${page.name}: not resolved`);
  }
  assert.deepEqual(wrong.slice(0, 5), []);
  assert.ok(valid >= 150, `only ${valid} pages were valid`);
});

test('parser check: a call signature in an interface no longer reads as a cut, and the structure gate still refuses what TypeScript reads as cut off or elided', () => {
  const head = 'interface Api { <U>(x: U): U; }\n';
  const complete = `${head}export default function P() { return null; }\n`;
  assert.deepEqual(pageStructureProblems(complete), []);
  // A cut inside the export: TypeScript reports it, so the lexer's reading stands, and the page is refused.
  assert.ok(pageStructureProblems(`${head}export default function P() { return <div>`).length > 0);
  // A dangling `let`: TypeScript's parser reads it as a name, which strict code reserves (Babel refuses it), so the parse vouches for nothing, the lexer's reading
  // stands, and the page is refused as cut off.
  assert.equal(guessedPageViews(`${complete}let`).views, null);
  assert.ok(pageStructureProblems(`${complete}let`).includes('stops mid-statement — the file looks truncated'));
  // A page with no default export is refused from the parser's views as from the lexer's.
  assert.match(pageStructureProblems(`${head}const x = 1;\n`).join('\n'), /no complete default export/);
  // A comment that elides code, after the construct the lexer misread (to it, the comment was the text of an element).
  assert.deepEqual(pageStructureProblems(`${head}// TODO: wire the handler\nexport default function P() { return null; }\n`), ['contains a TODO/FIXME comment — the page is incomplete']);
  // A markdown fence around the code is still prose.
  assert.match(pageStructureProblems(`\`\`\`tsx\n${complete}\`\`\`\n`).join('\n'), /markdown code fence|truncated|default export/);
});

test('parser check: where the parser does not answer, the lexer\'s reading stands — a page TypeScript does not parse, and a JSX attribute string after trivia', () => {
  // TypeScript reports an error in the page (a `>` in JSX text): the guess stands, and the call after it is not resolved.
  const unparsed = WRAP('interface Api { <U>(x: U): U; }\nconst bad = <b>a > b</b>;');
  assert.ok(parses(unparsed).parseDiagnostics.length > 0);
  assert.equal(typescriptViews(unparsed), null);
  assert.equal(reading(unparsed).resolves, false);
  // A JSX attribute string whose quote follows trivia and whose text holds a backslash: TypeScript reads it with escapes, Babel and esbuild without, so the two end
  // it at different quotes — the parser does not settle that, and the guess stays.
  const attribute = WRAP("const e = <C x= '\\'/>;' />;");
  assert.equal(parses(attribute).parseDiagnostics.length, 0);
  assert.ok(guesses(attribute).has('jsx-attribute'));
  assert.equal(reading(attribute).resolves, false);
  assert.equal(navigationFrontier(attribute).kind, 'jsx-attribute');
});

// What the parser vouches for is told from its own parse, not from the lexer's guesses: an earlier misread can make the lexer skip a JSX attribute string after trivia,
// which it then never names (`jsx-attribute`), and grammar that only TypeScript's parser takes names no guess at all. Babel reads both differently, or not at all.
const BABEL_CALLS = (babel, code) => {
  let tree;
  try {
    tree = babel.parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return null;
  }
  let found = 0;
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'navigateTo') found += 1;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) for (const child of value) walk(child);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(tree.program);
  return found;
};
// [what, attribute after `<C x=`, whether TypeScript and Babel read it alike]: the quote right after the `=` is a JSX string to both, and so is a string with no backslash.
const ATTRIBUTES = [
  ['a string after a space, with an escaped quote', " '\\'/>;//' />", false],
  ['a string after a comment, with an escaped quote', "/* c */'\\'/>;//' />", false],
  ['a string after a line break, with a backslash', "\n  'a\\\\' />", false],
  ['a string right after the `=`', "'a' />", true],
  ['a string after a space, with no backslash', " 'a' />", true],
];

test('parser check: a JSX attribute string after trivia keeps the navigation oracle\'s frontier, though a misread hid it from the lexer', (t) => {
  const babel = loadBabelOracle();
  // The page the parsers read differently: TypeScript reads the call; Babel ends the string at its first quote and reads the call in a comment.
  const differ = 'const n = {valueOf(){return 12;}}/2; const e = <C x= \'\\\'/>;//\' />; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});\n'
    + 'export default function P(){return null;}';
  assert.equal(parses(differ).parseDiagnostics.length, 0);
  assert.equal(navigationCalls(parses(differ)), 1);
  assert.deepEqual([...guesses(differ)], ['brace'], 'the lexer names the misread, and not the attribute it hid');
  assert.equal(navigationFrontier(differ)?.kind, 'brace', 'the frontier stands');
  const { deployment, residual } = resolvePageRefs(new Map([['page', { code: differ }]]), new Map([['detail', ID]]));
  assert.equal(deployment.get('page'), differ, 'nothing is rewritten');
  assert.deepEqual(residual.map(({ token }) => token), ['PAGEREF_detail'], 'the token is reported');
  assert.equal(guessedPageViews(differ).views, null);
  if (babel) assert.equal(BABEL_CALLS(babel, differ), 0, 'Babel reads no call');
  // Each guess the lexer names (GUESSED_SHAPES) before each attribute: where the two parsers read the string alike the parser vouches for the page and the call resolves;
  // where they do not, the frontier stands, whether or not the lexer saw the attribute after its guess.
  let compared = 0;
  for (const [what, snippet, kind] of GUESSED_SHAPES) {
    for (const [attributeWhat, attribute, alike] of ATTRIBUTES) {
      const code = WRAP(`${snippet}\nconst e = <C x=${attribute};`);
      const name = `${what}, ${attributeWhat}`;
      assert.equal(parses(code).parseDiagnostics.length, 0, `TypeScript parses ${name}`);
      assert.ok(guesses(code).has(kind), `${name}: the lexer guesses "${kind}"`);
      assert.equal(reading(code).resolves, alike, `${name}: the call resolves`);
      assert.equal(guessedPageViews(code).views !== null, alike, `${name}: the parser vouches for it`);
      if (babel && alike) assert.equal(BABEL_CALLS(babel, code), 1, `${name}: Babel reads the call`);
      compared += 1;
    }
  }
  assert.equal(compared, GUESSED_SHAPES.length * ATTRIBUTES.length);
  if (!babel) t.diagnostic('no Babel parser oracle: set BABEL_ORACLE_PATH to an @babel/parser package to compare the readings');
});

test('parser check: the structure gate reads a page with a JSX attribute string after trivia as the lexer does, as the navigation oracle does', () => {
  const babel = loadBabelOracle();
  // The page Babel refuses (the string ends at its escaped quote): the structure gate reads it as the lexer does, and refuses it as cut off, as before.
  const refused = "interface Api { <U>(x:U):U; }\nconst e = <C x= 'it\\'s'/>;\nexport default function P(){return null;}";
  assert.equal(parses(refused).parseDiagnostics.length, 0);
  assert.equal(pageStructureProblems(refused).length, 3);
  if (babel) assert.equal(BABEL_CALLS(babel, refused), null, 'Babel refuses the page');
  // Each guess before each attribute the two parsers read differently: the structure gate's answer is the lexer's, whether or not the lexer saw the attribute.
  for (const [what, snippet] of GUESSED_SHAPES) {
    for (const [attributeWhat, attribute, alike] of ATTRIBUTES) {
      if (alike) continue;
      const code = WRAP(`${snippet}\nconst e = <C x=${attribute};`);
      const problems = pageStructureProblems(code);
      setParserCheck(false);
      try {
        assert.deepEqual(problems, pageStructureProblems(code), `${what}, ${attributeWhat}: the structure gate reads it as the lexer does`);
      } finally {
        setParserCheck(true);
      }
    }
  }
});

// Grammar TypeScript's parser takes and leaves to its checker, which Babel's parser refuses, on a page the lexer guessed on: the parser vouches for nothing, and the
// lexer's reading stands — as on a page TypeScript does not parse. Their neighbours, which both parse, are read as the parser reads them. [what, declaration, both parse it]
const ONLY_TYPESCRIPT_TAKES = [
  ['`await` for a name', 'function f2() { return await; }', false], ['`yield` for a name', 'const y = (x: number) => yield;', false],
  ['`let` for a name', 'declare const v: number; const w = let;', false], ['`static` for a variable', 'declare const s: number; const t2 = static;', false],
  ['a reserved word for a type\'s name', 'type I = if;', false], ['a JSDoc nullable type', 'type J = ?string;', false], ['a JSDoc non-null type', 'type K = string!;', false],
  ['the JSDoc any type', 'type L = *;', false], ['a predicate outside a return type', 'type P = asserts x;', false], ['`readonly` before a name', 'type R = readonly string;', false],
  ['an empty list of type arguments', 'type E = Array<>;', false],
  ['`readonly` before an array type', 'type R2 = readonly string[];', true], ['a method named `yield`', 'interface Y { yield<U>(y: U): void; }', true],
  ['a property named `let`', 'const o = { let: 1, static: 2 }; const q = o.let;', true], ['a predicate in a return type', 'declare function isS(x: unknown): x is string;', true],
];

test('parser check: grammar only TypeScript\'s parser takes keeps the lexer\'s reading; what both parsers take is read as TypeScript parses it', () => {
  const babel = loadBabelOracle();
  for (const [what, declaration, both] of ONLY_TYPESCRIPT_TAKES) {
    const code = WRAP(`interface Api { <U>(x: U): U; }\n${declaration}`);
    assert.equal(parses(code).parseDiagnostics.length, 0, `TypeScript parses ${what}`);
    assert.ok(guesses(code).has('generic'), `${what}: the lexer guesses`);
    assert.equal(reading(code).resolves, both, `${what}: the call resolves`);
    assert.equal(pageStructureProblems(code).length === 0, both, `${what}: the structure gate reads it as ${both ? 'TypeScript parses it' : 'the lexer does'}`);
    assert.equal(guessedPageViews(code).views !== null, both, `${what}: the parser vouches for it`);
    if (babel) assert.equal(BABEL_CALLS(babel, code) !== null, both, `${what}: Babel ${both ? 'parses' : 'refuses'} it`);
  }
});

// With the Babel oracle: every generated valid page the lexer guessed on and the parser vouches for (whose calls the gates then read as TypeScript parses the page) is
// one Babel parses too, with the same navigation calls.
test('parser check: every guessed page the parser vouches for is one Babel parses, with the calls TypeScript reads', (t) => {
  const babel = loadBabelOracle();
  if (!babel) return t.skip('no Babel parser oracle: set BABEL_ORACLE_PATH to an @babel/parser package to run it');
  let vouched = 0;
  const differ = [];
  for (const page of [...validPages(), ...heldOpenLinePages()]) {
    if (guesses(page.code).size === 0 || !reading(page.code).resolves) continue;
    vouched += 1;
    const calls = BABEL_CALLS(babel, page.code);
    if (calls !== navigationCalls(parses(page.code))) differ.push(`${page.group}: ${JSON.stringify(page.name)} (Babel: ${calls})`);
  }
  assert.deepEqual(differ.slice(0, 5), [], `${differ.length} pages`);
  assert.ok(vouched >= 300, `vouched for ${vouched} guessed pages`);
});

// The pages built to make the lexer misread (helpers/misread-page.js), run in a JavaScript engine: with the parser asked where the lexer guessed, whatever the resolver
// rewrites leaves every regex as it was, and every call the page makes navigates to the page id — the call the lexer hid included.
test('parser check: a page the lexer misreads, resolved as TypeScript parses it, makes every call it made with its page id, and rewrites no regex', () => {
  const vm = require('node:vm');
  const { MISREAD_PAGES, OBJECT_DIVISION_PAGE_RUNNABLE, runnable } = require('./helpers/misread-page.js');
  const exec = (code) => {
    const calls = [];
    const tested = [];
    const context = vm.createContext({ navigateTo: (options) => calls.push(options.pageId), __tested: tested });
    vm.runInContext('RegExp.prototype.test = function () { __tested.push(this.source); return false; };', context);
    vm.runInContext(code, context, { timeout: 1000 });
    return { calls, tested };
  };
  for (const [name, code] of [['the object-division page', OBJECT_DIVISION_PAGE_RUNNABLE], ...['brace', 'paren', 'keyword'].map((kind) => [kind, runnable(MISREAD_PAGES[kind].code)])]) {
    const before = exec(code);
    const { deployment, residual } = resolvePageRefs(new Map([['page', { code }]]), new Map([['detail', ID]]));
    const after = exec(deployment.get('page'));
    assert.deepEqual(after.tested, before.tested, `${name}: no regex is rewritten`);
    assert.equal(after.calls.length, before.calls.length, `${name}: the page makes every call it made`);
    assert.deepEqual(after.calls, before.calls.map((pageId) => (pageId === 'PAGEREF_detail' ? ID : pageId)), `${name}: every call navigates to the page id`);
    // A token left in the text of a regex or a string is data, which no call hands over: it is not rewritten, and the residue reports it (no token may stand there).
    for (const left of residual) assert.ok(!after.calls.includes(left.token), `${name}: a token left is no call's`);
  }
});

test('parser check: the views of a text are kept for the next check of the same text, and the lexer\'s own tests can turn the parser off', () => {
  // The views are kept for the last few texts asked about: the oracle reads a page several times per build (resolve, stray, residual).
  const code = WRAP('interface Api { <U>(x: U): U; }');
  const first = typescriptViews(code);
  assert.ok(first !== null);
  assert.equal(typescriptViews(code), first, 'the same text is not parsed again');
  // The seam the lexer's own tests use: off, the parser vouches for nothing.
  setParserCheck(false);
  try {
    assert.equal(typescriptViews(code), null);
  } finally {
    setParserCheck(true);
  }
  // A test seam for another compiler: given one, the views are built with it (and not kept).
  assert.deepEqual(typescriptViews(code, { ts }).keep, first.keep);
});
