'use strict';
// The generic lifecycle of a protected create set (lib/managed-create-context.js) over the real binding store and the
// real request boundary: prepare -> send in scope -> fresh read -> receipts -> commit, and the read-only recovery of an
// attempt an earlier run left pending. A "new process" is a new context over a freshly opened store: it shares the
// persisted attempt, never the earlier process's in-memory answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createDeferredManagedCreateGate, sentProjection } = require('../lib/managed-create-transport.js');
const { CODES, createManagedCreateContext, buildRowPlan, defaultApprovalToken, acceptSaved } = require('../lib/managed-create-context.js');
const { CODES: STORE } = require('../lib/managed-bindings.js');
const { H, API, REQ, API_KEY, REQ_KEY, URL_API, URL_MEMBER, open, codeOf, apiBody, apiClassifier } = require('./helpers/managed-rows.js');

const NOT_FOUND = 'configuration-row-not-found';
const OTHER = '77777777-7777-4777-8777-777777777777';
const API2 = '44444444-4444-4444-8444-444444444444';
const REQ2 = '55555555-5555-4555-8555-555555555555';
const EV = '66666666-6666-4666-8666-666666666666';
const EVV = '88888888-8888-4888-8888-888888888888';
const ROOT_TOKEN = `adopt:customApi:${API_KEY}`;
const CHILD_TOKEN = 'adopt:customApiRequestParameter:contoso_api/request%3Ap';

const ctxOf = (dir, approvals = []) => createManagedCreateContext({ store: open(dir), approvals, notFoundCode: NOT_FOUND });

/** The driver plan of one Custom API and its request parameter (buildRowPlan input). */
function apiPlanOf({ key = API_KEY, api = API, req = REQ, mode = 'create', baseGeneration = null, baseObservation } = {}) {
  return {
    family: 'customApi', key, baseGeneration, declarationSha256: H('e'), ...(baseObservation !== undefined ? { baseObservation } : {}),
    rows: [
      { kind: 'customApi', key, id: api, parentId: null, mode, expectedSha256: H('7') },
      { kind: 'customApiRequestParameter', key: JSON.stringify([key, 'request:p']), id: req, parentId: api, mode, expectedSha256: H('8') },
    ],
    members: [{ kind: 'customApi', id: api, componentType: 10134 }, { kind: 'customApiRequestParameter', id: req, componentType: 10135 }],
    effects: [{ kind: 'membership', id: api }, { kind: 'membership', id: req }],
  };
}

/** A fresh read of apiPlanOf exactly as planned; `over` replaces fields of a row by kind. */
function apiRead({ key = API_KEY, api = API, req = REQ, root = {}, child = {}, members = 'present' } = {}) {
  return {
    rows: [
      { kind: 'customApi', key, id: api, state: 'present', parentId: null, projectionSha256: H('7'), ...root },
      { kind: 'customApiRequestParameter', key: JSON.stringify([key, 'request:p']), id: req, state: 'present', parentId: api, projectionSha256: H('8'), ...child },
    ],
    members: [{ id: api, state: members }, { id: req, state: 'present' }],
    ruleState: null,
  };
}

// Send the deep insert (and the two memberships) of the attempts through the real gate, answered as `answer` says.
async function send(ctx, store, attempts, { classify, answer = { statusCode: 204, headers: {} }, body = apiBody(), members = [API, REQ], accept = () => true } = {}) {
  const gate = createDeferredManagedCreateGate();
  gate.bind(store);
  const exchange = (req) => {
    const h = gate.screen(req);
    h.dispatching();
    h.answered(answer);
  };
  return ctx.run({ attempts, classify: classify || apiClassifier(attempts[0].token), acceptResult: accept }, async () => {
    exchange({ method: 'POST', url: URL_API, body: JSON.stringify(body) });
    for (const id of members) exchange({ method: 'POST', url: URL_MEMBER, body: JSON.stringify({ ComponentId: id }) });
  });
}

// A context whose store is reachable, for the gate.
function begun(dir, plans = [apiPlanOf()], approvals = []) {
  const store = open(dir);
  const ctx = createManagedCreateContext({ store, approvals, notFoundCode: NOT_FOUND });
  return { store, ctx, attempts: ctx.begin(plans) };
}

const groupOf = (dir, key = API_KEY) => open(dir).snapshot().envelope.groups.find((g) => g.family === 'customApi' && g.key === key) || null;
const attemptsOf = (dir) => open(dir).snapshot().envelope.attempts;

