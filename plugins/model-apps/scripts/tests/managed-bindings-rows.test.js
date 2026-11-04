'use strict';
// The configuration row families of the managed binding store (lib/managed-bindings.js ROW_FAMILIES, `rowProtocol`):
// a version-2 file that an old-family-only workspace never gets, sets of attempts prepared, sent and committed in one
// write each, every row sealed once before its request leaves, and ownership proved row by row — a root's
// acknowledgement or approval never mints a child.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { CODES, managedManifestView, readManagedManifest } = require('../lib/managed-bindings.js');
const { ENV, APP, SOL, FP, H, API, REQ, FORM, API_KEY, REQ_KEY, PROOF, open, rec, codeOf, apiPlan, apiExpected, apiConsumer, settleForm } = require('./helpers/managed-rows.js');

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

// --- Versions and vocabulary a newer plugin may write, and the files an older one wrote.

const FORM2 = '44444444-4444-4444-8444-444444444444';
const DASH = '77777777-7777-4777-8777-777777777777';
const formScope = (table) => ({ type: 'table', table });
const prepareForm = (store, key, id, table) => store.prepareAttempt({ family: 'form', key, baseGeneration: null, root: { kind: 'form', key, id }, knownScopes: [formScope(table)], declarationSha256: H('e'), publication: { scope: formScope(table), state: 'owed' } });
// A version-2 store with a committed Custom API group (groups[0]) and a second one sending (attempts[0]).
function rowStore() {
  const dir = dirOf();
  const store = open(dir);
  const [{ token }] = sending(store);
  store.noteSaved(token, { proof: null, acknowledgedRoot: true, acknowledgedChildCreates: [{ kind: 'customApiRequestParameter', key: REQ_KEY, id: REQ }] });
  store.commitGroupSet([proposal(token)]);
  sending(store, [apiPlan({ key: 'contoso_other', api: API2, req: REQ2 })], [apiExpected({ key: 'contoso_other', api: API2, req: REQ2 })]);
  return { dir, store };
}
const rewrite = (store, corrupt) => {
  const data = JSON.parse(text(store));
  corrupt(data);
  fs.writeFileSync(store.file, `${JSON.stringify(data, null, 2)}\n`);
};

test('a row protocol, consumer, record or proof version, a proof schema or a field this build does not know, at any depth of a closed shape, makes the whole store unreadable, and no sibling is written', () => {
  const newer = {
    'row protocol version': (d) => { d.attempts[0].rowProtocol.version = 2; },
    'row field': (d) => { d.attempts[0].rowProtocol.rows[1].ordinal = 1; },
    'row protocol field': (d) => { d.attempts[0].rowProtocol.order = []; },
    'effect field': (d) => { d.attempts[0].rowProtocol.effects[0].after = 'x'; },
    'completion field': (d) => { d.attempts[0].rowProtocol.completion.compound = []; },
    'member field': (d) => { d.attempts[0].rowProtocol.completion.members[0].behavior = 1; },
    'attempt field': (d) => { d.attempts[0].cohortToken = 'c'; },
    'expected proof version': (d) => { d.attempts[0].expected.proofVersion = 2; },
    'expected proof schema': (d) => { d.attempts[0].expected.proofSchema = 'configuration-rows-v2'; },
    'expected field': (d) => { d.attempts[0].expected.batch = null; },
    'expected child field': (d) => { d.attempts[0].expected.children[0].order = 0; },
    'consumer version': (d) => { d.groups[0].consumerState.version = 2; },
    'consumer row field': (d) => { d.groups[0].consumerState.rows[0].privateSha256 = H('1'); },
    'consumer field': (d) => { d.groups[0].consumerState.cohort = null; },
    'record format': (d) => { d.groups[0].records[1].formatVersion = 2; },
    'record field': (d) => { d.groups[0].records[0].cohort = 'c'; },
    'group proof schema': (d) => { d.groups[0].proofSchema = 'configuration-rows-v2'; },
    'group field': (d) => { d.groups[0].cohort = null; },
    'group proof field': (d) => { d.groups[0].proof.cohortSha256 = H('2'); },
    'group root field': (d) => { d.groups[0].root.cohort = 'c'; },
    'group publication field': (d) => { d.groups[0].publication = { scope: { type: 'table', table: 'account' }, state: 'not-needed', desiredSha256: null, dispatchToken: null, cohort: null }; },
    'attempt root field': (d) => { d.attempts[0].root.cohort = 'c'; },
    'send window field': (d) => { d.attempts[0].sendWindow = { possible: 0, notStarted: 0, epoch: 1, lane: 0 }; },
    'completion reserve field': (d) => { d.attempts[0].completionReserve.spare = 0; },
    'known scope field': (d) => { d.attempts[0].knownScopes = [{ type: 'table', table: 'account', lane: 0 }]; },
  };
  const outcome = (name, corrupt) => {
    const { dir, store } = rowStore();
    rewrite(store, corrupt);
    const bytes = text(store);
    return [name, codeOf(() => open(dir)), codeOf(() => store.refresh()), codeOf(() => prepareForm(store, 'account/main', FORM, 'account')), text(store) === bytes];
  };
  const got = Object.entries(newer).map(([name, corrupt]) => outcome(name, corrupt));
  assert.deepEqual(got, Object.keys(newer).map((name) => [name, CODES.unreadable, CODES.unreadable, CODES.unreadable, true]), 'open, refresh and a form write are each refused, and the file is kept as it was');
});

