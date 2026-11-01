'use strict';
// Declared business process flows on the managed settlement (lib/bpf-settlement.js settleDeclaredBpf), through the
// REAL vendored SDK and the plugin's REAL HTTP client with the workflow-effect gate, over an in-memory workflow table
// (helpers/workflow-wire.js). Every request is counted: a flow the plugin manages is one workflow row whose stage and
// step ids the create catalog reserves before anything is sent, a write is sent once inside its persisted effect, a
// lost answer is proved by reading at the reserved ids, and a change to a flow that already exists is refused before
// any request unless the conditional-edit switch is on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const { settleDeclaredBpf } = require('../lib/bpf-settlement.js');

const APP = 'contoso_app';
const SOL = 'contoso_solution';
const SWITCH = { workflowConditionalEdits: true };
const FLOW = {
  name: 'Ticket flow', entity: 'account', reconcile: 'declared',
  stages: [
    { key: 'qualify', name: 'Qualify', steps: [{ key: 'name', name: 'Name', field: 'name', required: true }] },
    { key: 'close', name: 'Close', steps: [{ key: 'fax', name: 'Fax', field: 'fax' }] },
  ],
};
const KEY = 'account/Ticket flow';
const approve = () => new Set([`bpf:${KEY}`]);
const getToken = () => 'x'.repeat(40);
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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

const catalogOf = (flow = FLOW) => createIntentCatalog([{ catalogKind: 'bpf', key: KEY, scope: { kind: 'table', solution: SOL, table: 'account' }, declaration: flow }]);

// Run one settlement in a fresh process; answers { result | error, from, p, membership } with the wire position it
// started at and the wire position at each solution-membership call.
async function settle(wire, dir, flow, extra = {}) {
  const p = await processOver(wire, dir);
  const from = wire.log.length;
  const membership = [];
  const ensureMembership = async () => { membership.push(wire.log.length); };
  try {
    const result = await settleDeclaredBpf({ flow, ...p, catalog: catalogOf(flow), halt: managedStop, instanceUrl: ORIGIN, ensureMembership, ...extra });
    return { result, from, p, membership };
  } catch (error) {
    return { error, from, p, membership };
  }
}
const writesSince = (wire, from) => wire.log.slice(from).filter((e) => e.method !== 'GET');
const writeLines = (wire, from) => wire.lines(from).filter((l) => !l.startsWith('GET'));
const ifMatchOf = (e) => e.headers['If-Match'] || e.headers['if-match'] || null;
// The ids of the stored XAML, in document order (the workflow id, then each stage and step).
const xamlIds = (wire, id) => [...new Set((wire.row(id).xaml.match(GUID) || []).map((g) => g.toLowerCase()))];
const committedOf = (p) => p.store.readGroup('bpf', KEY).committed;
const idsOf = (group) => Object.fromEntries(group.records.map((r) => [r.key, r.id]));

// The ids the catalog reserves for FLOW's create: a stage under the flow, a step under its stage.
function reservedFor(flow = FLOW) {
  const children = [];
  for (const st of flow.stages) {
    children.push({ locator: `stage:${st.key}`, childKind: 'bpfStage', keyParts: [st.key] });
    for (const p of st.steps) children.push({ locator: `step:${st.key}/${p.key}`, childKind: 'bpfStep', keyParts: [st.key, p.key], parentLocator: `stage:${st.key}` });
  }
  return catalogOf(flow).reserveChildren('bpf', KEY, { children });
}

async function created(flow = FLOW) {
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-settle-');
  const out = await settle(wire, dir, flow);
  assert.ifError(out.error);
  return { wire, dir, id: out.result.id, out };
}

