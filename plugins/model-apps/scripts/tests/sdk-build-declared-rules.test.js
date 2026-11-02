'use strict';
// Declared business rules (businessRules[].reconcile: "declared") wired into the build: the spec gate, the business-rules phase's
// dispatch to the managed rule helper (lib/rule-settlement.js settleDeclaredRule), the halt it is given, the workflow effect gate the
// build binds to its store (lib/deferred-workflow-gate.js), the "cannot host rules" skip, and a stored attempt whose declaration
// left the spec. Everything runs through the real engine (lib/sdk-build.js runSdkBuild), the real vendored SDK and the plugin's real
// client over an in-memory workflow table (helpers/workflow-wire.js) that enforces If-Match, with the CLI's transport shape: the
// publication barrier with the send observer inside it, and the gate on the client.
// The round trip is here too: the typed approval (build-model-app.js authorizationKeys), verify's check of a bound rule
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
    assert.ok(v.errors.includes("businessRules: 'Hide notes when closed' — reconcile is supported only on views, charts, forms, dashboards, business process flows and web resources; leave it out (this artifact keeps the existing build behaviour)"), JSON.stringify(v.errors));
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

// --- the approval ------------------------------------------------------------------------------------------------------------

test('--authorize adopt:rule:<table>/<name> is read in any case, typed or not, as the helper\'s approval; an overwrite, an undeclared rule or an ambiguous key is refused', async () => {
  await withRules(true, () => {
    const spec = specWith([RULE]);
    const keys = (...list) => authorizationKeys(list.flatMap((k) => ['--authorize', k]), spec);
    for (const key of ['adopt:rule:NEW_TICKET/hide notes WHEN closed', `adopt:${RULE.entity}/${RULE.name}`, 'adopt:New_Ticket/HIDE NOTES WHEN CLOSED']) {
      const r = keys(key);
      assert.equal(r.error, null, key);
      assert.deepEqual([...r.adopt], [APPROVAL], key);
      assert.equal(r.overwrite.size, 0, key);
    }
    for (const [key, words] of [
      [`overwrite:rule:${RULE.entity}/${RULE.name}`, /is not an approval a declared business rule takes: it is adopted whole, never overwritten by an approval \(use adopt:rule:new_ticket\/Hide notes when closed/],
      [`overwrite:${RULE.entity}/${RULE.name}`, /is not an approval a declared business rule takes/],
      ['adopt:rule:new_ticket/Other rule', /approves an artifact the spec does not declare \(it would need a business rule with reconcile: "declared" named new_ticket\/Other rule, as <table>\/<name>\)/],
      ['adopt:new_ticket/Other rule', /it would need a view or chart, or a business rule, with reconcile: "declared" keyed new_ticket\/Other rule/],
    ]) {
      const r = keys(key);
      assert.match(String(r.error), words, key);
      assert.equal(r.adopt.size + r.overwrite.size, 0, key);
    }
    // A declared view of the same table and name: the untyped key could mean either.
    const both = specWith([RULE]);
    both.views = [{ entity: 'new_ticket', name: RULE.name, reconcile: 'declared', columns: ['new_subject'] }];
    const ambiguous = authorizationKeys(['--authorize', `adopt:${RULE.entity}/${RULE.name}`], both);
    assert.match(String(ambiguous.error), /could approve more than one declared artifact; name the one you mean with its typed key: adopt:view:new_ticket\/Hide notes when closed or adopt:rule:new_ticket\/Hide notes when closed/);
    assert.equal(ambiguous.adopt.size, 0);
    // An undeclared rule of the same name takes no approval.
    assert.match(String(authorizationKeys(['--authorize', `adopt:rule:${RULE.entity}/${RULE.name}`], specWith([legacy(RULE)])).error), /does not declare/);
  });
  await withRules(false, () => {
    const off = authorizationKeys(['--authorize', `adopt:rule:${RULE.entity}/${RULE.name}`], specWith([RULE]));
    assert.match(String(off.error), /does not declare/);
    assert.equal(off.adopt.size, 0);
  });
});

// --- verify ------------------------------------------------------------------------------------------------------------------

// verify's reader as the CLI builds it (verify-model-app.js readerFor): a declared rule is read by its bound id on a throwaway SDK
// (isolatedReaderFor) over the same wire, never the build's.
async function verifyReader(wire) {
  const { sdk } = await sdkOver(wire);
  const cli = readerFor(sdk, APP, { isolatedReader: isolatedReaderFor(ORIGIN, { httpClient: clientOver(wire) }) });
  const ruleReads = [];
  const idReads = [];
  return {
    ruleReads,
    idReads,
    read: {
      findTable: async () => ({ logicalName: 'new_ticket' }),
      findColumns: async () => ['new_subject', 'new_status', 'new_notes', 'new_owner'],
      // The bound-id read verify makes of a group it does not hold as declared: workflow by workflowid, answered from the wire.
      queryRecords: async (table, o) => {
        const id = (/workflowid eq (\S+)/.exec((o && o.filter) || '') || [])[1];
        if (table === 'workflow' && id) { idReads.push(id); return wire.row(id) ? [{ workflowid: id }] : []; }
        return [];
      },
      sitemapXml: async () => '',
      declaredRule: async (id) => { ruleReads.push(id); return cli.declaredRule(id); },
    },
  };
}
const ruleChecks = (r) => r.checks.filter((c) => c.kind === 'managed-rule');
const manifestOf = (dir) => readVerifyManifest({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOLUTION });
const KEY = `new_ticket/${RULE.name}`;

test('verify holds a bound declared rule to its declaration and last proof by a fresh read of its id', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    assert.equal((await build(wire, dir, specWith([RULE]))).err, undefined);
    const id = storeOf(dir).readGroup('rule', KEY).committed.root.id;
    const { read, ruleReads } = await verifyReader(wire);
    const pass = await verifySpec(specWith([RULE]), read, { managedManifest: manifestOf(dir) });
    assert.deepEqual(ruleChecks(pass).map((c) => [c.name, c.present, c.detail]), [[`${KEY} (${id})`, true, '']]);
    assert.deepEqual(ruleReads, [id], 'read by the bound id');
    assert.deepEqual((pass.unverified || []).filter((u) => u.startsWith('managed:')), []);
    // A declaration the rule does not hold yet fails it, with the way out.
    const edited = specWith([{ ...RULE, actions: [{ ...RULE.actions[0], visible: true }] }]);
    const changed = await verifySpec(edited, read, { managedManifest: manifestOf(dir) });
    assert.equal(ruleChecks(changed)[0].present, false);
    assert.match(ruleChecks(changed)[0].detail, /^rule-declaration-changed: the spec's declaration .*which is not on the rule yet/);
    assert.ok(changed.missing.some((m) => m.kind === 'managed-rule'), 'a failing bound rule fails verify');
    // An omitted description or condition logic is not a change, as it is not for the build.
    assert.equal(ruleChecks(await verifySpec(specWith([{ ...RULE, description: undefined }]), read, { managedManifest: manifestOf(dir) }))[0].present, true);
    // The rule deactivated outside the spec fails it under the unchanged declaration; so does a body edit.
    Object.assign(wire.row(id), { statecode: 0, statuscode: 1 });
    const drafted = await verifySpec(specWith([RULE]), read, { managedManifest: manifestOf(dir) });
    assert.equal(ruleChecks(drafted)[0].present, false);
    assert.match(ruleChecks(drafted)[0].detail, /^rule-changed: the rule \(now Draft\) is not what its last build proved/);
    Object.assign(wire.row(id), { statecode: 1, statuscode: 2 });
    assert.equal(ruleChecks(await verifySpec(specWith([RULE]), read, { managedManifest: manifestOf(dir) }))[0].present, true, 'control: Active again');
    const wfom = wire.row(id).wfom;
    wire.row(id).wfom = wfom.split('new_notes').join('new_owner');
    assert.match(ruleChecks(await verifySpec(specWith([RULE]), read, { managedManifest: manifestOf(dir) }))[0].detail, /^rule-(changed|shape-unsupported): /);
    wire.row(id).wfom = wfom;
    // And a rule no read can find is reported failed, never passed.
    wire.rows.delete(id);
    const gone = await verifySpec(specWith([RULE]), read, { managedManifest: manifestOf(dir) });
    assert.deepEqual(ruleChecks(gone).map((c) => c.present), [false]);
  });
});

