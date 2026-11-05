'use strict';
// The protected create driver of the configuration families (lib/configuration-create-bindings.js), which the build uses
// under the opt-in: its plan, its exact and namesake reads, its classifier of the SDK's own requests, and one full create set
// through the real SDK, the real send-once gate and the real binding store against the fake org.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const { createDeferredManagedCreateGate } = require('../lib/managed-create-transport.js');
const { CODES, createManagedCreateContext } = require('../lib/managed-create-context.js');
const { openManagedBindings } = require('../lib/managed-bindings.js');
const A = require('../lib/configuration-artifacts.js');
const B = require('../lib/configuration-create-bindings.js');

const SOL = 'ContosoSol';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const VALUE = 'private-value-7f3a';
const CONNECTION = 'private-connection-9c1e';
const OTHER = '77777777-7777-4777-8777-777777777777';
const spec = (over = {}) => ({
  minimumPluginVersion: '2.21.0', solution: { uniqueName: SOL, publisherPrefix: 'contoso' },
  environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'x' }],
  connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
  customApis: [{ uniqueName: 'contoso_Calc', isFunction: true, requestParameters: [{ uniqueName: 'A', type: 'integer' }], responseProperties: [{ uniqueName: 'R', type: 'string' }] }],
  duplicateDetectionRules: [{ key: 'email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }],
  ...over,
});
const DEPLOY = { EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: VALUE }], ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: CONNECTION }] };
const TYPES = { connectionreference: 10132, customapi: 10133, duplicaterule: 4414, customapirequestparameter: 10134, customapiresponseproperty: 10135, duplicaterulecondition: 4416 };
const ALL = [['environmentVariable', 'contoso_ApiBase'], ['connectionReference', 'contoso_sp'], ['customApi', 'contoso_Calc'], ['duplicateRule', 'email']];

function planned(kind, key, over = {}) {
  const s = over.spec || spec();
  return B.planOf(s, { kind, key, bindings: A.readDeploymentBindings(DEPLOY, s), solution: SOL, componentTypes: TYPES, ...over, spec: undefined });
}
const rowOf = (p, kind) => p.rows.find((r) => r.kind === kind);