test('a new declared flow is created Draft with every reserved id, proved by a read, then activated by its own state write', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-settle-');
  const out = await settle(wire, dir, FLOW);
  assert.ifError(out.error);
  const { rootId, childIds } = reservedFor();
  assert.equal(out.result.id, rootId);
  // The complete request list, reads included.
  assert.deepEqual(wire.lines(out.from), [
    'GET EntityDefinitions(LogicalName=\'workflow\')?$select',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET organizations?$select',
    'POST workflows',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
  ]);
  assert.deepEqual(writeLines(wire, out.from), ['POST workflows', 'PATCH workflows(<id>)']);
  const [create, activate] = writesSince(wire, out.from);
  assert.equal(create.body.workflowid, rootId);
  assert.equal(create.body.statecode, undefined, 'created Draft: the create carries no state');
  assert.deepEqual(activate.body, { statecode: 1, statuscode: 2 });
  assert.equal(ifMatchOf(activate), null, 'its own new Draft is activated unconditionally');
  for (const childId of Object.values(childIds)) assert.ok(xamlIds(wire, rootId).includes(childId), `the XAML keeps ${childId}`);
  const group = committedOf(out.p);
  assert.deepEqual(idsOf(group), { [KEY]: rootId, ...childIds });
  assert.deepEqual(group.records.map((r) => r.origin), group.records.map(() => 'created'));
  assert.equal(group.publication, null);
  assert.deepEqual(out.p.store.snapshot().units().map((u) => classifyPersisted(u).targets.scopes), [[]], 'a flow claims no publication scope');
  // The stored backing table is what the build gets for role grants and the app's components.
  assert.equal(out.result.uniqueName, wire.row(rootId).uniquename);
  assert.equal(out.membership.length, 1);
  assert.ok(out.membership[0] > wire.log.indexOf(activate), 'membership comes after the activation and its proof');
  assert.deepEqual(wire.deleted, []);

  const next = await settle(wire, dir, FLOW);
  assert.ifError(next.error);
  assert.equal(next.result.noop, true);
  // The complete request list, reads included.
  assert.deepEqual(wire.lines(next.from), [
    'GET EntityDefinitions(LogicalName=\'workflow\')?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
  ]);
  assert.deepEqual(writesSince(wire, next.from), []);
  assert.equal(next.result.uniqueName, out.result.uniqueName);
});

// FLOW with a new step under the stored "close" stage and a new "resolve" stage: additive only.
const GROWN = {
  ...FLOW,
  stages: [
    FLOW.stages[0],
    { ...FLOW.stages[1], steps: [...FLOW.stages[1].steps, { key: 'phone', name: 'Phone', field: 'telephone1' }] },
    { key: 'resolve', name: 'Resolve', steps: [{ key: 'web', name: 'Website', field: 'websiteurl' }] },
  ],
};

test('a create whose answer is lost is not sent again: a read at the reserved ids proves it, and binding it needs the adopt approval', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-settle-');
  wire.script((e) => e.method === 'POST' && e.path === 'workflows', { error: 'socket hang up', code: 'ECONNRESET' });
  const first = await settle(wire, dir, FLOW);
  // No answer acknowledged the create, so the row the read finds is not known to be this build's.
  assert.equal(first.error && first.error.code, CODES.adoptionRequired);
  assert.deepEqual(writeLines(wire, first.from), ['POST workflows'], 'one create, not activated');
  assert.deepEqual(first.membership, []);
  assert.ok(first.p.store.readGroup('bpf', KEY).pending, 'the attempt is kept');
  const out = await settle(wire, dir, FLOW, { approvals: approve() });
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), ['PATCH workflows(<id>)'], 'then only the activation');
  const { rootId, childIds } = reservedFor();
  assert.deepEqual(idsOf(committedOf(out.p)), { [KEY]: rootId, ...childIds });
  assert.deepEqual(committedOf(out.p).records.map((r) => r.origin), committedOf(out.p).records.map(() => 'adopted'));
  assert.equal(wire.row(rootId).statecode, 1);
  assert.equal(out.membership.length, 1);
});

