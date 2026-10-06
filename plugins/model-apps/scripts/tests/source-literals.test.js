'use strict';
// Contract tests for the literal/comment blanker that backs the promotion gate and the eval's
// effect scoper. The plugin ships dependency-free, so this hand-rolled lexer stands in for a TSX
// parser — which makes its FALSE-POSITIVE behaviour (wrongly rejecting a real page) as important as
// its ability to reject prose. The corpus test below runs it over every .tsx the repo ships.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { blankLiterals, blankNonCodePreservingTemplateExpressions, commentRanges, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets, scanTemplateExpressionEnd, expressionPosition, opensTypeParameters, elementFailsAt, elementChildren, isTrivia, isSingleLineTrivia, trimTrivia, TRIVIA_CLASS, WS, AMBIGUITY_KINDS, ANGLE_AFTER, ANGLE_AFTER_LINE_BREAK, RESERVED_WORDS } = require('../lib/source-literals.js');
const { navReferencedKeys, strayPageRefs } = require('../lib/pageref-resolver.js');
const { pageStructureProblems } = require('../lib/page-structure.js');

const { loadTypescriptOracle, loadBabelOracle } = require('./helpers/typescript-oracle.js');
const { FRAMES, tokenVocabulary, programsFor, cleanSourceFile, readingAt, isElement, SIGNATURE_ENDINGS, HIDING_ENDINGS, CERTAIN_ELEMENTS, GUESSED_ELEMENTS, signaturePages, elementPages } = require('./helpers/angle-frames.js');
const { FUNCTION_TYPE_DECLARATIONS, ELEMENT_LOOKALIKE_PAGES } = require('./helpers/misread-page.js');
const { judgeDirect } = require('./helpers/jsx-element-fuzz.js');

function parseDiagnosticMessages(ts, code) {
  return ts.createSourceFile('snippet.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    .parseDiagnostics
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

function assertTsParses(ts, code, label) {
  assert.deepEqual(parseDiagnosticMessages(ts, code), [], label);
}

function assertTsRejects(ts, code, pattern, label) {
  assert.match(parseDiagnosticMessages(ts, code).join('\n'), pattern, label);
}

test('blanks comments, strings and template bodies while preserving offsets', () => {
  const src = 'const a = "hi"; // note\nconst b = `t${x}`; /* c */ const d = 1;';
  const out = blankLiterals(src);
  assert.equal(out.length, src.length, 'offsets must map 1:1');
  assert.ok(!/hi|note|t\$\{x\}|c\b/.test(out.replace('const d = 1;', '')), `leaked: ${out}`);
  assert.ok(out.includes('const d = 1;'), 'real code survives');
  assert.equal((out.match(/\n/g) || []).length, 1, 'newlines preserved');
});

test('an apostrophe in JSX text does not run away', () => {
  // JSX text IS blanked (it is text, not code) — the hazard is a stray apostrophe being read as a
  // string opener and blanking everything AFTER it too, which would hide the real export.
  const src = "export default function P(){ return <p>it's fine</p>; }\nconst after = 1;";
  const out = blankLiterals(src);
  assert.equal(out.length, src.length);
  assert.ok(out.includes('export default function P()'), 'code before the JSX survives');
  assert.ok(out.includes('const after = 1;'), 'code after the JSX survives');
  assert.ok(!out.includes("it's fine"), 'the JSX text itself is blanked');
  assert.ok(hasDefaultExport(src));
});

test('a quoted string that would span a newline is left alone', () => {
  // JS strings cannot contain a raw newline, so hitting one means the quote was not an opener.
  const src = "export default function P(){ return <p>don't</p>; }\nconst after = 1;";
  assert.ok(blankLiterals(src).includes('const after = 1;'));
});

test('hasDefaultExport rejects mentions that are not statements', () => {
  for (const bait of [
    // Prose in a failed worker response: the words appear in code position but not as a statement.
    'The worker says export default GeneratedComponent is required.\n',
    'const prose = "export default GeneratedComponent";\n',
    "const prose = 'export default P';\n",
    '/* export default */\nThis is prose\n',
    '// export default function P(){}\nconst x = 1;\n',
    'const t = `\nexport default Foo\n`;\n',
    'export default;\n',
    'export function P() {}\n',
    '',
  ]) {
    assert.equal(hasDefaultExport(bait), false, `wrongly accepted: ${JSON.stringify(bait)}`);
  }
});

test('hasDefaultExport accepts every legitimate spelling', () => {
  for (const ok of [
    'export default function P(){ return null; }\n',
    'export default async function P(){ return null; }\n',
    'export default class P {}\n',
    'const P = () => null;\nexport default P;\n',
    'export default memo(function P(){ return null; });\n',
    'export default {\n  render() { return null; }\n};\n',
    'function P(){}\nexport { P as default };\n',
    "export { default } from './P';\n",
    '/**\n * export default is required\n */\nexport default function P(){ return null; }\n',
  ]) {
    assert.equal(hasDefaultExport(ok), true, `wrongly rejected: ${JSON.stringify(ok)}`);
  }
});

test('JSX text is text, not code — the false-positive cases that block real users', () => {
  // Each of these is ordinary generated-page content that a regex-only scanner misreads.
  const cases = {
    'URL in JSX text (`//` is not a comment)': 'export default function P() {\n  return <p>https://contoso.com/help</p>;\n}\n',
    'numbered JSX text (`)` is not a bracket)': 'export default function P() {\n  return <p>1) Review details</p>;\n}\n',
    'regex literal (`(` is not a bracket)': 'const re = /\\(/;\nexport default function P(){ return <div/>; }\n',
    'regex with a character class': 'const re = /[/(]/g;\nexport default function P(){ return <div/>; }\n',
    'astral char (offsets must stay UTF-16 aligned)': 'const e = "\u{1F600}(";\nexport default function P(){ return <div/>; }\n',
    'nested element inside a .map() expression': 'export default function P(){ return <div>{items.map(x => { return (<section>{x}</section>); })}</div>; }\n',
    'TSX generic arrow (`<K extends …>` is not JSX)': 'const f = <K extends keyof T>(k: K) => k;\nexport default function P(){ return <div/>; }\n',
    'TSX generic arrow, comma form': 'const f = <T,>(x: T) => x;\nexport default function P(){ return <div/>; }\n',
    'generic arrow with an object constraint': 'const pick = <T extends { id: string }>(x: T) => x.id;\nexport default function P(){ return <div/>; }\n',
    // The one-parameter form needs the comma in a .tsx file: `<T>(x: T): T => x` is an element to TypeScript there (see opensTypeParameters).
    'generic arrow with a return-type annotation': 'const f = <T,>(x: T): T => x;\nexport default function P(){ return <div/>; }\n',
    'generic arrow, braces on both sides': 'const f = <T extends { a: { b: string } }>(x: T): { r: T } => ({ r: x });\nexport default function P(){ return <div/>; }\n',
    // `;` inside an object type is not a statement terminator, and the `>` of a function type's `=>`
    // is not the generic's closing angle — both are depth-sensitive.
    'object-type constraint with semicolons': 'const getId = <T extends { id: string; name: string }>(row: T) => row.id;\nexport default function P(){ return <div/>; }\n',
    'function-type constraint (contains its own `=>`)': 'const debounce = <T extends (...args: unknown[]) => void>(fn: T) => fn;\nexport default function P(){ return <div/>; }\n',
    'return object type with semicolons': 'const toOption = <T,>(v: T): { key: string; value: T } => ({ key: String(v), value: v });\nexport default function P(){ return <div/>; }\n',
    'generic with a nested type argument': 'const f = <T extends Record<string, number>>(x: T) => x;\nexport default function P(){ return <div/>; }\n',
    'generic with a default type parameter': 'const f = <T extends Record<string, unknown> = Record<string, never>>(x: T) => x;\nexport default function P(){ return <div/>; }\n',
    'type parameters split across lines': 'const f = <\n  T extends object\n>(x: T) => x;\nexport default function P(){ return <div/>; }\n',
    'JSX text containing an open paren': 'export default function P(){ return <button>(</button>; }\n',
    'JSX text containing balanced parens': 'export default function P(){ return <div>(text) here</div>; }\n',
    'JSX text containing an arrow': 'export default function P(){ return <p>(a) => b</p>; }\n',
    // Ordinary Fluent UI V9 / Dataverse page shapes — `<` after an identifier is a type argument,
    // not JSX, and must not switch modes.
    'useState with a generic argument': 'const [rows, setRows] = useState<Item[]>([]);\nexport default function P(){ return <div/>; }\n',
    'useRef with a union generic': 'const ref = useRef<HTMLDivElement | null>(null);\nexport default function P(){ return <div/>; }\n',
    'comparison inside a JSX expression': 'export default function P(){ return <div>{a < b ? <X/> : <Y/>}</div>; }\n',
    'generic component with children': 'export default function P(){ return <List<Item> items={x}><Row/></List>; }\n',
    'JSX comment': 'export default function P(){ return <div>{/* note */}<A/></div>; }\n',
    // A signature may carry its own trivia; a `;` or `(` inside a comment or string is not structural.
    'comment inside the type-parameter list': 'const preserveRow = <T extends Record<string, unknown>, // preserve fields; do not widen\n>(row: T) => row;\nexport default function P(){ return <div/>; }\n',
    'block comment inside the signature': 'const f = <T /* keep wide */ extends object>(x: T) => x;\nexport default function P(){ return <div/>; }\n',
    'string literal type in a constraint': 'const pickKey = <T extends { kind: "a" | "b" }>(x: T) => x.kind;\nexport default function P(){ return <div/>; }\n',
    'JSX with an explicit type argument': 'export default function P(){ return <Table<Row> rows={r} />; }\n',
    'fragment': 'export default function P(){ return <><span>a</span><span>b</span></>; }\n',
    'comparison operators': 'const b = a < c && c > a;\nexport default function P(){ return <div/>; }\n',
    // #542. A `//` or `/* */` comment BETWEEN ATTRIBUTES in a JSX opening tag is valid TSX and a
    // natural thing for a generator to emit when explaining an attribute. `jsxTag` mode had no
    // comment handling at all, so an apostrophe inside one was read as an attribute-value quote,
    // which then ran to EOF (the attribute scanner does not stop at a newline, because a JSX
    // attribute value legitimately may span lines). That blanked the real `export default` and
    // miscounted every bracket after it, so promotion rejected a complete page as "truncated" —
    // and because promotion is transactional, one such page blocked the whole batch.
    'in-tag line comment': 'export default function P(){ return <button\n  type="button"\n  // wins over the base border shorthand\n  className={x}\n>hi</button>; }\n',
    'in-tag line comment with an apostrophe': 'export default function P(){ return <button\n  type="button"\n  // wins over Griffel\'s atomic output\n  className={x}\n>hi</button>; }\n',
    'in-tag block comment with an apostrophe': 'export default function P(){ return <button\n  type="button"\n  /* Griffel\'s atomic output wins */\n  className={x}\n>hi</button>; }\n',
    'in-tag comment containing a quote and a bracket': 'export default function P(){ return <button\n  // don\'t count this ( or this "\n  className={x}\n>hi</button>; }\n',
    'in-tag comment before a self-closing tag': 'export default function P(){ return <div><Icon\n  // Griffel\'s output\n  aria-hidden\n/></div>; }\n',
    // The other position a `//` can appear inside a tag WITHOUT being a comment: a template-literal
    // TYPE argument. Its content is data, so it must be consumed whole — otherwise the comment
    // branch above blanks to end of line and rejects a valid module.
    'template-literal type argument containing `//`': 'export default function P(){ return <C<`https://${string}`> />; }\n',
    'template-literal type argument containing `/*`': 'export default function P(){ return <C<`a/*b`> />; }\n',
  };
  for (const [name, code] of Object.entries(cases)) {
    assert.equal(hasDefaultExport(code), true, `default export missed: ${name}`);
    assert.equal(hasUnbalancedBrackets(code), false, `falsely unbalanced: ${name}`);
  }
});

test('a large inline generic signature stays within the lookahead window', () => {
  // The generic-vs-JSX scan is bounded so a stray `<` cannot make it walk the whole file. The bound
  // has to clear a realistic signature: this one carries a 34-member inline return object type.
  const members = Array.from({ length: 34 }, (_, i) => `field${i}: string;`).join(' ');
  const code = `const wide = <T,>(v: T): { ${members} } => ({} as never);\nexport default function P(){ return <div/>; }\n`;
  assert.equal(hasDefaultExport(code), true);
  assert.equal(hasUnbalancedBrackets(code), false);
});

test('hasUnbalancedBrackets flags a truncated write but tolerates JSX and generics', () => {
  assert.equal(hasUnbalancedBrackets('export default function P() {\n  return <div>\n'), true);
  assert.equal(hasUnbalancedBrackets('const a = (1;\n'), true);
  // `<` / `>` are never counted: JSX and TS generics make them legitimately unbalanced.
  assert.equal(hasUnbalancedBrackets('const x: Array<Record<string, number>> = [];\nexport default () => <div a={1} />;\n'), false);
  // Brackets inside strings/comments must not count.
  assert.equal(hasUnbalancedBrackets('const s = "{{{"; // )))\nexport default () => null;\n'), false);
  // ...but blanking a comment must not become a way to HIDE a real defect. A template-literal type
  // argument in a tag is consumed as data, so a malformed expression after it on the same line is
  // still visible. (When the `//` inside the template was mistaken for a comment, the rest of the
  // line — including this `{(}` — was blanked and the file read as balanced.)
  assert.equal(hasUnbalancedBrackets('export default function P() {\n  return <C<`https://${string}`> value={(} />;\n}\n'), true);
});

// A cut that leaves every bracket balanced: inside JSX, a string, a template or a comment, or right
// after a token that needs more. A complete module ends in plain code.
test('endsMidStatement catches a cut that leaves every bracket balanced', () => {
  const ok = 'import * as React from "react";\nconst Inner = () => null;\n';
  for (const [what, code] of [
    ['inside a tag name', 'export default (props) => <GeneratedCompo'],
    ['inside an attribute string', 'export default (props) => <GeneratedComponent title="x'],
    ['inside JSX text', 'export default () => <div>Loading'],
    ['inside a JSX expression', 'export default () => <div>{count'],
    ['inside a closing tag', 'export default () => <div>ok</div'],
    ['inside a self-closing tag', 'export default () => <Icon /'],
    ['inside a template', `${ok}export default Inner;\nconst note = \`unfinished`],
    ['inside a block comment', `${ok}export default Inner;\n/* trailing`],
    ['inside a string', `${ok}export default Inner;\nconst s = "abc`],
    ['inside a regex', `${ok}export default Inner;\nconst r = /ab`],
    ['after an operator', `${ok}export default Inner;\nconst total = count *`],
    ['after a dot', `${ok}export default React.`],
    ['after `new`', `${ok}export default Inner;\nconst x = new`],
    ['after `=>`', 'export default (props) =>'],
    // A statement keyword cannot end a module either: cut right after one, following a complete export.
    ['after a trailing `export`', `${ok}export default Inner;\nexport`],
    ['after a trailing `export const`', `${ok}export default Inner;\nexport const`],
    ['after a trailing `function`', `${ok}export default Inner;\nfunction`],
  ]) {
    assert.equal(endsMidStatement(code), true, what);
  }
  for (const [what, code] of [
    ['a normal page', `${ok}export default Inner;\n`],
    ['JSX as the last thing', 'export default () => <div>ok</div>'],
    ['a self-closing tag as the last thing', 'export default () => <Icon />'],
    ['a line comment as the last thing', `${ok}export default Inner; // done`],
    ['a postfix increment as the last thing', 'let x = 0;\nx++'],
    ['a non-null assertion as the last thing', 'const y = x!'],
    ['a regex as the last thing', 'const r = /a+/'],
    ['a complete template as the last thing', 'const t = `a ${b} c`'],
    // A keyword reached as a property, and `void` as a type, can end a statement.
    ['a type ending in void', `${ok}export default Inner;\ntype Handler = (e: Event) => void`],
    ['a declared function returning void', `${ok}export default Inner;\ndeclare function track(e: string): void`],
    ['a keyword-named property as the last thing', `${ok}export default Inner;\nexport const w = counts.new`],
    ['an optional keyword-named property as the last thing', `${ok}export default Inner;\nexport const w = counts?.new`],
    ['a property named delete as the last thing', `${ok}export default Inner;\nexport const d = api.delete`],
    ['a property named default as the last thing', `${ok}export default Inner;\nexport const e = mod.default`],
    ['a debugger statement as the last thing', `${ok}export default Inner;\ndebugger`],
  ]) {
    assert.equal(endsMidStatement(code), false, what);
  }
});

// Ground truth from a real parser: for each valid module, the gates accept the whole module, and any
// prefix they accept (a cut the gates cannot see) must itself parse — a syntactically complete module,
// such as `export default React` cut from `export default React.memo(Inner);`. The modules are plain
// JavaScript because Node's parser takes no JSX or TypeScript, and each ends with its default export:
// a cut inside code AFTER a complete export can stop at a point that balances and ends on a name
// (`…\nfunction helper() `), which only the build's compile step catches — a documented limit. A
// child process runs the scan, since vm.SourceTextModule needs --experimental-vm-modules.
test('every prefix the gates accept is a module a real parser accepts', () => {
  const modules = [
    'function GeneratedComponent() { return 1; }\nexport default GeneratedComponent;\n',
    'const GeneratedComponent = () => { const a = [1, 2]; return a.map((x) => x * 2); };\nexport default GeneratedComponent;\n',
    'export default function GeneratedComponent(props) { const s = `a ${props.b} c`; return s.replace(/\\/*$/, ""); }\n',
    'import * as React from "react";\nconst Inner = () => null;\nexport default React.memo(Inner);\n',
    'export default async (x) => { await x; return x; };\n',
    'export default class Page { render() { return null; } }\n',
    'const Header = () => null, GeneratedComponent = () => Header;\nexport default GeneratedComponent;\n',
    'export default (async (x) => x);\n',
    'let count = 0;\nfor (const x of [1, 2]) if (x) /\\(/.test(String(x)) && count++;\nexport default function P() { return count; }\n',
    'const counts = { new: 3 }, total = 8;\nconst pct = Math.round((counts.new / total) * 100);\nexport default function P() { return `${pct}% new`; }\n',
    'import { a as b } from "./x";\nconst { c: GeneratedComponent } = b;\nexport default GeneratedComponent;\n',
  ];
  const script = `
    const vm = require('node:vm');
    const sl = require(${JSON.stringify(require.resolve('../lib/source-literals.js'))});
    const parses = (code) => { try { new vm.SourceTextModule(code); return true; } catch { return false; } };
    const accepts = (code) => sl.hasDefaultExport(code) && !sl.hasUnbalancedBrackets(code) && !sl.endsMidStatement(code);
    const out = { unparsable: [], rejected: [], brokenCuts: [] };
    for (const m of ${JSON.stringify(modules)}) {
      if (!parses(m)) { out.unparsable.push(m); continue; }
      if (!accepts(m)) out.rejected.push(m);
      for (let L = 1; L < m.length; L += 1) {
        const p = m.slice(0, L);
        if (accepts(p) && !parses(p)) out.brokenCuts.push(p);
      }
    }
    process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.unparsable, [], 'every sample module is valid JavaScript');
  assert.deepEqual(out.rejected, [], 'no complete module is refused');
  assert.deepEqual(out.brokenCuts, [], 'no prefix that fails to parse is accepted');
});

// Inside `${…}` a `/` is a regex or a division depending on the CODE before it. A comment's last word
// is not that code, in either direction.
test('a closed TypeScript type assertion inside a template expression is an operand before division', () => {
  const code = [
    'import React from "react";',
    'const total = 12, count = 2;',
    'const label = `${total as NonNullable<number> / count}/month`;',
    'const GeneratedComponent = () => React.createElement("span", null, label);',
    'export default GeneratedComponent;',
  ].join('\n');
  assert.equal(hasDefaultExport(code), true);
  assert.equal(hasUnbalancedBrackets(code), false);
  assert.equal(endsMidStatement(code), false);
});

test('an arrow before a regex is not mistaken for a generic close', () => {
  const code = 'const pattern = count<limit ? () => /\\(/ : () => /none/;\nexport default function P(){ return null; }';
  assert.equal(hasDefaultExport(code), true);
  assert.equal(hasUnbalancedBrackets(code), false);
  assert.equal(endsMidStatement(code), false);
});

test('spaced type arguments after a type assertion are operands before division', () => {
  const code = [
    'const total = 12, count = 2;',
    'const label = `${total as NonNullable< number > / count}/month`;',
    'const GeneratedComponent = () => label;',
    'export default GeneratedComponent;',
  ].join('\n');
  assert.equal(hasDefaultExport(code), true);
  assert.equal(hasUnbalancedBrackets(code), false);
  assert.equal(endsMidStatement(code), false);
});

test('a complete multiline JSX self-closing tag at EOF is not mid-statement', () => {
  const code = 'export default () => <div\n  title="Ready"\n/>';
  assert.equal(endsMidStatement(code), false);
});

test('a comment inside a template expression does not decide what a following slash is', () => {
  const exprEnd = (src) => scanTemplateExpressionEnd(src, src.indexOf('${') + 2);
  // The comment ends in `:`, which would read as a regex start — but `total / count` is a division.
  const division = 'const label = `${total // per row, then:\n  / count} items`;';
  assert.equal(exprEnd(division), division.indexOf('} items'));
  // The comment ends in a plain word, which would read as division — but this is a regex, and the
  // `}` inside it must not close the expression.
  const regex = 'const s = `${\n  // drop a trailing brace\n  /\\}$/.test(v)\n}`;';
  assert.equal(exprEnd(regex), regex.lastIndexOf('}'));
  // Same with a block comment, and with no comment at all.
  const block = 'const s = `${ /* brace: */ /\\}$/.test(v) }`;';
  assert.equal(exprEnd(block), block.lastIndexOf('}'));
  assert.equal(exprEnd('`${a /* c */} tail`'), '`${a /* c */} tail`'.indexOf('} tail'), 'a `}` right after a comment still closes');
  assert.equal(exprEnd('`${a / b} tail`'), '`${a / b} tail`'.indexOf('} tail'));
  // ...and the page as a whole keeps its export.
  const page = `${division}\nexport default function Page() { return null; }\n`;
  assert.equal(hasDefaultExport(page), true);
  assert.equal(hasUnbalancedBrackets(page), false);
});

// A `${…}` body is code and is read by the full lexer, JSX included. A brace scanner that knew no JSX
// took the `/` of `</span>` for a regex that swallowed the closing `}`, and an apostrophe in JSX text
// for a string; either way the template never ended and the page's export was blanked with it.
test('JSX inside a template expression is read as JSX', () => {
  const exprEnd = (src) => scanTemplateExpressionEnd(src, src.indexOf('${') + 2);
  for (const expr of [
    '<span>Save</span>',
    "<p>it's here</p>",
    '<a href={u}>go</a>',
    'items.map((i) => <li key={i}>{i}</li>)',
    '<Icon />',
  ]) {
    const line = `const x = \`\${${expr}}\`;`;
    assert.equal(exprEnd(line), line.lastIndexOf('}'), expr);
    const page = `${line}\nexport default function GeneratedComponent() { return 1; }\n`;
    assert.equal(hasDefaultExport(page), true, expr);
    assert.equal(hasUnbalancedBrackets(page), false, expr);
  }
  // Plain braces inside the expression nest; the expression ends at the brace that closes it.
  const obj = 'const s = `${fmt({ a: 1, b: { c: 2 } })} tail`;';
  assert.equal(exprEnd(obj), obj.indexOf('} tail'));
  // Output cut off inside the expression still terminates, without throwing.
  assert.equal(exprEnd('const x = `${<p>unfinished'), 'const x = `${<p>unfinished'.length);
});

// A keyword read back before a `/` or `<` means an expression starts — unless it is only a property
// NAME, or what precedes is a postfix operator ending an operand.
test('a keyword-named property or a postfix operator is an operand, not an expression start', () => {
  const at = (src) => expressionPosition(src, src.length);
  assert.equal(at('return '), true);
  assert.equal(at('x = typeof '), true);
  assert.equal(at('counts.new '), false, 'a property named `new`');
  assert.equal(at('counts?.in '), false, 'optional chaining reaches a property too');
  assert.equal(at('counts.\n  new '), false, 'across a line break');
  assert.equal(at('[...new '), true, "a spread's `...new` is the keyword");
  assert.equal(at('closed! '), false, 'a non-null assertion ends the operand');
  assert.equal(at('return !'), true, 'a prefix `!` starts one');
  assert.equal(at('(!!'), true);
  assert.equal(at('i++ '), false);
  assert.equal(at('i-- '), false);
  assert.equal(at('a + '), true, 'a binary `+` does not end an operand');
  // A `)` ends an operand, unless it closes a statement head: then a statement starts after it.
  assert.equal(at('(a + b) '), false);
  assert.equal(at('counts.get(k)! '), false, 'a non-null assertion on a call result');
  assert.equal(at('if (bad) '), true);
  assert.equal(at('if (bad) !'), true, 'the `!` after an `if (…)` head is a prefix `!`');
  assert.equal(at('for (const x of xs) '), true);
  assert.equal(at('for await (const x of xs) '), true, 'the head keyword sits before `await`');
  assert.equal(at('while (next(a, (b))) '), true, 'nested parentheses in the head');
  assert.equal(at('obj.if(a) '), false, 'a method named `if` is not a statement head');
  assert.equal(at('"a" '), false, 'a string literal ends an operand: `"a" / 2` divides');
  assert.equal(at('x) '), false, 'a `)` with no `(` to match ends an operand');
  // End to end: each divides, so the page is complete; the prefix `!` still opens a regex.
  for (const body of [
    'const pct = <Text>{counts.new / total}</Text>;',
    'const pct = <Text>{closed! / total}</Text>;',
    'const pct = `${Math.round((counts.new / total) * 100)}% new`;',
    'const half = <Text>{i++ / 2}</Text>;',
    'const noParen = (s) => !/\\(/.test(s);',
    'if (bad) !/\\(/.test(s) || warn();',
    'if (s) /\\(/.test(s) && warn();',
    'async function run() { for await (const x of items) /\\(/.test(String(x)); }',
    'const pct = counts.get("new")! / total;',
  ]) {
    const code = `export default function P() {\n  ${body}\n  return <div/>;\n}\n`;
    assert.equal(hasDefaultExport(code), true, body);
    assert.equal(hasUnbalancedBrackets(code), false, body);
  }
});

// A write cut off INSIDE its export statement matches the export pattern and balances, because the
// cut came before any bracket was opened. The export has to be complete.
test('hasDefaultExport requires the export itself to be complete', () => {
  const imp = 'import * as React from "react";\n';
  for (const [what, code] of [
    ['a function declaration', `${imp}export default function GeneratedComponent(props: P) {\n  return <div/>;\n}\n`],
    ['a generator with generics, defaults and destructuring', `${imp}export default function* gen<T>(a = (1), { b }: { b: T }): Iterable<T> { yield b; }\n`],
    ['an anonymous function', 'export default function (props) { return null; }\n'],
    ['a class', 'export default class Page extends React.Component<P> { render() { return null; } }\n'],
    ['a declared name', 'const GeneratedComponent = () => null;\nexport default GeneratedComponent;\n'],
    ['a declared name at EOF, no semicolon', 'const GeneratedComponent = () => null;\nexport default GeneratedComponent'],
    ['a hoisted function declared after', 'export default Page;\nfunction Page() { return null; }\n'],
    ['an imported name', 'import Page from "./page";\nexport default Page;\n'],
    ['a destructured name', 'const { Page } = lib;\nexport default Page;\n'],
    ['a name with $', 'const $Page = () => null;\nexport default $Page;\n'],
    ['a name, then another statement', 'const A = 1;\nexport default A; const b = 2;\n'],
    ['an expression', 'const P = () => null;\nexport default React.memo(P);\n'],
    ['an async arrow', 'export default async (x) => { return x; };\n'],
    // A `{` where a TYPE is expected is not the body; the body comes after it.
    ['an object return type, then the body', 'export default function P(props): { id: string } {\n  return { id: "x" };\n}\n'],
    ['a union of object types', 'export default function P(): { a: 1 } | { b: 2 } { return { a: 1 }; }\n'],
    ['a generic return type', 'export default async function P(): Promise<{ ok: boolean }> { return { ok: true }; }\n'],
    ['a function-type return', 'export default function P(): () => { c: 1 } { return () => ({ c: 1 }); }\n'],
    ['a type predicate', 'export default function isX(x: unknown): x is { d: 1 } { return !!x; }\n'],
    ['type parameters holding a function type', 'export default function P<T extends (a: string) => void>(cb: T) { cb("x"); }\n'],
    ['the body brace on its own line', 'export default function P(props)\n{\n  return null;\n}\n'],
    ['a class with an object type argument', 'export default class Foo extends React.Component<{ id: string }> { render() { return null; } }\n'],
    ['a class extending a call', 'export default class Foo extends mixin({ a: 1 }) { }\n'],
    ['an abstract class', 'export default abstract class Foo { }\n'],
    ['an async arrow with a bare parameter', 'export default async x => x;\n'],
    ['a name that is also a modifier', 'const async = () => null;\nexport default async;\n'],
    ['a renamed import', 'import { X as Page } from "./x";\nexport default Page;\n'],
    ['a namespace import', 'import * as Page from "./x";\nexport default Page;\n'],
    ['a destructured key alias', 'const { a: Page } = lib;\nexport default Page;\n'],
    ['an array destructuring', 'const [Page] = list;\nexport default Page;\n'],
    ['a generator declared with the star on its name', 'function *Page() { yield 1; }\nexport default Page;\n'],
    // A later declarator of a list, even past a comma inside type arguments.
    ['a later declarator', 'const Header = () => null, GeneratedComponent = () => null;\nexport default GeneratedComponent;\n'],
    ['a later declarator with a type', 'let count = 0, GeneratedComponent: React.FC = () => null;\nexport default GeneratedComponent;\n'],
    ['a declarator after type arguments', 'const cache = new Map<string, number>(), Page = () => null;\nexport default Page;\n'],
    ['a bare let declarator', 'let count = 0, Page;\nPage = () => null;\nexport default Page;\n'],
    ['a definite-assignment declarator', 'let count = 0, Page!: React.FC;\nPage = () => null;\nexport default Page;\n'],
    ['a pattern as a later declarator', 'const a = 1, { Page } = lib;\nexport default Page;\n'],
    ['an expression ending in a type assertion', 'const P = () => null;\nexport default P as React.FC;\n'],
    ['a parenthesized function expression at the end', 'export default (function P() { return null; })'],
    ['a parenthesized typed function expression at the end', 'export default (function P(): void { })'],
    ['a parenthesized name at the end', 'function GeneratedComponent() { return 1; }\nexport default (GeneratedComponent)'],
    ['a parenthesized async arrow at the end', 'export default (async (x) => x)'],
    ['a parenthesized ternary at the end', 'const A = 1, B = 2;\nexport default (ok ? A : B)'],
    ['a parenthesized object at the end', 'export default ({ a: 1 })'],
    ['a parenthesized arrow with a return type at the end', 'export default ((props: P): JSX.Element => <Page {...props} />)'],
    ['a typed arrow export', 'export default (props: P): JSX.Element => <Page {...props} />;\n'],
    ['an untyped arrow export with a return type', 'export default (props): JSX.Element => <Page {...props} />;\n'],
    ['a ternary after a leading group', 'const a = 1, b = 2, c = 3;\nexport default (a) ? b : c'],
    ['a spread inside a call in the group', 'const f = (...x) => x, args = [];\nexport default (f(...args))'],
    ['an arrow with its body', 'export default (props) => null;\n'],
    ['an array pattern inside an object pattern', 'const { a: [Page] } = lib;\nexport default Page;\n'],
    // A member chain followed by a line break is a complete statement (a cut would have removed it).
    ['a member chain on its own line', 'import * as React from "react";\nexport default React.memo\n'],
    ['a syntactically complete member chain at EOF (documented cut limit)', 'import * as React from "react";\nconst Inner = () => null;\nexport default React.memo'],
    ['a syntactically complete partial member name at EOF (documented cut limit)', 'import * as React from "react";\nconst Inner = () => null;\nexport default React.mem'],
    ['a member chain at EOF', 'const pages = { Home: () => null };\nexport default pages.Home'],
    ['an imported namespace member chain at EOF', 'import * as UI from "@fluentui/react-components";\nexport default UI.Spinner'],
    ['a typed object member chain at EOF', 'const pages: Record<string, () => null> = { Home: () => null };\nexport default pages.Home'],
    ['a return type naming a property like a statement word', 'export default function P(): Schema.module { return null as any; }\n'],
    // Overload signatures come before the body; any complete `export default` will do.
    ['overloads', 'export default function f(x: string): string;\nexport default function f(x: any) { return x; }\n'],
    // Identifiers may be non-ASCII.
    ['a non-ASCII function name', 'export default function Página(props) { return null; }\n'],
    ['a non-ASCII exported name', 'const Página = () => null;\nexport default Página;\n'],
    ['an exported name starting non-ASCII', 'const Ñame = () => null;\nexport default Ñame;\n'],
  ]) {
    assert.equal(hasDefaultExport(code), true, what);
  }
  for (const [what, code] of [
    ['cut after the parameter list', `${imp}export default function GeneratedComponent(props: P)`],
    ['cut after a return type', `${imp}export default function GeneratedComponent(props: P): JSX.Element`],
    ['cut after an object return type', `${imp}export default function GeneratedComponent(props): { id: string }`],
    ['cut after a union return type', `${imp}export default function P(): { a: 1 } | { b: 2 }`],
    ['cut after the type parameters', `${imp}export default function P<T extends { id: string }>`],
    ['cut inside the type parameters', `${imp}export default function P<T`],
    ['cut after the name', `${imp}export default function GeneratedComponent`],
    ['cut inside the keyword', `${imp}export default func`],
    ['cut in a class header', `${imp}export default class Page extends React.Component<P>`],
    ['cut after a class type argument', `${imp}export default class Foo extends React.Component<{ id: string }>`],
    ['a header followed by another statement', `${imp}export default function GeneratedComponent()\nconst x = { a: 1 };`],
    ['a header followed by an if', `${imp}export default function GeneratedComponent()\nif (true) { return 1; }`],
    ['a header followed by a try', `${imp}export default function GeneratedComponent()\ntry { run(); } catch (e) { log(e); }`],
    ['a header followed by a with', `${imp}export default function GeneratedComponent()\nwith (obj) { return 1; }`],
    ['a header followed by an interface', `${imp}export default function GeneratedComponent()\ninterface Foo { a: number }`],
    ['a header followed by an enum', `${imp}export default function GeneratedComponent()\nenum Foo { A }`],
    ['a header followed by a namespace', `${imp}export default function GeneratedComponent()\nnamespace Foo { export const x = 1; }`],
    ['a header followed by a module', `${imp}export default function GeneratedComponent()\nmodule Foo { }`],
    ['a header followed by a declare', `${imp}export default function GeneratedComponent()\ndeclare const x: number;`],
    ['cut in an abstract class header', `${imp}export default abstract class Foo`],
    ['cut inside the keyword after abstract', `${imp}export default abstract clas`],
    ['cut right after async', `${imp}export default async`],
    ['cut inside the keyword after async', `${imp}export default async functi`],
    ['cut at an arrow', `${imp}export default (props) =>`],
    ['cut at an async arrow', `${imp}export default async (x) =>`],
    ['only an overload signature', 'export default function f(x: string): string;\nexport default function f(x: any)'],
    ['cut mid-name', 'const GeneratedComponent = () => null;\nexport default GeneratedComp'],
    ['a name the module never has', 'export default Page;\n'],
    ['a name only a string mentions', 'const s = "Page";\nexport default Page;\n'],
    // Mentioned, but never bound at module level.
    ['cut to the `as` of an import', 'import * as React from "react";\nexport default as'],
    ['a name only a parameter binds', 'const f = (a) => a.id;\nexport default a'],
    ['a name only a property carries', 'const o = { Page: 1 };\nexport default Page;\n'],
    ['a name that is only a destructuring key', 'const { Page: other } = lib;\nexport default Page;\n'],
    ['a name renamed away on import', 'import { Page as Other } from "./x";\nexport default Page;\n'],
    ['a name inside a destructuring that never closes', 'const { Page\nexport default Page;\n'],
    ['the `as` of a renamed import', 'import { Button as FluentButton } from "@fluentui/react-components";\nexport default as'],
    ['the `type` keyword of an import', 'import { type Foo } from "./x";\nexport default type'],
    ['a name only an array literal holds', 'const list = [a, Page];\nexport default Page;\n'],
    ['a const declarator with no initializer', 'const Header = 1, as\nexport default as'],
    ['a computed destructuring key', 'const { [GeneratedComponent]: x } = obj;\nexport default GeneratedComponent;\n'],
    // An expression that stops at a token needing more.
    ['cut after a dot', 'import * as React from "react";\nexport default React.'],
    ['cut after an optional dot', 'import * as React from "react";\nexport default React?.'],
    ['cut after a member dot at EOF', 'const pages = { Home: () => null };\nexport default pages.'],
    ['cut after an optional member dot at EOF', 'const pages = { Home: () => null };\nexport default pages?.'],
    ['cut after `as`', 'const P = () => null;\nexport default P as'],
    ['cut after `as` and a namespace', 'const P = () => null;\nexport default P as React.'],
    ['cut after `satisfies`', 'const P = () => null;\nexport default P satisfies'],
    ['cut after `?`', 'const P = () => null;\nexport default ok ?'],
    ['cut after `&&`', 'const P = () => null;\nexport default ok &&'],
    // An arrow cut off after parameters that cannot be an expression.
    ['cut after empty arrow parameters', 'export default ()'],
    ['cut after typed arrow parameters', 'export default (props: { a: string })'],
    ['cut after optional typed arrow parameters', 'export default (props?: P)'],
    ['cut after spread arrow parameters', 'export default (...args)'],
    ['cut before the arrow of a typed arrow', 'export default (props: P): JSX.Element'],
    ['cut before the arrow of an untyped arrow with a return type', 'export default (props): JSX.Element'],
    ['cut before the arrow of a destructuring arrow with a return type', 'export default ({ id }): JSX.Element'],
    ['cut after parameters with a later rest parameter', 'export default (a, ...rest)'],
    // Not a legal arrow: no line break may come between `async` and its parameters (a SyntaxError).
    ['async, a line break, then an arrow', 'export default async\n(x) => x;\n'],
  ]) {
    assert.equal(hasDefaultExport(code), false, what);
  }
});

test('endsMidStatement distinguishes dangling operators from postfix and JSX or regex closers', () => {
  for (const [what, code] of [
    ['relational greater-than needs a right operand', 'const count = 1;\nexport default () => count >'],
    ['division slash needs a right operand', 'const count = 1;\nexport default () => count /'],
    ['JSX followed by dangling division slash needs a right operand', 'export default () => <div>Hi</div> /'],
    ['prefix bang needs its operand', 'const count = 1;\nexport default () => !'],
  ]) {
    assert.equal(endsMidStatement(code), true, what);
  }
  for (const [what, code] of [
    ['a JSX tag can end with >', 'export default () => <div />'],
    ['a regex literal can end with /', 'const re = /a+/;\nexport default re'],
    ['a postfix non-null assertion can end with !', 'const count = 1;\nexport default count!'],
  ]) {
    assert.equal(endsMidStatement(code), false, what);
  }
});

test('findElisionMarker treats any bare ellipsis line as elision, even parser-valid multiline spread', () => {
  // Documented limit: without a full parser, a line containing only `...` can be either a legal
  // multiline spread/rest or an elided block. The gate fails closed; generators should write
  // `...rows` on one line instead.
  for (const [what, code] of [
    ['multiline array spread', [
      'const rows = [1, 2];',
      'const copy = [',
      '  ...',
      '  rows',
      '];',
      'const GeneratedComponent = () => copy.length ? null : null;',
      'export default GeneratedComponent;',
    ].join('\n')],
    ['multiline object spread', 'const base = { title: "Ready" };\nconst copy = {\n  ...\n  base\n};\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;'],
    ['multiline call spread', 'const rows = [1, 2];\ncollect<number>(\n  ...\n  rows\n);\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;'],
    ['multiline optional call spread', 'const rows = [1, 2];\ncollect?.(\n  ...\n  rows\n);\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;'],
    ['multiline non-null call spread', 'const rows = [1, 2];\ncollect!(\n  ...\n  rows\n);\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;'],
    ['rest-parameter arrow with return type', 'const f = (\n  ...\n  args\n): number => args.length;\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;'],
    ['ternary object spread', 'const copy = ready ? { a: 1,\n  ...\n  base\n} : {};\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;'],
    ['case block elision', 'switch (kind) {\n  case 1: {\n    ...\n    renderRows();\n  }\n}\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;'],
    ['array ternary elision', 'const rows = [ready ?\n  ...\n  rows : []];\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;'],
    ['executable template elision', [
      'const GeneratedComponent = () => {',
      '  const title = `${(() => {',
      '    ...',
      '  })()}`;',
      '  return null;',
      '};',
      'export default GeneratedComponent;',
    ].join('\n')],
  ]) {
    assert.match(findElisionMarker(code) || '', /bare `\.\.\.` line/, what);
  }
  assert.equal(findElisionMarker('const { a, ...rest } = o;\nexport default rest;'), null, 'same-line object rest remains ordinary code');
  assert.equal(findElisionMarker('const rows = [...items];\nexport default rows;'), null, 'same-line array spread remains ordinary code');
});

test('TypeScript parser oracle documents lexer review snippets and adversarial neighbours', (t) => {
  const oracle = loadTypescriptOracle();
  if (!oracle) {
    t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
    return;
  }
  const valid = {
    'multiline object spread after {': [
      'const base = { title: "Ready" };',
      'const copy = {',
      '  ...',
      '  base',
      '};',
      'const GeneratedComponent = () => null;',
      'export default GeneratedComponent;',
    ].join('\n'),
    'generic instantiation default export at EOF': 'function Page<T>() { return null; }\nexport default Page<string>',
    'type alias with nested type arguments at EOF': 'const GeneratedComponent = () => null;\nexport default GeneratedComponent;\ntype Rows = Record<string, Array<number>>',
    'multiline cast type arguments before division in a template': [
      'const total = 12, count = 2;',
      'const label = `${total as NonNullable<',
      '  number',
      '> / count}/month`;',
      'const GeneratedComponent = () => null;',
      'export default GeneratedComponent;',
    ].join('\n'),
    'function type inside type arguments before division in a template': 'const total = 12, count = 2;\nconst label = `${total as ReturnType<() => number> / count}/month`;\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;',
    'self-closing JSX callback at EOF': 'import { Input } from "@fluentui/react-components";\nexport default () => <Input onChange={() => console.log("changed")} />',
    'TSX generic arrow with comma': 'const f = <T,>(x: T) => x;\nexport default f;',
    'relational chain a < b > c': 'const x = a < b > c;\nexport default x;',
    'nested type arguments before division': 'const total = 12, count = 2;\nconst label = `${total as Record<string, Array<number>> / count}/month`;\nexport default label;',
    'regex after statement-head paren': 'const value = 1;\nif (ready) /x/.test(value);\nexport default value;',
    'regex after return keyword': 'function f(){ return /x/; }\nexport default f;',
    'call spread split across lines': 'const y = fn(\n  ...\n  args\n);\nexport default y;',
    'array spread split across lines': 'const y = [\n  ...\n  rows\n];\nexport default y;',
    'arrow rest params': 'const f = (...args) => args.length;\nexport default f;',
    'object rest destructuring': 'const { a, ...rest } = o;\nexport default rest;',
    'non-null assertion at EOF': 'const x = y!;\nexport default x!',
    'non-null assertion before division at EOF': 'const z = x! / y;\nexport default z',
    'self-closing JSX with relational attribute at EOF': 'const x = 2;\nexport default () => <A b={x > 1} />',
    'self-closing JSX with block callback at EOF': 'export default () => <A b={() => { console.log("x"); }} />',
  };
  for (const [label, code] of Object.entries(valid)) assertTsParses(oracle, code, label);
  assertTsRejects(oracle, 'const GeneratedComponent = () => (\n  ...\n  renderRows()\n);\nexport default GeneratedComponent;', /Expression expected|Declaration or statement expected/, 'grouping parens do not allow spread');
  assertTsRejects(oracle, 'export default function GeneratedComponent() {\n  ...\n  renderRows();\n  return null;\n}', /Declaration or statement expected/, 'block elision is not TypeScript');
  assertTsRejects(oracle, 'const x = a >', /Expression expected/, 'dangling relational greater-than is not TypeScript');
});

test('navigation regex after relational greater-than remains visible', () => {
  const code = 'const marker = `${lo<hi && count > /}/.source.length ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}`;';
  assert.deepEqual(navReferencedKeys(code), ['details']);
});

// A cast's type may be one constituent of an intersection or union, so the check for "type arguments in a cast"
// walks back over the others to the `as`: missing it read `/ count}/` as a regex, and the page lost its default
// export. And angle brackets around an expression operator are comparisons even after a cast — pairing them as type
// arguments hid a navigation call. Every expectation matches TypeScript's parser.
test('a cast\'s type arguments reach its `as` or `satisfies` through unions, intersections and conditional types, and never span an expression operator', () => {
  const brand = 'type Brand<T> = { readonly __brand: T };\nconst total = 12, count = 2;\n';
  const complete = {
    'intersection cast before division': `${brand}const label = \`\${total as number & Brand<"USD"> / count}/month\`;\nexport default () => <p>{label}</p>;`,
    'union cast with a qualified name before division': 'namespace B { export type C<D> = D; }\nconst value = 4, n = 2;\nconst v = `${value as string | B.C<number> / n}/month`;\nexport default () => <p>{v}</p>;',
    'a qualified constituent before the name': 'namespace B { export type C = number; }\ntype Z<Q> = Q;\nconst value = 4, n = 2;\nconst v = `${value as B.C | Z<number> / n}/month`;\nexport default () => <p>{v}</p>;',
  };
  for (const [label, code] of Object.entries(complete)) {
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(hasUnbalancedBrackets(code), false, label);
    assert.equal(endsMidStatement(code), false, label);
  }
  assert.equal(endsMidStatement(`${brand}export default () => total as number & Brand<"USD"> / count /`), true,
    'a division cut after its slash is still dangling');
  const nav = 'const lo = 0, hi = 2, count = 3;\nconst marker = `${lo as number < hi && count > /}/.source.length ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}`;\nexport default function Page() { return null; }';
  assert.deepEqual(navReferencedKeys(nav), ['details'], 'a primitive takes no type arguments, and `&&` is no type operator');
  // Without the `&&`, only the primitive rule tells the comparison apart. TypeScript reads `lo as number` and two
  // comparisons around the regex `/}/`; inside a template substitution the `/` was read as a division, and its `}`
  // closed the substitution over the navigation call.
  const primitive = 'const lo = 0, hi = 2;\nconst marker = `${lo as number < hi > /}/.source.length ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}`;\nexport default function Page() { return null; }';
  assert.deepEqual(navReferencedKeys(primitive), ['details'], '`number` takes no type arguments');
  // A property's `:` reads like an annotation, so only the operator rule tells `lo < hi && count >` from type
  // arguments there. TypeScript reads two comparisons around the regex `/}/`.
  const property = 'const lo = 0, hi = 2, count = 3, s = "";\nconst o = { ok: lo < hi && count > /}/.test(s) };\nexport default function Page() { return null; }';
  assert.equal(hasDefaultExport(property), true);
  assert.equal(hasUnbalancedBrackets(property), false);
  assert.equal(endsMidStatement(property), false);
  const propertyNav = 'const lo = 0, hi = 2, count = 3;\nconst marker = `${({ ok: lo < hi && count > /}/.source.length }).ok ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}`;\nexport default function Page() { return null; }';
  assert.deepEqual(navReferencedKeys(propertyNav), ['details']);
  // `=` (a type parameter's default) and `+` (a mapped-type modifier) are type syntax too, so only `&&`, `||` and
  // `??` end a type-argument match; a string-literal constituent is stepped over; and the walk has no count limit.
  const d = 'const total = 12, count = 2;\n';
  const union = Array.from({ length: 17 }, (_, i) => `T${i}`);
  for (const [label, code] of Object.entries({
    'a type parameter default in a cast': `${d}const label = \`\${total as ReturnType<<T = unknown>(x: T) => number> / count}/month\`;\nexport default () => <p>{label}</p>;`,
    'a mapped-type modifier in a cast': `${d}const label = \`\${total as ReturnType<(x: { +readonly [K in "v"]: number }) => number> / count}/month\`;\nexport default () => <p>{label}</p>;`,
    'eighteen union constituents': `${union.map((n) => `type ${n} = number;`).join('\n')}\ntype Z<Q> = Q;\n${d}const v = \`\${total as ${union.join(' | ')} | Z<number> / count}/month\`;\nexport default () => <p>{v}</p>;`,
  })) {
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(endsMidStatement(code), false, label);
  }
  assert.equal(endsMidStatement(`${d}export default () => total as ReturnType<<T = unknown>(x: T) => number> / count /`), true);
  assert.equal(endsMidStatement(`${d}export default () => total satisfies "n/a" | NonNullable<number> / count /`), true);
  assert.equal(findElisionMarker(`${d}export default function Page() {\n  const avg = total satisfies "n/a" | NonNullable<number> / count; // TODO: render chart\n  return null;\n}`),
    'a TODO/FIXME comment', 'the comment after a division is a comment, not a regex');
  // `+`, `:` and the like are an expression's at the outer level of a would-be type-argument span. Taking them for type
  // syntax paired `start < anchor + padding` in one property with `end > /}/` in the next, across the `,` and the
  // `:` between, and the page read as unbalanced.
  const siblings = 'const start = 1, anchor = 4, padding = 1, end = 9;\nconst text = "value }";\nconst bounds = {\n  startsBefore: start < anchor + padding,\n  endsAfter: end > /}/.exec(text)!.index,\n};\nexport default () => <p>{String(bounds.endsAfter)}</p>;';
  assert.equal(hasUnbalancedBrackets(siblings), false);
  assert.equal(endsMidStatement(siblings), false);
  const siblingsNav = 'const start = 1, anchor = 4, end = 9;\nconst text = "value }";\nconst marker = `${({ a: start < anchor, b: end > /}/.exec(text)!.index }).b ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}`;\nexport default () => null;';
  assert.deepEqual(navReferencedKeys(siblingsNav), ['details']);
  // A `<` inside a group the `>` is outside of closes nothing there: `({ a: lo < hi }).a > /}/` compares twice,
  // although the `<` follows a property's `:`.
  const grouped = 'const lo = 0, hi = 2;\nconst marker = `${({ a: lo < hi }).a > /}/.source.length ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}`;\nexport default () => null;';
  assert.deepEqual(navReferencedKeys(grouped), ['details']);
  // Only a cast gives type-argument context. A `:` was taken for an annotation's, but a division never follows an
  // annotation's type, and each `:` matched was a ternary's, a property's or a case clause's.
  const ternary = 'const skipStart = false, start = 1, anchor = 4, padding = 1, end = 9;\nconst text = "value }";\nconst checks = [\n  skipStart ? true : start < Math.max(anchor + padding, 0),\n  end > /}/.exec(text)!.index,\n];\nexport default () => <p>{checks.every(Boolean) ? "match" : "no match"}</p>;';
  assert.equal(hasUnbalancedBrackets(ternary), false);
  assert.equal(endsMidStatement(ternary), false);
  const ternaryNav = 'const skip = false, start = 1, anchor = 4, end = 9;\nconst text = "value }";\nconst marker = `${[skip ? true : start < Math.max(anchor, 0), end > /}/.exec(text)!.index][1] ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}`;\nexport default () => null;';
  assert.deepEqual(navReferencedKeys(ternaryNav), ['details']);
  const callArgs = 'const f = (a: boolean, b: boolean) => a && b;\nconst start = 1, anchor = 4, end = 9, text = "v }";\nconst r = f(start < Math.max(anchor, 0), end > /}/.exec(text)!.index);\nexport default () => <p>{String(r)}</p>;';
  assert.equal(hasUnbalancedBrackets(callArgs), false);
  // A conditional type's `:` at the outer level of a cast's type arguments is type syntax.
  const conditional = `${d}const label = \`\${total as ReturnType<() => number extends number ? number : never> / count}\`;\nexport default () => null;`;
  assert.equal(hasDefaultExport(conditional), true);
  assert.equal(endsMidStatement(conditional), false);
  // TypeScript attaches type arguments only to a plain type name on the same line as the `<`. After an indexed type,
  // a literal, or a line break, the `<` is a comparison.
  const cmp = 'const low = 1, high = 4, count = 9, text = "value }";\n';
  for (const [label, code] of Object.entries({
    'an indexed type before `<`': `type Row = { qty: number };\ntype Key = "qty";\n${cmp}const allowed = low as Row[Key] < high && count > /}/.exec(text)!.index;\nexport default () => <p>{String(allowed)}</p>;`,
    'a literal type before `<`': `${cmp}const allowed = low as 0 | 1 < high && count > /}/.exec(text)!.index;\nexport default () => <p>{String(allowed)}</p>;`,
    'a line break before `<`': `type Count = number;\n${cmp}const allowed = low as Count\n  < high && count > /}/.exec(text)!.index;\nexport default () => <p>{String(allowed)}</p>;`,
    'a CRLF line break before `<`': `type Count = number;\r\n${cmp.replace('\n', '\r\n')}const allowed = low as Count\r\n  < high && count > /}/.exec(text)!.index;\r\nexport default () => <p>{String(allowed)}</p>;`,
  })) {
    assert.equal(hasUnbalancedBrackets(code), false, label);
    assert.equal(endsMidStatement(code), false, label);
  }
  assert.deepEqual(navReferencedKeys(`type Row = { qty: number };\ntype Key = "qty";\n${cmp}const m = \`\${low as Row[Key] < high && count > /}/.exec(text)!.index ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}\`;\nexport default () => null;`), ['details']);
  // An indexed type is still a constituent before the head: `Row[Key] & Brand<"x">` casts.
  const indexedEarlier = `type Row = { qty: number };\ntype Key = "qty";\ntype Brand<T> = { __b: T };\n${d}const label = \`\${total as Row[Key] & Brand<"x"> / count}/month\`;\nexport default () => <p>{label}</p>;`;
  assert.equal(endsMidStatement(indexedEarlier), false);
  assert.equal(hasDefaultExport(indexedEarlier), true);
  // A cast whose type is itself conditional: the walk steps back over `extends … ? … :` to the `as`.
  const direct = `type Value = number | undefined;\n${d}const label = \`\${total as Value extends undefined ? 0 : NonNullable<Value> / count}/month\`;\nexport default () => <p>{label}</p>;`;
  assert.equal(hasDefaultExport(direct), true);
  assert.equal(endsMidStatement(direct), false);
  assert.equal(endsMidStatement(`type Value = number | undefined;\n${d}export default () => total as Value extends undefined ? 0 : NonNullable<Value> / count /`), true);
  // Each part of the conditional may be a union: the true branch, the constraint, the checked type.
  const vd = `type Value = number | undefined;\n${d}`;
  for (const [label, code] of Object.entries({
    'a union true branch': `${vd}const label = \`\${total as Value extends undefined ? 0 | 1 : NonNullable<Value> / count}/month\`;\nexport default () => <p>{label}</p>;`,
    'a union constraint': `${vd}const label = \`\${total as Value extends string | undefined ? 0 : NonNullable<Value> / count}/month\`;\nexport default () => <p>{label}</p>;`,
    'a union checked type': `${vd}const label = \`\${total as number | Value extends undefined ? 0 : NonNullable<Value> / count}/month\`;\nexport default () => <p>{label}</p>;`,
  })) {
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(endsMidStatement(code), false, label);
  }
  assert.equal(endsMidStatement(`${vd}export default () => total as Value extends undefined ? 0 | 1 : NonNullable<Value> / count /`), true);
  assert.deepEqual(navReferencedKeys(`${vd}const m = \`\${total as Value extends undefined ? 0 | 1 : NonNullable<Value> / count / 2 ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}\`;\nexport default () => null;`), ['details']);
  // A negative literal keeps its sign, and every part may lead with its operator: right after `as` or `satisfies`, the
  // checked type, the constraint after `extends`, and either branch. A false branch may chain another conditional.
  const parts = {
    'a signed literal branch': 'Value extends undefined ? -1 | 0 : NonNullable<Value>',
    'a leading-union true branch': 'Value extends undefined ? | 0 | 1 : NonNullable<Value>',
    'a leading-union false branch': 'Value extends undefined ? 0 : | 1 | NonNullable<Value>',
    'a leading-intersection false branch': 'Value extends undefined ? 0 : & NonNullable<Value>',
    'a leading-union constraint': 'Value extends | undefined | null ? 0 : NonNullable<Value>',
    'a leading-union checked type': '| Value extends undefined ? 0 : NonNullable<Value>',
    'a conditional chained in the false branch': 'Value extends undefined ? 0 : Value extends null ? 1 : NonNullable<Value>',
  };
  for (const [label, type] of Object.entries(parts)) {
    const code = `${vd}const label = \`\${total as ${type} / count}/month\`;\nexport default () => <p>{label}</p>;`;
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(endsMidStatement(code), false, label);
    assert.equal(endsMidStatement(`${vd}export default () => total as ${type} / count /`), true, `${label}, cut`);
  }
  for (const keyword of ['as', 'satisfies']) {
    const code = `type Z<Q> = Q;\n${vd}const label = \`\${total ${keyword} | number | Z<number> / count}/month\`;\nexport default () => null;`;
    assert.equal(hasDefaultExport(code), true, `a leading union after \`${keyword}\``);
    assert.equal(endsMidStatement(code), false, `a leading union after \`${keyword}\``);
  }
  // `as` and `satisfies` are contextual keywords, so each may name a type. With type arguments of its own, or before
  // `?`, `:` or `extends`, such a name is a constituent, never the cast keyword; so is one within a longer name
  // (`E.as`), and one inside an index (`Row[as | Key]`) is never reached.
  for (const [label, [alias, type]] of Object.entries({
    'a generic named `satisfies`': ['type satisfies<T> = T;\n', 'satisfies<number> & NonNullable<Value>'],
    'a generic named `as`': ['type as<T> = T;\n', 'as<number> | NonNullable<Value>'],
    'a constraint named `satisfies`': ['type satisfies = undefined;\n', 'Value extends satisfies ? 0 : NonNullable<Value>'],
    'a checked type named `as`': ['type as = number | undefined;\n', 'as extends undefined ? 0 : NonNullable<Value>'],
    'a true branch named `as`': ['type as = 0;\n', 'Value extends undefined ? as : NonNullable<Value>'],
  })) {
    const code = `${alias}${vd}const label = \`\${total as ${type} / count}/month\`;\nexport default () => <p>{label}</p>;`;
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(endsMidStatement(code), false, label);
    assert.equal(endsMidStatement(`${alias}${vd}export default () => total as ${type} / count /`), true, `${label}, cut`);
  }
  // An index is stepped over whole, its brackets matched, so nothing inside one is read as part of the cast's type:
  // a string key, a second index, a nested one, or a union key holding a type named `as` anywhere in it.
  const row = 'type as = "price";\ntype Key = "qty";\ntype Keys = ["price"];\ntype Row = { price: number; qty: number; tax: number };\n';
  for (const [label, type] of Object.entries({
    'a string index': 'Row["qty"] & NonNullable<Value>',
    'a double index': 'Row["tax"]["toFixed"] & NonNullable<Value>',
    'a nested index': 'Row[Keys[0] | Key] & NonNullable<Value>',
    'an index led by a type named `as`': 'Row[as | Key] & NonNullable<Value>',
    'an index holding a type named `as` in the middle': 'Row["tax" | as | Key] & NonNullable<Value>',
  })) {
    const code = `${row}${vd}const label = \`\${total as ${type} / count}/month\`;\nexport default () => <p>{label}</p>;`;
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(endsMidStatement(code), false, label);
    assert.equal(endsMidStatement(`${row}${vd}export default () => total as ${type} / count /`), true, `${label}, cut`);
  }
  // No cast at all: a type alias whose type holds a keyword-named type keeps the regex on the next line a regex.
  for (const [label, code] of Object.entries({
    'a member named `as`': 'enum E { as, b }\ntype Z<Q> = Q;\ntype T = E.as | Z<number>\n/}/.test("a}") && console.log(1);\nexport default () => null;',
    'an index led by a type named `as`': `${row}type Z<T> = T;\ntype Price = Row[as | Key] & Z<number>\n/}/.test("}");\nexport default () => <p>Ready</p>;`,
    'an index holding a type named `as` in the middle': `${row}type Price = Row["tax" | as | Key] & NonNullable<number>\n/}/.test("}");\nexport default () => <p>Ready</p>;`,
    'an index with a comment before `as`': `${row}type Price = Row[/* selected columns */ as | Key] & NonNullable<number>\n/}/.test("}");\nexport default () => <p>Ready</p>;`,
    'a tuple led by a type named `as`': `${row}type Z<T> = T;\ntype Pair = [as | Key] & Z<number>\n/}/.test("}");\nexport default () => <p>Ready</p>;`,
  })) {
    assert.equal(hasUnbalancedBrackets(code), false, label);
    assert.equal(endsMidStatement(code), false, label);
  }
  // A leading operator decides nothing by itself: after `)` it is an expression's `|`, and the `/` starts a regex.
  const notCast = `${vd}const bits = (count) | total < count || count > /}/.exec("a}")!.index;\nexport default () => null;`;
  assert.equal(hasUnbalancedBrackets(notCast), false);
  assert.equal(endsMidStatement(notCast), false);
});

test('endsMidStatement treats non-JSX final type argument lists as documented incomplete tails', () => {
  // Documented limit: without a full parser, a final `>` can be a type-argument close or the end
  // of a relational expression. Only recorded JSX tag closes finish a file; type-argument tails need
  // a semicolon.
  const incomplete = {
    'generic instantiation default export at EOF': 'function Page<T>() { return null; }\nexport default Page<string>',
    'generic instantiation with trivia before type arguments': 'function Page<T>() { return null; }\nexport default Page /* c */ <string>',
    'type alias with nested type arguments at EOF': 'const GeneratedComponent = () => null;\nexport default GeneratedComponent;\ntype Rows = Record<string, Array<number>>',
    'type alias with object type argument at EOF': 'const GeneratedComponent = () => null;\nexport default GeneratedComponent;\ntype Rows = Array<{ id: string; label: string }>',
    'generic-looking arrow expression at EOF': 'export default () => a<b + c>',
    'cast type arguments at EOF': 'const v = [1];\nexport default v as unknown as Array<number>',
    'satisfies type arguments at EOF': 'const counts = { a: 1 };\nexport default counts satisfies Record<string, number>',
  };
  for (const [label, code] of Object.entries(incomplete)) assert.equal(endsMidStatement(code), true, label);
  assert.equal(endsMidStatement('function Page<T>() { return null; }\nexport default Page<string>;'), false, 'semicolon makes the documented limit explicit');
  assert.equal(endsMidStatement('const GeneratedComponent = () => null;\nexport default GeneratedComponent;\ntype Rows = Array<{ id: string; label: string }>;'), false, 'semicolon makes a type alias complete');
  assert.equal(endsMidStatement('const x = a >'), true, 'dangling relational greater-than still needs a right operand');
  assert.equal(endsMidStatement('const x = a < b > c'), false, 'a complete relational chain is an operand');
});

test('cast and annotation type arguments still make a following slash division', () => {
  const complete = {
    'cast type arguments before division in a template': 'const total = 12, count = 2;\nconst label = `${total as Record<string, Array<number>> / count}/month`;\nexport default label;',
    'annotation type arguments before division': 'const total: Record<string, Array<number>> = {};\nconst label = total / count;\nexport default label;',
    'non-null assertion at EOF': 'const x = y!;\nexport default x!',
    'non-null assertion before division at EOF': 'const z = x! / y;\nexport default z',
  };
  for (const [label, code] of Object.entries(complete)) assert.equal(endsMidStatement(code), false, label);
});

test('template expression slash classification handles multiline and nested type arguments', () => {
  for (const [label, code] of Object.entries({
    'multiline type arguments before division': [
      'const total = 12, count = 2;',
      'const label = `${total as NonNullable<',
      '  number',
      '> / count}/month`;',
      'const GeneratedComponent = () => null;',
      'export default GeneratedComponent;',
    ].join('\n'),
    'function type arrow inside type arguments before division': 'const total = 12, count = 2;\nconst label = `${total as ReturnType<() => number> / count}/month`;\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;',
    'regex after statement-head paren': 'const value = 1;\nif (ready) /x/.test(value);\nexport default value;',
    'regex after return keyword': 'function f(){ return /x/; }\nexport default f;',
  })) {
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(hasUnbalancedBrackets(code), false, label);
    assert.equal(endsMidStatement(code), false, label);
  }
});

test('endsMidStatement accepts self-closing JSX EOF tags using recorded tag closes', () => {
  for (const [label, code] of Object.entries({
    'callback attribute': 'import { Input } from "@fluentui/react-components";\nexport default () => <Input onChange={() => console.log("changed")} />',
    'relational expression attribute': 'const x = 2;\nexport default () => <A b={x > 1} />',
    'block callback attribute containing a semicolon': 'export default () => <A b={() => { console.log("x"); }} />',
  })) {
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(hasUnbalancedBrackets(code), false, label);
    assert.equal(endsMidStatement(code), false, label);
  }
});

test('every committed .tsx the repo ships is accepted (false-positive corpus)', () => {
  // A false positive here would block a real user mid-build, so this is the load-bearing test:
  // the samples the worker is told to copy, and every eval fixture artifact.
  //
  // Enumerate through `git ls-files` rather than walking the directory: capture-fixture.test.js
  // creates and deletes transient `capture-cli-test-<timestamp>` fixture directories while this
  // suite runs, and a plain walk races with it (EBUSY on Windows). Only committed files are the
  // contract anyway.
  const listed = execFileSync('git', ['ls-files', '-z', '*.tsx'], {
    cwd: path.resolve(__dirname, '..', '..', '..', '..'),
    encoding: 'utf8',
  }).split('\0').filter(Boolean);

  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const files = listed
    .filter((p) => p.startsWith('plugins/model-apps/samples/') || p.startsWith('evals/model-apps/genpage/fixtures/'))
    .map((p) => path.join(repoRoot, p));
  assert.ok(files.length >= 20, `expected a real corpus, found ${files.length}`);

  const rejected = files.filter((f) => {
    const code = fs.readFileSync(f, 'utf8');
    return !hasDefaultExport(code) || hasUnbalancedBrackets(code);
  });
  assert.deepEqual(rejected, [], 'these real pages would have been rejected');
});

test('ECMAScript line terminators end // comments without hiding executable navigation', () => {
  for (const term of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
    const code = `// inert${term}navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})`;
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], JSON.stringify(term));
  }
});

test('page structure accepts default exports after every ECMAScript line terminator', () => {
  const { pageStructureProblems } = require('../lib/page-structure.js');
  for (const term of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
    const code = `// header${term}export default function Page() { return null; }\n`;
    assert.deepStrictEqual(pageStructureProblems(code), [], JSON.stringify(term));
  }
});

test('string and regex literal line-terminator rules follow ECMAScript', () => {
  const ls = 'const s = "a\u2028b";\nexport default function Page() { return null; }\n';
  const ps = 'const s = "a\u2029b";\nexport default function Page() { return null; }\n';
  assert.equal(hasDefaultExport(ls), true, 'LS is legal inside string literals since ES2019');
  assert.equal(hasDefaultExport(ps), true, 'PS is legal inside string literals since ES2019');
  assert.equal(hasDefaultExport('const s = "a\rb";\nexport default function Page() { return null; }\n'), true, 'CR ends the broken string so later code remains visible');
  assert.deepStrictEqual(navReferencedKeys('const r = /a\u2028/;\nnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"})'), ['detail'], 'raw LS terminates a regex literal scan');
});

// A backslash continues a string across ONE line terminator, and CR LF is one terminator — so `"a\<CR><LF>b"` is a
// complete string (https://tc39.es/ecma262/#prod-LineContinuation). The string scan skipped the character after
// the backslash, the CR, and read the LF as a raw line break inside the string: the quote was refused, every quote
// after it paired the other way round, and a complete page failed as truncated. A page saved with CRLF endings and
// wrapped through a long string (generated text, an SVG path, a CSV) is exactly this shape.
const STRING_CONTINUATION_TERMINATORS = ['\n', '\r', '\r\n', '\u2028', '\u2029'];

test('a backslash continues a string across CRLF as it does across LF, CR, LS and PS', () => {
  const { pageStructureProblems } = require('../lib/page-structure.js');
  for (const quote of ['"', "'"]) {
    for (const term of STRING_CONTINUATION_TERMINATORS) {
      const code = `const text=${quote}a\\${term}b${quote}; export default function Page(){return <p>{text}</p>;}`;
      const what = `${quote} + ${JSON.stringify(term)}`;
      assert.equal(hasDefaultExport(code), true, what);
      assert.equal(endsMidStatement(code), false, what);
      assert.equal(hasUnbalancedBrackets(code), false, what);
      assert.deepStrictEqual(pageStructureProblems(code), [], what);
      // The string is blanked as one token, the continuation included; line terminators stay, as everywhere in the mask.
      assert.equal(blankLiterals(code).slice(0, code.indexOf(';')), `const text=${quote}  ${term} ${quote}`, what);
    }
  }
  // A page saved with CRLF endings: backslash, CR, LF inside a double-quoted string.
  const crlfPage = 'const text="a\\' + '\r\n' + 'b"; export default function Page(){return <p>{text}</p>;}';
  assert.deepStrictEqual(pageStructureProblems(crlfPage), []);
  // Continuations may repeat, and may start a string.
  assert.equal(hasDefaultExport('const t = "a\\\r\nb\\\r\nc\\\r\n"; export default () => null;'), true);
  // Inside a `${…}` body, where the same lexer runs, and inside a type-parameter lookahead (skipTrivia) — where a `;` or a
  // `>` in the continued string must not end the parameter list the lookahead is judging.
  assert.equal(hasDefaultExport('const t = `${"a\\\r\nb"}`; export default () => null;'), true);
  for (const inside of [';', '>', ')']) {
    const generic = `const id = <T extends "a\\\r\nb${inside}c",>(x: T) => x;\r\nexport default () => <p>{id("z")}</p>;`;
    assert.equal(hasDefaultExport(generic), true, `generic arrow with ${inside} in a continued string`);
    assert.equal(endsMidStatement(generic), false, inside);
    const ts = loadTypescriptOracle();
    if (ts) assertTsParses(ts, generic, `TypeScript accepts the generic arrow with ${inside}`);
  }
  const ts = loadTypescriptOracle();
  if (ts) assertTsParses(ts, crlfPage, 'TypeScript accepts the CRLF page');
});

// The control for the test above: a string that really is unterminated is still refused, whatever precedes the
// break — a continuation does not make a following raw line break legal, and an escaped backslash is not one.
test('a string that is still unterminated after a CRLF continuation is refused', () => {
  const { pageStructureProblems } = require('../lib/page-structure.js');
  const page = ' export default function Page(){return <p>{text}</p>;}';
  const refused = {
    'raw LF after a CRLF continuation': `const text="a\\\r\nb\n";${page}`,
    'raw CRLF after a CRLF continuation': `const text="a\\\r\nb\r\n";${page}`,
    'raw CR after a CR continuation': `const text="a\\\rb\r";${page}`,
    'raw CRLF after an escaped backslash': `const text="a\\\\\r\nb";${page}`,
    'the string never closes': `const text="a\\\r\nb;${page}`,
    'the file ends after the continuation': 'const text="a\\\r\n',
    'the file ends after the backslash and CR': 'const text="a\\\r',
    'the file ends after the backslash': 'const text="a\\',
  };
  for (const [what, code] of Object.entries(refused)) {
    assert.notDeepStrictEqual(pageStructureProblems(code), [], what);
  }
  const ts = loadTypescriptOracle();
  if (ts) {
    for (const [what, code] of Object.entries(refused)) {
      assert.notDeepStrictEqual(parseDiagnosticMessages(ts, code), [], `TypeScript rejects ${what}`);
    }
  }
});

// Navigation after a CRLF continuation is read like any other: the continuation must not pair the quotes the other way
// round and turn the next call's strings into code. The same boundary inside a quoted KEY (`"page\<CRLF>Type"`) must
// still let the call be seen — the key decodes to `pageType`.
test('a CRLF continuation does not hide a navigation call after it or inside its quoted key', () => {
  for (const term of STRING_CONTINUATION_TERMINATORS) {
    const label = JSON.stringify(term);
    const call = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})';
    assert.deepStrictEqual(navReferencedKeys(`const text="a\\${term}b"; ${call}`), ['detail'], `after a string with ${label}`);
    assert.deepStrictEqual(navReferencedKeys(`const text='a\\${term}b'; ${call}`), ['detail'], `after a single-quoted string with ${label}`);
    // A template needs no pairing — a line break is ordinary template text — but the continuation must not disturb its `${…}`.
    assert.deepStrictEqual(navReferencedKeys(`const text=\`a\\${term}b \${${call.replace('PAGEREF_detail', 'PAGEREF_inside')}} c\\${term}d\`; ${call}`), ['detail', 'inside'], `in a template with ${label}`);
    assert.deepStrictEqual(navReferencedKeys(`const text=\`a\\${term}b\`; ${call}`), ['detail'], `after a template with ${label}`);
    assert.deepStrictEqual(navReferencedKeys(`navigateTo({"page\\${term}Type":"generative",pageId:"PAGEREF_detail"})`), ['detail'], `key with ${label}`);
    assert.deepStrictEqual(navReferencedKeys(`navigateTo({pageType:"generative","page\\${term}Id":"PAGEREF_detail"})`), ['detail'], `pageId key with ${label}`);
    assert.deepStrictEqual(navReferencedKeys(`navigateTo({pageType:"generative",pageId:"PAGEREF_det\\${term}ail"})`), [], `a value with ${label} is not the canonical token`);
  }
});

// ─── Where the lexer is guessing ──────────────────────────────────────────────────────────────────────────────
//
// A lexer with no parser decides some things by heuristic: whether a `/` is a regex or a division, whether a `<` opens a JSX element, how a
// JSX tag with type arguments is scanned. A wrong guess blanks real code or reads text as code, and from there on the mask is not what the
// page means. `onAmbiguity(at, kind)` reports each such decision, as data, with the offset of the `/`, `<` or construct it could not read
// for certain. The tokenization is the same with or without a listener — the other gates depend on it — and a caller that must not trust
// what it cannot be sure of (the navigation reader) takes the earliest offset as a frontier.
//
// One test per kind: what makes the reading a guess, a raw example at its exact offset, and the nearby code that is NOT a guess.
function ambiguities(code) {
  const found = [];
  const blanked = blankNonCodePreservingTemplateExpressions(code, { onAmbiguity: (at, kind) => found.push([at, kind]) });
  assert.strictEqual(blanked, blankNonCodePreservingTemplateExpressions(code), `listening changes nothing the lexer blanks: ${JSON.stringify(code)}`);
  // A kind the list does not name would have no wording in the report a page author reads (see pageref-resolver's AMBIGUITY_TEXT).
  for (const [, kind] of found) assert.ok(AMBIGUITY_KINDS.includes(kind), `an unlisted kind: ${kind}`);
  return found;
}
const earliestAmbiguity = (code) => ambiguities(code).reduce((first, now) => (first === null || now[0] < first[0] ? now : first), null);
// [code, the text that starts at the offset the earliest ambiguity is reported at]
function assertAmbiguous(kind, cases) {
  for (const [code, at] of cases) assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf(at), kind], JSON.stringify(code));
}
function assertCertain(codes) {
  for (const code of codes) assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
}

// To this lexer `}` begins an expression, so a `/` after one opens a regex. That is right after a BLOCK's `}`
//   if (ok) { go(); }
//   /abc/.test(text);
// and wrong after an OBJECT literal's, or a function expression's, which divides:
//   const count = {valueOf(){return 12;}}/2; const half = total / 2;
// The two read alike. A wrong reading blanks real code up to the next `/` on the line, and a `/*` after that opens a comment that runs on
// to the next `*/` — hiding calls from every check that reads the mask. The same holds for a `<` that could open a JSX element.
test('ambiguity brace: a "/" or "<" right after a "}" is block or object, regex or division', () => {
  assertAmbiguous('brace', [
    ['const count = {valueOf(){return 12;}}/2; const half = total / 2;', '/2; const half'],
    ['if (ok) { go(); }\n/abc/.test(text);', '/abc/'],
    ['if (ok) { go(); } /* c */ /abc/.test(text);', '/abc/'],
    ['if (ok) { go(); }\n// }\n/abc/.test(text);', '/abc/'],
    ['const f = () => { go(); }\n/re/.test(x);', '/re/'],
    ['a = {}/1; b = c / 2;\nif (x) { }\n/re/.test(y);', '/1; b'],
    ['const s = `${ {a:1}/2; /x/ }`;', '/2; /x/'],
    ['const s = `a ${ if (x) { }\n/re/.test(y) } b`;', '/re/'],
    ['if (ok) { go(); }\n<div>text</div>;', '<div>'],
  ]);
  assertCertain([
    'const half = total / 2; const r = /x/;', 'const r = /x/;', 'f(/x/)', 'a = [/x/]', 'a = b ? /x/ : /y/', 'return /x/.test(s)',
    'a = b / 2 / 3', 'a = (b) / 2 / 3', 'x = y[0] / 2 / 3;', 'x = "}" / 2 / 3;', "x = '}' / 2 / 3;", '// }\n/x/.test(y)', '/* } */ /x/.test(y)', 'x = /}/ / 2',
    'const a = <p>{x}/{y}</p>;', 'const a = <Foo a={x}/>;', 'const a = <p>{x}</p>;', 'const a = `{x}/{y}/`;',
    // A `/` after a `}` with no closing `/` on its line cannot be a regex, so it divides: not a guess.
    'const n = {a: 1}/2;\nconst m = 3;',
  ]);
});

// `)` closes an `if (…)`, `for (…)` or `while (…)` head, after which a `/` begins a regex, or it ends an operand, after which it divides. The
// lexer finds the matching `(` by looking back at most 2,000 characters; past that it cannot tell.
//   if (true /* …2,100 characters… */) /navigateTo({…})/.test(text);
test('ambiguity paren: a "/" or "<" after a ")" whose "(" is out of reach is head or operand', () => {
  const far = (n) => `if (true /*${'x'.repeat(n)}*/)`;
  assertAmbiguous('paren', [
    [`${far(2100)} /abc/.test(text);`, '/abc/'],
    [`${far(2100)} <div/>;`, '<div/>'],
    [`const v = (${'a + '.repeat(600)}1) / 2 / 3;`, '/ 2 / 3'],
  ]);
  assertCertain([
    `${far(1500)} /abc/.test(text);`, `const v = (${'a + '.repeat(400)}1) / 2 / 3;`,
    '(a + b) / 2 / 3', 'if (x) /re/.test(y)', 'while (x) /re/.test(y)', 'for (const k of ks) /re/.test(k)', 'for await (const k of ks) /re/.test(k)',
    'if (a) { } else if (b) /x/.test(c)', 'foo(x) / 2 / 3', 'const a = foo(x) < 3 && 1;', 'if (x) <div/>;',
  ]);
});

// `of`, `await` and `yield` are keywords where a regex may follow and names where a division does; `type`, `get`, `async`, `as` … are keywords
// in a declaration or an assertion and names anywhere else. Which one it is depends on the grammar around it.
//   const of = 12; const count = of/2; const re = /\/*$/;
const CONTEXTUAL_WORDS = ['of', 'await', 'yield', 'let', 'async', 'static', 'get', 'set', 'as', 'satisfies', 'type', 'from', 'declare', 'abstract', 'readonly',
  'keyof', 'infer', 'is', 'asserts', 'override', 'accessor', 'using', 'out', 'module', 'namespace', 'global', 'unique', 'implements'];
test('ambiguity keyword: a "/" or "<" after a word that is a keyword in some places and a name in others', () => {
  for (const word of CONTEXTUAL_WORDS) {
    assertAmbiguous('keyword', [[`var ${word} = 12; var count = ${word}/2; var re = /x/;`, '/2; var re']]);
  }
  // A `<` after `async` on its line is code, whatever follows it (the next test). After a line break `async` is a name, and what follows is a guess unless it cannot be an element:
  // `<T,>(x: T) => x` cannot, and is code there as everywhere.
  assertAmbiguous('keyword', [['const f = async\n<T extends X>text</T>;', '<T extends X>'], ['const f = async\n<div>x</div>;', '<div>'], ['const c = of/2; const re = /\\/*$/;', '/2; const re']]);
  assertCertain([
    'a.of / 2 / 3', 'obj?.get / 2 / 3', 'a.type / 2 / 3', 'ofx / 2 / 3', 'typeofx / 2 / 3', 'return /x/.test(s)', 'typeof /x/.test(s)', 'x = new /x/', 'a = await_ / 2 / 3',
    'const f = (x) => x < 3;',
  ]);
});

// `async` and a `<` on its line. TypeScript's rule for `.tsx` steps over `async` (parser.ts, isParenthesizedArrowFunctionExpressionWorker,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts): with no line break before the `<`, the next tokens decide — a comma, `=` or `extends` and a token that is not
// `=`, `>` or `/` — as they do for any `<`, and a generic shape is the head of an async generic arrow. Every other is no arrow, and `async` is then an ordinary token: a method named `async`
// that has type parameters (`const o = { async<T>(x: T) { return x; } }`, `class C { async<T>(x: T) {} }`) or the identifier, after which a `<` is a comparison or the type arguments of
// a call. An element starts where an expression does, and nothing starts one after `async`: so the text after the `<` is code in every reading that parses, whatever the head of the
// rule is, and the page is not guessed at. After a line break `async` is a name and the `<` goes on its statement: a head that cannot be an element is type parameters there too
// (`<T,>`, or a parameter list and an arrow), and one that can (`<T extends X>text</T>`) keeps the guess.
test('ambiguity keyword: a "<" after `async` on its line is code, for certain, whatever follows it; after a line break it is a guess', () => {
  assertCertain([
    'const f = async <T,>(x: T) => x;', 'const f = async <T extends X>(x: T) => x;', 'const f = async <T = X>(x: T) => x;', 'const f = async <const T,>(x: T) => x;',
    // A parameter list and a colon after the constraint leaves JSX text open (`<T extends X>(x: T): T</T>`) and an arrow's return type: but with `async` before it only the arrow parses.
    'const f = async <T extends X>(x: T): T => x;', 'const f = async <T extends X>(x: T): Array<T> => [x];',
    'export default async <T,>(x: T) => x;', 'const f = [async <T,>(x: T) => x];', 'run(async <T,>(x: T) => x);', 'const o = { f: async <T,>(x: T) => x };',
    'const f = cond ? async <T,>(x: T) => x : null;', 'const f = async /* c */ <T,>(x: T) => x;', 'const f = async<T,>(x: T) => x;',
    'const f = async\u00a0<T,>(x: T) => x;', 'const f = async\u0085<T,>(x: T) => x;', 'const f = async\u200b<T,>(x: T) => x;', 'const f = async\t<T,>(x: T) => x;',
    // A method named `async` has type parameters of its own — with a head of every kind, an element's included, for the `<` after `async` is never an element — and a property named so is no
    // keyword at all.
    'class C { async<T,>(x: T) { return x; } }', 'const v = a.async <T,>(x);',
    'const o = { async<T>(x: T) { return x; } };', 'const o = { async <T>(x: T) { return x; } };', 'const o = { async<T extends X>(x: T) { return x; } };', 'class C { async<T>(x: T) { return x; } }',
    'class C { static async<T>(x: T) { return x; } }', 'class C { async\u0085<T>(x: T) { return x; } }', 'const o = { async/* c */<T>(x: T) { return x; } };', 'const o = { async<T,>(x: T) { return x; } };',
    // The identifier `async` and a comparison or the type arguments of a call, and the shapes that parse in no reading as an element.
    'const f = async < b;', 'const f = async<T>(x);', 'const f = async <T extends X>(x);', 'const f = async <div>x</div>;', 'const f = async <T>x</T>;', 'const f = async <T extends X>text</T>;',
    'const f = async <T extends>x</T>;', 'const f = async <T extends/>;', 'const f = async <b/>;',
    // The rule asks whether `await` and `yield` are identifiers, which the function around them decides; after `async` the `<` is code either way.
    'const f = async <await,>(x: T) => x;', 'const f = async <yield,>(x: T) => x;',
    // After a line break `async` is a name, and a head that cannot be an element is code whatever it is: `async` ends the statement and an arrow follows.
    'const f = async\n<T,>(x: T) => x;', 'const f = async /*\n*/ <T,>(x: T) => x;', 'const f = async\u2028<T,>(x: T) => x;', 'const f = async\n<T extends X>(x: T) => x;',
  ]);
  assertAmbiguous('keyword', [
    ['const f = async\n<T extends X>text</T>;', '<T extends X>'], ['const f = async /*\n*/ <T extends X>text</T>;', '<T extends X>'], ['const f = async\u2028<T extends X>text</T>;', '<T extends X>'],
    ['const f = async\n<div>x</div>;', '<div>'], ['const f = async\n<T extends>x</T>;', '<T extends>'], ['const f = async\n<T extends/>;', '<T extends/>'],
  ]);
  // Spelled with an escape the word is not `async`.
  assertAmbiguous('identifier', [['const f = \\u0061sync <T,>(x: T) => x;', '\\u0061sync']]);
  // A word cut short by a letter beyond ASCII or by `#` is not `async` either.
  assertAmbiguous('identifier', [['const f = éasync <T extends X>text</T>;', '<T extends X>'], ['class C { #async = 1; m() { return this.#async <T extends X>text</T>; } }', '<T extends X>']]);
});

// The premise, against TypeScript: after `async` and a `<` on its line TypeScript never reads an element, whatever the head after the `<` is — an async arrow's type parameters, a method named
// `async` that has type parameters (an object literal's or a class's), or the identifier `async` and a comparison or the type arguments of a call — with every kind of trivia between them.
// (After a line break the same text is not an arrow: `async` is a name there, and `<T,>(x: T) => x` begins the next statement or continues this one.)
test('TypeScript: a "<" after `async` on its line is never an element, and the lexer reads the text after it as the code it is', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const separators = ['', ' ', '\t', '\v', '\f', '\u00a0', '\u0085', '\u1680', '\u2000', '\u200b', '\u202f', '\u205f', '\u3000', '\ufeff', ' /* c */ '];
  // Every head kind: the generic shapes of the rule, an element's shapes (a name, `div`, a constraint with and without a parameter list, a `/>`), a method's, a call's type arguments.
  const heads = [
    '<T,>(x: T) => MARK', '<T extends X>(x: T) => MARK', '<T = X>(x: T) => MARK', '<const T,>(x: T) => MARK', '<T extends X = Y>(x: T) => MARK', '<T, U>(x: T, y: U) => MARK',
    '<T>(x: T) { return MARK; }', '<T>(x: T): T { return MARK; }', '<T extends X>(x: T) { return MARK; }', '<T,>(x: T) { return MARK; }', '<T>(MARK)', '<T extends X>(MARK)',
    '<T>MARK</T>', '<div>MARK</div>', '<T extends X>MARK</T>', '<T extends>MARK</T>', '<T extends/>', '<b/>', '<await>MARK</await>', '<yield,>(x: T) => MARK',
  ];
  const frames = [
    'const f = @;', 'export default @;', 'foo(@);', 'const f = [@];', 'const f = { k: @ };', 'const f = c ? @ : null;', 'let f; f = @;', '@;',
    'const o = { @ };', 'const o = { a: 1, @ };', 'class C { @ }', 'class C { static @ }', 'class C { x = 1; @ }', 'const o = { async };',
  ];
  const after = ' const re = /navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/; navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});';
  let parsed = 0;
  const asElement = [];
  const heard = new Set();
  for (const frame of frames) {
    for (const separator of separators) {
      for (const head of heads) {
        const code = `declare const T: any, X: any, Y: any, x: any, c: any, foo: any, MARK: any; ${frame.replace('@', `async${separator}${head}`)}${after}`;
        const source = cleanSourceFile(ts, code);
        if (!source) continue;
        parsed += 1;
        const at = code.indexOf('<');
        if (isElement(readingAt(ts, source, at))) { asElement.push(code); continue; }
        heard.add(head);
        assert.deepStrictEqual(ambiguities(code), [], `no guess: ${JSON.stringify(code)}`);
        // The regex after it is a regex, and the one call is the code that it is.
        assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, `the regex is data and only the real call is code: ${JSON.stringify(code)}`);
      }
    }
  }
  assert.deepStrictEqual(asElement, [], 'TypeScript reads an element after `async` and a `<` on its line');
  assert.ok(parsed >= 600, `only ${parsed} programs parsed`);
  // Every head kind that can be code was met: the generic ones, a method's, a call's, and the element-shaped ones that parse as a comparison.
  for (const head of ['<T,>(x: T) => MARK', '<T extends X>(x: T) => MARK', '<T>(x: T) { return MARK; }', '<T>(MARK)', '<T extends X>(MARK)']) assert.ok(heard.has(head), `a program with the head ${head} parses`);
});

// After a `>` the lexer cannot tell a comparison, the end of a cast's type arguments, a JSX tag and the `>` of an arrow apart without parsing:
//   const half = total as Types . Alias<number> / 2; const re = /\/*$/;    a division, but its type name is spelled in a way the scan misses
// The `>` of `=>`, which is always an arrow, is certain, and so is the `>` that closes the type arguments of a cast whose `as` or `satisfies` the lexer can prove is the keyword of one (below).
test('ambiguity angle: a "/" or "<" after a ">" that is not the ">" of an arrow', () => {
  assertAmbiguous('angle', [
    ['const half = total as Types . Alias<number> / 2; const re = /x/;', '/ 2; const re'],
    ['const c = 3 >/x/.test("x");', '/x/.test'],
    ['const a = 1 > <div>x</div>;', '<div>'],
  ]);
  assertCertain([
    'const f = () => /x/.test(s);', 'const f = (a) => <div/>;', 'a >= /x/.test(b)', 'const a = 5 >> 1 / 2 / 3;', 'const f = async () => /x/.exec(s);',
    'const a = total as Alias<number>;', 'const a = <div>x</div>;',
    'const half = total as Alias<number> / 2; const re = /x/;', 'const half = total satisfies Alias<number> / 2; const re = /x/;', 'const lt = total as Alias<number> < limit; const re = /x/;',
  ]);
});

// The `>` that ends a cast's type arguments is read with certainty, and TypeScript puts the operator after it together by itself: `x as A<B>>= y` is `x as A<B>`, then `>=`. So a run of `>`
// before the last `=` is never one operator the lexer can name (`>=`, `>>=`, `>>>=`, and any count beyond): it is a guess, whatever the first of them is, wherever the text after the `<`
// leaves both readings open — a head with a constraint and a parameter list that a `:` follows, JSX text after a comparison and an arrow's return type after an assignment. Where the head
// settles it, nothing is said: with no parameter list it is an element in every program that parses (an initialiser there would be an arrow with no parameters, an error), and where the rule
// reads an element both readings agree. A lone `>` before the `<` is the `angle` guess, said by the token's own class too.
test('ambiguity operator: a run of ">" and a "=" before a "<" is a guess whatever the count, since the first ">" may end type arguments', () => {
  for (const operator of ['>=', '>>=', '>>>=', '>>>>=']) {
    for (const head of ['x as A<B>', 'x satisfies A<B>', 'x as A<B<C>>', 'v ', 'a ']) {
      const code = `const k = ${head}${operator}<T extends X>(x: T): MARK</T>;${REGEX_STATEMENT}\n`;
      assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf('<T'), 'operator'], JSON.stringify(code));
      assert.ok(!maskOf(code).includes('MARK') && !maskOf(code).includes('navigateTo'), `the element is read, and the regex after it is data: ${JSON.stringify(code)}`);
      const element = `const k = ${head}${operator}<T extends X>MARK</T>;${REGEX_STATEMENT}\n`;
      assert.deepStrictEqual(ambiguities(element), [], JSON.stringify(element));
      assert.ok(!maskOf(element).includes('MARK') && !maskOf(element).includes('navigateTo'), `the element is read, and the regex after it is data: ${JSON.stringify(element)}`);
    }
  }
  // Where the rule reads an element anyway, there is nothing to guess: `<T extends>` and `<div>` are elements either way.
  assertCertain(['const k = x as A<B>>= <div>MARK</div>;', 'const k = x as A<B>>>= <T extends>MARK</T>;', 'const k = a >>= <div>MARK</div>;']);
  // A `>` that is not the end of `=>` and is not followed by `=` is the `angle` guess, said once — unless it closes the type arguments of a cast the lexer can prove is one, which a `<` after it compares.
  for (const code of ['const k = x as A<B>> <T extends X>MARK</T>;', 'const k = x as A<B>>><T extends X>MARK</T>;']) {
    assert.deepStrictEqual(ambiguities(code), [[code.indexOf('<T'), 'angle']], JSON.stringify(code));
  }
  assertCertain(['const k = x as A<B><T extends X>MARK</T>;']);
  // A closer followed by an operator of its own is that operator: the closer is a token of its own (TypeScript's scanner never puts a `>` together with what follows).
  assertCertain(['const k = x as A<B>== <T extends X>MARK</T>;', 'const k = x as A<B>!= <T extends X>MARK</T>;', 'const k = x as A<B>&& <T extends X>MARK</T>;']);
});

// A `>` — or `>>`, `>>>` — that is an operator for certain, because it follows a cast's closer, a regex or an element this lexer read, is a comparison or a shift, and the operand
// after a binary operator is a unary expression: a `<` there opens an element and nothing else, whatever the rule would read for the head (`<T extends X>`). Read by the rule,
// the element's text was code and the regex after it held a token that was rewritten.
test('a "<" after a ">" that is an operator for certain opens an element: the regex after it is data', () => {
  for (const before of ['const k = x as A<B> > ', 'const k = /x/ > ', 'const k = <b/> > ', 'const k = x as A<B> >> ', 'const k = x as A<B> >>> ', 'const k = /x/ >> ',
    'const k = x satisfies A<B> > ', 'const k = x as A<B<C>> > ']) {
    const code = `${before}<T extends X>MARK</T>;${REGEX_STATEMENT}\n`;
    assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
    assert.ok(!maskOf(code).includes('MARK') && !maskOf(code).includes('navigateTo'), `the element is read, and the regex after it is data: ${JSON.stringify(code)}`);
  }
});

// `*` before a `<`. After `function` the parser reads an optional `*`, an optional name and then type parameters (parser.ts, parseFunctionExpression and parseFunctionDeclaration,
// https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts), so a `<` there opens them whatever follows: `function* <T>(x: T) {}`. A lexer that took the `*` for a
// multiplication read `<T>(x: T) {…}` as an element, and the `</T>` in a string after it for its closing tag. After `yield` in a generator the delegation's operand is an assignment
// expression, where the rule applies (`yield* <T,>(x: T) => x`), and outside one `yield` is a name and the `*` multiplies (`yield * <T extends X>text</T>`): a guess where the text after
// the `<` may be an element. Any other `*` multiplies.
const CALL_IN_A_STRING = `const s = '</T>;navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});//';`;
test('a "<" after `function*` opens type parameters, for certain: the text after it is code, and a closing tag in a later string closes nothing', () => {
  for (const code of [
    'const g = function* <T>(x: T) { yield x; };', 'const g = async function* <T>(x: T) { yield x; };', 'export default function* <T>(x: T) { yield x; }', 'export default async function* <T>(x: T) { yield x; }',
    'const g = function*<T>(x: T) { yield x; };', 'const g = function * <T>(x: T) { yield x; };', 'const g = function\n*\n<T>(x: T) { yield x; };', 'const g = function /* c */ * /* d */ <T>(x: T) { yield x; };',
    'const g = function\u0085*\u200b<T>(x: T) { yield x; };', 'const g = function\u2028*\u2029<T>(x: T) { yield x; };', 'const g = (function* <T>(x: T) { yield x; });', 'f(function* <T>(x: T) { yield x; });',
    'const g = function* <T extends X>(x: T) { yield x; };', 'const g = function* <T,>(x: T) { yield x; };', 'const g = function* <T = X>(x: T) { yield x; };', 'const g = function* <const T>(x: T) { yield x; };',
    'export default function* <T>() {}', 'const g = { m: function* <T>(x: T) { yield x; } };',
  ]) {
    const page = `${code}\n${CALL_IN_A_STRING}\nexport default function P() { return null; }\n`;
    assert.deepStrictEqual(ambiguities(page), [], JSON.stringify(page));
    assert.ok(!maskOf(page).includes('navigateTo'), `the call is in a string: ${JSON.stringify(page)}`);
    assert.ok(maskOf(page).includes('yield') || !code.includes('yield'), `the body is code: ${JSON.stringify(page)}`);
  }
  // A name between them is the usual place for type parameters, and is not asked: `function* name<T>` is read as it always was.
  assertCertain(['const g = function* name<T>(x: T) { yield x; };', 'function* name<T>(x: T) { yield x; }', 'export default function* name<T>() {}']);
});

test('a "<" after `yield*` is a guess where the rule reads a generic and an element may compile; after another "*" it is an element, and a property named like a keyword multiplies', () => {
  // The rule reads these as constraints, and a name `yield` outside a generator multiplies by an element: both compile where the text after the head may be either — a parameter list and a
  // colon is an arrow's return type or JSX text — and which is not known.
  assertAmbiguous('operator', [
    ['function* g() { yield * <T extends X>(x: T): MARK; }', '<T extends'], ['function* g() { yield\n* <T extends X>(x: T): MARK; }', '<T extends'],
    ['function* g() { yield/* c */*/* d */<T extends X>(x: T): MARK; }', '<T extends'], ['function* g() { yield\u0085*\u200b<T extends X>(x: T): MARK; }', '<T extends'],
    ['function* g() { yield* <T extends X>(x: T): MARK; }', '<T extends'],
  ]);
  // A head that cannot be an element is type parameters, in a generator and outside one, and a head that is no more than an element's is an element: there is nothing to guess.
  assertCertain([
    'function* g() { yield* <T,>(x: T) => MARK; }', 'function* g() { yield\n* <T,>(x: T) => MARK; }', 'function* g() { yield/* c */*/* d */<T,>(x: T) => MARK; }',
    'function* g() { yield\u0085*\u200b<T,>(x: T) => MARK; }', 'function* g() { yield* <T extends X>(x: T) => MARK; }', 'function* g() { yield* <T = X>(x: T) => MARK; }',
    'function* g() { yield * <T extends X>MARK</T>; }', 'function* g() { yield\n* <T extends X>MARK</T>; }', 'function* g() { yield* <T extends X>(MARK)</T>; }',
  ]);
  // Where the rule reads an element, both readings are the element: nothing to guess.
  assertCertain(['function* g() { yield* <div>MARK</div>; }', 'function* g() { yield * <T extends>MARK</T>; }']);
  // A multiplication: an element is the operand, whatever follows its name. A property is no keyword.
  assertCertain([
    'const k = a * <T extends X>MARK</T>;', 'const k = a*<T extends X>MARK</T>;', 'const k = 2 * <T extends X>MARK</T>;', 'const k = f(x) * <T extends X>MARK</T>;', 'const k = a[0] * <T extends X>MARK</T>;',
    'const k = obj.function * <T extends X>MARK</T>;', 'const k = obj.function * <b>MARK</b>;', 'const k = obj?.function * <T extends X>MARK</T>;', 'const k = obj.\nfunction * <T extends X>MARK</T>;',
    'const k = obj.yield * <T extends X>MARK</T>;', 'const k = obj\n.yield * <T extends X>MARK</T>;', 'const k = functionx * <T extends X>MARK</T>;', 'const k = xfunction * <T extends X>MARK</T>;',
    'const k = a ** <T extends X>MARK</T>;', 'const k = a! * <T extends X>MARK</T>;',
  ].map((code) => `${code}\n`));
  for (const code of ['const k = obj.function * <T extends X>MARK</T>;', 'const k = obj.yield * <T extends X>MARK</T>;', 'const k = a * <T extends X>MARK</T>;']) assert.ok(!maskOf(code).includes('MARK'), `the element is read: ${code}`);
  // A keyword cut short by `#` or a letter beyond ASCII is not the word: the `*` after it is read as a guess where the rule reads a generic and an element may compile.
  assertAmbiguous('identifier', [['const k = éfunction * <T extends X>(x: T): MARK;', '<T extends'], ['class C { #function = 1; m() { return this.#function * <T extends X>(x: T): MARK; } }', '<T extends']]);
  assertCertain(['const k = éfunction * <T,>(x: T) => MARK;', 'class C { #function = 1; m() { return this.#function * <T,>(x: T) => MARK; } }', 'const k = éfunction * <T extends X>MARK</T>;']);
});

// A keyword spelled with a Unicode escape is a plain identifier (`\u0069f` is a name, not `if`), and a name that merely CONTAINS a keyword —
// `ñreturn`, `#new` — is not that keyword. Reading such a word back from a `/` takes the keyword for it, or misses the cast it ends:
//   var Al\u0069as = 12; var q = Al\u0069as/2; var re = /\/*$/;
test('ambiguity identifier: a Unicode escape in code, or a keyword-looking word cut by a non-ASCII letter or "#"', () => {
  assertAmbiguous('identifier', [
    ['var Al\\u0069as = 12; var q = 1;', '\\u0069as'],
    ['var \\u0069f = 1;', '\\u0069f'],
    ['const q = total as Al\\u0069as<number> / 2; const re = /x/;', '\\u0069as'],
    ['const q = ñreturn /x/.test(s) / 2;', '/x/.test'],
    ['class A { #new = 1; f() { return this.#new / 2 / 3; } }', '/ 2 / 3'],
  ]);
  assertCertain([
    'const s = "\\u0069";', 'const r = /\\u0069/;', '// \\u0069\n', 'const t = `\\u0069`;', 'const a = <a b="\\u0069" />;', "const s = '\\u{69}';",
    'return\u00a0/x/.test(s)', 'const q = x.return / 2 / 3;', 'const a = <p>\\u0069</p>;',
  ]);
});

// A JSX tag may carry TypeScript type arguments. For names — `<DataGridRow<Row>`, unions, arrays, nested arguments — the tag scan and
// TypeScript agree, and the shipped samples use them. They differ where the arguments hold a string or template type (escapes, line
// continuations: a JSX attribute has neither), an object type, or a function type (its `=>` is not an angle bracket). The string
//   <Component<"quote\"\<LF>/*"> onClick={…} />
// ends early, and the `/*` after it opens a comment over a real handler. The frontier is the element's `<`; the types are not scanned.
test('ambiguity jsx-type-arguments: type arguments the tag scan reads by the wrong rules are marked at the element\'s "<"', () => {
  assertAmbiguous('jsx-type-arguments', [
    ['const a = <Component<"quote\\"\\\n/*"> onClick={() => navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})} />;', '<Component'],
    ['const a = <Foo<"a"> b={1} />;', '<Foo'],
    ["const a = <Foo<'a'> b={1} />;", '<Foo'],
    ['const a = <Link<`https://${string}`> to={u} />;', '<Link'],
    ['const a = <Foo<{ a: string }> b={1} />;', '<Foo'],
    ['const a = <Foo<() => void> b={1} />;', '<Foo'],
    ['const a = <A b={<B<"x"> />} />;', '<B<"x">'],
  ]);
  assertCertain([
    'const a = <DataGridBody<Account>>{x}</DataGridBody>;', 'const a = <DataGridRow<Row> key={1}>x</DataGridRow>;', 'const a = <Select<string | number> items={r} />;',
    'const a = <Table<Array<Row>> rows={r} />;', 'const a = <Table<Row[]> rows={r} />;', 'const a = <Foo<A, B> x={1} />;', 'const a = <Foo<A.B> x={1} />;',
    'const a = <Component prop={1} />;', 'const a = <A></A>;', 'const a = <>{x}</>;', 'const a = <A b={<C/>} d="x" />;', 'const a = <A b={x < y} />;',
    'const f = <T,>(x: T) => x;', 'const a = <A b="x" c=\'y\' />;', 'const a = <A b={() => c} />;',
  ]);
});

// A JSX attribute string is read by two rules. TypeScript scans an attribute value by the character right after the `=`
// (scanner.ts, scanJsxAttributeValue, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts). A quote there starts a JSX string — no escapes, a line break allowed, ended by
// the next quote — which is how Babel and esbuild read every attribute string. Anything else goes to scan(), which skips all trivia, white space of every kind and comments, and reads a JavaScript
// string: a backslash escapes the character after it, and a raw line break is an error. So in
//   <C x= '\'/>;navigateTo({ … });//' />
// TypeScript reads ONE string, `'\'/>;navigateTo({ … });//'`, and the call is text; the other compilers end it at the second quote and find a real call. The lexer reads the JSX string, and where a
// backslash makes the JavaScript string end at another quote it reports the quote (`jsx-attribute`). Where the readings end together — no backslash, an escape that moves nothing, a line
// continuation — or the quote follows the `=` at once, every compiler reads the same string, and there is nothing to report.
const JSX_ATTRIBUTE_TAIL = 'const b = 1;//';
test('ambiguity jsx-attribute: a string written after white space or a comment that follows its "=", whose backslash moves its end, is marked at its quote', () => {
  const after = (between, quote = "'") => `const a = <C x=${between}${quote}\\${quote}/>;${JSX_ATTRIBUTE_TAIL}${quote} />;`;
  assertAmbiguous('jsx-attribute', [
    [after(' '), "'\\'/>"],
    [after(' ', '"'), '"\\"/>'],
    [after('   '), "'\\'/>"],
    [after('\t'), "'\\'/>"],
    [after('\n'), "'\\'/>"],
    [after('\r\n'), "'\\'/>"],
    [after('\u2028'), "'\\'/>"],
    [after('/* c */'), "'\\'/>"],
    [after(' /* c */ '), "'\\'/>"],
    [after(' // c\n'), "'\\'/>"],
    // Every character TypeScript skips there but a regular expression's `\s` does not, and one that it does: each is trivia to TypeScript, so each is a string that follows white space.
    [after('\u0085'), "'\\'/>"], [after('\u200B'), "'\\'/>"], [after('\u00A0'), "'\\'/>"], [after('\uFEFF'), "'\\'/>"],
    ['const a = <C x =  \'\\\'/>;const b = 1;//\' />;', "'\\'/>"],
    // A second attribute, a string whose backslash-quote is in the middle, and an element in a container: the same rule at each quote that does not follow its `=`.
    ['const a = <C y="1" x= \'\\\'/>;const b = 1;//\' />;', "'\\'/>"],
    ["const a = <C x= 'it\\'s' y=\"z\" />;", "'it\\'s'"],
    ["const a = <A b={<C x= '\\'/>} />;const b = 1;//' />;", "'\\'/>"],
    // A line break after a backslash-quote is not a line continuation, and the string goes on to the end of the line, where TypeScript reports it: the quote is where the readings differ.
    ["const a = <C x= '\\'\nb' />;", "'\\'\n"],
  ]);
  assertCertain([
    // A quote right after the `=`: a JSX string to every compiler, whatever it holds.
    after(''), after('', '"'), "const a = <C x='a\\' y=\"b\\\" />;", 'const a = <C x="\\" />;',
    // After trivia, with no backslash: both readings end at the same quote.
    'const a = <C x= "ab" y= \'cd\' />;', 'const a = <C x=\n"ab" />;', 'const a = <C x=/* c */"ab" />;', 'const a = <C x= "" />;',
    // With a backslash that moves nothing: an escaped backslash, an escape of another character, a line continuation (of every kind of line break).
    'const a = <C x= "a\\\\" />;', 'const a = <C x= "c\\n" y= \'\\\\\' />;', 'const a = <C x= "\\u0041\\x41\\0" />;', 'const a = <C x= "a\\\nb" />;', 'const a = <C x= "a\\\r\nb" />;',
    'const a = <C x= "a\\\u2028b" />;', 'const a = <C x= "a\\\u2029b" />;', 'const a = <C x= "\\\\\\\\" />;',
    // A raw line break with no backslash: TypeScript rejects the page (an unterminated string), and the others read a JSX string, so it is read as they do and nothing is reported.
    'const a = <C x= "a\nb" />;', 'const a = <C x= "a\rb" />;', "const a = <C x= 'a\nb' y=\"c\" />;", 'const a = <C x= "a\u2028b" />;',
    // Not an attribute: a string in an expression container, in JSX text, or in the type arguments of a tag (the latter is `jsx-type-arguments`).
    "const a = <C x={ 'a\\' } />;", 'const a = <p>a \\" "b" it\'s</p>;', 'const a = <C x={"\\""} y= "b" />;',
  ]);
  assert.deepStrictEqual(ambiguities('const a = <Foo<"a"> b= "c" />;').map(([, kind]) => kind), ['jsx-type-arguments'], 'a string in type arguments is no attribute string');
  // The lexer reads what it always did, and listening changes nothing it blanks: the call in the first example is code to it, and only the frontier is new.
  const hidden = `const a = <C x= '\\'/>;navigateTo({pageType:"generative",pageId:"PAGEREF_detail"});${JSX_ATTRIBUTE_TAIL}' />;`;
  assert.ok(blankNonCodePreservingTemplateExpressions(hidden).includes('navigateTo'), 'read as the others read it, the call is code');
  assert.deepStrictEqual(navReferencedKeys(hidden), ['detail'], 'and the reader sees it, after the frontier');
});

// The same strings, against both parsers: where the quote follows the `=` at once, or the readings end together, TypeScript and Babel agree on what is a call; where a backslash moves the end,
// TypeScript reads one string and Babel an element and a call (or the page is one only TypeScript parses), and the lexer names it. (esbuild reads a JSX string like Babel does.) Babel is
// optional: BABEL_ORACLE_PATH points at an `@babel/parser` package.
const JSX_ATTRIBUTE_CALL = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})';
// A string with `"` for its quote cannot hold a call written with `"`, so the call is written with `'`.
const JSX_ATTRIBUTE_CALL_SINGLE_QUOTED = "navigateTo({pageType:'generative',pageId:'PAGEREF_detail'})";
// [what, page, whether the lexer names a guess, the calls TypeScript reads (null: it rejects the page), the calls Babel reads (null: it rejects the page)]
const JSX_ATTRIBUTE_PAGES = [
  ['a space, then a backslash-quote', `const e = <C x= '\\'/>;${JSX_ATTRIBUTE_CALL};//' />;`, true, 0, 1],
  ['a space, then a backslash-quote, double quotes', `const e = <C x= "\\"/>;${JSX_ATTRIBUTE_CALL_SINGLE_QUOTED};//" />;`, true, 0, 1],
  ['a block comment, then a backslash-quote', `const e = <C x=/* c */'\\'/>;${JSX_ATTRIBUTE_CALL};//' />;`, true, 0, 1],
  ['a line comment, then a backslash-quote', `const e = <C x= // c\n'\\'/>;${JSX_ATTRIBUTE_CALL};//' />;`, true, 0, 1],
  ['a no-break space, then a backslash-quote', `const e = <C x=\u00a0'\\'/>;${JSX_ATTRIBUTE_CALL};//' />;`, true, 0, 1],
  ['a second attribute after trivia', `const e = <C a="1" x= '\\'/>;${JSX_ATTRIBUTE_CALL};//' />;`, true, 0, 1],
  // A next-line character and a zero-width space are trivia to TypeScript only: Babel does not parse the page.
  ['a next-line character, then a backslash-quote', `const e = <C x=\u0085'\\'/>;${JSX_ATTRIBUTE_CALL};//' />;`, true, 0, null],
  ['a zero-width space, then a backslash-quote', `const e = <C x=\u200b'\\'/>;${JSX_ATTRIBUTE_CALL};//' />;`, true, 0, null],
  // An escaped quote in the middle: TypeScript's string runs to the last quote, and Babel cannot parse what is left of the element.
  ['an escaped quote in the middle of the value', `const e = <C x= 'it\\'s' y= "z" />;${JSX_ATTRIBUTE_CALL};`, true, 1, null],
  ['the quote right after the "="', `const e = <C x='\\'/>;${JSX_ATTRIBUTE_CALL};//' />;`, false, 1, 1],
  ['the quote right after the "=", double quotes', `const e = <C x="\\"/>;${JSX_ATTRIBUTE_CALL};//" />;`, false, 1, 1],
  ['a space, then no backslash', `const e = <C x= "ab" y= 'cd' />;${JSX_ATTRIBUTE_CALL};`, false, 1, 1],
  ['a space, then an escaped backslash', `const e = <C x= "a\\\\" />;${JSX_ATTRIBUTE_CALL};`, false, 1, 1],
  ['a space, then another escape', `const e = <C x= "c\\n" y= '\\\\' />;${JSX_ATTRIBUTE_CALL};`, false, 1, 1],
  ['a space, then a line continuation', `const e = <C x= "a\\\nb" />;${JSX_ATTRIBUTE_CALL};`, false, 1, 1],
  ['a space, then a CRLF line continuation', `const e = <C x= "a\\\r\nb" />;${JSX_ATTRIBUTE_CALL};`, false, 1, 1],
  // A raw line break in the string with no backslash: TypeScript reports an unterminated string, and Babel takes it. The lexer reads it as Babel does and names nothing.
  ['a space, then a raw line break', `const e = <C x= "a\nb" />;${JSX_ATTRIBUTE_CALL};`, false, null, 1],
];
test('TypeScript and Babel: a JSX attribute string after trivia is a JavaScript string to one and a JSX string to the other, and the lexer names exactly the pages where a call differs', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const typeScriptCalls = (code) => {
    const source = ts.createSourceFile('page.tsx', `declare const C: any, navigateTo: any;\n${code}\n`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (source.parseDiagnostics.length > 0) return null;
    let calls = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') calls += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return calls;
  };
  for (const [what, code, guess, theirs] of JSX_ATTRIBUTE_PAGES) {
    assert.strictEqual(typeScriptCalls(code), theirs, `${what}: the calls TypeScript reads`);
    assert.deepStrictEqual(ambiguities(code).map(([, kind]) => kind), guess ? ['jsx-attribute'] : [], what);
    // Where the lexer names no guess and TypeScript parses the page, the call the lexer reads as code is the one TypeScript reads.
    if (!guess && theirs !== null) assert.strictEqual(blankNonCodePreservingTemplateExpressions(code).split('navigateTo(').length - 1, theirs, `${what}: no guess, and the same calls`);
  }
  const babel = loadBabelOracle();
  if (!babel) return t.diagnostic('no Babel parser oracle: set BABEL_ORACLE_PATH to an @babel/parser package to compare the readings');
  const babelCalls = (code) => {
    let tree;
    try {
      tree = babel.parse(`declare const C: any, navigateTo: any;\n${code}\n`, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    } catch {
      return null;
    }
    let calls = 0;
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee && node.callee.name === 'navigateTo') calls += 1;
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child.type === 'string') visit(child);
      }
    };
    visit(tree.program);
    return calls;
  };
  for (const [what, code, guess, theirs, others] of JSX_ATTRIBUTE_PAGES) {
    assert.strictEqual(babelCalls(code), others, `${what}: the calls Babel reads`);
    // Both parse the page: the lexer names a guess exactly where they read other calls.
    if (theirs !== null && others !== null) assert.strictEqual(theirs !== others, guess, `${what}: a guess exactly where the compilers read other calls`);
  }
});

// A `<` where an expression starts is an element or a generic arrow. The lexer recognises an element by a letter, `_`, `$` or `>` right after
// the `<`; JSX also allows space after it and names beyond ASCII.
//   const a = < div>x</div>;        const b = <Ñ>x</Ñ>;
test('ambiguity jsx-open: a "<" where an element may start that the lexer does not read as one', () => {
  assertAmbiguous('jsx-open', [
    ['const a = < div>x</div>;', '< div'],
    ['const a = <Ñ>x</Ñ>;', '<Ñ'],
    ['const a = <p>a <Ñ/></p>;', '<Ñ/'],
    ['const a = <p>a < div/></p>;', '< div'],
  ]);
  assertCertain(['a < b', 'if (a < 3) {}', 'const f = <T,>(x: T) => x;', 'for (let i = 0; i < n; i++) {}', 'const a = b <c;', 'const a = <p>a</p>;', 'const a = <p>a <b/></p>;']);
  // A `<` where an element may start as an attribute's value, and a closing tag that holds anything but a name and comments, are the same: the lexer does not read them as TypeScript does.
  assertAmbiguous('jsx-open', [
    ['const a = <A x=< B/>>text</A>;', '< B'],
    ['const a = <A x=<Ñ/>>text</A>;', '<Ñ'],
    ['const a = <A></A b>;', '</A b>'],
    ['const a = <A></A "x">;', '</A "x">'],
    ['const a = <A></A{x}>;', '</A{x}>'],
    ['const a = <A></\\u0041>;', '</\\u0041>'],
    ['const a = <A></A:>;', '</A:>'],
  ]);
});

// An attribute's value may be an element or a fragment: after the `=` — with white space and comments between, which TypeScript's scanner skips before a value that is no quote right after
// the `=` (scanner.ts, scanJsxAttributeValue) — a `<` begins it (parser.ts, parseJsxAttributeValue), and type arguments come only right after the tag's name (tryParseTypeArguments).
//   const e = <A x=<B/>>text</A>; const re = /navigateTo({ … })/;
// Read as type arguments, the `/>` of `<B/>` ended the OUTER tag, `>text</A>` was code, and the regex after it — a regex to TypeScript — was read as code, and its token rewritten. The value is lexed as
// the element it is, in a frame of its own, and the tag that holds it goes on when it ends.
const ATTRIBUTE_VALUE_ELEMENTS = [
  '<B/>', '<B />', '<B></B>', '<B>t</B>', '<></>', '<>t</>', '<B x="1" />', '<B y=<C/> />', '<B y=<C></C>>t</B>', '<B>{1}</B>', '<B>{"</A>"}</B>', '<B>{/* </A> */ 1}</B>', '<B<T> />', '<B.C/>', '<B>a > b</B>',
  '<B x={1} />', '<B {...p} />', '<B/* c */x="1" />', '<B>t<D/>u</B>', '<B>{<C/>}</B>', '<B y= <C/> >t</B>', '<B-c/>', '<this/>', "<B x='1' />", '<B>\'</B>', '<B>a &gt; b</B>',
];
test('an element or a fragment written as an attribute value is read as an element: its end is its own, and the tag that holds it goes on', (t) => {
  const callAfter = `${REGEX_STATEMENT} ${READ_CALL};`;
  const programs = [];
  for (const value of ATTRIBUTE_VALUE_ELEMENTS) {
    for (const gap of ['', ' ', '\n', '/* c */', ' /* > */ ', '// c\n', '\u00a0', '\u0085', '\u200b']) {
      for (const [outer, label] of [['<A x=@>text</A>', 'closed'], ['<A x=@ />', 'self-closing'], ['<A x=@ y="1" z={2}>text</A>', 'more attributes'], ['<A y="1" x=@>text</A>', 'after an attribute'], ['<A.B x=@>text</A.B>', 'dotted']]) {
        programs.push({ code: `const e = ${outer.replace('@', `${gap}${value}`)};${callAfter}`, label: `${label}, ${JSON.stringify(gap)}, ${value}` });
      }
    }
  }
  for (const { code, label } of programs) {
    assert.deepStrictEqual(ambiguities(code), [], label);
    const mask = maskOf(code);
    assert.strictEqual(mask.split('navigateTo(').length - 1, 1, `${label}: the regex is data, and only the real call is code`);
    assert.ok(!mask.includes('text'), `${label}: the text of the outer element is text`);
  }
  // Where the call is real code — after the element, with nothing misread — the reader sees it and rewrites it.
  const real = `const e = <A x=<B/>>text</A>; ${READ_CALL};\n`;
  assert.deepStrictEqual(navReferencedKeys(real), ['detail']);
  assert.deepStrictEqual(strayPageRefs(real), []);
  // The same text inside a template, an expression container and an attribute container, and as a child of another element: the depth of the elements around it is not its own.
  for (const code of [
    `const s = \`\${<A x=<B/>>text</A>}\`;${callAfter}`, `const e = <p>{<A x=<B/>>text</A>}</p>;${callAfter}`, `const e = <p q={<A x=<B/>>text</A>} />;${callAfter}`,
    `const f = () => <A x=<B/>>text</A>;${callAfter}`,
    `const e = <p><A x=<B/>>text</A></p>;${callAfter}`, `const e = <p><q><A x=<B/> /></q>text</p>;${callAfter}`, `const e = <p>a<A x=<B><C/></B>>text</A>b</p>;${callAfter}`,
    `const e = <p><A x=<B y=<C/>/>>text</A></p>;${callAfter}`, `const e = <><A x=<B/>>text</A></>;${callAfter}`,
  ]) {
    assert.deepStrictEqual(ambiguities(code), [], code);
    assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, `the regex is data: ${code}`);
  }
  // A string after white space or a comment keeps its guess inside a value, as anywhere (`jsx-attribute`), and type arguments after the name are still type arguments.
  assertAmbiguous('jsx-attribute', [["const a = <A x=<B y= '\\'/>>text</A>;const b = 1;//' />;", "'\\'/>"]]);
  assertCertain(['const a = <A x=<B<T> y="1" />>text</A>;', 'const a = <A<T> x=<B/>>text</A>;', 'const a = <A<T> x=<B<U>/>>text</A>;', 'const a = <A x=<B/> y=<C/>>text</A>;']);
  // The type arguments of the element in a value are its own: a guess about them is reported at that element's `<`, not at the tag that holds it.
  assertAmbiguous('jsx-type-arguments', [['const a = <A x=<B<{ a: 1 }>/> />;', '<B<'], ['const a = <A<{ a: 1 }> x=<B/> />;', '<A<']]);
  // A `<` after an `=` inside the type arguments of a tag is part of a type — a function type's parameter initializer — and no attribute's value: the guess about the arguments stands.
  assertAmbiguous('jsx-type-arguments', [['const e = <Fn<(a = <T,>(x: T) => x) => void> />;', '<Fn<'], ['const e = <Fn<(a = <T extends X>(x: T) => x) => void> />;', '<Fn<']]);
  // What the lexer counts of a value's type arguments ends with the value: the `<` of two comparisons in a function type's initializers are never closed, and the string after the value is an attribute
  // of the tag that holds it, not a part of type arguments (which would move the guess to that tag).
  assertAmbiguous('jsx-type-arguments', [['const e = <A x=<Fn<(a = x < y, b = z < w) => void> /> y="1" />;', '<Fn<']]);
  // TypeScript reads each of them as an element with no diagnostic, and the regex after it as a regex.
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  let parsed = 0;
  for (const { code, label } of programs) {
    const source = ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (source.parseDiagnostics.length > 0) continue;
    parsed += 1;
    let calls = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') calls += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.strictEqual(calls, 1, `${label}: the one call TypeScript reads`);
  }
  assert.ok(parsed >= programs.length * 0.6, `only ${parsed} of ${programs.length} programs parse`);
});

// A closing tag is `</`, an optional name and a `>`, and TypeScript scans what is between them as ordinary tokens: white space of every kind and comments stand before the name, around the dots of
// a dotted one and before the `>` (parser.ts, parseJsxClosingElement, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts). A search for the first `>` ended the tag inside a comment:
//   const e = <A></A /*> navigateTo({ … }); */>;
// and read the rest of the comment as code, and a call in it as a real call. A comment in a closing tag is blanked and heard like any other, and a tag that holds anything else is a guess (`jsx-open`).
test('a closing tag is read as TypeScript reads it: white space and comments stand in it, and a ">" in a comment ends nothing', (t) => {
  const closings = [
    ['a block comment after the name', '<A></A /*> @ */>'], ['a block comment before the name', '<A></ /*> @ */ A>'], ['a line comment', '<A></A // > @\n>'], ['both', '<A></ /* > */ A // >\n>'],
    ['a dotted name with comments', '<A.B></A /*> @ */ . /* > */ B>'], ['a fragment with a comment', '<></ /*> @ */>'], ['a namespaced name', '<a:b></a:b /*> @ */>'], ['a dashed name', '<a-b></a-b /*> @ */>'],
    ['white space of every kind', '<A></\u0085A\u2028\u00a0\u200b>'], ['a nested element', '<A><B></B /*> @ */></A /*> @ */>'], ['text with a closing tag in it', '<A>x </A /*> @ */>'],
    ['this', '<this></this /*> @ */>'], ['a comment with a closing tag in it', '<A></A /* </A> @ */>'], ['an expression container', '<A>{1}</A /*> @ */>'],
    // A line comment ends at any line terminator TypeScript knows (ts.isLineBreak), and a name is read as a name: parts beyond ASCII, a letter beyond the BMP, the zero-width joiner.
    ['a line comment ended by CR', '<A></A // > @\r>'], ['a line comment ended by U+2028', '<A></A // > @\u2028>'], ['a line comment ended by U+2029', '<A></A // > @\u2029>'],
    ['a name beyond ASCII', '<A\u00d1></A\u00d1 /*> @ */>'], ['a letter beyond the BMP', '<A\u{1d4b3}></A\u{1d4b3} /*> @ */>'], ['a zero-width joiner', '<A\u200d></A\u200d /*> @ */>'],
    ['a middle dot', '<A\u00b7b></A\u00b7b /*> @ */>'], ['a dashed namespaced name', '<a-b:c-d></a-b:c-d /*> @ */>'],
  ];
  const programs = closings.map(([what, tag]) => [what, `const e = ${tag.replaceAll('@', READ_CALL)};${REGEX_STATEMENT}\n${READ_CALL};`, tag.includes('@')]);
  for (const [what, code, hasCall] of programs) {
    assert.deepStrictEqual(ambiguities(code), [], what);
    // The calls in the comments are comments, the regex is data, and the one call after them is code.
    assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, `${what}: only the real call is code`);
    if (hasCall) assert.ok(commentRanges(code).some(({ text }) => text.includes('navigateTo(')), `${what}: the call is in a comment the lexer heard`);
  }
  // The comments are heard: a comment in a closing tag that says TODO is an elision marker like any other.
  assert.strictEqual(findElisionMarker('const e = <A></A /* TODO: fill in */>;'), 'a TODO/FIXME comment');
  assert.deepStrictEqual(commentRanges('const e = <A></A /* c */ // d\n>;').map((c) => c.text), ['/* c */', '// d']);
  // A token in such a comment is a stray one, as in any comment, and the call after the element is not hidden.
  const tokenInComment = `const e = <A></A /*> ${READ_CALL}; */>;\n${READ_CALL};`;
  assert.deepStrictEqual(strayPageRefs(tokenInComment).map((r) => [r.token, r.line, 'frontier' in r]), [['PAGEREF_detail', 1, false]]);
  assert.deepStrictEqual(navReferencedKeys(tokenInComment), ['detail']);
  // A tag with anything but a name and comments in it is not read: the first `>` ends it, and the guess is reported. A name has one `:` and starts with an identifier start (TS1005, TS1003).
  assertAmbiguous('jsx-open', [['const a = <A></A b>;', '</A b>'], ['const a = <A><B></B x></A>;', '</B x>'], ['const a = <A></a:b:c>;', '</a:b:c>'], ['const a = <A></1A>;', '</1A>']]);
  // A closing tag with no `>` before the end of the source is unterminated, a cut page, and nothing there is a guess.
  for (const cut of ['const e = <A></A', 'const e = <A></A /* c', 'const e = <A></', 'const e = <A></A // c', 'const e = <A></A.']) {
    assert.strictEqual(endsMidStatement(cut), true, cut);
    assert.deepStrictEqual(ambiguities(cut), [], cut);
  }
  // TypeScript reads each as one element and no call but the real one.
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  for (const [what, code] of programs) {
    const source = ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.deepStrictEqual(source.parseDiagnostics.map((d) => d.code), [], `TypeScript parses: ${what}`);
    let calls = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') calls += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.strictEqual(calls, 1, `${what}: the one call TypeScript reads`);
  }
  for (const code of ['const e = <A></A b>;', 'const e = <A></A "x">;', 'const e = <A></A{x}>;', 'const e = <A></\\u0041>;', 'const e = <A></A:>;']) {
    assert.ok(ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics.length > 0, `TypeScript rejects ${code}`);
  }
});

// A hashbang. TypeScript's scanner skips a `#!` at the very start of the file, to the end of its line, as trivia (scanner.ts, scan(): `pos === 0` and isShebangTrivia, whose /^#!.*/ stops at a line
// terminator); anywhere else — after a byte order mark, a space, a line break — a `#!` is an error. So it is a comment in effect: blanked and heard as one. Read as code, `#!navigateTo({ … });` was a call.
test('a hashbang at the start of the file is a comment to the end of its line; anywhere else a "#!" is no hashbang', (t) => {
  const page = (first) => `${first}\nexport default () => null;\n`;
  for (const line of ['#!/usr/bin/env node', '#!', `#!${READ_CALL};`, `#!${READ_CALL}; // TODO: x`, '#! /* not a comment opener', '#!/* x */']) {
    const code = page(line);
    assert.deepStrictEqual(ambiguities(code), [], line);
    assert.strictEqual(maskOf(code).split('\n')[0].trim(), '', `${line}: blanked`);
    assert.strictEqual(blankLiterals(code).length, code.length, 'offsets map 1:1');
    assert.deepStrictEqual(commentRanges(code).map((c) => [c.start, c.end]), [[0, line.length]], `${line}: heard as a comment`);
    assert.strictEqual(hasDefaultExport(code), true, `${line}: the export on the next line is the page's`);
    assert.strictEqual(endsMidStatement(code), false, line);
    assert.deepStrictEqual(pageStructureProblems(code), line.includes('TODO') ? ['contains a TODO/FIXME comment — the page is incomplete'] : [], line);
  }
  // Every line terminator ends it: LF, CR, CR LF, LS, PS; a hashbang with nothing after it is a hashbang.
  for (const terminator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const code = `#!x${terminator}export default () => null;`;
    assert.deepStrictEqual(commentRanges(code).map((c) => [c.start, c.end]), [[0, 3]], JSON.stringify(terminator));
    assert.strictEqual(hasDefaultExport(code), true, JSON.stringify(terminator));
  }
  assert.deepStrictEqual(commentRanges('#!x').map((c) => [c.start, c.end]), [[0, 3]]);
  // A token in a hashbang is a stray one, reported on its line as one in a comment is, and the call after it is as ever.
  const withToken = `#!${READ_CALL};\nexport default () => { ${READ_CALL}; return null; };\n`;
  assert.deepStrictEqual(maskOf(withToken).split('navigateTo(').length - 1, 1, 'the call in the hashbang is not code');
  assert.deepStrictEqual(strayPageRefs(withToken).map((r) => [r.token, r.line, r.column, 'frontier' in r]), [['PAGEREF_detail', 1, withToken.indexOf('PAGEREF_') + 1, false]]);
  assert.deepStrictEqual(navReferencedKeys(withToken), ['detail']);
  // Only at offset 0: after a byte order mark, white space or a line break it is not a hashbang, and is code as it was.
  for (const lead of ['\uFEFF', ' ', '\n', '\t', '\r\n']) {
    const code = `${lead}#!${READ_CALL};\nexport default () => null;\n`;
    assert.deepStrictEqual(commentRanges(code), [], JSON.stringify(lead));
    assert.ok(maskOf(code).includes('navigateTo('), `${JSON.stringify(lead)}: a "#!" there is code, as it is to a lexer that has no rule for it`);
  }
  assert.deepStrictEqual(commentRanges('const a = 1; #!x\n'), []);
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  const parse = (code) => ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls = (source) => {
    let n = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') n += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return n;
  };
  assert.deepStrictEqual(parse(withToken).parseDiagnostics.map((d) => d.code), [], 'TypeScript parses a page with a hashbang');
  assert.strictEqual(calls(parse(withToken)), 1, 'and reads one call in it: the one after the hashbang');
  for (const lead of ['\uFEFF', ' ', '\n']) assert.ok(parse(`${lead}#!x\nexport default 1;`).parseDiagnostics.some((d) => d.code === 18026), `TypeScript rejects a "#!" after ${JSON.stringify(lead)} (TS18026)`);
});

// A `<` where an expression starts is an element or a generic arrow's type parameters, and in a .tsx file TypeScript tells them apart by the
// next few tokens, with no look-ahead window (parser.ts, `isParenthesizedArrowFunctionExpressionWorker`, the `LanguageVariant.JSX` branch,
// TypeScript 5.8). After an optional `const`, the token after the first identifier is
//   `extends`, and the token after that is not `=`, `>` or `/`    <T extends unknown>(x: T) => x      <T extends>x</T>      <T extends/>
//   `,` or `=`                                                     <T,>(x: T) => x      <T = string>(x: T) => x
// and anything else is an element: `<T>` is JSX in TSX (a generic arrow needs the comma or a constraint), as is `<div data-active={e}>`.
// What a text-reading look-ahead did instead — find a parameter list and a later `=>` — took JSX text for parameters:
//   const check = isVisible(<div data-active={enabled}>(a): Title</div>) ? (() => /navigateTo({…})/.test(text)) : (() => false);
const opens = (code, at = code.indexOf('<')) => opensTypeParameters(code, at);
const GENERIC = { generic: true, ambiguity: null };
const ELEMENT = { generic: false, ambiguity: null };
test('a "<" that starts an expression opens type parameters only by the TSX rule: after an optional const, the token after the first identifier', () => {
  for (const code of [
    '<T,>(x: T) => x', '<T = string,>(x: T) => x', '<T = string>(x: T) => x', '<T=string>(x: T) => x', '<T extends unknown>(x: T) => x',
    '<const T,>(x: T) => x', '<const T extends string>(x: T) => x', '<const T = string>(x: T) => x', '<T extends Record<string, unknown>>(x: T) => x',
    '<K extends keyof V = keyof V>(k: K) => k', '<T extends { a: number }>(x: T): T => x', '<T extends (a: A) => B>(f: T) => f',
    // Trivia between the tokens does not matter: TypeScript's scanner skips it.
    '<T /* a */ , /* b */ >(x: T) => x', '<T // a\n  ,>(x: T) => x', '<T\n  extends\n  X>(x: T) => x', '<T extends/* c */X>(x) => x', '<const /* c */ T,>(x) => x',
    // A name that is a keyword somewhere else is an identifier here, and the word is the whole name.
    '<of,>(x: of) => x', '<type,>(x) => x', '<extends1,>(x) => x', '<Extends,>(x) => x', '<T_1,>(x) => x', '<$T,>(x) => x',
  ]) assert.deepStrictEqual(opens(code), GENERIC, code);
  for (const code of [
    // `<T>` is JSX in TSX: a generic arrow with no comma and no constraint is not one there.
    '<T>text</T>', '<T>x</T>', '<T />', '<T/>', '<T extends>text</T>', '<T extends/>', '<T extends />', '<T extends=1>x</T>', '<T extends="x" />', '<T extends>(x: T) => x',
    '<div>text</div>', '<div data-active={e}>(a): Title</div>', '<div className="x" onClick={() => go()}>t</div>', '<Foo.Bar x={1}/>', '<a:b x="1"/>', '<Foo-bar x/>',
    '<T x={1}>x</T>', '<T x>x</T>', '<T {...props}/>', '<>x</>', '<>', '<const>x</const>', '<const x>x</const>', '<this x/>',
    // A reserved word is not an identifier to TypeScript, so what follows it does not matter: an element, never type parameters.
    '<this,>(x) => x', '<class = 1>(x) => x', '<new extends X>(x) => x', '<typeof,>(x) => x',
    // A name that merely STARTS with a keyword is not the keyword.
    '<T extendsX>x</T>', '<T extendsX,>(x) => x', '<T extends1,>x</T>',
  ]) assert.deepStrictEqual(opens(code), ELEMENT, code);
});

// A `>` in JSX text does not compile: TypeScript reports TS1382, "Unexpected token. Did you mean `{'>'}` or `&gt;`?" (the test after next checks it against the
// parser). So the `=>` after a parameter list cannot be JSX text, `<Name>(…) =>` is no element in any page that compiles, and what it is — a generic
// function type — is certain wherever it appears: an annotation `const a: <T>(x: T) => T = f`, a member `onPick: <K>(key: K) => void`, a parameter type,
// the right side of an alias with type parameters. The parameter list is found by its parentheses, strings and comments skipped.
test('a "<Name>" followed by a parameter list and "=>" is a generic function type, for certain: a ">" in JSX text does not compile', () => {
  for (const code of [
    '<T>(x: T) => T', '<const T>(x: T) => T', '<T>() => T', '<T> /* c */ ( x : T ) /* c */ => T', '<T>\n(x: T)\n=> T', '<T>(cb: (a: number) => void) => T',
    '<T>(x: ")") => T', "<T>(x: ')') => T", '<T>(x: `)`) => T', '<T>(x = (1), y: T) => T', '<T>(x: T = f(1)) => T', '<T>([a, b]: P) => T',
    '<T>(...rest: T[]) => T',
    // A type-parameter list in the head is decided by the rule above: a comma, a default, a constraint.
    '<T, U>(x: T) => U', '<T = string>(x: T) => T', '<T extends X>(x: T) => T', '<const T,>(x: T) => T',
  ]) assert.deepStrictEqual(opens(code), GENERIC, code);
  // Wherever it stands, the type is code, and what follows it is read as code.
  assertCertain([
    'const a: <T>(x: T) => T = f;', 'interface P { onPick: <K>(key: K) => void; }', 'function g(cb: <U>(x: U) => void) {}', 'class C { handler: <T>(x: T) => void = f; }',
    'type H<A> = <T>(x: T) => T;', 'type H<A, B = A> = <T extends A>(x: T) => B;', 'let m: { cb: <T>(x: T) => void };', 'const m: Map<string, <T>(x: T) => T> = new Map();',
    'const a = <T>(x: T) => x;', 'type\nFn = <T>(x: T) => T;', 'a.type Fn = <T>(x: T) => T;',
  ]);
  // The same words as JSX text with no `=>` after the parentheses stay an element, for certain: they are not a parameter list.
  for (const code of [
    '<b>(optional)</b>', '<b>(1) of (2)</b>', '<b>(a) b</b>', '<b>(a)</b>', '<b>(a, b)</b>', '<b>({count})</b>', '<b>(<i>x</i>)</b>', '<b>(it\'s)</b>', '<b>(</b>', '<b>(a</b>',
    '<T>x</T>', '<T> (x)</T>', '<T>[x]</T>',
    // TypeScript reads one token after `const` as the name, whatever it is; a name that is not one has no shape to ask about.
    '<const 1>(x: T) => x',
    // An arrow written as an entity is text, and the page compiles: it is not the shape.
    '<T>(x: T) =&gt; x</T>',
    // The list has to start right after the `>`: text before it is JSX text, and an arrow in it does not compile.
    '<T>x (a) => y</T>', '<T>"s" (a) => y</T>',
  ]) assert.deepStrictEqual(opens(code), ELEMENT, code);
});

// The premise, checked against TypeScript's own parser: a `>` in JSX text is an error (TS1382) whatever the words around it, so the `=>` after the
// parameter list of `<Name>(…) =>` is never JSX text in a page that compiles; the types the shape is read as are valid; and the colon form is
// valid as both JSX text and a call signature, which is why it stays a guess.
test('TypeScript rejects ">" in JSX text (TS1382), so "<Name>(…) =>" is a type in every page that compiles', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const diagnosticCodes = (code) => ts.createSourceFile('snippet.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics.map((d) => d.code);
  for (const code of [
    'const a = <T>(x: T) => x</T>;', 'const a = <span>(required) => x</span>;', 'const a = <b>(a, b) => c</b>;',
    'const a = <T>(x: T) => navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})</T>;',
  ]) assert.ok(diagnosticCodes(code).includes(1382), `TS1382, an element whose text holds "=>": ${code}`);
  assertTsParses(ts, 'const a = <T>(x: T) =&gt; x</T>;', 'the arrow written as an entity is text');
  for (const code of [
    'const a: <T>(x: T) => T = f;', 'interface P { onPick: <K>(key: K) => void; }', 'function g(cb: <U>(x: U) => void) {}', 'type H<A> = <T>(x: T) => T;',
    'class C { handler: <T>(x: T) => void = f; }', 'const m: Map<string, <T>(x: T) => T> = new Map();', 'let m: { cb: <T>(x: T) => void };', 'type Fn = <T>(x: T) => T;',
  ]) assertTsParses(ts, code, `a generic function type: ${code}`);
  for (const code of ['const a = <span>(required): Name</span>;', 'interface Callable { <T>(x: T): T }', 'type Callable = { <T>(x: T): T };']) assertTsParses(ts, code, `the colon form: ${code}`);
});

// Directly after the head of a type alias, `type Name =` at a statement start, a `<` is the type parameters of a function type and nothing else: a
// type has no JSX, and `type Name` — two names side by side — cannot be an expression, so no other reading of the line remains. (TypeScript:
// parseTypeAliasDeclaration; `type` begins a declaration only when a name follows it on the same line.) That is certain whatever follows the `<`, which
// settles what the shape above cannot: a `:` after the parameter list, and a list too long to scan. Anywhere else those two are the `generic` guess.
test('a "<" directly after `type Name =` at a statement start is a function type for certain, whatever follows it', () => {
  const colon = '<T>(x: T): T;';
  assertCertain([
    `type Fn = ${colon}`, `type Fn=${colon}`, `type Fn\n  = ${colon}`, `type /* a */ Fn /* b */ = /* c */ ${colon}`, 'type Fn = <T extends { a: number }>(x: T): T;',
    'type Fn = <const T>(x: T): T;', `type Fn = <T>(${'x: number, '.repeat(300)}) => T;`,
    // The statement starts the line: the start of the file, a `;`, a block's `{` or `}`, or a line break where ASI ended the one before.
    `type Fn = ${colon}\nconst a = 1;`, `const a = 1; type Fn = ${colon}`, `function f() { type Fn = ${colon} return 1; }`, `if (ok) { go(); } type Fn = ${colon}`,
    `const a = 1\ntype Fn = ${colon}`, `const a = f()\n\n  type Fn = ${colon}`,
    // `export` and `declare` come before `type` and leave it the start of the declaration.
    `export type Fn = ${colon}`, `declare type Fn = ${colon}`, `export declare type Fn = ${colon}`, `const a = 1; export type Fn = ${colon}`, `export\ntype Fn = ${colon}`,
    // A name that merely contains a keyword is a name.
    `type typeFn = ${colon}`, `type Fn_ = ${colon}`, `type $ = ${colon}`,
  ]);
  // A call after it is a call: the type is code.
  const code = `type Fn = ${colon}\nnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"});\n`;
  assert.ok(blankNonCodePreservingTemplateExpressions(code).includes('navigateTo'));
  assert.deepStrictEqual(navReferencedKeys(code), ['detail']);
  // Not directly after a type alias head: the colon form is the guess, at the `<`.
  assertAmbiguous('generic', [
    ['type\nFn = <T>(x: T): T;', '<T>'],
    // `type` is not the word, or not a declaration's: a longer name, a property, a name before it on the line, another keyword.
    ['mytype Fn = <T>(x: T): T;', '<T>'],
    ['a.type Fn = <T>(x: T): T;', '<T>'],
    ['foo type Fn = <T>(x: T): T;', '<T>'],
    ['const Fn = <T>(x: T): T;', '<T>'],
    ['const type = <T>(x: T): T;', '<T>'],
    ['type 1Fn = <T>(x: T): T;', '<T>'],
    ['let Fn: any; Fn = <T>(x: T): T;', '<T>(x: T): T;'],
    ['export const Fn = <T>(x: T): T;', '<T>'],
    ['export default <T>(x: T): T;', '<T>'],
    // A head with type parameters ends in a `>`, which is the question this answers for a `<`: it is not read.
    ['type Fn<A> = <T>(x: T): T;', '<T>(x: T): T'],
    // An `=` that is the last character of another operator is not the head's. (`==`, `<=` and `!=` are comparisons, whose operand is an element: certain.)
    ...['>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**=', '<<=', '>>=', '&&=', '||=', '??='].map((operator) => [`type Fn ${operator} <T>(x: T): T;`, '<T>']),
    // `export` and `declare` before `type` do not make it a statement start where nothing starts one.
    ['foo export type Fn = <T>(x: T): T;', '<T>'],
    ['a.export type Fn = <T>(x: T): T;', '<T>'],
    // A property is not a keyword, and a line break would make it a statement start: `a.` LF `type …` is a member.
    ['a.\ntype Fn = <T>(x: T): T;', '<T>'],
    ['a?.\ntype Fn = <T>(x: T): T;', '<T>'],
    ['a.\nexport type Fn = <T>(x: T): T;', '<T>'],
    // The head ends in a `=`: anything else before the `<` is not it.
    ['type Fn: <T>(x: T): T;', '<T>'],
    ['type Fn(<T>(x: T): T);', '<T>'],
    // A parameter list too long to scan is a guess, except after the head.
    [`const long: <T>(${'x: number, '.repeat(300)}) => T = f;`, '<T>'],
  ]);
  // A word that is cut short is not the word: an escape, a private name's `#`, a letter beyond ASCII. The escape is an `identifier` guess of its
  // own, which comes first, so what is asked here is that the `<` is a guess too.
  for (const text of [
    'type Fn\\u0031 = <T>(x: T): T;', 'type Fnñ = <T>(x: T): T;', 'ñtype Fn = <T>(x: T): T;', '#type Fn = <T>(x: T): T;', 'ñexport type Fn = <T>(x: T): T;',
    't\\u0079pe Fn = <T>(x: T): T;',
  ]) assert.ok(ambiguities(text).some(([at, kind]) => at === text.indexOf('<T>') && kind === 'generic'), `the "<" is a guess: ${JSON.stringify(text)}`);
});

// What no rule settles: `<Name>(…)` followed by a `:` is the call signature of a type (`interface Callable { <T>(x: T): T }`) or JSX text that starts
// with a parenthesis (`<span>(required): Name</span>`) — both compile — and TypeScript tells them apart by whether a type or an expression is being
// parsed. The parameter list may also run past the window. Both are guesses (`generic`), and the element is read.
test('ambiguity generic: "<Name>(…)" followed by ":", or a parameter list too long to scan', () => {
  assert.deepStrictEqual(opens('<T>(x: T): T;'), { generic: false, ambiguity: 'generic' });
  assert.deepStrictEqual(opens('<span>(required): Name</span>'), { generic: false, ambiguity: 'generic' });
  assert.deepStrictEqual(opens('<const T>(x: T): T;'), { generic: false, ambiguity: 'generic' });
  assert.deepStrictEqual(opens(`<T>(${'x: number, '.repeat(300)}) => x`), { generic: false, ambiguity: 'generic' });
  assert.deepStrictEqual(opens(`<T>(${'x: number, '.repeat(300)}) b</T>`), { generic: false, ambiguity: 'generic' }, 'too long to scan, whatever follows');
  assertAmbiguous('generic', [
    ['const a = <span>(required): Name</span>;', '<span>'],
    ['export default function Page() { return <span>(required): Name</span>; }', '<span>'],
    ['interface Callable {\n  <T>(x: T): T;\n}', '<T>'],
    ['type Callable = { <T>(x: T): T };', '<T>'],
    [`const long: <T>(${'x: number, '.repeat(300)}) => T = f;`, '<T>'],
  ]);
  assertCertain([
    'const a = <span>(optional)</span>;', 'const a = <span>(a) b</span>;', 'type Fn = <T>(x: T) => T;', 'const f = <T,>(x: T) => x;', 'interface P { onPick: <K>(key: K) => void; }',
    'const a = <div data-active={e}>(a): Title</div>;', 'const f = <T extends { a: number }>(x: T): T => x;', 'const a = <div>text</div>;',
    'const a = <div className="x" onClick={() => go()}>t</div>;',
  ]);
});

// The words that start the tokens may be written with a Unicode escape, which TypeScript cooks before it looks for the keyword: `<\u0054,>` is `<T,>`
// and `ext\u0065nds` is `extends`. The lexer reads them the same way and reports that it did (`identifier`).
test('ambiguity identifier: a Unicode escape in the tokens that decide a "<"', () => {
  assert.deepStrictEqual(opens('<\\u0054,>(x) => x'), { generic: true, ambiguity: 'identifier' });
  assert.deepStrictEqual(opens('<T ext\\u0065nds X>(x) => x'), { generic: true, ambiguity: 'identifier' });
  assert.deepStrictEqual(opens('<c\\u006fnst T,>(x) => x'), { generic: true, ambiguity: 'identifier' });
  assert.deepStrictEqual(opens('<T\\u{31}>x</T\\u{31}>'), { generic: false, ambiguity: 'identifier' });
  assertAmbiguous('identifier', [['const f = <\\u0054,>(x) => x;', '<\\u0054']]);
});

// TypeScript asks the question above only where an assignment expression starts. The operand of a unary or binary operator is parsed as a unary
// expression, where a `<` is always an element (`parseUpdateExpression`): `cond && <T extends X>text</T>` is JSX whatever follows the name.
test('a "<" after a unary or binary operator opens an element whatever follows its name; where an assignment expression starts it may not', () => {
  const mask = (code) => blankNonCodePreservingTemplateExpressions(code);
  for (const before of ['cond &&', 'cond ||', 'cond ??', '!', 'a +', 'a -', 'a *', 'a %', 'a **', 'a |', 'a &', 'a ^', '~', '+', '-']) {
    // `extends` here is an attribute of the element, and `(a): MARK` is its text: TypeScript reads an element, a rule that stopped at the
    // tokens after the name would read type parameters.
    for (const code of [`const e = ${before} <T extends X>MARK</T>;`, `const e = ${before} <T extends X>(a): MARK</T>;`, `const e = ${before} <T extends X Y>MARK</T>;`]) {
      assert.ok(!mask(code).includes('MARK'), `an element, whose text is not code: ${code}`);
      assert.deepStrictEqual(ambiguities(code), [], code);
    }
  }
  for (const code of [
    'const f = <T extends X>(x: T) => MARK;', 'const f = (<T extends X>(x: T) => MARK);', 'foo(a, <T extends X>(x: T) => MARK);', 'const f = [<T extends X>(x: T) => MARK];',
    'const f = a ? <T extends X>(x: T) => MARK : b;', 'const f = a ? b : <T extends X>(x: T) => MARK;', 'const f = () => <T extends X>(x: T) => MARK;',
    'function g() { return <T extends X>(x: T) => MARK; }', 'x = <T extends X>(x: T) => MARK;', 'x += <T extends X>(x: T) => MARK;', 'x ||= <T extends X>(x: T) => MARK;',
  ]) {
    assert.ok(mask(code).includes('MARK'), `a generic arrow, whose body is code: ${code}`);
    assert.deepStrictEqual(ambiguities(code), [], code);
  }
});

// The page that took JSX text for parameters. The `<div …>` is an element (its name is followed by an attribute), so `(a): Title` is text, and
// the regex after the later `=>` is a regex: data, not a call.
test('JSX text that looks like parameters is text, so the regex after it stays data and the page is read with certainty', () => {
  const mask = (code) => blankNonCodePreservingTemplateExpressions(code);
  const page = [
    'const isVisible = (node: any) => !!node.props["data-active"];',
    'const check = isVisible(<div data-active={enabled}>(a): Title</div>) ? (() => /navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/.test(text)) : (() => false);',
    '',
  ].join('\n');
  assert.ok(!mask(page).includes('navigateTo'), 'the regex is data');
  assert.ok(mask(page).includes('isVisible'), 'the code around it is code');
  assert.deepStrictEqual(ambiguities(page), []);
  // A generic arrow ahead of a real call leaves the call a call.
  const arrow = 'const id = <T,>(x: T) => x;\nnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"});\n';
  assert.ok(mask(arrow).includes('navigateTo'));
  assert.deepStrictEqual(ambiguities(arrow), []);
  assert.deepStrictEqual(navReferencedKeys(arrow), ['detail']);
  // So does a generic function type, wherever it stands — the rule would call its `<T>` an element, but a `>` in JSX text does not compile.
  const type = 'type Fn = <T>(x: T) => T;\nconst a: <T>(x: T) => T = f;\ninterface P { onPick: <K>(key: K) => void; }\nnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"});\n';
  assert.ok(mask(type).includes('navigateTo'));
  assert.deepStrictEqual(ambiguities(type), []);
  assert.deepStrictEqual(navReferencedKeys(type), ['detail']);
  // JSX text that starts with a parenthesis and a colon is an element that compiles, and so is a call signature: the guess is reported, the element
  // is read right (the call after it is code), and the call is not trusted.
  const label = 'const label = <span>(required): Name</span>;\nnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"});\n';
  assert.ok(mask(label).includes('navigateTo'), 'the element is read right: what follows it is code');
  assert.deepStrictEqual(earliestAmbiguity(label), [label.indexOf('<span>'), 'generic']);
  const signature = 'interface Callable { <T>(x: T): T }\nnavigateTo({pageType:"generative",pageId:"PAGEREF_detail"});\n';
  assert.ok(!mask(signature).includes('navigateTo'), 'read as the element the rule opens, whose text runs on over the call');
  assert.deepStrictEqual(earliestAmbiguity(signature), [signature.indexOf('<T>'), 'generic']);
});

// A quote that starts no string by the end of its line — a string cannot span a raw line break — is read as an ordinary character instead.
// That is a fallback, not a reading: code that is not valid, or code after a misread.
test('ambiguity fallback: a quote with no closing quote on its line', () => {
  assertAmbiguous('fallback', [["const a = 'unterminated\nconst b = 1;", "'unterminated"], ['const a = "x" + "it\nconst b = 2;', '"it']]);
  assertCertain(['const a = "ok";', "const a = 'it\\'s';", "const a = <p>it's</p>;", "// it's\nconst a = 1;", 'const a = `it\'s`;', 'const a = "a\\\nb";']);
});

// Operators the position table does not know. After a spread `...` an expression starts, so a `/` is a regex; the table reads a division.
// And in `a+++/x/` the third `+` is a binary operator after a postfix `++`, but the table takes any doubled sign for a postfix. In `<<` the
// second `<` follows an operator, where an element may start, so before a name it is read as the start of an element — which it is not,
// and `1<<n>x</n>` swallows the rest of the page as a tag: a guess where the text after the `<` may be an element. Where it cannot be one (`1<<n;`,
// `1<<n)`, `1 <<n,`) the shift is read as the shift it is, with nothing guessed, as is a shift followed by anything else (`1 << 3`, `x <<= 2`).
test('ambiguity operator: a "/" after a spread or a run of three signs, and a "<" after a "<"', () => {
  assertAmbiguous('operator', [
    ['const m = [.../a/.exec("a")]; const n = /b/;', '/a/.exec'],
    ['const b = a+++/x/.test("x");', '/x/.test'],
    ['const b = a---/x/.test("x");', '/x/.test'],
    ['const m = 1<<n>x</n>; const q = x > y;', '<n>'],
    ['const m = 1 <<n>x</n>; const q = x > y;', '<n>'],
  ]);
  assertCertain([
    'const a = i++ / 2 / 3;', 'const a = x + +/x/.test(s);', 'const a = [...rest];', 'const a = 1.5 / 2 / 3;', 'const a = b-- / 2 / 3;', 'const a = x - -/y/.test(s);',
    'const a = 1 << 3;', 'x <<= 2;', 'x <<= (y);', 'flags & (1 << 2)', 'const a = b << c / 2 / 3;', 'const a = 1 << 3 < 4;', 'a <= b', 'a << /x/.source.length',
    // A shift by a name, where the name is followed by something no tag can have after its name: an element cannot parse, so the `<` is no tag.
    'const m = 1<<n; const q = x > y;', 'const m = 1 <<n; const q = x > y;', 'const m = (1<<k) | 2;', 'const m = a<<b, c;', 'const m = [1<<a, 1<<b];', 'const m = f(1<<a);', 'const m = 1<<a | 1<<b;',
    'const m = x<<y;\n',
  ]);
});

// A line break between an operand and a `/` or `<` decides nothing by itself: whether the statement ended at the break is the question
// ASI answers (ECMA-262 §12.10, https://tc39.es/ecma262/#sec-automatic-semicolon-insertion) wherever the next token cannot continue it, and in a
// TYPE context — a type alias, an annotated declaration with no initializer, an overload signature — a `/` or `<` cannot continue it, while in
// an expression they can. The same words are a division in one and a regex in the other, and which it is needs a parser:
//   type Value = number
//   /navigateTo({…})/.exec(text)
// (a block comment that holds a line break is a line break to the grammar). A division written on the next line is a guess only where a regex
// could close on its line, as it is everywhere else; and an operator or an opening bracket before the break leaves nothing to decide.
test('ambiguity newline: a "/" or "<" on a later line than the operand before it', () => {
  assertAmbiguous('newline', [
    ['type Value = number\n/abc/.test(x);', '/abc/'],
    ['type Value=number\n/abc/.exec(text);', '/abc/'],
    ['let n: number\n/abc/.test(x);', '/abc/'],
    ['declare function f(x: number)\n/abc/.test(x);', '/abc/'],
    ['type Names = string[]\n/abc/.test(x);', '/abc/'],
    ['type K = "a"\n/abc/.test(x);', '/abc/'],
    ['const a = b\n/abc/.test(x);', '/abc/'],
    ['const a = b[0]\n/abc/.test(x);', '/abc/'],
    ['const a = foo(x)\n/abc/.test(x);', '/abc/'],
    ['const a = "x"\n/abc/.test(x);', '/abc/'],
    ['const a = `x`\n/abc/.test(x);', '/abc/'],
    ['const a = 1\n/abc/.test(x);', '/abc/'],
    ['const a = b\n\n\n/abc/.test(x);', '/abc/'],
    ['const a = b // note\n/abc/.test(x);', '/abc/'],
    ['const a = b /* one\ntwo */ /abc/.test(x);', '/abc/'],
    ['const a = b\r\n/abc/.test(x);', '/abc/'],
    ['const a = b\r/abc/.test(x);', '/abc/'],
    ['const a = b\u2028/abc/.test(x);', '/abc/'],
    ['const a = b\u2029/abc/.test(x);', '/abc/'],
    ['const a = b\n/ 2 / 3;', '/ 2 / 3'],
    ['const a = b\n<div/>;', '<div/>'],
    ['const a = b\n<T extends X>text</T>;', '<T extends X>'],
  ]);
  assertCertain([
    // The break is before an operand-free position: an operator, an opening bracket, a comma or a statement end leaves an expression.
    'x = 1;\n/abc/.test(x);', 'foo(x);\n/abc/.test(y);', 'const a = b +\n/abc/.test(x);', 'const a = [\n/abc/,\n/def/\n];', 'f(\n/abc/\n)',
    'const a = b ?\n/x/ : /y/;', 'const a = b ||\n<div/>;', 'return\n/abc/.test(x);', 'const f = () =>\n/abc/.test(x);', 'const f = (a) =>\n<div/>;',
    // No break: an operand and its division, a regex that cannot close, a `<` that opens no element.
    'const a = b / 2 / 3;', 'const a = b\n/ 2;', 'const a = b\n< 3;', 'const a = b\n<= 3;', 'const a = b <\n3;',
    'const a = (b\n) / 2 / 3;', 'const a = b /* inline */ / 2 / 3;',
    // A head that cannot be an element is type parameters on a later line too: the statement ended, and an arrow begins the next.
    'const a = b\n<T,>(x: T) => x;', 'const a = b\n<T extends X>(x: T) => x;',
  ]);
});

// ASI and the restricted productions of ECMA-262 §12.10.1 decide what a `!`, a `++`, a `--` and a keyword before a line break are, and
// TypeScript's parser reads them the same way (parser.ts, TypeScript 5.8):
//   postfix `!` (the non-null assertion)  parseMemberExpressionRest:  `token() === ExclamationToken && !scanner.hasPrecedingLineBreak()`
//   postfix `++` and `--`                 parseUpdateExpression:      `(token() === PlusPlusToken || …) && !scanner.hasPrecedingLineBreak()`
//   break, continue, return               canParseSemicolon():         `… || scanner.hasPrecedingLineBreak()` — the label or expression is dropped
//   throw                                 parseThrowStatement:        a line break after `throw` ends it with no expression (an error in JavaScript)
//   yield                                 parseYieldExpression:       `!scanner.hasPrecedingLineBreak() && …`
// So after a line break a `!` is a PREFIX operator, a `++` is a prefix increment, and a `/` after either is a regex; on the same line as an
// operand they are postfix and the `/` divides. Each regex below holds a call that is code if the `/` is read as a division.
const HIDDEN = 'navigateTo({pageType:"generative",pageId:"PAGEREF_x"})';
const maskOf = (code) => blankNonCodePreservingTemplateExpressions(code);
test('a "!" or "++" or "--" after a line break is a prefix operator, so a "/" after it is a regex; on the line of its operand it is postfix', () => {
  for (const code of [
    `x\n!/${HIDDEN}/.test(y)`, `x\n! /${HIDDEN}/.test(y)`, `x\n\n!/${HIDDEN}/.test(y)`, `x /* c\n */ !/${HIDDEN}/.test(y)`, `x\r!/${HIDDEN}/.test(y)`,
    `x\u2028!/${HIDDEN}/.test(y)`, `foo(a)\n!/${HIDDEN}/.test(y)`, `type Value = number\n!/${HIDDEN}/.test(y)`,
    `x\n++/${HIDDEN}/.lastIndex`, `x\n--/${HIDDEN}/.lastIndex`, `x\n++\n/${HIDDEN}/.lastIndex`, `x /* c\n */ ++/${HIDDEN}/.lastIndex`,
    `let n = 0; ++/${HIDDEN}/.lastIndex`, `let n = 0;\n++\n/${HIDDEN}/.lastIndex;`, `n = ++/${HIDDEN}/.lastIndex`, `n = [--/${HIDDEN}/.lastIndex]`,
    `if (ok) ++/${HIDDEN}/.lastIndex;`,
  ]) {
    assert.ok(!maskOf(code).includes('navigateTo'), `read as a regex, whose body is not code: ${JSON.stringify(code)}`);
    assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
  }
  // On the line of the operand each is postfix, and the `/` after it is a division whose operands are code.
  for (const code of [`x! /${HIDDEN}/ 2`, `foo(a)! /${HIDDEN}/ 2`, `i++ /${HIDDEN}/ 2`, `i-- /${HIDDEN}/ 2`, `x /* c */ ++ /${HIDDEN}/ 2`, `a[0]++ /${HIDDEN}/ 2`]) {
    assert.ok(maskOf(code).includes('navigateTo'), `read as a division, whose operands are code: ${JSON.stringify(code)}`);
    assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
  }
  // The break comes after the postfix operator: the `/` after it is the question a line break leaves open.
  assertAmbiguous('newline', [['x!\n/abc/.test(y);', '/abc/'], ['i++\n/abc/.test(y);', '/abc/'], ['i--\n/abc/.test(y);', '/abc/']]);
  // A run of three signs is still a guess about which are operators.
  assertAmbiguous('operator', [['const b = a+++/x/.test("x");', '/x/.test']]);
});

test('a "break" or "continue" before a line break ends its statement, so a "/" after it is a regex; "throw" and "yield" there are guesses', () => {
  for (const word of ['break', 'continue', 'return']) {
    for (const gap of ['\n', '\r\n', '\u2028', ' /* c\n */ ']) {
      const code = `${word}${gap}/${HIDDEN}/.test(y)`;
      assert.ok(!maskOf(code).includes('navigateTo'), `${word}: read as a regex: ${JSON.stringify(code)}`);
      assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
    }
  }
  // A property of that name is not the keyword: nothing ends, and the `/` divides.
  for (const word of ['break', 'continue', 'throw']) {
    const code = `a.${word}\n/${HIDDEN}/ 2`;
    assert.ok(maskOf(code).includes('navigateTo'), `${word}: a property is an operand`);
  }
  // `throw /x/` has an operand, a regex, and is certain; after a line break it is an error in JavaScript and ends in TypeScript.
  assert.ok(!maskOf(`throw /${HIDDEN}/.test(y)`).includes('navigateTo'));
  assert.deepStrictEqual(ambiguities(`throw /${HIDDEN}/.test(y)`), []);
  assertAmbiguous('newline', [[`throw\n/abc/.test(y);`, '/abc/'], ['throw /* c\n */ /abc/.test(y);', '/abc/']]);
  assert.ok(!maskOf(`throw\n/${HIDDEN}/.test(y)`).includes('navigateTo'), 'read as a regex, as TypeScript reads it');
  // `yield` is a keyword only inside a generator: a guess, whatever follows the line break.
  assertAmbiguous('keyword', [['function* g() { yield\n/abc/.test(y); }', '/abc/'], ['function* g() { yield /abc/.test(y); }', '/abc/']]);
});

// A word that starts an expression before a `/`, so the `/` is a regex. The list was missing `throw`, `default` (as in `export default /x/`)
// and `extends` (`class A extends /x/ {}`), each a reserved word, so each is certain.
test('throw, default and extends are followed by an expression, so a "/" after one is a regex, unless the word is a property', () => {
  for (const code of [`throw /${HIDDEN}/.test(y);`, `export default /${HIDDEN}/;`, `class A extends /${HIDDEN}/ {}`]) {
    assert.ok(!maskOf(code).includes('navigateTo'), `read as a regex: ${code}`);
    assert.deepStrictEqual(ambiguities(code), [], code);
  }
  for (const code of [`a.throw /${HIDDEN}/ 2`, `a.default /${HIDDEN}/ 2`, `a?.extends /${HIDDEN}/ 2`, `a.\n  default /${HIDDEN}/ 2`]) {
    assert.ok(maskOf(code).includes('navigateTo'), `a property is an operand: ${code}`);
  }
});

// What a position table can say about the character before a `/` that is not a word, a bracket or an operator it knows. After a quote, a
// back-tick or an identifier that ends in a letter beyond ASCII the operand has ended: certain. After a character that begins nothing in code (`#`, `@`, a control character) there is
// no grammar to ask. After a `/` it depends on whether that `/` was a division operator (a regex follows) or the end of a regex (a division follows), which the output does not show:
// but the lexer read it, and knows (the next test).
test('a "/" after a character that begins nothing in code is a guess; after a quote or a name beyond ASCII it is not', () => {
  assertAmbiguous('fallback', [
    ['const a = # / 2 / 3;', '/ 2 / 3'],
    ['const a = @ / 2 / 3;', '/ 2 / 3'],
    ['const a = \u0001 / 2 / 3;', '/ 2 / 3'],
  ]);
  assertCertain([
    'const Ñ = 1; const q = Ñ / 2 / 3;', 'const a = "x" / 2 / 3;', "const a = 'x' / 2 / 3;", 'const a = `x` / 2 / 3;', 'const a = /x/ / 2;',
    'const a = 1. / 2 / 3;', 'const a = b.c / 2 / 3;',
  ]);
});

// In the lexer's output a regex keeps the `/` that opens it and the `/` that closes it, an element keeps its `>`, and a division is a bare `/`:
//   const n = /x/ / 2;       const e = <b/> / 2;       const r = a / /y/;
// look alike to a scan of the output, which could only guess at the `/` or `<` after them (`operator`, `angle`). The lexer read each of them, so it knows where a regex ended, where an
// element ended and which `/` it took for the division operator: a `/` after the end of a regex or of a whole element divides, a `/` after a division begins a regex, and a `<` after a regex
// or an element is a comparison, never an element — each certain, whatever the line breaks (a regex or an element is no type, and a `/` or `<` continues an expression across a line
// break: ASI inserts nothing before it). The regex after each decision holds the text of a call: it must be data, and the one real call must be code.
const READ_CALL = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})';
test('a "/" or "<" after a regex or an element the lexer read, or after a "/" it read as a division, is read by what it read: nothing is guessed', (t) => {
  const cases = [
    // A division after the end of a regex, then a regex that holds a call, and a real call.
    [`const n = /x/ / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex and a division'],
    [`const n = /x/ /2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex and a division, no space'],
    [`const n = /x/ / ${READ_CALL} / 2;`, 'a regex divided by a call'],
    [`const n = /x/\n/ 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex and a division on the next line'],
    [`const n = /x/ /* c */ / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex and a division after a comment'],
    [`const n = /x/g / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex with flags'],
    // The flags are part of the literal, whatever they spell: TypeScript's scanner takes every identifier part after the closing slash, and a word that they spell is no keyword (an unknown flag is the checker's error).
    [`const n = /x/in / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flags spell `in`'],
    [`const n = /x/is /2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flags spell `is`'],
    [`const n = /x/instanceof / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flags spell `instanceof`'],
    [`const n = /x/gimsuyd / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex with every flag'],
    [`const n = /x/g\n/ 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex with flags and a division on the next line'],
    [`const n = /x/is\n/ 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flags spell a contextual word and a division on the next line'],
    [`const n = /x/g < 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex with flags, compared'],
    [`const n = /x/is <b; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flags spell a contextual word, compared, with a name next to the `<`'],
    [`const n = /x/$ / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flag is a dollar sign'],
    [`const n = /x/é / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flag is a letter beyond ASCII'],
    [`const n = /x/𝒜 / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flag is a letter beyond the basic plane'],
    [`const n = /x/\u200c / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flag is a zero-width non-joiner'],
    [`const n = /x/g\u200d / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex whose flags end in a zero-width joiner'],
    [`const n = /[/]/ / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex with a class'],
    // A division after the end of a whole element: self-closing, with a closing tag, a fragment, nested.
    [`const n = <b/> / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a self-closing element and a division'],
    [`const n = <b/> /2; const re = /${READ_CALL}/; ${READ_CALL};`, 'an element and a division, no space'],
    [`const n = <b>t</b> / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'an element with a closing tag and a division'],
    [`const n = <>t</> / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a fragment and a division'],
    [`const n = <a><b/></a> / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a nested element and a division'],
    [`const n = <b/>\n/ 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'an element and a division on the next line'],
    [`const n = <b/> / ${READ_CALL} / 2;`, 'an element divided by a call'],
    [`const n = <b>{1}</b> / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'an element with an expression and a division'],
    [`const f = () => <b/> / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'an element in an arrow body'],
    [`const n = \`\${<b/> / 2}\`; const re = /${READ_CALL}/; ${READ_CALL};`, 'an element in a template substitution'],
    [`const n = <p>{<b/> / 2}</p>; const re = /${READ_CALL}/; ${READ_CALL};`, 'an element in an expression container'],
    // A regex after a division, and an element after one.
    [`const n = a / /${READ_CALL}/.source; ${READ_CALL};`, 'a division by a regex that holds a call'],
    [`const n = a / /${READ_CALL}/ / 2; ${READ_CALL};`, 'a division by a regex, divided'],
    [`const n = /x/ / /${READ_CALL}/; ${READ_CALL};`, 'a regex, divided by a regex'],
    [`const n = a /\n/${READ_CALL}/.source; ${READ_CALL};`, 'a division by a regex on the next line'],
    [`const n = a / <b>text</b>; const re = /${READ_CALL}/; ${READ_CALL};`, 'a division by an element'],
    [`const n = a / <T extends X>text</T>; const re = /${READ_CALL}/; ${READ_CALL};`, 'a division by an element with a constraint'],
    [`const k = a as A<B> / /${READ_CALL}/.source; ${READ_CALL};`, 'a cast divided by a regex that holds a call'],
    [`const k = a as A<B> /2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a cast divided, no space'],
    [`const k = a satisfies A<B> / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a satisfies cast divided'],
    [`const n = a /\n<b>text</b>; const re = /${READ_CALL}/; ${READ_CALL};`, 'a division by an element on the next line'],
    // A `<` after the end of a regex or of an element is a comparison.
    [`const n = /x/ < 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex compared'],
    [`const n = /x/\n< 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex compared on the next line'],
    [`const n = /x/ <b; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex compared, with a name next to the `<`'],
    [`const n = <b/> < y; const re = /${READ_CALL}/; ${READ_CALL};`, 'an element compared'],
    // A postfix `!` after the end of an operand is the same operand: what stands before it decides. (An element takes none: `<b/>!` is an error.)
    [`const n = /x/! / 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex asserted non-null and divided'],
    [`const n = /x/!\n/ 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex asserted non-null and divided on the next line'],
    [`const n = /x/! < 2; const re = /${READ_CALL}/; ${READ_CALL};`, 'a regex asserted non-null and compared'],
  ];
  for (const [code, what] of cases) {
    assert.deepStrictEqual(ambiguities(code), [], what);
    const mask = maskOf(code);
    // A regex or an element in the line is not code, and a call that is not in a regex is: the regex that holds the text of a call is data, the real call is the one call that remains.
    const calls = mask.split('navigateTo(').length - 1;
    assert.strictEqual(calls, code.includes(`/${READ_CALL}/`) ? 1 : code.split(`${READ_CALL}`).length - 1, `${what}: the calls the lexer reads as code`);
  }
  // The elements and regexes that lie before the decision are read as always: a `/` after something else is as it was.
  assertAmbiguous('angle', [['const k = f<A> / 2; const re = /x/;', '/ 2; const re']]);
  assertAmbiguous('newline', [['let v: number\n/x/.test(z);', '/x/.test'], ['const a = b\n/ 2 / 3;', '/ 2 / 3']]);
  // A `/` that closes no regex on its line divides wherever it stands — after a `}` too, where a regex could have started — and the `/` after it begins a regex: nothing is guessed.
  const afterObject = `const n = {} /\n/${READ_CALL}/.source;`;
  assert.deepStrictEqual(ambiguities(afterObject), []);
  assert.ok(!maskOf(afterObject).includes('navigateTo('), 'the regex that holds a call is data');
  // TypeScript reads each of them as the lexer does: it parses (but for a comparison with an element, which it rejects) and holds exactly one call, the real one.
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  const objectSource = ts.createSourceFile('page.tsx', afterObject, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepStrictEqual(objectSource.parseDiagnostics.map((d) => d.code), [], 'TypeScript parses a division by a regex on the next line');
  for (const [code, what] of cases) {
    const source = ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (what === 'an element compared') { assert.ok(source.parseDiagnostics.length > 0, `${what}: TypeScript rejects it`); continue; }
    assert.deepStrictEqual(source.parseDiagnostics.map((d) => d.code), [], `TypeScript parses: ${what}`);
    let real = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') real += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.strictEqual(real, 1, `${what}: the one call TypeScript reads`);
  }
});

// The truncation gate asks the same question at the end of the module: a `!`, `++` or `--` that is a PREFIX operator, after a line break or
// where an expression starts, needs its operand, and a postfix one does not.
test('endsMidStatement reads a "!", "++" or "--" after a line break as a prefix operator that needs its operand', () => {
  for (const [what, code] of [
    ['a prefix bang after a line break', 'const count = 1;\nexport default count\n!'],
    ['a prefix bang after a block comment with a line break', 'const count = 1;\nexport default count /* c\n */ !'],
    ['a prefix increment after a line break', 'let count = 1;\nexport default count\n++'],
    ['a prefix decrement after a line break', 'let count = 1;\nexport default count\n--'],
    ['a prefix increment where an expression starts', 'let count = 1;\nexport default () => ++'],
    ['a prefix decrement where an expression starts', 'let count = 1;\nexport default () => --'],
  ]) {
    assert.equal(endsMidStatement(code), true, what);
  }
  for (const [what, code] of [
    ['a postfix non-null assertion on the line of its operand', 'const count = 1;\nexport default count!'],
    ['a postfix increment on the line of its operand', 'let count = 1;\nexport default count++'],
    ['a postfix decrement on the line of its operand', 'let count = 1;\nexport default count--'],
    ['a postfix increment after a call', 'let count = 1;\nexport default next()++'],
  ]) {
    assert.equal(endsMidStatement(code), false, what);
  }
});

// The kinds are named once, by the lexer, so a caller that words them (the report on a navigation token) cannot miss one: each kind has an
// example that reports it first, and `ambiguities` refuses a kind that is not on the list.
test('AMBIGUITY_KINDS names every kind the lexer reports, each with an example that reports it first', () => {
  const examples = {
    brace: 'const count = {valueOf(){return 12;}}/2; const half = total / 2;',
    paren: `if (true /*${'x'.repeat(2100)}*/) /abc/.test(text);`,
    keyword: 'const of = 12; const count = of/2; const re = /x/;',
    angle: 'const half = total as Types . Alias<number> / 2; const re = /x/;',
    identifier: 'var Al\\u0069as = 12;',
    operator: 'const m = [.../a/.exec("a")]; const n = /b/;',
    newline: 'type Value = number\n/abc/.test(text);',
    generic: 'const a = <span>(a): Title</span>;',
    'jsx-type-arguments': 'const a = <Foo<"a"> b={1} />;',
    'jsx-attribute': "const a = <C x= '\\'/>;const b = 1;//' />;",
    'jsx-open': 'const a = < div>x</div>;',
    fallback: "const a = 'unterminated\nconst b = 1;",
  };
  assert.deepStrictEqual(Object.keys(examples).sort(), [...AMBIGUITY_KINDS].sort());
  for (const [kind, code] of Object.entries(examples)) assert.strictEqual(earliestAmbiguity(code)[1], kind, kind);
  assert.ok(Object.isFrozen(AMBIGUITY_KINDS), 'the list is not edited by a caller');
  assert.strictEqual(new Set(AMBIGUITY_KINDS).size, AMBIGUITY_KINDS.length, 'no kind twice');
});

// The corpus the pages are modelled on: no sample and no fixture page may hit a guess, because a guess halts a page that holds a navigation
// token after it. A hit would be a false reject of a page a real user was told to write.
test('no committed page hits an ambiguity: the realistic corpus is read with certainty', () => {
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  const files = execFileSync('git', ['ls-files', '-z', '*.tsx'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length >= 60, `expected a real corpus, found ${files.length}`);
  const hits = [];
  for (const file of files) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    const first = earliestAmbiguity(code);
    if (first) hits.push(`${file}: ${first[1]} at ${first[0]}`);
  }
  assert.deepStrictEqual(hits, [], 'these committed pages hit a lexer guess');
});

// ─── What a `<` opens where the arrow rule alone does not settle it ───────────────────────────────────────────────────

const REGEX_STATEMENT = ' const re = /navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/;';

// `<Name>(…) =>` is a generic function type — a type, and code — in every page that compiles, unless the ELEMENT reading of its text can parse: in a .tsx file
// TypeScript has no other reading of a `<` in an expression, and in a type there is no JSX. So the question for each is whether the element reading provably
// fails, and it is answered by reading the element's text, from the `>` of `<Name>` to the `=>`, the way TypeScript's parser reads the children of an element
// (source-literals.js, elementFailsAt). The element reading fails for these reasons, the diagnostic TypeScript 5.8 reports for each being checked in the test
// after next:
//   TS1382  a `>` in the text of an element's children, at any depth: the arrow's own, a nested arrow's, the `>` that ends the tag of `Array<T>`
//   TS1381  a `}` in the text
//   TS1005  an expression container that starts with a name and a `:`, as `{ label: T }` does: no expression has a name followed by a colon; or with two names side by side
//           (`{ readonly current: T }`), a bracket and a `:` (`{ [k: string]: T }`, `{ [K in keyof T]: T }`), a name, a `(` and a name and a `:` (`{ m(x: T): T }`), a quoted
//           name and a `:` (`{ 'a': T }`) or a quoted name and a call (`{ 'a'(x: T): T }`: a string is called as a name is) — the colon, or the second name, is the first
//           token TypeScript cannot take
//   TS1109  one that starts with a name, a `?` and a `:`, as `{ a?: T }` does, or has the same `?:` after a bracket, a quoted name or a call's `(`
//   TS1003  a `<` followed by a character that cannot start a tag name (`Array<{ a: T }>`, `Array<(y: T) => void>`), or a tag name followed by a token that is
//           no attribute (`Record<string, T>` has a `,`, `Array<T[]>` a `[`, `Array<T | U>` a `|`)
// A container that holds nothing but names, numbers, `.`, `,` and white space is skipped, and the text goes on: `({ a }: P) =>` fails at the arrow's own `>` (TS1382).
const ELEMENT_READING_FAILS = [
  ['a `>` in the text: the arrow itself', 1382, [
    '<T>(x: T) => T', '<T>() => T', '<T>(x: ")") => T', "<T>(x: ')') => T", '<T>(x: `)`) => T', '<T>(cb: (a: number) => void) => T', '<T>(x: "a\\"b") => T',
    '<T>(x = (1), y: T) => T', '<T> /* c */ (x: T) /* c */ => T', '<T>\n(x: T)\n=> T', '<T>(x: T /* > */) => T',
  ]],
  // A container that is skipped — its content is names, numbers, `.` and `,` — leaves the arrow's `>` in the text.
  ['a `>` in the text: after a container that is skipped', 1382, [
    '<T>({ a }: P) => T', '<T>({ a, b }: P) => T', '<T>(x: {}) => T', '<T>({}: P) => T', '<T>({ ...rest }: P) => T', '<T>({\n  a,\n  b\n}: P) => T',
    '<T>(x: { }) => T',
  ]],
  ['a `>` in the text: the end of a nested tag', 1382, [
    '<T>(x: Array<T>) => T', '<T>(item: Array<T>) => React.ReactNode', '<T>(x: Promise<T>) => void', '<T>(x: Array<keyof T>) => T', '<T>(x: Array<React.ReactNode>) => T',
    '<T>(x: Foo<Bar.Baz>) => T', '<T>(x: A<B>, y: C<D>) => T',
  ]],
  // The type arguments of a nested tag are read when they are only names, dots and commas, which TypeScript parses as types; the `>` after them ends the tag.
  ['a `>` in the text: after a nested tag with type arguments', 1382, [
    '<T>(x: Array<Array<T>>) => T', '<T>(x: Promise<Array<T>>) => void', '<T>(x: Array<Record<string, T>>) => T', '<T>(x: Array<Foo.Bar<T>>) => T', '<T>(x: A<B<C<D>>>) => T',
    '<T>(x: Array< Array<T> >) => T',
  ]],
  ['a `}` in the text', 1381, ['<T>(x: "}") => T', '<T>(x: Array<T>, y: "}") => T']],
  ['an expression container that starts with a name and a colon', 1005, [
    '<T>(value: { label: T }) => string', '<T>(v: {a: T; b: U}) => T', '<T>(o: {\n  a: number\n}) => T', '<T>(o: { a: number, b: string }) => T', '<T>(o: { $a: T }) => T',
    '<T>(o: { type: T }) => T',
  ]],
  ['an expression container that starts with a name, a `?` and a colon', 1109, ['<T>(v: { a?: T }) => T', '<T>(v: {a ?: T}) => T', '<T>(v: { a?\n: T }) => T']],
  // Two names side by side are no expression, unless the first can start one (`typeof a`, `new A`, `async a => a`, `function f() {}`) or the second continues it (`a in b`, `a as T`).
  ['an expression container that starts with two names', 1005, [
    '<T>(value: { readonly current: T }) => T', '<T>(v: { readonly a?: T }) => T', '<T>(o: { get a(): T }) => T', '<T>(o: { set a(v: T) }) => T', '<T>(o: { readonly\n  a: T }) => T',
  ]],
  // A bracket and a colon: after a name inside it (`[k: string]`) or after the bracket (`[K in keyof T]:`, `[a]:`).
  ['an expression container that starts with a bracket', 1005, [
    '<T>(m: { [k: string]: T }) => T', '<T>(m: { [k: number]: T }) => T', '<T>(m: { readonly [k: string]: T }) => T', '<T>(m: { [K in keyof T]: T[K] }) => T', '<T>(m: { [a]: T }) => T',
    '<T>(m: { [Symbol.iterator]: T }) => T', '<T>(m: { [k : string]: T }) => T', '<T>(m: { readonly [K in keyof T]: T[K] }) => T', '<T>(m: { readonly [K in keyof T]?: T[K] }) => T',
  ]],
  ['an expression container that starts with a bracket, `?` and a colon', 1109, ['<T>(m: { [K in keyof T]?: T[K] }) => T', '<T>(m: { [a]?: T }) => T']],
  // A name, `(`, and a typed argument, or none: a call whose argument or whose result is followed by a colon, which no expression has. (`async (x: T) => x`, `function (x: T) {}`
  // and `yield (x: T) => x` are not calls: an arrow and a function.)
  ['an expression container that starts with a call and a colon', 1005, [
    '<T>(o: { m(x: T): T }) => T', '<T>(o: { m(): T }) => T', '<T>(o: { m(x): T }) => T', '<T>(o: { m(x: T, y: U): T }) => T', '<T>(o: { new (x: T): T }) => T', '<T>(o: { m (x: T) : T }) => T',
    '<T>(o: { readonly(x: T): T }) => T', '<T>(o: { m(x: T): { a: T } }) => T',
  ]],
  ['an expression container that starts with a call and `?:`', 1109, ['<T>(o: { m(x?: T): T }) => T', '<T>(o: { m(x ?: T): T }) => T', '<T>(o: { new (): T }) => T']],
  ['an expression container that starts with a quoted name and a colon', 1005, [
    "<T>(o: { 'a': T }) => T", '<T>(o: { "a": T }) => T', '<T>(o: { "a" : T }) => T', "<T>(o: { 'a\\'b': T }) => T", '<T>(o: { "a}b": T }) => T', "<T>(o: { 'a': { b: T } }) => T",
  ]],
  ['an expression container that starts with a quoted name, `?` and a colon', 1109, ["<T>(o: { 'a'?: T }) => T", '<T>(o: { "a" ?: T }) => T']],
  // A quoted name is a string, and a string followed by a `(` is a call of it: a method signature with a quoted name fails as one with a name does. The string is read with its escapes
  // (`'a\'b'`, `"a}b"`, `'a(b'`), which a JSX string has none of: the container's end is the `}` that follows it, not one inside it.
  ['an expression container that starts with a quoted name and a call', 1005, [
    "<T>(o: { 'a'(y: T): T }) => T", '<T>(o: { "a"(y: T): T }) => T', "<T>(o: { 'a'(): T }) => T", '<T>(o: { "a"(): T }) => T', "<T>(o: { 'a'(x, y): T }) => T", "<T>(o: { 'a' (y: T) : T }) => T",
    "<T>(o: { 'a'(y: T) }) => T", "<T>(o: { 'a'(y): T }) => T",
    "<T>(o: { 'a\\'b'(y: T): T }) => T", '<T>(o: { "a\\"b"(y: T): T }) => T', "<T>(o: { 'a}b'(y: T): T }) => T", "<T>(o: { 'a(b'(y: T): T }) => T", "<T>(o: { 'a'(y: T): T; 'b'(): T }) => T",
    '<T>(o: { "a\\\\"(y: T): T }) => T',
  ]],
  ['an expression container that starts with a quoted name, a call and `?:`', 1109, ["<T>(o: { 'a'(x?: T): T }) => T", '<T>(o: { "a"(x ?: T): T }) => T']],
  // A number is an expression a colon cannot follow, in every form the scanner reads as one literal.
  ['an expression container that starts with a number and a colon', 1005, ['<T>(o: { 1: T }) => T', '<T>(o: { 1.5: T }) => T', '<T>(o: { 0x1: T }) => T', '<T>(o: { 1e3 : T }) => T', '<T>(o: { .5: T }) => T', '<T>(o: { 1_0: T }) => T']],
  ['an expression container that starts with a number, `?` and a colon', 1109, ['<T>(o: { 1?: T }) => T', '<T>(o: { 1 ?: T }) => T']],
  // A comment is trivia to TypeScript's scanner wherever white space is, so the reading of a container goes past it: the same shapes, with comments before and between their tokens.
  ['an expression container that has a comment before or between the tokens of a name and a colon', 1005, [
    '<T>(o: { /* c */ a: T }) => T', '<T>(o: { a /* c */ : T }) => T', '<T>(o: { a/* c */: T }) => T', '<T>(o: { // c\n a: T }) => T', '<T>(o: { /* } */ a: T }) => T', '<T>(o: { /* c */ readonly a: T }) => T',
    '<T>(o: { readonly /* c */ a: T }) => T', '<T>(m: { [/* c */ k: string]: T }) => T', '<T>(m: { [k /* c */ : string]: T }) => T', '<T>(m: { [a /* c */ ]: T }) => T',
    '<T>(o: { m(/* c */ x: T): T }) => T', '<T>(o: { m(x /* c */): T }) => T', '<T>(o: { 1 /* c */ : T }) => T', '<T>(o: { /* c */ "a": T }) => T',
  ]],
  ['an expression container that has a comment between a name and `?:`', 1109, ['<T>(o: { a /* c */ ?: T }) => T', '<T>(o: { a? /* c */ : T }) => T']],
  // `/` and `>` are two tokens of a self-closing tag, with trivia between them: the tag ends at the `>`, and what follows is the text of the element.
  ['a `>` in the text: after a self-closing tag with trivia between its `/` and its `>`', 1382, [
    '<T>(x: "<b / >") => T', '<T>(x: "<b /\t>") => T', '<T>(x: "<b /\u0085>") => T', '<T>(x: "<b /\u2028>") => T', '<T>(x: "<b / /* c */ >") => T', "<T>(x: '<b x=\"1\" / >') => T",
    '<T>(x: "<A.B / >") => T',
  ]],
  ['a `<` and then a character that cannot start a tag name', 1003, [
    '<T>(x: Array<{ a: T }>) => T', '<T>(x: Array<(y: T) => void>) => T', '<T>(x: Array<[T]>) => T', '<T>(x: Array<"a" | "b">) => T', "<T>(x: Array<'a'>) => T",
    '<T>(x: Array<`a`>) => T', '<T>(x: Array< { a: T }>) => T',
  ]],
  ['a tag name and then a token that is no attribute', 1003, [
    '<T>(m: Record<string, T>) => T[]', '<T>(x: Array<T[]>) => T', '<T>(x: Array<T | U>) => T', '<T>(x: Array<T & U>) => T', '<T>(x: Map<string, Array<T>>) => T',
    '<T>(x: Array<T extends U ? 1 : 2>) => T',
  ]],
];

// What stays a guess: the element reading may compile (the first), or cannot be shown to fail from what a lexical reading of the text knows. It is read as the type
// it almost always is — a page that holds one is complete to the structure gate — and the guess is reported (`generic`), so a call after it is refused, naming the kind.
const ELEMENT_READING_UNSURE = [
  // The arrow is inside an attribute string, and a JSX attribute string has no escapes: the `)` and the `=>` after it are text in the second attribute.
  // TypeScript parses this as one element with no diagnostic.
  '<Wrapper>(<Child x="\\" y=") =>" />)</Wrapper>',
  '<W>(<b>x</b>) => 1', '<W>(<>x</>) => 1',
  // A container with a character in it that could open a nested construct holding a `}` — an object, a string, a template, a regex, a comment, an escape, an element — and none of the shapes
  // read, is not skipped: it may end elsewhere than at its first `}`.
  '<T>(x: { <U>(y: U): U }) => T', "<T>(x: { 'a'?(y: T): T }) => T", "<T>(x: { 'a'<U>(y: U): T }) => T", '<T>(x: { (y: { a: T }): T }) => T', '<T>(x: { function (y: T) {} }) => T', '<T>(x: { a, `b` }) => T',
  '<T>(x: A<a-b>) => T', '<T>(x: A<a:b>) => T', '<T>(x: A<b /* c */>) => T', '<T>(x: A<b {...c}>) => T', '<T>(x: A<b<{ a: T }>>) => T', '<T>(x: A<b c={d}>) => T',
  '<T>(x: A<b c=<d/>>) => T',
  // The text between the `>` of `<Name>` and the parenthesis is the element's text too: a comment there is text, and a `</` in it is a closing tag.
  '<T> /* </ */ (x: T) => T',
];

const ELEMENT_READING_GUESS = { generic: false, ambiguity: 'generic' };
const TYPE_READING_GUESS = { generic: true, ambiguity: 'generic' };

test('"<Name>(…) =>" is a function type for certain wherever its element reading cannot parse, and a read type with a guess where that cannot be shown', () => {
  for (const [reason, , bodies] of ELEMENT_READING_FAILS) for (const body of bodies) assert.deepStrictEqual(opens(body), GENERIC, `${reason}: ${body}`);
  for (const body of ELEMENT_READING_UNSURE) assert.deepStrictEqual(opens(body), TYPE_READING_GUESS, body);
  // An element that is not followed by an arrow is no function type: a parameter-like text in an element, which compiles. The colon form, and a list too long to scan, are
  // what no rule settles: the element is read, and it is a guess.
  for (const body of ['<W>({() => 1})</W>', '<W>({ a }: X) </W>', '<b>(optional)</b>']) assert.deepStrictEqual(opens(body), ELEMENT, body);
  for (const body of ['<span>(required): Name</span>', '<T>(x: T): T', `<T>(${'x: number, '.repeat(300)}) => T`]) assert.deepStrictEqual(opens(body), ELEMENT_READING_GUESS, body);
  // The head of the type decides first where it can: a comma, a default or a constraint is a generic's, and a type alias head is a type's.
  for (const body of ['<T,>(x: Array<T>) => T', '<T extends X>(x: Array<T>) => T', '<T = string>(x: Array<T>) => T']) assert.deepStrictEqual(opens(body), GENERIC, body);
  assertCertain(['type F = <T>(x: Array<T>) => T;', 'type F = <T>(x: T): T;', 'export type F = <T>(o: { a: T }) => T;', 'declare type F = <T>(x: Map<string, T>) => void;']);
});

// `elementFailsAt(text, from, arrow)` reads the text of an element from `from` — just past the `>` of `<Name>` — the way TypeScript's parser reads the children of an
// element, up to and including the `>` of the `=>` at `arrow`. It answers the offset of the first character TypeScript's parser rejects, or -1 where this reading
// cannot say. `§` marks the offset expected, and a text with no mark is one that is not decided.
test('elementFailsAt: the text of an element is read token by token, and what cannot be told is left undecided', () => {
  const decide = (marked) => {
    const text = marked.replace('§', '');
    return [elementFailsAt(text, 0, text.lastIndexOf('=>')), marked.includes('§') ? marked.indexOf('§') : -1];
  };
  const punctuation = [...'()[]{},|&;?!*+%^~="\'`'];
  const decided = [
    // The text of the children: a `>` or a `}` is an error wherever it stands, the `>` of the arrow being the last place where one can.
    '(x: T) =§> T', '() =§> T', '(a§>b) => T', '(x: "§}") => T', '(a§} b) => T', '(x: ")") =§> T', '(x: T /* §> */) => T',
    // An expression container is read for what no expression has: a name and a colon, and a name, a `?` and a colon.
    '({ label§: T }) => T', '({label§:T}) => T', '({\n  a§: T\n}) => T', '({ $a§: T }) => T', '({ a_1 §: T }) => T', '({ a ?§: T }) => T', '({ a?§: T }) => T', '({ a ?\n§: T }) => T',
    // Two names side by side: the failure is at the second, unless the first can start an expression (`typeof a`, `new A`, `async a => a`) or the second continues one (`a in b`).
    '({ readonly §current: T }) => T', '({ a §b }) => T', '({ a\n§b }) => T', '({ get §a(): T }) => T', '({ as §T }) => T', '({ a §b, c }) => T', '({ x §null }) => T',
    '({ typeof a }) =§> T', '({ void a }) =§> T', '({ delete a }) =§> T', '({ await a }) =§> T', '({ yield a }) =§> T', '({ new A }) =§> T', '({ async a }) =§> T', '({ function f }) =§> T',
    '({ class A }) =§> T', '({ import x }) =§> T', '({ a in b }) =§> T', '({ a instanceof B }) =§> T', '({ a as T }) =§> T', '({ a satisfies T }) =§> T', '({ a\nas T }) =§> T',
    // A bracket: a name and a colon in it, or the bracket and a colon (and a `?` before the colon).
    '({ [k§: string]: T }) => T', '({ [ k §: string]: T }) => T', '({ readonly [k§: string]: T }) => T', '({ [K in keyof T]§: T[K] }) => T', '({ [a]§: T }) => T', '({ [a]?§: T }) => T',
    '({ [K in keyof T]?§: T[K] }) => T', '({ readonly [K in keyof T]§: T[K] }) => T', '({ [a, b]§: T }) => T',
    // A call: a name, a `(`, and a typed argument, or arguments of names, or none, then the colon that no call is followed by.
    '({ m(x§: T): T }) => T', '({ m ( x §: T): T }) => T', '({ m(x?§: T): T }) => T', '({ m()§: T }) => T', '({ m() §: T }) => T', '({ m(x)§: T }) => T', '({ m(x, y)§: T }) => T',
    '({ new (x§: T): T }) => T', '({ new ()§: T }) => T',
    // A quoted name: a string with escapes, which may hold a `}`, and then a colon.
    "({ 'a'§: T }) => T", '({ "a"§: T }) => T', '({ "a" §: T }) => T', "({ 'a\\'b'§: T }) => T", '({ "a}b"§: T }) => T', '({ "a"?§: T }) => T',
    // A container that holds nothing but names, numbers, `.`, `,` and white space is skipped, and the text goes on: the arrow's `>` is the next error.
    '({ a }) =§> T', '({}) =§> T', '({ }) =§> T', '({ a, b }) =§> T', '({ ...a }) =§> T', '({ a.b }) =§> T', '({ 1 }) =§> T', '({\n  a,\n  b\n}) =§> T', '({ a }: P) =§> T', '({ a }{ b }) =§> T',
    // A container that holds nothing that could open a nested construct with a `}` of its own — no brace, quote, back-tick, `/`, backslash or `<` — is skipped whatever it holds, and the text
    // goes on: the arrow's `>` is the next error. (If what it holds is no expression, TypeScript reports that inside it, before.)
    '({ a ? b : c }) =§> T', '({ a ?. b }) =§> T', '({ a?.5 : b }) =§> T', '({ a ?? b }) =§> T', '({ a.b: T }) =§> T', '({ (x: T): T }) =§> T', '({ a = 1 }) =§> T',
    '({ [Symbol.iterator](): T }) =§> T', '({ -readonly [K in keyof T]: T }) =§> T', '({ async (x: T) => x }) =§> T', '({ yield (x: T) => x }) =§> T', '({ async (x: T): T => x }) =§> T',
    '({ a\u00A0b }) =§> T', '({ \u00A0a: T }) =§> T', '({ m?(x: T): T }) =§> T', '({() => 1}) =§> T', '({ x => x }) =§> T', '({ a, b ? c : d }) =§> T',
    // What follows a skipped container is read as the text it is.
    '({ a }§>) => T', '({ a }§}) => T', '({ a }<§() => T', '({ a }<b>x) =§> T',
    // A `<` is followed by a tag name, and nothing else that this reads can follow it: with white space and line breaks between, too.
    ...punctuation.flatMap((c) => [`(a<§${c}) => T`, `(a< §${c}) => T`, `(a<\n§${c}) => T`]),
    // A tag: the name, a member name, and the `>` that ends it, after which the text goes on; a self-closing tag leaves the text as it was, and trivia of every kind may stand between its `/` and its `>`.
    '(<b>x) =§> T', '(<b/>x) =§> T', '(<b />x) =§> T', '(<A.B.C>x) =§> T', '(<_a$1>x) =§> T', '(< b>x) =§> T',
    '(<b / >x) =§> T', '(<b /\n>x) =§> T', '(<b /\r\n>x) =§> T', '(<b /\t>x) =§> T', '(<b /\u2028>x) =§> T', '(<b / /* c */ >x) =§> T', '(<b / // c\n>x) =§> T',
    '(<b x="1" / >x) =§> T', '(<A.B x / >x) =§> T', '(<b / /* > */ >x) =§> T', '(<b / // >\n>x) =§> T',
    // After the `/` of a tag, a token that is no `>` is where TypeScript wants it (TS1005).
    '(<b /§x>y) => T', '(<b / §x>y) => T', '(<b / /* c */ §x>y) => T', '(<b / §/>y) => T', '(<b /§{x}>y) => T',
    // A comment is trivia where a container reads a token: before and after the name, a colon, a bracket, a call.
    '({ /* c */ a§: T }) => T', '({ a /* c */ §: T }) => T', '({ // c\n a§: T }) => T', '({ /* } */ a§: T }) => T', '({ a/* c */§: T }) => T', '({ a /* c */ ?§: T }) => T',
    '({ [/* c */ k§: string]: T }) => T', '({ [k /* c */ §: string]: T }) => T', '({ [a /* c */ ]§: T }) => T', '({ m(/* c */ x§: T): T }) => T', '({ m(x /* c */)§: T }) => T',
    '({ m(/* c */)§: T }) => T', '({ readonly /* c */ §a: T }) => T', '({ /* c */ readonly §a: T }) => T', '({ 1 /* c */ §: T }) => T',
    '({ a /* } */ }) =§> T', '({ a, /* c */ b }) =§> T', '({ /* c */ }) =§> T', '({ a // }\n }) =§> T', '({ ...a /* } */ }) =§> T',
    // A run with nothing that could hide a `}` is skipped whatever it holds, and a comment in it is passed over whole: a `}` in the comment is no end.
    '({ (x: T): T // c\n }) =§> T', '({ (x: T): T /* c */ }) =§> T', '({ (/* } */ x: T): T }) =§> T', '({ a = 1 /* } */ }) =§> T', '({ (y: T) => y // }\n }) =§> T', '({ [Symbol.iterator](): T /* } */ }) =§> T',
    // A `{` where an attribute may start begins a spread, which wants its dots at once, so anything else there is an error at that token; a `<` after an attribute or after a closed list of
    // type arguments is no attribute name.
    '(<b {§a}>y) => T', '(<b { §a }>y) => T', '(<b {§}>y) => T', '(<b x="1" {§a}>y) => T', '(<b\n{\n§a}>y) => T', '(<b x §<T>>y) => T', '(<b<T> §<U>>y) => T', '(<b x="1" §<T>>y) => T',
    // A number and a colon, as a name and a colon, in every form the scanner reads as one literal.
    '({ 1§: T }) => T', '({ 1.5§: T }) => T', '({ 0x1§: T }) => T', '({ 1e3 §: T }) => T', '({ .5§: T }) => T', '({ 1?§: T }) => T', '({ 1_0§: T }) => T', '({ 1 ?§: T }) => T',
    // Attributes: names, a string with no escapes (a backslash is text, a `>` or a `}` in it is text), the `=` with white space BEFORE it.
    '(<b x>y) =§> T', '(<b x y z>y) =§> T', '(<b x-y>y) =§> T', '(<b x="1">y) =§> T', "(<b x='1'>y) =§> T", '(<b x ="1">y) =§> T', '(<b x="\\">y) =§> T', '(<b x="a>b">y) =§> T',
    '(<b x="}">y) =§> T', '(<b x="1"y="2">y) =§> T', '(<b x="a\nb">y) =§> T', '(<b\nx\n="1"\n>y) =§> T',
    // A value that is no string, container or element: TypeScript expects `{` or a JSX element there. `=>` and `==` are tokens of their own, so there is no value at all.
    '(<b x=§1>y) => T', '(<b x=§a>y) => T', '(<b x= §-1>y) => T', '(<b x=§`a`>y) => T', '(<b x§=>y) => T', '(<b x§==1>y) => T', '(<b x=§1 =>',
    // What cannot start an attribute, after the name and after an attribute.
    ...punctuation.filter((c) => c !== '{').flatMap((c) => [`(<b §${c}>y) => T`, `(<b x §${c}>y) => T`, `(<b x="1" §${c}>y) => T`]),
    // The type arguments of a tag, read when they are only names, dots and commas.
    '(<b<T>>x) =§> T', '(<b<T, U>>x) =§> T', '(<b<A.B<C>>>x) =§> T', '(<b <T> x>x) =§> T', '(<b<T> x="1">x) =§> T', '(<b<T>§,>x) => T', '(<b<\nT\n>>x) =§> T',
  ];
  for (const marked of decided) {
    const [got, expected] = decide(marked);
    assert.strictEqual(got, expected, JSON.stringify(marked));
  }
  const undecided = [
    // A container that holds a character that could open a nested construct with a `}` of its own — a comment, a `<` that starts an element or type parameters, a quote, a brace — and none of
    // the shapes read: it may end elsewhere than at its first `}`.
    '({ <U>(x: U): U }) => T', '({ function (x: T) {} }) => T',     '({ a, \'b\' }) => T', '({ (x: { a: T }): T }) => T', '({ a, `b` }) => T',
    // A backslash begins an identifier escape (`a\u0062` is `ab`), which this reading does not decode: a container that holds one is not skipped.
    '({ a\\u0062 }) => T', '({ \\u0061: T }) => T',
    // A comment that runs past the text: its end is not known, and nothing after it is.
    '({ a /* c }) => T', '({ a // c }) => T', '({ /* c }) => T',
    // A closing tag, a fragment, a comment, and what TypeScript reads as something other than a tag name or this does not read: `.`, `:`, `-`, a digit, `@`, `#`, an escape, a letter
    // beyond ASCII, a second `<`.
    '(</b>) => T', '(< /b>) => T', '(<>x</>) => T', '(< >) => T', '(a</* c */b>) => T', '(a<.b) => T', '(a<:b) => T', '(a<-b) => T', '(a<1) => T', '(a<@b) => T', '(a<#b) => T', '(a<\\u0062>) => T',
    '(a<é>) => T', '(a<<b) => T',
    // A name that continues with `-` or `:`, or a member name cut short.
    '(<a-b>x) => T', '(<a:b>x) => T', '(<A.>x) => T', '(<A.-b>x) => T',
    // In a tag: a self-closing tag with something else after the slash, a spread, a comment, an attribute value that is a container or an element, an unterminated
    // string, a comment before a value, a namespaced or a member attribute name, a name beyond ASCII.
    '(<b {...p}>y) => T', '(<b { ...p }>y) => T', '(<b {/* c */ a}>y) => T', '(<b {\u00A0a}>y) => T', '(<b {.a}>y) => T', '(<b /* c */ x>y) => T', '(<b // c\n x>y) => T',
    '(<b x={1}>y) => T', '(<b x=<c/>>y) => T', '(<b x="unterminated>y) => T',
    '(<b x= /* c */ "1">y) => T', '(<b x:y="1">z) => T', '(<b x.y>z) => T', '(<b é>z) => T',
    // A string that does not follow the `=` at once is an ordinary JavaScript string to TypeScript, with escapes, and ends where JSX's would not: `x = "a\"` goes on.
    '(<b x = "1">y) => T', "(<b x = '1'>y) => T", '(<b\nx\n=\n"1"\n>y) => T', '(<b x= "1">y) => T', '(<b x = "a\\">y) => T',
    // Type arguments that are not only names, dots and commas, or are not closed. (A `<` after an attribute or after a closed list is no attribute name, and is decided.)
    '(<b<{ a: T }>>y) => T', '(<b<T[]>>y) => T', '(<b<"a">>y) => T', '(<b<T) => T', '(<b<A . B>>y) => T', '(<b<A<B><C>>>y) => T', '(<b<A.>>y) => T',
    // The arrow itself inside a tag or an attribute string: the `>` is not text there, and nothing can be said.
    '(<b x=") =>" />)', '(<b =>', "(<b x=') =>' />)", '(<b x y =>',
  ];
  for (const text of undecided) assert.strictEqual(elementFailsAt(text, 0, text.lastIndexOf('=>')), -1, JSON.stringify(text));
});

// ─── White space beyond ASCII where the reading looks at a character ─────────────────────────────────────────────────────────────────────────────────────────────
//
// TypeScript's scanner skips trivia between the tokens of a tag — not only ASCII white space but the no-break space, U+0085, U+2028, the zero-width space, the byte order mark and
// every other character `isWhiteSpaceSingleLine` and `isLineBreak` name — where the TEXT of an element has none: a character there is text. The reading knows ASCII white space
// only, so a character beyond ASCII where a token could start or end is one it cannot tell from trivia (or from a letter that continues a name, as `é` does): it says nothing, -1.
// Each test puts such characters at one kind of place at which the reading looks at a character.
const TRIVIA_ASCII = ['\t', '\n', '\v', '\f', '\r', ' '];
const TRIVIA_BEYOND_ASCII = ['\u0085', '\u00A0', '\u1680', ...Array.from({ length: 12 }, (_, i) => String.fromCharCode(0x2000 + i)), '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF'];
const BEYOND_ASCII = [...TRIVIA_BEYOND_ASCII, '\u00E9'];
const elementFails = (text) => elementFailsAt(text, 0, text.lastIndexOf('=>'));
const visible = (text) => text.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const failsAtMark = (marked) => [elementFails(marked.replace('§', '')), marked.indexOf('§')];

test('elementFailsAt, the text of an element: a character beyond ASCII is text, nothing in it is skipped, so the ">" or "}" after it is still the error', () => {
  for (const c of BEYOND_ASCII) {
    for (const marked of [`(a${c}b) =§> T`, `(${c}§>) => T`, `(${c}§}) => T`, `(${c}${c}x: T${c}) =§> T`, `(x: "${c}§}") => T`]) {
      const [got, want] = failsAtMark(marked);
      assert.strictEqual(got, want, visible(marked));
    }
  }
});

test('elementFailsAt, after a "<": a character beyond ASCII is not read, as TypeScript skips trivia there and it may hide a tag name; ASCII white space is', () => {
  for (const marked of ['(a< b>) =§> T', '(a<\tb>) =§> T', '(a<\nb>) =§> T']) {
    const [got, want] = failsAtMark(marked);
    assert.strictEqual(got, want, visible(marked));
  }
  for (const c of BEYOND_ASCII) {
    for (const text of [`(a<${c}b>) => T`, `(a< ${c}b>) => T`, `(a<\n${c}b>) => T`, `(a<${c}) => T`, `(a<${c}>) => T`, `(a<${c}${c}b>) => T`]) assert.strictEqual(elementFails(text), -1, visible(text));
  }
});

test('elementFailsAt, an expression container: a name and a colon are read with ASCII white space only; a character beyond ASCII leaves nothing that can hide a "}", so the container is skipped', () => {
  for (const marked of ['({ a§: T }) => T', '({\ta §: T}) => T', '({ a ?§: T }) => T', '({ a ? §: T }) => T', '({\na\n?\n§: T}) => T']) {
    const [got, want] = failsAtMark(marked);
    assert.strictEqual(got, want, visible(marked));
  }
  // TypeScript skips trivia beyond ASCII between the tokens of a container, so the first-name rules do not read a name, a `?` or a colon with one beside it. What such a container cannot be is a
  // string, a template, a regex, a comment, an object or an element — nothing that holds a `}` of its own — so it ends at its first `}` whatever it holds, and the expression parser either reads
  // it or reports an error inside it, before the arrow: the arrow's `>` is where the text goes on to fail.
  for (const c of BEYOND_ASCII) {
    for (const text of [`({${c}a: T}) => T`, `({ ${c}a: T}) => T`, `({a${c}: T}) => T`, `({a ${c}: T}) => T`, `({a${c}?: T}) => T`, `({a?${c}: T}) => T`, `({a ?${c}: T}) => T`, `({a ? ${c}: T}) => T`]) {
      assert.strictEqual(elementFails(text), text.lastIndexOf('=>') + 1, visible(text));
    }
  }
});

test('elementFailsAt, a tag: a character beyond ASCII after the name, between attributes or before an "=" is not read, and after a "/" it is trivia like any other; ASCII white space is read', () => {
  for (const marked of ['(<b >x) =§> T', '(<b x="1"\ty="2">z) =§> T', '(<b x\t="1">y) =§> T', '(<b x \n§=>y) => T', '(<b />x) =§> T']) {
    const [got, want] = failsAtMark(marked);
    assert.strictEqual(got, want, visible(marked));
  }
  for (const c of BEYOND_ASCII) {
    for (const text of [
      // After the name.
      `(<b${c}>y) => T`, `(<b${c}x>y) => T`, `(<b${c}/>y) => T`, `(<b ${c}>y) => T`,
      // Between attributes, and after an attribute with no value.
      `(<b x="1"${c}y="2">z) => T`, `(<b x${c}y>z) => T`, `(<b x="1" ${c}y>z) => T`, `(<b x${c}>z) => T`,
      // Between an attribute's name and its `=`, where an ASCII space is skipped: `x` and the character beyond ASCII and `=>` is not an attribute with no value.
      `(<b x${c}="1">y) => T`, `(<b x ${c}="1">y) => T`, `(<b x${c}=>y) => T`, `(<b x${c}==1>y) => T`, `(<b x${c}={1}>y) => T`,
    ]) assert.strictEqual(elementFails(text), -1, visible(text));
  }
  // After a `/`, the `>` of a self-closing tag follows past trivia of every kind, beyond ASCII too (the scanner reads the `/` and the `>` as two tokens, parseExpected(SlashToken) and then
  // parseExpected(GreaterThanToken)): the tag ends there, and the arrow's `>` is the next error. A character that is no trivia is a token where the `>` should be (TS1005).
  for (const c of TRIVIA_BEYOND_ASCII) {
    for (const text of [`(<b /${c}>y) => T`, `(<b / ${c}>y) => T`, `(<b x="1" /${c}>y) => T`, `(<b /${c}${c}>y) => T`, `(<b /${c}/* c */${c}>y) => T`]) assert.strictEqual(elementFails(text), text.lastIndexOf('=>') + 1, visible(text));
  }
  for (const marked of ['(<b /§é>y) => T', '(<b / §é>y) => T', '(<b x="1" /§é>y) => T', '(<b /\u00A0§é>y) => T']) {
    const [got, want] = failsAtMark(marked);
    assert.strictEqual(got, want, visible(marked));
  }
});

// The attribute value is the place where a reading is most tempted to say more than it knows. TypeScript reads a JSX string only when its quote is the very next character after the `=`
// (scanJsxAttributeValue looks at that position and skips nothing); in any other case it calls scan(), which skips ALL trivia and then reads an ordinary token. So `x=` and a
// no-break space and `"a"` is an attribute with a value, and a reading that takes the character for a value that is no value calls a compiling element unparseable.
test('elementFailsAt, where an attribute value starts: a character beyond ASCII right after the "=" or after ASCII white space is not read, for TypeScript skips trivia there', () => {
  for (const c of BEYOND_ASCII) {
    for (const text of [
      `(<b x=${c}"1">y) => T`, `(<b x=${c}'1'>y) => T`, `(<b x=${c}{1}>y) => T`, `(<b x=${c}<c/>>y) => T`, `(<b x=${c}1>y) => T`, `(<b x=${c}y>y) => T`, `(<b x=${c}>y) => T`,
      `(<b x= ${c}{1}>y) => T`, `(<b x=\n${c}{1}>y) => T`, `(<b x=\t ${c}"1">y) => T`, `(<b x =${c}"1">y) => T`,
      // The element this decided wrongly: the second attribute's string has no escapes, so the `)` and the arrow in it are inside it and the element compiles.
      `(<C x=${c}"a" /><D p="\\" q=") =>" />)`, `(<C x= ${c}{1} /><D p="\\" q=") =>" />)`,
    ]) assert.strictEqual(elementFails(text), -1, visible(text));
  }
  // Every UTF-16 code unit beyond ASCII, there: undecided, whatever it is.
  const decided = [];
  for (let unit = 0x80; unit <= 0xffff; unit += 1) {
    const c = String.fromCharCode(unit);
    if (elementFails(`(<b x=${c}"1">y) => T`) !== -1 || elementFails(`(<b x= ${c}{1}>y) => T`) !== -1) decided.push(unit.toString(16));
  }
  assert.deepStrictEqual(decided, []);
  // ASCII there is decided: what TypeScript's scanner returns as a token other than a string, a `{` or a `<` is no value (TS1145), and the error is at that character.
  // (A quote and a `{` or `<` are values, `/` may begin a comment, and `=` and `>` after the name make a token of their own — each of those is read elsewhere or not at all.)
  for (const c of ['1', 'a', '_', '$', '-', '.', ':', ';', ',', '(', ')', '[', ']', '!', '?', '@', '#', '\\', '`', '|', '&', '*', '+', '%', '^', '~', '\u0000', '\u0001', '\u001f', '\u007f']) {
    const [got, want] = failsAtMark(`(<b x=§${c}y>z) => T`);
    assert.strictEqual(got, want, visible(c));
  }
  for (const c of ['"', "'", '{', '<', '/']) assert.strictEqual(elementFails(`(<b x=${c}y>z) => T`), -1, visible(c));
});

test('elementFailsAt, the type arguments of a tag: a character beyond ASCII where a name starts or ends, after a comma or after a closed list is not read; ASCII white space is', () => {
  for (const marked of ['(<b< T >>x) =§> T', '(<b<\tT,\nU>>x) =§> T', '(<b<A.B , C<D>>>x) =§> T']) {
    const [got, want] = failsAtMark(marked);
    assert.strictEqual(got, want, visible(marked));
  }
  for (const c of BEYOND_ASCII) {
    for (const text of [`(<b<${c}T>>x) => T`, `(<b<T${c}>>x) => T`, `(<b<T${c},U>>x) => T`, `(<b<T,${c}U>>x) => T`, `(<b<T>${c}>x) => T`, `(<b<A.${c}B>>x) => T`, `(<b<A${c}.B>>x) => T`, `(<b<T<${c}U>>>x) => T`]) {
      assert.strictEqual(elementFails(text), -1, visible(text));
    }
  }
});

// The claims above, against TypeScript: the characters it skips as trivia are the ones the tests use; each of them stands where an attribute value starts in an element that
// compiles, and the reading says nothing of it; and the ASCII characters at that place that the reading decides are errors TypeScript reports there.
test('TypeScript: its trivia beyond ASCII is the set the tests above use; each of them can start an attribute value that compiles, and the ASCII characters read as no value are errors', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const skipped = [];
  for (let unit = 0x80; unit <= 0xffff; unit += 1) if (ts.isWhiteSpaceSingleLine(unit) || ts.isLineBreak(unit)) skipped.push(String.fromCharCode(unit));
  assert.deepStrictEqual(skipped, TRIVIA_BEYOND_ASCII, 'a character TypeScript skips that the tests do not use');
  assert.deepStrictEqual(TRIVIA_ASCII.filter((c) => !(ts.isWhiteSpaceSingleLine(c.charCodeAt(0)) || ts.isLineBreak(c.charCodeAt(0)))), []);
  for (let unit = 0; unit < 0x80; unit += 1) {
    assert.strictEqual(ts.isWhiteSpaceSingleLine(unit) || ts.isLineBreak(unit), TRIVIA_ASCII.includes(String.fromCharCode(unit)), `U+${unit.toString(16)}`);
  }
  for (const c of [...TRIVIA_ASCII, ...TRIVIA_BEYOND_ASCII]) {
    for (const inner of [`<C x=${c}"a" />`, `<C x=${c}'a' />`, `<C x=${c}{1} />`, `<C x= ${c}{1} />`, `<C x${c}="a" />`]) {
      const text = `(${inner}<D p="\\" q=") =>" />)`;
      assertTsParses(ts, `const e = <W>${text}</W>;`, `TypeScript parses ${visible(text)}`);
      assert.strictEqual(elementFails(text), -1, `and the reading says nothing of ${visible(text)}`);
    }
  }
  const asciiTexts = [];
  for (let unit = 0; unit < 0x80; unit += 1) {
    const c = String.fromCharCode(unit);
    if (!TRIVIA_ASCII.includes(c) && !'"\'{</'.includes(c)) asciiTexts.push(`(<b x=${c}y>z) => T`);
  }
  const stats = judgeDirect(ts, (text, arrow) => elementFailsAt(text, 0, arrow), asciiTexts);
  assert.deepStrictEqual([stats.unsound, stats.unjustified], [[], []], 'a character read as no value that TypeScript reads as one, or reports an error for only later');
  assert.ok(stats.invalid >= 115, `${stats.invalid} ASCII characters were read as no value`);
});

// The rule that tells a generic arrow's type parameters from an element reads the tokens after a `<` the way TypeScript's scanner does, so it skips the trivia TypeScript skips
// between them. White space by JavaScript's definition (`\s`) is all of it but two characters: the next-line character (U+0085) and the zero-width space (U+200B), which TypeScript
// skips and `\s` does not match. A reader that used `\s` took the first for a token, `<T extends` and U+0085 and `>` for a constraint, and read an element as a generic arrow —
// and the regex after the element as code.
test('the TSX rule and the generic function type read past every character TypeScript skips between tokens, U+0085 and U+200B among them', () => {
  for (const c of [...TRIVIA_ASCII, ...TRIVIA_BEYOND_ASCII]) {
    for (const code of [
      `<T${c}extends${c}X>(x: T) => x`, `<T${c},>(x: T) => x`, `<${c}T,>(x: T) => x`, `<const${c}T,>(x: T) => x`, `<T${c}= string>(x: T) => x`, `<T${c}${c}extends${c}${c}X>(x: T) => x`,
    ]) assert.deepStrictEqual(opens(code), GENERIC, visible(code));
    for (const code of [`<T extends${c}>text</T>`, `<T extends${c}/>`, `<T${c}extends${c}>text</T>`, `<T${c}x>text</T>`, `<${c}T>text</T>`]) assert.deepStrictEqual(opens(code), ELEMENT, visible(code));
    // A generic function type has trivia between its `>`, its parameter list and its arrow: the list is found, and the type is certain.
    for (const code of [`<T>${c}(x: T) => T`, `<T>(x: T)${c}=> T`, `<T>${c}(x: T)${c}=> T`]) assert.deepStrictEqual(opens(code), GENERIC, visible(code));
  }
});

test('TypeScript: the rule skips exactly the characters its scanner skips between tokens, over every UTF-16 code unit', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const wrong = [];
  for (let unit = 0x80; unit <= 0xffff; unit += 1) {
    const c = String.fromCharCode(unit);
    const skipped = ts.isWhiteSpaceSingleLine(unit) || ts.isLineBreak(unit);
    // After the `>` of `<T>` no name can take the character in: it is skipped, or it is the token that is no parameter list. Every code unit is asked here, the characters that
    // can continue a name (U+200C, U+200D, a combining mark) too, for those are not trivia and must not be read as it.
    if (opens(`<T>${c}(x: T) => T`).generic !== skipped) wrong.push(`U+${unit.toString(16)} before a parameter list`);
    // A character that continues a name belongs to the first name, whatever the Unicode tables of the engine and of the TypeScript package say of it: not the question here.
    if (ts.isIdentifierPart(unit, ts.ScriptTarget.Latest) || /^\p{ID_Continue}$/u.test(c)) continue;
    // `<T` and the character and `,>`: type parameters when the character is skipped and the comma is the next token, and an element when it is a token of its own.
    if (opens(`<T${c},>(x: T) => x`).generic !== skipped) wrong.push(`U+${unit.toString(16)} between T and a comma`);
  }
  assert.deepStrictEqual(wrong, []);
});

// ─── The white space of the whole file is TypeScript's ───────────────────────────────────────────────────────────────────────────────────────
//
// One helper decides what white space is — isTrivia — and every scan of the lexer and the resolver uses it, backward and forward, in a test of a character and in a regular expression.
// JavaScript's `\s` (and `trim`) lacks U+0085 and U+200B, which TypeScript skips between tokens: `if` U+0085 `(true) /navigateTo({…})/;` is an `if` whose statement is a regex, and a
// lexer that did not know the character read no `if`, a division, and a call.
const TYPESCRIPT_WHITE_SPACE = [...TRIVIA_ASCII, ...TRIVIA_BEYOND_ASCII];
test('isTrivia is exactly the characters TypeScript skips between tokens — JavaScript\'s white space but for two, U+0085 and U+200B, which it adds — and trimTrivia trims by it', () => {
  const javascript = [];
  const typescript = [];
  for (let unit = 0; unit <= 0xffff; unit += 1) {
    const c = String.fromCharCode(unit);
    if (/\s/.test(c)) javascript.push(c);
    if (isTrivia(c)) typescript.push(c);
    assert.strictEqual(isTrivia(c), TYPESCRIPT_WHITE_SPACE.includes(c), `U+${unit.toString(16)}`);
    assert.strictEqual(isSingleLineTrivia(c), TYPESCRIPT_WHITE_SPACE.includes(c) && !'\n\r\u2028\u2029'.includes(c), `single line, U+${unit.toString(16)}`);
  }
  assert.deepStrictEqual(typescript.filter((c) => !javascript.includes(c)), ['\u0085', '\u200b'], 'TypeScript skips two characters `\\s` lacks');
  assert.deepStrictEqual(javascript.filter((c) => !typescript.includes(c)), [], 'and every character `\\s` has');
  for (const value of [undefined, null, '', 'ab', 12]) assert.strictEqual(isTrivia(value), false, `not a character: ${String(value)}`);
  assert.strictEqual(trimTrivia('\u0085\u200b \t a b \u2028\ufeff'), 'a b');
  assert.strictEqual(trimTrivia('\u0085\u200b'), '');
  assert.strictEqual(trimTrivia(' a\u200bb '), 'a\u200bb');
  assert.ok(new RegExp(`^${WS}+$`).test(TYPESCRIPT_WHITE_SPACE.join('')), 'WS is the same set as a regular expression');
  assert.ok(new RegExp(`^[${TRIVIA_CLASS}]+$`).test(TYPESCRIPT_WHITE_SPACE.join('')), 'and TRIVIA_CLASS is its class');
});

test('TypeScript: isTrivia agrees with its scanner over every UTF-16 code unit', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const wrong = [];
  for (let unit = 0; unit <= 0xffff; unit += 1) {
    const c = String.fromCharCode(unit);
    if (isTrivia(c) !== (ts.isWhiteSpaceSingleLine(unit) || ts.isLineBreak(unit))) wrong.push(`U+${unit.toString(16)}`);
    if (isSingleLineTrivia(c) !== ts.isWhiteSpaceSingleLine(unit)) wrong.push(`single line, U+${unit.toString(16)}`);
  }
  assert.deepStrictEqual(wrong, []);
});

// Every place the lexer asks whether a character is white space, with the two characters that differ: a head's `(`, the `/` or `<` after a token, the word before a `(`, the cast that ends before
// a `/`, the `.` before a property named like a keyword, `as` and `satisfies` before a type, and a `type Name =`. Each is read through U+0085 and U+200B as through a space.
test('every scan of the lexer reads U+0085 and the zero-width space as white space: a head, a `/` or `<` after a token, a word, a property, a cast', () => {
  for (const c of ['\u0085', '\u200b', '\u00a0', '\ufeff', '\u3000']) {
    // A statement head: `if`, `while`, `for`, `with` and `for await`, before the `(` and between the `)` and the regex, which is read for certain — the regex is data.
    for (const head of ['if', 'while', 'with']) {
      const code = `${head}${c}(x)${c}/navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/.test(s);\n`;
      assert.deepStrictEqual(ambiguities(code), [], visible(code));
      assert.ok(!maskOf(code).includes('navigateTo'), `${head}: the regex is data: ${visible(code)}`);
    }
    for (const code of [
      `for${c}(;;)${c}/navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/.test(s);\n`, `async function f() { for${c}await${c}(y of x)${c}/navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/.test(s); }\n`,
    ]) {
      assert.deepStrictEqual(ambiguities(code), [], visible(code));
      assert.ok(!maskOf(code).includes('navigateTo'), `the regex is data: ${visible(code)}`);
    }
    // A keyword before a `/` or a `<`: an expression starts. A name before one: it divides or compares.
    for (const word of ['return', 'typeof', 'throw', 'delete', 'void', 'in', 'of']) {
      const code = `function f(x) { ${word}${c}/navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/.test(s); }\n`;
      assert.ok(!maskOf(code).includes('navigateTo'), `${word}: the regex is data: ${visible(code)}`);
    }
    // A property named like a keyword is no keyword, with the `.` and the word apart: `obj.${c}return / 2 / 3` divides, with no regex.
    assertCertain([`const k = obj.${c}return / 2 / 3;`, `const k = obj${c}.${c}new / 2 / 3;`, `const k = obj?.${c}delete / 2 / 3;`, `const k = a${c}+${c}b / 2 / 3;`]);
    // `type`, `export` and `declare` before a type alias head, and a name with the white space between them.
    assertCertain([`type${c}Fn${c}=${c}<T>(x: T) => T;`, `export${c}type${c}Fn = <T>(x: T) => T;`, `declare${c}type Fn = <T>(x: T) => T;`]);
    // A cast that ends before a `/`: a division, with the type name and the `as` apart by white space — certain, so a scan that did not take `c` for white space would leave the guess.
    assert.deepStrictEqual(ambiguities(`const half = total${c}as${c}Alias<number>${c}/ 2; const re = /x/;`), [], 'a cast: a division, certain');
    assert.deepStrictEqual(ambiguities(`const half = total${c}satisfies${c}A.B<number>${c}< 2; const re = /x/;`), [], 'a cast: a comparison, certain');
  }
  // An unknown character beyond ASCII where a keyword's `(` should stand is no head and no certainty: a guess. (A letter, a mark or a digit beyond ASCII ends a name: certain.)
  assert.deepStrictEqual(ambiguities('const k = f\u2060(a) / 2 / 3;').map(([, kind]) => kind), ['identifier'], 'a character that is no letter and no white space before a "("');
  assertCertain(['const k = café(a) / 2 / 3;', 'const k = f(a)(b) / 2 / 3;', 'const k = a[0](b) / 2 / 3;', 'const k = (a)(b) / 2 / 3;']);
});

// The lexer's own source, and the resolver's, hold no `\s` or `trim(` in code: a test of white space is isTrivia, a regular expression's is WS (source-literals.js), a trim is trimTrivia. A
// new one fails here, so it cannot arrive with the characters TypeScript skips and JavaScript does not. The comments are the lexer's (a `\s` in a comment says why it is not used); the
// allowlist names each use that is no white space test, with the reason, and a stale entry fails too.
const commentRangesOf = (source) => commentRanges(source);
const WHITE_SPACE_FILES = ['source-literals.js', 'pageref-resolver.js', 'page-structure.js'];
const WHITE_SPACE_ALLOWED = [
  { file: 'pageref-resolver.js', text: '[\\s\\S]', reason: 'the complement idiom: any character at all, a string\'s escape or line continuation — no white space is tested' },
];
test('no code of the lexer, the resolver or the structure gate tests white space with `\\s` or `trim(`: it is isTrivia, WS and trimTrivia, and each exception is named', () => {
  const found = [];
  const used = new Set();
  for (const file of WHITE_SPACE_FILES) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
    const code = source.split('');
    for (const { start, end } of commentRangesOf(source)) for (let k = start; k < end; k += 1) if (!'\n\r\u2028\u2029'.includes(code[k])) code[k] = ' ';
    let text = code.join('');
    for (const allowed of WHITE_SPACE_ALLOWED.filter((entry) => entry.file === file)) {
      if (text.includes(allowed.text)) used.add(`${allowed.file} ${allowed.text}`);
      text = text.split(allowed.text).join(' '.repeat(allowed.text.length));
    }
    for (const match of text.matchAll(/\\[sS]|\.(?:trim|trimStart|trimEnd|trimLeft|trimRight)\(/g)) found.push(`${file}:${text.slice(0, match.index).split('\n').length}: ${match[0]}`);
  }
  assert.deepStrictEqual(found, [], 'JavaScript\'s white space where TypeScript\'s is meant');
  assert.deepStrictEqual(WHITE_SPACE_ALLOWED.filter((entry) => !used.has(`${entry.file} ${entry.text}`)), [], 'an allowlist entry that matches nothing');
});

// The scan above trusts the lexer's idea of where comments are. Where TypeScript is available, its parser's is the same: the comments that lead a token of the file, found through the tree
// (a bare scanner cannot tell a regular expression from a division).
test('TypeScript: the comments the lexer finds in its own source and the resolver\'s are the ones its parser finds', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  for (const file of WHITE_SPACE_FILES) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const theirs = new Map();
    const visit = (node) => {
      if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
      const children = node.getChildren(tree);
      if (children.length === 0) {
        // The comments before a token that start a line, and those after one on its own line.
        for (const range of [...(ts.getLeadingCommentRanges(source, node.getFullStart()) || []), ...(ts.getTrailingCommentRanges(source, node.getEnd()) || [])]) theirs.set(range.pos, range.end);
      } else children.forEach(visit);
    };
    visit(tree);
    const ours = commentRangesOf(source).map(({ start, end }) => [start, end]);
    assert.deepStrictEqual(ours, [...theirs].sort((a, b) => a[0] - b[0]), `${file}: the comments`);
    assert.ok(ours.length > 10, `${file}: ${ours.length} comments`);
  }
});
test('TypeScript: the element reading of a "<Name>(…) =>" that is a type fails to parse, for the reason the rule gives; the types are valid; the unsure shapes can compile', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const diagnostics = (code) => ts.createSourceFile('snippet.tsx', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX).parseDiagnostics;
  const asElement = (body) => `const e = ${body}</${body.match(/^<(\w+)>/)[1]}>;`;
  for (const [reason, code, bodies] of ELEMENT_READING_FAILS) {
    for (const body of bodies) {
      assert.ok(diagnostics(asElement(body)).some((d) => d.code === code), `${reason}, TS${code}: ${body}`);
      assertTsParses(ts, `export {};\nlet v: ${body};`, `a valid type: ${body}`);
    }
  }
  // These compile as JSX, so no rule may call them a type; the first is the page that read an arrow in an attribute string as a function type's.
  for (const code of [
    'const e = <Wrapper>(<Child x="\\" y=") =>" />)</Wrapper>;', 'const e = <W>({() => 1})</W>;', 'const e = <W>({ a }: X) </W>;', 'const e = <span>(required): Name</span>;',
    "const e = <Wrapper>(<Child x='\\' y=') =>' />)</Wrapper>;",
  ]) assertTsParses(ts, code, `an element: ${code}`);
  // The seven declarations a rule that asked only for a `<` or `{` before the arrow refused as truncated: each is a valid type, and an element that holds it is not.
  for (const [name, declaration] of FUNCTION_TYPE_DECLARATIONS) assertTsParses(ts, `import * as React from "react";\n${declaration}`, name);
  // TypeScript scans an attribute string by JSX's rules — no escapes — only when its quote comes right after the `=` (scanJsxAttributeValue looks at the character at that
  // position, with no white space skipped); after white space it is an ordinary JavaScript string, with escapes. So `x="a\"` ends at its second quote and the arrow after it
  // is text (TS1382), and `x = "a\"` goes on past the backslash-quote and is unterminated (TS1002): the reading leaves the second undecided.
  const text = (attribute) => `const e = <T>(<b ${attribute}/> ) => T</T>;`;
  assert.ok(diagnostics(text('x="a\\"')).some((d) => d.code === 1382), 'x="a\\" is a JSX string that ends at the second quote');
  assert.ok(!diagnostics(text('x = "a\\"')).some((d) => d.code === 1382) && diagnostics(text('x = "a\\"')).some((d) => d.code === 1002), 'x = "a\\" is a JavaScript string that goes on');
});

// Generic function types whose parameter lists hold type arguments, object types or a comma between type arguments are types, and code: a page that holds one is complete to
// the structure gate, no guess is named, and a call after it is a call.
test('a generic function type with type arguments, an object type or a comma in its parameter list is code: the page is complete and a call after it is read', () => {
  for (const [name, declaration] of FUNCTION_TYPE_DECLARATIONS) {
    const code = `import * as React from "react";\n${declaration}\nexport default function Page() {\n  navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});\n  return null;\n}\n`;
    assert.deepStrictEqual(ambiguities(code), [], name);
    assert.ok(maskOf(code).includes('navigateTo'), `${name}: the call after it is code`);
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], name);
    assert.deepStrictEqual(pageStructureProblems(code), [], `${name}: the page is complete`);
  }
  for (const [, , bodies] of ELEMENT_READING_FAILS) {
    for (const body of bodies) assertCertain([`const a: ${body} = f;`, `interface P { m: ${body}; }`, `function g(cb: ${body}) {}`]);
  }
  // What is not provably a type is read as one and reported at the `<`, and the call after it is not trusted: the guess is named, and the page is complete.
  for (const body of ELEMENT_READING_UNSURE) {
    const code = `const a: ${body} = f;\nnavigateTo({pageType:"generative", pageId:"PAGEREF_detail"});\n`;
    assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf('<'), 'generic'], body);
  }
});

// The page that read an arrow in an attribute string as a function type's: TypeScript reads one element with no diagnostic, and the regex after it is a regex. The `<` is a
// guess (`generic`), read as the type it almost always is, so a call or token after it is not trusted and is never rewritten.
test('"<Name>(…) =>" with the arrow in a nested attribute string: a guess at the "<", so a regex after it is never rewritten', () => {
  const nested = `const element = <Wrapper>(<Child x="\\" y=") =>" />)</Wrapper>;${REGEX_STATEMENT}\n`;
  assert.deepStrictEqual(earliestAmbiguity(nested), [nested.indexOf('<Wrapper>'), 'generic']);
  assert.deepStrictEqual(opens('<Wrapper>(<Child x="\\" y=") =>" />)</Wrapper>'), TYPE_READING_GUESS);
  // The JSX look-alikes that compile are elements, read right and with no guess: the regex after each is a regex, and its token is no call.
  for (const { name, code } of ELEMENT_LOOKALIKE_PAGES) {
    assert.deepStrictEqual(ambiguities(code), [], name);
    assert.strictEqual(maskOf(code).split('navigateTo').length - 1, 1, `${name}: only the real call is code`);
  }
});

// TypeScript's rule asks of the first name after the `<` whether it is an identifier (parser.ts, `isIdentifier()`), and two words are not one in some contexts:
// `await` inside an async function (and at the top level of a module), `yield` inside a generator. TypeScript 5.8:
//   async function p() { const e = <await extends SomeType>text</await>; }      JsxElement
//   function p() { const e = <await extends SomeType>(x: await) => x; }          ArrowFunction
//   function* g() { const e = <yield extends SomeType>text</yield>; }            JsxElement
// This lexer does not track what function a `<` is in, so it is a guess (`generic`), and the element is read. The token after `const` is read as the name
// without that check, so `<const await extends X>` stays with the rule.
test('a "<" followed by "await" or "yield" is a guess: whether the word is an identifier depends on the function around it', () => {
  const guess = { generic: false, ambiguity: 'generic' };
  for (const word of ['await', 'yield']) {
    for (const code of [
      `<${word} extends SomeType>text</${word}>`, `<${word} extends SomeType>(x: ${word}) => x`, `<${word},>(x) => x`, `<${word} = string>(x) => x`, `<${word}>text</${word}>`,
      `<${word}/* c */ extends X>(x) => x`,
    ]) assert.deepStrictEqual(opens(code), guess, code);
  }
  // A word written with a Unicode escape is the word to TypeScript, which cooks it before it asks.
  assert.deepStrictEqual(opens('<aw\\u0061it extends X>text</aw\\u0061it>'), guess);
  assert.deepStrictEqual(opens('<yi\\u0065ld,>(x) => x'), guess);
  for (const code of ['<const await extends X>(x) => x', '<const yield,>(x) => x', '<awaiting,>(x) => x', '<Await,>(x) => x', '<yielded extends X>(x) => x', '<await_,>(x) => x', '<$await,>(x) => x']) {
    assert.deepStrictEqual(opens(code), GENERIC, code);
  }
  assert.deepStrictEqual(opens('<awaiting>text</awaiting>'), ELEMENT);
  const regex = '/navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})/';
  for (const [what, code, word] of [
    ['an async function', `async function probe() { const element = <await extends SomeType>text</await>; const re = ${regex}; record(re.test(text)); return element; }`, 'await'],
    ['a generator', `function* probe() { const element = <yield extends SomeType>text</yield>; const re = ${regex}; record(re.test(text)); return element; }`, 'yield'],
    ['a plain function, where it is an arrow', `function probe() { const element = <await extends SomeType>(x: await) => x; const re = ${regex}; }`, 'await'],
  ]) {
    assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf(`<${word}`), 'generic'], what);
    assert.ok(!maskOf(code).includes('navigateTo'), `${what}: the regex is data`);
  }
});

// ─── The token before a `<` ──────────────────────────────────────────────────────────────────────────────────────────
//
// TypeScript asks the arrow question only where an ASSIGNMENT expression starts. The operand of a unary or binary operator is a unary expression, where a `<`
// followed by a name is an element whatever follows the name (parser.ts, `parseUpdateExpression`): `a === <T extends X>text</T>` is JSX. So what stands before
// the `<` decides whether the rule is asked at all, and a wrong answer reads an element's text, and the regex after it, as code. ANGLE_AFTER says, for each
// token that can stand there: `element` — a unary or binary operator, an element for certain; `rule` — an assignment expression starts, so the rule decides;
// `guess` — both readings compile, so the lexer reads the element and reports the guess. A token that is not in the table is a guess too.
const PREFIX_ONLY = new Set(['!', '~', 'typeof', 'delete', 'void', 'await']);
const ELEMENTS = ['<T extends X>MARK</T>', '<T extends X>(a): MARK</T>', '<T extends X Y>MARK</T>'];

test('after a unary or binary operator a "<" opens an element whatever follows its name: its text is text, the regex after it is data, and nothing is guessed', () => {
  for (const token of ANGLE_AFTER.element.filter((word) => word !== 'await')) {
    for (const separator of ['', ' ', '\n']) {
      // `<<` right before the `<` is `<<<`, a shift or type arguments (a guess, below), and a line break after `void` is a guess of its own.
      if ((token === '<<' && separator === '') || (token === 'void' && separator === '\n')) continue;
      for (const element of ELEMENTS) {
        const code = `const k = ${PREFIX_ONLY.has(token) ? '' : 'a '}${token}${separator}${element};${REGEX_STATEMENT}\n`;
        assert.ok(!maskOf(code).includes('MARK'), `an element, whose text is text: ${JSON.stringify(code)}`);
        assert.ok(!maskOf(code).includes('navigateTo'), `the regex after it is data: ${JSON.stringify(code)}`);
        assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
      }
    }
  }
  // `await` is the unary operator inside an async function and a name elsewhere: an element after it, and a guess (`keyword`) reported all the same.
  const awaited = `async function f() { const k = await <T extends X>MARK</T>;${REGEX_STATEMENT} }\n`;
  assert.deepStrictEqual(earliestAmbiguity(awaited), [awaited.indexOf('<T'), 'keyword']);
  assert.ok(!maskOf(awaited).includes('MARK') && !maskOf(awaited).includes('navigateTo'));
});

test('"<<" before a name is a shift or type arguments, a guess; after a space or a line break it is a shift, and the "<" opens an element', () => {
  // Right before the `<` TypeScript's scanner reads one token, a shift, and the parser splits it where type arguments begin with a function type: no element is
  // read there, so the rule reads what the type arguments are (a generic, which is code), and the pair is reported all the same.
  const shifted = `const k = a<<<T extends X>MARK</T>;${REGEX_STATEMENT}\n`;
  assert.deepStrictEqual(earliestAmbiguity(shifted), [shifted.indexOf('<T'), 'operator']);
  const typeArguments = `const k = total as ReturnType<<T = unknown>(x: T) => number> / count;${REGEX_STATEMENT}\n`;
  // The head of that function type cannot be an element (`T =` is no attribute), so its `<` is type parameters for certain and the pair is no guess; the `/` after the type
  // arguments' `>` follows a cast the lexer can prove is one, so it divides, for certain.
  assert.deepStrictEqual(ambiguities(typeArguments), []);
  assert.ok(maskOf(typeArguments).includes('count'), 'the function type is code, and so is what follows it');
  // Where the text after the pair may be an element, it is a guess: `<T extends X>text</T>` is one after a shift and type arguments for a function type are another.
  assert.deepStrictEqual(ambiguities(`const k = a<<<T = X>(x: T) => MARK;${REGEX_STATEMENT}\n`), [], 'a head that is no tag');
  assert.deepStrictEqual(earliestAmbiguity(`const k = a<<<T extends X>text</T>;${REGEX_STATEMENT}\n`), [`const k = a<<<T extends X>text</T>;`.indexOf('<T'), 'operator']);
  for (const separator of [' ', '\n']) {
    const code = `const k = a <<${separator}<T extends X>MARK</T>;${REGEX_STATEMENT}\n`;
    assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
    assert.ok(!maskOf(code).includes('MARK') && !maskOf(code).includes('navigateTo'), JSON.stringify(code));
  }
});

// Where TypeScript reads the `<` as an element after one of these tokens in one program and as something else in another, the lexer cannot tell which program
// it is in. `a >= <T extends X>(y: T): T</T>` compares; `let x: A<number>= <T extends X>(y: T): T => y` closes type arguments and assigns. `a < <T extends X>(y: T): T</T>`
// compares. `"a" in <T extends X>(y: T): T</T>` tests; `for (k in <T extends X>(y: T): T => y)` is a head. And `void` is the unary operator, or a type that a line break ended:
// `let x: void` LF `<T extends X>(y: T): T => y`. The element is read, and the guess is reported — but only where the text after the `<` leaves both readings open: a head that is
// no element (`<T,>`, `<T = X>`, a parameter list and an arrow that the element reading cannot hold) is type parameters whatever stands before it, and a head with a constraint and
// no parameter list is an element in every program that parses.
test('a "<" that opens a generic after ">=", a "<" or "in", or after "void" and a line break, is a guess where the head leaves both readings open: the element is read and reported', () => {
  const rows = [
    ['const k = a >= ', 'operator'], ['const k = a >=', 'operator'], ['const k = a >=\n', 'operator'],
    ['const k = a < ', 'operator'], ['const k = a <\n', 'operator'],
    ["const k = 'a' in ", 'operator'], ["const k = 'a' in", 'operator'], ["const k = 'a' in\n", 'operator'],
    ['void\n', 'newline'], ['void\r\n', 'newline'], ['void /* c\n */ ', 'newline'], ['const k = void\n', 'newline'],
  ];
  // A head with a constraint and a parameter list that a colon follows is JSX text or an arrow's return type, and both compile: the guess, with the element read.
  for (const [before, kind] of rows) {
    const code = `${before}<T extends X>(x: T): MARK</T>;${REGEX_STATEMENT}\n`;
    assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf('<T'), kind], JSON.stringify(code));
    assert.ok(!maskOf(code).includes('MARK') && !maskOf(code).includes('navigateTo'), `the element is read: ${JSON.stringify(code)}`);
  }
  // A head with a constraint and no parameter list, `<T extends X>text</T>`, is an element after each of these tokens, the cut `>=` included, in every program that parses
  // (`const k = <T extends X>text</T>` is an error: an arrow is attempted, and wants its parameters; so is `v >>= <T extends X>text</T>`).
  for (const [before] of rows) {
    const code = `${before}<T extends X>MARK</T>;${REGEX_STATEMENT}\n`;
    assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
    assert.ok(!maskOf(code).includes('MARK') && !maskOf(code).includes('navigateTo'), `the element is read: ${JSON.stringify(code)}`);
  }
  assertCertain([
    'const k = a >= <div>MARK</div>;', 'const k = a < <div>MARK</div>;', "const k = 'a' in <div>MARK</div>;", 'void\n<div>MARK</div>;', 'const k = a >= <>MARK</>;',
    'const k = a < <T>MARK</T>;', 'const k = a >= <T extends>MARK</T>;', 'void <T extends X>MARK</T>;', 'void<T extends X>MARK</T>;',
    // A head that cannot be an element is type parameters, whatever stands before it.
    'const k = a < <T,>(x: T) => MARK;', 'const k = "a" in <T,>(x: T) => MARK;', 'let x: void\n<T,>(x: T) => MARK;', 'f< <T extends X>(x: T) => MARK>();',
  ]);
});

// The head after a `<` is read within LOOKAHEAD characters (elementReadingFails), as the parameter list after it is: the question is asked at every candidate `<`, and a
// read of the whole source from each one would be quadratic. A head whose proof lies beyond the limit is left undecided, so the guess before it stays: a valid page is
// refused there, and nothing is misread.
test('a head is read within the lookahead: one whose proof lies beyond it leaves the guess before it standing', () => {
  const near = `v >>= <T ,>(y: T) => MARK;${REGEX_STATEMENT}\n`;
  assert.deepStrictEqual(ambiguities(near), [], 'a head that cannot be an element is type parameters, after a guess token too');
  assert.ok(maskOf(near).includes('MARK'));
  const far = `v >>= <T${' '.repeat(2100)},>(y: T) => MARK;${REGEX_STATEMENT}\n`;
  assert.deepStrictEqual(earliestAmbiguity(far), [far.indexOf('<T'), 'operator']);
});

// A self-closing head is the whole element (elementReadingFails): what follows `<T/>` is no text of its own. TypeScript takes no call of an element, so a line break after it ends the statement, and an
// arrow function may start the next (`const e = <T a="x"/>` LF `({ a }: { a: number }) => 1;` parses). A parameter list and an arrow there prove nothing about the `<`: the element reading of the text
// between them fails at `{ a: number }`, so a head read for what follows it would be type parameters. Read so, the string in the head, `"\"` to a JSX string, is a JavaScript string that no line closes,
// and the page — which TypeScript parses — is refused for nothing.
test('a self-closing head is the whole element: a parameter list and an arrow on the next line are another statement', (t) => {
  const arrow = '({ a }: { a: number }) => 1;';
  for (const head of ['<T/>', '<T a="x"/>', '<T a="\\"/>', "<T a='\\'/>", '<T a="\\" b="v"/>']) {
    const code = `const e = ${head}\n${arrow}\n${READ_CALL};\n`;
    assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
    assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, `the call after the arrow is code: ${JSON.stringify(code)}`);
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], JSON.stringify(code));
  }
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  for (const head of ['<T/>', '<T a="x"/>', '<T a="\\"/>', "<T a='\\'/>", '<T a="\\" b="v"/>']) {
    const source = ts.createSourceFile('page.tsx', `const e = ${head}\n${arrow}\n${READ_CALL};\n`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.deepStrictEqual(source.parseDiagnostics.map((d) => d.code), [], `TypeScript parses an element, then an arrow function statement: ${head}`);
  }
});

// ─── A call or construct signature with no return type ───────────────────────────────────────────────────────────────────────────────────────────
//
// `<T>(x)` is JSX text that starts with a parenthesis in an expression and, where a type holds members, a call signature with no return type — a construct signature after `new` — and TypeScript parses
// both with no diagnostic. A lexer that read the signature as an element read the rest of the type as JSX text, up to a closing tag that it found in a string or a comment that came after it, and
// read the text of a call in that string as a real one, whose token was then rewritten:
//   interface I { <T>(x) }          const s = '</T>;navigateTo({ … });//';
// callSignatureOrElement tells the two apart where the text can: a signature ends its member with `,`, `;`, `}` or a line break (parseTypeMemberSemicolon), and an element's text is read to its closing tag.
// The pages — every place a type with members stands, every head, ending and decoy — are in tests/helpers/angle-frames.js.

test('a call or construct signature with no return type is read as code, for certain: the type after it is no text, the token in the string is data, and the call after it is the real one', (t) => {
  const pages = signaturePages(SIGNATURE_ENDINGS);
  for (const { code, at, label } of pages) {
    assert.deepStrictEqual(ambiguities(code), [], label);
    // The text after the head is code, not the text of an element: its parenthesis is not blanked.
    assert.strictEqual(maskOf(code)[code.indexOf('(', at)], '(', `${label}: read as code`);
    assert.deepStrictEqual(strayPageRefs(code).map((found) => found.start), [code.indexOf('PAGEREF_detail')], `${label}: the token in the string is stray, and the call is not`);
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], label);
  }
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  for (const { code, at, label } of pages) {
    const source = cleanSourceFile(ts, code);
    assert.ok(source, `TypeScript parses ${label}`);
    assert.ok(!isElement(readingAt(ts, source, at)), `${label}: TypeScript reads no element there`);
  }
});

test('a signature whose type holds the closing tag in a string, a template or a comment is a guess, with the element read: nothing after it is trusted', (t) => {
  const pages = signaturePages(HIDING_ENDINGS);
  for (const { code, at, label } of pages) {
    assert.deepStrictEqual(earliestAmbiguity(code), [at, 'generic'], label);
    // Every token is refused, the string's and the call's, naming the guess.
    assert.deepStrictEqual(strayPageRefs(code).map((found) => found.frontier.kind), ['generic', 'generic'], label);
  }
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  for (const { code, at, label } of pages) {
    const source = cleanSourceFile(ts, code);
    assert.ok(source, `TypeScript parses ${label}`);
    assert.ok(!isElement(readingAt(ts, source, at)), `${label}: TypeScript reads a signature, which is why the guess is needed`);
  }
});

// After a signature's `)` TypeScript wants `,`, `;`, `}` or the end of the type, or the next token on a later line (parseTypeMemberSemicolon, canParseSemicolon); anything else on the line is TS1005. So where
// another token follows on the line, no signature stands there, and the text is an element, for certain, whatever else is in it. A closing tag directly after the `)` is one too: `</` is one token to the
// scanner in a .tsx file, and no member begins with it.
const SAME_LINE_FOLLOWERS = ['m: number', '<U>(y)', '(y)', '{ a }', '[k]', '.x', ' = 1', '?', '!', '+ 1', '/ 2', 'as T', '/* c */ m', '\u0085m', '\u00a0m', '\u200bm', '</T>', '</T> x', '< /T>'];
test('a parameter list that a token on its own line follows is an element, for certain: no signature has one there', (t) => {
  for (const follower of SAME_LINE_FOLLOWERS) {
    const sep = follower.startsWith(' ') || follower.startsWith('<') || follower.startsWith('/') || follower.startsWith('?') || follower.startsWith('!') || follower.startsWith('.') ? '' : ' ';
    assert.deepStrictEqual(opensTypeParameters(`<T>(x)${sep}${follower}`, 0), { generic: false, ambiguity: null }, JSON.stringify(follower));
  }
  // A closing tag after the `)` on a later line is the same, but a `</*` is a `<` and a comment, so the next line decides by what the text holds.
  for (const code of ['<T>(x)\n</T>', '<T>(x) /* c */ </T>', '<T>(x)\n\n  </T>', '<T>(x)\u2028</T>']) assert.deepStrictEqual(opensTypeParameters(code, 0), { generic: false, ambiguity: null }, JSON.stringify(code));
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  // TypeScript rejects each as a signature, and takes a line break of every kind, and a block comment that holds one, as the end of the member.
  for (const follower of SAME_LINE_FOLLOWERS) assert.ok(parseDiagnosticMessages(ts, `interface I { <T>(x) ${follower} }`).length > 0, `a signature followed by ${JSON.stringify(follower)} on its line`);
  for (const separator of ['\n', '\r', '\u2028', '\u2029', ' /* c\n */ ', ' // c\n', '; ', ', ']) assertTsParses(ts, `interface I { <T>(x)${separator}m: number }`, `a signature, then ${JSON.stringify(separator)}, then a member`);
  for (const separator of [' ', ' /* c */ ', '\u0085', '\u00a0']) assertTsRejects(ts, `interface I { <T>(x)${separator}m: number }`, /expected/i, `a signature, then ${JSON.stringify(separator)} and a member on the line`);
});

// The elements that stay certain: JSX text that starts with a parenthesis, in every place an element stands, wherever the lexer can tell. The token after the `)` or the closing tag the text reaches says so
// — and a container that holds a string (`{t("label")}`) is no obstacle.
test('JSX text that starts with a parenthesis is an element, for certain, wherever the token after the parenthesis or the closing tag the text reaches says so', (t) => {
  const pages = elementPages(CERTAIN_ELEMENTS);
  for (const { code, at, label } of pages) {
    assert.deepStrictEqual(ambiguities(code), [], label);
    // The text of the element is text, not code: its parenthesis is blanked.
    assert.notStrictEqual(maskOf(code)[code.indexOf('(', at)], '(', `${label}: read as an element`);
    assert.deepStrictEqual(strayPageRefs(code).map((found) => found.start), [code.indexOf('PAGEREF_detail')], `${label}: the token in the string is stray, and the call is not`);
    assert.deepStrictEqual(navReferencedKeys(code), ['detail'], label);
  }
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  for (const { code, at, label } of pages) {
    const source = cleanSourceFile(ts, code);
    assert.ok(source, `TypeScript parses ${label}`);
    assert.ok(isElement(readingAt(ts, source, at)), `${label}: TypeScript reads an element there`);
  }
});

test('JSX text that starts with a parenthesis is a guess where the closing tag could be inside a template, a comment or a regex that its text opens: the element is read, nothing after it is trusted', (t) => {
  const pages = elementPages(GUESSED_ELEMENTS);
  for (const { code, at, label } of pages) {
    assert.deepStrictEqual(earliestAmbiguity(code), [at, 'generic'], label);
    assert.notStrictEqual(maskOf(code)[code.indexOf('(', at)], '(', `${label}: read as an element`);
  }
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  for (const { code, at, label } of pages) {
    const source = cleanSourceFile(ts, code);
    assert.ok(source, `TypeScript parses ${label}`);
    assert.ok(isElement(readingAt(ts, source, at)), `${label}: TypeScript reads an element, so the guess is a cost`);
  }
});

// What the lexer says of `<Name>` and a parameter list that neither `=>` nor `:` follows, as the rule's verdict: an element for certain, code for certain, or a guess.
test('opensTypeParameters: a parameter list with no arrow and no colon after it is an element or a signature, for certain, or a guess where both compile', () => {
  const ELEMENT = { generic: false, ambiguity: null };
  const CODE = { generic: true, ambiguity: null };
  const GUESS = { generic: false, ambiguity: 'generic' };
  const rows = [
    ['<T>(x) }', CODE], ['<T>(x); }', CODE], ['<T>(x), }', CODE], ['<T>(x)\n}', CODE], ['<T>(x);\n  m: string }', CODE], ['<T>(x);\n  m: { a: string } }', CODE], ['<T>(x);\n  m: (a: T) => void }', CODE],
    ['<T>(x)\n  <U>(y) }', CODE], ['<T>(x); m: Array<string> }', CODE], ['<T>(x); m: Array<Array<string>> }', CODE], ['<T>(x);</U>', CODE], ['<T>(x);<b>y</c></T>', CODE], ['<T>(x),</>', CODE],
    // What follows a `/` is no closing tag unless it is a `<` that stands there: a name on the next line that a `/` follows is text, read to the `}` that ends the type.
    ['<T>(x)\n  m/n }', CODE], ['<T>(x)\n  1/2 }', CODE],
    // A `)` that a `<` or a closing tag follows, on its line or the next: no member of a type begins with `<` and a name, or with `</`, so it is an element whatever the text is.
    ['<T>(x)</U>', ELEMENT], ['<T>(x)<b>y</c></T>', ELEMENT], ['<T>(x)</>', ELEMENT], ['<T>(x)<U>(y)', ELEMENT], ['<T>(x)\n</U>', ELEMENT],
    ['<T>(optional)</T>', ELEMENT], ['<T>(x), y</T>', ELEMENT], ['<T>(x);\n</T>', ELEMENT], ["<T>(x), it's</T>", ELEMENT], ['<T>(x), "q" </T>', ELEMENT], ['<T>(x), {t("a")}</T>', ELEMENT],
    ['<T>(x), <b>y</b></T>', ELEMENT], ['<T>(x), <b>y</b> <c/></T>', ELEMENT], ['<T>(x),\n  <></>\n</T>', ELEMENT], ['<T>(x), <A.B>y</A.B></T>', ELEMENT], ['<T>(x),</ T>', ELEMENT], ['<T>(x), </T /* c */>', ELEMENT],
    // The text ends right after the `)`, or after white space and a line break: a page that was cut off, with nothing to read.
    ['<T>(x)', ELEMENT], ['<T>(x) ', ELEMENT], ['<T>(x)\n', ELEMENT],
    // The name of the closing tag is the head's, as the head spells it: a name that is a keyword with a type parameter after it. (A dotted name is no type parameter, so it is an element where it stands.)
    ['<A.B>(x), y</A.B>', ELEMENT], ['<const T>(x),\n</const>', ELEMENT], ['<const T>(x) }', CODE],
    ["<T>(x); m: '</T>'", GUESS], ['<T>(x); m: "a</T>b"', GUESS], ['<T>(x); m: `</T>`', GUESS], ['<T>(x); // </T>\n', GUESS], ['<T>(x); /* </T> */', GUESS],
    // The text is scanned as a type would scan it, as code: a `/` after a word or a number divides (and is an error in a type), a comment or a template that is closed before the closing tag
    // hides nothing, and a line comment that ends before it hides nothing; a comment that is open at the closing tag, or a `//` on its line, hides it.
    ['<T>(x), a/b</T>', ELEMENT], ['<T>(x), 1/2 done</T>', ELEMENT], ['<T>(x);\n  and/or more</T>', ELEMENT], ['<T>(x)\n  `x`</T>', ELEMENT], ['<T>(x); /* c */ </T>', ELEMENT], ['<T>(x); // c\n</T>', ELEMENT],
    ['<T>(x), see https://x.y</T>', ELEMENT], ['<T>(x); // c </T>', GUESS], ['<T>(x);\n  /* c </T>', GUESS], ['<T>(x); `a ${b} </T>', GUESS], ['<T>(x), = /re/ </T>', GUESS], ['<T>(x), return/exchange </T>', GUESS],
    // Where the text before the first thing that could hide the closing tag cannot be the members of a type — two names on a line, a name and a string or a `/` — no type holds the closing tag in anything:
    // an element. A name alone, a modifier, a name on the next line, a colon or a character that is no prose leaves both programs possible.
    ["<T>(x), see 'a </T> b'", ELEMENT], ['<T>(x), a b // </T>', ELEMENT], ['<T>(x); 1 2 // </T>', ELEMENT], ['<T>(x), see a/b // </T>', ELEMENT], ['<T>(x);\n  see https://x.y more\n  </T>', ELEMENT], ['<T>(x), a, b c // </T>', ELEMENT],
    ['<T>(x), a // </T>', GUESS], ['<T>(x), a\n  b // </T>', GUESS], ['<T>(x), readonly b // </T>', GUESS], ['<T>(x), get b // </T>', GUESS], ['<T>(x), public b // </T>', GUESS], ['<T>(x), see: https://x.y</T>', GUESS],
    ["<T>(x); 'a </T> b'", GUESS], ['<T>(x), a, // </T>', GUESS], ["<T>(x), it's // </T>", GUESS], ['<T>(x), é b // </T>', GUESS], ['<T>(x), a.b c // </T>', GUESS], ['<T>(x), a? b // </T>', GUESS],
    ['<T>(x); m: { <U>(y: U): void }', GUESS], ['<T>(x); m: { a / b }</T>', GUESS], ['<T>(x), </T c></T>', GUESS], ['<T>(x), </* c */T>', CODE], ['<T>(x);', GUESS], ['<T>(x), <b>y', GUESS],
    // A `</*` after the `)` is a `<`, a comment and a name: the next signature's type parameters, `</* c */T extends X>(y)`, which no closing tag is. (`</* c */T>` is one to the element reading.)
    ['<T>(x)\n</* c */T extends X>(y) }', CODE], ['<T>(x)\n</* c */T>(y)', CODE], ['<T>(x); </* c */T>(y) }', CODE], ['<T>(x)\n</ T>', ELEMENT], ['<T>(x)\n</ /* c */ T>', ELEMENT],
    // Without an end to the text, or a name for the head, there is no closing tag to find.
    ['< T>(x), y</T>', GUESS],
  ];
  for (const [code, expected] of rows) assert.deepStrictEqual(opensTypeParameters(code, 0), expected, JSON.stringify(code));
  // A parameter list that a `:` follows is still both, and one too long to scan.
  assert.deepStrictEqual(opensTypeParameters('<T>(x): T }', 0), GUESS);
  assert.deepStrictEqual(opensTypeParameters(`<T>(${'x, '.repeat(900)}x) }`, 0), GUESS);
});

// readChildren in closing mode, through elementChildren: the children of `<T>` read from its `>` to the closing tag of its own. `fails` is a text no element has, `closes` the closing tag found, `hidden` one that
// could be inside a string, a template, a comment or a regex that the text opens, and `unknown` a text this does not read.
test('elementChildren: the text of an element is read to its closing tag; a failure, a hidden closing tag and what is not read are told apart', (t) => {
  const kind = (read) => (read === null ? 'unknown' : read.fails !== undefined ? 'fails' : read.hideable ? 'hidden' : 'closes');
  const rows = [
    // A failure: a `}` or a `>` in the text, a container or a tag TypeScript rejects, a closing tag that is not the open element's.
    ['(x) }', 'fails'], ['(x); m: { a: string } }', 'fails'], ['(x) => y', 'fails'], ['(x) a > b</T>', 'fails'], ['(x)</U>', 'fails'], ['(x)<b>y</c></T>', 'fails'], ['(x)<b>y</T>', 'fails'], ['(x)</>', 'fails'],
    ['(x)<>y</T>', 'fails'], ['(x)<b x=1></b></T>', 'fails'], ['(x) <!-- c --></T>', 'fails'], ['(x)<b>y</b></b>', 'fails'], ['(x); m: Array<string> }', 'fails'], ['(x) { a: 1 }</T>', 'fails'],
    ['(x)<b x={a: 1}>y</b></T>', 'fails'], ['(x)<b {a}>y</b></T>', 'fails'], ['(x)<b x={"k"(y: 1)}/></T>', 'fails'],
    // A closing tag reached, with nothing that could hide it.
    ['(optional)</T>', 'closes'], ['(x), y</T>', 'closes'], ['(x)<b>y</b></T>', 'closes'], ['(x)<b/></T>', 'closes'], ['(x)<></></T>', 'closes'], ['(x)<A.B>y</A.B></T>', 'closes'], ['(x)</ T>', 'closes'],
    ['(x)</T /* c */>', 'closes'], ['(x) {y} </T>', 'closes'], ['(x) {t("a")} </T>', 'closes'], ['(x) {"}"} </T>', 'closes'], ["(x) {'}'}</T>", 'closes'], ["(x) {'it\\'s'}</T>", 'closes'], ['(x) {a ? "x" : "y"}</T>', 'closes'],
    ["(it's)</T>", 'closes'], ['(a) "q" </T>', 'closes'], ["(x) 'a' 'b' </T>", 'closes'], ["(x) 'a' </T> 'b'", 'closes'], ['(x)<b x="</T>">y</b></T>', 'closes'], ['(x)<b>y</b><c d="e"/>z</T>', 'closes'],
    ['(x)<b><c></c></b></T>', 'closes'], ['(x) < b>y</b></T>', 'closes'], ['(x)<b\n  x="1"\n>y</b></T>', 'closes'], ['(x)<T>y</T></T>', 'closes'], ["(x)<b>'y </b> z'</T>", 'closes'],
    // The `/` and the `>` of a self-closing tag are two tokens, with trivia between them: any other token after the `/` is TS1005, a self-closing tag opens no element, and a comment right after the
    // tag's last token is not read.
    ['(x)<b / ></T>', 'closes'], ['(x)<b /\n></T>', 'closes'], ['(x)<b / /* c */ ></T>', 'closes'], ['(x)<b x="1" / ></T>', 'closes'], ['(x)<b / // c\n></T>', 'closes'], ['(x)<b x / ></T>', 'closes'],
    ['(x)<b / /* > */ ></T>', 'closes'], ['(x)<b / x></T>', 'fails'], ['(x)<b / ></b></T>', 'fails'], ['(x)<b /* c */ ></T>', 'unknown'], ['(x)<b // c\n></T>', 'unknown'], ['(x)<b / /* c ></T>', 'unknown'],
    // An attribute whose value is an expression container, a spread, an object: skipped as a container in the text is, with the strings and the braces in it.
    ['(x)<b x={1}>y</b></T>', 'closes'], ['(x)<b {...p}/></T>', 'closes'], ['(x)<b x = {1}>y</b></T>', 'closes'], ['(x)<Icon name={icon} /></T>', 'closes'], ['(x)<b\n  x={1}\n  y="2"\n/></T>', 'closes'],
    ['(x)<b x={1} {...p} y="2"/></T>', 'closes'], ['(x)<b {...p}<T>>y</b></T>', 'fails'], ['(x)<b x={1}<T>>y</b></T>', 'fails'], ['(x)<b {.5: 1}>y</b></T>', 'fails'], ['(x)<b {...`t`}/></T>', 'unknown'],
    ['(x)<b style={{ color: "red" }}>y</b></T>', 'closes'], ['(x)<b x={a ? "}" : 1} /></T>', 'closes'], ['(x)<b x={{ a: "}" }}>y</b></T>', 'closes'], ['(x)<b x={t("</T>")}>y</b></T>', 'closes'],
    ['(x) {{ a: 1 }} </T>', 'closes'], ['(x) {{ a: "}" }} </T>', 'closes'], ['(x) {a ? { b: 1 } : c} </T>', 'closes'], ['(x) {() => { return "}"; }} </T>', 'closes'], ['(x) {() => 1} </T>', 'closes'], ['(x) {{ a }} </T>', 'closes'],
    // A comment right after the last name of a bracket or a call is part of its run: the colon after it fails the container, and without one the container is skipped.
    ['(x) { [a/* c */]: T } </T>', 'fails'], ['(x) { m(a/* c */): T } </T>', 'fails'], ['(x) { [K in keyof T/* c */]: T } </T>', 'fails'], ['(x) { m(a,b// c\n): T } </T>', 'fails'],
    ['(x) { [a/* c */] } </T>', 'closes'], ['(x) { m(a/* c */) } </T>', 'closes'],
    // The closing tag could be inside a string that the text opens and closes after it, a template, a comment or a regex.
    ["(x) 'a </T> b'</T>", 'hidden'], ['(x) "a </T> b"</T>', 'hidden'], ['(x) // c </T>', 'hidden'], ['(x) /* c </T> */', 'hidden'], ['(x) /* c </T>', 'hidden'], ['(x) `a </T> b`</T>', 'hidden'],
    ['(x) `a </T>', 'hidden'], ['(x) `a ${b} </T>', 'hidden'], ['(x) `a\\` </T> b`</T>', 'hidden'], ["(x) 'a /* </T> */ b'</T>", 'hidden'], ['(x) // it\'s "a </T>', 'hidden'],
    // A comment that no end is in sight for hides the closing tag even after a word, where a lone `/` would divide; so does a template with a `${` that is closed before it.
    ['(x) a // c </T>', 'hidden'], ['(x) a /* c </T>', 'hidden'], ['(x) 1 // c </T>', 'hidden'], ['(x) a /* c */ b </T>', 'closes'], ['(x) `a ${b} c` </T>', 'hidden'], ['(x) `a ${b} c` d </T>', 'hidden'],
    // A `/` that no regex may start at, a comment or a template that is closed before the closing tag, and a line comment that ends before it, hide nothing: the closing tag is in code.
    ['(x) a/b</T>', 'closes'], ['(x) 1/2 </T>', 'closes'], ['(x) a / b </T>', 'closes'], ['(x) a\n/b </T>', 'closes'], ['(x) $/y </T>', 'closes'], ['(x) _/y </T>', 'closes'], ['(x) a//b\n</T>', 'closes'],
    ['(x) `t` </T>', 'closes'], ['(x) `a\\`b` </T>', 'closes'], ['(x) `a` `b` </T>', 'closes'], ['(x) /* c */ </T>', 'closes'], ['(x) /* a */ /* b */ </T>', 'closes'], ['(x) // c\n</T>', 'closes'], ['(x) // c\r\n</T>', 'closes'],
    ['(x) // c\u2028</T>', 'closes'], ["(x) /* ' */ </T> '", 'closes'], ['(x) // c\n// d\n</T>', 'closes'], ['(x) a/ /* c */ b </T>', 'closes'], ['(x) a/* c */b </T>', 'closes'],
    // A `/` after anything else may begin a regex, which a type holds in a default value or a computed name, and the closing tag may be in it: a `)`, an operator, a keyword, a bracket, a quote, a tag, a letter beyond ASCII.
    ['(x) = /re/ </T>', 'hidden'], ['(x) (a) /b </T>', 'hidden'], ['(x) return/exchange </T>', 'hidden'], ['(x) [a] /b </T>', 'hidden'], ['(x) , /b </T>', 'hidden'], ['(x) é/y </T>', 'hidden'], ['(x)<b>y</b> /z </T>', 'hidden'],
    ['(x) typeof /b </T>', 'hidden'], ["(x) 'a' /b </T>", 'hidden'], ['(x) /* c */ /b </T>', 'hidden'], ['(x) /b </T>', 'hidden'], ['(x) {y} /b </T>', 'hidden'],
    ["(x)<b>'y </b> z </T> w'</T>", 'hidden'], ["(x) 'a' 'b </T>\n", 'closes'],
    // `</` and a comment is a `<` and a comment to a type, the type parameters of the next signature, and TS1003 to an element; with white space between, it is a closing tag to both.
    ['(x)</* c */T>', 'fails'], ['(x)\n</* c */T>', 'fails'], ['(x)</ /* c */ T>', 'closes'], ['(x)</ T>', 'closes'], ['(x)<b></ /* c */ b></T>', 'closes'], ['(x)<b></* c */b></T>', 'fails'],
    // Strings: one that ends right where the closing tag starts holds nothing of it; a quote inside a string is not the start of another; a quote right after a word that is no keyword is an apostrophe or an
    // inch mark, and after a keyword (`readonly'a'`, `keyof'a'`, `in'a'`) it opens a string, as it does after anything else.
    ["(x)'a'</T>", 'closes'], ['(x) "a \'b" </T> \'c\'', 'closes'], ["(x) it's </T> 'b'", 'closes'], ['(x) 5" wide </T> "b"', 'closes'], ["(x) readonly'a </T> b'", 'hidden'], ["(x) keyof'a </T> b'", 'hidden'],
    ["(x) in'a </T> b'", 'hidden'], ["(x) of'a </T> b'", 'hidden'], ["(x) café's </T> 'b'", 'hidden'], ["(x) it's (it's </T> 'b'", 'closes'], ["(x) it'a </T> b'c", 'closes'],
    // Not read: a container with a regex, a division or a template, an unread closing tag, a closing tag with a comment in the opening, text that ends first, a string that no line closes in a
    // container, braces that are not closed, an attribute container with a `<`, a template or a regex. (A container with a comment is skipped, with the comment: a `}` in it is no end.)
    ['(x) {a / b}</T>', 'unknown'], ['(x) {`t`}</T>', 'unknown'], ['(x) </T c></T>', 'unknown'], ['(x)', 'unknown'], ['(x) <b>y', 'unknown'],
    ['(x) {/* c */}</T>', 'closes'], ['(x) {/* } */}</T>', 'closes'], ['(x) {a /* } */ }</T>', 'closes'], ['(x) {// }\n}</T>', 'closes'], ['(x) {/* c }</T>', 'unknown'],
    ['(x) {"a}</T>', 'unknown'], ['(x) < /T>', 'unknown'], ['(x) <1></T>', 'unknown'], ['(x)<a-b></a-b></T>', 'unknown'], ['(x)<a:b></a:b></T>', 'unknown'],
    ['(x) {{ a: 1 } </T>', 'unknown'], ['(x) {{ a: `t` }} </T>', 'unknown'], ['(x)<b x={a < b}>y</b></T>', 'unknown'], ['(x)<b x={`t`} /></T>', 'unknown'], ['(x)<b x={/re/} /></T>', 'unknown'], ['(x)<b x={<c/>} /></T>', 'unknown'],
  ];
  for (const [text, expected] of rows) assert.strictEqual(kind(elementChildren(`<T>${text}`, 3, 'T')), expected, JSON.stringify(text));
  // An element whose name is not known cannot tell its closing tag from another, and the window is LOOKAHEAD characters.
  assert.strictEqual(elementChildren('<T>(x)</T>', 3, null), null);
  assert.strictEqual(kind(elementChildren('<T>(x)<b>y</b></T>', 3, null)), 'unknown');
  assert.strictEqual(kind(elementChildren(`<T>(x)${' '.repeat(2100)}</T>`, 3, 'T')), 'unknown');
  assert.strictEqual(kind(elementChildren(`<T>(x)${' '.repeat(1900)}</T>`, 3, 'T')), 'closes');
  // A closing tag that the window ends inside of is not read: the last position it can end at is the window's own.
  assert.strictEqual(kind(elementChildren(`<T>(x)${' '.repeat(1994)}</T>`, 3, 'T')), 'closes');
  assert.strictEqual(kind(elementChildren(`<T>(x)${' '.repeat(1995)}</T>`, 3, 'T')), 'unknown');
  // The trivia after the `/` of a tag that runs to the end of the window leaves the `>` out of sight, and what stands past it is not read.
  assert.strictEqual(kind(elementChildren(`<T>(x)<b /${' '.repeat(2100)}x`, 3, 'T')), 'unknown');
  assert.strictEqual(kind(elementChildren(`<T>(x)<b /${' '.repeat(2100)}></T>`, 3, 'T')), 'unknown');
  // A quote that no quote closes before the end of the window may open a string that holds the closing tag; where the source ends first, or a line break does, it is an apostrophe.
  assert.strictEqual(kind(elementChildren(`<T>(x) 'b </T>${' '.repeat(2100)}'`, 3, 'T')), 'hidden');
  assert.strictEqual(kind(elementChildren(`<T>(x) 'b </T>${' '.repeat(2100)}`, 3, 'T')), 'hidden');
  assert.strictEqual(kind(elementChildren(`<T>(x) 'b </T>\n${' '.repeat(2100)}'`, 3, 'T')), 'closes');
  assert.strictEqual(kind(elementChildren("<T>(x) 'b </T>", 3, 'T')), 'closes');
  // Where it closes, it is at the `>` of the closing tag.
  const text = '<T>(x)<b>y</b> z</T> after';
  assert.strictEqual(elementChildren(text, 3, 'T').closes, text.indexOf('</T>') + 3);
  // The reading is TypeScript's: where it says the text fails, TypeScript has a diagnostic for the element, and where it says the closing tag is reached with nothing hidden, the element compiles.
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  for (const [body, expected] of rows) {
    const element = `<T>${body}`;
    if (expected === 'fails') assert.ok(parseDiagnosticMessages(ts, `const e = ${element};`).length > 0, `TypeScript rejects ${JSON.stringify(body)} as the text of an element`);
    // The text after the closing tag that the reading reaches is no part of the element.
    if (expected === 'closes') assertTsParses(ts, `declare const y: any, t: any;\nconst e = ${element.slice(0, elementChildren(element, 3, 'T').closes + 1)};`, `TypeScript parses ${JSON.stringify(body)} as an element`);
  }
});

// A string in a container is skipped exactly where there is a closing tag to find (containerEndWithStrings), and still stops the container reading where there is an arrow (elementFailsAt): the
// verdicts of the arrow reading are the fuzz's, and none of them changes. The braces that a container holds are counted there too, outside the strings, so an object or a block in one is skipped whole.
test('a container that holds a string or braces is skipped, exactly, when the text is read to its closing tag, and is not read when it is read to an arrow', () => {
  for (const container of ['{t("label")}', '{"a}"}', "{'it\\'s'}", '{"a\\"}"}', '{a ? "x" : "y"}', '{"a" + \'b\'}', '{x["k"]}', '{"}" + "}"}', '{"a" + {}}', '{{ a: 1 }}', '{{ a: "}" }}', '{() => { return "}"; }}', '{{ a: { b: "{" } }}']) {
    assert.strictEqual(elementChildren(`<T>(x) ${container} </T>`, 3, 'T').closes, `<T>(x) ${container} </T>`.indexOf('</T>') + 3, container);
  }
  for (const container of ['{"a}', "{'a}\n'}", '{"a" / 2}', '{"a" + `b`}', '{"a" /* c */}', '{{ a: 1 }', '{{ "a": `b` }}', '{{ a: "}" }']) assert.strictEqual(elementChildren(`<T>(x) ${container} </T>`, 3, 'T'), null, container);
  // A quoted name and a colon, a call and a colon, still fail, as they did.
  for (const container of ['{"a": T}', "{'m'(x: T): T}", '{"m"(): T}']) assert.ok(elementChildren(`<T>(x) ${container} </T>`, 3, 'T').fails !== undefined, container);
  // In an arrow reading a quoted name that no colon follows, a brace, and an attribute's container are not read, as before.
  const quoted = '<T>(x: { "k" }) => T';
  assert.strictEqual(elementFailsAt(quoted, 3, quoted.indexOf('=>')), -1);
  const named = '<T>(x: { a: { "k" } }) => T';
  assert.strictEqual(elementFailsAt(named, 3, named.indexOf('=>')), named.indexOf(':', 8));
  for (const text of ['<T>(x: {{ a: 1 }}) => T', '<T>(x: <b x={1}>y</b>) => T', '<T>(<b {...p}/>) => T']) assert.strictEqual(elementFailsAt(text, 3, text.indexOf('=>')), -1, text);
});

// A signature in a type is read to the `}` that ends the type, and the next signature in it is read to the same `}`: k signatures cost k times the type, up to the window, so a pass has a budget of
// characters to read (elementChildren), and a reading that finds it spent says nothing, which is the guess.
test('a spent reading budget is a guess: the signature is read as the element it may be, and nothing after it is trusted', () => {
  const budget = { left: 10 };
  assert.deepStrictEqual(opensTypeParameters('<T>(x); m: string }', 0, budget), { generic: true, ambiguity: null });
  assert.ok(budget.left < 0, 'the reading spent the budget');
  assert.deepStrictEqual(opensTypeParameters('<T>(x); m: string }', 0, budget), { generic: false, ambiguity: 'generic' });
  // A reading that is not asked for a budget has none.
  assert.deepStrictEqual(opensTypeParameters('<T>(x); m: string }', 0), { generic: true, ambiguity: null });
  // A budget of nothing is spent, and one of a character is not.
  assert.strictEqual(elementChildren('<T>(x) }', 3, 'T', { left: 0 }), null);
  assert.deepStrictEqual(elementChildren('<T>(x) }', 3, 'T', { left: 1 }), { fails: 7 });
});

test('a reading spends the budget by the characters it reads, from the `>` of its head to where it fails, closes or ends', () => {
  const spent = (src, name = 'T') => {
    const budget = { left: 1000 };
    elementChildren(src, 3, name, budget);
    return 1000 - budget.left;
  };
  assert.strictEqual(spent('<T>(x); m: string }'), 16);            // fails at the `}`, index 18: 18 - 3 + 1
  assert.strictEqual(spent('<T>(x)\n  more text\n</T>'), 20);      // closes at the `>` of the closing tag, index 22
  assert.strictEqual(spent(`<T>(x); ${'a '.repeat(100)}`), 205);   // the text ends, and the last character is index 207
  // The budget reaches the rule, whatever asks it: the rule, and the reading of a head after a token that is guessed at.
  const budget = { left: 100 };
  opensTypeParameters('<T>(x); m: string }', 0, budget);
  assert.strictEqual(budget.left, 84);
});

// The budget of a pass is a share of its source and a base: fifty signatures in one type each read the rest of it, which is quadratic in the type and which the base covers; thousands of small types
// in a long source read a few characters each, which the share covers. A page of types of a hundred signatures each reads each type forty thousand characters over, and spends the budget after a few
// of them: the signatures after that are a guess (`generic`), and the pass does not go on reading them.
test('a pass has a budget in proportion to its source: a type of fifty signatures and a long page of small types are read with no guess, and a page of large ones spends it', () => {
  assert.deepStrictEqual(ambiguities(`interface I { ${'<T>(x); '.repeat(50)}}\n`), []);
  assert.deepStrictEqual(ambiguities('interface I { <T>(a); <T>(b); <T>(c); <T>(d); <T>(e); <T>(f) }\n'.repeat(6000)), []);
  const heavy = `interface I { ${'<T>(x); '.repeat(100)}}\n`;
  assert.deepStrictEqual(ambiguities(heavy.repeat(2)), []);
  assert.deepStrictEqual([...new Set(ambiguities(heavy.repeat(60)).map(([, kind]) => kind))], ['generic']);
});

// A head with a constraint and no parameter list is an element after a guess token (headWithoutParameterList) because the tag reading of the head and the type-parameter reading of it end at
// the same `>`. That fails where the head holds a string that the two read to different ends: an attribute's value is a JSX string, which has no escapes and ends at the next quote, and a type
// parameter's default is a JavaScript string, which has them.
//   let f:A<X>=<T extends X="\">">(x)=>x;           TypeScript: an arrow whose type parameter has the default `"\">"`; the lexer's tag ends at the `>` after `"\"`
//   const s='</T>;navigateTo({ … });//';             … so the `</T>` of this string closed an element that was never there, and the call after it was code
// A head that holds a backslash is not decided by the tag reading; every other way the two readings could end apart is no head the tag reading accepts (comments, a nested `<`, a `=>`, a character
// beyond ASCII outside a string) or ends the same (a string without a backslash).
const HEAD_GUESS_CONTEXTS = [
  ['let f:A<X>=', 'operator'], ['let f: A<X>= ', 'operator'], ['const k = a >= ', 'operator'], ['v >>= ', 'operator'], ['v >>>= ', 'operator'], ['const k = x as A<B>>= ', 'operator'],
  ['const k = x as A<B<C>>>= ', 'operator'], ['v >>>>= ', 'operator'], ['const k = a < ', 'operator'], ["const k = 'a' in ", 'operator'], ['void\n', 'newline'],
  ['function* g() { yield * ', 'operator'], ['let n = 0; n = ++ ', 'operator'],
];
test('a head that holds a backslash is not decided by the tag reading: a string in a type parameter\'s default ends elsewhere, so the guess stays', () => {
  for (const [before, kind] of HEAD_GUESS_CONTEXTS) {
    // The two strings end apart: the JSX string `"\"` ends at the escaped quote, the JavaScript string at the quote after `>`. The head the tag reading finds ends early, so whatever follows
    // it — a parameter list and an arrow, JSX text, an arrow with a return type — is not what follows the head.
    for (const string of ['"\\">"', "'\\'>'", '"a\\">b"']) {
      for (const tail of ['(x)=>MARK', 'MARK</T>', '(MARK)', '(x): MARK => 1']) {
        const code = `${before}<T extends X=${string}>${tail};\n${CALL_IN_A_STRING}\n`;
        assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf('<T'), kind], JSON.stringify(code));
      }
    }
    // The two strings end together, but a backslash is a head that is not decided: where nothing follows that proves the head type parameters the guess stands. (A parameter list and an arrow
    // that the element reading cannot hold prove it, with or without a backslash: a head that cannot be an element is type parameters whatever stands before it.)
    for (const string of ['"\\\\"', '"a\\nb"', '"\\u003e"', '"\\\n"']) {
      for (const tail of ['MARK</T>', '(MARK)', '(x): MARK => 1']) {
        const code = `${before}<T extends X=${string}>${tail};\n${CALL_IN_A_STRING}\n`;
        assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf('<T'), kind], JSON.stringify(code));
      }
      const arrow = `${before}<T extends X=${string}>(x)=>MARK;\n${CALL_IN_A_STRING}\n`;
      assert.deepStrictEqual(ambiguities(arrow), [], JSON.stringify(arrow));
    }
  }
  // The page that held the failure, whole: the lexer reads an element, its text runs to the `</T>` in the string, and the call after that is code — all after the guess.
  const held = `let f:A<X>=<T extends X="\\">">(x)=>x;\n${CALL_IN_A_STRING}\n`;
  assert.deepStrictEqual(earliestAmbiguity(held), [held.indexOf('<T'), 'operator']);
  assert.ok(maskOf(held).includes('navigateTo'), 'read as the tag reads it, the call is code, which is why the guess is needed');
  assert.deepStrictEqual(strayPageRefs(held).map((r) => [r.token, r.frontier.kind]), [['PAGEREF_detail', 'operator']], 'and its token is refused, naming the guess');
});

test('a head with a string that has no backslash, and every other head the tag reading accepts, is an element after a guess token; one it does not accept is a guess', () => {
  const certain = [
    // A string ends at the same quote in both readings, whatever it holds.
    '<T extends X=">">MARK</T>', "<T extends X='>'>MARK</T>", '<T extends X="a">MARK</T>', '<T extends X="=>">MARK</T>', '<T extends X="//">MARK</T>', '<T extends X="/*">MARK</T>',
    '<T extends X="é">MARK</T>', '<T extends X="">MARK</T>', '<T extends X=\'"\'>MARK</T>', '<T extends X="\'">MARK</T>', '<T extends X ="a">MARK</T>', '<T extends X="a"Y="b">MARK</T>',
    // A raw line break in a string is an unterminated string in a type, so only the element parses.
    '<T extends X="a\nb">MARK</T>',
    // White space and line breaks between the tokens of a head are the same in both readings.
    '<T extends X>MARK</T>', '<T\nextends\nX>MARK</T>', '<T\textends X >MARK</T>', '<T extends X/>', '<T extends X />',
  ];
  for (const [before] of HEAD_GUESS_CONTEXTS) {
    for (const head of certain) {
      const code = `${before}${head};${REGEX_STATEMENT}\n`;
      assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
      assert.ok(!maskOf(code).includes('MARK') && !maskOf(code).includes('navigateTo'), `the element is read, and the regex after it is data: ${JSON.stringify(code)}`);
    }
  }
  // A head the tag reading does not accept proves nothing, and the guess stands: a comment (so a `>` in one is no end), a character beyond ASCII between its tokens, a string after white space
  // (TypeScript reads it as a JavaScript string with escapes, and the tag reading leaves it undecided).
  for (const [before, kind] of HEAD_GUESS_CONTEXTS) {
    for (const head of ['<T extends X /* c */>MARK</T>', '<T extends X /* > */>MARK</T>', '<T extends\u00a0X>MARK</T>', '<T extends X // c\n>MARK</T>', '<T extends X= "a">MARK</T>']) {
      const code = `${before}${head};${REGEX_STATEMENT}\n`;
      assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf('<T'), kind], JSON.stringify(code));
    }
  }
});

// A `<` after a postfix `!` or `++`, an optional chain, or a cast is no expression start: a comparison or type arguments, and the regex after it is data.
test('a "<" after a postfix "!" or "++", an optional chain, a cast or a property named like a keyword is a comparison or type arguments: the regex after it is data, and nothing is guessed', () => {
  for (const before of [
    'const k = f!<string>("a");', 'const k = a! < b;', 'let q = 0; const k = q++ < b;', 'const k = f?.<string>("a");', 'const k = (a as any) < b;',
    // A property is not the keyword: `map.delete<string>(key)` is a call with type arguments.
    'const k = map.delete<string>("a");', 'const k = a.typeof < b;', 'const k = a.void < b;', 'const k = a.in < b;', 'const k = a.instanceof < b;', 'const k = a?.delete<string>("a");',
  ]) {
    const code = `${before}${REGEX_STATEMENT}\n`;
    assert.ok(!maskOf(code).includes('navigateTo'), `the regex is data: ${JSON.stringify(code)}`);
    assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
  }
});

// Where an assignment expression starts, the rule decides: a generic arrow is code. Each token the table calls `rule`, with a program that has it.
const ARROW = '<T extends X>(x: T) => MARK';
const RULE_FRAMES = {
  '=>': `const k = () => ${ARROW};`, ',': `f(a, ${ARROW});`, ';': `a; ${ARROW};`, ':': `const k = a ? b : ${ARROW};`, '?': `const k = a ? ${ARROW} : b;`,
  '(': `f(${ARROW});`, ')': `if (a) ${ARROW};`, '[': `const k = [${ARROW}];`, '{': `{ ${ARROW}; }`, '}': `if (a) { b } ${ARROW};`,
  return: `function g() { return ${ARROW}; }`, throw: `function g() { throw ${ARROW}; }`, case: `switch (a) { case ${ARROW}: break; }`, default: `export default ${ARROW};`,
  else: `if (a) b; else ${ARROW};`, do: `do ${ARROW}; while (a);`, yield: `function* g() { yield ${ARROW}; }`, of: `for (const k of ${ARROW}) {}`,
  new: `type A = new ${ARROW};`, extends: `type A = B extends ${ARROW} ? 1 : 2;`, break: `for (;;) { break\n${ARROW}; }`, continue: `for (;;) { continue\n${ARROW}; }`,
};
// A `}` is the `brace` guess and the keywords `yield` and `of` the `keyword` guess, each reported before the table is asked — where the text after the `<` may be an element. A head that
// cannot be one (the arrow here) is type parameters whatever stands before it, so nothing is reported (elementReadingFails).
const REPORTED_BEFORE_THE_TABLE = { '}': 'brace', yield: 'keyword', of: 'keyword' };
const ASSIGNMENT_TOKENS = new Set(['=', '+=', '-=', '*=', '**=', '/=', '%=', '<<=', '&=', '|=', '^=', '&&=', '||=', '??=']);
test('where an assignment expression starts a "<" is decided by the TSX rule: a generic arrow is code, after each token that can start one', () => {
  for (const token of ANGLE_AFTER.rule) {
    const frame = RULE_FRAMES[token] || (ASSIGNMENT_TOKENS.has(token) ? `v ${token} ${ARROW};` : null);
    assert.ok(frame, `a program for ${token}`);
    const code = `${frame}\n`;
    assert.ok(maskOf(code).includes('MARK'), `a generic arrow, whose body is code: ${JSON.stringify(code)}`);
    assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
    // Where the text after the `<` may be an element, the guess about the token before it is reported, before the table is asked.
    if (REPORTED_BEFORE_THE_TABLE[token]) {
      const elementish = frame.replace(ARROW, '<T extends X>MARK</T>');
      assert.deepStrictEqual(earliestAmbiguity(`${elementish}\n`), [elementish.indexOf('<T'), REPORTED_BEFORE_THE_TABLE[token]], JSON.stringify(elementish));
    }
  }
  // The start of the source begins an expression: nothing stands before the `<`.
  const first = `${ARROW};\n`;
  assert.ok(maskOf(first).includes('MARK'), 'a generic arrow at the start of the source is code');
  assert.deepStrictEqual(ambiguities(first), []);
  // A `>` that does not end `=>` is the `angle` guess, reported once before the table is asked: the table adds nothing at the same offset.
  const compared = `const k = a > <T extends X>MARK</T>;${REGEX_STATEMENT}\n`;
  assert.deepStrictEqual(ambiguities(compared), [[compared.indexOf('<T'), 'angle']]);
  // A `>` that follows an `=` is the one the position leaves unreported (an arrow's `=>` is certain), so the token's own class reports it: `<=` and `>`, `==` and `>` and `=>` and `>` are
  // programs TypeScript rejects and no page depends on them, but "every `>` before a `<` is reported" then holds for the text, whatever produced the `>`.
  for (const run of ['<=>', '==>', '!=>', '===>', '!==>', '=>>']) {
    const text = `const k = a ${run} <T extends X>MARK</T>;${REGEX_STATEMENT}\n`;
    assert.deepStrictEqual(ambiguities(text), [[text.indexOf('<T'), 'angle']], JSON.stringify(text));
  }
});

// The operator before the `<` is read as TypeScript's scanner reads one — a run of sign characters, the longest operator first, a `>` on its own — and the LAST
// token decides. [code, what the lexer reads at the `<T`, what TypeScript reads there]: `element` and `generic` (code) are certain, a kind is a guess, and the
// element is read.
const BEFORE_ANGLE_CASES = [
  ['const k = a === <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a===<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a !== <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a==!<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a===-<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a&&!<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a<=<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a << <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a ?? <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = typeof<T extends X>MARK</T>;', 'element', 'JsxElement'],
  // The `>` that closes type arguments or a tag is a token of its own, so what follows it is its own operator.
  ['const k = x as A<B>==<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = <p/>==<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = <p/>===<T extends X>MARK</T>;', 'element', 'JsxElement'],
  // A non-null assertion, then an assignment: the `=` is its own token (`!=` is the comparison, and no arrow follows it).
  ['x! = <T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['v ??= <T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['v&&=<T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['v=<T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['const k = () =><T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  // The end of type arguments and an initialiser, or a comparison with an element: both compile where the text after the `<` may be either, and where it cannot be an element — a comma, a
  // default, a parameter list and an arrow — it is type parameters whatever stands before it, so there is nothing to guess. So do a shift assignment and the end of nested type arguments, and
  // the end of a cast's type arguments and a comparison — the parser takes the first `>` for the closer where it can, and the lexer cannot tell that `>` from the first of a shift. A head with
  // a constraint and no parameter list is an element after any of them (as an initialiser it is an arrow with no parameters, an error); a parameter list and a colon after it keep the guess.
  ['let x: A<number>= <T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['let x: A<A<number>>= <T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['v >>= <T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['v >>>= <T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['let x: A<number>= <T extends X>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['const k = x as A<B>>= <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = x as A<B>>=<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = x as A<B<C>>>= <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = x satisfies A<B>>= <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a >= <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = x as A<B>>= <T extends X>(y: T): MARK</T>;', 'operator', 'JsxElement'],
  ['const k = x as A<B<C>>>= <T extends X>(y: T): MARK</T>;', 'operator', 'JsxElement'],
  ['const k = a >= <T extends X>(y: T): MARK</T>;', 'operator', 'JsxElement'],
  ['let x: A<number>= <T extends X>(y: T): T => MARK;', 'operator', 'ArrowFunction'],
  // After `<`, `in` and `void` and a line break, a head with a constraint and no parameter list is an element in every program that parses: nothing is guessed.
  ['const k = a < <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['f< <T>(x: T) => MARK>();', 'generic', 'FunctionType'],
  ["const k = 'a' in <T extends X>MARK</T>;", 'element', 'JsxElement'],
  ['for (const k in <T,>(x: T) => MARK) {}', 'generic', 'ArrowFunction'],
  ['let x: void\n<T,>(y: T) => MARK;', 'generic', 'ArrowFunction'],
  ['void\n<T extends X>MARK</T>;', 'element', 'JsxElement'],
  // A parameter list and a colon after the head is JSX text or an arrow's return type, and both compile: the guess.
  ['const k = a < <T extends X>(x: T): MARK</T>;', 'operator', 'JsxElement'],
  ["const k = 'a' in <T extends X>(x: T): MARK</T>;", 'operator', 'JsxElement'],
  ['void\n<T extends X>(x: T): MARK</T>;', 'newline', 'JsxElement'],
  ['void <T extends X>MARK</T>;', 'element', 'JsxElement'],
  // A `/` the lexer read as the division operator: its operand is a unary expression, so an element whatever follows the name. (After the end of a regex or an element the lexer asks nothing: a
  // `<` there is a comparison.)
  ['const k = a / <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a /<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = f(x) / <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = a /\n<T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = /x/ / <T extends X>MARK</T>;', 'element', 'JsxElement'],
  ['const k = <p/> / <T extends X>MARK</T>;', 'element', 'JsxElement'],
];
test('the token before a "<", scanned as TypeScript scans operators, decides what the "<" opens', () => {
  for (const [code, lexer] of BEFORE_ANGLE_CASES) {
    const found = ambiguities(code);
    if (lexer === 'element' || lexer === 'generic') {
      assert.deepStrictEqual(found, [], code);
      assert.strictEqual(maskOf(code).includes('MARK'), lexer === 'generic', `${lexer}: ${code}`);
    } else {
      assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf('<T'), lexer], code);
      assert.ok(!maskOf(code).includes('MARK'), `the element is read: ${code}`);
    }
  }
});

test('the table of tokens before a "<" is a partition: no token twice, every guess has a kind the lexer reports, and an unknown token is a guess', () => {
  const all = [...ANGLE_AFTER.element, ...Object.keys(ANGLE_AFTER.guess), ...ANGLE_AFTER.rule];
  assert.deepStrictEqual(all.filter((token, i) => all.indexOf(token) !== i), [], 'a token is in one class only');
  // The classes as the oracle test below verified them against TypeScript's parser. A token moved or dropped changes what the lexer reads after it, so a change
  // here is a change to be verified there (without the oracle, this is what stops it from slipping by).
  assert.deepStrictEqual([...ANGLE_AFTER.element].sort(), ['!', '!=', '!==', '%', '&', '&&', '*', '**', '+', '-', '/', '<<', '<=', '==', '===', '^', 'await', 'delete', 'instanceof', 'typeof', 'void', '|', '||', '~', '??'].sort());
  assert.deepStrictEqual(ANGLE_AFTER.guess, { '>=': 'operator', '>>=': 'operator', '>>>=': 'operator', '<': 'operator', in: 'operator' });
  assert.deepStrictEqual([...ANGLE_AFTER.rule].sort(), [
    '=', '+=', '-=', '*=', '**=', '/=', '%=', '<<=', '&=', '|=', '^=', '&&=', '||=', '??=', '=>', ',', ';', ':', '?', '(', ')', '[', '{', '}',
    'return', 'throw', 'case', 'default', 'else', 'do', 'yield', 'of', 'new', 'extends', 'break', 'continue',
  ].sort());
  assert.deepStrictEqual(ANGLE_AFTER_LINE_BREAK, { void: 'newline' });
  for (const kind of [...Object.values(ANGLE_AFTER.guess), ...Object.values(ANGLE_AFTER_LINE_BREAK)]) assert.ok(AMBIGUITY_KINDS.includes(kind), `a kind the lexer reports: ${kind}`);
  for (const token of Object.keys(ANGLE_AFTER_LINE_BREAK)) assert.ok(all.includes(token), `${token}: a token the table classifies`);
  assert.ok([ANGLE_AFTER, ANGLE_AFTER.element, ANGLE_AFTER.guess, ANGLE_AFTER.rule, ANGLE_AFTER_LINE_BREAK].every((table) => Object.isFrozen(table)), 'the table is not edited by a caller');
  // A sign run the table has no entry for — `++` before a `<` is not valid, so no program has it — is a guess, and where the rule would read a generic it is
  // reported; an element is an element either way.
  assertAmbiguous('operator', [[`let n = 0; n = ++ <T extends X>(x: T): MARK</T>;${REGEX_STATEMENT}`, '<T extends'], ['v >>>>= <T extends X>(x: T): MARK</T>;', '<T extends']]);
  assertCertain(['let n = 0; n = ++ <div>MARK</div>;', 'v >>>>= <T,>(y: T) => MARK;', 'let n = 0; n = ++ <T extends X>MARK</T>;', 'v >>>>= <T extends X>MARK</T>;']);
});

// ─── The tokens before a `<`, checked against TypeScript ─────────────────────────────────────────────────────────────

// RESERVED_WORDS is what TypeScript refuses as the first name after the `<`: its reserved words, with `const` read apart, as a modifier. Every other keyword is an
// identifier to it, `await` and `yield` outside the contexts that reserve them.
test('RESERVED_WORDS is the set of words TypeScript does not read as an identifier after a "<"', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const kinds = ts.SyntaxKind;
  const reserved = [];
  for (let kind = kinds.FirstReservedWord; kind <= kinds.LastReservedWord; kind += 1) reserved.push(ts.tokenToString(kind));
  assert.deepStrictEqual([...RESERVED_WORDS].sort(), reserved.filter((word) => word !== 'const').sort(), 'the reserved words, but `const`');
  for (let kind = kinds.FirstKeyword; kind <= kinds.LastKeyword; kind += 1) {
    const word = ts.tokenToString(kind);
    if (!word || word === 'const') continue;
    const code = `const f = <${word},>(x) => x;`;
    const at = code.indexOf('<');
    const reading = readingAt(ts, cleanSourceFile(ts, code) || ts.createSourceFile('snippet.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX), at);
    if (RESERVED_WORDS.has(word)) {
      assert.ok(isElement(reading), `${word}: not an identifier, so an element`);
      assert.deepStrictEqual(opens(code), ELEMENT, word);
    } else if (word === 'await' || word === 'yield') {
      assert.strictEqual(reading, 'ArrowFunction', `${word}: an identifier outside the context that reserves it`);
      assert.deepStrictEqual(opens(code), { generic: false, ambiguity: 'generic' }, `${word}: a guess, since the context is not tracked`);
    } else {
      assert.strictEqual(reading, 'ArrowFunction', `${word}: an identifier`);
      assert.deepStrictEqual(opens(code), GENERIC, word);
    }
  }
  // The contexts that reserve the two words: an element there, where outside them the same text is an arrow.
  for (const [code, reading] of [
    ['async function p() { const e = <await extends SomeType>text</await>; return e; }', 'JsxElement'],
    ['function p() { const e = <await extends SomeType>(x: await) => x; return e; }', 'ArrowFunction'],
    ['function* g() { const e = <yield extends SomeType>text</yield>; return e; }', 'JsxElement'],
    ['const element = <Wrapper>(<Child x="\\" y=") =>" />)</Wrapper>;', 'JsxElement'],
  ]) {
    const source = cleanSourceFile(ts, code);
    assert.ok(source, `TypeScript parses it: ${code}`);
    assert.strictEqual(readingAt(ts, source, code.indexOf('<')), reading, code);
  }
});

// The same question for the first name after the `<`: the rule asks whether it is an identifier, which for `await` and `yield` depends on the function around them.
// Every keyword, in every kind of function that can reserve one: wherever TypeScript reads an element, the lexer reads one or reports that it is guessing.
test('the first name after a "<": wherever TypeScript reads an element, the lexer reads one or reports the guess, for every keyword in every function', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const kinds = ts.SyntaxKind;
  const words = ['T'];
  for (let kind = kinds.FirstKeyword; kind <= kinds.LastKeyword; kind += 1) if (ts.tokenToString(kind)) words.push(ts.tokenToString(kind));
  const contexts = {
    'a function': 'function p() { const e = @; return e; }',
    'an async function': 'async function p() { const e = @; return e; }',
    'a generator': 'function* p() { const e = @; return e; }',
    'an async generator': 'async function* p() { const e = @; return e; }',
    'an async arrow': 'const p = async () => { const e = @; return e; };',
    'a module': 'export {}; const e = @;',
    'a script': 'const e = @;',
  };
  const shapes = {
    'an element with a constraint': (word) => `<${word} extends X>MARK</${word}>`,
    'an element named so': (word) => `<${word}>MARK</${word}>`,
    'a generic arrow with a comma': (word) => `<${word},>(x) => MARK`,
    'a generic arrow with a default': (word) => `<${word} = string>(x) => MARK`,
    'a generic arrow with a constraint': (word) => `<${word} extends X>(x) => MARK`,
  };
  const problems = [];
  let valid = 0;
  const readings = new Map();
  for (const word of words) {
    for (const [context, frame] of Object.entries(contexts)) {
      for (const [shape, build] of Object.entries(shapes)) {
        const text = build(word);
        const code = `${frame.replace('@', text)}${REGEX_STATEMENT}`;
        const source = cleanSourceFile(ts, code);
        if (!source) continue;
        valid += 1;
        const at = code.indexOf(text);
        const reading = readingAt(ts, source, at);
        readings.set(`${word}/${context}`, new Set([...(readings.get(`${word}/${context}`) || []), isElement(reading) ? 'element' : 'generic']));
        const found = [];
        const mask = blankNonCodePreservingTemplateExpressions(code, { onAmbiguity: (offset, kind) => found.push([offset, kind]) });
        const guessed = found.some(([offset]) => offset <= at);
        if (isElement(reading) && (mask.includes('navigateTo') || mask.includes('MARK')) && !guessed) problems.push(`TypeScript reads an element, the lexer reads code with no guess: ${word} in ${context}, ${shape}: ${JSON.stringify(code)}`);
      }
    }
  }
  assert.ok(valid > 300, `only ${valid} programs were valid, so the check proves little`);
  // The premise: `await` is an element in an async function and an identifier elsewhere, and `yield` likewise in a generator — which is why it is a guess.
  assert.deepStrictEqual([...readings.get('await/an async function')], ['element'], 'await in an async function');
  assert.ok(readings.get('await/a function').has('generic'), 'await outside one');
  assert.deepStrictEqual([...readings.get('yield/a generator')], ['element'], 'yield in a generator');
  assert.ok(readings.get('yield/a function').has('generic'), 'yield outside one');
  assert.deepStrictEqual(problems, [], 'an element read as code hides the regex after it from every check');
});

// The rule's tokens, against TypeScript: whatever stands after the first name, valid or not, TypeScript decides by the tokens alone (a program it rejects still gets
// the node it decided on: an arrow, or an element), so every third token, and every fourth after `extends`, is compared — including the ones that merely look
// like the ones in the rule (`=>` and `==` are not `=`, `/=` is not `/`, and a `>` is one token however much follows it).
test('the TSX rule as read here agrees with TypeScript on every token after the first name, whatever it is', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const tokens = [',', '=', '==', '===', '=>', '/', '/=', '>', '>=', '>>', '>>=', ':', '?', '.', '...', '[', '(', '{', '}', ')', '+', '*', 'extends', 'in', 'x', '1', '"s"', '`t`', '<', ';', '!'];
  const snippets = [];
  for (const head of ['<T', '<const T']) {
    for (const third of tokens) {
      snippets.push(`${head} ${third} y`, `${head}${third} y`);
      if (third === 'extends') for (const fourth of tokens) snippets.push(`${head} extends ${fourth} y`, `${head} extends${fourth} y`);
    }
  }
  const mismatches = [];
  for (const snippet of snippets) {
    const code = `const f = ${snippet}>(x) => x;`;
    const at = code.indexOf('<');
    const reading = readingAt(ts, ts.createSourceFile('snippet.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX), at);
    const ours = opensTypeParameters(code, at);
    if (ours.ambiguity) continue;
    if (ours.generic !== (reading === 'ArrowFunction')) mismatches.push(`${JSON.stringify(snippet)}: here ${ours.generic ? 'a generic arrow' : 'an element'}, TypeScript ${reading}`);
  }
  assert.deepStrictEqual(mismatches, []);
  assert.ok(snippets.length > 200, `${snippets.length} snippets`);
});

test('TypeScript reads each hand-picked "<" as the table says, and the lexer reads it by the same class', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  for (const [code, , reading] of BEFORE_ANGLE_CASES) {
    const source = cleanSourceFile(ts, code);
    assert.ok(source, `TypeScript parses it: ${JSON.stringify(code)}`);
    assert.strictEqual(readingAt(ts, source, code.indexOf('<T')), reading, JSON.stringify(code));
  }
});

// Every punctuator and keyword TypeScript has is either in the table, with the class TypeScript's own parse of it supports, or on the list of tokens that the
// table is never asked about — and a token that is on neither fails here, so a new token cannot arrive unclassified. Each token is put in front of a `<` in
// every frame (tests/helpers/angle-frames.js): as an operand of an operator, in a head, after a line break, in a type. TypeScript says which programs are
// valid and what it reads at the `<`:
//   element   an element in some program, and a generic never in an expression
//   guess     an element in one program and a generic or a type's `<` in another
//   rule      an element in no program, and a generic in some
// The lexer is checked on the same programs, whatever the table says: it must never read the text of an element as code — which hides the regex after it from
// every check and rewrites the token in it — without reporting a guess, nor read a generic arrow in an expression as an element.
const OUTSIDE_THE_TABLE = {
  // Read before the table is asked, and reported there: a `>` may close type arguments, a JSX tag or compare (`angle`). (A `/` is asked: after a division it begins an operand that is a unary
  // expression, so an element; after the end of a regex the lexer knows an operand ended, and asks nothing.)
  reported: ['>', '>>', '>>>'],
  // A member dot, a spread and an optional chain: read by the position table (a `...` is the `operator` guess).
  member: ['.', '...', '?.'],
  operand: [']'],
  // No program in which a `<` follows them is valid.
  none: ['</', '++', '--', '@', '`', '#', 'import', 'infer', 'keyof', 'readonly', 'unique'],
  // Words that end an operand or begin a declaration: a `<` after one is a comparison, type arguments or the start of a statement that ASI began, which is
  // the `newline` guess. (TypeScript reads a type name after a declaration word with no syntax error, as in `let x: catch`, which is no program.)
  words: [
    'catch', 'class', 'const', 'debugger', 'enum', 'export', 'false', 'finally', 'for', 'function', 'if', 'null', 'super', 'switch', 'this', 'true', 'try', 'var', 'while', 'with',
    'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'abstract', 'accessor', 'as', 'asserts', 'assert', 'any', 'async', 'boolean',
    'constructor', 'declare', 'get', 'intrinsic', 'is', 'module', 'namespace', 'never', 'out', 'require', 'number', 'object', 'satisfies', 'set', 'string', 'symbol', 'type',
    'undefined', 'unknown', 'using', 'from', 'global', 'bigint', 'override',
  ],
};
test('every punctuator and keyword TypeScript has is classified, and each class is how TypeScript reads a "<" after it', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it');
  const classOf = new Map();
  for (const [cls, tokens] of [['element', ANGLE_AFTER.element], ['guess', Object.keys(ANGLE_AFTER.guess)], ['rule', ANGLE_AFTER.rule]]) {
    for (const token of tokens) classOf.set(token, cls);
  }
  const outside = new Map();
  for (const [group, tokens] of Object.entries(OUTSIDE_THE_TABLE)) for (const token of tokens) outside.set(token, group);
  const vocabulary = tokenVocabulary(ts);
  assert.deepStrictEqual(vocabulary.filter((token) => !classOf.has(token) && !outside.has(token)), [], 'a token with no class: add it to the table, or say why the table is never asked about it');
  assert.deepStrictEqual(vocabulary.filter((token) => classOf.has(token) && outside.has(token)), [], 'a token in the table and on the list outside it');
  assert.deepStrictEqual([...classOf.keys(), ...outside.keys()].filter((token) => !vocabulary.includes(token)), [], 'a token TypeScript does not have');
  let clean = 0;
  let programs = 0;
  const problems = [];
  for (const token of vocabulary) {
    const seen = { jsx: false, jsxAfterBreak: false, code: false, codeAfterBreak: false, codeInExpression: false, clean: 0 };
    for (const program of programsFor(token)) {
      programs += 1;
      const source = cleanSourceFile(ts, program.code);
      if (!source) continue;
      clean += 1;
      seen.clean += 1;
      const reading = readingAt(ts, source, program.at);
      const element = isElement(reading);
      if (program.continuation === 'element') {
        if (element) { seen.jsx = true; if (program.separator === 'newline') seen.jsxAfterBreak = true; }
      } else if (!element) {
        seen.code = true;
        if (program.separator === 'newline') seen.codeAfterBreak = true;
        if (program.frame.role === 'expression') seen.codeInExpression = true;
      }
      // The lexer on the same program.
      const found = [];
      const mask = blankNonCodePreservingTemplateExpressions(program.code, { onAmbiguity: (at, kind) => found.push([at, kind]) });
      const guessed = found.some(([at]) => at <= program.at);
      const readAsElement = !mask.includes('MARK');
      const where = `${JSON.stringify(token)} in ${program.frame.name}, ${program.separator}, ${program.continuation}: ${JSON.stringify(program.code)}`;
      if (program.continuation === 'element' && element && !readAsElement && !guessed) problems.push(`the text of an element is read as code: ${where}`);
      if ((program.continuation === 'arrowComma' || program.continuation === 'arrowExtends') && reading === 'ArrowFunction' && program.frame.role === 'expression' && readAsElement && !guessed) {
        problems.push(`a generic arrow is read as an element, with no guess: ${where}`);
      }
    }
    const cls = classOf.get(token);
    const group = outside.get(token);
    if (cls === 'element' || cls === 'guess') assert.ok(seen.jsx, `${token}: ${cls}, but TypeScript reads no element after it in any program`);
    if (cls === 'element') assert.strictEqual(seen.codeInExpression, false, `${token}: element, but TypeScript reads a generic after it in an expression`);
    if (cls === 'guess') assert.ok(seen.code, `${token}: guess, but TypeScript reads nothing but an element after it`);
    if (cls === 'rule') {
      assert.strictEqual(seen.jsx, false, `${token}: rule, but TypeScript reads an element after it`);
      assert.ok(seen.code, `${token}: rule, but TypeScript reads no generic or type after it in any program`);
    }
    if (token === 'void') {
      assert.ok(seen.jsxAfterBreak && seen.codeAfterBreak, 'void: an element, or a type that a line break ended and an arrow after it: both compile after a line break');
      assert.strictEqual(ANGLE_AFTER_LINE_BREAK.void, 'newline');
    }
    if (group === 'none') assert.strictEqual(seen.clean, 0, `${token}: listed as never valid before a "<", but a program is`);
    if (group === 'reported') assert.ok(seen.jsx, `${token}: listed as reported before the table is asked, but TypeScript reads no element after it`);
    if (group === 'words' || group === 'member' || group === 'operand') assert.strictEqual(seen.jsx, false, `${token}: an element after it, so the table must be asked`);
  }
  t.diagnostic(`${vocabulary.length} tokens, ${programs} programs, ${clean} valid to TypeScript`);
  assert.ok(clean > 1500, `only ${clean} programs were valid, so the check proves little`);
  assert.deepStrictEqual(problems, [], 'the lexer must read what TypeScript reads at a "<", or say that it is guessing');
});

// ─── A `/` and a `>` of a tag are two tokens ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// TypeScript scans the `/` of a self-closing tag and its `>` as tokens of their own, with trivia of every kind between them (parseJsxOpeningOrSelfClosingElementOrOpeningFragment). A lexer that knew only an adjacent `/>`
// read `<B / >` as an opening tag, took the text after it for the text of an element, and found its closing tag in a string after it: the call in the string was read as code.
const TAG_DECOY = `const s = '</B></A></C>></A>;${READ_CALL};//'; const re = /${READ_CALL}/; ${READ_CALL};`;
const TAG_GAPS_UNIT = [' ', '\n', '\r\n', '\t', '\v', '\f', '\r', '\u0085', '\u00a0', '\u1680', '\u2003', '\u200b', '\u2028', '\u2029', '\u202f', '\u3000', '\ufeff', ' /* c */', ' /* > */ ', ' /**/', ' // c\n', ' // </B> >\n', ' /* c\n */', ' \n /* c */ // d\n '];
const TAG_SHAPES_UNIT = [
  '<B /@>', '<B x="1" /@>', "<B x='1' y={2} /@>", '<B.C /@>', '<B {...p} /@>', '<B<T> /@>', '<B x /@>',
  '<A x=<B /@>/>', '<A x=<B /@> />', '<A x=<B /@>>t</A>', '<A x=<B x="1" /@>>t</A>', '<A x=<B /@> y=<C /@>/>', '<A x=<B y=<C /@>/> />',
  '<A><B /@></A>', '<A>t<B /@>u<C /@></A>', '<A>{<B /@>}</A>', '<A>(a)<B /@></A>',
];
test('a self-closing tag ends at its ">" whatever stands between its "/" and the ">": the closing tag in a string after it closes nothing, and the call in it is data', () => {
  for (const gap of TAG_GAPS_UNIT) {
    for (const shape of TAG_SHAPES_UNIT) {
      const element = shape.replaceAll('@', gap);
      for (const code of [`const e = ${element};\n${TAG_DECOY}\n`, `f(${element});\n${TAG_DECOY}\n`, `const p = <p>{${element}}</p>;\n${TAG_DECOY}\n`]) {
        assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
        const mask = maskOf(code);
        assert.strictEqual(mask.split('navigateTo(').length - 1, 1, `only the real call is code: ${JSON.stringify(code)}`);
        assert.ok(mask.trimEnd().endsWith(';') && mask.lastIndexOf('navigateTo(') > mask.indexOf('const re'), `the real call is the last statement and is code: ${JSON.stringify(code)}`);
      }
    }
  }
  // The slash is a token on its own: a `//` or a `/*` right after it is a comment, which is trivia too, and a `/` with another token between it and the `>` is an error that no page has.
  assertCertain([`const e = <B //c\n/>;\n${TAG_DECOY}\n`, `const e = <B /*c*/ />;\n${TAG_DECOY}\n`, `const e = <B /* / */>t</B>;\n${TAG_DECOY}\n`]);
  // The element is a whole operand of code: a `/` or a `<` after it is a division or a comparison, wherever the `/` and the `>` of its tag stand.
  assertCertain([`const n = <B / > / 2; const re = /${READ_CALL}/; ${READ_CALL};`, `const n = <B /\n> < 2; const re = /${READ_CALL}/; ${READ_CALL};`, `const n = <A x=<B / >/> / 2; const re = /${READ_CALL}/; ${READ_CALL};`]);
  for (const code of [`const n = <B / > / 2; const re = /${READ_CALL}/; ${READ_CALL};`, `const n = <A x=<B /\n>/> / 2; const re = /${READ_CALL}/; ${READ_CALL};`]) assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, code);
  // A `/` with another token after it before any `>` is no end of a tag: TypeScript reports the `>` missing (TS1005), so no page has one, and a head with one provably is no element (readTag).
  assert.deepStrictEqual(elementFailsAt('(<b /x>) => T', 0, '(<b /x>) => T'.lastIndexOf('=>')), '(<b /'.length);
  const ts = loadTypescriptOracle();
  if (!ts) return;
  for (const gap of TAG_GAPS_UNIT) for (const shape of TAG_SHAPES_UNIT) {
    const code = `declare const f: any, p: any;\nconst e = ${shape.replaceAll('@', gap)};\n${TAG_DECOY}\n`;
    assert.deepStrictEqual(parseDiagnosticMessages(ts, code), [], `TypeScript parses ${JSON.stringify(code)}`);
  }
});

// ─── The name of a closing tag ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// `a:b` is the identifier `a`, a colon and the identifier `b`, each a token with trivia and comments around it, and `A.B` the same with a dot (parseJsxElementName, parseJsxTagName): a name that has a colon is no
// property access, and one with dots has no colon. The lexer read an adjacent colon only, took `</a :b>` for a tag it could not read, and went on at the first `>` with a guess (`jsx-open`).
test('the name of a closing tag is read as TypeScript reads it: a colon or a dot with trivia and comments around it', () => {
  const gaps = ['', ' ', '\n', '\t', '\u0085', '\u00a0', '\u2028', '/* c */', ' /* c */ ', '/**/', '// c\n', ' // > </a:b>\n', ' /* > */ '];
  const names = [['a', ':', 'b'], ['a-b', ':', 'c-d'], ['A', ':', 'B'], ['A', '.', 'B'], ['A', '.', 'B', '.', 'C'], ['this', '.', 'x'], ['a'], ['a-b'], ['_a$', ':', 'b1']];
  for (const gap of gaps) {
    for (const parts of names) {
      for (const lead of ['', gap]) {
        const open = `<${parts.join('')}>`;
        const code = `const e = ${open}x</${lead}${parts.join(gap)}${gap}>;\nconst s = '</${parts.join('')}>;${READ_CALL};//'; ${READ_CALL};\n`;
        assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
        assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, `the string is data and the real call is code: ${JSON.stringify(code)}`);
      }
    }
  }
  // What a name cannot be: a colon after dots, dots after a namespace name, a second colon, nothing after a separator, a name beyond a keyword. An error to TypeScript, so no page has one; the lexer does not read the tag
  // (`jsx-open`) and takes its first `>` as it always did.
  for (const name of ['A.B:c', 'a:b.c', 'a:b:c', 'a:', 'a.', 'a. >', ':a', '.a', 'a b', 'a:1']) {
    const code = `const e = <A>x</${name}>;\nconst s = '</A>;${READ_CALL};//'; ${READ_CALL};\n`;
    assert.deepStrictEqual(earliestAmbiguity(code), [code.indexOf('</'), 'jsx-open'], JSON.stringify(code));
  }
  // A page cut off inside the name is cut off, not unread.
  for (const cut of ['const e = <a:b>x</a', 'const e = <a:b>x</a:', 'const e = <a:b>x</a :', 'const e = <a.b>x</a.', 'const e = <a:b>x</a /* c */']) assert.strictEqual(endsMidStatement(cut), true, JSON.stringify(cut));
  assert.strictEqual(endsMidStatement('const e = <a:b>x</a :b>;'), false);
});

// ─── The flags of a regex ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// TypeScript's scanner takes every identifier part after the closing slash as part of the literal, a valid flag or not (reScanSlashToken): `/x/in` is one literal, and an unknown flag is the checker's error. The lexer stopped
// at the slash, read `in` as a keyword, and the `/` after it as the start of a regex that held the real one — and a regex that holds the text of a call, as data, was read as code.
test('the flags of a regex are part of the literal, whatever they spell: a "/" or "<" after it is a division or a comparison, on its line and the next, with no guess', () => {
  const flags = ['', 'g', 'gimsuyd', 'v', 'is', 'in', 'instanceof', 'if', 'of', 'as', 'satisfies', 'typeof', 'return', 'yield', 'await', 'x1', '$', '_', '1', 'é', '\u200d', '\u200c', '\u{1d49c}', 'ab\u200cc'];
  for (const flag of flags) {
    for (const continuation of [' / 2', '/2', '\n/ 2', ' /* c */ / 2', ' < 2', '\n< 2', ' <b', ' / /y/ / 2', ' / <T extends X>text</T>', '\u0085/ 2']) {
      const code = `const n = /x/${flag}${continuation}; const re = /${READ_CALL}/; ${READ_CALL};`;
      assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
      assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, `the regex is data, the real call is code: ${JSON.stringify(code)}`);
    }
  }
  // An escape is no identifier part: it ends the literal, and the backslash is an identifier written with an escape (an error to TypeScript, so no page has one).
  assertAmbiguous('identifier', [['const n = /x/\\u0067 / 2; const re = /y/;', '\\u0067']]);
  // The literal ends where the flags do, so what follows is read from there: a name after a space is no flag, a `.` is no flag, and a quote is no flag.
  assertCertain(['const n = /x/g .source;', "const n = /x/.test('a');", 'const n = /x/g\n.source;', 'const n = [/x/g, /y/i];', 'const n = f(/x/g, /y/);']);
  for (const code of ['const n = /x/ in o; const re = /y/;', 'const n = /x/ instanceof F; const re = /y/;']) assert.deepStrictEqual(ambiguities(code), [], code);
  // An unterminated regex has no flags, and a regex that does not close on its line is a division.
  assert.strictEqual(endsMidStatement('const n = /x'), true);
  const ts = loadTypescriptOracle();
  if (!ts) return;
  for (const flag of flags) assert.deepStrictEqual(parseDiagnosticMessages(ts, `const n = /x/${flag} / 2;`), [], `TypeScript parses a regex with the flags ${JSON.stringify(flag)}`);
  assert.ok(parseDiagnosticMessages(ts, 'const n = /x/\\u0067 / 2;').length > 0, 'TypeScript rejects an escape after the closing slash');
});

// ─── The closer of a cast ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// After `as` or `satisfies` TypeScript parses a type, so `A<B>` there is a name and type arguments and the token after their `>` continues an expression: a `/` divides and a `<` compares (parseBinaryExpressionRest). The lexer
// reads that for certain where the keyword is one — after an operand that ends for certain, with no line break before it, no dot, no reserved word — and reports the `>` (`angle`) where it may be a name.
test('the closer of a cast is read for certain: a "/" after it divides and a "<" compares, on its line and the next, and the regex after it is data', () => {
  const casts = [
    'x as A<B>', 'x satisfies A<B>', 'x as A<B<C>>', 'x as A<B<C<D>>>', 'x as A.B<C>', 'x as A<B, C>', 'x as A<B[]>', 'x as A<B | C>', 'x as A<{ a: B }>', 'x as A<() => B>', 'x as A<B>[]', 'x as A<B>[][]', 'x as A<B>[number]',
    'x as A<B> | C', 'x as C | A<B>', 'x as A<B> & C', 'x as | A<B>', 'x as C | D | A<B>', 'x as "a" | A<B>', 'x as -1 | A<B>', 'x as A extends B ? C : D<E>', 'x as number', 'x as A', 'x as A[]', 'x as A | B', 'x as "a"',
    'f(x) as A<B>', 'x! as A<B>', '(x) as A<B>', 'a.b as A<B>', 'a?.b as A<B>', 'a[0] as A<B>', '1 as A<B>', '"s" as A<B>', '`t` as A<B>', 'this as A<B>', 'null as A<B>', 'true as A<B>', 'x++ as A<B>', 'new A() as A<B>',
    '/re/ as A<B>', '<b/> as A<B>', '[1] as A<B>', 'x as unknown as A<B>', 'x as A<B> as C<D>', 'x as A<B> satisfies C<D>', '(x as A<B>) as C<D>', 'x ?? y as A<B>', '-x as A<B>', 'x as\n  A<B>',
    'a.class as A<B>', 'a.as as A<B>', 'x as A<B> as C<D> as E<F> as G<H>',
  ];
  const continuations = [' / 2', '/2', '\n/ 2', ' /* c */ / 2', ' / /y/ / 2', ' < 2', '\n< 2', ' <c>d', ' > /y/.test(z)', ' >> 1', ' >>> /y/.test(z)', ' > <b>t</b>', ' && /y/.test(z)', ' ? /y/.test(z) : 1'];
  let met = 0;
  for (const cast of casts) {
    for (const continuation of continuations) {
      // A line break after a cast whose type ends in a name or a bracket is the `newline` guess, as after any operand: only a closer is known to end a cast's type.
      if (continuation.startsWith('\n') && !cast.endsWith('>')) continue;
      const code = `const k = ${cast}${continuation}; const re = /${READ_CALL}/; ${READ_CALL};`;
      assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
      assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, `the regex is data and the real call is code: ${JSON.stringify(code)}`);
      met += 1;
    }
  }
  assert.ok(met >= 600, `${met} programs`);
  // Where the keyword is no keyword, or the walk cannot reach it, the `>` is a guess, as it was: a line break before it (`as` starts a statement), a property, a name after an operator, a label, a type operator the walk does not
  // read, a type that is parenthesized, an `as` too far back, a closer that no cast holds.
  assertAmbiguous('angle', [
    ['const k = x\nas A<B> / 2; const re = /y/;', '/ 2; const re'], ['const k = x.as A<B> / 2; const re = /y/;', '/ 2; const re'], ['const k = x?.as A<B> / 2; const re = /y/;', '/ 2; const re'],
    ['const as = 1; const k = as | A<B> / 2; const re = /y/;', '/ 2; const re'], ['const as = 1; let k; k = as & A<B> / 2; const re = /y/;', '/ 2; const re'], ['const as = 1; const k = [as, A<B> / 2]; const re = /y/;', '/ 2]'],
    ['as: for (;;) { break as\nA<B> / 2; } const re = /y/;', '/ 2; }'], ['function f() { return as\nA<B> / 2; } const re = /y/;', '/ 2; }'], ['const k = x as keyof A<B> / 2; const re = /y/;', '/ 2; const re'],
    ['const k = x as typeof y<B> / 2; const re = /y/;', '/ 2; const re'], ['const k = x as (A<B>) > /y/.test(z);', '/y/.test'], ['const k = x as readonly A<B>[] > /y/.test(z);', '/y/.test'],
    ['const k = f<A> / 2; const re = /y/;', '/ 2; const re'], ['const k = a > /y/.test(z);', '/y/.test'], ['const k = x as Types . Alias<B> / 2; const re = /y/;', '/ 2; const re'],
    ['const k = x as A<B>> /y/.test(z);', '/y/.test'], ['const k = x as A<B>>> /y/.test(z);', '/y/.test'],
    // A word that ends in `as` is the keyword only where nothing cuts it short, and a type that ends before the `>` is no proof where the keyword is a name (`as` alone on its line is a statement of its own).
    ['const k = xéas A<B> / 2; const re = /y/;', '/ 2; const re'], ['const k = x\nas\nA > /y/.test(z);', '/y/.test'], ['const k = x\nsatisfies\nA<B> > /y/.test(z);', '/y/.test'],
  ]);
  // A closer followed by an operator of its own is that operator: the `>` of a cast's type and a `>` that stands after it, with a space between, are two tokens; with none, a run the first of which may end the type arguments.
  assertCertain(['const k = x as A<B> > /y/.test(z);', 'const k = x as A<B> >> /y/.test(z);', 'const k = x as A<B> >>> /y/.test(z);', 'const k = x as A<B>[] > /y/.test(z);', 'const k = x as A<B> | C > /y/.test(z);', 'const k = x as number > /y/.test(z);',
    'const k = x as A<B> > <b>t</b>;', 'const k = x as A<B>[] >> <b>t</b>;', 'const k = <b/> > /y/.test(z);', 'const k = /x/ > /y/.test(z);', 'const k = /x/g >> <b>t</b>;', 'const k = x satisfies A<B> | C & D > /y/.test(z);']);
  assertAmbiguous('angle', [['const k = a > > /y/.test(z);', '/y/.test'], ['const k = x as A<B>, c > /y/.test(z);', '/y/.test'], ['const k = x as keyof A > /y/.test(z) ? 1 : 2;', '/y/.test']]);
  // The chain of casts is walked back a bounded number of links: one that is longer is not certain.
  const chain = (n) => `const k = x${' as A<B>'.repeat(n)} / 2; const re = /y/;`;
  assert.deepStrictEqual(ambiguities(chain(4)), []);
  assert.deepStrictEqual(ambiguities(chain(7)), []);
  assert.strictEqual(ambiguities(chain(12)).length, 1, 'a chain of twelve casts is past the limit');
  // A long run of `>` operators is read to a bounded depth: a recursion as deep as the run would overflow the stack, and the source is untrusted.
  assert.doesNotThrow(() => ambiguities(`const k = x ${'> '.repeat(20000)}/ 2; const re = /y/;`));
  assert.doesNotThrow(() => ambiguities(`const k = x${' as A<B>'.repeat(5000)} / 2; const re = /y/;`));
  const ts = loadTypescriptOracle();
  if (!ts) return;
  // TypeScript reads each of the certain casts as the lexer does: it parses, and the one real call is the call that remains.
  for (const cast of casts) for (const continuation of [' / 2', ' < 2', ' > /y/.test(z)', '\n/ 2']) {
    const code = `declare const x: any, y: any, z: any, f: any, a: any, A: any, B: any, C: any, D: any, E: any, F: any, G: any, H: any;\nconst k = ${cast}${continuation}; const re = /${READ_CALL}/; ${READ_CALL};`;
    const diagnostics = parseDiagnosticMessages(ts, code);
    if (diagnostics.length === 0) assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, JSON.stringify(code));
  }
});

// ─── The text of an element that starts with a parenthesis: the type that could be read from the same text ────────────────────────────────────────────────
//
// The text up to the closing tag is scanned as the type would scan it, as code, and what could hide the closing tag is a string, a template or a comment that is open at it, or a regex that may start (slashFollowsAnOperand). Before
// the first of those, the text must be what a type could hold for its members — a name, a `,` or a `;`, a name and then its own type — or no type holds the closing tag in anything (typeMembersFail).
test('typeMembersFail: text that no type can hold as its members leaves no type for a closing tag to be hidden in', () => {
  const closes = (text, typeFrom) => {
    const read = elementChildren(`<T>${text}`, 3, 'T', null, typeFrom);
    return read === null ? 'unknown' : read.fails !== undefined ? 'fails' : read.hideable ? 'hidden' : 'closes';
  };
  // After the `)` of `(x)`, at 6 in `<T>(x)…`.
  const rows = [
    // Two names on a line, a name and a `/`, a name and a string or a template: no type has them. Nothing after them hides a closing tag.
    ['(x), see https://x.y</T>', 'closes'], ['(x), a b // c </T>', 'closes'], ['(x); 1 2 // c </T>', 'closes'], ['(x), see a/b // c </T>', 'closes'], ["(x), see 'a </T> b'", 'closes'], ['(x), see `a </T> b`', 'closes'],
    ['(x), see "a </T> b"', 'closes'], ['(x); and/or more // c </T>', 'closes'], ['(x), a/b // c </T>', 'closes'],
    ['(x), a, b c /* </T> */ d</T>', 'closes'], ['(x);\n  see https://x.y more\n  </T>', 'closes'], ['(x), a_1 $b // c </T>', 'closes'],
    // A name alone, a modifier, a name on the next line, a colon, a bracket, a character beyond ASCII or anything that is no plain prose leaves both programs possible: a comment, a template or a string that is open at the closing tag hides it.
    ['(x), a // c </T>', 'hidden'], ['(x), a\n  b // c </T>', 'hidden'], ['(x), readonly b // c </T>', 'hidden'], ['(x), get b // c </T>', 'hidden'], ['(x), new b // c </T>', 'hidden'], ['(x), public b // c </T>', 'hidden'],
    ['(x), declare b // c </T>', 'hidden'], ['(x), a: b // c </T>', 'hidden'], ['(x), a? b // c </T>', 'hidden'], ['(x), [a] b // c </T>', 'hidden'], ['(x), é b // c </T>', 'hidden'], ['(x), a.b c // c </T>', 'hidden'],
    ["(x), it's // c </T>", 'hidden'], ['(x); // c </T>', 'hidden'], ['(x);\n  /* c </T>', 'hidden'], ['(x); `a ${b} </T>', 'hidden'], ["(x); 'a </T> b'", 'hidden'], ['(x), = /re/ </T>', 'hidden'], ['(x), a, // c </T>', 'hidden'],
    ['(x), a\n  see https://x.y </T>', 'closes'], ['(x),\n  a\n  b\n  // c </T>', 'hidden'], ['(x), 1\n  2 // c </T>', 'hidden'],
  ];
  for (const [text, expected] of rows) assert.strictEqual(closes(text, 6), expected, JSON.stringify(text));
  // Without the position of the type's members there is no type to ask about: the same texts are guesses wherever something could hide the closing tag.
  assert.strictEqual(closes('(x), see https://x.y</T>', -1), 'hidden');
  assert.strictEqual(closes('(x), a b // c </T>', -1), 'hidden');
  // ... and nothing is read from the start of the source: text before the head is no member of any type.
  const noType = elementChildren('a b<T>(x) // c </T>', 6, 'T');
  assert.strictEqual(noType.hideable, true);
  assert.strictEqual(noType.closes, 18);
  // Something that could hide the closing tag inside the parameter list itself is asked of nothing: the type is alive up to there.
  assert.strictEqual(closes('(x: "</T>"), a b</T>', 6), 'hidden');
  assert.strictEqual(closes('(x /* </T> */) a b</T>', 6), 'hidden');
});

// What a closing tag that a string, a template or a comment in the parameter list holds is, in `interface I { <T>(x: "</T>") }`: a call signature, and `const e = <T>(x: "</T>;` is an element: both parse with no diagnostic. So a
// closing tag in the parameter list is a guess, and one that no string, template or comment holds is an element for certain, as it is after the parameter list.
test('a parameter list that holds its own closing tag in a string, a template or a comment is a guess; the same list with no closing tag in it, and after it, is an element for certain', (t) => {
  const GUESS = { generic: false, ambiguity: 'generic' };
  const ELEMENT = { generic: false, ambiguity: null };
  for (const text of [
    '<T>(x: "</T>") }', "<T>(x: '</T>') }", '<T>(x: `</T>`) }', '<T>(x /* </T> */) }', '<T>(x = "</T>") }', '<T>(x: "a</T>b", y) }', '<T>(x // </T>\n) }', '<T>(x: "\\"</T>") }', '<T>(x: "</T>"); m: 1', '<T>(x: "</T>"),', '<T>(x: "</T>")\n}',
    '<T>(x: "</T>");\n  m: number', '<T>(x: `a${y}</T>`) }', '<T>(x: "</T>")}',
  ]) assert.deepStrictEqual(opensTypeParameters(text, 0), GUESS, JSON.stringify(text));
  // The closing tag is right after the `)`, and the string closes before it: in code.
  for (const text of ['<T>(x: "a")</T>', '<T>(x: `a`)</T>', '<T>(x /* a */)</T>', '<T>(x: "a")\n</T>', '<T>(x: "</T>") a</T>', '<T>(x)</T>']) assert.deepStrictEqual(opensTypeParameters(text, 0), ELEMENT, JSON.stringify(text));
  const ts = loadTypescriptOracle();
  if (!ts) return t.diagnostic('no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to check the readings');
  for (const code of ['interface I { <T>(x: "</T>") }', 'interface I { <T>(x: `</T>`) }', 'type L = { <T>(x /* </T> */) };', 'interface I { <T>(x: "</T>"); m: 1 }', 'const e = <T>(x: "</T>;\nconst r = 1;']) assertTsParses(ts, code, code);
});

// ─── A comment in an expression container ────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// A comment is trivia to TypeScript's scanner wherever white space is, so a container in the text of an element is read past it, and a `}` in a comment is no end of the container: `<T>(x: { /* c */ readonly a: T }) => T` is a
// function type for certain — the element reading fails at `a`, as it does without the comment — and so is every shape of a container with a comment before, between and after its tokens.
test('a comment is trivia where a container in the text of an element is read: the shapes that fail without it fail with it', () => {
  const comments = ['/* c */', ' /* c */ ', '/**/', '/* } */', '/* </T> */', '/* c\n */', ' // c\n', ' // } </T>\n', '/* c */ /* d */', '\n// c\n/* d */\n', '/** @type {x} */'];
  const bodies = [
    '{ C readonly a: T }', '{ C a: T }', '{ a C : T }', '{ a? C : T }', '{ a C ?: T }', '{ [C k: string]: T }', '{ [k C : string]: T }', '{ [K C in keyof T]: T }', '{ m(C x: T): T }', '{ m(x C : T): T }', '{ m(x?C : T): T }',
    '{ 1 C : T }', '{ "a" C : T }', '{ new C (x: T): T }', '{ (C x: T): T }', '{ readonly C a: T }', '{ C get a(): T }', '{ a: T; C b: U }', '{ C }', '{ a, C b }', '{ ...a C }',
    // A comment after the last name of a run that a bracket or a call holds: the run goes on to the `]` or `)`, and the colon after it fails the container. With no space between, a comment that stands right after a name is passed over.
    '{ [a C]: T }', '{ [K in keyof T C]: T }', '{ m(a C): T }', '{ m(a, C b): T }', '{ m(C): T }', '{ m(a, b C): T }', '{ [aC]: T }', '{ m(aC): T }', '{ m(a,bC): T }', '{ [K in keyof TC]: T }',
  ];
  for (const comment of comments) {
    for (const body of bodies) {
      const type = body.replaceAll('C', comment);
      const code = `const f: <T>(x: ${type}) => T = g;\nconst s = '</T>;${READ_CALL};//'; ${READ_CALL};\n`;
      assert.deepStrictEqual(ambiguities(code), [], JSON.stringify(code));
      assert.strictEqual(maskOf(code).split('navigateTo(').length - 1, 1, `the type is code, the string is data and the real call is code: ${JSON.stringify(code)}`);
    }
  }
  // A comment whose end is not known leaves the container undecided: the text of the element is not read to its end.
  for (const text of ['({ a /* c }) => T', '({ a // c }) => T', '({ (x: T): T /* c }) => T']) assert.strictEqual(elementFailsAt(text, 0, text.lastIndexOf('=>')), -1, text);
  // A comment between the tokens of a tag is read as ever: undecided in the arrow reading, which does not read a comment in a tag.
  assert.strictEqual(elementFailsAt('(<b /* c */ x>y) => T', 0, '(<b /* c */ x>y) => T'.lastIndexOf('=>')), -1);
  // A comment that the window of the reading ends in has no known end, and what stands past the window is not read: a colon there, which fails a container, is not seen. Where the comment ends in the window it is.
  const cut = (comment, tail) => `<T>(x) {a ${comment}${'c'.repeat(2004 - `<T>(x) {a ${comment}`.length)}${tail} T}</T>`;
  assert.strictEqual(elementChildren(cut('/*', '*/:'), 3, 'T'), null);
  assert.strictEqual(elementChildren(cut('//', ':'), 3, 'T'), null);
  assert.ok(elementChildren('<T>(x) {a /* c */: T}</T>', 3, 'T').fails !== undefined);
  assert.ok(elementChildren('<T>(x) {a // c\n: T}</T>', 3, 'T').fails !== undefined);
});
