'use strict';
// The Griffel unsupported-shorthand gate (AB#6691124): lib/griffel-styles.js and the check-griffel-styles.js CLI.
//
// Griffel's runtime skips ten CSS shorthands in a `makeStyles` style object and only logs to the browser console, so a page that writes one type-checks,
// transpiles, deploys and then renders without the border or the reset. The gate used to be an agent grepping the page for `borderWidth`: one property of the ten,
// and a text search that cannot tell a key from a string, a comment or an inline `style={{ … }}`. These tests pin what replaced it. That the docs run it before every
// transpile and upload is asserted in genpage-dispatch-contract.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { griffelStyleProblems, griffelProblemsNotIn, describeGriffelRefusal, describeGriffelWarning, SHORTHAND_REMEDIES, UNSUPPORTED_GRIFFEL_SHORTHANDS, STYLE_FUNCTIONS } = require('../lib/griffel-styles.js');
const { checkGriffelStyles } = require('../check-griffel-styles.js');

const SCRIPT = path.join(__dirname, '..', 'check-griffel-styles.js');
const PLUGIN = path.join(__dirname, '..', '..');
const REPO = path.join(PLUGIN, '..', '..');
const IMPORT = "import { makeStyles, tokens } from '@fluentui/react-components';\n";

// Griffel's UNSUPPORTED_CSS_PROPERTIES (packages/core/src/constants.ts of @griffel/core 1.19 and 1.20), each with the longhands CSS defines for it.
const TEN = [
  ['all', []],
  ['borderColor', ['borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']],
  ['borderStyle', ['borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle']],
  ['borderWidth', ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']],
  ['borderBlock', ['borderBlockStartWidth', 'borderBlockStartStyle', 'borderBlockStartColor', 'borderBlockEndWidth', 'borderBlockEndStyle', 'borderBlockEndColor']],
  ['borderBlockStart', ['borderBlockStartWidth', 'borderBlockStartStyle', 'borderBlockStartColor']],
  ['borderBlockEnd', ['borderBlockEndWidth', 'borderBlockEndStyle', 'borderBlockEndColor']],
  ['borderInline', ['borderInlineStartWidth', 'borderInlineStartStyle', 'borderInlineStartColor', 'borderInlineEndWidth', 'borderInlineEndStyle', 'borderInlineEndColor']],
  ['borderInlineStart', ['borderInlineStartWidth', 'borderInlineStartStyle', 'borderInlineStartColor']],
  ['borderInlineEnd', ['borderInlineEndWidth', 'borderInlineEndStyle', 'borderInlineEndColor']],
];

// A page whose makeStyles argument is `slots` (source text of the object), under the usual import.
const styles = (slots, header = IMPORT) => `${header}const useStyles = makeStyles(${slots});\n`;
// `property@line:column` of each unsupported key, in source order.
const found = (source) => griffelStyleProblems(source).problems.map((p) => `${p.property || p.code}@${p.line}:${p.column}`);
const names = (source) => griffelStyleProblems(source).problems.map((p) => p.property || p.code);

// ─── The set ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('griffel-styles: the checked set is exactly the ten shorthands Griffel drops, each with the longhands CSS defines for it', () => {
  assert.deepEqual([...UNSUPPORTED_GRIFFEL_SHORTHANDS.keys()].sort(), TEN.map(([property]) => property).sort());
  for (const [property, longhands] of TEN) assert.deepEqual(UNSUPPORTED_GRIFFEL_SHORTHANDS.get(property), longhands, property);
});

for (const [property, longhands] of TEN) {
  test(`griffel-styles: ${property} in a slot is reported with its line, column and longhands`, () => {
    const source = `${IMPORT}const useStyles = makeStyles({\n  root: {\n    ${property}: 'x',\n  },\n});\n`;
    const { calls, problems } = griffelStyleProblems(source);
    assert.equal(calls, 1);
    assert.equal(problems.length, 1);
    const [p] = problems;
    assert.deepEqual(
      { code: p.code, property: p.property, line: p.line, column: p.column, longhands: p.longhands },
      { code: 'unsupported-shorthand', property, line: 4, column: 5, longhands },
    );
    assert.ok(p.message.includes(`\`${property}\``), 'the message names the key');
    assert.match(p.message, /Griffel/);
    for (const longhand of longhands) assert.ok(p.message.includes(longhand), `the message lists ${longhand}`);
  });
}

test('griffel-styles: `all` has no longhand list, so its message says to set the properties one by one', () => {
  const [p] = griffelStyleProblems(styles("{ root: { all: 'unset' } }")).problems;
  assert.deepEqual(p.longhands, []);
  assert.match(p.message, /one by one/);
  assert.doesNotMatch(p.message, /Write the longhands/);
});

test('griffel-styles: the shorthands Griffel supports, their longhands, and names that only contain a flagged one are not reported', () => {
  const supported = [
    'padding', 'paddingBlock', 'margin', 'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'borderCollapse', 'borderImage',
    'outline', 'gap', 'overflow', 'flex', 'font', 'background', 'inset', 'transition', 'animation',
    'borderTopWidth', 'borderRightStyle', 'borderBottomColor', 'borderLeftWidth', 'borderBlockStartWidth', 'borderBlockEndStyle', 'borderInlineStartColor',
    'borderInlineEndWidth', 'borderStartStartRadius',
    'borderColors', 'xborderWidth', 'borderWidthX', 'allow', 'allAbout',
  ];
  const source = styles(`{ root: { ${supported.map((key) => `${key}: 'x'`).join(', ')} } }`);
  const { calls, problems } = griffelStyleProblems(source);
  assert.equal(calls, 1);
  assert.deepEqual(problems, []);
});

// ─── Keys ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('griffel-styles: a key is found however it is written — bare, quoted, spaced, commented, computed from a string, escaped, or shorthand', () => {
  const members = [
    "borderWidth: 'x'",
    "borderWidth : 'x'",
    "borderWidth\n    : 'x'",
    "borderWidth/* why */: 'x'",
    "'borderWidth': 'x'",
    "\"borderWidth\" : 'x'",
    "['borderWidth']: 'x'",
    '["borderWidth"]: "x"',
    "[`borderWidth`]: 'x'",
    "[ 'borderWidth' ]: 'x'",
    "'border\\u0057idth': 'x'",
    "'border\\x57idth': 'x'",
    "'border\\u{57}idth': 'x'",
    "'border\\\nWidth': 'x'",
    'borderWidth: undefined',
    'borderWidth: null',
    'borderWidth: 0',
    'borderWidth: tokens.strokeWidthThin',
    'borderWidth: `${tokens.strokeWidthThin}`',
    "borderWidth: ['1px', 'thin']",
    'borderWidth',
  ];
  for (const member of members) {
    const source = styles(`{ root: { color: 'red', ${member}, padding: 1 } }`);
    assert.deepEqual(names(source), ['borderWidth'], member);
  }
});

test('griffel-styles: a string that is not one of the ten, a value that names one, and a method are not keys Griffel drops', () => {
  const members = [
    "'borderWidth ': 'x'",
    "'border-width': 'x'",
    "' borderWidth': 'x'",
    "content: '\"borderWidth\": 1'",
    "transition: 'borderWidth 1s'",
    // A method's value is a function and a setter alone defines none: Griffel writes nothing for either, so no style is lost.
    "set borderColor(v) {}",
    "borderStyle() { return 'solid'; }",
    "async borderBlock() {}",
    "async *borderInline() {}",
    "*borderInlineEnd() {}",
    "[`--${name}`]: 'x'",
    "[`padding${side}`]: tokens.spacingHorizontalS",
    // A key that starts with `-` is a property whatever follows, and so is one that starts with `--` whatever its substitution holds — a nested template that
    // is raw text included — and one that starts with anything else Griffel does not nest under (`.`, a space).
    "[`-${suffix}`]: tokens.colorBrandForeground1",
    "[`--${String.raw`\\u`.length}`]: tokens.colorBrandForeground1",
    "[`.${className}`]: hover",
    "[` :${state}`]: hover",
  ];
  for (const member of members) {
    const source = styles(`{ root: { ${member}, color: 'red' } }`);
    assert.deepEqual(names(source), [], member);
  }
});

