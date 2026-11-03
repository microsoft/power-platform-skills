'use strict';
// The managed binding store (lib/managed-bindings.js): one local file per environment, app and solution that records the
// rows a declared form, dashboard, business rule or process flow is bound to, as whole groups, with the attempt that is
// changing a group written before anything is sent. These tests hold the file to what a later build may trust: a group
// is replaced whole or not at all, an interrupted change never exposes a partial or substituted set, a pending attempt
// masks the older group, and anything the store cannot read whole is refused rather than read as empty.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const {
  openManagedBindings, openManagedContext, discoverManagedStore, classifyPersisted, managedManifestView, CODES, MAX_BYTES,
  PREPARE_RESERVE_BYTES, DECLARATION_MAX_BYTES, COMPLETION_BASE_BYTES, COMPLETION_MAX_BYTES, checkDeclaration, publicationRiskApproval, publicationRemedy,
  RETIRED_GROUPS_KEPT, INCARNATIONS_KEPT,
} = require('../lib/managed-bindings.js');
const { canonicalJson } = require('../lib/reconcile-common.js');
const { noteToken } = require('../lib/output-redaction.js');
const { withRecordLease } = require('../lib/record-lease.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = 'contoso_app';
const SOL = 'contoso_solution';
const FP = environmentFingerprint(ENV);
const H = (c) => c.repeat(64);
const FORM = '11111111-1111-4111-8111-111111111111';
const DASH = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const BPF = '44444444-4444-4444-8444-444444444444';
const CTRL_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CTRL_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const SUBSTITUTE = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const FORM_KEY = 'account/main';
const TABLE = { type: 'table', table: 'account' };

const open = (dir, extra = {}) => openManagedBindings({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, ...extra });
const rec = (kind, key, id, over = {}) => ({ formatVersion: 1, appUniqueName: APP, environmentFingerprint: FP, kind, key, id, intentSha256: H('a'), origin: 'created', ...over });
const child = (key, id) => ({ kind: 'control', key, namespaceParentId: FORM, id, associationSha256: H('d') });
const expected = (rootId, children = [], schema = 'form-v1') => ({
  proofVersion: 1, proofSchema: schema, rootId, baseProofSha256: null, sentProjectionSha256: H('b'), preservationSha256: H('c'), baseObservation: null, children,
});
const PROOF = { savedSha256: H('1'), semanticSha256: H('2'), preservationSha256: H('3'), expectedChildrenSha256: H('4') };
const formState = (children = {}) => ({ declaration: { name: 'Main', fieldOptions: { name: { required: false } } }, children, proofSchema: 'form-v1' });
const owedTable = () => ({ scope: TABLE, state: 'owed', desiredSha256: H('5'), dispatchToken: null });
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const fileText = (store) => fs.readFileSync(store.file, 'utf8');
// A refusal over an unconfirmed publish names that dispatch as data: its token, the scope's typed approval and the remedy.
const blockedShape = (fn) => { try { fn(); } catch (e) { return [e.code, e.dispatchToken, e.approval, e.remedy]; } return null; };
const blockedBy = (dispatchToken, scope = TABLE) => [CODES.publicationUncertain, dispatchToken, publicationRiskApproval(scope, dispatchToken), publicationRemedy(scope, dispatchToken)];

// Settle a form group whose children are `kids` ([[key, id]]), from whatever the group is now.
function settleForm(store, kids, { acknowledged = true, publication = owedTable() } = {}) {
  const { committed } = store.readGroup('form', FORM_KEY);
  const base = committed ? committed.generation : null;
  const token = store.prepareAttempt({
    family: 'form', key: FORM_KEY, baseGeneration: base, root: { kind: 'form', key: FORM_KEY, id: FORM },
    knownScopes: [TABLE], declarationSha256: H('e'), publication: { scope: TABLE, state: 'owed' },
  });
  store.markSending(token, expected(FORM, kids.map(([k, id]) => child(k, id))));
  store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: acknowledged });
  return store.commitGroup({
    token, baseGeneration: base, records: [rec('form', FORM_KEY, FORM), ...kids.map(([k, id]) => rec('control', k, id, { parentKey: FORM_KEY }))],
    proof: PROOF, consumerState: formState(Object.fromEntries(kids)), publication,
  });
}

function writeRaw(store, mutate) {
  const data = JSON.parse(fileText(store));
  mutate(data);
  fs.writeFileSync(store.file, JSON.stringify(data, null, 2));
}

test('an absent store is empty and creates nothing; a corrupt or foreign one is unreadable and stays as it was', () => {
  const dir = makeTempDir('mb-absent-');
  assert.deepEqual(discoverManagedStore({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL }), { absent: true });
  const store = open(dir);
  assert.equal(store.snapshot().revision, 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'opening and reading an absent store writes nothing');

  settleForm(store, [['name', CTRL_A]]);
  const good = fileText(store);
  fs.writeFileSync(store.file, `${good.slice(0, 40)}`);
  assert.equal(codeOf(() => discoverManagedStore({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL })), CODES.unreadable);
  assert.equal(codeOf(() => open(dir)), CODES.unreadable);
  assert.equal(fileText(store), good.slice(0, 40), 'a corrupt store is never replaced with an empty one');

  fs.writeFileSync(store.file, good.replace(`"appUniqueName": "${APP}"`, '"appUniqueName": "contoso_other"'));
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'a header for another app is foreign');
});

test('a store file that is a link, a junction or a hard-linked name is refused', (t) => {
  const dir = makeTempDir('mb-links-');
  const store = open(dir);
  settleForm(store, [['name', CTRL_A]]);
  const real = path.join(makeTempDir('mb-links-real-'), 'real.json');
  fs.copyFileSync(store.file, real);

  fs.linkSync(store.file, path.join(dir, 'second-name.json'));
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'nlink > 1');
  fs.unlinkSync(path.join(dir, 'second-name.json'));
  assert.equal(open(dir).snapshot().revision, 4);

  fs.unlinkSync(store.file);
  fs.symlinkSync(path.dirname(real), store.file, 'junction');
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'a junction');
  fs.rmSync(store.file, { force: true, recursive: false });
  try { fs.unlinkSync(store.file); } catch { /* removed above */ }

  try {
    fs.symlinkSync(real, store.file, 'file');
  } catch (e) {
    if (e.code === 'EPERM') { t.diagnostic('file symbolic links need a privilege this account does not have; the junction case covers links'); return; }
    throw e;
  }
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'a symbolic link');
});

test('two groups of one identity, or two roots that are one systemform or workflow row, make the store unreadable', () => {
  const dir = makeTempDir('mb-dup-');
  const store = open(dir);
  settleForm(store, [['name', CTRL_A]]);
  const good = fileText(store);
  writeRaw(store, (d) => { d.groups.push(JSON.parse(JSON.stringify(d.groups[0]))); });
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'a repeated (family, key)');

  fs.writeFileSync(store.file, good);
  writeRaw(store, (d) => {
    const g = JSON.parse(JSON.stringify(d.groups[0]));
    Object.assign(g, { family: 'dashboard', key: 'sales', root: { kind: 'dashboard', key: 'sales', id: FORM }, publication: { scope: { type: 'dashboard', id: FORM }, state: 'owed', desiredSha256: H('5'), dispatchToken: null }, consumerState: { declaration: {}, tiles: {}, seedIds: [] } });
    g.records = [rec('dashboard', 'sales', FORM)];
    d.groups.push(g);
  });
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'a form and a dashboard on one systemform row');

  const wf = makeTempDir('mb-dup-wf-');
  const rules = open(wf);
  settleRule(rules, 'account/hide', RULE);
  writeRaw(rules, (d) => {
    const g = JSON.parse(JSON.stringify(d.groups[0]));
    Object.assign(g, { family: 'bpf', key: 'account-flow', root: { kind: 'bpf', key: 'account-flow', id: RULE }, consumerState: { declaration: {}, stages: {} } });
    g.records = [rec('bpf', 'account-flow', RULE)];
    d.groups.push(g);
  });
  assert.equal(codeOf(() => open(wf)), CODES.unreadable, 'a rule and a process flow on one workflow row');
});

test('a pending attempt masks the committed group from lookup; recovery reads both', () => {
  const store = open(makeTempDir('mb-mask-'));
  const first = settleForm(store, [['name', CTRL_A]]);
  assert.equal(store.lookup('control', 'name').id, CTRL_A);
  store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: first.generation, root: first.root, knownScopes: [TABLE], declarationSha256: H('e') });
  assert.equal(codeOf(() => store.lookup('control', 'name')), CODES.pending);
  assert.equal(codeOf(() => store.lookup('form', FORM_KEY)), CODES.pending);
  const { committed, pending } = store.readGroup('form', FORM_KEY);
  assert.equal(committed.generation, first.generation);
  assert.equal(pending.phase, 'prepared');
});

test('a plan made against an older generation or revision is refused and writes nothing', () => {
  const store = open(makeTempDir('mb-cas-'));
  const first = settleForm(store, [['name', CTRL_A]]);
  const before = fileText(store);
  const args = { family: 'form', key: FORM_KEY, root: first.root, knownScopes: [TABLE], declarationSha256: H('e') };
  assert.equal(codeOf(() => store.prepareAttempt({ ...args, baseGeneration: null })), CODES.conflict);
  assert.equal(codeOf(() => store.prepareAttempt({ ...args, baseGeneration: first.generation, revision: store.snapshot().revision - 1 })), CODES.conflict);
  assert.equal(fileText(store), before);
  // A commit replaces the group under a new generation, so a plan read before it can never be applied after it.
  const second = settleForm(store, [['name', CTRL_A], ['email', CTRL_B]]);
  assert.notEqual(second.generation, first.generation);
  assert.equal(second.previousGeneration, first.generation);
  const afterSecond = fileText(store);
  assert.equal(codeOf(() => store.prepareAttempt({ ...args, baseGeneration: first.generation })), CODES.conflict);
  assert.equal(fileText(store), afterSecond);
});

test('a lease another writer holds stops the change with nothing written; the change runs synchronously inside the lease', () => {
  const dir = makeTempDir('mb-lease-');
  const store = open(dir, { deps: { lease: { attempts: 1, sleep() {} } } });
  const first = settleForm(store, [['name', CTRL_A]]);
  const before = fileText(store);
  const inner = withRecordLease(dir, path.basename(store.file), () => codeOf(() => store.prepareAttempt({
    family: 'form', key: FORM_KEY, baseGeneration: first.generation, root: first.root, knownScopes: [TABLE], declarationSha256: H('e'),
  })));
  assert.equal(inner.value, CODES.busy);
  assert.equal(fileText(store), before);
  const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: first.generation, root: first.root, knownScopes: [TABLE], declarationSha256: H('e') });
  assert.equal(typeof token, 'string', 'a change answers when it returns, not later');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.lock')), [], 'the lease is let go before the change returns');
});

test('a write that does not read back whole — a failed reopen or a redacting writer — is a failure, never success', () => {
  const dir = makeTempDir('mb-reopen-');
  const store = open(dir);
  const first = settleForm(store, [['name', CTRL_A]]);
  const args = { family: 'form', key: FORM_KEY, baseGeneration: first.generation, root: first.root, knownScopes: [TABLE], declarationSha256: H('e') };
  const torn = open(dir, { deps: { writeFileAtomic: (p, text) => fs.writeFileSync(p, text.slice(0, text.length - 20)) } });
  assert.equal(codeOf(() => torn.prepareAttempt(args)), CODES.writeFailed);
  const redir = makeTempDir('mb-redact-');
  const clean = open(redir);
  const g = settleForm(clean, [['name', CTRL_A]]);
  const redacting = open(redir, { deps: { writeFileAtomic: (p, text) => fs.writeFileSync(p, text.replace(H('e'), '*'.repeat(64))) } });
  const before = fileText(clean);
  assert.equal(codeOf(() => redacting.prepareAttempt({ ...args, baseGeneration: g.generation })), CODES.writeFailed);
  assert.notEqual(fileText(clean), before, 'the redacted text did reach the disk');
  assert.equal(codeOf(() => open(redir).readGroup('form', FORM_KEY)), CODES.groupInvalid, 'and the group it changed is not trusted afterwards');
});

test('a group commit keeps the child records the new set omits; the store reads CRLF and a byte-order mark', () => {
  const store = open(makeTempDir('mb-omit-'));
  settleForm(store, [['name', CTRL_A], ['phone', CTRL_B]]);
  const second = settleForm(store, [['name', CTRL_A]]);
  assert.deepEqual(second.records.map((r) => r.key).sort(), [FORM_KEY, 'name', 'phone']);
  const text = fileText(store);
  fs.writeFileSync(store.file, `\uFEFF${text.replace(/\n/g, '\r\n')}`);
  assert.equal(store.refresh().revision, JSON.parse(text).revision);
  assert.equal(store.lookup('control', 'phone').id, CTRL_B);
});

