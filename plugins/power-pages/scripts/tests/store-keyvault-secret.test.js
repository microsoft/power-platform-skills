const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, '..', 'store-keyvault-secret.js');
const { storeKeyVaultSecret } = require('../store-keyvault-secret');

function runStoreKeyvaultSecret(args, opts = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    ...opts,
  });
}

function makeFakeAzureCli(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-keyvault-secret-test-'));
  const binDir = path.join(root, 'fake az bin');
  const tempRoot = path.join(root, 'temporary files');
  const reportPath = path.join(root, 'az-report.json');
  const fakeAzPath = path.join(binDir, 'fake-az.js');

  fs.mkdirSync(binDir);
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(fakeAzPath, `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const fileIndex = args.indexOf('--file');
const secretPath = fileIndex === -1 ? null : args[fileIndex + 1];
const report = {
  argv: args,
  secret: secretPath ? fs.readFileSync(secretPath, 'utf8') : null,
  secretPath,
  fileMode: secretPath ? fs.statSync(secretPath).mode & 0o777 : null,
  directoryMode: secretPath ? fs.statSync(path.dirname(secretPath)).mode & 0o777 : null,
};
fs.writeFileSync(process.env.FAKE_AZ_REPORT, JSON.stringify(report));
if (process.env.FAKE_AZ_EXIT) {
  process.stderr.write('fake Azure CLI failure\\n');
  process.exit(Number(process.env.FAKE_AZ_EXIT));
}
process.stdout.write(JSON.stringify({ secretUri: 'https://example.vault.azure.net/secrets/test/version' }));
`);

  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDir, 'az.cmd'),
      `@"${process.execPath}" "%~dp0fake-az.js" %*\r\n`
    );
  } else {
    const launcherPath = path.join(binDir, 'az');
    fs.writeFileSync(launcherPath, '#!/usr/bin/env node\nrequire("./fake-az.js");\n', { mode: 0o755 });
  }

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return {
    reportPath,
    tempRoot,
    env(overrides = {}) {
      return {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
        FAKE_AZ_REPORT: reportPath,
        ...overrides,
      };
    },
  };
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

test('store-keyvault-secret uses a private temp directory and keeps the secret out of az argv', (t) => {
  const fakeAzureCli = makeFakeAzureCli(t);
  const secretValue = 'secret value with spaces';
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my-vault',
    '--secretName', 'my-secret',
  ], { input: secretValue, env: fakeAzureCli.env() });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(fakeAzureCli.reportPath, 'utf8'));
  assert.equal(report.secret, secretValue);
  assert.equal(report.argv.includes(secretValue), false);
  assert.notEqual(path.dirname(report.secretPath), fakeAzureCli.tempRoot);
  assert.equal(report.secretPath.startsWith(`${fakeAzureCli.tempRoot}${path.sep}`), true);
  assert.equal(fs.existsSync(report.secretPath), false);
  assert.equal(fs.existsSync(path.dirname(report.secretPath)), false);
  if (process.platform !== 'win32') {
    assert.equal(report.fileMode, 0o600);
    assert.equal(report.directoryMode, 0o700);
  }
});

test('store-keyvault-secret cleans up the private temp directory when az fails', (t) => {
  const fakeAzureCli = makeFakeAzureCli(t);
  const result = runStoreKeyvaultSecret([
    '--vaultName', 'my-vault',
    '--secretName', 'my-secret',
  ], {
    input: 'secret-on-failure',
    env: fakeAzureCli.env({ FAKE_AZ_EXIT: '7' }),
  });

  assert.equal(result.status, 1);
  const report = JSON.parse(fs.readFileSync(fakeAzureCli.reportPath, 'utf8'));
  assert.equal(fs.existsSync(report.secretPath), false);
  assert.equal(fs.existsSync(path.dirname(report.secretPath)), false);
});

test('store-keyvault-secret creates the secret file exclusively and cleans up partial creation', () => {
  const calls = [];
  const existingPathError = new Error('path already exists');
  existingPathError.code = 'EEXIST';
  const fsImpl = {
    mkdtempSync(prefix) {
      calls.push(['mkdtempSync', prefix]);
      return '/tmp/kv-secret-private';
    },
    chmodSync(filePath, mode) {
      calls.push(['chmodSync', filePath, mode]);
    },
    openSync(filePath, flag, mode) {
      calls.push(['openSync', filePath, flag, mode]);
      throw existingPathError;
    },
    writeFileSync() {
      assert.fail('a pre-existing path must fail before writing');
    },
    closeSync() {
      assert.fail('a file that was not opened must not be closed');
    },
    unlinkSync() {
      assert.fail('a file that was not created must not be unlinked');
    },
    rmdirSync(filePath) {
      calls.push(['rmdirSync', filePath]);
    },
  };

  assert.throws(
    () => storeKeyVaultSecret(
      {
        vaultName: 'my-vault',
        secretName: 'my-secret',
        secretValue: 'do-not-follow',
      },
      {
        fsImpl,
        osImpl: { tmpdir: () => '/tmp' },
        pathImpl: path.posix,
        platform: 'linux',
        spawnSyncImpl: () => assert.fail('az must not run after exclusive creation fails'),
      }
    ),
    (error) => error === existingPathError
  );

  assert.deepEqual(calls, [
    ['mkdtempSync', '/tmp/kv-secret-'],
    ['chmodSync', '/tmp/kv-secret-private', 0o700],
    ['openSync', '/tmp/kv-secret-private/secret', 'wx', 0o600],
    ['rmdirSync', '/tmp/kv-secret-private'],
  ]);
});

