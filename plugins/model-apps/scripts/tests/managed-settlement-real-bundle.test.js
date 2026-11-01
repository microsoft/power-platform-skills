'use strict';
// The managed settlement through the REAL vendored SDK and the plugin's REAL HTTP client (lib/sdk-http-client.js), over
// an in-memory transport: the wrapper (lib/managed-feature-contract.js runManagedFeature) with the build's never-retry
// halt, the binding store it persists to, the publication barrier's transport gate, and the workflow-effect gate
// (lib/workflow-effect-context.js) that sends a managed business rule's or process flow's one workflow write once and
// refuses every other write inside its context — while a request with no context is sent exactly as before.
//
// Nothing in the shipped build calls these yet; these tests are what a declared form, dashboard, rule or flow will
// stand on, and they prove the client is unchanged when no gate is given.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createManagedWire, sdkOver, clientOver, ORIGIN } = require('./helpers/managed-wire.js');
const { openManagedContext, openManagedBindings, CODES } = require('../lib/managed-bindings.js');
const { runManagedFeature, withWorkflowEffect, publishManagedScope } = require('../lib/managed-feature-contract.js');
const { createWorkflowEffectGate, requestBodySha256, MISMATCH, currentWorkflowEffect } = require('../lib/workflow-effect-context.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { readSystemFormPublication } = require('../lib/systemform-published.js');
const { BuildHalt } = require('../lib/entity-provision.js');
const { RETRY, retryPolicyFor } = require('../lib/retry-policy.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');

const APP = 'contoso_app';
const SOL = 'contoso_solution';
const FP = environmentFingerprint(ORIGIN);
const H = (c) => c.repeat(64);
const API = `${ORIGIN}/api/data/v9.0`;
const ZERO = '00000000-0000-0000-0000-000000000000';
const MAIN = '11111111-1111-4111-8111-111111111111';
const RULE_A = '33333333-3333-4333-8333-33333333333a';
const RULE_B = '33333333-3333-4333-8333-33333333333b';
const LEGACY = '33333333-3333-4333-8333-33333333333c';
const FLOW = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = { type: 'table', table: 'account' };
const rec = (kind, key, id) => ({ formatVersion: 1, appUniqueName: APP, environmentFingerprint: FP, kind, key, id, intentSha256: H('a'), origin: 'created' });
const expected = (rootId, schema = 'form-v1') => ({ proofVersion: 1, proofSchema: schema, rootId, baseProofSha256: null, sentProjectionSha256: H('b'), preservationSha256: H('c'), baseObservation: null, children: [] });
const PROOF = { savedSha256: H('1'), semanticSha256: H('2'), preservationSha256: H('3'), expectedChildrenSha256: null };
const errOf = async (p) => { try { await p; } catch (e) { return e; } return null; };
const context = (dir, barrier) => openManagedContext({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOL, barrier });

// The build's managedStop, as lib/sdk-build.js makes it: it answers a never-retry halt and does not throw it.
const managedStop = (phase, label, stopCode, { cause } = {}) => new BuildHalt(`${label}: ${stopCode} — this declared artifact did not settle`, { phase, code: stopCode, recoverable: false, retry: RETRY.NEVER, cause });

function formPorts(wire, sdk, { formxml, calls = [] } = {}) {
  const note = (name, fn) => async (...a) => { calls.push(name); return fn(...a); };
  return {
    phase: 'forms', family: 'form', key: 'account/main', knownScopes: [ACCOUNT], knownIds: [MAIN], halt: managedStop,
    resolve: note('resolve', async () => ({})),
    plan: note('plan', async () => (wire.saved.get(MAIN) && wire.saved.get(MAIN).formxml === formxml
      ? { noop: true }
      : { root: { kind: 'form', key: 'account/main', id: MAIN }, expected: expected(MAIN), declarationSha256: H('e'), publication: { scope: ACCOUNT, state: 'owed' } })),
    apply: note('apply', async () => {
      if (!wire.saved.has(MAIN)) wire.putForm({ formid: MAIN, name: 'Main', objecttypecode: 'account', type: 2, formxml });
      else await sdk.dataverse.patch(`/systemforms(${MAIN})`, { formxml });
    }),
    prove: note('prove', async ({ recovering } = {}) => {
      const read = await readSystemFormPublication(sdk.dataverse, MAIN);
      if (read.saved.formxml !== formxml) throw Object.assign(new Error('the saved form is not the declared one'), { code: 'create-completion-required' });
      return { savedProof: { savedSha256: H('1') }, acknowledgedRoot: !recovering, records: [{ ...rec('form', 'account/main', MAIN), origin: recovering ? 'adopted' : 'created' }], proof: PROOF, consumerState: { declaration: {}, children: {}, proofSchema: 'form-v1' }, publication: { scope: ACCOUNT, state: 'owed', desiredSha256: H('9'), dispatchToken: null } };
    }),
    ensureMembership: note('membership', async () => undefined),
  };
}

test('a required failure rejects with the build\'s never-retry halt and runs no downstream step; nothing is prepared before the plan', async () => {
  for (const failing of ['resolve', 'plan', 'prove', 'membership']) {
    const wire = createManagedWire();
    const barrier = createPublicationBarrier();
    const { sdk } = await sdkOver(wire, { barrier });
    const dir = makeTempDir('msr-halt-');
    const { store } = context(dir, barrier);
    const before = store.snapshot().revision;
    const calls = [];
    const p = formPorts(wire, sdk, { formxml: `<form f="${failing}"/>`, calls });
    const real = p[failing === 'membership' ? 'ensureMembership' : failing];
    p[failing === 'membership' ? 'ensureMembership' : failing] = async (...a) => { await real(...a); throw Object.assign(new Error(`${failing} failed`), { code: `${failing}-failed` }); };
    const e = await errOf(runManagedFeature({ ...p, store, barrier }));
    assert.ok(e instanceof BuildHalt, failing);
    assert.equal(e.code, `${failing}-failed`);
    assert.equal(retryPolicyFor(e), RETRY.NEVER);
    assert.equal(calls[calls.length - 1], failing, `nothing ran after ${failing}`);
    assert.equal(barrier.allowScope(ACCOUNT, 'check'), false, 'and the table is quarantined');
    assert.equal(wire.publishes().length, 0);
    if (failing === 'resolve' || failing === 'plan') assert.equal(store.snapshot().revision, before, 'nothing was prepared');
  }
});

test('the wrapper catches a throw of every step and converts it with the halt factory; a hold outlives a send or commit failure', async () => {
  for (const step of ['resolve', 'plan', 'apply', 'prove', 'membership', 'commit']) {
    const wire = createManagedWire();
    const barrier = createPublicationBarrier();
    const { sdk } = await sdkOver(wire, { barrier });
    const dir = makeTempDir('msr-steps-');
    const opened = context(dir, barrier).store;
    const store = step === 'commit'
      ? openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOL, barrier })
      : opened;
    const p = formPorts(wire, sdk, { formxml: '<form v="1"/>' });
    const key = step === 'membership' ? 'ensureMembership' : step;
    if (step === 'commit') {
      const commit = store.commitGroup;
      store.commitGroup = () => { throw Object.assign(new Error('disk full'), { code: CODES.writeFailed }); };
      assert.ok(commit);
    } else {
      p[key] = async () => { throw new TypeError(`${step} broke`); };
    }
    const e = await errOf(runManagedFeature({ ...p, store, barrier }));
    assert.ok(e instanceof BuildHalt, `${step}: ${e && e.message}`);
    assert.equal(e.phase, 'forms');
    assert.ok(e.cause, `${step} keeps its cause`);
    // A change that may have reached the service is held (apply, commit) or quarantined (a required step): either way withheld.
    assert.equal(barrier.allowScope(ACCOUNT, 'check'), false, step);
  }
});

