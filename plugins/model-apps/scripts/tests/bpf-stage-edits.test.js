'use strict';
// Business process flow STAGE EDITS on a rebuild.
//
// A flow is matched by (table, name) and reused; before this its stages and steps were never looked at again ("exists — reuse; stage
// edits aren't applied on rebuild, recreate to change"), and recreating a flow deletes its backing table with every record that
// runs it. The build now compares the deployed definition with the spec and applies, in place and in ONE push, every edit that
// leaves each deployed stage where it is in the process — a stage added or renamed, a step added, renamed, rebound, made required or
// optional or moved — and REFUSES (with the reason and what to do) any that removes a stage or a step or reorders the stages,
// applying no stage or step edit of that flow (its Active/Draft state is converged on its own). The platform facts it rests on, and what is
// still to be measured live, are in lib/bpf-stages.js.
//
// Layered like business-process-flows.test.js:
//   1. the pure plan (lib/bpf-stages.js) — which edits are applied, which refused, and how;
//   2. the build over an artifact-aware double of the SDK's element surface — what is written, in what order, how it is reported;
//   3. the change classifier — an edit the build applies is not debt, one it refuses is;
//   4. the REAL BUNDLE over a fake Dataverse that serves the flow's own XAML — what actually goes over the wire for an Active and a
//      Draft flow, that every stage keeps its id, and that the next rebuild finds nothing to do.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { validateAppSpec } = require('../lib/app-spec.js');
// An apply that names no app folder and no workspace gets an app folder of its own: it holds its build lease in its workspace (helpers/own-app-folder.js).
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { bpfDef, runSdkBuild: runSdkBuildInPlace, inspectBpfStages, applyBpfStages } = require('../lib/sdk-build.js');
const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const { desiredBpfStages, deployedBpfStages, diffBpfStages, describeBpfEdit, describeBpfRefusals } = require('../lib/bpf-stages.js');
const { classifyChanges } = require('../lib/classify-changes.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const clone = (v) => JSON.parse(JSON.stringify(v));

// --- fixtures -----------------------------------------------------------------------------------

function specWith(flows) {
  return {
    solution: { uniqueName: 'BPF', displayName: 'BPF', publisherPrefix: 'new' },
    app: { name: 'BPF App', description: '' },
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: [
        { schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['New', 'Closed'] },
        { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
        { schemaName: 'new_owner', displayName: 'Owner', type: 'Text' },
        { schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: ['Low', 'High'] },
        { schemaName: 'new_region', displayName: 'Region', type: 'Text' },
      ],
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
    businessProcessFlows: flows,
  };
}
// stage('Triage', 'Subject:new_subject!', 'Priority:new_priority') — a step is `name:column`, with a trailing `!` when required.
const stage = (name, ...steps) => ({
  name,
  steps: steps.map((s) => { const m = /^(.*?):(\w+)(!?)$/.exec(s); return { name: m[1], field: m[2], ...(m[3] ? { required: true } : {}) }; }),
});
const flowOf = (stages, extra = {}) => ({ name: 'Ticket Handling', entity: 'new_ticket', stages, ...extra });
const DEPLOYED = () => flowOf([
  stage('Triage', 'Subject:new_subject!', 'Priority:new_priority'),
  stage('Resolve', 'Notes:new_notes', 'Confirmed with customer:new_owner'),
  stage('Close', 'Status:new_status'),
]);
const names = (stages) => stages.map((s) => s.name);
const stepNames = (stages) => stages.map((s) => s.steps.map((p) => p.name));

// The deployed shape the plan reads (deployedBpfStages' input: the SDK artifact's stages), from a spec flow.
function artifactStages(flow) {
  return flow.stages.map((st, i) => ({
    id: `stage-${i + 1}`, name: st.name, entityLogicalName: 'new_ticket',
    steps: st.steps.map((p, k) => ({ id: `step-${i + 1}-${k + 1}`, name: p.name, fieldName: p.field, ...(p.required ? { required: true } : {}) })),
  }));
}
const plan = (deployedFlow, desiredFlow, opts = { entity: 'new_ticket' }) => diffBpfStages(deployedBpfStages(artifactStages(deployedFlow)), desiredBpfStages(desiredFlow), opts);

// --- 1. the pure plan ---------------------------------------------------------------------------

test('a flow that already matches the spec has nothing to apply', () => {
  const p = plan(DEPLOYED(), DEPLOYED());
  assert.strictEqual(p.verdict, 'same');
  assert.deepStrictEqual(p.refusals, []);
});

test('every edit is compared on what the spec can say: names, columns (case-insensitively) and required', () => {
  const upper = flowOf([stage('Triage', 'Subject:NEW_SUBJECT!', 'Priority:new_priority'), DEPLOYED().stages[1], DEPLOYED().stages[2]]);
  assert.strictEqual(plan(DEPLOYED(), upper).verdict, 'same', 'a column is a logical name: its case says nothing');
  const optional = flowOf([stage('Triage', 'Subject:new_subject', 'Priority:new_priority'), DEPLOYED().stages[1], DEPLOYED().stages[2]]);
  assert.strictEqual(plan(DEPLOYED(), optional).verdict, 'edit', 'required -> optional is an edit');
  assert.strictEqual(plan(DEPLOYED(), optional).target[0].stepsChanged, true);
});

test('APPLIED: a stage added at the end, at the start and in the middle — nothing deployed moves', () => {
  const d = DEPLOYED();
  const extra = stage('Verify', 'Region:new_region');
  for (const [where, stages, at] of [['end', [...d.stages, extra], 3], ['start', [extra, ...d.stages], 0], ['middle', [d.stages[0], extra, d.stages[1], d.stages[2]], 1]]) {
    const p = plan(d, flowOf(stages));
    assert.strictEqual(p.verdict, 'edit', where);
    assert.deepStrictEqual(p.target.map((t) => [t.name, t.isNew]), stages.map((s) => [s.name, s.name === 'Verify']), `${where}: every desired stage, in the spec's order`);
    assert.strictEqual(p.target[at].isNew, true, where);
    assert.deepStrictEqual(p.target.filter((t) => !t.isNew).map((t) => t.stageId), p.target.filter((t) => !t.isNew).map((t) => `stage-${d.stages.findIndex((x) => x.name === t.name) + 1}`), `${where}: the deployed stages keep their ids`);
    assert.strictEqual(describeBpfEdit(p), '1 stage added', where);
  }
});

test('APPLIED: a stage renamed in place keeps its id, so no record leaves it', () => {
  const d = DEPLOYED();
  const p = plan(d, flowOf([d.stages[0], { ...d.stages[1], name: 'Fix' }, d.stages[2]]));
  assert.strictEqual(p.verdict, 'edit');
  assert.deepStrictEqual(p.target.map((t) => [t.name, t.renamedFrom, t.stageId]), [['Triage', null, 'stage-1'], ['Fix', 'Resolve', 'stage-2'], ['Close', null, 'stage-3']]);
  assert.strictEqual(describeBpfEdit(p), '1 stage renamed');
  // The first stage and the last are renamed the same way, and a case-only rename is a rename.
  const ends = plan(d, flowOf([{ ...d.stages[0], name: 'triage' }, d.stages[1], { ...d.stages[2], name: 'Done' }]));
  assert.deepStrictEqual(ends.target.map((t) => [t.renamedFrom, t.stageId]), [['Triage', 'stage-1'], [null, 'stage-2'], ['Close', 'stage-3']]);
  // Several at once, each in its own place.
  const several = plan(d, flowOf([{ ...d.stages[0], name: 'A' }, d.stages[1], { ...d.stages[2], name: 'C' }]));
  assert.strictEqual(describeBpfEdit(several), '2 stages renamed');
});

test('APPLIED: a rename and an addition in DIFFERENT places are told apart by their neighbours', () => {
  const d = DEPLOYED();
  const p = plan(d, flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2], stage('Archive', 'Region:new_region')]));
  assert.strictEqual(p.verdict, 'edit');
  assert.deepStrictEqual(p.target.map((t) => [t.name, t.renamedFrom, t.isNew]), [['Intake', 'Triage', false], ['Resolve', null, false], ['Close', null, false], ['Archive', null, true]]);
  assert.strictEqual(describeBpfEdit(p), '1 stage renamed, 1 stage added');
});

test('APPLIED: steps added, renamed, rebound, made required or optional, and moved — nothing a record refers to', () => {
  const d = DEPLOYED();
  const edited = flowOf([
    // Triage: Subject made optional, Priority rebound to Region, a step added in front
    stage('Triage', 'Region check:new_region', 'Subject:new_subject', 'Priority:new_region'),
    // Resolve: the two steps swapped, and one renamed
    stage('Resolve', 'Customer confirmed:new_owner', 'Notes:new_notes'),
    d.stages[2],
  ]);
  const p = plan(d, edited);
  assert.strictEqual(p.verdict, 'edit', JSON.stringify(p.refusals));
  const [triage, resolve, close] = p.target;
  assert.deepStrictEqual(triage.steps.map((s) => [s.name, s.stepId]), [['Region check', null], ['Subject', 'step-1-1'], ['Priority', 'step-1-2']]);
  assert.deepStrictEqual(resolve.steps.map((s) => [s.name, s.stepId, s.renamedFrom]), [['Customer confirmed', 'step-2-2', 'Confirmed with customer'], ['Notes', 'step-2-1', null]], 'a renamed step keeps its id');
  assert.strictEqual(close.stepsChanged, false, 'a stage nobody edited is not touched');
  assert.strictEqual(describeBpfEdit(p), 'steps changed in 2 stages');
});

