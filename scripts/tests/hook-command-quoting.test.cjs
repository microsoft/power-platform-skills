const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PLUGINS = [
  {
    name: 'code-apps',
    manifests: [
      { file: 'plugins/code-apps/hooks.json', files: [] },
      { file: 'plugins/code-apps/hooks/hooks.json', files: [] },
      { file: 'plugins/code-apps/com.github.copilot/hooks/hooks.json', files: [] },
    ],
  },
  {
    name: 'mobile-apps',
    manifests: [
      { file: 'plugins/mobile-apps/hooks/hooks.json', files: ['run-telemetry.js', 'run-telemetry.js'] },
    ],
    telemetryFiles: ['run-telemetry.js'],
  },
  {
    name: 'model-apps',
    manifests: [
      {
        file: 'plugins/model-apps/hooks/hooks.json',
        files: [
          'validate-write-safety.js',
          'run-skill-pretool-telemetry.js',
          'run-skill-posttool-validation.js',
          'validate-icon-imports.js',
          'run-user-prompt-telemetry.js',
        ],
      },
    ],
    telemetryFiles: ['run-skill-pretool-telemetry.js', 'run-user-prompt-telemetry.js'],
  },
  {
    name: 'pcf',
    manifests: [
      {
        file: 'plugins/pcf/hooks/hooks.json',
        files: ['validate-write-safety.js', 'run-skill-pretool-telemetry.js', 'run-user-prompt-telemetry.js'],
      },
    ],
    telemetryFiles: ['run-skill-pretool-telemetry.js', 'run-user-prompt-telemetry.js'],
  },
  {
    name: 'power-automate',
    manifests: [
      {
        file: 'plugins/power-automate/hooks/hooks.json',
        files: ['run-skill-pretool-telemetry.js', 'run-user-prompt-telemetry.js'],
      },
    ],
    telemetryFiles: ['run-skill-pretool-telemetry.js', 'run-user-prompt-telemetry.js'],
  },
  {
    name: 'power-apps-mobile-extension',
    manifests: [
      {
        file: 'plugins/power-apps-mobile-extension/hooks/hooks.json',
        files: ['run-telemetry.js', 'run-telemetry.js'],
      },
    ],
    telemetryFiles: ['run-telemetry.js'],
  },
];

const TELEMETRY_OPTOUTS = [
  'POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT',
  'POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT',
  'POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT',
  'POWER_PLATFORM_SKILLS_TELEMETRY_POWER_AUTOMATE_OPTOUT',
  'POWER_PLATFORM_SKILLS_TELEMETRY_POWER_APPS_MOBILE_EXTENSION_OPTOUT',
];
const INPUT = '{"tool_input":{"skill":"example"}}';

function collectCommands(value, commands = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectCommands(item, commands);
  } else if (value && typeof value === 'object') {
    if (typeof value.command === 'string') {
      commands.push(value.command);
    } else {
      for (const child of Object.values(value)) collectCommands(child, commands);
    }
  }
  return commands;
}

function getHookFile(command) {
  const pathArgument = command.match(/hooks\/([^/'"]+\.js)/)
    || command.match(/'hooks'\s*,\s*'([^']+\.js)'/);
  assert.ok(pathArgument, `hook command does not identify a hooks/*.js entry point: ${command}`);
  return pathArgument[1];
}

const HOOKS = PLUGINS.flatMap(plugin => plugin.manifests.flatMap(manifest => {
  const commands = collectCommands(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, manifest.file), 'utf8')));
  assert.equal(commands.length, manifest.files.length, `${manifest.file}: registered hook count changed`);
  return commands.map((command, index) => ({
    plugin: plugin.name,
    command,
    file: getHookFile(command),
    expectedFile: manifest.files[index],
    telemetry: (plugin.telemetryFiles || []).includes(manifest.files[index]),
    bestEffort: (plugin.bestEffortFiles || []).includes(manifest.files[index]),
  }));
}));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin hooks '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "plugin's files & scripts");
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  for (const file of new Set(HOOKS.map(hook => hook.expectedFile))) {
    fs.writeFileSync(path.join(root, 'hooks', file), `
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ file: path.basename(__filename), input, cwd: process.cwd() }));
  if (process.env.HOOK_TEST_STATUS) process.exitCode = Number(process.env.HOOK_TEST_STATUS);
});
module.exports = { start() {} };
`);
  }
  return { directory, root };
}