test('the halt factory is required and its answer is what is thrown; a factory that answers no error fails closed', async () => {
  const wire = createManagedWire();
  const barrier = createPublicationBarrier();
  const { sdk } = await sdkOver(wire, { barrier });
  const dir = makeTempDir('msr-factory-');
  const { store } = context(dir, barrier);
  const p = formPorts(wire, sdk, { formxml: '<form v="1"/>' });
  const missing = await errOf(runManagedFeature({ ...p, halt: undefined, store, barrier }));
  assert.equal(missing.code, CODES.notSettled);
  assert.equal(barrier.active, false);
  assert.deepEqual(wire.log, [], 'nothing was read or sent before the refusal');
  assert.equal(store.snapshot().revision, 0);

  p.prove = async () => { throw new Error('no proof'); };
  const silent = await errOf(runManagedFeature({ ...p, halt: () => 'not an error', store, barrier }));
  assert.equal(silent.code, CODES.notSettled);
  assert.ok(!(silent instanceof BuildHalt));
});

test('discovery, then recovery of a pending attempt, then commit, then exactly one scoped publish through the real client and gate', async () => {
  const wire = createManagedWire();
  const dir = makeTempDir('msr-recover-');
  // Process one: the change is accepted by the service, and the process ends before the proof.
  {
    const barrier = createPublicationBarrier();
    const { sdk } = await sdkOver(wire, { barrier });
    const { store } = context(dir, barrier);
    const p = formPorts(wire, sdk, { formxml: '<form v="1"/>' });
    p.prove = async () => { throw Object.assign(new Error('the process ended'), { code: 'crash' }); };
    assert.equal((await errOf(runManagedFeature({ ...p, store, barrier }))).code, 'crash');
    await sdk.fetchArtifact('form', MAIN);
    await sdk.publishArtifact('form', MAIN);
    assert.equal(wire.publishes('account').length, 0, 'the unproved change is not published by anyone in its run');
  }
  // Process two: discovery holds the table for the pending attempt; recovery proves, commits and releases it.
  const barrier = createPublicationBarrier();
  const { sdk } = await sdkOver(wire, { barrier });
  const ctx = context(dir, barrier);
  assert.deepEqual(ctx.debt.map((d) => d.kind), ['hold']);
  const calls = [];
  const r = await runManagedFeature({ ...formPorts(wire, sdk, { formxml: '<form v="1"/>', calls }), store: ctx.store, barrier });
  assert.deepEqual(r.result, { committed: true, recovered: true });
  assert.deepEqual(calls, ['prove', 'membership'], 'recovery sends nothing again');
  const out = await publishManagedScope({
    store: ctx.store, barrier, scope: ACCOUNT, groups: [{ family: 'form', key: 'account/main' }],
    readPublished: async (g) => { const x = await readSystemFormPublication(sdk.dataverse, g.root.id); return { publishedSha256: x.state === 'equal' ? H('9') : H('8') }; },
    publish: async () => { await sdk.fetchArtifact('form', MAIN); await sdk.publishArtifact('form', MAIN); },
  });
  assert.equal(out.sent, true);
  assert.equal(wire.publishes('account').length, 1);
  assert.equal(wire.publishes().length, 1);
  const reopened = openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOL });
  assert.equal(reopened.lookup('form', 'account/main').id, MAIN, 'the production caller persisted the group');
  assert.equal(reopened.readGroup('form', 'account/main').committed.publication.state, 'confirmed');
});

