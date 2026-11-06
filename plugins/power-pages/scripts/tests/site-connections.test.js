'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sc = require('../lib/site-connections');

const ENV = 'https://contoso.crm.dynamics.com';
const SITE = '11111111-2222-4333-8444-555555555555';
const CUSTOM = 'shared_contosoapi-0123456789abcdef01-fedcba9876543210fe';

// Routes Dataverse GETs by entity set. `decodeURIComponent` lets assertions read the
// OData filter the module built.
function dataverse(tables) {
  const calls = [];
  const fn = async ({ url }) => {
    calls.push(decodeURIComponent(url));
    const m = /\/api\/data\/v9\.2\/([a-z]+)\?/.exec(url);
    const table = m && tables[m[1]];
    if (table === undefined) return { statusCode: 404, body: '{}' };
    const value = typeof table === 'function' ? table(decodeURIComponent(url)) : table;
    return { statusCode: 200, body: JSON.stringify({ value }) };
  };
  fn.calls = calls;
  return fn;
}

const ppc = (id, name, content) => ({ powerpagecomponentid: id, name, content: JSON.stringify(content), statecode: 0 });

test('parseSiteConnectionContent reads logical name, id and web roles, tolerating either JSON spacing', () => {
  const compact = sc.parseSiteConnectionContent('{"connectionreferenceid":"0A0A0A0A-0000-4000-8000-000000000001","adx_siteconnection_adx_webrole":["r1"]}');
  assert.deepEqual(compact, {
    ok: true, connectionReferenceLogicalName: null, connectionReferenceId: '0a0a0a0a-0000-4000-8000-000000000001', webRoleIds: ['r1'],
  });
  const withName = sc.parseSiteConnectionContent('{"connectionreferencelogicalname": " cr1_sp ", "connectionreferenceid": "x"}');
  assert.equal(withName.connectionReferenceLogicalName, 'cr1_sp');
  assert.equal(withName.connectionReferenceId, null, 'a non-GUID id is ignored');
  assert.equal(sc.parseSiteConnectionContent('{oops').ok, false);
  assert.equal(sc.parseSiteConnectionContent('[]').ok, false);
  assert.equal(sc.parseSiteConnectionContent('').ok, false);
});

