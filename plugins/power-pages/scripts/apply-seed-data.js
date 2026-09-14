#!/usr/bin/env node
'use strict';

const { applySeedData } = require('./lib/apply-seed-data');
const { formatJsonResult, runBestEffortJsonCli } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --seedDir /tmp/powerpages-templates/<sha>/templates/spa/<id>/seed-data
//   --envUrl https://org.crm.dynamics.com
// Missing args are returned as `{ ok:false }` so create-site can continue to
// activation; seeding is best-effort and must never block go-live.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seedDir') args.seedDir = argv[++i];
    else if (arg === '--envUrl') args.envUrl = argv[++i];
  }
  return args;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.seedDir || !args.envUrl) {
    return { ok: false, inserted: 0, failed: 1, skipped: 0, errors: [{ scope: 'args', message: 'Usage: apply-seed-data.js --seedDir <dir> --envUrl <url>' }] };
  }
  return applySeedData(args);
}

if (require.main === module) {
  runBestEffortJsonCli(() => run());
}

module.exports = { parseArgs, run, formatJsonResult };