test('a create the service stored with another stage id is never bound, acknowledged or not, and nothing is sent after it', async () => {
  for (const lost of [false, true]) {
    const wire = createWorkflowWire();
    const dir = makeTempDir('bpf-settle-');
    const { childIds } = reservedFor();
    const stageId = childIds['stage:close'];
    const other = '11111111-2222-4333-8444-555555555555';
    // The service keeps the row but gives one stage another id, so the sent flow is not the one stored.
    wire.script((e) => {
      if (e.method === 'POST' && e.path === 'workflows') e.body.xaml = e.body.xaml.split(stageId).join(other);
      return false;
    }, {});
    if (lost) wire.script((e) => e.method === 'POST' && e.path === 'workflows', { error: 'socket hang up', code: 'ECONNRESET' });
    const out = await settle(wire, dir, FLOW);
    assert.equal(out.error && out.error.code, 'create-completion-required', lost ? 'lost answer' : 'acknowledged');
    assert.deepEqual(writeLines(wire, out.from), ['POST workflows'], 'not activated');
    assert.deepEqual(out.membership, []);
    assert.equal(out.p.store.readGroup('bpf', KEY).committed, null, 'nothing is bound');
    const again = await settle(wire, dir, FLOW);
    assert.ok(again.error, 'a re-run does not settle it either');
    assert.deepEqual(writesSince(wire, again.from), [], 'and sends nothing');
  }
});

test('a change to a flow that exists is refused before any request unless the conditional-edit switch is on', async () => {
  const { wire, dir } = await created();
  const from = wire.log.length;
  const out = await settle(wire, dir, GROWN);
  assert.equal(out.error && out.error.code, 'workflow-edit-refused');
  assert.equal(wire.log.length, from, 'no request at all');
  assert.deepEqual(out.membership, []);
});

test('removing or reordering a stage or step is refused before any request, even with the switch on', async () => {
  const { wire, dir } = await created();
  const shapes = [
    { ...FLOW, stages: [FLOW.stages[0]] },
    { ...FLOW, stages: [FLOW.stages[1], FLOW.stages[0]] },
    { ...FLOW, stages: [FLOW.stages[0], { ...FLOW.stages[1], steps: [] }] },
  ];
  for (const flow of shapes) {
    const from = wire.log.length;
    const out = await settle(wire, dir, flow, { opts: SWITCH });
    assert.equal(out.error && out.error.code, 'bpf-structure-refused');
    assert.equal(wire.log.length, from, 'no request at all');
  }
});

test('with the switch on, an additive edit of an Active flow goes Draft, writes the body, then goes Active, each against the version just read', async () => {
  const { wire, dir, id, out: first } = await created();
  const stored = committedOf(first.p);
  const closeId = idsOf(stored)['stage:close'];
  const out = await settle(wire, dir, GROWN, { opts: SWITCH });
  assert.ifError(out.error);
  const writes = writesSince(wire, out.from);
  // The complete request list, reads included.
  assert.deepEqual(wire.lines(out.from), [
    'GET EntityDefinitions(LogicalName=\'workflow\')?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET organizations?$select',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'GET workflows(<id>)?$select',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
  ]);
  assert.deepEqual(writeLines(wire, out.from), ['PATCH workflows(<id>)', 'PATCH workflows(<id>)', 'PATCH workflows(<id>)']);
  assert.deepEqual(writes[0].body, { statecode: 0, statuscode: 1 });
  assert.ok(writes[1].body.xaml, 'the body write carries the XAML');
  assert.deepEqual(writes[2].body, { statecode: 1, statuscode: 2 });
  assert.deepEqual(writes.map(ifMatchOf), ['W/"2"', 'W/"3"', 'W/"4"']);
  // The new ids are the catalog's: a step under the stored stage id, a stage and its step under the flow.
  const { childIds } = catalogOf(GROWN).reserveChildren('bpf', KEY, {
    actualRootId: id,
    children: [
      { locator: 'step:close/phone', childKind: 'bpfStep', keyParts: ['close', 'phone'], actualParentId: closeId },
      { locator: 'stage:resolve', childKind: 'bpfStage', keyParts: ['resolve'] },
      { locator: 'step:resolve/web', childKind: 'bpfStep', keyParts: ['resolve', 'web'], parentLocator: 'stage:resolve' },
    ],
  });
  const ids = idsOf(committedOf(out.p));
  for (const [locator, childId] of Object.entries(childIds)) assert.equal(ids[locator], childId, locator);
  for (const [locator, childId] of Object.entries(idsOf(stored))) assert.equal(ids[locator], childId, `${locator} is kept`);
  for (const [locator, childId] of Object.entries(ids)) if (locator !== KEY) assert.ok(xamlIds(wire, id).includes(childId), locator);
  assert.equal(wire.row(id).statecode, 1);
  assert.ok(out.membership[0] > wire.log.indexOf(writes[2]), 'membership comes after the proof');

  const next = await settle(wire, dir, GROWN, { opts: SWITCH });
  assert.ifError(next.error);
  assert.equal(next.result.noop, true);
  assert.deepEqual(writesSince(wire, next.from), []);
});

