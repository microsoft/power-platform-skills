'use strict';
// A small lexer for TSX source, used where a check has to distinguish real code from text.
//
// WHY hand-rolled: this plugin ships **dependency-free** (no package.json, no node_modules; it is
// installed by copying its directory, and every runtime `require` under scripts/ is a node builtin
// or a relative path), so there is no TypeScript parser to call. Several checks nevertheless have to
// answer "is this token code, or is it text?", and getting that wrong is costly in BOTH directions:
//
//   accepting text as code   ->  prose is promoted as a page, permanently marked implemented
//   rejecting code as text   ->  a valid generated page is refused and the user is blocked mid-build
//
// The second is worse, which is why this tracks JSX properly instead of running regexes over the
// raw file. Naive approaches fail on ordinary generated pages:
//   <p>https://contoso.com/help</p>   `//` is not a comment here
//   <p>1) Review details</p>          `)` is not a bracket here
//   const re = /\(/;                  `(` is not a bracket here
//   "The worker says export default X is required."   not an export statement
//
// MODES: code (incl. JSX expressions), comment, string, template, regex, JSX tag, JSX text. A
// template's `${…}` body is code, read by the same machine (lexInto).
// Blanked characters become spaces and newlines are preserved, so output offsets map 1:1 onto the
// input and a caller may mix matches across both.

// `/` starts a regex (rather than division) only where an expression may begin. Same idea for `<`
// starting JSX rather than a comparison or a TypeScript generic argument list.
const EXPR_START_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n']);
// Reserved words that are followed by an expression, so a `/` after one is a regex (and a `<` an element): `throw /x/`, `export default /x/`,
// `class A extends /x/ {}` as much as `return /x/`. The list is the reserved words of https://tc39.es/ecma262/#sec-keywords-and-reserved-words that
// take an operand, plus `of` and `yield`, which only sometimes are keywords (CONTEXTUAL_WORDS); the others (`break`, `catch`, `for`, `if`, …) are
// followed by a label, a bracket or a block, or end an operand (`this`, `null`, `super`, `true`).
const EXPR_START_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw', 'default', 'extends']);

// ECMAScript LineTerminator is LF, CR, LS and PS; CRLF is one terminator. LS/PS also
// terminate // comments and regex literals, but since ES2019 they are legal inside string
// literals. See https://tc39.es/ecma262/#sec-line-terminators and
// https://tc39.es/ecma262/#sec-literals-string-literals.
function isLineTerminator(ch) {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

// ─── The characters TypeScript's scanner skips between tokens ───────────────────────────────────────────────────
//
// `isWhiteSpaceSingleLine` (U+0009, U+000B, U+000C, U+0020, U+00A0, U+0085, U+1680, U+2000–U+200B, U+202F, U+205F, U+3000, U+FEFF) and `isLineBreak` (U+000A, U+000D, U+2028,
// U+2029), in https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts. JavaScript's `\s` — and so `String.prototype.trim` — is all of them but two: the
// next-line character U+0085 and the zero-width space U+200B, which TypeScript skips and JavaScript does not call white space. A lexer that used `\s` read
//   if<U+0085>(true) /navigateTo({ … })/;
// as an `if` that is not there, took the `)` for the end of an operand, and read the regex as a division — and the token in it was rewritten. So every test for white
// space in this file and in pageref-resolver.js is this one (isTrivia, TRIVIA_CLASS), whichever way the scan goes, and a test fails if `\s` or `trim(` comes back
// in code (source-literals.test.js). The explicit class of single-line white space is the same set without the four line terminators, for the places where TypeScript asks
// that two tokens be on one line (`hasPrecedingLineBreak`).
const TRIVIA_CLASS = '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200B\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
const TRIVIA_SINGLE_LINE_CLASS = '\\t\\v\\f \\u0085\\u00A0\\u1680\\u2000-\\u200B\\u202F\\u205F\\u3000\\uFEFF';
const TYPESCRIPT_TRIVIA = new RegExp(`[${TRIVIA_CLASS}]`);
const TYPESCRIPT_TRIVIA_SINGLE_LINE = new RegExp(`[${TRIVIA_SINGLE_LINE_CLASS}]`);
// The two as pieces of a regular expression source (`new RegExp(`a${WS}+b`)`): one white space character, with or without a line break.
const WS = `[${TRIVIA_CLASS}]`;
const WS_SINGLE_LINE = `[${TRIVIA_SINGLE_LINE_CLASS}]`;

function isTrivia(ch) {
  return typeof ch === 'string' && ch !== '' && TYPESCRIPT_TRIVIA.test(ch);
}

function isSingleLineTrivia(ch) {
  return typeof ch === 'string' && ch !== '' && TYPESCRIPT_TRIVIA_SINGLE_LINE.test(ch);
}

// `String.prototype.trim` with TypeScript's white space: both ends, line breaks included.
function trimTrivia(text) {
  let from = 0;
  let to = text.length;
  while (from < to && isTrivia(text[from])) from += 1;
  while (to > from && isTrivia(text[to - 1])) to -= 1;
  return text.slice(from, to);
}

function lineTerminatorStart(src, from) {
  for (let i = from; i < src.length; i += 1) if (isLineTerminator(src[i])) return i;
  return -1;
}

function isRawStringBreak(ch) {
  return ch === '\n' || ch === '\r';
}

// The index just past the escape that starts at `i`, a backslash. An escape is the backslash and the one character
// after it, except that a backslash before CR LF continues the string over BOTH: CR LF is one line terminator, so
//   "a\<CR><LF>b"
// is a complete string (https://tc39.es/ecma262/#prod-LineContinuation). Skipping only the CR left the LF to be read
// as a raw line break, which ends a string, so a page saved with CRLF endings and wrapped through a long string was
// refused as truncated. Only the quoted-string scanners need this: in template text a line break is ordinary text,
// and a regex literal cannot contain one at all.
function escapeEnd(src, i) {
  return src[i + 1] === '\r' && src[i + 2] === '\n' ? i + 3 : i + 2;
}

// The last character before `i` that is not white space — in the lexer's output blanked text is white space — with its index, and whether a
// line terminator stands between it and `i`. A block comment that holds a line break is a line break to the grammar (ECMA-262,
// https://tc39.es/ecma262/#sec-comments), and blanking keeps the line terminators of what it blanks, so such a comment counts here too.
function prevSignificant(src, i) {
  let newline = false;
  for (let j = i - 1; j >= 0; j -= 1) {
    if (!isTrivia(src[j])) return { ch: src[j], index: j, newline };
    if (isLineTerminator(src[j])) newline = true;
  }
  return { ch: '', index: -1, newline };
}

// ─── Where a `/` or `<` is read by guess ────────────────────────────────────────────────────────────────────────
//
// A `/` is a regex or a division, and a `<` opens a JSX element or compares, depending on what stands before it; a lexer with no parser can
// only guess at some of those. A wrong guess blanks real code (a regex run on to the next `/`, and the `/*` inside it opens a comment) or
// reads text as code, and from there on the mask is not what the page means. So each decision that rests on a heuristic rather than on the
// grammar reports itself through `onAmbiguity(at, kind)`, at the offset of the `/`, `<` or construct it could not read for certain. The
// tokenization is the same whether anyone listens; a caller that must not trust what it cannot be sure of takes the earliest offset as a
// frontier. Every branch of the lexer is either CERTAIN (the grammar decides, said where it is read) or one of these kinds:
//
//   brace               `}` ends a block (a `/` then begins a regex) or an object or function expression (it divides)
//                         const n = {valueOf(){return 12;}}/2; const re = /x/;
//   paren               `)` ends an if/for/while head (a regex follows) or an operand (a division), and its `(` is out of reach
//                         if (true /* …2,100 characters… */) /navigateTo({…})/.test(text);
//   keyword             a word that is a keyword in some places and a name in others
//                         const of = 12; const n = of/2; const re = /\/*$/;
//   angle               a `>` may close type arguments, a JSX tag or a comparison; the `>` of `=>`, the closer of a cast the lexer proves is one (castKeywordIsCertain) and the end of an element
//                       or a regex it read are certain
//                         const half = total as Types . Alias<number> / 2; const re = /x/;
//   identifier          an identifier written with a Unicode escape, or a keyword-looking word cut by `#` or a non-ASCII letter
//                         var Al\u0069as = 12;        this.#new / total / 2
//   operator            a `/` after a spread `...` or after a run of three signs, and the second `<` of a shift before a name that may start an element
//                       (`1<<n>x</n>`; where what follows cannot be one, `1<<n;`, it is the shift it is); and a `<` whose head has a constraint and a parameter list
//                       that a `:` follows, right after the cut `>=`, `>>=` or `>>>=` (the first `>` may end type arguments), after a `<`, after `in` or after
//                       `yield *`: TypeScript reads an element in one program and an arrow or a function type in another. (A `/` after a `/` is no guess: the lexer
//                       read the first, and knows whether it ended a regex or was the division operator — see `ends`, above readPosition.)
//                         [.../a/.exec(s)]            a+++/x/.test(s)             1<<n>x</n>
//                         a >= <T extends X>(y: T): T</T>      let x: A<number>= <T extends X>(y: T): T => y      yield * <T extends X>(x: T): T</T>
//   newline             a `/` or `<` on a later line than the operand before it (a name, a literal, `)`, `]`, `}`, `>`), a `/` after `throw`
//                       and a line break, and a `<` that could open a generic after `void` and a line break: ASI may have ended a statement at the
//                       break, and in a type context (a type alias, an annotated declaration with no initializer, an overload signature) it did,
//                       so a regex or an element begins the next one
//                         type Value = number
//                         /navigateTo({…})/.exec(text)                  let x: void       void
//                                                                         <T extends X>(y: T): T => y;  <T extends X>(y: T): T</T>;
//   jsx-type-arguments  a JSX element whose type arguments hold a string, template, object or function type: TypeScript's rules apply there,
//                       and the tag is scanned by a JSX attribute's (type arguments of names only — `<DataGridRow<Row>` — are certain)
//                         <Component<"quote\"\<LF>/*"> onClick={…} />
//   jsx-attribute       a JSX attribute string written after white space or a comment that follows its `=`, and holding a backslash that makes
//                       the end TypeScript reads — a JavaScript string, with escapes — another than the end every other compiler reads
//                         <C x= '\'/>;navigateTo({…});//' />
//   jsx-open            a `<` where an element may start that is not read as one: space after it, or a name beyond ASCII — in code, in JSX text and as an
//                       attribute's value — or a closing tag that holds anything but trivia, comments and a name before its `>`, so that where it ends is not known
//                         < div>x</div>               <Ñ/>               <A x=< B/>>…</A>               <A></A b>
//   generic             a `<Name>` followed by a parameter list and a `:` — a type's call signature, or JSX text that starts with a parenthesis; both
//                       compile — or a parameter list too long to scan, except directly after `type Name =`, where it is certainly a type; a `=>`
//                       after the list is a generic function type, for certain, wherever the element reading of the text up to the arrow cannot
//                       parse (a `>` or `}` in the text; an expression container that starts with a name, a number, a bracket, a call or a quoted name and
//                       a colon or a call, or with two names, or that holds nothing that could hide a `}` of its own — no brace, quote, back-tick, backslash or `<`, and no `/` but a
//                       comment's; a `<` and a character that cannot start a tag, … — elementFailsAt), and a guess, read as a type, where it may (the arrow
//                       inside the attribute string of a nested tag, a closing tag, a spread, a container that holds a brace, a quote, a regex or a `<`,
//                       white space beyond ASCII where a token of a tag could start or end); `<await` and `<yield`, which are identifiers or
//                       not by the function around them; a parameter list that neither `=>` nor `:` follows, which is JSX text or a call signature with no return
//                       type (callSignatureOrElement) — an element for certain where a `,`, `;`, `}` or line break does not follow the `)` (TypeScript wants one after a
//                       signature), or the text read as an element's children reaches its closing tag; a signature, for certain, where that reading fails (a `}` in the text
//                       that ends the type, a `</*` that starts the next signature's type parameters); a guess only where the closing tag could be inside a string, a template,
//                       a comment or a regex that the text opens, or the text cannot be read, or the pass's budget of readings is spent; and TypeScript's rule
//                       for a `<` (see below) decides everything else
//                         interface Callable { <T>(x: T): T }          <span>(required): Name</span>          const f: <T>(x: { 'a'?(y: T): T }) => T = g;
//                         <Wrapper>(<Child x="\" y=") =>" />)</Wrapper>          async function p() { return <await extends X>text</await>; }
//                         interface I { <T>(x); m: '</T>' }          <p>(a), see https://x.y</p>
//                       (not a guess: `interface I { <T>(x) }`, `type L = { <T>(x); m: { a: string } }`, `<b>(optional)</b>`, `<p>({t("label")})</p>`, `<p>(a), 1/2 done</p>`)
//   fallback            a quote with no closing quote on its line, read as an ordinary character; a `/` after a character that begins nothing
//                       in code (`#`, `@`, a control character)
//                         const a = 'unterminated        const n = # / 2 / 3;
//
// Everything else is CERTAIN, and `readPosition` says why at each branch. Two things decide a `!`, `++`, `--` or a keyword before a line break by
// the grammar and not by a guess: ASI and its restricted productions (ECMA-262 §12.10, https://tc39.es/ecma262/#sec-automatic-semicolon-insertion,
// and §12.10.1 for `[no LineTerminator here]`), which TypeScript's parser (src/compiler/parser.ts) reads the same way — a postfix `!`
// (parseMemberExpressionRest) and a postfix `++` or `--` (parseUpdateExpression) need no line break before them; `break`, `continue` and
// `return` (canParseSemicolon), `throw` (parseThrowStatement) and `yield` (parseYieldExpression) end at one. And a `<` where an expression
// starts is an element, a generic arrow's type parameters or a function type by the token before it (ANGLE_AFTER) and, where an assignment
// expression starts, by TypeScript's own TSX rule, read from the next few tokens (opensTypeParameters). The text after the `<` can settle it whatever
// stands before: a head that cannot be an element — a `,` or `=` after its name, a parameter list and an arrow whose element reading fails
// (elementReadingFails) — is type parameters, and a head with a constraint and no parameter list is an element in every program that parses
// (headWithoutParameterList).

// The kinds above, as data: a caller that words them for a person (the report on a navigation token) reads this list, and the tests refuse
// a kind that is not on it, so a kind cannot be added without its wording.
const AMBIGUITY_KINDS = Object.freeze(['brace', 'paren', 'keyword', 'angle', 'identifier', 'operator', 'newline', 'generic', 'jsx-type-arguments', 'jsx-attribute', 'jsx-open', 'fallback']);

// Words that are keywords in some positions and ordinary names in others. After `of`, `await` and `yield` the table expects an expression
// (a regex), and after the others a name (a division); either can be wrong, and which depends on the grammar around the word. `implements` is the
// word whose heritage clause takes an expression, as `extends` does — `class C implements /x/ {}` is a regex to TypeScript — and a name elsewhere (a
// strict-mode reserved word that the parser accepts as one).
const CONTEXTUAL_WORDS = new Set(['of', 'await', 'yield', 'let', 'async', 'static', 'get', 'set', 'as', 'satisfies', 'type', 'from', 'declare', 'abstract',
  'readonly', 'keyof', 'infer', 'is', 'asserts', 'override', 'accessor', 'using', 'out', 'module', 'namespace', 'global', 'unique', 'implements']);

// Whether a word read back from `s + 1` was cut short by a character that can belong to an identifier but is not in [\w$]: a Unicode escape's
// backslash, a private name's `#`, a letter beyond ASCII. The word is then not the keyword it spells, or not all of the name.
function cutsWord(src, s) {
  const c = s >= 0 ? src[s] : '';
  return c === '\\' || c === '#' || (c !== '' && c.charCodeAt(0) > 0x7f && !isTrivia(c));
}

// What the lexer itself read, by the offset of the last character of what it read, for the one question the output alone cannot answer: in the output a blanked regex keeps
// its delimiters and its flags, a self-closing tag or a closing tag keeps its `>`, and a division is a bare `/`, so
//   const n = /x/ / 2;        a regex that ENDS at the second `/`, then a division
//   const r = a / /y/;        a division, then a regex that starts at the third `/`
//   const e = <b/> / 2;       an element that ends at the `>`, then a division
//   const m = /x/in / 2;      a regex that ends at the `n`, which TypeScript reads as a flag, then a division
// look alike to a scan of the output, which can only say that the character before the `/` is a `/` or a `>` — or a word, which it takes for a keyword — a guess, whatever it read. The lexer
// knows which it read, because it read it: `ends` maps the offset of a regex's last character — its closing `/`, or the last of its flags — to 'regex', of the `>` that ends a whole element in code
// to 'element' (an element in an attribute's value is no operand of code, and an opening tag's `>` ends nothing), and of a `/` it read as the division operator to 'division'. Every one was read right
// if the reading up to it was certain, and where a guess was reported before it, it is the frontier: so what is decided from them inherits the certainty (readPosition).
const OPERAND_ENDED = Object.freeze({ expression: false, ambiguity: null, ended: true });
const EXPRESSION_STARTS = Object.freeze({ expression: true, ambiguity: null });
// The position after a `>` that is an operator for certain, one that follows what the lexer knows ended an operand (positionAfterGreaterThan): an expression starts there, and the token's own `angle` guess
// (angleBefore) is not made.
const OPERATOR_AFTER_OPERAND = Object.freeze({ expression: true, ambiguity: null, operator: true });

// What stands before the `/` or `<` at `i` decides how it is read. Returns { expression, ambiguity }: whether an expression may begin there
// (a `/` is then a regex, a `<` a JSX element) and the kind of guess that answer rests on, or null where the grammar decides. `ends` is what the lexer read (above), where it is the
// lexer that asks; a caller that has only the output (expressionPosition) has none, and the position after a `/` or a `>` is then a guess.
function readPosition(src, i, ends = null) {
  const prev = prevSignificant(src, i);
  const position = positionAfter(src, prev, ends);
  // A `/` or `<` on a later line than the operand before it. ASI (ECMA-262 §12.10.1) ends a statement at a line break wherever the next token
  // cannot continue it, and in a TYPE context — a type alias, an annotated declaration with no initializer, an overload signature — a `/` or
  // `<` cannot, so a regex or an element begins the next statement, where in an expression the same words divide or compare. Which context
  // this is needs a parser, so a position read as an operand across a line break is a guess (`newline`), whatever the operand was:
  //   type Value = number
  //   /navigateTo({…})/.exec(text)
  // A position that is an expression start already (an operator, a bracket, a keyword) is that either way, and one with a guess of its own
  // keeps that kind. An operand that is a regex literal or an element is no type, and ASI inserts nothing before a `/` or `<` that continues an expression, so it is a division
  // or a comparison on any line: `const n = /x/` LF `/ 2;` and `const n = <b/>` LF `/ 2;` are divisions.
  if (prev.newline && !position.expression && position.ambiguity === null && !position.ended) return { expression: false, ambiguity: 'newline' };
  return position;
}

// The position after an operator that is postfix after an operand on the same line and prefix everywhere else — a `!` (TypeScript's non-null
// assertion) at `at`, or a `++` or `--` whose first sign is at `at` — which is that of what stands before it, unless a line break does: then ASI
// ends the statement and the operator begins the next, so an expression follows. In the grammar a postfix `!` is
// `token() === ExclamationToken && !scanner.hasPrecedingLineBreak()` (parseMemberExpressionRest) and a postfix `++` or `--` is
// `LeftHandSideExpression [no LineTerminator here] ++` (ECMA-262 §12.10.1; parseUpdateExpression), so after a line break the `!` is a logical
// not and the `++` an increment of what FOLLOWS — and a `/` after either is a regex.
// A run of them (`a!!!!`, `a ++ ++`) is walked back over in a loop: the source is untrusted, and calling this once per operator overflowed
// the call stack a few thousand operators in.
function positionAfterPrefixable(src, at, ends = null, depth = 0) {
  let p = at;
  for (;;) {
    const before = prevSignificant(src, p);
    if (before.newline) return { expression: true, ambiguity: null };
    if (before.ch === '!') { p = before.index; continue; }
    // Exactly two signs: three are `a++ + x`, a guess that positionAfter reports (`operator`).
    if ((before.ch === '+' || before.ch === '-') && src[before.index - 1] === before.ch && src[before.index - 2] !== before.ch) { p = before.index - 1; continue; }
    return positionAfter(src, before, ends, depth);
  }
}

// The reading of the position after the previous significant character `prev` ({ ch, index, newline }, see prevSignificant); readPosition adds
// what a line break between them means. `depth` counts the casts that this reading is asked about from one another (castKeywordIsCertain).
function positionAfter(src, prev, ends = null, depth = 0) {
  const { ch, index } = prev;
  if (ch === '') return { expression: true, ambiguity: null };                // start of file: CERTAIN
  // The last character of a regex literal that the lexer read ends an operand, and it is its closing `/` or, where flags follow, the last of them (`/x/is`, `/x/in`): the flags are read as the
  // scanner reads them (regexFlagsEnd), so a word that they spell is no keyword, a `/` after it divides and a `<` compares. CERTAIN, on every line.
  if (ends !== null && ends.get(index) === 'regex') return OPERAND_ENDED;
  // A postfix operator ends an operand, so a `/` or `<` after one is an operator too:
  //   closed! / total      TypeScript's non-null assertion
  //   i++ / 2              postfix increment (or decrement)
  // `!` is postfix exactly when it does not itself start an expression and has no line break before it (positionAfterPrefixable), so a prefix
  // `!` still opens one: `return !/\(/.test(s)`, `if (bad) !/\(/.test(s)` (see closesStatementHead) and `x` LF `!/\(/.test(s)`. CERTAIN given
  // what stands before the `!`, whose guess it inherits.
  if (ch === '!') return positionAfterPrefixable(src, index, ends, depth);
  // `++` and `--` likewise: CERTAIN for two signs, inheriting what stands before them; a guess for three, where `a+++/x/` is `a++ + /x/`.
  if ((ch === '+' || ch === '-') && src[index - 1] === ch) {
    return src[index - 2] === ch ? { expression: false, ambiguity: 'operator' } : positionAfterPrefixable(src, index - 1, ends, depth);
  }
  // A `>` can be a binary relational operator (`count > /re/.test(x)`), the `>` of an arrow's `=>`,
  // a JSX tag close, or a type-argument close after a cast. Only the latter two end an operand.
  // The cast case is intentionally narrow: `total as NonNullable< number > / count` divides, but
  // `count<limit ? () => /re/ : ...` must leave `=>` as an expression-start token before a regex.
  // The `>` of `=>` is an arrow whatever follows: CERTAIN. The `>` that ends a whole element, which the lexer read, ends an operand: CERTAIN (`<b/> / 2`), and so does the one that closes the
  // type arguments of a cast the lexer can prove is one (castKeywordIsCertain). Any other is read by a bounded heuristic that cannot see through a type name spelled with an escape or around a dot
  // (`Types . Alias<number> / 2`): `angle`.
  if (ch === '>') {
    if (ends !== null && ends.get(index) === 'element') return OPERAND_ENDED;
    return positionAfterGreaterThan(src, index, ends, depth);
  }
  // `}` ends a block or an object literal: `brace`. After any other character in the set only an expression can follow: CERTAIN.
  if (EXPR_START_PUNCT.has(ch)) return { expression: true, ambiguity: ch === '}' ? 'brace' : null };
  // A `)` usually ends an operand — `counts.get(k)! / total`, `(a + b) / 2` — but the `)` that
  // closes an `if (…)`, `for (…)` or `while (…)` head is followed by a STATEMENT, where an
  // expression starts: `if (x) /re/.test(y)`. Certain once its `(` is found; `paren` when it is not.
  if (ch === ')') {
    const head = statementHead(src, index);
    return { expression: head.head, ambiguity: head.ambiguity };
  }
  // After `]` an operand has ended: CERTAIN.
  if (ch === ']') return { expression: false, ambiguity: null };
  if (/[\w$]/.test(ch)) {
    // Could be the tail of a keyword like `return` — read the word back. Built char by char so `src`
    // may be the lexer's partly blanked output ARRAY as well as a string (see blankLiterals).
    let s = index;
    while (s >= 0 && /[\w$]/.test(src[s])) s -= 1;
    let word = '';
    for (let k = s + 1; k <= index; k += 1) word += src[k];
    // ...unless it is a PROPERTY that happens to share a keyword's name — a status count is often
    // keyed `new`, and `counts.new / total` divides. `?.new` is a property too; a spread's
    // `...new Set(x)` is the keyword.
    const property = isPropertyName(src, s);
    const keyword = EXPR_START_WORDS.has(word) && !property;
    // `break` and `continue` take only a label, and one on the SAME line (a restricted production, ECMA-262 §12.10.1; TypeScript's
    // `canParseSemicolon` ends the statement at a line break), so after a line break the statement is over and a `/` starts the next one: a
    // regex. On the same line neither can be followed by a `/` at all, so the table's reading stands. `return` is on the list of words that
    // start an expression, and ends its statement at a line break the same way, so what follows is a regex either way.
    const expression = keyword || (prev.newline && !property && (word === 'break' || word === 'continue'));
    // A reserved word is certain; a name is certain. What is not: a word that is a keyword here and a name there (`keyword`), one cut
    // short by an escape, `#` or a non-ASCII letter, which is not the word it spells (`identifier`), and `throw` before a line break — an
    // error in JavaScript, `throw;` to TypeScript's `parseThrowStatement` — where what follows is unknowable (`newline`).
    if (cutsWord(src, s)) return { expression, ambiguity: 'identifier' };
    if (keyword && word === 'throw' && prev.newline) return { expression, ambiguity: 'newline' };
    return { expression, ambiguity: !property && CONTEXTUAL_WORDS.has(word) ? 'keyword' : null };
  }
  // `...` is the spread operator, after which an expression starts; the table knows only the member dot, after which none can: `operator`.
  if (ch === '.' && src[index - 1] === '.' && src[index - 2] === '.') return { expression: false, ambiguity: 'operator' };
  // A `/` is the end of a regex literal, after which a division follows, or a division operator, after which a regex does; in the output they are the same character. The lexer
  // knows which it read (see `ends`, above): after a division an expression starts, CERTAIN (the end of a regex was settled at the top). A caller that has only the
  // output cannot tell: `operator`.
  if (ch === '/') {
    const read = ends === null ? undefined : ends.get(index);
    if (read === 'division') return EXPRESSION_STARTS;
    return { expression: false, ambiguity: 'operator' };
  }
  // After the end of a string or a template (a quote, a back-tick) an operand has ended, after a member dot a name follows, and a name that
  // ends in a letter beyond ASCII is an identifier (the lexer's output holds no other text there): CERTAIN.
  if (ch === '"' || ch === "'" || ch === '`' || ch === '.' || /^\p{ID_Continue}$/u.test(ch)) return { expression: false, ambiguity: null };
  // Anything else begins nothing in code (`#`, `@`, a control character): there is no grammar to ask, so this is a fallback.
  return { expression: false, ambiguity: 'fallback' };
}

function expressionPosition(src, i) {
  return readPosition(src, i).expression;
}

// True when the word that starts after index `s` is reached through `.` (or `?.`), not `...`.
function isPropertyName(src, s) {
  let p = s;
  while (p >= 0 && isTrivia(src[p])) p -= 1;
  return src[p] === '.' && !(src[p - 1] === '.' && src[p - 2] === '.');
}

// Heuristic for the ambiguous `>` token in dependency-free TSX scanning. The raw shapes this protects:
//   total as NonNullable< number > / count    `>` closes a cast type argument; `/` is division
//   export default () => <Icon />             `>` closes JSX; EOF is complete
//   export default () => count >              `>` is a relational operator; EOF is truncated
//   count<limit ? () => /re/ : () => /none/   the `>` in `=>` is not an angle close
//
// Dependency-free text cannot safely tell a generic instantiation or type-alias tail from a
// relational expression in all TSX contexts. So expression classification is intentionally narrow:
// `/` after `>` divides only when `>` closes a cast's type arguments (`as Foo<Bar>`, `satisfies
// Foo<Bar>`). EOF handling is even stricter below: a final `>` completes only
// when the lexer recorded it as a JSX tag close, and a final type-argument list needs `;`.
// The reading of the position after the `>` at `close`, where it is no `=>` (that is an arrow, after which an expression starts: CERTAIN): { expression, ambiguity }.
// A `>` that closes the type arguments of a cast's type ends an operand — a `/` after it divides, a `<` compares — and that is CERTAIN where the cast is: the `as` or `satisfies` is the keyword of an
// operand and a cast (castKeywordIsCertain), since after the keyword TypeScript parses a type, in which `Name<` is type arguments. Where it is not certain — the word may be a name, the operand before
// it is a guess, a line break may stand before it — the reading stands and is reported (`angle`), as is every other `>` that ends an operand by the reading of the heuristics (a JSX tag's).
function positionAfterGreaterThan(src, close, ends, depth) {
  if (src[close - 1] === '=') return { expression: true, ambiguity: null };
  // A `>` — or a run of them, `>>` and `>>>` — right after what the lexer knows ended an operand is an operator, never the end of type arguments: the closer of a cast, an element or a regex that was read
  // (castKeywordIsCertain, `ends`) leaves no `<` open, and an operand follows the operator: CERTAIN.
  //   x as A<B> > /re/.test(y)       a comparison, then a regex          <b/> >> 1           x as A<B> >>> /re/.test(y)
  let run = close;
  while (src[run - 1] === '>') run -= 1;
  const before = prevSignificant(src, run);
  if (before.ch !== '' && depth < CAST_CHAIN_LIMIT) {
    if (positionAfter(src, before, ends, depth + 1).ended) return OPERATOR_AFTER_OPERAND;
    // The type of a cast that ends right before the operator: `x as A<B>[] > y`, `x as A<B> | C > y`, `x as number > y`.
    const keyword = castKeywordBeforeType(src, -1, before.index);
    if (keyword !== -1 && castKeywordIsCertain(src, keyword, ends, depth)) return OPERATOR_AFTER_OPERAND;
  }
  const keyword = castKeywordBefore(src, close);
  if (keyword !== -1) return castKeywordIsCertain(src, keyword, ends, depth) ? OPERAND_ENDED : { expression: false, ambiguity: 'angle' };
  return { expression: !greaterThanClosesJsxTag(src, close), ambiguity: 'angle' };
}

// The index of the `as` or `satisfies` of the cast whose type holds the type arguments that the `>` at `close` closes (castKeywordBeforeType), or -1.
function castKeywordBefore(src, close) {
  const open = matchingTypeArgumentOpen(src, close);
  return open === -1 ? -1 : castKeywordBeforeType(src, open, -1);
}

// Casts that follow casts, `x as A<B> as C<D> as E<F> / 2`: each keyword asks the position of the operand before it, which is a cast's `>` where one stands, and so on back. Bounded, since each link
// reads up to LOOKAHEAD characters; a chain longer than this is not certain.
const CAST_CHAIN_LIMIT = 8;
// The reserved words that end an operand. Every other reserved word is a statement's or an operator's, after which `as` is a name (`break as`, `typeof as`, `return as`).
const OPERAND_WORDS = new Set(['this', 'null', 'true', 'false']);

// Whether the `as` or `satisfies` that starts at `keyword` is certainly the operator of a cast, which TypeScript reads after an operand on the same line (parser.ts, parseBinaryExpressionRest:
// `if (scanner.hasPrecedingLineBreak()) break;` before the keyword, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts) and which is a name anywhere else:
//   x as A<B> / 2                one cast, a division
//   x ⏎ as A<B> / 2             `as` starts a statement: a name, and `as A` is two names side by side
//   a.as ⏎ A<B> / 2            a property `as`, and `A<B>` begins a statement
//   y = as ⏎ A<B> / 2          a name after an operator
// The operand before it must end for certain (the position it is read at is no guess, and no line break stands before the keyword), the word is not a property, an escape or a letter beyond
// ASCII does not cut it, and what stands before it is no reserved word but `this`, `null`, `true` and `false` — `break as ⏎ A<B>` is a label, then a statement. Then the type that follows is a
// type to every parse of the page, and where its `>` stands a `/` divides and a `<` compares, whatever else is true of the page. A mapped type's `as` — `{ [K in keyof T as Foo<K>]: V }` — passes
// this too, and no `/` or `<` can follow it there (TS1005 and the rest of a type are no expression), so nothing is read from it.
function castKeywordIsCertain(src, keyword, ends, depth) {
  if (depth >= CAST_CHAIN_LIMIT || cutsWord(src, keyword - 1) || isPropertyName(src, keyword - 1)) return false;
  const before = prevSignificant(src, keyword);
  if (before.newline) return false;
  if (/[\w$]/.test(before.ch)) {
    const { word, start } = wordBefore(src, keyword);
    if (RESERVED_WORDS.has(word) && !OPERAND_WORDS.has(word) && !isPropertyName(src, start)) return false;
  }
  const position = positionAfter(src, before, ends, depth + 1);
  return !position.expression && position.ambiguity === null;
}

// The `<` that a type-argument `>` at `close` closes, by angle depth, or -1. Function types are valid inside type
// arguments (`ReturnType<() => number>`): the arrow's `>` is not an angle close. The span is not judged here. Only a
// cast gives type-argument context (castKeywordBeforeType), and after `as` or `satisfies`
// TypeScript parses a type, where `Name<` is always type arguments, so no valid code puts an expression there.
function matchingTypeArgumentOpen(src, close) {
  let depth = 1;
  for (let k = close - 1; k >= 0 && close - k <= LOOKAHEAD; k -= 1) {
    const c = src[k];
    if (c === '>' && src[k - 1] !== '=') depth += 1;
    else if (c === '<') {
      depth -= 1;
      if (depth === 0) return k;
    } else if (c === ';' && depth === 1) {
      return -1;
    }
  }
  return -1;
}

// Type names that take no type arguments: `as number <` can only be a comparison. `this`, `true` and `false` are
// types too, and take none either.
const PRIMITIVE_TYPES = new Set(['any', 'unknown', 'never', 'void', 'undefined', 'null', 'number', 'string',
  'boolean', 'bigint', 'symbol', 'object', 'this', 'true', 'false']);

// The `as` or `satisfies` of a cast whose type holds a `<` that opens type arguments (`open`), or whose type ends at `typeEnd` (`open` is -1 then), or -1. After `as` or `satisfies` TypeScript parses a type, so
// there `Name<` IS type arguments and a `/` after their `>` divides. The name may be one part of a larger type, so the
// walk back steps over the rest of it to reach the keyword:
//   total as number & Brand<"USD"> / count     a constituent of an intersection or union
//   value as A | B.C<D> / n                    a qualified name
//   total satisfies "n/a" | NonNullable<number> / count    a string-literal constituent
//   total as | -1 | Brand<"USD"> / count       a type that leads with its operator, and a signed literal
//   total as V extends U ? 0 : NonNullable<V> / count     the false branch of a conditional type
//   total as Array<A>[] | B > count            an array or an index after type arguments (typeEnd only: nothing follows a type that no `>` closes)
// Each constituent is a (qualified) name, with its own closed type arguments, indexes or array brackets (each stepped over whole,
// its brackets matched), a numeric literal with its sign, or a string literal (its quotes are kept when the lexer
// blanks it). Anything else ends the walk and the `<` is not taken for type arguments. The walk is bounded by
// distance, like the other scans here, not by a count of constituents.
function castKeywordBeforeType(src, open, typeEnd) {
  const reference = open === -1 ? typeEnd + 1 : open;
  const skipSpace = (i) => { while (i >= 0 && isTrivia(src[i])) i -= 1; return i; };
  const skipName = (i) => { while (i >= 0 && /[\w$.]/.test(src[i])) i -= 1; return i; };
  const wordEndingAt = (e) => { let s = e; while (s >= 0 && /[\w$]/.test(src[s])) s -= 1; let w = ''; for (let k = s + 1; k <= e; k += 1) w += src[k]; return { s, w }; };
  // Steps back over the indexes and array brackets that end at `r` (`[]`, `[Key]`, `["tax" | as][0]`). Each is matched
  // to its own `[`, so nothing inside one is read by the walk: an operator or a word there belongs to the index's type,
  // never to the cast's. Returns the index before the leftmost, or null where an index has no `[` within reach.
  const skipBrackets = (r) => {
    while (src[r] === ']') {
      let depth = 0;
      let k = r;
      while (k >= 0 && reference - k <= LOOKAHEAD && !(src[k] === '[' && depth === 1)) {
        if (src[k] === ']') depth += 1;
        else if (src[k] === '[') depth -= 1;
        k -= 1;
      }
      if (k < 0 || reference - k > LOOKAHEAD) return null;
      r = k - 1;
      while (r >= 0 && isSingleLineTrivia(src[r])) r -= 1;
    }
    return r;
  };
  // Steps back over a (qualified) name that ends at `r`, with any indexes after it (`Row[Key]`, `Row["tax" | as][0]`).
  // Returns the index before the name, or null when there is none (a tuple, `[A, B]`, is not walked) or an index has
  // no `[` within reach.
  const skipIndexedName = (r) => {
    const names = skipBrackets(r);
    if (names === null) return null;
    const s = skipName(names);
    return s === names ? null : s;
  };
  // Steps back over one constituent that ends at `r`: a name (qualified), a literal, with its own closed type arguments
  // and then its indexes or array brackets (`Array<A>[]`, `Row[Key]`), or a string literal. Returns the index before it, or null.
  const skipConstituent = (r) => {
    if (src[r] === '"' || src[r] === "'") {
      const quote = src[r];
      let k = r - 1;
      while (k >= 0 && !(src[k] === quote && src[k - 1] !== '\\')) k -= 1;
      return k < 0 ? null : k - 1;
    }
    r = skipBrackets(r);
    if (r === null) return null;
    if (src[r] === '>') {
      const o = matchingTypeArgumentOpen(src, r);
      if (o === -1) return null;
      r = skipSpace(o - 1);
    }
    const s = skipName(r);
    if (s === r) return null;
    // A negative numeric literal type keeps its sign: `-1 | 0`.
    const t = skipSpace(s);
    return src[t] === '-' && /\d/.test(src[s + 1]) ? t - 1 : s;
  };
  // Steps back from a union or intersection operator at `q` over the constituent before it. When the operator leads its
  // type there is none, and it returns the index before the operator. It leads after a non-name (`? | 0`, `: | A`), and
  // after a bare `as`, `satisfies` or `extends` (`as | A`, `extends | 0 | 1`): only there are those words keywords.
  // `as` and `satisfies` are contextual, so with type arguments of its own (`satisfies<T>`), within a longer name
  // (`E.as`), or before `?`, `:` or `extends`, the word names a type; and one inside an index (`Row["tax" | as]`) is
  // never reached, as the index is stepped over whole. The name is taken whole, as `skipConstituent` reads it, so only
  // a word standing alone is a keyword. A type or variable named `as` or `satisfies` with no type arguments, standing
  // alone right before `|` or `&`, is read as the keyword.
  const skipBeforeOperator = (q) => {
    const b = skipSpace(q - 1);
    const s = skipIndexedName(b);
    let word = '';
    if (s !== null) for (let k = s + 1; k <= b; k += 1) word += src[k];
    if (word === 'as' || word === 'satisfies' || word === 'extends') return q - 1;
    const t = skipConstituent(b);
    return t === null ? q - 1 : t;
  };
  // Steps back over a union or intersection of constituents that ends at `r` (`0 | 1`, `string | undefined`), for the
  // parts of a conditional type. A leading operator is part of it: `| 0 | 1`. Returns the index before it, or null.
  const skipCompound = (r) => {
    let s = skipConstituent(r);
    while (s !== null) {
      const q = skipSpace(s);
      if (!((src[q] === '&' || src[q] === '|') && src[q - 1] !== src[q])) return s;
      s = skipBeforeOperator(q);
    }
    return null;
  };
  // The head, the name the `<` belongs to. TypeScript attaches type arguments only to a plain (qualified) type name on
  // the same line as the `<`. An indexed type (`Row[Key] <`), a literal (`0 | 1 <`), a primitive or `this`, or a line
  // break before the `<` (`as Count` then `< high` on the next line) makes that `<` a comparison. Where the type is
  // asked for by its end, its last constituent is the head: any constituent, since no `<` is asked about.
  let p;
  if (open === -1) {
    p = skipConstituent(typeEnd);
    if (p === null) return -1;
  } else {
    let end = open - 1;
    while (end >= 0 && isSingleLineTrivia(src[end])) end -= 1;
    p = end;
    while (p >= 0 && /[\w$.]/.test(src[p])) p -= 1;
    // Char by char, not `slice`: `src` may be the lexer's partly blanked output ARRAY (see expressionPosition).
    let name = '';
    for (let k = p + 1; k <= end; k += 1) name += src[k];
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name) || PRIMITIVE_TYPES.has(name)) return -1;
  }
  while (reference - p <= LOOKAHEAD) {
    const q = skipSpace(p);
    const op = src[q];
    if ((op === '&' || op === '|') && src[q - 1] !== op) {
      // The constituent before the operator, or, when the operator leads its type (`as | A | B<C>`, a false branch
      // `: | A | B<C>`), nothing: what comes before it then decides, as it does for any other type.
      p = skipBeforeOperator(q);
      continue;
    }
    // A conditional type's false branch: `as V extends U ? 0 | 1 : NonNullable<V> / count`. Step back over the true
    // branch, its `?`, the extends type and `extends` itself, to the checked type. Each part may be a union or an
    // intersection. A conditional chained in a false branch is walked one link per turn of the loop. A ternary or an
    // object property has no `extends` before its `?`, so the walk refuses it here, and so it does a conditional nested
    // in a true branch or a parenthesized type in any part.
    if (op === ':' && src[q - 1] !== ':') {
      let r = skipCompound(skipSpace(q - 1));
      if (r === null) return -1;
      r = skipSpace(r);
      if (src[r] !== '?' || src[r - 1] === '?') return -1;
      r = skipCompound(skipSpace(r - 1));
      if (r === null) return -1;
      const { s, w } = wordEndingAt(skipSpace(r));
      if (w !== 'extends') return -1;
      r = skipCompound(skipSpace(s));
      if (r === null) return -1;
      p = r;
      continue;
    }
    break;
  }
  // Only a cast. A `:` looked like an annotation's, but no valid code puts a division directly after an annotation's
  // type (`const x: Foo<T> / 2` is no TypeScript), and every `:` it matched was an object property's, a ternary's or a
  // case clause's: `{ a: start < anchor + padding, b: end > /}/ }`, `[c ? t : start < Math.max(x, 0), end > /}/]`.
  // After `as` or `satisfies`, TypeScript itself parses a type, so `Name<` there IS type arguments.
  const before = prevWordOrPunct(src, p + 1);
  return before.word === 'as' || before.word === 'satisfies' ? before.start : -1;
}

