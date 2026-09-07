'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLocalStore } = require('../lib/prototype-local-runtime');
const core = require('../lib/prototype-repository-core');
const { compilePrototype, validateDomain } = require('../lib/prototype-domain');
const { validateEntityRules } = require('../lib/authoring-rules');
const { revision } = require('../lib/prototype-files');
const { createPhotoCapture } = require('../lib/prototype-photo-capture');
const { sampleImageAsset } = require('./helpers/prototype-image-fixtures');

const domain = {
  schemaVersion: 1, appInstanceId: '22222222-2222-4222-8222-222222222222', schemaVersionNumber: 1,
  entities: [{
    id: 'Inspection', label: 'Inspection',
    fields: [
      { id: 'title', label: 'Title', type: 'text', required: true },
      { id: 'outcome', label: 'Outcome', type: 'choice', options: [{ id: 'pass', label: 'Pass' }, { id: 'fail', label: 'Fail' }] },
      { id: 'damagePhoto', label: 'Damage photo', type: 'photo' },
      { id: 'score', label: 'Score', type: 'number' },
    ], operations: ['list', 'get', 'create', 'update', 'delete'],
  }],
  actions: [{ id: 'saveInspection', label: 'Save inspection', entityId: 'Inspection', operation: 'save' }],
};
const rules = { schemaVersion: 1, rules: [{
  id: 'failurePhoto', entityId: 'Inspection', actionId: 'saveInspection',
  when: { fieldId: 'outcome', operator: 'equals', value: 'fail' },
  require: { fieldId: 'damagePhoto', message: 'Add a damage photo before saving' },
}] };
const persistence = {
  mode: 'local-prototype', scopeRevision: 'scope',
  conceptOwners: [{ conceptId: 'inspection', owner: 'local' }], transientConceptIds: [],
};
persistence.persistenceRevision = revision(persistence);
const facts = {
  schemaVersion: 1, contractType: 'scenario-facts', scopeRevision: 'scope',
  persistenceRevision: persistence.persistenceRevision,
  records: [{ id: 'inspection-one', conceptId: 'inspection', fields: { title: 'West entrance', outcome: 'pass', score: 2 } }],
  relationships: [], mediaAssets: [], scenarios: [], screenBindings: [], invariants: [],
};
facts.scenarioRevision = revision(facts);
const bindings = { schemaVersion: 1, entities: [{ entityId: 'Inspection', conceptId: 'inspection' }] };

function harness(scenario = facts) {
  const values = new Map();
  const files = new Map([['file:///capture.jpg', 'photo-bytes']]);
  let nextId = 0;
  let failStorage = false;
  let failCopy = false;
  const storage = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { if (failStorage) throw new Error('disk full'); values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  };
  const fileSystem = {
    documentDirectory: 'file:///documents/',
    async getInfoAsync(uri) { return { exists: files.has(uri) }; },
    async makeDirectoryAsync() {},
    async copyAsync({ from, to }) { if (failCopy) throw new Error('copy failed'); files.set(to, files.get(from)); },
    async writeAsStringAsync(uri, value, options) { assert.equal(options.encoding, 'base64'); if (failCopy) throw new Error('write failed'); files.set(uri, value); },
    async readAsStringAsync(uri, options) { assert.equal(options.encoding, 'base64'); if (!files.has(uri)) throw new Error('missing file'); return files.get(uri); },
    async deleteAsync(uri) { for (const key of files.keys()) if (key.startsWith(uri)) files.delete(key); },
  };
  const assertRules = (entityId, record, operation) => {
    const issues = validateEntityRules(domain, rules, entityId, record, operation);
    if (issues.length) throw new core.RepositoryError('rules', issues[0].message, issues);
  };
  const fixtures = compilePrototype(domain, bindings, { persistence, facts: scenario }, rules).fixtures;
  const make = (preview, projectedFixtures = fixtures) => createLocalStore({
    domain, fixtures: projectedFixtures, storage, files: fileSystem, assertRules, core, preview,
    randomUUID: () => `record-${++nextId}`,
  });
  return { make, values, files, fixtures, failStorage: () => { failStorage = true; }, failCopy: () => { failCopy = true; } };
}

