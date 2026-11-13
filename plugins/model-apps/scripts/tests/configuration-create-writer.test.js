'use strict';
// The default build's writer for new configuration rows (lib/configuration-create-writer.js): one flat POST per new row at
// the id lib/configuration-create-plan.js compiled, sent once through the build's raw client with a header set the writer
// decides alone, a durable receipt (lib/configuration-create-state.js) sealed before each send, an exact-row GET proof after
// it, and one header-free publication action for a new published rule. Every request here reaches a fake org through the
// real createAzHttpClient (lib/sdk-http-client.js), so a retry the transport would make is visible as a second request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const A = require('../lib/configuration-artifacts.js');
const P = require('../lib/configuration-create-plan.js');
const S = require('../lib/configuration-create-state.js');
const R = require('../lib/configuration-create-recovery.js');
const W = require('../lib/configuration-create-writer.js');

const SOL = 'ContosoSol';
const APP = 'contoso_app';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
// Private inputs: each distinct, so a leak of any one into the receipt is found by a plain substring search.
const VALUE = 'private-value-7f3a';
const CONNECTION = 'private-connection-9c1e';
const DEFAULT = 'private-default-41b2';
const SCHEMA = '{"private-schema":"5d0e"}';
const PRIVATE = [VALUE, CONNECTION, DEFAULT, SCHEMA];
const spec = (over = {}) => ({
  minimumPluginVersion: '2.21.0', solution: { uniqueName: SOL, publisherPrefix: 'contoso' },
  environmentVariables: [
    { schemaName: 'contoso_V', type: 'string', defaultValue: DEFAULT },
    { schemaName: 'contoso_J', type: 'json', valueSchema: SCHEMA, name: 'J', description: 'D', isRequired: true },
  ],
  connectionReferences: [{ logicalName: 'contoso_c1', connectorId: SP }],
  customApis: [
    { uniqueName: 'contoso_Calc', isFunction: true, requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'B', type: 'entityReference', entityLogicalName: 'contact', isOptional: true }], responseProperties: [{ uniqueName: 'R', type: 'string', description: 'Res' }] },
  ],
  duplicateDetectionRules: [
    { key: 'email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }, { key: 'f', column: 'lastname', match: 'firstCharacters', characters: 3 }] },
    { key: 'x', name: 'Unpub', entity: 'contact', status: 'unpublished', conditions: [{ key: 'z', column: 'lastname', match: 'exact' }] },
  ],
  ...over,
});
const deploy = () => ({ EnvironmentVariables: [{ SchemaName: 'contoso_V', Value: VALUE }], ConnectionReferences: [{ LogicalName: 'contoso_c1', ConnectionId: CONNECTION }] });
// One root of each kind; together their rows are all eight row kinds.
const ROOTS = [['environmentVariable', 'contoso_V'], ['environmentVariable', 'contoso_J'], ['connectionReference', 'contoso_c1'], ['customApi', 'contoso_Calc'], ['duplicateRule', 'email'], ['duplicateRule', 'x']];
const KT = P.CONFIGURATION_CREATE_KIND_TABLE;
const RKT = P.CONFIGURATION_CREATE_RECEIPT_KIND_TABLE;
const PUBLISH = /^\/duplicaterules\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.PublishDuplicateRule$/;

const compile = (kind, key, { s = spec(), solution = SOL, d = deploy(), baseline, additions } = {}) => {
  const c = P.compileConfigurationCreateUnit(s, { kind, key, bindings: A.readDeploymentBindings(d, s), solution, ...(baseline ? { baseline, additions } : {}) });
  assert.equal(c.ok, true, `${kind} ${key}: ${c.reason}`);
  return c;
};
const solutionHeaderOf = (headers) => {
  const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === 'mscrm.solutionuniquename');
  return k === undefined ? undefined : headers[k];
};
const isWrite = (q) => String(q.method).toUpperCase() !== 'GET';
const lost = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

// The fake org behind the real client. `fault({ method, path, body, org })` may answer instead of the org:
//   { lose: true }               the org commits the request, then the answer is lost (the socket closes)
//   { drop: true }               the request never reaches the org, and no answer comes back
//   { answer, commit? }          this answer instead of the org's (after the org commits it, with commit: true)
//   { transform }                the org's own answer, as transform(answer) returns it ({ statusCode, headers, body: text })
// Anything else lets the org answer.
async function harness({ fault, leaseDeps, contextSolution = SOL, workspaceDir = makeTempDir('cfg-writer-ws-'), publicationReads, membershipOrg = false, pageSize, liveRowShape } = {}) {
  const org = createConfigOrg({ tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }], solution: { uniqueName: SOL, version: '1.0.0.0', prefix: 'contoso' }, childrenJoin: membershipOrg, ...(pageSize ? { pageSize } : {}), ...(liveRowShape ? { liveRowShape } : {}) });
  const request = async (req) => {
    const method = String(req.method).toUpperCase();
    const where = decodeURIComponent(new URL(req.url).pathname + new URL(req.url).search).replace(/^\/api\/data\/v9\.\d/, '');
    const f = fault ? await fault({ method, path: where, body: req.body ? JSON.parse(String(req.body)) : undefined, org }) : null;
    if (f && f.transform) return f.transform(await org.request(req));
    if (f && f.lose) { await org.request(req); throw lost(); }
    if (f && f.drop) { org.requests.push({ method, path: where, dropped: true, headers: req.headers, body: req.body ? JSON.parse(String(req.body)) : undefined }); throw lost(); }
    if (f && f.answer) {
      if (f.commit) await org.request(req);
      else org.requests.push({ method, path: where, faulted: true, headers: req.headers, body: req.body ? JSON.parse(String(req.body)) : undefined });
      return f.answer;
    }
    return org.request(req);
  };
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request, sleep: async () => {}, sendOnce: configurationSendOnce });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('cfg-writer-sdk-')), instanceUrl: org.origin, httpClient, solutionUniqueName: SOL });
  await sdk.initWorkspace();
  W.attachConfigurationCreateBridge(sdk, { httpClient, apiUrl: (p) => sdk.dataverse.apiUrl(p) });
  const context = S.createStateContext({ environmentUrl: org.origin, solutionUniqueName: contextSolution, appUniqueName: APP });
  let waited = 0;
  const writer = W.createDefaultConfigurationWriter({
    bridge: W.configurationCreateBridgeOf(sdk), dataverse: sdk.dataverse, workspaceDir, context, ...(leaseDeps ? { leaseDeps } : {}),
    sleep: async () => { waited += 1; }, ...(publicationReads ? { publicationReads } : {}),
  });
  const writes = (since = 0) => org.requests.slice(since).filter(isWrite);
  const saved = () => S.readConfigurationCreateState(workspaceDir, { kindTable: RKT });
  return { org, sdk, httpClient, writer, workspaceDir, context, writes, saved, waits: () => waited };
}
const preflight = (h, declarations) => R.preflightConfigurationCreates({ workspaceDir: h.workspaceDir, context: h.context, kindTable: RKT, declarations, configurationWork: true });
async function halted(promise) {
  try { await promise; } catch (error) { assert.equal(error.name, 'ConfigurationCreateHalt', error.stack); return error; }
  assert.fail('the writer did not stop');
}
const rowsAt = (h, kind, id) => h.org.rows(KT[kind].entitySet).filter((r) => String(r[KT[kind].idColumn]).toLowerCase() === id);
const unitRow = (c, kind) => c.unit.rows.find((r) => r.kind === kind && r.role === 'create');
const rootOfKind = { 'env-definition': ['environmentVariable', 'contoso_V'], 'env-value': ['environmentVariable', 'contoso_V'], 'connection-reference': ['connectionReference', 'contoso_c1'], 'custom-api': ['customApi', 'contoso_Calc'], 'api-request': ['customApi', 'contoso_Calc'], 'api-response': ['customApi', 'contoso_Calc'], 'duplicate-rule': ['duplicateRule', 'email'], 'rule-condition': ['duplicateRule', 'email'] };
const declarationOf = (c) => ({ kind: c.unit.root.kind, key: c.unit.root.key, names: [c.unit.root.key] });

