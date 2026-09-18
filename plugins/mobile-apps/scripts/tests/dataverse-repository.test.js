'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { compileDataverseMapping, inspectService } = require('../lib/dataverse-repository-mapping');
const { createDataverseRepositories } = require('../lib/dataverse-repository-runtime');
const { createLiveMedia } = require('../lib/dataverse-repository-media');
const { SCOPE, PERMISSION, BINDINGS, prepareTestWriteScope, authorizeTestWrites, revokeTestWrites } = require('../lib/prototype-test-writes');
const { revision } = require('../lib/prototype-files');
const { sha256Hex } = require('../lib/product-experience-contracts');
const { validateEntityRules } = require('../lib/authoring-rules');
const core = require('../lib/prototype-repository-core');

const ENTITY_ID = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const serviceSource = `export class InspectionsService {
  public static async getAll(options?: IGetAllOptions): Promise<IOperationResult<InspectionRow[]>> { return operation(); }
  public static async get(id: string, options?: IGetOptions): Promise<IOperationResult<InspectionRow>> { return operation(); }
  public static async create(record: InspectionRow): Promise<IOperationResult<InspectionRow>> { return operation(); }
  public static async update(id: string, record: Partial<InspectionRow>): Promise<IOperationResult<InspectionRow>> { return operation(); }
  public static async delete(id: string): Promise<IOperationResult<void>> { return operation(); }
}`;
const domain = {
  schemaVersion: 1, appInstanceId: '22222222-2222-4222-8222-222222222222', schemaVersionNumber: 1,
  entities: [{
    id: 'Inspection', label: 'Inspection', fields: [
      { id: 'title', label: 'Title', type: 'text', required: true },
      { id: 'outcome', label: 'Outcome', type: 'choice', options: [{ id: 'pass', label: 'Pass' }, { id: 'fail', label: 'Fail' }] },
      { id: 'damagePhoto', label: 'Damage photo', type: 'photo' },
    ], operations: ['list', 'get', 'create', 'update', 'delete'],
  }], actions: [{ id: 'saveInspection', label: 'Save', entityId: 'Inspection', operation: 'save' }],
};
const rules = { schemaVersion: 1, rules: [{
  id: 'failurePhoto', entityId: 'Inspection', actionId: 'saveInspection',
  when: { fieldId: 'outcome', operator: 'equals', value: 'fail' },
  require: { fieldId: 'damagePhoto', message: 'Add damage evidence' },
}] };

