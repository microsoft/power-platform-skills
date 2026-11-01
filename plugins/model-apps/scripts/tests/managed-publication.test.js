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
const { runManagedFeature, publishManagedScope, PUBLICATION_UNCONFIRMED, PUBLICATION_UNVERIFIED, CREATION_RECORD_UNSETTLED, LAYER_READER_MISSING } = require('../lib/managed-feature-contract.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { readSystemFormPublication, readSystemFormLayers } = require('../lib/systemform-published.js');
const { publishTablesXml } = require('../lib/table-publish.js');
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
