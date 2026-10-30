#!/usr/bin/env node
'use strict';
// Plans promoting an app from one environment to another — PLAN ONLY. The target environment's SDK reads both
// environments (GET only) and says whether the package could be promoted: ready, refused (with every refusal) or unknown.
// There is no apply here and no fallback to a plain solution import; lib/promotion-plan.js explains why.

const fs = require('node:fs');
const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { safeMessage } = require('./lib/readonly-operations.js');
const { planAppPromotion } = require('./lib/promotion-plan.js');

const USAGE = 'Usage: node scripts/plan-app-promotion.js --source-env <envUrl> --target-env <envUrl> --package <solution.zip> --app <appUniqueName>\n'
  + '         [--settings <deployment-settings.json>] [--requirements <requirements.json>] [--mode managed|unmanaged]\n'
  + '         [--acknowledge-non-atomic-import] [--overwrite-unmanaged-customizations] [--publish-workflows] [--publish-app]';
const SWITCHES = ['acknowledge-non-atomic-import', 'overwrite-unmanaged-customizations', 'publish-workflows', 'publish-app'];
const VALUED = ['source-env', 'target-env', 'package', 'app', 'settings', 'requirements', 'mode'];

function usageExit(message) {
  makeWritesBlocking(process.stdout, process.stderr);
  process.stderr.write(`${message ? `✗ ${message}\n` : ''}${USAGE}\n`);
  process.exit(1);
}

function readJsonFile(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${what} must name a readable JSON file.`);
  }
}

/** Plans with both environments' az-token clients (a test seam: `clients`). */
async function planFromFlags(flags, clients = {}) {
  const sourceEnv = requireDataverseOrigin(flags['source-env']);
  const targetEnv = requireDataverseOrigin(flags['target-env']);
  const input = {
    packageBytes: fs.readFileSync(flags.package),
    appUniqueName: flags.app,
    mode: flags.mode,
    settings: flags.settings ? readJsonFile(flags.settings, '--settings') : undefined,
    requirements: flags.requirements ? readJsonFile(flags.requirements, '--requirements') : undefined,
    acknowledgeNonAtomicImport: flags['acknowledge-non-atomic-import'] === true,
    overwriteUnmanagedCustomizations: flags['overwrite-unmanaged-customizations'] === true,
    publishWorkflows: flags['publish-workflows'] === true,
    publishApp: flags['publish-app'] === true,
  };
  const sourceHttpClient = clients.source || createAzHttpClient(sourceEnv);
  const targetHttpClient = clients.target || createAzHttpClient(targetEnv);
  return withThrowawaySdk({ env: sourceEnv, httpClient: sourceHttpClient, prefix: 'promotion-source-' }, (makeSource) =>
    withThrowawaySdk({ env: targetEnv, httpClient: targetHttpClient, prefix: 'promotion-target-' }, (makeTarget) =>
      planAppPromotion({ sourceHttpClient, targetHttpClient, makeSdk: (client, side) => (side === 'source' ? makeSource : makeTarget)({ httpClient: client }), input })));
}

async function main() {
  const argv = process.argv.slice(2);
  const flagError = validateFlags(argv, { known: [...VALUED, ...SWITCHES], needValue: VALUED });
  if (flagError) usageExit(flagError);
  const { flags, positional } = parseArgs(argv);
  if (positional && positional.length) usageExit(`unexpected argument '${positional[0]}': this command only plans`);
  for (const name of ['source-env', 'target-env', 'package', 'app']) if (!flags[name]) usageExit(`--${name} is required`);
  for (const name of SWITCHES) if (flags[name] !== undefined && flags[name] !== true) usageExit(`--${name} takes no value`);
  let result;
  try {
    result = await planFromFlags(flags);
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : undefined;
    emitResult(false, { ok: false, error: safeMessage(err), ...(code ? { code } : {}) }, { ascii: true });
    return;
  }
  emitResult(result.ok, result, { ascii: true });
}

module.exports = { planFromFlags };

if (require.main === module) {
  main().catch((err) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${safeMessage(err)}\n`);
    process.exit(1);
  });
}
