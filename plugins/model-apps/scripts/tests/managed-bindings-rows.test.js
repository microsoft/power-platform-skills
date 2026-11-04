'use strict';
// The configuration row families of the managed binding store (lib/managed-bindings.js ROW_FAMILIES, `rowProtocol`):
// a version-2 file that an old-family-only workspace never gets, sets of attempts prepared, sent and committed in one
// write each, every row sealed once before its request leaves, and ownership proved row by row — a root's
// acknowledgement or approval never mints a child.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { CODES, managedManifestView, readManagedManifest } = require('../lib/managed-bindings.js');
const { ENV, APP, SOL, H, API, REQ, API_KEY, REQ_KEY, PROOF, open, rec, codeOf, apiPlan, apiExpected, apiConsumer, settleForm } = require('./helpers/managed-rows.js');

const API2 = '55555555-5555-4555-8555-555555555555';
const REQ2 = '66666666-6666-4666-8666-666666666666';
const dirOf = () => makeTempDir('mb-rows-');
const text = (store) => fs.readFileSync(store.file, 'utf8');
const SEALED = [
  { kind: 'customApi', key: API_KEY, id: API, sentFields: ['uniquename', 'customapiid'], sentSha256: H('7') },
  { kind: 'customApiRequestParameter', key: REQ_KEY, id: REQ, sentFields: ['uniquename'], sentSha256: H('8') },
];
const proposal = (token, over = {}) => ({
  token, baseGeneration: null, records: [rec('customApi', API_KEY, API), rec('customApiRequestParameter', REQ_KEY, REQ, { parentKey: API_KEY })],
  proof: PROOF, consumerState: apiConsumer(), proofSchema: 'configuration-rows-v1', ...over,
});
function sending(store, plans = [apiPlan()], expecteds = [apiExpected()]) {
  const tokens = store.prepareAttemptSet(plans);
  return store.markAttemptSetSending(tokens.map((token, i) => ({ token, expected: expecteds[i] })));
}

test('an old-family store stays version 1; the first configuration prepare writes version 2 and keeps every old group', () => {
  const dir = dirOf();
  const store = open(dir);
  settleForm(store);
  const before = JSON.parse(text(store));
  assert.equal(before.schemaVersion, 1);
  store.prepareAttemptSet([apiPlan()]);
  const after = JSON.parse(text(store));
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.groups, before.groups);
  assert.equal(open(dir).readGroup('customApi', API_KEY).pending.rowProtocol.rows.length, 2);
});

test('prepareAttemptSet is one write: a refusal of any plan writes nothing', () => {
  const dir = dirOf();
  const store = open(dir);
  store.prepareAttemptSet([apiPlan()]);
  const before = text(store);
  const second = apiPlan({ key: 'contoso_other', api: API2, req: REQ2 });
  assert.equal(codeOf(() => store.prepareAttemptSet([second, apiPlan()])), CODES.pending);
  assert.equal(text(store), before);
  assert.equal(codeOf(() => store.prepareAttemptSet([{ ...second, family: 'form' }])), CODES.notSettled);
  assert.equal(codeOf(() => store.prepareAttemptSet([second], { cohort: 'c1' })), CODES.notSettled);
  assert.equal(text(store), before);
});

test('one physical row is never prepared under two groups', () => {
  const dir = dirOf();
  const store = open(dir);
  store.prepareAttemptSet([apiPlan()]);
  const before = text(store);
  assert.throws(() => store.prepareAttemptSet([apiPlan({ key: 'contoso_other', api: API2 })]));
  assert.equal(text(store), before);
});

