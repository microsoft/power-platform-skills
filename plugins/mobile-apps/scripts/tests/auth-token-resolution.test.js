'use strict';

// Guards the tenant-resolution short-circuit in lib/validation-helpers.js.
//
// getAuthToken() used to build its candidate list as an array literal, which
// evaluates EVERY element before `.filter()` runs. That meant each Dataverse
// call spawned `az account show` (~4.9s measured on a warm macOS box) and probed
// the WWW-Authenticate header even when POWER_PLATFORM_TENANT_ID already
// supplied the answer. A data-model run issues dozens of calls, so the waste
// dominated wall-clock time.
//
// These tests exercise the real code path rather than mocking internals: a fake
// `az` executable is placed first on PATH and logs every invocation, so we can
// assert exactly which subcommands ran. The resource URL points at 127.0.0.1:1
// so that if the challenge probe IS reached it fails instantly with
// ECONNREFUSED instead of touching the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPERS = path.join(__dirname, '..', 'lib', 'validation-helpers.js');
const FAKE_AZ_PRELOAD = path.join(__dirname, 'helpers', 'fake-az-preload.js');
// Connection to port 1 is refused immediately, so the challenge probe (when it
// is reached at all) resolves fast and deterministically offline.
const UNREACHABLE_ENV_URL = 'https://127.0.0.1:1';

// The Node preload intercepts `execFileSync('az', ...)`, writes one line per
// invocation to $FAKE_AZ_LOG, then emulates the two subcommands getAuthToken uses:
//   az account show --query tenantId -o tsv
//   az account get-access-token --resource <url> [--tenant <id>] ...
// $FAKE_AZ_FAIL_TENANTS is a comma-separated list of tenants for which token
// acquisition should fail (exit 1), letting a test drive the fallback chain.
function makeFakeAzLog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-az-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'az.log');
}

// Runs getAuthToken in a child process so preload/env manipulation cannot leak
// into the test runner, and returns both the token and the az invocation log.
function runGetAuthToken(t, env = {}, explicitTenantId = null) {
  const logPath = makeFakeAzLog(t);
  const script = `
    const { getAuthToken } = require(${JSON.stringify(HELPERS)});
    getAuthToken(${JSON.stringify(UNREACHABLE_ENV_URL)}, ${JSON.stringify(explicitTenantId)})
      .then((token) => { process.stdout.write(String(token)); })
      .catch((error) => { process.stderr.write(String(error)); process.exit(1); });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${FAKE_AZ_PRELOAD}`,
      FAKE_AZ_LOG: logPath,
      // Cleared unless a test opts in — the ambient shell may have them set.
      POWER_PLATFORM_TENANT_ID: '',
      DATAVERSE_TENANT_ID: '',
      FAKE_AZ_ACCOUNT_TENANT: '',
      FAKE_AZ_FAIL_TENANTS: '',
      ...env,
    },
  });

  assert.equal(result.status, 0, `getAuthToken failed: ${result.stderr}`);
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return { token: result.stdout.trim(), log };
}

test('explicit tenant argument short-circuits shell environment and discovery', (t) => {
  const { token, log } = runGetAuthToken(
    t,
    {
      POWER_PLATFORM_TENANT_ID: 'tenant-from-env',
      DATAVERSE_TENANT_ID: 'secondary-tenant',
      FAKE_AZ_ACCOUNT_TENANT: 'tenant-from-az-account',
    },
    'explicit-tenant',
  );

  assert.equal(token, 'token-for:explicit-tenant');
  assert.doesNotMatch(log, /account show/);
  assert.equal(log.trim().split('\n').length, 1);
});

test('an inaccessible explicit tenant cannot fall back to an ambient identity', (t) => {
  const { token, log } = runGetAuthToken(t, {
    POWER_PLATFORM_TENANT_ID: 'tenant-from-env',
    DATAVERSE_TENANT_ID: 'secondary-tenant',
    FAKE_AZ_ACCOUNT_TENANT: 'tenant-from-az-account',
    FAKE_AZ_FAIL_TENANTS: 'selected-tenant',
  }, 'selected-tenant');
  assert.equal(token, 'null');
  assert.equal(log.trim().split('\n').length, 1);
  assert.match(log, /--tenant selected-tenant/);
  assert.doesNotMatch(log, /account show|tenant-from-env|secondary-tenant|tenant-from-az-account/);
});

for (const tenant of ['', '  ']) {
  test(`an empty explicit tenant ${JSON.stringify(tenant)} cannot use ambient auth`, (t) => {
    const { token, log } = runGetAuthToken(t, {
      POWER_PLATFORM_TENANT_ID: 'tenant-from-env',
    }, tenant);
    assert.equal(token, 'null');
    assert.equal(log, '');
  });
}

test('env-supplied tenant short-circuits: no `az account show` is spawned', (t) => {
  const { token, log } = runGetAuthToken(t, {
    POWER_PLATFORM_TENANT_ID: 'tenant-from-env',
    FAKE_AZ_ACCOUNT_TENANT: 'tenant-from-az-account',
  });

  assert.equal(token, 'token-for:tenant-from-env');
  assert.match(log, /get-access-token/);
  // The regression this test exists for.
  assert.doesNotMatch(log, /account show/);
  // Exactly one az invocation — nothing speculative.
  assert.equal(log.trim().split('\n').length, 1);
});

test('POWER_PLATFORM_TENANT_ID wins over DATAVERSE_TENANT_ID', (t) => {
  const { token } = runGetAuthToken(t, {
    POWER_PLATFORM_TENANT_ID: 'primary-tenant',
    DATAVERSE_TENANT_ID: 'secondary-tenant',
  });

  assert.equal(token, 'token-for:primary-tenant');
});

