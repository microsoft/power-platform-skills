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
const { makeTempDir } = require('./helpers/temp-dirs.js');
const {
  openManagedBindings, openManagedContext, discoverManagedStore, classifyPersisted, CODES,
} = require('../lib/managed-bindings.js');
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
  assert.deepEqual(store.readGroup('form', FORM_KEY).pending.sendWindow, { possible: 0, notStarted: 0 });
  assert.equal(codeOf(() => store.noteAttemptNotStarted(token)), CODES.notSettled, 'nothing counted to answer');
  store.noteAttemptDispatch(token);
  store.noteAttemptDispatch(token);
  store.noteAttemptNotStarted(token);
  store.markSending(token, expected(FORM), { observed: true });
  assert.deepEqual(open(dir).readGroup('form', FORM_KEY).pending.sendWindow, { possible: 1, notStarted: 1 }, 'kept on disk; marking again changes nothing');

  // An attempt sent without an observer never gets a window, so nothing can later show it unsent.
  const other = makeTempDir('mb-send-window-plain-');
  const plain = open(other);
  const p = prepareForm(plain);
  plain.markSending(p.token, expected(FORM));
  plain.markSending(p.token, expected(FORM), { observed: true });
  plain.noteAttemptDispatch(p.token);
  assert.equal(plain.readGroup('form', FORM_KEY).pending.sendWindow, undefined);

  const good = fileText(store);
  for (const [label, w] of [['a negative count', { possible: -1, notStarted: 0 }], ['a fraction', { possible: 0.5, notStarted: 0 }], ['an extra key', { possible: 0, notStarted: 0, sent: 1 }]]) {
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