test('acknowledgment: only a direct 201 or 204 that names the created id (or names none, for a 204) counts', () => {
  const id = '0b7c6f5e-0000-4000-8000-000000000001';
  const other = '0b7c6f5e-0000-4000-8000-000000000002';
  const at = (x) => `https://contoso.crm.dynamics.com/api/data/v9.2/duplicaterules(${x})`;
  const ack = (answer) => W.classifyCreateAcknowledgment(answer, { id, idColumn: 'duplicateruleid' });
  assert.deepEqual(ack({ status: 204, headers: { 'OData-EntityId': at(id) }, body: '' }), { ok: true });
  assert.deepEqual(ack({ status: 204, headers: { 'odata-entityid': at(id.toUpperCase()) } }), { ok: true });
  assert.deepEqual(ack({ status: 204, headers: {} }), { ok: true });
  assert.deepEqual(ack({ status: 201, headers: {}, body: { duplicateruleid: id } }), { ok: true });
  assert.deepEqual(ack({ status: 201, headers: { Location: at(id) }, body: {} }), { ok: true });
  for (const [answer, why] of [
    [{ status: 204, headers: { 'OData-EntityId': at(other) } }, /another row/],
    [{ status: 204, headers: { 'OData-EntityId': 'https://contoso.crm.dynamics.com/api/data/v9.2/duplicaterules' } }, /no readable id/],
    [{ status: 204, headers: {}, body: 'x' }, /carried a body/],
    [{ status: 201, headers: {}, body: { duplicateruleid: other } }, /another row/],
    [{ status: 201, headers: {}, body: {} }, /names no row/],
    [{ status: 201, headers: {}, body: '[]' }, /no readable body/],
    [{ status: 202, headers: {}, body: '' }, /answered 202/],
    [{ status: 207, headers: {}, body: '' }, /answered 207/],
    [{ status: 200, headers: { 'Content-Type': 'multipart/mixed; boundary=b' }, body: '--b' }, /answered 200/],
    [{ status: 204, headers: { 'Content-Type': 'multipart/mixed; boundary=b' } }, /multipart/],
    [{ status: 201, headers: {}, body: { duplicateruleid: id, error: { code: '0x1', message: 'm' } } }, /an error/],
    [{ status: 302, headers: { Location: at(id) } }, /answered 302/],
    [{ status: 400, headers: {}, body: { error: { code: '0x80040333' } } }, /answered 400/],
    [{ status: 412, headers: {} }, /answered 412/],
    [{ status: 500, headers: {} }, /answered 500/],
    [null, /not answered/],
  ]) {
    const got = ack(answer);
    assert.equal(got.ok, false, JSON.stringify(answer));
    assert.match(got.reason, why);
  }
  assert.throws(() => W.classifyCreateAcknowledgment({ status: 204 }, { id: 'nope' }), TypeError);
});

test('acknowledgment: the publication counts only as a complete 200 with a JSON object, or a 204, with no error', () => {
  const pub = W.classifyNewRulePublicationAcknowledgment;
  assert.deepEqual(pub({ status: 200, headers: {}, body: { asyncoperationid: 'x' } }), { ok: true });
  assert.deepEqual(pub({ status: 200, headers: {}, body: {} }), { ok: true });
  assert.deepEqual(pub({ status: 204, headers: {} }), { ok: true });
  for (const answer of [
    { status: 202, headers: {}, body: {} }, { status: 207, headers: {}, body: {} }, { status: 200, headers: {}, body: 'not json' },
    { status: 200, headers: { 'content-type': 'multipart/mixed; boundary=b' }, body: {} }, { status: 200, headers: {}, body: { error: { code: '0x1' } } },
    { status: 400, headers: {}, body: {} }, { status: 500, headers: {}, body: {} }, undefined,
  ]) assert.equal(pub(answer).ok, false, JSON.stringify(answer));
});

