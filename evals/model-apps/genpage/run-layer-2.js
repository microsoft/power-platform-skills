#!/usr/bin/env node
'use strict';

// Layer 2 eval runner — grades generated .tsx fixtures against the
// common_code_assertions and per-eval Phase 5 expectations defined in
// evals.json. Pure file I/O + regex; no Anthropic API, no Dataverse.
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
const { TapReporter } = require('./lib/reporter.js');
const {
  ASSERTIONS,
  PHASE5_EXPECTATIONS,
} = require('./lib/assertions-layer-2.js');

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
  return /^Phase 5\b/.test(text);
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
    const ev = evalById.get(fix.id);
    if (!ev) {
      reporter.assertion(
        `fixture references eval id ${fix.id}`,
        { status: 'fail', reason: `no eval with id ${fix.id} in evals.json` }
      );
      reporter.endFixture();
      continue;
    }
    if (fix.files.length === 0) {
      reporter.assertion(
        'fixture has at least one .tsx file',
        { status: 'fail', reason: 'no .tsx files in fixture (excluding RuntimeTypes.ts)' }
      );
      reporter.endFixture();
      continue;
    }

    // Apply every common_code_assertion
    for (const assertionText of evalsData.common_code_assertions) {
      const check = ASSERTIONS.get(assertionText);
      const result = check
        ? check({ files: fix.files, eval: ev })
        : { status: 'skip', reason: 'no check registered for this assertion text' };
      reporter.assertion(assertionText, result);
    }

    // Apply each per-eval Phase 5 expectation
    const phase5 = ev.expectations.filter(isPhase5Expectation);
    for (const expectationText of phase5) {
      const check = PHASE5_EXPECTATIONS.get(expectationText);
      const result = check
        ? check({ files: fix.files, eval: ev })
        : { status: 'skip', reason: 'no check registered for this Phase 5 expectation' };
      reporter.assertion(expectationText, result);
    }

    reporter.endFixture();
  }

  reporter.end();
  process.exit(reporter.exitCode);
}

if (require.main === module) main();

module.exports = { main, parseArgs };
