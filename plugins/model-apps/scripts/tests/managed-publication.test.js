'use strict';
// Publication of managed forms and dashboards: the holds, quarantines and publication debt of the managed settlement
// (lib/managed-feature-contract.js, lib/managed-bindings.js) on the run's publication barrier (lib/publication-barrier.js),
// through the plugin's real HTTP client and the barrier's real transport gate, counting the PublishXml requests that
// reach the wire. A table publish ships everything saved on the table, and a dashboard publish everything saved on the
// dashboard, so a scope whose managed change is not proved must not be published by anyone in the run — a sibling's
// success included — and a publish whose outcome is unknown is never sent a second time.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createManagedWire, sdkOver } = require('./helpers/managed-wire.js');
const { openManagedContext, openManagedBindings, CODES } = require('../lib/managed-bindings.js');
const { runManagedFeature, publishManagedScope, PUBLICATION_UNCONFIRMED, PUBLICATION_UNVERIFIED, CREATION_RECORD_UNSETTLED } = require('../lib/managed-feature-contract.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { readSystemFormPublication } = require('../lib/systemform-published.js');
const { publishTablesXml } = require('../lib/table-publish.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');
const { canonicalJson } = require('../lib/reconcile-common.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = 'contoso_app';
const SOL = 'contoso_solution';
const FP = environmentFingerprint(ENV);
const H = (c) => c.repeat(64);
const sha = (v) => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const layerHash = (row) => sha({ name: row.name, description: row.description, formxml: row.formxml });
const MAIN = '11111111-1111-4111-8111-111111111111';
const QUICK = '12121212-1212-4121-8121-121212121212';
const DASH = '22222222-2222-4222-8222-222222222222';
const DASH2 = '23232323-2323-4232-8232-232323232323';
const UNRELATED = '29292929-2929-4292-8292-292929292929';
const ACCOUNT = { type: 'table', table: 'account' };
const dashScope = (id) => ({ type: 'dashboard', id });
const rec = (kind, key, id) => ({ formatVersion: 1, appUniqueName: APP, environmentFingerprint: FP, kind, key, id, intentSha256: H('a'), origin: 'created' });
const expected = (rootId) => ({ proofVersion: 1, proofSchema: 'form-v1', rootId, baseProofSha256: null, sentProjectionSha256: H('b'), preservationSha256: H('c'), baseObservation: null, children: [] });
const PROOF = { savedSha256: H('1'), semanticSha256: H('2'), preservationSha256: H('3'), expectedChildrenSha256: null };
const codeOf = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

// What the build's managedStop does: answer a never-retry halt, never throw it.
const halts = [];
const halt = (phase, label, code, { cause } = {}) => { const e = Object.assign(new Error(`${label}: ${code}`), { phase, code, cause, retry: 'never' }); halts.push(e); return e; };

function context(dir, barrier) {
  return openManagedContext({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier });
}

const consumer = (family) => (family === 'dashboard' ? { declaration: {}, tiles: {}, seedIds: [] } : { declaration: {}, children: {}, proofSchema: 'form-v1' });
const familyScope = (family, id) => (family === 'dashboard' ? dashScope(id) : ACCOUNT);

// The ports of one managed form or dashboard over the wire: the change writes the saved layer; the proof reads it back.
function ports(wire, sdk, { family = 'form', key, id, formxml, fail = {} }) {
  const scope = familyScope(family, id);
  const step = (name, fn) => async (...a) => { if (fail[name]) throw fail[name]; return fn(...a); };
  return {
    phase: family === 'dashboard' ? 'dashboards' : 'forms', family, key, knownScopes: [scope], knownIds: [id], halt,
    resolve: step('resolve', async () => ({})),
    plan: step('plan', async () => {
      const current = wire.saved.get(id);
      if (current && current.formxml === formxml) return { noop: true };
      return { root: { kind: family, key, id }, expected: expected(id), declarationSha256: H('e'), publication: { scope, state: 'owed' } };
    }),
    apply: step('apply', async () => {
      if (!wire.saved.has(id)) wire.putForm({ formid: id, name: key, objecttypecode: family === 'dashboard' ? 'none' : 'account', type: family === 'dashboard' ? 0 : 2, formxml });
      else await sdk.dataverse.patch(`/systemforms(${id})`, { formxml });
      return { sent: true };
    }),
    prove: step('prove', async () => {
      const read = await readSystemFormPublication(sdk.dataverse, id);
      if (read.saved.formxml !== formxml) throw Object.assign(new Error('the saved form is not the declared one'), { code: 'create-completion-required' });
      return {
        savedProof: { savedSha256: layerHash(read.saved) }, acknowledgedRoot: true, records: [rec(family, key, id)], proof: PROOF, consumerState: consumer(family),
        publication: read.state === 'equal' ? { scope, state: 'not-needed', desiredSha256: null, dispatchToken: null } : { scope, state: 'owed', desiredSha256: layerHash(read.saved), dispatchToken: null },
      };
    }),
    ensureMembership: step('membership', async () => undefined),
  };
}

const readLayersOf = (sdk) => async (group) => {
  const r = await readSystemFormPublication(sdk.dataverse, group.root.id);
  return { savedSha256: layerHash(r.saved), publishedSha256: r.published ? layerHash(r.published) : H('0') };
};
const publishForms = (sdk, store, barrier, groups) => publishManagedScope({
  store, barrier, scope: ACCOUNT, groups, readLayers: readLayersOf(sdk), path: 'managed forms of account',
  publish: async () => { const r = await publishTablesXml(sdk.dataverse, ['account']); if (!r.ok) throw Object.assign(new Error(r.reason), { code: 'publish-failed' }); },
});
const publishDashboard = (sdk, store, barrier, family, key, id) => publishManagedScope({
  store, barrier, scope: dashScope(id), groups: [{ family, key }], readLayers: readLayersOf(sdk), path: `managed dashboard ${key}`,
  publish: async () => { await sdk.fetchArtifact('dashboard', id); await sdk.publishArtifact('dashboard', id); },
});

async function setup() {
  const wire = createManagedWire();
  const barrier = createPublicationBarrier();
  const { sdk } = await sdkOver(wire, { barrier });
  const dir = makeTempDir('mp-');
  const { store } = context(dir, barrier);
  return { wire, barrier, sdk, dir, store };
}

test('holds and quarantine: a hold ends only with its own token; a quarantine ends with nothing; a registered scope is not withheld', () => {
  const b = createPublicationBarrier();
  b.registerKnown([ACCOUNT, dashScope(DASH)], [MAIN, DASH]);
  assert.equal(b.active, false, 'a known scope is not a block');
  b.hold('attempt-a', [ACCOUNT], [MAIN], 'form a');
  b.hold('attempt-b', [ACCOUNT], [QUICK], 'form b');
  assert.equal(b.release('attempt-b'), true);
  assert.equal(b.allowScope(ACCOUNT, 'sibling'), false, 'a sibling\'s release does not end another attempt\'s hold');
  assert.equal(b.release('attempt-a'), true);
  assert.equal(b.allowScope(ACCOUNT, 'after'), true);
  b.quarantine([dashScope(DASH)], [DASH], 'dashboard sales (proof failed)');
  for (const t of ['attempt-a', 'attempt-b', 'anything']) b.release(t);
  assert.equal(b.allowScope(dashScope(DASH), 'later'), false);
  assert.equal(b.allowTarget(['dashboard', DASH], 'app'), false);
  assert.equal(b.allowScope(dashScope(UNRELATED), 'later'), true, 'an unrelated dashboard stays eligible');
  assert.deepEqual(b.withheld().map((w) => [w.dashboard, w.blockedBy]), [[DASH, ['dashboard sales (proof failed)']]]);
});

test('a send permit lets one publish through its own hold only: once, recorded at the send, never past another hold or block', async () => {
  const b = createPublicationBarrier();
  const sent = [];
  const gate = b.gateRequest(async (req) => { sent.push(req.body); return { statusCode: 204, headers: {}, body: '' }; });
  const pub = (tables) => gate({ url: `${ENV}/api/data/v9.0/PublishXml`, method: 'POST', headers: {}, body: JSON.stringify({ ParameterXml: `<importexportxml><entities>${tables.map((t) => `<entity>${t}</entity>`).join('')}</entities></importexportxml>` }) });
  b.hold('own', [ACCOUNT], [MAIN], 'form main (its publish is being sent)');
  const events = [];
  const permit = { token: 'own', scope: ACCOUNT, onDispatch: () => events.push('dispatch'), onWithheld: () => events.push('withheld') };
  await pub(['account']);
  assert.equal(sent.length, 0, 'outside the permit the hold withholds the table');
  await b.withSendPermit(permit, async () => {
    assert.equal((await pub(['account'])).statusCode, 204);
    assert.equal((await pub(['account'])).statusCode, 409, 'a second publish under one permit is not sent');
  });
  assert.deepEqual(events, ['dispatch']);
  assert.equal(sent.length, 1);

  const refused = [];
  await assert.rejects(b.withSendPermit({ ...permit, onDispatch: () => { throw Object.assign(new Error('disk full'), { code: 'store-write' }); } }, () => pub(['account'])), { code: 'store-write' });
  assert.equal(sent.length, 1, 'a dispatch that cannot be recorded is not sent');

  b.hold('sibling', [ACCOUNT], [QUICK], 'form quick (being saved)');
  await b.withSendPermit({ ...permit, onDispatch: () => refused.push('dispatch'), onWithheld: () => refused.push('withheld') }, async () => {
    assert.equal((await pub(['account', 'contact'])).statusCode, 409, 'nothing of a request whose own scope another hold withholds is sent');
  });
  assert.deepEqual(refused, ['withheld']);
  assert.equal(sent.length, 1);
  assert.equal(b.allowScope(ACCOUNT, 'after'), false, 'a permit releases nothing');
});

test('an unchanged managed form whose solution membership fails quarantines its table: an earlier sibling view\'s owed table publish sends nothing', async () => {
  const s = await setup();
  s.wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form v="1"/>' }, { publishedToo: true });
  // A declared view settled earlier in the run and owes the publish of account.
  const owedTables = ['account'];
  const p = ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>', fail: { membership: Object.assign(new Error('AddSolutionComponent failed'), { code: 'membership-failed' }) } });
  assert.equal(await codeOf(runManagedFeature({ ...p, store: s.store, barrier: s.barrier })), 'membership-failed');
  const mark = s.wire.log.length;
  await publishTablesXml(s.sdk.dataverse, owedTables);
  await publishTablesXml(s.sdk.dataverse, s.barrier.allowTables(owedTables, 'the publish phase'));
  assert.equal(s.wire.publishes('account').length, 0, 'zero overlapping table publishes');
  assert.ok(s.wire.log.length >= mark);
  assert.equal(s.barrier.checkAppWrite({ held: new Set(['account']), existingApp: true }).ok, false, 'and no app publish that holds the table');
  await publishTablesXml(s.sdk.dataverse, ['contact']);
  assert.equal(s.wire.publishes('contact').length, 1, 'an unrelated table still publishes');
});

test('publication debt: saved equals the declaration and the published layer is stale — one scoped publish, no content write; the next run publishes nothing', async () => {
  const s = await setup();
  s.wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form v="1"/>' }, { publishedToo: true });
  s.wire.saved.get(MAIN).formxml = '<form v="2"/>';
  const p = ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' });
  // The group was committed with the debt by an earlier run that stopped before publishing.
  const t = s.store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: MAIN }, knownScopes: [ACCOUNT], declarationSha256: H('e'), publication: { scope: ACCOUNT, state: 'owed' } });
  s.store.markSending(t, expected(MAIN));
  s.store.noteSaved(t, { proof: null, acknowledgedRoot: true });
  s.store.commitGroup({ token: t, baseGeneration: null, records: [rec('form', 'account/main', MAIN)], proof: PROOF, consumerState: consumer('form'), publication: { scope: ACCOUNT, state: 'owed', desiredSha256: layerHash(s.wire.saved.get(MAIN)), dispatchToken: null } });

  const r = await runManagedFeature({ ...p, store: s.store, barrier: s.barrier });
  assert.deepEqual(r.result, { noop: true });
  const out = await publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }]);
  assert.equal(out.sent, true);
  assert.equal(s.wire.publishes('account').length, 1);
  assert.deepEqual(s.wire.writes().filter((w) => !/PublishXml/.test(w.path)), [], 'no content write');
  assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'confirmed');

  const next = await setup();
  next.wire.saved.set(MAIN, s.wire.saved.get(MAIN));
  next.wire.published.set(MAIN, s.wire.published.get(MAIN));
  const again = context(s.dir, next.barrier).store;
  await runManagedFeature({ ...ports(next.wire, next.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }), store: again, barrier: next.barrier });
  assert.deepEqual(await publishForms(next.sdk, again, next.barrier, [{ family: 'form', key: 'account/main' }]), { sent: false, withheld: false, confirmed: [] });
  assert.equal(next.wire.publishes().length, 0, 'the identical next run publishes nothing');
});