// The word that ends before index `before` (white space skipped) and the index of its first character, or the `:` there, as the word ':'.
function prevWordOrPunct(src, before) {
  let p = before - 1;
  while (p >= 0 && isTrivia(src[p])) p -= 1;
  if (src[p] === ':') return { word: ':', start: p };
  let e = p;
  while (p >= 0 && /[\w$]/.test(src[p])) p -= 1;
  let word = '';
  for (let k = p + 1; k <= e; k += 1) word += src[k];
  return { word, start: p + 1 };
}

function greaterThanClosesJsxTag(src, close) {
  let depth = 0;
  for (let k = close; k >= 0 && close - k <= LOOKAHEAD; k -= 1) {
    if (src[k] === '>') depth += 1;
    else if (src[k] === '<') {
      depth -= 1;
      if (depth !== 0) continue;
      if (src[k + 1] === '/') return true;
      return /[A-Za-z_$/>]/.test(src[k + 1] || '') && expressionPosition(src, k);
    } else if (src[k] === ';') {
      return false;
    }
  }
  return false;
}

// Whether the `)` at `close` ends the head of an `if`, `for`, `while` or `with` statement, and whether that answer is certain:
// { head, ambiguity }. The matching `(` is found by counting back over `src` — the lexer's output, where brackets inside
// strings, comments and regexes are already blanked — and bounded, so a long expression costs at
// most LOOKAHEAD characters; past that, the `)` is taken to end an operand, which is a guess (`paren`), as is a head keyword that is
// not the keyword it spells (`identifier`). Once the `(` is found the answer is certain: the word before it is a head or it is not.
const STATEMENT_HEADS = new Set(['if', 'for', 'while', 'with']);
function statementHead(src, close) {
  let depth = 0;
  for (let j = close; j >= 0 && close - j <= LOOKAHEAD; j -= 1) {
    if (src[j] === ')') depth += 1;
    else if (src[j] === '(' && --depth === 0) {
      let { word, start } = wordBefore(src, j);
      // `for await (const x of xs)` — the head's keyword is the word before `await`.
      if (word === 'await') ({ word, start } = wordBefore(src, start + 1));
      const head = STATEMENT_HEADS.has(word) && !isPropertyName(src, start);
      // A `(` that follows no word — `f(a)(b)`, `x = (a)`, `a[0](b)` — is no head, for certain. One that follows a character beyond ASCII that is neither a letter nor white
      // space is a token this lexer does not know, so "no head" would rest on nothing: a guess (`identifier`, as for a keyword cut short by such a character).
      if (word === '' && unknownBeyondAscii(src[start])) return { head: false, ambiguity: 'identifier' };
      return { head, ambiguity: head && cutsWord(src, start) ? 'identifier' : null };
    }
  }
  return { head: false, ambiguity: 'paren' };
}

// A character beyond ASCII that begins nothing a lexer reading valid TypeScript expects in code: not white space (TypeScript's scanner skips it), and not a letter, a mark or a digit that
// belongs to a name. The lexer's output holds no other character there — a string, a comment and JSX text are blank — so one that is met is in a page TypeScript rejects.
function unknownBeyondAscii(ch) {
  return typeof ch === 'string' && ch !== '' && ch.charCodeAt(0) > 0x7f && !isTrivia(ch) && !/^\p{ID_Continue}$/u.test(ch);
}

function closesStatementHead(src, close) {
  return statementHead(src, close).head;
}

// The word that ends just before index `j` (whitespace skipped), and the index before its start.
function wordBefore(src, j) {
  let e = j - 1;
  while (e >= 0 && isTrivia(src[e])) e -= 1;
  let s = e;
  while (s >= 0 && /[\w$]/.test(src[s])) s -= 1;
  let word = '';
  for (let k = s + 1; k <= e; k += 1) word += src[k];
  return { word, start: s };
}

// The window for the scans that look back or ahead over a bounded stretch of source: the `(` of a statement head (statementHead), the `<` of
// a cast's type arguments (matchingTypeArgumentOpen) and the parameter list of a generic function type (genericFunctionTypeFollows). Past
// it the answer is a guess, and each says so (`paren`, `angle`, `generic`).
const LOOKAHEAD = 2000;   // generous: a signature with a large inline object type still fits