// A change interrupted at each persistence boundary, then a restart that substitutes one child for the one sent.
for (const boundary of ['prepared', 'sending', 'saved', 'commit-write']) {
  test(`an update interrupted after ${boundary}: the old group stays whole, the attempt stays, a substitute is never bound`, () => {
    const dir = makeTempDir('mb-partial-');
    const store = open(dir);
    const old = settleForm(store, [['name', CTRL_A]]);
    const oldGroup = JSON.stringify(JSON.parse(fileText(store)).groups);
    const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: old.generation, root: old.root, knownScopes: [TABLE], declarationSha256: H('e') });
    const exp = expected(FORM, [child('name', CTRL_A), child('phone', CTRL_B)]);
    if (boundary !== 'prepared') store.markSending(token, exp);
    if (boundary === 'saved') store.noteSaved(token, { proof: { savedSha256: H('1') } });
    if (boundary === 'commit-write') store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
    if (boundary === 'commit-write') {
      const failing = open(dir, { deps: { writeFileAtomic: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
      const records = [rec('form', FORM_KEY, FORM), rec('control', 'name', CTRL_A, { parentKey: FORM_KEY }), rec('control', 'phone', CTRL_B, { parentKey: FORM_KEY })];
      assert.equal(codeOf(() => failing.commitGroup({ token, baseGeneration: old.generation, records, proof: PROOF, consumerState: formState(), publication: owedTable() })), CODES.writeFailed);
    }

    const restarted = open(dir);
    assert.equal(JSON.stringify(JSON.parse(fileText(restarted)).groups), oldGroup, 'the committed group is exactly the old one');
    const { pending } = restarted.readGroup('form', FORM_KEY);
    assert.equal(pending.token, token, 'the attempt is retained');
    assert.equal(codeOf(() => restarted.lookup('control', 'name')), CODES.pending, 'the old root cannot authorize a plan');

    if (boundary === 'prepared') return;
    // The service now shows another row where `phone` was sent, and the answer of the create was lost.
    const substituted = [rec('form', FORM_KEY, FORM), rec('control', 'name', CTRL_A, { parentKey: FORM_KEY }), rec('control', 'phone', SUBSTITUTE, { parentKey: FORM_KEY })];
    const before = fileText(restarted);
    assert.equal(codeOf(() => restarted.commitGroup({ token, baseGeneration: old.generation, records: substituted, proof: PROOF, consumerState: formState(), publication: owedTable() })), CODES.completion);
    assert.equal(fileText(restarted), before, 'a refused commit writes nothing');
    const created = [rec('form', FORM_KEY, FORM), rec('control', 'name', CTRL_A, { parentKey: FORM_KEY }), rec('control', 'phone', CTRL_B, { parentKey: FORM_KEY })];
    const commit = () => restarted.commitGroup({ token, baseGeneration: old.generation, records: created, proof: PROOF, consumerState: formState(), publication: owedTable() });
    if (boundary === 'commit-write') {
      // The create was acknowledged before the crash, so the proved set may now be committed whole.
      assert.equal(commit().records.find((r) => r.key === 'phone').id, CTRL_B);
    } else {
      assert.equal(codeOf(commit), CODES.completion, 'a new child cannot be recorded as created without an acknowledged create');
      assert.equal(fileText(restarted), before);
    }
    assert.ok(!fileText(restarted).includes(SUBSTITUTE));
  });
}

test('an interrupted update leaves no new tile baseline or rule slot map in the file', () => {
  const dir = makeTempDir('mb-baseline-');
  const store = open(dir);
  const dashKey = 'sales';
  const token0 = store.prepareAttempt({ family: 'dashboard', key: dashKey, baseGeneration: null, root: { kind: 'dashboard', key: dashKey, id: DASH }, knownScopes: [{ type: 'dashboard', id: DASH }], declarationSha256: H('e') });
  store.markSending(token0, expected(DASH, [], 'dashboard-v1'));
  store.noteSaved(token0, { proof: null, acknowledgedRoot: true });
  const dash = store.commitGroup({ token: token0, baseGeneration: null, records: [rec('dashboard', dashKey, DASH)], proof: PROOF, consumerState: { declaration: {}, tiles: { revenue: 'cell_1' }, seedIds: [] }, publication: { scope: { type: 'dashboard', id: DASH }, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
  const rule = settleRule(store, 'account/hide', RULE, { slots: ['clause_a'] });

  const t1 = store.prepareAttempt({ family: 'dashboard', key: dashKey, baseGeneration: dash.generation, root: dash.root, knownScopes: [{ type: 'dashboard', id: DASH }], declarationSha256: H('f') });
  store.markSending(t1, expected(DASH, [], 'dashboard-v1'));
  const t2 = store.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: rule.generation, root: rule.root, knownScopes: [], declarationSha256: H('f') });
  store.markSending(t2, expected(RULE, [], 'rule-v1'));
  const failing = open(dir, { deps: { writeFileAtomic: () => { throw new Error('crash before the replace'); } } });
  assert.equal(codeOf(() => failing.commitGroup({ token: t1, baseGeneration: dash.generation, records: [rec('dashboard', dashKey, DASH)], proof: PROOF, consumerState: { declaration: {}, tiles: { revenue: 'cell_1', margin: 'cell_9' }, seedIds: [] }, publication: { scope: { type: 'dashboard', id: DASH }, state: 'not-needed', desiredSha256: null, dispatchToken: null } })), CODES.writeFailed);
  assert.equal(codeOf(() => failing.commitGroup({ token: t2, baseGeneration: rule.generation, records: [rec('business-rule', 'account/hide', RULE)], proof: PROOF, consumerState: { declaration: {}, slots: ['clause_b', 'clause_a'] }, publication: null })), CODES.writeFailed);

  const disk = JSON.parse(fileText(open(dir)));
  assert.deepEqual(disk.groups.find((g) => g.family === 'dashboard').consumerState.tiles, { revenue: 'cell_1' });
  assert.deepEqual(disk.groups.find((g) => g.family === 'rule').consumerState.slots, ['clause_a']);
  assert.ok(!fileText(store).includes('cell_9') && !fileText(store).includes('clause_b'));
});

// A rule settled with a confirmed create and a confirmed activation, both workflow effects of its own attempt.
function settleRule(store, key, id, { slots = ['clause_a'], confirm = true } = {}) {
  const { committed } = store.readGroup('rule', key);
  const base = committed ? committed.generation : null;
  const token = store.prepareAttempt({ family: 'rule', key, baseGeneration: base, root: { kind: 'business-rule', key, id }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(id, [], 'rule-v1'));
  const create = store.recordWorkflowEffect({ attemptToken: token, baseGeneration: base, family: 'rule', key, rowId: id, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: H('7') });
  const state = store.recordWorkflowEffect({ attemptToken: token, baseGeneration: base, family: 'rule', key, rowId: id, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active' });
  if (confirm) {
    store.markEffectDispatching(create.token, 'dispatch-create');
    store.confirmEffect(create.token, { observedSha256: H('7') });
    store.markEffectDispatching(state.token, 'dispatch-state');
    store.confirmEffect(state.token, { observedState: 'Active' });
    store.noteSaved(token, { proof: null, acknowledgedRoot: true });
    return store.commitGroup({ token, baseGeneration: base, records: [rec('business-rule', key, id)], proof: PROOF, consumerState: { declaration: {}, slots }, publication: null });
  }
  return { token, create, state };
}

test('a rule and a process flow settle with confirmed create and state effects, and reopen with the group and no effect left', () => {
  const dir = makeTempDir('mb-retire-');
  const store = open(dir);
  settleRule(store, 'account/hide', RULE);
  const key = 'account-flow';
  const token = store.prepareAttempt({ family: 'bpf', key, baseGeneration: null, root: { kind: 'bpf', key, id: BPF }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(BPF, [], 'bpf-v1'));
  const c = store.recordWorkflowEffect({ attemptToken: token, baseGeneration: null, family: 'bpf', key, rowId: BPF, effect: 'create', request: { method: 'POST', shape: 'bpf-create' }, desiredSha256: H('8') });
  const s = store.recordWorkflowEffect({ attemptToken: token, baseGeneration: null, family: 'bpf', key, rowId: BPF, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active' });
  for (const [e, proof] of [[c, { observedSha256: H('8') }], [s, { observedState: 'Active' }]]) { store.markEffectDispatching(e.token, `d-${e.effect}`); store.confirmEffect(e.token, proof); }
  store.noteSaved(token, { proof: null, acknowledgedRoot: true });
  store.commitGroup({ token, baseGeneration: null, records: [rec('bpf', key, BPF)], proof: PROOF, consumerState: { declaration: {}, stages: { qualify: 'stage_1' } }, publication: null });

  const reopened = open(dir).snapshot();
  assert.deepEqual(reopened.envelope.groups.map((g) => [g.family, g.key]).sort(), [['bpf', key], ['rule', 'account/hide']]);
  assert.deepEqual(reopened.envelope.attempts, []);
  assert.deepEqual(reopened.envelope.workflowEffects, [], 'no effect outlives its attempt');
});

// The read that found a state change already made on its row: its state and the row version it answered.
const SEEN_ACTIVE = Object.freeze({ observedState: 'Active', observedVersion: 'W/"2"' });
const activation = (token, version, over = {}) => ({
  attemptToken: token, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE, effect: 'state',
  request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active', expectedVersion: version, ...over,
});
// A rule attempt whose own create a read confirmed, with no state change recorded yet.
function createdRule(store) {
  const key = 'account/hide';
  const token = store.prepareAttempt({ family: 'rule', key, baseGeneration: null, root: { kind: 'business-rule', key, id: RULE }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(RULE, [], 'rule-v1'));
  const create = store.recordWorkflowEffect({ attemptToken: token, baseGeneration: null, family: 'rule', key, rowId: RULE, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: H('7') });
  store.markEffectDispatching(create.token, 'dispatch-create');
  store.confirmEffect(create.token, { observedSha256: H('7') });
  store.noteSaved(token, { proof: null, acknowledgedRoot: true });
  return token;
}
const commitRule = (store, token) => store.commitGroup({ token, baseGeneration: null, records: [rec('business-rule', 'account/hide', RULE)], proof: PROOF, consumerState: { declaration: {}, slots: ['clause_a'] }, publication: null });

test('a state change never sent, whose state a read already finds on the row, is kept as fulfilled until its commit; a body or a dispatched change is not', () => {
  const dir = makeTempDir('mb-moot-');
  const store = open(dir);
  const { token, create, state } = settleRule(store, 'account/hide', RULE, { confirm: false });
  assert.equal(codeOf(() => store.fulfillEffect(create.token, SEEN_ACTIVE)), CODES.notSettled, 'a body is never settled without its proof');
  assert.equal(codeOf(() => store.fulfillEffect(state.token, { ...SEEN_ACTIVE, observedState: 'Draft' })), CODES.notSettled, 'the row is not in the asked state');
  const unchanged = fileText(store);
  for (const observed of [undefined, null, '', ' ']) assert.equal(codeOf(() => store.fulfillEffect(state.token, { ...SEEN_ACTIVE, observedState: observed })), CODES.notSettled, `no observed state (${observed})`);
  for (const version of [undefined, null, '', ' ', 2]) assert.equal(codeOf(() => store.fulfillEffect(state.token, { ...SEEN_ACTIVE, observedVersion: version })), CODES.notSettled, `no row version (${version})`);
  assert.equal(codeOf(() => store.fulfillEffect(state.token)), CODES.notSettled, 'no read at all');
  assert.equal(codeOf(() => store.fulfillEffect('no-such-effect', SEEN_ACTIVE)), CODES.notSettled, 'an unknown effect');
  assert.equal(fileText(store), unchanged, 'a refusal writes nothing');
  store.markEffectDispatching(create.token, 'dispatch-create');
  store.confirmEffect(create.token, { observedSha256: H('7') });
  const fulfilled = store.fulfillEffect(state.token, SEEN_ACTIVE);
  assert.deepEqual([fulfilled.token, fulfilled.state, fulfilled.dispatchToken, fulfilled.observedState, fulfilled.observedVersion], [state.token, 'fulfilled', null, 'Active', 'W/"2"']);
  // A terminal fact on disk, never a dispatch of ours: it is not confirmed, sent or answered, nor fulfilled twice.
  const reopened = open(dir);
  assert.deepEqual(reopened.readGroup('rule', 'account/hide').effects.map((e) => [e.effect, e.state]), [['create', 'confirmed'], ['state', 'fulfilled']]);
  const kept = fileText(store);
  assert.equal(codeOf(() => reopened.confirmEffect(state.token, { observedState: 'Active' })), CODES.notSettled, 'never called confirmed');
  assert.equal(codeOf(() => reopened.markEffectDispatching(state.token, 'dispatch-state')), CODES.notSettled, 'never sent');
  assert.equal(codeOf(() => reopened.noteEffectOutcome(state.token, 'unconfirmed')), CODES.notSettled);
  assert.equal(codeOf(() => reopened.fulfillEffect(state.token, SEEN_ACTIVE)), CODES.notSettled);
  assert.equal(fileText(store), kept);
  // The attempt is untouched, still pending under the same token; its commit takes the fulfilled fact with it.
  assert.deepEqual(store.snapshot().envelope.attempts.map((a) => a.token), [token]);
  store.noteSaved(token, { proof: null, acknowledgedRoot: true });
  commitRule(store, token);
  assert.deepEqual(open(dir).snapshot().envelope.workflowEffects, []);

  const other = open(makeTempDir('mb-moot-sent-'));
  const sent = settleRule(other, 'account/hide', RULE, { confirm: false });
  other.markEffectDispatching(sent.state.token, 'dispatch-state');
  assert.equal(codeOf(() => other.fulfillEffect(sent.state.token, SEEN_ACTIVE)), CODES.notSettled, 'a change that may have left is confirmed, not fulfilled');
  other.noteEffectOutcome(sent.state.token, 'unconfirmed');
  assert.equal(codeOf(() => other.fulfillEffect(sent.state.token, SEEN_ACTIVE)), CODES.notSettled, 'a lost answer is confirmed, not fulfilled');
  // A change a definite no-start returned to unsent never left, so a read may find it fulfilled like one never sent.
  const third = open(makeTempDir('mb-moot-nostart-'));
  const back = settleRule(third, 'account/hide', RULE, { confirm: false });
  third.markEffectDispatching(back.state.token, 'dispatch-state');
  third.noteEffectOutcome(back.state.token, 'definite-no-start');
  assert.equal(third.fulfillEffect(back.state.token, SEEN_ACTIVE).state, 'fulfilled');

  // A prepared attempt that holds a fulfilled change is not retired: its retirement would drop the fact.
  const fourth = open(makeTempDir('mb-moot-prepared-'));
  const prepared = fourth.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: null, root: { kind: 'business-rule', key: 'account/hide', id: RULE }, knownScopes: [], declarationSha256: H('e') });
  fourth.fulfillEffect(fourth.recordWorkflowEffect(activation(prepared, null)).token, SEEN_ACTIVE);
  const held = fileText(fourth);
  assert.equal(codeOf(() => fourth.retireUnsentAttempt({ token: prepared, baseGeneration: null })), CODES.pending);
  assert.equal(fileText(fourth), held);
});

test('a change found fulfilled is never proposed again: after a failure before its commit and a maker\'s change, a proposal at the new row version answers the fulfilled record, in another handle and another process', () => {
  const dir = makeTempDir('mb-moot-history-');
  const store = open(dir);
  const token = createdRule(store);
  const state = store.recordWorkflowEffect(activation(token, 'W/"2"'));
  store.fulfillEffect(state.token, SEEN_ACTIVE);
  // The commit never happens (the membership step failed, say). A maker then deactivates the row: version 3.
  const effectsOf = () => JSON.parse(fileText(store)).workflowEffects;
  const before = effectsOf();
  const again = open(dir).recordWorkflowEffect(activation(token, 'W/"3"'));
  assert.deepEqual([again.token, again.state, again.dispatchToken, again.observedVersion], [state.token, 'fulfilled', null, 'W/"2"'], 'the fulfilled record, never a new change to send');
  assert.equal(codeOf(() => open(dir).recordWorkflowEffect(activation(token, 'W/"3"', { desiredState: 'Draft' }))), CODES.pending, 'another state change of the row waits for the commit');
  assert.deepEqual(effectsOf(), before, 'nothing recorded');

  // A separate process that opens the store fresh answers the same, and cannot send the change.
  const child = [
    "const m = require(process.argv[1]);",
    "const s = m.openManagedBindings({ workspaceDir: process.argv[2], environment: process.argv[3], appUniqueName: 'contoso_app', solutionUniqueName: 'contoso_solution' });",
    "const r = s.recordWorkflowEffect(JSON.parse(process.argv[4]));",
    "let sent = null; try { s.markEffectDispatching(r.token, 'child-dispatch'); sent = 'sent'; } catch (e) { sent = e.code; }",
    "process.stdout.write(JSON.stringify({ pid: process.pid, token: r.token, state: r.state, sent }));",
  ].join('\n');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = spawnSync(process.execPath, ['-e', child, path.join(__dirname, '..', 'lib', 'managed-bindings.js'), dir, ENV, JSON.stringify(activation(token, 'W/"3"'))], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(out.status, 0, out.stderr);
  const seen = JSON.parse(out.stdout);
  assert.notEqual(seen.pid, process.pid);
  assert.deepEqual([seen.token, seen.state, seen.sent], [state.token, 'fulfilled', CODES.notSettled]);
  assert.deepEqual(effectsOf(), before, 'the other process recorded and sent nothing');

  // Its commit, in a later run, settles the attempt with the fact and leaves no effect behind.
  commitRule(open(dir), token);
  assert.deepEqual(open(dir).snapshot().envelope.workflowEffects, []);
});

test('a row already in the wanted state before any change was recorded is recorded fulfilled in one write, never as a change to send', () => {
  const dir = makeTempDir('mb-moot-active-');
  const store = open(dir);
  const token = createdRule(store);
  const before = fileText(store);
  for (const [why, effect, seen, code] of [
    ['a body', { effect: 'body', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: null, desiredSha256: H('9') }, SEEN_ACTIVE, CODES.notSettled],
    ['a read of another state', {}, { ...SEEN_ACTIVE, observedState: 'Draft' }, CODES.notSettled],
    ['a read with no row version', {}, { observedState: 'Active' }, CODES.notSettled],
    ['another row', { rowId: BPF }, SEEN_ACTIVE, CODES.notSettled],
    ['an attempt that is not pending', { attemptToken: 'no-such-attempt' }, SEEN_ACTIVE, CODES.conflict],
  ]) assert.equal(codeOf(() => store.recordFulfilledEffect(activation(token, 'W/"2"', effect), seen)), code, why);
  // A write that fails records nothing: the row's state is read again by the next run, and nothing is left to send.
  const failing = open(dir, { deps: { writeFileAtomic: () => { throw new Error('injected write failure'); } } });
  assert.equal(codeOf(() => failing.recordFulfilledEffect(activation(token, 'W/"2"'), SEEN_ACTIVE)), CODES.writeFailed);
  assert.equal(fileText(store), before, 'a refusal or a failed write leaves no record');

  const fulfilled = store.recordFulfilledEffect(activation(token, 'W/"2"'), SEEN_ACTIVE);
  assert.deepEqual([fulfilled.state, fulfilled.dispatchToken, fulfilled.observedState, fulfilled.observedVersion], ['fulfilled', null, 'Active', 'W/"2"']);
  assert.equal(store.recordFulfilledEffect(activation(token, 'W/"2"'), SEEN_ACTIVE).token, fulfilled.token, 'the same fact answers the same record');
  // The maker deactivates (version 3): a later proposal answers the fulfilled record.
  assert.equal(open(dir).recordWorkflowEffect(activation(token, 'W/"3"')).token, fulfilled.token);
  assert.equal(JSON.parse(fileText(store)).workflowEffects.filter((e) => e.effect === 'state').length, 1);
  commitRule(store, token);

  // The same change still unsent is fulfilled in place; one that may have been sent is not.
  const unsent = open(makeTempDir('mb-moot-inplace-'));
  const t2 = createdRule(unsent);
  const recorded = unsent.recordWorkflowEffect(activation(t2, 'W/"1"'));
  assert.equal(unsent.recordFulfilledEffect(activation(t2, 'W/"2"'), SEEN_ACTIVE).token, recorded.token);
  const sent = open(makeTempDir('mb-moot-sentrec-'));
  const t3 = createdRule(sent);
  sent.markEffectDispatching(sent.recordWorkflowEffect(activation(t3, 'W/"1"')).token, 'dispatch-state');
  assert.equal(codeOf(() => sent.recordFulfilledEffect(activation(t3, 'W/"2"'), SEEN_ACTIVE)), CODES.pending);
});

test('finding a change fulfilled is one lease-held write: a failure leaves it unsent, a dispatch since the read is never overwritten, and the fact fences a later dispatch', () => {
  const dir = makeTempDir('mb-moot-crash-');
  const store = open(dir);
  const token = createdRule(store);
  const state = store.recordWorkflowEffect(activation(token, 'W/"2"'));
  const before = fileText(store);
  const failing = open(dir, { deps: { writeFileAtomic: () => { throw new Error('injected write failure'); } } });
  assert.equal(codeOf(() => failing.fulfillEffect(state.token, SEEN_ACTIVE)), CODES.writeFailed);
  assert.equal(fileText(store), before, 'the unsent effect, unchanged');

  // Two handles: one dispatched the change after the other read; the other cannot find it fulfilled.
  const other = open(dir);
  store.markEffectDispatching(state.token, 'dispatch-state');
  assert.equal(codeOf(() => other.fulfillEffect(state.token, SEEN_ACTIVE)), CODES.notSettled);
  assert.equal(open(dir).readGroup('rule', 'account/hide').effects.find((e) => e.token === state.token).state, 'dispatching');

  // And the other way round: once fulfilled, a handle opened before cannot send it.
  const dir2 = makeTempDir('mb-moot-fence-');
  const first = open(dir2);
  const t2 = createdRule(first);
  const s2 = first.recordWorkflowEffect(activation(t2, 'W/"2"'));
  const stale = open(dir2);
  first.fulfillEffect(s2.token, SEEN_ACTIVE);
  assert.equal(codeOf(() => stale.markEffectDispatching(s2.token, 'dispatch-state')), CODES.notSettled);
  assert.equal(open(dir2).readGroup('rule', 'account/hide').effects.find((e) => e.token === s2.token).state, 'fulfilled');

  // A fulfilled record that says anything else is not one: the group is unreadable rather than trusted.
  const good = fileText(first);
  for (const [why, change] of [
    ['a dispatch token', (e) => { e.dispatchToken = 'd'; }],
    ['a body', (e) => Object.assign(e, { effect: 'body', desiredState: null, desiredSha256: H('9') })],
    ['another state', (e) => { e.observedState = 'Draft'; }],
    ['no row version', (e) => { e.observedVersion = ''; }],
    ['a read on an unsent record', (e) => { e.state = 'definitely-unsent'; }],
  ]) {
    writeRaw(first, (d) => change(d.workflowEffects.find((e) => e.token === s2.token)));
    assert.equal(codeOf(() => open(dir2).readGroup('rule', 'account/hide')), CODES.groupInvalid, why);
    fs.writeFileSync(first.file, good);
  }
});

test('an interruption before the replace keeps the attempt and its whole effect set; after it, no retired owner is left', () => {
  const dir = makeTempDir('mb-retire-crash-');
  const store = open(dir);
  const { token, create, state } = settleRule(store, 'account/hide', RULE, { confirm: false });
  for (const [e, proof] of [[create, { observedSha256: H('7') }], [state, { observedState: 'Active' }]]) { store.markEffectDispatching(e.token, `d-${e.effect}`); store.confirmEffect(e.token, proof); }
  store.noteSaved(token, { proof: null, acknowledgedRoot: true });
  const before = fileText(store);
  const args = { token, baseGeneration: null, records: [rec('business-rule', 'account/hide', RULE)], proof: PROOF, consumerState: { declaration: {}, slots: ['clause_a'] }, publication: null };
  const crashing = open(dir, { deps: { writeFileAtomic: () => { throw new Error('crash before the replace'); } } });
  assert.equal(codeOf(() => crashing.commitGroup(args)), CODES.writeFailed);
  assert.equal(fileText(store), before, 'the old image: the attempt and both effects, unchanged');
  assert.equal(JSON.parse(before).workflowEffects.length, 2);

  open(dir).commitGroup(args);
  const after = JSON.parse(fileText(store));
  assert.equal(after.groups.length, 1);
  assert.deepEqual(after.attempts, []);
  assert.ok(!after.workflowEffects.some((e) => e.attemptToken === token), 'no effect names the retired attempt');
});

test('an unconfirmed effect refuses its attempt\'s commit and stays intact, and another attempt\'s effects are untouched', () => {
  const dir = makeTempDir('mb-retire-refuse-');
  const store = open(dir);
  const a = settleRule(store, 'account/hide', RULE, { confirm: false });
  const b = settleRule(store, 'contact/lock', '55555555-5555-4555-8555-555555555555', { confirm: false });
  store.markEffectDispatching(a.create.token, 'd-a');
  store.noteEffectOutcome(a.create.token, 'unconfirmed');
  store.markEffectDispatching(b.state.token, 'd-b');
  store.noteSaved(a.token, { proof: null, acknowledgedRoot: true });
  const before = fileText(store);
  const args = { token: a.token, baseGeneration: null, records: [rec('business-rule', 'account/hide', RULE)], proof: PROOF, consumerState: { declaration: {}, slots: [] }, publication: null };
  assert.equal(codeOf(() => store.commitGroup(args)), CODES.pending);
  assert.equal(fileText(store), before, 'the refused commit writes nothing');

  // Confirm A's effects and commit it: B's attempt and effects stay exactly as they were.
  store.confirmEffect(a.create.token, { observedSha256: H('7') });
  store.markEffectDispatching(a.state.token, 'd-a2');
  store.confirmEffect(a.state.token, { observedState: 'Active' });
  const bBefore = JSON.parse(fileText(store));
  store.commitGroup(args);
  const after = JSON.parse(fileText(store));
  assert.deepEqual(after.attempts, bBefore.attempts.filter((x) => x.token === b.token));
  assert.deepEqual(after.workflowEffects, bBefore.workflowEffects.filter((e) => e.attemptToken === b.token));
});

test('a workflow effect must name a pending attempt and its generation; a create carries no version and an existing-row edit must', () => {
  const dir = makeTempDir('mb-owner-');
  const store = open(dir);
  const committed = settleRule(store, 'account/hide', RULE);
  const token = store.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: committed.generation, root: committed.root, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(RULE, [], 'rule-v1'));
  const base = { attemptToken: token, family: 'rule', key: 'account/hide', rowId: RULE, effect: 'body', request: { method: 'POST', shape: 'rule-update' }, desiredSha256: H('9'), expectedVersion: 'W/"7"' };
  const before = fileText(store);
  assert.equal(codeOf(() => store.recordWorkflowEffect({ ...base, baseGeneration: null })), CODES.conflict, 'another generation');
  assert.equal(codeOf(() => store.recordWorkflowEffect({ ...base, baseGeneration: committed.generation, attemptToken: 'no-such-attempt' })), CODES.conflict, 'a dangling owner');
  assert.equal(codeOf(() => store.recordWorkflowEffect({ ...base, baseGeneration: committed.generation, expectedVersion: null })), CODES.groupInvalid, 'an existing-row edit without its version');
  assert.equal(fileText(store), before);
  const ok = store.recordWorkflowEffect({ ...base, baseGeneration: committed.generation });
  const good = fileText(store);

  writeRaw(store, (d) => { d.workflowEffects[0].attemptToken = 'gone'; });
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'a dangling owner on disk');
  fs.writeFileSync(store.file, good);
  writeRaw(store, (d) => { d.workflowEffects[0].baseGeneration = 'another-generation'; });
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'a generation that is not its attempt\'s');
  fs.writeFileSync(store.file, good);
  writeRaw(store, (d) => { d.workflowEffects.push({ ...d.workflowEffects[0] }); });
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'a repeated effect token');
  fs.writeFileSync(store.file, good);
  writeRaw(store, (d) => { Object.assign(d.workflowEffects[0], { effect: 'create', request: { method: 'POST', shape: 'rule-create' } }); });
  assert.equal(codeOf(() => open(dir).readGroup('rule', 'account/hide')), CODES.groupInvalid, 'a create with a version');
  fs.writeFileSync(store.file, good);
  writeRaw(store, (d) => { d.attempts.push({ ...d.attempts[0], token: 'second' }); });
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'two attempts for one group');
  fs.writeFileSync(store.file, good);
  assert.equal(open(dir).readGroup('rule', 'account/hide').effects[0].token, ok.token);
});

test('classification: settled installs nothing, owed debt is eligible with no hold, a pending attempt holds, uncertain and corrupt are quarantined', () => {
  const ctx = (dir, barrier) => openManagedContext({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier });

  const settledDir = makeTempDir('mb-cls-settled-');
  settleForm(open(settledDir), [['name', CTRL_A]], { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
  const file = path.join(settledDir, fs.readdirSync(settledDir).find((n) => n.startsWith('managed-bindings.')));
  const stamp = [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs];
  const barrier = createPublicationBarrier();
  const c = ctx(settledDir, barrier);
  assert.deepEqual(c.debt, []);
  assert.equal(barrier.active, false, 'a confirmed-only store blocks nothing');
  assert.deepEqual([fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs], stamp, 'and writes nothing');

  const owedDir = makeTempDir('mb-cls-owed-');
  settleForm(open(owedDir), [['name', CTRL_A]]);
  const b2 = createPublicationBarrier();
  assert.deepEqual(ctx(owedDir, b2).debt.map((d) => d.kind), ['eligible']);
  assert.equal(b2.active, false, 'eligible debt gets no hold nothing could release');

  const pendingDir = makeTempDir('mb-cls-pending-');
  const p = open(pendingDir);
  const g = settleForm(p, [['name', CTRL_A]]);
  const token = p.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: g.generation, root: g.root, knownScopes: [TABLE], declarationSha256: H('e') });
  const b3 = createPublicationBarrier();
  const d3 = ctx(pendingDir, b3).debt;
  assert.deepEqual(d3.map((d) => [d.kind, d.token]), [['hold', token]]);
  assert.equal(b3.blocks('account'), true);
  b3.release(token);
  assert.equal(b3.blocks('account'), false, 'the hold is the attempt\'s own, released by its token only');

  const uncertainDir = makeTempDir('mb-cls-uncertain-');
  const u = open(uncertainDir);
  settleForm(u, [['name', CTRL_A]]);
  u.markPublishDispatch({ groups: [{ family: 'form', key: FORM_KEY }], scope: TABLE, token: 'pub-1' });
  const b4 = createPublicationBarrier();
  assert.deepEqual(ctx(uncertainDir, b4).debt.map((d) => d.kind), ['uncertain']);
  b4.release('pub-1');
  assert.equal(b4.blocks('account'), true, 'an uncertain publish is withheld for the whole run');

  const corruptDir = makeTempDir('mb-cls-corrupt-');
  const k = open(corruptDir);
  settleForm(k, [['name', CTRL_A]]);
  writeRaw(k, (d) => { d.groups[0].consumerState.declaration = '<form><tabs/></form>'; });
  const b5 = createPublicationBarrier();
  assert.deepEqual(ctx(corruptDir, b5).debt.map((d) => d.kind), ['corrupt']);
  assert.equal(b5.blocks('account'), true);
  assert.equal(classifyPersisted({ family: 'form', key: FORM_KEY, group: null, attempt: null, effects: [], invalid: null }).kind, 'settled');

  fs.writeFileSync(k.file, '{');
  assert.equal(codeOf(() => ctx(corruptDir, createPublicationBarrier())), CODES.unreadable);
});

test('a commit that repeats a record, or carries an incomplete proof, is refused before it writes; distinct children still commit', () => {
  const dir = makeTempDir('mb-proposal-');
  const store = open(dir);
  const token = store.prepareAttempt({
    family: 'form', key: FORM_KEY, baseGeneration: null, root: { kind: 'form', key: FORM_KEY, id: FORM },
    knownScopes: [TABLE], declarationSha256: H('e'), publication: { scope: TABLE, state: 'owed' },
  });
  store.markSending(token, expected(FORM, [child('name', CTRL_A), child('phone', CTRL_B)]));
  store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  const before = fileText(store);
  const args = (records, proof = PROOF) => ({ token, baseGeneration: null, records, proof, consumerState: formState(), publication: owedTable() });
  const root = rec('form', FORM_KEY, FORM);
  const ctl = (key, id) => rec('control', key, id, { parentKey: FORM_KEY });
  // One key twice with two ids: a map would keep the last one and bind it silently.
  assert.equal(codeOf(() => store.commitGroup(args([root, ctl('name', SUBSTITUTE), ctl('name', CTRL_A), ctl('phone', CTRL_B)]))), CODES.groupInvalid, 'a repeated (kind, key)');
  assert.equal(codeOf(() => store.commitGroup(args([root, ctl('name', CTRL_A), ctl('phone', CTRL_B), ctl('fax', CTRL_A)]))), CODES.groupInvalid, 'a repeated id');
  assert.equal(codeOf(() => store.commitGroup(args([root, ctl('name', CTRL_A), ctl('phone', CTRL_B)], {}))), CODES.groupInvalid, 'an empty proof');
  assert.equal(codeOf(() => store.commitGroup(args([root, ctl('name', CTRL_A), ctl('phone', CTRL_B)], { ...PROOF, semanticSha256: null }))), CODES.groupInvalid, 'a proof without its semantic hash');
  const { expectedChildrenSha256, ...partial } = PROOF;
  assert.ok(expectedChildrenSha256);
  assert.equal(codeOf(() => store.commitGroup(args([root, ctl('name', CTRL_A), ctl('phone', CTRL_B)], partial))), CODES.groupInvalid, 'a proof that omits a field');
  // A child the expected proof never named is not bound by an observation.
  assert.equal(codeOf(() => store.commitGroup(args([root, ctl('name', CTRL_A), ctl('phone', CTRL_B), ctl('fax', SUBSTITUTE)]))), CODES.completion, 'an unplanned child');
  assert.equal(fileText(store), before, 'every refusal leaves the file byte for byte');

  const g = store.commitGroup(args([root, ctl('name', CTRL_A), ctl('phone', CTRL_B)], { ...PROOF, expectedChildrenSha256: null }));
  assert.deepEqual(g.records.map((r) => [r.key, r.id]), [[FORM_KEY, FORM], ['name', CTRL_A], ['phone', CTRL_B]]);

  // A proof edited on disk to lose its fields makes the group unusable on reopen.
  writeRaw(store, (d) => { d.groups[0].proof = {}; });
  assert.equal(open(dir).snapshot().invalidGroups.size, 1);
  assert.equal(codeOf(() => open(dir).readGroup('form', FORM_KEY)), CODES.groupInvalid);
});

test('a business rule\'s root is a business-rule binding: it prepares, commits and reopens; any other family-to-root pairing is refused', () => {
  const dir = makeTempDir('mb-rule-kind-');
  const store = open(dir);
  const g = settleRule(store, 'account/hide', RULE);
  assert.deepEqual(g.root, { kind: 'business-rule', key: 'account/hide', id: RULE });
  assert.equal(open(dir).readGroup('rule', 'account/hide').committed.records[0].kind, 'business-rule');
  const before = fileText(store);
  const prepare = (family, kind, id) => codeOf(() => store.prepareAttempt({ family, key: `${family}/x`, baseGeneration: null, root: { kind, key: `${family}/x`, id }, knownScopes: [], declarationSha256: H('e') }));
  assert.equal(prepare('rule', 'rule', '66666666-6666-4666-8666-666666666666'), CODES.groupInvalid, 'a rule root spelled as its family');
  assert.equal(prepare('form', 'business-rule', '77777777-7777-4777-8777-777777777777'), CODES.groupInvalid, 'a form with a rule root');
  assert.equal(prepare('bpf', 'business-rule', '88888888-8888-4888-8888-888888888888'), CODES.groupInvalid, 'a process flow with a rule root');
  assert.equal(fileText(store), before);
});

test('a workflow effect changes its own attempt\'s root row only, when recorded and when read back from disk', () => {
  const dir = makeTempDir('mb-effect-row-');
  const store = open(dir);
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const token = store.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: null, root: { kind: 'business-rule', key: 'account/hide', id: RULE }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(RULE, [], 'rule-v1'));
  const before = fileText(store);
  const effect = { attemptToken: token, baseGeneration: null, family: 'rule', key: 'account/hide', effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active' };
  assert.equal(codeOf(() => store.recordWorkflowEffect({ ...effect, rowId: OTHER })), CODES.notSettled, 'an effect on another workflow row');
  assert.equal(fileText(store), before, 'nothing was recorded');
  store.recordWorkflowEffect({ ...effect, rowId: RULE });
  writeRaw(store, (d) => { d.workflowEffects[0].rowId = OTHER; });
  assert.equal(codeOf(() => open(dir)), CODES.unreadable, 'an effect on disk that names another row than its attempt\'s root');
});

// A prepared attempt — persisted before markSending, so nothing of it was sent.
function prepareForm(store, { publication = { scope: TABLE, state: 'owed' } } = {}) {
  const { committed } = store.readGroup('form', FORM_KEY);
  const base = committed ? committed.generation : null;
  const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: base, root: { kind: 'form', key: FORM_KEY, id: FORM }, knownScopes: [TABLE], declarationSha256: H('e'), publication });
  return { token, base };
}

test('retireUnsentAttempt removes a prepared attempt and its unsent effects in one write, then ends only its own hold', () => {
  const dir = makeTempDir('mb-retire-unsent-');
  const barrier = createPublicationBarrier();
  const store = open(dir, { barrier });
  const committed = settleForm(store, [['name', CTRL_A]]);
  const { token, base } = prepareForm(store);
  barrier.hold(token, [TABLE], [FORM], 'form main');
  barrier.quarantine([{ type: 'table', table: 'contact' }], [], 'another form');
  const before = fileText(store);
  assert.equal(codeOf(() => store.retireUnsentAttempt({ token, baseGeneration: 'another' })), CODES.conflict);
  assert.equal(codeOf(() => store.retireUnsentAttempt({ token })), CODES.notSettled, 'the base is required');
  const failing = open(dir, { barrier, deps: { writeFileAtomic: () => { throw new Error('disk full'); } } });
  assert.equal(codeOf(() => failing.retireUnsentAttempt({ token, baseGeneration: base })), CODES.writeFailed);
  assert.equal(fileText(store), before, 'refused and failed retires write nothing');
  assert.equal(barrier.allowScope(TABLE, 'a sibling'), false, 'and keep the hold');

  assert.deepEqual(store.retireUnsentAttempt({ token, baseGeneration: base }), { retired: true, effects: 0 });
  const after = open(dir).readGroup('form', FORM_KEY);
  assert.equal(after.pending, null);
  assert.deepEqual(after.committed, committed, 'the committed group and its debt stay');
  assert.equal(barrier.allowScope(TABLE, 'a sibling'), true, 'its own hold ended');
  assert.equal(barrier.allowScope({ type: 'table', table: 'contact' }, 'a sibling'), false, 'a quarantine stays');

  // A rule whose create effect is recorded and still unsent is retired with it.
  const rule = store.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: null, root: { kind: 'business-rule', key: 'account/hide', id: RULE }, knownScopes: [], declarationSha256: H('e') });
  store.recordWorkflowEffect({ attemptToken: rule, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: H('7') });
  assert.deepEqual(store.retireUnsentAttempt({ token: rule, baseGeneration: null }), { retired: true, effects: 1 });
  assert.deepEqual(JSON.parse(fileText(store)).workflowEffects, []);
});

