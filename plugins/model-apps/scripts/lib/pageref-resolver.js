'use strict';
const { blankNonCodePreservingTemplateExpressions, isTrivia } = require('./source-literals.js');

// Pure STRUCTURAL resolver for generative-page cross-page navigation. Authors emit a link as a stable
// symbolic token — pageId: "PAGEREF_<key>" — because the real GenPageId is minted by the server at
// deploy time and differs per environment (SDK opaque-identity rule T5: never bake a resolved GUID into
// canonical source, or a cross-env recreate ships a dead link). See references/rules.md "Generative Page
// Navigation" and docs/app-builder-design.md §9. The ENGINE reads/writes files; this module
// only shapes/parses strings (pure, offline).
//
// THE SINGLE NAV ORACLE. `extractNavTargets` parses the ACTUAL
//   Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: <value>, … })
// call sites and returns one classified entry per generative call site. Every other function here, and
// the build/verify/download consumers, derive from it — so a decoy "PAGEREF_x" string or a stray GUID
// in a comment/label (NOT a real nav pageId) can never satisfy parity, resolution, or verification.
// This replaces the earlier bare-token string scan, which a wrong-quoted or misplaced token could evade.
//
// COMMENT / LITERAL STRIPPING (#588): extractNavTargets scans a code-only mask
// BEFORE scanning for navigateTo call sites. Anything inside a // comment, /* */ block comment, quoted
// string, regex literal, JSX text, or template-literal TEXT is blanked (same-length space substitution,
// preserving all character offsets) so a navigateTo that appears as help text is invisible to NAV_CALL.
// JavaScript inside template `${...}` expressions remains visible because it is executable code.
//
// The call's OBJECT is parsed from that same mask, and each value is then read from the ORIGINAL
// source at the same offsets. The mask blanks a string's contents but keeps its quotes, so it can
// locate `pageType: "…"` and `pageId: "…"` but not say what they hold. One lexer drives both steps:
// a lighter second copy that knew no regexes read the `/*` inside
//   u.replace(/\/*$/, "")
// as a comment opener, blanked everything after it, and dropped every later call — so a literal
// "PAGEREF_detail" shipped unresolved while verification passed.

