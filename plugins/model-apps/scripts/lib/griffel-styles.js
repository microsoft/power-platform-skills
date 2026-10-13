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
//   * The value of `animationName` in a style object is NOT a style object: its keyframes are serialized as written (compileKeyframeRule), so
//     `from: { borderColor: … }` is fine there and is not reported. A SLOT called `animationName` is a slot like any other, and its object is read.
//   * `makeResetStyles` is NOT checked, though the work item names it. Its keys are written to one CSS rule as they stand (resolveResetStyleRules →
//     createStringFromStyles, which never imports UNSUPPORTED_CSS_PROPERTIES), and the unsupported set is consulted only by resolveStyleRules, which makeStyles calls
//     and makeResetStyles does not — verified by running both over `borderColor: 'red'`: makeStyles drops it, makeResetStyles emits `border-color:red;`. Reporting
//     those keys would refuse a page that works. To check it too, add `['makeResetStyles', { slots: false }]` to STYLE_FUNCTIONS: its argument is one style object, with no slots.
//   * Inline React styles (`style={{ borderColor: … }}`) are not Griffel at all — the browser's own CSS handles them — and are not reported; rules.md recommends them.
//     `...shorthands.borderColor('red')` is Fluent's helper that expands to longhands; it is a call, not a key, and is not reported.
//   * The same names in a string, a comment, a template literal or a regex are text, not keys, and are not reported.
// The keys have to be written where the checker can see them, and a style object it cannot see is never reported as clean. `makeStyles(styles)` — an object built
// elsewhere — a slot or a nested selector whose object is a variable (`root: base`, `':hover': hover`), and a spread of anything but an object written inline
// (`...base`, `...helper()`) are each an `unread-style-object` problem: the keys behind them may be any of the ten, and a gate that let them through would deploy
// exactly what it exists to stop. Written inline, the same keys are checked, so the remedy is always to write them there. So is a getter that runs, whatever key
// it defines (`get root() { return … }`, `get color() { … }`): Griffel calls it as it reads the key, and a spread as it copies its object, and its body is code the
// check does not read, which may return any value and change what else its object holds before Griffel reads that (ranGetter). And so is a computed key the check
// cannot read as one string (`[key]`, `['border' + 'Width']`), which may name any of the ten, or a selector whose object it does not read — unless it is a template
// whose text before its first `${` no one of the ten begins with (`--${name}`, `& .${className}`, `@media (min-width: ${width}px)`): what that names can be told
// from its start, and the object under one that starts as Griffel's nested keys do (`:`, `[`, `>`, `&`, `@`) is read as any selector's is. What a spread or a
// prototype (`__proto__: { … }`) brings into an object is read at that object's level — slots beside slots — because Griffel's `for … in` sees it there, and an
// object is resolved as JavaScript resolves it (heldMembers): a key's last definition is the property, own keys hide inherited ones, a spread copies only its
// object's own keys, and a key is the string JavaScript makes of it (a CR LF or a lone CR written in a template is one LF, however the file ends its lines; U+2028
// and U+2029 stay as written), so a definition the check can prove never reaches Griffel is not checked, while one it cannot (a spread a condition chooses, a key
// computed at run time) is. A function member — a getter, a setter or a method — ends where its body closes, not at a comma of its type parameters or return type.
// A value is read when it is an object literal
// or object literals chosen by a condition — `cond && { … }`, `cond ? { … } : { … }` — through what changes nothing at run time: parentheses, a non-null `!`, and
// `as`/`satisfies` with a type the check reads — `as const`, or a type name with or without type arguments (typeEnd; no page wrote a cast in makeStyles at all) —
// after which what follows is code again (`x as T && y` can be `y`). Any other type leaves the value unread, so a type is never read as a value; `a || b`, which
// can be `a`, is not read either. The call's own argument is read the same way. Two spreads are read as safe without their keys, alone or chosen by a condition,
// both only as VALUE imports from a Griffel module that the page never declares again (a parameter or a variable of the same name takes the trust away; a read of
// it after `=` or `typeof` does not): Fluent's `shorthands.*(…)`, which writes the longhands and is the remedy itself (https://griffel.js.org/react/api/shorthands),
// and `typographyStyles.*`, whose every entry is `fontFamily`, `fontSize`, `fontWeight` and `lineHeight`
// (https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/typographyStyles.ts) — each by its own export names only (STYLE_HELPERS), never by a
// name it inherits: `shorthands.constructor(x)` is `Object(x)`, which hands x back as it is; and `shorthands.transition` only where it builds its own array, since given
// one array it returns what that array's own `reduce` returns. MEASURED before this rule: across 59 distinct pages that call
// `makeStyles` — the plugin's samples, eval fixtures and pages generated on real environments — no style object was written anywhere but inline, no key was
// computed, no getter was written, and the only spreads in `makeStyles` were `shorthands.*(…)`.
//
// WHAT CODE CAN CHANGE. The check reads what the style objects hold as written, and code written in them changes that only through the object it runs on: a
// getter's `this` is the object Griffel is reading, or the one a spread is copying, so a getter that runs there is reported (ranGetter). Code that writes shared
// state — `Object.prototype.borderWidth = …`, a property of an import such as `typographyStyles.body1`, a variable — changes what every object holds, as a
// statement anywhere else in the page could, and no check of the style objects can see it; the check does not follow it, wherever it runs (a getter's body, a
// Proxy's trap or a `toString` that Griffel calls on a fallback value, a template's substitution). So a getter whose object never reaches Griffel — in a value a
// later definition replaces, in a prototype a spread does not copy, in an animation's keyframes — is not reported, even where a spread has run it: what it can
// change there is that object alone. The gate checks what a page asks Griffel for; it is not a sandbox for code written to get past it.
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

