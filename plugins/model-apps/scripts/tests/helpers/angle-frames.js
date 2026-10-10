'use strict';

// The programs that the sweep of the token before a `<` (ambiguity-sweep.test.js) and the oracle's table test (source-literals.test.js) are built from, and — at the end — the pages for a parameter list that
// neither an arrow nor a colon follows, which the unit tests, the sweeps and the fuzz share.
//
// A `<` where an expression may start is an element, a generic arrow's type parameters, or a generic function type, and which one depends on the token
// in front of it: TypeScript applies its arrow rule only where an ASSIGNMENT expression starts, so after a unary or binary operator the same words are an
// element. The lexer must never read an element's text as code, because a regex after it would then be read as code, and a token in the regex rewritten.
// So every punctuator and keyword TypeScript has is put in front of a `<` — adjacent to it, after a space and after a line break — and the `<` continues
// each of the ways it can: an element, a generic arrow with a comma and with a constraint, and a function type. That is done in every frame in which the
// token can stand: a statement, an operand, a head, a type. Each program ends with a regex that holds a navigation call's text, on the line of the
// construct. TypeScript says which programs are valid (no parse diagnostics) and what it reads at the `<`; the others are dropped.

// The body of the regex that follows each construct, and the regex statement: TypeScript reads it as a regex, so a lexer that reads it as code rewrites
// the token inside it.
const REGEX_BODY = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})';
const AFTER = `; const re = /${REGEX_BODY}/;`;
// The same, with a real call after the regex: read right, only that call is rewritten.
const AFTER_WITH_CALL = `${AFTER} navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});`;

// The ways a `<` can continue. MARK is text the lexer must read as text where TypeScript reads an element and as code where it reads an arrow's body. The function types
// whose parameter lists hold what an element's text could not — a type argument, an object type, a comma between type arguments — are read by elementFailsAt, the
// others by the absence of a `<` or `{` between the `>` of `<T>` and the arrow.
const CONTINUATIONS = Object.freeze({
  element: '<T extends X>MARK</T>',
  arrowComma: '<T,>(x: T) => MARK',
  arrowExtends: '<T extends X>(x: T) => MARK',
  functionType: '<T>(x: T) => T',
  functionTypeArgument: '<T>(x: Array<T>) => T',
  functionTypeObject: '<T>(x: { a: T }) => T',
  functionTypeComma: '<T>(m: Record<string, T>) => T',
});

// What stands between the token and the `<`.
const SEPARATORS = Object.freeze({ adjacent: '', space: ' ', newline: '\n' });

// Every character TypeScript's scanner skips between two tokens (`ts.isWhiteSpaceSingleLine` and `ts.isLineBreak`), by name, and a comment: the separators where a lexer's idea of white
// space matters. JavaScript's `\s` lacks two of them, U+0085 and U+200B, so a lexer that used it read `if` U+0085 `(true) /re/` as no `if` at all.
const TRIVIA_SEPARATORS = Object.freeze({
  adjacent: '', space: ' ', tab: '\t', newline: '\n', 'carriage return': '\r', 'vertical tab': '\v', 'form feed': '\f', 'next line': '\u0085', 'no-break space': '\u00A0', ogham: '\u1680',
  'en quad': '\u2000', 'em quad': '\u2001', 'en space': '\u2002', 'em space': '\u2003', 'three-per-em space': '\u2004', 'four-per-em space': '\u2005', 'six-per-em space': '\u2006',
  'figure space': '\u2007', 'punctuation space': '\u2008', 'thin space': '\u2009', 'hair space': '\u200A', 'zero-width space': '\u200B', 'line separator': '\u2028',
  'paragraph separator': '\u2029', 'narrow no-break space': '\u202F', 'medium mathematical space': '\u205F', 'ideographic space': '\u3000', 'byte order mark': '\uFEFF',
  'block comment': '/* c */', 'line comment': '// c\n',
});

// `@` is the token and its separator, `§` the continuation. `role` says whether the token stands in an expression (where an element is possible) or in a
// type (where TypeScript's grammar has no JSX, and a `*`, `?` or `!` is a JSDoc type that parses but never compiles). Some tokens need a frame of their
// own — `case`, `else`, `do`, `in`, `of`, `extends`, `default`, the brackets — and a token in a frame that does not suit it is a syntax error, which drops it.
const FRAMES = Object.freeze([
  { name: 'binary', role: 'expression', text: 'const k = a @§' },
  { name: 'prefix', role: 'expression', text: 'const k = @§' },
  { name: 'statement', role: 'expression', text: '@§' },
  { name: 'assignment', role: 'expression', text: 'v @§' },
  { name: 'argument', role: 'expression', text: 'f(@§)' },
  { name: 'second argument', role: 'expression', text: 'f(a, @§)' },
  { name: 'array', role: 'expression', text: 'const k = [@§]' },
  { name: 'property', role: 'expression', text: 'const k = { o: @§ }' },
  { name: 'conditional, then', role: 'expression', text: 'const k = a @§ : b' },
  { name: 'conditional, else', role: 'expression', text: 'const k = a ? b @§' },
  { name: 'block', role: 'expression', text: 'if (a) { @§ }' },
  { name: 'function', role: 'expression', text: 'function g() { @§ }' },
  { name: 'generator', role: 'expression', text: 'function* g() { @§ }' },
  { name: 'async function', role: 'expression', text: 'async function g() { @§ }' },
  { name: 'case label', role: 'expression', text: 'switch (a) { @§: break; }' },
  { name: 'case body', role: 'expression', text: 'switch (a) { case 1: @§ }' },
  { name: 'else', role: 'expression', text: 'if (a) b; @§' },
  { name: 'do', role: 'expression', text: '@§; while (a)' },
  { name: 'for-in head', role: 'expression', text: 'for (const k @§) {}' },
  { name: 'for head', role: 'expression', text: 'for (v @§) {}' },
  { name: 'template substitution', role: 'expression', text: 'const k = `${@§}`' },
  { name: 'arrow body', role: 'expression', text: 'const k = () @§' },
  { name: 'postfix', role: 'expression', text: 'const k = a@§' },
  { name: 'closing paren', role: 'expression', text: 'if (a@§' },
  { name: 'closing paren, in an expression', role: 'expression', text: 'const k = (a@§' },
  { name: 'closing bracket', role: 'expression', text: 'const k = [a@§' },
  { name: 'closing brace', role: 'expression', text: 'if (a) { b@§' },
  { name: 'closing brace, of an object', role: 'expression', text: 'const k = { o: 1 @§' },
  { name: 'enum member', role: 'expression', text: 'enum E { A = @§ }' },
  { name: 'class field', role: 'expression', text: 'class C { m = @§ }' },
  { name: 'opening paren', role: 'expression', text: 'f @§)' },
  { name: 'opening bracket', role: 'expression', text: 'v @§]' },
  { name: 'opening brace', role: 'expression', text: '@§ }' },
  { name: 'export', role: 'expression', text: 'export @§' },
  { name: 'heritage', role: 'expression', text: 'class C @§ {}' },
  { name: 'annotation', role: 'type', text: 'let x: @§ = f' },
  { name: 'alias', role: 'type', text: 'type A = @§' },
  { name: 'alias, operand', role: 'type', text: 'type A = B @§' },
  { name: 'cast', role: 'type', text: 'const k = a as @§' },
  { name: 'parameter type', role: 'type', text: 'function g(p: @§) {}' },
  { name: 'return type', role: 'type', text: 'function g(): @§ {}' },
  { name: 'type arguments, of a call', role: 'type', text: 'f@§>()' },
  { name: 'type arguments, of an annotation', role: 'type', text: 'let x: A@§> = f' },
  { name: 'member type', role: 'type', text: 'interface I { m: @§ }' },
  { name: 'annotation, after type arguments', role: 'type', text: 'let x: A<B> @§' },
  { name: 'declaration, after type arguments', role: 'type', text: 'declare const x: A<B>@§' },
  { name: 'alias with type parameters', role: 'type', text: 'type A<B> = @§' },
  { name: 'union', role: 'type', text: 'let x: B | @§' },
  { name: 'conditional type', role: 'type', text: 'type A = B @§ ? 1 : 2' },
  { name: 'type arguments, closed before the token', role: 'type', text: 'let x: A<number@§' },
  { name: 'nested type arguments, closed before the token', role: 'type', text: 'let x: A<A<number@§' },
  { name: 'mapped type', role: 'type', text: 'type A = { [K @§]: 1 }' },
  // Where the token itself holds the closers of a cast's, a `satisfies`'s, an instantiation's or a return type's type arguments: `>>=` is `>`, then `>=`, and `>>>=` is two `>`,
  // then `>=` (TypeScript puts the operator together by itself where it expects one: reScanGreaterToken).
  { name: 'cast, closed by the token', role: 'type', text: 'const k = x as A<B@§' },
  { name: 'cast, nested, closed by the token', role: 'type', text: 'const k = x as A<B<C@§' },
  { name: 'satisfies, closed by the token', role: 'type', text: 'const k = x satisfies A<B@§' },
  { name: 'satisfies, nested, closed by the token', role: 'type', text: 'const k = x satisfies A<B<C@§' },
  { name: 'instantiation, closed by the token', role: 'type', text: 'const k = f<A@§' },
  { name: 'return type, closed by the token', role: 'type', text: 'const k = (): A<B@§' },
]);

