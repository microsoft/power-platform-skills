'use strict';
// Declared business rules on the managed settlement (lib/rule-settlement.js settleDeclaredRule), through the REAL
// vendored SDK and the plugin's REAL HTTP client with the workflow-effect gate, over an in-memory workflow table
// (helpers/workflow-wire.js). Every request is counted: a rule the plugin manages is one workflow row, a write is sent
// once inside its persisted effect, an answer that is lost is proved by reading, and an edit of a rule that already
// exists is refused before any request unless the conditional-edit switch is on.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createWorkflowWire, ORIGIN } = require('./helpers/workflow-wire.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { openManagedBindings, classifyPersisted, CODES } = require('../lib/managed-bindings.js');
const { createWorkflowEffectGate } = require('../lib/workflow-effect-context.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createIntentCatalog } = require('../lib/creates-catalog.js');
const { BuildHalt } = require('../lib/entity-provision.js');
const { RETRY } = require('../lib/retry-policy.js');
const { businessRuleDef } = require('../lib/sdk-build.js');
const { settleDeclaredRule, compileRuleIntent } = require('../lib/rule-settlement.js');

const APP = 'contoso_app';
const SOL = 'contoso_solution';
const SWITCH = { workflowConditionalEdits: true };
const RULE = {
  name: 'Hide fax', entity: 'account', reconcile: 'declared',
  conditions: [{ key: 'by-name', field: 'name', operator: 'Equals', value: 'A' }],
  actions: [{ key: 'hide-fax', type: 'SetVisibility', field: 'fax', visible: false }],
};
const approve = (rule = RULE) => new Set([`rule:${rule.entity}/${rule.name}`]);
const withCondition = (rule, value) => ({ ...rule, conditions: [{ ...rule.conditions[0], value }] });
const getToken = () => 'x'.repeat(40);

// The build's managedStop, as lib/sdk-build.js makes it: it answers a never-retry halt and does not throw it.
const managedStop = (phase, label, code, { cause } = {}) => new BuildHalt(`${label}: ${code}`, { phase, code, recoverable: false, retry: RETRY.NEVER, cause });

// One build process: a fresh store handle, barrier, gated client and SDK over the shared wire and workspace.
async function processOver(wire, dir) {
  const barrier = createPublicationBarrier();
  const store = openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOL, barrier });
  const workflowEffectGate = createWorkflowEffectGate({ store });
  const httpClient = createAzHttpClient(ORIGIN, { getToken, request: wire.request, sleep: async () => {}, workflowEffectGate });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(path.join(dir, 'sdk')), instanceUrl: ORIGIN, httpClient });
  await sdk.initWorkspace();
  return { barrier, store, sdk, httpClient };
}

const catalogOf = (rule) => createIntentCatalog([{ catalogKind: 'businessRule', key: `${rule.entity}/${rule.name}`, scope: { kind: 'table', solution: SOL, table: rule.entity }, declaration: rule }]);

// Run one settlement in a fresh process; answers { result | error, from, p } with the wire position it started at.
async function settle(wire, dir, rule, extra = {}) {
  const p = await processOver(wire, dir);
  const from = wire.log.length;
  try {
    const result = await settleDeclaredRule({ rule, ...p, catalog: catalogOf(rule), halt: managedStop, instanceUrl: ORIGIN, ...extra });
    return { result, from, p };
  } catch (error) {
    return { error, from, p };
  }
}
const writesSince = (wire, from) => wire.log.slice(from).filter((e) => e.method !== 'GET');
const writeLines = (wire, from) => wire.lines(from).filter((l) => !l.startsWith('GET'));
const ifMatchOf = (e) => e.headers['If-Match'] || e.headers['if-match'] || null;

