'use strict';
// Declared business rules on the managed settlement (lib/rule-settlement.js settleDeclaredRule), through the REAL
// vendored SDK and the plugin's REAL HTTP client with the workflow-effect gate, over an in-memory workflow table
// (helpers/workflow-wire.js). Every request is counted: a rule the plugin manages is one workflow row, a write is sent
// once inside its persisted effect, an answer that is lost is proved by reading, and an edit of a rule that already
// exists is refused before any request unless the conditional-edit switch is on.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createWorkflowWire, ORIGIN } = require('./helpers/workflow-wire.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { openManagedBindings, classifyPersisted, CODES, DECLARATION_MAX_BYTES } = require('../lib/managed-bindings.js');
const { createWorkflowEffectGate } = require('../lib/workflow-effect-context.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createAttemptSendObserver } = require('../lib/managed-feature-contract.js');
const { createIntentCatalog } = require('../lib/creates-catalog.js');
const { BuildHalt } = require('../lib/entity-provision.js');
const { RETRY } = require('../lib/retry-policy.js');
const { businessRuleDef } = require('../lib/sdk-build.js');
const { settleDeclaredRule, compileRuleIntent, validateDeclaredRule } = require('../lib/rule-settlement.js');
const { canonicalJson } = require('../lib/reconcile-common.js');
const { largestRule } = require('./helpers/workflow-largest.js');
const { createWorkflowDriver } = require('../lib/workflow-drive.js');

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
// With `observed`, the build's send observer is installed inside the barrier's gate, as build-model-app.js installs it
// (createAttemptSendObserver), and handed to the settlement as `sendObserver`.
async function processOver(wire, dir, { observed = false } = {}) {
  const barrier = createPublicationBarrier();
  const store = openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOL, barrier });
  const workflowEffectGate = createWorkflowEffectGate({ store });
  const sendObserver = observed ? createAttemptSendObserver() : null;
  const request = sendObserver ? barrier.gateRequest(sendObserver.wrap(wire.request)) : wire.request;
  const httpClient = createAzHttpClient(ORIGIN, { getToken, request, sleep: async () => {}, workflowEffectGate });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(path.join(dir, 'sdk')), instanceUrl: ORIGIN, httpClient });
  await sdk.initWorkspace();
  return { barrier, store, sdk, httpClient, ...(sendObserver ? { sendObserver } : {}) };
}

const catalogOf = (rule) => createIntentCatalog([{ catalogKind: 'businessRule', key: `${rule.entity}/${rule.name}`, scope: { kind: 'table', solution: SOL, table: rule.entity }, declaration: rule }]);

// Run one settlement in a fresh process; answers { result | error, from, p } with the wire position it started at.
// `failLocally`: the first `executePrepared` throws on this side, after the effect is recorded and before any request
// leaves (a local failure of the SDK's own send step), so the write stays definitely unsent.
function failFirstSend(sdk) {
  const real = sdk.executePrepared.bind(sdk);
  let failed = false;
  sdk.executePrepared = async (...args) => {
    if (!failed) { failed = true; throw Object.assign(new Error('the prepared request could not be built'), { code: 'LOCAL_SEND_FAILED' }); }
    return real(...args);
  };
}

