#!/usr/bin/env node
'use strict';

// The opt-in stable-turn-retry eval runner. It grades ONE evidence folder — by default fixtures/stable-turn-retry — against the host's
// side of `genpage-upload.js --turn-id` (lib/turn-retry-contract.js), and compares the default corpus's recorded uploads with it (an
// ordinary create or edit passes no --turn-id).
//
// It is separate from run-layer-1.js and run-layer-2.js on purpose: the turn id is for a host that retries one complete edit after
// losing its answer, not something the skill's ordinary flow does, so its evidence is selected by name and never joins the default
// runs. The folder's name has no eval id, which is what keeps the default loader (lib/fixture-loader.js loadFixtures) off it: their
// fixture, test and skip counts are the same with it as without it.
//
// Usage:
//   node run-stable-turn-retry.js [--fixtures <folder>]
//
// Exit code: 0 — every check passed; 1 — a check failed; 2 — runner error (a missing folder, malformed evidence, a bad argument).

const path = require('node:path');

const { parseEvalArgs } = require('../lib/eval-args.js');
const { loadFixtures, loadFixtureDir } = require('./lib/fixture-loader.js');
const { gradeTurnRetry } = require('./lib/turn-retry-contract.js');
const { TapReporter } = require('./lib/reporter.js');

function printHelp() {
  console.log(`Usage: run-stable-turn-retry.js [options]

Options:
  --fixtures <folder>  The ONE evidence folder to grade (default: ./fixtures/stable-turn-retry)
  --help               Show this message

Grades a host's page-upload retry under --turn-id: the id kept before the first send, the
same command sent again after a lost answer, one page and one history turn, a changed
request refused with nothing written, and no --turn-id on an ordinary edit. The default
runners (run-layer-1.js, run-layer-2.js) never load this evidence.
`);
}

function main() {
  // The shared parser, so a value-less --fixtures is an error here too. --eval and --tier select fixtures of the default corpus, which this
  // runner does not grade: taking either silently would report a pass for a scope nobody asked for.
  const args = parseEvalArgs(process.argv.slice(2), { printHelp });
  if (args.eval !== null || args.tier !== null) {
    console.error('error: --eval and --tier select default fixtures; this runner grades one evidence folder (--fixtures <folder>)');
    process.exit(2);
  }
  const folder = args.fixtures ? path.resolve(args.fixtures) : path.join(__dirname, 'fixtures', 'stable-turn-retry');

  let fixture;
  let corpus;
  try {
    fixture = loadFixtureDir(folder);
    corpus = loadFixtures(path.join(__dirname, 'fixtures'));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }

  const reporter = new TapReporter();
  reporter.start(1);
  reporter.startFixture(fixture.dirName);
  for (const { text, result } of gradeTurnRetry(fixture, { corpus })) reporter.assertion(text, result);
  reporter.endFixture();
  reporter.end();
  process.exit(reporter.exitCode);
}

if (require.main === module) main();

module.exports = { main };
