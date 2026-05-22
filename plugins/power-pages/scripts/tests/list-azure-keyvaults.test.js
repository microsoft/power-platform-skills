const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, '..', 'list-azure-keyvaults.js');

function runListAzureKeyvaults() {
  return spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    // Use a short timeout — the script calls `az` which may not be installed
    timeout: 10000,
    env: { ...process.env, PATH: '' },
  });
}

test('list-azure-keyvaults fails when az CLI is not available', () => {
  const result = runListAzureKeyvaults();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to run Azure CLI|az/i);
});
