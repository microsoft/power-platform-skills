'use strict';

const crypto = require('node:crypto');
const { readJson, atomicWrite, assertRevision, revision, writeOwnedFiles } = require('./prototype-files');
const { validateDomain } = require('./prototype-domain');
const { validateRules } = require('./authoring-rules');

const SCOPE = '.tmp/prototype-test-write-scope.json';
const PERMISSION = 'src/data/test-write-permission.json';
const BINDINGS = [SCOPE, '.tmp/prototype-domain.json', '.tmp/prototype-rules.json', '.tmp/prototype-dataverse-mapping.json'];
const GATE = 'prototype-test-writes';

function inputs(root) {
  const journal = readJson(root, '.tmp/prototype-conversion-journal.json');
  if (!journal.completed?.includes('startup')) throw new Error('Connected startup must exist before requesting controlled test writes');
  const domain = validateDomain(readJson(root, '.tmp/prototype-domain.json'));
  const rules = validateRules(domain, readJson(root, '.tmp/prototype-rules.json'));
  const mapping = readJson(root, '.tmp/prototype-dataverse-mapping.json');
  assertRevision(mapping, 'mappingRevision', 'Dataverse mapping');
  if (mapping.domainRevision !== revision(domain)
    || mapping.environmentKey !== revision({ environmentId: readJson(root, 'power.config.json').environmentId })) {
    throw new Error('Test writes cannot use stale domain/environment mappings');
  }
  return { domain, rules, mapping };
}

function prepareTestWriteScope(root, entityIds, { now = Date.now(), randomUUID = crypto.randomUUID } = {}) {
  const { domain, rules, mapping } = inputs(root);
  if (!Array.isArray(entityIds) || !entityIds.length || entityIds.length > 10 || new Set(entityIds).size !== entityIds.length) {
    throw new Error('Select 1–10 unique logical entities; each receives one fresh disposable test record');
  }
  const records = entityIds.map((entityId) => {
    const entry = mapping.entities.find((entity) => entity.entityId === entityId);
    if (entry?.owner !== 'dataverse' || !entry.operations.includes('create')) {
      throw new Error('Controlled test writes require an approved create-capable Dataverse entity');
    }
    return { entityId, recordId: randomUUID(), operations: entry.operations.filter((operation) => ['create', 'update', 'delete'].includes(operation)) };
  });
  const scope = {
    schemaVersion: 1, contractType: 'prototype-test-write-scope', scopeId: randomUUID(),
    appInstanceId: domain.appInstanceId, mappingRevision: mapping.mappingRevision,
    environmentKey: mapping.environmentKey, rulesRevision: revision(rules),
    expiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(), records,
  };
  scope.scopeRevision = revision(scope);
  atomicWrite(root, SCOPE, scope);
  return { ok: true, scope, bind: BINDINGS, gateId: GATE };
}

function currentScope(root, now) {
  const source = inputs(root);
  const scope = readJson(root, SCOPE);
  assertRevision(scope, 'scopeRevision', 'Controlled test-write scope');
  const keys = ['schemaVersion', 'contractType', 'scopeId', 'appInstanceId', 'mappingRevision', 'environmentKey', 'rulesRevision', 'expiresAt', 'records', 'scopeRevision'];
  if (scope.schemaVersion !== 1 || scope.contractType !== 'prototype-test-write-scope'
    || Object.keys(scope).some((key) => !keys.includes(key))
    || scope.appInstanceId !== source.domain.appInstanceId || scope.mappingRevision !== source.mapping.mappingRevision
    || scope.environmentKey !== source.mapping.environmentKey || scope.rulesRevision !== revision(source.rules)
    || !Number.isFinite(Date.parse(scope.expiresAt)) || Date.parse(scope.expiresAt) <= now
    || Date.parse(scope.expiresAt) > now + 24 * 60 * 60 * 1000
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(scope.scopeId || '')
    || !Array.isArray(scope.records) || !scope.records.length || scope.records.length > 10
    || new Set(scope.records.map((record) => record.recordId)).size !== scope.records.length) {
    throw new Error('Controlled test-write scope is stale, expired, or malformed');
  }
  for (const record of scope.records) {
    const entry = source.mapping.entities.find((entity) => entity.entityId === record.entityId);
    if (Object.keys(record).some((key) => !['entityId', 'recordId', 'operations'].includes(key))
      || entry?.owner !== 'dataverse' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.recordId)
      || !Array.isArray(record.operations) || !record.operations.includes('create')
      || new Set(record.operations).size !== record.operations.length
      || record.operations.some((operation) => !['create', 'update', 'delete'].includes(operation) || !entry.operations.includes(operation))) {
      throw new Error('A test grant may only create and then operate on its own new Dataverse records');
    }
  }
  return { ...source, scope };
}