test('REFUSED: a stage the flow has and the spec does not list — a record may sit on it', () => {
  const d = DEPLOYED();
  const p = plan(d, flowOf([d.stages[0], d.stages[2]]));
  assert.strictEqual(p.verdict, 'refused');
  assert.deepStrictEqual(p.refusals, [{ code: 'removed-stages', deployed: ['Resolve'], desired: [] }]);
  assert.deepStrictEqual(describeBpfRefusals(p.refusals), ["the flow has stage 'Resolve', which the spec does not list"]);
  assert.deepStrictEqual(p.target, [], 'nothing is applied');
});

test('REFUSED: stages replaced by a different number — the build cannot tell a rename from a removal', () => {
  const d = DEPLOYED();
  // one deployed stage replaced by two
  const two = plan(d, flowOf([d.stages[0], stage('X', 'Region:new_region'), stage('Y', 'Region:new_region'), d.stages[2]]));
  assert.strictEqual(two.verdict, 'refused');
  assert.deepStrictEqual(two.refusals, [{ code: 'removed-stages', deployed: ['Resolve'], desired: ['X', 'Y'] }]);
  assert.match(describeBpfRefusals(two.refusals)[0], /the flow has stage 'Resolve' where the spec has 'X', 'Y' — with a different number of stages there, the build cannot tell a rename from a removal/);
  // two deployed stages replaced by one, and every stage replaced by one
  assert.strictEqual(plan(d, flowOf([stage('Only', 'Region:new_region')])).verdict, 'refused');
  assert.strictEqual(plan(d, flowOf([d.stages[0], stage('Only', 'Region:new_region')])).verdict, 'refused');
});

test('REFUSED: the stages the flow has, listed in another order — a record\'s place in the process would move', () => {
  const d = DEPLOYED();
  const p = plan(d, flowOf([d.stages[0], d.stages[2], d.stages[1]]));
  assert.strictEqual(p.verdict, 'refused');
  assert.deepStrictEqual(p.refusals, [{ code: 'reordered', deployed: ['Triage', 'Resolve', 'Close'], desired: ['Triage', 'Close', 'Resolve'] }]);
  assert.deepStrictEqual(describeBpfRefusals(p.refusals), ["the spec lists the stages 'Triage', 'Close', 'Resolve' in another order than the flow's 'Triage', 'Resolve', 'Close'"]);
  // a reorder together with an addition is still a reorder
  assert.strictEqual(plan(d, flowOf([d.stages[2], stage('New', 'Region:new_region'), d.stages[0], d.stages[1]])).verdict, 'refused');
});

test('REFUSED: a step the flow has and the spec does not list — the spec would strip what a maker may have added', () => {
  const d = DEPLOYED();
  const p = plan(d, flowOf([stage('Triage', 'Subject:new_subject!'), d.stages[1], d.stages[2]]));
  assert.strictEqual(p.verdict, 'refused');
  assert.deepStrictEqual(p.refusals, [{ code: 'removed-steps', stage: 'Triage', steps: ['Priority'] }]);
  assert.deepStrictEqual(describeBpfRefusals(p.refusals), ["stage 'Triage' has step 'Priority', which the spec does not list"]);
  // …even when every other edit in the flow is one the build would apply
  const mixed = plan(d, flowOf([stage('Triage', 'Subject:new_subject!'), d.stages[1], d.stages[2], stage('Archive', 'Region:new_region')]));
  assert.strictEqual(mixed.verdict, 'refused', 'a refused flow gets none of its edits');
});

test('a step the spec renames is paired with the deployed step in its place, and an extra desired one is an addition', () => {
  const d = DEPLOYED();
  const p = plan(d, flowOf([stage('Triage', 'Subject:new_subject!', 'Urgency:new_priority', 'Region:new_region'), d.stages[1], d.stages[2]]));
  assert.strictEqual(p.verdict, 'edit', JSON.stringify(p.refusals));
  assert.deepStrictEqual(p.target[0].steps.map((s) => [s.name, s.stepId, s.renamedFrom]), [['Subject', 'step-1-1', null], ['Urgency', 'step-1-2', 'Priority'], ['Region', null, null]]);
});

test('REFUSED: a flow whose names cannot be told apart, and a deployed flow on another table', () => {
  const dup = [...deployedBpfStages(artifactStages(DEPLOYED()))];
  dup.push({ ...dup[0], id: 'dup' });
  assert.deepStrictEqual(diffBpfStages(dup, desiredBpfStages(DEPLOYED())).refusals, [{ code: 'ambiguous-stages', stages: ['Triage'] }]);
  const dupSteps = deployedBpfStages(artifactStages(flowOf([stage('Triage', 'Subject:new_subject', 'Subject:new_notes')])));
  const dupPlan = diffBpfStages(dupSteps, desiredBpfStages(flowOf([stage('Triage', 'Subject:new_subject')])));
  assert.deepStrictEqual(dupPlan.refusals, [{ code: 'ambiguous-steps', stage: 'Triage', steps: ['Subject'] }]);
  // On another table: refused for an edit, never complained about when nothing needs changing.
  const elsewhere = artifactStages(DEPLOYED());
  elsewhere[1].entityLogicalName = 'account';
  const want = flowOf([...DEPLOYED().stages, stage('Archive', 'Region:new_region')]);
  const refused = diffBpfStages(deployedBpfStages(elsewhere), desiredBpfStages(want), { entity: 'new_ticket' });
  assert.deepStrictEqual(refused.refusals, [{ code: 'other-table', stages: ['Resolve'], entity: 'new_ticket' }]);
  assert.strictEqual(diffBpfStages(deployedBpfStages(elsewhere), desiredBpfStages(DEPLOYED()), { entity: 'new_ticket' }).verdict, 'same');
});

test('a plan describes what it does in a few words, and a refusal in a sentence each', () => {
  const d = DEPLOYED();
  const p = plan(d, flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], stage('Verify', 'Region:new_region'), stage('Close', 'Status:new_status', 'Region:new_region')]));
  assert.strictEqual(describeBpfEdit(p), '1 stage renamed, 1 stage added, steps changed in 1 stage');
  assert.strictEqual(describeBpfEdit({ target: [] }), '');
});

// --- 2. the build over an artifact-aware double --------------------------------------------------
//
// The double models the SDK's element surface as the vendored bundle behaves (probed against it): updateElement MERGES a patch into
// an object and replaces anything else, and throws PATH_NOT_FOUND for a path that is not there; addElement mints the ids of what
// it adds; moveElement removes before it inserts; and EVERY mutation is validated — a stage with no step, a step with no id, a
// duplicate id — so an order of operations that passes through an invalid state fails here as it would live.

const jpTokens = (ptr) => (ptr === '' ? [] : ptr.split('/').slice(1));
function jpGet(obj, ptr) { let cur = obj; for (const t of jpTokens(ptr)) { if (cur == null) return undefined; cur = cur[t]; } return cur; }
function jpParent(obj, ptr) { const toks = jpTokens(ptr); const last = toks.pop(); let cur = obj; for (const t of toks) cur = cur[t]; return { parent: cur, last }; }
const sdkError = (code, message) => Object.assign(new Error(message), { code });

function validateFlow(flow) {
  const ids = new Set();
  for (const st of flow.stages) {
    if (!st.id) throw sdkError('VALIDATION_ERROR', 'a stage needs an id [stage-id-required]');
    if (ids.has(st.id)) throw sdkError('VALIDATION_ERROR', `two stages share the id '${st.id}' [stage-id-duplicate]`);
    ids.add(st.id);
    if (!(st.steps || []).length) throw sdkError('VALIDATION_ERROR', `a BPF stage must have at least one step [stage-needs-step] (${st.name})`);
    const stepIds = new Set();
    for (const step of st.steps) {
      if (!step.id) throw sdkError('VALIDATION_ERROR', 'a step needs an id [step-id-required]');
      if (stepIds.has(step.id)) throw sdkError('VALIDATION_ERROR', `two steps share the id '${step.id}' [step-id-duplicate]`);
      stepIds.add(step.id);
    }
  }
}

