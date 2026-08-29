'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const STATUSES = new Set([
  'ready',
  'ready_with_concerns',
  'needs_context',
  'needs_clarification',
  'blocked',
]);
const ENVELOPE_FIELDS = new Set([
  'schemaVersion',
  'status',
  'agent',
  'inputFingerprint',
  'artifacts',
  'concerns',
  'clarification',
]);
const ARTIFACT_FIELDS = new Set(['artifactId', 'targetPath', 'content']);
const CLARIFICATION_FIELDS = new Set(['question', 'reason', 'affectedDecisions']);
const TRUNCATION_PATTERN = /\[(?:output\s+)?truncated\]|<(?:output\s+)?truncated>|content\s+omitted/iu;
const TOOL_BLOCK_PATTERN = /^(?=[\s\S]*(?:missing|unavailable|not available|not exposed))(?=[\s\S]*(?:read|write|edit|bash|task|enterplanmode|exitplanmode|askuserquestion|plan mode|structured question|grep|glob|filesystem|shell|tool surface))[\s\S]*$/iu;

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableClone(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return `${JSON.stringify(stableClone(value), null, 2)}\n`;
}

function fingerprintInput(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function lexicalCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sealWorkOrder(workOrder) {
  if (!isPlainObject(workOrder)) throw new Error('work order must be an object');
  const sealed = structuredClone(workOrder);
  delete sealed.inputFingerprint;
  return {
    ...sealed,
    inputFingerprint: fingerprintInput(sealed),
  };
}

function assertExactFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative));
}

function assertSafeTarget(projectRoot, targetPath, fileSystem = fs) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  if (!path.isAbsolute(targetPath) || !isInside(root, target) || target === root) {
    throw new Error(`targetPath is outside the project root: ${targetPath}`);
  }
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fileSystem.existsSync(current) && fileSystem.lstatSync(current).isSymbolicLink()) {
      throw new Error(`targetPath traverses a symbolic link: ${targetPath}`);
    }
  }
  if (fileSystem.existsSync(target) && fileSystem.lstatSync(target).isSymbolicLink()) {
    throw new Error(`targetPath must not be a symbolic link: ${targetPath}`);
  }
  return target;
}

function normalizeWorkOrder(workOrder, { projectRoot, fileSystem = fs } = {}) {
  if (!isPlainObject(workOrder)) throw new Error('work order must be an object');
  if (workOrder.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`work order schemaVersion must equal ${SCHEMA_VERSION}`);
  }
  assertNonEmptyString(workOrder.agent, 'work order agent');
  assertNonEmptyString(workOrder.workOrderId, 'work order workOrderId');
  assertNonEmptyString(workOrder.inputFingerprint, 'work order inputFingerprint');
  if (sealWorkOrder(workOrder).inputFingerprint !== workOrder.inputFingerprint) {
    throw new Error('work order inputFingerprint does not match its complete content');
  }
  if (!Array.isArray(workOrder.artifacts) || workOrder.artifacts.length === 0) {
    throw new Error('work order artifacts must be a non-empty array');
  }
  const artifactIds = new Set();
  const targetPaths = new Set();
  const artifacts = workOrder.artifacts.map((artifact, index) => {
    if (!isPlainObject(artifact)) throw new Error(`work order artifacts[${index}] must be an object`);
    const keys = Object.keys(artifact);
    if (keys.some((key) => !['artifactId', 'targetPath'].includes(key))) {
      throw new Error(`work order artifacts[${index}] contains unsupported fields`);
    }
    assertNonEmptyString(artifact.artifactId, `work order artifacts[${index}].artifactId`);
    assertNonEmptyString(artifact.targetPath, `work order artifacts[${index}].targetPath`);
    const targetPath = projectRoot
      ? assertSafeTarget(projectRoot, artifact.targetPath, fileSystem)
      : path.resolve(artifact.targetPath);
    if (artifactIds.has(artifact.artifactId)) {
      throw new Error(`work order contains duplicate artifactId ${artifact.artifactId}`);
    }
    if (targetPaths.has(targetPath)) {
      throw new Error(`work order contains duplicate targetPath ${targetPath}`);
    }
    artifactIds.add(artifact.artifactId);
    targetPaths.add(targetPath);
    return { artifactId: artifact.artifactId, targetPath };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    agent: workOrder.agent,
    workOrderId: workOrder.workOrderId,
    inputFingerprint: workOrder.inputFingerprint,
    artifacts,
  };
}

function parseJsonObject(responseText) {
  if (typeof responseText !== 'string' || !responseText.trim()) {
    throw new Error('agent response must be non-empty text');
  }
  const trimmed = responseText.trim();
  if (!trimmed.startsWith('{')) {
    throw new Error('agent response must be exactly one JSON object with no Markdown or prose');
  }
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`agent response is invalid JSON: ${error.message}`);
  }
  if (!isPlainObject(value)) throw new Error('agent response must be a JSON object');
  return value;
}