test('receipt: a unit compiled for each of the eight row kinds round-trips through prepareCreateUnit, serialize and parse unchanged', async () => {
  const seen = new Set();
  for (const [kind, key] of ROOTS) {
    const c = compile(kind, key);
    const ws = makeTempDir('cfg-writer-rt-');
    const context = S.createStateContext({ environmentUrl: 'https://contoso.crm.dynamics.com', solutionUniqueName: SOL, appUniqueName: APP });
    S.prepareCreateUnit(ws, { kindTable: RKT, context, unit: { root: { ...c.unit.root }, publicIntentSha256: c.unit.publicIntentSha256, publicPlanSha256: c.unit.publicPlanSha256, publicationRequired: c.unit.publicationRequired, rows: c.unit.rows.map((r) => ({ ...r })) } });
    const bytes = fs.readFileSync(path.join(ws, S.STATE_FILE), 'utf8');
    const state = S.parseCreateState(bytes, { kindTable: RKT });
    assert.equal(S.serializeCreateState(state), bytes, `${kind} ${key}: the saved form is the canonical one`);
    const [u] = state.units;
    assert.deepEqual(u.root, { kind: c.unit.root.kind, key: c.unit.root.key, id: c.unit.root.id });
    assert.equal(u.publicIntentSha256, c.unit.publicIntentSha256);
    assert.equal(u.publicPlanSha256, c.unit.publicPlanSha256);
    const pick = (r) => ({ kind: r.kind, key: r.key, id: r.id, parentId: r.parentId, role: r.role, public: r.public });
    assert.deepEqual(u.rows.map(pick), c.unit.rows.map(pick), `${kind} ${key}: every row as compiled`);
    for (const r of u.rows) { seen.add(r.kind); assert.equal(r.dispatch, 'prepared'); }
    for (const secret of PRIVATE) assert.ok(!bytes.includes(secret), `${kind} ${key}: no private input on disk`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(KT).sort(), 'all eight row kinds');
});

test('execute: every new row is one flat POST at its compiled id, with the closed header matrix, a GET proof after it, and the receipt removed at the end', async () => {
  const h = await harness({ membershipOrg: true });
  const members = [];
  for (const [kind, key] of ROOTS) {
    const c = compile(kind, key);
    const mark = h.org.requests.length;
    const done = await h.writer.executeCreateUnit(c, { membership: async (items) => { members.push(...items); return []; } });
    assert.equal(done.rootId, c.unit.root.id);
    const sent = h.org.requests.slice(mark);
    const posts = sent.filter((q) => q.method === 'POST' && !PUBLISH.test(q.path));
    const created = c.unit.rows.filter((r) => r.role === 'create');
    assert.deepEqual(done.created, created.map((r) => r.id));
    assert.equal(posts.length, created.length, `${kind} ${key}: one POST per new row`);
    created.forEach((row, i) => {
      const q = posts[i];
      const k = KT[row.kind];
      assert.equal(q.path, `/${k.entitySet}`, `${row.kind}: a flat POST to its own set, no query`);
      assert.equal(q.body[k.idColumn], row.id, `${row.kind}: at the compiled id`);
      assert.ok(Object.values(q.body).every((v) => !Array.isArray(v) && !(v && typeof v === 'object')), `${row.kind}: no nested row (no deep insert)`);
      assert.equal(solutionHeaderOf(q.headers), k.solutionHeader ? SOL : undefined, `${row.kind}: the solution header ${k.solutionHeader ? 'is the unit\'s solution' : 'is absent'}`);
      for (const name of Object.keys(q.headers || {})) assert.doesNotMatch(name, /^if-(none-)?match$/i, `${row.kind}: no ETag precondition`);
      assert.ok(!Object.keys(q.body).some((col) => /plugintypeid/i.test(col)), `${row.kind}: no plug-in type`);
      const at = sent.indexOf(q);
      const next = sent.slice(at + 1).find((x) => x.method === 'GET');
      assert.ok(next && next.path.startsWith(`/${k.entitySet}(${row.id})`), `${row.kind}: the proof is a GET of that exact row, before anything else is sent (${next && next.path})`);
      assert.ok(sent.slice(at + 1, sent.indexOf(next)).every((x) => x.method === 'GET'));
      assert.equal(rowsAt(h, row.kind, row.id).length, 1);
    });
    const publications = sent.filter((q) => PUBLISH.test(q.path));
    if (c.unit.publicationRequired) {
      assert.equal(publications.length, 1, `${key}: one publication`);
      assert.deepEqual(publications[0].body, {});
      assert.equal(solutionHeaderOf(publications[0].headers), undefined, 'the publication carries no solution header');
      assert.equal(PUBLISH.exec(publications[0].path)[1], c.unit.root.id);
      assert.equal(sent.indexOf(publications[0]) > sent.indexOf(posts[posts.length - 1]), true, 'after every row');
    } else {
      assert.equal(publications.length, 0, `${kind} ${key}: no publication`);
    }
  }
  assert.ok(members.length > 0 && members.every((m) => m.kind !== 'environmentVariableValue'), 'a value row is never offered for membership');
  assert.equal(h.org.rows('duplicaterules').find((r) => r.name === 'Same email').statecode, 1, 'the published rule reads published');
  assert.equal(h.org.rows('duplicaterules').find((r) => r.name === 'Unpub').statecode, 0, 'the unpublished rule stays unpublished');
  const st = h.saved();
  assert.deepEqual(st ? st.units : [], [], 'every unit was removed from the receipt');
  assert.deepEqual(h.org.unexpected, []);
});

for (const kind of Object.keys(KT)) {
  test(`lost answer after a committed ${kind} create: the build stops pending, never sends it again or at a fresh id, and the next preflight stops with nothing sent`, async () => {
    const [rootKind, key] = rootOfKind[kind];
    const c = compile(rootKind, key);
    const row = unitRow(c, kind);
    const h = await harness({ fault: ({ method, body }) => method === 'POST' && body && body[KT[kind].idColumn] === row.id ? { lose: true } : null });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, 'configuration-create-pending');
    assert.equal(error.dispatched, true);
    const posts = h.writes().filter((q) => q.method === 'POST');
    assert.equal(posts.filter((q) => q.body[KT[kind].idColumn] === row.id).length, 1, 'the create was sent once');
    assert.equal(posts[posts.length - 1].body[KT[kind].idColumn], row.id, 'nothing was sent after it');
    assert.equal(rowsAt(h, kind, row.id).length, 1);
    assert.equal(h.org.rows(KT[kind].entitySet).length, 1, 'no row at a fresh id');
    const [u] = h.saved().units;
    assert.equal(u.rows.find((r) => r.id === row.id).dispatch, 'dispatched', 'the receipt says possibly sent');
    const mark = h.org.requests.length;
    assert.throws(() => preflight(h, [declarationOf(c)]), (e) => e.code === 'configuration-create-pending');
    assert.equal(h.org.requests.length, mark, 'the preflight sent nothing');
  });
}

test('a held request answered by nothing (the row is not there yet; a later read would 404) stops pending and is never sent again', async () => {
  const c = compile('customApi', 'contoso_Calc');
  const root = c.unit.root.id;
  const h = await harness({ fault: ({ method, body }) => method === 'POST' && body && body.customapiid === root ? { drop: true } : null });
  const error = await halted(h.writer.executeCreateUnit(c));
  assert.equal(error.code, 'configuration-create-pending');
  assert.equal(h.org.rows('customapis').length, 0, 'the early read would answer 404');
  assert.equal(h.writes().filter((q) => q.method === 'POST').length, 1, 'the writer sent the create once');
  // The request lands later (the held request is released): the row is now there, created once, at the compiled id.
  await h.org.request({ url: `${h.org.origin}/api/data/v9.2${P.compiledRowRequest(c.handle, root).path}`, method: 'POST', headers: { 'content-type': 'application/json' }, body: P.compiledRowRequest(c.handle, root).body });
  assert.throws(() => preflight(h, [declarationOf(c)]), (e) => e.code === 'configuration-create-pending');
  // A second compile of the same declaration derives the same id: there is no fresh id to create a second row at.
  assert.equal(compile('customApi', 'contoso_Calc').unit.root.id, root);
  assert.equal(h.org.rows('customapis').length, 1);
});

test('a complete non-2xx answer after the seal is not proof that nothing was created: pending, one attempt', async () => {
  for (const answer of [
    { statusCode: 400, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"0x80040333","message":"exists"}}' },
    { statusCode: 202, headers: {}, body: '' },
    { statusCode: 207, headers: { 'content-type': 'application/json' }, body: '{}' },
    { statusCode: 200, headers: { 'content-type': 'multipart/mixed; boundary=b' }, body: '--b--' },
    { statusCode: 401, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"0x80072560","message":"x"}}' },
    { statusCode: 403, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"0x80040220","message":"x"}}' },
    { statusCode: 404, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"0x80040217","message":"x"}}' },
  ]) {
    const c = compile('connectionReference', 'contoso_c1');
    const h = await harness({ fault: ({ method }) => method === 'POST' ? { answer } : null });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, 'configuration-create-pending', String(answer.statusCode));
    assert.equal(h.writes().length, 1, `${answer.statusCode}: one attempt`);
  }
});

test('send-once is the client\'s: a 401, 429 or 5xx answer to a create is not retried by the transport', async () => {
  for (const status of [401, 429, 500, 503]) {
    const c = compile('environmentVariable', 'contoso_J');
    let n = 0;
    const h = await harness({ fault: ({ method }) => method === 'POST' && ++n === 1 ? { answer: { statusCode: status, headers: { 'content-type': 'application/json', 'retry-after': '0' }, body: '{"error":{"code":"0x80040216","message":"x"}}' } } : null });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, 'configuration-create-pending', String(status));
    assert.equal(h.writes().length, 1, `${status}: exactly one attempt reached the service`);
  }
});

test('an inherited mixed-case solution name is the header as compiled; a unit compiled for another solution is refused before anything is saved or sent', async () => {
  const s = spec({ solution: { uniqueName: 'contosoSOL', publisherPrefix: 'contoso' } });
  const c = P.compileConfigurationCreateUnit(s, { kind: 'connectionReference', key: 'contoso_c1', bindings: A.readDeploymentBindings(deploy(), s), solution: 'contosoSOL' });
  const h = await harness();
  await h.writer.executeCreateUnit(c);
  assert.equal(solutionHeaderOf(h.writes()[0].headers), 'contosoSOL');
  const other = compile('customApi', 'contoso_Calc', { solution: 'OtherSol' });
  const mark = h.org.requests.length;
  const error = await halted(h.writer.executeCreateUnit(other));
  assert.equal(error.code, 'configuration-create-context-mismatch');
  assert.equal(error.dispatched, false);
  assert.equal(h.org.requests.length, mark);
  assert.deepEqual(h.saved().units, []);
});

