'use strict';
// Finds the style keys Griffel drops at runtime in a generated page's `makeStyles` calls (AB#6691124).
//
// WHY THIS EXISTS. The pages use @fluentui/react-components, whose styles are Griffel's. Griffel does not support a few CSS shorthands: `resolveStyleRules` skips
// the property and, in the browser, logs
//   @griffel/react: You are using unsupported shorthand CSS property "borderWidth". Please check your "makeStyles" calls, there *should not* be following: ...
// Nothing earlier notices. The page type-checks, `pac model genpage transpile` does not execute `makeStyles`, and the deploy succeeds — the page then renders
// without the border, the colour or the reset the author wrote. The only guard used to be an agent grepping the page for `borderWidth`, which covers one of the
// ten properties and, as a text search, reads a string, a comment and an inline `style={{ … }}` the same as a style key.
//
// The set is Griffel's own UNSUPPORTED_CSS_PROPERTIES (packages/core/src/constants.ts in https://github.com/microsoft/griffel, read from @griffel/core 1.19 and
// 1.20): exactly these ten. Griffel's guide describes the limit for three of them, `borderColor`, `borderStyle` and `borderWidth`, and suggests its `shorthands.*`
// helpers (https://griffel.js.org/react/guides/limitations, "Some of CSS shorthands are not supported"); the page its runtime message points to is
// https://aka.ms/griffel-css-shorthands. Every other shorthand (`padding`, `margin`, `border`, `gap`, `borderRadius`, `outline`, …) IS supported
// and is not reported. The check is deliberately this narrow: a key Griffel accepts must never be refused.
//
// WHAT IS CHECKED, and what is not:
//   * `makeStyles({ <slot>: { <key>: <value>, … } })` — every key of every slot's style object, at any depth: `':hover'`, `'@media …'`, `'& .child'` and the other
//     nested selectors and at-rules are style objects too, and resolveStyleRules checks each (the check runs on the key alone, before the value is looked at).
//     The slot names themselves are not properties and are not checked: a slot may be called `all`.
//   * An object written inline in a spread — `...(narrow && { borderColor: 'red' })` — is a style object once Griffel has spread it, so it is read too.
//   * The value of `animationName` is NOT a style object: its keyframes are serialized as written (compileKeyframeRule), so `from: { borderColor: … }` is
//     fine there and is not reported.
//   * `makeResetStyles` is NOT checked, though the work item names it. Its keys are written to one CSS rule as they stand (resolveResetStyleRules →
//     createStringFromStyles, which never imports UNSUPPORTED_CSS_PROPERTIES), and the unsupported set is consulted only by resolveStyleRules, which makeStyles calls
//     and makeResetStyles does not — verified by running both over `borderColor: 'red'`: makeStyles drops it, makeResetStyles emits `border-color:red;`. Reporting
//     those keys would refuse a page that works. To check it too, add `['makeResetStyles', { slots: false }]` to STYLE_FUNCTIONS: its argument is one style object, with no slots.
//   * Inline React styles (`style={{ borderColor: … }}`) are not Griffel at all — the browser's own CSS handles them — and are not reported; rules.md recommends them.
//     `...shorthands.borderColor('red')` is Fluent's helper that expands to longhands; it is a call, not a key, and is not reported.
//   * The same names in a string, a comment, a template literal or a regex are text, not keys, and are not reported.
// The keys have to be written in the call. `makeStyles(styles)` — an object built elsewhere — is listed as `notRead`, not checked, and a spread of an object defined
// elsewhere (`...base`) or a style built by a helper function is not read either: the checker reports what it can see in the call and says nothing about what it cannot.
//
// WHICH `makeStyles`. The unaliased name; any name the page imports it under from a Griffel module (`import { makeStyles as ms } from '@fluentui/react-components'`);
// and `<ns>.makeStyles` for a namespace import of one. A `makeStyles` imported from anywhere else is somebody else's function and is left alone. A local function that
// happens to be named `makeStyles` and is not imported is not told apart from Griffel's — nothing in a page does that.
//
// HOW IT READS THE SOURCE. With the plugin's own lexer (source-literals.js), not a second tokenizer: blankLiterals gives a mask of the file in which every
// comment, string body, template, regex and run of JSX text is blank and every offset is the original's, so a key is found where code has one and a quoted key is
// read back from the source at the same offsets. The lexer is a lexer, not a parser, and where it guesses what a `/` or `<` is it says so (`onAmbiguity`): the checker
// takes the earliest such offset as a frontier — the trust frontier the navigation oracle uses (pageref-resolver.js) — and does not trust a call that reaches it, or
// a `makeStyles(` in the raw text at or after it that the mask shows as text, which a wrong guess may have blanked: see `unverifiable-style-call` below.
const { blankLiterals, blankNonCodePreservingTemplateExpressions, isTrivia, trimTrivia, WS } = require('./source-literals.js');