// The Griffel-module exports a style object may be SPREAD from without its keys being read (see the header): `call` is spread as a call (`...shorthands.borderColor('red')`),
// `member` as a member (`...typographyStyles.body1`), and only by a name in `members`, the helper's own exports. Each helper is a plain object, so it also answers to the
// names it inherits from Object.prototype, and those are not helpers: `shorthands.constructor(x)` is `Object(x)`, which hands x back unexpanded, keys, getters and all.
// `shorthands`: Griffel's 23 helpers, each of which writes longhands from the values it is given (https://github.com/microsoft/griffel/blob/main/packages/core/src/shorthands/index.ts;
// the same 23 in @griffel/core 1.20.3, which Fluent 9 re-exports) — but `transition` given ONE argument that is an array returns what that array's own `reduce`
// returns (its normalizeTransitionInputs hands the array on: https://github.com/microsoft/griffel/blob/main/packages/core/src/shorthands/transition.ts), and an array
// can bring its own `reduce` (`new (class extends Array { reduce() { … } })()`), so `transition` is `guarded`: trusted only where it builds its own array
// (transitionBuildsItsOwnArray). `typographyStyles`: Fluent 9's 17 entries (the header's link). A name either one gains later is held until it is added here, as any
// spread the check cannot read is. Trusted only under a name imported from a Griffel module, or through a namespace import of one — never by the bare name, which a
// page could bind to anything.
const STYLE_HELPERS = new Map([
  ['shorthands', {
    kind: 'call',
    members: new Set(['border', 'borderLeft', 'borderBottom', 'borderRight', 'borderTop', 'borderColor', 'borderStyle', 'borderRadius', 'borderWidth', 'flex', 'gap',
      'gridArea', 'margin', 'marginBlock', 'marginInline', 'padding', 'paddingBlock', 'paddingInline', 'overflow', 'inset', 'outline', 'transition', 'textDecoration']),
    guarded: new Set(['transition']),
  }],
  ['typographyStyles', {
    kind: 'member',
    members: new Set(['body1', 'body1Strong', 'body1Stronger', 'body2', 'caption1', 'caption1Strong', 'caption1Stronger', 'caption2', 'caption2Strong', 'subtitle1',
      'subtitle2', 'subtitle2Stronger', 'title1', 'title2', 'title3', 'largeTitle', 'display']),
  }],
]);

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
    // A line break written in a template is read as JavaScript reads it: CR LF and a lone CR are each one LF (a template character's TV is the TRV of its
    // LineTerminatorSequence, https://tc39.es/ecma262/#sec-static-semantics-trv), so a key that a file saved with CRLF breaks across lines is the key a quoted
    // '\n' names, not the one '\r\n' names. U+2028 and U+2029 are kept as written, in a template and in a string alike (a string may hold them as written since
    // ES2019, though never a CR or an LF); a backslash before any line break is a continuation, which adds nothing (read below).
    if (c === '\r') {
      value += '\n';
      if (src[i + 1] === '\n') i += 1;
      continue;
    }
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
// `local` maps a name to the function it is — the unaliased names unless the page imports THAT name from a module that is not Griffel's — `namespaces` holds the
// local names of `import * as <ns>` from a Griffel module, and `helpers` maps a name imported from a Griffel module to its STYLE_HELPERS entry, with
// `helperNamespaces` the namespaces a helper may be reached through. A helper is trusted only as a VALUE import (not `import type`, not a `type` specifier: those
// bind nothing at run time) and only when the page uses the name nowhere but as `name.member` outside its import (onlyMemberUse): a parameter, a variable or a
// destructured name that declares it again is a use of another kind, so a page that rebinds the name loses the trust instead of lending it to its own object.
const FROM_QUOTE = new RegExp(`\\bfrom${WS}*(["'])`, 'g');
const NAMESPACE_IMPORT = new RegExp(`\\*${WS}*as${WS}+(${IDENTIFIER_SOURCE})`, 'u');
const AS_SEPARATOR = new RegExp(`${WS}+as${WS}+`);
const TYPE_PREFIX = new RegExp(`^type${WS}+(?=${IDENTIFIER_SOURCE})`, 'u');
// `import type { … }`, `import type * as ns`, `import type Name` — but not `import type from '…'`, whose default import is named `type`.
const TYPE_ONLY_CLAUSE = new RegExp(`^type${WS}*(?:[{*]|${WS}${IDENTIFIER_SOURCE})`, 'u');
function styleFunctionBindings(mask, src) {
  const local = new Map(STYLE_FUNCTIONS);
  const namespaces = new Set();
  const helpers = new Map();
  const helperNamespaces = new Set();
  const imports = [];
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
    imports.push([m.index, close + 1]);
    const moduleName = decodeStringLiteral(src, quoteAt, close + 1);
    const griffel = moduleName !== null && GRIFFEL_MODULES.has(moduleName);
    const typeOnly = TYPE_ONLY_CLAUSE.test(trimTrivia(clause));
    const namespace = NAMESPACE_IMPORT.exec(clause);
    if (namespace && griffel) {
      namespaces.add(namespace[1]);
      if (!typeOnly) helperNamespaces.add(namespace[1]);
    }
    const named = /\{([^}]*)\}/.exec(clause);
    if (!named) continue;
    for (const part of named[1].split(',')) {
      // `GriffelStyle`, `type GriffelStyle`, `makeStyles`, `makeStyles as ms`: the imported name, and the name it is bound to.
      const specifier = trimTrivia(part);
      const typeSpecifier = TYPE_PREFIX.test(specifier);
      const words = specifier.replace(TYPE_PREFIX, '').split(AS_SEPARATOR);
      const imported = trimTrivia(words[0] || '');
      const bound = trimTrivia(words[1] || words[0] || '');
      if (!bound) continue;
      if (STYLE_FUNCTIONS.has(imported) && griffel) local.set(bound, STYLE_FUNCTIONS.get(imported));
      else if (STYLE_FUNCTIONS.has(bound)) local.delete(bound); // the bare name is bound to something that is not Griffel's
      if (STYLE_HELPERS.has(imported) && griffel && !typeOnly && !typeSpecifier) helpers.set(bound, STYLE_HELPERS.get(imported));
      else helpers.delete(bound); // a later import of another module's export, or of a type, under that name takes it back
    }
  }
  for (const name of [...helpers.keys()]) if (!onlyMemberUse(mask, name, imports)) helpers.delete(name);
  for (const name of [...helperNamespaces]) if (!onlyMemberUse(mask, name, imports)) helperNamespaces.delete(name);
  return { local, namespaces, helpers, helperNamespaces };
}

// Whether every use of `name` in the code, outside the import statements in `skip` ([start, end) pairs), is a member access — `name.x` — or a read that cannot declare it:
// after `=` or `typeof`. Declaring the name again is always a use of another kind where it is declared (`(name)`, `name:`, `name =`, `{ name }`, `function name(`), so a
// name that passes is bound to its import wherever it is read; `x.name` is a property of something else and is not a use; `...name` and `name?.x` are uses of another
// kind, and fail it.
function onlyMemberUse(mask, name, skip) {
  const re = new RegExp(`(?<![\\p{ID_Continue}$\\u200c\\u200d])${escapeRegExp(name)}(?![\\p{ID_Continue}$\\u200c\\u200d])`, 'gu');
  for (let m = re.exec(mask); m; m = re.exec(mask)) {
    if (skip.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const before = previousSignificant(mask, m.index);
    if (before >= 0 && mask[before] === '.' && mask[before - 1] !== '.') continue;
    // Read where it stands, never declared there: after `=` (`const { Button } = Fluent`, a default value, a comparison) — unless `=>` follows, which makes it an
    // arrow function's parameter (`= shorthands => …`), a declaration — and after `typeof` (a type query, or the operator).
    const after = skipSpace(mask, m.index + name.length);
    const arrowParameter = mask[after] === '=' && mask[after + 1] === '>';
    if (before >= 0 && mask[before] === '=' && !arrowParameter) continue;
    const word = before >= 0 ? identifierEndingAt(mask, before + 1) : null;
    if (word && word.name === 'typeof') continue;
    if (mask[after] !== '.') return false;
  }
  return true;
}

// Whether the name at `at` is the name of a function declaration — `function makeStyles(…) {…}`, `function* makeStyles(…)` — which is not a call.
function declaresFunction(mask, at) {
  let end = previousSignificant(mask, at) + 1;
  if (end > 0 && mask[end - 1] === '*') end = previousSignificant(mask, end - 1) + 1;
  const word = identifierEndingAt(mask, end);
  return word !== null && word.name === 'function';
}

// Every call to a Griffel style function, as { spec, nameAt, callee, open, close, objectOpen, objectClose, argFrom, argTo }: `nameAt` is where the function's name is and `callee`
// where the call starts (`Fluent.makeStyles(` starts at `Fluent`); `open` and `close` are the call's parentheses and `objectOpen` and `objectClose` the braces of the
// inline object that is its first argument — -1 where that is not an object literal, and `close` is -1 where the call is never closed; [argFrom, argTo) is the first
// argument, whatever it is. A name is read whole
// (`notmakeStyles` is another name) and as a member only of a Griffel namespace import (`this.makeStyles(…)` is not Griffel's). TypeScript type arguments are
// skipped: `makeStyles<'root'>({ … })`. A call with no argument reads nothing and is left out.
function styleFunctionCalls(mask, src, match, angles) {
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
    const close = match[k];
    calls.push({ spec, nameAt: m.index, callee, open: k, close, objectOpen, objectClose: objectOpen === -1 ? -1 : match[objectOpen],
      argFrom: first, argTo: close === -1 ? -1 : expressionEnd(mask, match, angles, first, close) });
  }
  return calls;
}