test('retireUnsentAttempt refuses an attempt that may have been sent: marked sending, or an effect that was dispatched', () => {
  const dir = makeTempDir('mb-retire-refused-');
  const store = open(dir);
  const { token, base } = prepareForm(store);
  store.markSending(token, expected(FORM), { observed: true });
  const before = fileText(store);
  assert.equal(codeOf(() => store.retireUnsentAttempt({ token, baseGeneration: base })), CODES.pending, 'sending, even with nothing counted');
  assert.equal(fileText(store), before);

  const rule = store.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: null, root: { kind: 'business-rule', key: 'account/hide', id: RULE }, knownScopes: [], declarationSha256: H('e') });
  const e = store.recordWorkflowEffect({ attemptToken: rule, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: H('7') });
  store.markEffectDispatching(e.token, 'dispatch-create');
  assert.equal(codeOf(() => store.retireUnsentAttempt({ token: rule, baseGeneration: null })), CODES.pending);
  assert.equal(open(dir).readGroup('rule', 'account/hide').pending.token, rule);
});

test('the same unsent workflow effect asked for again is the same record; a different one, or one that may have started, is refused', () => {
  const dir = makeTempDir('mb-effect-reuse-');
  const store = open(dir);
  const token = store.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: null, root: { kind: 'business-rule', key: 'account/hide', id: RULE }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(RULE, [], 'rule-v1'));
  const state = { attemptToken: token, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active' };
  const first = store.recordWorkflowEffect(state);
  assert.equal(store.recordWorkflowEffect(state).token, first.token, 'a continued attempt sends the record it has');
  assert.equal(codeOf(() => store.recordWorkflowEffect({ ...state, desiredState: 'Draft' })), CODES.pending);
  store.markEffectDispatching(first.token, 'dispatch-state');
  assert.equal(codeOf(() => store.recordWorkflowEffect(state)), CODES.pending, 'a dispatched effect is never asked for again');
  assert.equal(JSON.parse(fileText(store)).workflowEffects.length, 1);
});

test('a send window is armed only by the write that marks a prepared attempt sending under an observer, and only counts', () => {
  const dir = makeTempDir('mb-send-window-');
  const store = open(dir);
  const { token } = prepareForm(store);
  assert.equal(codeOf(() => store.noteAttemptDispatch('no-such-attempt')), CODES.conflict);
  store.markSending(token, expected(FORM), { observed: true });
  assert.deepEqual(store.readGroup('form', FORM_KEY).pending.sendWindow, { possible: 0, notStarted: 0, epoch: 1 });
  assert.equal(codeOf(() => store.noteAttemptNotStarted(token)), CODES.notSettled, 'nothing counted to answer');
  store.noteAttemptDispatch(token);
  store.noteAttemptDispatch(token);
  store.noteAttemptNotStarted(token);
  store.markSending(token, expected(FORM), { observed: true });
  assert.deepEqual(open(dir).readGroup('form', FORM_KEY).pending.sendWindow, { possible: 1, notStarted: 1, epoch: 1 }, 'kept on disk; marking again changes nothing');

  // An attempt sent without an observer never gets a window, so nothing can later show it unsent.
  const other = makeTempDir('mb-send-window-plain-');
  const plain = open(other);
  const p = prepareForm(plain);
  plain.markSending(p.token, expected(FORM));
  plain.markSending(p.token, expected(FORM), { observed: true });
  plain.noteAttemptDispatch(p.token);
  assert.equal(plain.readGroup('form', FORM_KEY).pending.sendWindow, undefined);

  const good = fileText(store);
  for (const [label, w] of [['a negative count', { possible: -1, notStarted: 0, epoch: 1 }], ['a fraction', { possible: 0.5, notStarted: 0, epoch: 1 }], ['an extra key', { possible: 0, notStarted: 0, epoch: 1, sent: 1 }], ['no epoch', { possible: 0, notStarted: 0 }], ['epoch zero', { possible: 0, notStarted: 0, epoch: 0 }], ['a fractional epoch', { possible: 0, notStarted: 0, epoch: 1.5 }]]) {
    writeRaw(store, (d) => { d.attempts[0].sendWindow = w; });
    assert.notEqual(codeOf(() => open(dir).readGroup('form', FORM_KEY)), null, label);
    fs.writeFileSync(store.file, good);
  }
  writeRaw(store, (d) => { d.attempts[0].phase = 'prepared'; d.attempts[0].expected = null; });
  assert.notEqual(codeOf(() => open(dir).readGroup('form', FORM_KEY)), null, 'a window on an attempt never marked sending');
});

test('a confirmation judged against an older generation confirms nothing; a late outcome never undoes a confirmation', () => {
  const dir = makeTempDir('mb-confirm-gen-');
  const store = open(dir);
  const g = settleForm(store, [['name', CTRL_A]]);
  store.markPublishDispatch({ groups: [{ family: 'form', key: FORM_KEY }], scope: TABLE, token: 'dispatch-1' });
  const before = fileText(store);
  assert.equal(codeOf(() => store.confirmPublished({ groups: [{ family: 'form', key: FORM_KEY, publishedSha256: H('5'), generation: 'older' }], token: 'dispatch-1' })), CODES.conflict);
  assert.equal(fileText(store), before);
  store.confirmPublished({ groups: [{ family: 'form', key: FORM_KEY, publishedSha256: H('5'), generation: g.generation }], token: 'dispatch-1' });
  store.notePublishOutcome({ token: 'dispatch-1', outcome: 'unconfirmed' });
  store.notePublishOutcome({ token: 'dispatch-1', outcome: 'definite-no-start' });
  const pub = open(dir).readGroup('form', FORM_KEY).committed.publication;
  assert.deepEqual([pub.state, pub.dispatchToken], ['confirmed', 'dispatch-1']);
});

test('a new group whose root create no answer acknowledged is committed only with adoption approved; an acknowledged create needs none', () => {
  const dir = makeTempDir('mb-adopt-');
  const store = open(dir);
  const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: null, root: { kind: 'form', key: FORM_KEY, id: FORM }, knownScopes: [TABLE], declarationSha256: H('e') });
  store.markSending(token, expected(FORM));
  const args = (over = {}) => ({ token, baseGeneration: null, records: [rec('form', FORM_KEY, FORM, { origin: 'adopted' })], proof: PROOF, consumerState: formState(), publication: owedTable(), ...over });
  const before = fileText(store);
  for (const approval of [undefined, false, 'yes', 1]) {
    assert.equal(codeOf(() => store.commitGroup(args({ adoptionApproved: approval }))), CODES.adoptionRequired, String(approval));
  }
  assert.equal(fileText(store), before, 'a refused commit writes nothing');
  assert.equal(open(dir).readGroup('form', FORM_KEY).pending.token, token, 'the attempt stays');
  assert.equal(store.commitGroup(args({ adoptionApproved: true })).records[0].origin, 'adopted');

  const acked = makeTempDir('mb-adopt-acked-');
  assert.equal(settleForm(open(acked), []).records[0].origin, 'created');
});

