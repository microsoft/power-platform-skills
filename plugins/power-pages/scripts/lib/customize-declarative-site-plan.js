const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UUID_REGEX } = require('./validation-helpers');

const PLAN_SCHEMA_VERSION = 1;
const EXECUTION_SCHEMA_VERSION = 1;
const ALLOWED_SKILLS = new Set([
  'author-web-file',
  'author-content-snippet',
  'author-web-template',
  'author-page-template',
  'author-webpage',
  'author-webpage-content',
  'style-site',
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function validateCustomizationPlan(plan) {
  assertObject(plan, 'plan');

  const required = [
    'schemaVersion',
    'site',
    'summary',
    'preservation',
    'aesthetic',
    'mood',
    'capabilities',
    'operations',
    'warnings',
    'verification',
    'deployment',
  ];
  const missing = required.filter((key) => !(key in plan));
  if (missing.length > 0) {
    throw new Error(`Missing required plan keys: ${missing.join(', ')}`);
  }
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${plan.schemaVersion}`);
  }
  if ('modelVersion' in plan) {
    throw new Error('modelVersion is deployment-only and must not appear in a customization plan');
  }

  assertObject(plan.site, 'site');
  if ('modelVersion' in plan.site) {
    throw new Error(
      'site.modelVersion is deployment-only and must not appear in a customization plan'
    );
  }
  for (const key of ['name', 'websiteRecordId', 'siteRoot', 'languages']) {
    if (!(key in plan.site)) throw new Error(`site.${key} is required`);
  }
  assertString(plan.site.name, 'site.name');
  assertString(plan.site.websiteRecordId, 'site.websiteRecordId');
  if (!UUID_REGEX.test(plan.site.websiteRecordId)) {
    throw new Error('site.websiteRecordId must be a UUID');
  }
  assertString(plan.site.siteRoot, 'site.siteRoot');
  if (path.isAbsolute(plan.site.siteRoot) || plan.site.siteRoot.split(/[\\/]/).includes('..')) {
    throw new Error('site.siteRoot must be a project-relative path without parent traversal');
  }
  assertStringArray(plan.site.languages, 'site.languages');
  for (const key of ['summary', 'preservation']) assertString(plan[key], key);
  for (const key of ['aesthetic', 'mood']) {
    if (plan[key] !== null) assertString(plan[key], key);
  }
  for (const key of ['capabilities', 'operations', 'warnings', 'verification', 'deployment']) {
    if (!Array.isArray(plan[key])) throw new Error(`${key} must be an array`);
  }

  const operationIds = new Set();
  const operationsById = new Map();
  for (const operation of plan.operations) {
    assertObject(operation, 'every operation');
    if (typeof operation.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(operation.id)) {
      throw new Error('every operation id must be kebab-case');
    }
    if (operationIds.has(operation.id)) {
      throw new Error(`duplicate operation id ${operation.id}`);
    }
    if (!ALLOWED_SKILLS.has(operation.skill)) {
      throw new Error(`unsupported operation skill ${operation.skill}`);
    }
    assertString(operation.action, `operation ${operation.id}.action`);
    for (const key of ['target', 'inputs', 'outputBindings']) {
      assertObject(operation[key], `operation ${operation.id}.${key}`);
    }
    for (const key of ['locales', 'dependsOn', 'preserve', 'expectedOutputs']) {
      if (!Array.isArray(operation[key])) {
        throw new Error(`operation ${operation.id}.${key} must be an array`);
      }
    }
    assertStringArray(operation.locales, `operation ${operation.id}.locales`);
    assertStringArray(operation.dependsOn, `operation ${operation.id}.dependsOn`);
    assertStringArray(operation.preserve, `operation ${operation.id}.preserve`);
    assertStringArray(operation.expectedOutputs, `operation ${operation.id}.expectedOutputs`);

    for (const dependency of operation.dependsOn) {
      if (!operationIds.has(dependency)) {
        throw new Error(
          `operation ${operation.id} depends on ${dependency}, which must appear earlier`
        );
      }
    }
    for (const [inputName, binding] of Object.entries(operation.outputBindings)) {
      assertString(inputName, `operation ${operation.id}.outputBindings key`);
      if (inputName in operation.inputs) {
        throw new Error(
          `operation ${operation.id} input ${inputName} cannot be both static and output-bound`
        );
      }
      assertObject(binding, `operation ${operation.id}.outputBindings.${inputName}`);
      assertString(
        binding.sourceOperation,
        `operation ${operation.id}.outputBindings.${inputName}.sourceOperation`
      );
      assertString(binding.output, `operation ${operation.id}.outputBindings.${inputName}.output`);
      if (!operation.dependsOn.includes(binding.sourceOperation)) {
        throw new Error(
          `operation ${operation.id} output binding ${inputName} must reference an operation in dependsOn`
        );
      }
      const sourceOperation = operationsById.get(binding.sourceOperation);
      if (!sourceOperation.expectedOutputs.includes(binding.output)) {
        throw new Error(
          `operation ${operation.id} output binding ${inputName} references undeclared output ` +
            `${binding.output} from ${binding.sourceOperation}`
        );
      }
    }
    operationIds.add(operation.id);
    operationsById.set(operation.id, operation);
  }

  return plan;
}

function canonicalPlanJson(plan) {
  validateCustomizationPlan(plan);
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function planHash(plan) {
  return hashText(canonicalPlanJson(plan));
}

function createRunId(now = new Date()) {
  return `customize-${now.toISOString().replace(/[-:.]/g, '').replace('T', '-')}`;
}

function createExecutionReceipt(plan, runId, hash, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    runId,
    planHash: hash,
    status: 'approved',
    site: {
      websiteRecordId: plan.site.websiteRecordId,
      siteRoot: plan.site.siteRoot,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      status: 'pending',
      attempt: 0,
      outputs: {},
      error: null,
    })),
  };
}

function customizationPaths(projectRoot) {
  const root = path.join(path.resolve(projectRoot), 'docs', 'customize-declarative-site');
  return {
    root,
    historyRoot: path.join(root, 'history'),
    currentJson: path.join(root, 'current-plan.json'),
    currentHtml: path.join(root, 'current-plan.html'),
    currentExecution: path.join(root, 'current-execution.json'),
    currentIcon: path.join(root, 'power-pages-icon.png'),
  };
}

function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = {
  ALLOWED_SKILLS,
  EXECUTION_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  canonicalPlanJson,
  createExecutionReceipt,
  createRunId,
  customizationPaths,
  hashText,
  planHash,
  validateCustomizationPlan,
  writeFileAtomic,
  writeJsonAtomic,
};