test('a body write the service acknowledged but did not apply is never bound and never sent again; its ids stay the catalog ids', async () => {
  const { wire, dir, id } = await created();
  wire.script((e) => e.method === 'PATCH' && e.body && e.body.xaml, { statusCode: 204, unapplied: true });
  const out = await settle(wire, dir, GROWN, { opts: SWITCH });
  assert.equal(out.error && out.error.code, 'create-completion-required');
  assert.deepEqual(out.membership, []);
  assert.equal(idsOf(out.p.store.readGroup('bpf', KEY).committed)['stage:resolve'], undefined, 'the new stage is not bound');
  const sent = writesSince(wire, out.from).filter((e) => e.body && e.body.xaml);
  assert.equal(sent.length, 1);
  const sentIds = new Set(sent[0].body.xaml.match(GUID).map((g) => g.toLowerCase()));

  const retry = await settle(wire, dir, GROWN, { opts: SWITCH });
  assert.equal(retry.error && retry.error.code, CODES.pending, 'an unproved write stays pending');
  assert.deepEqual(writesSince(wire, retry.from), [], 'and is not sent again');
  // The ids it was sent with are the ones the catalog derives in any process: nothing is reminted.
  const closeId = idsOf(out.p.store.readGroup('bpf', KEY).committed)['stage:close'];
  const { childIds } = catalogOf(GROWN).reserveChildren('bpf', KEY, {
    actualRootId: id,
    children: [
      { locator: 'step:close/phone', childKind: 'bpfStep', keyParts: ['close', 'phone'], actualParentId: closeId },
      { locator: 'stage:resolve', childKind: 'bpfStage', keyParts: ['resolve'] },
      { locator: 'step:resolve/web', childKind: 'bpfStep', keyParts: ['resolve', 'web'], parentLocator: 'stage:resolve' },
    ],
  });
  for (const childId of Object.values(childIds)) assert.ok(sentIds.has(childId), `sent with the catalog id ${childId}`);
  assert.equal(xamlIds(wire, id).includes(childIds['stage:resolve']), false, 'the row never took it');
});
test('an enforcing service refuses a stale body write (412) and keeps the competing change; the non-enforcing control would overwrite it', async () => {
  const competing = async (enforceIfMatch) => {
    const wire = createWorkflowWire({ enforceIfMatch });
    const dir = makeTempDir('bpf-settle-');
    const first = await settle(wire, dir, FLOW);
    assert.ifError(first.error);
    const id = first.result.id;
    let fired = false;
    wire.script((e) => {
      if (!fired && e.method === 'PATCH' && e.body && e.body.xaml) {
        fired = true;
        const row = wire.row(id);
        row.name = 'Ticket flow (renamed elsewhere)';
        row.version += 1;
      }
      return false;
    }, {});
    const out = await settle(wire, dir, GROWN, { opts: SWITCH });
    return { wire, id, out };
  };
  const enforcing = await competing(true);
  assert.equal(enforcing.out.error && enforcing.out.error.code, 'bpf-drift');
  assert.equal(writesSince(enforcing.wire, enforcing.out.from).filter((e) => e.body && e.body.xaml).length, 1, 'sent once, not retried');
  assert.equal(enforcing.wire.row(enforcing.id).name, 'Ticket flow (renamed elsewhere)', 'the competing change survives');
  assert.deepEqual(enforcing.out.membership, []);

  const control = await competing(false);
  assert.equal(control.wire.row(control.id).name, 'Ticket flow', 'a service that ignores the version loses the competing change');
});

