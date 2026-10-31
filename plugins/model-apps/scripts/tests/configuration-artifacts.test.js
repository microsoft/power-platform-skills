'use strict';

// Unit tests for lib/configuration-artifacts.js: validation, deployment-settings bindings, failure
// classification and the plan/apply decisions, against a recording stub of the maker SDK. The wire
// itself (what the real SDK bundle sends for each decision) is covered by
// configuration-artifacts-real-bundle.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/configuration-artifacts.js');

const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const VAULT_REF = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg1/providers/Microsoft.KeyVault/vaults/contosovault/secrets/apikey';

// Every ctx below names `fence: null`: these tests drive the helper over stub SDKs, on the plain pass-through, which is
// also what a ctx without `fence` gets (the plugin loads no stable-id module). The helper's consuming side of a stable
// port is exercised with test-local doubles (tests/helpers/stable-create-port.js) in the real-bundle file.
const base = (extra = {}) => ({
  minimumPluginVersion: '2.21.0',
  solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' },
  ...extra,
});
const errorsOf = (spec, options) => C.validateConfiguration(spec, options).errors;
const hasError = (spec, pattern, options) => assert.ok(errorsOf(spec, options).some((e) => pattern.test(e)), `expected an error matching ${pattern}: ${JSON.stringify(errorsOf(spec, options))}`);

// A recording stub of the maker SDK surface the helper uses. `remotes` maps `kind:name` to a remote artifact.
// A create or an element update lands in the stub's rows, so the helper's read-back after a write sees it.
function stubSdk({ remotes = {}, get = {}, solution, fail = {} } = {}) {
  const calls = [];
  const byId = new Map();
  for (const [k, remote] of Object.entries(remotes)) byId.set(remote.id, { k, remote });
  const sdk = {
    calls,
    async findArtifact(kind, identity) {
      calls.push(['findArtifact', kind, identity]);
      if (fail.findArtifact) throw fail.findArtifact;
      const remote = remotes[`${kind}:${(identity.uniqueName || identity.name).toLowerCase()}`];
      return remote ? remote.id : null;
    },
    async fetchArtifact(kind, id, options) {
      calls.push(['fetchArtifact', kind, id, options]);
      const hit = byId.get(id);
      if (!hit) throw Object.assign(new Error('gone'), { code: 'ARTIFACT_NOT_FOUND' });
      return structuredClone(hit.remote);
    },
    async createArtifact(kind, artifact) {
      calls.push(['createArtifact', kind, artifact]);
      byId.set(artifact.id, { k: kind, remote: structuredClone(artifact) });
    },
    async pushArtifact(kind, id) {
      calls.push(['pushArtifact', kind, id]);
      if (fail.pushArtifact) throw fail.pushArtifact;
      return kind === 'duplicateRule' ? { publish: { kind: 'verified' } } : {};
    },
    async updateElement(kind, id, pointer, value) {
      calls.push(['updateElement', kind, id, pointer, value]);
      const hit = byId.get(id);
      if (hit) hit.remote = { ...hit.remote, [pointer.slice(1)]: value === undefined ? undefined : structuredClone(value) };
    },
    async getSolution(name) {
      calls.push(['getSolution', name]);
      if (fail.getSolution) throw fail.getSolution;
      return solution;
    },
    async setSolutionVersion(id, version) {
      calls.push(['setSolutionVersion', id, version]);
      if (solution) solution = { ...solution, version };
    },
    dataverse: {
      async get(path) {
        calls.push(['get', path]);
        const hit = Object.entries(get).find(([prefix]) => path.startsWith(prefix));
        if (!hit) throw Object.assign(new Error('unexpected read'), { code: 'CONNECTION_ERROR', statusCode: 500 });
        return { body: hit[1] };
      },
    },
  };
  return sdk;
}

// A pass-through create port: mints ids and runs execute once.
function passPort() {
  let n = 0;
  const mint = () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  return {
    calls: [],
    async run(request, execute) {
      this.calls.push(request);
      const childIds = Object.fromEntries((request.childKeys || []).map((k) => [k, mint()]));
      const id = mint();
      return { outcome: 'created', id, childIds, result: await execute({ id, childIds }) };
    },
    pending: () => null,
  };
}

test('a spec without configuration fields validates, plans, applies and verifies with zero calls', async () => {
  const spec = { solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso' }, entities: [] };
  assert.equal(C.usesConfiguration(spec), false);
  assert.deepEqual(C.validateConfiguration(spec), { errors: [], warnings: [] });
  const sdk = stubSdk();
  const plan = await C.planConfiguration(spec, { fence: null, sdk });
  await C.planSolutionVersion(spec, { fence: null, sdk }, plan);
  assert.deepEqual(plan, { operations: [], unknown: [] });
  assert.deepEqual(await C.applyConfiguration(plan, { fence: null, sdk }), { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] });
  assert.deepEqual(await C.verifyConfiguration(spec, { fence: null, sdk }), []);
  assert.deepEqual(sdk.calls, []);
});

test('the capability floor warns until minimumPluginVersion is 2.21.0 or newer', () => {
  const spec = base({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] });
  assert.deepEqual(C.validateConfiguration(spec).warnings, []);
  assert.match(C.validateConfiguration({ ...spec, minimumPluginVersion: '2.20.9' }).warnings[0], /minimumPluginVersion to '2\.21\.0'/);
  assert.match(C.validateConfiguration({ ...spec, minimumPluginVersion: undefined }).warnings[0], /minimumPluginVersion/);
  assert.deepEqual(C.validateConfiguration(spec).errors, []);
});

test('environment variables: names, closed keys and per-environment values', () => {
  hasError(base({ environmentVariables: [{ schemaName: 'other_X', type: 'string' }] }), /publisher prefix 'contoso_'/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'text' }] }), /type must be one of/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'string', color: 1 }] }), /'color' is not a supported property/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'string' }, { schemaName: 'CONTOSO_x', type: 'string' }] }), /declared more than once/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'string', value: 'v' }] }), /deployment settings \(EnvironmentVariables\)/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'string', currentValue: 'v' }] }), /does not carry a current value/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'number', defaultValue: '1e5' }] }), /defaultValue must be a decimal number/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'boolean', defaultValue: 'true' }] }), /'yes' or 'no'/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'json', defaultValue: '{' }] }), /valid JSON text/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'string', valueSchema: '{}' }] }), /valueSchema applies only to a json variable/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'string', connectorId: SP }] }), /connectorId applies only to a dataSource variable/);
  hasError(base({ environmentVariables: [{ schemaName: 'contoso_X', type: 'dataSource', connectorId: 'sharepoint' }] }), /connectorId must look like/);
  const valid = base({
    environmentVariables: [
      { schemaName: 'contoso_N', type: 'number', defaultValue: '-1.5', isRequired: true },
      { schemaName: 'contoso_B', type: 'boolean', defaultValue: 'no' },
      { schemaName: 'contoso_J', type: 'json', defaultValue: '{"a":1}', valueSchema: '{"type":"object"}' },
      { schemaName: 'contoso_Site', type: 'dataSource', connectorId: SP, parameterKey: 'dataset' },
      { schemaName: 'contoso_List', type: 'dataSource', connectorId: SP, parameterKey: 'table', parentSchemaName: 'contoso_Site' },
    ],
  });
  assert.deepEqual(errorsOf(valid), []);
});

test('a secret variable default is refused in a portable spec and must be a Key Vault reference otherwise, without echoing it', () => {
  const pasted = 'hunter2-not-a-reference';
  const spec = (defaultValue) => base({ environmentVariables: [{ schemaName: 'contoso_Key', type: 'secret', defaultValue }] });
  const portable = errorsOf(spec(VAULT_REF));
  assert.equal(portable.length, 1);
  assert.match(portable[0], /not allowed for a secret variable/);
  // No profile accepts a secret default, not even a Key Vault reference: the default lives in the definition row.
  const environment = errorsOf(spec(pasted), { profile: 'environment' });
  assert.match(environment[0], /not allowed for a secret variable/);
  assert.ok(!JSON.stringify([portable, environment]).includes(pasted));
  assert.ok(!JSON.stringify(portable).includes('contosovault'));
  assert.equal(errorsOf(spec(VAULT_REF), { profile: 'environment' }).length, 1);
  assert.deepEqual(errorsOf(base({ environmentVariables: [{ schemaName: 'contoso_Key', type: 'secret' }] })), []);
});

