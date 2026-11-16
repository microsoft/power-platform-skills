'use strict';
// The one `$batch` a protected create set may send (lib/managed-create-batch.js, admitted by the gate in
// lib/managed-create-transport.js when the set opts in with `batch`): the Custom API change set the SDK writes to edit an
// API the set already binds and add new children. Driven through the plugin's real HTTP client with a fake transport,
// the real binding store and a synthetic driver classifier. The shapes are those the SDK writes and the service answers
// (live captures, every id and host replaced by a placeholder).
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { apiPath } = require('../lib/workflow-effect-context.js');
const { MISMATCH, createDeferredManagedCreateGate, runWithManagedCreateSet, sentProjection } = require('../lib/managed-create-transport.js');
const { batchConfig, parseCustomApiChangeset, readChangesetAnswer } = require('../lib/managed-create-batch.js');
const { createManagedCreateContext } = require('../lib/managed-create-context.js');
const { ENV, SOL, H, API, REQ, API_KEY, REQ_KEY, URL_API, URL_MEMBER, open, apiBody, apiClassifier } = require('./helpers/managed-rows.js');

const API9 = `${ENV}/api/data/v9.0`;
const BATCH_URL = `${API9}/$batch`;
const NEW_REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_RESP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = '77777777-7777-4777-8777-777777777777';
const NEW_REQ_KEY = JSON.stringify([API_KEY, 'request:Extra']);
const NEW_RESP_KEY = JSON.stringify([API_KEY, 'response:Out']);
const BATCH_ID = 'batch_0a0a0a0a-0000-4000-8000-000000000001';
const CS_ID = 'changeset_0a0a0a0a-0000-4000-8000-000000000002';
const RB_ID = 'batchresponse_0a0a0a0a-0000-4000-8000-000000000003';
const RC_ID = 'changesetresponse_0a0a0a0a-0000-4000-8000-000000000004';
const HELD = 'W/"14860046"';
const SAVED = 'W/"14863812"';
const NOT_FOUND = 'configuration-row-not-found';

// --- the request, as cds-maker-sdk renderChangeSet writes it ------------------------------------------------------------

const rootBody = (over = {}) => ({ isprivate: true, ...over });
const reqBody = (over = {}) => ({
  customapirequestparameterid: NEW_REQ, uniquename: 'Extra', name: 'contoso_api.Extra', displayname: 'Extra', description: 'Extra', type: 10,
  logicalentityname: null, isoptional: false, 'CustomAPIId@odata.bind': `/customapis(${API})`, ...over,
});
const respBody = (over = {}) => ({
  customapiresponsepropertyid: NEW_RESP, uniquename: 'Out', name: 'contoso_api.Out', displayname: 'Out', description: 'Out', type: 10,
  logicalentityname: null, 'CustomAPIId@odata.bind': `/customapis(${API})`, ...over,
});
const rootOp = (body = rootBody(), over = {}) => ({ method: 'PATCH', path: `customapis(${API})?$select=customapiid`, body, etag: HELD, ...over });
const reqOp = (body = reqBody(), over = {}) => ({ method: 'POST', path: 'customapirequestparameters?$select=customapirequestparameterid', body, ...over });
const respOp = (body = respBody(), over = {}) => ({ method: 'POST', path: 'customapiresponseproperties?$select=customapiresponsepropertyid', body, ...over });

