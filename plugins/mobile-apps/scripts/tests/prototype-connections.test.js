'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { revision } = require('../lib/prototype-files');
const {
  environmentId, connectionsUrl, readJsonGet, readConnectionCatalog, validateConnectorSelection,
} = require('../lib/prototype-connections');

const ENV = '11111111-2222-4333-8444-555555555555';
const API = 'shared_sharepointonline';
const row = (name, status = 'Connected') => ({
  name,
  id: `/providers/Microsoft.PowerApps/apis/${API}/connections/${name}`,
  properties: {
    apiId: `/providers/Microsoft.PowerApps/apis/${API}`, displayName: `Library ${name}`,
    statuses: [{ status }], environment: { name: ENV },
    parameterValues: { secret: 'do-not-project-this' }, createdBy: { userPrincipalName: 'do-not-project-this' },
  },
});

test('connection inventory URL is explicitly environment-scoped, including Default environments', () => {
  assert.equal(connectionsUrl(ENV), 'https://111111112222433384445555555555.55.environment.api.powerplatform.com/connectivity/connections?api-version=1');
  assert.match(connectionsUrl(`Default-${ENV}`, API), /https:\/\/default111111112222433384445555555555\.55\..*\/connectors\/shared_sharepointonline\/connections\?api-version=1/);
  assert.equal(environmentId(ENV.toUpperCase()), ENV);
  for (const invalid of ['Production', `${ENV}\n`, `${ENV}/other`, '', '../environment']) assert.throws(() => environmentId(invalid));
});

test('read-only connection reader pages real provider shapes, projects no credentials, and has stable revisions', async () => {
  const calls = [];
  const dependencies = {
    async getToken(resource) { assert.equal(resource, 'https://api.powerplatform.com'); return 'fixture-token'; },
    async requestJson(url, token) {
      calls.push({ url, token });
      assert.equal(token, 'fixture-token');
      assert.equal(new URL(url).pathname, '/connectivity/connections');
      return url.includes('$skiptoken')
        ? { value: [row('second')] }
        : { value: [row('first')], nextLink: `${connectionsUrl(ENV)}&$skiptoken=page2` };
    },
    async resolveEnvironment() { throw new Error('Plain connection inventory must not require Dataverse'); },
  };
  const catalog = await readConnectionCatalog({ environmentId: ENV }, dependencies);
  assert.equal(calls.length, 2);
  assert.equal(catalog.items.length, 2);
  assert.equal(catalog.references, 'not-requested');
  assert.equal(JSON.stringify(catalog).includes('do-not-project-this'), false);
  const reversed = await readConnectionCatalog({ environmentId: ENV }, {
    ...dependencies, async requestJson() { return { value: [row('second'), row('first')] }; },
  });
  assert.equal(reversed.catalogRevision, catalog.catalogRevision);
  const selected = validateConnectorSelection(catalog, {
    kind: 'connector', apiId: API, environmentId: ENV, catalogRevision: catalog.catalogRevision, connectionId: 'first',
  });
  assert.equal(selected.connectionId, 'first');
  assert.equal(selected.discoveryConnectionId, 'first');
});

test('connection references require exact same-environment binding, never just a connector-name match', async () => {
  const catalog = await readConnectionCatalog({ environmentId: ENV, references: true, apiId: API }, {
    async getToken() { return 'fixture-token'; },
    async resolveEnvironment(id, options) {
      assert.equal(id, ENV);
      assert.deepEqual(options, { noCache: true });
      return { environmentId: ENV, environmentUrl: 'https://fixture.crm.dynamics.com', tenantId: 'fixture-tenant' };
    },
    async requestJson(url) {
      if (url.includes('/connectivity/')) return { value: [row('first'), row('expired', 'Error')] };
      assert.equal(new URL(url).pathname, '/api/data/v9.2/connectionreferences');
      assert.match(new URL(url).searchParams.get('$filter'), /statecode eq 0/);
      return { value: [
        { connectorid: `/providers/Microsoft.PowerApps/apis/${API}`, connectionid: 'first', connectionreferencelogicalname: 'cr_library', statecode: 0 },
        { connectorid: `/providers/Microsoft.PowerApps/apis/${API}`, connectionid: 'missing', connectionreferencelogicalname: 'cr_missing', statecode: 0 },
      ] };
    },
  });
  const selection = { kind: 'connector', environmentId: ENV, apiId: API, connectionRef: 'cr_library', catalogRevision: catalog.catalogRevision };
  const selected = validateConnectorSelection(catalog, selection);
  assert.equal(selected.connectionRef, 'cr_library');
  assert.equal(selected.connectionId, undefined);
  assert.equal(selected.discoveryConnectionId, 'first');
  assert.throws(() => validateConnectorSelection(catalog, { ...selection, connectionRef: 'cr_missing' }), /unavailable/);
  assert.throws(() => validateConnectorSelection(catalog, { ...selection, connectionId: 'first' }), /one ID/);
  assert.throws(() => validateConnectorSelection(catalog, { ...selection, connectionId: null }), /one ID/);
  assert.throws(() => validateConnectorSelection(catalog, { ...selection, catalogRevision: '0'.repeat(64) }), /exact environment/);
  assert.throws(() => validateConnectorSelection(catalog, { ...selection, environmentId: '22222222-2222-4222-8222-222222222222' }), /exact environment/);
});

