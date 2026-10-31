'use strict';

// lib/configuration-artifacts.js against the REAL maker-SDK bundle (lib/maker-sdk.js) and a strict
// in-memory org (tests/helpers/fake-config-org.js) that answers every request the SDK sends and
// records it. These tests pin the wire: what each plan decision actually sends, that an unchanged
// spec sends nothing, and that refusals happen before the first write.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { createStableCreatePort, readFromOrg } = require('./helpers/stable-create-port.js');
const { configurationSendOnce, withConfigurationWrite, inConfigurationWrite } = require('../lib/configuration-transport.js');
const { createConfigurationRuntime } = require('../lib/configuration-build.js');
const C = require('../lib/configuration-artifacts.js');

const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const SQL = '/providers/Microsoft.PowerApps/apis/shared_sql';

// `lose(request)` -> true commits the request in the org and then answers it 503, as a gateway that dropped the answer does.
// `unversioned(request)` -> true commits the request and answers it without any version (no ETag header, no `@odata.etag`).
// `retrying: true` builds the client without the configuration send-once rule (the generic six-attempt loop).
// `port` adds options to the stable create port double (tests/helpers/stable-create-port.js): `bound`, `protectedKinds`.
async function harness({ lose, unversioned, retrying = false, port = {}, ...orgOptions } = {}) {
  const org = createConfigOrg({
    tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }],
    solution: { uniqueName: 'ContosoSol', version: '1.0.0.0', prefix: 'contoso' },
    ...orgOptions,
  });
  const request = async (req) => {
    const answer = await org.request(req);
    const where = String(req.url).replace(/^https:\/\/[^/]+\/api\/data\/v9\.\d/, '');
    if (lose && lose({ method: String(req.method).toUpperCase(), path: where, body: req.body })) {
      return { statusCode: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040216', message: 'Service unavailable' } }) };
    }
    if (unversioned && unversioned({ method: String(req.method).toUpperCase(), path: where })) {
      const headers = Object.fromEntries(Object.entries(answer.headers || {}).filter(([k]) => k.toLowerCase() !== 'etag'));
      let body = answer.body;
      try { const parsed = JSON.parse(body); delete parsed['@odata.etag']; body = JSON.stringify(parsed); } catch { /* an empty 204 body has no version to strip */ }
      return { ...answer, headers, body };
    }
    return answer;
  };
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request, sleep: async () => {}, ...(retrying ? {} : { sendOnce: configurationSendOnce }) });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('config-artifacts-')), instanceUrl: org.origin, httpClient, solutionUniqueName: 'ContosoSol' });
  await sdk.initWorkspace();
  const creates = createStableCreatePort({ read: readFromOrg(org), ...port });
  // One build step (a new invocation of the build): plan everything, apply it, and return the result plus the writes it sent.
  const run = async (spec, extra = {}) => {
    const ctx = { sdk, creates, ...extra };
    const mark = org.requests.length;
    const plan = await C.planConfiguration(spec, ctx);
    await C.planSolutionVersion(spec, ctx, plan);
    const result = await C.applyConfiguration(plan, ctx);
    return { plan, result, writes: org.writes(mark), requests: org.requests.slice(mark) };
  };
  return { org, sdk, creates, run };
}

const spec = () => ({
  minimumPluginVersion: '2.21.0',
  solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso', version: '1.2.0.0' },
  environmentVariables: [
    { schemaName: 'contoso_List', type: 'dataSource', connectorId: SP, parameterKey: 'table', parentSchemaName: 'contoso_Site' },
    { schemaName: 'contoso_Site', type: 'dataSource', connectorId: SP, parameterKey: 'dataset' },
    { schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'https://api.contoso.com' },
  ],
  connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
  customApis: [{ uniqueName: 'contoso_Calc', isFunction: true,
    requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'B', type: 'integer', isOptional: true }],
    responseProperties: [{ uniqueName: 'R', type: 'string' }] }],
  duplicateDetectionRules: [{ key: 'email', name: 'Contacts with same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }],
});
const settings = (value, connectionId) => ({
  EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: value }],
  ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: connectionId }],
});
const header = (request, name) => Object.entries(request.headers || {}).find(([k]) => k.toLowerCase() === name.toLowerCase());

test('a first build creates every kind in dependency order; the same spec again sends no write at all', async () => {
  const h = await harness();
  const bindings = C.readDeploymentBindings(settings('https://v1.contoso.com', 'conn-1'), spec());
  const first = await h.run(spec(), { bindings });
  assert.deepEqual(first.result.refused, []);
  assert.deepEqual(first.result.unknown, []);
  assert.deepEqual(first.result.pendingPublish, []);
  assert.deepEqual(first.result.saved.map((s) => [s.kind, s.key, s.action]), [
    ['environmentVariable', 'contoso_Site', 'create'], ['environmentVariable', 'contoso_List', 'create'], ['environmentVariable', 'contoso_ApiBase', 'create'],
    ['connectionReference', 'contoso_sp', 'create'], ['customApi', 'contoso_Calc', 'create'], ['duplicateRule', 'email', 'create'],
    ['solutionVersion', 'ContosoSol', 'update'],
  ]);
  assert.deepEqual(h.org.unexpected, []);
  // Parent first, and the child binds it.
  const definitions = first.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/environmentvariabledefinitions'));
  assert.deepEqual(definitions.map((r) => r.body.schemaname), ['contoso_Site', 'contoso_List', 'contoso_ApiBase']);
  const site = h.org.rows('environmentvariabledefinitions').find((r) => r.schemaname === 'contoso_Site');
  assert.equal(h.org.rows('environmentvariabledefinitions').find((r) => r.schemaname === 'contoso_List')._parentdefinitionid_value, site.environmentvariabledefinitionid);
  // A value is per-environment data, not a solution component: its POST carries no solution header.
  const valuePost = first.requests.find((r) => r.method === 'POST' && r.path.startsWith('/environmentvariablevalues'));
  assert.equal(valuePost.body.value, 'https://v1.contoso.com');
  assert.equal(header(valuePost, 'MSCRM.SolutionUniqueName'), undefined);
  assert.equal(header(definitions[0], 'MSCRM.SolutionUniqueName')[1], 'ContosoSol');
  // The ids are the create port's: the Custom API's parameters carry the ids it minted per child key.
  const params = h.org.rows('customapirequestparameters');
  assert.equal(h.org.rows('customapis')[0].customapiid, h.creates.idOf('customApi', 'contoso_calc'));
  assert.equal(params.find((p) => p.uniquename === 'A').customapirequestparameterid, h.creates.childIdOf('contoso_calc', 'request:a'));
  assert.equal(h.org.rows('connectionreferences')[0].connectionid, 'conn-1');
  assert.equal(h.org.rows('duplicaterules')[0].statecode, 1);
  assert.equal(h.org.rows('solutions')[0].version, '1.2.0.0');
  // Nothing in the result or the plan carries a value or a connection id.
  const text = JSON.stringify([first.plan, first.result]);
  for (const secret of ['v1.contoso.com', 'conn-1', 'api.contoso.com']) assert.ok(!text.includes(secret), secret);

  const again = await h.run(spec(), { bindings });
  assert.deepEqual(again.writes, []);
  assert.equal(again.result.unchanged.length, 7);
  assert.ok(again.requests.every((r) => r.method === 'GET'));
  assert.ok(!again.requests.some((r) => r.path.startsWith('/EntityDefinitions')), 'an unchanged rule costs no switch read');
});

// The exact `--authorize` Set a maker passes (configurationAuthorizationKeys normalizes it in the build).
const allow = (...tokens) => new Set(tokens);

test('values: replacing or deleting a value, and rebinding or unbinding a reference, need their own token; an omitted entry leaves it', async () => {
  const h = await harness();
  const s = spec();
  await h.run(s, { bindings: C.readDeploymentBindings(settings('https://v1.contoso.com', 'conn-1'), s) });
  const valueId = h.org.rows('environmentvariablevalues')[0].environmentvariablevalueid;
  const referenceId = h.org.rows('connectionreferences')[0].connectionreferenceid;
  const v2 = C.readDeploymentBindings(settings('https://v2.contoso.com', 'conn-2'), s);
  const unauthorized = await h.run(s, { bindings: v2, authorizedDestructive: true });
  assert.deepEqual(unauthorized.result.refused.map((r) => [r.kind, r.code, r.authorize]), [
    ['environmentVariable', 'DESTRUCTIVE_CHANGE_UNAUTHORIZED', ['environmentVariableValue:contoso_apibase:value']],
    ['connectionReference', 'DESTRUCTIVE_CHANGE_UNAUTHORIZED', ['connectionReference:contoso_sp:connectionId']],
  ], 'a boolean authorizes nothing');
  assert.deepEqual(unauthorized.writes, []);
  const changed = await h.run(s, { bindings: v2, authorizedDestructive: allow('environmentVariableValue:contoso_apibase:value', 'connectionReference:contoso_sp:connectionId') });
  assert.deepEqual(changed.writes.sort(), [`PATCH /connectionreferences(${referenceId})`, `PATCH /environmentvariablevalues(${valueId})`].sort());
  const preserved = await h.run(s, { bindings: C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: '' }] }, s) });
  assert.deepEqual(preserved.writes, []);
  const cleared = await h.run(s, { bindings: C.readDeploymentBindings(settings(null, null), s), authorizedDestructive: allow('environmentVariableValue:contoso_apibase:value', 'connectionReference:contoso_sp:connectionId') });
  assert.deepEqual(cleared.writes.sort(), [`DELETE /environmentvariablevalues(${valueId})`, `PATCH /connectionreferences(${referenceId})`].sort());
  assert.deepEqual(cleared.result.unknown, []);
  assert.equal(h.org.rows('environmentvariablevalues').length, 0);
  assert.equal(h.org.rows('connectionreferences')[0].connectionid, null);
  assert.deepEqual(h.org.unexpected, []);
});

