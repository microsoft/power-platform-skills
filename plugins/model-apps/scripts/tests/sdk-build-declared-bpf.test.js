'use strict';
// Declared business process flows (businessProcessFlows[].reconcile: "declared") wired into the build: the spec gate, the
// business-process-flows phase's dispatch to the managed flow helper (lib/bpf-settlement.js settleDeclaredBpf), the halt it is
// given, the workflow effect gate the build binds to its store (lib/deferred-workflow-gate.js), the backing table it hands to the
// role grants, and a stored attempt whose declaration left the spec. Everything runs through the real engine
// (lib/sdk-build.js runSdkBuild), the real vendored SDK and the plugin's real client over an in-memory workflow table
// (helpers/workflow-wire.js) that enforces If-Match, with the CLI's transport shape: the publication barrier with the send
// observer inside it, and the gate on the client.
// The round trip is here too: the typed approval (build-model-app.js authorizationKeys), verify's check of a bound flow
// (lib/verify-spec.js over verify-model-app.js readerFor) and the explicit managed download's restore (download-model-app.js main), each
// over the same wire, and the whole CLI assembly (build-model-app.js buildModelApp) from the printed approval to the download.
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
const { sdkOver, clientOver } = require('./helpers/managed-wire.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const fs = require('node:fs');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { buildModelApp, authorizationKeys } = require('../build-model-app.js');
const { readerFor, isolatedReaderFor } = require('../verify-model-app.js');
const { main: downloadMain } = require('../download-model-app.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { readVerifyManifest } = require('../lib/declared-form-io.js');
const { storeFileName } = require('../lib/managed-bindings.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');

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
// `configureSdk(sdk, gate)`, when given, adjusts that invocation's SDK before the build runs (e.g. an operation it lacks).
async function build(wire, dir, spec, { gate = true, configureSdk, ...opts } = {}) {
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const workflowEffectGate = gate ? createDeferredWorkflowGate() : null;
  const binds = [];
  if (workflowEffectGate) {
    const bind = workflowEffectGate.bind;
    workflowEffectGate.bind = (store) => { binds.push(store); return bind(store); };
  }
  const { sdk } = await sdkOver(wire, { barrier, observer: sendObserver, workflowEffectGate });
  if (configureSdk) await configureSdk(sdk, workflowEffectGate);
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
test('a bound flow is never edited by default, and a declaration that omits or reorders its stages is refused before any request for it', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    const first = await build(wire, dir, specWith([FLOW]));
    assert.equal(first.err, undefined, chainText(first.err));
    const id = first.out.created.businessProcessFlows[KEY];
    const before = JSON.stringify(wire.row(id));
    const renamed = await build(wire, dir, specWith([{ ...FLOW, stages: [FLOW.stages[0], { ...FLOW.stages[1], name: 'Close' }] }]));
    assert.ok(renamed.err, 'a rename under the same key is an edit, which is off by default');
    assert.match(chainText(renamed.err), /workflow-edit-refused|the declaration renames the stage "resolve"/);
    assert.match(chainText(renamed.err), /renames the stage "resolve"/);
    assert.deepEqual(renamed.writes, []);
    const reordered = await build(wire, dir, specWith([{ ...FLOW, stages: [FLOW.stages[1], FLOW.stages[0]] }]));
    assert.match(chainText(reordered.err), /puts its stages in another order; stages and steps are never removed or moved/);
    assert.deepEqual(reordered.writes, []);
    const omitted = await build(wire, dir, specWith([{ ...FLOW, stages: [FLOW.stages[0]] }]));
    assert.match(chainText(omitted.err), /omits the stage "resolve"/);
    assert.deepEqual(omitted.writes, []);
    assert.equal(JSON.stringify(wire.row(id)), before, 'the row is untouched');
    assert.equal(storeOf(dir).readGroup('bpf', GROUP).committed.root.id, id, 'still bound to the same id');
  });
});