// A navigation call can be bare, a member call, optional (`navigateTo?.({ … })`), or spell the
// identifier through JavaScript Unicode escapes (`navigate\u0054o`). A regex cannot distinguish
// that identifier from a longer one such as `notnavigateTo`, `x\u0041navigateTo`, or a name using
// ZWNJ/ZWJ continuation characters, so call-site discovery tokenizes identifiers before checking
// for the object-literal argument. The callee may also be parenthesised, the argument may be, and
// the member may be named by a string literal; those static spellings are found too, the parenthesised callee only where a call
// can start (parenBeginsExpression) — the plain `navigateTo({ … })` is the one to write:
//   (navigateTo)({ … })      navigateTo(({ … }))      Xrm.Navigation?.["navigateTo"]?.({ … })
//
// ONE VALUE, ONE LITERAL. A property value counts as a literal only when the COMPLETE value expression is
// exactly one string literal: the next significant token after it is `,` or the object's closing `}`.
// `"PAGEREF_detail".slice(8)` evaluates to "detail", and `"PAGEREF_detail" && "x"` to "x"; reading the quoted
// text alone and rewriting it changed what the call received. Anything else is dynamic or non-canonical: never
// rewritten, and a PAGEREF_ token inside it is reported as malformed like any other non-canonical form.
// The one thing allowed between the literal and that `,` or `}` is a TypeScript cast, `as T` or `satisfies T`
// (`"PAGEREF_detail" as const`): it is erased when the page is compiled, so the value is still the literal, and a
// rewrite replaces the literal and leaves the cast as written. See "A value is a literal when …" below for how a cast
// is told from an expression.
//
// STRAY TOKENS. A PAGEREF_<key> token that is not the canonical pageId of a recognised call ships as the literal
// string — a dead link. The ways to leave one are too many to enumerate (a string, a template, a comment, a variable a call
// reads, a call spelled some other way), so `strayPageRefs` states the invariant instead: every token is either rewritten,
// reported as malformed, or stray — and the build refuses a stray one. A token is allowed ONLY as the double-quoted pageId
// literal of a navigateTo call whose options object is written inline, and nowhere else: NOT IN A COMMENT EITHER. A comment exemption cannot
// be made sound without a parser — every form of it (any comment; a `//` comment; a `//` comment that starts its own line) was defeated:
// the `/*` inside a regex opens a false block comment, and a line that starts with `//` can sit inside a template literal that holds code
// that runs. A rule about comments needs a parser to know where the comments are, and there is none here.
// A lexer with no parser cannot rule out a misread of the source, so two things keep the invariant from resting on one:
//   - the TRUST FRONTIER (lexNavigation): the earliest offset where the lexer decided by guess what a `/` or `<` is, or how a
//     construct is scanned. No call that reaches it is trusted, and no token at or after it: they are stray whatever accounts for
//     them, in a comment or not, and are never rewritten — or turned back into a token by reverse resolution;
//   - the RESIDUAL NET (resolvePageRefs): after forward resolution the resolved page holds NO raw PAGEREF_ token at all, so any that
//     is left is reported. It is a plain scan of the text — no lexer, no exemption of any kind.
const CANON = /^"PAGEREF_([A-Za-z0-9_-]+)"$/;  // canonical: double-quoted, both sides
const PAGEREF_TOKEN = /PAGEREF_([A-Za-z0-9_-]+)/g; // a PAGEREF token in ANY form (read with matchAll, which clones it)
// Content must not span across unescaped quote chars — prevents matching a "foo"+"bar" concat
// as a single literal when the full expression is somehow presented as a raw string.
const QUOTED = /^(["'`])((?:[^"'`\\]|\\[\s\S])*)\1$/;

// Where a PAGEREF_ token may be, worded once for every report of one — the page build, the promotion gate, a fix-up — so each tells the
// author the same thing. The options object has to be written in the call: an object built in a variable is not recognised, and the
// token in it is reported like any other that is not where this says. No comment may hold a token: see STRAY TOKENS above.
const PAGEREF_RULE = 'a PAGEREF_<key> token is allowed only as the double-quoted pageId literal of a pageType:"generative" navigateTo call '
  + '(the options object written inline in the call — an object built in a variable is not recognised), and nowhere else — not in a comment';

// What a report tells the author about a token at or after the trust frontier (see lexNavigation): what the construct is that this check
// cannot read for certain, for each kind of ambiguity the lexer reports (source-literals.js, AMBIGUITY_KINDS; a test refuses a kind that has
// no wording here). The token may be exactly where the rule puts it — what has to change is the construct before it.
const AMBIGUITY_TEXT = {
  brace: 'a "/" or "<" right after a "}" may be a division or comparison after an object literal, or a regex or JSX element after a block',
  paren: 'a "/" or "<" right after a ")" may be a division or comparison after an operand, or a regex or JSX element after the head of an if, for or while, and the matching "(" is too far back to tell',
  keyword: 'a "/" or "<" right after a word that is a keyword in some places and a name in others (of, await, yield, type, as, get …) may be a division or comparison of that name, or a regex or JSX element after the keyword',
  angle: 'a "/" or "<" right after a ">" may be a division or comparison after type arguments or a JSX tag, or a regex or JSX element after a comparison',
  identifier: 'an identifier written with a \\u escape, or a name cut short by "#" or a character beyond ASCII, is not read as the word it spells',
  operator: 'a "/" right after "..." or a run of three "+" or "-" may be a division or a regex, a "<" right after a "<" and before a name (1<<n) may be a shift or an element, and a "<" that could open a generic right after ">=", ">>=" or ">>>=" (the first ">" may end type arguments), after a "<", after "in" or after "yield *" may be an element in a comparison, a test or a product, or the type parameters of an arrow or a function type',
  newline: 'a "/" or "<" on a later line than the operand before it may continue its statement — as a division or a comparison — or, after a type alias, an annotated declaration or an overload signature with no ";", begin the next one as a regex or a JSX element; a "/" after "throw" and a line break is the same question, and so is a "<" after "void" and a line break',
  'jsx-type-arguments': 'a JSX element with type arguments that hold a string, template, object or function type is read by the rules of a JSX tag, not by TypeScript\'s',
  'jsx-attribute': 'a JSX attribute value written after white space or a comment that follows its "=" is read by TypeScript as a string with escapes, and by other compilers without them, so they may disagree on where it ends when it holds a backslash; write the value right after the "="',
  'jsx-open': 'a "<" where an element may start, but that this check does not read as one (a space after it, a name beyond ASCII), may be a comparison or an element, and a closing tag that holds anything but a name and comments before its ">" (a second name, a string, a brace) is not read, so where it ends cannot be told',
  generic: 'a "<Name>" followed by a parameter list and a ":" may be the type parameters of a call signature or an element whose text starts with a parenthesis, and so may one followed by a parameter list and no return type when a string, a template, a comment or a regex after it could hold its closing tag "</Name>" or the text after it cannot be read to the end of an element; one followed by a parameter list and "=>" is a function type unless a nested tag, an attribute string or an expression container in the list holds the arrow, and this check cannot rule that out for every "<" or "{" there; "<await" and "<yield" may be type parameters or an element, by whether the function around them is async or a generator; and a parameter list too long to scan cannot be told at all',
  fallback: 'a quote with no closing quote on its line is read as an ordinary character, not as the start of a string, and a "/" after a character that begins nothing in code ("#", "@") has no grammar to ask',
};
const AMBIGUITY_REMEDY = 'this check cannot tell for certain how the code after it is read, so it does not trust a navigation call that reaches it, '
  + 'or a PAGEREF_ token at or after it; '
  + 'make the code before it unambiguous — put an operand in parentheses, ({ … }) / 2 or (/re/).test(text), or end the statement with a ";" — '
  + 'move the navigation call above it, or avoid the construct';

function isIdentifierStart(ch) {
  return ch === '$' || ch === '_' || /\p{ID_Start}/u.test(ch || '');
}

function isIdentifierContinue(ch) {
  return ch === '$' || ch === '_' || ch === '\u200c' || ch === '\u200d' || /\p{ID_Continue}/u.test(ch || '');
}

function readUnicodeEscape(src, i) {
  if (src[i] !== '\\' || src[i + 1] !== 'u') return null;
  if (src[i + 2] === '{') {
    const end = src.indexOf('}', i + 3);
    if (end === -1) return null;
    const hex = src.slice(i + 3, end);
    if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
    const cp = Number.parseInt(hex, 16);
    if (cp > 0x10ffff) return null;
    return { ch: String.fromCodePoint(cp), end: end + 1 };
  }
  const hex = src.slice(i + 2, i + 6);
  if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
  return { ch: String.fromCharCode(Number.parseInt(hex, 16)), end: i + 6 };
}

function readCodePoint(src, i) {
  const cp = src.codePointAt(i);
  if (cp === undefined) return null;
  return { ch: String.fromCodePoint(cp), end: i + (cp > 0xffff ? 2 : 1) };
}

function readIdentifier(src, i) {
  if (src[i] === '#') {
    const privateName = readIdentifier(src, i + 1);
    return privateName ? { name: `#${privateName.name}`, end: privateName.end } : null;
  }
  const firstEscape = readUnicodeEscape(src, i);
  const first = firstEscape || readCodePoint(src, i);
  if (!first || !isIdentifierStart(first.ch)) return null;
  let name = first.ch;
  let end = first.end;
  while (end < src.length) {
    const esc = readUnicodeEscape(src, end);
    const next = esc || readCodePoint(src, end);
    if (!next || !isIdentifierContinue(next.ch)) break;
    name += next.ch;
    end = next.end;
  }
  return { name, end };
}

// The white space in the mask is TypeScript's (isTrivia in source-literals.js), not JavaScript's `\s`, which lacks U+0085 and U+200B: a call written as
// `navigateTo<U+200B>(` is a call to TypeScript, and a reader that did not skip the character would not see it.
function skipSpace(mask, i) {
  while (i < mask.length && isTrivia(mask[i])) i += 1;
  return i;
}

// The matching bracket of every `{`, `(` and `[` in the mask and of every `}`, `)` and `]` — a closer's index at its opener's and the
// opener's at its closer's, -1 at a bracket with no partner and at anything else — computed ONCE per source. The mask has blanked
// comments and literal bodies, so every bracket here is code. Each kind has a stack of its own, so a stray `)` inside an object
// literal cannot unbalance its braces. A bracket group is then skipped in O(1) through this table: a call nested in another's
// `data` costs the outer call nothing, where copying and scanning it once per level made a chain of calls quadratic.
function matchBrackets(mask) {
  const match = new Int32Array(mask.length).fill(-1);
  const braces = [];
  const parens = [];
  const squares = [];
  const close = (stack, at) => {
    const open = stack.pop();
    if (open === undefined) return;
    match[open] = at;
    match[at] = open;
  };
  for (let i = 0; i < mask.length; i += 1) {
    switch (mask.charCodeAt(i)) {
      case 0x7b: braces.push(i); break;        // {
      case 0x7d: close(braces, i); break;      // }
      case 0x28: parens.push(i); break;        // (
      case 0x29: close(parens, i); break;      // )
      case 0x5b: squares.push(i); break;       // [
      case 0x5d: close(squares, i); break;     // ]
      default:
    }
  }
  return match;
}

// A `(` begins an expression of its own — rather than continuing the one before it — only after a token that cannot END an operand.
// They are listed, not excluded, because the tokens that can end one are many and easy to miss, and each of these makes
// `(navigateTo)(…)` an argument list that hands the object to a function that is not navigateTo:
//   factory!(navigateTo)({ … })                      `!` ends an operand: a non-null assertion
//   factory<unknown>(navigateTo)({ … })              `>` ends an operand: a generic instantiation
//   tag`x`(navigateTo)({ … })                        a back-tick ends an operand: a tagged template
//   function () { return f; }(navigateTo)({ … })     `}` ends an operand: a function expression — which the `}` of a block cannot be told from
// So the last token before the `(` must be the start of the source; `;` `{` `(` `[` `,` or `:`; a `?` that is a ternary (`?.` ends in
// a `.`); an operator that ends in `=` (`=` `==` `===` `!=` `!==` `+=` `<=` `>=` …); `=>`; or `&&`, `||` or `??`. Anything else is
// refused — a name or keyword, `)`, `]`, `.`, `?.`, `}`, `!`, any other `>`, a quote or a back-tick, `++`, `--`, the other operators —
// and the token in the call is reported as stray: the plain `navigateTo({ … })` is the one to write. Comments are blank in the
// mask, so they are not tokens.
function parenBeginsExpression(mask, at) {
  let i = at - 1;
  while (i >= 0 && isTrivia(mask[i])) i -= 1;
  if (i < 0) return true;
  switch (mask[i]) {
    case ';': case '{': case '(': case '[': case ',': case ':': case '?': case '=':
      return true;
    case '>': return mask[i - 1] === '=';
    case '&': case '|': return mask[i - 1] === mask[i];
    default: return false;
  }
}

// Whether the mask between `from` and `to` is a member chain and nothing more — `navigateTo`, `Xrm.Navigation.navigateTo`,
// `xrm?.Navigation?.["navigateTo"]`: identifiers joined by `.` and `?.`, or a computed member holding one string literal.
function isMemberChain({ mask, match }, from, to) {
  let i = skipSpace(mask, from);
  const head = readIdentifier(mask, i);
  if (!head || mask[i] === '#') return false;
  i = skipSpace(mask, head.end);
  while (i < to) {
    let computedAllowed = true;
    if (mask[i] === '?' && mask[i + 1] === '.') {
      i = skipSpace(mask, i + 2);
    } else if (mask[i] === '.') {
      i = skipSpace(mask, i + 1);
      computedAllowed = false;
    } else if (mask[i] !== '[') {
      return false;
    }
    if (computedAllowed && mask[i] === '[') {
      const close = match[i];
      const open = skipSpace(mask, i + 1);
      const quote = mask[open];
      if (close === -1 || (quote !== '"' && quote !== "'" && quote !== '`')) return false;
      let end = open + 1;
      while (end < close && mask[end] !== quote) end += 1;
      if (end >= close || skipSpace(mask, end + 1) !== close) return false;
      i = skipSpace(mask, close + 1);
    } else {
      const id = readIdentifier(mask, i);
      if (!id || mask[i] === '#') return false;
      i = skipSpace(mask, id.end);
    }
  }
  return i === skipSpace(mask, to);
}

// From the end of a callee's NAME to the `(` of its call (after an optional `?.`), or -1. The callee may stand in parentheses —
//   (navigateTo)({ … })     (Xrm.Navigation.navigateTo)?.({ … })     ((navigateTo))({ … })
// — but only when they wrap exactly the callee (a member chain that ends in the name) and begin an expression of their own, which
// parenBeginsExpression decides from an allowlist of the tokens before the `(`. A `)` after the name that closes anything else is not
// the callee's, and the call is not a navigation of that object:
//   factory(navigateTo)({ … })      the argument list of a call; the callee is whatever `factory` returns
//   (0, navigateTo)({ … })          a comma expression: the callee is its last operand, and may be any
// The mask has blanked comments, so `navigateTo /* c */ ( {` reads as `navigateTo ( {`.
function calleeCallOpen(context, nameEnd) {
  const { mask, match } = context;
  let i = skipSpace(mask, nameEnd);
  const closers = [];
  while (mask[i] === ')') { closers.push(i); i = skipSpace(mask, i + 1); }
  if (closers.length) {
    // Layer by layer: the innermost group holds exactly the callee, and each one outside it exactly the group inside it.
    let inner = match[closers[0]];
    if (inner === -1 || !isMemberChain(context, inner + 1, nameEnd)) return -1;
    for (let k = 1; k < closers.length; k += 1) {
      const open = match[closers[k]];
      if (open === -1 || skipSpace(mask, open + 1) !== inner || skipSpace(mask, closers[k - 1] + 1) !== closers[k]) return -1;
      inner = open;
    }
    if (!parenBeginsExpression(mask, inner)) return -1;
  }
  if (mask[i] === '?' && mask[i + 1] === '.') i = skipSpace(mask, i + 2);
  return mask[i] === '(' ? i : -1;
}

// From the `(` of a call to the `{` of the object literal that is its WHOLE first argument, or -1. The object may stand in
// parentheses and may carry type-only casts, but nothing else may touch it, because a token in anything else is not what the call
// receives:
//   navigateTo({ … })       navigateTo(({ … }))       navigateTo({ … } as const)       navigateTo({ … }, options)
//   navigateTo(({ … }).pageId.length === 14 ? a : b)    the object is read for its pageId, and which branch runs depends on it
//   navigateTo(({ … }, other))                          a comma expression: the argument is `other`
// So after the object come its casts, then the `)` of each parenthesis around it — each closing straight away, a cast outside them
// is not accepted — and then the argument must end: at a `,`, or at the `)` that closes the call.
function argumentObjectOpen(context, callOpen) {
  const { mask, match } = context;
  const callClose = match[callOpen];
  if (callClose === -1) return -1;
  const wrappers = [];
  let i = skipSpace(mask, callOpen + 1);
  while (mask[i] === '(') { wrappers.push(i); i = skipSpace(mask, i + 1); }
  if (mask[i] !== '{' || match[i] === -1) return -1;
  const open = i;
  let j = castTailsEnd(context, match[open] + 1, callClose);
  if (j === -1) return -1;
  for (let k = wrappers.length - 1; k >= 0; k -= 1) {
    j = skipSpace(mask, j);
    if (j !== match[wrappers[k]]) return -1;
    j += 1;
  }
  j = skipSpace(mask, j);
  return j === callClose || mask[j] === ',' ? open : -1;
}

// The value of the string literal src[from, to), quotes included, with JavaScript's escapes read as JavaScript reads
// them — or null when the text is not a complete literal or holds a malformed escape. Used for a quoted property
// name and for a computed member's name; never evaluates anything. A back-tick literal is accepted only when asked: it
// is a name for a member access, but not for a property key.
function decodeStringLiteral(src, from, to, allowBacktick = false) {
  const quote = src[from];
  if ((quote !== '"' && quote !== "'" && !(allowBacktick && quote === '`')) || src[to - 1] !== quote) return null;
  let value = '';
  for (let i = from + 1; i < to - 1; i += 1) {
    const c = src[i];
    if (c !== '\\') { value += c; continue; }
    i += 1;
    if (i >= to - 1) return null;
    const e = src[i];
    if (e === '\r' && src[i + 1] === '\n') { i += 1; continue; }
    if (e === '\n' || e === '\r' || e === '\u2028' || e === '\u2029') continue;
    if (e === 'u') {
      if (src[i + 1] === '{') {
        const close = src.indexOf('}', i + 2);
        if (close === -1 || close >= to - 1) return null;
        const hex = src.slice(i + 2, close);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
        const cp = Number.parseInt(hex, 16);
        if (cp > 0x10ffff) return null;
        value += String.fromCodePoint(cp);
        i = close;
        continue;
      }
      const hex = src.slice(i + 1, i + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
      continue;
    }
    if (e === 'x') {
      const hex = src.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (e === '0') { value += '\0'; continue; }
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', "'": "'", '"': '"', '\\': '\\' };
    value += Object.prototype.hasOwnProperty.call(simple, e) ? simple[e] : e;
  }
  return value;
}

// `Xrm.Navigation["navigateTo"]({ … })` names the method with a string literal. The mask blanks its body, so — as for a
// quoted property key — the name is read from the SOURCE at the offsets the mask gives. `at` is the `[`. Returns the
// index after the closing `]`, or -1 unless the brackets are a member access (they follow an expression, so an array
// literal or a computed key does not count) holding exactly one literal that decodes to `navigateTo`.
function staticNavigateNameEnd(mask, src, at) {
  let before = at - 1;
  while (before >= 0 && isTrivia(mask[before])) before -= 1;
  if (before < 0 || !/[\w$.)\]]/.test(mask[before])) return -1;
  const open = skipSpace(mask, at + 1);
  const quote = mask[open];
  if (quote !== '"' && quote !== "'" && quote !== '`') return -1;
  // "navigateTo" is ten characters, so even with an escape for each one the literal is far shorter than this bound;
  // it keeps a `[` before a long string from reading the whole string for nothing.
  let close = -1;
  for (let k = open + 1; k < mask.length && k <= open + 64; k += 1) {
    if (mask[k] === quote) { close = k; break; }
  }
  if (close === -1) return -1;
  const end = skipSpace(mask, close + 1);
  if (mask[end] !== ']') return -1;
  return decodeStringLiteral(src, open, close + 1, true) === 'navigateTo' ? end + 1 : -1;
}

// The `{` of every object-literal argument of a navigateTo call, with the `(` of the call that holds it, in the order the callees appear. Identifiers are read
// whole, so `notnavigateTo` and `x\u0041navigateTo` are other names; a `[` is checked as a computed member name. The call
// and its argument are judged by calleeCallOpen and argumentObjectOpen: a spelling is a navigation only when it is a call
// of navigateTo and the object is the whole of its first argument. The call's `(` is kept because a call is trusted only as far as ALL of
// it is: see analyzeNavigation.
function navigateCallObjectOpens(context) {
  const { mask, src } = context;
  const opens = new Map();
  const consider = (nameEnd) => {
    const callOpen = calleeCallOpen(context, nameEnd);
    const open = callOpen === -1 ? -1 : argumentObjectOpen(context, callOpen);
    if (open !== -1 && !opens.has(open)) opens.set(open, callOpen);
  };
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === '[') {
      const nameEnd = staticNavigateNameEnd(mask, src, i);
      if (nameEnd !== -1) consider(nameEnd);
      continue;
    }
    const id = readIdentifier(mask, i);
    if (!id) continue;
    if (id.name === 'navigateTo') consider(id.end);
    i = Math.max(i, id.end - 1);
  }
  return [...opens].map(([open, callOpen]) => ({ open, callOpen }));
}

