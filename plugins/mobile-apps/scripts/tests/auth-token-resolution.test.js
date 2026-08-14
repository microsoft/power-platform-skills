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
// Connection to port 1 is refused immediately, so the challenge probe (when it
// is reached at all) resolves fast and deterministically offline.
const UNREACHABLE_ENV_URL = 'https://127.0.0.1:1';

// The fake `az` writes one line per invocation to $FAKE_AZ_LOG, then emulates
// just the two subcommands getAuthToken uses:
//   az account show --query tenantId -o tsv
//   az account get-access-token --resource <url> [--tenant <id>] ...
// $FAKE_AZ_FAIL_TENANTS is a comma-separated list of tenants for which token
// acquisition should fail (exit 1), letting a test drive the fallback chain.
const FAKE_AZ = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AZ_LOG, args.join(' ') + '\\n');

if (args[0] === 'account' && args[1] === 'show') {
  process.stdout.write((process.env.FAKE_AZ_ACCOUNT_TENANT || '') + '\\n');
  process.exit(0);
}

if (args[0] === 'account' && args[1] === 'get-access-token') {
  const tenantIndex = args.indexOf('--tenant');
  const tenant = tenantIndex === -1 ? '' : args[tenantIndex + 1];
  const failing = (process.env.FAKE_AZ_FAIL_TENANTS || '').split(',').filter(Boolean);
  if (tenant && failing.includes(tenant)) process.exit(1);
  process.stdout.write('token-for:' + (tenant || 'active-account') + '\\n');
  process.exit(0);
}

process.exit(1);
`;

function makeFakeAz(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-az-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'az.js');
  const azPath = path.join(dir, 'az');
  const azCmdPath = path.join(dir, 'az.cmd');
  fs.writeFileSync(scriptPath, FAKE_AZ.replace(/^#![^\n]*\n/, ''));
  fs.writeFileSync(
    azPath,
    `#!${process.execPath}\nrequire(${JSON.stringify(scriptPath)});\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    azCmdPath,
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
  );
  return { dir, logPath: path.join(dir, 'az.log') };
}

function withPrependedPath(dir, overrides = {}) {
  const env = { ...process.env, ...overrides };
  const pathEntry = Object.entries(env).find(([key]) => key.toLowerCase() === 'path');
  const currentPath = pathEntry?.[1] ?? '';
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = `${dir}${path.delimiter}${currentPath}`;
  return env;
}

// Runs getAuthToken in a child process so PATH/env manipulation cannot leak
// into the test runner, and returns both the token and the az invocation log.
function runGetAuthToken(t, env = {}, explicitTenantId = null) {
  const { dir, logPath } = makeFakeAz(t);
  const script = `
    const { getAuthToken } = require(${JSON.stringify(HELPERS)});
    getAuthToken(${JSON.stringify(UNREACHABLE_ENV_URL)}, ${JSON.stringify(explicitTenantId)})
      .then((token) => { process.stdout.write(String(token)); })
      .catch((error) => { process.stderr.write(String(error)); process.exit(1); });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: withPrependedPath(dir, {
      FAKE_AZ_LOG: logPath,
      // Cleared unless a test opts in — the ambient shell may have them set.
      POWER_PLATFORM_TENANT_ID: '',
      DATAVERSE_TENANT_ID: '',
      FAKE_AZ_ACCOUNT_TENANT: '',
      FAKE_AZ_FAIL_TENANTS: '',
      ...env,
    }),
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
