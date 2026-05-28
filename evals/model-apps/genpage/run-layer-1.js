#!/usr/bin/env node
'use strict';

// Layer 1 eval runner — grades workflow artifacts (workflow-log.md,
// genpage-plan.md, entity-creation-log.md) against the common_workflow_assertions
// and per-eval Phase/Edit-Phase expectations defined in evals.json. Pure file
// I/O + regex; no Anthropic API, no Dataverse.
//
// Usage:
//   node run-layer-1.js [--fixtures <dir>] [--eval <id>] [--tier <tier>]
//
// Defaults:
//   --fixtures = ./fixtures (relative to this script)
//
// Exit code:
//   0 — every fixture passed
//   1 — at least one fixture had a failing assertion
//   2 — runner error (missing fixtures dir, malformed evals.json)
//
// Skipped assertions emit `ok # SKIP <reason>` and do not cause failure.

const path = require('node:path');
const fs = require('node:fs');

const { loadFixtures } = require('./lib/fixture-loader.js');
const { TapReporter } = require('./lib/reporter.js');
const {
  WORKFLOW_ASSERTIONS,
  PHASE_EXPECTATIONS,
} = require('./lib/assertions-layer-1.js');

function parseArgs(argv) {
  const args = { fixtures: null, eval: null, tier: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixtures') args.fixtures = argv[++i];
    else if (a === '--eval') args.eval = parseInt(argv[++i], 10);
    else if (a === '--tier') args.tier = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: run-layer-1.js [options]

Options:
  --fixtures <dir>   Directory containing eval fixtures (default: ./fixtures)
  --eval <id>        Run only the fixture with this eval id
  --tier <tier>      Run only fixtures whose eval matches this tier
                       (smoke | full | stress)
  --help             Show this message

Fixtures directory layout:
  <fixtures>/
    2-mock-dashboard/
      dashboard.tsx                  (consumed by Layer 2)
      workflow-log.md                (consumed by Layer 1)
      genpage-plan.md                (consumed by Layer 1)
      [entity-creation-log.md]       (consumed by Layer 1 when entities created)

Layer 1 reads workflow-log.md / genpage-plan.md / entity-creation-log.md and
greps them for evidence of the assertions in evals.json. Workflow assertions
that need AST analysis or schema cross-check are marked SKIP rather than
guessed.
`);
}

function loadEvals() {
  const file = path.join(__dirname, 'evals.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPhaseExpectation(text) {
  return /^Phase\s|^Edit Phase\s/.test(text);
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

  let selected = fixtures;
  if (args.eval !== null) selected = selected.filter((f) => f.id === args.eval);
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
    const ev = evalById.get(fix.id);
    if (!ev) {
      reporter.assertion(
        `fixture references eval id ${fix.id}`,
        { status: 'fail', reason: `no eval with id ${fix.id} in evals.json` }
      );
      reporter.endFixture();
      continue;
    }

    // common workflow assertions
    for (const assertionText of evalsData.common_workflow_assertions) {
      const check = WORKFLOW_ASSERTIONS.get(assertionText);
      const result = check
        ? check({ fixture: fix, eval: ev })
        : { status: 'skip', reason: 'no check registered for this assertion text' };
      reporter.assertion(assertionText, result);
    }

    // per-eval Phase/Edit Phase expectations
    const phaseExp = ev.expectations.filter(isPhaseExpectation);
    for (const expectationText of phaseExp) {
      const check = PHASE_EXPECTATIONS.get(expectationText);
      const result = check
        ? check({ fixture: fix, eval: ev })
        : { status: 'skip', reason: 'no check registered for this expectation' };
      reporter.assertion(expectationText, result);
    }

    reporter.endFixture();
  }

  reporter.end();
  process.exit(reporter.exitCode);
}

if (require.main === module) main();

module.exports = { main, parseArgs };