test('a set sent, acknowledged and read back exactly is committed as created, row by row, with its proof and baseline', async () => {
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  const out = await send(ctx, store, attempts);
  assert.equal(out.localError, null);
  const [result] = ctx.settle([{ token: attempts[0].token, observation: apiRead() }]);
  assert.equal(result.verdict.action, 'commit');
  const g = groupOf(dir);
  assert.deepEqual(g.records.map((r) => [r.kind, r.key, r.id, r.origin, r.parentKey]), [
    ['customApi', API_KEY, API, 'created', undefined], ['customApiRequestParameter', REQ_KEY, REQ, 'created', API_KEY]]);
  assert.deepEqual(g.consumerState.rows.map((r) => [r.kind, r.projectionSha256]), [['customApi', H('7')], ['customApiRequestParameter', H('8')]]);
  assert.equal(attemptsOf(dir).length, 0);
});

test('a parent\'s acknowledgement never mints a child: the child needs its own exact approval', async () => {
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  const token = attempts[0].token;
  // The driver sends the root on its own; the parameter appears by other means.
  const rootOnly = ({ body }) => ({ type: 'rows', token, expectTable: 'customapis', expectKey: 'customapiid', rows: [{ kind: 'customApi', key: API_KEY, id: JSON.parse(body).customapiid, parentId: null, ...sentProjection({ uniquename: API_KEY }) }] });
  await send(ctx, store, attempts, { classify: rootOnly, members: [] });
  const [halted] = ctx.settle([{ token, observation: apiRead() }]);
  assert.equal(halted.verdict.code, CODES.ownership);
  assert.deepEqual(halted.verdict.approvals, [CHILD_TOKEN], 'only the child is asked for; the root kept its receipt');
  const [done] = ctxOf(dir, [CHILD_TOKEN]).settle([{ token, observation: apiRead(), declarationSha256: H('e') }]);
  assert.equal(done.verdict.action, 'commit');
  assert.deepEqual(groupOf(dir).records.map((r) => r.origin), ['created', 'adopted']);
});

test('recovery: a changed declaration halts; a prepared attempt resumes first; a sending one proven unsent resumes continue', () => {
  const dir = makeTempDir('mc-context-');
  const { prepare, expected } = buildRowPlan(apiPlanOf());
  const store = open(dir);
  const [prepared] = store.prepareAttemptSet([prepare]);
  const ctx = ctxOf(dir);
  assert.equal(ctx.classify(prepared, apiRead(), { declarationSha256: H('f') }).code, CODES.intentChanged);
  assert.deepEqual(ctx.classify(prepared, apiRead(), { declarationSha256: H('e') }), { action: 'resume', claim: 'first' });
  const [first] = ctx.resume([{ token: prepared, claim: 'first' }]);
  assert.deepEqual(first.expected, expected, 'a resumed prepared attempt gets the same proof again');
  const later = ctxOf(dir);
  assert.deepEqual(later.classify(prepared, { rows: [], members: [] }, { declarationSha256: H('e') }), { action: 'resume', claim: 'continue' });
  const [cont] = later.resume([{ token: prepared, claim: 'continue' }]);
  assert.ok(cont.epoch !== first.epoch, 'a continued attempt runs under a new epoch');
});

test('recovery after a possible send: an unread row or member is unverified, never absent', async () => {
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  await send(ctx, store, attempts);
  const later = ctxOf(dir);
  const at = { declarationSha256: H('e') };
  assert.equal(later.classify(attempts[0].token, apiRead({ child: { state: 'unknown' } }), at).code, CODES.unverified);
  assert.equal(later.classify(attempts[0].token, apiRead({ members: 'unknown' }), at).code, CODES.unverified);
  assert.equal(later.classify(attempts[0].token, { rows: apiRead().rows.slice(0, 1), members: apiRead().members }, at).code, CODES.unverified, 'a row the read does not list is unknown');
});

test('recovery: another id, parent or content, or an answer naming another id, is a conflict; a missing row or member is completion', async () => {
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  await send(ctx, store, attempts, { answer: { statusCode: 204, headers: { 'OData-EntityId': `${URL_API}(${OTHER})` } } });
  const token = attempts[0].token;
  assert.equal(ctx.classify(token, apiRead()).code, CODES.conflict, 'this process saw the service answer another id');
  const later = ctxOf(dir);
  const at = { declarationSha256: H('e') };
  assert.equal(later.classify(token, apiRead({ child: { projectionSha256: H('0') } }), at).code, CODES.conflict);
  assert.equal(later.classify(token, apiRead({ child: { parentId: OTHER } }), at).code, CODES.conflict);
  const absent = later.classify(token, apiRead({ child: { state: 'absent' } }), at);
  assert.deepEqual([absent.code, absent.phase, absent.rows.map((r) => r.key)], [CODES.completion, 'saved', [REQ_KEY]]);
  const member = later.classify(token, apiRead({ members: 'absent' }), at);
  assert.deepEqual([member.code, member.phase], [CODES.completion, 'membership-pending']);
});

