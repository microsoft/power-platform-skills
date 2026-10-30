'use strict';
// Declared business process flows through the REAL vendored SDK over a fake workflows service that keeps the flow's row
// (XAML and all): a full projection is the baseline, a description the flow never had is added at the artifact root in
// the SAME push as the other edits, every new stage and step carries an id the creation port gave it before anything
// was changed, a refused stage list refuses the metadata too, and a no-op writes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { workflowsService, stage, flowOf, DEPLOYED } = require('./helpers/bpf-batch-service.js');
const { fakeManaged, passThroughCreates } = require('./helpers/feature-ports.js');
const { stableCreates, stableId } = require('./helpers/stable-creates.js');
const { bpfDef, inspectBpfStages } = require('../lib/sdk-build.js');
const { planBpfMetadata, applyBpfMetadata, createdBpfBinding, buildDeclaredBpf, bpfKey, stageKey, stepKey, KIND } = require('../lib/bpf-reconcile.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A workflows service with nothing deployed yet. `faults.batch(body)` may rewrite a `$batch` before the service applies it,
// `faults.get(url)` answers a workflow GET with a 500 when it returns true.
function service() {
  const svc = workflowsService({});
  const log = [];
  const faults = {};
  const client = {
    ...svc,
    get: async (url, o) => {
      if (/EntityDefinitions\(LogicalName='workflow'\)/.test(url)) return { status: 200, headers: {}, body: { EntitySetName: 'workflows' } };
      if (faults.get && faults.get(String(url))) return { status: 500, headers: {}, body: { error: { code: '0x80040216', message: 'busy' } } };
      return svc.get(url, o);
    },
    post: async (url, body, o) => { log.push(['POST', String(url)]); return svc.post(url, body, o); },
    patch: async (url, body, o) => { log.push(['PATCH', Object.keys(body)]); return svc.patch(url, body, o); },
    postRaw: async (url, body, o) => {
      log.push(['BATCH', [...String(body).matchAll(/"(\w+)":/g)].map((m) => m[1]).filter((k) => !k.startsWith('@'))]);
      return svc.postRaw(url, faults.batch ? faults.batch(String(body)) : body, o);
    },
  };
  const open = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpf-rec-'));
    dirs.push(dir);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient: client });
    await sdk.initWorkspace();
    return sdk;
  };
  const readId = async (id) => (await open()).fetchArtifact('bpf', id, { overwrite: true });
  const xamlOf = async (id) => (await svc.get(`https://contoso.crm.dynamics.com/api/data/v9.2/workflows(${id})`)).body.xaml;
  return { open, log, faults, readId, xamlOf };
}

async function deployed(flow = DEPLOYED(), status = 'Active', id = undefined) {
  const env = service();
  const creator = await env.open();
  const art = await creator.createArtifact('bpf', { ...bpfDef({ ...flow, status }), ...(id ? { id } : {}) });
  await creator.pushArtifact('bpf', art.id);
  env.log.length = 0;
  return { ...env, id: art.id, read: () => env.readId(art.id), xaml: () => env.xamlOf(art.id) };
}

// What the build does for a reused declared flow: the stage check reads the deployed flow (when the spec supplies stages),
// the plan works on that same copy, and the apply makes every edit locally before one push.
async function rebuild(env, flow, ctx = {}, flowId = env.id) {
  const sdk = await env.open();
  const before = env.log.length;
  const stageCheck = Array.isArray(flow.stages) && flow.stages.length ? await inspectBpfStages(sdk, flow, env.id) : undefined;
  const plan = await planBpfMetadata({ flow, flowId, sdk, stageCheck }, ctx);
  const result = await applyBpfMetadata(plan, { sdk }, ctx);
  return { stageCheck, plan, result, writes: env.log.slice(before) };
}
const declared = (flow, extra) => ({ ...flow, reconcile: 'declared', ...extra });
const codes = (list) => list.map((r) => r.code);
const boundAs = async (env, flow) => fakeManaged([createdBpfBinding(flow, env.id, await env.read())]);