// A value is a literal when it is exactly one string literal followed by NOTHING BUT TypeScript casts, in a SMALL grammar:
//   literal  ( `as const`  |  `as` Name  |  `satisfies` Name )*   and then the `,` or `}` that ends the value
//   Name     a plain or dotted ASCII identifier — `string`, `PageKey`, `Pages.Key` — with no type arguments, suffixes, unions or
//            literal types; `true`, `false`, `null` and `this` are only identifiers here
// `as T` and `satisfies T` are erased when the page is compiled and cannot change a value, and the const assertion is the form a
// generated page plausibly writes —
//   pageId: "PAGEREF_detail" as const
// — so refusing it would halt a valid build. See
//   https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions
//   https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html#const-assertions
//   https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator
// The grammar is positive and closed on purpose. TypeScript ends a cast's type at the first token no type can continue with, so
// anything after it — `.slice(1)`, `+ "x"`, `< limit > [0]` — is an expression, and a reader that tried to tell "more of the type"
// from "an expression" by shape was fooled: `as unknown as true < limit > [false][0]` is a comparison, and was rewritten as a cast.
// A name read whole and then the end of the value leaves nothing to tell. Whatever is outside it — a generic, a union, an array, a
// string-literal type, a function type — is not a literal even where TypeScript would erase it: the value is reported like any
// other non-canonical reference, never rewritten, and the author writes the literal alone. That includes a PAGEREF_ token inside
// a type, which the compiler erases but this check, reading the source, does not: a token is allowed only as the double-quoted
// pageId literal of a navigateTo call, and nowhere else — not in a comment.
const TYPE_NAME = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;

