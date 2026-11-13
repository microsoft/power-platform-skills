'use strict';
// The closed, flat create units of the default configuration path (lib/configuration-create-plan.js): the single-row bodies
// at stable ids, held to the bundled SDK's own payloads for the same declaration; the public projections a receipt keeps and
// a read proves; the classification of a planned operation; the baseline of an existing root; and the check of a stored unit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const A = require('../lib/configuration-artifacts.js');
const B = require('../lib/configuration-create-bindings.js');
const P = require('../lib/configuration-create-plan.js');

const SOL = 'ContosoSol';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
// Private inputs: each distinct, so a leak of any one is found by a plain substring search.
const VALUE = 'private-value-7f3a';
const CONNECTION = 'private-connection-9c1e';
const DEFAULT = 'private-default-41b2';
const SCHEMA = '{"private-schema":"5d0e"}';
const CUSTOM_CONNECTOR = '11111111-1111-4111-8111-111111111111';
const spec = (over = {}) => ({
  minimumPluginVersion: '2.21.0', solution: { uniqueName: SOL, publisherPrefix: 'contoso' },
  environmentVariables: [
    { schemaName: 'contoso_V', type: 'string', defaultValue: DEFAULT },
    { schemaName: 'contoso_J', type: 'json', valueSchema: SCHEMA, name: 'J', description: 'D', isRequired: true },
    { schemaName: 'contoso_S', type: 'secret' },
    { schemaName: 'contoso_D', type: 'dataSource', connectorId: SP, parameterKey: 'dataset', parentSchemaName: 'contoso_V' },
    { schemaName: 'contoso_N', type: 'number', name: null, description: null, defaultValue: null },
  ],
  connectionReferences: [
    { logicalName: 'contoso_c1', connectorId: SP },
    { logicalName: 'contoso_c2', connectorId: SP, name: 'C2', description: 'd', customConnectorId: CUSTOM_CONNECTOR },
  ],
  customApis: [
    { uniqueName: 'contoso_Calc', isFunction: true, requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'B', type: 'entityReference', entityLogicalName: 'Contact', isOptional: true, name: null, displayName: 'Bee' }], responseProperties: [{ uniqueName: 'R', type: 'string', description: 'Res' }] },
    { uniqueName: 'contoso_Act', name: 'Act', displayName: null, description: 'desc', binding: 'entity', boundEntityLogicalName: 'Account', isPrivate: true, allowedProcessingSteps: 'syncAndAsync', enabledForWorkflow: true, executePrivilegeName: 'prvRead' },
  ],
  duplicateDetectionRules: [
    { key: 'email', name: 'Same email', entity: 'Contact', conditions: [{ key: 'e', column: 'EmailAddress1', match: 'exact' }, { key: 'f', column: 'lastname', match: 'firstCharacters', characters: 3, ignoreBlankValues: true, matchingColumn: 'lastname' }] },
    { key: 'x', name: 'Unpub', entity: 'contact', matchingEntity: 'contact', description: 'dd', caseSensitive: true, excludeInactiveRecords: true, status: 'unpublished', conditions: [{ key: 'z', column: 'lastname', match: 'lastCharacters', characters: 2 }] },
  ],
  ...over,
});
const deploy = ({ value = VALUE, connection = CONNECTION } = {}) => ({ EnvironmentVariables: [{ SchemaName: 'contoso_V', Value: value }], ConnectionReferences: [{ LogicalName: 'contoso_c2', ConnectionId: connection }] });
const ROOTS = [
  ['environmentVariable', 'contoso_V'], ['environmentVariable', 'contoso_J'], ['environmentVariable', 'contoso_S'], ['environmentVariable', 'contoso_D'], ['environmentVariable', 'contoso_N'],
  ['connectionReference', 'contoso_c1'], ['connectionReference', 'contoso_c2'],
  ['customApi', 'contoso_Calc'], ['customApi', 'contoso_Act'],
  ['duplicateRule', 'email'], ['duplicateRule', 'x'],
];
const TYPES = { connectionreference: 10132, customapi: 10133, duplicaterule: 4414, customapirequestparameter: 10134, customapiresponseproperty: 10135, duplicaterulecondition: 4416 };

function compile(kind, key, { s = spec(), dep = deploy(), ...over } = {}) {
  return P.compileConfigurationCreateUnit(s, { kind, key, bindings: A.readDeploymentBindings(dep, s), solution: SOL, ...over });
}
const requestsOf = (c) => c.unit.rows.filter((r) => r.role === 'create').map((r) => P.compiledRowRequest(c.handle, r.id));

function orgOf() {
  return createConfigOrg({ tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }, { logicalName: 'account', attributes: ['name'] }], solution: { uniqueName: SOL, version: '1.0.0.0', prefix: 'contoso' } });
}
async function sdkOf(org, sent) {
  const gate = { screen(req) { if (req.method !== 'GET') sent.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: req.body }); return null; } };
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request: org.request, sleep: async () => {}, sendOnce: configurationSendOnce, workflowEffectGate: gate });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('cfg-plan-sdk-')), instanceUrl: org.origin, httpClient, solutionUniqueName: SOL });
  await sdk.initWorkspace();
  return sdk;
}
// One compiled row straight to the fake org, with the exact bytes the writer would send.
async function send(org, req) {
  const res = await org.request({ url: `${org.origin}/api/data/v9.2${req.path}`, method: req.method, headers: { 'content-type': 'application/json' }, body: req.body });
  assert.ok(res.statusCode < 300, `${req.path}: ${res.statusCode} ${res.body}`);
}
const hasSolutionHeader = (headers) => Object.keys(headers || {}).some((h) => h.toLowerCase() === 'mscrm.solutionuniquename');