async function settle(wire, dir, rule, { observed = false, failLocally = false, ...extra } = {}) {
  const p = await processOver(wire, dir, { observed });
  if (failLocally) failFirstSend(p.sdk);
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
  // The complete request list, reads included.
  assert.deepEqual(wire.lines(out.from), [
    'GET EntityDefinitions(LogicalName=\'workflow\')?$select',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET EntityDefinitions(LogicalName=\'account\')/Attributes?$select',
    'POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
  ]);
  assert.deepEqual(writeLines(wire, out.from), [
    'POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson',
    'PATCH workflows(<id>)',
  ]);
  const [create, activate] = writesSince(wire, out.from);
  assert.equal(create.body.Entity.workflowid, out.result.id, 'the catalog id is the row id');
  assert.deepEqual(activate.body, { statecode: 1, statuscode: 2 }, 'the activation is a state-only write');
  assert.equal(ifMatchOf(activate), `W/"${wire.row(out.result.id).version - 1}"`, 'against the version of the read that proved the body');
  assert.equal(wire.row(out.result.id).statecode, 1);
  const { committed, pending, effects } = out.p.store.readGroup('rule', 'account/Hide fax');
  assert.equal(pending, null);
  assert.deepEqual(effects, [], 'a committed attempt keeps no effect');
  assert.deepEqual(committed.records.map((r) => [r.kind, r.id, r.origin]), [['business-rule', out.result.id, 'created']]);

  // The same declaration again is a no-op that sends nothing.
  const again = await settle(wire, dir, RULE);
  assert.equal(again.result.noop, true);
  // The complete request list, reads included.
  assert.deepEqual(wire.lines(again.from), [
    'GET EntityDefinitions(LogicalName=\'workflow\')?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
  ]);
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

test('a maker copy of the bound clause plus a change to the original is rule-drift; the switch-on edit sends nothing', async () => {
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

test('stored [A], live [B, A]: the slot no longer names the bound clause, so the switch-on edit is rule-drift with no write', async () => {
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

test('every new workflow effect carries the edit switch to the shared gate as a boolean', async (t) => {
  const contract = require('../lib/managed-feature-contract.js');
  const real = contract.withWorkflowEffect;
  const seen = [];
  contract.withWorkflowEffect = (args, fn) => { seen.push([args.effect.effect, args.workflowConditionalEdits]); return real(args, fn); };
  t.after(() => { contract.withWorkflowEffect = real; });
  const { wire, dir } = await created();
  assert.deepEqual(seen, [['create', false], ['state', false]], 'a default create and its activation: the switch is off');
  seen.length = 0;
  const edit = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.ifError(edit.error);
  assert.deepEqual(seen, [['state', true], ['body', true], ['state', true]], 'Draft, body, Active: each with the switch on');
});

test('with the switch, an Active rule is edited as Draft, body, Active: three writes, each carrying the version its read returned', async () => {
  const { wire, dir, id } = await created();
  const out = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.ifError(out.error);
  // The complete request list, reads included.
  assert.deepEqual(wire.lines(out.from), [
    'GET EntityDefinitions(LogicalName=\'workflow\')?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
    'GET EntityDefinitions(LogicalName=\'account\')/Attributes?$select',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
    'GET EntityDefinitions(LogicalName=\'account\')/Attributes?$select',
    'GET workflows(<id>)?$select',
    'POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.UpdateProcessWithWfomJson',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
  ]);
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

test('an edit stopped between its body and its own activation: only a conditional 412 proves no start, and only the switch sends it again', async () => {
  // The service refuses the activation's precondition (412 to a request that carried If-Match) and leaves the row as it
  // was: the effect gate records that the write never started, so the switch-on rerun may send it once more.
  const { wire, dir, id } = await created();
  let bodySeen = false;
  wire.script((e) => {
    if (/UpdateProcess/.test(e.path)) bodySeen = true;
    return bodySeen && e.method === 'PATCH' && e.body && e.body.statecode === 1;
  }, { statusCode: 412, body: { error: { code: '0x80060882', message: 'precondition failed' } }, unapplied: true });
  const first = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.equal(first.error && first.error.code, 'rule-drift', 'a refused precondition reads as drift');
  assert.match(wire.row(id).wfom, /"C"/);

  // Without the switch the rerun may only read: setting the existing rule Active is a state change of a live row.
  const refused = await settle(wire, dir, withCondition(RULE, 'C'));
  assert.equal(refused.error && refused.error.code, 'workflow-edit-refused');
  assert.deepEqual(writesSince(wire, refused.from), [], 'no write without the switch');
  assert.deepEqual(wire.log.slice(refused.from), [], 'its recorded activation is refused by the preflight, before any read');
  assert.equal(wire.row(id).statecode, 0);

  const again = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
  assert.ifError(again.error);
  assert.equal(again.result.recovered, true);
  assert.deepEqual(writeLines(wire, again.from), ['PATCH workflows(<id>)'], 'only the activation, sent once more');
  const [write] = writesSince(wire, again.from);
  assert.deepEqual(write.body, { statecode: 1, statuscode: 2 });
  assert.equal(ifMatchOf(write), `W/"${wire.row(id).version - 1}"`, 'against the version just read');
  assert.equal(wire.row(id).statecode, 1);
});

test('an answered refusal of an activation is not proof that it never started: it is never sent again', async () => {
  // A generic 400, a 412 to a request that carried no If-Match, and a lost answer all leave the outcome open.
  const answers = [
    ['generic-400', { statusCode: 400, body: { error: { code: '0x80040203', message: 'busy' } }, unapplied: true }, 'workflow-state-path-unavailable'],
    ['lost', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true }, CODES.pending],
  ];
  for (const [label, answer, firstCode] of answers) {
    const { wire, dir, id } = await created();
    let bodySeen = false;
    wire.script((e) => {
      if (/UpdateProcess/.test(e.path)) bodySeen = true;
      return bodySeen && e.method === 'PATCH' && e.body && e.body.statecode === 1;
    }, answer);
    const first = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
    assert.equal(first.error && first.error.code, firstCode, label);
    const { effects } = first.p.store.readGroup('rule', 'account/Hide fax');
    assert.deepEqual(effects.map((e) => e.state).slice(-1), ['unconfirmed'], `${label}: the activation stays unconfirmed`);
    const again = await settle(wire, dir, withCondition(RULE, 'C'), { opts: SWITCH });
    assert.equal(again.error && again.error.code, CODES.pending, label);
    assert.deepEqual(writesSince(wire, again.from), [], `${label}: never sent again`);
    assert.equal(wire.row(id).statecode, 0);
  }
});

test('a create whose answer is lost is never sent again; once a read finds the row, binding it needs the adopt approval', async () => {
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

  // The service carried the create out after all. No answer said so, so the row is not known to be this build's.
  const id = String(sent.Entity.workflowid).toLowerCase();
  wire.rows.set(id, { kind: 'rule', workflowid: id, category: 2, type: 1, name: sent.Entity.name, description: sent.Entity.description, primaryentity: sent.Entity.primaryentity, wfom: sent.WfomJson, statecode: 0, statuscode: 1, version: 1 });
  const unapproved = await settle(wire, dir, RULE);
  assert.equal(unapproved.error && unapproved.error.code, CODES.adoptionRequired);
  assert.deepEqual(writesSince(wire, unapproved.from), [], 'nothing is sent before the approval');
  assert.ok(unapproved.p.store.readGroup('rule', 'account/Hide fax').pending, 'the attempt is kept');

  const out = await settle(wire, dir, RULE, { approvals: approve() });
  assert.ifError(out.error);
  assert.deepEqual(out.result, { committed: true, recovered: true, id });
  assert.deepEqual(writeLines(wire, out.from), ['PATCH workflows(<id>)'], 'only its own activation is sent');
  assert.equal(out.p.store.readGroup('rule', 'account/Hide fax').committed.records[0].origin, 'adopted', 'an unacknowledged create is not recorded as created');
  assert.deepEqual(wire.deleted, []);
});

test('a 503 to a create the service did carry out is proved by the read, not resent, and is bound only with the adopt approval', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-settle-');
  wire.script((e) => /CreateProcess/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216', message: 'busy' } } });
  const first = await settle(wire, dir, RULE);
  assert.equal(first.error && first.error.code, CODES.adoptionRequired);
  assert.deepEqual(writeLines(wire, first.from), ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson']);
  const out = await settle(wire, dir, RULE, { approvals: approve() });
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), ['PATCH workflows(<id>)']);
  assert.equal(out.p.store.readGroup('rule', 'account/Hide fax').committed.records[0].origin, 'adopted');
});

test('a failed or lost activation never deletes the created rule and is never sent again', async () => {
  const refused = { statusCode: 400, body: { error: { code: '0x80040203', message: 'invalid' } }, unapplied: true };
  const lost = { error: 'socket hang up', code: 'ECONNRESET', unapplied: true };
  for (const [answer, code] of [[refused, 'workflow-state-path-unavailable'], [lost, CODES.pending]]) {
    const wire = createWorkflowWire();
    const dir = makeTempDir('rule-settle-');
    wire.script((e) => e.method === 'PATCH', answer);
    const out = await settle(wire, dir, RULE);
    assert.equal(out.error && out.error.code, code);
    assert.deepEqual(writesSince(wire, out.from).map((e) => e.method), ['POST', 'PATCH'], 'the activation is sent once');
    assert.deepEqual(wire.deleted, []);
    assert.equal(wire.rows.size, 1);
    // Neither answer proves the activation never started, so the attempt waits for a read that proves it.
    const again = await settle(wire, dir, RULE);
    assert.deepEqual(writesSince(wire, again.from), []);
    assert.equal(again.error && again.error.code, CODES.pending);
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
  // Once the environment hosts rules, the same attempt finishes: its create is sent under its stored record, and this
  // time its answer acknowledges the row.
  const later = await settle(wire, dir, RULE);
  assert.ifError(later.error);
  assert.deepEqual(later.result.recovered, true);
  assert.equal(later.result.resumed, true, 'the same create, resumed under its own token once its id reads absent');
  assert.deepEqual(writeLines(wire, later.from), [
    'POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson',
    'PATCH workflows(<id>)',
  ]);
  assert.equal(later.p.store.readGroup('rule', 'account/Hide fax').committed.records[0].origin, 'created');

  // The same answer to a create the platform did save is not a skip: the row is proved by reading, and because no answer
  // acknowledged it, it is bound only with the adopt approval.
  const saved = createWorkflowWire();
  const savedDir = makeTempDir('rule-settle-');
  saved.script((e) => /CreateProcess/.test(e.path), off);
  const held = await settle(saved, savedDir, RULE);
  assert.equal(held.error && held.error.code, CODES.adoptionRequired);
  const kept = await settle(saved, savedDir, RULE, { approvals: approve() });
  assert.ifError(kept.error);
  assert.equal(kept.result.committed, true);
  assert.equal(kept.p.store.readGroup('rule', 'account/Hide fax').committed.records[0].origin, 'adopted');

  // A 5xx is never a skip.
  const busy = createWorkflowWire();
  busy.script((e) => /CreateProcess/.test(e.path), { statusCode: 503, body: off.body, unapplied: true });
  const unknown = await settle(busy, makeTempDir('rule-settle-'), RULE);
  assert.equal(unknown.error && unknown.error.code, CODES.pending);
});

test('an edit interrupted before its commit leaves the committed group as it was; only the same declaration finishes it, without a resend', async () => {
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

const causeCategory = (err) => { for (let e = err; e; e = e.cause) if (e.category) return e.category; return null; };
const ruleCopy = (dir, id) => [path.join(dir, 'sdk', 'business-rules', `${id}.json`), path.join(dir, 'sdk', '.metadata', 'business-rules', `${id}.meta.json`)];

test('a local copy with an edit no run sent stops every path before any request and is kept byte for byte', async () => {
  const fs = require('node:fs');
  const { wire, dir, id } = await created();
  const p = await processOver(wire, dir);
  await p.sdk.updateElement('businessRule', id, '/rootCondition/clauses/0/value', 'Z');
  const [file] = ruleCopy(dir, id);
  const bytes = fs.readFileSync(file);
  // The same declaration (the no-op path), a switch-on edit and a pure state change: each refuses unread and unsent.
  for (const [rule, extra] of [[RULE, {}], [withCondition(RULE, 'C'), { opts: SWITCH }], [{ ...RULE, status: 'Draft' }, { opts: SWITCH }], [RULE, {}]]) {
    const out = await settle(wire, dir, rule, extra);
    assert.equal(out.error && out.error.code, 'create-completion-required');
    assert.equal(causeCategory(out.error), 'workspace-copy-unsent-edits');
    assert.deepEqual(wire.log.slice(out.from), [], 'no request at all');
    assert.deepEqual(fs.readFileSync(file), bytes, 'the local copy is kept');
  }
  // The remedy the message names: delete only the copy's own two files; the binding store is untouched.
  for (const f of ruleCopy(dir, id)) fs.rmSync(f, { force: true });
  const next = await settle(wire, dir, RULE);
  assert.ifError(next.error);
  assert.equal(next.result.noop, true);
  assert.deepEqual(writesSince(wire, next.from), []);
});

test('an approved adoption whose row is gone before it is bound never recreates it', async () => {
  const seed = await created();
  const wire = seed.wire;
  const dir = makeTempDir('rule-settle-');
  const failing = async () => { throw new Error('solution membership failed'); };
  const first = await settle(wire, dir, RULE, { approvals: approve(), ensureMembership: failing });
  assert.ok(first.error);
  assert.deepEqual(writesSince(wire, first.from), []);
  wire.rows.delete(seed.id);
  for (const extra of [{}, { approvals: approve() }, { approvals: approve(), opts: SWITCH }]) {
    const out = await settle(wire, dir, RULE, extra);
    assert.ok(out.error, 'it stops');
    assert.equal(out.error.code, 'create-completion-required', 'an adoption never takes the create branch');
    assert.deepEqual(writesSince(wire, out.from), [], 'no POST and no PATCH');
    assert.equal(wire.rows.size, 0, 'no row is recreated');
  }
});

test('with the switch, a scope change is staged, sent with the body and proved; a re-adoption compares the scope', async () => {
  const { wire, dir, id } = await created({ ...RULE, status: 'Draft' });
  const allForms = { ...RULE, status: 'Draft', scope: 'AllForms' };
  const refused = await settle(wire, dir, allForms);
  assert.equal(refused.error && refused.error.code, 'workflow-edit-refused');
  assert.deepEqual(wire.log.slice(refused.from), []);
  const out = await settle(wire, dir, allForms, { opts: SWITCH });
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.UpdateProcessWithWfomJson']);
  assert.equal(wire.row(id).processtriggerscope, 1, 'AllForms reaches the row');
  assert.equal((await settle(wire, dir, allForms)).result.noop, true);

  // A same-name rule this workspace does not manage: a declaration whose scope differs from the live one is not its body.
  const other = makeTempDir('rule-settle-');
  const wrong = await settle(wire, other, { ...RULE, status: 'Draft' }, { approvals: approve() });
  assert.equal(wrong.error && wrong.error.code, 'rule-whole-body-required');
  assert.deepEqual(writesSince(wire, wrong.from), []);
  const right = await settle(wire, other, allForms, { approvals: approve() });
  assert.ifError(right.error);
  assert.deepEqual(writesSince(wire, right.from), []);
});

test('a state-only change is one conditional state write with no body, and is refused unsent by default', async () => {
  const { wire, dir, id } = await created({ ...RULE, status: 'Draft' });
  const refused = await settle(wire, dir, RULE);
  assert.equal(refused.error && refused.error.code, 'workflow-edit-refused');
  assert.deepEqual(wire.log.slice(refused.from), [], 'the default refusal sends no request');
  const before = wire.row(id).wfom;
  const out = await settle(wire, dir, RULE, { opts: SWITCH });
  assert.ifError(out.error);
  // The complete request list, reads included.
  assert.deepEqual(wire.lines(out.from), [
    'GET EntityDefinitions(LogicalName=\'workflow\')?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson',
  ]);
  assert.deepEqual(writeLines(wire, out.from), ['PATCH workflows(<id>)']);
  const [write] = writesSince(wire, out.from);
  assert.deepEqual(write.body, { statecode: 1, statuscode: 2 });
  assert.equal(ifMatchOf(write), `W/"${wire.row(id).version - 1}"`);
  assert.equal(wire.row(id).wfom, before, 'no definition push');
  assert.equal((await settle(wire, dir, RULE)).result.noop, true);

  const back = await settle(wire, dir, { ...RULE, status: 'Draft' }, { opts: SWITCH });
  assert.ifError(back.error);
  assert.deepEqual(writesSince(wire, back.from).map((e) => e.body), [{ statecode: 0, statuscode: 1 }]);
});

test('a state write a path proposes late, on a row this attempt is not proved to have created, is refused before it is recorded or sent', async () => {
  // A Draft rule another workspace created at the id this rule's catalog derives: present, and not this attempt's.
  const wire = createWorkflowWire();
  const other = await settle(wire, makeTempDir('rule-settle-'), { ...RULE, status: 'Draft' });
  assert.ifError(other.error);
  const id = other.result.id;
  const key = `${RULE.entity}/${RULE.name}`;
  for (const conditionalEdits of [false, true]) {
    const { store, sdk, httpClient } = await processOver(wire, makeTempDir('rule-settle-'));
    // A create-shaped attempt (no base) with no recorded effect: what a recovery sees before it records one.
    const token = store.prepareAttempt({
      family: 'rule', key, root: { kind: 'business-rule', key, id }, declarationSha256: 'a'.repeat(64),
      expected: { proofVersion: 1, proofSchema: 'business-rule/declared-1', rootId: id, baseProofSha256: null, sentProjectionSha256: 'b'.repeat(64), preservationSha256: 'c'.repeat(64), baseObservation: null, children: [] },
    });
    const driver = createWorkflowDriver({ store, sdk, httpClient, instanceUrl: ORIGIN, family: 'rule', key, label: 'probe', noun: 'rule', driftCode: 'rule-drift', conditionalEdits });
    const from = wire.log.length;
    const failure = await driver.driveState(token, id, 'Active', null, { conditional: false }).then(() => null, (e) => e);
    if (!conditionalEdits) {
      assert.equal(failure && failure.code, 'workflow-edit-refused');
      assert.deepEqual(writeLines(wire, from), [], 'nothing is sent');
      assert.deepEqual(store.readGroup('rule', key).effects, [], 'nothing is recorded');
      assert.equal(wire.row(id).statecode, 0, 'the existing Draft stays Draft');
    } else {
      assert.ifError(failure);
      assert.deepEqual(writeLines(wire, from), ['PATCH workflows(<id>)'], 'only the switch lets it through');
    }
  }
});

test('compileRuleIntent is byte-identical to businessRuleDef for the legacy rule corpus', () => {
  const corpus = [
    { name: 'Hide fax', entity: 'Account', conditions: [{ field: 'name', operator: 'Equals', value: 'x' }, { field: 'numberofemployees', operator: 'IsGreaterThan', value: 5, dataType: 'Integer' }], actions: [{ type: 'SetVisibility', field: 'fax', visible: false }, { type: 'SetFieldValue', field: 'accountnumber', value: 42, dataType: 'Integer' }] },
    { name: 'Lock', entity: 'contact', status: 'Draft', description: 'd', scope: 'AllForms', conditions: [{ field: 'emailaddress1', operator: 'ContainsData' }], actions: [{ type: 'LockUnlock', field: 'telephone1', lock: true, label: 'Lock phone' }, { type: 'SetBusinessRequired', field: 'jobtitle', required: true }] },
    { name: 'Empty', entity: 'lead', conditions: [], actions: [] },
  ];
  for (const rule of corpus) assert.equal(JSON.stringify(compileRuleIntent(rule)), JSON.stringify(businessRuleDef(rule)));
});

test('a create that failed on this side before any request is sent again under its own token: continued with the send observer, resumed without it', async () => {
  const clean = createWorkflowWire();
  const fresh = await settle(clean, makeTempDir('rule-settle-'), RULE);
  assert.ifError(fresh.error);
  for (const observed of [true, false]) {
    const wire = createWorkflowWire();
    const dir = makeTempDir('rule-settle-');
    const first = await settle(wire, dir, RULE, { observed, failLocally: true });
    assert.ok(first.error, `${observed}: it stops`);
    assert.deepEqual(writesSince(wire, first.from), [], `${observed}: nothing reached the service`);
    const { pending, effects } = first.p.store.readGroup('rule', 'account/Hide fax');
    assert.deepEqual([pending.phase, effects.map((e) => [e.effect, e.state])], ['sending', [['create', 'definitely-unsent']]]);
    if (observed) assert.deepEqual(pending.sendWindow, { possible: 0, notStarted: 0, epoch: 1 }, 'the window saw nothing leave');

    const again = await settle(wire, dir, RULE, { observed });
    assert.ifError(again.error);
    assert.deepEqual([again.result.recovered, again.result.continued, again.result.resumed], observed ? [true, true, undefined] : [true, undefined, true],
      `${observed}: the same attempt, ${observed ? 'continued' : 'resumed'}`);
    assert.deepEqual(writeLines(wire, again.from), writeLines(clean, fresh.from), `${observed}: exactly the create and its activation, once`);
    const group = again.p.store.readGroup('rule', 'account/Hide fax');
    assert.equal(group.pending, null);
    assert.deepEqual([group.committed.root.id, group.committed.records[0].origin], [pending.root.id, 'created'], `${observed}: the same id, bound as created`);
  }
});
// The shared edit gate exempts the attempt's own activation only on a fresh read that found its row Draft
// (editSwitchRequired `observedState`): every new effect says what the read before it observed.
test('the default activation of its own create carries the Draft its fresh read observed; no other effect claims a read', async (t) => {
  const contract = require('../lib/managed-feature-contract.js');
  const real = contract.withWorkflowEffect;
  const seen = [];
  contract.withWorkflowEffect = (args, fn) => { seen.push([args.effect.effect, args.effect.desiredState || null, args.observedState]); return real(args, fn); };
  t.after(() => { contract.withWorkflowEffect = real; });
  await created();
  assert.deepEqual(seen, [['create', null, undefined], ['state', 'Active', 'Draft']]);
});

// A refusal of the shared gate is thrown before its effect is recorded: no effect exists to look up, so the driver
// must not answer it as a write failure (that path reads the effect it expects to have been recorded).
test('a refusal of the shared edit gate is the coded refusal of the run: nothing recorded or sent after it, and the attempt finishes later', async (t) => {
  const contract = require('../lib/managed-feature-contract.js');
  const real = contract.withWorkflowEffect;
  const reached = [];
  // The read the activation was planned on is withheld from the shared gate only, so the gate itself refuses.
  contract.withWorkflowEffect = (args, fn) => { reached.push(args.effect.effect); return real(args.effect.effect === 'state' ? { ...args, observedState: undefined } : args, fn); };
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-settle-');
  let out;
  try { out = await settle(wire, dir, RULE); } finally { contract.withWorkflowEffect = real; }
  assert.deepEqual(reached, ['create', 'state'], 'the activation reached the shared gate');
  assert.ok(out.error, 'the run stops');
  assert.equal(out.error.code, 'workflow-edit-refused', `the gate's code, not a TypeError: ${out.error.message}`);
  assert.ok(!/TypeError|Cannot read/.test(String(out.error.message)), out.error.message);
  assert.deepEqual(writesSince(wire, out.from).map((e) => e.method), ['POST'], 'only the create left');
  const { pending, effects } = out.p.store.readGroup('rule', 'account/Hide fax');
  assert.ok(pending, 'the attempt is kept');
  assert.deepEqual(effects.map((e) => [e.effect, e.state]), [['create', 'confirmed']], 'no state effect was recorded');

  const again = await settle(wire, dir, RULE);
  assert.ifError(again.error);
  assert.deepEqual(writesSince(wire, again.from).map((e) => e.method), ['PATCH'], 'a later run sends only the activation, once');
});

// The ORIGINAL authored rule is the attempt's declaration (recorded before any send, committed as
// originalDeclaration); the derived state stays this module's own, so the next run is still a no-op.
test('the authored rule is recorded with the attempt and committed apart from the derived state; the next run is still a no-op', async () => {
  const authored = JSON.parse(JSON.stringify(RULE));
  const { wire, dir, store } = await created();
  const group = store.readGroup('rule', 'account/Hide fax').committed;
  assert.deepEqual(group.originalDeclaration, authored);
  assert.deepEqual(Object.keys(group.consumerState.declaration).sort(), ["nodes","rule"]);
  const next = await settle(wire, dir, RULE);
  assert.ifError(next.error);
  assert.equal(next.result.noop, true);
  assert.deepEqual(writesSince(wire, next.from), []);
  for (const observed of [true, false]) {
    const w = createWorkflowWire();
    const d = makeTempDir('rule-settle-');
    const first = await settle(w, d, RULE, { observed, failLocally: true });
    assert.ok(first.error);
    assert.deepEqual(first.p.store.readGroup('rule', 'account/Hide fax').pending.declaration, authored, `${observed}: recorded before the send`);
    const again = await settle(w, d, RULE, { observed });
    assert.ifError(again.error);
    assert.equal(observed ? again.result.continued : again.result.resumed, true, `${observed}: the same attempt, sent for its recorded declaration`);
    assert.deepEqual(again.p.store.readGroup('rule', 'account/Hide fax').committed.originalDeclaration, authored, `${observed}: committed`);
  }
});

// ----- The default activation of the attempt's own create, against a maker's change after the read that proved it.
// The first process can be stopped inside that activation: its effect is recorded and the write's callback throws before
// any request leaves, so a later process finds the create confirmed and the activation definitely unsent.
async function heldAtActivation(wire, dir, decl = RULE) {
  const contract = require('../lib/managed-feature-contract.js');
  const real = contract.withWorkflowEffect;
  contract.withWorkflowEffect = (args, fn) => real(args, args.effect.effect === 'state'
    ? async () => { throw Object.assign(new Error('stopped before the activation left'), { code: 'LOCAL_STOP' }); } : fn);
  try { return await settle(wire, dir, decl); } finally { contract.withWorkflowEffect = real; }
}
// A maker's change of the row on the service side: `activate`; `deactivate` (activated, then back to Draft: the same
// state at a newer version); `edit` (the body, still Draft).
function makerChange(row, change) {
  if (change === 'activate') Object.assign(row, { statecode: 1, statuscode: 2, version: row.version + 1 });
  if (change === 'deactivate') Object.assign(row, { statecode: 0, statuscode: 1, version: row.version + 2 });
  if (change === 'edit') {
    row.description = 'Changed by a maker';
    row.version += 1;
  }
}

for (const recovery of [false, true]) {
  for (const change of ['none', 'activate', 'deactivate', 'edit']) {
    test(`the own activation ${recovery ? 'resumed by a later process' : 'of a first create'} is held to the version of the read that proved it (maker: ${change})`, async () => {
      const wire = createWorkflowWire();
      const dir = makeTempDir('rule-settle-');
      let token = null;
      if (recovery) {
        const first = await heldAtActivation(wire, dir);
        assert.ok(first.error);
        const g = first.p.store.readGroup('rule', 'account/Hide fax');
        token = g.pending.token;
        assert.deepEqual(g.effects.map((e) => [e.effect, e.state]), [['create', 'confirmed'], ['state', 'definitely-unsent']]);
      }
      let seen = null;
      wire.script((e) => {
        if (seen || e.method !== 'PATCH' || !e.body || e.body.statecode !== 1) return false;
        const row = [...wire.rows.values()][0];
        seen = { ifMatch: ifMatchOf(e), read: row.version };
        makerChange(row, change);
        seen.after = row.version;
        return false;
      }, { statusCode: 500 });
      const out = await settle(wire, dir, RULE);
      const row = [...wire.rows.values()][0];
      assert.ok(seen, 'the activation reached the service');
      assert.equal(seen.ifMatch, `W/"${seen.read}"`, 'it carries the version of the read that proved the body');
      assert.equal(writesSince(wire, out.from).filter((e) => e.method === 'PATCH').length, 1, 'one activation, never sent again');
      const g = out.p.store.readGroup('rule', 'account/Hide fax');
      if (change === 'none' || change === 'activate') {
        assert.ifError(out.error);
        assert.equal(row.statecode, 1);
        // Activated by this write, or already Active with exactly the proved body: then it is met without this write (kept as a
        // fulfilled fact until the commit) and nothing is written.
        assert.equal(row.version, change === 'none' ? seen.after + 1 : seen.after);
        assert.equal(g.pending, null);
        assert.deepEqual(g.effects, []);
        assert.deepEqual(g.committed.records.map((r) => r.origin), g.committed.records.map(() => 'created'));
        const next = await settle(wire, dir, RULE);
        assert.equal(next.result.noop, true);
        assert.deepEqual(writesSince(wire, next.from), []);
        return;
      }
      // A Draft at a newer version or a changed body: refused, the maker's change kept, the attempt kept.
      assert.equal(out.error.code, 'create-completion-required');
      assert.equal(row.version, seen.after, 'no write of this build was applied');
      assert.equal(row.statecode, 0, 'never activated, and the maker\'s deactivation is never undone');
      assert.equal(g.committed, null);
      if (recovery) assert.equal(g.pending.token, token, 'the same attempt, kept');
      const next = await settle(wire, dir, RULE);
      assert.equal(next.error.code, 'create-completion-required', 'a later run refuses the same way');
      assert.deepEqual(writesSince(wire, next.from), [], 'and sends nothing');
      assert.equal(next.p.store.readGroup('rule', 'account/Hide fax').pending.token, g.pending.token);
    });
  }
}

test('an activation recorded without a row version is never sent; once the maker activates the proved row it settles with no write', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-settle-');
  const contract = require('../lib/managed-feature-contract.js');
  const real = contract.withWorkflowEffect;
  // Stop before the activation is recorded, then record it as an unconditional activation was recorded before.
  contract.withWorkflowEffect = (args, fn) => (args.effect.effect === 'state'
    ? Promise.reject(Object.assign(new Error('stopped before the activation was recorded'), { code: 'LOCAL_STOP' })) : real(args, fn));
  let first;
  try { first = await settle(wire, dir, RULE); } finally { contract.withWorkflowEffect = real; }
  assert.ok(first.error);
  const { pending, effects } = first.p.store.readGroup('rule', 'account/Hide fax');
  assert.deepEqual(effects.map((e) => [e.effect, e.state]), [['create', 'confirmed']]);
  first.p.store.recordWorkflowEffect({
    attemptToken: pending.token, baseGeneration: null, family: 'rule', key: 'account/Hide fax', rowId: pending.root.id, effect: 'state',
    request: { method: 'PATCH', shape: 'workflow-patch' }, desiredSha256: null, desiredState: 'Active', expectedVersion: null,
  });
  const again = await settle(wire, dir, RULE);
  assert.equal(again.error.code, 'create-completion-required');
  assert.match(again.error.cause.message, /without the row version/);
  assert.deepEqual(writesSince(wire, again.from), []);
  assert.equal(wire.row(pending.root.id).statecode, 0);
  assert.equal(again.p.store.readGroup('rule', 'account/Hide fax').pending.token, pending.token);
  // The maker activates the row as declared: a fresh read proves it, and the record settles with nothing sent.
  makerChange(wire.row(pending.root.id), 'activate');
  const settled = await settle(wire, dir, RULE);
  assert.ifError(settled.error);
  assert.deepEqual(writesSince(wire, settled.from), []);
  const g = settled.p.store.readGroup('rule', 'account/Hide fax');
  assert.equal(g.pending, null);
  assert.ok(g.committed);
  assert.equal(settled.result.id, pending.root.id);
});

for (const when of ['before-read', 'at-activation']) {
  test(`a separate OS process resuming the activation never activates a Draft the maker changed ${when}`, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('rule-settle-');
    const first = await heldAtActivation(wire, dir);
    const token = first.p.store.readGroup('rule', 'account/Hide fax').pending.token;
    const input = path.join(dir, 'child-input.json');
    const output = path.join(dir, 'child-output.json');
    fs.writeFileSync(input, JSON.stringify({ family: 'rule', declaration: RULE, dir, when, rows: [...wire.rows], output, app: APP, solution: SOL }));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'workflow-resume-child.js'), input], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.notEqual(r.pid, process.pid);
    assert.equal(r.changed, true);
    assert.equal(r.code, 'create-completion-required');
    assert.equal(r.token, token, 'the same attempt, kept');
    assert.equal(r.finalVersion, r.versionAfterMaker, 'no write of the second process was applied');
    assert.equal(r.finalState, 0);
    if (when === 'before-read') assert.deepEqual(r.writes, []);
    else {
      assert.deepEqual(r.writes, ['PATCH workflows(<id>)']);
      assert.equal(r.ifMatch, `W/"${r.versionAfterMaker - 1}"`);
    }
  });
}

test('the largest supported rule (100 conditions, 100 actions) commits with its authored declaration whole, and the next run is a no-op', async () => {
  const decl = largestRule();
  assert.deepEqual(validateDeclaredRule(decl), []);
  const bytes = Buffer.byteLength(canonicalJson(decl), 'utf8');
  assert.ok(bytes > 128 * 1024 && bytes <= DECLARATION_MAX_BYTES, `${bytes} bytes, inside the store's declaration bound`);
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-largest-');
  const out = await settle(wire, dir, decl);
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson', 'PATCH workflows(<id>)']);
  const { committed } = out.p.store.readGroup('rule', `account/${decl.name}`);
  assert.equal(canonicalJson(committed.originalDeclaration), canonicalJson(decl), 'the authored declaration is kept whole');
  const again = await settle(wire, dir, decl);
  assert.ifError(again.error);
  assert.deepEqual(writeLines(wire, again.from), []);
});

for (const missing of ['httpClient', 'instanceUrl']) {
  test(`without the ${missing} the conditional activation needs, it stops workflow-state-path-unavailable before the activation is recorded`, async () => {
    const wire = createWorkflowWire();
    const out = await settle(wire, makeTempDir('rule-no-state-path-'), RULE, { [missing]: null });
    assert.equal(out.error && out.error.code, 'workflow-state-path-unavailable');
    assert.deepEqual(out.p.store.readGroup('rule', `account/${RULE.name}`).effects.map((e) => [e.effect, e.state]), [['create', 'confirmed']]);
    assert.deepEqual(writeLines(wire, out.from), ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson']);
  });
}

test('an activation the service keeps refusing at the proved version is not applied and kept; activating the verified row, then rerunning, settles it with no write', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-refused-412-');
  let token = null;
  for (let run = 0; run < 2; run++) {
    // A 412 that changes nothing: the row stays at the version the activation was proved against.
    wire.script((e) => e.method === 'PATCH' && e.body && e.body.statecode === 1, { statusCode: 412, unapplied: true, body: { error: { code: '0x80060882', message: 'The version of the existing record doesn\'t match the RowVersion property provided.' } } });
    const out = await settle(wire, dir, RULE);
    assert.equal(out.error && out.error.code, CODES.pending);
    const message = out.error.cause.message;
    assert.match(message, /was not applied/);
    assert.doesNotMatch(message, /was not sent/, 'an answered 412 proves a refusal, not that nothing was sent');
    assert.match(message, /activate the rule yourself if it is as declared, then rerun/);
    const { pending } = out.p.store.readGroup('rule', `account/${RULE.name}`);
    token = token || pending.token;
    assert.equal(pending.token, token, 'the same attempt is kept');
    assert.equal(writesSince(wire, out.from).filter((e) => e.method === 'PATCH').length, 1, 'one conditional activation per run');
  }
  const row = [...wire.rows.values()][0];
  assert.equal(row.version, 1);
  Object.assign(row, { statecode: 1, statuscode: 2 });
  row.version += 1;
  const final = await settle(wire, dir, RULE);
  assert.ifError(final.error);
  assert.deepEqual(writeLines(wire, final.from), []);
});

// ----- An activation this attempt found made (a maker activated the row first) is a durable fact: it is kept through a
// failure before the commit and a process exit, so a later run never proposes it again — after a maker's deactivation
// that would undo the maker's change. `found-at-activation`: the maker activates as the conditional activation arrives
// (412; the fresh read finds the proved body Active). `already-active`: the row is Active when the run reads it, so no
// activation is recorded until the fact is. `sent`: this run's own activation, the control.
const failingMembership = async () => { throw new Error('solution membership unavailable'); };
const firstRow = (wire) => [...wire.rows.values()][0];
for (const mode of ['found-at-activation', 'already-active', 'sent']) {
  test(`an activation met before a failed commit is never sent again: after a maker's deactivation a separate process sends nothing and refuses (${mode})`, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('rule-met-');
    if (mode === 'found-at-activation') {
      wire.script((e) => {
        if (e.method === 'PATCH' && e.body && e.body.statecode === 1 && firstRow(wire).statecode === 0) makerChange(firstRow(wire), 'activate');
        return false;
      }, { statusCode: 500 });
    }
    if (mode === 'already-active') {
      const real = wire.request;
      wire.request = async (req) => {
        const answer = await real(req);
        if (req.method === 'POST' && /CreateProcessWithWfomJson|\/workflows$/.test(req.url)) makerChange(firstRow(wire), 'activate');
        return answer;
      };
    }
    const first = await settle(wire, dir, RULE, { ensureMembership: failingMembership });
    assert.ok(first.error);
    assert.equal(firstRow(wire).statecode, 1);
    assert.deepEqual(writeLines(wire, first.from), mode === 'already-active' ? ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson'] : ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson', 'PATCH workflows(<id>)']);
    const g = first.p.store.readGroup('rule', 'account/Hide fax');
    assert.deepEqual(g.effects.map((e) => [e.effect, e.state]), [['create', 'confirmed'], ['state', mode === 'sent' ? 'confirmed' : 'fulfilled']]);
    // The maker deactivates the row, outside the plugin; a separate OS process then settles the same declaration.
    makerChange(firstRow(wire), 'deactivate');
    const version = firstRow(wire).version;
    const input = path.join(dir, 'child-input.json');
    const output = path.join(dir, 'child-output.json');
    fs.writeFileSync(input, JSON.stringify({ family: 'rule', declaration: RULE, dir, when: 'none', rows: [...wire.rows], output, app: APP, solution: SOL }));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'workflow-resume-child.js'), input], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.notEqual(r.pid, process.pid);
    assert.equal(r.code, 'create-completion-required');
    assert.deepEqual(r.writes, [], 'nothing is sent: the maker\'s deactivation is never undone');
    assert.equal(r.finalState, 0);
    assert.equal(r.finalVersion, version);
    assert.equal(r.token, g.pending.token, 'the same attempt, kept');
    // The maker's way out: activate the row as declared, then rerun; it is proved by reading and bound with no write.
    makerChange(firstRow(wire), 'activate');
    const settled = await settle(wire, dir, RULE);
    assert.ifError(settled.error);
    assert.deepEqual(writeLines(wire, settled.from), []);
    const done = settled.p.store.readGroup('rule', 'account/Hide fax');
    assert.equal(done.pending, null);
    assert.deepEqual(done.effects, []);
    assert.ok(done.committed);
  });
}

test('an activation another process found made while this one was about to record it is met: nothing is sent, and the attempt commits', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-met-race-');
  const contract = require('../lib/managed-feature-contract.js');
  const real = contract.withWorkflowEffect;
  // Between this run's read and its record of the activation, the maker activates the row and another process of the
  // same attempt records that fact.
  contract.withWorkflowEffect = (args, fn) => {
    if (args.effect.effect === 'state') {
      const row = wire.row(args.effect.rowId);
      makerChange(row, 'activate');
      args.store.recordFulfilledEffect({ ...args.effect }, { observedState: 'Active', observedVersion: `W/"${row.version}"` });
    }
    return real(args, fn);
  };
  let out;
  try { out = await settle(wire, dir, RULE); } finally { contract.withWorkflowEffect = real; }
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), ['POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson']);
  const g = out.p.store.readGroup('rule', 'account/Hide fax');
  assert.equal(g.pending, null);
  assert.ok(g.committed);
  assert.equal(firstRow(wire).statecode, 1);
});

