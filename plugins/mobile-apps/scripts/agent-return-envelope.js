#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  materializeEnvelopeSet,
  sealWorkOrder,
  validateEnvelopeSet,
} = require('./lib/agent-return-envelope');

const STATUS_PRIORITY = [
  'blocked',
  'needs_clarification',
  'needs_context',
  'ready_with_concerns',
  'ready',
];

function parseArgs(argv) {
  const args = { workOrders: [], responses: [] };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--work-order') args.workOrders.push(argv[++index]);
    else if (token === '--response') args.responses.push(argv[++index]);
    else if (token === '--output') args.output = argv[++index];
    else if (token === '--seal-work-order') args.sealWorkOrder = argv[++index];
    else if (token === '--validation-plan') args.validationPlan = argv[++index];
    else if (token === '--materialization-state') args.materializationState = argv[++index];
    else if (token === '--phase') args.phase = argv[++index];
    else if (token === '--validate-only') args.validateOnly = true;
    else if (token === '--materialize') args.materialize = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node agent-return-envelope.js --project-root <dir> \\',
    '    --seal-work-order <json> --output <sealed-json>',
    '  node agent-return-envelope.js --project-root <dir> \\',
    '    --work-order <json> --response <json-or-text> [repeat pairs] \\',
    '    <--validate-only|--materialize> [--validation-plan <json>] \\',
    '    [--materialization-state <json> --phase <id>] \\',
    '    [--output <json>] [--json]',
  ].join('\n');
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative));
}

function projectFile(projectRoot, file, label) {
  if (!file) throw new Error(`${label} path is required`);
  const resolved = path.resolve(projectRoot, file);
  if (!isInside(projectRoot, resolved)) throw new Error(`${label} must stay inside project root`);
  return resolved;
}

function atomicWriteJson(file, value, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fileSystem.renameSync(temporary, file);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function aggregateStatus(envelopes) {
  return STATUS_PRIORITY.find(
    (status) => envelopes.some((envelope) => envelope.status === status),
  ) || 'blocked';
}

function runValidationPlan(plan, stagedArtifacts, projectRoot, {
  spawn = spawnSync,
} = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || plan.schemaVersion !== 1 || !Array.isArray(plan.commands)) {
    throw new Error('validation plan must contain schemaVersion 1 and commands');
  }
  const byId = new Map(stagedArtifacts.map((artifact) => [artifact.artifactId, artifact]));
  const replace = (value) => String(value)
    .replaceAll('{{projectRoot}}', projectRoot)
    .replace(/\{\{artifact:([^}]+)\}\}/g, (_match, artifactId) => {
      const artifact = byId.get(artifactId);
      if (!artifact) throw new Error(`validation plan references unknown artifact ${artifactId}`);
      return artifact.stagedPath;
    })
    .replace(/\{\{target:([^}]+)\}\}/g, (_match, artifactId) => {
      const artifact = byId.get(artifactId);
      if (!artifact) throw new Error(`validation plan references unknown artifact ${artifactId}`);
      return artifact.targetPath;
    });
  const findings = [];
  for (const [index, command] of plan.commands.entries()) {
    if (!command || typeof command !== 'object' || Array.isArray(command)
      || typeof command.command !== 'string' || !command.command.trim()
      || !Array.isArray(command.args)
      || command.args.some((argument) => typeof argument !== 'string')) {
      throw new Error(`validation plan commands[${index}] is invalid`);
    }
    const result = spawn(replace(command.command), command.args.map(replace), {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const diagnostic = String(result.stderr || result.stdout || 'validator failed')
        .trim()
        .slice(0, 2000);
      findings.push(`${command.id || `command-${index + 1}`}: ${diagnostic}`);
    }
  }
  return findings;
}

function recordMaterializationState(file, projectRoot, phase, artifacts, {
  fileSystem = fs,
  nowIso = () => new Date().toISOString(),
} = {}) {
  if (!phase || typeof phase !== 'string') {
    throw new Error('--phase is required with --materialization-state');
  }
  let previous = { schemaVersion: 1, revision: 0, artifacts: {} };
  if (fileSystem.existsSync(file)) {
    previous = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
    if (previous.schemaVersion !== 1
      || !Number.isInteger(previous.revision)
      || !previous.artifacts
      || Array.isArray(previous.artifacts)) {
      throw new Error('materialization state is invalid');
    }
  }
  const changed = Object.fromEntries(artifacts.map((artifact) => {
    const content = fileSystem.readFileSync(artifact.targetPath);
    return [artifact.artifactId, {
      agent: artifact.agent,
      targetPath: path.relative(projectRoot, artifact.targetPath).replace(/\\/g, '/'),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    }];
  }));
  const state = {
    schemaVersion: 1,
    phase,
    revision: previous.revision + 1,
    updatedAt: nowIso(),
    artifacts: { ...previous.artifacts, ...changed },
  };
  atomicWriteJson(file, state, fileSystem);
  return state;
}

