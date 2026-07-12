#!/usr/bin/env node
'use strict';

const { inspectSolutionZip, decideReinstall } = require('./lib/template-reinstall-policy');
const { formatJsonResult } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --zipPath /tmp/template.zip [--installed true|false] [--installedVersion 1.0.0.0]
// The optional installed fields let create-site combine the zip inspection with
// `check-solution-installed.js` output when computing the next re-install step.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--zipPath') args.zipPath = argv[++i];
    else if (arg === '--installed') args.installed = argv[++i] === 'true';
    else if (arg === '--installedVersion') args.installedVersion = argv[++i];
  }
  return args;
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.zipPath) return { ok: false, error: 'Usage: inspect-template-solution.js --zipPath <path>' };
  const inspected = inspectSolutionZip(args.zipPath);
  if (!inspected.ok) return inspected;
  if (typeof args.installed === 'boolean') {
    return {
      ...inspected,
      decision: decideReinstall({
        installed: args.installed,
        installedVersion: args.installedVersion,
        zipVersion: inspected.version,
      }),
    };
  }
  return inspected;
}

if (require.main === module) {
  process.stdout.write(formatJsonResult(run()));
}

module.exports = { parseArgs, run };
