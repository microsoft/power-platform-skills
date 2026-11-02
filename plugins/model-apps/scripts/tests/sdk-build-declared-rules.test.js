'use strict';
// Declared business rules (businessRules[].reconcile: "declared") wired into the build: the spec gate, the business-rules phase's
// dispatch to the managed rule helper (lib/rule-settlement.js settleDeclaredRule), the halt it is given, the workflow effect gate the
// build binds to its store (lib/deferred-workflow-gate.js), the "cannot host rules" skip, and a stored attempt whose declaration
// left the spec. Everything runs through the real engine (lib/sdk-build.js runSdkBuild), the real vendored SDK and the plugin's real
// client over an in-memory workflow table (helpers/workflow-wire.js) that enforces If-Match, with the CLI's transport shape: the
// publication barrier with the send observer inside it, and the gate on the client.
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

const SOLUTION = 'BR';
const APP = 'new_brapp';
const RULE = {
  entity: 'new_ticket', name: 'Hide notes when closed', reconcile: 'declared',
  conditions: [{ key: 'closed', field: 'new_status', operator: 'Equals', value: '100000001', dataType: 'Picklist' }],
  actions: [{ key: 'hide-notes', type: 'SetVisibility', field: 'new_notes', visible: false }],
};
const LOCK = {
  entity: 'new_ticket', name: 'Lock owner when closed', reconcile: 'declared',
  conditions: [{ key: 'closed', field: 'new_status', operator: 'Equals', value: '100000001', dataType: 'Picklist' }],
  actions: [{ key: 'lock-owner', type: 'LockUnlock', field: 'new_owner', lock: true }],
};
// The same rule as the build has always made it: no reconcile, no keys.
const legacy = (r) => ({
  entity: r.entity, name: r.name,
  conditions: r.conditions.map(({ key, ...c }) => c),
  actions: r.actions.map(({ key, ...a }) => a),
});
const APPROVAL = `rule:${RULE.entity}/${RULE.name}`;

function specWith(rules) {
  return {
    solution: { uniqueName: SOLUTION, displayName: 'BR', publisherPrefix: 'new' },
    app: { name: 'BR App', uniqueName: APP, description: '' },
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
    businessRules: rules,
  };
}

async function withRules(on, fn) {
  const was = DECLARED_FEATURES.rules;
  DECLARED_FEATURES.rules = on;
  try { return await fn(); } finally { DECLARED_FEATURES.rules = was; }
}

const storeOf = (dir) => openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOLUTION });

// One invocation, as build-model-app.js assembles it: a fresh barrier, send observer, workflow effect gate and SDK over the same
// wire and the same build workspace `dir`, which holds the binding store. `gate: false` leaves the client without a gate.
async function build(wire, dir, spec, { gate = true, ...opts } = {}) {
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const workflowEffectGate = gate ? createDeferredWorkflowGate() : null;
  // How many times the build bound the gate to its store (once at most: a build opens one store).
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
      phases: ['business-rules'], publicationBarrier: barrier, sendObserver, ...(workflowEffectGate ? { workflowEffectGate } : {}), ...opts,
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
const CREATE = 'POST workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson';

// --- the spec gate -----------------------------------------------------------------------------------------------------------

test('with the build path off, a declared business rule is refused with the words it always had', async () => {
  await withRules(false, () => {
    const v = validateAppSpec(specWith([RULE]), { profile: 'deploy' });
    assert.equal(v.ok, false);
    assert.ok(v.errors.includes("businessRules: 'Hide notes when closed' — reconcile is supported only on views, charts, forms, dashboards and web resources; leave it out (this artifact keeps the existing build behaviour)"), JSON.stringify(v.errors));
  });
});

test('with the build path on, a declared rule validates with its keys and every action shape, and what the helper cannot settle is refused', async () => {
  await withRules(true, () => {
    assert.deepEqual(validateAppSpec(specWith([RULE]), { profile: 'deploy' }).errors, []);
    // The shapes an undeclared rule still refuses are a declared rule's, with the AllForms scope and OR logic.
    const rich = {
      ...RULE, scope: 'AllForms', conditionLogic: 'OR',
      actions: [
        { key: 'default-owner', type: 'SetDefaultValue', field: 'new_owner', value: 'ops' },
        { key: 'say', type: 'ShowErrorMessage', field: 'new_notes', errorMessage: 'Closed tickets need notes' },
        { key: 'rec', type: 'Recommendation', field: 'new_owner', recommendationTitle: 'Assign', messageText: 'Assign to ops', applyActions: [{ key: 'to-ops', field: 'new_owner', value: 'ops' }] },
      ],
    };
    assert.deepEqual(validateAppSpec(specWith([rich]), { profile: 'deploy' }).errors, []);
    assert.ok(validateAppSpec(specWith([legacy(rich)]), { profile: 'deploy' }).errors.some((e) => /action type must be one of SetVisibility\|LockUnlock\|SetBusinessRequired\|SetFieldValue \(got 'SetDefaultValue'\)/.test(e)), 'undeclared, the newer shapes stay closed');
    const refused = (rule) => {
      const v = validateAppSpec(specWith(Array.isArray(rule) ? rule : [rule]), { profile: 'deploy' });
      assert.equal(v.ok, false, JSON.stringify(rule));
      return v.errors.join('\n');
    };
    assert.match(refused({ ...RULE, reconcile: 'additive' }), /business rule 'Hide notes when closed': reconcile must be "declared" \(or left out\)/);
    assert.match(refused({ ...RULE, conditions: [{ ...RULE.conditions[0], key: undefined }] }), /condition 1 needs a key \(reconcile: "declared"\)/);
    assert.match(refused({ ...RULE, scope: 'Form' }), /scope must be one of Entity\|AllForms/);
    assert.match(refused({ ...RULE, actions: [{ ...rich.actions[2], applyActions: [{ key: 'x', field: 'new_ghost', value: '1' }] }] }), /applyActions 1 references 'new_ghost', which is not a column on new_ticket/);
    // One approval (rule:<table>/<name>) would approve both, and the undeclared one's state convergence would write the declared row.
    assert.match(refused([RULE, { ...LOCK, name: 'hide notes WHEN closed' }]), /are business rules on new_ticket with the same name/);
    assert.match(refused([RULE, legacy(RULE)]), /are business rules on new_ticket with the same name/);
    assert.match(refused([{ ...RULE, key: 'one' }, { ...LOCK, key: 'ONE' }]), /are declared business rules with the same key \(ONE\)/);
    // Two undeclared rules are what they always were.
    assert.deepEqual(validateAppSpec(specWith([legacy(RULE), legacy(LOCK)]), { profile: 'deploy' }).errors, []);
  });
});

// --- the build ---------------------------------------------------------------------------------------------------------------

test('with the build path off or on, an undeclared rule sends exactly the requests it always sent', async () => {
  const run = (on) => withRules(on, async () => {
    const wire = createWorkflowWire();
    const b = await build(wire, makeTempDir('declared-rule-'), specWith([legacy(RULE)]));
    assert.equal(b.err, undefined, chainText(b.err));
    assert.equal(b.binds, 0, 'no declared rule and no stored effect: the gate stays unbound');
    return b.lines;
  });
  const off = await run(false);
  assert.ok(off.includes(CREATE), 'control: the legacy rule is created');
  assert.deepEqual(await run(true), off);
});

test('a declared rule is created Draft under its catalog id, proved, then activated by one conditional write; the rebuild sends nothing', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    const first = await build(wire, dir, specWith([RULE]));
    assert.equal(first.err, undefined, chainText(first.err));
    const id = first.out.created.businessRules[`new_ticket|${RULE.name}`];
    assert.match(String(id), /^[0-9a-f-]{36}$/);
    const workflowWrites = first.writes.filter((c) => /^workflows/i.test(c.path));
    assert.deepEqual(workflowWrites.map((c) => `${c.method} ${c.path.replace(id, '<id>')}`), [`${CREATE.slice(0, 4)} ${CREATE.slice(5)}`, 'PATCH workflows(<id>)']);
    const [create, activate] = workflowWrites;
    assert.equal(create.body.Entity.workflowid, id, 'the catalog id is the row id');
    assert.deepEqual(activate.body, { statecode: 1, statuscode: 2 });
    assert.equal(activate.headers['If-Match'] || activate.headers['if-match'], `W/"${wire.row(id).version - 1}"`, 'against the version of the read that proved the body');
    assert.deepEqual(wire.deleted, []);
    assert.equal(wire.row(id).statecode, 1);
    assert.ok(first.writes.some((c) => /AddSolutionComponent/i.test(c.path) && JSON.stringify(c.body).includes(id)), 'the created rule joins the solution');
    assert.equal(first.binds, 1, 'the build bound the gate of its client to its store');
    const store = storeOf(dir);
    const { committed, pending } = store.readGroup('rule', `new_ticket/${RULE.name}`);
    assert.equal(pending, null);
    assert.deepEqual(committed.records.map((r) => [r.kind, r.id, r.origin]), [['business-rule', id, 'created']]);

    const again = await build(wire, dir, specWith([RULE]));
    assert.equal(again.err, undefined, chainText(again.err));
    assert.deepEqual(again.writes.filter((c) => /^workflows/i.test(c.path)), [], 'the same declaration again is a no-op');
    assert.equal(again.out.created.businessRules[`new_ticket|${RULE.name}`], id);
  });
});

