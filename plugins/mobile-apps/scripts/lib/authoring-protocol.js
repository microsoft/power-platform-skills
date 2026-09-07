'use strict';

// This portable wire contract is bundled by both the Player and the skills.
// Keep it free of Node/native dependencies so requests are checked at both ends.
const PROTOCOL_VERSION = 2;
const PROTOCOL_ID = 'powerapps.mobile.authoring';
const OPERATIONS = Object.freeze(['prototype', 'edit', 'teach', 'connect']);
const SCREEN_STATES = Object.freeze(['planned', 'building', 'checking', 'ready', 'failed']);
const JOB_STATES = Object.freeze([
  'queued', 'preparingWorkspace', 'awaitingSkill', 'awaitingApproval',
  'generating', 'checking', 'startingMetro', 'ready', 'failed', 'cancelled', 'interrupted',
]);
const DECISIONS = Object.freeze(['approve', 'reject', 'revise', 'apply', 'discard']);
const TARGET_ROLES = Object.freeze(['screen', 'collection', 'item', 'form', 'field', 'action', 'surface']);
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function text(value, label, maximum = 500, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maximum) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${maximum} characters`);
  }
  return value.trim();
}

function id(value, label) {
  const result = text(value, label, 128);
  if (!IDENTIFIER.test(result)) throw new Error(`${label} has an invalid identifier`);
  return result;
}

function revision(value, label, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length !== 64 || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 revision`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer at least ${minimum}`);
  }
  return value;
}

function strings(value, label, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be an array of at most ${maximum} strings`);
  }
  return value.map((entry, index) => text(entry, `${label}[${index}]`, 1000));
}

function enumeration(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`${label} is unsupported`);
  return value;
}

function protocol(value) {
  if (value !== PROTOCOL_VERSION) {
    throw new Error(`Authoring protocol ${PROTOCOL_VERSION} is required`);
  }
  return value;
}

function optionalId(value, label) {
  return value === undefined || value === null ? undefined : id(value, label);
}

function recordReference(value) {
  object(value, 'recordRef');
  return {
    conceptId: id(value.conceptId, 'recordRef.conceptId'),
    recordId: text(value.recordId, 'recordRef.recordId', 256),
    ...(value.label === undefined ? {} : { label: text(value.label, 'recordRef.label', 200) }),
  };
}

function assertContext(value) {
  object(value, 'context');
  const result = {
    protocolVersion: protocol(value.protocolVersion),
    appInstanceId: id(value.appInstanceId, 'context.appInstanceId'),
    jobId: id(value.jobId, 'context.jobId'),
    previewRevision: revision(value.previewRevision, 'context.previewRevision'),
    scope: enumeration(value.scope || 'app', ['app', 'screen', 'target'], 'context.scope'),
  };
  if (value.screenId !== undefined) result.screenId = id(value.screenId, 'context.screenId');
  if (value.route !== undefined) {
    result.route = text(value.route, 'context.route', 500);
    if (!result.route.startsWith('/') || /[?#\\]/.test(result.route)) {
      throw new Error('context.route must be a canonical route without query data');
    }
  }
  if (value.targetId !== undefined) result.targetId = id(value.targetId, 'context.targetId');
  if (value.actionId !== undefined) result.actionId = id(value.actionId, 'context.actionId');
  if (value.label !== undefined) result.label = text(value.label, 'context.label', 200);
  if (value.recordRef !== undefined) result.recordRef = recordReference(value.recordRef);
  if (result.scope !== 'app' && (!result.screenId || !result.route)) {
    throw new Error('Screen and target context require screenId and route');
  }
  if (result.scope === 'target' && !result.targetId) {
    throw new Error('Target context requires a registered targetId');
  }
  if (value.hasUnsavedChanges !== undefined) {
    if (typeof value.hasUnsavedChanges !== 'boolean') throw new Error('hasUnsavedChanges must be a boolean');
    result.hasUnsavedChanges = value.hasUnsavedChanges;
  }
  // Raw record fields, photos, credentials, and source paths are not wire inputs.
  for (const forbidden of ['fields', 'record', 'photo', 'token', 'projectRoot', 'sourcePath']) {
    if (Object.prototype.hasOwnProperty.call(value, forbidden)) {
      throw new Error(`context.${forbidden} is not permitted`);
    }
  }
  return result;
}

function assertTarget(value) {
  object(value, 'target');
  const bounds = object(value.bounds, 'target.bounds');
  const normalizedBounds = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key])
      || Math.abs(bounds[key]) > 100000 || (['width', 'height'].includes(key) && bounds[key] <= 0)) {
      throw new Error(`target.bounds.${key} is invalid`);
    }
    normalizedBounds[key] = bounds[key];
  }
  return {
    id: id(value.id, 'target.id'),
    screenId: id(value.screenId, 'target.screenId'),
    label: text(value.label, 'target.label', 200),
    role: enumeration(value.role, TARGET_ROLES, 'target.role'),
    bounds: normalizedBounds,
    ...(value.actionId === undefined ? {} : { actionId: id(value.actionId, 'target.actionId') }),
    ...(value.recordRef === undefined ? {} : { recordRef: recordReference(value.recordRef) }),
  };
}

