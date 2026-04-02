#!/usr/bin/env node

// Lists Azure Key Vaults available in the user's current Azure subscription.
// Uses Azure CLI (`az keyvault list`).
//
// Usage:
//   node list-azure-keyvaults.js
//
// Output (JSON to stdout):
//   [{ "name": "myvault", "resourceGroup": "myRG", "location": "eastus" }, ...]
//
// Exit codes:
//   0 - Success
//   1 - Azure CLI not available or not logged in

const { spawnSync } = require('child_process');

function main() {
  const result = spawnSync('az', [
    'keyvault', 'list',
    '--query', '[].{name:name, resourceGroup:resourceGroup, location:location}',
    '-o', 'json',
  ], { encoding: 'utf8', timeout: 30000 });

  if (result.error) {
    process.stderr.write('Failed to run Azure CLI. Ensure `az` is installed and available on PATH.\n');
    process.exit(1);
  }

  if (result.status !== 0) {
    process.stderr.write('Failed to list Azure Key Vaults. Ensure you are logged in (`az login`).\n');
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(1);
  }

  const output = (result.stdout || '').trim();
  if (!output) {
    process.stdout.write('[]');
    return;
  }

  try {
    const vaults = JSON.parse(output);
    process.stdout.write(JSON.stringify(vaults));
  } catch {
    process.stderr.write('Failed to parse Azure CLI output.\n');
    process.exit(1);
  }
}

main();
