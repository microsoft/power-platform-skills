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
const { settleDeclaredBpf, validateDeclaredBpf } = require('../lib/bpf-settlement.js');
const { canonicalJson } = require('../lib/reconcile-common.js');
const { largestFlow } = require('./helpers/workflow-largest.js');

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

const catalogOf = (flow = FLOW) => createIntentCatalog([{ catalogKind: 'bpf', key: KEY, scope: { kind: 'table', solution: SOL, table: 'account' }, declaration: flow }]);

// Run one settlement in a fresh process; answers { result | error, from, p, membership } with the wire position it
// started at and the wire position at each solution-membership call.
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

async function settle(wire, dir, flow, { observed = false, failLocally = false, ...extra } = {}) {
  const p = await processOver(wire, dir, { observed });
  if (failLocally) failFirstSend(p.sdk);
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
  assert.equal(ifMatchOf(activate), `W/"${wire.row(rootId).version - 1}"`, 'its own new Draft is activated against the version of the read that proved it');
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

// #796: the identity read of a flow on a table the build has only just created can meet the table's metadata-cache lag, live:
//   GET workflows?$filter=… -> HTTP 400 {"error":{"code":"0x80041102","message":"The entity with a name = 'account' with namemapping = 'Logical' was not found in the MetadataCache…"}}
// With the caller's `freshTable`, that read's failure is marked so the stop is one the build's bounded retry may ride out (retryPolicyFor: SERVICE); nothing is sent, and the next settlement creates the flow once.
// Without it, for another table's answer and for any other answer, the stop stays final.
const notInCache = (table) => `The entity with a name = '${table}' with namemapping = 'Logical' was not found in the MetadataCache.LazyDynamicMetadataCache with version 9495075 and timestamp 9495075`;
const nameRead = (e) => e.method === 'GET' && e.path === 'workflows';
const answer400 = (code, message) => ({ statusCode: 400, body: { error: { code, message } } });

test('an identity read that meets the metadata-cache lag of a table the build just created stops as the retry may ride out, sends nothing, and the next settlement creates once', async () => {
  const { retryPolicyFor, isFreshTableReadLag } = require('../lib/retry-policy.js');
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-settle-');
  wire.script(nameRead, answer400('0x80041102', notInCache('account')));
  const first = await settle(wire, dir, FLOW, { freshTable: 'account' });
  assert.equal(first.error && first.error.cause && first.error.cause.code, 'create-identity-unverified');
  assert.equal(retryPolicyFor(first.error.cause), RETRY.SERVICE, 'the lag of a table this invocation created');
  assert.equal(isFreshTableReadLag(first.error.cause), true);
  assert.deepEqual(writesSince(wire, first.from), [], 'nothing is sent');
  const again = await settle(wire, dir, FLOW, { freshTable: 'account' });
  assert.ifError(again.error);
  assert.deepEqual(writeLines(wire, again.from).filter((l) => l === 'POST workflows'), ['POST workflows'], 'one create');
  assert.equal(wire.rows.size, 1);
});

test('an identity read that fails for a table the build did not create, for another table, or with any other answer stays final', async () => {
  const { retryPolicyFor, isFreshTableReadLag } = require('../lib/retry-policy.js');
  for (const [label, answer, freshTable] of [
    ['no freshTable', answer400('0x80041102', notInCache('account')), undefined],
    ['the answer names another table', answer400('0x80041102', notInCache('contoso_other')), 'account'],
    ['an unrelated 400', answer400('0x80040265', 'The value of the attribute is not valid'), 'account'],
    ['the cache words under another code', answer400('0x80040220', notInCache('account')), 'account'],
  ]) {
    const wire = createWorkflowWire();
    const dir = makeTempDir('bpf-settle-');
    wire.script(nameRead, answer);
    const out = await settle(wire, dir, FLOW, freshTable ? { freshTable } : {});
    assert.equal(out.error && out.error.cause && out.error.cause.code, 'create-identity-unverified', label);
    assert.equal(retryPolicyFor(out.error.cause), RETRY.NEVER, label);
    assert.equal(isFreshTableReadLag(out.error.cause), false, label);
    assert.deepEqual(writesSince(wire, out.from), [], `${label}: nothing is sent`);
  }
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
  assert.deepEqual(wire.log.slice(refused.from), [], 'its recorded activation is refused by the preflight, before any read');

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
  for (const [flow, extra] of [[FLOW, {}], [GROWN, { opts: SWITCH }], [{ ...FLOW, status: 'Draft' }, { opts: SWITCH }], [FLOW, {}], [FLOW, { freshTable: 'account' }]]) {
    const out = await settle(wire, dir, flow, extra);
    assert.equal(out.error && out.error.code, 'create-completion-required');
    assert.equal(causeCategory(out.error), 'workspace-copy-unsent-edits');
    // A table the build just created changes nothing here (#796): the stop is the local copy's, never the lag's.
    assert.equal(require('../lib/retry-policy.js').isFreshTableReadLag(out.error), false);
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
    assert.equal(out.error.code, 'create-completion-required', 'an adoption never takes the create branch');
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

test('a live flow whose XAML holds an activity or an expression this module does not model is refused on every path, unsent', async () => {
  const EXPR = '[System.String.Concat(&quot;foreign&quot;, System.DateTime.UtcNow.ToString())]';
  const foreign = [
    // An opaque activity in a stage's own Activities collection (a stage action).
    ['stage', (xaml) => { let n = 0; return xaml.replace(/<sco:Collection x:TypeArguments="Activity" x:Key="Activities">/g, (tag) => (++n === 2 ? `${tag}<Sequence DisplayName="Foreign stage activity"><WriteLine Text="foreign" /></Sequence>` : tag)); }],
    // Another activity inside a control step.
    ['step', (xaml) => xaml.replace(/(<Sequence DisplayName="ControlStep[^"]*">)/, '$1<WriteLine Text="foreign" />')],
    // A control argument written as a Visual Basic expression (text) instead of a Literal: the SDK's stages and steps
    // read the same, so only the XAML shows it.
    ['expression argument', (xaml) => xaml.replace(/(<mcwb:Control\.Parameters><InArgument[^>]*>)<Literal[^>]*\/>/, `$1${EXPR}`)],
    // An expression beside a Literal in the same argument.
    ['expression beside a literal', (xaml) => xaml.replace(/(<mcwb:Control\.Parameters><InArgument[^>]*><Literal[^>]*\/>)/, `$1${EXPR}`)],
    // An expression in an argument's attribute form.
    ['inline expression', (xaml) => xaml.replace(/<mcwb:Control /, `<mcwb:Control ControlDisplayName="${EXPR}" `)],
    // An expression activity as the argument's value.
    ['value activity', (xaml) => xaml.replace(/(<mcwb:Control\.Parameters><InArgument[^>]*>)<Literal[^>]*\/>/, '$1<mva:VisualBasicValue x:TypeArguments="x:String" ExpressionText="&quot;foreign&quot;" />')],
    // Text directly inside a control step, between its activities.
    ['text in a control step', (xaml) => xaml.replace(/(<Sequence DisplayName="ControlStep[^"]*">)/, '$1foreign')],
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

test('a linear flow whose control steps are renamed, unnamed or indented is still managed: a no-op reads only, an edit is not refused', async () => {
  const variants = [
    // A control step is known by its structure, not its DisplayName ("ControlStep4" when the SDK writes it).
    ['renamed', (xaml) => xaml.replace(/(<Sequence\b[^>]*?)\sDisplayName="ControlStep[^"]*"/g, '$1 DisplayName="Contact details"')],
    ['unnamed', (xaml) => xaml.replace(/(<Sequence\b[^>]*?)\sDisplayName="ControlStep[^"]*"/g, '$1')],
    // Whitespace between elements is not content.
    ['indented', (xaml) => xaml.replace(/></g, '>\n    <')],
  ];
  for (const [how, mutate] of variants) {
    const { wire, dir, id } = await created();
    const row = wire.row(id);
    const next = mutate(row.xaml);
    assert.notEqual(next, row.xaml, how);
    row.xaml = next;
    row.version += 1;
    const noop = await settle(wire, dir, FLOW);
    assert.ifError(noop.error);
    assert.equal(noop.result.noop, true, `${how}: a no-op`);
    assert.deepEqual(writesSince(wire, noop.from), [], `${how}: nothing is sent`);
    const edit = await settle(wire, dir, { ...FLOW, order: 124 }, { opts: SWITCH });
    assert.ifError(edit.error);
    assert.ok(writesSince(wire, edit.from).length, `${how}: the edit is sent`);
  }
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
  const edit = await settle(wire, dir, { ...FLOW, order: 124 }, { opts: SWITCH });
  assert.ifError(edit.error);
  assert.ok(seen.length, 'the edit records effects');
  assert.ok(seen.every(([, on]) => on === true), `with the switch on, each effect says so: ${JSON.stringify(seen)}`);
});

test('a create that failed on this side before any request is sent again under its own token: continued with the send observer, resumed without it', async () => {
  const clean = createWorkflowWire();
  const fresh = await settle(clean, makeTempDir('bpf-settle-'), FLOW);
  assert.ifError(fresh.error);
  for (const observed of [true, false]) {
    const wire = createWorkflowWire();
    const dir = makeTempDir('bpf-settle-');
    const first = await settle(wire, dir, FLOW, { observed, failLocally: true });
    assert.ok(first.error, `${observed}: it stops`);
    assert.deepEqual(writesSince(wire, first.from), [], `${observed}: nothing reached the service`);
    const { pending, effects } = first.p.store.readGroup('bpf', KEY);
    assert.deepEqual([pending.phase, effects.map((e) => [e.effect, e.state])], ['sending', [['create', 'definitely-unsent']]]);
    if (observed) assert.deepEqual(pending.sendWindow, { possible: 0, notStarted: 0, epoch: 1 }, 'the window saw nothing leave');

    const again = await settle(wire, dir, FLOW, { observed });
    assert.ifError(again.error);
    assert.deepEqual([again.result.recovered, again.result.continued, again.result.resumed], observed ? [true, true, undefined] : [true, undefined, true],
      `${observed}: the same attempt, ${observed ? 'continued' : 'resumed'}`);
    assert.deepEqual(writeLines(wire, again.from), writeLines(clean, fresh.from), `${observed}: exactly the writes of a first create, once`);
    const group = again.p.store.readGroup('bpf', KEY);
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
  const dir = makeTempDir('bpf-settle-');
  let out;
  try { out = await settle(wire, dir, FLOW); } finally { contract.withWorkflowEffect = real; }
  assert.deepEqual(reached, ['create', 'state'], 'the activation reached the shared gate');
  assert.ok(out.error, 'the run stops');
  assert.equal(out.error.code, 'workflow-edit-refused', `the gate's code, not a TypeError: ${out.error.message}`);
  assert.ok(!/TypeError|Cannot read/.test(String(out.error.message)), out.error.message);
  assert.deepEqual(writesSince(wire, out.from).map((e) => e.method), ['POST'], 'only the create left');
  const { pending, effects } = out.p.store.readGroup('bpf', KEY);
  assert.ok(pending, 'the attempt is kept');
  assert.deepEqual(effects.map((e) => [e.effect, e.state]), [['create', 'confirmed']], 'no state effect was recorded');

  const again = await settle(wire, dir, FLOW);
  assert.ifError(again.error);
  assert.deepEqual(writesSince(wire, again.from).map((e) => e.method), ['PATCH'], 'a later run sends only the activation, once');
});

// The ORIGINAL authored flow is the attempt's declaration (recorded before any send, committed as
// originalDeclaration); the derived state stays this module's own, so the next run is still a no-op.
test('the authored flow is recorded with the attempt and committed apart from the derived state; the next run is still a no-op', async () => {
  const authored = JSON.parse(JSON.stringify(FLOW));
  const { wire, dir, id, out } = await created();
  const group = out.p.store.readGroup('bpf', KEY).committed;
  assert.deepEqual(group.originalDeclaration, authored);
  assert.deepEqual(Object.keys(group.consumerState.declaration).sort(), ["applied","backing","flow"]);
  assert.ok(out.result.uniqueName, 'the backing table is named');
  assert.equal(out.result.uniqueName, wire.row(id).uniquename, 'the backing identity survives');
  const next = await settle(wire, dir, FLOW);
  assert.ifError(next.error);
  assert.equal(next.result.noop, true);
  assert.deepEqual(writesSince(wire, next.from), []);
  assert.equal(next.result.uniqueName, out.result.uniqueName);
  for (const observed of [true, false]) {
    const w = createWorkflowWire();
    const d = makeTempDir('bpf-settle-');
    const first = await settle(w, d, FLOW, { observed, failLocally: true });
    assert.ok(first.error);
    assert.deepEqual(first.p.store.readGroup('bpf', KEY).pending.declaration, authored, `${observed}: recorded before the send`);
    const again = await settle(w, d, FLOW, { observed });
    assert.ifError(again.error);
    assert.equal(observed ? again.result.continued : again.result.resumed, true, `${observed}: the same attempt, sent for its recorded declaration`);
    assert.deepEqual(again.p.store.readGroup('bpf', KEY).committed.originalDeclaration, authored, `${observed}: committed`);
  }
});

// ----- The default activation of the attempt's own create, against a maker's change after the read that proved it.
// The first process can be stopped inside that activation: its effect is recorded and the write's callback throws before
// any request leaves, so a later process finds the create confirmed and the activation definitely unsent.
async function heldAtActivation(wire, dir, decl = FLOW) {
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
    const next = row.xaml.replace(/(<mcwb:Control.DataFieldName><InArgument[^>]*><Literal[^>]*Value=")name(")/, '$1fax$2');
    assert.notEqual(next, row.xaml);
    row.xaml = next;
    row.version += 1;
  }
}

for (const recovery of [false, true]) {
  for (const change of ['none', 'activate', 'deactivate', 'edit']) {
    test(`the own activation ${recovery ? 'resumed by a later process' : 'of a first create'} is held to the version of the read that proved it (maker: ${change})`, async () => {
      const wire = createWorkflowWire();
      const dir = makeTempDir('bpf-settle-');
      let token = null;
      if (recovery) {
        const first = await heldAtActivation(wire, dir);
        assert.ok(first.error);
        const g = first.p.store.readGroup('bpf', KEY);
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
      const out = await settle(wire, dir, FLOW);
      const row = [...wire.rows.values()][0];
      assert.ok(seen, 'the activation reached the service');
      assert.equal(seen.ifMatch, `W/"${seen.read}"`, 'it carries the version of the read that proved the body');
      assert.equal(writesSince(wire, out.from).filter((e) => e.method === 'PATCH').length, 1, 'one activation, never sent again');
      const g = out.p.store.readGroup('bpf', KEY);
      if (change === 'none' || change === 'activate') {
        assert.ifError(out.error);
        assert.equal(row.statecode, 1);
        // Activated by this write, or already Active with exactly the proved body: then it is met without this write (kept as a
        // fulfilled fact until the commit) and nothing is written.
        assert.equal(row.version, change === 'none' ? seen.after + 1 : seen.after);
        assert.equal(g.pending, null);
        assert.deepEqual(g.effects, []);
        assert.deepEqual(g.committed.records.map((r) => r.origin), g.committed.records.map(() => 'created'));
        const next = await settle(wire, dir, FLOW);
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
      const next = await settle(wire, dir, FLOW);
      assert.equal(next.error.code, 'create-completion-required', 'a later run refuses the same way');
      assert.deepEqual(writesSince(wire, next.from), [], 'and sends nothing');
      assert.equal(next.p.store.readGroup('bpf', KEY).pending.token, g.pending.token);
    });
  }
}

test('an activation recorded without a row version is never sent; once the maker activates the proved row it settles with no write', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-settle-');
  const contract = require('../lib/managed-feature-contract.js');
  const real = contract.withWorkflowEffect;
  // Stop before the activation is recorded, then record it as an unconditional activation was recorded before.
  contract.withWorkflowEffect = (args, fn) => (args.effect.effect === 'state'
    ? Promise.reject(Object.assign(new Error('stopped before the activation was recorded'), { code: 'LOCAL_STOP' })) : real(args, fn));
  let first;
  try { first = await settle(wire, dir, FLOW); } finally { contract.withWorkflowEffect = real; }
  assert.ok(first.error);
  const { pending, effects } = first.p.store.readGroup('bpf', KEY);
  assert.deepEqual(effects.map((e) => [e.effect, e.state]), [['create', 'confirmed']]);
  first.p.store.recordWorkflowEffect({
    attemptToken: pending.token, baseGeneration: null, family: 'bpf', key: KEY, rowId: pending.root.id, effect: 'state',
    request: { method: 'PATCH', shape: 'workflow-patch' }, desiredSha256: null, desiredState: 'Active', expectedVersion: null,
  });
  const again = await settle(wire, dir, FLOW);
  assert.equal(again.error.code, 'create-completion-required');
  assert.match(again.error.cause.message, /without the row version/);
  assert.deepEqual(writesSince(wire, again.from), []);
  assert.equal(wire.row(pending.root.id).statecode, 0);
  assert.equal(again.p.store.readGroup('bpf', KEY).pending.token, pending.token);
  // The maker activates the row as declared: a fresh read proves it, and the record settles with nothing sent.
  makerChange(wire.row(pending.root.id), 'activate');
  const settled = await settle(wire, dir, FLOW);
  assert.ifError(settled.error);
  assert.deepEqual(writesSince(wire, settled.from), []);
  const g = settled.p.store.readGroup('bpf', KEY);
  assert.equal(g.pending, null);
  assert.ok(g.committed);
  assert.equal(settled.result.id, pending.root.id);
});

for (const when of ['before-read', 'at-activation']) {
  test(`a separate OS process resuming the activation never activates a Draft the maker changed ${when}`, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('bpf-settle-');
    const first = await heldAtActivation(wire, dir);
    const token = first.p.store.readGroup('bpf', KEY).pending.token;
    const input = path.join(dir, 'child-input.json');
    const output = path.join(dir, 'child-output.json');
    fs.writeFileSync(input, JSON.stringify({ family: 'bpf', declaration: FLOW, dir, when, rows: [...wire.rows], output, app: APP, solution: SOL }));
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

test('the largest supported flow (30 stages of 30 steps) commits with its authored declaration whole, and the next run is a no-op', async () => {
  const decl = largestFlow(FLOW.name);
  assert.deepEqual(validateDeclaredBpf(decl), []);
  const bytes = Buffer.byteLength(canonicalJson(decl), 'utf8');
  assert.ok(bytes > 128 * 1024 && bytes <= DECLARATION_MAX_BYTES, `${bytes} bytes, inside the store's declaration bound`);
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-largest-');
  const out = await settle(wire, dir, decl);
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), ['POST workflows', 'PATCH workflows(<id>)']);
  const { committed } = out.p.store.readGroup('bpf', KEY);
  assert.equal(canonicalJson(committed.originalDeclaration), canonicalJson(decl), 'the authored declaration is kept whole');
  assert.equal(out.result.uniqueName, wire.row(out.result.id).uniquename, 'the proved backing survives');
  const again = await settle(wire, dir, decl);
  assert.ifError(again.error);
  assert.deepEqual(writeLines(wire, again.from), []);
  assert.equal(again.result.uniqueName, out.result.uniqueName);
});

for (const missing of ['httpClient', 'instanceUrl']) {
  test(`without the ${missing} the conditional activation needs, it stops workflow-state-path-unavailable before the activation is recorded`, async () => {
    const wire = createWorkflowWire();
    const out = await settle(wire, makeTempDir('bpf-no-state-path-'), FLOW, { [missing]: null });
    assert.equal(out.error && out.error.code, 'workflow-state-path-unavailable');
    assert.deepEqual(out.p.store.readGroup('bpf', KEY).effects.map((e) => [e.effect, e.state]), [['create', 'confirmed']]);
    assert.deepEqual(writeLines(wire, out.from), ['POST workflows']);
  });
}

test('an activation the service keeps refusing at the proved version is not applied and kept; activating the verified row, then rerunning, settles it with no write', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-refused-412-');
  let token = null;
  for (let run = 0; run < 2; run++) {
    // A 412 that changes nothing: the row stays at the version the activation was proved against.
    wire.script((e) => e.method === 'PATCH' && e.body && e.body.statecode === 1, { statusCode: 412, unapplied: true, body: { error: { code: '0x80060882', message: 'The version of the existing record doesn\'t match the RowVersion property provided.' } } });
    const out = await settle(wire, dir, FLOW);
    assert.equal(out.error && out.error.code, CODES.pending);
    const message = out.error.cause.message;
    assert.match(message, /was not applied/);
    assert.doesNotMatch(message, /was not sent/, 'an answered 412 proves a refusal, not that nothing was sent');
    assert.match(message, /activate the process flow yourself if it is as declared, then rerun/);
    const { pending } = out.p.store.readGroup('bpf', KEY);
    token = token || pending.token;
    assert.equal(pending.token, token, 'the same attempt is kept');
    assert.equal(writesSince(wire, out.from).filter((e) => e.method === 'PATCH').length, 1, 'one conditional activation per run');
  }
  const row = [...wire.rows.values()][0];
  assert.equal(row.version, 1);
  Object.assign(row, { statecode: 1, statuscode: 2 });
  row.version += 1;
  const final = await settle(wire, dir, FLOW);
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
    const dir = makeTempDir('bpf-met-');
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
    const first = await settle(wire, dir, FLOW, { ensureMembership: failingMembership });
    assert.ok(first.error);
    assert.equal(firstRow(wire).statecode, 1);
    assert.deepEqual(writeLines(wire, first.from), mode === 'already-active' ? ['POST workflows'] : ['POST workflows', 'PATCH workflows(<id>)']);
    const g = first.p.store.readGroup('bpf', KEY);
    assert.deepEqual(g.effects.map((e) => [e.effect, e.state]), [['create', 'confirmed'], ['state', mode === 'sent' ? 'confirmed' : 'fulfilled']]);
    // The maker deactivates the row, outside the plugin; a separate OS process then settles the same declaration.
    makerChange(firstRow(wire), 'deactivate');
    const version = firstRow(wire).version;
    const input = path.join(dir, 'child-input.json');
    const output = path.join(dir, 'child-output.json');
    fs.writeFileSync(input, JSON.stringify({ family: 'bpf', declaration: FLOW, dir, when: 'none', rows: [...wire.rows], output, app: APP, solution: SOL }));
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
    const settled = await settle(wire, dir, FLOW);
    assert.ifError(settled.error);
    assert.deepEqual(writeLines(wire, settled.from), []);
    const done = settled.p.store.readGroup('bpf', KEY);
    assert.equal(done.pending, null);
    assert.deepEqual(done.effects, []);
    assert.ok(done.committed);
  });
}

test('an activation another process found made while this one was about to record it is met: nothing is sent, and the attempt commits', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-met-race-');
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
  try { out = await settle(wire, dir, FLOW); } finally { contract.withWorkflowEffect = real; }
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), ['POST workflows']);
  const g = out.p.store.readGroup('bpf', KEY);
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

test('the plan reserves the whole completion of the largest supported flow: the reservation covers what its commit adds to the store', async () => {
  const decl = largestFlow(FLOW.name);
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-reserve-');
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
// A valid flow dense in stages and steps: each step is a few bytes of the declaration but is kept again in the derived
// state, the reserved ids and the proof, so the completion grows many times faster than the declaration. No count of
// stages or steps is enforced; the plan's completion bound is what decides.
function denseFlow(name, stages, steps) {
  return {
    name, entity: 'account', reconcile: 'declared', status: 'Active',
    stages: Array.from({ length: stages }, (_, i) => ({
      key: `s${i}`, name: `S${i}`, steps: Array.from({ length: steps }, (_, j) => ({ key: `p${j}`, name: `P${j}`, field: 'fax' })),
    })),
  };
}
const catalogFor = (flow) => createIntentCatalog([{ catalogKind: 'bpf', key: `account/${flow.name}`, scope: { kind: 'table', solution: SOL, table: 'account' }, declaration: flow }]);

test('the completion bound is never cut down: a dense flow near the limit is reserved whole, and one beyond it is refused by its plan before anything is recorded or sent', async () => {
  const { COMPLETION_MAX_BYTES } = require('../lib/managed-bindings.js');
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-dense-');
  // Near the limit: what the commit adds to the store from the first write on stays within the attempt's reservation.
  const near = denseFlow('Dense flow', 35, 90);
  assert.deepEqual(validateDeclaredBpf(near), []);
  let reserve = null;
  let atFirstWrite = null;
  const request = wire.request;
  wire.request = async (req) => {
    if (req.method !== 'GET' && atFirstWrite === null) atFirstWrite = fs.statSync(storeFile(dir)).size;
    return request(req);
  };
  const ensureMembership = async () => {
    const m = fs.readFileSync(storeFile(dir), 'utf8').match(/"completionReserve":\s*\{\s*"bytes":\s*(\d+)/);
    reserve = m ? Number(m[1]) : null;
  };
  const first = await settle(wire, dir, near, { catalog: catalogFor(near), ensureMembership });
  assert.ifError(first.error);
  const grown = fs.statSync(storeFile(dir)).size - atFirstWrite;
  assert.ok(reserve && reserve <= COMPLETION_MAX_BYTES, `a reservation within the limit (${reserve})`);
  assert.ok(reserve >= grown, `the reservation (${reserve} bytes) covers what the completion added (${grown} bytes)`);

  // Beyond it: a declaration well within the declaration bound whose completion needs more than one flow may reserve.
  const far = denseFlow('Denser flow', 50, 100);
  assert.deepEqual(validateDeclaredBpf(far), []);
  assert.ok(Buffer.byteLength(canonicalJson(far)) < DECLARATION_MAX_BYTES);
  const before = fs.readFileSync(storeFile(dir));
  const out = await settle(wire, dir, far, { catalog: catalogFor(far) });
  assert.equal(out.error && out.error.code, 'workflow-declaration-too-large');
  const refusal = out.error.cause || out.error;
  assert.match(refusal.message, /Reduce the process flow \(fewer stages or steps\) or split it into several process flows, then rerun/);
  assert.ok(refusal.completionBytes > COMPLETION_MAX_BYTES && refusal.completionMaxBytes === COMPLETION_MAX_BYTES);
  assert.deepEqual(writeLines(wire, out.from), []);
  const g = out.p.store.readGroup('bpf', 'account/Denser flow');
  assert.equal(g.pending, null);
  assert.deepEqual(g.effects, []);
  assert.ok(!g.committed);
  assert.ok(fs.readFileSync(storeFile(dir)).equals(before), 'the store is left byte for byte');
  assert.ok(out.p.store.readGroup('bpf', 'account/Dense flow').committed, 'the flow already settled is kept');
});

test('an activation another process records as made while this one replays it is met: nothing is sent, and the attempt commits', async () => {
  const wire = createWorkflowWire();
  const dir = makeTempDir('bpf-met-replay-');
  // The first run's activation is refused (412, not applied): it stays on record, unsent, for a later run to send.
  wire.script((e) => e.method === 'PATCH', { statusCode: 412, unapplied: true, body: { error: { message: 'Version refused' } } });
  const first = await settle(wire, dir, FLOW);
  assert.equal(first.error && first.error.code, CODES.pending);
  const stored = first.p.store.readGroup('bpf', KEY).effects.find((e) => e.effect === 'state');
  assert.equal(stored.state, 'definitely-unsent');
  // As the replay is about to send it, the maker activates the row and another OS process of the same attempt records
  // that fact; this run still holds the record it read as unsent.
  const p = await processOver(wire, dir);
  const patch = p.httpClient.patch.bind(p.httpClient);
  p.httpClient.patch = async (...args) => {
    const row = wire.row(stored.rowId);
    makerChange(row, 'activate');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'workflow-fulfil-child.js')], {
      input: JSON.stringify({ dir, origin: ORIGIN, app: APP, solution: SOL, token: stored.token, observed: { observedState: 'Active', observedVersion: `W/"${row.version}"` } }),
      env, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(child.stdout);
    assert.notEqual(r.pid, process.pid);
    assert.equal(r.state, 'fulfilled');
    return patch(...args);
  };
  const out = await settle(wire, dir, FLOW, p);
  assert.ifError(out.error);
  assert.deepEqual(writeLines(wire, out.from), []);
  const g = p.store.readGroup('bpf', KEY);
  assert.equal(g.pending, null);
  assert.ok(g.committed);
  assert.equal(firstRow(wire).statecode, 1);
});