'use strict';
// The create port with stable identities (lib/creates-port.js): the plain pass-through's call shape, with ids allocated from the
// plan's intents for protected kinds only. These tests pin what the port may and may not conclude from one execute.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCreatesPort, createCreatesPortForSpec, primaryDispatchEvidence } = require('../lib/creates-port.js');
const { createPassthroughCreates } = require('../lib/creates-passthrough.js');
const { intentFor, capabilityFor, allocates, kindAliasOf, DESCRIPTORS } = require('../lib/creates-capabilities.js');
const { stableCreateIdV1 } = require('../lib/creates-identity.js');

const SOL = { kind: 'solution', solution: 'contosocore' };
const TABLE = { kind: 'table', solution: 'contosocore', table: 'contoso_order' };
const profile = intentFor('fieldSecurityProfile', {
  key: 'pii', scope: SOL, declaration: { key: 'pii' },
  children: [
    { locator: 'contoso_order.contoso_ssn', childKind: 'fieldPermission', declaration: { table: 'contoso_order', column: 'contoso_ssn' } },
    { locator: 'contoso_order.contoso_dob', childKind: 'fieldPermission', declaration: { table: 'contoso_order', column: 'contoso_dob' } },
  ],
});
const view = intentFor('view', { key: 'contoso_order|active', scope: TABLE, declaration: { queryType: 0, name: 'Active' } });
const chart = intentFor('chart', { key: 'contoso_order|by owner', scope: TABLE, declaration: { name: 'By owner' } });
const VIEW_ID = stableCreateIdV1({ scope: TABLE, kind: 'view', keyParts: view.keyParts });
const CHILD_KEYS = ['contoso_order.contoso_ssn', 'contoso_order.contoso_dob'];
const stable = (extra = {}) => createCreatesPort({ mode: 'stable', protectedKinds: ['view', 'chart', 'appTheme'], intents: [view, chart], ...extra });
const codeOf = async (p) => { try { await p; } catch (e) { return e.code; } return 'resolved'; };

test('a protected create is sent with the derived ids, exactly once, and a saved answer at that id is created', async () => {
  const port = stable();
  const calls = [];
  const out = await port.run({ kind: 'view', key: 'contoso_order|active', identity: { name: 'Active' } }, async (ids) => {
    calls.push(ids);
    return { type: 'view', id: ids.id.toUpperCase(), saved: true };
  });
  assert.deepStrictEqual(calls, [{ id: VIEW_ID, childIds: {} }]);
  assert.strictEqual(out.outcome, 'created');
  assert.strictEqual(out.evidence, 'sdk-acknowledged');
  assert.strictEqual(out.id, VIEW_ID);
  assert.deepStrictEqual(out.ids, { id: out.id, childIds: out.childIds });
  // A second port (a new process, a rerun) allocates the same id: nothing was recorded.
  const again = await stable().run({ kind: 'view', key: 'contoso_order|active' }, async (ids) => ({ id: ids.id, saved: true }));
  assert.strictEqual(again.id, VIEW_ID);
  assert.strictEqual(port.identityFor('view', 'contoso_order|active').id, VIEW_ID);
});

test('preparatory reads inside execute work, and their failure is rethrown as the same object with the attempted ids', async () => {
  const port = stable();
  const reads = [];
  await port.run({ kind: 'view', key: 'contoso_order|active' }, async ({ id }) => { reads.push('GET'); return { id, saved: true }; });
  assert.deepStrictEqual(reads, ['GET']);
  const boom = Object.assign(new Error('read failed'), { code: 'HTTP_503', transient: true });
  let caught;
  try { await port.run({ kind: 'view', key: 'contoso_order|active' }, async () => { throw boom; }); } catch (e) { caught = e; }
  assert.strictEqual(caught, boom, 'the error keeps its identity, code and retry signal');
  assert.strictEqual(caught.transient, true);
  assert.strictEqual(caught.createAttempt.id, port.identityFor('view', 'contoso_order|active').id);
  assert.strictEqual(caught.createAttempt.evidence, null, 'a failed preparatory read is not evidence the create was sent');
  assert.ok(!Object.keys(caught).includes('createAttempt'), 'the annotation is not enumerable (envelopes and logs are unchanged)');
});

