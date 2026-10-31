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
    post: async (url, body, o) => {
      log.push(['POST', String(url)]);
      if (faults.post) {
        const answer = await faults.post(body, () => svc.post(url, body, o));
        if (answer) return answer;
      }
      return svc.post(url, body, o);
    },
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
  // The build's findById (queryRecords on workflowid): the rows with that id, as { workflowid, uniquename }.
  const rowsAt = async (id) => {
    const res = await svc.get(`https://contoso.crm.dynamics.com/api/data/v9.2/workflows(${id})`);
    return res.status === 200 ? [{ workflowid: res.body.workflowid, uniquename: res.body.uniquename }] : [];
  };
  return { open, log, faults, readId, xamlOf, rowsAt };
}
const byId = (env, calls = []) => async (id) => { calls.push(['id', id]); return env.rowsAt(id); };

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
  // One nested operation per parent: the new stage under the flow, then each stage's new steps under that stage's id
  // (the existing Resolve stage's actual id, the new Review stage's reserved one). All of them reserve before any edit.
  const resolveId = (await env.read()).stages[1].id;
  assert.deepEqual(creates.calls.map((c) => [c.op.kind, c.op.identity.parentId, c.op.childKeys]), [
    [KIND, env.id, [stageKey('Review')]],
    [KIND, resolveId, [stepKey('Resolve', 'Owner')]],
    [KIND, creates.calls[0].ids.childIds[stageKey('Review')], [stepKey('Review', 'Approver')]],
  ]);
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
  const review = (await env.read()).stages[3].id;
  assert.deepEqual(requests.map((r) => [r.kind, r.identity.parentId]), [[KIND, env.id], [KIND, review]]);
});

