#!/usr/bin/env node
'use strict';
// Bulk data repair of existing rows: plan (GET-only), apply an approved plan, resume its notAttempted rows, revert.
// lib/data-fix-runner.js holds the rules; this is the command line around it. Business values — before/after, row names,
// the filter text — go only to the private files under <app-dir>/.data-fix/<planId>/; stdout carries counts, codes,
// digests and paths. This plugin sends no telemetry from this command.
//
// Exit status: 0 only when the operation made every planned change (`operation.status` repaired / reverted /
// nothingToWrite / nothingToRevert), or for a plan or a revert review, which write nothing. Any other operation status
// — unknown, failed, conflicted, partial, unverified — exits 1 with the same JSON: a repair that kept another maker's
// change or stopped part-way is not a success, even though everything it did is recorded and can be resumed or reverted.

const fs = require('node:fs');
const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { findingOf } = require('./lib/readonly-operations.js');
const runner = require('./lib/data-fix-runner.js');

const USAGE = [
  'Usage:',
  '  node scripts/data-fix.js plan    --env <envUrl> --app-dir <dir> (--request <file.json> | --table <name> --filter <odata> --set <json> --max-rows <n>)',
  '  node scripts/data-fix.js apply   --env <envUrl> --app-dir <dir> --plan-id <id> --approve <planDigest> [--app <uniqueName> [--workspace <dir>]] [--batch-size <n>] [--max-throttle-wait-ms <ms>]',
  '  node scripts/data-fix.js resume  --env <envUrl> --app-dir <dir> --plan-id <id> --approve <planDigest> [--app <uniqueName> [--workspace <dir>]] [--batch-size <n>] [--max-throttle-wait-ms <ms>]',
  '  node scripts/data-fix.js revert  --env <envUrl> --app-dir <dir> --plan-id <id> [--approve <revertDigest>] [--app <uniqueName> [--workspace <dir>]] [--batch-size <n>] [--max-throttle-wait-ms <ms>]',
  '',
  '--app binds the repair to that app\'s build lease: no row is written while a build of the app is applying. --workspace',
  'names the build\'s workspace when the build was given one (default: <app-dir>/.maker-workspace, as the build\'s own).',
  'Every write of a plan (apply, resume, revert) must name the same --app and --workspace.',
].join('\n');

const VERBS = {
  plan: { known: ['env', 'app-dir', 'request', 'table', 'filter', 'set', 'max-rows'], needValue: ['env', 'app-dir', 'request', 'table', 'filter', 'set', 'max-rows'] },
  apply: { known: ['env', 'app-dir', 'plan-id', 'approve', 'app', 'workspace', 'batch-size', 'max-throttle-wait-ms'], needValue: ['env', 'app-dir', 'plan-id', 'approve', 'app', 'workspace', 'batch-size', 'max-throttle-wait-ms'] },
  resume: { known: ['env', 'app-dir', 'plan-id', 'approve', 'app', 'workspace', 'batch-size', 'max-throttle-wait-ms'], needValue: ['env', 'app-dir', 'plan-id', 'approve', 'app', 'workspace', 'batch-size', 'max-throttle-wait-ms'] },
  revert: { known: ['env', 'app-dir', 'plan-id', 'approve', 'app', 'workspace', 'batch-size', 'max-throttle-wait-ms'], needValue: ['env', 'app-dir', 'plan-id', 'approve', 'app', 'workspace', 'batch-size', 'max-throttle-wait-ms'] },
};

function usageExit(message) {
  makeWritesBlocking(process.stdout, process.stderr);
  process.stderr.write(`${message ? `✗ ${message}\n` : ''}${USAGE}\n`);
  process.exit(1);
}

// The request the SDK plans: a JSON file (rows mode needs one — each row's id and set), or the four filter flags.
function requestOf(flags) {
  if (flags.request) {
    if (flags.table || flags.filter || flags.set || flags['max-rows']) throw new runner.DataFixRunnerError('DATA_FIX_REQUEST_INVALID', '--request replaces --table, --filter, --set and --max-rows.');
    try {
      return JSON.parse(fs.readFileSync(flags.request, 'utf8'));
    } catch {
      throw new runner.DataFixRunnerError('DATA_FIX_REQUEST_INVALID', '--request must name a readable JSON file.');
    }
  }
  let set;
  try {
    set = JSON.parse(flags.set);
  } catch {
    throw new runner.DataFixRunnerError('DATA_FIX_REQUEST_INVALID', '--set must be a JSON object of column logical name to value.');
  }
  const maxRows = flags['max-rows'] === undefined ? undefined : Number(flags['max-rows']);
  return { table: flags.table, filter: flags.filter, set, ...(maxRows === undefined ? {} : { maxRows }) };
}