test('an empty, malformed or foreign answer never becomes a create', async () => {
  for (const answer of [undefined, null, 'ok', { saved: true }, { id: 'nope', saved: true }]) {
    assert.strictEqual(await codeOf(stable().run({ kind: 'chart', key: 'contoso_order|by owner' }, async () => answer)), 'create-identity-unverified', JSON.stringify(answer));
  }
  assert.strictEqual(await codeOf(stable().run({ kind: 'chart', key: 'contoso_order|by owner' }, async () => ({ id: '0f0f0f0f-1111-4222-8333-444444444444', saved: true }))), 'create-identity-conflict');
  assert.strictEqual(await codeOf(stable().run({ kind: 'chart', key: 'contoso_order|by owner' }, async ({ id }) => ({ id }))), 'create-identity-unverified', 'neither saved nor adopted');
});

test('a by-value failure is thrown as its own error, annotated; ARTIFACT_ALREADY_EXISTS is evidence of dispatch', async () => {
  const port = stable();
  const already = Object.assign(new Error('a record with matching key values already exists'), { code: 'ARTIFACT_ALREADY_EXISTS' });
  let caught;
  let calls = 0;
  try {
    await port.run({ kind: 'chart', key: 'contoso_order|by owner' }, async ({ id }) => { calls += 1; return { type: 'chart', id, saved: false, error: already }; });
  } catch (e) { caught = e; }
  assert.strictEqual(calls, 1, 'the port never sends again');
  assert.strictEqual(caught, already);
  assert.strictEqual(caught.createAttempt.evidence, 'already-exists');
  assert.strictEqual(caught.createAttempt.id, port.identityFor('chart', 'contoso_order|by owner').id);
  // A thrown wrapper whose cause is the collision is the same evidence.
  assert.strictEqual(primaryDispatchEvidence(new Error('push failed', { cause: already })), 'already-exists');
  // An answer the HTTP client marked as following an earlier ambiguous send of the same request.
  const body = {};
  Object.defineProperty(body, Symbol.for('power-platform-skills.http-send-history'), { value: { sends: 2, earlierAmbiguous: true } });
  assert.strictEqual(primaryDispatchEvidence(Object.assign(new Error('500'), { body })), 'ambiguous-dispatch');
  assert.strictEqual(primaryDispatchEvidence(Object.assign(new Error('400'), { code: 'VALIDATION' })), null);
});

test('adoption is a match, never a creation — and only where the SDK adopts natively', async () => {
  const out = await stable().run({ kind: 'view', key: 'contoso_order|active' }, async ({ id }) => ({ id, saved: false, adoptedExisting: true }));
  assert.strictEqual(out.outcome, 'matched');
  assert.strictEqual(out.evidence, 'sdk-adopted-exact');
  assert.strictEqual(await codeOf(stable().run({ kind: 'chart', key: 'contoso_order|by owner' }, async ({ id }) => ({ id, saved: false, adoptedExisting: true }))), 'create-identity-conflict');
  // An adoption with an error beside it is a failure, as the build's pushFailed reads it.
  const err = new Error('x');
  let caught;
  try { await stable().run({ kind: 'view', key: 'contoso_order|active' }, async ({ id }) => ({ id, saved: false, adoptedExisting: true, error: err })); } catch (e) { caught = e; }
  assert.strictEqual(caught, err);
});

test('a protected create has no children, and the kind and key must be planned, before anything runs', async () => {
  let ran = 0;
  const exec = async ({ id }) => { ran += 1; return { id, saved: true }; };
  assert.strictEqual(await codeOf(stable().run({ kind: 'view', key: 'contoso_order|active', childKeys: ['x'] }, exec)), 'create-identity-invalid', 'a child of a single-row kind');
  assert.strictEqual(await codeOf(stable().run({ kind: 'view', key: 'other' }, exec)), 'create-identity-invalid', 'an unplanned key');
  assert.strictEqual(ran, 0);
  assert.strictEqual(await codeOf(Promise.resolve().then(() => createCreatesPort({ mode: 'stable', protectedKinds: ['nonsense'] }))), 'create-identity-unsupported');
  for (const gated of ['app', 'appaction', 'businessRule', 'bpf', 'genPage', 'securityRole', 'table']) {
    assert.strictEqual(await codeOf(Promise.resolve().then(() => createCreatesPort({ mode: 'stable', protectedKinds: [gated] }))), 'create-identity-unsupported', gated);
  }
  // Two intents that would be one row are refused when the plan is read.
  const twin = intentFor('view', { key: 'other-key', scope: TABLE, declaration: { queryType: 0, name: 'ACTIVE' } });
  assert.strictEqual(await codeOf(Promise.resolve().then(() => createCreatesPort({ mode: 'stable', protectedKinds: ['view'], intents: [view, twin] }))), 'create-identity-invalid');
});