test('refusals happen before the first write: another connector, a changed Custom API contract, a label edit in a multilingual org', async () => {
  const h = await harness({ languages: [1033, 1036] });
  const s = spec();
  delete s.duplicateDetectionRules;
  await h.run(s);
  const ids = { sp: h.org.rows('connectionreferences')[0].connectionreferenceid, calc: h.org.rows('customapis')[0].customapiid };
  const wrong = spec();
  wrong.connectionReferences[0].connectorId = SQL;
  wrong.customApis[0].isFunction = false;
  wrong.customApis[0].requestParameters[0].type = 'string';
  delete wrong.duplicateDetectionRules;
  const refused = await h.run(wrong, { solutionUniqueName: 'ContosoSol' });
  assert.deepEqual(refused.result.refused, [
    { kind: 'connectionReference', key: 'contoso_sp', id: ids.sp, code: 'CONNECTION_REFERENCE_CONNECTOR_MISMATCH' },
    { kind: 'customApi', key: 'contoso_Calc', id: ids.calc, code: 'CUSTOM_API_IMMUTABLE' },
  ]);
  assert.deepEqual(refused.writes, [], 'membership included');
  const label = spec();
  delete label.duplicateDetectionRules;
  label.customApis[0].displayName = 'Calculate';
  const labelled = await h.run(label);
  assert.deepEqual(labelled.result.refused, [{ kind: 'customApi', key: 'contoso_Calc', id: ids.calc, code: 'CUSTOM_API_LABELS_UNSUPPORTED' }]);
  assert.deepEqual(labelled.writes, []);
  assert.deepEqual(h.org.unexpected, []);
});

test('a Custom API edit keeps the ids of kept parameters; each removal needs its own child token, never a parent token or a boolean', async () => {
  const h = await harness();
  const s = spec();
  await h.run(s);
  const before = new Map(h.org.rows('customapirequestparameters').map((p) => [p.uniquename, p.customapirequestparameterid]));
  const edited = spec();
  edited.customApis[0].requestParameters = [{ uniqueName: 'A', type: 'integer', displayName: 'Alpha' }, { uniqueName: 'C', type: 'string' }];
  const calc = h.org.rows('customapis')[0].customapiid;
  for (const authorizedDestructive of [undefined, true, allow('customApi:contoso_calc'), allow('customApi:contoso_calc:request:c')]) {
    const unauthorized = await h.run(edited, { authorizedDestructive });
    assert.deepEqual(unauthorized.result.refused, [{ kind: 'customApi', key: 'contoso_Calc', id: calc, code: 'DESTRUCTIVE_CHANGE_UNAUTHORIZED', authorize: ['customApi:contoso_calc:request:b'] }]);
    assert.deepEqual(unauthorized.writes, []);
  }
  const authorized = await h.run(edited, { authorizedDestructive: allow('customApi:contoso_calc:request:b') });
  assert.deepEqual(authorized.result.saved, [{ kind: 'customApi', key: 'contoso_Calc', id: calc, action: 'update', fields: ['/requestParameters'] }]);
  const after = new Map(h.org.rows('customapirequestparameters').map((p) => [p.uniquename, p]));
  assert.deepEqual([...after.keys()].sort(), ['A', 'C']);
  assert.equal(after.get('A').customapirequestparameterid, before.get('A'));
  assert.equal(after.get('A').displayname, 'Alpha');
  assert.equal(after.get('C').customapirequestparameterid, h.creates.idOf('customApiRequestParameter', 'contoso_calc|request:c'));
  assert.deepEqual((await h.run(edited)).writes, []);
  assert.deepEqual(h.org.unexpected, []);
});

test('a duplicate rule edit is saved and published again; a table with detection off is refused unless the spec turns it on', async () => {
  const h = await harness();
  await h.run(spec());
  const edited = spec();
  edited.duplicateDetectionRules[0].status = 'published';
  edited.duplicateDetectionRules[0].description = 'changed';
  edited.duplicateDetectionRules[0].conditions.push({ key: 'l', column: 'lastname', match: 'firstCharacters', characters: 3 });
  const conditionId = h.org.rows('duplicateruleconditions')[0].duplicateruleconditionid;
  const saved = await h.run(edited);
  assert.deepEqual(saved.result.saved.map((x) => [x.key, x.fields]), [['email', ['/description', '/conditions']]]);
  assert.deepEqual(saved.result.pendingPublish, []);
  assert.ok(saved.writes.some((w) => w.endsWith('Microsoft.Dynamics.CRM.PublishDuplicateRule')));
  assert.equal(h.org.rows('duplicaterules')[0].statecode, 1);
  assert.ok(h.org.rows('duplicateruleconditions').some((c) => c.duplicateruleconditionid === conditionId));
  assert.equal(h.org.rows('duplicateruleconditions').length, 2);
  assert.equal(h.org.rows('duplicateruleconditions').find((c) => c.baseattributename === 'lastname').duplicateruleconditionid, h.creates.idOf('duplicateRuleCondition', 'email|l'));
  assert.deepEqual((await h.run(edited)).writes, []);

  const off = await harness({ tables: [{ logicalName: 'contact', duplicateDetectionEnabled: false, attributes: ['emailaddress1'] }] });
  const refused = await off.run(spec());
  assert.deepEqual(refused.result.refused, [{ kind: 'duplicateRule', key: 'email', code: 'DUPLICATE_DETECTION_DISABLED' }]);
  assert.ok(!refused.writes.some((w) => w.includes('duplicaterule')));
  const declared = { ...spec(), entities: [{ schemaName: 'contact', duplicateDetectionEnabled: true }] };
  const blocked = await off.run(declared);
  assert.deepEqual(blocked.result.refused, [{ kind: 'duplicateRule', key: 'email', code: 'DUPLICATE_DETECTION_DISABLED' }], 'the precondition is checked again when applying');
  off.org.table('contact').duplicateDetectionEnabled = true;
  const enabled = await off.run(declared);
  assert.deepEqual(enabled.result.saved.map((x) => x.kind), ['duplicateRule']);
  assert.deepEqual(off.org.unexpected, []);
});

const referenceOnly = () => ({ minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] });

test('a create whose answer was lost is the typed unknown with its cause and safe handle; it is sent once', async () => {
  let drop = true;
  const h = await harness({ intercept: ({ method, path }) => (drop && method === 'POST' && path.startsWith('/connectionreferences') ? { statusCode: 503, body: { error: { code: '0x80040216', message: 'Service unavailable' } } } : undefined) });
  const s = referenceOnly();
  const first = await h.run(s);
  const id = h.creates.idOf('connectionReference', 'contoso_sp');
  assert.deepEqual(first.result.unknown, [{ kind: 'connectionReference', key: 'contoso_sp', id, code: 'create-outcome-unknown', cause: 'CONNECTION_ERROR' }]);
  assert.deepEqual(first.result.unknown[0].handle, { formatVersion: 1, kind: 'connectionReference', key: 'contoso_sp', identity: { uniqueName: 'contoso_sp' }, ids: { id, childIds: {} } });
  assert.ok(!Object.keys(first.result.unknown[0]).includes('handle'), 'the handle never reaches a printed result');
  // Sent once: the configuration send-once rule keeps the client from re-sending a create whose answer was lost.
  assert.equal(first.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/connectionreferences')).length, 1);
  // The next build reads the identity's own id first; nothing is there, so the same identity is created once more.
  drop = false;
  const again = await h.run(s);
  assert.deepEqual(again.result.saved.map((x) => [x.key, x.id, x.action]), [['contoso_sp', id, 'create']]);
  assert.equal(h.org.rows('connectionreferences').length, 1);
  assert.deepEqual(h.org.unexpected, []);
});

test('a create that landed behind a lost answer is found at its own id; a namesake at another id is refused; an unreadable id stops the item', async () => {
  const h = await harness({ lose: ({ method, path }) => method === 'POST' && path.startsWith('/connectionreferences') });
  const s = referenceOnly();
  const first = await h.run(s);
  assert.deepEqual(first.result.unknown.map((u) => u.code), ['create-outcome-unknown']);
  const landed = h.org.rows('connectionreferences')[0].connectionreferenceid;
  assert.equal(landed, h.creates.idOf('connectionReference', 'contoso_sp'));
  const found = await h.run(s, { bindings: C.readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-1' }] }, s) });
  assert.deepEqual(found.result.saved.map((x) => [x.key, x.id, x.action]), [['contoso_sp', landed, 'update']]);
  assert.deepEqual(found.writes, [`PATCH /connectionreferences(${landed})`], 'never a second create');

  // A row of the same name somebody else made, at an id that is not this identity's.
  const other = await harness();
  const outside = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('config-outside-')), instanceUrl: other.org.origin, httpClient: createAzHttpClient(other.org.origin, { getToken: () => 'test-token-0123456789abcdef', request: other.org.request, sleep: async () => {} }) });
  await outside.initWorkspace();
  await other.run(s, { sdk: outside, creates: undefined });
  const foreign = other.org.rows('connectionreferences')[0].connectionreferenceid;
  const conflict = await other.run(s);
  assert.deepEqual(conflict.result.refused, [{ kind: 'connectionReference', key: 'contoso_sp', id: foreign, code: 'create-identity-conflict', reason: 'CONFIGURATION_IDENTITY_FOREIGN' }]);
  assert.deepEqual(conflict.writes, []);
  // The plain pass-through port has no resolver: the unique name is the identity and the row is reused.
  const plain = await other.run(s, { creates: undefined });
  assert.deepEqual(plain.result.unchanged.map((x) => [x.key, x.id]), [['contoso_sp', foreign]]);

  // A resolver that cannot read the id never proves absence.
  const failing = await harness();
  const unreadable = await failing.run(s, { creates: createStableCreatePort({ read: async () => { throw new Error('read failed'); } }) });
  assert.deepEqual(unreadable.result.unknown, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'create-identity-unverified' }]);
  assert.deepEqual(unreadable.writes, []);
});