// A getter defines a key, and Griffel reads it — `for … in`, then `obj[key]`, which calls it — so what it returns is that key's value: its name is checked as any
// key's is, and the value it returns, which the check cannot read, is reported wherever a style object is wanted. A getter is also code that runs, so one that
// defines a property is reported too (see the next tests).
test('griffel-styles: a getter is a key Griffel reads, and the object it returns is one the check cannot see', () => {
  const GETTER = "get root(): Record<string, string> { return { borderWidth: '1px' }; }";
  assert.deepEqual(names(styles(`{ ${GETTER} }`)), ['unread-style-object']);
  assert.deepEqual(names(styles("{ root: { get ':hover'() { return hover; }, get color() { return 'red'; } } }")), ['unread-style-object', 'unread-style-object']);
  assert.deepEqual(names(styles("{ root: { get borderWidth() { return '1px'; } } }")), ['borderWidth', 'unread-style-object']);
  assert.deepEqual(names(styles("{ root: { get [key]() { return 'red'; } }, get 0() { return base; }, get 'b'() { return { color: 'red' }; } }")),
    ['unread-style-object', 'unread-style-object', 'unread-style-object']);
  // A key named get, set or async is a key like any other.
  assert.deepEqual(names(styles("{ get: { borderColor: 'x' }, set : { color: 'red' }, async: base }")), ['borderColor', 'unread-style-object']);
  // A getter's name may follow `get` with no space at all.
  for (const getter of ["get['root']()", "get'root'()", 'get.5()']) {
    assert.deepEqual(names(styles(`{ ${getter} { return { borderWidth: '1px' }; } }`)), ['unread-style-object'], getter);
  }
  // Its return type is a type, however it is written: one that reads like a conditional of objects is not the getter's value, and an object type's members are
  // not keys (the one problem below is the getter itself, which runs).
  assert.deepEqual(names(`${IMPORT}type Style<A, B> = Record<string, string>;\nconst useStyles = makeStyles({ get root(): Style<true extends true ? {} : {}, never> { return { borderWidth: '1px' }; } });\n`),
    ['unread-style-object']);
  assert.deepEqual(names(styles("{ root: { get color(): { borderWidth: string }['borderWidth'] { return 'red'; } } }")), ['unread-style-object']);
  const [slot] = griffelStyleProblems(styles(`{ ${GETTER} }`)).problems;
  assert.match(slot.message, /^the style object of slot "root" is not written here \(get root\(\)/);
  // The value is a getter's however it is named: one called `as` is no cast.
  const [as] = griffelStyleProblems(styles("{ get as(): Record<string, string> { return { color: 'red' }; } }")).problems;
  assert.match(as.message, /^the style object of slot "as" is not written here/);
});

// A function member — a getter, a setter, a method, an async or generator method — ends where its body closes: its return type may hold commas, and the member
// after it is read from where it starts. (A getter that runs is reported for itself — the one `unread-style-object` below each — never for a key in its type.)
test('griffel-styles: a function member ends with its body, not at a comma of its return type', () => {
  assert.deepEqual(names(`${IMPORT}type Color<A, B, C> = string;\ntype all = string;\nconst useStyles = makeStyles({ root: { get color(): Color<string, all, string> { return 'red'; } } });\n`),
    ['unread-style-object']);
  // Each kind of function member, with a type argument that would read as a key `all` if the member ended at the first comma.
  assert.deepEqual(names(styles("{ root: { color(): Color<string, all, string> { return 1; }, borderWidth: '1px' } }")), ['borderWidth']);
  assert.deepEqual(names(styles("{ root: { async color(): Promise<Map<a, all>> { }, *gen(): Generator<a, all, b> { }, async *g(): X<a, all, b> {}, borderColor: 'x' } }")),
    ['borderColor']);
  assert.deepEqual(names(styles("{ root: { set['borderColor'](v) {}, get x(): T<a, b> { return 1; }, borderStyle: 's', fn(a = { all: 1 }): { all: 1 } { return 1; } } }")),
    ['unread-style-object', 'borderStyle']);
  // An object type inside the type arguments is not the body, though a comma follows it.
  assert.deepEqual(names(styles('{ root: { fn(): Map<{}, all, x> { return 1; } } }')), []);
  // Nor is one in a conditional return type, which a `:` follows.
  assert.deepEqual(names(`${IMPORT}type Color<A, B, C> = string;\ntype all = string;\nconst useStyles = makeStyles({ root: { get color():\n  false extends true ? {} : Color<string, all, string> {\n  return 'red';\n }, } });\n`),
    ['unread-style-object']);
  // A method's type parameters come before its parameters, and hold commas too.
  assert.deepEqual(names(styles("{ root: { fn<A, all, C>(): string { return 'x'; }, async g<A, all>(): X<a, all, b> {}, *h<A, all>() {}, color: 'red' } }")), []);
});

// A getter is code, and it runs: Griffel calls it as it reads its key, and a spread as it copies its object — before a later definition replaces what it returned.
// Its `this` is that object, so it can rewrite or delete a key Griffel reads after it, and the check does not read code: a getter that runs is reported, whatever
// key it defines. One that never runs — replaced in its own object before anything reads it, or inherited under an own key — is not; nor is one whose object never
// reaches Griffel, though a spread runs it, since its own object is all it can change without writing shared state, which no check of the style objects can see
// (WHAT CODE CAN CHANGE, in the library's header). Each page here was run (TypeScript 5.8.3, then Node and Griffel 1.20.3's own resolveStyleRulesForSlots) and the
// getters it called counted: the check reports each one that runs on a style object Griffel reads or on an object a spread copies into one, and no other.
test('griffel-styles: a getter that runs is reported whatever key it defines, and one that never runs is not', () => {
  const page = (slots) => styles(slots, `${IMPORT}const bad: Record<string, string> = { borderWidth: '1px' };\nconst c = true;\n`);
  // Griffel reads `color`, which runs the getter, which writes the `:hover` Griffel reads next.
  assert.deepEqual(names(page("{ root: { get color() { (this as any)[':hover'] = { borderWidth: '1px' }; return 'red'; }, ':hover': { color: 'blue' } } }")),
    ['unread-style-object']);
  // The same under animationName: its keyframes are not read, but its getter runs.
  assert.deepEqual(names(page("{ root: { get animationName() { (this as any)[':hover'] = bad; return {}; }, ':hover': { color: 'blue' } } }")), ['unread-style-object']);
  // Deleting the own `:hover` lets Griffel read the inherited one, which the own key hid.
  assert.deepEqual(names(page("{ root: { __proto__: { ':hover': bad }, get color() { delete (this as any)[':hover']; return 'red'; }, ':hover': { color: 'blue' } } }")),
    ['unread-style-object']);
  // A spread calls the getter as it copies its object, before the later `root` replaces what it returned — by then it has put `bad` in `other`.
  assert.deepEqual(names(page("{ ...{ get root(): Record<string, string> { Reflect.set(this, 'other', bad); return {}; }, other: { color: 'red' } }, root: { color: 'blue' } }")),
    ['unread-style-object']);
  // So does a spread inside a prototype, as the prototype is written, though an own key hides what it copied; and a spread inside a spread.
  assert.deepEqual(names(page("{ root: { __proto__: { ...{ get color() { return 'red'; } } }, color: 'blue' } }")), ['unread-style-object']);
  assert.deepEqual(names(page("{ ...{ ...{ get root() { return {}; } } }, root: { color: 'blue' } }")), ['unread-style-object']);
  // A spread a condition chooses copies, and so runs the getter, whenever it is chosen: uncertain is not "never".
  assert.deepEqual(names(page("{ ...(c && { get root(): Record<string, string> { Reflect.set(this, 'other', bad); return {}; }, other: { color: 'red' } }), root: { color: 'blue' } }")),
    ['unread-style-object']);
  assert.deepEqual(names(page("{ ...(c ? { get root(): Record<string, string> { return {}; } } : {}), root: { color: 'blue' } }")), ['unread-style-object']);
  // A getter that never runs is not reported.
  for (const slots of [
    "{ root: { get color() { return 'red'; }, color: 'blue' } }", // replaced in its own object
    "{ root: { get color() { return 'red'; }, ...{ color: 'blue' } } }", // … by what a later spread copies into it
    "{ ...{ get root() { return {}; }, root: { color: 'blue' } } }", // … inside the object a spread copies, before the copy
    "{ root: { __proto__: { get color() { return 'red'; } }, color: 'blue' } }", // inherited, and an own key hides it
    "{ ...{ __proto__: { get root() { return {}; } } } }", // a spread copies own keys only
  ]) assert.deepEqual(names(page(slots)), [], slots);
  // Nor is one whose object never reaches Griffel, though a spread runs it as the page is built: what it can change there is that object alone.
  for (const slots of [
    "{ ...{ root: { ...{ get color() { return 'red'; } } } }, root: { color: 'blue' } }", // in a value a later definition replaces
    "{ ...{ __proto__: { ...{ get root() { return {}; } } } } }", // in a prototype the spread does not copy
    "{ root: { animationName: { get from() { return { opacity: 0 }; } } } }", // in an animation's keyframes, which are not style objects
  ]) assert.deepEqual(names(page(slots)), [], slots);
  // The problem names the getter and where it is: where Griffel reads it, or where the spread that ran it put it.
  const [held] = griffelStyleProblems(page("{ root: { get color() { return 'red'; } } }")).problems;
  assert.deepEqual(held.within, ['root', 'color']);
  assert.match(held.message, /^"color" is defined by a getter \(get color\(\) \{ return 'red'; \}\), which runs when its object is read/);
  const [ran] = griffelStyleProblems(page("{ ...{ get root() { return {}; } }, root: { color: 'blue' } }")).problems;
  assert.deepEqual(ran.within, ['...', 'root']);
});

// A key is the string JavaScript makes of it, so two keys are taken for one only where they are one. A CR LF or a lone CR written in a template is one LF,
// however the file ends its lines (the TRV of a LineTerminatorSequence), so it is the key a quoted '\n' names, which replaces it, and not the key '\r\n' or '\r'
// names, which does not. U+2028 and U+2029 stay as written, in a template and in a string alike: neither is the key '\n' names.
test('griffel-styles: a line break written in a template key is read as JavaScript reads it', () => {
  const page = (slots) => styles(slots, `${IMPORT}const bad: Record<string, string> = { borderWidth: '1px' };\n`);
  assert.deepEqual(names(page("{ ...{ [`a\r\nb`]: bad }, 'a\\r\\nb': { color: 'red' } }")), ['unread-style-object']);
  assert.deepEqual(names(page("{ ...{ [`a\rb`]: bad }, 'a\\rb': { color: 'red' } }")), ['unread-style-object']);
  assert.deepEqual(names(page("{ ...{ [`a\r\nb`]: bad }, 'a\\nb': { color: 'red' } }")), []);
  assert.deepEqual(names(page("{ ...{ [`a\rb`]: bad }, [`a\nb`]: { color: 'red' } }")), []);
  // The page text below holds U+2028 and U+2029 themselves (the test's own string escapes put them there), not the escape `\u2028`.
  assert.deepEqual(names(page("{ ...{ [`a\u2028b`]: bad }, 'a\\nb': { color: 'red' } }")), ['unread-style-object']);
  assert.deepEqual(names(page("{ ...{ [`a\u2029b`]: bad }, 'a\\nb': { color: 'red' } }")), ['unread-style-object']);
  assert.deepEqual(names(page("{ ...{ [`a\u2029b`]: bad }, 'a\u2029b': { color: 'red' } }")), []);
  assert.deepEqual(names(page("{ ...{ [`a\u2028b`]: bad }, 'a\\u2028b': { color: 'red' } }")), []);
  // A backslash before a line break is a continuation, which adds nothing, whichever line break follows it.
  assert.deepEqual(names(page("{ ...{ [`a\\\r\nb`]: bad }, ab: { color: 'red' } }")), []);
  assert.deepEqual(names(page("{ ...{ [`a\\\rb`]: bad }, ab: { color: 'red' } }")), []);
});

// What a spread or a prototype brings into an object is that object's own: slots where it holds slots, keys where it holds keys. `__proto__: …` written as a name
// or a string sets the prototype, and `for … in` reads what the prototype holds; a computed `['__proto__']` is an ordinary key.
test('griffel-styles: a spread or a prototype adds members at the level it is written — slots beside slots, keys beside keys', () => {
  assert.deepEqual(names(styles('{ ...{ root: base } }')), ['unread-style-object']);
  assert.deepEqual(names(styles("{ ...{ all: { color: 'red' } } }")), [], 'a slot called all, brought in by a spread, is a slot');
  assert.deepEqual(names(styles("{ ...(c ? { root: { borderColor: 'x' } } : { other: base }) }")), ['borderColor', 'unread-style-object']);
  assert.deepEqual(names(styles('{ __proto__: { root: base } }')), ['unread-style-object']);
  assert.deepEqual(names(styles("{ '__proto__': { root: { borderStyle: 'solid' } } }")), ['borderStyle']);
  assert.deepEqual(names(styles("{ __proto__: null, root: { color: 'red' } }")), []);
  assert.deepEqual(names(styles("{ root: { __proto__: { borderWidth: '1px' } } }")), ['borderWidth']);
  assert.deepEqual(names(styles("{ root: { ['__proto__']: { color: 'red' } } }")), []);
  // A computed `['__proto__']` at the level of slots is a slot of that name, and `all` in its object is a key Griffel drops.
  assert.deepEqual(names(styles("{ ['__proto__']: { all: { color: 'red' } } }")), ['all']);
  const [proto] = griffelStyleProblems(styles('{ __proto__: slots }')).problems;
  assert.match(proto.message, /^the prototype set here \(__proto__: slots\) adds keys the check cannot read/);
});

// An object holds, for each key, its LAST definition — a later one replaces an earlier one, a spread's keys included — and its own keys hide the prototype's of the
// same name; a spread copies only its object's own keys. A definition that cannot reach Griffel is not checked; one that may (a spread a condition chooses, a key
// computed at run time) is never taken to replace anything.
test('griffel-styles: what an object holds is resolved as JavaScript resolves it — the last definition, own keys before inherited ones', () => {
  assert.deepEqual(names(styles("{ ...{ root: base }, root: { color: 'red' } }")), [], 'a slot a later one replaces');
  assert.deepEqual(names(styles("{ __proto__: { root: base }, root: { color: 'red' } }")), [], 'a prototype slot an own one hides');
  assert.deepEqual(names(styles("{ ...{ __proto__: { root: base }, other: { color: 'red' } } }")), [], 'a spread copies no prototype');
  assert.deepEqual(names(styles("{ __proto__: { __proto__: { root: base }, root: { color: 'red' } } }")), [], 'a prototype chain');
  assert.deepEqual(names(styles("{ root: { borderWidth: 1 }, root: { color: 'red' } }")), [], 'a repeated key: the last one');
  assert.deepEqual(names(styles("{ root: { color: 'red' }, root: { borderWidth: 1 } }")), ['borderWidth']);
  assert.deepEqual(names(styles("{ ...{ 0x10: base }, '16': { color: 'red' } }")), [], '0x10 and "16" are one key');
  assert.deepEqual(names(styles("{ root: { __proto__: { borderColor: 'x' }, borderColor: 'y' } }")), ['borderColor'], 'one key, not two');
  // What may still reach Griffel is checked: a spread a condition chooses replaces nothing, nor does a key computed at run time; a later conditional one is
  // itself checked.
  assert.deepEqual(names(styles("{ root: base, ...(c && { root: { color: 'red' } }) }")), ['unread-style-object']);
  assert.deepEqual(names(styles("{ ...(c && { root: base }), root: { color: 'red' } }")), []);
  assert.deepEqual(names(styles("{ root: base, [k]: { color: 'red' } }")), ['unread-style-object']);
  assert.deepEqual(names(styles("{ root: { borderColor: 'x' }, ...(c ? { root: { color: 'red' } } : {}) }")), ['borderColor']);
  // A ternary whose other branch is a trusted helper spreads one object, but only when the condition holds; a template key, however alike two are, is computed
  // at run time; and an object in a value the check cannot read (a call's argument) is not certainly spread.
  assert.deepEqual(names(`${IMPORT.replace('tokens', 'shorthands, tokens')}const useStyles = makeStyles({ root: { ':hover': hover, ...(c ? { ':hover': { color: 'red' } } : shorthands.padding('1px')) } });\n`),
    ['unread-style-object']);
  assert.deepEqual(names(styles("{ root: { [`:${s}`]: hover, [`:${s}`]: { color: 'red' } } }")), ['unread-style-object']);
  assert.deepEqual(names(styles("{ root: base, ...pick({ root: { color: 'red' } }) }")), ['unread-style-object', 'unread-style-object']);
});

// A computed key names what its expression is at run time, which may be any of the ten — or a selector, whose object Griffel reads. One the check cannot read as a
// string is held, not guessed at, unless it is a template whose text before its first `${` no one of the ten begins with: then what it is can be told from that start.
test('griffel-styles: a computed key the check cannot read is held, unless its literal start shows it is none of the ten', () => {
  const held = [
    "[prop]: 'x'",
    "['border' + 'Width']: 'x'",
    "[('borderWidth')]: 'x'",
    "[String.raw`borderWidth`]: 'x'",
    "[`border${side}Width`]: 'x'",
    "[`${prefix}Color`]: 'x'",
    "[`\\u0062order${side}`]: 'x'",
    "[selector]: hover",
    "[1 + 1]: { color: 'red' }",
  ];
  for (const member of held) assert.deepEqual(names(styles(`{ root: { ${member}, color: 'red' } }`)), ['unread-style-object'], member);
  // A template that starts like a selector or an at-rule may hold a style object: one written inline is read, and one written elsewhere is reported.
  assert.deepEqual(names(styles("{ root: { [`& .${iconClassName}`]: { borderColor: 'x' }, [`@media (min-width: ${width}px)`]: { color: 'red' } } }")), ['borderColor']);
  for (const start of [':', '[', '>', '&', '@']) assert.deepEqual(names(styles(`{ root: { [\`${start}\${state}\`]: hover } }`)), ['unread-style-object'], start);
  // A `\${` is text, not a substitution: the key is that string.
  assert.deepEqual(names(styles('{ root: { [`--a\\${b}`]: c } }')), []);
  // A slot's key is not a property, so a computed slot name is not held; its object is read as any slot's is.
  assert.deepEqual(names(styles("{ [slot]: { color: 'red' }, [`${name}Root`]: { borderStyle: 'solid' } }")), ['borderStyle']);
  assert.deepEqual(names(styles('{ [slot]: base }')), ['unread-style-object']);
  // The problem names the key as it is written, and both ways out.
  const [key] = griffelStyleProblems(styles("{ root: { [selector]: hover } }")).problems;
  assert.deepEqual(key.within, ['root', '[…]']);
  assert.match(key.message, /^the key \[selector\] is computed, so the check cannot tell what it names: it may be a property Griffel drops, or a selector/);
});

// A number is a key too, and a slot may be called by one: its object is read as any slot's is.
test('griffel-styles: a numeric key is read — as a slot, and as a key that is none of the ten', () => {
  assert.deepEqual(names(styles("{ 0: { borderWidth: '1px' }, 1.5: hidden }")), ['borderWidth', 'unread-style-object']);
  assert.deepEqual(names(styles("{ 0x1F: { color: 'red' }, .5: { borderColor: 'x' }, 1_000n: { color: 'red' }, 1e3: { ':hover': { borderStyle: 'solid' } } }")),
    ['borderColor', 'borderStyle']);
  assert.deepEqual(names(styles("{ root: { 0: { borderColor: 'x' }, 100: 'red' } }")), ['borderColor']);
});

test('griffel-styles: the value is never looked at — the key alone is what Griffel refuses', () => {
  // resolveStyleRules tests the key before the value, so even an empty value is dropped with a console error.
  for (const value of ["'0'", '0', 'undefined', 'null', 'tokens.strokeWidthThin', '`${x}px`', "cond ? 'a' : 'b'", "fn(1, 'two', [3])", '{ nested: true }']) {
    assert.deepEqual(names(styles(`{ root: { borderWidth: ${value}, color: 'red' } }`)), ['borderWidth'], value);
  }
});

// ─── Depth ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('griffel-styles: keys are found at any depth — pseudo selectors, at-rules, child selectors, several slots', () => {
  const cases = [
    ["{ root: { ':hover': { borderColor: 'red' } } }", ['borderColor']],
    ["{ root: { '&:focus-visible': { borderStyle: 'solid' } } }", ['borderStyle']],
    ["{ root: { '@media (min-width: 600px)': { borderWidth: 1 } } }", ['borderWidth']],
    ["{ root: { '@media screen': { ':hover': { borderInline: 'x' } } } }", ['borderInline']],
    ["{ root: { '@supports (display: grid)': { borderBlock: 'x' } } }", ['borderBlock']],
    ["{ root: { '@container (min-width: 20em)': { borderBlockStart: 'x' } } }", ['borderBlockStart']],
    ["{ root: { '@layer base': { borderBlockEnd: 'x' } } }", ['borderBlockEnd']],
    ["{ root: { '& .child': { all: 'unset' } } }", ['all']],
    ["{ root: { ' > span': { borderInlineStart: 'x' } } }", ['borderInlineStart']],
    ["{ root: { 'a': { 'b': { 'c': { 'd': { 'e': { borderInlineEnd: 'x' } } } } } } }", ['borderInlineEnd']],
    ["{ one: { color: 'red' }, two: { padding: 1, ':hover': { borderWidth: 2 } }, three: { borderColor: 'x' } }", ['borderWidth', 'borderColor']],
    ["{ root: { borderWidth: 1, ':hover': { borderWidth: 2 }, '@media screen': { borderWidth: 3 } } }", ['borderWidth', 'borderWidth', 'borderWidth']],
  ];
  for (const [slots, expected] of cases) assert.deepEqual(names(styles(slots)), expected, slots);
});