test('recovery in a later process: an exact set nobody acknowledged needs each row\'s exact approval, and is then adopted', async () => {
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  // Nobody checked what the operation answered, so no answer of it acknowledges a create.
  await send(ctx, store, attempts, { accept: null });
  const token = attempts[0].token;
  const halted = ctxOf(dir).classify(token, apiRead(), { declarationSha256: H('e') });
  assert.deepEqual([halted.code, halted.approvals], [CODES.ownership, [ROOT_TOKEN, CHILD_TOKEN]]);
  assert.equal(ctxOf(dir, [ROOT_TOKEN]).classify(token, apiRead(), { declarationSha256: H('e') }).code, CODES.ownership, 'the root\'s approval does not cover the child');
  const [done] = ctxOf(dir, [ROOT_TOKEN, CHILD_TOKEN]).settle([{ token, observation: apiRead(), declarationSha256: H('e') }]);
  assert.equal(done.verdict.action, 'commit');
  assert.deepEqual(groupOf(dir).records.map((r) => r.origin), ['adopted', 'adopted']);
});

test('receipts outlive the process that proved them: a later run asks only for the row it could not prove', async () => {
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  await send(ctx, store, attempts);
  const token = attempts[0].token;
  const [first] = ctx.settle([{ token, observation: apiRead({ child: { state: 'unknown' } }) }]);
  assert.equal(first.verdict.code, CODES.unverified);
  assert.equal(attemptsOf(dir)[0].acknowledgedRoot, true, 'the root create this process saw acknowledged and read exactly is kept');
  const halted = ctxOf(dir).classify(token, apiRead(), { declarationSha256: H('e') });
  assert.deepEqual(halted.approvals, [CHILD_TOKEN]);
});

test('a bound row found absent halts with the driver\'s not-found code and is never replaced', async () => {
  const dir = makeTempDir('mc-context-');
  const one = begun(dir);
  await send(one.ctx, one.store, one.attempts);
  one.ctx.settle([{ token: one.attempts[0].token, observation: apiRead() }]);
  const edit = apiPlanOf({ mode: 'update', baseGeneration: groupOf(dir).generation, baseObservation: { rowVersion: '1', savedSha256: H('1') } });
  const two = begun(dir, [edit]);
  await send(two.ctx, two.store, two.attempts, { members: [] });
  const gone = two.ctx.classify(two.attempts[0].token, apiRead({ root: { state: 'absent' } }));
  assert.deepEqual([gone.code, gone.rows.map((r) => r.id)], [NOT_FOUND, [API]]);
  const [kept] = two.ctx.settle([{ token: two.attempts[0].token, observation: apiRead() }]);
  assert.equal(kept.verdict.action, 'commit', 'an edit of bound rows commits on their existing bindings');
  assert.deepEqual(groupOf(dir).records.map((r) => r.origin), ['created', 'created']);
});

test('a private input is proved by this process\'s own answer and a matching read; across processes only by approval; masked never', async () => {
  const EV_KEY = 'contoso_ev';
  const VAL_KEY = JSON.stringify([EV_KEY, 'value']);
  const plan = {
    family: 'environmentVariable', key: EV_KEY, declarationSha256: H('e'),
    rows: [
      { kind: 'environmentVariable', key: EV_KEY, id: EV, parentId: null, mode: 'create', expectedSha256: H('7') },
      { kind: 'environmentVariableValue', key: VAL_KEY, id: EVV, parentId: EV, mode: 'create', expectedSha256: H('8'), sensitiveInput: true },
    ],
    members: [{ kind: 'environmentVariable', id: EV, componentType: 380 }],
  };
  const read = (privateState) => ({
    rows: [
      { kind: 'environmentVariable', key: EV_KEY, id: EV, state: 'present', parentId: null, projectionSha256: H('7') },
      { kind: 'environmentVariableValue', key: VAL_KEY, id: EVV, state: 'present', parentId: EV, projectionSha256: H('8'), ...(privateState ? { privateState } : {}) },
    ],
    members: [{ id: EV, state: 'present' }],
    ruleState: null,
  });
  const evClassify = (token) => ({ body }) => {
    const b = JSON.parse(body);
    return { type: 'rows', token, expectTable: 'environmentvariabledefinitions', expectKey: 'environmentvariabledefinitionid', rows: [
      { kind: 'environmentVariable', key: EV_KEY, id: b.id, parentId: null, ...sentProjection({ schemaname: EV_KEY }) },
      { kind: 'environmentVariableValue', key: VAL_KEY, id: EVV, parentId: b.id, ...sentProjection({ schemaname: EV_KEY }) }] };
  };
  const run = async () => {
    const dir = makeTempDir('mc-context-');
    const b = begun(dir, [plan]);
    await send(b.ctx, b.store, b.attempts, { classify: evClassify(b.attempts[0].token), body: { id: EV }, members: [] });
    return { dir, ...b, token: b.attempts[0].token };
  };
  const same = await run();
  const [mine] = same.ctx.settle([{ token: same.token, observation: read('match') }]);
  assert.equal(mine.verdict.action, 'commit');
  const valueToken = `adopt:environmentVariableValue:${EV_KEY}/value`;
  const cross = await run();
  const at = { declarationSha256: H('e') };
  assert.equal(cross.ctx.classify(cross.token, read('masked')).code, CODES.completion, 'a masked value is never certified');
  assert.equal(cross.ctx.classify(cross.token, read()).code, CODES.completion, 'an unreported private state is not a match');
  // The definition's create was receipted by its checked run; its private value still needs the maker's approval.
  const halted = ctxOf(cross.dir).classify(cross.token, read('match'), at);
  assert.deepEqual([halted.code, halted.approvals], [CODES.ownership, [valueToken]]);
  assert.equal(ctxOf(cross.dir, [`adopt:environmentVariable:${EV_KEY}`, valueToken]).classify(cross.token, read('masked'), at).code, CODES.completion, 'approval never certifies a masked value');
  const [adopted] = ctxOf(cross.dir, [`adopt:environmentVariable:${EV_KEY}`, valueToken]).settle([{ token: cross.token, observation: read('match'), declarationSha256: H('e') }]);
  assert.equal(adopted.verdict.action, 'commit');
  // A receipt from an earlier process proves the row was created, not that its private value is today's: a later
  // process that reads the value matching still needs the maker's approval of it.
  const earlier = await run();
  assert.equal(earlier.ctx.settle([{ token: earlier.token, observation: read('masked') }])[0].verdict.code, CODES.completion);
  const later = ctxOf(earlier.dir).classify(earlier.token, read('match'), at);
  assert.deepEqual([later.code, later.approvals], [CODES.ownership, [valueToken]]);
});

