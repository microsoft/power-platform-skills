#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  readExecutionMode,
  recordAgentDispatch,
  recordTransportFailure,
  resumeWaitingInteraction,
  writeExecutionMode,
  writeWaitingInteraction,
} = require('./lib/agent-return-runtime');

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--state') args.state = argv[++index];
    else if (token === '--read-mode') args.action = 'read-mode';
    else if (token === '--write-mode') args.action = 'write-mode';
    else if (token === '--wait') args.action = 'wait';
    else if (token === '--resume') args.action = 'resume';
    else if (token === '--record-dispatch') args.action = 'record-dispatch';
    else if (token === '--record-transport-failure') args.action = 'record-transport-failure';
    else if (token === '--host-id') args.hostId = argv[++index];
    else if (token === '--runtime-id') args.runtimeId = argv[++index];
    else if (token === '--plugin-version') args.pluginVersion = argv[++index];
    else if (token === '--execution-mode') args.executionMode = argv[++index];
    else if (token === '--phase') args.phase = argv[++index];
    else if (token === '--kind') args.kind = argv[++index];
    else if (token === '--section-id') args.sectionId = argv[++index];
    else if (token === '--question') args.question = argv[++index];
    else if (token === '--affected-decisions') args.affectedDecisions = argv[++index];
    else if (token === '--answer') args.answer = argv[++index];
    else if (token === '--revision') args.revision = Number(argv[++index]);
    else if (token === '--run-id') args.runId = argv[++index];
    else if (token === '--agent') args.agent = argv[++index];
    else if (token === '--work-order-id') args.workOrderId = argv[++index];
    else if (token === '--reason') args.reason = argv[++index];
    else if (token === '--input-fingerprint') args.inputFingerprint = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function projectState(args, defaultName) {
  if (!args.projectRoot) throw new Error('--project-root is required');
  const root = path.resolve(args.projectRoot);
  const state = path.resolve(root, args.state || `.tmp/${defaultName}`);
  const relative = path.relative(root, state);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--state must stay inside project root');
  }
  return state;
}

function binding(args) {
  return {
    hostId: args.hostId,
    runtimeId: args.runtimeId,
    pluginVersion: args.pluginVersion,
  };
}

function run(args) {
  if (args.action === 'read-mode') {
    return readExecutionMode(projectState(args, 'agent-execution-mode.json'), binding(args));
  }
  if (args.action === 'write-mode') {
    return writeExecutionMode(
      projectState(args, 'agent-execution-mode.json'),
      binding(args),
      args.executionMode,
    );
  }
  if (args.action === 'wait') {
    return writeWaitingInteraction(projectState(args, 'agent-interaction-state.json'), {
      runId: args.runId,
      phase: args.phase,
      revision: args.revision || 1,
      pendingInteraction: {
        kind: args.kind,
        sectionId: args.sectionId,
        question: args.question,
        affectedDecisions: String(args.affectedDecisions || '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      },
    });
  }
  if (args.action === 'resume') {
    return resumeWaitingInteraction(
      projectState(args, 'agent-interaction-state.json'),
      args.answer,
      { runId: args.runId },
    );
  }
  if (args.action === 'record-dispatch') {
    return recordAgentDispatch(
      projectState(args, 'agent-dispatch-state.json'),
      {
        runId: args.runId,
        agent: args.agent,
        workOrderId: args.workOrderId,
        reason: args.reason,
        inputFingerprint: args.inputFingerprint,
      },
    );
  }
  if (args.action === 'record-transport-failure') {
    return recordTransportFailure(
      projectState(args, 'agent-dispatch-state.json'),
      {
        runId: args.runId,
        agent: args.agent,
        workOrderId: args.workOrderId,
        inputFingerprint: args.inputFingerprint,
      },
    );
  }
  throw new Error(
    'choose --read-mode, --write-mode, --wait, --resume, --record-dispatch, '
      + 'or --record-transport-failure',
  );
}

function main(argv = process.argv) {
  try {
    const result = run(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`agent-return-runtime: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, run };