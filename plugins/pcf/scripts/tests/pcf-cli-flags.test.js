'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { booleanFlagError } = require('../lib/pcf-cli-flags.js');
const { parseArgs } = require('../lib/dataverse-auth.js');

const scriptsDir = path.join(__dirname, '..');

// Every case below fails with a usage error before any project, SDK or network work starts, so
// spawning the real entry point is cheap and pins the whole contract a caller sees: exit code,
// empty stdout and the stderr message.
function runCli(script, argv) {
  return spawnSync(process.execPath, [path.join(scriptsDir, script), ...argv], {
    encoding: 'utf8',
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: '1' },
  });
}

// `--name=value`, `--name=` and `--name <value>` all reach the parsed flags as a string, and each
// must stay a usage error rather than reading as true or false.
function refusedForms(name) {
  return [[`--${name}=false`], [`--${name}=true`], [`--${name}=`], [`--${name}`, 'yes']];
}

const COMMANDS = [
  {
    script: 'pcf-inventory.js',
    prefix: ['--env', 'https://contoso.crm.dynamics.com'],
    booleans: ['include-managed', 'where-used'],
  },
  {
    script: 'pcf-upgrade.js',
    prefix: ['--project', path.join(scriptsDir, 'does-not-exist')],
    booleans: ['apply', 'allow-dirty', 'no-install'],
  },
  {
    script: 'pcf-ci-build.js',
    prefix: [],
    booleans: ['all', 'templates', 'latest', 'keep', 'package'],
  },
];

for (const { script, prefix, booleans } of COMMANDS) {
  test(`${script} refuses a value on each boolean flag with a usage error`, () => {
    for (const name of booleans) {
      for (const form of refusedForms(name)) {
        const result = runCli(script, [...prefix, ...form]);
        const label = `${script} ${form.join(' ')}`;
        assert.equal(result.status, 1, label);
        assert.equal(result.stdout, '', label);
        assert.match(result.stderr, /Usage:/, label);
        assert.match(result.stderr, new RegExp(`--${name} does not take a value`), label);
      }
    }
  });

  test(`${script} reports the first refused boolean flag in its declared order, not argv order`, () => {
    const reversed = [...booleans].reverse().map((name) => `--${name}=1`);
    const result = runCli(script, [...prefix, ...reversed]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`--${booleans[0]} does not take a value`));
    for (const name of booleans.slice(1)) assert.doesNotMatch(result.stderr, new RegExp(`--${name} does not take a value`));
  });
}

test('pcf-inventory checks --env before boolean flag values', () => {
  const result = runCli('pcf-inventory.js', ['--where-used=false']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--env is required/);
  assert.doesNotMatch(result.stderr, /does not take a value/);
});

test('pcf-upgrade accepts bare boolean flags and checks them before --hosts', () => {
  const bare = runCli('pcf-upgrade.js', ['--apply', '--allow-dirty', '--no-install', '--hosts', 'console']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--hosts contains unknown value 'console'/);
  assert.doesNotMatch(bare.stderr, /does not take a value/);

  const valued = runCli('pcf-upgrade.js', ['--apply=1', '--hosts', 'console']);
  assert.match(valued.stderr, /--apply does not take a value/);
});

test('pcf-ci-build accepts bare boolean flags and checks them before the selector count', () => {
  const bare = runCli('pcf-ci-build.js', ['--latest', '--keep', '--all', '--templates']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /Choose exactly one of/);
  assert.doesNotMatch(bare.stderr, /does not take a value/);

  const valued = runCli('pcf-ci-build.js', ['--latest=1', '--all', '--templates']);
  assert.match(valued.stderr, /--latest does not take a value/);
});

test('booleanFlagError accepts absent and bare flags and names the first valued flag', () => {
  assert.equal(booleanFlagError(parseArgs([]).flags, ['a', 'b']), null);
  assert.equal(booleanFlagError(parseArgs(['--a', '--b']).flags, ['a', 'b']), null);
  assert.equal(booleanFlagError(parseArgs(['--b=x', '--a=']).flags, ['a', 'b']), '--a does not take a value');
  assert.equal(booleanFlagError(parseArgs(['--b', 'x']).flags, ['a', 'b']), '--b does not take a value');
});