// A maker's own edit of the live rule, outside the plugin: a plain client (no gate) and its own SDK workspace. The rule
// is taken to Draft and back on the table directly: the SDK's own Active-rule edit sends its update with the version it
// read BEFORE its own deactivation, which an enforcing service refuses.
async function makerEdit(wire, id, edit) {
  const row = wire.row(id);
  const active = row.statecode === 1;
  Object.assign(row, { statecode: 0, statuscode: 1 });
  const httpClient = createAzHttpClient(ORIGIN, { getToken, request: wire.request, sleep: async () => {} });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('rule-maker-')), instanceUrl: ORIGIN, httpClient });
  await sdk.initWorkspace();
  await sdk.fetchArtifact('businessRule', id, { overwrite: true });
  const art = await sdk.getArtifact('businessRule', id);
  const root = JSON.parse(JSON.stringify(art.rootCondition));
  edit(root);
  await sdk.updateElement('businessRule', id, '/rootCondition', root);
  const prep = await sdk.withArtifactLock('businessRule', id, () => sdk.prepareArtifactUnlocked('businessRule', id, undefined));
  const saved = await sdk.withArtifactLock('businessRule', id, () => sdk.executePrepared(prep));
  assert.notEqual(saved && saved.saved, false, 'the maker edit is saved');
  if (active) Object.assign(wire.row(id), { statecode: 1, statuscode: 2 });
  wire.row(id).version += 1;
}
// The literal of every condition of the stored WFOM, in order, e.g. ['B', 'A'] (a condition is a BinaryExpression
// whose `right` holds one PrimitiveExpression; two or more are joined under an outer BinaryExpression).
const liveValues = (wire, id) => [...wire.row(id).wfom.matchAll(/"primitiveValue":"([^"]*)"/g)].map((m) => m[1]);

async function created(rule = RULE) {
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-settle-');
  const out = await settle(wire, dir, rule);
  assert.ifError(out.error);
  return { wire, dir, id: out.result.id, store: out.p.store };
}

test('a new declared rule is created Draft, proved by a read, then activated by its own state write: no DELETE, no roll-back', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-settle-');
  const out = await settle(wire, dir, RULE);
  assert.ifError(out.error);
  assert.equal(out.result.committed, true);
  assert.deepEqual(writeLines(wire, out.from), [
    'POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson',
    'PATCH workflows(<id>)',
  ]);
  const [create, activate] = writesSince(wire, out.from);
  assert.equal(create.body.Entity.workflowid, out.result.id, 'the catalog id is the row id');
  assert.deepEqual(activate.body, { statecode: 1, statuscode: 2 }, 'the activation is a state-only write');
  assert.equal(wire.row(out.result.id).statecode, 1);
  const { committed, pending, effects } = out.p.store.readGroup('rule', 'account/Hide fax');
  assert.equal(pending, null);
  assert.deepEqual(effects, [], 'a committed attempt keeps no effect');
  assert.deepEqual(committed.records.map((r) => [r.kind, r.id, r.origin]), [['business-rule', out.result.id, 'created']]);

  // The same declaration again is a no-op that sends nothing.
  const again = await settle(wire, dir, RULE);
  assert.equal(again.result.noop, true);
  assert.deepEqual(writesSince(wire, again.from), []);
});

test('a Draft rule is created Draft and never activated', async () => {
  const wire = createWorkflowWire();
  const out = await settle(wire, makeTempDir('rule-settle-'), { ...RULE, status: 'Draft' });
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson']);
  assert.equal(wire.row(out.result.id).statecode, 0);
});

test('by default an edit of a managed rule is refused before any request (workflow-edit-refused)', async () => {
  const { wire, dir, store } = await created();
  const before = store.readGroup('rule', 'account/Hide fax').committed;
  for (const edited of [withCondition(RULE, 'B'), { ...RULE, status: 'Draft' }, { ...RULE, description: 'new' }]) {
    const out = await settle(wire, dir, edited);
    assert.equal(out.error && out.error.code, 'workflow-edit-refused');
    assert.equal(out.error.retry, RETRY.NEVER);
    assert.deepEqual(wire.log.slice(out.from), [], 'no request at all');
  }
  // An adoption approval lets the rule be read (a re-adoption may be what it asks for), but an edit is still refused, unsent.
  const approved = await settle(wire, dir, withCondition(RULE, 'B'), { approvals: approve() });
  assert.equal(approved.error && approved.error.code, 'workflow-edit-refused');
  assert.deepEqual(writesSince(wire, approved.from), []);
  assert.deepEqual(store.readGroup('rule', 'account/Hide fax').committed, before);
});

