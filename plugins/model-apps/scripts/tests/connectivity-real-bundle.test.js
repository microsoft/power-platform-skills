'use strict';
// REAL BUNDLE and REAL PROCESSES: connections and connector metadata, through the vendored SDK, the plugin's real az-token HttpClient and its
// real Power Apps service client, over a fake Power Platform (helpers/fake-power-platform.js) that answers in the shapes the SDK measured on live
// environments and checks that every request carries the token of its audience. A stub cannot tell the plugin that a re-vendored bundle changed a
// code, moved a read, or stopped refusing what it refused — this can. Below the in-process tests the three scripts run in child processes
// (helpers/run-with-fakes.js) with a fake `pac` alone on PATH, or none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createPowerAppsServiceClient } = require('../lib/power-apps-service-client.js');
const { sdkFirst, connectivity, connectivityRefusal, connectivityCloudOf, connectivityRouteRefusal, powerAppsPreflight } = require('../lib/sdk-first.js');
const { createMakerSdk, createNodeWorkspaceStorage, SdkError } = require('../lib/maker-sdk.js');
const { connectionRowFromSdk } = require('../list-connections.js');
const { createCloud, connectionRow, swagger, ORG, ENVIRONMENT_ID, DATAVERSE_TOKEN, POWER_APPS_TOKEN } = require('./helpers/fake-power-platform.js');
const { runScript } = require('./helpers/run-with-fakes.js');

const TEST_ORG = 'https://contoso.crmtest.dynamics.com';
const SQL = '/providers/Microsoft.PowerApps/apis/shared_sql';
const WEATHER = '/providers/Microsoft.PowerApps/apis/shared_msnweather';
const ID = (n) => String(n).padStart(32, '0');
const CONNECTIONS = [
  connectionRow({ id: ID(1), apiId: SQL, displayName: 'Contoso SQL' }),
  connectionRow({ id: '00000000-0000-0000-0000-000000000002', apiId: '/providers/Microsoft.PowerApps/apis/shared_logicflows', displayName: 'a flow\'s own connection' }),
  connectionRow({ id: ID(3), apiId: WEATHER, displayName: 'weather' }),
];
const WEATHER_SWAGGER = {
  ...swagger([
    { id: 'CurrentWeather', summary: 'Get current weather', path: '/current', parameters: [{ name: 'Location', in: 'query', required: true, type: 'string' }, { name: 'Internal', in: 'query', 'x-ms-visibility': 'internal', type: 'string' }], response: { $ref: '#/definitions/Weather' } },
    { id: 'Ping' },
  ]),
  definitions: { Weather: { type: 'object', properties: { temp: { type: 'number', description: 'Temperature' } } } },
};
const SWAGGERS = { shared_msnweather: WEATHER_SWAGGER };

// The SDK over the fake platform, read through the plugin's rule. `tokens` stand in for the Azure CLI reads the preflight makes, and `tokenReads` counts them — one
// per Azure CLI process a real run would start. `route: false` leaves out the plugin's own check of the org's cloud, so a test can see what the BUNDLE does with an org the
// plugin would never hand it.
function world(config = {}) {
  const cloud = createCloud({ connections: CONNECTIONS, swaggers: SWAGGERS, ...config });
  const httpClient = createAzHttpClient(cloud.org, { getToken: () => cloud.tokens.dataverse, request: cloud.request, sleep: async () => {} });
  const service = createPowerAppsServiceClient({ getToken: () => cloud.tokens.powerApps, request: cloud.request });
  const tokenReads = { dataverse: 0, powerApps: 0 };
  const read = (fromSdk, { tokens = {}, serviceClient = service, route = true } = {}) => sdkFirst(cloud.org, {
    ...connectivity,
    ...(route ? {} : { preflight: powerAppsPreflight }),
    httpClient: () => httpClient,
    sdkOptions: { powerAppsServiceClient: serviceClient },
    fromSdk,
    fromPac: async (refusal) => ({ viaPac: true, refusal }),
  }, {
    getAuthTokenAsync: async () => { tokenReads.dataverse += 1; return cloud.tokens.dataverse; },
    getPowerAppsTokenAsync: async () => { tokenReads.powerApps += 1; return cloud.tokens.powerApps; },
    powerAppsTokenFailureMessage: () => 'no Azure CLI token for the Power Apps service',
    ...tokens,
  });
  return { cloud, read, tokenReads };
}
const lines = (cloud) => cloud.requests.map((r) => `${r.method} ${r.host}${r.path}`);

// --- the Public cloud ----------------------------------------------------------------------------------------------------------------

test('REAL BUNDLE: the connections of a Public environment — read from the org\'s own environment id through BAP and the runtime it names, a flow\'s own connections dropped', async () => {
  const { cloud, read } = world();
  const result = await read((sdk) => sdk.listConnections());
  assert.strictEqual(result.source, 'sdk');
  assert.deepStrictEqual(result.value.map((c) => [c.connectionId, c.displayName, c.connectorId, c.connectorName, c.statuses]), [
    [ID(1), 'Contoso SQL', SQL, 'shared_sql', ['Connected']],
    [ID(3), 'weather', WEATHER, 'shared_msnweather', ['Connected']],
  ]);
  assert.deepStrictEqual(lines(cloud), [
    'GET contoso.crm.dynamics.com/api/data/v9.0/RetrieveCurrentOrganization(AccessType=@p1)',
    `GET api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/${ENVIRONMENT_ID}`,
    'GET unitedstates.api.powerapps.com/providers/Microsoft.PowerApps/connections',
  ]);
  // Each audience got its own token, and the other\'s never: the fake answers 401 to a wrong one, and says so here too.
  for (const request of cloud.requests) {
    const expected = request.host === 'contoso.crm.dynamics.com' ? DATAVERSE_TOKEN : POWER_APPS_TOKEN;
    assert.strictEqual(request.authorization, `Bearer ${expected}`, `${request.host}`);
  }
  // The rows are the script\'s rows: PAC\'s fields, and nothing of the SDK\'s extras.
  assert.deepStrictEqual(result.value.map(connectionRowFromSdk), [
    { connectorId: SQL, connectionId: ID(1), displayName: 'Contoso SQL' },
    { connectorId: WEATHER, connectionId: ID(3), displayName: 'weather' },
  ]);
});

test('REAL BUNDLE: a connection list that comes in pages is followed to its end, on the runtime\'s own origin', async () => {
  const { cloud, read } = world({ pageSize: 1 });
  const result = await read((sdk) => sdk.listConnections());
  assert.strictEqual(result.value.length, 2);
  const pages = cloud.toPowerApps().filter((r) => r.path === '/providers/Microsoft.PowerApps/connections');
  assert.strictEqual(pages.length, 3, 'three pages of one row each (one of them the flow connection, which is dropped)');
  assert.ok(pages.every((r) => r.host === 'unitedstates.api.powerapps.com'));
});

test('REAL BUNDLE: an environment with no connections is an empty list, not a refusal', async () => {
  const { read } = world({ connections: [] });
  assert.deepStrictEqual(await read((sdk) => sdk.listConnections()), { source: 'sdk', value: [] });
});

test('REAL BUNDLE: a connector\'s operations and one operation\'s schema, by short name or by full API id — what pac prints, with `$ref`s resolved and internal parameters left out', async () => {
  const { cloud, read } = world();
  const operations = await read((sdk) => sdk.listConnectorOperations('shared_msnweather'));
  assert.deepStrictEqual(operations.value, { operations: [{ name: 'CurrentWeather', summary: 'Get current weather' }, { name: 'Ping', summary: null }] });
  const byId = await read((sdk) => sdk.listConnectorOperations(WEATHER));
  assert.deepStrictEqual(byId.value, operations.value);
  const schema = await read((sdk) => sdk.getConnectorOperationSchema('SHARED_MSNWEATHER', 'CurrentWeather'));
  assert.deepStrictEqual(schema.value, {
    operation: 'CurrentWeather',
    parameters: [{ name: 'Location', required: true }],
    response: { type: 'object', properties: { temp: { type: 'number', description: 'Temperature' } } },
  });
  const none = await read((sdk) => sdk.getConnectorOperationSchema('shared_msnweather', 'Ping'));
  assert.deepStrictEqual(none.value, { operation: 'Ping', parameters: [], response: {} });
  assert.ok(cloud.toPowerApps().some((r) => r.path === '/providers/Microsoft.PowerApps/apis/shared_msnweather'));
});

// --- refusals: pac is asked, and only then -------------------------------------------------------------------------------------------

const asksPac = (code) => (result) => {
  assert.strictEqual(result.source, 'pac', `${code}: pac answers`);
  assert.strictEqual(result.fallback.code, code);
  assert.deepStrictEqual(result.value.refusal, result.fallback);
  assert.ok(result.fallback.message.length > 0);
  return result;
};

test('REAL BUNDLE: a 410 ServiceDecommissioned from the Power Apps host is CONNECTIVITY_ROUTE_DECOMMISSIONED — the SDK still maps it, for a Public org — and pac is asked, after BAP named the runtime and it answered', async () => {
  const { cloud, read } = world({ decommissioned: true });
  const result = asksPac('CONNECTIVITY_ROUTE_DECOMMISSIONED')(await read((sdk) => sdk.listConnections()));
  assert.match(result.fallback.message, /decommissioned/);
  assert.deepStrictEqual(lines(cloud), [
    'GET contoso.crm.dynamics.com/api/data/v9.0/RetrieveCurrentOrganization(AccessType=@p1)',
    `GET api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/${ENVIRONMENT_ID}`,
    'GET unitedstates.api.powerapps.com/providers/Microsoft.PowerApps/connections',
  ]);
  // The same for the connector reads.
  asksPac('CONNECTIVITY_ROUTE_DECOMMISSIONED')(await read((sdk) => sdk.listConnectorOperations('shared_x')));
});