test('a data-source parent must be declared, be a data source, and the parent chain must end', () => {
  const ds = (schemaName, parentSchemaName, type = 'dataSource') => ({ schemaName, type, ...(type === 'dataSource' ? { connectorId: SP } : {}), ...(parentSchemaName ? { parentSchemaName } : {}) });
  hasError(base({ environmentVariables: [ds('contoso_List', 'contoso_Site')] }), /'contoso_Site' is not declared/);
  hasError(base({ environmentVariables: [ds('contoso_List', 'contoso_Site'), ds('contoso_Site', null, 'string')] }), /must be a dataSource variable/);
  hasError(base({ environmentVariables: [ds('contoso_A', 'contoso_B'), ds('contoso_B', 'contoso_A')] }), /parentSchemaName cycle/);
  hasError(base({ environmentVariables: [ds('contoso_A', 'contoso_A')] }), /parentSchemaName cycle/);
});

test('connection references: a connection is never authored in the spec', () => {
  hasError(base({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP, connectionId: 'abc' }] }), /bind it per environment in deployment settings/);
  hasError(base({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: 'shared_sharepointonline' }] }), /connectorId must look like/);
  hasError(base({ connectionReferences: [{ logicalName: 'sp', connectorId: SP }] }), /publisher prefix/);
  hasError(base({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP, customConnectorId: 'x' }] }), /customConnectorId must be a GUID/);
  hasError(base({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }, { logicalName: 'Contoso_SP', connectorId: SP }] }), /declared more than once/);
  assert.deepEqual(errorsOf(base({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP, name: 'SharePoint' }] })), []);
});

test('custom APIs: the contract only, with binding, function and parameter rules', () => {
  const api = (extra) => base({ customApis: [{ uniqueName: 'contoso_Calc', ...extra }] });
  hasError(api({ pluginTypeId: '00000000-0000-0000-0000-000000000001' }), /register its implementation separately/);
  hasError(api({ binding: 'entity' }), /boundEntityLogicalName is required for a entity binding/);
  hasError(api({ binding: 'global', boundEntityLogicalName: 'account' }), /applies only to an entity or entityCollection binding/);
  hasError(api({ isFunction: true, responseProperties: [] }), /needs at least one responseProperties entry/);
  // An omitted binding or response list is not managed: an existing bound function stays valid (checked at run time).
  assert.deepEqual(errorsOf(api({ boundEntityLogicalName: 'account' })), []);
  assert.deepEqual(errorsOf(api({ isFunction: true })), []);
  hasError(api({ allowedProcessingSteps: 'sync' }), /allowedProcessingSteps must be one of/);
  hasError(api({ requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'a', type: 'string' }] }), /'a' is declared more than once/);
  hasError(api({ requestParameters: [{ uniqueName: 'A', type: 'integer', entityLogicalName: 'account' }] }), /entityLogicalName applies only to entity/);
  hasError(api({ responseProperties: [{ uniqueName: 'R', type: 'string', isOptional: true }] }), /'isOptional' is not a supported property/);
  hasError(api({ requestParameters: [{ uniqueName: 'A' }] }), /type is required/);
  // The same unique name in the request and the response is fine: they are different tables.
  assert.deepEqual(errorsOf(api({ binding: 'entity', boundEntityLogicalName: 'account', isFunction: true,
    requestParameters: [{ uniqueName: 'Target', type: 'entityReference', entityLogicalName: 'account' }],
    responseProperties: [{ uniqueName: 'Target', type: 'string' }] })), []);
});

test('duplicate-detection rules: keys, counted matches, declared column types and the table switch', () => {
  const rule = (extra = {}, condition = {}) => ({ key: 'k', name: 'Rule', entity: 'contoso_item', conditions: [{ key: 'c', column: 'contoso_name', match: 'exact', ...condition }], ...extra });
  const entities = [{ schemaName: 'contoso_item', columns: [{ schemaName: 'contoso_when', type: 'DateTime' }] }];
  hasError(base({ duplicateDetectionRules: [rule({}, { match: 'firstCharacters' })] }), /characters must be a positive whole number/);
  hasError(base({ duplicateDetectionRules: [rule({}, { characters: 3 })] }), /characters applies only to firstCharacters or lastCharacters/);
  hasError(base({ entities, duplicateDetectionRules: [rule({}, { column: 'contoso_when', match: 'firstCharacters', characters: 2 })] }), /cannot compare column 'contoso_when' of type DateTime/);
  hasError(base({ duplicateDetectionRules: [rule(), rule({ key: 'k2' })] }), /name 'Rule' is declared more than once/);
  hasError(base({ duplicateDetectionRules: [rule(), rule({ name: 'Other' })] }), /key 'k' is declared more than once/);
  hasError(base({ duplicateDetectionRules: [rule({ conditions: [], status: 'published' })] }), /at least one condition/);
  // An empty list is valid for a rule whose effective status is unpublished, decided against the row at run time.
  assert.deepEqual(errorsOf(base({ duplicateDetectionRules: [rule({ conditions: [] })] })), []);
  hasError(base({ entities: [{ schemaName: 'contoso_item', duplicateDetectionEnabled: false }], duplicateDetectionRules: [rule({ status: 'published' })] }), /declares duplicateDetectionEnabled: false/);
  assert.deepEqual(errorsOf(base({ entities: [{ schemaName: 'contoso_item', duplicateDetectionEnabled: false }], duplicateDetectionRules: [rule({ status: 'unpublished' })] })), []);
  // A system column the spec does not declare is the platform's to judge.
  assert.deepEqual(errorsOf(base({ entities, duplicateDetectionRules: [rule({}, { column: 'createdon', match: 'firstCharacters', characters: 2 })] })), []);
  const six = Array.from({ length: 6 }, (_, i) => rule({ key: `k${i}`, name: `Rule ${i}`, status: 'published' }));
  // An omitted status is decided against the row at plan time, so only authored publications are counted here.
  assert.deepEqual(errorsOf(base({ duplicateDetectionRules: Array.from({ length: 6 }, (_, i) => rule({ key: `k${i}`, name: `Rule ${i}` })) })), []);
  hasError(base({ duplicateDetectionRules: six }), /6 published rules; Dataverse allows at most 5/);
  six[5].status = 'unpublished';
  assert.deepEqual(errorsOf(base({ duplicateDetectionRules: six })), []);
});

test('solution.version is four whole numbers, each a 32-bit signed integer', () => {
  for (const good of ['1.0.0.0', '2147483647.0.0.1']) assert.deepEqual(errorsOf(base({ solution: { uniqueName: 'S', publisherPrefix: 'contoso', version: good } })), [], good);
  for (const bad of ['1.0.0', '1.0.0.0.0', 'v1.0.0.0', '2147483648.0.0.0', 1, '']) {
    hasError(base({ solution: { uniqueName: 'S', publisherPrefix: 'contoso', version: bad } }), /solution\.version must be four whole numbers/);
  }
});

test('deployment settings: a string sets, null clears, an empty string or a missing entry leaves the environment alone', () => {
  const spec = base({
    environmentVariables: [{ schemaName: 'contoso_N', type: 'number' }, { schemaName: 'contoso_S', type: 'string' }, { schemaName: 'contoso_K', type: 'secret' }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }, { logicalName: 'contoso_sql', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sql' }],
  });
  const read = C.readDeploymentBindings({
    EnvironmentVariables: [{ SchemaName: 'contoso_N', Value: '42' }, { SchemaName: 'CONTOSO_S', Value: null }, { SchemaName: 'contoso_K', Value: '' }],
    ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-1', ConnectorId: SP }, { LogicalName: 'contoso_sql', ConnectionId: null }, { LogicalName: 'contoso_x' }],
  }, spec);
  assert.deepEqual(read.errors, []);
  assert.deepEqual([...read.environmentVariables], [['contoso_n', { value: '42' }], ['contoso_s', { value: null }]]);
  assert.deepEqual([...read.connectionReferences], [['contoso_sp', { connectionId: 'conn-1' }], ['contoso_sql', { connectionId: null }]]);
  assert.deepEqual(C.readDeploymentBindings(undefined, spec).errors, []);
  assert.deepEqual(C.readDeploymentBindings([], spec).errors, ['deployment settings must be a JSON object']);
});

test('deployment settings: a mistyped value, a pasted secret or a connection of another connector is refused without echoing it', () => {
  const spec = base({
    environmentVariables: [{ schemaName: 'contoso_N', type: 'number' }, { schemaName: 'contoso_K', type: 'secret' }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
  });
  const read = C.readDeploymentBindings({
    EnvironmentVariables: [{ SchemaName: 'contoso_N', Value: 'forty-two' }, { SchemaName: 'contoso_K', Value: 'p@ssw0rd-pasted' }, { SchemaName: 'contoso_N', Value: '1' }],
    ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-sql-1', ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_sql' }],
  }, spec);
  assert.equal(read.errors.length, 4);
  assert.match(read.errors[0], /\(contoso_N\) Value must be a decimal number/);
  assert.match(read.errors[1], /\(contoso_K\) Value must be a Key Vault secret reference/);
  assert.match(read.errors[2], /'contoso_N' appears more than once/);
  assert.match(read.errors[3], /ConnectorId does not match the connector the App Spec declares/);
  const text = JSON.stringify(read.errors);
  for (const secret of ['forty-two', 'p@ssw0rd-pasted', 'conn-sql-1']) assert.ok(!text.includes(secret), secret);
  assert.equal(read.environmentVariables.size, 0);
  assert.equal(read.connectionReferences.size, 0);
  const vault = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_K', Value: VAULT_REF }] }, spec);
  assert.deepEqual(vault.errors, []);
});

