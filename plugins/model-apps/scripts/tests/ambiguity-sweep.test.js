'use strict';
// A differential sweep of the navigation reader's trust boundary.
//
// The reader finds navigation calls in a mask made by a lexer that has no parser, and rewrites the PAGEREF_ token in each call it finds.
// Where the lexer decides by guess what a `/` or `<` is (source-literals.js, `onAmbiguity`), a wrong guess hides a real call or turns text
// into one, and a rewrite then changes what the page does. The reader refuses every token at or after the first guess (the trust
// frontier), and reads the resolved copy once more as plain text (the residual net). The claim under test is:
//
//     a page that is not refused is resolved correctly: it does what the original did, except each token is its page id.
//
// This file states it as a property and enumerates programs against it — a construct that makes the lexer guess, then a payload that holds a
// token, in every combination that matters. Pages in plain JavaScript are RUN, original and resolved, and compared: what each navigates to,
// the strings it logs, the regexes it runs. Pages that need TypeScript to read (JSX type arguments, generic casts) are checked against the
// TypeScript parser where it is available (TYPESCRIPT_ORACLE_PATH, see helpers/typescript-oracle.js): it says which calls are real, and the
// reader must rewrite exactly those or refuse the page. Refusing is always allowed — it fails closed — so a sweep that only refused would
// pass; the vacuity guards say how many pages were accepted and that every kind of guess was exercised.
//
// A second sweep puts EVERY punctuator and keyword TypeScript has in front of a `<` — in every frame where it can stand — and checks the same claim where
// the page holds a regex that TypeScript reads and the lexer must not read as code (tests/helpers/angle-frames.js). The sweeps after it ask the same of
// the places where a lexer's idea of white space, or of the `>` that ends a list of type arguments, can differ from TypeScript's: every closed list of type
// arguments or tag immediately before every token and a `<`; every character TypeScript skips between a token and a `<` or a `/`, and in the head of a
// statement; and a `*` before a `<` in every place TypeScript reads one.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadTypescriptOracle, loadBabelOracle, loadBaseLexer } = require('./helpers/typescript-oracle.js');
const { tokenVocabulary, programsFor, cleanSourceFile, readingAt, isElement, REGEX_BODY, AFTER_WITH_CALL, CONTINUATIONS, FRAMES, PRODUCER_FRAMES, TRIVIA_SEPARATORS, SIGNATURE_FRAMES, SIGNATURE_ENDINGS, HIDING_ENDINGS, CERTAIN_ELEMENTS, GUESSED_ELEMENTS, HIDDEN_TEXT_ELEMENTS, UNREAD_LIST_ELEMENTS, MEMBER_ELEMENT_FRAMES, NO_MEMBER_ELEMENT_FRAMES, valuedKeywordElements, DECOYS, signaturePages, elementPages, ELEMENT_FRAMES, elementPage, signaturePage, failingLists, LEFT_LISTS, EXACT_DEFAULTS, defaultLists, exactDefaultLists, commentedDefaultLists, commentedConstraintLists, commentedMemberEndings, commentedArrowContinuations, PROSE_SHAPED_LINES, PROSE_OPEN_LINES, PROSE_HIDING_ELEMENTS, PROSE_HIDING_ENDINGS, PROSE_TYPE_ENDINGS, proseElements } = require('./helpers/angle-frames.js');
const { AMBIGUITY_KINDS, blankNonCodePreservingTemplateExpressions } = require('../lib/source-literals.js');
const { extractNavTargets, resolvePageRefs, strayPageRefs, navMalformedRefs, reverseResolveNavIdsReport, navigationFrontier } = require('../lib/pageref-resolver.js');
const { LONG_KEY, MISREAD_PAGES, ELEMENT_AFTER_OPERATOR_PAGES, ELEMENT_LOOKALIKE_PAGES, FUNCTION_TYPE_PAGES } = require('./helpers/misread-page.js');
const { ANY_SPACE } = require('./helpers/jsx-element-fuzz.js');
const { numberedMemberPages, nestedTextPages, expressionLinePages, literalTagPages, nestedSoupPages, nestedCodePages, nestedTagPages, nestedPairPages, taggedStringPages, importTypePages, accessorNamePages } = require('./helpers/hidden-closing-pages.js');

const ID = '11111111-1111-4111-8111-111111111111';
const CALL = 'navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});';
// The text of a call, for a place where it is data: the body of a regex. A lexer that reads the regex as code takes it for a call and rewrites
// its token, which changes what the regex matches.
const BODY = 'navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})';

// An `if` whose head holds one call and a comment sized so that the head, from its `(` to its `)`, is 1,960 characters long.
function edgeHead() {
  const build = (pad) => `if (/*${'x'.repeat(pad)}*/ ${BODY} && 1) /ab+c/.test("x");`;
  const base = build(0);
  return build(1960 - (base.indexOf(') /ab+c/') - base.indexOf('(')));
}

// What makes the lexer guess, one construct per kind it can be run in JavaScript, and shapes it reads with certainty. `kind` is the ambiguity it
// must report, or null. Each is valid JavaScript; the names are unique per construct, so any two can share a page. The `/\/*$/` is what turns a
// misread into a hidden call: a false regex ends at its first `/`, and the `/*` after that opens a comment over what follows. `clean: false` marks
// a construct that holds a token where it is data (the body of a regex): a page that has one is refused whatever the lexer reads, and one that
// is accepted would have had the token rewritten in text.
const JS_CONSTRUCTS = [
  { name: 'nothing', kind: null, code: '' },
  { name: 'a division after an object literal', kind: 'brace', code: 'const n1 = {valueOf(){return 12;}}/2; const r1 = /\\/*$/;' },
  { name: 'a regex after a block', kind: 'brace', code: 'if (true) { }\n/ab+c/.test("x");' },
  { name: 'a regex after a parenthesis out of reach', kind: 'paren', code: `if (true /*${'x'.repeat(2100)}*/) /x+/.test("y");` },
  { name: 'a division by a name that can be a keyword', kind: 'keyword', code: 'const of = 12; const n2 = of/2; const r2 = /\\/*$/;' },
  { name: 'an identifier written with an escape', kind: 'identifier', code: 'var a\\u0062 = 1; var n3 = a\\u0062/2; var r3 = /\\/*$/;' },
  { name: 'a regex after a spread', kind: 'operator', code: 'var s1 = [.../ab/.exec("ab")];' },
  { name: 'a regex after three signs', kind: 'operator', code: 'var i3 = 1; var n4 = i3+++/x/.test("x");' },
  { name: 'an ordinary division', kind: null, code: 'const t5 = 10; const n5 = t5 / 2; const r5 = /\\/*$/;' },
  { name: 'a parenthesised object divided', kind: null, code: 'const n6 = ({valueOf(){return 12;}}) / 2; const r6 = /\\/*$/;' },
  { name: 'a regex after a block ended by a semicolon', kind: null, code: 'if (true) { };\n/ab+c/.test("x");' },
  // A division on the line after its operand: ASI could have ended the statement there (in a type context it does), so it is a guess.
  { name: 'a division on the next line', kind: 'newline', code: 'const t7 = 10;\nconst n7 = t7\n/ 2; const r7 = /\\/*$/;' },
  // ASI and the restricted productions (ECMA-262 §12.10.1): after a line break a `!`, `++` or `--` is a prefix operator, and `break`, `continue`
  // and `return` end their statements, so a `/` after any of them is a regex. Each reading is certain, so a page that holds one is accepted; the
  // variants that hold a call in the regex hold a token in text, and a lexer that read the `/` as a division would rewrite it.
  { name: 'a regex after a "!" on the next line', kind: null, code: 'const b1 = 1;\nb1\n!/ab+c/.test("x");' },
  { name: 'a regex holding a call after a "!" on the next line', kind: null, clean: false, code: `const b2 = 1;\nb2\n!/${BODY}/.test("x");` },
  { name: 'a regex holding a backtick after a "!" on the next line', kind: null, code: 'const b3 = 1;\nb3\n!/`/.test("x");' },
  { name: 'a regex after a "++" on the next line', kind: null, code: 'let i1 = 0;\ni1\n++/ab+c/.lastIndex;' },
  { name: 'a regex holding a call after a "++" on the next line', kind: null, clean: false, code: `let i2 = 0;\ni2\n++/${BODY}/.lastIndex;` },
  { name: 'a regex after a "--" where an expression starts', kind: null, code: 'var d1 = --/ab+c/.lastIndex;' },
  { name: 'a regex holding a call after a "--" where an expression starts', kind: null, clean: false, code: `var d2 = --/${BODY}/.lastIndex;` },
  { name: 'a regex after "break" on the next line', kind: null, code: 'for (var k1 = 0; k1 < 1; k1 += 1) {\n  if (k1 === 0) break\n  /ab+c/.test("x");\n}' },
  { name: 'a regex holding a call after "break" on the next line', kind: null, clean: false, code: `for (var k2 = 0; k2 < 1; k2 += 1) {\n  if (k2 === 0) break\n  /${BODY}/.test("x");\n}` },
  { name: 'a regex after "continue" on the next line', kind: null, code: 'for (var k3 = 0; k3 < 1; k3 += 1) {\n  if (k3 === 0) continue\n  /ab+c/.test("x");\n}' },
  { name: 'a regex holding a call after "continue" on the next line', kind: null, clean: false, code: `for (var k4 = 0; k4 < 1; k4 += 1) {\n  if (k4 === 0) continue\n  /${BODY}/.test("x");\n}` },
  { name: 'a regex after "return" on the next line', kind: null, code: 'function f1() {\n  return\n  /ab+c/.test("x");\n}\nf1();' },
  { name: 'a regex holding a call after "return" on the next line', kind: null, clean: false, code: `function f2() {\n  return\n  /${BODY}/.test("x");\n}\nf2();` },
  { name: 'a regex after "throw" on the same line', kind: null, code: 'try { throw /ab+c/; } catch (e1) { }' },
  { name: 'a regex holding a call after "throw" on the same line', kind: null, clean: false, code: `try { throw /${BODY}/; } catch (e2) { }` },
  // A postfix `++` on the line of its operand, and a division by it: an operand, so a division.
  { name: 'a division after a postfix "++"', kind: null, code: 'let i4 = 4;\nconst n8 = i4++ / 2; const r8 = /\\/*$/;' },
  // A statement head whose `(` is 1,960 characters before its `)`: inside the 2,000-character look-behind as written and as deployed (the id is
  // longer than the token), and outside it where reverse resolution writes a token of a long key — which the reverse sweep below meets.
  { name: 'a statement head just inside the look-behind', kind: null, code: edgeHead() },
  // A call inside the pageId expression of another: with a token in it the outer value is malformed (a page the build halts on, so never accepted),
  // and reverse resolution must not write the token there, whatever the lexer reads — it is the token of a call it trusts, in a value it does not.
  { name: 'a call inside the pageId expression of another', kind: null, clean: false, code: `navigateTo({pageType:"generative", pageId:[${BODY}][0]});` },
];

// Constructs that need TypeScript to read: a division after type arguments, a JSX element with string type arguments, and the rest of the
// kinds. `kind: null` is a shape the lexer reads with certainty, which the shipped samples use.
const TS_CONSTRUCTS = [
  { name: 'a division after a qualified generic cast', kind: 'angle', code: 'const total = 10; const h1 = total as Types . Alias<number> / 2; const r7 = /\\/*$/;' },
  { name: 'a division after a cast to an escaped type name', kind: 'identifier', code: 'const total = 10; const h2 = total as Al\\u0069as<number> / 2; const r8 = /\\/*$/;' },
  { name: 'a JSX element with a string type argument', kind: 'jsx-type-arguments', code: 'const el1 = <Component<"quote\\"\\\n/*"> onClick={() => 1} />;' },
  { name: 'a JSX element with a space after the <', kind: 'jsx-open', code: 'const el2 = < div>x</div>;' },
  // A JSX attribute string that follows white space or a comment after its `=` is a JavaScript string to TypeScript, with escapes, and a JSX string — no escapes — to every other compiler: where
  // a backslash makes the two end at different quotes it is a guess, and where they end together, or the quote follows the `=` at once, it is not.
  { name: 'a JSX attribute string after white space, whose backslash-quote ends it elsewhere', kind: 'jsx-attribute', code: "const el9 = <C x= '\\'/>;const q9 = 1;//' />;" },
  { name: 'a JSX attribute string after a comment, whose backslash-quote ends it elsewhere', kind: 'jsx-attribute', code: 'const el10 = <C x=/* c */ "\\"/>;const q10 = 1;//" />;' },
  { name: 'a JSX attribute string after white space, with an escape that does not move its end', kind: null, code: 'const el11 = <C x= "c\\n" y= \'\\\\\' />;' },
  { name: 'a JSX attribute string right after the =, with a backslash before its quote', kind: null, code: 'const el12 = <C x="a\\" y=\'b\\\' />;' },
  // `<Name>` and a parameter list, then `:`: a call signature in a type, or an element whose text starts with a parenthesis — both compile, and only a
  // parser that knows the context can tell them apart, so it is a guess; it is read as an element, which is what a TSX expression would make it.
  { name: 'a call signature with type parameters', kind: 'generic', code: 'interface Callable1 {\n  <T>(x: T): T;\n}' },
  { name: 'an element whose text starts with a parenthesis and a colon', kind: 'generic', code: 'const el6 = <span>(required): Name</span>;' },
  { name: 'a function type in an annotation, with a parameter list too long to scan', kind: 'generic', code: `const long2: <T>(${Array.from({ length: 300 }, (_, n) => `p${n}: number`).join(', ')}) => T = f;` },
  // `<Name>` and a parameter list, then `=>`: a generic function type, for certain wherever it stands — a `>` in JSX text does not compile (TS1382), so it
  // is no element — and directly after `type Name =` at a statement start whatever follows.
  { name: 'a function type in an annotation', kind: null, code: 'const annotated1: <T>(x: T) => T = f;' },
  { name: 'a function type as a parameter type', kind: null, code: 'function takes1(cb: <U>(x: U) => void) {}' },
  { name: 'a generic function type in a member', kind: null, code: 'interface Props1 { onPick: <K>(key: K) => void; }' },
  { name: 'a function type after a type alias with type parameters', kind: null, code: 'type Fn6<A> = <T>(x: T) => A;' },
  { name: 'a function type in a type literal', kind: null, code: 'let holder2: { cb: <T>(x: T) => void };' },
  { name: 'a generic function type directly after a type alias head', kind: null, code: 'type Fn1 = <T>(x: T) => T;' },
  { name: 'a function type after an exported type alias head', kind: null, code: 'export type Fn2 = <T>(x: T) => T;' },
  { name: 'a function type after a declared type alias head', kind: null, code: 'declare type Fn3 = <T>(x: T) => T;' },
  { name: 'a function type after a type alias head in a block', kind: null, code: 'function holder1() { type Fn4 = <T>(x: T) => T; return 1; }' },
  { name: 'a function type after a type alias head that follows a line break', kind: null, code: 'const sep1 = 1\ntype Fn5 = <T>(x: T) => T;' },
  { name: 'a function type with a parameter list too long to scan, after a type alias head', kind: null, code: `type Long1 = <T>(${Array.from({ length: 300 }, (_, n) => `p${n}: number`).join(', ')}) => T;` },
  // `<Name>(…) =>` is a function type for certain wherever the element reading of its text cannot parse: a `>` in the text of an element's children is TS1382, a `}` is
  // TS1381, and a container that starts with a name and a colon, a `<` and a character that cannot start a tag, or a tag name and a token that is no attribute are
  // errors too. What the reading cannot rule out — here, an arrow inside an attribute string, which has no escapes — is a guess, read as a type.
  { name: 'an element whose nested element holds an arrow in an attribute string', kind: 'generic', code: 'const el7 = <Wrapper>(<Child x="\\" y=") =>" />)</Wrapper>;' },
  { name: 'a function type whose parameter list holds a type argument', kind: null, code: 'const arr1: <T>(x: Array<T>) => T = f;' },
  { name: 'a function type with an object type in its list, directly after a type alias head', kind: null, code: 'type Fn8 = <T>(o: { a: T }) => T;' },
  // The generic function types that a rule asking only for a `<` or `{` before the arrow refused as truncated: a type argument, an object type, a comma between
  // type arguments, nested type arguments, an optional member, a string with a backslash-quote.
  { name: 'a function type member with a type argument', kind: null, code: 'interface ListProps2 { renderItem: <T>(item: Array<T>) => React.ReactNode; }' },
  { name: 'a function type annotation with a type argument, then an initializer', kind: null, code: 'const pick2: <T>(items: Array<T>) => T = (items) => items[0];' },
  { name: 'a function type after a type alias with type parameters, with a type argument', kind: null, code: 'type Fn9<A> = <T>(x: Array<T>) => A;' },
  { name: 'a function type annotation with an object type', kind: null, code: 'const fmt2: <T>(value: { label: T }) => string = (v) => String(v.label);' },
  { name: 'a function type as a parameter type, with a type argument', kind: null, code: 'function apply2(cb: <T>(x: Promise<T>) => void) { return cb; }' },
  { name: 'a function type in a type literal, with a type argument', kind: null, code: 'type Props2 = { onPick: <T>(x: Array<T>) => void };' },
  { name: 'a function type annotation with two type arguments', kind: null, code: 'let holder3: <T>(m: Record<string, T>) => T[];' },
  { name: 'a function type with nested type arguments', kind: null, code: 'let holder4: <T>(m: Promise<Array<Record<string, T>>>) => void;' },
  { name: 'a function type with an optional member', kind: null, code: 'let holder5: <T>(o: { a?: T; b: string }) => void;' },
  { name: 'a function type with a string type that holds a backslash-quote', kind: null, code: 'let holder6: <T>(x: "a\\"b", y: T) => void;' },
  // The first name after a `<` is an identifier to TypeScript except `await` in an async function and `yield` in a generator, which the lexer does not track.
  { name: 'an element named await in an async function', kind: 'generic', code: 'async function probe1() { const e1 = <await extends SomeType>text</await>; return e1; }' },
  { name: 'an element named yield in a generator', kind: 'generic', code: 'function* probe2() { const e2 = <yield extends SomeType>text</yield>; return e2; }' },
  { name: 'a generic arrow named await outside an async function', kind: 'generic', code: 'function probe3() { const e3 = <await extends SomeType>(x: await) => x; return e3; }' },
  // The token before a `<`: after a unary or binary operator it is an element whatever follows its name (certain); where both an element and a generic compile it
  // is a guess.
  { name: 'an element after "==="', kind: null, code: 'const q1 = a === <T extends X>text</T>;' },
  { name: 'an element after "!=="', kind: null, code: 'const q2 = a !== <T extends X>text</T>;' },
  { name: 'an element after "<="', kind: null, code: 'const q3 = a <= <T extends X>text</T>;' },
  { name: 'an element after "<<" and a space', kind: null, code: 'const q4 = a << <T extends X>text</T>;' },
  { name: 'an element after "typeof"', kind: null, code: 'const q5 = typeof <T extends X>text</T>;' },
  { name: 'an element after "delete"', kind: null, code: 'delete <T extends X>text</T>;' },
  { name: 'an element after "instanceof"', kind: null, code: 'const q6 = a instanceof <T extends X>text</T>;' },
  { name: 'an element after "void"', kind: null, code: 'void <T extends X>text</T>;' },
  { name: 'an element after ">="', kind: 'operator', code: 'const g1 = a >= <T extends X>text</T>;' },
  { name: 'an element after a "<"', kind: 'operator', code: 'const g2 = a < <T extends X>text</T>;' },
  { name: 'an element after "in"', kind: 'operator', code: 'const g3 = "k" in <T extends X>text</T>;' },
  { name: 'an element after "void" and a line break', kind: 'newline', code: 'void\n<T extends X>text</T>;' },
  // A `<` where an expression starts is a generic arrow's type parameters only by TypeScript's rule for TSX: after an optional `const` and the
  // first name, a `,` or `=`, or `extends` and then a token that is not `=`, `>` or `/`. Everything else is an element, and text in it is text.
  { name: 'a generic arrow with a trailing comma', kind: null, code: 'const id1 = <T,>(x: T) => x;' },
  { name: 'a generic arrow with a constraint', kind: null, code: 'const id2 = <T extends unknown>(x: T) => x;' },
  { name: 'a generic arrow with a const parameter', kind: null, code: 'const id3 = <const T,>(x: T) => x;' },
  { name: 'a generic arrow with a default', kind: null, code: 'const id4 = <T = string,>(x: T): T => x;' },
  { name: 'a generic arrow as an argument', kind: null, code: 'const mapped1 = [1].map(<T,>(x: T) => x);' },
  { name: 'an element whose text looks like parameters', kind: null, code: 'const el5 = <div data-active={true}>(a): Title</div>;' },
  // The page that a lexer which looked for a parameter list and a later `=>` got wrong: it took `<div …>` for type parameters and `(a): Title` for
  // parameters, and read the regex after the second arrow as code.
  { name: 'text that looks like parameters, then a regex holding a call', kind: null, clean: false, code: `const isVisible1 = (node: any) => !!node.props["data-active"];\nconst check1 = isVisible1(<div data-active={enabled}>(a): Title</div>) ? (() => /${BODY}/.test(text)) : (() => false);` },
  { name: 'a shift before a name', kind: 'operator', code: 'const sh = 1<<n; const r9 = /\\/*$/;' },
  { name: 'a JSX element with type arguments that are names', kind: null, code: 'const el3 = <DataGridRow<Row> key={1}>x</DataGridRow>;' },
  { name: 'a comparison of names', kind: null, code: 'const c1 = a < b; const c2 = a > b;' },
  // A type context ends a statement at a line break where an expression continues it, so what follows is a regex or an element there and a
  // division or a comparison here: a guess (`newline`).
  { name: 'a regex after a type alias with no semicolon', kind: 'newline', code: 'type Value1 = number\n/ab+c/.test("x"); const r10 = /\\/*$/;' },
  { name: 'a regex holding a call after a type alias with no semicolon', kind: 'newline', clean: false, code: `type Value2 = number\n/${BODY}/.test("x");` },
  { name: 'a regex after an annotated declaration with no semicolon', kind: 'newline', code: 'let n10: number\n/ab+c/.test("x");' },
  { name: 'a regex holding a call after an overload signature with no semicolon', kind: 'newline', clean: false, code: `declare function f10(x: number)\n/${BODY}/.exec("x");` },
  { name: 'an element after a type alias with no semicolon', kind: 'newline', code: 'type Value3 = number\n<div>x</div>;' },
  // The words that start an expression, in the places only TypeScript or a module reads: a regex after each.
  { name: 'a regex after export default', kind: null, code: 'export default /ab+c/;' },
  { name: 'a regex after extends', kind: null, code: 'class Extender extends /ab+c/ {}' },
  { name: 'a division after a non-null assertion on the line of its operand', kind: null, code: 'const total2: number | undefined = 10; const h3 = total2! / 2; const r11 = /\\/*$/;' },
  { name: 'a regex after a "!" on the next line, as TypeScript reads it', kind: null, code: 'const total3: number | undefined = 10;\ntotal3\n!/ab+c/.test("x");' },
];