test('a bound flow kept Draft with its status left out is a no-op for the build and passes verify; a stated status is held to as written', async () => {
  await withBpf(true, async () => {
    const legacyChecks = (r) => r.checks.filter((c) => c.kind === 'business-process-flow').map((c) => [c.present, c.detail]);
    const DRAFT = 'deployed but DRAFT — the process does not appear on the form';
    const ACTIVE = 'deployed ACTIVE but the spec asks for Draft — the process is running';
    // The flow's own checks only (the stub reader answers no sitemap, so the app shell's checks never pass here).
    const flowMissing = (r) => r.missing.filter((m) => m.kind === 'business-process-flow' || m.kind === 'managed-bpf').map((m) => m.kind);
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    const first = await build(wire, dir, specWith([{ ...FLOW, status: 'Draft' }]));
    assert.equal(first.err, undefined, chainText(first.err));
    const id = storeOf(dir).readGroup('bpf', GROUP).committed.root.id;
    assert.equal(wire.row(id).statecode, 0, 'created and kept Draft');
    assert.equal(manifestOf(dir).groups.find((g) => g.family === 'bpf').declaration.applied.status, 'Draft');

    // The status left out: the build changes nothing and verify expects the Draft it keeps, both checks passing.
    const omitted = await build(wire, dir, specWith([FLOW]));
    assert.equal(omitted.err, undefined, chainText(omitted.err));
    assert.deepEqual(omitted.writes.filter((c) => /^workflows/i.test(c.path)), [], 'no workflow write');
    assert.equal(wire.row(id).statecode, 0, 'never activated');
    const { read } = await verifyReader(wire);
    const verify = (spec) => verifySpec(spec, read, { managedManifest: manifestOf(dir) });
    const kept = await verify(specWith([FLOW]));
    assert.deepEqual(legacyChecks(kept), [[true, '']]);
    assert.deepEqual(bpfChecks(kept).map((c) => c.present), [true]);
    assert.deepEqual(flowMissing(kept), []);

    // Controls: Draft stated passes; Active stated is an edit the build refuses with no write, and verify fails it.
    assert.deepEqual(flowMissing(await verify(specWith([{ ...FLOW, status: 'Draft' }]))), []);
    const activate = await build(wire, dir, specWith([{ ...FLOW, status: 'Active' }]));
    assert.match(chainText(activate.err), /workflow-edit-refused/);
    assert.deepEqual(activate.writes, []);
    const wantActive = await verify(specWith([{ ...FLOW, status: 'Active' }]));
    assert.deepEqual(legacyChecks(wantActive), [[false, DRAFT]]);
    assert.deepEqual(flowMissing(wantActive), ['business-process-flow', 'managed-bpf']);
    // The flow activated outside the spec: the omitted status still expects the Draft its last build proved.
    Object.assign(wire.row(id), { statecode: 1, statuscode: 2 });
    const drifted = await verify(specWith([FLOW]));
    assert.deepEqual(legacyChecks(drifted), [[false, ACTIVE]]);
    assert.ok(flowMissing(drifted).includes('business-process-flow'));
    Object.assign(wire.row(id), { statecode: 0, statuscode: 1 });

    // Re-adoption never unlocks a structural change: stages reordered under the typed approval are still refused, with no request.
    const reordered = await build(wire, dir, specWith([{ ...FLOW, stages: [FLOW.stages[1], FLOW.stages[0]] }]), { authorizedAdoption: new Set([APPROVAL]) });
    assert.match(chainText(reordered.err), /bpf-structure-refused|puts its stages in another order/);
    assert.deepEqual(reordered.lines, []);

    // A new flow with its status left out is created Active, and verify expects Active.
    const fresh = createWorkflowWire();
    const fdir = makeTempDir('declared-bpf-');
    assert.equal((await build(fresh, fdir, specWith([FLOW]))).err, undefined);
    const fid = storeOf(fdir).readGroup('bpf', GROUP).committed.root.id;
    assert.equal(fresh.row(fid).statecode, 1);
    const fv = await verifySpec(specWith([FLOW]), (await verifyReader(fresh)).read, { managedManifest: manifestOf(fdir) });
    assert.deepEqual(legacyChecks(fv), [[true, '']]);
    assert.deepEqual(flowMissing(fv), []);
  });
});

// --- the approval ------------------------------------------------------------------------------------------------------------