test('approval tokens are percent-encoded, so a / or : in a key never makes two rows share one', () => {
  const child = (root, slot) => ({ kind: 'customApiRequestParameter', key: JSON.stringify([root, slot]), parentId: API });
  assert.equal(defaultApprovalToken('customApi', 'a/b:c', child('a/b:c', 'request:x/y')), 'adopt:customApiRequestParameter:a%2Fb%3Ac/request%3Ax%2Fy');
  assert.notEqual(defaultApprovalToken('customApi', 'a/b', child('a/b', 'c')), defaultApprovalToken('customApi', 'a', child('a', 'b/c')));
  assert.equal(defaultApprovalToken('customApi', 'a/b', { kind: 'customApi', key: 'a/b', parentId: null }), 'adopt:customApi:a/b');
  assert.throws(() => defaultApprovalToken('customApi', 'a', { kind: 'customApiRequestParameter', key: 'a/request:p', parentId: API }), TypeError);
  assert.throws(() => defaultApprovalToken('customApi', 'a', child('b', 'p')), TypeError, 'a child of another root has no token under this one');
  assert.throws(() => createManagedCreateContext({ store: open(makeTempDir('mc-context-')) }), TypeError, 'a driver must name its not-found code');
});

test('each item of a set settles on its own: one halting never holds back another\'s commit', async () => {
  const dir = makeTempDir('mc-context-');
  const KEY2 = 'contoso_api2';
  const { store, ctx, attempts } = begun(dir, [apiPlanOf(), apiPlanOf({ key: KEY2, api: API2, req: REQ2 })]);
  const tokenOf = new Map([[API_KEY, attempts[0].token], [KEY2, attempts[1].token], [API, attempts[0].token], [REQ, attempts[0].token], [API2, attempts[1].token], [REQ2, attempts[1].token]]);
  const both = (req) => { const c = apiClassifier(null)(req); return c && { ...c, token: tokenOf.get(c.type === 'rows' ? c.rows[0].key : c.id) }; };
  await send(ctx, store, attempts, { classify: both });
  await send(ctx, store, attempts, { classify: both, body: { ...apiBody(API2, REQ2), uniquename: KEY2 }, members: [API2, REQ2] });
  const results = ctx.settle([
    { token: attempts[0].token, observation: apiRead({ child: { state: 'unknown' } }) },
    { token: attempts[1].token, observation: apiRead({ key: KEY2, api: API2, req: REQ2 }) }]);
  assert.deepEqual(results.map((r) => r.verdict.action === 'commit' ? 'commit' : r.verdict.code), [CODES.unverified, 'commit']);
  assert.ok(groupOf(dir, KEY2));
  assert.equal(groupOf(dir), null);
  assert.deepEqual(attemptsOf(dir).map((a) => [a.key, a.acknowledgedRoot]), [[API_KEY, true]], 'the halted item keeps its attempt and the receipt this process proved');
});