// The SDK's deep inserts, each split into the single rows it creates: a nested child becomes its own row with the bind to
// its root the flat body carries instead. A request URL is e.g.
//   https://<org>/api/data/v9.0/customapis?$select=customapiid&$expand=CustomAPIRequestParameters(...)
//   https://<org>/api/data/v9.0/duplicaterules(<id>)/Microsoft.Dynamics.CRM.PublishDuplicateRule
const NAVS = {
  CustomAPIRequestParameters: { set: 'customapirequestparameters', bind: 'CustomAPIId', parentSet: 'customapis' },
  CustomAPIResponseProperties: { set: 'customapiresponseproperties', bind: 'CustomAPIId', parentSet: 'customapis' },
  DuplicateRule_DuplicateRuleConditions: { set: 'duplicateruleconditions', bind: 'regardingobjectid', parentSet: 'duplicaterules' },
};
function flatten(sent, origin) {
  const rows = [];
  const publications = [];
  for (const req of sent) {
    const rel = req.url.replace(origin, '').replace(/^\/api\/data\/v9\.\d\//, '/');
    const header = hasSolutionHeader(req.headers);
    if (/\/Microsoft\.Dynamics\.CRM\.PublishDuplicateRule$/.test(rel)) { publications.push({ method: req.method, path: rel, body: req.body, solutionHeader: header }); continue; }
    const set = rel.slice(1).split('?')[0];
    const body = JSON.parse(req.body);
    const pkCol = Object.values(B.KINDS).find((k) => k.set === set).pk;
    const children = [];
    for (const [nav, n] of Object.entries(NAVS)) {
      if (!Object.prototype.hasOwnProperty.call(body, nav)) continue;
      for (const child of body[nav]) children.push({ set: n.set, solutionHeader: header, body: { ...child, [`${n.bind}@odata.bind`]: `/${n.parentSet}(${body[pkCol]})` } });
      delete body[nav];
    }
    rows.push({ set, solutionHeader: header, body }, ...children);
  }
  return { rows, publications };
}
const idOfBody = (set, body) => body[Object.values(B.KINDS).find((k) => k.set === set).pk];
const byId = (rows) => new Map(rows.map((r) => [idOfBody(r.set, r.body), r]));

test('compile: every new root is flat single-row POSTs at the protected plan\'s own ids; only the value row and the publication carry no solution header', () => {
  const s = spec();
  for (const [kind, key] of ROOTS) {
    const c = compile(kind, key, { s });
    assert.equal(c.ok, true, `${kind} ${key}: ${c.reason}`);
    const protectedPlan = B.planOf(s, { kind, key, bindings: A.readDeploymentBindings(deploy(), s), solution: SOL, componentTypes: TYPES });
    assert.deepEqual(c.unit.rows.map((r) => r.id).sort(), protectedPlan.plan.rows.map((r) => r.id).sort(), `${kind} ${key}: one id scheme`);
    const rootRow = c.unit.rows.find((r) => r.parentId === null);
    assert.equal(rootRow.id, c.unit.root.id);
    for (const req of requestsOf(c)) {
      const k = P.CONFIGURATION_CREATE_KIND_TABLE[req.kind];
      const body = JSON.parse(req.body);
      assert.equal(req.method, 'POST');
      assert.equal(req.path, `/${B.KINDS[k.bindingKind].set}`);
      assert.equal(body[k.idColumn], req.id, 'the id is supplied');
      assert.equal(req.solutionHeader, req.kind !== 'env-value', `${req.kind} header`);
      for (const value of Object.values(body)) assert.ok(!Array.isArray(value) && (value === null || typeof value !== 'object'), `${req.kind}: flat`);
      const binds = Object.keys(body).filter((f) => f.endsWith('@odata.bind'));
      if (req.parentId === null) {
        assert.deepEqual(binds.filter((f) => !/^(ParentDefinitionId|CustomConnectorId)@/.test(f)), [], 'a root binds no parent');
      } else {
        assert.deepEqual(binds, [`${k.parentBind.key}@odata.bind`]);
        assert.equal(body[binds[0]], `/${k.parentBind.set}(${req.parentId})`);
      }
      assert.ok(Object.isFrozen(req));
    }
  }
  assert.deepEqual(P.compiledPublicationRequest(compile('duplicateRule', 'email').handle), {
    method: 'POST', path: `/duplicaterules(${compile('duplicateRule', 'email').unit.root.id})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, body: '{}', solutionHeader: false,
  });
  assert.equal(compile('duplicateRule', 'email').unit.publicationRequired, true);
  assert.equal(P.compiledPublicationRequest(compile('duplicateRule', 'x').handle), null, 'an unpublished rule is not published');
  assert.equal(compile('duplicateRule', 'x').unit.publicationRequired, false);
  assert.equal(P.compiledPublicationRequest(compile('customApi', 'contoso_Calc').handle), null);
});

test('compile: the exact single-row bodies, defaults included', () => {
  const ev = compile('environmentVariable', 'contoso_V');
  const [def, value] = requestsOf(ev);
  assert.deepEqual(JSON.parse(def.body), { environmentvariabledefinitionid: def.id, schemaname: 'contoso_V', type: 100000000, displayname: 'contoso_V', isrequired: false, defaultvalue: DEFAULT });
  assert.deepEqual(JSON.parse(value.body), { environmentvariablevalueid: value.id, value: VALUE, 'EnvironmentVariableDefinitionId@odata.bind': `/environmentvariabledefinitions(${def.id})` });
  const ds = requestsOf(compile('environmentVariable', 'contoso_D'));
  assert.equal(ds.length, 1, 'a variable without a deployed value creates no value row');
  assert.equal(JSON.parse(ds[0].body)['ParentDefinitionId@odata.bind'], `/environmentvariabledefinitions(${def.id})`, 'a data source binds its declared parent');
  assert.equal(compile('environmentVariable', 'contoso_D').unit.rows[0].public.parentDefinitionId, def.id);
  const [cr] = requestsOf(compile('connectionReference', 'contoso_c2'));
  assert.deepEqual(JSON.parse(cr.body), {
    connectionreferenceid: cr.id, connectionreferencelogicalname: 'contoso_c2', connectorid: SP, connectionreferencedisplayname: 'C2', description: 'd',
    connectionid: CONNECTION, 'CustomConnectorId@odata.bind': `/connectors(${CUSTOM_CONNECTOR})`,
  });
  const rule = requestsOf(compile('duplicateRule', 'email'));
  assert.deepEqual(JSON.parse(rule[2].body), {
    duplicateruleconditionid: rule[2].id, baseattributename: 'lastname', matchingattributename: 'lastname', operatorcode: 1, operatorparam: 3, ignoreblankvalues: true,
    'regardingobjectid@odata.bind': `/duplicaterules(${rule[0].id})`,
  });
  // A Custom API root always carries a description (the platform refuses a root without one): undeclared, it is the
  // display name, itself the unique name.
  const [api] = requestsOf(compile('customApi', 'contoso_Calc'));
  assert.equal(JSON.parse(api.body).description, 'contoso_Calc');
  assert.equal(JSON.parse(requestsOf(compile('customApi', 'contoso_Act'))[0].body).description, 'desc');
});

test('compile: every body is the bundled SDK\'s own payload for the same declaration, with only the nesting split, and every row reads back as its public projection', async () => {
  const s = spec();
  const bindings = A.readDeploymentBindings(deploy(), s);
  for (const [kind, key] of ROOTS) {
    const c = compile(kind, key, { s });
    // OLD: the artifact the default path handed the SDK (configuration-artifacts.js buildArtifact) at the same ids, pushed
    // through the real SDK bundle as one deep insert, every mutation captured at the gate.
    const ids = P.deriveConfigurationCreateIds(s, { kind, key, bindings, solution: SOL });
    const artifact = A.buildArtifact({ kind, key: ids.key, detail: { entry: A.configurationIntentOf(s, kind, key) } }, ids.id, { ...ids.childIds }, { bindings }, ids.parentDefinitionId);
    const oldOrg = orgOf();
    const sent = [];
    const sdk = await sdkOf(oldOrg, sent);
    await sdk.createArtifact(kind, artifact);
    await sdk.pushArtifact(kind, ids.id);
    const old = flatten(sent, oldOrg.origin);
    const now = requestsOf(c).map((r) => ({ set: r.path.slice(1), solutionHeader: r.solutionHeader, body: JSON.parse(r.body) }));
    assert.deepEqual(byId(now), byId(old.rows), `${kind} ${key}: the same rows, sets, headers and bodies`);
    const publication = P.compiledPublicationRequest(c.handle);
    assert.deepEqual(publication ? [{ ...publication }] : [], old.publications, `${kind} ${key}: the same publication`);
    // Each row the SDK made reads back (the default reader) as exactly the public projection of the flat body.
    for (const row of c.unit.rows) {
      const k = P.CONFIGURATION_CREATE_KIND_TABLE[row.kind];
      const read = await B.readDefaultConfigurationRow(sdk.dataverse, k.bindingKind, row.id);
      assert.equal(read.state, 'present', `${row.kind} ${row.key}`);
      const observed = P.publicProjectionFromObserved(row.kind, read);
      assert.deepEqual(observed.public, row.public, `${kind} ${key} ${row.key}: observed = posted`);
      assert.deepEqual(P.publicProjectionFromPost(c.handle, row.id), { ok: true, public: row.public });
    }
    // NEW: the flat bodies sent one by one to an empty org build the same graph, whose baseline is the unit's public rows.
    const newOrg = orgOf();
    for (const req of requestsOf(c)) await send(newOrg, req);
    const reader = await sdkOf(newOrg, []);
    const baseline = await P.captureConfigurationBaseline(reader.dataverse, { kind, rootId: c.unit.root.id });
    assert.equal(baseline.ok, true, `${kind} ${key}: ${baseline.reason}`);
    assert.deepEqual(baseline.root.public, c.unit.rows[0].public);
    assert.deepEqual(
      baseline.children.map((ch) => [ch.kind, ch.id, ch.public]).sort(),
      c.unit.rows.slice(1).map((r) => [r.kind, r.id, r.public]).sort(),
      `${kind} ${key}: the flat graph reads back whole`,
    );
    if (kind === 'duplicateRule') assert.equal(baseline.root.ruleState, 'unpublished', 'a rule\'s content is created unpublished; publication is its own request');
  }
});

test('ids are the stable create identity: the same in another process, independent of private inputs, the existing row\'s when one exists', () => {
  const s = spec();
  const mine = ROOTS.map(([kind, key]) => P.deriveConfigurationCreateIds(s, { kind, key, bindings: A.readDeploymentBindings(deploy(), s), solution: SOL }));
  const lib = path.join(__dirname, '..', 'lib');
  const script = [
    `const A = require(${JSON.stringify(path.join(lib, 'configuration-artifacts.js'))});`,
    `const P = require(${JSON.stringify(path.join(lib, 'configuration-create-plan.js'))});`,
    'const [s, dep, roots, sol] = JSON.parse(process.argv[1]);',
    'process.stdout.write(JSON.stringify(roots.map(([kind, key]) => P.deriveConfigurationCreateIds(s, { kind, key, bindings: A.readDeploymentBindings(dep, s), solution: sol }))));',
  ].join('\n');
  const other = JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify([s, deploy({ value: 'another', connection: 'another' }), ROOTS, SOL])], { encoding: 'utf8' }));
  assert.deepEqual(other, mine);
  const existing = '22222222-2222-4222-8222-222222222222';
  const bound = P.deriveConfigurationCreateIds(s, { kind: 'customApi', key: 'contoso_Calc', solution: SOL, rootId: existing.toUpperCase() });
  assert.equal(bound.id, existing);
  assert.notDeepEqual(bound.childIds, mine[7].childIds, 'children derive under the existing root');
  assert.deepEqual(Object.keys(bound.childIds).sort(), ['request:a', 'request:b', 'response:r']);
  assert.notEqual(P.deriveConfigurationCreateIds(s, { kind: 'customApi', key: 'contoso_Calc', solution: 'Other' }).id, mine[7].id, 'the solution scopes the identity');
});

test('the unit holds no private value, and a private-only change leaves both public hashes and every id unchanged', () => {
  const a = ROOTS.map(([kind, key]) => compile(kind, key));
  const changedSpec = spec();
  changedSpec.environmentVariables[0].defaultValue = 'other-default';
  changedSpec.environmentVariables[1].valueSchema = '{"other":1}';
  const b = ROOTS.map(([kind, key]) => compile(kind, key, { s: changedSpec, dep: deploy({ value: 'other-value', connection: 'other-connection' }) }));
  const text = JSON.stringify(a.map((c) => c.unit));
  for (const secret of [VALUE, CONNECTION, DEFAULT, SCHEMA, 'private-schema']) assert.ok(!text.includes(secret), `${secret} is not in the unit`);
  const sent = a.flatMap((c) => requestsOf(c).map((r) => r.body)).join('\n');
  for (const secret of [VALUE, CONNECTION, DEFAULT]) assert.ok(sent.includes(secret), `${secret} is sent`);
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(b[i].unit.publicIntentSha256, a[i].unit.publicIntentSha256, ROOTS[i].join(' '));
    assert.equal(b[i].unit.publicPlanSha256, a[i].unit.publicPlanSha256, ROOTS[i].join(' '));
    assert.deepEqual(b[i].unit.rows.map((r) => r.id), a[i].unit.rows.map((r) => r.id));
  }
  assert.notEqual(requestsOf(b[0])[0].body, requestsOf(a[0])[0].body, 'the private change is in what is sent');
  assert.deepEqual(a[0].unit.rows.map((r) => r.privateFields), [['defaultValue', 'valueSchema', 'secretReference'], ['value', 'secretReference']], 'the classification names fields, never values');
  // A public change moves both hashes.
  const relabelled = spec();
  relabelled.environmentVariables[0].description = 'new';
  const c = compile('environmentVariable', 'contoso_V', { s: relabelled });
  assert.notEqual(c.unit.publicIntentSha256, a[0].unit.publicIntentSha256);
  assert.notEqual(c.unit.publicPlanSha256, a[0].unit.publicPlanSha256);
});

test('the public hashes ignore row and key order and the dispatch state; the intent hash ignores where the unit lands', () => {
  const c = compile('customApi', 'contoso_Calc');
  const shuffled = JSON.parse(JSON.stringify(c.unit));
  shuffled.rows.reverse();
  shuffled.rows = shuffled.rows.map((r) => Object.fromEntries(Object.entries({ ...r, dispatch: 'sealed', public: Object.fromEntries(Object.entries(r.public).reverse()) }).reverse()));
  assert.equal(P.publicIntentSha256(shuffled), c.unit.publicIntentSha256);
  assert.equal(P.publicPlanSha256(shuffled), c.unit.publicPlanSha256);
  const moved = JSON.parse(JSON.stringify(c.unit));
  const other = '33333333-3333-4333-8333-333333333333';
  for (const r of moved.rows) {
    if (r.parentId) { r.parentId = other; r.public.parentId = other; } else r.id = other;
  }
  moved.root.id = other;
  assert.equal(P.publicIntentSha256(moved), c.unit.publicIntentSha256, 'the same rows under another root id are the same intent');
  assert.notEqual(P.publicPlanSha256(moved), c.unit.publicPlanSha256, 'but another plan');
  assert.notEqual(P.publicIntentSha256({ ...c.unit, publicationRequired: true }), c.unit.publicIntentSha256);
});

test('compile: a declaration the closed rows cannot represent is refused before anything is sent', () => {
  const s = spec();
  s.environmentVariables[0].type = 'mystery';
  s.duplicateDetectionRules[0].conditions[0].match = 'soundsLike';
  assert.deepEqual([compile('environmentVariable', 'contoso_V', { s }).code, compile('duplicateRule', 'email', { s }).code], [P.CODES.shapeRefused, P.CODES.shapeRefused]);
  assert.equal(compile('customApi', 'contoso_Nope').code, P.CODES.shapeRefused, 'an undeclared root');
  // A field the artifact gains (a newer declaration field) is not dropped silently.
  const original = A.buildArtifact;
  try {
    A.buildArtifact = (...args) => ({ ...original(...args), hint: 'h' });
    const refused = compile('environmentVariable', 'contoso_N');
    assert.equal(refused.code, P.CODES.shapeRefused);
    assert.match(refused.reason, /environmentVariable\.hint/);
    A.buildArtifact = (...args) => { const a = original(...args); a.conditions[0].weight = 1; return a; };
    assert.equal(compile('duplicateRule', 'email').code, P.CODES.shapeRefused);
  } finally {
    A.buildArtifact = original;
  }
  // The platform refuses a Custom API root without a description (a child may omit one): a root that would go without
  // one is refused before anything is sent, never POSTed.
  const pin = B.pinApiLabels;
  try {
    B.pinApiLabels = (artifact, ...rest) => { pin(artifact, ...rest); artifact.description = null; };
    const refused = compile('customApi', 'contoso_Calc');
    assert.equal(refused.code, P.CODES.shapeRefused);
    assert.match(refused.reason, /description/);
  } finally {
    B.pinApiLabels = pin;
  }
});

test('a compiled unit is frozen and its bodies are fixed: changing the spec or the bindings afterwards changes nothing that is sent', () => {
  const s = spec();
  const bindings = A.readDeploymentBindings(deploy(), s);
  const c = P.compileConfigurationCreateUnit(s, { kind: 'environmentVariable', key: 'contoso_V', bindings, solution: SOL });
  const before = requestsOf(c).map((r) => r.body);
  s.environmentVariables[0].defaultValue = 'changed';
  bindings.environmentVariables.clear();
  assert.deepEqual(requestsOf(c).map((r) => r.body), before);
  assert.ok(Object.isFrozen(c.unit) && Object.isFrozen(c.unit.rows[0].public) && Object.isFrozen(c.handle));
  assert.equal(P.compiledUnitOf(c.handle), c.unit);
  assert.throws(() => P.compiledRowRequest({}, 'value'), /not a compiled configuration create unit/);
  assert.throws(() => P.compiledRowRequest(c.handle, 'nope'), /creates no row nope/);
  assert.throws(() => P.compiledPublicationRequest(Object.freeze(Object.create(null))), /not a compiled/);
});

// A rule's key and a condition's key are authored separately and may be equal; a row is addressed by its id.
test('a rule and its condition may share a key: each row is still addressed and sent as itself, new rule or addition', async () => {
  const own = { key: 'email', column: 'emailaddress1', match: 'exact' };
  const s = ruleSpec([own]);
  assert.deepEqual(A.validateConfiguration(s).errors, []);
  const c = compile('duplicateRule', 'email', { s });
  assert.equal(c.ok, true, c.reason);
  const [rule, condition] = [c.unit.rows.find((r) => r.kind === 'duplicate-rule'), c.unit.rows.find((r) => r.kind === 'rule-condition')];
  assert.deepEqual([rule.key, condition.key], ['email', 'email']);
  const ruleReq = P.compiledRowRequest(c.handle, rule.id);
  assert.deepEqual([ruleReq.kind, ruleReq.id, ruleReq.path], ['duplicate-rule', rule.id, '/duplicaterules']);
  assert.equal(JSON.parse(ruleReq.body).duplicateruleid, rule.id);
  const condReq = P.compiledRowRequest(c.handle, condition.id);
  assert.deepEqual([condReq.kind, condReq.id, condReq.path], ['rule-condition', condition.id, '/duplicateruleconditions']);
  assert.equal(JSON.parse(condReq.body)['regardingobjectid@odata.bind'], `/duplicaterules(${rule.id})`);
  assert.deepEqual(P.publicProjectionFromPost(c.handle, rule.id), { ok: true, public: rule.public });
  assert.deepEqual(P.publicProjectionFromPost(c.handle, condition.id.toUpperCase()), { ok: true, public: condition.public }, 'an id in any case');
  assert.deepEqual(P.validateRecordedCreateUnit(JSON.parse(JSON.stringify(c.unit)), { current: c.unit }), { ok: true, samePlan: true });
  // The same under a rule that already exists: the new condition shares the preserved rule's key.
  const org = orgOf();
  const first = compile('duplicateRule', 'email', { s: ruleSpec([{ key: 'e', column: 'emailaddress1', match: 'exact' }]) });
  for (const req of requestsOf(first)) await send(org, req);
  const baseline = await P.captureConfigurationBaseline((await sdkOf(org, [])).dataverse, { kind: 'duplicateRule', rootId: first.unit.root.id });
  assert.equal(baseline.ok, true, baseline.reason);
  const added = compile('duplicateRule', 'email', { s: ruleSpec([{ key: 'e', column: 'emailaddress1', match: 'exact' }, { key: 'email', column: 'lastname', match: 'exact' }]), baseline, additions: ['email'] });
  assert.equal(added.ok, true, added.reason);
  const newRow = added.unit.rows.find((r) => r.role === 'create');
  assert.deepEqual([newRow.kind, newRow.key, added.unit.root.key], ['rule-condition', 'email', 'email']);
  const req = P.compiledRowRequest(added.handle, newRow.id);
  assert.deepEqual([req.kind, req.path, JSON.parse(req.body).baseattributename], ['rule-condition', '/duplicateruleconditions', 'lastname']);
  assert.throws(() => P.compiledRowRequest(added.handle, first.unit.root.id), /creates no row/, 'a preserved rule is never sent');
  assert.deepEqual(requestsOf(added).map((r) => r.id), [newRow.id]);
  assert.deepEqual(P.validateRecordedCreateUnit(JSON.parse(JSON.stringify(added.unit)), { current: added.unit }), { ok: true, samePlan: true });
});

// ---------------------------------------------------------------------------------------------
// Classification, over the planner's own operations

const GUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function stubSdk(remotes, get = {}) {
  const byIdMap = new Map(Object.values(remotes).map((r) => [r.id, r]));
  return {
    async findArtifact(kind, identity) {
      const r = remotes[`${kind}:${(identity.uniqueName || identity.name).toLowerCase()}`];
      return r ? r.id : null;
    },
    async fetchArtifact(kind, id) {
      const r = byIdMap.get(id);
      if (!r) throw Object.assign(new Error('gone'), { code: 'ARTIFACT_NOT_FOUND' });
      return structuredClone(r);
    },
    dataverse: {
      async get(p) {
        const hit = Object.entries(get).find(([prefix]) => p.startsWith(prefix));
        if (!hit) throw Object.assign(new Error('unexpected read'), { code: 'CONNECTION_ERROR', statusCode: 500 });
        return { body: hit[1] };
      },
    },
  };
}
const apiRemote = (extra = {}) => ({
  id: GUID(1), uniqueName: 'contoso_Calc', name: 'contoso_Calc', displayName: 'contoso_Calc', description: 'contoso_Calc',
  binding: 'global', boundEntityLogicalName: null, isFunction: false, allowedProcessingSteps: 'none', enabledForWorkflow: false,
  isPrivate: false, executePrivilegeName: null, pluginTypeId: null,
  requestParameters: [{ id: GUID(2), uniqueName: 'A', name: 'contoso_Calc.A', displayName: 'A', description: 'A', type: 'integer', isOptional: false, entityLogicalName: null }],
  responseProperties: [],
  ...extra,
});
const evRemote = (extra = {}) => ({
  id: GUID(3), schemaName: 'contoso_S', type: 'string', name: 'contoso_S', description: null, defaultValue: null, isRequired: false,
  valueSchema: null, connectorId: null, parameterKey: null, parentId: null, currentValue: null, ...extra,
});
const ruleRemote = (extra = {}) => ({
  id: GUID(4), name: 'Same email', description: null, entityLogicalName: 'contact', matchingEntityLogicalName: 'contact', caseSensitive: false,
  excludeInactiveRecords: false, status: 'unpublished', conditions: [{ id: GUID(5), column: 'emailaddress1', matchingColumn: 'emailaddress1', match: 'exact', characters: null, ignoreBlankValues: false }],
  ...extra,
});
const RULE_READS = { "/EntityDefinitions(LogicalName='contact')": { IsDuplicateDetectionEnabled: { Value: true } }, '/duplicaterules?$select=duplicateruleid&$filter=': { value: [{ duplicateruleid: GUID(4) }] } };
const base = (extra) => ({ minimumPluginVersion: '2.21.0', solution: { uniqueName: SOL, publisherPrefix: 'contoso' }, ...extra });
const apiSpec = (requestParameters, extra = {}) => base({ customApis: [{ uniqueName: 'contoso_Calc', requestParameters, ...extra }] });
const ruleSpec = (conditions, extra = {}) => base({ duplicateDetectionRules: [{ key: 'email', name: 'Same email', entity: 'contact', status: 'unpublished', conditions, ...extra }] });
const evSpec = (extra = {}) => base({ environmentVariables: [{ schemaName: 'contoso_S', type: 'string', ...extra }] });
async function opOf(s, remotes, { dep, get } = {}) {
  const plan = await A.planConfiguration(s, { fence: null, sdk: stubSdk(remotes, get), bindings: dep ? A.readDeploymentBindings(dep, s) : undefined });
  assert.equal(plan.operations.length, 1, JSON.stringify(plan));
  return plan.operations[0];
}

test('classify: a new root is one create unit; an existing root that only gains children takes the additions route', async () => {
  assert.deepEqual(P.classifyConfigurationMutation(await opOf(apiSpec([{ uniqueName: 'A', type: 'integer' }]), {})), { route: 'create-unit', kind: 'custom-api', key: 'contoso_Calc' });
  const A_ = { uniqueName: 'A', type: 'integer' };
  const api = await opOf(apiSpec([A_, { uniqueName: 'C', type: 'string' }]), { 'customApi:contoso_calc': apiRemote() });
  assert.deepEqual(P.classifyConfigurationMutation(api), { route: 'additions', kind: 'custom-api', key: 'contoso_Calc', rootId: GUID(1), additions: ['request:c'] });
  const value = await opOf(evSpec(), { 'environmentVariable:contoso_s': evRemote() }, { dep: { EnvironmentVariables: [{ SchemaName: 'contoso_S', Value: VALUE }] } });
  assert.deepEqual(P.classifyConfigurationMutation(value), { route: 'additions', kind: 'env-definition', key: 'contoso_S', rootId: GUID(3), additions: ['value'] });
  assert.ok(!JSON.stringify(P.classifyConfigurationMutation(value)).includes(VALUE));
  const exact = { key: 'e', column: 'emailaddress1', match: 'exact' };
  const rule = await opOf(ruleSpec([exact, { key: 'l', column: 'lastname', match: 'exact' }]), { 'duplicateRule:same email': ruleRemote() }, { get: RULE_READS });
  assert.deepEqual(P.classifyConfigurationMutation(rule), { route: 'additions', kind: 'duplicate-rule', key: 'email', rootId: GUID(4), additions: ['l'] });
  assert.deepEqual(P.classifyConfigurationMutation(rule, { ruleState: 'published' }).code, P.CODES.mixedEdit, 'a fresh observation decides over the planner\'s read');
  assert.deepEqual(P.classifyConfigurationMutation(rule, { ruleState: null }).code, P.CODES.mixedEdit, 'a rule in flight is not unpublished');
});

test('classify: additions with any edit, removal or status change of existing rows are refused; edits alone stay on the existing route', async () => {
  const C_ = { uniqueName: 'C', type: 'string' };
  const relabel = await opOf(apiSpec([{ uniqueName: 'A', type: 'integer', displayName: 'Changed' }, C_]), { 'customApi:contoso_calc': apiRemote() });
  assert.equal(P.classifyConfigurationMutation(relabel).code, P.CODES.mixedEdit, 'a label edit of an existing child');
  const removal = await opOf(apiSpec([C_]), { 'customApi:contoso_calc': apiRemote() });
  assert.equal(P.classifyConfigurationMutation(removal).code, P.CODES.mixedEdit, 'a removed child');
  const rootEdit = await opOf(apiSpec([{ uniqueName: 'A', type: 'integer' }, C_], { isPrivate: true }), { 'customApi:contoso_calc': apiRemote() });
  assert.equal(P.classifyConfigurationMutation(rootEdit).code, P.CODES.mixedEdit, 'a root column edit');
  const onlyEdit = await opOf(apiSpec([{ uniqueName: 'A', type: 'integer' }], { isPrivate: true }), { 'customApi:contoso_calc': apiRemote() });
  assert.deepEqual(P.classifyConfigurationMutation(onlyEdit), { route: 'existing' });
  const valueAndEdit = await opOf(evSpec({ description: 'new' }), { 'environmentVariable:contoso_s': evRemote() }, { dep: { EnvironmentVariables: [{ SchemaName: 'contoso_S', Value: VALUE }] } });
  assert.equal(P.classifyConfigurationMutation(valueAndEdit).code, P.CODES.mixedEdit);
  const valueChange = await opOf(evSpec(), { 'environmentVariable:contoso_s': evRemote({ currentValue: { id: GUID(9), value: 'old' } }) }, { dep: { EnvironmentVariables: [{ SchemaName: 'contoso_S', Value: VALUE }] } });
  assert.deepEqual(P.classifyConfigurationMutation(valueChange), { route: 'existing' }, 'a changed value is an edit of the existing value row');
  const exact = { key: 'e', column: 'emailaddress1', match: 'exact' };
  const lastname = { key: 'l', column: 'lastname', match: 'exact' };
  const status = await opOf(ruleSpec([exact, lastname], { status: 'published' }), { 'duplicateRule:same email': ruleRemote() }, { get: RULE_READS });
  assert.equal(P.classifyConfigurationMutation(status).code, P.CODES.mixedEdit, 'a status change');
  const published = await opOf(ruleSpec([exact, lastname], { status: 'published' }), { 'duplicateRule:same email': ruleRemote({ status: 'published' }) }, { get: RULE_READS });
  assert.equal(P.classifyConfigurationMutation(published).code, P.CODES.mixedEdit, 'a condition appended to a published rule');
  const changedCondition = await opOf(ruleSpec([{ ...exact, ignoreBlankValues: true }, lastname]), { 'duplicateRule:same email': ruleRemote() }, { get: RULE_READS });
  assert.equal(P.classifyConfigurationMutation(changedCondition).code, P.CODES.mixedEdit, 'an existing condition replaced');
  // A request parameter's isOptional is create-only (a PATCH of it is a silent no-op on the platform). The planner refuses
  // the change itself; an operation that still carried one beside a new child is an edit, never a plain addition.
  const optional = await opOf(apiSpec([{ uniqueName: 'A', type: 'integer', isOptional: true }, C_]), { 'customApi:contoso_calc': apiRemote() });
  assert.deepEqual(P.classifyConfigurationMutation(optional), { route: 'existing' }, 'the planner refuses it: no create unit');
  // `detail` is a non-enumerable property of a planned operation, so it is copied on its own.
  const carried = await opOf(apiSpec([{ uniqueName: 'A', type: 'integer' }, C_]), { 'customApi:contoso_calc': apiRemote() });
  const existing = carried.detail.changes.find((c) => c.pointer === '/requestParameters').value.find((c) => c.uniqueName === 'A');
  for (const [field, v] of [['isOptional', true], ['type', 'string'], ['entityLogicalName', 'contact']]) {
    const op = { ...carried, detail: structuredClone(carried.detail) };
    Object.assign(op.detail.changes.find((c) => c.pointer === '/requestParameters').value.find((c) => c.uniqueName === 'A'), { [field]: v });
    assert.equal(P.classifyConfigurationMutation(op).code, P.CODES.mixedEdit, `an existing child's ${field} carried beside an addition`);
  }
  assert.equal(existing.isOptional, false);
  assert.equal(P.classifyConfigurationMutation(carried).route, 'additions', 'the unchanged contract stays an addition');
  const unchanged = await opOf(apiSpec([{ uniqueName: 'A', type: 'integer' }]), { 'customApi:contoso_calc': apiRemote() });
  assert.deepEqual(P.classifyConfigurationMutation(unchanged), { route: 'existing' });
  assert.deepEqual(P.classifyConfigurationMutation({ kind: 'table', key: 'x', action: 'create' }), { route: 'existing' }, 'a kind this module does not create');
  assert.deepEqual(P.classifyConfigurationMutation({ kind: 'customApi', key: 'x', action: 'refuse', code: 'X' }), { route: 'existing' });
  assert.equal(P.classifyConfigurationMutation({ kind: 'customApi', key: 'x', action: 'update', id: GUID(1), detail: {} }).code, P.CODES.shapeRefused);
});

// ---------------------------------------------------------------------------------------------
// Additions under an existing root

test('additions: only the new children are created, under the existing root\'s id; the root and every child it holds are preserved', async () => {
  const org = orgOf();
  const first = compile('customApi', 'contoso_Calc', { s: apiSpec([{ uniqueName: 'A', type: 'integer' }]) });
  // The existing API carries another case in its unique name: a new child's default name follows the row, as the SDK's
  // update of that row would have named it.
  for (const req of requestsOf(first)) {
    await send(org, req.kind === 'custom-api' ? { ...req, body: JSON.stringify({ ...JSON.parse(req.body), uniquename: 'contoso_calc' }) } : req);
  }
  await send(org, { method: 'POST', path: '/customapiresponseproperties', body: JSON.stringify({ customapiresponsepropertyid: GUID(7), uniquename: 'Extra', name: 'n', displayname: 'd', description: null, type: 10, logicalentityname: null, 'CustomAPIId@odata.bind': `/customapis(${first.unit.root.id})` }) });
  const dv = (await sdkOf(org, [])).dataverse;
  const baseline = await P.captureConfigurationBaseline(dv, { kind: 'customApi', rootId: first.unit.root.id });
  assert.equal(baseline.ok, true, baseline.reason);
  assert.deepEqual(baseline.children.map((c) => c.kind), ['api-request', 'api-response'], 'an undeclared child is kept too');
  const s = apiSpec([{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'C', type: 'string' }]);
  const c = compile('customApi', 'contoso_Calc', { s, baseline, additions: ['request:c'] });
  assert.equal(c.ok, true, c.reason);
  assert.deepEqual(c.unit.rows.map((r) => [r.kind, r.key, r.role]), [
    ['api-request', 'request:c', 'create'], ['custom-api', 'contoso_calc', 'preserved'], ['api-request', 'request:a', 'preserved'], ['api-response', 'response:extra', 'preserved'],
  ]);
  const [req] = requestsOf(c);
  const body = JSON.parse(req.body);
  assert.equal(body.name, 'contoso_calc.C');
  assert.equal(body['CustomAPIId@odata.bind'], `/customapis(${first.unit.root.id})`);
  assert.equal(c.unit.root.id, first.unit.root.id);
  assert.equal(c.unit.publicationRequired, false);
  assert.deepEqual(P.validateRecordedCreateUnit(JSON.parse(JSON.stringify(c.unit)), { current: c.unit }), { ok: true, samePlan: true });
  await send(org, req);
  const after = await P.captureConfigurationBaseline(dv, { kind: 'customApi', rootId: first.unit.root.id });
  assert.deepEqual(after.children.find((ch) => ch.id === req.id).public, c.unit.rows[0].public, 'the new row reads back as its projection');
  assert.equal(compile('customApi', 'contoso_Calc', { s, baseline, additions: ['request:nope'] }).code, P.CODES.shapeRefused);
  assert.throws(() => compile('customApi', 'contoso_Calc', { s, baseline, additions: [] }), /needs the slots/);
  assert.throws(() => compile('customApi', 'contoso_Calc', { s, baseline: { ...baseline, ok: false } }), /not a complete capture/);
});

test('additions: conditions are added only to a rule observed unpublished', async () => {
  const org = orgOf();
  const exact = { key: 'e', column: 'emailaddress1', match: 'exact' };
  const first = compile('duplicateRule', 'email', { s: ruleSpec([exact]) });
  for (const req of requestsOf(first)) await send(org, req);
  const dv = (await sdkOf(org, [])).dataverse;
  const baseline = await P.captureConfigurationBaseline(dv, { kind: 'duplicateRule', rootId: first.unit.root.id });
  assert.equal(baseline.root.ruleState, 'unpublished');
  const s = ruleSpec([exact, { key: 'l', column: 'lastname', match: 'exact' }]);
  const c = compile('duplicateRule', 'email', { s, baseline, additions: ['l'] });
  assert.equal(c.ok, true, c.reason);
  assert.deepEqual(c.unit.rows.filter((r) => r.role === 'create').map((r) => r.key), ['l']);
  assert.equal(c.unit.rows.find((r) => r.kind === 'rule-condition' && r.role === 'preserved').key, `@${first.unit.rows[1].id}`);
  assert.equal(P.compiledPublicationRequest(c.handle), null, 'an append publishes nothing');
  for (const ruleState of ['published', null]) {
    assert.equal(compile('duplicateRule', 'email', { s, baseline: { ...baseline, root: { ...baseline.root, ruleState } }, additions: ['l'] }).code, P.CODES.mixedEdit);
  }
});

// ---------------------------------------------------------------------------------------------
// Baseline and observed projections

test('captureConfigurationBaseline: an absent root, an incomplete or ambiguous child list, or an unreadable row is never an empty baseline', async () => {
  const c = compile('customApi', 'contoso_Calc');
  const org = orgOf();
  for (const req of requestsOf(c)) await send(org, req);
  const dv = (await sdkOf(org, [])).dataverse;
  const rootId = c.unit.root.id;
  const good = await P.captureConfigurationBaseline(dv, { kind: 'custom-api', rootId });
  assert.equal(good.ok, true);
  const asked = [];
  const pages = (edit) => async (d, p) => { asked.push(p); const read = await B.readAllPages(d, p); return edit(read, p); };
  await P.captureConfigurationBaseline(dv, { kind: 'customApi', rootId }, { readAllPages: pages((r) => r) });
  assert.ok(asked.every((p) => p.endsWith(`&$filter=_customapiid_value eq ${rootId}`)), 'children are listed by their parent');
  assert.ok(asked[0].startsWith('/customapirequestparameters?$select=customapirequestparameterid,uniquename,'));
  const cases = [
    ['an incomplete page', pages(() => ({ complete: false, reason: 'more records were flagged without a link to them' }))],
    ['an id listed twice', pages((r) => ({ ...r, rows: [...r.rows, ...r.rows] }))],
    ['another parent', pages((r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, _customapiid_value: GUID(8) })) }))],
    ['a missing column', pages((r) => ({ ...r, rows: r.rows.map(({ type, ...x }) => x) }))],
    ['an unknown option', pages((r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, type: 99 })) }))],
    ['a row without an id', pages((r) => ({ ...r, rows: r.rows.map(({ customapirequestparameterid, customapiresponsepropertyid, ...x }) => x) }))],
  ];
  for (const [what, readAllPages] of cases) {
    const out = await P.captureConfigurationBaseline(dv, { kind: 'customApi', rootId }, { readAllPages });
    assert.deepEqual([out.ok, out.code], [false, P.CODES.graphUnreadable], what);
  }
  assert.equal((await P.captureConfigurationBaseline(dv, { kind: 'customApi', rootId: GUID(8) })).code, P.CODES.rowMissing);
  const unknown = await P.captureConfigurationBaseline(dv, { kind: 'customApi', rootId }, { readRow: async () => ({ state: 'unknown', reason: 'the read failed (HTTP 500)' }) });
  assert.deepEqual([unknown.code, unknown.reason], [P.CODES.graphUnreadable, 'the read failed (HTTP 500)']);
});

