'use strict';
// The regression net of the lexer: pages TypeScript parses, each with a navigation call after it, read by this lexer and by the base it was derived from.
//
// The navigation reader refuses what its lexer cannot read for certain (source-literals.js, `onAmbiguity`), and a refusal of a page that compiles costs the author a retry. So the claim the
// differential makes is one of precision, and the other half of it is soundness:
//
//   - SOUND: whatever page TypeScript parses, a call or string that TypeScript reads as DATA — a regex or a string that holds the text of a navigation call — is never rewritten. Each page
//     is read again with two such decoys after it; the base is counted too, which rewrites them in the places this lexer refuses.
//   - PRECISE: every valid page the lexer refuses is one of the RECORDED classes below, each a place where two programs share the text up to the decision and compile differently
//     (TWO_WAY shows both, with TypeScript's reading of each), and every refusal names its guess. A page that is refused and belongs to no class fails the test, so a regression of a new
//     shape cannot arrive silently; a class that no page meets fails too, so the list cannot go stale.
//
// The pages are tests/helpers/valid-pages.js: generic arrows and function expressions in every position, casts and `satisfies` with every operator and operand after them, instantiation
// expressions and hooks, interfaces and type literals with every member form, generic function types in every position and with every kind of parameter list, destructured and default
// parameters, and the statements an everyday page is made of. The base is optional: BASE_LIB_PATH points at the scripts/lib directory of the lexer before this change; without it the
// comparison is skipped and the rest runs.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadTypescriptOracle } = require('./helpers/typescript-oracle.js');
const { validPages, NAVIGATION_CALL, SIGNATURE_MEMBERS, HIDDEN_CLOSING_MEMBERS, HIDING_ELEMENTS, INITIALIZER_ELEMENTS } = require('./helpers/valid-pages.js');
const next = require('../lib/pageref-resolver.js');

const SKIP = 'no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it';
const ID = '11111111-1111-4111-8111-111111111111';
const loadBase = () => {
  const at = process.env.BASE_LIB_PATH;
  if (!at) return null;
  try {
    return require(path.join(at, 'pageref-resolver.js'));
  } catch {
    return null;
  }
};

// What a lexer does with a page: whether it resolves the call the page makes (and nothing else is changed), and the guess it names where it does not.
function reading(lib, code) {
  const resolved = lib.resolvePageRefs(new Map([['page', { code }]]), new Map([['detail', ID]]));
  const deployed = resolved.deployment.get('page');
  const frontier = lib.navigationFrontier ? lib.navigationFrontier(code) : null;
  return { deployed, resolves: deployed === code.replace('"PAGEREF_detail"', `"${ID}"`), kind: frontier ? frontier.kind : null };
}

// Two places where data holds the text of a navigation call, after the snippet and before the real call. TypeScript reads a regex and a string; a lexer that read the snippet wrongly reads
// them as code (a string that holds the closing tags that an element read by mistake would be looking for), and rewrites the token in them.
const DECOY_REGEX = `  const decoyRegex = /${NAVIGATION_CALL.replace(/;$/, '')}/;`;
const DECOY_STRING = `  const decoyString = '</T></U></b></A></B></W></Cmp>;${NAVIGATION_CALL}//';`;
const withDecoys = (code) => code.replace(`  ${NAVIGATION_CALL}`, `${DECOY_REGEX}\n${DECOY_STRING}\n  ${NAVIGATION_CALL}`);
const decoysIntact = (deployed) => deployed.includes(DECOY_REGEX) && deployed.includes(DECOY_STRING);