function mappingFixture(t) {
  const root = path.join(path.resolve(__dirname, '../../../..'), `.dataverse-repository-work-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(root, 'src/generated/services'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'src/generated/services/InspectionsService.ts');
  fs.writeFileSync(file, serviceSource);
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({
    environmentId: 'fixture-environment',
    databaseReferences: { 'default.cds': { dataSources: {
      inspection: { logicalName: 'cr_inspection', entitySetName: 'inspections' },
    } } },
  }));
  const schema = { schemaVersion: 1, tables: [{
    logicalName: 'cr_inspection', plannedDecision: 'reuse', serviceRequired: true,
    columns: [
      { logicalName: 'cr_title', type: 'string', plannedDecision: 'reuse' },
      { logicalName: 'cr_outcome', type: 'choice', plannedDecision: 'reuse' },
      { logicalName: 'cr_photo', type: 'image', plannedDecision: 'reuse', requiredLevel: 'None' },
    ],
  }] };
  const snapshot = { tables: [{
    logicalName: 'cr_inspection', entitySetName: 'inspections', primaryIdAttribute: 'cr_inspectionid',
    detailLevel: 'full', missingDetailClasses: [],
    columns: [
      { logicalName: 'cr_title', type: 'String' },
      { logicalName: 'cr_outcome', type: 'Picklist', choices: [{ value: 1, label: 'Pass' }, { value: 2, label: 'Fail' }] },
      { logicalName: 'cr_photo', type: 'Image', maxSizeInKB: 10240 },
    ],
  }] };
  const mapping = {
    schemaVersion: 1, domainRevision: revision(domain), schemaRevision: revision(schema),
    entities: [{
      entityId: 'Inspection', owner: 'dataverse', decision: 'reuse', logicalName: 'cr_inspection',
      serviceFile: 'InspectionsService.ts', serviceExport: 'InspectionsService', serviceSha256: sha256Hex(serviceSource),
      fields: [
        { fieldId: 'title', column: 'cr_title' },
        { fieldId: 'outcome', column: 'cr_outcome', choiceMap: { pass: 1, fail: 2 } },
        { fieldId: 'damagePhoto', column: 'cr_photo', mediaStrategy: 'image-base64' },
      ],
    }],
  };
  const persistence = { mode: 'dataverse', conceptOwners: [{ conceptId: 'inspection', owner: 'dataverse' }] };
  persistence.persistenceRevision = revision(persistence);
  const options = {
    root, domain, mapping, schema, snapshot,
    persistence,
    bindings: { schemaVersion: 1, entities: [{ entityId: 'Inspection', conceptId: 'inspection' }] },
  };
  return { root, file, options, compiled: compileDataverseMapping(options) };
}

function runtime(mapping, { candidate = false, candidateWritePermission = null } = {}) {
  const rows = new Map([[ENTITY_ID, { cr_inspectionid: ENTITY_ID, cr_title: 'West entrance', cr_outcome: 1, cr_photo: null }]]);
  const journals = new Map();
  const calls = [];
  let failResult = false;
  let interruptAfterCreate = false;
  const storage = {
    async getItem(key) { return journals.get(key) ?? null; },
    async setItem(key, value) { journals.set(key, value); },
    async removeItem(key) { journals.delete(key); },
  };
  const service = {
    async getAll(options) { calls.push(['list', options]); return { success: true, data: [...rows.values()], skipToken: 'verified-sdk-cursor' }; },
    async get(id) { calls.push(['get', id]); return { success: true, data: rows.get(id) || null }; },
    async create(payload) {
      calls.push(['create', payload]);
      if (failResult) return { success: false };
      rows.set(payload.cr_inspectionid, { ...payload });
      if (interruptAfterCreate) throw new Error('connection interrupted after commit');
      return { success: true };
    },
    async update(id, payload) {
      calls.push(['update', id, payload]);
      if (failResult) return { success: false };
      rows.set(id, { ...rows.get(id), ...payload });
      return { success: true };
    },
    async delete(id) { calls.push(['delete', id]); rows.delete(id); return { success: true }; },
  };
  const media = {
    async fromBase64(entityId, id, fieldId, value) { return { status: 'ready', id: `${id}-${fieldId}`, uri: `file:///stored/${value}` }; },
    async toBase64(value) { return value.uri.split('/').pop(); },
  };
  const make = () => createDataverseRepositories({
    domain, mapping, services: { Inspection: service }, core, storage, media,
    randomUUID: () => NEW_ID, localRepositories: {},
    preview: { previewKind: candidate ? 'candidate' : 'active', dataNamespace: candidate ? 'candidate-a' : 'active' },
    candidateWritePermission,
    assertRules: (entityId, record, operation) => {
      const issues = validateEntityRules(domain, rules, entityId, record, operation);
      if (issues.length) throw new core.RepositoryError('rules', issues[0].message);
    },
  });
  return { make, rows, journals, calls, failResult: () => { failResult = true; }, interrupt: () => { interruptAfterCreate = true; } };
}

test('mapping uses verified official export/signatures and numeric choices, never file-name guesses', (t) => {
  const { options, compiled, file } = mappingFixture(t);
  assert.equal(compiled.entities[0].fields[1].choiceMap.fail, 2);
  assert.equal(compiled.services[0].exportName, 'InspectionsService');
  assert.match(compiled.services[0].methods.getAll.signature, /IGetAllOptions/);
  options.mapping.entities[0].serviceExport = 'GuessedService';
  assert.throws(() => compileDataverseMapping(options), /declared class/);
  options.mapping.entities[0].serviceExport = 'InspectionsService';
  fs.appendFileSync(file, '\n// official regeneration\n');
  assert.throws(() => compileDataverseMapping(options), /changed since mapping review/);
  assert.throws(() => inspectService(serviceSource.replace('options?: IGetAllOptions', 'options?: UnknownOptions'), 'InspectionsService'), /signature/);
  assert.throws(() => inspectService(`/* ${serviceSource} */`, 'InspectionsService'), /declared class/);
  assert.throws(() => inspectService(`const example = ${JSON.stringify(serviceSource)};`, 'InspectionsService'), /declared class/);
  assert.throws(() => inspectService(`export class InspectionsService {}\n${serviceSource.replace('InspectionsService', 'DifferentService')}`, 'InspectionsService'), /signature/);
});