test('provider connector-qualified names normalize to exact terminal IDs without guessing a different API', async () => {
  const dependencies = {
    getToken: async () => 'fixture-token',
    requestJson: async () => ({ value: [{ name: `${API}/first`, properties: { statuses: [{ status: 'Connected' }] } }] }),
  };
  const catalog = await readConnectionCatalog({ environmentId: ENV }, dependencies);
  assert.equal(catalog.items[0].apiId, API);
  assert.equal(catalog.items[0].connectionId, 'first');
  const scoped = await readConnectionCatalog({ environmentId: ENV, apiId: API }, {
    ...dependencies, requestJson: async () => ({ value: [{ name: 'first', properties: { statuses: [{ status: 'Connected' }] } }] }),
  });
  assert.equal(scoped.items[0].apiId, API);
  await assert.rejects(readConnectionCatalog({ environmentId: ENV, apiId: 'shared_other' }, dependencies), /another connector/);
  await assert.rejects(readConnectionCatalog({ environmentId: ENV }, {
    ...dependencies, requestJson: async () => ({ value: [{ ...row('first'), name: 'shared_other/first' }] }),
  }), /connector API disagree/);
});

test('failed, malformed, duplicate and cross-origin listings never become a success-shaped empty catalogue', async () => {
  const read = (requestJson) => readConnectionCatalog({ environmentId: ENV }, { getToken: async () => 'fixture', requestJson });
  await assert.rejects(read(async () => ({ error: 'not authorized' })), /value array/);
  await assert.rejects(read(async () => ({ value: [], nextLink: 'https://other.invalid/connections?api-version=1' })), /changed its environment/);
  await assert.rejects(read(async () => ({ value: [], nextLink: connectionsUrl(ENV) })), /did not terminate/);
  for (const nextLink of [0, false, '', {}]) await assert.rejects(read(async () => ({ value: [], nextLink })), /Invalid.*continuation/);
  await assert.rejects(read(async () => ({ value: [], nextLink: '?page=2', '@odata.nextLink': '?page=3' })), /Ambiguous/);
  await assert.rejects(read(async () => ({ value: [row('same'), row('same')] })), /duplicate/);
  await assert.rejects(read(async () => ({ value: [{ ...row('first'), name: 'first\n' }] })), /Invalid connection/);
  await assert.rejects(read(async () => { throw new Error('injected provider error'); }), /provider error/);
  await assert.rejects(read(async () => ({ value: Array(10001).fill(row('many')) })), /row bound/);
  await assert.rejects(read(async (url) => ({
    value: [{ ...row('large'), ignoredProviderContent: 'x'.repeat(5 * 1024 * 1024) }],
    ...(url.includes('page=2') ? {} : { nextLink: '?page=2' }),
  })), /aggregate response bound/);
});

test('actual HTTP reader uses GET with header auth, rejects redirects and never calls consent/create', async () => {
  const calls = [];
  function transport(statusCode, body) {
    return {
      request(url, options, onResponse) {
        calls.push({ url: url.href, options });
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = () => {
          const response = new EventEmitter();
          response.statusCode = statusCode;
          onResponse(response);
          response.emit('data', Buffer.from(JSON.stringify(body)));
          response.emit('end');
        };
        return request;
      },
    };
  }
  assert.deepEqual(await readJsonGet(connectionsUrl(ENV), 'fixture-token', { transport: transport(200, { value: [] }) }), { value: [] });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.doesNotMatch(calls[0].url, /token|create|consent/i);
  await assert.rejects(readJsonGet(connectionsUrl(ENV), 'fixture-token', { transport: transport(302, {}) }), /HTTP 302/);
  assert.equal(calls.length, 2);
  assert.throws(() => readJsonGet('https://credential@other.invalid/', 'fixture'), /credential-free/);
  assert.throws(() => readJsonGet(connectionsUrl(ENV), 'fixture\r\nheader'), /authentication/);
});