test('--authorize adopt:bpf:<table>/<name> is read in any case, typed or not, as the helper\'s approval; an overwrite, an undeclared flow or an ambiguous key is refused', async () => {
  await withBpf(true, () => {
    const spec = specWith([FLOW]);
    const keys = (...list) => authorizationKeys(list.flatMap((k) => ['--authorize', k]), spec);
    for (const key of ['adopt:bpf:NEW_TICKET/ticket PROCESS', `adopt:${FLOW.entity}/${FLOW.name}`, 'adopt:New_Ticket/TICKET process']) {
      const r = keys(key);
      assert.equal(r.error, null, key);
      assert.deepEqual([...r.adopt], [APPROVAL], key);
      assert.equal(r.overwrite.size, 0, key);
    }
    for (const [key, words] of [
      [`overwrite:bpf:${FLOW.entity}/${FLOW.name}`, /is not an approval a declared business process flow takes: it is adopted whole, never overwritten by an approval \(use adopt:bpf:new_ticket\/Ticket process/],
      [`overwrite:${FLOW.entity}/${FLOW.name}`, /is not an approval a declared business process flow takes/],
      ['adopt:bpf:new_ticket/Other process', /approves an artifact the spec does not declare \(it would need a business process flow with reconcile: "declared" named new_ticket\/Other process, as <table>\/<name>\)/],
      ['adopt:new_ticket/Other process', /it would need a view or chart, or a business process flow, with reconcile: "declared" keyed new_ticket\/Other process/],
    ]) {
      const r = keys(key);
      assert.match(String(r.error), words, key);
      assert.equal(r.adopt.size + r.overwrite.size, 0, key);
    }
    // A declared business rule of the same table and name: the untyped key could mean either; each typed key means one.
    const both = { ...specWith([FLOW]), businessRules: [{ entity: 'new_ticket', name: FLOW.name, reconcile: 'declared', conditions: [{ key: 'c', field: 'new_status', operator: 'Equals', value: '100000001', dataType: 'Picklist' }], actions: [{ key: 'a', type: 'SetVisibility', field: 'new_notes', visible: false }] }] };
    const ambiguous = authorizationKeys(['--authorize', `adopt:${FLOW.entity}/${FLOW.name}`], both);
    assert.match(String(ambiguous.error), /could approve more than one declared artifact; name the one you mean with its typed key: (adopt:rule:new_ticket\/Ticket process or adopt:bpf:new_ticket\/Ticket process|adopt:bpf:new_ticket\/Ticket process or adopt:rule:new_ticket\/Ticket process)/);
    assert.equal(ambiguous.adopt.size, 0);
    assert.deepEqual([...authorizationKeys(['--authorize', `adopt:bpf:${FLOW.entity}/${FLOW.name}`], both).adopt], [APPROVAL]);
    // An undeclared flow of the same name takes no approval.
    assert.match(String(authorizationKeys(['--authorize', `adopt:bpf:${FLOW.entity}/${FLOW.name}`], specWith([legacy(FLOW)])).error), /does not declare/);
  });
  await withBpf(false, () => {
    const off = authorizationKeys(['--authorize', `adopt:bpf:${FLOW.entity}/${FLOW.name}`], specWith([FLOW]));
    assert.match(String(off.error), /does not declare/);
    assert.equal(off.adopt.size, 0);
  });
});

// --- verify ------------------------------------------------------------------------------------------------------------------

// verify's reader as the CLI builds it (verify-model-app.js readerFor): a declared flow is read by its bound id on a throwaway SDK
// (isolatedReaderFor) over the same wire, never the build's.
async function verifyReader(wire) {
  const { sdk } = await sdkOver(wire);
  const cli = readerFor(sdk, APP, { isolatedReader: isolatedReaderFor(ORIGIN, { httpClient: clientOver(wire) }) });
  const bpfReads = [];
  const idReads = [];
  return {
    bpfReads,
    idReads,
    read: {
      findTable: async () => ({ logicalName: 'new_ticket' }),
      findColumns: async () => ['new_subject', 'new_status', 'new_notes', 'new_owner'],
      // The bound-id reads verify makes: of a group it does not hold as declared, and the presence and state of a declared flow's
      // own row (workflow by workflowid), answered from the wire. A read by name answers nothing.
      queryRecords: async (table, o) => {
        const id = (/workflowid eq (\S+)/.exec((o && o.filter) || '') || [])[1];
        if (table === 'workflow' && id) { idReads.push(id); return wire.row(id) ? [{ workflowid: id, statecode: wire.row(id).statecode }] : []; }
        return [];
      },
      sitemapXml: async () => '',
      declaredBpf: async (id) => { bpfReads.push(id); return cli.declaredBpf(id); },
    },
  };
}
const bpfChecks = (r) => r.checks.filter((c) => c.kind === 'managed-bpf');
const manifestOf = (dir) => readVerifyManifest({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOLUTION });

test('verify holds a bound declared flow to its declaration and last proof by a fresh read of its id', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    assert.equal((await build(wire, dir, specWith([FLOW]))).err, undefined);
    const id = storeOf(dir).readGroup('bpf', GROUP).committed.root.id;
    const { read, bpfReads } = await verifyReader(wire);
    const verify = (spec) => verifySpec(spec, read, { managedManifest: manifestOf(dir) });
    const pass = await verify(specWith([FLOW]));
    assert.deepEqual(bpfChecks(pass).map((c) => [c.name, c.present, c.detail]), [[`${GROUP} (${id})`, true, '']]);
    assert.deepEqual(bpfReads, [id], 'read by the bound id');
    assert.deepEqual((pass.unverified || []).filter((u) => u.startsWith('managed:')), []);
    // A declaration the flow does not hold yet fails it, with the way out.
    const edited = await verify(specWith([{ ...FLOW, stages: [FLOW.stages[0], { ...FLOW.stages[1], steps: [{ ...FLOW.stages[1].steps[0], required: true }] }] }]));
    assert.equal(bpfChecks(edited)[0].present, false);
    assert.match(bpfChecks(edited)[0].detail, /^bpf-declaration-changed: the spec's declaration changes the step "resolve\/notes", which is not on the flow yet/);
    assert.ok(edited.missing.some((m) => m.kind === 'managed-bpf'), 'a failing bound flow fails verify');
    const added = await verify(specWith([{ ...FLOW, stages: [...FLOW.stages, { key: 'close', name: 'Close', steps: [{ key: 'status', name: 'Status', field: 'new_status' }] }] }]));
    assert.match(bpfChecks(added)[0].detail, /adds the stage "close"/);
    // What a build refuses outright is named as such: a stage left out, or the stages reordered.
    assert.match(bpfChecks(await verify(specWith([{ ...FLOW, stages: [FLOW.stages[0]] }])))[0].detail, /^bpf-declaration-changed: the spec's declaration omits the stage "resolve"; stages and steps are never removed or moved/);
    assert.match(bpfChecks(await verify(specWith([{ ...FLOW, stages: [FLOW.stages[1], FLOW.stages[0]] }])))[0].detail, /puts its stages in another order/);
    // An omitted description, order or status keeps its live value, as it does for the build; a stated one that differs is a change.
    assert.equal(bpfChecks(await verify(specWith([{ ...FLOW, status: 'Active', order: 100 }])))[0].present, true);
    assert.match(bpfChecks(await verify(specWith([{ ...FLOW, status: 'Draft' }])))[0].detail, /sets the flow Draft/);
    // The flow deactivated outside the spec fails it under the unchanged declaration; so does a renamed flow row.
    Object.assign(wire.row(id), { statecode: 0, statuscode: 1 });
    assert.match(bpfChecks(await verify(specWith([FLOW])))[0].detail, /^bpf-changed: the flow \(now Draft\) is not what its last build proved/);
    Object.assign(wire.row(id), { statecode: 1, statuscode: 2 });
    assert.equal(bpfChecks(await verify(specWith([FLOW])))[0].present, true, 'control: Active again');
    const name = wire.row(id).name;
    wire.row(id).name = 'Ticket process (copy)';
    assert.match(bpfChecks(await verify(specWith([FLOW])))[0].detail, /^bpf-changed: /);
    wire.row(id).name = name;
    // And a flow no read can find is reported failed, never passed.
    wire.rows.delete(id);
    assert.deepEqual(bpfChecks(await verify(specWith([FLOW]))).map((c) => c.present), [false]);
  });
});

