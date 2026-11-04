'use strict';
// The protected create driver of the configuration families (lib/configuration-create-bindings.js), not wired into the
// build yet: its plan, its exact and namesake reads, its classifier of the SDK's own requests, and one full create set
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
// Every mutation the real SDK sends to push `p`, as the gate is asked about it (the body is the JSON text it sends).
async function wireOf(p) {
  const org = orgOf();
  const sent = [];
  const sdk = await sdkOf(org, { screen(req) { if (req.method !== 'GET') sent.push({ ...req, headers: { ...req.headers } }); return null; } });
  await sdk.createArtifact(p.kind, B.artifactFor(p));
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

test('classifyConstituent: only a bound Custom API\'s later child or root PATCH, never a root create or an effect', async () => {
  const fresh = planned('customApi', 'contoso_Calc');
  const { sent } = await wireOf(fresh);
  const [apiPost, member] = sent;
  assert.equal(B.classifyConstituent([{ token: 't', planned: fresh }], apiPost), null, 'a root create');
  assert.equal(B.classifyConstituent([{ token: 't', planned: fresh }], member), null, 'a membership');
  const root = fresh.plan.rows[0].id;
  const bound = planned('customApi', 'contoso_Calc', { boundIdOf: (kind) => (kind === 'customApi' ? root : undefined) });
  assert.equal(bound.plan.rows[0].mode, 'update');
  const param = JSON.parse(apiPost.body).CustomAPIRequestParameters[0];
  const childPost = { method: 'POST', url: apiPost.url.replace(/customapis\?.*$/, 'customapirequestparameters'), headers: {}, body: JSON.stringify({ ...param, customapirequestparameterid: rowOf(bound, 'customApiRequestParameter').id, 'CustomAPIId@odata.bind': `/customapis(${root})` }) };
  const named = B.classifyConstituent([{ token: 't', planned: bound }], childPost);
  assert.deepEqual(named && named.rows.map((r) => [r.kind, r.parentId]), [['customApiRequestParameter', root]]);
  const patch = { method: 'PATCH', url: apiPost.url.replace(/customapis\?.*$/, `customapis(${root})`), headers: {}, body: JSON.stringify({ isfunction: true }) };
  assert.equal(B.classifyConstituent([{ token: 't', planned: bound }], patch).rows[0].kind, 'customApi');
  assert.equal(B.classifyConstituent([{ token: 't', planned: bound }], { ...patch, body: JSON.stringify({ isfunction: false }) }), null, 'a PATCH to another value');
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
