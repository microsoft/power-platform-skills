#!/usr/bin/env node
/**
 * Update or inspect the durable execution receipt for an approved customization plan.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./lib/render-template');
const {
  EXECUTION_SCHEMA_VERSION,
  customizationPaths,
  planHash,
  validateCustomizationPlan,
  writeJsonAtomic,
} = require('./lib/customize-declarative-site-plan');

function main() {
  const args = parseArgs(process.argv);
  if (!args.projectRoot || !args.action) {
    console.error(
      'Usage: node update-customize-declarative-site-execution.js ' +
        '--projectRoot <path> --action <status|resolve|start|complete|fail|finish> ' +
        '[--operationId <id>] [--outputs <json-file>] [--error <message>] ' +
        '[--websiteRecordId <id>] [--siteRoot <relative-path>]'
    );
    process.exit(1);
  }

  try {
    const result = updateExecution({
      projectRoot: path.resolve(args.projectRoot),
      action: args.action,
      operationId: args.operationId || null,
      outputsPath: args.outputs ? path.resolve(args.outputs) : null,
      errorMessage: args.error || null,
      expectedWebsiteRecordId: args.websiteRecordId || null,
      expectedSiteRoot: args.siteRoot || null,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

function updateExecution({
  projectRoot,
  action,
  operationId = null,
  outputsPath = null,
  errorMessage = null,
  expectedWebsiteRecordId = null,
  expectedSiteRoot = null,
  now = new Date(),
}) {
  const paths = customizationPaths(projectRoot);
  const plan = readJson(paths.currentJson, 'current plan');
  validateCustomizationPlan(plan);
  const execution = readJson(paths.currentExecution, 'current execution receipt');
  validateExecutionReceipt(execution, plan);
  validateExpectedIdentity(plan, { expectedWebsiteRecordId, expectedSiteRoot });

  if (action === 'status') return execution;
  if (action === 'resolve') {
    const operation = findOperation(plan, operationId);
    requireDependenciesCompleted(operation, execution);
    return {
      runId: execution.runId,
      planHash: execution.planHash,
      operation,
      ...(plan.newSiteDesign ? {
        designContext: {
          ...plan.newSiteDesign,
          aesthetic: plan.aesthetic,
          mood: plan.mood,
        },
      } : {}),
      resolvedInputs: {
        ...operation.inputs,
        ...resolveOutputBindings(operation, execution),
      },
    };
  }

  const timestamp = now.toISOString();
  if (action === 'finish') {
    const incomplete = execution.operations.filter((entry) => entry.status !== 'completed');
    if (incomplete.length > 0) {
      throw new Error(`cannot finish; incomplete operations: ${incomplete.map((entry) => entry.id).join(', ')}`);
    }
    execution.status = 'completed';
    execution.completedAt = timestamp;
    execution.updatedAt = timestamp;
    writeJsonAtomic(paths.currentExecution, execution);
    return execution;
  }

  const operation = findOperation(plan, operationId);
  const state = execution.operations.find((entry) => entry.id === operation.id);
  if (action === 'start') {
    if (!['pending', 'failed'].includes(state.status)) {
      throw new Error(`operation ${operation.id} must be pending or failed before start`);
    }
    requireDependenciesCompleted(operation, execution);
    state.status = 'running';
    state.startedAt = timestamp;
    state.failedAt = null;
    state.completedAt = null;
    state.attempt = (state.attempt || 0) + 1;
    state.outputs = {};
    state.error = null;
    execution.status = 'in-progress';
  } else if (action === 'complete') {
    if (state.status !== 'running') {
      throw new Error(`operation ${operation.id} must be running before completion`);
    }
    state.outputs = readOutputs(outputsPath);
    const missingOutputs = operation.expectedOutputs.filter((key) => !(key in state.outputs));
    if (missingOutputs.length > 0) {
      throw new Error(
        `operation ${operation.id} outputs are missing: ${missingOutputs.join(', ')}`
      );
    }
    state.status = 'completed';
    state.completedAt = timestamp;
    state.error = null;
  } else if (action === 'fail') {
    if (state.status !== 'running') {
      throw new Error(`operation ${operation.id} must be running before failure`);
    }
    if (!errorMessage || errorMessage.trim() === '') {
      throw new Error('--error is required when marking an operation failed');
    }
    state.status = 'failed';
    state.failedAt = timestamp;
    state.error = errorMessage;
    execution.status = 'failed';
  } else {
    throw new Error(`unsupported action ${action}`);
  }

  execution.updatedAt = timestamp;
  writeJsonAtomic(paths.currentExecution, execution);
  return execution;
}

function validateExpectedIdentity(plan, { expectedWebsiteRecordId, expectedSiteRoot }) {
  if (
    expectedWebsiteRecordId &&
    plan.site.websiteRecordId.toLowerCase() !== expectedWebsiteRecordId.toLowerCase()
  ) {
    throw new Error('current plan websiteRecordId does not match the selected declarative site');
  }
  if (expectedSiteRoot && plan.site.siteRoot !== expectedSiteRoot) {
    throw new Error('current plan siteRoot does not match the selected declarative site');
  }
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON: ${filePath}`);
  }
}

function readOutputs(outputsPath) {
  if (!outputsPath) return {};
  const outputs = readJson(outputsPath, 'operation outputs');
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    throw new Error('operation outputs must be a JSON object');
  }
  return outputs;
}

function validateExecutionReceipt(execution, plan) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new Error('current execution receipt must be an object');
  }
  if (execution.schemaVersion !== EXECUTION_SCHEMA_VERSION) {
    throw new Error(`unsupported execution schemaVersion ${execution.schemaVersion}`);
  }
  if (typeof execution.runId !== 'string' || execution.runId.trim() === '') {
    throw new Error('current execution receipt runId must be a non-empty string');
  }
  if (!['approved', 'in-progress', 'failed', 'completed'].includes(execution.status)) {
    throw new Error(`unsupported execution status ${execution.status}`);
  }
  if (execution.planHash !== planHash(plan)) {
    throw new Error('current execution receipt does not match current-plan.json');
  }
  if (
    execution.site?.websiteRecordId?.toLowerCase() !==
      plan.site.websiteRecordId.toLowerCase() ||
    execution.site?.siteRoot !== plan.site.siteRoot
  ) {
    throw new Error('current execution receipt site identity does not match current-plan.json');
  }
  if (!Array.isArray(execution.operations)) {
    throw new Error('current execution receipt operations must be an array');
  }
  const expectedIds = plan.operations.map((operation) => operation.id);
  const actualIds = execution.operations.map((operation) => operation.id);
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error('current execution receipt operations do not match current-plan.json');
  }
  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];
    const state = execution.operations[index];
    if (!['pending', 'running', 'completed', 'failed'].includes(state.status)) {
      throw new Error(`unsupported execution status for operation ${operation.id}: ${state.status}`);
    }
    if (!Number.isInteger(state.attempt) || state.attempt < 0) {
      throw new Error(`operation ${operation.id} attempt must be a non-negative integer`);
    }
    if (!state.outputs || typeof state.outputs !== 'object' || Array.isArray(state.outputs)) {
      throw new Error(`operation ${operation.id} outputs must be an object`);
    }
    if (state.status === 'completed') {
      const missingOutputs = operation.expectedOutputs.filter((key) => !(key in state.outputs));
      if (missingOutputs.length > 0) {
        throw new Error(
          `completed operation ${operation.id} outputs are missing: ${missingOutputs.join(', ')}`
        );
      }
    }
  }
  if (
    execution.status === 'completed' &&
    execution.operations.some((operation) => operation.status !== 'completed')
  ) {
    throw new Error('completed execution receipt contains incomplete operations');
  }
}

function findOperation(plan, operationId) {
  if (!operationId) throw new Error('--operationId is required for this action');
  const operation = plan.operations.find((entry) => entry.id === operationId);
  if (!operation) throw new Error(`operation not found: ${operationId}`);
  return operation;
}

function requireDependenciesCompleted(operation, execution) {
  const incomplete = operation.dependsOn.filter((dependencyId) => {
    const dependency = execution.operations.find((entry) => entry.id === dependencyId);
    return !dependency || dependency.status !== 'completed';
  });
  if (incomplete.length > 0) {
    throw new Error(
      `operation ${operation.id} has incomplete dependencies: ${incomplete.join(', ')}`
    );
  }
}

function resolveOutputBindings(operation, execution) {
  const resolved = {};
  for (const [inputName, binding] of Object.entries(operation.outputBindings)) {
    const source = execution.operations.find((entry) => entry.id === binding.sourceOperation);
    if (!source || source.status !== 'completed') {
      throw new Error(
        `output binding ${inputName} source ${binding.sourceOperation} is not completed`
      );
    }
    if (!(binding.output in source.outputs)) {
      throw new Error(
        `output binding ${inputName} cannot find ${binding.output} in ${binding.sourceOperation}`
      );
    }
    resolved[inputName] = source.outputs[binding.output];
  }
  return resolved;
}

if (require.main === module) main();

module.exports = {
  readOutputs,
  resolveOutputBindings,
  updateExecution,
  validateExpectedIdentity,
  validateExecutionReceipt,
};
