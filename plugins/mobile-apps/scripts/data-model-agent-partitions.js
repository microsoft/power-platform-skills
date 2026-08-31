#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { sha256 } = require('./build-dataverse-operation-manifest');
const {
  assertSafeTarget,
  sealWorkOrder,
  stableJson,
} = require('./lib/agent-return-envelope');
const { atomicWriteJson } = require('./lib/agent-return-runtime');
const {
  completeDataModelWorkOrders,
  dataModelRequestHash,
  extractTypedResult,
  expandDataModelPartitionPlan,
  initializeDataModelPartitionPlan,
  mergeCompletedDataModelPlan,
  pendingDataModelWorkOrders,
  prepareDataModelPartitionRepair,
  refreshDataModelPartitionPlan,
  recordDataModelPartitionResult,
} = require('./lib/data-model-agent-partitions');

function parseArgs(argv) {
  const args = { findings: [] };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--request') args.request = argv[++index];
    else if (token === '--state') args.state = argv[++index];
    else if (token === '--result') args.result = argv[++index];
    else if (token === '--partition-id') args.partitionId = argv[++index];
    else if (token === '--output') args.output = argv[++index];
    else if (token === '--max-payload-bytes') args.maxPayloadBytes = argv[++index];
    else if (token === '--finding') args.findings.push(argv[++index]);
    else if (token === '--initialize') args.action = 'initialize';
    else if (token === '--expand-topology') args.action = 'expand-topology';
    else if (token === '--record-result') args.action = 'record-result';
    else if (token === '--prepare-repair') args.action = 'prepare-repair';
    else if (token === '--refresh-request') args.action = 'refresh-request';
    else if (token === '--resume') args.action = 'resume';
    else if (token === '--merge') args.action = 'merge';
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node data-model-agent-partitions.js --project-root <dir> --request <json>',
    '  --initialize [--max-payload-bytes <bytes>] [--state <json>]',
    '  --expand-topology --result <validated-result-json> [--state <json>]',
    '  --record-result --partition-id <id> --result <validated-result-json>',
    '  --prepare-repair --partition-id <id> --finding <text> [--finding <text>]',
    '  --refresh-request',
    '  --resume [--state <json>]',
    '  --merge [--output <semantic-json>] [--state <json>]',
  ].join('\n');
}

function projectFile(projectRoot, file, label, defaultPath = null) {
  const selected = file || defaultPath;
  if (!selected) throw new Error(`${label} is required`);
  const resolved = path.resolve(projectRoot, selected);
  try {
    return assertSafeTarget(projectRoot, resolved, fs);
  } catch (error) {
    throw new Error(`${label} is unsafe: ${error.message}`);
  }
}

function relativeProjectPath(projectRoot, file) {
  return path.relative(projectRoot, file).replace(/\\/g, '/');
}

function readJson(file, fileSystem) {
  return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
}

function atomicWriteStableJson(file, value, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, stableJson(value), 'utf8');
    fileSystem.renameSync(temporary, file);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function writeDerivedFiles(projectRoot, files, fileSystem) {
  for (const file of files) {
    atomicWriteStableJson(projectFile(projectRoot, file.path, 'derived file'), file.value, fileSystem);
  }
}

function loadBoundInputs(args, fileSystem) {
  if (!args.projectRoot) throw new Error('--project-root is required');
  const projectRoot = path.resolve(args.projectRoot);
  const requestFile = projectFile(projectRoot, args.request, '--request');
  const stateFile = projectFile(
    projectRoot,
    args.state,
    '--state',
    '.tmp/data-model-partition-state.json',
  );
  return {
    projectRoot,
    requestFile,
    request: readJson(requestFile, fileSystem),
    stateFile,
  };
}