// TypeScript reads `as` and `satisfies` as operators only on the line of what they cast: in
//   "PAGEREF_detail"
//   as const
// the value has ended before the `as`, and the page does not compile. A comment that spans a line break counts, as it does to
// TypeScript.
function lineBreakBetween(src, from, to) {
  for (let i = from; i < to; i += 1) {
    const c = src.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// The end of the string literal that opens src[from, to) — or -1. The mask blanks a string's body, so the next quote of the
// same kind is the closing one. A back-tick body is read from the SOURCE: a `${` in it, even an escaped one, is the
// safe-side reading of a substitution, and a template with one is an expression, not a literal.
function stringLiteralEnd({ mask, src }, from, to) {
  const quote = mask[from];
  if (quote !== '"' && quote !== "'" && quote !== '`') return -1;
  let end = from + 1;
  while (end < to && mask[end] !== quote) end += 1;
  if (end >= to) return -1;
  if (quote === '`' && src.slice(from + 1, end).includes('${')) return -1;
  return end + 1;
}

// A cast name read whole — `as const` is the const assertion, and `as Name` or `satisfies Name` a type assertion — or -1. `const` is
// a name only as the whole of an `as` (never after `satisfies`, never qualified); anything else this expression does not match
// leaves its tokens behind for the caller to see that the value goes on.
function castNameEnd(mask, from, to, keyword) {
  TYPE_NAME.lastIndex = from;
  const name = from < to ? TYPE_NAME.exec(mask) : null;
  if (!name) return -1;
  if (name[0].split('.')[0] === 'const' && (keyword !== 'as' || name[0] !== 'const')) return -1;
  return from + name[0].length;
}

// Past every `as Name` / `satisfies Name` that follows `from`: the end of the last one, or `from` when none does. -1 when a cast
// keyword is not followed by a name. Whatever is left after the last cast is not read: it is the caller's to see that the value
// goes on.
function castTailsEnd(context, from, to) {
  const { mask, src } = context;
  let end = from;
  for (;;) {
    const at = skipSpace(mask, end);
    const id = at < to && !lineBreakBetween(src, end, at) ? readIdentifier(mask, at) : null;
    // The keyword as WRITTEN: a contextual keyword spelled with a Unicode escape is a plain identifier.
    const keyword = id ? mask.slice(at, id.end) : '';
    if (keyword !== 'as' && keyword !== 'satisfies') return end;
    const nameEnd = castNameEnd(mask, skipSpace(mask, id.end), to, keyword);
    if (nameEnd === -1) return -1;
    end = nameEnd;
  }
}

// The string literal that is the WHOLE value src[from, to), as { start, end } (the casts after it are outside that span, so a
// rewrite leaves them as written), or null when the value is anything else.
function literalValue(context, from, to) {
  const end = stringLiteralEnd(context, from, to);
  if (end === -1) return null;
  const tailsEnd = castTailsEnd(context, end, to);
  return tailsEnd !== -1 && skipSpace(context.mask, tailsEnd) >= to ? { start: from, end } : null;
}

// The LAST effective `pageType` and `pageId` members of the object literal whose `{` is at `open` and `}` at `close`,
// each as { valueStart, valueEnd, hasRuntimeOverrideAfter } or null. The spans are absolute offsets into the mask and,
// equally, into the source. Object literals are last-write-wins at runtime, including methods, accessors and
// shorthand properties:
//   { pageId: "PAGEREF_detail", get pageId() { return "runtime"; } }
//   { pageType: "generative", pageType() { return "entityrecord"; } }
// Later computed keys and spreads can also overwrite either property, so a literal before them is
// classified dynamic; a literal after them wins again by normal object order.
//
// A value is the COMPLETE expression: from after the colon to the `,` that ends the member (or the object's `}`),
// without the whitespace and comments around it. Whether that is ONE string literal is for the caller to judge, from the
// source text of the span (literalValue) — a literal followed by `.slice(8)` or `&& x` is not one, and one followed by a
// type-only cast (`as const`) is.
//
// One pass over the object's OWN members. A bracket group inside a member is jumped through the match table and a string
// through its closing quote, so nothing nested is read: a call nested in another's `data` is a candidate of its own and is
// scanned there, and each character is read by the innermost object that holds it, once. (Reading each candidate's whole
// text, and building the previous-non-blank table per key, made a chain of n nested calls cost n squared.)
function scanNavigationObject({ mask, src, match }, open, close) {
  const found = { pageType: null, pageId: null };
  // A spread or a computed key may overwrite either property; a method, accessor or shorthand member overwrites the
  // one it is named after.
  const overrideAll = () => {
    if (found.pageType) found.pageType.hasRuntimeOverrideAfter = true;
    if (found.pageId) found.pageId.hasRuntimeOverrideAfter = true;
  };
  const override = (name) => {
    const member = name === 'pageType' ? found.pageType : name === 'pageId' ? found.pageId : null;
    if (member) member.hasRuntimeOverrideAfter = true;
  };
  // The `,` that ends the member starting at `from`, or `close`. In the mask a string's body is blank, so the next quote of
  // the same kind closes it; a template's backticks pair up the same way, which skips its `${…}` bodies too.
  const memberEnd = (from) => {
    let k = from;
    while (k < close) {
      const ch = mask[k];
      if (ch === ',') return k;
      if (ch === '{' || ch === '(' || ch === '[') {
        const closer = match[k];
        k = closer === -1 || closer > close ? close : closer + 1;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        let end = k + 1;
        while (end < close && mask[end] !== ch) end += 1;
        k = end >= close ? close : end + 1;
      } else {
        k += 1;
      }
    }
    return close;
  };
  const readName = (at) => {
    const quote = mask[at];
    if (quote === '"' || quote === "'") {
      let end = at + 1;
      while (end < close && mask[end] !== quote) end += 1;
      if (end >= close) return null;
      return { name: decodeStringLiteral(src, at, end + 1), end: end + 1, quoted: true };
    }
    // From the MASK, like every other structural read: a comment is blank there, so a word inside one —
    // `/* keep pageId */` — never reads as a property. Read from the source, it was taken for a later
    // `pageId` and the call's real literal for an override.
    const id = readIdentifier(mask, at);
    return id ? { name: id.name, end: id.end, quoted: false } : null;
  };
  let i = open + 1;
  while (i < close) {
    i = skipSpace(mask, i);
    if (i >= close) break;
    // A member starts here, right after the `{` or the previous member's `,`.
    if (mask[i] === '.' && mask[i + 1] === '.' && mask[i + 2] === '.') { overrideAll(); i = memberEnd(i + 3) + 1; continue; }
    let k = i;
    if (mask[k] === '*') k = skipSpace(mask, k + 1);
    if (mask[k] === '[') { overrideAll(); i = memberEnd(k) + 1; continue; }
    let first = readName(k);
    let modifier = null;
    if (first && !first.quoted && (first.name === 'get' || first.name === 'set' || first.name === 'async')) {
      modifier = first.name;
      k = skipSpace(mask, first.end);
      if (mask[k] === '*') k = skipSpace(mask, k + 1);
      if (mask[k] === '[') { overrideAll(); i = memberEnd(k) + 1; continue; }
      first = readName(k);
    }
    if (!first) { i = memberEnd(i) + 1; continue; }
    k = skipSpace(mask, first.end);
    if (mask[k] === ':') {
      const valueStart = skipSpace(mask, k + 1);
      const end = memberEnd(valueStart);
      let valueEnd = end;
      while (valueEnd > valueStart && isTrivia(mask[valueEnd - 1])) valueEnd -= 1;
      if (first.name === 'pageType' || first.name === 'pageId') found[first.name] = { valueStart, valueEnd, hasRuntimeOverrideAfter: false };
      i = end + 1;
      continue;
    }
    if (mask[k] === '(') { override(first.name); i = memberEnd(k) + 1; continue; }
    if (!modifier) override(first.name);
    i = memberEnd(i) + 1;
  }
  return found;
}

// The offset where each line of `src` starts, to turn an offset into "line N, column M". A line ends at LF, CR LF or a
// lone CR — the terminators an editor counts — so the numbers match what a maker sees in the file.
function lineStarts(src) {
  const starts = [0];
  for (const m of src.matchAll(/\r\n|\r|\n/g)) starts.push(m.index + m[0].length);
  return starts;
}

// The 1-based line and column (in UTF-16 units, as an editor counts them) of offset `at`.
function locate(starts, at) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: at - starts[lo] + 1 };
}

