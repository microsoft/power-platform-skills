'use strict';
// The source scans that pin "no production script does X" (helpers/production-scripts.js scriptsMatching) read a script's CODE, not its comments.
// Their comment stripper is the plugin's literal-aware lexer (lib/source-literals.js commentRanges): the regex it replaced took a `//` or `/*` inside a
// string, a template or a regular expression for a comment and dropped the code after it — `const s = 'a // b'; cleanWorkspace();` hid the call, and a
// scan for it passed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { productionScripts, withoutComments } = require('./helpers/production-scripts.js');
const { loadTypescriptOracle } = require('./helpers/typescript-oracle.js');

test('withoutComments keeps the code after a comment marker that sits in a string, a template or a regular expression', () => {
  const kept = [
    "const s = 'a // b'; cleanWorkspace();",
    'const s = "a /* b"; cleanWorkspace(); const t = "*/";',
    'const t = `a // b ${x} /* c`; cleanWorkspace();',
    "const u = 'https://contoso.crm.dynamics.com/api'; cleanWorkspace();",
    'const r = /a\\/\\/b/; cleanWorkspace();',
    'const r = /[/*]/g; cleanWorkspace();',
  ];
  for (const code of kept) {
    assert.match(withoutComments(code), /cleanWorkspace\(\)/, code);
  }
});

test('withoutComments drops real comments — line and block, between code — and keeps every offset and line break', () => {
  const code = 'const a = 1; // cleanWorkspace()\n/* cleanWorkspace()\n spans */ const b = 2;\n';
  const out = withoutComments(code);
  assert.doesNotMatch(out, /cleanWorkspace/);
  assert.strictEqual(out.length, code.length, 'a comment becomes blank space, so offsets are the source\'s');
  assert.deepStrictEqual(out.split('\n').length, code.split('\n').length, 'and line breaks are kept');
  assert.match(out, /^const a = 1; +\n +\n +const b = 2;\n$/);
});

test('every production script reads through the lexer: its code keeps every byte that is not a comment, and its line breaks', () => {
  const scripts = productionScripts();
  assert.ok(scripts.length > 40, `found ${scripts.length} scripts`);
  for (const file of scripts) {
    const code = fs.readFileSync(file, 'utf8');
    const out = withoutComments(code);
    assert.strictEqual(out.length, code.length, file);
    for (let i = 0; i < code.length; i += 1) {
      if (out[i] !== code[i]) assert.strictEqual(out[i], ' ', `${file}: offset ${i} changed to something other than a blank`);
      if (code[i] === '\n' || code[i] === '\r') assert.strictEqual(out[i], code[i], `${file}: a line break at ${i} is kept`);
    }
  }
});

// The comments TypeScript's own parser finds in `code`, as [start, end] pairs in source order. Every comment is trivia between two tokens: TypeScript reports one on a
// line of its own as LEADING trivia of the token after it (the end-of-file token included), and one on the same line after code (`x; // note`, `catch { /* … */ }`) as
// TRAILING trivia of the token before it — so the union of both, over every node, is all of them. A JSDoc is not walked into: its nodes (`@param {number} x`) sit
// INSIDE the comment, and the trivia "after" one of them is the comment's own text — `/** @param {number} x // a count */` would yield a second comment at `//`.
// The JSDoc itself is still found, as leading trivia of the token it documents.
function typescriptComments(ts, file, code) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Map();
  const visit = (node) => {
    if (ts.isJSDoc(node)) return;
    for (const c of ts.getLeadingCommentRanges(code, node.pos) || []) found.set(c.pos, c.end);
    for (const c of ts.getTrailingCommentRanges(code, node.end) || []) found.set(c.pos, c.end);
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...found].sort((a, b) => a[0] - b[0]);
}

const oracle = { skip: !process.env.TYPESCRIPT_ORACLE_PATH && 'TYPESCRIPT_ORACLE_PATH is not set' };

// With TypeScript pointed at (TYPESCRIPT_ORACLE_PATH, the lexer-oracle CI job), the comments the lexer finds in each production script are exactly the
// ones TypeScript's own parser finds: so the scans cannot be blinded (code read as a comment) or polluted (a comment read as code) by a script's text.
test('the comments the lexer finds in every production script are the ones TypeScript finds', oracle, () => {
  const ts = loadTypescriptOracle();
  const { commentRanges } = require('../lib/source-literals.js');
  for (const file of productionScripts()) {
    const code = fs.readFileSync(file, 'utf8');
    // A `#!` line is the parser's shebang, not a comment it reports; the lexer hears it as one.
    const ours = commentRanges(code).filter((c) => !c.text.startsWith('#!')).map((c) => [c.start, c.end]);
    assert.deepStrictEqual(ours, typescriptComments(ts, file, code), file);
  }
});

// The oracle itself must not invent a comment: a `//` inside a JSDoc is the JSDoc's text. Walking into the JSDoc's own nodes found a second "comment" from there to
// the JSDoc's end, and failed the comparison above for a script whose comments the lexer had read correctly.
test('the TypeScript oracle reads a JSDoc as one comment, with no comment inside it', oracle, () => {
  const ts = loadTypescriptOracle();
  const { commentRanges } = require('../lib/source-literals.js');
  const cases = [
    ['/** @param {number} x // a count */\nfunction f(x) {}\n', [[0, 35]]],
    ['/** {@link f} // x */\nfunction f() {}\n', [[0, 21]]],
    ['class C {\n  /** @returns {number} // n */\n  m() { return 1; } // after\n}\n', [[12, 41], [62, 70]]],
    ["/** @type {string} */ const s = 'a // b'; // tail\n", [[0, 21], [42, 49]]],
  ];
  for (const [code, expected] of cases) {
    assert.deepStrictEqual(typescriptComments(ts, 'case.js', code), expected, code);
    assert.deepStrictEqual(commentRanges(code).map((c) => [c.start, c.end]), expected, `the lexer agrees: ${code}`);
  }
});