// `deployed` is a spec-shaped flow (stages[].steps[] of name/field/required); `statecode` 1 = Active, 0 = Draft. `others` are more
// flows of the same environment ({ deployed, statecode }), served as flow-2, flow-3 …; `refusePush` makes flow-1's pushArtifact throw
// (or, with `refusePush.resolve`, answer saved:false) so a failure's handling can be tested.
function makeBpf(deployed, { statecode = 1, refusePush, fetchFails, rows, others = [] } = {}) {
  const flows = [{ deployed, statecode }, ...others].map((f, i) => ({ id: `flow-${i + 1}`, deployed: f.deployed, statecode: f.statecode === undefined ? 1 : f.statecode }));
  const server = new Map(flows.map((f) => [f.id, { id: f.id, name: f.deployed.name, entityLogicalName: 'new_ticket', status: f.statecode === 1 ? 'Active' : 'Draft', stages: artifactStages(f.deployed) }]));
  const local = new Map();
  let seq = 0;
  const calls = [];
  const rec = (name, ...args) => calls.push({ name, args });
  const mint = (prefix) => `${prefix}-minted-${++seq}`;
  const withIds = (node) => {
    const out = clone(node);
    if (!out.id) out.id = mint('id');
    for (const step of out.steps || []) if (!step.id) step.id = mint('step');
    return out;
  };
  const provision = {
    queryRecords: async (entity, o) => {
      if (entity !== 'workflow') return entity === 'solution' ? [] : [{ publisherid: 'pub-1' }];
      if (rows) return rows;
      // The reuse query filters on ` name eq '<flow name>'`; the unique-name probe on `uniquename eq` (no flow of that name: no clash).
      const named = / name eq '([^']*)'/.exec((o && o.filter) || '');
      const flow = named && flows.find((f) => f.deployed.name === named[1]);
      return flow ? [{ workflowid: flow.id, statecode: flow.statecode, createdon: '2026-01-01T00:00:00Z', uniquename: `new_${flow.deployed.name.toLowerCase().replace(/[^a-z0-9]/g, '')}` }] : [];
    },
    updateRecord: async (entity, id, patch) => { rec('updateRecord', entity, id, patch); },
    addSolutionComponent: async (a) => { rec('addSolutionComponent', a); },
    createArtifact: (kind, def) => { rec('createArtifact', kind, def); return { id: 'flow-created' }; },
    fetchArtifact: async (type, id, o) => {
      rec('fetchArtifact', type, id, o);
      if (fetchFails) throw fetchFails;
      if (!local.has(id) || (o && o.overwrite)) local.set(id, clone(server.get(id)));
      return clone(local.get(id));
    },
    getArtifact: async (type, id) => { rec('getArtifact', type, id); return clone(local.get(id)); },
    updateElement: async (type, id, ptr, patch) => {
      rec('updateElement', type, id, ptr, patch);
      const art = local.get(id);
      const current = jpGet(art, ptr);
      if (current === undefined) throw sdkError('PATH_NOT_FOUND', `Path ${ptr} not found in ${type}/${id}`);
      const { parent, last } = jpParent(art, ptr);
      const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
      parent[last] = plain(current) && plain(patch) ? Object.assign({}, current, clone(patch)) : clone(patch);
      validateFlow(art);
    },
    addElement: async (type, id, ptr, el, o) => {
      rec('addElement', type, id, ptr, el, o);
      const art = local.get(id);
      const arr = jpGet(art, ptr);
      if (!Array.isArray(arr)) throw sdkError('PATH_NOT_FOUND', `Path ${ptr} is not a list`);
      const pos = o && o.position;
      const at = pos && typeof pos === 'object' && 'index' in pos ? Math.max(0, Math.min(pos.index, arr.length)) : arr.length;
      arr.splice(at, 0, withIds(el));
      validateFlow(art);
    },
    moveElement: async (type, id, from, to, o) => {
      rec('moveElement', type, id, from, to, o);
      const art = local.get(id);
      const el = jpGet(art, from);
      const target = jpGet(art, to);
      if (el === undefined || !Array.isArray(target)) throw sdkError('PATH_NOT_FOUND', `cannot move ${from} to ${to}`);
      const { parent, last } = jpParent(art, from);
      parent.splice(Number(last), 1);
      target.splice(Math.max(0, Math.min(o && o.index !== undefined ? o.index : target.length, target.length)), 0, el);
      validateFlow(art);
    },
    removeElement: async (type, id, ptr) => {
      rec('removeElement', type, id, ptr);
      const art = local.get(id);
      const { parent, last } = jpParent(art, ptr);
      parent.splice(Number(last), 1);
      validateFlow(art);
    },
    pushArtifact: async (type, id) => {
      rec('pushArtifact', type, id);
      if (refusePush && id === 'flow-1') {
        if (!refusePush.resolve) throw refusePush;
        return { type, id, saved: false, error: refusePush.resolve };
      }
      server.set(id, clone(local.get(id)));
      return { type, id, saved: true, shipped: false, publish: { kind: 'notRequested' } };
    },
  };
  return { provision, calls, server: (id = 'flow-1') => clone(server.get(id)), local: (id = 'flow-1') => clone(local.get(id)) };
}
const writes = (calls) => calls.filter((c) => ['updateElement', 'addElement', 'moveElement', 'removeElement', 'pushArtifact', 'updateRecord', 'createArtifact'].includes(c.name));
const structure = (flow) => flow.stages.map((s) => `${s.name}[${s.steps.map((p) => `${p.name}:${p.fieldName}${p.required ? '!' : ''}`).join(', ')}]`);
const specStructure = (flow) => structure({ stages: artifactStages(flow) });

async function rebuild(desiredFlow, deployedFlow = DEPLOYED(), opts = {}) {
  const double = makeBpf(deployedFlow, opts);
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const warnings = [];
  const events = [];
  const spec = specWith([desiredFlow, ...(opts.more || [])]);
  assert.strictEqual(validateAppSpec(spec, { profile: 'plan' }).ok, true, `the fixture must itself be a valid spec: ${JSON.stringify(validateAppSpec(spec, { profile: 'plan' }).errors)}`);
  let error = null;
  let result = null;
  try {
    result = await runSdkBuild(spec, { sdk, provisionSdk: double.provision, apply: true, phases: ['business-process-flows'], warn: (m) => warnings.push(m), emit: (e) => events.push(e) });
  } catch (e) {
    error = e;
  }
  const done = events.filter((e) => e.phase === 'business-process-flows' && e.status !== 'start');
  return { ...double, warnings, events, done, result, error, spec };
}

test('NO EDIT: a rebuild of a flow that matches the spec reads it and writes nothing', async () => {
  const r = await rebuild(DEPLOYED());
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(writes(r.calls), [], `no write of any kind; saw ${JSON.stringify(writes(r.calls).map((c) => c.name))}`);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.done.length, 1, 'one step event for the flow');
  assert.strictEqual(r.done[0].status, 'skip');
  assert.match(r.done[0].label, /^business process flow "Ticket Handling" on new_ticket \(exists — reuse\)$/);
  assert.ok(!/recreate to change/.test(JSON.stringify(r.events)), 'it no longer says edits are not applied');
});

test('the deployed copy is fetched with overwrite, so a stale local copy never decides the plan', async () => {
  const r = await rebuild(DEPLOYED());
  const fetches = r.calls.filter((c) => c.name === 'fetchArtifact');
  assert.deepStrictEqual(fetches.map((c) => [c.args[0], c.args[1], c.args[2]]), [['bpf', 'flow-1', { overwrite: true }]]);
});

test('APPLIED: a step added to a stage is written in place, at its position, in one push', async () => {
  const d = DEPLOYED();
  const want = flowOf([stage('Triage', 'Subject:new_subject!', 'Priority:new_priority', 'Region:new_region'), d.stages[1], d.stages[2]]);
  const r = await rebuild(want);
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(structure(r.server()), specStructure(want).map((s) => s), 'the flow now holds what the spec says');
  assert.deepStrictEqual(structure(r.server()), ['Triage[Subject:new_subject!, Priority:new_priority, Region:new_region]', 'Resolve[Notes:new_notes, Confirmed with customer:new_owner]', 'Close[Status:new_status]']);
  const add = r.calls.find((c) => c.name === 'addElement');
  assert.deepStrictEqual([add.args[2], add.args[3], add.args[4]], ['/stages/0/steps', { name: 'Region', fieldName: 'new_region' }, { position: { index: 2 } }]);
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'pushArtifact').map((c) => [c.args[0], c.args[1]]), [['bpf', 'flow-1']], 'one push');
  assert.ok(!r.calls.some((c) => c.name === 'createArtifact' || c.name === 'removeElement'), 'nothing is recreated or removed');
  assert.strictEqual(r.done.length, 1);
  assert.strictEqual(r.done[0].status, 'ok');
  assert.strictEqual(r.events.filter((e) => e.phase === 'business-process-flows' && e.status === 'start').length, 1);
  assert.match(r.done[0].label, /^business process flow "Ticket Handling" on new_ticket \(exists — applying steps changed in 1 stage in place\)$/);
  assert.ok(r.server().stages.every((s, i) => s.id === `stage-${i + 1}`), 'every stage keeps its id');
});

test('APPLIED: a step renamed, rebound and made required or optional is patched in place — its id kept', async () => {
  const d = DEPLOYED();
  const want = flowOf([stage('Triage', 'Subject:new_subject', 'Urgency:new_region!'), d.stages[1], d.stages[2]]);
  const r = await rebuild(want);
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'updateElement').map((c) => [c.args[2], c.args[3]]), [
    ['/stages/0/steps/0', { required: false }],
    ['/stages/0/steps/1', { name: 'Urgency', fieldName: 'new_region', required: true }],
  ]);
  assert.deepStrictEqual(structure(r.server()).slice(0, 1), ['Triage[Subject:new_subject, Urgency:new_region!]']);
  assert.deepStrictEqual(r.server().stages[0].steps.map((s) => s.id), ['step-1-1', 'step-1-2']);
});

test('APPLIED: the steps of a stage put in another order are moved, not removed and re-added', async () => {
  const d = DEPLOYED();
  const want = flowOf([stage('Triage', 'Priority:new_priority', 'Subject:new_subject!'), d.stages[1], d.stages[2]]);
  const r = await rebuild(want);
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'moveElement').map((c) => [c.args[2], c.args[3], c.args[4]]), [['/stages/0/steps/1', '/stages/0/steps', { index: 0 }]]);
  assert.deepStrictEqual(r.server().stages[0].steps.map((s) => s.id), ['step-1-2', 'step-1-1']);
  assert.ok(!r.calls.some((c) => c.name === 'removeElement' || c.name === 'addElement'));
});

