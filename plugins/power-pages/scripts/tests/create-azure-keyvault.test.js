const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, '..', 'create-azure-keyvault.js');

function run(args = []) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PATH: '' },
  });
}

test('fails when no arguments are provided', () => {
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('fails when --name is missing', () => {
  const result = run(['--resourceGroup', 'myRG', '--location', 'eastus']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('fails when --resourceGroup is missing', () => {
  const result = run(['--name', 'myvault', '--location', 'eastus']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('fails when --location is missing', () => {
  const result = run(['--name', 'myvault', '--resourceGroup', 'myRG']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('fails when vault name is invalid (too short)', () => {
  const result = run(['--name', 'ab', '--resourceGroup', 'myRG', '--location', 'eastus']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /3-24 characters/);
});

test('fails when vault name starts with a number', () => {
  const result = run(['--name', '1vault', '--resourceGroup', 'myRG', '--location', 'eastus']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /starting with a letter/);
});

test('fails when az CLI is not available', () => {
  const result = run(['--name', 'myvault', '--resourceGroup', 'myRG', '--location', 'eastus']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to run Azure CLI|az/i);
});