test('domain has no hidden fixtures; canonical scenario facts are the sole projection', () => {
  assert.throws(() => validateDomain({ ...domain, fixtures: [] }), /unsupported field fixtures/);
  const result = compilePrototype(domain, bindings, { persistence, facts }, rules);
  assert.deepEqual(result.fixtures.entities.Inspection, [{ id: 'inspection-one', title: 'West entrance', outcome: 'pass', score: 2 }]);
  result.fixtures.entities.Inspection[0].title = 'Changed projection';
  assert.equal(facts.records[0].fields.title, 'West entrance');
  const forged = structuredClone(facts);
  forged.records[0].fields.title = 'Not canonical';
  assert.throws(() => compilePrototype(domain, bindings, { persistence, facts: forged }), /revision/);
  assert.throws(() => compilePrototype(domain, bindings, { persistence: { ...persistence, mode: 'dataverse' }, facts }), /local-prototype/);
  assert.throws(() => compilePrototype(domain, bindings, { persistence: { ...persistence, scopeRevision: 'changed' }, facts }), /revision/);
  const collision = structuredClone(domain);
  collision.entities[0].id = 'EntityMap';
  assert.throws(() => validateDomain(collision), /reserved generated/);
  collision.entities[0].id = 'Inspection';
  collision.entities[0].fields[0].id = 'toString';
  assert.throws(() => validateDomain(collision), /non-reserved/);
});

test('a presentation-only prototype does not invent a phantom data entity', () => {
  const emptyDomain = { ...domain, entities: [], actions: [] };
  const owner = { mode: 'local-prototype', scopeRevision: 'scope', conceptOwners: [], transientConceptIds: [] };
  owner.persistenceRevision = revision(owner);
  const canonical = { ...facts, records: [], persistenceRevision: owner.persistenceRevision };
  delete canonical.scenarioRevision;
  canonical.scenarioRevision = revision(canonical);
  const result = compilePrototype(emptyDomain, { schemaVersion: 1, entities: [] }, { persistence: owner, facts: canonical });
  assert.deepEqual(result.fixtures.entities, {});
});

test('persistent CRUD/query survives reload and uses stable app identity, not network or Metro', async () => {
  const h = harness();
  const store = h.make();
  const repository = store.repositories.Inspection;
  await repository.create({ title: 'North', outcome: 'pass', score: 3 }, { operationId: 'create-north' });
  await repository.create({ title: 'South', outcome: 'pass', score: 1 }, { operationId: 'create-south' });
  const page = await repository.list({ orderBy: [{ fieldId: 'score', direction: 'asc' }], pageSize: 1 });
  assert.equal(page.items[0].title, 'South');
  assert.equal(page.nextCursor, '1');
  assert.equal((await h.make().repositories.Inspection.list()).total, 3);
  await h.make().repositories.Inspection.update('inspection-one', { title: 'Updated' });
  assert.equal((await repository.get('inspection-one')).title, 'Updated');
  const matches = await repository.list({ where: [{ fieldId: 'title', operator: 'contains', value: 'north' }] });
  assert.equal(matches.items.length, 1);
  await repository.delete(matches.items[0].id);
  assert.equal((await repository.list()).total, 2);
  assert.match(store.namespace, /22222222-2222-4222-8222-222222222222:v1:active/);
  assert.doesNotMatch(store.namespace, /http|8081/);
});

test('serialized writes and durable operation receipts prevent duplicate local submissions', async () => {
  const h = harness();
  const save = () => h.make().repositories.Inspection.create({ title: 'Same', outcome: 'pass' }, { operationId: 'save-one' });
  const [first, second] = await Promise.all([save(), save()]);
  assert.equal(first.id, second.id);
  assert.equal((await h.make().repositories.Inspection.list()).total, 2);
  await assert.rejects(h.make().repositories.Inspection.create({ title: 'Different' }, { operationId: 'save-one' }), /different input/);
});