test('verify lists a reader that cannot read a flow as unverified, and a flow the spec no longer declares, or any with the build path off, is held to its bound id', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    assert.equal((await build(wire, dir, specWith([FLOW]))).err, undefined);
    const id = storeOf(dir).readGroup('bpf', GROUP).committed.root.id;
    const { read, bpfReads, idReads } = await verifyReader(wire);
    const { declaredBpf, ...plain } = read;
    void declaredBpf;
    const blind = await verifySpec(specWith([FLOW]), plain, { managedManifest: manifestOf(dir) });
    assert.deepEqual(bpfChecks(blind), []);
    assert.ok(blind.unverified.includes(`managed:bpf ${GROUP} (this reader cannot read a business process flow by id)`), JSON.stringify(blind.unverified));
    // The flow's presence and state are still read by its bound id, never by its name.
    assert.deepEqual(blind.checks.filter((c) => c.kind === 'business-process-flow').map((c) => c.present), [true]);
    assert.deepEqual(idReads, [id]);
    // A flow is keyed by its table and name, so a renamed flow is another flow: the bound one is held to its id.
    const renamed = await verifySpec(specWith([{ ...FLOW, name: 'Ticket journey' }]), read, { managedManifest: manifestOf(dir) });
    assert.deepEqual(bpfChecks(renamed).map((c) => [c.name, c.present, c.detail]), [[`${GROUP} (${id})`, true, '']]);
    assert.deepEqual(bpfReads, [], 'not read as a declared flow');
    assert.deepEqual(idReads, [id, id]);
    await withBpf(false, async () => {
      const off = await verifySpec(specWith([legacy(FLOW)]), read, { managedManifest: manifestOf(dir) });
      assert.deepEqual(bpfChecks(off).map((c) => [c.name, c.present]), [[`${GROUP} (${id})`, true]]);
      assert.deepEqual(bpfReads, []);
      assert.deepEqual(idReads, [id, id, id], 'held to its bound workflow id');
    });
  });
});

// --- the explicit managed download -------------------------------------------------------------------------------------------

// download-model-app.js main with its side effects replaced: the download's SDK is a real one over the wire, and runDownload answers
// the spec a download of this app hydrates, which holds no process flow (a plain download reconstructs none), or `plain` if given.
async function download(wire, out, argv, { plain, ...extra } = {}) {
  const { sdk } = await sdkOver(wire);
  const dl = Object.create(sdk);
  dl.queryRecords = async (table, o) => (table === 'appmodule' ? [{ uniquename: APP }] : sdk.queryRecords(table, o));
  const downloaded = specWith([]);
  delete downloaded.businessProcessFlows;
  if (plain) downloaded.businessProcessFlows = plain;
  const emitted = [];
  const said = [];
  const mark = wire.log.length;
  await downloadMain({
    argv: ['--env', ORIGIN, '--app', '00000000-0000-0000-0000-00000000a333', '--out', out, ...argv],
    stderr: { write: (text) => { said.push(String(text)); return true; } },
    exit: () => {},
    emitResult: (ok, payload) => emitted.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeDownloadSdk: async () => ({ sdk: dl, cleanup() {} }),
    makeGenpageSdk: () => ({}),
    runDownload: async () => ({ ok: true, spec: downloaded, pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [] }),
    ...extra,
  });
  const specFile = path.join(out, 'app-spec.json');
  return { emitted, said: said.join(''), calls: wire.log.slice(mark), written: fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : null };
}
const storeFileOf = (dir) => path.join(dir, storeFileName(environmentFingerprint(ORIGIN), APP, SOLUTION));

test('the explicit managed download restores a proved declared flow, keys included, into businessProcessFlows, and names any it cannot restore', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    const described = { ...FLOW, description: 'Triage first', order: 3 };
    assert.equal((await build(wire, dir, specWith([described]))).err, undefined);
    const id = storeOf(dir).readGroup('bpf', GROUP).committed.root.id;
    const flags = ['--include-managed', '--managed-manifest', storeFileOf(dir)];
    const restored = await download(wire, makeTempDir('declared-bpf-'), flags);
    assert.equal(restored.emitted.length, 1);
    assert.equal(restored.emitted[0].ok, true, JSON.stringify(restored.emitted) + restored.said);
    assert.deepEqual(restored.emitted[0].payload.managedBpfs, { restored: [GROUP], stale: [] });
    assert.deepEqual(restored.written.businessProcessFlows, [described], 'the declaration it was built from, whole');
    // An entry for the same table and name is replaced, never doubled.
    const other = { ...legacy(FLOW), name: 'Escalation' };
    const replaced = await download(wire, makeTempDir('declared-bpf-'), flags, { plain: [legacy(FLOW), other] });
    assert.deepEqual(replaced.written.businessProcessFlows, [described, other]);
    // A flow changed since its last proof is named and left out; the rest of the download is written.
    Object.assign(wire.row(id), { statecode: 0, statuscode: 1 });
    const changed = await download(wire, makeTempDir('declared-bpf-'), flags);
    assert.equal(changed.emitted[0].ok, true);
    assert.deepEqual(changed.emitted[0].payload.managedBpfs.restored, []);
    assert.match(changed.emitted[0].payload.managedBpfs.stale[0].reason, new RegExp(`process flow ${id} is not what its last build proved \\(bpf-changed\\)`));
    assert.match(changed.said, /WARNING: managed business process flow new_ticket\/Ticket process was not restored: /);
    assert.equal(changed.written.businessProcessFlows, undefined);
  });
});