test('a declared rule found unbound halts through the build halt with the typed adoption it needs; nothing is written until it is given', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const seeded = await build(wire, makeTempDir('declared-rule-'), specWith([legacy(RULE)]));
    assert.equal(seeded.err, undefined, chainText(seeded.err));
    const dir = makeTempDir('declared-rule-');
    const refused = await build(wire, dir, specWith([RULE]));
    assert.ok(refused.err, 'the run stops');
    assert.deepEqual(refused.writes, [], 'nothing is written for an unbound rule');
    const halt = ownHalt(refused.err);
    assert.ok(halt, chainText(refused.err));
    assert.equal(halt.name, 'BuildHalt');
    assert.equal(halt.code, 'create-ownership-required');
    assert.equal(halt.retry, RETRY.NEVER);
    assert.deepEqual(halt.findings.map((f) => [f.label, f.code]), [[`declared rule "new_ticket/${RULE.name}"`, 'create-ownership-required']]);
    assert.match(halt.message, /\(approve with --authorize "adopt:rule:new_ticket\/Hide notes when closed"\)/);

    const adopted = await build(wire, dir, specWith([RULE]), { authorizedAdoption: new Set([APPROVAL]) });
    assert.equal(adopted.err, undefined, chainText(adopted.err));
    assert.deepEqual(adopted.writes.filter((c) => /^workflows/i.test(c.path)), [], 'a read-only adoption');
    assert.equal(storeOf(dir).readGroup('rule', `new_ticket/${RULE.name}`).committed.records[0].origin, 'adopted');
  });
});

test('a declared rule whose client has no workflow effect gate bound to the store stops before any request for it', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const b = await build(wire, makeTempDir('declared-rule-'), specWith([RULE]), { gate: false });
    const halt = ownHalt(b.err);
    assert.ok(halt, chainText(b.err));
    assert.equal(halt.code, 'workflow-state-path-unavailable');
    assert.equal(halt.retry, RETRY.NEVER);
    assert.deepEqual(b.lines.filter((l) => /workflows/.test(l) && !/EntityDefinitions/.test(l)), [], 'no request for the rule, read or write');
  });
});