// ─── The classes of valid page this lexer refuses ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Each is { kind, what, matches }: the guess it names, the two programs that share the text, and which generated pages are in it.
const ANGLE_OPERATORS = ['>', '>>', '>>>', '/'];
const SLASH_OPERANDS = ['/re/', '<b>text</b>', '<b>{y}</b>', '<b/>', '<>x</>', '<T extends X>text</T>'];
// A `/` or `<` after a `/` is no class any more: the lexer read the first `/`, so it knows whether it ended a regex (an operand ended: a division or a comparison follows) or was the division
// operator (an operand follows: a regex or an element), and decides by it (source-literals.js, `ends`). What is left of the pair that once stood for it is a `>`: `x as A<B> / /re/` is a division
// by a regex after type arguments, and `a > / /re/` a comparison with a regex, which the first class holds.
const REFUSAL_CLASSES = [
  {
    id: 'a ">" before a "/" or "<"',
    kind: 'angle',
    what: 'a `>` that is not the end of `=>` and closes no cast, before a `/` or a `<`: a comparison and then a regex or an element, or the end of type arguments and then a division. `a > /re/` and `f<A> / x / 2` end in the same `> /`, and the two are told apart by whether what stands between the `<` and the `>` is a list of types, which only a type parser says.',
    matches: (page) => page.group === 'everyday' && /^const g\d+ = /.test(page.name),
  },
  {
    id: 'a generic call signature in an object type',
    kind: 'generic',
    what: 'a `<Name>`, a parameter list and a `:`: a call or construct signature with type parameters in an object type, or JSX text that starts with a parenthesis. `interface P { <U>(x: U): T }` and `<U>(x: U): T</U>` are the same text.',
    matches: (page) => /^type literal in a generic function type|^interface member|^type literal member|^class implements|^type literal in a parameter/.test(page.group) && /^(new )?<U>\(x: U\): T;$/.test(page.name),
  },
  {
    id: 'a call signature with no return type, and its closing tag in a string, a template or a comment of its type',
    kind: 'generic',
    what: 'a `<Name>`, a parameter list and no return type, then a string, a template or a comment of the same type that holds `</Name>`: `interface P { <U>(x: U); a: \'</U>\' }` is a type, and with that `</U>` closing it `<U>(x: U); a: \'</U>` is an element whose text starts with a parenthesis.',
    matches: (page) => /^type literal in a generic function type|^interface member|^type literal member|^class implements|^type literal in a parameter/.test(page.group) && HIDDEN_CLOSING_MEMBERS.includes(page.name),
  },
  {
    id: 'JSX text that starts with a parenthesis, then a `,`, `;` or line break, and a comment, a template or a regex that is open at its closing tag',
    kind: 'generic',
    what: 'the text after the `)` could be the members of a type that holds a comment, a template or a regex with the closing tag in it: `interface P { <U>(x: U); // </U> }` and `<U>(x: U); // </U>` share their text, and the closing tag is the end of the element in one and inside a comment in the other. Text before it that no type can hold (two names on a line, a name and a `/`) leaves no such type, and is read as the element.',
    matches: (page) => page.group === 'parenthesised element' && HIDING_ELEMENTS.includes(page.element),
  },
  {
    id: 'JSX text that starts with a parenthesis, where something may start an expression before its `)` and a `/`, a `<` or a back-tick follows',
    kind: 'generic',
    what: 'the parenthesised text could be the parameter list of a call signature with a default, a computed name, a decorator, an accessor\'s body or a constraint, and what follows may be a regex, JSX or a template that holds a `)` of its own: `interface P { <U>(a = /[)]/); m: \'</U>\' }` and `<U>(a = /[)]/); m: \'</U>` share their text, and the `)` that ends the list is another one in each.',
    matches: (page) => page.group === 'parenthesised element' && INITIALIZER_ELEMENTS.includes(page.element),
  },
  {
    id: 'a division on the next line',
    kind: 'newline',
    what: 'a `/` on a later line than the operand before it, where a regex could close on its line: a division that continues the statement, or (after a type) a regex that begins the next one. `const q = x` LF `/ y / z` and `let v: number` LF `/ y /.test(z)` are the same text.',
    matches: (page) => page.group === 'everyday' && page.name === 'const r5 = x\n/ y / z;',
  },
];