test('a configuration unit that is merely malformed is isolated, and a sibling is still written', () => {
  const malformed = {
    'a version of the wrong type': (d) => { d.attempts[0].rowProtocol.version = '1'; },
    'a missing field': (d) => { delete d.attempts[0].rowProtocol.rows[1].sentSha256; },
    'a hash that is not one': (d) => { d.attempts[0].expected.sentProjectionSha256 = 'x'; },
    'a root with no id': (d) => { delete d.attempts[0].root.id; },
    'a send window count of the wrong type': (d) => { d.attempts[0].sendWindow = { possible: '0', notStarted: 0, epoch: 1 }; },
    'a reservation with no used count': (d) => { delete d.attempts[0].completionReserve.used; },
  };
  for (const [name, corrupt] of Object.entries(malformed)) {
    const { dir, store } = rowStore();
    rewrite(store, corrupt);
    const again = open(dir);
    assert.equal(codeOf(() => again.readGroup('customApi', 'contoso_other')), CODES.groupInvalid, name);
    assert.equal(typeof prepareForm(again, 'account/main', FORM, 'account'), 'string', `${name}: a form is still written`);
  }
});

test('a set mutation charges every attempt it spends for, and never an attempt it does not name', () => {
  const store = open(dirOf());
  const [unrelated] = store.prepareAttemptSet([apiPlan({ key: 'contoso_third', api: '88888888-8888-4888-8888-888888888888', req: '99999999-9999-4999-8999-999999999999' })]);
  const plans = [apiPlan(), apiPlan({ key: 'contoso_other', api: API2, req: REQ2 })];
  const tokens = store.prepareAttemptSet(plans);
  const reserve = (token) => JSON.parse(text(store)).attempts.find((a) => a.token === token).completionReserve;
  const before = Buffer.byteLength(text(store), 'utf8');
  store.markAttemptSetSending([{ token: tokens[0], expected: apiExpected() }, { token: tokens[1], expected: apiExpected({ key: 'contoso_other', api: API2, req: REQ2 }) }]);
  const grown = Buffer.byteLength(text(store), 'utf8') - before;
  const [a, b] = tokens.map(reserve);
  assert.ok(a.used > 0 && b.used > 0, `both participants pay (${a.used}, ${b.used})`);
  assert.ok(a.used + b.used >= grown, `together they pay the whole growth (${a.used} + ${b.used} of ${grown})`);
  assert.equal(reserve(unrelated).used, 0, 'an attempt the write did not name keeps its whole reservation');
});

test('an old-family file stays version 1, a dashboard create receipt included; a version-2 file stays 2', () => {
  const dir = dirOf();
  const store = open(dir);
  settleForm(store);
  const dscope = { type: 'dashboard', id: DASH };
  const token = store.prepareAttempt({ family: 'dashboard', key: 'ops', baseGeneration: null, root: { kind: 'dashboard', key: 'ops', id: DASH }, knownScopes: [dscope], declarationSha256: H('e'), publication: { scope: dscope, state: 'owed' } });
  const exp = { proofVersion: 1, proofSchema: 'dashboard-v1', rootId: DASH, baseProofSha256: null, sentProjectionSha256: H('b'), preservationSha256: H('c'), baseObservation: null, children: [] };
  const { epoch } = store.markSending(token, exp, { observed: true });
  store.noteDashboardCreateDraft(token, { sendEpoch: epoch, rootId: DASH, draftSha256: H('7'), bodySha256: H('8') });
  assert.equal(JSON.parse(text(store)).schemaVersion, 1);
  prepareForm(store, 'contact/main', FORM2, 'contact');
  assert.equal(JSON.parse(text(store)).schemaVersion, 1, 'dashboard recovery fields alone never upgrade the file');
  const dir2 = dirOf();
  settleForm(open(dir2));
  rewrite(open(dir2), (d) => { d.schemaVersion = 2; });
  const two = open(dir2);
  prepareForm(two, 'contact/main', FORM2, 'contact');
  assert.equal(JSON.parse(text(two)).schemaVersion, 2, 'a version-2 file is never written back as 1');
});