test('REAL BUNDLE: an org in the Test cloud is refused BEFORE ANY REQUEST — CONNECTIVITY_NOT_CONFIGURED: the SDK reads it only through the Power Platform API, and the plugin gives it no client for that', async () => {
  const { cloud, read } = world({ org: TEST_ORG });
  const reads = [
    ['the connection list', (sdk) => sdk.listConnections()],
    ['a connector\'s operations', (sdk) => sdk.listConnectorOperations('shared_msnweather')],
    ['an operation\'s schema', (sdk) => sdk.getConnectorOperationSchema('shared_msnweather', 'Ping')],
  ];
  for (const [what, fromSdk] of reads) {
    // `route: false`: the plugin's own check of the org's cloud is left out, so this is the bundle's answer.
    const result = asksPac('CONNECTIVITY_NOT_CONFIGURED')(await read(fromSdk, { route: false }));
    assert.match(result.fallback.message, /Test cloud[\s\S]*Power Platform API[\s\S]*powerPlatformApiClient/, what);
  }
  // Not the org read, not the Business Application Platform, not a runtime: the refusal is made from the org's host alone.
  assert.deepStrictEqual(cloud.requests, []);
});

test('REAL BUNDLE: through the plugin\'s rule an org in the Test cloud is answered by pac AT ONCE — no Azure CLI token is read, no SDK is made, nothing is requested — with the code the bundle gives', async () => {
  const { cloud, read, tokenReads } = world({ org: TEST_ORG });
  const viaRule = asksPac('CONNECTIVITY_NOT_CONFIGURED')(await read((sdk) => sdk.listConnections()));
  assert.match(viaRule.fallback.message, /Test cloud[\s\S]*Power Platform API/);
  assert.deepStrictEqual(cloud.requests, []);
  assert.deepStrictEqual(tokenReads, { dataverse: 0, powerApps: 0 });
  // What the bundle itself says for the same org, when it is asked: the same code. (Only now are the tokens read: the preflight of a read that does not skip the SDK.)
  const viaBundle = await read((sdk) => sdk.listConnections(), { route: false });
  assert.strictEqual(viaBundle.fallback.code, viaRule.fallback.code);
  assert.deepStrictEqual(tokenReads, { dataverse: 1, powerApps: 1 });
});

// --- the host rule: what the plugin decides from an org's host is what the bundle does with it ------------------------------------------

// What the real bundle does with an org at `instanceUrl`, given the clients the plugin gives it, when every client fails the moment it is used: whether it reached for a
// client at all (`sent`) and the code it ended with. It refuses before any request, or it sends one — nothing in between — and the plugin's rule (lib/sdk-first.js
// connectivityCloudOf) is a copy of the bundle's own, which the bundle does not export, so this is what keeps the copy honest.
async function bundleOutcome(instanceUrl) {
  const attempts = [];
  const unanswered = new Error('no request is answered here');
  const refuse = async (url) => { attempts.push(url); throw unanswered; };
  const client = { get: refuse, post: refuse, patch: refuse, delete: refuse, put: refuse, postRaw: refuse, patchRaw: refuse };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connectivity-host-rule-'));
  try {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl, httpClient: client, powerAppsServiceClient: client });
    const error = await sdk.listConnections().then(() => null, (e) => e);
    return { sent: attempts.length, code: error instanceof SdkError ? error.code : undefined, reachedForAClient: Boolean(error) && error.cause === unanswered };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// [the org's host as the SDK is given it, its cloud, why it is in the table]. The plugin only ever passes an https origin that dataverseOrigin accepted, so some of these (a custom
// domain, a port, a name that is not a URL) never reach the rule from a script; they are here because the rule is the bundle's, whatever it is given.
const HOSTS = [
  ['https://contoso.crm.dynamics.com', 'Public', 'a Public org'],
  ['https://contoso.crm4.dynamics.com', 'Public', 'a Public org in a numbered region'],
  ['https://contoso.crm11.dynamics.com', 'Public', 'a region number of two digits'],
  ['https://contoso.crm0.dynamics.com', 'Public', 'any number but 9'],
  ['https://contoso.crm09.dynamics.com', 'Public', 'the digits are compared as text: 09 is not 9'],
  ['https://CONTOSO.CRM.DYNAMICS.COM', 'Public', 'upper case: the host is folded'],
  ['https://user@contoso.crm.dynamics.com', 'Public', 'user information is not part of the host'],
  ['https://contoso.crm9.dynamics.com', 'Unsupported', 'GCC'],
  ['https://contoso.crmtest.dynamics.com', 'Test', 'the Test cloud'],
  ['https://CONTOSO.CRMTEST.DYNAMICS.COM', 'Test', 'the Test cloud, in upper case'],
  ['https://user@contoso.crmtest.dynamics.com', 'Test', 'user information is not part of a Test host either'],
  ['https://a.b.crmtest.dynamics.com', 'Unsupported', 'a Test name of two labels is not an org of the Test cloud'],
  ['https://contoso-crmtest.dynamics.com', 'Unsupported', 'a name that merely ends in crmtest.dynamics.com'],
  ['https://crmtest.dynamics.com', 'Unsupported', 'the Test region with no org name'],
  ['https://contoso.crmtest.dynamics.com:8443', 'Unsupported', 'a port belongs to a Test host as well'],
  ['https://contoso.crm.microsoftdynamics.us', 'Unsupported', 'GCC High'],
  ['https://contoso.crm.appsplatform.us', 'Unsupported', 'DoD'],
  ['https://contoso.crm.dynamics.cn', 'Unsupported', 'China'],
  ['https://contoso.api.crm.dynamics.com', 'Unsupported', 'the API alias of a host is not the org\'s own'],
  ['https://contoso.crmfoo.dynamics.com', 'Unsupported', 'a region label that is neither a number nor test'],
  ['https://contoso.example.com', 'Unsupported', 'a custom domain'],
  ['https://contoso.crm.dynamics.com.example.org', 'Unsupported', 'a name that only begins like an org\'s'],
  ['https://contoso.crm.dynamics.com:8443', 'Unsupported', 'a port belongs to the host'],
  ['https://contoso.crm.dynamics.com.', 'Unsupported', 'a trailing dot makes it another host'],
  ['contoso.crm.dynamics.com', 'Unsupported', 'not a URL'],
  ['', 'Unsupported', 'nothing'],
];

test('REAL BUNDLE: the host rule — what the plugin decides from an org\'s host is what the bundle does with it: it refuses before any request, with the code the plugin names, or it sends one', async () => {
  assert.deepStrictEqual([...new Set(HOSTS.map(([, cloud]) => cloud))].sort(), ['Public', 'Test', 'Unsupported'], 'every cloud is in the table');
  for (const [host, cloud, why] of HOSTS) {
    const label = `${JSON.stringify(host)} (${why})`;
    const bundle = await bundleOutcome(host);
    const refusal = connectivityRouteRefusal(host);
    assert.strictEqual(connectivityCloudOf(host), cloud, label);
    if (cloud === 'Public') {
      assert.strictEqual(refusal, null, `${label}: the plugin hands a Public org to the SDK`);
      assert.ok(bundle.sent > 0 && bundle.reachedForAClient, `${label}: and the bundle sends a request (${JSON.stringify(bundle)})`);
    } else {
      assert.ok(refusal, `${label}: the plugin has pac answer it`);
      assert.strictEqual(bundle.sent, 0, `${label}: and the bundle refuses it before any request`);
      assert.strictEqual(refusal.code, bundle.code, `${label}: with the code the bundle gives`);
    }
  }
});

test('REAL BUNDLE: a Public org of any spelling the rule accepts is read through the SDK, with both tokens read; one it does not is not', async () => {
  for (const org of ['https://contoso.crm.dynamics.com', 'https://contoso.crm4.dynamics.com', 'https://contoso.crm11.dynamics.com', 'https://CONTOSO.CRM.DYNAMICS.COM']) {
    const { cloud, read, tokenReads } = world({ org });
    const result = await read((sdk) => sdk.listConnections());
    assert.strictEqual(result.source, 'sdk', org);
    assert.deepStrictEqual(tokenReads, { dataverse: 1, powerApps: 1 }, `${org}: the preflight reads both`);
    assert.strictEqual(cloud.requests.length, 3, `${org}: the org, BAP, the runtime`);
  }
  for (const org of ['https://contoso.crm9.dynamics.com', 'https://contoso.crmtest.dynamics.com']) {
    const { cloud, read, tokenReads } = world({ org });
    assert.strictEqual((await read((sdk) => sdk.listConnections())).source, 'pac', org);
    assert.deepStrictEqual(tokenReads, { dataverse: 0, powerApps: 0 }, org);
    assert.deepStrictEqual(cloud.requests, [], org);
  }
});

test('REAL BUNDLE: an org outside the Public and Test clouds is CONNECTIVITY_CLOUD_UNSUPPORTED before any request — pac is asked, and no token is sent anywhere', async () => {
  for (const org of ['https://contoso.crm9.dynamics.com', 'https://contoso.crm.microsoftdynamics.us', 'https://contoso.crm.dynamics.cn', 'https://contoso.crm.appsplatform.us']) {
    const { cloud, read, tokenReads } = world({ org });
    // The bundle's own answer (`route: false`), then the plugin's: the same code, and the plugin reads no token to give it.
    const viaBundle = asksPac('CONNECTIVITY_CLOUD_UNSUPPORTED')(await read((sdk) => sdk.listConnections(), { route: false }));
    const viaRule = asksPac('CONNECTIVITY_CLOUD_UNSUPPORTED')(await read((sdk) => sdk.listConnections()));
    assert.strictEqual(viaRule.fallback.code, viaBundle.fallback.code, org);
    assert.deepStrictEqual(cloud.requests, [], `${org}: nothing was requested`);
    assert.deepStrictEqual(tokenReads, { dataverse: 1, powerApps: 1 }, `${org}: only the read that left the rule out read the tokens`);
  }
});