test('a rename, a description the flow never had and a new order go to an Active flow in ONE change set; the next build writes nothing', async () => {
  const env = await deployed();
  const d = DEPLOYED();
  const managed = await boundAs(env, declared(d));
  const want = declared(flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2]]), { description: 'Ticket triage to close', order: 7 });
  const { result, writes } = await rebuild(env, want, { managed });
  assert.deepEqual(result.saved.map((s) => s.id), [env.id], JSON.stringify(result));
  assert.equal(writes.length, 1, JSON.stringify(writes));
  assert.equal(writes[0][0], 'BATCH');
  assert.ok(['description', 'processorder', 'xaml'].every((k) => writes[0][1].includes(k)));
  const after = await env.read();
  assert.deepEqual([after.description, after.order, after.stages.map((s) => s.name), after.status], ['Ticket triage to close', 7, ['Intake', 'Resolve', 'Close'], 'Active']);
  managed.persist(result.managedBindings);
  const again = await rebuild(env, want, { managed });
  assert.equal(again.plan.action, 'noChange');
  assert.equal(again.writes.length, 0);
});

test('new stages and steps carry the ids the creation port gave them, in the XAML of one push, with no child row POSTed', async () => {
  const env = await deployed();
  const d = DEPLOYED();
  const managed = await boundAs(env, declared(d));
  const want = declared(flowOf([d.stages[0], stage('Resolve', 'Notes:new_notes', 'Owner:new_owner'), d.stages[2], stage('Review', 'Approver:new_approver')]));
  const creates = stableCreates();
  const { plan, result, writes } = await rebuild(env, want, { managed, creates });
  const key = bpfKey(want);
  assert.deepEqual(plan.childKeys, [stepKey('Resolve', 'Owner'), stageKey('Review'), stepKey('Review', 'Approver')]);
  assert.equal(creates.calls.length, 1, 'one port operation reserves every child id before any edit');
  assert.equal(creates.calls[0].op.kind, KIND, 'later children are reserved in the flow\'s own creation family');
  assert.equal(creates.calls[0].op.identity.parentId, env.id, 'under the flow\'s actual id');
  assert.equal(writes.length, 1, JSON.stringify(writes));
  assert.ok(!writes.some(([verb]) => verb === 'POST'), 'no child row is posted directly');
  const ids = Object.fromEntries(plan.childKeys.map((k) => [k, stableId('stable-test', KIND, key, k)]));
  const after = await env.read();
  assert.equal(after.stages[3].id, ids[stageKey('Review')]);
  assert.equal(after.stages[3].steps[0].id, ids[stepKey('Review', 'Approver')]);
  assert.equal(after.stages[1].steps[1].id, ids[stepKey('Resolve', 'Owner')]);
  const xaml = await env.xaml();
  for (const id of Object.values(ids)) assert.ok(xaml.includes(id), `XAML holds ${id}`);
  assert.deepEqual(result.saved[0].childIds, ids);
  managed.persist(result.managedBindings);
  const again = await rebuild(env, want, { managed, creates: stableCreates() });
  assert.equal(again.plan.action, 'noChange', 'the recorded baseline names the materialized child ids');
  assert.equal(again.writes.length, 0);
});

test('a supplied stage list that would remove a stage refuses the whole request, description and status included', async () => {
  const env = await deployed();
  const d = DEPLOYED();
  const managed = await boundAs(env, declared(d));
  const want = declared(flowOf([d.stages[0], d.stages[1]]), { description: 'New text', status: 'Draft' });
  const { result, writes } = await rebuild(env, want, { managed, authorizedOverwrite: true });
  assert.deepEqual(codes(result.refused), ['bpf-stage-edit-refused']);
  assert.equal(writes.length, 0);
  const after = await env.read();
  assert.deepEqual([after.description, after.status], [undefined, 'Active']);
});