test('a first publish whose answer is lost is never sent a second time, in this run or the next', async () => {
  const s = await setup();
  const p = ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  await runManagedFeature({ ...p, store: s.store, barrier: s.barrier });
  s.wire.script((e) => /PublishXml/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216', message: 'gateway' } }, unapplied: true });
  assert.equal(await codeOf(publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }])), PUBLICATION_UNCONFIRMED);
  assert.equal(s.wire.publishes('account').length, 1, 'the client sends a publish once');
  assert.equal(await codeOf(publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }])), PUBLICATION_UNCONFIRMED);
  assert.equal(s.wire.publishes('account').length, 1);

  // The next run: the store's uncertain publish withholds the table from every path, and the debt is never re-sent.
  const nextBarrier = createPublicationBarrier();
  const next = context(s.dir, nextBarrier);
  assert.deepEqual(next.debt.map((d) => d.kind), ['uncertain']);
  const { sdk } = await sdkOver(s.wire, { barrier: nextBarrier });
  assert.equal(await codeOf(publishForms(sdk, next.store, nextBarrier, [{ family: 'form', key: 'account/main' }])), PUBLICATION_UNCONFIRMED);
  await publishTablesXml(sdk.dataverse, ['account']);
  assert.equal(s.wire.publishes('account').length, 1, 'no second publish');
});

