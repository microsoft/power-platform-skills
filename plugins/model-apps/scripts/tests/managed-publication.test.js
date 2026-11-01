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
const { runManagedFeature, publishManagedScope, confirmUncertainPublication, createAttemptSendObserver, notStartedAnswer, existingRowDispatches, rowsCreatedByAttempt, withWorkflowEffect, editSwitchRequired, PUBLICATION_UNCONFIRMED, PUBLICATION_UNVERIFIED, CREATION_RECORD_UNSETTLED, LAYER_READER_MISSING } = require('../lib/managed-feature-contract.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { readSystemFormPublication, readSystemFormLayers, readSystemFormRootPresence, systemFormLayerSha256 } = require('../lib/systemform-published.js');
const { publishTablesXml } = require('../lib/table-publish.js');
const { createWorkflowEffectGate } = require('../lib/workflow-effect-context.js');
const { postPublishXml } = require('../lib/publish-xml.js');
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
    preflight: step('preflight', async () => undefined),
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
  store, barrier, scope: ACCOUNT, groups, client: sdk.dataverse, path: 'managed forms of account',
  publish: async () => { const r = await publishTablesXml(sdk.dataverse, ['account']); if (!r.ok) throw Object.assign(new Error(r.reason), { code: 'publish-failed' }); },
});
const publishDashboard = (sdk, store, barrier, family, key, id) => publishManagedScope({
  store, barrier, scope: dashScope(id), groups: [{ family, key }], client: sdk.dataverse, path: `managed dashboard ${key}`,
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
    await pub(['account']);
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
    store: s.store, barrier: s.barrier, scope: ACCOUNT, groups, client: s.sdk.dataverse, path: 'managed forms of account',
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

const formRow = (id, formxml, table = 'account') => ({ formid: id, name: 'Main', objecttypecode: table, type: 2, formxml });
// A form an earlier run committed on `account`: `publishedXml` is live, `savedXml` is saved, and the group's publication
// is `state` — 'owed' (desired = the saved layer it committed) or 'not-needed' (saved equalled published at the commit).
function committedForm(s, { id, key, publishedXml, savedXml, state = 'owed' }) {
  s.wire.putForm(formRow(id, publishedXml), { publishedToo: true });
  s.wire.saved.get(id).formxml = savedXml;
  const t = s.store.prepareAttempt({ family: 'form', key, baseGeneration: null, root: { kind: 'form', key, id }, knownScopes: [ACCOUNT], declarationSha256: H('e'), publication: { scope: ACCOUNT, state: 'owed' } });
  s.store.markSending(t, expected(id));
  s.store.noteSaved(t, { proof: null, acknowledgedRoot: true });
  const publication = state === 'owed'
    ? { scope: ACCOUNT, state: 'owed', desiredSha256: layerHash(s.wire.saved.get(id)), dispatchToken: null }
    : { scope: ACCOUNT, state: 'not-needed', desiredSha256: null, dispatchToken: null };
  s.store.commitGroup({ token: t, baseGeneration: null, records: [rec('form', key, id)], proof: PROOF, consumerState: consumer('form'), publication });
}
const MAIN_G = { family: 'form', key: 'account/main' };
const QUICK_G = { family: 'form', key: 'account/quick' };
const storeWriteFailure = () => Object.assign(new Error('no space left on the device'), { code: 'ENOSPC' });

test('a publish that was sent fails closed when its settlement is not recorded: a failed confirm write, a partial confirmation of two groups, or a failed outcome write withholds the table for the rest of the run', async () => {
  // The one confirmation write fails after the read-back proved the publish.
  const a = await setup();
  committedForm(a, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  a.store.confirmPublished = () => { throw storeWriteFailure(); };
  assert.equal(await codeOf(publishForms(a.sdk, a.store, a.barrier, [MAIN_G])), 'ENOSPC');
  assert.equal(a.wire.publishes('account').length, 1);
  assert.equal(a.barrier.allowScope(ACCOUNT, 'a sibling view'), false, 'the table is blocked, not merely released');
  await publishTablesXml(a.sdk.dataverse, ['account']);
  assert.equal(a.wire.publishes('account').length, 1, 'no sibling publishes over the unrecorded send');
  await publishTablesXml(a.sdk.dataverse, ['contact']);
  assert.equal(a.wire.publishes('contact').length, 1, 'an unrelated table still publishes');

  // Two groups published by one send: the first is confirmed, then the write fails.
  const b = await setup();
  committedForm(b, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  committedForm(b, { id: QUICK, key: 'account/quick', publishedXml: '<form q="1"/>', savedXml: '<form q="2"/>' });
  const realConfirm = b.store.confirmPublished;
  b.store.confirmPublished = (args) => { realConfirm({ ...args, groups: args.groups.slice(0, 1) }); throw storeWriteFailure(); };
  assert.equal(await codeOf(publishForms(b.sdk, b.store, b.barrier, [MAIN_G, QUICK_G])), 'ENOSPC');
  assert.equal(b.wire.publishes('account').length, 1);
  assert.equal(b.barrier.allowScope(ACCOUNT, 'a sibling view'), false, 'a partial confirmation withholds the table');
  await publishTablesXml(b.sdk.dataverse, ['account']);
  assert.equal(b.wire.publishes('account').length, 1);
  assert.deepEqual([MAIN_G, QUICK_G].map((g) => b.store.readGroup(g.family, g.key).committed.publication.state), ['confirmed', 'dispatching']);
  assert.ok(context(b.dir, createPublicationBarrier()).debt.some((d) => d.key === 'account/quick' && d.kind === 'uncertain'), 'the next run still withholds it');

  // A send that ended definitely-not-started, whose outcome cannot be written: the store still says dispatching.
  const c = await setup();
  committedForm(c, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  c.store.notePublishOutcome = () => { throw storeWriteFailure(); };
  const refusedConnection = (s) => publishManagedScope({
    store: s.store, barrier: s.barrier, scope: ACCOUNT, groups: [MAIN_G], client: s.sdk.dataverse,
    publish: async () => { await publishTablesXml(s.sdk.dataverse, ['account']); throw Object.assign(new Error('connection refused before the request was written'), { code: 'ECONNREFUSED', definiteNoStart: true }); },
  });
  c.wire.script((e) => /PublishXml/.test(e.path), { statusCode: 503, body: {}, unapplied: true });
  assert.equal(await codeOf(refusedConnection(c)), 'ENOSPC');
  assert.equal(c.barrier.allowScope(ACCOUNT, 'a sibling view'), false, 'not proved unsent in the store: withheld');

  // The same with a store that records it: proved unsent, so the scope is released and the debt is paid once later.
  const d = await setup();
  committedForm(d, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  d.wire.script((e) => /PublishXml/.test(e.path), { statusCode: 503, body: {}, unapplied: true });
  assert.equal(await codeOf(refusedConnection(d)), 'ECONNREFUSED');
  assert.equal(d.barrier.allowScope(ACCOUNT, 'a sibling view'), true, 'a definitely-unsent exit releases');
  assert.deepEqual(d.store.readGroup('form', 'account/main').committed.publication, { ...d.store.readGroup('form', 'account/main').committed.publication, state: 'owed', dispatchToken: null });
  d.wire.log.length = 0;
  assert.equal((await publishForms(d.sdk, d.store, d.barrier, [MAIN_G])).sent, true);
  assert.equal(d.wire.publishes('account').length, 1);
});

test('a pre-send read of the layers that fails or answers no proof withholds the table for the run: nothing is sent and no sibling publishes it', async () => {
  for (const form of [async () => { throw new Error('socket hang up'); }, async () => ({ savedSha256: H('9') })]) {
    const s = await setup();
    committedForm(s, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
    const out = codeOf(publishManagedScope({ store: s.store, barrier: s.barrier, scope: ACCOUNT, groups: [MAIN_G], client: s.sdk.dataverse, readers: { form }, publish: () => publishTablesXml(s.sdk.dataverse, ['account']) }));
    assert.equal(await out, PUBLICATION_UNVERIFIED);
    assert.equal(s.wire.publishes().length, 0);
    assert.equal(s.barrier.allowScope(ACCOUNT, 'a sibling view'), false, 'the unread table is fenced');
    await publishTablesXml(s.sdk.dataverse, ['account']);
    assert.equal(s.wire.publishes('account').length, 0, 'no sibling publishes the unread saved layer');
    assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'owed', 'the debt is not consumed');
  }
});

test('a table publish is sent only while every managed form of the table has the saved layer its group proved: a drifted sibling, already published or not passed, stops it; unrelated scopes stay eligible', async () => {
  // Both groups passed; MAIN's debt is already live, but someone saved over it since.
  const a = await setup();
  committedForm(a, { id: MAIN, key: 'account/main', publishedXml: '<form v="2"/>', savedXml: '<form v="2"/>' });
  committedForm(a, { id: QUICK, key: 'account/quick', publishedXml: '<form q="1"/>', savedXml: '<form q="2"/>' });
  a.wire.saved.get(MAIN).formxml = '<form foreign="true"/>';
  assert.equal(await codeOf(publishForms(a.sdk, a.store, a.barrier, [MAIN_G, QUICK_G])), 'create-completion-required');
  assert.equal(a.wire.publishes().length, 0);
  assert.equal(a.wire.published.get(MAIN).formxml, '<form v="2"/>', 'the foreign save is not put live');
  assert.equal(a.barrier.allowScope(ACCOUNT, 'a sibling view'), false);
  assert.equal(a.store.readGroup('form', 'account/quick').committed.publication.state, 'owed');

  // The caller passes only QUICK; MAIN settled earlier (nothing owed) and has a foreign save since.
  const b = await setup();
  committedForm(b, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="1"/>', state: 'not-needed' });
  committedForm(b, { id: QUICK, key: 'account/quick', publishedXml: '<form q="1"/>', savedXml: '<form q="2"/>' });
  b.wire.saved.get(MAIN).formxml = '<form foreign="true"/>';
  assert.equal(await codeOf(publishForms(b.sdk, b.store, b.barrier, [QUICK_G])), 'create-completion-required');
  assert.equal(b.wire.publishes().length, 0);
  assert.equal(b.wire.published.get(MAIN).formxml, '<form v="1"/>');

  // Controls: a settled sibling whose saved layer is still its published one, and a drifted form of another table.
  const c = await setup();
  committedForm(c, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="1"/>', state: 'not-needed' });
  committedForm(c, { id: QUICK, key: 'account/quick', publishedXml: '<form q="1"/>', savedXml: '<form q="2"/>' });
  c.wire.putForm(formRow(UNRELATED, '<form c="1"/>', 'contact'), { publishedToo: true });
  c.wire.saved.get(UNRELATED).formxml = '<form c="foreign"/>';
  assert.deepEqual(await publishForms(c.sdk, c.store, c.barrier, [QUICK_G]), { sent: true, withheld: false, confirmed: [QUICK_G] });
  assert.equal(c.wire.publishes('account').length, 1, 'one send');
  assert.equal(c.wire.published.get(QUICK).formxml, '<form q="2"/>');
  assert.equal(c.barrier.allowScope({ type: 'table', table: 'contact' }, 'the publish phase'), true, 'an unrelated scope stays eligible');
});

test('a send permit sends only a request whose whole publish target set is the permit\'s one scope: a publish of everything, another scope, an extra scope or an unreadable request is refused unsent', async () => {
  const b = createPublicationBarrier();
  const sent = [];
  const gate = b.gateRequest(async (req) => { sent.push(req); return { statusCode: 204, headers: {}, body: '' }; });
  const post = (action, body) => ({ url: `${ENV}/api/data/v9.0/${action}`, method: 'POST', headers: {}, body });
  const xml = (inner) => post('PublishXml', JSON.stringify({ ParameterXml: `<importexportxml>${inner}</importexportxml>` }));
  const entities = (...t) => `<entities>${t.map((x) => `<entity>${x}</entity>`).join('')}</entities>`;
  b.hold('own', [ACCOUNT], [MAIN], 'form main (its publish is being sent)');
  b.hold('dash', [dashScope(DASH)], [DASH], 'dashboard sales (its publish is being sent)');
  const refusedFor = async (scope, token, req) => {
    const events = [];
    const answer = await b.withSendPermit({ token, scope, onDispatch: () => events.push('dispatch'), onWithheld: () => events.push('withheld'), onRefused: () => events.push('refused') }, () => gate(req));
    return { status: answer.statusCode, events };
  };
  const refusals = [
    [ACCOUNT, 'own', xml(entities('account', 'contact'))],
    [ACCOUNT, 'own', xml(entities('contact'))],
    [ACCOUNT, 'own', post('PublishAllXml', '{}')],
    [ACCOUNT, 'own', post('$batch', '--b\r\nPOST PublishXml\r\n\r\n{"ParameterXml":"<importexportxml><entities><entity>account</entity></entities></importexportxml>"}\r\n--b--')],
    [ACCOUNT, 'own', post('PublishXml', 'not json')],
    [ACCOUNT, 'own', xml(`${entities('account')}<appmodules><appmodule>{0a0a0a0a-0000-4000-8000-000000000001}</appmodule></appmodules>`)],
    [ACCOUNT, 'own', xml(`${entities('account')}<dashboards><dashboard>${DASH}</dashboard></dashboards>`)],
    [ACCOUNT, 'own', xml('')],
    [dashScope(DASH), 'dash', xml(entities('account'))],
    [dashScope(DASH), 'dash', xml(`<dashboards><dashboard>${DASH}</dashboard><dashboard>${DASH2}</dashboard></dashboards>`)],
    // An empty target leaf, in every spelling, and a structure that does not close as it opens.
    [ACCOUNT, 'own', xml(`${entities('account')}`.replace('</entities>', '<entity/></entities>'))],
    [ACCOUNT, 'own', xml(`${entities('account')}`.replace('</entities>', '<entity /></entities>'))],
    [ACCOUNT, 'own', xml(`${entities('account')}`.replace('</entities>', '<entity>\n</entity></entities>'))],
    [dashScope(DASH), 'dash', xml(`<dashboards><dashboard>${DASH}</dashboard><dashboard/></dashboards>`)],
    [ACCOUNT, 'own', xml('<entities><entity>account</entity></dashboards>')],
    [ACCOUNT, 'own', post('PublishXml', JSON.stringify({ ParameterXml: '<importexportxml><entities><entity>account</entity></entities>' }))],
    // The supported subset: no namespace, no attribute, and a target tag written exactly `<entity>` / `<dashboard>`.
    [ACCOUNT, 'own', xml('<entities><entity >account</entity></entities>')],
    [ACCOUNT, 'own', xml('<entities><x:entity xmlns:x="urn:x">account</x:entity></entities>')],
    [ACCOUNT, 'own', post('PublishXml', JSON.stringify({ ParameterXml: '<importexportxml xmlns="urn:x"><entities><entity>account</entity></entities></importexportxml>' }))],
  ];
  for (const [scope, token, req] of refusals) {
    assert.deepEqual(await refusedFor(scope, token, req), { status: 409, events: ['refused'] }, `refused: ${req.url} ${req.body}`);
  }
  assert.equal(sent.length, 0, 'nothing of a refused request is sent');

  // The permit's own scope, written as the SDK and the table publish write it, is sent once each.
  const own = await refusedFor(ACCOUNT, 'own', xml(`<entities><entity> Account </entity></entities><nodes/>`));
  assert.deepEqual(own, { status: 204, events: ['dispatch'] });
  const dash = await refusedFor(dashScope(DASH), 'dash', xml(`<dashboards><dashboard>{${DASH.toUpperCase()}}</dashboard></dashboards>`));
  assert.deepEqual(dash, { status: 204, events: ['dispatch'] });
  assert.equal(sent.length, 2);

  // Outside a permit nothing changes: with nothing withheld, a two-table publish goes as it came.
  b.release('own');
  b.release('dash');
  const plain = xml(entities('account', 'contact'));
  await gate(plain);
  assert.equal(sent[2], plain);
});

test('a managed publish whose request names more than its own scope is refused unsent: the debt stays owed, nothing is blocked, and a correct publish pays it once', async () => {
  const s = await setup();
  committedForm(s, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  s.wire.putForm(formRow(UNRELATED, '<form c="1"/>', 'contact'), { publishedToo: true });
  s.wire.saved.get(UNRELATED).formxml = '<form c="2"/>';
  const broad = publishManagedScope({
    store: s.store, barrier: s.barrier, scope: ACCOUNT, groups: [MAIN_G], client: s.sdk.dataverse,
    publish: () => publishTablesXml(s.sdk.dataverse, ['account', 'contact']),
  });
  assert.equal(await codeOf(broad), 'managed-publication-refused');
  assert.equal(s.wire.publishes().length, 0);
  assert.equal(s.wire.published.get(UNRELATED).formxml, '<form c="1"/>');
  const pub = s.store.readGroup('form', 'account/main').committed.publication;
  assert.deepEqual([pub.state, pub.dispatchToken], ['owed', null], 'no token is used');
  assert.equal(s.barrier.allowScope(ACCOUNT, 'after'), true, 'definitely unsent: released, not blocked');
  assert.equal((await publishForms(s.sdk, s.store, s.barrier, [MAIN_G])).sent, true);
  assert.equal(s.wire.publishes('account').length, 1);
  assert.equal(s.wire.publishes('contact').length, 0);
});

test('a managed publish whose ParameterXml has an empty target leaf or a malformed structure is refused unsent: no dispatch, debt owed, no token used', async () => {
  const bodies = {
    selfClosingEntity: '<importexportxml><entities><entity>account</entity><entity/></entities></importexportxml>',
    selfClosingWhitespaceEntity: '<importexportxml><entities><entity>account</entity><entity /></entities></importexportxml>',
    selfClosingDashboard: '<importexportxml><entities><entity>account</entity></entities><dashboards><dashboard/></dashboards></importexportxml>',
    malformed: '<importexportxml><entities><entity>account</entity></dashboards></importexportxml>',
    pairedEmptyEntity: '<importexportxml><entities><entity>account</entity><entity>  </entity></entities></importexportxml>',
    leafOutsideItsList: '<importexportxml><entity>account</entity></importexportxml>',
    leafInTheOtherList: '<importexportxml><dashboards><entity>account</entity></dashboards></importexportxml>',
    nonEmptyContainer: '<importexportxml><entities><entity>account</entity></entities><nodes>x</nodes></importexportxml>',
    commentInLeaf: '<importexportxml><entities><entity>account<!-- contact --></entity></entities></importexportxml>',
    textAroundRoot: 'x<importexportxml><entities><entity>account</entity></entities></importexportxml>',
  };
  for (const [name, body] of Object.entries(bodies)) {
    const s = await setup();
    committedForm(s, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
    const out = publishManagedScope({
      store: s.store, barrier: s.barrier, scope: ACCOUNT, groups: [MAIN_G], client: s.sdk.dataverse,
      publish: () => postPublishXml(s.sdk.dataverse, body),
    });
    assert.equal(await codeOf(out), 'managed-publication-refused', name);
    assert.equal(s.wire.publishes().length, 0, `${name}: nothing is sent`);
    const pub = s.store.readGroup('form', 'account/main').committed.publication;
    assert.deepEqual([pub.state, pub.dispatchToken], ['owed', null], `${name}: the debt stays owed and no token is used`);
    assert.equal(s.barrier.allowScope(ACCOUNT, 'after'), true, `${name}: definitely unsent, so not blocked`);
  }
  // Controls: the scoped table request with a harmless empty container, and a scoped dashboard request, each send once.
  const t = await setup();
  committedForm(t, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  const table = await publishManagedScope({
    store: t.store, barrier: t.barrier, scope: ACCOUNT, groups: [MAIN_G], client: t.sdk.dataverse,
    publish: () => postPublishXml(t.sdk.dataverse, '<importexportxml><entities><entity>account</entity></entities><nodes/><nodes /><entities></entities></importexportxml>'),
  });
  assert.equal(table.sent, true);
  assert.equal(t.wire.publishes().length, 1);
});

test('the layers of every covered group are read by its family\'s reader: a covered group of a family with no reader fences the scope, never skipped', async () => {
  const VIEW = '31313131-3131-4313-8313-313131313131';
  const viewGroup = (s) => {
    const t = s.store.prepareAttempt({ family: 'view', key: 'account/active', baseGeneration: null, root: { kind: 'view', key: 'account/active', id: VIEW }, knownScopes: [ACCOUNT], declarationSha256: H('e') });
    s.store.markSending(t, { ...expected(VIEW), proofSchema: 'view-v1' });
    s.store.noteSaved(t, { proof: null, acknowledgedRoot: true });
    s.store.commitGroup({ token: t, baseGeneration: null, records: [rec('view', 'account/active', VIEW)], proof: PROOF, consumerState: { baseline: {} }, publication: { scope: ACCOUNT, state: 'not-needed', desiredSha256: null, dispatchToken: null }, proofSchema: 'view-v1' });
  };
  // A form debt on a table that also holds a committed view group: the shared readers have no view reader here.
  const s = await setup();
  committedForm(s, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  viewGroup(s);
  const read = [];
  const formOnly = { form: async (client, group) => { read.push(group.family); return readSystemFormLayers(client, group); } };
  const missing = publishManagedScope({ store: s.store, barrier: s.barrier, scope: ACCOUNT, groups: [MAIN_G], client: s.sdk.dataverse, readers: formOnly, publish: () => publishTablesXml(s.sdk.dataverse, ['account']) });
  assert.equal(await codeOf(missing), LAYER_READER_MISSING);
  assert.deepEqual(read, [], 'nothing is read for a scope that cannot be read whole');
  assert.equal(s.wire.publishes().length, 0);
  assert.equal(s.barrier.allowScope(ACCOUNT, 'a sibling'), false, 'the scope is fenced for the run');
  assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'owed');

  // With a view reader, each covered group goes to its own family's reader, and the form publish is sent once.
  const v = await setup();
  committedForm(v, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  viewGroup(v);
  const calls = [];
  const readers = {
    form: async (client, group) => { calls.push(`form ${group.root.id}`); return readSystemFormLayers(client, group); },
    view: async (client, group) => { calls.push(`view ${group.root.id}`); return { savedSha256: H('7'), publishedSha256: H('7') }; },
  };
  const out = await publishManagedScope({ store: v.store, barrier: v.barrier, scope: ACCOUNT, groups: [MAIN_G], client: v.sdk.dataverse, readers, publish: () => publishTablesXml(v.sdk.dataverse, ['account']) });
  assert.equal(out.sent, true);
  assert.deepEqual(calls, [`form ${MAIN}`, `view ${VIEW}`, `form ${MAIN}`], 'before the send every covered group; after it the debt');
  assert.equal(v.wire.publishes('account').length, 1);

  // A caller-supplied reader function is not accepted: a family's reader is shared, never reimplemented per caller.
  const r = await setup();
  committedForm(r, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
  assert.equal(await codeOf(publishManagedScope({ store: r.store, barrier: r.barrier, scope: ACCOUNT, groups: [MAIN_G], readLayers: readLayersOf(r.sdk), publish: () => publishTablesXml(r.sdk.dataverse, ['account']) })), CODES.notSettled);
  assert.equal(r.wire.publishes().length, 0);
});

test('a table\'s managed views and charts are read by the shared readers before a form publish of the table: equal layers send once, an unpublished saved layer fences the table', async () => {
  const VIEW = '31313131-3131-4313-8313-313131313131';
  const CHART = '32323232-3232-4323-8323-323232323232';
  const committedQuery = (s, family, key, id) => {
    const t = s.store.prepareAttempt({ family, key, baseGeneration: null, root: { kind: family, key, id }, knownScopes: [ACCOUNT], declarationSha256: H('e') });
    s.store.markSending(t, { ...expected(id), proofSchema: `${family}-v1` });
    s.store.noteSaved(t, { proof: null, acknowledgedRoot: true });
    s.store.commitGroup({ token: t, baseGeneration: null, records: [rec(family, key, id)], proof: PROOF, consumerState: { baseline: {} }, publication: { scope: ACCOUNT, state: 'not-needed', desiredSha256: null, dispatchToken: null }, proofSchema: `${family}-v1` });
  };
  const view = { savedqueryid: VIEW, name: 'Active', returnedtypecode: 'account', fetchxml: '<fetch v="1"/>', layoutxml: '<grid/>' };
  const chart = { savedqueryvisualizationid: CHART, name: 'By owner', primaryentitytypecode: 'account', datadescription: '<datadefinition/>', presentationdescription: '<Chart/>' };
  const arrange = async ({ viewEdited = false, chartPublished = true } = {}) => {
    const s = await setup();
    committedForm(s, { id: MAIN, key: 'account/main', publishedXml: '<form v="1"/>', savedXml: '<form v="2"/>' });
    // viewEdited: the view's published layer is an older definition; its saved layer holds an edit not yet published.
    if (viewEdited) s.wire.putQuery('savedqueries', 'savedqueryid', { ...view, fetchxml: '<fetch v="0"/>' }, { publishedToo: true });
    s.wire.putQuery('savedqueries', 'savedqueryid', view, { publishedToo: !viewEdited });
    s.wire.putQuery('savedqueryvisualizations', 'savedqueryvisualizationid', chart, { publishedToo: chartPublished });
    committedQuery(s, 'view', 'account/active', VIEW);
    committedQuery(s, 'chart', 'account/by owner', CHART);
    return s;
  };
  const publish = (s) => publishManagedScope({ store: s.store, barrier: s.barrier, scope: ACCOUNT, groups: [MAIN_G], client: s.sdk.dataverse, publish: () => publishTablesXml(s.sdk.dataverse, ['account']) });
  const readPaths = (s) => s.wire.log.filter((e) => e.method === 'GET' && /^savedquer/i.test(e.path)).map((e) => e.path);

  // Saved equals published on both: the form publish is sent once, after each was read in both layers by the shared map.
  const s = await arrange();
  assert.equal((await publish(s)).sent, true);
  assert.equal(s.wire.publishes('account').length, 1);
  assert.deepEqual(readPaths(s), [
    `savedqueries(${VIEW})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `savedqueries(${VIEW})`,
    `savedqueryvisualizations(${CHART})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `savedqueryvisualizations(${CHART})`,
  ]);

  // A chart saved and never published (or a view edit saved and not published) would go live with the form: nothing is sent.
  for (const variant of [{ chartPublished: false }, { viewEdited: true }]) {
    const u = await arrange(variant);
    assert.equal(await codeOf(publish(u)), CODES.completion, JSON.stringify(variant));
    assert.equal(u.wire.publishes().length, 0);
    assert.equal(u.barrier.allowScope(ACCOUNT, 'a sibling'), false, 'the table is fenced for the run');
    assert.equal(u.store.readGroup('form', 'account/main').committed.publication.state, 'owed');
  }
});

test('a dashboard known only by its retained id, with no scope given, is quarantined when its creation record is not settled: no path publishes it', async () => {
  const s = await setup();
  s.wire.putForm({ formid: DASH, name: 'Sales', objecttypecode: 'none', type: 0, formxml: '<form d="1"/>' });
  s.wire.putForm({ formid: UNRELATED, name: 'Other', objecttypecode: 'none', type: 0, formxml: '<form o="1"/>' });
  let downstream = 0;
  const later = async () => { downstream += 1; };
  const code = await codeOf(runManagedFeature({
    phase: 'dashboards', family: 'dashboard', key: 'sales', knownScopes: [], knownIds: [DASH], store: s.store, barrier: s.barrier, halt,
    preflight: async () => undefined,
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

test('a form whose row has no description: the hash its feature records from the row is the hash the shared reader answers, so its debt is paid; empty text stays distinct', async () => {
  const owe = (s, desiredSha256) => {
    const t = s.store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: MAIN }, knownScopes: [ACCOUNT], declarationSha256: H('e'), publication: { scope: ACCOUNT, state: 'owed' } });
    s.store.markSending(t, expected(MAIN));
    s.store.noteSaved(t, { proof: null, acknowledgedRoot: true });
    s.store.commitGroup({ token: t, baseGeneration: null, records: [rec('form', 'account/main', MAIN)], proof: PROOF, consumerState: consumer('form'), publication: { scope: ACCOUNT, state: 'owed', desiredSha256, dispatchToken: null } });
  };
  // The row as the feature declares it: no description key at all. The service answers it with description null.
  const declared = { name: 'Main', formxml: '<form v="2"/>' };
  const s = await setup();
  s.wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form v="1"/>' }, { publishedToo: true });
  s.wire.saved.get(MAIN).formxml = declared.formxml;
  owe(s, systemFormLayerSha256(declared));
  assert.deepEqual(await publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }]), { sent: true, withheld: false, confirmed: [{ family: 'form', key: 'account/main' }] });
  assert.equal(s.wire.publishes('account').length, 1);
  assert.equal(s.store.readGroup('form', 'account/main').committed.publication.state, 'confirmed');
  assert.equal(systemFormLayerSha256(declared), systemFormLayerSha256({ ...declared, description: null }));

  // Control: a declared empty description is not the service's null, so that saved layer is not the owed one.
  const c = await setup();
  c.wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form v="1"/>' }, { publishedToo: true });
  c.wire.saved.get(MAIN).formxml = declared.formxml;
  owe(c, systemFormLayerSha256({ ...declared, description: '' }));
  assert.equal(await codeOf(publishForms(c.sdk, c.store, c.barrier, [{ family: 'form', key: 'account/main' }])), CODES.completion);
  assert.equal(c.wire.publishes().length, 0);
});

// A managed form CREATED under its own stable id over the wire (POST systemforms {formid}), whose declaration is its
// form XML: the expected proof and the declaration hash both follow it, so a changed declaration is a different plan.
// `resumeCreate` reads the root in both layers by that id. A create whose answer was lost is adopted by the proof.
const isCreate = (e) => e.method === 'POST' && /^systemforms$/i.test(e.path);
function createPorts(wire, sdk, { key, id, formxml }) {
  const p = ports(wire, sdk, { key, id, formxml });
  const exp = { ...expected(id), sentProjectionSha256: sha({ formxml }) };
  p.tokens = [];
  p.resumeAsked = 0;
  p.plan = async () => {
    const current = wire.saved.get(id);
    if (current && current.formxml === formxml) return { noop: true };
    return { root: { kind: 'form', key, id }, expected: exp, declarationSha256: sha({ key, formxml }), publication: { scope: ACCOUNT, state: 'owed' } };
  };
  p.apply = async ({ token }) => {
    p.tokens.push(token);
    const res = await sdk.dataverse.post('/systemforms', { formid: id, name: key, objecttypecode: 'account', type: 2, formxml });
    if (!(res.status >= 200 && res.status < 300)) throw Object.assign(new Error(`the create answered ${res.status}`), { code: 'create-refused' });
    return { sent: true };
  };
  const prove = p.prove;
  p.prove = async (a) => {
    const proved = await prove(a);
    // A recovered create was never acknowledged in this attempt: its root is adopted, not claimed as created.
    return a.recovering ? { ...proved, records: proved.records.map((r) => ({ ...r, origin: 'adopted' })) } : proved;
  };
  p.resumeCreate = async () => { p.resumeAsked += 1; return { root: await readSystemFormRootPresence(sdk.dataverse, id) }; };
  return p;
}
const refuseNextCreate = (wire) => wire.script(isCreate, { statusCode: 400, body: { error: { code: '0x80040203', message: 'refused' } }, unapplied: true });
// A fresh process over the same workspace and wire.
async function nextRun(s) {
  const barrier = createPublicationBarrier();
  const c = context(s.dir, barrier);
  const { sdk } = await sdkOver(s.wire, { barrier });
  return { barrier, store: c.store, debt: c.debt, sdk };
}

test('a create the service refused is resumed in the next run under its own token and id: exactly one more create, then one publish', async () => {
  const s = await setup();
  const first = createPorts(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  refuseNextCreate(s.wire);
  assert.equal(await codeOf(runManagedFeature({ ...first, store: s.store, barrier: s.barrier })), 'create-refused');
  assert.equal(s.wire.log.filter(isCreate).length, 1);
  const stranded = s.store.readGroup('form', 'account/main').pending;
  assert.equal(stranded.phase, 'sending');

  const n = await nextRun(s);
  assert.deepEqual(n.debt.map((d) => d.kind), ['hold']);
  const again = createPorts(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  const r = await runManagedFeature({ ...again, store: n.store, barrier: n.barrier });
  assert.deepEqual(r.result, { committed: true, recovered: true, resumed: true });
  assert.equal(again.resumeAsked, 1);
  assert.deepEqual(again.tokens, [stranded.token], 'the same create, under the attempt\'s own token');
  assert.equal(s.wire.log.filter(isCreate).length, 2, 'exactly one more create');
  assert.deepEqual([...s.wire.saved.keys()], [MAIN], 'one root, under its stable id');
  assert.equal(n.store.readGroup('form', 'account/main').committed.root.id, MAIN);
  assert.equal(n.barrier.active, false, 'the resumed attempt released its own hold');
  assert.equal((await publishForms(n.sdk, n.store, n.barrier, [{ family: 'form', key: 'account/main' }])).sent, true);
  assert.equal(s.wire.publishes('account').length, 1);

  const third = await nextRun(s);
  assert.deepEqual((await runManagedFeature({ ...createPorts(s.wire, third.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: third.store, barrier: third.barrier })).result, { noop: true });
  assert.equal(s.wire.log.filter(isCreate).length, 2, 'the identical next run creates nothing');
});

test('a create whose root is present is proved and adopted, never resent; a late first create makes the resend fail on the primary key, never a second root', async () => {
  // The service made the row and the answer was lost.
  const s = await setup();
  s.wire.script(isCreate, { statusCode: 400, body: { error: { code: '0x80040203', message: 'lost' } } });
  assert.equal(await codeOf(runManagedFeature({ ...createPorts(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier })), 'create-refused');
  const n = await nextRun(s);
  const p = createPorts(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  assert.deepEqual((await runManagedFeature({ ...p, adoptionApproved: true, store: n.store, barrier: n.barrier })).result, { committed: true, recovered: true });
  assert.deepEqual([p.resumeAsked, p.tokens.length, s.wire.log.filter(isCreate).length], [1, 0, 1]);
  assert.equal(n.store.readGroup('form', 'account/main').committed.records[0].origin, 'adopted');

  // The first create is delayed: the read finds no root, and the create lands before the resend reaches the service.
  const d = await setup();
  refuseNextCreate(d.wire);
  await codeOf(runManagedFeature({ ...createPorts(d.wire, d.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: d.store, barrier: d.barrier }));
  const late = await nextRun(d);
  const q = createPorts(d.wire, late.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  const send = q.apply;
  q.apply = async (a) => { d.wire.putForm({ formid: MAIN, name: 'account/main', objecttypecode: 'account', type: 2, formxml: '<form v="1"/>' }); return send(a); };
  assert.equal(await codeOf(runManagedFeature({ ...q, store: late.store, barrier: late.barrier })), 'create-refused');
  assert.equal(d.wire.log.filter(isCreate).length, 2);
  assert.deepEqual([...d.wire.saved.keys()], [MAIN], 'the resend failed on the primary key: one root');
  assert.equal(late.store.readGroup('form', 'account/main').pending.token, q.tokens[0], 'the attempt stays, under its token');
  assert.equal(late.barrier.allowScope(ACCOUNT, 'a sibling'), false, 'and its hold stays');
  const after = await nextRun(d);
  const r = createPorts(d.wire, after.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  assert.deepEqual((await runManagedFeature({ ...r, adoptionApproved: true, store: after.store, barrier: after.barrier })).result, { committed: true, recovered: true });
  assert.equal(d.wire.log.filter(isCreate).length, 2, 'proved, not resent');
});

test('a create is not resumed when its declaration changed, when its root cannot be read, or when it was not a create', async () => {
  const strand = async () => {
    const s = await setup();
    refuseNextCreate(s.wire);
    await codeOf(runManagedFeature({ ...createPorts(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier }));
    return s;
  };
  // A changed declaration is a new change: refused before anything is sent, and the scope is quarantined.
  const s = await strand();
  const n = await nextRun(s);
  const changed = createPorts(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' });
  assert.equal(await codeOf(runManagedFeature({ ...changed, store: n.store, barrier: n.barrier })), 'create-completion-required');
  assert.deepEqual([changed.tokens.length, s.wire.log.filter(isCreate).length], [0, 1]);
  assert.equal(n.store.readGroup('form', 'account/main').pending.phase, 'sending', 'the attempt is kept as it was');
  assert.deepEqual(n.barrier.withheld().map((w) => w.blockedBy.length > 0), [true], 'quarantined for the run');

  // A presence read that is not a "does not exist" from both layers sends nothing.
  const u = await strand();
  const m = await nextRun(u);
  u.wire.script((e) => e.method === 'GET' && /systemforms/.test(e.path) && !/RetrieveUnpublished/.test(e.path), { statusCode: 403, body: { error: { code: '0x80040220' } } });
  const blind = createPorts(u.wire, m.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  assert.equal(await codeOf(runManagedFeature({ ...blind, store: m.store, barrier: m.barrier })), PUBLICATION_UNVERIFIED);
  assert.deepEqual([blind.tokens.length, u.wire.log.filter(isCreate).length], [0, 1]);
  assert.equal(m.barrier.allowScope(ACCOUNT, 'a sibling'), false);

  // An edit of a committed form whose send was refused is never resumed: the proof decides, as before.
  const e = await setup();
  await runManagedFeature({ ...ports(e.wire, e.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: e.store, barrier: e.barrier });
  e.wire.script((x) => x.method === 'PATCH', { statusCode: 400, body: { error: { code: '0x80040203' } }, unapplied: true });
  await codeOf(runManagedFeature({ ...ports(e.wire, e.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }), store: e.store, barrier: e.barrier }));
  const k = await nextRun(e);
  const edit = { ...ports(e.wire, k.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }), resumeCreate: async () => { throw new Error('never asked'); } };
  assert.equal(await codeOf(runManagedFeature({ ...edit, store: k.store, barrier: k.barrier })), 'create-completion-required');
  assert.equal(e.wire.writes().filter((x) => x.method === 'PATCH').length, 1, 'no second edit');
});

test('the systemform presence read: absent only when both layers say the row does not exist', async () => {
  const wire = createManagedWire();
  const { sdk } = await sdkOver(wire);
  assert.equal(await readSystemFormRootPresence(sdk.dataverse, MAIN), 'absent');
  wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form/>' });
  assert.equal(await readSystemFormRootPresence(sdk.dataverse, MAIN.toUpperCase()), 'present', 'saved only, never published');
  const unverified = async (answer, saved) => {
    wire.script((e) => e.method === 'GET' && /systemforms/.test(e.path) && saved === /RetrieveUnpublished/.test(e.path), answer);
    return codeOf(readSystemFormRootPresence(sdk.dataverse, DASH));
  };
  assert.equal(await unverified({ statusCode: 404, body: { error: { code: '0x80040216' } } }, true), PUBLICATION_UNVERIFIED, 'a 404 for another reason');
  assert.equal(await unverified({ statusCode: 403, body: { error: { code: '0x80040220' } } }, false), PUBLICATION_UNVERIFIED);
  assert.equal(await unverified({ statusCode: 200, body: { formid: QUICK, name: 'x', formxml: '<form/>' } }, true), PUBLICATION_UNVERIFIED, 'another row');
  assert.equal(await codeOf(readSystemFormRootPresence({ get: async () => { throw new Error('reset'); } }, MAIN)), PUBLICATION_UNVERIFIED);
  assert.equal(await codeOf(readSystemFormRootPresence(sdk.dataverse, 'not-a-guid')), PUBLICATION_UNVERIFIED);
});

test('a prepared attempt that never reached the send is retired by a no-op plan: its hold ends, nothing is written', async () => {
  const s = await setup();
  s.wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml: '<form v="1"/>' }, { publishedToo: true });
  // A run that stopped after prepareAttempt, before markSending: intent only.
  s.store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: MAIN }, knownScopes: [ACCOUNT], declarationSha256: H('e'), publication: { scope: ACCOUNT, state: 'owed' } });
  const n = await nextRun(s);
  assert.deepEqual(n.debt.map((d) => d.kind), ['hold']);
  const r = await runManagedFeature({ ...ports(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: n.store, barrier: n.barrier });
  assert.deepEqual(r.result, { noop: true });
  assert.equal(n.store.readGroup('form', 'account/main').pending, null);
  assert.equal(n.barrier.active, false, 'its own hold ended');
  assert.deepEqual(s.wire.writes(), []);
  assert.deepEqual((await nextRun(s)).debt, [], 'the next run finds nothing pending');
});

test('a publish that landed and whose answer was lost is confirmed read-only by the next run: no second publish, and the run after finds nothing owed', async () => {
  const s = await setup();
  await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier });
  s.wire.script((e) => /PublishXml/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216', message: 'gateway' } } });
  assert.equal(await codeOf(publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }])), PUBLICATION_UNCONFIRMED);
  assert.equal(s.wire.publishes('account').length, 1);
  assert.equal(s.wire.published.get(MAIN).formxml, '<form v="1"/>', 'it landed');

  const n = await nextRun(s);
  assert.deepEqual(n.debt.map((d) => d.kind), ['uncertain']);
  const token = n.store.readGroup('form', 'account/main').committed.publication.dispatchToken;
  assert.deepEqual(await publishForms(n.sdk, n.store, n.barrier, [{ family: 'form', key: 'account/main' }]), { sent: false, withheld: false, confirmed: [{ family: 'form', key: 'account/main' }] });
  const pub = n.store.readGroup('form', 'account/main').committed.publication;
  assert.deepEqual([pub.state, pub.dispatchToken], ['confirmed', token], 'confirmed under its original dispatch');
  assert.equal(s.wire.publishes().length, 1, 'nothing was sent');
  assert.equal(n.barrier.allowScope(ACCOUNT, 'a sibling'), false, 'the quarantine of this run is never cleared');
  assert.deepEqual((await nextRun(s)).debt, [], 'the next run installs no block');
});

test('an uncertain publication that a fresh read does not prove stays blocked: nothing is sent, replayed or deleted; one dispatch is confirmed whole or not at all', async () => {
  const s = await setup();
  await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier });
  await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/quick', id: QUICK, formxml: '<form q="1"/>' }), store: s.store, barrier: s.barrier });
  const both = [{ family: 'form', key: 'account/main' }, { family: 'form', key: 'account/quick' }];
  s.wire.script((e) => /PublishXml/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216', message: 'gateway' } } });
  assert.equal(await codeOf(publishForms(s.sdk, s.store, s.barrier, both)), PUBLICATION_UNCONFIRMED);
  // One form of the dispatch is live; the other's published layer is not what was owed.
  const live = s.wire.published.get(QUICK);
  s.wire.published.set(QUICK, { ...live, formxml: '<form q="0"/>' });

  const n = await nextRun(s);
  const states = (st) => both.map(({ family, key }) => st.readGroup(family, key).committed.publication.state);
  const answer = await confirmUncertainPublication({ store: n.store, barrier: n.barrier, scope: ACCOUNT, client: n.sdk.dataverse });
  assert.deepEqual(answer, { confirmed: [], unconfirmed: both.map((g) => ({ ...g, code: PUBLICATION_UNCONFIRMED })) });
  assert.deepEqual(states(n.store), ['unconfirmed', 'unconfirmed'], 'the live one is not confirmed without its sibling');
  assert.equal(await codeOf(publishForms(n.sdk, n.store, n.barrier, both)), PUBLICATION_UNCONFIRMED);
  const failing = { ...require('../lib/managed-layer-readers.js').LAYER_READERS, form: async () => { throw new Error('reset'); } };
  assert.deepEqual((await confirmUncertainPublication({ store: n.store, barrier: n.barrier, scope: ACCOUNT, client: n.sdk.dataverse, readers: failing })).unconfirmed.map((u) => u.code), [PUBLICATION_UNVERIFIED, PUBLICATION_UNVERIFIED]);
  assert.deepEqual((await confirmUncertainPublication({ store: n.store, barrier: n.barrier, scope: ACCOUNT, client: n.sdk.dataverse, readers: {} })).unconfirmed.map((u) => u.code), [LAYER_READER_MISSING, LAYER_READER_MISSING]);
  assert.equal(s.wire.publishes().length, 1, 'nothing was sent again');
  assert.equal(s.wire.writes().filter((w) => !/PublishXml/.test(w.path)).length, 0, 'nothing was written');

  // The whole dispatch is live: one write confirms both.
  s.wire.published.set(QUICK, live);
  const m = await nextRun(s);
  assert.deepEqual(await confirmUncertainPublication({ store: m.store, barrier: m.barrier, scope: ACCOUNT, client: m.sdk.dataverse }), { confirmed: both, unconfirmed: [] });
  assert.deepEqual(states(m.store), ['confirmed', 'confirmed']);
  assert.equal(s.wire.publishes().length, 1);
});

// The same-token continuation of recoverManagedAttempt. A build whose transport carries a send observer
// (createAttemptSendObserver, inside the barrier's gate as build-model-app.js installs it) records on the attempt every
// mutation its apply sends, before it leaves. An attempt that failed with nothing carried out — a local edit that failed
// before any request, or a request the service refused unapplied — is then continued by the next run under its own
// token; anything that may have landed is only proved, as before.
async function observedRun(s) {
  const barrier = createPublicationBarrier();
  const observer = createAttemptSendObserver();
  const { sdk } = await sdkOver(s.wire, { barrier, observer });
  const c = context(s.dir, barrier);
  return { barrier, observer, sdk, store: c.store, debt: c.debt };
}
async function observedSetup() {
  const s = { wire: createManagedWire(), dir: makeTempDir('mp-observed-') };
  return Object.assign(s, await observedRun(s));
}
const isPatch = (e) => e.method === 'PATCH' && /^systemforms\(/i.test(e.path);
// The edit of a managed form, as the forms helper sends it: the service's answer decides, and a refusal is the
// feature's own error. `local` makes the apply fail before it sends anything (a local SDK edit that failed).
function editPorts(wire, sdk, { formxml, local = null }) {
  const p = ports(wire, sdk, { key: 'account/main', id: MAIN, formxml });
  p.sends = [];
  p.apply = async ({ token, continuing }) => {
    p.sends.push([token, continuing === true]);
    if (local) throw local;
    const res = await sdk.dataverse.patch(`/systemforms(${MAIN})`, { formxml });
    if (!(res.status >= 200 && res.status < 300)) throw Object.assign(new Error(`the edit answered ${res.status}`), { code: 'form-layout-rejected' });
    return { sent: true };
  };
  return p;
}
const localFailure = () => Object.assign(new Error('the local copy could not be edited'), { code: 'form-layout-local-edit' });
const observed = (p, n) => ({ ...p, store: n.store, barrier: n.barrier, sendObserver: n.observer });
async function committedEdit(s) {
  await runManagedFeature(observed(ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), s));
  return s.store.readGroup('form', 'account/main').committed;
}

test('an edit that failed locally before any request is continued by the next run under its own token: one edit, then committed', async () => {
  const s = await observedSetup();
  const base = await committedEdit(s);
  const first = editPorts(s.wire, s.sdk, { formxml: '<form v="2"/>', local: localFailure() });
  assert.equal(await codeOf(runManagedFeature(observed(first, s))), 'form-layout-local-edit');
  assert.deepEqual(s.wire.writes(), [], 'nothing reached the service');
  const stranded = s.store.readGroup('form', 'account/main').pending;
  assert.deepEqual([stranded.phase, stranded.sendWindow], ['sending', { possible: 0, notStarted: 0, epoch: 1 }]);

  const n = await observedRun(s);
  assert.deepEqual(n.debt.map((d) => d.kind), ['hold']);
  const again = editPorts(s.wire, n.sdk, { formxml: '<form v="2"/>' });
  assert.deepEqual((await runManagedFeature(observed(again, n))).result, { committed: true, recovered: true, continued: true });
  assert.deepEqual(again.sends, [[stranded.token, true]], 'the same attempt, continued under its own token');
  assert.equal(s.wire.writes().filter(isPatch).length, 1, 'exactly one edit');
  const { committed, pending } = n.store.readGroup('form', 'account/main');
  assert.equal(pending, null);
  assert.notEqual(committed.generation, base.generation);
  assert.equal(s.wire.saved.get(MAIN).formxml, '<form v="2"/>');
  assert.equal(n.barrier.active, false, 'its own hold ended');
  const t = await observedRun(s);
  assert.deepEqual((await runManagedFeature(observed(editPorts(s.wire, t.sdk, { formxml: '<form v="2"/>' }), t))).result, { noop: true });

  // A create that failed locally is continued the same way: one create under its stable id, no presence read needed.
  const c = await observedSetup();
  const create = createPorts(c.wire, c.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  create.apply = async () => { throw localFailure(); };
  assert.equal(await codeOf(runManagedFeature(observed(create, c))), 'form-layout-local-edit');
  const m = await observedRun(c);
  const resent = createPorts(c.wire, m.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  assert.deepEqual((await runManagedFeature(observed(resent, m))).result, { committed: true, recovered: true, continued: true });
  assert.deepEqual([resent.resumeAsked, c.wire.log.filter(isCreate).length], [0, 1]);
  assert.deepEqual([...c.wire.saved.keys()], [MAIN]);
});

test('an edit the service refused unapplied with a Dataverse error is continued by the next run: one more edit, then committed', async () => {
  const s = await observedSetup();
  await committedEdit(s);
  s.wire.script(isPatch, { statusCode: 400, body: { error: { code: '0x80040203', message: 'refused' } }, unapplied: true });
  const first = editPorts(s.wire, s.sdk, { formxml: '<form v="2"/>' });
  assert.equal(await codeOf(runManagedFeature(observed(first, s))), 'form-layout-rejected');
  assert.deepEqual(s.store.readGroup('form', 'account/main').pending.sendWindow, { possible: 0, notStarted: 1, epoch: 1 });

  const n = await observedRun(s);
  const again = editPorts(s.wire, n.sdk, { formxml: '<form v="2"/>' });
  assert.deepEqual((await runManagedFeature(observed(again, n))).result, { committed: true, recovered: true, continued: true });
  assert.deepEqual(again.sends, [[first.sends[0][0], true]]);
  assert.equal(s.wire.writes().filter(isPatch).length, 2, 'the refused edit and its one continuation');
  assert.equal(s.wire.saved.get(MAIN).formxml, '<form v="2"/>');
  assert.equal(n.store.readGroup('form', 'account/main').pending, null);
});

test('an answer that does not prove the edit was not carried out leaves the attempt possibly sent: the next run only proves it', async () => {
  const strand = async (unapplied) => {
    const s = await observedSetup();
    await committedEdit(s);
    // A 400 with no Dataverse error (a proxy's page): nothing says the platform refused the operation.
    s.wire.script(isPatch, { statusCode: 400, body: '<html>bad gateway</html>', unapplied });
    assert.equal(await codeOf(runManagedFeature(observed(editPorts(s.wire, s.sdk, { formxml: '<form v="2"/>' }), s))), 'form-layout-rejected');
    assert.deepEqual(s.store.readGroup('form', 'account/main').pending.sendWindow, { possible: 1, notStarted: 0, epoch: 1 });
    return s;
  };
  // It landed: proved and committed, never sent again.
  const landed = await strand(false);
  const n = await observedRun(landed);
  const p = editPorts(landed.wire, n.sdk, { formxml: '<form v="2"/>' });
  assert.deepEqual((await runManagedFeature(observed(p, n))).result, { committed: true, recovered: true });
  assert.deepEqual([p.sends.length, landed.wire.writes().filter(isPatch).length], [0, 1]);

  // It did not land: the proof fails, nothing is sent, and the attempt stays under its token.
  const lost = await strand(true);
  const token = lost.store.readGroup('form', 'account/main').pending.token;
  const m = await observedRun(lost);
  const q = editPorts(lost.wire, m.sdk, { formxml: '<form v="2"/>' });
  assert.equal(await codeOf(runManagedFeature(observed(q, m))), 'create-completion-required');
  assert.deepEqual([q.sends.length, lost.wire.writes().filter(isPatch).length], [0, 1]);
  assert.equal(m.store.readGroup('form', 'account/main').pending.token, token);
  assert.equal(m.barrier.allowScope(ACCOUNT, 'a sibling'), false);
});

test('a proven-unsent attempt is not continued when its declaration changed, or by a run that does not observe its sends', async () => {
  const strand = async () => {
    const s = await observedSetup();
    const p = createPorts(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
    p.apply = async () => { throw localFailure(); };
    await codeOf(runManagedFeature(observed(p, s)));
    return s;
  };
  const s = await strand();
  const n = await observedRun(s);
  const changed = createPorts(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' });
  assert.equal(await codeOf(runManagedFeature(observed(changed, n))), 'create-completion-required');
  assert.deepEqual([changed.tokens.length, s.wire.writes().length], [0, 0]);
  assert.equal(n.store.readGroup('form', 'account/main').pending.phase, 'sending', 'the attempt is kept as it was');
  assert.deepEqual(n.barrier.withheld().map((w) => w.blockedBy.length > 0), [true], 'quarantined for the run');

  // Without an observer the window is not trusted: only resumeCreate's presence read or the proof decide, as before.
  const u = await strand();
  const m = await nextRun(u);
  const plain = createPorts(u.wire, m.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  assert.deepEqual((await runManagedFeature({ ...plain, store: m.store, barrier: m.barrier })).result, { committed: true, recovered: true, resumed: true });
  assert.equal(plain.resumeAsked, 1);
});

test('the send observer counts a mutation on its attempt before it leaves, only inside a window, and never a publish the barrier withholds', async () => {
  const dir = makeTempDir('mp-observer-');
  const barrier = createPublicationBarrier();
  const { store } = context(dir, barrier);
  const token = store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: MAIN }, knownScopes: [ACCOUNT], declarationSha256: H('e'), publication: { scope: ACCOUNT, state: 'owed' } });
  store.markSending(token, expected(MAIN), { observed: true });
  const windowOf = () => store.readGroup('form', 'account/main').pending.sendWindow;
  const seen = [];
  let answer = { statusCode: 204, headers: {}, body: '' };
  const inner = async (req) => { seen.push([req.method, windowOf().possible]); if (answer instanceof Error) throw answer; return answer; };
  const observer = createAttemptSendObserver();
  assert.equal(observer.installed, false);
  // A wrapper given an observer that is on no transport refuses before it reads or writes anything.
  const before = fs.readFileSync(store.file, 'utf8');
  assert.equal(await codeOf(runManagedFeature({ ...ports(createManagedWire(), null, { key: 'account/other', id: QUICK, formxml: '<form/>' }), store, barrier, sendObserver: observer })), CODES.notSettled);
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);

  const send = barrier.gateRequest(observer.wrap(inner));
  const req = (method, p = `systemforms(${MAIN})`, body = '{}', headers = {}) => send({ url: `${ENV}/api/data/v9.2/${p}`, method, headers, body });
  await req('PATCH');
  assert.deepEqual(windowOf(), { possible: 0, notStarted: 0, epoch: 1 }, 'no window open: not counted');
  const w = observer.open(store, token);
  await req('GET');
  await req('PATCH');
  answer = { statusCode: 400, headers: {}, body: JSON.stringify({ error: { code: '0x80040203', message: 'refused' } }) };
  await req('POST', 'systemforms');
  answer = new Error('socket hang up');
  await assert.rejects(req('DELETE'));
  barrier.hold(token, [ACCOUNT], [MAIN], 'form main');
  answer = { statusCode: 204, headers: {}, body: '' };
  await req('POST', 'PublishXml', JSON.stringify({ ParameterXml: '<importexportxml><entities><entity>account</entity></entities></importexportxml>' }));
  assert.deepEqual(windowOf(), { possible: 2, notStarted: 1, epoch: 1 }, 'a lost answer stays possibly applied');
  // A closed window trails: it still counts every mutation (a re-send, a request left in flight) and records no
  // not-started answer, so it can only grow. Only end() stops it.
  w.close();
  answer = { statusCode: 400, headers: {}, body: JSON.stringify({ error: { code: '0x80040203', message: 'refused' } }) };
  await req('PATCH');
  assert.deepEqual(windowOf(), { possible: 3, notStarted: 1, epoch: 1 }, 'counted after close, and its refusal ends nothing');
  w.end();
  answer = { statusCode: 204, headers: {}, body: '' };
  await req('PATCH');
  assert.deepEqual(seen, [['PATCH', 0], ['GET', 0], ['PATCH', 1], ['POST', 2], ['DELETE', 2], ['PATCH', 3], ['PATCH', 3]], 'counted before it left; the withheld publish never reached the transport');
  assert.deepEqual(windowOf(), { possible: 3, notStarted: 1, epoch: 1 }, 'an ended window counts nothing');

  // A count that cannot be written stops the request before it leaves.
  const broken = { noteAttemptDispatch: () => { throw Object.assign(new Error('disk full'), { code: CODES.writeFailed }); }, noteAttemptNotStarted() {} };
  const w2 = observer.open(broken, token);
  await assert.rejects(req('PATCH'), { code: CODES.writeFailed });
  w2.end();
  assert.equal(seen.length, 7);
});

test('a not-started answer is a Dataverse refusal of one operation or a failed If-Match; nothing else', () => {
  const at = (p, headers = {}) => ({ url: `${ENV}/api/data/v9.2/${p}`, method: 'PATCH', headers });
  const coded = (statusCode, code = '0x80040203') => ({ statusCode, headers: {}, body: JSON.stringify({ error: { code, message: 'x' } }) });
  const row = at(`systemforms(${MAIN})`);
  assert.equal(notStartedAnswer(row, coded(400)), true);
  assert.equal(notStartedAnswer(row, { ...coded(404, '0x80040217'), body: Buffer.from(coded(404, '0x80040217').body) }), true);
  assert.equal(notStartedAnswer(at(`systemforms(${MAIN})`, { 'If-Match': '"7"' }), { statusCode: 412, headers: {}, body: '' }), true);
  for (const [label, req, res] of [
    ['a 412 without If-Match or a code', row, { statusCode: 412, headers: {}, body: '' }],
    ['a 400 without a Dataverse code', row, { statusCode: 400, headers: {}, body: '<html/>' }],
    ['a code that is not one', row, coded(400, 'BadRequest')],
    ['a 409', row, coded(409)],
    ['a 429', row, coded(429)],
    ['a 503', row, coded(503)],
    ['a 401: the client sends it again with a fresh token', row, { statusCode: 401, headers: {}, body: '' }],
    ['a 401 with a code', row, coded(401)],
    ['a 500', row, coded(500)],
    ['a success', row, { statusCode: 204, headers: {}, body: '' }],
    ['a batch', at('$batch'), coded(400)],
    ['a transport error', row, { error: 'socket hang up' }],
    ['a cut-off answer', row, { ...coded(400), incompleteResponse: true }],
    ['no answer', row, null],
  ]) assert.equal(notStartedAnswer(req, res), false, label);
});

// The feature's preflight (runManagedFeature `preflight`): its own safety checks — the clean-continuation check of a
// dirty local copy, a retained creation id, an edit switch — run on EVERY path, recovery included, before anything the
// feature reads into its workspace or sends. A refusal keeps the attempt and its token and writes nothing.
const tracked = (p) => {
  p.calls = [];
  for (const name of ['resolve', 'plan', 'apply', 'prove', 'ensureMembership', 'resumeCreate']) {
    const fn = p[name];
    if (typeof fn === 'function') p[name] = async (...a) => { p.calls.push(name); return fn(...a); };
  }
  return p;
};
const dirtyCopy = () => Object.assign(new Error('the local copy has unsent edits'), { code: 'create-completion-required', category: 'workspace-copy-unsent-edits' });
const fileOf = (store) => (fs.existsSync(store.file) ? fs.readFileSync(store.file, 'utf8') : null);

test('the feature preflight is required: without it nothing is read, held or written', async () => {
  const s = await setup();
  const p = ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  delete p.preflight;
  const before = fileOf(s.store);
  assert.equal(await codeOf(runManagedFeature({ ...p, store: s.store, barrier: s.barrier })), CODES.notSettled);
  assert.deepEqual(s.wire.log, []);
  assert.equal(s.barrier.active, false);
  assert.equal(fileOf(s.store), before);
});

test('the feature preflight runs first on an ordinary run: a refusal plans, prepares and sends nothing', async () => {
  const s = await setup();
  const seen = [];
  const p = tracked(ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }));
  p.preflight = async (a) => { seen.push(a); throw dirtyCopy(); };
  const before = fileOf(s.store);
  assert.equal(await codeOf(runManagedFeature({ ...p, store: s.store, barrier: s.barrier })), 'create-completion-required');
  assert.deepEqual(p.calls, []);
  assert.deepEqual(seen.map((a) => [a.recovering, a.committed, a.pending]), [[false, null, null]]);
  assert.equal(fileOf(s.store), before, 'nothing prepared');
  assert.deepEqual(s.wire.writes(), []);
  assert.equal(s.barrier.allowScope(ACCOUNT, 'a sibling'), false, 'quarantined for the run');
});

test('the feature preflight runs before every recovery route — prove, continue, resume — and a refusal keeps the attempt, its token and every byte, on each identical rerun', async () => {
  // Each case strands an attempt, then answers a fresh run over the same workspace: [run, ports, observed?].
  const proveCase = async () => {
    const s = await setup();
    await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier });
    const crash = Object.assign(new Error('the process ended'), { code: 'crash' });
    assert.equal(await codeOf(runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>', fail: { prove: crash } }), store: s.store, barrier: s.barrier })), 'crash');
    return { s, next: () => nextRun(s), make: (n) => ports(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }), want: { committed: true, recovered: true } };
  };
  const continueCase = async () => {
    const s = await observedSetup();
    await committedEdit(s);
    await codeOf(runManagedFeature(observed(editPorts(s.wire, s.sdk, { formxml: '<form v="2"/>', local: localFailure() }), s)));
    return { s, next: () => observedRun(s), make: (n) => editPorts(s.wire, n.sdk, { formxml: '<form v="2"/>' }), want: { committed: true, recovered: true, continued: true } };
  };
  const resumeCase = async () => {
    const s = await setup();
    refuseNextCreate(s.wire);
    await codeOf(runManagedFeature({ ...createPorts(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier }));
    return { s, next: () => nextRun(s), make: (n) => createPorts(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), want: { committed: true, recovered: true, resumed: true } };
  };
  for (const [route, strand] of [['prove', proveCase], ['continue', continueCase], ['resume', resumeCase]]) {
    const { s, next, make, want } = await strand();
    const stranded = s.store.readGroup('form', 'account/main').pending;
    assert.equal(stranded.phase, 'sending', route);
    const writes = s.wire.writes().length;
    for (const attempt of [1, 2]) {
      const n = await next();
      const before = fileOf(n.store);
      const seen = [];
      const p = tracked(make(n));
      p.preflight = async (a) => { seen.push(a); throw dirtyCopy(); };
      assert.equal(await codeOf(runManagedFeature({ ...p, store: n.store, barrier: n.barrier, ...(n.observer ? { sendObserver: n.observer } : {}) })), 'create-completion-required', `${route} #${attempt}`);
      assert.deepEqual(p.calls, [], `${route} #${attempt}: nothing read, planned or sent after the refusal`);
      assert.deepEqual(seen.map((a) => [a.recovering, a.pending.token]), [[true, stranded.token]], `${route} #${attempt}`);
      assert.equal(fileOf(n.store), before, `${route} #${attempt}: nothing written`);
      assert.equal(n.store.readGroup('form', 'account/main').pending.token, stranded.token);
      assert.equal(s.wire.writes().length, writes);
      assert.equal(n.barrier.allowScope(ACCOUNT, 'a sibling'), false, `${route} #${attempt}: withheld for the run`);
    }
    const n = await next();
    const p = make(n);
    assert.deepEqual((await runManagedFeature({ ...p, store: n.store, barrier: n.barrier, ...(n.observer ? { sendObserver: n.observer } : {}) })).result, want, `${route}: a passing preflight recovers as before`);
  }
});

// Adoption consent: a root whose create no answer acknowledged is bound only with the feature's typed adoption
// approval (`adoptionApproved: true`, which the feature derives from its own `<family>:<key>` approval). A fresh read
// that proves the content shows what the row is, not that the maker agreed to manage it.
test('an unacknowledged root is committed only with adoption approved: without it the attempt stays, no binding and no membership', async () => {
  const s = await setup();
  s.wire.script(isCreate, { statusCode: 400, body: { error: { code: '0x80040203', message: 'lost' } } });
  assert.equal(await codeOf(runManagedFeature({ ...createPorts(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier })), 'create-refused');
  const stranded = s.store.readGroup('form', 'account/main').pending;
  for (const attempt of [1, 2]) {
    const n = await nextRun(s);
    const before = fileOf(n.store);
    const p = tracked(createPorts(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }));
    assert.equal(await codeOf(runManagedFeature({ ...p, store: n.store, barrier: n.barrier })), CODES.adoptionRequired, `#${attempt}`);
    assert.ok(!p.calls.includes('ensureMembership'), 'no membership for a root nobody approved');
    const { committed, pending } = n.store.readGroup('form', 'account/main');
    assert.deepEqual([committed, pending.token], [null, stranded.token], 'no binding; the attempt stays under its token');
    assert.equal(fileOf(n.store), before, 'nothing written');
    assert.equal(n.barrier.allowScope(ACCOUNT, 'a sibling'), false, 'withheld for the run');
  }
  const bad = await nextRun(s);
  assert.equal(await codeOf(runManagedFeature({ ...createPorts(s.wire, bad.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), adoptionApproved: 'yes', store: bad.store, barrier: bad.barrier })), CODES.notSettled, 'only a boolean approval');
  const n = await nextRun(s);
  const p = createPorts(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' });
  assert.deepEqual((await runManagedFeature({ ...p, adoptionApproved: true, store: n.store, barrier: n.barrier })).result, { committed: true, recovered: true });
  assert.equal(n.store.readGroup('form', 'account/main').committed.records[0].origin, 'adopted');
  assert.equal(s.wire.log.filter(isCreate).length, 1, 'never resent');

  // An acknowledged create needs no approval and commits as created.
  const a = await setup();
  assert.equal((await runManagedFeature({ ...createPorts(a.wire, a.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: a.store, barrier: a.barrier })).result.committed, true);
  assert.equal(a.store.readGroup('form', 'account/main').committed.records[0].origin, 'created');
});

// The send window covers the whole logical operation, the client's own re-sends included; a run's claim on an attempt's
// sends is checked under the store's lease and fences any older claimant at dispatch; a publish that may have been sent
// is settled before a newer generation is committed over it; the not-started rule reads the operation path as the
// service does; and a workflow feature's preflight sees the attempt's effects.
const latch = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const outcome = (p) => p.then((value) => ({ value }), (error) => ({ error: error.code || error.message }));
const refused = () => JSON.stringify({ error: { code: '0x80040203', message: 'refused' } });

test('send window: a request the client re-sends after the window closed (a 401 refreshed) stays counted, and the next run only proves it', async () => {
  const s = await observedSetup();
  await committedEdit(s);
  const entered = latch(), answer = latch();
  const original = s.wire.request;
  let first = true;
  s.wire.script((e) => e.method === 'PATCH', { statusCode: 401, body: { error: { code: '0x80040220' } }, unapplied: true });
  s.wire.request = async (req) => {
    if (req.method === 'PATCH' && first) { first = false; entered.resolve(); await answer.promise; }
    return original(req);
  };
  const n = await observedRun(s);
  const p = editPorts(s.wire, n.sdk, { formxml: '<form v="2"/>' });
  let write;
  p.apply = async () => {
    write = n.sdk.dataverse.patch(`/systemforms(${MAIN})`, { formxml: '<form v="2"/>' });
    // The apply fails while its own write is still in flight; the client then refreshes the token and sends it again.
    await Promise.all([write, (async () => { await entered.promise; throw localFailure(); })()]);
  };
  assert.equal(await codeOf(runManagedFeature(observed(p, n))), 'form-layout-local-edit');
  answer.resolve();
  assert.equal((await write).status, 204);
  assert.equal(s.wire.writes().filter(isPatch).length, 2, 'the 401 and its re-send');
  const after = n.store.readGroup('form', 'account/main').pending.sendWindow;
  assert.ok(after.possible >= 1, `the re-sent edit stays possibly applied: ${JSON.stringify(after)}`);
  assert.equal(after.notStarted, 0, 'a 401 is answered by sending again, so it ends nothing');
  const again = await observedRun(s);
  const q = editPorts(s.wire, again.sdk, { formxml: '<form v="2"/>' });
  assert.deepEqual((await runManagedFeature(observed(q, again))).result, { committed: true, recovered: true }, 'proved, not continued');
  assert.deepEqual([q.sends.length, s.wire.writes().filter(isPatch).length], [0, 2]);
});

test('send window: a refusal that arrives after the window closed ends nothing; one that arrives while it is open does', async () => {
  const dir = makeTempDir('mp-trailing-');
  const barrier = createPublicationBarrier();
  const { store } = context(dir, barrier);
  const token = store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: MAIN }, knownScopes: [ACCOUNT], declarationSha256: H('e'), publication: { scope: ACCOUNT, state: 'owed' } });
  const marked = store.markSending(token, expected(MAIN), { observed: true, claim: 'first' });
  const epoch = marked ? marked.epoch : undefined;
  const windowOf = () => store.readGroup('form', 'account/main').pending.sendWindow;
  const gate = latch();
  const observer = createAttemptSendObserver();
  const send = observer.wrap(async () => { await gate.promise; return { statusCode: 400, headers: {}, body: refused() }; });
  const req = { url: `${ENV}/api/data/v9.2/systemforms(${MAIN})`, method: 'PATCH', headers: {}, body: '{}' };
  const w = observer.open(store, token, epoch);
  const inFlight = send(req);
  w.close();
  gate.resolve();
  assert.equal((await inFlight).statusCode, 400);
  assert.deepEqual(windowOf(), { possible: 1, notStarted: 0, epoch: 1 }, 'in flight when the window closed: possibly applied');
  w.end();
  const w2 = observer.open(store, token, epoch);
  await send(req);
  w2.end();
  assert.deepEqual(windowOf(), { possible: 1, notStarted: 1, epoch: 1 }, 'answered while open: not started');
});

test('send claim: of two runs that read the same zero, the second is refused under the lease before it sends: one edit', async () => {
  const s = await observedSetup();
  await committedEdit(s);
  await codeOf(runManagedFeature(observed(editPorts(s.wire, s.sdk, { formxml: '<form v="2"/>', local: localFailure() }), s)));
  const token = s.store.readGroup('form', 'account/main').pending.token;
  const a = await observedRun(s);
  const aRead = latch(), releaseA = latch(), bEntered = latch(), releaseB = latch();
  const original = s.wire.request;
  s.wire.request = async (req) => {
    if (req.method === 'PATCH') { bEntered.resolve(); await releaseB.promise; }
    return original(req);
  };
  const b = await observedRun(s);
  s.wire.request = original;
  const pa = editPorts(s.wire, a.sdk, { formxml: '<form v="2"/>' });
  let aSaw;
  pa.preflight = async ({ pending }) => { aSaw = pending.sendWindow; aRead.resolve(); await releaseA.promise; };
  const pb = editPorts(s.wire, b.sdk, { formxml: '<form v="2"/>' });
  const aDone = outcome(runManagedFeature(observed(pa, a)));
  await aRead.promise;
  const bDone = outcome(runManagedFeature(observed(pb, b)));
  assert.equal(await Promise.race([bEntered.promise.then(() => true), bDone.then(() => false)]), true, 'the second run is sending');
  releaseA.resolve();
  const aResult = await aDone;
  releaseB.resolve();
  const bResult = await bDone;
  assert.equal(aSaw.possible, 0, 'the first run read a zero window');
  assert.equal(aResult.error, CODES.pending, 'its stale zero claims nothing');
  assert.deepEqual(pa.sends, [], 'and it sent nothing');
  assert.deepEqual(bResult.value.result, { committed: true, recovered: true, continued: true });
  assert.deepEqual(pb.sends, [[token, true]]);
  assert.equal(s.wire.writes().filter(isPatch).length, 1, 'one edit');
});

test('send claim: a run that claimed the attempt and was overtaken by a newer claim is refused at its dispatch, unsent', async () => {
  const s = await observedSetup();
  await committedEdit(s);
  await codeOf(runManagedFeature(observed(editPorts(s.wire, s.sdk, { formxml: '<form v="2"/>', local: localFailure() }), s)));
  const token = s.store.readGroup('form', 'account/main').pending.token;
  const pause = (p) => {
    const claimed = latch(), release = latch();
    const apply = p.apply;
    p.apply = async (x) => { claimed.resolve(); await release.promise; return apply(x); };
    return { claimed, release };
  };
  const a = await observedRun(s);
  const b = await observedRun(s);
  const pa = editPorts(s.wire, a.sdk, { formxml: '<form v="2"/>' });
  const pb = editPorts(s.wire, b.sdk, { formxml: '<form v="2"/>' });
  const ga = pause(pa), gb = pause(pb);
  const windowNow = () => context(s.dir, createPublicationBarrier()).store.readGroup('form', 'account/main').pending.sendWindow;
  const aDone = outcome(runManagedFeature(observed(pa, a)));
  await ga.claimed.promise;
  assert.equal(windowNow().epoch, 2, 'the first claim');
  const bDone = outcome(runManagedFeature(observed(pb, b)));
  await gb.claimed.promise;
  assert.equal(windowNow().epoch, 3, 'a newer claim over the same zero');
  ga.release.resolve();
  const aResult = await aDone;
  // The store refuses the count under the stale epoch before the request leaves; the client reports that as a failed transport.
  assert.equal(aResult.error, 'CONNECTION_ERROR', 'the overtaken run stops');
  assert.deepEqual([s.wire.writes().filter(isPatch).length, windowNow().possible], [0, 0], 'its edit never left');
  gb.release.resolve();
  assert.deepEqual((await bDone).value.result, { committed: true, recovered: true, continued: true });
  assert.deepEqual(pb.sends, [[token, true]]);
  assert.equal(s.wire.writes().filter(isPatch).length, 1, 'one edit');
  assert.equal(s.wire.saved.get(MAIN).formxml, '<form v="2"/>');
});

test('publication: a change over a publish that may have been sent stops before it prepares anything, unless a fresh read confirms that publish first', async () => {
  const strand = async (unapplied) => {
    const s = await setup();
    await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier });
    s.wire.script((e) => /PublishXml/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216' } }, unapplied });
    assert.equal(await codeOf(publishForms(s.sdk, s.store, s.barrier, [{ family: 'form', key: 'account/main' }])), 'managed-publication-unconfirmed');
    return s;
  };
  const refs = [{ family: 'form', key: 'account/main' }];
  // The old publish landed, and no client is given to confirm it: the change is not made over it.
  const s = await strand(false);
  const old = s.store.readGroup('form', 'account/main').committed;
  const n = await nextRun(s);
  const changed = tracked(ports(s.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }));
  const before = fileOf(n.store);
  assert.equal(await codeOf(runManagedFeature({ ...changed, store: n.store, barrier: n.barrier })), PUBLICATION_UNCONFIRMED);
  assert.deepEqual(changed.calls, ['resolve', 'plan'], 'nothing prepared or sent');
  assert.equal(fileOf(n.store), before);
  assert.deepEqual(n.store.readGroup('form', 'account/main'), { committed: old, pending: null, effects: [] });
  assert.equal(s.wire.saved.get(MAIN).formxml, '<form v="1"/>');

  // With a client, the old publish is confirmed read-only first; the new generation then owes its own publish, which a
  // later publish sends.
  const m = await nextRun(s);
  const p = ports(s.wire, m.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' });
  assert.deepEqual((await runManagedFeature({ ...p, client: m.sdk.dataverse, store: m.store, barrier: m.barrier })).result, { committed: true, recovered: false });
  const next = m.store.readGroup('form', 'account/main').committed;
  assert.notEqual(next.generation, old.generation);
  assert.equal(next.publication.state, 'owed', 'the new generation keeps its own debt');
  const publishes = s.wire.publishes().length;
  const t = await nextRun(s);
  assert.equal((await publishForms(t.sdk, t.store, t.barrier, refs)).sent, true);
  assert.equal(s.wire.publishes().length, publishes + 1);
  assert.equal(s.wire.published.get(MAIN).formxml, '<form v="2"/>');

  // The old publish did not land: the fresh read cannot confirm it, so the change stops before it prepares anything.
  const u = await strand(true);
  const k = await nextRun(u);
  const q = tracked(ports(u.wire, k.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }));
  const prior = fileOf(k.store);
  assert.equal(await codeOf(runManagedFeature({ ...q, client: k.sdk.dataverse, store: k.store, barrier: k.barrier })), PUBLICATION_UNCONFIRMED);
  assert.ok(!q.calls.includes('apply'));
  assert.equal(fileOf(k.store), prior, 'nothing written');
  assert.deepEqual(u.wire.writes().filter(isPatch), []);
});

test('not started: the operation path is read decoded, so an encoded batch is a batch and an ambiguous path ends nothing', async () => {
  const at = (p) => ({ url: `${ENV}/api/data/v9.2/${p}`, method: 'POST', headers: {} });
  const coded = { statusCode: 400, headers: {}, body: refused() };
  for (const [label, p] of [['a batch', '$batch'], ['an encoded batch', '%24batch'], ['an encoded batch in lower case', '%24BATCH'], ['a double-encoded batch', '%2524batch'], ['a malformed escape', `systemforms(${MAIN})%zz`], ['a lone percent', `systemforms(${MAIN})%`], ['a batch segment', '$batch/x']]) {
    assert.equal(notStartedAnswer(at(p), coded), false, label);
  }
  assert.equal(notStartedAnswer(at(`systemforms(${MAIN})`), coded), true, 'one operation');
  assert.equal(notStartedAnswer(at(`systemforms%28${MAIN}%29`), coded), true, 'an encoded single operation is still one');

  // Through the real client: an encoded `$batch` refused with a Dataverse code stays possibly applied.
  const counts = [];
  for (const endpoint of ['$batch', '%24batch']) {
    const s = await observedSetup();
    const token = s.store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: MAIN }, declarationSha256: H('e'), knownScopes: [ACCOUNT] });
    const { epoch } = s.store.markSending(token, expected(MAIN), { observed: true, claim: 'first' });
    const w = s.observer.open(s.store, token, epoch);
    const body = `--batch_1\r\nContent-Type: application/http\r\n\r\nPATCH /api/data/v9.0/systemforms(${MAIN}) HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"formxml":"<form/>"}\r\n--batch_1--\r\n`;
    s.wire.script((e) => e.path === '$batch', { statusCode: 400, body: { error: { code: '0x80040203' } }, unapplied: true });
    await s.sdk.dataverse.post(`/${endpoint}`, body, { headers: { 'Content-Type': 'multipart/mixed; boundary=batch_1' } });
    w.end();
    counts.push(s.store.readGroup('form', 'account/main').pending.sendWindow.possible);
  }
  assert.deepEqual(counts, [1, 1]);
});

test('workflow preflight: an existing row the attempt never created is listed as an edit, whatever the group\'s commit state says', () => {
  const RULE = '33333333-3333-4333-8333-333333333333';
  const pending = { token: 't1', root: { kind: 'business-rule', key: 'account/hide', id: RULE }, baseGeneration: null, acknowledgedRoot: false, savedObservation: null };
  const effect = (over) => ({ token: `e-${over.effect}-${over.state || 'u'}`, attemptToken: 't1', rowId: RULE, state: 'definitely-unsent', dispatchToken: null, ...over });
  const state = effect({ effect: 'state' });
  const body = effect({ effect: 'body' });
  assert.deepEqual(existingRowDispatches({ pending, effects: [state, body] }), [state, body], 'no committed group and a null base are not evidence of a create');
  assert.deepEqual(existingRowDispatches({ pending, effects: [effect({ effect: 'create', state: 'confirmed' }), state] }), [], 'its own create, confirmed');
  assert.deepEqual(existingRowDispatches({ pending: { ...pending, acknowledgedRoot: true }, effects: [state] }), [], 'its own create, acknowledged');
  assert.deepEqual(existingRowDispatches({ pending: { ...pending, savedObservation: { acknowledgedRoot: true } }, effects: [state] }), []);
  assert.deepEqual(existingRowDispatches({ pending, effects: [effect({ effect: 'create' }), state] }), [state], 'a create that is not confirmed proves nothing');
  assert.deepEqual(existingRowDispatches({ pending, effects: [{ ...state, state: 'dispatching', dispatchToken: 'd' }] }), [], 'a dispatched effect is proved, never sent again');
  assert.deepEqual(existingRowDispatches({ pending, effects: [{ ...state, attemptToken: 'other' }] }), [], 'another attempt\'s effect');
  assert.deepEqual(existingRowDispatches({ pending: null, effects: [state] }), []);
  assert.deepEqual([...rowsCreatedByAttempt({ pending: { ...pending, acknowledgedRoot: true }, effects: [] })], [RULE]);
});

test('workflow preflight: with the edit switch off, a state write to an adopted existing workflow is refused before anything is sent; preflight sees the attempt\'s effects', async () => {
  const s = await setup();
  const key = 'account/hide';
  s.wire.workflows.set(MAIN, { workflowid: MAIN, statecode: 0, statuscode: 1 });
  const token = s.store.prepareAttempt({ family: 'rule', key, baseGeneration: null, root: { kind: 'business-rule', key, id: MAIN }, declarationSha256: H('e'), knownScopes: [] });
  s.store.markSending(token, { ...expected(MAIN), proofSchema: 'rule-v1', baseProofSha256: H('d'), baseObservation: { rowVersion: null, savedSha256: H('d') } });
  const effect = { attemptToken: token, baseGeneration: null, family: 'rule', key, rowId: MAIN, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active' };
  const recorded = s.store.recordWorkflowEffect(effect);
  const { sdk } = await sdkOver(s.wire, { barrier: s.barrier, workflowEffectGate: createWorkflowEffectGate({ store: s.store }) });
  const switchOn = false;
  const seen = [];
  const result = await codeOf(runManagedFeature({
    family: 'rule', key, phase: 'rules', halt, store: s.store, barrier: s.barrier, adoptionApproved: true,
    preflight: async (a) => {
      seen.push(a.effects.map((e) => e.token));
      if (!switchOn && existingRowDispatches(a).length) throw Object.assign(new Error('edits are switched off'), { code: 'workflow-edit-refused' });
    },
    resolve: async () => {}, plan: async () => {}, apply: async () => {}, ensureMembership: async () => {},
    prove: async () => {
      await withWorkflowEffect({ store: s.store, effect }, () => sdk.dataverse.patch(`/workflows(${MAIN})`, { statecode: 1, statuscode: 2 }));
      return null;
    },
  }));
  assert.equal(result, 'workflow-edit-refused');
  assert.deepEqual(seen, [[recorded.token]]);
  assert.deepEqual(s.wire.writes(), [], 'adoption approval does not switch edits on');
  assert.equal(s.wire.workflows.get(MAIN).statecode, 0);
  assert.equal(s.store.readGroup('rule', key).pending.token, token);
});

test('publication race: a publish dispatched while an edit runs its preflight stops the edit before it prepares or sends; the publish puts only its own version live', { timeout: 20000 }, async () => {
  const s = await setup();
  const refs = [{ family: 'form', key: 'account/main' }];
  await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier });
  const inPreflight = latch();
  const releaseEdit = latch();
  const entered = latch();
  const releasePublish = latch();
  const p = tracked(ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }));
  let saw;
  p.preflight = async ({ committed }) => { saw = committed.publication.state; inPreflight.resolve(); await releaseEdit.promise; };
  const editDone = outcome(runManagedFeature({ ...p, client: s.sdk.dataverse, store: s.store, barrier: s.barrier }));
  await inPreflight.promise;
  // Another process publishes version 1 while the edit waits in its preflight: its dispatch is recorded, then held in flight.
  const original = s.wire.request;
  s.wire.request = async (req) => {
    if (req.method === 'POST' && /PublishXml/.test(req.url)) { entered.resolve(); await releasePublish.promise; }
    return original(req);
  };
  const publisher = await nextRun(s);
  s.wire.request = original;
  const publishDone = outcome(publishForms(publisher.sdk, publisher.store, publisher.barrier, refs));
  assert.equal(await Promise.race([entered.promise.then(() => true), publishDone.then(() => false)]), true, 'the publish is in flight');
  assert.equal(publisher.store.readGroup('form', 'account/main').committed.publication.state, 'dispatching');
  releaseEdit.resolve();
  const edited = await editDone;
  releasePublish.resolve();
  const published = await publishDone;
  assert.equal(saw, 'owed', 'the edit read the group before the publish was dispatched');
  assert.equal(edited.error, PUBLICATION_UNCONFIRMED);
  assert.equal(s.barrier.allowScope(ACCOUNT, 'a sibling'), false, 'the edit\'s scope is quarantined for the run');
  assert.ok(!p.calls.includes('apply'), 'nothing sent');
  assert.deepEqual(s.wire.log.filter(isPatch), [], 'the edit never left');
  assert.equal(s.wire.published.get(MAIN).formxml, '<form v="1"/>', 'the earlier publish put only its own version live');
  assert.equal(published.error, undefined, 'the publish settled');
  const reopened = await nextRun(s);
  const after = reopened.store.readGroup('form', 'account/main');
  assert.equal(after.pending, null, 'nothing prepared');
  assert.equal(after.committed.publication.state, 'confirmed');
  // No dead end: the next run makes the edit.
  const again = ports(s.wire, reopened.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' });
  assert.deepEqual((await runManagedFeature({ ...again, client: reopened.sdk.dataverse, store: reopened.store, barrier: reopened.barrier })).result, { committed: true, recovered: false });
  assert.equal(s.wire.saved.get(MAIN).formxml, '<form v="2"/>');
});

test('workflow handoff: a state effect first recorded inside recovery is refused by the operation check before it is sent; only the attempt\'s own Draft completion passes', async () => {
  const key = 'account/hide';
  const refusal = () => Object.assign(new Error('edits are switched off'), { code: 'workflow-edit-refused' });
  // An existing Draft workflow, a pending attempt with a recorded base and no effect recorded yet: the persisted-effect
  // preflight sees nothing, and recovery proposes the state write for the first time.
  const strand = async ({ acknowledged = false } = {}) => {
    const s = await setup();
    s.wire.workflows.set(MAIN, { workflowid: MAIN, statecode: 0, statuscode: 1 });
    const token = s.store.prepareAttempt({ family: 'rule', key, baseGeneration: null, root: { kind: 'business-rule', key, id: MAIN }, declarationSha256: H('e'), knownScopes: [] });
    s.store.markSending(token, { ...expected(MAIN), proofSchema: 'rule-v1', baseProofSha256: H('d'), baseObservation: { rowVersion: null, savedSha256: H('d') } });
    if (acknowledged) s.store.noteSaved(token, { proof: null, acknowledgedRoot: true, phase: 'state-pending' });
    const effect = { attemptToken: token, baseGeneration: null, family: 'rule', key, rowId: MAIN, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active' };
    const { sdk } = await sdkOver(s.wire, { barrier: s.barrier, workflowEffectGate: createWorkflowEffectGate({ store: s.store }) });
    return { s, token, effect, sdk };
  };
  const recover = ({ s, effect, sdk }, proposeWith) => {
    const seen = {};
    const run = codeOf(runManagedFeature({
      family: 'rule', key, phase: 'rules', halt, store: s.store, barrier: s.barrier, adoptionApproved: true,
      preflight: async (a) => {
        seen.preflight = existingRowDispatches(a).length;
        if (existingRowDispatches(a).length) throw refusal();
      },
      resolve: async () => {}, plan: async () => {}, apply: async () => {}, ensureMembership: async () => {},
      prove: async () => {
        await proposeWith(() => sdk.dataverse.patch(`/workflows(${MAIN})`, { statecode: 1, statuscode: 2 }));
        throw Object.assign(new Error('stopped after the write'), { code: 'probe-complete' });
      },
    }));
    return run.then((code) => ({ code, seen }));
  };
  // The documented consumer rule: check the proposed operation, with the switch off, before it is recorded or sent.
  const byRule = (x) => (send) => {
    if (editSwitchRequired(x.s.store.readGroup('rule', key), x.effect)) throw refusal();
    return withWorkflowEffect({ store: x.s.store, effect: x.effect }, send);
  };
  // The same check made by withWorkflowEffect itself when the feature passes its switch.
  const bySwitch = (x) => (send) => withWorkflowEffect({ store: x.s.store, effect: x.effect, workflowConditionalEdits: false }, send);
  for (const [label, how] of [['the consumer rule', byRule], ['withWorkflowEffect with the switch off', bySwitch]]) {
    const x = await strand();
    const { code, seen } = await recover(x, how(x));
    assert.equal(seen.preflight, 0, `${label}: the persisted-effect preflight sees nothing to refuse`);
    assert.equal(code, 'workflow-edit-refused', label);
    assert.deepEqual(x.s.wire.writes(), [], `${label}: zero writes`);
    assert.equal(x.s.wire.workflows.get(MAIN).statecode, 0, `${label}: Draft kept`);
    const after = x.s.store.readGroup('rule', key);
    assert.deepEqual([after.pending.token, after.effects], [x.token, []], `${label}: the attempt kept, nothing recorded`);
  }
  // The attempt's own Draft, its create acknowledged: completing it is the one write the default path allows.
  const own = await strand({ acknowledged: true });
  assert.equal((await recover(own, bySwitch(own))).code, 'probe-complete');
  assert.equal(own.s.wire.writes().length, 1);
  assert.equal(own.s.wire.workflows.get(MAIN).statecode, 1);
  // Any body write, and a state write of another attempt or with no pending attempt, is an edit; a create is not.
  const read = own.s.store.readGroup('rule', key);
  assert.equal(editSwitchRequired(read, { ...own.effect, effect: 'body', desiredState: null }), true, 'a body write of its own Draft is not completion');
  assert.equal(editSwitchRequired(read, { ...own.effect, attemptToken: 'another' }), true);
  assert.equal(editSwitchRequired({ pending: null, effects: [] }, own.effect), true);
  assert.equal(editSwitchRequired({ pending: null, effects: [] }, { ...own.effect, effect: 'create' }), false);
});

// A declaration with authored free text, as a maker writes it: names, a description with markup characters, a URL.
const DECLARED = Object.freeze({
  name: 'Main', description: 'Sales <overview> & pipeline — “quarterly” ünïcode', fieldOptions: { name: { required: false } },
  iframe: { name: 'News', url: 'https://contoso.crm.dynamics.com/WebResources/new_news.htm?id=1&lang=en' },
});
const TODAY = Object.freeze({ ...DECLARED, description: 'Changed since' });
// The ports of a feature that records its declaration with the attempt; its proof answers today's declaration, as a helper
// that rebuilt it from the spec would.
function declaring(p, declaration, answered = declaration) {
  const plan = p.plan;
  p.plan = async (a) => { const r = await plan(a); return r && r.noop !== true ? { ...r, declaration } : r; };
  const prove = p.prove;
  p.proveSaw = [];
  p.prove = async (a) => { p.proveSaw.push(a.declaration); const r = await prove(a); return { ...r, consumerState: { ...r.consumerState, declaration: answered } }; };
  return p;
}

test('declaration: an attempt keeps its original declaration from before the send; recovery commits that one, never today\'s, never null', async () => {
  const s = await setup();
  await runManagedFeature({ ...ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: s.store, barrier: s.barrier });
  const first = declaring(ports(s.wire, s.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>', fail: { membership: Object.assign(new Error('membership failed'), { code: 'membership-failed' }) } }), DECLARED);
  const apply = first.apply;
  let onDisk;
  first.apply = async (a) => { onDisk = context(s.dir, createPublicationBarrier()).store.readGroup('form', 'account/main').pending.declaration; return apply(a); };
  assert.equal(await codeOf(runManagedFeature({ ...first, store: s.store, barrier: s.barrier })), 'membership-failed');
  assert.deepEqual(onDisk, DECLARED, 'persisted, losslessly, before the send');
  assert.equal(s.wire.saved.get(MAIN).formxml, '<form v="2"/>');

  for (const answered of [TODAY, null]) {
    const u = await setup();
    await runManagedFeature({ ...ports(u.wire, u.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: u.store, barrier: u.barrier });
    const p = declaring(ports(u.wire, u.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>', fail: { membership: Object.assign(new Error('membership failed'), { code: 'membership-failed' }) } }), DECLARED);
    await codeOf(runManagedFeature({ ...p, store: u.store, barrier: u.barrier }));
    const n = await nextRun(u);
    // Today's spec says something else; the recovery proves the save the attempt made and records what it declared.
    const q = declaring(ports(u.wire, n.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }), TODAY, answered);
    let preflightSaw;
    q.preflight = async ({ pending }) => { preflightSaw = pending.declaration; };
    assert.deepEqual((await runManagedFeature({ ...q, store: n.store, barrier: n.barrier })).result, { committed: true, recovered: true });
    assert.deepEqual(preflightSaw, DECLARED);
    assert.deepEqual(q.proveSaw, [DECLARED], 'the recovery proof is given the recorded declaration');
    const { committed, pending } = (await nextRun(u)).store.readGroup('form', 'account/main');
    assert.equal(pending, null);
    assert.deepEqual(committed.consumerState.declaration, DECLARED, `answered ${answered === null ? 'null' : 'today\'s'}`);
  }
});

test('declaration: a changed declaration is never sent under an attempt that recorded another; a prepared one is retired and prepared again', async () => {
  // A continuation whose declaration changed, under the same hash: refused before anything is sent.
  const s = await observedSetup();
  await committedEdit(s);
  const first = declaring(editPorts(s.wire, s.sdk, { formxml: '<form v="2"/>', local: localFailure() }), DECLARED);
  assert.equal(await codeOf(runManagedFeature(observed(first, s))), 'form-layout-local-edit');
  const stranded = s.store.readGroup('form', 'account/main').pending;
  const n = await observedRun(s);
  const changed = declaring(editPorts(s.wire, n.sdk, { formxml: '<form v="2"/>' }), TODAY);
  assert.equal(await codeOf(runManagedFeature(observed(changed, n))), 'create-completion-required');
  assert.deepEqual([changed.sends, s.wire.log.filter(isPatch)], [[], []]);
  assert.deepEqual(n.store.readGroup('form', 'account/main').pending, stranded, 'kept as it was');

  // A prepared attempt (never marked sending) whose plan now declares something else sent nothing: it is retired, and
  // the change is prepared and sent under a new attempt that records today's declaration.
  const u = await setup();
  await runManagedFeature({ ...ports(u.wire, u.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="1"/>' }), store: u.store, barrier: u.barrier });
  const g = u.store.readGroup('form', 'account/main').committed;
  const old = u.store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: g.generation, root: { kind: 'form', key: 'account/main', id: MAIN }, knownScopes: [ACCOUNT], declarationSha256: H('e'), declaration: DECLARED, publication: { scope: ACCOUNT, state: 'owed' } });
  const m = await nextRun(u);
  const p = declaring(ports(u.wire, m.sdk, { key: 'account/main', id: MAIN, formxml: '<form v="2"/>' }), TODAY);
  const tokens = [];
  const apply = p.apply;
  p.apply = async (a) => { tokens.push(a.token); return apply(a); };
  assert.deepEqual((await runManagedFeature({ ...p, store: m.store, barrier: m.barrier })).result, { committed: true, recovered: false });
  assert.equal(tokens.length, 1);
  assert.notEqual(tokens[0], old, 'not sent under the attempt that recorded another declaration');
  assert.deepEqual(m.store.readGroup('form', 'account/main').committed.consumerState.declaration, TODAY);
});