test('the explicit managed download names a flow whose last attempt is not settled, and without the flags reads no flow by id', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    wire.script((e) => e.method === 'PATCH', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    assert.ok((await build(wire, dir, specWith([FLOW]))).err);
    const pending = await download(wire, makeTempDir('declared-bpf-'), ['--include-managed', '--managed-manifest', storeFileOf(dir)]);
    assert.equal(pending.emitted[0].ok, true, JSON.stringify(pending.emitted));
    assert.deepEqual(pending.emitted[0].payload.managedBpfs.restored, []);
    assert.match(pending.emitted[0].payload.managedBpfs.stale[0].reason, /its last attempt is not settled/);
    assert.deepEqual(pending.calls.filter((c) => /^workflows\(/i.test(c.path)), [], 'an unsettled flow is not read');
    const plain = await download(wire, makeTempDir('declared-bpf-'), []);
    assert.equal(plain.emitted[0].ok, true, JSON.stringify(plain.emitted) + plain.said);
    assert.equal('managedBpfs' in plain.emitted[0].payload, false);
    assert.deepEqual(plain.calls.filter((c) => /^workflows\(/i.test(c.path)), [], 'no flow is read');
  });
});

// --- the CLI -----------------------------------------------------------------------------------------------------------------

test('the enabled feature through the CLI: the printed typed approval binds the flow, verify passes then fails a changed declaration, and the managed download restores it', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    assert.equal((await build(wire, makeTempDir('declared-bpf-'), specWith([legacy(FLOW)]))).err, undefined, 'the maker\'s flow');
    const appDir = makeTempDir('declared-bpf-');
    const dir = path.join(appDir, '.maker-workspace');
    fs.mkdirSync(dir);
    const { read } = await verifyReader(wire);
    const cli = async (spec, extra = {}) => {
      const barrier = createPublicationBarrier();
      const sendObserver = createAttemptSendObserver();
      const workflowEffectGate = createDeferredWorkflowGate();
      const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: clientOver(wire, { barrier, observer: sendObserver, workflowEffectGate }) });
      await sdk.initWorkspace();
      let verified = null;
      let err;
      const mark = wire.log.length;
      try {
        await buildModelApp(spec, { apply: true, env: ORIGIN, workspaceDir: dir, appDir, retryDelayMs: 0, ...extra }, {
          sdk, provisionSdk: sdk, runBuild: (s, o) => runSdkBuild(s, { ...o, phases: ['business-process-flows'] }), publicationBarrier: barrier, sendObserver, workflowEffectGate, warn: () => {}, log: () => {},
          verify: async (s, o) => { verified = await verifySpec(s, read, o); return verified; },
        });
      } catch (e) { err = e; }
      return { err, verified, workflowWrites: wire.log.slice(mark).filter((c) => c.method !== 'GET' && /^workflows/i.test(c.path)) };
    };
    const halted = await cli(specWith([FLOW]));
    assert.ok(halted.err, 'the unbound flow is not taken over');
    assert.deepEqual(halted.workflowWrites, []);
    const printed = /--authorize "(adopt:bpf:[^"]+)"/.exec(chainText(halted.err));
    assert.ok(printed, chainText(halted.err));
    assert.equal(printed[1], `adopt:bpf:${FLOW.entity}/${FLOW.name}`);
    const keys = authorizationKeys(['--authorize', printed[1]], specWith([FLOW]));
    assert.equal(keys.error, null);
    const bound = await cli(specWith([FLOW]), { authorizedAdoption: keys.adopt, verify: true });
    assert.equal(bound.err, undefined, chainText(bound.err));
    assert.deepEqual(bound.workflowWrites, [], 'a read-only adoption');
    const g = storeOf(dir).readGroup('bpf', GROUP).committed;
    assert.equal(g.records[0].origin, 'adopted');
    assert.deepEqual(bpfChecks(bound.verified).map((c) => c.present), [true], 'the inline verify reads the bound flow');
    const edited = specWith([{ ...FLOW, stages: [FLOW.stages[0], { ...FLOW.stages[1], name: 'Close' }] }]);
    const standalone = await verifySpec(edited, read, { managedManifest: manifestOf(dir) });
    assert.equal(bpfChecks(standalone)[0].present, false, 'the flow does not hold a declaration it was never built from');
    const downloaded = await download(wire, makeTempDir('declared-bpf-'), ['--include-managed', '--managed-manifest', storeFileOf(dir)]);
    assert.deepEqual(downloaded.emitted[0].payload.managedBpfs, { restored: [GROUP], stale: [] });
    assert.deepEqual(downloaded.written.businessProcessFlows, [FLOW]);
  });
});
// --- a removed or pending flow's identity -------------------------------------------------------------------------------------

test('a removed declared flow whose create answer was lost fences its table and name: the legacy path reads and creates nothing, even with the row not visible yet, and a late arrival leaves one flow', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    const isCreate = (e) => e.method === 'POST' && /^workflows$/i.test(e.path);
    wire.script(isCreate, { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    const lost = await build(wire, dir, specWith([FLOW]));
    assert.ok(lost.err, 'the lost create stops the run');
    assert.equal(wire.rows.size, 0, 'the create has not arrived');
    const original = wire.log.find(isCreate);
    const held = storeOf(dir).readGroup('bpf', GROUP);
    assert.ok(held.pending && typeof held.pending.root.id === 'string');
    // Undeclared under the same table and name, in the same case or another (the service compares names without case).
    for (const flows of [[legacy(FLOW)], [{ ...legacy(FLOW), name: FLOW.name.toUpperCase() }], []]) {
      const next = await build(wire, dir, specWith(flows));
      assert.equal(next.err && next.err.code, 'managed-not-settled', chainText(next.err));
      assert.match(chainText(next.err), /declared business process flow "new_ticket\/Ticket process": an earlier run's change of this flow is still waiting to be proved/);
      assert.deepEqual(next.writes, [], 'no legacy create beside the unproved one');
      assert.deepEqual(next.lines.filter((l) => /workflows/i.test(l)), [], 'the table and name are not even read');
      assert.equal(wire.rows.size, 0);
    }
    // The first request arrives late: still one flow, the held one.
    await wire.request({ method: original.method, url: original.url, headers: original.headers, body: JSON.stringify(original.body) });
    assert.deepEqual([...wire.rows.keys()].map((k) => k.toLowerCase()), [held.pending.root.id.toLowerCase()]);
  });
});