test('Q2: a maker copy of the bound clause plus a change to the original is rule-drift; the switch-on edit sends nothing', async () => {
  const { wire, dir, id } = await created();
  await makerEdit(wire, id, (root) => {
    const copy = { ...root.clauses[0], id: 'maker-copy' };
    delete copy.bag;
    root.clauses[0].value = 'B';
    root.clauses.push(copy);
  });
  const before = wire.row(id).wfom;
  const out = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.equal(out.error && out.error.code, 'rule-drift');
  assert.deepEqual(writesSince(wire, out.from), []);
  assert.equal(wire.row(id).wfom, before);
});

test('Q3: stored [A], live [B, A]: the slot no longer names the bound clause, so the switch-on edit is rule-drift with no write', async () => {
  const { wire, dir, id } = await created();
  await makerEdit(wire, id, (root) => {
    const b = { ...root.clauses[0], id: 'maker-b', value: 'B' };
    delete b.bag;
    root.clauses.unshift(b);
  });
  const out = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.equal(out.error && out.error.code, 'rule-drift');
  assert.deepEqual(writesSince(wire, out.from), []);
  assert.deepEqual(liveValues(wire, id), ['B', 'A']);
});

test('a drifted rule is re-adopted read-only only by a declaration naming its whole body, in order', async () => {
  const { wire, dir, id, store } = await created();
  await makerEdit(wire, id, (root) => {
    const b = { ...root.clauses[0], id: 'maker-b', value: 'B' };
    delete b.bag;
    root.clauses.unshift(b);
  });
  // Partial: names only the bound clause.
  const partial = await settle(wire, dir, RULE, { approvals: approve() });
  assert.equal(partial.error && partial.error.code, 'rule-whole-body-required');
  assert.deepEqual(writesSince(wire, partial.from), []);
  // Out of order.
  const swapped = { ...RULE, conditions: [RULE.conditions[0], { key: 'by-name-b', field: 'name', operator: 'Equals', value: 'B' }] };
  const wrong = await settle(wire, dir, swapped, { approvals: approve() });
  assert.equal(wrong.error && wrong.error.code, 'rule-whole-body-required');
  // Whole and in order: adopted with no write, and the next run is a no-op.
  const whole = { ...RULE, conditions: [{ key: 'by-name-b', field: 'name', operator: 'Equals', value: 'B' }, RULE.conditions[0]] };
  const out = await settle(wire, dir, whole, { approvals: approve() });
  assert.ifError(out.error);
  assert.equal(out.result.committed, true);
  assert.deepEqual(writesSince(wire, out.from), []);
  assert.equal(store.readGroup('rule', 'account/Hide fax').committed.records[0].origin, 'created', 'the record keeps its origin');
  const next = await settle(wire, dir, whole);
  assert.equal(next.result.noop, true);
});

test('a same-name rule the plugin does not manage needs adopt approval and a whole-body declaration; adoption writes nothing', async () => {
  const seed = await created();
  const wire = seed.wire;
  const dir = makeTempDir('rule-settle-');
  const refused = await settle(wire, dir, RULE);
  assert.equal(refused.error && refused.error.code, 'create-ownership-required');
  assert.deepEqual(writesSince(wire, refused.from), []);
  const out = await settle(wire, dir, RULE, { approvals: approve() });
  assert.ifError(out.error);
  assert.deepEqual(writesSince(wire, out.from), []);
  const { committed } = out.p.store.readGroup('rule', 'account/Hide fax');
  assert.deepEqual(committed.records.map((r) => [r.id, r.origin]), [[seed.id, 'adopted']]);
});