test('verify fails a keyed rule renamed in the spec, lists a reader that cannot read a rule as unverified, and with the build path off holds the group to its bound id', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    const keyed = { ...RULE, key: 'hide-notes' };
    assert.equal((await build(wire, dir, specWith([keyed]))).err, undefined);
    const id = storeOf(dir).readGroup('rule', 'hide-notes').committed.root.id;
    const { read, ruleReads, idReads } = await verifyReader(wire);
    assert.equal(ruleChecks(await verifySpec(specWith([keyed]), read, { managedManifest: manifestOf(dir) }))[0].present, true);
    const renamed = await verifySpec(specWith([{ ...keyed, name: 'Hide notes once closed' }]), read, { managedManifest: manifestOf(dir) });
    assert.equal(ruleChecks(renamed)[0].present, false);
    assert.match(ruleChecks(renamed)[0].detail, /^rule-declaration-changed: the spec names this rule new_ticket\/Hide notes once closed and its last build settled new_ticket\/Hide notes when closed; a build does not rename or move a managed rule/);
    const { declaredRule, ...plain } = read;
    void declaredRule;
    const blind = await verifySpec(specWith([keyed]), plain, { managedManifest: manifestOf(dir) });
    assert.deepEqual(ruleChecks(blind), []);
    assert.ok(blind.unverified.includes('managed:rule hide-notes (this reader cannot read a business rule by id)'), JSON.stringify(blind.unverified));
    await withRules(false, async () => {
      const before = ruleReads.length;
      const off = await verifySpec(specWith([keyed]), read, { managedManifest: manifestOf(dir) });
      assert.deepEqual(ruleChecks(off).map((c) => [c.name, c.present, c.detail]), [[`hide-notes (${id})`, true, '']]);
      assert.equal(ruleReads.length, before, 'not read as a declared rule');
      assert.deepEqual(idReads, [id], 'held to its bound workflow id');
    });
  });
});