// Every PAGEREF_<key> token in `src`, in source order, however it is written: { key, start, end }. This is a plain scan of the text and
// reads no lexer: it is what the residual net is, and the one place where "is there a token here" is decided.
function rawTokens(src) {
  const tokens = [];
  for (const m of src.matchAll(PAGEREF_TOKEN)) tokens.push({ key: m[1], start: m.index, end: m.index + m[0].length });
  return tokens;
}

// Every PAGEREF_<key> token in `src`, in source order, and each is counted: a token in a string, a template, a regex or JSX is data the
// page ships, and one in a comment is just as much a token — there is no comment exemption (see STRAY TOKENS). A token at or after the trust
// `frontier` — { at, kind }, see lexNavigation — carries it, so a report can say where the checker stopped being sure.
function pageRefTokens(src, frontier) {
  return rawTokens(src).map((token) => (frontier && token.start >= frontier.at ? { ...token, frontier } : token));
}

// Tokens as reported to a person: the token as written, its key, its offsets and where it is — and, for one at or after the trust frontier,
// the frontier: { start, kind, line, column }.
function withLocations(src, tokens) {
  const starts = lineStarts(src);
  return tokens.map((t) => ({
    token: `PAGEREF_${t.key}`,
    key: t.key,
    start: t.start,
    end: t.end,
    ...locate(starts, t.start),
    ...(t.frontier ? { frontier: { start: t.frontier.at, kind: t.frontier.kind, ...locate(starts, t.frontier.at), ...(t.frontier.reaches ? { reaches: true } : {}) } } : {}),
  }));
}

// The tokens starting in [from, to), as the half-open range [lo, hi) of indexes into `tokens` (which are in source order): two binary
// searches per candidate, however much lies between them. A value that holds another call holds that call's tokens too, so the ranges of
// nested values overlap, and copying each value's tokens would grow as n²/2 (n = 8,192: 33.5 million entries, 256 MiB): a value holds
// two indexes into the shared list instead.
function tokenRange(tokens, from, to) {
  const firstAtOrAfter = (at) => {
    let lo = 0;
    let hi = tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid].start < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return [firstAtOrAfter(from), firstAtOrAfter(to)];
}

// The mask of one source, every PAGEREF_ token in it, and the TRUST FRONTIER — { at, kind }, the earliest offset where the lexer decided
// by guess what a `/` or `<` is, or how a construct is scanned (source-literals.js, `onAmbiguity`), or null when it guessed nowhere —
// from a single lexing pass. After a block's `}` a `/` begins a regex, but after an object literal's it divides, and the two read alike;
// the lexer takes the regex reading, and where that is wrong it blanks code up to the next `/` and reads on in the wrong state. The same
// holds for every guess the lexer makes, and nothing short of a parser can tell which was wrong, so nothing at or after the earliest is
// trusted: pageRefTokens marks every token there, strayPageRefs reports each, and no consumer rewrites a call that reaches it.
function lexNavigation(src) {
  let frontier = null;
  const mask = blankNonCodePreservingTemplateExpressions(src, {
    onAmbiguity: (at, kind) => { if (!frontier || at < frontier.at) frontier = { at, kind }; },
  });
  return { mask, tokens: pageRefTokens(src, frontier), frontier };
}

