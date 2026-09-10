#!/usr/bin/env node
'use strict';

const {
  decideReinstall,
  inspectSolutionDirectory,
  inspectSolutionZip,
} = require('./lib/template-reinstall-policy');
const { formatJsonResult } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --solutionPath /tmp/template/solution [--installed true|false] [--installedVersion 1.0.0.0]
// The optional installed fields let create-site combine the source inspection with
// `check-solution-installed.js` output when computing the next re-install step.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--solutionPath') args.solutionPath = argv[++i];
    else if (arg === '--zipPath') args.zipPath = argv[++i];
    else if (arg === '--installed') args.installed = argv[++i] === 'true';
    else if (arg === '--installedVersion') args.installedVersion = argv[++i];
  }
  return args;
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.solutionPath && !args.zipPath) {
    return { ok: false, error: 'Usage: inspect-template-solution.js --solutionPath <path>' };
  }
  const inspected = args.solutionPath
    ? inspectSolutionDirectory(args.solutionPath)
    : inspectSolutionZip(args.zipPath);
  if (!inspected.ok) return inspected;
  if (typeof args.installed === 'boolean') {
    return {
      ...inspected,
      decision: decideReinstall({
        installed: args.installed,
        installedVersion: args.installedVersion,
        availableVersion: inspected.version,
      }),
    };
  }
  return inspected;
}

if (require.main === module) {
  process.stdout.write(formatJsonResult(run()));
}

module.exports = { parseArgs, run };
