const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const childProcess = require('child_process');

const helpersPath = path.join(__dirname, '..', 'lib', 'validation-helpers.js');

test('getAuthToken passes the validated resource as an argv element without a shell', () => {
  let capturedCall = null;
  const fakeExecFile = (file, args, options) => {
    capturedCall = { file, args, options };
    const out = 'fake-token-value\n';
    return options && options.encoding ? out : Buffer.from(out);
  };

  const { getAuthToken } = require(helpersPath);
  const token = getAuthToken('https://example.crm.dynamics.com/', fakeExecFile);

  assert.equal(token, 'fake-token-value');
  assert.equal(capturedCall.file, 'az');
  assert.deepEqual(
    capturedCall.args,
    [
      'account',
      'get-access-token',
      '--resource',
      'https://example.crm.dynamics.com',
      '--query',
      'accessToken',
      '-o',
      'tsv',
    ],
  );
  assert.equal(capturedCall.options.shell, false);
  assert.equal(capturedCall.args.includes('--allow-no-subscriptions'), false);
});

test('getAuthToken rejects shell metacharacters and non-Microsoft resource hosts before execution', () => {
  const { getAuthToken } = require(helpersPath);
  let called = false;
  const fakeExecFile = () => {
    called = true;
    return 'should-not-run';
  };

  assert.throws(
    () => getAuthToken('https://example.crm.dynamics.com/"; touch PWNED; #', fakeExecFile),
    /origin URL|path|query|fragment/i,
  );
  assert.throws(
    () => getAuthToken('https://attacker.example', fakeExecFile),
    /trusted Microsoft Power Platform host/i,
  );
  assert.equal(called, false);
});

test('validatePowerPlatformUrl accepts supported public and sovereign cloud hosts', () => {
  const { validatePowerPlatformUrl } = require(helpersPath);
  const urls = [
    'https://org.crm.dynamics.com',
    'https://org.crm9.dynamics.com/api/data/v9.2/WhoAmI',
    'https://org.crm.dynamics.cn',
    'https://org.crm.microsoftdynamics.us',
    'https://org.crm.appsplatform.us',
    'https://api.powerplatform.com',
    'https://api.gov.powerplatform.microsoft.us',
    'https://api.powerplatform.partner.microsoftonline.cn',
    'https://api.bap.microsoft.com',
  ];

  for (const url of urls) {
    assert.doesNotThrow(() => validatePowerPlatformUrl(url), url);
  }
});

test('makeRequest blocks bearer-token delivery to an untrusted URL', async () => {
  const { makeRequest } = require(helpersPath);
  await assert.rejects(
    () => makeRequest({
      url: 'https://attacker.example/collect',
      bearerToken: 'sensitive-token',
    }),
    /trusted Microsoft Power Platform host/i,
  );
});

// --- findProjectRoot: EDM / data-model site awareness ------------------------

test('findProjectRoot: recognizes a .powerpages-site/ directory as a project root (data-model/EDM sites)', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  // EDM/data-model site: .powerpages-site/ present, NO powerpages.config.json.
  const root = fs.mkdtempSync(path.join(__dirname, 'fpr-edm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.powerpages-site'), { recursive: true });
  fs.writeFileSync(path.join(root, '.powerpages-site', 'website.yml'), 'id: x\nname: y\n');

  assert.equal(findProjectRoot(root), path.resolve(root));
});