// A rule whose attempt is prepared and sending, so its workflow effects can be recorded.
function ruleAttempt(store, key, id) {
  const token = store.prepareAttempt({ family: 'rule', key, baseGeneration: null, root: { kind: 'business-rule', key, id }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(id, 'rule-v1'));
  return token;
}
const ruleBody = (id, name) => ({ Entity: { workflowid: id, name, category: 2 } });
const actionUrl = (verb) => `${API}/workflows(${ZERO})/Microsoft.Dynamics.CRM.${verb}ProcessWithWfomJson`;
const sends = (wire, pred) => wire.log.filter(pred).length;

async function gated(wire) {
  const dir = makeTempDir('msr-wf-');
  const store = openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOL });
  const gate = createWorkflowEffectGate({ store });
  const { sdk, httpClient } = await sdkOver(wire, { workflowEffectGate: gate });
  return { store, gate, sdk, client: httpClient };
}

test('inside an effect context, reads pass and spend nothing; the one matching state write is sent once, and its 503 is recorded unconfirmed', async () => {
  const wire = createManagedWire();
  wire.workflows.set(FLOW, { workflowid: FLOW, statecode: 0, statuscode: 1 });
  const { store, sdk } = await gated(wire);
  const token = store.prepareAttempt({ family: 'bpf', key: 'account-flow', baseGeneration: null, root: { kind: 'bpf', key: 'account-flow', id: FLOW }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(FLOW, 'bpf-v1'));
  const effect = { attemptToken: token, baseGeneration: null, family: 'bpf', key: 'account-flow', rowId: FLOW, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active' };
  wire.script((e) => e.method === 'PATCH', { statusCode: 503, body: { error: { code: '0x80040216', message: 'unavailable' } } });
  const recorded = await withWorkflowEffect({ store, effect }, async (r) => {
    assert.equal(currentWorkflowEffect().token, r.token);
    for (let i = 0; i < 3; i += 1) assert.equal((await sdk.dataverse.get(`/workflows(${FLOW})?$select=statecode,statuscode`)).status, 200);
    assert.equal(store.readGroup('bpf', 'account-flow').effects[0].state, 'definitely-unsent', 'reads do not consume the effect');
    await errOf(sdk.updateRecord('workflow', FLOW, { statecode: 1, statuscode: 2 }));
    return r;
  });
  assert.equal(sends(wire, (e) => e.method === 'PATCH'), 1, 'sent once, not retried');
  const persisted = store.readGroup('bpf', 'account-flow').effects.find((e) => e.token === recorded.token);
  assert.equal(persisted.state, 'unconfirmed');
  assert.ok(persisted.dispatchToken);
  assert.equal(wire.workflows.get(FLOW).statecode, 1, 'the service applied it: only a fresh read may now settle it');

  // The legacy client, with no gate, re-sends the same answer as it always did.
  const legacyWire = createManagedWire();
  legacyWire.workflows.set(FLOW, { workflowid: FLOW, statecode: 0, statuscode: 1 });
  for (let i = 0; i < 6; i += 1) legacyWire.script((e) => e.method === 'PATCH', { statusCode: 503, body: { error: { code: '0x80040216' } }, unapplied: true });
  const plain = await sdkOver(legacyWire);
  await errOf(plain.sdk.updateRecord('workflow', FLOW, { statecode: 1, statuscode: 2 }));
  assert.equal(sends(legacyWire, (e) => e.method === 'PATCH'), 6);
});

test('a row with an uncertain effect is readable and not writable outside a context; a later matching proof settles it without a send', async () => {
  const wire = createManagedWire();
  const { store, client } = await gated(wire);
  const token = ruleAttempt(store, 'account/hide', RULE_A);
  const body = ruleBody(RULE_A, 'Hide');
  const effect = { attemptToken: token, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE_A, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: requestBodySha256(body) };
  wire.script((e) => /CreateProcess/.test(e.path), { error: 'socket hang up', code: 'ECONNRESET' });
  const rec0 = await withWorkflowEffect({ store, effect }, async (r) => { await errOf(client.post(actionUrl('Create'), body)); return r; });
  assert.equal(store.readGroup('rule', 'account/hide').effects[0].state, 'unconfirmed');
  const before = wire.log.length;
  assert.equal((await client.get(`${API}/workflows(${RULE_A})?$select=name`)).status, 200, 'observation is allowed');
  const refused = await errOf(client.patch(`${API}/workflows(${RULE_A})`, { statecode: 1, statuscode: 2 }));
  assert.equal(refused.code, MISMATCH);
  const batch = `--batch_1\r\nContent-Type: application/http\r\n\r\nPATCH ${API}/workflows(${RULE_A}) HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"statecode":1,"statuscode":2}\r\n--batch_1--\r\n`;
  assert.equal((await errOf(client.post(`${API}/$batch`, batch, { headers: { 'Content-Type': 'multipart/mixed; boundary=batch_1' } }))).code, MISMATCH, 'a $batch part is classified as well');
  assert.equal(wire.log.length, before + 1, 'only the read reached the wire');
  store.confirmEffect(rec0.token, { observedSha256: requestBodySha256(body) });
  assert.equal(store.readGroup('rule', 'account/hide').effects[0].state, 'confirmed');
  assert.equal(sends(wire, (e) => /CreateProcess/.test(e.path)), 1);
});

test('inside a context a write to another row, by another method or version, or a second write, is refused before it is sent', async () => {
  const wire = createManagedWire();
  wire.workflows.set(RULE_A, { workflowid: RULE_A, statecode: 0, statuscode: 1 });
  const { store, client } = await gated(wire);
  const token = ruleAttempt(store, 'account/hide', RULE_A);
  const body = ruleBody(RULE_A, 'Hide v2');
  const effect = { attemptToken: token, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE_A, effect: 'body', request: { method: 'POST', shape: 'rule-update' }, desiredSha256: requestBodySha256(body), expectedVersion: 'W/"7"' };
  const before = wire.log.length;
  await withWorkflowEffect({ store, effect }, async () => {
    const refusals = [
      client.post(actionUrl('Update'), ruleBody(RULE_B, 'Hide v2'), { headers: { 'If-Match': 'W/"7"' } }),
      client.post(actionUrl('Update'), body, { headers: { 'If-Match': 'W/"6"' } }),
      client.post(actionUrl('Update'), body),
      client.post(actionUrl('Create'), body, { headers: { 'If-Match': 'W/"7"' } }),
      client.patch(`${API}/workflows(${RULE_A})`, { name: 'Hide v2' }, { headers: { 'If-Match': 'W/"7"' } }),
      client.post(`${API}/AddSolutionComponent`, { ComponentId: RULE_A }),
    ];
    for (const r of refusals) assert.equal((await errOf(r)).code, MISMATCH);
    assert.equal(wire.log.length, before, 'nothing was sent');
    assert.equal(store.readGroup('rule', 'account/hide').effects[0].state, 'definitely-unsent');
    assert.equal((await client.post(actionUrl('Update'), body, { headers: { 'If-Match': 'W/"7"' } })).status, 200);
    assert.equal((await errOf(client.post(actionUrl('Update'), body, { headers: { 'If-Match': 'W/"7"' } }))).code, MISMATCH, 'the effect is sent once');
  });
  assert.equal(sends(wire, (e) => /UpdateProcess/.test(e.path)), 1);
  assert.equal(store.readGroup('rule', 'account/hide').effects[0].state, 'dispatching', 'a 2xx is not a proof: a fresh read confirms it');
});

test('a conditional write refused 412 did not start: its effect may be sent again in a new context', async () => {
  const wire = createManagedWire();
  wire.workflows.set(RULE_A, { workflowid: RULE_A, statecode: 0, statuscode: 1 });
  const { store, client } = await gated(wire);
  const token = ruleAttempt(store, 'account/hide', RULE_A);
  const body = ruleBody(RULE_A, 'Hide v2');
  const effect = { attemptToken: token, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE_A, effect: 'body', request: { method: 'POST', shape: 'rule-update' }, desiredSha256: requestBodySha256(body), expectedVersion: 'W/"7"' };
  wire.script((e) => /UpdateProcess/.test(e.path), { statusCode: 412, body: { error: { code: '0x80060882', message: 'The version of the existing record does not match' } }, unapplied: true });
  const rec0 = await withWorkflowEffect({ store, effect }, async (r) => { await client.post(actionUrl('Update'), body, { headers: { 'If-Match': 'W/"7"' } }); return r; });
  assert.equal(store.readGroup('rule', 'account/hide').effects[0].state, 'definitely-unsent');
  const { runWithWorkflowEffect } = require('../lib/workflow-effect-context.js');
  await runWithWorkflowEffect(rec0, () => client.post(actionUrl('Update'), body, { headers: { 'If-Match': 'W/"7"' } }));
  assert.equal(sends(wire, (e) => /UpdateProcess/.test(e.path)), 2);
});

test('two managed rules and a legacy rule on one action URL: no cross-row send, no resend of the uncertain one, the legacy retry unchanged', async () => {
  const run = async (withGate) => {
    const wire = createManagedWire();
    const { store, client: gatedClient } = await gated(wire);
    const client = withGate ? gatedClient : clientOver(wire);
    if (withGate) {
      const ta = ruleAttempt(store, 'account/hide', RULE_A);
      const tb = ruleAttempt(store, 'contact/lock', RULE_B);
      const a = ruleBody(RULE_A, 'Hide');
      const b = ruleBody(RULE_B, 'Lock');
      const effA = { attemptToken: ta, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE_A, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: requestBodySha256(a) };
      const effB = { attemptToken: tb, baseGeneration: null, family: 'rule', key: 'contact/lock', rowId: RULE_B, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: requestBodySha256(b) };
      wire.script((e) => /CreateProcess/.test(e.path) && e.body.Entity.workflowid === RULE_A, { statusCode: 503, body: { error: { code: '0x80040216' } } });
      await withWorkflowEffect({ store, effect: effA }, async () => {
        assert.equal((await errOf(client.post(actionUrl('Create'), b))).code, MISMATCH, 'B\'s body under A\'s effect');
        await client.post(actionUrl('Create'), a);
      });
      await withWorkflowEffect({ store, effect: effB }, () => client.post(actionUrl('Create'), b));
      assert.equal(sends(wire, (e) => /CreateProcess/.test(e.path) && e.body.Entity.workflowid === RULE_A), 1, 'the uncertain create is not re-sent');
      assert.equal(sends(wire, (e) => /CreateProcess/.test(e.path) && e.body.Entity.workflowid === RULE_B), 1);
      const states = Object.fromEntries(store.snapshot().envelope.workflowEffects.map((e) => [e.rowId, e.state]));
      assert.deepEqual(states, { [RULE_A]: 'unconfirmed', [RULE_B]: 'dispatching' }, 'one row\'s outcome never settles another');
      assert.equal((await errOf(client.post(actionUrl('Create'), a))).code, MISMATCH, 'a legacy write of the uncertain row is refused');
    }
    // The legacy rule: no context, the same action URL, a 503 then success.
    wire.script((e) => /CreateProcess/.test(e.path) && e.body.Entity.workflowid === LEGACY, { statusCode: 503, body: { error: { code: '0x80040216' } }, unapplied: true });
    const answer = await client.post(actionUrl('Create'), ruleBody(LEGACY, 'Legacy'));
    return { status: answer.status, legacySends: sends(wire, (e) => /CreateProcess/.test(e.path) && e.body.Entity.workflowid === LEGACY) };
  };
  const withGate = await run(true);
  const without = await run(false);
  assert.deepEqual(withGate, without);
  assert.deepEqual(without, { status: 200, legacySends: 2 }, 'the legacy create keeps its retry');
});

test('a $batch inside a context is one write when it holds exactly one matching part; a second or an unclassified part refuses it', async () => {
  const wire = createManagedWire();
  wire.workflows.set(FLOW, { workflowid: FLOW, statecode: 0, statuscode: 1 });
  const { store, client } = await gated(wire);
  const token = store.prepareAttempt({ family: 'bpf', key: 'account-flow', baseGeneration: null, root: { kind: 'bpf', key: 'account-flow', id: FLOW }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(FLOW, 'bpf-v1'));
  const part = (method, url, body, ifMatch) => `--batch_1\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n${method} ${url} HTTP/1.1\r\nContent-Type: application/json\r\n${ifMatch ? `If-Match: ${ifMatch}\r\n` : ''}\r\n${body ? JSON.stringify(body) : ''}\r\n`;
  const batch = (...parts) => `${parts.join('')}--batch_1--\r\n`;
  const opts = { headers: { 'Content-Type': 'multipart/mixed; boundary=batch_1' } };
  const state = { statecode: 1, statuscode: 2 };
  const effect = { attemptToken: token, baseGeneration: null, family: 'bpf', key: 'account-flow', rowId: FLOW, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active', expectedVersion: 'W/"3"' };
  const before = wire.log.length;
  await withWorkflowEffect({ store, effect }, async () => {
    assert.equal((await errOf(client.post(`${API}/$batch`, batch(part('PATCH', `${API}/workflows(${FLOW})`, state, 'W/"3"'), part('PATCH', `${API}/workflows(${RULE_A})`, state, 'W/"3"')), opts))).code, MISMATCH);
    assert.equal((await errOf(client.post(`${API}/$batch`, batch(part('PATCH', `${API}/workflows(${FLOW})`, state, 'W/"3"'), part('POST', `${API}/AddSolutionComponent`, { ComponentId: FLOW })), opts))).code, MISMATCH);
    assert.equal(wire.log.length, before);
    assert.equal((await client.post(`${API}/$batch`, batch(part('GET', `${API}/workflows(${FLOW})`), part('PATCH', `${API}/workflows(${FLOW})`, state, 'W/"3"')), opts)).status, 204);
  });
  assert.equal(wire.log.length, before + 1);
  assert.equal(store.readGroup('bpf', 'account-flow').effects[0].state, 'dispatching');
});

test('a context that is not the persisted effect sends nothing; the stored effect still sends once, and a 412 re-entry cannot change it', async () => {
  const wire = createManagedWire();
  wire.workflows.set(RULE_A, { workflowid: RULE_A, statecode: 0, statuscode: 1 });
  const { store, client } = await gated(wire);
  const { runWithWorkflowEffect } = require('../lib/workflow-effect-context.js');
  const token = ruleAttempt(store, 'account/hide', RULE_A);
  const stored = store.recordWorkflowEffect({ attemptToken: token, baseGeneration: null, family: 'rule', key: 'account/hide', rowId: RULE_A, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Draft' });
  const before = wire.log.length;
  const active = { statecode: 1, statuscode: 2 };
  // The stored record asks for Draft; a copy that asks for Active is not that record.
  assert.equal((await errOf(runWithWorkflowEffect({ ...stored, desiredState: 'Active' }, () => client.patch(`${API}/workflows(${RULE_A})`, active)))).code, MISMATCH);
  assert.equal((await errOf(runWithWorkflowEffect({ ...stored, rowId: RULE_B }, () => client.patch(`${API}/workflows(${RULE_B})`, active)))).code, MISMATCH, 'another row');
  assert.equal((await errOf(runWithWorkflowEffect({ ...stored, token: 'not-persisted' }, () => client.patch(`${API}/workflows(${RULE_A})`, { statecode: 0, statuscode: 1 })))).code, MISMATCH, 'no record');
  assert.equal(wire.log.length, before, 'nothing was sent');
  assert.equal(wire.workflows.get(RULE_A).statecode, 0);
  assert.deepEqual(store.readGroup('rule', 'account/hide').effects[0], stored, 'the record is unchanged');

  // A 412 sends the record back to definitely-unsent; a re-entry may send it again only as it was recorded.
  wire.script((e) => e.method === 'PATCH', { statusCode: 412, body: { error: { code: '0x80060882' } }, unapplied: true });
  const versioned = ruleAttempt(store, 'contact/lock', RULE_B);
  wire.workflows.set(RULE_B, { workflowid: RULE_B, statecode: 0, statuscode: 1 });
  const v = store.recordWorkflowEffect({ attemptToken: versioned, baseGeneration: null, family: 'rule', key: 'contact/lock', rowId: RULE_B, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active', expectedVersion: 'W/"3"' });
  await errOf(runWithWorkflowEffect(v, () => client.patch(`${API}/workflows(${RULE_B})`, active, { headers: { 'If-Match': 'W/"3"' } })));
  assert.equal(store.readGroup('rule', 'contact/lock').effects[0].state, 'definitely-unsent');
  const sent = wire.log.length;
  assert.equal((await errOf(runWithWorkflowEffect({ ...v, expectedVersion: 'W/"4"' }, () => client.patch(`${API}/workflows(${RULE_B})`, active, { headers: { 'If-Match': 'W/"4"' } })))).code, MISMATCH, 'a re-entry at another version');
  assert.equal(wire.log.length, sent);

  // The stored Draft record, entered as it was persisted, is sent once.
  await runWithWorkflowEffect(stored, () => client.patch(`${API}/workflows(${RULE_A})`, { statecode: 0, statuscode: 1 }));
  assert.equal(sends(wire, (e) => e.method === 'PATCH' && e.path === `workflows(${RULE_A})`), 1);
  assert.equal(store.readGroup('rule', 'account/hide').effects[0].state, 'dispatching');
});

test('a $batch the gate cannot read whole is refused unsent inside a context; a whole batch of reads still passes', async () => {
  const wire = createManagedWire();
  wire.workflows.set(FLOW, { workflowid: FLOW, statecode: 0, statuscode: 1 });
  const { store, client } = await gated(wire);
  const token = store.prepareAttempt({ family: 'bpf', key: 'account-flow', baseGeneration: null, root: { kind: 'bpf', key: 'account-flow', id: FLOW }, knownScopes: [], declarationSha256: H('e') });
  store.markSending(token, expected(FLOW, 'bpf-v1'));
  const effect = { attemptToken: token, baseGeneration: null, family: 'bpf', key: 'account-flow', rowId: FLOW, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredState: 'Active' };
  const opts = { headers: { 'Content-Type': 'multipart/mixed; boundary=batch_1' } };
  const get = `--batch_1\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nGET ${API}/workflows(${FLOW})?$select=statecode HTTP/1.1\r\nAccept: application/json\r\n\r\n`;
  const patch = `--batch_1\r\nContent-Type: application/http\r\n\r\nPATCH ${API}/workflows(${FLOW}) HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"statecode":1,"statuscode":2}\r\n`;
  const envelopes = {
    empty: '',
    'not a batch': 'not a parseable OData batch',
    'no part': '--batch_1--\r\n',
    'no close delimiter': get,
    'an unsupported request line': `--batch_1\r\nContent-Type: application/http\r\n\r\nMERGE ${API}/workflows(${FLOW}) HTTP/1.1\r\n\r\n{"statecode":1,"statuscode":2}\r\n--batch_1--\r\n`,
    'a read beside an untyped part': `${get}--batch_1\r\n\r\nPATCH ${API}/workflows(${FLOW}) HTTP/1.1\r\n\r\n{"statecode":1,"statuscode":2}\r\n--batch_1--\r\n`,
    'a read beside a part with no request': `${get}--batch_1\r\nContent-Type: application/http\r\n\r\n{"statecode":1,"statuscode":2}\r\n--batch_1--\r\n`,
    'a preamble before the first boundary': `PATCH ${API}/workflows(${FLOW}) HTTP/1.1\r\n${get}--batch_1--\r\n`,
    'another boundary than the content type names': get.replace(/batch_1/g, 'batch_2') + '--batch_2--\r\n',
    'a change set with trailing content': `--batch_1\r\nContent-Type: multipart/mixed; boundary=cs_1\r\n\r\n--cs_1\r\nContent-Type: application/http\r\n\r\nGET ${API}/workflows(${FLOW}) HTTP/1.1\r\n\r\n--cs_1--\r\n${patch.slice('--batch_1\r\n'.length)}--batch_1--\r\n`,
  };
  const before = wire.log.length;
  await withWorkflowEffect({ store, effect }, async () => {
    for (const [name, body] of Object.entries(envelopes)) assert.equal((await errOf(client.post(`${API}/$batch`, body, opts))).code, MISMATCH, name);
    assert.equal(wire.log.length, before, 'nothing was sent');
    assert.equal(store.readGroup('bpf', 'account-flow').effects[0].state, 'definitely-unsent');
    assert.equal((await client.post(`${API}/$batch`, `${get}${get}--batch_1--\r\n`, opts)).status, 204, 'a whole batch of reads');
  });
  assert.equal(wire.log.length, before + 1);
  assert.equal(store.readGroup('bpf', 'account-flow').effects[0].state, 'definitely-unsent', 'reads spend nothing');
  // Outside a context, with no uncertain row, the legacy client sends what it always sent.
  assert.equal((await client.post(`${API}/$batch`, 'not a parseable OData batch', opts)).status, 204);
});