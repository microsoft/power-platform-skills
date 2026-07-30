'use strict';
// Contract tests for the literal/comment blanker that backs the promotion gate and the eval's
// effect scoper. The plugin ships dependency-free, so this hand-rolled lexer stands in for a TSX
// parser — which makes its FALSE-POSITIVE behaviour (wrongly rejecting a real page) as important as
// its ability to reject prose. The corpus test below runs it over every .tsx the repo ships.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { blankLiterals, hasDefaultExport, hasUnbalancedBrackets } = require('../lib/source-literals.js');

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