function assertCheckpointFile(projectRoot, record, fileSystem) {
  const workOrderFile = projectFile(projectRoot, record.workOrderPath, 'checkpoint work order');
  if (!fileSystem.existsSync(workOrderFile)) {
    throw new Error(`${record.partitionId} work order is missing`);
  }
  const workOrder = readJson(workOrderFile, fileSystem);
  if (workOrder.inputFingerprint !== record.inputFingerprint) {
    throw new Error(`${record.partitionId} work-order fingerprint changed`);
  }
  if (sealWorkOrder(workOrder).inputFingerprint !== record.inputFingerprint) {
    throw new Error(`${record.partitionId} work-order content no longer matches its fingerprint`);
  }
  const measuredBytes = Buffer.byteLength(stableJson(workOrder), 'utf8');
  if (measuredBytes !== record.payloadBytes) {
    throw new Error(`${record.partitionId} work-order byte count changed`);
  }
  if (record.status === 'complete') {
    const resultFile = projectFile(projectRoot, record.resultPath, 'checkpoint result');
    if (!fileSystem.existsSync(resultFile)) throw new Error(`${record.partitionId} result is missing`);
    const sourceText = fileSystem.readFileSync(resultFile, 'utf8');
    if (sha256(sourceText) !== record.resultFileHash) {
      throw new Error(`${record.partitionId} result file changed after completion`);
    }
  }
  return workOrder;
}

function loadTopology(projectRoot, state, fileSystem) {
  if (state.mode !== 'partitioned' || state.topology.status !== 'complete') {
    throw new Error('a completed topology result is required');
  }
  assertCheckpointFile(projectRoot, state.topology, fileSystem);
  const resultFile = projectFile(projectRoot, state.topology.resultPath, 'topology result');
  return extractTypedResult(
    readJson(resultFile, fileSystem),
    state.topology.resultType,
    state.topology.resultId,
    state.topology.inputFingerprint,
  );
}

function checkpointRecord(state, partitionId) {
  if (partitionId === 'topology') return state.topology;
  if (state.mode === 'single' && partitionId === 'single') return state.single;
  return state.partitions.find((record) => record.partitionId === partitionId);
}

function checkpointSummary(state, { resumed = false } = {}) {
  return {
    status: state.status,
    mode: state.mode,
    runId: state.runId,
    maxPayloadBytes: state.maxPayloadBytes,
    pendingPartitionIds: pendingDataModelWorkOrders(state).map((record) => record.partitionId),
    completedPartitionIds: completeDataModelWorkOrders(state).map((record) => record.partitionId),
    resumed,
    metrics: state.metrics,
  };
}

