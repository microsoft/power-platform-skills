#!/usr/bin/env node

// Creates an Azure Key Vault in a specified resource group using Azure CLI.
//
// Usage:
//   node create-azure-keyvault.js --name <vault-name> --resourceGroup <rg-name> --location <location>
//
// Output (JSON to stdout):
//   { "name": "myvault", "resourceGroup": "myRG", "location": "eastus" }
//
// Exit codes:
//   0 - Success
//   1 - Validation or Azure CLI error

const { spawnSync } = require('child_process');

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const name = getArg('name');
const resourceGroup = getArg('resourceGroup');
const location = getArg('location');

if (!name || !resourceGroup || !location) {
  process.stderr.write(
    'Usage: node create-azure-keyvault.js --name <vault-name> --resourceGroup <rg-name> --location <location>\n'
  );
  process.exit(1);
}

// Azure Key Vault name: 3-24 chars, starts with letter, alphanumerics and hyphens
if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(name)) {
  process.stderr.write(
    'Error: --name must be 3-24 characters, starting with a letter, containing only alphanumerics and hyphens.\n'
  );
  process.exit(1);
}

const result = spawnSync('az', [
  'keyvault', 'create',
  '--name', name,
  '--resource-group', resourceGroup,
  '--location', location,
  '--query', '{name:name, resourceGroup:resourceGroup, location:location}',
  '-o', 'json',
], { encoding: 'utf8', timeout: 120000 });

if (result.error) {
  process.stderr.write('Failed to run Azure CLI. Ensure `az` is installed and available on PATH.\n');
  process.exit(1);
}

if (result.status !== 0) {
  process.stderr.write(`Failed to create Key Vault "${name}". Check that the name is globally unique and you have permissions.\n`);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

try {
  const parsed = JSON.parse(result.stdout);
  process.stdout.write(JSON.stringify(parsed));
} catch {
  process.stderr.write('Failed to parse Azure CLI output.\n');
  process.exit(1);
}