// One request through a bound gate inside a context's run, answered as `answer` says (null: dispatched, never answered).
function exchangeVia(gate, req, answer) {
  const h = gate.screen(req);
  h.dispatching();
  if (answer) h.answered(answer);
}
const OK = { statusCode: 204, headers: {} };
const deepInsert = (body = apiBody()) => ({ method: 'POST', url: URL_API, body: JSON.stringify(body) });
const membership = (id) => ({ method: 'POST', url: URL_MEMBER, body: JSON.stringify({ ComponentId: id }) });
function gateOf(store) {
  const gate = createDeferredManagedCreateGate();
  gate.bind(store);
  return gate;
}

test('only a checked run acknowledges a create: no check, a failed check, a thrown or refused operation, or any unproven row answer keeps every 2xx unchecked', async () => {
  const runs = [
    ['no result check', {}, async () => 'saved'],
    ['the check says no', { acceptResult: () => false }, async () => 'saved'],
    ['the check throws', { acceptResult: () => { throw new Error('malformed'); } }, async () => 'saved'],
    ['the check answers a truthy non-true', { acceptResult: () => 1 }, async () => 'saved'],
    ['the operation failed after its content was acknowledged', { acceptResult: () => true }, async () => { throw new Error('a later step of the push failed'); }],
  ];
  for (const [name, opts, after] of runs) {
    const dir = makeTempDir('mc-context-');
    const { store, ctx, attempts } = begun(dir);
    const gate = gateOf(store);
    const out = await ctx.run({ attempts, classify: apiClassifier(attempts[0].token), ...opts }, async () => {
      exchangeVia(gate, deepInsert(), OK);
      for (const id of [API, REQ]) exchangeVia(gate, membership(id), OK);
      return after();
    });
    assert.equal(out.checked, false, name);
    assert.deepEqual(ctx.facts(attempts[0].token).filter((f) => f.type === 'row').map((f) => f.outcome), ['unchecked', 'unchecked'], name);
    assert.equal(attemptsOf(dir)[0].acknowledgedRoot, false, `${name}: no root receipt`);
    const [halted] = ctx.settle([{ token: attempts[0].token, observation: apiRead() }]);
    assert.deepEqual([halted.verdict.code, halted.verdict.approvals], [CODES.ownership, [ROOT_TOKEN, CHILD_TOKEN]], `${name}: nothing is taken as created`);
  }
  // A 2xx for another row is kept a conflict, and an unknown answer stays unknown: neither is laundered by the check.
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  const gate = gateOf(store);
  const out = await ctx.run({ attempts, classify: apiClassifier(attempts[0].token), acceptResult: () => true }, async () => {
    exchangeVia(gate, deepInsert(), { statusCode: 204, headers: { 'OData-EntityId': `${URL_API}(${OTHER})` } });
    return { saved: true };
  });
  assert.equal(out.checked, false);
  assert.deepEqual(ctx.facts(attempts[0].token).map((f) => f.outcome), ['conflict', 'conflict']);
  assert.equal(ctx.classify(attempts[0].token, apiRead()).code, CODES.conflict);
  const lost = begun(makeTempDir('mc-context-'));
  const lostGate = gateOf(lost.store);
  const l = await lost.ctx.run({ attempts: lost.attempts, classify: apiClassifier(lost.attempts[0].token), acceptResult: () => true }, async () => { exchangeVia(lostGate, deepInsert(), null); return { saved: true }; });
  assert.equal(l.checked, false, 'an unanswered content request is never laundered by saved:true');
  assert.deepEqual(lost.ctx.facts(lost.attempts[0].token).map((f) => [f.outcome, f.unanswered]), [['unknown', true], ['unknown', true]]);
});

test('a checked run receipts its new root before anything else: the attempt stays sending, its membership still goes, and its open debt is kept', async () => {
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  const gate = gateOf(store);
  const token = attempts[0].token;
  const out = await ctx.run({ attempts, classify: apiClassifier(token), acceptResult: () => true }, async () => { exchangeVia(gate, deepInsert(), OK); return 'saved'; });
  assert.equal(out.checked, true);
  const [a] = attemptsOf(dir);
  assert.deepEqual([a.acknowledgedRoot, a.phase, a.savedObservation, a.acknowledgedChildCreates], [true, 'sending', null, undefined], 'the root alone, before any read-back');
  // The membership work comes after the receipt, and one of its answers is lost: the receipt stands, the debt stays.
  const later = await ctx.run({ attempts, classify: apiClassifier(token), acceptResult: () => true }, async () => {
    exchangeVia(gate, membership(API), OK);
    exchangeVia(gate, membership(REQ), { statusCode: 500, headers: {} });
    return 'saved';
  });
  assert.equal(later.localError, null);
  const pending = ctxOf(dir).classify(token, apiRead({ members: 'absent' }), { declarationSha256: H('e') });
  assert.deepEqual([pending.code, pending.phase], [CODES.completion, 'membership-pending']);
  const owned = ctxOf(dir).classify(token, apiRead(), { declarationSha256: H('e') });
  assert.deepEqual([owned.code, owned.approvals], [CODES.ownership, [CHILD_TOKEN]], 'a later process has the root receipt; the child needs its own proof');
  // An edit never creates a root receipt, and the store refuses a receipt from another epoch.
  assert.equal(codeOf(() => store.noteSaved(token, { proof: null, acknowledgedRoot: true, phase: 'sending', epoch: 99 })), STORE.pending);
  assert.equal(codeOf(() => store.noteSaved(token, { proof: { x: 1 }, acknowledgedRoot: true, phase: 'sending', epoch: 1 })), STORE.notSettled);
});