// --- no kind whose create writes child rows is protected in this release -----------------------------------------------------------
// A parent's binding is not authority over a row at a child's derived id: a protected rerun could rewrite a child a maker made and
// report it created. So every kind with child rows (and every other gated kind) is refused wherever protection could be turned on,
// and keeps the plain create path — random ids, one call — on the stable port the build hands its phases.
const PROTECTED_KINDS = ['chart', 'connectionReference', 'view'];
// Listed, not derived from the descriptors: each kind keeps its own test even if its gate is lost.
const GATED = ['app', 'appaction', 'bpf', 'businessRule', 'customApi', 'dashboard', 'duplicateRule', 'environmentVariable', 'fieldSecurityProfile', 'form', 'genPage'];

test('the protected kinds are exactly the single-row kinds; every kind with child rows is gated', () => {
  assert.deepStrictEqual(Object.keys(DESCRIPTORS).filter(allocates).sort(), PROTECTED_KINDS);
  for (const kind of PROTECTED_KINDS) assert.deepStrictEqual([DESCRIPTORS[kind].aggregate, DESCRIPTORS[kind].children], [false, undefined], kind);
  assert.deepStrictEqual(Object.keys(DESCRIPTORS).filter((k) => DESCRIPTORS[k].class === 'C' && !allocates(k)).sort(), GATED);
  for (const kind of GATED) assert.match(DESCRIPTORS[kind].gate, /\S/, `${kind} says why it is gated`);
});

const GATED_SPEC = {
  createIdentity: 'stable-v1', solution: { uniqueName: 'ContosoCore' },
  views: [{ entity: 'contoso_order', name: 'Active' }], charts: [{ entity: 'contoso_order', name: 'By owner', chartType: 'column', groupBy: 'ownerid' }],
  forms: [{ entity: 'contoso_order', name: 'Order' }], dashboards: [{ name: 'Orders' }],
  fieldSecurityProfiles: [{ key: 'pii', name: 'PII', permissions: [{ table: 'contoso_order', column: 'contoso_ssn' }] }],
};
const childKindsOf = (kind) => Object.keys(DESCRIPTORS[kind].children || {});

