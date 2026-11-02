'use strict';
// Declared business process flows (businessProcessFlows[].reconcile: "declared") wired into the build: the spec gate, the
// business-process-flows phase's dispatch to the managed flow helper (lib/bpf-settlement.js settleDeclaredBpf), the halt it is
// given, the workflow effect gate the build binds to its store (lib/deferred-workflow-gate.js), the backing table it hands to the
// role grants, and a stored attempt whose declaration left the spec. Everything runs through the real engine
// (lib/sdk-build.js runSdkBuild), the real vendored SDK and the plugin's real client over an in-memory workflow table
// (helpers/workflow-wire.js) that enforces If-Match, with the CLI's transport shape: the publication barrier with the send
// observer inside it, and the gate on the client.
// The build path is behind lib/declared-features.js; each test sets it explicitly and restores it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { openManagedBindings } = require('../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createAttemptSendObserver } = require('../lib/managed-feature-contract.js');
const { createDeferredWorkflowGate } = require('../lib/deferred-workflow-gate.js');
const { DECLARED_FEATURES } = require('../lib/declared-features.js');
const { RETRY } = require('../lib/retry-policy.js');
const { createWorkflowWire, ORIGIN } = require('./helpers/workflow-wire.js');
const { sdkOver } = require('./helpers/managed-wire.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const SOLUTION = 'BP';
const APP = 'new_bpapp';
const FLOW = {
  name: 'Ticket process', entity: 'new_ticket', reconcile: 'declared',
  stages: [
    { key: 'triage', name: 'Triage', steps: [{ key: 'owner', name: 'Owner', field: 'new_owner', required: true }] },
    { key: 'resolve', name: 'Resolve', steps: [{ key: 'notes', name: 'Notes', field: 'new_notes' }] },
  ],
};
// The same flow as the build has always made it: no reconcile, no keys.
const legacy = (f) => ({
  name: f.name, entity: f.entity,
  stages: f.stages.map(({ key, steps, ...st }) => ({ ...st, steps: steps.map(({ key: k, ...step }) => step) })),
});
const KEY = `new_ticket|${FLOW.name}`;
const GROUP = `new_ticket/${FLOW.name}`;
const APPROVAL = `bpf:${GROUP}`;

function specWith(flows) {
  return {
    solution: { uniqueName: SOLUTION, displayName: 'BP', publisherPrefix: 'new' },
    app: { name: 'BP App', uniqueName: APP, description: '' },
    minimumPluginVersion: '2.21.0',
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: [
        { schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['New', 'Closed'] },
        { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
        { schemaName: 'new_owner', displayName: 'Owner', type: 'Text' },
      ],
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
    businessProcessFlows: flows,
  };
}

async function withBpf(on, fn) {
  const was = DECLARED_FEATURES.bpf;
  DECLARED_FEATURES.bpf = on;
  try { return await fn(); } finally { DECLARED_FEATURES.bpf = was; }
}

const storeOf = (dir) => openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOLUTION });

// One invocation, as build-model-app.js assembles it: a fresh barrier, send observer, workflow effect gate and SDK over the same
// wire and the same build workspace `dir`, which holds the binding store. `gate: false` leaves the client without a gate.
async function build(wire, dir, spec, { gate = true, ...opts } = {}) {
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const workflowEffectGate = gate ? createDeferredWorkflowGate() : null;
  const binds = [];
  if (workflowEffectGate) {
    const bind = workflowEffectGate.bind;
    workflowEffectGate.bind = (store) => { binds.push(store); return bind(store); };
  }
  const { sdk } = await sdkOver(wire, { barrier, observer: sendObserver, workflowEffectGate });
  const mark = wire.log.length;
  const warnings = [];
  let out;
  let err;
  try {
    out = await runSdkBuild(spec, {
      sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: ORIGIN, warn: (w) => warnings.push(String(w)),
      phases: ['business-process-flows'], publicationBarrier: barrier, sendObserver, ...(workflowEffectGate ? { workflowEffectGate } : {}), ...opts,
    });
  } catch (e) {
    err = e;
  }
  const writes = wire.log.slice(mark).filter((c) => c.method !== 'GET');
  return { out, err, warnings, writes, lines: wire.lines(mark), writeLines: wire.lines(mark).filter((l) => !l.startsWith('GET')), binds: binds.length };
}