test('each row is sealed once, before it is sent, under the window epoch of the run that claimed it', () => {
  const store = open(dirOf());
  const [{ token, epoch }] = sending(store);
  assert.equal(epoch, 1);
  assert.equal(codeOf(() => store.sealRowDispatch({ token, epoch: 2, rows: [SEALED[0]] })), CODES.pending, 'an older or newer epoch sends nothing');
  assert.equal(codeOf(() => store.sealRowDispatch({ token, epoch, rows: [{ ...SEALED[1], id: API2 }] })), CODES.requestMismatch, 'a row under another id');
  store.sealRowDispatch({ token, epoch, rows: SEALED });
  assert.equal(codeOf(() => store.sealRowDispatch({ token, epoch, rows: [{ ...SEALED[0], sentFields: ['x'] }] })), CODES.requestMismatch, 'a second send of a sealed row');
  const row = store.readGroup('customApi', API_KEY).pending.rowProtocol.rows[0];
  assert.deepEqual([row.dispatched, row.sentFields, row.sentSha256], [true, ['customapiid', 'uniquename'], H('7')], 'the first sealed projection is kept');
  assert.equal(codeOf(() => store.markAttemptSetSending([{ token, expected: apiExpected() }], { claim: 'continue' })), CODES.pending, 'a dispatched row is never claimed as unsent');
});

test('a completion effect is marked once; a dispatched effect alone defeats an unsent claim', () => {
  const store = open(dirOf());
  const [{ token, epoch }] = sending(store);
  assert.equal(codeOf(() => store.markRowEffectDispatch({ token, epoch, kind: 'rule-state', id: API })), CODES.requestMismatch);
  store.markRowEffectDispatch({ token, epoch, kind: 'membership', id: REQ });
  assert.equal(codeOf(() => store.markRowEffectDispatch({ token, epoch, kind: 'membership', id: REQ })), CODES.requestMismatch);
  assert.equal(codeOf(() => store.markAttemptSetSending([{ token, expected: apiExpected() }], { claim: 'continue' })), CODES.pending);
});

test('an attempt that sent nothing is claimed again under a new epoch, which fences the older run', () => {
  const store = open(dirOf());
  const [{ token }] = sending(store);
  const [{ epoch }] = store.markAttemptSetSending([{ token, expected: apiExpected() }], { claim: 'continue' });
  assert.equal(epoch, 2);
  assert.equal(codeOf(() => store.sealRowDispatch({ token, epoch: 1, rows: SEALED })), CODES.pending);
  store.sealRowDispatch({ token, epoch, rows: SEALED });
});

test('ownership is proved row by row: a root acknowledgement never mints a child, and a child adoption names it exactly', () => {
  const dir = dirOf();
  const store = open(dir);
  const [{ token, epoch }] = sending(store);
  store.sealRowDispatch({ token, epoch, rows: SEALED });
  store.noteSaved(token, { proof: null, acknowledgedRoot: true });
  assert.equal(codeOf(() => store.commitGroupSet([proposal(token)])), CODES.completion, 'a created child needs its own receipt');
  const adopted = proposal(token, { records: [rec('customApi', API_KEY, API), rec('customApiRequestParameter', REQ_KEY, REQ, { parentKey: API_KEY, origin: 'adopted' })] });
  assert.equal(codeOf(() => store.commitGroupSet([adopted])), CODES.adoptionRequired, 'an adopted child needs its own approval');
  assert.equal(codeOf(() => store.commitGroupSet([{ ...adopted, adoptionApproved: true }])), CODES.adoptionRequired, 'the root approval is not the child\'s');
  assert.equal(codeOf(() => store.commitGroupSet([{ ...adopted, adoptionApprovedChildren: [{ kind: 'customApiRequestParameter', key: JSON.stringify([API_KEY, 'request:q']), id: REQ }] }])), CODES.adoptionRequired, 'another slot is another row');
  const [g] = store.commitGroupSet([{ ...adopted, adoptionApprovedChildren: [{ kind: 'customApiRequestParameter', key: REQ_KEY, id: REQ }] }]);
  assert.deepEqual(g.records.map((r) => r.origin), ['created', 'adopted']);
  assert.equal(open(dir).readGroup('customApi', API_KEY).committed.generation, g.generation);
});