// If `j` is the start of a comment or a quoted/template string, return the index just past it;
// otherwise return `j` unchanged.
function skipTrivia(src, j) {
  const c = src[j];
  const n = src[j + 1];
  if (c === '/' && n === '/') {
    const end = lineTerminatorStart(src, j);
    return end === -1 ? src.length : end;
  }
  if (c === '/' && n === '*') {
    const end = src.indexOf('*/', j + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (c === '"' || c === "'" || c === '`') {
    for (let k = j + 1; k < src.length; k += 1) {
      if (src[k] === '\\') { k = escapeEnd(src, k) - 1; continue; }
      if (src[k] === c) return k + 1;
      if (isRawStringBreak(src[k]) && c !== '`') return j;   // not a string after all
    }
    return src.length;
  }
  return j;
}

// ─── What a `<` that starts an expression opens, in a .tsx file ────────────────────────────────────────────────
//
// A `<` where an expression may start is an element or a generic arrow's type parameters; both can follow an `=`, so position cannot tell them
// apart, and getting it wrong desynchronises the lexer for the rest of the page:
//   const updateField = <K extends keyof FormState>(key: K) => { … }     generic arrow
//   const el = <Section title="x">…</Section>;                           element
//
// TypeScript decides it by the next few tokens, and so does this: parser.ts (https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts),
// `isParenthesizedArrowFunctionExpressionWorker`, the
// `LanguageVariant.JSX` branch (TypeScript 5.8). At the start of an assignment expression a `<` is a generic arrow's type parameters ONLY when,
// after an optional `const`, the token after the first identifier is
//   `extends`, and the token after that is not `=`, `>` or `/`     <T extends X>(x: T) => x      (an element: <T extends>  <T extends/>  <T extends=…>)
//   `,` or `=`                                                      <T,>(x: T) => x      <T = string>(x: T) => x
// and otherwise it begins an element: `<T>` is JSX in TSX (a generic arrow with one unconstrained parameter needs the comma), and so is
// `<div data-active={e}>`. No window is involved. An earlier version looked for a parameter list and a later `=>`, which took JSX text for
// parameters — `isVisible(<div data-active={e}>(a): Title</div>) ? (() => /navigateTo(…)/.test(t)) : …` — and read the regex after the arrow
// as code. The identifier is read the way TypeScript's scanner reads one (Unicode escapes cooked, as TypeScript returns an identifier that
// spells a keyword as that keyword), and an escape is reported (`identifier`), since the decision then rests on a word written in disguise.
//
// What the rule does not say is what a TYPE does. A type position has no JSX, and TypeScript parses a type there: `const a: <T>(x: T) => T = f`,
// `onPick: <K>(key: K) => void`, `type H<A> = <T>(x: Array<T>) => A`. The rule calls `<T>` an element, but a `<Name>` followed by a parameter list and `=>`
// is an element only if the element reading of everything between the `>` of `<Name>` and the arrow can parse, and TypeScript rejects most of what a parameter
// list holds when it is read as the children of an element: a `>` (TS1382) — the arrow's own, a nested arrow's, the `>` that ends the tag of `Array<T>` — a `}`
// (TS1381), a container that starts with a name and a colon, as `{ label: T }` does (TS1005), a `<` and a character that cannot start a tag name, or a tag name
// and a token that is no attribute, as in `Array<{ a: T }>` and `Record<string, T>` (TS1003). Where the reading fails, no page that compiles has an element
// there, and the shape is a generic function type, for certain (genericFunctionTypeFollows, elementFailsAt, which says why for each case). Where it cannot be
// shown to fail — the arrow may be inside an attribute string, which has no escapes, or in a container this does not read —
//   const element = <Wrapper>(<Child x="\" y=") =>" />)</Wrapper>;        (TypeScript: one JsxElement, no diagnostics)
// it is a guess, `generic`, read as the type it almost always is: the page is complete to the structure gate, and nothing after the `<` is trusted. What else
// stays two-way is a `:` after the parameter list — a call signature `{ <T>(x: T): T }` and JSX text `<span>(required): Name</span>` both compile — and a
// parameter list too long to scan: the same guess, with the element read. And directly after the head of a type alias, `type Name =` at a statement start
// (afterTypeAliasHead), the `<` is a function type's whatever follows it, since nothing but a type can stand there.
//
// The first name after the `<` is asked about in the rule as `isIdentifier()`, which is context-sensitive: `await` is not an identifier in an async
// function (or at the top level of a module) and `yield` is not one in a generator, so there `<await extends X>text</await>` is an element where outside
// them it is a generic arrow. The lexer does not track those contexts, so a `<` followed by either word is a guess (`generic`), and the element is read.
// The token after `const` is read by TypeScript as the name with no such check, so `<const await extends X>` is decided by the rule.
//
// And the rule is asked only where an ASSIGNMENT expression starts. See ANGLE_AFTER, below: after a unary or binary operator the same words are an element.

// Reserved words are not identifiers to TypeScript, so a `<` followed by one is an element (`const` is read apart, as a modifier of a type
// parameter).
const RESERVED_WORDS = new Set(['break', 'case', 'catch', 'class', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var',
  'void', 'while', 'with']);

// The index of the next token at or after `j`: white space and comments, which TypeScript's scanner skips, are passed over (a line break is
// white space here; whether one is there matters to TypeScript for other rules, not for this one). The white space is TypeScript's (isTrivia), which has
// the characters `\s` lacks: with `\s`, `<T extends` and U+0085 and `>text</T>` would read as a constraint where TypeScript reads an element,
// and the regex after the element as code.
function skipSpaceAndComments(src, j) {
  for (;;) {
    while (j < src.length && isTrivia(src[j])) j += 1;
    if (src[j] === '/' && src[j + 1] === '/') {
      const end = lineTerminatorStart(src, j);
      if (end === -1) return src.length;
      j = end;
    } else if (src[j] === '/' && src[j + 1] === '*') {
      const end = src.indexOf('*/', j + 2);
      if (end === -1) return src.length;
      j = end + 2;
    } else {
      return j;
    }
  }
}

// A Unicode escape in an identifier, `\u0054` or `\u{54}`, at `j` (a backslash): its character and the index after it, or null.
function readIdentifierEscape(src, j) {
  if (src[j + 1] !== 'u') return null;
  if (src[j + 2] === '{') {
    const close = src.indexOf('}', j + 3);
    const hex = close === -1 ? '' : src.slice(j + 3, close);
    if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) return null;
    return { ch: String.fromCodePoint(Number.parseInt(hex, 16)), end: close + 1 };
  }
  const hex = src.slice(j + 2, j + 6);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? { ch: String.fromCharCode(Number.parseInt(hex, 16)), end: j + 6 } : null;
}

// The token that starts at `j`, for the few tokens the rule above looks at: a `word` (its text cooked, and whether an escape was in it), `,`,
// `>`, a bare `=` (not `==`, `===` or `=>`), a bare `/` (not `/=`), the end of the source, or any `other` character. TypeScript's scanner does
// not combine a `>` with what follows it until the parser asks, so a `>` is always one.
function readRuleToken(src, j) {
  if (j >= src.length) return { kind: 'eof', text: '', end: src.length, escaped: false };
  const c = src[j];
  const token = (kind, end) => ({ kind, text: src.slice(j, end), end, escaped: false });
  if (c === ',') return token('comma', j + 1);
  if (c === '>') return token('gt', j + 1);
  if (c === '=') return src[j + 1] === '>' ? token('other', j + 2) : src[j + 1] === '=' ? token('other', src[j + 2] === '=' ? j + 3 : j + 2) : token('equals', j + 1);
  if (c === '/') return src[j + 1] === '=' ? token('other', j + 2) : token('slash', j + 1);
  let k = j;
  let text = '';
  let escaped = false;
  while (k < src.length) {
    let ch;
    let next;
    if (src[k] === '\\') {
      const escape = readIdentifierEscape(src, k);
      escaped = true;
      if (!escape) break;
      ({ ch, end: next } = escape);
    } else {
      ch = String.fromCodePoint(src.codePointAt(k));
      next = k + ch.length;
    }
    const part = /^[A-Za-z0-9_$]$/.test(ch) || (ch.charCodeAt(0) > 0x7f && (/^\p{ID_Continue}$/u.test(ch) || ch === '\u200c' || ch === '\u200d'));
    const start = /^[A-Za-z_$]$/.test(ch) || (ch.charCodeAt(0) > 0x7f && /^\p{ID_Start}$/u.test(ch));
    if (!(k === j ? start : part)) break;
    text += ch;
    k = next;
  }
  return k > j ? { kind: 'word', text, end: k, escaped } : token('other', j + String.fromCodePoint(src.codePointAt(j)).length);
}

// Whether the `<` at `i`, where an assignment expression may start, opens a generic arrow's type parameters (`generic`) or an element, and the kind of
// guess the answer rests on, or null where the rule decides: { generic, ambiguity }. See above.
function opensTypeParameters(src, i, budget = null) {
  let escaped = false;
  const read = (j) => {
    const token = readRuleToken(src, skipSpaceAndComments(src, j));
    if (token.escaped) escaped = true;
    return token;
  };
  const verdict = (generic, ambiguity = null) => ({ generic, ambiguity: escaped ? 'identifier' : ambiguity });
  const first = read(i + 1);
  let identifier = first;
  if (first.kind === 'word' && first.text === 'const') {
    // TypeScript steps over `const` and then reads one more token, whatever it is, as the name.
    identifier = read(first.end);
  } else if (first.kind !== 'word' || RESERVED_WORDS.has(first.text)) {
    return verdict(false);               // `<>`, `<1`, `<this`: no identifier, so an element
  } else if (first.text === 'await' || first.text === 'yield') {
    // `isIdentifier()` is false for `await` inside an async function (or a module's top level) and for `yield` inside a generator, and the first name is the
    // one token the rule asks it of (the name after `const` is not): the same words are an element there and a generic arrow elsewhere, and which this is
    // takes the enclosing function, which is not tracked. `<await extends X>text</await>` is a JsxElement in an async function, an ArrowFunction in a plain one.
    return { generic: false, ambiguity: 'generic' };
  }
  const third = read(identifier.end);
  if (third.kind === 'word' && third.text === 'extends') {
    const fourth = read(third.end);
    // TypeScript's rule makes `<T extends` and a `=`, a `>` or a `/` an element where an expression starts. In a type a `=` or a `>` there is no constraint (TS1110), but a `/` starts one:
    // parseTypeParameter reads a constraint that starts no type as an expression, a regex, and only the checker objects (`let f: <T extends />;…/>(a: T) => T` is a FunctionType). The lexer
    // cannot tell a type from an expression there, so the `/` is the guess, with the element read.
    if (fourth.kind === 'slash') return verdict(false, 'generic');
    return verdict(!(fourth.kind === 'equals' || fourth.kind === 'gt'));
  }
  if (third.kind === 'comma' || third.kind === 'equals') return verdict(true);
  if (third.kind === 'gt' && identifier.kind === 'word') {
    const type = genericFunctionTypeFollows(src, third.end, i, budget);
    return verdict(type.generic, type.ambiguity);
  }
  return verdict(false);
}

// ─── The token before the `<` ─────────────────────────────────────────────────────────────────────────────────────
//
// TypeScript asks the question above only where an ASSIGNMENT expression starts. The operand of a unary or binary operator is a unary expression, where a `<`
// followed by a name is an element whatever follows the name (parser.ts, `parseUpdateExpression` parses a JSX element there with no arrow rule): `a === <T extends
// X>text</T>` is JSX, where `v = <T extends X>(x: T) => x` is a generic arrow. So what stands before the `<` decides whether the rule is asked at all, and a wrong
// answer reads an element's text as code — and the regex after it, whose token is then rewritten.
//
// For each token that can stand there, ANGLE_AFTER says which of three it is. The classes are TypeScript's own, checked against its parser for every punctuator
// and keyword it has (the oracle test in source-literals.test.js):
//   element   a unary or binary operator, or `typeof`, `delete`, `instanceof`, `void`, `await`: the operand is a unary expression, so an element, whatever
//             follows the name. CERTAIN. (`<<` only after a space or a line break; right before the `<` it is `<<<`, a shift or type arguments, which is reported. A `/` is
//             this operator only where the lexer read it as the division operator — a `/` that ends a regex ends an operand, and no `<` after it is an element.)
//   rule      an assignment expression starts, so the rule above decides: `=` and every compound assignment, `=>`, `,`, `;`, `:`, `?`, an opening bracket, the
//             `)` that ends a head and the `}` that ends a block, `return`, `throw`, `case`, `default`, `else`, `do`, `yield`, `of`, `new`, `extends`, and `break` and
//             `continue`, which end their statements at a line break. (The `>`, `>>` and `>>>` that may end type arguments or a tag are read, and reported,
//             before the table is asked: `angle`.)
//   guess     both readings compile, and no lexer without a parser can tell which program it is in:
//               `>=`     a comparison with an element, or the end of type arguments and an initialiser:  a >= <T extends X>(y: T): T</T>   let x: A<number>= <T extends X>(y: T): T => y
//               `>>=`    the same, where the first `>` ends the type arguments of a cast or a type and `>=` is a comparison — the lexer cannot tell that `>` from the first
//                        of a shift — or an assignment:                                                  x as A<B>>= <T extends X>(y: T): T</T>   a >>= <T extends X>(y: T): T => y
//               `>>>=`   the same, with two closers or a longer shift:                                    x as A<B<C>>>= <T extends X>(y: T): T</T>
//               `<`      a comparison with an element, or a function type for a type argument:           a < <T extends X>(y: T): T</T>    f< <T extends X>(y: T): T => y>()
//               `in`     a test of an element, or a for-in head:                                        "a" in <T extends X>(y: T): T</T>   for (k in <T extends X>(y: T): T => y)
//               `void`   before a line break only: the operator, or a type that the line break ended:   void LF <T extends X>(y: T): T</T>   let x: void LF <T extends X>(y: T): T => y
//             The element is read and the guess reported (`operator`; `newline` after `void`) — but only where the text after the `<` leaves both readings open. The rule reads a
//             generic for a head with a comma, a default or a constraint; a head that cannot be an element (`<T,>`, `<T = X>`, or a parameter list and an arrow whose element reading
//             fails) is type parameters whatever stands before it (elementReadingFails), and where the rule reads an element both readings agree. A head with a constraint and
//             no parameter list, `<T extends X>text</T>`, is an element in every program that parses — an arrow wants its parameters, so `const k = <T extends X>text</T>` is an
//             error — and is read as one with no guess (headWithoutParameterList), after every token here, the cut `>=`, `>>=` and `>>>=` included: there the first `>` ends
//             type arguments and `>=` compares (an element), or the run is one assignment and the arrow it then must be has no parameters (an error). What stays a guess is a
//             head with a constraint and a parameter list that a `:` follows: JSX text, or an arrow's return type.
// A token that is in none of them is a guess too, so a token nobody classified cannot be taken for one that is understood.
//
// The token is the LAST operator of the run of sign characters that ends at the `<`, cut as TypeScript's scanner cuts one: left to right, the longest operator
// first, and a `>` always on its own — the parser puts `>>`, `>=` and the rest together only where an operator is expected (`reScanGreaterToken`, in
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts). So `a!== <T…>` is `!==`, `x! = <T,>…` is a non-null assertion and then `=`, and a `>`
// that closes type arguments or a tag leaves the operator after it a token of its own (`x as A<B>== <T…>`). A run that ends in `=` after one or more `>` is the one cut
// this lexer cannot make: the parser puts those `>` together with the `=` where it expects an operator, and takes the first of them for the end of type arguments where it does not
// (`x as A<B>>= y` is `x as A<B>`, then `>=`), and a closer that is read with certainty — a cast's, an instantiation's — leaves no trace here. So every count of `>` before the
// `=` is a guess, whatever the operator would be if the first were not a closer: `>=` is a comparison (an element follows), `>>=` and `>>>=` are assignments (the rule decides).
const ANGLE_AFTER = Object.freeze({
  element: Object.freeze(['!', '~', '+', '-', '*', '**', '/', '%', '&', '&&', '|', '||', '^', '??', '==', '===', '!=', '!==', '<=', '<<', 'typeof', 'delete', 'instanceof', 'void', 'await']),
  guess: Object.freeze({ '>=': 'operator', '>>=': 'operator', '>>>=': 'operator', '<': 'operator', in: 'operator' }),
  rule: Object.freeze(['=', '+=', '-=', '*=', '**=', '/=', '%=', '<<=', '&=', '|=', '^=', '&&=', '||=', '??=', '=>', ',', ';', ':', '?', '(', ')', '[', '{', '}',
    'return', 'throw', 'case', 'default', 'else', 'do', 'yield', 'of', 'new', 'extends', 'break', 'continue']),
});
// The tokens whose class is another when a line break stands between them and the `<`.
const ANGLE_AFTER_LINE_BREAK = Object.freeze({ void: 'newline' });

const ANGLE_CLASS = new Map([
  ...ANGLE_AFTER.element.map((token) => [token, { read: 'element' }]),
  ...Object.entries(ANGLE_AFTER.guess).map(([token, kind]) => [token, { read: 'guess', kind }]),
  ...ANGLE_AFTER.rule.map((token) => [token, { read: 'rule' }]),
]);
const ANGLE_CLASS_AFTER_LINE_BREAK = new Map(Object.entries(ANGLE_AFTER_LINE_BREAK).map(([token, kind]) => [token, { read: 'guess', kind }]));

// The characters of an operator, and the operators a run of them is cut into — longest first; a `>` is read on its own. A run longer than RUN_LIMIT is read from its
// end: every operator is shorter than that, and a scan that went back over the whole of a long `=====…` — or of `<></>=<></>=…`, where every character is one of
// them — before each `<` would be quadratic.
const SIGN_CHARS = '=!<>+-*%&|^?~/';
const OPERATORS = ['<<=', '===', '!==', '**=', '&&=', '||=', '??=', '<<', '<=', '==', '=>', '!=', '**', '&&', '||', '??', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '=', '!', '+', '-', '*', '/', '%', '&', '|', '^', '~', '<', '?'];
const RUN_LIMIT = 12;

function lastOperator(run) {
  const tokens = [];
  for (let k = 0; k < run.length;) {
    // No operator in the list starts with a `>`, so a `>` is a token of its own.
    const operator = OPERATORS.find((candidate) => run.startsWith(candidate, k)) || run[k];
    tokens.push(operator);
    k += operator.length;
  }
  const last = tokens.length - 1;
  if (tokens[last] !== '=') return tokens[last];
  // A `=` after `>`s: `>=`, `>>=` and `>>>=`, and a count of `>` that is no operator's (`>>>>=`), a token the table does not know. All of them are guesses (see ANGLE_AFTER).
  let signs = 0;
  while (tokens[last - 1 - signs] === '>') signs += 1;
  return signs > 0 ? `${'>'.repeat(signs)}=` : '=';
}

// The token that ends right before the `<` at `i` — a word, the last operator of a run of sign characters, or any other character — and whether a line break
// stands between them, and `index`, where its last character is. `src` is the lexer's output (comments and strings are blank), and may be the array it is built in.
function tokenBeforeAngle(src, i) {
  const { ch, index, newline } = prevSignificant(src, i);
  if (ch === '') return { token: '', newline, index };
  if (/[\w$]/.test(ch)) return { token: wordBefore(src, i).word, newline, index };
  if (!SIGN_CHARS.includes(ch)) return { token: ch, newline, index };
  let start = index;
  while (start > 0 && index - start < RUN_LIMIT && SIGN_CHARS.includes(src[start - 1])) start -= 1;
  let run = '';
  for (let k = start; k <= index; k += 1) run += src[k];
  return { token: lastOperator(run), newline, index };
}

// What the `*` whose character is at `star` is, from the word before it: the generator mark of `function*` (`'function'`), the delegation of `yield*` (`'yield'`), a word cut
// short by an escape, `#` or a letter beyond ASCII, which is not the word it spells (`'cut'`), or a multiplication (`'multiply'`). A word reached through `.` or `?.` is a
// property, so `obj.function * <b>x</b>` multiplies. The two keywords are reserved, so no name is spelled so; `yield` is a keyword only in a generator, and which this is takes
// the enclosing function, which is not tracked.
function starAfter(src, star) {
  const before = prevSignificant(src, star);
  if (!/[\w$]/.test(before.ch)) return 'multiply';
  const { word, start } = wordBefore(src, star);
  if ((word !== 'function' && word !== 'yield') || isPropertyName(src, start)) return 'multiply';
  return cutsWord(src, start) ? 'cut' : word;
}

// How the token before the `<` at `i` reads it: { read: 'element' | 'rule' | 'typeParameters' | 'guess', kind } (see above).
function angleBefore(src, i) {
  // Another `<` right before it: TypeScript's scanner reads `<<` as one token, a shift, and the parser puts the two back where type arguments begin with a function
  // type (`ReturnType<<T = unknown>(x: T) => number>`). Either way no element is read there, so the rule decides — what it reads is what the type arguments are —
  // and the pair is reported, as the guess it is, at the `<` (`operator`, in lexInto).
  if (src[i - 1] === '<') return { read: 'rule' };
  const { token, newline, index } = tokenBeforeAngle(src, i);
  // The start of the source begins an expression: CERTAIN.
  if (token === '') return { read: 'rule' };
  // A `>` that is not the end of `=>` may end type arguments, a tag or a cast, or be a comparison, and a lexer with no types cannot tell which: a guess (`angle`). readPosition
  // reports it too, and is asked first, but it does not where an `=` stands before the `>` that the cut gave to another operator (`<=>`), and a claim that "it was reported
  // before" is the one that a producer of an unreported `>` breaks. So the token's own class reports it, wherever the `>` came from. The `<` is read as it always was, by the
  // rule: a `>` that is a comparison is followed by a unary operand, which is an element, and the rule may read that element as code — which is what the guess is for.
  if (token.endsWith('>') && token !== '=>') return { read: 'rule', report: 'angle' };
  // A `*` is a multiplication, whose operand is an element, except in two places where TypeScript reads something else after it (parser.ts,
  // https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts):
  //   function* <T>(x: T) {}   parseFunctionExpression and parseFunctionDeclaration read `function`, an optional `*`, an optional name, and then type parameters — so
  //                           the `<` opens them, whatever follows. CERTAIN. An element there was read as the tag it is not, and the closing tag the lexer then looked for was
  //                           found in a string or a comment that came after, where `'</T>…'` ended an element that was never there.
  //   yield* <T,>(x: T) => x  in a generator, parseYieldExpression parses an assignment expression after the `*`, where the rule applies; outside one `yield` is a name and
  //                           the `*` multiplies, so `yield * <T extends X>text</T>` is an element. Which this is takes the enclosing function: a guess (`operator`) where the text
  //                           after the `<` leaves both readings open. `<T,>(x: T) => x` cannot be an element, so it is type parameters in either (elementReadingFails), and
  //                           `<T extends X>text</T>`, with no parameter list for an arrow to take, is an element in either (headWithoutParameterList).
  if (token === '*') {
    const star = starAfter(src, index);
    if (star === 'function') return { read: 'typeParameters' };
    if (star === 'yield') return { read: 'guess', kind: 'operator' };
    if (star === 'cut') return { read: 'guess', kind: 'identifier' };
  }
  const cls = (newline && ANGLE_CLASS_AFTER_LINE_BREAK.get(token)) || ANGLE_CLASS.get(token) || { read: 'guess', kind: 'operator' };
  return cls.read === 'guess' ? { ...cls, token } : cls;
}

// Whether the head of the `<` at `i`, read as a tag to its `>`, is followed by no parameter list and arrow that type parameters could take: `<T extends X>text</T>`, `<T extends X>(text)`.
// With nothing to take, no arrow and no function type can start there, so the only reading that parses is an element: `a < <T extends X>text</T>` compares, where
// `const k = <T extends X>text</T>` is an error (an arrow is attempted, and wants its parameters). A guess about what the token before the `<` leaves open is moot.
//
// All of that rests on one claim: the tag reading and the type-parameter reading of the head END AT THE SAME `>`, so that what follows it is the same text in both. readTag reads the
// head as JSX does, and TypeScript reads the same characters as type parameters (parser.ts, parseTypeParameters, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts:
// `<`, then names, `extends` types and `=` defaults, then `>`). What readTag accepts is only
//   `<` Name (`.` Name)* [`<` names, dots, commas and nested lists `>`] ( white space, then a name with `-` in it, then optionally white space, `=` and a quoted string right after it )* white space ( `>` | `/` trivia `>` )
// with ASCII white space between its tokens, and the two readings of such a head differ in one place only; every other way they could end apart either cannot occur in it or is no
// reading of a type parameter list:
//   - a STRING. An attribute's value is a JSX string, which has no escapes and ends at the next quote; the same text in a type is a JavaScript string, in which a backslash escapes the
//     character after it (scanner.ts, scanString, and scanJsxAttributeValue for the one that has none). In `<T extends X="\">">(x) => x` the JSX string is `"\"` and the head ends at the
//     `>` after it, so no parameter list follows and this would say "element"; TypeScript's type parameter has the default `"\">"`, ends at the last `>`, and an arrow with a parameter list follows.
//     So a head that holds a backslash is not decided here. Without one both readings end the string at the same quote, whatever it holds (`">"`, `"=>"`, `"//"`, `"é"`); a raw line
//     break in it is an unterminated string in a type, so only the element parses, which is what this says.
//   - a COMMENT. readTag stops at a `/` that begins a comment and answers null, so no comment stands in an accepted head but after the `/` of a self-closing one — `<T extends X / /* c */ >` — which is no type
//     parameter list in any reading (a `/` is no token of one), so only the element parses; and the text of a string is no comment in either reading.
//   - a nested `<`. After an attribute a `<` is TS1003 in a tag (so no head with one is accepted), and the type arguments right after the name are names, dots and commas, where no type
//     parameter has them (a name is followed by `extends`, `=`, `,` or `>`): the type-parameter reading fails there, so again only the element parses.
//   - `=>`, `=` and `>` outside a string. A `=` before a `>` or another `=` is a `fails` of readTag, an attribute's `=` takes a quote that follows it at once (any other value is `fails` or
//     null), and the first `>` that no list of tag type arguments holds ends the head for both readings.
//   - a character beyond ASCII or a line terminator outside a string: readTag reads ASCII white space and names only, and answers null for the rest — but after the `/` of a self-closing head, where
//     trivia of every kind stands before the `>`, and which no type parameter list has.
function headWithoutParameterList(src, i, budget = null) {
  if (!isTagNameStart(src[i + 1])) return false;
  const tag = readTag(src, i + 1, Math.min(src.length, i + LOOKAHEAD));
  if (tag === null || tag.fails !== undefined) return false;
  // Bounded by the head, which readTag read within LOOKAHEAD: a search of the whole source for each `<` would be quadratic.
  for (let k = i; k < tag.resume; k += 1) if (src[k] === '\\') return false;
  const type = genericFunctionTypeFollows(src, tag.resume, i, budget);
  return !type.generic && type.ambiguity === null;
}

// Whether the `<` at `i` follows `async` on the same line: `const f = async <T,>(x: T) => x`, `const o = { async<T>(x: T) { return x; } }`. A word that is a keyword in some places
// and a name in others is a guess before a `/` (`keyword`), but never before a `<` on its line, because TypeScript never reads an element there. After `async` and a `<` with no line break
// between them, isParenthesizedArrowFunctionExpressionWorker (parser.ts, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts) answers True for the shapes of the TSX
// rule that are generic — an async arrow with type parameters — and False for every other, and then `async` is an ordinary token: a method named `async` that has type parameters (in an
// object literal or a class: `async<T>(x: T) {}`), or the identifier `async`, after which a `<` is a comparison or the type arguments of a call (`async<T>(x)`). An element starts only
// where an expression does, and nothing starts one after `async`: so the text after the `<` is code in every reading that parses, whatever the rule says of its head (`async <T>text</T>` and
// `async <div>x</div>` parse in no reading as an element), and the lexer, which reads it as code, reads it right. After a line break `async` is a name that ends its statement, and the
// `<` is decided by what stands after it as for any name: the guess stays (`keyword`). This is asked only where the position after the word is the `keyword` guess
// (positionAfter), which a property named `async` (`x.async <T,>`, no keyword at all) and a name cut short by an escape, `#` or a letter beyond ASCII (an `identifier` guess) never are, so
// neither is checked here.
function asyncBeforeAngle(out, i) {
  return !prevSignificant(out, i).newline && wordBefore(out, i).word === 'async';
}

// What a `<` at `i`, where an expression may start, opens: { generic, ambiguity }. `src` is the source and `out` the lexer's output.
function angleOpens(src, out, i, budget = null, certainOperator = false) {
  let before = angleBefore(out, i);
  // A `>` that is an operator for certain — it follows a cast's closer, an element or a regex the lexer read (OPERATOR_AFTER_OPERAND) — is a comparison or a shift, and the operand
  // after a binary operator is a unary expression, where a `<` opens an element and nothing else (parser.ts, parseBinaryExpressionRest and parseUnaryExpressionOrHigher,
  // https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts): CERTAIN, and read as one. Keeping the rule here and only dropping the report would read
  // `<T extends X>text</T>` as type parameters — `x as A<B> > <T extends X>text</T>; const r = /…/;` then hid the regex's token in code.
  if (certainOperator && before.report === 'angle') before = { read: 'element' };
  if (before.read === 'element') return { generic: false, ambiguity: null };
  if (before.read === 'typeParameters') return { generic: true, ambiguity: null };
  // Directly after the head of a type alias a `<` is a function type's whatever follows it (afterTypeAliasHead). The head ends in a lone `=`, so no token of
  // another class can precede it.
  if (afterTypeAliasHead(out, i)) return { generic: true, ambiguity: null };
  const rule = opensTypeParameters(src, i, budget);
  // After a guess token, a head with a constraint and no parameter list is an element in every program that parses (headWithoutParameterList). That holds after the cut `>=`, `>>=`
  // and `>>>=` too: where the first `>` ends type arguments, `>=` compares and the head is an element; where the run is one operator, an assignment, the rule reads the head as
  // type parameters, TypeScript attempts the arrow it then must be, and with no parameter list that is an error (`v >>= <T extends X>text</T>`).
  if (before.read === 'guess' && rule.generic && rule.ambiguity === null && headWithoutParameterList(src, i, budget)) return { generic: false, ambiguity: null };
  const verdict = before.read === 'guess' && rule.generic ? { generic: false, ambiguity: before.kind } : rule;
  return before.report && verdict.ambiguity === null ? { ...verdict, ambiguity: before.report } : verdict;
}

