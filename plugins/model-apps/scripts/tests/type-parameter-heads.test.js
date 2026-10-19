'use strict';

// Type-parameter heads that start like an element's head, and the places a member, a function type or an element may stand (source-literals.js: opensTypeParameters, signatureHeadFollows, memberMayBeginAt).
//
// TypeScript's rule for a `<` where an expression starts reads an element for `<in U>`, `<public U>` and `<>`, and for any head after `delete`, `typeof`, `void` or `instanceof`; in a type, a class or an object literal the same text is the
// type parameters of a call or construct signature, a method or a function type. The lexer tells them apart by what stands before the head and what follows its list, and a wrong reading takes the text of a type for JSX text that runs on to
// a closing tag in a later string, template, comment or regex, and the text of a navigation call there for code. The tests ask TypeScript's parser (TYPESCRIPT_ORACLE_PATH) what a program is, and derive from it the words and tokens the
// lexer must know: the words before a member's name, the tokens that end a member before a line break, the modifiers of a type parameter.
//
// What a test says is read as code is the name MARK: the lexer keeps a name where it reads code and blanks it where it reads text.

const { test } = require('node:test');
const assert = require('node:assert');
const { opensTypeParameters, blankNonCodePreservingTemplateExpressions, TYPE_PARAMETER_MODIFIERS, MEMBER_NAME_OPERATORS, MEMBER_PREFIX_WORDS, OPERATOR_WORD_ENDS_MEMBER_AFTER, OPERATOR_WORDS_THAT_ARE_NAMES, HEAD_NESTING } = require('../lib/source-literals.js');
const { resolvePageRefs, navigationFrontier } = require('../lib/pageref-resolver.js');
const { loadTypescriptOracle, loadBaseLexer } = require('./helpers/typescript-oracle.js');
const { cleanSourceFile, readingAt, isElement, tokenVocabulary } = require('./helpers/angle-frames.js');
const { NEWLINE_GAPS, DECORATED_PLACES, UNREADABLE_LISTS, UNREADABLE_HEADS, ESCAPED_HEADS, ESCAPE_PLACES, ESCAPE_GAPS, CLASS_HERITAGES, LAST_ELEMENT_HERITAGES, decoratorEndPages, decimalPointPages, NUMBER_GAPS, KEYWORD_NAMES, KEYWORD_BODIES, KEYWORD_METHOD_FRAMES, CLASS_VALUES_WRAPPED, OBJECT_VALUES, OBJECT_VALUE_FRAMES, SHORTHAND_NAMES, SHORTHAND_FRAMES } = require('./helpers/type-head-pages.js');

const SKIP = 'no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it';
const ID = '11111111-1111-4111-8111-111111111111';
const CALL = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})';
const ELEMENT = { generic: false, ambiguity: null };
const TYPE = { generic: true, ambiguity: null };
const GUESS = { generic: false, ambiguity: 'generic' };
const TYPE_GUESS = { generic: true, ambiguity: 'generic' };

const maskOf = (code) => blankNonCodePreservingTemplateExpressions(code);
const readsAsCode = (code) => maskOf(code).includes('MARK');
function guessesOf(code) {
  const found = [];
  blankNonCodePreservingTemplateExpressions(code, { onAmbiguity: (at, kind) => found.push([at, kind]) });
  return found;
}
const visible = (text) => JSON.stringify(text);

// A page for a type: the real call is in a handler first, a note holds the closing tag of the head's name and the text of a call, and the page's default export comes last. The `}` in the note balances the brace of the type that a lexer
// reading the head for an element swallows, so that no structure check can tell the misread from the page.
const pageOf = (types, closing) => `function openDetail() { ${CALL}; }\n${types}\nconst note = '</${closing}>};${CALL};//';\nexport default function Page() { return null; }\n`;
// The name that an element with the head closes with: its first word, and nothing for a fragment.
const closingOf = (head) => (/^<\s*([A-Za-z]+)/.exec(head) || [null, ''])[1];

// What the lexer does with a page that has two tokens, the real call first and data after it: the tokens it rewrites and the guess it names.
function readPage(code, lexer = { resolvePageRefs, navigationFrontier }) {
  const resolved = lexer.resolvePageRefs(new Map([['page', { code }]]), new Map([['detail', ID]]));
  const deployed = resolved.deployment.get('page');
  const before = [...code.matchAll(/"PAGEREF_detail"/g)];
  const after = [...deployed.matchAll(/"(?:PAGEREF_detail|11111111-1111-4111-8111-111111111111)"/g)];
  return { rewritten: before.filter((token, k) => after[k][0] === `"${ID}"`).map((token) => token.index), tokens: before.map((token) => token.index), frontier: lexer.navigationFrontier ? lexer.navigationFrontier(code) : null };
}
// `expect` is 'exact' (the real call is rewritten, the data is not, and no guess is named) or 'refused' (the data is not rewritten and a guess is named, so the page is refused after it): 'refused:identifier' names the kind of the
// guess, 'refused:identifier|newline' one of two (the first guess at a `<` is the one that the frontier names), and a plain 'refused' is the guess `generic`.
function assertRead(code, expect, label) {
  const { rewritten, tokens, frontier } = readPage(code);
  assert.strictEqual(tokens.length, 2, `${label}: a real call and a note`);
  assert.deepStrictEqual(rewritten.filter((at) => at !== tokens[0]), [], `${label}: the token in the note is data and is rewritten`);
  if (expect === 'exact') {
    assert.strictEqual(frontier, null, `${label}: no guess is named`);
    assert.deepStrictEqual(rewritten, [tokens[0]], `${label}: the real call is rewritten`);
  } else {
    const kinds = expect.startsWith('refused:') ? expect.slice('refused:'.length).split('|') : ['generic'];
    assert.ok(frontier && kinds.includes(frontier.kind), `${label}: the guess ${kinds.join(' or ')} is named: ${visible(frontier)}`);
  }
}
// How many of the pages the released lexer reads wrong: it rewrites the token that is data.
function misreadByBase(base, codes) {
  if (!base) return 0;
  return codes.filter((code) => base.resolvePageRefs(new Map([['page', { code }]]), new Map([['detail', ID]])).deployment.get('page').split(ID).length - 1 === 2).length;
}
// TypeScript's reading of such a page: it parses, and has one real call (the handler's).
function assertTypeScriptReads(ts, code, label) {
  const source = cleanSourceFile(ts, code);
  assert.ok(source, `${label}: TypeScript parses the page`);
  let calls = 0;
  (function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') calls += 1;
    ts.forEachChild(node, visit);
  })(source);
  assert.strictEqual(calls, 1, `${label}: one real call`);
}
// The method, accessor or signature named `word` that has type parameters, in a program that TypeScript parses with no diagnostic.
function methodNamed(ts, code, word) {
  const source = cleanSourceFile(ts, code);
  if (!source) return false;
  let found = false;
  (function visit(node) {
    if (node.name && node.typeParameters && node.name.text === word) found = true;
    ts.forEachChild(node, visit);
  })(source);
  return found;
}
const keywordsOf = (ts) => tokenVocabulary(ts).filter((token) => /^[a-z]+$/.test(token));
const punctuatorsOf = (ts) => tokenVocabulary(ts).filter((token) => !/^[a-z]+$/.test(token));

// ─── A string in the head whose quote is escaped ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A JSX attribute string has no escapes and ends at the next quote, so the tag reading of `<in U="\">">` ends at the `>` inside the string; the default of a type parameter is a JavaScript string, whose backslash escapes the quote, and
// the list ends at the last `>`. The text after each is another text, and an element read from the wrong end took the rest of the type for its own text. Only a quote that an odd number of backslashes precedes moves an end.
const MOVING_STRINGS = ['"\\">"', "'\\'>'", '"a\\">b"', '"\\\\\\">"'];
const STILL_STRINGS = ['">"', '"a"', '"\\\\"', '"\\x3e"', '"a\\nb"', '"\\u003e"'];
const STRING_HEADS = [['in', (s) => `<in U=${s}>`], ['public', (s) => `<public U extends X=${s}>`], ['const', (s) => `<const in U=${s}>`], ['static', (s) => `<static\nU=${s}>`], ['in', (s) => `<in out U=${s}>`]];

test('opensTypeParameters: a head with a string whose quote is escaped ends in one place for JSX and in another for TypeScript, and is a guess; a string with no such escape is read as it always was', () => {
  for (const [name, head] of STRING_HEADS) {
    for (const string of MOVING_STRINGS) for (const tail of ['(y): void }', '(y); a: string }', '(y) {}', '(y)\n  m: 1 }']) {
      const code = `${head(string)}${tail}`;
      assert.deepStrictEqual(opensTypeParameters(code, 0), GUESS, visible(code));
    }
    // Where the escapes move no end the two readings agree, and what follows the list decides: the `}` that ends a type fails the element, and a closing tag that nothing can hide ends it.
    for (const string of STILL_STRINGS) {
      assert.deepStrictEqual(opensTypeParameters(`${head(string)}(y): void }`, 0), TYPE, visible(string));
      assert.deepStrictEqual(opensTypeParameters(`${head(string)}(y) text</${name}>`, 0), ELEMENT, visible(string));
    }
  }
  // After an `=`, a `(`, a `[`, a `:` or an `=>` a function type may stand, and the same head with an escaped quote is as unreadable there.
  for (const string of MOVING_STRINGS) assert.deepStrictEqual(opensTypeParameters(`<in U=${string}>(y) => void`, 0, null, false, true), GUESS, visible(string));
  // A tag in the string is a `<` after an attribute, which no element has (TS1003): the tag reading fails there, and the head is a type whatever the string holds.
  assert.deepStrictEqual(opensTypeParameters('<in U="\\"</in>">(y): void }', 0), TYPE);
  assert.deepStrictEqual(opensTypeParameters('<in U="\\"</in>">(y) => void', 0, null, false, true), TYPE);
});

test('a method named like an operator, a signature or a function type whose type parameter has a string default with an escaped quote: the note after it is data, and the page is refused after a guess, not rewritten', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const members = [];
  for (const word of MEMBER_NAME_OPERATORS) members.push([`${word} with a constraint and an escaped default`, `${word}<T extends string="\\">">(): void;`, 'T', 'refused']);
  for (const word of MEMBER_NAME_OPERATORS) members.push([`${word} with an escaped single quote`, `${word}<T extends string='\\'>'>(y: T): void;`, 'T', 'refused']);
  members.push(['a variance modifier', '<in U="\\">">(y: U): void;', 'in', 'refused'], ['a modifier and a constraint', '<public U extends X="\\">">(y: U): void;', 'public', 'refused'], ['const and a modifier', '<const in U="\\">">(y: U): void;', 'const', 'refused'],
    ['a construct signature', 'new <out U="\\">">(y: U): void;', 'out', 'refused'], ['a function type', 'cb: <in U="\\">">(y: U) => void;', 'in', 'refused'],
    // A string whose escaped quote is followed by a tag: the tag reading fails at the `<` after the attribute, no element has the head, and it is a type for certain.
    ['a tag-like text in the string', '<in U="\\"</in>">(y: U): void;', 'in', 'exact']);
  const codes = [];
  for (const [name, member, closing, expect] of members) {
    const code = pageOf(`interface Api { ${member} }`, closing);
    codes.push(code);
    assertRead(code, expect, name);
    if (ts) assertTypeScriptReads(ts, code, name);
  }
  if (!ts) t.diagnostic(SKIP);
  if (base) assert.ok(misreadByBase(base, codes) >= 8, `the released lexer rewrites the note in only ${misreadByBase(base, codes)} of the ${members.length} pages`);
  // The same members with a string that moves no end are read for certain, where nothing in the type holds the closing tag.
  for (const string of STILL_STRINGS) {
    const code = `function openDetail() { ${CALL}; }\ninterface Api { delete<T extends string=${string}>(): void; <in U=${string}>(y: U): void; }\nconst note = '${CALL}';\nexport default function Page() { return null; }\n`;
    assertRead(code, 'exact', `a string that moves no end: ${string}`);
  }
});

// ─── A self-closing head after `extends` ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A constraint that starts no type is read by the parser as an expression, and a `/` there begins a regex: `<in U extends />;…/>(y): void` is a signature whose constraint is the regex `/>;…/`, where a tag that closes itself ends at
// the `>` after the `/`. The regex is the head's own text, so a call in it is data. A regex that its line does not close is unterminated (TS1161), no type has the text, and only the element compiles.
test('opensTypeParameters: a tag that closes itself right after `extends` may be a constraint that is a regex, and is a guess where the regex closes on its line; elsewhere it is an element', () => {
  for (const head of ['<in U extends />', '<public U extends  / >', '<const in U extends />', '<out U extends\n/>']) {
    assert.deepStrictEqual(opensTypeParameters(`${head};x;/>(y): void }`, 0), GUESS, visible(head));
    assert.deepStrictEqual(opensTypeParameters(head, 0), ELEMENT, `no regex closes: ${visible(head)}`);
  }
  for (const head of ['<in U/>', '<in U x />', '<in U extends X />', '<in U extendsX />']) assert.deepStrictEqual(opensTypeParameters(`${head};x;/>(y)`, 0), ELEMENT, visible(head));
});

test('a signature or a method whose constraint is a regex holds the text of a call as data: the page is refused after a guess, and an element that closes itself after `extends` is read for certain', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const members = [['a signature', `<in U extends />;${CALL};/>(y): void;`], ['a signature with a modifier run', `<const in U extends />;${CALL};/>(y): void;`], ['a method named delete', `delete<U extends />;${CALL};/>(y): void;`],
    ['a method named instanceof', `instanceof<U extends />;${CALL};/>(y): void;`], ['a construct signature', `new <out U extends />;${CALL};/>(y): void;`]];
  const codes = [];
  for (const [name, member] of members) {
    const code = `function openDetail() { ${CALL}; }\ninterface Api { ${member} }\nexport default function Page() { return null; }\n`;
    codes.push(code);
    const { rewritten, tokens, frontier } = readPage(code);
    assert.strictEqual(tokens.length, 2, name);
    assert.deepStrictEqual(rewritten.filter((at) => at !== tokens[0]), [], `${name}: the token in the regex is data and is rewritten`);
    assert.ok(frontier && frontier.kind === 'generic', `${name}: a guess is named`);
    if (ts) assert.ok(cleanSourceFile(ts, code), `${name}: TypeScript parses the page`);
  }
  if (!ts) t.diagnostic(SKIP);
  if (base) assert.strictEqual(misreadByBase(base, codes), members.length, 'the released lexer rewrites the data of every page');
  // An element whose tag closes itself after `extends` and whose line holds no second `/` is the element it looks like: only an element compiles.
  const element = `function openDetail() { ${CALL}; }\nconst e = <in U extends />;\nconst note = '</in>;${CALL};//';\nexport default function Page() { return null; }\n`;
  assertRead(element, 'exact', 'an element that closes itself');
  if (ts) assertTypeScriptReads(ts, element, 'an element that closes itself');
});

// ─── A line break before the word ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// `delete`, `typeof` and `void` begin a member where a member may begin: after a separator, a modifier, or the end of a member that a line break stands after. After a token that wants its operand — an `=`, an `=>`, a `:`, a `(`, a `[`,
// a prefix operator, a binary operator — a line break ends nothing: the word is an operator and its operand an element, the page that the released lexer resolves.
test('an element after `delete`, `typeof` or `void` is read for certain where a line break follows a token that wants its operand, on every kind of line break, as it is on one line', (t) => {
  const ts = loadTypescriptOracle();
  const places = [['an initializer', (s) => `const e =\n${s};`], ['a conditional alternative', (s) => `const e = true ? 0 :\n${s};`], ['an arrow body', (s) => `const e = () =>\n${s};`], ['an argument', (s) => `f(\n${s});`],
    ['an array', (s) => `const e = [\n${s}];`], ['a prefix `!`', (s) => `const e = !\n${s};`], ['a `+`', (s) => `const e = x +\n${s};`], ['a `&&`', (s) => `const e = x &&\n${s};`], ['a conditional', (s) => `const e = x ?\n${s} : y;`],
    ['a property value', (s) => `const e = {key:\n${s}};`], ['a comment with a line break', (s) => `const e = /*\n*/${s};`], ['a line comment', (s) => `const e = // c\n${s};`], ['U+2028', (s) => `const e =\u2028${s};`],
    ['a `*`', (s) => `const e = x *\n${s};`], ['a `??`', (s) => `const e = x ??\n${s};`], ['a `<`', (s) => `const e = x <\n${s};`], ['a prefix `~`', (s) => `const e = ~\n${s};`], ['a `**=`', (s) => `let e; e **=\n${s};`]];
  let valid = 0;
  for (const word of ['void', 'typeof', 'delete']) {
    for (const [place, wrap] of places) {
      for (const text of ['<span>(MARK); // note</span>', '<span>(MARK) text</span>', '<>(MARK); // note</>', '<public U>(MARK); // note</public>']) {
        const code = `${wrap(`${word} ${text}`)}\n${CALL};`;
        const label = `${place} / ${word} / ${text}`;
        assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
        assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
        if (ts && cleanSourceFile(ts, code)) valid += 1;
      }
    }
  }
  if (ts) assert.ok(valid >= 150, `${valid} of the pages are valid to TypeScript`);
  else t.diagnostic(SKIP);
  // The same word on the next line of a type or a class, after a token that may end a member, begins a method: its list is the type parameters of a signature, and the text after it is code.
  const members = ['a: string', 'a?: string', 'a()', 'a(): void', '[k: string]: T', 'a: A<B>', "a: 'x'", 'a: `t`', 'a', 'a?', 'a: string[]', 'a: { b: 1 }', 'a: (x: T) => void'];
  const classMembers = [...members, 'a = 1', 'a = x!', 'a = i++', 'a!', 'a = f()', 'a = "s"', 'a = {}', 'a() {}', 'a = /x/'];
  for (const word of MEMBER_NAME_OPERATORS) {
    for (const member of members) {
      for (const separator of ['\n', '\n  ', '\r\n', ' /* c */\n', '\u2028']) {
        const code = `interface I { ${member}${separator}${word}<U>(y: U): MARK }`;
        assert.ok(readsAsCode(code), `read as a member: ${visible(code)}`);
        assert.deepStrictEqual(guessesOf(code), [], `no guess: ${visible(code)}`);
      }
    }
    // `instanceof` goes on the expression before it (`a = x` and a line break, then `instanceof` is `x instanceof …`), so only a type ends a member before it.
    if (word !== 'instanceof') {
      for (const member of classMembers) {
        const code = `class C { ${member}\n${word}<U>(y: U): MARK { return y; } }`;
        assert.ok(readsAsCode(code), `read as a method: ${visible(code)}`);
      }
    }
  }
});

