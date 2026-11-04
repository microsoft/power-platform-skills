'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const connectivity = require('../lib/connectivity-api');
const { run: makeSolutionAware, FALLBACK_GUIDANCE } = require('../lib/make-connectors-solution-aware');

const ENV = '00000000-0000-4000-8000-0000000000ab';
const BASE = 'https://000000000000400080000000000000.ab.environment.api.powerplatform.com';
const CUSTOM = 'shared_contosoapi-0123456789abcdef01-fedcba9876543210fe';

function router(routes) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    for (const [match, respond] of routes) {
      if (match(req)) {
        const r = typeof respond === 'function' ? respond(req) : respond;
        return { statusCode: r.statusCode || 200, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
      }
    }
    return { statusCode: 404, body: JSON.stringify({ error: { code: 'NotFound', message: req.url } }) };
  };
  fn.calls = calls;
  return fn;
}

test('buildEnvironmentApiBaseUrl splits the hex id by cloud shard length and keeps the Default prefix', () => {
  assert.equal(connectivity.buildEnvironmentApiBaseUrl(ENV), BASE);
  assert.equal(
    connectivity.buildEnvironmentApiBaseUrl(`Default-${ENV}`),
    'https://default000000000000400080000000000000.ab.environment.api.powerplatform.com',
  );
  assert.equal(
    connectivity.buildEnvironmentApiBaseUrl(ENV, 'UsGov'),
    'https://000000000000400080000000000000a.b.environment.api.gov.powerplatform.microsoft.us',
  );
  assert.throws(() => connectivity.buildEnvironmentApiBaseUrl('not-a-guid'), /Invalid environment id/);
  assert.throws(() => connectivity.buildEnvironmentApiBaseUrl(ENV, 'China'), /No environment-routed/);
});

test('connectorNameFromId accepts ids and bare names and rejects path injection', () => {
  assert.equal(connectivity.connectorNameFromId('/providers/Microsoft.PowerApps/apis/shared_sharepointonline'), 'shared_sharepointonline');
  assert.equal(connectivity.connectorNameFromId(CUSTOM), CUSTOM);
  for (const bad of ['', '../x', 'shared/x', '/providers/Microsoft.PowerApps/apis/a/b', 'x?y=1']) {
    assert.throws(() => connectivity.connectorNameFromId(bad), /Invalid connector id/, bad);
  }
});

test('looksLikeCustomConnector matches the 18-hex custom connector suffix in source and target shapes', () => {
  assert.equal(connectivity.looksLikeCustomConnector(CUSTOM), true);
  assert.equal(connectivity.looksLikeCustomConnector('shared_sharepointonline'), false);
  assert.equal(connectivity.looksLikeCustomConnector('shared_x-abc-def'), false);
  // After a solution import the target gets a different internal name with one hash.
  assert.equal(connectivity.looksLikeCustomConnector('shared_cr123-5fcontosoapi-0a1b2c3d4e5f6a7b8c'), true);
});

test('getConnector sends the environment filter and normalizes solution-aware state', async () => {
  const req = router([
    [(r) => r.url.startsWith(`${BASE}/connectivity/connectors/${CUSTOM}?`), {
      body: { name: CUSTOM, properties: { displayName: 'Contoso API', isCustomApi: true, almMode: 'Solution', xrmConnectorId: '0c0c0c0c-0000-4000-8000-000000000003' } },
    }],
  ]);
  const c = await connectivity.getConnector({ environmentId: ENV, connectorName: CUSTOM, token: 't', makeRequest: req });
  assert.match(req.calls[0].url, /\$filter=environment%20eq%20'00000000-0000-4000-8000-0000000000ab'/);
  assert.equal(req.calls[0].headers.Authorization, 'Bearer t');
  assert.deepEqual(c, {
    name: CUSTOM, displayName: 'Contoso API', isCustomApi: true, almMode: 'Solution',
    xrmConnectorId: '0c0c0c0c-0000-4000-8000-000000000003', isSolutionAware: true,
  });
});