// Every word a stop says: its message, its causes and the findings it carries.
function chainText(err) {
  const out = [];
  for (let e = err, n = 0; e && n < 10; e = e.cause, n += 1) {
    out.push(String(e.message || ''));
    for (const f of Array.isArray(e.findings) ? e.findings : []) out.push(`${f.code}: ${f.message}`);
  }
  return out.join('\n');
}
const ownHalt = (err) => { for (let e = err; e; e = e.cause) if (Array.isArray(e.findings)) return e; return null; };
const ifMatchOf = (e) => e.headers['If-Match'] || e.headers['if-match'] || null;

// --- the spec gate -----------------------------------------------------------------------------------------------------------

test('with the build path off, a declared process flow is refused with the words it always had', async () => {
  await withBpf(false, () => {
    const v = validateAppSpec(specWith([FLOW]), { profile: 'deploy' });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.startsWith("business process flow 'Ticket process': unsupported key 'reconcile' (allowed: name, entity, description, status, order, stages, securityRoles).")), JSON.stringify(v.errors));
    assert.ok(v.errors.some((e) => e.startsWith("business process flow 'Ticket process': stage 'Triage' has unsupported key 'key' (allowed: name, entity, steps).")), JSON.stringify(v.errors));
  });
});

test('with the build path on, a declared flow validates with its stage and step keys, and what the helper cannot settle is refused', async () => {
  await withBpf(true, () => {
    assert.deepEqual(validateAppSpec(specWith([FLOW]), { profile: 'deploy' }).errors, []);
    // Only the flow's own settings: allowed for a declared flow (the helper refuses to create or adopt one without stages).
    assert.deepEqual(validateAppSpec(specWith([{ name: FLOW.name, entity: FLOW.entity, reconcile: 'declared', description: 'Triage first' }]), { profile: 'deploy' }).errors, []);
    const refused = (flows) => {
      const v = validateAppSpec(specWith(flows), { profile: 'deploy' });
      assert.equal(v.ok, false, JSON.stringify(flows));
      return v.errors.join('\n');
    };
    assert.match(refused([{ ...FLOW, reconcile: 'additive' }]), /business process flow 'Ticket process': reconcile must be "declared" \(or left out\)/);
    assert.match(refused([{ ...FLOW, stages: [{ ...FLOW.stages[0], key: undefined }, FLOW.stages[1]] }]), /business process flow 'Ticket process': stages\[0\]: a declared stage needs a key/);
    assert.match(refused([{ ...FLOW, stages: [FLOW.stages[0], { ...FLOW.stages[1], key: 'triage' }] }]), /the stage key "triage" is used twice/);
    assert.match(refused([{ ...FLOW, stages: [{ ...FLOW.stages[0], steps: [FLOW.stages[0].steps[0], { ...FLOW.stages[1].steps[0], key: 'owner' }] }] }]), /the step key "owner" is used twice in its stage/);
    assert.match(refused([{ ...FLOW, stages: [] }]), /stages, when given, must list at least one stage/);
    // Keys belong to a declared flow only: an undeclared flow refuses them with the words it always had.
    assert.match(refused([{ ...legacy(FLOW), stages: FLOW.stages }]), /stage 'Triage' has unsupported key 'key' \(allowed: name, entity, steps\)/);
    // The column check still applies to a declared flow's steps.
    assert.match(refused([{ ...FLOW, stages: [{ ...FLOW.stages[0], steps: [{ key: 'x', name: 'X', field: 'new_ghost' }] }] }]), /step 'X' references 'new_ghost', which is not a column on new_ticket/);
    // One `bpf:<table>/<name>` approval names one flow: two flows with one name are refused, declared or not.
    assert.match(refused([FLOW, { ...legacy(FLOW), name: 'ticket PROCESS' }]), /collides with 'Ticket process'/);
    assert.deepEqual(validateAppSpec(specWith([legacy(FLOW)]), { profile: 'deploy' }).errors, [], 'an undeclared flow is what it always was');
  });
});