test('discoverSiteConnectionDependencies resolves by logical name first, then by source id, and classifies connectors', async () => {
  const req = dataverse({
    powerpagecomponents: [
      ppc('11111111-1111-4111-8111-111111111111', 'SharePoint', { connectionreferencelogicalname: 'cr1_sharepoint', adx_siteconnection_adx_webrole: ['r1'] }),
      ppc('22222222-2222-4222-8222-222222222222', 'On-prem API', { connectionreferenceid: '0b0b0b0b-0000-4000-8000-000000000002' }),
      ppc('33333333-3333-4333-8333-333333333333', 'Second SharePoint', { connectionreferencelogicalname: 'CR1_SHAREPOINT' }),
    ],
    connectionreferences: [
      { connectionreferenceid: 'C0C05000-0000-4000-8000-00000000C050', connectionreferencelogicalname: 'cr1_sharepoint', connectorid: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', connectionid: 'aaa' },
      { connectionreferenceid: '0b0b0b0b-0000-4000-8000-000000000002', connectionreferencelogicalname: 'cr1_onprem', connectorid: `/providers/Microsoft.PowerApps/apis/${CUSTOM}`, connectionid: 'bbb' },
    ],
    connectors: [],
    solutioncomponentdefinitions: [{ solutioncomponenttype: 10171, primaryentityname: 'connectionreference' }],
  });

  const deps = await sc.discoverSiteConnectionDependencies({ envUrl: ENV, token: 't', siteId: SITE, makeRequest: req });

  assert.match(req.calls[0], /powerpagecomponenttype eq 36/);
  assert.deepEqual(deps.siteConnections.map((s) => s.resolvedBy), ['logicalName', 'id', 'logicalName']);
  assert.deepEqual(deps.connectionReferences.map((r) => [r.logicalName, r.usedBy.length]), [['cr1_sharepoint', 2], ['cr1_onprem', 1]]);
  assert.equal(deps.componentTypes.connectionReference, 10171);
  assert.equal(deps.componentTypes.connector, 372);

  const custom = deps.connectors.find((c) => c.connectorName === CUSTOM);
  assert.deepEqual([custom.isCustom, custom.isSolutionAware, custom.classifiedBy], [true, false, 'name-pattern']);
  assert.equal(deps.connectors.find((c) => c.connectorName === 'shared_sharepointonline').isCustom, false);

  const codes = deps.problems.map((p) => p.code).sort();
  assert.deepEqual(codes, ['CUSTOM_CONNECTOR_NOT_SOLUTION_AWARE', 'LOGICAL_NAME_MISSING']);
});

test('a custom connector with a Dataverse connector row is solution-aware; missing rows and refs are diffed per solution', async () => {
  const req = dataverse({
    powerpagecomponents: [ppc('22222222-2222-4222-8222-222222222222', 'On-prem API', { connectionreferencelogicalname: 'cr1_onprem' })],
    connectionreferences: [
      { connectionreferenceid: '0b0b0b0b-0000-4000-8000-000000000002', connectionreferencelogicalname: 'cr1_onprem', connectorid: `/providers/Microsoft.PowerApps/apis/${CUSTOM}` },
    ],
    connectors: [{ connectorid: '0C0C0C0C-0000-4000-8000-000000000003', connectorinternalid: CUSTOM, displayname: 'Contoso API', name: 'cr1_contosoapi' }],
    solutioncomponentdefinitions: [{ solutioncomponenttype: 10171 }],
  });
  const deps = await sc.discoverSiteConnectionDependencies({ envUrl: ENV, token: 't', siteId: SITE, makeRequest: req });
  assert.deepEqual(deps.problems, []);
  const [custom] = deps.customConnectors;
  assert.deepEqual([custom.isSolutionAware, custom.xrmConnectorId, custom.classifiedBy], [true, '0c0c0c0c-0000-4000-8000-000000000003', 'dataverse']);

  const none = sc.computeMissing(deps, new Set());
  assert.equal(none.connectionReferences.length, 1);
  assert.equal(none.customConnectors.length, 1);
  const all = sc.computeMissing(deps, new Set(['0b0b0b0b-0000-4000-8000-000000000002', '0c0c0c0c-0000-4000-8000-000000000003']));
  assert.deepEqual(all, { connectionReferences: [], customConnectors: [] });
});

test('unresolvable and malformed site connections are reported, not thrown', async () => {
  const req = dataverse({
    powerpagecomponents: [
      { powerpagecomponentid: '44444444-4444-4444-8444-444444444444', name: 'Broken', content: '{nope', statecode: 0 },
      ppc('55555555-5555-4555-8555-555555555555', 'Dangling', { connectionreferencelogicalname: 'cr1_gone' }),
      ppc('66666666-6666-4666-8666-666666666666', 'Empty', { adx_siteconnection_adx_webrole: [] }),
    ],
    connectionreferences: [],
  });
  const deps = await sc.discoverSiteConnectionDependencies({ envUrl: ENV, token: 't', siteId: SITE, makeRequest: req });
  assert.deepEqual(deps.problems.map((p) => p.code), ['CONTENT_UNPARSEABLE', 'NO_CONNECTION_REFERENCE', 'CONNECTION_REFERENCE_NOT_FOUND']);
  assert.equal(deps.componentTypes.connectionReference, null, 'no component-type lookup without references');
});

test('logical names are escaped in OData filters and requests are batched', async () => {
  const names = Array.from({ length: 25 }, (_, i) => `cr1_o'brien_${i}`);
  const req = dataverse({ connectionreferences: [] });
  await sc.fetchConnectionReferences({ envUrl: ENV, token: 't', logicalNames: names, makeRequest: req });
  assert.equal(req.calls.length, 2, '25 names → 2 batched requests of ≤20');
  assert.match(req.calls[0], /connectionreferencelogicalname eq 'cr1_o''brien_0'/);
});

test('discovery validates the environment URL and site id before any request', async () => {
  const req = dataverse({});
  await assert.rejects(() => sc.discoverSiteConnectionDependencies({ envUrl: 'https://evil.invalid', token: 't', siteId: SITE, makeRequest: req }), /not an allowed Microsoft Dataverse/);
  await assert.rejects(() => sc.discoverSiteConnectionDependencies({ envUrl: ENV, token: 't', siteId: 'x', makeRequest: req }), /siteId must be a GUID/);
  assert.equal(req.calls.length, 0);
});

test('fetchDataverseConnectors returns null when the connector table is unavailable', async () => {
  const req = dataverse({});
  assert.equal(await sc.fetchDataverseConnectors({ envUrl: ENV, token: 't', connectorNames: [CUSTOM], makeRequest: req }), null);
});

test('computeMissing checks custom connectors against the connectors solution, not the site solution', () => {
  const deps = {
    connectionReferences: [{ id: 'aaaa' }],
    customConnectors: [
      { connectorName: 'shared_ok-0123456789abcdef01', isSolutionAware: true, xrmConnectorId: 'cccc' },
      { connectorName: 'shared_raw-0123456789abcdef01', isSolutionAware: false, xrmConnectorId: null },
    ],
  };
  const site = new Set(['aaaa']);
  // Only the site solution is known: a solution-aware connector is not a gap.
  assert.deepEqual(sc.computeMissing(deps, site, { connectorSolutionObjectIds: null }).customConnectors.map((c) => c.xrmConnectorId), [null]);
  // Connectors solution known: membership is checked there.
  assert.equal(sc.computeMissing(deps, site, { connectorSolutionObjectIds: new Set(['cccc']) }).customConnectors.length, 1);
  assert.equal(sc.computeMissing(deps, site, { connectorSolutionObjectIds: new Set() }).customConnectors.length, 2);
  // Default: the same (union) set for both.
  assert.equal(sc.computeMissing(deps, new Set(['aaaa', 'cccc'])).customConnectors.length, 1);
  assert.deepEqual(sc.computeMissing(deps, site).connectionReferences, []);
});