function assertIntegrationSelection(value) {
  object(value, 'integration');
  const kind = enumeration(value.kind, ['native', 'connector'], 'integration.kind');
  const catalogRevision = revision(value.catalogRevision, 'integration.catalogRevision');
  const allowed = kind === 'native'
    ? ['kind', 'catalogRevision', 'capabilityId']
    : ['kind', 'catalogRevision', 'apiId', 'environmentId', 'connectionId', 'connectionRef'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`integration.${key} is not permitted`);
  }
  if (kind === 'native') {
    return { kind, catalogRevision, capabilityId: id(value.capabilityId, 'integration.capabilityId') };
  }
  const apiId = text(value.apiId, 'integration.apiId', 500);
  if (!/^(?:\/providers\/Microsoft\.PowerApps\/apis\/)?[a-zA-Z0-9_.-]+$/.test(apiId)) {
    throw new Error('integration.apiId must identify a connector, not a URL or command');
  }
  const result = { kind, catalogRevision, apiId, environmentId: id(value.environmentId, 'integration.environmentId') };
  if (value.connectionId !== undefined) {
    result.connectionId = text(value.connectionId, 'integration.connectionId', 1000);
    if (!/^[a-zA-Z0-9_./:-]+$/.test(result.connectionId) || result.connectionId.includes('://')
      || result.connectionId.split('/').includes('..')) {
      throw new Error('integration.connectionId is invalid');
    }
  }
  if (value.connectionRef !== undefined) result.connectionRef = id(value.connectionRef, 'integration.connectionRef');
  if (!!result.connectionId === !!result.connectionRef) {
    throw new Error('Choose exactly one existing connection or connection reference');
  }
  return result;
}

function assertJobRequest(value) {
  object(value, 'job request');
  const result = {
    protocolVersion: protocol(value.protocolVersion),
    operation: enumeration(value.operation, OPERATIONS, 'operation'),
    prompt: text(value.prompt, 'prompt', 16000),
    baseRevision: revision(value.baseRevision, 'baseRevision', true),
  };
  if (value.appName !== undefined) result.appName = text(value.appName, 'appName', 100);
  if (value.appInstanceId !== undefined) result.appInstanceId = id(value.appInstanceId, 'appInstanceId');
  if (value.context !== undefined) result.context = assertContext(value.context);
  if (value.integration !== undefined) {
    if (result.operation !== 'edit') throw new Error('Integration selections belong to an explicit edit operation');
    result.integration = assertIntegrationSelection(value.integration);
  }
  if (result.operation !== 'prototype' && (!result.appInstanceId || !result.baseRevision)) {
    throw new Error('Follow-up operations require appInstanceId and baseRevision');
  }
  if (result.context && (result.context.appInstanceId !== result.appInstanceId
    || result.context.previewRevision !== result.baseRevision)) {
    throw new Error('Context does not match the requested app revision');
  }
  return result;
}