test('a flow of the same name the spec does not manage is never adopted without approval, and adoption needs its whole body', async () => {
  const { wire } = await created();
  const dir = makeTempDir('bpf-settle-');
  const from = wire.log.length;
  const refused = await settle(wire, dir, FLOW);
  assert.equal(refused.error && refused.error.code, 'create-ownership-required');
  assert.deepEqual(writesSince(wire, from), []);
  const partial = await settle(wire, dir, { ...FLOW, stages: [FLOW.stages[0]] }, { approvals: approve() });
  assert.equal(partial.error && partial.error.code, 'bpf-whole-body-required');
  const adopted = await settle(wire, dir, FLOW, { approvals: approve() });
  assert.ifError(adopted.error);
  assert.deepEqual(writesSince(wire, from), [], 'adoption writes nothing');
  assert.deepEqual(committedOf(adopted.p).records.map((r) => r.origin), committedOf(adopted.p).records.map(() => 'adopted'));
});
test('an unmanaged shape is refused before any request, and a managed flow changed outside the spec is drift, not overwritten', async () => {
  const { wire, dir, id } = await created();
  const from = wire.log.length;
  const branching = { ...FLOW, stages: [{ ...FLOW.stages[0], nextStage: 'close' }, FLOW.stages[1]] };
  const shape = await settle(wire, dir, branching, { opts: SWITCH });
  assert.equal(shape.error && shape.error.code, 'bpf-shape-unsupported');
  assert.equal(wire.log.length, from, 'no request at all');

  wire.row(id).name = 'Renamed by hand';
  wire.row(id).version += 1;
  const drift = await settle(wire, dir, FLOW, { opts: SWITCH });
  assert.equal(drift.error && drift.error.code, 'bpf-drift');
  assert.deepEqual(writesSince(wire, drift.from), []);
  assert.equal(wire.row(id).name, 'Renamed by hand');
});
test('a create whose answer is lost and that has not appeared stays pending and is never sent again; once a read proves it, only its activation is sent', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-settle-');
  wire.script((e) => e.method === 'POST' && e.path === 'workflows', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
  const first = await settle(wire, dir, FLOW);
  assert.equal(first.error && first.error.code, CODES.pending);
  assert.deepEqual(writeLines(wire, first.from), ['POST workflows']);
  const sent = writesSince(wire, first.from)[0].body;

  const still = await settle(wire, dir, FLOW);
  assert.equal(still.error && still.error.code, CODES.pending);
  assert.deepEqual(writesSince(wire, still.from), [], 'an unproved create is not sent again');

  // The service carried the create out after all. No answer said so, so binding it needs the adopt approval.
  const id = String(sent.workflowid).toLowerCase();
  wire.rows.set(id, { ...sent, kind: 'bpf', workflowid: id, statecode: 0, statuscode: 1, version: 1 });
  const unapproved = await settle(wire, dir, FLOW);
  assert.equal(unapproved.error && unapproved.error.code, CODES.adoptionRequired);
  assert.deepEqual(writesSince(wire, unapproved.from), [], 'nothing is sent before the approval');
  const out = await settle(wire, dir, FLOW, { approvals: approve() });
  assert.ifError(out.error);
  assert.equal(out.result.id, id);
  assert.deepEqual(writeLines(wire, out.from), ['PATCH workflows(<id>)'], 'only its own activation is sent');
  const group = committedOf(out.p);
  assert.deepEqual(group.records.map((r) => r.origin), group.records.map(() => 'adopted'), 'an unacknowledged create is not recorded as created');
  assert.deepEqual(idsOf(group), { [KEY]: id, ...reservedFor().childIds });
  assert.equal(out.membership.length, 1);
});
test('an edit stopped between its body and its own activation: only a conditional 412 proves no start, and only the switch sends it again', async () => {
  const { wire, dir, id } = await created();
  let bodySeen = false;
  wire.script((e) => {
    if (e.method === 'PATCH' && e.body && e.body.xaml) bodySeen = true;
    return bodySeen && e.method === 'PATCH' && e.body && e.body.statecode === 1;
  }, { statusCode: 412, body: { error: { code: '0x80060882', message: 'precondition failed' } }, unapplied: true });
  const first = await settle(wire, dir, GROWN, { opts: SWITCH });
  assert.equal(first.error && first.error.code, 'bpf-drift', 'a refused precondition reads as drift');
  assert.equal(wire.row(id).statecode, 0, 'left Draft with the new body');
  assert.deepEqual(first.membership, []);

  // Without the switch the rerun may only read: setting the existing flow Active is a state change of a live row.
  const refused = await settle(wire, dir, GROWN);
  assert.equal(refused.error && refused.error.code, 'workflow-edit-refused');
  assert.deepEqual(writesSince(wire, refused.from), [], 'no write without the switch');

  const again = await settle(wire, dir, GROWN, { opts: SWITCH });
  assert.ifError(again.error);
  assert.equal(again.result.recovered, true);
  const writes = writesSince(wire, again.from);
  assert.deepEqual(writes.map((e) => e.body), [{ statecode: 1, statuscode: 2 }], 'only the activation, sent once more');
  assert.equal(ifMatchOf(writes[0]), `W/"${wire.row(id).version - 1}"`, 'against the version just read');
  assert.equal(wire.row(id).statecode, 1);
  assert.equal(again.membership.length, 1);
  assert.ok(idsOf(committedOf(again.p))['stage:resolve']);
});