// The store file of the binding store under `dir` (managed-bindings storeFileName: `<prefix><sha256 hex>.json`), outside
// the SDK workspace.
function storeFile(dir) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'sdk') walk(p); } else if (/[0-9a-f]{64}\.json$/.test(e.name)) found.push(p);
    }
  };
  walk(dir);
  assert.equal(found.length, 1, 'one binding store');
  return found[0];
}

test('the plan reserves the whole completion of the largest supported rule: the reservation covers what its commit adds to the store', async () => {
  const decl = largestRule();
  const wire = createWorkflowWire();
  const dir = makeTempDir('rule-reserve-');
  let reserve = null;
  // Read the attempt's reservation as the store file holds it, after the send and before the commit.
  const ensureMembership = async () => {
    const file = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    const attempts = JSON.stringify(file).match(/"completionReserve":\{"bytes":(\d+)/);
    reserve = attempts ? Number(attempts[1]) : null;
  };
  const out = await settle(wire, dir, decl, { ensureMembership });
  assert.ifError(out.error);
  assert.ok(reserve, 'the attempt holds a reservation');
  const grown = fs.statSync(storeFile(dir)).size;
  assert.ok(reserve >= grown, `the reservation (${reserve} bytes) covers the committed group (${grown} bytes in the store file)`);
});