function normalizeClarification(value, status) {
  if (status !== 'needs_clarification') {
    if (value !== null) throw new Error('clarification must be null for this status');
    return null;
  }
  if (!isPlainObject(value)) {
    throw new Error('needs_clarification requires a clarification object');
  }
  assertExactFields(value, CLARIFICATION_FIELDS, 'clarification');
  assertNonEmptyString(value.question, 'clarification.question');
  assertNonEmptyString(value.reason, 'clarification.reason');
  assertStringArray(value.affectedDecisions, 'clarification.affectedDecisions');
  return {
    question: value.question.trim(),
    reason: value.reason.trim(),
    affectedDecisions: value.affectedDecisions.map((item) => item.trim()),
  };
}

function validateArtifact(artifact, index, requestedById, projectRoot, fileSystem) {
  if (!isPlainObject(artifact)) throw new Error(`artifacts[${index}] must be an object`);
  assertExactFields(artifact, ARTIFACT_FIELDS, `artifacts[${index}]`);
  assertNonEmptyString(artifact.artifactId, `artifacts[${index}].artifactId`);
  assertNonEmptyString(artifact.targetPath, `artifacts[${index}].targetPath`);
  assertNonEmptyString(artifact.content, `artifacts[${index}].content`);
  if (TRUNCATION_PATTERN.test(artifact.content)) {
    throw new Error(`artifacts[${index}].content contains a truncation marker`);
  }
  const requested = requestedById.get(artifact.artifactId);
  if (!requested) throw new Error(`artifactId was not requested: ${artifact.artifactId}`);
  const targetPath = assertSafeTarget(projectRoot, artifact.targetPath, fileSystem);
  if (targetPath !== requested.targetPath) {
    throw new Error(`targetPath is not allowlisted for ${artifact.artifactId}`);
  }
  return {
    artifactId: artifact.artifactId,
    targetPath,
    content: artifact.content,
  };
}

function parseAgentEnvelope(responseText, workOrder, {
  projectRoot,
  fileSystem = fs,
} = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  const normalizedWorkOrder = normalizeWorkOrder(workOrder, { projectRoot, fileSystem });
  const envelope = parseJsonObject(responseText);
  assertExactFields(envelope, ENVELOPE_FIELDS, 'response');
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`response schemaVersion must equal ${SCHEMA_VERSION}`);
  }
  if (!STATUSES.has(envelope.status)) throw new Error(`unsupported response status: ${envelope.status}`);
  if (envelope.agent !== normalizedWorkOrder.agent) {
    throw new Error(`response agent must equal ${normalizedWorkOrder.agent}`);
  }
  if (envelope.inputFingerprint !== normalizedWorkOrder.inputFingerprint) {
    throw new Error('response inputFingerprint does not match the work order');
  }
  assertStringArray(envelope.concerns, 'response concerns');
  if (!Array.isArray(envelope.artifacts)) throw new Error('response artifacts must be an array');
  const clarification = normalizeClarification(envelope.clarification, envelope.status);
  const contentReady = ['ready', 'ready_with_concerns'].includes(envelope.status);
  if (!contentReady && envelope.artifacts.length !== 0) {
    throw new Error(`${envelope.status} responses must not contain artifacts`);
  }
  if (envelope.status === 'ready' && envelope.concerns.length !== 0) {
    throw new Error('ready responses must not contain concerns');
  }
  if (['ready_with_concerns', 'needs_context', 'blocked'].includes(envelope.status)
    && envelope.concerns.length === 0) {
    throw new Error(`${envelope.status} requires at least one concern`);
  }
  if (envelope.status === 'blocked'
    && envelope.concerns.some((concern) => TOOL_BLOCK_PATTERN.test(concern))) {
    throw new Error('child tool unavailability is not a substantive blocked condition');
  }

  const requestedById = new Map(normalizedWorkOrder.artifacts.map(
    (artifact) => [artifact.artifactId, artifact],
  ));
  const artifacts = envelope.artifacts.map((artifact, index) => validateArtifact(
    artifact,
    index,
    requestedById,
    projectRoot,
    fileSystem,
  ));
  const returnedIds = new Set(artifacts.map((artifact) => artifact.artifactId));
  if (returnedIds.size !== artifacts.length) throw new Error('response contains duplicate artifactIds');
  if (new Set(artifacts.map((artifact) => artifact.targetPath)).size !== artifacts.length) {
    throw new Error('response contains duplicate targetPaths');
  }
  if (contentReady && normalizedWorkOrder.artifacts.some(
    (artifact) => !returnedIds.has(artifact.artifactId),
  )) {
    throw new Error('ready response is missing one or more requested artifacts');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    status: envelope.status,
    agent: envelope.agent,
    inputFingerprint: envelope.inputFingerprint,
    artifacts,
    concerns: envelope.concerns.map((item) => item.trim()),
    clarification,
  };
}

function validateEnvelopeSet(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('at least one agent response is required');
  }
  const envelopes = entries.map((entry) => parseAgentEnvelope(
    entry.responseText,
    entry.workOrder,
    options,
  ));
  const targets = new Map();
  const artifactIds = new Map();
  for (const envelope of envelopes) {
    for (const artifact of envelope.artifacts) {
      if (artifactIds.has(artifact.artifactId)) {
        throw new Error(
          `duplicate artifactId across agent responses: ${artifact.artifactId}`,
        );
      }
      if (targets.has(artifact.targetPath)) {
        throw new Error(
          `duplicate targetPath across agent responses: ${artifact.targetPath}`,
        );
      }
      artifactIds.set(artifact.artifactId, envelope.agent);
      targets.set(artifact.targetPath, envelope.agent);
    }
  }
  return envelopes;
}

