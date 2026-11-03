#!/usr/bin/env node
'use strict';

const ALLOWED = new Set(['eventName', 'correlationId', 'templateId', 'catalogSha', 'audience', 'sessionId', 'errorClass']);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || !ALLOWED.has(key.slice(2)) || Object.hasOwn(args, key.slice(2)) ||
        typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error('Invalid telemetry arguments.');
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  try {
    // Like the SPA template-outcome command, this optional module must not make
    // the creation skill fail when telemetry is unavailable.
    const { recordNonSpaCreation } = require('./lib/non-spa-creation-telemetry');
    return recordNonSpaCreation(parseArgs(argv));
  } catch {
    return { ok: false };
  }
}

if (require.main === module) process.stdout.write(`${JSON.stringify(main())}\n`);
module.exports = { main, parseArgs };
