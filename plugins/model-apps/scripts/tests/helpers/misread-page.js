'use strict';

// Pages that JavaScript and this plugin's lexer read differently — one for each way the lexer's guess can hide a navigation call or put one
// where there is none. In each, the lexer takes the text after a marked spot for something else (a regex run on to the next `/`, a block
// comment opened by the `/*` inside it, a string that ends early), so a REAL `navigateTo` call is read as part of a comment or a regex and its
// token is not seen, or text that is not a call is read as one and rewritten. A parser would read each page right; the plugin ships none, so
// the navigation reader refuses whatever follows the first spot it cannot read for certain: the page's `kind`, at `frontier(code)`.
//
// The calls are real: JavaScript makes every `navigateTo` call a page writes outside a string. Line numbers matter to the tests that name them.
const CALL = 'navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});';
const IN_A_STRING = `const note = '*/ navigateTo({pageType:"generative", pageId:"PAGEREF_detail"}) /*';`;
const page = (...lines) => `${lines.join('\n')}\n`;
// The text of a call as the body of a regex: data to TypeScript, which a lexer that reads the regex as code takes for a call and rewrites.
const REGEX_OF_A_CALL = '/navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/';

// A page that has `lines` between two real calls, the last of them followed on the same line by a regex that holds the text of a call, as a program in which
// TypeScript reads an element where a `<` follows a token that another program reads differently. The guess is at the `<` of `<T extends X>`.
function guessAfterOperator(kind, ...lines) {
  const body = [...lines.slice(0, -1), `${lines[lines.length - 1]} const re = ${REGEX_OF_A_CALL};`];
  return {
    kind,
    frontier: (code) => code.indexOf('<T extends X>'),
    code: page('export default function Page() {', '  const text = "x"; const a = 1;', `  ${CALL}`, ...body.map((line) => `  ${line}`), `  ${CALL}`, '  return null;', '}'),
  };
}

