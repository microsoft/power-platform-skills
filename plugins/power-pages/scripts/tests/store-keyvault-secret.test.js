const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, '..', 'store-keyvault-secret.js');
const { parseArgs, runCli, storeKeyVaultSecret } = require('../store-keyvault-secret');

function runStoreKeyvaultSecret(args, opts = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    ...opts,
  });
}

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-keyvault-secret-test-'));
  const tempRoot = path.join(root, 'temporary files');
  fs.mkdirSync(tempRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return tempRoot;
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

test('store-keyvault-secret rejects explicit empty --secretValue without reading stdin', () => {
  let stderr = '';
  const status = runCli(
    [
      '--vaultName', 'my-vault',
      '--secretName', 'my-secret',
      '--secretValue', '',
    ],
    {
      stdin: {
        isTTY: false,
        get fd() {
          assert.fail('stdin must not be read when --secretValue is present');
        },
      },
      stdout: { write: () => assert.fail('empty secrets must not produce output') },
      stderr: { write: (value) => { stderr += value; } },
    }
  );

  assert.equal(status, 1);
  assert.equal(stderr, 'Error: Secret value is empty.\n');
});

for (const [name, args] of [
  [
    'bare trailing --secretValue',
    [
      '--vaultName', 'my-vault',
      '--secretName', 'my-secret',
      '--secretValue',
    ],
  ],
  [
    '--secretValue followed by another option',
    [
      '--vaultName', 'my-vault',
      '--secretName', 'my-secret',
      '--secretValue', '--unused',
    ],
  ],
]) {
  test(`store-keyvault-secret rejects ${name} without reading stdin`, () => {
    let stderr = '';
    const status = runCli(
      args,
      {
        stdin: {
          isTTY: false,
          get fd() {
            assert.fail('stdin must not be read when --secretValue is present');
          },
        },
        stdout: { write: () => assert.fail('missing values must not produce output') },
        stderr: { write: (value) => { stderr += value; } },
      },
      {
        spawnSyncImpl: () => assert.fail('az must not run for a missing secret value'),
      }
    );

    assert.equal(status, 1);
    assert.equal(stderr, 'Error: Secret value is empty.\n');
  });
}

test('store-keyvault-secret parses unambiguous inline secret values verbatim', () => {
  assert.equal(
    parseArgs(['--secretValue=--foo']).secretValue,
    '--foo'
  );
  assert.equal(
    parseArgs(['--secretValue=value with spaces=and=equals']).secretValue,
    'value with spaces=and=equals'
  );
});

test('store-keyvault-secret rejects empty inline --secretValue without reading stdin', () => {
  let stderr = '';
  const status = runCli(
    [
      '--vaultName', 'my-vault',
      '--secretName', 'my-secret',
      '--secretValue=',
    ],
    {
      stdin: {
        isTTY: false,
        get fd() {
          assert.fail('stdin must not be read when inline --secretValue is present');
        },
      },
      stdout: { write: () => assert.fail('empty secrets must not produce output') },
      stderr: { write: (value) => { stderr += value; } },
    }
  );

  assert.equal(status, 1);
  assert.equal(stderr, 'Error: Secret value is empty.\n');
});

test('store-keyvault-secret uses a private temp directory and keeps the secret out of az argv', (t) => {
  const tempRoot = makeTempRoot(t);
  const secretValue = 'secret value with spaces';
  let report;

  const result = storeKeyVaultSecret(
    {
      vaultName: 'my-vault',
      secretName: 'my-secret',
      secretValue,
    },
    {
      osImpl: { tmpdir: () => tempRoot },
      spawnSyncImpl(command, args, options) {
        const fileIndex = args.indexOf('--file');
        const secretPath = fileIndex === -1 ? null : args[fileIndex + 1];
        report = {
          command,
          args,
          options,
          secret: fs.readFileSync(secretPath, 'utf8'),
          secretPath,
          fileMode: fs.statSync(secretPath).mode & 0o777,
          directoryMode: fs.statSync(path.dirname(secretPath)).mode & 0o777,
        };
        return {
          status: 0,
          stdout: JSON.stringify({
            secretUri: 'https://example.vault.azure.net/secrets/test/version',
          }),
          stderr: '',
        };
      },
    }
  );

  assert.equal(result.secretUri, 'https://example.vault.azure.net/secrets/test/version');
  assert.equal(report.command, 'az');
  assert.deepEqual(report.options, { encoding: 'utf8', timeout: 30000 });
  assert.equal(report.secret, secretValue);
  assert.equal(report.args.includes(secretValue), false);
  assert.notEqual(path.dirname(report.secretPath), tempRoot);
  assert.equal(report.secretPath.startsWith(`${tempRoot}${path.sep}`), true);
  assert.equal(fs.existsSync(report.secretPath), false);
  assert.equal(fs.existsSync(path.dirname(report.secretPath)), false);
  if (process.platform !== 'win32') {
    assert.equal(report.fileMode, 0o600);
    assert.equal(report.directoryMode, 0o700);
  }
});

test('store-keyvault-secret cleans up the private temp directory when az fails', (t) => {
  const tempRoot = makeTempRoot(t);
  const secretValue = 'secret-on-failure';
  let report;

  assert.throws(
    () => storeKeyVaultSecret(
      {
        vaultName: 'my-vault',
        secretName: 'my-secret',
        secretValue,
      },
      {
        osImpl: { tmpdir: () => tempRoot },
        spawnSyncImpl(command, args) {
          const fileIndex = args.indexOf('--file');
          const secretPath = fileIndex === -1 ? null : args[fileIndex + 1];
          report = {
            command,
            args,
            secret: fs.readFileSync(secretPath, 'utf8'),
            secretPath,
          };
          return {
            status: 7,
            stdout: '',
            stderr: 'fake Azure CLI failure\n',
          };
        },
      }
    ),
    (error) => {
      assert.equal(error.code, 'AZ_COMMAND_FAILED');
      assert.equal(error.stderr, 'fake Azure CLI failure\n');
      return true;
    }
  );

  assert.equal(report.command, 'az');
  assert.equal(report.secret, secretValue);
  assert.equal(report.args.includes(secretValue), false);
  assert.notEqual(path.dirname(report.secretPath), tempRoot);
  assert.equal(report.secretPath.startsWith(`${tempRoot}${path.sep}`), true);
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