test('mapping rejects owner changes, unknown choice values, missing fields, and globally required photos', (t) => {
  const { options } = mappingFixture(t);
  const testMapping = (change, expression) => {
    const modified = structuredClone(options);
    change(modified);
    assert.throws(() => compileDataverseMapping(modified), expression);
  };
  testMapping((value) => { value.mapping.entities[0].owner = 'local'; }, /approved owner/);
  testMapping((value) => { value.mapping.entities[0].fields[1].choiceMap.fail = 9; }, /verified numeric/);
  testMapping((value) => { value.mapping.entities[0].fields.pop(); }, /lose fields/);
  testMapping((value) => {
    value.schema.tables[0].columns[2].requiredLevel = 'ApplicationRequired';
    value.mapping.schemaRevision = revision(value.schema);
  }, /optional Dataverse Image/);
});

test('lookup mappings require exact relationship evidence, not a column-name navigation guess', (t) => {
  const { options } = mappingFixture(t);
  options.domain = structuredClone(domain);
  options.domain.entities[0].fields.push({ id: 'parentInspection', label: 'Parent inspection', type: 'lookup', targetEntityId: 'Inspection' });
  options.mapping.domainRevision = revision(options.domain);
  options.schema.tables[0].columns.push({ logicalName: 'cr_parentid', type: 'lookup', plannedDecision: 'reuse' });
  options.mapping.schemaRevision = revision(options.schema);
  options.snapshot.tables[0].columns.push({ logicalName: 'cr_parentid', type: 'Lookup', lookupTargets: ['cr_inspection'] });
  options.mapping.entities[0].fields.push({ fieldId: 'parentInspection', column: 'cr_parentid', navigationProperty: 'cr_ParentInspection' });
  assert.throws(() => compileDataverseMapping(options), /navigation-property evidence/);
  options.relationshipEvidence = { cr_inspection: [{
    ReferencingAttribute: 'cr_parentid', ReferencedEntity: 'cr_inspection',
    ReferencingEntityNavigationPropertyName: 'cr_ParentInspection',
  }] };
  const field = compileDataverseMapping(options).entities[0].fields.at(-1);
  assert.equal(field.readColumn, '_cr_parentid_value');
  assert.equal(field.navigationProperty, 'cr_ParentInspection');
  assert.equal(field.targetEntitySet, 'inspections');
});

test('retained connector/local owners cannot be substituted with a guessed local adapter', (t) => {
  const { root, options } = mappingFixture(t);
  options.domain = structuredClone(domain);
  options.domain.entities.push({ id: 'Preference', label: 'Preference', fields: [{ id: 'label', label: 'Label', type: 'text' }], operations: ['list', 'get'] });
  options.mapping.domainRevision = revision(options.domain);
  options.bindings.entities.push({ entityId: 'Preference', conceptId: 'preference' });
  options.persistence.conceptOwners.push({ conceptId: 'preference', owner: 'local' });
  options.persistence.mode = 'mixed';
  delete options.persistence.persistenceRevision;
  options.persistence.persistenceRevision = revision(options.persistence);
  options.mapping.entities.push({ entityId: 'Preference', owner: 'local', decision: 'defer' });
  assert.equal(compileDataverseMapping(options).entities.at(-1).owner, 'local');
  options.persistence.conceptOwners[1].owner = 'connector:office365users';
  delete options.persistence.persistenceRevision;
  options.persistence.persistenceRevision = revision(options.persistence);
  options.mapping.entities[1].owner = 'connector:office365users';
  assert.throws(() => compileDataverseMapping(options), /exact existing app-owned repository/);
  const file = 'src/data/repositories/directory.ts';
  const content = 'export const directoryRepository = existingVerifiedRepository;\n';
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  options.mapping.entities[1].retainedAdapter = { file, exportName: 'directoryRepository', sha256: sha256Hex(content) };
  assert.equal(compileDataverseMapping(options).entities.at(-1).retainedAdapter.file, file);
});