test('send claim: a claim on an attempt\'s sends is checked under the lease, and a newer claim fences the older one at dispatch', () => {
  const dir = makeTempDir('mb-claim-');
  const store = open(dir);
  const { token } = prepareForm(store);
  assert.equal(codeOf(() => store.markSending(token, expected(FORM), { observed: true, claim: 'later' })), CODES.notSettled);
  assert.deepEqual(store.markSending(token, expected(FORM), { observed: true, claim: 'first' }), { epoch: 1 });
  const marked = fileText(store);
  assert.equal(codeOf(() => store.markSending(token, expected(FORM), { observed: true, claim: 'first' })), CODES.pending, 'a second first send');
  assert.equal(codeOf(() => store.markSending(token, expected(FORM), { observed: false, claim: 'continue' })), CODES.pending, 'a continuation that does not observe its sends');
  assert.equal(fileText(store), marked, 'a refused claim writes nothing');
  // Two runs that read the same zero: each claim moves the window to a new epoch, and the older claimant is refused unsent.
  assert.deepEqual(store.markSending(token, expected(FORM), { observed: true, claim: 'continue' }), { epoch: 2 });
  assert.deepEqual(store.markSending(token, expected(FORM), { observed: true, claim: 'continue' }), { epoch: 3 });
  for (const old of [1, 2]) assert.equal(codeOf(() => store.noteAttemptDispatch(token, old)), CODES.pending, `epoch ${old}`);
  assert.deepEqual(store.readGroup('form', FORM_KEY).pending.sendWindow, { possible: 0, notStarted: 0, epoch: 3 }, 'nothing counted for a refused dispatch');
  store.noteAttemptDispatch(token, 3);
  assert.equal(codeOf(() => store.noteAttemptNotStarted(token, 2)), CODES.pending, 'an answer under an older epoch ends nothing');
  const counted = fileText(store);
  assert.equal(codeOf(() => store.markSending(token, expected(FORM), { observed: true, claim: 'continue' })), CODES.pending, 'a counted send is never continued');
  assert.equal(fileText(store), counted);
  assert.deepEqual(open(dir).readGroup('form', FORM_KEY).pending.sendWindow, { possible: 1, notStarted: 0, epoch: 3 });

  // A resume claim needs a create no answer acknowledged; an edit of a committed group is never one.
  const other = makeTempDir('mb-claim-edit-');
  const edits = open(other);
  settleForm(edits, []);
  const e = prepareForm(edits);
  edits.markSending(e.token, expected(FORM), { observed: true, claim: 'first' });
  assert.equal(codeOf(() => edits.markSending(e.token, expected(FORM), { observed: true, claim: 'resume' })), CODES.pending);
});

test('publication: a new generation is not committed over a publish that may have been sent; once confirmed, it carries its own debt', () => {
  const dir = makeTempDir('mb-uncertain-commit-');
  const store = open(dir);
  const g = settleForm(store, []);
  // The store no longer lets an attempt and an uncertain publish of its group coexist (prepareAttempt and markSending
  // refuse it), so the state a store written by an earlier build may hold is made by hand: the attempt saved, then the
  // publish dispatched with the attempt set aside, then the attempt put back.
  const { token } = prepareForm(store);
  store.markSending(token, expected(FORM));
  store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  coexist(store, () => store.markPublishDispatch({ groups: [{ family: 'form', key: FORM_KEY }], scope: TABLE, token: 'dispatch-old' }));
  const owed = { scope: TABLE, state: 'owed', desiredSha256: H('6'), dispatchToken: null };
  const args = { token, baseGeneration: g.generation, records: [rec('form', FORM_KEY, FORM)], proof: PROOF, consumerState: formState(), publication: owed };
  for (const outcome of [null, 'unconfirmed']) {
    if (outcome) store.notePublishOutcome({ token: 'dispatch-old', outcome });
    const before = fileText(store);
    assert.deepEqual(blockedShape(() => store.commitGroup(args)), blockedBy('dispatch-old'), outcome || 'dispatching');
    assert.equal(fileText(store), before, 'nothing written');
  }
  assert.equal(store.readGroup('form', FORM_KEY).pending.token, token, 'the attempt stays');
  assert.equal(store.readGroup('form', FORM_KEY).committed.generation, g.generation);
  store.confirmPublished({ groups: [{ family: 'form', key: FORM_KEY, publishedSha256: H('5'), generation: g.generation }], token: 'dispatch-old' });
  assert.deepEqual(store.commitGroup(args).publication, owed, 'its own debt, never the old dispatch');
  codeOf(() => store.notePublishOutcome({ token: 'dispatch-old', outcome: 'unconfirmed' }));
  assert.deepEqual(open(dir).readGroup('form', FORM_KEY).committed.publication, owed, 'a late outcome of the old dispatch touches nothing');
});

// Put a publish dispatch beside an attempt the way only an older store could hold them: set the attempts aside, dispatch,
// put them back.
function coexist(store, dispatch) {
  let attempts;
  writeRaw(store, (d) => { attempts = d.attempts; d.attempts = []; });
  store.refresh();
  dispatch();
  writeRaw(store, (d) => { d.attempts = attempts; });
  store.refresh();
}

test('publication: an attempt is neither prepared nor claimed over a publish that may have been sent, whatever the run read before', () => {
  for (const outcome of [null, 'unconfirmed']) {
    const dir = makeTempDir('mb-uncertain-prepare-');
    const store = open(dir);
    settleForm(store, []);
    // A run that read the group before another process dispatched its publish: its read is stale, the lease-held check is not.
    const stale = open(dir);
    open(dir).markPublishDispatch({ groups: [{ family: 'form', key: FORM_KEY }], scope: TABLE, token: 'dispatch-1' });
    if (outcome) open(dir).notePublishOutcome({ token: 'dispatch-1', outcome });
    assert.equal(stale.readGroup('form', FORM_KEY).committed.publication.state, 'owed', 'what the run read');
    const before = fileText(store);
    assert.deepEqual(blockedShape(() => prepareForm(stale)), blockedBy('dispatch-1'), outcome || 'dispatching');
    assert.equal(fileText(store), before, 'nothing prepared');
  }

  // A store that already holds both: no claim of any kind sends under the attempt.
  const dir = makeTempDir('mb-uncertain-claim-');
  const store = open(dir);
  settleForm(store, []);
  const { token } = prepareForm(store);
  coexist(store, () => store.markPublishDispatch({ groups: [{ family: 'form', key: FORM_KEY }], scope: TABLE, token: 'dispatch-2' }));
  const before = fileText(store);
  for (const claim of ['first', undefined]) {
    assert.deepEqual(blockedShape(() => store.markSending(token, expected(FORM), { observed: true, claim })), blockedBy('dispatch-2'), String(claim));
  }
  writeRaw(store, (d) => { d.attempts[0].phase = 'sending'; d.attempts[0].expected = expected(FORM); d.attempts[0].sendWindow = { possible: 0, notStarted: 0, epoch: 1 }; });
  const sending = fileText(store);
  for (const claim of ['continue', 'resume']) {
    assert.deepEqual(blockedShape(() => store.markSending(token, expected(FORM), { observed: true, claim })), blockedBy('dispatch-2'), claim);
  }
  assert.equal(fileText(store), sending, 'a refused claim writes nothing');
  assert.notEqual(before, sending);
  // Once the dispatch is confirmed read-only, the continuation is claimed as before.
  store.refresh();
  store.confirmPublished({ groups: [{ family: 'form', key: FORM_KEY, publishedSha256: H('5'), generation: store.readGroup('form', FORM_KEY).committed.generation }], token: 'dispatch-2' });
  assert.deepEqual(store.markSending(token, expected(FORM), { observed: true, claim: 'continue' }), { epoch: 2 });
});

// A declaration as a maker writes it: names, a description with markup characters and quotes, unicode, a URL.
const DECLARATION = Object.freeze({
  name: 'Main',
  heading: '<b>Sales</b>',
  description: 'Sales <overview> & pipeline — “quarterly” ünïcode; see https://contoso.com/a?b=1&c=2',
  fieldOptions: { name: { required: false, label: 'Account <name>' } },
  iframe: { name: 'News', url: 'https://contoso.crm.dynamics.com/WebResources/new_news.htm?id=1&lang=en' },
  order: [1, 2.5, -3, true, null],
});

function prepareDeclared(store, declaration) {
  const { committed } = store.readGroup('form', FORM_KEY);
  const base = committed ? committed.generation : null;
  const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: base, root: { kind: 'form', key: FORM_KEY, id: FORM }, knownScopes: [TABLE], declarationSha256: H('e'), declaration, publication: { scope: TABLE, state: 'owed' } });
  return { token, base };
}

test('declaration: an attempt keeps its declaration losslessly, and commits it beside the feature\'s own state, never into it', () => {
  const dir = makeTempDir('mb-declaration-');
  const store = open(dir);
  settleForm(store, []);
  const { token, base } = prepareDeclared(store, DECLARATION);
  assert.deepEqual(open(dir).readGroup('form', FORM_KEY).pending.declaration, DECLARATION, 'free text, unicode and URLs survive a reopen');
  store.markSending(token, expected(FORM));
  store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  // What the feature derived and proved — here a declaration slot in another shape, as a flow keeps its applied state
  // and backing there — is committed exactly as given; the original sits beside it.
  const derived = { ...formState(), declaration: { flow: 'derived', applied: H('7'), backing: FORM } };
  const g = store.commitGroup({ token, baseGeneration: base, records: [rec('form', FORM_KEY, FORM)], proof: PROOF, consumerState: derived, publication: owedTable() });
  for (const [label, got] of [['answered', g], ['reopened', open(dir).readGroup('form', FORM_KEY).committed]]) {
    assert.deepEqual(got.consumerState, derived, `${label}: the feature's state is its own`);
    assert.deepEqual(got.originalDeclaration, DECLARATION, `${label}: the original, losslessly`);
  }
  assert.deepEqual(managedManifestView(open(dir).snapshot()).groups[0].originalDeclaration, DECLARATION);

  // A null or rebuilt declaration in the feature's state replaces nothing of the original.
  const next = prepareDeclared(store, DECLARATION);
  store.markSending(next.token, expected(FORM));
  store.noteSaved(next.token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  const h = store.commitGroup({ token: next.token, baseGeneration: next.base, records: [rec('form', FORM_KEY, FORM)], proof: PROOF, consumerState: { ...formState(), declaration: null }, publication: owedTable() });
  assert.deepEqual([h.consumerState.declaration, h.originalDeclaration], [null, DECLARATION]);

  // A generation whose attempt recorded none keeps none: an older original never describes it.
  const plain = prepareForm(store);
  store.markSending(plain.token, expected(FORM));
  store.noteSaved(plain.token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  store.commitGroup({ token: plain.token, baseGeneration: plain.base, records: [rec('form', FORM_KEY, FORM)], proof: PROOF, consumerState: formState(), publication: owedTable() });
  assert.equal(Object.hasOwn(open(dir).readGroup('form', FORM_KEY).committed, 'originalDeclaration'), false);
});

test('declaration: secrets, tokens, a markup document, non-JSON values and oversized declarations are refused before anything is written', () => {
  const dir = makeTempDir('mb-declaration-refused-');
  const store = open(dir);
  settleForm(store, []);
  const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
  let deep = {};
  for (let i = 0; i < 40; i += 1) deep = { d: deep };
  const cases = [
    ['a JWT', { description: `token ${jwt}` }],
    ['a JWT as a key', { [jwt]: 1 }],
    ['a URL with credentials', { url: 'https://maker:hunter2@contoso.com/x' }],
    ['a signed URL', { url: 'https://contoso.blob.core.windows.net/c/x?sv=2020&sig=abcdef' }],
    ['an access token parameter', { url: 'https://contoso.com/x?access_token=abc' }],
    ['a connection string', { note: 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abc==' }],
    ['a private key', { note: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----' }],
    ['a markup document', { formxml: '<form><tabs/></form>' }],
    ['a top-level list', [1, 2]],
    ['no object', 'Main'],
    ['a non-finite number', { n: Infinity }],
    ['undefined', { n: undefined }],
    ['a function', { n: () => 1 }],
    ['a date', { n: new Date(0) }],
    ['too deep', deep],
    ['over the bound', { description: 'x'.repeat(DECLARATION_MAX_BYTES) }],
  ];
  const before = fileText(store);
  for (const [label, declaration] of cases) {
    assert.equal(codeOf(() => prepareDeclared(store, declaration)), CODES.declarationRefused, label);
  }
  assert.equal(codeOf(() => store.prepareAttempt({ family: 'view', key: 'account/active', baseGeneration: null, root: { kind: 'view', key: 'account/active', id: FORM }, knownScopes: [TABLE], declarationSha256: H('e'), declaration: { name: 'Active' } })), CODES.declarationRefused, 'a family whose group keeps no declaration');
  // A token this process obtained, whatever its shape: the atomic writer would redact it, so it is refused before.
  const obtained = 'r7-obtained-token-0123456789abcdef';
  noteToken(obtained);
  assert.equal(codeOf(() => prepareDeclared(store, { description: `x ${obtained} y` })), CODES.declarationRefused, 'an obtained token');
  assert.equal(fileText(store), before, 'nothing was written');
  // Each refusal is answered on the store as written by hand too: the reopened store refuses the group, not the file.
  writeRaw(store, (d) => { d.groups[0].consumerState.declaration = { description: `token ${jwt}` }; });
  assert.equal(codeOf(() => open(dir).readGroup('form', FORM_KEY)), CODES.groupInvalid);
});

test('declaration: a URL is judged by what it means, not how it is spelled; accepted authored text is kept byte for byte', () => {
  const dir = makeTempDir('mb-declaration-urls-');
  const store = open(dir);
  settleForm(store, []);
  const at = '@';
  const refused = [
    ['a user name alone', `https://fixture-user${at}contoso.com/view`],
    ['a user name split by a line break', `https://fixture-\nuser${at}contoso.com/view`],
    ['a user name with no slashes', `https:user${at}contoso.com/view`],
    ['an encoded access token name', 'https://contoso.com/x?%61ccess_token=abc'],
    ['an encoded signature name', 'https://contoso.blob.core.windows.net/c/x?sv=2020&%73ig=abcdef'],
    ['an encoded token in the fragment', 'https://contoso.com/cb#%61ccess_token=abc'],
    ['a name encoded twice', 'https://contoso.com/x?%2561ccess_token=abc'],
    ['a name that does not decode', 'https://contoso.com/x?%E0%A4%A=1'],
    ['an upper-case name', 'https://contoso.com/x?ACCESS_TOKEN=abc'],
    ['an encoded separator in the name', 'https://contoso.com/x?client%5Fsecret=abc'],
  ];
  const before = fileText(store);
  for (const [label, url] of refused) assert.equal(codeOf(() => prepareDeclared(store, { url })), CODES.declarationRefused, label);
  assert.equal(fileText(store), before, 'nothing was written');

  const accepted = [
    `mailto:sales${at}contoso.com`,
    `Contact sales${at}contoso.com for access`,
    'https://contoso.com/x?signal=1&sigma=2&design=3',
    'https://contoso.com/search?q=access_token',
    'https://contoso.com/a%20b?name=%E2%9C%93',
    `https://contoso.com/${at}user/profile`,
    '50% off, 100%25 sure',
  ];
  for (const text of accepted) {
    const { token, base } = prepareDeclared(store, { text });
    assert.equal(open(dir).readGroup('form', FORM_KEY).pending.declaration.text, text, `kept as written: ${text}`);
    store.retireUnsentAttempt({ token, baseGeneration: base });
  }
});

test('declaration: userinfo is recognised by the URL syntax — whitespace, a no-break space or a custom scheme does not hide it; an ambiguous free-text boundary is refused; ordinary text, links and markup are kept', () => {
  const dir = makeTempDir('mb-declaration-userinfo-');
  const store = open(dir);
  settleForm(store, []);
  const at = '@';
  // Every spelling a URL parser reads as userinfo: `new URL(...)` gives each a non-empty username.
  const refused = [
    ['a space in the user name', `https://fixture secret${at}contoso.com/`],
    ['a space in the password', `https://fixture:synthetic secret${at}contoso.com/`],
    ['a no-break space in the user name', `https://fixture\u00a0secret${at}contoso.com/`],
    ['a custom scheme', `custom://fixture secret${at}contoso.com/`],
    ['a space and no path', `https://fixture secret${at}contoso.com`],
    // No `/`, `?` or `#` between the link and a later address: where the URL ends is ambiguous, so it is refused.
    ['an ambiguous boundary', `Visit https://contoso.com or write to sales${at}contoso.com`],
  ];
  for (const [label, url] of refused) assert.ok(new URL(url.replace(/^Visit /, '')).username, `${label}: a URL parser sees a user name`);
  const before = fileText(store);
  for (const [label, url] of refused) assert.equal(codeOf(() => prepareDeclared(store, { url })), CODES.declarationRefused, label);
  assert.equal(fileText(store), before, 'nothing was written');

  const accepted = [
    `<a href="https://contoso.com">Mail sales${at}contoso.com</a>`,
    '<b>Sales</b> and <i>service</i>',
    `See https://contoso.com/ or write to sales${at}contoso.com`,
    `[help](https://contoso.com) or sales${at}contoso.com`,
    `Read 'https://contoso.com' then mail sales${at}contoso.com`,
    `Visit https://contoso.com? Ask sales${at}contoso.com`,
    'Visit https://contoso.com and ping @ the team',
    `https://contoso.com/path with spaces/${at}user`,
  ];
  for (const text of accepted) {
    const { token, base } = prepareDeclared(store, { text });
    assert.equal(open(dir).readGroup('form', FORM_KEY).pending.declaration.text, text, `kept as written: ${text}`);
    store.retireUnsentAttempt({ token, baseGeneration: base });
  }
});

test('declaration: only plain data is kept — hidden, computed and symbol-keyed properties are refused before anything is written', () => {
  const dir = makeTempDir('mb-declaration-data-');
  const store = open(dir);
  settleForm(store, []);
  const hidden = { name: 'Main' };
  Object.defineProperty(hidden, 'toJSON', { value: () => ({ name: 'Swapped' }), enumerable: false });
  let reads = 0;
  const computed = { get name() { reads += 1; return reads === 1 ? 'Main' : 'https://contoso.com/x?access_token=abc'; } };
  const listed = ['a', 'b'];
  listed.extra = 'hidden';
  const before = fileText(store);
  for (const [label, declaration] of [
    ['a hidden toJSON', hidden],
    ['an own toJSON', { name: 'Main', toJSON: () => ({ name: 'Swapped' }) }],
    ['a getter', computed],
    ['a symbol key', { name: 'Main', [Symbol('s')]: 1 }],
    ['an array with an extra property', { order: listed }],
    ['an array of another kind', { order: new Uint8Array(2) }],
  ]) assert.equal(codeOf(() => prepareDeclared(store, declaration)), CODES.declarationRefused, label);
  assert.equal(reads, 0, 'a getter is never called');
  assert.equal(fileText(store), before, 'nothing was written');
  // Plain data with no prototype is still plain data, and is kept as the same values.
  const bare = Object.assign(Object.create(null), { name: 'Main', order: [1, 2] });
  prepareDeclared(store, bare);
  assert.deepEqual(open(dir).readGroup('form', FORM_KEY).pending.declaration, { name: 'Main', order: [1, 2] });
});

test('prepareAttempt `replaces`: a prepared attempt is replaced in the same write that prepares the new one, and only then is its hold ended', () => {
  const dir = makeTempDir('mb-declaration-replace-');
  const barrier = createPublicationBarrier();
  const store = open(dir, { barrier });
  settleForm(store, []);
  const old = prepareDeclared(store, { name: 'Original' });
  store.recordWorkflowEffect({ attemptToken: store.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: null, root: { kind: 'business-rule', key: 'account/hide', id: RULE }, knownScopes: [], declarationSha256: H('e') }), baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: H('7') });
  barrier.hold(old.token, [TABLE], [FORM], 'form main');
  const replace = (declaration, over = {}) => store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: old.base, root: { kind: 'form', key: FORM_KEY, id: FORM }, knownScopes: [TABLE], declarationSha256: H('f'), declaration, publication: { scope: TABLE, state: 'owed' }, replaces: { token: old.token, baseGeneration: old.base }, ...over });
  const before = fileText(store);
  // Refused before anything is written: a declaration the store would not keep, a malformed `replaces`, an attempt of
  // another group, a stale base.
  assert.equal(codeOf(() => replace({ url: 'https://contoso.com/x?%61ccess_token=abc' })), CODES.declarationRefused);
  assert.equal(codeOf(() => replace({ name: 'New' }, { replaces: { token: old.token } })), CODES.notSettled);
  const rule = JSON.parse(fileText(store)).attempts.find((a) => a.family === 'rule').token;
  assert.equal(codeOf(() => replace({ name: 'New' }, { replaces: { token: rule, baseGeneration: null } })), CODES.conflict);
  assert.equal(codeOf(() => replace({ name: 'New' }, { replaces: { token: old.token, baseGeneration: 'another' } })), CODES.conflict);
  assert.equal(fileText(store), before, 'nothing was written');
  assert.equal(barrier.allowScope(TABLE, 'a sibling'), false, 'the hold is kept');

  const token = replace({ name: 'New' });
  const { pending } = open(dir).readGroup('form', FORM_KEY);
  assert.deepEqual([pending.token, pending.declaration], [token, { name: 'New' }], 'the new attempt, alone');
  assert.equal(JSON.parse(fileText(store)).attempts.filter((a) => a.family === 'form').length, 1);
  assert.equal(barrier.allowScope(TABLE, 'a sibling'), true, 'the replaced attempt\'s hold ended');

  // An attempt that may have been sent is never replaced.
  store.markSending(token, expected(FORM));
  const sent = fileText(store);
  assert.equal(codeOf(() => store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: old.base, root: { kind: 'form', key: FORM_KEY, id: FORM }, knownScopes: [TABLE], declarationSha256: H('f'), replaces: { token, baseGeneration: old.base } })), CODES.pending);
  assert.equal(fileText(store), sent);

  // The original declaration written by hand is held to the same rules on read.
  const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
  writeRaw(store, (d) => { d.groups[0].originalDeclaration = { description: `token ${jwt}` }; });
  assert.equal(codeOf(() => open(dir).readGroup('form', FORM_KEY)), CODES.groupInvalid);
});

