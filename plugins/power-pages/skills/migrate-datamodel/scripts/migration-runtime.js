#!/usr/bin/env node
'use strict';

// Shell-independent discovery, UTF-8 solution capture and read-only migration
// polling. Migration mutations and approval gates remain owned by the skill.
const fs = require('node:fs');
const path = require('node:path');
const { runPac, commandError } = require('../../../scripts/lib/pac-command');
const { resolvePowerPagesSiteRoot } = require('../../../scripts/lib/validation-helpers');

const MODES = new Set(['configurationData', 'all', 'configurationDataReferences']);
const STATUSES = ['NotStarted', 'Running', 'Completed', 'Failed', 'Reverted', 'Unknown'];

function isFile(filename) {
  try {
    return fs.statSync(filename).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function siteRootIn(directory) {
  const nested = resolvePowerPagesSiteRoot(directory);
  if (nested && isFile(path.join(nested, 'website.yml'))) return nested;
  return isFile(path.join(directory, 'website.yml')) ? directory : null;
}

function discoverSite(directory = process.cwd(), requireSite = false) {
  const root = path.resolve(directory);
  const direct = siteRootIn(root);
  const candidates = direct ? [direct] : fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => siteRootIn(path.join(root, entry.name)))
    .filter(Boolean);
  if (requireSite && candidates.length !== 1) {
    throw new Error(`Expected exactly one site with website.yml under ${root}; found ${candidates.length}. Select the correct site explicitly.`);
  }
  return {
    siteRoot: candidates.length === 1 ? candidates[0] : null,
    candidates,
    parentOutputDir: path.join(direct ? path.dirname(root) : root, 'migration-reports'),
  };
}

function captureSolutions(filename, deps = {}) {
  const result = (deps.runPac || runPac)(['solution', 'list', '--includeSystemSolutions'], {
    captureAll: true,
    timeoutMs: 60000,
  });
  if (result.status !== 0 || result.error) throw new Error(commandError('Listing installed solutions', result));
  if (!result.stdout.trim()) throw new Error('PAC returned an empty solution list; template detection cannot continue.');
  const output = path.resolve(filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Avoid shell redirection/Out-File defaults: detection reads UTF-8 on every OS.
  fs.writeFileSync(output, result.stdout, 'utf8');
  return { output };
}

function parseTracker(output) {
  // PAC's documented skill contract is a label/value block, for example:
  // Current migration status is : Running
  //   Current Step: ConfigurationDataCompleted
  // Step history and chunk details can also contain "Completed"; never infer
  // the top-level result from those incidental occurrences.
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const statusMatch = /^\s*Current migration status is\s*:\s*(\w+)\s*$/im.exec(text);
  const status = STATUSES.find((candidate) => candidate.toLowerCase() === statusMatch?.[1].toLowerCase());
  if (!status) throw new Error('PAC output has no recognized "Current migration status is:" field; review migration-status.txt.');
  const currentStep = /^\s*Current Step\s*:\s*(\w+)\s*$/im.exec(text)?.[1] || null;
  return { status, currentStep };
}

async function pollMigration({ websiteId, mode, outputDir }, deps = {}) {
  if (typeof websiteId !== 'string' || !websiteId.trim()) throw new Error('--website-id is required');
  if (!MODES.has(mode)) throw new Error('--mode must be configurationData, all, or configurationDataReferences');
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('--output-dir is required');
  const maxAttempts = 30;
  const intervalMs = 60000;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const emit = deps.emit || ((record) => console.log(JSON.stringify(record)));
  const run = deps.runPac || runPac;
  const isReferences = mode === 'configurationDataReferences';
  fs.mkdirSync(outputDir, { recursive: true });

  let finalRecord;
  let verboseSupported = true;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const operation = {
      label: isReferences ? 'Migrating transactional references' : 'Migrating configuration metadata to EDM',
      detail: `mode=${mode}`,
      poll: { attempt, max: maxAttempts },
    };
    const command = ['pages', 'migrate-datamodel', '--webSiteId', websiteId, '--checkMigrationStatus'];
    let result = run([...command, ...(verboseSupported ? ['--verbose'] : [])], { captureAll: true, timeoutMs: 60000 });
    // Older PAC builds reject --verbose. Only that explicit compatibility
    // error permits a non-verbose retry; auth/network/PATH errors must stop.
    if (verboseSupported && (result.status !== 0 || result.error) &&
        /unknown argument\s+['"]?--verbose\b/i.test(result.stderr || result.stdout || '')) {
      verboseSupported = false;
      result = run(command, { captureAll: true, timeoutMs: 60000 });
    }
    const rawOutput = result.stdout || result.stderr || '';
    fs.writeFileSync(path.join(outputDir, 'migration-status.txt'), rawOutput, 'utf8');
    let tracker = { status: 'Unknown', currentStep: null };
    let error = null;
    try {
      tracker = parseTracker(rawOutput);
    } catch (parseError) {
      error = parseError.message;
    }
    if (result.status !== 0 || result.error) error = commandError('Checking migration status', result);
    if (!error && mode === 'configurationData' && tracker.status === 'Running' && !tracker.currentStep) {
      error = 'Metadata-only polling requires Current Step; verify the tracker directly in Dataverse before continuing or resetting.';
    }

    let outcome = 'Running';
    if (error) outcome = 'CheckFailed';
    else if (['Failed', 'Reverted'].includes(tracker.status)) outcome = tracker.status;
    else if (mode === 'configurationData' && tracker.currentStep?.toLowerCase() === 'configurationdatacompleted') {
      outcome = 'ConfigurationDataCompleted';
    } else if (mode !== 'configurationData' && tracker.status === 'Completed') outcome = 'Completed';
    else if (attempt === maxAttempts) outcome = 'TimedOut';

    finalRecord = {
      attempt, maxAttempts, mode, verboseSupported, ...tracker, outcome, error, operation,
      capturedAt: new Date().toISOString(),
      // Full verbose output is retained for the agent's existing step-history
      // and chunk interpretation. Do not truncate it to a process log tail.
      rawOutput,
    };
    fs.writeFileSync(path.join(outputDir, 'migration-status.json'), JSON.stringify(finalRecord, null, 2) + '\n', 'utf8');
    emit(finalRecord);
    if (outcome !== 'Running') break;
    await sleep(intervalMs);
  }
  return finalRecord;
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const allowed = {
    discover: new Set(['path', 'require-site']),
    solutions: new Set(['output']),
    poll: new Set(['website-id', 'mode', 'output-dir']),
    delay: new Set(['seconds']),
  }[action];
  if (!allowed) throw new Error('Usage: migration-runtime.js discover|solutions|poll|delay [options]');
  const args = { action };
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index].replace(/^--/, '');
    if (!rest[index].startsWith('--') || !allowed.has(option)) throw new Error(`Unknown argument: ${rest[index]}`);
    if (option === 'require-site') args[option] = true;
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error(`--${option} requires a value`);
      args[option] = value;
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.action === 'discover') {
    console.log(JSON.stringify(discoverSite(args.path, args['require-site']), null, 2));
  } else if (args.action === 'solutions') {
    if (!args.output) throw new Error('--output is required');
    console.log(JSON.stringify(captureSolutions(args.output)));
  } else if (args.action === 'delay') {
    const seconds = Number(args.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('--seconds must be an integer from 1 to 60');
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  } else {
    const result = await pollMigration({ websiteId: args['website-id'], mode: args.mode, outputDir: args['output-dir'] });
    process.exitCode = ['Completed', 'ConfigurationDataCompleted'].includes(result.outcome)
      ? 0 : result.outcome === 'TimedOut' ? 2 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { discoverSite, captureSolutions, parseTracker, pollMigration, parseArgs };