test('an omitted status is preserved; a metadata-only edit may omit stages', async () => {
  const env = await deployed(DEPLOYED(), 'Draft');
  const managed = await boundAs(env, declared(DEPLOYED()));
  const { result } = await rebuild(env, { name: 'Ticket Handling', entity: 'new_ticket', reconcile: 'declared', description: 'Only text' }, { managed });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  const after = await env.read();
  assert.deepEqual([after.description, after.status, after.stages.length], ['Only text', 'Draft', 3]);
});

test('a part changed outside the spec is drift only when this run writes it', async () => {
  const env = await deployed();
  const managed = await boundAs(env, declared(DEPLOYED()));
  const outside = await env.open();
  await outside.fetchArtifact('bpf', env.id, { overwrite: true });
  await outside.updateElement('bpf', env.id, '/order', 42);
  await outside.pushArtifact('bpf', env.id);
  const writesOrder = await rebuild(env, declared(DEPLOYED(), { order: 7 }), { managed });
  assert.deepEqual(codes(writesOrder.result.refused), ['bpf-drift']);
  assert.equal(writesOrder.writes.length, 0);
  const describes = await rebuild(env, declared(DEPLOYED(), { description: 'Text' }), { managed });
  assert.equal(describes.result.saved.length, 1, JSON.stringify(describes.result));
  assert.equal((await env.read()).order, 42, 'the part someone else changed and this run leaves alone is theirs');
});

test('clearing a description, adopting an unmanaged flow and a missing or different bound flow each stop before writing', async () => {
  const env = await deployed({ ...DEPLOYED(), description: 'Has text' });
  const managed = await boundAs(env, declared({ ...DEPLOYED(), description: 'Has text' }));
  assert.deepEqual(codes((await rebuild(env, declared(DEPLOYED(), { description: '' }), { managed })).result.refused), ['bpf-clear-not-authorized']);
  assert.deepEqual(codes((await rebuild(env, declared(DEPLOYED(), { order: 5 }), {})).result.refused), ['bpf-adoption-not-authorized']);
  const same = await rebuild(env, declared(DEPLOYED()), { managed: fakeManaged() });
  assert.equal(same.plan.action, 'noChange');
  assert.equal(same.result.managedBindings.length, 0, 'a matching flow is not bound without approval');
  assert.deepEqual(codes((await rebuild(env, declared(DEPLOYED()), { managed }, null)).result.refused), ['bpf-bound-row-missing']);
  assert.deepEqual(codes((await rebuild(env, declared(DEPLOYED()), { managed }, '00000000-0000-4000-8000-000000000009')).result.refused), ['bpf-binding-mismatch']);
  assert.equal(env.log.length, 0);
});

test('a port that fails after the push saved is unknown with no binding; without a port nothing is sent', async () => {
  const env = await deployed();
  const d = DEPLOYED();
  const want = declared(flowOf([...d.stages, stage('Review', 'Approver:new_approver')]));
  const lost = await rebuild(env, want, { managed: await boundAs(env, declared(d)), creates: stableCreates({ failAfterExecute: true }) });
  assert.deepEqual(codes(lost.result.unknown), ['bpf-write-unknown']);
  assert.equal(lost.result.managedBindings.length, 0);
  assert.equal(lost.writes.length, 1, 'the push was sent');
  const env2 = await deployed();
  const none = await rebuild(env2, want, { managed: await boundAs(env2, declared(d)) });
  assert.deepEqual(codes(none.result.refused), ['bpf-rejected']);
  assert.equal(none.writes.length, 0);
  const env3 = await deployed();
  const pass = await rebuild(env3, want, { managed: await boundAs(env3, declared(d)), creates: passThroughCreates() });
  assert.equal(pass.result.saved.length, 1, JSON.stringify(pass.result));
});

// --- The stored flow is proven before anything is bound ---------------------------------------------------------------

const keepXaml = (old) => (body) => body.replace(/"xaml":"(?:[^"\\]|\\.)*"/g, () => `"xaml":${JSON.stringify(old)}`);
const OTHER_ID = '00000000-0000-4000-8000-0000000000aa';
// The real SDK with one member replaced, for a fault the fake service cannot produce.
const withMember = (sdk, name, fn) => new Proxy(sdk, { get: (t, p) => (p === name ? fn(t) : (typeof t[p] === 'function' ? t[p].bind(t) : t[p])) });