// The HTTP client's record of the sends behind an answer, on the failure body the SDK keeps as the error's cause.
const HISTORY = Symbol.for('power-platform-skills.http-send-history');
const answered = (statusCode, history) => {
  const body = { error: { code: '0x80040203' } };
  if (history) Object.defineProperty(body, HISTORY, { value: history, enumerable: false });
  return Object.assign(new Error('x'), { code: 'CONNECTION_ERROR', statusCode, cause: body });
};

test('failure classification: only a local refusal, or a 4xx on a single request sent once, is "nothing"', () => {
  const err = (code, statusCode) => Object.assign(new Error('x'), { code, statusCode });
  assert.deepEqual(C.classifyFailure(err('VALIDATION_ERROR')), { code: 'VALIDATION_ERROR', outcome: 'nothing' });
  assert.deepEqual(C.classifyFailure(err('CUSTOM_API_LABELS_UNSUPPORTED')), { code: 'CUSTOM_API_LABELS_UNSUPPORTED', outcome: 'nothing' });
  assert.deepEqual(C.classifyFailure(answered(400, { sends: 1, earlierAmbiguous: false }), { singleWrite: true }), { code: 'CONNECTION_ERROR', outcome: 'nothing' });
  assert.deepEqual(C.classifyFailure(answered(400, { sends: 1, earlierAmbiguous: false })), { code: 'CONNECTION_ERROR', outcome: 'unknown' });
  // A 4xx that answered a re-send after an ambiguous send (a 412 because the first one committed), or one with no
  // record of the sends behind it, does not prove that nothing was written.
  assert.deepEqual(C.classifyFailure(answered(412, { sends: 2, earlierAmbiguous: true }), { singleWrite: true }), { code: 'CONNECTION_ERROR', outcome: 'unknown' });
  assert.deepEqual(C.classifyFailure(err('CONNECTION_ERROR', 400), { singleWrite: true }), { code: 'CONNECTION_ERROR', outcome: 'unknown' });
  assert.deepEqual(C.classifyFailure(answered(408, { sends: 1, earlierAmbiguous: false }), { singleWrite: true }), { code: 'CONNECTION_ERROR', outcome: 'unknown' });
  assert.deepEqual(C.classifyFailure(answered(429, { sends: 1, earlierAmbiguous: false }), { singleWrite: true }), { code: 'CONNECTION_ERROR', outcome: 'unknown' });
  assert.deepEqual(C.classifyFailure(err('CONNECTION_ERROR', 503), { singleWrite: true }), { code: 'CONNECTION_ERROR', outcome: 'unknown' });
  assert.deepEqual(C.classifyFailure(err('CONNECTION_ERROR'), { singleWrite: true }), { code: 'CONNECTION_ERROR', outcome: 'unknown' });
  assert.deepEqual(C.classifyFailure(err('DUPLICATE_RULE_UPDATE_NOT_ATOMIC')), { code: 'DUPLICATE_RULE_UPDATE_NOT_ATOMIC', outcome: 'unknown' });
  // A code that is not a fixed identifier (it could be a message) is never passed through.
  assert.deepEqual(C.classifyFailure(err('see https://contoso.crm.dynamics.com')), { code: 'UNEXPECTED_ERROR', outcome: 'unknown' });
  assert.deepEqual(C.classifyFailure(new Error('no code')), { code: 'UNEXPECTED_ERROR', outcome: 'unknown' });
});

const evRemote = (extra = {}) => ({
  id: 'ev-1', schemaName: 'contoso_S', type: 'string', name: 'contoso_S', description: null, defaultValue: null, isRequired: false,
  valueSchema: null, connectorId: null, parameterKey: null, parentId: null, currentValue: null, ...extra,
});
const crRemote = (extra = {}) => ({ id: 'cr-1', logicalName: 'contoso_sp', name: 'contoso_sp', description: null, connectorId: SP, connectionId: null, ...extra });

test('an unchanged artifact is read, never written; a plan never serializes a value', async () => {
  const spec = base({ environmentVariables: [{ schemaName: 'contoso_S', type: 'string' }], connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] });
  const sdk = stubSdk({ remotes: { 'environmentVariable:contoso_s': evRemote({ currentValue: { id: 'v-1', value: 'same' } }), 'connectionReference:contoso_sp': crRemote({ connectionId: 'conn-1' }) } });
  const bindings = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_S', Value: 'same' }], ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-1' }] }, spec);
  const plan = await C.planConfiguration(spec, { fence: null, sdk, bindings });
  assert.deepEqual(plan.operations.map((op) => op.action), ['unchanged', 'unchanged']);
  const result = await C.applyConfiguration(plan, { fence: null, sdk, bindings });
  assert.deepEqual(result.unchanged, [{ kind: 'environmentVariable', key: 'contoso_S', id: 'ev-1' }, { kind: 'connectionReference', key: 'contoso_sp', id: 'cr-1' }]);
  assert.deepEqual(sdk.calls.map((c) => c[0]).filter((n) => !['findArtifact', 'fetchArtifact'].includes(n)), []);

  const changed = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_S', Value: 'new-secret-ish' }], ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-2' }] }, spec);
  const plan2 = await C.planConfiguration(spec, { fence: null, sdk, bindings: changed });
  assert.deepEqual(plan2.operations.map((op) => [op.action, op.fields]), [['update', ['/currentValue']], ['update', ['/connectionId']]]);
  const text = JSON.stringify(plan2);
  assert.ok(!text.includes('new-secret-ish') && !text.includes('conn-2'), text);
  const refused2 = await C.applyConfiguration(plan2, { fence: null, sdk, bindings: changed });
  assert.deepEqual(refused2.refused.map((r) => r.authorize), [['environmentVariableValue:contoso_s:value'], ['connectionReference:contoso_sp:connectionId']]);
  assert.ok(!sdk.calls.some((c) => c[0] === 'updateElement'));
  const result2 = await C.applyConfiguration(plan2, { fence: null, sdk, bindings: changed, authorizedDestructive: new Set(['environmentVariableValue:contoso_s:value', 'connectionReference:contoso_sp:connectionId']) });
  assert.ok(!JSON.stringify(result2).includes('new-secret-ish'));
  // The value edit keeps the value row's id so the SDK patches it instead of adding a second row.
  assert.deepEqual(sdk.calls.find((c) => c[0] === 'updateElement' && c[3] === '/currentValue')[4], { id: 'v-1', value: 'new-secret-ish' });
});

test('a variable type change and a reference connector change are refused before any write', async () => {
  const spec = base({ environmentVariables: [{ schemaName: 'contoso_S', type: 'json' }], connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] });
  const sdk = stubSdk({ remotes: { 'environmentVariable:contoso_s': evRemote(), 'connectionReference:contoso_sp': crRemote({ connectorId: '/providers/Microsoft.PowerApps/apis/shared_sql' }) } });
  const plan = await C.planConfiguration(spec, { fence: null, sdk });
  const result = await C.applyConfiguration(plan, { fence: null, sdk, creates: passPort() });
  assert.deepEqual(result.refused, [
    { kind: 'environmentVariable', key: 'contoso_S', id: 'ev-1', code: 'ENVIRONMENT_VARIABLE_TYPE_IMMUTABLE' },
    { kind: 'connectionReference', key: 'contoso_sp', id: 'cr-1', code: 'CONNECTION_REFERENCE_CONNECTOR_MISMATCH' },
  ]);
  assert.ok(!sdk.calls.some((c) => ['updateElement', 'pushArtifact', 'createArtifact'].includes(c[0])));
});

