#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  parseReturnOnly,
  sealWorkOrder,
  validateDirectWrite,
} = require('./lib/screen-builder-work-order');
const {
  canSkipValidation,
  captureDirectWriteSnapshot,
  createRunState,
  pendingScreens,
  recordChannelFailure,
  recordScreenSuccess,
  recordValidation,
  restoreOutOfScopeChanges,
  restoreSnapshotPaths,
  workspaceFingerprint,
} = require('./lib/screen-builder-runtime');

function parseArgs(argv) {
  const args = { workOrders: [], paths: [], validators: [], allowedPaths: [], restorePaths: [] };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--input') args.input = argv[++index];
    else if (token === '--output') args.output = argv[++index];
    else if (token === '--work-order') args.workOrders.push(argv[++index]);
    else if (token === '--response') args.response = argv[++index];
    else if (token === '--result') args.result = argv[++index];
    else if (token === '--state') args.state = argv[++index];
    else if (token === '--snapshot') args.snapshot = argv[++index];
    else if (token === '--backup-dir') args.backupDirectory = argv[++index];
    else if (token === '--allowed-path') args.allowedPaths.push(argv[++index]);
    else if (token === '--restore-path') args.restorePaths.push(argv[++index]);
    else if (token === '--run-id') args.runId = argv[++index];
    else if (token === '--screen-id') args.screenId = argv[++index];
    else if (token === '--channel') args.channel = argv[++index];
    else if (token === '--diagnostic') args.diagnostic = argv[++index];
    else if (token === '--output-hash') args.outputHash = argv[++index];
    else if (token === '--fingerprint') args.fingerprint = argv[++index];
    else if (token === '--path') args.paths.push(argv[++index]);
    else if (token === '--validator') args.validators.push(argv[++index]);
    else if (token === '--max-input-bytes') args.maxInputBytes = Number(argv[++index]);
    else if (token === '--max-output-bytes') args.maxOutputBytes = Number(argv[++index]);
    else if (token === '--seal') args.action = 'seal';
    else if (token === '--parse-return') args.action = 'parse-return';
    else if (token === '--verify-direct') args.action = 'verify-direct';
    else if (token === '--initialize-run') args.action = 'initialize-run';
    else if (token === '--record-channel-failure') args.action = 'record-channel-failure';
    else if (token === '--record-success') args.action = 'record-success';
    else if (token === '--pending') args.action = 'pending';
    else if (token === '--workspace-fingerprint') args.action = 'workspace-fingerprint';
    else if (token === '--record-validation') args.action = 'record-validation';
    else if (token === '--can-skip-validation') args.action = 'can-skip-validation';
    else if (token === '--capture-direct-snapshot') args.action = 'capture-direct-snapshot';
    else if (token === '--audit-direct-writes') args.action = 'audit-direct-writes';
    else if (token === '--restore-direct-paths') args.action = 'restore-direct-paths';
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function projectFile(root, value, label) {
  if (!value) throw new Error(`${label} is required`);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside project root`);
  }
  return resolved;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function run(args) {
  if (!args.projectRoot) throw new Error('--project-root is required');
  const root = path.resolve(args.projectRoot);
  const options = {
    projectRoot: root,
    ...(args.maxInputBytes ? { maxInputBytes: args.maxInputBytes } : {}),
    ...(args.maxOutputBytes ? { maxOutputBytes: args.maxOutputBytes } : {}),
  };
  if (args.action === 'seal') {
    const result = sealWorkOrder(readJson(projectFile(root, args.input, '--input')), options);
    atomicWriteJson(projectFile(root, args.output, '--output'), result.sealed);
    return { inputFingerprint: result.sealed.inputFingerprint, payloadBytes: result.payloadBytes };
  }
  if (args.action === 'parse-return') {
    const result = parseReturnOnly(
      fs.readFileSync(projectFile(root, args.response, '--response'), 'utf8'),
      readJson(projectFile(root, args.workOrders[0], '--work-order')),
      options,
    );
    atomicWriteJson(projectFile(root, args.output, '--output'), result);
    return result;
  }
  if (args.action === 'verify-direct') {
    return validateDirectWrite(
      readJson(projectFile(root, args.workOrders[0], '--work-order')),
      readJson(projectFile(root, args.result, '--result')),
      options,
    );
  }
  if (args.action === 'capture-direct-snapshot') {
    const snapshot = captureDirectWriteSnapshot(root, args.paths, args.backupDirectory);
    atomicWriteJson(projectFile(root, args.snapshot, '--snapshot'), snapshot);
    return {
      snapshotRevision: snapshot.snapshotRevision,
      protectedFileCount: snapshot.entries.length,
      snapshotPath: projectFile(root, args.snapshot, '--snapshot'),
    };
  }
  if (args.action === 'audit-direct-writes') {
    return restoreOutOfScopeChanges(
      root,
      readJson(projectFile(root, args.snapshot, '--snapshot')),
      args.allowedPaths,
    );
  }
  if (args.action === 'restore-direct-paths') {
    return restoreSnapshotPaths(
      root,
      readJson(projectFile(root, args.snapshot, '--snapshot')),
      args.restorePaths,
    );
  }
  const stateFile = args.state ? projectFile(root, args.state, '--state') : null;
  if (args.action === 'initialize-run') {
    const workOrders = args.workOrders.map((file) => readJson(projectFile(root, file, '--work-order')));
    const state = createRunState(args.runId, workOrders);
    atomicWriteJson(stateFile, state);
    return state;
  }
  if (['record-channel-failure', 'record-success', 'pending'].includes(args.action)) {
    const state = readJson(stateFile);
    if (args.action === 'record-channel-failure') {
      recordChannelFailure(state, args.screenId, args.channel, args.diagnostic);
      atomicWriteJson(stateFile, state);
      return state.screens[args.screenId];
    }
    if (args.action === 'record-success') {
      recordScreenSuccess(state, args.screenId, args.channel, args.outputHash);
      atomicWriteJson(stateFile, state);
      return state.screens[args.screenId];
    }
    return { pending: pendingScreens(state) };
  }
  if (args.action === 'workspace-fingerprint') {
    return { fingerprint: workspaceFingerprint(root, args.paths) };
  }
  if (args.action === 'record-validation') {
    const state = recordValidation(args.fingerprint, args.validators);
    atomicWriteJson(stateFile, state);
    return state;
  }
  if (args.action === 'can-skip-validation') {
    const state = fs.existsSync(stateFile) ? readJson(stateFile) : null;
    return { canSkip: canSkipValidation(state, args.fingerprint, args.validators) };
  }
  throw new Error('choose one screen-builder contract action');
}

function main(argv = process.argv) {
  try {
    const result = run(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok === false ? 1 : 0;
  } catch (error) {
    process.stderr.write(`screen-builder-contract: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, run };