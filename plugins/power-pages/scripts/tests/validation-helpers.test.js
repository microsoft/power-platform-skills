const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const childProcess = require('child_process');

const helpersPath = path.join(__dirname, '..', 'lib', 'validation-helpers.js');

test('getAuthToken calls az account get-access-token without --allow-no-subscriptions (only az login accepts that flag)', (t) => {
  const originalExecFileSync = childProcess.execFileSync;
  let captured = null;

  childProcess.execFileSync = (file, args, options) => {
    captured = { file, args, options };
    const out = 'fake-token-value\n';
    return options && options.encoding ? out : Buffer.from(out);
  };
  delete require.cache[require.resolve(helpersPath)];

  t.after(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[require.resolve(helpersPath)];
  });

  const { getAuthToken } = require(helpersPath);
  const token = getAuthToken('https://example.crm.dynamics.com');

  assert.equal(token, 'fake-token-value');
  assert.equal(captured.file, 'az');
  assert.deepEqual(
    captured.args,
    ['account', 'get-access-token', '--resource', 'https://example.crm.dynamics.com', '--query', 'accessToken', '-o', 'tsv'],
  );
  assert.equal(captured.options.shell, false);
  assert.ok(
    !captured.args.includes('--allow-no-subscriptions'),
    'az account get-access-token rejects --allow-no-subscriptions on recent CLI versions; the helper must omit it.',
  );
});

test('getAuthToken rejects POSIX and Windows metacharacter payloads before invoking az', (t) => {
  const originalExecFileSync = childProcess.execFileSync;
  let calls = 0;
  childProcess.execFileSync = () => {
    calls++;
    return 'should-not-run';
  };
  delete require.cache[require.resolve(helpersPath)];
  t.after(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[require.resolve(helpersPath)];
  });

  const { getAuthToken } = require(helpersPath);
  assert.equal(getAuthToken('https://org.crm.dynamics.com/;echo-marker'), null);
  assert.equal(getAuthToken('https://org.crm.dynamics.com/&echo-marker%PATH%'), null);
  assert.equal(calls, 0);
});

test('URL validation accepts documented Dataverse and Power Platform sovereign-cloud hosts', () => {
  const {
    validateDataverseEnvironmentUrl,
    validateTokenResourceUrl,
    validateBapUrl,
  } = require(helpersPath);

  const dataverseUrls = [
    'https://org.crm9.dynamics.com',
    'https://org.api.crm.microsoftdynamics.us',
    'https://org.api.crm.appsplatform.us',
    'https://org.api.crm.dynamics.cn',
  ];
  for (const url of dataverseUrls) {
    assert.equal(validateDataverseEnvironmentUrl(url), url);
  }

  assert.equal(
    validateTokenResourceUrl('https://high.service.flow.microsoft.us/'),
    'https://high.service.flow.microsoft.us/',
  );
  assert.equal(
    validateTokenResourceUrl('https://high.gov.service.flow.microsoft.us/'),
    'https://high.gov.service.flow.microsoft.us/',
  );
  assert.equal(
    validateTokenResourceUrl('https://api.powerplatform.partner.microsoftonline.cn'),
    'https://api.powerplatform.partner.microsoftonline.cn',
  );
  assert.equal(
    validateBapUrl('https://dod.api.bap.microsoft.us/providers/example'),
    'https://dod.api.bap.microsoft.us/providers/example',
  );
});

test('URL validation rejects malicious hosts, credentials, ports, fragments, and unsafe host characters', async () => {
  const {
    validateDataverseEnvironmentUrl,
    validateTokenResourceUrl,
    makeRequest,
  } = require(helpersPath);

  const invalid = [
    'http://org.crm.dynamics.com',
    'https://user:pass@org.crm.dynamics.com',
    'https://org.crm.dynamics.com:443',
    'https://org.crm.dynamics.com#fragment',
    'https://org.crm.dynamics.com.attacker.invalid',
    'https://org_crm.dynamics.com',
    'https://org.crm.dynamics.com\n.attacker.invalid',
  ];
  for (const url of invalid) {
    assert.throws(() => validateDataverseEnvironmentUrl(url));
  }
  assert.throws(() => validateTokenResourceUrl('https://example.invalid'));
  assert.throws(
    () => makeRequest({
      url: 'https://metadata.internal.invalid/token',
      headers: { Authorization: 'Bearer test-token' },
    }),
    /not an allowed Microsoft Dataverse or Power Platform endpoint/,
  );
});

// --- findProjectRoot: EDM / data-model site awareness ------------------------

test('findProjectRoot: recognizes a .powerpages-site/ directory as a project root (data-model/EDM sites)', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  // EDM/data-model site: .powerpages-site/ present, NO powerpages.config.json.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-edm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.powerpages-site'), { recursive: true });
  fs.writeFileSync(path.join(root, '.powerpages-site', 'website.yml'), 'id: x\nname: y\n');

  assert.equal(findProjectRoot(root), path.resolve(root));
});

test('findProjectRoot: still recognizes powerpages.config.json (code sites)', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'powerpages.config.json'), '{}');

  assert.equal(findProjectRoot(root), path.resolve(root));
});

test('findProjectRoot: returns null when neither marker is present', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-none-'));
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

test('getEnvironmentUrl parses the 2.8.x "Org URL:" output via mocked execSync', (t) => {
  const originalExecSync = childProcess.execSync;
  childProcess.execSync = () => '  Org URL:   https://orgABC.crm.dynamics.com/\n';
  t.after(() => { childProcess.execSync = originalExecSync; });
  // Re-require fresh so the module binds the mocked execSync.
  delete require.cache[require.resolve(helpersPath)];
  const { getEnvironmentUrl } = require(helpersPath);
  assert.equal(getEnvironmentUrl(), 'https://orgabc.crm.dynamics.com');
  delete require.cache[require.resolve(helpersPath)];
});