test('native signature data persists as a local file without duplicating its bytes in the record store', async () => {
  const h = harness();
  const active = h.make();
  const input = { uri: 'data:image/png;base64,aW5r', operationId: 'signature-one' };
  const signature = await active.importPhoto(input);
  assert.equal(signature.status, 'ready');
  assert.equal(signature.mimeType, 'image/png');
  assert.equal(h.files.get(signature.uri), 'aW5r');
  await active.repositories.Inspection.update('inspection-one', { outcome: 'fail', damagePhoto: signature });
  assert.deepEqual(await h.make().importPhoto(input), signature);
  assert.equal((await h.make().repositories.Inspection.get('inspection-one')).damagePhoto.uri, signature.uri);
  for (const value of h.values.values()) assert.equal(value.includes('aW5r'), false);
  await assert.rejects(active.importPhoto({ ...input, uri: 'data:image/png;base64,b3RoZXI=' }), /reused/);
  await assert.rejects(active.importPhoto({ uri: 'data:image/png;base64,bad!', operationId: 'bad-signature' }), /invalid/);
  await assert.rejects(active.importPhoto({ uri: 'data:text/html;base64,aW5r' }), /local photo/);
  await assert.rejects(active.importPhoto({ uri: input.uri, mimeType: 'image/jpeg' }), /MIME/);
  const candidate = h.make({ previewKind: 'candidate', dataNamespace: 'signature-review' });
  const local = await candidate.importPhoto({ uri: 'data:image/png;base64,bmV3' });
  await candidate.discardCandidate();
  assert.equal(h.files.has(local.uri), false);
  assert.equal(h.files.has(signature.uri), true);
});

test('photos persist before rule-checked saves; cancellation/failure preserves historical evidence', async () => {
  const h = harness();
  const store = h.make();
  const repository = store.repositories.Inspection;
  await assert.rejects(repository.update('inspection-one', { outcome: 'fail' }), /damage photo/);
  await assert.rejects(repository.update('inspection-one', { damagePhoto: { status: 'cancelled' } }), /Invalid photo/);
  const photo = await store.importPhoto({ uri: 'file:///capture.jpg', operationId: 'capture-one' });
  assert.equal(photo.status, 'ready');
  assert.notEqual(photo.uri, 'file:///capture.jpg');
  await repository.update('inspection-one', { outcome: 'fail', damagePhoto: photo });
  const reloaded = h.make();
  await reloaded.repositories.Inspection.update('inspection-one', { title: 'Still damaged' });
  assert.deepEqual((await reloaded.repositories.Inspection.get('inspection-one')).damagePhoto, photo);
  await reloaded.repositories.Inspection.update('inspection-one', { outcome: 'pass' });
  assert.deepEqual((await repository.get('inspection-one')).damagePhoto, photo);
  assert.deepEqual(await reloaded.importPhoto({ uri: 'file:///capture.jpg', operationId: 'capture-one' }), photo);
  h.failCopy();
  await assert.rejects(store.importPhoto({ uri: 'file:///capture.jpg' }), /could not be persisted/);
  assert.equal((await repository.get('inspection-one')).title, 'Still damaged');
});

test('actual capture adapter handles approval, permissions, cancellation, busy state, and persistence before ready', async () => {
  const h = harness();
  const store = h.make();
  let granted = false;
  let canceled = false;
  let launches = 0;
  const picker = {
    async requestCameraPermissionsAsync() { return { granted }; },
    async requestMediaLibraryPermissionsAsync() { return { granted }; },
    async launchCameraAsync() { launches += 1; return { canceled, assets: canceled ? null : [{ uri: 'file:///capture.jpg', mimeType: 'image/jpeg' }] }; },
    async launchImageLibraryAsync() { return this.launchCameraAsync(); },
  };
  const capture = createPhotoCapture({ picker, allowedSources: ['camera'], persist: (input) => store.importPhoto(input) });
  assert.equal((await capture('library')).status, 'failed');
  assert.equal((await capture('camera')).status, 'failed');
  assert.equal(launches, 0);
  granted = true;
  canceled = true;
  assert.equal((await capture('camera')).status, 'cancelled');
  assert.equal(h.files.size, 1);
  canceled = false;
  const first = capture('camera');
  assert.equal((await capture('camera')).status, 'pending');
  const photo = await first;
  assert.equal(photo.status, 'ready');
  assert.equal(h.files.has(photo.uri), true);
  await store.repositories.Inspection.update('inspection-one', { outcome: 'fail', damagePhoto: photo });
  h.failCopy();
  assert.equal((await capture('camera')).status, 'failed');
  assert.deepEqual((await store.repositories.Inspection.get('inspection-one')).damagePhoto, photo);
});