test('verify reads a pending or bound declared flow by its own id before any name lookup, so a namesake never passes for it', async () => {
  await withBpf(true, async () => {
    const namesake = '77777777-7777-4777-8777-777777777777';
    const legacyChecks = (r) => r.checks.filter((c) => c.kind === 'business-process-flow').map((c) => [c.present, c.detail]);
    const DRAFT = 'deployed but DRAFT — the process does not appear on the form';
    const readOver = async (wire, queries) => {
      const { sdk } = await sdkOver(wire);
      const { read } = await verifyReader(wire);
      return { ...read, queryRecords: async (table, o) => { queries.push(String((o && o.filter) || '')); return table === 'workflow' ? sdk.queryRecords(table, o) : []; } };
    };

    // Pending: the activation's answer was lost, so the Draft row is held; a maker renames it, and an Active flow takes its name.
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    wire.script((e) => e.method === 'PATCH', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    assert.ok((await build(wire, dir, specWith([FLOW]))).err);
    const id = storeOf(dir).readGroup('bpf', GROUP).pending.root.id;
    const manifest = manifestOf(dir);
    assert.deepEqual(manifest.pending.map((p) => [p.family, p.key, p.root && p.root.id]), [['bpf', GROUP, id]], 'the pending entry carries the row its attempt holds');
    wire.rows.set(namesake, { ...wire.row(id), workflowid: namesake, statecode: 1, statuscode: 2 });
    wire.row(id).name = 'Renamed in Maker';
    const queries = [];
    const read = await readOver(wire, queries);
    const pending = await verifySpec(specWith([FLOW]), read, { managedManifest: manifest });
    assert.deepEqual(legacyChecks(pending), [[false, DRAFT]], 'its own Draft row, not the Active namesake');
    assert.ok(queries.includes(`workflowid eq ${id}`), JSON.stringify(queries));
    assert.ok(!queries.some((q) => /\bname eq/.test(q)), 'never looked up by name');
    assert.ok(!pending.ok);

    // What cannot be read safely is unverified, never a pass and never a name read: no row named, a failed read, another row answered.
    const unnamed = { ...manifest, pending: manifest.pending.map((p) => ({ ...p, root: null })) };
    const failing = { ...read, queryRecords: async () => { throw new Error('connection reset'); } };
    const other = { ...read, queryRecords: async (table) => (table === 'workflow' ? [{ workflowid: namesake, statecode: 1 }] : []) };
    for (const [r, m, why] of [[read, unnamed, /the store does not name its row/], [failing, manifest, /could not be read: connection reset/], [other, manifest, /answered another row/]]) {
      queries.length = 0;
      const out = await verifySpec(specWith([FLOW]), r, { managedManifest: m });
      assert.deepEqual(legacyChecks(out), []);
      assert.ok(out.unverified.some((u) => u.startsWith('business-process-flow:new_ticket.Ticket process (') && why.test(u)), JSON.stringify(out.unverified));
      assert.ok(!queries.some((q) => /\bname eq/.test(q)));
    }

    // Bound: the same holds for a committed flow — its row deactivated and renamed beside an Active namesake fails as Draft.
    const bound = createWorkflowWire();
    const bdir = makeTempDir('declared-bpf-');
    assert.equal((await build(bound, bdir, specWith([FLOW]))).err, undefined);
    const bid = storeOf(bdir).readGroup('bpf', GROUP).committed.root.id;
    bound.rows.set(namesake, { ...bound.row(bid), workflowid: namesake });
    Object.assign(bound.row(bid), { statecode: 0, statuscode: 1, name: 'Renamed in Maker' });
    const bq = [];
    const committed = await verifySpec(specWith([FLOW]), await readOver(bound, bq), { managedManifest: manifestOf(bdir) });
    assert.deepEqual(legacyChecks(committed), [[false, DRAFT]]);
    assert.ok(!bq.some((q) => /\bname eq/.test(q)));
  });
});
// --- a removed flow whose row is gone ----------------------------------------------------------------------------------------

const RETIRED = /^managed-root-retired: declared business process flow "new_ticket\/Ticket process": its row [0-9a-f-]{36} is gone \(a read by its exact id answered not found\) and the spec no longer declares it/;
const isStateChange = (e) => e.method === 'PATCH' && /^workflows\(/i.test(e.path);
const idReadOf = (id) => (e) => e.method === 'GET' && e.path.toLowerCase() === `workflows(${id})`;

for (const [how, refuse] of [
  ['answered 412 and was not applied', (wire) => wire.script(isStateChange, { statusCode: 412, body: { error: { code: '0x80060882', message: 'version mismatch' } }, unapplied: true })],
  ['met a row a maker saved after the run read it', (wire) => wire.advance(isStateChange)],
]) {
  test(`a removed flow whose activation ${how} is retired, with a notice, once a fresh read by its id answers not found; until then it is held`, async () => {
    await withBpf(true, async () => {
      const wire = createWorkflowWire();
      const dir = makeTempDir('declared-bpf-');
      refuse(wire);
      const first = await build(wire, dir, specWith([FLOW]));
      assert.ok(first.err, 'the refused activation stops the run');
      const held = storeOf(dir).readGroup('bpf', GROUP);
      const id = held.pending.root.id;
      assert.deepEqual(held.effects.map((e) => [e.effect, e.state]), [['create', 'confirmed'], ['state', 'definitely-unsent']]);
      assert.equal(wire.row(id).statecode, 0, 'Draft');

      // The row is there: held, and nothing is written.
      const present = await build(wire, dir, specWith([]));
      assert.equal(present.err && present.err.code, 'managed-not-settled', chainText(present.err));
      assert.match(chainText(present.err), /it is not retired: its row is still there/);
      assert.deepEqual(present.writes, []);
      assert.equal(present.lines.filter((l) => l === 'GET workflows(<id>)?$select').length, 1, 'one read by its exact id');

      // Gone, but the answer proves nothing: a refusal, a 404 without the documented code, another row. Held each time.
      wire.rows.delete(id);
      for (const answer of [
        { statusCode: 403, body: { error: { code: '0x80040220', message: 'Principal user is missing prvReadWorkflow privilege' } } },
        { statusCode: 404, body: { error: { code: '0x80060888', message: 'Resource not found for the segment' } } },
        { statusCode: 200, body: { workflowid: '77777777-7777-4777-8777-777777777777' } },
      ]) {
        wire.script(idReadOf(id), answer);
        const unread = await build(wire, dir, specWith([]));
        assert.equal(unread.err && unread.err.code, 'managed-not-settled', JSON.stringify(answer));
        assert.match(chainText(unread.err), /it is not retired: its row could not be read/);
        assert.deepEqual(unread.writes, []);
        assert.ok(storeOf(dir).readGroup('bpf', GROUP).pending, 'still pending');
      }

      // Proved gone: retired with a notice that names the key and claims no change; nothing is written, and it stays retired.
      const retired = await build(wire, dir, specWith([]));
      assert.equal(retired.err, undefined, chainText(retired.err));
      assert.deepEqual(retired.writes, []);
      const notices = retired.warnings.filter((w) => w.startsWith('managed-root-retired:'));
      assert.equal(notices.length, 1, retired.warnings.join('\n'));
      assert.match(notices[0], RETIRED);
      assert.doesNotMatch(notices[0], /\bactivated\b/);
      const after = storeOf(dir);
      assert.deepEqual(after.readGroup('bpf', GROUP), { committed: null, pending: null, effects: [] });
      const entry = after.snapshot().envelope.retiredGroups.at(-1);
      assert.deepEqual([entry.family, entry.key, entry.generation, entry.rootId, entry.reason], ['bpf', GROUP, null, id, 'root-absent']);
      assert.deepEqual(entry.attempt.effects, [{ effect: 'create', state: 'confirmed' }, { effect: 'state', state: 'definitely-unsent' }], 'the record says what each change was');
      const again = await build(wire, dir, specWith([]));
      assert.equal(again.err, undefined);
      assert.deepEqual(again.lines.filter((l) => /workflows/i.test(l)), [], 'nothing left to read');
      assert.deepEqual(again.warnings.filter((w) => w.startsWith('managed-root-retired:')), []);
    });
  });
}

test('a committed flow the spec no longer declares is retired once its row is proved gone, so verify stops checking it; a row that is there or cannot be read keeps it', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    assert.equal((await build(wire, dir, specWith([FLOW]))).err, undefined);
    const id = storeOf(dir).readGroup('bpf', GROUP).committed.root.id;

    const present = await build(wire, dir, specWith([]));
    assert.equal(present.err, undefined);
    assert.deepEqual(present.writes, []);
    assert.deepEqual(present.warnings, []);
    assert.ok(storeOf(dir).readGroup('bpf', GROUP).committed, 'still managed');

    wire.rows.delete(id);
    wire.script(idReadOf(id), { statusCode: 403, body: { error: { code: '0x80040220', message: 'Principal user is missing prvReadWorkflow privilege' } } });
    const unread = await build(wire, dir, specWith([]));
    assert.equal(unread.err, undefined, 'a removed committed flow never stopped the run, and an unreadable row does not either');
    assert.match(unread.warnings.join('\n'), /declared business process flow "new_ticket\/Ticket process": the spec no longer declares it, and it stays in the binding store: its row could not be read \(HTTP 403: Principal user is missing prvReadWorkflow privilege\)/);
    assert.ok(storeOf(dir).readGroup('bpf', GROUP).committed);
    const { read } = await verifyReader(wire);
    assert.equal((await verifySpec({}, read, { managedManifest: manifestOf(dir) })).ok, false, 'verify still checks the row it is bound to');

    const retired = await build(wire, dir, specWith([]));
    assert.equal(retired.err, undefined);
    assert.deepEqual(retired.writes, []);
    assert.match(retired.warnings.join('\n'), RETIRED);
    const entry = storeOf(dir).snapshot().envelope.retiredGroups.at(-1);
    assert.deepEqual([entry.key, entry.rootId, entry.attempt], [GROUP, id, null]);
    assert.ok(typeof entry.generation === 'string' && entry.generation);
    const verified = await verifySpec({}, read, { managedManifest: manifestOf(dir) });
    assert.equal(verified.ok, true, JSON.stringify(verified.checks));
  });
});