test('live journal and cache binding changes with the officially initialized environment', (t) => {
  const { root, options, compiled } = mappingFixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'power.config.json')));
  config.environmentId = 'different-fixture-environment';
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify(config));
  const next = compileDataverseMapping(options);
  assert.notEqual(next.environmentKey, compiled.environmentKey);
  assert.notEqual(next.mappingRevision, compiled.mappingRevision);
});

test('live adapter maps bounded queries and validates SDK success before reporting writes', async (t) => {
  const { compiled } = mappingFixture(t);
  const h = runtime(compiled);
  const repo = h.make().Inspection;
  const page = await repo.list({ where: [{ fieldId: 'outcome', operator: 'equals', value: 'pass' }], pageSize: 5 });
  assert.equal(page.items[0].outcome, 'pass');
  assert.equal(page.nextCursor, 'verified-sdk-cursor');
  assert.equal(h.calls[0][1].filter, 'cr_outcome eq 1');
  assert.equal(h.calls[0][1].maxPageSize, 5);
  assert.deepEqual(h.calls[0][1].orderBy, ['cr_inspectionid asc']);
  h.failResult();
  await assert.rejects(repo.update(ENTITY_ID, { title: 'Failed' }, { operationId: 'update-one' }), /did not succeed/);
  assert.equal(h.rows.get(ENTITY_ID).cr_title, 'West entrance');
});

test('common rules run above live writes and preserve historical photo bytes across updates', async (t) => {
  const { compiled } = mappingFixture(t);
  const h = runtime(compiled);
  const repo = h.make().Inspection;
  await assert.rejects(repo.update(ENTITY_ID, { outcome: 'fail' }, { operationId: 'fail-without-evidence' }), /Add damage/);
  assert.equal(h.calls.filter((entry) => entry[0] === 'update').length, 0);
  const photo = { status: 'ready', id: 'capture-one', uri: 'file:///captures/cGhvdG8=' };
  await repo.update(ENTITY_ID, { outcome: 'fail', damagePhoto: photo }, { operationId: 'save-photo' });
  assert.equal(h.rows.get(ENTITY_ID).cr_photo, 'cGhvdG8=');
  const saved = await repo.update(ENTITY_ID, { title: 'Historical evidence' }, { operationId: 'rename' });
  assert.equal(saved.outcome, 'fail');
  assert.equal(saved.damagePhoto.status, 'ready');
  assert.equal(h.calls.filter((entry) => entry[0] === 'update').at(-1)[2].cr_photo, undefined);
});

test('connected candidate cannot write without separate explicit test-write permission', async (t) => {
  const { compiled } = mappingFixture(t);
  const h = runtime(compiled, { candidate: true });
  const repo = h.make().Inspection;
  await repo.list();
  await assert.rejects(repo.create({ title: 'Not allowed' }, { operationId: 'candidate-write' }), /separate explicit approval/);
  assert.equal(h.calls.some((entry) => entry[0] === 'create'), false);
});

function permissionFor(mapping, recordId = NEW_ID) {
  return {
    schemaVersion: 1, scopeId: 'approved-test-scope', permissionId: 'approved-test-scope',
    scopeRevision: 'b'.repeat(64), appInstanceId: domain.appInstanceId,
    mappingRevision: mapping.mappingRevision, environmentKey: mapping.environmentKey,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    records: [{ entityId: 'Inspection', recordId, operations: ['create', 'update', 'delete'] }],
  };
}