test('griffel-styles: an object written in a spread, a ternary or a call argument is a style object once Griffel has it', () => {
  const cases = [
    ["{ root: { ...(narrow && { borderColor: 'red' }) } }", ['borderColor']],
    ["{ root: { ...(narrow ? { borderBlock: 'x' } : { borderInline: 'y' }) } }", ['borderBlock', 'borderInline']],
    ["{ root: { ...{ borderStyle: 'solid' } } }", ['borderStyle']],
    // The argument is read; what the call returns is a style object the check cannot see, so that is reported too.
    ["{ root: { ...pick({ borderWidth: 1 }) } }", ['unread-style-object', 'borderWidth']],
  ];
  for (const [slots, expected] of cases) assert.deepEqual(names(styles(slots)), expected, slots);
});

// A style object the checker cannot see may hold any of the ten, so it is reported wherever it is, never passed as clean: written elsewhere and passed to a slot or a
// selector, or spread in. Only Fluent's own helpers, imported from a Griffel module, are spread without their keys being read: shorthands.*(…) writes longhands, and
// typographyStyles.* holds font longhands only.
test('griffel-styles: a style object the check cannot see is reported — a slot\'s, a selector\'s, a spread — and Fluent\'s imported helpers are not', () => {
  const HELPERS = "import { makeStyles, shorthands, tokens, typographyStyles } from '@fluentui/react-components';\n";
  const cases = [
    ['{ root: base }', ['unread-style-object']],
    ['{ root }', ['unread-style-object']],
    ["{ ...baseSlots, root: { color: 'red' } }", ['unread-style-object']],
    ["{ root: { ':hover': hover } }", ['unread-style-object']],
    ["{ root: { '@media (min-width: 600px)': wide, '& .row': { color: 'red' } } }", ['unread-style-object']],
    ['{ root: { ...base } }', ['unread-style-object']],
    ["{ root: { ...helper('red') } }", ['unread-style-object']],
    ["{ root: { ...(b || { color: 'red' }) } }", ['unread-style-object']],
    ["{ root: { ...(b ?? { color: 'red' }) } }", ['unread-style-object']],
    ["{ root: { ...(n ? base : { color: 'red' }) } }", ['unread-style-object']],
    ["{ root: { ...(n ? { color: 'red' } : base) } }", ['unread-style-object']],
    ["{ root: { ...(n && base) } }", ['unread-style-object']],
    // `a || b && { … }` is `a || (b && { … })`: the value can be `a`.
    ["{ root: { ...(a || b && { color: 'red' }) } }", ['unread-style-object']],
    // Read in full: an inline object, or inline objects chosen by a condition, in parentheses or with a TypeScript assertion after one; a property holding a variable is a
    // value, not a style object, and so is a custom property computed from a template.
    ["{ root: { ...(n && { color: 'red' }), ...(n ? { color: 'red' } : m ? { color: 'blue' } : { color: 'green' }), ...({ color: 'red' }) } }", []],
    ["{ root: { color: 'red' } as const, other: { color: 'red' } satisfies GriffelStyle, more: ({ color: 'red' }) }", []],
    ["{ root: { color: c, '--brand': c, WebkitAppearance: c, '-webkit-tap-highlight-color': c, ':hover': { color: c } } }", []],
    ['{ root: { [`--${name}`]: c } }', []],
    // A computed key the check cannot read may be a selector as well as one of the ten: held.
    ['{ root: { [key]: c } }', ['unread-style-object']],
    ["{ root: { ...(a || b ? { color: 'red' } : { color: 'blue' }) } }", []],
    ["{ root: { ...(props?.wide && { color: 'red' }), ...(x?.[0] ? { color: 'red' } : { color: 'blue' }) } }", []],
    // Fluent's helpers, imported from a Griffel module, are spread as they are…
    ["{ root: { ...shorthands.borderColor('red'), ...shorthands.border('1px', 'solid', 'red'), ...typographyStyles.body1, ...shorthands.padding(\n  tokens.spacingHorizontalS,\n) } }", [], HELPERS],
    // …and only then: not by a name the page did not import from one, not chained, not at the level of slots.
    ["{ root: { ...shorthands.borderColor('red'), ...typographyStyles.body1 } }", ['unread-style-object', 'unread-style-object']],
    ["{ root: { ...shorthands.borderColor('red').x, ...typographyStyles.body1.y, ...typographyStyles['body1'] } }", ['unread-style-object', 'unread-style-object', 'unread-style-object'], HELPERS],
    ["{ ...shorthands.borderColor('red') }", ['unread-style-object'], HELPERS],
    ["{ root: { ...shorthands.borderColor('red') } }", ['unread-style-object'], `${HELPERS}import { shorthands } from './mine';\n`],
    ["{ root: { ...F.shorthands.borderColor('red'), ...F.typographyStyles.body1 } }", [], "import * as F from '@fluentui/react-components';\nimport { makeStyles } from '@fluentui/react-components';\n"],
    ["{ root: { ...G.shorthands.borderColor('red') } }", ['unread-style-object'], "import * as G from './mine';\nimport { makeStyles } from '@fluentui/react-components';\n"],
  ];
  for (const [slots, expected, header] of cases) assert.deepEqual(names(styles(slots, header)), expected, slots);
  // Each says where it is and what to do: the slot, the selectors and at-rules it sits under, and to write the object inline.
  const [hover] = griffelStyleProblems(styles("{ root: { ':hover': hover } }")).problems;
  assert.deepEqual(hover.within, ['root', ':hover']);
  assert.match(hover.message, /^the style object of ":hover" is not written here \(hover\), so the check cannot read its keys/);
  const [spread] = griffelStyleProblems(styles('{ root: { ...base } }')).problems;
  assert.deepEqual(spread.within, ['root', '...']);
  assert.match(spread.message, /^this spread \(\.\.\.base\) adds keys the check cannot read/);
  const [slot] = griffelStyleProblems(styles('{ root: base }')).problems;
  assert.match(slot.message, /^the style object of slot "root" is not written here \(base\)/);
});

// A helper is trusted by its own export names only. Each is a plain object, so it also answers to every name it inherits from Object.prototype, and those are no
// helpers: `shorthands.constructor(x)` is `Object(x)`, which hands x back unexpanded, keys, getters and all. (Run against @griffel/core 1.20.3 and
// @fluentui/react-components 9.74.6: the getter below runs as the spread copies x, and Griffel drops the borderWidth it puts under `:hover`.)
test('griffel-styles: a Griffel helper is trusted by its own export names only, never by a name it inherits', () => {
  const HELPERS = "import { makeStyles, shorthands, tokens, typographyStyles } from '@fluentui/react-components';\n";
  assert.deepEqual(names(styles("{ root: { ...shorthands.constructor({ get color() { Reflect.set(this, ':hover', { borderWidth: '2px', borderTopStyle: 'solid' }); return 'red'; }, ':hover': { color: 'blue' } }) } }", HELPERS)),
    ['unread-style-object', 'unread-style-object']);
  // What such a call is given is read as any spread's inline objects are: a shorthand in it is named too.
  assert.deepEqual(names(styles("{ root: { ...shorthands.constructor({ borderWidth: '2px' }) } }", HELPERS)), ['unread-style-object', 'borderWidth']);
  // Every name either helper inherits — as this Node defines Object.prototype — by its imported name, an alias or a namespace.
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    assert.deepEqual(names(styles(`{ root: { ...shorthands.${name}({ color: 'red' }) } }`, HELPERS)), ['unread-style-object'], `shorthands.${name}`);
    assert.deepEqual(names(styles(`{ root: { ...typographyStyles.${name} } }`, HELPERS)), ['unread-style-object'], `typographyStyles.${name}`);
  }
  assert.deepEqual(names(styles("{ root: { ...expand.constructor({ color: 'red' }) } }", "import { makeStyles, shorthands as expand } from '@fluentui/react-components';\n")),
    ['unread-style-object']);
  assert.deepEqual(names(styles("{ root: { ...F.shorthands.constructor({ color: 'red' }), ...F.typographyStyles.constructor } }",
    "import * as F from '@fluentui/react-components';\nimport { makeStyles } from '@fluentui/react-components';\n")), ['unread-style-object', 'unread-style-object']);
  // A name neither has is held too, until it is added to the list.
  assert.deepEqual(names(styles("{ root: { ...shorthands.borderBlock('1px'), ...typographyStyles.hero } }", HELPERS)), ['unread-style-object', 'unread-style-object']);
  // Each of Griffel's 23 helpers and Fluent's 17 typography entries is spread as it is.
  const helpers = ['border', 'borderLeft', 'borderBottom', 'borderRight', 'borderTop', 'borderColor', 'borderStyle', 'borderRadius', 'borderWidth', 'flex', 'gap',
    'gridArea', 'margin', 'marginBlock', 'marginInline', 'padding', 'paddingBlock', 'paddingInline', 'overflow', 'inset', 'outline', 'transition', 'textDecoration'];
  const entries = ['body1', 'body1Strong', 'body1Stronger', 'body2', 'caption1', 'caption1Strong', 'caption1Stronger', 'caption2', 'caption2Strong', 'subtitle1',
    'subtitle2', 'subtitle2Stronger', 'title1', 'title2', 'title3', 'largeTitle', 'display'];
  const all = [...helpers.map((h) => `...shorthands.${h}('1px')`), ...entries.map((e) => `...typographyStyles.${e}`)].join(', ');
  assert.deepEqual(names(styles(`{ root: { ${all} } }`, HELPERS)), []);
  // `transition` given ONE argument that is an array returns what that array's own `reduce` returns (an array can bring its own), so it is trusted only where it
  // builds its own array: any number of arguments but one, none of them a spread, or one array, string or number written in place. (Run against @griffel/core
  // 1.20.3: the first page below loses its borderWidth.)
  const TRANSITION = `${HELPERS}const list: any = [];\nconst c = true;\n`;
  for (const call of [
    "shorthands.transition(new (class extends Array { reduce(...args: any[]): any { return { borderWidth: '2px', borderTopStyle: 'solid' }; } })())",
    "shorthands.transition(Object.setPrototypeOf([], { reduce() { return { color: 'red' }; } }))",
    'shorthands.transition(list)',
    'shorthands.transition(...list)',
    "shorthands.transition(...list, '1s')",
    "shorthands.transition(c ? list : 'inherit')",
    'shorthands.transition(list as Map<string, number>)',
    'shorthands.transition([list][0])',
    'shorthands.transition(list,)',
  ]) assert.deepEqual(names(styles(`{ root: { ...${call} } }`, TRANSITION)), ['unread-style-object'], call);
  for (const call of [
    "shorthands.transition('opacity', '0.2s')",
    "shorthands.transition('opacity', '0.2s', '0s', 'ease-in')",
    "shorthands.transition(list, '1s')",
    "shorthands.transition('inherit')",
    'shorthands.transition(`all`)',
    "shorthands.transition([['opacity', '0.2s'], ['color', '1s', '0s', 'ease']])",
    "shorthands.transition([['opacity', '0.2s']],)",
    'shorthands.transition()',
    'shorthands.padding(list)',
  ]) assert.deepEqual(names(styles(`{ root: { ...${call} } }`, TRANSITION)), [], call);
});