// Whether the `<` at `i` comes directly after the head of a type alias, `type Name =`, that starts a statement: a place where a `<` is a type's and
// nothing else. A type has no JSX, and `type Name` — two names side by side — cannot be an expression, so the line is a declaration and no other
// reading remains (TypeScript: parseTypeAliasDeclaration; `type` begins a declaration only when a name follows it on the same line, which is
// `nextTokenIsIdentifierOnSameLine`). That settles what the shape in genericFunctionTypeFollows leaves open: a `:` after the parameter list, a list too long to
// scan, and an arrow that the element reading may hold. `export` and `declare` may stand before `type`. A head with type parameters, `type Fn<A> =`, ends in a `>`, which is the
// question this answers for a `<`, so it is not read (what follows its `=` is then decided by the shape alone). `src` is the lexer's output, where
// comments and strings are blank.
//   type Fn = <T>(x: T): T;        export type Fn = <T>(x: T): T;        const a: <T>(x: T): T = f;   (not a head: a guess)
// Nothing here asks whether a word is cut short (an escape, `#`, a letter beyond ASCII): the name is the word before a lone `=` — an operator that
// ends in `=` leaves no name before it — and `type` is the word before the name with white space between them, and follows a `;`, a brace, a line
// break or a modifier, so a cut character glued to either leaves no word to match.
function afterTypeAliasHead(src, i) {
  const equals = prevSignificant(src, i);
  if (equals.ch !== '=') return false;
  const name = wordBefore(src, equals.index);
  if (!/^[A-Za-z_$][\w$]*$/.test(name.word)) return false;
  // A property is not the keyword: `a.` LF `type Name = …` is a member and a name, which a line break would otherwise make a statement start.
  const keyword = wordBefore(src, name.start + 1);
  if (keyword.word !== 'type' || isPropertyName(src, keyword.start)) return false;
  // `type` LF `Name = …` is two statements, `type;` and an assignment.
  for (let k = keyword.start + 1 + keyword.word.length; k <= name.start; k += 1) if (isLineTerminator(src[k])) return false;
  // `type` starts a statement: it begins the file, or follows a `;`, a block's `{` or `}`, or a line break, where ASI ended the statement before it
  // (ECMA-262 §12.10) — after any `export` and `declare`, which belong to the declaration.
  let at = keyword.start + 1;
  for (;;) {
    const before = prevSignificant(src, at);
    if (before.ch === '' || before.newline || before.ch === ';' || before.ch === '{' || before.ch === '}') return true;
    const modifier = wordBefore(src, at);
    if ((modifier.word !== 'export' && modifier.word !== 'declare') || isPropertyName(src, modifier.start)) return false;
    at = modifier.start + 1;
  }
}

// ─── Whether the element reading of `<Name>(…) =>` can parse ───────────────────────────────────────────────────────────────────────────────
//
// A `<Name>` followed by a parameter list and `=>` is a generic function type — `const a: <T>(x: Array<T>) => T = f` — or, in an expression, an element whose text
// holds a `=>`. In a .tsx file there is no other reading of a `<` in an expression (a generic arrow needs the comma or the constraint the rule asks for), and in a type there
// is no JSX. So it is a type, for certain, wherever the element reading does not parse: a page that compiles has no element there. Whether it parses is read off the text, from
// the `>` of `<Name>` to the `=>`, the way TypeScript's parser reads the children of an element, token by token (parser.ts,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts: parseJsxChild, parseJsxExpression, parseJsxOpeningOrSelfClosingElementOrOpeningFragment,
// parseJsxElementName, parseJsxAttributes, parseJsxAttribute, parseJsxAttributeValue; scanner.ts: scanJsxToken, scanJsxAttributeValue), and it stops at the first thing
// TypeScript rejects. These are TypeScript 5.8's diagnostics, and the test of this reading checks each against its parser:
//   TS1382  "Unexpected token. Did you mean `{'>'}` or `&gt;`?" — a `>` in the text of an element's children, at ANY depth: the `=>`'s own, a nested arrow's, and the `>` that
//           ends a nested tag such as `<T>` in `Array<T>`. Quotes, parentheses and `=>` are plain text there, and there are no comments in JSX text
//   TS1381  the same for a `}`
//   TS1005  "'}' expected" — an expression container that starts with a name, a number or a quoted name and a `:`, as `{ label: T }` does: TypeScript reads the name as an expression and
//           wants the `}`. No expression is a name followed by a colon; a `?` makes it a conditional, so `{ a ? b : c }` is one, which is why the colon must follow the name directly.
//           Two names side by side, a bracket and a colon, and a call and a colon are the same error (see containerFailsAt); so is a `{` in a tag where an attribute may start that is
//           no spread (`<T extends { a: string }>`)
//   TS1109  "Expression expected" — one that starts with a name, a `?` and a `:`, as `{ a?: T }` does. (`?.` and `??` are not this)
//   TS1003  "Identifier expected" — a `<` followed by a character that cannot start a tag name (`Array<{ a: T }>`, `Array<(y: T) => void>`), or a tag name followed by a token
//           that is no attribute (`Record<string, T>` has a `,`, `Array<T[]>` a `[`, `Array<T | U>` a `|`), or an attribute where a tag may continue (a `<` after an attribute,
//           as in `<T extends A<B>>`)
//   TS1145  "'{' or JSX element expected" — an attribute value that is not a string, a container or an element
// What this cannot parse it does not claim: a closing tag, a fragment, a comment, a spread, a name with a `-` or a `:`, an attribute string that does not follow its `=` at once (see
// readTag), an expression container that holds a brace, a quote, a back-tick, a `/`, a backslash or a `<` and none of the shapes above, type arguments on a tag that are more than names, dots
// and commas, and a character beyond ASCII where a token could start or end: TypeScript's scanner skips trivia there (white space of every kind, not only ASCII's), so it may hide a name,
// a value or a colon (see isTagSpace). Each leaves the element reading possible, and the reading says -1. So does an arrow that lies inside a tag or an attribute string, since the `>` is
// not text there — the case that matters:
//   const element = <Wrapper>(<Child x="\" y=") =>" />)</Wrapper>;      (TypeScript: one JsxElement, no diagnostics)
// A JSX attribute string has no escapes, so the second attribute is `") =>"`, and the `)` and the `=>` that the parameter-list scan found are inside it.
//
// The same reading, taken to the closing tag of the element and not to an arrow, settles a parameter list that neither `=>` nor `:` follows (callSignatureOrElement; readChildren with a `closing` name).
// The nested elements are followed, each closed by its own closing tag; a `}` or `>` in the text, a closing tag that is not the open element's, and a `<` right before a `/*` (`</*`, which is TS1003 to
// an element and the start of the next signature's type parameters to a type) fail it. It also skips what an arrow reading leaves unread, because a closing tag has to be found past it: an expression
// container that holds strings and balanced braces, and the containers and spreads among a nested tag's attributes. The verdicts of the arrow reading are not changed by any of it.

// The ASCII characters that cannot begin a tag name, nor an attribute, nor continue a tag after a name: TypeScript's scanner returns each as a token that is not an identifier,
// a keyword, `{`, `>` or `/`, and the parser reports TS1003 at it. `-`, `.`, `:`, `<`, `>`, `/`, a digit, `#`, `@`, a backslash and every character beyond ASCII are not here: they
// continue a name or begin a construct this reading does not follow (`#name` is a private name, which TypeScript accepts as a tag name).
const NOT_IN_A_TAG = new Set([...'()[]{},|&;?!*+%^~="\'`']);

const isTagNameStart = (c) => typeof c === 'string' && /^[A-Za-z_$]$/.test(c);
const isTagNamePart = (c) => typeof c === 'string' && /^[A-Za-z0-9_$]$/.test(c);
// The white space this reading skips between the tokens of a tag; TypeScript's scanner skips more (non-breaking spaces and the like), which is left undecided.
const isTagSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';

// The words that can start an expression and be followed by a second word, which no other first word can: `typeof a`, `void a`, `delete a`, `await a`, `yield a`, `new A`,
// `async a => a` and `async function f() {}`, `function f() {}` and `class A {}` (parser.ts, parseSimpleUnaryExpression, parseUnaryExpressionOrHigher and parsePrimaryExpression,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts; parseAssignmentExpressionOrHigher for `yield` and the arrow). `import` is on the list although
// no `import a` is an expression: it is the one word that starts one in a way this does not follow (`import(…)`, `import.meta`), and where in doubt the container is not called an error.
const EXPRESSION_PREFIX_WORDS = new Set(['typeof', 'void', 'delete', 'await', 'yield', 'new', 'async', 'function', 'class', 'import']);
// The words that continue an expression after a name: `a instanceof B`, `a in b`, `a as T`, `a satisfies T`. Every other word after a name ends it.
const EXPRESSION_INFIX_WORDS = new Set(['instanceof', 'in', 'as', 'satisfies']);
// The words before a `(` that make it something other than a call's: `async (x: T) => x` and `yield (x: T) => x` are arrows, `function (x: T) {}` a function. Every other word before
// a `(` is called — `typeof (x: T)`, `new (x: T)` and `await (x: T)` take a unary operand, which no arrow is — and a `:` in its first argument is an error.
const NOT_CALLED_WORDS = new Set(['async', 'function', 'yield']);