function orgOf(opts = {}) {
  return createConfigOrg({ tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }], solution: { uniqueName: SOL, version: '1.0.0.0', prefix: 'contoso' }, ...opts });
}
async function sdkOf(org, gate) {
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request: org.request, sleep: async () => {}, sendOnce: configurationSendOnce, workflowEffectGate: gate });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('cfg-create-sdk-')), instanceUrl: org.origin, httpClient, solutionUniqueName: SOL });
  await sdk.initWorkspace();
  return sdk;
}
// A seed row, written straight to the fake org (no SDK, no gate): a namesake someone else made.
async function seed(org, set, body) {
  const res = await org.request({ url: `${org.origin}/api/data/v9.2/${set}`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(res.statusCode < 300, `seed ${set}: ${res.statusCode}`);
}
// Every mutation the real SDK sends to push `p` (or `artifact` in its place), as the gate is asked about it (the body is
// the JSON text it sends). `sent` keeps capturing, so a later edit pushed through `sdk` is captured too.
async function wireOf(p, { artifact = B.artifactFor(p), org = orgOf() } = {}) {
  const sent = [];
  const sdk = await sdkOf(org, { screen(req) { if (req.method !== 'GET') sent.push({ ...req, headers: { ...req.headers } }); return null; } });
  await sdk.createArtifact(p.kind, artifact);
  const result = await sdk.pushArtifact(p.kind, p.plan.rows[0].id);
  for (const m of p.plan.members) {
    await sdk.dataverse.post('/AddSolutionComponent', { ComponentId: m.id, ComponentType: m.componentType, SolutionUniqueName: SOL, AddRequiredComponents: false });
  }
  return { sent, result, org, sdk };
}
const withBody = (req, edit) => {
  const b = JSON.parse(req.body);
  edit(b);
  return { ...req, body: JSON.stringify(b) };
};
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

// A reader over canned answers: `routes` is [[prefix-or-regexp, answer | (path) => answer]]; an unrouted read is a 500.
function reader(routes, { absolute } = {}) {
  const answerFor = (p) => {
    for (const [match, a] of routes) {
      if (typeof match === 'string' ? p.startsWith(match) : match.test(p)) return typeof a === 'function' ? a(p) : a;
    }
    return { status: 500, body: { error: { code: '0x80040216' } } };
  };
  return { get: async (p) => answerFor(p), getAbsolute: async (u) => (absolute ? absolute(u) : answerFor(u)) };
}
const ok = (value, extra = {}) => ({ status: 200, body: { value, ...extra } });

// The fresh base read of every planned row that exists now, as a bound plan is prepared from it.
async function basesOf(dv, p) {
  const bases = new Map();
  for (const r of p.plan.rows) {
    const read = await B.readConfigurationRow(dv, r.kind, r.id);
    if (read.state === 'present') bases.set(r.id, read);
  }
  return bases;
}
// The plan of an edit of `first` once it exists: its root bound, its existing children bound, each from a fresh read.
async function rebound(dv, first, over = {}) {
  const bases = await basesOf(dv, first);
  const boundSlots = first.rows.filter((r) => r.slot !== null && bases.has(r.id)).map((r) => r.slot);
  return planned(first.kind, first.key, { boundIdOf: (kind) => (kind === first.kind ? first.plan.rows[0].id : undefined), boundSlots, bases, ...over });
}
// The requests the real SDK sends to push an edit of an artifact it pushed before: `ops` are its element updates.
async function pushEdit(w, kind, id, ops) {
  await w.sdk.fetchArtifact(kind, id, { overwrite: true });
  for (const [pointer, value] of ops) await w.sdk.updateElement(kind, id, pointer, value);
  w.sent.length = 0;
  const result = await w.sdk.pushArtifact(kind, id);
  return { result, sent: [...w.sent] };
}
// The change-set constituents of a $batch as the SDK renders it (CRLF lines; the boundaries differ per request):
//   --changeset_<id>\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: 1\r\n\r\n
//   PATCH https://contoso.crm.dynamics.com/api/data/v9.0/customapis(<id>)?$select=customapiid HTTP/1.1\r\n
//   MSCRM.SolutionUniqueName: ContosoSol\r\nIf-Match: W/"16"\r\nPrefer: return=representation\r\n\r\n{"isprivate":false}\r\n
function constituentsOf(req) {
  return String(req.body).split(/--changeset_[\w-]+/).filter((c) => c.includes('application/http')).map((chunk) => {
    const [, head, ...rest] = chunk.split('\r\n\r\n');
    const [line, ...headerLines] = head.split('\r\n');
    const [, method, url] = /^(\w+) (\S+) HTTP\/1\.1$/.exec(line);
    const headers = Object.fromEntries(headerLines.map((h) => [h.slice(0, h.indexOf(':')), h.slice(h.indexOf(':') + 1).trim()]));
    return { method, url, headers, body: rest.join('\r\n\r\n').replace(/\r\n$/, '') };
  });
}

test('planOf: one artifact\'s rows at the derived ids, members of its solution, no private input anywhere in the plan', () => {
  const ev = planned('environmentVariable', 'contoso_ApiBase');
  assert.deepEqual(ev.plan.rows.map((r) => [r.kind, r.mode, r.sensitiveInput]), [['environmentVariable', 'create', false], ['environmentVariableValue', 'create', true]]);
  assert.equal(ev.plan.rows[1].parentId, ev.plan.rows[0].id);
  assert.deepEqual(ev.plan.members, [{ kind: 'environmentVariable', id: ev.plan.rows[0].id, componentType: 380 }], 'a value row is never a member');
  const rule = planned('duplicateRule', 'email');
  assert.equal(rule.plan.ruleState, 'published');
  assert.deepEqual(rule.plan.effects.map((e) => e.kind), ['membership', 'membership', 'rule-state']);
  const cr = planned('connectionReference', 'contoso_sp');
  for (const p of [ev, cr]) {
    const text = JSON.stringify(p);
    assert.ok(!text.includes(VALUE) && !text.includes(CONNECTION), 'the planned object carries no private input');
  }
  assert.equal(B.artifactFor(ev).currentValue.value, VALUE, 'only the SDK artifact carries it');
  assert.equal(B.artifactFor(cr).connectionId, CONNECTION);
  assert.ok(Object.isFrozen(ev.rows[0].expected));
  assert.deepEqual(planned('customApi', 'contoso_Calc'), planned('customApi', 'contoso_Calc'), 'the plan is deterministic');
});

test('planOf: membership needs the component types; a restricted solution plans none', () => {
  assert.throws(() => planned('customApi', 'contoso_Calc', { componentTypes: undefined }), /component type of customapi/);
  const def = planned('customApi', 'contoso_Calc', { componentTypes: undefined, solution: 'Default' });
  assert.deepEqual(def.plan.members, []);
  assert.deepEqual(def.plan.effects, []);
});

test('readConfigurationRow: absent only on 404 0x80040217; any other failure or a malformed answer is unknown', async () => {
  const p = planned('customApi', 'contoso_Calc');
  const { sdk } = await wireOf(p);
  const id = p.plan.rows[0].id;
  const real = await sdk.dataverse.get(`/customapis(${id})?$select=${['customapiid', ...Object.keys(B.KINDS.customApi.columns)].join(',')}`);
  const present = await B.readConfigurationRow(sdk.dataverse, 'customApi', id);
  assert.equal(present.state, 'present');
  assert.equal((await B.readConfigurationRow(sdk.dataverse, 'customApi', OTHER)).state, 'absent', 'the fake org answers 404 0x80040217');
  const cases = [
    ['403', { status: 403, body: { error: { code: '0x80040220' } } }],
    ['500', { status: 500, body: {} }],
    ['404 without the not-found code', { status: 404, body: { error: { code: '0x80060888' } } }],
    ['a 200 that is not an object', { status: 200, body: '<html>' }],
    ['another row', { status: 200, body: { ...real.body, customapiid: OTHER } }],
    ['a selected column left out', { status: 200, body: Object.fromEntries(Object.entries(real.body).filter(([k]) => k !== 'isprivate')) }],
    ['an option code this build does not know', { status: 200, body: { ...real.body, bindingtype: 9 } }],
  ];
  for (const [what, answer] of cases) {
    assert.equal((await B.readConfigurationRow(reader([['/customapis(', answer]]), 'customApi', id)).state, 'unknown', what);
  }
  const threw = { get: async () => { throw Object.assign(new Error('socket'), { statusCode: 404, body: { error: { code: '0x80040217' } } }); } };
  assert.equal((await B.readConfigurationRow(threw, 'customApi', id)).state, 'absent', 'a thrown 404 0x80040217 is the same absence');
  assert.equal((await B.readConfigurationRow({ get: async () => { throw new Error('reset'); } }, 'customApi', id)).state, 'unknown');
});

test('namesake queries follow every page: a namesake on a later page is a conflict; an unfollowable page is unknown', async () => {
  const p = planned('customApi', 'contoso_Calc');
  const api = p.plan.rows[0].id;
  // The planned API exists (as a resumed create would find it) with two request parameters: "X" on page 1, and a
  // namesake "A" at another id on page 2. A response property "A" is the other direction: never a namesake of a request parameter.
  const org = orgOf({ pageSize: 1 });
  await seed(org, 'customapis', {
    customapiid: api, uniquename: 'contoso_Calc', name: 'contoso_Calc', displayname: 'contoso_Calc', bindingtype: 0, isfunction: true, allowedcustomprocessingsteptype: 0,
    CustomAPIRequestParameters: [{ customapirequestparameterid: '11111111-0000-4000-8000-000000000001', uniquename: 'X', name: 'X', displayname: 'X', type: 7 },
      { customapirequestparameterid: OTHER, uniquename: 'a', name: 'a', displayname: 'a', type: 7 }],
    CustomAPIResponseProperties: [{ customapiresponsepropertyid: '11111111-0000-4000-8000-000000000002', uniquename: 'A', name: 'A', displayname: 'A', type: 10 }],
  });
  const sdk = await sdkOf(org, null);
  const out = await B.readConfigurationConflicts(sdk.dataverse, p);
  assert.equal(out.state, 'unknown', 'the root at the planned id answers its own namesake query: the reads disagree');
  const childOnly = out.rows.filter((r) => r.kind !== 'customApi');
  assert.deepEqual(childOnly.map((r) => [r.kind, r.state, r.ids]), [['customApiRequestParameter', 'conflict', [OTHER]], ['customApiResponseProperty', 'clear', undefined]]);
  assert.ok(org.requests.some((r) => /\$skiptoken=/.test(r.path)), 'the second page was read');

  const rootQ = '/customapis?';
  const reqQ = '/customapirequestparameters?';
  const respQ = '/customapiresponseproperties?';
  const clearAll = [[rootQ, ok([])], [reqQ, ok([])], [respQ, ok([])]];
  assert.equal((await B.readConfigurationConflicts(reader(clearAll), p)).state, 'clear');
  const link = 'https://contoso.crm.dynamics.com/api/data/v9.2/customapis?$skiptoken=1';
  const cases = [
    ['an empty first page whose continuation fails', [[rootQ, ok([], { '@odata.nextLink': link })]], () => ({ status: 503, body: {} })],
    ['a continuation that repeats', [[rootQ, ok([], { '@odata.nextLink': link })]], () => ok([], { '@odata.nextLink': link })],
    ['a relative continuation', [[rootQ, ok([], { '@odata.nextLink': '/api/data/v9.2/customapis?$skiptoken=1' })]]],
    ['more records without a link', [[rootQ, ok([], { '@Microsoft.Dynamics.CRM.morerecords': true })]]],
    ['a page that is not a list', [[rootQ, { status: 200, body: { value: {} } }]]],
  ];
  for (const [what, routes, absolute] of cases) {
    const out2 = await B.readConfigurationConflicts(reader([...routes, ...clearAll], { absolute }), p);
    assert.deepEqual([out2.state, out2.code], ['unknown', CODES.unverified], what);
  }
  const later = await B.readConfigurationConflicts(reader([[rootQ, ok([], { '@odata.nextLink': link })], ...clearAll], { absolute: () => ok([{ customapiid: OTHER, uniquename: 'CONTOSO_calc' }]) }), p);
  assert.deepEqual([later.state, later.code, later.rows[0].ids], ['conflict', CODES.conflict, [OTHER]], 'a namesake differing only in case, on a later page');
});
test('namesake predicates: a rule by name on any table, one value per definition, a condition by what it describes', async () => {
  const rule = planned('duplicateRule', 'email');
  const ruleId = rule.plan.rows[0].id;
  const cond = (over) => ({ duplicateruleconditionid: OTHER, baseattributename: 'EmailAddress1', matchingattributename: 'emailaddress1', operatorcode: 0, operatorparam: null, ignoreblankvalues: false, _regardingobjectid_value: ruleId, ...over });
  const judge = async (rules, conds) => B.readConfigurationConflicts(reader([['/duplicaterules?', ok(rules)], ['/duplicateruleconditions?', ok(conds)]]), rule);
  const sameName = await judge([{ duplicateruleid: OTHER, name: 'SAME EMAIL', baseentityname: 'account' }], []);
  assert.deepEqual([sameName.state, sameName.rows[0].ids], ['conflict', [OTHER]], 'a same-name rule on another table');
  assert.equal((await judge([], [cond()])).state, 'conflict', 'a condition the declaration describes');
  assert.equal((await judge([], [cond({ operatorcode: 1, operatorparam: 3 })])).state, 'clear', 'another condition of the rule');
  assert.equal((await judge([], [cond({ operatorcode: 42 })])).state, 'unknown', 'a condition this build cannot read');
  assert.equal((await judge([], [cond({ _regardingobjectid_value: OTHER })])).state, 'unknown', 'a row the filter does not hold for');
  assert.equal((await judge([{ duplicateruleid: OTHER, name: 'Other rule' }], [])).state, 'unknown', 'a name the filter does not hold for');
  assert.equal((await judge([{ duplicateruleid: ruleId, name: 'Same email' }], [])).state, 'unknown', 'the planned id answering its namesake query');
  assert.equal((await judge([{ name: 'Same email' }], [])).state, 'unknown', 'a row without an id');

  const ev = planned('environmentVariable', 'contoso_ApiBase');
  const def = ev.plan.rows[0].id;
  const evJudge = async (values) => B.readConfigurationConflicts(reader([['/environmentvariabledefinitions?', ok([])], ['/environmentvariablevalues?', ok(values)]]), ev);
  assert.equal((await evJudge([])).state, 'clear');
  const v = await evJudge([{ environmentvariablevalueid: OTHER, _environmentvariabledefinitionid_value: def }]);
  assert.deepEqual([v.state, v.rows[1].ids], ['conflict', [OTHER]], 'any value of the planned definition');
  assert.equal((await evJudge([{ environmentvariablevalueid: OTHER, _environmentvariabledefinitionid_value: OTHER }])).state, 'unknown');
});

test('observe: exact reads, the private input compared in memory only, unmodelled columns and unreadable members', async () => {
  const ev = planned('environmentVariable', 'contoso_ApiBase');
  const cr = planned('connectionReference', 'contoso_sp');
  const evWire = await wireOf(ev);
  const crWire = await wireOf(cr);
  const exact = await B.observe(evWire.sdk.dataverse, ev);
  assert.deepEqual(exact.rows.map((r) => [r.kind, r.state, r.projectionSha256 === rowOf(ev, r.kind).expectedSha256, r.privateState]),
    [['environmentVariable', 'present', true, undefined], ['environmentVariableValue', 'present', true, 'match']]);
  assert.deepEqual(exact.members, [{ id: ev.plan.rows[0].id, state: 'present' }]);
  assert.ok(!JSON.stringify(exact).includes(VALUE), 'the observation carries no private input');
  // The same rows read back with the value masked, hidden or replaced.
  const over = (dv, set, edit) => ({ ...dv, get: async (p) => { const r = await dv.get(p); return p.startsWith(`/${set}(`) ? { ...r, body: edit({ ...r.body }) } : r; } });
  const evState = async (edit) => (await B.observe(over(evWire.sdk.dataverse, 'environmentvariablevalues', edit), ev)).rows[1].privateState;
  assert.equal(await evState((b) => { delete b.value; return b; }), 'masked');
  assert.equal(await evState((b) => ({ ...b, value: '*****' })), 'masked');
  assert.equal(await evState((b) => ({ ...b, value: 'someone-else' })), 'mismatch');
  const crObs = await B.observe(over(crWire.sdk.dataverse, 'connectionreferences', (b) => ({ ...b, promptingbehavior: 1 })), cr);
  assert.notEqual(crObs.rows[0].projectionSha256, cr.plan.rows[0].expectedSha256, 'a column this build never writes, filled, is a difference');
  // The platform's own create default there is the row as made; empty is too.
  for (const filled of [0, null]) {
    const crDefault = await B.observe(over(crWire.sdk.dataverse, 'connectionreferences', (b) => ({ ...b, promptingbehavior: filled })), cr);
    assert.equal(crDefault.rows[0].projectionSha256, cr.plan.rows[0].expectedSha256, `promptingbehavior ${filled} read back is the create`);
  }
  const noMembers = { ...evWire.sdk.dataverse, get: async (p) => (p.startsWith('/solutioncomponents') ? { status: 500, body: {} } : evWire.sdk.dataverse.get(p)) };
  assert.deepEqual((await B.observe(noMembers, ev)).members, [{ id: ev.plan.rows[0].id, state: 'unknown' }]);
  const gone = await B.observe(orgReader(), planned('duplicateRule', 'email'));
  assert.equal(gone.ruleState, 'unpublished', 'an absent rule is no published rule');
  assert.ok(gone.rows.every((r) => r.state === 'absent'));
});
const orgReader = () => ({ get: async () => ({ status: 404, body: { error: { code: '0x80040217' } } }) });
test('the classifier names every request the real SDK sends for a planned push, with a sealed projection and no private input', async () => {
  for (const [kind, key] of ALL) {
    const p = planned(kind, key);
    const { sent, result } = await wireOf(p);
    assert.equal(B.acceptResultFor(p)(result), true, `${kind}: the SDK's own push result is accepted`);
    assert.equal(B.acceptResultFor(p)({ ...result, id: OTHER }), false);
    assert.equal(B.acceptResultFor(p)({ ...result, saved: false }), false);
    const classify = B.createClassifier([{ token: 't', planned: p }]);
    const named = sent.map((req) => classify(req));
    assert.ok(named.every(Boolean), `${kind}: every request is a planned row or effect`);
    const rows = named.filter((c) => c.type === 'rows').flatMap((c) => c.rows.map((r) => r.kind)).sort();
    assert.deepEqual(rows, p.plan.rows.map((r) => r.kind).sort(), `${kind}: each planned row is sent exactly once`);
    const effects = named.filter((c) => c.type === 'effect').map((c) => `${c.kind}:${c.id}`).sort();
    assert.deepEqual(effects, p.plan.effects.map((e) => `${e.kind}:${e.id}`).sort(), `${kind}: and each planned effect`);
    const text = JSON.stringify(named);
    assert.ok(!text.includes(VALUE) && !text.includes(CONNECTION), `${kind}: no private input in a descriptor`);
  }
});

test('the classifier refuses anything but the plan: ids, parents, columns, values, queries, solutions, shapes', async () => {
  const api = planned('customApi', 'contoso_Calc');
  const ev = planned('environmentVariable', 'contoso_ApiBase');
  const cr = planned('connectionReference', 'contoso_sp');
  const rule = planned('duplicateRule', 'email');
  const unpublished = planned('duplicateRule', 'email', { spec: spec({ duplicateDetectionRules: [{ key: 'email', name: 'Same email', entity: 'contact', status: 'unpublished', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }] }) });
  const wire = {};
  for (const p of [api, ev, cr, rule]) wire[p.kind] = (await wireOf(p)).sent;
  const classify = B.createClassifier([{ token: 'a', planned: api }, { token: 'e', planned: ev }, { token: 'c', planned: cr }, { token: 'r', planned: rule }]);
  const [apiPost, apiMember] = wire.customApi;
  const [defPost, valuePost] = wire.environmentVariable;
  const [crPost] = wire.connectionReference;
  const [rulePost, publish] = wire.duplicateRule;
  assert.ok(classify(apiPost) && classify(defPost) && classify(valuePost) && classify(crPost) && classify(rulePost) && classify(publish) && classify(apiMember));
  const reqId = rowOf(api, 'customApiRequestParameter').id;
  const respId = rowOf(api, 'customApiResponseProperty').id;
  const refused = [
    ['child ids swapped', withBody(apiPost, (b) => { b.CustomAPIRequestParameters[0].customapirequestparameterid = respId; b.CustomAPIResponseProperties[0].customapiresponsepropertyid = reqId; })],
    ['a child moved to the other direction', withBody(apiPost, (b) => { b.CustomAPIResponseProperties.push(b.CustomAPIRequestParameters.pop()); })],
    ['a planned child left out of the deep insert', withBody(apiPost, (b) => { b.CustomAPIResponseProperties = []; })],
    ['a nested child binding a parent', withBody(apiPost, (b) => { b.CustomAPIRequestParameters[0]['CustomAPIId@odata.bind'] = `/customapis(${OTHER})`; })],
    ['an unknown column', withBody(apiPost, (b) => { b.iscustomizable = true; })],
    ['an option code outside the table', withBody(apiPost, (b) => { b.bindingtype = 7; })],
    ['another value', withBody(apiPost, (b) => { b.isfunction = false; })],
    ['an unplanned id', withBody(apiPost, (b) => { b.customapiid = OTHER; })],
    ['a query beyond the id', { ...apiPost, url: `${apiPost.url}&$top=1` }],
    ['another solution', { ...defPost, headers: { ...defPost.headers, 'MSCRM.SolutionUniqueName': 'Fabrikam' } }],
    ['a value row with a solution header', { ...valuePost, headers: { ...valuePost.headers, 'MSCRM.SolutionUniqueName': SOL } }],
    ['a value under another definition', withBody(valuePost, (b) => { b['EnvironmentVariableDefinitionId@odata.bind'] = `/environmentvariabledefinitions(${OTHER})`; })],
    ['a value under no definition', withBody(valuePost, (b) => { delete b['EnvironmentVariableDefinitionId@odata.bind']; })],
    ['a column this build never writes', withBody(crPost, (b) => { b.promptingbehavior = 1; })],
    ['a column this build never writes, sent as the platform default', withBody(crPost, (b) => { b.promptingbehavior = 0; })],
    ['a definition kept by Dataverse', withBody(defPost, (b) => { b.secretstore = 1; })],
    ['a rule without its condition', withBody(rulePost, (b) => { b.DuplicateRule_DuplicateRuleConditions = []; })],
    ['a condition on its own', { method: 'POST', url: `${rulePost.url.replace('duplicaterules', 'duplicateruleconditions')}`, headers: {}, body: JSON.stringify(JSON.parse(rulePost.body).DuplicateRule_DuplicateRuleConditions[0]) }],
    ['a planned create PATCHed', { method: 'PATCH', url: apiPost.url.replace(/customapis\?.*$/, `customapis(${api.plan.rows[0].id})`), headers: {}, body: JSON.stringify({ description: 'x' }) }],
    ['a membership adding required components', withBody(apiMember, (b) => { b.AddRequiredComponents = true; })],
    ['a membership of another type', withBody(apiMember, (b) => { b.ComponentType = 4414; })],
    ['a membership of another solution', withBody(apiMember, (b) => { b.SolutionUniqueName = 'Fabrikam'; })],
    ['a publish with a body', { ...publish, body: JSON.stringify({ x: 1 }) }],
    ['a removal', { method: 'DELETE', url: apiPost.url.replace(/customapis\?.*$/, `customapis(${api.plan.rows[0].id})`), headers: {} }],
  ];
  for (const [what, req] of refused) assert.equal(classify(req), null, what);
  assert.equal(B.createClassifier([{ token: 'u', planned: unpublished }])(publish), null, 'a publish the plan does not declare');

  const valueSwap = thrown(() => classify(withBody(valuePost, (b) => { b.value = 'someone-else'; })));
  assert.equal(valueSwap && valueSwap.code, B.PRIVATE_MISMATCH);
  assert.ok(!valueSwap.message.includes('someone-else') && !valueSwap.message.includes(VALUE), 'the refusal names no private input');
  const connSwap = thrown(() => classify(withBody(crPost, (b) => { b.connectionid = 'another-connection'; })));
  assert.equal(connSwap && connSwap.code, B.PRIVATE_MISMATCH);
  assert.throws(() => B.createClassifier([{ token: 'a', planned: api }, { token: 'b', planned: planned('customApi', 'contoso_Calc') }]), /planned twice/);
});

test('a bound Custom API edit as the real SDK sends it: the root PATCH on its own or in a change set, a child\'s labels on their own', async () => {
  const fresh = planned('customApi', 'contoso_Calc');
  const w = await wireOf(fresh);
  const [apiPost, member] = w.sent;
  assert.equal(B.classifyConstituent([{ token: 't', planned: fresh }], apiPost), null, 'a root create');
  assert.equal(B.classifyConstituent([{ token: 't', planned: fresh }], member), null, 'a membership');
  const root = fresh.plan.rows[0].id;
  const api = (over) => spec({ customApis: [{ ...spec().customApis[0], ...over }] });

  // The root alone: one direct PATCH, the selected primary key in its query and the held row version in If-Match.
  const priv = await rebound(w.sdk.dataverse, fresh, { spec: api({ isPrivate: true }) });
  assert.deepEqual(priv.plan.rows.map((r) => r.id), fresh.plan.rows.map((r) => r.id), 'a bound plan keeps the ids it was created at');
  assert.equal(priv.plan.baseObservation.rowVersion, priv.rows[0].ifMatch);
  const one = await pushEdit(w, 'customApi', root, [['/isPrivate', true]]);
  assert.equal(one.result.saved, true);
  const [patch] = one.sent;
  assert.match(patch.url, /customapis\([^)]+\)\?\$select=customapiid$/);
  const entries = [{ token: 't', planned: priv }];
  assert.deepEqual(B.createClassifier(entries)(patch).rows.map((r) => r.kind), ['customApi'], 'the direct PATCH');
  assert.deepEqual(B.classifyConstituent(entries, patch).rows.map((r) => r.kind), ['customApi'], 'the same PATCH in a change set');
  assert.equal(B.createClassifier(entries)({ ...patch, url: patch.url.replace(/\?.*$/, '') }), null, 'without the selected key');
  assert.equal(B.createClassifier(entries)({ ...patch, url: `${patch.url},name` }), null, 'selecting more');
  assert.equal(B.createClassifier(entries)(withBody(patch, (b) => { b.isprivate = false; })), null, 'a PATCH to another value');

  // A child's labels alone, in both directions: a direct PATCH of that child.
  for (const [pointer, value, over, kind] of [
    ['/requestParameters/0/description', 'Arg', { requestParameters: [{ uniqueName: 'A', type: 'integer', description: 'Arg' }] }, 'customApiRequestParameter'],
    ['/responseProperties/0/name', 'contoso_Calc.R2', { responseProperties: [{ uniqueName: 'R', type: 'string', name: 'contoso_Calc.R2' }] }, 'customApiResponseProperty'],
  ]) {
    const p = await rebound(w.sdk.dataverse, fresh, { spec: api({ isPrivate: true, ...over }) });
    const edit = await pushEdit(w, 'customApi', root, [[pointer, value]]);
    assert.equal(edit.result.saved, true);
    assert.equal(edit.sent.length, 1);
    const named = B.createClassifier([{ token: 't', planned: p }])(edit.sent[0]);
    assert.deepEqual(named && named.rows.map((r) => [r.kind, r.parentId]), [[kind, root]], `${kind}: the SDK's own label PATCH`);
    assert.equal(B.classifyConstituent([{ token: 't', planned: p }], edit.sent[0]), null, `${kind}: never a constituent`);
    assert.equal(B.createClassifier([{ token: 't', planned: p }])(withBody(edit.sent[0], (b) => { b.type = 10; })), null, `${kind}: more than its labels`);
  }

  // The root with a later child, in both directions: one $batch whose constituents are the root PATCH and the child POST.
  for (const [list, add, kind, isPrivate] of [
    ['requestParameters', { uniqueName: 'B', type: 'string', isOptional: true }, 'customApiRequestParameter', false],
    ['responseProperties', { uniqueName: 'S', type: 'string' }, 'customApiResponseProperty', true],
  ]) {
    const declared = spec().customApis[0];
    const p = await rebound(w.sdk.dataverse, fresh, {
      spec: api({ isPrivate, requestParameters: declared.requestParameters, responseProperties: declared.responseProperties, [list]: [...declared[list], add] }),
    });
    const added = p.rows.find((r) => r.kind === kind && r.mode === 'create');
    const edit = await pushEdit(w, 'customApi', root, [['/isPrivate', isPrivate], [`/${list}`, B.artifactFor(p)[list]]]);
    assert.equal(edit.result.saved, true);
    assert.deepEqual(edit.sent.map((r) => r.url.replace(/^.*\/api\/data\/v9\.\d\//, '')), ['$batch']);
    assert.equal(B.createClassifier([{ token: 't', planned: p }])(edit.sent[0]), null, 'the $batch itself is refused today');
    const parts = constituentsOf(edit.sent[0]);
    assert.deepEqual(parts.map((c) => c.method), ['PATCH', 'POST']);
    const named = parts.map((c) => B.classifyConstituent([{ token: 't', planned: p }], c));
    assert.deepEqual(named.map((n) => n && n.rows.map((r) => r.id)), [[root], [added.id]], `${kind}: each constituent is its planned row`);
    assert.equal(B.classifyConstituent([{ token: 't', planned: p }], { ...parts[1], url: parts[1].url.replace(/\?.*$/, '') }), null, 'a child POST without its selected key');
    assert.equal(B.classifyConstituent([{ token: 't', planned: fresh }], parts[1]), null, 'a child POST under a root the plan creates');
    const created = planned('customApi', 'contoso_Calc', { spec: api({ isPrivate, requestParameters: declared.requestParameters, responseProperties: declared.responseProperties, [list]: [...declared[list], add] }) });
    assert.equal(rowOf(created, kind) && created.rows.find((r) => r.id === added.id).mode, 'create');
    assert.equal(B.classifyConstituent([{ token: 't', planned: created }], parts[1]), null, 'the same child POST when the plan creates its root');
  }

  // The root with a child's labels: the change set's child PATCH is refused; it is admitted only on its own.
  const both = await rebound(w.sdk.dataverse, fresh, { spec: api({ isPrivate: false, requestParameters: [{ uniqueName: 'A', type: 'integer', displayName: 'X' }] }) });
  const mixed = await pushEdit(w, 'customApi', root, [['/isPrivate', false], ['/requestParameters/0/displayName', 'X']]);
  const parts = constituentsOf(mixed.sent[0]);
  assert.deepEqual(parts.map((c) => [c.method, c.url.replace(/^.*\/api\/data\/v9\.\d\/|\(.*$/g, '')]), [['PATCH', 'customapis'], ['PATCH', 'customapirequestparameters']]);
  assert.ok(B.classifyConstituent([{ token: 't', planned: both }], parts[0]));
  assert.equal(B.classifyConstituent([{ token: 't', planned: both }], parts[1]), null, 'a child label PATCH in a change set');
  assert.ok(B.createClassifier([{ token: 't', planned: both }])(parts[1]), 'the same PATCH sent on its own');
});

test('a bound Custom API\'s registered implementation is kept exactly: never written, and the edit is proved only while the row holds that one', async () => {
  const PLUGIN = '00000000-0000-4000-8000-0000000000aa';
  const fresh = planned('customApi', 'contoso_Calc');
  assert.deepEqual(fresh.rows.map((r) => r.preserved), [{}, {}, {}], 'a create expects no implementation');
  const w = await wireOf(fresh);
  const row = w.org.rows('customapis')[0];
  row._plugintypeid_value = PLUGIN;
  const dv = w.sdk.dataverse;
  // A create is still proved only with no implementation: one on the row is not the row it made.
  assert.notEqual((await B.observe(dv, fresh)).rows[0].projectionSha256, fresh.rows[0].expectedSha256);

  const root = fresh.plan.rows[0].id;
  const p = await rebound(dv, fresh, { spec: spec({ customApis: [{ ...spec().customApis[0], isPrivate: true }] }) });
  assert.deepEqual(p.rows[0].preserved, { _plugintypeid_value: PLUGIN }, 'the exact plug-in type of the base read');
  assert.deepEqual(p.rows.slice(1).map((r) => r.preserved), [{}, {}]);
  assert.equal((await B.editShapeOf(dv, p)).rootChanged, true, 'the edit itself is the only difference');
  const edit = await pushEdit(w, 'customApi', root, [['/isPrivate', true]]);
  assert.equal(edit.sent.length, 1);
  const [patch] = edit.sent;
  assert.ok(!/plugintype/i.test(patch.body), 'the SDK sends no implementation');
  const classify = B.createClassifier([{ token: 't', planned: p }]);
  assert.ok(classify(patch), 'the edit\'s own PATCH');
  for (const [what, add] of [['the implementation', { _plugintypeid_value: PLUGIN }], ['a clear of it', { _plugintypeid_value: null }], ['a bind to it', { 'PluginTypeId@odata.bind': `/plugintypes(${PLUGIN})` }]]) {
    assert.equal(classify(withBody(patch, (b) => Object.assign(b, add))), null, `a PATCH carrying ${what}`);
  }
  assert.equal(row._plugintypeid_value, PLUGIN);
  const after = await B.observe(dv, p);
  assert.equal(after.rows[0].projectionSha256, p.rows[0].expectedSha256, 'proved with the implementation it was planned over');
  for (const changed of ['00000000-0000-4000-8000-0000000000bb', null]) {
    row._plugintypeid_value = changed;
    assert.notEqual((await B.observe(dv, p)).rows[0].projectionSha256, p.rows[0].expectedSha256, `an implementation ${changed ? 'replaced' : 'removed'}`);
  }
});

test('a PATCH carries exactly the row version the plan was prepared from; an update without a fresh base read is not planned', () => {
  const s = spec({ customApis: [{ ...spec().customApis[0], isPrivate: true }] });
  const base = (over = {}) => ({ state: 'present', kind: 'customApi', id: OTHER, parentId: null, rowVersion: 'W/"3"', decoded: { fields: { name: 'n', displayName: 'd', description: 'x' } }, ...over });
  const bound = (b) => planned('customApi', 'contoso_Calc', { spec: s, boundIdOf: (k) => (k === 'customApi' ? OTHER : undefined), bases: b === undefined ? undefined : new Map([[OTHER, b]]) });
  const p = bound(base());
  assert.equal(p.rows[0].ifMatch, 'W/"3"');
  assert.deepEqual(p.plan.baseObservation && p.plan.baseObservation.rowVersion, 'W/"3"');
  assert.equal(bound(base({ rowVersion: 'W/"4"' })).plan.declarationSha256, p.plan.declarationSha256, 'a version is no part of the declaration');
  assert.deepEqual([p.rows[0].expected.name, p.rows[0].expected.displayName, p.rows[0].expected.description], ['n', 'd', 'x'], 'labels the App Spec leaves out are the row\'s own');
  for (const [what, b] of [['no base', undefined], ['an absent base', { state: 'absent' }], ['another row\'s', base({ id: '11111111-1111-4111-8111-111111111111' })],
    ['another kind\'s', base({ kind: 'connectionReference' })], ['no version', base({ rowVersion: null })], ['a wildcard version', base({ rowVersion: '*' })]]) {
    assert.throws(() => bound(b), /no fresh base read with a row version/, what);
  }
  const classify = B.createClassifier([{ token: 't', planned: p }]);
  const url = `https://contoso.crm.dynamics.com/api/data/v9.0/customapis(${OTHER})?$select=customapiid`;
  const req = (headers) => ({ method: 'PATCH', url, headers, body: JSON.stringify({ isprivate: true }) });
  assert.ok(classify(req({ 'If-Match': 'W/"3"' })), 'the held version');
  assert.ok(classify(req({ 'if-match': 'W/"3"' })), 'in any spelling');
  for (const [what, headers] of [['no condition', {}], ['the wildcard', { 'If-Match': '*' }], ['another version', { 'If-Match': 'W/"999"' }],
    ['an older version', { 'If-Match': 'W/"2"' }], ['a list of versions', { 'If-Match': 'W/"3", W/"4"' }], ['two spellings', { 'If-Match': 'W/"3"', 'if-match': 'W/"3"' }],
    ['a version that is not text', { 'If-Match': ['W/"3"'] }]]) {
    assert.equal(classify(req(headers)), null, what);
  }
});

test('Custom API labels: the plan pins what the SDK fills in, and the bundled SDK sends the same body from an unpinned artifact', async () => {
  const authored = spec({ customApis: [{ uniqueName: 'contoso_Calc', displayName: 'Calc', requestParameters: [{ uniqueName: 'A', type: 'integer', displayName: 'Alpha' }], responseProperties: [{ uniqueName: 'R', type: 'string', description: 'Result' }] }] });
  for (const s of [spec(), authored]) {
    const p = planned('customApi', 'contoso_Calc', { spec: s });
    const unpinned = B.artifactFor(p);
    const declared = s.customApis[0];
    const strip = (o, from) => { for (const f of ['name', 'displayName', 'description']) if (from[f] === undefined) delete o[f]; };
    strip(unpinned, declared);
    unpinned.requestParameters.forEach((c, i) => strip(c, declared.requestParameters[i]));
    unpinned.responseProperties.forEach((c, i) => strip(c, declared.responseProperties[i]));
    const pinnedPost = (await wireOf(p)).sent[0];
    const rawPost = (await wireOf(p, { artifact: unpinned })).sent[0];
    assert.deepEqual(JSON.parse(rawPost.body), JSON.parse(pinnedPost.body), 'the SDK fills an unset label exactly as the plan pins it');
    assert.ok(B.createClassifier([{ token: 't', planned: p }])(rawPost));
  }
  const p = planned('customApi', 'contoso_Calc', { spec: authored });
  const [root, req, resp] = [p.rows[0].expected, rowOf(p, 'customApiRequestParameter').expected, rowOf(p, 'customApiResponseProperty').expected];
  assert.deepEqual([root.name, root.displayName, root.description], ['contoso_Calc', 'Calc', 'Calc']);
  assert.deepEqual([req.name, req.displayName, req.description], ['contoso_Calc.A', 'Alpha', 'Alpha']);
  assert.deepEqual([resp.name, resp.displayName, resp.description], ['contoso_Calc.R', 'R', 'Result']);
  const classify = B.createClassifier([{ token: 't', planned: p }]);
  const post = (await wireOf(p)).sent[0];
  assert.equal(classify(withBody(post, (b) => { b.name = 'Unplanned root label'; })), null, 'a root label the plan does not hold');
  assert.equal(classify(withBody(post, (b) => { b.CustomAPIRequestParameters[0].description = 'Unplanned'; })), null, 'a child label the plan does not hold');
});
// The real lifecycle: the SDK behind the real send-once gate, bound to a real binding store.
async function lifecycle() {
  const org = orgOf();
  const gate = createDeferredManagedCreateGate();
  const sdk = await sdkOf(org, gate);
  const storeDir = makeTempDir('cfg-create-store-');
  const store = openManagedBindings({ workspaceDir: storeDir, environment: org.origin, appUniqueName: 'contoso_app', solutionUniqueName: SOL });
  gate.bind(store);
  const ctx = createManagedCreateContext({ store, notFoundCode: B.NOT_FOUND_CODE });
  return { org, sdk, dv: sdk.dataverse, store, storeDir, ctx };
}
const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('one create set end to end: the SDK\'s own push and memberships through the gate, observed, settled and committed', async () => {
  const { org, sdk, dv, storeDir, ctx } = await lifecycle();
  assert.deepEqual(await B.readComponentTypes(dv), { complete: true, types: TYPES });
  const plans = ALL.map(([kind, key]) => planned(kind, key));
  for (const p of plans) assert.equal((await B.readConfigurationConflicts(dv, p)).state, 'clear');
  const attempts = ctx.begin(plans.map((p) => p.plan));
  const classify = B.createClassifier(plans.map((p, i) => ({ token: attempts[i].token, planned: p })));
  const scope = (i, acceptResult, fn) => ctx.run({ attempts: [attempts[i]], classify, deleteCode: B.DELETE_CODE, label: 'configuration create', acceptResult }, fn);
  for (const [i, p] of plans.entries()) {
    const pushed = await scope(i, B.acceptResultFor(p), async () => {
      await sdk.createArtifact(p.kind, B.artifactFor(p));
      return sdk.pushArtifact(p.kind, p.plan.rows[0].id);
    });
    assert.deepEqual([pushed.error, pushed.localError, pushed.checked], [null, null, true], `${p.kind}: a checked push`);
    // The members the platform did not add with the solution header (a rule's condition), added by the driver.
    const missing = (await B.observe(dv, p)).members.filter((m) => m.state === 'absent').map((m) => p.plan.members.find((x) => x.id === m.id));
    const added = await scope(i, undefined, async () => {
      for (const m of missing) await dv.post('/AddSolutionComponent', { ComponentId: m.id, ComponentType: m.componentType, SolutionUniqueName: SOL, AddRequiredComponents: false });
    });
    assert.equal(added.localError, null);
    const [settled] = ctx.settle([{ token: attempts[i].token, observation: await B.observe(dv, p) }]);
    assert.equal(settled.verdict.action, 'commit', `${p.kind}: ${settled.verdict.code || ''} ${settled.verdict.message || ''}`);
    assert.deepEqual(settled.group.records.map((r) => [r.kind, r.id, r.origin]), p.plan.rows.map((r) => [r.kind, r.id, 'created']));
  }
  assert.equal(org.rows('duplicaterules')[0].statecode, 1, 'the rule was published inside its own create set');
  assert.deepEqual(org.unexpected, []);
  for (const file of filesUnder(storeDir)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(VALUE) && !text.includes(CONNECTION), `no private input in ${path.basename(file)}`);
  }
});

test('a push carrying another private input is refused unsent, and the refusal names no value', async () => {
  const { org, sdk, dv, ctx } = await lifecycle();
  const p = planned('environmentVariable', 'contoso_ApiBase');
  const [attempt] = ctx.begin([p.plan]);
  const out = await ctx.run({ attempts: [attempt], classify: B.createClassifier([{ token: attempt.token, planned: p }]), deleteCode: B.DELETE_CODE, label: 'configuration create', acceptResult: B.acceptResultFor(p) }, async () => {
    const artifact = B.artifactFor(p);
    artifact.currentValue.value = 'someone-else';
    await sdk.createArtifact(p.kind, artifact);
    return sdk.pushArtifact(p.kind, p.plan.rows[0].id);
  });
  assert.equal(out.localError && out.localError.code, B.PRIVATE_MISMATCH);
  assert.equal(out.checked, false);
  assert.ok(!out.localError.message.includes('someone-else') && !out.localError.message.includes(VALUE));
  assert.deepEqual(org.rows('environmentvariablevalues'), [], 'the value was never sent');
  const [held] = ctx.settle([{ token: attempt.token, observation: await B.observe(dv, p) }]);
  assert.equal(held.verdict.code, CODES.completion, 'the definition alone is not the planned set');
});

test('fake org paging is opt-in: without pageSize a collection is one page, as before', async () => {
  const org = orgOf();
  for (const n of [1, 2, 3]) await seed(org, 'connectionreferences', { connectionreferenceid: `00000000-0000-4000-8000-00000000000${n}`, connectionreferencelogicalname: `contoso_c${n}`, connectorid: SP });
  const all = await org.request({ url: `${org.origin}/api/data/v9.2/connectionreferences?$select=connectionreferenceid`, method: 'GET', headers: {} });
  const body = typeof all.body === 'string' ? JSON.parse(all.body) : all.body;
  assert.equal(body.value.length, 3);
  assert.equal(body['@odata.nextLink'], undefined);
  const paged = orgOf({ pageSize: 2 });
  for (const n of [1, 2, 3]) await seed(paged, 'connectionreferences', { connectionreferenceid: `00000000-0000-4000-8000-00000000000${n}`, connectionreferencelogicalname: `contoso_c${n}`, connectorid: SP });
  const sdk = await sdkOf(paged, null);
  const first = await sdk.dataverse.get('/connectionreferences?$select=connectionreferenceid');
  assert.equal(first.body.value.length, 2);
  const second = await sdk.dataverse.getAbsolute(first.body['@odata.nextLink']);
  assert.deepEqual([second.body.value.length, second.body['@odata.nextLink']], [1, undefined]);
});

test('an environment variable\'s secret store is read and compared: empty or Key Vault is what a create makes, Dataverse differs, anything else is unknown', async () => {
  const s = spec({ environmentVariables: [spec().environmentVariables[0], { schemaName: 'contoso_Secret', type: 'secret' }, { schemaName: 'contoso_Plain', type: 'string' }] });
  for (const key of ['contoso_Secret', 'contoso_Plain']) {
    const p = planned('environmentVariable', key, { spec: s });
    const w = await wireOf(p);
    const id = p.plan.rows[0].id;
    const store = async (value) => {
      const res = await w.org.request({ url: `${w.org.origin}/api/data/v9.2/environmentvariabledefinitions(${id})`, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secretstore: value }) });
      assert.ok(res.statusCode < 300, `PATCH secretstore ${value}: ${res.statusCode}`);
    };
    const root = async (dv = w.sdk.dataverse) => {
      const r = (await B.observe(dv, p)).rows[0];
      return r.state === 'present' ? (r.projectionSha256 === p.rows[0].expectedSha256 ? 'same' : 'differs') : r.state;
    };
    assert.equal(await root(), 'same', `${key}: as created (the column left empty)`);
    await store(0);
    assert.equal(await root(), 'same', `${key}: Azure Key Vault, the column's default`);
    await store(1);
    assert.equal(await root(), 'differs', `${key}: a value kept by Dataverse is not the definition the plan made`);
    await store(2);
    assert.equal(await root(), 'unknown', `${key}: a store this build cannot read`);
    await store(null);
    const unselected = { ...w.sdk.dataverse, get: async (q) => {
      const r = await w.sdk.dataverse.get(q);
      if (!q.startsWith('/environmentvariabledefinitions(')) return r;
      const body = { ...r.body };
      delete body.secretstore;
      return { ...r, body };
    } };
    assert.equal(await root(unselected), 'unknown', `${key}: a read without the column proves nothing about it`);
  }
});

test('a rule is published once, by the create set that makes it: a bound rule\'s plan verifies its state and publishes nothing', async () => {
  const created = planned('duplicateRule', 'email');
  const id = created.plan.rows[0].id;
  assert.deepEqual(created.plan.effects.filter((e) => e.kind === 'rule-state'), [{ kind: 'rule-state', id }]);
  const publish = (ruleId) => ({ method: 'POST', url: `https://contoso.crm.dynamics.com/api/data/v9.0/duplicaterules(${ruleId})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, headers: {}, body: '{}' });
  assert.deepEqual(B.createClassifier([{ token: 't', planned: created }])(publish(id)), { type: 'effect', token: 't', kind: 'rule-state', id });
  const unpublished = planned('duplicateRule', 'email', { spec: spec({ duplicateDetectionRules: [{ ...spec().duplicateDetectionRules[0], status: 'unpublished' }] }) });
  assert.deepEqual(unpublished.plan.effects.filter((e) => e.kind === 'rule-state'), []);
  const w = await wireOf(created);
  const bound = await rebound(w.sdk.dataverse, created);
  assert.deepEqual([bound.rows[0].mode, bound.plan.ruleState], ['update', 'published'], 'the state the rule must read back as');
  assert.deepEqual(bound.plan.effects.filter((e) => e.kind === 'rule-state'), [], 'and no publish is planned for it');
  assert.equal(B.createClassifier([{ token: 't', planned: bound }])(publish(id)), null, 'a publish of a bound rule');
  // A bound rule whose App Spec omits its status keeps the row's state: a rule somebody unpublished is verified as
  // unpublished, never published again. An authored status is the declared one.
  const unpublish = await w.org.request({ url: `${w.org.origin}/api/data/v9.2/duplicaterules(${id})`, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statecode: 0, statuscode: 0 }) });
  assert.ok(unpublish.statusCode < 300);
  assert.equal((await rebound(w.sdk.dataverse, created)).plan.ruleState, 'unpublished');
  const declared = spec({ duplicateDetectionRules: [{ ...spec().duplicateDetectionRules[0], status: 'published' }] });
  assert.equal((await rebound(w.sdk.dataverse, created, { spec: declared })).plan.ruleState, 'published');
});

test('completion reads the root\'s whole child graph: a child the plan does not hold, on any page, is a difference; a graph not read whole is unknown', async () => {
  // A condition added under the rule while it is still unpublished, then published inside the set: never the prepared rule.
  {
    const { org, sdk, dv, ctx } = await lifecycle();
    const p = planned('duplicateRule', 'email');
    const [attempt] = ctx.begin([p.plan]);
    const classify = B.createClassifier([{ token: attempt.token, planned: p }]);
    const run = (fn, acceptResult) => ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, label: 'configuration create', acceptResult }, fn);
    const artifact = B.artifactFor(p);
    artifact.status = 'unpublished';
    const pushed = await run(async () => { await sdk.createArtifact(p.kind, artifact); return sdk.pushArtifact(p.kind, p.plan.rows[0].id); }, B.acceptResultFor(p));
    assert.equal(pushed.checked, true);
    await seed(org, 'duplicateruleconditions', { duplicateruleconditionid: OTHER, baseattributename: 'lastname', matchingattributename: 'lastname', operatorcode: 0, ignoreblankvalues: false, 'regardingobjectid@odata.bind': `/duplicaterules(${p.rows[0].id})` });
    const done = await run(async () => {
      for (const m of (await B.observe(dv, p)).members.filter((x) => x.state === 'absent')) {
        const full = p.plan.members.find((x) => x.id === m.id);
        await dv.post('/AddSolutionComponent', { ComponentId: m.id, ComponentType: full.componentType, SolutionUniqueName: SOL, AddRequiredComponents: false });
      }
      await dv.post(`/duplicaterules(${p.rows[0].id})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, {});
    });
    assert.equal(done.localError, null);
    const observation = await B.observe(dv, p);
    assert.equal(observation.ruleState, 'published');
    assert.deepEqual(observation.rows.slice(1).map((r) => r.projectionSha256 === rowOf(p, r.kind).expectedSha256), [true], 'the planned condition alone still reads as planned');
    const [settled] = ctx.settle([{ token: attempt.token, observation }]);
    assert.notEqual(settled.verdict.action, 'commit', 'a rule with a condition the plan never made is not the rule it prepared');
  }
  const differs = async (dv, p) => {
    const r = (await B.observe(dv, p)).rows[0];
    return r.state === 'present' ? (r.projectionSha256 === p.rows[0].expectedSha256 ? 'same' : 'differs') : r.state;
  };
  // A second value under the definition.
  const ev = planned('environmentVariable', 'contoso_ApiBase');
  const evWire = await wireOf(ev);
  assert.equal(await differs(evWire.sdk.dataverse, ev), 'same');
  await seed(evWire.org, 'environmentvariablevalues', { environmentvariablevalueid: OTHER, value: 'another', 'EnvironmentVariableDefinitionId@odata.bind': `/environmentvariabledefinitions(${ev.rows[0].id})` });
  assert.equal(await differs(evWire.sdk.dataverse, ev), 'differs', 'a value the plan does not hold');
  // A child the plan does not hold, in each direction, the second on a later page.
  const api = planned('customApi', 'contoso_Calc');
  const root = api.rows[0].id;
  for (const [set, body, opts] of [
    ['customapirequestparameters', { customapirequestparameterid: OTHER, uniquename: 'Z', name: 'Z', displayname: 'Z', type: 10 }, {}],
    ['customapiresponseproperties', { customapiresponsepropertyid: OTHER, uniquename: 'Z', name: 'Z', displayname: 'Z', type: 10 }, { pageSize: 1 }],
  ]) {
    const w = await wireOf(api, { org: orgOf(opts) });
    assert.equal(await differs(w.sdk.dataverse, api), 'same', `${set}: the planned graph`);
    await seed(w.org, set, { ...body, 'CustomAPIId@odata.bind': `/customapis(${root})` });
    const since = w.org.requests.length;
    assert.equal(await differs(w.sdk.dataverse, api), 'differs', `${set}: an extra child`);
    if (opts.pageSize) assert.ok(w.org.requests.slice(since).some((r) => r.path.startsWith('/customapiresponseproperties') && /\$skiptoken=/.test(r.path)), 'found on the second page');
  }
  // Any doubt about the graph leaves the root unknown.
  const w = await wireOf(api);
  const dv = w.sdk.dataverse;
  const reqId = rowOf(api, 'customApiRequestParameter').id;
  const around = (match, fn) => ({ ...dv, get: async (q) => (match.test(q) ? fn(q, await dv.get(q)) : dv.get(q)) });
  const listOf = /^\/customapirequestparameters\?/;
  for (const [what, reading] of [
    ['a collection that cannot be read', around(listOf, () => ({ status: 500, body: {} }))],
    ['a collection that does not end', around(listOf, (q, r) => ({ ...r, body: { ...r.body, '@Microsoft.Dynamics.CRM.morerecords': true } }))],
    ['a row under another parent', around(listOf, (q, r) => ({ ...r, body: { value: r.body.value.map((x) => ({ ...x, _customapiid_value: OTHER })) } }))],
    ['a row named twice', around(listOf, (q, r) => ({ ...r, body: { value: [...r.body.value, ...r.body.value] } }))],
    ['a row without an id', around(listOf, (q, r) => ({ ...r, body: { value: [...r.body.value, { _customapiid_value: root }] } }))],
    ['a planned child listed but read absent', around(new RegExp(`^/customapirequestparameters\\(${reqId}\\)`), () => ({ status: 404, body: { error: { code: '0x80040217' } } }))],
    ['a planned child read but not listed', around(listOf, (q, r) => ({ ...r, body: { value: [] } }))],
  ]) {
    assert.equal(await differs(reading, api), 'unknown', what);
  }
  assert.equal(await differs(dv, api), 'same');
});