test('approved candidate tests can create and maintain only their own bounded disposable rows', async (t) => {
  const { compiled } = mappingFixture(t);
  const h = runtime(compiled, { candidate: true, candidateWritePermission: permissionFor(compiled) });
  const repo = h.make().Inspection;
  await assert.rejects(repo.update(ENTITY_ID, { title: 'Never modify a business row' }, { operationId: 'bad-update' }), /test-record scope/);
  await assert.rejects(repo.delete(NEW_ID, { operationId: 'bad-delete' }), /created by this approved/);
  const row = await repo.create({ title: 'Disposable', outcome: 'pass' }, { operationId: 'trial-create' });
  assert.equal(row.id, NEW_ID);
  await h.make().Inspection.update(NEW_ID, { title: 'Edited disposable' }, { operationId: 'trial-update' });
  await assert.rejects(repo.create({ title: 'Too many' }, { operationId: 'second-trial' }), /exhausted/);
  await h.make().Inspection.delete(NEW_ID, { operationId: 'trial-delete' });
  assert.equal(h.rows.has(NEW_ID), false);
  assert.equal(h.rows.get(ENTITY_ID).cr_title, 'West entrance');
  const unsafe = runtime(compiled, { candidate: true, candidateWritePermission: permissionFor(compiled, ENTITY_ID) });
  await assert.rejects(unsafe.make().Inspection.create({ title: 'Collision' }, { operationId: 'collision' }), /already exists/);
  assert.equal(unsafe.calls.some((call) => call[0] === 'create'), false);
});

test('test-write ownership is not claimed before remote acknowledgement and remains recoverable', async (t) => {
  const { compiled } = mappingFixture(t);
  const permission = permissionFor(compiled);
  const h = runtime(compiled, { candidate: true, candidateWritePermission: permission });
  h.interrupt();
  await assert.rejects(h.make().Inspection.create({ title: 'Interrupted trial' }, { operationId: 'trial' }), /interrupted/);
  const ledger = JSON.parse([...h.journals.entries()].find(([key]) => key.includes(':test-scope:'))[1]);
  assert.equal(ledger.records[NEW_ID].state, 'in-flight');
  await assert.rejects(h.make().Inspection.update(NEW_ID, { title: 'Premature' }, { operationId: 'premature' }), /created by this approved/);
  await h.make().Inspection.reconcileWrite('trial');
  await h.make().Inspection.update(NEW_ID, { title: 'Recovered trial' }, { operationId: 'recovered' });
  permission.expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(h.make().Inspection.delete(NEW_ID, { operationId: 'expired' }), /expired/);
});

test('test-write compiler requires foreground consent or the shared exact Player receipt, and preserves proof on revocation', async (t) => {
  const { root, compiled } = mappingFixture(t);
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  };
  write('.tmp/prototype-domain.json', domain);
  write('.tmp/prototype-rules.json', rules);
  write('.tmp/prototype-dataverse-mapping.json', compiled);
  write('.tmp/prototype-conversion-journal.json', { completed: ['metadata', 'services', 'schemas', 'adapters', 'startup'] });
  write('.tmp/prototype-generated.json', { schemaVersion: 1, inputRevisions: {}, files: {} });
  const plan = prepareTestWriteScope(root, ['Inspection']);
  assert.equal(plan.scope.records.length, 1);
  assert.notEqual(plan.scope.records[0].recordId, ENTITY_ID);
  await assert.rejects(authorizeTestWrites(root, {}, { env: {} }), /Ask the maker first/);
  await authorizeTestWrites(root, { confirmDisposableTestWrites: true }, { env: {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, PERMISSION))).approval.transport, 'standalone-foreground');
  await revokeTestWrites(root, { env: {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, PERMISSION))), null);
  assert.equal(fs.readdirSync(path.join(root, '.tmp/prototype-test-write-approvals')).length, 1);
  const env = { MOBILE_AUTHORING_CONTEXT: 'mock verified by the injected shared client' };
  const clientFactory = () => ({
    descriptor: { operation: 'connect', appInstanceId: domain.appInstanceId },
    async verifySavedDecision(receipt, expected) {
      assert.equal(receipt, 'verified-player-receipt.json');
      assert.deepEqual(expected, { gateId: 'prototype-test-writes', action: 'approve' });
      return { question: { kind: 'schema' }, binding: { type: 'artifacts', files: BINDINGS.map((file) => ({ path: file })) },
        receipt: { approvalId: 'maker-approval', approvalRevision: 1, answer: { allowTestWrites: true } } };
    },
  });
  await assert.rejects(authorizeTestWrites(root, { confirmDisposableTestWrites: true }, { env, clientFactory }), /never a runner confirmation/);
  await authorizeTestWrites(root, { receipt: 'verified-player-receipt.json' }, { env, clientFactory });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, PERMISSION))).approval.transport, 'player');
  const scope = JSON.parse(fs.readFileSync(path.join(root, SCOPE)));
  scope.records[0].values = { title: 'Not a second fixture authority' };
  delete scope.scopeRevision;
  scope.scopeRevision = revision(scope);
  write(SCOPE, scope);
  await assert.rejects(authorizeTestWrites(root, { confirmDisposableTestWrites: true }, { env: {} }), /may only create/);
});