// --- the explicit managed download -------------------------------------------------------------------------------------------

// download-model-app.js main with its side effects replaced: the download's SDK is a real one over the wire, and runDownload answers
// the spec a download of this app hydrates, which holds no business rule (a plain download reconstructs none), or `plain` if given.
async function download(wire, out, argv, { plain, ...extra } = {}) {
  const { sdk } = await sdkOver(wire);
  const dl = Object.create(sdk);
  dl.queryRecords = async (table, o) => (table === 'appmodule' ? [{ uniquename: APP }] : sdk.queryRecords(table, o));
  const downloaded = specWith([]);
  delete downloaded.businessRules;
  if (plain) downloaded.businessRules = plain;
  const emitted = [];
  const said = [];
  const mark = wire.log.length;
  await downloadMain({
    argv: ['--env', ORIGIN, '--app', '00000000-0000-0000-0000-00000000a222', '--out', out, ...argv],
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

test('the explicit managed download restores a proved declared rule into businessRules, and names any it cannot restore', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    assert.equal((await build(wire, dir, specWith([RULE]))).err, undefined);
    const id = storeOf(dir).readGroup('rule', KEY).committed.root.id;
    const flags = ['--include-managed', '--managed-manifest', storeFileOf(dir)];
    const restored = await download(wire, makeTempDir('declared-rule-'), flags);
    assert.equal(restored.emitted.length, 1);
    assert.equal(restored.emitted[0].ok, true, JSON.stringify(restored.emitted) + restored.said);
    assert.deepEqual(restored.emitted[0].payload.managedRules, { restored: [KEY], stale: [] });
    assert.deepEqual(restored.written.businessRules, [RULE], 'the declaration it was built from, whole');
    // An entry for the same table and name is replaced, never doubled.
    const replaced = await download(wire, makeTempDir('declared-rule-'), flags, { plain: [legacy(RULE), legacy(LOCK)] });
    assert.deepEqual(replaced.written.businessRules, [RULE, legacy(LOCK)]);
    // A rule changed since its last proof is named and left out; the rest of the download is written.
    Object.assign(wire.row(id), { statecode: 0, statuscode: 1 });
    const changed = await download(wire, makeTempDir('declared-rule-'), flags);
    assert.equal(changed.emitted[0].ok, true);
    assert.deepEqual(changed.emitted[0].payload.managedRules.restored, []);
    assert.match(changed.emitted[0].payload.managedRules.stale[0].reason, new RegExp(`rule ${id} is not what its last build proved \\(rule-changed\\)`));
    assert.match(changed.said, /WARNING: managed business rule new_ticket\/Hide notes when closed was not restored: /);
    assert.equal(changed.written.businessRules, undefined);
  });
});