test('findProjectRoot: still recognizes powerpages.config.json (code sites)', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  const root = fs.mkdtempSync(path.join(__dirname, 'fpr-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'powerpages.config.json'), '{}');

  assert.equal(findProjectRoot(root), path.resolve(root));
});

test('findProjectRoot: returns null when neither marker is present', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  const root = fs.mkdtempSync(path.join(__dirname, 'fpr-none-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(findProjectRoot(root), null);
});

// --- odataGet / odataGetAll (shared pagination) ------------------------------

test('odataGetAll follows @odata.nextLink and aggregates all pages', async () => {
  const { odataGetAll } = require(helpersPath);
  const pages = {
    'https://x/api/data/v9.2/things': { value: [{ id: 1 }, { id: 2 }], '@odata.nextLink': 'https://x/page2' },
    'https://x/page2': { value: [{ id: 3 }] },
  };
  const fakeRequest = async ({ url }) => ({ statusCode: 200, body: JSON.stringify(pages[url]) });
  const rows = await odataGetAll('https://x/api/data/v9.2/things', 'tok', fakeRequest);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
});

test('odataGetAll FAILS CLOSED: throws when it hits maxPages with @odata.nextLink still present', async () => {
  const { odataGetAll } = require(helpersPath);
  // Every page advertises a nextLink → never terminates → hits the page cap.
  // Must throw rather than silently return a truncated set (wrong ALM counts).
  const fakeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ value: [{ id: 1 }], '@odata.nextLink': 'https://x/next' }),
  });
  await assert.rejects(
    () => odataGetAll('https://x/start', 'tok', fakeRequest, 3),
    /page cap.*nextLink|truncated/i,
  );
});

test('odataGet throws on non-2xx', async () => {
  const { odataGet } = require(helpersPath);
  const fakeRequest = async () => ({ statusCode: 404, body: 'not found' });
  await assert.rejects(() => odataGet('https://x/y', 'tok', fakeRequest), /HTTP 404/);
});

test('odataGet throws on transport error', async () => {
  const { odataGet } = require(helpersPath);
  const fakeRequest = async () => ({ error: 'ECONNRESET' });
  await assert.rejects(() => odataGet('https://x/y', 'tok', fakeRequest), /OData request failed/);
});


// --- parseEnvironmentUrl: PAC `pac env who` label compatibility (2.8.x "Org URL:") ---

test('parseEnvironmentUrl extracts the URL from the 2.8.x "Org URL:" banner', () => {
  const { parseEnvironmentUrl } = require(helpersPath);
  // Real `pac env who` shape on PAC 2.8.1 — the URL is under "Org URL:",
  // and there is an "Environment ID:" line but NO "Environment URL:" line.
  const who = [
    'Connected as admin@contoso.onmicrosoft.com',
    'Connected to... CitizenServicesDev',
    'Organization Information',
    '  Org ID:                     00e3facc-644f-f111-b31f-6045bd29e553',
    '  Friendly Name:              CitizenServicesDev',
    '  Org URL:                    https://org4a2942d9.crm17.dynamics.com/',
    '  Environment ID:             d3b0c5e9-6fd9-e4f0-9bdc-eaf672fb6c5d',
  ].join('\n');
  assert.equal(parseEnvironmentUrl(who), 'https://org4a2942d9.crm17.dynamics.com');
});

test('parseEnvironmentUrl still extracts the URL from the legacy "Environment URL:" banner', () => {
  const { parseEnvironmentUrl } = require(helpersPath);
  const who = 'Environment URL:    https://legacy.crm.dynamics.com/\nUser: x@y.com';
  assert.equal(parseEnvironmentUrl(who), 'https://legacy.crm.dynamics.com');
});

test('parseEnvironmentUrl returns null when no URL label is present (and on empty input)', () => {
  const { parseEnvironmentUrl } = require(helpersPath);
  assert.equal(parseEnvironmentUrl('Connected as x@y.com\nNo URL here'), null);
  assert.equal(parseEnvironmentUrl(''), null);
  assert.equal(parseEnvironmentUrl(null), null);
});

test('getEnvironmentUrl parses the 2.8.x "Org URL:" output via mocked execFileSync', (t) => {
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = () => '  Org URL:   https://orgABC.crm.dynamics.com/\n';
  t.after(() => { childProcess.execFileSync = originalExecFileSync; });
  // Re-require fresh so the module binds the mocked execFileSync.
  delete require.cache[require.resolve(helpersPath)];
  const { getEnvironmentUrl } = require(helpersPath);
  assert.equal(getEnvironmentUrl(), 'https://orgABC.crm.dynamics.com');
  delete require.cache[require.resolve(helpersPath)];
});
