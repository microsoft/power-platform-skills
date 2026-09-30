#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TapReporter } = require('./lib/reporter.js');
const { parseEvalArgs } = require('./lib/eval-args.js');
const { computeFacts } = require('./lib/facts.js');
const { ASSERTIONS } = require('./lib/assertions.js');

function parseArgs(argv) {
  let evals = null;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--evals') {
      const value = argv[++i];
      if (!value || /^--/.test(value)) {
        console.error('error: --evals requires a value');
        process.exit(2);
      }
      evals = value;
    } else {
      rest.push(argv[i]);
    }
  }
  const parsed = parseEvalArgs(rest, {
    printHelp: () => process.stdout.write('Usage: run-pcf.js [--fixtures <dir>] [--eval <id>] [--tier <smoke|full>] [--evals <file>]\n'),
  });
  parsed.evals = evals;
  return parsed;
}

function loadEvals(file) {
  const evalsPath = file ? path.resolve(file) : path.join(__dirname, 'evals.json');
  return JSON.parse(fs.readFileSync(evalsPath, 'utf8').replace(/^\uFEFF/, ''));
}

function dirForEval(fixturesDir, ev) {
  const explicit = path.join(fixturesDir, ev.fixture || '');
  if (fs.existsSync(explicit)) return explicit;
  const prefix = `${Number(ev.id)}-`;
  const padded = `${String(ev.id).padStart(3, '0')}-`;
  const hit = fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .find((name) => name === String(ev.id) || name.startsWith(prefix) || name.startsWith(padded));
  return hit ? path.join(fixturesDir, hit) : explicit;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args.fixtures ? path.resolve(args.fixtures) : path.join(__dirname, 'fixtures');
  let data;
  try {
    data = loadEvals(args.evals);
  } catch (err) {
    console.error(`error: failed to load evals.json: ${err.message}`);
    process.exit(2);
  }
  let selected = data.evals || [];
  if (args.eval !== null) selected = selected.filter((ev) => ev.id === args.eval);
  if (args.tier === 'smoke') selected = selected.filter((ev) => ev.tier === 'smoke');
  if (!selected.length) {
    console.error('error: no fixtures matched the filter');
    process.exit(2);
  }

  const reporter = new TapReporter();
  reporter.start(selected.length);
  for (const ev of selected) {
    const name = `${String(ev.id).padStart(3, '0')}-${ev.fixture || ev.family}`;
    reporter.startFixture(name);
    const fixtureDir = dirForEval(fixturesDir, ev);
    let facts;
    try {
      facts = await computeFacts({ ...ev, fixtureDir });
    } catch (err) {
      reporter.assertion('facts computed without error', { status: 'fail', reason: err.stack || err.message });
      reporter.endFixture();
      continue;
    }
    const assertions = ev.assertions || data.common_assertions || [];
    for (const text of assertions) {
      const check = ASSERTIONS.get(text);
      reporter.assertion(text, check ? check({ facts, eval: ev }) : { status: 'skip', reason: 'no check registered for this assertion text' });
    }
    reporter.endFixture();
  }
  reporter.end();
  process.exit(reporter.exitCode);
}

if (require.main === module) main();
module.exports = { main, parseArgs, loadEvals, dirForEval };