test('APPLIED: a stage added at the end and one in the middle are inserted where the spec lists them, carrying their steps', async () => {
  const d = DEPLOYED();
  const want = flowOf([d.stages[0], stage('Verify', 'Region:new_region!'), d.stages[1], d.stages[2], stage('Archive', 'Notes:new_notes')]);
  const r = await rebuild(want);
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(names(r.server().stages), ['Triage', 'Verify', 'Resolve', 'Close', 'Archive']);
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'addElement').map((c) => [c.args[2], c.args[3].name, c.args[3].entityLogicalName, c.args[3].steps, c.args[4]]), [
    ['/stages', 'Verify', 'new_ticket', [{ name: 'Region', fieldName: 'new_region', required: true }], { position: { index: 1 } }],
    ['/stages', 'Archive', 'new_ticket', [{ name: 'Notes', fieldName: 'new_notes' }], { position: { index: 4 } }],
  ]);
  assert.deepStrictEqual(r.server().stages.filter((s) => /^stage-/.test(s.id)).map((s) => s.name), ['Triage', 'Resolve', 'Close'], 'the three deployed stages keep their ids');
  assert.match(r.done[0].label, /applying 2 stages added in place/);
});

test('APPLIED: a stage renamed in place keeps its id, and the steps of that stage can change in the same run', async () => {
  const d = DEPLOYED();
  const want = flowOf([d.stages[0], stage('Fix', 'Notes:new_notes', 'Confirmed with customer:new_owner', 'Region:new_region'), d.stages[2]]);
  const r = await rebuild(want);
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'updateElement').map((c) => [c.args[2], c.args[3]]), [['/stages/1/name', 'Fix']]);
  assert.strictEqual(r.server().stages[1].id, 'stage-2', 'the stage a record sits on is the same stage');
  assert.strictEqual(r.server().stages[1].steps.length, 3);
  assert.match(r.done[0].label, /applying 1 stage renamed, steps changed in 1 stage in place/);
});

test('APPLIED: every kind of edit at once ends in the spec\'s structure, through steps that are all valid (a stage never holds no step)', async () => {
  // The rename (Triage -> Intake) and the addition (Verify) are in different places — Resolve sits between them — which is what lets
  // the plan tell them apart; side by side they would be ambiguous (see the replaced-by-a-different-number test above).
  const want = flowOf([
    stage('Intake', 'Region:new_region', 'Subject:new_subject', 'Urgency:new_priority!'),
    stage('Resolve', 'Customer confirmed:new_owner', 'Notes:new_notes'),
    stage('Verify', 'Owner:new_owner'),
    stage('Close', 'Status:new_status!'),
  ]);
  const r = await rebuild(want);
  assert.strictEqual(r.error, null, r.error && r.error.message);
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(structure(r.server()), [
    'Intake[Region:new_region, Subject:new_subject, Urgency:new_priority!]',
    'Resolve[Customer confirmed:new_owner, Notes:new_notes]',
    'Verify[Owner:new_owner]',
    'Close[Status:new_status!]',
  ]);
  assert.deepStrictEqual(r.server().stages.map((s) => s.id).filter((id) => /^stage-/.test(id)), ['stage-1', 'stage-2', 'stage-3']);
  assert.strictEqual(r.calls.filter((c) => c.name === 'pushArtifact').length, 1);
  assert.ok(!r.calls.some((c) => c.name === 'removeElement'));
});

test('APPLIED: applying is idempotent — the next rebuild reads back what the first wrote, finds it as the spec says, and writes nothing', async () => {
  const d = DEPLOYED();
  const want = flowOf([d.stages[0], stage('Fix', 'Notes:new_notes', 'Confirmed with customer:new_owner'), d.stages[2], stage('Archive', 'Notes:new_notes')]);
  const first = await rebuild(want);
  assert.ok(writes(first.calls).length > 0);
  // The second rebuild finds the flow as the first one left it: what the double now serves as deployed, read back into the spec's terms.
  const asDeployed = first.server();
  const second = await rebuild(want, {
    name: asDeployed.name,
    entity: 'new_ticket',
    stages: asDeployed.stages.map((s) => ({ name: s.name, steps: s.steps.map((p) => ({ name: p.name, field: p.fieldName, ...(p.required ? { required: true } : {}) })) })),
  });
  assert.deepStrictEqual(writes(second.calls), []);
  assert.strictEqual(second.done[0].status, 'skip');
  assert.match(second.done[0].label, /\(exists — reuse\)$/);
});

test('REFUSED: a stage the flow has and the spec does not list is not removed — the reason and the way forward are said, and nothing is written', async () => {
  const d = DEPLOYED();
  const r = await rebuild(flowOf([d.stages[0], d.stages[2]]));
  assert.strictEqual(r.error, null, 'the build goes on: a flow it leaves as it is must not stop an otherwise good app');
  assert.deepStrictEqual(writes(r.calls), [], 'no write of any kind');
  assert.strictEqual(r.done.length, 1);
  assert.strictEqual(r.done[0].status, 'skip');
  assert.match(r.done[0].label, /^business process flow "Ticket Handling" on new_ticket \(exists — reuse; its stages and steps were NOT changed: see the warning\)$/);
  assert.strictEqual(r.warnings.length, 1);
  const w = r.warnings[0];
  assert.match(w, /^business process flow "Ticket Handling" on new_ticket: NOT changed — the flow has stage 'Resolve', which the spec does not list\./);
  assert.match(w, /A build never removes or moves a stage or a step: a record that is partway through the flow sits on one of its stages, and the platform does not document what becomes of a record whose stage is removed or moved\./);
  assert.match(w, /No stage or step edits were applied; the requested Active\/Draft state is handled independently\. That includes the edits that would have been safe\./);
  assert.doesNotMatch(w, /nothing was written/i, 'the state may still be converged, so the warning must not claim that nothing was written');
  assert.match(w, /To keep the flow as it is, list in the spec what it has \(a stage or step added in Maker, say\)\./);
  assert.match(w, /To make the flow match the spec, make the change in Maker \(move or finish the records on a stage before removing it\); the next build then finds the flow as the spec says\./);
  assert.match(w, /If the flow's process records can be lost, delete the flow \(which deletes its backing table and the records in it\) and run the build again, which creates it afresh\.$/);
});

test('REFUSED: a step the flow has and the spec does not list, and stages reordered — each says what differs', async () => {
  const d = DEPLOYED();
  const step = await rebuild(flowOf([stage('Triage', 'Subject:new_subject!'), d.stages[1], d.stages[2]]));
  assert.deepStrictEqual(writes(step.calls), []);
  assert.match(step.warnings[0], /NOT changed — stage 'Triage' has step 'Priority', which the spec does not list\./);
  const order = await rebuild(flowOf([d.stages[0], d.stages[2], d.stages[1]]));
  assert.deepStrictEqual(writes(order.calls), []);
  assert.match(order.warnings[0], /NOT changed — the spec lists the stages 'Triage', 'Close', 'Resolve' in another order than the flow's 'Triage', 'Resolve', 'Close'\./);
});

test('REFUSED: all of a flow\'s edits wait for the one that is refused — a safe addition beside a dropped stage is not applied either', async () => {
  const d = DEPLOYED();
  const r = await rebuild(flowOf([d.stages[0], d.stages[2], stage('Archive', 'Notes:new_notes')]));
  assert.deepStrictEqual(writes(r.calls), []);
  assert.deepStrictEqual(structure(r.server()), structure({ stages: artifactStages(d) }), 'the flow is exactly as it was');
  assert.match(r.warnings[0], /the flow has stage 'Resolve', which the spec does not list/);
});

test('REFUSED: one flow\'s refusal never holds back another flow of the same spec', async () => {
  const d = DEPLOYED();
  const other = flowOf([stage('Only', 'Notes:new_notes')], { name: 'Other Process' });
  const otherWanted = flowOf([stage('Only', 'Notes:new_notes'), stage('Added', 'Region:new_region')], { name: 'Other Process' });
  const r = await rebuild(flowOf([d.stages[0], d.stages[2]]), d, { others: [{ deployed: other }], more: [otherWanted] });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.match(r.warnings[0], /^business process flow "Ticket Handling"/);
  assert.deepStrictEqual(names(r.server('flow-2').stages), ['Only', 'Added'], 'the other flow got its edit');
  assert.deepStrictEqual(structure(r.server('flow-1')), structure({ stages: artifactStages(d) }), 'the refused flow is as it was');
  assert.deepStrictEqual(r.done.map((e) => [e.n, e.status]), [[1, 'skip'], [2, 'ok']], 'one step event per flow');
});

test('UNCHECKED: a flow whose deployed definition cannot be read is left as it is, with the reason, and the build goes on', async () => {
  const r = await rebuild(DEPLOYED(), DEPLOYED(), { fetchFails: Object.assign(new Error('HTTP 503 from workflows'), { code: 'CONNECTION_ERROR' }) });
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(writes(r.calls), []);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /^business process flow "Ticket Handling" on new_ticket: its stages could not be compared with the spec \(HTTP 503 from workflows\); it was left as it is\.$/);
  assert.match(r.done[0].label, /exists — reuse; its stages could not be compared/);
});

const notImplemented = () => Object.assign(new Error("Operation 'bpf-structural-authoring' is not implemented yet: adding, removing or reordering stages on a process whose primary composite holds non-stage activities (multi-table nesting or advanced constructs) is not supported yet"), { code: 'NOT_IMPLEMENTED' });
// The SDK reports a refusal either way: this one it throws, and `saved: false` with the error is how it reports others — both reach the build with the same code.
for (const [how, refusePush] of [['thrown', notImplemented()], ['returned by value as a failed push', { resolve: notImplemented() }]]) {
  test(`an SDK that cannot author the flow (a branch, an action) writes nothing, and the edit is reported as not applied — the build goes on (${how})`, async () => {
    const d = DEPLOYED();
    const want = flowOf([...d.stages, stage('Archive', 'Notes:new_notes')]);
    const r = await rebuild(want, d, { refusePush });
    assert.strictEqual(r.error, null);
    assert.deepStrictEqual(structure(r.server()), structure({ stages: artifactStages(d) }), 'the flow on the server is untouched');
    assert.strictEqual(r.done.length, 1);
    assert.strictEqual(r.done[0].status, 'skip');
    assert.match(r.done[0].label, /NOT applied: the SDK cannot edit this flow — see the warning\)$/);
    assert.match(r.warnings[0], /^business process flow "Ticket Handling" on new_ticket: its stage edits were NOT applied — .*not implemented yet.*No stage or step edits were applied; the requested Active\/Draft state is handled independently\. Make the change in Maker \(the SDK cannot make this edit to a flow with branches or other advanced constructs\), or put the spec back in line with the flow\.$/);
    assert.doesNotMatch(r.warnings[0], /nothing was written/i);
  });
}