test('publicProjectionFromObserved: the closed public fields only, a rule\'s state apart from its content', async () => {
  const org = orgOf();
  for (const [kind, key] of [['connectionReference', 'contoso_c2'], ['duplicateRule', 'email']]) for (const req of requestsOf(compile(kind, key))) await send(org, req);
  const dv = (await sdkOf(org, [])).dataverse;
  const cr = compile('connectionReference', 'contoso_c2');
  const read = await B.readDefaultConfigurationRow(dv, 'connectionReference', cr.unit.root.id);
  const observed = P.publicProjectionFromObserved('connection-reference', read);
  assert.deepEqual(observed, { ok: true, public: cr.unit.rows[0].public }, 'whether it is connected is not public');
  assert.ok(!JSON.stringify(observed).includes(CONNECTION));
  const rule = compile('duplicateRule', 'email');
  const ruleRead = await B.readDefaultConfigurationRow(dv, 'duplicateRule', rule.unit.root.id);
  assert.deepEqual(P.publicProjectionFromObserved('duplicateRule', ruleRead), { ok: true, public: rule.unit.rows[0].public, ruleState: 'unpublished' });
  const raw = (await dv.get(`/duplicateruleconditions(${rule.unit.rows[1].id})?$select=duplicateruleconditionid,${B.DEFAULT_READ_COLUMNS.duplicateRuleCondition.join(',')}`)).body;
  assert.deepEqual(P.publicProjectionFromObserved('rule-condition', raw), { ok: true, public: rule.unit.rows[1].public });
  const { operatorcode, ...missing } = raw;
  assert.equal(P.publicProjectionFromObserved('rule-condition', missing).code, P.CODES.graphUnreadable);
  assert.equal(P.publicProjectionFromObserved('rule-condition', { ...raw, _regardingobjectid_value: null }).code, P.CODES.graphUnreadable, 'a child without a parent');
  assert.throws(() => P.publicProjectionFromObserved('table', raw), /not a configuration create kind/);
});