test('an edit\'s checked run receipts no root', async () => {
  const dir = makeTempDir('mc-context-');
  const one = begun(dir);
  await send(one.ctx, one.store, one.attempts);
  one.ctx.settle([{ token: one.attempts[0].token, observation: apiRead() }]);
  const two = begun(dir, [apiPlanOf({ mode: 'update', baseGeneration: groupOf(dir).generation, baseObservation: { rowVersion: '1', savedSha256: H('1') } })]);
  const out = await send(two.ctx, two.store, two.attempts, { members: [] });
  assert.equal(out.checked, true);
  assert.equal(attemptsOf(dir)[0].acknowledgedRoot, false);
  assert.equal(codeOf(() => two.store.noteSaved(two.attempts[0].token, { proof: null, acknowledgedRoot: true, phase: 'sending', epoch: 1 })), STORE.notSettled);
});

test('a receipt the store cannot write is the run\'s typed local failure, and nothing more is sent under that context', async () => {
  const dir = makeTempDir('mc-context-');
  const { store, ctx, attempts } = begun(dir);
  const gate = gateOf(store);
  const full = Object.assign(new Error('the managed binding store would be too large'), { code: STORE.storeFull });
  store.noteSaved = () => { throw full; };
  const out = await ctx.run({ attempts, classify: apiClassifier(attempts[0].token), acceptResult: () => true }, async () => { exchangeVia(gate, deepInsert(), OK); return 'saved'; });
  assert.deepEqual([out.checked, out.localError], [false, full]);
  assert.deepEqual(ctx.facts(attempts[0].token).map((f) => f.outcome), ['unchecked', 'unchecked']);
  let called = false;
  const next = await ctx.run({ attempts, classify: apiClassifier(attempts[0].token), acceptResult: () => true }, async () => { called = true; });
  assert.deepEqual([called, next.localError, next.checked], [false, full, false]);
});

test('acceptSaved accepts only the SDK\'s saved result for exactly the pushed artifact', () => {
  const ok = acceptSaved({ type: 'customApi', id: API });
  assert.equal(ok({ type: 'customApi', id: API.toUpperCase(), saved: true, shipped: true, publish: { kind: 'notRequested' } }), true);
  for (const r of [
    { type: 'customApi', id: API, saved: false, adoptedExisting: true },
    { type: 'customApi', id: API, saved: false, shipped: false, publish: { kind: 'notRequested' }, error: { code: 'ALREADY_EXISTS' } },
    { type: 'customApi', id: API, saved: true, error: { code: 'VERSION_CONFLICT' } },
    { type: 'customApi', id: API, saved: true, adoptedExisting: true },
    { type: 'customApi', id: API, saved: 'true' },
    { type: 'customApi', id: OTHER, saved: true },
    { type: 'environmentVariable', id: API, saved: true },
    null, 'saved', [],
  ]) assert.equal(ok(r), false, JSON.stringify(r));
  const command = acceptSaved({ type: 'command', id: 'account' });
  assert.equal(command({ type: 'command', id: 'account', saved: true }), true);
  assert.equal(command({ type: 'command', id: 'Account', saved: true }), false, 'a command bar is named by its table, exactly');
  assert.equal(command({ type: 'command', id: API, saved: true }), false, 'never by one of its root GUIDs');
  assert.throws(() => acceptSaved({ type: 'customApi' }), TypeError);
});

// A directory holding the committed set of apiPlanOf, as one checked run and an exact read leave it.
async function committed() {
  const dir = makeTempDir('mc-context-');
  const one = begun(dir);
  await send(one.ctx, one.store, one.attempts);
  assert.equal(one.ctx.settle([{ token: one.attempts[0].token, observation: apiRead() }])[0].verdict.action, 'commit');
  return dir;
}
const editOf = (dir, sha) => {
  const plan = apiPlanOf({ mode: 'update', baseGeneration: groupOf(dir).generation, baseObservation: { rowVersion: '1', savedSha256: H('1') } });
  plan.rows[0].expectedSha256 = sha;
  return plan;
};