test('REAL BUNDLE: a BAP row that does not tie the environment to this org, or names a runtime outside api.powerapps.com, is CONNECTIVITY_ENVIRONMENT_UNVERIFIED — pac is asked, and the token never reaches the named host', async () => {
  const cases = {
    'another org\'s row': { bapRow: { linkedEnvironmentMetadata: { instanceUrl: 'https://fabrikam.crm.dynamics.com/' } } },
    'a runtime that is not api.powerapps.com': { runtimeOrigin: 'https://evil.example' },
    'a runtime named with a port': { runtimeOrigin: 'https://unitedstates.api.powerapps.com:8443' },
    'a runtime over http': { runtimeOrigin: 'http://unitedstates.api.powerapps.com' },
  };
  for (const [what, config] of Object.entries(cases)) {
    const { cloud, read } = world(config);
    asksPac('CONNECTIVITY_ENVIRONMENT_UNVERIFIED')(await read((sdk) => sdk.listConnections()));
    assert.ok(cloud.requests.every((r) => r.host === 'contoso.crm.dynamics.com' || r.host === 'api.bap.microsoft.com'), `${what}: only the org and BAP were asked (${lines(cloud).join(' | ')})`);
  }
});

test('REAL BUNDLE: a connector whose definition puts parameters on a path item is READ through the SDK — they are merged into every operation under it, the operation\'s own first — and pac is not asked', async () => {
  const shared = swagger([
    { id: 'Get', path: '/items', parameters: [{ name: 'own', in: 'query', type: 'string' }, { name: 'tenant', in: 'query', required: false, type: 'string' }] },
    { id: 'Create', method: 'post', path: '/items' },
    { id: 'Other', path: '/other' },
  ]);
  shared.paths['/items'].parameters = [
    { name: 'tenant', in: 'query', required: true, type: 'string' },
    { name: 'site', in: 'header', required: true, type: 'string' },
    { name: 'trace', in: 'header', type: 'string', 'x-ms-visibility': 'internal' },
  ];
  const { cloud, read } = world({ swaggers: { shared_shared: shared } });
  const operations = await read((sdk) => sdk.listConnectorOperations('shared_shared'));
  assert.strictEqual(operations.source, 'sdk');
  assert.deepStrictEqual(operations.value.operations.map((o) => o.name), ['Get', 'Create', 'Other']);
  // The operation's own parameters come first and win a clash (`tenant`: the operation says optional, the path item required); the path item's follow, an internal one left out
  // as it is for an operation's own; an operation under another path item has none of them. Swagger 2.0: https://swagger.io/specification/v2/#path-item-object
  const get = await read((sdk) => sdk.getConnectorOperationSchema('shared_shared', 'Get'));
  assert.deepStrictEqual(get.value, { operation: 'Get', parameters: [{ name: 'own', required: false }, { name: 'tenant', required: false }, { name: 'site', required: true }], response: {} });
  assert.strictEqual(get.source, 'sdk');
  assert.deepStrictEqual((await read((sdk) => sdk.getConnectorOperationSchema('shared_shared', 'Create'))).value.parameters, [{ name: 'tenant', required: true }, { name: 'site', required: true }]);
  assert.deepStrictEqual((await read((sdk) => sdk.getConnectorOperationSchema('shared_shared', 'Other'))).value.parameters, []);
  assert.ok(cloud.toPowerApps().some((r) => r.path === '/providers/Microsoft.PowerApps/apis/shared_shared'), 'the connector was read from the service');
});

test('REAL BUNDLE: a connector definition the SDK still refuses — an OpenAPI 3 document, a path item that holds a $ref — is CONNECTOR_SWAGGER_UNSUPPORTED, and pac is asked for it', async () => {
  const openApi3 = { ...swagger([{ id: 'Get', path: '/items' }]), openapi: '3.0.1' };
  const pathRef = swagger([{ id: 'Get', path: '/items' }]);
  pathRef.paths['/items'].$ref = '#/paths/~1other';
  const { read } = world({ swaggers: { shared_openapi3: openApi3, shared_pathref: pathRef } });
  for (const connector of ['shared_openapi3', 'shared_pathref']) {
    asksPac('CONNECTOR_SWAGGER_UNSUPPORTED')(await read((sdk) => sdk.listConnectorOperations(connector)));
    asksPac('CONNECTOR_SWAGGER_UNSUPPORTED')(await read((sdk) => sdk.getConnectorOperationSchema(connector, 'Get')));
  }
});

test('REAL BUNDLE: no Power Apps token is a refusal of the preflight — the SDK is never made, the org is never read, pac is asked', async () => {
  const { cloud, read } = world();
  const result = asksPac('POWER_APPS_TOKEN_UNAVAILABLE')(await read((sdk) => sdk.listConnections(), { tokens: { getPowerAppsTokenAsync: async () => null } }));
  assert.match(result.fallback.message, /no Azure CLI token for the Power Apps service/);
  assert.deepStrictEqual(cloud.requests, []);
});

test('REAL BUNDLE: a token that goes missing after the preflight arrives wrapped in the SDK\'s ConnectionError, and is still a refusal with the client\'s own words', async () => {
  const { cloud, read } = world();
  const noToken = createPowerAppsServiceClient({ getToken: () => null, tokenFailureMessage: () => 'the Power Apps token went away', request: cloud.request });
  const result = asksPac('POWER_APPS_TOKEN_UNAVAILABLE')(await read((sdk) => sdk.listConnections(), { serviceClient: noToken }));
  assert.strictEqual(result.fallback.message, 'the Power Apps token went away');
});

// --- failures: thrown with the SDK\'s code, never answered by pac -------------------------------------------------------------------

// A read that must FAIL: if the rule asked pac, `read` would resolve with its answer and this would not reject.
async function fails(read, fromSdk, check, options) {
  await assert.rejects(read(fromSdk, options), (err) => { check(err); return true; });
}

test('REAL BUNDLE: a route that serves and fails is a failure — a 500 or 502 from BAP, a 429, 400 or 503 from the runtime, a missing connector or environment, a 410 that is not "decommissioned", any status from the ORG — and pac is not asked', async () => {
  const json = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const onBap = (status, message = 'boom') => (r) => (r.host === 'api.bap.microsoft.com' ? json(status, { error: { message } }) : undefined);
  const onConnections = (status, body) => (r) => (r.path === '/providers/Microsoft.PowerApps/connections' ? json(status, body) : undefined);
  const onOrg = (status) => (r) => (r.path.includes('RetrieveCurrentOrganization') ? json(status, { error: { message: 'denied' } }) : undefined);
  const cases = [
    ['a 500 from BAP', { override: onBap(500) }, (sdk) => sdk.listConnections(), 500],
    ['a 502 from BAP', { override: onBap(502) }, (sdk) => sdk.listConnections(), 502],
    ['a 404 from BAP (no such environment)', { override: onBap(404, 'no such environment') }, (sdk) => sdk.listConnections(), 404],
    ['a 429 from the runtime', { override: onConnections(429, { error: { message: 'slow down' } }) }, (sdk) => sdk.listConnections(), 429],
    ['a 400 from the runtime', { override: onConnections(400, { error: { message: 'bad request' } }) }, (sdk) => sdk.listConnections(), 400],
    ['a 503 from the runtime', { override: onConnections(503, { error: { message: 'unavailable' } }) }, (sdk) => sdk.listConnections(), 503],
    ['a missing connector', {}, (sdk) => sdk.listConnectorOperations('shared_nothere'), 404],
    ['a 410 with another code', { decommissioned: false, override: onConnections(410, { error: { code: 'Gone', message: 'gone' } }) }, (sdk) => sdk.listConnections(), 410],
    // Dataverse's own answers are not the connectivity routes': the SDK keeps them as the ConnectionErrors they are, a 401 and a 403 included.
    ['the org refusing the environment read (401)', { override: onOrg(401) }, (sdk) => sdk.listConnections(), 401],
    ['the org refusing the environment read (403)', { override: onOrg(403) }, (sdk) => sdk.listConnections(), 403],
  ];
  for (const [what, config, fromSdk, status] of cases) {
    const { read } = world(config);
    await fails(read, fromSdk, (err) => {
      assert.strictEqual(err.code, 'CONNECTION_ERROR', what);
      assert.strictEqual(err.statusCode, status, what);
      assert.strictEqual(connectivityRefusal(err), null, `${what} is not a refusal`);
    });
  }
});

// A 401 or 403 from either connectivity route — the SDK's own typed answer (api/connectivityShared.ts connectivityUnauthorized), which says in its own words to supply another token or fall
// back to pac. The plugin has no other token, so it falls back, and says so.
const UNAUTHORIZED_BODY = { error: { code: 'AuthorizationFailed', message: 'the caller may not read this', innererror: { code: 'TokenNotAllowed' } } };
const unauthorizedReads = [
  ['the Business Application Platform', (r) => r.host === 'api.bap.microsoft.com', (sdk) => sdk.listConnections()],
  ['the connection list', (r) => r.path === '/providers/Microsoft.PowerApps/connections', (sdk) => sdk.listConnections()],
  ['a connector\'s operations', (r) => r.path.startsWith('/providers/Microsoft.PowerApps/apis/'), (sdk) => sdk.listConnectorOperations('shared_msnweather')],
  ['an operation\'s schema', (r) => r.path.startsWith('/providers/Microsoft.PowerApps/apis/'), (sdk) => sdk.getConnectorOperationSchema('shared_msnweather', 'CurrentWeather')],
];

