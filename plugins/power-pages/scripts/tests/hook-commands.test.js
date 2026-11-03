const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const MANIFEST = require('../../hooks/hooks.json');
const FILES = {
  PreToolUse: 'run-skill-pretool-telemetry.js',
  PostToolUse: 'run-skill-posttool-validation.js',
  UserPromptSubmit: 'run-user-prompt-telemetry.js',
};
const HOOKS = Object.entries(MANIFEST.hooks).flatMap(([event, groups]) =>
  groups.flatMap(group => group.hooks.map(hook => ({
    ...hook, file: FILES[event], telemetry: event !== 'PostToolUse',
  })))
);
const INPUT = '{"tool_input":{"skill":"example"}}';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'power-pages hooks '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "plugin's files & scripts");
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  for (const filename of Object.values(FILES)) {
    // Replace only the installed hook body, not the manifest command. This isolates
    // shell forwarding from PAC/network activity while proving which file ran.
    fs.writeFileSync(path.join(root, 'hooks', filename), `
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ file: path.basename(__filename), input, cwd: process.cwd() }));
  if (process.env.HOOK_TEST_STATUS) {
    console.error('hook failure');
    process.exit(Number(process.env.HOOK_TEST_STATUS));
  }
});
`);
  }
  return { directory, root };
}

function environment(root, variable = 'PLUGIN_ROOT') {
  return {
    ...process.env,
    PLUGIN_ROOT: '',
    CLAUDE_PLUGIN_ROOT: '',
    HOOK_TEST_STATUS: '',
    POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1',
    [variable]: root,
  };
}

test('Power Pages hooks use only portable command fields and preserve registration', () => {
  assert.deepEqual(Object.keys(MANIFEST.hooks), Object.keys(FILES));
  assert.equal(HOOKS.length, 3);
  for (const [event, groups] of Object.entries(MANIFEST.hooks)) {
    assert.equal(groups.length, 1);
    if (event !== 'UserPromptSubmit') assert.equal(groups[0].matcher, 'Skill|skill');
    for (const hook of groups[0].hooks) {
      assert.deepEqual(Object.keys(hook).sort(), ['command', 'timeout', 'type']);
      assert.equal(hook.type, 'command');
      assert.equal(hook.timeout, 30);
      assert.ok(!hook.command.includes('"'), 'nested double quotes regress #788');
    }
  }
});

const shells = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : [];
if (process.platform !== 'win32' && process.env.HOOK_TEST_POWERSHELL) {
  shells.push(process.env.HOOK_TEST_POWERSHELL);
}
const runners = process.platform === 'win32' ? [] : [{
  name: 'POSIX shell',
  binary: '/bin/sh',
  args: command => ['-c', command],
  failureStatus: code => code,
}];
for (const shell of shells) {
  for (const nested of [false, true]) {
    runners.push({
      name: `${path.basename(shell)} (${nested ? 'nested' : 'direct'})`,
      binary: shell,
      args(command) {
        // Model an extra -Command "..." layer that reproduces #788's parser
        // error. Embedded " in node -e "JavaScript" exposes JS to PowerShell.
        const script = nested
          ? `& '${shell.replaceAll("'", "''")}' -NoLogo -NoProfile -Command "${command}"; exit (Get-Variable LASTEXITCODE -ValueOnly)`
          : command;
        return ['-NoLogo', '-NoProfile', '-Command', script];
      },
      // PowerShell -Command maps native nonzero exits to 1; POSIX preserves them.
      failureStatus: () => 1,
    });
  }
}

for (const runner of runners) {
  function launch(hook, options) {
    return spawnSync(runner.binary, runner.args(hook.command), {
      ...options, encoding: 'utf8', timeout: 15000,
    });
  }

  test(`${runner.name}: commands preserve stdin, cwd, path quoting and root selection`, t => {
    const { directory, root } = fixture(t);
    for (const hook of HOOKS) {
      for (const variable of ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
        const env = environment(root, variable);
        if (variable === 'PLUGIN_ROOT') env.CLAUDE_PLUGIN_ROOT = path.join(directory, 'wrong root');
        const result = launch(hook, { cwd: directory, env, input: INPUT });
        assert.equal(result.status, 0, `${hook.file}: ${result.stderr}`);
        assert.equal(result.stderr, '');
        const output = JSON.parse(result.stdout);
        assert.equal(output.file, hook.file);
        assert.equal(output.input, INPUT);
        assert.equal(fs.realpathSync(output.cwd), fs.realpathSync(directory));
      }
    }
  });

  test(`${runner.name}: telemetry failures do not block and validator failures propagate`, t => {
    const { directory, root } = fixture(t);
    for (const hook of HOOKS) {
      for (const code of [1, 2]) {
        const result = launch(hook, {
          cwd: directory, env: { ...environment(root), HOOK_TEST_STATUS: String(code) }, input: '{}',
        });
        assert.equal(JSON.parse(result.stdout).file, hook.file);
        assert.match(result.stderr, /hook failure/);
        assert.equal(result.status, hook.telemetry ? 0 : runner.failureStatus(code), hook.file);
      }
    }
  });

  test(`${runner.name}: missing modules remain diagnostic and only telemetry fails open`, t => {
    const { directory, root } = fixture(t);
    for (const hook of HOOKS) {
      const result = launch(hook, {
        cwd: directory, env: environment(path.join(root, 'missing')), input: '{}',
      });
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Cannot find module/);
      assert.equal(result.status, hook.telemetry ? 0 : 1, hook.file);
    }
  });

  test(`${runner.name}: missing plugin roots retain the existing diagnostic and no-op`, t => {
    const { directory } = fixture(t);
    for (const hook of HOOKS) {
      const result = launch(hook, { cwd: directory, env: environment(''), input: '{}' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /PLUGIN_ROOT is not set/);
    }
  });

  test(`${runner.name}: installed hook scripts accept unrelated input without side effects`, t => {
    const { directory } = fixture(t);
    for (const hook of HOOKS) {
      const result = launch(hook, {
        cwd: directory, env: environment(PLUGIN_ROOT),
        input: JSON.stringify({ tool_name: 'Read', tool_input: {}, prompt: 'No skill invocation' }),
      });
      assert.equal(result.status, 0, `${hook.file}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    assert.deepEqual(fs.readdirSync(directory), ["plugin's files & scripts"]);
  });
}