const publishAll = (s) => s.barrier.gateRequest(s.wire.request)({ url: `${ENV}/api/data/v9.0/PublishAllXml`, method: 'POST', headers: {}, body: '{}' });
// An earlier run committed `formxml` on MAIN and stopped before publishing it: the group owes its publish.
function commitOwedForm(s, formxml) {
  const t = s.store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: MAIN }, knownScopes: [ACCOUNT], declarationSha256: H('e'), publication: { scope: ACCOUNT, state: 'owed' } });
  s.store.markSending(t, expected(MAIN));
  s.store.noteSaved(t, { proof: null, acknowledgedRoot: true });
  const desired = layerHash({ ...s.wire.saved.get(MAIN), formxml });
  s.store.commitGroup({ token: t, baseGeneration: null, records: [rec('form', 'account/main', MAIN)], proof: PROOF, consumerState: consumer('form'), publication: { scope: ACCOUNT, state: 'owed', desiredSha256: desired, dispatchToken: null } });
}

test('a publish whose answer is lost withholds its table for the rest of the run: no sibling table publish, publish-all or app write overlaps it; another table still publishes', async () => {
  const s = await setup();
  await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier });
  s.wire.script((e) => /PublishXml/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216', message: 'gateway' } }, unapplied: true });
  assert.equal(await codeOf(publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }])), PUBLICATION_UNCONFIRMED);
  assert.equal(s.wire.publishes('account').length, 1);
  assert.equal(s.barrier.allowScope(ACCOUNT, 'a sibling view'), false, 'the table is withheld, not merely released');
  assert.deepEqual(s.barrier.allowTables(['account', 'contact'], 'the publish phase'), ['contact']);
  await publishTablesXml(s.sdk.dataverse, ['account']);
  await publishAll(s);
  assert.equal(s.wire.publishes('account').length, 1, 'no sibling path publishes over the unconfirmed send');
  assert.equal(s.wire.log.filter((e) => /PublishAllXml/.test(e.path)).length, 0);
  assert.equal(s.barrier.checkAppWrite({ held: new Set(['account']), existingApp: true }).ok, false);
  await publishTablesXml(s.sdk.dataverse, ['contact']);
  assert.equal(s.wire.publishes('contact').length, 1, 'an unrelated table still publishes');
  assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'unconfirmed');
});

