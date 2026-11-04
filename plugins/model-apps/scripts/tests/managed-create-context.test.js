'use strict';
// The generic lifecycle of a protected create set (lib/managed-create-context.js) over the real binding store and the
// real request boundary: prepare -> send in scope -> fresh read -> receipts -> commit, and the read-only recovery of an
// attempt an earlier run left pending. A "new process" is a new context over a freshly opened store: it shares the
// persisted attempt, never the earlier process's in-memory answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createDeferredManagedCreateGate, sentProjection } = require('../lib/managed-create-transport.js');
const { CODES, createManagedCreateContext, buildRowPlan, defaultApprovalToken } = require('../lib/managed-create-context.js');
const { H, API, REQ, API_KEY, REQ_KEY, URL_API, URL_MEMBER, open, apiBody, apiClassifier } = require('./helpers/managed-rows.js');

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
async function send(ctx, store, attempts, { classify, answer = { statusCode: 204, headers: {} }, body = apiBody(), members = [API, REQ] } = {}) {
  const gate = createDeferredManagedCreateGate();
  gate.bind(store);
  const exchange = (req) => {
    const h = gate.screen(req);
    h.dispatching();
    h.answered(answer);
  };
  return ctx.run({ attempts, classify: classify || apiClassifier(attempts[0].token) }, async () => {
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
  const rootOnly = ({ body }) => ({ type: 'rows', token, rows: [{ kind: 'customApi', key: API_KEY, id: JSON.parse(body).customapiid, parentId: null, ...sentProjection({ uniquename: API_KEY }) }] });
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
  await send(ctx, store, attempts);
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
    return { type: 'rows', token, rows: [
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
  const halted = ctxOf(cross.dir).classify(cross.token, read('match'), at);
  assert.deepEqual([halted.code, halted.approvals], [CODES.ownership, [`adopt:environmentVariable:${EV_KEY}`, valueToken]]);
  assert.equal(ctxOf(cross.dir, [`adopt:environmentVariable:${EV_KEY}`, valueToken]).classify(cross.token, read('masked'), at).code, CODES.completion, 'approval never certifies a masked value');
  const [adopted] = ctxOf(cross.dir, [`adopt:environmentVariable:${EV_KEY}`, valueToken]).settle([{ token: cross.token, observation: read('match'), declarationSha256: H('e') }]);
  assert.equal(adopted.verdict.action, 'commit');
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