// Everything the oracle reads from one source, computed once: the classified targets (in source order), the tokens and the frontier. A
// target says `afterFrontier: true` — and has no such property otherwise — when ANY part of its call lies at or after the frontier: its
// options object from the open brace to the close brace the lexer found, or the call that holds it, to its `)`. What a call means is read
// from the whole object (a later member can make `pageType` something else, and a guess can hide that member), so a call is trusted only
// as far as all of it is. Deciding by where the pageId lies rewrote a call whose object ran through a guess. The target is still
// classified — parity and the key list are as they were — and it is the callers that refuse to rewrite it or to turn an id back into it.
//
// Code-mask scanning (#588): call sites are found in a mask that blanks inert strings/comments/JSX
// text/template text but preserves executable template expressions. The object is parsed from the
// same mask (string bodies blanked, quotes kept) and every value is read from the original source at
// the span the mask gives. Both strings are the same length, so every span maps 1:1. The brackets of the
// mask are matched once, and each object is scanned for its own two members only (scanNavigationObject).
function analyzeNavigation(src) {
  const { mask, tokens, frontier } = lexNavigation(src);
  const context = { mask, src, match: matchBrackets(mask) };
  const targets = [];
  for (const { open, callOpen } of navigateCallObjectOpens(context)) {
    const close = context.match[open];
    if (close === -1) continue;
    // A recognised call has its `)` (argumentObjectOpen refuses one without), and the object lies inside it, so the call ends last.
    const reachesFrontier = frontier !== null && context.match[callOpen] >= frontier.at;
    const add = (target) => targets.push(reachesFrontier ? { ...target, afterFrontier: true } : target);
    const { pageType, pageId } = scanNavigationObject(context, open, close);
    if (!pageType) continue;
    // Only a pageType that is EXACTLY the string literal 'generative' makes this a generative navigation — `"generative" as
    // const` is that literal, as the casts are type-only. An expression such as `"generative" && "entityrecord"` evaluates to
    // another value, and one that merely CAN evaluate to 'generative' is not provably a cross-page link. Its PAGEREF_ token
    // is not rewritten — it is stray.
    const pageTypeValue = literalValue(context, pageType.valueStart, pageType.valueEnd);
    const pageTypeLiteral = pageTypeValue && QUOTED.exec(src.slice(pageTypeValue.start, pageTypeValue.end));
    if (!pageTypeLiteral || pageTypeLiteral[2] !== 'generative') continue;
    if (!pageId) continue;
    const { valueStart, valueEnd } = pageId;
    // Classify from the ORIGINAL source span: the mask blanks every string body, so a backtick-quoted
    // `PAGEREF_x` is found (and classified as pageref-malformed) only in `src`.
    const raw = src.slice(valueStart, valueEnd);
    if (pageType.hasRuntimeOverrideAfter || pageId.hasRuntimeOverrideAfter) {
      add({ kind: 'dynamic', raw, valueStart, valueEnd });
      continue;
    }
    // The span of a literal ends at the literal, so a rewrite leaves any type-only cast after it as written
    // (`"PAGEREF_x" as const` → `"<page id>" as const`); a value that is not a literal is spanned whole.
    const literal = literalValue(context, valueStart, valueEnd);
    const literalText = literal ? src.slice(literal.start, literal.end) : '';
    // The canonical form is anchored at both ends, so a literal with an expression tail (`"PAGEREF_x".slice(8)`) is not it.
    const canon = CANON.exec(literalText);
    if (canon) { add({ kind: 'pageref', key: canon[1], valueStart, valueEnd: literal.end }); continue; }
    // A PAGEREF token in any non-canonical form is malformed (single/back-tick quoted, concatenated, followed by an
    // expression tail, one branch of a conditional, held in a type) — the resolver can only substitute the canonical double-quoted
    // token, so a malformed one would ship UNRESOLVED — which is why the build halts on one (navMalformedRefs). `key` is the first
    // token's; `tokenFrom` and `tokenTo` are the range of ALL its tokens in the source's one token list (see tokenRange), which
    // navMalformedRefs reads so the report names each. A token in a comment inside the value is one of them: no comment is exempt.
    const [tokenFrom, tokenTo] = tokenRange(tokens, valueStart, valueEnd);
    if (tokenTo > tokenFrom) {
      add({ kind: 'pageref-malformed', key: tokens[tokenFrom].key, tokenFrom, tokenTo, raw, valueStart, valueEnd });
      continue;
    }
    // A literal is exactly one string literal (a back-tick template with a `${…}` substitution is an expression).
    const quoted = QUOTED.exec(literalText);
    if (quoted) {
      add({ kind: 'literal', pageId: quoted[2], quote: quoted[1], valueStart, valueEnd: literal.end });
      continue;
    }
    add({ kind: 'dynamic', raw, valueStart, valueEnd });
  }
  // Calls are found in the order their callees appear, but an outer call's pageId can follow a call nested in its data.
  // Rewriting right to left is correct only for targets in source order, so they are put in it here, once.
  targets.sort((a, b) => a.valueStart - b.valueStart);
  return { targets, tokens, frontier };
}

// Parse every generative navigateTo(...) call site into a classified pageId descriptor (see the module
// header). Spans are ABSOLUTE offsets into `code` so resolve/reverse can rewrite precisely and never
// partial-collide; the entries are in the order their values appear in the source. Only calls whose pageType is
// the string literal 'generative' are returned — a non-generative or dynamic pageType is not a cross-page genpage
// navigation.
function extractNavTargets(code) {
  return analyzeNavigation(String(code || '')).targets;
}

// The PAGEREF_ tokens of `code` that nothing accounts for: not the canonical pageId of a recognised call (which
// resolution rewrites) and not inside a value reported as malformed (which navMalformedRefs reports). Nothing else is exempt — a comment
// included. Each is { token, key, start, end, line, column }, in source order. A stray token ships as the literal string
// "PAGEREF_x" — a dead link — so the build refuses a page that holds one (see describePageRefLocations).
// A call that is not recognised, a token held in a variable, a string, a template or a comment, a pageType that is not a literal, and a
// value a runtime override can replace all leave one.
//
// A call is accounted for only if ALL of it lies before the trust frontier (see analyzeNavigation). A token at or after the frontier is
// stray whatever accounts for it, and so is the token of a call that reaches it, though the token itself lies before it. Both carry
// `frontier`, { start, kind, line, column } — and `reaches: true` for the second — saying where the source stops being read for certain
// (see lexNavigation).
function strayPageRefs(code) {
  const src = String(code || '');
  const { targets, tokens, frontier } = analyzeNavigation(src);
  // The spans a token may sit in and be accounted for, merged: a nested call's value can lie inside an outer one's. The value of a call
  // that reaches the frontier accounts for nothing, but a token in it is told apart from any other stray one.
  const accounted = [];
  const reaching = [];
  for (const target of targets) {
    if (target.kind !== 'pageref' && target.kind !== 'pageref-malformed') continue;
    const spans = target.afterFrontier ? reaching : accounted;
    const last = spans[spans.length - 1];
    if (last && target.valueStart <= last[1]) last[1] = Math.max(last[1], target.valueEnd);
    else spans.push([target.valueStart, target.valueEnd]);
  }
  const stray = [];
  let a = 0;
  let r = 0;
  for (const token of tokens) {
    if (!token.frontier) {
      while (a < accounted.length && accounted[a][1] <= token.start) a += 1;
      if (a < accounted.length && accounted[a][0] <= token.start) continue;
      while (r < reaching.length && reaching[r][1] <= token.start) r += 1;
      if (r < reaching.length && reaching[r][0] <= token.start) { stray.push({ ...token, frontier: { ...frontier, reaches: true } }); continue; }
    }
    stray.push(token);
  }
  return withLocations(src, stray);
}

// "PAGEREF_a (line 3, column 7), PAGEREF_b (line 9, column 21)": tokens as an error message names them, so the
// build, the promotion gate and a fix-up report a leftover the same way. A token at or after the trust frontier says where that is and what
// kind of guess it is: "PAGEREF_a (line 5, column 3, after the "brace" ambiguity at line 4, column 38)"; one in a call that reaches it, from
// before it: "PAGEREF_a (line 3, column 7, in a call that reaches the "brace" ambiguity at line 4, column 38)".
function describePageRefLocations(refs) {
  return refs.map((r) => {
    const where = r.frontier ? `${r.frontier.reaches ? ', in a call that reaches' : ', after'} the "${r.frontier.kind}" ambiguity at line ${r.frontier.line}, column ${r.frontier.column}` : '';
    return `${r.token} (line ${r.line}, column ${r.column}${where})`;
  }).join(', ');
}

