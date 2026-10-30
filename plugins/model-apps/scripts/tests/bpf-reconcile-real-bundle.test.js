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
const { planBpfMetadata, applyBpfMetadata, createdBpfBinding, bpfKey, stageKey, stepKey } = require('../lib/bpf-reconcile.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function deployed(flow = DEPLOYED(), status = 'Active') {
  const state = {};
  const svc = workflowsService(state);
  const log = [];
  const client = {
    ...svc,
    get: async (url, o) => (/EntityDefinitions\(LogicalName='workflow'\)/.test(url) ? { status: 200, headers: {}, body: { EntitySetName: 'workflows' } } : svc.get(url, o)),
    post: async (url, body, o) => { log.push(['POST', String(url)]); return svc.post(url, body, o); },
    patch: async (url, body, o) => { log.push(['PATCH', Object.keys(body)]); return svc.patch(url, body, o); },
    postRaw: async (url, body, o) => {
      log.push(['BATCH', [...String(body).matchAll(/"(\w+)":/g)].map((m) => m[1]).filter((k) => !k.startsWith('@'))]);
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
  const xaml = async () => (await svc.get(`https://contoso.crm.dynamics.com/api/data/v9.2/workflows(${art.id})`)).body.xaml;
  return { id: art.id, open, log, read, xaml };
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
  assert.equal(writes.length, 1, JSON.stringify(writes));
  assert.ok(!writes.some(([verb]) => verb === 'POST'), 'no child row is posted directly');
  const ids = Object.fromEntries(plan.childKeys.map((k) => [k, stableId('stable-test', 'business-process-flow-children', key, k)]));
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