test('a push the service acknowledged without storing the new children is create-completion-required, with no binding', async () => {
  const env = await deployed();
  const d = DEPLOYED();
  const managed = await boundAs(env, declared(d));
  env.faults.batch = keepXaml(await env.xaml());
  const want = declared(flowOf([...d.stages, stage('Review', 'Approver:new_approver')]));
  const { result, writes } = await rebuild(env, want, { managed, creates: stableCreates() });
  assert.equal(writes.length, 1, 'the push was sent and acknowledged');
  assert.deepEqual(codes(result.refused), ['create-completion-required'], JSON.stringify(result));
  assert.equal(result.saved.length, 0);
  assert.equal(result.managedBindings.length, 0, 'the intended children are never recorded as the baseline');
  assert.deepEqual((await env.read()).stages.map((s) => s.name), ['Triage', 'Resolve', 'Close']);
});

test('a flow that cannot be read back after its push, or reads back otherwise, is unknown with no binding', async () => {
  const env = await deployed();
  const managed = await boundAs(env, declared(DEPLOYED()));
  env.faults.batch = (body) => { env.faults.get = (url) => /workflows\(/i.test(url); return body; };
  const unreadable = await rebuild(env, declared(DEPLOYED(), { description: 'Text' }), { managed });
  assert.equal(unreadable.writes.length, 1);
  assert.deepEqual(codes(unreadable.result.unknown), ['bpf-stored-unreadable'], JSON.stringify(unreadable.result));
  assert.equal(unreadable.result.managedBindings.length, 0);
  // The service keeps another description than the one sent: saved, but not what was asked.
  const env2 = await deployed();
  env2.faults.batch = (body) => body.replace(/"description":"(?:[^"\\]|\\.)*"/g, '"description":"Someone else"');
  const other = await rebuild(env2, declared(DEPLOYED(), { description: 'Mine' }), { managed: await boundAs(env2, declared(DEPLOYED())) });
  assert.equal(other.writes.length, 1);
  assert.deepEqual(codes(other.result.unknown), ['bpf-stored-mismatch'], JSON.stringify(other.result));
  assert.equal(other.result.managedBindings.length, 0);
});

test('the flow an id names must be the declared table\'s flow: another table or another id is refused before anything is written', async () => {
  const env = await deployed();
  const metadataOnly = { name: DEPLOYED().name, entity: 'new_other', reconcile: 'declared', description: 'wrong table text' };
  const ctx = { authorizedAdoption: new Set([bpfKey(metadataOnly)]), managed: fakeManaged() };
  const other = await rebuild(env, metadataOnly, ctx);
  assert.deepEqual(codes(other.result.refused), ['bpf-identity-mismatch'], JSON.stringify(other.result));
  assert.equal(other.result.managedBindings.length, 0);
  const staged = await rebuild(env, declared({ ...DEPLOYED(), entity: 'new_other' }), { ...ctx, authorizedAdoption: true });
  assert.deepEqual(codes(staged.result.refused), ['bpf-identity-mismatch'], 'identity before the stage plan');
  const sdk = withMember(await env.open(), 'fetchArtifact', (t) => async (...a) => ({ ...(await t.fetchArtifact(...a)), id: OTHER_ID }));
  const flow = { name: DEPLOYED().name, entity: 'new_ticket', reconcile: 'declared', description: 'Text' };
  const plan = await planBpfMetadata({ flow, flowId: env.id, sdk }, { authorizedAdoption: true });
  const wrongId = await applyBpfMetadata(plan, { sdk }, { authorizedAdoption: true });
  assert.deepEqual(codes(wrongId.refused), ['bpf-identity-mismatch']);
  assert.equal(env.log.length, 0, 'nothing written');
  assert.equal((await env.read()).description, undefined);
});

// --- One creation family; child ids derive under the flow's actual id ---------------------------------------------------