// A faithful read of a row as this module created it: every default column, each empty column null and each defaulted one
// at its create default, e.g. for a definition
//   { "environmentvariabledefinitionid": "<id>", "schemaname": "contoso_S", ..., "hint": null, "learnmoreurl": null, ... }
function faithfulRead(c) {
  const row = c.unit.rows[0];
  const k = P.CONFIGURATION_CREATE_KIND_TABLE[row.kind];
  const body = JSON.parse(P.compiledRowRequest(c.handle, row.id).body);
  const raw = { [k.idColumn]: row.id };
  for (const col of B.DEFAULT_READ_COLUMNS[k.bindingKind]) {
    const mapped = B.KINDS[k.bindingKind].columns[col];
    raw[col] = col in body ? body[col] : Array.isArray(mapped) && mapped.length === 3 ? mapped[2] : null;
  }
  return raw;
}

test('observed public state the closed projection cannot represent is refused, never dropped; its empty or default form is not', async () => {
  const ev = compile('environmentVariable', 'contoso_S', { s: evSpec() });
  const cr = compile('connectionReference', 'contoso_c1');
  const api = compile('customApi', 'contoso_Act');
  const cases = [
    [ev, 'env-definition', 'hint', 'A public hint 3b9d'], [ev, 'env-definition', 'learnmoreurl', 'https://contoso.example/help-3b9d'],
    [ev, 'env-definition', 'inputcontrolconfig', '{"control":"3b9d"}'],
    [cr, 'connection-reference', 'connectionparametersconfig', '{"p":"3b9d"}'], [cr, 'connection-reference', 'connectionparametersetconfig', '{"s":"3b9d"}'],
    [cr, 'connection-reference', 'promptingbehavior', 1],
  ];
  for (const [c, tag, column, value] of cases) {
    const raw = faithfulRead(c);
    assert.deepEqual(P.publicProjectionFromObserved(tag, raw), { ok: true, public: c.unit.rows[0].public }, `${column}: the faithful read`);
    const out = P.publicProjectionFromObserved(tag, { ...raw, [column]: value });
    assert.deepEqual([out.ok, out.code], [false, P.CODES.graphUnreadable], column);
    assert.match(out.reason, new RegExp(`the ${column} column`));
    assert.ok(!out.reason.includes(String(value)), 'the refusal names the column, never its value');
  }
  assert.deepEqual(P.publicProjectionFromObserved('connection-reference', { ...faithfulRead(cr), promptingbehavior: null }), { ok: true, public: cr.unit.rows[0].public }, 'an empty prompting behavior is the default');
  // A Custom API's implementation lookup is not part of the projection: a wider read that carries it changes nothing.
  assert.deepEqual(P.publicProjectionFromObserved('custom-api', { ...faithfulRead(api), _plugintypeid_value: GUID(9) }), { ok: true, public: api.unit.rows[0].public });
  // The baseline of an existing root reads it the same way: a customized root is no baseline, a faithful one is.
  const dvOf = (rootRow) => ({ get: async (p) => ({ status: 200, body: p.startsWith('/environmentvariabledefinitions(') ? rootRow : { value: [] } }) });
  const good = await P.captureConfigurationBaseline(dvOf(faithfulRead(ev)), { kind: 'environmentVariable', rootId: ev.unit.root.id });
  assert.deepEqual(good, { ok: true, root: { kind: 'env-definition', id: ev.unit.root.id, public: ev.unit.rows[0].public }, children: [] });
  const hinted = await P.captureConfigurationBaseline(dvOf({ ...faithfulRead(ev), hint: 'A public hint 3b9d' }), { kind: 'environmentVariable', rootId: ev.unit.root.id });
  assert.deepEqual([hinted.ok, hinted.code], [false, P.CODES.graphUnreadable]);
  assert.match(hinted.reason, /the hint column/);
});