test(
  'store-keyvault-secret does not follow a pre-existing symlink',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-keyvault-symlink-'));
    const privateDir = path.join(root, 'private');
    const targetPath = path.join(root, 'target');
    fs.mkdirSync(privateDir, { mode: 0o700 });
    fs.writeFileSync(targetPath, 'unchanged');
    fs.symlinkSync(targetPath, path.join(privateDir, 'secret'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    assert.throws(
      () => storeKeyVaultSecret(
        {
          vaultName: 'my-vault',
          secretName: 'my-secret',
          secretValue: 'must-not-reach-target',
        },
        {
          fsImpl: {
            ...fs,
            mkdtempSync: () => privateDir,
          },
          osImpl: { tmpdir: () => root },
          pathImpl: path,
          platform: process.platform,
          spawnSyncImpl: () => assert.fail('az must not run when the secret path is a symlink'),
        }
      ),
      (error) => {
        assert.equal(error.code, 'EEXIST');
        assert.equal(error.cleanupError.code, 'TEMP_CLEANUP_FAILED');
        return true;
      }
    );

    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'unchanged');
  }
);

test('store-keyvault-secret removes a partially written file when writing fails', () => {
  const calls = [];
  const writeError = new Error('disk is full');
  writeError.code = 'ENOSPC';
  const fsImpl = {
    mkdtempSync: () => '/tmp/kv-secret-private',
    chmodSync: () => {},
    openSync: () => 42,
    writeFileSync() {
      calls.push('write');
      throw writeError;
    },
    closeSync(handle) {
      calls.push(['close', handle]);
    },
    unlinkSync(filePath) {
      calls.push(['unlink', filePath]);
    },
    rmdirSync(filePath) {
      calls.push(['rmdir', filePath]);
    },
  };

  assert.throws(
    () => storeKeyVaultSecret(
      {
        vaultName: 'my-vault',
        secretName: 'my-secret',
        secretValue: 'partial-write-test',
      },
      {
        fsImpl,
        osImpl: { tmpdir: () => '/tmp' },
        pathImpl: path.posix,
        platform: 'linux',
        spawnSyncImpl: () => assert.fail('az must not run after a partial write'),
      }
    ),
    (error) => error === writeError
  );

  assert.deepEqual(calls, [
    'write',
    ['close', 42],
    ['unlink', '/tmp/kv-secret-private/secret'],
    ['rmdir', '/tmp/kv-secret-private'],
  ]);
});

test('store-keyvault-secret preserves the az failure when cleanup also fails', () => {
  const unlinkError = new Error('secret file is still busy');
  unlinkError.code = 'EBUSY';
  const directoryError = new Error('temporary directory is not empty');
  directoryError.code = 'ENOTEMPTY';
  const fsImpl = {
    mkdtempSync: () => 'C:\\Temp\\kv-secret-private',
    openSync: () => 42,
    writeFileSync: () => {},
    closeSync: () => {},
    unlinkSync: () => { throw unlinkError; },
    rmdirSync: () => { throw directoryError; },
  };

  assert.throws(
    () => storeKeyVaultSecret(
      {
        vaultName: 'my-vault',
        secretName: 'my-secret',
        secretValue: 'cleanup-test',
      },
      {
        fsImpl,
        osImpl: { tmpdir: () => 'C:\\Temp' },
        pathImpl: path.win32,
        platform: 'win32',
        spawnSyncImpl: () => ({
          status: 1,
          stderr: 'Azure denied the request',
        }),
      }
    ),
    (error) => {
      assert.equal(error.code, 'AZ_COMMAND_FAILED');
      assert.equal(error.stderr, 'Azure denied the request');
      assert.equal(error.cleanupError.code, 'TEMP_CLEANUP_FAILED');
      assert.match(error.cleanupError.message, /secret file is still busy/);
      assert.match(error.cleanupError.message, /temporary directory is not empty/);
      return true;
    }
  );
});
