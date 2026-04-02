#!/usr/bin/env node

// Stores a secret in an Azure Key Vault using Azure CLI.
// Uses `spawnSync` (no shell) to safely pass the secret value without shell interpretation.
//
// Usage:
//   node store-keyvault-secret.js --vaultName <name> --secretName <name> --secretValue <value>
//
// Output (JSON to stdout):
//   { "secretUri": "https://myvault.vault.azure.net/secrets/mysecret/abc123..." }
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

const vaultName = getArg('vaultName');
const secretName = getArg('secretName');
const secretValue = getArg('secretValue');

if (!vaultName || !secretName || !secretValue) {
  process.stderr.write(
    'Usage: node store-keyvault-secret.js --vaultName <name> --secretName <name> --secretValue <value>\n'
  );
  process.exit(1);
}

// Azure Key Vault name: 3-24 chars, starts with letter, alphanumerics and hyphens
if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(vaultName)) {
  process.stderr.write(
    'Error: --vaultName must be 3-24 characters, starting with a letter, containing only alphanumerics and hyphens.\n'
  );
  process.exit(1);
}

// Key Vault secret name: 1-127 chars, alphanumerics and hyphens
if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,125}[a-zA-Z0-9])?$/.test(secretName)) {
  process.stderr.write(
    'Error: --secretName must be 1-127 characters, alphanumerics and hyphens only.\n'
  );
  process.exit(1);
}

const result = spawnSync('az', [
  'keyvault', 'secret', 'set',
  '--vault-name', vaultName,
  '--name', secretName,
  '--value', secretValue,
  '--query', '{secretUri:id}',
  '-o', 'json',
], { encoding: 'utf8', timeout: 30000 });

if (result.error) {
  process.stderr.write('Failed to run Azure CLI. Ensure `az` is installed and available on PATH.\n');
  process.exit(1);
}

if (result.status !== 0) {
  process.stderr.write(
    `Failed to store secret in Key Vault "${vaultName}". Ensure you have access and the vault exists.\n`
  );
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