test('reference discovery validates its resolved environment before requesting that origin token', async () => {
  const audiences = [];
  const dependencies = {
    getToken: async (audience) => { audiences.push(audience); return 'fixture-token'; },
    requestJson: async () => ({ value: [] }),
    resolveEnvironment: async () => ({ environmentId: '22222222-2222-4222-8222-222222222222', environmentUrl: 'https://other.crm.dynamics.com' }),
  };
  await assert.rejects(readConnectionCatalog({ environmentId: ENV, references: true }, dependencies), /environment resolution changed/);
  assert.deepEqual(audiences, ['https://api.powerplatform.com']);
  await assert.rejects(readConnectionCatalog({ environmentId: ENV, references: true }, {
    ...dependencies, resolveEnvironment: async () => { throw new Error('References unavailable for this environment'); },
  }), /References unavailable/);
  await assert.rejects(readConnectionCatalog({ environmentId: ENV, tenantId: 'not-a-guid' }, {
    getToken: async () => { throw new Error('Must validate before auth'); },
  }), /explicit environment GUID/);
});

test('unknown or mixed connection status and malformed catalogue bindings cannot be selected', async () => {
  const mixed = row('mixed');
  mixed.properties.statuses.push({ status: 'Error' });
  const catalog = await readConnectionCatalog({ environmentId: ENV }, {
    getToken: async () => 'fixture-token',
    requestJson: async () => ({ value: [mixed, { ...row('unknown'), properties: { apiId: API, statuses: [] } }, row('connected')] }),
  });
  const select = (connectionId, source = catalog) => validateConnectorSelection(source, {
    kind: 'connector', environmentId: ENV, apiId: API, catalogRevision: source.catalogRevision, connectionId,
  });
  assert.throws(() => select('mixed'), /unavailable/);
  assert.throws(() => select('unknown'), /unavailable/);
  assert.equal(select('connected').discoveryConnectionId, 'connected');
  assert.throws(() => validateConnectorSelection(null, {}), /catalogue/);

  const inconsistent = structuredClone(catalog);
  inconsistent.references = 'included';
  inconsistent.items.push({
    kind: 'connection-ref', environmentId: ENV, apiId: API, connectionRef: 'cr_unbound',
    boundConnectionId: null, availability: 'available', displayName: 'Unbound',
    id: revision([ENV, API, 'connection-ref', 'cr_unbound']),
  });
  delete inconsistent.catalogRevision;
  inconsistent.catalogRevision = revision(inconsistent);
  assert.throws(() => select('connected', inconsistent), /no available exact bound connection/);
});

test('inventory CLI rejects missing, duplicate and mutation flags before authentication', () => {
  const script = path.resolve(__dirname, '../list-prototype-connections.js');
  for (const args of [
    [], ['--environment-id', ENV, '--create'],
    ['--environment-id', ENV, '--environment-id', ENV],
    ['--environment-id', ENV, '--references', '--references'],
    ['--environment-id', ENV, '--tenant-id', `Default-${ENV}`],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' }, timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /explicit|Duplicate|Unknown/);
  }
});

test('catalogue skill paths preserve exact existing selections without legacy creation wrappers', () => {
  const pluginRoot = path.resolve(__dirname, '../..');
  const read = (relative) => fs.readFileSync(path.join(pluginRoot, relative), 'utf8');
  const list = read('skills/list-connections/SKILL.md');
  assert.match(list, /default[\s\S]*--existing-only[\s\S]*discovery only/);
  assert.match(list, /list-prototype-connections\.js/);
  assert.match(list, /https:\/\/make\.powerapps\.com\//);
  assert.match(list, /connector-reference-powerapps-connectors/);
  assert.match(list, /maker creates a connection in the portal/);
  const add = read('skills/add-connector/SKILL.md');
  assert.match(add, /--existing-only` exception[\s\S]*only SharePoint/);
  assert.match(add, /Other non-Dataverse selections stay[\s\S]*generic verified path/);
  assert.doesNotMatch(add, /npx expo install/);
  const sharepoint = read('skills/add-sharepoint/SKILL.md');
  assert.match(sharepoint, /existing lists[\s\S]*skip Steps 3–5/);
  assert.doesNotMatch(sharepoint, /npx power-apps create-connection/);
  assert.match(sharepoint, /--connection-ref <selected-reference>/);
  const reference = read('skills/list-connections/references/existing-selection.md');
  assert.match(reference, /verify-prototype-connection\.js/);
  assert.match(reference, /discovery ID into a final add that selected a reference/);
  assert.match(reference, /Shared Apply\/Discard remains a separate transaction/);
});
