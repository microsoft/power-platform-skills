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

function validatePageOutput({ filePath }) {
  if (!filePath) return { ok: false, filePath, problems: ['--file is required'] };
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return { ok: false, filePath: abs, problems: ['file was never written'] };
  const problems = structuralProblems(fs.readFileSync(abs, 'utf8'));
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
