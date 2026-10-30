'use strict';
// Declared business process flows through the REAL vendored SDK over a fake workflows service that keeps the
// flow's row (XAML and all): the declared description and order converge in the SAME push as the safe stage
// edits, a description the flow never had is written to the row after the push, a flow is bound so outside
// changes are drift and a never-managed flow needs adoption, and a no-op writes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { workflowsService, stage, flowOf, DEPLOYED } = require('./helpers/bpf-batch-service.js');
const { fakeManaged } = require('./helpers/feature-ports.js');
const { bpfDef, inspectBpfStages, applyBpfStages } = require('../lib/sdk-build.js');
const { planBpfMetadata, applyBpfMetadata, createdBpfBinding, projectBpfForVerify } = require('../lib/bpf-reconcile.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function deployed(flow = DEPLOYED(), status = 'Active') {
  const state = {};
  const svc = workflowsService(state);
  const log = [];
  const client = {
    ...svc,
    // updateRecord resolves the table's entity set first, as against Dataverse.
    get: async (url, o) => (/EntityDefinitions\(LogicalName='workflow'\)/.test(url) ? { status: 200, headers: {}, body: { EntitySetName: 'workflows' } } : svc.get(url, o)),
    patch: async (url, body, o) => { log.push(['PATCH', Object.keys(body)]); if (state.fail) throw new Error('socket hang up'); return svc.patch(url, body, o); },
    postRaw: async (url, body, o) => {
      log.push(['BATCH', [...String(body).matchAll(/"(\w+)":/g)].map((m) => m[1]).filter((k) => !k.startsWith('@'))]);
      if (state.fail) throw new Error('socket hang up');
      return svc.postRaw(url, body, o);
    },
  };
  const open = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpf-rec-'));
    dirs.push(dir);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient: client });
    await sdk.initWorkspace();
    return sdk;
  };
  const creator = await open();
  const art = await creator.createArtifact('bpf', bpfDef({ ...flow, status }));
  await creator.pushArtifact('bpf', art.id);
  log.length = 0;
  const read = async () => (await open()).fetchArtifact('bpf', art.id, { overwrite: true });
  return { id: art.id, open, log, state, read };
}

// What the build does for a reused declared flow: the stage plan reads the deployed flow, the metadata plan
// works on that same copy, and a stage edit (when there is one) carries the metadata in its single push.
async function rebuild(env, flow, ctx = {}) {
  const sdk = await env.open();
  const before = env.log.length;
  const stageCheck = await inspectBpfStages(sdk, flow, env.id);
  const plan = await planBpfMetadata({ flow, flowId: env.id, sdk, fetched: true }, ctx);
  const pushStages = stageCheck.kind === 'edit' ? () => applyBpfStages(sdk, flow, env.id, stageCheck.plan, {}) : undefined;
  const result = await applyBpfMetadata(plan, { sdk, pushStages }, ctx);
  return { stageCheck, plan, result, writes: env.log.slice(before) };
}

const declared = (flow, extra) => ({ ...flow, reconcile: 'declared', ...extra });

test('a renamed stage, a new description and a new order go to an Active flow in ONE change set, and the next build writes nothing', async () => {
  const env = await deployed({ ...DEPLOYED(), description: 'Old text', order: 3 });
  const d = DEPLOYED();
  const want = declared(flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2]]), { description: 'Ticket triage to close', order: 7 });
  const managed = fakeManaged([createdBpfBinding(declared({ ...DEPLOYED(), description: 'Old text', order: 3 }), env.id)]);
  const { result, writes } = await rebuild(env, want, { managed });
  assert.deepEqual(result.saved.map((s) => s.id), [env.id], JSON.stringify(result));
  assert.equal(writes.length, 1, JSON.stringify(writes));
  assert.equal(writes[0][0], 'BATCH');
  assert.ok(['description', 'processorder', 'xaml'].every((k) => writes[0][1].includes(k)));
  const after = await env.read();
  assert.deepEqual([after.description, after.order, after.stages.map((s) => s.name), after.status], ['Ticket triage to close', 7, ['Intake', 'Resolve', 'Close'], 'Active']);
  managed.persist(result.managedBindings);
  const again = await rebuild(env, want, { managed });
  assert.equal(again.plan.action, 'noChange', JSON.stringify(again.plan));
  assert.deepEqual(again.writes, []);
});

