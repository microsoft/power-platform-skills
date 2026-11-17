'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '../..');

test('plugin discovery registers no hooks that can intercept unrelated tools', () => {
  for (const file of ['hooks.json', 'hooks/hooks.json', 'com.github.copilot/hooks/hooks.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, file), 'utf8'));
    assert.deepEqual(config.hooks, {}, file);
  }
  assert.equal(fs.existsSync(path.join(pluginRoot, 'hooks', 'set-cli-origin.js')), false);
});

const bashInstalled = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
test('CLI attribution affects only its child process and preserves explicit origin and exit status',
  { skip: !bashInstalled && !process.env.CI }, () => {
    assert.ok(bashInstalled, 'Bash must be installed in CI');
    const prefix = 'env -u PA_PLUGIN_REPORT_AGENT PA_CLI_ORIGIN="${PA_CLI_ORIGIN-plugin}"';
    const instructions = fs.readFileSync(path.join(pluginRoot, 'shared', 'cli-binary.md'), 'utf8');
    assert.ok(instructions.includes(`${prefix} $PA app list`));
    const stub = `${prefix} '${process.execPath.replaceAll('\\', '/')}' -e 'console.log(JSON.stringify({origin:process.env.PA_CLI_ORIGIN,report:process.env.PA_PLUGIN_REPORT_AGENT,args:process.argv.slice(1)}));process.exit(Number(process.env.STUB_EXIT||0))'`;
    const run = (script, env) => spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
      env, encoding: 'utf8', timeout: 15000,
    });
    const baseline = { ...process.env };
    delete baseline.PA_CLI_ORIGIN;
    delete baseline.PA_PLUGIN_REPORT_AGENT;
    delete baseline.STUB_EXIT;
    for (const origin of [undefined, '', 'user/custom']) {
      for (const report of [undefined, 'inherited-agent']) {
        const env = { ...baseline };
        if (origin !== undefined) env.PA_CLI_ORIGIN = origin;
        if (report !== undefined) env.PA_PLUGIN_REPORT_AGENT = report;
        const result = run(`${stub} app list "a b"; printf '\\nparent:%s:%s' "\${PA_CLI_ORIGIN-unset}" "\${PA_PLUGIN_REPORT_AGENT-unset}"`, env);
        assert.equal(result.status, 0, result.stderr);
        const [output, , parent] = result.stdout.trimEnd().split(/\r?\n/);
        assert.deepEqual(JSON.parse(output), { origin: origin ?? 'plugin', args: ['app', 'list', 'a b'] });
        assert.equal(parent, `parent:${origin ?? 'unset'}:${report ?? 'unset'}`);
        const failure = run(stub, { ...env, STUB_EXIT: '7' });
        assert.equal(failure.status, 7, failure.stderr);
        const capture = run(`result="$(${stub} app list)"; printf '%s' "$result"`, env);
        assert.equal(capture.status, 0, capture.stderr);
        assert.deepEqual(JSON.parse(capture.stdout), { origin: origin ?? 'plugin', args: ['app', 'list'] });
      }
    }
  });