test('variables are planned parent first, and a new child is created with its new parent\'s id', async () => {
  const spec = base({ environmentVariables: [
    { schemaName: 'contoso_List', type: 'dataSource', connectorId: SP, parameterKey: 'table', parentSchemaName: 'contoso_Site' },
    { schemaName: 'contoso_Site', type: 'dataSource', connectorId: SP, parameterKey: 'dataset' },
  ] });
  const sdk = stubSdk();
  const creates = passPort();
  const plan = await C.planConfiguration(spec, { fence: null, sdk });
  assert.deepEqual(plan.operations.map((op) => [op.key, op.action]), [['contoso_Site', 'create'], ['contoso_List', 'create']]);
  const result = await C.applyConfiguration(plan, { fence: null, sdk, creates });
  const [site, list] = result.saved;
  assert.equal(site.key, 'contoso_Site');
  const childArtifact = sdk.calls.find((c) => c[0] === 'createArtifact' && c[2].schemaName === 'contoso_List')[2];
  assert.equal(childArtifact.parentId, site.id);
  assert.equal(childArtifact.currentValue, null);
  // No value is bound, so no value row id is reserved.
  assert.deepEqual(result.managedBindings.map((b) => [b.key, b.origin, Object.keys(b.childIds || {})]), [['contoso_Site', 'created', []], ['contoso_List', 'created', []]]);
  assert.equal(list.action, 'create');
});

test('managed identity: a bound id is fetched directly; a name match needs the adoption decision', async () => {
  const spec = base({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP, description: 'SharePoint' }] });
  const sdk = stubSdk({ remotes: { 'connectionReference:contoso_sp': crRemote() } });
  const bound = { lookup: async () => ({ id: 'cr-1' }) };
  const p1 = await C.planConfiguration(spec, { fence: null, sdk, managed: bound });
  assert.equal(p1.operations[0].origin, 'managed');
  assert.ok(!sdk.calls.some((c) => c[0] === 'findArtifact'));

  const refusing = { lookup: async () => null, planAdoption: async () => ({ allowed: false, code: 'ADOPTION_NOT_OWNED' }) };
  const p2 = await C.planConfiguration(spec, { fence: null, sdk, managed: refusing });
  assert.deepEqual([p2.operations[0].action, p2.operations[0].code, p2.operations[0].origin], ['refuse', 'ADOPTION_NOT_OWNED', 'adopted']);
  const silent = { lookup: async () => null, planAdoption: async () => undefined };
  assert.equal((await C.planConfiguration(spec, { fence: null, sdk, managed: silent })).operations[0].code, 'ADOPTION_REFUSED');

  const allowing = { lookup: async () => ({ id: 'deleted-elsewhere' }), planAdoption: async () => ({ allowed: true }) };
  const p3 = await C.planConfiguration(spec, { fence: null, sdk, managed: allowing });
  const result = await C.applyConfiguration(p3, { fence: null, sdk, managed: allowing });
  assert.deepEqual(result.saved, [{ kind: 'connectionReference', key: 'contoso_sp', id: 'cr-1', action: 'update', fields: ['/description'] }]);
  assert.deepEqual(result.managedBindings, [{ kind: 'connectionReference', key: 'contoso_sp', id: 'cr-1', origin: 'adopted' }]);
});

test('a failed read is unknown in the plan and in the result, and nothing is written', async () => {
  const spec = base({ connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] });
  const sdk = stubSdk({ fail: { findArtifact: Object.assign(new Error('socket hang up at https://contoso.crm.dynamics.com'), { code: 'CONNECTION_ERROR' }) } });
  const plan = await C.planConfiguration(spec, { fence: null, sdk });
  assert.deepEqual(plan, { operations: [], unknown: [{ kind: 'connectionReference', key: 'contoso_sp', code: 'CONNECTION_ERROR' }] });
  const result = await C.applyConfiguration(plan, { fence: null, sdk, creates: passPort() });
  assert.deepEqual(result.unknown, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'CONNECTION_ERROR' }]);
  assert.ok(!JSON.stringify(result).includes('contoso.crm'));
});

const apiRemote = (extra = {}) => ({
  id: 'api-1', uniqueName: 'contoso_Calc', name: 'contoso_Calc', displayName: 'contoso_Calc', description: 'contoso_Calc',
  binding: 'global', boundEntityLogicalName: null, isFunction: false, allowedProcessingSteps: 'none', enabledForWorkflow: false,
  isPrivate: false, executePrivilegeName: null, pluginTypeId: null,
  requestParameters: [{ id: 'p-a', uniqueName: 'A', type: 'integer', isOptional: false, entityLogicalName: null }, { id: 'p-b', uniqueName: 'B', type: 'integer', isOptional: false, entityLogicalName: null }],
  responseProperties: [],
  ...extra,
});

test('custom API: immutable fields refuse, a removed parameter is destructive and needs authorization', async () => {
  const declared = (extra = {}) => base({ customApis: [{ uniqueName: 'contoso_Calc', requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'B', type: 'integer' }], ...extra }] });
  const sdk = stubSdk({ remotes: { 'customApi:contoso_calc': apiRemote() } });
  assert.equal((await C.planConfiguration(declared({ isFunction: true, responseProperties: [{ uniqueName: 'R', type: 'string' }] }), { fence: null, sdk })).operations[0].code, 'CUSTOM_API_IMMUTABLE');
  assert.equal((await C.planConfiguration(declared({ requestParameters: [{ uniqueName: 'A', type: 'string' }, { uniqueName: 'B', type: 'integer' }] }), { fence: null, sdk })).operations[0].code, 'CUSTOM_API_PARAMETER_IMMUTABLE');
  assert.equal((await C.planConfiguration(declared({ requestParameters: [{ uniqueName: 'A', type: 'integer', isOptional: true }, { uniqueName: 'B', type: 'integer' }] }), { fence: null, sdk })).operations[0].code, 'CUSTOM_API_PARAMETER_IMMUTABLE');
  // Unauthored labels never turn into a write; the definition alone is not proof the API works.
  const same = await C.planConfiguration(declared(), { fence: null, sdk });
  assert.equal(same.operations[0].action, 'unchanged');
  assert.deepEqual(same.operations[0].preconditions, [{ kind: 'customApiImplementation', verified: false }]);

  const removing = declared({ requestParameters: [{ uniqueName: 'A', type: 'integer', displayName: 'Alpha' }, { uniqueName: 'C', type: 'string' }] });
  const plan = await C.planConfiguration(removing, { fence: null, sdk });
  assert.deepEqual([plan.operations[0].action, plan.operations[0].destructive, plan.operations[0].fields], ['update', true, ['/requestParameters']]);
  // A boolean, a list, a function, a parent token or another child's token authorizes nothing: only the exact Set entry does.
  for (const authorizedDestructive of [undefined, true, ['customApi:contoso_calc:request:b'], (op) => op.key === 'contoso_Calc', new Set(['customApi:contoso_calc']), new Set(['customApi:contoso_calc:request:a'])]) {
    const refused = await C.applyConfiguration(plan, { fence: null, sdk, authorizedDestructive });
    assert.deepEqual(refused.refused, [{ kind: 'customApi', key: 'contoso_Calc', id: 'api-1', code: 'DESTRUCTIVE_CHANGE_UNAUTHORIZED', authorize: ['customApi:contoso_calc:request:b'] }]);
    assert.ok(!sdk.calls.some((c) => c[0] === 'updateElement'));
  }
  const result = await C.applyConfiguration(plan, { fence: null, sdk, authorizedDestructive: new Set(['customApi:contoso_calc:request:b']), creates: passPort() });
  assert.equal(result.saved.length, 1);
  // The merged list keeps A's row id, drops B, and gives the new C the id its create-port record holds.
  const merged = sdk.calls.find((c) => c[0] === 'updateElement')[4];
  assert.deepEqual(merged.map((c) => [c.id, c.uniqueName, c.displayName]), [['p-a', 'A', 'Alpha'], ['00000000-0000-0000-0000-000000000001', 'C', undefined]]);

});