test('a scope a sibling holds at the moment of the send is not published and consumes nothing: the debt stays owed and is paid once the sibling releases it', async () => {
  const s = await setup();
  await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier });
  const groups = [{ family: 'form', key: 'account/main' }];
  const out = await publishManagedScope({
    store: s.store, barrier: s.barrier, scope: ACCOUNT, groups, readLayers: readLayersOf(s.sdk), path: 'managed forms of account',
    publish: async () => {
      // A sibling form starts saving on the table between the barrier's check and the send.
      s.barrier.hold('sibling', [ACCOUNT], [QUICK], 'form quick (being saved)');
      const r = await publishTablesXml(s.sdk.dataverse, ['account']);
      if (!r.ok) throw Object.assign(new Error(r.reason), { code: 'publish-failed' });
    },
  });
  assert.deepEqual(out, { sent: false, withheld: true, confirmed: [] });
  assert.equal(s.wire.publishes('account').length, 0, 'nothing overlaps the sibling\'s unproved change');
  assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'owed', 'the debt is not consumed');
  assert.equal(s.barrier.allowScope(ACCOUNT, 'after'), false, 'the sibling\'s hold stands');
  s.barrier.release('sibling');
  assert.equal((await publishForms(s.sdk, s.store, s.barrier, groups)).sent, true);
  assert.equal(s.wire.publishes('account').length, 1);
  assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'confirmed');
});

