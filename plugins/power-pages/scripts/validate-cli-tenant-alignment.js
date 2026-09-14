#!/usr/bin/env node
'use strict';

const { validateCliTenantAlignment } = require('./lib/cli-tenant-alignment');
const { formatJsonResult } = require('./lib/template-cli-args');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--envUrl') args.envUrl = argv[++i];
    else if (arg === '--token') args.token = argv[++i];
  }
  return args;
}

function run(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (!args.envUrl && !args.token) {
    return {
      ok: false,
      error: 'Usage: validate-cli-tenant-alignment.js [--envUrl <url>] [--token <bearer-token>] (at least one required)',
    };
  }
  return validateCliTenantAlignment(args, deps);
}

if (require.main === module) {
  process.stdout.write(formatJsonResult(run()));
}

module.exports = { parseArgs, run };
