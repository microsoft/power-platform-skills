'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CliLaunchError, cliInvocation, resolveExecutable, runCliSync } = require('../lib/process-runner');
const { runAzureCli } = require('../lib/azure-cli');

const graphUrl = 'https://graph.microsoft.com/v1.0/applications?%24select=appId%2CdisplayName&%24filter=appId+eq+%27test%27';
const literalArguments = [
  '--tenant', 'selected-tenant', graphUrl, '{user:user.name,tenantId:tenantId}',
  'a "quoted" value', '%MOBILE_CLI_SENTINEL%', '!MOBILE_CLI_SENTINEL!',
  '&|^()<>', '$literal $(text) `text`', '', 'trailing\\', 'space and trailing\\',
];

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cli-runner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

function envWithPath(directory, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  return { ...env, PATH: directory };
}

function windowsOptions(file = 'C:\\CLI tools\\az.cmd', extra = {}) {
  return {
    platform: 'win32',
    env: { Path: path.win32.dirname(file), SystemRoot: 'C:\\Windows' },
    exists: (candidate) => candidate === file,
    readFile: () => '@echo off\r\n',
    ...extra,
  };
}

test('native command resolution skips implicit cwd and relative PATH entries on every platform', () => {
  for (const [platform, env, prefix] of [
    ['win32', { PATH: '.;;tools;C:relative;C:\\Trusted' }, 'C:\\Trusted\\'],
    ['linux', { PATH: ':.:tools:/trusted' }, '/trusted/'],
  ]) {
    const seen = [];
    assert.equal(resolveExecutable('az', {
      platform, env, exists: (file) => { seen.push(file); return false; },
    }), null);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((file) => file.startsWith(prefix)));
  }
});

test('Windows resolution follows PATH and PATHEXT order and Node environment-key casing', () => {
  const files = new Set(['C:\\Preferred\\az.cmd', 'C:\\Preferred\\az.exe', 'C:\\Later\\az.exe']);
  const options = windowsOptions('', {
    env: { Path: 'C:\\Old', PATH: '"C:\\Preferred";C:\\Later', PATHEXT: '.CMD;.EXE;.JS' },
    exists: (file) => files.has(file),
  });
  assert.equal(resolveExecutable('az', options), 'C:\\Preferred\\az.cmd');
  assert.equal(resolveExecutable('az.exe', options), 'C:\\Preferred\\az.exe');
  assert.equal(resolveExecutable('C:\\Later\\az.exe', options), 'C:\\Later\\az.exe');
  assert.equal(resolveExecutable('C:\\Missing\\az.exe', options), null);
});

test('every native executable preserves argv without shell interpolation', () => {
  for (const [platform, file] of [['win32', 'C:\\tools\\pa.exe'], ['darwin', '/opt/tools/pa'], ['linux', '/opt/tools/pa']]) {
    const invocation = cliInvocation(file, literalArguments, {
      platform, env: {}, exists: (candidate) => candidate === file,
    });
    assert.equal(invocation.file, file);
    assert.deepEqual(invocation.args, literalArguments);
    assert.equal(invocation.windowsVerbatimArguments, false);
  }
});

