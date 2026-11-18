#!/usr/bin/env node
'use strict';

// Shell-independent migration commands and diagnostics. Approval gates and
// reset/retry decisions remain owned by the skill; no helper resets a tracker.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runPac, commandError } = require('../../../scripts/lib/pac-command');
const { resolvePowerPagesSiteRoot } = require('../../../scripts/lib/validation-helpers');
const { parseCSV } = require('./generate-migration-reports');

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

function validateTarget(websiteId, outputDir) {
  if (typeof websiteId !== 'string' || !websiteId.trim()) throw new Error('--website-id is required');
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('--output-dir is required');
}

function checkMigrationStatus(websiteId, deps = {}, verboseSupported = true) {
  const run = deps.runPac || runPac;
  const command = ['pages', 'migrate-datamodel', '--webSiteId', websiteId, '--checkMigrationStatus'];
  let result = run([...command, ...(verboseSupported ? ['--verbose'] : [])], { captureAll: true, timeoutMs: 60000 });
  // Only an explicit unsupported-flag error permits a non-verbose retry;
  // authentication, network and executable errors must remain visible.
  if (verboseSupported && (result.status !== 0 || result.error) &&
      /unknown argument\s+['"]?--verbose\b/i.test(result.stderr || result.stdout || '')) {
    verboseSupported = false;
    result = run(command, { captureAll: true, timeoutMs: 60000 });
  }
  const rawOutput = result.stdout || result.stderr || '';
  let tracker = { status: 'Unknown', currentStep: null };
  let error = null;
  try {
    tracker = parseTracker(rawOutput);
    if (tracker.status === 'Unknown') {
      error = 'PAC reported an Unknown migration status; review the saved tracker response before continuing.';
    }
  } catch (parseError) {
    error = parseError.message;
  }
  if (result.status !== 0 || result.error) error = commandError('Checking migration status', result);
  return { ...tracker, verboseSupported, rawOutput, error, capturedAt: new Date().toISOString() };
}

function saveDiagnostic(outputDir, name, record) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${name}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return record;
}

function customizationFiles(directories) {
  const files = new Map();
  for (const directory of new Set(directories.map((entry) => path.resolve(entry)))) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^SiteCustomization.*\.csv$/i.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      const content = fs.readFileSync(filename, 'utf8');
      const stat = fs.statSync(filename);
      files.set(filename, {
        content,
        fingerprint: `${stat.mtimeMs}:${stat.ctimeMs}:${createHash('sha256').update(content).digest('hex')}`,
      });
    }
  }
  return files;
}

function generateCustomizationReport({ websiteId, outputDir }, deps = {}) {
  validateTarget(websiteId, outputDir);
  const directories = [outputDir, path.dirname(path.resolve(outputDir)), deps.cwd || process.cwd()];
  const previousFiles = customizationFiles(directories);
  const before = checkMigrationStatus(websiteId, deps);
  const ready = before.status === 'Completed' ||
    (before.status === 'Running' && before.currentStep?.toLowerCase() === 'configurationdatacompleted');
  if (before.error || !before.currentStep || !ready) {
    return saveDiagnostic(outputDir, 'customization-report-attempt', {
      outcome: 'CheckFailed', before,
      error: before.error || 'Verify the tracker and completed migration milestone before generating a report.',
    });
  }
  // A report request may update tracker metadata even though it does not migrate
  // site data. Preserve both snapshots, separate from migration-status.json.
  // https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model
  saveDiagnostic(outputDir, 'customization-report-attempt', { outcome: 'Generating', before });
  const command = (deps.runPac || runPac)([
    'pages', 'migrate-datamodel', '--webSiteId', websiteId, '--siteCustomizationReportPath', outputDir,
  ], { captureAll: true, ...(deps.cwd ? { cwd: deps.cwd } : {}) });
  const after = checkMigrationStatus(websiteId, deps, before.verboseSupported);
  const trackerChanged = before.status !== after.status || before.currentStep !== after.currentStep;
  const csvPaths = [];
  const invalidCsvPaths = [];
  for (const [filename, file] of customizationFiles(directories)) {
    if (previousFiles.get(filename)?.fingerprint === file.fingerprint) continue;
    let rows;
    try {
      rows = parseCSV(file.content.replace(/^\uFEFF/, ''), { strict: true });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      invalidCsvPaths.push(filename);
      continue;
    }
    const required = ['Type of customization', 'Guidance', 'Snippet', 'Location'];
    const headers = rows[0] || [];
    if (required.every((header) => headers.includes(header)) &&
        rows.slice(1).every((row) => row.length === headers.length)) csvPaths.push(filename);
    else invalidCsvPaths.push(filename);
  }
  let outcome = 'ReportGenerated';
  let error = null;
  if (command.status !== 0 || command.error) {
    outcome = 'CommandFailed';
    error = commandError('Generating customization report', command);
  } else if (after.error || !after.currentStep) {
    outcome = 'CheckFailed';
    error = after.error || 'Report generated without a verifiable current migration step.';
  } else if (trackerChanged) {
    outcome = 'TrackerChanged';
    error = 'Report request changed the migration status/current step; review both snapshots before continuing.';
  } else if (invalidCsvPaths.length || csvPaths.length === 0) {
    outcome = 'ReportMissingOrInvalid';
    error = 'PAC did not produce a new or updated valid customization CSV; exit code 0 is not report-generation success.';
  } else if (csvPaths.length > 1) {
    outcome = 'ReportSelectionRequired';
    error = 'Multiple customization CSVs changed; verify the selected site and report provenance before choosing one.';
  }
  return saveDiagnostic(outputDir, 'customization-report-attempt', {
    outcome, error, before, command, after, trackerChanged, csvPaths, invalidCsvPaths,
  });
}