test('with the switch, an Active rule is edited as Draft, body, Active: three writes, each carrying the version its read returned', async () => {
  const { wire, dir, id } = await created();
  const out = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), [
    'PATCH workflows(<id>)',
    'POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.UpdateProcessWithWfomJson',
    'PATCH workflows(<id>)',
  ]);
  const writes = writesSince(wire, out.from);
  assert.deepEqual(writes.map((e) => e.body.statecode === undefined ? 'body' : e.body.statecode), [0, 'body', 1]);
  assert.deepEqual(writes.map(ifMatchOf), ['W/"2"', 'W/"3"', 'W/"4"'], 'every write is conditioned on the version just read');
  assert.equal(wire.row(id).statecode, 1);
  assert.match(wire.row(id).wfom, /"C"/);
  const next = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.equal(next.result.noop, true);
});

test('with the switch, a version that moves between the version read and the body read is rule-drift; nothing is sent', async () => {
  const { wire, dir, id } = await created({ ...RULE, status: 'Draft' });
  // Another writer touches the row (its body unchanged) between this build's two reads.
  let bumped = false;
  wire.script((e) => {
    if (!bumped && e.method === 'GET' && /RetrieveProcess/.test(e.path)) { bumped = true; wire.row(id).version += 1; }
    return false;
  }, null);
  const out = await settle(wire, dir, withCondition({ ...RULE, status: 'Draft' }, 'C'), { opts: SWITCH });
  assert.equal(out.error && out.error.code, 'rule-drift');
  assert.deepEqual(writesSince(wire, out.from), []);
});

test('an enforcing service refuses a stale edit (412) and keeps the competing body; the non-enforcing control would overwrite it', async () => {
  const competing = async (enforceIfMatch) => {
    const wire = createWorkflowWire({ enforceIfMatch });
    const dir = makeTempDir('rule-settle-');
    const draft = { ...RULE, status: 'Draft' };
    const first = await settle(wire, dir, draft);
    assert.ifError(first.error);
    const id = first.result.id;
    // Another session saves the rule after this build read it and just before its body write reaches the service.
    let fired = false;
    wire.script((e) => {
      if (!fired && e.method === 'POST' && /UpdateProcess/.test(e.path)) {
        fired = true;
        const row = wire.row(id);
        row.description = 'competing';
        row.version += 1;
      }
      return false;
    }, {});
    const out = await settle(wire, dir, withCondition(draft, 'C'), { opts: SWITCH });
    return { wire, id, out };
  };
  const enforcing = await competing(true);
  assert.equal(enforcing.out.error && enforcing.out.error.code, 'rule-drift');
  assert.equal(writesSince(enforcing.wire, enforcing.out.from).length, 1, 'sent once, not retried');
  assert.equal(enforcing.wire.row(enforcing.id).description, 'competing', 'the competing body survives');
  assert.doesNotMatch(enforcing.wire.row(enforcing.id).wfom, /"C"/);

  const control = await competing(false);
  assert.equal(control.wire.row(control.id).description, '', 'a service that ignores the version loses the competing body');
});