// What may follow a construct. `clean` payloads are what a page the reader reads with certainty may hold and still be accepted: a real call,
// a template line that starts with `//` and holds a call. The others hold a token where it ships as data or sits in what only looks like inert
// text — they are refused, or (after a guess) refused for a reason the report names. `text of a call in …` is what a misreading lexer takes for
// a call. No comment may hold a token, whatever line it starts: a template literal can start a line with `//` and run what follows.
const JS_PAYLOADS = [
  { name: 'a real call', clean: true, code: CALL },
  { name: 'a real call after a block comment', clean: true, code: `/* note */ ${CALL}` },
  { name: 'a // comment that says what a call looks like', clean: true, code: '// navigateTo({pageType:"generative", pageId:"help-text"});' },
  { name: 'a template line that starts with // and holds a call', clean: true, code: 'log(`\n// ${navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})}\n`);' },
  { name: 'a token in a // comment on its own line', clean: false, code: '// PAGEREF_detail is replaced at deploy' },
  { name: 'a token in a template line that starts with //, outside the substitution', clean: false, code: 'log(`\n// PAGEREF_detail\n`);' },
  { name: 'the text of a call in a string', clean: false, code: 'log(\'*/ navigateTo({pageType:"generative", pageId:"PAGEREF_detail"}) /*\');' },
  { name: 'the text of a call in a regex', clean: false, code: '/navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})/.test("x");' },
  { name: 'a token in a trailing comment', clean: false, code: 'log(1); // PAGEREF_detail' },
  { name: 'a token in a block comment on its own line', clean: false, code: '/* PAGEREF_detail */' },
  { name: 'a token in a string', clean: false, code: 'log("PAGEREF_detail");' },
  { name: 'no token at all', clean: true, code: 'log(2);' },
];
const TS_PAYLOADS = [
  ...JS_PAYLOADS,
  { name: 'a real call in a JSX attribute', clean: true, code: 'const el4 = <Button onClick={() => navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})} />;' },
  { name: 'a real call with type-only casts', clean: true, code: 'navigateTo({pageType:"generative" as const, pageId:"PAGEREF_detail" as const});' },
];

// A guess INSIDE a call's options object, with a member after it that can make `pageType` something else at run time: a getter, a computed key,
// a spread. The members after a guess are not read for certain, so the call is not trusted — its token is not rewritten, though it lies before
// the guess — and a page that is accepted must have its generative calls rewritten and every other call as it was. With the guess before the
// `pageId` the false comment it opens covers the `pageId` itself. Each page also holds a real call after the object.
const NEST_PREAMBLE = 'const typeKey = "pageType"; const of = 12; const override = { pageType: "entityrecord" }; const flag = false;';
const NEST_GUESSES = [
  { name: 'a division after an object literal', kind: 'brace', code: 'data: {valueOf(){return 12;}}/2, r: /\\/*$/,' },
  { name: 'a division by a name that can be a keyword', kind: 'keyword', code: 'data: of/2, r: /\\/*$/,' },
  { name: 'no guess', kind: null, code: 'data: 12 / 2, r: /\\/*$/,' },
];
const NEST_OVERRIDES = [
  { name: 'a getter under a computed key', code: 'get [typeKey]() { return flag ? "generative" : "entityrecord"; }', overrides: true },
  { name: 'a computed key', code: '[typeKey]: "entityrecord"', overrides: true },
  { name: 'a spread', code: '...override', overrides: true },
  { name: 'a getter', code: 'get pageType() { return "entityrecord"; }', overrides: true },
  { name: 'a plain member', code: 'extra: 1', overrides: false },
];
const NEST_SHAPES = [
  { name: 'the pageId before the guess', build: (guess, override) => `navigateTo({ pageType: "generative", pageId: "PAGEREF_detail",\n  ${guess.code}\n  ${override.code}\n  /* regular comment */ });` },
  { name: 'the pageId after the guess', build: (guess, override) => `navigateTo({ pageType: "generative",\n  ${guess.code}\n  pageId: "PAGEREF_detail",\n  ${override.code}\n  /* regular comment */ });` },
];
function nestedPrograms() {
  const out = [];
  for (const guess of NEST_GUESSES) {
    for (const override of NEST_OVERRIDES) {
      for (const shape of NEST_SHAPES) {
        const code = `${NEST_PREAMBLE}\n${shape.build(guess, override)}\n${CALL}\n`;
        // Read right, with no guess and no override, the call is trusted and the page is accepted.
        out.push({ label: `${shape.name} / ${guess.name} / ${override.name}`, code, certain: guess.kind === null && !override.overrides && shape === NEST_SHAPES[0], kinds: guess.kind ? [guess.kind] : [], constructs: [] });
      }
    }
  }
  return out;
}

// The shapes a program takes: a construct then a payload; a call, a construct, then a payload (a call that is read before the guess and one
// after it); two constructs then a payload; and a payload, a construct, a payload.
function programsOf(constructs, payloads, { callFirst }) {
  const guessing = constructs.filter((c) => c.kind !== null);
  const out = [];
  for (const c of constructs) for (const p of payloads) out.push({ label: `${c.name} / ${p.name}`, parts: [c, p] });
  for (const c of constructs) for (const p of payloads) out.push({ label: `${callFirst.name} / ${c.name} / ${p.name}`, parts: [callFirst, c, p] });
  for (let i = 0; i < guessing.length; i += 1) {
    for (let j = i + 1; j < guessing.length; j += 1) for (const p of payloads) out.push({ label: `${guessing[i].name} / ${guessing[j].name} / ${p.name}`, parts: [guessing[i], guessing[j], p] });
  }
  return out.map((program) => ({
    label: program.label,
    code: `${program.parts.map((part) => part.code).join('\n')}\n`,
    // Read with certainty, and holding no token in text: such a page is accepted. A payload names no kind of guess, which is none.
    certain: program.parts.every((part) => (part.kind ?? null) === null && part.clean !== false),
    constructs: program.parts.filter((part) => constructs.includes(part)).map((part) => part.name),
  }));
}

// Everything the page does that a rewrite could change: where it navigates (and as what), what it logs, and the source of every regex it runs.
function run(code) {
  const calls = [];
  const logs = [];
  const tested = [];
  const context = vm.createContext({ navigateTo: (options) => calls.push([options.pageType, options.pageId]), log: (value) => logs.push(value), __tested: tested });
  vm.runInContext('RegExp.prototype.test = function () { __tested.push(this.source); return false; };', context);
  vm.runInContext(code, context, { timeout: 2000 });
  return { calls, logs, tested };
}

const refusal = (code) => {
  const resolved = resolvePageRefs(new Map([['page', { code }]]), new Map([['detail', ID]]));
  const strays = strayPageRefs(code);
  const guess = strays.find((r) => r.frontier);
  return { refused: strays.length > 0 || resolved.residual.length > 0 || resolved.unresolved.length > 0, kind: guess ? guess.frontier.kind : null, resolved };
};