test('owed publication whose saved layer has drifted is not published: nothing is sent, the debt stays owed and the table is withheld; an equal saved layer publishes once', async () => {
  const s = await setup();
  s.wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form v="1"/>' }, { publishedToo: true });
  commitOwedForm(s, '<form v="2"/>');
  // Someone else's change is saved on the form: publishing the table would put it live under this debt.
  s.wire.saved.get(MAIN).formxml = '<form foreign="1"/>';
  assert.equal(await codeOf(publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }])), 'create-completion-required');
  assert.equal(s.wire.publishes().length, 0);
  assert.equal(s.wire.published.get(MAIN).formxml, '<form v="1"/>', 'the foreign change was not published');
  assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'owed');
  await publishTablesXml(s.sdk.dataverse, ['account']);
  assert.equal(s.wire.publishes().length, 0, 'the table is withheld for the rest of the run');

  const c = await setup();
  c.wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form v="1"/>' }, { publishedToo: true });
  commitOwedForm(c, '<form v="2"/>');
  c.wire.saved.get(MAIN).formxml = '<form v="2"/>';
  assert.equal((await publishForms(c.sdk, c.store, c.barrier, [{ family: 'form', key: 'account/main' }])).sent, true);
  assert.equal(c.wire.publishes('account').length, 1);
  assert.equal(c.wire.published.get(MAIN).formxml, '<form v="2"/>');
});