test('an edit of bound rows records the intent it proved, never another identity or origin', async () => {
  const dir = await committed();
  const two = begun(dir, [editOf(dir, H('c'))]);
  await send(two.ctx, two.store, two.attempts, { members: [] });
  const [done] = two.ctx.settle([{ token: two.attempts[0].token, observation: apiRead({ root: { projectionSha256: H('c') } }) }]);
  assert.equal(done.verdict.action, 'commit');
  assert.deepEqual(groupOf(dir).records.map((r) => [r.kind, r.id, r.origin, r.intentSha256]), [['customApi', API, 'created', H('c')], ['customApiRequestParameter', REQ, 'created', H('8')]]);
  for (const recordOf of [
    (row, origin, attempt, header) => ({ formatVersion: 1, ...header, kind: row.kind, key: row.key, id: OTHER, intentSha256: row.expectedSha256, origin, ...(row.parentId ? { parentKey: API_KEY } : {}) }),
    (row, origin, attempt, header) => ({ formatVersion: 1, ...header, kind: row.kind, key: row.key, id: row.id, intentSha256: row.expectedSha256, origin: 'adopted', ...(row.parentId ? { parentKey: API_KEY } : {}) }),
  ]) {
    const d = await committed();
    const store = open(d);
    const ctx = createManagedCreateContext({ store, notFoundCode: NOT_FOUND, recordOf });
    const attempts = ctx.begin([editOf(d, H('c'))]);
    await send(ctx, store, attempts, { members: [] });
    const before = groupOf(d);
    assert.throws(() => ctx.settle([{ token: attempts[0].token, observation: apiRead({ root: { projectionSha256: H('c') } }) }]), TypeError);
    assert.deepEqual(groupOf(d), before, 'nothing committed');
  }
});

// A plan over rows that already exist and that this run never writes: every row an update, with the base it read.
const readOnlyPlanOf = (over = {}) => apiPlanOf({ mode: 'update', baseObservation: { rowVersion: '1', savedSha256: H('1') }, ...over });

test('a plan of existing rows that sent nothing is accepted read-only: each unbound row adopted under its own approval, in one write', () => {
  const dir = makeTempDir('mc-context-');
  const { ctx, attempts } = begun(dir, [readOnlyPlanOf()]);
  const token = attempts[0].token;
  const [capture] = ctx.captureReadOnly([token]);
  const [halted] = ctx.acceptReadOnly([{ token, observation: apiRead(), capture }]);
  assert.deepEqual([halted.verdict.code, halted.verdict.approvals, halted.group], [CODES.ownership, [ROOT_TOKEN, CHILD_TOKEN], undefined]);
  assert.equal(groupOf(dir), null);
  const before = attemptsOf(dir)[0];
  const approved = createManagedCreateContext({ store: open(dir), approvals: [ROOT_TOKEN, CHILD_TOKEN], notFoundCode: NOT_FOUND });
  const [fresh] = approved.captureReadOnly([token]);
  // The store accepts nothing unsent as created, whatever proposal a driver hands it.
  const s = open(dir);
  const real = s.commitReadOnlyGroupSet;
  const created = [];
  const spy = createManagedCreateContext({ store: Object.assign(Object.create(s), { commitReadOnlyGroupSet: (p) => { created.push(...p); throw new Error('held'); } }), approvals: [ROOT_TOKEN, CHILD_TOKEN], notFoundCode: NOT_FOUND });
  assert.throws(() => spy.acceptReadOnly([{ token, observation: apiRead(), capture: fresh, declarationSha256: H('e') }]), /held/);
  assert.equal(codeOf(() => real.call(s, created.map((p) => ({ ...p, records: p.records.map((r) => ({ ...r, origin: 'created' })) })))), STORE.adoptionRequired);
  assert.equal(groupOf(dir), null);
  const [done] = approved.acceptReadOnly([{ token, observation: apiRead(), capture: fresh, declarationSha256: H('e') }]);
  assert.equal(done.verdict.action, 'commit');
  assert.deepEqual(groupOf(dir).records.map((r) => [r.kind, r.id, r.origin]), [['customApi', API, 'adopted'], ['customApiRequestParameter', REQ, 'adopted']]);
  assert.equal(done.group.generation, groupOf(dir).generation);
  assert.deepEqual(attemptsOf(dir), []);
  assert.deepEqual([before.acknowledgedRoot, before.rowProtocol.rows.map((r) => r.dispatched), before.rowProtocol.effects.map((e) => e.dispatched)], [false, [false, false], [false, false]], 'nothing was sent, and nothing claims it was');
});