test('falls through to the next candidate when a tenant yields no token', (t) => {
  const { token, log } = runGetAuthToken(t, {
    POWER_PLATFORM_TENANT_ID: 'broken-tenant',
    DATAVERSE_TENANT_ID: 'working-tenant',
    FAKE_AZ_FAIL_TENANTS: 'broken-tenant',
  });

  assert.equal(token, 'token-for:working-tenant');
  assert.match(log, /--tenant broken-tenant/);
  assert.match(log, /--tenant working-tenant/);
});

test('still falls back to `az account show` when no env tenant is set', (t) => {
  // With no env tenant and an unreachable endpoint, the challenge probe yields
  // nothing, so the az active-account tenant must still be consulted.
  const { token, log } = runGetAuthToken(t, {
    FAKE_AZ_ACCOUNT_TENANT: 'tenant-from-az-account',
  });

  assert.match(log, /account show/);
  assert.equal(token, 'token-for:tenant-from-az-account');
});

test('final fallback mints an unqualified token when no tenant resolves', (t) => {
  // No env tenant, unreachable challenge, and `az account show` returns blank.
  const { token, log } = runGetAuthToken(t);

  assert.match(log, /account show/);
  assert.equal(token, 'token-for:active-account');
  assert.doesNotMatch(log, /--tenant/);
});

function runMetadataHelper(t, script, args, env = {}) {
  const logPath = makeFakeAzLog(t);
  const directory = path.dirname(logPath);
  const requestLog = path.join(directory, 'requests.jsonl');
  const preload = path.join(directory, 'metadata-preload.cjs');
  // The preload follows list-table-columns into its request subprocesses, so
  // the real argument/token plumbing runs without Azure or HTTP traffic.
  fs.writeFileSync(preload, `
const fs = require('node:fs');
require(${JSON.stringify(FAKE_AZ_PRELOAD)});
const helpers = require(${JSON.stringify(HELPERS)});
helpers.makeRequest = async ({ url, headers }) => {
  fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({
    url, authorization: headers.Authorization,
  }) + '\\n');
  return {
    statusCode: 200,
    body: JSON.stringify(url.endsWith('/WhoAmI')
      ? { UserId: 'mock-user', OrganizationId: 'mock-organization' }
      : { value: [
        { LogicalName: 'cr_title', AttributeType: 'String', RequiredLevel: { Value: 'ApplicationRequired' } },
        { LogicalName: 'createdon', AttributeType: 'DateTime' },
      ] }),
  };
};
require(${JSON.stringify(path.join(__dirname, '..', 'emit-telemetry-checkpoint.js'))})
  .captureSuccessfulDataverseRequest = () => {};
`);
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', script), UNREACHABLE_ENV_URL, ...args,
  ], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      FAKE_AZ_LOG: logPath,
      FAKE_AZ_STATIC_TOKEN: '',
      FAKE_AZ_FAIL_TENANTS: '',
      POWER_PLATFORM_TENANT_ID: 'tenant-from-env',
      DATAVERSE_TENANT_ID: 'secondary-tenant',
      FAKE_AZ_ACCOUNT_TENANT: 'tenant-from-az-account',
      POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
      ...env,
    },
  });
  assert.ifError(result.error);
  return {
    result,
    calls: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : [],
    requests: fs.existsSync(requestLog)
      ? fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

for (const [script, positionals, count] of [
  ['verify-dataverse-access.js', [], 1],
  ['list-table-columns.js', ['cr_visit', 'cr_airport'], 2],
]) {
  for (const explicit of [true, false]) {
    test(`${script} preserves output with ${explicit ? 'explicit' : 'legacy environment'} tenant selection`, (t) => {
      const args = [...positionals, ...(explicit ? ['--tenant-id', 'selected-tenant'] : [])];
      const { result, calls, requests } = runMetadataHelper(t, script, args);
      assert.equal(result.status, 0, result.stderr);
      const tenant = explicit ? 'selected-tenant' : 'tenant-from-env';
      assert.equal(calls.length, count);
      assert.ok(calls.every((call) => call.includes(`--tenant ${tenant}`)));
      assert.equal(requests.length, count);
      assert.ok(requests.every((request) => request.authorization === `Bearer token-for:${tenant}`));
      const data = JSON.parse(result.stdout);
      if (script === 'verify-dataverse-access.js') {
        assert.equal(data.userId, 'mock-user');
        assert.equal(data.organizationId, 'mock-organization');
        assert.equal(data.token, `token-for:${tenant}`);
      } else {
        assert.deepEqual(Object.keys(data), positionals);
        for (const table of positionals) {
          assert.deepEqual(data[table], [
            { name: 'cr_title', type: 'String', required: 'ApplicationRequired' },
          ]);
          assert.ok(requests.some((request) => request.url.includes(`LogicalName='${table}'`)));
        }
      }
    });
  }

  test(`${script} stops after the selected tenant is rejected`, (t) => {
    const { result, calls, requests } = runMetadataHelper(t, script,
      [...positionals, '--tenant-id', 'selected-tenant'],
      { FAKE_AZ_FAIL_TENANTS: 'selected-tenant' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to get Azure CLI token/);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /--tenant selected-tenant/);
    assert.deepEqual(requests, []);
  });

  for (const invalid of [
    ['--tenant-id'], ['--tenant-id', ''], ['--tenant-id', '  '],
    ['--tenant-id', '--unknown-option'],
  ]) {
    test(`${script} rejects malformed tenant arguments ${JSON.stringify(invalid)} before auth`, (t) => {
      const { result, calls, requests } = runMetadataHelper(t, script, [...positionals, ...invalid]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /tenant-id/);
      assert.deepEqual(calls, []);
      assert.deepEqual(requests, []);
    });
  }
}