test('a resolver stop that names the id it could not read keeps that id and a safe handle; the next run sends nothing', async () => {
  const h = await harness({ lose: ({ method, path }) => method === 'POST' && path.startsWith('/connectionreferences') });
  const s = referenceOnly();
  const first = await h.run(s);
  const id = first.result.unknown[0].id;
  assert.ok(id);
  // The common resolver's typed stop: its code, and the create it is about (kind, key, the id it read) — plus text that is not for output.
  const stop = Object.assign(new Error('the row at that id could not be read: Authorization: Bearer abc.def'), { code: 'create-identity-unverified', create: { kind: 'connectionReference', key: 'contoso_sp', id } });
  const next = await h.run(s, { creates: { ...h.creates, resolve: async () => { throw stop; } } });
  assert.deepEqual(next.result.unknown, [{ kind: 'connectionReference', key: 'contoso_sp', id, code: 'create-identity-unverified' }]);
  assert.deepEqual(next.result.unknown[0].handle, { formatVersion: 1, kind: 'connectionReference', key: 'contoso_sp', identity: { uniqueName: 'contoso_sp' }, ids: { id } });
  assert.deepEqual(next.plan.unknown, [{ kind: 'connectionReference', key: 'contoso_sp', id, code: 'create-identity-unverified' }]);
  assert.doesNotMatch(JSON.stringify([next.result, next.plan, next.result.unknown[0].handle]), /Bearer|Authorization/);
  assert.deepEqual(next.writes, []);
  // A stop the resolver raises for a conflict keeps its own code (refused, nothing sent); an id that is not a GUID is dropped.
  const conflict = Object.assign(new Error('x'), { code: 'create-identity-conflict', create: { kind: 'connectionReference', key: 'contoso_sp', id: 'not a guid' } });
  const refused = await h.run(s, { creates: { ...h.creates, resolve: async () => { throw conflict; } } });
  assert.deepEqual([refused.result.refused, refused.result.unknown, refused.writes], [[{ kind: 'connectionReference', key: 'contoso_sp', code: 'create-identity-conflict' }], [], []]);
});

test('without a create port of its own the build still creates every kind and every added child (ordinary creation is never disabled)', async () => {
  const h = await harness();
  const s = spec();
  delete s.solution.version;
  const bindings = C.readDeploymentBindings(settings(undefined, undefined), s);
  const first = await h.run(s, { bindings, creates: undefined });
  assert.deepEqual([first.result.refused, first.result.unknown], [[], []]);
  assert.equal(first.result.saved.length, 6);
  const edited = spec();
  delete edited.solution.version;
  edited.customApis[0].requestParameters.push({ uniqueName: 'C', type: 'string' });
  edited.duplicateDetectionRules[0].conditions.push({ key: 'l', column: 'lastname', match: 'exact' });
  const added = await h.run(edited, { bindings: C.readDeploymentBindings(settings('https://v1.contoso.com', undefined), edited), creates: undefined });
  assert.deepEqual([added.result.refused, added.result.unknown], [[], []]);
  assert.equal(h.org.rows('environmentvariablevalues').length, 1);
  assert.ok(h.org.rows('customapirequestparameters').some((p) => p.uniquename === 'C'));
  assert.ok(h.org.rows('duplicateruleconditions').some((c) => c.baseattributename === 'lastname'));
  assert.deepEqual(h.org.unexpected, []);
});

test('children added to an existing root are created through the port under its ids: a value, a parameter, a condition', async () => {
  const h = await harness();
  const s = spec();
  delete s.solution.version;
  await h.run(s);
  const edited = spec();
  delete edited.solution.version;
  edited.customApis[0].requestParameters.push({ uniqueName: 'C', type: 'string' });
  edited.duplicateDetectionRules[0].conditions.push({ key: 'l', column: 'lastname', match: 'exact' });
  const bindings = C.readDeploymentBindings(settings('https://v1.contoso.com', undefined), edited);
  const added = await h.run(edited, { bindings });
  assert.deepEqual(added.result.refused, []);
  assert.deepEqual(added.result.unknown, []);
  const value = h.creates.idOf('environmentVariableValue', 'contoso_apibase|value');
  const param = h.creates.idOf('customApiRequestParameter', 'contoso_calc|request:c');
  const condition = h.creates.idOf('duplicateRuleCondition', 'email|l');
  assert.equal(h.org.rows('environmentvariablevalues')[0].environmentvariablevalueid, value);
  assert.equal(h.org.rows('customapirequestparameters').find((p) => p.uniquename === 'C').customapirequestparameterid, param);
  assert.equal(h.org.rows('duplicateruleconditions').find((c) => c.baseattributename === 'lastname').duplicateruleconditionid, condition);
  const ported = h.creates.calls.filter((c) => c.op === 'run').map((c) => [c.kind, c.key, c.identity.parentId]);
  assert.ok(ported.some(([kind, key, parentId]) => kind === 'customApiRequestParameter' && key === 'contoso_calc|request:c' && parentId === h.org.rows('customapis')[0].customapiid));
  const bound = Object.fromEntries(added.result.managedBindings.map((b) => [b.kind, b.childIds]));
  assert.deepEqual(bound.environmentVariable, { value });
  assert.deepEqual(bound.customApi, { 'request:c': param });
  assert.deepEqual(bound.duplicateRule, { l: condition });
  assert.deepEqual((await h.run(edited, { bindings })).writes, []);
  assert.deepEqual(h.org.unexpected, []);
});

test('a child create whose answer was lost leaves the item unknown and stops the writes after it; the next build finds the child at its id', async () => {
  const h = await harness({ lose: ({ method, path }) => method === 'POST' && path.startsWith('/customapirequestparameters') });
  const s = spec();
  delete s.solution.version;
  await h.run(s);
  const edited = spec();
  delete edited.solution.version;
  edited.customApis[0].requestParameters.push({ uniqueName: 'C', type: 'string' });
  edited.duplicateDetectionRules[0].description = 'later';
  const lost = await h.run(edited);
  assert.deepEqual(lost.result.unknown.map((u) => [u.kind, u.key, u.code, u.cause]), [['customApi', 'contoso_Calc', 'CONFIGURATION_WRITE_UNKNOWN', 'CONNECTION_ERROR']]);
  assert.deepEqual(lost.result.refused.map((r) => [r.kind, r.code]), [['duplicateRule', 'CONFIGURATION_STOPPED_AFTER_UNKNOWN']]);
  assert.ok(!lost.writes.some((w) => w.includes('duplicaterule')));
  const params = () => h.org.rows('customapirequestparameters').filter((p) => p.uniquename === 'C');
  assert.equal(params().length, 1);
  assert.equal(params()[0].customapirequestparameterid, h.creates.idOf('customApiRequestParameter', 'contoso_calc|request:c'));
  const again = await h.run(edited);
  assert.equal(params().length, 1, 'the child is paired, never created twice');
  assert.deepEqual(again.result.unknown, []);
  assert.deepEqual(again.result.saved.map((x) => x.kind), ['duplicateRule']);
});

test('a read-back that shows a child at another id than the one created is not a saved Custom API: the create is not complete', async () => {
  const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let org = null;
  let swap = true;
  // Between the create and its read-back the request parameter is replaced by a row with the same content at another id.
  const h = await harness({ intercept: ({ method, path }) => {
    if (!swap || !org || method !== 'GET' || !path.startsWith('/customapis(') || !org.rows('customapirequestparameters').length) return undefined;
    const set = org.sets.get('customapirequestparameters');
    const row = [...set.values()][0];
    set.delete(row.customapirequestparameterid);
    row.customapirequestparameterid = foreign;
    set.set(foreign, row);
    swap = false;
    return undefined;
  } });
  org = h.org;
  const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, customApis: [{ uniqueName: 'contoso_Api', requestParameters: [{ uniqueName: 'a', type: 'string' }] }] };
  const { result } = await h.run(s);
  assert.equal(swap, false);
  const id = h.creates.idOf('customApi', 'contoso_api');
  assert.deepEqual(result.saved, []);
  assert.deepEqual(result.unknown.map((u) => [u.key, u.id, u.code, u.missing]), [['contoso_Api', id, 'create-completion-required', ['request:a']]]);
  // The root is this build's, and only the children the read shows at their own ids are claimed with it.
  assert.deepEqual(result.managedBindings, [{ kind: 'customApi', key: 'contoso_Api', id, origin: 'created' }]);
  // Without the swap the same create is saved with its child.
  const k = await harness();
  const plain = await k.run(s);
  assert.deepEqual(plain.result.unknown, []);
  assert.deepEqual(plain.result.saved.map((x) => x.key), ['contoso_Api']);
  assert.deepEqual(plain.result.managedBindings, [{ kind: 'customApi', key: 'contoso_Api', id, childIds: { 'request:a': k.creates.childIdOf('contoso_api', 'request:a') }, origin: 'created' }]);
});