// The `>` that ends type arguments or a tag, read with certainty by the lexer and never reported, IMMEDIATELY before the operator run: a cast's (`as` and `satisfies`), nested
// lists, an instantiation expression's, a return type's, an alias head's, a conditional type's and a JSX tag's. TypeScript reads such a `>` as the end of the list and puts the
// operator after it together by itself (`x as A<B>>= y` is `x as A<B>`, then `>=`), where a lexer that cut the whole run as one operator read `>>=`. The token and the closer make
// one run of sign characters when nothing stands between them, so these frames are not asked what class the token alone has (source-literals.test.js): what TypeScript reads is
// that of the run, and the sweep (ambiguity-sweep.test.js) asks only whether a regex that TypeScript reads is ever read as code.
const PRODUCER_FRAMES = Object.freeze([
  { name: 'cast, closed before the token', role: 'type', text: 'const k = x as A<B>@§' },
  { name: 'cast, nested, closed before the token', role: 'type', text: 'const k = x as A<B<C>>@§' },
  { name: 'cast, in a union, closed before the token', role: 'type', text: 'const k = x as D | A<B>@§' },
  { name: 'satisfies, closed before the token', role: 'type', text: 'const k = x satisfies A<B>@§' },
  { name: 'satisfies, nested, closed before the token', role: 'type', text: 'const k = x satisfies A<B<C>>@§' },
  { name: 'instantiation, closed before the token', role: 'type', text: 'const k = f<A>@§' },
  { name: 'return type, closed before the token', role: 'type', text: 'const k = (): A<B>@§' },
  { name: 'alias head, closed before the token', role: 'type', text: 'type A<B>@§' },
  { name: 'conditional type, closed before the token', role: 'type', text: 'type A = B extends C<D>@§' },
  { name: 'JSX closing tag, before the token', role: 'expression', text: 'const k = <p></p>@§' },
  { name: 'JSX self-closing tag, before the token', role: 'expression', text: 'const k = <p/>@§' },
  // The same producers with a space before the token: the token is then an operator run of its own, after an operand the lexer knows has ended, and the operand after a binary
  // operator is a unary expression — a `<` there is an element, whatever the rule would read (`x as A<B> > <T extends X>text</T>`).
  { name: 'cast, closed, a space before the token', role: 'type', text: 'const k = x as A<B> @§' },
  { name: 'satisfies, closed, a space before the token', role: 'type', text: 'const k = x satisfies A<B> @§' },
  { name: 'regex, a space before the token', role: 'expression', text: 'const k = /x/ @§' },
  { name: 'JSX self-closing tag, a space before the token', role: 'expression', text: 'const k = <p/> @§' },
]);

// Every punctuator and keyword TypeScript has (`ts.tokenToString` of each token kind from the first to the last of each group), once each.
function tokenVocabulary(ts) {
  const kinds = ts.SyntaxKind;
  const seen = new Set();
  const tokens = [];
  const add = (first, last) => {
    for (let kind = first; kind <= last; kind += 1) {
      const text = ts.tokenToString(kind);
      if (text && !seen.has(text)) { seen.add(text); tokens.push(text); }
    }
  };
  add(kinds.FirstPunctuation, kinds.LastPunctuation);
  add(kinds.FirstKeyword, kinds.LastKeyword);
  return tokens;
}

// Every program for one token: each frame, separator and continuation. `at` is the offset of the continuation's `<`. `frames`, `separators` and `continuations` default to FRAMES, the
// three separators above and every way a `<` can continue; the sweeps pass PRODUCER_FRAMES, and TRIVIA_SEPARATORS for every character TypeScript skips between two tokens.
function programsFor(token, { after = AFTER, frames = FRAMES, separators = SEPARATORS, continuations = CONTINUATIONS } = {}) {
  const programs = [];
  for (const frame of frames) {
    const start = frame.text.indexOf('§');
    for (const [separator, between] of Object.entries(separators)) {
      for (const [continuation, text] of Object.entries(continuations)) {
        const before = frame.text.slice(0, start).replace('@', token + between);
        const code = `${before}${text}${frame.text.slice(start + 1)}${after}`;
        programs.push({ token, frame, separator, continuation, code, at: before.length });
      }
    }
  }
  return programs;
}