// The same old-family writes, in the same order and with the same tokens, leave the same bytes on disk as the 2.22.0
// store wrote (the digests below were taken by running this sequence against that release). A configuration family
// changes nothing of how a file without one is written: not its version, its fields, their order or its accounting.
test('old-family writes are byte for byte what the previous release wrote', () => {
  const WANT = [
    '7626f752adc2604fe6d56d8255e2482bfcd8893802204045c8012ea2e493667f', '0d3a59184d0b4ff7d6191f82563307354b0a6d047143afa5a914910c6762a4b8',
    '89e72530691a79dd64ccfd586efec2d1e526d4eadb286c62344d8b9ec9df99ea', '7b499bec0f386f2f781846f475908d9cf94d1aaaff3999fb96494a2667e69abf',
    '29f17427b57f5560828df60fab078670e297302898634f9c4cdebd77b96c2403', 'a990343e2dd2a8905bf99809660cce51002400b48fb58e69fd4a1c6fe4bd0dfd',
    'd01c5c703e36f5f153267f8bde560854fe2747425a7720ecb3fd7bfa84ce652d', 'c7671610f743b8c4346e577579e995f926af7af61b8511fe3e211ed2d2fd0f29',
    '87dc1d3661ee3e3e88c5b4d3a9f7f72d30b0b9900a2f527e5c14cf195636776f', 'a7e20721e6734d661408cd8aca94f1c90e0741c3fd250dd8f6a3d51b2bf2875c',
    '43c104fa5531bb0d9ed30619cad14a063a02b1d9b61db8e8e172d32ae61a4bc0', '79faad00eb88d15e84421e44ad96c856c25085eab9f3bd18df07eec634d7e9a8',
    '2c68665b8246990399cf0c409b2ae7a5be522445dab29287d7fd9eadd3bd5739', 'f36f18b421fb63c989c2876e23f590dfd73afcea9c17c67d9763a1aad117f8ff',
  ];
  const real = crypto.randomUUID;
  let n = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  try {
    const store = open(dirOf());
    const got = [];
    const step = (fn) => { fn(); got.push(crypto.createHash('sha256').update(fs.readFileSync(store.file)).digest('hex')); };
    const scope = formScope('account');
    const dscope = { type: 'dashboard', id: DASH };
    const exp = (rootId, schema) => ({ proofVersion: 1, proofSchema: schema, rootId, baseProofSha256: null, sentProjectionSha256: H('b'), preservationSha256: H('c'), baseObservation: null, children: [] });
    const record = (kind, key, id) => ({ formatVersion: 1, appUniqueName: APP, environmentFingerprint: FP, kind, key, id, intentSha256: H('a'), origin: 'created' });
    let t1; let t2; let t3; let epoch; let dispatchToken;
    step(() => { t1 = prepareForm(store, 'account/main', FORM, 'account'); });
    step(() => store.markSending(t1, exp(FORM, 'form-v1')));
    step(() => store.noteSaved(t1, { proof: { savedSha256: H('1') }, acknowledgedRoot: true }));
    step(() => store.commitGroup({ token: t1, baseGeneration: null, records: [record('form', 'account/main', FORM)], proof: PROOF, consumerState: { declaration: { name: 'Main' }, children: {}, proofSchema: 'form-v1' }, publication: { scope, state: 'owed', desiredSha256: H('5'), dispatchToken: null } }));
    step(() => { t2 = store.prepareAttempt({ family: 'dashboard', key: 'ops', baseGeneration: null, root: { kind: 'dashboard', key: 'ops', id: DASH }, knownScopes: [dscope], declarationSha256: H('e'), publication: { scope: dscope, state: 'owed' } }); });
    step(() => { ({ epoch } = store.markSending(t2, exp(DASH, 'dashboard-v1'), { observed: true })); });
    step(() => store.noteDashboardCreateDraft(t2, { sendEpoch: epoch, rootId: DASH, draftSha256: H('7'), bodySha256: H('8') }));
    step(() => { ({ dispatchToken } = store.noteDashboardCreateDispatch(t2, { sendEpoch: epoch, bodySha256: H('8') })); });
    step(() => store.noteAttemptDispatch(t2, epoch));
    step(() => store.noteDashboardCreateAnswer(t2, { sendEpoch: epoch, dispatchToken, bodySha256: H('8') }));
    step(() => store.noteSaved(t2, { proof: null, acknowledgedRoot: true }));
    step(() => store.commitGroup({ token: t2, baseGeneration: null, records: [record('dashboard', 'ops', DASH)], proof: PROOF, consumerState: { declaration: {}, tiles: {}, seedIds: [] }, publication: { scope: dscope, state: 'owed', desiredSha256: H('5'), dispatchToken: null } }));
    step(() => { t3 = prepareForm(store, 'contact/main', FORM2, 'contact'); });
    step(() => store.retireUnsentAttempt({ token: t3, baseGeneration: null }));
    assert.deepEqual(got, WANT);
    assert.equal(JSON.parse(text(store)).schemaVersion, 1);
  } finally {
    crypto.randomUUID = real;
  }
});