// What reaches Griffel is the value, whatever wraps it: parentheses, a non-null assertion and a type assertion change nothing at run time, so an object written
// under them is read — and refused nowhere — while a type after `as` or `satisfies` is never read as a runtime conditional, whatever `?` and `:` it holds.
test('griffel-styles: the value is read through what changes nothing at run time, and a type never stands for a value', () => {
  const HELPERS = "import { makeStyles, shorthands, tokens, typographyStyles } from '@fluentui/react-components';\n";
  const call = (argument, header = HELPERS) => `${header}const useStyles = makeStyles(${argument});\n`;
  const cases = [
    // The call's own argument, in parentheses or asserted: read, as written in the call.
    ["({ root: { color: 'red' } })", []],
    ["(({ root: { borderWidth: 1 } }))", ['borderWidth']],
    ["{ root: { color: 'red' } } as const", []],
    // A non-null assertion.
    ["{ root: ({ color: 'red' })!, other: { ...({ color: 'red' })! } }", []],
    // Type arguments after `as`: their commas are the type's, not members of the object (no phantom slot named `boolean`).
    ["{ root: { color: 'red' } as Style<string, boolean, number>, other: { borderWidth: 1 } as Record<string, Partial<{ a: string }>> }", ['borderWidth']],
    // A conditional TYPE after `as` or `satisfies` is not a runtime conditional: the value is `hidden`, which the check cannot see.
    ['{ root: hidden as true extends true ? {} : {} }', ['unread-style-object']],
    ['{ root: hidden satisfies (true extends true ? {} : {}) }', ['unread-style-object']],
    // Fluent's helpers compose with what an object does: in parentheses, after a condition, in a branch.
    ["{ root: { ...(enabled && shorthands.border('1px', 'solid', 'red')), ...(shorthands.padding('4px')), ...(n ? shorthands.borderColor('red') : {}), ...(n ? typographyStyles.body1 : { color: 'red' }) } }", []],
    // …but a helper is not a slot object.
    ["{ ...(n && shorthands.borderColor('red')) }", ['unread-style-object']],
    // A custom property is `--` and any name, and holds a value.
    ["{ root: { '--brand_color': tokens.colorBrandForeground1, '--x-1_y': c, '--': c } }", []],
    // The keywords are matched exactly: `Null`, `TRUE`, `False` and `undefined` are names a page can bind to an object.
    ['{ root: { ...Null, ...TRUE, ...False, ...undefined } }', ['unread-style-object', 'unread-style-object', 'unread-style-object', 'unread-style-object']],
    ["{ root: { ':hover': 1E3, ':focus': 2e-1, '& .row': null, '@media print': false } }", []],
  ];
  for (const [argument, expected] of cases) assert.deepEqual(names(call(argument)), expected, argument);
});

// A helper is trusted only as Fluent's own, at run time: an import of a type binds nothing then, and a page that declares the name again — a parameter, a variable,
// a destructured name — has its own object under it, which the check cannot see.
test('griffel-styles: a helper is trusted only as a value import that the page never declares again', () => {
  const page = (header, body) => `${header}${body}\n`;
  const SPREAD = "const useStyles = makeStyles({ root: { ...shorthands.border() } });";
  const cases = [
    [page("import { makeStyles, shorthands } from '@fluentui/react-components';\n", SPREAD), []],
    [page("import type { shorthands } from '@fluentui/react-components';\nimport { makeStyles } from '@fluentui/react-components';\n", SPREAD), ['unread-style-object']],
    [page("import { makeStyles, type shorthands } from '@fluentui/react-components';\n", SPREAD), ['unread-style-object']],
    [page("import { makeStyles, shorthands } from '@fluentui/react-components';\n", `function build(shorthands: { border: () => object }) {\n  return makeStyles({ root: { ...shorthands.border() } });\n}`), ['unread-style-object']],
    [page("import { makeStyles, shorthands } from '@fluentui/react-components';\n", `const f = ({ shorthands }) => makeStyles({ root: { ...shorthands.border() } });`), ['unread-style-object']],
    [page("import { makeStyles, typographyStyles } from '@fluentui/react-components';\n", "const { typographyStyles } = x;\nconst useStyles = makeStyles({ root: { ...typographyStyles.body1 } });"), ['unread-style-object']],
    // A key of the same name, `{ typographyStyles: t }`, reads like a typed parameter, `(shorthands: T)`, which DOES declare the name: the check does not tell the two
    // apart, so it takes the trust away for both — the safe answer, which costs a page that does this a rename.
    [page("import { makeStyles, typographyStyles } from '@fluentui/react-components';\n", "const { typographyStyles: t } = x;\nconst useStyles = makeStyles({ root: { ...typographyStyles.body1 } });"), ['unread-style-object']],
    // A property of something else named the same is not a declaration of the name.
    [page("import { makeStyles, shorthands } from '@fluentui/react-components';\n", `const n = theme.shorthands;\n${SPREAD}`), []],
    // Through a namespace: a value import is trusted, a type-only one is not.
    [page("import * as F from '@fluentui/react-components';\n", "const useStyles = F.makeStyles({ root: { ...F.shorthands.borderColor('red'), ...F.typographyStyles.body1 } });"), []],
    [page("import type * as F from '@fluentui/react-components';\nimport { makeStyles } from '@fluentui/react-components';\n", "const useStyles = makeStyles({ root: { ...F.shorthands.border() } });"), ['unread-style-object']],
    // …and a namespace name the page declares again is no longer the namespace.
    [page("import * as F from '@fluentui/react-components';\nimport { makeStyles } from '@fluentui/react-components';\n", "const build = (F: any) => makeStyles({ root: { ...F.shorthands.border() } });"), ['unread-style-object']],
    // `import type from '…'` imports a default named `type`; the clause after it is an ordinary one.
    [page("import type from './t';\nimport { makeStyles, shorthands } from '@fluentui/react-components';\n", SPREAD), []],
  ];
  for (const [source, expected] of cases) assert.deepEqual(names(source), expected, source);
});

// A cast's type ends where TypeScript ends it, and what follows it is code again: a comparison after a keyword type (`size as number < 10`) is not type
// arguments and does not swallow the members after it; `X as T && Y` can be Y; a cast in a condition leaves both branches readable; and a read of a helper's name
// that cannot declare it — a type query, the right of `=` — keeps its trust.
test('griffel-styles: what follows a cast\'s type is code again, and a read of a helper\'s name keeps its trust', () => {
  const HELPERS = "import { makeStyles, shorthands, tokens, typographyStyles } from '@fluentui/react-components';\n";
  const cases = [
    // A comparison after `as number`, then a spread the check cannot see: still reported, not swallowed into `fontSize`.
    ["{ root: { fontSize: size as number < 10 ? '12px' : '16px', ...hidden } }", ['unread-style-object']],
    // A keyword type, a literal type, `this` and `void` take no type arguments, so a `<` after one is a comparison even when a later `>` could close it (here
    // before a variable named `as`): the members between are read, never jumped as the type's.
    ["{ root: { fontSize: size as number < 5 ? '12px' : '16px', ...hidden, opacity: 1 > as ? '1' : '0' } }", ['unread-style-object']],
    ...['number', 'string', 'object', 'undefined', 'null', 'true', 'this'].map((type) => (
      [`{ root: { fontSize: size as ${type} < 5 ? '12px' : '16px', borderWidth: '1px', opacity: 1 > as ? '1' : '0' } }`, ['borderWidth']])),
    // …and one followed by a `.` is the first name of a type reference, which does take them.
    ["{ root: { color: 'red' } as number.Shape<A, B>, other: { borderColor: 'x' } }", ['borderColor']],
    // After a type NAME, `<` opens type arguments; these are not types, so nothing is jumped, and the selector after them is read.
    ["{ root: { fontSize: size as Num < 10 ? '12px' : '16px', ':hover': hidden, z: a > b } }", ['unread-style-object']],
    // `X as T && Y`: the value can be Y.
    ["{ root: { ...(shorthands.padding('4px') as Record<string, string> && hidden) } }", ['unread-style-object']],
    ["{ root: { ...(c ? { color: 'red' } : shorthands.padding('1px') as T ? { color: 'blue' } : hidden) } }", ['unread-style-object']],
    // A cast in a condition, or in a branch: both branches are read.
    ["{ root: flag as boolean ? { color: 'red' } : { color: 'blue' }, other: c ? { color: 'red' } as T : { color: 'blue' } }", []],
    ["{ root: { color: 'red' } as const satisfies GriffelStyle }", []],
    // A cast followed by a comparison is a boolean, not an object.
    ['{ root: { ...(x as number < 3) } }', ['unread-style-object']],
    // Only `as const` and a type name, with or without type arguments, are read; any other type makes the value one the check cannot see (no page wrote a cast in
    // makeStyles at all), and the problem says so.
    ["{ root: { color: 'red' } as import('x').T<A, B>, other: { color: 'red' } as A | B, more: { color: 'red' } satisfies (typeof x)[] }", ['unread-style-object', 'unread-style-object', 'unread-style-object']],
    // Text after `as` that is not a type (type arguments that are not types) is never taken for one: what the value is cannot be told.
    ["{ root: hidden as Num < 10 ? { color: 'red' } : { color: 'blue' } }", ['unread-style-object']],
    // The comma operator: the value of `({ … } as T, hidden)` is `hidden`.
    ["{ root: { ...({ color: 'red' } as T, hidden) } }", ['unread-style-object']],
  ];
  for (const [slots, expected] of cases) assert.deepEqual(names(styles(slots, HELPERS)), expected, slots);
  const [cast] = griffelStyleProblems(styles("{ root: { color: 'red' } as A | B }", HELPERS)).problems;
  assert.match(cast.message, /^the type this value is asserted as \(\{ color: 'red' \} as A \| B\) is not one the check reads — it reads `as const` and a type name/);
  // A `<` whose `>` comes only after the member's object has closed is no type's: nothing is jumped — the cast is unread, and the member after it is read.
  assert.deepEqual(names(`${IMPORT}const useStyles = makeStyles({ root: { color: 'red' } as T<A, other: hidden });\nconst later = a > b;\n`),
    ['unread-style-object', 'unread-style-object']);
  // Each member is told for its own reason: one after an unread cast is a value written elsewhere, not another cast.
  const [first, second] = griffelStyleProblems(styles("{ root: { color: 'red' } as A | B, other: hidden }", HELPERS)).problems;
  assert.match(first.message, /^the type this value is asserted as/);
  assert.match(second.message, /^the style object of slot "other" is not written here \(hidden\)/);
  // Type arguments are jumped whole, whatever they hold — a generic function's parameters, a default, a trailing comma.
  assert.deepEqual(names(styles("{ root: { color: 'red' } satisfies ReturnType<<T extends string>() => { color: T }>, other: { borderWidth: 1 } }", HELPERS)), ['borderWidth']);
  assert.deepEqual(names(styles("{ root: { color: 'red' } satisfies ReturnType<<T = string,>() => { color: T }> }", HELPERS)), []);
  // What only looks like the end of a type is not taken for it: a predicate, a constructor, a conditional type — each leaves the value unread, never its type's
  // `? {} : {}` read as code.
  for (const type of ['(value: unknown) => value is unknown extends unknown ? {} : {}', 'abstract new () => true extends true ? {} : {}', 'Shape extends infer S extends { color: string } ? S : never']) {
    assert.deepEqual(names(styles(`{ root: { ...(hidden as unknown as ${type}) } }`, HELPERS)), ['unread-style-object'], type);
  }
  // An arrow function's parameter declares its name, whatever comes before it.
  assert.deepEqual(names(`${HELPERS}const build = (x: unknown) =>\n  shorthands => makeStyles({ root: { ...shorthands.border() } });\n`), ['unread-style-object']);
  assert.deepEqual(names(`${HELPERS}const build: (s: object) => unknown =\n  shorthands => makeStyles({ root: { ...shorthands.border() } });\n`), ['unread-style-object']);
  assert.deepEqual(names(`${HELPERS}const f = (s = shorthands) => s;\nconst useStyles = makeStyles({ root: { ...shorthands.borderColor('red') } });\n`), [], 'a default value is a read');
  assert.deepEqual(names(`${HELPERS}type Variant = keyof typeof typographyStyles;\nconst useStyles = makeStyles({ root: { ...typographyStyles.body1 } });\n`), [], 'a type query is a read');
  assert.deepEqual(names("import * as Fluent from '@fluentui/react-components';\nconst { Button } = Fluent;\nconst useStyles = Fluent.makeStyles({ root: { ...Fluent.shorthands.borderColor('red') } });\n"), [],
    'the right of `=` is a read');
});