test('validatePublicRow: exactly the kind\'s fields, each of its type', () => {
  const pub = compile('duplicateRule', 'email').unit.rows[1].public;
  assert.deepEqual(P.validatePublicRow('rule-condition', pub), { ok: true });
  const cases = [
    [{ ...pub, extra: 1 }, /unknown field extra/],
    [(({ ignoreBlankValues, ...r }) => r)(pub), /missing field ignoreBlankValues/],
    [{ ...pub, parentId: pub.parentId.toUpperCase() }, /parentId is not guid/],
    [{ ...pub, characters: -1 }, /characters is not nullable-integer/],
    [{ ...pub, characters: 1.5 }, /characters/],
    [{ ...pub, ignoreBlankValues: 'false' }, /ignoreBlankValues is not boolean/],
    [{ ...pub, column: null }, /column is not string/],
  ];
  for (const [row, reason] of cases) assert.match(P.validatePublicRow('rule-condition', row).reason, reason);
  assert.equal(P.validatePublicRow('nope', pub).ok, false);
});

test('the receipt kind table is the kind table\'s exact receipt view: root, parentKinds, publicFields, privateFields, frozen', () => {
  const R = P.CONFIGURATION_CREATE_RECEIPT_KIND_TABLE;
  assert.deepEqual(Object.keys(R), Object.keys(P.CONFIGURATION_CREATE_KIND_TABLE));
  for (const [tag, k] of Object.entries(P.CONFIGURATION_CREATE_KIND_TABLE)) {
    assert.deepEqual(Object.keys(R[tag]), ['root', 'parentKinds', 'publicFields', 'privateFields'], tag);
    assert.deepEqual(R[tag], { root: k.root, parentKinds: k.parentKinds, publicFields: k.publicFields, privateFields: k.privateFields }, tag);
    for (const v of [R[tag], R[tag].parentKinds, R[tag].publicFields, R[tag].privateFields]) assert.ok(Object.isFrozen(v), tag);
  }
  assert.ok(Object.isFrozen(R));
});