test('an answered refusal or a lost answer to an activation is not proof that it never started: it is never sent again', async () => {
  const answers = [
    ['generic-400', { statusCode: 400, body: { error: { code: '0x80040203', message: 'busy' } }, unapplied: true }, 'workflow-state-path-unavailable'],
    ['lost', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true }, CODES.pending],
  ];
  for (const [label, answer, firstCode] of answers) {
    const { wire, dir, id } = await created();
    let bodySeen = false;
    wire.script((e) => {
      if (e.method === 'PATCH' && e.body && e.body.xaml) bodySeen = true;
      return bodySeen && e.method === 'PATCH' && e.body && e.body.statecode === 1;
    }, answer);
    const first = await settle(wire, dir, GROWN, { opts: SWITCH });
    assert.equal(first.error && first.error.code, firstCode, label);
    const { effects } = first.p.store.readGroup('bpf', KEY);
    assert.deepEqual(effects.map((e) => e.state).slice(-1), ['unconfirmed'], `${label}: the activation stays unconfirmed`);
    const again = await settle(wire, dir, GROWN, { opts: SWITCH });
    assert.equal(again.error && again.error.code, CODES.pending, label);
    assert.deepEqual(writesSince(wire, again.from), [], `${label}: never sent again`);
    assert.equal(wire.row(id).statecode, 0);
  }
  // The same holds for a new flow's own activation: it is never deleted and never sent again.
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-settle-');
  wire.script((e) => e.method === 'PATCH', answers[0][1]);
  const out = await settle(wire, dir, FLOW);
  assert.equal(out.error && out.error.code, 'workflow-state-path-unavailable');
  const again = await settle(wire, dir, FLOW);
  assert.equal(again.error && again.error.code, CODES.pending);
  assert.deepEqual(writesSince(wire, again.from), []);
  assert.deepEqual(wire.deleted, []);
});

const flowCopy = (dir, id) => [path.join(dir, 'sdk', 'business-process-flows', `${id}.json`), path.join(dir, 'sdk', '.metadata', 'business-process-flows', `${id}.meta.json`)];
const causeCategory = (err) => { for (let e = err; e; e = e.cause) if (e.category) return e.category; return null; };

test('a local copy with an edit no run sent stops every path before any request and is kept byte for byte', async () => {
  const { wire, dir, id } = await created();
  const p = await processOver(wire, dir);
  await p.sdk.updateElement('bpf', id, '/stages/0/name', 'Edited by hand');
  const [file] = flowCopy(dir, id);
  const bytes = fs.readFileSync(file);
  for (const [flow, extra] of [[FLOW, {}], [GROWN, { opts: SWITCH }], [{ ...FLOW, status: 'Draft' }, { opts: SWITCH }], [FLOW, {}]]) {
    const out = await settle(wire, dir, flow, extra);
    assert.equal(out.error && out.error.code, 'create-completion-required');
    assert.equal(causeCategory(out.error), 'workspace-copy-unsent-edits');
    assert.deepEqual(wire.log.slice(out.from), [], 'no request at all');
    assert.deepEqual(fs.readFileSync(file), bytes, 'the local copy is kept');
  }
  for (const f of flowCopy(dir, id)) fs.rmSync(f, { force: true });
  const next = await settle(wire, dir, FLOW);
  assert.ifError(next.error);
  assert.equal(next.result.noop, true);
});