test('candidate copy-on-write discard cannot change active rows or media', async () => {
  const h = harness();
  const active = h.make();
  const photo = await active.importPhoto({ uri: 'file:///capture.jpg' });
  await active.repositories.Inspection.update('inspection-one', { damagePhoto: photo });
  const candidate = h.make({ previewKind: 'candidate', dataNamespace: 'candidate-a' });
  await candidate.repositories.Inspection.list();
  await active.repositories.Inspection.update('inspection-one', { title: 'Active changed' });
  assert.equal((await candidate.repositories.Inspection.get('inspection-one')).title, 'West entrance');
  const candidatePhoto = await candidate.importPhoto({ uri: 'file:///capture.jpg' });
  await candidate.repositories.Inspection.update('inspection-one', { title: 'Candidate only', damagePhoto: candidatePhoto });
  await candidate.repositories.Inspection.delete('inspection-one');
  await candidate.discardCandidate();
  const restored = await h.make().repositories.Inspection.get('inspection-one');
  assert.equal(restored.title, 'Active changed');
  assert.equal(restored.damagePhoto.uri, photo.uri);
  assert.equal(h.files.has(photo.uri), true);
  assert.equal(h.files.has(candidatePhoto.uri), false);
  assert.throws(() => h.make({ previewKind: 'candidate', dataNamespace: 'active' }), /must not use/);
  assert.throws(() => h.make({ previewKind: 'candidate', dataNamespace: '../active' }), /namespace/);
});

test('storage and invalid query errors are visible, not success-shaped empty lists', async () => {
  const h = harness();
  const repository = h.make().repositories.Inspection;
  await repository.list();
  h.failStorage();
  await assert.rejects(repository.update('inspection-one', { title: 'Lost' }), /not committed/);
  assert.equal((await repository.get('inspection-one')).title, 'West entrance');
  await assert.rejects(repository.list({ pageSize: 1000 }), /bounds/);
  await assert.rejects(repository.list({ where: [{ fieldId: 'unknown', operator: 'equals', value: 'x' }] }), /Unsupported query/);
  await assert.rejects(repository.list({ orderBy: [{ fieldId: 'outcome', direction: 'asc' }] }), /Invalid ordering/);
  await assert.rejects(repository.list({ where: [{ fieldId: 'score', operator: 'equals', value: '' }] }), /Invalid number/);
});

test('local datetime queries compare instants without changing canonical fixture text', () => {
  const entity = { id: 'Schedule', fields: [{ id: 'when', type: 'datetime' }] };
  const rows = [{ id: 'a', when: '2026-09-07T09:00:00+05:00' }, { id: 'b', when: '2026-09-07T03:00:00Z' }];
  const ordered = core.queryRows(rows, core.validateQuery(entity, { orderBy: [{ fieldId: 'when', direction: 'asc' }] }));
  assert.deepEqual(ordered.items.map((row) => row.id), ['b', 'a']);
  const same = core.queryRows(rows, core.validateQuery(entity, { where: [{ fieldId: 'when', operator: 'equals', value: '2026-09-07T04:00:00.000Z' }] }));
  assert.equal(same.items[0].id, 'a');
  assert.equal(rows[0].when, '2026-09-07T09:00:00+05:00');
});

function imageFacts() {
  const scenario = structuredClone(facts);
  const asset = sampleImageAsset();
  scenario.mediaAssets.push(asset);
  scenario.records[0].fields.damagePhoto = { mediaAssetKey: asset.key };
  delete scenario.scenarioRevision;
  scenario.scenarioRevision = revision(scenario);
  return scenario;
}

test('local projection preserves provenance through an exact concept, record and photo field reference', () => {
  const scenario = imageFacts();
  const compiled = compilePrototype(domain, bindings, { persistence, facts: scenario }, rules);
  const photo = compiled.fixtures.entities.Inspection[0].damagePhoto;
  assert.equal(photo.status, 'ready');
  assert.equal(photo.uri, scenario.mediaAssets[0].source.value);
  assert.deepEqual(photo.sample, {
    conceptId: 'inspection', recordId: 'inspection-one', field: 'damagePhoto',
    asset: scenario.mediaAssets[0],
  });
  assert.deepEqual(scenario.records[0].fields.damagePhoto, { mediaAssetKey: scenario.mediaAssets[0].key });
  photo.sample.asset.provenance.creator = 'Projection edit';
  assert.equal(scenario.mediaAssets[0].provenance.creator, 'Hannes Röst');
  const wrongField = structuredClone(domain);
  wrongField.entities[0].fields.find((field) => field.id === 'damagePhoto').type = 'text';
  assert.throws(() => compilePrototype(wrongField, bindings, { persistence, facts: scenario }), /exact photo field/);
  const wrongConcept = { schemaVersion: 1, entities: [{ entityId: 'Inspection', conceptId: 'not-approved' }] };
  assert.throws(() => compilePrototype(domain, wrongConcept, { persistence, facts: scenario }), /approved local/);
  delete scenario.mediaAssets[0].provenance;
  delete scenario.scenarioRevision;
  scenario.scenarioRevision = revision(scenario);
  assert.throws(() => compilePrototype(domain, bindings, { persistence, facts: scenario }), /provenance/);
});

