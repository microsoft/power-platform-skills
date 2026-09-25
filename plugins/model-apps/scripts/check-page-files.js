#!/usr/bin/env node
'use strict';
// Pre-dispatch gate for /genpage: are the page files a plan names safe to hand to parallel workers?
//
// The rule itself lives in lib/page-file-targets.js (shared with /app-builder and the evals). This
// wrapper exists so the orchestrator — an AI following SKILL.md — gets a yes/no answer it cannot talk
// itself past: a traversal, an absolute path or two case-colliding names are easy to spot by eye, but
// a directory junction that points outside the working directory is not.
//
// Usage:
//   node check-page-files.js --plan <working-dir>/genpage-plan.md [--working-dir <dir>]
// The working directory defaults to the plan file's own directory, which is where /genpage writes it.
//
// Output (one JSON line) and exit code:
//   0  {"ok":true,"workingDir":…,"files":[…],"problems":[]}
//   3  {"ok":false,…,"problems":[{"file","code","message"}]}   — halt and re-plan
//   1  usage error, or the plan has no readable ## Pages table, or more than one

const fs = require('node:fs');
const path = require('node:path');
const { pageFileProblems, pagesSections } = require('./lib/page-file-targets.js');

function checkPageFiles({ planPath, workingDir }) {
  if (!planPath) return { exit: 1, result: { ok: false, error: '--plan is required' } };
  const abs = path.resolve(planPath);
  let plan;
  try {
    plan = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { exit: 1, result: { ok: false, error: `--plan could not be read: ${e.message}` } };
  }
  const sections = pagesSections(plan);
  // Refused, not read by the first: a Pages table quoted in the requirements (fenced or not) decided the
  // files checked here while the workers wrote the real table's (lib/page-file-targets.js).
  if (sections.length > 1) {
    return { exit: 1, result: { ok: false, error: `${abs} has ${sections.length} ## Pages headings, so which table the pages come from is ambiguous (a Pages table quoted in the requirements counts too) — re-plan with exactly one` } };
  }
  const files = sections.length ? sections[0] : null;
  if (!files) return { exit: 1, result: { ok: false, error: `${abs} has no ## Pages table with a File column` } };
  if (!files.length) return { exit: 1, result: { ok: false, error: `${abs} lists no pages` } };
  const root = path.resolve(workingDir || path.dirname(abs));
  const problems = pageFileProblems(files, { workingDir: root });
  return { exit: problems.length ? 3 : 0, result: { ok: problems.length === 0, workingDir: root, files, problems } };
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plan') { out.planPath = argv[i + 1]; i += 1; }
    else if (argv[i] === '--working-dir') { out.workingDir = argv[i + 1]; i += 1; }
  }
  return out;
}

if (require.main === module) {
  const { exit, result } = checkPageFiles(parseArgv(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(exit);
}

module.exports = { checkPageFiles };