test('an omitted field or child list is not managed; explicit values manage, each destructive one with its own token', async () => {
  const h = await harness();
  const full = {
    minimumPluginVersion: '2.21.0',
    solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' },
    environmentVariables: [{ schemaName: 'contoso_Mode', type: 'string', description: 'Mode', defaultValue: 'fast', isRequired: true }],
    customApis: [{ uniqueName: 'contoso_Calc', isPrivate: true, executePrivilegeName: 'prvReadAccount', description: 'Calc',
      requestParameters: [{ uniqueName: 'A', type: 'integer', isOptional: true }], responseProperties: [{ uniqueName: 'R', type: 'string' }] }],
    duplicateDetectionRules: [{ key: 'email', name: 'Contacts with same email', entity: 'contact', caseSensitive: true, excludeInactiveRecords: true,
      conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact', ignoreBlankValues: true }] }],
  };
  const created = await h.run(full);
  assert.deepEqual([created.result.refused, created.result.unknown], [[], []]);
  const bare = {
    ...full,
    environmentVariables: [{ schemaName: 'contoso_Mode', type: 'string' }],
    customApis: [{ uniqueName: 'contoso_Calc', description: 'Calc' }],
    duplicateDetectionRules: [{ key: 'email', name: 'Contacts with same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }],
  };
  const everything = allow('environmentVariable:contoso_mode:defaultValue', 'environmentVariable:contoso_mode:isRequired', 'customApi:contoso_calc:isPrivate',
    'customApi:contoso_calc:response:r', 'duplicateRule:email:caseSensitive', 'duplicateRule:email:condition:e');
  const omitted = await h.run(bare, { authorizedDestructive: everything });
  assert.deepEqual(omitted.writes, [], 'no token turns an omission into a change');
  assert.deepEqual(omitted.result.unchanged.map((u) => u.kind), ['environmentVariable', 'customApi', 'duplicateRule']);
  assert.equal(h.org.rows('customapirequestparameters').length, 1);
  assert.equal(h.org.rows('customapiresponseproperties').length, 1);
  const definition = h.org.rows('environmentvariabledefinitions')[0];
  assert.equal(definition.defaultvalue, 'fast');
  assert.equal(definition.isrequired, true);
  assert.equal(h.org.rows('duplicateruleconditions')[0].ignoreblankvalues, true, 'an omitted ignoreBlankValues keeps the stored flag');
  const explicit = {
    ...full,
    environmentVariables: [{ schemaName: 'contoso_Mode', type: 'string', defaultValue: null, isRequired: false }],
    customApis: [{ uniqueName: 'contoso_Calc', isPrivate: false, responseProperties: [] }],
    duplicateDetectionRules: [{ ...bare.duplicateDetectionRules[0], caseSensitive: false }],
  };
  const refused = await h.run(explicit, { authorizedDestructive: true });
  assert.deepEqual(refused.result.refused.map((r) => [r.kind, r.authorize]), [
    ['environmentVariable', ['environmentVariable:contoso_mode:defaultValue', 'environmentVariable:contoso_mode:isRequired']],
    ['customApi', ['customApi:contoso_calc:isPrivate', 'customApi:contoso_calc:response:r']],
    ['duplicateRule', ['duplicateRule:email:caseSensitive']],
  ]);
  assert.deepEqual(refused.writes, []);
  const managed = await h.run(explicit, { authorizedDestructive: everything });
  assert.deepEqual(managed.result.saved.map((x) => [x.kind, x.fields]), [
    ['environmentVariable', ['/defaultValue', '/isRequired']], ['customApi', ['/isPrivate', '/responseProperties']], ['duplicateRule', ['/caseSensitive']],
  ]);
  assert.equal(h.org.rows('customapirequestparameters').length, 1, 'an omitted request list is still unmanaged');
  assert.equal(h.org.rows('customapiresponseproperties').length, 0);
  assert.equal(h.org.rows('duplicateruleconditions')[0].ignoreblankvalues, true);
  assert.deepEqual(h.org.unexpected, []);
});

test('a duplicate condition the list no longer names is removed only with its own token', async () => {
  const h = await harness();
  const s = spec();
  s.duplicateDetectionRules[0].conditions.push({ key: 'l', column: 'lastname', match: 'exact' });
  await h.run(s);
  const edited = spec();
  // A row nobody keyed for this build (no managed binding) is named by its id; a recorded binding names it by key.
  const lastId = h.org.rows('duplicateruleconditions').find((c) => c.baseattributename === 'lastname').duplicateruleconditionid;
  const refused = await h.run(edited, { authorizedDestructive: allow('duplicateRule:email:condition:e', 'duplicateRule:email:condition:l') });
  assert.deepEqual(refused.result.refused.map((r) => [r.code, r.authorize]), [['DESTRUCTIVE_CHANGE_UNAUTHORIZED', [`duplicateRule:email:condition:${lastId}`]]]);
  assert.deepEqual(refused.writes, []);
  const ruleId = h.org.rows('duplicaterules')[0].duplicateruleid;
  const managed = { lookup: async (kind, key) => (kind === 'duplicateRule' && key === 'email' ? { id: ruleId, childIds: { e: h.creates.childIdOf('email', 'e'), l: lastId } } : null) };
  const named = await h.run(edited, { managed });
  assert.deepEqual(named.result.refused.map((r) => r.authorize), [['duplicateRule:email:condition:l']]);
  const removed = await h.run(edited, { managed, authorizedDestructive: allow('duplicateRule:email:condition:l') });
  assert.deepEqual(removed.result.saved.map((x) => [x.kind, x.fields]), [['duplicateRule', ['/conditions']]]);
  assert.deepEqual(h.org.rows('duplicateruleconditions').map((c) => c.baseattributename), ['emailaddress1']);
});

test('a value the SDK could not settle is unknown, never a saved variable: on create and on update, for a 503 and a 400', async () => {
  for (const status of [503, 400]) {
    let failValue = true;
    const h = await harness({ intercept: ({ method, path }) => (failValue && method !== 'GET' && path.startsWith('/environmentvariablevalues') ? { statusCode: status, body: { error: { code: '0x80040203', message: 'no' } } } : undefined) });
    const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string' }] };
    const bindings = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://v1.contoso.com' }] }, s);
    const created = await h.run(s, { bindings });
    const id = h.org.rows('environmentvariabledefinitions')[0].environmentvariabledefinitionid;
    // Two lines: the definition is proven, the value is not; never one whole-variable saved.
    assert.deepEqual(created.result.saved, [{ kind: 'environmentVariable', key: 'contoso_ApiBase', id, action: 'create', unit: 'definition' }], `create ${status}`);
    assert.deepEqual(created.result.unknown, [{ kind: 'environmentVariable', key: 'contoso_ApiBase', id, code: 'ENVIRONMENT_VARIABLE_VALUE_UNSETTLED', unit: 'value' }], `create ${status}`);
    assert.ok(!JSON.stringify(created.result).includes('v1.contoso.com'));
    const u = await harness({ intercept: ({ method, path }) => (failValue && method === 'PATCH' && path.startsWith('/environmentvariablevalues') ? { statusCode: status, body: { error: { code: '0x80040203', message: 'no' } } } : undefined) });
    failValue = false;
    await u.run({ ...s, environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', description: 'a' }] }, { bindings });
    failValue = true;
    const changed = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://v2.contoso.com' }] }, s);
    const updated = await u.run({ ...s, environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', description: 'b' }] }, { bindings: changed, authorizedDestructive: allow('environmentVariableValue:contoso_apibase:value') });
    assert.deepEqual(updated.result.saved.map((x) => [x.unit, x.fields]), [['definition', ['/description']]], `update ${status}`);
    assert.deepEqual(updated.result.unknown.map((x) => [x.code, x.unit]), [['ENVIRONMENT_VARIABLE_VALUE_UNSETTLED', 'value']], `update ${status}`);
  }
});

test('a clear the server refused after the definition was patched is unknown, never a saved variable', async () => {
  let failDelete = false;
  const h = await harness({ intercept: ({ method, path }) => (failDelete && method === 'DELETE' && path.startsWith('/environmentvariablevalues') ? { statusCode: 503, body: { error: { code: '0x80040216', message: 'Service unavailable' } } } : undefined) });
  const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', description: 'a' }] };
  await h.run(s, { bindings: C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://v1.contoso.com' }] }, s) });
  failDelete = true;
  const cleared = await h.run({ ...s, environmentVariables: [{ ...s.environmentVariables[0], description: 'b' }] }, {
    bindings: C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: null }] }, s),
    authorizedDestructive: allow('environmentVariableValue:contoso_apibase:value'),
  });
  assert.equal(h.org.rows('environmentvariabledefinitions')[0].description, 'b');
  assert.equal(h.org.rows('environmentvariablevalues').length, 1, 'the value is still there');
  assert.ok(!cleared.result.saved.some((x) => x.unit !== 'definition'), 'never reported as a saved variable');
  assert.equal(cleared.result.unknown.length, 1);
  assert.ok(['CONFIGURATION_WRITE_UNKNOWN', 'ENVIRONMENT_VARIABLE_VALUE_UNSETTLED'].includes(cleared.result.unknown[0].code), cleared.result.unknown[0].code);
});

test('a value the server saved but answered without a version is saved: the variable is complete and the next build sends nothing', async () => {
  const h = await harness({ unversioned: ({ method, path }) => method !== 'GET' && path.startsWith('/environmentvariablevalues') });
  const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string' }] };
  const bindings = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://v1.contoso.com' }] }, s);
  const created = await h.run(s, { bindings });
  assert.deepEqual(created.result.unknown, []);
  assert.deepEqual(created.result.refused, []);
  assert.deepEqual(created.result.saved.map((x) => x.key), ['contoso_ApiBase']);
  assert.equal(h.org.rows('environmentvariablevalues')[0].value, 'https://v1.contoso.com');
  const again = await h.run(s, { bindings });
  assert.deepEqual(again.writes, []);
  const changed = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://v2.contoso.com' }] }, s);
  const updated = await h.run(s, { bindings: changed, authorizedDestructive: allow('environmentVariableValue:contoso_apibase:value') });
  assert.deepEqual(updated.result.unknown, []);
  assert.deepEqual(updated.result.saved.map((x) => x.key), ['contoso_ApiBase']);
  assert.equal(h.org.rows('environmentvariablevalues')[0].value, 'https://v2.contoso.com');
  assert.deepEqual(h.org.unexpected, []);
});

test('readiness is read from the rows: a required variable without a value, an unbound or unverified reference, an unregistered Custom API', async () => {
  const h = await harness();
  const s = {
    minimumPluginVersion: '2.21.0',
    solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' },
    environmentVariables: [{ schemaName: 'contoso_Key', type: 'string', isRequired: true }, { schemaName: 'contoso_Opt', type: 'string', isRequired: true, defaultValue: 'x' }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
    customApis: [{ uniqueName: 'contoso_Calc' }],
  };
  const { result } = await h.run(s);
  // Refused before its first write: a definition that nothing can read would only fail later, at run time.
  assert.deepEqual(result.refused, [{ kind: 'environmentVariable', key: 'contoso_Key', code: 'ENVIRONMENT_VARIABLE_VALUE_MISSING' }]);
  assert.deepEqual(h.org.rows('environmentvariabledefinitions').map((r) => r.schemaname), ['contoso_Opt']);
  assert.deepEqual(C.configurationReadiness(result).map((b) => [b.key, b.code, b.blocksConsumers]), [
    ['contoso_Key', 'CONFIGURATION_DEFINITION_MISSING', true],
    ['contoso_sp', 'CONNECTION_REFERENCE_UNBOUND', true],
    ['contoso_Calc', 'CUSTOM_API_IMPLEMENTATION_UNPROVEN', true],
  ]);
  // The settings ask for a connection; without an inventory to prove it against, the binding is a wish.
  const bound = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_Key', Value: 'k' }], ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-1' }] }, s);
  const unverified = await h.run(s, { bindings: bound });
  assert.deepEqual(unverified.result.refused, []);
  assert.deepEqual(C.configurationReadiness(unverified.result).map((b) => [b.key, b.code]), [['contoso_sp', 'CONNECTION_REFERENCE_BINDING_UNVERIFIED'], ['contoso_Calc', 'CUSTOM_API_IMPLEMENTATION_UNPROVEN']]);
  const elsewhere = await h.run(s, { bindings: bound, connections: async () => [{ connectionId: 'conn-9' }] });
  assert.deepEqual(C.configurationReadiness(elsewhere.result).map((b) => [b.key, b.code]), [['contoso_sp', 'CONNECTION_REFERENCE_UNBOUND'], ['contoso_Calc', 'CUSTOM_API_IMPLEMENTATION_UNPROVEN']]);
  h.org.rows('customapis')[0]._plugintypeid_value = '00000000-0000-4000-8000-0000000000aa';
  const ready = await h.run(s, { bindings: bound, connections: async () => [{ connectionId: 'CONN-1', connectorId: SP }] });
  assert.deepEqual(C.configurationReadiness(ready.result), []);
  assert.deepEqual(h.org.unexpected, []);
});

test('an authorized clear of a required value is applied and read back; the missing value then stops the build', async () => {
  const h = await harness();
  const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, environmentVariables: [{ schemaName: 'contoso_V', type: 'string', isRequired: true }] };
  const present = await h.run(s, { bindings: C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_V', Value: 'present' }] }, s) });
  assert.deepEqual(present.result.refused, []);
  assert.equal(h.org.rows('environmentvariablevalues').length, 1);
  const cleared = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_V', Value: null }] }, s);
  // Without its exact token the clear is refused before any write, and the value stays.
  const unauthorized = await h.run(s, { bindings: cleared, authorizedDestructive: allow('environmentVariable:contoso_v:defaultValue') });
  assert.deepEqual(unauthorized.writes, []);
  assert.deepEqual(unauthorized.result.refused.map((r) => [r.key, r.code]), [['contoso_V', 'ENVIRONMENT_VARIABLE_VALUE_MISSING']]);
  assert.equal(h.org.rows('environmentvariablevalues').length, 1);
  // With it the clear is what the maker asked for: it is sent, read back, and the build then stops on the missing value.
  const step = await C.runConfigurationStep(s, { sdk: h.sdk, creates: h.creates, bindings: cleared, authorizedDestructive: allow('environmentVariableValue:contoso_v:value') }, 'data-model');
  assert.deepEqual(step.outcome.refused, []);
  assert.deepEqual(step.outcome.unknown, []);
  assert.deepEqual(step.outcome.saved.map((x) => [x.key, x.action, x.fields]), [['contoso_V', 'update', ['/currentValue']]]);
  assert.deepEqual(h.org.rows('environmentvariablevalues'), []);
  assert.deepEqual(step.blocking.map((b) => [b.key, b.code]), [['contoso_V', 'ENVIRONMENT_VARIABLE_VALUE_MISSING']]);
  assert.deepEqual(step.halt && step.halt.items, [{ kind: 'environmentVariable', key: 'contoso_V', code: 'ENVIRONMENT_VARIABLE_VALUE_MISSING' }]);
  // A first create of a required variable with no value is still refused before its first write.
  const fresh = { ...s, environmentVariables: [{ schemaName: 'contoso_W', type: 'string', isRequired: true }] };
  const first = await h.run(fresh, { bindings: C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_W', Value: null }] }, fresh), authorizedDestructive: allow('environmentVariableValue:contoso_w:value') });
  assert.deepEqual(first.writes, []);
  assert.deepEqual(first.result.refused.map((r) => [r.key, r.code]), [['contoso_W', 'ENVIRONMENT_VARIABLE_VALUE_MISSING']]);
  assert.deepEqual(h.org.unexpected, []);
});

test('a create committed behind a lost answer is never reported as nothing written, whatever answers a later send', async () => {
  const once = await harness({ lose: ({ method, path }) => method === 'POST' && path.startsWith('/connectionreferences') });
  const s = referenceOnly();
  const sentOnce = await once.run(s);
  assert.equal(sentOnce.requests.filter((r) => r.method === 'POST').length, 1);
  assert.equal(sentOnce.result.unknown.length, 1);
  // A client without the rule re-sends; the re-send is refused 412 because the first one committed, which the SDK
  // answers as ARTIFACT_ALREADY_EXISTS (saved: false). That is a create that landed, so it stays unknown.
  let sends = 0;
  const retrying = await harness({ retrying: true, lose: ({ method, path }) => method === 'POST' && path.startsWith('/connectionreferences') && ++sends === 1 });
  const resent = await retrying.run(s);
  assert.equal(retrying.org.rows('connectionreferences').length, 1);
  assert.deepEqual(resent.result.refused, []);
  assert.deepEqual(resent.result.saved, []);
  assert.deepEqual(resent.result.unknown.map((u) => [u.code, u.cause]), [['create-outcome-unknown', 'ARTIFACT_ALREADY_EXISTS']]);
  // A refusal of a first, only send is still a refusal: nothing was written.
  const refusing = await harness({ intercept: ({ method, path }) => (method === 'POST' && path.startsWith('/connectionreferences') ? { statusCode: 400, body: { error: { code: '0x80040203', message: 'bad' } } } : undefined) });
  const refused = await refusing.run(s);
  assert.deepEqual(refused.result.refused, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'CONNECTION_ERROR' }]);
  assert.equal(refused.requests.filter((r) => r.method === 'POST').length, 1);
});

test('a reused root, a duplicate rule included, is put into the build solution, and membership is proven by a fresh read', async () => {
  const h = await harness();
  const s = {
    minimumPluginVersion: '2.21.0',
    solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' },
    environmentVariables: [{ schemaName: 'contoso_Mode', type: 'string' }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
    customApis: [{ uniqueName: 'contoso_Calc' }],
    duplicateDetectionRules: [{ key: 'email', name: 'Contacts with same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }],
  };
  // Made by somebody else, outside the solution.
  const outside = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('config-outside-')), instanceUrl: h.org.origin, httpClient: createAzHttpClient(h.org.origin, { getToken: () => 'test-token-0123456789abcdef', request: h.org.request, sleep: async () => {} }) });
  await outside.initWorkspace();
  await h.run(s, { sdk: outside, creates: undefined });
  assert.deepEqual(h.org.rows('solutioncomponents'), []);
  const reused = await h.run(s, { solutionUniqueName: 'ContosoSol', creates: undefined });
  assert.deepEqual(reused.result.refused, []);
  assert.deepEqual(reused.result.unknown, []);
  // Four roots, then the rule's condition: a reused rule exports whole only when its conditions are members too.
  assert.deepEqual(reused.writes, ['POST /AddSolutionComponent', 'POST /AddSolutionComponent', 'POST /AddSolutionComponent', 'POST /AddSolutionComponent', 'POST /AddSolutionComponent']);
  const members = new Set(h.org.rows('solutioncomponents').map((m) => `${m.componenttype}:${m.objectid}`));
  assert.ok(members.has(`380:${h.org.rows('environmentvariabledefinitions')[0].environmentvariabledefinitionid}`));
  assert.ok(members.has(`10132:${h.org.rows('connectionreferences')[0].connectionreferenceid}`));
  assert.ok(members.has(`10133:${h.org.rows('customapis')[0].customapiid}`));
  assert.ok(members.has(`44:${h.org.rows('duplicaterules')[0].duplicateruleid}`));
  assert.ok(members.has(`45:${h.org.rows('duplicateruleconditions')[0].duplicateruleconditionid}`));
  // Once in, a rebuild reads the membership and sends nothing.
  assert.deepEqual((await h.run(s, { solutionUniqueName: 'ContosoSol', creates: undefined })).writes, []);
  assert.deepEqual(h.org.unexpected, []);
});

test('a Custom API\'s parameters and a rule\'s conditions are proven solution members, added when a create left them out; a value never is', async () => {
  const bindings = C.readDeploymentBindings(settings('https://v1.contoso.com', 'conn-1'), spec());
  const adds = (requests) => requests.filter((r) => r.method === 'POST' && r.path === '/AddSolutionComponent').map((r) => r.body.ComponentType).sort((a, b) => a - b);
  for (const childrenJoin of [false, true]) {
    const h = await harness({ childrenJoin });
    const first = await h.run(spec(), { bindings, solutionUniqueName: 'ContosoSol' });
    assert.deepEqual(first.result.refused, [], String(childrenJoin));
    assert.deepEqual(first.result.unknown, [], String(childrenJoin));
    // The roots ride in on their create header; each child the create left out is added, and none that it put in.
    assert.deepEqual(adds(first.requests), childrenJoin ? [] : [45, 10134, 10134, 10135]);
    const members = new Set(h.org.rows('solutioncomponents').map((m) => `${m.componenttype}:${m.objectid}`));
    for (const p of h.org.rows('customapirequestparameters')) assert.ok(members.has(`10134:${p.customapirequestparameterid}`), p.uniquename);
    for (const p of h.org.rows('customapiresponseproperties')) assert.ok(members.has(`10135:${p.customapiresponsepropertyid}`), p.uniquename);
    for (const c of h.org.rows('duplicateruleconditions')) assert.ok(members.has(`45:${c.duplicateruleconditionid}`));
    // A value is this environment's data: never a member, under any type.
    const value = h.org.rows('environmentvariablevalues')[0].environmentvariablevalueid;
    assert.ok(!h.org.rows('solutioncomponents').some((m) => m.componenttype === 381 || m.objectid === value));
    const again = await h.run(spec(), { bindings, solutionUniqueName: 'ContosoSol' });
    assert.deepEqual(again.writes, []);
    assert.deepEqual(again.result.unknown, []);
    assert.deepEqual(h.org.unexpected, []);
  }
  // A condition the platform refuses to add is not a member: that line is refused, and nothing else claims it.
  const refusing = await harness({ intercept: ({ method, path, body }) => (method === 'POST' && path === '/AddSolutionComponent' && body && body.ComponentType === 45
    ? { statusCode: 400, body: { error: { code: '0x80040203', message: 'Invalid component' } } } : undefined) });
  const refused = await refusing.run(spec(), { bindings, solutionUniqueName: 'ContosoSol' });
  assert.deepEqual([...refused.result.refused, ...refused.result.unknown].map((x) => [x.kind, x.key, x.unit]), [['duplicateRuleCondition', 'email|e', 'membership']]);
  // An add the platform answers and does not make is no proof: the fresh read finds the condition missing.
  const silent = await harness({ intercept: ({ method, path, body }) => (method === 'POST' && path === '/AddSolutionComponent' && body && body.ComponentType === 45
    ? { statusCode: 200, body: { id: '00000000-0000-0000-0000-000000000045' } } : undefined) });
  const unproven = await silent.run(spec(), { bindings, solutionUniqueName: 'ContosoSol' });
  const condition = silent.org.rows('duplicateruleconditions')[0].duplicateruleconditionid;
  assert.deepEqual(unproven.result.unknown.map((x) => [x.kind, x.key, x.id, x.code, x.unit]), [['duplicateRuleCondition', 'email|e', condition, 'SOLUTION_MEMBERSHIP_UNKNOWN', 'membership']]);
});

test('solution version: omitted costs nothing, equal costs one read and sends nothing, a managed solution is refused', async () => {
  const h = await harness();
  const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' } };
  const omitted = await h.run(s);
  assert.deepEqual(omitted.requests, []);
  const equal = await h.run({ ...s, solution: { ...s.solution, version: '1.0.0.0' } });
  assert.deepEqual(equal.writes, []);
  assert.equal(equal.requests.length, 1);
  assert.deepEqual(equal.result.unchanged.map((u) => u.kind), ['solutionVersion']);
  const managed = await harness({ solution: { uniqueName: 'ContosoSol', version: '1.0.0.0', prefix: 'contoso', managed: true } });
  const refused = await managed.run({ ...s, solution: { ...s.solution, version: '2.0.0.0' } });
  assert.deepEqual(refused.result.refused.map((r) => [r.kind, r.key, r.code]), [['solutionVersion', 'ContosoSol', 'SOLUTION_MANAGED']]);
  assert.deepEqual(refused.writes, []);
  const absent = await h.run({ ...s, solution: { uniqueName: 'OtherSol', publisherPrefix: 'contoso', version: '2.0.0.0' } });
  assert.deepEqual(absent.result.refused.map((r) => [r.kind, r.key, r.code]), [['solutionVersion', 'OtherSol', 'SOLUTION_NOT_FOUND']]);
});

test('verify after a build: definitions and bindings match; an unregistered Custom API is reported unproven', async () => {
  const h = await harness();
  const s = spec();
  const bindings = C.readDeploymentBindings(settings('https://v1.contoso.com', 'conn-1'), s);
  await h.run(s, { bindings });
  const mark = h.org.requests.length;
  const checks = await C.verifyConfiguration(s, { sdk: h.sdk, bindings });
  assert.deepEqual(checks.filter((c) => !c.ok), [{ kind: 'customApi', key: 'contoso_Calc', name: 'implementation', ok: false, code: 'CUSTOM_API_IMPLEMENTATION_UNPROVEN' }]);
  assert.equal(checks.filter((c) => c.name === 'binding').length, 2);
  assert.deepEqual(h.org.writes(mark), []);
});

// The build's wiring, exactly as the integration contract writes it: the ctx comes from configurationContext with the
// normalized `--authorize` Set, and the halt is what the build turns into a BuildHalt.
test('build wiring: one step per phase; authority is the normalized token Set; an unregistered API blocks pages, not the step', async () => {
  const h = await harness();
  const wire = (tokens = []) => C.configurationContext({
    sdk: h.sdk,
    creates: h.creates,
    solutionUniqueName: 'ContosoSol',
    authorizedDestructive: C.configurationAuthorizationKeys(tokens, spec()).keys,
  });
  const s = spec();
  const first = await C.runConfigurationStep(s, wire(), 'data-model');
  assert.equal(first.halt, null);
  assert.deepEqual(first.blocking.map((b) => [b.key, b.code]), [['contoso_sp', 'CONNECTION_REFERENCE_UNBOUND'], ['contoso_Calc', 'CUSTOM_API_IMPLEMENTATION_UNPROVEN']]);
  assert.equal((await C.runConfigurationStep(s, wire(), 'solution')).halt, null);
  assert.equal(h.org.rows('solutions')[0].version, '1.2.0.0');

  const edited = spec();
  edited.customApis[0].requestParameters = [{ uniqueName: 'A', type: 'integer' }];
  const mark = h.org.requests.length;
  const refused = await C.runConfigurationStep(edited, wire(['customApi:contoso_Calc:request:A']), 'data-model');
  assert.deepEqual(refused.halt, {
    phase: 'data-model', code: 'configuration-incomplete', retry: 'never',
    message: '1 configuration item not completed: customApi contoso_Calc (DESTRUCTIVE_CHANGE_UNAUTHORIZED)',
    items: [{ kind: 'customApi', key: 'contoso_Calc', code: 'DESTRUCTIVE_CHANGE_UNAUTHORIZED' }],
  });
  assert.deepEqual(h.org.writes(mark), []);
  assert.deepEqual(C.configurationDestructive(refused.plan), ['customApi:contoso_calc:request:b']);
  const removed = await C.runConfigurationStep(edited, wire(['customApi:CONTOSO_CALC:Request:B']), 'data-model');
  assert.equal(removed.halt, null);
  assert.deepEqual(h.org.rows('customapirequestparameters').map((p) => p.uniquename), ['A']);

  // A pages-only build reads the rows and blocks on what is not there, with no write.
  const more = { ...spec(), connectionReferences: [...spec().connectionReferences, { logicalName: 'contoso_sql', connectorId: SQL }] };
  const before = h.org.requests.length;
  assert.deepEqual((await C.configurationBlocking(more, wire())).map((b) => [b.key, b.code]), [
    ['contoso_sp', 'CONNECTION_REFERENCE_UNBOUND'], ['contoso_sql', 'CONFIGURATION_DEFINITION_MISSING'], ['contoso_Calc', 'CUSTOM_API_IMPLEMENTATION_UNPROVEN'],
  ]);
  assert.deepEqual(h.org.writes(before), []);
  const none = h.org.requests.length;
  assert.deepEqual(await C.configurationBlocking({ minimumPluginVersion: '2.21.0', app: { name: 'x' } }, wire()), []);
  assert.equal(h.org.requests.length, none, 'a spec without configuration reads nothing');
  assert.deepEqual(h.org.unexpected, []);
});

test('build wiring: an unknown outcome is never retried by a whole-build retry', async () => {
  const h = await harness({ lose: ({ method, path }) => method === 'POST' && path.startsWith('/connectionreferences') });
  const ctx = C.configurationContext({ sdk: h.sdk, creates: h.creates, solutionUniqueName: 'ContosoSol' });
  const step = await C.runConfigurationStep(referenceOnly(), ctx, 'data-model');
  assert.equal(step.halt.retry, 'never');
  assert.deepEqual(step.halt.items, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'create-outcome-unknown' }]);
});

test('send-once scope: inside a configuration write every mutating request, a $batch included, is sent once; a read and everything outside keep their retry', async () => {
  assert.equal(configurationSendOnce('POST', '/$batch'), false);
  await withConfigurationWrite(async () => {
    for (const method of ['POST', 'patch', 'PUT', 'DELETE']) assert.equal(configurationSendOnce(method, '/anything'), true, method);
    assert.equal(configurationSendOnce('GET', '/customapis'), false);
    await withConfigurationWrite(async () => assert.equal(inConfigurationWrite(), true));
    assert.equal(inConfigurationWrite(), true, 'a nested scope does not close the outer one');
  });
  await assert.rejects(withConfigurationWrite(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(inConfigurationWrite(), false, 'the scope closes when the work throws');
  // Two writes side by side do not share a scope.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const beside = (async () => { await gate; return inConfigurationWrite(); })();
  await withConfigurationWrite(async () => { release(); await Promise.resolve(); });
  assert.equal(await beside, false);

  // Through the real client: a 503 to a PATCH is sent once inside the scope and retried outside it; a raw $batch
  // inside the scope is sent once too.
  let sends = 0;
  const request = async () => { sends += 1; return { statusCode: 503, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"0x80040216","message":"x"}}' }; };
  const client = createAzHttpClient('https://contoso.crm.dynamics.com', { getToken: () => 'test-token-0123456789abcdef', request, sleep: async () => {}, sendOnce: configurationSendOnce });
  const batch = () => client.postRaw('https://contoso.crm.dynamics.com/api/data/v9.2/$batch', '--b\r\n--b--', { headers: { 'Content-Type': 'multipart/mixed; boundary=b' } }).catch((e) => e);
  await withConfigurationWrite(batch);
  assert.equal(sends, 1);
  sends = 0;
  await withConfigurationWrite(() => client.get('https://contoso.crm.dynamics.com/api/data/v9.2/customapis').catch((e) => e));
  assert.ok(sends > 1, 'a read inside the scope keeps its retry');
  const patch = () => client.patch('https://contoso.crm.dynamics.com/api/data/v9.2/connectionreferences(00000000-0000-0000-0000-000000000001)', { description: 'x' }).catch((e) => e);
  sends = 0;
  await withConfigurationWrite(patch);
  assert.equal(sends, 1);
  sends = 0;
  await patch();
  assert.ok(sends > 1, 'outside the scope nothing changes');
});

const pageUsing = (key, { references = [], apis = [] }) => ({ key, connectorBindings: references.map((logicalName) => ({ logicalName })), actionBindings: apis.map((name) => ({ name })) });

test('build runtime: what a step confirmed is recorded before it halts, a record that cannot be kept is incomplete, and no halt is ever retried', async () => {
  const h = await harness({ lose: ({ method, path }) => method === 'POST' && path.startsWith('/connectionreferences') });
  const s = {
    minimumPluginVersion: '2.21.0',
    solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' },
    environmentVariables: [{ schemaName: 'contoso_Mode', type: 'string', defaultValue: 'a' }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
  };
  const recorded = [];
  const managed = { recordApplied: async (rec) => { recorded.push(rec); } };
  const runtime = createConfigurationRuntime({ spec: s, sdk: h.sdk, opts: { creates: h.creates, managed }, appUniqueName: 'contoso_app' });
  const step = await runtime.apply('data-model');
  assert.deepEqual(recorded.map((r) => [r.kind, r.key, r.id, r.origin, r.appUniqueName]), [
    ['environmentVariable', 'contoso_mode', h.creates.idOf('environmentVariable', 'contoso_mode'), 'created', 'contoso_app'],
  ]);
  assert.match(recorded[0].intentSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(step.halt.items, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'create-outcome-unknown' }]);
  assert.throws(() => runtime.throwIfIncomplete(step), (e) => e.name === 'BuildHalt' && e.retry === 'never' && e.phase === 'data-model' && e.code === 'configuration-incomplete');
  assert.doesNotThrow(() => runtime.throwIfIncomplete({ halt: null }));

  // The recorder fails: the create stands (it is not repeated), and the step is incomplete for it.
  const k = await harness();
  const failing = { recordApplied: async () => { throw new Error('store unavailable'); } };
  const one = { ...s, connectionReferences: undefined };
  const first = await createConfigurationRuntime({ spec: one, sdk: k.sdk, opts: { creates: k.creates, managed: failing } }).apply('data-model');
  assert.deepEqual(first.outcome.unknown.map((u) => [u.kind, u.key, u.code, u.unit]), [['environmentVariable', 'contoso_mode', 'CONFIGURATION_RECORD_UNCONFIRMED', 'management']]);
  assert.deepEqual(first.halt.items, [{ kind: 'environmentVariable', key: 'contoso_mode', code: 'CONFIGURATION_RECORD_UNCONFIRMED' }]);
  assert.equal(first.halt.retry, 'never');
  // The next build finds the row at its id and creates nothing twice; with no record of it and no adoption policy
  // to decide on it, its management is still not confirmed.
  const again = await createConfigurationRuntime({ spec: one, sdk: k.sdk, opts: { creates: k.creates, managed: failing } }).apply('data-model');
  assert.deepEqual(again.halt && again.halt.items, [{ kind: 'environmentVariable', key: 'contoso_mode', code: 'CONFIGURATION_RECORD_UNCONFIRMED' }]);
  assert.deepEqual(again.outcome.unchanged.map((x) => x.key), ['contoso_Mode']);
  assert.equal(k.org.rows('environmentvariabledefinitions').length, 1, 'the next build finds it at its id; nothing is created twice');
  // The common adoption policy decides a found row with no record: allowed, it is recorded as adopted and the step completes.
  const kept = [];
  const adopting = { lookup: async () => null, planAdoption: async () => ({ allowed: true }), recordApplied: async (rec) => { kept.push(rec); } };
  const adopted = await createConfigurationRuntime({ spec: one, sdk: k.sdk, opts: { creates: k.creates, managed: adopting } }).apply('data-model');
  assert.equal(adopted.halt, null);
  assert.deepEqual(kept.map((r) => [r.kind, r.key, r.id, r.origin]), [['environmentVariable', 'contoso_mode', k.creates.idOf('environmentVariable', 'contoso_mode'), 'adopted']]);
  const refusing = { lookup: async () => null, planAdoption: async () => ({ allowed: false, code: 'ADOPTION_NOT_OWNED' }), recordApplied: async () => {} };
  const refused = await createConfigurationRuntime({ spec: one, sdk: k.sdk, opts: { creates: k.creates, managed: refusing } }).apply('data-model');
  assert.deepEqual(refused.halt && refused.halt.items, [{ kind: 'environmentVariable', key: 'contoso_Mode', code: 'ADOPTION_NOT_OWNED' }]);
});

test('build runtime: a child is recorded when it is created, under a root this run created or one it found, and a child record that fails is incomplete', async () => {
  const s = (params) => ({ minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, customApis: [{ uniqueName: 'contoso_Api', requestParameters: params }] });
  // A recorder that keeps roots and refuses children.
  const h = await harness();
  const kept = [];
  const childless = { recordApplied: async (rec) => { if (rec.parentKey) throw new Error('store unavailable'); kept.push(rec); } };
  const first = await createConfigurationRuntime({ spec: s([{ uniqueName: 'a', type: 'string' }]), sdk: h.sdk, opts: { creates: h.creates, managed: childless } }).apply('data-model');
  assert.deepEqual(kept.map((r) => [r.kind, r.key]), [['customApi', 'contoso_api']]);
  assert.deepEqual(first.outcome.unknown.map((u) => [u.kind, u.key, u.id, u.code, u.unit]), [
    ['customApiRequestParameter', 'contoso_api|request:a', h.creates.childIdOf('contoso_api', 'request:a'), 'CONFIGURATION_RECORD_UNCONFIRMED', 'management'],
  ]);
  assert.deepEqual(first.halt && first.halt.items, [{ kind: 'customApiRequestParameter', key: 'contoso_api|request:a', code: 'CONFIGURATION_RECORD_UNCONFIRMED' }]);
  // A parameter added to the API a later build finds (its root record is there): the new child is recorded as created.
  const recorded = [];
  const k = await harness();
  const store = new Map();
  const managed = {
    lookup: async (kind, key) => store.get(`${kind}:${String(key).toLowerCase()}`) || null,
    recordApplied: async (rec) => { recorded.push(rec); if (!rec.parentKey) store.set(`${rec.kind}:${rec.key}`, { id: rec.id }); },
  };
  await createConfigurationRuntime({ spec: s([{ uniqueName: 'a', type: 'string' }]), sdk: k.sdk, opts: { creates: k.creates, managed } }).apply('data-model');
  recorded.length = 0;
  const added = await createConfigurationRuntime({ spec: s([{ uniqueName: 'a', type: 'string' }, { uniqueName: 'b', type: 'string' }]), sdk: k.sdk, opts: { creates: k.creates, managed } }).apply('data-model');
  assert.equal(added.halt, null);
  assert.equal(k.org.rows('customapirequestparameters').length, 2);
  const b = k.org.rows('customapirequestparameters').find((r) => r.uniquename === 'b').customapirequestparameterid;
  assert.deepEqual(recorded.map((r) => [r.kind, r.key, r.id, r.parentKey, r.origin]), [['customApiRequestParameter', 'contoso_api|request:b', b, 'contoso_api', 'created']]);
});

test('build runtime: two declarations of one item stop the build before anything is read or written', async () => {
  const h = await harness();
  const mark = h.org.requests.length;
  const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }, { logicalName: 'CONTOSO_SP', connectorId: SP }] };
  assert.throws(() => createConfigurationRuntime({ spec: s, sdk: h.sdk, opts: {} }), (e) => e.name === 'BuildHalt' && e.code === 'configuration-intent-invalid' && e.phase === 'preflight' && e.retry === 'never');
  assert.equal(h.org.requests.length, mark);
});

test('build runtime, pages only: a page is gated on the rows read now, never on the settings, and the read writes nothing', async () => {
  const h = await harness();
  await h.run(referenceOnly());
  const bindings = C.readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-1' }] }, referenceOnly());
  const runtime = createConfigurationRuntime({ spec: referenceOnly(), sdk: h.sdk, opts: { creates: h.creates, configurationBindings: bindings, connections: async () => [{ connectionId: 'conn-1', connectorId: SP }] } });
  const mark = h.org.requests.length;
  await assert.rejects(runtime.beforePages([pageUsing('orders', { references: ['contoso_sp'] })]), (e) => e.name === 'BuildHalt' && e.code === 'configuration-prerequisite-not-applied' && e.retry === 'never'
    && /page "orders"/.test(e.message) && /CONNECTION_REFERENCE_UNBOUND/.test(e.message) && /did not apply configuration/.test(e.message));
  assert.deepEqual(h.org.writes(mark), []);
  assert.ok(h.org.requests.slice(mark).every((r) => r.method === 'GET'));
  // A page that names nothing the step owns is not held up.
  assert.deepEqual((await runtime.beforePages([pageUsing('home', {})])).blockers, []);
  // Once the binding is really on the row, the same pages-only gate lets the page through.
  h.org.rows('connectionreferences')[0].connectionid = 'conn-1';
  const fresh = createConfigurationRuntime({ spec: referenceOnly(), sdk: h.sdk, opts: { creates: h.creates, configurationBindings: bindings, connections: async () => [{ connectionId: 'conn-1', connectorId: SP }] } });
  assert.deepEqual((await fresh.beforePages([pageUsing('orders', { references: ['contoso_sp'] })])).blockers, []);
});

test('build runtime: a connection of another connector is not a binding, so the page that uses the reference is held', async () => {
  const h = await harness();
  const inventory = async () => [{ connectionId: 'conn-sql', connectorId: SQL }, { connectionId: 'conn-sp', connectorId: SP }];
  // The settings name the declared connector, and the connection they pick is a SQL one: the row would join the two.
  const bindings = C.readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-sql', ConnectorId: SP }] }, referenceOnly());
  const runtime = createConfigurationRuntime({ spec: referenceOnly(), sdk: h.sdk, opts: { creates: h.creates, configurationBindings: bindings, connections: inventory } });
  const step = await runtime.apply('data-model');
  assert.deepEqual(step.blocking.map((b) => [b.key, b.code]), [['contoso_sp', 'CONNECTION_REFERENCE_UNBOUND']]);
  await assert.rejects(runtime.beforePages([pageUsing('orders', { references: ['contoso_sp'] })]), (e) => e.code === 'configuration-prerequisite-not-applied' && /CONNECTION_REFERENCE_UNBOUND/.test(e.message));
  // A pages-only run reads the row now and holds the page the same way.
  const pagesOnly = createConfigurationRuntime({ spec: referenceOnly(), sdk: h.sdk, opts: { creates: h.creates, configurationBindings: bindings, connections: inventory } });
  await assert.rejects(pagesOnly.beforePages([pageUsing('orders', { references: ['contoso_sp'] })]), (e) => e.code === 'configuration-prerequisite-not-applied' && /CONNECTION_REFERENCE_UNBOUND/.test(e.message));
  // A connection of the declared connector is a binding; an inventory row that does not say its connector proves nothing.
  h.org.rows('connectionreferences')[0].connectionid = 'conn-sp';
  const bound = createConfigurationRuntime({ spec: referenceOnly(), sdk: h.sdk, opts: { creates: h.creates, configurationBindings: bindings, connections: inventory } });
  assert.deepEqual((await bound.beforePages([pageUsing('orders', { references: ['contoso_sp'] })])).blockers, []);
  const unsaid = createConfigurationRuntime({ spec: referenceOnly(), sdk: h.sdk, opts: { creates: h.creates, configurationBindings: bindings, connections: async () => [{ connectionId: 'conn-sp' }] } });
  await assert.rejects(unsaid.beforePages([pageUsing('orders', { references: ['contoso_sp'] })]), (e) => /CONNECTION_REFERENCE_BINDING_UNVERIFIED/.test(e.message));
  assert.deepEqual(h.org.unexpected, []);
});

test('build runtime: a connection the settings ask for that is not proven bound stops the build, with or without a page that uses it', async () => {
  const h = await harness();
  const ask = (connectionId) => C.readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: connectionId }] }, referenceOnly());
  const step = (opts) => createConfigurationRuntime({ spec: referenceOnly(), sdk: h.sdk, opts: { creates: h.creates, ...opts } }).apply('data-model');
  const inaccessible = await step({ configurationBindings: ask('inaccessible'), connections: async () => [] });
  assert.deepEqual(inaccessible.outcome.saved.map((x) => x.key), ['contoso_sp']);
  assert.deepEqual(inaccessible.halt && inaccessible.halt.items, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'CONNECTION_REFERENCE_UNBOUND' }]);
  assert.equal(inaccessible.halt.retry, 'never');
  // No inventory to prove it against: the binding asked for is not proven either.
  const unproven = await step({ configurationBindings: ask('inaccessible') });
  assert.deepEqual(unproven.halt && unproven.halt.items, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'CONNECTION_REFERENCE_BINDING_UNVERIFIED' }]);
  // Proven bound: complete.
  const proven = await step({ configurationBindings: ask('inaccessible'), connections: async () => [{ connectionId: 'inaccessible', connectorId: SP }] });
  assert.equal(proven.halt, null);
  // What the settings do not ask to bind is a scaffold, and an authorized unbind is what was asked for: neither stops the build.
  const k = await harness();
  const scaffold = await createConfigurationRuntime({ spec: referenceOnly(), sdk: k.sdk, opts: { creates: k.creates, connections: async () => [] } }).apply('data-model');
  assert.equal(scaffold.halt, null);
  assert.deepEqual(scaffold.blocking.map((b) => [b.key, b.code]), [['contoso_sp', 'CONNECTION_REFERENCE_UNBOUND']]);
  const unbind = await step({ configurationBindings: ask(null), authorizedDestructive: allow('connectionReference:contoso_sp:connectionId'), connections: async () => [] });
  assert.deepEqual(unbind.outcome.saved.map((x) => [x.key, x.action]), [['contoso_sp', 'update']]);
  assert.equal(unbind.halt, null);
  assert.deepEqual(h.org.unexpected, []);
});