// The type of an assertion, held against TypeScript's own parser: for each type after `as`, followed by each runtime tail, where TypeScript parses the program
// without a syntax error, the check either does not read the type (-1: the value is then unread) or ends it exactly where TypeScript's AsExpression type ends —
// never anywhere else. And the forms it reads (`const`, a name with or without type arguments) are read exactly, before what can follow a type.
test('griffel-styles: the type of an assertion ends where TypeScript\'s parser ends it', { skip: !process.env.TYPESCRIPT_ORACLE_PATH && 'TYPESCRIPT_ORACLE_PATH is not set' }, () => {
  const { loadTypescriptOracle } = require('./helpers/typescript-oracle.js');
  const { assertedTypeEnd } = require('../lib/griffel-styles.js');
  const ts = loadTypescriptOracle();
  const TYPES = ['number', 'string', 'boolean', 'any', 'unknown', 'object', 'null', 'undefined', 'void', 'never', 'bigint', 'symbol', 'true', 'false', 'this', 'const',
    'number.A', 'number.A<B>', 'T', 'A.B', 'A.B.C<D>', 'Record<string, number>',
    'Partial<Record<string, { a?: string; b: number }>>', 'Array<() => void>', 'Map<string, Array<number>>', 'Foo<Bar<Baz>>', 'string[]', 'T[K]', "T['a']",
    'Promise<T>[]', 'readonly string[]', '[number, string]', '{ a: string; b?: number }', "'a' | 'b'", "| 'a' | 'b'", 'A & B', 'A & B | C', '& A & B', 'keyof T',
    'typeof y', 'typeof y.z', 'keyof typeof y', '(A | B)[]', '() => void', '(a: number) => string', 'new () => T', '<U>(x: U) => U', 'A extends B ? C : D',
    'true extends true ? {} : {}', 'A extends B ? C extends D ? E : F : G', '-1', '1e3', '0x1F', '10n', '`t`', 'unique symbol', 'Fluent.GriffelStyle',
    "Record<'root' | 'item', GriffelStyle>", "Record<'>' | '<', T>", "import('x').T", "import('x').T<A, B>", "import('x')", "typeof import('x')"];
  // ' < 10 ? a : b, w: 1 > as ? c : d' puts a `>` after the comparison, before a variable named `as`: a type taken to have arguments would close there.
  const TAILS = ['', ' && y', ' || y', ' ?? y', ' ? a : b', ' < 10 ? a : b', ' < 10 ? a : b, w: 1 > as ? c : d', ' as T', ' satisfies U', ' === y', ' > 2', '\n  ',
    ' /* c */', '\n < 3'];
  const READ = new Set(['number', 'string', 'boolean', 'any', 'unknown', 'object', 'null', 'undefined', 'void', 'never', 'bigint', 'symbol', 'true', 'false', 'this',
    'const', 'number.A', 'number.A<B>', 'T', 'A.B', 'A.B.C<D>',
    'Record<string, number>', 'Partial<Record<string, { a?: string; b: number }>>', 'Array<() => void>', 'Map<string, Array<number>>', 'Foo<Bar<Baz>>',
    'Fluent.GriffelStyle', "Record<'root' | 'item', GriffelStyle>", "Record<'>' | '<', T>"]);
  const ENDING = new Set(['', ' && y', ' || y', ' ?? y', ' ? a : b', ' as T', ' satisfies U', '\n  ', ' /* c */']);
  let compared = 0;
  let exact = 0;
  for (const type of TYPES) {
    for (const tail of TAILS) {
      const code = `const o = { k: x as ${type}${tail}, z: 1 };\n`;
      const source = ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      if (source.parseDiagnostics.length) continue;
      let cast = null;
      const visit = (node) => {
        if (!cast && ts.isAsExpression(node) && node.expression.getText(source) === 'x') cast = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!cast) continue;
      const end = assertedTypeEnd(code, code.indexOf(' as ') + 3);
      assert.ok(end === -1 || end === cast.type.end, `${JSON.stringify(code)}: ended at ${end}, TypeScript at ${cast.type.end}`);
      if (READ.has(type) && ENDING.has(tail)) {
        assert.strictEqual(end, cast.type.end, `${JSON.stringify(code)}: a form the check reads`);
        exact += 1;
      }
      compared += 1;
    }
  }
  assert.ok(compared >= 400 && exact >= 150, `compared ${compared} programs, ${exact} read exactly`);
});

// The decisions that settle where a member ends, without the oracle: a form the check reads ends where TypeScript ends it, and anything else is not read (-1).
test('griffel-styles: an assertion\'s type ends where TypeScript ends it — the cases that decide where a member ends', () => {
  const { assertedTypeEnd } = require('../lib/griffel-styles.js');
  const typeOf = (code) => {
    const from = code.indexOf(' as ') + 3;
    const end = assertedTypeEnd(code, from);
    return end === -1 ? -1 : code.slice(from, end).trim();
  };
  assert.equal(typeOf('x as Record<string, T> && y'), 'Record<string, T>');
  assert.equal(typeOf('x as A || y'), 'A', '`||` is code, not a union');
  assert.equal(typeOf('x as const ? a : b'), 'const', 'a `?` before what can start a type is a runtime conditional');
  assert.equal(typeOf('x as T ? !a : b'), -1, 'before anything else TypeScript reads the `?` as part of the type');
  assert.equal(typeOf('x as Fluent.GriffelStyle satisfies U'), 'Fluent.GriffelStyle');
  assert.equal(typeOf('x as ReturnType<<T extends string = "a",>() => { a: T }>, z'), 'ReturnType<<T extends string = "a",>() => { a: T }>');
  assert.equal(typeOf('x as T <U>, z'), 'T <U>', 'type arguments may follow a space on the same line');
  assert.equal(typeOf('x as T\n<U>, z'), -1, 'after a line break TypeScript reads `<` as a comparison, so `<U>` is no part of the type');
  assert.equal(typeOf("x as Record<'>' | '<', `${'<'}`>, z"), "Record<'>' | '<', `${'<'}`>", 'a quoted `<` or `>` is no bracket');
  // A keyword type, a literal type, `this` and `void` take no type arguments: a `<` after one is a comparison, and the type ends at the word. A `.` after a keyword
  // type makes it the first name of a type reference, which takes them.
  assert.equal(typeOf('x as null, z'), 'null');
  assert.equal(typeOf('x as this ? a : b'), 'this');
  assert.equal(typeOf('x as number.A<B>, z'), 'number.A<B>');
  for (const word of ['number', 'string', 'boolean', 'object', 'undefined', 'never', 'null', 'true', 'false', 'void', 'this', 'const']) {
    assert.equal(typeOf(`x as ${word} < 10 ? a : b, w: 1 > as ? c : d`), -1, `${word} takes no type arguments`);
  }
  // A `<` that a comparison leaves open does not keep a later type's arguments from closing.
  assert.equal(typeOf('a < b ? c : d; y = x as Map<K, V>, z'), 'Map<K, V>');
  for (const other of ['x as number < 10 ? a : b', 'x as A | B && y', 'x as T\n  < 3', 'x as -1 ? a : b', 'x as A extends B ? C : D, z', 'x as () => void, z',
    "x as import('y').T<A, B> ? a : b", 'x as Num < 10 ? a : b', 'x as T[]', 'x as T!', 'x as (value: unknown) => value is A']) {
    assert.equal(typeOf(other), -1, `${JSON.stringify(other)} is not read`);
  }
  // Type arguments are a balanced run, read without recursion: deep ones end where they close, and do not exhaust the stack.
  assert.equal(typeOf(`x as ${'Array<'.repeat(5000)}T${'>'.repeat(5000)}`), `${'Array<'.repeat(5000)}T${'>'.repeat(5000)}`);
});

// A page nested past anything written by hand still gets an answer — never an exhausted stack or heap: past the depth the check reads, a value is unread and an
// object is reported as nested too deep.
test('griffel-styles: a pathologically nested page gets one answer, not an exhausted stack', () => {
  const deep = 20000;
  const cases = [
    `{ root: { color: 'red' } as ${'true extends false ? {} : '.repeat(deep)}{} }`,
    `{ root: ${'c ? {} : '.repeat(deep)}{} }`,
    `{ root: ${'('.repeat(deep)}{}${')'.repeat(deep)} }`,
    `{ root: { ...${'(c && '.repeat(deep)}{}${')'.repeat(deep)} } }`,
    `{ root: ${"{ ':hover': ".repeat(deep)}{}${' }'.repeat(deep)} }`,
  ];
  for (const slots of cases) assert.deepEqual(names(styles(slots)), ['unread-style-object'], slots.slice(0, 60));
  const [nested] = griffelStyleProblems(styles(`{ root: ${"{ ':hover': ".repeat(100)}{}${' }'.repeat(100)} }`)).problems;
  assert.match(nested.message, /^this style object is nested deeper than the check reads \(64 levels\)/);
  assert.deepEqual(names(styles(`{ root: ${"{ ':hover': ".repeat(10)}{ borderWidth: 1 }${' }'.repeat(10)} }`)), ['borderWidth'], 'nesting a page writes is read');
});

test('griffel-styles: an animation\'s keyframes are not a style object — Griffel serializes them as written', () => {
  const keyframes = "{ from: { borderColor: 'red' }, to: { borderColor: 'blue' } }";
  assert.deepEqual(names(styles(`{ root: { animationName: ${keyframes}, animationDuration: '1s' } }`)), []);
  assert.deepEqual(names(styles(`{ root: { animationName: [${keyframes}, { '0%': { borderWidth: 1 } }], color: 'red' } }`)), []);
  // …but the key beside it is checked.
  assert.deepEqual(names(styles(`{ root: { animationName: ${keyframes}, borderColor: 'x' } }`)), ['borderColor']);
  // A SLOT called animationName is a slot like any other: Griffel reads its object as a style object, so the check does too.
  assert.deepEqual(names(styles("{ animationName: { borderWidth: '1px' } }")), ['borderWidth']);
  assert.deepEqual(names(styles('{ animationName: hidden }')), ['unread-style-object']);
});

test('griffel-styles: a slot may be named like a shorthand — slot names are not properties', () => {
  assert.deepEqual(names(styles("{ all: { color: 'red' }, borderColor: { padding: 1 }, borderWidth: { margin: 1 } }")), []);
  assert.deepEqual(names(styles("{ all: { borderWidth: 1 } }")), ['borderWidth']);
});

// ─── Text is not code ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('griffel-styles: the same names in a string, comment, template, regex, JSX text or inline style are not reported', () => {
  const source = [
    "import * as React from 'react';",
    "import { makeStyles, tokens } from '@fluentui/react-components';",
    "import { borderWidth } from './legacy';",
    '',
    '// borderWidth: 1 was removed — Griffel drops it',
    'const useStyles = makeStyles({',
    '  root: {',
    "    content: '\"borderWidth\": 1',",
    "    // borderColor: 'red',",
    "    /* borderStyle: 'solid', all: 'unset' */",
    '    boxShadow: `inset 0 0 0 1px ${tokens.colorNeutralStroke1}`,',
    "    background: 'url(\"borderBlock: x\")',",
    '    padding: tokens.spacingHorizontalM,',
    '  },',
    '});',
    '',
    'const BORDER = /borderWidth:\\s*\\d+/;',
    'const theme = { borderColor: "red", borderWidth: 1 };',
    'const inline: React.CSSProperties = { borderStyle: "solid", all: "unset" };',
    `const note = \`borderWidth: \${theme.borderWidth} borderColor: x\`;`,
    '',
    'export default function Page() {',
    '  const styles = useStyles();',
    '  return (',
    '    <div className={styles.root} style={{ borderColor: tokens.colorBrandStroke1, borderWidth: 2, borderBlock: "1px solid" }}>',
    '      borderWidth: 1 and borderColor: red are text here',
    '      <span style={{ all: "unset" }}>{BORDER.test(note) ? "borderStyle: dashed" : null}</span>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');
  const result = griffelStyleProblems(source);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.problems, []);
});

test('griffel-styles: a page with no makeStyles reports nothing, whatever else it holds', () => {
  const source = "const theme = { borderColor: 'red', borderWidth: 1, all: 'x' };\nexport default function P() { return <div style={theme} />; }\n";
  assert.deepEqual(griffelStyleProblems(source), { calls: 0, frontier: null, problems: [] });
  assert.deepEqual(griffelStyleProblems('').problems, []);
  assert.deepEqual(griffelStyleProblems(null).problems, []);
});

// ─── Which makeStyles ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('griffel-styles: makeStyles imported under another name, or as a namespace, from a Griffel module is read', () => {
  const body = "{ root: { borderWidth: 1 } }";
  const cases = [
    ["import { makeStyles as ms } from '@fluentui/react-components';\n", `const s = ms(${body});`],
    ["import { makeStyles as ms, tokens } from '@griffel/react';\n", `const s = ms(${body});`],
    ['import { makeStyles as styles } from "@griffel/core";\n', `const s = styles(${body});`],
    ["import {\n  tokens,\n  type GriffelStyle,\n  makeStyles as ms,\n} from '@fluentui/react-components';\n", `const s = ms(${body});`],
    ["import * as Fluent from '@fluentui/react-components';\n", `const s = Fluent.makeStyles(${body});`],
    ["import * as Fluent from '@fluentui/react-components';\n", `const s = Fluent?.makeStyles(${body});`],
    ["import * as Fluent from '@griffel/react';\n", `const s = Fluent . makeStyles (${body});`],
    ["import './global.css'\nimport { makeStyles } from '@fluentui/react-components'\n", `const s = makeStyles(${body})`],
    ['', `const s = makeStyles(${body});`],
    [IMPORT, `const s = makeStyles<'root'>(${body});`],
    [IMPORT, `const s = makeStyles <'root' | 'other'> (${body});`],
    [IMPORT, `export const useStyles = makeStyles(\n  ${body},\n);`],
  ];
  for (const [header, call] of cases) assert.deepEqual(names(`${header}${call}\n`), ['borderWidth'], `${header}${call}`);
});