// Griffel's UNSUPPORTED_CSS_PROPERTIES, each with the longhands to write instead. The logical-property shorthands expand to the width, style and colour of
// each side, because those are the longhands CSS defines for them (border-block-start-width, …); `all` is every property, so it has no longhand list.
const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
const logical = (edge) => ['Width', 'Style', 'Color'].map((part) => `border${edge}${part}`);
const UNSUPPORTED_GRIFFEL_SHORTHANDS = new Map([
  ['all', []],
  ['borderColor', SIDES.map((side) => `border${side}Color`)],
  ['borderStyle', SIDES.map((side) => `border${side}Style`)],
  ['borderWidth', SIDES.map((side) => `border${side}Width`)],
  ['borderBlock', [...logical('BlockStart'), ...logical('BlockEnd')]],
  ['borderBlockStart', logical('BlockStart')],
  ['borderBlockEnd', logical('BlockEnd')],
  ['borderInline', [...logical('InlineStart'), ...logical('InlineEnd')]],
  ['borderInlineStart', logical('InlineStart')],
  ['borderInlineEnd', logical('InlineEnd')],
]);

// The packages that export Griffel's makeStyles: `@fluentui/react-components` re-exports it from `@griffel/react`, which wraps `@griffel/core`.
const GRIFFEL_MODULES = new Set(['@fluentui/react-components', '@griffel/react', '@griffel/core']);

// The Griffel functions whose style objects are read, by the name they are exported under. `slots` says the argument is an object of slots, each holding a style
// object (makeStyles); see the header for why makeResetStyles is not here.
const STYLE_FUNCTIONS = new Map([['makeStyles', { slots: true }]]);

const IDENTIFIER_SOURCE = '[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200c\\u200d]*';
const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const IDENTIFIER = new RegExp(IDENTIFIER_SOURCE, 'uy');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── Source positions ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// A line ends at LF, CR LF or a lone CR, and a column is in UTF-16 units, as an editor counts them, so a report names the place a maker sees in the file.
function lineStarts(src) {
  const starts = [0];
  for (const m of src.matchAll(/\r\n|\r|\n/g)) starts.push(m.index + m[0].length);
  return starts;
}
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

// ─── Reading the mask ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The matching bracket of every `{`, `(` and `[` and of every `}`, `)` and `]` (-1 where there is none), computed once. Each kind has its own stack, so a stray
// `)` cannot unbalance a brace. The mask holds no bracket from a string, comment, template or regex, so every bracket in it is code.
function matchBrackets(mask) {
  const match = new Int32Array(mask.length).fill(-1);
  const stacks = { '{': [], '(': [], '[': [] };
  const openOf = { '}': '{', ')': '(', ']': '[' };
  for (let i = 0; i < mask.length; i += 1) {
    const c = mask[i];
    if (stacks[c]) stacks[c].push(i);
    else if (openOf[c]) {
      const open = stacks[openOf[c]].pop();
      if (open !== undefined) { match[open] = i; match[i] = open; }
    }
  }
  return match;
}

function skipSpace(mask, i) {
  while (i < mask.length && isTrivia(mask[i])) i += 1;
  return i;
}
// The index of the last character before `i` that is not white space (the mask holds a comment as white space), or -1.
function previousSignificant(mask, i) {
  let j = i - 1;
  while (j >= 0 && isTrivia(mask[j])) j -= 1;
  return j;
}