test('a removed flow whose binding store changes while its row is read is not retired by that read', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    assert.equal((await build(wire, dir, specWith([FLOW]))).err, undefined);
    const committed = storeOf(dir).readGroup('bpf', GROUP).committed;
    const id = committed.root.id;
    wire.rows.delete(id);
    // Another run retires the group from its own store handle while this run's read of the row is on the wire.
    let raced = false;
    wire.script((e) => {
      if (!raced && idReadOf(id)(e)) {
        raced = true;
        storeOf(dir).retireAbsentGroup({ family: 'bpf', key: GROUP, generation: committed.generation, rootId: id, evidence: { kind: 'root-absent', rootId: id, row: 'not-found' } });
      }
      return false;
    }, null);
    const res = await build(wire, dir, specWith([]));
    assert.equal(raced, true);
    assert.equal(res.err, undefined);
    assert.deepEqual(res.writes, []);
    assert.doesNotMatch(res.warnings.join('\n'), RETIRED);
    assert.match(res.warnings.join('\n'), /declared business process flow "new_ticket\/Ticket process": the spec no longer declares it, and it stays in the binding store: the binding store changed while its row was read/);
    assert.equal(storeOf(dir).snapshot().envelope.retiredGroups.length, 1, 'only the other run\'s retirement is recorded');
  });
});

