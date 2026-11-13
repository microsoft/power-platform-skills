'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cr = require('../lib/connection-references');
const { verifySiteConnections } = require('../lib/verify-site-connections');

const ENV = 'https://contoso.crm.dynamics.com';
const ENV_ID = '00000000-0000-4000-8000-0000000000ab';
const SITE = '11111111-2222-4333-8444-555555555555';
const SOLUTION = '0d0d0d0d-0000-4000-8000-000000000004';

function tempFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'deployment-settings.json');
  if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}

function fakeRequest(handlers) {
  const calls = [];
  const fn = async (req) => {
    calls.push({ ...req, url: decodeURIComponent(req.url) });
    for (const [match, respond] of handlers) {
      if (match({ ...req, url: decodeURIComponent(req.url) })) {
        const r = typeof respond === 'function' ? respond(req) : respond;
        return { statusCode: r.statusCode || 200, body: r.body === undefined ? '' : JSON.stringify(r.body) };
      }
    }
    return { statusCode: 404, body: '{}' };
  };
  fn.calls = calls;
  return fn;
}

const entry = (LogicalName, ConnectionId = '', ConnectorId = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline') => ({ LogicalName, ConnectionId, ConnectorId });

// --- deployment-settings.json read/write -----------------------------------

test('readConnectionReferenceSettings supports every settings-file shape and normalizes stage labels', (t) => {
  const shapes = [
    { ConnectionReferences: [entry('cr1_a', 'c1')] },
    { Stages: [{ Name: 'Staging', ConnectionReferences: [entry('cr1_a', 'c1')] }] },
    { stages: { Staging: { ConnectionReferences: [entry('cr1_a', 'c1')] } } },
    { Staging: { EnvironmentVariables: [], ConnectionReferences: [entry('cr1_a', 'c1')] } },
  ];
  for (const shape of shapes) {
    const file = tempFile(t, shape);
    assert.deepEqual(cr.readConnectionReferenceSettings(file, 'Deploy to Staging'), [entry('cr1_a', 'c1')], JSON.stringify(shape));
  }
  assert.deepEqual(cr.readConnectionReferenceSettings(tempFile(t), 'Staging'), [], 'a missing file reads as no bindings');
});

test('upsertConnectionReferenceSettings merges by logical name and preserves other keys', (t) => {
  const file = tempFile(t, {
    $schema: 'x',
    stages: { Staging: { EnvironmentVariables: [{ SchemaName: 'cr1_Url', Value: 'https://x' }], ConnectionReferences: [entry('cr1_a', 'old')] } },
  });
  cr.upsertConnectionReferenceSettings(file, 'Staging', [entry('CR1_A', 'new'), entry('cr1_b', 'c2')]);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.$schema, 'x');
  assert.deepEqual(written.stages.Staging.EnvironmentVariables, [{ SchemaName: 'cr1_Url', Value: 'https://x' }]);
  assert.deepEqual(written.stages.Staging.ConnectionReferences, [entry('CR1_A', 'new'), entry('cr1_b', 'c2')]);
});

test('upsertConnectionReferenceSettings creates stages.{stage} for a new file and appends to a Stages[] array', (t) => {
  const fresh = tempFile(t);
  cr.upsertConnectionReferenceSettings(fresh, 'Production', [entry('cr1_a', 'c1')]);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), {
    stages: { Production: { EnvironmentVariables: [], ConnectionReferences: [entry('cr1_a', 'c1')] } },
  });

  const arr = tempFile(t, { Stages: [{ Name: 'Staging', ConnectionReferences: [] }] });
  cr.upsertConnectionReferenceSettings(arr, 'Production', [entry('cr1_a', 'c9')]);
  const written = JSON.parse(fs.readFileSync(arr, 'utf8'));
  assert.equal(written.Stages.length, 2);
  assert.deepEqual(written.Stages[1].ConnectionReferences, [entry('cr1_a', 'c9')]);
});