test('a compiled unit is executed once: the same handle again is refused with nothing read or sent', async () => {
  const c = compile('connectionReference', 'contoso_c1');
  const h = await harness();
  await h.writer.executeCreateUnit(c);
  const mark = h.org.requests.length;
  const error = await halted(h.writer.executeCreateUnit(c));
  assert.equal(error.code, 'configuration-create-shape-refused');
  assert.equal(h.org.requests.length, mark);
});

test('the proof read: a different row, missing columns, changed content, a missing row or an unexpected child each stop, and nothing is sent again', async () => {
  const c0 = compile('customApi', 'contoso_Calc');
  const root = c0.unit.root.id;
  const cases = [
    ['a read of another row', 'configuration-create-graph-unreadable', ({ method, path: p }) => method === 'GET' && p.startsWith(`/customapis(${root})`) ? { answer: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customapiid: '0b7c6f5e-0000-4000-8000-0000000000ff', uniquename: 'contoso_Calc' }) } } : null],
    ['missing columns', 'configuration-create-graph-unreadable', ({ method, path: p }) => method === 'GET' && p.startsWith(`/customapis(${root})`) ? { answer: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customapiid: root }) } } : null],
    ['changed content', 'configuration-create-content-conflict', ({ method, path: p, org }) => { if (method === 'GET' && p.startsWith(`/customapis(${root})`)) { const r = org.rows('customapis')[0]; if (r) r.displayname = 'Edited'; } return null; }],
    ['a row deleted before the read', 'configuration-create-row-missing', ({ method, path: p, org }) => { if (method === 'GET' && p.startsWith(`/customapis(${root})`)) org.sets.get('customapis').clear(); return null; }],
  ];
  for (const [why, code, fault] of cases) {
    const c = compile('customApi', 'contoso_Calc');
    const h = await harness({ fault });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, code, why);
    assert.equal(h.writes().length, 1, `${why}: the root only, never again`);
    assert.throws(() => preflight(h, [declarationOf(c)]), (e) => e.code === 'configuration-create-pending', why);
  }
  // An acknowledged child edited before the whole-graph read, and a child the unit does not name.
  for (const [why, mutate] of [
    ['an acknowledged child later edited', (org) => { org.rows('customapirequestparameters')[0].displayname = 'Edited'; }],
    ['a child the unit does not name', (org) => { org.sets.get('customapirequestparameters').set('0b7c6f5e-0000-4000-8000-0000000000ee', { ...org.rows('customapirequestparameters')[0], customapirequestparameterid: '0b7c6f5e-0000-4000-8000-0000000000ee', uniquename: 'Z', name: 'Z' }); }],
  ]) {
    const c = compile('customApi', 'contoso_Calc');
    let posts = 0;
    const created = c.unit.rows.filter((r) => r.role === 'create').length;
    const h = await harness({ fault: ({ method, org }) => { if (method === 'POST') posts += 1; else if (posts === created && !org.__edited) { org.__edited = true; mutate(org); } return null; } });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, 'configuration-create-content-conflict', why);
    assert.equal(h.writes().length, created, `${why}: nothing sent again`);
  }
});

test('two new children with the second unanswered: the first is verified, the second stays possibly sent, and nothing follows', async () => {
  const c = compile('duplicateRule', 'email');
  const [first, second] = c.unit.rows.filter((r) => r.kind === 'rule-condition');
  const h = await harness({ fault: ({ method, body }) => method === 'POST' && body && body.duplicateruleconditionid === second.id ? { lose: true } : null });
  const error = await halted(h.writer.executeCreateUnit(c));
  assert.equal(error.code, 'configuration-create-pending');
  const [u] = h.saved().units;
  assert.equal(u.rows.find((r) => r.id === first.id).dispatch, 'verified');
  assert.equal(u.rows.find((r) => r.id === second.id).dispatch, 'dispatched');
  assert.equal(u.publication && u.publication.dispatch === 'dispatched', false, 'the publication was not sent');
  assert.equal(h.writes().filter((q) => PUBLISH.test(q.path)).length, 0);
});

test('membership: a row not proven a member stops membership-incomplete before the publication', async () => {
  const c = compile('duplicateRule', 'email');
  const h = await harness();
  const error = await halted(h.writer.executeCreateUnit(c, { membership: async (items) => items.slice(0, 1) }));
  assert.equal(error.code, 'configuration-create-membership-incomplete');
  assert.equal(h.writes().filter((q) => PUBLISH.test(q.path)).length, 0);
  const h2 = await harness();
  const error2 = await halted(h2.writer.executeCreateUnit(compile('duplicateRule', 'email'), { membership: async () => { throw new Error('read failed'); } }));
  assert.equal(error2.code, 'configuration-create-membership-incomplete');
});