function partitionEnvelopeSet(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('at least one agent response is required');
  }
  const valid = [];
  const failures = [];
  for (const [index, entry] of entries.entries()) {
    try {
      valid.push({
        index,
        workOrder: entry.workOrder,
        envelope: parseAgentEnvelope(entry.responseText, entry.workOrder, options),
      });
    } catch (error) {
      failures.push({
        index,
        agent: entry.workOrder?.agent || null,
        inputFingerprint: entry.workOrder?.inputFingerprint || null,
        error: error.message,
      });
    }
  }
  if (valid.length > 0) {
    validateEnvelopeSet(valid.map((entry) => ({
      workOrder: entry.workOrder,
      responseText: JSON.stringify(entry.envelope),
    })), options);
  }
  return { valid, failures };
}

function materializeEnvelopeSet(entries, {
  projectRoot,
  fileSystem = fs,
  validateArtifactContent = () => [],
  validateStagedArtifacts = () => [],
} = {}) {
  const envelopes = validateEnvelopeSet(entries, { projectRoot, fileSystem });
  const artifacts = envelopes.flatMap((envelope) => envelope.artifacts.map((artifact) => ({
    ...artifact,
    agent: envelope.agent,
  }))).sort((left, right) => (
    lexicalCompare(left.targetPath, right.targetPath)
      || lexicalCompare(left.artifactId, right.artifactId)
  ));
  for (const artifact of artifacts) {
    const findings = validateArtifactContent(artifact);
    if (!Array.isArray(findings)) {
      throw new Error('validateArtifactContent must return an array');
    }
    if (findings.length > 0) {
      throw new Error(`${artifact.artifactId} failed validation: ${findings.join('; ')}`);
    }
  }

  const staged = [];
  const installed = [];
  try {
    for (const artifact of artifacts) {
      fileSystem.mkdirSync(path.dirname(artifact.targetPath), { recursive: true });
      const extension = path.extname(artifact.targetPath);
      const baseName = path.basename(artifact.targetPath, extension);
      const temporary = path.join(
        path.dirname(artifact.targetPath),
        `.${baseName}.agent-${process.pid}-${crypto.randomUUID()}${extension}`,
      );
      fileSystem.writeFileSync(temporary, artifact.content, { encoding: 'utf8', flag: 'wx' });
      staged.push({ ...artifact, temporary });
    }
    const stagedFindings = validateStagedArtifacts(staged.map((artifact) => ({
      agent: artifact.agent,
      artifactId: artifact.artifactId,
      targetPath: artifact.targetPath,
      stagedPath: artifact.temporary,
    })));
    if (!Array.isArray(stagedFindings)) {
      throw new Error('validateStagedArtifacts must return an array');
    }
    if (stagedFindings.length > 0) {
      throw new Error(`staged artifact validation failed: ${stagedFindings.join('; ')}`);
    }
    for (const artifact of staged) {
      let backup = null;
      if (fileSystem.existsSync(artifact.targetPath)) {
        backup = `${artifact.targetPath}.agent-backup-${process.pid}-${crypto.randomUUID()}`;
        fileSystem.renameSync(artifact.targetPath, backup);
      }
      try {
        fileSystem.renameSync(artifact.temporary, artifact.targetPath);
        installed.push({ targetPath: artifact.targetPath, backup });
      } catch (error) {
        if (backup && fileSystem.existsSync(backup)) {
          fileSystem.renameSync(backup, artifact.targetPath);
        }
        throw error;
      }
    }
    for (const artifact of installed) {
      if (artifact.backup && fileSystem.existsSync(artifact.backup)) {
        fileSystem.rmSync(artifact.backup, { force: true });
      }
    }
  } catch (error) {
    for (const artifact of [...installed].reverse()) {
      if (fileSystem.existsSync(artifact.targetPath)) {
        fileSystem.rmSync(artifact.targetPath, { force: true });
      }
      if (artifact.backup && fileSystem.existsSync(artifact.backup)) {
        fileSystem.renameSync(artifact.backup, artifact.targetPath);
      }
    }
    throw error;
  } finally {
    for (const artifact of staged) {
      if (fileSystem.existsSync(artifact.temporary)) {
        fileSystem.rmSync(artifact.temporary, { force: true });
      }
    }
  }
  return artifacts.map(({ agent, artifactId, targetPath }) => ({ agent, artifactId, targetPath }));
}

module.exports = {
  SCHEMA_VERSION,
  STATUSES,
  fingerprintInput,
  lexicalCompare,
  materializeEnvelopeSet,
  normalizeWorkOrder,
  partitionEnvelopeSet,
  parseAgentEnvelope,
  sealWorkOrder,
  stableJson,
  validateEnvelopeSet,
};