// The program as a TypeScript source file, or null where it has a syntax error: such a program is not a page.
function cleanSourceFile(ts, code) {
  const source = ts.createSourceFile('page.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  return source.parseDiagnostics.length === 0 ? source : null;
}

const READINGS = ['JsxElement', 'JsxSelfClosingElement', 'JsxFragment', 'ArrowFunction', 'FunctionType', 'ConstructorType', 'CallSignature', 'ConstructSignature'];
// What TypeScript reads at the `<` at `at`: the kind of the outermost node that starts there, of those that a `<` can open ('other' where it is type
// parameters or arguments, or part of a construct that starts earlier: `async <T,>(x: T) => x` starts at `async`).
function readingAt(ts, source, at) {
  let found = null;
  const visit = (node) => {
    if (node.getStart(source) === at) {
      const name = ts.SyntaxKind[node.kind];
      if (READINGS.includes(name) && (found === null || READINGS.indexOf(name) < READINGS.indexOf(found))) found = name;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found === null ? 'other' : found;
}

const isElement = (reading) => reading === 'JsxElement' || reading === 'JsxSelfClosingElement' || reading === 'JsxFragment';

// ─── A parameter list that neither `=>` nor `:` follows ──────────────────────────────────────────────────────────────────────────────────────────────────
//
// The pages for the two readings of `<Name>(…)` with neither an arrow nor a colon after it (callSignatureOrElement in lib/source-literals.js): the text of an element that starts with a parenthesis in an
// expression, and a call or construct signature with no return type in a type that holds members. TypeScript parses both with no diagnostic, so the text alone does not tell them apart:
//   const e = <b>(optional)</b>;            interface I { <T>(x) }            type L = { <T>(x); m: { a: string } };            interface C { new <T>(x) }
// Every page ends with a decoy — a string, a template, a comment or a regex that holds the closing tag of the head's name and the text of a call — and then the one real call. A lexer that read a
// signature for an element reads the rest of the type as JSX text up to the closing tag in the decoy, and takes the text of the call in it for code, which rewrites a token that is data.
// The tables are the shapes that the unit tests (source-literals.test.js), the sweeps (ambiguity-sweep.test.js) and the fuzz (jsx-element-fuzz.js) share.

const CALL = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})';

// `@` is where the head goes. Every place a type with members stands, and where a construct signature can follow `new`.
const SIGNATURE_FRAMES = [
  ['an interface', 'interface I { @ }'], ['a type literal', 'type L = { @ };'], ['an ambient variable', 'declare const v: { @ };'], ['a parameter annotation', 'function f(a: { @ }) {}'],
  ['an implements clause', 'class C implements I<{ @ }> {}'], ['type arguments', 'let x: Array<{ @ }>;'], ['a member of an interface', 'interface I { m: { @ } }'],
  ['after a member', 'interface I { n: number; @ }'], ['an extending interface', 'interface I extends J { @ }'], ['a union', 'type U = A | { @ };'], ['an export', 'export interface I { @ }'],
  ['a namespace', 'declare namespace N { interface I { @ } }'], ['a cast', 'const o = {} as { @ };'], ['a constraint', 'type G<T extends { @ }> = T;'],
];
const SIGNATURE_HEADS = ['<T>(x)', '<T>(x, y)', '<T>()', 'new <T>(x)', 'new <T>()', '<T>(x?)', '<T>(...a)', '<T>({ a })', '<T>(x: number[])', "<T>(x: 'a')", '<Wrapper>(x)'];
// What follows a signature's `)` and ends its member — the separators, the end of the type, a line break of every kind (a block comment that holds one, a line comment, U+2028, CR) — and the members
// that can come next: a property with an object type, a function type, a method, an index signature, another signature. None holds a closing tag.
const SIGNATURE_ENDINGS = [
  '', ';', ',', '\n', ' // c\n', ' /* c */', ' /* c\n */', '\u2028m: number', '\u2029m: number', '\rm: number', ';\n  m: string', '\n  m: string;', ';\n  m: { a: string }', ';\n  m: { readonly a?: string }',
  '\n  <U>(y)', '\n  new <U>(y)', ';\n  m: (a: T) => void', ';\n  m: Array<string>', ';\n  m(): void', ';\n  [k: string]: T', ';\n  readonly m?: 1', ';\n  m: <U>(y: U) => void', ',\n  m: 1',
];
// What may follow it that a closing tag could be inside of: a string, a template, a comment or a JSDoc comment that holds the closing tag of the head's name; and an object type with a signature of its own
// (`{ <U>(y: U): void }`), which the reading of the text does not read. A string or a regex can stand right after a keyword, which the reading must not take for a word of prose: a member's quoted name after
// its modifier (`public'…'`, which TypeScript parses before any member and leaves to the checker), and a regex in the heritage clause of a class in a computed name (`implements /…/`). `<T>` and `</T>`
// stand for the head's name.
const HIDING_ENDINGS = [";\n  m: '</T>'", ';\n  m: "a</T>b"', ';\n  m: `</T>`', ';\n  // </T>\n  m: number', ';\n  /* </T> */', ';\n  /** </T> */ m: number', ";\n  m: '</T>' | '<T>'", ';\n  m: { <U>(y: U): void }',
  ";\n  public'</T>': number", ';\n  [class C implements /[</T>]/ {}]: 1'];

// What follows the type or the element and holds the closing tag of the head's name (NAME) and the text of a call, which is data in every one.
const DECOYS = {
  string: `const s = '</NAME>;${CALL};//';`,
  'double-quoted string': `const s = "</NAME>;${CALL};//";`,
  template: `const s = \`</NAME>;${CALL};//\`;`,
  'block comment': `/* </NAME>;${CALL}; */`,
  'line comment': `// </NAME>;${CALL};`,
  regex: `const re = /[</NAME>;${CALL}]/;`,
};

// The page: the frame with the signature and what follows it, then a decoy, then the one real call. `at` is the offset of the signature's `<`.
function signaturePage(frame, head, ending, decoy = DECOYS.string) {
  const name = /<(\w+)>/.exec(head)[1];
  const member = `${head}${ending.replaceAll('</T>', `</${name}>`).replaceAll('<T>', `<${name}>`)}`;
  return { code: `${frame.replace('@', member)}\n${decoy.replaceAll('NAME', name)}\n${CALL};\n`, at: frame.indexOf('@') + head.indexOf('<'), name };
}
const signaturePages = (endings, decoy = DECOYS.string) => SIGNATURE_FRAMES.flatMap(([frameName, frame]) => SIGNATURE_HEADS.flatMap((head) => endings.map((ending) => ({ ...signaturePage(frame, head, ending, decoy), label: `${frameName} / ${head} / ${JSON.stringify(ending)}` }))));

// The places an element stands. The third entry says whether a member of a type may begin there (after a `{`, a `,`, a `;`, `return`, `default`, a `?`): where none can — after an `=`, a `(`, a `[`, a `:` or an `=>` — the text of a head
// with a parameter list that neither `=>` nor `:` follows is an element, for certain, whatever it holds (source-literals.js, NO_MEMBER_BEFORE).
const ELEMENT_FRAMES = [
  ['a declaration', 'const e = @;', false], ['an argument', 'f(@);', false], ['a property', 'const o = { k: @ };', false], ['a child', 'const p = <p>{@}</p>;', true], ['a return', 'function g() { return @; }', true],
  ['a default export', 'export default @;', true], ['a conditional', 'const k = c ? @ : null;', true], ['an arrow body', 'const m = items.map((x) => @);', false], ['a block', 'if (a) { @ }', true], ['an array', 'const l = [@];', false],
  // A quote on the line after the element: the apostrophe in its text is no string that this quote could close.
  ['a conditional with a string', "const k = c ? @ : 'none';", true], ['a template', 'const k = `${@}`;', true],
];
// The frames where a member of a type may begin at the head, and where none can.
const MEMBER_ELEMENT_FRAMES = ELEMENT_FRAMES.filter(([, , member]) => member);
const NO_MEMBER_ELEMENT_FRAMES = ELEMENT_FRAMES.filter(([, , member]) => !member);
// A tag that no type has — an attribute with a value, an attribute that `extends` does not introduce, a dotted name with an attribute, a fragment — is an element to every reading, and its text opens nothing: a URL, an apostrophe, a back-tick or a
// comment opener in it, and the elements in it, are text. What stands after its closing tag is read as the code it follows, which is where the nested element's own text must not reach (a link in a hint is one).
const JSX_ONLY_ELEMENTS = [
  '<p>(a); <a href="/x">see https://x.y</a></p>', '<p>(a)\n  <a href="/x">it\'s https://x.y</a> and <b d="1">that\'s</b>\n</p>', '<p>(a), <a href="/x">`t</a> `u` done</p>', '<p>(a); <a href="/x">/* c</a> more</p>',
  '<p>(a); <a href="/x">// c</a> more</p>', '<p>(a); <>x // y</> more</p>', '<p>(a)\n  <b d>see https://x.y</b>\n</p>', '<p>(a), <A.B x>see https://x.y</A.B></p>', '<p>(a); <a href="/x"><b>https://x.y</b></a></p>',
  '<p>(a); <a href="/x">x <i>y // z</i> w</a></p>', '<p>(a); <Link href={url}>https://x.y</Link></p>', '<p>(a), <a href="/x">it\'s</a> <a href="/y">https://x.y</a></p>', '<p>(a);\n  <a href="/x">https://x.y</a>\n  /b</p>',
  '<p>(a); <a href="/x">x</a> + 1</p>', "<p>(a), <a href='/x'>'q</a> 'r</p>", '<p>(a)\n  <a href={url}>https://x.y</a> // not a comment\n</p>',
  // A keyword that has a value is an attribute: no type has `type="button"`, `for="x"` or `as="span"`, so a link or a button keeps its text JSX text, as a tag with an attribute that is no keyword does.
  '<p>(a); <button type="button">see https://x.y</button></p>', '<p>(a)\n  <label for="x">it\'s https://x.y</label>\n</p>', '<p>(a), <Link as="span" href="/x">`t</Link> `u` done</p>', '<p>(a); <a href="/x" default="y">/* c</a> more</p>',
  '<p>(a); <Text in="x" weight={w}>// c</Text> more</p>', '<p>(a);\n  <button type={kind}>https://x.y</button>\n  /b</p>', '<p>(a); <A.B as="x">see https://x.y</A.B></p>',
];
// The same, from every keyword TypeScript has (`keywords`, which the oracle lists): a keyword that is the name of an attribute with a value is an attribute's, whatever word comes before it, since no parameter list of a
// type has a name that another follows without a comma — so no type has the tag, and its text is JSX text.
function valuedKeywordElements(keywords) {
  const elements = [];
  for (const word of keywords) {
    elements.push(`<p>(a); <a ${word}="v">see https://x.y</a></p>`, `<p>(a), <a ${word}={v}>it's \`t</a> done</p>`, `<p>(a)\n  <A.B x ${word}="1">/* c</A.B>\n</p>`, `<p>(a);\n  <a x="v" ${word}={v}>// c</a>\n  /b</p>`,
      // In an expression of a member the reading of the text cannot decide for the tag: it is the tag's own words that say whether the text after it is code.
      `<p>(a); m(b = <a ${word}="v">it's https://x.y</a>)</p>`, `<p>(a); [<A.B x ${word}={v}>\`t</A.B>]: string</p>`);
  }
  return elements;
}
// The elements that stay certain: JSX text that starts with a parenthesis, in every place an element stands, wherever the lexer can tell. The token after the `)` or the closing tag the text reaches says so
// — and a container that holds a string (`{t("label")}`) is no obstacle.
const CERTAIN_ELEMENTS = [
  '<b>(optional)</b>', '<span>(total: {count})</span>', '<Text>({items.length} items)</Text>', '<p>({formatDate(d)})</p>', '<p>({t("label")})</p>', '<p>(a) b</p>', '<p>(a) (b)</p>', '<p>(a)<b>x</b></p>',
  "<p>(it's) fine</p>", '<p>(see https://x.y) now</p>', '<p>(a)\n</p>', '<p>\n  (a)\n</p>', '<li>(x) = {y}</li>', '<div><b>(x)</b></div>', '<p>(a) it\'s and "that" a/b</p>', '<p>({a ? "x" : "y"})</p>',
  '<p>()</p>', '<p>(a, b)</p>', '<p>(a) &amp; b</p>', '<p>({`x`})</p>', "<p>({'}'})</p>", '<p>(<b>x</b>)</p>', '<p>(a)\n  <b>x</b>\n</p>',
  // A `,`, `;` or line break after the `)`: the reading goes on to the closing tag.
  '<p>(a), (b)</p>', '<p>(a); b</p>', '<p>(a)\n  more text\n</p>', '<p>(a), <b>x</b></p>', '<p>(a),</p>', '<p>(a);</p>', '<p>(a),\n</p>', '<p>(a),\n  <b>x</b>\n</p>', "<p>(a), it's</p>", '<p>(a), "q"</p>',
  '<p>(a);\n {t("x")}</p>', '<p>(a)\n  {count} items</p>', '<p>(a)\n  {t("x")}</p>', '<p>(a)\n  more\n  <b>x</b> y\n</p>', '<p>(a), {t("a")}, {t(\'b\')}</p>', '<p>(a)\n  {"}"}</p>',
  // Nested elements with attributes of every kind, and containers with an object in them: the elements a page holds.
  '<p>(a)\n  <b x={1}>y</b>\n</p>', '<p>(a),\n  <Icon name={icon} />\n</p>', '<p>(a);\n  <b style={{ color: "red" }}>y</b></p>', '<p>(a)\n  <b {...p}/>\n</p>', '<p>(a)\n  {{ a: 1 }.a}\n</p>',
  '<Text>\n  (see below)\n  <Link href={url} onClick={() => go("/x")}>docs</Link>\n</Text>', '<li>(a)\n  <b x={t("</li>")}>y</b>\n</li>', '<Foo.Bar>(a), (b)</Foo.Bar>',
  // The text is scanned as a type would scan it: a `/` after a word or a number divides, and a template or a comment that is closed before the closing tag, or a line comment that ends before it, hides nothing.
  '<p>(a)\n  b/c</p>', '<p>(a),\n  `x`</p>', '<p>(a);\n  /* c */</p>', '<p>(a), 1/2 done</p>', '<p>(a);\n  and/or more</p>', '<p>(a)\n  `x` `y`</p>', '<p>(a), see https://x.y\n</p>',
  '<p>(a); // c\n</p>', '<p>(a);\n  /* c */ more /* d */</p>', '<p>(a); {t("x")} a/b</p>', "<p>(a); it's a/b</p>", '<p>(a)\n  {/* c */}\n</p>', '<p>(a);\n  <b>x</b> and/or <i>y</i></p>',
  // Prose that no type holds the members of — two names on a line, a name and a `/` — leaves no type for the closing tag to be hidden in, whatever it holds after it.
  '<p>(a), see https://x.y</p>', '<p>(a), a b // c </p>', '<p>(a), 1 2 `x ${y} </p>', '<p>(a), see a/b = /re/ </p>',
  // A template or a regex where a member would begin, which no member does (TS1131), a sign or an `=` there, and a list that holds no parameters (TS1003 in every signature).
  '<p>(a); `x ${y} </p>', '<p>(a);\n  /x </p>', '<p>(a), = /re/ </p>', '<p>(a); || /x </p>', '<li>(1): first</li>', '<p>("a"); // c </p>',
  // A `/` in the list that divides, or a regex that holds nothing the parenthesis scan misreads; text whose parameters fail before a type, a default or a pattern.
  '<span>({done}/{total})</span>', '<span>(press [/] to search)</span>', '<p>(see @/components)</p>',
  // A label and a type that fails at its second token — a number and a word, an object type whose member is no member, `new` and `import` where a type must follow, an `=` before a closing tag — and an
  // initializer whose first token is a regex, an element, a template or a division: the `)` that ends the list is found exactly, and a closing tag follows it.
  '<p>(Size: 10 MB max, <a href="/x">upgrade</a>)</p>', '<p>(Size: -5 px, <b>x</b>)</p>', '<p>(Name: {user.name}, <a href={profile}>edit</a>)</p>', '<p>(Count: {items.length + 1}, <b>x</b>)</p>', '<p>(Mode: new <a href="/x">beta</a>)</p>',
  '<p>(Mode: new feature, <b>x</b>)</p>', '<p>(Hint: import <a href="/x">docs</a>)</p>', '<p>(Hint: import from <b>CSV</b>)</p>', '<p>(Tip: use <code>=</code>)</p>', '<p>(Tip: <b>a</b> <code>=</code> <b>b</b>)</p>',
  '<p>(a = /x/)</p>', '<p>(a = /[)]/)</p>', '<p>(a = b/(c))</p>', '<p>(score = 3/5)</p>', '<p>(a = <b>c</b>)</p>', '<p>(Status = <Badge>OK</Badge>)</p>', '<p>(a = `x`)</p>',
  ...JSX_ONLY_ELEMENTS,
];
// The same, where the closing tag could be inside a comment, a template or a regex that the text opens, and is not closed before it, and the text before it could be the members of a type: a guess where a member of a type may begin at the head
// (MEMBER_ELEMENT_FRAMES), and an element for certain where none can (NO_MEMBER_ELEMENT_FRAMES). A guess in every place: where the text holds an `=` or a `[` before its `)`, which may start an expression in a parameter list.
// (A template after a member's colon is a type: `m: \`a${string}\``.)
const HIDDEN_TEXT_ELEMENTS = ['<p>(a); // c </p>', '<p>(a);\n  /* c </p>', '<p>(a); m: `x ${y} </p>', '<p>(a), x // c </p>', '<p>(a),\n  see\n  x // c </p>', '<p>(a), readonly x // c </p>', '<p>(a);\n  see /* c </p>'];
const UNREAD_LIST_ELEMENTS = [
  // A default whose regex, element or template is not its first token, or a division after something that is no name or number: the scan cannot say where the list ends.
  '<p>(a = f(/x/))</p>', '<p>(a = (b)/c)</p>', '<p>(a = typeof /x/)</p>', '<p>(a = <b>c</b> / 2)</p>', '<p>(a = `${b}`)</p>'];
const GUESSED_ELEMENTS = [...HIDDEN_TEXT_ELEMENTS, ...UNREAD_LIST_ELEMENTS];

function elementPage(frame, element, decoy = DECOYS.string) {
  const name = /^<([\w.]+)>/.exec(element)[1];
  return { code: `${frame.replace('@', element)}\n${decoy.replaceAll('NAME', name)}\n${CALL};\n`, at: frame.indexOf('@'), name };
}
const elementPages = (elements, decoy = DECOYS.string, frames = ELEMENT_FRAMES) => frames.flatMap(([frameName, frame]) => elements.map((element) => ({ ...elementPage(frame, element, decoy), label: `${frameName} / ${JSON.stringify(element)}` })));

// ─── A parameter list that fails, and a default value that the scan reads exactly ──────────────────────────────────────────────────────────────────────────────
//
// The texts that JSX may have after a parenthesis and a label, which a parameter list shares the start of, and that TypeScript rejects as one in a call signature, a construct signature and a function type alike (a number and
// a word, an object type that is none, `new` and `import` where a type must follow, an `=` before a closing tag); and the defaults whose first token is a regex or an element, a division of a name or a number, and a template with no
// `${`, which the scan of a parameter list reads exactly (genericFunctionTypeFollows in lib/source-literals.js). Each is put in an element and in a type, with a decoy after it, and TypeScript says which are pages.

// The lists, from every keyword TypeScript has (`keywords`), white space of every kind it skips, and the characters that follow a name in an object type.
function failingLists(keywords) {
  const words = [...keywords, 'MB', 'max', 'user', 'count', '\u00e9'];
  const gaps = [' ', '\n', '\u00a0', '\u0085', '\u2028', '/* c */'];
  const lists = [];
  for (const number of ['10', '1.5', '-5']) for (const word of words) lists.push(`Size: ${number} ${word}, <a href="/x">upgrade</a>`);
  for (const gap of gaps) for (const word of ['MB', 'max', 'in', 'extends']) lists.push(`Size:${gap}10${gap}${word}${gap}max, <b>x</b>`);
  for (const name of ['user', 'a', 'readonly', 'get', 'set', 'new', 'static', 'break', 'this']) for (const junk of ['.', '+', '-', '*', '%', '&', '|', '^', '!', '~', '/']) lists.push(`Name: {${name}${junk}b}, <a href={profile}>edit</a>`);
  for (const gap of gaps) for (const junk of ['.', '+', '/']) lists.push(`Name: {a${gap}${junk}${gap}b}, <b>x</b>`);
  for (const head of ['new', 'import']) {
    for (const follow of [...words, '<a href="/x">beta</a>', '<a b>', '<a href=', ')', ',', '=', '[', '{', '.meta', '*', '/', '|', '&', '?', ':', '1', '"x"', '`x`']) lists.push(`Mode: ${head} ${follow}, <b>x</b>`);
    for (const gap of gaps) lists.push(`Mode: ${head}${gap}feature, <b>x</b>`, `Mode: ${head}${gap}<a href="/x">beta</a>`);
  }
  for (const gap of gaps) for (const before of ['a = ', 'a: T = ', 'a?: T = ', 'a, b = ', 'Tip: use <code>=', 'Tip: <b>a</b> <code>=']) for (const tag of ['</code>', '</x>', '</ x>', '</>', '</b>']) lists.push(`${before}${gap}${tag}`);
  return lists;
}
// The failing lists that the scan still leaves a guess, and why: a number followed by `extends` (a conditional type, which TypeScript reads on) or by a name that is not ASCII, and a `/` after a modifier (the text of the list
// is scanned as code, where a regex may follow a contextual word).
const LEFT_LISTS = /^Size: -?[\d.]+ (?:extends|\u00e9),|^Name: \{(?:readonly|get|set|static)\//;

// Defaults the scan reads exactly, by what their first token is, and the defaults it leaves.
const EXACT_DEFAULTS = {
  regex: ['/x/', '/[)]/', '/\\)/', '/(x)/', '/(/', '/[(]/', "/'/", '/"/', '/`/', '/[/]/', '/a\\/b/', '/=/', '/=x/', '/ /', '/\\//', '/x/g', '/x/in', '/x/\u00e9', '/x/*2', '/[/*]/', '/\\/*/',
    '\n/x/', ' /* c */ /x/', ' // c\n/x/'],
  element: ['<b>c</b>', '<b/>', '<b />', '<b>)</b>', "<b>it's</b>", '<b>(</b>', '<b x="1">y</b>', '<b x=")">y</b>', '<b x={1}>y</b>', '<b x={")"}>y</b>', '<A.B>y</A.B>', '<b>{")"}</b>', '<b><i>x</i></b>', '<b>`</b>', '<b>/</b>',
    '<b>//</b>', '<b>/*</b>', '<b x="\\" y=")" />', '<b>\n  x\n</b>', "<b x='\"'>y</b>",
    // A `<` that TypeScript's rule for a `.tsx` file leaves an element whatever follows it: a reserved word, an `extends` and a `>`, a name with an attribute, a name and a `>` and text that starts with a parenthesis.
    '<class>x</class>', '<this>x</this>', '<T extends>x</T>', '<const T>x</const>', '<b>(x) y</b>'],
  // An element whose text starts with a parenthesis and a colon: the list is read exactly, but a page that holds it as the code of a signature (`interface I { <T>(a = <b>(x): y</b>) }`) is a guess, because the scan
  // of the page reads an element there as a call signature that a colon follows, which compiles as JSX text does.
  elementText: ['<b>(x): y</b>'],
  template: ['`x`', '`)`', '`(`', '`\\``', '`a b`', '`/`'],
  division: ['b/(c)', 'b/c', '1/2', 'a/b/c', 'b / c', 'a.b/c', 'a?.b/c', 'x\n/y', '1.5/2'],
};
// ... and the defaults the scan leaves: a regex or an element that is not the first token, a `/` after what is no name or number (a comment between them included: a block comment, or a line comment and a line
// break, where the comment may end in a word and the regex that follows is not the division of it — `1 + // c` and `/[)]/`), a template with a `${`, and anything after a `{`;
// and an element whose `<` TypeScript reads as the type parameters of a generic arrow (`<T,>`, `<T = X>`, `<T extends X>`, `<const T,>`), where the arrow's own parameter list may hold a closing tag in a string.
const UNREAD_DEFAULTS = ['f(/x/)', '(b)/c', 'typeof /x/', '<b>c</b> / 2', '/x/ / 2', '`${b}`', 'x ? /y/ : z', '[/x/]', 'b + /x/', '{ k: 1 }/2', '() => { x/2 }', 'function () { x/2 }', 'a[0]/2', 'f()/2', '"s"/2', 'a /* c */ / b',
  '1 + // c\n/[)]/', 'x || // c\n/\\)/',
  'of/x/', 'yield/x/', 'new/x/', 'in/x/', 'return/x/', '<T,>(x) => x', '<T extends X>(x: T) => x', '<await>x</await>', '<b>c</b> + <d/>', '/x/ + /y/',
  '<T extends X>(x: T = "</T>") => x', '<T,>(x: T = "</T>") => x', '<T = "s">(x: T = "</T>") => x', '<const T,>(x: T = "</const>") => x', '<const T extends X>(x: T = "</const>") => x', '<T extends X = Y>(x: T = "</T>") => x',
  '<await extends X>(x: T = "</await>") => x', '<yield>x</yield>', '<>x</>', '< b>c</b>'];
// A regex that its line does not close (TS1161): no program that parses has it as a default, so a list that holds one is JSX text, for certain, in an element and in a type alike.
const UNTERMINATED_DEFAULTS = ['/x\n', '/x)\n', '/[)\n', '/>\n', '/ x\n', '/\\\n', '/(\n', '/x\r\n', '/x\u2028'];
// The lists that hold a default, from every default above and the places a default stands, with the text after the list that JSX may have and a type may not, and the endings that a type may have.
const DEFAULT_LABELS_EXACT = ['a = ', 'a: T = ', 'a?: T = ', 'a, b = ', 'a=', '{ a }: P = ', 'see = '];
function defaultLists() {
  const values = [...Object.values(EXACT_DEFAULTS).flat(), ...UNREAD_DEFAULTS, ...UNTERMINATED_DEFAULTS, '/x', '/x)', '/[)', '/>', '/x/)', '/ x', '<b', '`x', '`x${', '"x'];
  const lists = [];
  for (const value of values) for (const label of [...DEFAULT_LABELS_EXACT, 'a: A<B> = ', 'cb: <U = ']) lists.push(`${label}${value}`);
  for (const value of values) lists.push(`a = ${value}, b = ${value}`, `a = 1, b = ${value}`, `a = ${value}, b`, `a = x ${value}`, `a = ${value} y`);
  return lists;
}
// The lists whose default the scan reads exactly (or whose regex it knows is unterminated): the first `=` of the list has the default, and no `<` stands before it.
const exactDefaultLists = () => DEFAULT_LABELS_EXACT.flatMap((label) => [...Object.values(EXACT_DEFAULTS).flat(), ...UNTERMINATED_DEFAULTS].map((value) => `${label}${value}`));

// ─── A regex after a line comment ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// The scan of a parameter list reads a `/` after a name or a number as a division, and a block comment ends in a `/`, so a `/` after one stays a possible regex. A line comment ends in whatever its text does, though, and
// TypeScript skips it as trivia: after `a = 1 + // fallback` and a line break the last word is `fallback`, a name, and the last token is the `+` — so the `/` that begins the next line is a regex, whose `)` is not the one
// that ends the list:
//   interface I { <T>(a = 1 + // fallback
//   /[)]/); m: '</T>;navigateTo(…);//' }
// A scan that took that `/` for a division ended the list at the `)` in the regex, and read the string after it as code (lib/source-literals.js, slashFollowsAnOperand). The values below put every place a regex may follow an
// operator, a keyword or a bracket — and a division after a name or a number, which is as valid — behind a line comment and a line break (`@` is where they go), the comment ending in a name, a number, a `$`, a letter beyond
// ASCII, a sign, or nothing at all, and the line break of every kind TypeScript has. The regexes hold a `)`, a `>` or a closing tag, which ends a list or an element that took them for code.
const LINE_COMMENT_GAPS = [' // c\n', ' // x1\n', ' // $\n', ' // 1\n', ' // \u00e9\n', ' //\n', ' // c.\n', ' // a/b\n', ' // c\r\n', ' // c\r', ' // c\u2028', ' // c\u2029', ' /* a */ // b\n', '\n// c\n', ' // c\n // d\n',
  ' // c /* d\n'];
const REGEXES_AFTER_COMMENT = ['1 +@/[)]/', 'x ||@/\\)/', 'x &&@/(x)/', 'x ??@/x)/', '!@/[)]/', '-@/\\)/', 'typeof@/[)]/', 'void@/>)/', 'f(@/[)]/)', '(@/[)]/)', 'x ? y :@/\\)/', 'x ?@/[)]/ : y', '[@/\\)/]', 'a, b =@/[)]/'];
const DIVISIONS_AFTER_COMMENT = ['b@/ (c)', '1@/ 2', 'a.b@/ c', 'f()@/ 2', 'x@/ y / z'];
const commentedValues = (shapes, gaps = LINE_COMMENT_GAPS) => shapes.flatMap((shape) => gaps.map((gap) => shape.replace('@', gap)));
// The lists of a parameter list that hold such a default (after a label, and as a second default), and a regex that is the constraint of a function type in a parameter's type: `<U extends /x)/>(b: U) => U` is a type, whose
// constraint starts no type and is read as an expression.
const commentedDefaultLists = () => commentedValues([...REGEXES_AFTER_COMMENT, ...DIVISIONS_AFTER_COMMENT]).flatMap((value) => ['a = ', 'a: T = ', 'a?: string, re = '].map((label) => `${label}${value}`));
const commentedConstraintLists = () => LINE_COMMENT_GAPS.flatMap((gap) => ['/x)/', '/[)]/', '/\\)/', '/>(b: U) => U)/'].map((regex) => `a: <U extends${gap}${regex}>(b: U) => U`));
// The text after a call signature with no return type is read up to a closing tag (readChildren), where a later member's default holds a regex after a line comment, and the regex — a class holds the `/` of a closing
// tag — holds the closing tag of the head and the text of a call (`</T>` stands for the head's closing tag, as in the other endings).
const HOLDING_REGEXES_AFTER_COMMENT = ['1 +@/[</T>;CALL//]/', 'x ||@/[</T>;CALL]/g', 'typeof@/[^</T>;CALL]/', 'x ? y :@/[</T>;CALL//]/'];
const commentedMemberEndings = () => commentedValues(HOLDING_REGEXES_AFTER_COMMENT).flatMap((value) => [`;\n  m(a = ${value.replaceAll('CALL', CALL)}): void`, `\n  <U>(a = ${value.replaceAll('CALL', CALL)})`]);
// Generic arrows after a token that leaves a `<` undecided (`>=`, `in`, `void` and a line break, `<`), whose lists hold such a default: the head is `<T extends X>`, so the arrow or the text of an element is read by the scan.
const commentedArrowContinuations = () => {
  const continuations = {};
  for (const value of commentedValues([...REGEXES_AFTER_COMMENT, ...DIVISIONS_AFTER_COMMENT], [' // c\n', ' // $\n', ' // 1\n', ' // c\r\n', ' // c\u2028'])) {
    continuations[`an arrow / ${JSON.stringify(value)}`] = `<T extends X>(a = ${value}) => MARK`;
    continuations[`an arrow with a return type / ${JSON.stringify(value)}`] = `<T extends X>(a = ${value}): T => MARK`;
  }
  return continuations;
};

// ─── Prose with a comment in it ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// JSX text that starts with a parenthesis and runs over several lines, one of them with a `//` in it — a URL on a line of its own, a label and a URL, a name and a note — and then a line that starts with a `/`, a path:
//   const e = <p>(optional);
//     https://contoso.com
//     /docs</p>;
// A type that has this text for its members reads `//` as a comment, which is trivia, so the `/` on the last line follows what stands before the comment: the `:` of `https:`, where a type must follow (TS1110), or a name, which a
// `/` divides in an expression and no type has before a `/` (lib/source-literals.js, typeMembersFail and slashFollowsAnOperand). A lexer that took the last word of the comment for what the `/` follows read the name-and-note lines
// as a division (the base does), and one that gave up at the comment read every one as a regex that may hold the closing tag, and refused a page that only compiles as an element.
const PROSE_LEADS = [';', ',', ';\n  ', ',\n  ', '\n  ', '; ', ', '];
const PROSE_URLS = ['https://contoso.com', 'http://x.y/z', 'ftp://host'];
// The words before a URL's colon, and before a note: names and keywords. A modifier (`readonly`, `static`, `abstract`) is a name before a `:`, and is read as one wherever a `:` follows it.
const PROSE_LABELS = ['Docs', 'See', 'url', 'link', 'ref', 'type', 'from', 'as', 'of', 'is', 'new', 'static', 'readonly', 'abstract', 'default', 'in', 'get', '\u00e9'];
const PROSE_NAMES = ['b', 'name', 'a1', '$x', '_y', '\u00e9', '\u65e5\u672c', '1', 'type', 'from', 'as', 'of', 'is', 'new', 'return', 'typeof', 'void', 'delete', 'else', 'extends', 'implements', 'await', 'yield', 'case', 'do',
  'throw', 'instanceof', 'get', 'static', 'readonly'];
const PROSE_PATHS = ['/b', '/docs', '/ x', '/a/b/c more text'];
// A line that holds a `//`, by what stands before it: nothing but a URL's scheme and its colon, a label and then a URL, a name and a note.
const PROSE_COMMENT_LINES = [
  ...PROSE_URLS,
  ...PROSE_LABELS.map((label) => `${label}: ${PROSE_URLS[0]}`),
  ...PROSE_NAMES.flatMap((name) => [`${name} // note`, `${name}// note`]),
  'a: b // c', 'x // c // d', 'x /* c */ // d', 'x /* c\n */ // d', 'https://x.y // z',
];
// The same text with a first line that holds what the reading of the members of a type reads token by token (typeMembersFail), by what stands before the `//`: it begins with a parenthesis, a bracket, a quote, a tag, an operator or a
// number with a `.` or an exponent sign, ends in a postfix `!`, a call or an index, or starts with a modifier. In a type each fails where a member begins (TS1131), after a name (TS1005) or at the `/` after the comment (TS1110, TS1131),
// so only the element compiles, and the base resolved every one of them by the word that ends the comment.
const PROSE_LINE_CLASSES = {
  parenthesis: ['(x) // c', '() // c', '(x, y) // c', 'see (x) // c', 'Label: (x) // c', '(x): https://x.y', '(x?: y) // c', '(x = 1) // c', '(...x) // c', '(x)(y) // c', '(a, (b)) // c'],
  // A `(` that no `)` closes on the line, at a member's start or after a name: a parameter list that no parameter starts (a `/` after the comments, a number, a string), or whose first parameters fail (two names, a name and a `,` and then a
  // `/`), so no signature has it (TS1138, TS1003, TS1005; parameterListMayStart, parameterSyntaxFails).
  unclosedParenthesis: ['foo( // note', 'see foo( // note', 'f( // c', '( // c', 'a( // c', 'if ( // c', 'new ( // c', 'readonly ( // c', 'Total (x y // c', 'foo(1 // c', "foo('a' // c", 'f(a b // c', 'f(see docs // c', 'f(a, // c',
    'Call api.get( // returns JSON', '(a // c', 'f(x, // c'],
  // A `=` right after a name, a number, a string or a signature on its line: no member of a type has one (`m = 1` is TS1131, and `m(x) = 1` TS1005; with a `?`, a type or a line break before the `=` the initializer is kept for the checker). The text
  // after the `=` is read as no member's, whatever it holds.
  initializer: ['x = // note', '1.5 = // note', "'a' = // note", 'a = b + // note', 'a = b || // note', 'x = [ // note', 'x = (a, // note', 'total = price * qty // per line', 'm(x) = // note', 'type = // note', 'new = // note'],
  bracket: ['[x] https://contoso.com', '[x] // c', '[] // c', '[1, 2] // c', 'see [x] // c', '[x] y // c', '[x]: https://x.y', '[k: string]: https://x.y', '[x]?: https://x.y', '[x](y) // c', '[a.b] https://x.y',
    // An index signature starts with a `[`, a name and a `,` or a `:`, whatever follows (isUnambiguouslyIndexSignature), and neither a parameter nor a type starts with a `/`.
    '[ a, // c', '[ k: // c', '[a,\n  // c'],
  quote: ["'x' // c", '"x" // c', "'x': https://x.y", "'x // c", '"x // c', "'x' y // c", "'a b': https://x.y", '"x"(y) // c', "'it\\'s' // c"],
  tag: ['<b/> // c', '<b>y</b> // c', '<>y</> // c', '<b /> // c', 'see <b/> // c', '<b>y</b> https://x.y', 'new (x) // c', '<b>(x)</b> // c', '<b>y</b> (x): https://x.y'],
  operator: ['|| // c', '&& // c', '| // c', '& // c', '= // c', '== // c', '! // c', '? // c', '?? // c', '... // c', '. // c', '@ // c', '# // c', '{} // c', '{ a } // c', '=== x // c', '> // c', '=> // c', '#x // c'],
  postfix: ['x! // c', 'f() // c', 'x[0] // c', '!x https://x.y', 'x = 1 https://x.y', 'x! y // c', 'x!! // c', 'a[] // c', 'x ! // c', 'x = a b // c', "x = 'a' 'b' // c"],
  number: ['1.5 https://x.y', '.5 https://x.y', '1. // c', '1e+5 https://x.y', '1.5e+3 // c', '1e-5: https://x.y', '0.5 // c', '1E+3 // c', '1_0e+1 https://x.y', '.5e-3 // c'],
  modifier: ['readonly https://contoso.com', 'static https://x.y', 'in // note', 'default // note', 'get // note', 'set https://x.y', 'abstract // c', 'declare\n  https://x.y', 'readonly static x // c', 'const // c', 'out https://x.y', 'export // c'],
  // What goes on over a line break, or after a type: `&` and `|` at the start of a line go on a type and not a name or a signature, a `:` there is a type's or TS1005, a type goes on with `.`, `|` and `&`, and a keyword,
  // a sign or a `,` after a type or where a type must be is TS1005 or TS1110.
  continuation: ['m\n  &"x" // c', '(b, c)\n  &"x" // c', '"x" // n\r!\r"x" // n', 'https://x.y\r||\nhttps://x.y/z', "'s'\r\n||\rhttps://x.y", 'in @ // c', 'typeof\r\n:https://x.y', 'm\n  : https://x.y', 'a: A\n  : B // c', 'a: A\n  ? B // c', 'a: A.B, // c', 'a: A | B; // c',
    'a: A default // c', 'a: A in // c', 'a:, b // c', 'a: ; b // c', 'a: = 1 // c', 'a: -1, // c', 'a: keyof T, // c', 'a: unique symbol, // c', 'a: A | // c', 'a: A & // c', 'a: A\n  || b // c', 'a: ||', 'readonly . // c', 'static * // c'],
  // A `[` after a `:` or a type, on its line, opens a tuple or an indexed access, whose first type is no `/` (TS1110): the path on the next line is no type's, and no regex that holds the closing tag begins there.
  tuple: ['Total: [ // note', 'a: A[ // c', 'm: A | [ // c', 'Total: [ /* c */', 'a: B.C[ // c', 'Range: [ // inclusive', 'a?: [ // c', 'a(): [ // c'],
};
const PROSE_SHAPED_LINES = Object.values(PROSE_LINE_CLASSES).flat();
// The lines whose `//` stands behind a token after which a regex may begin and that a type's members can have there: an `[` that nothing closes (a computed name), an initializer's `=` after a `?` or a type (`x? =`, `x: A =`, which the checker, not the
// parser, objects to) or in a parameter list (`f(a =`), or an operator or a `,` in such an expression. A regex may begin at the `/` of the next line, and the closing tag of the head may be inside it (`<p>(a); [ // note` and a line break, then
// `/[</p>;navigateTo(…)//]/]: string`: a type, and `<p>(a); [ // note⏎ /[` then `</p>` and the call: an element). Both compile, so the page is a guess where a member of a type may begin at the head, and an element for certain where none can
// (source-literals.js, NO_MEMBER_BEFORE). The base read the word that ends the comment for the token before the `/`, and resolved them.
const PROSE_OPEN_LINES = ['[ // note', 'f(a = // note', 'x: A = // note', 'x? = // note', '[ x = // note', 'x: A = b + // note'];
// The elements: `(a)`, a separator, the line, a path on the next line, and the closing tag after it, on its line or the next.
const PROSE_ENDS = ['</p>', '\n</p>'];
function* proseElements({ leads = PROSE_LEADS, lines = PROSE_COMMENT_LINES, paths = PROSE_PATHS, ends = PROSE_ENDS } = {}) {
  for (const lead of leads) for (const line of lines) for (const path of paths) for (const end of ends) yield `<p>(a)${lead}${line}\n  ${path}${end}`;
}
// Where the closing tag could be inside the comment, which a type with the same text for its members could hold it in: a guess.
const PROSE_HIDING_ELEMENTS = ['<p>(a);\n  https://x.y</p>', '<p>(a), see: // c </p>', '<p>(a);\n  type: // c </p>', '<p>(a)\n  b // c </p>', '<p>(a);\n  default: // c </p>'];
// ... and the members of a type that hold the closing tag of the head (`</T>`) in a comment after a name or a label, with a line after it that makes it a type: both programs compile.
const PROSE_HIDING_ENDINGS = [';\n  https: // </T>\n  string', ',\n  see: // </T>\n  T', ';\n  name // </T>\n  m: 1', ';\n  type: // </T>\n  string', ';\n  default: // </T>\n  string', '\n  b // </T>\n  m: 1', ';\n  new // </T>\n  m: T',
  ';\n  readonly // </T>\n  m: T', ';\n  a:\n  // </T>\n  string', ';\n  a: /* </T> */ string', ';\n  a: b // </T>\n  c: d', ';\n  a:\n  /* c\n  </T> */ b'];
// Members of a type that read like the prose above and compile, with no closing tag: the type is code, for certain.
const PROSE_TYPE_ENDINGS = [';\n  https: // c\n  string', ',\n  see: // c\n  T', ';\n  name // c\n  m: T', ';\n  a: b // c\n  c: d', ';\n  type: // c\n  string', '\n  b\n  // c\n  m: T'];

module.exports = {
  REGEX_BODY, AFTER, AFTER_WITH_CALL, CONTINUATIONS, SEPARATORS, TRIVIA_SEPARATORS, FRAMES, PRODUCER_FRAMES, tokenVocabulary, programsFor, cleanSourceFile, readingAt, isElement,
  CALL, SIGNATURE_FRAMES, SIGNATURE_HEADS, SIGNATURE_ENDINGS, HIDING_ENDINGS, DECOYS, signaturePage, signaturePages, ELEMENT_FRAMES, MEMBER_ELEMENT_FRAMES, NO_MEMBER_ELEMENT_FRAMES, JSX_ONLY_ELEMENTS, valuedKeywordElements, CERTAIN_ELEMENTS, GUESSED_ELEMENTS,
  HIDDEN_TEXT_ELEMENTS, UNREAD_LIST_ELEMENTS, elementPage, elementPages,
  failingLists, LEFT_LISTS, EXACT_DEFAULTS, UNREAD_DEFAULTS, UNTERMINATED_DEFAULTS, defaultLists, exactDefaultLists,
  LINE_COMMENT_GAPS, commentedDefaultLists, commentedConstraintLists, commentedMemberEndings, commentedArrowContinuations,
  PROSE_LEADS, PROSE_URLS, PROSE_LABELS, PROSE_NAMES, PROSE_PATHS, PROSE_COMMENT_LINES, PROSE_LINE_CLASSES, PROSE_SHAPED_LINES, PROSE_OPEN_LINES, PROSE_HIDING_ELEMENTS, PROSE_HIDING_ENDINGS, PROSE_TYPE_ENDINGS, proseElements,
};