test('a description the flow never had is written to its row after the push; order alone goes through the SDK', async () => {
  const env = await deployed();
  assert.equal((await env.read()).description, undefined, 'the SDK reads no description for a row without one');
  const want = declared(DEPLOYED(), { description: 'Ticket flow', order: 2 });
  const { result, writes } = await rebuild(env, want, { authorizedAdoption: true });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  assert.deepEqual(writes.map((w) => w[0]), ['BATCH', 'PATCH'], 'the SDK push first, the row write after it');
  assert.deepEqual(writes[1][1], ['description']);
  const after = await env.read();
  assert.deepEqual([after.description, after.order], ['Ticket flow', 2]);
  const managed = fakeManaged(result.managedBindings);
  const again = await rebuild(env, want, { managed });
  assert.equal(again.plan.action, 'noChange');
  assert.deepEqual(again.writes, []);
});

test('a flow the spec has never managed needs adoption approval; nothing is written meanwhile, stage edits included', async () => {
  const env = await deployed();
  const d = DEPLOYED();
  const want = declared(flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2]]), { order: 4 });
  // A declared flow that already matches is not a refusal, and is not bound without approval either.
  const same = await rebuild(env, declared(DEPLOYED()));
  assert.deepEqual([same.plan.action, same.result.refused, same.result.managedBindings, same.writes], ['noChange', [], [], []]);
  const refused = await rebuild(env, want);
  assert.equal(refused.stageCheck.kind, 'edit');
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['bpf-adoption-not-authorized']);
  assert.deepEqual(refused.writes, []);
  const adopted = await rebuild(env, want, { authorizedAdoption: true });
  assert.equal(adopted.result.saved.length, 1);
  assert.deepEqual((await env.read()).stages.map((s) => s.name), ['Intake', 'Resolve', 'Close']);
});

test('a flow changed outside the spec since the last build is drift until the overwrite is approved', async () => {
  const flow = declared(DEPLOYED(), { order: 3 });
  const env = await deployed(flow);
  const managed = fakeManaged([createdBpfBinding(flow, env.id)]);
  const maker = await env.open();
  await maker.fetchArtifact('bpf', env.id, { overwrite: true });
  await maker.updateElement('bpf', env.id, '/stages/1/name', 'Work');
  await maker.pushArtifact('bpf', env.id);
  env.log.length = 0;
  const want = declared(DEPLOYED(), { order: 5 });
  const drift = await rebuild(env, want, { managed });
  assert.deepEqual(drift.result.refused.map((r) => r.code), ['bpf-drift']);
  assert.deepEqual(drift.writes, []);
  const overwritten = await rebuild(env, want, { managed, authorizedOverwrite: true });
  assert.equal(overwritten.result.saved.length, 1, JSON.stringify(overwritten.result));
  const after = await env.read();
  assert.deepEqual([after.order, after.stages[1].name], [5, 'Resolve']);
});

test('stages the stage plan will not edit (a step removed) hold back the metadata too: nothing is written and nothing is recorded', async () => {
  const flow = declared(DEPLOYED());
  const env = await deployed(flow);
  const managed = fakeManaged([createdBpfBinding(flow, env.id)]);
  const want = declared(flowOf([stage('Triage', 'Subject:new_subject'), DEPLOYED().stages[1], DEPLOYED().stages[2]]), { order: 9 });
  const { stageCheck, result, writes } = await rebuild(env, want, { managed });
  assert.equal(stageCheck.kind, 'refused');
  assert.deepEqual(result.refused.map((r) => r.code), ['bpf-stage-edit-refused']);
  assert.deepEqual([writes, result.managedBindings], [[], []]);
});

test('a write that does not report its outcome is unknown and never recorded; an edit the SDK refuses before writing is refused', async () => {
  const flow = declared(DEPLOYED());
  const env = await deployed(flow);
  const managed = fakeManaged([createdBpfBinding(flow, env.id)]);
  env.state.fail = true;
  const lost = await rebuild(env, declared(DEPLOYED(), { order: 8 }), { managed });
  assert.deepEqual(lost.result.unknown.map((r) => r.code), ['bpf-write-unknown'], JSON.stringify(lost.result));
  assert.deepEqual([lost.result.saved, lost.result.managedBindings], [[], []]);
  env.state.fail = false;
  const sdk = await env.open();
  const plan = await planBpfMetadata({ flow: declared(flowOf([{ ...DEPLOYED().stages[0], name: 'Intake' }, ...DEPLOYED().stages.slice(1)])), flowId: env.id, sdk }, { managed });
  const notImplemented = Object.assign(new Error('the SDK cannot author this stage list'), { code: 'NOT_IMPLEMENTED' });
  const refused = await applyBpfMetadata(plan, { sdk, pushStages: async () => { throw notImplemented; } }, { managed });
  assert.deepEqual(refused.refused.map((r) => r.code), ['bpf-rejected']);
});