test('a child receipt lets the child be recorded created; an unacknowledged root needs the root approval', () => {
  const store = open(dirOf());
  const [{ token, epoch }] = sending(store);
  store.sealRowDispatch({ token, epoch, rows: SEALED });
  store.noteSaved(token, { proof: null, acknowledgedChildCreates: [{ kind: 'customApiRequestParameter', key: REQ_KEY, id: REQ }] });
  assert.equal(codeOf(() => store.commitGroupSet([proposal(token)])), CODES.adoptionRequired);
  const rootAdopted = proposal(token, { records: [rec('customApi', API_KEY, API, { origin: 'adopted' }), rec('customApiRequestParameter', REQ_KEY, REQ, { parentKey: API_KEY })] });
  const [g] = store.commitGroupSet([{ ...rootAdopted, adoptionApproved: true }]);
  assert.deepEqual(g.records.map((r) => r.origin), ['adopted', 'created']);
});

test('commitGroupSet is one write: a refusal of any proposal commits nothing', () => {
  const dir = dirOf();
  const store = open(dir);
  const two = [apiPlan(), apiPlan({ key: 'contoso_other', api: API2, req: REQ2 })];
  const [a, b] = sending(store, two, [apiExpected(), apiExpected({ key: 'contoso_other', api: API2, req: REQ2 })]);
  store.noteSaved(a.token, { proof: null, acknowledgedRoot: true, acknowledgedChildCreates: [{ kind: 'customApiRequestParameter', key: REQ_KEY, id: REQ }] });
  const before = text(store);
  const otherKey = JSON.stringify(['contoso_other', 'request:p']);
  const bProposal = proposal(b.token, { records: [rec('customApi', 'contoso_other', API2), rec('customApiRequestParameter', otherKey, REQ2, { parentKey: 'contoso_other' })], consumerState: apiConsumer({ key: 'contoso_other', api: API2, req: REQ2 }) });
  assert.equal(codeOf(() => store.commitGroupSet([proposal(a.token), bProposal])), CODES.adoptionRequired);
  assert.equal(text(store), before, 'the first group is not committed without the second');
  assert.equal(codeOf(() => store.commitGroupSet([proposal(a.token), proposal(a.token)])), CODES.notSettled);
});

test('a version-2 file with an unknown family, or a configuration unit in a version-1 file, is unreadable whole', () => {
  for (const corrupt of [(d) => { d.attempts[0].family = 'command'; }, (d) => { d.schemaVersion = 1; }]) {
    const dir = dirOf();
    const store = open(dir);
    store.prepareAttemptSet([apiPlan()]);
    const data = JSON.parse(text(store));
    corrupt(data);
    fs.writeFileSync(store.file, JSON.stringify(data));
    assert.equal(codeOf(() => open(dir).snapshot()), CODES.unreadable);
  }
});

test('the manifest view lists a committed configuration group with its rows, and a pending one apart', () => {
  const dir = dirOf();
  const store = open(dir);
  const [{ token }] = sending(store);
  store.noteSaved(token, { proof: null, acknowledgedRoot: true, acknowledgedChildCreates: [{ kind: 'customApiRequestParameter', key: REQ_KEY, id: REQ }] });
  store.commitGroupSet([proposal(token)]);
  store.prepareAttemptSet([apiPlan({ key: 'contoso_other', api: API2, req: REQ2 })]);
  const view = managedManifestView(open(dir).snapshot());
  assert.deepEqual(view.groups.map((g) => [g.family, g.key, g.rows]), [['customApi', API_KEY, apiConsumer().rows]]);
  assert.equal(view.groups[0].declaration, undefined);
  assert.deepEqual(view.pending, [{ family: 'customApi', key: 'contoso_other', code: CODES.pending }]);
  const read = readManagedManifest({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL });
  assert.deepEqual(read.groups, view.groups);
});