test('griffel-styles: a makeStyles that is somebody else\'s is left alone', () => {
  const body = "{ root: { borderWidth: 1 } }";
  const cases = [
    ["import { makeStyles } from './styles';\n", `const s = makeStyles(${body});`],
    ["import { makeStyles } from '@mui/styles';\n", `const s = makeStyles(${body});`],
    ["import { makeStyles as ms } from '@mui/styles';\n", `const s = ms(${body});`],
    ["import * as Mui from '@mui/styles';\n", `const s = Mui.makeStyles(${body});`],
    ["import * as Fluent from '@fluentui/react-components';\n", `const s = other.makeStyles(${body});`],
    ["import * as Fluent from '@fluentui/react-components';\n", `const s = x.Fluent.makeStyles(${body});`],
    [IMPORT, `const s = this.makeStyles(${body});`],
    [IMPORT, `const s = notmakeStyles(${body});`],
    [IMPORT, `const s = makeStylesX(${body});`],
    [IMPORT, `const s = import('@fluentui/react-components').makeStyles${body};`],
  ];
  for (const [header, call] of cases) assert.deepEqual(names(`${header}${call}\n`), [], `${header}${call}`);
  // A declaration of a function with that name is not a call, whatever its parameters look like.
  assert.deepEqual(
    griffelStyleProblems(`${IMPORT}function makeStyles({ borderWidth }) { return 1; }\nfunction* makeStyles({ all }) { yield all; }\n`),
    { calls: 0, frontier: null, problems: [] },
  );
  // Importing the bare name from elsewhere does not hide Griffel's under an alias.
  const both = "import { makeStyles } from './local';\nimport { makeStyles as real } from '@griffel/react';\n";
  assert.deepEqual(found(`${both}const a = makeStyles(${body});\nconst b = real(${body});\n`), ['borderWidth@4:26']);
});

// makeResetStyles takes ONE style object, not slots. The work item names it, but Griffel does not drop these keys there: resolveResetStyleRules writes each key into a
// single CSS rule as it stands (createStringFromStyles) and never consults UNSUPPORTED_CSS_PROPERTIES, which only resolveStyleRules (makeStyles) does. Running both
// over `borderColor: 'red'` gives `border-color:red;` for makeResetStyles and a dropped key plus a console error for makeStyles. Refusing a page that works would be a
// false positive, so the checker leaves it alone; if a Griffel release starts dropping them, add `makeResetStyles` to STYLE_FUNCTIONS (it carries `slots: false`).
test('griffel-styles: makeResetStyles is not checked, because Griffel does not drop these keys there', () => {
  assert.deepEqual([...STYLE_FUNCTIONS.keys()], ['makeStyles']);
  const source = "import { makeResetStyles } from '@fluentui/react-components';\nconst r = makeResetStyles({ borderColor: 'red', borderWidth: 1, ':hover': { borderStyle: 'solid' } });\n";
  assert.deepEqual(griffelStyleProblems(source), { calls: 0, frontier: null, problems: [] });
});

test('griffel-styles: several calls are all read, and the problems come in source order', () => {
  const source = [
    IMPORT.trimEnd(),
    "const a = makeStyles({ root: { borderStyle: 'solid' } });",
    "const b = makeStyles({ root: { padding: 1 } });",
    "const c = makeStyles({",
    "  root: { ':hover': { borderWidth: 1 }, borderColor: 'x' },",
    '});',
    '',
  ].join('\n');
  const { calls, problems } = griffelStyleProblems(source);
  assert.equal(calls, 3);
  assert.deepEqual(problems.map((p) => `${p.property}@${p.line}:${p.column}`), ['borderStyle@2:32', 'borderWidth@5:23', 'borderColor@5:41']);
});

// ─── Positions ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('griffel-styles: a position is the line and column an editor shows — any line ending, a tab is one column, UTF-16 units, no byte order mark', () => {
  const lines = [IMPORT.trimEnd(), 'const useStyles = makeStyles({', '\troot: {', '\t\tborderWidth: 1,', '\t},', '});', ''];
  for (const eol of ['\n', '\r\n', '\r']) assert.deepEqual(found(lines.join(eol)), ['borderWidth@4:3'], JSON.stringify(eol));
  assert.deepEqual(found(`\uFEFF${lines.join('\r\n')}`), ['borderWidth@4:3'], 'a byte order mark is not a column');
  assert.deepEqual(found(`\uFEFFconst useStyles = makeStyles({ root: { borderWidth: 1 } });`), ['borderWidth@1:40'], 'nor on the first line, where it would shift the column');
  // 58 characters before the key, and each of the two emoji is two UTF-16 units: column 62 in an editor, where counting code points would say 60.
  const astral = `${IMPORT}const label = '😀😀'; const useStyles = makeStyles({ root: { borderWidth: 1 } });\n`;
  assert.deepEqual(found(astral), ['borderWidth@2:62']);
});

// ─── What cannot be read ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('griffel-styles: a call whose style object is built elsewhere is reported, never passed as clean', () => {
  const source = `${IMPORT}const base = { root: { borderWidth: 1 } };\nconst useStyles = makeStyles(base);\nconst other = makeStyles(cond ? a : b);\n`;
  const result = griffelStyleProblems(source);
  assert.equal(result.calls, 0);
  assert.equal(result.notRead, undefined, 'no list of calls left for someone to check by eye');
  assert.deepEqual(result.problems.map((p) => `${p.code}@${p.line}:${p.column}`), ['unread-style-object@3:19', 'unread-style-object@4:15']);
  assert.match(result.problems[0].message, /^this makeStyles call is given a style object written elsewhere, so the check cannot read its keys[\s\S]*makeStyles\(\{ … \}\)/);
  assert.deepEqual(griffelStyleProblems(`${IMPORT}const s = makeStyles();\n`).problems, [], 'a call with no argument has nothing to read');
});

test('griffel-styles: a call that never closes is reported, not skipped', () => {
  for (const tail of ["makeStyles({ root: { borderWidth: 1 }", "makeStyles({ root: { borderWidth: 1 } }", 'makeStyles({ root: { color: "red" }, ']) {
    const result = griffelStyleProblems(`${IMPORT}const useStyles = ${tail}\n`);
    assert.deepEqual(result.problems.map((p) => `${p.code}@${p.line}:${p.column}`), ['unbalanced-style-call@2:19'], tail);
    assert.equal(result.calls, 0);
  }
});

// The lexer says where it guessed what a `/` or `<` is (source-literals.js, onAmbiguity). `{a: 1} / 2; … /re/` reads as a regex after a block's `}` and as a division
// after an object literal's, and the lexer takes the regex: everything up to the next `/` on the line is blanked, a makeStyles call included. So nothing at or after
// the first guess is trusted, as in the navigation oracle (pageref-resolver.js) — a key there is neither reported nor passed.
const CALL = "const useStyles = makeStyles({ root: { borderWidth: 1 } });";
const GUESS = 'const o = {a: 1} / 2; const x = /re/;';

test('griffel-styles: a call that lies entirely before the lexer\'s first guess is read as usual', () => {
  const result = griffelStyleProblems(`${IMPORT}${CALL}\n${GUESS}\n`);
  assert.equal(result.frontier.kind, 'brace');
  assert.equal(result.calls, 1);
  assert.deepEqual(result.problems.map((p) => `${p.property}@${p.line}:${p.column}`), ['borderWidth@2:40']);
});

test('griffel-styles: a call at or after the first guess cannot be checked for certain', () => {
  const cases = [
    ['visible after the guess', `${IMPORT}${GUESS}\n${CALL}\n`, 'unverifiable-style-call@3:19'],
    ['blanked by the wrong guess', `${IMPORT}const o = {a: 1} / 2; ${CALL} const x = /re/;\n`, 'unverifiable-style-call@2:41'],
    ['the guess inside the call', `${IMPORT}const useStyles = makeStyles({ root: { width: ({a: 1} / 2) + 'px', borderWidth: 1 } }); const x = /re/;\n`, 'unverifiable-style-call@2:19'],
  ];
  for (const [label, source, expected] of cases) {
    const result = griffelStyleProblems(source);
    assert.deepEqual(result.problems.map((p) => `${p.code}@${p.line}:${p.column}`), [expected], label);
    assert.equal(result.calls, 0, label);
    assert.match(result.problems[0].message, /cannot (?:be checked for certain|tell for certain)/, label);
    assert.match(result.problems[0].message, /put an operand in parentheses/, label);
    assert.match(result.problems[0].message, /move the makeStyles call above it/, label);
  }
});

test('griffel-styles: a page the lexer guessed on is clean when it holds no makeStyles at all', () => {
  const result = griffelStyleProblems(`${GUESS}\nexport default function P() { return <div />; }\n`);
  assert.equal(result.frontier.kind, 'brace');
  assert.deepEqual(result.problems, []);
});

// A gate that throws leaves the orchestrator with a stack trace and no JSON, so a page cut off mid-write or garbled anywhere must still get a well-formed answer.
test('griffel-styles: a page cut off or garbled at any offset still gets a well-formed answer', () => {
  const page = [
    IMPORT.trimEnd(),
    'const useStyles = makeStyles({',
    "  root: { ':hover': { borderColor: 'red' }, padding: `${a}px`, ...(b && { all: 'unset' }) },",
    "  other: { content: '\"x\"', animationName: { from: { borderWidth: 0 } }, [`border${side}`]: 1 },",
    '});',
    'const re = /a\\/b/g;',
    'export default function P() { return <div className={useStyles().root} style={{ borderColor: "red" }}>{`t ${1}`}</div>; }',
    '',
  ].join('\n');
  const noise = ['{', '}', '(', ')', '[', ']', '<', '/', "'", '"', '`', '\\', '$'];
  const wellFormed = (result, source) => {
    const lines = source.split(/\r\n|\r|\n/).length;
    assert.equal(typeof result.calls, 'number');
    assert.ok(Array.isArray(result.problems));
    for (const p of result.problems) {
      assert.ok(Number.isInteger(p.line) && p.line >= 1 && p.line <= lines, `line ${p.line} of ${lines}`);
      assert.ok(Number.isInteger(p.column) && p.column >= 1, `column ${p.column}`);
    }
    for (const p of result.problems) assert.ok(typeof p.code === 'string' && typeof p.message === 'string');
  };
  for (let i = 0; i <= page.length; i += 1) {
    for (const source of [page.slice(0, i), ...noise.map((ch) => page.slice(0, i) + ch + page.slice(i))]) wellFormed(griffelStyleProblems(source), source);
  }
});

// ─── Where a key is, and a page against the version that is deployed ──────────────────────────────────────────────────────────────

const within = (source) => griffelStyleProblems(source).problems.map((p) => [p.property, p.within]);

test('griffel-styles: each key reports the slot, selectors and at-rules it sits under — a spread as `...`, a computed key that is not a string as `[…]`', () => {
  const source = styles("{ root: { borderWidth: 1, ':hover': { borderColor: 'red', '@media (min-width: 1px)': { borderStyle: 'solid' } } }, card: { ...(flag && { borderBlock: 'x' }), '& .child': { all: 'unset' }, [`:focus`]: { borderInline: 'y' }, [name]: { borderBlockEnd: 'z' } } }");
  assert.deepEqual(within(source), [
    ['borderWidth', ['root']],
    ['borderColor', ['root', ':hover']],
    ['borderStyle', ['root', ':hover', '@media (min-width: 1px)']],
    ['borderBlock', ['card', '...']],
    ['all', ['card', '& .child']],
    ['borderInline', ['card', ':focus']],
    // The computed key itself is held (it may be one of the ten), and the object written under it is still read.
    [undefined, ['card', '[…]']],
    ['borderBlockEnd', ['card', '[…]']],
  ]);
  // Two calls, each with its own slots.
  assert.deepEqual(within(`${styles('{ a: { all: 1 } }')}${styles('{ b: { all: 1 } }').replace(IMPORT, '')}`), [['all', ['a']], ['all', ['b']]]);
});