test('a flow without the opt-in is not read, an invalid declaration is refused before reading, and verify projects only owned metadata', async () => {
  const env = await deployed();
  const reads = [];
  const sdk = await env.open();
  // sdk-async-ok: the spy returns the SDK's promise to the helper, which awaits it.
  const spy = { getArtifact: (...a) => { reads.push(a); return sdk.getArtifact(...a); }, fetchArtifact: (...a) => { reads.push(a); return sdk.fetchArtifact(...a); } };
  assert.equal((await planBpfMetadata({ flow: DEPLOYED(), flowId: env.id, sdk: spy })).action, null);
  const bad = await planBpfMetadata({ flow: declared(DEPLOYED(), { order: -1, description: 'x'.repeat(2001) }), flowId: env.id, sdk: spy });
  assert.deepEqual(bad.refused.map((r) => r.code), ['bpf-spec-invalid']);
  assert.deepEqual(reads, []);
  const live = await env.read();
  assert.deepEqual(Object.keys(projectBpfForVerify(live)), ['stages']);
  assert.deepEqual(projectBpfForVerify(live, { order: true, description: true }).description, '');
  assert.deepEqual(projectBpfForVerify(live).stages[0], { name: 'Triage', steps: [{ name: 'Subject', field: 'new_subject', required: false }, { name: 'Priority', field: 'new_priority', required: false }] });
});

test('a spec that starts declaring a description or an order is an edit, not drift', async () => {
  const flow = declared(DEPLOYED());
  const env = await deployed(flow);
  const managed = fakeManaged([createdBpfBinding(flow, env.id)]);
  const { result } = await rebuild(env, declared(DEPLOYED(), { description: 'Now described', order: 6 }), { managed });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  const after = await env.read();
  assert.deepEqual([after.description, after.order], ['Now described', 6]);
});
test('the bound flow is the authority: a different flow found by name is refused, a bound flow no longer found is never recreated, and nothing is read or written', async () => {
  const flow = declared(DEPLOYED(), { order: 3 });
  const env = await deployed(flow);
  const managed = fakeManaged([createdBpfBinding(flow, '99999999-9999-9999-9999-999999999999')]);
  const want = declared(DEPLOYED(), { order: 5 });
  const sdk = await env.open();
  const reads = [];
  const spy = new Proxy(sdk, { get: (t, p) => (typeof t[p] === 'function' ? (...a) => { reads.push(p); return t[p](...a); } : t[p]) });
  const other = await planBpfMetadata({ flow: want, flowId: env.id, sdk: spy }, { managed, authorizedOverwrite: true, authorizedAdoption: true });
  assert.deepEqual([other.action, other.refused.map((r) => r.code), reads], [null, ['bpf-binding-mismatch'], []]);
  const result = await applyBpfMetadata(other, { sdk }, { managed });
  assert.deepEqual([result.saved, result.managedBindings, env.log], [[], [], []]);
  const gone = await planBpfMetadata({ flow: want, flowId: null, sdk: spy }, { managed });
  assert.deepEqual([gone.action, gone.needsCreate, gone.refused.map((r) => r.code), reads], [null, undefined, ['bpf-bound-row-missing'], []]);
  const fresh = await planBpfMetadata({ flow: want, flowId: null, sdk: spy }, {});
  assert.deepEqual([fresh.action, fresh.needsCreate, fresh.refused, reads], [null, true, [], []]);
  // The same flow under a differently cased id is still the bound flow.
  const same = await planBpfMetadata({ flow: want, flowId: env.id.toUpperCase(), sdk }, { managed: fakeManaged([createdBpfBinding(flow, env.id)]) });
  assert.deepEqual([same.action, same.refused], ['update', []]);
});