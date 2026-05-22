const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, '..', 'store-keyvault-secret.js');

function runStoreKeyvaultSecret(args, opts = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    ...opts,
  });
}

test('store-keyvault-secret fails with no arguments', () => {
  const result = runStoreKeyvaultSecret([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('store-keyvault-secret fails with missing --secretName', () => {
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my-vault',
    '--secretValue', 'super-secret',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('store-keyvault-secret fails with no secret value and TTY-like stdin', () => {
  // Without --secretValue and without piped stdin, should fail
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my-vault',
    '--secretName', 'my-secret',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(result.status, 1);
});

test('store-keyvault-secret rejects invalid vault name (too short)', () => {
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'ab',
    '--secretName', 'my-secret',
    '--secretValue', 'value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--vaultName must be 3-24 characters/);
});

test('store-keyvault-secret rejects invalid vault name (special characters)', () => {
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my_vault!',
    '--secretName', 'my-secret',
    '--secretValue', 'value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--vaultName must be 3-24 characters/);
});

test('store-keyvault-secret rejects invalid secret name', () => {
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my-vault',
    '--secretName', 'bad_name!',
    '--secretValue', 'value',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--secretName must be 1-127 characters/);
});

test('store-keyvault-secret accepts --secretValue (fails at az CLI)', () => {
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my-vault',
    '--secretName', 'my-secret',
    '--secretValue', 'super-secret',
  ], { env: { ...process.env, PATH: '' } });
  // Passes validation but fails when calling az CLI (az unavailable with empty PATH)
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /--vaultName must be/);
  assert.doesNotMatch(result.stderr, /--secretName must be/);
});

test('store-keyvault-secret accepts secret via stdin (fails at az CLI)', () => {
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my-vault',
    '--secretName', 'my-secret',
  ], { input: 'super-secret-from-stdin', env: { ...process.env, PATH: '' } });
  // Passes validation but fails when calling az CLI
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /No secret value provided/);
  assert.doesNotMatch(result.stderr, /Secret value is empty/);
});

test('store-keyvault-secret rejects empty stdin', () => {
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my-vault',
    '--secretName', 'my-secret',
  ], { input: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Secret value is empty/);
});