// What a report of `strayPageRefs` entries tells the author to do. A token in the wrong place is removed or moved to where the rule
// allows one; a token after the trust frontier may be in the right place, and what has to change is the construct before it — each kind
// of construct present is described once, however many tokens follow it.
function pageRefAdvice(refs) {
  const advice = [];
  if (refs.some((r) => !r.frontier)) advice.push(`${PAGEREF_RULE}; remove it or move it there`);
  const kinds = [...new Set(refs.filter((r) => r.frontier).map((r) => r.frontier.kind))];
  if (kinds.length > 0) advice.push(`${kinds.map((kind) => AMBIGUITY_TEXT[kind]).join('; and ')} — ${AMBIGUITY_REMEDY}`);
  return advice.join('; and ');
}

// The first place the lexer guessed in `code` — { start, kind, line, column } — or null when it guessed nowhere (see lexNavigation).
function navigationFrontier(code) {
  const src = String(code || '');
  const { frontier } = lexNavigation(src);
  return frontier ? { start: frontier.at, kind: frontier.kind, ...locate(lineStarts(src), frontier.at) } : null;
}

// What a refusal that names no token says about a page with a frontier, or '' for a page with none. A call written after the frontier can be
// one this check never sees — the lexer read a regex or a comment over it — and an absent call is then reported with no cause: the parity
// halt says "declared-but-absent: [detail]", and the author, who can see the call, cannot act on it. The note names the guess, what
// it could be, and what to change.
function frontierNote(code) {
  const frontier = navigationFrontier(code);
  if (!frontier) return '';
  return `the page has a "${frontier.kind}" ambiguity at line ${frontier.line}, column ${frontier.column}, so a navigation call written after it may not be seen: ${AMBIGUITY_TEXT[frontier.kind]} — ${AMBIGUITY_REMEDY}`;
}

// Sorted-unique keys referenced by a CANONICAL nav pageref (the parity input). Derived from the
// oracle, so only real nav call sites count — a decoy PAGEREF_ string is never included.
function navReferencedKeys(code) {
  const keys = new Set();
  for (const t of extractNavTargets(code)) if (t.kind === 'pageref') keys.add(t.key);
  return [...keys].sort();
}

// Sorted-unique PAGEREF tokens used as a nav pageId in a MALFORMED form. The build HALTs on any:
// the resolver substitutes only the canonical double-quoted token, so a malformed ref would
// deploy a dead link. Derived from the oracle, so a malformed PAGEREF that is NOT a nav pageId is
// ignored here — strayPageRefs is the one that reports it.
function navMalformedRefs(code) {
  const bad = new Set();
  for (const token of malformedTokens(analyzeNavigation(String(code || '')))) bad.add(`PAGEREF_${token.key}`);
  return [...bad].sort();
}

// The tokens of every malformed value, each once, in source order — one traversal. Each malformed value holds a range of the source's token
// list, and the ranges of nested values are nested or disjoint and come in the order the values start, so a token an enclosing value has
// read is skipped, and each token is read once however deep the nesting goes.
function* malformedTokens({ targets, tokens }) {
  let readTo = 0;
  for (const target of targets) {
    if (target.kind !== 'pageref-malformed') continue;
    for (let i = Math.max(target.tokenFrom, readTo); i < target.tokenTo; i += 1) yield tokens[i];
    readTo = Math.max(readTo, target.tokenTo);
  }
}

// What resolvePageRefs rewrites, and what reverse resolution must write only where the forward path will: the canonical pageId of a call that
// lies wholly before the trust frontier (see analyzeNavigation). The one place the predicate is written.
const isRewritten = (target) => target.kind === 'pageref' && !target.afterFrontier;

// Resolve every source's CANONICAL nav pageref to a quoted GenPageId, structurally (span-based,
// applied in source order so earlier spans stay valid). Returns the resolved copies plus
//   unresolved — the sorted-unique referenced keys that had NO id (dangling nav targets), left verbatim so the
//                caller can HALT fail-closed;
//   residual   — every PAGEREF_ token still in a resolved copy, as { page, token, key, start, end, line, column } with the source's key as
//                `page` (and `frontier`, see strayPageRefs). The resolved page holds NO raw PAGEREF_ token at all, so any left — one the
//                rewrite did not reach (a dangling target, one anywhere a recognised call does not hold it, one in a call that reaches the
//                trust frontier) or one that was never in a call (a string, a comment) — would ship as the literal string, and a caller
//                that deploys the copies must refuse any (describePageRefLocations says where each is). It is a plain scan of the
//                RESOLVED text with no exemption and no lexer to mislead it: the lexer may read that text differently from the source,
//                and a token it hid is still there.
function resolvePageRefs(sources, keyToId) {
  const deployment = new Map();
  const unresolved = new Set();
  const residual = [];
  for (const [key, entry] of sources) {
    const code = entry && typeof entry.code === 'string' ? entry.code : '';
    // A call that reaches the trust frontier — at or after it in whole or in part (see analyzeNavigation) — is not rewritten: the lexer's
    // reading of what lies there is not certain, and the token it leaves is in the residue, where the caller refuses it. The page is left
    // half resolved on purpose.
    const { targets: found } = analyzeNavigation(code);
    const targets = found.filter(isRewritten);
    // The targets are in source order and their spans are disjoint literals, so the resolved copy is built in ONE pass:
    // replacing right to left copied the whole source once per target, which made a page with n calls cost n squared
    // (8,192 calls in 490 KB took 3 s).
    const pieces = [];
    let cursor = 0;
    for (const t of targets) {
      if (keyToId.has(t.key)) {
        pieces.push(code.slice(cursor, t.valueStart), JSON.stringify(String(keyToId.get(t.key))));
        cursor = t.valueEnd;
      } else {
        unresolved.add(t.key);
      }
    }
    pieces.push(code.slice(cursor));
    const out = pieces.join('');
    deployment.set(key, out);
    for (const ref of withLocations(out, lexNavigation(out).tokens)) residual.push({ page: key, ...ref });
  }
  return { deployment, unresolved: [...unresolved].sort(), residual };
}