test('REAL BUNDLE: a 401 or 403 from the Business Application Platform or the Power Apps host is CONNECTIVITY_UNAUTHORIZED — the SDK\'s own typed answer — and a refusal: pac is asked, with the SDK\'s words', async () => {
  const json = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const status of [401, 403]) {
    for (const [what, matches, fromSdk] of unauthorizedReads) {
      const { cloud, read } = world({ override: (r) => (matches(r) ? json(status, UNAUTHORIZED_BODY) : undefined) });
      const result = asksPac('CONNECTIVITY_UNAUTHORIZED')(await read(fromSdk));
      assert.match(result.fallback.message, new RegExp(`^A connectivity request was refused with HTTP ${status} \\(AuthorizationFailed; TokenNotAllowed\\)`), `${status} from ${what}`);
      assert.match(result.fallback.message, /Supply a valid token for this route, or fall back to pac\.$/, `${status} from ${what}: the SDK's advice`);
      assert.ok(cloud.requests.length >= 2, `${status} from ${what}: the read got as far as the refused request`);
    }
  }
});

test('REAL BUNDLE: what a service says in a body never chooses the refusal — a 401 or 403 that names another refusal is still the SDK\'s CONNECTIVITY_UNAUTHORIZED; a 400, 404, 429 or 500 that names one is a failure', async () => {
  const json = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const forged = (code) => ({ code, error: { code, message: 'service denied this request' }, message: 'service denied this request' });
  for (const code of ['CONNECTIVITY_CLOUD_UNSUPPORTED', 'CONNECTIVITY_ROUTE_DECOMMISSIONED', 'CONNECTIVITY_NOT_CONFIGURED', 'POWER_APPS_TOKEN_UNAVAILABLE']) {
    for (const status of [401, 403]) {
      const { read } = world({ override: (r) => (r.host === 'api.bap.microsoft.com' ? json(status, forged(code)) : undefined) });
      const result = asksPac('CONNECTIVITY_UNAUTHORIZED')(await read((sdk) => sdk.listConnections()));
      assert.notStrictEqual(result.fallback.code, code, `HTTP ${status} naming ${code}: the code is the SDK's, not the body's`);
    }
    for (const status of [400, 404, 429, 500]) {
      const { read } = world({ override: (r) => (r.host === 'api.bap.microsoft.com' ? json(status, forged(code)) : undefined) });
      await fails(read, (sdk) => sdk.listConnections(), (err) => {
        assert.strictEqual(err.code, 'CONNECTION_ERROR', `HTTP ${status} naming ${code}`);
        assert.strictEqual(err.statusCode, status);
        assert.strictEqual(connectivityRefusal(err), null);
      });
    }
  }
});

test('REAL BUNDLE: an answer the SDK cannot read is a failure with its own code, not a partial list and not pac\'s answer', async () => {
  const json = (body) => ({ statusCode: 200, headers: {}, body: JSON.stringify(body) });
  const cases = [
    ['a page whose value is not a list', { override: (r) => (r.path === '/providers/Microsoft.PowerApps/connections' ? json({ value: 'nope' }) : undefined) }, (sdk) => sdk.listConnections(), 'CONNECTIVITY_RESPONSE_UNREADABLE'],
    ['a row with no name', { connections: [{ ...CONNECTIONS[0], name: '' }] }, (sdk) => sdk.listConnections(), 'CONNECTIVITY_RESPONSE_UNREADABLE'],
    ['a connector with no swagger', { override: (r) => (r.path.includes('/apis/') ? json({ properties: {} }) : undefined) }, (sdk) => sdk.listConnectorOperations('shared_msnweather'), 'CONNECTIVITY_RESPONSE_UNREADABLE'],
    ['a missing operation', {}, (sdk) => sdk.getConnectorOperationSchema('shared_msnweather', 'NoSuchOperation'), 'CONNECTOR_OPERATION_NOT_FOUND'],
    ['a bad connector name', {}, (sdk) => sdk.listConnectorOperations('shared/../x'), 'INVALID_ARGUMENT'],
  ];
  for (const [what, config, fromSdk, code] of cases) {
    const { read } = world(config);
    await fails(read, fromSdk, (err) => assert.strictEqual(err.code, code, `${what}: ${err.message}`));
  }
});

test('REAL BUNDLE: a next-page link on another origin is refused before it is sent, and a redirect is a failure whose Location is never requested', async () => {
  const { cloud, read } = world({
    override: (r) => {
      if (r.path === '/providers/Microsoft.PowerApps/connections') {
        return { statusCode: 200, headers: {}, body: JSON.stringify({ value: [CONNECTIONS[0]], nextLink: 'https://evil.example/providers/Microsoft.PowerApps/connections?page=2' }) };
      }
      return undefined;
    },
  });
  await fails(read, (sdk) => sdk.listConnections(), (err) => assert.strictEqual(err.code, 'INVALID_ARGUMENT'));
  assert.ok(cloud.requests.every((r) => r.host !== 'evil.example'), 'the link was never followed');

  const redirected = world({ override: (r) => (r.path === '/providers/Microsoft.PowerApps/connections' ? { statusCode: 302, headers: { location: 'https://evil.example/steal' }, body: '' } : undefined) });
  await fails(redirected.read, (sdk) => sdk.listConnections(), (err) => {
    assert.strictEqual(err.code, 'CONNECTION_ERROR');
    assert.strictEqual(err.statusCode, 302);
  });
  assert.ok(redirected.cloud.requests.every((r) => r.host !== 'evil.example'));
});

// --- the scripts, in real processes ---------------------------------------------------------------------------------------------

const REFERENCES = [{ connectionreferencelogicalname: 'new_weather', connectorid: WEATHER, connectionid: ID(3) }];

test('PROCESS: list-connections.js prints the SDK\'s connections as PAC\'s rows with readiness, the source, and needs neither pac nor az', () => {
  const run = runScript('list-connections.js', [ORG], { platform: { connections: CONNECTIONS, references: REFERENCES } });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(run.stderr, '');
  assert.strictEqual(run.lines.length, 1, 'one line');
  assert.deepStrictEqual(JSON.parse(run.lines[0]), {
    ok: true,
    connections: [
      { connectorId: WEATHER, connectionId: ID(3), displayName: 'weather', readyToBind: true, connectionReferences: ['new_weather'] },
      { connectorId: SQL, connectionId: ID(1), displayName: 'Contoso SQL', readyToBind: false, connectionReferences: [] },
    ],
    connectionReferences: [{ logicalName: 'new_weather', connectorId: WEATHER, connectionId: ID(3) }],
    connectionsSource: 'sdk',
  });
  assert.strictEqual(run.requests.length, 3, 'the org, BAP, the runtime');
  assert.deepStrictEqual(run.pacCalls, []);
});

// What `pac connection list` prints (live capture, PAC CLI 2.12.2; every value here is synthetic).
const PAC_GRID = [
  'Connected as [maker001]',
  'Id                               Name     API Id                                                Status',
  `${ID(3)} weather  ${WEATHER}  Connected`,
  '',
].join('\r\n');

test('PROCESS: in the Test cloud list-connections.js asks pac AT ONCE — nothing is requested of the org, BAP or a runtime and no Azure CLI token is read for the SDK — and says so, with the code the SDK gives, in the same rows', () => {
  const run = runScript('list-connections.js', [TEST_ORG], {
    platform: { org: TEST_ORG, references: REFERENCES },
    pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual(out.connections, [{ connectorId: WEATHER, connectionId: ID(3), displayName: 'weather', readyToBind: true, connectionReferences: ['new_weather'] }]);
  assert.strictEqual(out.connectionsSource, 'pac');
  assert.strictEqual(out.connectionsFallback.code, 'CONNECTIVITY_NOT_CONFIGURED');
  assert.match(out.connectionsFallback.message, /Test cloud[\s\S]*Power Platform API[\s\S]*pac reads them\. Nothing was requested\.$/);
  assert.deepStrictEqual(run.requests, [], 'the fakes saw no request');
  assert.deepStrictEqual(run.tokenReads, { dataverse: 0, powerApps: 0 }, 'and no Azure CLI process was started for the SDK path');
  assert.deepStrictEqual(run.pacCalls.map((c) => c.args), [['connection', 'list', '--environment', TEST_ORG]], 'the call PAC has always been given, pinned to the environment asked about — not to the organization pac has active');
});

test('PROCESS: an org outside the Public and Test clouds — GCC, GCC High, DoD, China — is answered by pac at once as CONNECTIVITY_CLOUD_UNSUPPORTED, by list-connections.js and connector.js alike, with nothing requested and no token read', () => {
  const operations = 'Connected as [maker001]\r\n{"operations":[{"name":"CurrentWeather","summary":"Now"}]}\r\n';
  for (const org of ['https://contoso.crm9.dynamics.com', 'https://contoso.crm.microsoftdynamics.us', 'https://contoso.crm.appsplatform.us', 'https://contoso.crm.dynamics.cn']) {
    const list = runScript('list-connections.js', [org], { platform: { org, references: REFERENCES }, pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] } });
    assert.strictEqual(list.status, 0, `${org}: ${list.stderr}`);
    const listed = JSON.parse(list.lines[0]);
    assert.deepStrictEqual([listed.connectionsSource, listed.connectionsFallback.code], ['pac', 'CONNECTIVITY_CLOUD_UNSUPPORTED'], org);
    assert.deepStrictEqual([list.requests, list.tokenReads], [[], { dataverse: 0, powerApps: 0 }], org);
    assert.deepStrictEqual(list.pacCalls.map((c) => c.args), [['connection', 'list', '--environment', org]], org);

    const connector = runScript('connector.js', ['operations', '--env', org, '--connector-id', 'shared_msnweather', '--connection-id', ID(3)], { platform: { org }, pac: { responses: [{ match: ['model', 'genpage', 'list-connector-operations'], stdout: operations }] } });
    assert.strictEqual(connector.status, 0, `${org}: ${connector.stderr}`);
    const answered = JSON.parse(connector.lines[0]);
    assert.deepStrictEqual([answered.source, answered.fallback.code], ['pac', 'CONNECTIVITY_CLOUD_UNSUPPORTED'], org);
    assert.deepStrictEqual([connector.requests, connector.tokenReads], [[], { dataverse: 0, powerApps: 0 }], org);
    assert.strictEqual(connector.pacCalls.length, 1, org);
  }
});

