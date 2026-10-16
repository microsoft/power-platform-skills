'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hostAgent, invokesCli, rewrite } = require('../../hooks/set-cli-origin');

const pluginRoot = path.resolve(__dirname, '../..');
const hook = path.join(pluginRoot, 'hooks', 'set-cli-origin.js');
const claude = (command) => ({ tool_name: 'Bash', tool_input: { command, timeout: 1000 } });
const copilot = (command, toolName = 'powershell') => ({ toolName, toolArgs: { command, description: 'CLI' } });
const updated = (result) => result?.modifiedArgs || result?.hookSpecificOutput.updatedInput;

test('detects host only from host signals, never collects model information', () => {
  for (const env of [{ CLAUDECODE: '1' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }]) {
    assert.equal(hostAgent(env), 'claude-code');
  }
  for (const env of [{ COPILOT_CLI: '1' }, { COPILOT_AGENT_SESSION_ID: 'session' }]) {
    assert.equal(hostAgent(env), 'copilot-cli');
  }
  assert.equal(hostAgent({ MODEL: 'anything' }), 'unknown');
});

test('detects CLI executables, not arguments, comments or similarly named packages', () => {
  for (const command of [
    'npx --no-install pa app list', 'npx --no-install power-apps list-codeapps',
    'cd app && npx --no-install pa app list',
    'npx --no-install tsc; npx --no-install pa app list',
    'if true; then npx --no-install pa app list; fi',
    'command npx --no-install pa app list',
    'env PA_CLI_ORIGIN=custom npx --no-install pa app list',
    'PA="npx --no-install pa"; $PA app list',
    'PA="npx --no-install pa"; ${PA} app list',
    'pa app list', './node_modules/.bin/power-apps list-codeapps',
    'npx \\\n --no-install pa app list',
    'bash -c "npx --no-install pa app list"',
  ]) assert.equal(invokesCli(command, 'bash'), true, command);
  for (const command of [
    'echo "npx --no-install pa app list"', 'printf "%s" pa',
    '# npx --no-install pa app list\necho hi',
    'npx --no-install parallel', 'npx --no-install pa-other',
    'git diff -- pa', 'node -e "console.log(\'pa app list\')"',
    'PA="npx --no-install pa"; echo "$PA"',
    'pa() { echo hello; }; echo defined',
    'cat <<EOF\npa app list\nEOF',
  ]) assert.equal(invokesCli(command, 'bash'), false, command);
  assert.equal(invokesCli("& 'C:\\tools\\pa.cmd' app list", 'powershell'), true);
  assert.equal(invokesCli("Write-Output 'npx --no-install pa app list'", 'powershell'), false);
});

