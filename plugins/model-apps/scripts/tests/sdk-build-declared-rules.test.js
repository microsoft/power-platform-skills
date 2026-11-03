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
const { createWorkflowWire, stepNames, ORIGIN } = require('./helpers/workflow-wire.js');
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
// `configureSdk(sdk, gate)`, when given, adjusts that invocation's SDK before the build runs (e.g. a capability it lacks).
async function build(wire, dir, spec, { gate = true, configureSdk, sdkDir, ...opts } = {}) {
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const workflowEffectGate = gate ? createDeferredWorkflowGate() : null;
  // How many times the build bound the gate to its store (once at most: a build opens one store).
  const binds = [];
  if (workflowEffectGate) {
    const bind = workflowEffectGate.bind;
    workflowEffectGate.bind = (store) => { binds.push(store); return bind(store); };
  }
  const { sdk } = await sdkOver(wire, { barrier, observer: sendObserver, workflowEffectGate, ...(sdkDir ? { workspaceDir: sdkDir } : {}) });
  if (configureSdk) await configureSdk(sdk, workflowEffectGate);
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

// #796, as for a declared process flow (sdk-build-declared-bpf.test.js): through the whole CLI assembly, its attempt told the table was created by
// this invocation, a lag on the rule's identity read is read again in place within the build's one retry allowance, and once that is spent the
// build stops with the service's own answer in the words the CLI prints (dataverse-auth.js emitResult: redactOutput(err.message)).
test('a declared rule\'s identity read on a table this invocation created is read again in place; past the build\'s retries the printed stop quotes the service\'s answer (#796)', async () => {
  const { redactOutput } = require('../lib/output-redaction.js');
  const MESSAGE = "The entity with a name = 'new_ticket' with namemapping = 'Logical' was not found in the MetadataCache.LazyDynamicMetadataCache with version 1 and timestamp 1";
  const nameRead = (e) => e.method === 'GET' && e.path === 'workflows';
  await withRules(true, async () => {
    const cli = async (lags) => {
      const wire = createWorkflowWire();
      for (let i = 0; i < lags; i += 1) wire.script(nameRead, { statusCode: 400, body: { error: { code: '0x80041102', message: MESSAGE } } });
      const appDir = makeTempDir('declared-rule-');
      const dir = path.join(appDir, '.maker-workspace');
      fs.mkdirSync(dir);
      const barrier = createPublicationBarrier();
      const sendObserver = createAttemptSendObserver();
      const workflowEffectGate = createDeferredWorkflowGate();
      const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: clientOver(wire, { barrier, observer: sendObserver, workflowEffectGate }) });
      await sdk.initWorkspace();
      const events = [];
      let attempts = 0;
      let err;
      try {
        await buildModelApp(specWith([RULE]), { apply: true, env: ORIGIN, workspaceDir: dir, appDir, retryDelayMs: 0 }, {
          sdk, provisionSdk: sdk, publicationBarrier: barrier, sendObserver, workflowEffectGate, warn: () => {}, log: () => {},
          journal: { path: 'x', record: (e) => events.push(e), close: () => {} },
          runBuild: (s, o) => { attempts += 1; o.createdTables.add('new_ticket'); return runSdkBuild(s, { ...o, phases: ['business-rules'] }); },
        });
      } catch (e) { err = e; }
      return { err, attempts, retries: events.filter((e) => e.status === 'retry').length, workflowWrites: wire.log.filter((c) => c.method !== 'GET' && /^workflows/i.test(c.path)) };
    };
    const recovered = await cli(2);
    assert.equal(recovered.err, undefined, chainText(recovered.err));
    assert.equal(recovered.attempts, 1, 'one attempt: the read was made again where it failed');
    assert.equal(recovered.retries, 2);
    assert.equal(recovered.workflowWrites.filter((c) => /CreateProcessWithWfomJson/.test(c.path)).length, 1, 'created once');
    const spent = await cli(4);
    assert.ok(spent.err, 'the lag outlasts the three retries');
    assert.equal(spent.attempts, 1);
    assert.equal(spent.retries, 3);
    assert.deepEqual(spent.workflowWrites, [], 'nothing is sent for the rule');
    const printed = redactOutput(spent.err.message);
    assert.match(printed, /HTTP 400/, printed);
    assert.ok(printed.includes('0x80041102'), printed);
    assert.ok(printed.includes(MESSAGE), printed);
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
    // A real, current approval keeps the footer that offers it.
    assert.match(halt.message, /Fix the cause \(or give the approval named above\) and run the build again; it is not retried automatically\.$/);

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

test('a removed declared rule whose create answer was lost fences its table and name: the legacy path reads and creates nothing, even with the row not visible yet, and a late arrival leaves one rule', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    const isCreate = (e) => /CreateProcessWithWfomJson/.test(e.path);
    wire.script(isCreate, { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    const lost = await build(wire, dir, specWith([RULE]));
    assert.ok(lost.err, 'the lost create stops the run');
    assert.equal(wire.rows.size, 0, 'the create has not arrived');
    const original = wire.log.find(isCreate);
    const held = storeOf(dir).readGroup('rule', KEY);
    assert.ok(held.pending && typeof held.pending.root.id === 'string');
    // Undeclared under the same table and name, in the same case or another (the service compares names without case).
    for (const rules of [[legacy(RULE)], [{ ...legacy(RULE), name: RULE.name.toUpperCase() }]]) {
      const next = await build(wire, dir, specWith(rules));
      assert.equal(next.err && next.err.code, 'managed-not-settled', chainText(next.err));
      assert.match(chainText(next.err), /declared business rule "new_ticket\/Hide notes when closed": an earlier run's change of this rule is still waiting to be proved/);
      assert.deepEqual(next.writes, [], 'no legacy create beside the unproved one');
      assert.deepEqual(next.lines.filter((l) => /workflows/i.test(l) && !/EntityDefinitions/.test(l)), [], 'the table and name are not even read');
      assert.equal(wire.rows.size, 0);
    }
    // The first request arrives late: still one rule, the held one.
    await wire.request({ method: original.method, url: original.url, headers: original.headers, body: JSON.stringify(original.body) });
    assert.deepEqual([...wire.rows.keys()].map((k) => k.toLowerCase()), [held.pending.root.id.toLowerCase()]);
  });
});

// The SDK of an environment that cannot host business rules, refused before any request is sent.
const capabilityMissing = (sdk) => {
  sdk.executePrepared = async () => { throw Object.assign(new Error('business rule capability is unavailable before transport'), { code: 'BUSINESS_RULE_API_UNAVAILABLE' }); };
};

test('the capability-unavailable skip writes nothing, an adopted rule does not count as created, and the skip never hides a declared rule\'s outstanding write', async () => {
  await withRules(true, async () => {
    // Control: unavailable before transport, every declared rule is skipped and nothing is sent or bound.
    const clean = createWorkflowWire();
    const cdir = makeTempDir('declared-rule-');
    const c = await build(clean, cdir, specWith([RULE, LOCK]), { configureSdk: capabilityMissing });
    assert.equal(c.err, undefined, chainText(c.err));
    assert.deepEqual(c.writes, []);
    assert.equal(c.out.skipped.businessRules.length, 2);
    assert.equal(storeOf(cdir).readGroup('rule', KEY).committed, null);

    // A read-only adoption is not a create of this run, so the same answer for the next rule is the clean skip.
    const wire = createWorkflowWire();
    assert.equal((await build(wire, makeTempDir('declared-rule-'), specWith([legacy(RULE)]))).err, undefined);
    const adir = makeTempDir('declared-rule-');
    const adopted = await build(wire, adir, specWith([RULE, LOCK]), { authorizedAdoption: new Set([APPROVAL]), configureSdk: capabilityMissing });
    assert.equal(adopted.err, undefined, chainText(adopted.err));
    assert.deepEqual(adopted.out.skipped.businessRules, [`new_ticket|${LOCK.name}`]);
    assert.deepEqual(adopted.writes.filter((w) => /^workflows/i.test(w.path)), []);
    assert.equal(storeOf(adir).readGroup('rule', KEY).committed.records[0].origin, 'adopted');

    // A declared rule whose activation answer was lost is not a capability gap: the run ends incomplete and nothing is sent.
    const held = createWorkflowWire();
    const hdir = makeTempDir('declared-rule-');
    held.script((e) => e.method === 'PATCH', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    assert.ok((await build(held, hdir, specWith([LOCK]))).err);
    const next = await build(held, hdir, specWith([RULE, LOCK]), { configureSdk: capabilityMissing });
    assert.equal(next.err && next.err.code, 'managed-not-settled', chainText(next.err));
    assert.match(chainText(next.err), /declared business rule "Lock owner when closed" on new_ticket: an earlier run sent a change of this rule that is still waiting to be proved.*Nothing was sent for it/);
    assert.deepEqual(next.writes, []);
    const lock = storeOf(hdir).readGroup('rule', `new_ticket/${LOCK.name}`);
    assert.ok(lock.pending, 'the attempt is kept');
    assert.equal(held.row(lock.pending.root.id).statecode, 0, 'still Draft: not activated by a skipped run');
  });
});

test('a declared rule an earlier run sent is not counted as created by the run that recovers it', async () => {
  await withRules(true, async () => {
    const off = { statusCode: 400, body: { error: { code: '0x80040216', message: 'An unexpected error occurred.' } }, unapplied: true };
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    // The create is applied but its answer is lost: the next run recovers the row an earlier run sent, and creates nothing.
    wire.script((e) => /CreateProcess/.test(e.path), { error: 'socket hang up', code: 'ECONNRESET' });
    assert.ok((await build(wire, dir, specWith([RULE]))).err);
    wire.script((e) => /CreateProcess/.test(e.path), off);
    // With no acknowledged create it is bound only by the adoption approval, and binding it is not a create of this run.
    const next = await build(wire, dir, specWith([RULE, LOCK]), { authorizedAdoption: new Set([APPROVAL]) });
    assert.equal(next.err, undefined, chainText(next.err));
    assert.deepEqual(next.out.skipped.businessRules, [`new_ticket|${LOCK.name}`]);
    assert.equal(storeOf(dir).readGroup('rule', KEY).committed.records[0].origin, 'adopted');
    assert.equal(wire.rows.size, 1);

    // Its create answered, but the read that proves it failed: the next run proves and activates the row an earlier run
    // created, and that is not a create of this run either.
    const own = createWorkflowWire();
    const odir = makeTempDir('declared-rule-');
    let sentCreate = false;
    own.script((e) => { if (/CreateProcess/.test(e.path)) { sentCreate = true; return false; } return sentCreate && e.method === 'GET' && /workflows/i.test(e.path); }, { statusCode: 404, body: { error: { code: '0x80040217', message: 'Does Not Exist' } }, unapplied: true });
    const unproved = await build(own, odir, specWith([RULE]));
    assert.ok(unproved.err, 'the create is not proved in its own run');
    own.script((e) => /CreateProcess/.test(e.path), off);
    const recovered = await build(own, odir, specWith([RULE, LOCK]));
    assert.equal(recovered.err, undefined, chainText(recovered.err));
    assert.deepEqual(recovered.out.skipped.businessRules, [`new_ticket|${LOCK.name}`]);
    assert.equal(storeOf(odir).readGroup('rule', KEY).committed.records[0].origin, 'created');
    assert.equal(own.row(storeOf(odir).readGroup('rule', KEY).committed.root.id).statecode, 1);
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
      // The bound-id read verify makes of a group it does not hold as declared, and of a declared rule's presence and state:
      // workflow by workflowid, answered from the wire.
      queryRecords: async (table, o) => {
        const id = (/workflowid eq (\S+)/.exec((o && o.filter) || '') || [])[1];
        if (table === 'workflow' && id) { idReads.push(id); return wire.row(id) ? [{ workflowid: id, statecode: wire.row(id).statecode }] : []; }
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
    assert.deepEqual(blind.checks.filter((c) => c.kind === 'business-rule').map((c) => [c.name, c.present]), [['new_ticket.Hide notes when closed', true]], 'its presence and state are still read, by its bound id');
    await withRules(false, async () => {
      const before = ruleReads.length;
      idReads.length = 0;
      const off = await verifySpec(specWith([keyed]), read, { managedManifest: manifestOf(dir) });
      assert.deepEqual(ruleChecks(off).map((c) => [c.name, c.present, c.detail]), [[`hide-notes (${id})`, true, '']]);
      assert.equal(ruleReads.length, before, 'not read as a declared rule');
      assert.deepEqual(idReads, [id, id], 'held to its bound workflow id, and its presence and state read by that id, never by name');
    });
  });
});

test('verify reads a pending declared rule by its own id before any name lookup, so a namesake never passes for it', async () => {
  await withRules(true, async () => {
    const namesake = '77777777-7777-4777-8777-777777777777';
    const legacyChecks = (r) => r.checks.filter((c) => c.kind === 'business-rule').map((c) => [c.present, c.detail]);
    // The activation's answer was lost, so the Draft row is held; a maker renames it, and an Active rule takes its name.
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    wire.script((e) => e.method === 'PATCH', { error: 'socket hang up', code: 'ECONNRESET', unapplied: true });
    assert.ok((await build(wire, dir, specWith([RULE]))).err);
    const id = storeOf(dir).readGroup('rule', KEY).pending.root.id;
    const manifest = manifestOf(dir);
    assert.deepEqual(manifest.pending.map((p) => [p.family, p.key, p.root && p.root.id]), [['rule', KEY, id]], 'the pending entry carries the row its attempt holds');
    wire.rows.set(namesake, { ...wire.row(id), workflowid: namesake, statecode: 1, statuscode: 2 });
    wire.row(id).name = 'Renamed in Maker';
    const { sdk } = await sdkOver(wire);
    const { read } = await verifyReader(wire);
    const queries = [];
    read.queryRecords = async (table, o) => { queries.push(String((o && o.filter) || '')); return table === 'workflow' ? sdk.queryRecords(table, o) : []; };
    const pending = await verifySpec(specWith([RULE]), read, { managedManifest: manifest });
    assert.deepEqual(legacyChecks(pending), [[false, 'deployed but DRAFT — the rule does not run']], 'its own Draft row, not the Active namesake');
    assert.ok(queries.includes(`workflowid eq ${id}`), JSON.stringify(queries));
    assert.ok(!queries.some((q) => /\bname eq/.test(q)), 'never looked up by name');
    assert.ok(!pending.ok);

    // What cannot be read safely is unverified, never a pass and never a name read.
    const failing = { ...read, queryRecords: async () => { throw new Error('connection reset'); } };
    queries.length = 0;
    const out = await verifySpec(specWith([RULE]), failing, { managedManifest: manifest });
    assert.deepEqual(legacyChecks(out), []);
    assert.ok(out.unverified.some((u) => u.startsWith('business-rule:new_ticket.Hide notes when closed (') && /could not be read: connection reset/.test(u)), JSON.stringify(out.unverified));
    assert.ok(!out.ok);
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

// --- the platform's step renaming -------------------------------------------------------------------------------------------

// The platform renames every WFOM step on save (helpers/workflow-wire.js `renumberSteps`): a rule of every action shape, a
// recommendation's apply-action included, reads back under step names the build never sent. Build, rebuild, verify and the managed
// download all hold it to what it is, not to those names.
test('a rule of every action shape the platform stores under renamed steps is built once, verified, and restored by the managed download', async () => {
  await withRules(true, async () => {
    const rich = {
      ...RULE, name: 'Closed ticket rules', conditionLogic: 'OR',
      conditions: [RULE.conditions[0], { key: 'owned-by-ops', field: 'new_owner', operator: 'Equals', value: 'ops' }],
      actions: [
        RULE.actions[0],
        { key: 'lock-owner', type: 'LockUnlock', field: 'new_owner', lock: true },
        { key: 'need-subject', type: 'SetBusinessRequired', field: 'new_subject', required: true },
        { key: 'default-owner', type: 'SetDefaultValue', field: 'new_owner', value: 'ops' },
        { key: 'say', type: 'ShowErrorMessage', field: 'new_notes', errorMessage: 'Closed tickets need notes' },
        { key: 'rec', type: 'Recommendation', field: 'new_owner', recommendationTitle: 'Assign', messageText: 'Assign to ops', applyActions: [{ key: 'to-ops', field: 'new_owner', value: 'ops' }] },
      ],
    };
    const key = `new_ticket/${rich.name}`;
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    const first = await build(wire, dir, specWith([rich]));
    assert.equal(first.err, undefined, chainText(first.err));
    const id = storeOf(dir).readGroup('rule', key).committed.root.id;
    const create = first.writes.find((c) => /CreateProcessWithWfomJson$/.test(c.path));
    assert.notDeepEqual(stepNames(wire.row(id).wfom), stepNames(create.body.WfomJson), 'stored under names the build did not send');
    assert.equal(wire.row(id).statecode, 1);
    const again = await build(wire, dir, specWith([rich]));
    assert.equal(again.err, undefined, chainText(again.err));
    assert.deepEqual(again.writes.filter((c) => /^workflows/i.test(c.path)), [], 'the rebuild is a no-op');
    const { read } = await verifyReader(wire);
    assert.deepEqual(ruleChecks(await verifySpec(specWith([rich]), read, { managedManifest: manifestOf(dir) })).map((c) => [c.present, c.detail]), [[true, '']]);
    const restored = await download(wire, makeTempDir('declared-rule-'), ['--include-managed', '--managed-manifest', storeFileOf(dir)]);
    assert.deepEqual(restored.emitted[0].payload.managedRules, { restored: [key], stale: [] }, restored.said);
    assert.deepEqual(restored.written.businessRules, [rich]);
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

// --- a removed rule whose row is gone ----------------------------------------------------------------------------------------

const RETIRED = /^managed-root-retired: declared business rule "new_ticket\/Hide notes when closed": its row [0-9a-f-]{36} is gone \(a read by its exact id answered not found\) and the spec no longer declares it/;
const isStateChange = (e) => e.method === 'PATCH' && /^workflows\(/i.test(e.path);
const idReadOf = (id) => (e) => e.method === 'GET' && e.path.toLowerCase() === `workflows(${id})`;

for (const [how, refuse] of [
  ['answered 412 and was not applied', (wire) => wire.script(isStateChange, { statusCode: 412, body: { error: { code: '0x80060882', message: 'version mismatch' } }, unapplied: true })],
  ['met a row a maker saved after the run read it', (wire) => wire.advance(isStateChange)],
]) {
  test(`a removed rule whose activation ${how} is held while its row is there, and retired with a notice once a fresh read by its id answers not found`, async () => {
    await withRules(true, async () => {
      const wire = createWorkflowWire();
      const dir = makeTempDir('declared-rule-');
      refuse(wire);
      assert.ok((await build(wire, dir, specWith([RULE]))).err, 'the refused activation stops the run');
      const held = storeOf(dir).readGroup('rule', KEY);
      const id = held.pending.root.id;
      assert.deepEqual(held.effects.map((e) => [e.effect, e.state]), [['create', 'confirmed'], ['state', 'definitely-unsent']]);

      const present = await build(wire, dir, specWith([]));
      assert.equal(present.err && present.err.code, 'managed-not-settled', chainText(present.err));
      assert.match(chainText(present.err), /it is not retired: its row is still there/);
      assert.deepEqual(present.writes, []);

      wire.rows.delete(id);
      // Gone, but a refusal proves nothing: held, nothing written.
      wire.script(idReadOf(id), { statusCode: 403, body: { error: { code: '0x80040220', message: 'Principal user is missing prvReadWorkflow privilege' } } });
      const refused = await build(wire, dir, specWith([]));
      assert.equal(refused.err && refused.err.code, 'managed-not-settled', chainText(refused.err));
      assert.match(chainText(refused.err), /it is not retired: its row could not be read \(HTTP 403/);
      assert.deepEqual(refused.writes, []);
      assert.ok(storeOf(dir).readGroup('rule', KEY).pending, 'still pending');

      const retired = await build(wire, dir, specWith([]));
      assert.equal(retired.err, undefined, chainText(retired.err));
      assert.deepEqual(retired.writes, []);
      assert.match(retired.warnings.join('\n'), RETIRED);
      assert.doesNotMatch(retired.warnings.join('\n'), /\bactivated\b/, 'the notice never claims an activation');
      assert.deepEqual(storeOf(dir).readGroup('rule', KEY), { committed: null, pending: null, effects: [] });
      const entry = storeOf(dir).snapshot().envelope.retiredGroups.at(-1);
      assert.deepEqual([entry.family, entry.key, entry.generation, entry.rootId], ['rule', KEY, null, id]);
      assert.equal((await build(wire, dir, specWith([]))).err, undefined, 'and stays retired');
    });
  });
}

test('a committed rule the spec no longer declares is retired once its row is proved gone, so verify stops checking it; while its row is there it stays', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    assert.equal((await build(wire, dir, specWith([RULE]))).err, undefined);
    const id = storeOf(dir).readGroup('rule', KEY).committed.root.id;
    const present = await build(wire, dir, specWith([]));
    assert.equal(present.err, undefined);
    assert.deepEqual(present.warnings, []);
    assert.ok(storeOf(dir).readGroup('rule', KEY).committed, 'still managed');

    wire.rows.delete(id);
    const { read } = await verifyReader(wire);
    assert.equal((await verifySpec({}, read, { managedManifest: manifestOf(dir) })).ok, false, 'verify checks the row it is bound to');
    const retired = await build(wire, dir, specWith([]));
    assert.equal(retired.err, undefined, chainText(retired.err));
    assert.deepEqual(retired.writes, []);
    assert.match(retired.warnings.join('\n'), RETIRED);
    const verified = await verifySpec({}, read, { managedManifest: manifestOf(dir) });
    assert.equal(verified.ok, true, JSON.stringify(verified.checks));
  });
});

// The store's observation is taken BEFORE the row is read. Another run that counts a send of the removed rule's attempt while that
// read is on the wire may put the row back after the 404; every effect is still settled and the create confirmed, so only the
// observation refuses the retirement. Nothing is written, the attempt is kept, and this run cannot confirm the retirement.
test('a removed rule whose attempt another run counts a send for while its row is read is not retired by that read', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    wire.script(isStateChange, { statusCode: 412, body: { error: { code: '0x80060882', message: 'version mismatch' } }, unapplied: true });
    assert.ok((await build(wire, dir, specWith([RULE]))).err);
    const held = storeOf(dir).readGroup('rule', KEY);
    const id = held.pending.root.id;
    wire.rows.delete(id);
    let raced = false;
    wire.script((e) => {
      if (!raced && idReadOf(id)(e)) { raced = true; storeOf(dir).noteAttemptDispatch(held.pending.token); }
      return false;
    }, null);
    const res = await build(wire, dir, specWith([]));
    assert.equal(raced, true);
    assert.equal(res.err && res.err.code, 'managed-not-settled', chainText(res.err));
    assert.match(chainText(res.err), /its retirement could not be confirmed \(the binding store did not confirm the retirement \(managed-binding-generation-conflict: .*changed since it was observed.*keeps its row, table and name held, and the next invocation rereads the durable result/);
    assert.deepEqual(res.writes, []);
    assert.doesNotMatch(res.warnings.join('\n'), RETIRED);
    assert.equal((storeOf(dir).snapshot().envelope.retiredGroups || []).length, 0);
    assert.equal(storeOf(dir).readGroup('rule', KEY).pending.token, held.pending.token, 'the attempt is kept');
  });
});

test('a removed rule whose create never reached the transport is only noted: no read of its row, nothing written, and the run goes on', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    const denied = await build(wire, dir, specWith([RULE]), {
      configureSdk: (sdk) => { sdk.executePrepared = async () => { throw Object.assign(new Error('rule operation failed before transport'), { code: 'ECONNREFUSED' }); }; },
    });
    assert.ok(denied.err);
    assert.deepEqual(denied.writes, []);
    const stored = storeOf(dir).readGroup('rule', KEY);
    assert.ok(stored.pending && stored.effects.every((e) => e.state === 'definitely-unsent'), JSON.stringify(stored.effects));
    const removed = await build(wire, dir, specWith([]));
    assert.equal(removed.err, undefined, chainText(removed.err));
    assert.deepEqual(removed.writes, []);
    assert.deepEqual(removed.lines.filter((l) => /workflows/i.test(l)), [], 'nothing sent, so nothing to read');
    assert.match(removed.warnings.join('\n'), /declared business rule "new_ticket\/Hide notes when closed": an earlier run prepared it and sent nothing/);
    assert.doesNotMatch(removed.warnings.join('\n'), RETIRED);
  });
});

// A refused retirement leaves this run's cached store from before the race. Another run that, while this run's exact read is on
// the wire, retires the committed rule and prepares a fresh create of it (a new row id, the same table and name) must still find
// that table and name held in this run: a legacy rule of the same name reads and creates nothing beside the other run's create.
test('a removed rule whose retirement could not be confirmed keeps its table and name held: a legacy rule of the same name creates nothing', async () => {
  await withRules(true, async () => {
    const wire = createWorkflowWire();
    const dir = makeTempDir('declared-rule-');
    assert.equal((await build(wire, dir, specWith([RULE]))).err, undefined);
    const committed = storeOf(dir).readGroup('rule', KEY).committed;
    const id = committed.root.id;
    wire.rows.delete(id);
    let raced = false;
    wire.script((e) => {
      if (!raced && idReadOf(id)(e)) {
        raced = true;
        const other = storeOf(dir);
        const { observation } = other.observeRetirement({ family: 'rule', key: KEY });
        other.retireAbsentGroup({ family: 'rule', key: KEY, generation: committed.generation, rootId: id, evidence: { kind: 'root-absent', rootId: id, row: 'not-found' }, observation });
        other.prepareAttempt({ family: 'rule', key: KEY, baseGeneration: null, root: { ...committed.root, id: '99999999-9999-4999-8999-999999999999' }, knownScopes: [], declarationSha256: 'a'.repeat(64), declaration: committed.originalDeclaration });
      }
      return false;
    }, null);
    const res = await build(wire, dir, specWith([legacy(RULE)]));
    assert.equal(raced, true);
    assert.equal(res.err && res.err.code, 'managed-not-settled', chainText(res.err));
    assert.match(chainText(res.err), /its retirement could not be confirmed .*keeps its row, table and name held/);
    assert.deepEqual(res.writes, [], 'no legacy create beside the other run\'s');
    assert.deepEqual(res.lines.filter((l) => /\bname eq\b/i.test(decodeURIComponent(l))), [], 'not even read by name');
  });

});
// --- a key declared again after its root was retired -------------------------------------------------------------------------

// A business rule made by a build, then deleted and retired by a build without its declaration, so the store's key has a new
// incarnation and the old id is the retired one. `retainSdk`: every build keeps the SDK's workspace in `dir` (answered as `sdk`,
// the options that keep it for later builds), so it still holds its synced copy of the retired row.
async function retiredRule({ retainSdk = false } = {}) {
  const wire = createWorkflowWire();
  const dir = makeTempDir('declared-rule-');
  const sdk = retainSdk ? { sdkDir: dir } : {};
  assert.equal((await build(wire, dir, specWith([RULE]), sdk)).err, undefined);
  const old = JSON.parse(JSON.stringify(storeOf(dir).readGroup('rule', KEY).committed));
  wire.rows.delete(old.root.id);
  const retired = await build(wire, dir, specWith([]), sdk);
  assert.equal(retired.err, undefined, chainText(retired.err));
  assert.match(retired.warnings.join('\n'), RETIRED);
  // Read from the envelope, not incarnations(), so a build without incarnations fails on what it sends, not on an accessor.
  const reborn = (storeOf(dir).snapshot().envelope.incarnations || []).find((x) => x.family === 'rule' && x.key === KEY) || {};
  return { wire, dir, old, reborn: reborn.rootId, sdk };
}
// Whether the SDK workspace kept in `dir` (sdkOver `workspaceDir`) still lists the artifact `id` in its manifest.
const sdkHolds = (dir, id) => fs.existsSync(path.join(dir, 'manifest.json')) && fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').toLowerCase().includes(id);
const createdIdsOf = (r) => r.writes.filter((c) => /CreateProcess/.test(c.path)).map((c) => String(c.body.Entity.workflowid).toLowerCase());

for (const fresh of [false, true]) {
  test(`a declared business rule declared again after its root was retired is created under a fresh id, never the retired one, and the next build is write-free (${fresh ? 'a fresh' : 'the same'} workspace)`, async () => {
    await withRules(true, async () => {
      // The SDK's workspace is the build workspace throughout: the same one keeps it (and its synced copy of the retired
      // row) through the create, the retirement and the new declaration; a fresh one is a new directory with only the store.
      const { wire, dir, old, reborn } = await retiredRule({ retainSdk: true });
      const ws = fresh ? makeTempDir('declared-rule-') : dir;
      if (fresh) fs.copyFileSync(storeFileOf(dir), storeFileOf(ws));
      assert.equal(sdkHolds(ws, old.root.id), !fresh, 'the same workspace still holds the SDK\'s copy of the retired row; a fresh one holds none');
      const first = await build(wire, ws, specWith([RULE]), { sdkDir: ws });
      assert.equal(first.err, undefined, chainText(first.err));
      assert.ok(!createdIdsOf(first).includes(old.root.id), 'the retired id is never created again');
      assert.deepEqual(createdIdsOf(first), [reborn], 'one create, under the incarnation');
      assert.ok(!JSON.stringify(first.writes).toLowerCase().includes(old.root.id), 'no write names the retired id');
      const bound = storeOf(ws).readGroup('rule', KEY).committed;
      assert.equal(bound.root.id, reborn);
      assert.equal(wire.row(reborn).statecode, 1);
      const oldIds = new Set(old.records.map((r) => String(r.id).toLowerCase()));
      assert.deepEqual(bound.records.map((r) => String(r.id).toLowerCase()).filter((id) => oldIds.has(id)), [], 'every id is derived under the new root');
      const second = await build(wire, ws, specWith([RULE]), { sdkDir: ws });
      assert.equal(second.err, undefined, chainText(second.err));
      assert.deepEqual(second.writes.filter((c) => /^workflows/i.test(c.path)), []);
    });
  });
}

test('a declared business rule declared again after retirement keeps its incarnation through a lost create answer: the landed row is bound under it with the approval, the unlanded one is held, never sent under a second id', async () => {
  await withRules(true, async () => {
    // Both SDK workspace lifetimes: a new one per build, and the build workspace kept throughout.
    for (const [applied, retainSdk] of [[false, false], [true, false], [false, true], [true, true]]) {
      const { wire, dir, old, reborn, sdk } = await retiredRule({ retainSdk });
      wire.script((e) => /CreateProcess/.test(e.path), { error: 'socket hang up', code: 'ECONNRESET', ...(applied ? {} : { unapplied: true }) });
      const lost = await build(wire, dir, specWith([RULE]), sdk);
      assert.ok(lost.err, `applied=${applied}: the lost answer stops the build`);
      assert.ok(!createdIdsOf(lost).includes(old.root.id), 'the retired id is never created again');
      assert.deepEqual(createdIdsOf(lost), [reborn]);
      assert.equal(storeOf(dir).readGroup('rule', KEY).pending.root.id, reborn, 'the attempt holds the incarnation');
      const next = await build(wire, dir, specWith([RULE]), { ...sdk, ...(applied ? { authorizedAdoption: new Set([APPROVAL]) } : {}) });
      assert.deepEqual(createdIdsOf(next), [], `applied=${applied}: never sent again`);
      if (applied) {
        assert.equal(next.err, undefined, chainText(next.err));
        assert.equal(storeOf(dir).readGroup('rule', KEY).committed.root.id, reborn);
      } else {
        assert.match(chainText(next.err), /managed-settlement-pending/);
        assert.equal(storeOf(dir).readGroup('rule', KEY).pending.root.id, reborn, 'still the incarnation, not a new id');
      }
      assert.ok(!JSON.stringify([lost.writes, next.writes]).toLowerCase().includes(old.root.id));
    }
  });
});
// The catalog selects an incarnation by its canonical identity too: a declaration whose name differs from the retired one
// only by case is the same artifact to the identity algorithm (and to Dataverse), so it takes the retired key's
// incarnation, never the retired stable id, in a retained SDK workspace that still holds the retired row's copy.
test('a declared business rule declared again after retirement under a case-only change of its name is created under the incarnation, never the retired id', async () => {
  await withRules(true, async () => {
    const { wire, dir, old, reborn, sdk } = await retiredRule({ retainSdk: true });
    const changed = { ...JSON.parse(JSON.stringify(RULE)), name: RULE.name.toUpperCase() };
    const first = await build(wire, dir, specWith([changed]), sdk);
    assert.equal(first.err, undefined, chainText(first.err));
    assert.deepEqual(createdIdsOf(first), [reborn], 'one create, under the incarnation of the same identity');
    assert.ok(!JSON.stringify(first.writes).toLowerCase().includes(old.root.id), 'no write names the retired id');
    const second = await build(wire, dir, specWith([changed]), sdk);
    assert.equal(second.err, undefined, chainText(second.err));
    assert.deepEqual(second.writes.filter((c) => /^workflows/i.test(c.path)), []);
  });
});