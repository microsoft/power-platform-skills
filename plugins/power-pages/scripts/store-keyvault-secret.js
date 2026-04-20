#!/usr/bin/env node

// Stores a secret in an Azure Key Vault using Azure CLI.
// The secret value never appears as a CLI argument to `az` — it is written to a
// short-lived temp file (mode 0600) and passed via `--file` to avoid exposure in
// process listings.
//
// Usage (preferred — secret never in process args):
//   printf '%s' '<value>' | node store-keyvault-secret.js --vaultName <name> --secretName <name>
//
// Usage (convenience — secret is in the node process args but NOT in the az args):
//   node store-keyvault-secret.js --vaultName <name> --secretName <name> --secretValue <value>
//
// Output (JSON to stdout):
//   { "secretUri": "https://myvault.vault.azure.net/secrets/mysecret/abc123..." }
//
// Exit codes:
//   0 - Success
//   1 - Validation or Azure CLI error

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const vaultName = getArg('vaultName');
const secretName = getArg('secretName');
const secretValueArg = getArg('secretValue');

if (!vaultName || !secretName) {
  process.stderr.write(
    'Usage:\n' +
    '  printf \'%s\' \'<value>\' | node store-keyvault-secret.js --vaultName <name> --secretName <name>\n' +
    '  node store-keyvault-secret.js --vaultName <name> --secretName <name> --secretValue <value>\n'
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

// Resolve the secret value: prefer stdin, fall back to --secretValue
let secretValue = secretValueArg;

if (!secretValue) {
  // Read from stdin (non-TTY only — don't block waiting for interactive input)
  if (process.stdin.isTTY) {
    process.stderr.write(
      'Error: No secret value provided. Pipe the value via stdin or pass --secretValue.\n'
    );
    process.exit(1);
  }
  try {
    secretValue = fs.readFileSync(process.stdin.fd, 'utf8');
  } catch {
    process.stderr.write('Error: Failed to read secret value from stdin.\n');
    process.exit(1);
  }
}

if (!secretValue) {
  process.stderr.write('Error: Secret value is empty.\n');
  process.exit(1);
}

// Write the secret to a temp file with restrictive permissions (owner-only read/write).
// This avoids passing the secret as a CLI argument to `az`, which would be visible
// in process listings (ps, /proc) to other users on the same machine.
const tmpFile = path.join(os.tmpdir(), `kv-secret-${process.pid}-${Date.now()}`);

try {
  fs.writeFileSync(tmpFile, secretValue, { mode: 0o600 });

  const result = spawnSync('az', [
    'keyvault', 'secret', 'set',
    '--vault-name', vaultName,
    '--name', secretName,
    '--file', tmpFile,
    '--encoding', 'utf-8',
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
} finally {
  // Always clean up the temp file
  try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
}