test('PROCESS: a 410 ServiceDecommissioned from the Power Apps host of a Public org is still a refusal — list-connections.js and connector.js ask pac, with CONNECTIVITY_ROUTE_DECOMMISSIONED, after the SDK read as far as the runtime', () => {
  const list = runScript('list-connections.js', [ORG], {
    platform: { connections: CONNECTIONS, references: REFERENCES, decommissioned: true },
    pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] },
  });
  assert.strictEqual(list.status, 0, list.stderr);
  const listed = JSON.parse(list.lines[0]);
  assert.deepStrictEqual([listed.connectionsSource, listed.connectionsFallback.code], ['pac', 'CONNECTIVITY_ROUTE_DECOMMISSIONED']);
  assert.match(listed.connectionsFallback.message, /decommissioned/);
  assert.strictEqual(list.requests.length, 3, 'the org, BAP, the runtime — which answered 410');
  assert.deepStrictEqual(list.pacCalls.map((c) => c.args), [['connection', 'list', '--environment', ORG]]);

  const connector = runScript('connector.js', ['operations', ...CONNECTOR_ARGS()], {
    platform: { swaggers: SWAGGERS, decommissioned: true },
    pac: { responses: [{ match: ['model', 'genpage', 'list-connector-operations'], stdout: 'Connected as [maker001]\r\n{"operations":[{"name":"CurrentWeather","summary":"Now"}]}\r\n' }] },
  });
  assert.strictEqual(connector.status, 0, connector.stderr);
  assert.strictEqual(JSON.parse(connector.lines[0]).fallback.code, 'CONNECTIVITY_ROUTE_DECOMMISSIONED');
  assert.strictEqual(connector.requests.length, 3);
});

test('PROCESS: with no Azure CLI token list-connections.js asks pac and sends no request to the org or the Power Apps service', () => {
  const run = runScript('list-connections.js', [ORG], {
    platform: { connections: CONNECTIONS, references: REFERENCES, noPowerAppsToken: true },
    pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.connectionsSource, 'pac');
  assert.strictEqual(out.connectionsFallback.code, 'POWER_APPS_TOKEN_UNAVAILABLE');
  assert.deepStrictEqual(run.requests, [], 'the connection references are read by the stand-in for dataverseRequest, and the SDK was never made');
  assert.deepStrictEqual(run.tokenReads, { dataverse: 1, powerApps: 1 }, 'a Public org reads both tokens first — the preflight that found the Power Apps one missing');
});

test('PROCESS: a failure of a route that serves fails list-connections.js — exit 1, an ok:false line with the SDK\'s code, its words on stderr — and pac is never run', () => {
  const run = runScript('list-connections.js', [ORG], {
    platform: { connections: CONNECTIONS, failures: [{ host: 'api.bap.microsoft.com', status: 500, body: { error: { message: 'The gateway failed' } } }] },
    pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] },
  });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.lines.length, 1, 'one line');
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.code], [false, 'CONNECTION_ERROR']);
  assert.match(out.error, /HTTP 500 from https:\/\/api\.bap\.microsoft\.com\/[\s\S]*The gateway failed/);
  assert.match(run.stderr, /HTTP 500 from https:\/\/api\.bap\.microsoft\.com\/[\s\S]*The gateway failed/);
  assert.deepStrictEqual(run.pacCalls, []);
});

test('PROCESS: a 401 or 403 from the Business Application Platform or the Power Apps host is a refusal — list-connections.js asks pac and says so, as CONNECTIVITY_UNAUTHORIZED with the SDK\'s words, in the same rows', () => {
  for (const [status, host] of [[401, 'api.bap.microsoft.com'], [403, 'api.bap.microsoft.com'], [401, 'unitedstates.api.powerapps.com'], [403, 'unitedstates.api.powerapps.com']]) {
    const run = runScript('list-connections.js', [ORG], {
      platform: { connections: CONNECTIONS, references: REFERENCES, failures: [{ host, status, body: UNAUTHORIZED_BODY }] },
      pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] },
    });
    assert.strictEqual(run.status, 0, `${status} from ${host}: ${run.stderr}`);
    const out = JSON.parse(run.lines[0]);
    assert.strictEqual(out.connectionsSource, 'pac', `${status} from ${host}`);
    assert.strictEqual(out.connectionsFallback.code, 'CONNECTIVITY_UNAUTHORIZED', `${status} from ${host}`);
    assert.match(out.connectionsFallback.message, new RegExp(`^A connectivity request was refused with HTTP ${status} \\(AuthorizationFailed; TokenNotAllowed\\)[\\s\\S]*fall back to pac\\.$`));
    assert.deepStrictEqual(out.connections.map((c) => c.connectionId), [ID(3)], 'the rows are pac\'s');
    assert.deepStrictEqual(run.pacCalls.map((c) => c.args), [['connection', 'list', '--environment', ORG]], `${status} from ${host}`);
  }
});

// What list-connections.js prints for a failure past its arguments, whoever raised it — the SDK's read, pac, the connection references, an origin that is not a Dataverse one: exit 1, ONE
// line on stdout that is an ok:false object of pure printable ASCII (a console code page garbles anything else), and the same message on stderr. `code` is the error's own, and only when
// it has one: the SDK's errors do, the others do not. A failure of pac — asked because the SDK refused — also says why: `connectionsFallback`, the same key a listing pac gave uses, with the
// refusal's code (`fallback`) — and a failure that is not pac's does not.
function assertFailureLine(run, what, { error, code, fallback }) {
  assert.strictEqual(run.status, 1, `${what}: ${run.stderr}`);
  assert.match(run.stdout, /^[\x20-\x7e]+\n$/, `${what}: one line of printable ASCII, got ${JSON.stringify(run.stdout)}`);
  const out = JSON.parse(run.stdout);
  assert.deepStrictEqual(Object.keys(out), ['ok', 'error', ...(code ? ['code'] : []), ...(fallback ? ['connectionsFallback'] : [])], what);
  assert.strictEqual(out.ok, false, what);
  assert.match(out.error, error, what);
  if (code) assert.strictEqual(out.code, code, what);
  if (fallback) assert.strictEqual(out.connectionsFallback.code, fallback, `${what}: says why pac was asked`);
  assert.strictEqual(run.stderr, `${out.error.trim()}\n`, `${what}: the same message on stderr`);
  return out;
}

test('PROCESS: every failure of list-connections.js past its arguments is ONE ok:false line of pure ASCII — the SDK\'s own with its code, any other with none — with the message on stderr and exit 1', () => {
  const accent = 'Jos\u00e9';
  const cases = [
    {
      what: 'the SDK\'s read fails — a 500 from BAP',
      argv: [ORG],
      platform: { connections: CONNECTIONS, failures: [{ host: 'api.bap.microsoft.com', status: 500, body: { error: { message: `The gateway failed for ${accent}` } } }] },
      pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] },
      expect: { code: 'CONNECTION_ERROR', error: new RegExp(`^HTTP 500 from https://api\\.bap\\.microsoft\\.com/[\\s\\S]*The gateway failed for ${accent}`) },
      saw: (run) => {
        assert.match(run.stdout, /for Jos\\u00e9/, 'the accent is an escape');
        assert.deepStrictEqual(run.pacCalls, [], 'a failure that is not a refusal is not answered by pac');
      },
    },
    {
      what: 'pac, asked at once for a Test cloud org, exits non-zero',
      argv: [TEST_ORG],
      platform: { org: TEST_ORG, references: REFERENCES },
      pac: { responses: [{ match: ['connection', 'list'], status: 1, stderr: `Error: the sign-in for ${accent} has expired\n` }] },
      expect: { fallback: 'CONNECTIVITY_NOT_CONFIGURED', error: new RegExp(`^pac connection list failed \\(exit 1\\): Error: the sign-in for ${accent} has expired$`) },
      saw: (run) => {
        assert.match(run.stdout, /for Jos\\u00e9 has expired/, 'the accent is an escape');
        assert.strictEqual(run.pacCalls.length, 1);
      },
    },
    {
      what: 'pac, asked at once for a Test cloud org, is not installed',
      argv: [TEST_ORG],
      platform: { org: TEST_ORG, references: REFERENCES },
      expect: { fallback: 'CONNECTIVITY_NOT_CONFIGURED', error: /^pac connection list could not run: .*Ensure the PAC CLI is installed and on PATH/ },
      saw: (run) => assert.deepStrictEqual(run.pacCalls, []),
    },
    {
      what: 'pac exits 0 with output that is not a connection list',
      argv: [TEST_ORG],
      platform: { org: TEST_ORG, references: REFERENCES },
      pac: { responses: [{ match: ['connection', 'list'], stdout: 'Connected as [maker001]\r\nThis is not a table at all\r\n' }] },
      expect: { fallback: 'CONNECTIVITY_NOT_CONFIGURED', error: /^pac connection list printed output this script could not read \u2014 no connection table or JSON list/ },
      saw: (run) => assert.match(run.stdout, /could not read \\u2014 no connection table/, 'the em dash of the message is an escape'),
    },
    {
      what: 'the origin is not a Dataverse one',
      argv: ['https://contoso.example.com'],
      platform: { connections: CONNECTIONS },
      pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] },
      expect: { error: /^'https:\/\/contoso\.example\.com' is not a Dataverse environment URL\./ },
      saw: (run) => assert.deepStrictEqual([run.requests, run.pacCalls, run.tokenReads], [[], [], { dataverse: 0, powerApps: 0 }], 'nothing is asked of anyone'),
    },
    {
      what: 'the connection references cannot be read',
      argv: [ORG],
      platform: { connections: CONNECTIONS, referencesAnswer: { status: 500, data: { error: { message: 'r\u00e9f\u00e9rences illisibles' } } } },
      expect: { error: /^List connection references failed: HTTP 500 \u2014 r\u00e9f\u00e9rences illisibles$/ },
      saw: (run) => {
        assert.match(run.stdout, /HTTP 500 \\u2014 r\\u00e9f\\u00e9rences/, 'the em dash and the accents are escapes');
        assert.strictEqual(run.requests.length, 3, 'the SDK read the connections first');
      },
    },
  ];
  for (const { what, argv, platform, pac, expect, saw } of cases) {
    const run = runScript('list-connections.js', argv, { platform, ...(pac ? { pac } : {}) });
    assertFailureLine(run, what, expect);
    saw(run);
  }
});