// The `,` that ends the expression starting at `from` inside a bracket group that closes at `close` — a member of an object, an argument of a call — or `close`. A
// bracket group is jumped through the match table and a string through its closing quote. The type of an `as` or `satisfies` is jumped whole (typeEnd), so its own
// commas (`{ … } as Record<string, T>`) do not end the expression; where the text after one does not read as a type, nothing is jumped, and the next comma ends it.
function expressionEnd(mask, match, angles, from, close) {
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
    } else if (ID_START.test(ch) && !ID_PART.test(mask[k - 1] || '')) {
      const id = readIdentifier(mask, k);
      if (!id) { k += 1; continue; }
      if ((id.name === 'as' || id.name === 'satisfies') && mask[previousSignificant(mask, k)] !== '.') {
        const end = typeEnd(mask, angles, id.end, close);
        k = end === -1 ? id.end : end;
        continue;
      }
      k = id.end;
    } else {
      k += 1;
    }
  }
  return close;
}

// How deep a style value or object may nest before the check stops reading it — far deeper than any page writes one (a few levels) — so that a pathological page gets
// an answer, not an exhausted stack: past it, a value is unread and an object is reported as one the check does not read.
const MAX_STYLE_DEPTH = 64;
// A line terminator, which ends a type before `<` (TypeScript reads `T\n<` as a comparison).
const LINE_BREAK = /[\n\r\u2028\u2029]/;
// The types TypeScript reads with no type arguments (parseNonArrayType in https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts): a keyword
// type unless a `.` follows it, which makes it the first name of a dotted type reference (parseKeywordAndNoDot); and always `void`, the literal types `null`, `true`
// and `false`, `this`, and the `const` of `as const`. After one of them a `<` is a comparison — `size as number < 5 ? a : b` is `(size as number) < 5 ? a : b` — so
// it is never jumped as type arguments: a jump there ran on to whatever `>` came later, across the members between.
const KEYWORD_TYPES = new Set(['any', 'unknown', 'string', 'number', 'bigint', 'symbol', 'boolean', 'undefined', 'never', 'object']);
const ARGUMENTLESS_TYPES = new Set(['const', 'void', 'null', 'true', 'false', 'this']);

// The `>` that closes each `<` as type arguments would — `<` and `>` counted as brackets from that `<` on, `=>` not a closer — or -1, computed once. A `<` that a
// comparison leaves open does not keep a later one from closing (each `>` closes the latest open `<`, which is the one a count from that `<` would close at), and a
// type's arguments are looked up rather than scanned for: a scan from each cast to the end of the object made a page of casts quadratic. The mask holds no `<` or
// `>` of a string, comment, template or regex.
function matchAngles(mask) {
  const match = new Int32Array(mask.length).fill(-1);
  const open = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === '<') open.push(i);
    else if (mask[i] === '>' && mask[i - 1] !== '=' && open.length) match[open.pop()] = i;
  }
  return match;
}