test('a dashboard known only by its retained id, with no scope given, is quarantined when its creation record is not settled: no path publishes it', async () => {
  const s = await setup();
  s.wire.putForm({ formid: DASH, name: 'Sales', objecttypecode: 'none', type: 0, formxml: '<form d="1"/>' });
  s.wire.putForm({ formid: UNRELATED, name: 'Other', objecttypecode: 'none', type: 0, formxml: '<form o="1"/>' });
  let downstream = 0;
  const later = async () => { downstream += 1; };
  const code = await codeOf(runManagedFeature({
    phase: 'dashboards', family: 'dashboard', key: 'sales', knownScopes: [], knownIds: [DASH], store: s.store, barrier: s.barrier, halt,
    resolve: async () => { throw Object.assign(new Error('the retained creation is not settled'), { code: CREATION_RECORD_UNSETTLED }); },
    plan: later, apply: later, prove: later, ensureMembership: later,
  }));
  assert.equal(code, CREATION_RECORD_UNSETTLED);
  assert.equal(downstream, 0);
  assert.equal(s.barrier.active, true);
  await s.sdk.fetchArtifact('dashboard', DASH);
  await s.sdk.publishArtifact('dashboard', DASH);
  await s.barrier.gateRequest(s.wire.request)({ url: `${ENV}/api/data/v9.0/PublishXml`, method: 'POST', headers: {}, body: JSON.stringify({ ParameterXml: `<importexportxml><dashboards><dashboard>${DASH}</dashboard></dashboards></importexportxml>` }) });
  assert.equal(s.wire.publishes(DASH).length, 0, 'zero sends that name the dashboard');
  assert.equal(s.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [DASH] }).ok, false);
  await s.sdk.fetchArtifact('dashboard', UNRELATED);
  await s.sdk.publishArtifact('dashboard', UNRELATED);
  assert.equal(s.wire.publishes(UNRELATED).length, 1, 'an unrelated dashboard still publishes');
});

test('a successful create and a successful recovery of a pending attempt each send one scoped publish; a true no-op sends none', async () => {
  const s = await setup();
  const p = ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  assert.equal((await runManagedFeature({ ...p, store: s.store, barrier: s.barrier })).result.committed, true);
  await publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }]);
  assert.equal(s.wire.publishes('account').length, 1);

  // A true no-op: saved equals the declaration, published equals saved, nothing pending.
  const noop = await runManagedFeature({ ...p, store: s.store, barrier: s.barrier });
  assert.deepEqual(noop.result, { noop: true });
  await publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }]);
  assert.equal(s.wire.publishes('account').length, 1);

  // A run that dies after the service accepted the change, before the commit.
  const crash = Object.assign(new Error('the process ended'), { code: 'crash' });
  const p2 = ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>', fail: { prove: crash } });
  const realApply = p2.apply;
  let applied = 0;
  p2.apply = async (...a) => { applied += 1; return realApply(...a); };
  assert.equal(await codeOf(runManagedFeature({ ...p2, store: s.store, barrier: s.barrier })), 'crash');
  assert.equal(applied, 1);

  const b = createPublicationBarrier();
  const recovered = context(s.dir, b);
  assert.deepEqual(recovered.debt.map((d) => d.kind), ['hold']);
  const { sdk } = await sdkOver(s.wire, { barrier: b });
  const p3 = ports(s.wire, sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' });
  const r = await runManagedFeature({ ...p3, store: recovered.store, barrier: b });
  assert.deepEqual(r.result, { committed: true, recovered: true });
  assert.equal(b.active, false, 'the recovered attempt released its own hold');
  await publishForms(sdk, recovered.store, b, [{ family: 'form', key: 'account/main' }]);
  assert.equal(s.wire.publishes('account').length, 2, 'exactly one more publish, for the recovered change');
  assert.equal(s.wire.published.get(MAIN).formxml, '<form v="2"/>');
});

test('two forms on one table, one fails its proof: the other\'s success does not release the table', async () => {
  const s = await setup();
  const bad = ports(s.wire, s.sdk, { key: 'account/quick', id: QUICK, formxml: '<form q="1"/>', fail: { prove: Object.assign(new Error('read back differs'), { code: 'create-completion-required' }) } });
  const good = ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  assert.equal(await codeOf(runManagedFeature({ ...bad, store: s.store, barrier: s.barrier })), 'create-completion-required');
  assert.equal((await runManagedFeature({ ...good, store: s.store, barrier: s.barrier })).result.committed, true);
  const out = await publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }]);
  assert.equal(out.withheld, true);
  await publishTablesXml(s.sdk.dataverse, ['account']);
  assert.equal(s.wire.publishes('account').length, 0);
  assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'owed', 'the debt stays for a later run');
});