test('a label someone else changed, or one the plan never held, is never certified', async () => {
  const { org, sdk, dv, ctx } = await lifecycle();
  const p = planned('customApi', 'contoso_Calc');
  const [attempt] = ctx.begin([p.plan]);
  const classify = B.createClassifier([{ token: attempt.token, planned: p }]);
  const artifact = B.artifactFor(p);
  artifact.name = 'Unplanned root label';
  artifact.requestParameters[0].name = 'Unplanned child label';
  const run = await ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, label: 'configuration create', acceptResult: B.acceptResultFor(p) }, async () => {
    await sdk.createArtifact(p.kind, artifact);
    return sdk.pushArtifact(p.kind, p.plan.rows[0].id);
  });
  assert.equal(run.checked, false);
  assert.deepEqual(org.rows('customapis'), [], 'refused unsent');
  const [settled] = ctx.settle([{ token: attempt.token, observation: await B.observe(dv, p) }]);
  assert.notEqual(settled.verdict.action, 'commit');
  // The planned labels, created as planned, then changed by someone else: the read-back differs on that row.
  const w = await wireOf(p);
  const reqId = rowOf(p, 'customApiRequestParameter').id;
  const same = async () => (await B.observe(w.sdk.dataverse, p)).rows.map((r) => r.projectionSha256 === rowOf(p, r.kind).expectedSha256);
  assert.deepEqual(await same(), [true, true, true]);
  const res = await w.org.request({ url: `${w.org.origin}/api/data/v9.2/customapirequestparameters(${reqId})`, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Changed' }) });
  assert.ok(res.statusCode < 300);
  assert.deepEqual(await same(), [true, false, true]);
});