test('a removed flow whose operation was never sent is only noted: no read of its row, nothing written, and the run goes on', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    const denied = await build(wire, dir, specWith([FLOW]), {
      configureSdk: (sdk) => { sdk.executePrepared = async () => { throw Object.assign(new Error('flow operation unavailable'), { code: 'BPF_API_UNAVAILABLE' }); }; },
    });
    assert.ok(denied.err);
    assert.deepEqual(denied.writes, []);
    assert.ok(storeOf(dir).readGroup('bpf', GROUP).effects.every((e) => e.state === 'definitely-unsent'));
    const removed = await build(wire, dir, specWith([]));
    assert.equal(removed.err, undefined, chainText(removed.err));
    assert.deepEqual(removed.writes, []);
    assert.deepEqual(removed.lines.filter((l) => /workflows/i.test(l)), [], 'nothing sent, so nothing to read');
    assert.match(removed.warnings.join('\n'), /declared business process flow "new_ticket\/Ticket process": an earlier run prepared it and sent nothing/);
  });
});

// --- a change of the authored flow alone -------------------------------------------------------------------------------------

test('a change of the security roles alone sends no workflow write, grants on the stored backing table, and the managed download restores the flow as now written', async () => {
  await withBpf(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-bpf-');
    const grants = [];
    const persona = { persona: 'Ops', appAccess: false, jobs: [{ name: 'Triage', privileges: [{ entity: 'new_ticket', access: ['read'] }] }] };
    // A flow a maker made, with a backing table name the build would not derive: the grant must follow the stored one.
    const seeded = await build(wire, makeTempDir('declared-bpf-'), specWith([legacy(FLOW)]));
    assert.equal(seeded.err, undefined);
    wire.row(seeded.out.created.businessProcessFlows[KEY]).uniquename = 'new_maker_owned_backing';
    const configureSdk = (sdk) => {
      sdk.createPersonaRole = async () => ({ roleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', reused: true, appliedPrivileges: [] });
      sdk.addEntityPrivilegesToRole = async (roleId, privileges) => { grants.push({ roleId, privileges }); return privileges; };
    };
    const phases = ['business-process-flows', 'security'];
    const spec = { ...specWith([FLOW]), personas: [persona] };
    assert.deepEqual(validateAppSpec(spec, { profile: 'deploy' }).errors, []);
    assert.equal((await build(wire, dir, spec, { phases, configureSdk, authorizedAdoption: new Set([APPROVAL]) })).err, undefined);
    assert.equal(grants.length, 0);

    const updated = { ...FLOW, securityRoles: { personas: ['Ops'] } };
    const next = await build(wire, dir, { ...spec, businessProcessFlows: [updated] }, { phases, configureSdk });
    assert.equal(next.err, undefined, chainText(next.err));
    assert.deepEqual(next.writes.filter((e) => /^workflows/i.test(e.path)), [], 'no workflow write');
    assert.deepEqual(grants.map((g) => g.privileges[0].entity), ['new_maker_owned_backing']);
    const group = storeOf(dir).readGroup('bpf', GROUP);
    assert.deepEqual(group.committed.originalDeclaration, updated, 'the commit records the flow as now written');
    assert.equal(group.committed.consumerState.declaration.backing, 'new_maker_owned_backing', 'and keeps the backing table it proved');

    // The same flow again records nothing new.
    const file = storeFileOf(dir);
    const before = fs.readFileSync(file, 'utf8');
    const same = await build(wire, dir, { ...spec, businessProcessFlows: [updated] }, { phases, configureSdk });
    assert.equal(same.err, undefined);
    assert.deepEqual(same.writes.filter((e) => /^workflows/i.test(e.path)), []);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'an unchanged declaration is a no-op');

    const dl = await download(wire, makeTempDir('declared-bpf-'), ['--include-managed', '--managed-manifest', file], {
      runDownload: async () => ({ ok: true, spec: { ...specWith([]), personas: [persona] }, pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [] }),
    });
    assert.equal(dl.emitted[0].ok, true, JSON.stringify(dl.emitted) + dl.said);
    assert.deepEqual(dl.written.businessProcessFlows, [updated]);
  });
});