test('griffel-styles: griffelProblemsNotIn tells the keys a deployed page already had from the new ones — the same key in the same place first, then the same key anywhere that nothing else has claimed', () => {
  const found = (source) => griffelStyleProblems(source).problems;
  const split = (local, deployed) => {
    const { added, inherited } = griffelProblemsNotIn(found(local), found(deployed));
    return { added: added.map((p) => `${p.property}@${p.line}`), inherited: inherited.map((p) => `${p.property}@${p.line}`) };
  };
  const deployed = styles("{\n  root: { borderWidth: 1 },\n  hover: { ':hover': { borderColor: 'red' } },\n}");
  // The page as it is: every key is already there, and nothing is new.
  assert.deepEqual(split(deployed, deployed), { added: [], inherited: ['borderWidth@3', 'borderColor@4'] });
  // A key in a place the deployed page had none: the new one, and only it. The keys that were there are inherited whatever line they are on now.
  assert.deepEqual(split(styles("{\n  card: { borderStyle: 'solid' },\n  root: { borderWidth: 1 },\n  hover: { ':hover': { borderColor: 'red' } },\n}"), deployed), { added: ['borderStyle@3'], inherited: ['borderWidth@4', 'borderColor@5'] });
  // A slot renamed, a rule moved under another selector: the same key, still dropped, still not new.
  assert.deepEqual(split(styles("{\n  container: { borderWidth: 1 },\n  hover: { ':focus': { borderColor: 'red' } },\n}"), deployed), { added: [], inherited: ['borderWidth@3', 'borderColor@4'] });
  // A second key where there was one is new — and in-place matching takes the key that is where the deployed one was, so the new one is the one named, wherever it comes.
  assert.deepEqual(split(styles("{\n  root: { borderWidth: 1 },\n  card: { borderWidth: 2 },\n  hover: { ':hover': { borderColor: 'red' } },\n}"), deployed), { added: ['borderWidth@4'], inherited: ['borderWidth@3', 'borderColor@5'] });
  assert.deepEqual(split(styles("{\n  card: { borderWidth: 2 },\n  root: { borderWidth: 1 },\n  hover: { ':hover': { borderColor: 'red' } },\n}"), deployed), { added: ['borderWidth@3'], inherited: ['borderWidth@4', 'borderColor@5'] });
  // The same key twice in one object is ONE property — JavaScript keeps the last definition — so it is one key, with the last value: the value the deployed page
  // had is not new, and another value is. (That each deployed key is spent once is held by the two-hooks case below, and by two slots each with the key.)
  assert.deepEqual(split(styles("{ root: { borderWidth: 1, borderWidth: 1 } }"), styles("{ root: { borderWidth: 1 } }")), { added: [], inherited: ['borderWidth@2'] });
  assert.deepEqual(split(styles("{ root: { borderWidth: 2, borderWidth: 1 } }"), styles("{ root: { borderWidth: 1 } }")), { added: [], inherited: ['borderWidth@2'] });
  assert.deepEqual(split(styles("{ root: { borderWidth: 1, borderWidth: 2 } }"), styles("{ root: { borderWidth: 1 } }")), { added: ['borderWidth@2'], inherited: [] });
  // The same slot in two makeStyles hooks: counted across the calls, the earlier one is the deployed one.
  const hook = "{ root: { borderColor: 'red' } }";
  assert.deepEqual(split(`${styles(hook)}${styles(hook, '')}`, styles(hook)), { added: ['borderColor@3'], inherited: ['borderColor@2'] });
  // Among keys that cannot be told apart by place, the earlier one is taken as the deployed one: each deployed key is spent once.
  assert.deepEqual(split(styles("{\n  a: { borderWidth: 1 },\n  b: { borderWidth: 2 },\n}"), styles("{ root: { borderWidth: 1 } }")), { added: ['borderWidth@4'], inherited: ['borderWidth@3'] });
  // Nothing deployed (or nothing known of it): every key is new.
  for (const none of [[], undefined, null]) assert.deepEqual(griffelProblemsNotIn(found(deployed), none).inherited, []);
  assert.equal(griffelProblemsNotIn(found(deployed), []).added.length, 2);
  // A key the deployed page had of ANOTHER property does not stand in for it.
  assert.deepEqual(split(styles("{ root: { borderStyle: 'solid' } }"), styles("{ root: { borderWidth: 1 } }")), { added: ['borderStyle@2'], inherited: [] });
});

test('griffel-styles: a call the checker cannot read is never "already there", whatever the deployed page had — what it hides cannot be compared', () => {
  const unreadable = `${IMPORT}${GUESS}\n${CALL}\n`;
  const problems = griffelStyleProblems(unreadable).problems;
  assert.deepEqual(problems.map((p) => p.code), ['unverifiable-style-call']);
  const { added, inherited } = griffelProblemsNotIn(problems, problems);
  assert.deepEqual(added.map((p) => p.code), ['unverifiable-style-call']);
  assert.deepEqual(inherited, []);
  // Mixed with a key, the key can be inherited and the call is still held.
  const mixed = [...griffelStyleProblems(styles("{ root: { borderWidth: 1 } }")).problems, ...problems];
  const split = griffelProblemsNotIn(mixed, mixed);
  assert.deepEqual(split.inherited.map((p) => p.property), ['borderWidth']);
  assert.deepEqual(split.added.map((p) => p.code), ['unverifiable-style-call']);
});

const valuesOf = (source) => griffelStyleProblems(source).problems.map((p) => [p.property, p.value]);

test('griffel-styles: each key reports the value it is set to as written — a quoted string by its text, whichever quotes; anything else as its source text with the white space collapsed', () => {
  // Plain strings: the quotes do not matter, and nor do the comments around the value.
  assert.deepEqual(valuesOf(styles("{ a: { borderColor: 'red', borderStyle: \"red\", borderWidth: /* c */ 'red' /* d */, all: 'x' } }")), [
    ['borderColor', '"red"'], ['borderStyle', '"red"'], ['borderWidth', '"red"'], ['all', '"x"'],
  ]);
  // An escaped quote is read as the character: 'a\'b' and "a'b" are one string.
  assert.deepEqual(valuesOf(styles("{ a: { borderColor: 'a\\'b', borderStyle: \"a'b\" } }")), [['borderColor', '"a\'b"'], ['borderStyle', '"a\'b"']]);
  // Everything else is its text, white space collapsed: nothing is evaluated, so a token is that text whatever it resolves to and a variable is its name.
  assert.deepEqual(valuesOf(styles("{ a: { borderColor: tokens.colorBrandStroke1, borderStyle:\n   tokens .\n  colorNeutralStroke1,\n borderWidth: 1, all: `1px ${x}`, borderBlock: 'a' + 'b' } }")), [
    ['borderColor', 'tokens.colorBrandStroke1'], ['borderStyle', 'tokens . colorNeutralStroke1'], ['borderWidth', '1'], ['all', '`1px ${x}`'], ['borderBlock', "'a' + 'b'"],
  ]);
  // A shorthand member writes no value: it is the variable of the same name.
  assert.deepEqual(valuesOf(styles('{ a: { borderColor } }')), [['borderColor', 'borderColor']]);
  // A value that is a string with a different meaning is not equal to the text of an expression: "red" the string is not red the variable.
  assert.notDeepEqual(valuesOf(styles("{ a: { borderColor: 'red' } }")), valuesOf(styles('{ a: { borderColor: red } }')));
});

test('griffel-styles: a key given ANOTHER value is a new key — a reformat of it, or the same key and value moved to another slot, is not', () => {
  const found = (source) => griffelStyleProblems(source).problems;
  const split = (local, deployed) => {
    const { added, inherited } = griffelProblemsNotIn(found(local), found(deployed));
    return { added: added.map((p) => `${p.property}@${p.line}`), inherited: inherited.map((p) => `${p.property}@${p.line}`) };
  };
  const hover = (value, slot = 'row') => styles(`{\n  ${slot}: { ':hover': { borderColor: ${value} } },\n}`);
  const deployed = hover("'red'");
  // Another value, in the same place: Griffel drops it just the same, so the page would show none of the change — a new key.
  for (const value of ["'blue'", 'tokens.colorBrandStroke1', "'red' + x", '`red`', 'red']) assert.deepEqual(split(hover(value), deployed), { added: ['borderColor@3'], inherited: [] }, value);
  // The same value, written another way: not a change.
  for (const value of ['"red"', "'red' /* now blue */", "\n    'red'", "'\\x72ed'"]) assert.deepEqual(split(hover(value), deployed), { added: [], inherited: ['borderColor@3'] }, value);
  // A slot renamed, or the rule moved under another selector, with the value kept: the same key. With the value changed as well: new.
  assert.deepEqual(split(hover("'red'", 'container'), deployed), { added: [], inherited: ['borderColor@3'] });
  assert.deepEqual(split(hover("'blue'", 'container'), deployed), { added: ['borderColor@3'], inherited: [] });
  // Two slots whose values were exchanged: each value is still there once.
  const two = (a, b) => styles(`{\n  a: { borderColor: ${a} },\n  b: { borderColor: ${b} },\n}`);
  assert.deepEqual(split(two("'blue'", "'red'"), two("'red'", "'blue'")), { added: [], inherited: ['borderColor@3', 'borderColor@4'] });
  // A value used once before and twice now: the second is new, whichever slot it is in.
  assert.deepEqual(split(two("'red'", "'red'"), styles("{\n  a: { borderColor: 'red' },\n}")), { added: ['borderColor@4'], inherited: ['borderColor@3'] });
});

test('griffel-styles: a refusal and a warning say what a key is, both ways out, and — for a call that cannot be read — that it could not be read', () => {
  const keys = griffelStyleProblems(styles("{ root: { borderWidth: 1 } }")).problems;
  const unreadable = griffelStyleProblems(`${IMPORT}${GUESS}\n${CALL}\n`).problems;
  const command = 'node scripts/check-griffel-styles.js --file <page.tsx>';
  const build = { surface: 'build', subject: 'page "Detail"', command };
  const refusal = describeGriffelRefusal(keys, 'detail.tsx', build);
  assert.ok(refusal.startsWith('page "Detail" writes CSS that Griffel drops at runtime, so the page would deploy without it — detail.tsx:2:'), refusal);
  assert.ok(refusal.includes(SHORTHAND_REMEDIES));
  assert.ok(refusal.endsWith('Fix it in the page\'s source (`node scripts/check-griffel-styles.js --file <page.tsx>` lists every one), then re-run.'), refusal);
  // A note goes before the way on.
  assert.ok(describeGriffelRefusal(keys, 'detail.tsx', { ...build, note: 'Because.' }).endsWith('Because. Fix it in the page\'s source (`node scripts/check-griffel-styles.js --file <page.tsx>` lists every one), then re-run.'));
  // The upload's wording, for the same keys.
  assert.ok(describeGriffelRefusal(keys, 'x.tsx', { surface: 'upload', subject: 'x.tsx', command: 'cmd' }).startsWith('x.tsx writes CSS that Griffel drops at runtime, so the page would deploy without it — refusing to upload. x.tsx:2:'));
  // Only calls it could not read: no word about CSS that is dropped, and nothing to delete.
  const onlyUnreadable = describeGriffelRefusal(unreadable, 'detail.tsx', build);
  assert.ok(onlyUnreadable.startsWith('page "Detail" has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime — detail.tsx:'), onlyUnreadable);
  assert.doesNotMatch(onlyUnreadable, /Deleting a key|would deploy without it/);
  assert.ok(onlyUnreadable.endsWith('Change the page\'s source as that says (`node scripts/check-griffel-styles.js --file <page.tsx>` shows what it cannot read), then re-run.'), onlyUnreadable);
  // Both: the keys first, then the calls — and "them".
  const both = describeGriffelRefusal([...keys, ...unreadable], 'detail.tsx', build);
  assert.ok(both.indexOf('`borderWidth` is not supported') < both.indexOf('It also has makeStyles calls the check could not read'), both);
  assert.ok(both.endsWith('Fix them in the page\'s source (`node scripts/check-griffel-styles.js --file <page.tsx>` lists every one), then re-run.'), both);
  // The warnings: why the run goes on, per standing.
  const stands = (standing, surface = 'build') => describeGriffelWarning(keys, 'detail.tsx', { ...build, surface, standing });
  assert.ok(stands('unchanged').startsWith('page "Detail" is already deployed, and its source is the one the last build recorded for it, so this build sends it again as it is and goes on. It writes CSS that Griffel drops at runtime, so the page renders without it as it does today: detail.tsx:2:'));
  assert.ok(stands('unrecorded').startsWith('page "Detail" is already deployed, and this workspace holds no record of what the last build sent for it, so the build cannot tell whether this send changes it; it goes on, as builds did before this check. '));
  assert.ok(stands('inherited', 'upload').startsWith('page "Detail" updates a page that is already deployed, and the deployed page already had these, set the same, so the upload goes on. '));
  assert.ok(stands('undetermined', 'upload').startsWith('page "Detail" updates a page that is already deployed, and the deployed page could not be read to tell which of these it already had, so the upload goes on. '));
  for (const [standing, next] of [
    ['unchanged', 'once the page\'s source changes, the build holds it to the check and stops on anything the check still reports.'],
    ['unrecorded', 'once a build has recorded this page, a change to its source is held to the check, and the build stops on anything the check still reports.'],
  ]) assert.ok(stands(standing).includes(SHORTHAND_REMEDIES) && stands(standing).endsWith(`lists every one); ${next}`), standing);
  for (const [standing, next] of [
    ['inherited', 'an upload that adds anything the check reports, or sets one of these to another value, is refused.'],
    ['undetermined', 'when the deployed page can be read, an upload that adds anything the check reports is refused.'],
  ]) assert.ok(stands(standing, 'upload').endsWith(`lists every one); ${next}`), standing);
  // A page with only a call the check cannot read has no key to delete, and is told to make the code readable.
  const readOnly = describeGriffelWarning(unreadable, 'detail.tsx', { ...build, standing: 'unchanged' });
  assert.ok(readOnly.includes('It has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime: detail.tsx:'), readOnly);
  assert.doesNotMatch(readOnly, /Deleting a key|renders without it as it does today/);
  assert.ok(readOnly.endsWith('Edit the page\'s source to make the code readable (`node scripts/check-griffel-styles.js --file <page.tsx>` shows what it cannot read); once the page\'s source changes, the build holds it to the check and stops on anything the check still reports.'), readOnly);
  // A page with both says so: the keys first, then the calls whose contents it cannot tell.
  const mixed = describeGriffelWarning([...keys, ...unreadable], 'detail.tsx', { ...build, standing: 'unchanged' });
  assert.ok(mixed.indexOf('`borderWidth` is not supported') < mixed.indexOf('It also has makeStyles calls the Griffel check could not read, so it cannot tell whether they hold more: detail.tsx:'), mixed);
  assert.ok(mixed.includes(SHORTHAND_REMEDIES) && mixed.includes('Edit the page\'s source to do either'), mixed);
});