test('getConnector reports a non-solution-aware custom connector and returns null on 404', async () => {
  const req = router([
    [(r) => r.url.includes(`/connectors/${CUSTOM}?`), { body: { name: CUSTOM, properties: { isCustomApi: true } } }],
  ]);
  const c = await connectivity.getConnector({ environmentId: ENV, connectorName: CUSTOM, token: 't', makeRequest: req });
  assert.equal(c.isSolutionAware, false);
  assert.equal(await connectivity.getConnector({ environmentId: ENV, connectorName: 'shared_missing', token: 't', makeRequest: req }), null);
});

test('listConnections maps connection names, status and follows same-origin next links only', async () => {
  const page1 = {
    value: [{ name: 'aaa', properties: { displayName: 'Prod SharePoint', apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', statuses: [{ status: 'Connected' }] } }],
    nextLink: `${BASE}/connectivity/connectors/shared_sharepointonline/connections?page=2`,
  };
  const page2 = {
    value: [{ name: 'bbb', properties: { displayName: 'Broken', statuses: [{ status: 'Error' }] } }],
    nextLink: 'https://attacker.invalid/steal',
  };
  const req = router([
    [(r) => r.url.endsWith('page=2'), { body: page2 }],
    [(r) => r.url.includes('/connections?api-version=1'), { body: page1 }],
  ]);
  const list = await connectivity.listConnections({ environmentId: ENV, connectorName: 'shared_sharepointonline', token: 't', makeRequest: req });
  assert.deepEqual(list.map((c) => [c.connectionId, c.status, c.isConnected]), [['aaa', 'Connected', true], ['bbb', 'Error', false]]);
  assert.equal(req.calls.length, 2, 'the off-origin nextLink must not be followed');
});

test('makeConnectorsSolutionAware posts apisToMigrate and maps per-connector status', async () => {
  const solutionId = '0d0d0d0d-0000-4000-8000-000000000004';
  const req = router([
    [(r) => r.method === 'POST', (r) => {
      assert.deepEqual(JSON.parse(r.body), { apisToMigrate: [CUSTOM] });
      return { body: { statuses: { [CUSTOM.toUpperCase()]: { status: 'Success' } } } };
    }],
  ]);
  const res = await connectivity.makeConnectorsSolutionAware({ environmentId: ENV, solutionId, connectorNames: [CUSTOM], token: 't', makeRequest: req });
  assert.equal(req.calls[0].url, `${BASE}/connectivity/solutions/${solutionId}/makeConnectorsSolutionAware?api-version=2022-03-01-preview`);
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, [{ connectorName: CUSTOM, status: 'Success', error: null }]);
});

test('make-connectors-solution-aware refuses to run without consent', async () => {
  await assert.rejects(
    () => makeSolutionAware({ environmentId: ENV, solutionId: '0d0d0d0d-0000-4000-8000-000000000004', connectors: [CUSTOM], token: 't', consent: false }),
    /without --consent/,
  );
});

test('make-connectors-solution-aware confirms by re-reading the connector, and returns portal fallback on failure', async () => {
  const solutionId = '0d0d0d0d-0000-4000-8000-000000000004';
  let migrated = false;
  const ok = router([
    [(r) => r.method === 'POST', () => { migrated = true; return { body: { statuses: { [CUSTOM]: { status: 'Success' } } } }; }],
    [(r) => r.url.includes(`/connectors/${CUSTOM}?`), () => ({
      body: { name: CUSTOM, properties: migrated ? { isCustomApi: true, almMode: 'Solution', xrmConnectorId: 'x-1' } : { isCustomApi: true } },
    })],
  ]);
  const good = await makeSolutionAware({ environmentId: ENV, solutionId, connectors: [CUSTOM], token: 't', consent: true, makeRequest: ok });
  assert.equal(good.ok, true);
  assert.equal(good.results[0].xrmConnectorId, 'x-1');
  assert.equal(good.fallback, undefined);

  const failing = router([
    [(r) => r.method === 'POST', { statusCode: 403, body: { error: { code: 'Forbidden', message: 'not a maker' } } }],
    [(r) => r.url.includes(`/connectors/${CUSTOM}?`), { body: { name: CUSTOM, properties: { isCustomApi: true } } }],
  ]);
  const bad = await makeSolutionAware({ environmentId: ENV, solutionId, connectors: [CUSTOM], token: 't', consent: true, makeRequest: failing });
  assert.equal(bad.ok, false);
  assert.equal(bad.fallback, FALLBACK_GUIDANCE);
  assert.match(bad.error, /Forbidden: not a maker/);
});