test('two dashboards, one fails: the other publishes its own scope, the failed one is never published, nor is an app that holds it', async () => {
  const s = await setup();
  const bad = ports(s.wire, s.sdk, { family: 'dashboard', key: 'sales', id: DASH, formxml: '<form d="1"/>', fail: { prove: Object.assign(new Error('tiles differ'), { code: 'create-completion-required' }) } });
  const good = ports(s.wire, s.sdk, { family: 'dashboard', key: 'service', id: DASH2, formxml: '<form d="2"/>' });
  assert.equal(await codeOf(runManagedFeature({ ...bad, store: s.store, barrier: s.barrier })), 'create-completion-required');
  assert.equal((await runManagedFeature({ ...good, store: s.store, barrier: s.barrier })).result.committed, true);
  assert.equal((await publishDashboard(s.sdk, s.store, s.barrier, 'dashboard', 'service', DASH2)).sent, true);
  assert.equal(s.wire.publishes(DASH2).length, 1);
  await s.sdk.fetchArtifact('dashboard', DASH);
  await s.sdk.publishArtifact('dashboard', DASH);
  assert.equal(s.wire.publishes(DASH).length, 0, 'the failed dashboard is cut from every envelope');
  const verdict = s.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [DASH, DASH2] });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.dashboards, [DASH]);
});

test('a dashboard creation record that is not settled quarantines that dashboard id: no dashboard publish and no app publish of it; an unrelated id still publishes', async () => {
  const s = await setup();
  s.wire.putForm({ formid: UNRELATED, name: 'Other', objecttypecode: 'none', type: 0, formxml: '<form o="1"/>' });
  const p = ports(s.wire, s.sdk, { family: 'dashboard', key: 'sales', id: DASH, formxml: '<form d="1"/>' });
  const realApply = p.apply;
  p.apply = async (...a) => { await realApply(...a); throw Object.assign(new Error('the creation record could not be cleared'), { code: CREATION_RECORD_UNSETTLED }); };
  assert.equal(await codeOf(runManagedFeature({ ...p, store: s.store, barrier: s.barrier })), CREATION_RECORD_UNSETTLED);
  await s.sdk.fetchArtifact('dashboard', DASH);
  await s.sdk.publishArtifact('dashboard', DASH);
  assert.equal(s.wire.publishes(DASH).length, 0);
  assert.equal(s.barrier.checkAppWrite({ held: new Set(), existingApp: true, addedDashboards: [DASH] }).ok, false, 'no app write that adds it');
  assert.equal(s.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [] }).ok, true, 'an app that does not hold it may publish');
  await s.sdk.fetchArtifact('dashboard', UNRELATED);
  await s.sdk.publishArtifact('dashboard', UNRELATED);
  assert.equal(s.wire.publishes(UNRELATED).length, 1);
});