function run(args, fileSystem = fs) {
  const inputs = loadBoundInputs(args, fileSystem);
  const { projectRoot, requestFile, request, stateFile } = inputs;
  if (args.action === 'initialize') {
    if (fileSystem.existsSync(stateFile)) {
      const previous = readJson(stateFile, fileSystem);
      const requestHash = dataModelRequestHash(request);
      if (previous.runId === request.runId) {
        if (previous.requestHash !== requestHash) {
          throw new Error('data-model partition request changed within the same run');
        }
        for (const record of [previous.single, previous.topology, ...previous.partitions].filter(Boolean)) {
          assertCheckpointFile(projectRoot, record, fileSystem);
        }
        previous.metrics.resumedWorkOrderCount += completeDataModelWorkOrders(previous).length;
        atomicWriteJson(stateFile, previous, fileSystem);
        return checkpointSummary(previous, { resumed: true });
      }
    }
    const initialized = initializeDataModelPartitionPlan(request, {
      maxPayloadBytes: args.maxPayloadBytes,
      requestPath: relativeProjectPath(projectRoot, requestFile),
    });
    writeDerivedFiles(projectRoot, initialized.files, fileSystem);
    atomicWriteJson(stateFile, initialized.state, fileSystem);
    return checkpointSummary(initialized.state);
  }
  if (!fileSystem.existsSync(stateFile)) throw new Error('data-model partition state is missing');
  const state = readJson(stateFile, fileSystem);

  if (args.action === 'expand-topology') {
    assertCheckpointFile(projectRoot, state.topology, fileSystem);
    const resultFile = projectFile(projectRoot, args.result, '--result');
    const resultSourceText = fileSystem.readFileSync(resultFile, 'utf8');
    const resultValue = JSON.parse(resultSourceText);
    const expanded = expandDataModelPartitionPlan(state, request, resultValue, {
      resultPath: relativeProjectPath(projectRoot, resultFile),
      resultSourceText,
      responsePayloadBytes: resultValue.responsePayloadBytes,
    });
    writeDerivedFiles(projectRoot, expanded.files, fileSystem);
    atomicWriteJson(stateFile, expanded.state, fileSystem);
    return checkpointSummary(expanded.state, { resumed: expanded.resumed });
  }

  if (args.action === 'record-result') {
    const partitionId = requiredArgument(args.partitionId, '--partition-id');
    const partitionRecord = checkpointRecord(state, partitionId);
    if (!partitionRecord) throw new Error(`unknown data-model partition ${partitionId}`);
    assertCheckpointFile(projectRoot, partitionRecord, fileSystem);
    const resultFile = projectFile(projectRoot, args.result, '--result');
    const resultSourceText = fileSystem.readFileSync(resultFile, 'utf8');
    const resultValue = JSON.parse(resultSourceText);
    const topology = state.mode === 'partitioned'
      ? loadTopology(projectRoot, state, fileSystem)
      : null;
    const recorded = recordDataModelPartitionResult(
      state,
      request,
      partitionId,
      resultValue,
      {
        resultPath: relativeProjectPath(projectRoot, resultFile),
        resultSourceText,
        responsePayloadBytes: resultValue.responsePayloadBytes,
        topologyValue: topology,
      },
    );
    atomicWriteJson(stateFile, recorded.state, fileSystem);
    return checkpointSummary(recorded.state, { resumed: recorded.resumed });
  }

  if (args.action === 'prepare-repair') {
    const partitionId = requiredArgument(args.partitionId, '--partition-id');
    const record = checkpointRecord(state, partitionId);
    if (!record) throw new Error(`unknown data-model partition ${partitionId}`);
    assertCheckpointFile(projectRoot, record, fileSystem);
    const workOrderFile = projectFile(projectRoot, record.workOrderPath, 'work order');
    const repaired = prepareDataModelPartitionRepair(
      state,
      request,
      partitionId,
      args.findings,
      readJson(workOrderFile, fileSystem),
    );
    atomicWriteStableJson(workOrderFile, repaired.workOrder, fileSystem);
    atomicWriteJson(stateFile, repaired.state, fileSystem);
    return checkpointSummary(repaired.state);
  }

  if (args.action === 'refresh-request') {
    const topology = state.mode === 'partitioned' && state.topology.status === 'complete'
      ? loadTopology(projectRoot, state, fileSystem)
      : null;
    const refreshed = refreshDataModelPartitionPlan(state, request, topology);
    writeDerivedFiles(projectRoot, refreshed.files, fileSystem);
    atomicWriteJson(stateFile, refreshed.state, fileSystem);
    return {
      ...checkpointSummary(refreshed.state),
      invalidatedPartitionIds: refreshed.invalidatedPartitionIds,
    };
  }

  if (args.action === 'resume') {
    for (const record of [state.single, state.topology, ...state.partitions].filter(Boolean)) {
      assertCheckpointFile(projectRoot, record, fileSystem);
    }
    state.metrics.resumedWorkOrderCount += completeDataModelWorkOrders(state).length;
    atomicWriteJson(stateFile, state, fileSystem);
    return checkpointSummary(state, { resumed: true });
  }

  if (args.action === 'merge') {
    for (const record of completeDataModelWorkOrders(state)) {
      assertCheckpointFile(projectRoot, record, fileSystem);
    }
    const values = new Map();
    const resultRecords = state.mode === 'single' ? [state.single] : state.partitions;
    for (const record of resultRecords) {
      values.set(record.partitionId, readJson(
        projectFile(projectRoot, record.resultPath, 'partition result'),
        fileSystem,
      ));
    }
    const topology = state.mode === 'partitioned'
      ? loadTopology(projectRoot, state, fileSystem)
      : null;
    const merged = mergeCompletedDataModelPlan(state, request, values, topology);
    const outputFile = projectFile(
      projectRoot,
      args.output,
      '--output',
      '.tmp/agent-results/data-model-merged.json',
    );
    atomicWriteStableJson(outputFile, merged.semantic, fileSystem);
    merged.state.mergedSemanticPath = relativeProjectPath(projectRoot, outputFile);
    atomicWriteJson(stateFile, merged.state, fileSystem);
    return {
      ...checkpointSummary(merged.state),
      output: merged.state.mergedSemanticPath,
      semanticResultHash: merged.state.mergedSemanticHash,
    };
  }
  throw new Error('choose one data-model partition action');
}

function requiredArgument(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = run(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const diagnostic = {
      status: 'error',
      error: error.message,
      ...(Array.isArray(error.repairPartitionIds)
        ? { repairPartitionIds: error.repairPartitionIds }
        : {}),
    };
    process.stderr.write(`data-model-agent-partitions: ${JSON.stringify(diagnostic)}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  assertCheckpointFile,
  checkpointSummary,
  main,
  parseArgs,
  run,
};