test('creates go through the create port, with one id per child and a composite failure kept unknown', async () => {
  const spec = base({
    environmentVariables: [{ schemaName: 'contoso_S', type: 'string' }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
    customApis: [{ uniqueName: 'contoso_Calc', requestParameters: [{ uniqueName: 'A', type: 'integer' }], responseProperties: [{ uniqueName: 'R', type: 'string' }] }],
  });
  const sdk = stubSdk();
  // Without a port of its own the build creates through the plain pass-through: ordinary creation is never disabled.
  const plain = stubSdk();
  const unported = await C.applyConfiguration(await C.planConfiguration(spec, { fence: null, sdk: plain }), { fence: null, sdk: plain });
  assert.deepEqual([unported.refused, unported.unknown], [[], []]);
  assert.deepEqual(unported.saved.map((x) => [x.kind, x.action]), [['environmentVariable', 'create'], ['connectionReference', 'create'], ['customApi', 'create']]);

  const creates = passPort();
  const result = await C.applyConfiguration(await C.planConfiguration(spec, { fence: null, sdk }), { fence: null, sdk, creates });
  // Keys are folded to lower case: Dataverse matches these names case-insensitively, the port does not.
  assert.deepEqual(creates.calls.map((c) => [c.kind, c.key, c.childKeys]), [
    ['environmentVariable', 'contoso_s', []], ['connectionReference', 'contoso_sp', []], ['customApi', 'contoso_calc', ['request:a', 'response:r']],
  ]);
  const api = sdk.calls.find((c) => c[0] === 'createArtifact' && c[1] === 'customApi')[2];
  const apiBinding = result.managedBindings.find((b) => b.kind === 'customApi');
  assert.equal(api.requestParameters[0].id, apiBinding.childIds['request:a']);
  assert.equal(api.responseProperties[0].id, apiBinding.childIds['response:r']);

  // A 400 on a single-request create sent nothing; the same 400 on a variable WITH a value (two POSTs) may have left the definition.
  const http400 = answered(400, { sends: 1, earlierAmbiguous: false });
  const failing = stubSdk({ fail: { pushArtifact: http400 } });
  const withValue = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_S', Value: 'v' }] }, spec);
  const r400 = await C.applyConfiguration(await C.planConfiguration(spec, { fence: null, sdk: failing, bindings: withValue }), { fence: null, sdk: failing, creates: passPort(), bindings: withValue });
  assert.deepEqual(r400.unknown.map((u) => [u.kind, u.code, u.cause]), [['environmentVariable', 'create-outcome-unknown', 'CONNECTION_ERROR']]);
  // An unknown outcome stops the writes after it: what it left is not known.
  assert.deepEqual(r400.refused.map((r) => [r.kind, r.code]), [['connectionReference', 'CONFIGURATION_STOPPED_AFTER_UNKNOWN'], ['customApi', 'CONFIGURATION_STOPPED_AFTER_UNKNOWN']]);
  assert.deepEqual(r400.saved, []);
  const singles = base({ connectionReferences: spec.connectionReferences, customApis: spec.customApis });
  const r400single = await C.applyConfiguration(await C.planConfiguration(singles, { fence: null, sdk: failing }), { fence: null, sdk: failing, creates: passPort() });
  assert.deepEqual(r400single.refused.map((r) => [r.kind, r.code]), [['connectionReference', 'CONNECTION_ERROR'], ['customApi', 'CONNECTION_ERROR']]);
  assert.deepEqual(r400single.unknown, []);

  // The port refusing on its own (an earlier create with an unknown outcome) sends nothing.
  const fenced = { async run() { throw Object.assign(new Error('fenced'), { code: 'CREATE_OUTCOME_UNKNOWN' }); } };
  const rf = await C.applyConfiguration(await C.planConfiguration(base({ connectionReferences: spec.connectionReferences }), { fence: null, sdk }), { fence: null, sdk, creates: fenced });
  assert.deepEqual(rf.refused, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'CREATE_OUTCOME_UNKNOWN' }]);
  // The port's own typed stops pass through by name; one raised before anything was sent sends nothing.
  const conflict = { async run() { throw Object.assign(new Error('conflict'), { code: 'create-identity-conflict' }); } };
  const rc = await C.applyConfiguration(await C.planConfiguration(base({ connectionReferences: spec.connectionReferences }), { fence: null, sdk }), { fence: null, sdk, creates: conflict });
  assert.deepEqual(rc.refused, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'create-identity-conflict' }]);
});

const ruleRemote = (extra = {}) => ({
  id: 'r-1', name: 'Same email', description: null, entityLogicalName: 'contact', matchingEntityLogicalName: 'contact', caseSensitive: false,
  excludeInactiveRecords: false, status: 'published', conditions: [{ id: 'c-1', column: 'emailaddress1', matchingColumn: 'emailaddress1', match: 'exact', characters: null, ignoreBlankValues: false }],
  ...extra,
});
const ruleSpec = (extra = {}, entities) => base({
  ...(entities ? { entities } : {}),
  duplicateDetectionRules: [{ key: 'email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }], ...extra }],
});
const FLAG = "/EntityDefinitions(LogicalName='contact')";
const COUNT = '/duplicaterules?$select=duplicateruleid&$filter=';

test('duplicate rules: an unchanged rule costs no switch or slot reads; a name on another table is not this rule', async () => {
  const sdk = stubSdk({ remotes: { 'duplicateRule:same email': ruleRemote() } });
  const plan = await C.planConfiguration(ruleSpec(), { fence: null, sdk });
  assert.equal(plan.operations[0].action, 'unchanged');
  assert.ok(!sdk.calls.some((c) => c[0] === 'get'));
  const other = stubSdk({ remotes: { 'duplicateRule:same email': ruleRemote({ entityLogicalName: 'account', matchingEntityLogicalName: 'account' }) } });
  assert.equal((await C.planConfiguration(ruleSpec(), { fence: null, sdk: other })).operations[0].code, 'DUPLICATE_RULE_NAME_CONFLICT');
  const cross = stubSdk({ remotes: { 'duplicateRule:same email': ruleRemote({ matchingEntityLogicalName: 'lead' }) } });
  // An omitted matchingEntity keeps the row's; an authored one that differs is an immutable change.
  assert.equal((await C.planConfiguration(ruleSpec(), { fence: null, sdk: cross })).operations[0].action, 'unchanged');
  assert.equal((await C.planConfiguration(ruleSpec({ matchingEntity: 'contact' }), { fence: null, sdk: cross })).operations[0].code, 'DUPLICATE_RULE_TABLE_IMMUTABLE');
});

test('duplicate rules: the table switch is never turned on implicitly, and the five-rule limit is checked before writing', async () => {
  const off = { [FLAG]: { IsDuplicateDetectionEnabled: { Value: false } }, [COUNT]: { value: [] } };
  const sdk = stubSdk({ get: off });
  const refused = await C.planConfiguration(ruleSpec({ description: 'x' }), { fence: null, sdk });
  assert.deepEqual([refused.operations[0].action, refused.operations[0].code], ['refuse', 'DUPLICATE_DETECTION_DISABLED']);
  assert.ok(sdk.calls.some((c) => c[0] === 'get' && c[1].includes(encodeURIComponent("baseentityname eq 'contact' and statecode eq 1"))));

  // The spec turns the switch on explicitly: the plan carries a precondition the apply checks again.
  const declared = await C.planConfiguration(ruleSpec({}, [{ schemaName: 'contact', duplicateDetectionEnabled: true }]), { fence: null, sdk });
  assert.deepEqual(declared.operations[0].preconditions, [{ kind: 'tableDuplicateDetection', table: 'contact' }]);
  const still = await C.applyConfiguration(declared, { fence: null, sdk, creates: passPort() });
  assert.deepEqual(still.refused, [{ kind: 'duplicateRule', key: 'email', code: 'DUPLICATE_DETECTION_DISABLED' }]);
  const on = stubSdk({ get: { [FLAG]: { IsDuplicateDetectionEnabled: { Value: true } } } });
  const passed = await C.applyConfiguration(declared, { fence: null, sdk: on, creates: passPort() });
  assert.equal(passed.saved.length, 1);

  const five = { [FLAG]: { IsDuplicateDetectionEnabled: { Value: true } }, [COUNT]: { value: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ duplicateruleid: x })) } };
  const full = await C.planConfiguration(ruleSpec(), { fence: null, sdk: stubSdk({ get: five }) });
  assert.equal(full.operations[0].code, 'DUPLICATE_RULE_LIMIT');
  // A rule that is already one of the five published ones can still be edited.
  const mine = stubSdk({ remotes: { 'duplicateRule:same email': ruleRemote() }, get: { ...five, [COUNT]: { value: ['a', 'b', 'c', 'd', 'r-1'].map((x) => ({ duplicateruleid: x })) } } });
  assert.equal((await C.planConfiguration(ruleSpec({ description: 'edited' }), { fence: null, sdk: mine })).operations[0].action, 'update');

  const unreadable = await C.planConfiguration(ruleSpec(), { fence: null, sdk: stubSdk({ get: { [FLAG]: { IsDuplicateDetectionEnabled: {} } } }) });
  assert.deepEqual(unreadable, { operations: [], unknown: [{ kind: 'duplicateRule', key: 'email', code: 'DUPLICATE_DETECTION_UNREADABLE' }] });
});

