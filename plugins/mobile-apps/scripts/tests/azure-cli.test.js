'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AzureCliLaunchError, resolveAzureCli, runAzureCli } = require('../lib/azure-cli');

const windowsRoot = "C:\\Program Files\\Azure CLI's tools (test) & 100%!";
const windowsLauncher = path.win32.join(windowsRoot, 'wbin', 'az.cmd');
const windowsPython = path.win32.join(windowsRoot, 'python.exe');
const graphUrl = 'https://graph.microsoft.com/v1.0/applications?%24select=appId%2CdisplayName&%24filter=appId+eq+%27test%27';
const msiLauncher = '@IF EXIST "%~dp0\\..\\python.exe" (\r\n  SET AZ_INSTALLER=MSI\r\n  "%~dp0\\..\\python.exe" -IBm azure.cli %*\r\n)\r\n';

function windowsOptions(overrides = {}) {
  return {
    platform: 'win32',
    env: { Path: path.win32.dirname(windowsLauncher) },
    exists: (file) => [windowsLauncher, windowsPython].includes(file),
    readFile: () => msiLauncher,
    realpath: (file) => file,
    ...overrides,
  };
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-azure-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

test('official Windows MSI and ZIP shims resolve to their own isolated Python runtime', () => {
  for (const installer of ['MSI', 'ZIP']) {
    const options = windowsOptions({ readFile: () => msiLauncher.replace('MSI', installer) });
    const invocation = resolveAzureCli(options);
    assert.equal(invocation.file, windowsPython);
    assert.deepEqual(invocation.prefix, ['-IBm', 'azure.cli']);
    assert.equal(invocation.env.AZ_INSTALLER, installer);
    assert.equal(invocation.env.Path, options.env.Path);
    assert.equal(options.env.AZ_INSTALLER, undefined);
  }
});

test('a side-by-side Python launcher uses that installation, never a Python from another PATH entry', () => {
  const launcher = 'C:\\Azure\\az.bat';
  const python = 'C:\\Azure\\python.exe';
  const invocation = resolveAzureCli(windowsOptions({
    env: { PATH: 'C:\\Azure;C:\\Different Python' },
    exists: (file) => [launcher, python, 'C:\\Different Python\\python.exe'].includes(file),
    readFile: () => '@echo off\r\nSET AZ_INSTALLER=PIP\r\n  "%~dp0\\python.exe" -m azure.cli %*\r\n',
  }));
  assert.equal(invocation.file, python);
  assert.deepEqual(invocation.prefix, ['-IBm', 'azure.cli']);
});

test('Windows launcher symlinks resolve the runtime beside the actual installation', () => {
  const invocation = resolveAzureCli(windowsOptions({
    env: { PATH: 'C:\\Links' },
    exists: (file) => ['C:\\Links\\az.cmd', windowsPython].includes(file),
    realpath: (file) => {
      assert.equal(file, 'C:\\Links\\az.cmd');
      return windowsLauncher;
    },
  }));
  assert.equal(invocation.file, windowsPython);
});

test('PATH resolution skips current-directory and relative entries on both platforms', () => {
  for (const [platform, env] of [
    ['win32', { PATH: '.;;tools;C:relative;C:\\Trusted' }],
    ['linux', { PATH: ':.:tools:/trusted' }],
  ]) {
    const seen = [];
    assert.throws(() => resolveAzureCli({
      platform, env, exists: (file) => { seen.push(file); return false; },
    }), (error) => error instanceof AzureCliLaunchError && error.code === 'AZURE_CLI_NOT_FOUND');
    const prefix = platform === 'win32' ? 'C:\\Trusted\\' : '/trusted/';
    assert.ok(seen.length > 0);
    assert.ok(seen.every((file) => file.startsWith(prefix)));
  }
});

test('resolution follows absolute PATH order and Windows environment-key casing', () => {
  const invocation = resolveAzureCli(windowsOptions({
    env: { Path: 'C:\\Old', PATH: '"C:\\Preferred";C:\\Later' },
    exists: (file) => ['C:\\Preferred\\az.exe', 'C:\\Later\\az.exe', 'C:\\Old\\az.exe'].includes(file),
    readFile: () => { throw new Error('Native executables do not need a batch parser'); },
  }));
  assert.equal(invocation.file, 'C:\\Preferred\\az.exe');
  assert.deepEqual(invocation.prefix, []);
});

test('native macOS and Linux launchers retain their original argv', () => {
  for (const platform of ['darwin', 'linux']) {
    let actual;
    const env = { PATH: '/opt/tools:/usr/bin' };
    const args = ['account', 'get-access-token', '--tenant', 'selected-tenant', '--resource', 'https://contoso.crm.dynamics.com'];
    assert.equal(runAzureCli(args, { encoding: 'utf8', timeout: 10000 }, {
      platform, env, exists: (file) => file === '/opt/tools/az',
      execFileSync: (file, argv, options) => {
        actual = { file, argv, options };
        return 'test-token';
      },
    }), 'test-token');
    assert.equal(actual.file, '/opt/tools/az');
    assert.deepEqual(actual.argv, args);
    assert.equal(actual.options.shell, false);
    assert.equal(actual.options.timeout, 10000);
  }
});

test('Windows argv preserves tenant selectors, encoded URLs and shell metacharacters without a shell', () => {
  const args = [
    'rest', '--url', graphUrl, '--tenant', 'selected-tenant',
    '--query', '{user:user.name,tenantId:tenantId}', 'a "quoted" value',
    '%PATH%', '!value!', '&|^()<>', '$literal $(text) `text`', '',
  ];
  const env = { ...windowsOptions().env, SECRET: 'not-for-diagnostics' };
  let actual;
  const result = runAzureCli(args, {
    env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    timeout: 30000, shell: true, windowsVerbatimArguments: true,
  }, windowsOptions({
    execFileSync(file, argv, options) {
      actual = { file, argv, options };
      return '{"value":[]}';
    },
  }));
  assert.equal(result, '{"value":[]}');
  assert.equal(actual.file, windowsPython);
  assert.deepEqual(actual.argv, ['-IBm', 'azure.cli', ...args]);
  assert.equal(actual.options.shell, false);
  assert.equal(actual.options.windowsVerbatimArguments, false);
  assert.equal(actual.options.windowsHide, true);
  assert.equal(actual.options.maxBuffer, 16 * 1024 * 1024);
  assert.equal(actual.options.timeout, 30000);
  assert.equal(actual.options.env.SECRET, env.SECRET);
  assert.equal(actual.options.env.AZ_INSTALLER, 'MSI');
});

test('missing runtime and unknown batch launchers fail explicitly before any process starts', () => {
  for (const [overrides, code] of [
    [{ exists: (file) => file === windowsLauncher }, 'AZURE_CLI_RUNTIME_MISSING'],
    [{ readFile: () => '@echo unknown custom launcher\r\n' }, 'AZURE_CLI_UNSUPPORTED_LAUNCHER'],
  ]) {
    assert.throws(() => runAzureCli(['account', 'show'], {}, windowsOptions({
      ...overrides,
      execFileSync: () => assert.fail('No process may start after resolution fails'),
    })), (error) => error instanceof AzureCliLaunchError && error.code === code);
  }
});

test('process-launch failures are distinguished without leaking arguments or token output', () => {
  for (const code of ['ENOENT', 'EACCES', 'EINVAL', 'ETIMEDOUT']) {
    assert.throws(() => runAzureCli(['--secret', 'private-argument'], {}, windowsOptions({
      execFileSync() {
        throw Object.assign(new Error('private-argument'), {
          code, status: null, stdout: 'private-token', stderr: 'private-diagnostic',
        });
      },
    })), (error) => {
      assert.ok(error instanceof AzureCliLaunchError);
      assert.equal(error.code, 'AZURE_CLI_LAUNCH_FAILED');
      assert.match(error.message, new RegExp(code));
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
  }
});

test('real CLI exit failures retain exit status and stderr for normal authentication handling', () => {
  const failure = Object.assign(new Error('Azure CLI exited'), { status: 1, stderr: 'Sign in to the selected tenant.' });
  assert.throws(() => runAzureCli(['account', 'show'], {}, windowsOptions({
    execFileSync: () => { throw failure; },
  })), (error) => error === failure);
});

test('invalid argv is rejected before resolving or starting Azure CLI', () => {
  for (const args of [null, 'account show', [7], ['invalid\0argument']]) {
    assert.throws(() => runAzureCli(args, {}, {
      exists: () => assert.fail('Arguments must be validated first'),
    }), TypeError);
  }
});

test('Dataverse authentication preserves launcher failures instead of attempting tenant fallbacks', (t) => {
  const cwd = temporary(t);
  const helper = path.resolve(__dirname, '../lib/validation-helpers.js');
  const script = `
require(${JSON.stringify(helper)}).getAuthToken('https://contoso.crm.dynamics.com', 'selected-tenant')
  .then(() => { process.exitCode = 2; }, (error) => {
    process.stderr.write(error.code + ': ' + error.message);
    process.exitCode = 1;
  });
`;
  const env = { ...process.env, PATH: '', POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' };
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
  }
  const result = spawnSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^AZURE_CLI_NOT_FOUND: Azure CLI was not found on PATH/);
  assert.doesNotMatch(result.stderr, /az login|selected-tenant/);
  assert.equal(result.stdout, '');
});

test('native executable fixture runs from PATH, not a same-named file in the project', (t) => {
  const directory = temporary(t);
  const bin = path.join(directory, 'trusted bin');
  const cwd = path.join(directory, "app's folder");
  fs.mkdirSync(bin);
  fs.mkdirSync(cwd);
  const probe = path.join(bin, 'probe.cjs');
  fs.writeFileSync(probe, 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
  let args;
  if (process.platform === 'win32') {
    fs.copyFileSync(process.execPath, path.join(bin, 'az.exe'));
    fs.writeFileSync(path.join(cwd, 'az.exe'), 'not an executable');
    args = [probe, '--tenant', 'selected-tenant', graphUrl];
  } else {
    fs.writeFileSync(path.join(bin, 'az'), '#!/bin/sh\nexec "$REAL_NODE" "$AZURE_TEST_PROBE" "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(cwd, 'az'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    args = ['--tenant', 'selected-tenant', graphUrl];
  }
  const env = { ...process.env, PATH: bin, REAL_NODE: process.execPath, AZURE_TEST_PROBE: probe };
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
  }
  const result = JSON.parse(runAzureCli(args, { env, cwd, encoding: 'utf8', timeout: 10000 }));
  assert.deepEqual(result.args, ['--tenant', 'selected-tenant', graphUrl]);
  assert.equal(fs.realpathSync(result.cwd), fs.realpathSync(cwd));
});

test('Windows installed Azure CLI supports real module execution without cmd.exe', {
  skip: process.platform !== 'win32' ? 'Windows Azure CLI installation smoke test' : false,
  timeout: 90000,
}, (t) => {
  const directory = temporary(t);
  const env = {
    ...process.env,
    AZURE_CONFIG_DIR: directory,
    AZURE_CORE_COLLECT_TELEMETRY: 'false',
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
  };
  let invocation;
  try {
    invocation = resolveAzureCli({ env });
  } catch (error) {
    if (!process.env.CI && error.code === 'AZURE_CLI_NOT_FOUND') {
      t.skip('Azure CLI is not installed locally; Windows CI requires it');
      return;
    }
    throw error;
  }
  assert.match(invocation.file, /python\.exe$/i, 'Exercise the real Windows batch-launcher installation');
  const version = JSON.parse(runAzureCli(['version', '--output', 'json'], {
    env, cwd: directory, encoding: 'utf8', timeout: 60000,
  }));
  assert.match(version['azure-cli'], /^\d+\.\d+\.\d+/);
  const args = [graphUrl, '%PATH%', '!value!', 'a "quote" & literal', "an apostrophe's path"];
  const received = JSON.parse(execFileSync(invocation.file, [
    '-I', '-c', 'import json,sys; print(json.dumps(sys.argv[1:]))', ...args,
  ], { env: invocation.env, cwd: directory, shell: false, encoding: 'utf8', timeout: 10000 }));
  assert.deepEqual(received, args);
});