test('pins: a data-source definition, every root\'s namesake predicate, a condition\'s namesake, private inputs out of every durable record', async () => {
  const s23 = (over) => spec({ minimumPluginVersion: '2.23.0', ...over });
  // A data-source definition: the SDK's own create classifies and reads back as planned.
  const site = planned('environmentVariable', 'contoso_Site', { spec: s23({ environmentVariables: [spec().environmentVariables[0], { schemaName: 'contoso_Site', type: 'dataSource', connectorId: SP, parameterKey: 'dataset' }] }) });
  const siteWire = await wireOf(site);
  assert.ok(B.createClassifier([{ token: 't', planned: site }])(siteWire.sent.find((r) => /environmentvariabledefinitions/.test(r.url))));
  assert.equal((await B.observe(siteWire.sdk.dataverse, site)).rows[0].projectionSha256, site.rows[0].expectedSha256);
  // A namesake differing only in case (a rule's name with quotes and an ampersand) at another id is a conflict.
  for (const [kind, key, data, set, body] of [
    ['environmentVariable', 'contoso_Name', { environmentVariables: [{ schemaName: 'contoso_Name', type: 'string' }] }, 'environmentvariabledefinitions', { environmentvariabledefinitionid: OTHER, schemaname: 'CONTOSO_name', type: 100000000 }],
    ['connectionReference', 'contoso_Name', { connectionReferences: [{ logicalName: 'contoso_Name', connectorId: SP }] }, 'connectionreferences', { connectionreferenceid: OTHER, connectionreferencelogicalname: 'CONTOSO_name', connectorid: SP }],
    ['customApi', 'contoso_Name', { customApis: [{ uniqueName: 'contoso_Name' }] }, 'customapis', { customapiid: OTHER, uniquename: 'CONTOSO_name' }],
    ['duplicateRule', 'rk', { duplicateDetectionRules: [{ key: 'rk', name: "O'Brien & sons", entity: 'contact', conditions: [] }] }, 'duplicaterules', { duplicateruleid: OTHER, name: "O'BRIEN & SONS", baseentityname: 'account', matchingentityname: 'account' }],
  ]) {
    const p = planned(kind, key, { spec: { minimumPluginVersion: '2.23.0', solution: { uniqueName: SOL, publisherPrefix: 'contoso' }, ...data } });
    const org = orgOf();
    await seed(org, set, body);
    assert.equal((await B.readConfigurationConflicts((await sdkOf(org, null)).dataverse, p)).state, 'conflict', kind);
  }
  // A condition's namesake under a bound rule: every authored optional field and the actual parent.
  const ruleBase = await B.readConfigurationRow(reader([[`/duplicaterules(${OTHER})`, { status: 200, body: {
    '@odata.etag': 'W/"5"', duplicateruleid: OTHER, name: 'Same email', description: null, baseentityname: 'contact', matchingentityname: 'contact',
    iscasesensitive: false, excludeinactiverecords: false, statecode: 1, statuscode: 2,
  } }]]), 'duplicateRule', OTHER);
  const rule = planned('duplicateRule', 'rk|/x', { spec: s23({ duplicateDetectionRules: [{ key: 'rk|/x', name: 'Same email', entity: 'contact', conditions: [{ key: 'ck|/y', column: 'emailaddress1', matchingColumn: 'lastname', match: 'firstCharacters', characters: 3, ignoreBlankValues: true }] }] }), boundIdOf: (k) => (k === 'duplicateRule' ? OTHER : undefined), bases: new Map([[OTHER, ruleBase]]) });
  assert.equal(rule.rows[1].key, JSON.stringify(['rk|/x', 'ck|/y']));
  const row = { duplicateruleconditionid: '11111111-1111-4111-8111-111111111111', baseattributename: 'EMAILADDRESS1', matchingattributename: 'LASTNAME', operatorcode: 1, operatorparam: 3, ignoreblankvalues: true, _regardingobjectid_value: OTHER };
  for (const [change, expected] of [[{}, 'conflict'], [{ matchingattributename: 'emailaddress1' }, 'clear'], [{ operatorparam: 2 }, 'clear'], [{ ignoreblankvalues: false }, 'clear'],
    [{ operatorcode: 2 }, 'clear'], [{ _regardingobjectid_value: row.duplicateruleconditionid }, 'unknown'], [{ operatorparam: '3' }, 'unknown'], [{ duplicateruleconditionid: 'not-a-guid' }, 'unknown']]) {
    const dv = { get: async (q) => {
      assert.ok(q.startsWith(`/duplicateruleconditions?$filter=_regardingobjectid_value eq ${OTHER}&$select=`));
      return { status: 200, body: { value: [{ ...row, ...change }] } };
    } };
    assert.equal((await B.readConfigurationConflicts(dv, rule)).state, expected, JSON.stringify(change));
  }
  // Another private input changes neither the plan nor a sealed projection.
  const priv = s23({ environmentVariables: [{ schemaName: 'contoso_Private', type: 'string' }], connectionReferences: [{ logicalName: 'contoso_ref', connectorId: SP }] });
  const deploy = (v) => A.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_Private', Value: `value-${v}` }], ConnectionReferences: [{ LogicalName: 'contoso_ref', ConnectionId: `connection-${v}` }] }, priv);
  for (const [kind, key, column] of [['environmentVariable', 'contoso_Private', 'value'], ['connectionReference', 'contoso_ref', 'connectionid']]) {
    const p = B.planOf(priv, { kind, key, bindings: deploy('one'), solution: SOL, componentTypes: TYPES });
    const q = B.planOf(priv, { kind, key, bindings: deploy('two'), solution: SOL, componentTypes: TYPES });
    assert.deepEqual(p, q);
    const req = (await wireOf(p)).sent.find((r) => r.body && Object.hasOwn(JSON.parse(r.body), column));
    const other = withBody(req, (b) => { b[column] = column === 'value' ? 'value-two' : 'connection-two'; });
    assert.deepEqual(B.createClassifier([{ token: 't', planned: p }])(req), B.createClassifier([{ token: 't', planned: q }])(other));
  }
});
test('a bound row keeps what its App Spec omits: the expectation is the row read under the authored fields, never a create default', async () => {
  const sameAs = async (dv, p, label) => {
    const seen = await B.observe(dv, p);
    for (const r of p.rows) assert.equal(seen.rows.find((x) => x.id === r.id).projectionSha256, r.expectedSha256, `${label}: ${r.kind}`);
  };
  // A Custom API made private, then edited by a description-only App Spec that no longer says so.
  {
    const s = spec({ customApis: [{ ...spec().customApis[0], isPrivate: true }] });
    const first = planned('customApi', 'contoso_Calc', { spec: s });
    const w = await wireOf(first);
    const next = structuredClone(s);
    delete next.customApis[0].isPrivate;
    next.customApis[0].description = 'A description-only edit';
    const q = await rebound(w.sdk.dataverse, first, { spec: next });
    assert.equal(q.rows[0].expected.isPrivate, true, 'an omitted flag keeps the row\'s own value');
    const edit = await pushEdit(w, 'customApi', first.rows[0].id, [['/description', 'A description-only edit']]);
    assert.equal(edit.result.saved, true);
    assert.deepEqual(Object.keys(JSON.parse(edit.sent[0].body)), ['description'], 'the SDK sends only the edited field');
    assert.ok(B.createClassifier([{ token: 't', planned: q }])(edit.sent[0]), 'and that PATCH is the planned one');
    await sameAs(w.sdk.dataverse, q, 'omitted isPrivate');
    // An explicit false is still a change, and a create of the same App Spec still takes the create default.
    const flipped = structuredClone(next);
    flipped.customApis[0].isPrivate = false;
    const r = await rebound(w.sdk.dataverse, first, { spec: flipped });
    assert.equal(r.rows[0].expected.isPrivate, false);
    assert.notEqual((await B.observe(w.sdk.dataverse, r)).rows[0].projectionSha256, r.rows[0].expectedSha256, 'an explicit false the row does not show yet');
    assert.equal(planned('customApi', 'contoso_Calc', { spec: next }).rows[0].expected.isPrivate, false, 'a created row: the create default');
  }
  // An environment variable's default value and required flag, omitted by a later description-only edit.
  {
    const s = spec({ environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'fallback', isRequired: true }] });
    const first = planned('environmentVariable', 'contoso_ApiBase', { spec: s });
    const w = await wireOf(first);
    const next = spec({ environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', description: 'A description-only edit' }] });
    const q = await rebound(w.sdk.dataverse, first, { spec: next });
    assert.deepEqual([q.rows[0].expected.defaultValue, q.rows[0].expected.isRequired], ['fallback', true]);
    const edit = await pushEdit(w, 'environmentVariable', first.rows[0].id, [['/description', 'A description-only edit']]);
    assert.equal(edit.result.saved, true);
    await sameAs(w.sdk.dataverse, q, 'omitted defaultValue and isRequired');
    const cleared = spec({ environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', description: 'A description-only edit', defaultValue: null, isRequired: false }] });
    const c = await rebound(w.sdk.dataverse, first, { spec: cleared });
    assert.deepEqual([c.rows[0].expected.defaultValue, c.rows[0].expected.isRequired], [null, false], 'an explicit null and false stay changes');
    const created = planned('environmentVariable', 'contoso_ApiBase', { spec: next });
    assert.deepEqual([created.rows[0].expected.defaultValue, created.rows[0].expected.isRequired], [null, false], 'a created row: the create defaults');
  }
  // A connection reference's description and connection, and a rule's flags and its condition's optional fields.
  {
    const s = spec({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP, description: 'Kept' }] });
    const first = planned('connectionReference', 'contoso_sp', { spec: s });
    const w = await wireOf(first);
    const next = spec({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] });
    const q = await rebound(w.sdk.dataverse, first, { spec: next, bindings: A.readDeploymentBindings({}, next) });
    assert.deepEqual([q.rows[0].expected.description, q.rows[0].expected.connected], ['Kept', true], 'no binding asked: the row keeps its connection');
    await sameAs(w.sdk.dataverse, q, 'omitted description and connection');
  }
  {
    const declared = { key: 'email', name: 'Same email', entity: 'contact', caseSensitive: true, conditions: [{ key: 'e', column: 'emailaddress1', match: 'firstCharacters', characters: 3, ignoreBlankValues: true }] };
    const first = planned('duplicateRule', 'email', { spec: spec({ duplicateDetectionRules: [declared] }) });
    const w = await wireOf(first);
    const next = spec({ duplicateDetectionRules: [{ key: 'email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'firstCharacters' }] }] });
    const q = await rebound(w.sdk.dataverse, first, { spec: next });
    assert.equal(q.rows[0].expected.caseSensitive, true);
    assert.deepEqual(q.rows[1].expected, { column: 'emailaddress1', matchingColumn: 'emailaddress1', match: 'firstCharacters', characters: 3, ignoreBlankValues: true });
    await sameAs(w.sdk.dataverse, q, 'omitted rule flag and condition fields');
    const created = planned('duplicateRule', 'email', { spec: next });
    assert.deepEqual([created.rows[0].expected.caseSensitive, created.rows[1].expected.ignoreBlankValues, created.rows[1].expected.characters], [false, false, null], 'a created rule: the create defaults');
  }
});

// Create one planned artifact through its own create set and commit it, as the lifecycle test does.
async function createCommitted(h, p) {
  const [attempt] = h.ctx.begin([p.plan]);
  const classify = B.createSetClassifier([{ token: attempt.token, planned: p }]);
  const scope = (fn, acceptResult) => h.ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, label: 'configuration create', acceptResult }, fn);
  const pushed = await scope(async () => {
    await h.sdk.createArtifact(p.kind, B.artifactFor(p));
    return h.sdk.pushArtifact(p.kind, p.plan.rows[0].id);
  }, B.acceptResultFor(p));
  assert.deepEqual([pushed.error, pushed.localError, pushed.checked], [null, null, true]);
  await addMissingMembers(h, p, scope);
  const [settled] = h.ctx.settle([{ token: attempt.token, observation: await B.observe(h.dv, p) }]);
  assert.equal(settled.verdict.action, 'commit', `${settled.verdict.code || ''} ${settled.verdict.message || ''}`);
  return settled;
}
async function addMissingMembers(h, p, scope) {
  const missing = (await B.observe(h.dv, p)).members.filter((m) => m.state === 'absent').map((m) => p.plan.members.find((x) => x.id === m.id));
  if (!missing.length) return;
  const added = await scope(async () => {
    for (const m of missing) await h.dv.post('/AddSolutionComponent', { ComponentId: m.id, ComponentType: m.componentType, SolutionUniqueName: SOL, AddRequiredComponents: false });
  });
  assert.equal(added.localError, null);
}

test('a bound Custom API edit is one checked change set end to end: the root PATCH with new children of both kinds, or new children only', async () => {
  const api = (over) => spec({ customApis: [{ ...spec().customApis[0], ...over }] });
  const declared = spec().customApis[0];
  for (const [label, over, ops, want] of [
    ['root plus both kinds', { isPrivate: true, requestParameters: [...declared.requestParameters, { uniqueName: 'B', type: 'string', isOptional: true }], responseProperties: [...declared.responseProperties, { uniqueName: 'S', type: 'integer' }] },
      (p) => [['/isPrivate', true], ['/requestParameters', B.artifactFor(p).requestParameters], ['/responseProperties', B.artifactFor(p).responseProperties]], ['PATCH', 'POST', 'POST']],
    ['children only, both kinds', { requestParameters: [...declared.requestParameters, { uniqueName: 'B', type: 'string' }], responseProperties: [...declared.responseProperties, { uniqueName: 'S', type: 'integer' }] },
      (p) => [['/requestParameters', B.artifactFor(p).requestParameters], ['/responseProperties', B.artifactFor(p).responseProperties]], ['POST', 'POST']],
  ]) {
    const h = await lifecycle();
    const fresh = planned('customApi', 'contoso_Calc');
    await createCommitted(h, fresh);
    const p = await rebound(h.dv, fresh, { spec: api(over), baseGeneration: h.store.readGroup('customApi', fresh.key).committed.generation });
    const [attempt] = h.ctx.begin([p.plan]);
    const classify = B.createSetClassifier([{ token: attempt.token, planned: p }]);
    const batch = { apiBase: `${h.org.origin}/api/data/v9.0`, solution: SOL };
    const scope = (fn, acceptResult) => h.ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, label: 'configuration edit', acceptResult, batch }, fn);
    const root = fresh.plan.rows[0].id;
    const mark = h.org.requests.length;
    const pushed = await scope(async () => {
      await h.sdk.fetchArtifact('customApi', root, { overwrite: true });
      for (const [pointer, value] of ops(p)) await h.sdk.updateElement('customApi', root, pointer, value);
      return h.sdk.pushArtifact('customApi', root);
    }, B.acceptResultFor(p));
    const requests = h.org.requests.slice(mark).filter((r) => r.method !== 'GET');
    assert.deepEqual([pushed.error, pushed.localError, pushed.checked], [null, null, true], `${label}: a checked change set`);
    assert.deepEqual(requests.map((r) => r.path), ['/$batch'], `${label}: one request left`);
    assert.deepEqual(requests[0].operations.map((c) => c.method), want);
    await addMissingMembers(h, p, scope);
    const [settled] = h.ctx.settle([{ token: attempt.token, observation: await B.observe(h.dv, p) }]);
    assert.equal(settled.verdict.action, 'commit', `${label}: ${settled.verdict.code || ''} ${settled.verdict.message || ''}`);
    const added = p.rows.filter((r) => r.mode === 'create').map((r) => r.id).sort();
    assert.equal(added.length, 2);
    assert.deepEqual(settled.group.records.filter((r) => added.includes(r.id)).map((r) => r.origin), ['created', 'created'], `${label}: the new children are this run's creates`);
    assert.deepEqual(h.org.unexpected, []);
  }
});