test('a write larger than the store may be read back is refused before it is written; the store stays readable', () => {
  const dir = makeTempDir('mb-oversize-');
  const store = open(dir);
  settleForm(store, []);
  const { token, base } = prepareForm(store);
  store.markSending(token, expected(FORM));
  store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  const big = 'x'.repeat(1 << 20);
  // Fill the file to half a MiB short of what it may hold: less than a new obligation must leave free.
  const fill = (length) => writeRaw(store, (d) => {
    const g = d.groups[0];
    d.groups = [g, { ...JSON.parse(JSON.stringify(g)), key: 'account/filler', root: { ...g.root, key: 'account/filler', id: SUBSTITUTE }, records: g.records.map((r) => ({ ...r, key: 'account/filler', id: SUBSTITUTE })), consumerState: { ...g.consumerState, declaration: { description: 'x'.repeat(length) } } }];
  });
  fill(0);
  fill(MAX_BYTES - fs.statSync(store.file).size - (1 << 19));
  store.refresh();
  assert.ok(fs.statSync(store.file).size < MAX_BYTES, 'readable');
  assert.ok(MAX_BYTES - fs.statSync(store.file).size < PREPARE_RESERVE_BYTES);
  const before = fileText(store);
  // A commit whose consumer state would take the file past what any open reads back.
  const commit = (description) => store.commitGroup({ token, baseGeneration: base, records: [rec('form', FORM_KEY, FORM)], proof: PROOF, consumerState: { ...formState(), declaration: { description } }, publication: owedTable() });
  assert.equal(codeOf(() => commit(big)), CODES.storeFull);
  assert.equal(fileText(store), before, 'nothing written');
  assert.equal(open(dir).readGroup('form', FORM_KEY).pending.token, token, 'it still opens, the attempt kept');
  // A new attempt must leave the reserve free, so it is refused before it is recorded (and so before it is sent)...
  const rule = () => store.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: null, root: { kind: 'business-rule', key: 'account/hide', id: RULE }, knownScopes: [], declarationSha256: H('e') });
  assert.equal(codeOf(rule), CODES.storeFull);
  assert.equal(fileText(store), before, 'nothing written');
  // ...while the commit of the attempt already sent still fits: the reserve is there for it.
  commit('fits');
  assert.equal(open(dir).readGroup('form', FORM_KEY).pending, null);
});

test('child receipt: a later observation that repeats a receipt in another spelling of the same GUID adds nothing and is not a duplicate, whichever spelling was stored first', () => {
  for (const [first, later] of [[CTRL_A, `{${CTRL_A.toUpperCase()}}`], [`{${CTRL_A.toUpperCase()}}`, CTRL_A]]) {
    const store = open(makeTempDir('mb-receipt-alias-'));
    const base = settleForm(store, [], { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
    const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, root: base.root, baseGeneration: base.generation, declarationSha256: H('a'), knownScopes: [TABLE] });
    store.markSending(token, { ...expected(FORM, [child('account/main/one', CTRL_A), child('account/main/two', CTRL_B)]), baseObservation: { rowVersion: null, savedSha256: H('b') } });
    store.noteSaved(token, { proof: null, acknowledgedChildCreates: [{ kind: 'control', key: 'account/main/one', id: first }] });
    store.noteSaved(token, { proof: null, acknowledgedChildCreates: [{ kind: 'control', key: 'account/main/one', id: later }, { kind: 'control', key: 'account/main/two', id: CTRL_B }] });
    assert.deepEqual(store.readGroup('form', FORM_KEY).pending.acknowledgedChildCreates, [{ kind: 'control', key: 'account/main/one', id: first.toLowerCase() }, { kind: 'control', key: 'account/main/two', id: CTRL_B }], `stored ${first}, repeated as ${later}`);
  }
});

// Each family's largest declaration, with every name, label and description at its longest and in three-byte UTF-8
// text: the documented process-flow ceiling (references/app-spec-schema-advanced.md: 30 stages, 30 steps each), more
// tiles than a dashboard takes, and stated sizing models for forms and rules, which have no published ceiling.
const wideText = (n, i = 0) => `${i}${'完'.repeat(n)}`.slice(0, n);
const key64 = (p, i) => `${p}${i}`.padEnd(64, 'k');
const field64 = (i) => `contoso_field${i}`.padEnd(64, 'x');
const LARGEST = {
  bpf: () => ({ name: wideText(100), entity: field64(0), reconcile: 'declared', status: 'Active', order: 2147483647, description: wideText(2000),
    stages: Array.from({ length: 30 }, (_, i) => ({ key: key64('s', i), name: wideText(100, i), entity: field64(0),
      steps: Array.from({ length: 30 }, (_, j) => ({ key: key64('p', j), name: wideText(100, j), field: field64(i * 30 + j), required: true })) })) }),
  form: () => ({ entity: field64(0), table: field64(0), name: wideText(100), formType: 'Main', reconcile: 'declared', layout: 'explicit', notes: true,
    tabs: Array.from({ length: 25 }, (_, t) => ({ name: key64('tab', t), label: wideText(100, t), expanded: true,
      columns: Array.from({ length: 2 }, (_, c) => ({ width: '50%', sections: Array.from({ length: 5 }, (_, s) => ({ name: key64(`sec${t}_${c}_`, s), label: wideText(100, s), columns: 4,
        fields: Array.from({ length: 4 }, (_, f) => ({ name: field64(((t * 2 + c) * 5 + s) * 4 + f), colspan: 4, readOnly: true, hidden: false })) })) })) })),
    fieldOptions: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [field64(i), { readOnly: true, hidden: false, required: true, after: field64(i + 1) }])),
    subgrids: Array.from({ length: 50 }, (_, i) => ({ childEntity: field64(i), view: wideText(100, i), label: wideText(100, i), tab: key64('tab', i % 25), after: field64(i) })),
    quickViews: Array.from({ length: 50 }, (_, i) => ({ lookup: field64(i), targetEntity: field64(i), form: wideText(100, i), label: wideText(100, i) })),
    events: Array.from({ length: 100 }, (_, i) => ({ event: 'onchange', attribute: field64(i), library: `contoso_/scripts/${'l'.repeat(80)}${i}.js`, function: `Contoso.${'f'.repeat(90)}${i}` })) }),
  dashboard: () => ({ reconcile: 'declared', key: key64('d', 0), name: wideText(100), description: wideText(2000), dashboardId: DASH,
    tiles: Array.from({ length: 30 }, (_, i) => ({ key: key64('t', i), type: 'iframe', name: wideText(100, i), view: wideText(100, i), chart: wideText(100, i), entity: field64(i),
      viewId: DASH, visualizationId: DASH, url: `https://contoso.example/${'p'.repeat(2000)}?tile=${i}`, webResource: `contoso_/${'w'.repeat(90)}${i}.html`,
      componentId: key64('c', i), colspan: 4, rowspan: 12 })) }),
  rule: () => ({ name: wideText(100), entity: field64(0), reconcile: 'declared', key: key64('r', 0), status: 'Active', conditionLogic: 'AND', description: wideText(2000),
    conditions: Array.from({ length: 100 }, (_, i) => ({ key: key64('c', i), field: field64(i), operator: 'Equal', value: wideText(250, i), dataType: 'string' })),
    actions: Array.from({ length: 100 }, (_, i) => (i % 10 === 9
      ? { key: key64('a', i), type: 'Recommendation', field: field64(i), label: wideText(100, i), recommendationTitle: wideText(100, i), messageText: wideText(500, i), acceptanceText: wideText(100, i),
        applyActions: Array.from({ length: 10 }, (_, j) => ({ key: key64(`x${i}_`, j), field: field64(j), value: wideText(250, j), dataType: 'string' })) }
      : { key: key64('a', i), type: 'SetFieldValue', field: field64(i), label: wideText(100, i), value: wideText(250, i), dataType: 'string' })) }),
};
const ROOTS = { form: ['form', FORM], dashboard: ['dashboard', DASH], rule: ['business-rule', RULE], bpf: ['bpf', BPF] };

test('declaration budget: each family\'s largest declaration is kept whole, at least twice inside the bound; views and charts keep none', () => {
  const dir = makeTempDir('mb-declaration-largest-');
  const store = open(dir);
  for (const [family, build] of Object.entries(LARGEST)) {
    const declaration = build();
    const bytes = Buffer.byteLength(canonicalJson(declaration), 'utf8');
    assert.ok(bytes * 2 <= DECLARATION_MAX_BYTES, `${family}: ${bytes} bytes leaves a margin of at least 2`);
    assert.deepEqual(checkDeclaration(family, `account/${family}`, declaration), declaration, family);
    const [kind, id] = ROOTS[family];
    store.prepareAttempt({ family, key: `account/${family}`, baseGeneration: null, root: { kind, key: `account/${family}`, id }, knownScopes: [], declarationSha256: H('e'), declaration });
    assert.deepEqual(open(dir).readGroup(family, `account/${family}`).pending.declaration, declaration, `${family}: kept exactly`);
  }
  // The process flow at the documented ceiling is larger than the earlier bound of 128 KiB, which refused it.
  assert.ok(Buffer.byteLength(canonicalJson(LARGEST.bpf()), 'utf8') > 128 * 1024);
  for (const family of ['view', 'chart']) assert.equal(codeOf(() => checkDeclaration(family, `account/${family}`, { name: 'Active' })), CODES.declarationRefused, `${family}: no declaration`);
});

test('declaration budget: process flows at the documented ceiling, each held three times (original, consumer state, pending attempt), fit the store', () => {
  const dir = makeTempDir('mb-declaration-store-');
  const store = open(dir);
  const flow = LARGEST.bpf();
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    const key = `account/flow${i}`;
    const id = `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`;
    ids.push([key, id]);
    const prepare = (baseGeneration) => store.prepareAttempt({ family: 'bpf', key, baseGeneration, root: { kind: 'bpf', key, id }, knownScopes: [], declarationSha256: H('e'), declaration: flow });
    const token = prepare(null);
    store.markSending(token, expected(id, [], 'bpf-v1'));
    store.noteSaved(token, { proof: null, acknowledgedRoot: true });
    const g = store.commitGroup({ token, baseGeneration: null, records: [rec('bpf', key, id)], proof: PROOF, consumerState: { declaration: { flow, applied: true, backing: null }, stages: {} }, publication: null });
    prepare(g.generation);
  }
  const size = fs.statSync(store.file).size;
  assert.ok(size > 4 * (1 << 20), `${size} bytes: more than the earlier whole-store bound of 4 MiB`);
  assert.ok(size <= MAX_BYTES - PREPARE_RESERVE_BYTES, `${size} bytes, inside the bound with the reserve free`);
  const reopened = open(dir);
  for (const [key] of ids) {
    const { committed, pending } = reopened.readGroup('bpf', key);
    assert.deepEqual([committed.originalDeclaration, committed.consumerState.declaration.flow, pending.declaration], [flow, flow, flow], key);
  }
});