function environment(root, rootVariable, status = '') {
  const env = {
    ...process.env,
    PLUGIN_ROOT: '',
    CLAUDE_PLUGIN_ROOT: '',
    HOOK_TEST_STATUS: status,
  };
  for (const variable of TELEMETRY_OPTOUTS) env[variable] = '1';
  env[rootVariable] = root;
  if (rootVariable === 'PLUGIN_ROOT') env.CLAUDE_PLUGIN_ROOT = path.join(root, 'wrong root');
  return env;
}

const runners = process.platform === 'win32' ? [] : [{
  name: 'POSIX shell',
  binary: '/bin/sh',
  args: command => ['-c', command],
  failureStatus: code => code,
}];
const shells = process.platform === 'win32'
  ? ['powershell.exe', 'pwsh.exe']
  : (process.env.HOOK_TEST_POWERSHELL ? [process.env.HOOK_TEST_POWERSHELL] : []);
for (const shell of shells) {
  for (const nested of [false, true]) {
    runners.push({
      name: `${path.basename(shell)} (${nested ? 'nested' : 'direct'})`,
      binary: shell,
      args(command) {
        // The extra -Command "..." layer reproduces the quoting loss reported in #788.
        const script = nested
          ? `& '${shell.replaceAll("'", "''")}' -NoLogo -NoProfile -Command "${command}"; exit (Get-Variable LASTEXITCODE -ValueOnly)`
          : command;
        return ['-NoLogo', '-NoProfile', '-Command', script];
      },
      failureStatus: () => 1,
    });
  }
}

test('all affected manifests register the expected hooks without nested double quotes', () => {
  assert.ok(HOOKS.length > 0);
  for (const hook of HOOKS) {
    assert.equal(hook.file, hook.expectedFile, `${hook.plugin}: hook entry point changed`);
    assert.ok(!hook.command.includes('"'), `${hook.plugin}: nested double quotes regress #788`);
  }
});

for (const runner of runners) {
  function launch(hook, options) {
    return spawnSync(runner.binary, runner.args(hook.command), {
      ...options,
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  test(`${runner.name}: hook commands preserve stdin, cwd, paths and plugin-root fallback`, t => {
    const { directory, root } = fixture(t);
    for (const [index, hook] of HOOKS.entries()) {
      const rootVariable = index % 2 === 0 ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
      const result = launch(hook, {
        cwd: directory,
        env: environment(root, rootVariable),
        input: INPUT,
      });
      assert.equal(result.status, 0, `${hook.plugin}/${hook.file}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.file, hook.expectedFile);
      assert.equal(output.input, INPUT);
      assert.equal(fs.realpathSync.native(output.cwd), fs.realpathSync.native(directory));
    }
  });

  test(`${runner.name}: telemetry failures fail open and validator failures propagate`, t => {
    const { directory, root } = fixture(t);
    for (const hook of HOOKS) {
      const result = launch(hook, {
        cwd: directory,
        env: environment(root, 'PLUGIN_ROOT', '1'),
        input: '{}',
      });
      assert.equal(JSON.parse(result.stdout).file, hook.expectedFile);
      const expectedStatus = hook.telemetry ? 0 : runner.failureStatus(1);
      assert.equal(result.status, expectedStatus, `${hook.plugin}/${hook.file}`);
    }
  });

  test(`${runner.name}: missing modules do not block telemetry or best-effort hooks`, t => {
    const { directory, root } = fixture(t);
    for (const hook of HOOKS) {
      const result = launch(hook, {
        cwd: directory,
        env: environment(path.join(root, 'missing'), 'PLUGIN_ROOT'),
        input: '{}',
      });
      const expectedStatus = hook.telemetry || hook.bestEffort ? 0 : runner.failureStatus(1);
      assert.equal(result.status, expectedStatus, `${hook.plugin}/${hook.file}: ${result.stderr}`);
    }
  });
}