function readIdentifier(mask, i) {
  IDENTIFIER.lastIndex = i;
  const m = IDENTIFIER.exec(mask);
  return m ? { name: m[0], end: i + m[0].length } : null;
}
// The identifier that ends right before `end`, as { name, start }, or null.
function identifierEndingAt(mask, end) {
  let start = end;
  while (start > 0 && ID_PART.test(mask[start - 1])) start -= 1;
  if (start === end || !ID_START.test(mask[start])) return null;
  return { name: mask.slice(start, end), start };
}
// The index just past the `>` that closes the type arguments whose `<` is at `i` (the `>` of an arrow `=>` is not one), or the end of the mask when they never close.
function skipTypeArguments(mask, i) {
  let depth = 0;
  for (let k = i; k < mask.length; k += 1) {
    if (mask[k] === '<') depth += 1;
    else if (mask[k] === '>' && mask[k - 1] !== '=') {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return mask.length;
}

// The value of the string literal src[from, to) — quotes included — with JavaScript's escapes read as JavaScript reads them, or null when it is not a complete
// literal or holds a malformed escape. A quoted key is read from the source, because the mask blanks every string body.
function decodeStringLiteral(src, from, to) {
  const quote = src[from];
  if ((quote !== '"' && quote !== "'" && quote !== '`') || src[to - 1] !== quote) return null;
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  let value = '';
  for (let i = from + 1; i < to - 1; i += 1) {
    const c = src[i];
    if (c !== '\\') { value += c; continue; }
    i += 1;
    const e = src[i];
    if (e === '\r' && src[i + 1] === '\n') { i += 1; continue; }
    if (e === '\n' || e === '\r' || e === '\u2028' || e === '\u2029') continue; // a line continuation adds no character
    if (e === 'x') {
      const hex = src.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      value += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else if (e === 'u') {
      if (src[i + 1] === '{') {
        const close = src.indexOf('}', i + 2);
        const hex = close === -1 ? '' : src.slice(i + 2, close);
        if (close === -1 || close >= to - 1 || !/^[0-9A-Fa-f]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
        value += String.fromCodePoint(parseInt(hex, 16));
        i = close;
      } else {
        const hex = src.slice(i + 1, i + 5);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
        value += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      }
    } else {
      value += Object.prototype.hasOwnProperty.call(simple, e) ? simple[e] : e;
    }
  }
  return value;
}

// ─── Which calls are Griffel's ──────────────────────────────────────────────────────────────────────────────────────────────────
// The names a page gives Griffel's style functions, from its import declarations. Shapes, in the mask (a module name is a blanked string there, so it is read from
// the source at the same offsets):
//   import { makeStyles, tokens } from '@fluentui/react-components';        → makeStyles
//   import { makeStyles as ms, type GriffelStyle } from '@griffel/react';   → ms
//   import * as Fluent from '@fluentui/react-components';                   → Fluent.makeStyles(…)
//   import { makeStyles } from './styles';                                  → not Griffel's: the bare name is somebody else's here
//   import './styles.css';   import('x');   import.meta                     → no names
// `local` maps a name to the function it is — the unaliased names unless the page imports THAT name from a module that is not Griffel's — and `namespaces` holds the
// local names of `import * as <ns>` from a Griffel module.
const FROM_QUOTE = new RegExp(`\\bfrom${WS}*(["'])`, 'g');
const NAMESPACE_IMPORT = new RegExp(`\\*${WS}*as${WS}+(${IDENTIFIER_SOURCE})`, 'u');
const AS_SEPARATOR = new RegExp(`${WS}+as${WS}+`);
const TYPE_PREFIX = new RegExp(`^type${WS}+(?=${IDENTIFIER_SOURCE})`, 'u');
function styleFunctionBindings(mask, src) {
  const local = new Map(STYLE_FUNCTIONS);
  const namespaces = new Set();
  const importRe = /\bimport\b/g;
  for (let m = importRe.exec(mask); m; m = importRe.exec(mask)) {
    const before = previousSignificant(mask, m.index);
    if (before >= 0 && mask[before] === '.') continue; // a property named import
    const clauseStart = skipSpace(mask, m.index + m[0].length);
    if (['(', '.', '"', "'"].includes(mask[clauseStart])) continue;
    // The clause runs to the `from` that is followed by the module's quote.
    FROM_QUOTE.lastIndex = clauseStart;
    const from = FROM_QUOTE.exec(mask);
    if (!from) continue;
    const clause = mask.slice(clauseStart, from.index);
    // A clause holds no `;` or `=`: a match that crossed one found the `from` of some later statement.
    if (/[;=]/.test(clause)) continue;
    const quoteAt = from.index + from[0].length - 1;
    const close = mask.indexOf(from[1], quoteAt + 1);
    if (close === -1) continue;
    const moduleName = decodeStringLiteral(src, quoteAt, close + 1);
    const griffel = moduleName !== null && GRIFFEL_MODULES.has(moduleName);
    const namespace = NAMESPACE_IMPORT.exec(clause);
    if (namespace && griffel) namespaces.add(namespace[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    if (!named) continue;
    for (const part of named[1].split(',')) {
      // `GriffelStyle`, `type GriffelStyle`, `makeStyles`, `makeStyles as ms`: the imported name, and the name it is bound to.
      const words = trimTrivia(part).replace(TYPE_PREFIX, '').split(AS_SEPARATOR);
      const imported = trimTrivia(words[0] || '');
      const bound = trimTrivia(words[1] || words[0] || '');
      if (!bound) continue;
      if (STYLE_FUNCTIONS.has(imported) && griffel) local.set(bound, STYLE_FUNCTIONS.get(imported));
      else if (STYLE_FUNCTIONS.has(bound)) local.delete(bound); // the bare name is bound to something that is not Griffel's
    }
  }
  return { local, namespaces };
}

// Whether the name at `at` is the name of a function declaration — `function makeStyles(…) {…}`, `function* makeStyles(…)` — which is not a call.
function declaresFunction(mask, at) {
  let end = previousSignificant(mask, at) + 1;
  if (end > 0 && mask[end - 1] === '*') end = previousSignificant(mask, end - 1) + 1;
  const word = identifierEndingAt(mask, end);
  return word !== null && word.name === 'function';
}

// Every call to a Griffel style function, as { spec, nameAt, callee, open, close, objectOpen, objectClose }: `nameAt` is where the function's name is and `callee`
// where the call starts (`Fluent.makeStyles(` starts at `Fluent`); `open` and `close` are the call's parentheses and `objectOpen` and `objectClose` the braces of the
// inline object that is its first argument — -1 where that is not an object literal, and `close` is -1 where the call is never closed. A name is read whole
// (`notmakeStyles` is another name) and as a member only of a Griffel namespace import (`this.makeStyles(…)` is not Griffel's). TypeScript type arguments are
// skipped: `makeStyles<'root'>({ … })`. A call with no argument reads nothing and is left out.
function styleFunctionCalls(mask, src, match) {
  const { local, namespaces } = styleFunctionBindings(mask, src);
  const calls = [];
  const names = new RegExp(IDENTIFIER_SOURCE, 'gu');
  for (let m = names.exec(mask); m; m = names.exec(mask)) {
    const name = m[0];
    // The name alone decides first: nearly every identifier of a page is something else, and each check below reads the text around it.
    if (!local.has(name) && !STYLE_FUNCTIONS.has(name)) continue;
    const prev = previousSignificant(mask, m.index);
    let spec;
    let callee = m.index;
    if (prev >= 0 && mask[prev] === '.' && mask[prev - 1] !== '.') {
      // `<ns>.makeStyles(` or `<ns>?.makeStyles(`. Three dots are a spread (`...makeStyles(…)`), handled as a bare name below.
      spec = STYLE_FUNCTIONS.get(name);
      const dot = mask[prev - 1] === '?' ? prev - 1 : prev;
      const receiver = identifierEndingAt(mask, previousSignificant(mask, dot) + 1);
      if (!spec || !receiver || !namespaces.has(receiver.name)) continue;
      // `a.ns.makeStyles(`: `ns` is a property of `a` there, not the namespace import.
      const beforeReceiver = previousSignificant(mask, receiver.start);
      if (beforeReceiver >= 0 && mask[beforeReceiver] === '.' && mask[beforeReceiver - 1] !== '.') continue;
      callee = receiver.start;
    } else {
      spec = local.get(name);
      if (!spec || declaresFunction(mask, m.index)) continue;
    }
    let k = skipSpace(mask, m.index + name.length);
    if (mask[k] === '<') k = skipSpace(mask, skipTypeArguments(mask, k));
    if (mask[k] !== '(') continue;
    const first = skipSpace(mask, k + 1);
    if (mask[first] === ')') continue;
    const objectOpen = mask[first] === '{' ? first : -1;
    calls.push({ spec, nameAt: m.index, callee, open: k, close: match[k], objectOpen, objectClose: objectOpen === -1 ? -1 : match[objectOpen] });
  }
  return calls;
}

// ─── Style objects ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The members of the object literal whose `{` is at `open`, as { name, nameAt, spread, valueFrom, valueTo }: `name` is the key where it is a name or a string literal
// (null for a computed key that is not one), `nameAt` where the key starts in the source, and [valueFrom, valueTo) the value — empty for a shorthand member
// (`{ borderColor }`), and the expression after the dots for a spread (`spread: true`, no name). Methods and accessors are skipped. Strings are blank in the mask, so the
// next quote of the same kind closes one.
function objectMembers({ mask, src, match }, open) {
  const close = match[open];
  // The `,` that ends the member starting at `from`, or `close`: a bracket group is jumped through the match table and a string through its closing quote.
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
  const members = [];
  let i = open + 1;
  while (i < close) {
    i = skipSpace(mask, i);
    if (i >= close) break;
    if (mask.startsWith('...', i)) {
      const end = memberEnd(i + 3);
      members.push({ name: null, nameAt: i, spread: true, valueFrom: i + 3, valueTo: end });
      i = end + 1;
      continue;
    }
    let name = null;
    let nameAt = i;
    let afterName = i;
    const quote = mask[i];
    if (quote === '"' || quote === "'") {
      let end = i + 1;
      while (end < close && mask[end] !== quote) end += 1;
      if (end >= close) break;
      name = decodeStringLiteral(src, i, end + 1);
      afterName = end + 1;
    } else if (quote === '[') {
      // A computed key. Only one that is a single string literal — `['borderWidth']`, or a template without a substitution — has a name. A template WITH a
      // substitution decodes to text that holds its `${`, which is never one of the ten names, so it needs no case of its own.
      const closer = match[i];
      if (closer === -1 || closer > close) { i = memberEnd(i) + 1; continue; }
      const inner = skipSpace(mask, i + 1);
      const q = mask[inner];
      if (q === '"' || q === "'" || q === '`') {
        let end = inner + 1;
        while (end < closer && mask[end] !== q) end += 1;
        if (end < closer && skipSpace(mask, end + 1) === closer) {
          const literal = decodeStringLiteral(src, inner, end + 1);
          if (literal !== null) { name = literal; nameAt = inner; }
        }
      }
      afterName = closer + 1;
    } else {
      const id = readIdentifier(mask, i);
      if (!id) { i = memberEnd(i) + 1; continue; }
      // `get x() {…}`, `set x(v) {…}`, `async x() {…}` are methods, whatever x is.
      if ((id.name === 'get' || id.name === 'set' || id.name === 'async') && isTrivia(mask[id.end])) {
        const next = skipSpace(mask, id.end);
        if (readIdentifier(mask, next) || mask[next] === '[' || mask[next] === '"' || mask[next] === "'" || mask[next] === '*') { i = memberEnd(i) + 1; continue; }
      }
      name = id.name;
      afterName = id.end;
    }
    const after = skipSpace(mask, afterName);
    if (mask[after] === ':') {
      const valueFrom = skipSpace(mask, after + 1);
      const end = memberEnd(valueFrom);
      members.push({ name, nameAt, spread: false, valueFrom, valueTo: end });
      i = end + 1;
    } else if (mask[after] === '(') {
      i = memberEnd(after) + 1; // a method
    } else if ((mask[after] === ',' || after >= close) && quote !== '"' && quote !== "'" && quote !== '[') {
      // `{ borderColor }`: an unquoted key whose value is the variable of the same name — still a key named borderColor.
      members.push({ name, nameAt, spread: false, valueFrom: after, valueTo: after });
      i = after + 1;
    } else {
      i = memberEnd(after) + 1;
    }
  }
  return members;
}

// The object literals written in [from, to): `{ … }` where an expression may start — after `(`, `,`, `[`, `:`, `?`, `=` or an operator — found through
// parentheses, brackets, a ternary and a cast, but not inside one another (each is read, in its turn, for the ones it holds). A `{` after `)`, after `=>` or after
// a word opens a block, not an object, and is skipped whole.
function objectsIn({ mask, match }, from, to) {
  const found = [];
  let k = from;
  while (k < to) {
    const c = mask[k];
    if (c === '"' || c === "'" || c === '`') {
      let end = k + 1;
      while (end < to && mask[end] !== c) end += 1;
      k = end + 1;
    } else if (c === '{') {
      const closer = match[k];
      if (closer === -1 || closer > to) break;
      const before = previousSignificant(mask, k);
      const prev = before < from ? '' : mask[before];
      const block = prev === ')' || (prev === '>' && mask[before - 1] === '=') || ID_PART.test(prev);
      if (!block) found.push(k);
      k = closer + 1;
    } else {
      k += 1;
    }
  }
  return found;
}

// A key's value as it is written, so that a key whose value CHANGED can be told from one that did not (griffelProblemsNotIn): whitespace is collapsed, a value that is one quoted string
// is read as the text it holds (so 'red' and "red" are one value, whichever quotes a page was saved with), and nothing else is evaluated — `tokens.colorBrandStroke1` is that text,
// whatever the token resolves to, and a variable is its name. A shorthand member (`{ borderColor }`) writes no value; its value is the variable of the same name, so it is that name.
function valueText({ mask, src }, member) {
  if (member.valueFrom === member.valueTo) return member.name;
  const from = member.valueFrom;
  let to = member.valueTo;
  while (to > from && isTrivia(mask[to - 1])) to -= 1; // the mask holds a comment as white space
  const quote = mask[from];
  // One string literal: it opens at `from`, and the first quote of its kind after it — a quote inside the body is blank in the mask — is the one that closes it at `to`.
  if ((quote === '"' || quote === "'") && mask.indexOf(quote, from + 1) === to - 1) {
    const text = decodeStringLiteral(src, from, to);
    if (text !== null) return JSON.stringify(text);
  }
  return src.slice(from, to).replace(/\s+/g, ' ');
}

// Every unsupported key under the object whose `{` is at `open`, depth first. `slotObject` is true for the object of slots, whose keys are slot names. `trail` is the names of
// the keys the object hangs under — the slot, then each selector or at-rule below it — and `findings` collects { name, at, longhands, within, value }, with `within` that trail (a spread, or a
// computed key that is not a string, is `...` or `[…]` in it): where a key is, apart from the line it is on, so that a page can be told from an earlier version of itself; and `value`, what
// it is set to (valueText), so that a key given another value is not taken for the same one.
function scanStyleObject(ctx, open, findings, slotObject, trail = []) {
  for (const member of objectMembers(ctx, open)) {
    if (!slotObject && !member.spread && member.name !== null && UNSUPPORTED_GRIFFEL_SHORTHANDS.has(member.name)) {
      findings.push({ name: member.name, at: member.nameAt, longhands: UNSUPPORTED_GRIFFEL_SHORTHANDS.get(member.name), within: trail, value: valueText(ctx, member) });
    }
    // Keyframes are not style objects (see the header), so an animation's frames are not read.
    if (member.name === 'animationName') continue;
    const here = [...trail, member.spread ? '...' : (member.name === null ? '[…]' : member.name)];
    for (const nested of objectsIn(ctx, member.valueFrom, member.valueTo)) scanStyleObject(ctx, nested, findings, false, here);
  }
}

// ─── What the lexer's reading may have hidden ───────────────────────────────────────────────────────────────────────────────────
// The offsets of a style function's name followed by `(` or `<` in the raw source at or after `from` that are not in `known` (the calls the mask showed). After the
// trust frontier a wrong guess may have blanked code up to the next `/`, a call included, so what the mask shows as text there may be a call; a name in a comment or a
// string that happens to be followed by `(` is reported with it, as the navigation oracle reports a token there whatever accounts for it (pageref-resolver.js).
function hiddenStyleCalls(src, names, from, known) {
  const alternatives = [...new Set(names)].map(escapeRegExp).join('|');
  const re = new RegExp(`(?<![\\p{ID_Continue}$\\u200c\\u200d])(?:${alternatives})(?![\\p{ID_Continue}$\\u200c\\u200d])${WS}*[(<]`, 'gu');
  re.lastIndex = from;
  const found = [];
  for (let m = re.exec(src); m; m = re.exec(src)) if (!known.has(m.index)) found.push(m.index);
  return found;
}

// ─── The result ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function shorthandMessage(name, longhands) {
  if (!longhands.length) {
    return `\`${name}\` is not supported by Griffel: it resets every property, and makeStyles drops it at runtime. Set the properties you need one by one instead.`;
  }
  return `\`${name}\` is not supported by Griffel: makeStyles drops it at runtime and the page renders without it. Write the longhands instead: ${longhands.join(', ')}.`;
}

const UNVERIFIABLE_REMEDY = 'Make the code before it unambiguous — put an operand in parentheses, ({ … }) / 2 or (/re/).test(text), or end the statement with a ";" — '
  + 'or move the makeStyles call above it.';

/**
 * The problems with the Griffel style calls of one page's source.
 * @param {string} source the page's TSX
 * @returns {{ calls: number, notRead: Array<{ line: number, column: number }>, frontier: null | { line: number, column: number, kind: string },
 *             problems: Array<{ code: string, property?: string, line: number, column: number, longhands?: string[], within?: string[], value?: string, message: string }> }}
 *   `calls` is how many makeStyles calls with an inline object were read; `notRead` lists the calls whose argument is not an object written in the call
 *   (`makeStyles(styles)`), which nothing here checks. A problem is
 *     `unsupported-shorthand` — a key Griffel drops, with the line and column of the key, the longhands to write, `within`: the slot, selectors and at-rules the key sits under
 *                               (`["root", ":hover"]`), and `value`: what the key is set to, as written (`"red"` for either quoting of the string red, `tokens.colorBrandStroke1` for an
 *                               expression — nothing is evaluated). Together they tell the same key, still there and set to the same, from a new or a changed one when a page is compared
 *                               with an earlier version of itself;
 *     `unverifiable-style-call` — the lexer guessed what a `/` or `<` was before the call or inside it, so a key in it cannot be said to be there or not (see the header);
 *     `unbalanced-style-call`   — the call's brackets do not balance, as in a page that is cut off.
 *   `frontier` is where the lexer first guessed, or null for a page it read without one.
 */
function griffelStyleProblems(source) {
  // A byte order mark is not a column of line 1 in an editor.
  const src = String(source == null ? '' : source).replace(/^\uFEFF/, '');
  // Two views of one lexing pass: the literal mask the checker reads (templates blanked whole, so nothing in one is a key and no call is read inside one), and the
  // ambiguity listener, which only the other entry point offers. The tokenization is the same with or without a listener (source-literals.js).
  const mask = blankLiterals(src);
  let guess = null;
  blankNonCodePreservingTemplateExpressions(src, { onAmbiguity: (at, kind) => { if (!guess || at < guess.at) guess = { at, kind }; } });
  const match = matchBrackets(mask);
  const ctx = { mask, src, match };
  const starts = lineStarts(src);
  const problems = [];
  const notRead = [];
  let read = 0;
  const calls = styleFunctionCalls(mask, src, match);
  for (const call of calls) {
    const at = locate(starts, call.callee);
    const unbalanced = call.close === -1 || (call.objectOpen !== -1 && call.objectClose === -1);
    // A call is read for certain only when ALL of it lies before the first guess: a guess inside it can hide a key, and one before it can have shifted where the
    // call starts and ends. What the lexer was not sure of is not reported as clean. A call that never closes counts as reaching it: a wrong guess blanks code up to
    // the next `/`, closing bracket included, so with a guess on the page the unbalance is as likely the lexer's as the page's.
    if (guess && (unbalanced || call.close >= guess.at)) {
      const where = locate(starts, guess.at);
      problems.push({
        code: 'unverifiable-style-call',
        ...at,
        message: `the makeStyles call here cannot be checked for certain: the checker cannot tell how the page is read from line ${where.line}, column ${where.column} on (a "/" or "<" there it could read two ways — kind "${guess.kind}"), and this call lies at or after it. ${UNVERIFIABLE_REMEDY}`,
      });
      continue;
    }
    if (unbalanced) {
      problems.push({ code: 'unbalanced-style-call', ...at, message: 'the makeStyles call here is never closed: its brackets do not balance, so the page is cut off or malformed. Finish the call and check again.' });
      continue;
    }
    if (call.objectOpen === -1) { notRead.push(at); continue; }
    read += 1;
    const findings = [];
    scanStyleObject(ctx, call.objectOpen, findings, call.spec.slots);
    for (const f of findings) {
      problems.push({ code: 'unsupported-shorthand', property: f.name, ...locate(starts, f.at), longhands: f.longhands, within: f.within, value: f.value, message: shorthandMessage(f.name, f.longhands) });
    }
  }
  if (guess) {
    const known = new Set(calls.map((call) => call.nameAt));
    const { local } = styleFunctionBindings(mask, src);
    for (const nameAt of hiddenStyleCalls(src, [...local.keys(), ...STYLE_FUNCTIONS.keys()], guess.at, known)) {
      const where = locate(starts, guess.at);
      problems.push({
        code: 'unverifiable-style-call',
        ...locate(starts, nameAt),
        message: `a makeStyles call may be here, but the checker cannot tell for certain that this is code: it cannot tell how the page is read from line ${where.line}, column ${where.column} on (a "/" or "<" there it could read two ways — kind "${guess.kind}"). ${UNVERIFIABLE_REMEDY}`,
      });
    }
  }
  problems.sort((a, b) => a.line - b.line || a.column - b.column);
  return { calls: read, notRead, frontier: guess ? { ...locate(starts, guess.at), kind: guess.kind } : null, problems };
}

// The problems of one file as the text a refusal carries — `<file>:<line>:<column>: <message>`, one per problem — so a halt names where each one is and the
// longhands to write there. One wording for the one defect: the build's halt and genpage-upload.js's refusal both use it, and both end by naming the checker.
function describeGriffelProblems(problems, file) {
  return problems.map((p) => `${file}:${p.line}:${p.column}: ${p.message}`).join(' ');
}

// ─── A page against the version that is already deployed ─────────────────────────────────────────────────────────────────────────
// The check is held against what a run is about to SHIP. A page that is already deployed with a key Griffel drops — written by an earlier version of the plugin, whose only guard
// was a grep for `borderWidth`, so `borderColor` under `:hover` passed — shipped it before this check existed, and sending the same bytes again ships nothing new. Refusing it would
// stop a rebuild, or an edit, over a defect the maker did not touch, and the way out would change how the page looks: those declarations never applied, so writing the longhands makes
// them start to. Only a key the deployed page did not already have is held back; a page that is created, or whose source changed, is held to the whole check (sdk-build.js and
// genpage-upload.js decide which a page is), and what is let through is said, with both ways out.
const isShorthandProblem = (problem) => problem.code === 'unsupported-shorthand';

/**
 * Which of `problems` the page's deployed version already had. `deployed` is that version's problems (griffelStyleProblems of the source that was deployed). A key counts as already
 * there when the deployed page has the same key set to the same value in the same place (`within`: the slot, selectors and at-rules it sits under) and, failing that, the same key set to
 * the same value anywhere that nothing else has claimed — so a slot that was renamed, or a rule that was moved, does not turn a key Griffel was already dropping into a new one. A key given
 * ANOTHER value is a new one: Griffel drops it just the same, so the page would show none of the change the maker meant, which is what this check exists to stop (a value is compared as
 * written — `value` of the problem — and nothing is evaluated). Each key of the deployed page is spent once, so a second `borderColor` where there was one is new. A problem that is not a
 * shorthand — a call the checker cannot read — is never "already there": what it hides cannot be compared with anything.
 * @returns {{ added: object[], inherited: object[] }} the problems the deployed page did not have, and those it did, each in source order
 */
function griffelProblemsNotIn(problems, deployed) {
  const keyOf = (p) => `${p.property}\u0001${p.value}`;
  const placeOf = (p) => `${(p.within || []).join('\u0000')}\u0001${keyOf(p)}`;
  const inPlace = new Map();
  const anywhere = new Map();
  const spend = (map, key, by) => map.set(key, (map.get(key) || 0) + by);
  for (const d of deployed || []) {
    if (!isShorthandProblem(d)) continue;
    spend(inPlace, placeOf(d), 1);
    spend(anywhere, keyOf(d), 1);
  }
  const added = [];
  const inherited = [];
  const unplaced = [];
  for (const p of problems) {
    if (!isShorthandProblem(p)) added.push(p);
    else if ((inPlace.get(placeOf(p)) || 0) > 0) {
      spend(inPlace, placeOf(p), -1);
      spend(anywhere, keyOf(p), -1);
      inherited.push(p);
    } else unplaced.push(p);
  }
  for (const p of unplaced) {
    if ((anywhere.get(keyOf(p)) || 0) > 0) { spend(anywhere, keyOf(p), -1); inherited.push(p); } else added.push(p);
  }
  const bySource = (a, b) => a.line - b.line || a.column - b.column;
  return { added: added.sort(bySource), inherited: inherited.sort(bySource) };
}

// What each way out of a dropped key does to the page. Both are a choice about how it looks, and a message that names only the longhands steers a maker who meant to keep a page as
// it is into changing it: Griffel never applied the key, so deleting it changes nothing on screen, while the longhands DO apply.
const SHORTHAND_REMEDIES = 'Deleting a key changes nothing on screen, because Griffel never applied it; writing the longhands (for `all`, the properties you want) '
  + 'makes the style start to render, which changes how the page looks.';

// The wording that differs between the two places the check is held, so that one defect has one text: the build's pages phase (a page of the App Spec) and genpage-upload.js (a file).
const SURFACES = {
  build: { lead: ' — ', where: 'the page\'s source', rerun: 're-run.' },
  upload: { lead: ' — refusing to upload. ', where: 'the file', rerun: 're-run the upload.' },
};

/**
 * The text of a halt or a refusal: `problems` of one file, which the run does not go on with.
 * @param {object[]} problems  what griffelStyleProblems (or griffelProblemsNotIn) found, never empty
 * @param {string} file        the file their positions are in
 * @param {object} o
 * @param {'build'|'upload'} o.surface  who is speaking (SURFACES)
 * @param {string} o.subject   what the sentence starts with: `page "Detail"`, or the path of the file
 * @param {string} o.command   the checker command that lists every problem, with its path quoted as a shell needs it
 * @param {string} [o.note]    one more sentence before the way on, such as why this page is held to the check
 * A key Griffel drops is worded as such, with both ways out (SHORTHAND_REMEDIES). A call the checker could not read is NOT said to write CSS Griffel drops — it may not — but to be one
 * the check could not read, with what to change in the code; where a page has both, the keys come first.
 */
function describeGriffelRefusal(problems, file, { surface, subject, command, note = '' }) {
  const words = SURFACES[surface];
  const shorthands = problems.filter(isShorthandProblem);
  const unreadable = problems.filter((p) => !isShorthandProblem(p));
  const noteText = note ? `${note} ` : '';
  if (!shorthands.length) {
    return `${subject} has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime${words.lead}${describeGriffelProblems(unreadable, file)} `
      + `${noteText}Change ${words.where} as that says (\`${command}\` shows what it cannot read), then ${words.rerun}`;
  }
  const alsoUnreadable = unreadable.length
    ? ` It also has makeStyles calls the check could not read, so it cannot tell whether they hold more: ${describeGriffelProblems(unreadable, file)}`
    : '';
  return `${subject} writes CSS that Griffel drops at runtime, so the page would deploy without it${words.lead}${describeGriffelProblems(shorthands, file)} ${SHORTHAND_REMEDIES}${alsoUnreadable} `
    + `${noteText}Fix ${problems.length === 1 ? 'it' : 'them'} in ${words.where} (\`${command}\` lists every one), then ${words.rerun}`;
}

// Why a run goes on with a page that has problems (`why`, the sentence that follows its subject), and what the check will do about the page from then on (`next`, the end of the
// warning). `unchanged` and `unrecorded` are the build's: the page is an update, and either its source is the one the last build recorded for it, or there is no record to say (a
// workspace that is new, moved or was cleared) — and the page exists in the environment, so an earlier build deployed it as it is, which is the behaviour a run must not take away.
// `inherited` and `undetermined` are genpage-upload.js's: the deployed page it downloads had these keys, or could not be read to compare with (only under --overwrite-deployed, which
// goes on without it).
const STANDING = {
  unchanged: {
    why: 'is already deployed, and its source is the one the last build recorded for it, so this build sends it again as it is and goes on.',
    next: 'once the page\'s source changes, the build holds it to the check and stops on anything the check still reports.',
  },
  unrecorded: {
    why: 'is already deployed, and this workspace holds no record of what the last build sent for it, so the build cannot tell whether this send changes it; it goes on, as builds did before this check.',
    next: 'once a build has recorded this page, a change to its source is held to the check, and the build stops on anything the check still reports.',
  },
  inherited: {
    why: 'updates a page that is already deployed, and the deployed page already had these, set the same, so the upload goes on.',
    next: 'an upload that adds anything the check reports, or sets one of these to another value, is refused.',
  },
  undetermined: {
    why: 'updates a page that is already deployed, and the deployed page could not be read to tell which of these it already had, so the upload goes on.',
    next: 'when the deployed page can be read, an upload that adds anything the check reports is refused.',
  },
};

/**
 * The text of a warning: `problems` of one page that the run goes on with, because it ships nothing new (see above). Same arguments as describeGriffelRefusal, with `standing` — one
 * of STANDING's keys — in place of `note`. It says that the page renders without the key today, both ways out, and that the check still stops a change that adds one.
 */
function describeGriffelWarning(problems, file, { surface, subject, standing, command }) {
  const words = SURFACES[surface];
  const shorthands = problems.filter(isShorthandProblem);
  const unreadable = problems.filter((p) => !isShorthandProblem(p));
  const parts = [`${subject} ${STANDING[standing].why}`];
  if (shorthands.length) {
    parts.push(`It writes CSS that Griffel drops at runtime, so the page renders without it as it does today: ${describeGriffelProblems(shorthands, file)} ${SHORTHAND_REMEDIES}`);
  }
  if (unreadable.length) {
    parts.push(`${shorthands.length ? 'It also has' : 'It has'} makeStyles calls the Griffel check could not read, so it cannot tell ${shorthands.length ? 'whether they hold more' : 'whether the page writes CSS that Griffel drops at runtime'}: ${describeGriffelProblems(unreadable, file)}`);
  }
  parts.push(`Edit ${words.where} to ${shorthands.length ? 'do either' : 'make the code readable'} (\`${command}\` ${shorthands.length ? 'lists every one' : 'shows what it cannot read'}); ${STANDING[standing].next}`);
  return parts.join(' ');
}

module.exports = { griffelStyleProblems, describeGriffelProblems, griffelProblemsNotIn, describeGriffelRefusal, describeGriffelWarning, SHORTHAND_REMEDIES, UNSUPPORTED_GRIFFEL_SHORTHANDS, GRIFFEL_MODULES, STYLE_FUNCTIONS };