test('duplicate rules: an edit keeps condition ids, and a rule saved but not published is reported', async () => {
  const sdk = stubSdk({ remotes: { 'duplicateRule:same email': ruleRemote() }, get: { [FLAG]: { IsDuplicateDetectionEnabled: { Value: true } }, [COUNT]: { value: [{ duplicateruleid: 'r-1' }] } } });
  const spec = ruleSpec({ conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact', ignoreBlankValues: true }, { key: 'l', column: 'lastname', match: 'firstCharacters', characters: 3 }] });
  // Unbound, an authored ignoreBlankValues that differs does not describe the row: guessing it is the same criterion
  // could rewrite the wrong one, so the row is a removal (named by its id) and the declaration an addition.
  const unbound = await C.planConfiguration(spec, { fence: null, sdk });
  assert.deepEqual(unbound.operations[0].authorize, ['duplicateRule:email:condition:c-1']);
  // A recorded binding pins the key to its row: the same declaration is an edit of that row, under the key's token.
  const managed = { lookup: async (kind, key) => (kind === 'duplicateRule' && key === 'email' ? { id: 'r-1', childIds: { e: 'c-1' } } : null) };
  const plan = await C.planConfiguration(spec, { fence: null, sdk, managed });
  assert.deepEqual(plan.operations[0].fields, ['/conditions']);
  assert.deepEqual(plan.operations[0].authorize, ['duplicateRule:email:condition:e'], 'a changed criterion needs its own token');
  // The save lands and leaves the rule unpublished (Dataverse unpublishes a rule whose criteria change); the
  // publish job then fails. The read-back, not the job's answer, decides it is pending.
  const update = sdk.updateElement;
  sdk.updateElement = async (...args) => {
    await update(...args);
    await update('duplicateRule', 'r-1', '/status', 'unpublished');
    sdk.calls.pop();
  };
  sdk.pushArtifact = async () => ({ publish: { kind: 'failed', error: { code: 'DUPLICATE_RULE_PUBLISH_FAILED' } } });
  const result = await C.applyConfiguration(plan, { fence: null, sdk, creates: passPort(), managed, authorizedDestructive: new Set(['duplicateRule:email:condition:e']) });
  const merged = sdk.calls.find((c) => c[0] === 'updateElement')[4];
  // The kept condition keeps its row id; the new one gets the id its create-port record holds.
  assert.deepEqual(merged.map((c) => c.id), ['c-1', '00000000-0000-0000-0000-000000000001']);
  assert.deepEqual(result.pendingPublish, [{ kind: 'duplicateRule', key: 'email', id: 'r-1', code: 'DUPLICATE_RULE_PUBLISH_FAILED' }]);
  assert.equal(result.saved.length, 1);
});

test('solution version: equal is unchanged, different is one write, missing or managed is refused, omitted costs nothing', async () => {
  const spec = (version) => base({ solution: { uniqueName: 'ContosoSol', publisherPrefix: 'contoso', ...(version ? { version } : {}) } });
  const sdk = stubSdk({ solution: { solutionId: 'sol-1', version: '1.0.0.0', isManaged: false } });
  assert.deepEqual(await C.planSolutionVersion(spec(), { fence: null, sdk }), { operations: [], unknown: [] });
  assert.deepEqual(sdk.calls, []);
  assert.equal((await C.planSolutionVersion(spec('1.0.0.0'), { fence: null, sdk })).operations[0].action, 'unchanged');
  const plan = await C.planSolutionVersion(spec('1.2.0.0'), { fence: null, sdk });
  const result = await C.applyConfiguration(plan, { fence: null, sdk });
  assert.deepEqual(result.saved, [{ kind: 'solutionVersion', key: 'ContosoSol', id: 'sol-1', action: 'update', fields: ['/version'] }]);
  assert.deepEqual(sdk.calls.filter((c) => c[0] === 'setSolutionVersion'), [['setSolutionVersion', 'sol-1', '1.2.0.0']]);
  const managed = stubSdk({ solution: { solutionId: 'sol-1', version: '1.0.0.0', isManaged: true } });
  assert.equal((await C.planSolutionVersion(spec('1.2.0.0'), { fence: null, sdk: managed })).operations[0].code, 'SOLUTION_MANAGED');
  const absent = stubSdk({ fail: { getSolution: Object.assign(new Error("No solution found for 'ContosoSol'."), { code: 'INVALID_ARGUMENT' }) } });
  assert.equal((await C.planSolutionVersion(spec('1.2.0.0'), { fence: null, sdk: absent })).operations[0].code, 'SOLUTION_NOT_FOUND');
  assert.deepEqual(await C.verifySolutionVersion(spec('1.2.0.0'), { fence: null, sdk: absent }), [{ kind: 'solutionVersion', key: 'ContosoSol', name: 'version', ok: false, code: 'SOLUTION_NOT_FOUND' }]);
  const down = stubSdk({ fail: { getSolution: Object.assign(new Error('x'), { code: 'CONNECTION_ERROR' }) } });
  assert.deepEqual((await C.planSolutionVersion(spec('1.2.0.0'), { fence: null, sdk: down })).unknown, [{ kind: 'solutionVersion', key: 'ContosoSol', code: 'CONNECTION_ERROR' }]);
});

test('verify reports drift by pointer, binding drift, a missing required value and an unproven Custom API, never a value', async () => {
  const spec = base({
    environmentVariables: [{ schemaName: 'contoso_S', type: 'string', isRequired: true, description: 'wanted' }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
    customApis: [{ uniqueName: 'contoso_Calc', requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'B', type: 'integer' }] }],
    duplicateDetectionRules: [{ key: 'gone', name: 'Missing rule', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }],
  });
  const sdk = stubSdk({ remotes: {
    'environmentVariable:contoso_s': evRemote({ isRequired: true }),
    'connectionReference:contoso_sp': crRemote({ connectionId: 'conn-old' }),
    'customApi:contoso_calc': apiRemote({ pluginTypeId: 'plugin-1' }),
  } });
  const bindings = C.readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: 'conn-new' }] }, spec);
  const checks = await C.verifyConfiguration(spec, { fence: null, sdk, bindings });
  assert.deepEqual(checks, [
    { kind: 'environmentVariable', key: 'contoso_S', name: 'definition', ok: false, code: 'DRIFT', fields: ['/description'] },
    { kind: 'environmentVariable', key: 'contoso_S', name: 'value', ok: false, code: 'ENVIRONMENT_VARIABLE_VALUE_MISSING' },
    { kind: 'connectionReference', key: 'contoso_sp', name: 'definition', ok: true },
    { kind: 'connectionReference', key: 'contoso_sp', name: 'binding', ok: false, code: 'BINDING_DRIFT' },
    { kind: 'customApi', key: 'contoso_Calc', name: 'definition', ok: true },
    { kind: 'customApi', key: 'contoso_Calc', name: 'implementation', ok: true },
    { kind: 'duplicateRule', key: 'gone', name: 'definition', ok: false, code: 'NOT_FOUND' },
  ]);
  assert.ok(!JSON.stringify(checks).includes('conn-'));
  assert.ok(!sdk.calls.some((c) => ['updateElement', 'pushArtifact', 'createArtifact'].includes(c[0])));
});

test('--authorize tokens of these kinds are normalized as a plan writes them; an unknown item or field is a problem, other kinds are left alone', () => {
  const spec = base({
    environmentVariables: [{ schemaName: 'contoso_S', type: 'string' }],
    customApis: [{ uniqueName: 'contoso_Calc' }],
    duplicateDetectionRules: [{ key: 'Email', name: 'Same email', entity: 'contact', conditions: [{ key: 'E', column: 'emailaddress1', match: 'exact' }] }],
  });
  const answer = C.configurationAuthorizationKeys([
    'customApi:CONTOSO_CALC:Request:B', 'environmentVariableValue:Contoso_S:value', 'duplicateRule:Email:condition:E',
    'duplicateRule:email:condition:E', 'environmentVariable:contoso_nope:defaultValue', 'customApi:contoso_Calc:everything', 'table:contoso_x:delete', 42,
  ], spec);
  assert.deepEqual([...answer.keys], ['customApi:contoso_calc:request:b', 'environmentVariableValue:contoso_s:value', 'duplicateRule:Email:condition:E']);
  assert.deepEqual(answer.problems, [
    // A rule key is matched byte for byte: 'email' is not the declared 'Email'.
    { token: 'duplicateRule:email:condition:E', code: 'CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM' },
    { token: 'environmentVariable:contoso_nope:defaultValue', code: 'CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM' },
    { token: 'customApi:contoso_Calc:everything', code: 'CONFIGURATION_AUTHORIZATION_INVALID' },
  ]);
  assert.deepEqual(answer.unclaimed, ['table:contoso_x:delete', 42]);
  // The ctx keeps only a Set: anything else authorizes nothing.
  assert.equal(C.configurationContext({ fence: null, sdk: {}, authorizedDestructive: true }).authorizedDestructive.size, 0);
  assert.equal(C.configurationContext({ fence: null, sdk: {}, authorizedDestructive: ['customApi:contoso_calc:request:b'] }).authorizedDestructive.size, 0);
});

