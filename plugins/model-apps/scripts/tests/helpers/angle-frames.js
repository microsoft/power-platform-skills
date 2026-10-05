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
// (`{ <U>(y: U): void }`), which the reading of the text does not read. `<T>` and `</T>` stand for the head's name.
const HIDING_ENDINGS = [";\n  m: '</T>'", ';\n  m: "a</T>b"', ';\n  m: `</T>`', ';\n  // </T>\n  m: number', ';\n  /* </T> */', ';\n  /** </T> */ m: number', ";\n  m: '</T>' | '<T>'", ';\n  m: { <U>(y: U): void }'];

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

// The places an element stands.
const ELEMENT_FRAMES = [
  ['a declaration', 'const e = @;'], ['an argument', 'f(@);'], ['a property', 'const o = { k: @ };'], ['a child', 'const p = <p>{@}</p>;'], ['a return', 'function g() { return @; }'],
  ['a default export', 'export default @;'], ['a conditional', 'const k = c ? @ : null;'], ['an arrow body', 'const m = items.map((x) => @);'], ['a block', 'if (a) { @ }'], ['an array', 'const l = [@];'],
  // A quote on the line after the element: the apostrophe in its text is no string that this quote could close.
  ['a conditional with a string', "const k = c ? @ : 'none';"], ['a template', 'const k = `${@}`;'],
];
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
];
// The same, where the closing tag could be inside a comment, a template or a regex that the text opens, and is not closed before it, and the text before it could be the members of a type: a guess.
const GUESSED_ELEMENTS = ['<p>(a); // c </p>', '<p>(a);\n  /* c </p>', '<p>(a); `x ${y} </p>', '<p>(a), = /re/ </p>', '<p>(a), x // c </p>', '<p>(a),\n  see\n  x // c </p>', '<p>(a), readonly x // c </p>', '<p>(a);\n  see /* c </p>'];

function elementPage(frame, element, decoy = DECOYS.string) {
  const name = /^<([\w.]+)>/.exec(element)[1];
  return { code: `${frame.replace('@', element)}\n${decoy.replaceAll('NAME', name)}\n${CALL};\n`, at: frame.indexOf('@'), name };
}
const elementPages = (elements, decoy = DECOYS.string) => ELEMENT_FRAMES.flatMap(([frameName, frame]) => elements.map((element) => ({ ...elementPage(frame, element, decoy), label: `${frameName} / ${JSON.stringify(element)}` })));

module.exports = {
  REGEX_BODY, AFTER, AFTER_WITH_CALL, CONTINUATIONS, SEPARATORS, TRIVIA_SEPARATORS, FRAMES, PRODUCER_FRAMES, tokenVocabulary, programsFor, cleanSourceFile, readingAt, isElement,
  CALL, SIGNATURE_FRAMES, SIGNATURE_HEADS, SIGNATURE_ENDINGS, HIDING_ENDINGS, DECOYS, signaturePage, signaturePages, ELEMENT_FRAMES, CERTAIN_ELEMENTS, GUESSED_ELEMENTS, elementPage, elementPages,
};