test('a run that omits the declaration of a form whose publish answer was lost publishes nothing that overlaps it', async () => {
  const one = await setup();
  await runManagedFeature({ ...ports(one.wire, one.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: one.store, barrier: one.barrier });
  one.wire.script((e) => /PublishXml/.test(e.path), { error: 'socket hang up', code: 'ECONNRESET' });
  assert.equal(await codeOf(publishForms(one.sdk, one.store, one.barrier, [{ family: 'form', key: 'account/main' }])), PUBLICATION_UNCONFIRMED);
  const sent = one.wire.publishes('account').length;

  // Process two: the spec no longer declares the form. Discovery alone withholds what the store says is uncertain.
  const barrier = createPublicationBarrier();
  context(one.dir, barrier);
  const { sdk } = await sdkOver(one.wire, { barrier });
  await publishTablesXml(sdk.dataverse, ['account', 'contact']);
  await sdk.fetchArtifact('form', MAIN);
  await sdk.publishArtifact('form', MAIN);
  assert.equal(one.wire.publishes('account').length, sent, 'zero overlapping sends');
  assert.equal(one.wire.publishes('contact').length, 1, 'the unrelated table still publishes');
  assert.equal(barrier.checkAppWrite({ held: new Set(['account']), existingApp: true }).ok, false);
});

test('no store keeps the build\'s requests exactly; a corrupt store stops before any publish', async () => {
  const run = async (withContext) => {
    const wire = createManagedWire();
    const barrier = createPublicationBarrier();
    const dir = makeTempDir('mp-parity-');
    if (withContext) {
      const c = context(dir, barrier);
      assert.equal(c.absent, true);
      assert.deepEqual(fs.readdirSync(dir), []);
    }
    const { sdk } = await sdkOver(wire, { barrier });
    wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form/>' });
    await publishTablesXml(sdk.dataverse, ['account']);
    await sdk.fetchArtifact('form', MAIN);
    await sdk.publishArtifact('form', MAIN);
    return wire.log.map((e) => `${e.method} ${e.url} ${JSON.stringify(e.body)}`);
  };
  assert.deepEqual(await run(true), await run(false));

  const dir = makeTempDir('mp-corrupt-');
  const s = openManagedBindings({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL });
  const t = s.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: MAIN }, knownScopes: [ACCOUNT], declarationSha256: H('e') });
  assert.ok(t);
  fs.writeFileSync(s.file, fs.readFileSync(s.file, 'utf8').slice(0, -3));
  const barrier = createPublicationBarrier();
  let code = null;
  try { context(dir, barrier); } catch (e) { code = e.code; }
  assert.equal(code, CODES.unreadable, 'the build stops: nothing it would publish next is trusted');
});

test('the systemform reader: equal, differing and never-published layers; every other answer is unverified', async () => {
  const wire = createManagedWire();
  const { sdk } = await sdkOver(wire);
  wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form/>' }, { publishedToo: true });
  assert.equal((await readSystemFormPublication(sdk.dataverse, MAIN.toUpperCase())).state, 'equal');
  wire.saved.get(MAIN).description = 'changed';
  assert.equal((await readSystemFormPublication(sdk.dataverse, MAIN)).state, 'differs');
  wire.putForm({ formid: DASH, name: 'Sales', objecttypecode: 'none', type: 0, formxml: '<form/>' });
  const never = await readSystemFormPublication(sdk.dataverse, DASH);
  assert.deepEqual([never.state, never.published], ['never-published', null]);

  const unverified = async (answer, saved = false) => {
    wire.script((e) => e.method === 'GET' && /systemforms/.test(e.path) && (saved === /RetrieveUnpublished/.test(e.path)), answer);
    return codeOf(readSystemFormPublication(sdk.dataverse, MAIN));
  };
  assert.equal(await unverified({ statusCode: 404, body: { error: { code: '0x80040216', message: 'other' } } }), PUBLICATION_UNVERIFIED, 'a 404 for another reason');
  assert.equal(await unverified({ statusCode: 403, body: { error: { code: '0x80040220' } } }), PUBLICATION_UNVERIFIED);
  assert.equal(await unverified({ statusCode: 200, body: { formid: QUICK, name: 'Main', formxml: '<form/>' } }), PUBLICATION_UNVERIFIED, 'another row');
  assert.equal(await unverified({ statusCode: 200, body: { formid: MAIN, name: 'Main' } }), PUBLICATION_UNVERIFIED, 'no form XML');
  assert.equal(await unverified({ statusCode: 404, body: { error: { code: '0x80040217' } } }, true), PUBLICATION_UNVERIFIED, 'a saved layer that is missing is not "never published"');
  assert.equal(await codeOf(readSystemFormPublication(sdk.dataverse, 'not-a-guid')), PUBLICATION_UNVERIFIED);
  assert.equal(await codeOf(readSystemFormPublication({ get: async () => { throw new Error('reset'); } }, MAIN)), PUBLICATION_UNVERIFIED);
});