test('later stages and steps are reserved in the flow\'s own creation family, which a port that knows only that family accepts', async () => {
  const env = await deployed();
  const d = DEPLOYED();
  const requests = [];
  const creates = {
    run: async (req, execute) => {
      requests.push(req);
      if (req.kind !== 'business-process-flow') throw Object.assign(new Error('kind absent from the agreed family catalog'), { code: 'CREATE_PORT_INVALID' });
      return stableCreates().run(req, execute);
    },
  };
  const want = declared(flowOf([...d.stages, stage('Review', 'Approver:new_approver')]));
  const { result } = await rebuild(env, want, { managed: await boundAs(env, declared(d)), creates });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  assert.deepEqual(requests.map((r) => [r.kind, r.identity.parentId]), [[KIND, env.id]]);
});

test('child ids derive under the flow\'s actual id: the same keys get the same ids at creation, when added later and under an imported flow', async () => {
  const d = DEPLOYED();
  const full = declared(flowOf([...d.stages, stage('Review', 'Approver:new_approver')]));
  // Created with all four stages.
  const fresh = service();
  const atCreate = stableCreates({ underParent: true });
  const made = await buildDeclaredBpf({ flow: full, sdk: await fresh.open(), findByName: async () => [] }, { managed: fakeManaged(), creates: atCreate }, settleHooks());
  const root = atCreate.calls[0].ids.id;
  assert.equal(made.flowId, root);
  const createdFlow = await fresh.readId(root);
  // The same root created with three stages, Review added on a later run.
  const env = await deployed(d, 'Active', root);
  const later = stableCreates({ underParent: true });
  const added = await rebuild(env, full, { managed: await boundAs(env, declared(d)), creates: later });
  assert.equal(added.result.saved.length, 1, JSON.stringify(added.result));
  assert.equal(later.calls[0].op.identity.parentId, root);
  const addedFlow = await env.read();
  assert.equal(addedFlow.stages[3].id, createdFlow.stages[3].id, 'a stage added later has the id it would have had at creation');
  assert.equal(addedFlow.stages[3].steps[0].id, createdFlow.stages[3].steps[0].id);
  // An imported flow (an id the SDK chose): the new children derive under that id.
  const imported = await deployed();
  const port = stableCreates({ underParent: true });
  await rebuild(imported, full, { managed: await boundAs(imported, declared(d)), creates: port });
  const importedFlow = await imported.read();
  assert.equal(port.calls[0].op.identity.parentId, imported.id);
  assert.equal(importedFlow.stages[3].id, stableId('stable-test', 'child', imported.id, stageKey('Review')));
  assert.notEqual(importedFlow.stages[3].id, createdFlow.stages[3].id);
});

test('a retry after an incomplete write asks for, and stores, the same child ids', async () => {
  const env = await deployed();
  const d = DEPLOYED();
  const managed = await boundAs(env, declared(d));
  const want = declared(flowOf([...d.stages, stage('Review', 'Approver:new_approver')]));
  env.faults.batch = keepXaml(await env.xaml());
  const first = stableCreates({ underParent: true });
  assert.deepEqual(codes((await rebuild(env, want, { managed, creates: first })).result.refused), ['create-completion-required']);
  delete env.faults.batch;
  const second = stableCreates({ underParent: true });
  const retry = await rebuild(env, want, { managed, creates: second });
  assert.equal(retry.result.saved.length, 1, JSON.stringify(retry.result));
  assert.deepEqual(second.calls[0].ids.childIds, first.calls[0].ids.childIds);
  const after = await env.read();
  assert.equal(after.stages[3].id, first.calls[0].ids.childIds[stageKey('Review')]);
});

// --- A declared flow end to end: resolve, create or reconcile, prove, settle ---------------------------------------------

function settleHooks(extra = {}) {
  const events = [];
  return {
    events,
    onCreated: async (id) => { events.push(['created', id]); },
    onExisting: async (id) => { events.push(['existing', id]); },
    settleFeatureResult: (phase, label, r) => {
      events.push(['settle', phase, label, r]);
      return { ok: !r.refused.length && !r.unknown.length };
    },
    ...extra,
  };
}
const settled = (hooks) => hooks.events.filter((e) => e[0] === 'settle').map((e) => e[3]);