// ─── The CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function withPage(source, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'griffel-styles-'));
  try {
    const file = path.join(dir, 'page.tsx');
    fs.writeFileSync(file, source, 'utf8');
    return fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const runCli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

test('check-griffel-styles CLI: exit 0 and one JSON line for a page with nothing unsupported', () => {
  withPage(styles("{ root: { padding: 1, borderTopWidth: 1, ':hover': { borderBottomColor: 'red' } } }"), (file) => {
    const res = runCli('--file', file);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.split('\n').length, 2, 'one line and its newline');
    assert.deepEqual(JSON.parse(res.stdout), { ok: true, filePath: path.resolve(file), calls: 1, problems: [] });
    assert.equal(res.stderr, '');
  });
});

test('check-griffel-styles CLI: a style object written elsewhere fails the check (exit 3), never a pass', () => {
  withPage(`${IMPORT}const styles = { root: { borderWidth: '1px' } };\nconst useStyles = makeStyles(styles);\n`, (file) => {
    const res = runCli('--file', file);
    assert.equal(res.status, 3, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, false);
    assert.deepEqual(out.problems.map((p) => `${p.code}@${p.line}:${p.column}`), ['unread-style-object@3:19']);
  });
});

test('check-griffel-styles CLI: exit 3 with each key\'s property, line, column and longhands', () => {
  const source = `${IMPORT}const useStyles = makeStyles({\n  root: {\n    borderWidth: 1,\n    ':hover': { borderInline: 'x' },\n  },\n});\n`;
  withPage(source, (file) => {
    const res = runCli('--file', file);
    assert.equal(res.status, 3, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.filePath, path.resolve(file));
    assert.equal(out.calls, 1);
    assert.deepEqual(out.problems.map(({ code, property, line, column, longhands, within, value }) => ({ code, property, line, column, longhands, within, value })), [
      { code: 'unsupported-shorthand', property: 'borderWidth', line: 4, column: 5, longhands: TEN[3][1], within: ['root'], value: '1' },
      { code: 'unsupported-shorthand', property: 'borderInline', line: 5, column: 17, longhands: TEN[7][1], within: ['root', ':hover'], value: '"x"' },
    ]);
    for (const p of out.problems) assert.equal(typeof p.message, 'string');
  });
});

test('check-griffel-styles CLI: a relative path works and the result names the absolute one', () => {
  withPage(styles("{ root: { borderColor: 'red' } }"), (file, dir) => {
    const res = spawnSync(process.execPath, [SCRIPT, '--file', 'page.tsx'], { encoding: 'utf8', cwd: dir });
    assert.equal(res.status, 3);
    const { filePath } = JSON.parse(res.stdout);
    assert.ok(path.isAbsolute(filePath), filePath);
    // The temp folder may be reached through a link or a short name (macOS /var, Windows 8.3), so compare what the two paths resolve to.
    assert.equal(fs.realpathSync.native(filePath), fs.realpathSync.native(file));
  });
});

test('check-griffel-styles CLI: exit 1 when there is no file to check', () => {
  const missing = path.join(os.tmpdir(), 'griffel-styles-does-not-exist', 'page.tsx');
  for (const args of [[], ['--file'], ['--file', missing], ['--page', missing]]) {
    const res = runCli(...args);
    assert.equal(res.status, 1, JSON.stringify(args));
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, false);
    assert.equal(typeof out.error, 'string');
  }
  assert.match(JSON.parse(runCli().stdout).error, /--file is required/);
  assert.match(JSON.parse(runCli('--file', missing).stdout).error, /could not be read.*ENOENT/);
  withPage('', (file, dir) => {
    const res = runCli('--file', dir);
    assert.equal(res.status, 1, 'a folder is not a page');
    assert.equal(JSON.parse(res.stdout).ok, false);
  });
});

test('check-griffel-styles CLI: a long result is one complete JSON line — the exit does not cut the output off', () => {
  // Far more than the 64 KiB a pipe holds: on POSIX, where a pipe's writes are queued, a process.exit() straight after the write would lose the tail.
  const slots = Array.from({ length: 800 }, (_, i) => `s${i}: { borderWidth: ${i} }`).join(',\n  ');
  withPage(styles(`{\n  ${slots},\n}`), (file) => {
    const res = runCli('--file', file);
    assert.equal(res.status, 3, res.stderr);
    assert.ok(res.stdout.length > 200 * 1024, `${res.stdout.length} bytes`);
    assert.equal(res.stdout.indexOf('\n'), res.stdout.length - 1, 'one line');
    assert.equal(JSON.parse(res.stdout).problems.length, 800);
  });
});

test('check-griffel-styles CLI: checkGriffelStyles returns the exit code and the result the script prints', () => {
  withPage(styles("{ root: { all: 'unset' } }"), (file) => {
    const { exit, result } = checkGriffelStyles({ filePath: file });
    assert.equal(exit, 3);
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems.map((p) => p.property), ['all']);
  });
  assert.equal(checkGriffelStyles({}).exit, 1);
  withPage(styles("{ root: { padding: 1 } }"), (file) => assert.equal(checkGriffelStyles({ filePath: file }).exit, 0));
});

test('check-griffel-styles CLI: a call the checker cannot read for certain fails the check rather than passing it', () => {
  withPage(`${IMPORT}${GUESS}\n${CALL}\n`, (file) => {
    const res = runCli('--file', file);
    assert.equal(res.status, 3);
    assert.deepEqual(JSON.parse(res.stdout).problems.map((p) => p.code), ['unverifiable-style-call']);
  });
});

// ─── Real pages ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function walk(dir, suffix, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, suffix, out);
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

// Markdown fences: ``` or ~~~ (three or more), closed by the same fence. The plugin teaches by example, so a sample that put one of these keys in a
// makeStyles call would be the page-builder copying what this gate then refuses.
function fencedBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (!open) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !lines[end].trimStart().startsWith(open[1])) end += 1;
    blocks.push({ line: start, body: lines.slice(start, end).join('\n') });
    i = end;
  }
  return blocks;
}

test('griffel-styles: no code sample in the plugin\'s own instructions teaches a shorthand the gate refuses', () => {
  let styled = 0;
  for (const dir of ['references', 'skills', 'agents']) {
    for (const file of walk(path.join(PLUGIN, dir), '.md')) {
      for (const block of fencedBlocks(fs.readFileSync(file, 'utf8'))) {
        if (!/\bmakeStyles\b/.test(block.body)) continue;
        styled += 1;
        const { problems } = griffelStyleProblems(block.body);
        assert.deepEqual(problems.map((p) => `${p.property || p.code}@${p.line}:${p.column}`), [], `${path.relative(PLUGIN, file)}:${block.line}`);
      }
    }
  }
  assert.ok(styled > 0, 'the plugin has makeStyles samples to check');
});

test('griffel-styles: the committed pages — every sample the builder copies passes the gate, and the fixtures hold the keys the old `borderWidth` grep missed', (t) => {
  // Through `git ls-files`, not a directory walk: capture-fixture.test.js creates and deletes transient fixture folders while the suite runs (as source-literals.test.js notes).
  let pages;
  try {
    pages = execFileSync('git', ['ls-files', '-z', '*.tsx'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    t.skip('not a git checkout');
    return;
  }
  assert.ok(pages.length >= 60, `expected a real corpus, found ${pages.length}`);
  const oldGrep = /['"]?borderWidth['"]?\s*:/g;
  const tenNames = new Set(TEN.map(([property]) => property));
  let keys = 0;
  let grepHits = 0;
  const byFile = {};
  for (const page of pages) {
    const source = fs.readFileSync(path.join(REPO, page), 'utf8');
    const { problems } = griffelStyleProblems(source);
    // A sample is what the page builder is told to copy, so a refusal there would be the plugin teaching what its own gate refuses — or blocking a page that is fine.
    if (page.startsWith('plugins/model-apps/')) assert.deepEqual(problems, [], page);
    for (const p of problems) {
      assert.equal(p.code, 'unsupported-shorthand', `${page}: ${p.message}`);
      assert.ok(tenNames.has(p.property), `${page}: ${p.property}`);
      keys += 1;
      (byFile[page] ||= []).push(p.property);
    }
    grepHits += (source.match(oldGrep) || []).length;
  }
  // Captured as the model wrote them, so these pages are what the gate is for: the sales dashboard drops four keys (one of them the only one the old grep sees) and the
  // case wizard a `borderBlockEnd`, which no grep for `borderWidth` could.
  const dashboard = pages.find((page) => page.endsWith('2-mock-dashboard-real/sales-dashboard.tsx'));
  const wizard = pages.find((page) => page.endsWith('4-case-wizard/page.tsx'));
  assert.ok(dashboard && wizard, 'the two captured pages are committed');
  assert.deepEqual(byFile[dashboard].sort(), ['borderColor', 'borderColor', 'borderColor', 'borderWidth']);
  assert.deepEqual(byFile[wizard], ['borderBlockEnd']);
  assert.ok(keys > grepHits, `${keys} keys found, ${grepHits} matched by the old grep`);
});

// What genpage-upload.js does with a real page: it compares the file with the version that is deployed. A page is never new against itself, however many keys it has and wherever they
// are, and a key added to it is the one thing that is — checked on the committed pages that hold keys, which are as the model wrote them.
test('griffel-styles: griffelProblemsNotIn on the committed pages that hold keys — a page is never new against itself, and a key added to it is the only new one', (t) => {
  let pages;
  try {
    pages = execFileSync('git', ['ls-files', '-z', '*.tsx'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    t.skip('not a git checkout');
    return;
  }
  let held = 0;
  for (const page of pages) {
    const source = fs.readFileSync(path.join(REPO, page), 'utf8');
    const { problems } = griffelStyleProblems(source);
    if (!problems.length) continue;
    held += 1;
    const same = griffelProblemsNotIn(problems, problems);
    assert.deepEqual(same.added, [], `${page}: nothing is new against itself`);
    assert.equal(same.inherited.length, problems.length, page);
    const grown = `${source}\nconst addedStyles = makeStyles({ added: { borderStyle: 'solid' } });\n`;
    const { added, inherited } = griffelProblemsNotIn(griffelStyleProblems(grown).problems, problems);
    assert.deepEqual(added.map((p) => [p.property, p.within]), [['borderStyle', ['added']]], `${page}: only the key that was added`);
    assert.equal(inherited.length, problems.length, `${page}: every key it already had is still its own`);
  }
  assert.ok(held >= 2, 'the two captured pages hold keys');
});

// ─── Size ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('griffel-styles: the time grows with the page, not with its square', (t) => {
  // Each shape at a small and an 8x larger size. The casts: a keyword type before a comparison, a type name whose `<` never closes (TypeScript reads it as type
  // arguments that never close), and a run of them — each cast's type arguments are looked up, not scanned for to the end of the object, which made these quadratic.
  const SHAPES = [
    ['slots', 250, (n) => styles(`{\n${Array.from({ length: n }, (_, i) => (
      `  s${i}: { color: tokens.colorNeutralForeground${i % 7}, padding: tokens.spacingHorizontalM, margin: tokens.spacingVerticalS, ':hover': { color: tokens.colorBrandForeground1 } },`
    )).join('\n')}\n}`)],
    ['casts before a comparison', 500, (n) => styles(`{ root: { ${Array.from({ length: n }, (_, i) => `'--v${i}': size as number < 10 ? '12px' : '16px'`).join(', ')} } }`)],
    ['unclosed type arguments', 500, (n) => styles(`{ root: { ${Array.from({ length: n }, (_, i) => `'--v${i}': size as Num < 10 ? '12px' : '16px'`).join(', ')} } }`)],
    ['a run of unclosed casts', 1000, (n) => styles(`{ root: x ${'as T<'.repeat(n)} }`)],
  ];
  const medianMs = (fn, runs) => {
    const times = [];
    for (let i = 0; i < runs; i += 1) {
      const start = process.hrtime.bigint();
      fn();
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
  };
  const calibration = medianMs(() => griffelStyleProblems(SHAPES[0][2](60)), 3);
  if (calibration > 400) { t.skip(`host too slow to judge scaling (60 slots took ${calibration.toFixed(0)} ms)`); return; }
  for (const [shape, size, page] of SHAPES) {
    const small = page(size);
    const large = page(size * 8);
    griffelStyleProblems(large);
    // 8x the size is 8x the time when linear and about 64x when quadratic (a member access that re-reads the text before it did exactly that); the wide margin keeps
    // the two apart on a busy host, and a pause on one run gets two more tries.
    let ratio = Infinity;
    let timings = '';
    for (let attempt = 0; attempt < 3 && !(ratio < 25); attempt += 1) {
      const [tSmall, tLarge] = [medianMs(() => griffelStyleProblems(small), 5), medianMs(() => griffelStyleProblems(large), 5)];
      ratio = tLarge / Math.max(tSmall, 2);
      timings = `${tSmall.toFixed(1)} -> ${tLarge.toFixed(1)} ms`;
    }
    assert.ok(ratio < 25, `${shape}: 8x the size took ${ratio.toFixed(1)}x the time (${timings})`);
  }
  assert.equal(griffelStyleProblems(SHAPES[0][2](2000)).calls, 1);
});