function assertScreen(value) {
  object(value, 'screen');
  const route = text(value.route, 'screen.route', 500);
  if (!route.startsWith('/') || /[?#\\]/.test(route)) throw new Error('screen.route is invalid');
  return {
    id: id(value.id, 'screen.id'),
    title: text(value.title, 'screen.title', 200),
    route,
    state: enumeration(value.state || 'planned', SCREEN_STATES, 'screen.state'),
    dependencies: strings(value.dependencies || [], 'screen.dependencies').map((entry) => id(entry, 'dependency')),
    ...(value.detail === undefined ? {} : { detail: text(value.detail, 'screen.detail', 1000) }),
  };
}

function assertScreenPlan(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('A screen plan must contain 1-100 screens');
  }
  const screens = value.map(assertScreen);
  const ids = new Set();
  const routes = new Set();
  for (const screen of screens) {
    if (ids.has(screen.id) || routes.has(screen.route)) throw new Error('Screen IDs and routes must be unique');
    ids.add(screen.id);
    routes.add(screen.route);
  }
  for (const screen of screens) {
    for (const dependency of screen.dependencies) {
      if (!ids.has(dependency) || dependency === screen.id) throw new Error('Invalid screen dependency');
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(screens.map((screen) => [screen.id, screen]));
  function visit(screenId) {
    if (visiting.has(screenId)) throw new Error('Screen dependencies contain a cycle');
    if (visited.has(screenId)) return;
    visiting.add(screenId);
    byId.get(screenId).dependencies.forEach(visit);
    visiting.delete(screenId);
    visited.add(screenId);
  }
  screens.forEach((screen) => visit(screen.id));
  return screens;
}

function assertQuestion(value) {
  object(value, 'question');
  const fields = value.fields || [];
  if (!Array.isArray(fields) || fields.length > 12) throw new Error('question.fields is invalid');
  const fieldIds = new Set();
  return {
    id: id(value.id, 'question.id'),
    gateId: id(value.gateId, 'question.gateId'),
    sourceRevision: revision(value.sourceRevision, 'question.sourceRevision'),
    kind: enumeration(value.kind, ['plan', 'clarification', 'apply', 'schema'], 'question.kind'),
    title: text(value.title, 'question.title', 200),
    summary: text(value.summary, 'question.summary', 4000),
    items: strings(value.items || [], 'question.items', 30),
    fields: fields.map((field) => {
      object(field, 'question field');
      const fieldId = id(field.id, 'field.id');
      if (fieldIds.has(fieldId)) throw new Error('Question field IDs must be unique');
      fieldIds.add(fieldId);
      const type = enumeration(field.type, ['text', 'select', 'boolean'], 'field.type');
      const choices = strings(field.choices || [], 'field.choices', 30);
      if (type === 'select' && choices.length === 0) throw new Error('Select fields require choices');
      return { id: fieldId, label: text(field.label, 'field.label', 300), type, choices };
    }),
  };
}

function assertDecision(value) {
  object(value, 'decision');
  const answer = value.answer === undefined ? {} : object(value.answer, 'decision.answer');
  if (Object.keys(answer).length > 12) throw new Error('Too many decision answers');
  const answers = {};
  for (const [key, item] of Object.entries(answer)) {
    id(key, 'answer field');
    if (typeof item !== 'boolean' && (typeof item !== 'string' || item.length > 4000)) {
      throw new Error('Decision answers must be bounded strings or booleans');
    }
    Object.defineProperty(answers, key, { value: item, enumerable: true });
  }
  return {
    approvalId: id(value.approvalId, 'approvalId'),
    approvalRevision: integer(value.approvalRevision, 'approvalRevision', 1),
    action: enumeration(value.action, DECISIONS, 'decision.action'),
    answer: answers,
  };
}

function assertCandidate(value) {
  object(value, 'candidate');
  const readyScreenIds = strings(value.readyScreenIds, 'readyScreenIds').map((entry) => id(entry, 'readyScreenId'));
  if (readyScreenIds.length === 0 || new Set(readyScreenIds).size !== readyScreenIds.length) {
    throw new Error('A candidate requires unique ready screen IDs');
  }
  const checks = strings(value.checks, 'checks', 30);
  if (!checks.length) throw new Error('A candidate requires its completed readiness checks');
  return {
    id: id(value.id, 'candidate.id'),
    baseRevision: revision(value.baseRevision, 'candidate.baseRevision', true),
    sourceRevision: revision(value.sourceRevision, 'candidate.sourceRevision'),
    dataMode: enumeration(value.dataMode, ['prototype', 'dataverse', 'mixed', 'connector-only'], 'candidate.dataMode'),
    readyScreenIds,
    checks,
    final: value.final === true,
  };
}

function assertCapabilities(value) {
  object(value, 'capabilities');
  protocol(value.protocolVersion);
  if (value.protocolId !== PROTOCOL_ID) throw new Error('This is not the mobile authoring protocol');
  const operations = strings(value.operations, 'operations', OPERATIONS.length);
  operations.forEach((operation) => enumeration(operation, OPERATIONS, 'capability operation'));
  const flags = {};
  for (const key of ['questions', 'candidates', 'progressivePreview', 'contextualEditing', 'teaching', 'dataverseConversion']) {
    if (typeof value[key] !== 'boolean') throw new Error(`Capability ${key} must be a boolean`);
    flags[key] = value[key];
  }
  for (const key of ['nativeCatalog', 'connectorCatalog']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`Capability ${key} must be a boolean`);
    }
    flags[key] = value[key] === true;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    protocolId: PROTOCOL_ID,
    protocolHash: revision(value.protocolHash, 'protocolHash'),
    operations,
    ...flags,
  };
}

module.exports = {
  PROTOCOL_VERSION, PROTOCOL_ID, OPERATIONS, SCREEN_STATES, JOB_STATES, DECISIONS, TARGET_ROLES,
  object, text, id, revision, integer, strings, enumeration, optionalId,
  assertContext, assertTarget, assertIntegrationSelection, assertJobRequest, assertScreen, assertScreenPlan,
  assertQuestion, assertDecision, assertCandidate, assertCapabilities,
};
