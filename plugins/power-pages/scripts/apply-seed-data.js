#!/usr/bin/env node
'use strict';

const { applySeedData, planSeedData, emptyPlan } = require('./lib/apply-seed-data');
const { formatJsonResult, runBestEffortJsonCli } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --seedDir ~/.power-platform-skills/template-cache/<sha>/templates/spa/<id>/seed-data
//   [--seedFile ~/.power-platform-skills/template-cache/<sha>/templates/spa/<id>/seed-data/data.json]
//   --envUrl https://contoso.crm.dynamics.com [--plan] [--currencyCode SGD]
// Missing args are returned as `{ ok:false }` so create-site can continue to
// activation; seeding is best-effort and must never block go-live.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan') {
      args.plan = true;
    } else if (['--seedDir', '--seedFile', '--envUrl', '--currencyCode'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      args[arg.slice(2)] = value;
    } else {
      throw new Error(`Unknown seed argument: ${arg}`);
    }
  }
  return args;
}

async function run(argv = process.argv.slice(2), deps = {}) {
  let args;
  const argsFailure = (message) => ({
    ...(argv.includes('--plan') ? emptyPlan() : { inserted: 0, failed: 1, skipped: 0 }),
    ok: false, errors: [{ scope: 'args', message }],
  });
  try {
    args = parseArgs(argv);
  } catch (err) {
    return argsFailure(err.message);
  }
  if (!args.seedDir || !args.envUrl) {
    return argsFailure('Usage: apply-seed-data.js --seedDir <dir> --envUrl <url>');
  }
  return args.plan ? planSeedData(args, deps) : applySeedData(args, deps);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run, formatJsonResult };