test('sample images survive reload and candidate namespaces without file downloads or reseeding', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Repositories must not fetch sample URLs'); });
  const scenario = imageFacts();
  const h = harness(scenario);
  const active = h.make();
  const photo = (await active.repositories.Inspection.get('inspection-one')).damagePhoto;
  assert.deepEqual((await h.make().repositories.Inspection.get('inspection-one')).damagePhoto, photo);
  assert.equal(h.files.size, 1);
  assert.deepEqual(JSON.parse(h.values.get(active.namespace)).media, {});
  const candidate = h.make({ previewKind: 'candidate', dataNamespace: 'image-review' });
  await candidate.repositories.Inspection.list();
  const capture = await active.importPhoto({ uri: 'file:///capture.jpg' });
  await active.repositories.Inspection.update('inspection-one', { damagePhoto: capture });
  assert.deepEqual((await candidate.repositories.Inspection.get('inspection-one')).damagePhoto, photo);
  const changedFixtures = structuredClone(h.fixtures);
  changedFixtures.entities.Inspection[0].damagePhoto.sample.asset.provenance.attribution = 'New canonical caption';
  const reloadedCandidate = h.make({ previewKind: 'candidate', dataNamespace: 'image-review' }, changedFixtures);
  await reloadedCandidate.repositories.Inspection.update('inspection-one', { title: 'Candidate only' });
  assert.deepEqual((await reloadedCandidate.repositories.Inspection.get('inspection-one')).damagePhoto, photo);
  const candidateCapture = await candidate.importPhoto({ uri: 'file:///capture.jpg' });
  await candidate.repositories.Inspection.update('inspection-one', { damagePhoto: candidateCapture });
  await candidate.discardCandidate();
  assert.deepEqual((await active.repositories.Inspection.get('inspection-one')).damagePhoto, capture);
  assert.equal(h.files.has(capture.uri), true);
  assert.equal(h.files.has(candidateCapture.uri), false);
  assert.equal(scenario.mediaAssets[0].provenance.attribution, 'Fronalpstock panorama');
});

test('new HTTPS writes cannot forge provenance or borrow another record binding', async () => {
  const h = harness(imageFacts());
  const store = h.make();
  const photo = (await store.repositories.Inspection.get('inspection-one')).damagePhoto;
  const uncredited = { status: 'ready', id: photo.id, uri: photo.uri };
  await assert.rejects(store.repositories.Inspection.update('inspection-one', { damagePhoto: uncredited }), /canonical scenario image/);
  await assert.rejects(store.importPhoto({ uri: photo.uri }), /captured local photo/);
  const changed = structuredClone(photo);
  changed.sample.asset.provenance.creator = 'Invented credit';
  await assert.rejects(store.repositories.Inspection.update('inspection-one', { damagePhoto: changed }), /exact canonical record field/);
  await assert.rejects(store.repositories.Inspection.create({ id: 'copied-image', title: 'Copy', damagePhoto: photo }), /exact photo binding/);
  changed.sample.recordId = 'copied-image';
  await assert.rejects(store.repositories.Inspection.create({ id: 'copied-image', title: 'Copy', damagePhoto: changed }), /exact canonical record field/);
  await store.repositories.Inspection.update('inspection-one', { title: 'Still canonical', damagePhoto: photo });
  assert.deepEqual((await store.repositories.Inspection.get('inspection-one')).damagePhoto, photo);
});

test('corrupt stored sample metadata fails visibly rather than silently replacing it with fixtures', async () => {
  const h = harness(imageFacts());
  const store = h.make();
  await store.repositories.Inspection.list();
  const stored = JSON.parse(h.values.get(store.namespace));
  delete stored.entities.Inspection[0].damagePhoto.sample.asset.provenance;
  h.values.set(store.namespace, JSON.stringify(stored));
  const before = h.values.get(store.namespace);
  await assert.rejects(h.make().repositories.Inspection.list(), /provenance.*explicit recovery/);
  assert.equal(h.values.get(store.namespace), before);
});