// Where the type of an `as` or a `satisfies` that starts at `from` ends (exclusive), or -1. Only the forms a page writes are read — `const`, and a name, maybe
// dotted, maybe with type arguments (`GriffelStyle`, `Fluent.GriffelStyle`, `Record<string, GriffelStyle>`); measured, none of 59 distinct pages that call makeStyles
// (samples, eval fixtures, pages generated on real environments) wrote a cast inside the call at all. Type arguments are jumped as a run of balanced `<` and `>`
// (matchAngles; a string or template is blank between its quotes in the mask, so `Record<'>', T>` counts no quoted `>`) that must close inside the range; what they
// hold is the type's. A type that takes none (KEYWORD_TYPES, ARGUMENTLESS_TYPES) ends at its word. And a type is taken to end only where what follows cannot
// continue it, as TypeScript reads one (parsePostfixTypeOrHigher in parser.ts): the end of the range, `,` `)` `]` `}` `;` `:`, `&&` `||` `??`, another `as` or
// `satisfies`, or a `?` before what can start a type — a runtime conditional; TypeScript reads a `?` before anything else as part of the type. Any other type (a
// union, an object, function or conditional type, an import type, …) or continuation (`[`, `|`, `extends`, `<` after a keyword, …) is -1, so the caller reads the
// value as one it cannot see: a type is never taken to end where TypeScript would read on.
function typeEnd(mask, angles, from, end) {
  const at = (i) => skipSpace(mask, i);
  const head = readIdentifier(mask, at(from));
  if (!head) return -1;
  let k = head.end;
  const argumentless = ARGUMENTLESS_TYPES.has(head.name) || (KEYWORD_TYPES.has(head.name) && mask[at(k)] !== '.');
  if (!argumentless) {
    for (;;) {
      const dot = at(k);
      if (mask[dot] !== '.') break;
      const next = readIdentifier(mask, at(dot + 1));
      if (!next) return -1;
      k = next.end;
    }
    const open = at(k);
    if (mask[open] === '<' && !LINE_BREAK.test(mask.slice(k, open))) {
      const close = angles[open];
      if (close === -1 || close >= end) return -1;
      k = close + 1;
    }
  }
  const f = at(k);
  if (f >= end) return k;
  const c = mask[f];
  const d = mask[f + 1];
  if (c === ',' || c === ')' || c === ']' || c === '}' || c === ';' || c === ':') return k;
  if ((c === '&' && d === '&') || (c === '|' && d === '|') || (c === '?' && d === '?')) return k;
  if (c === '?' && d !== '.') {
    const n = mask[at(f + 1)] || '';
    return '{(["\'`-'.includes(n) || /[0-9]/.test(n) || ID_START.test(n) ? k : -1;
  }
  const word = readIdentifier(mask, f);
  return word && (word.name === 'as' || word.name === 'satisfies') ? k : -1;
}
// ─── Style objects ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The members of the object literal whose `{` is at `open`, as { name, nameAt, spread, valueFrom, valueTo, head, keyText, getter, proto }: `name` is the key where it
// is a name, a number or a string literal (null for a computed key that is not one), `nameAt` where the key starts in the source, and [valueFrom, valueTo) the value —
// empty for a shorthand member (`{ borderColor }`), and the expression after the dots for a spread (`spread: true`, no name). A computed key also has `keyText`, as
// written (`[key]`), and a template key with a substitution has `head`, its text before the first `${` — all that can be known of what it names (scanStyleObject).
// `proto` marks `__proto__: …` written as a name or a string, which sets the object's prototype rather than a key: `for … in` reads what the prototype holds as
// the object's own (https://tc39.es/ecma262/#sec-runtime-semantics-propertydefinitionevaluation; a computed `['__proto__']` and a shorthand are ordinary keys). A
// getter is a member too (`getter: true`, the value its whole text): Griffel reads every slot and key with `for … in` and `obj[key]`, which calls it, so what it
// returns is that key's value. A setter alone defines no value and a method's value is a function, which Griffel skips, so both are left out. Strings are blank
// in the mask, so the next quote of the same kind closes one.
function objectMembers(ctx, open) {
  const { mask, src, match, angles } = ctx;
  const close = match[open];
  // The `,` that ends the member starting at `from`, or `close` (expressionEnd).
  const memberEnd = (from) => expressionEnd(mask, match, angles, from, close);
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
    // A function member — `get x() {…}`, `set x(v) {…}`, `async x() {…}`, `async *x() {…}`, `*x() {…}` — is its prefix, then its name, written as any key's
    // is and with or without space before it (`get['x']()`, `get.5()`), then its parameters. Only a getter defines a value Griffel reads.
    const functionFrom = i;
    let functionKind = null;
    const word = readIdentifier(mask, i);
    let next = -1;
    if (word && (word.name === 'get' || word.name === 'set' || word.name === 'async')) {
      next = skipSpace(mask, word.end);
      if (word.name === 'async' && mask[next] === '*') next = skipSpace(mask, next + 1);
    } else if (mask[i] === '*') {
      next = skipSpace(mask, i + 1);
    }
    if (next !== -1 && startsKey(mask, next)) {
      functionKind = word && word.name === 'get' ? 'getter' : 'function';
      i = next;
    }
    let name = null;
    let nameAt = i;
    let afterName = i;
    let head;
    let keyText;
    let numeric = false;
    let shorthandAllowed = false;
    const quote = mask[i];
    if (quote === '"' || quote === "'") {
      let end = i + 1;
      while (end < close && mask[end] !== quote) end += 1;
      if (end >= close) break;
      name = decodeStringLiteral(src, i, end + 1);
      afterName = end + 1;
    } else if (quote === '[') {
      // A computed key. Only one that is a single string literal — `['borderWidth']`, or a template without a substitution — has a name. A template WITH a
      // substitution is named by its text as written, which holds its `${` and is never one of the ten names; what it can name is told by its `head`. Any other
      // expression (`[key]`, `['border' + 'Width']`, `[('borderWidth')]`) has no name.
      const closer = match[i];
      if (closer === -1 || closer > close) { i = memberEnd(i) + 1; continue; }
      keyText = src.slice(i, closer + 1);
      const inner = skipSpace(mask, i + 1);
      const q = mask[inner];
      if (q === '"' || q === "'" || q === '`') {
        let end = inner + 1;
        while (end < closer && mask[end] !== q) end += 1;
        if (end < closer && skipSpace(mask, end + 1) === closer) {
          const substitution = q === '`' ? substitutionStart(src, inner, end) : -1;
          if (substitution === -1) {
            const literal = decodeStringLiteral(src, inner, end + 1);
            if (literal !== null) { name = literal; nameAt = inner; }
          } else {
            // Only the head is text: what the substitutions hold is code (a nested `String.raw\`\u\`` is valid there and is no string escape), so the rest is not
            // decoded. The head is decoded as the template's own text is (`\u0062order` is `border`); one that cannot be decoded tells nothing, as an empty one.
            name = src.slice(inner + 1, end);
            nameAt = inner;
            head = decodeStringLiteral(`\`${src.slice(inner + 1, substitution)}\``, 0, substitution - inner + 1) ?? '';
          }
        }
      }
      afterName = closer + 1;
    } else {
      // A number is a key as well — `{ 0: { … } }` is a slot called "0" — and it is never one of the ten.
      NUMERIC_KEY.lastIndex = i;
      const number = NUMERIC_KEY.exec(mask);
      if (number) {
        name = number[0];
        numeric = true;
        afterName = i + number[0].length;
      } else {
        const id = readIdentifier(mask, i);
        if (!id) { i = memberEnd(i) + 1; continue; }
        name = id.name;
        afterName = id.end;
        shorthandAllowed = true;
      }
    }
    const after = skipSpace(mask, afterName);
    // A method's type parameters come between its name and its parameters (`fn<A, B>(…) {…}`): they are jumped whole, commas and all.
    const params = mask[after] === '<' && angles[after] !== -1 && angles[after] < close ? skipSpace(mask, angles[after] + 1) : after;
    if (functionKind) {
      const end = functionEnd(ctx, params, close);
      if (functionKind === 'getter') members.push({ name, nameAt, spread: false, valueFrom: functionFrom, valueTo: end, head, keyText, numeric, getter: true });
      i = end + 1;
    } else if (mask[after] === ':') {
      const valueFrom = skipSpace(mask, after + 1);
      const end = memberEnd(valueFrom);
      members.push({ name, nameAt, spread: false, valueFrom, valueTo: end, head, keyText, numeric, proto: name === '__proto__' && keyText === undefined });
      i = end + 1;
    } else if (mask[params] === '(') {
      i = functionEnd(ctx, params, close) + 1; // a method
    } else if ((mask[after] === ',' || after >= close) && shorthandAllowed) {
      // `{ borderColor }`: an unquoted key whose value is the variable of the same name — still a key named borderColor.
      members.push({ name, nameAt, spread: false, valueFrom: after, valueTo: after });
      i = after + 1;
    } else {
      i = memberEnd(after) + 1;
    }
  }
  return members;
}

// A numeric literal where a key starts — decimal (`0`, `1.5`, `.5`, `1e3`, `1_000`), hexadecimal, octal or binary, or a BigInt (`1n`): what an object literal
// takes as a key besides a name, a string and a computed key (https://tc39.es/ecma262/#prod-LiteralPropertyName).
const NUMERIC_KEY = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d[\d_]*)?)n?/y;

// Whether a key starts at `i`: a name, a string, a number or a computed key.
function startsKey(mask, i) {
  NUMERIC_KEY.lastIndex = i;
  return Boolean(readIdentifier(mask, i)) || '["\''.includes(mask[i] || ' ') || NUMERIC_KEY.test(mask);
}

// Where the function member whose parameters open at `paramsOpen` ends: the `,` after its body, or `close`. Its return type comes between the two and may hold
// commas (`(): Map<A, B> {`), braces (`(): { a: string } {`) and brackets, so the end is not the first comma: it is the first `{ … }`, past bracket groups and a
// type's arguments (matchAngles), that the next `,` — or the object's end — follows. A function member that does not read that way ends where its expression would.
function functionEnd({ mask, match, angles }, paramsOpen, close) {
  if (mask[paramsOpen] !== '(' || match[paramsOpen] === -1 || match[paramsOpen] >= close) return expressionEnd(mask, match, angles, paramsOpen, close);
  let k = match[paramsOpen] + 1;
  while (k < close) {
    const c = mask[k];
    if (c === '{' || c === '(' || c === '[') {
      const end = match[k];
      if (end === -1 || end >= close) return close;
      if (c === '{') {
        const next = skipSpace(mask, end + 1);
        if (next >= close || mask[next] === ',') return Math.min(next, close);
      }
      k = end + 1;
    } else if (c === '<' && angles[k] !== -1 && angles[k] < close) {
      k = angles[k] + 1;
    } else {
      k += 1;
    }
  }
  return close;
}

