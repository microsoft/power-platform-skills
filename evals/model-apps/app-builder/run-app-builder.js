#!/usr/bin/env node
'use strict';
// app-builder OFFLINE eval runner — grades each fixture's App Spec against per-stage STRUCTURAL
// facts (author/plan/data/ui/app/verify/page) via the assertion registry + per-eval expectations
// in evals.json. Deterministic + offline: plugin pure primitives only — no Anthropic API, no
// Dataverse, no live env. Mirrors evals/model-apps/genpage/run-layer-*.js. See EVAL_GUIDE.md.
//
// Usage: node run-app-builder.js [--fixtures <dir>] [--eval <id>] [--tier <smoke|full>]
// Exit:  0 all pass · 1 an assertion failed · 2 runner error
const path = require('node:path');
const fs = require('node:fs');
const { loadFixtures } = require('./lib/fixture-loader.js');
const { TapReporter } = require('../genpage/lib/reporter.js');
const { stageFacts } = require('./lib/facts.js');
const { ASSERTIONS } = require('./lib/assertions.js');

// Known tiers, so a typo is rejected with the valid choices instead of silently matching no
// fixture and reporting "no fixtures matched the filter" (which blames the fixtures, not the arg).
// The parser is shared with the genpage runners — all three had the same silent-default defect.
const { parseEvalArgs } = require('../lib/eval-args.js');

function parseArgs(argv) {
  return parseEvalArgs(argv, {
    printHelp: () => process.stdout.write('Usage: run-app-builder.js [--fixtures <dir>] [--eval <id>] [--tier <smoke|full>]\n'),
  });
}

function loadEvals() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'evals.json'), 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args.fixtures ? path.resolve(args.fixtures) : path.join(__dirname, 'fixtures');

  let fixtures, evalsData;
  try { fixtures = loadFixtures(fixturesDir); }
  catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  try { evalsData = loadEvals(); }
  catch (e) { console.error(`error: failed to load evals.json: ${e.message}`); process.exit(2); }

  const evalById = new Map(evalsData.evals.map((e) => [e.id, e]));

  let selected = fixtures;
  if (args.eval !== null) selected = selected.filter((f) => f.id === args.eval);
  if (args.tier) selected = selected.filter((f) => { const ev = evalById.get(f.id); return ev && ev.tier === args.tier; });
  if (!selected.length) { console.error('error: no fixtures matched the filter'); process.exit(2); }

  const reporter = new TapReporter();
  reporter.start(selected.length);

  for (const fix of selected) {
    reporter.startFixture(fix.dirName);
    const ev = evalById.get(fix.id);
    if (!ev) {
      reporter.assertion(`fixture references eval id ${fix.id}`, { status: 'fail', reason: `no eval id ${fix.id} in evals.json` });
      reporter.endFixture();
      continue;
    }
    let facts;
    try { facts = await stageFacts(fix.spec); }
    catch (e) {
      reporter.assertion('stage facts computed without error', { status: 'fail', reason: e.message });
      reporter.endFixture();
      continue;
    }
    const texts = [...evalsData.common_stage_assertions, ...(ev.expectations || [])];
    for (const text of texts) {
      const check = ASSERTIONS.get(text);
      reporter.assertion(text, check
        ? check({ facts, spec: fix.spec, eval: ev })
        : { status: 'skip', reason: 'no check registered for this assertion text' });
    }
    reporter.endFixture();
  }

  reporter.end();
  process.exit(reporter.exitCode);
}

if (require.main === module) main();
module.exports = { main, parseArgs };