// ─── Pairs of programs with the same text, whose readings differ ───────────────────────────────────────────────────────────────────────────────────────────
// [what TypeScript reads, the snippet, the real navigation calls TypeScript finds in the page]. Each pair compiles; each page is refused after the class's guess; and where the base is given,
// at least one of the pair is read wrong by it — it rewrites the token of data, or leaves a real call as it was.
const CALL = 'navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})';
const TWO_WAY = [
  {
    kind: 'angle',
    pairs: [
      ['a comparison with a regex that holds the call', `const k = a > /${CALL}/;`, 0],
      ['an instantiation expression divided by the call', `const k = f<A> / ${CALL} / 2;`, 1],
      ['an instantiation expression divided, and a regex that holds the call', `const k = f<A> / 2; const re = /${CALL}/;`, 0],
    ],
  },
  {
    kind: 'generic',
    pairs: [
      ['an interface with a call signature, and a string that holds the call', `interface P { <U>(x: U): T; }\nconst s = '</U>;${CALL};//';`, 0],
      ['an element whose text starts with a parenthesis, then the call', `const el = <U>(x: U): T;</U>;\n${CALL};`, 1],
      ['a type literal with a call signature, then the call', `type P = { <U>(x: U): T; };\n${CALL};`, 1],
      // The same text with no return type: the type's string holds the closing tag and the call, and an element's text ends at the closing tag that is in it.
      ['an interface with a call signature with no return type, and a string that holds the closing tag and the call', `interface P { <U>(x: U); a: '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis, which ends at the closing tag in what is a string to the type, then the call', `const el = <U>(x: U); a: '</U>;${CALL};//'`, 1],
      ['an interface with a call signature with no return type, and a comment that holds the closing tag and the call', `interface P { <U>(x: U); // </U>;${CALL};\n}`, 0],
      ['an element whose text starts with a parenthesis, which ends at the closing tag in what is a comment to the type, then the call', `const el = <U>(x: U); // </U>;${CALL};`, 1],
      // A default in the parameter list: the regex holds a `)`, which ends the list in a scan of it and is the regex's to the type.
      ['an interface with a call signature whose default is a regex that holds a `)`, and a string that holds the closing tag and the call', `interface P { <U>(a = /[)]/); m: '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds the same default, then the call', `const el = <U>(a = /[)]/); m: '</U>;\n${CALL};`, 1],
    ],
  },
  {
    kind: 'newline',
    pairs: [
      ['a regex statement after a type annotation, which holds the call', `let v: number\n/${CALL}/.test(z);`, 0],
      ['a division that continues the statement', `const q = x\n/ y / ${CALL};`, 1],
    ],
  },
  {
    kind: 'operator',
    // A head with a constraint and a parameter list that a colon follows, after the cut `>=`: the first `>` may have ended type arguments, so the `>` and `=` are a cut that this lexer
    // cannot make, and the colon leaves the arrow's return type and JSX text open. No generated page has this shape (a head with no parameter list, `<T extends X>text</T>`, is an element
    // whatever the cut is, and is read as one), so the pair stands for it. The base reads both of these right, by looking past the head for an arrow; the lexer here reads the head and
    // its parameter list. Both compile, and the same text up to the colon is read two ways.
    baseRight: true,
    pairs: [
      ['an element after `>=` whose text starts with a parenthesis and a colon', `const k = a >= <T extends X>(y: T): T</T>; const re = /${CALL}/;`, 0],
      ['an arrow with a return type, after the end of type arguments', `let x: A<number>= <T extends X>(y: T): T => y;\n${CALL};`, 1],
    ],
  },
];

const wrap = (snippet) => `import * as React from "react";\nexport default function Page() {\n  ${snippet.replace(/\n/g, '\n  ')}\n  return null;\n}\n`;
const parses = (ts, code) => ts.createSourceFile('page.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const realCalls = (ts, source) => {
  let found = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') found += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

// The shapes that were refused, with a guess named, where only one program has the text: each is certain now, and a page of one that is refused again fails the test (and a shape that no valid page
// has fails it too), so the rule behind each is pinned here as well as in its own unit test.
const CERTAIN_SHAPES = [
  ['a cast, then `>`, `>>`, `>>>`, `/` or `<` and a regex or an element: the closer of a cast and the operator after it are read for certain', (page) => page.group === 'cast then operator' && ANGLE_OPERATORS.includes(page.parts.operator) && SLASH_OPERANDS.includes(page.parts.operand)],
  ['a regex or an element, then a division or a comparison, or a division, then a regex or an element', (page) => page.group === 'everyday' && /^const m\d+ = /.test(page.name)],
  ['an element as an attribute value', (page) => page.group === 'everyday' && /^const v\d+ = /.test(page.name)],
  ['a comment in a closing tag', (page) => page.group === 'everyday' && /^const c\d+ = /.test(page.name)],
  ['a regex with flags, then a division or a comparison, and a word that the flags spell', (page) => page.group === 'everyday' && /^const w\d+ = /.test(page.name)],
  ['a self-closing tag with trivia between its `/` and its `>`', (page) => page.group === 'everyday' && /^const z\d+ = /.test(page.name)],
  ['a closing tag name with a colon or a dot and trivia around it', (page) => page.group === 'everyday' && /^const k\d+ = /.test(page.name)],
  ['a generic function type with a comment in its object type', (page) => page.group === 'everyday' && /^const h\d+: /.test(page.name)],
  ['an element whose text starts with a parenthesis and holds an apostrophe, with a string after it on its line', (page) => page.group === 'everyday' && /^const q\d+ = /.test(page.name)],
  ['a hashbang', (page) => page.group === 'hashbang'],
  ['a method named `async` that has type parameters, or `async` and a comparison', (page) => page.group.startsWith('declaration') && /^(const o[34]|class F2|const r[234])\b/.test(page.name)],
  ['a quoted method signature in an object type', (page) => /^type literal in a (parameter|generic function type)/.test(page.group) && /^(['"])(?:m|a\\'b)\1\(/.test(page.name)],
  ['a call or construct signature with no return type', (page) => /^type literal in a generic function type|^interface member|^type literal member|^class implements|^type literal in a parameter/.test(page.group) && SIGNATURE_MEMBERS.includes(page.name)],
  ['an element whose text starts with a parenthesis', (page) => page.group === 'parenthesised element' && !HIDING_ELEMENTS.includes(page.element) && !INITIALIZER_ELEMENTS.includes(page.element)],
];

test('valid pages: this lexer never reads the text of a call as a call, and refuses a page that compiles only in the recorded classes, naming its guess', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const base = loadBase();
  const stats = { pages: 0, valid: 0, resolved: 0, refused: 0, baseResolved: 0, baseRegressions: 0, baseImprovements: 0, baseDecoysRewritten: 0, decoysRewritten: 0 };
  const met = new Map(REFUSAL_CLASSES.map((cls) => [cls, 0]));
  const shapes = new Map(CERTAIN_SHAPES.map(([what]) => [what, { valid: 0, resolved: 0 }]));
  const unexplained = [];
  const unsound = [];
  const silent = [];
  const refusedAgain = [];
  for (const page of validPages()) {
    stats.pages += 1;
    const source = parses(ts, page.code);
    if (source.parseDiagnostics.length > 0 || realCalls(ts, source) !== 1) continue;
    stats.valid += 1;
    const here = reading(next, page.code);
    for (const [what, belongs] of CERTAIN_SHAPES) {
      if (!belongs(page)) continue;
      shapes.get(what).valid += 1;
      if (here.resolves) shapes.get(what).resolved += 1;
      else refusedAgain.push(`${what}: ${page.group} / ${JSON.stringify(page.name)} (${here.kind})`);
    }
    if (here.resolves) stats.resolved += 1;
    else {
      stats.refused += 1;
      const cls = REFUSAL_CLASSES.find((candidate) => candidate.kind === here.kind && candidate.matches(page));
      if (here.kind === null) silent.push(page.name);
      else if (cls) met.set(cls, met.get(cls) + 1);
      else unexplained.push(`${page.group} / ${here.kind}: ${JSON.stringify(page.name)}`);
    }
    // The data after the snippet is never rewritten, wherever the snippet is read right or wrong.
    const decoyed = withDecoys(page.code);
    if (parses(ts, decoyed).parseDiagnostics.length === 0 && !decoysIntact(reading(next, decoyed).deployed)) { stats.decoysRewritten += 1; unsound.push(`${page.group}: ${JSON.stringify(page.name)}`); }
    if (base) {
      const there = reading(base, page.code);
      if (there.resolves) stats.baseResolved += 1;
      if (there.resolves && !here.resolves) stats.baseRegressions += 1;
      if (!there.resolves && here.resolves) stats.baseImprovements += 1;
      if (parses(ts, decoyed).parseDiagnostics.length === 0 && !decoysIntact(reading(base, decoyed).deployed)) stats.baseDecoysRewritten += 1;
    }
  }
  t.diagnostic(`${stats.pages} pages, ${stats.valid} valid to TypeScript: ${stats.resolved} resolved, ${stats.refused} refused after a named guess; decoys rewritten: ${stats.decoysRewritten}`
    + `${base ? `; the base resolves ${stats.baseResolved}, refuses ${stats.baseRegressions} that it resolves and resolves ${stats.baseImprovements} that it does not, and rewrites the decoys of ${stats.baseDecoysRewritten}` : '; no base lexer (BASE_LIB_PATH): not compared'}`);
  t.diagnostic(`refused, by class: ${REFUSAL_CLASSES.map((cls) => `${cls.id}: ${met.get(cls)}`).join('; ')}`);
  t.diagnostic(`certain shapes, resolved of valid: ${[...shapes].map(([what, n]) => `${what}: ${n.resolved}/${n.valid}`).join('; ')}`);
  assert.deepStrictEqual(refusedAgain.slice(0, 8), [], 'a page of a shape that is certain now is refused again');
  assert.deepStrictEqual([...shapes].filter(([, n]) => n.valid === 0).map(([what]) => what), [], 'a shape that no valid page has');
  assert.deepStrictEqual(unsound.slice(0, 5), [], 'a page whose data is read as code and rewritten');
  assert.deepStrictEqual(silent.slice(0, 5), [], 'a valid page the lexer refuses with no guess to name');
  assert.deepStrictEqual(unexplained.slice(0, 8), [], `${unexplained.length} valid pages are refused that belong to no recorded class`);
  assert.deepStrictEqual([...met].filter(([, n]) => n === 0).map(([cls]) => cls.id), [], 'a recorded class that no page meets');
  // The net is not vacuous, and the lexer is precise: nearly every page that compiles is resolved.
  assert.ok(stats.valid >= 25000, `only ${stats.valid} pages were valid`);
  assert.ok(stats.resolved >= 0.96 * stats.valid, `only ${stats.resolved} of ${stats.valid} valid pages were resolved`);
  if (base) {
    assert.ok(stats.baseDecoysRewritten >= 100 && stats.baseDecoysRewritten > stats.decoysRewritten, `the base rewrites ${stats.baseDecoysRewritten} decoys, this lexer ${stats.decoysRewritten}`);
    assert.ok(stats.baseImprovements >= 100, `${stats.baseImprovements} pages are resolved here and not by the base`);
  }
});

// Each recorded class is a place where the same text compiles two ways: both pages parse, TypeScript finds the calls the table says, this lexer refuses both after the class's guess, and
// where the base is given it reads one of them wrong.
test('valid pages: each recorded class is two programs with the same text, both of which compile and which a lexer without a parser cannot tell apart', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const base = loadBase();
  for (const { kind, pairs, baseRight } of TWO_WAY) {
    let baseWrong = 0;
    for (const [what, snippet, calls] of pairs) {
      const code = wrap(snippet);
      const source = parses(ts, code);
      assert.deepStrictEqual(source.parseDiagnostics.map((d) => d.code), [], `${kind}: ${what} compiles`);
      assert.strictEqual(realCalls(ts, source), calls, `${kind}: ${what}: the calls TypeScript reads`);
      const here = reading(next, code);
      assert.strictEqual(here.kind, kind, `${kind}: ${what}: the guess`);
      assert.ok(!here.resolves && here.deployed === code, `${kind}: ${what}: nothing is rewritten`);
      if (base) {
        const there = reading(base, code);
        // Wrong is the token of data rewritten (no real call, and the page changed), or a real call left (one call, and the page as it was).
        if ((calls === 0 && there.deployed !== code) || (calls === 1 && there.deployed === code)) baseWrong += 1;
      }
    }
    if (base && !baseRight) assert.ok(baseWrong >= 1, `${kind}: the base reads one of the pair wrong`);
  }
});