function optionsOf(flags) {
  const options = {};
  if (flags['batch-size'] !== undefined) options.batchSize = Number(flags['batch-size']);
  if (flags['max-throttle-wait-ms'] !== undefined) options.maxThrottleWaitMs = Number(flags['max-throttle-wait-ms']);
  return options;
}

async function run(verb, flags, env, httpClient = createAzHttpClient(env)) {
  return withThrowawaySdk({ env, httpClient, prefix: 'data-fix-' }, async (make) => {
    const base = { origin: env, httpClient, makeSdk: (client) => make({ httpClient: client }), appDir: flags['app-dir'] };
    if (verb === 'plan') return runner.planDataFix({ ...base, request: flags.parsedRequest });
    const common = { ...base, planId: flags['plan-id'], approve: flags.approve, appUniqueName: flags.app, workspaceDir: flags.workspace, options: optionsOf(flags) };
    if (verb === 'apply') return runner.applyApprovedPlan(common);
    if (verb === 'resume') return runner.resumeRemaining(common);
    return runner.revertApplied(common);
  });
}

async function main() {
  const [verb, ...argv] = process.argv.slice(2);
  const spec = VERBS[verb];
  if (!spec) usageExit(verb ? `unknown verb '${verb}'` : '');
  const flagError = validateFlags(argv, spec);
  if (flagError) usageExit(flagError);
  const { flags } = parseArgs(argv);
  if (!flags.env || !flags['app-dir']) usageExit('--env and --app-dir are required');
  if (verb !== 'plan' && !flags['plan-id']) usageExit('--plan-id is required');
  // The workspace names the folder of an app's build lease, so without an app it would bind nothing.
  if (flags.workspace !== undefined && !flags.app) usageExit('--workspace needs --app: it names the workspace of that app\'s build lease');
  if ((verb === 'apply' || verb === 'resume') && !flags.approve) usageExit('--approve <planDigest> is required: the digest `plan` printed, after reviewing its review file');
  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (err) {
    usageExit(err.message);
  }
  let result;
  try {
    if (verb === 'plan') flags.parsedRequest = runner.checkRequest(requestOf(flags));
    result = await run(verb, flags, env);
  } catch (err) {
    // Code, HTTP status and fixed (or this plugin's own) words only: a service's error text can quote a row value
    // (lib/readonly-operations.js findingOf). The SDK's column refusals name the column and the reason only
    // (DataFixColumnsInvalidError.issues); `details` is printed only for the runner's own errors, which build it.
    const { code, statusCode, message } = findingOf(err, 'DATA_FIX_FAILED');
    const issues = err && Array.isArray(err.issues) ? err.issues.map((i) => ({ column: i.column, reason: i.reason })) : undefined;
    const details = err instanceof runner.DataFixRunnerError && err.details ? err.details : undefined;
    emitResult(false, { ok: false, verb, error: message, code, ...(statusCode !== undefined ? { statusCode } : {}), ...(issues ? { issues } : {}), ...(details ? { details } : {}) }, { ascii: true });
    return;
  }
  // A write's success is the whole operation's, not the last attempt's: an earlier unknown row, a conflict, a stop
  // part-way all exit non-zero. A plan and a revert review carry no operation status of their own to fail on.
  const ok = result.operation && !result.approvalNeeded ? runner.OPERATION_SUCCESS.includes(result.operation.status) : true;
  emitResult(ok, { ok, verb, ...result }, { ascii: true });
}

module.exports = { requestOf };

if (require.main === module) {
  main().catch((err) => {
    makeWritesBlocking(process.stdout, process.stderr);
    const { code, message } = findingOf(err, 'DATA_FIX_FAILED');
    process.stderr.write(`Error (${code}): ${message}\n`);
    process.exit(1);
  });
}