test('an intent is exactly one declaration, and its canonical JSON is stable, complete and refuses what JSON would change', () => {
  const spec = base({ environmentVariables: [{ schemaName: 'contoso_S', type: 'string' }, { schemaName: 'CONTOSO_s', type: 'number' }], connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }] });
  assert.equal(C.configurationIntentOf(spec, 'connectionReference', 'CONTOSO_SP').logicalName, 'contoso_sp');
  assert.throws(() => C.configurationIntentOf(spec, 'environmentVariable', 'contoso_s'), { code: 'CONFIGURATION_INTENT_AMBIGUOUS' });
  assert.throws(() => C.configurationIntentOf(spec, 'customApi', 'contoso_x'), { code: 'CONFIGURATION_INTENT_NOT_FOUND' });
  assert.throws(() => C.configurationIntentOf(spec, 'webResource', 'x'), { code: 'CONFIGURATION_INTENT_KIND_UNKNOWN' });
  assert.equal(C.canonicalConfigurationJson({ b: 1, a: [2, { d: null, c: 'x' }], e: true }), '{"a":[2,{"c":"x","d":null}],"b":1,"e":true}');
  assert.equal(C.canonicalConfigurationJson({ a: 1, b: 2 }), C.canonicalConfigurationJson({ b: 2, a: 1 }));
  for (const bad of [{ a: undefined }, { a: Number.NaN }, [Infinity], JSON.parse('{"__proto__":{"x":1}}'), { f() {} }]) {
    assert.throws(() => C.canonicalConfigurationJson(bad), { code: 'CONFIGURATION_INTENT_NOT_CANONICAL' });
  }
});

test('management records: only what this run created or a maker adopted, with children; a value or connection never shapes a hash', () => {
  const spec = (description) => base({
    environmentVariables: [{ schemaName: 'contoso_S', type: 'string', description }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
    customApis: [
      { uniqueName: 'contoso_Calc', requestParameters: [{ uniqueName: 'A', type: 'integer' }] },
      { uniqueName: 'contoso_Old', requestParameters: [{ uniqueName: 'B', type: 'integer' }] },
    ],
  });
  // A binding's childIds are only the children this run created and read back, so each child is recorded as created,
  // even under a root that was adopted or found (a parameter added to an API an earlier build made).
  const result = { managedBindings: [
    { kind: 'environmentVariable', key: 'contoso_S', id: 'ev-1', origin: 'created', childIds: { value: 'v-1' } },
    { kind: 'connectionReference', key: 'contoso_sp', id: 'cr-1', origin: 'found' },
    { kind: 'customApi', key: 'contoso_Calc', id: 'api-1', origin: 'adopted', childIds: { 'request:a': 'p-a' } },
    { kind: 'customApi', key: 'contoso_Old', id: 'api-2', origin: 'resolved', childIds: { 'request:b': 'p-b' } },
  ] };
  const records = C.configurationManagedRecords(result, spec('one'));
  assert.deepEqual(records.map((r) => [r.kind, r.key, r.id, r.parentKey, r.origin]), [
    ['environmentVariable', 'contoso_s', 'ev-1', undefined, 'created'],
    ['environmentVariableValue', 'contoso_s|value', 'v-1', 'contoso_s', 'created'],
    ['customApi', 'contoso_calc', 'api-1', undefined, 'adopted'],
    ['customApiRequestParameter', 'contoso_calc|request:a', 'p-a', 'contoso_calc', 'created'],
    ['customApiRequestParameter', 'contoso_old|request:b', 'p-b', 'contoso_old', 'created'],
  ]);
  for (const r of records) assert.match(r.intentSha256, /^[0-9a-f]{64}$/);
  const again = C.configurationManagedRecords(result, spec('two'));
  assert.notEqual(again[0].intentSha256, records[0].intentSha256, 'the definition is the intent');
  assert.equal(again[1].intentSha256, records[1].intentSha256, 'a value record hashes its slot, never the value');
  const withValue = spec('one');
  withValue.environmentVariables[0].currentValue = 'secret-ish';
  assert.equal(C.configurationManagedRecords(result, withValue)[0].intentSha256, records[0].intentSha256);
  assert.ok(!JSON.stringify(records).includes('secret-ish'));
  assert.throws(() => C.configurationManagedRecords({ managedBindings: [{ kind: 'customApi', key: 'contoso_missing', id: 'x', origin: 'created' }] }, spec('one')), { code: 'CONFIGURATION_INTENT_NOT_FOUND' });
});

test('download: definitions only, never a value, a connection or an implementation; a failed read is reported, a rule is lossy', async () => {
  const sdk = stubSdk({ remotes: {
    'environmentVariable:contoso_s': evRemote({ description: 'd', currentValue: { id: 'v-1', value: 'live-value' } }),
    'customApi:contoso_calc': apiRemote({ pluginTypeId: 'plugin-1' }),
  } });
  const answer = await C.readConfigurationForDownload(sdk, [
    { kind: 'environmentVariable', key: 'contoso_S', id: 'ev-1' },
    { kind: 'connectionReference', key: 'contoso_sp', id: 'cr-gone' },
    { kind: 'customApi', key: 'contoso_Calc', id: 'api-1' },
    { kind: 'duplicateRule', key: 'email', id: 'r-1' },
  ]);
  assert.deepEqual(answer.declarations.environmentVariables, [{ schemaName: 'contoso_S', name: 'contoso_S', type: 'string', description: 'd', isRequired: false }]);
  assert.equal(answer.declarations.customApis[0].uniqueName, 'contoso_Calc');
  assert.deepEqual(answer.declarations.customApis[0].requestParameters.map((c) => c.uniqueName), ['A', 'B']);
  assert.deepEqual(answer.unknown, [{ kind: 'connectionReference', key: 'contoso_sp', code: 'CONFIGURATION_ROW_ABSENT' }]);
  assert.deepEqual(answer.lossy, [{ kind: 'duplicateRule', key: 'email', code: 'DUPLICATE_RULE_KEYS_NOT_RECOVERABLE' }]);
  const text = JSON.stringify(answer);
  for (const leak of ['live-value', 'plugin-1', 'v-1', 'p-a']) assert.ok(!text.includes(leak), leak);
  assert.ok(!sdk.calls.some((c) => ['updateElement', 'pushArtifact', 'createArtifact'].includes(c[0])));
});

test('the shipped helpers name no document that is not in the repository', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['configuration-artifacts.js', 'configuration-build.js', 'configuration-transport.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
    assert.doesNotMatch(text, /DESIGN\.md|§\d|\bR\d-\d\d\b/, file);
  }
});