function startReferences({ websiteId, outputDir }, deps = {}) {
  validateTarget(websiteId, outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const command = (deps.runPac || runPac)([
    'pages', 'migrate-datamodel', '--webSiteId', websiteId, '--mode', 'configurationDataReferences',
  ], { captureAll: true });
  const failed = command.status !== 0 || Boolean(command.error);
  // Observed refusal: "The website is already under migration." Check this
  // even on exit 0; a refused command must not enter the normal polling loop.
  const refused = /\b(?:web\s*site|site)\b[^\r\n]*\balready\s+under\s+migration\b/i
    .test(`${command.stdout || ''}\n${command.stderr || ''}`);
  const tracker = checkMigrationStatus(websiteId, deps);
  return saveDiagnostic(outputDir, 'references-start', {
    outcome: refused ? 'StartRefused' : failed ? 'StartFailed' : tracker.error ? 'CheckFailed' : 'StartAccepted',
    error: failed || refused ? commandError('Starting references migration', command) : tracker.error,
    command, tracker,
  });
}

async function pollMigration({ websiteId, mode, outputDir }, deps = {}) {
  validateTarget(websiteId, outputDir);
  if (!MODES.has(mode)) throw new Error('--mode must be configurationData, all, or configurationDataReferences');
  const maxAttempts = 30;
  const intervalMs = 60000;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const emit = deps.emit || ((record) => console.log(JSON.stringify(record)));
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
    const check = checkMigrationStatus(websiteId, deps, verboseSupported);
    verboseSupported = check.verboseSupported;
    const { rawOutput, status, currentStep } = check;
    const tracker = { status, currentStep };
    fs.writeFileSync(path.join(outputDir, 'migration-status.txt'), rawOutput, 'utf8');
    let error = check.error;
    if (!error && mode === 'configurationData' && tracker.status === 'Running' && !tracker.currentStep) {
      error = 'Metadata-only polling requires Current Step; verify the tracker directly in Dataverse before continuing or resetting.';
    }

    let outcome = 'Running';
    if (error) outcome = 'CheckFailed';
    else if (['Failed', 'Reverted'].includes(tracker.status)) outcome = tracker.status;
    else if (mode === 'configurationData' && (tracker.status === 'Completed' ||
        tracker.currentStep?.toLowerCase() === 'configurationdatacompleted')) {
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
    report: new Set(['website-id', 'output-dir']),
    'start-references': new Set(['website-id', 'output-dir']),
    delay: new Set(['seconds']),
  }[action];
  if (!allowed) throw new Error('Usage: migration-runtime.js discover|solutions|poll|report|start-references|delay [options]');
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
  } else if (args.action === 'report' || args.action === 'start-references') {
    const action = args.action === 'report' ? generateCustomizationReport : startReferences;
    const result = action({ websiteId: args['website-id'], outputDir: args['output-dir'] });
    console.log(JSON.stringify(result));
    process.exitCode = ['ReportGenerated', 'StartAccepted'].includes(result.outcome) ? 0 : 1;
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

module.exports = {
  discoverSite, captureSolutions, parseTracker, pollMigration, parseArgs,
  generateCustomizationReport, startReferences,
};