// The calls TypeScript sees in a parsed page: `navigateTo({ pageType: "generative", pageId: "PAGEREF_…" })`, by the span of the pageId literal — and only where
// every member is a plain `name: value` one: a getter, a computed key or a spread can make the call something else at run time.
function navigationLiteralSpans(ts, source) {
  const unwrap = (node) => {
    while (ts.isAsExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  const spans = [];
  const plainName = (property) => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name));
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo' && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      const properties = node.arguments[0].properties;
      const values = new Map();
      if (properties.every(plainName)) for (const property of properties) values.set(property.name.text, unwrap(property.initializer));
      const type = values.get('pageType');
      const id = values.get('pageId');
      if (type && ts.isStringLiteral(type) && type.text === 'generative' && id && ts.isStringLiteral(id) && /^PAGEREF_/.test(id.text)) spans.push(`${id.getStart(source)}-${id.getEnd()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return spans.sort();
}

test('sweep (JavaScript, run): a page that is not refused does what the original did, with each token its page id', (t) => {
  const programs = [...programsOf(JS_CONSTRUCTS, JS_PAYLOADS, { callFirst: JS_PAYLOADS[0] }), ...nestedPrograms()];
  const kindsRefused = new Set();
  const falseRefusals = [];
  const acceptedWith = new Set();
  let accepted = 0;
  for (const program of programs) {
    const original = run(program.code);
    const { refused, kind, resolved } = refusal(program.code);
    if (kind) kindsRefused.add(kind);
    if (refused) {
      if (program.certain) falseRefusals.push(program.label);
      continue;
    }
    accepted += 1;
    for (const name of program.constructs) acceptedWith.add(name);
    const after = run(resolved.deployment.get('page'));
    // A call is a generative navigation by what it is at RUN time: only those have their token rewritten, and every other call is as it was.
    assert.deepStrictEqual(after.calls, original.calls.map(([type, id]) => [type, type === 'generative' && id === 'PAGEREF_detail' ? ID : id]), `${program.label}: where it navigates`);
    assert.deepStrictEqual(after.logs, original.logs, `${program.label}: what it logs`);
    assert.deepStrictEqual(after.tested, original.tested, `${program.label}: the regexes it runs`);
    assert.ok(![...after.calls.flat(), ...after.logs].some((value) => /PAGEREF_/.test(String(value))), `${program.label}: no token ships`);
  }
  assert.deepStrictEqual(falseRefusals, [], 'a page the lexer reads with certainty is never refused');
  t.diagnostic(`${programs.length} pages run, ${accepted} accepted and resolved correctly, ${programs.length - accepted} refused`);
  assert.ok(accepted >= 100, `only ${accepted} of ${programs.length} pages were accepted, so the sweep proves little`);
  // Every construct read with certainty, that holds no token in text, was accepted somewhere: the certainty is exercised, not assumed.
  assert.deepStrictEqual(JS_CONSTRUCTS.filter((c) => c.kind === null && c.clean !== false && c.name !== 'nothing' && !acceptedWith.has(c.name)).map((c) => c.name), [], 'each certain construct was accepted');
  const exercised = ['brace', 'paren', 'keyword', 'identifier', 'operator', 'newline'];
  assert.deepStrictEqual(exercised.filter((kind) => !kindsRefused.has(kind)), [], 'every kind that JavaScript can run was met, and refused');
});

test('sweep (reverse resolution): whatever it writes, the forward path accepts unchanged, and every id it keeps is reported', () => {
  // Every program, as a build would have deployed it: each token an id. Reverse resolution then turns back what it can; the claim is about
  // what it WRITES — each token must be one the forward path takes, and resolving the result must give the deployed page back. A short key
  // makes the tokens shorter than the ids; a long one longer, which moves the code after each.
  const programs = [...programsOf([...JS_CONSTRUCTS, ...TS_CONSTRUCTS], TS_PAYLOADS, { callFirst: JS_PAYLOADS[0] }), ...nestedPrograms()];
  let written = 0;
  let kept = 0;
  let keptForRebuild = 0;
  for (const key of ['detail', LONG_KEY]) {
    for (const program of programs) {
      const deployed = program.code.replaceAll('PAGEREF_detail', ID);
      const report = reverseResolveNavIdsReport(deployed, new Map([[ID, key]]));
      const idsLeft = report.code.split(ID).length - 1;
      assert.strictEqual(report.left.length, idsLeft, `${program.label}: every id left in the result is reported`);
      if (report.code === deployed) {
        kept += 1;
        if (report.left.some((l) => l.why === 'would-not-rebuild')) keptForRebuild += 1;
        continue;
      }
      written += 1;
      const forward = resolvePageRefs(new Map([['page', { code: report.code }]]), new Map([[key, ID]]));
      assert.deepStrictEqual(strayPageRefs(report.code), [], `${program.label} (key ${key.length}): no token written is stray`);
      assert.deepStrictEqual(navMalformedRefs(report.code), [], `${program.label} (key ${key.length}): none is malformed`);
      assert.deepStrictEqual([forward.unresolved, forward.residual], [[], []], `${program.label} (key ${key.length}): all are resolved`);
      assert.strictEqual(forward.deployment.get('page'), deployed, `${program.label} (key ${key.length}): resolving the result gives the deployed page back`);
    }
  }
  assert.ok(written >= 100, `only ${written} pages were written as tokens, so the sweep proves little (${kept} were not)`);
  assert.ok(keptForRebuild > 0, 'a page whose tokens the forward path would refuse is met, and kept with its ids');
});

test('sweep (TypeScript parser): a page that is not refused has its real navigation literals rewritten, and nothing else', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  // The calls TypeScript sees, by the span of the pageId literal. A page TypeScript cannot parse is not a page: its construct is wrong, not the reader.
  const realLiterals = (code) => {
    const { diagnostics } = ts.transpileModule(code, { fileName: 'page.tsx', reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 } });
    if (diagnostics.length) return null;
    return navigationLiteralSpans(ts, ts.createSourceFile('page.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX));
  };
  const constructs = [...JS_CONSTRUCTS, ...TS_CONSTRUCTS];
  const programs = [...programsOf(constructs, TS_PAYLOADS, { callFirst: JS_PAYLOADS[0] }), ...nestedPrograms()];
  const kindsRefused = new Set();
  const unparsable = [];
  const falseRefusals = [];
  const acceptedWith = new Set();
  let accepted = 0;
  for (const program of programs) {
    const real = realLiterals(program.code);
    if (real === null) { unparsable.push(program.label); continue; }
    const { refused, kind } = refusal(program.code);
    if (kind) kindsRefused.add(kind);
    if (refused) {
      if (program.certain) falseRefusals.push(program.label);
      continue;
    }
    accepted += 1;
    for (const name of program.constructs) acceptedWith.add(name);
    const rewritten = extractNavTargets(program.code).filter((target) => target.kind === 'pageref' && !target.afterFrontier).map((target) => `${target.valueStart}-${target.valueEnd}`).sort();
    assert.deepStrictEqual(rewritten, real, `${program.label}: the literals the reader rewrites are exactly the ones TypeScript reads as navigation`);
  }
  assert.deepStrictEqual(unparsable, [], 'every construct is a page TypeScript parses');
  assert.deepStrictEqual(falseRefusals, [], 'a page the lexer reads with certainty is never refused');
  t.diagnostic(`${programs.length} pages parsed, ${accepted} accepted with exactly the real literals rewritten, ${programs.length - accepted} refused`);
  assert.ok(accepted >= 150, `only ${accepted} of ${programs.length} pages were accepted, so the sweep proves little`);
  assert.deepStrictEqual(constructs.filter((c) => c.kind === null && c.clean !== false && c.name !== 'nothing' && !acceptedWith.has(c.name)).map((c) => c.name), [], 'each certain construct was accepted');
  // `fallback` is a quote with no closing quote, which TypeScript does not parse; its unit test covers it.
  assert.deepStrictEqual(AMBIGUITY_KINDS.filter((kind) => kind !== 'fallback' && !kindsRefused.has(kind)), [], 'every other kind of guess was met, and refused');
});

// One batch of programs against TypeScript. A program is TypeScript's to judge: it is a page only if TypeScript parses it with no diagnostic, and then it says whether a regex it reads holds the
// text of a navigation call (the token inside it is data). The claim under test: a page that is not refused has its token rewritten only where TypeScript reads a real call — never in
// a regex, and never in a literal that is not a navigation. `programs` yields { code, label }.
function judgePrograms(ts, programs) {
  const counts = { generated: 0, valid: 0, regexHoldsToken: 0, refusedAfterAGuess: 0, refusedPlain: 0, accepted: 0 };
  const guessKinds = new Map();
  const unsound = [];
  const acceptedWithRegex = [];
  for (const program of programs) {
    counts.generated += 1;
    const source = cleanSourceFile(ts, program.code);
    if (!source) continue;
    counts.valid += 1;
    let regexHoldsToken = false;
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral && node.text.includes('PAGEREF_detail')) regexHoldsToken = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (regexHoldsToken) counts.regexHoldsToken += 1;
    const { refused, kind } = refusal(program.code);
    if (refused) {
      if (kind) { counts.refusedAfterAGuess += 1; guessKinds.set(kind, (guessKinds.get(kind) || 0) + 1); } else counts.refusedPlain += 1;
      continue;
    }
    counts.accepted += 1;
    const rewritten = extractNavTargets(program.code).filter((target) => target.kind === 'pageref' && !target.afterFrontier).map((target) => `${target.valueStart}-${target.valueEnd}`).sort();
    // Accepting a page that holds a token in a regex is the failure, and so is rewriting a literal that TypeScript does not see as a navigation.
    if (regexHoldsToken) acceptedWithRegex.push(program.label);
    if (regexHoldsToken || JSON.stringify(rewritten) !== JSON.stringify(navigationLiteralSpans(ts, source))) unsound.push(program.label);
  }
  return { counts, guessKinds, unsound, acceptedWithRegex };
}

const describeProgram = (program) => `${JSON.stringify(program.token)} / ${program.frame.name} / ${program.separator} / ${program.continuation}: ${JSON.stringify(program.code)}`;
const labelled = function* (programs) { for (const program of programs) yield { ...program, label: describeProgram(program) }; };
const guessSummary = (guessKinds) => [...guessKinds].map(([kind, n]) => `${kind} ${n}`).join(', ');

// A `<` where an expression may start is an element, a generic arrow's type parameters or a generic function type, and which one depends on the token before
// it: TypeScript applies its arrow rule only where an assignment expression starts, so after a unary or binary operator the same words are an element. A lexer
// that reads an element's text as code reads the regex after it as code too, and the token in the regex is rewritten. So every punctuator and keyword TypeScript
// has is put in front of a `<` — adjacent to it, after a space, after a line break — in front of each way the `<` can continue (an element, two generic arrows, a
// function type), in every frame where the token can stand (tests/helpers/angle-frames.js), followed on the same line by a regex that holds the text of a
// navigation call and then a real call. TypeScript says which programs are valid and what it reads. The claim: wherever TypeScript reads a regex, its token
// is never rewritten and the page is never accepted — it is refused, with a guess named or not.
test('sweep (every token before a "<", TypeScript parser): where TypeScript reads a regex, its token is never rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const tokens = tokenVocabulary(ts);
  const { counts, guessKinds, unsound } = judgePrograms(ts, labelled(tokens.flatMap((token) => programsFor(token, { after: AFTER_WITH_CALL }))));
  t.diagnostic(`${tokens.length} tokens, ${counts.generated} programs, ${counts.valid} valid to TypeScript (${counts.regexHoldsToken} with the token in a regex): ${counts.refusedPlain} refused with no guess, ${counts.refusedAfterAGuess} refused after a guess (${guessSummary(guessKinds)}), ${counts.accepted} accepted`);
  assert.deepStrictEqual(unsound, [], 'no page in which TypeScript reads a regex is accepted, or has a token in one rewritten');
  assert.ok(counts.valid >= 1500, `only ${counts.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(counts.regexHoldsToken, counts.valid, 'every valid program has the regex');
  assert.ok(counts.refusedPlain >= 500 && counts.refusedAfterAGuess >= 60, 'both ways of refusing were exercised: a token read right, and one after a guess');
});

// The `>` that ends a list of type arguments — a cast's, `as` or `satisfies`, nested lists, an instantiation's, a return type's, an alias head's, a conditional type's — or a JSX tag is read by
// the lexer with certainty and never reported, and the operator after it is put together by TypeScript's parser, not by its scanner: `x as A<B>>= <T extends X>text</T>` is `x as A<B>`,
// then `>=`, then an element, where a lexer that cut the run `>>=` as one operator read an assignment and a generic arrow, and the regex after the element as code. So each such list is put
// IMMEDIATELY before every punctuator and keyword TypeScript has (PRODUCER_FRAMES), adjacent, after a space and after a line break, in front of every way a `<` continues.
test('sweep (a closed list of type arguments or a tag immediately before every token and a "<", TypeScript parser): where TypeScript reads a regex, its token is never rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const tokens = tokenVocabulary(ts);
  const { counts, guessKinds, unsound } = judgePrograms(ts, labelled(tokens.flatMap((token) => programsFor(token, { after: AFTER_WITH_CALL, frames: PRODUCER_FRAMES }))));
  t.diagnostic(`${tokens.length} tokens, ${counts.generated} programs, ${counts.valid} valid to TypeScript (${counts.regexHoldsToken} with the token in a regex): ${counts.refusedPlain} refused with no guess, ${counts.refusedAfterAGuess} refused after a guess (${guessSummary(guessKinds)}), ${counts.accepted} accepted`);
  assert.deepStrictEqual(unsound, [], 'no page in which TypeScript reads a regex is accepted, or has a token in one rewritten');
  assert.ok(counts.valid >= 400, `only ${counts.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(counts.regexHoldsToken, counts.valid, 'every valid program has the regex');
  assert.ok(counts.refusedAfterAGuess >= 50, 'the closers that are no cast were followed by guesses that were reported');
  // The run that held the failure: a closer, then `>=` and an element — `>>=` after one closer, `>>>=` after two. TypeScript reads each of them as a comparison with an element, and so does
  // the lexer: a head with a constraint and no parameter list is an element whatever the cut is (as an initialiser it would be an arrow with no parameters, an error), so no guess is named,
  // the regex after the element is data, and its token is refused as a stray one.
  const held = programsFor('>=', { after: AFTER_WITH_CALL, frames: PRODUCER_FRAMES, separators: { adjacent: '' }, continuations: { element: CONTINUATIONS.element } })
    .filter((program) => { const source = cleanSourceFile(ts, program.code); return source && isElement(readingAt(ts, source, program.at)); });
  assert.ok(held.length >= 5, `only ${held.length} programs have a closer, ">=" and an element`);
  for (const program of held) {
    const { refused, kind } = refusal(program.code);
    assert.ok(refused && kind === null, `the element is read, and the token in the regex after it refused with no guess: ${describeProgram(program)}`);
  }
  assert.ok(held.some((program) => program.frame.name === 'cast, nested, closed before the token') && held.some((program) => program.frame.name === 'satisfies, closed before the token'), 'a nested cast and a satisfies were met');
});

// The same programs with every character TypeScript skips between two tokens between the token and the `<`: white space of every kind — U+0085 and the zero-width space among them, which
// JavaScript's `\s` lacks — and comments. The token is the last operator of the run, and what stands before it is read through the same trivia.
test('sweep (every trivia character between a token and a "<", TypeScript parser): where TypeScript reads a regex, its token is never rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const tokens = tokenVocabulary(ts);
  const frames = FRAMES.filter((frame) => ['binary', 'prefix', 'statement', 'assignment', 'argument', 'else', 'arrow body'].includes(frame.name)).concat(PRODUCER_FRAMES.filter((frame) => ['cast, closed before the token', 'satisfies, closed before the token', 'JSX self-closing tag, before the token'].includes(frame.name)));
  const continuations = { element: CONTINUATIONS.element, arrowComma: CONTINUATIONS.arrowComma, functionType: CONTINUATIONS.functionType };
  // A `/` and a comment make one comment (`//* c */` runs to the end of the line, regex and all): TypeScript parses that, and there is nothing in it for the lexer to read.
  const makesOneComment = (program) => /\/[/*]|\*\//.test(program.token + TRIVIA_SEPARATORS[program.separator]);
  const programs = tokens.flatMap((token) => programsFor(token, { after: AFTER_WITH_CALL, frames, separators: TRIVIA_SEPARATORS, continuations })).filter((program) => !makesOneComment(program));
  const { counts, guessKinds, unsound } = judgePrograms(ts, labelled(programs));
  t.diagnostic(`${tokens.length} tokens, ${counts.generated} programs, ${counts.valid} valid to TypeScript (${counts.regexHoldsToken} with the token in a regex): ${counts.refusedPlain} refused with no guess, ${counts.refusedAfterAGuess} refused after a guess (${guessSummary(guessKinds)}), ${counts.accepted} accepted`);
  assert.deepStrictEqual(unsound, [], 'no page in which TypeScript reads a regex is accepted, or has a token in one rewritten');
  assert.ok(counts.valid >= 6000, `only ${counts.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(counts.regexHoldsToken, counts.valid, 'every valid program has the regex');
  // A head that cannot be an element (a comma, a parameter list and an arrow) is type parameters whatever stands before it, so only the element and the `>` guesses are left to refuse after. (A `<` after
  // a `/` that the lexer read as the division operator is an element, for certain, so the `operator` guesses that once stood here for `/` are gone.)
  assert.ok(counts.refusedPlain >= 4000 && counts.refusedAfterAGuess >= 300, 'both ways of refusing were exercised');
  assert.ok((guessKinds.get('angle') || 0) >= 200, `the angle guess was met: ${guessSummary(guessKinds)}`);
});

// A `/` is a regex or a division by what stands before it, and TypeScript skips every trivia character between the token and the `/` — U+0085 and the zero-width space among them. So every
// punctuator and keyword TypeScript has is put in front of a regex that holds the text of a navigation call, in every frame (tests/helpers/angle-frames.js) with every trivia character
// between, and a real call follows. Wherever TypeScript parses the program it reads a regex there, whose token is data: it is never rewritten and the page is never accepted.
test('sweep (every trivia character between a token and a "/", TypeScript parser): where TypeScript reads a regex, its token is never rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const tokens = tokenVocabulary(ts);
  const continuations = { regex: `/${BODY}/` };
  const after = '; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});';
  // `/` and a comment, and `*` and `/*`, make one comment; a `<` or `>` before the regex is no frame of this sweep (the sweeps above ask what follows a `>`).
  const makesOneComment = (program) => /\/[/*]|\*\//.test(`${program.token}${TRIVIA_SEPARATORS[program.separator]}/`);
  const programs = tokens.flatMap((token) => programsFor(token, { after, frames: FRAMES, separators: TRIVIA_SEPARATORS, continuations })).filter((program) => !makesOneComment(program));
  const { counts, guessKinds, unsound } = judgePrograms(ts, labelled(programs));
  t.diagnostic(`${tokens.length} tokens, ${counts.generated} programs, ${counts.valid} valid to TypeScript (${counts.regexHoldsToken} with the token in a regex): ${counts.refusedPlain} refused with no guess, ${counts.refusedAfterAGuess} refused after a guess (${guessSummary(guessKinds)}), ${counts.accepted} accepted`);
  assert.deepStrictEqual(unsound, [], 'no page in which TypeScript reads a regex is accepted, or has a token in one rewritten');
  assert.ok(counts.valid >= 3000, `only ${counts.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(counts.regexHoldsToken, counts.valid, 'every valid program has the regex');
  assert.ok(counts.refusedPlain >= 5000 && counts.refusedAfterAGuess >= 1000, 'both ways of refusing were exercised: a regex read right, and one after a guess');
});

// The head of an `if`, `while`, `for`, `with` or `for await`, and the regex that is its statement: TypeScript skips every trivia character between the keyword and the `(` (and between `for` and
// `await`) and between the `)` and the `/`. A lexer that did not know a character took the word before the `(` for no word, the `)` for the end of an operand, and the `/` for a division — and the
// token in the regex was rewritten (`if` U+0085 `(true) /navigateTo({…})/;`). Every head with every trivia character in each of the places.
test('sweep (every trivia character in the head of a statement and before its regex, TypeScript parser): the regex that is its statement is never rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const heads = [
    { name: 'if', make: (a, b) => `if${a}(x)${b}` }, { name: 'while', make: (a, b) => `while${a}(x)${b}` }, { name: 'for', make: (a, b) => `for${a}(;;)${b}` }, { name: 'with', make: (a, b) => `with${a}(x)${b}` },
    { name: 'for await', make: (a, b) => `for${a}await${a}(y of x)${b}` }, { name: 'else if', make: (a, b) => `if (x) ; else if${a}(x)${b}` }, { name: 'do while', make: (a, b) => `do ; while${a}(x)${b}` },
  ];
  const programs = [];
  for (const head of heads) {
    for (const [first, a] of Object.entries(TRIVIA_SEPARATORS)) {
      for (const [second, b] of Object.entries(TRIVIA_SEPARATORS)) {
        const code = `declare const x: any, y: any, s: any;\nasync function f() {\n  ${head.make(a, b)}/${BODY}/.test(s);\n  navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});\n}\n`;
        programs.push({ code, label: `${head.name} / ${JSON.stringify(first)} / ${JSON.stringify(second)}: ${JSON.stringify(code)}` });
      }
    }
  }
  const { counts, unsound } = judgePrograms(ts, programs);
  t.diagnostic(`${counts.generated} programs, ${counts.valid} valid to TypeScript (${counts.regexHoldsToken} with the token in a regex): ${counts.refusedPlain} refused with no guess, ${counts.refusedAfterAGuess} refused after a guess, ${counts.accepted} accepted`);
  assert.deepStrictEqual(unsound, [], 'no head is read as an operand, so no regex is read as code');
  assert.ok(counts.valid >= 4000, `only ${counts.valid} programs were valid`);
  assert.strictEqual(counts.regexHoldsToken, counts.valid, 'every valid program has the regex');
  // A head is read for certain at every character: its regex is data, so the page is refused for the token in it — plain, with no guess to blame.
  assert.strictEqual(counts.refusedAfterAGuess, 0, 'a head with white space in it is no guess');
  assert.strictEqual(counts.refusedPlain, counts.valid, 'each page is refused for the token in the regex');
});

// A `*` before a `<`. After `function` TypeScript reads an optional `*`, an optional name and then type parameters, so a `<` after `function*` opens them, whatever follows; after `yield` in a
// generator the rule for an arrow applies, and outside one the `*` multiplies; after anything else it multiplies, and the operand is an element. A lexer that read `function* <T>(x: T) {…}`
// as an element took the `</T>` in a string after it for its closing tag, and the call written after that was read as code. Every place a `*` can stand before a `<` — after `function`,
// `async function`, a default export, `yield` in a generator and outside one, a property named like either, a name, a number, a call — with every kind of white space and a comment on each side
// of the `*`, in front of what the `<` can be: type parameters and a body, a generic arrow, an element. A string that holds a closing tag and a call, a regex that holds a call, and a real
// call follow. TypeScript says which programs are pages: the reader rewrites the real call and nothing else, or refuses the page.
test('sweep (a "*" before a "<", TypeScript parser): type parameters, a delegation and a product are never read as the wrong one', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const leads = [
    { name: 'function expression', before: 'const g = function', after: ';' }, { name: 'async function expression', before: 'const g = async function', after: ';' },
    { name: 'default export', before: 'export default function', after: '' }, { name: 'async default export', before: 'export default async function', after: '' },
    { name: 'parenthesised function', before: 'const g = (function', after: ');' }, { name: 'argument', before: 'f(function', after: ');' }, { name: 'object member', before: 'const o = { m: function', after: ' };' },
    { name: 'yield in a generator', before: 'function* gen() { yield', after: '; }' }, { name: 'yield in an async generator', before: 'async function* gen() { yield', after: '; }' },
    { name: 'yield outside a generator', before: 'function gen() { yield', after: '; }' }, { name: 'property function', before: 'const o = obj.function', after: ';' },
    { name: 'property yield', before: 'const o = obj.yield', after: ';' }, { name: 'optional property function', before: 'const o = obj?.function', after: ';' },
    { name: 'name', before: 'const o = a', after: ';' }, { name: 'number', before: 'const o = 1', after: ';' }, { name: 'call', before: 'const o = f(x)', after: ';' }, { name: 'index', before: 'const o = a[0]', after: ';' },
    { name: 'name ending in function', before: 'const o = xfunction', after: ';' }, { name: 'name starting with function', before: 'const o = functionx', after: ';' },
    { name: 'non-null assertion', before: 'const o = a!', after: ';' },
  ];
  const tails = {
    typeParameters: '<T>(x: T) { return x; }', typeParametersComma: '<T,>(x: T) { return x; }', arrow: '<T,>(x: T) => MARK', arrowExtends: '<T extends X>(x: T) => MARK',
    element: '<T extends X>MARK</T>', elementPlain: '<b>MARK</b>', functionType: '<T>(x: T) => T',
  };
  const around = { adjacent: '', space: ' ', newline: '\n', comment: '/* c */', 'next line': '\u0085', 'zero-width space': '\u200B', 'line separator': '\u2028', 'no-break space': '\u00A0' };
  const after = `\n${"const str = '</T>;navigateTo({pageType:\"generative\",pageId:\"PAGEREF_detail\"});//';"}\nconst re = /${BODY}/;\nnavigateTo({pageType:"generative", pageId:"PAGEREF_detail"});\n`;
  const programs = [];
  for (const lead of leads) {
    for (const [tail, text] of Object.entries(tails)) {
      for (const [first, a] of Object.entries(around)) {
        for (const [second, b] of Object.entries(around)) {
          const code = `declare const T: any, X: any, MARK: any, a: any, f: any, x: any, obj: any;\n${lead.before}${a}*${b}${text}${lead.after}${after}`;
          programs.push({ code, lead: lead.name, tail, label: `${lead.name} / ${tail} / ${first} / ${second}: ${JSON.stringify(code)}` });
        }
      }
    }
  }
  const { counts, unsound } = judgePrograms(ts, programs);
  t.diagnostic(`${counts.generated} programs, ${counts.valid} valid to TypeScript: ${counts.refusedPlain} refused with no guess, ${counts.refusedAfterAGuess} refused after a guess, ${counts.accepted} accepted`);
  assert.deepStrictEqual(unsound, [], 'no string or regex is read as code, so the only token rewritten is the real call\'s, or the page is refused');
  assert.ok(counts.valid >= 1500, `only ${counts.valid} programs were valid`);
  // `function*` and its type parameters are certain: a page with them, which TypeScript parses, is refused only for the tokens it holds as data (a string, a regex), with no guess to blame.
  const certain = programs.filter((program) => /function expression|default export|parenthesised|argument|object member/.test(program.lead) && /^typeParameters/.test(program.tail) && cleanSourceFile(ts, program.code));
  assert.ok(certain.length >= 300, `only ${certain.length} pages have type parameters after "function*"`);
  for (const program of certain) assert.strictEqual(refusal(program.code).kind, null, `no guess: ${program.label}`);
});

// A JSX attribute string. TypeScript scans an attribute value by one of two rules (scanner.ts, scanJsxAttributeValue, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts):
// a quote right after the `=` starts a JSX string — no escapes, ended by the next quote, which is how Babel and esbuild read every attribute string — and anything else goes to scan(), which
// skips all trivia and reads a JavaScript string, where a backslash escapes the character after it. So after trivia a backslash before the quote that ends the string in JSX moves its end in
// TypeScript, and the call that follows is text to one compiler and code to the other. Here is every trivia character and comment between the `=` and the quote, both quotes, every kind of body
// (a backslash in each place that matters, an escape that moves nothing, a line continuation, a raw line break), in front of each way the element can end, in the places an element is a whole
// statement. TypeScript says which programs are pages, and the claims are:
//   - a page the lexer reads with no guess has, in the lexer's code, the calls TypeScript reads — no more and no fewer;
//   - no token is rewritten where TypeScript reads no call;
//   - where Babel (BABEL_ORACLE_PATH, optional) parses the page too and reads other calls than TypeScript does, the lexer has named a guess, and only ever `jsx-attribute`, at a quote that does
//     not follow its `=` at once.
test('sweep (a JSX attribute string after trivia, TypeScript and Babel parsers): the lexer is certain only where the compilers read the same calls', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const babel = loadBabelOracle();
  const bodies = {
    empty: '', text: 'ab', 'a lone backslash': '\\', 'text, then a backslash': 'a\\', 'two backslashes': '\\\\', 'three backslashes': '\\\\\\', 'an n escape': '\\n', 'a unicode escape': '\\u0041',
    'a hex escape': '\\x41', 'a nul escape': '\\0', 'a line continuation': '\\\n', 'a CRLF continuation': '\\\r\n', 'a line separator continuation': '\\\u2028', 'a raw line break': 'a\nb',
    'a raw line separator': 'a\u2028b',
  };
  // After the quote that ends the string in JSX: the call is in the JavaScript string where a backslash moves its end, and code where it does not. The quote that would end that string
  // is the same one, and the call is written with the other (a string cannot hold its own quote), so every call is on one line with the quote after it.
  const tails = {
    'a hidden call': (q, call) => `/>;${call};//${q} />;`,
    'a hidden call, a space before the slash': (q, call) => ` />;${call};//${q} />;`,
    plain: (q, call) => ` />;${call};`,
    'another attribute': (q, call) => ` y=${q}z${q} />;${call};`,
    children: (q, call) => `>text</C>;${call};`,
  };
  // The tail ends a statement, so the rest of each frame is on the next line, out of reach of the `//` in the tail.
  const frames = { initializer: ['const e = ', ''], return: ['function r() { return ', '}'], assignment: ['x = ', ''], arrow: ['const g = () => ', ''], 'default export': ['export default ', ''] };
  const separators = [...Object.entries(TRIVIA_SEPARATORS), ['block comment, spaced', ' /* c */ '], ['line comment, spaced', ' // c\n '], ['multi-line comment', '/*\n*/']];
  const programs = [];
  for (const [frame, [head, foot]] of Object.entries(frames)) {
    for (const [separator, between] of separators) {
      for (const q of ['\'', '"']) {
        const other = q === '\'' ? '"' : '\'';
        const call = `navigateTo({pageType:${other}generative${other},pageId:${other}PAGEREF_detail${other}})`;
        for (const [body, text] of Object.entries(bodies)) {
          for (const [tail, make] of Object.entries(tails)) {
            const code = `declare const C: any, x: any, navigateTo: any;\n${head}<C x=${between}${q}${text}${q}${make(q, call)}\n${foot}\nnavigateTo({pageType:"generative", pageId:"PAGEREF_detail"});\n`;
            programs.push({ code, label: `${frame} / ${separator} / ${q} / ${body} / ${tail}: ${JSON.stringify(code)}` });
          }
        }
      }
    }
  }
  const callsTypeScriptReads = (source) => {
    const found = [];
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') found.push(node.expression.getStart(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found.sort((a, b) => a - b);
  };
  // Where Babel throws the page is not one it can read, which is no disagreement about a call.
  const callsBabelReads = (code) => {
    let tree;
    try {
      tree = babel.parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    } catch {
      return null;
    }
    const found = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee && node.callee.name === 'navigateTo') found.push(node.callee.start);
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child.type === 'string') visit(child);
      }
    };
    visit(tree.program);
    return found.sort((a, b) => a - b);
  };
  const stats = { generated: programs.length, valid: 0, certain: 0, guessed: 0, hiddenForTypeScript: 0, babelParses: 0, babelDiffers: 0 };
  const failures = [];
  for (const program of programs) {
    const source = cleanSourceFile(ts, program.code);
    if (!source) continue;
    stats.valid += 1;
    const found = [];
    const mask = blankNonCodePreservingTemplateExpressions(program.code, { onAmbiguity: (at, kind) => found.push([at, kind]) });
    const lexerCalls = [...mask.matchAll(/\bnavigateTo\(/g)].map((match) => match.index);
    const typeScriptCalls = callsTypeScriptReads(source);
    if (typeScriptCalls.length < lexerCalls.length) stats.hiddenForTypeScript += 1;
    if (found.length > 0) stats.guessed += 1; else stats.certain += 1;
    for (const [at, kind] of found) if (kind !== 'jsx-attribute' || !/['"]/.test(program.code[at]) || program.code[at - 1] === '=') failures.push(`${program.label}: a "${kind}" guess at ${at}, which is not a quote after trivia`);
    if (found.length === 0 && JSON.stringify(lexerCalls) !== JSON.stringify(typeScriptCalls)) failures.push(`${program.label}: certain, and the lexer reads calls at ${lexerCalls} where TypeScript reads them at ${typeScriptCalls}`);
    if (!babel) continue;
    const babelCalls = callsBabelReads(program.code);
    if (babelCalls === null) continue;
    stats.babelParses += 1;
    const differs = JSON.stringify(babelCalls) !== JSON.stringify(typeScriptCalls);
    if (differs) stats.babelDiffers += 1;
    if (differs && found.length === 0) failures.push(`${program.label}: certain, and TypeScript reads calls at ${typeScriptCalls} where Babel reads them at ${babelCalls}`);
  }
  assert.deepStrictEqual(failures.slice(0, 5), [], `${failures.length} pages are read differently than the claims allow`);
  const { counts, unsound } = judgePrograms(ts, programs);
  t.diagnostic(`${stats.generated} programs, ${stats.valid} valid to TypeScript: ${stats.certain} with no guess, ${stats.guessed} with a guess (${stats.hiddenForTypeScript} where TypeScript hides a call the lexer sees); `
    + `${babel ? `Babel parses ${stats.babelParses}, and reads other calls in ${stats.babelDiffers}` : 'no Babel parser oracle (BABEL_ORACLE_PATH)'}; ${counts.accepted} accepted, ${counts.refusedPlain} refused with no guess, ${counts.refusedAfterAGuess} refused after a guess`);
  assert.deepStrictEqual(unsound, [], 'no token is rewritten where TypeScript reads no call');
  assert.ok(stats.valid >= 4000, `only ${stats.valid} programs were valid`);
  assert.ok(stats.certain >= 2000 && stats.guessed >= 500, 'both were exercised: a string read with certainty, and one that is a guess');
  assert.ok(stats.hiddenForTypeScript >= 200, 'TypeScript hides a call that the other compilers read, and the lexer named it');
  if (babel) assert.ok(stats.babelParses >= 3000 && stats.babelDiffers >= 200, `Babel parses ${stats.babelParses} and reads other calls in ${stats.babelDiffers}`);
});

// The pages the tests are built on are pages: TypeScript parses each of them, and where the page says its regex holds a token, TypeScript reads it as a regex.
test('the committed misread pages are valid to TypeScript, and those that hold a token in a regex or a string hold it in one', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const literalTokens = (source, kind, needle) => {
    let found = 0;
    const visit = (node) => {
      if (node.kind === kind && node.text.includes(needle)) found += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };
  const regexTokens = (source) => literalTokens(source, ts.SyntaxKind.RegularExpressionLiteral, 'PAGEREF_detail');
  // A string that holds a whole call is data; the `"PAGEREF_detail"` of a real call is a string too, and is not counted.
  const stringTokens = (source) => literalTokens(source, ts.SyntaxKind.StringLiteral, 'navigateTo(');
  for (const [name, { code }] of Object.entries(MISREAD_PAGES)) assert.ok(cleanSourceFile(ts, code), `${name}: a page TypeScript parses`);
  for (const { name, code } of [...FUNCTION_TYPE_PAGES, ...ELEMENT_LOOKALIKE_PAGES]) assert.ok(cleanSourceFile(ts, code), `${name}: a page TypeScript parses`);
  for (const name of [
    'generic, with await', 'generic, with yield', 'operator, after ">="',
    'operator, after ">>=" that ends type arguments', 'operator, after ">>>=" that ends nested type arguments', 'operator, after ">>=" that ends the type arguments of satisfies',
  ]) {
    assert.strictEqual(regexTokens(cleanSourceFile(ts, MISREAD_PAGES[name].code)), 1, `${name}: TypeScript reads the token as text in a regex`);
  }
  // TypeScript reads the call in the attribute string as the text of one string (the quote follows white space, so scan() reads a JavaScript string, with escapes), and the call after the
  // closing tag in each generator page as the text of a string.
  assert.strictEqual(stringTokens(cleanSourceFile(ts, MISREAD_PAGES['jsx-attribute'].code)), 1, 'jsx-attribute: TypeScript reads the token as text in one string');
  // A regex after a line comment: the token is in the string of a type in the first page and in a regex, in a member's default, in the second.
  assert.strictEqual(stringTokens(cleanSourceFile(ts, MISREAD_PAGES['generic, a regex after a line comment'].code)), 1, 'a regex after a line comment: TypeScript reads the token as text in a string');
  assert.strictEqual(regexTokens(cleanSourceFile(ts, MISREAD_PAGES['generic, a regex that holds a closing tag after a line comment'].code)), 1, 'a regex that holds a closing tag after a line comment: TypeScript reads the token as text in a regex');
  for (const { name, code } of ELEMENT_LOOKALIKE_PAGES.filter(({ name: what }) => /generator/.test(what))) assert.strictEqual(stringTokens(cleanSourceFile(ts, code)), 1, `${name}: TypeScript reads the token as text in a string`);
  for (const { name, code } of ELEMENT_AFTER_OPERATOR_PAGES) {
    const source = cleanSourceFile(ts, code);
    assert.ok(source, `${name}: a page TypeScript parses`);
    assert.strictEqual(regexTokens(source), 1, `${name}: TypeScript reads the token as text in a regex`);
  }
});

// ─── Where each token lies, as TypeScript reads the page ─────────────────────────────────────────────────────────────────────────────────────
//
// The claim of a lexer with no parser is about tokens: a PAGEREF_ token is rewritten only where TypeScript reads it as the pageId of a navigation call, and every other token — in a regex, a string, a
// comment, text — is reported stray, so the build halts on it and never rewrites it. The sweeps below put programs for each of the changes they cover in front of TypeScript's parser and ask it
// per token (`readTokens`): every token TypeScript reads as data is reported stray, whatever the lexer read; and where the lexer named no guess, the tokens it reports stray are exactly the data tokens,
// so every real call is seen, which is what a lexer that reads the page right does (a page where it guessed is refused after the guess, which is always allowed).
function tokenReading(ts, code) {
  const source = cleanSourceFile(ts, code);
  if (!source) return null;
  const real = navigationLiteralSpans(ts, source).map((span) => span.split('-').map(Number));
  const tokens = [...code.matchAll(/PAGEREF_[A-Za-z0-9_-]+/g)].map((match) => match.index);
  const isReal = (at) => real.some(([from, to]) => at >= from && at < to);
  return { real: tokens.filter(isReal), data: tokens.filter((at) => !isReal(at)), spans: real };
}

// What the lexer before a change (BASE_LIB_PATH) does with a program: whether it accepts it (names no stray token), and then whether it rewrites exactly the calls TypeScript reads or a token that is data.
function readByBase(base, program, reading) {
  const resolved = base.resolvePageRefs(new Map([['page', { code: program.code }]]), new Map([['detail', 'gp-detail']]));
  const accepted = base.strayPageRefs(program.code).length === 0 && resolved.residual.length === 0 && resolved.unresolved.length === 0 && base.navMalformedRefs(program.code).length === 0;
  if (!accepted) return { accepted };
  const rewritten = base.extractNavTargets(program.code).filter((target) => target.kind === 'pageref' && !target.afterFrontier).map((target) => `${target.valueStart}-${target.valueEnd}`).sort();
  const real = reading.spans.map(([from, to]) => `${from}-${to}`).sort();
  return { accepted, right: JSON.stringify(rewritten) === JSON.stringify(real), rewritesData: rewritten.some((span) => !real.includes(span)) };
}

// `base`, where it is given, is read the same way: `stats.baseRight` counts the valid programs it reads exactly, `stats.baseMisread` those where it rewrites a token that TypeScript reads as data (what shows that the
// sweep sees a misread), and `stats.lost` those it reads exactly and this lexer does not (`lostPrograms`): a program that was resolved before must be resolved now.
function readTokens(ts, programs, base = null) {
  const stats = { generated: 0, valid: 0, exact: 0, guessed: 0, realTokens: 0, dataTokens: 0, baseRight: 0, baseMisread: 0, lost: 0 };
  const problems = [];
  const kinds = new Map();
  const guessedPrograms = [];
  const lostPrograms = [];
  for (const program of programs) {
    stats.generated += 1;
    const reading = tokenReading(ts, program.code);
    if (reading === null) continue;
    stats.valid += 1;
    stats.realTokens += reading.real.length;
    stats.dataTokens += reading.data.length;
    const there = base ? readByBase(base, program, reading) : null;
    if (there && there.right) stats.baseRight += 1;
    if (there && there.rewritesData) stats.baseMisread += 1;
    const stray = new Set(strayPageRefs(program.code).map((found) => found.start));
    const missed = reading.data.filter((at) => !stray.has(at));
    if (missed.length > 0) problems.push(`${program.label}: a token TypeScript reads as data is not stray (at ${missed}): ${JSON.stringify(program.code)}`);
    const frontier = navigationFrontier(program.code);
    if (frontier) {
      stats.guessed += 1;
      kinds.set(frontier.kind, (kinds.get(frontier.kind) || 0) + 1);
      guessedPrograms.push(program);
      if (there && there.right) { stats.lost += 1; lostPrograms.push(program); }
      continue;
    }
    const extra = [...stray].filter((at) => !reading.data.includes(at));
    const rewritten = extractNavTargets(program.code).filter((target) => target.kind === 'pageref' && !target.afterFrontier).map((target) => `${target.valueStart}-${target.valueEnd}`).sort();
    if (extra.length > 0) problems.push(`${program.label}: no guess, and a token of a real call is stray (at ${extra}): ${JSON.stringify(program.code)}`);
    else if (JSON.stringify(rewritten) !== JSON.stringify(navigationLiteralSpans(ts, cleanSourceFile(ts, program.code)))) problems.push(`${program.label}: no guess, and the calls rewritten are not the real ones: ${JSON.stringify(program.code)}`);
    else stats.exact += 1;
  }
  return { stats, problems, kinds, guessedPrograms, lostPrograms };
}
const describeReading = ({ stats, kinds }) => `${stats.generated} programs, ${stats.valid} valid to TypeScript (${stats.dataTokens} tokens read as data, ${stats.realTokens} in real calls): ${stats.exact} read exactly with no guess, ${stats.guessed} refused after a guess (${guessSummary(kinds)})`
  + `${stats.baseRight + stats.baseMisread + stats.lost > 0 ? `; the base reads ${stats.baseRight} exactly and misreads ${stats.baseMisread}, and ${stats.lost} of those it reads exactly are refused here` : ''}`;
const guessesOf = (code) => {
  const found = [];
  blankNonCodePreservingTemplateExpressions(code, { onAmbiguity: (at, kind) => found.push([at, kind]) });
  return found;
};

// A head with a string default. The default of a type parameter is a JavaScript string, and the value of an attribute is a JSX string, which has no escapes: `<T extends X="\">">(x)=>x` is an arrow
// whose type parameter has the default `"\">"`, and a tag that ends at the `>` after `"\"`. A head with no parameter list is an element after a guess token (headWithoutParameterList) because the two
// readings end at the same `>`, which fails where a backslash moves the end of the string. Every such head, with and without escapes, in front of a parameter list and an arrow and in front of text,
// after every token the lexer guesses at — the cut `>=`, `>>=` and `>>>=`, `<`, `in`, `void` and a line break, `yield *`, an unknown run like `>>>>=`, and `++` — in every frame and after every
// separator. A string with the text of a closing tag and a call, a regex with the text of a call and a real call follow: TypeScript says which are data.
test('sweep (a head with a string default after every guess token, TypeScript parser): nothing TypeScript reads as data is rewritten, and an arrow read as an element is guessed at', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const strings = { 'escaped quote': '"\\">"', 'escaped single quote': "'\\'>'", 'escape in the middle': '"a\\">b"', 'greater-than': '">"', plain: '"a"', 'escaped backslash': '"\\\\"', 'a hex escape': '"\\x3e"' };
  const tails = { 'a parameter list and an arrow': '(x)=>MARK', text: 'MARK</T>' };
  const continuations = {};
  for (const [name, text] of Object.entries(strings)) for (const [tail, more] of Object.entries(tails)) continuations[`${name} / ${tail}`] = `<T extends X=${text}>${more}`;
  const after = `; const s = '</T>;navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});//'; const re = /${REGEX_BODY}/; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});`;
  const tokens = ['>=', '>>=', '>>>=', '<', 'in', 'void', 'yield *', '>>>>=', '++'];
  const frames = [...FRAMES, ...PRODUCER_FRAMES, { name: 'generator', role: 'expression', text: 'function* g() { @§ }' }];
  const programs = [...labelled(tokens.flatMap((token) => programsFor(token, { after, frames, continuations })))];
  const { counts, guessKinds, unsound } = judgePrograms(ts, programs);
  t.diagnostic(`${tokens.length} tokens, ${counts.generated} programs, ${counts.valid} valid to TypeScript: ${counts.refusedPlain} refused with no guess, ${counts.refusedAfterAGuess} refused after a guess (${guessSummary(guessKinds)}), ${counts.accepted} accepted`);
  assert.deepStrictEqual(unsound, [], 'no page is accepted, and no token is rewritten where TypeScript reads none');
  assert.ok(counts.valid >= 1000, `only ${counts.valid} programs were valid, so the sweep proves little`);
  // The reading at the `<` is TypeScript's: an arrow or a function type is code and an element is text. Where the lexer reads an element and TypeScript reads code, or the reverse, the lexer must
  // have said so before the `<` — and the text after the head is what shows which it read (MARK is the arrow's body or an element's text).
  const problems = [];
  let arrowsReadAsElements = 0;
  let validWithEscape = 0;
  for (const program of programs) {
    const source = cleanSourceFile(ts, program.code);
    if (!source) continue;
    const found = [];
    const mask = blankNonCodePreservingTemplateExpressions(program.code, { onAmbiguity: (at, kind) => found.push([at, kind]) });
    const guessed = found.some(([at]) => at <= program.at);
    const element = isElement(readingAt(ts, source, program.at));
    const readAsElement = !mask.includes('MARK');
    if (/\\/.test(program.code.slice(program.at, program.at + 24))) validWithEscape += 1;
    if (!element && readAsElement && program.continuation.endsWith('a parameter list and an arrow')) {
      arrowsReadAsElements += 1;
      if (!guessed) problems.push(`an arrow is read as an element, with no guess: ${program.label}`);
    }
    if (element && !readAsElement && !guessed) problems.push(`the text of an element is read as code, with no guess: ${program.label}`);
  }
  assert.deepStrictEqual(problems.slice(0, 5), [], `${problems.length} pages are read as the other of an element and an arrow with no guess`);
  assert.ok(arrowsReadAsElements >= 20, `only ${arrowsReadAsElements} arrows were read as elements, so the sweep never met the page that held the failure`);
  assert.ok(validWithEscape >= 300, `only ${validWithEscape} valid programs have a head with a backslash`);
  assert.ok(counts.refusedAfterAGuess >= 300, 'the guess tokens were guessed at');
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token TypeScript reads as data is stray');
});