test('PROCESS: a pac that fails after the SDK refused says why pac was asked — the failure line carries the refusal as `connectionsFallback`, the same reason a listing pac gave prints — for the Test cloud and for a route the SDK read as far as it could', () => {
  // A Test-cloud org: pac is asked at once, and there is none on the machine.
  const missing = runScript('list-connections.js', [TEST_ORG], { platform: { org: TEST_ORG, references: REFERENCES } });
  const out = assertFailureLine(missing, 'the Test cloud, no pac', { error: /^pac connection list could not run: /, fallback: 'CONNECTIVITY_NOT_CONFIGURED' });
  const worked = JSON.parse(runScript('list-connections.js', [TEST_ORG], {
    platform: { org: TEST_ORG, references: REFERENCES },
    pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] },
  }).lines[0]);
  assert.deepStrictEqual(out.connectionsFallback, worked.connectionsFallback, 'the same reason, whether pac then worked or not');
  assert.match(out.connectionsFallback.message, /Test cloud[\s\S]*Power Platform API[\s\S]*pac reads them\. Nothing was requested\.$/);

  // A Public org whose BAP host refuses the token: the SDK read as far as BAP and refused, and pac failed too. The reason is the SDK's own, and the token the service repeated in it is in neither stream.
  const body = { error: { code: `rejected ${POWER_APPS_TOKEN}`, message: `the token ${POWER_APPS_TOKEN} may not read this`, innererror: { code: `inner ${POWER_APPS_TOKEN}` } } };
  const refused = runScript('list-connections.js', [ORG], {
    platform: { connections: CONNECTIONS, references: REFERENCES, failures: [{ host: 'api.bap.microsoft.com', status: 403, body }] },
    pac: { responses: [{ match: ['connection', 'list'], status: 1, stderr: 'Error: the sign-in has expired\n' }] },
  });
  const unauthorized = assertFailureLine(refused, 'a refused token, and pac failing', { error: /^pac connection list failed \(exit 1\): Error: the sign-in has expired$/, fallback: 'CONNECTIVITY_UNAUTHORIZED' });
  assert.match(unauthorized.connectionsFallback.message, /refused with HTTP 403 \(rejected <token>; inner <token>\)/);
  assert.ok(!refused.stdout.includes(POWER_APPS_TOKEN) && !refused.stderr.includes(POWER_APPS_TOKEN), 'the token is in neither stream');
  assert.strictEqual(refused.pacCalls.length, 1);
});

// The connection references are read with `dataverseRequest` (lib/dataverse-auth.js), whose failure this script prints. Here the REAL `dataverseRequest` runs over the fake transport (`realDataverseRequest` in the
// preload) — its token handling and its handling of an answer are the real ones — and the service repeats the Dataverse token in the refusal of that read.
const DATAVERSE_ECHO = ['syntheticDataverseHeaderPartNotARealCredential', 'syntheticDataversePayloadPartNotARealCredential', 'syntheticDataverseSignaturePartNotARealCredential'].join('.');
const referencesRead = (status, body) => ({ host: new URL(ORG).hostname, pathIncludes: 'connectionreferences', method: 'GET', status, body });

test('PROCESS: a refused read of the connection references prints no Dataverse token that the service repeats — whole or in a part — and keeps its status and its words; the failure is still ONE ok:false line', () => {
  const [, payload] = DATAVERSE_ECHO.split('.');
  const run = runScript('list-connections.js', [ORG], {
    platform: {
      tokens: { dataverse: DATAVERSE_ECHO },
      connections: CONNECTIONS,
      realDataverseRequest: true,
      failures: [referencesRead(403, { error: { code: '0x80048306', message: `Rejected bearer ${DATAVERSE_ECHO}; the claim ${payload} may not read connection references` } })],
    },
  });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.lines.length, 1);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual(out, { ok: false, error: 'List connection references failed: HTTP 403 \u2014 Rejected bearer <token>; the claim <token> may not read connection references' });
  assert.strictEqual(run.stderr.trim(), out.error);
  for (const text of [run.stdout, run.stderr]) {
    for (const secret of [DATAVERSE_ECHO, ...DATAVERSE_ECHO.split('.')]) assert.ok(!text.includes(secret), `the Dataverse token (or a part of it) was printed: ${text}`);
  }
  assert.strictEqual(run.requests.filter((r) => r.path.endsWith('/connectionreferences')).length, 1, 'the read was made once: a 403 is not retried');
});

