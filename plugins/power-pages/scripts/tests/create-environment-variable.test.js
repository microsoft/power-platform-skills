const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, '..', 'create-environment-variable.js');
const FAKE_ENV_URL = 'https://org123.crm.dynamics.com';

function runCreateEnvVar(args, opts = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    ...opts,
  });
}

test('create-environment-variable fails with no arguments', () => {
  const result = runCreateEnvVar([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('create-environment-variable fails with missing envUrl', () => {
  const result = runCreateEnvVar([
    '--schemaName', 'cr5b4_ApiSecret',
    '--displayName', 'API Secret',
    '--value', 'my-secret-value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('create-environment-variable rejects malicious envUrl (shell injection)', () => {
  const result = runCreateEnvVar([
    'https://evil.com; rm -rf /',
    '--schemaName', 'cr5b4_ApiSecret',
    '--displayName', 'API Secret',
    '--value', 'my-secret-value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /valid HTTPS URL/);
});

test('create-environment-variable rejects non-HTTPS envUrl', () => {
  const result = runCreateEnvVar([
    'http://org123.crm.dynamics.com',
    '--schemaName', 'cr5b4_ApiSecret',
    '--displayName', 'API Secret',
    '--value', 'my-secret-value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /valid HTTPS URL/);
});

test('create-environment-variable fails with missing --displayName', () => {
  const result = runCreateEnvVar([
    FAKE_ENV_URL,
    '--schemaName', 'cr5b4_ApiSecret',
    '--value', 'my-secret-value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('create-environment-variable fails with missing --value', () => {
  const result = runCreateEnvVar([
    FAKE_ENV_URL,
    '--schemaName', 'cr5b4_ApiSecret',
    '--displayName', 'API Secret',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('create-environment-variable rejects invalid --type', () => {
  const result = runCreateEnvVar([
    FAKE_ENV_URL,
    '--schemaName', 'cr5b4_ApiSecret',
    '--displayName', 'API Secret',
    '--value', 'value',
    '--type', 'number',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--type must be "string" or "secret"/);
});

test('create-environment-variable rejects invalid schema name (starts with digit)', () => {
  const result = runCreateEnvVar([
    FAKE_ENV_URL,
    '--schemaName', '123invalid',
    '--displayName', 'Test',
    '--value', 'value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--schemaName must start with a letter/);
});

test('create-environment-variable rejects invalid schema name (special characters)', () => {
  const result = runCreateEnvVar([
    FAKE_ENV_URL,
    '--schemaName', 'my-schema-name',
    '--displayName', 'Test',
    '--value', 'value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--schemaName must start with a letter/);
});

test('create-environment-variable accepts valid string type args (fails at auth)', () => {
  const result = runCreateEnvVar([
    FAKE_ENV_URL,
    '--schemaName', 'cr5b4_ApiSecret',
    '--displayName', 'API Secret',
    '--value', 'my-secret-value',
  ], { env: { ...process.env, PATH: '' } });
  // Passes validation but fails when getting auth token (az CLI unavailable)
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /--type must be/);
  assert.doesNotMatch(result.stderr, /--schemaName must/);
});

test('create-environment-variable accepts valid secret type args (fails at auth)', () => {
  const result = runCreateEnvVar([
    FAKE_ENV_URL,
    '--schemaName', 'cr5b4_VaultSecret',
    '--displayName', 'Vault Secret',
    '--value', 'https://myvault.vault.azure.net/secrets/mysecret/abc123',
    '--type', 'secret',
  ], { env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /--type must be/);
});
