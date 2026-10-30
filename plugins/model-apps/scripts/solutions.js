#!/usr/bin/env node
'use strict';
// solutions: read-only questions about a solution.
//
//   inspect   the solution's unique name, display name, version, managed state and publisher. With --include-artifacts,
//             also the artifacts the SDK can read of it, by kind, and what it could not read (lib/solution-inventory.js
//             says what the inventory leaves out: it is a diagnosis, not everything the solution owns).
//
// Every request is a GET; the result counts them (`cost.gets`). Nothing is written to the environment.

const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { safeMessage } = require('./lib/readonly-operations.js');
const { inspectSolution, INVENTORY_READ_CONCURRENCY } = require('./lib/solution-inventory.js');

const USAGE = 'Usage: node scripts/solutions.js inspect --env <envUrl> --solution <uniqueName|id> [--include-artifacts]';
const VALUED = ['env', 'solution'];
const SWITCHES = ['include-artifacts'];

function usageExit(message) {
  makeWritesBlocking(process.stdout, process.stderr);
  process.stderr.write(`${message ? `✗ ${message}\n` : ''}${USAGE}\n`);
  process.exit(1);
}

/** Runs `inspect` with the environment's az-token client (a test seam: `httpClient`). */
async function inspectFromFlags(flags, httpClient) {
  const env = requireDataverseOrigin(flags.env);
  const client = httpClient || createAzHttpClient(env);
  return withThrowawaySdk({ env, httpClient: client, prefix: 'solution-inspect-' }, (make) => inspectSolution({
    httpClient: client,
    makeSdk: (readOnly) => make({ httpClient: readOnly, readConcurrency: INVENTORY_READ_CONCURRENCY }),
    solution: flags.solution,
    includeArtifacts: flags['include-artifacts'] === true,
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const flagError = validateFlags(argv, { known: [...VALUED, ...SWITCHES], needValue: VALUED });
  if (flagError) usageExit(flagError);
  const { flags, positional } = parseArgs(argv);
  const verbs = positional || [];
  if (verbs[0] !== 'inspect' || verbs.length !== 1) usageExit(verbs.length ? `unknown command '${verbs.join(' ')}'` : 'a command is required');
  for (const name of VALUED) if (!flags[name]) usageExit(`--${name} is required`);
  for (const name of SWITCHES) if (flags[name] !== undefined && flags[name] !== true) usageExit(`--${name} takes no value`);
  let result;
  try {
    result = await inspectFromFlags(flags);
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : undefined;
    emitResult(false, { ok: false, error: safeMessage(err), ...(code ? { code } : {}) }, { ascii: true });
    return;
  }
  emitResult(result.ok, result, { ascii: true });
}

module.exports = { inspectFromFlags };

if (require.main === module) {
  main().catch((err) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${safeMessage(err)}\n`);
    process.exit(1);
  });
}