test('findUnboundConnectionReferences flags references without a ConnectionId', () => {
  const required = [
    { logicalName: 'cr1_a', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' },
    { logicalName: 'cr1_b', connectorId: '/providers/Microsoft.PowerApps/apis/shared_x' },
    { logicalName: 'cr1_c', connectorId: '/providers/Microsoft.PowerApps/apis/shared_y' },
  ];
  const { configured, unbound } = cr.findUnboundConnectionReferences(required, [entry('CR1_A', 'c1', ''), entry('cr1_b', '')]);
  assert.deepEqual(configured, [entry('CR1_A', 'c1', '/providers/Microsoft.PowerApps/apis/shared_sharepointonline')]);
  assert.deepEqual(unbound.map((r) => r.logicalName), ['cr1_b', 'cr1_c']);
});

// --- Dataverse-backed operations -------------------------------------------

test('listSolutionConnectionReferences resolves the env-specific component type and fetches by id', async () => {
  const req = fakeRequest([
    [(r) => r.url.includes('/solutioncomponentdefinitions?'), { body: { value: [{ solutioncomponenttype: 10171 }] } }],
    [(r) => r.url.includes('/solutioncomponents?'), { body: { value: [{ objectid: '0B0B0B0B-0000-4000-8000-000000000002' }] } }],
    [(r) => r.url.includes('/connectionreferences?'), {
      body: { value: [{ connectionreferenceid: '0b0b0b0b-0000-4000-8000-000000000002', connectionreferencelogicalname: 'cr1_onprem', connectorid: '/providers/Microsoft.PowerApps/apis/shared_x' }] },
    }],
  ]);
  const refs = await cr.listSolutionConnectionReferences({ envUrl: ENV, token: 't', solutionIds: [SOLUTION], makeRequest: req });
  assert.match(req.calls[1].url, new RegExp(`_solutionid_value eq ${SOLUTION} and componenttype eq 10171`));
  assert.deepEqual(refs.map((r) => [r.logicalName, r.connectorName]), [['cr1_onprem', 'shared_x']]);
});

test('bindConnectionReferences PATCHes by target id, skips unchanged and reports missing references', async () => {
  const req = fakeRequest([
    [(r) => r.method === 'PATCH', { statusCode: 204 }],
    [(r) => r.url.includes('/connectionreferences?'), {
      body: {
        value: [
          { connectionreferenceid: 'e0000000-0000-4000-8000-000000000001', connectionreferencelogicalname: 'cr1_a', connectionid: null },
          { connectionreferenceid: 'e0000000-0000-4000-8000-000000000002', connectionreferencelogicalname: 'cr1_b', connectionid: 'same' },
        ],
      },
    }],
  ]);
  const res = await cr.bindConnectionReferences({
    envUrl: ENV, token: 't', makeRequest: req,
    entries: [entry('cr1_a', 'c1'), entry('cr1_b', 'same'), entry('cr1_gone', 'c3'), entry('cr1_unset', '')],
  });
  assert.deepEqual(res.results.map((r) => [r.logicalName, r.status]), [
    ['cr1_a', 'bound'], ['cr1_b', 'unchanged'], ['cr1_gone', 'not-found'], ['cr1_unset', 'skipped'],
  ]);
  assert.equal(res.ok, false);
  const patch = req.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, `${ENV}/api/data/v9.2/connectionreferences(e0000000-0000-4000-8000-000000000001)`);
  assert.deepEqual(JSON.parse(patch.body), { connectionid: 'c1' });
});

test('parseArgs reads the subcommand and comma-separated solution ids', () => {
  const args = cr.parseArgs(['node', 'x', 'check-settings', '--envUrl', ENV, '--solutionIds', `${SOLUTION}, ${SOLUTION}`, '--stageLabel', 'Staging']);
  assert.equal(args.command, 'check-settings');
  assert.deepEqual(args.solutionIds, [SOLUTION, SOLUTION]);
  assert.equal(args.stageLabel, 'Staging');
});

// --- verify-site-connections ------------------------------------------------

function targetEnv({ siteConnections, refs, connections }) {
  return fakeRequest([
    [(r) => r.url.includes('/powerpagecomponents?'), { body: { value: siteConnections } }],
    [(r) => r.url.includes('/connectionreferences?'), { body: { value: refs } }],
    [(r) => r.url.includes('.environment.api.powerplatform.com/connectivity/connectors/'), { body: { value: connections } }],
  ]);
}

const row = (id, name, content) => ({ powerpagecomponentid: id, name, content: typeof content === 'string' ? content : JSON.stringify(content), statecode: 0 });