/** A change set of `ops` in the SDK's framing; each op may replace its MIME or HTTP header lines and its body text. */
function changeset(ops, { eol = '\r\n', boundary = `Content-Type: multipart/mixed;boundary=${CS_ID}` } = {}) {
  const parts = ops.map((op, i) => [
    `--${CS_ID}`, ...(op.mime || ['Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${op.contentId || i + 1}`]), '',
    `${op.method} ${op.base || API9}/${op.path} HTTP/1.1`,
    ...(op.headers || ['Content-Type: application/json;type=entry', `MSCRM.SolutionUniqueName: ${SOL}`, ...(op.etag ? [`If-Match: ${op.etag}`] : []), 'Prefer: return=representation']),
    '', op.text !== undefined ? op.text : JSON.stringify(op.body),
  ].join(eol));
  return [`--${BATCH_ID}`, boundary, '', ...parts, `--${CS_ID}--`, `--${BATCH_ID}--`, ''].join(eol);
}

// --- the answer, as the service sends it --------------------------------------------------------------------------------

const PART_HEADERS = ['Preference-Applied: return=representation', 'Cache-Control: no-store', 'Content-Type: application/json; odata.metadata=minimal', 'OData-Version: 4.0'];
const rootPart = (id = 1, over = {}, headers = [`ETag: ${SAVED}`, ...PART_HEADERS]) => ({
  id, status: 'HTTP/1.1 200 OK', headers,
  body: { '@odata.context': `${API9}/$metadata#customapis(customapiid)/$entity`, '@odata.etag': SAVED, customapiid: API, ...over },
});
const reqPart = (id = 2, over = {}, headers = PART_HEADERS) => ({
  id, status: 'HTTP/1.1 201 Created', headers,
  body: { '@odata.context': `${API9}/$metadata#customapirequestparameters(customapirequestparameterid)/$entity`, '@odata.etag': 'W/"14863815"', customapirequestparameterid: NEW_REQ, _customapiid_value: API, ...over },
});
const respPart = (id = 3, over = {}, headers = PART_HEADERS) => ({
  id, status: 'HTTP/1.1 201 Created', headers,
  body: { '@odata.context': `${API9}/$metadata#customapiresponseproperties(customapiresponsepropertyid)/$entity`, '@odata.etag': 'W/"14863816"', customapiresponsepropertyid: NEW_RESP, _customapiid_value: API, ...over },
});
// The captured atomic failure: the outer status, and only the failed part, with its OData error envelope.
const failedPart = (id = 2) => ({
  id, status: 'HTTP/1.1 412 Precondition Failed', headers: ['Content-Type: application/json; odata.metadata=minimal', 'OData-Version: 4.0'],
  body: { error: { code: '0x80040333', message: 'A record was not created or updated because a duplicate of the current record already exists.' } },
});
function answerText(parts, { eol = '\r\n', boundary = `Content-Type: multipart/mixed; boundary=${RC_ID}` } = {}) {
  return [`--${RB_ID}`, boundary, '', ...parts.map((p) => [
    `--${RC_ID}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${p.id}`, '',
    p.status, ...p.headers, '', p.text !== undefined ? p.text : JSON.stringify(p.body),
  ].join(eol)), `--${RC_ID}--`, `--${RB_ID}--`, ''].join(eol);
}
const answer = (statusCode, parts, opts) => ({ statusCode, headers: { 'content-type': `multipart/mixed; boundary=${RB_ID}` }, body: answerText(parts, opts) });

// --- a store binding the API, and an edit of it that adds two new children ----------------------------------------------

const rowsOf = (mode, extra = []) => [
  { kind: 'customApi', key: API_KEY, id: API, parentId: null, mode, expectedSha256: H('7') },
  { kind: 'customApiRequestParameter', key: REQ_KEY, id: REQ, parentId: API, mode, expectedSha256: H('8') },
  ...extra,
];
const planOf = (rows, baseGeneration = null) => ({
  family: 'customApi', key: API_KEY, baseGeneration, declarationSha256: H('e'), rows,
  ...(baseGeneration !== null ? { baseObservation: { rowVersion: '14860046', savedSha256: H('1') } } : {}),
  members: rows.map((r) => ({ kind: r.kind, id: r.id, componentType: r.kind === 'customApi' ? 10134 : r.kind === 'customApiRequestParameter' ? 10135 : 10136 })),
  effects: rows.filter((r) => r.mode === 'create').map((r) => ({ kind: 'membership', id: r.id })),
});
const readOf = (rows) => ({
  rows: rows.map((r) => ({ kind: r.kind, key: r.key, id: r.id, state: 'present', parentId: r.parentId, projectionSha256: r.expectedSha256 })),
  members: rows.map((r) => ({ id: r.id, state: 'present' })),
  ruleState: null,
});
const NEW_ROWS = [
  { kind: 'customApiRequestParameter', key: NEW_REQ_KEY, id: NEW_REQ, parentId: API, mode: 'create', expectedSha256: H('a') },
  { kind: 'customApiResponseProperty', key: NEW_RESP_KEY, id: NEW_RESP, parentId: API, mode: 'create', expectedSha256: H('b') },
];

// Create and commit the API and its parameter (one deep insert), then begin the edit: the API and its parameter bound
// (updates), the two new children to create.
async function boundEdit(dir) {
  const firstStore = open(dir);
  const first = createManagedCreateContext({ store: firstStore, approvals: [], notFoundCode: NOT_FOUND });
  const created = first.begin([planOf(rowsOf('create'))]);
  const gate = createDeferredManagedCreateGate();
  gate.bind(firstStore);
  await first.run({ attempts: created, classify: apiClassifier(created[0].token), acceptResult: () => true }, async () => {
    for (const req of [{ url: URL_API, body: apiBody() }, { url: URL_MEMBER, body: { ComponentId: API } }, { url: URL_MEMBER, body: { ComponentId: REQ } }]) {
      const h = gate.screen({ method: 'POST', url: req.url, body: JSON.stringify(req.body) });
      h.dispatching();
      h.answered({ statusCode: 204, headers: {} });
    }
  });
  const [done] = first.settle([{ token: created[0].token, observation: readOf(rowsOf('create')) }]);
  assert.equal(done.verdict.action, 'commit');
  const generation = open(dir).snapshot().envelope.groups.find((g) => g.family === 'customApi').generation;
  const store = open(dir);
  const ctx = createManagedCreateContext({ store, approvals: [], notFoundCode: NOT_FOUND });
  const attempts = ctx.begin([planOf(rowsOf('update', NEW_ROWS), generation)]);
  return { store, ctx, attempts, token: attempts[0].token };
}

/**
 * The synthetic driver: it prepared `root` (a PATCH of the API under `ifMatch`, or none) and `children` (the new rows'
 * exact bodies), and classifies a constituent as its prepared row — returning what it prepared, which the gate compares
 * with what the request carries.
 */
function driver(token, { root = rootBody(), ifMatch = HELD, children = [reqBody(), respBody()] } = {}) {
  const KINDS = {
    customapirequestparameters: { kind: 'customApiRequestParameter', pk: 'customapirequestparameterid', keyOf: (b) => JSON.stringify([API_KEY, `request:${b.uniquename}`]) },
    customapiresponseproperties: { kind: 'customApiResponseProperty', pk: 'customapiresponsepropertyid', keyOf: (b) => JSON.stringify([API_KEY, `response:${b.uniquename}`]) },
  };
  return ({ method, url, body }) => {
    const p = apiPath(url);
    let json;
    try { json = JSON.parse(body); } catch { return null; }
    if (method === 'PATCH' && p === `customapis(${API})` && root) {
      return { type: 'rows', token, expectTable: 'customapis', expectKey: 'customapiid', rows: [{ kind: 'customApi', key: API_KEY, id: API, parentId: null, ...sentProjection(root) }], prepared: root, ifMatch };
    }
    const k = method === 'POST' ? KINDS[p] : null;
    const prepared = k && children.find((c) => c[k.pk] === json[k.pk]);
    if (!prepared) return null;
    const { 'CustomAPIId@odata.bind': bind, ...fields } = prepared;
    return { type: 'rows', token, expectTable: p, expectKey: k.pk, rows: [{ kind: k.kind, key: k.keyOf(prepared), id: prepared[k.pk], parentId: API, ...sentProjection(fields) }], prepared };
  };
}

// The edit's attempt as the store file holds it, read by a fresh handle.
const attemptOn = (dir) => JSON.parse(JSON.stringify(open(dir).snapshot().envelope.attempts.find((a) => a.family === 'customApi')));
const dispatchedOf = (a) => a.rowProtocol.rows.filter((r) => r.dispatched).map((r) => r.id).sort();
const swallow = (p) => p.then((v) => v, (e) => e);
const CT = { 'Content-Type': `multipart/mixed;boundary=${BATCH_ID}` };

async function harness({ respond, drive } = {}) {
  const dir = makeTempDir('mc-batch-');
  const { store, ctx, attempts, token } = await boundEdit(dir);
  const gate = createDeferredManagedCreateGate();
  gate.bind(store);
  const sent = [];
  const request = async (req) => {
    sent.push({ method: req.method, url: req.url, body: req.body, attempt: attemptOn(dir) });
    return respond ? respond(req, sent.length) : answer(200, [rootPart(1), reqPart(2), respPart(3)]);
  };
  const client = createAzHttpClient(ENV, { getToken: () => 'TOK', request, sleep: async () => {}, workflowEffectGate: gate });
  const set = { store, entries: attempts.map(({ token: t, epoch }) => ({ token: t, epoch })), classify: driver(token, drive), batch: { apiBase: API9, solution: SOL } };
  const post = (text, headers = CT, url = BATCH_URL) => client.postRaw(url, text, { headers });
  return { dir, store, ctx, attempts, token, sent, set, post, before: attemptOn(dir) };
}

const outcomes = (facts) => facts.filter((f) => f.type === 'row').map((f) => [f.contentId, f.id, f.outcome, f.status]);

test('the captured change set — the API\'s PATCH and one new request parameter — is sealed once, sent once and acknowledged by its 200 and 201 bodies', async () => {
  const h = await harness({ drive: { children: [reqBody()] }, respond: () => answer(200, [rootPart(1), reqPart(2)]) });
  const out = await runWithManagedCreateSet(h.set, () => h.post(changeset([rootOp(), reqOp()])));
  assert.equal(out.localError, null);
  assert.equal(out.error, null);
  assert.equal(h.sent.length, 1, 'one request left');
  const atSend = h.sent[0].attempt;
  assert.deepEqual(dispatchedOf(atSend), [API, NEW_REQ].sort(), 'both rows were sealed before the request left; the unsent child was not');
  assert.equal(atSend.sendWindow.possible, h.before.sendWindow.possible + 1, 'the change set counts as one possible send');
  const sealed = atSend.rowProtocol.rows.find((r) => r.id === NEW_REQ);
  assert.deepEqual(sealed.sentFields, Object.keys(reqBody()).filter((k) => k !== 'CustomAPIId@odata.bind').sort());
  assert.ok(!JSON.stringify(atSend).includes('changeset_'), 'no request text is kept');
  assert.deepEqual(outcomes(out.facts), [[1, API, 'acknowledged', 200], [2, NEW_REQ, 'acknowledged', 201]]);
  assert.ok(out.facts.every((f) => f.batchStatus === 200 && !f.changesetFailure));
});

test('the API\'s PATCH, new request parameters and new response properties in the SDK\'s order are read by Content-ID, not position', async () => {
  const h = await harness({ respond: () => answer(200, [respPart(3), rootPart(1), reqPart(2)]) });
  const out = await runWithManagedCreateSet(h.set, () => h.post(changeset([rootOp(), reqOp(), respOp()])));
  assert.equal(out.localError, null);
  assert.deepEqual(dispatchedOf(h.sent[0].attempt), [API, NEW_REQ, NEW_RESP].sort());
  assert.deepEqual(outcomes(out.facts), [[1, API, 'acknowledged', 200], [2, NEW_REQ, 'acknowledged', 201], [3, NEW_RESP, 'acknowledged', 201]]);
});

test('children only, of both kinds, in LF and quoted boundaries: admitted and acknowledged by 201 parts with no root part', async () => {
  const h = await harness({ drive: { root: null }, respond: () => answer(200, [reqPart(1), respPart(2)], { eol: '\n', boundary: `Content-Type: multipart/mixed; boundary="${RC_ID}"` }) });
  const text = changeset([reqOp(), respOp()], { eol: '\n', boundary: `Content-Type: multipart/mixed; boundary="${CS_ID}"` });
  const out = await runWithManagedCreateSet(h.set, () => h.post(text, { 'content-type': `multipart/mixed; boundary="${BATCH_ID}"` }));
  assert.equal(out.localError, null);
  assert.deepEqual(dispatchedOf(h.sent[0].attempt), [NEW_REQ, NEW_RESP].sort(), 'the bound API is not sealed: it is not written');
  assert.deepEqual(outcomes(out.facts), [[1, NEW_REQ, 'acknowledged', 201], [2, NEW_RESP, 'acknowledged', 201]]);
});

test('every other $batch is refused unsent, nothing is sealed, and the refusal is the set\'s local failure', async () => {
  const h = await harness();
  const ok = changeset([rootOp(), reqOp(), respOp()]);
  const cases = {
    'mixed line endings': ok.replace('\r\nContent-ID: 2', '\nContent-ID: 2'),
    'a bare CR': ok.replace('Content-ID: 2', 'Content-ID: 2\r'),
    'a preamble': `preamble\r\n${ok}`,
    'an epilogue': `${ok}\r\n`,
    'a tab': ok.replace('Prefer: return=representation', 'Prefer:\treturn=representation'),
    'no closing change set delimiter': ok.replace(`--${CS_ID}--\r\n`, ''),
    'a second change set': ok.replace(`--${BATCH_ID}--`, `--${BATCH_ID}\r\nContent-Type: multipart/mixed;boundary=${CS_ID}\r\n\r\n--${CS_ID}--\r\n--${BATCH_ID}--`),
    'a nested multipart part': changeset([rootOp(), reqOp({ ...reqBody() }, { mime: [`Content-Type: multipart/mixed;boundary=${CS_ID}`, 'Content-Transfer-Encoding: binary', 'Content-ID: 2'] }), respOp()]),
    'a boundary inside a body': changeset([rootOp(), reqOp(reqBody({ description: `--${CS_ID}` })), respOp()]),
    'a duplicate MIME header': changeset([rootOp(), reqOp(reqBody(), { mime: ['Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 2', 'content-id: 2'] }), respOp()]),
    'a duplicate HTTP header': changeset([rootOp(), reqOp(reqBody(), { headers: ['Content-Type: application/json;type=entry', `MSCRM.SolutionUniqueName: ${SOL}`, 'Prefer: return=representation', 'prefer: return=representation'] }), respOp()]),
    'a folded header': changeset([rootOp(), reqOp(reqBody(), { headers: ['Content-Type: application/json;type=entry', `MSCRM.SolutionUniqueName: ${SOL}`, 'Prefer:', ' return=representation'] }), respOp()]),
    'an extra header': changeset([rootOp(), reqOp(reqBody(), { headers: ['Content-Type: application/json;type=entry', `MSCRM.SolutionUniqueName: ${SOL}`, 'Prefer: return=representation', 'MSCRM.BypassCustomPluginExecution: true'] }), respOp()]),
    'a duplicate JSON key': changeset([rootOp(), reqOp(null, { text: JSON.stringify(reqBody()).replace('"uniquename":"Extra"', '"uniquename":"Extra","uniquename":"Other"') }), respOp()]),
    'a nested JSON value': changeset([rootOp(rootBody({ description: { text: 'x' } })), reqOp(), respOp()]),
    'a duplicate Content-ID': changeset([rootOp(), reqOp(reqBody(), { contentId: 1 }), respOp()]),
    'a Content-ID gap': changeset([rootOp(), reqOp(reqBody(), { contentId: 3 }), respOp(respBody(), { contentId: 4 })]),
    'an extra query': changeset([rootOp(rootBody(), { path: `customapis(${API})?$select=customapiid&$expand=CustomAPIRequestParameters` }), reqOp(), respOp()]),
    'a content-id reference': changeset([rootOp(), reqOp(reqBody({ 'CustomAPIId@odata.bind': '$1' })), respOp()]),
    'another API version': changeset([rootOp(), reqOp(reqBody(), { base: `${ENV}/api/data/v9.2` }), respOp()]),
    'another origin': changeset([rootOp(), reqOp(reqBody(), { base: 'https://fabrikam.crm.dynamics.com/api/data/v9.0' }), respOp()]),
    'a part the set did not prepare': changeset([rootOp(), reqOp(), respOp(), respOp(respBody({ customapiresponsepropertyid: OTHER, uniquename: 'More' }))]),
    'a GET': changeset([rootOp(), { method: 'GET', path: `customapis(${API})`, text: '' }, respOp()]),
    'a DELETE': changeset([rootOp(), { method: 'DELETE', path: `customapirequestparameters(${REQ})`, text: '' }, respOp()]),
    'a child PATCH': changeset([rootOp(), { method: 'PATCH', path: `customapirequestparameters(${REQ})?$select=customapirequestparameterid`, body: { displayname: 'x' }, etag: HELD }, respOp()]),
    'a root create': changeset([{ method: 'POST', path: 'customapis?$select=customapiid', body: { customapiid: API, uniquename: API_KEY } }, reqOp(), respOp()]),
    'another table': changeset([rootOp(), { method: 'POST', path: 'duplicateruleconditions', body: { duplicateruleconditionid: OTHER } }, respOp()]),
    'another bind': changeset([rootOp(), reqOp(reqBody({ 'CustomAPIId@odata.bind': `/customapis(${OTHER})` })), respOp()]),
    'children bound to two APIs': changeset([reqOp(), respOp(respBody({ 'CustomAPIId@odata.bind': `/customapis(${OTHER})` }))]),
    'another child id': changeset([rootOp(), reqOp(reqBody({ customapirequestparameterid: REQ })), respOp()]),
    'the SDK\'s order reversed': changeset([rootOp(), respOp(respBody(), { contentId: 2 }), reqOp(reqBody(), { contentId: 3 })]),
    'a root PATCH after a child': changeset([reqOp(reqBody(), { contentId: 1 }), rootOp(rootBody(), { contentId: 2 })]),
    'a wildcard If-Match': changeset([rootOp(rootBody(), { etag: '*' }), reqOp(), respOp()]),
    'a stale If-Match': changeset([rootOp(rootBody(), { etag: 'W/"14860001"' }), reqOp(), respOp()]),
    'no If-Match': changeset([rootOp(rootBody(), { etag: null }), reqOp(), respOp()]),
    'an If-Match on a child': changeset([rootOp(), reqOp(reqBody(), { etag: HELD }), respOp()]),
    'an unprepared root field': changeset([rootOp(rootBody({ isfunction: true })), reqOp(), respOp()]),
    'an unprepared root value': changeset([rootOp(rootBody({ isprivate: false })), reqOp(), respOp()]),
    'an extra child field': changeset([rootOp(), reqOp(reqBody({ iscustomizable: true })), respOp()]),
    'an unprepared child value': changeset([rootOp(), reqOp(reqBody({ description: 'Changed' })), respOp()]),
    'a mistyped child field': changeset([rootOp(), reqOp(reqBody({ type: '10' })), respOp()]),
    'no solution header': changeset([rootOp(), reqOp(reqBody(), { headers: ['Content-Type: application/json;type=entry', 'Prefer: return=representation'] }), respOp()]),
    'another solution': changeset([rootOp(), reqOp(reqBody(), { headers: ['Content-Type: application/json;type=entry', 'MSCRM.SolutionUniqueName: other_solution', 'Prefer: return=representation'] }), respOp()]),
    'a lone child': changeset([reqOp()]),
    'a lone root PATCH': changeset([rootOp()]),
  };
  const refused = async (text, headers = CT, url = BATCH_URL) => {
    const out = await runWithManagedCreateSet(h.set, () => swallow(h.post(text, headers, url)));
    return out.localError && out.localError.code;
  };
  for (const [name, text] of Object.entries(cases)) assert.equal(await refused(text), MISMATCH, name);
  assert.equal(await refused(ok, { 'Content-Type': `multipart/mixed;boundary=${BATCH_ID.replace('0001', '0009')}` }), MISMATCH, 'another outer boundary');
  assert.equal(await refused(ok, { ...CT, 'MSCRM.SolutionUniqueName': SOL }), MISMATCH, 'an extra outer header');
  assert.equal(await refused(ok, CT, `${API9}/$batch?continue-on-error=true`), MISMATCH, 'a query on the batch');
  assert.equal(await refused(ok, CT, `${ENV}/api/data/v9.2/$batch`), MISMATCH, 'another API base');
  assert.equal(h.sent.length, 0, 'nothing left');
  assert.deepEqual(attemptOn(h.dir), h.before, 'nothing was sealed or counted');
  // The control: the same text is admitted.
  const good = await runWithManagedCreateSet(h.set, () => h.post(ok));
  assert.equal(good.localError, null);
  assert.equal(h.sent.length, 1);
});

test('shapes from outside the admitted family stay refused: a duplicate rule\'s compound update, the hand-made failing change set, any $batch without the option', async () => {
  const h = await harness();
  const rule = changeset([
    { method: 'POST', path: 'CompoundUpdateDuplicateDetectionRule', headers: ['Content-Type: application/json;type=entry', `MSCRM.SolutionUniqueName: ${SOL}`], body: { Entity: { '@odata.type': 'Microsoft.Dynamics.CRM.duplicaterule', duplicateruleid: OTHER }, ChildEntities: [] } },
    { method: 'POST', path: 'duplicateruleconditions', headers: ['Content-Type: application/json;type=entry', `MSCRM.SolutionUniqueName: ${SOL}`], body: { duplicateruleconditionid: NEW_REQ, operatorcode: 0, 'regardingobjectid@odata.bind': `/duplicaterules(${OTHER})` } },
  ]);
  // The hand-made change set of the captured failure: its PATCH has no If-Match and no $select, its POST no $select or Prefer.
  const handMade = changeset([
    { method: 'PATCH', path: `customapis(${API})`, headers: ['Content-Type: application/json;type=entry', `MSCRM.SolutionUniqueName: ${SOL}`], body: { isprivate: false } },
    { method: 'POST', path: 'customapirequestparameters', headers: ['Content-Type: application/json;type=entry', `MSCRM.SolutionUniqueName: ${SOL}`], body: reqBody() },
  ]);
  for (const text of [rule, handMade]) {
    const out = await runWithManagedCreateSet(h.set, () => swallow(h.post(text)));
    assert.equal(out.localError.code, MISMATCH);
  }
  const { batch, ...without } = h.set;
  assert.ok(batch);
  const out = await runWithManagedCreateSet(without, () => swallow(h.post(changeset([rootOp(), reqOp(), respOp()]))));
  assert.equal(out.localError.code, MISMATCH);
  assert.match(out.localError.message, /sends each change on its own/, 'a set that did not opt in refuses as before');
  assert.equal(h.sent.length, 0);
  assert.deepEqual(attemptOn(h.dir), h.before);
  assert.throws(() => batchConfig({ apiBase: `${API9}/`, solution: SOL }), TypeError);
  assert.throws(() => batchConfig({ apiBase: API9 }), TypeError, 'the solution header is stated, never assumed');
  await assert.rejects(runWithManagedCreateSet({ ...h.set, batch: { apiBase: 'http://contoso.crm.dynamics.com/api/data/v9.0', solution: null } }, async () => null), TypeError);
});

test('a constituent the driver describes otherwise, or under an edit that would create the API, is refused unsent', async () => {
  const h = await harness();
  const ok = changeset([rootOp(), reqOp(), respOp()]);
  const run = async (classify) => {
    const out = await runWithManagedCreateSet({ ...h.set, classify }, () => swallow(h.post(ok)));
    return out.localError && out.localError.code;
  };
  const base = driver(h.token);
  const tweak = (fn) => (req) => { const c = base(req); return c && fn(c, req); };
  assert.equal(await run(tweak((c) => ({ ...c, token: 'another' }))), MISMATCH, 'another attempt');
  assert.equal(await run(tweak((c) => ({ ...c, expectTable: 'customapis', expectKey: 'customapiid' }))), MISMATCH, 'another table to read the answer under');
  assert.equal(await run(tweak((c) => ({ ...c, rows: [...c.rows, c.rows[0]] }))), MISMATCH, 'more than one row');
  assert.equal(await run(tweak((c) => ({ ...c, rows: [{ ...c.rows[0], parentId: c.rows[0].parentId ? OTHER : null }] }))), MISMATCH, 'another parent');
  assert.equal(await run(tweak((c) => ({ ...c, rows: [{ ...c.rows[0], sentSha256: H('0') }] }))), MISMATCH, 'a seal of another projection');
  assert.equal(await run(tweak((c) => ({ ...c, rows: [{ ...c.rows[0], sentFields: ['iscustomizable'] }] }))), MISMATCH, 'a seal of a field not carried');
  assert.equal(await run(tweak((c) => (c.ifMatch ? { ...c, ifMatch: 'W/"1"' } : c))), MISMATCH, 'a version the driver does not hold');
  assert.equal(h.sent.length, 0);
  assert.deepEqual(attemptOn(h.dir), h.before);
  // A plan whose API row is a create: the change set would write an API the set has not bound.
  const dir = makeTempDir('mc-batch-');
  const store = open(dir);
  const ctx = createManagedCreateContext({ store, approvals: [], notFoundCode: NOT_FOUND });
  const [fresh] = ctx.begin([planOf(rowsOf('create', NEW_ROWS))]);
  const gate = createDeferredManagedCreateGate();
  gate.bind(store);
  const handle = await runWithManagedCreateSet({ store, entries: [{ token: fresh.token, epoch: fresh.epoch }], classify: driver(fresh.token), batch: h.set.batch }, async () => {
    try { gate.screen({ method: 'POST', url: BATCH_URL, body: ok, headers: CT }); } catch (e) { return e.code; }
    return null;
  });
  assert.equal(handle.value, MISMATCH);
});

test('one seal, one send: no transport or SDK re-send, and a swallowed refusal stops the set', async () => {
  for (const [name, respond, status] of [
    ['a 503', () => ({ statusCode: 503, headers: {}, body: '' }), 503],
    ['a 401', () => ({ statusCode: 401, headers: {}, body: '' }), 401],
    ['a transport failure', () => ({ error: 'socket hang up', code: 'ECONNRESET' }), null],
  ]) {
    const h = await harness({ respond });
    const text = changeset([rootOp(), reqOp(), respOp()]);
    const out = await runWithManagedCreateSet(h.set, async () => {
      await swallow(h.post(text));
      // The SDK, or a caller, sends the same change set again.
      return swallow(h.post(text));
    });
    assert.equal(h.sent.length, 1, `${name}: sent once`);
    assert.equal(out.value.code, MISMATCH, `${name}: the second send is refused`);
    assert.ok(out.facts.every((f) => f.outcome === 'unknown' && f.status === null && f.batchStatus === status), name);
    assert.equal(attemptOn(h.dir).sendWindow.possible, h.before.sendWindow.possible + 1, `${name}: counted once`);
    assert.deepEqual(dispatchedOf(attemptOn(h.dir)), [API, NEW_REQ, NEW_RESP].sort(), `${name}: the seals stay`);
  }
  const h = await harness();
  const out = await runWithManagedCreateSet(h.set, async () => {
    const first = await swallow(h.post(changeset([rootOp(rootBody({ isprivate: false })), reqOp(), respOp()])));
    const second = await swallow(h.post(changeset([rootOp(), reqOp(), respOp()])));
    return [first.code, second.code];
  });
  assert.deepEqual(out.value, [MISMATCH, MISMATCH]);
  assert.match(out.localError.message, /part 1/, 'the first refusal is the one surfaced');
  assert.equal(h.sent.length, 0);
});

test('the captured atomic failure, a failure inside a 200, a contradiction or a lost answer acknowledges nothing and is never re-sent', async () => {
  const run = async (respond) => {
    const h = await harness({ respond });
    const out = await runWithManagedCreateSet(h.set, () => swallow(h.post(changeset([rootOp(), reqOp(), respOp()]))));
    assert.equal(h.sent.length, 1);
    return out.facts;
  };
  const rolledBack = await run(() => answer(412, [failedPart(2)]));
  assert.deepEqual(outcomes(rolledBack), [[1, API, 'unknown', null], [2, NEW_REQ, 'unknown', 412], [3, NEW_RESP, 'unknown', null]]);
  assert.ok(rolledBack.every((f) => f.batchStatus === 412 && JSON.stringify(f.changesetFailure) === JSON.stringify({ contentId: 2, status: 412, code: '0x80040333' })));
  assert.ok(!JSON.stringify(rolledBack).includes('duplicate'), 'no answer text is kept');
  const inner = await run(() => answer(200, [rootPart(1), { ...failedPart(2) }, respPart(3)]));
  assert.deepEqual(inner.map((f) => f.outcome), ['unknown', 'unknown', 'unknown']);
  assert.ok(inner.every((f) => !f.changesetFailure));
  const swapped = await run(() => answer(200, [rootPart(1), reqPart(2, { customapirequestparameterid: OTHER }), respPart(3)]));
  assert.deepEqual(swapped.map((f) => f.outcome), ['unknown', 'conflict', 'unknown']);
  assert.equal(swapped[1].answeredId, OTHER);
  const lostSuffix = await run(() => ({ ...answer(200, [rootPart(1), reqPart(2), respPart(3)]), body: answerText([rootPart(1), reqPart(2), respPart(3)]).split(`--${RC_ID}--`)[0] }));
  assert.deepEqual(lostSuffix.map((f) => f.outcome), ['unknown', 'unknown', 'unknown']);
  const lost = await run(() => { throw new Error('socket closed'); });
  assert.deepEqual(lost.map((f) => f.outcome), ['unknown', 'unknown', 'unknown']);
  // An answer that never arrives while the operation runs: unknown, unanswered.
  const h = await harness({ respond: () => new Promise(() => {}) });
  const out = await runWithManagedCreateSet(h.set, async () => { h.post(changeset([rootOp(), reqOp(), respOp()])); });
  assert.ok(out.facts.length === 3 && out.facts.every((f) => f.outcome === 'unknown' && f.unanswered === true));
});

test('an answer is read per constituent: anything but a complete success is unknown, and a contradiction is a conflict', () => {
  const admitted = { apiBase: API9, boundId: API, constituents: [{ contentId: 1, role: 'root', id: API }, { contentId: 2, role: 'requestParameter', id: NEW_REQ }, { contentId: 3, role: 'responseProperty', id: NEW_RESP }] };
  const read = (res) => readChangesetAnswer(res, admitted).parts.map((p) => p.outcome);
  const all = ['acknowledged', 'acknowledged', 'acknowledged'];
  const unknown = ['unknown', 'unknown', 'unknown'];
  const parts = () => [rootPart(1), reqPart(2), respPart(3)];
  assert.deepEqual(read(answer(200, parts())), all);
  assert.deepEqual(read(answer(200, parts(), { eol: '\n' })), all, 'LF throughout');
  assert.deepEqual(read({ statusCode: 200, headers: {}, body: Buffer.from(answerText(parts())) }), all, 'bytes, and no outer Content-Type');
  const cases = {
    'an outer 204': [answer(204, parts()), unknown],
    'a missing part': [answer(200, [rootPart(1), reqPart(2)]), unknown],
    'a duplicate Content-ID': [answer(200, [rootPart(1), reqPart(2), reqPart(2)]), unknown],
    'a foreign Content-ID': [answer(200, [rootPart(1), reqPart(2), respPart(9)]), unknown],
    'another outer boundary': [{ ...answer(200, parts()), headers: { 'Content-Type': 'multipart/mixed; boundary=batchresponse_0a0a0a0a-0000-4000-8000-000000000009' } }, unknown],
    'two outer Content-Types': [{ ...answer(200, parts()), headers: { 'content-type': `multipart/mixed; boundary=${RB_ID}`, 'Content-Type': `multipart/mixed; boundary=${RB_ID}` } }, unknown],
    'mixed line endings': [{ ...answer(200, parts()), body: answerText(parts()).replace('\r\nContent-ID: 2', '\nContent-ID: 2') }, unknown],
    'an epilogue': [{ ...answer(200, parts()), body: `${answerText(parts())}trailer\r\n` }, unknown],
    'a duplicate part header': [answer(200, [rootPart(1, {}, [`ETag: ${SAVED}`, `etag: ${SAVED}`]), reqPart(2), respPart(3)]), unknown],
    'a root 204': [answer(200, [{ ...rootPart(1), status: 'HTTP/1.1 204 No Content', text: '' }, reqPart(2), respPart(3)]), unknown],
    'a child 200': [answer(200, [rootPart(1), { ...reqPart(2), status: 'HTTP/1.1 200 OK' }, respPart(3)]), unknown],
    'no etag in a body': [answer(200, [rootPart(1), reqPart(2, { '@odata.etag': undefined }), respPart(3)]), unknown],
    'a root ETag header other than its body': [answer(200, [rootPart(1, {}, ['ETag: W/"1"']), reqPart(2), respPart(3)]), unknown],
    'a duplicate body key': [answer(200, [rootPart(1), { ...reqPart(2), text: JSON.stringify(reqPart(2).body).replace('{', `{"customapirequestparameterid":"${OTHER}",`) }, respPart(3)]), unknown],
    'a context of another API base': [answer(200, [rootPart(1, { '@odata.context': 'https://fabrikam.crm.dynamics.com/api/data/v9.0/$metadata#customapis(customapiid)/$entity' }), reqPart(2), respPart(3)]), unknown],
    'an alternate-key identity header': [answer(200, [rootPart(1), reqPart(2, {}, [...PART_HEADERS, `OData-EntityId: ${API9}/customapirequestparameters(uniquename='Extra')`]), respPart(3)]), unknown],
    'no primary key': [answer(200, [rootPart(1, { customapiid: undefined }), reqPart(2), respPart(3)]), unknown],
    'a root body without its key, however well its OData-EntityId reads': [answer(200, [rootPart(1, { customapiid: undefined }, [`ETag: ${SAVED}`, `OData-EntityId: ${API9}/customapis(${API})`]), reqPart(2), respPart(3)]), unknown],
    'a child body without its key, however well its Location reads': [answer(200, [rootPart(1), reqPart(2, { customapirequestparameterid: undefined }, [...PART_HEADERS, `Location: ${API9}/customapirequestparameters(${NEW_REQ})`]), respPart(3)]), unknown],
    'a child key that is no id': [answer(200, [rootPart(1), reqPart(2, { customapirequestparameterid: 'Extra' }), respPart(3)]), unknown],
    'a context that did not select the key': [answer(200, [rootPart(1), reqPart(2, { '@odata.context': `${API9}/$metadata#customapirequestparameters/$entity` }), respPart(3)]), unknown],
    'a context that selected another column': [answer(200, [rootPart(1), reqPart(2, { '@odata.context': `${API9}/$metadata#customapirequestparameters(uniquename)/$entity` }), respPart(3)]), unknown],
    'a body without its key and a Location naming another row': [answer(200, [rootPart(1), reqPart(2, { customapirequestparameterid: undefined }, [...PART_HEADERS, `Location: ${API9}/customapirequestparameters(${OTHER})`]), respPart(3)]), ['unknown', 'conflict', 'unknown']],
    'a child naming another API': [answer(200, [rootPart(1), reqPart(2, { _customapiid_value: OTHER }), respPart(3)]), ['unknown', 'conflict', 'unknown']],
    'a child answered as the other child table': [answer(200, [rootPart(1), reqPart(2, { '@odata.context': `${API9}/$metadata#customapiresponseproperties(customapiresponsepropertyid)/$entity` }), respPart(3)]), ['unknown', 'conflict', 'unknown']],
    'a Location naming another row': [answer(200, [rootPart(1, {}, [`ETag: ${SAVED}`, `Location: ${API9}/customapis(${OTHER})`]), reqPart(2), respPart(3)]), ['conflict', 'unknown', 'unknown']],
    'a root answered under another id': [answer(200, [rootPart(1, { customapiid: OTHER }), reqPart(2), respPart(3)]), ['conflict', 'unknown', 'unknown']],
    'a conflict in an incomplete answer': [answer(200, [rootPart(1), reqPart(2, { customapirequestparameterid: OTHER })]), ['unknown', 'conflict', 'unknown']],
    'a failed part of another set': [answer(412, [{ ...failedPart(9) }]), unknown],
  };
  for (const [name, [res, want]] of Object.entries(cases)) assert.deepEqual(read(res), want, name);
  assert.equal(readChangesetAnswer(answer(412, [failedPart(9)]), admitted).failure, undefined, 'a failure of a part the set did not send is no diagnostic');
  assert.equal(readChangesetAnswer(answer(200, [rootPart(1), failedPart(2), respPart(3)]), admitted).failure, undefined, 'a failure under a 200 is not the atomic one');
});

test('a checked run keeps the children\'s acknowledgements and never receipts the API\'s PATCH as a created root', async () => {
  const h = await harness();
  const out = await h.ctx.run({ attempts: h.attempts, classify: h.set.classify, batch: h.set.batch, acceptResult: () => true }, () => h.post(changeset([rootOp(), reqOp(), respOp()])));
  assert.equal(out.checked, true);
  assert.deepEqual(h.ctx.facts(h.token).map((f) => [f.id, f.mode, f.outcome]), [[API, 'update', 'acknowledged'], [NEW_REQ, 'create', 'acknowledged'], [NEW_RESP, 'create', 'acknowledged']]);
  assert.ok(!attemptOn(h.dir).acknowledgedRoot, 'an edit of a bound API is no root create');
  const failed = await harness({ respond: () => answer(412, [failedPart(2)]) });
  const bad = await failed.ctx.run({ attempts: failed.attempts, classify: failed.set.classify, batch: failed.set.batch, acceptResult: () => true }, () => swallow(failed.post(changeset([rootOp(), reqOp(), respOp()]))));
  assert.equal(bad.checked, false);
  assert.ok(failed.ctx.facts(failed.token).every((f) => f.outcome === 'unknown'));
  assert.ok(!attemptOn(failed.dir).acknowledgedRoot);
  // A child answered without its own key in its body, though its Location names it: nothing is acknowledged, and the
  // exact fresh read that follows cannot turn the answer into a child-create receipt or created ownership.
  const keyless = await harness({ respond: () => answer(200, [rootPart(1), reqPart(2, { customapirequestparameterid: undefined }, [...PART_HEADERS, `Location: ${API9}/customapirequestparameters(${NEW_REQ})`]), respPart(3)]) });
  const run = await keyless.ctx.run({ attempts: keyless.attempts, classify: keyless.set.classify, batch: keyless.set.batch, acceptResult: () => true }, () => keyless.post(changeset([rootOp(), reqOp(), respOp()])));
  assert.equal(run.checked, false);
  assert.deepEqual(keyless.ctx.facts(keyless.token).map((f) => f.outcome), ['unknown', 'unknown', 'unknown']);
  const receipts = [];
  const noteSaved = keyless.store.noteSaved;
  keyless.store.noteSaved = (token, details) => {
    receipts.push(...((details && details.acknowledgedChildCreates) || []).map((c) => c.id));
    return noteSaved(token, details);
  };
  const [settled] = keyless.ctx.settle([{ token: keyless.token, observation: readOf(rowsOf('update', NEW_ROWS)) }]);
  assert.notEqual(settled.verdict.action, 'commit');
  assert.deepEqual(receipts, []);
  const group = open(keyless.dir).snapshot().envelope.groups.find((g) => g.family === 'customApi');
  assert.ok(!group.records.some((r) => r.id === NEW_REQ || r.id === NEW_RESP), 'no created binding for a child the answer did not prove');
});

test('the request reader alone: the captured request reads as the API\'s edit and one new child; the hand-made one does not', () => {
  const config = batchConfig({ apiBase: API9, solution: SOL });
  const parsed = parseCustomApiChangeset({ url: BATCH_URL, body: changeset([rootOp(), reqOp()]), headers: CT }, config, { limit: 4 });
  assert.equal(parsed.boundId, API);
  assert.deepEqual(parsed.constituents.map((k) => [k.contentId, k.role, k.id, k.ifMatch]), [[1, 'root', API, HELD], [2, 'requestParameter', NEW_REQ, undefined]]);
  assert.throws(() => parseCustomApiChangeset({ url: BATCH_URL, body: changeset([rootOp(), reqOp(), respOp()]), headers: CT }, config, { limit: 2 }), { code: MISMATCH }, 'never read past what the set prepared');
  const unsolved = batchConfig({ apiBase: API9, solution: null });
  const noSolution = changeset([reqOp(reqBody(), { headers: ['Content-Type: application/json;type=entry', 'Prefer: return=representation'] }), respOp(respBody(), { headers: ['Content-Type: application/json;type=entry', 'Prefer: return=representation'] })]);
  assert.equal(parseCustomApiChangeset({ url: BATCH_URL, body: noSolution, headers: CT }, unsolved).constituents.length, 2, 'no solution header when the SDK context has none');
  assert.throws(() => parseCustomApiChangeset({ url: BATCH_URL, body: changeset([reqOp(), respOp()]), headers: CT }, unsolved), { code: MISMATCH }, 'and none added');
  // Ordinary spaces around the boundary parameter's '=' are its grammar, as the client's own multipart reader reads it;
  // anything more than spaces, or a second parameter, is still refused.
  const spaced = (decl) => parseCustomApiChangeset({ url: BATCH_URL, body: changeset([rootOp(), reqOp()], { boundary: `Content-Type: ${decl}` }), headers: { 'Content-Type': `multipart/mixed; boundary = ${BATCH_ID}` } }, config);
  assert.equal(spaced(`multipart/mixed; boundary = "${CS_ID}"`).constituents.length, 2);
  assert.equal(spaced(`multipart/mixed;boundary =${CS_ID}`).constituents.length, 2);
  for (const decl of [`multipart/mixed; boundary =\t"${CS_ID}"`, `multipart/mixed; boundary = "${CS_ID}"; charset=utf-8`, `multipart/mixed; boundary = "${CS_ID}`, `multipart/mixed; boundary = ""`]) {
    assert.throws(() => spaced(decl), { code: MISMATCH }, decl);
  }
});