test('an approved adoption whose row is gone before it is bound never recreates it', async () => {
  const seed = await created();
  const wire = seed.wire;
  const dir = makeTempDir('bpf-settle-');
  const failing = async () => { throw new Error('solution membership failed'); };
  const first = await settle(wire, dir, FLOW, { approvals: approve(), ensureMembership: failing });
  assert.ok(first.error);
  assert.deepEqual(writesSince(wire, first.from), []);
  wire.rows.delete(seed.id);
  for (const extra of [{}, { approvals: approve() }, { approvals: approve(), opts: SWITCH }]) {
    const out = await settle(wire, dir, FLOW, extra);
    assert.ok(out.error, 'it stops');
    assert.deepEqual(writesSince(wire, out.from), [], 'no POST and no PATCH');
    assert.equal(wire.rows.size, 0, 'no row is recreated');
  }
});

test('a state-only change is one conditional state write with no body, and is refused unsent by default', async () => {
  const { wire, dir, id } = await created({ ...FLOW, status: 'Draft' });
  const active = { ...FLOW, status: 'Active' };
  const refused = await settle(wire, dir, active);
  assert.equal(refused.error && refused.error.code, 'workflow-edit-refused');
  assert.deepEqual(wire.log.slice(refused.from), [], 'the default refusal sends no request');
  const before = wire.row(id).xaml;
  const out = await settle(wire, dir, active, { opts: SWITCH });
  assert.ifError(out.error);
  // The complete request list, reads included.
  assert.deepEqual(wire.lines(out.from), [
    'GET EntityDefinitions(LogicalName=\'workflow\')?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
    'PATCH workflows(<id>)',
    'GET workflows?$select',
    'GET workflows?$select',
    'GET workflows(<id>)?$select',
  ]);
  assert.deepEqual(writeLines(wire, out.from), ['PATCH workflows(<id>)']);
  const [write] = writesSince(wire, out.from);
  assert.deepEqual(write.body, { statecode: 1, statuscode: 2 });
  assert.equal(ifMatchOf(write), `W/"${wire.row(id).version - 1}"`);
  assert.equal(wire.row(id).xaml, before, 'no definition push');
  assert.equal((await settle(wire, dir, active)).result.noop, true);
});

test('a live flow whose XAML holds an activity this module does not model is refused on every path, unsent', async () => {
  const foreign = [
    // An opaque activity in a stage's own Activities collection (a stage action).
    ['stage', (xaml) => { let n = 0; return xaml.replace(/<sco:Collection x:TypeArguments="Activity" x:Key="Activities">/g, (tag) => (++n === 2 ? `${tag}<Sequence DisplayName="Foreign stage activity"><WriteLine Text="foreign" /></Sequence>` : tag)); }],
    // Another activity inside a control step.
    ['step', (xaml) => xaml.replace(/(<Sequence DisplayName="ControlStep[^"]*">)/, '$1<WriteLine Text="foreign" />')],
  ];
  for (const [where, mutate] of foreign) {
    const { wire, dir, id } = await created();
    const row = wire.row(id);
    row.xaml = mutate(row.xaml);
    assert.match(row.xaml, /foreign/, where);
    row.version += 1;
    for (const [flow, extra] of [[FLOW, {}], [{ ...FLOW, order: 124 }, { opts: SWITCH }]]) {
      const out = await settle(wire, dir, flow, extra);
      assert.equal(out.error && out.error.code, 'bpf-shape-unsupported', where);
      assert.deepEqual(writesSince(wire, out.from), [], `${where}: nothing is sent`);
    }
    // Nor is it adopted by a workspace that does not manage it.
    const adopted = await settle(wire, makeTempDir('bpf-settle-'), FLOW, { approvals: approve() });
    assert.equal(adopted.error && adopted.error.code, 'bpf-shape-unsupported', `${where}: adoption`);
    assert.deepEqual(writesSince(wire, adopted.from), []);
    assert.match(wire.row(id).xaml, /foreign/, `${where}: the activity survives`);
  }
});