test('the explicit managed download names a rule whose last attempt is not settled, and without the flags reads no rule by id', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    wire.script((e) => e.method === 'PATCH', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    assert.ok((await build(wire, dir, specWith([RULE]))).err);
    const pending = await download(wire, makeTempDir('declared-rule-'), ['--include-managed', '--managed-manifest', storeFileOf(dir)]);
    assert.equal(pending.emitted[0].ok, true, JSON.stringify(pending.emitted));
    assert.deepEqual(pending.emitted[0].payload.managedRules.restored, []);
    assert.match(pending.emitted[0].payload.managedRules.stale[0].reason, /its last attempt is not settled/);
    assert.deepEqual(pending.calls.filter((c) => /RetrieveProcessWithWfomJson/.test(c.path)), [], 'an unsettled rule is not read');
    const plain = await download(wire, makeTempDir('declared-rule-'), []);
    assert.equal(plain.emitted[0].ok, true, JSON.stringify(plain.emitted) + plain.said);
    assert.equal('managedRules' in plain.emitted[0].payload, false);
    assert.deepEqual(plain.calls.filter((c) => /^workflows\(/i.test(c.path)), [], 'no rule is read');
  });
});

// --- the CLI -----------------------------------------------------------------------------------------------------------------

test('the enabled feature through the CLI: the printed typed approval binds the rule, verify passes then fails a changed declaration, and the managed download restores it', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    assert.equal((await build(wire, makeTempDir('declared-rule-'), specWith([legacy(RULE)]))).err, undefined, 'the maker\'s rule');
    const appDir = makeTempDir('declared-rule-');
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
          sdk, provisionSdk: sdk, runBuild: (s, o) => runSdkBuild(s, { ...o, phases: ['business-rules'] }), publicationBarrier: barrier, sendObserver, workflowEffectGate, warn: () => {}, log: () => {},
          verify: async (s, o) => { verified = await verifySpec(s, read, o); return verified; },
        });
      } catch (e) { err = e; }
      return { err, verified, workflowWrites: wire.log.slice(mark).filter((c) => c.method !== 'GET' && /^workflows/i.test(c.path)) };
    };
    const halted = await cli(specWith([RULE]));
    assert.ok(halted.err, 'the unbound rule is not taken over');
    assert.deepEqual(halted.workflowWrites, []);
    const printed = /--authorize "(adopt:rule:[^"]+)"/.exec(chainText(halted.err));
    assert.ok(printed, chainText(halted.err));
    assert.equal(printed[1], `adopt:rule:${RULE.entity}/${RULE.name}`);
    const keys = authorizationKeys(['--authorize', printed[1]], specWith([RULE]));
    assert.equal(keys.error, null);
    const bound = await cli(specWith([RULE]), { authorizedAdoption: keys.adopt, verify: true });
    assert.equal(bound.err, undefined, chainText(bound.err));
    assert.deepEqual(bound.workflowWrites, [], 'a read-only adoption');
    const g = storeOf(dir).readGroup('rule', KEY).committed;
    assert.equal(g.records[0].origin, 'adopted');
    assert.deepEqual(ruleChecks(bound.verified).map((c) => c.present), [true], 'the inline verify reads the bound rule');
    const edited = specWith([{ ...RULE, actions: [{ ...RULE.actions[0], visible: true }] }]);
    const standalone = await verifySpec(edited, read, { managedManifest: manifestOf(dir) });
    assert.equal(ruleChecks(standalone)[0].present, false, 'the rule does not hold a declaration it was never built from');
    const downloaded = await download(wire, makeTempDir('declared-rule-'), ['--include-managed', '--managed-manifest', storeFileOf(dir)]);
    assert.deepEqual(downloaded.emitted[0].payload.managedRules, { restored: [KEY], stale: [] });
    assert.deepEqual(downloaded.written.businessRules, [RULE]);
  });
});