// The index of the first token at or after `from` that a container (containerFailsAt) can read: the white space this reading knows (isTagSpace) and comments are passed over, as TypeScript's scanner
// passes over them between any two tokens, so `{ /* c */ readonly a: T }` is read as `{ readonly a: T }` is. A comment whose end is not within `last` has no known end, and nothing after it is
// known: src.length, where no token stands, is returned, so that every reading that asks what the token is says nothing.
function skipTagTrivia(src, from, last) {
  let j = from;
  while (j <= last) {
    if (isTagSpace(src[j])) {
      j += 1;
    } else if (src[j] === '/' && src[j + 1] === '/') {
      j += 2;
      while (j <= last && !isLineTerminator(src[j])) j += 1;
      if (j > last) return src.length;
    } else if (src[j] === '/' && src[j + 1] === '*') {
      j += 2;
      while (j <= last && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      if (j > last) return src.length;
      j += 2;
    } else {
      return j;
    }
  }
  return j;
}

// The end of the run of characters at `from` that a container may hold and be skipped: names and numbers, `.` and `,` (which hold the member chains, comma expressions and spreads
// of `{ a }`, `{ a, b }`, `{ a.b }` and `{ ...a }`), and the white space and comments this reading knows (skipTagTrivia). Nothing here can open a construct that holds a `}` — a string, a template,
// a regex, an object, an element, a function; a comment is passed over whole, so a `}` in it is no end — so a `}` that ends the run is the container's own.
function skippableEnd(src, from, last) {
  let j = from;
  while (j <= last) {
    if (isTagNamePart(src[j]) || src[j] === '.' || src[j] === ',') j += 1;
    else if (isTagSpace(src[j]) || (src[j] === '/' && (src[j + 1] === '/' || src[j + 1] === '*'))) j = skipTagTrivia(src, j, last);
    else break;
  }
  return j;
}

// The end of the run of characters at `from` that can open no nested construct holding a `}` (see containerFailsAt): everything but `{`, `}`, a quote, a back-tick, a `/` that is no comment, a backslash and `<`. A comment
// is passed over whole (skipTagTrivia), so a `}` in it is no end. A run that reaches `last` first has no end to read.
function plainContainerEnd(src, from, last) {
  let j = from;
  while (j <= last) {
    if (src[j] === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) j = skipTagTrivia(src, j, last);
    else if (PLAIN_CONTAINER_STOPS.has(src[j])) return j;
    else j += 1;
  }
  return j;
}
const PLAIN_CONTAINER_STOPS = new Set([...'{}"\'`/\\<']);

// The index just past the `}` that ends the container whose content starts at `from`, where the content holds nothing but plain text (plainContainerEnd), JavaScript strings and balanced braces, or -1. A string
// in an expression container is read as the scanner reads one (stringEnd): with its escapes, ending at its own quote, and holding no raw line break, so a `}` inside it is no end of the container and
// the first `}` after it that no string covers and no brace of its own opened is. What stops the run is anything else that can hide a `}`: a template, a comment, a regex, an escape, a `<`. A brace
// that is not in a string opens an object, a block or a type, which a `}` closes (`depth`), so `{{ a: 1 }}` and `{() => { return "}"; }}` are skipped, with the strings in them.
//   { t("label") }          { "a}" }          { a ? 'x' : 'y' }          { "it's" }          {{ color: "red" }}          { a ? { b: "}" } : c }
function containerEndWithStrings(src, from, last) {
  let depth = 0;
  for (let j = from; j <= last; j += 1) {
    const c = src[j];
    if (!PLAIN_CONTAINER_STOPS.has(c)) continue;
    if (c === '}' && depth === 0) return j + 1;
    if (c === '{' || c === '}') {
      depth += c === '{' ? 1 : -1;
      continue;
    }
    if (c !== '"' && c !== "'") return -1;
    const end = stringEnd(src, j, last);
    if (end === -1) return -1;
    j = end - 1;
  }
  return -1;
}

// The end of the JavaScript string that starts at `open` — a quote in an expression container is an ordinary string, with escapes, which ends at its quote and cannot hold a raw line
// break (scanner.ts, scanString): the index just past its closing quote, -1 where a raw line break or the end of the source comes first (it is no string), or -2 where `last` does (it may be one).
function stringScan(src, open, last) {
  const quote = src[open];
  for (let k = open + 1; k <= last; k += 1) {
    if (src[k] === '\\') { k = escapeEnd(src, k) - 1; continue; }
    if (src[k] === quote) return k + 1;
    if (isRawStringBreak(src[k])) return -1;
  }
  return last + 1 >= src.length ? -1 : -2;
}

// The index just past the string, or -1 where it is none or is not closed before `last`.
function stringEnd(src, open, last) {
  return Math.max(stringScan(src, open, last), -1);
}

// The index just past the template literal that starts at the back-tick `open`, with its escapes (`\``) and no `${`, which opens code that is not read here; -1 where it holds one or is not closed
// before `last`.
function templateEnd(src, open, last) {
  for (let k = open + 1; k <= last; k += 1) {
    if (src[k] === '\\') { k += 1; continue; }
    if (src[k] === '`') return k + 1;
    if (src[k] === '$' && src[k + 1] === '{') return -1;
  }
  return -1;
}

// The index just past the comment that starts at the `/` at `open` — at the line terminator that ends a `//` comment, after the `*/` of a `/* */` one — or `last + 1` where it is not ended within `last`
// (its end is not known, and it covers what follows), or -1 where no comment starts there.
function commentEnd(src, open, last) {
  if (src[open + 1] === '/') {
    let k = open + 2;
    while (k <= last && !isLineTerminator(src[k])) k += 1;
    return k;
  }
  if (src[open + 1] !== '*') return -1;
  for (let k = open + 2; k < last; k += 1) if (src[k] === '*' && src[k + 1] === '/') return k + 2;
  return last + 1;
}

// Whether the `/` at `at` follows a word or a number that is no keyword before an expression (EXPR_START_WORDS): the `/` divides there, and in a type, which has no division, it is an error — in no
// reading that parses does a regex start after it. After anything else — a bracket, an operator, a quote, a tag, a keyword — one may. `implements` is such a keyword too, though the lexer's table
// leaves it out (it is a contextual word there, a guess): its heritage clause takes an expression, as `extends` does, so in a computed name a type may hold `[class C implements /re/ {}]`, and the
// closing tag in that regex (parseHeritageClause, parseExpressionWithTypeArguments, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts).
//   and/or      1/2      a / b          (not: `(a) /x/`, `= /x/`, `return /x/`, `implements /x/`, `</b> /x/`)
function slashFollowsAnOperand(src, at) {
  const before = prevSignificant(src, at);
  if (!/[\w$]/.test(before.ch)) return false;
  let start = before.index;
  while (start > 0 && /[\w$]/.test(src[start - 1])) start -= 1;
  const word = src.slice(start, before.index + 1);
  return !EXPR_START_WORDS.has(word) && word !== 'implements';
}

// The words that can stand before a member's name in a type, so that a name after one is no second name: every reserved word, every contextual one, and the modifiers TypeScript takes.
const MEMBER_MODIFIERS = new Set(['public', 'private', 'protected', 'const', 'interface', 'package']);

// Whether the text from `from` to `to` cannot be the members of a type. It is what follows the `)` of a call or construct signature, up to the first place that could hide the closing tag the text reaches
// (a string, a template, a comment, a regex): where no type can be valid up to there, no program has one that holds the closing tag in anything, and nothing after it hides it. A member is a name, and what follows
// a name on its line is `:`, `?`, `(`, `<`, a separator or the end of the line (parseTypeMemberSemicolon, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts); a second name or a string
// there is TS1005, and a `/` has no place after a name in a type (it divides in an expression, where a name may stand but a member does not). A template or a regex that opens at `to` is no member's
// start either (TS1131, "Property or signature expected"; parseTypeMember): with only names and separators before it, it stands where a member begins or right after a name. (After a `:` a template is
// a type, `m: \`a${string}\``, and the reading stops at the colon, undecided.) Only plain prose is read — names, numbers, `,` and `;` — and a word that may be a modifier, or any other character, leaves it
// undecided (false):
//   (a), see https://x.y           `see` and `https`, two names on a line
//   (a); and/or more               a name and a `/`
//   (a), see 'x                    a name and the string that opens at `to`
//   (a); `x ${y}                   a template where a member begins
function typeMembersFail(src, from, to, opener) {
  let named = false;                           // a member's name was read on this line
  let k = from;
  while (k < to) {
    const c = src[k];
    if (isTrivia(c)) {
      if (isLineTerminator(c)) named = false;
      k += 1;
    } else if (/[\w$]/.test(c)) {
      let end = k;
      while (end < to && /[\w$]/.test(src[end])) end += 1;
      if (named) return true;
      const word = src.slice(k, end);
      if (RESERVED_WORDS.has(word) || CONTEXTUAL_WORDS.has(word) || MEMBER_MODIFIERS.has(word)) return false;
      named = true;
      k = end;
    } else if (c === ',' || c === ';') {
      named = false;
      k += 1;
    } else {
      return c === '/' && named && src[k + 1] !== '/' && src[k + 1] !== '*';
    }
  }
  // Only an opener after the parameter list stands where a member does: one inside it (a default value's template, `(a = \`x</p>\`)`) is the type's too.
  if (from <= to && (opener === '`' || (opener === '/' && src[to + 1] !== '/' && src[to + 1] !== '*'))) return true;
  return named && (opener === '"' || opener === "'");
}

// Whether the quote at `at` comes right after a word that is no keyword: an apostrophe in prose (`it's`) or an inch mark (`5" wide`). A type has no string right after a name or a number — what follows
// one with no white space between is a keyword's operand (`readonly'a': T`, `keyof'a'`, `[K in'a']`) or a member's quoted name after its modifier (`public'a': T`), and a keyword is a reserved word, a
// contextual one or a modifier — so a quote like this opens no string that could hold a closing tag. The modifiers are the words typeMembersFail reads (MEMBER_MODIFIERS): `public`, `private` and
// `protected` are in neither of the other sets, and TypeScript's parser takes them before any member of a type, leaving the misplaced modifier to the checker (TS1070), so
// `interface I { <T>(); public'</T>…' }` parses with the closing tag in a string. (A character beyond ASCII before the quote is not a word here, and the quote is read as one that may open a string.)
function quoteEndsAWord(src, at) {
  let start = at;
  while (isTagNamePart(src[start - 1])) start -= 1;
  if (start === at) return false;
  const word = src.slice(start, at);
  return !RESERVED_WORDS.has(word) && !CONTEXTUAL_WORDS.has(word) && !MEMBER_MODIFIERS.has(word);
}

// A `{` in the text of an element, at `open`, which is an expression container — `{ label: T }`, `{ [k: string]: T }` — read for the one thing this reading knows about it:
// { fails } is the offset of a token TypeScript's parser rejects, at or before which it reports an error, { resume } is the index just past the container's `}` where its content
// is skipped and the text goes on, and null is where nothing can be said. The container holds an expression (parseJsxExpression, parseExpression, then `parseExpected(}`), and a
// `:` that has no `?` before it in the expression, and is not an object member's, a parameter's type or a label — nothing that is read here is any of those — is an error, so
// every shape below ends in one, where the colon is the first token TypeScript cannot take. Each is checked against its parser (the fuzz in tests/jsx-element-reading.test.js):
//   { name :                  TS1005 at the colon    { label: T }          { 'a': T }  { "a" : T }  { 1: T }  { 1.5?: T }
//   { name ? :                TS1109 at the second   { a?: T }             { 'a'?: T }
//   { name name               TS1005 at the second   { readonly a: T }     { a b }      no expression is two names side by side …
//   { [ name :                TS1005 at the colon    { [k: string]: T }    { readonly [k: string]: T }
//   { [ … ] :                 TS1005 at the colon    { [K in keyof T]: T } { [a]: b }   … but `typeof a`, `a in b`, `a as T`, `async a => a` are (the exception lists above)
//   { name ( name :           TS1005 at the colon    { m(x: T): T }       { m(x?: T): T } (TS1109)     { m(): T }      { new (x: T): T }      { m(x, y): T }
//   { 'name' ( name :         the same, a quoted name being a string, a call of which fails as a call of a name does   { 'm'(x: T): T }   { "m"(): T }   { 'a\'b'(x, y): T }
// and for a container that holds nothing but names, numbers, `.`, `,` and white space — `{ a }`, `{}`, `{ a, b }`, `{ ...a }`, `{ a.b }`, `{ typeof a }` — or nothing that could hide a `}`
// of its own (below), whatever it is, valid or not, it is skipped: if it is an expression it ends at its `}`, and if it is not TypeScript reports an error inside it, before anything later that
// is named. Anything else — a comment, a `<`, a `{`, a quote, a `?` that is not followed by a colon after a quoted name — is not read, unless `strings` says that strings and braces are: they are then
// skipped exactly (containerEndWithStrings), so `{t("label")}`, `{"a}"}` and `{{ color: "red" }}` are skipped where only the strings and the braces could hide a `}`.
function containerFailsAt(src, open, last, strings = false) {
  const skip = (at) => skipTagTrivia(src, at, last);
  const nameEnd = (at) => { let j = at; if (!isTagNameStart(src[j])) return -1; while (isTagNamePart(src[j])) j += 1; return j; };
  // The offset of the colon in `:` or `? :` at `at`, or -1: a name followed by one is an error at the colon.
  const colonAt = (at) => {
    const k = skip(at);
    if (src[k] === ':') return k;
    if (src[k] !== '?') return -1;
    const m = skip(k + 1);
    return src[m] === ':' ? m : -1;
  };
  // A `[` at `bracket`: `[k: string]`, `[K in keyof T]`, `[a]`, followed by a colon.
  const bracketFails = (bracket) => {
    const first = skip(bracket + 1);
    const word = nameEnd(first);
    if (word !== -1) {
      const colon = skip(word);
      if (src[colon] === ':') return colon;
      if (src[colon] === '?' && src[skip(colon + 1)] === ':') return skip(colon + 1);
    }
    const end = skippableEnd(src, bracket + 1, last);
    return src[end] === ']' ? colonAt(end + 1) : -1;
  };
  // A `(` at `paren`, after a name or after a quoted name: a call, whose first argument is a name and a colon (`m(x: T)`, `m(x?: T)`), or whose arguments are names, numbers and member
  // names, or none, and that a colon follows (`m(x): T`, `m(): T`, `m(x, y): T`). No expression has either colon, so it is the first token TypeScript cannot take.
  const callFails = (paren) => {
    const inner = skip(paren + 1);
    const argument = nameEnd(inner);
    const argumentColon = argument === -1 ? -1 : colonAt(argument);
    if (argumentColon !== -1) return argumentColon;
    const end = skippableEnd(src, inner, last);
    if (src[end] !== ')') return -1;
    const afterCall = skip(end + 1);
    return src[afterCall] === ':' ? afterCall : -1;
  };
  const start = skip(open + 1);
  const quote = src[start];
  if (quote === '"' || quote === "'") {
    // A quoted name is a string in an expression container, a JavaScript string with its escapes (`{ 'a\'b': T }`), which ends at its own quote: stringEnd.
    const end = stringEnd(src, start, last);
    if (end === -1) return null;
    const colon = colonAt(end);
    if (colon !== -1) return { fails: colon };
    // A quoted name and a `(` — a method signature with a quoted name, `{ 'm'(x: T): T }` — is a call of a string, which fails as a call of a name does: below. The name is no keyword, so
    // there is no `async (x: T) => x` to be read for an arrow.
    const next = skip(end);
    const call = src[next] === '(' ? callFails(next) : -1;
    if (call !== -1) return { fails: call };
    const resume = strings ? containerEndWithStrings(src, open + 1, last) : -1;
    return resume === -1 ? null : { resume };
  }
  if (src[start] === '[') {
    const colon = bracketFails(start);
    if (colon !== -1) return { fails: colon };
  }
  // A number is an expression that a colon cannot follow either, in any of the forms the scanner reads as one literal — `{ 1: T }`, `{ 1.5: T }`, `{ 0x1: T }`, `{ 1e3?: T }` —
  // and what comes after its first characters is not read: a token that goes on past this class (`1e+3`) is left undecided.
  if (/[0-9]/.test(src[start] || '') || (src[start] === '.' && /[0-9]/.test(src[start + 1] || ''))) {
    let numberEnd = start;
    while (numberEnd <= last && /[0-9A-Za-z_.]/.test(src[numberEnd])) numberEnd += 1;
    const colon = colonAt(numberEnd);
    if (colon !== -1) return { fails: colon };
  }
  const word = nameEnd(start);
  if (word !== -1) {
    const first = src.slice(start, word);
    const colon = colonAt(word);
    if (colon !== -1) return { fails: colon };
    const next = skip(word);
    if (isTagNameStart(src[next]) && !EXPRESSION_PREFIX_WORDS.has(first) && !EXPRESSION_INFIX_WORDS.has(src.slice(next, nameEnd(next)))) return { fails: next };
    if (src[next] === '[') {
      const bracket = bracketFails(next);
      if (bracket !== -1) return { fails: bracket };
    }
    if (src[next] === '(' && !NOT_CALLED_WORDS.has(first)) {
      const call = callFails(next);
      if (call !== -1) return { fails: call };
    }
  }
  const end = skippableEnd(src, open + 1, last);
  if (src[end] === '}') return { resume: end + 1 };
  // What else cannot hold a nested construct that hides a `}`: any run without `{`, `}`, a quote, a back-tick, `/`, a backslash or `<` — no object, string, template, comment, regex, escape
  // or element, which are the places a `}` can stand that is not the container's own. So the first `}` ends the container whatever the content is, and the expression parser, which takes
  // no `}` as part of an expression, either reads it to there or reports an error inside it, before anything the text after it holds. Then, as for the names above, the text goes on:
  // `{ (y: T): T }`, `{ m?(y: T): T }`, `{ [Symbol.iterator](): T }`, `{ a = 1 }`, `{ -readonly [K in keyof T]-?: T[K] }`, `{ a.b: T }`.
  const plain = plainContainerEnd(src, open + 1, last);
  if (src[plain] === '}') return { resume: plain + 1 };
  const resume = strings ? containerEndWithStrings(src, open + 1, last) : -1;
  return resume === -1 ? null : { resume };
}

// The index just past the type arguments of a tag that start at `at`, a `<`: names (`Name`, `A.B`), commas and nested lists only, which TypeScript parses as types whatever
// the names mean (tryParseTypeArguments, right after the tag name); -1 where they hold anything else or are not closed before `limit`. Reading them is what lets the `>` that
// ends the tag of `Array<Array<T>>` — `Array`, then the type arguments `<T>`, then that `>` — count as text, where a tag with other type arguments is left alone.
//   Array<Record<string, T>>      the tag is `Record`, its type arguments `<string, T>`, and the `>` after them ends it
function skipTagTypeArguments(src, at, limit) {
  let depth = 1;
  let state = 'open';              // open: a type argument starts; name: a name was read; close: a list was closed
  let k = at + 1;
  while (k < limit) {
    const c = src[k];
    if (isTagSpace(c)) { k += 1; continue; }
    if (state === 'open') {
      if (!isTagNameStart(c)) return -1;
      while (isTagNamePart(src[k])) k += 1;
      while (src[k] === '.' && isTagNameStart(src[k + 1])) { k += 1; while (isTagNamePart(src[k])) k += 1; }
      state = 'name';
    } else if (c === ',') {
      state = 'open';
      k += 1;
    } else if (c === '>') {
      depth -= 1;
      k += 1;
      state = 'close';
      if (depth === 0) return k;
    } else if (c === '<' && state === 'name') {
      depth += 1;
      state = 'open';
      k += 1;
    } else {
      return -1;
    }
  }
  return -1;
}

// The end of the tag name that starts at `at`: names joined by dots (parseJsxElementName). The scanner continues a name over a `-` and a single `:` (`a-b`, `a:b`), which is not read here:
// the caller looks at the character this returns.
function tagNameEnd(src, at) {
  let k = at;
  for (;;) {
    while (isTagNamePart(src[k])) k += 1;
    if (src[k] === '.' && isTagNameStart(src[k + 1])) { k += 1; continue; }
    return k;
  }
}

// A tag whose name starts at `at` (the character after its `<`), read up to the `>` that ends it: { resume } is where the text goes on, { fails } the offset of what TypeScript
// rejects, and null where this reading cannot say. `arrow` is the `=` of the arrow whose element reading is being asked after: a tag that reaches it has the arrow inside.
// `closing` says that the text is read to a closing tag (readChildren) and not to an arrow: an expression container that is an attribute's value or a spread is then skipped, as one in the text is
// (containerFailsAt), where an arrow reading leaves the tag unread.
//   <b>   <b/>   <b / >   <A.B x y-z a="1" b='2' c = "3" d="\">   — a JSX attribute string has no escapes, so the last one is `"\"` and ends at the second quote
//   <b x={1} {...props} style={{ color: "red" }}>        — read where `closing` is
function readTag(src, at, arrow, closing = false) {
  let k = tagNameEnd(src, at);
  // The scanner continues a tag name over a `-` and a single `:` (`a-b`, `a:b`), which is not read here.
  if (src[k] === '-' || src[k] === ':') return null;
  let typeArguments = true;          // only right after the name (tryParseTypeArguments)
  for (;;) {
    while (k < arrow && isTagSpace(src[k])) k += 1;
    if (k >= arrow) return null;
    const c = src[k];
    if (c === '>') return { resume: k + 1 };
    if (c === '/') {
      // `/` and `>` are two tokens of a self-closing tag, with trivia of every kind between them (the lexer's `/` of a tag, lexInto): `<b />`, `<b / >`, `<b /⏎>`, `<b / /* c */ >`. Where another token
      // follows the `/`, TypeScript expects the `>` and reports it missing (TS1005). The `//` and `/*` of a comment right after the last token of the tag are not read.
      if (src[k + 1] === '/' || src[k + 1] === '*') return null;
      const close = skipSpaceAndComments(src, k + 1);
      if (close >= arrow) return null;
      return src[close] === '>' ? { resume: close + 1, selfClosing: true } : { fails: close };
    }
    if (c === '{') {
      // A `{` where an attribute may start begins a spread, `{...props}`, and parseJsxSpreadAttribute wants the `...` right after it, so anything else there is an error at that
      // token (TS1005): `<T extends { a: string }>`, `<b {a}>`. A comment, a character beyond ASCII (which may be trivia) or the dots are not decided.
      let m = k + 1;
      while (m < arrow && isTagSpace(src[m])) m += 1;
      if (closing && src[m] === '.') {
        // A spread is no name, number or key: skipped as a container, or not read; `{.5: 1}` has no `...` and fails at its colon, as any `{` that no `...` follows does.
        const spread = containerFailsAt(src, k, arrow - 1, true);
        if (spread === null || spread.fails !== undefined) return spread;
        k = spread.resume;
        typeArguments = false;
        continue;
      }
      return m < arrow && src.charCodeAt(m) <= 0x7f && src[m] !== '.' && src[m] !== '/' ? { fails: m } : null;
    }
    if (c === '<') {
      // Type arguments come only right after the name (tryParseTypeArguments): after an attribute a `<` is no attribute name (TS1003), as in `<T extends A<B>>`.
      if (!typeArguments) return { fails: k };
      const end = skipTagTypeArguments(src, k, arrow);
      if (end === -1) return null;
      k = end;
      typeArguments = false;
      continue;
    }
    if (isTagNameStart(c)) {
      typeArguments = false;
      k += 1;
      while (isTagNamePart(src[k]) || src[k] === '-') k += 1;
      let m = k;
      while (m < arrow && isTagSpace(src[m])) m += 1;
      if (m >= arrow || src[m] !== '=') continue;
      // `=>` and `==` are tokens of their own to the scanner: the attribute has no value, and the token is where no attribute can start (TS1003).
      if (src[m + 1] === '>' || src[m + 1] === '=') return { fails: m };
      m += 1;
      if (m >= arrow) return null;
      // What follows the `=` is read by TypeScript like this (scanner.ts, scanJsxAttributeValue): the character right after it decides, with no white space skipped. A quote there
      // starts a JSX string — no escapes, line breaks allowed — so `x="a\"` ends at its second quote. Anything else goes to scan(), which first skips ALL trivia and then reads an
      // ordinary token: a string with JavaScript's escapes (`x = "a\"` goes on past the backslash-quote, where `x="a\"` ends there), a `{`, a `<`, or something that is no value.
      // The trivia is more than ASCII white space: it is everything ts.isWhiteSpaceSingleLine and ts.isLineBreak name, the no-break space, U+0085, U+2028, the zero-width space and the
      // byte order mark among it, and comments. So only a quote right after the `=` is read as a string here.
      if (src[m] === '"' || src[m] === "'") {
        const quote = src[m];
        let close = m + 1;
        while (close < arrow && src[close] !== quote) close += 1;
        if (close >= arrow) return null;     // not closed before the arrow: the arrow is inside the string, or the string is not closed at all
        k = close + 1;
        continue;
      }
      while (m < arrow && isTagSpace(src[m])) m += 1;
      if (m >= arrow) return null;
      // A character beyond ASCII where the value should start may be trivia that scan() skips before the value — `x=`, U+00A0 and `"a"` is an attribute whose value is "a", and the
      // element compiles — or a letter, or something TypeScript rejects. It cannot be told which here, so nothing is said: a reading that takes it for a value that is no value calls a
      // compiling element unparseable. `fails` is for ASCII characters only, each of which is trivia (skipped above), a quote, `{`, `<` or `/` (not read, next), or a character that
      // scan() returns as a token that is no value or an invalid character, and TypeScript reports an error at it (TS1145, TS1127).
      if (src.charCodeAt(m) > 0x7f) return null;
      // A container is the attribute's value, `x={1}`: skipped where the text is read to a closing tag, with the verdict that a container in the text has. An arrow reading does not read it.
      if (closing && src[m] === '{') {
        const value = containerFailsAt(src, m, arrow - 1, true);
        if (value === null || value.fails !== undefined) return value;
        k = value.resume;
        continue;
      }
      // After white space a quote is an ordinary string, `{` is a container, `<` an element, and a `/` may start a comment: not read. Anything else is no attribute value (TS1145).
      if (src[m] === '"' || src[m] === "'" || src[m] === '{' || src[m] === '<' || src[m] === '/') return null;
      return { fails: m };
    }
    if (NOT_IN_A_TAG.has(c)) return { fails: k };
    return null;
  }
}

// The reading of the text that starts at `from` — just past the `>` of `<Name>` — as the children of an element, token by token, the way TypeScript's parser reads them (see above). It stops at the
// first character TypeScript rejects, and it is asked two things, which differ in where the text ends:
//   `closing` null     up to and including the `>` of the `=>` at `arrow`: is the text of `<Name>(…) =>` an element? A `>` or `}` in the text is the error, so reaching the arrow's own `>` in text is
//                      a failure too, and a closing tag or a fragment is not read.
//   `closing` { name } up to the closing tag of the element, which is `name`'s, or `last`: could `<Name>` and the text after it be an element? The nested elements are followed, each
//                      closed by its own closing tag (a name that is not the one the innermost open element has is TS17002), and the first closing tag with none open ends the element.
// The result is { fails } with the offset of what TypeScript rejects, { closes, hideable } with the offset of the `>` of the closing tag that ends the element, or null where nothing can be said:
// a container, tag or closing tag this does not read, or the end of the window. `hideable` is set where the closing tag could be inside a string, a template, a comment or a regex that the text
// opens, as part of a type that holds one, and not a closing tag at all. The text is scanned as the type would scan it, as code: a string that starts in it and ends after the closing tag (or may: the
// window ends first); a template that does (one with a `${` is code that is not read: it may); a comment, `//` to the end of its line or `/* */`, that does; and a `/` that is neither — a
// regex, where one may start, is the one thing left that could — unless a word or a number stands before it, after which it divides, or is an error in a type (slashFollowsAnOperand). A quote with no
// closing quote on its line is no string, and neither is one right after a word that is no keyword, an apostrophe or an inch mark (quoteEndsAWord). A nested tag's attribute strings and a container's
// content are no text, and set nothing.
// An expression container is read for what it can be said to hold (containerFailsAt): an error, or nothing that matters, after which the text goes on.
function readChildren(src, from, last, arrow, closing) {
  const bound = closing === null ? arrow : last + 1;
  const open = [];
  let hideable = false;
  let hiddenUntil = 0;                       // the end of the furthest string, template or comment that the text opened
  let typeChecked = false;                   // the first thing in the text that could hide the closing tag was asked whether the type up to it can be valid (typeMembersFail)
  let typeDead = false;                      // ... and it cannot: nothing in the text hides the closing tag
  let j = from;
  while (j <= last) {
    const c = src[j];
    if (c === '>' || c === '}') return { fails: j };
    if (c === '{') {
      // A string in a container is skipped exactly where there is a closing tag to find: the elements this is asked of are short, and what could hide a `}` is the string.
      const container = containerFailsAt(src, j, last, closing !== null);
      if (container === null) return null;
      if (container.fails !== undefined) return { fails: container.fails };
      j = container.resume;
      continue;
    }
    if (c !== '<') {
      if (closing !== null && j >= hiddenUntil && !typeDead) {
        // What the text opens that a type reads as a token: a string, a template, a comment (a regex, where one may start) — the closing tag is hidden by one that is not closed before it. `hides`
        // is 0 where this opens nothing that hides, -1 where it may, and the index just past it where it does.
        let hides = 0;
        if (c === '`') {
          const end = templateEnd(src, j, last);
          hides = end === -1 ? -1 : end;
        } else if (c === '/') {
          const end = commentEnd(src, j, last);
          if (end !== -1) hides = end;
          else if (!slashFollowsAnOperand(src, j)) hides = -1;
        } else if ((c === '"' || c === "'") && !quoteEndsAWord(src, j)) {
          const end = stringScan(src, j, last);
          hides = end === -2 ? -1 : Math.max(end, 0);
        }
        if (hides !== 0) {
          // The first thing that could hide the closing tag is asked whether the type that this text would be the members of can be valid up to it: where it cannot, no type holds the closing tag
          // in anything, nothing that follows can hide it, and the text is an element.
          if (!typeChecked) {
            typeChecked = true;
            typeDead = closing.typeFrom >= 0 && typeMembersFail(src, closing.typeFrom, j, c);
          }
          if (!typeDead) {
            if (hides === -1) hideable = true;
            else hiddenUntil = Math.max(hiddenUntil, hides);
          }
        }
      }
      j += 1;
      continue;
    }
    j += 1;
    // `</` is one token to TypeScript's scanner in JSX text, with nothing between the two characters (scanner.ts, scanJsxToken); `< /b>` is no closing tag. What follows it is scanned as ordinary tokens, so
    // a comment may stand before the name (`</ /* c */ b>`), but `</*` has none in it: the `/` is the token's, and the `*` is TS1003. (A type reads `</*` as a `<` and a comment.)
    if (closing !== null && src[j] === '/') {
      if (src[j + 1] === '*') return { fails: j + 1 };
      const tag = readClosingTag(src, j - 1);
      if (tag.kind !== 'closed' || tag.end > last) return null;
      const expected = open.length > 0 ? open[open.length - 1] : closing.name;
      if (expected === null) return null;
      if (tag.name !== expected) return { fails: j };
      if (open.length === 0) return { closes: tag.end, hideable: hideable || j - 1 < hiddenUntil };
      open.pop();
      j = tag.end + 1;
      continue;
    }
    while (j <= last && isTagSpace(src[j])) j += 1;
    const next = src[j];
    if (isTagNameStart(next)) {
      const tag = readTag(src, j, bound, closing !== null);
      if (tag === null) return null;
      if (tag.fails !== undefined) return { fails: tag.fails };
      // A tag that is not self-closing opens an element, which a closing tag with its name closes.
      if (closing !== null && !tag.selfClosing) open.push(src.slice(j, tagNameEnd(src, j)));
      j = tag.resume;
      continue;
    }
    if (closing !== null && next === '>') {
      open.push('');                       // a fragment, `<>`, which `</>` closes
      j += 1;
      continue;
    }
    // A closing tag and a fragment are not read where there is no closing tag to find. What cannot start a tag name is TS1003.
    return j <= last && NOT_IN_A_TAG.has(next) ? { fails: j } : null;
  }
  return null;
}

// The offset of the first character that TypeScript's parser rejects when it reads the text that starts at `from` — just past the `>` of `<Name>` — as the children of an
// element, up to and including the `>` of the `=>` at `arrow`, or -1 where this reading cannot say that it fails (see above). The text of the children is everything up to a `<` or
// a `{`; a `>` or a `}` in it is the error, so reaching the arrow's own `>` in text is a failure too. An expression container is read for what it can be said to hold
// (containerFailsAt): an error, or nothing that matters, after which the text goes on.
function elementFailsAt(src, from, arrow) {
  const read = readChildren(src, from, arrow + 1, arrow, null);
  return read !== null && read.fails !== undefined ? read.fails : -1;
}

// The children of the element `<name>` read from `from`, just past its opening tag, to its closing tag, within LOOKAHEAD characters: { fails }, { closes, hideable } or null (readChildren). `name` is
// null where the tag's name is not known (headTagName), and a closing tag with no open element inside it is then not told from another. `typeFrom` is where the members of the type that the text
// would be start — just past the `)` of the parameter list — or -1 where there is no such type (typeMembersFail).
//
// A call signature's text is read to the `}` that ends its type, and the next signature in that type is read again to the same `}`: a type of k signatures costs k times its length, up to the window.
// So a pass over a source has a budget of characters to read, a share of its length and a base for short ones (lexInto), which each reading spends; where it is spent a reading says nothing, which
// is the guess, and the pass stays linear however the source is built.
const READING_BUDGET_PER_CHAR = 8;
const READING_BUDGET_BASE = 100000;
function elementChildren(src, from, name, budget = null, typeFrom = -1) {
  if (budget !== null && budget.left <= 0) return null;
  const last = Math.min(src.length - 1, from + LOOKAHEAD);
  const read = readChildren(src, from, last, -1, { name, typeFrom });
  if (budget !== null) budget.left -= (read === null ? last : read.fails !== undefined ? read.fails : read.closes) - from + 1;
  return read;
}

// `<Name>` has been read, and `after` is the index just past its `>`; `head` is the index of its `<`. A parameter list and then `=>` is a generic function type, `<T>(x: T) => T`, and that is certain wherever the
// element reading of the text between them cannot parse (elementFailsAt, above): a page that compiles has no element there. Where it may — the arrow is in a nested attribute
// string, a tag with a closing tag or a spread, an expression container that is neither shape — the text is read as the type it almost always is, and the guess is reported
// (`generic`), so nothing after the `<` is trusted: the page is complete to the structure gate, and a call after it is refused, naming the kind. A `:` after the list is a call
// signature (`<T>(x: T): T`) and also JSX text that starts with a parenthesis (`<span>(required): Name</span>`); both compile, and only a parser that knows whether a type or an
// expression is being parsed can tell them apart: that is the same guess, and the element is read, as the rule says. (Where the list can hold no parameters — `<li>(1): First</li>` — only the
// element compiles, and it is certain: parameterListMayStart.) A list that runs past the window cannot be told at all: the
// same. The parentheses are matched with comments and strings skipped, which is JavaScript's reading and not JSX's — the reason an arrow can be found where there is none.
// In a type the list is read exactly that way until something in it may start an expression (expressionMayStart: an initializer's `=`, a computed name's `[`, a decorator's `@`, an import
// type's attributes, an accessor's body, a type parameter's constraint). A type holds no regex, no JSX and no statement, so before one the `)` the scan finds is the type's, and a `/` that
// starts no comment is in no type at all: the text is the element's. After one, the scan is still exact while it reads no `/`, `<` or back-tick — with no regex, no JSX and no template, every
// quote opens a string and every parenthesis is code — and once it reads one, the expression may hold what the scan misreads (a regex with a `)` in it, JSX text, a template in a template),
// so the `)` it finds is not trusted, and a list with no arrow after it is the guess (`interface I { <T>(a = /[)]/); m: '</T>…' }` ended the list at the `)` in the regex's class, and the
// `]` after it read as the text of an element). A list whose parameters fail before any of that has no type reading either (parameterSyntaxFails).
// Parentheses followed by neither `=>` nor `:` are JSX text (`<b>(optional)</b>`) or a call signature with no return type: callSignatureOrElement says which, where it can.
function genericFunctionTypeFollows(src, after, head, budget = null) {
  const open = skipSpaceAndComments(src, after);
  if (src[open] !== '(') return { generic: false, ambiguity: null };
  // A list that can hold no parameters, or whose parameters fail before a type, a default, a pattern or a decorator, belongs to no signature and no function type: the text is an element,
  // for certain (`<li>(1): First</li>`, `<span>(press [/] to search)</span>`).
  if (!parameterListMayStart(src, open) || parameterSyntaxFails(src, open)) return { generic: false, ambiguity: null };
  const end = Math.min(src.length, open + LOOKAHEAD);
  let depth = 0;
  let k = open;
  let expression = false;   // something that may start an expression was read (expressionMayStart)
  let unsafe = false;       // ... and after it a `/`, a `<` or a back-tick: a regex, JSX or a template, which may hold what the scan misreads
  for (; k < end; k += 1) {
    const skipped = skipTrivia(src, k);
    if (skipped !== k) {
      if (src[k] === '`') {
        // skipTrivia ends a template at its first back-tick, which may be the start of one nested in a substitution: ``(a: `${`)`}`)``.
        if (!templateSkipIsWhole(src, k, skipped - 1)) return { generic: false, ambiguity: 'generic' };
        if (expression) unsafe = true;
      }
      k = skipped - 1;
      continue;
    }
    const c = src[k];
    if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) break;
    else if (expression) {
      if (c === '/' || c === '<') unsafe = true;
    } else if (expressionMayStart(src, k)) {
      expression = true;
    } else if (c === '/') {
      // No type holds a `/` that starts no comment: only the element compiles (`<p>(see: /docs)</p>`, `<span>({done}/{total})</span>`).
      return { generic: false, ambiguity: null };
    }
  }
  if (k >= end) return { generic: false, ambiguity: k >= src.length && !unsafe ? null : 'generic' };
  const next = skipSpaceAndComments(src, k + 1);
  if (src[next] === '=' && src[next + 1] === '>') return { generic: true, ambiguity: elementFailsAt(src, after, next) === -1 ? 'generic' : null };
  if (src[next] === ':' || unsafe) return { generic: false, ambiguity: 'generic' };
  return callSignatureOrElement(src, after, head, k, next, budget);
}