// --- the build ---------------------------------------------------------------------------------------------------------------

test('with the build path off or on, an undeclared flow sends exactly the requests it always sent', async () => {
  const run = (on) => withBpf(on, async () => {
    const wire = createWorkflowWire();
    const b = await build(wire, makeTempDir('declared-bpf-'), specWith([legacy(FLOW)]));
    assert.equal(b.err, undefined, chainText(b.err));
    assert.equal(b.binds, 0, 'no declared flow and no stored effect: the gate stays unbound');
    return b.lines;
  });
  const off = await run(false);
  assert.ok(off.includes('POST workflows'), 'control: the legacy flow is created');
  assert.deepEqual(await run(true), off);
});

test('a declared flow is created Draft under its catalog ids, proved, then activated by one conditional write; the rebuild sends nothing', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    const first = await build(wire, dir, specWith([FLOW]));
    assert.equal(first.err, undefined, chainText(first.err));
    const id = first.out.created.businessProcessFlows[KEY];
    assert.match(String(id), /^[0-9a-f-]{36}$/);
    const workflowWrites = first.writes.filter((c) => /^workflows/i.test(c.path));
    assert.deepEqual(workflowWrites.map((c) => `${c.method} ${c.path.replace(id, '<id>')}`), ['POST workflows', 'PATCH workflows(<id>)']);
    const [create, activate] = workflowWrites;
    assert.equal(create.body.workflowid, id, 'the catalog id is the row id');
    assert.equal(create.body.statecode === undefined || create.body.statecode === 0, true, 'created Draft');
    assert.deepEqual(activate.body, { statecode: 1, statuscode: 2 });
    assert.equal(ifMatchOf(activate), `W/"${wire.row(id).version - 1}"`, 'against the version of the read that proved the body');
    assert.deepEqual(wire.deleted, []);
    assert.equal(wire.row(id).statecode, 1);
    assert.ok(first.writes.some((c) => /AddSolutionComponent/i.test(c.path) && JSON.stringify(c.body).includes(id)), 'the created flow joins the solution');
    assert.equal(first.binds, 1, 'the build bound the gate of its client to its store');
    // The backing table the role grants use is the name the platform stored for the flow.
    assert.equal(first.out.created.bpfBackingTables[KEY], String(wire.row(id).uniquename).toLowerCase());
    const { committed, pending } = storeOf(dir).readGroup('bpf', GROUP);
    assert.equal(pending, null);
    assert.equal(committed.records.find((r) => r.id === id).origin, 'created');

    const again = await build(wire, dir, specWith([FLOW]));
    assert.equal(again.err, undefined, chainText(again.err));
    assert.deepEqual(again.writes.filter((c) => /^workflows/i.test(c.path)), [], 'the same declaration again is a no-op');
    assert.equal(again.out.created.businessProcessFlows[KEY], id);
    assert.equal(again.out.created.bpfBackingTables[KEY], first.out.created.bpfBackingTables[KEY]);
  });
});

test('a declared flow found unbound halts through the build halt with the typed adoption it needs; the adopted flow keeps its stored backing table', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const seeded = await build(wire, makeTempDir('declared-bpf-'), specWith([legacy(FLOW)]));
    assert.equal(seeded.err, undefined, chainText(seeded.err));
    const id = seeded.out.created.businessProcessFlows[KEY];
    // A flow authored elsewhere keeps a unique name unrelated to its display name: that name, not a derivation, is its table.
    wire.row(id).uniquename = 'new_makerauthoredflow';
    const dir = makeTempDir('declared-bpf-');
    const refused = await build(wire, dir, specWith([FLOW]));
    assert.ok(refused.err, 'the run stops');
    assert.deepEqual(refused.writes, [], 'nothing is written for an unbound flow');
    const halt = ownHalt(refused.err);
    assert.ok(halt, chainText(refused.err));
    assert.equal(halt.name, 'BuildHalt');
    assert.equal(halt.code, 'create-ownership-required');
    assert.equal(halt.retry, RETRY.NEVER);
    assert.deepEqual(halt.findings.map((f) => f.code), ['create-ownership-required']);
    assert.match(halt.message, /\(approve with --authorize "adopt:bpf:new_ticket\/Ticket process"\)/);

    const adopted = await build(wire, dir, specWith([FLOW]), { authorizedAdoption: new Set([APPROVAL]) });
    assert.equal(adopted.err, undefined, chainText(adopted.err));
    assert.deepEqual(adopted.writes.filter((c) => /^workflows/i.test(c.path)), [], 'a read-only adoption');
    assert.equal(adopted.out.created.businessProcessFlows[KEY], id);
    assert.equal(adopted.out.created.bpfBackingTables[KEY], 'new_makerauthoredflow');
    assert.equal(storeOf(dir).readGroup('bpf', GROUP).committed.records.find((r) => r.id === id).origin, 'adopted');
  });
});