test('uses each host output contract, preserving non-command fields and approval policy', () => {
  const command = 'npx --no-install pa app list';
  const a = rewrite(claude(command), { CLAUDECODE: '1' });
  assert.equal(a.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(updated(a).timeout, 1000);
  assert.match(updated(a).command, /plugin\/claude-code/);
  assert.ok(updated(a).command.endsWith(command));
  const b = rewrite(copilot(command), { COPILOT_CLI: '1' });
  assert.equal(b.modifiedArgs.description, 'CLI');
  assert.match(updated(b).command, /\$env:PA_CLI_ORIGIN = 'plugin\/copilot-cli'/);
  assert.equal(b.permissionDecision, undefined);
  assert.equal(a.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(rewrite({ toolName: 'powershell', toolArgs: JSON.stringify(copilot(command).toolArgs) }, { COPILOT_CLI: '1' }), b);
  assert.match(updated(rewrite(claude(command), {})).command, /plugin\/unknown/);
});

test('does not confuse hook runtime, host identity and target shell', () => {
  assert.match(updated(rewrite(copilot('pa app list', 'bash'), { COPILOT_CLI: '1' })).command, /export PA_CLI_ORIGIN/);
  assert.equal(rewrite(claude('pa app list'), { COPILOT_CLI: '1' }), null);
  assert.equal(rewrite(copilot('pa app list', 'shell'), {}), null);
  assert.equal(rewrite({ tool_name: 'Write', tool_input: { command: 'pa app list' } }, {}), null);
});

test('preserves explicitly set parent values including empty values, and is idempotent', () => {
  for (const value of ['', 'custom-origin', ' plugin/custom ']) {
    assert.equal(rewrite(claude('pa app list'), { PA_CLI_ORIGIN: value }), null);
  }
  const input = claude('pa app list');
  input.tool_input = updated(rewrite(input, {}));
  assert.equal(rewrite(input, {}), null);
  for (const payload of [null, {}, { tool_name: 42 }, { tool_name: 'Bash', tool_input: {} }]) {
    assert.equal(rewrite(payload, {}), null);
  }
});

const available = (shell) => !spawnSync(shell, ['--version'], { stdio: 'ignore' }).error;

for (const shell of ['bash', 'pwsh']) {
  const installed = available(shell);
  test(`${shell}: rewritten command delivers origin to stub CLI and preserves behavior`, { skip: !installed && !process.env.CI }, () => {
    assert.ok(installed, `${shell} must be installed in CI`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-apps-origin-'));
    try {
      fs.writeFileSync(path.join(dir, 'stub.cjs'), 'console.log(JSON.stringify({origin:process.env.PA_CLI_ORIGIN,args:process.argv.slice(2)}));process.exit(Number(process.env.STUB_EXIT||0));');
      const isBash = shell === 'bash';
      const setup = isBash
        ? 'pa() { node stub.cjs "$@"; }; power-apps() { node stub.cjs "$@"; }; npx() { shift; "$@"; }; '
        : 'function pa { node stub.cjs @args }; function power-apps { node stub.cjs @args }; function npx { $binary=$args[1]; & $binary @($args | Select-Object -Skip 2) }; ';
      const env = { ...process.env, COPILOT_CLI: '1' };
      delete env.PA_CLI_ORIGIN;
      const run = (command, extra = {}) => {
        const result = rewrite(copilot(command, isBash ? 'bash' : 'powershell'), env);
        const script = updated(result)?.command || command;
        const args = isBash ? ['--noprofile', '--norc', '-c', script]
          : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
        return spawnSync(shell, args, { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
      };
      const check = (command, origin, extra) => {
        const result = run(command, extra);
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout.trim());
        assert.equal(output.origin, origin);
        assert.deepEqual(output.args, ['app', 'list', 'a b']);
      };
      const call = 'npx --no-install pa app list "a b"';
      for (const binary of ['pa', 'power-apps']) {
        check(setup + `npx --no-install ${binary} app list "a b"`, 'plugin/copilot-cli');
      }
      if (isBash) {
        check(setup + 'PA="npx --no-install pa"; $PA app list "a b"', 'plugin/copilot-cli');
        check(setup + 'PA="npx --no-install pa"; ${PA} app list "a b"', 'plugin/copilot-cli');
      }
      check(setup + call, 'parent/custom', { PA_CLI_ORIGIN: 'parent/custom' });
      check(setup + call, '', { PA_CLI_ORIGIN: '' });
      check(setup + (isBash ? 'PA_CLI_ORIGIN=inline/custom ' : "$env:PA_CLI_ORIGIN='inline/custom'; ") + call, 'inline/custom');
      check(setup + (isBash ? 'export PA_CLI_ORIGIN=script/custom; ' : "$env:PA_CLI_ORIGIN='script/custom'; ") + call, 'script/custom');
      const failure = run(setup + call + (isBash ? '' : '; exit $LASTEXITCODE'), { STUB_EXIT: '7' });
      assert.equal(failure.status, 7, failure.stderr);
      const unrelated = isBash ? 'printf "%s" "${PA_CLI_ORIGIN-unset}"' : "if (Test-Path Env:PA_CLI_ORIGIN) { $env:PA_CLI_ORIGIN } else { 'unset' }";
      assert.equal(run(unrelated).stdout.trim(), 'unset');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('hook process reads UTF-8 JSON, reports malformed input, and runs from bundled root', () => {
  const env = { ...process.env, CLAUDECODE: '1', PLUGIN_ROOT: pluginRoot };
  delete env.PA_CLI_ORIGIN;
  const payload = claude('npx --no-install pa app list --search "caf\u00e9"');
  const result = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(updated(JSON.parse(result.stdout)).command.endsWith(payload.tool_input.command));
  const bad = spawnSync(process.execPath, [hook], { input: '{', env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /CLI attribution was not applied/);
  assert.equal(bad.stdout, '');
  const claudeHook = require('../../hooks/hooks.json').hooks.PreToolUse[0];
  const nativeManifest = require('../../hooks.json');
  const copilotHook = nativeManifest.hooks.preToolUse[0];
  assert.equal(nativeManifest.version, 1);
  assert.match('Bash', new RegExp(`^(?:${claudeHook.matcher})$`));
  for (const tool of ['bash', 'powershell']) assert.match(tool, new RegExp(`^(?:${copilotHook.matcher})$`));
  for (const tool of ['Write', 'shell']) assert.doesNotMatch(tool, new RegExp(`^(?:${copilotHook.matcher})$`));
  for (const [launcher, data] of [
    [claudeHook.hooks[0].command, payload],
    [copilotHook.command, copilot('npx --no-install pa app list')],
  ]) {
    const launched = spawnSync(launcher, { shell: true, input: JSON.stringify(data), env, encoding: 'utf8' });
    assert.equal(launched.status, 0, launched.stderr);
    assert.ok(updated(JSON.parse(launched.stdout)).command.endsWith(data.tool_input?.command || data.toolArgs.command));
  }
});
