const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const childProcess = require('child_process');

const helpersPath = path.join(__dirname, '..', 'lib', 'validation-helpers.js');

test('getAuthToken calls az account get-access-token without --allow-no-subscriptions (only az login accepts that flag)', () => {
  let captured = null;
  const { getAuthToken } = require(helpersPath);
  const token = getAuthToken('https://example.crm.dynamics.com', {
    platform: 'linux',
    execFile(file, args, options) {
      captured = { file, args, options };
      return 'fake-token-value\n';
    },
  });

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

test('getAuthToken invokes the Azure CLI cmd shim safely on Windows', () => {
  const { getAuthToken } = require(helpersPath);
  const calls = [];
  const token = getAuthToken('https://org.crm.dynamics.com', {
    platform: 'win32',
    execFile(file, args, options) {
      calls.push({ file, args, options });
      return 'windows-token\n';
    },
  });

  assert.equal(token, 'windows-token');
  assert.equal(calls[0].file, 'cmd.exe');
  assert.deepEqual(calls[0].args, [
    '/d', '/s', '/c', 'az.cmd',
    'account', 'get-access-token',
    '--resource', 'https://org.crm.dynamics.com',
    '--query', 'accessToken',
    '-o', 'tsv',
  ]);
  assert.equal(calls[0].options.shell, false);
});

test('getAuthToken rejects POSIX and Windows metacharacter payloads before invoking az', () => {
  const { getAuthToken } = require(helpersPath);
  let calls = 0;
  const deps = {
    platform: 'linux',
    execFile() {
      calls++;
      return 'should-not-run';
    },
  };

  assert.equal(getAuthToken('https://org.crm.dynamics.com/;echo-marker', deps), null);
  assert.equal(getAuthToken('https://org.crm.dynamics.com/&echo-marker%PATH%', deps), null);
  assert.equal(calls, 0);
});

test('URL validation accepts documented Dataverse and Power Platform sovereign-cloud hosts', () => {
  const {
    validateDataverseEnvironmentUrl,
    validateTokenResourceUrl,
    validateBapUrl,
    validateBapPollingUrl,
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
    validateDataverseEnvironmentUrl('HTTPS://ORG.CRM.DYNAMICS.COM'),
    'https://org.crm.dynamics.com',
  );
  assert.equal(
    validateDataverseEnvironmentUrl('HtTpS://Org.Api.Crm.MicrosoftDynamics.Us'),
    'https://org.api.crm.microsoftdynamics.us',
  );

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
  assert.equal(
    validateBapPollingUrl(
      '/providers/Microsoft.BusinessAppPlatform/lifecycleOperations/op-1',
      'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments',
    ),
    'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/lifecycleOperations/op-1',
  );
  assert.equal(
    validateBapPollingUrl(
      'https://api.bap.microsoft.com/lifecycleOperations/op-2',
      'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments',
    ),
    'https://api.bap.microsoft.com/lifecycleOperations/op-2',
  );
  assert.throws(
    () => validateBapPollingUrl(
      'https://high.api.bap.microsoft.us/lifecycleOperations/op-3',
      'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments',
    ),
    /different host/,
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
    'HTTPS://org.crm.dynamics.com:443',
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

test('parseActiveAuthListEnvironmentUrl extracts the active auth profile Environment Url', () => {
  const { parseActiveAuthListEnvironmentUrl } = require(helpersPath);
  const output = [
    'Index Active Kind      Name User                  Cloud  Type            Environment      Environment Url',
    '[1]   *      UNIVERSAL      user@contoso.com      Public OperatingSystem PowerPagesProDev https://powerpagesprodev.crm.dynamics.com/',
    '[2]          UNIVERSAL      user@contoso.com      Public OperatingSystem OtherEnv https://other.crm.dynamics.com/',
  ].join('\n');
  assert.equal(parseActiveAuthListEnvironmentUrl(output), 'https://powerpagesprodev.crm.dynamics.com');
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

test('getEnvironmentUrl falls back to active pac auth list Environment Url when pac env who has no URL', (t) => {
  const originalExecSync = childProcess.execSync;
  childProcess.execSync = (command) => {
    if (command === 'pac env who') return 'No organization selected\n';
    if (command === 'pac auth list') {
      return [
        'Index Active Kind      Name User                  Cloud  Type            Environment      Environment Url',
        '[1]   *      UNIVERSAL      user@contoso.com      Public OperatingSystem PowerPagesProDev https://powerpagesprodev.crm.dynamics.com/',
      ].join('\n');
    }
    throw new Error(`unexpected command: ${command}`);
  };
  t.after(() => { childProcess.execSync = originalExecSync; });
  delete require.cache[require.resolve(helpersPath)];

  const { getEnvironmentUrl } = require(helpersPath);

  assert.equal(getEnvironmentUrl(), 'https://powerpagesprodev.crm.dynamics.com');
  delete require.cache[require.resolve(helpersPath)];
});

// --- validateDataverseApiPath: Path traversal and origin enforcement ---

test('validateDataverseApiPath accepts valid Dataverse API paths', () => {
  const { validateDataverseApiPath } = require(helpersPath);
  const base = 'https://org.crm.dynamics.com';
  
  // plain entity set
  assert.equal(validateDataverseApiPath('accounts', base), `${base}/api/data/v9.2/accounts`);
  
  // key lookup
  assert.equal(validateDataverseApiPath('accounts(00000000-0000-0000-0000-000000000000)', base), `${base}/api/data/v9.2/accounts(00000000-0000-0000-0000-000000000000)`);
  
  // query strings
  assert.equal(validateDataverseApiPath('accounts?$select=name&$top=5', base), `${base}/api/data/v9.2/accounts?$select=name&$top=5`);
  
  // filter with encoded characters and spaces (should encode spaces in result)
  assert.equal(validateDataverseApiPath('accounts?$filter=name eq \'a%26b\'', base), `${base}/api/data/v9.2/accounts?$filter=name%20eq%20%27a%26b%27`);
  
  // $expand, nested navigation path
  assert.equal(validateDataverseApiPath('contacts(123)/account_primary_contact', base), `${base}/api/data/v9.2/contacts(123)/account_primary_contact`);
  
  // metadata
  assert.equal(validateDataverseApiPath("EntityDefinitions(LogicalName='account')/Attributes", base), `${base}/api/data/v9.2/EntityDefinitions(LogicalName='account')/Attributes`);
  
  // $batch
  assert.equal(validateDataverseApiPath('$batch', base), `${base}/api/data/v9.2/$batch`);
  
  // query containing ../ or // inside the QUERY string only
  assert.equal(validateDataverseApiPath('accounts?$filter=url eq \'https://evil.com/x\'', base), `${base}/api/data/v9.2/accounts?$filter=url%20eq%20%27https://evil.com/x%27`);
  assert.equal(validateDataverseApiPath('accounts?$filter=path eq \'../admin\'', base), `${base}/api/data/v9.2/accounts?$filter=path%20eq%20%27../admin%27`);
  
  // trailing slash and leading-slash behavior
  assert.equal(validateDataverseApiPath('accounts/', base), `${base}/api/data/v9.2/accounts/`);
  assert.equal(validateDataverseApiPath('/accounts', base), `${base}/api/data/v9.2/accounts`); // strips one leading slash
});

test('validateDataverseApiPath rejects path traversal and out-of-scope paths', () => {
  const { validateDataverseApiPath } = require(helpersPath);
  const base = 'https://org.crm.dynamics.com';
  
  // traversal
  assert.throws(() => validateDataverseApiPath('../../admin', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('..\\..\\admin', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('../v9.1/accounts', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('v9.2/../../x', base), /resolves outside the API base path/);
  
  // encoded traversal
  assert.throws(() => validateDataverseApiPath('%2e%2e/%2e%2e/admin', base), /resolves outside the API base path/);
  assert.throws(() => validateDataverseApiPath('..%2fadmin', base), /encoded path separators are not allowed/);
  assert.throws(() => validateDataverseApiPath('..%5cadmin', base), /encoded path separators are not allowed/);
  assert.throws(() => validateDataverseApiPath('EntityDefinitions%2f..%2f..%2fadmin', base), /encoded path separators are not allowed/);
  
  // origin changes
  assert.throws(() => validateDataverseApiPath('https://evil.com/x', base), /resolves to a different origin/);
  assert.throws(() => validateDataverseApiPath('//evil.com/x', base), /resolves outside the API base path/); // Because of leading slash stripping, this becomes /evil.com/x
  assert.throws(() => validateDataverseApiPath('///evil.com/x', base), /resolves to a different origin/); // /// -> // -> origin change
  assert.throws(() => validateDataverseApiPath('https://user:pass@evil.com/x', base), /resolves to a different origin/);
  
  // fragments
  assert.throws(() => validateDataverseApiPath('accounts#x', base), /fragments/);
  
  // control characters
  assert.throws(() => validateDataverseApiPath('accounts\t', base), /control characters/);
  assert.throws(() => validateDataverseApiPath('accounts\r\n', base), /control characters/);
  
  // type and limits
  assert.throws(() => validateDataverseApiPath('', base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath('   ', base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath(null, base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath(undefined, base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath([], base), /non-empty string/);
  assert.throws(() => validateDataverseApiPath('a'.repeat(8001), base), /maximum length/);
});