test('a new declared flow is created with the port\'s root and child ids, proven by a fresh read, then added to the solution and settled', async () => {
  const env = service();
  const flow = declared(DEPLOYED(), { description: 'Ticket flow' });
  const creates = stableCreates();
  const managed = fakeManaged();
  const hooks = settleHooks();
  const out = await buildDeclaredBpf({ flow, sdk: await env.open(), findByName: async () => [], findById: async () => assert.fail('no binding yet') }, { managed, creates }, hooks);
  const { ids, op } = creates.calls[0];
  assert.equal(op.kind, KIND);
  assert.deepEqual(op.identity, { table: 'new_ticket', name: 'Ticket Handling' });
  assert.deepEqual(op.childKeys, DEPLOYED().stages.flatMap((s) => [stageKey(s.name), ...s.steps.map((t) => stepKey(s.name, t.name))]));
  assert.deepEqual(out, { flowId: ids.id, backingTable: 'new_tickethandling' });
  const stored = await env.readId(ids.id);
  assert.equal(stored.stages[0].id, ids.childIds[stageKey('Triage')]);
  assert.equal(stored.stages[0].steps[1].id, ids.childIds[stepKey('Triage', 'Priority')]);
  assert.deepEqual([stored.description, stored.status], ['Ticket flow', 'Active']);
  assert.deepEqual(hooks.events.map((e) => e.slice(0, 2)), [['created', ids.id], ['settle', 'business-process-flows']], 'membership first, then settlement');
  const r = settled(hooks)[0];
  assert.deepEqual(r.saved.map((s) => [s.id, s.created]), [[ids.id, true]]);
  assert.deepEqual(r.managedBindings.map((b) => [b.id, b.origin]), [[ids.id, 'created']]);
  managed.persist(r.managedBindings);
  // The next build finds it by its binding, reads it by id, and writes nothing.
  const before = env.log.length;
  const again = settleHooks();
  const rerun = await buildDeclaredBpf({ flow, sdk: await env.open(), findByName: async () => assert.fail('the binding comes first'), findById: async (id) => [{ workflowid: id, uniquename: 'new_tickethandling' }] }, { managed, creates: stableCreates() }, again);
  assert.deepEqual(rerun, { flowId: ids.id, backingTable: 'new_tickethandling' });
  assert.equal(env.log.length, before, 'nothing written');
  assert.deepEqual(again.events.map((e) => e[0]), ['settle', 'existing'], 'an existing flow\'s solution membership follows its settlement');
  // The 2.21.0 pass-through port (fresh ids every call) creates with its own root id too.
  const pass = service();
  const passed = await buildDeclaredBpf({ flow, sdk: await pass.open(), findByName: async () => [] }, { managed: fakeManaged(), creates: passThroughCreates() }, settleHooks());
  assert.equal((await pass.readId(passed.flowId)).stages.length, 3);
});

test('a create the port gives no GUID root, or whose children read back incomplete, binds nothing', async () => {
  const env = service();
  const flow = declared(DEPLOYED());
  const noRoot = { run: async (req, execute) => { const answer = await execute({ id: 'not-a-guid', childIds: {} }); return { outcome: answer.outcome === 'refused' ? 'refused' : 'unknown', id: 'not-a-guid', childIds: {}, result: answer }; } };
  const hooks = settleHooks();
  assert.equal(await buildDeclaredBpf({ flow, sdk: await env.open(), findByName: async () => [] }, { managed: fakeManaged(), creates: noRoot }, hooks), null);
  const r = settled(hooks)[0];
  assert.deepEqual(codes(r.refused), ['bpf-rejected']);
  assert.match(r.refused[0].message, /CREATE_ROOT_ID_MISSING/);
  assert.equal(env.log.length, 0, 'no random root is made up: nothing is sent');
  // The service stored the flow, but a fresh read shows a stage missing.
  const sdk = withMember(await env.open(), 'fetchArtifact', (t) => async (...a) => { const art = await t.fetchArtifact(...a); return { ...art, stages: art.stages.slice(0, -1) }; });
  const partial = settleHooks();
  assert.equal(await buildDeclaredBpf({ flow, sdk, findByName: async () => [] }, { managed: fakeManaged(), creates: stableCreates() }, partial), null);
  const p = settled(partial)[0];
  assert.deepEqual(codes(p.refused), ['create-completion-required']);
  assert.equal(p.managedBindings.length, 0);
  assert.equal(partial.events.filter((e) => e[0] === 'created').length, 0, 'an unproven flow is not added to the solution');
});