// ---------------------------------------------------------------------------------------------
// A stored unit

test('validateRecordedCreateUnit: a stored unit is exactly a unit this module could compile; another intent is named, never re-planned', () => {
  const c = compile('duplicateRule', 'email');
  const stored = () => JSON.parse(JSON.stringify({ unitId: 'u-1', attemptId: 'a-1', state: 'prepared', ...c.unit, rows: c.unit.rows.map((r) => ({ ...r, dispatch: 'unsent' })) }));
  assert.deepEqual(P.validateRecordedCreateUnit(stored()), { ok: true });
  assert.deepEqual(P.validateRecordedCreateUnit(stored(), { current: c.unit }), { ok: true, samePlan: true });
  const broken = [
    ['an unknown unit field', (u) => { u.extra = 1; }],
    ['an unknown row field', (u) => { u.rows[0].body = '{}'; }],
    ['an upper-case id', (u) => { u.rows[1].id = u.rows[1].id.toUpperCase(); }],
    ['a duplicated id', (u) => { u.rows[2].id = u.rows[1].id; }],
    ['a duplicated key', (u) => { u.rows[2].key = u.rows[1].key; }],
    ['a child of another root', (u) => { u.rows[1].parentId = GUID(8); }],
    ['a child whose public parent differs', (u) => { u.rows[1].public.parentId = GUID(8); }],
    ['a child of a kind the root cannot hold', (u) => { u.rows[1].kind = 'api-request'; }],
    ['a second root', (u) => { u.rows.push({ ...u.rows[0], id: GUID(8), key: 'other' }); }],
    ['a changed private classification', (u) => { u.rows[0].privateFields = ['name']; }],
    ['a value in the public row', (u) => { u.rows[0].public.defaultValue = DEFAULT; }],
    ['nothing to create', (u) => { for (const r of u.rows) r.role = 'preserved'; }],
    ['an unknown role', (u) => { u.rows[0].role = 'update'; }],
    ['a rewritten public row', (u) => { u.rows[0].public.name = 'Other'; }],
    ['a malformed hash', (u) => { u.publicPlanSha256 = 'abc'; }],
    ['a root that is not a root tag', (u) => { u.root.kind = 'duplicateRule'; }],
  ];
  for (const [what, edit] of broken) {
    const u = stored();
    edit(u);
    assert.equal(P.validateRecordedCreateUnit(u).code, P.CODES.stateInvalid, what);
  }
  const api = compile('customApi', 'contoso_Calc');
  const published = JSON.parse(JSON.stringify({ ...api.unit, publicationRequired: true }));
  published.publicIntentSha256 = P.publicIntentSha256(published);
  published.publicPlanSha256 = P.publicPlanSha256(published);
  assert.equal(P.validateRecordedCreateUnit(published).code, P.CODES.stateInvalid, 'only a new rule is published');
  // The declaration changed since the attempt was recorded: another public intent, or another root.
  const relabelled = spec();
  relabelled.duplicateDetectionRules[0].name = 'Renamed';
  assert.equal(P.validateRecordedCreateUnit(stored(), { current: compile('duplicateRule', 'email', { s: relabelled }).unit }).code, P.CODES.intentChanged);
  assert.equal(P.validateRecordedCreateUnit(stored(), { current: compile('duplicateRule', 'x').unit }).code, P.CODES.intentChanged);
  // The same intent at another root id (found under an older id) is the same attempt, but not the same plan.
  const elsewhere = compile('duplicateRule', 'email', { solution: 'Other' });
  assert.deepEqual(P.validateRecordedCreateUnit(stored(), { current: elsewhere.unit }), { ok: true, samePlan: false });
});