test('STATE: an edit the SDK refuses does not stop the flow\'s state from being converged', async () => {
  const d = DEPLOYED();
  const want = flowOf([...d.stages, stage('Archive', 'Notes:new_notes')]);
  const r = await rebuild(want, d, { statecode: 0, refusePush: notImplemented() });
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'updateRecord').map((c) => c.args), [['workflow', 'flow-1', { statecode: 1, statuscode: 2 }]], 'a Draft flow the spec wants Active is still activated');
  assert.strictEqual(r.done.length, 1);
  assert.strictEqual(r.done[0].status, 'skip');
});

// A refused stage edit says what it did NOT do — apply a stage or step edit — and not that the flow was left as it was: the Active/Draft
// state the spec asks for is converged by its own step (the state is not a stage edit, and a flow a maker left in the wrong one stays
// invisible or running), so "nothing was written" was untrue whenever the two differed. Both refusals say it the same way: the plan's
// (a stage or step the spec does not list) and the SDK's before it writes (a branch it cannot author).
test('REFUSED: the Active/Draft state the spec asks for is still converged, and the warning says that instead of claiming nothing was written', async () => {
  const d = DEPLOYED();
  const r = await rebuild(flowOf([d.stages[0], d.stages[2]], { status: 'Draft' }), d, { statecode: 1 });
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(writes(r.calls).filter((c) => c.name !== 'updateRecord'), [], 'no stage or step edit, and no push, was made');
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'updateRecord').map((c) => c.args), [['workflow', 'flow-1', { statecode: 0, statuscode: 1 }]], 'but the flow the spec wants in Draft is deactivated');
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /No stage or step edits were applied; the requested Active\/Draft state is handled independently\./);
  assert.doesNotMatch(r.warnings[0], /nothing was written/i);
  assert.match(r.done[0].label, /\(existed in the wrong state — deactivated; its stages and steps were NOT changed: see the warning\)$/);
});

test('NOT applied by the SDK: the Active/Draft state the spec asks for is still converged, and the warning says that instead of claiming nothing was written', async () => {
  const d = DEPLOYED();
  const r = await rebuild(flowOf([...d.stages, stage('Archive', 'Notes:new_notes')], { status: 'Draft' }), d, { statecode: 1, refusePush: notImplemented() });
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(structure(r.server()), structure({ stages: artifactStages(d) }), 'the definition on the server is untouched');
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'updateRecord').map((c) => c.args), [['workflow', 'flow-1', { statecode: 0, statuscode: 1 }]]);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /No stage or step edits were applied; the requested Active\/Draft state is handled independently\./);
  assert.doesNotMatch(r.warnings[0], /nothing was written/i);
});

test('a push the platform refuses AFTER the write began halts the build — a half-applied live flow is never skipped', async () => {
  const d = DEPLOYED();
  const want = flowOf([...d.stages, stage('Archive', 'Notes:new_notes')]);
  const r = await rebuild(want, d, { refusePush: Object.assign(new Error('Business process flow x was deactivated to apply an edit, and it could NOT be reactivated — it is left DISABLED.'), { code: 'BPF_LEFT_DEACTIVATED' }) });
  assert.ok(r.error, 'the build halts');
  assert.match(r.error.message, /business-process-flows failed:.*left DISABLED/);
  assert.strictEqual(r.error.code, 'BPF_LEFT_DEACTIVATED');
  const conflict = await rebuild(want, d, { refusePush: { resolve: Object.assign(new Error('Version conflict (412)'), { code: 'VERSION_CONFLICT' }) } });
  assert.ok(conflict.error, 'a concurrent edit halts too (requireSuccessfulPush)');
});

test('STATE: a Draft flow the spec wants Active is edited first, then activated — one step event, both reported', async () => {
  const d = DEPLOYED();
  const want = flowOf([d.stages[0], d.stages[1], d.stages[2], stage('Archive', 'Notes:new_notes')]);
  const r = await rebuild(want, d, { statecode: 0 });
  assert.deepStrictEqual(r.warnings, []);
  const order = r.calls.filter((c) => ['addElement', 'pushArtifact', 'updateRecord'].includes(c.name)).map((c) => c.name);
  assert.deepStrictEqual(order, ['addElement', 'pushArtifact', 'updateRecord']);
  assert.deepStrictEqual(r.calls.find((c) => c.name === 'updateRecord').args, ['workflow', 'flow-1', { statecode: 1, statuscode: 2 }]);
  assert.strictEqual(r.done.length, 1);
  assert.strictEqual(r.done[0].status, 'ok');
  assert.strictEqual(r.server().status, 'Draft', 'the artifact the SDK pushed was Draft: the activation is the existing, separate step');
});

test('STATE: an Active flow the spec wants Draft is edited, then deactivated', async () => {
  const d = DEPLOYED();
  const want = flowOf([d.stages[0], d.stages[1], d.stages[2], stage('Archive', 'Notes:new_notes')], { status: 'Draft' });
  const r = await rebuild(want, d, { statecode: 1 });
  const order = r.calls.filter((c) => ['addElement', 'pushArtifact', 'updateRecord'].includes(c.name)).map((c) => c.name);
  assert.deepStrictEqual(order, ['addElement', 'pushArtifact', 'updateRecord']);
  assert.deepStrictEqual(r.calls.find((c) => c.name === 'updateRecord').args, ['workflow', 'flow-1', { statecode: 0, statuscode: 1 }]);
});

test('STATE: a state mismatch with no stage edit is converged exactly as before, with the same wording', async () => {
  const r = await rebuild(DEPLOYED(), DEPLOYED(), { statecode: 0 });
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'updateRecord').map((c) => c.args), [['workflow', 'flow-1', { statecode: 1, statuscode: 2 }]]);
  assert.match(r.done[0].label, /^business process flow "Ticket Handling" on new_ticket \(existed in the wrong state — activated\)$/);
  assert.ok(!r.calls.some((c) => c.name === 'pushArtifact'));
});

test('a flow the spec creates is created whole, as before — the stage-edit path is for a flow that exists', async () => {
  const r = await rebuild(DEPLOYED(), DEPLOYED(), { rows: [] });
  assert.deepStrictEqual(r.calls.filter((c) => c.name === 'createArtifact').map((c) => c.args[0]), ['bpf']);
  assert.ok(!r.calls.some((c) => c.name === 'fetchArtifact' || c.name === 'getArtifact'), 'a flow nobody has yet is not read back');
});

test('the step plan counts one event per flow whichever way a flow goes (the total the plan advertised holds)', async () => {
  const d = DEPLOYED();
  for (const want of [DEPLOYED(), flowOf([...d.stages, stage('Archive', 'Notes:new_notes')]), flowOf([d.stages[0]])]) {
    const r = await rebuild(want);
    const labelled = r.events.filter((e) => e.phase === 'business-process-flows');
    assert.deepStrictEqual([...new Set(labelled.map((e) => e.n))], [1], 'every event of the flow carries the same step number');
    assert.ok(labelled.every((e) => e.total === 1));
  }
});

// --- 3. the change classifier -------------------------------------------------------------------