test('a bound flow is read by its id, never recreated when missing; two flows of the name or an unreadable lookup stop before writing', async () => {
  const env = await deployed();
  const flow = declared(DEPLOYED());
  const managed = await boundAs(env, flow);
  const creates = stableCreates();
  const run = async (input, ctx) => { const hooks = settleHooks(); const out = await buildDeclaredBpf({ flow, sdk: await env.open(), ...input }, { creates, ...ctx }, hooks); return { out, r: settled(hooks)[0] }; };
  const gone = await run({ findById: async () => [], findByName: async () => assert.fail('the binding comes first') }, { managed });
  assert.equal(gone.out, null);
  assert.deepEqual(codes(gone.r.refused), ['bpf-bound-row-missing']);
  const two = await run({ findByName: async () => [{ workflowid: env.id, uniquename: 'new_tickethandling' }, { workflowid: OTHER_ID, uniquename: 'new_tickethandling2' }] }, { managed: fakeManaged(), authorizedAdoption: true });
  assert.deepEqual(codes(two.r.refused), ['bpf-name-ambiguous']);
  const unreadable = await run({ findByName: async () => { throw new Error('HTTP 500'); } }, { managed: fakeManaged(), authorizedAdoption: true });
  assert.deepEqual(codes(unreadable.r.unknown), ['bpf-lookup-unreadable']);
  assert.equal(creates.calls.length, 0);
  assert.equal(env.log.length, 0);
});

test('an existing flow found by name is reconciled; the backing table is the one the row names, and a failed solution add of a new flow is refused but stays bound', async () => {
  const env = await deployed();
  const hooks = settleHooks();
  const out = await buildDeclaredBpf({ flow: declared(DEPLOYED(), { description: 'Adopted' }), sdk: await env.open(), findByName: async () => [{ workflowid: env.id, uniquename: 'contoso_originalbacking' }] }, { managed: fakeManaged(), authorizedAdoption: true }, hooks);
  assert.deepEqual(out, { flowId: env.id, backingTable: 'contoso_originalbacking' });
  assert.equal((await env.read()).description, 'Adopted');
  assert.deepEqual(hooks.events.map((e) => e[0]), ['settle', 'existing']);
  const fresh = service();
  const failing = settleHooks({ onCreated: async () => { throw new Error('solution is locked'); } });
  assert.equal(await buildDeclaredBpf({ flow: declared(DEPLOYED()), sdk: await fresh.open(), findByName: async () => [] }, { managed: fakeManaged(), creates: stableCreates() }, failing), null);
  const r = settled(failing)[0];
  assert.deepEqual(codes(r.refused), ['bpf-solution-membership-failed']);
  assert.equal(r.managedBindings.length, 1, 'the proven row stays this spec\'s, so the next build finds it and adds it then');
});

test('the name-clash check runs before the create, and its halt stops it', async () => {
  const env = service();
  const creates = stableCreates();
  const halt = Object.assign(new Error('the unique name is taken'), { code: 'bpf-unique-name-conflict' });
  await assert.rejects(buildDeclaredBpf({ flow: declared(DEPLOYED()), sdk: await env.open(), findByName: async () => [], beforeCreate: async () => { throw halt; } }, { managed: fakeManaged(), creates }, settleHooks()), halt);
  assert.equal(creates.calls.length, 0);
  assert.equal(env.log.length, 0);
});