test('validateRecordedCreateUnit: the publication slot and publicationRequired never contradict, and only a new rule has either', () => {
  const published = compile('duplicateRule', 'email');
  const unpublished = compile('duplicateRule', 'x');
  const api = compile('customApi', 'contoso_Calc');
  assert.deepEqual([published.unit.publicationRequired, unpublished.unit.publicationRequired, api.unit.publicationRequired], [true, false, false]);
  const recorded = (c, edit) => { const u = JSON.parse(JSON.stringify(c.unit)); edit(u); return u; };
  const slot = { dispatch: 'dispatched' };
  // Each representation alone, and both when they agree, are the compiled plan.
  const legit = [
    [published, 'compiled only', () => {}],
    [unpublished, 'compiled only', () => {}],
    [api, 'compiled only', () => {}],
    [published, 'stored only', (u) => { delete u.publicationRequired; u.publication = { dispatch: 'unsent' }; }],
    [unpublished, 'stored only', (u) => { delete u.publicationRequired; u.publication = null; }],
    [api, 'stored only', (u) => { delete u.publicationRequired; u.publication = null; }],
    [published, 'both', (u) => { u.publication = slot; }],
    [api, 'both', (u) => { u.publication = null; }],
  ];
  for (const [c, what, edit] of legit) {
    assert.deepEqual(P.validateRecordedCreateUnit(recorded(c, edit), { current: c.unit }), { ok: true, samePlan: true }, `${c.unit.root.key}: ${what}`);
  }
  // The hashes are left as compiled: a contradiction is refused before them, never read as either side.
  const contradictions = [
    [api, 'a Custom API with a publication slot', (u) => { u.publication = slot; }],
    [api, 'a Custom API stored with only a publication slot', (u) => { delete u.publicationRequired; u.publication = slot; }],
    [unpublished, 'an unpublished rule with a publication slot', (u) => { u.publication = slot; }],
    [published, 'a published rule without its publication slot', (u) => { u.publication = null; }],
  ];
  for (const [c, what, edit] of contradictions) {
    const out = P.validateRecordedCreateUnit(recorded(c, edit), { current: c.unit });
    assert.deepEqual([out.ok, out.code], [false, P.CODES.stateInvalid], what);
  }
});