test('TypeScript: a line break before `delete` begins a member only after the tokens that end one, and the lexer reads a member after each of them and an element after every other that goes before an operand', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  // Every token that TypeScript's parser lets a member follow across a line break, with the prefixes that make it the last token of a member.
  const prefixes = ['a', 'a?', 'a!', 'a: A', 'a = 1', 'a()', 'a: A[', 'a: {', 'a: A<B', 'a: [', 'a(', 'a: (', 'a = (', 'a = [', 'a: A |', 'a =', 'a: ', 'readonly a', 'static a', 'a = x', 'get a() { return 1 }', '[k: string]: T'];
  const frames = [(member) => `interface I { ${member}\n delete<U>(y: U): MARK }`, (member) => `class C { ${member}\n delete<U>(y: U): MARK {} }`, (member) => `type L = { ${member}\n delete<U>(y: U): MARK };`];
  const tokens = [...tokenVocabulary(ts), "'x'", '"x"', '`x`', '1', '/x/', '/x/g', '0x1', '1n', '#p', '@dec', '@dec()', '@a.b', '@(x)', '@dec<T>()', 'x', '\u00e9'];
  const ends = new Set();
  const unsound = [];
  // JSDoc's types, `a: A?` and `a: A | *`, parse in TypeScript and its checker rejects them (TS8020): a `?` or `*` after a type is read as the operator it is in an expression.
  const JSDOC_TYPES = new Set(['a: A ?', '[k: string]: T ?', 'a: A | *', 'a:  *']);
  for (const token of tokens) {
    for (const prefix of prefixes) {
      for (const frame of frames) {
        const code = frame(`${prefix} ${token}`);
        if (!methodNamed(ts, code, 'delete')) continue;
        ends.add(token);
        if (!readsAsCode(code) && !JSDOC_TYPES.has(`${prefix} ${token}`)) unsound.push(visible(code));
      }
    }
  }
  assert.deepStrictEqual(unsound.slice(0, 5), [], 'a member that follows a token across a line break is read as the text of an element');
  // The tokens that end a member: a closing bracket, a separator, a postfix operator, a mark, a generator's `*`, and every name, keyword and literal.
  for (const token of ['}', ')', ']', ';', ',', '>', '*', '++', '--', '!', '?', 'x', 'delete', 'in', "'x'", '`x`', '1', '/x/']) assert.ok(ends.has(token), `TypeScript lets a member follow ${token} across a line break`);
  // The tokens that never do — an operator, an `=`, an `=>`, a `:`, an opening bracket, a `.` — put the line break in the middle of an expression: an element after `void` there is read as text, with no guess. Where the braces may hold members, which a
  // property of a class is (`class K { p = a /` and a line break, then `void <span>…`), a `/` that ends a regex literal ends the property's initializer, and the `>` of `>>` and `>>>` may close type arguments: the lexer cannot tell them from an operator, and guesses.
  // At the top level of the source no member stands, and it does not.
  const operandFrames = [['', ''], ['a ', ''], ['(', ')'], ['[', ']'], ['f(', ')'], ['{ k: ', ' }'], ['() ', ''], ['x ? a : ', ''], ['x ? ', ' : y'], ['a ', ' b'], ['f(a, ', ')']];
  const places = [['the top level', (e) => `const e = ${e};\n${CALL};`, []], ['a class property', (e) => `class K { p = ${e}; }\n${CALL};`, ['/', '>>', '>>>']]];
  let checked = 0;
  for (const [place, wrap, guessed] of places) {
    const imprecise = new Set();
    const meetsAMember = [];
    for (const token of punctuatorsOf(ts)) {
      if (ends.has(token)) continue;
      for (const [left, right] of operandFrames) {
        const code = `${wrap(`${left}${token}\nvoid <span>(MARK); // note</span>${right}`)}`;
        if (!cleanSourceFile(ts, code)) continue;
        checked += 1;
        if (guessesOf(code).length > 0) imprecise.add(token);
        // A `.` and a `?.` before `void` make it a property: `a.void<span>(MARK)` is a call, and the text in it is code.
        if (readsAsCode(code) && token !== '.' && token !== '?.') meetsAMember.push(token);
      }
    }
    assert.deepStrictEqual(meetsAMember, [], `${place}: an element after a token that wants its operand is read as the members of a type`);
    assert.deepStrictEqual([...imprecise].sort(), guessed, `${place}: a guess where no member can follow the token`);
  }
  assert.ok(checked >= 120, `only ${checked} expression pages were valid`);
});

// ─── Words before the name of a member ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MEMBER_FRAMES = [
  ['an interface', (k, w) => `interface I { ${k} ${w}<U>(y: U): MARK }`], ['a type literal', (k, w) => `type L = { ${k} ${w}<U>(y: U): MARK };`], ['a class', (k, w) => `class C { ${k} ${w}<U>(y: U): MARK { return y; } }`],
  ['a declared class', (k, w) => `declare class C { ${k} ${w}<U>(y: U): MARK }`], ['an abstract class', (k, w) => `abstract class C { ${k} ${w}<U>(y: U): MARK }`], ['an object literal', (k, w) => `const o = { ${k} ${w}<U>(y: U) { return MARK; } };`],
  ['a class expression', (k, w) => `const K = class { ${k} ${w}<U>(y: U) { return MARK; } };`],
];

test('TypeScript: the words before the name of a member are the words of MEMBER_PREFIX_WORDS, and a method named like an operator after any of them is a member, read as code', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const words = keywordsOf(ts);
  assert.ok(words.length > 80 && words.includes('readonly') && words.includes('get') && words.includes('accessor'), 'the vocabulary has the keywords');
  const accepted = new Set();
  const byFrame = new Map();
  for (const word of MEMBER_NAME_OPERATORS) {
    for (const [name, frame] of MEMBER_FRAMES) {
      for (const keyword of words) {
        if (!methodNamed(ts, frame(keyword, word), word)) continue;
        accepted.add(keyword);
        byFrame.set(name, (byFrame.get(name) || new Set()).add(keyword));
      }
    }
  }
  // The union of the seven places is the list: the lexer cannot tell which place a `<` is in. `const` is a modifier in a class only, and the others in every place that has members (`export` in all).
  assert.deepStrictEqual([...MEMBER_PREFIX_WORDS].sort(), [...accepted].sort(), 'the words that TypeScript takes before a member\'s name');
  assert.ok(byFrame.get('a class').has('const') && !byFrame.get('an interface').has('const'), '`const` is a modifier in a class only');
  assert.ok(['export', 'in', 'out', 'get', 'set'].every((word) => byFrame.get('an interface').has(word)), 'a variance modifier, `export` and the words of an accessor stand before a member of a type');
  // Each word before each operator in each place that takes it: the method is a member, its text is code, and nothing is guessed.
  let pages = 0;
  for (const word of MEMBER_NAME_OPERATORS) {
    for (const [name, frame] of MEMBER_FRAMES) {
      for (const keyword of byFrame.get(name)) {
        const code = frame(keyword, word);
        if (!methodNamed(ts, code, word)) continue;
        pages += 1;
        assert.ok(readsAsCode(code), `${name}: ${visible(code)} is read as a member`);
        assert.deepStrictEqual(guessesOf(code), [], `${name}: no guess: ${visible(code)}`);
      }
    }
  }
  assert.ok(pages >= 300, `${pages} pages`);
  // Two words, and a generator's `*` after them; a decorator, in every shape, before a class member (and in no other place: TypeScript rejects one before a member of a type or an object literal).
  for (const prefix of ['static async ', 'public static ', 'static async *', 'async *', '*', 'export get ', 'readonly in ', 'in out ']) {
    for (const word of MEMBER_NAME_OPERATORS) {
      const code = `class C { ${prefix}${word}<U>(y: U): MARK { return y; } }`;
      if (methodNamed(ts, code, word)) assert.ok(readsAsCode(code), visible(code));
    }
  }
  for (const decorator of ['@dec ', '@dec() ', '@a.b ', '@a.b() ', '@(x) ', '@dec<T>() ', '@dec(1, 2) ', '@dec(x => x) ', '@dec @dec2 ', '@dec static ', '@dec async *', '@dec get ', '@dec readonly ']) {
    for (const word of MEMBER_NAME_OPERATORS) {
      const code = `class C { ${decorator}${word}<U>(y: U): MARK { return y; } }`;
      assert.ok(methodNamed(ts, code, word), `TypeScript reads a method: ${visible(code)}`);
      assert.ok(readsAsCode(code), `read as a member after a decorator: ${visible(code)}`);
      const expression = `const o = { ${decorator}${word}<U>(y: U) { return MARK; } };`;
      assert.strictEqual(cleanSourceFile(ts, expression), null, `no decorator before a member of an object literal: ${visible(expression)}`);
    }
  }
});

test('TypeScript: a word that no member has before its name leaves `delete`, `typeof` and `void` an operator and the text after it an element, after every keyword that an expression has before an operand', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const frames = [(k, w) => `const e = ${k} ${w} <U>(y) MARK</U>;`, (k, w) => `${k} ${w} <U>(y) MARK</U>;`, (k, w) => `function f() { ${k} ${w} <U>(y) MARK</U>; }`, (k, w) => `const e = a ${k} ${w} <U>(y) MARK</U>;`, (k, w) => `if (a) ${k} ${w} <U>(y) MARK</U>;`];
  let checked = 0;
  for (const keyword of keywordsOf(ts)) {
    if (MEMBER_PREFIX_WORDS.has(keyword)) continue;
    for (const word of ['delete', 'typeof', 'void']) {
      for (const frame of frames) {
        const code = frame(keyword, word);
        if (!cleanSourceFile(ts, code)) continue;
        checked += 1;
        assert.ok(!readsAsCode(code), `${visible(code)}: the text of the element is text`);
        assert.deepStrictEqual(guessesOf(code), [], `${visible(code)}: no guess`);
      }
    }
  }
  assert.ok(checked >= 20, `${checked} programs were valid`);
  // `in` is a modifier before a member and an operator before an operand: where a name stands before it on its line it is the operator, and the element after the word is certain.
  for (const code of ['const e = "a" in delete <U>(y) MARK</U>;', 'const e = a in typeof <U>(y) MARK</U>;', 'if (a in void <U>(y) MARK</U>) {}']) {
    assert.ok(cleanSourceFile(ts, code), code);
    assert.ok(!readsAsCode(code), code);
    assert.deepStrictEqual(guessesOf(code), [], code);
  }
});

// ─── A modifier run that starts with `const` ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The rule for a `<` steps over a `const` and reads the next token for the name, and the parser takes `const` for one more modifier of the parameter: `<const in U>(y)` is a signature whose parameter has the modifiers `const` and `in`.
// An element may have a head whose words are all attributes; a `,`, a `=` and a value that is no string, or a `{` that is no spread are no attributes (TS1003, TS1145): the tag reading fails, and no element has the head.
const CONST_HEADS = [];
for (const modifier of TYPE_PARAMETER_MODIFIERS) CONST_HEADS.push(`<const ${modifier} U>`, `<${modifier} const U>`);
CONST_HEADS.push('<const const U>', '<const in out U>', '<const readonly in U>', '<const in U extends X>', '<const static\nU>', '<const public U="x">');
const CONST_LISTS = ['<const in U = X>', '<const in U, V>', '<in const U extends X = Y>', '<const in out U extends { a: T }>', '<const readonly U = string>'];

test('opensTypeParameters: `const` and another modifier before the name, in either order, are the type parameters of a signature; a `const` and a name are read as they always were', () => {
  for (const head of [...CONST_HEADS, ...CONST_LISTS]) {
    const closing = closingOf(head);
    const noElement = CONST_LISTS.includes(head);
    assert.deepStrictEqual(opensTypeParameters(`${head}(y): void }`, 0), TYPE, visible(head));
    // What follows the list tells an element from a signature where an element may have the head, and nothing does where none may.
    assert.deepStrictEqual(opensTypeParameters(`${head}(y) text</${closing}>`, 0), noElement ? TYPE : ELEMENT, visible(head));
    // Where no member begins, the head is an element unless an arrow follows its list (a function type); where an expression is known to start, the rule's answer is the only one.
    assert.deepStrictEqual(opensTypeParameters(`${head}(y) text</${closing}>`, 0, null, false, true), noElement ? TYPE : ELEMENT, visible(head));
    assert.deepStrictEqual(opensTypeParameters(`${head}(y) text</${closing}>`, 0, null, true), ELEMENT, visible(head));
    assert.deepStrictEqual(opensTypeParameters(`${head}(y: U) => void`, 0, null, false, true), TYPE, `a function type: ${visible(head)}`);
  }
  assert.deepStrictEqual(opensTypeParameters('<const in U>(y); // </const>', 0), GUESS, 'the closing tag may be in the comment');
  // A comment between the tokens is trivia to TypeScript and no tag the lexer reads: it may be either program.
  for (const code of ['<const /* c */ in U>(y): void }', '<const in /* c */ U>(y): void }', '<in /* c */ const U>(y): void }']) assert.deepStrictEqual(opensTypeParameters(code, 0), GUESS, visible(code));
  // The rule for an assignment expression keeps what it decided: a `const` and a name that `extends`, `,` or `=` follows is a generic arrow's, and a `const` and a word that is no modifier is an element.
  for (const code of ['<const T,>(x: T) => x', '<const T = string>(x: T) => x', '<const T extends X>(x: T) => x']) assert.deepStrictEqual(opensTypeParameters(code, 0), TYPE, visible(code));
  for (const code of ['<const T == y', '<const T extendsx y', '<const T ( y', '<const T x>(y) }']) assert.deepStrictEqual(opensTypeParameters(code, 0), ELEMENT, visible(code));
});

test('TypeScript: a `const` and another modifier before the name of a type parameter are two modifiers of one parameter, wherever a list stands', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const frames = [(h) => `interface I { ${h}(y: U): void }`, (h) => `interface I { m${h}(y: U): void }`, (h) => `type F = ${h}(y: U) => void;`, (h) => `class C { m${h}(y: U): void {} }`, (h) => `const o = { m${h}(y) { return y; } };`];
  let found = 0;
  for (const modifier of TYPE_PARAMETER_MODIFIERS) {
    for (const head of [`<const ${modifier} U>`, `<${modifier} const U>`]) {
      for (const frame of frames) {
        const source = cleanSourceFile(ts, frame(head));
        assert.ok(source, `a program: ${visible(frame(head))}`);
        let modifiers = null;
        (function visit(node) {
          if (ts.isTypeParameterDeclaration(node)) modifiers = (ts.getModifiers(node) || []).map((m) => ts.tokenToString(m.kind)).sort();
          ts.forEachChild(node, visit);
        })(source);
        assert.deepStrictEqual(modifiers, ['const', modifier].sort(), visible(frame(head)));
        found += 1;
      }
    }
  }
  assert.strictEqual(found, TYPE_PARAMETER_MODIFIERS.size * 2 * frames.length);
  // After a `const`, a name that no list can have is no list: `<const T == y` is no type parameter, and a parameter list never starts with it.
  assert.strictEqual(cleanSourceFile(ts, 'interface I { <const T == y>(y: U): void }'), null);
});

test('a signature, a method or a function type whose type parameter has `const` and another modifier is a type, and the note after it is data', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const codes = [];
  for (const head of ['<const in U>', '<const out U>', '<const in out U>', '<const public U>', '<in const U>', '<public const U>', '<const static\nU>', '<const const U>']) {
    for (const member of [`${head}(y: U): void;`, `new ${head}(y: U): void;`, `delete${head}(y: U): void;`, `m${head}(y: U): void;`, `callback: ${head}(y: U) => void;`]) {
      // The note holds the closing tag of the head's name and a call: an element has the same text up to it, which a lexer that reads the head for an element takes for JSX text, and the call for code.
      const code = pageOf(`interface Api { ${member} }`, closingOf(head));
      codes.push(code);
      assertRead(code, 'exact', visible(member));
      if (ts) assertTypeScriptReads(ts, code, member);
    }
  }
  if (!ts) t.diagnostic(SKIP);
  if (base) assert.ok(misreadByBase(base, codes) >= 20, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // A comment inside the head is trivia to TypeScript and no tag that the lexer reads: the head is either program, and the page is refused after it, with the note unrewritten.
  for (const head of ['<const /* c */ in U>', '<const in /* c */ U>', '<in /* c */ const U>']) {
    const code = pageOf(`interface Api { ${head}(y: U): void; }`, 'const');
    assertRead(code, 'refused', visible(head));
    if (ts) assertTypeScriptReads(ts, code, head);
  }
});

// ─── A line break between a modifier and the name ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A modifier of a type parameter takes the name after it only on its own line, and `static` is the one that takes it across a line break (nextTokenCanFollowModifier): `<in` and a line break, then `U>` is no list, and `<static` and a line break, then
// `U>` is one. Where a line break makes the word a name (or the head no list) the text is an element; where a comment or a character beyond ASCII is in the head the lexer reads none of it, and it is a guess.
test('TypeScript: only `static` takes the name of a type parameter after a line break, and the lexer reads a head as a list wherever TypeScript does', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const frames = [['a call signature', (h) => `interface I { ${h}(y: U): void }`, (h) => `${h}(y: U): void }`, false], ['a function type', (h) => `type F = ${h}(y: U) => void;`, (h) => `${h}(y: U) => void`, true]];
  const words = [...TYPE_PARAMETER_MODIFIERS, 'const', 'get', 'set', 'export', 'default', 'function', 'new', 'typeof', 'of', 'type'];
  const gaps = [['a space', ' '], ['a line break', '\n'], ['a carriage return and a line feed', '\r\n'], ['a line separator', '\u2028'], ['a comment with a line break', '/*\n*/']];
  let valid = 0;
  for (const word of words) {
    for (const [frame, program, text, noMember] of frames) {
      for (const [gap, space] of gaps) {
        const head = `<${word}${space}U>`;
        const label = `${visible(head)} in ${frame}`;
        const reads = Boolean(cleanSourceFile(ts, program(head)));
        const answer = opensTypeParameters(text(head), 0, null, false, noMember);
        if (reads) {
          valid += 1;
          assert.ok(answer.generic || answer.ambiguity !== null, `TypeScript parses ${label}, and an element is read for certain`);
        }
        if (!TYPE_PARAMETER_MODIFIERS.has(word) || word === 'const') continue;
        // Every modifier but `static` and `const` is a name when a line break follows it.
        assert.strictEqual(reads, word === 'static' || gap === 'a space', label);
        if (word !== 'static') assert.deepStrictEqual(answer, reads ? TYPE : ELEMENT, label);
        else if (gap === 'a space' || gap === 'a line break' || gap === 'a carriage return and a line feed') assert.deepStrictEqual(answer, TYPE, label);
        else assert.deepStrictEqual(answer, GUESS, `${label}: the head holds what the lexer does not read`);
      }
    }
  }
  // Each modifier and `const` with a space, in both frames, and `static` with the other four gaps.
  assert.strictEqual(valid, (TYPE_PARAMETER_MODIFIERS.size + 1) * frames.length + (gaps.length - 1) * frames.length, 'the heads that TypeScript parses');
  // The words that no type parameter takes before its name are no modifiers: the head is an element, whatever follows the word.
  for (const word of ['get', 'set', 'export', 'default', 'function', 'new', 'typeof', 'of', 'type']) {
    for (const [, space] of gaps) assert.strictEqual(cleanSourceFile(ts, `interface I { <${word}${space}U>(y: U): void }`), null, word);
  }
});