test('a create whose answer is lost is never sent again: it stays pending until a read proves it, then settles in a fresh process', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-settle-');
  wire.script((e) => /CreateProcess/.test(e.path), { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
  const first = await settle(wire, dir, RULE);
  assert.equal(first.error && first.error.code, CODES.pending);
  assert.deepEqual(writeLines(wire, first.from), ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson']);
  const sent = writesSince(wire, first.from)[0].body;

  const still = await settle(wire, dir, RULE);
  assert.equal(still.error && still.error.code, CODES.pending);
  assert.deepEqual(writesSince(wire, still.from), [], 'an unproved create is not sent again');

  // The service carried the create out after all.
  const id = String(sent.Entity.workflowid).toLowerCase();
  wire.rows.set(id, { kind: 'rule', workflowid: id, category: 2, type: 1, name: sent.Entity.name, description: sent.Entity.description, primaryentity: sent.Entity.primaryentity, wfom: sent.WfomJson, statecode: 0, statuscode: 1, version: 1 });
  const out = await settle(wire, dir, RULE);
  assert.ifError(out.error);
  assert.deepEqual(out.result, { committed: true, recovered: true, id });
  assert.deepEqual(writeLines(wire, out.from), ['PATCH workflows(<id>)'], 'only its own activation is sent');
  assert.equal(out.p.store.readGroup('rule', 'account/Hide fax').committed.records[0].origin, 'adopted', 'an unacknowledged create is not recorded as created');
  assert.deepEqual(wire.deleted, []);
});

test('a 503 to a create the service did carry out is proved by the read, not resent', async () => {
  const wire = createWorkflowWire();
  wire.script((e) => /CreateProcess/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216', message: 'busy' } } });
  const out = await settle(wire, makeTempDir('rule-settle-'), RULE);
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), [
    'POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson',
    'PATCH workflows(<id>)',
  ]);
});

test('a failed or lost activation never deletes the created rule', async () => {
  const refused = { statusCode: 400, body: { error: { code: '0x80040203', message: 'invalid' } }, unapplied: true };
  const lost = { error: 'socket hang up', code: 'ECONNRESET', unapplied: true };
  for (const [answer, code, rerunWrites] of [[refused, 'workflow-state-path-unavailable', ['PATCH']], [lost, CODES.pending, []]]) {
    const wire = createWorkflowWire();
    const dir = makeTempDir('rule-settle-');
    wire.script((e) => e.method === 'PATCH', answer);
    const out = await settle(wire, dir, RULE);
    assert.equal(out.error && out.error.code, code);
    assert.deepEqual(writesSince(wire, out.from).map((e) => e.method), ['POST', 'PATCH'], 'the activation is sent once');
    assert.deepEqual(wire.deleted, []);
    assert.equal(wire.rows.size, 1);
    // A refused activation was never started, so the next run sends it once more under its own record; a lost one may
    // have been carried out, so it is never sent again and the attempt waits for a read that proves it.
    const again = await settle(wire, dir, RULE);
    assert.deepEqual(writesSince(wire, again.from).map((x) => x.method), rerunWrites);
    if (rerunWrites.length) assert.equal(again.result && again.result.recovered, true);
    else assert.equal(again.error && again.error.code, CODES.pending);
  }
});

test('a rule never claims a publication scope, committed, pending or uncertain, so a table publish never covers or waits on it', async () => {
  // A table publish covers every store unit whose scopes include its table (classifyPersisted). A rule has no layer to
  // publish, so no sibling publish may need a layer reader for it or be blocked by an unproved rule write.
  const scopesOf = (store) => store.snapshot().units().filter((u) => u.family === 'rule').map((u) => ({ kind: classifyPersisted(u).kind, scopes: classifyPersisted(u).targets.scopes }));
  const { store } = await created();
  assert.deepEqual(scopesOf(store), [{ kind: 'settled', scopes: [] }]);
  assert.equal(store.readGroup('rule', 'account/Hide fax').committed.publication, null);
  const wire = createWorkflowWire();
  wire.script((e) => e.method === 'PATCH', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
  const lost = await settle(wire, makeTempDir('rule-settle-'), RULE);
  assert.equal(lost.error && lost.error.code, CODES.pending);
  assert.deepEqual(scopesOf(lost.p.store), [{ kind: 'uncertain', scopes: [] }]);
});
test('availability: only a confirmed switched-off refusal of the create, with no row read back, skips the rule', async () => {
  const off = { statusCode: 400, body: { error: { code: '0x80040216', message: 'Business rules are not enabled' } } };
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-settle-');
  wire.script((e) => /CreateProcess/.test(e.path), { ...off, unapplied: true });
  const out = await settle(wire, dir, RULE);
  assert.ifError(out.error);
  assert.equal(out.result.skipped, 'unavailable');
  assert.equal(writesSince(wire, out.from).length, 1);
  assert.equal(out.p.store.readGroup('rule', 'account/Hide fax').committed, null, 'nothing is bound');
  const { pending, effects } = out.p.store.readGroup('rule', 'account/Hide fax');
  assert.deepEqual(effects.map((e) => [e.effect, e.state]), [['create', 'definitely-unsent']], 'refused before it started: it may be sent again under its own record');
  assert.ok(pending);
  wire.script((e) => /CreateProcess/.test(e.path), { ...off, unapplied: true });
  const again = await settle(wire, dir, RULE);
  assert.equal(again.result && again.result.skipped, 'unavailable');
  assert.equal(writesSince(wire, again.from).length, 1);
  // Once the environment hosts rules, the same attempt finishes: its create is sent under its stored record.
  const later = await settle(wire, dir, RULE);
  assert.ifError(later.error);
  assert.deepEqual(later.result.recovered, true);
  assert.equal(later.p.store.readGroup('rule', 'account/Hide fax').committed.records[0].origin, 'adopted');

  // The same answer to a create the platform did save is not a skip: the rule is proved and bound.
  const saved = createWorkflowWire();
  saved.script((e) => /CreateProcess/.test(e.path), off);
  const kept = await settle(saved, makeTempDir('rule-settle-'), RULE);
  assert.ifError(kept.error);
  assert.equal(kept.result.committed, true);

  // A 5xx is never a skip.
  const busy = createWorkflowWire();
  busy.script((e) => /CreateProcess/.test(e.path), { statusCode: 503, body: off.body, unapplied: true });
  const unknown = await settle(busy, makeTempDir('rule-settle-'), RULE);
  assert.equal(unknown.error && unknown.error.code, CODES.pending);
});

test('Q5: an edit interrupted before its commit leaves the committed group as it was; only the same declaration finishes it, without a resend', async () => {
  const { wire, dir, store } = await created();
  const before = store.readGroup('rule', 'account/Hide fax').committed;
  const failing = async () => { throw new Error('solution membership failed'); };
  const first = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH, ensureMembership: failing });
  assert.ok(first.error);
  assert.deepEqual(first.p.store.readGroup('rule', 'account/Hide fax').committed, before, 'no new baseline under the old root');

  const other = await settle(wire, dir, withCondition(RULE, 'D'), { opts: SWITCH });
  assert.equal(other.error && other.error.code, CODES.pending);
  assert.deepEqual(writesSince(wire, other.from), []);

  const out = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.ifError(out.error);
  assert.equal(out.result.recovered, true);
  assert.deepEqual(writesSince(wire, out.from), []);
  const next = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.equal(next.result.noop, true);
});

test('compileRuleIntent is byte-identical to businessRuleDef for the legacy rule corpus', () => {
  const corpus = [
    { name: 'Hide fax', entity: 'Account', conditions: [{ field: 'name', operator: 'Equals', value: 'x' }, { field: 'numberofemployees', operator: 'IsGreaterThan', value: 5, dataType: 'Integer' }], actions: [{ type: 'SetVisibility', field: 'fax', visible: false }, { type: 'SetFieldValue', field: 'accountnumber', value: 42, dataType: 'Integer' }] },
    { name: 'Lock', entity: 'contact', status: 'Draft', description: 'd', scope: 'AllForms', conditions: [{ field: 'emailaddress1', operator: 'ContainsData' }], actions: [{ type: 'LockUnlock', field: 'telephone1', lock: true, label: 'Lock phone' }, { type: 'SetBusinessRequired', field: 'jobtitle', required: true }] },
    { name: 'Empty', entity: 'lead', conditions: [], actions: [] },
  ];
  for (const rule of corpus) assert.equal(JSON.stringify(compileRuleIntent(rule)), JSON.stringify(businessRuleDef(rule)));
});
