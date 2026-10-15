// Importing install.js must not start an install. Process and network boundaries are
// mocked below so malformed marketplace fixtures can never run a CLI or fetch real data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const {
  parseArgs, selectPlugins, OPT_IN_PLUGINS, isValidPluginName, parseMarketplaceManifest,
} = require('../install.js');

const MARKETPLACE = ['power-pages', 'model-apps', 'dataverse', 'power-automate'];
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8');
const RAW_ROOT = 'https://raw.githubusercontent.com/microsoft/power-platform-skills/main/';
const INJECTION_NAMES = [
  'power-pages$(echo REVIEW_ONLY)',
  'power-pages`echo REVIEW_ONLY`',
  'power-pages" & echo REVIEW_ONLY & rem "',
  'power-pages;echo REVIEW_ONLY',
  'power-pages|echo REVIEW_ONLY',
  '%COMSPEC%',
  '!PATH!',
  'power-pages\n',
  'power-pages\r\n',
  'power-pages\u0000',
];

function manifest(names = MARKETPLACE) {
  return { name: 'power-platform-skills', plugins: names.map((name) => ({ name })) };
}

function loadInstaller({
  platform = 'linux',
  env = platform === 'win32' ? { Path: 'C:\\tools', SystemRoot: 'C:\\Windows' } : { PATH: '/tools' },
  files = {},
  commands = [],
  remote = {},
  execute = () => Buffer.from('power-pages model-apps dataverse power-automate'),
  argv,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'C:\\project' : '/project';
  const file = paths.join(root, 'scripts', 'install.js');
  const calls = [];
  const requests = [];
  const messages = [];
  const writes = [];
  const module = { id: 'installer-test', exports: {} };
  const requireMock = (name) => {
    if (name === 'path') return paths;
    if (name === 'os') return { homedir: () => paths.join(root, 'home') };
    if (name === 'fs') return {
      constants: fs.constants,
      existsSync: (target) => Object.hasOwn(files, target),
      readFileSync: (target) => {
        if (Object.hasOwn(files, target)) return files[target];
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
      writeFileSync: (...args) => writes.push(args),
      statSync: (target) => {
        if (commands.includes(target)) return { isFile: () => true };
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
      accessSync: () => {},
    };
    if (name === 'child_process') return {
      execSync: () => assert.fail('The installer must not use execSync'),
      execFileSync: (file, args, options) => {
        assert.equal(options.shell, false);
        calls.push({ file, args: Array.from(args), options });
        return execute(file, args, options);
      },
    };
    if (name === 'https') return {
      get: (url, options, callback) => {
        requests.push(url);
        const res = new EventEmitter();
        res.statusCode = Object.hasOwn(remote, url) ? 200 : 404;
        callback(res);
        queueMicrotask(() => {
          res.emit('data', remote[url]);
          res.emit('end');
        });
        return new EventEmitter();
      },
    };
    throw new Error(`Unexpected require: ${name}`);
  };
  vm.runInNewContext(SOURCE, {
    require: requireMock, module,
    process: {
      platform, env, version: process.version, stdout: { isTTY: false },
      cwd: () => root,
      argv: argv || ['node', file],
      exit: (code) => assert.fail(`Unexpected exit ${code}`),
    },
    console: { log: (...args) => messages.push(args.join(' ')) },
  }, { filename: 'install.js' });
  return { installer: module.exports, calls, requests, messages, writes };
}

test('dataverse is opt-in through --include-dataverse', () => {
  assert.equal(OPT_IN_PLUGINS.dataverse, '--include-dataverse');
});

test('without flags, every plugin except dataverse is installed', () => {
  const { selected, skipped } = selectPlugins(MARKETPLACE, parseArgs([]).includedOptIn);
  assert.deepEqual(selected, ['power-pages', 'model-apps', 'power-automate']);
  assert.deepEqual(skipped, ['dataverse']);
});

test('--include-dataverse installs dataverse alongside the other plugins', () => {
  const { selected, skipped } = selectPlugins(MARKETPLACE, parseArgs(['--include-dataverse']).includedOptIn);
  assert.deepEqual(selected, MARKETPLACE);
  assert.deepEqual(skipped, []);
});

test('--help is recognised', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('an unknown or misspelled argument fails instead of silently skipping a plugin', () => {
  assert.throws(() => parseArgs(['--include-dataverze']), /Unknown argument '--include-dataverze'/);
  assert.throws(() => parseArgs(['dataverse']), /Unknown argument/);
});

test('plugin-name validation accepts the Open Plugins grammar, including its length boundaries', () => {
  for (const name of ['a', '0', 'plugin.v2', 'plugin-2', 'a'.repeat(64), ...MARKETPLACE]) {
    assert.equal(isValidPluginName(name), true, name);
  }
  for (const name of [
    '', 'a'.repeat(65), '-plugin', 'plugin-', '.plugin', 'plugin.', 'plugin--name',
    'plugin..name', 'Uppercase', 'plugin_name', 'plugin/name', 'plugin name', 'plügïn',
    ...INJECTION_NAMES, null, 42, {}, [], true,
  ]) {
    assert.equal(isValidPluginName(name), false, JSON.stringify(name));
  }
});

test('marketplace validation rejects every malformed entry, including opt-in and later entries', () => {
  for (const plugins of [undefined, null, {}, 'plugins']) {
    assert.throws(() => parseMarketplaceManifest(JSON.stringify({ name: 'power-platform-skills', plugins })),
      /plugins must be an array/);
  }
  for (const entry of [null, 'dataverse', [], {}, { name: 1 }, ...INJECTION_NAMES.map((name) => ({ name }))]) {
    assert.throws(() => parseMarketplaceManifest(JSON.stringify({
      name: 'power-platform-skills', plugins: [{ name: 'power-pages' }, entry],
    })), /plugins\[1\].name/);
  }
  for (const raw of ['null', '[]', '"marketplace"', '42']) {
    assert.throws(() => parseMarketplaceManifest(raw), /manifest must be an object/);
  }
  assert.throws(() => parseMarketplaceManifest('{"name":"different","plugins":[]}'), /expected 'power-platform-skills'/);
  assert.throws(() => parseMarketplaceManifest('{invalid'), SyntaxError);
  assert.deepEqual(parseMarketplaceManifest(JSON.stringify(manifest([]))), manifest([]));
});

test('local and remote plugin source formats and committed manifests remain supported', () => {
  for (const source of [
    './plugins/power-pages',
    { source: 'github', repo: 'contoso/plugins', path: 'plugins/widget' },
    { source: 'git-subdir', url: 'contoso/plugins', path: 'plugins/widget' },
  ]) {
    const value = { name: 'power-platform-skills', plugins: [{ name: 'widget', source }] };
    assert.deepEqual(parseMarketplaceManifest(JSON.stringify(value)), value);
  }
  for (const file of ['marketplace.json', path.join('.claude-plugin', 'marketplace.json')]) {
    const value = parseMarketplaceManifest(fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8'));
    assert.ok(value.plugins.some((plugin) => plugin.name === 'dataverse'));
  }
});

for (const platform of ['linux', 'win32']) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'C:\\project' : '/project';
  for (const relative of ['marketplace.json', paths.join('.plugin', 'marketplace.json'), paths.join('.claude-plugin', 'marketplace.json')]) {
    test(`${platform}: local ${relative} validates names before returning a marketplace`, async () => {
      const file = paths.join(root, relative);
      const valid = loadInstaller({ platform, files: { [file]: JSON.stringify(manifest()) } });
      assert.deepEqual(JSON.parse(JSON.stringify(await valid.installer.loadMarketplace())), manifest());
      assert.deepEqual(valid.requests, []);
      for (const name of INJECTION_NAMES) {
        const bad = loadInstaller({ platform, files: { [file]: JSON.stringify(manifest([name])) } });
        await assert.rejects(bad.installer.loadMarketplace(), /plugins\[0\].name/);
        assert.deepEqual(bad.calls, []);
        assert.ok(bad.messages.some((message) => message.includes('Ignoring invalid marketplace manifest')));
      }
    });
  }
}

for (const relative of ['marketplace.json', '.plugin/marketplace.json', '.claude-plugin/marketplace.json']) {
  test(`downloaded ${relative} validates names before returning a marketplace`, async () => {
    const url = RAW_ROOT + relative;
    const valid = loadInstaller({ remote: { [url]: JSON.stringify(manifest()) } });
    assert.deepEqual(JSON.parse(JSON.stringify(await valid.installer.loadMarketplace())), manifest());
    for (const name of INJECTION_NAMES) {
      const bad = loadInstaller({ remote: { [url]: JSON.stringify(manifest([name])) } });
      await assert.rejects(bad.installer.loadMarketplace(), /plugins\[0\].name/);
      assert.deepEqual(bad.calls, []);
    }
  });
}

test('invalid local manifests are reported and never returned instead of a valid fallback', async () => {
  const fixture = loadInstaller({
    files: { '/project/marketplace.json': JSON.stringify(manifest([INJECTION_NAMES[0]])) },
    remote: { [RAW_ROOT + 'marketplace.json']: JSON.stringify(manifest()) },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await fixture.installer.loadMarketplace())), manifest());
  assert.ok(fixture.messages.some((message) => message.includes('Ignoring invalid marketplace manifest')));
  assert.deepEqual(fixture.calls, []);
});

test('CLI resolution skips relative PATH entries and honors PATH and supported PATHEXT order', () => {
  const linux = loadInstaller({ env: { PATH: ':.:tools:/first:/second' }, commands: ['/second/copilot', '/first/copilot'] });
  assert.equal(linux.installer.resolveCommand('copilot'), '/first/copilot');
  const windows = loadInstaller({
    platform: 'win32',
    env: { Path: 'C:\\ignored', PATH: '.;tools;;"C:\\first";C:\\second', PATHEXT: '.JS;.CMD;.EXE' },
    commands: ['C:\\first\\copilot.js', 'C:\\first\\copilot.cmd', 'C:\\first\\copilot.exe', 'C:\\second\\copilot.exe'],
  });
  assert.equal(windows.installer.resolveCommand('copilot'), 'C:\\first\\copilot.cmd');
  assert.equal(windows.installer.resolveCommand('missing'), null);
  for (const name of ['copilot & echo REVIEW_ONLY', 'copilot\n', '../copilot', '', null]) {
    assert.throws(() => windows.installer.resolveCommand(name), /Invalid command name/);
  }
});

test('native CLI calls preserve argv and process options without shell interpretation', () => {
  for (const platform of ['linux', 'win32']) {
    const file = platform === 'win32' ? 'C:\\tools\\copilot.exe' : '/tools/copilot';
    const fixture = loadInstaller({ platform, commands: [file], execute: () => Buffer.from(' output \n') });
    const args = ['plugin', 'install', 'power-pages@power-platform-skills', ...INJECTION_NAMES];
    const result = fixture.installer.run('copilot', args, { cwd: 'working-directory' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'output');
    assert.equal(fixture.calls[0].file, file);
    assert.deepEqual(fixture.calls[0].args, args);
    assert.equal(fixture.calls[0].options.cwd, 'working-directory');
    assert.equal(fixture.calls[0].options.timeout, 120_000);
    assert.equal(fixture.calls[0].options.windowsVerbatimArguments, undefined);
  }
});

test('process failures, stderr and missing commands retain actionable error output', () => {
  const failure = loadInstaller({
    commands: ['/tools/copilot'],
    execute: () => { throw Object.assign(new Error('launch failed'), { stderr: Buffer.from('CLI error\n') }); },
  });
  assert.equal(failure.installer.run('copilot', ['--version']).output, 'CLI error');
  assert.equal(failure.installer.run('copilot', ['--version']).ok, false);
  assert.match(failure.installer.run('missing', []).output, /not found on PATH/);
});

test('Windows batch launchers use an absolute cmd.exe and only checked inert arguments', () => {
  for (const extension of ['cmd', 'bat']) {
    const file = `C:\\Program Files\\CLI\\copilot.${extension}`;
    const fixture = loadInstaller({
      platform: 'win32', commands: [file],
      env: { Path: 'C:\\Program Files\\CLI', ComSpec: 'cmd.exe', SystemRoot: 'C:\\Windows' },
    });
    assert.equal(fixture.installer.run('copilot', ['plugin', 'install', 'widget.v2@power-platform-skills']).ok, true);
    const call = fixture.calls[0];
    assert.equal(call.file, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(call.args, ['/d', '/s', '/v:off', '/c',
      `""${file}" plugin install widget.v2@power-platform-skills"`]);
    assert.equal(call.options.windowsVerbatimArguments, true);
    assert.equal(call.options.env.NoDefaultCurrentDirectoryInExePath, '1');
    for (const arg of [...INJECTION_NAMES, 'a&b', 'a^b', '(echo)', 'a>b', 'a<b', 'two words', '', 'x\t', 42]) {
      assert.equal(fixture.installer.run('copilot', [arg]).ok, false, JSON.stringify(arg));
    }
    assert.equal(fixture.calls.length, 1, 'unsafe arguments fail before spawning');
  }
});

test('Windows batch launchers reject paths containing expansion, quotes or control characters', () => {
  for (const dir of ['C:\\100%\\bin', 'C:\\wow!\\bin', 'C:\\a"\\bin', 'C:\\line\nbreak\\bin']) {
    const fixture = loadInstaller({
      platform: 'win32', env: { Path: dir }, commands: [path.win32.join(dir, 'copilot.cmd')],
    });
    assert.equal(fixture.installer.run('copilot', ['--version']).ok, false, JSON.stringify(dir));
    assert.deepEqual(fixture.calls, []);
  }
});

test('both plugin installers pass the original CLI flags and identifiers as separate arguments', () => {
  const fixture = loadInstaller({ commands: ['/tools/claude', '/tools/copilot'] });
  fixture.installer.installClaude(MARKETPLACE);
  fixture.installer.installCopilot(MARKETPLACE);
  assert.deepEqual(fixture.calls.filter((call) => call.args[1] === 'install').map(({ file, args }) => ({ file, args })), [
    ...MARKETPLACE.map((name) => ({ file: '/tools/claude', args: ['plugin', 'install', `${name}@power-platform-skills`, '--scope', 'user'] })),
    ...MARKETPLACE.map((name) => ({ file: '/tools/copilot', args: ['plugin', 'install', `${name}@power-platform-skills`] })),
  ]);
  assert.deepEqual(fixture.calls.filter((call) => call.args[1] === 'marketplace').map((call) => call.args), [
    ['plugin', 'marketplace', 'add', 'microsoft/power-platform-skills'],
    ['plugin', 'marketplace', 'update', 'power-platform-skills'],
    ['plugin', 'marketplace', 'add', 'microsoft/power-platform-skills'],
  ]);
});

test('main preserves default and opt-in selection for clone, downloaded and piped launch modes', async () => {
  for (const platform of ['linux', 'win32']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const root = platform === 'win32' ? 'C:\\project' : '/project';
    const cliDir = platform === 'win32' ? 'C:\\tools' : '/tools';
    const extension = platform === 'win32' ? '.cmd' : '';
    for (const script of [paths.join(root, 'scripts', 'install.js'), paths.join(root, 'install.js'), '-', undefined]) {
      for (const includeDataverse of [false, true]) {
        if (script === undefined && includeDataverse) continue;
        const argv = script === undefined ? ['node'] : ['node', script];
        if (includeDataverse) argv.push('--include-dataverse');
        const fixture = loadInstaller({
          platform, argv,
          files: { [paths.join(root, 'marketplace.json')]: JSON.stringify(manifest()) },
          commands: ['claude', 'copilot', 'pac', 'az'].map((cli) => paths.join(cliDir, cli + extension)),
        });
        await fixture.installer.main();
        const calls = fixture.calls.filter((call) => platform === 'win32'
          ? call.args[4].includes(' plugin install ') : call.args[1] === 'install');
        const expected = includeDataverse ? MARKETPLACE : MARKETPLACE.filter((name) => name !== 'dataverse');
        assert.equal(calls.length, expected.length * 2);
        for (const name of expected) {
          assert.equal(calls.filter((call) => call.args.join(' ').includes(`${name}@power-platform-skills`)).length, 2);
        }
        assert.deepEqual(fixture.requests, [], 'local installs do not need another repository file or network request');
        if (!includeDataverse) assert.ok(fixture.messages.some((line) => line.includes('Skipping dataverse')));
      }
    }
  }
});

test('main never installs a plugin from an invalid local or downloaded marketplace', async () => {
  for (const local of [true, false]) {
    for (const name of INJECTION_NAMES) {
      const raw = JSON.stringify(manifest(['power-pages', name]));
      const fixture = loadInstaller({
        commands: ['/tools/claude', '/tools/copilot', '/tools/pac', '/tools/az'],
        files: local ? { '/project/marketplace.json': raw } : {},
        remote: local ? {} : { [RAW_ROOT + 'marketplace.json']: raw },
      });
      await assert.rejects(fixture.installer.main(), /plugins\[1\].name/);
      assert.equal(fixture.calls.some((call) => call.args[0] === 'plugin'), false);
      assert.deepEqual(fixture.writes, []);
    }
  }
});

test('prerequisite install and update commands retain their separate arguments', async () => {
  const cases = [
    { platform: 'linux', commands: ['copilot', 'dotnet', 'az'], expected: ['tool', 'install', '--global', 'Microsoft.PowerApps.CLI.Tool'] },
    { platform: 'linux', commands: ['copilot', 'dotnet', 'pac', 'az'], expected: ['tool', 'update', '--global', 'Microsoft.PowerApps.CLI.Tool'] },
    { platform: 'darwin', commands: ['copilot', 'pac', 'brew'], expected: ['install', 'azure-cli'] },
    { platform: 'win32', commands: ['copilot', 'pac', 'winget'], expected: ['install', '-e', '--id', 'Microsoft.AzureCLI',
      '--accept-source-agreements', '--accept-package-agreements'] },
  ];
  for (const scenario of cases) {
    const win = scenario.platform === 'win32';
    const paths = win ? path.win32 : path.posix;
    const root = win ? 'C:\\project' : '/project';
    const fixture = loadInstaller({
      platform: scenario.platform,
      commands: scenario.commands.map((cli) => paths.join(win ? 'C:\\tools' : '/tools', cli + (win ? '.exe' : ''))),
      files: { [paths.join(root, 'marketplace.json')]: JSON.stringify(manifest()) },
      remote: { 'https://api.nuget.org/v3-flatcontainer/microsoft.powerapps.cli.tool/index.json': '{"versions":["2.0.0"]}' },
    });
    await fixture.installer.main();
    assert.ok(fixture.calls.some((call) => JSON.stringify(call.args) === JSON.stringify(scenario.expected)));
  }
});

test('the single-file installer works when piped into Node, with or without an explicit stdin argument', () => {
  for (const args of [['-', '--help'], []]) {
    const input = args.length ? SOURCE : SOURCE.replace(/^(#![^\n]*\n)/,
      "$1process.argv.push('-', '--help');\n");
    const output = execFileSync(process.execPath, args, { input, encoding: 'utf8', timeout: 30_000, shell: false });
    assert.match(output, /Usage: node install.js/);
    assert.doesNotMatch(output, /Checking prerequisites/);
  }
});

test('a real native executable receives metacharacters as data, not shell syntax', () => {
  const fixture = loadInstaller({
    platform: process.platform,
    env: { ...process.env, PATH: path.dirname(process.execPath), Path: path.dirname(process.execPath) },
    commands: [process.execPath], execute: execFileSync,
  });
  const values = ['$(echo REVIEW_ONLY)', 'x" & echo REVIEW_ONLY & rem "', '%PATH%', '!PATH!'];
  const result = fixture.installer.run('node', ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...values]);
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(JSON.parse(result.output), values);
});

test('real Windows batch launchers forward plugin argv unchanged from a path containing spaces and &', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer shim & path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const script = path.join(dir, 'argv.js');
  const shim = path.join(dir, 'copilot.cmd');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const fixture = loadInstaller({
    platform: 'win32', env: { ...process.env, PATH: dir, Path: dir },
    commands: [shim], execute: execFileSync,
  });
  const args = ['plugin', 'install', 'widget.v2@power-platform-skills', '--scope', 'user'];
  const result = fixture.installer.run('copilot', args);
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(JSON.parse(result.output), args);
});
