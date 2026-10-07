#!/usr/bin/env node
'use strict';

// Layer 2 eval runner — grades generated .tsx fixtures against the
// common_code_assertions and per-eval Phase 5 expectations defined in
// evals.json. Offline file I/O, static checks and pure production gates/resolver;
// no agent, TypeScript compiler, React rendering or Dataverse calls.
//
// Usage:
//   node run-layer-2.js [--fixtures <dir>] [--eval <id>] [--tier <smoke|full|stress>]
//
// Defaults:
//   --fixtures = ./fixtures (relative to this script)
//
// Exit code:
//   0 — every fixture passed (no failing assertions)
//   1 — at least one fixture had a failing assertion
//   2 — runner error (missing fixtures dir, malformed evals.json, etc.)
//
// Skipped assertions do not cause failure. They are reported as `ok # SKIP`.

const path = require('node:path');
const fs = require('node:fs');

const { loadFixtures } = require('./lib/fixture-loader.js');
const { parseEvalArgs } = require('../lib/eval-args.js');
const { TapReporter } = require('./lib/reporter.js');
const { refusalProblems } = require('./lib/workflow-evidence.js');
const {
  ASSERTIONS,
  PHASE5_EXPECTATIONS,
} = require('./lib/assertions-layer-2.js');

function parseArgs(argv) {
  // Shared with the app-builder runner: all three shipped an identical parser whose
  // `argv[++i]` yielded `undefined` for a trailing flag, so a value-less `--tier`/`--fixtures`
  // silently became "no filter" and the run reported PASS for a scope never asked for.
  return parseEvalArgs(argv, { printHelp });
}

function printHelp() {
  console.log(`Usage: run-layer-2.js [options]

Options:
  --fixtures <dir>   Directory containing eval fixtures (default: ./fixtures)
  --eval <id>        Run only the fixture with this eval id
  --tier <tier>      Run only fixtures whose eval matches this tier
                       (smoke | full | stress)
  --help             Show this message

Fixtures directory layout:
  <fixtures>/
    1-account-gallery/
      page.tsx
      [workflow-log.md]
    2-mock-dashboard/
      dashboard.tsx

Fixture folder name MUST start with the eval id, optionally followed by
"-<kebab-slug>". Each .tsx file in the folder is checked (RuntimeTypes.ts
is excluded).
`);
}

function loadEvals() {
  const file = path.join(__dirname, 'evals.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPhase5Expectation(text) {
  // The letter is part of the phase name, so \b after "5" alone silently excluded 5b's registered check.
  return /^Phase 5(?:[abc])?\b/.test(text);
}

function getExpectationCheck(text) {
  return isPhase5Expectation(text) ? PHASE5_EXPECTATIONS.get(text) : undefined;
}

// Grades one fixture in report order: an expected refusal or a fixture without pages is a single
// gate result; otherwise the common code assertions, then the eval's Phase 5 / 5a / 5b / 5c
// expectations. `kind` says which list a result came from. main() reports exactly these results,
// and evals/model-apps/tests/eval-coverage-contract.test.js reads the same ones.
function gradeFixture(fix, ev, evalsData) {
  if (!ev) {
    return [{ kind: 'gate', text: `fixture references eval id ${fix.id}`, result: { status: 'fail', reason: `no eval with id ${fix.id} in evals.json` } }];
  }
  if (fix.manifest?.expectedOutcome === 'refused') {
    const problems = refusalProblems(fix);
    return [{ kind: 'gate', text: 'expected refusal has a failed gate and no generated pages or mutations', result: problems.length
      ? { status: 'fail', reason: problems[0] }
      : { status: 'pass', reason: '' } }];
  }
  if (fix.files.length === 0) {
    return [{ kind: 'gate', text: 'fixture has at least one .tsx file', result: { status: 'fail', reason: 'no .tsx files in fixture (excluding RuntimeTypes.ts)' } }];
  }
  const results = [];
  for (const text of evalsData.common_code_assertions) {
    const check = ASSERTIONS.get(text);
    results.push({ kind: 'common', text, result: check
      ? check({ files: fix.files, fixture: fix, eval: ev })
      : { status: 'skip', reason: 'no check registered for this assertion text' } });
  }
  for (const text of ev.expectations.filter(isPhase5Expectation)) {
    const check = getExpectationCheck(text);
    results.push({ kind: 'expectation', text, result: check
      ? check({ files: fix.files, fixture: fix, eval: ev })
      : { status: 'skip', reason: 'no check registered for this Phase 5 expectation' } });
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args.fixtures
    ? path.resolve(args.fixtures)
    : path.join(__dirname, 'fixtures');

  let fixtures;
  try {
    fixtures = loadFixtures(fixturesDir);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }

  let evalsData;
  try {
    evalsData = loadEvals();
  } catch (err) {
    console.error(`error: failed to load evals.json: ${err.message}`);
    process.exit(2);
  }
  const evalById = new Map(evalsData.evals.map((e) => [e.id, e]));

  // Filter fixtures by eval id / tier if requested
  let selected = fixtures;
  if (args.eval !== null) {
    selected = selected.filter((f) => f.id === args.eval);
  }
  if (args.tier) {
    selected = selected.filter((f) => {
      const ev = evalById.get(f.id);
      return ev && ev.tier === args.tier;
    });
  }

  if (selected.length === 0) {
    console.error('error: no fixtures matched the filter');
    process.exit(2);
  }

  const reporter = new TapReporter();
  reporter.start(selected.length);

  for (const fix of selected) {
    reporter.startFixture(fix.dirName);
    for (const { text, result } of gradeFixture(fix, evalById.get(fix.id), evalsData)) {
      reporter.assertion(text, result);
    }
    reporter.endFixture();
  }

  reporter.end();
  process.exit(reporter.exitCode);
}

if (require.main === module) main();

module.exports = { main, parseArgs, isPhase5Expectation, getExpectationCheck, gradeFixture };
