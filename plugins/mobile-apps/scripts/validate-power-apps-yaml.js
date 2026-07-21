#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  formatValidationReport,
  validatePowerAppsYamlSource,
} = require('./lib/power-apps-yaml-schema.js');

function parseArgs(argv) {
  const args = { source: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') args.source = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/validate-power-apps-yaml.js --source <canvas-source-root> [--json]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.source) throw new Error('--source is required');
  args.source = path.resolve(args.source);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = validatePowerAppsYamlSource(args.source, { throwOnError: false });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatValidationReport(report));
  process.exitCode = report.valid ? 0 : 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[schema] FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