for (const kind of GATED) {
  test(`${kind} is gated: protection cannot be turned on, and it keeps the plain create path with nothing protected`, async () => {
    const refused = (e) => e.code === 'create-identity-unsupported' && e.message.includes(kind);
    // Refused activation: the port, the spec's port (as a shipped or a feature kind, with or without createIdentity) and the plan.
    assert.throws(() => createCreatesPort({ mode: 'stable', protectedKinds: ['view', kind], intents: [view] }), refused);
    for (const spec of [GATED_SPEC, { solution: GATED_SPEC.solution }]) {
      assert.throws(() => createCreatesPortForSpec(spec, { intents: [view], shippedKinds: ['view', kind] }), refused);
      assert.throws(() => createCreatesPortForSpec(spec, { intents: [], featureKinds: [kind] }), refused);
    }
    // The legacy path on the stable port the build would hand its phases: random ids, one call each, nothing protected or identified.
    let n = 0;
    const port = createCreatesPortForSpec(GATED_SPEC, { intents: [view, chart], shippedKinds: ['view', 'chart'], newId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}` });
    assert.strictEqual(port.mode, 'stable');
    for (const k of [kind, ...childKindsOf(kind)]) {
      assert.strictEqual(port.protects(k), false, k);
      assert.strictEqual(port.identityFor(k, 'k'), null, k);
      const calls = [];
      const exec = async (ids) => { calls.push(ids); return { id: ids.id, saved: true }; };
      const first = await port.run({ kind: k, key: 'k', identity: { parentKind: kind, parentKey: 'k', slot: 's' } }, exec);
      const second = await port.run({ kind: k, key: 'k' }, exec);
      assert.strictEqual(calls.length, 2, k);
      assert.notStrictEqual(first.id, second.id, `${k}: a fresh id each time, as before`);
      assert.strictEqual(first.evidence, undefined, `${k}: the plain pass-through answer`);
      const err = new Error('x');
      await assert.rejects(port.run({ kind: k, key: 'k' }, async () => { throw err; }), (e) => e === err && e.createAttempt === undefined);
    }
  });
}

test('an unprotected kind on a stable port is the plain pass-through, unchanged', async () => {
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-00000000000${n++}`;
  const port = stable({ newId });
  const err = new Error('x');
  const out = await port.run({ kind: 'dashboard', key: 'd', childKeys: ['a'] }, async (ids) => ({ got: ids }));
  const id = '00000000-0000-4000-8000-000000000000';
  const childIds = { a: '00000000-0000-4000-8000-000000000001' };
  assert.deepStrictEqual(out, { outcome: 'created', id, childIds, ids: { id, childIds }, result: { got: { id, childIds } } });
  await assert.rejects(port.run({ kind: 'dashboard', key: 'd' }, async () => { throw err; }), (e) => e === err && e.createAttempt === undefined);
  assert.strictEqual(port.protects('dashboard'), false);
  assert.strictEqual(port.identityFor('dashboard', 'd'), null);
});

test('the theme setter runs once, answers applied with no ids and no receipt, and an unknown outcome is never re-sent', async () => {
  let calls = 0;
  const out = await stable().run({ kind: 'appTheme', key: 'app' }, async (ids) => {
    calls += 1;
    assert.deepStrictEqual(ids, { id: null, childIds: {} });
    return { outcome: 'updated', published: true, appId: '0f0f0f0f-1111-4222-8333-444444444444', webResourceId: '0f0f0f0f-1111-4222-8333-555555555555' };
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(out.outcome, 'applied');
  assert.strictEqual(out.id, null);
  assert.deepStrictEqual(out.result, { outcome: 'updated', published: true }, 'the ids in the SDK answer are not projected');
  calls = 0;
  assert.strictEqual(await codeOf(stable().run({ kind: 'appTheme', key: 'app' }, async () => { calls += 1; return undefined; })), 'create-outcome-unknown');
  assert.strictEqual(calls, 1);
});

test('passthrough mode is the plain pass-through, call for call', async () => {
  let a = 0;
  let b = 0;
  const ours = createCreatesPort({ mode: 'passthrough', newId: () => `id-${a++}` });
  const plain = createPassthroughCreates({ newId: () => `id-${b++}` });
  const exec = async (ids) => ({ sent: ids });
  assert.deepStrictEqual(await ours.run({ kind: 'fieldSecurityProfile', key: 'pii', childKeys: CHILD_KEYS }, exec), await plain.run({ kind: 'fieldSecurityProfile', key: 'pii', childKeys: CHILD_KEYS }, exec));
  assert.strictEqual(ours.run, ours.run);
  assert.strictEqual(ours.protects('fieldSecurityProfile'), false);
  await assert.rejects(ours.run({ kind: '', key: 'x' }, exec), TypeError);
});

test('the spec decides the mode: no createIdentity and no new feature intents is the pass-through', () => {
  const reference = intentFor('connectionReference', { key: 'contoso_sharepoint', scope: SOL, declaration: { logicalName: 'contoso_sharepoint' } });
  assert.strictEqual(createCreatesPortForSpec({}, { shippedKinds: ['view', 'chart'] }).mode, 'passthrough');
  assert.strictEqual(createCreatesPortForSpec({}, { shippedKinds: ['view'], intents: [view], featureKinds: ['connectionReference'] }).mode, 'passthrough', 'a feature kind with no declaration in this spec');
  const feature = createCreatesPortForSpec({}, { intents: [reference], featureKinds: ['connectionReference'], shippedKinds: ['view'] });
  assert.strictEqual(feature.mode, 'stable');
  assert.deepStrictEqual(['connectionReference', 'view'].map(feature.protects), [true, false], 'a new feature is protected; legacy kinds stay legacy');
  const on = createCreatesPortForSpec({ createIdentity: 'stable-v1' }, { intents: [view, chart], shippedKinds: ['view', 'chart'] });
  assert.deepStrictEqual(['view', 'chart', 'form'].map(on.protects), [true, true, false]);
  assert.throws(() => createCreatesPortForSpec({ createIdentity: true }), (e) => e.code === 'create-identity-invalid');
  // A field security profile (a profile with permission rows) cannot be a feature kind in this release.
  assert.throws(() => createCreatesPortForSpec({}, { intents: [profile], featureKinds: ['fieldSecurityProfile'] }), (e) => e.code === 'create-identity-unsupported');
});

// --- no regression: a default build cannot reach any of this ---------------------------------------------------------------------
// Walks the build's relative require graph from its entry points. The port is wired in at exactly two edges: the engine requires
// creates-stable-build.js inside the branch a spec with createIdentity takes, and creates-catalog.js inside the settlement of a
// declared form (forms[].reconcile "declared"), a declared dashboard (dashboards[].reconcile "declared"), a declared business rule
// (businessRules[].reconcile "declared") or a declared process flow (businessProcessFlows[].reconcile "declared"), the only places a build without createIdentity takes ids from a catalog. The business-rule
// helper (rule-settlement.js) loads the catalog itself, so the engine's, the spec gate's and the rule reader's (declared-rule-io.js,
// for verify and the managed download) requires of it are gated edges too. The process-flow helper (bpf-settlement.js) does the same,
// so the engine's, the spec gate's and the flow reader's (declared-bpf-io.js) requires of it are gated edges as well. The
// dashboard helper (dashboard-reconcile.js) derives its seed cell ids with creates-identity.js only on a declared dashboard's
// create, and its workspace scope (dashboard-recovery-workspace.js) reads a retained create copy with creates-local.js only for
// a declared dashboard; each through one lazy accessor, so those edges are gated too. Verify (verify-model-app.js, which the
// build requires for its inline --verify) requires configuration-protected.js only for an App Spec with configurationIdentity,
// so that edge is gated as well. The build command requires managed-create-transport.js only to make (and compose) the managed create
// gate of an apply where protected configuration is in play (sdk-build.js protectedConfigurationInPlay), and the engine requires the
// configuration hookup's modules only inside protectedConfigurationFor, which it calls only once that gate exists; those edges are gated
// too. Apart
// from those gated edges the default build must load none of the new modules, and must still hand the engine the plain pass-through.
const GATED_EDGES = [['sdk-build.js', 'creates-stable-build.js'], ['sdk-build.js', 'creates-catalog.js'], ['sdk-build.js', 'rule-settlement.js'], ['app-spec.js', 'rule-settlement.js'], ['declared-rule-io.js', 'rule-settlement.js'], ['sdk-build.js', 'bpf-settlement.js'], ['app-spec.js', 'bpf-settlement.js'], ['declared-bpf-io.js', 'bpf-settlement.js'], ['dashboard-reconcile.js', 'creates-identity.js'], ['dashboard-recovery-workspace.js', 'creates-local.js'], ['verify-model-app.js', 'configuration-protected.js'],
  ['build-model-app.js', 'managed-create-transport.js'], ['sdk-build.js', 'managed-create-context.js'], ['sdk-build.js', 'configuration-create-bindings.js'], ['sdk-build.js', 'configuration-protected.js']];
const SCRIPTS = path.join(__dirname, '..');
const NEW_MODULES = ['creates-identity.js', 'creates-capabilities.js', 'creates-port.js', 'creates-catalog.js'].map((f) => path.join(SCRIPTS, 'lib', f));
function requireGraph(entry, { gated = false } = {}) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) {
      let target = path.resolve(path.dirname(file), m[2]);
      if (!fs.existsSync(target) && fs.existsSync(`${target}.js`)) target = `${target}.js`;
      if (gated && GATED_EDGES.some(([from, to]) => path.basename(file) === from && path.basename(target) === to)) continue;
      if (/\.js$/.test(target) && fs.existsSync(target) && !target.includes(`${path.sep}vendor${path.sep}`)) stack.push(target);
    }
  }
  return seen;
}

test('the default build loads none of the stable-identity modules and still wires the plain pass-through', () => {
  const graph = requireGraph(path.join(SCRIPTS, 'build-model-app.js'), { gated: true });
  assert.ok(graph.has(path.join(SCRIPTS, 'lib', 'sdk-build.js')), 'the walk reaches the engine (control)');
  assert.ok(requireGraph(path.join(SCRIPTS, 'build-model-app.js')).has(path.join(SCRIPTS, 'lib', 'creates-port.js')), 'the gated edge is the wiring (control)');
  const engine = fs.readFileSync(path.join(SCRIPTS, 'lib', 'sdk-build.js'), 'utf8');
  assert.match(engine, /if \(spec\.createIdentity !== undefined\) \{\n {4}const \{ createStableCreates \} = require\('\.\/creates-stable-build\.js'\);/);
  assert.equal(engine.match(/require\('\.\/creates-stable-build\.js'\)/g).length, 1, 'the only edge into the stable modules is the gated one');
  assert.match(engine, /if \(!formCatalog\) \{\n {10}const \{ createIntentCatalog \} = require\('\.\/creates-catalog\.js'\);/);
  assert.match(engine, /if \(!dashboardCatalog\) \{\n {10}const \{ createIntentCatalog \} = require\('\.\/creates-catalog\.js'\);/);
  assert.match(engine, /if \(!ruleCatalog\) \{\n {10}const \{ createIntentCatalog \} = require\('\.\/creates-catalog\.js'\);/);
  assert.match(engine, /if \(!bpfCatalog\) \{\n {10}const \{ createIntentCatalog \} = require\('\.\/creates-catalog\.js'\);/);
  assert.equal(engine.match(/require\('\.\/creates-catalog\.js'\)/g).length, 4, 'the catalog is required only where a declared form, dashboard, business rule or process flow settles');
  // The business-rule helper is required only inside the rules phase's declared branches (its dispatch and the sweep of a stored
  // attempt whose declaration was removed, both behind the flag) and by the spec gate for a declared rule.
  assert.equal(engine.match(/require\('\.\/rule-settlement\.js'\)/g).length, 2);
  assert.equal(fs.readFileSync(path.join(SCRIPTS, 'lib', 'app-spec.js'), 'utf8').match(/require\('\.\/rule-settlement\.js'\)/g).length, 1);
  // The process-flow helper likewise: the dispatch and the sweep in the engine, and the spec gate for a declared flow.
  assert.equal(engine.match(/require\('\.\/bpf-settlement\.js'\)/g).length, 2);
  assert.equal(fs.readFileSync(path.join(SCRIPTS, 'lib', 'app-spec.js'), 'utf8').match(/require\('\.\/bpf-settlement\.js'\)/g).length, 1);
  // The rule reader loads it only through one lazy accessor, which verify and the download call only for a committed rule group.
  assert.match(fs.readFileSync(path.join(SCRIPTS, 'lib', 'declared-rule-io.js'), 'utf8'), /^const settlement = \(\) => require\('\.\/rule-settlement\.js'\);$/m);
  assert.equal(fs.readFileSync(path.join(SCRIPTS, 'lib', 'declared-rule-io.js'), 'utf8').match(/require\('\.\/rule-settlement\.js'\)/g).length, 1);
  // The flow reader likewise, through one lazy accessor called only for a committed flow group.
  assert.match(fs.readFileSync(path.join(SCRIPTS, 'lib', 'declared-bpf-io.js'), 'utf8'), /^const settlement = \(\) => require\('\.\/bpf-settlement\.js'\);$/m);
  assert.equal(fs.readFileSync(path.join(SCRIPTS, 'lib', 'declared-bpf-io.js'), 'utf8').match(/require\('\.\/bpf-settlement\.js'\)/g).length, 1);
  // The dashboard helper likewise, through one lazy accessor that only a declared dashboard's create calls.
  const dashboardHelper = fs.readFileSync(path.join(SCRIPTS, 'lib', 'dashboard-reconcile.js'), 'utf8');
  assert.match(dashboardHelper, /^const identity = \(\) => require\('\.\/creates-identity\.js'\);$/m);
  assert.equal(dashboardHelper.match(/require\('\.\/creates-identity\.js'\)/g).length, 1);
  const dashboardScope = fs.readFileSync(path.join(SCRIPTS, 'lib', 'dashboard-recovery-workspace.js'), 'utf8');
  assert.match(dashboardScope, /^const createsLocal = \(\) => require\('\.\/creates-local\.js'\);$/m);
  assert.equal(dashboardScope.match(/require\('\.\/creates-local\.js'\)/g).length, 1);
  // Verify loads the protected configuration only behind the opt-in.
  const verifier = fs.readFileSync(path.join(SCRIPTS, 'verify-model-app.js'), 'utf8');
  assert.match(verifier, /spec\.configurationIdentity === 'stable-v1'\r?\n\s*\? require\('\.\/lib\/configuration-protected\.js'\)/);
  assert.equal(verifier.match(/require\('\.\/lib\/configuration-protected\.js'\)/g).length, 1);
  // The build command makes the managed create gate only for an apply with protected configuration in play, and makeSdk composes it
  // only when it was given one; the engine loads the hookup's modules only in protectedConfigurationFor, called only with that gate.
  const command = fs.readFileSync(path.join(SCRIPTS, 'build-model-app.js'), 'utf8');
  assert.match(command, /const writeGate = managedCreateGate \? require\('\.\/lib\/managed-create-transport\.js'\)\.composeWriteGates\(workflowEffectGate, managedCreateGate\) : workflowEffectGate;/);
  assert.match(command, /const managedCreateGate = opts\.apply && protectedConfigurationInPlay\(spec, \{ apply: true, env, workspaceDir, appDir: opts\.appDir \}\)\r?\n\s*\? require\('\.\/lib\/managed-create-transport\.js'\)\.createDeferredManagedCreateGate\(\) : null;/);
  assert.equal(command.match(/require\('\.\/lib\/managed-create-transport\.js'\)/g).length, 2);
  const hookup = engine.slice(engine.indexOf('function protectedConfigurationFor('), engine.indexOf('// The entry every caller enters by.'));
  for (const m of ['managed-create-context', 'configuration-create-bindings', 'configuration-protected']) {
    assert.equal(hookup.match(new RegExp(`require\\('\\./${m}\\.js'\\)`, 'g')).length, 1, `${m}.js is required in the hookup factory`);
    assert.equal(engine.match(new RegExp(`require\\('\\./${m}\\.js'\\)`, 'g')).length, 1, `${m}.js is required nowhere else in the engine`);
  }
  assert.match(engine, /if \(opts\.managedCreateGate && workflowStore && !opts\.protectedConfiguration\) \{/);
  assert.equal(engine.match(/protectedConfigurationFor\(/g).length, 2, 'defined once, called once behind the gate');
  assert.ok(graph.has(path.join(SCRIPTS, 'lib', 'creates-passthrough.js')));
  for (const m of NEW_MODULES) assert.ok(!graph.has(m), `${path.basename(m)} is not reachable from a default build`);
  const build = fs.readFileSync(path.join(SCRIPTS, 'build-model-app.js'), 'utf8');
  assert.match(build, /const creates = deps\.creates \|\| createPassthroughCreates\(\);/);
  // Control: the walk would see a new module if something required it.
  assert.ok(requireGraph(path.join(SCRIPTS, 'lib', 'creates-port.js')).has(path.join(SCRIPTS, 'lib', 'creates-identity.js')));
});

// --- the semantic theme setter: an answer is applied only when it says what happened ------------------------------------------------

test('the theme setter is a semantic U kind keyed by the app and its setting definition, allocating no id', () => {
  const d = capabilityFor('appTheme');
  assert.deepStrictEqual([d.class, d.semantic, d.key], ['U', true, 'app + setting definition']);
  assert.strictEqual(allocates('appTheme'), false);
  assert.strictEqual(stable().identityFor('appTheme', 'app'), null);
});

test('a theme answer that does not say what happened to the row is an unknown outcome, never applied', async () => {
  for (const answer of [{}, [], { outcome: 'unknown', published: false }, { outcome: 'applied' }, { outcome: 'CREATED' }, Object.create({ outcome: 'updated' })]) {
    let calls = 0;
    const error = await stable().run({ kind: 'appTheme', key: 'app' }, async () => { calls += 1; return answer; }).catch((e) => e);
    assert.strictEqual(error && error.code, 'create-outcome-unknown', JSON.stringify(answer));
    assert.strictEqual(error.transient, false);
    assert.strictEqual(calls, 1);
  }
  for (const outcome of ['created', 'updated', 'removed', 'unchanged']) {
    const out = await stable().run({ kind: 'appTheme', key: 'app' }, async () => ({ appId: '0f0f0f0f-1111-4222-8333-444444444444', outcome, published: false }));
    assert.deepStrictEqual([out.outcome, out.id, out.result.outcome], ['applied', null, outcome], outcome);
  }
});

test('a theme setter failure that may have been sent stops as an unknown outcome; a refusal is rethrown unchanged', async () => {
  const lost = Object.assign(new Error('write response lost'), { code: 'ECONNRESET', transient: true, method: 'POST' });
  const body = {};
  Object.defineProperty(body, Symbol.for('power-platform-skills.http-send-history'), { value: { sends: 2, earlierAmbiguous: true } });
  const marked = Object.assign(new Error('HTTP 400'), { statusCode: 400, body });
  const status = Object.assign(new Error('HTTP 504'), { code: 'CONNECTION_ERROR', statusCode: 504 });
  for (const failure of [lost, marked, status]) {
    let calls = 0;
    const error = await stable().run({ kind: 'appTheme', key: 'app' }, async () => { calls += 1; throw failure; }).catch((e) => e);
    assert.strictEqual(error.code, 'create-outcome-unknown', failure.message);
    assert.strictEqual(error.transient, false, 'a run again would send it again');
    assert.strictEqual(error.cause, failure);
    assert.strictEqual(calls, 1);
  }
  const refused = Object.assign(new Error('the theme is not valid'), { code: 'APP_THEME_INVALID' });
  const error = await stable().run({ kind: 'appTheme', key: 'app' }, async () => { throw refused; }).catch((e) => e);
  assert.strictEqual(error, refused);
  assert.strictEqual(error.createAttempt, undefined);
});

// --- a stable port refuses a kind it does not know --------------------------------------------------------------------------------

test('a stable port refuses an unknown kind before anything runs; known unprotected kinds and the consumers\u2019 own names pass through', async () => {
  let calls = 0;
  const exec = async ({ id }) => { calls += 1; return { id }; };
  for (const kind of ['chrat', 'Chart', 'savedquery', 'toString', '__proto__']) {
    assert.strictEqual(await codeOf(stable().run({ kind, key: 'contoso_order|by owner' }, exec)), 'create-identity-unsupported', kind);
  }
  assert.strictEqual(calls, 0);
  for (const kind of ['dashboard', 'form', 'table', 'webResource', 'membership', 'command', 'business-process-flow', 'business-process-flow-children',
    'business-rule', 'business-rule-node', 'web-resource', 'form-layout', 'form-layout-child', 'dashboard-tile', 'formPageEmbed', 'formCell', 'environmentVariableValue']) {
    const out = await stable().run({ kind, key: 'k' }, exec);
    assert.strictEqual(out.outcome, 'created', kind);
  }
  assert.deepStrictEqual(['command', 'business-process-flow', 'web-resource', 'dashboard-tile', 'formPageEmbed', 'chrat'].map(kindAliasOf), ['appaction', 'bpf', 'webResource', 'formCell', 'formCell', null]);
  // No alias stands for a kind that is sent with a stable identity: an alias can never route a protected create around its port.
  for (const [alias, target] of Object.entries(require('../lib/creates-capabilities.js').KIND_ALIASES)) {
    const known = Object.prototype.hasOwnProperty.call(require('../lib/creates-capabilities.js').NON_ROW_EXCEPTIONS, target) || !allocates(target);
    assert.ok(known, `${alias} → ${target}`);
  }
  // The pass-through port stays permissive: it never refuses a kind.
  assert.strictEqual((await createCreatesPort({ mode: 'passthrough' }).run({ kind: 'chrat', key: 'x' }, async ({ id }) => ({ id }))).outcome, 'created');
});
test('a create stop is a refusal only with the port\u2019s pre-send certificate: the same code from a step after the send is an unknown outcome', async () => {
  const { createThroughPort } = require('../lib/reconcile-common.js');
  const { markPreSend } = require('../lib/creates-port.js');
  const portThrowing = (err) => ({ creates: { run: async () => { throw err; } } });
  const request = { kind: 'view', key: 'contoso_order|active' };
  const execute = async () => { throw new Error('execute is not reached'); };
  // Codes a pre-send stop can carry. Each can also come from a step after the send (a receipt or record that could not be
  // written), so the code alone must never be read as "nothing was sent".
  for (const code of ['creation-record-unwritten', 'managed-binding-store-unwritable', 'managed-settlement-pending', 'create-completion-required', 'create-identity-conflict']) {
    const after = await createThroughPort(portThrowing(Object.assign(new Error('after the send'), { code })), request, execute);
    assert.equal(after.status, 'unknown', `${code} without the certificate is an unknown outcome`);
    const before = await createThroughPort(portThrowing(markPreSend(Object.assign(new Error('before the send'), { code }))), request, execute);
    assert.deepEqual(before, { status: 'refused', code }, `${code} with the certificate is a refusal`);
  }
});