// ─── A function type ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Where no member of a type begins — after a `:`, an `=>`, a `(`, a `[`, an `=` — a type may: `onPick: <in U>(y: U) => void` is a function type, and the `=>` after its parameter list is what tells it from an element, whose text cannot hold a
// `>`. The list is read to its `)`, and an arrow after it makes the head a type where the element reading fails before the arrow, and a guess where it may not (the arrow is in an attribute string). With no arrow after the list the head is an
// element there, as it always was.
const NO_ELEMENT_HEADS = ['<in U, out V>', '<public U = string>', '<in U extends { a: T }>', '<in U extends (x: T) => T>'];
const FUNCTION_TYPE_HEADS = ['<in U>', '<out U>', '<in out U>', '<public U>', '<readonly U>', '<static U>', '<accessor U>', '<>', '<const in U>', '<in const U>', '<static\nU>', '<in U="x">', ...NO_ELEMENT_HEADS];
const FUNCTION_TYPE_PLACES = [
  ['a property of an interface', (t) => `interface I { callback: ${t}; }`], ['an optional property', (t) => `interface I { callback?: ${t}; }`], ['a property of a type literal', (t) => `type L = { callback: ${t} };`], ['a variable', (t) => `let v: ${t};`],
  ['a parameter', (t) => `function f(a: ${t}) {}`], ['a parameter of a method', (t) => `interface I { m(cb: ${t}): void }`], ['the return type of a function type', (t) => `type F = () => ${t};`], ['a tuple', (t) => `type T = [${t}];`],
  ['parentheses', (t) => `type T = (${t})[];`], ['a default of a type parameter', (t) => `type G<T = ${t}> = T;`], ['a property of a class', (t) => `class C { callback: ${t} = null as any; }`],
];

test('opensTypeParameters: where no member begins, a head whose list an arrow follows is a function type, and a head with no arrow is an element', () => {
  for (const head of FUNCTION_TYPE_HEADS) {
    for (const parameters of ['(y: U)', '(y)', '()', '(...a: U[])', '(y: U, z?: V)']) {
      assert.deepStrictEqual(opensTypeParameters(`${head}${parameters} => void; note: '</in>'`, 0, null, false, true), TYPE, `${visible(head)}${parameters}`);
      // Where an expression is known to start, a function type cannot stand.
      assert.deepStrictEqual(opensTypeParameters(`${head}${parameters} => void; note: '</in>'`, 0, null, true), ELEMENT, `in an expression: ${visible(head)}${parameters}`);
    }
    // With no arrow after the list the text is an element's, or a type's where no element has the head.
    for (const text of ['(y): void; note', '(y); note', '(y) text</in>', '(y) {}', '(y), x']) {
      assert.deepStrictEqual(opensTypeParameters(`${head}${text}`, 0, null, false, true), NO_ELEMENT_HEADS.includes(head) ? TYPE : ELEMENT, `${visible(head)}${visible(text)}`);
    }
  }
  // A list that the lexer's scan closes at a parenthesis in an attribute string of a nested element (a JSX string has no escapes, a JavaScript one has) shows an arrow that is not there: the head is the guess, read as a type.
  assert.deepStrictEqual(opensTypeParameters('<in U>(a = x + <Child x="\\" y=") =>" />)</in>', 0, null, false, true), TYPE_GUESS);
  // A list that holds a regex, an element or a template in a default is not read to its end: no arrow is seen, but none is ruled out either, and the head is the guess, read as an element, where it was a certain element before.
  // (Where an expression is known to start, the rule's answer is the element.)
  for (const code of ['<> ([*/</>)', '<in U>([*/</in>)', '<public U>(a = f(/)/)</public>', '<>(a,\n[/</>']) {
    assert.deepStrictEqual(opensTypeParameters(code, 0, null, false, true), GUESS, visible(code));
    assert.deepStrictEqual(opensTypeParameters(code, 0, null, true), ELEMENT, `in an expression: ${visible(code)}`);
  }
});

test('a function type with a head that starts like an element\'s is read as the type it is after a `:`, an `=>`, a `(`, a `[` and an `=`, and the note after it is data', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const codes = [];
  for (const head of FUNCTION_TYPE_HEADS) {
    for (const [place, wrap] of FUNCTION_TYPE_PLACES) {
      const types = wrap(`${head}(y: U) => void`);
      const code = pageOf(types, closingOf(head));
      const label = `${place} / ${visible(head)}`;
      codes.push(code);
      assertRead(code, 'exact', label);
      if (ts) {
        assertTypeScriptReads(ts, code, label);
        assert.strictEqual(readingAt(ts, cleanSourceFile(ts, code), code.indexOf(head)), 'FunctionType', `${label}: TypeScript reads a function type`);
      }
    }
  }
  if (!ts) t.diagnostic(SKIP);
  // Half of the heads are read for an element by the rule and by the released lexer alike (a name that is no reserved word is read as before), and the rest, which start with `in` or `>`, are not.
  if (base) assert.ok(misreadByBase(base, codes) >= 80, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // The list of a head after an `=` that holds an element with an arrow in an attribute string is no function type's that can be told: the page is TypeScript's element, and the lexer's guess, so it is refused after it and the note is data.
  const arrow = pageOf('const e = <in U>(a = x + <Child x="\\" y=") =>" />)</in>;', 'in');
  assertRead(arrow, 'refused', 'an arrow that an element holds in a string');
  if (ts) assertTypeScriptReads(ts, arrow, 'an element whose text holds an arrow');
});

// ─── A method with a body, named by a word or marked optional ───────────────────────────────────────────────────────────────────────────────────────────────

// `new <U>(y) { return y; }` in a class is a method named `new` that has type parameters and a body, as `m?<U>(y) {}` is an optional one: the `{` after the list begins the method's body, and no signature or element has it there.
test('opensTypeParameters: a `{` that follows the list of a head right after a word or a `?` is a method\'s body, and the head is a type where the text fails as an element', () => {
  const body = '(y) { return y; } }';
  assert.deepStrictEqual(opensTypeParameters(`<U>${body}`, 0, null, false, false, true), TYPE);
  assert.deepStrictEqual(opensTypeParameters('<U>(y) {}</U>', 0, null, false, false, true), ELEMENT);
  assert.deepStrictEqual(opensTypeParameters('<U>(y) {} // c </U>', 0, null, false, false, true), GUESS);
  assert.deepStrictEqual(opensTypeParameters('<U>(y) {count} text</U>', 0, null, false, false, true), ELEMENT, 'a container is text');
  // The body is code that no model of a type's members reads, and what follows it may be a comment, a string or a template that holds the closing tag: either program, and a guess. With none the closing tag ends an element.
  for (const text of ['(y) {} // c </U>', '(y) {} /* </U> */', '(y) {} x = \'</U>\';', '(y) {} x = `</U>`;', '(y) { } /* c */ // </U>']) assert.deepStrictEqual(opensTypeParameters(`<U>${text}`, 0, null, false, false, true), GUESS, visible(text));
  assert.deepStrictEqual(opensTypeParameters('<U>(y) {} text </U> // c', 0, null, false, false, true), ELEMENT);
  // A head that the rule reads for an element and a signature may have (`<in U>`), asked where a member begins, reads the text after its list the same way: a `{` is read, and no model of a type's members says that the comment is no type's.
  assert.deepStrictEqual(opensTypeParameters('<in U>(y) {} // c </in>', 0), GUESS);
  assert.deepStrictEqual(opensTypeParameters('<in U>(y) {} </in> // c', 0), ELEMENT);
  // The members are read from the end of the body, and no member of a class or an object literal begins with a `/` that starts no comment (TS1131): a regex there is no type's and cannot hold the closing tag. A name there leaves it open.
  for (const text of ['(y) {} // c\n  /b</U>', '(y) {} /* c */ /b</U>', '(y)\n{}\n/docs</U>', '(y) {} / x</U>']) assert.deepStrictEqual(opensTypeParameters(`<U>${text}`, 0, null, false, false, true), ELEMENT, visible(text));
  for (const text of ["(y) {} // c\n  b = '</U>'", '(y) {} x = /</U>/;', '(y) {}, x: /</U>/']) assert.deepStrictEqual(opensTypeParameters(`<U>${text}`, 0, null, false, false, true), GUESS, visible(text));
  // After any other token nothing is named, and the text is an element's, as it always was.
  assert.deepStrictEqual(opensTypeParameters(`<U>${body}`, 0), ELEMENT);
});

test('a method with a body that is named by a word or marked optional is a member of its class or object literal, and the note after it is data', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const names = ['new', 'return', 'throw', 'case', 'default', 'else', 'do', 'extends', 'break', 'continue', 'm?', 'delete?', 'typeof?', 'void?', 'instanceof?'];
  const codes = [];
  for (const name of names) {
    for (const [place, wrap] of [['a class', (m) => `class C { ${m} }`], ['an object literal', (m) => `const o = { ${m} };`], ['a class expression', (m) => `const K = class { ${m} };`]]) {
      if (place === 'an object literal' && /\?$/.test(name)) continue;
      const code = pageOf(wrap(`${name}<U>(y) { return y; }`), 'U');
      codes.push(code);
      const label = `${place} / ${name}`;
      assertRead(code, 'exact', label);
      if (ts) assertTypeScriptReads(ts, code, label);
    }
  }
  if (!ts) t.diagnostic(SKIP);
  if (base) assert.ok(misreadByBase(base, codes) >= 20, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // A method named `in` is the operator in an expression, and a guess whose name is the kind of the operator: the page is refused, and the note is data all the same.
  const named = pageOf('class C { in<U>(y) { return y; } }', 'U');
  const { rewritten, tokens, frontier } = readPage(named);
  assert.deepStrictEqual(rewritten.filter((at) => at !== tokens[0]), [], 'the note is data');
  assert.ok(frontier && frontier.kind === 'operator', `a guess is named: ${visible(frontier)}`);
});

test('a method with a body whose class holds a comment, a string or a template after it that has the closing tag and a call: the page is refused after a guess, and the call is data', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const open = `function openDetail() { ${CALL}; }\n`;
  const hiders = [['a line comment', `// note </U> ${CALL}\n`], ['a block comment', `/* </U> ${CALL} */`], ['a string', `x = '</U> ${CALL}';`], ['a template', `x = \`</U> ${CALL}\`;`]];
  const codes = [];
  for (const name of ['delete', 'typeof', 'void', 'instanceof', 'new', 'return', 'm?', 'delete?']) {
    for (const [hider, text] of hiders) {
      const code = `${open}class C { ${name}<U>(y) {} ${text} }\nexport default function Page() { return null; }\n`;
      codes.push(code);
      const label = `${name} and ${hider}`;
      assertRead(code, 'refused', label);
      if (ts) assertTypeScriptReads(ts, code, label);
    }
    // An object literal has no property that a string or a template makes: a comment only.
    if (!/\?$/.test(name)) {
      const code = `${open}const o = { ${name}<U>(y) {} /* </U> ${CALL} */ };\nexport default function Page() { return null; }\n`;
      codes.push(code);
      assertRead(code, 'refused', `${name} in an object literal`);
      if (ts) assertTypeScriptReads(ts, code, `${name} in an object literal`);
    }
  }
  if (!ts) t.diagnostic(SKIP);
  if (base) assert.ok(misreadByBase(base, codes) >= 20, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // With nothing that could hold the closing tag the text after the body is read as it is: the next member's `}` fails the element, and the type is certain.
  for (const name of ['delete', 'new', 'm?']) assertRead(pageOf(`class C { ${name}<U>(y) {} x = 1; }`, 'U'), 'exact', `${name} and no comment`);
});

// ─── A type parameter written with a Unicode escape ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// An identifier may be written with a Unicode escape, and the parser reads the word it spells: `delete<\u0054>(): void` is a method named `delete` that has the type parameter T. The name of an element's tag or attribute may hold none
// (TS17021, "Unicode escape sequence cannot appear here"), so the head is no element's — and the lexer, which reads no escape in a tag, must not take it for one: an element read for the method took the rest of the type for JSX text that
// runs on to a closing tag in a later string, and the call in it for code. The head is read as the list it may be, and is the guess `identifier`: the page is refused after it, and the call in the note is never rewritten.
// (The heads, places and gaps are those of helpers/type-head-pages.js, which the sweep of the same pages reads.)

test('a method named like an operator, a signature or a method whose type parameter is written with a Unicode escape: the page is refused after the guess `identifier`, and the note after it is data', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const codes = [];
  let valid = 0;
  const names = [...MEMBER_NAME_OPERATORS, 'm'];
  for (const [head, closing] of ESCAPED_HEADS) {
    for (const [place, wrap] of ESCAPE_PLACES) {
      for (const name of names) {
        for (const gap of ESCAPE_GAPS) {
          // An object literal has a property with no gap before the list: `delete\n<T>()` is two members there, which a comma would have to separate.
          if (place === 'an object literal' && gap !== '') continue;
          const code = pageOf(wrap(`${name}${gap}${head}(): void`), closing);
          const label = `${place} / ${name}${visible(gap)}${visible(head)}`;
          codes.push(code);
          // A name and a `<` on the next line are two members to the parser, and the position of the `<` is the guess `newline` (a `<` on a later line than the word before it, or after `void` and a line break), which may be reported before the head is read.
          assertRead(code, (name === 'm' || name === 'void') && /[\n]/.test(gap) ? 'refused:identifier|newline' : 'refused:identifier', label);
          if (ts && cleanSourceFile(ts, code)) {
            valid += 1;
            assertTypeScriptReads(ts, code, label);
          }
        }
      }
    }
  }
  if (!ts) t.diagnostic(SKIP);
  else assert.ok(valid >= 400, `${valid} of the ${codes.length} pages are valid to TypeScript`);
  // The released lexer and the one before this change took the head for an element and rewrote the note.
  if (base) assert.ok(misreadByBase(base, codes) >= 150, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // The guess is named at the `<` of the head, and it is the escape that is reported: `identifier`.
  const found = guessesOf('interface Api { delete<\\u0054>(): MARK }');
  assert.deepStrictEqual(found, [[found[0] && found[0][0], 'identifier']], 'one guess, at the head');
  assert.strictEqual('interface Api { delete<\\u0054>(): MARK }'[found[0][0]], '<');
});

test('a type parameter that is written with an escape costs the page the calls after it, and the same type with the name spelled out is read as it was: a call after it is rewritten where nothing in the type holds the closing tag', () => {
  const after = (head) => `interface Api { delete${head}(): void; }\nfunction openDetail() { ${CALL}; }\nexport default function Page() { return null; }\n`;
  for (const head of ['<T>', '<in U>', '<public U>', '<const U>']) {
    const plain = readPage(after(head));
    assert.strictEqual(plain.frontier, null, `${head}: no guess is named`);
    assert.strictEqual(plain.rewritten.length, 1, `${head}: the call after the type is rewritten`);
  }
  for (const head of [String.raw`<\u0054>`, String.raw`<in \u0054>`, String.raw`<public \u0054>`, String.raw`<const \u0054>`]) {
    const escaped = readPage(after(head));
    assert.ok(escaped.frontier && escaped.frontier.kind === 'identifier', `${head}: the guess is named: ${visible(escaped.frontier)}`);
    assert.deepStrictEqual(escaped.rewritten, [], `${head}: the call after the guess is not rewritten`);
  }
});

// ─── A parameter list that cannot be read to its end ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Where no member begins, a head that starts like an element's is a type if an arrow follows its parameter list, and the list is read to find it. A list that cannot be read — a template with a template or a comment in a substitution, a regex
// after a call in a default, a list longer than the window — shows no arrow, which says nothing about one: `callback: <in U>(value: `${`prefix`}`) => void` is a function type. It is the guess `generic`, as it is for a head that is no
// modifier's, and not the certain element that it was: read for an element's text it took the closing tag in a later string of the type for its own.
const ORDINARY_HEAD = /^<(?:U|const U)>$/;

test('opensTypeParameters: where no member begins, a head whose parameter list cannot be read to its end is the guess, with an arrow after it or none, and an element where an expression is known to start', () => {
  for (const head of UNREADABLE_HEADS) {
    for (const [what, list] of UNREADABLE_LISTS) {
      const label = `${visible(head)} and ${what}`;
      assert.deepStrictEqual(opensTypeParameters(`${head}${list} => void; note: '</in>'`, 0, null, false, true), GUESS, `an arrow after it: ${label}`);
      if (!ORDINARY_HEAD.test(head)) {
        // A head that no element has the text of is read where an arrow follows; a text with none is an element's that cannot be told from a function type's.
        assert.deepStrictEqual(opensTypeParameters(`${head}${list} text</in>`, 0, null, false, true), GUESS, `no arrow after it: ${label}`);
        assert.deepStrictEqual(opensTypeParameters(`${head}${list} => void; note: '</in>'`, 0, null, true), ELEMENT, `in an expression: ${label}`);
      }
    }
  }
  // A list that is read to its end is not the guess: with no arrow after it, it is the text of an element for certain, and with one, a type.
  for (const head of UNREADABLE_HEADS.filter((head) => !ORDINARY_HEAD.test(head))) {
    for (const list of ['(y: U)', '(value: `a${string}`)', '(x = 1)', '(x?: U, ...rest: V[])']) {
      assert.deepStrictEqual(opensTypeParameters(`${head}${list} text</in>`, 0, null, false, true), ELEMENT, `${visible(head)}${list}`);
      assert.deepStrictEqual(opensTypeParameters(`${head}${list} => void; note: '</in>'`, 0, null, false, true), TYPE, `${visible(head)}${list} =>`);
    }
  }
});