test('publication: a lost, refused or malformed answer, or a rule that never reads published, stops publication-pending after ONE action', async () => {
  const cases = [
    ['lost after commit', { lose: true }],
    ['never reached the org', { drop: true }],
    ['202', { answer: { statusCode: 202, headers: {}, body: '' } }],
    ['500', { answer: { statusCode: 500, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"0x80040216","message":"x"}}' } }],
    ['a 200 that is not JSON', { answer: { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'queued' } }],
    ['acknowledged but never published', { answer: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"asyncoperationid":"0b7c6f5e-0000-4000-8000-0000000000aa"}' } }],
  ];
  for (const [why, f] of cases) {
    const c = compile('duplicateRule', 'email');
    const h = await harness({ fault: ({ method, path: p }) => method === 'POST' && PUBLISH.test(p) ? f : null, publicationReads: 4 });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, 'configuration-create-publication-pending', why);
    assert.equal(h.writes().filter((q) => PUBLISH.test(q.path)).length, 1, `${why}: one action`);
    const [u] = h.saved().units;
    assert.ok(['dispatched', 'acknowledged'].includes(u.publication.dispatch), `${why}: ${u.publication.dispatch}`);
    if (why === 'acknowledged but never published') { assert.equal(u.publication.dispatch, 'acknowledged'); assert.equal(h.waits(), 3, 'four reads, three waits'); }
    assert.throws(() => preflight(h, [declarationOf(c)]), (e) => e.code === 'configuration-create-publication-pending', why);
  }
});

test('publication: a rule edited between the proof and the action is caught by the last graph read, after one action', async () => {
  const c = compile('duplicateRule', 'email');
  const h = await harness({ fault: ({ method, path: p, org }) => { if (method === 'POST' && PUBLISH.test(p)) org.rows('duplicateruleconditions')[0].ignoreblankvalues = true; return null; } });
  const error = await halted(h.writer.executeCreateUnit(c));
  assert.equal(error.code, 'configuration-create-content-conflict');
  assert.equal(h.writes().filter((q) => PUBLISH.test(q.path)).length, 1);
});

test('the receipt: a failure to seal sends nothing, and a receipt another writer changed refuses the next seal before its send', async () => {
  // The workspace path is a file: the receipt cannot be written, so nothing is sent.
  const file = path.join(makeTempDir('cfg-writer-file-'), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const c = compile('connectionReference', 'contoso_c1');
  const h = await harness({ workspaceDir: file });
  await assert.rejects(h.writer.executeCreateUnit(c), (e) => e.name === 'ConfigurationCreateHalt' && /^configuration-create-/.test(e.code));
  assert.equal(h.writes().length, 0);
  // The receipt is replaced on disk after the first row is sent: the next seal (the second row's) is refused and that row is never sent.
  const c2 = compile('environmentVariable', 'contoso_V');
  const h2 = await harness();
  const origPost = h2.httpClient.post.bind(h2.httpClient);
  h2.httpClient.post = async (...args) => {
    const answer = await origPost(...args);
    fs.rmSync(path.join(h2.workspaceDir, S.STATE_FILE));
    return answer;
  };
  const error = await halted(h2.writer.executeCreateUnit(c2));
  assert.match(error.code, /^configuration-create-/);
  assert.equal(h2.writes().length, 1, 'the second row was never sent');
});

// A storage fault on the receipt itself (lib/configuration-create-state.js saves it with an atomic rename): once armed, the rename
// onto the receipt that comes `skip` renames later fails with EIO, which no rename retry repeats. Renames of other files pass.
function receiptRenameFault() {
  const original = fs.renameSync;
  let armed = null;
  let renames = 0;
  fs.renameSync = function renameSync(from, to, ...rest) {
    if (path.basename(String(to)) === S.STATE_FILE) {
      renames += 1;
      if (armed !== null) {
        if (armed === 0) { armed = null; throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' }); }
        armed -= 1;
      }
    }
    return original.call(this, from, to, ...rest);
  };
  return { arm: (skip = 0) => { armed = skip; }, renames: () => renames, restore: () => { fs.renameSync = original; } };
}
const G = () => require('crypto').randomUUID();
const page = (answer, edit) => { const body = JSON.parse(answer.body); edit(body); return { ...answer, body: JSON.stringify(body) }; };

test('the proof read: a request parameter the declaration leaves optional-by-default, read back optional, is a content conflict', async () => {
  const c = compile('customApi', 'contoso_Calc');
  const a = c.unit.rows.find((r) => r.kind === 'api-request' && r.key.toLowerCase().endsWith(':a'));
  assert.ok(a, 'parameter A (no isOptional in the declaration)');
  const h = await harness({ fault: ({ method, path: p, org }) => { if (method === 'GET' && p.startsWith(`/customapirequestparameters(${a.id})`)) org.sets.get('customapirequestparameters').get(a.id).isoptional = true; return null; } });
  const error = await halted(h.writer.executeCreateUnit(c));
  assert.equal(error.code, 'configuration-create-content-conflict');
  assert.equal(h.writes().length, 2, 'the API and parameter A, nothing after');
  assert.equal(h.saved().units[0].rows.find((r) => r.id === a.id).dispatch, 'dispatched', 'never marked verified');
});

test('publication: a 401, 429 or 5xx answer to the action is one attempt, never retried by the transport', async () => {
  for (const status of [401, 429, 500, 503]) {
    const c = compile('duplicateRule', 'email');
    const h = await harness({ fault: ({ method, path: p }) => method === 'POST' && PUBLISH.test(p) ? { answer: { statusCode: status, headers: { 'content-type': 'application/json', 'retry-after': '0' }, body: '{"error":{"code":"0x80040216","message":"x"}}' } } : null });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, 'configuration-create-publication-pending', String(status));
    assert.equal(h.writes().filter((q) => PUBLISH.test(q.path)).length, 1, `${status}: exactly one action reached the service`);
    assert.equal(h.saved().units[0].publication.dispatch, 'dispatched');
  }
});

test('the receipt: a failed save at each later step stops the build there, with nothing sent after it', async (t) => {
  const fault = receiptRenameFault();
  t.after(() => fault.restore());
  const stopped = (error) => assert.equal(error.code, 'configuration-create-persistence-uncertain', error.message);

  // The seal of the publication: the action is never sent, and the next preflight reads the receipt with GETs only (none).
  {
    const c = compile('duplicateRule', 'email');
    const h = await harness();
    stopped(await halted(h.writer.executeCreateUnit(c, { membership: async () => { fault.arm(0); return []; } })));
    assert.equal(h.writes().filter((q) => PUBLISH.test(q.path)).length, 0, 'the action was not sent');
    assert.equal(h.saved().units[0].publication.dispatch, 'prepared');
    const mark = h.org.requests.length;
    assert.throws(() => preflight(h, [declarationOf(c)]), (e) => /^configuration-create-/.test(e.code));
    assert.equal(h.org.requests.length, mark, 'the preflight sent nothing');
  }
  // The verified mark after an acknowledged create: the next row is never sealed or sent.
  {
    const c = compile('customApi', 'contoso_Calc');
    const root = c.unit.root.id;
    const h = await harness({ fault: ({ method, path: p }) => { if (method === 'GET' && p.startsWith(`/customapis(${root})`)) fault.arm(0); return null; } });
    stopped(await halted(h.writer.executeCreateUnit(c)));
    assert.equal(h.writes().length, 1, 'the root only');
    const [u] = h.saved().units;
    assert.equal(u.rows.find((r) => r.id === root).dispatch, 'dispatched', 'the mark was not saved');
    assert.ok(u.rows.filter((r) => r.id !== root).every((r) => r.dispatch === 'prepared'));
  }
  // The seal of a later row: that row is never sent.
  {
    const c = compile('customApi', 'contoso_Calc');
    const root = c.unit.root.id;
    const h = await harness({ fault: ({ method, path: p }) => { if (method === 'GET' && p.startsWith(`/customapis(${root})`)) fault.arm(1); return null; } });
    stopped(await halted(h.writer.executeCreateUnit(c)));
    assert.equal(h.writes().length, 1, 'the second row was never sent');
    const [u] = h.saved().units;
    assert.equal(u.rows.find((r) => r.id === root).dispatch, 'verified');
    assert.ok(u.rows.filter((r) => r.id !== root).every((r) => r.dispatch === 'prepared'));
  }
  // The completion (the last save of a whole unit): the build stops and the unit stays in the receipt for the next preflight.
  {
    const probe = await harness();
    const before = fault.renames();
    await probe.writer.executeCreateUnit(compile('connectionReference', 'contoso_c1'));
    const saves = fault.renames() - before;
    const c = compile('connectionReference', 'contoso_c1');
    const h = await harness();
    fault.arm(saves - 1);
    stopped(await halted(h.writer.executeCreateUnit(c)));
    assert.equal(h.writes().length, 1);
    assert.equal(h.saved().units[0].rows[0].dispatch, 'verified');
    const mark = h.org.requests.length;
    assert.throws(() => preflight(h, [declarationOf(c)]), (e) => /^configuration-create-/.test(e.code));
    assert.equal(h.org.requests.length, mark);
  }
});

test('the graph read: a child listed twice across pages, a child naming another parent, or a next page this build cannot follow is unreadable, and nothing is sent again', async () => {
  const set = '/customapirequestparameters?';
  const cases = [
    ['listed twice', () => {
      let first;
      return ({ method, path: p }) => {
        if (method !== 'GET' || !p.startsWith(set)) return null;
        if (!p.includes('$skiptoken')) return { transform: (a) => { first = JSON.parse(a.body).value[0].customapirequestparameterid; return a; } };
        return { transform: (a) => page(a, (b) => { b.value[0].customapirequestparameterid = first; }) };
      };
    }],
    ['another parent', () => ({ method, path: p }) => method === 'GET' && p.startsWith(set) && p.includes('$skiptoken') ? { transform: (a) => page(a, (b) => { b.value[0]._customapiid_value = G(); }) } : null],
    ['a link that is not https', () => ({ method, path: p }) => method === 'GET' && p.startsWith(set) && !p.includes('$skiptoken') ? { transform: (a) => page(a, (b) => { b['@odata.nextLink'] = b['@odata.nextLink'].replace(/^https:/, 'http:'); }) } : null],
    ['a relative link', () => ({ method, path: p }) => method === 'GET' && p.startsWith(set) && !p.includes('$skiptoken') ? { transform: (a) => page(a, (b) => { b['@odata.nextLink'] = b['@odata.nextLink'].replace(/^https:\/\/[^/]+/, ''); }) } : null],
    ['more records with no link', () => ({ method, path: p }) => method === 'GET' && p.startsWith(set) && !p.includes('$skiptoken') ? { transform: (a) => page(a, (b) => { delete b['@odata.nextLink']; b['@Microsoft.Dynamics.CRM.morerecords'] = true; }) } : null],
  ];
  for (const [why, make] of cases) {
    const c = compile('customApi', 'contoso_Calc');
    const created = c.unit.rows.filter((r) => r.role === 'create').length;
    const h = await harness({ pageSize: 1, fault: make() });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, 'configuration-create-graph-unreadable', why);
    assert.equal(h.writes().length, created, `${why}: every row once, nothing again`);
    assert.ok(h.org.requests.some((q) => q.method === 'GET' && q.path.includes('$skiptoken')) || why !== 'listed twice', `${why}: the read did page`);
  }
  // The same paged read with nothing wrong in it completes.
  const h = await harness({ pageSize: 1 });
  await h.writer.executeCreateUnit(compile('customApi', 'contoso_Calc'));
  assert.ok(h.org.requests.some((q) => q.method === 'GET' && q.path.includes('$skiptoken')), 'the read paged');
});

test('the plug-in type of a new Custom API is never sent, proven or kept: a GET that names one, or another one later, still verifies', async () => {
  const c = compile('customApi', 'contoso_Calc');
  const root = c.unit.root.id;
  const withPluginType = ({ method, path: p }) => method === 'GET' && p.startsWith(`/customapis(${root})`) ? { transform: (a) => page(a, (b) => { b._plugintypeid_value = G(); }) } : null;
  const h = await harness({ fault: withPluginType });
  const done = await h.writer.executeCreateUnit(c);
  assert.equal(done.rootId, root);
  assert.ok(h.org.requests.filter((q) => q.method === 'GET' && q.path.startsWith(`/customapis(${root})`)).length >= 2, 'read more than once, a different plug-in type each time');
  // Kept in the receipt: the API row verified with a plug-in type on its read, the receipt names none.
  const c2 = compile('customApi', 'contoso_Calc');
  const firstChild = c2.unit.rows.find((r) => r.role === 'create' && r.id !== root);
  const h2 = await harness({ fault: (q) => (q.method === 'POST' && q.body && q.body.customapirequestparameterid === firstChild.id ? { lose: true } : withPluginType(q)) });
  await halted(h2.writer.executeCreateUnit(c2));
  const bytes = fs.readFileSync(path.join(h2.workspaceDir, S.STATE_FILE), 'utf8');
  assert.equal(h2.saved().units[0].rows.find((r) => r.id === root).dispatch, 'verified');
  assert.doesNotMatch(bytes, /plugintype/i);
});

test('rows read without an ETag (as a live rule and connection reference are) are proven without one, and no write carries If-Match', async () => {
  const h = await harness({ liveRowShape: true });
  for (const [kind, key] of [['duplicateRule', 'email'], ['duplicateRule', 'x'], ['connectionReference', 'contoso_c1']]) await h.writer.executeCreateUnit(compile(kind, key));
  assert.equal(h.org.rows('duplicaterules').find((r) => r.name === 'Same email').statecode, 1);
  for (const q of h.writes()) for (const name of Object.keys(q.headers || {})) assert.doesNotMatch(name, /^if-(none-)?match$/i);
  assert.deepEqual(h.saved().units, []);
});

test('a unit this build did not compile (a forged or copied handle) is refused before anything is saved, read or sent', async () => {
  const c = compile('connectionReference', 'contoso_c1');
  const h = await harness();
  for (const forged of [{ handle: {}, unit: c.unit }, { handle: { ...c.handle }, unit: c.unit }, { unit: c.unit }, null]) {
    const error = await halted(h.writer.executeCreateUnit(forged));
    assert.equal(error.code, 'configuration-create-shape-refused');
    assert.equal(error.dispatched, false);
  }
  assert.equal(h.org.requests.length, 0);
  assert.equal(fs.existsSync(path.join(h.workspaceDir, S.STATE_FILE)), false, 'no receipt');
});

test('a second compile of a root whose unit is still open is refused pending with nothing sent: after a lost answer, and while the first is in flight', async () => {
  const c = compile('customApi', 'contoso_Calc');
  const root = c.unit.root.id;
  const h = await harness({ fault: ({ method, body }) => method === 'POST' && body && body.customapiid === root ? { lose: true } : null });
  await halted(h.writer.executeCreateUnit(c));
  const mark = h.org.requests.length;
  const again = compile('customApi', 'contoso_Calc');
  assert.equal(again.unit.root.id, root, 'the same ids');
  assert.equal((await halted(h.writer.executeCreateUnit(again))).code, 'configuration-create-pending');
  assert.equal(h.org.requests.length, mark, 'nothing read or sent');

  let release;
  let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const atPost = new Promise((resolve) => { reached = resolve; });
  const h2 = await harness({ fault: async ({ method, body }) => { if (method === 'POST' && body && body.customapiid === root) { reached(); await gate; } return null; } });
  const first = h2.writer.executeCreateUnit(compile('customApi', 'contoso_Calc'));
  await atPost;
  const before = h2.org.requests.length;
  assert.equal((await halted(h2.writer.executeCreateUnit(compile('customApi', 'contoso_Calc')))).code, 'configuration-create-pending');
  assert.equal(h2.org.requests.length, before, 'the second sent nothing');
  release();
  await first;
  assert.equal(h2.writes().filter((q) => q.body && q.body.customapiid === root).length, 1, 'the API was sent once');
  assert.equal(h2.org.rows('customapis').length, 1);
});

test('the receipt holds the same bytes whatever the private inputs are (values, connections, default values, schemas)', async () => {
  const other = {
    s: spec({
      environmentVariables: [
        { schemaName: 'contoso_V', type: 'string', defaultValue: 'other-default' },
        { schemaName: 'contoso_J', type: 'json', valueSchema: '{"other":"schema"}', name: 'J', description: 'D', isRequired: true },
      ],
    }),
    d: { EnvironmentVariables: [{ SchemaName: 'contoso_V', Value: 'other-value' }], ConnectionReferences: [{ LogicalName: 'contoso_c1', ConnectionId: 'other-connection' }] },
  };
  // The receipt's random parts (the epoch and the unit's ids) are fixed before the comparison; everything else must be equal.
  const fixed = (dir) => {
    const st = S.readConfigurationCreateState(dir, { kindTable: RKT });
    return S.serializeCreateState({ ...st, epoch: '00000000-0000-4000-8000-000000000000', units: st.units.map((u) => ({ ...u, unitId: '00000000-0000-4000-8000-000000000001', attemptId: '00000000-0000-4000-8000-000000000002' })) });
  };
  for (const [kind, key] of [['environmentVariable', 'contoso_V'], ['environmentVariable', 'contoso_J'], ['connectionReference', 'contoso_c1']]) {
    const saved = [];
    for (const variant of [{}, other]) {
      const c = compile(kind, key, variant);
      const last = c.unit.rows.filter((r) => r.role === 'create').pop();
      const h = await harness({ fault: ({ method, body }) => method === 'POST' && body && body[KT[last.kind].idColumn] === last.id ? { lose: true } : null });
      await halted(h.writer.executeCreateUnit(c));
      saved.push(fixed(h.workspaceDir));
    }
    assert.equal(saved[1], saved[0], `${kind} ${key}`);
    for (const secret of [...PRIVATE, 'other-default', 'other-value', 'other-connection', '{"other":"schema"}']) assert.ok(!saved[0].includes(secret) && !saved[1].includes(secret), `${kind} ${key}: ${secret}`);
  }
});

test('deleted and recreated after a lost answer (the same row again, or a namesake at another id): still pending, nothing sent, and accepting it needs the private review', async () => {
  for (const how of ['the same row again', 'a namesake at another id']) {
    const c = compile('environmentVariable', 'contoso_V');
    const value = c.unit.rows.find((r) => r.kind === 'env-value');
    const h = await harness({ fault: ({ method, body }) => method === 'POST' && body && body.environmentvariablevalueid === value.id ? { lose: true } : null });
    assert.equal((await halted(h.writer.executeCreateUnit(c))).code, 'configuration-create-pending');
    const values = h.org.sets.get('environmentvariablevalues');
    const row = values.get(value.id);
    values.delete(value.id);
    if (how === 'the same row again') values.set(value.id, row);
    else { const id = G(); values.set(id, { ...row, environmentvariablevalueid: id }); }
    const mark = h.org.requests.length;
    assert.throws(() => preflight(h, [declarationOf(c)]), (e) => e.code === 'configuration-create-pending', how);
    assert.equal((await halted(h.writer.executeCreateUnit(compile('environmentVariable', 'contoso_V')))).code, 'configuration-create-pending', how);
    assert.equal(h.org.requests.length, mark, `${how}: nothing read or sent`);
    // The unit holds a value row: accepting the current state is offered only with the private review.
    const st = h.saved();
    const offer = S.prepareResolutionOffer(h.workspaceDir, { kindTable: RKT, context: h.context, unitId: st.units[0].unitId, mode: 'accept-current', observedPublicSha256: 'a'.repeat(64), expectedRevision: st.revision });
    assert.equal(offer.privateAcknowledgmentRequired, true, how);
  }
});

test('ids: every compiled id is the existing create identity, and a child added under an existing root at a random (legacy) id derives under that id', async () => {
  const I = require('../lib/creates-identity.js');
  const scope = { kind: 'solution', solution: SOL };
  const rootId = (kind, key) => I.stableCreateIdV1({ scope, kind, keyParts: [key] });
  const childKind = { 'env-value': 'environmentVariableValue', 'api-request': 'customApiRequestParameter', 'api-response': 'customApiResponseProperty', 'rule-condition': 'duplicateRuleCondition' };
  const childParts = (r) => (r.kind === 'env-value' ? ['value'] : [r.key.slice(r.key.indexOf(':') + 1)]);
  for (const [kind, key] of ROOTS) {
    const { unit } = compile(kind, key);
    assert.equal(unit.root.id, rootId(kind, key.toLowerCase()), `${kind} ${key}`);
    for (const r of unit.rows.filter((x) => x.id !== unit.root.id)) {
      assert.equal(r.parentId, unit.root.id);
      assert.equal(r.id, I.stableChildIdV1(unit.root.id, childKind[r.kind], childParts(r)), `${kind} ${key} ${r.kind} ${r.key}`);
    }
  }
  // An API created long ago at a random id, with parameter A only; the declaration now adds B.
  const legacy = G();
  const onlyA = spec({ customApis: [{ ...spec().customApis[0], requestParameters: [spec().customApis[0].requestParameters[0]], responseProperties: [] }] });
  const seed = compile('customApi', 'contoso_Calc', { s: onlyA });
  const h = await harness();
  for (const r of seed.unit.rows) {
    const q = P.compiledRowRequest(seed.handle, r.id);
    const body = q.body.split(seed.unit.root.id).join(legacy);
    await h.org.request({ url: `${h.org.origin}/api/data/v9.2${q.path}`, method: 'POST', headers: { 'content-type': 'application/json' }, body });
  }
  const s = spec({ customApis: [{ ...spec().customApis[0], responseProperties: [] }] });
  const baseline = await P.captureConfigurationBaseline(h.sdk.dataverse, { kind: 'customApi', rootId: legacy });
  assert.equal(baseline.ok, true, baseline.reason);
  const full = compile('customApi', 'contoso_Calc', { s });
  const slotB = full.unit.rows.find((r) => r.kind === 'api-request' && r.key.toLowerCase().endsWith(':b')).key;
  const c = compile('customApi', 'contoso_Calc', { s, baseline, additions: [slotB] });
  const added = c.unit.rows.filter((r) => r.role === 'create');
  assert.equal(added.length, 1);
  assert.equal(added[0].parentId, legacy);
  assert.equal(added[0].id, I.stableChildIdV1(legacy, 'customApiRequestParameter', ['b']));
  const mark = h.org.requests.length;
  await h.writer.executeCreateUnit(c);
  const writes = h.writes(mark);
  assert.equal(writes.length, 1, 'only the new parameter');
  assert.equal(writes[0].body.customapirequestparameterid, added[0].id);
  assert.equal(h.org.rows('customapis').length, 1);
});

// The rule's lifecycle is proved at the graph reads around the one publication action, not by the polling GET alone: before
// the action a new rule must still read unpublished (it was never published; one already reading published is not published
// again), and after it the last graph read must show the state the unit requires before the unit leaves the receipt.
const setRuleState = (org, statecode, statuscode) => Object.assign(org.rows('duplicaterules')[0], { statecode, statuscode });
const LIFECYCLE_STATES = [['published', 1, 2], ['publishing', 0, 1]];

test('lifecycle: a new rule that already reads published or publishing before its publication is not published: publication-pending, the slot unsent, the next preflight sends nothing', async () => {
  for (const [why, statecode, statuscode] of LIFECYCLE_STATES) {
    const c = compile('duplicateRule', 'email');
    const condition = unitRow(c, 'rule-condition');
    const h = await harness({ fault: ({ method, body, org }) => (method === 'POST' && body && body.duplicateruleconditionid === condition.id ? { transform: (a) => { setRuleState(org, statecode, statuscode); return a; } } : null) });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.deepEqual(h.writes().filter((q) => PUBLISH.test(q.path)), [], `${why}: the action is never sent`);
    assert.equal(error.code, 'configuration-create-publication-pending', why);
    const [u] = h.saved().units;
    assert.equal(u.publication.dispatch, 'prepared', `${why}: the slot was not sealed`);
    assert.ok(u.rows.every((r) => r.role !== 'create' || r.dispatch === 'verified'), `${why}: every row verified`);
    const mark = h.org.requests.length;
    assert.throws(() => preflight(h, [declarationOf(c)]), (e) => e.name === 'ConfigurationCreateHalt', why);
    assert.equal(h.org.requests.length, mark, `${why}: the preflight sent nothing`);
  }
});

test('lifecycle: the last graph read must show the new rule published; unpublished or publishing there keeps the unit (acknowledged) and stops publication-pending', async () => {
  for (const [why, statecode, statuscode] of [['unpublished', 0, 0], ['publishing', 0, 1]]) {
    const c = compile('duplicateRule', 'email');
    const root = c.unit.root.id;
    let published = false;
    let reads = 0;
    const h = await harness({ fault: ({ method, path: p, org }) => {
      if (method === 'POST' && PUBLISH.test(p)) published = true;
      // After the action: the first root read (the polling GET) sees it published; the second (the last graph read) does not.
      else if (published && method === 'GET' && p.startsWith(`/duplicaterules(${root})`) && ++reads === 2) setRuleState(org, statecode, statuscode);
      return null;
    } });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(reads >= 2, true, `${why}: the last graph read happened`);
    assert.equal(error.code, 'configuration-create-publication-pending', why);
    assert.equal(h.writes().filter((q) => PUBLISH.test(q.path)).length, 1, `${why}: one action`);
    const [u] = h.saved().units;
    assert.equal(u.publication.dispatch, 'acknowledged', `${why}: the unit is kept`);
    const mark = h.org.requests.length;
    assert.throws(() => preflight(h, [declarationOf(c)]), (e) => e.code === 'configuration-create-publication-pending', why);
    assert.equal(h.org.requests.length, mark);
  }
});

test('lifecycle: a new rule declared unpublished that reads published or publishing at its graph read is a content conflict, and its unit is kept', async () => {
  for (const [why, statecode, statuscode] of LIFECYCLE_STATES) {
    const c = compile('duplicateRule', 'x');
    assert.equal(c.unit.publicationRequired, false);
    const condition = unitRow(c, 'rule-condition');
    const h = await harness({ fault: ({ method, body, org }) => (method === 'POST' && body && body.duplicateruleconditionid === condition.id ? { transform: (a) => { setRuleState(org, statecode, statuscode); return a; } } : null) });
    const error = await halted(h.writer.executeCreateUnit(c));
    assert.equal(error.code, 'configuration-create-content-conflict', why);
    assert.deepEqual(h.writes().filter((q) => PUBLISH.test(q.path)), []);
    assert.equal(h.saved().units.length, 1, `${why}: the unit is kept`);
  }
});

test('lifecycle: the rule states the unit expects still complete it (a new published rule, a new unpublished rule)', async () => {
  for (const key of ['email', 'x']) {
    const c = compile('duplicateRule', key);
    const h = await harness();
    await h.writer.executeCreateUnit(c);
    assert.equal(h.org.rows('duplicaterules')[0].statecode, c.unit.publicationRequired ? 1 : 0);
    assert.deepEqual(h.saved().units, []);
  }
});

test('acknowledgment: an id the answer names but cannot be read, or an error member of any type, is never an acknowledgment even when the header names the id', () => {
  const id = '0b7c6f5e-0000-4000-8000-000000000001';
  const at = (x) => `https://contoso.crm.dynamics.com/api/data/v9.2/duplicaterules(${x})`;
  const ack = (answer) => W.classifyCreateAcknowledgment(answer, { id, idColumn: 'duplicateruleid' });
  for (const [answer, why] of [
    [{ status: 201, headers: { 'OData-EntityId': at(id) }, body: { duplicateruleid: 'not-an-id' } }, /unreadable id/],
    [{ status: 201, headers: { 'OData-EntityId': at(id) }, body: { duplicateruleid: null } }, /unreadable id/],
    [{ status: 201, headers: { 'OData-EntityId': at(id) }, body: { duplicateruleid: 42 } }, /unreadable id/],
    [{ status: 201, headers: { Location: 'https://contoso.crm.dynamics.com/somewhere' }, body: { duplicateruleid: id } }, /no readable id/],
    [{ status: 201, headers: { 'OData-EntityId': at(id) }, body: { duplicateruleid: id, error: 'replaced' } }, /an error/],
    [{ status: 201, headers: { 'OData-EntityId': at(id) }, body: { duplicateruleid: id, Error: 7 } }, /an error/],
    [{ status: 201, headers: { 'OData-EntityId': at(id) }, body: { duplicateruleid: id, error: null } }, /an error/],
  ]) {
    const got = ack(answer);
    assert.equal(got.ok, false, JSON.stringify(answer));
    assert.match(got.reason, why, JSON.stringify(answer));
  }
  // The measured and documented shapes stay acknowledgments: a header-identified 201 representation (with or without the
  // id column) and a bodyless 204.
  assert.deepEqual(ack({ status: 201, headers: { 'OData-EntityId': at(id) }, body: { duplicateruleid: id, name: 'n' } }), { ok: true });
  assert.deepEqual(ack({ status: 201, headers: { 'OData-EntityId': at(id) }, body: { name: 'n' } }), { ok: true });
  assert.deepEqual(ack({ status: 204, headers: { 'OData-EntityId': at(id) } }), { ok: true });
  const pub = W.classifyNewRulePublicationAcknowledgment;
  for (const answer of [
    { status: 200, headers: {}, body: { error: 'the response was replaced by an intermediary' } },
    { status: 200, headers: {}, body: { Error: 1 } },
    { status: 200, headers: {}, body: { asyncoperationid: 'x', error: null } },
    { status: 204, headers: { 'content-type': 'text/plain' }, body: 'truncated non-JSON answer' },
    { status: 204, headers: {}, body: { asyncoperationid: 'x' } },
  ]) assert.equal(pub(answer).ok, false, JSON.stringify(answer));
  assert.deepEqual(pub({ status: 200, headers: {}, body: { asyncoperationid: 'x', statecode: 0, statuscode: 0, operationtype: 7 } }), { ok: true });
  assert.deepEqual(pub({ status: 204, headers: {}, body: '' }), { ok: true });
});

test('acknowledgment through the client: a malformed id in a 201, or a malformed or error publication answer, stops there with nothing after it', async () => {
  const c = compile('duplicateRule', 'email');
  const malformed = await harness({ fault: ({ method, path: p }) => (method === 'POST' && p === '/duplicaterules' ? { transform: (a) => ({ ...a, statusCode: 201, body: JSON.stringify({ duplicateruleid: 'not-an-id' }) }) } : null) });
  const error = await halted(malformed.writer.executeCreateUnit(c));
  assert.deepEqual(malformed.writes().map((q) => `${q.method} ${q.path}`), ['POST /duplicaterules'], 'no condition or publication after it');
  assert.equal(error.code, 'configuration-create-pending');
  assert.equal(malformed.saved().units[0].rows.find((r) => r.id === c.unit.root.id).dispatch, 'dispatched');
  for (const [why, answer] of [
    ['an error member that is not an object', (a) => ({ ...a, statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'the response was replaced by an intermediary' }) })],
    ['a 204 with a body', (a) => ({ ...a, statusCode: 204, headers: { 'content-type': 'text/plain' }, body: 'truncated non-JSON answer' })],
  ]) {
    const h = await harness({ fault: ({ method, path: p }) => (method === 'POST' && PUBLISH.test(p) ? { transform: answer } : null) });
    const e = await halted(h.writer.executeCreateUnit(compile('duplicateRule', 'email')));
    assert.equal(e.code, 'configuration-create-publication-pending', why);
    assert.equal(h.saved().units[0].publication.dispatch, 'dispatched', `${why}: not acknowledged`);
  }
  // A header-identified 201 representation and a bodyless 204 publication still complete the unit.
  const ok = await harness({ fault: ({ method, path: p }) => {
    if (method === 'POST' && p === '/duplicaterules') return { transform: (a) => ({ ...a, statusCode: 201, headers: { ...a.headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Same email' }) }) };
    if (method === 'POST' && PUBLISH.test(p)) return { transform: (a) => ({ ...a, statusCode: 204, headers: {}, body: '' }) };
    return null;
  } });
  await ok.writer.executeCreateUnit(compile('duplicateRule', 'email'));
  assert.deepEqual(ok.saved().units, []);
});