test('interrupted live create is reconciled, not blindly replayed or converted into success', async (t) => {
  const { compiled } = mappingFixture(t);
  const h = runtime(compiled);
  h.interrupt();
  const values = { title: 'Created once', outcome: 'pass', damagePhoto: null };
  await assert.rejects(h.make().Inspection.create(values, { operationId: 'create-once' }), /interrupted/);
  await assert.rejects(h.make().Inspection.create(values, { operationId: 'create-once' }), /may have committed/);
  assert.equal(h.calls.filter((entry) => entry[0] === 'create').length, 1);
  assert.deepEqual(await h.make().Inspection.reconcileWrite('create-once'), { status: 'committed', recordId: NEW_ID });
  const result = await h.make().Inspection.create(values, { operationId: 'create-once' });
  assert.equal(result.id, NEW_ID);
  assert.equal(h.calls.filter((entry) => entry[0] === 'create').length, 1);
});

test('unchanged local screen calls get a durable live operation identity across reloads', async (t) => {
  const { compiled } = mappingFixture(t);
  const h = runtime(compiled);
  h.interrupt();
  const values = { title: 'Retry without changing a screen', outcome: 'pass' };
  await assert.rejects(h.make().Inspection.create(values), /interrupted/);
  await assert.rejects(h.make().Inspection.create({ outcome: 'pass', title: values.title }), /may have committed/);
  assert.equal(h.calls.filter((entry) => entry[0] === 'create').length, 1);
  const operation = [...h.journals.values()].map((value) => JSON.parse(value)).find((value) => value.operationId);
  await h.make().Inspection.reconcileWrite(operation.operationId);
  assert.equal((await h.make().Inspection.create(values)).id, NEW_ID);
  assert.equal([...h.journals.keys()].some((key) => key.includes(':pending:')), false);
});

test('real image cache is immutable, environment-scoped, size-checked and survives later photo reads', async () => {
  const content = new Map();
  const files = {
    documentDirectory: 'file:///documents/', EncodingType: { Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(uri) { return { exists: content.has(uri), size: content.has(uri) ? Buffer.from(content.get(uri), 'base64').length : undefined }; },
    async writeAsStringAsync(uri, value) { content.set(uri, value); },
    async readAsStringAsync(uri) { return content.get(uri); },
  };
  const make = (namespace) => createLiveMedia({
    files, namespace, RepositoryError: core.RepositoryError,
    digest: async (value) => crypto.createHash('sha256').update(value).digest('hex'),
  });
  const media = make('app:real:environment-one:active');
  const photo = await media.fromBase64('Inspection', ENTITY_ID, 'damagePhoto', 'cGhvdG8=', 10);
  const changed = await media.fromBase64('Inspection', ENTITY_ID, 'damagePhoto', 'bmV3LXBob3Rv', 10);
  assert.notEqual(photo.uri, changed.uri);
  assert.equal(await media.toBase64(photo, 10), 'cGhvdG8=');
  const otherEnvironment = await make('app:real:environment-two:active').fromBase64('Inspection', ENTITY_ID, 'damagePhoto', 'cGhvdG8=', 10);
  assert.notEqual(otherEnvironment.uri, photo.uri);
  await assert.rejects(media.fromBase64('Inspection', ENTITY_ID, 'damagePhoto', 'not base64', 10), /valid bounded base64/);
  await assert.rejects(media.toBase64({ status: 'cancelled' }, 10), /Persist a captured/);
  await assert.rejects(media.fromBase64('Inspection', ENTITY_ID, 'damagePhoto', Buffer.alloc(1025).toString('base64'), 1), /exceeds/);
});