// Where the first substitution of the template whose opening back-tick is at `from` and closing one at `to` starts (its `$`), or -1. A `\${` is text, not a substitution.
function substitutionStart(src, from, to) {
  for (let k = from + 1; k < to; k += 1) {
    if (src[k] === '\\') k += 1;
    else if (src[k] === '$' && src[k + 1] === '{') return k;
  }
  return -1;
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

// The operators at the top level of [a, b) that decide what an expression's value is — `?` and its `:`, `&&`, `||` and `??` — and each top-level cast, `as` or
// `satisfies`, as `{ op: 'cast', at, end }` with `end` where its type ends (typeEnd): in source order, as { op, at }. A cast's type is jumped, so `x as A extends B ?
// C : D` holds no runtime conditional, while what follows the type is code again (`x as T && y`). A bracket group is stepped over whole (the match table) and so is a
// string; `?.` is a member access, not a conditional. null when a bracket does not close inside the range, or a cast's type cannot be read: what the expression is
// cannot be told.
function topLevelOperators(ctx, a, b) {
  const { mask, match, angles } = ctx;
  const ops = [];
  let k = a;
  while (k < b) {
    const c = mask[k];
    if (c === '{' || c === '(' || c === '[') {
      const closer = match[k];
      if (closer === -1 || closer >= b) return null;
      k = closer + 1;
    } else if (c === '"' || c === "'" || c === '`') {
      let end = k + 1;
      while (end < b && mask[end] !== c) end += 1;
      k = end + 1;
    } else if (c === '?' && mask[k + 1] === '?') {
      ops.push({ op: '??', at: k });
      k += 2;
    } else if (c === '?' && mask[k + 1] === '.' && !/[0-9]/.test(mask[k + 2] || '')) {
      k += 2;
    } else if (c === '?' || c === ':') {
      ops.push({ op: c, at: k });
      k += 1;
    } else if ((c === '&' || c === '|') && mask[k + 1] === c) {
      ops.push({ op: c + c, at: k });
      k += 2;
    } else if (ID_START.test(c) && !ID_PART.test(mask[k - 1] || '')) {
      const id = readIdentifier(mask, k);
      if (!id) { k += 1; continue; }
      // `x.as` is a member, not the operator.
      if ((id.name === 'as' || id.name === 'satisfies') && mask[previousSignificant(mask, k)] !== '.') {
        const end = typeEnd(mask, angles, id.end, b);
        if (end === -1) {
          // Said, so the problem names the assertion rather than a value written elsewhere (scanStyleObject, griffelStyleProblems).
          ctx.unreadCast = true;
          return null;
        }
        ops.push({ op: 'cast', at: k, end });
        k = end;
        continue;
      }
      k = id.end;
    } else {
      k += 1;
    }
  }
  return ops;
}

// The object literals the expression in [from, to) is written as — an object literal, or object literals chosen by a condition — as the offsets of their `{`; or null
// when some value the expression can have is one the checker cannot read in full. `helpers` lets a trusted Fluent helper stand where an object would (a spread:
// trustedHelperValue), contributing nothing to read. Reading through a condition sets `ctx.conditional` (heldMembers asks whether a spread is one object for
// certain). Taken in the order JavaScript binds them (loosest first):
//   c ? X : Y               X and Y; the condition is not a style object
//   a || X, a ?? X          null: `a` can be the value, and it is not read
//   c && X                  X; `c` is a condition (a false one spreads nothing)
//   X as T, X satisfies T   X, when nothing but casts follows it: the type is jumped (topLevelOperators), and `x as T < 10` is a comparison, not an object
//   ( X ), X!               X: parentheses and a non-null assertion change nothing at run time
//   { … }                   read: the keys are in it
// Anything else — a variable, a member, a call — holds keys the checker cannot see.
function styleObjectsOf(ctx, from, to, helpers = false, depth = 0) {
  const { mask, match } = ctx;
  // Deeper than any style value is written: what it holds is not read, rather than recursing until the stack runs out.
  if (depth > MAX_STYLE_DEPTH) return null;
  const a = skipSpace(mask, from);
  let b = to;
  const trim = () => { while (b > a && isTrivia(mask[b - 1])) b -= 1; };
  trim();
  while (b > a && mask[b - 1] === '!') { b -= 1; trim(); }
  if (a >= b) return null;
  const ops = topLevelOperators(ctx, a, b);
  if (ops === null) return null;
  const q = ops.findIndex((o) => o.op === '?');
  if (q !== -1) {
    ctx.conditional = true;
    // The `:` of this `?`: a conditional inside its first branch pairs off its own.
    let nested = 0;
    for (let i = q + 1; i < ops.length; i += 1) {
      if (ops[i].op === '?') nested += 1;
      else if (ops[i].op === ':' && nested-- === 0) {
        const yes = styleObjectsOf(ctx, ops[q].at + 1, ops[i].at, helpers, depth + 1);
        const no = yes && styleObjectsOf(ctx, ops[i].at + 1, b, helpers, depth + 1);
        return no ? [...yes, ...no] : null;
      }
    }
    return null;
  }
  if (ops.some((o) => o.op === '||' || o.op === '??')) return null;
  const ands = ops.filter((o) => o.op === '&&');
  if (ands.length) {
    ctx.conditional = true;
    return styleObjectsOf(ctx, ands[ands.length - 1].at + 2, b, helpers, depth + 1);
  }
  const cast = ops.find((o) => o.op === 'cast');
  if (cast) {
    // `X as A as B`: casts one after another; anything else after the first cast's type makes the value something other than X.
    let end = cast.end;
    for (const next of ops) if (next.op === 'cast' && next.at === skipSpace(mask, end)) end = next.end;
    return skipSpace(mask, end) >= b ? styleObjectsOf(ctx, a, cast.at, helpers, depth + 1) : null;
  }
  if (mask[a] === '(' && match[a] === b - 1) return styleObjectsOf(ctx, a + 1, b - 1, helpers, depth + 1);
  if (mask[a] === '{' && match[a] === b - 1) return [a];
  return helpers && trustedHelperValue(ctx, a, b) ? [] : null;
}

// Whether the expression in [a, b) is a trusted Griffel-module export (STYLE_HELPERS): `shorthands.<name>(…)` or `typographyStyles.<name>`, by a name the page imported
// from a Griffel module (`helpers`), or through a namespace import of one (`Fluent.shorthands.<name>(…)`) — see styleFunctionBindings for when either is trusted.
// Exactly that, and nothing after it.
function trustedHelperValue(ctx, a, b) {
  const { mask, match, helpers, helperNamespaces } = ctx;
  const first = readIdentifier(mask, a);
  if (!first) return false;
  let k = skipSpace(mask, first.end);
  let helper = helpers.get(first.name);
  if (!helper && helperNamespaces.has(first.name) && mask[k] === '.') {
    const inner = readIdentifier(mask, skipSpace(mask, k + 1));
    if (inner && STYLE_HELPERS.has(inner.name)) {
      helper = STYLE_HELPERS.get(inner.name);
      k = skipSpace(mask, inner.end);
    }
  }
  if (!helper || mask[k] !== '.') return false;
  const member = readIdentifier(mask, skipSpace(mask, k + 1));
  // Only the helper's own exports: a name it inherits (`constructor`, `valueOf`, …) is no helper, and `shorthands.constructor(x)` hands x back unread (STYLE_HELPERS).
  if (!member || !helper.members.has(member.name)) return false;
  if (helper.kind === 'member') return member.end === b;
  k = skipSpace(mask, member.end);
  if (mask[k] !== '(' || match[k] !== b - 1) return false;
  return !(helper.guarded && helper.guarded.has(member.name)) || transitionBuildsItsOwnArray(ctx, k, b - 1);
}

// Whether Griffel's `transition`, called with the arguments between the `(` at `open` and the `)` at `close`, builds its own array — whose `reduce` is the built-in
// one — rather than handing on the one it was given (STYLE_HELPERS). It hands one on only when it gets exactly one argument and that argument is an array
// (`transitionInputs.length === 1 && Array.isArray(transitionInputs[0])`), so: any number of arguments but one, none of them a spread (`...list` may be that one); or
// one array or primitive literal written in place — an array literal is a fresh Array, and a string or a number is no array. Anything else (`transition(list)`,
// `transition(Object.assign([], { reduce() { … } }))`) may be an array with its own `reduce`.
function transitionBuildsItsOwnArray(ctx, open, close) {
  const args = callArguments(ctx, open, close);
  if (args === null) return false;
  if (args.some(({ from }) => ctx.mask.startsWith('...', skipSpace(ctx.mask, from)))) return false;
  if (args.length !== 1) return true;
  const { from, to } = args[0];
  const a = skipSpace(ctx.mask, from);
  let z = to;
  while (z > a && isTrivia(ctx.mask[z - 1])) z -= 1;
  return (ctx.mask[a] === '[' && ctx.match[a] === z - 1) || primitiveValue(ctx, from, to);
}

// The arguments between the `(` at `open` and the `)` at `close`, as [{ from, to }], split at the commas at their top level: a bracket group and a string are stepped
// over whole, as topLevelOperators steps them, and a trailing comma adds none. null when a bracket does not close inside them, or a `<` stands at their top level —
// a comparison, or type arguments whose commas would split one argument in two (`x as Map<a, b>`), which cannot be told apart here.
function callArguments({ mask, match }, open, close) {
  const args = [];
  let from = open + 1;
  let k = from;
  while (k < close) {
    const c = mask[k];
    if (c === '{' || c === '(' || c === '[') {
      const closer = match[k];
      if (closer === -1 || closer >= close) return null;
      k = closer + 1;
    } else if (c === '"' || c === "'" || c === '`') {
      let end = k + 1;
      while (end < close && mask[end] !== c) end += 1;
      k = end + 1;
    } else if (c === '<') {
      return null;
    } else if (c === ',') {
      args.push({ from, to: k });
      from = k + 1;
      k += 1;
    } else {
      k += 1;
    }
  }
  if (skipSpace(mask, from) < close) args.push({ from, to: close });
  return args;
}

// A key that names a CSS property holds a value: `color`, `WebkitAppearance`, `-webkit-tap-highlight-color`, or a custom property — `--` and any name
// (`--brand_color`; https://www.w3.org/TR/css-variables-1/#defining-variables). Any other key of a style object is a selector or an at-rule (`':hover'`,
// `'& .row'`, `'@media (…)'`), which Griffel reads as a nested style object.
const PROPERTY_KEY = /^-?[A-Za-z][A-Za-z0-9-]*$/;
const isPropertyKey = (name) => name.startsWith('--') || PROPERTY_KEY.test(name);

// Whether the value in [from, to) is a string, a template, a number or `true`/`false`/`null`: never a style object, so it hides no key whatever the key it is under
// looks like (`'borderWidth ': 'x'` is a property Griffel writes as it is). The keywords are reserved words, matched exactly: `Null` or `TRUE` is an ordinary name, and
// `undefined` is not reserved (a page can bind it). The mask keeps a literal's quotes and blanks its body, so the first quote of its kind closes it.
const PRIMITIVE = /^(?:[-+]?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?|true|false|null)$/;
function primitiveValue({ mask }, from, to) {
  const a = skipSpace(mask, from);
  let b = to;
  while (b > a && isTrivia(mask[b - 1])) b -= 1;
  if (a >= b) return false;
  const q = mask[a];
  if (q === '"' || q === "'" || q === '`') return mask.indexOf(q, a + 1) === b - 1;
  return PRIMITIVE.test(mask.slice(a, b));
}

// Every unsupported key under the object whose `{` is at `open`, depth first. `slotObject` is true for the object of slots, whose keys are slot names. `trail` is the names of
// the keys the object hangs under — the slot, then each selector or at-rule below it — and `findings` collects { name, at, longhands, within, value }, with `within` that trail (a spread, or a
// computed key that is not a string, is `...` or `[…]` in it): where a key is, apart from the line it is on, so that a page can be told from an earlier version of itself; and `value`, what
// it is set to (valueText), so that a key given another value is not taken for the same one. A member whose value is a style object the checker cannot see — a slot, a selector or a
// spread not written as style objects it reads (styleObjectsOf; a spread inside a style object may also be a trusted helper) — is a finding too, `{ unread, at, within, value }`,
// `unread` saying which it is; the objects written inline in its value are still read. So is a getter that runs, whatever its key (ranGetter). The members are the ones the object holds as Griffel reads it (heldMembers).
function scanStyleObject(ctx, open, findings, slotObject, trail = []) {
  if (trail.length > MAX_STYLE_DEPTH) {
    findings.push({ unread: 'deep', at: open, within: trail, value: '' });
    return;
  }
  for (const { member, within } of heldMembers(ctx, open, findings, slotObject, trail)) {
    if (!slotObject && member.name !== null && UNSUPPORTED_GRIFFEL_SHORTHANDS.has(member.name)) {
      findings.push({ name: member.name, at: member.nameAt, longhands: UNSUPPORTED_GRIFFEL_SHORTHANDS.get(member.name), within, value: valueText(ctx, member) });
    }
    const here = [...within, member.name === null ? '[…]' : member.name];
    // Keyframes are not style objects (see the header), so an animation's frames are not read. A SLOT may be called animationName: its object is a style object.
    // A getter that defines the key still runs when Griffel reads it (ranGetter).
    if (!slotObject && member.name === 'animationName') {
      if (member.getter) findings.push(ranGetter(ctx, member, here));
      continue;
    }
    // A computed key that is not one string may name any key, so it is held unless what it is can be told from its start: a template whose text before its first
    // `${` (`head`) no one of the ten begins with — `--${name}`, `& .${className}`, `@media (min-width: ${width}px)` — names none of them. A slot's key is not a
    // property, so a computed one is not held.
    if (!slotObject && (member.name === null || (member.head !== undefined && mayBeginShorthand(member.head)))) {
      findings.push({ unread: 'key', at: member.nameAt, within: here, value: valueText(ctx, member), key: member.keyText });
    } else {
      // What the key holds, read from its name — or, for a template, from its head, by Griffel's own test: it nests an object only under a key that starts with
      // `:`, `[`, `>`, `&` or an at-rule (`@media`, `@supports` …), so a head that starts with anything else (`--`, `-`, `padding`) names a property whatever is
      // substituted, while one that starts with one of them may be a selector.
      const holdsStyleObject = slotObject || (member.head !== undefined ? NESTED_START.test(member.head) : !isPropertyKey(member.name));
      if (holdsStyleObject) {
        ctx.unreadCast = false;
        // A getter's value is what its body returns, which is never read, however it is written: its text, `get <name>(…) {…}`, is no object (`!member.getter`
        // says so rather than leaving it to what styleObjectsOf makes of a function's text — a getter called `as` would read as a cast).
        const read = !member.getter
          && (styleObjectsOf(ctx, member.valueFrom, member.valueTo) !== null || primitiveValue(ctx, member.valueFrom, member.valueTo));
        if (!read) {
          const unread = ctx.unreadCast ? 'cast' : slotObject ? 'slot' : 'selector';
          findings.push({ unread, at: member.nameAt, within: here, value: valueText(ctx, member) });
        }
      } else if (member.getter) {
        // A property's value is no style object, but a getter that defines it is code that runs as Griffel reads the key (ranGetter).
        findings.push(ranGetter(ctx, member, here));
      }
    }
    // A getter's body is code, not an object: it is not searched for objects written inline. Any other member's objects are style objects one level down.
    if (!member.getter) for (const nested of objectsIn(ctx, member.valueFrom, member.valueTo)) scanStyleObject(ctx, nested, findings, false, here);
  }
}

// The members the object whose `{` is at `open` holds as Griffel reads it, in the order JavaScript defines them, each as { member, within }. Its own members, and
// what an inline spread copies in — the spread object's OWN members only: a spread copies own enumerable properties, never what its object inherits
// (CopyDataProperties, https://tc39.es/ecma262/#sec-copydataproperties) — and what a prototype set by `__proto__: { … }` adds, which `for … in` reads. Then as
// JavaScript resolves them: the last definition of a key is the property, so a member that a later member of the same key certainly replaces never reaches Griffel
// and is left out; and an own property hides an inherited one of the same name, so an inherited member counts only where no own member certainly defines that key.
// "Certainly": a spread a condition chooses (`...(c && { … })`) may define nothing, and a key computed at run time (keyOf null) cannot be told, so neither takes
// anything out — a member is kept whenever the check cannot prove it gone. A spread or a prototype whose value the check cannot read is a finding (it may define
// any key); the objects written inline in it are still read, at this object's level. A getter a spread copies has RUN — the copy reads every key of its object,
// which calls it — so taking out the value it returned does not take out what it did: `ran` marks it, and it is a finding where it is taken out (ranGetter), as it
// is where it is held (scanStyleObject). `ownOnly` reads an object a spread copies; `depth` counts spreads and prototypes nested in one another, past
// MAX_STYLE_DEPTH unread.
function heldMembers(ctx, open, findings, slotObject, trail, ownOnly = false, depth = 0) {
  const own = [];
  const inherited = [];
  for (const member of objectMembers(ctx, open)) {
    if (!member.spread && !member.proto) {
      own.push({ member, within: trail, certain: true });
      continue;
    }
    if (member.proto && ownOnly) continue;
    const within = [...trail, member.spread ? '...' : '__proto__'];
    const into = member.spread ? own : inherited;
    // What a prototype holds is inherited however it got there; what an object a spread copies inherits is not copied.
    const copied = member.spread || ownOnly;
    // A getter its own object still holds when a spread copies that object is called by the copy (CopyDataProperties reads each key with [[Get]]); one that a
    // prototype holds runs only if Griffel reads it, and is held then. (What an unread value does with an object written in it — a call's argument, say — the
    // check cannot tell, and that value is a finding already.)
    const ran = (entry) => entry.ran || (member.spread && entry.member.getter === true);
    ctx.unreadCast = false;
    ctx.conditional = false;
    const objects = depth < MAX_STYLE_DEPTH ? styleObjectsOf(ctx, member.valueFrom, member.valueTo, member.spread && !slotObject) : null;
    if (objects === null) {
      if (!primitiveValue(ctx, member.valueFrom, member.valueTo)) {
        const unread = depth >= MAX_STYLE_DEPTH ? 'deep' : ctx.unreadCast ? 'cast' : member.spread ? 'spread' : 'proto';
        findings.push({ unread, at: member.nameAt, within, value: valueText(ctx, member) });
      }
      if (depth < MAX_STYLE_DEPTH) {
        for (const nested of objectsIn(ctx, member.valueFrom, member.valueTo)) {
          for (const entry of heldMembers(ctx, nested, findings, slotObject, within, copied, depth + 1)) into.push({ ...entry, certain: false });
        }
      }
      continue;
    }
    const certain = member.spread && !ctx.conditional && objects.length === 1;
    for (const object of objects) {
      for (const entry of heldMembers(ctx, object, findings, slotObject, within, copied, depth + 1)) into.push({ ...entry, certain: certain && entry.certain, ran: ran(entry) });
    }
  }
  const last = new Map();
  own.forEach((entry, i) => {
    const key = keyOf(entry.member);
    if (key !== null && entry.certain) last.set(key, i);
  });
  // Taken out, a getter that has run is still reported; one that has not never runs (a later definition in its own object replaced it, or an own key hides it).
  const takenOut = (entry) => { if (entry.ran) findings.push(ranGetter(ctx, entry.member, [...entry.within, entry.member.name])); };
  const held = own.filter((entry, i) => {
    const key = keyOf(entry.member);
    if (key === null || !last.has(key) || last.get(key) <= i) return true;
    takenOut(entry);
    return false;
  });
  for (const entry of inherited) {
    const key = keyOf(entry.member);
    if (key === null || !last.has(key)) held.push(entry);
    else takenOut(entry);
  }
  return held;
}

// A getter that runs — Griffel calls it as it reads the key, a spread as it copies its object — is code the check does not read: what it returns, and what it does
// to its object first (`this[':hover'] = …`, `delete this.x`, which Griffel then reads), may put any key in front of Griffel, so it is a finding whatever key it
// defines, a property's included. One that never runs is not: a later definition in its own object replaces it before anything reads it, and an own key hides an
// inherited one. What a getter does to anything but its own object is shared state, which the check does not follow (WHAT CODE CAN CHANGE, in the header).
function ranGetter(ctx, member, within) {
  return { unread: 'getter', at: member.nameAt, within, value: valueText(ctx, member) };
}

// The key a member defines, where it can be told for certain: a name or a string as written (decoded — a CR LF or a lone CR in a template is one LF, as JavaScript reads it),
// and a number in the form JavaScript gives it as a key — `0x10` and `'16'` are one key, `1e3` is `'1000'` (ToString of its value; a module allows no legacy octal
// such as `010`) — or null: a key computed at run time is never taken to be the same key as another.
function keyOf(member) {
  if (member.name === null || member.head !== undefined) return null;
  if (!member.numeric) return member.name;
  const text = member.name.replace(/_/g, '');
  try {
    return text.endsWith('n') ? String(BigInt(text.slice(0, -1))) : String(Number(text));
  } catch {
    return null;
  }
}

// What a key Griffel nests an object under starts with (isNestedSelector, and the at-rules, in @griffel/core's resolveStyleRules).
const NESTED_START = /^[:[>&@]/;

// Whether a key that starts with `head` may be one of the ten: Griffel matches a key exactly, so only one that is a start of one of them can be.
const mayBeginShorthand = (head) => [...UNSUPPORTED_GRIFFEL_SHORTHANDS.keys()].some((name) => name.startsWith(head));

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

// What an `unread-style-object` problem says, by what holds the object the checker cannot see. `value` is the expression as written, shortened; for a computed key,
// `name` is the key as written.
function unreadMessage(kind, name, value) {
  const shorten = (text) => (String(text || '').length > 60 ? `${String(text).slice(0, 57)}…` : String(text || ''));
  const shown = shorten(value);
  if (kind === 'key') {
    return `the key ${shorten(name)} is computed, so the check cannot tell what it names: it may be a property Griffel drops, or a selector whose style object `
      + 'the check does not read. Write the key as a name or a string (`borderTopWidth: …`, `\':hover\': { … }`), or as a template that starts with what it is '
      + '(`--…`, `& .…`, `@media …`), and check again.';
  }
  if (kind === 'cast') {
    return `the type this value is asserted as (${shown}) is not one the check reads — it reads \`as const\` and a type name, with or without type arguments — so it `
      + 'cannot tell what the value is, and it may hold a key Griffel drops. Write the object without the assertion, or assert a named type, and check again.';
  }
  if (kind === 'deep') {
    return `this style object is nested deeper than the check reads (${MAX_STYLE_DEPTH} levels), so it cannot read its keys, and they may include one Griffel drops. `
      + 'Write it with less nesting and check again.';
  }
  if (kind === 'call') {
    return 'this makeStyles call is given a style object written elsewhere, so the check cannot read its keys, and they may include one Griffel drops. '
      + 'Write the object in the call — makeStyles({ … }) — and check again.';
  }
  if (kind === 'spread') {
    return `this spread (...${shown}) adds keys the check cannot read, and they may include one Griffel drops. Write the keys in this style object instead, `
      + 'and check again (Fluent\'s shorthands.*(…) and typographyStyles.* may be spread as they are).';
  }
  if (kind === 'proto') {
    return `the prototype set here (__proto__: ${shown}) adds keys the check cannot read, and they may include one Griffel drops. Write the keys in this object `
      + 'instead, and check again.';
  }
  if (kind === 'getter') {
    return `"${name}" is defined by a getter (${shown}), which runs when its object is read — by Griffel, or by a spread that copies it — and its body is code `
      + 'the check does not read: what it returns, and what it changes in the object, may include a key Griffel drops. Write the value as a property, and check again.';
  }
  const holder = kind === 'slot' ? `slot "${name}"` : `"${name}"`;
  return `the style object of ${holder} is not written here (${shown}), so the check cannot read its keys, and they may include one Griffel drops. `
    + 'Write it inline, as an object, and check again.';
}

/**
 * The problems with the Griffel style calls of one page's source.
 * @param {string} source the page's TSX
 * @returns {{ calls: number, frontier: null | { line: number, column: number, kind: string },
 *             problems: Array<{ code: string, property?: string, line: number, column: number, longhands?: string[], within?: string[], value?: string, message: string }> }}
 *   `calls` is how many makeStyles calls with an inline object were read. A problem is
 *     `unsupported-shorthand` — a key Griffel drops, with the line and column of the key, the longhands to write, `within`: the slot, selectors and at-rules the key sits under
 *                               (`["root", ":hover"]`), and `value`: what the key is set to, as written (`"red"` for either quoting of the string red, `tokens.colorBrandStroke1` for an
 *                               expression — nothing is evaluated). Together they tell the same key, still there and set to the same, from a new or a changed one when a page is compared
 *                               with an earlier version of itself;
 *     `unread-style-object`     — a style object the checker cannot see, so it cannot say what keys it holds: the call's own (`makeStyles(styles)`), a slot's or a selector's that is
 *                               not written inline (a getter's included), or a spread of anything but an inline object or a trusted Griffel helper; a getter that runs, whatever
 *                               key it defines (its code may change what Griffel reads); or a computed key it
 *                               cannot read, which may be one of the ten (see the header); with `within` where it is;
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
  const angles = matchAngles(mask);
  const { local, helpers, helperNamespaces } = styleFunctionBindings(mask, src);
  const ctx = { mask, src, match, angles, helpers, helperNamespaces };
  const starts = lineStarts(src);
  const problems = [];
  let read = 0;
  const calls = styleFunctionCalls(mask, src, match, angles);
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
    // The argument is read as a slot's value is (styleObjectsOf): an object written in the call, maybe in parentheses, with an assertion or chosen by a condition.
    ctx.unreadCast = false;
    const slots = styleObjectsOf(ctx, call.argFrom, call.argTo);
    if (slots === null) {
      problems.push({ code: 'unread-style-object', ...at, within: [], message: unreadMessage(ctx.unreadCast ? 'cast' : 'call', '', src.slice(call.argFrom, call.argTo)) });
      continue;
    }
    read += 1;
    const findings = [];
    for (const open of slots) scanStyleObject(ctx, open, findings, call.spec.slots);
    for (const f of findings) {
      if (f.unread) {
        problems.push({ code: 'unread-style-object', ...locate(starts, f.at), within: f.within, value: f.value,
          message: unreadMessage(f.unread, f.key ?? f.within[f.within.length - 1], f.value) });
      } else {
        problems.push({ code: 'unsupported-shorthand', property: f.name, ...locate(starts, f.at), longhands: f.longhands, within: f.within, value: f.value, message: shorthandMessage(f.name, f.longhands) });
      }
    }
  }
  if (guess) {
    const known = new Set(calls.map((call) => call.nameAt));
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
  return { calls: read, frontier: guess ? { ...locate(starts, guess.at), kind: guess.kind } : null, problems };
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

// typeEnd over a whole source — where the type that starts at `from` ends, or -1 — for the differential test that holds it against TypeScript's own parser: never an end
// TypeScript does not agree with (tests/griffel-styles.test.js, with TYPESCRIPT_ORACLE_PATH set).
function assertedTypeEnd(source, from) {
  const mask = blankLiterals(String(source));
  return typeEnd(mask, matchAngles(mask), from, mask.length);
}

module.exports = { griffelStyleProblems, describeGriffelProblems, griffelProblemsNotIn, describeGriffelRefusal, describeGriffelWarning, SHORTHAND_REMEDIES, UNSUPPORTED_GRIFFEL_SHORTHANDS, GRIFFEL_MODULES, STYLE_FUNCTIONS,
  assertedTypeEnd };
