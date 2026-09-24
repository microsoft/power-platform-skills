#!/usr/bin/env node
'use strict';
// Validate page-builder worker output before the orchestrator accepts it.
//
// A partially written `.tsx` can still contain the token `export default`, so existence plus a token
// scan is not enough. This script reuses the dependency-free TSX lexer that already protects
// promote-intent-pages.js, giving the AI orchestration an executable yes/no gate before it decides
// whether to run the inline fallback.

const fs = require('node:fs');
const path = require('node:path');
const { blankLiterals, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets } = require('./lib/source-literals.js');

function structuralProblems(code) {
  const text = String(code || '');
  const problems = [];
  if (!text.trim()) return ['file is empty'];
  // hasDefaultExport also refuses a file cut off INSIDE its export (`export default function P(props)`
  // with no body), so say so: the one inline rewrite should write the whole page, not add an export.
  if (!hasDefaultExport(text)) problems.push('no complete default export — missing, or the file ends inside it');
  if (hasUnbalancedBrackets(text)) problems.push('unbalanced brackets — output looks truncated');
  // A cut that leaves every bracket balanced: inside JSX, a template or a comment, or after `a +`.
  if (endsMidStatement(text)) problems.push('stops mid-statement — output looks truncated');
  // On the blanked source, so a fence inside a template literal (a page rendering markdown help) is
  // data; a fence wrapping the file — the model answered in markdown — is code-position text.
  if (/^\s*(```|~~~)/m.test(blankLiterals(text))) problems.push('contains a markdown code fence');
  const elision = findElisionMarker(text);
  if (elision) problems.push(`contains ${elision}`);
  return problems;
}

// Every outcome is a result, never a throw: `ok:false` is what sends the orchestrator to its one inline
// rewrite, and a folder or an unreadable file at the page path used to throw out of readFileSync — an
// uncaught CLI failure instead of that recovery. lstat, not existsSync, so a link there (dangling ones
// included) is reported as what it is: not a page written in place — the dispatch gate
// (check-page-files.js) refuses a link at a page path before any worker runs.
function validatePageOutput({ filePath }) {
  if (!filePath) return { ok: false, filePath, problems: ['--file is required'] };
  const abs = path.resolve(filePath);
  const fail = (problem) => ({ ok: false, filePath: abs, problems: [problem] });
  let entry;
  try { entry = fs.lstatSync(abs); } catch (e) {
    return fail(e && e.code === 'ENOENT' ? 'file was never written' : `file could not be inspected (${(e && e.code) || e})`);
  }
  if (entry.isSymbolicLink()) return fail('is a symbolic link or junction, not a page file written in place');
  if (!entry.isFile()) return fail('is not a regular file');
  let code;
  try { code = fs.readFileSync(abs, 'utf8'); } catch (e) { return fail(`file could not be read (${(e && e.code) || e})`); }
  const problems = structuralProblems(code);
  return { ok: problems.length === 0, filePath: abs, problems };
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') {
      out.filePath = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function main() {
  const result = validatePageOutput(parseArgv(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 3);
}

if (require.main === module) main();

module.exports = { validatePageOutput, structuralProblems };