test('generic .cmd and .bat launchers use absolute cmd.exe with no tool-specific layout parsing', () => {
  for (const command of ['az', 'pa', 'npm', 'custom-cli']) {
    for (const extension of ['cmd', 'bat']) {
      const file = `C:\\CLI tools\\${command}.${extension}`;
      const invocation = cliInvocation(command, ['--version'], windowsOptions(file, {
        readFile: () => assert.fail('Simple arguments do not require inspecting a launcher'),
      }));
      assert.equal(invocation.file, 'C:\\Windows\\System32\\cmd.exe');
      assert.deepEqual(invocation.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
      assert.equal(invocation.windowsVerbatimArguments, true);
      assert.equal(invocation.env.NoDefaultCurrentDirectoryInExePath, '1');
      assert.ok(invocation.args[4].includes(`${command}.${extension}`));
    }
  }
});

test('batch interpreter lookup never falls back to a project-local cmd executable', () => {
  const file = 'C:\\tools\\az.cmd';
  const invocation = cliInvocation('az', [], windowsOptions(file, {
    env: { PATH: 'C:\\tools', ComSpec: 'cmd.exe', SystemRoot: 'D:\\Windows' },
  }));
  assert.equal(invocation.file, 'D:\\Windows\\System32\\cmd.exe');
  assert.throws(() => cliInvocation('az', [], windowsOptions(file, {
    env: { PATH: 'C:\\tools', ComSpec: 'cmd.exe' },
  })), (error) => error.code === 'CLI_LAUNCH_FAILED');
});

test('caller options cannot override the generic batch execution boundary', () => {
  let received;
  const result = runCliSync('az', ['version', '--output', 'json'], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    shell: true, windowsVerbatimArguments: false,
  }, windowsOptions(undefined, {
    execFileSync(file, args, options) {
      received = { file, args, options };
      return '{"version":"test"}';
    },
  }));
  assert.equal(result, '{"version":"test"}');
  assert.equal(received.options.shell, false);
  assert.equal(received.options.windowsVerbatimArguments, true);
  assert.equal(received.options.windowsHide, true);
  assert.equal(received.options.timeout, 30000);
  assert.equal(received.options.maxBuffer, 16 * 1024 * 1024);
});

test('batch arguments with controls or an unsafe delayed-expansion contract fail before launch', () => {
  for (const argument of ['line\nbreak', 'line\rbreak', 'tab\there']) {
    assert.throws(() => runCliSync('az', [argument], {}, windowsOptions(undefined, {
      execFileSync: () => assert.fail('Unsafe arguments must not launch'),
    })), (error) => error.code === 'CLI_UNSAFE_ARGUMENT');
  }
  assert.throws(() => runCliSync('az', ['!value!'], {}, windowsOptions(undefined, {
    readFile: () => '@setlocal EnableDelayedExpansion\r\n',
    execFileSync: () => assert.fail('Unsafe delayed expansion must not launch'),
  })), (error) => error.code === 'CLI_UNSAFE_ARGUMENT');
});

