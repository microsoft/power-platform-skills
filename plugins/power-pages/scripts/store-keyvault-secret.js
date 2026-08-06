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

function getArg(args, name) {
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  const inlineArg = args.find((arg) => arg.startsWith(`${flag}=`));

  if (idx === -1) {
    // Slice after the first `=` so values can contain leading dashes, spaces, and
    // additional `=` characters without entering the spaced-form option grammar.
    return inlineArg === undefined ? null : inlineArg.slice(flag.length + 1);
  }

  // Arguments use `--name value`. A bare flag or `--name --other` is present but
  // empty, so callers can reject it without falling back to another input source.
  const value = args[idx + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}

function parseArgs(args) {
  return {
    vaultName: getArg(args, 'vaultName'),
    secretName: getArg(args, 'secretName'),
    secretValue: getArg(args, 'secretValue'),
  };
}

function cleanupTemporarySecret(
  fsImpl,
  tempFileHandle,
  tempFile,
  tempFileCreated,
  tempDir
) {
  const errors = [];

  if (tempFileHandle !== null) {
    try {
      fsImpl.closeSync(tempFileHandle);
    } catch (error) {
      errors.push(error);
    }
  }

  if (tempFileCreated) {
    try {
      fsImpl.unlinkSync(tempFile);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(error);
    }
  }

  if (tempDir) {
    try {
      fsImpl.rmdirSync(tempDir);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(error);
    }
  }

  if (errors.length === 1) {
    const error = new Error(`Failed to remove temporary secret artifacts: ${errors[0].message}`, {
      cause: errors[0],
    });
    error.code = 'TEMP_CLEANUP_FAILED';
    throw error;
  }

  if (errors.length > 1) {
    const detail = errors.map((item) => item.message).join('; ');
    const error = new AggregateError(
      errors,
      `Failed to remove temporary secret artifacts: ${detail}`
    );
    error.code = 'TEMP_CLEANUP_FAILED';
    throw error;
  }
}

function storeKeyVaultSecret(
  { vaultName, secretName, secretValue },
  {
    fsImpl = fs,
    osImpl = os,
    pathImpl = path,
    spawnSyncImpl = spawnSync,
    platform = process.platform,
  } = {}
) {
  let tempDir = null;
  let tempFile = null;
  let tempFileHandle = null;
  let tempFileCreated = false;
  let output;
  let operationError = null;
  let cleanupError = null;

  try {
    tempDir = fsImpl.mkdtempSync(pathImpl.join(osImpl.tmpdir(), 'kv-secret-'));

    // Node's POSIX mode bits do not map to Windows ACLs. On Windows, the private
    // directory inherits the current user's temp-directory DACL instead.
    // See: https://nodejs.org/api/fs.html#file-modes
    if (platform !== 'win32') {
      fsImpl.chmodSync(tempDir, 0o700);
    }

    tempFile = pathImpl.join(tempDir, 'secret');
    // `wx` maps to O_CREAT | O_EXCL, so an attacker-created file or symlink wins
    // the race by making this write fail instead of redirecting the secret.
    // See: https://nodejs.org/api/fs.html#file-system-flags
    tempFileHandle = fsImpl.openSync(tempFile, 'wx', 0o600);
    tempFileCreated = true;
    fsImpl.writeFileSync(tempFileHandle, secretValue, 'utf8');
    fsImpl.closeSync(tempFileHandle);
    tempFileHandle = null;

    const result = spawnSyncImpl('az', [
      'keyvault', 'secret', 'set',
      '--vault-name', vaultName,
      '--name', secretName,
      '--file', tempFile,
      '--encoding', 'utf-8',
      '--query', '{secretUri:id}',
      '-o', 'json',
    ], { encoding: 'utf8', timeout: 30000 });

    if (result.error) {
      const error = new Error('Failed to run Azure CLI.');
      error.code = 'AZ_SPAWN_FAILED';
      error.cause = result.error;
      throw error;
    }

    if (result.status !== 0) {
      const error = new Error(`Failed to store secret in Key Vault "${vaultName}".`);
      error.code = 'AZ_COMMAND_FAILED';
      error.stderr = result.stderr;
      throw error;
    }

    try {
      output = JSON.parse(result.stdout);
    } catch (cause) {
      const error = new Error('Failed to parse Azure CLI output.');
      error.code = 'AZ_OUTPUT_INVALID';
      error.cause = cause;
      throw error;
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      cleanupTemporarySecret(
        fsImpl,
        tempFileHandle,
        tempFile,
        tempFileCreated,
        tempDir
      );
    } catch (error) {
      cleanupError = error;
    }
  }

  if (operationError) {
    if (cleanupError) operationError.cleanupError = cleanupError;
    throw operationError;
  }
  if (cleanupError) throw cleanupError;

  return output;
}

function runCli(
  args = process.argv.slice(2),
  {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
  dependencies
) {
  const { vaultName, secretName, secretValue: secretValueArg } = parseArgs(args);

  if (!vaultName || !secretName) {
    stderr.write(
      'Usage:\n' +
      '  printf \'%s\' \'<value>\' | node store-keyvault-secret.js --vaultName <name> --secretName <name>\n' +
      '  node store-keyvault-secret.js --vaultName <name> --secretName <name> --secretValue <value>\n'
    );
    return 1;
  }

  // Azure Key Vault name: 3-24 chars, starts with letter, alphanumerics and hyphens
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(vaultName)) {
    stderr.write(
      'Error: --vaultName must be 3-24 characters, starting with a letter, containing only alphanumerics and hyphens.\n'
    );
    return 1;
  }

  // Key Vault secret name: 1-127 chars, alphanumerics and hyphens
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,125}[a-zA-Z0-9])?$/.test(secretName)) {
    stderr.write(
      'Error: --secretName must be 1-127 characters, alphanumerics and hyphens only.\n'
    );
    return 1;
  }

  // Resolve the secret value: use --secretValue when present, otherwise read stdin.
  let secretValue = secretValueArg;
  if (secretValue === null) {
    // Read from stdin (non-TTY only — don't block waiting for interactive input).
    if (stdin.isTTY) {
      stderr.write(
        'Error: No secret value provided. Pipe the value via stdin or pass --secretValue.\n'
      );
      return 1;
    }

    try {
      secretValue = fs.readFileSync(stdin.fd, 'utf8');
    } catch {
      stderr.write('Error: Failed to read secret value from stdin.\n');
      return 1;
    }
  }

  if (!secretValue) {
    stderr.write('Error: Secret value is empty.\n');
    return 1;
  }

  try {
    const result = storeKeyVaultSecret(
      { vaultName, secretName, secretValue },
      dependencies
    );
    stdout.write(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error.code === 'AZ_SPAWN_FAILED') {
      stderr.write('Failed to run Azure CLI. Ensure `az` is installed and available on PATH.\n');
    } else if (error.code === 'AZ_COMMAND_FAILED') {
      stderr.write(
        `Failed to store secret in Key Vault "${vaultName}". Ensure you have access and the vault exists.\n`
      );
      if (error.stderr) stderr.write(error.stderr);
    } else if (error.code === 'AZ_OUTPUT_INVALID') {
      stderr.write('Failed to parse Azure CLI output.\n');
    } else if (error.code === 'TEMP_CLEANUP_FAILED') {
      stderr.write(`${error.message}\n`);
    } else {
      stderr.write(`Failed to prepare temporary secret file: ${error.message}\n`);
    }

    if (error.cleanupError) {
      stderr.write(`${error.cleanupError.message}\n`);
    }
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  cleanupTemporarySecret,
  parseArgs,
  runCli,
  storeKeyVaultSecret,
};