test('CLASSIFIER: an edit the build applies is a full build and NOT debt; one it refuses is debt, as before', () => {
  const prior = specWith([DEPLOYED()]);
  const d = DEPLOYED();
  const applied = classifyChanges(specWith([flowOf([...d.stages, stage('Archive', 'Notes:new_notes')])]), prior);
  assert.strictEqual(applied.verdict, 'full');
  assert.deepStrictEqual(applied.debt, [], JSON.stringify(applied.debt));
  assert.ok(applied.fullReasons.some((r) => /business-process-flows: businessProcessFlow 'new_ticket\|Ticket Handling' stages changed — reconciled by a full build/.test(r)), JSON.stringify(applied.fullReasons));
  const renamed = classifyChanges(specWith([flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2]])]), prior);
  assert.deepStrictEqual(renamed.debt, [], 'a rename is applied in place');
  const refused = classifyChanges(specWith([flowOf([d.stages[0], d.stages[2]])]), prior);
  assert.strictEqual(refused.verdict, 'full');
  assert.deepStrictEqual(refused.debt, [{ artifactType: 'businessProcessFlow', identity: 'new_ticket|Ticket Handling', reason: 'businessProcessFlow-edit-not-convergent' }]);
  assert.ok(refused.fullReasons.some((r) => /edited — the additive build engine skips edits/.test(r)), JSON.stringify(refused.fullReasons));
});

test('CLASSIFIER: a stage edit together with a flow property the build does not apply is still debt', () => {
  const d = DEPLOYED();
  const prior = specWith([DEPLOYED()]);
  const both = classifyChanges(specWith([flowOf([...d.stages, stage('Archive', 'Notes:new_notes')], { description: 'a new description' })]), prior);
  assert.deepStrictEqual(both.debt.map((x) => x.reason), ['businessProcessFlow-edit-not-convergent'], 'the description is not applied, so the edit is not fully converged');
  const status = classifyChanges(specWith([flowOf([...d.stages, stage('Archive', 'Notes:new_notes')], { status: 'Draft' })]), prior);
  assert.deepStrictEqual(status.debt, [], 'status and the stage edit are both applied');
});

// --- 4. the real bundle -------------------------------------------------------------------------
//
// A fake Dataverse that keeps the flow row (XAML and all) the way the platform does: a create stores the row the SDK sent, a GET
// serves it back, a PATCH merges into it and moves its version, and a `$batch` change set applies its PATCHes in order. The edits go
// through a FRESH SDK over a fresh workspace — what a rebuild is — and the stage plan reads the flow the way the build does.

function batchResponse(parts) {
  const lines = ['--batchresponse_x', 'Content-Type: multipart/mixed; boundary=changesetresponse_x', ''];
  for (const p of parts) {
    lines.push('--changesetresponse_x', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${p.id}`, '',
      p.representation ? 'HTTP/1.1 200 OK' : 'HTTP/1.1 204 No Content', `ETag: ${p.etag}`, ...(p.representation ? ['Content-Type: application/json', '', JSON.stringify({ '@odata.etag': p.etag })] : ['']), '');
  }
  lines.push('--changesetresponse_x--', '--batchresponse_x--', '');
  return lines.join('\r\n');
}

function fakeWorkflows({ atomic = true } = {}) {
  const rows = new Map();
  const log = [];
  const bump = (row) => { row['@odata.etag'] = `W/"${Number(/\d+/.exec(row['@odata.etag'])[0]) + 1}"`; };
  const client = {
    get: async (url) => {
      const m = /\/workflows\(([^)]+)\)/i.exec(String(url));
      if (m) {
        const row = rows.get(m[1].replace(/'/g, ''));
        return row ? { status: 200, headers: { etag: row['@odata.etag'] }, body: { ...row } } : { status: 404, headers: {}, body: { error: { message: 'not found' } } };
      }
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => {
      log.push({ verb: 'POST', url: String(url), keys: Object.keys(body) });
      rows.set(body.workflowid, { ...body, statecode: 0, statuscode: 1, '@odata.etag': 'W/"1"' });
      return { status: 201, headers: { 'odata-entityid': `https://contoso.crm.dynamics.com/api/data/v9.2/workflows(${body.workflowid})` }, body: { workflowid: body.workflowid, '@odata.etag': 'W/"1"' } };
    },
    patch: async (url, body, options) => {
      const id = /workflows\(([^)]+)\)/.exec(String(url))[1];
      log.push({ verb: 'PATCH', url: String(url), keys: Object.keys(body), ifMatch: (options && options.headers && options.headers['If-Match']) || null, body });
      Object.assign(rows.get(id), body);
      bump(rows.get(id));
      return { status: 200, headers: { etag: rows.get(id)['@odata.etag'] }, body: { '@odata.etag': rows.get(id)['@odata.etag'] } };
    },
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  if (atomic) {
    client.postRaw = async (url, body) => {
      const parts = String(body).split(/^--changeset_\S*/m).slice(1).filter((p) => /Content-ID/i.test(p));
      const out = [];
      for (const part of parts) {
        const request = /^(PATCH|POST|DELETE|GET) (\S+) HTTP/m.exec(part);
        const ifMatch = /^If-Match:\s*(.+)$/im.exec(part);
        const prefer = /^Prefer:\s*(.+)$/im.exec(part);
        const json = part.slice(part.indexOf('{'), part.lastIndexOf('}') + 1);
        const patch = json ? JSON.parse(json) : {};
        const row = rows.get(/workflows\(([^)]+)\)/.exec(request[2])[1]);
        log.push({ verb: 'BATCH-PATCH', url: request[2], keys: Object.keys(patch), ifMatch: ifMatch ? ifMatch[1].trim() : null });
        Object.assign(row, patch);
        bump(row);
        out.push({ id: /Content-ID:\s*(\S+)/i.exec(part)[1], etag: row['@odata.etag'], representation: !!(prefer && /representation/.test(prefer[1])) });
      }
      return { status: 200, headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_x' }, body: batchResponse(out) };
    };
  }
  return { client, rows, log };
}

async function realBpf({ atomic = true, status = 'Active', flow = DEPLOYED() } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const fake = fakeWorkflows({ atomic });
  const open = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpf-stages-'));
    tempDirs.push(dir);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient: fake.client });
    await sdk.initWorkspace();
    return sdk;
  };
  const creator = await open();
  const art = await creator.createArtifact('bpf', bpfDef({ ...flow, status }));
  await creator.pushArtifact('bpf', art.id);
  fake.log.length = 0;
  // A rebuild: a SDK over a workspace that has never seen the flow.
  return { sdk: await open(), open, fake, id: art.id, row: () => fake.rows.get(art.id) };
}
const xamlStages = (row) => [...row.xaml.matchAll(/DisplayName="StageStep\d+: ([^"]*)"/g)].map((m) => m[1]);
const xamlStageIds = (row) => [...row.xaml.matchAll(/x:Key="StageId">([^<]+)</g)].map((m) => m[1]);
const xamlSteps = (row) => [...row.xaml.matchAll(/DisplayName="StepStep\d+: ([^"]*)"/g)].map((m) => m[1]);

test('REAL BUNDLE: an Active flow\'s edits go over the wire as ONE conditional change set, and the flow stays Active', async () => {
  const { sdk, fake, id, row } = await realBpf();
  const idsBefore = xamlStageIds(row());
  const d = DEPLOYED();
  const want = flowOf([{ ...d.stages[0], name: 'Intake' }, stage('Resolve', 'Notes:new_notes', 'Confirmed with customer:new_owner', 'Region:new_region'), d.stages[2], stage('Archive', 'Notes:new_notes')]);
  const inspected = await inspectBpfStages(sdk, want, id);
  assert.strictEqual(inspected.kind, 'edit', JSON.stringify(inspected));
  const pushed = await applyBpfStages(sdk, want, id, inspected.plan, {});
  assert.strictEqual(pushed.saved, true);
  // The wire: a single $batch change set (two PATCHes, the definition's header under the row's token, then the XAML) — no
  // deactivation, no activation, and no unconditional write.
  assert.deepStrictEqual(fake.log.map((l) => l.verb), ['BATCH-PATCH', 'BATCH-PATCH'], JSON.stringify(fake.log));
  assert.deepStrictEqual(fake.log.map((l) => l.keys), [['name', 'processorder'], ['xaml']]);
  assert.ok(fake.log[0].ifMatch, 'conditioned on the version the fetch read');
  assert.ok(!fake.log.some((l) => (l.keys || []).includes('statecode')), 'the flow was never deactivated or activated');
  assert.strictEqual(row().statecode, 1, 'the flow is still Active');
  // The stored definition: renamed, extended, and every stage that existed still has its own id.
  assert.deepStrictEqual(xamlStages(row()), ['Intake', 'Resolve', 'Close', 'Archive']);
  assert.deepStrictEqual(xamlStageIds(row()).slice(0, 3), idsBefore, 'a renamed stage is the same stage');
  assert.strictEqual(xamlStageIds(row()).length, 4);
  assert.ok(xamlSteps(row()).includes('Region'), 'the added step reached the definition');
});

test('REAL BUNDLE: a rebuild after the edit finds the flow as the spec says — the next run writes nothing', async () => {
  const { sdk, open, fake, id } = await realBpf();
  const d = DEPLOYED();
  const want = flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2], stage('Archive', 'Notes:new_notes')]);
  const first = await inspectBpfStages(sdk, want, id);
  await applyBpfStages(sdk, want, id, first.plan, {});
  fake.log.length = 0;
  const again = await inspectBpfStages(await open(), want, id);
  assert.strictEqual(again.kind, 'same', JSON.stringify(again.plan && again.plan.refusals));
  assert.deepStrictEqual(fake.log, [], 'reading a flow that matches writes nothing');
});