const MISREAD_PAGES = {
  // `}/2` divides an object literal; the lexer reads the `/` as the regex of a block and ends it at the `/` of the real regex on the line.
  brace: {
    kind: 'brace',
    frontier: (code) => code.indexOf('}/2') + 1,
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      '  const extras: any = {};',
      '  const count = {valueOf(){return 12;}, ...extras}/2; const re = /\\/*$/;',
      `  ${CALL}`,
      '  /* regular comment */',
      '  return null;',
      '}',
    ),
  },
  // The `(` of `if (` is further back than the lexer looks (2,000 characters), so the `)` is taken to end an operand and the REGEX after it
  // is read as code: the `navigateTo` call inside it is "found" and rewritten, changing what the regex matches.
  paren: {
    kind: 'paren',
    frontier: (code) => code.indexOf(') /navigateTo') + 2,
    code: page(
      'export default function Page() {',
      '  const text = "x";',
      `  ${CALL}`,
      `  if (true /*${'x'.repeat(2100)}*/) /navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})/.test(text);`,
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  // `of` is a name here and the table takes it for the keyword before a regex. The false regex ends at the real one's `/`, the `/*` inside
  // it opens a comment that ends at the `*/` INSIDE a string, and the rest of that string is read as code.
  keyword: {
    kind: 'keyword',
    frontier: (code) => code.indexOf('of/2') + 2,
    code: page(
      'export default function Page() {',
      '  const of = 12;',
      '  const count = of/2; const re = /\\/*$/;',
      `  ${IN_A_STRING}`,
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  // `Al\u0069as` is `Alias`: the cast's type arguments are not found behind the escape, the `>` is taken for a comparison, and the `/` after it
  // for a regex.
  identifier: {
    kind: 'identifier',
    frontier: (code) => code.indexOf('\\u0069as'),
    code: page(
      'type Alias<T> = T;',
      'export default function Page() {',
      `  ${CALL}`,
      '  const total: number = 10;',
      '  const half = total as Al\\u0069as<number> / 2; const re = /\\/*$/;',
      `  ${IN_A_STRING}`,
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  // The same division, behind a qualified type name spelled with spaces around the dot, which the scan for a cast's type does not follow.
  angle: {
    kind: 'angle',
    frontier: (code) => code.indexOf('/ 2; const re'),
    code: page(
      'declare namespace Types { type Alias<T> = T; }',
      'export default function Page() {',
      `  ${CALL}`,
      '  const total: number = 10;',
      '  const half = total as Types . Alias<number> / 2; const re = /\\/*$/;',
      `  ${IN_A_STRING}`,
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  // A tag's strings are scanned by the rules of a JSX attribute, which have no escapes; the type argument is a TypeScript string. It ends
  // at `\"`, the line break and the `/*` after it open an own-line comment that runs to the end of the file, over the real handler.
  'jsx-type-arguments': {
    kind: 'jsx-type-arguments',
    frontier: (code) => code.indexOf('<Component'),
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      '  return (',
      '    <Component<"quote\\"\\',
      '/*"> onClick={() => navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})} />',
      '  );',
      '}',
    ),
  },
  // `type Value = number` has no semicolon, so a line break ends it where an expression would go on: the next line is a regex statement, though to
  // a lexer with no parser it follows an operand and divides. The regex holds the text of a call. A guess (`newline`), so the call after it is not
  // trusted, and nothing there is rewritten — the text in the regex included.
  newline: {
    kind: 'newline',
    frontier: (code) => code.indexOf('/navigateTo', code.indexOf('type Value')),
    code: page(
      'export default function Page() {',
      '  const text = "x";',
      `  ${CALL}`,
      '  type Value = number',
      '  /navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})/.exec(text)',
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  // `interface Callable { <T>(x: T): T }` is a call signature, a type; but a `<T>` followed by a parameter list and a `:` also opens an element whose text
  // starts with a parenthesis (the next page), and only a parser can tell which. The element is read, as the TSX rule says, whose text runs on over the
  // call after it, and the guess is reported (`generic`): the call after it is not trusted, and nothing there is rewritten.
  generic: {
    kind: 'generic',
    frontier: (code) => code.indexOf('<T>'),
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      '  interface Callable { <T>(x: T): T }',
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  // The other reading of the same shape, and the right one here: JSX text that starts with a parenthesis and a colon compiles. The element is read right
  // and the call after it is seen — but the guess is reported all the same, so the call is refused, naming it, and nothing there is rewritten. A valid
  // page refused for the sake of a guess; the way out is to put the call before the element.
  'generic, in JSX text': {
    kind: 'generic',
    frontier: (code) => code.indexOf('<span>'),
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      '  const label = <span>(required): Name</span>;',
      `  ${CALL}`,
      '  return label;',
      '}',
    ),
  },
  // `<Wrapper>(<Child x="\" y=") =>" />)</Wrapper>` is one element, and TypeScript reads it with no diagnostic: a `>` is barred only in the text of an element's
  // children, and a JSX attribute string has no escapes, so the `)` in the second attribute and the `=>` after it are inside a string. To a lexer that scanned the
  // parameter list with JavaScript's rules they were a list and an arrow, `<Wrapper>(…) =>` a generic function type — code — and the regex after the element was
  // read as code, and its token rewritten. The element is read right, but a `<Name>` followed by a list and an arrow that holds a `<` or `{` is a guess (`generic`).
  'generic, in a nested element': {
    kind: 'generic',
    frontier: (code) => code.indexOf('<Wrapper>'),
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      '  const element = <Wrapper>(<Child x="\\" y=") =>" />)</Wrapper>; const re = /navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/;',
      `  ${CALL}`,
      '  return element;',
      '}',
    ),
  },
  // The same element with an attribute value that does not start right after its `=`: TypeScript's scanner skips white space before the value, and not only the ASCII
  // kind — a no-break space, U+2028, a byte order mark and the rest are skipped too — so `x=` and a no-break space and `"a"` is an attribute whose value is "a", and the
  // element still compiles. A reading that takes any character beyond ASCII there for a value that is no value calls the element unparseable, and the shape a function type,
  // for certain. A character it cannot tell from such white space leaves the reading undecided: the guess (`generic`) is reported at the `<`.
  'generic, in a nested element, with white space beyond ASCII before an attribute value': {
    kind: 'generic',
    frontier: (code) => code.indexOf('<Wrapper>'),
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      '  const element = <Wrapper>(<Child x=\u00A0"a" /><Other p="\\" q=") =>" />)</Wrapper>; const re = /navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/;',
      `  ${CALL}`,
      '  return element;',
      '}',
    ),
  },
  // The first name after a `<` is an identifier to TypeScript except `await` in an async function and `yield` in a generator, where `<await extends X>` is an
  // element: TypeScript reads `<await extends SomeType>text</await>` here as one, with the regex after it a regex. A lexer that took it for a generic arrow's
  // type parameters read the regex as code. The lexer does not know what function it is in, so it is a guess (`generic`), and the element is read.
  'generic, with await': {
    kind: 'generic',
    frontier: (code) => code.indexOf('<await'),
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      '  async function probe() { const element = <await extends SomeType>text</await>; const re = /navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/; return element; }',
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  'generic, with yield': {
    kind: 'generic',
    frontier: (code) => code.indexOf('<yield'),
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      '  function* probe() { const element = <yield extends SomeType>text</yield>; const re = /navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/; return element; }',
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  // After the cut `>=`, TypeScript reads `<T extends X>(x: T): text</T>` as an element whose text starts with a parenthesis — and reads the same text as an arrow with a return type in
  // another program (`let x: A<number>= <T extends X>(y: T): T => y`). Which program this is cannot be told for the `>` and `=` that may be a cut, so the element is read and the guess
  // reported (`operator`), and the regex after it, which holds a token, is refused. With no parameter list, `<T extends X>text</T>` is an element in every program that parses — an
  // arrow there wants its parameters — and is read as one with no guess (ELEMENT_AFTER_OPERATOR_PAGES).
  'operator, after ">="': guessAfterOperator('operator', 'const k = a >= <T extends X>(x: T): text</T>;'),
  // The `>` that ends a cast's type arguments is read as certain and unreported, and TypeScript merges the `>` after it into the operator only where an operator is expected
  // (scanner.ts, reScanGreaterToken): `x as A<B>>= y` is the cast, then `>=`. A lexer that read the run `>>=` as one token took the first `>` for part of an assignment, and read the `<` after
  // it as type parameters; TypeScript reads an element there, and the regex after it is data. Which `>` ended the type arguments cannot be told, so the `<` is a guess where the head leaves
  // both readings open.
  'operator, after ">>=" that ends type arguments': guessAfterOperator('operator', 'const k = x as A<B>>= <T extends X>(x: T): text</T>;'),
  'operator, after ">>>=" that ends nested type arguments': guessAfterOperator('operator', 'const k = x as A<B<C>>>= <T extends X>(x: T): text</T>;'),
  'operator, after ">>=" that ends the type arguments of satisfies': guessAfterOperator('operator', 'const k = x satisfies A<B>>= <T extends X>(x: T): text</T>;'),
  // A JSX attribute string written after white space is a JavaScript string to TypeScript, with escapes (scanner.ts, scanJsxAttributeValue falls back to scan() unless the quote follows the
  // `=` at once): `'\'/>;navigateTo(…);//'` is ONE string, and the call in it is text. Babel and esbuild read a JSX string, which has no escapes and ends at the second quote, and find a real
  // call. The compilers disagree, so neither reading is trusted: the guess is at the quote (`jsx-attribute`), and everything after it, the call in the string included, is refused.
  'jsx-attribute': {
    kind: 'jsx-attribute',
    frontier: (code) => code.indexOf("'\\'/>"),
    code: page(
      'export default function Page() {',
      `  ${CALL}`,
      `  const element = <C x= '\\'/>;${CALL}//' />;`,
      `  ${CALL}`,
      '  return null;',
      '}',
    ),
  },
  // The guess sits INSIDE the call's options object: the `}/2` after `data` is read as a regex that ends at the `/` of `/\/*$/`, and the `/*`
  // in that opens a comment over the getter that follows, which makes `pageType` something else at run time. The `pageId` before it is read
  // right — but the object it is in is not, so the call is not trusted and its token is not rewritten (`reaching`).
  'inside an options object': {
    kind: 'brace',
    reaching: true,
    frontier: (code) => code.indexOf('}/2') + 1,
    code: page(
      'export default function Page() {',
      '  const typeKey = "pageType"; const extras = {}; const flag = false;',
      '  navigateTo({ pageType: "generative", pageId: "PAGEREF_detail",',
      '    data: {valueOf(){return 12;}, ...extras}/2, r: /\\/*$/,',
      '    get [typeKey]() { return flag ? "generative" : "entityrecord"; }',
      '    /* regular comment */ });',
      '  return null;',
      '}',
    ),
  },
};

// `++` on the line after its operand is a PREFIX increment (a restricted production: ECMA-262 §12.10.1), so the `/` after it is a regex, whose body
// is the text of a call. The lexer reads that right, so no guess is involved: the token in the regex is plain text, stray whatever precedes it, and
// never rewritten. (To the lexer before it knew the rule, `++` was always postfix: the regex was a division and the text in it a call.)
const PREFIX_INCREMENT_PAGE = page(
  'export default function Page() {',
  '  const text = "x"; let n = 0;',
  `  ${CALL}`,
  '  n',
  '  ++',
  '  /navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})/.exec(text)!.index',
  '  return null;',
  '}',
);

// A template line that starts with `//` and holds a call in a `${}`: it runs. The `/` after a `!` on the line after its operand is a regex (`!` is
// a prefix operator there), and it holds a backtick: a lexer that read it as a division took that backtick for the start of a template, and the
// text of the real one for code — where a line that starts with `//` is a comment. Read right, the call is a call, and is rewritten.
const TEMPLATE_LINE_PAGE = page(
  'export default function Page() {',
  '  const x = 1;',
  '  x',
  '  !/`/.test("x");',
  '  const message = `',
  '// ${navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})}',
  '`;',
  '  return null;',
  '}',
);

// JSX text that looks like a parameter list: `(a): Title`. The element has an attribute, so its name is not followed by a comma or a constraint
// and TypeScript reads it as an element, whatever comes later. A lexer that looked for a parameter list and a later `=>` took `<div …>` for type
// parameters and `(a): Title` for parameters, and the `=>` in the next arrow for theirs — and read the regex after that arrow as code: a call. Read
// right, the regex is data, the token in it is a token no rewrite resolves, and no guess is involved.
const JSX_TEXT_PAGE = page(
  'export default function Page() {',
  '  const text = "x"; const enabled = true;',
  `  ${CALL}`,
  '  const isVisible = (node: any) => !!node.props["data-active"];',
  '  const check = isVisible(<div data-active={enabled}>(a): Title</div>) ? (() => /navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/.test(text)) : (() => false);',
  '  return null;',
  '}',
);

// A page whose `<` follows a unary or binary operator, so that TypeScript reads an element whatever follows the name — `a === <T extends X>text</T>` is JSX, where
// `v = <T extends X>…` would start a generic arrow — and the regex after it on the same line is data. The lexer reads that right: no guess is involved, the token in
// the regex is stray whatever precedes it and is never rewritten, and the real call before it is. The token is on line `ELEMENT_PAGE_TOKEN_LINE`.
const ELEMENT_PAGE_TOKEN_LINE = 4;
const ELEMENT_AFTER_OPERATOR_PAGES = [
  ['==', 'a == '], ['===', 'a === '], ['!=', 'a != '], ['!==', 'a !== '], ['<=', 'a <= '], ['<<', 'a << '], ['typeof', 'typeof '], ['delete', 'delete '], ['instanceof', 'a instanceof '], ['void', 'void '],
  // After these a head with a constraint and no parameter list is an element in every program that parses, and no guess is named (an arrow would want its parameters). The cut
  // `>=`, `>>=` and `>>>=` is among them: where its first `>` ends a cast's type arguments the rest compares, and where the run is one assignment the arrow has no parameters.
  ['<', 'a < '], ['in', '"a" in '], ['yield *', 'yield * '],
  ['>=', 'a >= '], ['>>= after type arguments', 'x as A<B>>= '], ['>>>= after nested type arguments', 'x as A<B<C>>>= '], ['>>= after the type arguments of satisfies', 'x satisfies A<B>>= '],
].map(([token, before]) => ({
  name: `after "${token}"`,
  code: page(
    'export default function Page() {',
    '  const text = "x"; const a = 1;',
    `  ${CALL}`,
    `  const k = ${before}<T extends X>text</T>; const re = ${REGEX_OF_A_CALL};`,
    '  return null;',
    '}',
  ),
}));

// Pages in which `<Name>` and a parameter list stand in an ELEMENT's text and compile as JSX — shapes a function type's parameter list could be taken for — and elements
// whose head TypeScript reads one way and a reader that knew white space by JavaScript's definition the other: `<T extends` and a character that TypeScript's scanner skips
// but a JavaScript regex's `\s` does not (U+0085, U+200B) is `<T extends>`, an element, not a generic arrow with a constraint. The lexer reads each element right, so the regex
// after it is data: its token is stray with no guess named, and never rewritten; the real call before it is. The token is on line `ELEMENT_PAGE_TOKEN_LINE`, as in the pages above.
// The last two are no element at all: `function*` takes type parameters (parser.ts, parseFunctionExpression: `function`, an optional `*`, an optional name, then the type
// parameters), so `<T>` there is TypeScript's and the string after it, which holds a closing tag and a call, is data. A lexer that took the `<T>` for an element ended it at the
// `</T>` inside the string and read the call after that as code. The string's token is stray with no guess named, and never rewritten.
const STRING_OF_A_CALL = `const s = '</T>;${CALL}//';`;
const ELEMENT_LOOKALIKE_PAGES = [
  ['an expression container that holds an arrow', 'const k = <W>({() => 1})</W>;'],
  ['an expression container that holds a name, with a colon after it in the text', 'const k = <W>({ a }: X) </W>;'],
  ['a head cut by a next-line character, which TypeScript skips as white space', 'const k = <T extends\u0085>text</T>;'],
  ['a head cut by a zero-width space, which TypeScript skips as white space', 'const k = <T extends\u200B>text</T>;'],
  ['the type parameters of a generator expression, and a string that holds a closing tag and a call', 'const g = function* <T>(x: T) { yield x; };', STRING_OF_A_CALL],
  ['the type parameters of an async generator expression, and a string that holds a closing tag and a call', 'const g = async function* <T>(x: T) { yield x; };', STRING_OF_A_CALL],
].map(([name, element, data = `const re = ${REGEX_OF_A_CALL};`]) => ({
  name,
  code: page(
    'export default function Page() {',
    '  const text = "x"; const a = 1;',
    `  ${CALL}`,
    `  ${element} ${data}`,
    '  return null;',
    '}',
  ),
}));

// Generic function types that TypeScript parses with no diagnostic, and whose parameter lists hold what an element's text could not: a type argument, an object type,
// a comma between type arguments, an object type whose member is readonly, an index signature, a method signature or a quoted key, a destructured parameter. A rule that asked only
// whether a `<` or `{` stood between the `>` of `<Name>` and the arrow took each for a guess, and the structure gate refused every page that held one as truncated. Each is
// certain: no page that compiles reads the `<` as an element, so the page is complete, a call after the declaration is a call and is rewritten, and no guess is named. The call is on
// line `FUNCTION_TYPE_CALL_LINE`.
const FUNCTION_TYPE_CALL_LINE = 4;
const FUNCTION_TYPE_DECLARATIONS = [
  ['an interface member with a type argument', 'interface ListProps { renderItem: <T>(item: Array<T>) => React.ReactNode; }'],
  ['an annotation with a type argument', 'const pick: <T>(items: Array<T>) => T = (items) => items[0];'],
  ['a type alias with type parameters', 'type Fn<A> = <T>(x: Array<T>) => A;'],
  ['an annotation with an object type', 'const fmt: <T>(value: { label: T }) => string = (v) => String(v.label);'],
  ['a parameter type', 'function apply(cb: <T>(x: Promise<T>) => void) { return cb; }'],
  ['a member of a type literal', 'type Props = { onPick: <T>(x: Array<T>) => void };'],
  ['an annotation with two type arguments', 'let h: <T>(m: Record<string, T>) => T[];'],
  ['an interface member with a readonly member in an object type', 'interface P { cb: <T>(value: { readonly current: T }) => T; }'],
  ['a member of a type literal with a destructured parameter', 'type F = { cb: <T>({ a }: { a: T }) => T };'],
  ['a member of a type literal with an index signature', 'type F = { cb: <T>(m: { [k: string]: T }) => T };'],
  ['a member of a type literal with a method signature', 'type F = { cb: <T>(o: { m(x: T): T }) => T };'],
  ['a member of a type literal with a quoted key', "type F = { cb: <T>(o: { 'a': T }) => T };"],
];
const FUNCTION_TYPE_PAGES = FUNCTION_TYPE_DECLARATIONS.map(([name, declaration]) => ({
  name,
  declaration,
  code: page('import * as React from "react";', declaration, 'export default function Page() {', `  ${CALL}`, '  return null;', '}'),
}));

// A page as plain JavaScript, called once, so a test can run it and count what it navigates to. Only the pages written in plain JavaScript
// besides their types run this way; the others need the TypeScript compiler.
const runnable = (code) => `${code.replace('export default function Page', 'function Page').replace(': any', '')}Page();\n`;

// Reverse resolution turns an id into a token, which is usually longer, and the code after it moves. The lexer looks back 2,000 characters for the
// `(` of an `if` head, so a head just inside that window with ids is one just outside it with tokens: a `paren` ambiguity, after which no call is
// trusted. `lookBehindPage(id, calls, pad)` is such a page: an `if` whose head holds `calls` navigation calls and a comment of `pad` characters, a
// regex statement, and one more call after it. With 36-character ids and `LONG_KEY`, twenty calls are well inside the window and well outside it
// once every id is a token.
const LONG_KEY = `a-page-with-a-rather-long-key-${'x'.repeat(30)}`;
// `regex` is what follows the head (`/abc/` is harmless; `/\/*$/` opens a false comment when the head is read by guess, which covers what `after`
// holds), and `after` is text after the last call.
const lookBehindPage = (id, calls, pad = 0, { regex = '/abc/', after = '' } = {}) => {
  const call = `navigateTo({pageType:"generative",pageId:"${id}"})`;
  return [
    'const text = "x";',
    `if (/*${'x'.repeat(pad)}*/ ${Array.from({ length: calls }, () => `${call} && `).join('')}1) ${regex}.test(text);`,
    `${call};`,
    after,
  ].join('\n');
};

// A page whose only call is one the lexer cannot see: `of/2` is read as the start of a regex, which ends at the real one's `/`, and the `/*`
// inside that opens a comment over the call. Nothing is rewritten wrongly — the call is just never found, so a page that declares it fails
// parity ("declared-but-absent"), a message that tells the author nothing unless it names the guess.
const HIDDEN_CALL_PAGE = {
  kind: 'keyword',
  frontier: (code) => code.indexOf('of/2') + 2,
  code: page(
    'export default function Page() {',
    '  const of = 12;',
    '  const count = of/2; const re = /\\/*$/;',
    `  ${CALL}`,
    '  /* regular comment */',
    '  return null;',
    '}',
  ),
};

// The first page found, kept under its name for the tests that predate the table.
const OBJECT_DIVISION_PAGE = MISREAD_PAGES.brace.code;
const OBJECT_DIVISION_PAGE_RUNNABLE = runnable(OBJECT_DIVISION_PAGE);

module.exports = { MISREAD_PAGES, HIDDEN_CALL_PAGE, PREFIX_INCREMENT_PAGE, TEMPLATE_LINE_PAGE, JSX_TEXT_PAGE, ELEMENT_AFTER_OPERATOR_PAGES, ELEMENT_LOOKALIKE_PAGES, ELEMENT_PAGE_TOKEN_LINE, FUNCTION_TYPE_DECLARATIONS, FUNCTION_TYPE_PAGES, FUNCTION_TYPE_CALL_LINE, OBJECT_DIVISION_PAGE, OBJECT_DIVISION_PAGE_RUNNABLE, runnable, LONG_KEY, lookBehindPage };