test('a change-set constituent the plan did not prepare is refused before anything is sent', async () => {
  const h = await lifecycle();
  const fresh = planned('customApi', 'contoso_Calc');
  await createCommitted(h, fresh);
  const declared = spec().customApis[0];
  const p = await rebound(h.dv, fresh, { spec: spec({ customApis: [{ ...declared, isPrivate: true, requestParameters: [...declared.requestParameters, { uniqueName: 'B', type: 'string' }] }] }), baseGeneration: h.store.readGroup('customApi', fresh.key).committed.generation });
  const root = fresh.plan.rows[0].id;
  const [attempt] = h.ctx.begin([p.plan]);
  // The SDK is asked for another child than the plan's (another type): the parser's constituent check refuses the set.
  const other = B.artifactFor(p).requestParameters.map((c) => (c.uniqueName === 'B' ? { ...c, type: 'integer' } : c));
  const mark = h.org.requests.length;
  const out = await h.ctx.run({
    attempts: [attempt], classify: B.createSetClassifier([{ token: attempt.token, planned: p }]), deleteCode: B.DELETE_CODE, label: 'configuration edit',
    acceptResult: B.acceptResultFor(p), batch: { apiBase: `${h.org.origin}/api/data/v9.0`, solution: SOL },
  }, async () => {
    await h.sdk.fetchArtifact('customApi', root, { overwrite: true });
    await h.sdk.updateElement('customApi', root, '/isPrivate', true);
    await h.sdk.updateElement('customApi', root, '/requestParameters', other);
    return h.sdk.pushArtifact('customApi', root);
  });
  const requests = h.org.requests.slice(mark).filter((r) => r.method !== 'GET');
  assert.notEqual(out.localError, null, 'refused locally');
  assert.deepEqual(requests, [], 'nothing was sent');
});