async function authorizeTestWrites(root, { receipt, confirmDisposableTestWrites = false } = {}, {
  env = process.env, now = () => Date.now(), clientFactory = (options) => require('./mobile-authoring-transport').createClient(options),
} = {}) {
  const original = currentScope(root, now());
  let proof;
  if (env.MOBILE_AUTHORING_CONTEXT || env.MOBILE_AUTHORING_RUNNER_TOKEN) {
    if (confirmDisposableTestWrites || !receipt) throw new Error('Player test writes require the exact maker receipt, never a runner confirmation flag');
    const client = clientFactory({ env, projectRoot: root });
    if (client.descriptor.operation !== 'connect' || client.descriptor.appInstanceId !== original.domain.appInstanceId) {
      throw new Error('Test-write approval must belong to this explicit conversion job');
    }
    const saved = await client.verifySavedDecision(receipt, { gateId: GATE, action: 'approve' });
    if (saved.question.kind !== 'schema' || saved.receipt.answer.allowTestWrites !== true
      || saved.binding.type !== 'artifacts'
      || BINDINGS.some((file) => !saved.binding.files.some((entry) => entry.path === file))) {
      throw new Error('Test-write approval must explicitly confirm the complete disposable-record scope');
    }
    proof = { transport: 'player', approvalId: saved.receipt.approvalId, approvalRevision: saved.receipt.approvalRevision, receiptDigest: revision(saved.receipt) };
  } else {
    if (!confirmDisposableTestWrites || receipt) throw new Error('Ask the maker first, then explicitly confirm disposable test writes in the standalone foreground');
    proof = { transport: 'standalone-foreground', scopeRevision: original.scope.scopeRevision };
  }
  const { scope } = currentScope(root, now());
  if (scope.scopeRevision !== original.scope.scopeRevision) throw new Error('Test-write scope changed while approval was verified');
  const permission = { ...scope, permissionId: scope.scopeId, approval: proof };
  const prior = readJson(root, '.tmp/prototype-generated.json');
  atomicWrite(root, `.tmp/prototype-test-write-approvals/${scope.scopeId}-${revision(proof).slice(0, 20)}.json`, { scope, proof });
  writeOwnedFiles(root, { [PERMISSION]: `${JSON.stringify(permission, null, 2)}\n` }, {
    ...prior.inputRevisions, testWritePermission: revision(permission),
  });
  return { ok: true, permissionId: scope.scopeId, expiresAt: scope.expiresAt, records: scope.records, requiresCandidateValidation: true };
}

async function revokeTestWrites(root, {
  env = process.env, clientFactory = (options) => require('./mobile-authoring-transport').createClient(options),
} = {}) {
  if (env.MOBILE_AUTHORING_CONTEXT || env.MOBILE_AUTHORING_RUNNER_TOKEN) {
    const client = clientFactory({ env, projectRoot: root });
    await client.verify({ refresh: true });
  }
  const prior = readJson(root, '.tmp/prototype-generated.json');
  const revisions = { ...prior.inputRevisions };
  delete revisions.testWritePermission;
  writeOwnedFiles(root, { [PERMISSION]: 'null\n' }, revisions);
  return { ok: true, testWrites: 'revoked', remoteRecordsAndJournals: 'preserved' };
}

module.exports = { SCOPE, PERMISSION, BINDINGS, GATE, prepareTestWriteScope, authorizeTestWrites, revokeTestWrites };