test('a declared flow whose client has no workflow effect gate bound to the store stops before any request for it', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const b = await build(wire, makeTempDir('declared-bpf-'), specWith([FLOW]), { gate: false });
    const halt = ownHalt(b.err);
    assert.ok(halt, chainText(b.err));
    assert.equal(halt.code, 'workflow-state-path-unavailable');
    assert.equal(halt.retry, RETRY.NEVER);
    assert.deepEqual(b.lines.filter((l) => /workflows/.test(l) && !/EntityDefinitions/.test(l)), [], 'no request for the flow, read or write');
  });
});

test('a stored flow change still waiting to be proved after its declaration left the spec holds the run, and its row is not written', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    wire.script((e) => e.method === 'PATCH', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    const lost = await build(wire, dir, specWith([FLOW]));
    assert.ok(lost.err, 'the lost activation stops the run');
    const id = [...wire.rows.keys()][0];
    assert.equal(wire.row(id).statecode, 0, 'Draft');

    // The entry is now undeclared: the legacy path would activate the Draft row it finds by name.
    const undeclared = await build(wire, dir, specWith([legacy(FLOW)]));
    assert.ok(undeclared.err, 'the run ends incomplete');
    assert.equal(undeclared.err.code, 'managed-not-settled');
    assert.match(chainText(undeclared.err), /declared business process flow "new_ticket\/Ticket process": an earlier run's change of this flow is still waiting to be proved, and the spec no longer declares it/);
    assert.deepEqual(undeclared.writes, [], 'nothing is written to the held row');
    assert.equal(undeclared.binds, 1, 'the store holds a workflow effect, so the gate is bound with no declared flow');
    assert.equal(wire.row(id).statecode, 0);

    // Removed altogether: the same hold, and nothing sent.
    const removed = await build(wire, dir, specWith([]));
    assert.equal(removed.err && removed.err.code, 'managed-not-settled');
    assert.deepEqual(removed.writes, []);
  });
});

test('a settled flow whose stored backing table the settlement does not answer has it read by id, and one that cannot be read stops the run unmapped', async () => {
  await withBpf(true, async () => {
    const settlement = require('../lib/bpf-settlement.js');
    const real = settlement.settleDeclaredBpf;
    settlement.settleDeclaredBpf = async (args) => ({ ...(await real(args)), uniqueName: null });
    try {
      const wire = createWorkflowWire();
      const b = await build(wire, makeTempDir('declared-bpf-'), specWith([FLOW]));
      assert.equal(b.err, undefined, chainText(b.err));
      const id = b.out.created.businessProcessFlows[KEY];
      assert.equal(b.out.created.bpfBackingTables[KEY], String(wire.row(id).uniquename).toLowerCase(), 'read back by the flow id');

      const unread = createWorkflowWire();
      const dir = makeTempDir('declared-bpf-');
      const first = await build(unread, dir, specWith([FLOW]));
      assert.equal(first.err, undefined, chainText(first.err));
      delete unread.row(first.out.created.businessProcessFlows[KEY]).uniquename;
      const again = await build(unread, dir, specWith([FLOW]));
      const halt = ownHalt(again.err);
      assert.ok(halt, chainText(again.err));
      assert.equal(halt.code, 'bpf-backing-unproved');
      assert.equal(halt.retry, RETRY.NEVER);
      assert.deepEqual(again.writes.filter((c) => /^workflows/i.test(c.path)), []);
    } finally {
      settlement.settleDeclaredBpf = real;
    }
  });
});