// Completion capacity: twelve process flows at the documented ceiling sent against an almost full store must all be
// able to commit the consumer state that keeps their flow. A free-space check at each admission let all twelve send
// and only seven commit; each attempt now holds its own reservation from prepareAttempt to its commit.
test('completion capacity: every pending attempt holds its own completion bytes; an admission that would leave too little is refused before its send, no other write takes them, and every attempt sent can commit', () => {
  const flow = LARGEST.bpf();
  const bpfKey = (i) => `account/flow${i}`;
  const bpfId = (i) => `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`;
  const prepareBpf = (store, i) => store.prepareAttempt({ family: 'bpf', key: bpfKey(i), root: { kind: 'bpf', key: bpfKey(i), id: bpfId(i) }, baseGeneration: null, knownScopes: [], declarationSha256: H('e'), declaration: flow });
  // Each write here rewrites a file of about 30 MB, so a send is the two writes that grow it: the expected proof and the
  // saved observation.
  const send = (store, i, token) => {
    store.markSending(token, expected(bpfId(i), [], 'bpf-v1'));
    store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  };
  const commitBpf = (store, i, token) => store.commitGroup({ token, baseGeneration: null, records: [rec('bpf', bpfKey(i), bpfId(i))], proof: PROOF, consumerState: { declaration: { flow, applied: true, backing: null }, stages: {} }, publication: null });
  const held = (store) => store.snapshot().envelope.attempts.reduce((n, a) => n + (a.completionReserve ? a.completionReserve.bytes - a.completionReserve.used : 0), 0);
  const padded = (description) => ({ ...formState(), declaration: { ...formState().declaration, description } });
  // A form attempt sent and saved, whose commit adds `description` to its consumer state.
  const sentForm = (store) => {
    const base = store.readGroup('form', FORM_KEY).committed;
    const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, root: base.root, baseGeneration: base.generation, knownScopes: [TABLE], declarationSha256: H('e') });
    store.markSending(token, expected(FORM));
    store.noteSaved(token, { proof: null, acknowledgedRoot: false });
    return (description) => store.commitGroup({ token, baseGeneration: base.generation, records: [rec('form', FORM_KEY, FORM)], proof: PROOF, consumerState: padded(description), publication: base.publication });
  };

  // The order that exposed the gap: twelve prepared, then other content fills the file, then all twelve are sent.
  const a = open(makeTempDir('mb-capacity-first-'));
  settleForm(a, [], { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
  const tokens = Array.from({ length: 12 }, (_, i) => prepareBpf(a, i));
  // The near-limit baseline of the original reproduction (the shared reserve and a quarter MiB left free) reaches into
  // the bytes the twelve hold: it is refused, nothing written, and no reservation is spent. What is left beside the
  // reservations still fits.
  const fill = sentForm(a);
  const reserved = held(a);
  const target = (store, free) => 'x'.repeat(MAX_BYTES - free - fs.statSync(store.file).size - 2048);
  const bytes = fileText(a);
  const refused = codeOf(() => fill(target(a, PREPARE_RESERVE_BYTES + (1 << 18))));
  if (refused !== null) {
    assert.equal(refused, CODES.storeFull);
    assert.equal(fileText(a), bytes, 'nothing written');
    assert.equal(held(a), reserved, 'and no one\'s reservation was spent');
    fill(target(a, reserved + (1 << 18)));
  }
  assert.ok(MAX_BYTES - fs.statSync(a.file).size < PREPARE_RESERVE_BYTES + reserved + (1 << 19), 'the file is almost full');
  tokens.forEach((t, i) => send(a, i, t));
  const commits = tokens.map((t, i) => codeOf(() => commitBpf(a, i, t)));
  assert.deepEqual(commits, tokens.map(() => null), 'every attempt sent commits the consumer state that keeps its flow');
  assert.deepEqual(a.snapshot().envelope.attempts, [], 'all twelve completed');
  assert.deepEqual(open(path.dirname(a.file)).readGroup('bpf', bpfKey(11)).committed.consumerState.declaration.flow, flow);
  assert.equal(refused, CODES.storeFull, 'the baseline that would have taken their bytes was refused');

  // The other order: the file is almost full first. Each admission must leave the shared reserve beyond every
  // reservation, so the attempts that would not fit are refused at prepareAttempt (before anything is sent, nothing
  // written); every one admitted is sent and commits.
  const b = open(makeTempDir('mb-capacity-full-'));
  settleForm(b, [], { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
  prepareBpf(b, 99);
  const each = b.snapshot().envelope.attempts[0].completionReserve.bytes;
  assert.ok(each >= Buffer.byteLength(JSON.stringify({ flow }, null, 2)), `${each} bytes held for a flow's consumer copy`);
  b.retireUnsentAttempt({ token: b.snapshot().envelope.attempts[0].token, baseGeneration: null });
  sentForm(b)(target(b, PREPARE_RESERVE_BYTES + 5 * each));
  const admitted = [];
  let refusedAt = null;
  for (let i = 0; i < 12 && refusedAt === null; i += 1) {
    const before = fileText(b);
    const code = codeOf(() => admitted.push([i, prepareBpf(b, i)]));
    if (code) { assert.equal(code, CODES.storeFull); assert.equal(fileText(b), before, 'refused before it was recorded'); refusedAt = i; }
  }
  assert.ok(refusedAt !== null && admitted.length >= 3 && admitted.length < 12, `${admitted.length} admitted, the next refused`);
  // An admitted attempt's markSending spends its own reservation, so content written since its prepare cannot strand it.
  for (const [i, t] of admitted) send(b, i, t);
  for (const [i, t] of admitted) commitBpf(b, i, t);
  assert.deepEqual(b.snapshot().envelope.attempts, []);

  // A completion that knows it is large says so (completionBytes) and is refused before its send when it cannot fit.
  const c = open(makeTempDir('mb-capacity-declared-'));
  settleForm(c, [], { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
  const t0 = prepareBpf(c, 0);
  const base = c.readGroup('form', FORM_KEY).committed;
  const declare = (completionBytes) => c.prepareAttempt({ family: 'form', key: FORM_KEY, root: base.root, baseGeneration: base.generation, knownScopes: [TABLE], declarationSha256: H('e'), completionBytes });
  assert.equal(codeOf(() => declare(MAX_BYTES)), CODES.notSettled, 'more than one attempt may hold');
  assert.equal(codeOf(() => declare(-1)), CODES.notSettled);
  const big = declare(6 * (1 << 20));
  assert.equal(c.readGroup('form', FORM_KEY).pending.completionReserve.bytes, 6 * (1 << 20));
  // Retiring it releases its own reservation and no other.
  const withBoth = held(c);
  c.retireUnsentAttempt({ token: big, baseGeneration: base.generation });
  assert.equal(held(c), withBoth - 6 * (1 << 20));
  assert.equal(c.readGroup('bpf', bpfKey(0)).pending.token, t0);
  // A reservation written by hand is held to its shape on read.
  writeRaw(c, (d) => { d.attempts[0].completionReserve.used = d.attempts[0].completionReserve.bytes + 1; });
  assert.equal(codeOf(() => open(path.dirname(c.file)).readGroup('bpf', bpfKey(0))), CODES.groupInvalid);

  // An attempt's own writes from its send on spend its own reservation: a large expected proof fits in a file whose
  // only free bytes are the ones that attempt holds, and what it spent is no longer counted as held.
  const d = open(makeTempDir('mb-capacity-spend-'));
  const settledD = settleForm(d, [], { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
  const own = d.prepareAttempt({ family: 'form', key: FORM_KEY, root: settledD.root, baseGeneration: settledD.generation, knownScopes: [TABLE], declarationSha256: H('e'), completionBytes: 2 * (1 << 20) });
  const kids = Array.from({ length: 3000 }, (_, i) => child(`account/main/cell${i}`, `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`));
  const fillD = (length) => writeRaw(d, (x) => {
    const g = x.groups[0];
    x.groups = [g, { ...JSON.parse(JSON.stringify(g)), key: 'account/filler', root: { ...g.root, key: 'account/filler', id: SUBSTITUTE }, records: g.records.map((r) => ({ ...r, key: 'account/filler', id: SUBSTITUTE })), consumerState: { ...g.consumerState, declaration: { description: 'x'.repeat(length) } } }];
  });
  fillD(0);
  fillD(MAX_BYTES - 2 * (1 << 20) - (1 << 16) - fs.statSync(d.file).size);
  d.refresh();
  const proofBytes = Buffer.byteLength(JSON.stringify(expected(FORM, kids), null, 2));
  assert.ok(proofBytes > (1 << 17) && proofBytes < 2 * (1 << 20) - (1 << 18), `a ${proofBytes}-byte proof: more than the free bytes beside the reservation, less than the reservation`);
  d.markSending(own, expected(FORM, kids));
  const spent = d.readGroup('form', FORM_KEY).pending.completionReserve;
  assert.ok(spent.used >= proofBytes && spent.used < spent.bytes, `${spent.used} of ${spent.bytes} spent`);
  d.noteSaved(own, { proof: null, acknowledgedRoot: false });
  assert.equal(d.readGroup('form', FORM_KEY).pending.phase, 'saved');
});

test('completion capacity: an attempt that holds no reservation (prepared by an older build) acquires one under admission before a new send, or is refused before it with nothing changed; every attempt sent commits', () => {
  const flow = LARGEST.bpf();
  const bpfKey = (i) => `account/legacy${i}`;
  const bpfId = (i) => `45454545-4545-4545-8545-${String(i).padStart(12, '0')}`;
  const prepareBpf = (store, i) => store.prepareAttempt({ family: 'bpf', key: bpfKey(i), root: { kind: 'bpf', key: bpfKey(i), id: bpfId(i) }, baseGeneration: null, knownScopes: [], declarationSha256: H('e'), declaration: flow });
  const proofOf = (i) => expected(bpfId(i), [], 'bpf-v1');
  const held = (store) => store.snapshot().envelope.attempts.reduce((n, a) => n + (a.completionReserve ? a.completionReserve.bytes - a.completionReserve.used : 0), 0);
  const unreserved = (store) => writeRaw(store, (x) => { for (const a of x.attempts) delete a.completionReserve; });
  const fillTo = (store, free) => {
    const base = store.readGroup('form', FORM_KEY).committed;
    const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, root: base.root, baseGeneration: base.generation, knownScopes: [TABLE], declarationSha256: H('e') });
    store.markSending(token, expected(FORM));
    store.noteSaved(token, { proof: null, acknowledgedRoot: false });
    const description = 'x'.repeat(MAX_BYTES - free - fs.statSync(store.file).size - 2048);
    store.commitGroup({ token, baseGeneration: base.generation, records: [rec('form', FORM_KEY, FORM)], proof: PROOF, consumerState: { ...formState(), declaration: { ...formState().declaration, description } }, publication: base.publication });
  };
  const notNeeded = { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } };

  // Twelve prepared with no reservation, as an older build left them; then other content fills the file. Each new send
  // must acquire its reservation as an admission (every other reservation and the shared reserve kept free): the ones
  // that fit are sent and all commit, the rest are refused at markSending before anything is sent.
  const a = open(makeTempDir('mb-capacity-legacy-'));
  settleForm(a, [], notNeeded);
  const tokens = Array.from({ length: 12 }, (_, i) => prepareBpf(a, i));
  const each = a.snapshot().envelope.attempts[0].completionReserve.bytes;
  unreserved(a);
  a.refresh();
  assert.equal(held(a), 0);
  fillTo(a, PREPARE_RESERVE_BYTES + 5 * each);
  const sent = [];
  const refused = [];
  tokens.forEach((t, i) => {
    const before = fileText(a);
    const code = codeOf(() => a.markSending(t, proofOf(i), { claim: 'first' }));
    const pending = a.readGroup('bpf', bpfKey(i)).pending;
    if (code === null) {
      assert.equal(pending.completionReserve.bytes, each, 'the send acquired the reservation its declaration needs');
      a.noteSaved(t, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
      sent.push([i, t]);
    } else {
      assert.equal(code, CODES.storeFull);
      assert.equal(fileText(a), before, 'refused before it was recorded');
      assert.equal(pending.phase, 'prepared');
      assert.equal(pending.completionReserve, undefined);
      refused.push([i, t]);
    }
  });
  assert.ok(sent.length >= 1 && sent.length < 12, `${sent.length} sent, ${refused.length} refused before their send`);
  for (const [i, t] of sent) {
    assert.equal(codeOf(() => a.commitGroup({ token: t, baseGeneration: null, records: [rec('bpf', bpfKey(i), bpfId(i))], proof: PROOF, consumerState: { declaration: { flow, applied: true, backing: null }, stages: {} }, publication: null })), null, `attempt ${i} was sent and commits`);
  }
  for (const [, t] of refused) a.retireUnsentAttempt({ token: t, baseGeneration: null });
  assert.deepEqual(a.snapshot().envelope.attempts, []);

  // A continued send (a window proved to have dispatched nothing) is a new send too: with no reservation it acquires one
  // the same way, or is refused with the attempt, its window and the store as they were.
  const continued = (free) => {
    const store = open(makeTempDir('mb-capacity-legacy-continue-'));
    settleForm(store, [], notNeeded);
    const t = prepareBpf(store, 0);
    assert.equal(store.markSending(t, proofOf(0), { observed: true, claim: 'first' }).epoch, 1);
    unreserved(store);
    store.refresh();
    if (free !== null) fillTo(store, free);
    const before = fileText(store);
    return { store, t, before, code: codeOf(() => store.markSending(t, proofOf(0), { observed: true, claim: 'continue' })) };
  };
  const full = continued(PREPARE_RESERVE_BYTES + (each >> 1));
  assert.equal(full.code, CODES.storeFull, 'the acquisition is an admission: the shared reserve stays free beside it');
  assert.equal(fileText(full.store), full.before);
  const kept = full.store.readGroup('bpf', bpfKey(0)).pending;
  assert.equal(kept.phase, 'sending');
  assert.deepEqual(kept.sendWindow, { possible: 0, notStarted: 0, epoch: 1 });
  assert.equal(kept.completionReserve, undefined);
  const roomy = continued(null);
  assert.equal(roomy.code, null);
  const resumed = roomy.store.readGroup('bpf', bpfKey(0)).pending;
  assert.equal(resumed.completionReserve.bytes, each);
  assert.equal(resumed.sendWindow.epoch, 2);
});

test('completion capacity: a reservation smaller than the send\'s estimate is enlarged under admission at markSending, or the send is refused with nothing changed', () => {
  const store = open(makeTempDir('mb-capacity-enlarge-'));
  settleForm(store, [], { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
  const base = store.readGroup('form', FORM_KEY).committed;
  const t = store.prepareAttempt({ family: 'form', key: FORM_KEY, root: base.root, baseGeneration: base.generation, knownScopes: [TABLE], declarationSha256: H('e') });
  assert.equal(store.readGroup('form', FORM_KEY).pending.completionReserve.bytes, COMPLETION_BASE_BYTES);
  const before = fileText(store);
  assert.equal(codeOf(() => store.markSending(t, expected(FORM), { completionBytes: MAX_BYTES })), CODES.notSettled, 'a malformed estimate is refused, not skipped');
  assert.equal(codeOf(() => store.markSending(t, expected(FORM), { completionBytes: 'big' })), CODES.notSettled);
  assert.equal(fileText(store), before);
  store.markSending(t, expected(FORM), { completionBytes: 3 * (1 << 20) });
  assert.deepEqual(store.readGroup('form', FORM_KEY).pending.completionReserve, { bytes: 3 * (1 << 20), used: 0 });
});

test('capacity: a declaration whose calculated minimum exceeds the maximum reservation is refused, not clamped', () => {
  let value = Array(200000).fill('x');
  for (let i = 0; i < 28; i += 1) value = [value];
  const declaration = { nodes: value };
  const text = JSON.stringify(declaration, null, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(declaration)) < DECLARATION_MAX_BYTES, 'within the compact declaration cap');
  assert.ok(COMPLETION_BASE_BYTES + Buffer.byteLength(text) > COMPLETION_MAX_BYTES, 'its indented copy alone is more than the largest reservation');
  const store = open(makeTempDir('mb-capacity-minimum-'));
  const key = 'account/deep';
  let refusal = null;
  try { store.prepareAttempt({ family: 'form', key, root: { kind: 'form', key, id: FORM }, declarationSha256: H('a'), declaration }); } catch (e) { refusal = e; }
  assert.equal(refusal && refusal.code, CODES.storeFull);
  assert.match(refusal.message, /needs at least \d+ bytes/);
  assert.equal(fs.existsSync(store.file), false, 'nothing was written');

  // An attempt an older build prepared with such a declaration (its reservation clamped, or none) is refused at its send.
  const older = open(makeTempDir('mb-capacity-minimum-older-'));
  const small = older.prepareAttempt({ family: 'form', key, root: { kind: 'form', key, id: FORM }, declarationSha256: H('a'), declaration: { nodes: [] } });
  writeRaw(older, (x) => { x.attempts[0].declaration = declaration; x.attempts[0].completionReserve = { bytes: COMPLETION_MAX_BYTES, used: 0 }; });
  older.refresh();
  const before = fileText(older);
  assert.equal(codeOf(() => older.markSending(small, expected(FORM))), CODES.storeFull);
  assert.equal(fileText(older), before);
  assert.equal(older.readGroup('form', key).pending.phase, 'prepared');
});
// A group whose root the service no longer has (the maker deleted it) can never be published, used or proved again;
// without a way to retire it, an owed but never-sent publish blocks every later build. The CALLER proves the root gone
// from a fresh read of every layer (saved and published for a family that publishes; the one row for a workflow); the
// store rechecks, under the lease, that nothing of the group could still land.
const DASH_SCOPE = { type: 'dashboard', id: DASH };
const absent = (rootId, over = {}) => ({ kind: 'root-absent', rootId, saved: 'not-found', published: 'not-found', ...over });
const absentRow = (rootId, over = {}) => ({ kind: 'root-absent', rootId, row: 'not-found', ...over });
// The contract's order: observe the group, then read the root (here: assumed read), then retire against that observation.
const seen = (store, family, key) => store.observeRetirement({ family, key }).observation;
const retireNow = (store, args) => store.retireAbsentGroup({ ...args, observation: seen(store, args.family, args.key) });
function settleDashboard(store, key, { publication = { scope: DASH_SCOPE, state: 'owed', desiredSha256: H('5'), dispatchToken: null } } = {}) {
  const token = store.prepareAttempt({ family: 'dashboard', key, baseGeneration: null, root: { kind: 'dashboard', key, id: DASH }, knownScopes: [DASH_SCOPE], declarationSha256: H('e'), publication: { scope: DASH_SCOPE, state: 'owed' } });
  store.markSending(token, expected(DASH, [], 'dashboard-v1'));
  store.noteSaved(token, { proof: null, acknowledgedRoot: true });
  return store.commitGroup({ token, baseGeneration: null, records: [rec('dashboard', key, DASH)], proof: PROOF, consumerState: { declaration: {}, tiles: {}, seedIds: [] }, publication });
}
const debtOf = (dir) => (discoverManagedStore({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL }).debt || []).map((d) => `${d.family}:${d.key}:${d.kind}`).sort();

test('absent root: a committed group whose root both layers prove gone is retired alone, with an audit entry that pays no debt', () => {
  const dir = makeTempDir('mb-absent-root-');
  const AT = Date.UTC(2025, 0, 2, 3, 4, 5, 678);
  const store = open(dir, { deps: { now: () => AT } });
  settleForm(store, [['name', CTRL_A]]);
  settleRule(store, 'account/hide', RULE);
  const dash = settleDashboard(store, 'sales');
  assert.deepEqual(debtOf(dir), ['dashboard:sales:eligible', 'form:account/main:eligible']);
  const before = JSON.parse(fileText(store));

  // The root id may come in any GUID spelling; the evidence must be about that same row.
  const answer = retireNow(store, { family: 'dashboard', key: 'sales', generation: dash.generation, rootId: `{${DASH.toUpperCase()}}`, evidence: absent(DASH) });
  assert.deepEqual(answer, { retired: { family: 'dashboard', key: 'sales', generation: dash.generation, attempt: null } });
  const after = JSON.parse(fileText(store));
  assert.deepEqual(after.groups, before.groups.filter((g) => g.family !== 'dashboard'), 'every other group, its debt and proof stay exactly');
  assert.deepEqual([after.attempts, after.workflowEffects], [before.attempts, before.workflowEffects]);
  assert.deepEqual(after.retiredGroups, [{ family: 'dashboard', key: 'sales', generation: dash.generation, rootId: DASH, reason: 'root-absent', publication: 'owed', attempt: null, at: '2025-01-02T03:04:05.678Z' }],
    'the entry records an unpaid debt dropped with its root, never a publish');
  assert.equal(open(dir).readGroup('dashboard', 'sales').committed, null);
  assert.deepEqual(debtOf(dir), ['form:account/main:eligible'], 'the sibling form still owes its publish');

  // A settled publication (not-needed, confirmed) and a family that never publishes retire alike.
  const notNeeded = makeTempDir('mb-absent-root-not-needed-');
  const n = settleForm(open(notNeeded), [], { publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
  retireNow(open(notNeeded), { family: 'form', key: FORM_KEY, generation: n.generation, rootId: FORM, evidence: absent(FORM) });
  assert.equal(JSON.parse(fs.readFileSync(open(notNeeded).file, 'utf8')).retiredGroups[0].publication, 'not-needed');
  const confirmedDir = makeTempDir('mb-absent-root-confirmed-');
  const c = open(confirmedDir);
  const cg = settleForm(c, []);
  c.markPublishDispatch({ groups: [{ family: 'form', key: FORM_KEY }], scope: TABLE, token: 'dispatch-1' });
  c.confirmPublished({ groups: [{ family: 'form', key: FORM_KEY, publishedSha256: H('5'), generation: cg.generation }], token: 'dispatch-1' });
  retireNow(c, { family: 'form', key: FORM_KEY, generation: cg.generation, rootId: FORM, evidence: absent(FORM) });
  assert.equal(JSON.parse(fileText(c)).retiredGroups[0].publication, 'confirmed');
  const ruleDir = makeTempDir('mb-absent-root-rule-');
  const r = settleRule(open(ruleDir), 'account/hide', RULE);
  retireNow(open(ruleDir), { family: 'rule', key: 'account/hide', generation: r.generation, rootId: RULE, evidence: absentRow(RULE) });
  assert.deepEqual(JSON.parse(fs.readFileSync(open(ruleDir).file, 'utf8')).retiredGroups.map((x) => [x.publication, x.attempt]), [[null, null]]);
});

test('absent root: a workflow, one layer, is retired on its one row\'s 404: a committed rule or flow, or a create whose activation never left, with its attempt', () => {
  // A committed flow (no attempt, no effect, no publication) whose row was deleted fails every verify: retired alone.
  const dir = makeTempDir('mb-absent-root-bpf-');
  const store = open(dir);
  settleForm(store, []);
  const key = 'account-flow';
  const bt = store.prepareAttempt({ family: 'bpf', key, baseGeneration: null, root: { kind: 'bpf', key, id: BPF }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(bt, expected(BPF, [], 'bpf-v1'));
  store.noteSaved(bt, { proof: null, acknowledgedRoot: true });
  const bg = store.commitGroup({ token: bt, baseGeneration: null, records: [rec('bpf', key, BPF)], proof: PROOF, consumerState: { declaration: {}, stages: {} }, publication: null });
  assert.equal(codeOf(() => retireNow(store, { family: 'bpf', key, generation: bg.generation, rootId: BPF, evidence: absent(BPF) })), CODES.notSettled, 'two layers is not a workflow\'s proof');
  assert.equal(codeOf(() => retireNow(store, { family: 'form', key: FORM_KEY, generation: store.readGroup('form', FORM_KEY).committed.generation, rootId: FORM, evidence: absentRow(FORM) })), CODES.notSettled, 'one row is not a published family\'s proof');
  assert.deepEqual(retireNow(store, { family: 'bpf', key, generation: bg.generation, rootId: BPF, evidence: absentRow(BPF) }), { retired: { family: 'bpf', key, generation: bg.generation, attempt: null } });
  assert.deepEqual(JSON.parse(fileText(store)).groups.map((g) => g.family), ['form'], 'the sibling form stays');

  // A create whose own create a read confirmed and whose activation was answered unapplied (a 412: definitely unsent),
  // then the row was deleted. Its attempt holds every run, and declaring it again can never prove it: the attempt and
  // its group (never committed: generation null) are retired together, and the entry says the row was never activated.
  const AT = Date.UTC(2025, 0, 2, 3, 4, 5, 678);
  const cdir = makeTempDir('mb-absent-root-create-');
  const released = [];
  const cs = open(cdir, { deps: { now: () => AT }, barrier: { release: (t) => released.push(t) } });
  settleForm(cs, [['name', CTRL_A]]);
  const token = createdRule(cs);
  const state = cs.recordWorkflowEffect(activation(token, 'W/"2"'));
  cs.markEffectDispatching(state.token, 'dispatch-state');
  cs.noteEffectOutcome(state.token, 'definite-no-start');
  const before = JSON.parse(fileText(cs));
  const args = { family: 'rule', key: 'account/hide', generation: null, rootId: RULE, evidence: absentRow(RULE), attemptToken: token, observation: seen(cs, 'rule', 'account/hide') };
  for (const [label, over, code] of [
    ['another root, proved absent', { rootId: BPF, evidence: absentRow(BPF) }, CODES.conflict],
    ['a generation for a group never committed', { generation: 'gen-x' }, CODES.conflict],
  ]) {
    const text = fileText(cs);
    assert.equal(codeOf(() => cs.retireAbsentGroup({ ...args, ...over })), code, label);
    assert.equal(fileText(cs), text, `${label}: nothing written`);
  }
  // An attempt the file records on another base than its group is not one the store vouches for: refused, unchanged.
  {
    const odir = makeTempDir('mb-absent-root-base-');
    const os = open(odir);
    const t = createdRule(os);
    writeRaw(os, (d) => { d.attempts[0].baseGeneration = 'gen-x'; });
    const text = fileText(os);
    assert.notEqual(codeOf(() => open(odir).retireAbsentGroup({ ...args, attemptToken: t })), null);
    assert.notEqual(codeOf(() => open(odir).retireAbsentGroup({ ...args, generation: 'gen-x', attemptToken: t })), null);
    assert.notEqual(codeOf(() => open(odir).observeRetirement({ family: 'rule', key: 'account/hide' })), null);
    assert.equal(fileText(os), text);
  }
  assert.equal(codeOf(() => open(cdir, { deps: { writeFileAtomic: () => { throw new Error('crash before the replace'); } }, barrier: { release: (t) => released.push(t) } }).retireAbsentGroup(args)), CODES.writeFailed);
  assert.deepEqual([JSON.parse(fileText(cs)), released], [before, []], 'a failed write keeps the attempt, its effects and its hold');
  assert.deepEqual(cs.retireAbsentGroup(args), { retired: { family: 'rule', key: 'account/hide', generation: null, attempt: token } });
  assert.deepEqual(released, [token], 'only the retired attempt\'s own hold ends, after the write');
  const after = JSON.parse(fileText(cs));
  assert.deepEqual([after.groups, after.attempts, after.workflowEffects], [before.groups, [], []], 'the attempt and the effects it owned are gone; the form stays');
  assert.deepEqual(after.retiredGroups, [{ family: 'rule', key: 'account/hide', generation: null, rootId: RULE, reason: 'root-absent', publication: null,
    attempt: { token, phase: 'saved', effects: [{ effect: 'create', state: 'confirmed' }, { effect: 'state', state: 'definitely-unsent' }] }, at: '2025-01-02T03:04:05.678Z' }],
  'the audit says the row was created and never activated, not that it is live');
  // A run still holding the retired attempt can send nothing more under it: its effect and its attempt are gone.
  const afterText = fileText(cs);
  assert.equal(codeOf(() => cs.markEffectDispatching(state.token, 'dispatch-again')), CODES.notSettled);
  assert.equal(codeOf(() => cs.recordWorkflowEffect(activation(token, 'W/"2"'))), CODES.conflict);
  assert.equal(fileText(cs), afterText);
  assert.deepEqual(open(cdir).readGroup('rule', 'account/hide'), { committed: null, pending: null, effects: [] });
});

test('absent root: retirement refuses with nothing written unless the evidence is typed proof of absence in both layers and the group is the one proved', () => {
  const dir = makeTempDir('mb-absent-root-refuse-');
  const store = open(dir);
  const g = settleForm(store, [['name', CTRL_A]]);
  const args = (over = {}) => ({ family: 'form', key: FORM_KEY, generation: g.generation, rootId: FORM, evidence: absent(FORM), observation: seen(store, 'form', FORM_KEY), ...over });
  const { kind, rootId, published } = absent(FORM);
  const before = fileText(store);
  for (const [label, over, code] of [
    ['no evidence', { evidence: undefined }, CODES.notSettled],
    ['evidence that is not an object', { evidence: 'absent' }, CODES.notSettled],
    ['the published layer alone', { evidence: { kind, rootId, published } }, CODES.notSettled],
    ['a saved layer that was found', { evidence: absent(FORM, { saved: 'found' }) }, CODES.notSettled],
    ['a saved layer that was forbidden', { evidence: absent(FORM, { saved: 'forbidden' }) }, CODES.notSettled],
    ['a published layer that timed out', { evidence: absent(FORM, { published: 'timeout' }) }, CODES.notSettled],
    ['another kind of evidence', { evidence: absent(FORM, { kind: 'published-absent' }) }, CODES.notSettled],
    ['an untyped extra field', { evidence: absent(FORM, { status: 404 }) }, CODES.notSettled],
    ['evidence about another row', { evidence: absent(CTRL_A) }, CODES.notSettled],
    ['evidence with no row', { evidence: absent(FORM, { rootId: 'not-a-guid' }) }, CODES.notSettled],
    ['no root id', { rootId: undefined }, CODES.notSettled],
    ['no generation', { generation: undefined }, CODES.notSettled],
    ['a null generation with no attempt named', { generation: null }, CODES.notSettled],
    ['an empty attempt token', { attemptToken: '' }, CODES.notSettled],
    ['the evidence of a workflow\'s one row', { evidence: { kind, rootId, row: 'not-found' } }, CODES.notSettled],
    ['both shapes at once', { evidence: absent(FORM, { row: 'not-found' }) }, CODES.notSettled],
    ['an attempt named where none is pending', { attemptToken: 'attempt-x' }, CODES.conflict],
    ['a null generation for a committed group', { generation: null, attemptToken: 'attempt-x' }, CODES.conflict],
    ['an unknown family', { family: 'widget' }, CODES.notSettled],
    ['a group that does not exist', { key: 'contact/main' }, CODES.notSettled],
    ['the other family on the key', { family: 'dashboard' }, CODES.notSettled],
    ['another generation', { generation: 'older' }, CODES.conflict],
    ['another root, proved absent', { rootId: CTRL_A, evidence: absent(CTRL_A) }, CODES.conflict],
    ['no observation', { observation: undefined }, CODES.notSettled],
    ['an observation that is not one', { observation: 'retirement-v1:xyz' }, CODES.notSettled],
    ['an observation of another state', { observation: `retirement-v1:${'0'.repeat(64)}` }, CODES.conflict],
  ]) {
    assert.equal(codeOf(() => store.retireAbsentGroup(args(over))), code, label);
    assert.equal(fileText(store), before, `${label}: nothing written`);
  }
  assert.equal(codeOf(() => store.retireAbsentGroup()), CODES.notSettled);

  // A group the file cannot vouch for is never retired (an owed publish with a dispatch token is not a valid record).
  writeRaw(store, (d) => { d.groups[0].publication.dispatchToken = 'dispatch-x'; });
  const invalidText = fileText(store);
  assert.equal(codeOf(() => open(dir).retireAbsentGroup(args())), CODES.groupInvalid);
  assert.equal(fileText(store), invalidText);
});

test('absent root: retirement is bound to the group as observed before the root was read; progress on it since refuses, a sibling write does not', () => {
  // The race: the retiring run observes, reads a 404, and meanwhile another run sends the recorded create, confirms it
  // and acknowledges the root. The 404 is then about a row that now exists, so the retirement must not land.
  const AT = Date.UTC(2025, 0, 2, 3, 4, 5, 678);
  const dir = makeTempDir('mb-absent-root-observed-');
  const released = [];
  const a = open(dir, { deps: { now: () => AT }, barrier: { release: (t) => released.push(t) } });
  const b = open(dir);
  const key = 'account/hide';
  const token = a.prepareAttempt({ family: 'rule', key, baseGeneration: null, root: { kind: 'business-rule', key, id: RULE }, knownScopes: [], declarationSha256: H('e') });
  a.markSending(token, expected(RULE, [], 'rule-v1'), { observed: true });
  const create = a.recordWorkflowEffect({ attemptToken: token, baseGeneration: null, family: 'rule', key, rowId: RULE, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: H('7') });
  const args = (observation) => ({ family: 'rule', key, generation: null, rootId: RULE, evidence: absentRow(RULE), attemptToken: token, observation });
  const progress = [
    ['the create is sent', () => b.markEffectDispatching(create.token, 'dispatch-create')],
    ['the create is confirmed', () => b.confirmEffect(create.token, { observedSha256: H('7') })],
    ['the root is acknowledged', () => b.noteSaved(token, { proof: null, acknowledgedRoot: true })],
  ];
  for (const [label, step] of progress) {
    const observation = seen(a, 'rule', key);
    step();
    const text = fileText(a);
    let refusal = null;
    try { a.retireAbsentGroup(args(observation)); } catch (e) { refusal = e; }
    assert.deepEqual([refusal && refusal.code, /observe it again/.test(refusal && refusal.message)], [CODES.conflict, true], label);
    assert.deepEqual([fileText(a), released], [text, []], `${label}: nothing written, no hold released`);
  }
  // A send counted in the attempt's window is progress too, even with no effect recorded for it.
  {
    const wdir = makeTempDir('mb-absent-root-window-');
    const ws = open(wdir);
    const t = ws.prepareAttempt({ family: 'rule', key, baseGeneration: null, root: { kind: 'business-rule', key, id: RULE }, knownScopes: [], declarationSha256: H('e') });
    ws.markSending(t, expected(RULE, [], 'rule-v1'), { observed: true });
    const c2 = ws.recordWorkflowEffect({ attemptToken: t, baseGeneration: null, family: 'rule', key, rowId: RULE, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: H('7') });
    ws.markEffectDispatching(c2.token, 'dispatch-create');
    ws.confirmEffect(c2.token, { observedSha256: H('7') });
    const observation = seen(ws, 'rule', key);
    open(wdir).noteAttemptDispatch(t);
    const text = fileText(ws);
    assert.equal(codeOf(() => ws.retireAbsentGroup({ ...args(observation), attemptToken: t })), CODES.conflict, 'a counted send');
    assert.equal(fileText(ws), text);
  }
  // A write about another group between the observation and the retirement changes nothing about this one.
  const observation = seen(b, 'rule', key);
  settleDashboard(b, 'sales');
  assert.deepEqual(a.retireAbsentGroup(args(observation)), { retired: { family: 'rule', key, generation: null, attempt: token } }, 'one handle\'s observation holds for another');
  assert.deepEqual([released, JSON.parse(fileText(a)).groups.map((g) => g.family)], [[token], ['dashboard']]);
  // Observing writes nothing, and a key with nothing on it has nothing to observe.
  const text = fileText(a);
  assert.match(seen(a, 'dashboard', 'sales'), /^retirement-v1:[0-9a-f]{64}$/);
  assert.equal(codeOf(() => a.observeRetirement({ family: 'rule', key })), CODES.notSettled);
  assert.equal(codeOf(() => a.observeRetirement({ family: 'widget', key })), CODES.notSettled);
  assert.equal(codeOf(() => a.observeRetirement()), CODES.notSettled);
  assert.equal(fileText(a), text);
});

test('absent root: retirement refuses with nothing written while an attempt, a workflow effect or a possibly sent publish could still land', () => {
  // A pending attempt, prepared, sending or saved: it is recovered or retired as an attempt first, never dropped here.
  for (const phase of ['prepared', 'sending', 'saved']) {
    const dir = makeTempDir(`mb-absent-root-${phase}-`);
    const store = open(dir);
    const g = settleForm(store, []);
    const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: g.generation, root: g.root, knownScopes: [TABLE], declarationSha256: H('f') });
    if (phase !== 'prepared') store.markSending(token, expected(FORM));
    if (phase === 'saved') store.noteSaved(token, { proof: { savedSha256: H('1') } });
    const before = fileText(store);
    const args = { family: 'form', key: FORM_KEY, generation: g.generation, rootId: FORM, evidence: absent(FORM) };
    assert.equal(codeOf(() => retireNow(store, args)), CODES.pending, phase);
    assert.equal(fileText(store), before, `${phase}: nothing written`);
    if (phase === 'prepared') {
      // The way out: a provably unsent attempt is retired first; then the group is.
      store.retireUnsentAttempt({ token, baseGeneration: g.generation });
      retireNow(store, args);
      assert.equal(open(dir).readGroup('form', FORM_KEY).committed, null);
    }
  }

  // Named with its token, a pending attempt of a family whose push is not journaled write by write is still refused.
  {
    const dir = makeTempDir('mb-absent-root-form-attempt-');
    const store = open(dir);
    const g = settleForm(store, []);
    const token = store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: g.generation, root: g.root, knownScopes: [TABLE], declarationSha256: H('f') });
    store.markSending(token, expected(FORM));
    const before = fileText(store);
    assert.equal(codeOf(() => retireNow(store, { family: 'form', key: FORM_KEY, generation: g.generation, rootId: FORM, evidence: absent(FORM), attemptToken: token })), CODES.pending);
    assert.equal(fileText(store), before);
  }

  // A workflow attempt on the group: refused unless named, and while any effect it owns may have been sent (dispatching,
  // then unconfirmed). Answered unapplied (definitely unsent, no dispatch token) in a send window that counted nothing
  // possibly applied, the attempt retires with the group.
  const wf = makeTempDir('mb-absent-root-effect-');
  const ws = open(wf);
  const rule = settleRule(ws, 'account/hide', RULE);
  const wt = ws.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: rule.generation, root: rule.root, knownScopes: [], declarationSha256: H('f') });
  ws.markSending(wt, expected(RULE, [], 'rule-v1'), { observed: true });
  const act = ws.recordWorkflowEffect(activation(wt, 'W/"3"', { baseGeneration: rule.generation }));
  const wargs = (over = {}) => ({ family: 'rule', key: 'account/hide', generation: rule.generation, rootId: RULE, evidence: absentRow(RULE), attemptToken: wt, ...over });
  const refused = (over, label) => {
    const wfBefore = fileText(ws);
    let refusal = null;
    try { retireNow(ws, wargs(over)); } catch (e) { refusal = e; }
    assert.equal(fileText(ws), wfBefore, `${label}: nothing written`);
    return [refusal && refusal.code, refusal && refusal.message];
  };
  assert.equal(refused({ attemptToken: undefined }, 'not named')[0], CODES.pending);
  assert.equal(refused({ attemptToken: 'attempt-other' }, 'another attempt')[0], CODES.conflict);
  assert.equal(refused({ generation: 'older' }, 'another generation')[0], CODES.conflict);
  assert.equal(refused({ rootId: CTRL_A, evidence: absentRow(CTRL_A) }, 'another root')[0], CODES.conflict);
  ws.markEffectDispatching(act.token, 'dispatch-act');
  const [dispatching, message] = refused({}, 'dispatching');
  assert.deepEqual([dispatching, /workflow effect/.test(message)], [CODES.pending, true]);
  ws.noteEffectOutcome(act.token, 'unconfirmed');
  assert.equal(refused({}, 'unconfirmed')[0], CODES.pending);
  writeRaw(ws, (d) => { Object.assign(d.workflowEffects.find((e) => e.token === act.token), { state: 'definitely-unsent', dispatchToken: null }); });
  ws.refresh();
  retireNow(ws, wargs());
  const retired = JSON.parse(fileText(ws));
  assert.deepEqual([retired.groups.length, retired.attempts.length, retired.workflowEffects.length, retired.retiredGroups[0].attempt.effects], [0, 0, 0, [{ effect: 'state', state: 'definitely-unsent' }]]);

  // An empty or all-unsent journal is no record that nothing else was sent: an attempt marked sending with no send
  // window, or with one that counted a possibly applied mutation (a create whose answer was lost), and no confirmed
  // create of its own, may still have a write on its way. It stays on its recovery path; a prepared one never left.
  const shapes = [
    ['no send window, no effect', () => {}, {}],
    ['no send window, an unsent activation', (s, t, g) => s.recordWorkflowEffect(activation(t, 'W/"3"', { baseGeneration: g })), {}],
    ['a window that counted a send, no effect', (s, t) => s.noteAttemptDispatch(t), { observed: true }],
    ['a window that counted a send, an unsent activation', (s, t, g) => { s.recordWorkflowEffect(activation(t, 'W/"3"', { baseGeneration: g })); s.noteAttemptDispatch(t); }, { observed: true }],
  ];
  for (const [label, act2, opts] of shapes) {
    const dir = makeTempDir('mb-absent-root-unaccounted-');
    const s = open(dir);
    const r = settleRule(s, 'account/hide', RULE);
    const t = s.prepareAttempt({ family: 'rule', key: 'account/hide', baseGeneration: r.generation, root: r.root, knownScopes: [], declarationSha256: H('f') });
    s.markSending(t, expected(RULE, [], 'rule-v1'), opts);
    act2(s, t, r.generation);
    const text = fileText(s);
    let refusal = null;
    try { retireNow(s, { family: 'rule', key: 'account/hide', generation: r.generation, rootId: RULE, evidence: absentRow(RULE), attemptToken: t }); } catch (e) { refusal = e; }
    assert.deepEqual([refusal && refusal.code, /does not account for/.test(refusal && refusal.message)], [CODES.pending, true], label);
    assert.equal(fileText(s), text, `${label}: nothing written`);
    assert.equal(open(dir).readGroup('rule', 'account/hide').pending.token, t, `${label}: the attempt stays for its recovery`);
  }
  {
    const dir = makeTempDir('mb-absent-root-prepared-');
    const s = open(dir);
    const t = s.prepareAttempt({ family: 'bpf', key: 'account-flow', baseGeneration: null, root: { kind: 'bpf', key: 'account-flow', id: BPF }, knownScopes: [], declarationSha256: H('e') });
    retireNow(s, { family: 'bpf', key: 'account-flow', generation: null, rootId: BPF, evidence: absentRow(BPF), attemptToken: t });
    assert.deepEqual(JSON.parse(fileText(s)).retiredGroups[0].attempt, { token: t, phase: 'prepared', effects: [] }, 'a prepared attempt never left');
  }

  // A publish that may have been sent (dispatching, then unconfirmed): refused with the dispatch's decision as data.
  const pub = makeTempDir('mb-absent-root-publish-');
  const ps = open(pub);
  const pg = settleForm(ps, []);
  const pargs = { family: 'form', key: FORM_KEY, generation: pg.generation, rootId: FORM, evidence: absent(FORM) };
  ps.markPublishDispatch({ groups: [{ family: 'form', key: FORM_KEY }], scope: TABLE, token: 'dispatch-1' });
  let pubBefore = fileText(ps);
  assert.deepEqual(blockedShape(() => retireNow(ps, pargs)), blockedBy('dispatch-1'), 'dispatching');
  assert.equal(fileText(ps), pubBefore);
  ps.notePublishOutcome({ token: 'dispatch-1', outcome: 'unconfirmed' });
  pubBefore = fileText(ps);
  assert.deepEqual(blockedShape(() => retireNow(ps, pargs)), blockedBy('dispatch-1'), 'unconfirmed');
  assert.equal(fileText(ps), pubBefore);
  // The way out of that one is the publish's own: accept its risk (or confirm it); the debt is owed again, then retirable.
  ps.acceptUncertainPublication({ scope: TABLE, dispatchToken: 'dispatch-1', approval: publicationRiskApproval(TABLE, 'dispatch-1') });
  retireNow(ps, pargs);
  const final = JSON.parse(fileText(ps));
  assert.deepEqual([final.groups.length, final.publicationRiskAcceptances.length, final.retiredGroups[0].publication], [0, 1, 'owed']);
});

test('absent root: two processes retiring the same group on one observation make one audit entry and keep the sibling', { timeout: 30000 }, async () => {
  const dir = makeTempDir('mb-absent-root-processes-');
  const store = open(dir);
  settleRule(store, 'account/hide', RULE);
  const g = settleForm(store, []);
  const before = JSON.parse(fileText(store));
  // A worker file in the test's own temp dir: each child opens the store itself, says it is ready, and retires on "go".
  const worker = path.join(makeTempDir('mb-absent-root-worker-'), 'retire-worker.js');
  fs.writeFileSync(worker, `'use strict';
const { openManagedBindings } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'managed-bindings.js'))});
const { context, retirement } = JSON.parse(process.argv[2]);
const store = openManagedBindings(context);
process.send({ ready: true });
process.once('message', () => {
  let result;
  try { result = store.retireAbsentGroup(retirement); } catch (error) { result = { error: error.code }; }
  process.send(result, () => process.disconnect());
});
`);
  const payload = JSON.stringify({ context: { workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL },
    retirement: { family: 'form', key: FORM_KEY, generation: g.generation, rootId: FORM, evidence: absent(FORM), observation: seen(store, 'form', FORM_KEY) } });
  const children = [0, 1].map(() => {
    const child = fork(worker, [payload], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = new Promise((resolve) => child.once('message', resolve));
    const done = new Promise((resolve, reject) => {
      let result;
      child.on('message', (m) => { if (!m.ready) result = m; });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(result) : reject(new Error(stderr))));
    });
    return { child, ready, done };
  });
  await Promise.all(children.map((c) => c.ready));
  children.forEach((c) => c.child.send({ go: true }));
  const results = await Promise.all(children.map((c) => c.done));
  assert.equal(results.filter((r) => r.retired).length, 1, JSON.stringify(results));
  assert.ok(results.some((r) => [CODES.busy, CODES.notSettled].includes(r.error)), JSON.stringify(results));
  const after = JSON.parse(fileText(store));
  assert.deepEqual([after.revision, after.retiredGroups.length, after.groups], [before.revision + 1, 1, before.groups.filter((x) => x.family !== 'form')]);
});

test('absent root: two handles race under the lease, a failed write leaves the bytes, the audit stays bounded, and a build that does not know it refuses the file', () => {
  const dir = makeTempDir('mb-absent-root-race-');
  const a = open(dir);
  const b = open(dir);
  const g = settleForm(a, []);
  const args = { family: 'form', key: FORM_KEY, generation: g.generation, rootId: FORM, evidence: absent(FORM), observation: seen(b, 'form', FORM_KEY) };
  a.retireAbsentGroup(args);
  const once = fileText(a);
  assert.equal(codeOf(() => b.retireAbsentGroup(args)), CODES.notSettled, 'the stale handle rereads under the lease and finds no group');
  assert.equal(fileText(a), once);
  assert.equal(JSON.parse(once).retiredGroups.length, 1);

  const crash = makeTempDir('mb-absent-root-crash-');
  const cg = settleForm(open(crash), []);
  const crashBefore = fs.readFileSync(open(crash).file, 'utf8');
  const failing = open(crash, { deps: { writeFileAtomic: () => { throw new Error('crash before the replace'); } } });
  assert.equal(codeOf(() => retireNow(failing, { ...args, generation: cg.generation })), CODES.writeFailed);
  assert.equal(fs.readFileSync(failing.file, 'utf8'), crashBefore);
  assert.equal(open(crash).readGroup('form', FORM_KEY).committed.generation, cg.generation);

  // Newest last, at most RETIRED_GROUPS_KEPT; anything else in the list makes the file unreadable, unchanged.
  const bound = makeTempDir('mb-absent-root-bound-');
  const bs = open(bound);
  const bg = settleForm(bs, []);
  const old = (i) => ({ family: 'form', key: `old/${i}`, generation: `gen-${i}`, rootId: FORM, reason: 'root-absent', publication: 'owed', attempt: null, at: '2025-01-01T00:00:00.000Z' });
  const wfOld = { ...old(0), family: 'rule', generation: null, publication: null, attempt: { token: 'attempt-1', phase: 'saved', effects: [{ effect: 'create', state: 'confirmed' }] } };
  writeRaw(bs, (d) => { d.retiredGroups = Array.from({ length: RETIRED_GROUPS_KEPT }, (_, i) => old(i)); });
  bs.refresh();
  retireNow(bs, { ...args, generation: bg.generation });
  const kept = JSON.parse(fileText(bs)).retiredGroups;
  assert.deepEqual([kept.length, kept[0].key, kept[kept.length - 1].generation], [RETIRED_GROUPS_KEPT, 'old/1', bg.generation]);
  for (const [label, list] of [
    ['too many', Array.from({ length: RETIRED_GROUPS_KEPT + 1 }, (_, i) => old(i))],
    ['another reason', [{ ...old(0), reason: 'deleted' }]],
    ['a publish that may have been sent', [{ ...old(0), publication: 'unconfirmed' }]],
    ['an untyped field', [{ ...old(0), paid: true }]],
    ['no time', [{ ...old(0), at: 'yesterday' }]],
    ['no attempt key', [(({ attempt, ...rest }) => rest)(old(0))]],
    ['no generation and no attempt', [{ ...old(0), generation: null }]],
    ['an attempt on a family that publishes', [{ ...wfOld, family: 'form' }]],
    ['an attempt with an effect that may have been sent', [{ ...wfOld, attempt: { ...wfOld.attempt, effects: [{ effect: 'state', state: 'unconfirmed' }] } }]],
    ['an attempt in an unknown phase', [{ ...wfOld, attempt: { ...wfOld.attempt, phase: 'done' } }]],
    ['an attempt with an untyped field', [{ ...wfOld, attempt: { ...wfOld.attempt, activated: true } }]],
  ]) {
    writeRaw(bs, (d) => { d.retiredGroups = list; });
    const text = fileText(bs);
    assert.equal(codeOf(() => open(bound)), CODES.unreadable, label);
    assert.equal(fileText(bs), text, `${label}: unchanged`);
  }

  writeRaw(bs, (d) => { d.retiredGroups = [old(0), wfOld]; });
  assert.deepEqual(open(bound).snapshot().envelope.retiredGroups, [old(0), wfOld], 'a retired workflow attempt reads back');

  // A build that predates the audit list reads it as an unexpected key: the whole file is refused, not read as empty.
  writeRaw(bs, (d) => { d.retiredGroups = [old(0)]; d.retiredGroupsV2 = []; });
  assert.equal(codeOf(() => open(bound)), CODES.unreadable);
});
// A key whose root was proved gone and retired is created again, if it is declared again, under a fresh id: the deterministic
// create id it had is the row the service deleted. The new id is written in the retirement's own write, so every later run,
// retry and recovery of that key reads the same one, and the retired root is never prepared again under the key.
test('retirement gives the key a fresh, durable incarnation in the same write; the retired root is never prepared again under it; an older file without one opens as before', () => {
  const dir = makeTempDir('mb-incarnation-');
  const store = open(dir);
  const g = settleForm(store, [['name', CTRL_A]]);
  // A 2.21.0-candidate file has no incarnations: it opens, reads and writes as it always did.
  assert.equal('incarnations' in JSON.parse(fileText(store)), false);
  assert.deepEqual(open(dir).incarnations(), []);
  assert.equal(open(dir).readGroup('form', FORM_KEY).committed.generation, g.generation);

  const rev = store.snapshot().revision;
  retireNow(store, { family: 'form', key: FORM_KEY, generation: g.generation, rootId: FORM, evidence: absent(FORM) });
  const after = JSON.parse(fileText(store));
  assert.equal(after.revision, rev + 1, 'one write retires the group and sets its incarnation');
  assert.equal(after.incarnations.length, 1);
  const [inc] = after.incarnations;
  assert.deepEqual([inc.family, inc.key, inc.identity, inc.after, inc.epoch], ['form', FORM_KEY, FORM, FORM, 1]);
  assert.match(inc.rootId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(inc.rootId, FORM);
  assert.deepEqual(open(dir).incarnations(), [{ family: 'form', key: FORM_KEY, identity: FORM, rootId: inc.rootId, epoch: 1 }], 'every later handle reads the same id');

  // The retired root, in any spelling, is refused for the key under the lease: nothing is written.
  const prepare = (id) => store.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: null, root: { kind: 'form', key: FORM_KEY, id }, knownScopes: [TABLE], declarationSha256: H('e'), publication: { scope: TABLE, state: 'owed' } });
  for (const id of [FORM, FORM.toUpperCase()]) {
    const text = fileText(store);
    assert.equal(codeOf(() => prepare(id)), CODES.conflict, id);
    assert.equal(fileText(store), text, 'nothing written');
  }
  // A stale handle that read the file before the retirement is refused the same way: the fence reads the disk.
  const stale = makeTempDir('mb-incarnation-stale-');
  const sa = open(stale);
  const sg = settleForm(sa, []);
  const sb = open(stale);
  retireNow(sa, { family: 'form', key: FORM_KEY, generation: sg.generation, rootId: FORM, evidence: absent(FORM) });
  assert.deepEqual(sb.incarnations(), [], 'the stale handle has not read it');
  assert.equal(codeOf(() => sb.prepareAttempt({ family: 'form', key: FORM_KEY, baseGeneration: null, root: { kind: 'form', key: FORM_KEY, id: FORM }, knownScopes: [TABLE], declarationSha256: H('e') })), CODES.conflict);

  // The incarnation is created, committed, and retired in its turn: the key's entry moves on in place (the same identity,
  // the next epoch, a third id), never duplicated.
  const token = prepare(inc.rootId);
  store.markSending(token, expected(inc.rootId));
  store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  const reborn = store.commitGroup({ token, baseGeneration: null, records: [rec('form', FORM_KEY, inc.rootId)], proof: PROOF, consumerState: formState(), publication: owedTable() });
  assert.deepEqual(store.incarnations(), [{ family: 'form', key: FORM_KEY, identity: FORM, rootId: inc.rootId, epoch: 1 }], 'kept while it is bound');
  const r = settleRule(store, 'account/hide', RULE);
  retireNow(store, { family: 'rule', key: 'account/hide', generation: r.generation, rootId: RULE, evidence: absentRow(RULE) });
  retireNow(store, { family: 'form', key: FORM_KEY, generation: reborn.generation, rootId: inc.rootId, evidence: absent(inc.rootId) });
  const next = JSON.parse(fileText(store)).incarnations;
  assert.deepEqual(next.map((x) => [x.family, x.key, x.identity, x.after, x.epoch]), [['form', FORM_KEY, FORM, inc.rootId, 2], ['rule', 'account/hide', RULE, RULE, 1]]);
  assert.ok(![FORM, inc.rootId].includes(next[0].rootId), 'a third id, never one retired');
  assert.equal(codeOf(() => prepare(inc.rootId)), CODES.conflict, 'the latest retired root is fenced');

  // A failed write sets no incarnation and retires nothing.
  const crash = makeTempDir('mb-incarnation-crash-');
  const cg = settleForm(open(crash), []);
  const before = fileText(open(crash));
  const failing = open(crash, { deps: { writeFileAtomic: () => { throw new Error('crash before the replace'); } } });
  assert.equal(codeOf(() => retireNow(failing, { family: 'form', key: FORM_KEY, generation: cg.generation, rootId: FORM, evidence: absent(FORM) })), CODES.writeFailed);
  assert.equal(fileText(open(crash)), before);
  assert.deepEqual(open(crash).incarnations(), []);
});

test('incarnations are read strictly: a malformed list makes the whole file unreadable, unchanged; at the cap only a new key\'s retirement is refused', () => {
  const dir = makeTempDir('mb-incarnation-strict-');
  const store = open(dir);
  const g = settleForm(store, []);
  const one = (i, over = {}) => ({ family: 'form', key: `old/${i}`, identity: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`, rootId: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, after: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`, epoch: 1, ...over });
  for (const [label, list] of [
    ['not a list', {}],
    ['too many', Array.from({ length: INCARNATIONS_KEPT + 1 }, (_, i) => one(i))],
    ['an untyped field', [one(0, { at: 'now' })]],
    ['no after', [(({ after, ...rest }) => rest)(one(0))]],
    ['an unknown family', [one(0, { family: 'page' })]],
    ['an empty key', [one(0, { key: ' ' })]],
    ['an uppercase root', [one(0, { rootId: one(0).rootId.toUpperCase() })]],
    ['a root that is not a GUID', [one(0, { rootId: 'new' })]],
    ['the retired root again', [one(0, { rootId: one(0).after })]],
    ['no identity', [(({ identity, ...rest }) => rest)(one(0))]],
    ['no epoch', [(({ epoch, ...rest }) => rest)(one(0))]],
    ['a zero epoch', [one(0, { epoch: 0 })]],
    ['a fractional epoch', [one(0, { epoch: 1.5 })]],
    ['its own identity as its root', [one(0, { rootId: one(0).identity })]],
    ['another key\'s retired root as its root', [one(0), one(1, { rootId: one(0).after })]],
    ['another key\'s identity as its root', [one(0), one(1, { rootId: one(0).identity })]],
    ['one identity for two keys', [one(0), one(1, { identity: one(0).identity })]],
    ['one key twice', [one(0), one(1, { key: 'old/0' })]],
    ['one row for two keys of one table', [one(0), one(1, { family: 'dashboard', rootId: one(0).rootId })]],
  ]) {
    writeRaw(store, (d) => { d.incarnations = list; });
    const text = fileText(store);
    assert.equal(codeOf(() => open(dir)), CODES.unreadable, label);
    assert.equal(fileText(store), text, `${label}: unchanged`);
  }
  // One id in two tables is two rows.
  writeRaw(store, (d) => { d.incarnations = [one(0), one(1, { family: 'rule', rootId: one(0).rootId })]; });
  assert.equal(open(dir).incarnations().length, 2);

  writeRaw(store, (d) => { d.incarnations = Array.from({ length: INCARNATIONS_KEPT }, (_, i) => one(i)); });
  const full = open(dir);
  const text = fileText(full);
  assert.equal(codeOf(() => retireNow(full, { family: 'form', key: FORM_KEY, generation: g.generation, rootId: FORM, evidence: absent(FORM) })), CODES.storeFull);
  assert.equal(fileText(full), text, 'refused whole: the group is kept');
  writeRaw(store, (d) => { d.incarnations = [...Array.from({ length: INCARNATIONS_KEPT - 1 }, (_, i) => one(i)), one(9999, { key: FORM_KEY })]; });
  const replace = open(dir);
  retireNow(replace, { family: 'form', key: FORM_KEY, generation: g.generation, rootId: FORM, evidence: absent(FORM) });
  const kept = JSON.parse(fileText(replace)).incarnations;
  assert.deepEqual([kept.length, kept.at(-1).key, kept.at(-1).after, kept.at(-1).epoch], [INCARNATIONS_KEPT, FORM_KEY, FORM, 2], 'the key\'s own entry moves on at the cap');
});

// A plan made for an earlier incarnation (its root retired since the plan read the store) is refused under the lease by
// its epoch, however many retirements ago that was: comparing only the last retired root would let a plan two
// retirements old prepare a root proved gone. A plan for the current incarnation, and an adoption under another id, still
// prepare.
const prepareAt = (s, id, more = {}, key = FORM_KEY) => s.prepareAttempt({
  family: 'form', key, baseGeneration: null, root: { kind: 'form', key, id }, knownScopes: [TABLE], declarationSha256: H('e'),
  publication: { scope: TABLE, state: 'owed' }, ...more,
});
function settleAt(s, id, { key = FORM_KEY, incarnation } = {}) {
  const token = prepareAt(s, id, incarnation ? { incarnation } : {}, key);
  s.markSending(token, expected(id));
  s.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  return s.commitGroup({ token, baseGeneration: null, records: [rec('form', key, id)], proof: PROOF, consumerState: formState(), publication: owedTable() });
}
const retireAt = (s, g, key = FORM_KEY) => retireNow(s, { family: 'form', key, generation: g.generation, rootId: g.root.id, evidence: absent(g.root.id) });

test('incarnation epoch: a plan made before any number of retirements is refused with nothing written; the current plan and an adoption under another id prepare', () => {
  const dir = makeTempDir('mb-incarnation-epoch-');
  const stale = open(dir);
  const s = open(dir);
  retireAt(s, settleForm(s, []));
  const first = s.incarnations()[0];
  const once = open(dir);
  retireAt(s, settleAt(s, first.rootId));
  const second = s.incarnations()[0];
  retireAt(s, settleAt(s, second.rootId));
  const third = s.incarnations()[0];
  assert.deepEqual([first, second, third].map((x) => [x.key, x.identity, x.epoch]), [[FORM_KEY, FORM, 1], [FORM_KEY, FORM, 2], [FORM_KEY, FORM, 3]]);
  assert.equal(new Set([FORM, first.rootId, second.rootId, third.rootId]).size, 4, 'a fresh root at every retirement');
  const token = (x) => ({ identity: FORM, epoch: x ? x.epoch : 0, rootId: x ? x.rootId : null });
  const text = fileText(s);
  for (const [label, fn] of [
    ['a handle read before any retirement, its original root', () => prepareAt(stale, FORM)],
    ['a handle read after the first retirement, that incarnation', () => prepareAt(once, first.rootId)],
    ['a plan token from before any retirement', () => prepareAt(open(dir), FORM, { incarnation: token(null) })],
    ['a plan token of the first incarnation', () => prepareAt(open(dir), first.rootId, { incarnation: token(first) })],
    ['a plan token of the second incarnation', () => prepareAt(open(dir), second.rootId, { incarnation: token(second) })],
    ['the current epoch with another root', () => prepareAt(open(dir), third.rootId, { incarnation: { ...token(third), rootId: first.rootId } })],
  ]) {
    assert.equal(codeOf(fn), CODES.conflict, label);
    assert.equal(fileText(s), text, `${label}: nothing written`);
  }
  assert.equal(codeOf(() => prepareAt(open(dir), third.rootId, { incarnation: { identity: FORM, epoch: 1 } })), CODES.notSettled, 'a malformed token is refused, never read as none');
  assert.equal(fileText(s), text);
  // The current plan prepares; an adoption of a row found under another id replaces it under the same token check.
  const current = open(dir);
  const t1 = prepareAt(current, third.rootId, { incarnation: token(third) });
  stale.refresh();
  prepareAt(stale, SUBSTITUTE, { incarnation: token(third), replaces: { token: t1, baseGeneration: null } });
  assert.equal(open(dir).readGroup('form', FORM_KEY).pending.root.id, SUBSTITUTE);
});

test('incarnation identity: a lineage selected by its identity under another key moves on when that key retires its root, and a plan for its earlier epoch is refused', () => {
  const dir = makeTempDir('mb-incarnation-identity-');
  const s = open(dir);
  retireAt(s, settleForm(s, []));
  const first = s.incarnations()[0];
  // Another key whose declaration has the same canonical identity (a spelling the catalog folds to the same stable id)
  // selected this lineage by identity and was created under its root; that root is then retired under that key.
  const ALIAS = 'account/MAIN';
  const g = settleAt(s, first.rootId, { key: ALIAS, incarnation: { identity: FORM, epoch: 1, rootId: first.rootId } });
  retireAt(s, g, ALIAS);
  const list = s.incarnations();
  assert.equal(list.length, 1, 'the lineage moves on; no second entry for the other spelling');
  assert.deepEqual([list[0].key, list[0].identity, list[0].epoch], [FORM_KEY, FORM, 2]);
  assert.ok(![FORM, first.rootId].includes(list[0].rootId));
  const text = fileText(s);
  assert.equal(codeOf(() => prepareAt(open(dir), first.rootId, { incarnation: { identity: FORM, epoch: 1, rootId: first.rootId } }, ALIAS)), CODES.conflict);
  assert.equal(codeOf(() => prepareAt(open(dir), first.rootId, { incarnation: { identity: FORM, epoch: 1, rootId: first.rootId } })), CODES.conflict);
  assert.equal(fileText(s), text, 'nothing written');
  assert.equal(typeof prepareAt(open(dir), list[0].rootId, { incarnation: { identity: FORM, epoch: 2, rootId: list[0].rootId } }, ALIAS), 'string');
});