test('a function type whose parameter list cannot be read to its end: the note after it is data, and the page is refused after the guess, in every place a function type stands', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const codes = [];
  for (const head of UNREADABLE_HEADS) {
    for (const [place, wrap] of FUNCTION_TYPE_PLACES) {
      for (const [what, list] of UNREADABLE_LISTS) {
        const code = pageOf(wrap(`${head}${list} => void`), closingOf(head));
        const label = `${place} / ${visible(head)} / ${what}`;
        codes.push(code);
        assertRead(code, 'refused', label);
        if (ts) {
          assertTypeScriptReads(ts, code, label);
          assert.strictEqual(readingAt(ts, cleanSourceFile(ts, code), code.indexOf(head)), 'FunctionType', `${label}: TypeScript reads a function type`);
        }
      }
    }
  }
  if (!ts) t.diagnostic(SKIP);
  // The head of an element in the same places cannot be told apart either, and neither can one that is no element's: the page is refused, and the note is data. The released lexer reads the head of every modifier and fragment as an element.
  if (base) assert.ok(misreadByBase(base, codes) >= 5 * FUNCTION_TYPE_PLACES.length * UNREADABLE_LISTS.length, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // Readable lists are read exactly where the note comes after them.
  for (const head of ['<in U>', '<public U>', '<const in U>', '<>']) {
    for (const list of ['(value: `a${string}`)', '(x = 1)', '(x?: U)']) {
      for (const [place, wrap] of FUNCTION_TYPE_PLACES) assertRead(pageOf(wrap(`${head}${list} => void`), closingOf(head)), 'exact', `${place} / ${visible(head)}${list}`);
    }
  }
});

// ─── A word that takes an operand, before a line break ──────────────────────────────────────────────────────────────────────────────────────────────────────

// A token that wants an operand — an `=`, an `&&`, a `(` — leaves the expression to go on across a line break, and so does a word that wants one: `const e = void` and a line break, then `void <span>(x)</span>` is the `void` of an element, as it is
// on one line (`void void <span>…`), and the `//` in the element is JSX text. The word before the break ends a member where it is the name of one or a type: `a: void` and a line break, then `delete<U>(y: U): T`, is a type and a method.
const BREAK_ELEMENTS = ['<span>(MARK); // note</span>', '<span>(MARK) text</span>', '<span>(MARK)</span>', '<span>(x = f(/)/)) MARK</span>', '<>(MARK); // note</>', '<public U>(MARK); // note</public>'];
const LINE_BREAKS = NEWLINE_GAPS;
const OPERAND_PLACES = [['an initializer', (w) => `const e = ${w};`], ['an argument', (w) => `f(${w});`], ['an array element', (w) => `const a = [${w}];`], ['the right side of +', (w) => `const e = x + ${w};`], ['the right side of &&', (w) => `const e = x && ${w};`],
  ['the right side of <', (w) => `const e = x < ${w};`], ['an async function', (w) => `async function f() { const e = ${w}; }`], ['a property value', (w) => `const o = { k: ${w} };`], ['a class property', (w) => `class K { p = ${w}; }`],
  ['a class property that a decorator precedes', (w) => `class K { @dec p = ${w}; }`], ['a static class property', (w) => `class K { static p = ${w}; }`]];