test('an environment that cannot host rules skips every declared rule with one warning, and the same answer after a create halts', async () => {
  await withRules(true, async () => {
    const off = { statusCode: 400, body: { error: { code: '0x80040216', message: 'An unexpected error occurred.' } }, unapplied: true };
    const wire = createWorkflowWire();
    wire.script((e) => /CreateProcess/.test(e.path), off);
    const b = await build(wire, makeTempDir('declared-rule-'), specWith([RULE, LOCK]));
    assert.equal(b.err, undefined, chainText(b.err));
    assert.deepEqual(b.out.skipped.businessRules, [`new_ticket|${RULE.name}`, `new_ticket|${LOCK.name}`]);
    assert.deepEqual(b.writeLines.filter((l) => /CreateProcess/.test(l)), [CREATE], 'the second rule is not sent');
    assert.equal(b.warnings.filter((w) => /business rules were NOT created/.test(w)).length, 1);
    assert.deepEqual(b.out.created.businessRules, {});

    const after = createWorkflowWire();
    let creates = 0;
    after.script((e) => /CreateProcess/.test(e.path) && ++creates === 2, off);
    const late = await build(after, makeTempDir('declared-rule-'), specWith([RULE, LOCK]));
    const halt = ownHalt(late.err);
    assert.ok(halt, chainText(late.err));
    assert.equal(halt.code, 'business-rule-unavailable-after-create');
    assert.deepEqual(late.out, undefined);
  });
});

test('a stored rule change still waiting to be proved after its declaration left the spec holds the run, and its row is not written', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    wire.script((e) => e.method === 'PATCH', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    const lost = await build(wire, dir, specWith([RULE]));
    assert.ok(lost.err, 'the lost activation stops the run');
    const id = [...wire.rows.keys()][0];
    assert.equal(wire.row(id).statecode, 0, 'Draft');

    // The entry is now undeclared: the legacy path would activate the Draft row it finds by name.
    const undeclared = await build(wire, dir, specWith([legacy(RULE)]));
    assert.ok(undeclared.err, 'the run ends incomplete');
    assert.equal(undeclared.err.code, 'managed-not-settled');
    assert.match(chainText(undeclared.err), /declared business rule "new_ticket\/Hide notes when closed": an earlier run's change of this rule is still waiting to be proved, and the spec no longer declares it/);
    assert.deepEqual(undeclared.writes, [], 'nothing is written to the held row');
    assert.equal(undeclared.binds, 1, 'the store holds a workflow effect, so the gate is bound with no declared rule');
    assert.equal(wire.row(id).statecode, 0);

    // Removed altogether: the same hold, and nothing sent.
    const removed = await build(wire, dir, specWith([]));
    assert.equal(removed.err && removed.err.code, 'managed-not-settled');
    assert.deepEqual(removed.writes, []);
  });
});
// --- the deferred gate -------------------------------------------------------------------------------------------------------

test('the deferred gate passes everything until bound, refuses a write inside an effect while unbound, and binds to one store only', async () => {
  const { runWithWorkflowEffect, MISMATCH } = require('../lib/workflow-effect-context.js');
  const gate = createDeferredWorkflowGate();
  const patch = { method: 'PATCH', url: `${ORIGIN}/api/data/v9.2/workflows(11111111-1111-4111-8111-111111111111)`, body: '{}' };
  assert.equal(gate.screen(patch), null, 'unbound and outside an effect: untouched');
  const effect = { token: 't', family: 'rule', key: 'new_ticket/x', effect: 'state', request: { shape: 'state' } };
  assert.throws(() => runWithWorkflowEffect(effect, () => gate.screen(patch)), (e) => e.code === MISMATCH && /not bound to its managed binding store/.test(e.message));
  assert.equal(runWithWorkflowEffect(effect, () => gate.screen({ method: 'GET', url: patch.url })), null, 'a read inside an effect passes');
  const store = storeOf(makeTempDir('declared-rule-'));
  assert.equal(gate.boundTo(store), false);
  gate.bind(store);
  gate.bind(store);
  assert.equal(gate.boundTo(store), true);
  assert.throws(() => gate.bind(storeOf(makeTempDir('declared-rule-'))), /already bound to another managed binding store/);
});