test('a new step derives under its stage\'s ACTUAL id: two imported flows with one workflow id and stage caption but different stage ids get different step ids', async () => {
  const flowId = '11111111-2222-5333-8444-555555555555';
  const base = declared({ name: 'Parent Identity', entity: 'new_ticket', status: 'Draft', stages: [{ name: 'Triage', steps: [{ name: 'Subject', field: 'new_subject' }] }] });
  const want = { ...base, stages: [{ ...base.stages[0], steps: [...base.stages[0].steps, { name: 'Priority', field: 'new_priority' }] }] };
  const addUnder = async (stageId) => {
    const env = service();
    const creator = await env.open();
    const def = bpfDef(base);
    def.id = flowId;
    def.stages[0].id = stageId;
    await creator.pushArtifact('bpf', (await creator.createArtifact('bpf', def)).id);
    const live = await env.readId(flowId);
    const port = stableCreates({ underParent: true });
    const { result } = await rebuild({ ...env, id: flowId }, want, { managed: fakeManaged([createdBpfBinding(base, flowId, live)]), creates: port });
    assert.equal(result.saved.length, 1, JSON.stringify(result));
    const stored = await env.readId(flowId);
    assert.equal(stored.stages[0].id, stageId, 'the imported stage keeps its id');
    return { request: port.calls[0].op, step: stored.stages[0].steps[1].id };
  };
  const a = await addUnder('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const b = await addUnder('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(a.request.identity.parentId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(b.request.identity.parentId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.notEqual(a.step, b.step, 'two actual parents never collapse to one child identity');
  assert.equal(a.step, stableId('stable-test', 'child', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', stepKey('Triage', 'Priority')));
});

test('child ids derive under the flow\'s actual id: the same keys get the same ids at creation, when added later and under an imported flow', async () => {
  const d = DEPLOYED();
  const full = declared(flowOf([...d.stages, stage('Review', 'Approver:new_approver')]));
  // Created with all four stages.
  const fresh = service();
  const atCreate = stableCreates({ underParent: true, identity: true });
  const made = await buildDeclaredBpf({ flow: full, sdk: await fresh.open(), findById: byId(fresh), findByName: async () => [] }, { managed: fakeManaged(), creates: atCreate }, settleHooks());
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
  assert.equal(createdFlow.stages[3].steps[0].id, stableId('stable-test', 'child', createdFlow.stages[3].id, stepKey('Review', 'Approver')), 'a step derives under its stage, at creation too');
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

// --- A declared flow end to end: resolve, create or reconcile, prove, settle -----------------------------------------

// The build's managed settlement as it is specified (the build's settleManagedResult): every id in
// `memberIds` joins the solution BEFORE anything is recorded; a failed add is unknown 'managed-membership-failed' and
// clears the bindings; a result that is not clean halts with a never-retry error and records nothing applied.
function settleHooks(extra = {}) {
  const events = [];
  const hooks = { events, ensureMember: async (id) => { events.push(['member', id]); }, ...extra };
  hooks.settle = extra.settle || (async (phase, label, r, { memberIds } = {}) => {
    events.push(['settle', phase, label, r, memberIds]);
    if (!r.refused.length && !r.unknown.length) {
      for (const id of memberIds || []) {
        try {
          await hooks.ensureMember(id);
        } catch (e) {
          r.unknown.push({ key: label, code: 'managed-membership-failed', message: e.message });
          r.managedBindings = [];
          break;
        }
      }
    }
    events.push(['record', r.managedBindings.map((b) => b.id)]);
    const findings = [...r.refused, ...r.unknown];
    if (findings.length) throw Object.assign(new Error(`${label}: ${findings[0].code}`), { code: findings[0].code, transient: false, findings });
    return { ok: true };
  });
  return hooks;
}
const settled = (hooks) => hooks.events.filter((e) => e[0] === 'settle').map((e) => e[3]);
const halted = (code) => (e) => e.code === code;
const identityPort = (opts = {}) => stableCreates({ underParent: true, identity: true, ...opts });
const derivedOf = (flow) => stableId('stable-test', KIND, bpfKey(flow));

test('a new declared flow is read at its derived id, then by name, then created with the port\'s ids, proven, added to the solution and only then bound', async () => {
  const env = service();
  const flow = declared(DEPLOYED(), { description: 'Ticket flow' });
  const creates = identityPort();
  const managed = fakeManaged();
  const hooks = settleHooks();
  const lookups = [];
  const out = await buildDeclaredBpf({ flow, sdk: await env.open(), findById: byId(env, lookups), findByName: async () => { lookups.push(['name']); return []; } }, { managed, creates }, hooks);
  const { ids, op } = creates.calls[0];
  assert.equal(ids.id, derivedOf(flow), 'the root is the derived id the resolver read first');
  assert.deepEqual(lookups, [['id', ids.id], ['name']]);
  assert.equal(op.kind, KIND);
  assert.deepEqual(op.identity, { table: 'new_ticket', name: 'Ticket Handling' });
  assert.deepEqual(op.childKeys, DEPLOYED().stages.map((s) => stageKey(s.name)));
  // Each stage's steps are reserved under that stage's id.
  assert.deepEqual(creates.calls.slice(1).map((c) => [c.op.identity.parentId, c.op.childKeys]), DEPLOYED().stages.map((s) => [ids.childIds[stageKey(s.name)], s.steps.map((t) => stepKey(s.name, t.name))]));
  assert.deepEqual(out, { flowId: ids.id, backingTable: 'new_tickethandling' });
  const stored = await env.readId(ids.id);
  assert.equal(stored.stages[0].id, ids.childIds[stageKey('Triage')]);
  assert.equal(stored.stages[0].steps[1].id, stableId('stable-test', 'child', stored.stages[0].id, stepKey('Triage', 'Priority')));
  assert.deepEqual([stored.description, stored.status], ['Ticket flow', 'Active']);
  assert.deepEqual(hooks.events.map((e) => e[0]), ['settle', 'member', 'record'], 'membership before anything is recorded');
  assert.deepEqual(hooks.events[0][4], [ids.id]);
  const r = settled(hooks)[0];
  assert.deepEqual(r.saved.map((s) => [s.id, s.created]), [[ids.id, true]]);
  assert.deepEqual(r.managedBindings.map((b) => [b.id, b.origin]), [[ids.id, 'created']]);
  managed.persist(r.managedBindings);
  // The next build finds it by its binding, reads it by id, writes nothing, and its membership is settled again first.
  const before = env.log.length;
  const again = settleHooks();
  const rerun = await buildDeclaredBpf({ flow, sdk: await env.open(), findByName: async () => assert.fail('the binding comes first'), findById: byId(env) }, { managed, creates: identityPort() }, again);
  assert.deepEqual(rerun, { flowId: ids.id, backingTable: 'new_tickethandling' });
  assert.equal(env.log.length, before, 'nothing written');
  assert.deepEqual(again.events.map((e) => e[0]), ['settle', 'member', 'record'], 'an existing flow\'s membership is required before its binding too');
  assert.deepEqual(again.events[0][4], [ids.id]);
});

test('a port that gives no stable identity creates nothing: the new flow is refused create-identity-unsupported and the build halts', async () => {
  for (const creates of [passThroughCreates(), stableCreates()]) {
    const env = service();
    const hooks = settleHooks();
    await assert.rejects(buildDeclaredBpf({ flow: declared(DEPLOYED()), sdk: await env.open(), findById: byId(env), findByName: async () => [] }, { managed: fakeManaged(), creates }, hooks), halted('create-identity-unsupported'));
    assert.equal(env.log.length, 0, 'nothing is sent');
    assert.deepEqual(settled(hooks)[0].managedBindings, []);
  }
});

test('an unbound declared flow is looked for at its derived id BEFORE its name: a row there takes the existing path, never a create', async () => {
  const flow = declared(DEPLOYED());
  const env = await deployed(DEPLOYED(), 'Active', derivedOf(flow));
  const creates = identityPort();
  const lookups = [];
  const hooks = settleHooks();
  const out = await buildDeclaredBpf({ flow, sdk: await env.open(), findById: byId(env, lookups), findByName: async () => { lookups.push(['name']); return []; } }, { managed: fakeManaged(), creates }, hooks);
  assert.deepEqual(lookups, [['id', env.id]], 'the stale name lookup is never asked');
  assert.equal(creates.calls.length, 0, 'a present row is the consumer\'s, not the port\'s');
  assert.equal(env.log.length, 0);
  assert.equal(out.flowId, env.id);
  const r = settled(hooks)[0];
  assert.deepEqual(r.unchanged.map((u) => [u.id, u.managed]), [[env.id, false]], 'a matching id is not ownership: no binding without the adoption approval');
  // With the approval it is bound as adopted.
  const approved = settleHooks();
  await buildDeclaredBpf({ flow, sdk: await env.open(), findById: byId(env), findByName: async () => assert.fail('derived id first') }, { managed: fakeManaged(), creates, authorizedAdoption: true }, approved);
  assert.deepEqual(settled(approved)[0].managedBindings.map((b) => [b.id, b.origin]), [[env.id, 'adopted']]);
});

test('a lost answer to the create is inspected ONCE at the root id and continued there; the next build reads it by id; never a second POST', async () => {
  const env = service();
  const flow = declared(DEPLOYED(), { status: 'Draft' });
  let lose = true;
  env.faults.post = async (body, store) => {
    await store();
    if (lose) { lose = false; throw Object.assign(new Error('offline: the answer was lost after the row was stored'), { code: 'ECONNRESET' }); }
    return null;
  };
  const lookups = [];
  const hooks = settleHooks();
  const out = await buildDeclaredBpf({ flow, sdk: await env.open(), findById: byId(env, lookups), findByName: async () => { lookups.push(['name']); return []; } }, { managed: fakeManaged(), creates: identityPort() }, hooks);
  const root = derivedOf(flow);
  assert.deepEqual(lookups, [['id', root], ['name'], ['id', root]], 'one inspection after the failure, at the id it was sent with');
  assert.equal(env.log.filter(([verb]) => verb === 'POST').length, 1, 'never a second create');
  assert.equal(out.flowId, root);
  const r = settled(hooks)[0];
  assert.deepEqual([r.refused, r.unknown], [[], []], JSON.stringify(r));
  assert.deepEqual(r.unchanged.map((u) => u.id), [root], 'the stored flow is exactly the declared one');
  // The next build: the derived id answers first, so the name lookup and the port are never asked.
  const next = identityPort();
  const rerun = await buildDeclaredBpf({ flow, sdk: await env.open(), findById: byId(env), findByName: async () => assert.fail('derived id first') }, { managed: fakeManaged(), creates: next }, settleHooks());
  assert.equal(rerun.flowId, root);
  assert.equal(next.calls.length, 0);
  assert.equal(env.log.filter(([verb]) => verb === 'POST').length, 1);
});

test('a collision answer is inspected, not called someone else\'s: the row at the sent id is continued with no second create', async () => {
  const flow = declared(DEPLOYED());
  const env = await deployed(DEPLOYED(), 'Active', derivedOf(flow));
  env.faults.post = async () => ({ status: 412, headers: {}, body: { error: { code: '0x80040237', message: 'A record with the supplied workflowid already exists.' } } });
  // The resolver's read misses the row (a replica that has not caught up); the inspection after the failure finds it.
  let reads = 0;
  const findById = async (id) => (reads++ === 0 ? [] : env.rowsAt(id));
  const hooks = settleHooks();
  const out = await buildDeclaredBpf({ flow, sdk: await env.open(), findById, findByName: async () => [] }, { managed: fakeManaged(), creates: identityPort() }, hooks);
  assert.equal(reads, 2);
  assert.equal(out.flowId, env.id);
  const r = settled(hooks)[0];
  assert.deepEqual([codes(r.refused), codes(r.unknown)], [[], []]);
  assert.equal(env.log.filter(([verb]) => verb === 'POST').length, 1);
});

test('thrown and returned push failures share one route: a pre-send refusal is refused, anything else is inspected, and an absent row is completion-required', async () => {
  const flow = declared(DEPLOYED());
  const attempt = async (pushed) => {
    const env = service();
    const sdk = withMember(await env.open(), 'pushArtifact', () => pushed);
    const lookups = [];
    const hooks = settleHooks();
    let error;
    try {
      await buildDeclaredBpf({ flow, sdk, findById: byId(env, lookups), findByName: async () => [] }, { managed: fakeManaged(), creates: identityPort() }, hooks);
    } catch (e) { error = e; }
    return { error, lookups, r: settled(hooks)[0] };
  };
  const lost = await attempt(async (kind, id) => ({ saved: false, id, error: { code: 'CONNECTION_ERROR', message: 'response lost after dispatch' } }));
  assert.equal(lost.error.code, 'create-completion-required');
  assert.deepEqual([codes(lost.r.refused), codes(lost.r.unknown)], [[], ['create-completion-required']], 'a returned connection failure may have been sent');
  assert.equal(lost.lookups.filter(([k]) => k === 'id').length, 2, 'resolver read + one inspection');
  const thrown = await attempt(async () => { throw Object.assign(new Error('socket hang up'), { code: 'CONNECTION_ERROR' }); });
  assert.deepEqual(codes(thrown.r.unknown), ['create-completion-required']);
  const unreadable = await (async () => {
    const env = service();
    const sdk = withMember(await env.open(), 'pushArtifact', () => async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); });
    let n = 0;
    const hooks = settleHooks();
    await assert.rejects(buildDeclaredBpf({ flow, sdk, findById: async () => { if (n++) throw new Error('HTTP 503'); return []; }, findByName: async () => [] }, { managed: fakeManaged(), creates: identityPort() }, hooks));
    return settled(hooks)[0];
  })();
  assert.deepEqual(codes(unreadable.unknown), ['create-identity-unverified']);
  const refused = await attempt(async (kind, id) => ({ saved: false, id, error: { code: 'VALIDATION_ERROR', message: 'checked before any request' } }));
  assert.deepEqual(codes(refused.r.refused), ['bpf-rejected']);
  assert.equal(refused.lookups.filter(([k]) => k === 'id').length, 1, 'a definite pre-send refusal is not inspected');
});

test('the SDK\'s own push result reaches the port and the saved entry: its warnings are not dropped', async () => {
  const env = service();
  const flow = declared(DEPLOYED());
  const sdk = withMember(await env.open(), 'pushArtifact', (t) => async (...a) => ({ ...(await t.pushArtifact(...a)), warnings: ['SDK witness'] }));
  const creates = identityPort();
  const hooks = settleHooks();
  await buildDeclaredBpf({ flow, sdk, findById: byId(env), findByName: async () => [] }, { managed: fakeManaged(), creates }, hooks);
  assert.deepEqual(creates.calls[0].answer.sdkResult.warnings, ['SDK witness']);
  assert.deepEqual(settled(hooks)[0].saved[0].sdkResult.warnings, ['SDK witness']);
});

test('a create the port gives no GUID or no derived root, or whose children read back incomplete, binds nothing and halts', async () => {
  const env = service();
  const flow = declared(DEPLOYED());
  const noRoot = { protects: () => true, identityFor: () => ({ id: derivedOf(flow), childIds: {} }), run: async (req, execute) => { const answer = await execute({ id: 'not-a-guid', childIds: {} }); return { outcome: answer.outcome === 'refused' ? 'refused' : 'unknown', id: 'not-a-guid', childIds: {}, result: answer }; } };
  const hooks = settleHooks();
  await assert.rejects(buildDeclaredBpf({ flow, sdk: await env.open(), findById: byId(env), findByName: async () => [] }, { managed: fakeManaged(), creates: noRoot }, hooks), halted('bpf-rejected'));
  assert.match(settled(hooks)[0].refused[0].message, /CREATE_ROOT_ID_MISSING/);
  const otherRoot = { ...noRoot, run: async (req, execute) => { const answer = await execute({ id: OTHER_ID, childIds: {} }); return { outcome: 'refused', id: OTHER_ID, childIds: {}, result: answer }; } };
  const other = settleHooks();
  await assert.rejects(buildDeclaredBpf({ flow, sdk: await env.open(), findById: byId(env), findByName: async () => [] }, { managed: fakeManaged(), creates: otherRoot }, other), halted('bpf-rejected'));
  assert.match(settled(other)[0].refused[0].message, /CREATE_ROOT_ID_NOT_DERIVED/);
  assert.equal(env.log.length, 0, 'no root other than the derived one is ever sent');
  // The service stored the flow, but a fresh read shows a stage missing.
  const sdk = withMember(await env.open(), 'fetchArtifact', (t) => async (...a) => { const art = await t.fetchArtifact(...a); return { ...art, stages: art.stages.slice(0, -1) }; });
  const partial = settleHooks();
  await assert.rejects(buildDeclaredBpf({ flow, sdk, findById: byId(env), findByName: async () => [] }, { managed: fakeManaged(), creates: identityPort() }, partial), halted('create-completion-required'));
  assert.deepEqual(partial.events.map((e) => e[0]), ['settle', 'record'], 'an unproven flow is not added to the solution');
  assert.deepEqual(partial.events[1][1], []);
});

test('a bound flow is read by its id, never recreated when missing; two flows of the name or an unreadable lookup stop before writing', async () => {
  const env = await deployed();
  const flow = declared(DEPLOYED());
  const managed = await boundAs(env, flow);
  const creates = identityPort();
  const run = async (input, ctx, code) => { const hooks = settleHooks(); await assert.rejects(buildDeclaredBpf({ flow, sdk: await env.open(), ...input }, { creates, ...ctx }, hooks), halted(code)); return settled(hooks)[0]; };
  const gone = await run({ findById: async () => [], findByName: async () => assert.fail('the binding comes first') }, { managed }, 'bpf-bound-row-missing');
  assert.deepEqual(codes(gone.refused), ['bpf-bound-row-missing']);
  const two = await run({ findById: async () => [], findByName: async () => [{ workflowid: env.id, uniquename: 'new_tickethandling' }, { workflowid: OTHER_ID, uniquename: 'new_tickethandling2' }] }, { managed: fakeManaged(), authorizedAdoption: true }, 'bpf-name-ambiguous');
  assert.deepEqual(codes(two.refused), ['bpf-name-ambiguous']);
  const unreadable = await run({ findById: async () => [], findByName: async () => { throw new Error('HTTP 500'); } }, { managed: fakeManaged(), authorizedAdoption: true }, 'bpf-lookup-unreadable');
  assert.deepEqual(codes(unreadable.unknown), ['bpf-lookup-unreadable']);
  const derivedUnreadable = await run({ findById: async () => { throw new Error('HTTP 500'); }, findByName: async () => assert.fail('an unreadable derived id is not absence') }, { managed: fakeManaged() }, 'create-identity-unverified');
  assert.deepEqual(codes(derivedUnreadable.unknown), ['create-identity-unverified']);
  assert.equal(creates.calls.length, 0);
  assert.equal(env.log.length, 0);
});

test('an existing flow is added to the solution BEFORE it is bound; a failed add halts with no binding and nothing after it', async () => {
  const env = await deployed();
  const hooks = settleHooks();
  const out = await buildDeclaredBpf({ flow: declared(DEPLOYED(), { description: 'Adopted' }), sdk: await env.open(), findById: byId(env), findByName: async () => [{ workflowid: env.id, uniquename: 'contoso_originalbacking' }] }, { managed: fakeManaged(), authorizedAdoption: true, creates: identityPort() }, hooks);
  assert.deepEqual(out, { flowId: env.id, backingTable: 'contoso_originalbacking' });
  assert.equal((await env.read()).description, 'Adopted');
  assert.deepEqual(hooks.events.map((e) => e[0]), ['settle', 'member', 'record']);
  // Existing flow, membership fails: a never-retry halt, no binding recorded, so nothing downstream runs on it.
  const locked = async () => { throw new Error('solution is locked'); };
  const existing = settleHooks({ ensureMember: locked });
  await assert.rejects(buildDeclaredBpf({ flow: declared(DEPLOYED(), { description: 'Again' }), sdk: await env.open(), findById: byId(env), findByName: async () => [{ workflowid: env.id, uniquename: 'contoso_originalbacking' }] }, { managed: fakeManaged(), authorizedAdoption: true, creates: identityPort() }, existing), (e) => e.code === 'managed-membership-failed' && e.transient === false);
  assert.deepEqual(existing.events.at(-1), ['record', []]);
  // New flow, membership fails: same.
  const fresh = service();
  const failing = settleHooks({ ensureMember: locked });
  await assert.rejects(buildDeclaredBpf({ flow: declared(DEPLOYED()), sdk: await fresh.open(), findById: byId(fresh), findByName: async () => [] }, { managed: fakeManaged(), creates: identityPort() }, failing), halted('managed-membership-failed'));
  assert.deepEqual(failing.events.at(-1), ['record', []], 'the proven row is not bound while it is outside the solution');
});

test('a settlement that answers not-ok without halting is turned into a never-retry halt by the helper', async () => {
  const env = await deployed();
  const hooks = settleHooks({ settle: async () => ({ ok: false }) });
  await assert.rejects(buildDeclaredBpf({ flow: declared(DEPLOYED(), { description: 'x' }), sdk: await env.open(), findById: byId(env), findByName: async () => [{ workflowid: env.id, uniquename: 'new_tickethandling' }] }, { managed: fakeManaged(), creates: identityPort() }, hooks), (e) => e.transient === false && e.recoverable === false);
});

test('the name-clash check runs before the create, and its halt stops it', async () => {
  const env = service();
  const creates = identityPort();
  const halt = Object.assign(new Error('the unique name is taken'), { code: 'bpf-unique-name-conflict' });
  await assert.rejects(buildDeclaredBpf({ flow: declared(DEPLOYED()), sdk: await env.open(), findById: byId(env), findByName: async () => [], beforeCreate: async () => { throw halt; } }, { managed: fakeManaged(), creates }, settleHooks()), halt);
  assert.equal(creates.calls.length, 0);
  assert.equal(env.log.length, 0);
});