test('launcher errors remain distinct from CLI exits without exposing token output', () => {
  for (const code of ['ENOENT', 'EACCES', 'EINVAL', 'ETIMEDOUT']) {
    assert.throws(() => runCliSync('az', ['private-argument'], {}, windowsOptions(undefined, {
      execFileSync() {
        throw Object.assign(new Error('private-argument'), {
          code, status: null, stdout: 'private-token', stderr: 'private-diagnostic',
        });
      },
    })), (error) => {
      assert.ok(error instanceof CliLaunchError);
      assert.equal(error.code, 'CLI_LAUNCH_FAILED');
      assert.match(error.message, new RegExp(code));
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
  }
  const rejected = Object.assign(new Error('Sign in to the selected tenant.'), { status: 1 });
  assert.throws(() => runCliSync('az', ['account', 'show'], {}, windowsOptions(undefined, {
    execFileSync: () => { throw rejected; },
  })), (error) => error === rejected);
});

test('invalid commands and argv fail before launching', () => {
  for (const command of ['az account show', './az', 'tools/az', 'bad\ncommand']) {
    assert.throws(() => runCliSync(command, [], {}, { exists: () => false }), TypeError);
  }
  for (const args of [null, 'account show', [7], ['bad\0argument']]) {
    assert.throws(() => runCliSync('az', args, {}, { exists: () => false }), TypeError);
  }
});

test('Dataverse authentication preserves a missing-launcher error rather than trying another tenant', (t) => {
  const helper = path.resolve(__dirname, '../lib/validation-helpers.js');
  const source = `
require(${JSON.stringify(helper)}).getAuthToken('https://contoso.crm.dynamics.com', 'selected-tenant')
  .then(() => { process.exitCode = 2; }, (error) => {
    process.stderr.write(error.code + ': ' + error.message);
    process.exitCode = 1;
  });
`;
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: temporary(t), env: envWithPath(''), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^CLI_NOT_FOUND: CLI az was not found on PATH/);
  assert.doesNotMatch(result.stderr, /az login|selected-tenant/);
  assert.equal(result.stdout, '');
});

test('native executable fixture uses PATH rather than a same-named command in the project', (t) => {
  const directory = temporary(t);
  const bin = path.join(directory, 'trusted bin');
  const cwd = path.join(directory, "app's folder");
  fs.mkdirSync(bin);
  fs.mkdirSync(cwd);
  const probe = path.join(bin, 'probe.cjs');
  fs.writeFileSync(probe, 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
  let args = literalArguments;
  if (process.platform === 'win32') {
    fs.copyFileSync(process.execPath, path.join(bin, 'sample.exe'));
    fs.writeFileSync(path.join(cwd, 'sample.exe'), 'not executable');
    args = [probe, ...args];
  } else {
    fs.writeFileSync(path.join(bin, 'sample'), '#!/bin/sh\nexec "$REAL_NODE" "$CLI_TEST_PROBE" "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(cwd, 'sample'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  }
  const result = JSON.parse(runCliSync('sample', args, {
    cwd, env: envWithPath(bin, { REAL_NODE: process.execPath, CLI_TEST_PROBE: probe }),
    encoding: 'utf8', timeout: 10000,
  }));
  assert.deepEqual(result.args, literalArguments);
  assert.equal(fs.realpathSync(result.cwd), fs.realpathSync(cwd));
});

test('actual Windows batch launchers preserve argv and local-only flags without an Azure layout', {
  skip: process.platform !== 'win32' ? 'Requires Windows cmd.exe' : false,
}, (t) => {
  const directory = temporary(t);
  const bin = path.join(directory, "tools's (100%) & literal!");
  const npmBin = path.join(directory, 'node_modules', '.bin');
  const cwd = path.join(directory, 'another app');
  fs.mkdirSync(bin);
  fs.mkdirSync(npmBin, { recursive: true });
  fs.mkdirSync(cwd);
  const probe = path.join(directory, 'probe.cjs');
  fs.writeFileSync(probe, 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exit(Number(process.env.CLI_TEST_EXIT || 0));');
  const source = '@echo off\r\n"%CLI_TEST_NODE%" "%CLI_TEST_PROBE%" %*\r\n';
  for (const file of [path.join(bin, 'az.cmd'), path.join(bin, 'custom.bat'), path.join(npmBin, 'pa.cmd')]) {
    fs.writeFileSync(file, source);
    const env = envWithPath(path.dirname(file), {
      CLI_TEST_NODE: process.execPath, CLI_TEST_PROBE: probe,
      MOBILE_CLI_SENTINEL: 'MUST_NOT_EXPAND',
    });
    fs.writeFileSync(path.join(cwd, path.basename(file)), '@exit /b 99\r\n');
    const args = ['--no-install', ...literalArguments];
    const result = JSON.parse(runCliSync(file, args, { env, cwd, encoding: 'utf8', timeout: 15000 }));
    assert.deepEqual(result.args, args, file);
    assert.equal(fs.realpathSync(result.cwd), fs.realpathSync(cwd));
    assert.throws(() => runCliSync(file, ['--version'], {
      env: { ...env, CLI_TEST_EXIT: '7' }, cwd, encoding: 'utf8', timeout: 15000,
    }), (error) => error.status === 7);
  }
});

test('Windows runs the real installed az.cmd and preserves percent-bearing query arguments', {
  skip: process.platform !== 'win32' ? 'Windows Azure CLI installation smoke test' : false,
  timeout: 90000,
}, (t) => {
  const directory = temporary(t);
  const env = {
    ...process.env, AZURE_CONFIG_DIR: directory,
    AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
    MOBILE_CLI_SENTINEL: 'MUST_NOT_EXPAND',
  };
  const launcher = resolveExecutable('az', { env });
  if (!launcher && !process.env.CI) return t.skip('Azure CLI not installed locally; required in Windows CI');
  assert.match(launcher || '', /\.cmd$/i);
  const options = { env, cwd: directory, encoding: 'utf8', timeout: 60000 };
  const version = JSON.parse(runAzureCli(['version', '--output', 'json'], options));
  assert.match(version['azure-cli'], /^\d+\.\d+\.\d+/);
  const expected = '%MOBILE_CLI_SENTINEL% & !MOBILE_CLI_SENTINEL! percent%24value';
  assert.equal(runAzureCli(['version', '--query', `'${expected}'`, '--output', 'tsv'], options).trim(), expected);
});
