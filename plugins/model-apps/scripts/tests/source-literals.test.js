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
    'JSX text containing an open paren': 'export default function P(){ return <button>(</button>; }\n',
    'JSX text containing balanced parens': 'export default function P(){ return <div>(text) here</div>; }\n',
    'JSX with an explicit type argument': 'export default function P(){ return <Table<Row> rows={r} />; }\n',
    'fragment': 'export default function P(){ return <><span>a</span><span>b</span></>; }\n',
    'comparison operators': 'const b = a < c && c > a;\nexport default function P(){ return <div/>; }\n',
  };
  for (const [name, code] of Object.entries(cases)) {
    assert.equal(hasDefaultExport(code), true, `default export missed: ${name}`);
    assert.equal(hasUnbalancedBrackets(code), false, `falsely unbalanced: ${name}`);
  }
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
