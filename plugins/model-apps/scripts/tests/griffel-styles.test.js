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

test('griffel-styles: a key that is not a literal name is not guessed at', () => {
  const members = [
    "[prop]: 'x'",
    "[`border${side}Width`]: 'x'",
    "['border' + 'Width']: 'x'",
    "'borderWidth ': 'x'",
    "'border-width': 'x'",
    "' borderWidth': 'x'",
    "content: '\"borderWidth\": 1'",
    "transition: 'borderWidth 1s'",
    "get borderWidth() { return 1; }",
    "set borderColor(v) {}",
    "borderStyle() { return 'solid'; }",
    "async borderBlock() {}",
  ];
  for (const member of members) {
    const source = styles(`{ root: { ${member}, color: 'red' } }`);
    assert.deepEqual(names(source), [], member);
  }
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
    ["{ root: { ...pick({ borderWidth: 1 }) } }", ['borderWidth']],
    ["{ root: { ...base, ...typographyStyles.body1, ...shorthands.padding(1) } }", []],
    ["{ root: { ...shorthands.borderColor('red'), ...shorthands.border('1px', 'solid', 'red') } }", []],
  ];
  for (const [slots, expected] of cases) assert.deepEqual(names(styles(slots)), expected, slots);
});

test('griffel-styles: an animation\'s keyframes are not a style object — Griffel serializes them as written', () => {
  const keyframes = "{ from: { borderColor: 'red' }, to: { borderColor: 'blue' } }";
  assert.deepEqual(names(styles(`{ root: { animationName: ${keyframes}, animationDuration: '1s' } }`)), []);
  assert.deepEqual(names(styles(`{ root: { animationName: [${keyframes}, { '0%': { borderWidth: 1 } }], color: 'red' } }`)), []);
  // …but the key beside it is checked.
  assert.deepEqual(names(styles(`{ root: { animationName: ${keyframes}, borderColor: 'x' } }`)), ['borderColor']);
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
  assert.deepEqual(griffelStyleProblems(source), { calls: 0, notRead: [], frontier: null, problems: [] });
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
    { calls: 0, notRead: [], frontier: null, problems: [] },
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
  assert.deepEqual(griffelStyleProblems(source), { calls: 0, notRead: [], frontier: null, problems: [] });
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

test('griffel-styles: a call whose style object is built elsewhere is listed as notRead, not passed as clean', () => {
  const source = `${IMPORT}const base = { root: { borderWidth: 1 } };\nconst useStyles = makeStyles(base);\nconst other = makeStyles(cond ? a : b);\n`;
  assert.deepEqual(griffelStyleProblems(source), {
    calls: 0,
    notRead: [{ line: 3, column: 19 }, { line: 4, column: 15 }],
    frontier: null,
    problems: [],
  });
  assert.deepEqual(griffelStyleProblems(`${IMPORT}const s = makeStyles();\n`).notRead, [], 'a call with no argument has nothing to read');
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
    assert.ok(Array.isArray(result.notRead));
    for (const p of [...result.problems, ...result.notRead]) {
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
  // The same key twice in one place (an object may repeat a name): the deployed page had it once. With the SAME value both times nothing but the count tells the two apart, so a key that is not
  // spent once it is matched in place would let both through; with another value the second is new on its value alone.
  assert.deepEqual(split(styles("{ root: { borderWidth: 1, borderWidth: 1 } }"), styles("{ root: { borderWidth: 1 } }")), { added: ['borderWidth@2'], inherited: ['borderWidth@2'] });
  assert.deepEqual(split(styles("{ root: { borderWidth: 1, borderWidth: 2 } }"), styles("{ root: { borderWidth: 1 } }")), { added: ['borderWidth@2'], inherited: ['borderWidth@2'] });
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
    assert.deepEqual(JSON.parse(res.stdout), { ok: true, filePath: path.resolve(file), calls: 1, notRead: [], problems: [] });
    assert.equal(res.stderr, '');
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
  const page = (slots) => styles(`{\n${Array.from({ length: slots }, (_, i) => (
    `  s${i}: { color: tokens.colorNeutralForeground${i % 7}, padding: tokens.spacingHorizontalM, margin: tokens.spacingVerticalS, ':hover': { color: tokens.colorBrandForeground1 } },`
  )).join('\n')}\n}`);
  const medianMs = (fn, runs) => {
    const times = [];
    for (let i = 0; i < runs; i += 1) {
      const start = process.hrtime.bigint();
      fn();
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
  };
  const small = page(250);
  const large = page(2000);
  assert.equal(griffelStyleProblems(large).calls, 1);
  const calibration = medianMs(() => griffelStyleProblems(page(60)), 3);
  if (calibration > 400) { t.skip(`host too slow to judge scaling (60 slots took ${calibration.toFixed(0)} ms)`); return; }
  // 8x the slots is 8x the time when linear and about 64x when quadratic (a member access that re-reads the text before it did exactly that); the wide margin keeps the
  // two apart on a busy host, and a pause on one run gets two more tries.
  let ratio = Infinity;
  let timings = '';
  for (let attempt = 0; attempt < 3 && !(ratio < 25); attempt += 1) {
    const [tSmall, tLarge] = [medianMs(() => griffelStyleProblems(small), 5), medianMs(() => griffelStyleProblems(large), 5)];
    ratio = tLarge / Math.max(tSmall, 2);
    timings = `${tSmall.toFixed(1)} -> ${tLarge.toFixed(1)} ms`;
  }
  assert.ok(ratio < 25, `8x the slots took ${ratio.toFixed(1)}x the time (${timings})`);
});