test('teardown: every declared configuration item is kept and named, never a value; a Custom API on a table the spec makes is called out', () => {
  assert.deepEqual(C.configurationTeardownNotes(base()), []);
  assert.deepEqual(C.configurationTeardownNotes(base({ environmentVariables: [] })), []);
  const spec = base({
    entities: [{ schemaName: 'contoso_Order' }, { schemaName: 'account', existing: true }],
    environmentVariables: [{ schemaName: 'contoso_ApiKey', type: 'string', defaultValue: 'not-for-output' }],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP }],
    customApis: [
      { uniqueName: 'contoso_Approve', binding: 'entity', boundEntityLogicalName: 'contoso_order' },
      { uniqueName: 'contoso_Touch', binding: 'entity', boundEntityLogicalName: 'account' },
      { uniqueName: 'contoso_Ping', binding: 'global' },
    ],
    duplicateDetectionRules: [{ key: 'orders-by-name', name: 'Orders by name', entity: 'contoso_order' }],
  });
  const notes = C.configurationTeardownNotes(spec);
  assert.equal(notes.length, 6);
  for (const name of ['contoso_ApiKey', 'contoso_sp', 'contoso_Approve', 'contoso_Touch', 'contoso_Ping', 'orders-by-name']) {
    assert.ok(notes.some((n) => n.includes(name)), `a note names ${name}: ${JSON.stringify(notes)}`);
  }
  assert.ok(notes.every((n) => /kept/.test(n)));
  assert.ok(!notes.join('\n').includes('not-for-output'));
  assert.ok(!notes.join('\n').includes(SP));
  const bound = notes.filter((n) => /delete the Custom API first/.test(n));
  assert.equal(bound.length, 1);
  assert.match(bound[0], /contoso_Approve/);
  assert.match(bound[0], /contoso_order/);
});
test('the stable create port\'s intents: one per declared artifact, under the port key, with the child slots the helper sends', () => {
  const spec = base({
    environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string' }, { schemaName: 'contoso_Mode', type: 'string' }],
    connectionReferences: [{ logicalName: 'contoso_SP', connectorId: SP }],
    customApis: [{ uniqueName: 'contoso_Calc', requestParameters: [{ uniqueName: 'A', type: 'integer' }], responseProperties: [{ uniqueName: 'R', type: 'string' }] }],
    duplicateDetectionRules: [{ key: 'Email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }],
  });
  const bindings = C.readDeploymentBindings({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://v1.contoso.com' }] }, spec);
  const seen = [];
  const intentFor = (kind, args) => { seen.push([kind, args]); return { kind, key: args.key }; };
  const bound = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const intents = C.configurationCreateIntents(spec, { intentFor, bindings, boundIdOf: (kind, key) => (kind === 'customApi' && key === 'contoso_calc' ? bound : undefined) });
  const scope = { kind: 'solution', solution: 'ContosoSol' };
  assert.deepEqual(seen, [
    ['environmentVariable', { key: 'contoso_apibase', scope, declaration: { schemaName: 'contoso_ApiBase' }, children: [{ locator: 'value', childKind: 'environmentVariableValue', declaration: {} }] }],
    ['environmentVariable', { key: 'contoso_mode', scope, declaration: { schemaName: 'contoso_Mode' }, children: [] }],
    ['connectionReference', { key: 'contoso_sp', scope, declaration: { logicalName: 'contoso_SP' }, children: [] }],
    ['customApi', { key: 'contoso_calc', scope, declaration: { uniqueName: 'contoso_Calc' }, boundId: bound, children: [
      { locator: 'request:a', childKind: 'customApiRequestParameter', declaration: { uniqueName: 'A' } },
      { locator: 'response:r', childKind: 'customApiResponseProperty', declaration: { uniqueName: 'R' } }] }],
    ['duplicateRule', { key: 'Email', scope, declaration: { key: 'Email' }, children: [{ locator: 'e', childKind: 'duplicateRuleCondition', declaration: { key: 'e' } }] }],
  ]);
  assert.equal(intents.length, 5);
  assert.throws(() => C.configurationCreateIntents(spec, {}), /intentFor/);
});

test('the stable create port as the helper takes it: a pass-through port unchanged; a stable one reads its planned id first', async () => {
  const passthrough = { mode: 'passthrough', run: async () => ({}), protects: () => false, identityFor: () => null };
  assert.equal(C.configurationCreates(passthrough, {}), passthrough, 'no resolve: the plain name lookup, as before');
  const spec = base({ duplicateDetectionRules: [{ key: 'Email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }],
    customApis: [{ uniqueName: 'contoso_Calc' }] });
  const planned = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const stable = { mode: 'stable', run: async () => ({}), protects: (k) => k !== 'connectionReference', identityFor: (kind, key) => (key === 'nope' ? null : { id: planned, childIds: {} }) };
  const asked = [];
  const provision = { dataverse: { get: async () => ({}) } };
  const resolveProtectedTarget = async (args) => { asked.push(args); if (args.key === 'boom') throw Object.assign(new Error('x'), { code: 'create-identity-conflict', create: { id: planned } }); return { state: 'present', id: planned, row: { secret: 1 } }; };
  const port = C.configurationCreates(stable, { resolveProtectedTarget, provision, spec, boundIdOf: (kind) => (kind === 'customApi' ? planned : undefined) });
  assert.equal(port.run, stable.run);
  assert.equal(port.protects('connectionReference'), false);
  assert.deepEqual(await port.resolve({ kind: 'duplicateRule', key: 'Email' }), { state: 'present', id: planned }, 'only the state and the id');
  await port.resolve({ kind: 'customApi', key: 'contoso_calc' });
  assert.deepEqual(asked.map(({ readByName, ...rest }) => rest), [
    { provision, kind: 'duplicateRule', key: 'Email', id: planned, expected: { baseEntity: 'contact' } },
    { provision, kind: 'customApi', key: 'contoso_calc', id: planned, boundId: planned, expected: { uniqueName: 'contoso_Calc' } },
  ]);
  assert.deepEqual(await asked[0].readByName(), [], 'the helper runs its own name lookup after an absent');
  await assert.rejects(port.resolve({ kind: 'duplicateRule', key: 'boom' }), (e) => e.code === 'create-identity-conflict');
  await assert.rejects(port.resolve({ kind: 'duplicateRule', key: 'nope' }), (e) => e.code === 'create-identity-invalid');
  assert.throws(() => C.configurationCreates(stable, {}), /resolveProtectedTarget/);
});

test('the stable create port asks a rule at its id for the matching table only when the declaration names one', async () => {
  const planned = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const stable = { mode: 'stable', run: async () => ({}), protects: () => true, identityFor: () => ({ id: planned, childIds: {} }) };
  const rule = (extra) => ({ key: 'Email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }], ...extra });
  const asked = [];
  const resolveProtectedTarget = async (args) => { asked.push(args.expected); return { state: 'present', id: planned }; };
  // An existing contact-to-account rule rerun with the matching table left out keeps its own: the base table, the
  // default of a NEW rule only, is not asked of it (an undefined member is not compared by the shared reader).
  await C.configurationCreates(stable, { resolveProtectedTarget, spec: base({ duplicateDetectionRules: [rule({})] }) }).resolve({ kind: 'duplicateRule', key: 'Email' });
  await C.configurationCreates(stable, { resolveProtectedTarget, spec: base({ duplicateDetectionRules: [rule({ matchingEntity: 'account' })] }) }).resolve({ kind: 'duplicateRule', key: 'Email' });
  assert.deepEqual(asked, [{ baseEntity: 'contact' }, { baseEntity: 'contact', matchingEntity: 'account' }]);
});

test('the configuration kinds\' own stable port: every kind protected as a feature declaration, scoped to the spec\'s solution, the named one, or the Default Solution', async () => {
  const { createFakeFence } = require('./helpers/stable-create-port.js');
  const fence = createFakeFence();
  const sdk = { marker: 'sdk' };
  const ref = { logicalName: 'contoso_SP', connectorId: SP };
  const scopeOf = () => fence.calls[fence.calls.length - 1].intents.map((i) => i.scope);
  const port = C.configurationStableCreates(base({ connectionReferences: [ref], environmentVariables: [{ schemaName: 'contoso_Mode', type: 'string' }] }), { fence, sdk });
  // featureKinds, never shippedKinds: a spec without createIdentity (every standalone run) is protected all the same.
  assert.deepEqual(fence.calls[0].featureKinds, ['environmentVariable', 'connectionReference', 'customApi', 'duplicateRule']);
  assert.deepEqual(fence.calls[0].shippedKinds, []);
  assert.deepEqual(scopeOf(), [{ kind: 'solution', solution: 'ContosoSol' }, { kind: 'solution', solution: 'ContosoSol' }]);
  assert.equal(port.mode, 'stable');
  assert.equal(typeof port.resolve, 'function', 'it reads the planned id before any name');
  assert.equal(C.configurationAcceptsPort(port), false, 'a port of two kinds cannot stand in for every configuration kind');
  // The spec names no solution: the one the run names, else the Default Solution a create without a header lands in.
  const standalone = { connectionReferences: [ref] };
  C.configurationStableCreates(standalone, { fence, sdk, solutionUniqueName: 'OtherSol' });
  assert.deepEqual(scopeOf(), [{ kind: 'solution', solution: 'OtherSol' }]);
  const plain = C.configurationStableCreates(standalone, { fence, sdk });
  assert.deepEqual(scopeOf(), [{ kind: 'solution', solution: 'Default' }]);
  assert.notEqual(plain.identityFor('connectionReference', 'contoso_sp').id, port.identityFor('connectionReference', 'contoso_sp').id, 'another scope is another id');
  // Nothing of these kinds declared: the shared pass-through, unchanged.
  assert.equal(C.configurationStableCreates(base({}), { fence, sdk }).mode, 'passthrough');
  assert.throws(() => C.configurationStableCreates(standalone, {}), /fence/);
  // A build port that protects every configuration kind and resolves stands in; the pass-through does not.
  const every = C.configurationStableCreates(base({ connectionReferences: [ref], environmentVariables: [{ schemaName: 'contoso_Mode', type: 'string' }],
    customApis: [{ uniqueName: 'contoso_Calc' }], duplicateDetectionRules: [{ key: 'Email', name: 'Same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] }] }), { fence, sdk });
  assert.equal(C.configurationAcceptsPort(every), true);
  assert.equal(C.configurationAcceptsPort({ run: async () => ({}), protects: () => true }), false, 'no resolve');
  assert.equal(C.configurationAcceptsPort(null), false);
});