test('build runtime: a Custom API without an implementation blocks the page that calls it; a definition no page calls is a scaffold, not a failure', async () => {
  const h = await harness();
  const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, customApis: [{ uniqueName: 'contoso_Calc' }] };
  const runtime = createConfigurationRuntime({ spec: s, sdk: h.sdk, opts: { creates: h.creates } });
  const step = await runtime.apply('data-model');
  assert.equal(step.halt, null);
  assert.deepEqual(step.blocking.map((b) => [b.key, b.code]), [['contoso_Calc', 'CUSTOM_API_IMPLEMENTATION_UNPROVEN']]);
  const mark = h.org.requests.length;
  await assert.rejects(runtime.beforePages([pageUsing('calc', { apis: ['CONTOSO_CALC'] })]), (e) => e.code === 'configuration-prerequisite-not-applied' && /CUSTOM_API_IMPLEMENTATION_UNPROVEN/.test(e.message) && /did not leave it usable/.test(e.message));
  assert.equal(h.org.requests.length, mark, 'the step\'s own read is used: nothing is read again');
  assert.deepEqual((await runtime.beforePages([pageUsing('home', {})])).blockers, []);
  await assert.rejects(runtime.apply('pages'), TypeError);
});

test('a child is one id whichever way it is made, by its root\'s create or added by a later run; under another parent it is another id', async () => {
  const full = () => ({ minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' },
    customApis: [{ uniqueName: 'contoso_Api', requestParameters: [{ uniqueName: 'A', type: 'string' }, { uniqueName: 'B', type: 'string' }] }],
    duplicateDetectionRules: [{ key: 'email', name: 'Contacts with same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }, { key: 'l', column: 'lastname', match: 'exact' }] }] });
  const bare = () => { const s = full(); s.customApis[0].requestParameters.pop(); s.duplicateDetectionRules[0].conditions.pop(); return s; };
  const idsOf = (org) => ({
    api: org.rows('customapis')[0].customapiid,
    b: org.rows('customapirequestparameters').find((p) => p.uniquename === 'B').customapirequestparameterid,
    l: org.rows('duplicateruleconditions').find((c) => c.baseattributename === 'lastname').duplicateruleconditionid,
  });
  // B and l made by the creates of their roots.
  const h = await harness();
  assert.deepEqual((await h.run(full())).result.unknown, []);
  const composite = idsOf(h.org);
  // The same B and l added by a later run to roots a first run created without them.
  const k = await harness();
  await k.run(bare());
  const later = await k.run(full());
  assert.deepEqual([later.result.refused, later.result.unknown], [[], []]);
  assert.ok(k.creates.calls.some((c) => c.op === 'run' && c.kind === 'customApiRequestParameter' && c.identity.parentId === composite.api), 'B was its own create, under its parent');
  assert.deepEqual(idsOf(k.org), composite);
  assert.equal(composite.b, h.creates.idOf('customApiRequestParameter', 'contoso_api|request:b'));
  assert.equal(composite.b, h.creates.childIdUnder(composite.api, 'customApiRequestParameter', 'request:b'));
  // A root bound to another id: every child of it derives from that id.
  const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const b = await harness({ port: { bound: { 'customApi|contoso_api': other } } });
  await b.run(full());
  const under = idsOf(b.org);
  assert.equal(under.api, other);
  assert.notEqual(under.b, composite.b);
  assert.equal(under.b, b.creates.childIdUnder(other, 'customApiRequestParameter', 'request:b'));
  assert.equal(under.l, composite.l, 'the rule is not bound, so its children keep their ids');
});

test('a child added under a parent at another id than its planned one is refused by the stable port, and nothing is sent', async () => {
  const s = () => ({ minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' },
    customApis: [{ uniqueName: 'contoso_Api', requestParameters: [{ uniqueName: 'A', type: 'string' }] }] });
  const h = await harness();
  // The API was made by a build without the stable port: a fresh id, not the one the port plans.
  await h.run(s(), { creates: undefined });
  const foreign = h.org.rows('customapis')[0].customapiid;
  assert.notEqual(foreign, h.creates.idOf('customApi', 'contoso_api'));
  const managed = { lookup: async (kind) => (kind === 'customApi' ? { id: foreign } : null) };
  const edited = s();
  edited.customApis[0].requestParameters.push({ uniqueName: 'B', type: 'string' });
  const run = await h.run(edited, { managed });
  assert.deepEqual(h.creates.calls.filter((c) => c.op === 'refuse').map((c) => [c.kind, c.key]), [['customApiRequestParameter', 'contoso_api|request:b']]);
  assert.deepEqual(run.writes.filter((w) => w.includes('customapirequestparameters')), []);
  assert.deepEqual(run.result.saved, []);
  assert.deepEqual([...run.result.refused, ...run.result.unknown].map((x) => [x.kind, x.key, x.code]), [['customApi', 'contoso_Api', 'create-identity-conflict']]);
});

test('a kind the create port does not protect keeps the plain name lookup: a row made without the port is the same artifact, not a conflict', async () => {
  const s = { minimumPluginVersion: '2.21.0', solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] };
  const open = await harness({ port: { protectedKinds: ['environmentVariable', 'customApi', 'duplicateRule'] } });
  await open.run(s, { creates: undefined });
  const again = await open.run(s);
  assert.deepEqual([again.result.refused, again.result.unknown, again.writes], [[], [], []]);
  assert.deepEqual(again.result.unchanged.map((x) => [x.kind, x.key]), [['connectionReference', 'contoso_sp']]);
  assert.ok(!open.creates.calls.some((c) => c.op === 'resolve'), 'no stable read for an unprotected kind');
  // Protected, the same row at another id than the planned one is refused, as before.
  const shut = await harness();
  await shut.run(s, { creates: undefined });
  const refused = await shut.run(s);
  assert.deepEqual(refused.result.refused.map((r) => [r.kind, r.code]), [['connectionReference', 'create-identity-conflict']]);
  assert.deepEqual(refused.writes, []);
});