// An element or a fragment as an attribute's value is lexed as an element, with an end of its own (parseJsxAttributeValue). In every frame an element can stand, with white space and comments
// between the `=` and the `<`, in front of the text of an element and of a self-closing tag, among other attributes — and holding strings, expression containers and closing tags that a
// lexer that took its `/>` for the end of the OUTER tag would take for code.
const ELEMENT_VALUES = [
  '<B/>', '<B />', '<B></B>', '<B>t</B>', '<></>', '<>t</>', '<B y=<C/> />', '<B y=<C></C>>t</B>', '<B>{1}</B>', '<B>{"</A>"}</B>', '<B>{/* </A> */ 1}</B>', '<B<T> />', '<B.C/>', '<B x="/>" />', "<B x='>' />",
  '<B>{\'/>\'}</B>', '<B x={"</A>"} />', '<B>{<C/>}</B>', '<B>a &gt; b</B>', '<B {...p} />', '<B x="1" y=\'2\' z={3} />', '<B>t<D/>u<D></D>v</B>', '<B>{`</A>${1}`}</B>',
  `<B>{/${REGEX_BODY}/.test(s)}</B>`, `<B x={${CALL.replace(';', '')}} />`, `<B>{${CALL.replace(';', '')}}</B>`,
];
test('sweep (an element or a fragment as an attribute value, TypeScript parser): the value ends where its element does, every token is read where TypeScript reads it, and no guess is made', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const outers = ['<A x=@>text</A>', '<A x=@ />', '<A x=@ y="1">text</A>', '<A y="1" x=@>text</A>', '<A.B x=@>text</A.B>', '<A<T> x=@>text</A>', '<A x=@ y=@>text</A>', '<A>{1}<B x=@/>text</A>'];
  const gaps = ['', ' ', '\n', '/* c */', ' /* > */ ', ' // c\n', '\u00a0', '\u0085', '\u200b'];
  const places = ['const e = @;', 'f(@);', 'const o = { k: @ };', 'const p = <p>{@}</p>;', 'const t = `${@}`;', 'function g() { return @; }', 'export default @;'];
  const decoys = ` const re = /${REGEX_BODY}/; const s = '</A></B></C></D>;navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});//'; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});`;
  const programs = [];
  for (const place of places) {
    for (const outer of outers) {
      for (const value of ELEMENT_VALUES) {
        for (const gap of gaps) {
          const element = outer.replaceAll('@', `${gap}${value}`);
          programs.push({ code: `declare const c: any, f: any, s: any, p: any;\n${place.replace('@', element)}${decoys}`, label: `${place} / ${outer} / ${JSON.stringify(gap)} / ${value}` });
        }
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 8000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  // The value is lexed as an element: no guess at all, so every page is read exactly.
  assert.strictEqual(reading.stats.guessed, 0, `a page with an element for an attribute value was guessed at: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly');
  // Without the decoys, the one real call is accepted and rewritten, wherever the element stands: nothing is refused. (A value that holds a regex with the text of a call is data, so a token stays.)
  const plain = programs.filter((program, index) => index % 7 === 0 && !program.label.includes('.test(s)')).map((program) => ({ ...program, code: program.code.replace(decoys, ` navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});`) }));
  const { counts, unsound } = judgePrograms(ts, plain);
  assert.deepStrictEqual(unsound, [], 'no token is rewritten where TypeScript reads no call');
  assert.strictEqual(counts.accepted, counts.valid, 'every page with an element value and a real call is accepted');
});

// A closing tag is `</`, a name and a `>`, and white space and comments stand between them: a `>` in a comment ends nothing. In every frame an element can stand, with a comment before the name,
// around the dots of a dotted one, before the `>`, a line comment, and in each of the places a closing tag can be — the text of an element, a nested element, an attribute's value — a comment that holds
// the text of a call and a `>`.
test('sweep (a comment in a closing tag, TypeScript parser): a ">" in it ends nothing, and its call is a comment', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const text = `> ${BODY}; `;
  const comments = [`/*${text}*/`, `// ${text}\n`, `/* ${text} */ /* > */`, `/*${text}*/ // >\n`, `/* </A> ${text}*/`];
  const tags = [
    (c) => `<A>x</A ${c}>`, (c) => `<A></ ${c} A>`, (c) => `<A></A ${c}>`, (c) => `<A.B></A ${c} . ${c} B>`, (c) => `<></ ${c}>`, (c) => `<a:b></a:b ${c}>`, (c) => `<a-b></a-b ${c}>`,
    (c) => `<A><B></B ${c}></A ${c}>`, (c) => `<A x=<B></B ${c}>>t</A ${c}>`, (c) => `<A>{<B/>}<B>y</B ${c}></A>`, (c) => `<this></this ${c}>`, (c) => `<A>text <b>bold</b ${c}> more</A>`,
  ];
  const places = ['const e = @;', 'f(@);', 'const p = <p>{@}</p>;', 'const t = `${@}`;', 'function g() { return @; }', 'const h = () => @;', 'export default @;'];
  const trailers = [' const re = /' + REGEX_BODY + '/; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});', ' navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});'];
  const programs = [];
  for (const place of places) {
    for (const make of tags) {
      for (const comment of comments) {
        for (const trailer of trailers) {
          const element = make(comment);
          programs.push({ code: `declare const f: any;\n${place.replace('@', element)}${trailer}`, label: `${place} / ${element}` });
        }
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 500, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(reading.stats.guessed, 0, `a page with a comment in a closing tag was guessed at: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly');
});

// A hashbang: `#!` at offset 0 is trivia to TypeScript, to the end of its line; anywhere else it is an error. A token or a call in it is text.
test('sweep (a hashbang, TypeScript parser): a "#!" at the start of the file is a comment to the end of its line, and nowhere else', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const lines = [
    `#!${BODY};`, `#!${CALL}`, '#!/usr/bin/env node', '#!', `#!/* ${BODY} */`, `#! // ${BODY}`, `#!${BODY}; /*`, `#!'${BODY}`, `#!\`${BODY}`, `#!<A>${BODY}`, `#!${BODY}; //`, `#!/${BODY}/`,
  ];
  const terminators = ['\n', '\r\n', '\r', '\u2028', '\u2029', '\n\n'];
  const rests = [
    'export default () => null;', `const re = /${REGEX_BODY}/; export default () => null;`, `export default () => { ${BODY}; return null; };`, `${CALL}\nexport default () => null;`,
    `/* c */ ${CALL}`, `<p>${BODY}</p>;`, `const e = <A>x</A>; ${CALL}`,
  ];
  const programs = [];
  for (const line of lines) for (const terminator of terminators) for (const rest of rests) programs.push({ code: `${line}${terminator}${rest}\n`, label: JSON.stringify(line) });
  // Not a hashbang anywhere but offset 0: TypeScript rejects each of these, so none is a page.
  for (const lead of ['\ufeff', ' ', '\n', '\t', '\r\n', '/* c */ ', '// c\n']) {
    for (const rest of rests) assert.strictEqual(cleanSourceFile(ts, `${lead}#!x\n${rest}\n`), null, `TypeScript rejects a "#!" after ${JSON.stringify(lead)}`);
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 200, `only ${reading.stats.valid} programs were valid`);
  assert.strictEqual(reading.stats.guessed, 0, `a hashbang was guessed at: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly: the token in the hashbang is stray, the real call is seen');
});

// What the lexer read decides a `/` or `<` after a regex, an element or a division, whatever stands between them: every operand that ends in a `/` or a `>` the lexer read, every operator that can follow
// it, in every frame and after every separator TypeScript skips, with a regex that holds the text of a call after it, and a real call. TypeScript says which are pages.
test('sweep (a "/" or "<" after a regex, an element or a division, TypeScript parser): every token is read where TypeScript reads it, with no guess', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const operands = ['/x/', '/x/g', '/[/]/', '/\\//', '<b/>', '<b>t</b>', '<></>', '<a><b/></a>', '<b>{1}</b>', 'a', 'a / b', '(a)', 'a[0]', '1', '"s"', 'f(x)', 'x!'];
  const operators = ['/', '<', '< ', '/ /x/ /', '/ <b/> /', '/ /x/ <', '<=', '</'];
  const rightHand = ['2', 'y', `/${REGEX_BODY}/`, `/${REGEX_BODY}/.source`, '<b>t</b>', '/y/'];
  const separators = ['', ' ', '\n', '/* c */', '\u0085'];
  const places = ['const n = @;', 'const p = <p>{@}</p>;', 'function g() { return @; }', 'const t = `${@}`;'];
  const trailer = ` const re = /${REGEX_BODY}/; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});`;
  const programs = [];
  for (const place of places) {
    for (const operand of operands) {
      for (const operator of operators) {
        for (const separator of separators) {
          for (const right of rightHand) {
            const expression = `${operand}${separator}${operator}${separator}${right}`;
            // A `/` that begins a comment is no operator, and a `<` or `</` after the end of an element is a page TypeScript does not read the way a comparison reads: both are dropped by TypeScript.
            programs.push({ code: `declare const a: any, b: any, c: any, f: any, x: any, y: any;\n${place.replace('@', expression)}${trailer}`, label: `${place} / ${JSON.stringify(expression)}` });
          }
        }
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 2000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  // The guesses that are left are the ones no lexer could make certain: a `>` (type arguments, a comparison), an operand on an earlier line. A `/` or `<` after something this lexer read is no guess.
  assert.ok(!reading.kinds.has('operator'), `a "/" or "<" after a regex, an element or a division was guessed at: ${guessSummary(reading.kinds)}`);
  assert.ok(reading.stats.exact >= 0.8 * reading.stats.valid, `only ${reading.stats.exact} of ${reading.stats.valid} valid pages were read exactly (${guessSummary(reading.kinds)})`);
});

// `async` and a `<` on its line: TypeScript never reads an element there (the arrow rule decides what is an async arrow, and every other `<` is a method's type parameters, a comparison or the type
// arguments of a call). Every head kind, in an object literal, a class, an expression and a statement, after every separator, with a regex and a string that hold the text of a call and a real call.
test('sweep (a "<" after `async`, TypeScript parser): TypeScript reads no element there, no token is read as TypeScript does not, and no guess is made on its line', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const heads = [
    '<T,>(x: T) => MARK', '<T extends X>(x: T) => MARK', '<T = X>(x: T) => MARK', '<const T,>(x: T) => MARK', '<T>(x: T) { return MARK; }', '<T>(x: T): T { return MARK; }', '<T extends X>(x: T) { return MARK; }',
    '<T,>(x: T) { return MARK; }', '<T>(MARK)', '<T extends X>(MARK)', '<T>MARK</T>', '<div>MARK</div>', '<T extends X>MARK</T>', '<T extends>MARK</T>', '<T extends/>', '<b/>',
    '<T>(x: T) => MARK', '<T extends X>(x: T): T => MARK',
  ];
  const places = [
    'const f = @;', 'export default @;', 'foo(@);', 'const f = [@];', 'const f = { k: @ };', 'const f = c ? @ : null;', 'let f; f = @;', '@;', 'const o = { @ };', 'const o = { a: 1, @ };',
    'class C { @ }', 'class C { static @ }', 'class C { x = 1; @ }', 'const f = () => @;', 'function g() { return @; }',
  ];
  const separators = ['', ' ', '\t', '\u00a0', '\u0085', '\u200b', ' /* c */ ', '\n', ' // c\n '];
  const trailer = ` const re = /${REGEX_BODY}/; const s = '</T></div>;navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});//'; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});`;
  const programs = [];
  for (const place of places) for (const separator of separators) for (const head of heads) programs.push({ code: `declare const T: any, X: any, c: any, foo: any, MARK: any;\n${place.replace('@', `async${separator}${head}`)}${trailer}`, label: `${place} / ${JSON.stringify(separator)} / ${head}`, separator });
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 600, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  let sameLine = 0;
  let elements = 0;
  for (const program of programs) {
    const source = cleanSourceFile(ts, program.code);
    if (!source) continue;
    const at = program.code.indexOf('<', program.code.indexOf('async'));
    if (isElement(readingAt(ts, source, at)) && !/[\n\u2028]/.test(program.separator)) elements += 1;
    if (/[\n\u2028]/.test(program.separator)) continue;
    sameLine += 1;
    assert.deepStrictEqual(guessesOf(program.code).filter(([where]) => where <= at), [], `a guess on the line of \`async\`: ${program.label}`);
  }
  assert.strictEqual(elements, 0, 'TypeScript reads an element after `async` and a `<` on its line');
  assert.ok(sameLine >= 400, `only ${sameLine} valid programs have the \`<\` on the line of \`async\``);
});

// `<T>(x)` that neither an arrow nor a colon follows is a call signature with no return type where a type holds members, and the text of an element that starts with a parenthesis in an expression;
// TypeScript parses both, and the lexer tells them apart (callSignatureOrElement). A signature read for an element reads the rest of the type as JSX text up to the closing tag of a decoy after it
// — a string, a template, a comment, a regex that holds `</T>` and the text of a call — takes that call for code, and rewrites a token that is data. Every shape of a signature in every place a type
// with members stands (tests/helpers/angle-frames.js), followed by every ending that ends its member or goes on to another and by each decoy; TypeScript says which are pages and which tokens are data.
test('sweep (a call or construct signature with no return type, TypeScript parser): every token is read where TypeScript reads it, with no guess, and the decoy after the type is data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  // What TypeScript skips between the `)` and the next member: a line break of any kind ends the member, and white space of any other kind does not.
  const endings = [...new Set([...SIGNATURE_ENDINGS, ...ANY_SPACE.map((space) => `${space}m: number`)])];
  const programs = [];
  for (const [decoyName, decoy] of Object.entries(DECOYS)) for (const page of signaturePages(endings, decoy)) programs.push({ ...page, label: `${decoyName} / ${page.label}` });
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 12000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.ok(reading.stats.dataTokens >= 12000 && reading.stats.realTokens >= 12000, `${reading.stats.dataTokens} tokens were data and ${reading.stats.realTokens} real`);
  // The signature is code, for certain: no guess at all, so every valid page is read exactly, the token in the decoy is stray and the one call is rewritten.
  assert.strictEqual(reading.stats.guessed, 0, `a page with a signature and no hidden closing tag was guessed at: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly');
  // Where the type holds the closing tag in a string, a template or a comment, or a signature of its own, the closing tag could be that one: a guess, with every token after it refused.
  const hiding = [];
  for (const [decoyName, decoy] of Object.entries(DECOYS)) for (const page of signaturePages(HIDING_ENDINGS, decoy)) hiding.push({ ...page, label: `${decoyName} / ${page.label}` });
  const guessed = readTokens(ts, hiding);
  t.diagnostic(describeReading(guessed));
  assert.deepStrictEqual(guessed.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(guessed.stats.valid >= 2000, `only ${guessed.stats.valid} programs with a hidden closing tag were valid`);
  assert.strictEqual(guessed.stats.guessed, guessed.stats.valid, 'every valid page with a hidden closing tag is refused after a guess');
  assert.deepStrictEqual([...guessed.kinds.keys()], ['generic'], 'and the guess is the one for a parameter list');
  // The same pages are TypeScript's signatures, not elements.
  for (const page of [...programs.filter((program, index) => index % 17 === 0), ...hiding.filter((program, index) => index % 5 === 0)]) {
    const source = cleanSourceFile(ts, page.code);
    if (source) assert.ok(!isElement(readingAt(ts, source, page.at)), `TypeScript reads a signature, not an element: ${page.label}`);
  }
});

// The same text as an element, where it stays certain: JSX text that starts with a parenthesis in every place an element stands, with white space of every kind after the `)`, nested elements with
// attributes of every kind, containers with strings and objects, and a closing tag in a string, a template, a comment or a regex after it. A closing tag that could be one inside the text
// itself — a template, a comment — is a guess.
test('sweep (JSX text that starts with a parenthesis, TypeScript parser): the element is read exactly where its text can be read to its closing tag, and every decoy after it is data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const elements = [...CERTAIN_ELEMENTS, ...ANY_SPACE.map((space) => `<p>(a)${space}b</p>`), ...ANY_SPACE.map((space) => `<p>(a),${space}<b x={1}>c</b></p>`)];
  const programs = [];
  for (const [decoyName, decoy] of Object.entries(DECOYS)) for (const page of elementPages(elements, decoy)) programs.push({ ...page, label: `${decoyName} / ${page.label}` });
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 3000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(reading.stats.guessed, 0, `an element that can be read to its closing tag was guessed at: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly');
  const hiding = [];
  for (const [decoyName, decoy] of Object.entries(DECOYS)) {
    // Where a member of a type may begin at the head, a comment, a template or a regex that the text opens could hold the closing tag; a list that the scan cannot read is a guess in every place.
    for (const page of elementPages(HIDDEN_TEXT_ELEMENTS, decoy, MEMBER_ELEMENT_FRAMES)) hiding.push({ ...page, label: `${decoyName} / ${page.label}` });
    for (const page of elementPages(UNREAD_LIST_ELEMENTS, decoy)) hiding.push({ ...page, label: `${decoyName} / ${page.label}` });
  }
  const guessed = readTokens(ts, hiding);
  assert.deepStrictEqual(guessed.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.strictEqual(guessed.stats.guessed, guessed.stats.valid, 'every valid page whose text could hide its closing tag is refused after a guess');
  assert.ok(guessed.stats.valid >= 100, `only ${guessed.stats.valid} such programs were valid`);
  // After an `=`, a `(`, a `[`, a `:` or an `=>` no member of a type begins: the same texts are elements, for certain, with the decoy after them data and the real call rewritten.
  const placed = [];
  for (const [decoyName, decoy] of Object.entries(DECOYS)) for (const page of elementPages(HIDDEN_TEXT_ELEMENTS, decoy, NO_MEMBER_ELEMENT_FRAMES)) placed.push({ ...page, label: `${decoyName} / ${page.label}` });
  const certain = readTokens(ts, placed);
  t.diagnostic(`where no member begins: ${describeReading(certain)}`);
  assert.deepStrictEqual(certain.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(certain.stats.valid >= 150, `only ${certain.stats.valid} such programs were valid`);
  assert.strictEqual(certain.stats.guessed, 0, `a text read as the element it is, where no type has a member, was guessed at: ${guessSummary(certain.kinds)}`);
  assert.strictEqual(certain.stats.exact, certain.stats.valid, 'every valid page is read exactly');
  for (const page of placed.filter((program, index) => index % 7 === 0)) {
    const source = cleanSourceFile(ts, page.code);
    if (source) assert.ok(isElement(readingAt(ts, source, page.at)), `TypeScript reads an element: ${page.label}`);
  }
  for (const page of programs.filter((program, index) => index % 11 === 0)) {
    const source = cleanSourceFile(ts, page.code);
    if (source) assert.ok(isElement(readingAt(ts, source, page.at)), `TypeScript reads an element: ${page.label}`);
  }
});

// A label and a list that TypeScript rejects as one, and a default value that the scan reads exactly (failingLists, defaultLists in helpers/angle-frames.js). Each list is JSX text after a parenthesis in the places an element stands, and
// the parameter list of a signature in the places a type with members stands (a call signature with and without a return type, a construct signature, a function type), with a decoy after it that holds the closing tag of
// the head and the text of a call. TypeScript says which programs are pages and which tokens are data: a list read as no list where TypeScript parses a signature reads the text after the signature as an element's, and the
// call in the decoy as code.
const SIGNATURE_HEADS_OF_A_LIST = ['<T>(LIST)', '<T>(LIST): T', 'new <T>(LIST)', 'm: <T>(LIST) => T'];
const listPages = (lists, { elementFrames, signatureFrames, decoys, heads = SIGNATURE_HEADS_OF_A_LIST, endings = [''], every = 1 }) => {
  const elements = [];
  const signatures = [];
  lists.forEach((list, index) => {
    if (index % every !== 0) return;
    for (const decoy of decoys) {
      for (const frame of elementFrames) elements.push({ ...elementPage(frame[1], `<p>(${list})</p>`, decoy), list, label: `element ${frame[0]} / ${JSON.stringify(list)}` });
      for (const frame of signatureFrames) {
        for (const head of heads) for (const ending of endings) signatures.push({ ...signaturePage(frame[1], head.replace('LIST', () => list), ending, decoy), list, label: `signature ${frame[0]} / ${head} / ${JSON.stringify(list)} / ${JSON.stringify(ending)}` });
      }
    }
  });
  return { elements, signatures };
};
test('sweep (a list that fails to parse, TypeScript parser): no signature parses, every token is read where TypeScript reads it, and the element is read exactly', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const keywords = [];
  for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind += 1) keywords.push(ts.tokenToString(kind));
  const lists = failingLists(keywords);
  const { elements, signatures } = listPages(lists, { elementFrames: ELEMENT_FRAMES.slice(0, 4), signatureFrames: SIGNATURE_FRAMES.slice(0, 4), decoys: [DECOYS.string, DECOYS.regex] });
  // The claim itself: TypeScript parses none of these lists as the parameters of a call signature, a construct signature or a function type, in any place that holds one.
  const asSignatures = readTokens(ts, signatures);
  t.diagnostic(`${lists.length} lists as signatures: ${describeReading(asSignatures)}`);
  assert.ok(asSignatures.stats.generated >= 10000, `only ${asSignatures.stats.generated} signature pages were built`);
  assert.deepStrictEqual(asSignatures.stats.valid, 0, 'a list that the scan reads as no list is a parameter list');
  const asElements = readTokens(ts, elements);
  t.diagnostic(`as elements: ${describeReading(asElements)}`);
  assert.deepStrictEqual(asElements.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(asElements.stats.valid >= 3000, `only ${asElements.stats.valid} element pages were valid, so the sweep proves little`);
  // A list that no signature has leaves the element certain: no guess, but for the few lists the scan leaves (a number and `extends`, a modifier before a `/`), and every other valid page is read exactly.
  assert.ok(asElements.stats.guessed > 0 && asElements.stats.guessed <= 0.03 * asElements.stats.valid, `${asElements.stats.guessed} of ${asElements.stats.valid} pages were guessed at, which the lists the scan leaves explain: ${guessSummary(asElements.kinds)}`);
  assert.deepStrictEqual([...new Set(asElements.guessedPrograms.map((page) => page.list).filter((list) => !LEFT_LISTS.test(list)))], [], 'an element whose list fails was guessed at');
  for (const page of elements.filter((program, index) => index % 31 === 0)) {
    const source = cleanSourceFile(ts, page.code);
    if (source) assert.ok(isElement(readingAt(ts, source, page.at)), `TypeScript reads an element: ${page.label}`);
  }
});

test('sweep (a default value, TypeScript parser): every token is read where TypeScript reads it, and a default the scan reads exactly leaves its element and its signature certain', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const lists = defaultLists();
  const { elements, signatures } = listPages(lists, { elementFrames: ELEMENT_FRAMES.slice(0, 3), signatureFrames: SIGNATURE_FRAMES.slice(0, 3), decoys: [DECOYS.string, DECOYS.regex, DECOYS.template], every: 2 });
  const asElements = readTokens(ts, elements);
  t.diagnostic(`${lists.length} lists as elements: ${describeReading(asElements)}`);
  assert.deepStrictEqual(asElements.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(asElements.stats.valid >= 2000, `only ${asElements.stats.valid} element pages were valid, so the sweep proves little`);
  assert.ok(asElements.stats.exact >= 0.25 * asElements.stats.valid && asElements.stats.guessed >= 0.1 * asElements.stats.valid, `${asElements.stats.exact} read exactly and ${asElements.stats.guessed} guessed: both are met`);
  const asSignatures = readTokens(ts, signatures);
  t.diagnostic(`as signatures: ${describeReading(asSignatures)}`);
  assert.deepStrictEqual(asSignatures.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(asSignatures.stats.valid >= 2000 && asSignatures.stats.exact >= 0.25 * asSignatures.stats.valid, `${asSignatures.stats.exact} of ${asSignatures.stats.valid} signature pages were read exactly`);

  // The defaults the scan reads exactly are read exactly: an element with one of them is certain, in every place an element stands, and so is the type that holds it as a call signature or a construct signature with no
  // return type (a function type and a return type leave the guesses they always did: `<T>(x): T` is JSX text as well). The page of a type has its closing tag in the decoy only, so nothing is hidden in the list.
  // An element whose text starts with a parenthesis and a colon is exact as an element's text only: in the code of a signature the scan of the page reads it as a call signature that a colon follows.
  const exactLists = exactDefaultLists();
  const codeLists = exactLists.filter((list) => !EXACT_DEFAULTS.elementText.some((value) => list.endsWith(value)));
  const exact = listPages(exactLists, { elementFrames: ELEMENT_FRAMES, signatureFrames: [], decoys: [DECOYS.string, DECOYS.regex, DECOYS.template] });
  const exactCode = listPages(codeLists, { elementFrames: [], signatureFrames: SIGNATURE_FRAMES.slice(0, 4), heads: ['<T>(LIST)', 'new <T>(LIST)'], decoys: [DECOYS.string, DECOYS.regex, DECOYS.template] });
  for (const [what, pages] of [['elements', exact.elements], ['signatures', exactCode.signatures]]) {
    const certain = readTokens(ts, pages);
    t.diagnostic(`exact defaults as ${what}: ${describeReading(certain)}`);
    assert.deepStrictEqual(certain.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
    assert.ok(certain.stats.valid >= 3000, `only ${certain.stats.valid} ${what} pages were valid, so the sweep proves little`);
    assert.deepStrictEqual(certain.guessedPrograms.slice(0, 5).map((page) => page.label), [], `a page whose default is read exactly was guessed at (${what})`);
    assert.strictEqual(certain.stats.exact, certain.stats.valid, 'every valid page is read exactly');
  }
});

// A signature whose own parameter list holds the closing tag of its head in a string, a template or a comment: `interface I { <T>(x: "</T>") }` is a call signature, and `const e = <T>(x: "</T>;` is an
// element, and both parse with no diagnostic — the text up to the closing tag is the same. So a closing tag that the type reads inside a string, a template or a comment is a guess, whatever follows the `)`.
const HIDING_HEADS = ['<T>(x: "</T>")', "<T>(x: '</T>')", '<T>(x: `</T>`)', '<T>(x /* </T> */)', '<T>(x = "</T>")', '<T>(x: "a</T>b", y)', '<T>(x // </T>\n)', '<T>(x: "\\"</T>")', "<T>(x: '\\'</T>')", '<T>(x: "</T>"): void'];
test('sweep (a call signature whose parameter list holds its own closing tag, TypeScript parser): the closing tag in a string, a template or a comment is a guess, and the call after it is never rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const endings = ['', ';', ',', '\n', ';\n  m: number', '\n  m: number'];
  const programs = [];
  for (const [decoyName, decoy] of Object.entries(DECOYS)) {
    for (const [frameName, frame] of SIGNATURE_FRAMES) {
      for (const head of HIDING_HEADS) {
        for (const ending of endings) {
          const code = `${frame.replace('@', `${head}${ending}`)}\n${decoy.replaceAll('NAME', 'T')}\n${SWEEP_CALL}\n`;
          programs.push({ code, label: `${decoyName} / ${frameName} / ${head} / ${JSON.stringify(ending)}`, at: frame.indexOf('@') });
        }
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 2500, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  // Every one has a closing tag in a string, a template or a comment of its parameter list, so every one is a guess (the `: void` form is one whose return type TypeScript reads, and both compile).
  assert.strictEqual(reading.stats.guessed, reading.stats.valid, 'a head that holds its closing tag was read with no guess');
  assert.deepStrictEqual([...reading.kinds.keys()], ['generic'], 'and the guess is the one for a parameter list');
  // And they are TypeScript's signatures, not elements.
  for (const page of programs.filter((program, index) => index % 13 === 0)) {
    const source = cleanSourceFile(ts, page.code);
    if (source) assert.ok(!isElement(readingAt(ts, source, page.at + page.code.slice(page.at).indexOf('<T>'))), `TypeScript reads a signature: ${page.label}`);
  }
});

// A regex after a line comment (commentedDefaultLists, commentedConstraintLists, commentedMemberEndings and commentedArrowContinuations in helpers/angle-frames.js). The scan of a parameter list reads a `/` after a name or a number
// as a division, and a line comment ends in a name, a number or a `$` and is trivia to TypeScript, so a `/` that follows one on the next line — after an operator, a keyword or a bracket — begins a regex, whose `)` or closing tag is
// not the end of the list or of the text:
//   interface I { <T>(a = 1 + // fallback
//   /[)]/); m: '</T>;navigateTo(…);//' }
// Each family is a place that meets such a regex, with comments that end in a name, a number, a `$`, a letter beyond ASCII, a sign and nothing, and a line break of every kind, and a decoy after it that holds the closing tag of the head and
// the text of a call — and, where the text of a signature is read to its closing tag, a regex that holds both. TypeScript says which programs are pages and which tokens are data; a division after a name or a number, which is as valid, is
// in every family that scans a list.
test('sweep (a regex after a line comment, TypeScript parser): every token is read where TypeScript reads it, and a `/` after a line comment is never a division', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const { elements, signatures } = listPages([...commentedDefaultLists(), ...commentedConstraintLists()], { elementFrames: ELEMENT_FRAMES.slice(0, 2), signatureFrames: SIGNATURE_FRAMES.slice(0, 3), decoys: [DECOYS.string, DECOYS.regex], every: 3 });
  // The text of a call signature with no return type is read to its closing tag: a later member's default holds the regex, and the regex holds the closing tag and a call.
  const endings = commentedMemberEndings();
  const members = SIGNATURE_FRAMES.slice(0, 4).flatMap(([frameName, frame]) => ['<T>(x)', 'new <T>(x)'].flatMap((head) => endings.map((ending) => ({ ...signaturePage(frame, head, ending, DECOYS.string), label: `${frameName} / ${head} / ${JSON.stringify(ending)}` }))));
  // A generic arrow after each token that leaves a `<` undecided, in the frames where the token and the arrow make a program, and a string that holds a closing tag and a call as the text after it.
  const after = `; const s = '</T>;navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});//'; const re = /${REGEX_BODY}/; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});`;
  const tokenFrames = [['>=', ['type arguments, closed before the token']], ['>>=', ['binary', 'nested type arguments, closed before the token']], ['in', ['for-in head']], ['<', ['type arguments, of a call']],
    ['yield *', ['generator']], ['void', ['annotation']]];
  const arrows = tokenFrames.flatMap(([token, names]) => [...labelled(programsFor(token, { after, frames: FRAMES.filter((frame) => names.includes(frame.name)), continuations: commentedArrowContinuations() }))]);
  const families = [['lists as elements', elements, 1000], ['lists as signatures', signatures, 6000], ['the text of a signature with no return type', members, 900], ['arrows after a token that leaves a `<` undecided', arrows, 1500]];
  const refusedAfterAGuess = [];
  for (const [what, programs, least] of families) {
    const reading = readTokens(ts, programs);
    t.diagnostic(`${what}: ${describeReading(reading)}`);
    assert.deepStrictEqual(reading.problems.slice(0, 5), [], `${what}: every token is read where TypeScript reads it`);
    assert.ok(reading.stats.valid >= least, `${what}: only ${reading.stats.valid} programs were valid, so the sweep proves little`);
    refusedAfterAGuess.push([what, reading.stats.guessed, reading.stats.valid]);
  }
  // The regex after a comment is a guess wherever a scan or a reading of a signature's text meets one, so nearly every valid page of the signatures and of the text of a signature is refused after it: what is read exactly is a function
  // type whose list holds a regex with no `)` of its own, where the element reading of the text fails at the arrow.
  for (const [what, guessed, valid] of refusedAfterAGuess.filter(([name]) => /signature/.test(name))) assert.ok(guessed >= 0.9 * valid, `${what}: ${guessed} of ${valid} valid programs were refused after a guess`);
  for (const page of members.filter((program, index) => index % 17 === 0)) {
    const source = cleanSourceFile(ts, page.code);
    if (source) assert.ok(!isElement(readingAt(ts, source, page.at)), `TypeScript reads a signature: ${page.label}`);
  }
});

// JSX text that starts with a parenthesis and runs over several lines, one with a `//` in it and a line that starts with a `/` after it (PROSE_COMMENT_LINES, PROSE_PATHS in helpers/angle-frames.js):
//   const e = <p>(optional);
//     https://contoso.com
//     /docs</p>;
// A type that has the same text for its members reads `//` as a comment, so the `/` on the last line follows the token before the comment — the colon of `https:`, where a type must follow, or a name — and begins
// no regex that could hold the closing tag: only the element compiles, and it is read for certain, with the decoy after it (a string, a template, a comment, a regex that holds `</p>` and a call) data. The base read the
// last word of the comment for the token before the `/`, and a lexer that read the comment as nothing refused every such page: the family must stay resolved. The line before the `//` may begin with a parenthesis, a bracket,
// a quote, a tag or an operator, end in a postfix `!`, a call or an index, have a number with a `.` or an exponent sign, or start with a modifier (PROSE_SHAPED_LINES): each fails as the members of a type, so those pages are
// read for certain too; where the closing tag could be in the comment (PROSE_HIDING_ELEMENTS, PROSE_HIDING_ENDINGS), a type with the same text compiles
// too, and the page is a guess.
test('sweep (JSX text of lines, one with a `//` in it, and a line that starts with a `/`, TypeScript parser): the element is read exactly where no type can have its text, and a guess is made where one can', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  // (The double-quoted string is left out: the text of a call has quotes of its own, and no page holds it.)
  const decoys = Object.entries(DECOYS).filter(([name]) => name !== 'double-quoted string');
  // Each element in one place and with one decoy, the places and the decoys taken in turn: the whole family is read, in every frame and after every decoy.
  const placed = (elements, frames = ELEMENT_FRAMES) => elements.map((element, index) => {
    const [frameName, frame] = frames[index % frames.length];
    const [decoyName, decoy] = decoys[Math.floor(index / frames.length) % decoys.length];
    return { ...elementPage(frame, element, decoy), label: `${decoyName} / ${frameName} / ${JSON.stringify(element)}` };
  });
  const base = loadBaseLexer();
  const family = readTokens(ts, placed([...proseElements()]), base);
  t.diagnostic(`lines with a comment, a path after them: ${describeReading(family)}`);
  assert.deepStrictEqual(family.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(family.stats.valid >= 4500, `only ${family.stats.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(family.stats.guessed, 0, `a text that no type can hold was guessed at: ${guessSummary(family.kinds)}: ${JSON.stringify(family.guessedPrograms.slice(0, 3).map((program) => program.label))}`);
  assert.strictEqual(family.stats.exact, family.stats.valid, 'every valid page is read exactly');
  assert.deepStrictEqual(family.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  // The lines that begin with a parenthesis, a bracket, a quote, a tag or an operator, end in a postfix `!`, a call or an index, have a number with a `.` or an exponent sign, or start with a modifier are read token by token
  // (typeMembersFail): each fails as the members of a type where a member begins or after a name, or at the `/` after the comment, so they are certain too.
  const shaped = readTokens(ts, placed([...proseElements({ lines: PROSE_SHAPED_LINES, ends: ['</p>'] })]), base);
  t.diagnostic(`lines that begin or end with a bracket, a quote, a tag, an operator, a postfix or a number: ${describeReading(shaped)}`);
  assert.deepStrictEqual(shaped.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(shaped.stats.valid >= 2000, `only ${shaped.stats.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(shaped.stats.guessed, 0, `a text that no type can hold was guessed at: ${guessSummary(shaped.kinds)}: ${JSON.stringify(shaped.guessedPrograms.slice(0, 3).map((program) => program.label))}`);
  assert.strictEqual(shaped.stats.exact, shaped.stats.valid, 'every valid page is read exactly');
  assert.deepStrictEqual(shaped.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  // Where the closing tag could be in the comment, as an element and as the members of a type, both compile and the page is a guess — where a member of a type may begin at the head. After an `=`, a `(`, a `[`, a `:` or an `=>` none can,
  // and the same pages are elements for certain.
  const hidingElements = PROSE_HIDING_ELEMENTS.flatMap((element) => Array.from({ length: MEMBER_ELEMENT_FRAMES.length * decoys.length }, () => element));
  const hiding = readTokens(ts, placed(hidingElements, MEMBER_ELEMENT_FRAMES));
  assert.deepStrictEqual(hiding.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(hiding.stats.valid >= 100, `only ${hiding.stats.valid} programs with a closing tag in a comment were valid`);
  assert.strictEqual(hiding.stats.guessed, hiding.stats.valid, 'a closing tag that the comment could hold is a guess');
  const unhidden = readTokens(ts, placed(PROSE_HIDING_ELEMENTS.flatMap((element) => Array.from({ length: NO_MEMBER_ELEMENT_FRAMES.length * decoys.length }, () => element)), NO_MEMBER_ELEMENT_FRAMES));
  assert.deepStrictEqual(unhidden.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(unhidden.stats.valid >= 100, `only ${unhidden.stats.valid} programs with a closing tag in a comment were valid`);
  assert.strictEqual(unhidden.stats.guessed, 0, `an element where no member of a type begins was guessed at: ${guessSummary(unhidden.kinds)}`);
  assert.strictEqual(unhidden.stats.exact, unhidden.stats.valid, 'every valid page is read exactly');
  // The lines whose `//` stands behind an open `[`, an initializer's `=` after a `?` or a type, or one in a parameter list, and a path on the next line: a regex may begin at the path's `/`, and the closing tag may be inside it, so where a member of a
  // type may begin at the head both programs compile and the page is a guess. The base read the word that ends the comment for the token before the `/` and resolved them — the pages this lexer cannot read for certain. Where no member begins
  // the element is the only reading, and is read exactly, as the base reads it.
  const openElements = [...proseElements({ leads: [';\n  ', ','], lines: PROSE_OPEN_LINES, paths: ['/b', '/ x'], ends: ['</p>'] })];
  const refusedOpen = readTokens(ts, placed(openElements.flatMap((element) => Array.from({ length: MEMBER_ELEMENT_FRAMES.length * decoys.length }, () => element)), MEMBER_ELEMENT_FRAMES), base);
  t.diagnostic(`lines that end in an open bracket or an initializer, where a member may begin: ${describeReading(refusedOpen)}`);
  assert.deepStrictEqual(refusedOpen.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(refusedOpen.stats.valid >= 300, `only ${refusedOpen.stats.valid} programs were valid`);
  assert.strictEqual(refusedOpen.stats.guessed, refusedOpen.stats.valid, 'a regex after the comment could hold the closing tag: a guess');
  const certainOpen = readTokens(ts, placed(openElements.flatMap((element) => Array.from({ length: NO_MEMBER_ELEMENT_FRAMES.length * decoys.length }, () => element)), NO_MEMBER_ELEMENT_FRAMES), base);
  t.diagnostic(`the same lines, where no member begins: ${describeReading(certainOpen)}`);
  assert.deepStrictEqual(certainOpen.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(certainOpen.stats.valid >= 300, `only ${certainOpen.stats.valid} programs were valid`);
  assert.strictEqual(certainOpen.stats.guessed, 0, `an element where no member of a type begins was guessed at: ${guessSummary(certainOpen.kinds)}`);
  assert.strictEqual(certainOpen.stats.exact, certainOpen.stats.valid, 'every valid page is read exactly');
  assert.deepStrictEqual(certainOpen.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  // The members of a type with the same text: a closing tag in a comment is a guess and the decoy after the type is data; where there is none, the type is code for certain.
  const types = [];
  for (const [decoyName, decoy] of decoys) for (const page of signaturePages(PROSE_HIDING_ENDINGS, decoy)) if (['<T>(x)', 'new <T>(x)', '<T>()'].some((head) => page.label.includes(` / ${head} / `))) types.push({ ...page, label: `${decoyName} / ${page.label}` });
  const hidden = readTokens(ts, types);
  t.diagnostic(`members of a type with a closing tag in a comment: ${describeReading(hidden)}`);
  assert.deepStrictEqual(hidden.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(hidden.stats.valid >= 700, `only ${hidden.stats.valid} types with a closing tag in a comment were valid`);
  assert.strictEqual(hidden.stats.guessed, hidden.stats.valid, 'a type that holds the closing tag in a comment is refused after a guess');
  const code = readTokens(ts, signaturePages(PROSE_TYPE_ENDINGS, DECOYS.string).filter((page, index) => index % 3 === 0));
  assert.deepStrictEqual(code.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(code.stats.valid >= 250, `only ${code.stats.valid} types were valid`);
  assert.strictEqual(code.stats.exact, code.stats.valid, 'a type with no closing tag in it is code, for certain');
  // They are TypeScript's signatures, not elements.
  for (const page of types.filter((program, index) => index % 7 === 0)) {
    const source = cleanSourceFile(ts, page.code);
    if (source) assert.ok(!isElement(readingAt(ts, source, page.at)), `TypeScript reads a signature, not an element: ${page.label}`);
  }
});

// ─── What the text after a signature can hold: a number for a name, a nested element, the lines of a prose element in an expression ─────────────────────
//
// The text after the `)` of `<T>(x)` is read to the closing tag `</T>`: an element ends there, and a type that has the same text for its members may hold the closing tag in a string, a template, a comment or a
// regex, so that the text of a call after it is data. The sweeps below put pages for each shape (helpers/hidden-closing-pages.js) in front of TypeScript's parser and ask it per token: a token it reads as data is
// stray, and a lexer that names no guess rewrites exactly the real calls. Where the base (BASE_LIB_PATH) is given, the pages that it misreads show that the sweep sees a misread, and a page that it reads
// exactly is read exactly here.

// `1e-5` is ONE numeric literal to the scanner (scanNumber), a valid name for a member. A reading that took `1e` for a name and the `-` for a sign said that no type has the text, and that the closing tag in the
// string after it is no string's: the page was read as an element, and the call in the string was rewritten.
test('sweep (a member named by a number, TypeScript parser): a decimal literal with a signed exponent is one name, so the closing tag that its type holds is hidden and the token in it is data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const pages = numberedMemberPages();
  const reading = readTokens(ts, pages, base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 6000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  // A type that holds the closing tag in a string, a template or a comment is refused after a guess — and the one that holds it in an object type, `{ a: '</T>…' }`, which no element has for text, is code for certain. A page
  // read as an element would have the call in its string rewritten, and `problems` says so.
  assert.ok(reading.stats.guessed >= 0.8 * reading.stats.valid, `only ${reading.stats.guessed} of ${reading.stats.valid} valid programs were refused after a guess`);
  assert.strictEqual(reading.stats.guessed + reading.stats.exact, reading.stats.valid, 'a page is read exactly or refused after a guess');
  // The names that the scanner reads as one token with a sign in it are the ones a reading that stops at the sign gets wrong: they are a large part of the valid pages.
  const signed = pages.filter((page) => /[eE][+-][0-9]/.test(page.name) && tokenReading(ts, page.code) !== null);
  assert.ok(signed.length >= 2000, `only ${signed.length} valid pages have a name with a signed exponent`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  // A sign that no digit follows is no part of the number (TS1124), and a hex literal has no exponent: neither is a valid name, so the pages are no type's.
  const named = (name) => `interface I { <T>(x); ${name}: '</T>;${CALL}' }\n${CALL}\n`;
  for (const name of ['1e5', '1e+5', '1e-5', '1_0E+1', '.5e-1']) assert.notStrictEqual(tokenReading(ts, named(name)), null, `${name} is a member name`);
  for (const name of ['1e+x', '1e+', '0x1e+5', '1e-']) assert.strictEqual(tokenReading(ts, named(name)), null, `${name} is no member name`);
});

// A nested element in an expression of a member — a default value, a computed name, an initializer — is JSX text to a type that reads it as an element, which has no comment or string in it, and code goes on
// after its closing tag. Read as code, `x // y</b> +` is a comment up to the end of its line, and the `/` on the next line a division; and `<b>'x</b> + '` is a string, which hides the quote that opens the string
// that holds the closing tag and the text of a call. The text of the nested element opens things that end with it (and the base misreads a part of these pages too: its scan skipped past the nested closing tag).
test('sweep (the text of a nested element in a default value or a computed name, TypeScript parser): what it opens ends with the element, and the closing tag that a later string, template or regex holds is hidden', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const reading = readTokens(ts, nestedTextPages(20261120, 36000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 5000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.ok(reading.stats.guessed >= 0.9 * reading.stats.valid, `${reading.stats.guessed} of ${reading.stats.valid} valid programs were refused after a guess`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  // The base calibrates the sweep: it reads a part of these pages wrong, and this lexer reads none of them.
  if (base) assert.ok(reading.stats.baseMisread >= 200, `the base misreads ${reading.stats.baseMisread} pages, so the sweep may not see a misread`);
});

// A literal that holds the text of an element — `'<b>c</b>'`, or `<b>` in one string and `</b>` in the next — is a token of the type, and the tags in it are no element's. The element reading takes them for tags that open and
// close, and a lexer that took the depth they make for the depth of the type's own text ended what a nested element opened at the wrong place: the template after the second literal was read as code, and the closing tag
// in it as an element's. The tags in the literals open and close in the element reading and in no other.
test('sweep (a literal that holds the tags of an element, TypeScript parser): the tags in a string, a template, a regex or a comment are no element\'s, and the closing tag a later literal holds is hidden', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const reading = readTokens(ts, literalTagPages(20261122, 36000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 5000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  if (base) assert.ok(reading.stats.baseMisread >= 100, `the base misreads ${reading.stats.baseMisread} pages, so the sweep may not see a misread`);
});

// The text of a nested element, drawn from quotes, back-ticks, comment openers, tags, containers and words, is JSX text to a type that reads the element and code to a reading that does not, and its tags and literals may be
// one thing in the one and another in the other: wherever either reading hides the closing tag that a later literal holds, it is hidden, and no token in the literal is rewritten.
test('sweep (the text of a nested element as a soup of quotes, comments and tags, TypeScript parser): either reading of the text may hide the closing tag, and no token is rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const reading = readTokens(ts, nestedSoupPages(20261123, 60000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 4000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  if (base) assert.ok(reading.stats.baseMisread >= 200, `the base misreads ${reading.stats.baseMisread} pages, so the sweep may not see a misread`);
});

// A nested tag that no element has — the type arguments of a name, a comparison, the type parameters of a signature or a method — is code to a type, and what looks like its closing tag is in a string before it. The element
// reading closes the nested element there and takes the quote after it for text, where the type ends a string and starts the next, which holds the closing tag of the head and a call: the token in it is data, and the page is
// refused, with the guess at the head, wherever the closing tag of the head could be inside it.
test('sweep (a nested tag that no element has, TypeScript parser): the type arguments, comparison or type parameters before a string that holds the nested closing tag leave the closing tag of the head hidden', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const reading = readTokens(ts, nestedCodePages(20261124, 60000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 4000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  if (base) assert.ok(reading.stats.baseMisread >= 100, `the base misreads ${reading.stats.baseMisread} pages, so the sweep may not see a misread`);
});

// After type arguments, a comparison or the type parameters of a signature the text is code, and a string that holds tags — a fragment, a tag with an attribute, a closing tag — holds them as text. The element reading takes
// them for tags, and a closing tag in the next string would cut it: the quotes that pair as the type reads them pair differently, and the string that holds the closing tag of the head is read as code. Every page that
// TypeScript parses has the decoy in a literal, so no token in it may be rewritten.
test('sweep (tags that stand in strings after type arguments, TypeScript parser): the tags are text to the type, and the closing tag of the head that a string holds is hidden', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const reading = readTokens(ts, taggedStringPages(20261125, 60000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 10000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
});

// The words in a nested tag decide whether a type can read it as code: a modifier (`<public U>(y): T`), an operator (`x <a in b> y`, `x <typeof U> \`t\``), a type operator (`Array<keyof X>`), a dotted or dashed name with one of
// them, a line break before an `=` (`<a`, `href` and `="/x">` on three lines: a member of a type, and another with an initializer), and an empty pair of angle brackets (`<>(y)`, `f(x)<>`, `a[0]<>`, `a!<>`, `'s'<>`, `{}<>`, and
// `f // note:` and a line break, then `<> || …`). The pages draw the tag from every keyword TypeScript has, joined to a name, a dot, a dash or a value, and from the words that no keyword
// is — not only the tags that the lexer's rule already calls code — in every place a tag stands: as the type parameters or arguments of a signature, a name or a call, as a comparison, and as an element. The closing tag of the nested
// element is in a string before the one that holds the closing tag of the head, where it is a type's.
test('sweep (the words of a nested tag and a fragment after an operand, TypeScript parser): a tag that a type can read as code leaves the closing tag of the head hidden, whatever its words, and no token is rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const keywords = [];
  for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind += 1) keywords.push(ts.tokenToString(kind));
  const pages = nestedTagPages(20261201, 40000, keywords);
  const reading = readTokens(ts, pages, base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 5000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  // The sweep meets each family: tags with a keyword among their words and fragments after an operand, valid to the parser.
  const valid = pages.filter((page) => tokenReading(ts, page.code) !== null);
  assert.ok(valid.filter((page) => page.what.startsWith('fragment')).length >= 800, 'fragments after an operand');
  assert.ok(valid.filter((page) => page.what.startsWith('tag')).length >= 3000, 'tags');
  assert.ok(valid.filter((page) => page.what.startsWith('tag') && /\\[nru]/.test(page.what)).length >= 1000, 'tags with a line break in them');
  assert.ok(valid.filter((page) => page.what.startsWith('tag') && /\\n(?:[^"\\]|\\[^n])*\\n="|\\r\\n[^"]*\\r\\n=|\\r[^"]*\\r=/.test(page.what)).length >= 150, 'tags with a line break before an `=`');
  assert.ok(valid.filter((page) => page.what.startsWith('fragment') && /\/\/ ?(note|c)/.test(page.what)).length >= 500, 'fragments after a line comment');
  assert.ok(valid.filter((page) => keywords.some((word) => page.what.includes(`"${word} `) || page.what.includes(` ${word}"`) || page.what.includes(` ${word} `))).length >= 1000, 'tags with a keyword among their words');
  if (base) assert.ok(reading.stats.baseMisread >= 100, `the base misreads ${reading.stats.baseMisread} pages, so the sweep may not see a misread`);
});

// Two or three nested elements, each with a comment opener, a quote or a back-tick in its text, in a default value, a computed name or an initializer. The region that each text opens may end where another's ends — two `//` comments on
// one line, a template and a comment, a string and a comment — and a region that is open at the closing tag of an element is a place to choose between the two readings of it, told by where it starts: two with one end are two places,
// and the head's closing tag is hidden where either reading says so.
test('sweep (two nested elements whose text opens a region each, TypeScript parser): regions that end at one place are two places, and no token in the string, template or regex after them is rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const reading = readTokens(ts, nestedPairPages(20261202, 40000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 5000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  if (base) assert.ok(reading.stats.baseMisread >= 500, `the base misreads ${reading.stats.baseMisread} pages, so the sweep may not see a misread`);
});

// An import type has no line-break rule before its `(` (parseImportType): `typeof import` and a line break, then `('./m')`, is one type, where after any other type a `(` at the start of a line begins a call signature, whose first
// parameter a string is not. A lexer that took the `(` for a signature's parameter list said that no type has the text, and read the closing tag in the path, or in the string, template, comment or regex after the type, as an element's:
// the token in it was rewritten. The pages draw the two words, the `(` and the path from every kind of line terminator, space and comment, in each place a type stands.
test('sweep (an import type whose `(` stands on a later line, TypeScript parser): the `(` is the import type\'s, and the closing tag that a literal holds after it is hidden', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const reading = readTokens(ts, importTypePages(20261305, 40000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 14000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
});

// `get [a, /x/]()` is an accessor whose computed name is a comma expression with a regex in it: parseTypeMember tries `get` and `set` before an index signature, and what they take is any `[`, on any line (canFollowGetOrSetKeyword).
// After any other word, a `[`, a name and a `,` or a `:` are an index signature, and no `/` follows. A lexer that took the accessor for an index signature said that no type has the text, and read the closing tag in the regex as
// an element's. The pages draw the modifier, the word, the name and what follows it, with trivia of every kind between the tokens.
test('sweep (an accessor whose computed name holds a comma and a regex, TypeScript parser): the `[` after `get` or `set` is no index signature, and the regex that holds the closing tag hides it', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  const reading = readTokens(ts, accessorNamePages(20261306, 60000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 3500, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
});

// A keyword that is the name of an attribute with a value (`<a break="v">`, `<A.B x in="1">`) is an attribute's, whatever word comes before it: no parameter list of a type has one name after another without a comma, and no
// comparison has `a break="v"`. So no type has the tag, and its text is JSX text, in every place an element stands. The precision of the reading: none of these pages is a guess, and each is read exactly.
test('sweep (a keyword as the name of an attribute with a value, TypeScript parser): the tag is an element to every reading, so JSX text in it opens nothing and no page is refused', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const keywords = [];
  for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind += 1) keywords.push(ts.tokenToString(kind));
  const programs = [];
  for (const decoyName of ['string', 'template', 'line comment']) for (const page of elementPages(valuedKeywordElements(keywords), DECOYS[decoyName])) programs.push({ ...page, label: `${decoyName} / ${page.label}` });
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 8000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(reading.stats.guessed, 0, `a page whose tag has a valued attribute was refused after a guess: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly');
});

// The lines of a prose element after `(a);` — a bracket, a quote, a tag, an operator, a number, a modifier, a postfix — are certain where no type can have them (PROSE_SHAPED_LINES). In an expression of a type the same
// lines are a type's, and a regex after the comment may hold the closing tag: the base took the last word of the comment for the token before the `/` and read it as a division, which rewrites the token in the regex.
// This lexer refuses or reads each page exactly: a `/` after a `)` or a `]` divides, and after anything else it may begin a regex.
test('sweep (the lines of a prose element in an expression of a type, TypeScript parser): a regex after the comment may hold the closing tag, and no token in it is rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const base = loadBaseLexer();
  // The lines up to their comment: the generator adds the comment and the line break, and a path of a regex after them.
  const prefixes = [...new Set(PROSE_SHAPED_LINES.map((line) => line.replace(/ ?(?:\/\/ c|https:\/\/.*)$/, '')))];
  const keywords = [];
  for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind += 1) keywords.push(ts.tokenToString(kind));
  const lines = [...prefixes, ...keywords, 'a', 'x1', '\u00e9', '1', 'Docs', 'see', ':', '::', '=>', '>', '<', '</', '\\', '`', '${', '}', ')', ']', ',', ';'];
  const reading = readTokens(ts, expressionLinePages(lines, 20261121, 90000), base);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 1500, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.deepStrictEqual(reading.lostPrograms.slice(0, 3).map((program) => program.label), [], 'a page that the base resolves is refused');
  if (base) assert.ok(reading.stats.baseMisread >= 1000, `the base misreads ${reading.stats.baseMisread} pages, so the sweep may not see a misread`);
});

// ─── The delimiters of a tag ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// TypeScript scans the `/` and the `>` of a self-closing tag as two tokens, with trivia of every kind between them: white space, line breaks, comments (parseJsxOpeningOrSelfClosingElementOrOpeningFragment). A lexer that knew only an adjacent
// `/>` ended the tag at the `>` of an opening tag and read the text after it as the text of an element, so the closing tag of a decoy after the tag — in a string — closed an element that was never open, and the
// call in that string was read as code. Every trivia kind between the slash and the `>`, in every kind of tag, every place an element stands, and the decoys after it.
const SWEEP_CALL = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});';
const SWEEP_DECOYS = [
  ` const re = /${REGEX_BODY}/; const s = '</B></A></C>></A></B>;${SWEEP_CALL}//'; ${SWEEP_CALL}`,
  ` const t = \`</B></A>;${SWEEP_CALL}\`; /* </A> */ ${SWEEP_CALL}`,
  ` ${SWEEP_CALL}`,
];
const TAG_GAPS = [
  '', ' ', '\n', '\r\n', '\t', '\v', '\f', '\r', '\u0085', '\u00a0', '\u1680', '\u2000', '\u200b', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', ' \n ', '\u0085\u2028',
  '/* c */', ' /* c */ ', '/* > */', ' /* </B> > */ ', '/**/', '/* c\n */', ' // c\n', ' // > </B>\n', '// c\r\n', '/* c */ /* d */', '\n/* c */\n// d\n', '\u00a0/* c */\u2028',
];
test('sweep (a "/" and a ">" of a tag with trivia between them, TypeScript parser): the tag ends at the ">", whatever stands between, and every decoy after it is data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  // `@` is the gap between the slash and the `>`; each value is in a place where an element ends and a statement goes on.
  const tags = [
    '<B /@>', '<B x="1" /@>', "<B x='1' y=\"2\" /@>", '<B.C /@>', '<B x={1} /@>', '<B {...p} /@>', '<B<T> /@>', '<B x /@>', '<B x y="1" z={2} /@>', '<B\n  x="1"\n  /@>',
    '<A x=<B /@>/>', '<A x=<B /@> />', '<A x=<B /@>>t</A>', '<A x=<B x="1" /@>>t</A>', '<A x=<B /@> y=<C /@>/>', '<A x=<B /@> y="1" />', '<A x=<B y=<C /@>/> />', '<A x= /* c */ <B /@>>t</A>',
    '<A><B /@></A>', '<A>t<B /@>u<C /@></A>', '<A>{<B /@>}</A>', '<A><B x="1" /@><B /@></A>', '<A>(a)<B /@></A>', '<A.B><C /@></A.B>', '<><B /@></>',
  ];
  const places = ['const e = X;', 'f(X);', 'const o = { k: X };', 'const p = <p>{X}</p>;', 'function g() { return X; }', 'export default X;', 'const h = () => X;', 'const l = [X, X];'];
  const programs = [];
  for (const place of places) {
    for (const tag of tags) {
      for (const gap of TAG_GAPS) {
        for (const [index, decoy] of SWEEP_DECOYS.entries()) {
          if (index > 0 && programs.length % 3 !== 0) continue;
          const element = tag.replaceAll('@', gap);
          programs.push({ code: `declare const f: any, p: any;\n${place.replaceAll('X', element)}${decoy}\n`, label: `${place} / ${JSON.stringify(element)} / decoy ${index}` });
        }
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 5000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.ok(reading.stats.dataTokens >= 4000 && reading.stats.realTokens >= 4000, `${reading.stats.dataTokens} tokens were data and ${reading.stats.realTokens} real`);
  assert.strictEqual(reading.stats.guessed, 0, `a tag with trivia before its ">" was guessed at: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly');
});

// A closing tag's name is an identifier, then a `:` and an identifier or `.` and identifiers, each a token of its own with trivia and comments around it (parseJsxElementName, parseJsxTagName); `-` continues an identifier
// (scanJsxIdentifier). A name with a colon is never followed by a dot, and a dotted one never by a colon.
test('sweep (a closing tag whose name has a ":" or a "." with trivia around it, TypeScript parser): the closing tag is read to its ">", and the decoy after it is data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const gaps = ['', ' ', '\n', '\t', '\u0085', '\u00a0', '\u2028', '/* c */', ' /* c */ ', '/* > */', '// c\n', ' // > </a:b>\n', '/**/ /**/'];
  const names = [
    { open: '<a:b>', parts: ['a', ':', 'b'] }, { open: '<a-b:c-d>', parts: ['a-b', ':', 'c-d'] }, { open: '<A:B>', parts: ['A', ':', 'B'] }, { open: '<A.B>', parts: ['A', '.', 'B'] },
    { open: '<A.B.C>', parts: ['A', '.', 'B', '.', 'C'] }, { open: '<a>', parts: ['a'] }, { open: '<a-b>', parts: ['a-b'] }, { open: '<this.x>', parts: ['this', '.', 'x'] },
    { open: '<a :b>', parts: ['a', ':', 'b'] }, { open: '<a:\n b>', parts: ['a', ':', 'b'] }, { open: '<a/* c */:b>', parts: ['a', ':', 'b'] }, { open: '<A /* c */ . B>', parts: ['A', '.', 'B'] },
  ];
  const places = ['const e = X;', 'f(X);', 'const p = <p>{X}</p>;', 'function g() { return X; }', 'const e = <w>X</w>;', 'const e = <w x=X />;'];
  const programs = [];
  for (const place of places) {
    for (const { open, parts } of names) {
      for (const gap of gaps) {
        for (const lead of ['', gap]) {
          const closing = `</${lead}${parts.join(gap)}${gap}>`;
          const element = `${open}x${closing}`;
          const decoy = ` const re = /${REGEX_BODY}/; const s = '</${parts.join('')}>></a>;${SWEEP_CALL}//'; ${SWEEP_CALL}`;
          programs.push({ code: `declare const f: any;\n${place.replaceAll('X', element)}${decoy}\n`, label: `${place} / ${JSON.stringify(element)}` });
        }
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 1500, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(reading.stats.guessed, 0, `a closing tag with trivia in its name was guessed at: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly');
});

// TypeScript takes every identifier part after the closing `/` of a regex as part of the literal, a valid flag or not (reScanSlashToken): `/x/in` is one literal, and so is `/x/instanceof` and `/x/é`. A word that
// the flags spell is no keyword, so the `/` after it divides and a `<` compares, on this line and the next, and the regex after that holds the text of a call.
test('sweep (the flags of a regex, TypeScript parser): the literal ends after its last identifier part, and a "/" or "<" after it is read as TypeScript reads it, with no guess', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const flags = [
    '', 'g', 'gi', 'gimsuyd', 'v', 'is', 'in', 'instanceof', 'if', 'of', 'as', 'satisfies', 'typeof', 'void', 'return', 'delete', 'new', 'case', 'do', 'else', 'throw', 'yield', 'await', 'async', 'let',
    'x1', '$', '_', '1', 'é', '\u200d', '\u200c', '\u{1d49c}', 'ab\u200cc', 'aé1_$', 'gg',
  ];
  const continuations = [' / 2', '/2', '\n/ 2', ' /* c */ / 2', ' < 2', '\n< 2', ' <b', ' /\n2', ' / /y/ / 2', ' / <T extends X>text</T>', ' < <b/>', '\u0085/ 2', ' !', ' ? 1 : 2'];
  const frames = ['const n = @;', 'f(@);', 'const p = <p>{@}</p>;', 'function g() { return @; }', 'const t = `${@}`;', 'const o = { k: @ };'];
  const programs = [];
  for (const frame of frames) {
    for (const flag of flags) {
      for (const continuation of continuations) {
        const literal = `/x/${flag}${continuation}`;
        programs.push({ code: `declare const f: any, b: any, T: any, X: any, y: any;\n${frame.replace('@', literal)} const r = /${REGEX_BODY}/; ${SWEEP_CALL}\n`, label: `${frame} / ${JSON.stringify(literal)}` });
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 800, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  assert.strictEqual(reading.stats.guessed, 0, `a "/" or "<" after a regex was guessed at: ${guessSummary(reading.kinds)}`);
  assert.strictEqual(reading.stats.exact, reading.stats.valid, 'every valid page is read exactly');
});

// A cast's closer: `x as A<B> / 2` is a division and `x as A<B> < 2` a comparison, in every program that parses, when `as` is the cast's keyword — a name where a line break or an operator stands before it (parseBinaryExpressionRest). Every
// shape of cast the lexer walks (names, qualified names, indexes and array brackets, unions, intersections, literals, conditional types), after every kind of operand, and every name `as` can be, with every
// continuation after the closer, and a regex that holds the text of a call after it: the plain casts are read for certain, and every other is read right or guessed at — never read as code where it is data.
const CAST_OPERANDS = ['x', '(x)', 'x!', 'f()', 'a.b', 'a?.b', 'a[0]', '1', '"s"', '`t`', 'this', 'null', 'true', 'x++', 'new A()', '/re/', '<b/>', '[1]', 'x as unknown', 'x as A<B>', 'x satisfies A<B>', '(x as A<B>)', 'x ?? y', '-x', '!x'];
const CAST_TYPES = [
  'A<B>', 'A<B<C>>', 'A<B<C<D>>>', 'A.B<C>', 'A<B, C>', 'A<B[]>', 'A<B | C>', 'A<{ a: B }>', 'A<() => B>', 'A<keyof B>', 'A<B>[]', 'A<B>[][]', 'A<B>[number]', 'A<B> | C', 'C | A<B>', 'A<B> & C', 'C & A<B>', '| A<B>', '& A<B>',
  'C | D | A<B>', 'A | B<C>[]', 'A[] | B<C>', '"a" | A<B>', '-1 | A<B>', 'A extends B ? C : D<E>', 'A extends B ? C<D> : E<F>', 'number', 'A', 'A[]', 'A | B', '"a"', '-1', 'A.B', 'unique symbol', 'readonly A<B>[]', 'keyof A<B>',
  'typeof y', 'typeof y<B>', '(A<B>)', 'A<B>[] | undefined', 'Array<A<B>>', 'Record<string, A<B>>', 'A<B> extends C ? D : E',
];
const CAST_CONTINUATIONS = [
  ' / 2', '/2', '\n/ 2', ' /* c */ / 2', ' / /y/ / 2', ' < 2', '\n< 2', ' <c>d', ' <T,>(y: T) => y', ' > /y/.test(z)', ' >> 1', ' >= 1', ' > <b>t</b>', ' >>> /y/.test(z)', ' && /y/.test(z)', ' == /y/.test(z)',
  ' ? /y/.test(z) : 1', ' | /y/.source', ' as A<B> / 2', ' satisfies A<B> < 2', ' in y', ' instanceof y',
];
test('sweep (the closer of a cast, TypeScript parser): every cast the lexer walks is read for certain, every other is read right or guessed at, and the regex after it is data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const programs = [];
  for (const keyword of ['as', 'satisfies']) {
    for (const operand of CAST_OPERANDS) {
      for (const type of CAST_TYPES) {
        for (const continuation of CAST_CONTINUATIONS) {
          const cast = `${operand} ${keyword} ${type}${continuation}`;
          programs.push({ code: `declare const x: any, y: any, z: any, f: any, a: any, b: any, c: any, d: any, A: any, B: any, C: any, T: any;\nconst k = ${cast};\nconst r = /${REGEX_BODY}/; ${SWEEP_CALL}\n`, label: JSON.stringify(cast), keyword, operand, type, continuation });
        }
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 8000, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  // The shapes that are certain: where the type ends in a closer or in a name or a literal the walk steps over, after an operand that ends for certain, no guess is made.
  const certain = readTokens(ts, programs.filter((program) => !/^(readonly|keyof|typeof|unique|\(|\|\s|&\s)/.test(program.type) && !/<T,>|^ <c>d$| in y| instanceof y/.test(program.continuation) && !/^(x\+\+|\/re\/|<b\/>|new A\(\)|x \?\? y)$/.test(program.operand)));
  t.diagnostic(`the plain casts: ${describeReading(certain)}`);
  assert.deepStrictEqual(certain.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(certain.stats.valid >= 4000, `only ${certain.stats.valid} plain casts were valid`);
  assert.ok(certain.stats.exact >= 0.9 * certain.stats.valid, `only ${certain.stats.exact} of ${certain.stats.valid} plain casts were read for certain (${guessSummary(certain.kinds)})`);
});

// Where `as` is no keyword — a name after an operator, a property, a label, a statement of its own after a line break — the type after it is read by TypeScript another way, and a closer after it is the end of type
// arguments, a comparison or the end of an instantiation: the lexer says nothing certain there, and never reads the regex that holds a call as code.
test('sweep (a name `as` or `satisfies` before a type, TypeScript parser): where it is no keyword the closer is guessed at or read right, and the regex after it is data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const heads = [
    'const as = 1, satisfies = 1;\nconst k = @;', 'const as = 1;\nlet k;\nk = @;', 'const as = 1, A = 1, B = 1;\nas\nA<B> / 2; const k = @;', 'const o = { as: 1, satisfies: 2 };\nconst k = @;',
    'as: for (;;) { break as\n@; }', 'const as = 1;\nconst k = [as, @];', 'function g(as: any) { return @; }', 'const as = 1;\nconst k = as ? @ : 0;', 'const as = 1;\nconst k = as || @;', 'const as = 1;\nif (as) @;', 'const as = 1;\nfor (;as;) @;',
  ];
  const expressions = [
    'as | A<B> / 2', 'as & A<B> / 2', 'as\nA<B> / 2', 'as\nA<B> < 2', 'x.as\nA<B> / 2', 'x.as A<B> / 2', 'x?.as A<B> / 2', 'as A<B> / 2', 'satisfies | A<B> / 2', 'x\nas A<B> / 2', 'x\nsatisfies A<B> / 2',
    'as < A > /y/.test(z)', 'x ? as : A<B> / 2', 'as\n<B> / 2', '[as, A<B> / 2]', 'as /y/.test(z)', 'as(A<B> / 2)', 'as ?? A<B> / 2',
  ];
  const programs = [];
  for (const head of heads) {
    for (const expression of expressions) {
      programs.push({ code: `declare const x: any, y: any, z: any, A: any, B: any;\n${head.replace('@', expression)}\nconst r = /${REGEX_BODY}/; ${SWEEP_CALL}\n`, label: `${JSON.stringify(head)} / ${JSON.stringify(expression)}` });
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 25, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
});

// A comment is trivia to TypeScript's scanner wherever white space is, so a container in the text of an element — `{ /* c */ readonly a: T }` — is read past it: the same shapes as without one, in every place a comment can
// stand, in the parameter list of a generic function type that no element reading can parse. `const f: <T>(x: { /* c */ readonly a: T }) => T = g;` is a type, for certain, and the call after it is real.
test('sweep (a comment in the object type of a generic function type, TypeScript parser): the type is read for certain, and the strings after it are data', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const comments = ['/*c*/', ' /* c */ ', '/* } */', '/* </T> */', '/**/', '/* c\n */', ' // c\n', ' // } </T>\n', '/* c */ /* d */', '\n// c\n/* d */\n', '/** @type {x} */'];
  const bodies = [
    '{ C readonly a: T }', '{ C a: T }', '{ a C : T }', '{ a? C : T }', '{ a C ?: T }', '{ [C k: string]: T }', '{ [k C : string]: T }', '{ [K C in keyof T]: T }', '{ m(C x: T): T }', '{ m(x C : T): T }', '{ m(x?C : T): T }',
    '{ 1 C : T }', '{ "a" C : T }', '{ new C (x: T): T }', '{ (C x: T): T }', '{ readonly C a: T }', '{ C get a(): T }', '{ a: T; C b: U }',
  ];
  const frames = ['const f: <T>(x: BODY) => T = g;', 'type F = <T>(x: BODY) => T;', 'interface I { cb: <T>(x: BODY) => T; }', 'function h(cb: <T>(x: BODY) => T) {}', 'let l: Array<<T>(x: BODY) => T>;'];
  const decoy = `const s = '</T>;${SWEEP_CALL}//'; const re = /${REGEX_BODY}/; ${SWEEP_CALL}`;
  const programs = [];
  for (const frame of frames) {
    for (const body of bodies) {
      for (const comment of comments) {
        const type = body.replaceAll('C', comment);
        programs.push({ code: `declare const g: any;\n${frame.replace('BODY', type)}\n${decoy}\n`, label: `${frame} / ${JSON.stringify(type)}` });
      }
    }
  }
  const reading = readTokens(ts, programs);
  t.diagnostic(describeReading(reading));
  assert.deepStrictEqual(reading.problems.slice(0, 5), [], 'every token is read where TypeScript reads it');
  assert.ok(reading.stats.valid >= 700, `only ${reading.stats.valid} programs were valid, so the sweep proves little`);
  // The container is read to the error TypeScript reports in it, whatever stands in front of the comment's neighbours: no guess.
  assert.ok(reading.stats.guessed <= 0.05 * reading.stats.valid, `${reading.stats.guessed} of ${reading.stats.valid} types with a comment were guessed at (${guessSummary(reading.kinds)})`);
});