// Download inverse: rewrite each nav pageId LITERAL whose value is a known deployed id back to its
// symbolic "PAGEREF_<key>". Structural (via the oracle) + span-based, so it NEVER touches a
// recordId, a data value, or a GUID in a comment — only an actual navigation pageId. Dataverse may
// echo the GUID upper- or lower-cased, so match case-insensitively.
//
// It writes a token only where it is sure of what it replaces:
//   - only a DOUBLE-quoted literal, which is what forward resolution writes. The quoting is never changed: a single-quoted or
//     back-ticked id is left as the id, because a token in the quotes it was found in is another string — the corruption was
//         const note = "*/ navigateTo({pageType:'generative', pageId:'<id>'}) /*";
//     where the lexer, misled by an earlier regex, read the text of a double-quoted string as code and the rewrite put
//     "PAGEREF_detail" inside it, ending the string;
//   - only in a call the checker trusts: one that lies wholly before the trust frontier (see lexNavigation and analyzeNavigation);
//   - only if the forward path takes what it writes. A token is usually longer than the id it replaces (`"<36 characters>"` against
//     `"PAGEREF_<a longer key>"`), so the code after it moves, and a window the lexer looks back or ahead over — the `(` of an `if` head is
//     looked for 2,000 characters back — can then end before the construct it is looking for: a head read for certain with ids is one read by
//     guess with tokens. The build and promotion then refuse a page the download wrote, with nothing said. So the result is read as the
//     forward path reads it (analyzeNavigation) and every token written must be the canonical pageId of a call it trusts — read as a
//     `pageref` with the key written, wholly before any frontier the result has. If one is not, NOTHING is written: the page keeps its ids, and every
//     known id in it is reported as `would-not-rebuild` (see rebuildRefusal), with the frontier to blame when there is one. A token the page
//     held before is not this check's business: only what reverse resolution writes decides.
// What it leaves is reported by what is in the RESULT, not by what it was sure of: `left` has an entry for every known id still in the
// result text, whatever it is there (see knownIdsLeft), so a call the lexer hid is reported like any other.
function reverseResolveNavIdsReport(code, idToKey) {
  const byLower = new Map([...(idToKey || new Map())].map(([id, key]) => [String(id).toLowerCase(), key]));
  const s = String(code || '');
  const original = analyzeNavigation(s);
  // One pass over targets in source order, as in resolvePageRefs: no span is copied around once per target. `written` says where each token
  // lands in the result, and which id it replaced in `s`, for the check on the result below.
  const pieces = [];
  const written = [];
  let cursor = 0;
  let grown = 0;
  for (const t of original.targets) {
    if (t.kind !== 'literal' || t.afterFrontier || t.quote !== '"' || !byLower.has(String(t.pageId).toLowerCase())) continue;
    const key = byLower.get(String(t.pageId).toLowerCase());
    const token = `"PAGEREF_${key}"`;
    pieces.push(s.slice(cursor, t.valueStart), token);
    written.push({ key, start: t.valueStart + grown, end: t.valueStart + grown + token.length, fromStart: t.valueStart, fromEnd: t.valueEnd });
    grown += token.length - (t.valueEnd - t.valueStart);
    cursor = t.valueEnd;
  }
  if (written.length === 0) return { code: s, left: knownIdsLeft(s, byLower, original) };
  pieces.push(s.slice(cursor));
  const result = pieces.join('');
  const rewritten = analyzeNavigation(result);
  const refusal = rebuildRefusal(rewritten, written);
  if (refusal === null) return { code: result, left: knownIdsLeft(result, byLower, rewritten) };
  // The page as it is, every id in it reported — a partly tokenised page would be refused by the build all the same — with the frontier told
  // in the coordinates of this page, not of the one that was not written.
  const frontier = refusal.frontier ? { kind: refusal.frontier.kind, ...locate(lineStarts(s), originalOffset(written, refusal.frontier.at)) } : null;
  return {
    code: s,
    left: knownIdsLeft(s, byLower, original).map(({ id, key, line, column }) => ({ id, key, line, column, why: 'would-not-rebuild', ...(frontier ? { frontier: { ...frontier } } : {}) })),
  };
}

// Whether the forward path takes every token that reverse resolution wrote into `analysis` (the result, as analyzeNavigation reads it), as
// the build takes one: resolvePageRefs rewrites a target for which `isRewritten` holds, and strayPageRefs accepts a token only there — a token
// at or after the frontier, or in a call that reaches it, is stray. A token is taken only if the forward path rewrites the target at the
// literal that was written, and reads the key that was written (a key with a `"` in it closes the string and is read as a shorter token, and a
// call that a frontier before it hid is not read at all). And it must not sit inside a value that is not the canonical literal: a call inside
// another call's pageId expression makes that value malformed, which the build halts on (navMalformedRefs). Returns null when every token is
// taken, or { frontier } when one is not: the result's earliest frontier where it is to blame — at or before a token, or reached by its call —
// or null when a token is refused for another reason.
function rebuildRefusal(analysis, written) {
  const { targets, frontier } = analysis;
  const targetAt = new Map();
  for (const target of targets) targetAt.set(target.valueStart, target);
  let refused = false;
  let blamed = false;
  for (const w of written) {
    const target = targetAt.get(w.start);
    if (target && isRewritten(target) && target.key === w.key) continue;
    refused = true;
    if (frontier && (w.start >= frontier.at || (target && target.afterFrontier))) blamed = true;
  }
  const generated = new Set(written.map((w) => w.start + 1)); // a token starts just after the opening quote of its literal
  for (const token of malformedTokens(analysis)) if (generated.has(token.start)) refused = true;
  return refused ? { frontier: blamed ? frontier : null } : null;
}

// The offset in the page as it was (before reverse resolution) of offset `at` in the result: each token written is longer or shorter than the
// id it replaced, so what lies after one has moved.
function originalOffset(written, at) {
  let moved = 0;
  for (const w of written) {
    if (w.end <= at) moved += (w.end - w.start) - (w.fromEnd - w.fromStart);
    else return w.start < at ? w.fromStart : at - moved;
  }
  return at - moved;
}

// Every place a known page id is still in `text`, in source order: { id, key, line, column, why }, with the id as written and its place in
// `text` (the result of reverse resolution, which is what a person opens). `why`:
//   'quote'    the literal pageId of a call the checker trusts, in quotes other than double ones;
//   'frontier' an id at or after the trust frontier, or in a call that reaches it — and `frontier`, { kind, line, column }, says where;
//   'text'     anything else: a record id or other data, a string, a comment, an object built in a variable.
// (A page that reverse resolution would not write — see rebuildRefusal — has every id reported as 'would-not-rebuild' by the caller.)
// The ids are found by scanning the text, so what the lexer recognised as a call does not limit it: a frontier can hide a call, and the
// id in it stays, with nothing recognised to report. The ids are matched whole — a longer run of id characters around one is not it — and
// whatever the case. `byLower` maps each id, lower-cased, to its key. `analysis` is analyzeNavigation(text) when the caller has it.
function knownIdsLeft(text, byLower, analysis) {
  const ids = [...byLower.keys()].filter((id) => id.length > 0).sort((a, b) => b.length - a.length);
  if (ids.length === 0) return [];
  const escaped = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const found = [...text.matchAll(new RegExp(`(?<![0-9A-Za-z_-])(?:${escaped.join('|')})(?![0-9A-Za-z_-])`, 'gi'))];
  if (found.length === 0) return [];
  // The result is read again, because what was rewritten is not what is left: the second reading is of the text the person gets.
  const { targets, frontier } = analysis || analyzeNavigation(text);
  const starts = lineStarts(text);
  const literals = targets.filter((t) => t.kind === 'literal');
  const left = [];
  let l = 0;
  for (const m of found) {
    const at = m.index;
    while (l < literals.length && literals[l].valueEnd <= at) l += 1;
    const literal = l < literals.length && literals[l].valueStart <= at ? literals[l] : null;
    const untrusted = frontier !== null && (at >= frontier.at || Boolean(literal && literal.afterFrontier));
    left.push({
      id: m[0],
      key: byLower.get(m[0].toLowerCase()),
      ...locate(starts, at),
      why: untrusted ? 'frontier' : literal && literal.quote !== '"' ? 'quote' : 'text',
      // `reaches`: the id lies before the frontier, but in a call that runs through it.
      ...(untrusted ? { frontier: { kind: frontier.kind, ...locate(starts, frontier.at), ...(at < frontier.at ? { reaches: true } : {}) } } : {}),
    });
  }
  return left;
}

// The rewritten source alone, for a caller that has no use for what was left.
function reverseResolveNavIds(code, idToKey) {
  return reverseResolveNavIdsReport(code, idToKey).code;
}

// Pure exact-parity between a page's DECLARED navigatesTo targetKeys and the keys its source
// actually references via canonical nav pagerefs. Exact parity is required: a declared edge
// missing from the source, or a source ref with no declaration, is an authoring error the caller
// HALTs on before deploy.
function navTargetParity(declaredKeys, referencedKeysList) {
  const d = new Set((declaredKeys || []).map(String));
  const r = new Set((referencedKeysList || []).map(String));
  return {
    declaredNotReferenced: [...d].filter((k) => !r.has(k)).sort(),
    referencedNotDeclared: [...r].filter((k) => !d.has(k)).sort(),
  };
}

module.exports = {
  extractNavTargets,
  navReferencedKeys,
  navMalformedRefs,
  resolvePageRefs,
  reverseResolveNavIds,
  reverseResolveNavIdsReport,
  navTargetParity,
  strayPageRefs,
  describePageRefLocations,
  pageRefAdvice,
  navigationFrontier,
  frontierNote,
  PAGEREF_RULE,
};