// Whether the parameter list whose `(` is at `open` can hold what TypeScript parses as parameters (parseParameters, parseParameterWorker,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts): its first token is the `)` of an empty list, a name or a modifier (a letter, `_`, `$` or the `\` of a Unicode escape),
// a binding pattern's `{` or `[`, the `.` of a rest parameter or the `@` of a decorator. A number, a string, a template, a `#` or an operator first is TS1003 in a call signature, a construct
// signature and a function type alike — `interface I { <b>(1): text }` has none — so where one stands the text is JSX that starts with a parenthesis. A character beyond ASCII is not judged
// (TypeScript reads more of them as names or as white space than this does), nor is a `.`, which may be the start of `...` (`.5` is a number, and TS1003 too).
function parameterListMayStart(src, open) {
  const c = src[skipSpaceAndComments(src, open + 1)];
  return c === undefined || c.charCodeAt(0) > 0x7f || /^[A-Za-z_$\\{[.@)]$/.test(c);
}

// The words TypeScript's parser takes before a parameter's name (parseParameterWorker reads modifiers there, and only the checker rejects a misplaced one), measured over every keyword
// TypeScript 5.8 has, each in a call signature, a construct signature and a function type, followed by a name: all three parse. A parameter that starts with one is not read.
const PARAMETER_MODIFIERS = new Set(['abstract', 'accessor', 'async', 'declare', 'export', 'in', 'out', 'override', 'private', 'protected', 'public', 'readonly', 'static']);
// The keywords that are no parameter's name in any of those places, alone or with a type (TS1359, TS1390 and the like are parse diagnostics): a parameter that starts with one fails —
// but `default`, which is a modifier before what it can head (defaultMayModify). Every other keyword — `get`, `set`, `of`, `type`, `let`, `await` and the rest — parses as a name
// there, alone, with a type, optional, and after a `,`. The test of these sets measures them again, before every keyword.
const NOT_PARAMETER_NAMES = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with']);

// Whether the parameter list whose `(` is at `open` fails as parameters before anything this does not read. Each parameter is read up to its type, its default, a pattern, a decorator or a
// modifier, which end the reading (false): an optional `...` and a name, then an optional `?`, then `:`, `=`, `,` or `)` — what TypeScript wants after the name (parseParameterWorker,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts; anything else is TS1005). A character beyond ASCII that is not white space to TypeScript (isTrivia) or a backslash
// may go on with the name, and ends the reading too. Any other ASCII character
// after a name is no parameter's in a call signature, a construct signature and a function type alike, and neither is one that no parameter starts with after a `,` (a number, a quote, a
// back-tick, a `<`, a `#`, an operator: TS1003, as parameterListMayStart says of the first), so only the element compiles:
// `(press [/] to search)`, `(see @/components)`, `(it's)`, `(N/A)`, `(see docs)`, `(a.b)`. A keyword is read as TypeScript reads it there: a modifier (PARAMETER_MODIFIERS) or `this`, which is a
// name only first and alone, ends the reading; one that is no parameter's name (NOT_PARAMETER_NAMES: `(extends <code>Base</code>)`, `(import from <b>CSV</b>)`) fails, except a `default`
// that may be a modifier; every other keyword is a name (`(get the <b>app</b>)`, `(set in <b>Settings</b>)`). A type is read only to its second token: one that fails there fails
// the list (typeStartFails).
function parameterSyntaxFails(src, open) {
  let k = skipSpaceAndComments(src, open + 1);
  for (;;) {
    if (src.startsWith('...', k)) k = skipSpaceAndComments(src, k + 3);
    let end = k;
    while (end < src.length && /[A-Za-z0-9_$]/.test(src[end])) end += 1;
    if (end === k || /[0-9]/.test(src[k])) return false;
    if (end < src.length && (src[end] === '\\' || (src[end].charCodeAt(0) > 0x7f && !isTrivia(src[end])))) return false;
    const word = src.slice(k, end);
    if (PARAMETER_MODIFIERS.has(word) || word === 'this') return false;
    if (word === 'default' && defaultMayModify(src, end)) return false;
    if (NOT_PARAMETER_NAMES.has(word)) return true;
    k = skipSpaceAndComments(src, end);
    if (src[k] === '?') k = skipSpaceAndComments(src, k + 1);
    const c = src[k];
    if (c === ',') {
      k = skipSpaceAndComments(src, k + 1);
      // The next parameter starts as the first does (parameterListMayStart): a number, a quote, a back-tick, a `<`, a `#` or an operator there is TS1003.
      const n = src[k];
      if (n !== undefined && n.charCodeAt(0) <= 0x7f && !/^[A-Za-z_$\\{[.@)]$/.test(n)) return true;
      continue;
    }
    // A type that fails at its second token is TS1005 there (`(Note: <a href="/help">see help</a>)`, `(Tip: get the <b>app</b>)`); any other type ends the reading.
    if (c === ':') return typeStartFails(src, skipSpaceAndComments(src, k + 1));
    return c !== undefined && c !== ')' && c !== '=' && c.charCodeAt(0) <= 0x7f;
  }
}

// Whether `default`, ending at `end` at the start of a parameter, may be a modifier there. TypeScript's parser takes it as one before what it can head — `class`, `function`,
// `interface`, `abstract`, `async` or a decorator (nextTokenCanFollowDefaultKeyword) — so `(default interface)` and `(default @d x)` parse, a parameter named `interface`
// or `x` (only the checker objects). Before anything else it is no parameter's name. A character that could continue or escape a word is not read: true.
function defaultMayModify(src, end) {
  const next = skipSpaceAndComments(src, end);
  const c = src[next];
  return c === '@' || c === '\\' || (c !== undefined && c.charCodeAt(0) > 0x7f) || /^(?:class|function|interface|abstract|async)(?![\w$])/.test(src.slice(next, next + 10));
}

// The words a type may start with that take a type after them: `keyof T`, `typeof x`, `readonly T[]`, `unique symbol`, `infer U`, `asserts x`, measured over every keyword
// TypeScript has; `new`, `abstract`, `function` and `import`, which start a type that a name does not follow, are kept as well.
const TYPE_OPERATOR_WORDS = new Set(['keyof', 'typeof', 'readonly', 'unique', 'infer', 'asserts', 'new', 'abstract', 'function', 'import']);

// Whether the type that starts at `t`, a parameter's, fails at its second token, a name. A name there that follows a type reference is TS1005 (the list wants a `,`, a `)`, an `=`, a
// `?` or an operator), unless the first word takes a type after it (TYPE_OPERATOR_WORDS) or the second is a conditional type's `extends`. A `<` there opens a generic function type's
// type parameters, which after their first name want `,`, `>`, `=` or `extends` (parseTypeParameter), unless the first word is a modifier — TypeScript parses every one there, and
// only the checker objects (`<private x>`). A name that a character beyond ASCII or a backslash goes on with ends the reading: false. Both are measured against TypeScript over
// every pair of keywords.
function typeStartFails(src, t) {
  const nameEnd = (at) => {
    let e = at;
    while (e < src.length && /[A-Za-z0-9_$]/.test(src[e])) e += 1;
    if (e === at || /[0-9]/.test(src[at]) || src[e] === '\\' || (e < src.length && src[e].charCodeAt(0) > 0x7f && !isTrivia(src[e]))) return -1;
    return e;
  };
  const parameters = src[t] === '<';
  const first = parameters ? skipSpaceAndComments(src, t + 1) : t;
  const firstEnd = nameEnd(first);
  if (firstEnd === -1) return false;
  const word = src.slice(first, firstEnd);
  if (parameters ? word === 'const' || PARAMETER_MODIFIERS.has(word) : TYPE_OPERATOR_WORDS.has(word)) return false;
  const second = skipSpaceAndComments(src, firstEnd);
  const secondEnd = nameEnd(second);
  return secondEnd !== -1 && src.slice(second, secondEnd) !== 'extends';
}

// Whether the character at `k`, in a parameter list read as a type, may start an expression or a statement there. TypeScript's parser does so from a type only at these places (parser.ts,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts): an initializer's `=` (any `=` that is not the `=>` of a function type — `a: A<B>= /re/` is an initializer
// after type arguments), a computed name's `[` (any `[` but the `[]` of an array type, which this does not tell from a tuple, an index signature or an indexed access), a decorator's `@`,
// an import type's attributes (`import("m", { with: { k: v } })`), an accessor's body in a type literal (`{ get x() { return 1 / 2 } }`: parseAccessorDeclaration parses a block, and only the
// checker objects), and a type parameter's constraint, which is read as an expression where its first token starts no type (`<U extends /x/>`: parseTypeParameter). So `import` counts
// as a whole word wherever it stands, `get` and `set` wherever an accessor's name may follow them, and `extends` wherever what follows it may start no type: more starts only leave
// the scan untrusted sooner where a `/`, a `<` or a back-tick follows. `typeof` takes a name.
function expressionMayStart(src, k) {
  const c = src[k];
  if (c === '=') return src[k + 1] !== '>';
  if (c === '@') return true;
  if (c === '[') return src[skipSpaceAndComments(src, k + 1)] !== ']';
  if (/[\w$\\]/.test(src[k - 1] || '') || !/[eigs]/.test(c)) return false;
  const word = /^(?:import|extends|get|set)(?![\w$\\])/.exec(src.slice(k, k + 8));
  if (word === null) return false;
  if (word[0] === 'extends') {
    // A constraint is read as a type where its first token starts one (`isStartOfType() || !isStartOfExpression()`), and a conditional type's `extends` is always followed by a
    // type, so before a name, a string, a number, a template, a `{`, a `[`, a `<`, a `|`, a `&`, a `!`, a `?`, a `*` or a `.` it starts nothing: `${T extends string ? Capitalize<T>
    // : never}` holds no expression. Before `class`, `super`, `delete` (and `await` and `yield`, which no type takes either), a `/`, a `(`, an operator, a `#` or an `@` it may.
    const next = skipSpaceAndComments(src, k + 7);
    const n = src[next];
    if (n === undefined) return true;
    if (/^[A-Za-z_$]$/.test(n)) return /^(?:class|super|delete|await|yield)(?![\w$\\])/.test(src.slice(next, next + 7));
    return !(n.charCodeAt(0) > 0x7f || /^[{['"`0-9<|&!?*.]$/.test(n));
  }
  if (word[0] !== 'get' && word[0] !== 'set') return true;
  // `get` and `set` begin an accessor only before its name — a `[`, a name or a keyword, a string or a number (canFollowGetOrSetKeyword). Before a `:`, a `?`, a `(`, a `<` or a `,` each is
  // a name, a property's (`{ get: T }`), a method's (`{ get(url: string): T }`) or a parameter's (`(get: /docs)`), and starts nothing.
  const next = src[skipSpaceAndComments(src, k + 3)];
  return next !== undefined && (next.charCodeAt(0) > 0x7f || /^[\w$\\['"#.]$/.test(next));
}

// Whether the template that opens with the back-tick at `open` ends at the back-tick at `close`, the first one after it that no backslash escapes, where skipTrivia ends it, and not at the start of a
// template nested in one of its substitutions (TemplateLiteral, https://tc39.es/ecma262/#sec-template-literal-lexical-components): each `${` is followed to its `}`, with the braces in it counted and the
// strings in it skipped. A `/` in a substitution (a comment, a regex or a division, which may hold a brace) leaves it unsaid, and so does a string that does not close before `close`: false.
// So does a `<` after anything in a substitution that may start an expression (expressionMayStart), as in the parameter list around it: in a template literal type JSX enters a substitution
// only through one — an accessor's body, a constraint, a default, a computed name — and starts with a `<`, and a quote in its text is no string, so the strings this skips would be the wrong
// ones (`${{ get x() { return <p>it's</p> } y: '}}}' | `)` }}` read `it's</p> … '` as a string and found the `}` of the substitution in the wrong place). No back-tick comes before `close`.
// A template literal type, x: `a${string}`, `${Lowercase<T>}` or `${T extends string ? 'a' : 'b'}`, is whole; a = `${`)`}` is not.
function templateSkipIsWhole(src, open, close) {
  let depth = 0;
  let expression = false;
  for (let k = open + 1; k < close; k += 1) {
    const c = src[k];
    if (c === '\\') {
      k += 1;
    } else if (depth === 0) {
      if (c === '$' && src[k + 1] === '{') {
        depth = 1;
        k += 1;
      }
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
    } else if (c === '"' || c === "'") {
      let j = k + 1;
      while (j < close && src[j] !== c && !isLineTerminator(src[j])) j += src[j] === '\\' ? 2 : 1;
      if (j >= close || src[j] !== c) return false;
      k = j;
    } else if (c === '/' || (c === '<' && expression)) {
      return false;
    } else if (expressionMayStart(src, k)) {
      expression = true;
    }
  }
  return depth === 0;
}

// The name of the tag whose `<` is at `head`, or null where white space or a comment stands between them: the name of its closing tag is not known then. (A name that a `-` or a `:` continues never
// gets here: the rule above reads the first name as a word, and a head that readTag cannot read is no head.)
function headTagName(src, head) {
  return isTagNameStart(src[head + 1]) ? src.slice(head + 1, tagNameEnd(src, head + 1)) : null;
}

// `<Name>` and a parameter list, with neither `=>` nor `:` after it: `close` is the `)` and `next` the token after it. It is JSX text that starts with a parenthesis, or — where a type holds members —
// a call or construct signature with no return type, which TypeScript parses with no diagnostic and which the text alone does not tell from an element until its end:
//   const e = <b>(optional)</b>;                  interface I { <T>(x) }            type L = { <T>(x); m: { a: string } };            interface C { new <T>(x) }
// An element read for a signature reads the rest of the type as JSX text up to a closing tag found in a string or a comment that comes after it — `const s = '</T>;navigateTo({ … });//'` — where the
// call is a real one in no reading, and its token was rewritten. A signature read for an element is the failure; an element read for a signature reads JSX text as code, which is the same failure
// the other way (a call inside the text of an element is no call). Two things settle it:
//   1. A signature ends its member where TypeScript wants it to: after the `)` comes `,`, `;`, `}` or the end of the source, or the next token is on a later line (parseTypeMemberSemicolon, and
//      canParseSemicolon for the line break, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts). Anything else on the line — a name, a `<`, a `(`, a `{`, a comment that holds no
//      line break — is TS1005, so no signature stands there and the text is an element, for certain: `<b>(optional)</b>`, `<p>({t("label")})</p>`, `<span>(total: {count})</span>`. So is a closing tag
//      right after the `)`, on whatever line: `</` is one token to the scanner in a .tsx file and no member begins with it (but `</*` is `<` and a comment).
//   2. Where the member may end there, the text is read from the `>` of `<Name>` as the children of an element (readChildren), up to the closing tag of its own, a failure, something it cannot read, or the
//      end of the window (or of the pass's budget, elementChildren). A failure — a `}` or a `>` in the text, a container or a tag TypeScript rejects, a closing tag that is not the open element's, a `</*` (TS1003 to
//      an element; to a type, the `<` and the comment of the next signature's type parameters) — means
//      no page that parses has an element there, so it is a signature, read as code, for certain: the `}` that ends the type is the usual one. A closing tag reached means an element, for certain: a type
//      member list has no `</` as code, so the closing tag could be one only inside a string, a template, a comment or a regex that the text opens (`interface I { <T>(x); m: '</T>' }`). The text is scanned as the
//      type would scan it, as code, from the `(` on: where none of those is open at the closing tag, it is in code, and no type reads it as a type — the element is the only reading, for certain. Where one that is not
//      closed before it is open at it (a string, a template, a comment), or may be (a `/` that a regex may start after, a template with a `${`), or the reading cannot say, both programs compile and the text up to
//      the decision is the same: the guess
//      (`generic`), the element read.
function callSignatureOrElement(src, after, head, close, next, budget) {
  const token = src[next];
  // Text that ends here is a page that was cut off; no reading of it is complete.
  if (token === undefined) return { generic: false, ambiguity: null };
  let lineBreak = false;
  for (let k = close + 1; k < next && !lineBreak; k += 1) lineBreak = isLineTerminator(src[k]);
  const closingTag = token === '<' && src[next + 1] === '/' && src[next + 2] !== '*';
  if (closingTag || (!lineBreak && token !== ',' && token !== ';' && token !== '}')) return { generic: false, ambiguity: null };
  const read = elementChildren(src, after, headTagName(src, head), budget, close + 1);
  if (read === null) return { generic: false, ambiguity: 'generic' };
  if (read.fails !== undefined) return { generic: true, ambiguity: null };
  return { generic: false, ambiguity: read.hideable ? 'generic' : null };
}

// Whether the text that starts with the `<` at `i` provably cannot be an element, so that no page TypeScript parses has one there, whatever stands before the `<`. Its head read as a tag
// fails (`<T,>` has a `,` where an attribute or the end of the tag must be, `<T = X>` a value that is no string, container or element: TS1003 and TS1145), or the head ends and a parameter list
// and an arrow follow, and the element reading of the text between them fails (elementFailsAt: a `>` in the text, TS1382, among the rest). What the `<` opens then is the type parameters of an
// arrow or of a function type, or the second `<` of a shift whose operand cannot be an element either — code in every reading, which is what the lexer reads it as (parser.ts,
// parseJsxOpeningOrSelfClosingElementOrOpeningFragment and parseJsxAttribute, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts). So there is nothing to guess about
// the token before: a guess about it is whether an element or type parameters follow, and here an element cannot. Where an element may compile (`<T extends X>text</T>`, `<b>x</b>`), nothing is
// certain and the guess stays. The first name must be an ordinary one: `await` and `yield` are names or not by the function around them, and a reserved word or a `const` has a rule of its own.
//   x as A<B> as <T,>(x: T) => x          type Fn = A | <T extends X>(x: T) => T          f< <T>(x: T) => T>()          Array<<T>(x: T) => T>
function elementReadingFails(src, i, budget = null) {
  if (!isTagNameStart(src[i + 1])) return false;
  const first = readRuleToken(src, i + 1);
  if (first.kind !== 'word' || first.escaped || RESERVED_WORDS.has(first.text) || first.text === 'await' || first.text === 'yield') return false;
  // The head is read within LOOKAHEAD characters, as the parameter list after it is: a `<` is asked this at every candidate, and a read of the whole source from each of `x<a<a<a…` would be
  // quadratic. A head that reaches the limit is left undecided.
  const tag = readTag(src, i + 1, Math.min(src.length, i + LOOKAHEAD));
  if (tag === null) return false;
  if (tag.fails !== undefined) return true;
  // A self-closing tag is the whole element: what follows it is no text of its own.
  if (tag.selfClosing) return false;
  const type = genericFunctionTypeFollows(src, tag.resume, i, budget);
  return type.generic && type.ambiguity === null;
}

/**
 * Blank every comment, string, template, regex literal and JSX text run in TSX source.
 * @param {string} code
 * @returns {string} same length as `code`, non-code regions replaced by spaces
 */
function blankLiterals(code, opts) {
  const src = String(code || '');
  // Reports each comment's [start, end) to the caller (commentRanges below), so code that must read
  // COMMENT text uses this lexer's view of what a comment is rather than a regex that takes the `//`
  // in "https://…" for one. Optional: the blanked output is the same either way.
  const onComment = opts && typeof opts.onComment === 'function' ? opts.onComment : null;
  const onRegexEnd = opts && typeof opts.onRegexEnd === 'function' ? opts.onRegexEnd : null;
  // split('') and NOT [...src]: the spread iterates by CODE POINT, so an astral character (an emoji
  // in a label, which generated pages do use) makes array indices drift out of step with the UTF-16
  // offsets everything else here uses, corrupting the output.
  const out = src.split('');
  lexInto(src, out, 0, { onComment, onRegexEnd });
  return out.join('');
}

// Whether a regex literal that starts at the `/` at `i` closes on its line, so that it COULD be read as one. A regex cannot span a line, and
// one that runs to the end of the source is unterminated: a `/` with no closing `/` before them divides, whatever stands before it.
function regexCloses(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === '\\') { j += 1; continue; }
    if (isLineTerminator(src[j])) return false;
    if (src[j] === '[') inClass = true;
    else if (src[j] === ']') inClass = false;
    else if (src[j] === '/' && !inClass) return true;
  }
  return false;
}

// The index just past the flags of the regex literal whose closing `/` is right before `from`. TypeScript's scanner takes EVERY identifier part after the closing slash as part of the literal, a valid flag or not
// (scanner.ts, reScanSlashToken: `while (p < end) { const ch = codePointUnchecked(p); if (!isIdentifierPart(ch, languageVersion)) break; … p += charSize(ch); }`,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts); an unknown or repeated flag is reported later, by the checker, and is no parse error. So a word that follows is part of the
// literal, and what the table of keywords says of it does not matter:
//   const n = /x/in / 2;       one literal `/x/in`, then a division by 2     (read as `/x/`, the keyword `in` and a regex from the second slash, the next regex is exposed as code)
//   const n = /x/is / 2;       the flags `i` and `s`, and `is` is no keyword either
// A backslash is no identifier part, so an escape ends the literal (`/x/\u0067` is a regex and an identifier, which TypeScript rejects). The scanner's tables are those of an older Unicode version than
// JavaScript's `\p{ID_Continue}`, which this reads (JSX_NAME_PART) and which holds every character the tables do: one that only the newer has is read as a flag here, and TypeScript rejects it (TS1127).
function regexFlagsEnd(src, from) {
  let k = from;
  while (JSX_NAME_PART.test(codePointAt(src, k))) k += codePointAt(src, k).length;
  return k;
}

// Whether the JSX attribute string whose quote is at `open` — and which, read as JSX reads one, ends at `close`, the next quote — is read to another end by TypeScript.
// TypeScript scans a JSX attribute value like this (scanner.ts, scanJsxAttributeValue, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts): the character
// right after the `=` decides, with nothing skipped. A quote there starts a JSX string — no escapes, line breaks allowed, ends at the next quote — which every compiler reads so.
// Anything else goes to `scan()`, which first skips ALL trivia, white space of every kind and comments, and then reads an ordinary token, so a quote that follows trivia starts a
// JavaScript string: a backslash escapes the character after it, and a raw line break is an error (scanString, with `jsxAttributeString` false). Babel and esbuild read a JSX string
// whether or not trivia comes first. So for
//   <C x= '\'/>;navigateTo({ … });//' />
// TypeScript reads ONE string, `'\'/>;navigateTo({ … });//'`, and the call is text; the others end it at the second quote and find a real call. The readings differ only where a
// backslash is in the string — a raw line break with none is an error to TypeScript and fine to the others, so the page is not one TypeScript parses — and only where the JavaScript
// reading does not end at the same quote: `x= "a\\"` and `x= "a\nb"` end where JSX's does. The lexer reads the JSX string, as it always did, and a page where the two differ is
// a guess at the quote (`jsx-attribute`).
function jsxStringEndsElsewhere(src, open, close) {
  let escapes = false;
  for (let k = open + 1; k < close; k += 1) if (src[k] === '\\') { escapes = true; break; }
  if (!escapes) return false;
  const quote = src[open];
  for (let k = open + 1; k < src.length; k += 1) {
    if (src[k] === '\\') { k = escapeEnd(src, k) - 1; continue; }
    if (src[k] === quote) return k !== close;
    if (isRawStringBreak(src[k])) return true;
  }
  return true;
}

// ─── A closing tag ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// `</`, a name and `>`, as TypeScript reads one (parser.ts, parseJsxClosingElement and parseJsxClosingFragment,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts). The `</` is one token (scanner.ts, scanJsxToken, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts),
// and what follows it is scanned as ordinary tokens, so white space of every kind AND COMMENTS stand between the tokens: before the name, around the dots of a dotted one or the colon of a namespaced
// one, and before the `>`. The name is an identifier or a keyword, which the scanner continues over a `-` (scanJsxIdentifier), and `.` joins them or a single `:` makes a namespace name of two, which
// no `.` follows (parseJsxElementName and parseJsxTagName); a closing fragment has none:
//   </A>   </A.B>   </a-b>   </a:b>   </>   </A /* > */ >   </ /* > */ A>   </A // >⏎ >   </A /* c */ . /* d */ B>   </a /* c */ : /* d */ b>
// A search for the first `>` ended the tag inside a comment and read the rest of the comment as code, and a call in it as a real call:
//   const e = <A></A /*> navigateTo({ … }); */>;
// A tag that holds anything else between its `</` and its `>` — a second name, a string, a brace, an escape in the name, a dot after a namespace name — is an error to TypeScript, so no page that
// parses has one: the lexer does not read it (`unread`), and the caller takes the first `>` as it always did, and says so.
const JSX_NAME_START = /^[\p{ID_Start}$_]$/u;
const JSX_NAME_PART = /^[\p{ID_Continue}$\u200c\u200d]$/u;
const codePointAt = (src, k) => (k < src.length ? String.fromCodePoint(src.codePointAt(k)) : '');

// The end of the name that starts at `j`, or -1: an identifier start, then identifier parts and `-` (scanJsxIdentifier). A `:` or a `.` is a token of its own, with trivia around it.
function jsxNameEnd(src, j) {
  const first = codePointAt(src, j);
  if (!JSX_NAME_START.test(first)) return -1;
  let k = j + first.length;
  for (;;) {
    const ch = codePointAt(src, k);
    if (ch === '-' || JSX_NAME_PART.test(ch)) k += ch.length;
    else return k;
  }
}

// The closing tag whose `</` is at `i`: { kind, end, comments, name }. `kind` is 'closed' — `end` is the offset of its `>`, and `name` its name as written with the dots joined and the colon of a
// namespace name kept, white space and comments dropped (a closing fragment's is '') —
// 'unterminated', where the source ends inside it (`end` is -1), or 'unread', where something stands in it that TypeScript has no tag for. `comments` are the [from, to) of the comments the
// tag holds, which are blanked and heard.
function readClosingTag(src, i) {
  const comments = [];
  let name = '';
  let j = i + 2;
  // White space and comments, which TypeScript's scanner skips between two tokens of a tag.
  const skipTrivia = () => {
    for (;;) {
      while (j < src.length && isTrivia(src[j])) j += 1;
      if (src[j] === '/' && src[j + 1] === '/') {
        const end = lineTerminatorStart(src, j);
        const stop = end === -1 ? src.length : end;
        comments.push([j, stop]);
        j = stop;
      } else if (src[j] === '/' && src[j + 1] === '*') {
        const end = src.indexOf('*/', j + 2);
        const stop = end === -1 ? src.length : end + 2;
        comments.push([j, stop]);
        j = stop;
      } else {
        return;
      }
    }
  };
  const unread = { kind: 'unread', end: -1, comments: [], name: '' };
  // A name that is cut off by the end of the source is the page cut off; anything else that is no name is not read.
  const failed = () => (j >= src.length ? { kind: 'unterminated', end: -1, comments, name: '' } : unread);
  // The part of a name that starts at `j`, with the separator that came before it.
  const part = (separator) => {
    const end = jsxNameEnd(src, j);
    if (end === -1) return false;
    name += separator + src.slice(j, end);
    j = end;
    skipTrivia();
    return true;
  };
  skipTrivia();
  if (src[j] !== '>' && j < src.length) {
    if (!part('')) return failed();
    if (src[j] === ':') {
      j += 1;
      skipTrivia();
      if (!part(':')) return failed();
    } else {
      while (src[j] === '.') {
        j += 1;
        skipTrivia();
        if (!part('.')) return failed();
      }
    }
  }
  if (src[j] === '>') return { kind: 'closed', end: j, comments, name };
  return failed();
}

// The lexer itself. From `start` it blanks inert text into `out` — `src` split into UTF-16 units,
// possibly already partly blanked by an enclosing call — and judges regex and JSX positions on it.
//
// With `untilCloseBrace` it reads the body of a template's `${…}` instead, and returns the index of
// the `}` that closes it (src.length when none does). That body is ordinary code — strings,
// comments, regexes, nested templates and JSX — so it gets this same lexer, not a lighter scanner.
// A brace counter that knew no JSX read the `/` of `</span>` in
//   `${<span>Save</span>}`
// as the start of a regex that swallowed the closing `}`, and the apostrophe in `${<p>it's</p>}` as a
// string. Either way the template never ended, and the page's `export default` vanished with it.
// Otherwise it returns src.length.
function lexInto(src, out, start, { onComment = null, onRegexEnd = null, onAmbiguity = null, onJsxTagEnd = null, untilCloseBrace = false, onEnd = null, keep = null } = {}) {
  // `out` is the literal view every position judgment below reads: comments, strings, regexes, JSX
  // text AND whole template bodies blanked. `keep`, when given, is the executable view built in the
  // same pass (blankNonCodePreservingTemplateExpressions): blanked exactly like `out`, except that a
  // template's `${…}` bodies stay code.
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < to && k < src.length; k += 1) {
      if (isLineTerminator(src[k])) continue;
      out[k] = ' ';
      if (keep) keep[k] = ' ';
    }
  };
  const blankLiteralViewOnly = (from, to) => {
    for (let k = Math.max(0, from); k < to && k < src.length; k += 1) if (!isLineTerminator(src[k])) out[k] = ' ';
  };
  // A template literal from its opening backtick at `open` to its closing one at `close`, whose `${…}`
  // bodies (`expressions`) were lexed by frames of their own. Its TEXT — the `${` and `}` delimiters
  // included — is blanked in both views. Its bodies are blanked in the literal view only (no
  // declaration lives in one), and there only around the templates each body closed itself: those are
  // blank already. Blanking the whole body at every level instead cost one pass per enclosing template
  // over every nested character — quadratic in the nesting depth. In `keep` a body's closing `}`
  // becomes `;`, so two bodies separated only by blanked text cannot read as one call:
  //   `${Xrm.Navigation.navigateTo} text ${({ pageType: "generative", pageId: "PAGEREF_x" })}`
  // blanked to spaces would present `navigateTo   ({ ... })`.
  const closeTemplate = (open, close, expressions, closedBy) => {
    let from = open + 1;
    for (const e of expressions) {
      blank(from, e.start);
      let k = e.start;
      for (const [o, c] of e.closed) { blankLiteralViewOnly(k, o + 1); k = c; }
      blankLiteralViewOnly(k, e.end);
      if (e.end >= close) { from = close; break; }   // an unterminated body ran to the end
      out[e.end] = ' ';
      if (keep) keep[e.end] = ';';
      from = e.end + 1;
    }
    blank(from, close);
    closedBy.push([open, close]);
  };

  // The lexer's state is a STACK OF FRAMES, not the call stack. A CODE frame lexes code — the module,
  // or one `${…}` body — and a TEMPLATE frame reads a template literal's text around its bodies. Each
  // body used to be lexed by a recursive call, which overflowed the call stack a little over a thousand
  // templates deep: page source is untrusted input, so its nesting now costs heap, at any depth. A code
  // frame carries its own lexer state, the templates it closed itself (`closed`), and — for a body —
  // the `${…}` record it fills in (`bodyOf`).
  const codeFrame = (bodyOf) => ({
    kind: 'code',
    mode: 'code',
    jsxDepth: 0,                    // open JSX elements in the CURRENT expression frame
    angleDepth: 0,                  // nested < > inside a tag's type arguments
    tagStart: -1,                   // the `<` that opened the tag being read (see `jsx-type-arguments`)
    selfClosingAt: -1,              // the `>` that ends the tag being read as a self-closing one, once its `/` was read (see the `/` of a tag)
    frames: [],                     // JSX-expression frames: { returnMode, braceDepth, savedJsxDepth }
    braceDepth: 0,                  // `{` opened in plain code inside a `${…}` body (untilCloseBrace)
    unterminated: false,            // a string, regex, template, comment or closing tag ran off the end
    untilCloseBrace: !!bodyOf,
    bodyOf,
    closed: [],
  });
  const root = codeFrame(null);
  root.untilCloseBrace = untilCloseBrace;
  const stack = [root];
  let i = start;
  // What this pass read, for the position of a `/` or `<` after it (see the comment above readPosition): the last character of each regex — its closing `/`, or the last of its flags — ('regex'), the `>`
  // that ends each element that is a whole operand of code ('element') and each `/` read as the division operator ('division'), by offset.
  const ends = new Map();
  // The characters the readings that look past a parameter list may read in this pass (elementChildren).
  const reading = { left: READING_BUDGET_PER_CHAR * src.length + READING_BUDGET_BASE };
  // Only the module frame reports regex and JSX-tag ends: a body's are inside a template literal, which
  // the checks that listen for them read as one inert token.
  const reportRegexEnd = (fr, j) => { if (onRegexEnd && fr === root) onRegexEnd(j); };
  const reportJsxTagEnd = (fr, j) => { if (onJsxTagEnd && fr === root) onJsxTagEnd(j); };

  const leaveJsxExpr = (fr) => {
    const f = fr.frames.pop();
    if (!f) { fr.mode = 'code'; return; }
    // Restore the enclosing element depth. It must be per-frame: in
    //   <div>{items.map(x => { return (<section>…</section>); })}</div>
    // the `<div>` is open across the whole expression, but once `</section>` closes we are back in
    // CODE (inside the arrow body), not in the div's text run. A single global counter left the
    // lexer in jsxText for the rest of the file and blanked the real `export default`.
    fr.jsxDepth = f.savedJsxDepth;
    fr.tagStart = f.savedTagStart;
    fr.mode = f.returnMode;
  };
  const enterJsxExpr = (fr, returnMode) => {
    fr.frames.push({ returnMode, braceDepth: 0, savedJsxDepth: fr.jsxDepth, savedTagStart: fr.tagStart });
    fr.jsxDepth = 0;
    fr.mode = 'code';
  };
  // The `<` at `at`, after an attribute's `=`, begins an element or a fragment that is the attribute's VALUE (parseJsxAttributeValue). It is lexed as a frame of its own, as an expression
  // container is — the depth of open elements starts again at zero in it — but it is read as a tag, not as code, and it ends where its own element does (elementEnded), whereupon the tag
  // that holds it goes on with its next attribute or its `>`.
  const enterElementValue = (fr, at) => {
    fr.frames.push({ element: true, returnMode: 'jsxTag', braceDepth: 0, savedJsxDepth: fr.jsxDepth, savedTagStart: fr.tagStart });
    fr.jsxDepth = 0;
    fr.tagStart = at;
  };
  // An element has ended at the `>` at `at`: a self-closing tag's, or a closing tag's that closed the last open one. Inside another element's text it is a child, and the text goes on;
  // as an attribute's value it ends the frame it was lexed in (enterElementValue) and the tag that holds it goes on; otherwise it ended a whole operand of code, and where it ended is
  // recorded for the `/` or `<` that may follow it.
  const elementEnded = (fr, at) => {
    if (fr.jsxDepth > 0) { fr.mode = 'jsxText'; return; }
    const top = fr.frames[fr.frames.length - 1];
    if (top && top.element) { leaveJsxExpr(fr); fr.angleDepth = 0; return; }
    fr.mode = 'code';
    if (at >= 0) ends.set(at, 'element');
  };
  // A template literal starts at the backtick `i`: its text is read by a frame of its own.
  const openTemplate = () => {
    stack.push({ kind: 'template', open: i, expressions: [] });
    i += 1;
  };
  // The template frame `tf` ends at `end` — its closing backtick, or src.length when none closes it —
  // and the code frame that opened it resumes right after it.
  const endTemplate = (tf, end) => {
    stack.pop();
    const opener = stack[stack.length - 1];
    if (end >= src.length) opener.unterminated = true;
    closeTemplate(tf.open, end, tf.expressions, opener.closed);
    i = Math.min(end + 1, src.length);
  };
  // The `${…}` body `fr` ends at `end` — its closing `}`, or src.length — and its template's text
  // resumes right after it.
  const endBody = (fr, end) => {
    fr.bodyOf.end = end;
    fr.bodyOf.closed = fr.closed;
    stack.pop();
    i = end < src.length ? end + 1 : src.length;
  };

  for (;;) {
    const fr = stack[stack.length - 1];

    if (fr.kind === 'template') {
      // Template text: only an escape, the closing backtick and a `${` mean anything here.
      if (i >= src.length) { endTemplate(fr, src.length); continue; }
      const t = src[i];
      if (t === '\\') { i += 2; continue; }
      if (t === '`') { endTemplate(fr, i); continue; }
      if (t === '$' && src[i + 1] === '{') {
        const body = { start: i + 2, end: src.length, closed: [] };
        fr.expressions.push(body);
        stack.push(codeFrame(body));
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (i >= src.length) {
      if (fr.bodyOf) { endBody(fr, src.length); continue; }
      // Where the lexer stopped: a complete module ends in plain code, with nothing left open.
      if (onEnd) onEnd({ open: fr.unterminated || fr.mode !== 'code' || fr.frames.length > 0 });
      return src.length;
    }
    const c = src[i];
    const n = src[i + 1];

    if (fr.mode === 'code') {
      // A hashbang. TypeScript's scanner skips a `#!` at the very start of the file, to the end of its line, as trivia (scanner.ts, scan(): `pos === 0` and isShebangTrivia, whose
      // /^#!.*/ stops at a line terminator, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts); anywhere else — after a byte order mark, a space or a line break —
      // a `#!` is an error. So it is a comment in effect, and is blanked and heard as one: what stands in it is text, where read as code `#!navigateTo({ … });` was a call.
      if (i === 0 && c === '#' && n === '!') {
        const end = lineTerminatorStart(src, i);
        const stop = end === -1 ? src.length : end;
        blank(i, stop);
        if (onComment) onComment(i, stop);
        i = stop;
        continue;
      }
      if (c === '/' && n === '/') {
        const end = lineTerminatorStart(src, i);
        blank(i, end === -1 ? src.length : end);
        if (onComment) onComment(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end;
        continue;
      }
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        if (end === -1) fr.unterminated = true;
        blank(i, stop);
        if (onComment) onComment(i, stop);
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        for (; j < src.length; j += 1) {
          if (src[j] === '\\') { j = escapeEnd(src, j) - 1; continue; }
          if (src[j] === c) break;
          if (isRawStringBreak(src[j])) { j = -1; break; }   // a string cannot span a raw LF/CR
        }
        // No closing quote on this line, so this quote starts no string: code that is not valid, or code read after a misread. It is read as
        // an ordinary character — a fallback, not a reading (`fallback`).
        if (j === -1) { if (onAmbiguity) onAmbiguity(i, 'fallback'); i += 1; continue; }
        if (j >= src.length) fr.unterminated = true;
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      if (c === '`') {
        // Template literal. Its body — `${}` expressions included — is blanked: no declaration lives
        // inside one. But where it ENDS is found by lexing each `${…}` body with this same lexer
        // (strings, comments, regexes, nested templates and JSX alike). Counting bare braces
        // ended `[${rows.map((r) => `{"id":"${r.id}"}`).join(",")}]` at the `}` in the nested
        // template's TEXT, and everything up to the next backtick — `export default` included — was
        // misread, so a complete page failed as truncated and later nav calls went unseen.
        openTemplate();
        continue;
      }
      // Position is judged on the blanked output, not the raw source: every comment before `i` is
      // already spaces there, so a comment's last word is not mistaken for the previous token —
      //   return (
      //     // Instructions
      //     <Text>1) Pick a record</Text>
      // read `Instructions` as the token before `<`, took the JSX for a comparison, lexed its text as
      // code and reported `1)` as an unbalanced bracket.
      if (c === '/') {
        const position = readPosition(out, i, ends);
        if (position.expression) {
          // Regex literal: scan to the unescaped closing `/`, honouring a character class so `/[/]/`
          // does not terminate early.
          let j = i + 1;
          let inClass = false;
          for (; j < src.length; j += 1) {
            if (src[j] === '\\') { j += 1; continue; }
            if (isLineTerminator(src[j])) { j = -1; break; }
            if (src[j] === '[') inClass = true;
            else if (src[j] === ']') inClass = false;
            else if (src[j] === '/' && !inClass) break;
          }
          // A regex that does not close on its line is no regex, so this `/` divides — certain, whatever the position was.
          if (j === -1) { ends.set(i, 'division'); i += 1; continue; }
          // Read as a regex that closes: a guess where the position was one, because a division was possible as well (`brace`, `paren`, …).
          // The tokenization is not changed; the position is reported to a caller that must refuse what it cannot read for certain.
          if (position.ambiguity && onAmbiguity) onAmbiguity(i, position.ambiguity);
          // The flags are part of the literal (regexFlagsEnd), and where it ends is what the `/` or `<` after it is read from (`ends`).
          const flagsEnd = j >= src.length ? j : regexFlagsEnd(src, j + 1);
          if (j >= src.length) fr.unterminated = true;
          else { reportRegexEnd(fr, j); ends.set(flagsEnd - 1, 'regex'); }
          blank(i + 1, j);
          i = Math.min(flagsEnd, src.length);
          continue;
        }
        // Read as a division: a guess only where a regex that closes on this line was possible as well; one that cannot close is no regex.
        if (position.ambiguity && onAmbiguity && regexCloses(src, i)) onAmbiguity(i, position.ambiguity);
        ends.set(i, 'division');
      }
      if (c === '<') {
        // An element starts only where an expression does, and the lexer recognises one by a letter, `_`, `$`, `>` or a Unicode escape's
        // backslash right after the `<`.
        const candidate = /[A-Za-z_$>\\]/.test(n || '');
        // The second `<` of a shift, `<<` or `<<=`, follows an operator, where an element may start, so the table reads it as one — which it
        // is not, but before a name this lexer then reads a tag: `1<<n` swallows what follows. Followed by anything else it is read as the
        // shift it is, and nothing is guessed (`operator`).
        const shift = out[i - 1] === '<';
        // Without a listener only a candidate needs its position read, as it always did.
        const position = candidate || onAmbiguity ? readPosition(out, i, ends) : null;
        // A `<` whose text cannot be an element opens type parameters in every program TypeScript parses, so the token before it is nothing to guess about (elementReadingFails). It is
        // asked only where its answer could matter: a position that is an expression start or was reported, or the second `<` of a shift.
        const typeParameters = candidate && (shift || position.expression || position.ambiguity !== null) && elementReadingFails(src, i, reading);
        if (candidate && shift && onAmbiguity && !typeParameters) onAmbiguity(i, 'operator');
        else if (candidate && !typeParameters && position.ambiguity && onAmbiguity && !(position.ambiguity === 'keyword' && asyncBeforeAngle(out, i))) onAmbiguity(i, position.ambiguity);
        if (candidate && position.expression) {
          // An element, a generic arrow's type parameters or a function type: the token before the `<` says whether TypeScript's own rule is asked (an
          // assignment expression starts) or an element is certain (a unary or binary operator), and where the answer is a guess it is reported. Directly
          // after `type Name =` it is a function type's type parameters (afterTypeAliasHead). The rule reports what it cannot decide.
          const opens = typeParameters ? { generic: true, ambiguity: null } : angleOpens(src, out, i, reading, position.operator === true);
          // What the position already reported at this `<` (`angle`, `newline`, …) is not reported twice.
          if (opens.ambiguity && onAmbiguity && opens.ambiguity !== position.ambiguity) onAmbiguity(i, opens.ambiguity);
          if (!opens.generic) {
            fr.mode = 'jsxTag';
            fr.tagStart = i;
            i += 1;
            continue;
          }
        } else if (!candidate && !shift && position && position.expression && onAmbiguity) {
          // A `<` where an expression starts can only open an element (or a generic arrow); JSX allows space after it and names beyond
          // ASCII, which this lexer does not read as one (`jsx-open`).
          onAmbiguity(i, 'jsx-open');
        }
      }
      // A backslash in code can only be a Unicode escape inside an identifier — `\u0069f` is a NAME, not `if`, and `Al\u0069as` is `Alias` —
      // which defeats the keyword and cast reading the position table does by looking at the word (`identifier`).
      if (c === '\\' && onAmbiguity) onAmbiguity(i, 'identifier');
      if (fr.frames.length) {
        const top = fr.frames[fr.frames.length - 1];
        if (c === '{') { top.braceDepth += 1; i += 1; continue; }
        if (c === '}') {
          if (top.braceDepth === 0) { leaveJsxExpr(fr); i += 1; continue; }
          top.braceDepth -= 1; i += 1; continue;
        }
      } else if (fr.untilCloseBrace) {
        if (c === '{') fr.braceDepth += 1;
        else if (c === '}') {
          if (fr.braceDepth === 0) {
            if (fr.bodyOf) { endBody(fr, i); continue; }
            return i;
          }
          fr.braceDepth -= 1;
        }
      }
      i += 1;
      continue;
    }

    if (fr.mode === 'jsxTag') {
      // Comments come FIRST. A `//` or `/* */` comment between attributes is valid TSX, and a
      // generator naturally emits one to explain an attribute. Without this branch the attribute-
      // value case below sees an apostrophe in the comment prose ("Griffel's") and treats it as a
      // quote — and that scanner deliberately does NOT stop at a newline, because a JSX attribute
      // value may legitimately span lines, so it ran to EOF. The real `export default` was blanked
      // and every bracket after it miscounted, which is the false-positive direction this file's
      // header calls the worse one: a complete page refused as truncated. #542.
      //
      // `/` in a tag is otherwise only the start of `/>`, and `n` distinguishes all three cases.
      if (c === '/' && n === '/') {
        const end = lineTerminatorStart(src, i);
        blank(i, end === -1 ? src.length : end);
        if (onComment) onComment(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end;
        continue;
      }
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        if (end === -1) fr.unterminated = true;
        blank(i, stop);
        if (onComment) onComment(i, stop);
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {                 // attribute value
        // Inside type arguments a quote starts a string LITERAL TYPE, scanned by TypeScript's rules — escapes, line continuations — where this
        // scan has none (`jsx-type-arguments`, see below).
        if (fr.angleDepth > 0 && onAmbiguity) onAmbiguity(fr.tagStart, 'jsx-type-arguments');
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += 1;
        if (j >= src.length) fr.unterminated = true;
        // A string that does not follow its `=` at once is another string to TypeScript than to the other compilers (`jsx-attribute`, see jsxStringEndsElsewhere).
        else if (fr.angleDepth === 0 && src[i - 1] !== '=' && onAmbiguity && jsxStringEndsElsewhere(src, i, j)) onAmbiguity(i, 'jsx-attribute');
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      // A template literal inside a tag can only be part of an explicit TYPE ARGUMENT, e.g.
      //   <Link<`https://${string}`> to={u} />
      // and its content is data, not code. Consuming it as one unit here is what keeps the `//`
      // in a template-literal *type* from being mistaken for the comment branch above — which
      // would blank to end of line and reject a valid module, and could also hide a genuinely
      // malformed expression that follows on the same line. Mirrors the `code`-mode scanner: the
      // body is blanked, and its end is found by the expression-aware scanner.
      if (c === '`') {
        // Always type arguments here (see above): a template literal TYPE, scanned by TypeScript's rules (`jsx-type-arguments`).
        if (onAmbiguity) onAmbiguity(fr.tagStart, 'jsx-type-arguments');
        openTemplate();
        continue;
      }
      if (c === '{') {
        // Inside type arguments a `{` opens an OBJECT type, not an attribute's expression, and its members are lexed as code
        // (`jsx-type-arguments`).
        if (fr.angleDepth > 0 && onAmbiguity) onAmbiguity(fr.tagStart, 'jsx-type-arguments');
        enterJsxExpr(fr, 'jsxTag');
        i += 1;
        continue;
      }
      // The `/` of a self-closing tag and its `>` are two tokens, with trivia between them — white space of every kind, line breaks and comments (parseJsxOpeningOrSelfClosingElementOrOpeningFragment:
      // parseExpected(SlashToken), then parseExpected(GreaterThanToken), https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts):
      //   <B/>     <B / >     <B /⏎>     <B / /* c */ >     <B x="1" /⏎// c⏎>
      // The comment branches above took `//` and `/*`, so this `/` is a token of its own. Where a `>` follows it past the trivia, that `>` ends the element and no text run follows (`selfClosingAt`); the trivia
      // is lexed as it is anywhere in a tag. Read as the end of an opening tag, that `>` took the text after it for the text of an element, and a closing tag in a string after it for the end of one.
      if (c === '/') {
        const close = skipSpaceAndComments(src, i + 1);
        if (src[close] === '>') fr.selfClosingAt = close;
        i += 1;
        continue;
      }
      // An explicit type argument (`<Table<Row> rows={r} />`) nests angle brackets inside the tag.
      // Without tracking that, the `>` of `<Row>` would end the tag early and the element would
      // never close, desynchronising the rest of the file. For names and their unions, arrays and nested arguments (`<DataGridRow<Account>`) this scan and TypeScript read the tag alike:
      // CERTAIN. They differ where the arguments hold a string or template type (escapes and line continuations, which a JSX attribute
      // has none of), an object type, or a function type (its `=>` is not an angle bracket):
      //   <Component<"quote\"\<LF>/*"> onClick={…} />
      // ends the string at `\"`, and the `/*` after it opens a comment over a real handler. Scanning TypeScript's types here would be a
      // second parser; the element is marked instead, at its own `<` (`jsx-type-arguments`).
      // But type arguments come only right after the tag's name (parser.ts, tryParseTypeArguments, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts). A `<` after an
      // attribute's `=` — with white space and comments between, which TypeScript's scanner skips before a value that is no quote right after the `=` (scanJsxAttributeValue) — is the
      // attribute's VALUE, an element or a fragment (parseJsxAttributeValue):
      //   <A x=<B/>>text</A>
      // Read as type arguments, the `/>` of `<B/>` ended the outer tag, `>text` was code, and a regex or string after it — which TypeScript reads as data — was read as code. The value is lexed
      // as the element it is (enterElementValue). Space after the `<`, or a name beyond ASCII, is not read as one here, as it is not where an expression starts (`jsx-open`).
      if (c === '<') {
        if (fr.angleDepth === 0 && prevSignificant(out, i).ch === '=') {
          if (/[A-Za-z_$>]/.test(n || '')) { enterElementValue(fr, i); i += 1; continue; }
          if (onAmbiguity) onAmbiguity(i, 'jsx-open');
        }
        fr.angleDepth += 1;
        i += 1;
        continue;
      }
      if (c === '>') {
        if (i === fr.selfClosingAt) {
          reportJsxTagEnd(fr, i);
          elementEnded(fr, i);
          i += 1;
          continue;
        }
        if (fr.angleDepth > 0) {
          if (src[i - 1] === '=' && onAmbiguity) onAmbiguity(fr.tagStart, 'jsx-type-arguments');
          fr.angleDepth -= 1;
          i += 1;
          continue;
        }
        reportJsxTagEnd(fr, i);
        fr.jsxDepth += 1;
        fr.mode = 'jsxText';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // mode === 'jsxText' — everything here is prose until a tag or an expression starts.
    if (c === '{') { enterJsxExpr(fr, 'jsxText'); i += 1; continue; }
    if (c === '<' && n === '/') {                   // closing tag
      const tag = readClosingTag(src, i);
      let end = tag.end;
      if (tag.kind === 'unread') {
        // Something stands in the tag that is no comment, no name and no `>`: `</A b>`, `</A "x">`, `</A{x}>`. TypeScript reports an error there, and the lexer does not know where such a tag
        // ends: the first `>` is taken, as it always was, and the guess is reported.
        if (onAmbiguity) onAmbiguity(i, 'jsx-open');
        end = src.indexOf('>', i);
      } else {
        // The comments in the tag are comments, blanked and heard like any other: a `>` in one ends nothing.
        for (const [from, to] of tag.comments) { blank(from, to); if (onComment) onComment(from, to); }
      }
      const stop = end === -1 ? src.length : end + 1;
      if (end === -1) fr.unterminated = true;
      else reportJsxTagEnd(fr, end);
      fr.jsxDepth = Math.max(0, fr.jsxDepth - 1);
      elementEnded(fr, end);
      i = stop;
      continue;
    }
    if (c === '<' && /[A-Za-z_$>]/.test(n || '')) { fr.mode = 'jsxTag'; fr.tagStart = i; i += 1; continue; }
    // A `<` in JSX text can only open an element, which JSX allows to be spelled with space after the `<` or a name beyond ASCII; this
    // lexer reads neither as one, and takes the `<` for text (`jsx-open`).
    if (c === '<' && onAmbiguity) onAmbiguity(i, 'jsx-open');
    blank(i, i + 1);
    i += 1;
  }
}

// Index of the `}` that closes the `${…}` whose body starts at `start`, or src.length. The body is
// lexed into `scratch` — a `src.split('')` the caller owns and whose blanks inside the body do not
// matter to it — or into a fresh copy when none is given. `onComment` hears the body's comments: they
// are real comments, so an elision marker or a comment inside an import there counts like any other.
function scanTemplateExpressionEnd(src, start, scratch, onComment) {
  return lexInto(src, scratch || src.split(''), start, { untilCloseBrace: true, onComment: onComment || null });
}

/**
 * Blank inert source while leaving executable JavaScript inside template `${...}` expressions.
 *
 * Raw shapes this must separate:
 *   `help: navigateTo({ pageId: "PAGEREF_x" })`          template TEXT, inert
 *   `${navigateTo({ pageId: "PAGEREF_x" })}`             template EXPRESSION, executable
 *   `${`nested ${navigateTo({ pageId: "PAGEREF_x" })}`}` nested expression, executable
 *   `${"navigateTo({ pageId: \"PAGEREF_x\" })"}`         string inside expression, inert
 *   `${/navigateTo\({ pageId: "PAGEREF_x" }\)/}`         regex inside expression, inert
 *   `${slash-star navigateTo({ pageId: "PAGEREF_x" }) star-slash real}` comments in expressions are inert
 *   `escaped \` and \${ text`                            escaped template text, inert
 *
 * `blankLiterals` intentionally blanks whole template bodies for declaration/bracket checks. The
 * navigation oracle needs a different view: template text is still data, but `${...}` is live code.
 * Both views come out of ONE lexing pass (lexInto's `keep` buffer), so every position judgment is the
 * one `blankLiterals` makes. Overlaying each body with a fresh lex of its own slice, recursively,
 * re-lexed a template nested n deep n times over — cubic: a valid 2.5 KB page of nested templates
 * took seconds.
 *
 * `opts.onComment(start, end)`, when given, hears every comment the pass meets — in code, in a JSX tag, and in a
 * template's `${…}` bodies — so a caller that needs to know where comments are does not lex the source a second
 * time. The navigation rules make no use of it: no comment is exempt from them, and a PAGEREF_ token in one is a stray.
 *
 * `opts.onAmbiguity(at, kind)`, when given, hears every place the lexer decided by heuristic what a `/` or `<` is, or how a construct is
 * scanned, where the grammar alone does not decide (see "Where a `/` or `<` is read by guess" for the kinds), with the offset of the `/`,
 * `<` or construct, in code, in JSX and in template bodies alike. The output is the same whether or not anyone listens.
 */
function blankNonCodePreservingTemplateExpressions(code, opts) {
  const src = String(code || '');
  const keep = src.split('');
  const onComment = opts && typeof opts.onComment === 'function' ? opts.onComment : null;
  const onAmbiguity = opts && typeof opts.onAmbiguity === 'function' ? opts.onAmbiguity : null;
  lexInto(src, src.split(''), 0, { keep, onComment, onAmbiguity });
  return keep.join('');
}

/**
 * True when `code` really exports a default binding.
 *
 * Two conditions, both required. (1) The match is in code, not in a string/comment/JSX text — that
 * is what blankLiterals gives us. (2) `export` begins a STATEMENT: at the start of a line, or right
 * after `;` or `}`. Without (2), ordinary prose in a failed worker response is accepted:
 *   "The worker says export default GeneratedComponent is required."
 * Real source always writes the keyword at a statement position.
 *
 * Both spellings count:
 *   export default <expr|function|class|async function>
 *   export { P as default }   /   export { default } from './x'
 */
// Identifiers may be non-ASCII (`Página`), so every name below is matched by Unicode property. White space is TypeScript's (WS, WS_SINGLE_LINE: see isTrivia), as everywhere in this file.
const DEFAULT_EXPORT = new RegExp(String.raw`(?:^${WS_SINGLE_LINE}*|[;}]${WS_SINGLE_LINE}*)export${WS_SINGLE_LINE}+default${WS}+[\p{ID_Continue}$({[*]`, 'gmu');
const NAMED_DEFAULT_EXPORT = new RegExp(String.raw`(?:^${WS_SINGLE_LINE}*|[;}]${WS_SINGLE_LINE}*)export${WS_SINGLE_LINE}*\{[^}]*\bdefault\b[^}]*\}`, 'm');
const EXPORT_MODIFIER = new RegExp(String.raw`^(async|abstract)\b${WS_SINGLE_LINE}*`);
const ARROW_CUT_OFF = new RegExp(String.raw`=>${WS}*$`);
const FUNCTION_HEAD = new RegExp(String.raw`^(?:async${WS}+)?function\b${WS}*\*?${WS}*(?:[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*)?${WS}*`, 'u');
const CLASS_HEAD = new RegExp(String.raw`^(?:abstract${WS}+)?class\b`);
const EXPORTED_NAME = new RegExp(String.raw`^([\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*)${WS_SINGLE_LINE}*(?:;|[\r\n\u2028\u2029]|$)`, 'u');
const EXPORTED_MEMBER_CHAIN = new RegExp(String.raw`^([\p{ID_Start}$_][\p{ID_Continue}$]*)(?:${WS}*\??\.${WS}*[\p{ID_Start}$_][\p{ID_Continue}$]*)+${WS_SINGLE_LINE}*$`, 'u');
const PARENTHESISED_FUNCTION_OR_CLASS = new RegExp(String.raw`^\(${WS}*(?:async${WS}+)?(?:function|class)\b`);
const RETURN_TYPE_COLON = new RegExp(String.raw`^${WS}*:`);
const DANGLING_CAST = new RegExp(String.raw`(?<![\p{ID_Continue}$])(?:as|satisfies|keyof)${WS}*$`, 'u');
function hasDefaultExport(code) {
  const bare = blankLiterals(code);
  if (NAMED_DEFAULT_EXPORT.test(bare)) return true;
  // Any complete one will do: TypeScript overloads declare the signature(s) before the body —
  //   export default function f(x: string): string;
  //   export default function f(x: any) { return x; }
  for (const m of bare.matchAll(DEFAULT_EXPORT)) {
    if (defaultExportIsComplete(bare, m.index + m[0].length - 1)) return true;
  }
  return false;
}

// A write cut off INSIDE its export statement still matches DEFAULT_EXPORT, and its brackets balance
// because the cut came before any was opened:
//   export default function GeneratedComponent(props)    the body never came
//   export default GeneratedComp                         cut mid-name
// So a function or class must reach its body, and a bare exported name must be one the module has.
// `at` is where the exported thing starts in `bare` (blanked code, so strings and comments are gone).
function defaultExportIsComplete(bare, at) {
  const rest = bare.slice(at);
  // `async` and `abstract` only modify what follows. Cut right after one, or inside the keyword it
  // modifies (`export default abstract clas`), the export is incomplete. Followed by `;` or a line
  // break instead, the word is a plain exported name (it is a legal identifier), handled below.
  const mod = EXPORT_MODIFIER.exec(rest);
  if (mod) {
    const after = rest.slice(mod[0].length);
    if (!trimTrivia(after)) return false;
    if (!/^(?:function|class)\b/.test(after) && !/^(?:;|[\r\n\u2028\u2029])/.test(after)) {
      // Only an async ARROW is left — `async (x) => …`, `async x => …` — and it needs its `=>` and body.
      return mod[1] === 'async' && /=>/.test(after) && !ARROW_CUT_OFF.test(after);
    }
  }
  const fn = FUNCTION_HEAD.exec(rest);
  if (fn) {
    // Type parameters come first and may hold parentheses of their own: `<T extends (a: A) => void>`.
    let k = fn[0].length;
    if (rest[k] === '<') k = skipTypeArguments(rest, k);
    while (k < rest.length && isTrivia(rest[k])) k += 1;
    if (rest[k] !== '(') return false;
    let depth = 0;
    for (; k < rest.length; k += 1) {
      if (rest[k] === '(') depth += 1;
      else if (rest[k] === ')') { depth -= 1; if (depth === 0) return hasDeclarationBody(rest, k + 1); }
    }
    return false;
  }
  const cls = CLASS_HEAD.exec(rest);
  if (cls) return hasDeclarationBody(rest, cls[0].length);
  const name = EXPORTED_NAME.exec(rest);
  if (!name) {
    // A member chain at EOF is syntactically complete: `export default UI.Spinner` and
    // `export default pages.Home` are valid exports whether the base is imported or local. A cut at
    // `React.memo` before its call is a known syntactically-complete limit documented for this gate;
    // only truly dangling `React.` / `React?.` tails stay rejected by DANGLING_TAIL below.
    const member = EXPORTED_MEMBER_CHAIN.exec(rest);
    if (member) return true;
    // So is an arrow's parameter list with the arrow cut off — `export default ()`,
    // `(props: { a: string })`, `(props): JSX.Element` of `export default (props) => <div/>;` —
    // when the group cannot be an expression: empty, spreading at its own level, annotating a type at
    // its own level, or followed by a return type (after a leading group a `:` can only start one; a
    // ternary needs its `?` first). Such a group is parameters, so an `=>` must follow. A ternary's
    // `:` inside the group is not an annotation, nor is a return type's, which follows `)`. A bare
    // `(props)` reads exactly like the valid `export default (GeneratedComponent)`, so it passes; so
    // does a parenthesized function or class.
    if (rest[0] === '(' && !PARENTHESISED_FUNCTION_OR_CLASS.test(rest)) {
      let depth = 0;
      let annotated = false;
      let ternary = false;
      let spread = false;
      for (let k = 0; k < rest.length; k += 1) {
        const c = rest[k];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') {
          if (--depth > 0) continue;
          if (c === ')') {
            const inner = trimTrivia(rest.slice(1, k));
            const params = !inner || spread || (annotated && !ternary) || RETURN_TYPE_COLON.test(rest.slice(k + 1));
            if (params && !/=>/.test(rest.slice(k + 1))) return false;
          }
          break;
        } else if (depth === 1 && c === '.' && rest.startsWith('...', k)) {
          spread = true;
          k += 2;
        } else if (depth === 1 && c === ':') {
          let p = k - 1;
          while (p >= 0 && isTrivia(rest[p])) p -= 1;
          if (rest[p] !== ')') annotated = true;
        } else if (depth === 1 && c === '?' && rest[k + 1] !== ':' && rest[k + 1] !== '.') ternary = true;
      }
    }
    // Any other expression — `memo(Page)`, `(props) => …`, `{ … }` — is taken as written (its brackets
    // are checked separately), unless it stops at a token that needs more: `React.`, `Page as`,
    // `cond ?`, `a &&`, an arrow's `=>`.
    return !DANGLING_TAIL.test(rest) && !DANGLING_CAST.test(rest);
  }
  // `export default GeneratedComponent;` — the module must declare or import the name.
  return declaresName(bare, name[1]);
}

// True when `name` is a local object binding. This is narrower than declaresName on purpose:
// `export default pages.Home` is complete when `pages` is an object literal, but `React.memo` at EOF
// is usually a truncated call on an imported namespace and remains rejected.
function declaresObjectName(bare, name) {
  const w = `(?<![\\p{ID_Continue}$])${name.replace(/\$/g, '\\$')}(?![\\p{ID_Continue}$])`;
  return new RegExp(`(?<![\\p{ID_Continue}$.])(?:const|let|var)${WS}+${w}${WS}*=${WS}*\\{`, 'u').test(bare);
}

// True when `bare` (blanked code) DECLARES or imports `name` — not merely mentions it:
//   const|let|var|function|class|enum|interface|type|namespace NAME
//   import NAME from …      import * as NAME from …      import { A as NAME, NAME } from …
//   const { a: NAME, NAME = 1, ...NAME } = …      const [NAME, , NAME] = …
// A parameter, a property or a call argument is not a binding the module can export — and neither is
// the `as` of `import * as React`, which let a write cut two characters into `export default async`
// pass as `export default as`.
function declaresName(bare, name) {
  const w = `(?<![\\p{ID_Continue}$])${name.replace(/\$/g, '\\$')}(?![\\p{ID_Continue}$])`;
  const direct = new RegExp(`(?<![\\p{ID_Continue}$.])(?:(?:const|let|var|class|enum|interface|type|namespace)${WS}+|function${WS}*\\*?${WS}*|import${WS}+(?:type${WS}+)?|\\*${WS}*as${WS}+)${w}`, 'u');
  if (direct.test(bare)) return true;
  for (const m of bare.matchAll(BINDING_GROUP)) {
    if (bindsInGroup(bare, m.index + m[0].length - 1, w, name)) return true;
  }
  // A later declarator of a list — `const Header = () => null, GeneratedComponent = () => null;` —
  // follows a `,` at the list's own depth, before its `;` (or the block that holds it closes). A
  // `const` declarator always has an initializer, so `, NAME` followed by neither `=` nor a type
  // annotation is not one. (A type with no `=` after it is a syntax error the build reports; a cut
  // cannot produce one, since the rest of the file still follows.) A `let` / `var` declarator may
  // stand alone, or assert `NAME!: T`. A later declarator may also be a pattern:
  // `const a = 1, { GeneratedComponent } = lib;`.
  const declarator = new RegExp(`${WS}*${w}${WS}*(?:!${WS}*:|[=:,;\\n]|$)`, 'uy');
  const constDeclarator = new RegExp(`${WS}*${w}${WS}*[=:]`, 'uy');
  const pattern = new RegExp(`${WS}*[{[]`, 'y');
  for (const m of bare.matchAll(DECLARATION_LIST)) {
    const re = m[1] === 'const' ? constDeclarator : declarator;
    let depth = 0;
    for (let k = m.index + m[0].length; k < bare.length; k += 1) {
      const c = bare[k];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) break; }
      else if (depth === 0 && c === ';') break;
      else if (depth === 0 && c === ',') {
        re.lastIndex = k + 1;
        if (re.test(bare)) return true;
        pattern.lastIndex = k + 1;
        if (pattern.test(bare) && bindsInGroup(bare, pattern.lastIndex - 1, w, name)) return true;
      }
    }
  }
  return false;
}

// `import { … }`, `import X, { … }`, `const { … }`, `const [ … ]`: the opening bracket of the group that may bind a name (declaresName). `matchAll` copies a global regex, so
// these constants carry no state between calls.
const BINDING_GROUP = new RegExp(String.raw`(?<![\p{ID_Continue}$.])(?:import|const|let|var)${WS}*(?:type${WS}+)?(?:[\p{ID_Start}$_][\p{ID_Continue}$]*${WS}*,${WS}*)?([{[])`, 'gu');
const DECLARATION_LIST = new RegExp(String.raw`(?<![\p{ID_Continue}$.])(const|let|var)${WS}`, 'gu');
const BINDING_END = new RegExp(String.raw`^${WS}*(?:[,}\]]|=(?![=>])|$)`);
const INDEX_COLON = new RegExp(String.raw`^${WS}*\]${WS}*:`);

// True when the import `{…}` or destructuring `{…}` / `[…]` opening at `open` binds the name `w`
// matches. A binding is followed by `,`, the closing bracket, a default `=` or nothing — so neither
// `NAME:` (a key), `NAME as X` (renamed away), the keywords of `{ A as B }` / `{ type A }`, nor a
// computed key `{ [NAME]: x }` counts; only in an array pattern does `]` end a binding.
function bindsInGroup(bare, open, w, name) {
  const close = matchingBracket(bare, open);
  if (close === -1) return false;
  const inner = bare.slice(open + 1, close);
  for (const hit of inner.matchAll(new RegExp(w, 'gu'))) {
    const after = inner.slice(hit.index + name.length);
    if (BINDING_END.test(after) && !INDEX_COLON.test(after)) return true;
  }
  return false;
}

// Index of the bracket that closes the `{` or `[` at `open`, or -1. Only that bracket kind is
// counted; `bare` is blanked, so none hides in a string or comment.
function matchingBracket(bare, open) {
  const o = bare[open];
  const c = o === '{' ? '}' : ']';
  let depth = 0;
  for (let k = open; k < bare.length; k += 1) {
    if (bare[k] === o) depth += 1;
    else if (bare[k] === c && --depth === 0) return k;
  }
  return -1;
}

// Index just past the `>` that closes the type-argument list opening at `k` (the `>` of an `=>`
// inside it does not count), or rest.length when none does.
function skipTypeArguments(rest, k) {
  let angle = 0;
  for (; k < rest.length; k += 1) {
    if (rest[k] === '<') angle += 1;
    else if (rest[k] === '>' && rest[k - 1] !== '=') { angle -= 1; if (angle === 0) return k + 1; }
  }
  return rest.length;
}

// Tokens after which a `{` opens an object TYPE, not the declaration's body:
//   (props): { id: string } {           the first group is the return type, the second the body
//   extends React.Component<{ id: string }> {    inside type arguments
//   (): A | { b: 1 } {    (): () => { c: 1 } {    (x): x is { d: 1 } {
const TYPE_EXPECTED = new Set([':', '|', '&', ',', '?', '=>', 'extends', 'implements', 'keyof', 'typeof', 'infer', 'is', 'asserts', 'readonly', 'unique']);
// A word that can only start a STATEMENT: met before the body, the declaration ended without one —
//   export default function GeneratedComponent()
//   if (ready) { … }
// (`new` and `import` are left out: both can appear in a type, `new () => T`, `import("./x").T`.)
const STATEMENT_WORDS = new Set(['if', 'else', 'try', 'catch', 'finally', 'for', 'while', 'do', 'switch', 'with', 'return', 'throw', 'break', 'continue', 'debugger', 'const', 'let', 'var', 'function', 'class', 'interface', 'enum', 'namespace', 'module', 'declare', 'export']);

// True when a declaration's body `{` follows `from` — after the parameter list of a function, or the
// `class` keyword. A `;`, a bare `=` or a statement keyword before it means the declaration ended
// without one.
function hasDeclarationBody(rest, from) {
  let paren = 0;
  let angle = 0;
  let bracket = 0;
  let prev = ')';                   // the token before `from`
  for (let k = from; k < rest.length; k += 1) {
    const c = rest[k];
    if (isTrivia(c)) continue;
    const nested = paren > 0 || angle > 0 || bracket > 0;
    if (c === '{') {
      if (!nested && !TYPE_EXPECTED.has(prev)) return true;
      // An object type (or a brace inside a type argument or parameter list): skip the whole group.
      let depth = 0;
      for (; k < rest.length; k += 1) {
        if (rest[k] === '{') depth += 1;
        else if (rest[k] === '}') { depth -= 1; if (depth === 0) break; }
      }
      if (k >= rest.length) return false;
      prev = '}';
      continue;
    }
    if (/[\p{ID_Continue}$]/u.test(c)) {
      let j = k;
      while (j < rest.length && /[\p{ID_Continue}$]/u.test(rest[j])) j += 1;
      prev = rest.slice(k, j);
      // A statement word — unless reached as a property of a qualified type: `(): Schema.module {`.
      let p = k - 1;
      while (p >= 0 && isTrivia(rest[p])) p -= 1;
      if (!nested && STATEMENT_WORDS.has(prev) && rest[p] !== '.') return false;
      k = j - 1;
      continue;
    }
    if (c === '=' && rest[k + 1] === '>') { prev = '=>'; k += 1; continue; }
    if (!nested && (c === ';' || c === '=')) return false;
    if (c === '(') paren += 1;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '<') angle += 1;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    prev = c;
  }
  return false;
}

/**
 * True when the brackets in `code` are unbalanced — the signature of a truncated write. Counted only
 * over code (blankLiterals removes strings, comments, regex literals and JSX text, so `1) Review`
 * and `/\(/` do not count). `<` / `>` are never counted: JSX and TypeScript generics make them
 * legitimately unbalanced.
 */
function hasUnbalancedBrackets(code) {
  const bare = blankLiterals(code);
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const ch of bare) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs[ch] && stack.pop() !== pairs[ch]) return true;
  }
  return stack.length > 0;
}

// A token that cannot end a module: an operator, `.` / `?.`, `,` / `?` / `:`, an arrow's `=>`, or a
// reserved word that needs what follows — an operand, or the rest of its statement (`export`,
// `const`, `function`, `if`, …). `x++` and `x!` can end one, and so can `>` (a JSX tag), `/` (the end
// of a regex) and `debugger`, so none of those is on the list. A word reached through `.` is a
// property (`counts.new`, `api.delete`), and `void` is left off because it is also a complete TYPE:
// `type Handler = (e: Event) => void`.
const DANGLING_TAIL = new RegExp(String.raw`(?:=>|\?\.|[.,?:=&|^~*%<]|(?<!\+)\+|(?<!-)-|(?<![\p{ID_Continue}$.])(?:new|typeof|delete|await|yield|in|instanceof|extends|export|import|default|const|let|var|function|class|interface|enum|return|throw|if|else|for|while|do|switch|case|try|catch|finally|with))${WS}*$`, 'u');

/**
 * True when `code` stops mid-statement: inside a string, template, comment or JSX element, or right
 * after a token that needs more. Every bracket balances in
 *   export default () => <div>Loading        const note = `unfinished        const total = count *
 * so hasUnbalancedBrackets cannot see these cuts. A complete module ends in plain code.
 */
function endsMidStatement(code) {
  const src = String(code || '');
  const out = src.split('');
  const regexEnds = new Set();
  const jsxTagEnds = new Set();
  let open = false;
  lexInto(src, out, 0, { onRegexEnd: (index) => regexEnds.add(index), onJsxTagEnd: (index) => jsxTagEnds.add(index), onEnd: (end) => { open = end.open; } });
  const bare = out.join('');
  return open || DANGLING_TAIL.test(bare) || hasDanglingFinalOperator(out, regexEnds, jsxTagEnds);
}

function hasDanglingFinalOperator(out, regexEnds, jsxTagEnds) {
  const { ch, index } = prevSignificant(out, out.length);
  if (ch === '>') return !jsxTagEnds.has(index);
  if (ch === '/') return !regexEnds.has(index);
  // A `!`, `++` or `--` that is a prefix operator (after a line break or where an expression starts) needs an operand; a postfix one ends one.
  if (ch === '!') return positionAfterPrefixable(out, index).expression;
  if ((ch === '+' || ch === '-') && out[index - 1] === ch && out[index - 2] !== ch) return positionAfterPrefixable(out, index - 1).expression;
  return false;
}

/**
 * The comments in TSX source, found by the same lexer as blankLiterals — so a `//` inside a string,
 * template or JSX text ("https://…", "a // b") is never taken for one.
 * @param {string} code
 * @returns {{ start: number, end: number, text: string }[]}
 */
function commentRanges(code) {
  const src = String(code || '');
  const ranges = [];
  blankLiterals(src, { onComment: (start, end) => ranges.push({ start, end, text: src.slice(start, end) }) });
  return ranges;
}

// The white space of a comment's JSDoc-style lines and of the markers below is TypeScript's, as everywhere in this file (WS, WS_SINGLE_LINE).
const COMMENT_LEADING_STAR = new RegExp(String.raw`^${WS_SINGLE_LINE}*\*+`, 'gm');
const TODO_OPENING_COLON = new RegExp(String.raw`^todo${WS}*:`, 'i');
const TODO_COLON = new RegExp(String.raw`\bTODO${WS}*:`);
const BARE_ELLIPSIS_LINE = new RegExp(String.raw`^${WS_SINGLE_LINE}*(\.\.\.|…)${WS_SINGLE_LINE}*$`, 'm');

/**
 * The first marker showing a generator ELIDED or DEFERRED code instead of writing it, or null. One rule
 * for every gate that asks "is this page complete?" — the genpage evals and the worker-output check
 * before a parallel page is accepted — so they cannot disagree about the same file.
 *
 * Raw shapes, each matched only where it can mean elision:
 *   // TODO: wire the save handler         a TODO/FIXME comment
 *   // ... rest of the component            a comment that opens with an ellipsis
 *   /* ... *\/                              the same, as a block comment
 *   ...                                     a bare line standing in for code
 * The same words in a string or JSX text are UI copy, never elision: "Loading…" and "Search
 * documents…" appear in committed samples and in real captured pages, and 'TODO' is an ordinary
 * status value on a task board.
 * @param {string} code
 * @returns {string|null}
 */
function findElisionMarker(code) {
  const src = String(code || '');
  for (const { text } of commentRanges(src)) {
    // The comment without its delimiters, or a JSDoc block's leading `*` on each line — so
    //   /**
    //    * TODO implement save
    //    */
    // opens with TODO, as `// TODO implement save` does.
    const body = trimTrivia(text.replace(/^\/\/+|^\/\*+|\*+\/$/g, '').replace(COMMENT_LEADING_STAR, ''));
    // FIXME is never prose, in any case. TODO is — a status on a task board ("board order: TODO ->
    // IN_PROGRESS -> DONE", "each todo: title, due date and owner") — so it counts only as a marker:
    // opening the comment (`// TODO wire paging`, or `// Todo:` in any case with its colon), or
    // written `TODO:` inside one.
    if (/\bfixme\b/i.test(body) || /^TODO\b/.test(body) || TODO_OPENING_COLON.test(body) || TODO_COLON.test(body)) {
      return 'a TODO/FIXME comment';
    }
    if (/^(\.\.\.|…)/.test(body)) return 'a comment that elides code (`// ...`)';
    // The one phrasing that only ever stands in for code. "The rest of the file/code" is not on this
    // list: "upload the rest of the file in 4 MB chunks" is how a file-handling page describes itself.
    if (/\bomitted for brevity\b/i.test(body)) return 'a comment that elides code ("omitted for brevity")';
  }
  // Comments and strings are blanked here, but executable `${...}` template bodies are kept: an
  // ellipsis inside an IIFE in a template is code, not template text. A line holding only `...`
  // always fails closed as a placeholder. The text alone cannot reliably distinguish every legal
  // multiline spread/rest from an elided block without a full parser, so generated code must write
  // the spread and operand together: `...rows`, not `...` followed by `rows` on the next line.
  if (bareEllipsisElidesCode(blankNonCodePreservingTemplateExpressions(src))) return 'a bare `...` line standing in for code';
  return null;
}

function bareEllipsisElidesCode(mask) {
  return BARE_ELLIPSIS_LINE.test(mask);
}
function ellipsisFollowedByStatement(mask, k) {
  if (!/[\w$]/.test(mask[k])) return false;
  let j = k;
  while (j < mask.length && /[\w$]/.test(mask[j])) j += 1;
  const word = mask.slice(k, j);
  return STATEMENT_WORDS.has(word) || word === 'import' || word === 'export';
}

module.exports = { blankLiterals, blankNonCodePreservingTemplateExpressions, commentRanges, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets, expressionPosition, opensTypeParameters, elementFailsAt, elementChildren, scanTemplateExpressionEnd, isLineTerminator, isTrivia, isSingleLineTrivia, trimTrivia, TRIVIA_CLASS, WS, AMBIGUITY_KINDS, ANGLE_AFTER, ANGLE_AFTER_LINE_BREAK, RESERVED_WORDS };