test('verifySiteConnections passes only logical-name site connections bound to a connected connection', async () => {
  const req = targetEnv({
    siteConnections: [
      row('11111111-1111-4111-8111-111111111111', 'Good', { connectionreferencelogicalname: 'cr1_good' }),
      row('22222222-2222-4222-8222-222222222222', 'Id only', { connectionreferenceid: '0b0b0b0b-0000-4000-8000-000000000002' }),
      row('33333333-3333-4333-8333-333333333333', 'Missing ref', { connectionreferencelogicalname: 'cr1_gone' }),
      row('44444444-4444-4444-8444-444444444444', 'Unbound', { connectionreferencelogicalname: 'cr1_unbound' }),
      row('55555555-5555-4555-8555-555555555555', 'Broken conn', { connectionreferencelogicalname: 'cr1_broken' }),
      row('66666666-6666-4666-8666-666666666666', 'Garbage', '{nope'),
    ],
    refs: [
      { connectionreferenceid: 'a0000000-0000-4000-8000-000000000001', connectionreferencelogicalname: 'cr1_good', connectorid: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', connectionid: 'conn1' },
      { connectionreferenceid: 'a0000000-0000-4000-8000-000000000002', connectionreferencelogicalname: 'cr1_unbound', connectorid: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', connectionid: null },
      { connectionreferenceid: 'a0000000-0000-4000-8000-000000000003', connectionreferencelogicalname: 'cr1_broken', connectorid: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', connectionid: 'conn2' },
    ],
    connections: [
      { name: 'conn1', properties: { statuses: [{ status: 'Connected' }] } },
      { name: 'conn2', properties: { statuses: [{ status: 'Error' }] } },
    ],
  });
  const res = await verifySiteConnections({ envUrl: ENV, token: 't', siteId: SITE, environmentId: ENV_ID, ppApiToken: 'pp', makeRequest: req });
  assert.deepEqual(res.results.map((r) => [r.name, r.status, r.code]), [
    ['Good', 'pass', 'OK'],
    ['Id only', 'fail', 'LOGICAL_NAME_MISSING'],
    ['Missing ref', 'fail', 'CONNECTION_REFERENCE_NOT_FOUND'],
    ['Unbound', 'fail', 'CONNECTION_REFERENCE_UNBOUND'],
    ['Broken conn', 'fail', 'CONNECTION_NOT_CONNECTED'],
    ['Garbage', 'fail', 'CONTENT_UNPARSEABLE'],
  ]);
  assert.deepEqual(res.summary, { total: 6, pass: 1, fail: 5, warn: 0 });
  assert.equal(res.ok, false);
  assert.equal(req.calls.filter((c) => c.url.includes('/connectivity/')).length, 1, 'connections are listed once per connector');
  assert.equal(req.calls.some((c) => c.method === 'PATCH'), false, 'verification never writes');
});

test('verifySiteConnections skips the connection-status check without an environment id', async () => {
  const req = targetEnv({
    siteConnections: [row('11111111-1111-4111-8111-111111111111', 'Good', { connectionreferencelogicalname: 'cr1_good' })],
    refs: [{ connectionreferenceid: 'a0000000-0000-4000-8000-000000000001', connectionreferencelogicalname: 'cr1_good', connectorid: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', connectionid: 'conn1' }],
    connections: [],
  });
  const res = await verifySiteConnections({ envUrl: ENV, token: 't', siteId: SITE, makeRequest: req });
  assert.equal(res.ok, true);
  assert.match(res.results[0].message, /not checked/);
  assert.equal(req.calls.some((c) => c.url.includes('/connectivity/')), false);
});

test('mapConnectorsToTarget keeps certified ids and maps custom connectors by schema name', async () => {
  const SRC = 'https://source.crm.dynamics.com';
  const TGT = 'https://target.crm.dynamics.com';
  const srcCustom = '/providers/Microsoft.PowerApps/apis/shared_contosoapi-0123456789abcdef01-fedcba9876543210fe';
  const srcLegacy = '/providers/Microsoft.PowerApps/apis/shared_legacyapi-0123456789abcdef01-fedcba9876543210fe';
  const srcMissing = '/providers/Microsoft.PowerApps/apis/shared_otherapi-0123456789abcdef01-fedcba9876543210fe';
  const req = fakeRequest([
    [(r) => r.url.startsWith(SRC) && r.url.includes('/connectors?'), {
      body: { value: [
        { connectorid: 'a1', connectorinternalid: 'shared_contosoapi-0123456789abcdef01-fedcba9876543210fe', name: 'cr1_contosoapi' },
        { connectorid: 'a2', connectorinternalid: 'shared_otherapi-0123456789abcdef01-fedcba9876543210fe', name: 'cr1_otherapi' },
      ] },
    }],
    [(r) => r.url.startsWith(TGT) && r.url.includes('/connectors?'), (r) => {
      assert.match(decodeURIComponent(r.url), /name eq 'cr1_contosoapi'/);
      return { body: { value: [{ connectorid: 'b1', connectorinternalid: 'shared_cr1-5fcontosoapi-0a1b2c3d4e5f6a7b8c', name: 'cr1_contosoapi' }] } };
    }],
  ]);
  const map = await cr.mapConnectorsToTarget({
    sourceEnvUrl: SRC, sourceToken: 's', targetEnvUrl: TGT, targetToken: 't', makeRequest: req,
    connectorIds: ['/providers/Microsoft.PowerApps/apis/shared_sharepointonline', srcCustom, srcLegacy, srcMissing],
  });
  assert.deepEqual(map.get('/providers/microsoft.powerapps/apis/shared_sharepointonline'), {
    targetConnectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', isCustom: false, schemaName: null, found: true, reason: null,
  });
  assert.equal(map.get(srcCustom.toLowerCase()).targetConnectorId, '/providers/Microsoft.PowerApps/apis/shared_cr1-5fcontosoapi-0a1b2c3d4e5f6a7b8c');
  assert.match(map.get(srcLegacy.toLowerCase()).reason, /not solution-aware in the source/);
  assert.match(map.get(srcMissing.toLowerCase()).reason, /deploy the connectors solution first/);
});

test('findUnboundConnectionReferences defaults ConnectorId to the target connector id when known', () => {
  const { configured } = cr.findUnboundConnectionReferences(
    [{ logicalName: 'cr1_api', connectorId: '/providers/Microsoft.PowerApps/apis/shared_src', targetConnectorId: '/providers/Microsoft.PowerApps/apis/shared_tgt' }],
    [{ LogicalName: 'cr1_api', ConnectionId: 'c1' }],
  );
  assert.equal(configured[0].ConnectorId, '/providers/Microsoft.PowerApps/apis/shared_tgt');
});

// --- review regressions: mixed shapes, single-stage files ------------------

test('saving a new stage never hides existing top-level or Stages-object stage blocks', (t) => {
  const topLevel = tempFile(t, { Staging: { EnvironmentVariables: [], ConnectionReferences: [entry('cr1_a', 'c1')] } });
  cr.upsertConnectionReferenceSettings(topLevel, 'Production', [entry('cr1_a', 'p1')]);
  assert.deepEqual(cr.readConnectionReferenceSettings(topLevel, 'Staging'), [entry('cr1_a', 'c1')]);
  assert.deepEqual(cr.readConnectionReferenceSettings(topLevel, 'Production'), [entry('cr1_a', 'p1')]);
  const written = JSON.parse(fs.readFileSync(topLevel, 'utf8'));
  assert.equal(written.stages, undefined, 'reuses the top-level stage-key shape instead of adding a stages object');

  const capital = tempFile(t, { Stages: { Staging: { ConnectionReferences: [entry('cr1_a', 'c1')] } } });
  cr.upsertConnectionReferenceSettings(capital, 'Production', [entry('cr1_a', 'p1')]);
  const cap = JSON.parse(fs.readFileSync(capital, 'utf8'));
  assert.deepEqual(Object.keys(cap), ['Stages'], 'no shadowing lowercase stages key');
  assert.deepEqual(cr.readConnectionReferenceSettings(capital, 'Staging'), [entry('cr1_a', 'c1')]);

  const mixed = { stages: { Production: { ConnectionReferences: [entry('cr1_a', 'p1')] } }, Staging: { ConnectionReferences: [entry('cr1_a', 'c1')] } };
  assert.deepEqual(cr.readConnectionReferenceSettings(tempFile(t, mixed), 'Staging'), [entry('cr1_a', 'c1')], 'lookup falls through shapes');
});

test('a single-stage settings file is readable but refuses stage-labelled writes', (t) => {
  const single = tempFile(t, { EnvironmentVariables: [], ConnectionReferences: [entry('cr1_a', 'c1')] });
  assert.deepEqual(cr.readConnectionReferenceSettings(single, 'Staging'), [entry('cr1_a', 'c1')]);
  assert.throws(() => cr.upsertConnectionReferenceSettings(single, 'Production', [entry('cr1_a', 'p1')]), /single-stage settings file/);
  assert.deepEqual(JSON.parse(fs.readFileSync(single, 'utf8')).ConnectionReferences, [entry('cr1_a', 'c1')], 'file untouched');
});