test('PROCESS control: a read of the connection references that SUCCEEDS is printed as it came, even when a value in it is the token\'s own text — a success is the caller\'s data and is never altered', () => {
  const run = runScript('list-connections.js', [ORG], {
    platform: {
      tokens: { dataverse: DATAVERSE_ECHO },
      connections: CONNECTIONS,
      realDataverseRequest: true,
      failures: [referencesRead(200, { value: [{ connectionreferencelogicalname: 'new_weather', connectorid: WEATHER, connectionid: DATAVERSE_ECHO }] })],
    },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual(out.connectionReferences, [{ logicalName: 'new_weather', connectorId: WEATHER, connectionId: DATAVERSE_ECHO }]);
});

test('PROCESS: a usage error of list-connections.js — no environment URL, a flag it does not take — is the problem on stderr alone: exit 1, nothing on stdout, nothing asked of anyone', () => {
  for (const [what, argv, problem] of [
    ['no environment URL', [], /^Usage: node list-connections\.js <envUrl>\n$/],
    ['a flag it does not take', ['--environment', ORG], /^\u2717 unknown flag\(s\): --environment[^\n]*\nUsage: node list-connections\.js <envUrl>\n$/],
  ]) {
    const run = runScript('list-connections.js', argv, { platform: { connections: CONNECTIONS } });
    assert.strictEqual(run.status, 1, what);
    assert.strictEqual(run.stdout, '', `${what}: a usage error is not a result, so no line`);
    assert.match(run.stderr, problem, what);
    assert.deepStrictEqual([run.requests, run.pacCalls], [[], []], what);
  }
});

test('PROCESS: the successful line of list-connections.js keeps non-ASCII text as it is — only a failure line is escaped — and exits 0 with nothing on stderr', () => {
  const name = 'Caf\u00e9 \u2014 Contoso';
  const run = runScript('list-connections.js', [ORG], { platform: { connections: [connectionRow({ id: ID(1), apiId: SQL, displayName: name })], references: [] } });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(run.stderr, '');
  assert.strictEqual(run.lines.length, 1);
  assert.ok(run.stdout.includes(name), 'the name is on the line as it is, not as an escape');
  assert.strictEqual(JSON.parse(run.lines[0]).connections[0].displayName, name);
});

const CONNECTOR_ARGS = (...rest) => ['--env', ORG, '--connector-id', 'shared_msnweather', '--connection-id', ID(3), ...rest];

test('PROCESS: connector.js operations and schema --operation print pac\'s JSON from the SDK — one ASCII line, ok and source added — with no pac on the machine', () => {
  const ops = runScript('connector.js', ['operations', ...CONNECTOR_ARGS()], { platform: { swaggers: SWAGGERS } });
  assert.strictEqual(ops.status, 0, ops.stderr);
  assert.strictEqual(ops.lines.length, 1);
  assert.strictEqual(ops.lines[0], '{"ok":true,"operations":[{"name":"CurrentWeather","summary":"Get current weather"},{"name":"Ping","summary":null}],"source":"sdk"}');
  assert.deepStrictEqual(ops.pacCalls, []);

  const schema = runScript('connector.js', ['schema', ...CONNECTOR_ARGS('--operation', 'CurrentWeather')], { platform: { swaggers: SWAGGERS } });
  assert.strictEqual(schema.status, 0, schema.stderr);
  assert.deepStrictEqual(JSON.parse(schema.lines[0]), {
    ok: true,
    operation: 'CurrentWeather',
    parameters: [{ name: 'Location', required: true }],
    response: { type: 'object', properties: { temp: { type: 'number', description: 'Temperature' } } },
    source: 'sdk',
  });
});

test('PROCESS: connector.js prints a summary with non-ASCII text as escapes — the line stays pure ASCII for any console', () => {
  const run = runScript('connector.js', ['operations', ...CONNECTOR_ARGS()], {
    platform: { swaggers: { shared_msnweather: swagger([{ id: 'Forecast', summary: 'Pr\u00e9vision \u2014 7 jours' }]) } },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.stdout, /^[\x00-\x7e\r\n]*$/);
  assert.strictEqual(JSON.parse(run.lines[0]).operations[0].summary, 'Pr\u00e9vision \u2014 7 jours');
});

test('PROCESS: connector.js reads a connector whose definition puts parameters on a path item through the SDK — merged into the operation, one ASCII line, source "sdk" — and never asks pac', () => {
  const shared = swagger([{ id: 'Get', path: '/items', parameters: [{ name: 'own', in: 'query', type: 'string' }] }]);
  shared.paths['/items'].parameters = [{ name: 'tenant', in: 'query', required: true, type: 'string' }];
  const run = runScript('connector.js', ['schema', '--env', ORG, '--connector-id', 'shared_shared', '--connection-id', ID(3), '--operation', 'Get'], {
    platform: { swaggers: { shared_shared: shared } },
    pac: { responses: [{ match: ['model'], stdout: '{"operation":"Get","parameters":[],"response":{}}' }] },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.lines[0]), { ok: true, operation: 'Get', parameters: [{ name: 'own', required: false }, { name: 'tenant', required: true }], response: {}, source: 'sdk' });
  assert.deepStrictEqual(run.pacCalls, []);
});

test('PROCESS: in the Test cloud connector.js asks pac AT ONCE — pinned to the environment, with the connector\'s short name, nothing requested and no token read — and says why', () => {
  const run = runScript('connector.js', ['operations', '--env', TEST_ORG, '--connector-id', WEATHER, '--connection-id', ID(3)], {
    platform: { org: TEST_ORG },
    pac: { responses: [{ match: ['model', 'genpage', 'list-connector-operations'], stdout: 'Connected as [maker001]\r\n{"operations":[{"name":"CurrentWeather","summary":"Now"}]}\r\n' }] },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual(out.operations, [{ name: 'CurrentWeather', summary: 'Now' }]);
  assert.strictEqual(out.source, 'pac');
  assert.strictEqual(out.fallback.code, 'CONNECTIVITY_NOT_CONFIGURED');
  assert.match(out.fallback.message, /Test cloud[\s\S]*Power Platform API/);
  assert.deepStrictEqual(run.requests, [], 'the fakes saw no request');
  assert.deepStrictEqual(run.tokenReads, { dataverse: 0, powerApps: 0 }, 'and no Azure CLI process was started');
  assert.deepStrictEqual(run.pacCalls.map((c) => c.args), [['model', 'genpage', 'list-connector-operations', '--environment', TEST_ORG, '--connector-id', 'shared_msnweather', '--connection-id', ID(3)]]);

  const schema = runScript('connector.js', ['schema', '--env', TEST_ORG, '--connector-id', 'shared_msnweather', '--connection-id', ID(3), '--operation', 'CurrentWeather'], {
    platform: { org: TEST_ORG },
    pac: { responses: [{ match: ['model', 'genpage', 'get-connector-schema'], stdout: 'Connected as [maker001]\n{"operation":"CurrentWeather","parameters":[{"name":"Location","required":true}],"response":{}}\n' }] },
  });
  assert.strictEqual(schema.status, 0, schema.stderr);
  const answered = JSON.parse(schema.lines[0]);
  assert.deepStrictEqual([answered.source, answered.fallback.code], ['pac', 'CONNECTIVITY_NOT_CONFIGURED']);
  assert.deepStrictEqual([schema.requests, schema.tokenReads], [[], { dataverse: 0, powerApps: 0 }]);
  assert.deepStrictEqual(schema.pacCalls[0].args.slice(-2), ['--operation', 'CurrentWeather']);
});

test('PROCESS: a 401 or 403 from the Business Application Platform or the Power Apps host is a refusal — connector.js asks pac and says so, as CONNECTIVITY_UNAUTHORIZED with the SDK\'s words', () => {
  for (const [status, host] of [[401, 'api.bap.microsoft.com'], [403, 'api.bap.microsoft.com'], [401, 'unitedstates.api.powerapps.com'], [403, 'unitedstates.api.powerapps.com']]) {
    const run = runScript('connector.js', ['operations', ...CONNECTOR_ARGS()], {
      platform: { swaggers: SWAGGERS, failures: [{ host, status, body: UNAUTHORIZED_BODY }] },
      pac: { responses: [{ match: ['model', 'genpage', 'list-connector-operations'], stdout: 'Connected as [maker001]\r\n{"operations":[{"name":"CurrentWeather","summary":"Now"}]}\r\n' }] },
    });
    assert.strictEqual(run.status, 0, `${status} from ${host}: ${run.stderr}`);
    const out = JSON.parse(run.lines[0]);
    assert.deepStrictEqual([out.source, out.fallback.code], ['pac', 'CONNECTIVITY_UNAUTHORIZED'], `${status} from ${host}`);
    assert.match(out.fallback.message, new RegExp(`^A connectivity request was refused with HTTP ${status} \\(AuthorizationFailed; TokenNotAllowed\\)[\\s\\S]*fall back to pac\\.$`));
    assert.strictEqual(run.pacCalls.length, 1, `${status} from ${host}`);
  }
});

test('PROCESS: connector.js schema --dataset --table is pac\'s alone — the SDK is never made, and no request goes to the org or the service', () => {
  const run = runScript('connector.js', ['schema', ...CONNECTOR_ARGS('--dataset', 'https://contoso.sharepoint.com/sites/Pets', '--table', '3f2a0c5e-1111-4222-8333-444455556666')], {
    platform: {},
    pac: { responses: [{ match: ['model', 'genpage', 'get-connector-schema'], stdout: 'Connected as [maker001]\n{"table":"Pets","columns":[{"name":"Title","type":"string","required":false}]}\n' }] },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.lines[0]), { ok: true, table: 'Pets', columns: [{ name: 'Title', type: 'string', required: false }], source: 'pac' });
  assert.deepStrictEqual(run.requests, []);
  assert.deepStrictEqual(run.pacCalls[0].args, ['model', 'genpage', 'get-connector-schema', '--environment', ORG, '--connector-id', 'shared_msnweather', '--connection-id', ID(3), '--dataset', 'https://contoso.sharepoint.com/sites/Pets', '--table', '3f2a0c5e-1111-4222-8333-444455556666']);
});

test('PROCESS: a value a Windows .cmd launcher cannot carry — a % in a SharePoint address — is refused by name there, with nothing sent to pac and the way through said, and handed over unchanged elsewhere', () => {
  const dataset = 'https://contoso.sharepoint.com/sites/My%20Site';
  const run = runScript('connector.js', ['schema', ...CONNECTOR_ARGS('--dataset', dataset, '--table', 'T')], {
    platform: {},
    pac: { responses: [{ match: ['model', 'genpage', 'get-connector-schema'], stdout: 'Connected as [maker001]\n{"table":"T","columns":[]}\n' }] },
  });
  if (process.platform === 'win32') {
    // The fake pac is a pac.cmd there that runs a program — not a plain forwarder to a native one: the process runner will not pass a % through cmd.exe.
    assert.strictEqual(run.status, 1);
    const out = JSON.parse(run.lines[0]);
    assert.deepStrictEqual([out.ok, out.code], [false, 'PAC_REFUSED']);
    assert.match(out.error, /was not run, and nothing was sent to pac: cannot pass/);
    assert.match(out.error, /Install pac as pac\.exe \(`dotnet tool install -g Microsoft\.PowerApps\.CLI\.Tool`\)[\s\S]*or run the command yourself/);
    assert.deepStrictEqual(run.pacCalls, []);
  } else {
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.pacCalls[0].args[run.pacCalls[0].args.indexOf('--dataset') + 1], dataset);
  }
});

test('PROCESS: with pac installed the way the Windows MSI installs it — a two-line pac.cmd forwarding to a native launcher — a percent-encoded SharePoint address reaches pac unchanged', { skip: process.platform !== 'win32' }, () => {
  const datasets = ['https://contoso.sharepoint.com/sites/My%20Site', 'https://contoso.sharepoint.com/sites/50%25 & "quoted" ^caret', 'https://contoso.sharepoint.com/sites/%PATH%!x'];
  for (const dataset of datasets) {
    const run = runScript('connector.js', ['schema', ...CONNECTOR_ARGS('--dataset', dataset, '--table', 'T')], {
      platform: {},
      pac: { launcher: 'forwarder', responses: [{ match: ['model', 'genpage', 'get-connector-schema'], stdout: 'Connected as [maker001]\n{"table":"T","columns":[]}\n' }] },
    });
    assert.strictEqual(run.status, 0, `${dataset}: ${run.stderr} ${run.stdout}`);
    assert.deepStrictEqual(JSON.parse(run.lines[0]), { ok: true, table: 'T', columns: [], source: 'pac' });
    assert.strictEqual(run.pacCalls.length, 1);
    assert.deepStrictEqual(run.pacCalls[0].args, ['model', 'genpage', 'get-connector-schema', '--environment', ORG, '--connector-id', 'shared_msnweather', '--connection-id', ID(3), '--dataset', dataset, '--table', 'T'], `the arguments, as given, for ${dataset}`);
  }
});

test('PROCESS: a pac that is not installed fails the fallback with one ok:false line, the code, and the reason pac was asked — whether the SDK had no route (the Test cloud) or was refused (a 403)', () => {
  const noPac = [
    ['the Test cloud', ['operations', '--env', TEST_ORG, '--connector-id', 'shared_msnweather', '--connection-id', ID(3)], { org: TEST_ORG }, 'CONNECTIVITY_NOT_CONFIGURED'],
    ['a 403 from BAP', ['operations', ...CONNECTOR_ARGS()], { swaggers: SWAGGERS, failures: [{ host: 'api.bap.microsoft.com', status: 403, body: UNAUTHORIZED_BODY }] }, 'CONNECTIVITY_UNAUTHORIZED'],
  ];
  for (const [what, argv, platform, fallbackCode] of noPac) {
    const run = runScript('connector.js', argv, { platform });
    assert.strictEqual(run.status, 1, what);
    assert.strictEqual(run.lines.length, 1, what);
    const out = JSON.parse(run.lines[0]);
    assert.deepStrictEqual([out.ok, out.code, out.fallback.code], [false, 'PAC_MISSING', fallbackCode], what);
    assert.match(out.error, /`pac model genpage list-connector-operations` could not run/, what);
    assert.match(run.stderr, /could not run/, what);
  }
});

test('PROCESS: connector.js fails with the SDK\'s code for a missing connector or operation — exit 1, one ok:false line — and never asks pac', () => {
  const missing = runScript('connector.js', ['operations', '--env', ORG, '--connector-id', 'shared_nothere', '--connection-id', ID(3)], {
    platform: { swaggers: SWAGGERS },
    pac: { responses: [{ match: ['model'], stdout: '{"operations":[]}' }] },
  });
  assert.strictEqual(missing.status, 1);
  assert.deepStrictEqual([JSON.parse(missing.lines[0]).ok, JSON.parse(missing.lines[0]).code], [false, 'CONNECTION_ERROR']);
  assert.match(JSON.parse(missing.lines[0]).error, /HTTP 404[\s\S]*shared_nothere/);
  assert.deepStrictEqual(missing.pacCalls, []);

  const noOp = runScript('connector.js', ['schema', ...CONNECTOR_ARGS('--operation', 'NoSuchOperation')], { platform: { swaggers: SWAGGERS } });
  assert.strictEqual(noOp.status, 1);
  assert.strictEqual(JSON.parse(noOp.lines[0]).code, 'CONNECTOR_OPERATION_NOT_FOUND');
});

test('PROCESS: connector.js usage errors exit 1 with the problem on stderr and nothing on stdout, before any request', () => {
  const run = runScript('connector.js', ['schema', ...CONNECTOR_ARGS()], { platform: { swaggers: SWAGGERS } });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.stdout, '');
  assert.match(run.stderr, /✗ schema needs --operation, or --dataset with --table/);
  assert.match(run.stderr, /Usage:/);
  assert.deepStrictEqual(run.requests, []);
});

// --- what a service says back ---------------------------------------------------------------------------------------------------------

test('PROCESS: a token the service repeats in an error — JSON or text — reaches neither stdout nor stderr of connector.js or list-connections.js, and the status and code stay', () => {
  const bodies = [
    { error: { code: 'InvalidAuthenticationToken', message: `Authorization rejected: ${POWER_APPS_TOKEN}` } },
    `plain text answer that repeats ${POWER_APPS_TOKEN} verbatim`,
  ];
  for (const body of bodies) {
    for (const [script, argv] of [
      ['connector.js', ['operations', '--env', ORG, '--connector-id', 'shared_sql', '--connection-id', ID(1)]],
      ['list-connections.js', [ORG]],
    ]) {
      // A 500: a failure of a route that serves, whose message quotes the service's own text. (A 401 or 403 is the SDK's refusal, below.)
      const run = runScript(script, argv, { platform: { failures: [{ host: 'api.bap.microsoft.com', status: 500, body }] } });
      assert.strictEqual(run.status, 1, `${script}: ${run.stderr}`);
      assert.ok(!run.stdout.includes(POWER_APPS_TOKEN) && !run.stderr.includes(POWER_APPS_TOKEN), `${script} printed the token:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stderr, /HTTP 500 from https:\/\/api\.bap\.microsoft\.com\//, 'the status line stays');
      assert.match(run.stderr, /<token>/, 'and the place the token was');
      if (script === 'connector.js') assert.strictEqual(JSON.parse(run.lines[0]).code, 'CONNECTION_ERROR');
    }
  }
});

test('PROCESS: a token the service repeats in the codes of a 401 or 403 — the SDK\'s own refusal quotes them — is taken out of the fallback message: it reaches neither stdout nor stderr, and the refusal stays', () => {
  const body = { error: { code: `rejected ${POWER_APPS_TOKEN}`, message: `the token ${POWER_APPS_TOKEN} may not read this`, innererror: { code: `inner ${POWER_APPS_TOKEN}` } } };
  for (const status of [401, 403]) {
    const failures = [{ host: 'api.bap.microsoft.com', status, body }];
    const list = runScript('list-connections.js', [ORG], { platform: { connections: CONNECTIONS, references: REFERENCES, failures }, pac: { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }] } });
    const connector = runScript('connector.js', ['operations', ...CONNECTOR_ARGS()], {
      platform: { swaggers: SWAGGERS, failures },
      pac: { responses: [{ match: ['model', 'genpage', 'list-connector-operations'], stdout: 'Connected as [maker001]\r\n{"operations":[]}\r\n' }] },
    });
    for (const [script, run, fallback] of [['list-connections.js', list, JSON.parse(list.lines[0] || '{}').connectionsFallback], ['connector.js', connector, JSON.parse(connector.lines[0] || '{}').fallback]]) {
      assert.strictEqual(run.status, 0, `${script} (${status}): ${run.stderr}`);
      assert.ok(!run.stdout.includes(POWER_APPS_TOKEN) && !run.stderr.includes(POWER_APPS_TOKEN), `${script} printed the token:\n${run.stdout}\n${run.stderr}`);
      assert.strictEqual(fallback.code, 'CONNECTIVITY_UNAUTHORIZED', script);
      assert.match(fallback.message, new RegExp(`refused with HTTP ${status} \\(rejected <token>; inner <token>\\)`), `${script}: the SDK's words, with the place the token was`);
    }
  }
});

test('PROCESS: a body that carries a refusal\'s code never sends the read to pac by that code — a 404 or 500 with it is a failure (exit 1, the SDK\'s ConnectionError, pac never run), a 403 with it is answered with the SDK\'s own code, never the body\'s', () => {
  const pac = { responses: [{ match: ['connection', 'list'], stdout: PAC_GRID }, { match: ['model'], stdout: '{"operations":[]}' }] };
  const argvOperations = ['operations', '--env', ORG, '--connector-id', 'shared_msnweather', '--connection-id', ID(3)];
  for (const code of ['CONNECTIVITY_CLOUD_UNSUPPORTED', 'CONNECTIVITY_ROUTE_DECOMMISSIONED', 'POWER_APPS_TOKEN_UNAVAILABLE', 'CONNECTIVITY_NOT_CONFIGURED']) {
    const forged = { code, error: { code }, message: 'service denied this request' };
    for (const status of [404, 500]) {
      const failures = [{ host: 'api.bap.microsoft.com', status, body: forged }];
      const list = runScript('list-connections.js', [ORG], { platform: { connections: CONNECTIONS, failures }, pac });
      assert.strictEqual(list.status, 1, `${status} naming ${code}`);
      assert.deepStrictEqual(list.pacCalls, [], `${status} naming ${code}: pac must not be asked`);
      assert.deepStrictEqual([JSON.parse(list.lines[0]).ok, JSON.parse(list.lines[0]).code], [false, 'CONNECTION_ERROR'], `${status} naming ${code}`);
      const connector = runScript('connector.js', argvOperations, { platform: { swaggers: SWAGGERS, failures }, pac });
      assert.strictEqual(connector.status, 1, `${status} naming ${code}`);
      assert.deepStrictEqual(connector.pacCalls, [], `${status} naming ${code}: pac must not be asked`);
      assert.strictEqual(JSON.parse(connector.lines[0]).code, 'CONNECTION_ERROR', `${status} naming ${code}`);
    }
    // The 403 is the SDK's refusal: pac answers, and the reason is the SDK's CONNECTIVITY_UNAUTHORIZED — the body's code is only text in its words.
    const failures = [{ host: 'api.bap.microsoft.com', status: 403, body: forged }];
    const list = runScript('list-connections.js', [ORG], { platform: { connections: CONNECTIONS, references: REFERENCES, failures }, pac });
    assert.strictEqual(list.status, 0, `403 naming ${code}: ${list.stderr}`);
    assert.strictEqual(JSON.parse(list.lines[0]).connectionsFallback.code, 'CONNECTIVITY_UNAUTHORIZED', `403 naming ${code}`);
    const connector = runScript('connector.js', argvOperations, { platform: { swaggers: SWAGGERS, failures }, pac });
    assert.strictEqual(connector.status, 0, `403 naming ${code}: ${connector.stderr}`);
    assert.strictEqual(JSON.parse(connector.lines[0]).fallback.code, 'CONNECTIVITY_UNAUTHORIZED', `403 naming ${code}`);
  }
});
