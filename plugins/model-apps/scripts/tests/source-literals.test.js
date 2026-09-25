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
const { blankLiterals, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets, scanTemplateExpressionEnd, expressionPosition } = require('../lib/source-literals.js');
const { navReferencedKeys } = require('../lib/pageref-resolver.js');

// The TypeScript parser the lexer's review snippets are checked against. The plugin ships dependency-free, so a
// checkout has none: point TYPESCRIPT_ORACLE_PATH at a `typescript` package to run that check, skipped otherwise.
function loadTypescriptOracle() {
  const at = process.env.TYPESCRIPT_ORACLE_PATH;
  if (!at) return null;
  try {
    return require(at);
  } catch {
    return null;
  }
}

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
    'generic arrow with a return-type annotation': 'const f = <T>(x: T): T => x;\nexport default function P(){ return <div/>; }\n',
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
test('cast type arguments reach their `as` through intersections and unions, and never span an expression operator', () => {
  const brand = 'type Brand<T> = { readonly __brand: T };\nconst total = 12, count = 2;\n';
  const complete = {
    'intersection cast before division': `${brand}const label = \`\${total as number & Brand<"USD"> / count}/month\`;\nexport default () => <p>{label}</p>;`,
    'union cast with a qualified name before division': 'namespace B { export type C<D> = D; }\nconst value = 4, n = 2;\nconst v = `${value as string | B.C<number> / n}`;\nexport default () => null;',
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
    'eighteen union constituents': `${union.map((n) => `type ${n} = number;`).join('\n')}\ntype Z<Q> = Q;\n${d}const v = \`\${total as ${union.join(' | ')} | Z<number> / count}\`;\nexport default () => null;`,
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
  const indexedEarlier = `type Row = { qty: number };\ntype Key = "qty";\ntype Brand<T> = { __b: T };\n${d}const label = \`\${total as Row[Key] & Brand<"x"> / count}\`;\nexport default () => null;`;
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
    'a union checked type': `${vd}const label = \`\${total as number | Value extends undefined ? 0 : NonNullable<Value> / count}\`;\nexport default () => null;`,
  })) {
    assert.equal(hasDefaultExport(code), true, label);
    assert.equal(endsMidStatement(code), false, label);
  }
  assert.equal(endsMidStatement(`${vd}export default () => total as Value extends undefined ? 0 | 1 : NonNullable<Value> / count /`), true);
  assert.deepEqual(navReferencedKeys(`${vd}const m = \`\${total as Value extends undefined ? 0 | 1 : NonNullable<Value> / count / 2 ? Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_details" }) : ""}\`;\nexport default () => null;`), ['details']);
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