test('a read-only acceptance keeps a bound row\'s origin and refuses anything else: a create plan, no capture, a store moved since the capture, a dispatch', async () => {
  const dir = await committed();
  const bound = begun(dir, [readOnlyPlanOf({ baseGeneration: groupOf(dir).generation })]);
  const [cap] = bound.ctx.captureReadOnly([bound.attempts[0].token]);
  const [kept] = bound.ctx.acceptReadOnly([{ token: bound.attempts[0].token, observation: apiRead(), capture: cap }]);
  assert.equal(kept.verdict.action, 'commit');
  assert.deepEqual(groupOf(dir).records.map((r) => r.origin), ['created', 'created'], 'bound rows keep how they were first bound');

  const create = begun(makeTempDir('mc-context-'));
  const [cc] = create.ctx.captureReadOnly([create.attempts[0].token]);
  assert.throws(() => create.ctx.acceptReadOnly([{ token: create.attempts[0].token, observation: apiRead(), capture: cc }]), TypeError, 'a create plan is never accepted without its send');
  const plain = begun(makeTempDir('mc-context-'), [readOnlyPlanOf()], [ROOT_TOKEN, CHILD_TOKEN]);
  assert.throws(() => plain.ctx.acceptReadOnly([{ token: plain.attempts[0].token, observation: apiRead() }]), TypeError, 'no capture, no acceptance');

  // The attempt moved between the capture and the acceptance: another process claimed it under a new epoch. Nothing
  // is written; a write to another group alone moves nothing this acceptance rests on.
  const moved = makeTempDir('mc-context-');
  const m = begun(moved, [readOnlyPlanOf()], [ROOT_TOKEN, CHILD_TOKEN]);
  const [mc] = m.ctx.captureReadOnly([m.attempts[0].token]);
  begun(moved, [apiPlanOf({ key: 'contoso_api2', api: API2, req: REQ2 })]);
  assert.deepEqual(m.ctx.captureReadOnly([m.attempts[0].token]), [mc]);
  ctxOf(moved).resume([{ token: m.attempts[0].token, claim: 'continue' }]);
  const snap = open(moved).snapshot().envelope;
  assert.equal(codeOf(() => m.ctx.acceptReadOnly([{ token: m.attempts[0].token, observation: apiRead(), capture: mc }])), STORE.conflict);
  assert.deepEqual(open(moved).snapshot().envelope, snap);

  // Something was dispatched under the attempt: it may have written, so it is recovered, never accepted read-only.
  const sent = makeTempDir('mc-context-');
  const s = begun(sent, [readOnlyPlanOf()], [ROOT_TOKEN, CHILD_TOKEN]);
  // The proposal the context would hand the store while nothing was sent, kept to hand it again after the dispatch.
  const real = s.store.commitReadOnlyGroupSet;
  let proposals;
  s.store.commitReadOnlyGroupSet = (p) => { proposals = p; throw new Error('held'); };
  assert.throws(() => s.ctx.acceptReadOnly([{ token: s.attempts[0].token, observation: apiRead(), capture: s.ctx.captureReadOnly([s.attempts[0].token])[0] }]), /held/);
  s.store.commitReadOnlyGroupSet = real;
  const gate = gateOf(s.store);
  await s.ctx.run({ attempts: s.attempts, classify: apiClassifier(s.attempts[0].token) }, async () => exchangeVia(gate, membership(API), null));
  const [sc] = s.ctx.captureReadOnly([s.attempts[0].token]);
  const [refused] = s.ctx.acceptReadOnly([{ token: s.attempts[0].token, observation: apiRead(), capture: sc }]);
  assert.deepEqual([refused.verdict.code, refused.group], [STORE.pending, undefined]);
  assert.equal(groupOf(sent), null);
  // The store refuses the same acceptance on its own, should a driver hand it a dispatched attempt.
  assert.equal(codeOf(() => s.store.commitReadOnlyGroupSet(proposals.map((p) => ({ ...p, capture: sc })))), STORE.pending);
  assert.equal(groupOf(sent), null);
});

test('a read-only acceptance is all or nothing: one item not accepted holds every other item too', () => {
  const dir = makeTempDir('mc-context-');
  const KEY2 = 'contoso_api2';
  const { ctx, attempts } = begun(dir, [readOnlyPlanOf(), readOnlyPlanOf({ key: KEY2, api: API2, req: REQ2 })], [ROOT_TOKEN, CHILD_TOKEN]);
  const captures = ctx.captureReadOnly(attempts.map((a) => a.token));
  const results = ctx.acceptReadOnly([
    { token: attempts[0].token, observation: apiRead(), capture: captures[0] },
    { token: attempts[1].token, observation: apiRead({ key: KEY2, api: API2, req: REQ2 }), capture: captures[1] }]);
  assert.deepEqual(results.map((r) => [r.verdict.action === 'commit' ? 'commit' : r.verdict.code, r.group]), [['commit', undefined], [CODES.ownership, undefined]]);
  assert.equal(groupOf(dir), null, 'the accepted item is not committed alone');
  assert.equal(attemptsOf(dir).length, 2);
});