test('an element after `void`, `typeof` or `delete` that follows a word taking an operand is read for certain, with every kind of line break between the words, as it is on one line', (t) => {
  const ts = loadTypescriptOracle();
  let valid = 0;
  for (const [place, wrap] of OPERAND_PLACES) {
    for (const first of ['void', 'typeof', 'delete', 'a in', 'a instanceof']) {
      for (const gap of LINE_BREAKS) {
        for (const word of ['void', 'typeof', 'delete']) {
          for (const text of BREAK_ELEMENTS) {
            // A property value is after a `:`, where a type may stand: `void` there may be the type, so the word before the line break is not read as an operator.
            if (place === 'a property value' && !/^(?:void|typeof|delete)$/.test(first)) continue;
            const code = `${wrap(`${first}${gap}${word} ${text}`)}\n${CALL};`;
            const label = `${place} / ${first} / ${visible(gap)} / ${word} / ${text}`;
            if (place === 'a property value') {
              // After a `:` the word may be a type, and a method may follow it: not decided, and never rewritten.
              if (!/\n|\u2028|\u2029/.test(gap)) assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess on one line`);
              continue;
            }
            assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
            assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
            if (ts && cleanSourceFile(ts, code)) valid += 1;
          }
        }
      }
    }
  }
  if (ts) assert.ok(valid >= 2000, `${valid} of the pages are valid to TypeScript`);
  else t.diagnostic(SKIP);
});

// The words that end a member before a line break: a type or a name after the tokens of OPERATOR_WORD_ENDS_MEMBER_AFTER, the name of a member, and the words that are names as well.
const WORD_ENDINGS = ['a: void', 'a: A | void', 'a: A & void', 'a: () => void', 'a: typeof void', 'a: keyof void', 'a: readonly void', 'a(x): x is void', 'a: A.void', 'a: A.delete', 'a: delete', 'a: in', 'a: instanceof', 'a: return', 'a?: void', 'a: [x: void]',
  'void', 'delete', 'typeof', 'instanceof', 'in', 'static void', 'readonly delete', 'public in', 'get void'];
const CLASS_WORD_ENDINGS = [...WORD_ENDINGS, 'a = x.void', 'a = x?.delete', 'a = x as void', 'a = x satisfies void', 'a = await', 'a = yield', 'a = of', 'const e = await', 'static e = await'];

test('a member that follows a word that ends a member is read as one: a type or a name after a line break, and the words that are names as well', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  let checked = 0;
  for (const word of MEMBER_NAME_OPERATORS) {
    for (const [place, endings, frame] of [['an interface', WORD_ENDINGS, (m) => `interface I { ${m}\n  ${word}<U>(y: U): MARK }`], ['a type literal', WORD_ENDINGS, (m) => `type L = { ${m}\n  ${word}<U>(y: U): MARK };`],
      ['a class', CLASS_WORD_ENDINGS, (m) => `class C { ${m}\n  ${word}<U>(y: U): MARK {} }`]]) {
      for (const ending of endings) {
        for (const separator of ['', ';', ',']) {
          const code = frame(`${ending}${separator}`);
          if (!methodNamed(ts, code, word)) continue;
          checked += 1;
          assert.ok(readsAsCode(code), `${place}: ${visible(code)} is read as a member`);
        }
      }
    }
  }
  assert.ok(checked >= 250, `${checked} programs were valid`);
});

test('TypeScript: a word that begins an expression ends a member before a line break only after the tokens of OPERATOR_WORD_ENDS_MEMBER_AFTER, a separator, a modifier or a decorator, and the words that are names as well always — derived from the parser, and read as a member after each', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  // The words of EXPR_START_WORDS (an operator before an operand), a sample of the reserved ones and the three that are names as well.
  const words = ['void', 'typeof', 'delete', 'in', 'instanceof', 'new', 'return', 'default', 'await', 'yield', 'of'];
  const lefts = ['', 'a', 'a: A', 'a: ()', 'a = x', 'a = f(', 'a = [', 'a = (', 'x.', 'a: A.', 'a = x as', 'a: keyof', 'a: A |', 'a: A &', 'a = x ?', 'a = !', 'a = x +', '@d', '@d()', 'static', 'a: typeof', 'a: unique', 'a(x): x', 'a: readonly', 'a: A extends B ? C :', 'a: { [K in', 'a = x satisfies', 'a = -', 'a: [x:'];
  const frames = [(s) => `interface I { ${s}\n delete<U>(y: U): MARK }`, (s) => `class C { ${s}\n delete<U>(y: U): MARK {} }`];
  const tokens = [...tokenVocabulary(ts), 'x', "'x'", '1', '`t`'];
  const after = new Map(words.map((word) => [word, new Set()]));
  const unsound = [];
  // TypeScript's parser stops with an assertion on a few programs that this makes of the keyword `using`: such a program is no page.
  const methodAfter = (code) => {
    try {
      return methodNamed(ts, code, 'delete');
    } catch (error) {
      return false;
    }
  };
  for (const word of words) {
    for (const token of tokens) {
      for (const left of lefts) {
        for (const frame of frames) {
          const code = frame(`${left} ${token} ${word}`);
          if (!methodAfter(code)) continue;
          after.get(word).add(token === '?.' ? '.' : token);
          if (!readsAsCode(code)) unsound.push(visible(code));
        }
      }
    }
  }
  assert.deepStrictEqual(unsound.slice(0, 5), [], 'a member after a line break that follows a word is read as the text of an element');
  // The words that are names as well are those a class field may be initialised with: `a = await`, `a = yield`, `a = of`.
  const names = words.filter((word) => methodNamed(ts, `class C { a = ${word}\n delete<U>(y: U): MARK {} }`, 'delete'));
  assert.deepStrictEqual([...OPERATOR_WORDS_THAT_ARE_NAMES].sort(), names.sort(), 'the operator words that may end a field');
  // After every other token that the words before a member may follow, the lexer knows the member by another rule: a separator, a modifier (`MEMBER_PREFIX_WORDS`), the end of a decorator (here a tagged template: `@d `t` void`).
  const union = new Set();
  for (const word of words) if (!OPERATOR_WORDS_THAT_ARE_NAMES.has(word)) for (const token of after.get(word)) union.add(token);
  const known = new Set([...OPERATOR_WORD_ENDS_MEMBER_AFTER, ';', ',', '`t`', ...MEMBER_PREFIX_WORDS]);
  assert.deepStrictEqual([...union].filter((token) => !known.has(token)).sort(), [], 'a token after which TypeScript lets a member follow a word, and the lexer does not know');
  assert.deepStrictEqual([...OPERATOR_WORD_ENDS_MEMBER_AFTER].filter((token) => !union.has(token)).sort(), [], 'a token of OPERATOR_WORD_ENDS_MEMBER_AFTER that no program has before a word');
});

test('`await`, `yield` and `of` before a line break may end a member, and a page that holds an element after them is read exactly where the braces hold statements and refused where they may hold members: the class field is a name', (t) => {
  const ts = loadTypescriptOracle();
  // A field that is initialised with the identifier `await` and a method that starts on the next line: TypeScript reads both, in a class and in an async function.
  for (const word of OPERATOR_WORDS_THAT_ARE_NAMES) {
    for (const code of [`class C { const e = ${word}\n delete<U>(y: U): MARK {} }`, `class C { e = ${word}\n void<U>(y: U): MARK {} }`, `async function f() { class C { e = ${word}\n typeof<U>(y: U): MARK {} } }`]) {
      if (ts) assert.ok(methodNamed(ts, code, /delete|void|typeof/.exec(code)[0]), `TypeScript reads a method: ${visible(code)}`);
      assert.ok(readsAsCode(code), `read as a member: ${visible(code)}`);
    }
  }
  if (!ts) t.diagnostic(SKIP);
  // An element after `await` and a line break is the operand of an operator in the braces of a function, where no member stands: it is read for certain, and so is the one after every word that is only an operator.
  const element = '<span>(MARK); // note</span>';
  const real = `function openDetail() { ${CALL}; }\n`;
  for (const word of ['await', 'yield', 'of', 'void', 'typeof', 'delete']) {
    const code = `async function f() { const e = ${word}\nvoid ${element}; }\n${real}`;
    const { rewritten, frontier } = readPage(code);
    assert.deepStrictEqual([frontier, rewritten.length], [null, 1], `${word}: the call after the element is rewritten`);
    if (ts) assert.ok(cleanSourceFile(ts, code), `${word}: TypeScript parses the page`);
  }
  // Where the braces may be a class's, an object literal's or a type's — the block of an arrow function and its value in an object literal — the line break may end a field or a member that `await` is the name of: a guess. The words that are
  // only operators are read, except after an `=>`, where a type may end in `void` (`a: () => void`).
  for (const [place, wrap] of [['the block of an async arrow', (s) => `const f = async () => { const e = ${s}; };`], ['the value of an async arrow in an object', (s) => `const o = { f: async () => ${s} };`]]) {
    const code = wrap(`await\nvoid ${element}`) + `\n${real}`;
    const { rewritten, frontier } = readPage(code);
    assert.ok(frontier && frontier.kind === 'generic', `${place}: a guess is named: ${visible(frontier)}`);
    assert.deepStrictEqual(rewritten, [], `${place}: the call after the guess is not rewritten`);
    if (ts) assert.ok(cleanSourceFile(ts, code), `${place}: TypeScript parses the page`);
  }
  for (const word of ['void', 'typeof', 'delete']) {
    const code = `const f = async () => { const e = ${word}\nvoid ${element}; };\n${real}`;
    assert.deepStrictEqual(readPage(code).frontier, null, `${word}: read for certain in the block of an arrow`);
  }
});

// ─── A decorator, and an expression after it ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A class member may be preceded by decorators, and `@dec delete<U>(y: U): T {}` is a decorated method named `delete`: where a member may begin is where a decorator ends. An `@` earlier on the statement says nothing about the token before the word:
// in `@dec(void <span>…</span>)` it is the `(` of the decorator's arguments, in `@dec x = void <span>…` an initializer's `=`, and in a decorated method's body whatever that body holds. (The places are those of helpers/type-head-pages.js.)

test('an element after `void`, `typeof` or `delete` is read for certain wherever a decorator stands earlier on its statement: in its arguments, a field initializer and a method body', (t) => {
  const ts = loadTypescriptOracle();
  let valid = 0;
  for (const [place, wrap] of DECORATED_PLACES) {
    // After `return` and a line break in the block of an arrow function the statement may have ended: that place is read below.
    if (place === 'the value of a return in an arrow') continue;
    for (const gap of LINE_BREAKS) {
      for (const word of ['void', 'typeof', 'delete']) {
        for (const text of BREAK_ELEMENTS) {
          const code = `${wrap(`${gap}${word} ${text}`)}\n${CALL};`;
          const label = `${place} / ${visible(gap)} / ${word} / ${text}`;
          assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
          assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
          if (ts && cleanSourceFile(ts, code)) valid += 1;
        }
      }
    }
  }
  if (ts) assert.ok(valid >= 1500, `${valid} of the pages are valid to TypeScript`);
  else t.diagnostic(SKIP);
  // `return` and a line break in the block of an arrow function: the braces may be a type's, the statement may have ended there, and a member named `return` may stand in it: not decided, as it was not before a decorator. In the body of a method, a
  // block, the statement that the line break ends is certain.
  for (const gap of LINE_BREAKS.filter((gap) => /\n|\u2028|\u2029/.test(gap))) {
    const arrow = `class C { @decorate method = () => { return${gap}void ${BREAK_ELEMENTS[0]}; } }\n${CALL};`;
    const method = `class C { @decorate method() { return${gap}void ${BREAK_ELEMENTS[0]}; } }\n${CALL};`;
    assert.ok(guessesOf(arrow).length > 0, `a guess is named after a return in an arrow and ${visible(gap)}`);
    assert.deepStrictEqual(guessesOf(method), [], `no guess after a return in a method and ${visible(gap)}`);
    if (ts) for (const code of [arrow, method]) assert.ok(cleanSourceFile(ts, code), `TypeScript parses the page: ${visible(code)}`);
  }
  assert.deepStrictEqual(guessesOf(`class C { @decorate method = () => { return void ${BREAK_ELEMENTS[0]}; } }\n${CALL};`), [], 'no guess on one line');
});

const DECORATORS = ['@dec', '@a.b', '@a?.b', '@a!', '@a!.b', '@dec()', '@dec()!', '@(x)', '@dec<T>()', '@dec<A, B>()', '@dec<(x: A) => B>()', '@tag`x`', '@dec()`x`', '@1', "@'x'", '@new X()', '@new X', '@#a', '@a.#b', '@this', '@this.x', '@super.x', '@import("x")', '@a\n.b',
  // An instantiation expression is a decorator's end too, and so is a number's decimal point (`1.`).
  '@dec<T>', '@dec<A, B>', '@dec<(x: A) => B>', '@a.b<T>', '@(x)<T>', '@dec<Array<string>>', '@dec<{ a: 1 }>', '@dec<"s">', '@dec<T>()<U>', '@dec<T> /* c */', '@1.', '@1_0.',
  '@function(){}', '@class {}', '@async', '@static', '@a.static', '@readonly', '@get', '@\\u0064ec', '@dec(\n1,\n2\n)', '@dec(() => { return 1; })', '@dec({ a: 1, b: [1, 2] })', '@dec("a;b", \'c,d\')', '@dec(`x${y}`)', '@dec(/x/)', '@dec() @dec2()', '@dec @dec2', '@dec static', '@dec static async', '@dec async *',
  '@dec readonly', '@dec get', '@dec public', '@dec override', '@dec accessor', '@dec declare', '@dec abstract', '@dec in', '@dec out', '@dec export', '@dec const', '@dec(a => a)', '@dec(a ? b : c)', '@dec(a, b)', '@dec(a = 1)', '@dec(typeof x)', '@dec(void 0)'];
const DECORATED_FRAMES = [
  (d, w) => `class C { ${d} ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { m() {} ${d} ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { x = 1; ${d} ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { x = 1\n ${d} ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { ${d}\n ${w}<U>(y: U): MARK {} }`,
  (d, w) => `abstract class C { ${d} abstract ${w}<U>(y: U): MARK; }`, (d, w) => `const K = class { ${d} ${w}<U>(y: U): MARK {} };`, (d, w) => `declare class C { ${d} ${w}<U>(y: U): MARK; }`,
  // The name after a generator's `*`, after a field named `in` or `instanceof` that a line break ends, and after a decorator that ends in the `>` of type arguments or in a decimal point (each only where the parser reads them so).
  (d, w) => `class C { ${d} *${w}<U>(y: U): MARK { yield y; } }`, (d, w) => `class C { ${d}\n *${w}<U>(y: U): MARK { yield y; } }`, (d, w) => `class C { ${d} in\n ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { ${d} instanceof\n ${w}<U>(y: U): MARK {} }`,
];

test('TypeScript: a decorated method named like an operator is read as a member after every shape of decorator, and an expression that holds an `@` earlier on its statement is not', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  let checked = 0;
  for (const decorator of DECORATORS) {
    for (const word of MEMBER_NAME_OPERATORS) {
      for (const frame of DECORATED_FRAMES) {
        const code = frame(decorator, word);
        if (!methodNamed(ts, code, word)) continue;
        checked += 1;
        assert.ok(readsAsCode(code), `read as a member: ${visible(code)}`);
      }
    }
  }
  assert.ok(checked >= 1500, `${checked} programs were valid`);
  const element = BREAK_ELEMENTS[0];
  for (const code of [`class C { @dec(a, void ${element}) m() {} }`, `class C { @dec(a ? 1 : void ${element}) m() {} }`, `class C { @dec x = (void ${element}); }`, `class C { @dec x = a in void ${element}; }`, `class C { @dec x = [void ${element}]; }`,
    `class C { @dec x = f(typeof void ${element}); }`, `@dec class C { m() { const e = void ${element}; } }`, `class C { @dec m(a = void ${element}) {} }`, `class C { @dec(x) y = z in void ${element}; }`, `class C { @dec static x = void ${element}; }`]) {
    assert.ok(cleanSourceFile(ts, code), `TypeScript parses ${visible(code)}`);
    assert.ok(!readsAsCode(code), `the element is text: ${visible(code)}`);
    assert.deepStrictEqual(guessesOf(code), [], `no guess: ${visible(code)}`);
  }
});

// ─── Where no member stands ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The braces of a function, a method and a statement hold statements, never members: the word before an element is an operator there, whatever stands before it and after a line break too (`const e = await` and a line break, then
// `void <span>…</span>`). The braces of a class, an object literal and a type may hold members, and braces that the lexer does not know for a block are taken for them (membersMayStandAt, blockBraceAt).
const STATEMENT_BRACES = [
  ['a function', (s) => `async function f() { ${s} }`], ['a function expression', (s) => `const f = async function () { ${s} };`], ['a named function expression', (s) => `const f = async function g(a) { ${s} };`], ['a method of a class', (s) => `class C { async m(a) { ${s} } }`],
  ['a method of a class that extends a call', (s) => `class C extends mixin(A) { async m() { ${s} } }`], ['a getter', (s) => `class C { get x() { ${s} } }`], ['a constructor', (s) => `class C { constructor(a) { ${s} } }`], ['a method of an object literal', (s) => `const o = { async m() { ${s} } };`],
  ['a static method', (s) => `class C { static async m() { ${s} } }`], ['a generator', (s) => `function* g() { ${s} }`], ['an if block', (s) => `async function f() { if (a) { ${s} } }`], ['an else block', (s) => `async function f() { if (a) { b; } else { ${s} } }`],
  ['a for block', (s) => `async function f() { for (let i = 0; i < n; i += 1) { ${s} } }`], ['a for-await block', (s) => `async function f() { for await (const x of y) { ${s} } }`], ['a while block', (s) => `async function f() { while (a) { ${s} } }`],
  ['a do block', (s) => `async function f() { do { ${s} } while (a); }`], ['a switch', (s) => `async function f() { switch (a) { case 1: ${s} } }`], ['a try block', (s) => `async function f() { try { ${s} } catch { g(); } }`],
  ['a catch block', (s) => `async function f() { try { g(); } catch (e) { ${s} } }`], ['a finally block', (s) => `async function f() { try { g(); } finally { ${s} } }`], ['a block after a statement', (s) => `async function f() { a; { ${s} } }`], ['the top level', (s) => s],
];

test('an element after a word that takes an operand and a line break is read for certain in the braces of a function, a method and a block, and the top level, wherever they stand', (t) => {
  const ts = loadTypescriptOracle();
  let valid = 0;
  for (const [place, wrap] of STATEMENT_BRACES) {
    for (const prefix of ['void', 'typeof', 'delete', 'await', 'a in', 'a instanceof']) {
      for (const gap of ['\n', '/*\n*/', '\r\n']) {
        const code = `${wrap(`const e = ${prefix}${gap}void ${BREAK_ELEMENTS[0]};`)}\n${CALL};`;
        const label = `${place} / ${prefix} / ${visible(gap)}`;
        assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
        assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
        if (ts && cleanSourceFile(ts, code)) valid += 1;
      }
    }
  }
  if (ts) assert.ok(valid >= 300, `${valid} of the pages are valid to TypeScript`);
  else t.diagnostic(SKIP);
  t.diagnostic(`${valid} pages valid to TypeScript`);
  // The same words are a guess where the braces may be a class's, an object literal's or a type's: the block of an arrow function, which a function type's object type cannot be told from, and what the lexer does not read.
  for (const [place, wrap] of [['the block of an arrow', (s) => `const f = async () => { ${s} };`], ['the value of an arrow in an object', (s) => `const o = { f: async () => ${s.replace(/^const e = /, '').replace(/;$/, '')} };`],
    ['braces after a colon', (s) => `async function f() { l: { ${s} } }`], ['braces after a closing brace', (s) => `async function f() { if (a) { b; } { ${s} } }`], ['a template substitution', (s) => `const t = \`\${(() => { ${s} })()}\`;`]]) {
    const code = `${wrap(`const e = await\nvoid ${BREAK_ELEMENTS[0]};`)}\n${CALL};`;
    assert.ok(guessesOf(code).length > 0, `${place}: a guess is named`);
    const { rewritten, frontier } = readPage(code);
    assert.ok(frontier && frontier.kind === 'generic', `${place}: the guess is generic: ${visible(frontier)}`);
    assert.deepStrictEqual(rewritten, [], `${place}: the call after the guess is not rewritten`);
  }
});

test('TypeScript: a method named like an operator is a member in the braces of a class after every heritage — a call, a parenthesis, `new`, a function or a class, a name that a keyword of a block spells or an escape cuts — and in an object literal that follows a `;` of a `for` head, and the lexer reads it as code', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  let checked = 0;
  for (const heritage of CLASS_HERITAGES) {
    for (const word of ['delete', 'void']) {
      for (const [separator, before] of [[' ', ''], [' ', 'a = await\n'], ['', '']]) {
        const code = `${heritage}${separator}{ ${before}${word}<U>(y: U): MARK {} }`;
        if (!methodNamed(ts, code, word)) continue;
        checked += 1;
        assert.ok(readsAsCode(code), `read as a method: ${visible(code)}`);
      }
    }
  }
  assert.ok(checked >= 250, `${checked} programs were valid`);
  // A `;` of a `for` head and an `=>` before braces that are not a block: the braces of an object literal and a type literal, whose methods and signatures are members.
  const bodies = [(m) => `for (let i = 0;; { ${m} }) {}`, (m) => `for (let i = 0; i < 1; { ${m} }) {}`, (m) => `for (;;) { for (;; { ${m} }) {} }`, (m) => `const e = <div style={{ ${m} }} />;`, (m) => `class K { static p = { ${m} }; }`,
    (m) => `const s = \`\${{ ${m} }}\`;`, (m) => `function k(a = { ${m} }) {}`];
  const signatures = [(m) => `type F = () => { ${m} };`, (m) => `let f: (a) => { ${m} };`, (m) => `type G = new () => { ${m} };`, (m) => `function g(): { ${m} } { return null as any; }`, (m) => `let x: { ${m} };`];
  for (const word of MEMBER_NAME_OPERATORS) {
    for (const [wraps, tail] of [[bodies, '{}'], [signatures, ';']]) {
      for (const wrap of wraps) {
        const code = wrap(`${word}<U>(y: U): MARK ${tail}`);
        if (!methodNamed(ts, code, word)) continue;
        checked += 1;
        assert.ok(readsAsCode(code), `read as a method: ${visible(code)}`);
      }
    }
  }
  assert.ok(checked >= 300, `${checked} programs were valid`);
  t.diagnostic(`${checked} programs valid to TypeScript`);
});

// ─── A heritage that ends in a call after `implements` or a comma ─────────────────────────────────────────────────────────────────────────────────────────

// A heritage clause is a list, and the parser reads each element as a left-hand-side expression (parseExpressionWithTypeArguments), so `class C implements B() {`, `class C extends A, B() {` and `interface I extends A, B() {` parse; only the checker objects
// (TS2500, TS1174, TS2499). The braces after such a `)` hold members, as they do after `extends mixin(A)`: a call that follows `implements` or a comma is no function's head. A lexer that took it for one read the method after it for an element, whose text ran on
// to the closing tag in the note, and rewrote the call there — and with the type parameter written with an escape the guard that refuses such a name was bypassed too. A call that follows a comma in an object literal is a method's head all the same, whose braces
// hold statements: the comma has to be read back to the keyword that begins its list, or to what no list holds.
const CALL_HERITAGES = [
  ['a class that implements a call', 'class C implements B()', 'class'], ['a class that implements a parenthesis', 'class C implements (B)', 'class'], ['a class that implements two names and calls the second', 'class C implements A, B()', 'class'],
  ['a class that extends two names and calls the second', 'class C extends A, B()', 'class'], ['a class with a base that implements a call', 'class C extends A implements B()', 'class'], ['a call with a path', 'class C implements A, ns.B()', 'class'],
  ['a call after another call', 'class C implements A(x, y), B()', 'class'], ['type arguments before the comma', 'class C implements A<T>, B()', 'class'], ['a comment and a line break after the comma', 'class C implements A, /* c */\n  B()', 'class'],
  ['three elements', 'class C implements A, B(), D()', 'class'], ['a call named `$`', 'class C implements A, $()', 'class'], ['an abstract class', 'abstract class C implements A, B()', 'class'],
  ['an interface that extends two names and calls the second', 'interface I extends A, B()', 'interface'], ['an interface that extends a call', 'interface I extends B()', 'interface'], ['an interface with three elements', 'interface I extends A, B(), C()', 'interface'],
  ['an interface that implements a call', 'interface I implements B()', 'interface'], ['an interface with a path', 'interface I extends A, ns.B()', 'interface'], ['an interface with type arguments before the comma', 'interface I extends A<T>, B()', 'interface'],
  ['an interface with a comment after the comma', 'interface I extends A, /* c */ B()', 'interface'],
];
const CALL_HERITAGE_HEADS = ['<T>', '<in T>', '<>', '<T extends string>'];

test('TypeScript: a method named like an operator is a member in the braces of a class or an interface after a heritage that ends in a call after `implements` or a comma, and the note after it is data', (t) => {
  const ts = loadTypescriptOracle();
  const base = loadBaseLexer();
  const codes = [];
  let valid = 0;
  for (const [what, heritage, kind] of CALL_HERITAGES) {
    for (const word of MEMBER_NAME_OPERATORS) {
      for (const head of CALL_HERITAGE_HEADS) {
        const member = kind === 'class' ? `${word}${head}(x: MARK): void {}` : `${word}${head}(x: MARK): void;`;
        const code = pageOf(`${heritage} { ${member} }`, closingOf(head));
        const label = `${what} / ${word}${visible(head)}`;
        if (ts && !cleanSourceFile(ts, code)) continue;
        codes.push(code);
        assertRead(code, 'exact', label);
        assert.ok(readsAsCode(code), `${label}: the method is code`);
        if (ts) {
          assertTypeScriptReads(ts, code, label);
          assert.ok(methodNamed(ts, code, word), `${label}: TypeScript reads a method`);
          valid += 1;
        }
      }
    }
  }
  if (!ts) t.diagnostic(SKIP);
  else assert.ok(valid >= 19 * 4 * 3, `${valid} pages are valid to TypeScript`);
  // The released lexer reads the head after `delete`, `typeof`, `void` and `instanceof` for an element in every place, and rewrites the note.
  if (base) assert.ok(misreadByBase(base, codes) >= codes.length / 2, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // A type parameter written with an escape is the parser's, and no element has the name: the page is refused after the guess `identifier` and the note is never rewritten — after these heritages too.
  const escaped = [];
  for (const [what, heritage, kind] of CALL_HERITAGES) {
    for (const word of MEMBER_NAME_OPERATORS) {
      for (const head of [String.raw`<\u0054>`, String.raw`<in \u0054>`]) {
        const member = kind === 'class' ? `${word}${head}(x: MARK): void {}` : `${word}${head}(x: MARK): void;`;
        const code = pageOf(`${heritage} { ${member} }`, closingOf(head));
        if (ts && !cleanSourceFile(ts, code)) continue;
        escaped.push(code);
        assertRead(code, 'refused:identifier', `${what} / ${word}${visible(head)}`);
      }
    }
  }
  if (ts) assert.ok(escaped.length >= 19 * 4 * 2, `${escaped.length} pages with an escape are valid to TypeScript`);
  if (base) assert.ok(misreadByBase(base, escaped) >= escaped.length / 2, `the released lexer misreads only ${misreadByBase(base, escaped)} of the ${escaped.length} pages with an escape`);
  // A single call after `extends` was read as members before, and a call after a comma is read the same way now.
  const note = (heritage) => pageOf(`${heritage} { delete<T>(x: MARK): void; }`, 'T');
  assertRead(note('interface I extends A, B()'), 'exact', 'a call after a comma');
  assertRead(note('interface I extends B()'), 'exact', 'a call after `extends`');
});

// What may stand before the comma in a heritage list: any left-hand-side expression, with type arguments, whatever its brackets, quotes and operators hold. The list is read back from the comma to the keyword that begins it, and a method after the call that ends it is a member
// wherever the keyword is (`class C implements A, B() {`, `class C extends A, B() {`, `interface I extends A, B() {`).
const LIST_ELEMENTS = ['A', 'A.B', 'A<T>', 'A<T, U>', 'A<(x: T) => U>', 'A<{ a: 1, b: 2 }>', 'A<B<C>>', 'A<X extends Y ? 1 : 2>', 'a?.b', 'a?.b()', 'a[0]', 'a[b, c]', 'x!', 'this', '"x"', "'x, y'", '`x, y`', 'tag`x`', 'class {}', 'class D extends E {}', 'function () {}', 'function* () {}',
  'class Named<T> extends Base<T> implements I {}', 'class implements A, B() {}', 'class extends mixin(A) {}', 'class { m() {} }', 'class extends class {} {}', '@dec class {}', 'new @dec class {}', 'new @dec(1) class {}', 'new @a.b @c class {}', 'class extends (B) {}', 'class Named {}', 'class<T> {}', 'class implements {}', 'class extends Base<{ a: 1 }> {}',
  // A template's substitution holds braces that are no class's.
  '`x${A}y`', 'tag`${A}`', '`${class {}}`', '`${{ a: 1 }}`', 'f(`${A}`)',
  'async function () {}', 'new B', 'new B()', '(B, C)', '(cond ? A : B)', 'f(g(1, 2))', 'f({ a: 1 }, [2, 3])', 'f(function () { return 1; })', 'f(/a,b/)', 'import("x")', '/* c */ A', 'A /* c */', 'A // c\n', '\u00e9', String.raw`\u0041`, '$', 'a.b.c', 'null', '1',
  '/x/', '/x, y/g', '1e+5', '1E-5', '.5e+3', '1_0e+1', 'a?.[0]', 'a?.(b)', 'a!.b', 'this.#x'];

test('TypeScript: the elements of a heritage list before a call — names, paths, type arguments, optional chains, calls, literals, functions and classes — are read back to the keyword, and the braces after the call hold members', (t) => {
  const ts = loadTypescriptOracle();
  const shapes = [(e) => `class C implements ${e}, B()`, (e) => `class C extends ${e}, B()`, (e) => `class C implements ${e}, D, B()`, (e) => `interface I extends ${e}, B()`, (e) => `interface I extends D, ${e}, B()`];
  let valid = 0;
  for (const element of LIST_ELEMENTS) {
    for (const shape of shapes) {
      const heritage = shape(element);
      const code = pageOf(`${heritage} { delete<T>(x: MARK): void${heritage.startsWith('class') ? ' {}' : ';'} }`, 'T');
      if (ts && !cleanSourceFile(ts, code)) continue;
      valid += 1;
      // A name written with an escape is a guess of its own (`identifier`), wherever it stands, and so is a `/` right after `implements`, a word that a name may be (`keyword`: a regex or a division): the page is refused after it, and the note is never rewritten.
      const before = heritage.slice(0, heritage.indexOf(element));
      const guess = element.includes('\\') ? 'refused:identifier' : /^\/[^*/]/.test(element) && /implements $/.test(before) ? 'refused:keyword' : 'exact';
      assertRead(code, guess, visible(heritage));
      if (guess === 'exact') assert.ok(readsAsCode(code), `${visible(heritage)}: the method is code`);
    }
  }
  if (!ts) t.diagnostic(SKIP);
  else assert.ok(valid >= LIST_ELEMENTS.length * shapes.length * 0.7, `${valid} pages are valid to TypeScript`);
  // A list longer than the window that is read back (2,000 characters) leaves the keyword out of sight: the braces may hold members, and the method is read as one.
  const names = Array.from({ length: 300 }, (unused, k) => `Base${k}`).join(', ');
  for (const heritage of [`class C implements ${names}, B()`, `interface I extends ${names}, B()`]) {
    const code = pageOf(`${heritage} { delete<T>(x: MARK): void${heritage.startsWith('class') ? ' {}' : ';'} }`, 'T');
    assertRead(code, 'exact', `a list of ${names.length} characters`);
    if (ts) assertTypeScriptReads(ts, code, 'a long list');
  }
});

test('a call after a comma in an object literal is a method\'s head whose braces hold statements, so an element after `void` that follows a statement there is read for certain', (t) => {
  const ts = loadTypescriptOracle();
  const body = 'x;\nvoid <span>(MARK); // note</span>;';
  const frames = [
    ['a property', (b) => `const o = { a: 1, m() { ${b} } };`], ['a shorthand property', (b) => `const o = { a, m() { ${b} } };`], ['a shorthand property and a method before it', (b) => `const o = { a, b() {}, m() { ${b} } };`],
    ['a spread', (b) => `const o = { ...s, m() { ${b} } };`], ['a quoted key', (b) => `const o = { 'k': 1, m() { ${b} } };`], ['a computed key', (b) => `const o = { [k]: 1, m() { ${b} } };`],
    ['a getter before it', (b) => `const o = { get a() { return 1; }, m() { ${b} } };`], ['a conditional', (b) => `const o = { a: c ? d : e, m() { ${b} } };`], ['a call', (b) => `const o = { a: f(x, y), m() { ${b} } };`],
    ['an array', (b) => `const o = { a: [1, 2], m() { ${b} } };`], ['an object', (b) => `const o = { a: { b: 1 }, m() { ${b} } };`], ['a string with a comma', (b) => `const o = { a: 'x, y', m() { ${b} } };`],
    ['a comparison', (b) => `const o = { a: x > y, m() { ${b} } };`], ['an arrow', (b) => `const o = { a: (x) => y, m() { ${b} } };`], ['an element', (b) => `const o = { a: <b>t</b>, m() { ${b} } };`],
    ['type arguments', (b) => `const o = { a: f<A, B>(x), m() { ${b} } };`], ['an async method', (b) => `const o = { a: 1, async m() { ${b} } };`], ['a generator', (b) => `const o = { a: 1, *m() { ${b} } };`],
    ['a method before it', (b) => `const o = { n() {}, m() { ${b} } };`], ['an argument', (b) => `f({ a: 1, m() { ${b} } });`], ['a returned object', (b) => `function g() { return { a: 1, m() { ${b} } }; }`],
    ['a property named like a heritage keyword', (b) => `const o = { a: x.extends, m() { ${b} } };`], ['a property named implements', (b) => `const o = { a: x.implements, m() { ${b} } };`], ['a key named like a heritage keyword', (b) => `const o = { extends: 1, implements: 2, m() { ${b} } };`],
    ['a class that implements a call, whose method has the body', (b) => `class C implements A, B() { m() { ${b} } }`], ['a class that extends a call after a comma, whose method has the body', (b) => `class C extends A, B() { m() { ${b} } }`],
  ];
  let valid = 0;
  for (const [what, wrap] of frames) {
    const code = `${wrap(body)}\n${CALL};`;
    assert.deepStrictEqual(guessesOf(code), [], `${what}: no guess`);
    assert.ok(!readsAsCode(code), `${what}: the text of the element is text`);
    assert.deepStrictEqual(readPage(code).rewritten.length, 1, `${what}: the call after it is rewritten`);
    if (ts && cleanSourceFile(ts, code)) valid += 1;
  }
  if (ts) assert.strictEqual(valid, frames.length, 'every page is valid to TypeScript');
  else t.diagnostic(SKIP);
});

// ─── Where no member stands, the head of an element is read for certain ───────────────────────────────────────────────────────────────────────────────────────

// A head that starts like an element's is the type parameters of a signature where a member of a type may begin at it, and the text after its list can hide the closing tag (`<in U>(y); // note</in>`: the comment may hold it): both programs compile, and the page
// is refused after the guess. Where no member can stand — after `return`, after a comma in parentheses or brackets, and at the start of a statement in a block or at the top level — the head is an element, and the text is read as the element's: nothing is guessed. The
// places are those where membersMayStandAt answers no; a lexer that asked it only for a word before the head (`void`, `delete`) guessed here as it does for a signature.
const NO_MEMBER_HEADS = ['<>', '<in U>', '<out U>', '<public U>', '<const in U>', '<const in out U>', '<U>', '<static\nU>'];
const NOTE_TEXTS = ['(MARK); // note', '(MARK), x; // note', '(MARK); /* note */', '(MARK) plain text // note'];
const NO_MEMBER_PLACES = [
  ['the value of a return', (e) => `function f() { return ${e}; }`], ['the value of a return in a method', (e) => `class C { m() { return ${e}; } }`], ['the value of a return in a method that follows a property of an object literal', (e) => `const o = { a: 1, m() { return ${e}; } };`],
  ['an argument after a comma', (e) => `f(a, ${e});`], ['an operand after a comma in parentheses', (e) => `const v = (touch(), ${e});`], ['an element of an array after a comma', (e) => `const v = [a, ${e}];`],
  ['the start of the source', (e) => `${e};`], ['the start of a statement after a statement', (e) => `x;\n${e};`], ['the start of a statement in a function', (e) => `function f() { ${e}; }`], ['the start of a statement in a block', (e) => `{ ${e}; }`],
  ['the start of a statement in an if block', (e) => `if (a) { ${e}; }`], ['the start of a statement in an else block', (e) => `if (a) { b; } else { ${e}; }`], ['the start of a statement in a try block', (e) => `try { ${e}; } catch { g(); }`],
  ['the start of a statement in an async method', (e) => `class C { static async m(a) { ${e}; } }`], ['the body of an if with no braces', (e) => `if (a) ${e};`],
];

test('a head that starts like an element\'s is an element for certain after `return`, after a comma in parentheses or brackets and at the start of a statement in a block or at the top level, wherever the text after its list could hide the closing tag', (t) => {
  const ts = loadTypescriptOracle();
  let valid = 0;
  for (const [place, wrap] of NO_MEMBER_PLACES) {
    for (const head of NO_MEMBER_HEADS) {
      for (const text of NOTE_TEXTS) {
        const code = `${wrap(`${head}${text}</${closingOf(head)}>`)}\n${CALL};`;
        const label = `${place} / ${visible(head)} / ${text}`;
        if (ts && !cleanSourceFile(ts, code)) continue;
        valid += 1;
        assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
        assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
        assert.strictEqual(readPage(code).rewritten.length, 1, `${label}: the call after the element is rewritten`);
        if (ts) assert.ok(isElement(readingAt(ts, cleanSourceFile(ts, code), code.indexOf(head))), `${label}: TypeScript reads an element`);
      }
    }
  }
  if (!ts) t.diagnostic(SKIP);
  else assert.ok(valid >= NO_MEMBER_PLACES.length * NO_MEMBER_HEADS.length * 3, `${valid} pages are valid to TypeScript`);
});

test('a head that starts like an element\'s stays a guess where a member of a type may begin, in the braces that the lexer does not know for a block, and where its list cannot be read or its head holds a comment', (t) => {
  const ts = loadTypescriptOracle();
  const heads = ['<>', '<in U>', '<public U>', '<const in U>', '<U>'];
  // A member of a type begins here, and so do the braces after a heritage that ends in a call, a class and an arrow's block: the same text is a signature's.
  const members = [
    ['a member of an interface', (e) => `interface I {\n  ${e}\n}`], ['a member of a type literal', (e) => `type L = {\n  ${e}\n};`], ['a member after a comma', (e) => `interface I { a: A,\n  ${e}\n}`], ['a member after a semicolon', (e) => `interface I { a: A;\n  ${e}\n}`],
    ['a member after a heritage that ends in a call', (e) => `interface I extends A, B() {\n  ${e}\n}`], ['a member after `extends` and a call', (e) => `interface I extends B() {\n  ${e}\n}`],
    ['the block of an arrow', (e) => `const f = () => {\n  ${e};\n};`], ['braces after a colon', (e) => `l: {\n  ${e};\n}`], ['a template substitution', (e) => `const s = \`\${(() => {\n  ${e};\n})()}\`;`],
  ];
  for (const [place, wrap] of members) {
    for (const head of heads) {
      const code = `${wrap(`${head}(y); // note</${closingOf(head)}>`)}\n${CALL};`;
      const { rewritten, frontier } = readPage(code);
      assert.ok(frontier && frontier.kind === 'generic', `${place} / ${visible(head)}: the guess is named: ${visible(frontier)}`);
      assert.deepStrictEqual(rewritten, [], `${place} / ${visible(head)}: the call after the guess is not rewritten`);
      if (ts && place !== 'braces after a colon' && place !== 'the block of an arrow' && place !== 'a template substitution') assert.ok(cleanSourceFile(ts, code), `${place} / ${visible(head)}: TypeScript parses the page`);
    }
  }
  // No member stands in the braces of a function, and the list cannot be read to its end, or the head holds a comment that the lexer does not read: the guess stays, as it does after an `=`.
  const unread = [['a regex after a call in a default', '<in U>(a = f(/)/))</in>'], ['a regex in parentheses in a default', '<public U>(a = (/[)]/))</public>'], ['a template in a template', '<in U>(x: `${`p`}`)</in>'],
    ['a head with a comment', '<public /* c */ U>(y)</public>'], ['a comment in a fragment head', '<in /* c */ U>(y)</in>']];
  for (const [place, wrap] of NO_MEMBER_PLACES.filter(([what]) => /return|comma|source|statement in a function/.test(what))) {
    for (const [what, element] of unread) {
      const code = `${wrap(element)}\n${CALL};`;
      const { rewritten, frontier } = readPage(code);
      assert.ok(frontier && frontier.kind === 'generic', `${place} / ${what}: the guess is named: ${visible(frontier)}`);
      assert.deepStrictEqual(rewritten, [], `${place} / ${what}: the call after the guess is not rewritten`);
      if (ts) assert.ok(cleanSourceFile(ts, code), `${place} / ${what}: TypeScript parses the page`);
    }
  }
  // A token that is a guess of its own before the head — `in`, `>=`, `<` — keeps its guess wherever it stands: only after a token that the rule reads (`return`, a `,`, a `;`) does the place say that no member stands.
  for (const place of ['const k = a in @;', 'const k = a >= @;', 'x = a < @;', 'function f() { return a in @; }']) {
    const code = `${place.replace('@', '<in U>(y); // note</in>')}\n${CALL};`;
    const { rewritten, frontier } = readPage(code);
    assert.ok(frontier && frontier.kind === 'generic', `${place}: the guess is named: ${visible(frontier)}`);
    assert.deepStrictEqual(rewritten, [], `${place}: the call after the guess is not rewritten`);
  }
});

// ─── A long run of postfix `!` ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Whether a line break before a word ends a member depends on whether an operand ended before it: after a name, `!` is the postfix operator of a non-null assertion, and a run of them is walked back to the name. A page is untrusted input, and a call per `!` overflowed
// the stack a few thousand of them in (the same walk as positionAfterPrefixable, which is a loop). The braces that hold the statement are looked for from where the run begins, so that a run longer than the window that the lexer looks back over (2,000 characters) does not
// put them out of sight: a function's or a method's body is read for certain at any length. The block of an arrow is the one place that stays a guess (`generic`), as for any statement in it: its braces may be a function type's object type.
test('a run of 20,000 postfix `!` before a line break and an element is read, not a stack overflow: exactly where the braces are known for a block, and after a guess in the block of an arrow', (t) => {
  const ts = loadTypescriptOracle();
  const element = 'void <span>(MARK); // note</span>;';
  // [place, the page for a run of n, what the page gives]: 'exact' resolves the call after it, 'generic' names the guess.
  const pages = (n) => [
    ['a function body', `function f() { const p = value${'!'.repeat(n)}\n${element} }\n${CALL};`, 'exact'],
    ['a method body', `class C { m() { const p = value${'!'.repeat(n)}\n${element} } }\n${CALL};`, 'exact'],
    ['the block of an arrow', `const f = () => { const p = value${'!'.repeat(n)}\n${element} };\n${CALL};`, 'generic'],
    ['a class property', `class C { x = value${'!'.repeat(n)}\n  void<U>(y: MARK): T {} }\n${CALL};`, 'exact'],
    ['prefix operators, which no operand precedes', `function f() { const p =${'!'.repeat(n)}\n${element} }\n${CALL};`, 'exact'],
  ];
  for (const n of [20, 1999, 2001, 20000, 200000]) {
    for (const [what, code, expected] of pages(n)) {
      const label = `${what} / ${n}`;
      let read;
      assert.doesNotThrow(() => { read = readPage(code); }, `${label}: no stack overflow`);
      if (expected === 'exact') {
        assert.strictEqual(read.frontier, null, `${label}: no guess is named`);
        assert.strictEqual(read.rewritten.length, 1, `${label}: the call after it is rewritten`);
      } else {
        assert.ok(read.frontier && read.frontier.kind === 'generic', `${label}: the guess generic is named: ${visible(read.frontier)}`);
        assert.deepStrictEqual(read.rewritten, [], `${label}: the call after the guess is not rewritten`);
      }
      // The method of the class is code and the text of an element is text, wherever the run ends: the guess reads the head as the element it may be.
      assert.strictEqual(readsAsCode(code), what === 'a class property', `${label}: the method is code and the element's text is text`);
      if (ts && n <= 20) assert.ok(cleanSourceFile(ts, code), `${label}: TypeScript parses the page`);
    }
  }
});

// ─── A decorator that ends in the `>` of type arguments or in a decimal point ───────────────────────────────────────────────────────────────────────────────

// A decorator is an `@` and a left-hand-side expression, and the expression may end in the `>` of type arguments — an instantiation expression, `@dec<T>` — which the parser takes for one when the next token is a binary operator or stands on a later line
// (canFollowTypeArgumentsInExpression, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts): a generator's `*`, a method named `instanceof`, a field named `in` or `instanceof` that a line break ends. Or in a number's decimal point: `1.` is a
// literal of its own, and `@1. *delete<U>() {}` a decorated generator. A member begins where the decorator ends, so a method named like an operator after it is a member and the note after it is data; a lexer that took the `>` or the `.` for the end of nothing read
// the operator word for an operator and the `<U>` for an element, whose text ran on to the closing tag in the note and held the call there.
// The names of the methods, accessors and signatures that have type parameters in a program that TypeScript parses with no diagnostic (null where it does not parse).
function typeParameterNames(ts, code) {
  const source = cleanSourceFile(ts, code);
  if (!source) return null;
  const names = new Set();
  (function visit(node) {
    if (node.name && node.typeParameters && node.name.text) names.add(node.name.text);
    ts.forEachChild(node, visit);
  })(source);
  return names;
}

test('TypeScript: a method named like an operator is a member after a decorator that ends in the `>` of type arguments or in a decimal point, and the note after it is data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const base = loadBaseLexer();
  const codes = [];
  let valid = 0;
  for (const { code, label } of decoratorEndPages()) {
    const names = typeParameterNames(ts, code);
    if (!names || ![...MEMBER_NAME_OPERATORS].some((word) => names.has(word))) continue;
    valid += 1;
    codes.push(code);
    assertRead(code, 'exact', label);
    assert.ok(readsAsCode(code), `${label}: the method is code`);
  }
  assert.ok(valid >= 1500, `${valid} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages valid to TypeScript`);
  // The released lexer reads the head of every one of them that follows the operator word directly for an element, and rewrites the note.
  if (base) assert.ok(misreadByBase(base, codes) >= codes.length / 2, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // The shapes in which the `>` was found: a generator, a method named `instanceof`, and a field named `in` or `instanceof` that a line break ends — and the controls that were read right before: a call, a line break, a field that a `;` ends.
  const named = [
    ['a generator', 'class Store { @d<string> *delete<T>(key: T) { yield key; } }', 'exact'], ['a method named instanceof', 'class Guard { @d<string> instanceof<T>(value: T): boolean { return true; } }', 'exact'],
    ['a field named in and a line break', 'class Store { @d<string> in\n  delete<T>(key: T): void {} }', 'exact'], ['a field named instanceof and a line break', 'class Guard { @d<string> instanceof\n  void<T>(value: T): void {} }', 'exact'],
    ['a decimal point and a generator', 'class Store { @1. *delete<T>(key: T) { yield key; } }', 'exact'], ['a decimal point, a line break and a generator', 'class Store { @1.\n  *typeof<T>(key: T) { yield key; } }', 'exact'],
    ['control: a call and a generator', 'class Store { @d<string>() *delete<T>(key: T) { yield key; } }', 'exact'], ['control: a line break', 'class Store { @d<string>\n  delete<T>(key: T): void {} }', 'exact'],
    ['control: a field that a semicolon ends', 'class Store { @d<string> in = 1;\n  delete<T>(key: T): void {} }', 'exact'],
  ];
  for (const [what, source, expect] of named) {
    const code = pageOf(source, 'T');
    assert.ok(cleanSourceFile(ts, code), `${what}: TypeScript parses the page`);
    assertRead(code, expect, what);
  }
  // A `>` or a `.` that ends no decorator stays what it was: the `>` of a comparison and of an arrow is no end of a decorator, so the operator word after it is an operator and the element after that is text, with no guess — whatever decorator stands earlier on its statement.
  const element = 'void <span>(MARK); // note</span>;';
  for (const code of [`class C { @dec x = a > ${element} }`, `class C { @dec x = a >> ${element} }`, `class C { x = () => ${element} }`, `class C { @dec x = (a) => ${element} }`, `class C { @dec x = a < b > ${element} }`, `class C { @dec(a) x = b > ${element} }`,
    `class C { @dec<T>\n  x = a > ${element} }`, `class C { @dec<T>() x = a > ${element} }`, `class C { @1. x = a > ${element} }`, `class C { @dec x = 1.5 ${element.replace('void', '+ void')} }`]) {
    assert.ok(cleanSourceFile(ts, code), `TypeScript parses ${visible(code)}`);
    assert.ok(!readsAsCode(code), `the element is text: ${visible(code)}`);
    assert.deepStrictEqual(guessesOf(code), [], `no guess: ${visible(code)}`);
  }
});

// ─── A number that ends in a decimal point, after white space of every kind ─────────────────────────────────────────────────────────────────────────────────

// `1.` is a literal of its own (scanNumber, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts), and it ends a decorator or a field's initializer whatever stands before its digits, as long as it is no part of a name or of another number (`a1.`, `1.5.`, `1e5.`,
// `0x1.` and `1n.` are member accesses). The scanner skips every character of `isWhiteSpaceSingleLine` and `isLineBreak` between two tokens, so the `@` of a decorator and the digits of its number may stand as far apart as any two tokens do: a no-break space, the line separator,
// the byte order mark, a comment. A lexer that took any character beyond ASCII before the digits for the end of a name saw no number, no end of the decorator and no end of the field: it read the operator word after it for an operator and the `<T>` for an element, whose text ran on to
// the closing tag in the note after the class, and rewrote the call there.
test('TypeScript: a number that ends in a decimal point ends a decorator and a field\'s initializer after every character that the scanner skips between two tokens, and the method after it is a member', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const base = loadBaseLexer();
  const skipped = [];
  for (let unit = 0; unit <= 0xffff; unit += 1) if (ts.isWhiteSpaceSingleLine(unit) || ts.isLineBreak(unit)) skipped.push(String.fromCharCode(unit));
  assert.deepStrictEqual(skipped.filter((c) => !NUMBER_GAPS.includes(c)), [], 'a character that TypeScript skips between two tokens is missing from NUMBER_GAPS');
  const beyondAscii = skipped.filter((c) => c.charCodeAt(0) > 0x7f);
  assert.strictEqual(beyondAscii.length, 21, 'the characters beyond ASCII that the scanner skips');
  const codes = [];
  const covered = { decorator: new Set(), field: new Set() };
  for (const { code, label } of decimalPointPages()) {
    const names = typeParameterNames(ts, code);
    if (!names || ![...MEMBER_NAME_OPERATORS].some((word) => names.has(word))) continue;
    codes.push(code);
    const [family, gap] = label.split(' / ');
    covered[family === 'a decorator' ? 'decorator' : 'field'].add(JSON.parse(gap));
    assertRead(code, 'exact', label);
    assert.ok(readsAsCode(code), `${label}: the method is code`);
  }
  assert.ok(codes.length >= 2400, `${codes.length} pages are valid to TypeScript`);
  t.diagnostic(`${codes.length} pages valid to TypeScript`);
  // Each character that the scanner skips, beyond ASCII too, stood before the digits in a decorator and in a field's initializer that TypeScript parses.
  for (const family of ['decorator', 'field']) assert.deepStrictEqual(skipped.filter((c) => !covered[family].has(c)), [], `a character that was never tried before the number of a ${family}`);
  // The released lexer knows no number that ends a decorator, and reads the method after it for an element in most of them.
  if (base) assert.ok(misreadByBase(base, codes) >= codes.length / 3, `the released lexer misreads only ${misreadByBase(base, codes)} of the ${codes.length} pages`);
  // The named shapes, one by one: a decorated generator, a decorated method named `instanceof`, a field that a line break ends, and the number as an argument, which is no end of anything.
  const element = 'void <span>(MARK); // note</span>;';
  for (const c of ['\u00a0', '\u2028', '\u0085', '\u200b', '\ufeff', '\u3000']) {
    for (const [what, source] of [
      ['a decorated generator', `class Store { @${c}1. *delete<T>(key: MARK) { yield key; } }`], ['a decorated generator on the next line', `class Store { @${c}1.\n  *typeof<T>(key: MARK) { yield key; } }`],
      ['a decorated method named instanceof', `class Guard { @${c}1. instanceof<T>(value: MARK): boolean { return true; } }`], ['a field and a method', `class Store { a =${c}1.\n  delete<T>(key: MARK): void {} }`],
    ]) {
      const code = pageOf(source, 'T');
      assert.ok(cleanSourceFile(ts, code), `${what}: TypeScript parses ${visible(source)}`);
      assertRead(code, 'exact', `${what} after ${visible(c)}`);
      assert.ok(readsAsCode(code), `${what} after ${visible(c)}: the method is code`);
    }
    // After the number as an argument, or a number that goes on (`1.5`), the same word is an operator and the text after it is an element's, as it is with ASCII white space around it.
    for (const source of [`class C { @dec(${c}1.) x = ${element} }`, `class C { @${c}1.5 x = ${element.replace('void', '+ void')} }`, `class C { @dec x = ${c}1.5 ${element.replace('void', '+ void')} }`]) {
      assert.ok(cleanSourceFile(ts, source), `TypeScript parses ${visible(source)}`);
      assert.ok(!readsAsCode(source), `the element is text: ${visible(source)}`);
      assert.deepStrictEqual(guessesOf(source), [], `no guess: ${visible(source)}`);
    }
  }
});

// ─── A method, a function or a property that a heritage keyword names ───────────────────────────────────────────────────────────────────────────────────────

// The word before the `(` of `class C extends (B) {` and `class C implements (B) {` is the keyword of a heritage clause, and the braces after the `)` hold members. The same word names a method (`class C { implements() { … } }`), a function and a property of an object
// literal, and the braces after its `)` are the body of a function, whose statements an element may start: `void <span>(x); // note</span>` there is an element, for certain. Which of the two a word is, is read from what stands before it: a keyword follows the name of
// a class, its type arguments or another heritage clause, and a name follows a member's separator, a modifier, a generator's `*`, a decorator or a line break after a member. (A lexer that took every such word for the keyword refused the element, as it does where braces may
// hold members.)
const KEYWORD_BODY_PLACES = [['a method of a class', (n, b) => `class C { ${n}() { ${b} } }`], ['a method of an object literal', (n, b) => `const o = { ${n}() { ${b} } };`]];

test('a method, a function or a property named `implements`, `extends` or `new` has the body of a function: an element after `void` there is read for certain, wherever the name stands', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  let valid = 0;
  for (const [place, frame] of [...KEYWORD_BODY_PLACES, ...KEYWORD_METHOD_FRAMES]) {
    for (const name of KEYWORD_NAMES) {
      for (const body of KEYWORD_BODIES) {
        const text = frame(name, body);
        if (text === null) continue;
        const code = `${text}\n${CALL};`;
        const label = `${place} / ${name} / ${visible(body)}`;
        if (!cleanSourceFile(ts, code)) continue;
        valid += 1;
        assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
        assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
        assert.strictEqual(readPage(code).rewritten.length, 1, `${label}: the call after it is rewritten`);
      }
    }
  }
  assert.ok(valid >= 300, `${valid} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages valid to TypeScript`);
  // A method named `implements` or `extends` in the braces of a class whose heritage ends in the same word before a `(`: the first braces hold members, the second the statements, and each is read for what it is.
  for (const heritage of ['class C implements (B)', 'class C extends (B)', 'class C extends A implements (B)', 'class C<T> implements (B)', 'abstract class C implements (B)', 'const K = class extends (B)', 'class C implements f(B)', 'class C extends A, f(B)', 'class C extends A implements B, f(C)',
    'class C extends class {} implements (B)', 'class C implements A, class {}, B()', 'class C extends class D extends E {}, f(B)', 'class C extends class {} implements class extends B {}, f(C)']) {
    for (const name of ['implements', 'extends']) {
      const code = `${heritage} { ${name}() { void <span>(MARK); // note</span>; }\n  delete<T>(x: MARK): void {} }\nconst note = '</T>};${CALL};//';\n${CALL};`;
      if (!cleanSourceFile(ts, code)) continue;
      const label = `${heritage} / ${name}`;
      assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
      assert.ok(maskOf(code).includes('MARK): void'), `${label}: the method of the heritage's braces is code`);
      assert.ok(!/<span>\(MARK/.test(maskOf(code)), `${label}: the text of the element in the method's body is text`);
      assert.deepStrictEqual(readPage(code).rewritten.length, 1, `${label}: the note is data and the call after it is rewritten`);
    }
  }
  // A name written with an escape is a guess of its own (`identifier`) wherever it stands, in a heritage too: the page is refused after it, and nothing after it is rewritten.
  for (const code of [String.raw`class C extends \u0041 implements (B) { delete<T>(x: MARK): void {} }`, String.raw`class \u0043 implements (B) { delete<T>(x: MARK): void {} }`]) {
    const page = `${code}\nconst note = '</T>};${CALL};//';\n${CALL};`;
    assert.ok(cleanSourceFile(ts, page), `TypeScript parses ${visible(page)}`);
    const { rewritten, frontier } = readPage(page);
    assert.ok(frontier && frontier.kind === 'identifier', `${visible(code)}: the guess identifier is named: ${visible(frontier)}`);
    assert.deepStrictEqual(rewritten, [], `${visible(code)}: nothing after the guess is rewritten`);
  }
});

// ─── A letter beyond ASCII, a private name and a heritage word as a value before a method ──────────────────────────────────────────────────────────────────

// A comma before a name and a call is a heritage list's or an object literal's, and the lexer reads the comma back to tell them apart (heritageListBefore): `{ a: 1, m() { … } }` has a function's head after it, `class C implements A, B() { … }` an element of a list. A name
// that a letter beyond ASCII makes (`café`), a private name (`this.#item`) and a word that a heritage keyword spells (`{ a: implements, m() { … } }`, `{ implements, m() { … } }`) are whole tokens, read as such, so the scan goes on to the `:` or the `{` that says what the comma
// belongs to: a character that it cannot read, or a word that merely looks like the keyword, is no reason to take the comma for a list's.
test('a method after a comma in an object literal is a function\'s head wherever the left side of the comma holds a letter beyond ASCII, a private name or a word that a heritage keyword spells', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  let valid = 0;
  const frames = [
    ...OBJECT_VALUE_FRAMES.flatMap(([place, frame]) => OBJECT_VALUES.map((value) => [`${place} / ${visible(value)}`, (b) => frame(value, b)])),
    ...SHORTHAND_FRAMES.flatMap(([place, frame]) => SHORTHAND_NAMES.map((name) => [`${place} / ${name}`, (b) => frame(name, b)])),
  ];
  for (const [place, frame] of frames) {
    for (const body of KEYWORD_BODIES) {
      const code = `${frame(body)}\n${CALL};`;
      if (!cleanSourceFile(ts, code)) continue;
      valid += 1;
      const label = `${place} / ${visible(body)}`;
      assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
      assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
      assert.strictEqual(readPage(code).rewritten.length, 1, `${label}: the call after it is rewritten`);
    }
  }
  assert.ok(valid >= 1500, `${valid} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages valid to TypeScript`);
  // The same words and letters inside a heritage list: the comma belongs to the list, the braces after the call hold members, and the method there is code — as before.
  for (const element of ['caf\u00e9', '\u540d', 'implements', 'a?.caf\u00e9', 'f(caf\u00e9)', 'caf\u00e9!', 'this.#item', 'a.implements', 'a.extends']) {
    for (const shape of [(e) => `class C implements ${e}, B()`, (e) => `class C extends ${e}, B()`, (e) => `class C implements A, ${e}, B()`, (e) => `interface I extends ${e}, B()`, (e) => `class C extends implements, ${e}, B()`]) {
      const heritage = shape(element);
      const code = pageOf(`${heritage} { delete<T>(x: MARK): void${heritage.startsWith('class') ? ' {}' : ';'} }`, 'T');
      if (!cleanSourceFile(ts, code)) continue;
      assertRead(code, 'exact', visible(heritage));
      assert.ok(readsAsCode(code), `${visible(heritage)}: the method is code`);
    }
  }
  // A name written with an escape is a guess of its own, whatever stands around it, and the page is refused after it.
  for (const code of [String.raw`const o = { a: \u0061, m() { void <span>(MARK); // note</span>; } };`, String.raw`const o = { \u0061, m() { void <span>(MARK); // note</span>; } };`]) {
    const page = `${code}\n${CALL};`;
    assert.ok(cleanSourceFile(ts, page), `TypeScript parses ${visible(page)}`);
    const { rewritten, frontier } = readPage(page);
    assert.ok(frontier && frontier.kind === 'identifier', `${visible(code)}: the guess identifier is named: ${visible(frontier)}`);
    assert.deepStrictEqual(rewritten, [], `${visible(code)}: nothing after the guess is rewritten`);
  }
});

// ─── The last element of a heritage list ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The element that ends a list in a `)` — a call or a parenthesis of any kind — after `implements`, after `extends A,` and after any other comma: the parser reads it as any left-hand-side expression, so the braces after it hold members (the shapes of CLASS_HERITAGES that
// LAST_ELEMENT_HERITAGES draw from a few introducers and the elements: `f(A)`, `(A)`, `import("x")`, `this.f(A)`, `(A as any)`, …).
test('TypeScript: a method named like an operator is a member after a heritage whose last element is a call or a parenthesis of any kind, after `implements`, after `extends A,` and after every other comma', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  let valid = 0;
  for (const heritage of LAST_ELEMENT_HERITAGES) {
    for (const word of ['delete', 'void']) {
      const code = pageOf(`${heritage} { ${word}<U>(x: MARK): void {} }`, 'U');
      if (!methodNamed(ts, code, word)) continue;
      valid += 1;
      assertRead(code, 'exact', `${visible(heritage)} / ${word}`);
      assert.ok(readsAsCode(code), `${visible(heritage)} / ${word}: the method is code`);
    }
  }
  assert.ok(valid >= LAST_ELEMENT_HERITAGES.length, `${valid} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages valid to TypeScript`);
});

// ─── A class that is complete before a method ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A word that may be the keyword of a heritage clause (`extends`, `implements`), and a comma that may end one of its elements, are read back to the `class` or `interface` that the head starts with (readHeritageBack). Read back from the name or the comma after a class that is
// complete — the value of a property, the initializer of a field, a declaration that no `;` ends — the scan meets that class's own `class`, `extends` and `implements`: they are the head of a class whose braces were closed before, and no heritage of what follows. A lexer that took
// them for the keyword of the next call's list refused the body of the method after it, where an element is read for certain, and named a guess — for a page that the released lexer resolved. A parenthesis around the class was no change to the page: the scan crosses it as one bracket.
test('a class that is complete before a method — the value of a property, the initializer of a field, a declaration — leaves no heritage behind it: the braces after the method\'s `)` hold a function\'s statements, and the element in them is read for certain', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const bodies = ['void <span>(MARK); // details</span>;', 'return <>(MARK) // details</>;', 'return <span>(MARK) // detail</span>;', 'x;\nvoid <span>(MARK); // note</span>;'];
  const shapes = [
    ['the value of a property', (v, n, b) => `const registry = { Adapter: ${v}, ${n}() { ${b} } };`], ['the value of a property in a class', (v, n, b) => `class Host { #item = 1; make() { return { adapter: ${v}, ${n}() { ${b} } }; } }`],
    ['a property between the class and the method', (v, n, b) => `const registry = { Adapter: ${v}, label: 'x', ${n}() { ${b} } };`], ['the value of a property in an argument', (v, n, b) => `register({ Adapter: ${v}, ${n}() { ${b} } });`],
    ['the initializer of a field', (v, n, b) => `class Host { adapter = ${v}\n  ${n}() { ${b} } }`], ['a generator after the value', (v, n, b) => `const registry = { Adapter: ${v}, *${n}() { ${b} } };`],
    ['an async method after the value', (v, n, b) => `const registry = { Adapter: ${v}, async ${n}() { ${b} } };`], ['a getter after the value', (v, n, b) => `const registry = { Adapter: ${v}, get ${n}() { ${b} } };`],
  ];
  let valid = 0;
  for (const value of CLASS_VALUES_WRAPPED) {
    for (const [place, frame] of shapes) {
      for (const name of ['render', 'implements', 'extends']) {
        for (const body of bodies) {
          const code = `${frame(value, name, body)}\n${CALL};`;
          if (!cleanSourceFile(ts, code)) continue;
          valid += 1;
          const label = `${place} / ${visible(value)} / ${name} / ${visible(body)}`;
          assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
          assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
          assert.strictEqual(readPage(code).rewritten.length, 1, `${label}: the call after it is rewritten`);
        }
      }
    }
  }
  assert.ok(valid >= 1200, `${valid} pages are valid to TypeScript`);
  // A name after a declaration that no `;` ends: the class or the interface is complete, and the function that follows is no part of its head.
  const declarations = ['class Q {}', 'class Q extends Base {}', 'class Q implements I {}', 'class Q extends mixin(A) {}', 'class Q implements A, B() {}', 'class Q<T> extends B<T> implements I {}', 'interface Q {}', 'interface Q extends A, B {}', 'abstract class Q {}', 'export default class {}',
    '@dec class Q {}', 'const K = class extends Base {}', 'class Q { m() { return { a: 1 }; } }', 'class Q {} // note', 'class Q extends Base { static { x(); } }'];
  let declared = 0;
  for (const declaration of declarations) {
    for (const body of bodies) {
      const code = `${declaration}\nfunction implements() { ${body} }\n${CALL};`;
      if (!cleanSourceFile(ts, code)) continue;
      declared += 1;
      assert.deepStrictEqual(guessesOf(code), [], `${visible(declaration)}: no guess`);
      assert.ok(!readsAsCode(code), `${visible(declaration)}: the text of the element is text`);
      assert.strictEqual(readPage(code).rewritten.length, 1, `${visible(declaration)}: the call after it is rewritten`);
    }
  }
  assert.ok(declared >= 40, `${declared} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages with a class value and ${declared} with a declaration valid to TypeScript`);
  // A field named `new` that no `;` and no initializer ends, and a method after it on the next line: the field is the name of a member of the class, no operator, and the braces of the method are its body. The same with the `;`.
  const element = 'void <span>(MARK); // note</span>;';
  const field = `class C { new\n  render() { ${element} } }\n${CALL};`;
  assert.ok(cleanSourceFile(ts, field), `TypeScript parses ${visible(field)}`);
  assert.deepStrictEqual(guessesOf(field), [], 'no guess after a field named `new`');
  assert.ok(!readsAsCode(field), 'the text of the element is text');
  assert.strictEqual(readPage(field).rewritten.length, 1, 'and the call after it is rewritten');
  const ended = `class C { new;\n  render() { ${element} } }\n${CALL};`;
  assert.deepStrictEqual(guessesOf(ended), [], 'no guess where a `;` ends the field');
  assert.strictEqual(readPage(ended).rewritten.length, 1);
  // A class whose own base is a class expression has the braces of the base inside its head: the braces of the class are the second, after a `}`. The head is read back across the first, as the head of a class that is complete, and the braces of the method after it are its body.
  for (const nested of [`const registry = { Adapter: class extends class {} {}, render() { ${element} } };\n${CALL};`, `class Q extends class {} {}\nfunction implements() { ${element} }\n${CALL};`]) {
    assert.ok(cleanSourceFile(ts, nested), `TypeScript parses ${visible(nested)}`);
    assert.deepStrictEqual(guessesOf(nested), [], `no guess: ${visible(nested)}`);
    assert.ok(!readsAsCode(nested), `the text of the element is text: ${visible(nested)}`);
    assert.strictEqual(readPage(nested).rewritten.length, 1, `and the call after it is rewritten: ${visible(nested)}`);
  }
  // A run of members whose braces the scan crosses one after the other (as many as the window of 2,000 characters holds): it reads the head of each braces that it meets, and none of them twice. A scan that read the heads of all the braces before them for each would take time that doubles with every member.
  for (const [what, member, length] of [['methods', (k) => `m${k}() { return ${k}; }`, 60], ['properties with a class', (k) => `p${k}: class extends B${k} {}`, 60], ['methods with a call in the head', (k) => `m${k}(a = f(${k})) { return a; }`, 45],
    ['properties with a class whose base is a class expression', (k) => `p${k}: class extends class B${k} {} {}`, 40], ['methods with a class whose base is a class expression between them', (k) => (k % 3 === 0 ? `p${k}: class extends class {} {}` : `m${k}() { return ${k}; }`), 60]]) {
    const run = `const registry = {\n  ${Array.from({ length }, (unused, k) => member(k)).join(',\n  ')},\n  render() { ${element} }\n};\n${CALL};`;
    assert.ok(cleanSourceFile(ts, run), `TypeScript parses a run of ${what}`);
    const started = Date.now();
    assert.deepStrictEqual(guessesOf(run), [], `a run of ${what}: no guess`);
    assert.ok(!readsAsCode(run), `a run of ${what}: the text of the element is text`);
    assert.strictEqual(readPage(run).rewritten.length, 1, `a run of ${what}: the call after it is rewritten`);
    assert.ok(Date.now() - started < 10000, `a run of ${what} is read in linear time: ${Date.now() - started} ms`);
  }
  // A class among the elements of a heritage list is one element: the braces after the call that ends the list hold the members of the outer class, whatever words the inner class has, and a method that the outer class names like a keyword has the body of a function.
  for (const heritage of ['class C extends class {}, B()', 'class C extends class {} implements (B)', 'class C implements A, class {}, B()', 'class C extends class D extends E {} implements (B)', 'class C extends class Named<T> extends Base<T> implements I {}, B()', 'class C extends function () {}, B()',
    'class C implements A, class implements {}, B()', 'class C extends class extends mixin(A) {} implements (B)']) {
    const code = pageOf(`${heritage} { implements() { ${element} }\n  delete<T>(x: MARK): void {} }`, 'T');
    if (!cleanSourceFile(ts, code)) continue;
    assertRead(code, 'exact', visible(heritage));
    assert.ok(readsAsCode(code), `${visible(heritage)}: the method of the outer class is code`);
    assert.ok(!/<span>\(MARK/.test(maskOf(code)), `${visible(heritage)}: the element in the body of a method is text`);
  }
});

// ─── A class whose base is a class expression, and a field named `new` ──────────────────────────────────────────────────────────────────────────────────

// A class expression in the head of a class has its braces inside the head, so the braces of the class come after a `}` (`{ a: class extends class {} {}, m() { … } }`). The head is read back across them, as the head of a class that is complete is, and the braces of the method after it are its body,
// where an element is read for certain. So it is for a base that is an element of `implements`, one after a comma or after `new`, with members, decorators and type parameters of its own, and for a chain of them: no more than HEAD_NESTING deep.
const NESTED_BASE_HEADS = ['class extends class {}', 'class extends class A {}', 'class A extends class B {}', 'class extends class extends B {}', 'class extends class extends class {} {}', 'class extends class {} implements I', 'class implements class {}', 'class extends A implements class {}', 'class extends A implements class {}, class {}',
  'class extends class {}, class {}', 'class extends class {}.x', 'class extends class {}()', 'class extends class {}!', 'class extends new class {}', 'class extends new @d class {}', 'class extends class { m() { return class {}; } }', 'class extends class Named<T> extends Base<T> implements I {}', 'class extends class implements I {}',
  'class extends class<T> {}', 'class extends class\n{}', 'class\nextends\nclass\n{}', 'class extends class /* c */ {} /* d */', 'class extends class {}\n.x', 'class implements class {}, class {}, class {}, class {}, class {}, class {}, class {}', `${'class extends '.repeat(HEAD_NESTING)}class {}${' {}'.repeat(HEAD_NESTING - 1)}`];
const NESTED_BASE_FRAMES = [
  ['the value of a property', (head, n, b) => `const registry = { Adapter: ${head} {}, ${n}() { ${b} } };`], ['a property between the class and the method', (head, n, b) => `const registry = { Adapter: ${head} {}, label: 'x', ${n}() { ${b} } };`],
  ['the value of a property in an argument', (head, n, b) => `register({ Adapter: ${head} {}, ${n}() { ${b} } });`], ['two classes', (head, n, b) => `const registry = { A: ${head} {}, B: ${head} {}, ${n}() { ${b} } };`],
  ['the value of a property in a class', (head, n, b) => `class Host { make() { return { adapter: ${head} {}, ${n}() { ${b} } }; } }`], ['the initializer of a field', (head, n, b) => `class Host { adapter = ${head} {}\n  ${n}() { ${b} } }`],
  ['a generator after the value', (head, n, b) => `const registry = { Adapter: ${head} {}, *${n}() { ${b} } };`], ['an async method after the value', (head, n, b) => `const registry = { Adapter: ${head} {}, async ${n}() { ${b} } };`],
  ['a declaration before a function', (head, n, b) => `${head} {}\nfunction ${n}() { ${b} }`], ['a declaration and a comment before a function', (head, n, b) => `${head} {} // note\nfunction ${n}() { ${b} }`], ['an expression before a function', (head, n, b) => `const Adapter = ${head} {}\nfunction ${n}() { ${b} }`],
];
test('a class whose base is a class expression, as the value before a method, the initializer of a field or a declaration before a function, has its head read back across the braces of the base: the braces of the method after it are its body, and an element in it is read for certain', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const bodies = ['void <span>(MARK); // details</span>;', 'return <>(MARK) // details</>;', 'return <span>(MARK) // detail</span>;', 'x;\nvoid <span>(MARK); // note</span>;'];
  let valid = 0;
  for (const head of NESTED_BASE_HEADS) {
    for (const [place, frame] of NESTED_BASE_FRAMES) {
      for (const name of ['render', 'implements', 'extends']) {
        for (const body of bodies) {
          const code = `${frame(head, name, body)}\n${CALL};`;
          if (!cleanSourceFile(ts, code)) continue;
          valid += 1;
          const label = `${place} / ${visible(head)} / ${name} / ${visible(body)}`;
          assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
          assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
          assert.strictEqual(readPage(code).rewritten.length, 1, `${label}: the call after it is rewritten`);
        }
      }
    }
  }
  assert.ok(valid >= 1000, `${valid} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages valid to TypeScript`);
  // The braces of the class itself hold members, wherever the class stands: a method named like an operator that has type parameters is code after such a head, and the closing tag of its type parameter in the note after it is data.
  let members = 0;
  for (const head of NESTED_BASE_HEADS) {
    for (const wrap of [(c) => c, (c) => `const o = { a: ${c}, b: 1 };`, (c) => `function f() { ${c} }`, (c) => `const K = ${c};`, (c) => `class H { a = ${c} }`, (c) => `f(${c});`]) {
      const code = pageOf(wrap(`${head} { delete<U>(y: U): MARK {} }`), 'U');
      if (!cleanSourceFile(ts, code)) continue;
      members += 1;
      assertRead(code, 'exact', visible(head));
      assert.ok(readsAsCode(code), `${visible(head)}: the method is code`);
    }
  }
  assert.ok(members >= 100, `${members} pages are valid to TypeScript`);
});

test('a class whose base is a class expression and a field named `new` leave as they were what they never resolved: a function expression or an object literal in a head, type arguments after the base, a chain that is deeper than HEAD_NESTING, a `new` that no member of a class begins', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const element = 'void <span>(MARK); // note</span>;';
  const chain = (depth) => `${'class extends '.repeat(depth)}class {}${' {}'.repeat(depth)}`;
  // The braces of a function expression or an object literal in a head have no `class` of their own, and a class read back across them would take the `class` of the head for theirs; type arguments after the base are the guess `brace` of the `}` before them. A `new` that is no
  // field — an operator on a line of its own in a function, a property that a field's initializer ends in, a private name — has no member of a class begin at it, and a class whose head is not read leaves its field named `new` where it was.
  const refused = [
    ['a function expression for the base', `const registry = { Adapter: class extends function () {} {}, render() { ${element} } };`], ['an async function expression for the base', `const registry = { Adapter: class extends async function () {} {}, render() { ${element} } };`],
    ['an object literal for the base', `const registry = { Adapter: class extends {} {}, render() { ${element} } };`], ['a function expression after a class expression', `const registry = { Adapter: class extends class {}, function () {} {}, render() { ${element} } };`],
    ['a declaration with a function expression for the base', `class Q extends function () {} {}\nfunction implements() { ${element} }`], ['type arguments after the base', `const registry = { Adapter: class extends class {}<T> {}, render() { ${element} } };`],
    [`${HEAD_NESTING + 1} bases, one in the head of the other`, `const registry = { Adapter: ${chain(HEAD_NESTING + 1)}, render() { ${element} } };`],
    ['a field named `new` in a class whose base is a function expression', `class C extends function () {} { new\n  m() { ${element} } }`], ['a field named `new` in a class whose base is an object literal', `class C extends {} { new\n  m() { ${element} } }`],
    ['an operator `new` and a block on the next line', `function g() {\n  new Foo()\n  { ${element} }\n}`], ['an operator `new` that a line break separates from its name, and a block', `function g() {\n  new\n  Foo()\n  { ${element} }\n}`],
    ['a property named `new` that ends a field\'s initializer', `class C { a = x.new\n  render() { ${element} } }`], ['a private field named `new`', `class C { #new\n  render() { ${element} } }`],
  ];
  for (const [what, text] of refused) {
    const code = `${text}\n${CALL};`;
    assert.ok(cleanSourceFile(ts, code), `TypeScript parses ${what}`);
    assert.ok(guessesOf(code).length > 0, `${what}: a guess is named`);
    assert.deepStrictEqual(readPage(code).rewritten, [], `${what}: the call after it is not rewritten`);
  }
  // A chain of HEAD_NESTING bases is read, and so is a long list of class expressions that are no more than one deep.
  for (const [what, text] of [[`${HEAD_NESTING} bases, one in the head of the other`, `const registry = { Adapter: ${chain(HEAD_NESTING)}, render() { ${element} } };`], ['seven class expressions in a list', `const registry = { Adapter: class implements ${Array(7).fill('class {}').join(', ')} {}, render() { ${element} } };`]]) {
    const code = `${text}\n${CALL};`;
    assert.ok(cleanSourceFile(ts, code), `TypeScript parses ${what}`);
    assert.deepStrictEqual(guessesOf(code), [], `${what}: no guess`);
    assert.strictEqual(readPage(code).rewritten.length, 1, `${what}: the call after it is rewritten`);
  }
});

// A field named `new` that a line break ends is the name of a member, and the call on the next line is the head of a method, whose braces are its body: an element there is read for certain. After `extends`, `implements` or a comma of a heritage list the same words are the operator and an element
// of the list, whose braces hold members. What stands before the `new` tells them apart: a member of a class begins at the field — after the start of the body, a separator, a modifier or a decorator — and no keyword or comma of a heritage list is before it.
const NEW_FIELDS = ['new', 'static new', 'readonly new', 'declare new', 'public new', 'private new', 'protected new', 'abstract new', 'accessor new', 'override new', '@d new', '@d() new', '@a.b new', 'static readonly new', '@d static new'];
const NEW_FIELD_PLACES = [
  ['a class', (f, m) => `class C { ${f}\n  ${m} }`], ['a class expression', (f, m) => `const K = class { ${f}\n  ${m} };`], ['a class that extends a name', (f, m) => `class C extends B { ${f}\n  ${m} }`], ['a class that extends a call', (f, m) => `class C extends mixin(A) { ${f}\n  ${m} }`],
  ['a class that extends new', (f, m) => `class C extends new X() { ${f}\n  ${m} }`], ['a class that implements a call after a comma', (f, m) => `class C implements A, B() { ${f}\n  ${m} }`], ['an abstract class', (f, m) => `abstract class C { ${f}\n  ${m} }`],
  ['a class in a function', (f, m) => `function g() { class C { ${f}\n  ${m} } }`], ['the class of a property', (f, m) => `const o = { k: class { ${f}\n  ${m} }, l() { x; } };`], ['a class whose base is a class expression', (f, m) => `class C extends class {} { ${f}\n  ${m} }`],
  ['a class after a member', (f, m) => `class C { a() {}\n  ${f}\n  ${m} }`], ['a class after a field', (f, m) => `class C { a = 1;\n  ${f}\n  ${m} }`], ['a class after a static block', (f, m) => `class C { static { x; }\n  ${f}\n  ${m} }`],
  // What ends the member before the field, with no `;`: a name, a type, a modifier mark, a call, a bracket, a literal, a regex, a postfix operator and another field named `new`.
  ['a class after a field with no `;`', (f, m) => `class C { a = 1\n  ${f}\n  ${m} }`], ['a class after a typed field', (f, m) => `class C { a: string\n  ${f}\n  ${m} }`], ['a class after an optional field', (f, m) => `class C { a?: string\n  ${f}\n  ${m} }`], ['a class after a definite field', (f, m) => `class C { a!: string\n  ${f}\n  ${m} }`],
  ['a class after a call', (f, m) => `class C { a = g()\n  ${f}\n  ${m} }`], ['a class after an array', (f, m) => `class C { a = [1]\n  ${f}\n  ${m} }`], ['a class after a string', (f, m) => `class C { a = 'x'\n  ${f}\n  ${m} }`], ['a class after a template', (f, m) => `class C { a = \`x\`\n  ${f}\n  ${m} }`],
  ['a class after a regex', (f, m) => `class C { a = /x/\n  ${f}\n  ${m} }`], ['a class after an increment', (f, m) => `class C { a = x++\n  ${f}\n  ${m} }`], ['a class after a static field', (f, m) => `class C { static a\n  ${f}\n  ${m} }`], ['a class after a field named `new`', (f, m) => `class C { new\n  ${f}\n  ${m} }`],
  ['a comment before the line break', (f, m) => `class C { ${f} // c\n  ${m} }`], ['a comment that holds the line break', (f, m) => `class C { ${f} /* c\n */ ${m} }`], ['a CR LF', (f, m) => `class C { ${f}\r\n  ${m} }`], ['the initializer of a field', (f, m) => `class H { a = class C { ${f}\n  ${m} } }`],
];
const AFTER_NEW_FIELD = ['m() { B }', 'static m() { B }', 'async m() { B }', '*m() { B }', 'get m() { B }', 'set m(v) { B }', 'implements() { B }', 'extends() { B }', 'new() { B }', 'constructor() { B }', 'x = 1\n  m() { B }', '@d m() { B }'];
test('a class expression whose own head holds the braces of an object literal or of a function expression is no class that is complete: the heritage that holds it is read as it was, and the braces after the call that ends its list hold members', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  // The braces of an object literal or a function expression have no `class` of their own: a head that holds them is read to no `class`, and the `class` of the head that holds it is not theirs. A scan that took one for the other found the keyword of the outer class behind the
  // braces, took the inner class for a class that is complete, and read the comma after it back to the start of the source: a heritage that no list was found in, and the braces after the call that ends it for a function's body.
  const heritages = ['class A extends class extends {} {}, mixin(A)', 'class A extends B, class extends { a: 1 } {}, mixin(A)', 'class A extends class extends function () {} {}, mixin(A)', 'class A implements class extends {} {}, B()', 'class A extends class B extends class C extends {} {} {}, mixin(A)',
    'class A extends class extends async function () {} {}, mixin(A)', 'class A extends class extends {} {} implements (B)', 'class A extends new class extends {} {}, mixin(A)', 'class A extends class<T> extends { a: 1 } {}.x, mixin(A)', 'class A extends class extends {} {}, class extends {} {}, mixin(A)',
    'class A extends class extends B {}, class extends {} {}, mixin(A)', 'class A extends class implements class extends {} {} {}, mixin(A)', 'class A extends new @d class extends {} {}, mixin(A)'];
  let valid = 0;
  for (const heritage of heritages) {
    for (const wrap of [(c) => c, (c) => `const o = { a: ${c}, b: 1 };`, (c) => `function f() { ${c} }`, (c) => `class H { a = ${c} }`, (c) => `f(${c});`]) {
      const code = pageOf(wrap(`${heritage} { delete<U>(y: U): MARK {} }`), 'U');
      if (!cleanSourceFile(ts, code)) continue;
      valid += 1;
      assertRead(code, 'exact', visible(heritage));
      assert.ok(readsAsCode(code), `${visible(heritage)}: the method is code`);
    }
  }
  assert.ok(valid >= 40, `${valid} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages valid to TypeScript`);
});

test('a field named `new` that a line break ends, whatever modifier or decorator it has and wherever its class stands, is no operator: the braces of the method after it are its body, and an element in it is read for certain', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const bodies = ['void <span>(MARK); // details</span>;', 'return <>(MARK) // details</>;', 'x;\nvoid <span>(MARK); // note</span>;', 'const e = <in U>(MARK); // note</in>;'];
  let valid = 0;
  for (const field of NEW_FIELDS) {
    for (const [place, frame] of NEW_FIELD_PLACES) {
      for (const method of AFTER_NEW_FIELD) {
        for (const body of bodies) {
          const code = `${frame(field, method.replace('B', body))}\n${CALL};`;
          if (!cleanSourceFile(ts, code)) continue;
          valid += 1;
          const label = `${place} / ${visible(field)} / ${visible(method)} / ${visible(body)}`;
          assert.deepStrictEqual(guessesOf(code), [], `${label}: no guess`);
          assert.ok(!readsAsCode(code), `${label}: the text of the element is text`);
          assert.strictEqual(readPage(code).rewritten.length, 1, `${label}: the call after it is rewritten`);
        }
      }
    }
  }
  assert.ok(valid >= 1500, `${valid} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages valid to TypeScript`);
});

test('the operator `new` of an element of a heritage list, with line breaks around it and after the keyword or the comma, is no field: the braces after its call hold members, in a class too, where a member begins after the keyword that a line break follows', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const heritages = CLASS_HERITAGES.filter((heritage) => /\bnew\b/.test(heritage));
  assert.ok(heritages.length >= 20, `${heritages.length} heritages with a new`);
  let valid = 0;
  for (const heritage of heritages) {
    // The braces of a class around the head are where a field named `new` stands, and after `implements` and a line break a member may begin as far as the line break is concerned; the keyword and the comma are what the field's reading must look at.
    for (const [place, wrap] of [['no wrap', (c) => c], ['a field\'s initializer', (c) => `class H { a = ${c} }`], ['a field\'s initializer after a field', (c) => `class H { b = 1\n  a = ${c} }`], ['a static field\'s initializer', (c) => `class H { static a = ${c} }`],
      ['the value of a property in a class', (c) => `class H { make() { return { a: ${c}, b: 1 }; } }`], ['a function', (c) => `function f() { ${c} }`]]) {
      for (const member of ['delete<T>(x: MARK): void {}', 'void<T>(x: MARK): void {}', 'a = 1;\n  delete<T>(x: MARK): void {}']) {
        const code = pageOf(wrap(`${heritage} { ${member} }`), 'T');
        if (!cleanSourceFile(ts, code)) continue;
        valid += 1;
        assertRead(code, 'exact', `${place} / ${visible(heritage)} / ${visible(member)}`);
        assert.ok(readsAsCode(code), `${place} / ${visible(heritage)} / ${visible(member)}: the method is code`);
      }
    }
  }
  assert.ok(valid >= 200, `${valid} pages are valid to TypeScript`);
  t.diagnostic(`${valid} pages valid to TypeScript`);
});