function run(args, { fileSystem = fs } = {}) {
  if (!args.projectRoot) throw new Error('--project-root is required');
  if (args.sealWorkOrder) {
    if (!args.output) throw new Error('--output is required with --seal-work-order');
    const projectRoot = path.resolve(args.projectRoot);
    const source = projectFile(projectRoot, args.sealWorkOrder, 'work order');
    const output = projectFile(projectRoot, args.output, 'output');
    const sealed = sealWorkOrder(JSON.parse(fileSystem.readFileSync(source, 'utf8')));
    atomicWriteJson(output, sealed, fileSystem);
    return sealed;
  }
  if (Number(Boolean(args.validateOnly)) + Number(Boolean(args.materialize)) !== 1) {
    throw new Error('choose exactly one of --validate-only or --materialize');
  }
  if (args.workOrders.length === 0
    || args.workOrders.length !== args.responses.length) {
    throw new Error('supply one --response for every --work-order');
  }
  const projectRoot = path.resolve(args.projectRoot);
  const entries = args.workOrders.map((workOrderFile, index) => {
    const workOrderPath = projectFile(projectRoot, workOrderFile, 'work order');
    const responsePath = projectFile(projectRoot, args.responses[index], 'response');
    return {
      workOrder: JSON.parse(fileSystem.readFileSync(workOrderPath, 'utf8')),
      responseText: fileSystem.readFileSync(responsePath, 'utf8'),
    };
  });
  const envelopes = validateEnvelopeSet(entries, { projectRoot, fileSystem });
  const status = aggregateStatus(envelopes);
  let materialized = [];
  if (args.materialize) {
    if (!['ready', 'ready_with_concerns'].includes(status)) {
      throw new Error(`cannot materialize aggregate agent status ${status}`);
    }
    const validationPlan = args.validationPlan
      ? JSON.parse(fileSystem.readFileSync(
        projectFile(projectRoot, args.validationPlan, 'validation plan'),
        'utf8',
      ))
      : { schemaVersion: 1, commands: [] };
    materialized = materializeEnvelopeSet(entries, {
      projectRoot,
      fileSystem,
      validateStagedArtifacts: (artifacts) => runValidationPlan(
        validationPlan,
        artifacts,
        projectRoot,
      ),
    });
    if (args.materializationState) {
      recordMaterializationState(
        projectFile(projectRoot, args.materializationState, 'materialization state'),
        projectRoot,
        args.phase,
        materialized,
        { fileSystem },
      );
    }
  }
  const result = {
    schemaVersion: 1,
    status,
    envelopeCount: envelopes.length,
    agentDispatchCount: envelopes.length,
    agentToolCallCount: 0,
    concerns: envelopes.flatMap((envelope) => envelope.concerns.map((concern) => ({
      agent: envelope.agent,
      concern,
    }))),
    clarifications: envelopes
      .filter((envelope) => envelope.clarification)
      .map((envelope) => ({ agent: envelope.agent, ...envelope.clarification })),
    artifacts: envelopes.flatMap((envelope) => envelope.artifacts.map((artifact) => ({
      agent: envelope.agent,
      artifactId: artifact.artifactId,
      targetPath: artifact.targetPath,
    }))),
    materialized,
  };
  if (args.output) {
    atomicWriteJson(projectFile(projectRoot, args.output, 'output'), result, fileSystem);
  }
  return result;
}

function main(argv = process.argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = run(args);
    if (args.json || !args.output) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'blocked') return 2;
    if (result.status === 'needs_context') return 3;
    if (result.status === 'needs_clarification') return 4;
    return 0;
  } catch (error) {
    process.stderr.write(`agent-return-envelope: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  aggregateStatus,
  atomicWriteJson,
  main,
  parseArgs,
  recordMaterializationState,
  run,
  runValidationPlan,
};