test('REAL BUNDLE: a Draft flow is edited with one PATCH and left Draft', async () => {
  const { sdk, fake, id, row } = await realBpf({ status: 'Draft' });
  const d = DEPLOYED();
  const want = flowOf([stage('Triage', 'Subject:new_subject', 'Priority:new_priority'), d.stages[1], d.stages[2]]);
  const inspected = await inspectBpfStages(sdk, want, id);
  assert.strictEqual(inspected.kind, 'edit');
  await applyBpfStages(sdk, want, id, inspected.plan, {});
  assert.deepStrictEqual(fake.log.map((l) => [l.verb, l.keys]), [['PATCH', ['xaml', 'name', 'processorder']]]);
  assert.strictEqual(row().statecode, 0);
});

test('REAL BUNDLE: a rename keeps the stage\'s id, a new stage gets one of its own, and a step keeps its id through a rename and a move', async () => {
  const { sdk, id, row } = await realBpf();
  const before = [...row().xaml.matchAll(/x:Key="ProcessStepId">([^<]+)</g)].map((m) => m[1]);
  const d = DEPLOYED();
  const want = flowOf([stage('Triage', 'Priority:new_priority', 'Subject:new_subject!'), stage('Resolve', 'Customer confirmed:new_owner', 'Notes:new_notes'), d.stages[2]]);
  const inspected = await inspectBpfStages(sdk, want, id);
  await applyBpfStages(sdk, want, id, inspected.plan, {});
  const after = [...row().xaml.matchAll(/x:Key="ProcessStepId">([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(after.slice(0, 2), [before[1], before[0]], 'the two Triage steps swapped, each with its own id');
  assert.deepStrictEqual(after.slice(2, 4), [before[3], before[2]], 'the two Resolve steps swapped, the renamed one kept its id');
  assert.deepStrictEqual(xamlSteps(row()).slice(2, 4), ['Customer confirmed', 'Notes']);
});

test('REAL BUNDLE: a flow whose primary composite holds something that is not a stage cannot have a stage added — the SDK says so before it writes — and a rename keeps what it does not model', async () => {
  const { fake, open, id, row } = await realBpf();
  // What a branch added in Maker looks like to the SDK: another kind of activity beside the stages.
  const branch = '<mxswa:ActivityReference AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.ConditionComposite, Microsoft.Crm.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35" DisplayName="ConditionStep9: c"><mxswa:ActivityReference.Properties><sco:Collection x:TypeArguments="Activity" x:Key="Activities" /></mxswa:ActivityReference.Properties></mxswa:ActivityReference>';
  const injected = row().xaml.replace(/(<sco:Collection x:TypeArguments="Activity" x:Key="Activities">)(<mxswa:ActivityReference AssemblyQualifiedName="Microsoft\.Crm\.Workflow\.Activities\.StageComposite)/, `$1${branch}$2`);
  assert.notStrictEqual(injected, row().xaml, 'the fixture really holds the extra activity');
  row().xaml = injected;
  const d = DEPLOYED();
  const add = flowOf([...d.stages, stage('Archive', 'Notes:new_notes')]);
  const sdk = await open();
  const inspected = await inspectBpfStages(sdk, add, id);
  assert.strictEqual(inspected.kind, 'edit');
  await assert.rejects(applyBpfStages(sdk, add, id, inspected.plan, {}), (e) => e && e.code === 'NOT_IMPLEMENTED');
  assert.deepStrictEqual(fake.log, [], 'nothing was sent');
  // A rename is still something the SDK can do to that very flow — and the rest of the definition goes back as it was.
  const again = await open();
  const rename = flowOf([d.stages[0], { ...d.stages[1], name: 'Fix' }, d.stages[2]]);
  const second = await inspectBpfStages(again, rename, id);
  assert.strictEqual(second.kind, 'edit');
  await applyBpfStages(again, rename, id, second.plan, {});
  assert.deepStrictEqual(xamlStages(row()), ['Triage', 'Fix', 'Close']);
  assert.ok(row().xaml.includes(branch), 'the activity the SDK does not model is still in the definition, untouched');
});

// The SDK refuses a structural edit per CONTAINER, not per flow: an activity it does not model stops the structural edit of the one
// collection that holds it, and no other. What an action held by a stage looks like to the SDK: another kind of activity beside the
// stage's steps. Adding a STAGE is not stopped by it (the stages' own collection holds nothing but stages); adding a STEP to that
// stage is.
const STAGE_ACTION = '<mxswa:ActivityReference AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.ActionComposite, Microsoft.Crm.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35" DisplayName="ActionStep9: kept"><mxswa:ActivityReference.Properties><sco:Collection x:TypeArguments="Activity" x:Key="Activities" /></mxswa:ActivityReference.Properties></mxswa:ActivityReference>';
function holdStageAction(row) {
  const firstStageSteps = /(<sco:Collection x:TypeArguments="Activity" x:Key="Activities">)(<mxswa:ActivityReference AssemblyQualifiedName="Microsoft\.Crm\.Workflow\.Activities\.StepComposite)/;
  const injected = row.xaml.replace(firstStageSteps, `$1${STAGE_ACTION}$2`);
  assert.notStrictEqual(injected, row.xaml, 'the fixture really holds the action');
  row.xaml = injected;
}

test('REAL BUNDLE: an action held by one STAGE does not stop a stage being added — and the action is kept, and the flow stays Active', async () => {
  const { open, id, row } = await realBpf();
  holdStageAction(row());
  const d = DEPLOYED();
  const add = flowOf([...d.stages, stage('Archive', 'Notes:new_notes')]);
  const sdk = await open();
  const inspected = await inspectBpfStages(sdk, add, id);
  assert.strictEqual(inspected.kind, 'edit', JSON.stringify(inspected));
  const pushed = await applyBpfStages(sdk, add, id, inspected.plan, {});
  assert.strictEqual(pushed.saved, true);
  assert.deepStrictEqual(xamlStages(row()), ['Triage', 'Resolve', 'Close', 'Archive']);
  assert.ok(row().xaml.includes(STAGE_ACTION), 'the action the SDK does not model is still in the definition, untouched');
  assert.strictEqual(row().statecode, 1, 'the flow is still Active');
});

test('REAL BUNDLE: a step added to the stage that holds an action is refused before any request, the flow is left as it was, and a step rename on that stage still works', async () => {
  const { fake, open, id, row } = await realBpf();
  holdStageAction(row());
  const original = row().xaml;
  const d = DEPLOYED();
  const addStep = flowOf([stage('Triage', 'Subject:new_subject!', 'Priority:new_priority', 'Region:new_region'), d.stages[1], d.stages[2]]);
  const sdk = await open();
  const inspected = await inspectBpfStages(sdk, addStep, id);
  assert.strictEqual(inspected.kind, 'edit', JSON.stringify(inspected));
  await assert.rejects(applyBpfStages(sdk, addStep, id, inspected.plan, {}), (e) => e && e.code === 'NOT_IMPLEMENTED');
  assert.deepStrictEqual(fake.log, [], 'nothing was sent');
  assert.strictEqual(row().xaml, original, 'the stored definition is exactly as it was');
  // A rename of a step is not a structural edit of the stage's collection: it works, and what the SDK does not model stays.
  const again = await open();
  const rename = flowOf([stage('Triage', 'Subject:new_subject!', 'Urgency:new_priority'), d.stages[1], d.stages[2]]);
  const second = await inspectBpfStages(again, rename, id);
  assert.strictEqual(second.kind, 'edit', JSON.stringify(second));
  await applyBpfStages(again, rename, id, second.plan, {});
  assert.deepStrictEqual(xamlSteps(row()).slice(0, 2), ['Subject', 'Urgency']);
  assert.ok(row().xaml.includes(STAGE_ACTION), 'the action is still in the definition');
});

test('REAL BUNDLE: the deployed flow is read as the plan expects — stage and step ids, names, columns, required', async () => {
  const { sdk, id } = await realBpf();
  await sdk.fetchArtifact('bpf', id, { overwrite: true });
  const artifact = await sdk.getArtifact('bpf', id);
  const shape = deployedBpfStages(artifact.stages);
  assert.deepStrictEqual(shape.map((s) => [s.name, s.entity, s.steps.map((p) => [p.name, p.field, p.required])]), [
    ['Triage', 'new_ticket', [['Subject', 'new_subject', true], ['Priority', 'new_priority', false]]],
    ['Resolve', 'new_ticket', [['Notes', 'new_notes', false], ['Confirmed with customer', 'new_owner', false]]],
    ['Close', 'new_ticket', [['Status', 'new_status', false]]],
  ]);
  assert.ok(shape.every((s) => s.id && s.steps.every((p) => p.id)), 'every stage and step carries an id');
  assert.strictEqual(diffBpfStages(shape, desiredBpfStages(DEPLOYED()), { entity: 'new_ticket' }).verdict, 'same', 'the flow the build made reads back as the spec said');
});

test('REAL BUNDLE: a stale local copy is replaced by the environment\'s — the plan is made on what is deployed', async () => {
  const { sdk, id } = await realBpf();
  await sdk.fetchArtifact('bpf', id);
  await sdk.updateElement('bpf', id, '/stages/0/name', 'Edited by an interrupted build');
  const inspected = await inspectBpfStages(sdk, DEPLOYED(), id);
  assert.strictEqual(inspected.kind, 'same', 'the interrupted build\'s local rename does not count: only the deployed flow does');
  assert.strictEqual((await sdk.getArtifact('bpf', id)).stages[0].name, 'Triage');
});

// An Active flow's change set the customization lock refuses. The platform answers the whole `$batch` 429 with ONE part, the guard's,
// and nothing written (measured: etag, state, name and definition unchanged):
//   --batchresponse_<id>
//   Content-Type: multipart/mixed; boundary=changesetresponse_<id>
//
//   --changesetresponse_<id>
//   Content-Type: application/http
//   Content-ID: 1
//
//   HTTP/1.1 429 Too Many Requests
//   {"error":{"code":"0x80071151","message":"Cannot start the requested operation [EntityCustomization] because there is another [WorkflowSetState] running…"}}
//   --changesetresponse_<id>--
//   --batchresponse_<id>--
// The plugin's HTTP client delivers it once — a `$batch` it never sends again but for the two kinds lib/sdk-http-client.js names — and the
// SDK sends the IDENTICAL change set again after its first wait (2 s), the guard still under the caller's If-Match, so a flow edited in the
// meantime would fail it 412 with nothing written. This is the one BPF write the plugin makes that the SDK's lock re-send reaches: a Draft
// flow's edit is one PATCH, and the plugin never takes the deactivate, edit and activate cycle (its client has postRaw).
function lockRefusedChangeSet(contentId) {
  return ['--batchresponse_l', 'Content-Type: multipart/mixed; boundary=changesetresponse_l', '', '--changesetresponse_l', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${contentId}`, '',
    'HTTP/1.1 429 Too Many Requests', 'Content-Type: application/json; odata.metadata=minimal', '',
    JSON.stringify({ error: { code: '0x80071151', message: 'Cannot start the requested operation [EntityCustomization] because there is another [WorkflowSetState] running at this moment.' } }),
    '--changesetresponse_l--', '--batchresponse_l--', ''].join('\r\n');
}

// SDK waits use setTimeout; advance those waits without speeding up the asynchronous workspace writes. The wall-clock bound
// catches a hung call even if a loaded machine needs many event-loop turns to finish one write.
async function settleBpfWaits(t, promise) {
  let settled = false;
  let value;
  let failure;
  promise.then((result) => { settled = true; value = result; }, (error) => { settled = true; failure = error; });
  const deadline = Date.now() + 20000;
  while (!settled && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5000);
  }
  assert.ok(settled, 'the SDK call settled within the wall-clock bound');
  if (failure) throw failure;
  return value;
}

test('REAL BUNDLE: an Active flow\'s change set the customization lock refuses is delivered ONCE by the plugin\'s HTTP client and sent again by the SDK — the edit lands under the same If-Match, and the flow stays Active', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const { fake, id, row } = await realBpf();
  const batches = [];
  let refusals = 1;
  // The transport under the plugin's real client, onto the fake: what Node's client hands it — the status, the headers and the body as text.
  const asTransport = async (answer) => ({ statusCode: answer.status, headers: answer.headers, body: typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body) });
  async function request({ url, method, headers, body }) {
    if (method === 'POST' && /\/\$batch$/.test(new URL(url).pathname)) {
      batches.push(String(body));
      if (refusals > 0) {
        refusals -= 1;
        return { statusCode: 429, headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_l' }, body: lockRefusedChangeSet(/Content-ID:\s*(\S+)/i.exec(String(body))[1]) };
      }
      return asTransport(await fake.client.postRaw(url, body));
    }
    if (method === 'GET') return asTransport(await fake.client.get(url));
    if (method === 'PATCH') return asTransport(await fake.client.patch(url, JSON.parse(body), { headers }));
    return asTransport(await fake.client[method.toLowerCase()](url, body === null ? undefined : JSON.parse(body), { headers }));
  }
  const clientSleeps = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpf-stages-lock-'));
  tempDirs.push(dir);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient: createAzHttpClient('https://contoso.crm.dynamics.com', { getToken: () => 'token', request, sleep: async (ms) => { clientSleeps.push(ms); } }) });
  await sdk.initWorkspace();
  const d = DEPLOYED();
  const want = flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2]]);
  const inspected = await inspectBpfStages(sdk, want, id);
  assert.strictEqual(inspected.kind, 'edit', JSON.stringify(inspected));
  const pushed = await applyBpfStages(sdk, want, id, inspected.plan, {});
  assert.strictEqual(pushed.saved, true);
  assert.strictEqual(batches.length, 2, 'the refused change set and the SDK\u2019s one re-send of it');
  assert.strictEqual(batches[1], batches[0], 'the same body: the guard under the same If-Match, the definition on the same row');
  assert.deepStrictEqual(clientSleeps, [], 'the client sent the change set once: it waited for nothing');
  assert.deepStrictEqual(fake.log.map((l) => l.verb), ['BATCH-PATCH', 'BATCH-PATCH'], 'only the accepted change set wrote anything');
  assert.deepStrictEqual(xamlStages(row()), ['Intake', 'Resolve', 'Close']);
  assert.strictEqual(row().statecode, 1, 'the flow is still Active');
});

test('REAL BUNDLE: an Active edit refused by the lock then edited by another maker fails its identical guarded resend without writing', async (t) => {
  const { sdk, fake, id, row } = await realBpf();
  const bodies = [];
  fake.client.postRaw = async (url, body) => {
    bodies.push(String(body));
    const contentId = /Content-ID:\s*(\S+)/i.exec(String(body))[1];
    if (bodies.length === 1) {
      row().name = 'Another maker';
      row()['@odata.etag'] = 'W/"99"';
      return { status: 429, headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_l' }, body: lockRefusedChangeSet(contentId) };
    }
    const validator = /^If-Match:\s*(.+)$/im.exec(String(body))[1].trim();
    assert.notStrictEqual(validator, row()['@odata.etag'], 'the resend keeps the old guard, never a newly read token');
    return { status: 200, headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_l' }, body: lockRefusedChangeSet(contentId).replace('429 Too Many Requests', '412 Precondition Failed') };
  };
  const d = DEPLOYED();
  const want = flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2]]);
  const inspected = await inspectBpfStages(sdk, want, id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(settleBpfWaits(t, applyBpfStages(sdk, want, id, inspected.plan)), { code: 'version-conflict' });
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(bodies[1], bodies[0]);
  assert.deepStrictEqual(fake.log, []);
  assert.deepStrictEqual(xamlStages(row()), ['Triage', 'Resolve', 'Close']);
  assert.strictEqual(row().name, 'Another maker');
  assert.strictEqual(row().statecode, 1);
});

test('REAL BUNDLE: an ambiguous 503 envelope carrying a lock-refused part never authorizes an Active edit resend', async () => {
  const { sdk, fake, id, row } = await realBpf();
  let sends = 0;
  fake.client.postRaw = async (url, body) => {
    sends += 1;
    return { status: 503, headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_l' }, body: lockRefusedChangeSet(/Content-ID:\s*(\S+)/i.exec(String(body))[1]) };
  };
  const d = DEPLOYED();
  const want = flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2]]);
  const inspected = await inspectBpfStages(sdk, want, id);
  await assert.rejects(applyBpfStages(sdk, want, id, inspected.plan), { code: 'CONNECTION_ERROR' });
  assert.strictEqual(sends, 1);
  assert.deepStrictEqual(fake.log, []);
  assert.deepStrictEqual(xamlStages(row()), ['Triage', 'Resolve', 'Close']);
});

test('REAL BUNDLE: a fallback edit whose activation exhausts the lock waits succeeds when its bound compensation is acknowledged, keeping that write\'s token', async (t) => {
  // The production client has postRaw and takes the in-place path above. This explicitly non-batch client pins the SDK's
  // fallback contract too: a late, acknowledged activation is success, not a stale 429 that would make the builder replay it.
  const { sdk, fake, id, row } = await realBpf({ atomic: false });
  const patch = fake.client.patch;
  const activationGuards = [];
  fake.client.patch = async (url, body, options) => {
    assert.strictEqual(options.headers['If-Match'], row()['@odata.etag'], 'every fallback write remains bound to its last acknowledged predecessor');
    if (body.statecode === 1) {
      activationGuards.push(options.headers['If-Match']);
      if (activationGuards.length <= 38) return { status: 429, headers: {}, body: { error: { code: '0x80071151', message: 'Cannot start the requested operation [WorkflowSetState] because another customization is running.' } } };
    }
    return patch(url, body, options);
  };
  const d = DEPLOYED();
  const want = flowOf([{ ...d.stages[0], name: 'Intake' }, d.stages[1], d.stages[2]]);
  const inspected = await inspectBpfStages(sdk, want, id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pushed = await settleBpfWaits(t, applyBpfStages(sdk, want, id, inspected.plan));
  assert.strictEqual(pushed.saved, true);
  assert.strictEqual(activationGuards.length, 39, '38 forward refusals, then the acknowledged bound compensation');
  assert.strictEqual(new Set(activationGuards).size, 1, 'the compensation writes the same version, never another maker\'s edit');
  assert.strictEqual(row().statecode, 1);
  assert.deepStrictEqual(xamlStages(row()), ['Intake', 'Resolve', 'Close']);
  // No fetch between the pushes: only the compensation's returned token can authorize this next edit.
  await sdk.updateElement('bpf', id, '/stages/0/name', 'Screen');
  assert.strictEqual((await settleBpfWaits(t, sdk.pushArtifact('bpf', id))).saved, true);
  assert.deepStrictEqual(xamlStages(row()), ['Screen', 'Resolve', 'Close']);
});
