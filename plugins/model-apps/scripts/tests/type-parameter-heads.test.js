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
const { opensTypeParameters, blankNonCodePreservingTemplateExpressions, TYPE_PARAMETER_MODIFIERS, MEMBER_NAME_OPERATORS, MEMBER_PREFIX_WORDS, OPERATOR_WORD_ENDS_MEMBER_AFTER, OPERATOR_WORDS_THAT_ARE_NAMES } = require('../lib/source-literals.js');
const { resolvePageRefs, navigationFrontier } = require('../lib/pageref-resolver.js');
const { loadTypescriptOracle, loadBaseLexer } = require('./helpers/typescript-oracle.js');
const { cleanSourceFile, readingAt, isElement, tokenVocabulary } = require('./helpers/angle-frames.js');
const { NEWLINE_GAPS, DECORATED_PLACES, UNREADABLE_LISTS, UNREADABLE_HEADS, ESCAPED_HEADS, ESCAPE_PLACES, ESCAPE_GAPS, CLASS_HERITAGES } = require('./helpers/type-head-pages.js');

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
  '@function(){}', '@class {}', '@async', '@static', '@a.static', '@readonly', '@get', '@\\u0064ec', '@dec(\n1,\n2\n)', '@dec(() => { return 1; })', '@dec({ a: 1, b: [1, 2] })', '@dec("a;b", \'c,d\')', '@dec(`x${y}`)', '@dec(/x/)', '@dec() @dec2()', '@dec @dec2', '@dec static', '@dec static async', '@dec async *',
  '@dec readonly', '@dec get', '@dec public', '@dec override', '@dec accessor', '@dec declare', '@dec abstract', '@dec in', '@dec out', '@dec export', '@dec const', '@dec(a => a)', '@dec(a ? b : c)', '@dec(a, b)', '@dec(a = 1)', '@dec(typeof x)', '@dec(void 0)'];
const DECORATED_FRAMES = [
  (d, w) => `class C { ${d} ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { m() {} ${d} ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { x = 1; ${d} ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { x = 1\n ${d} ${w}<U>(y: U): MARK {} }`, (d, w) => `class C { ${d}\n ${w}<U>(y: U): MARK {} }`,
  (d, w) => `abstract class C { ${d} abstract ${w}<U>(y: U): MARK; }`, (d, w) => `const K = class { ${d} ${w}<U>(y: U): MARK {} };`, (d, w) => `declare class C { ${d} ${w}<U>(y: U): MARK; }`,
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
