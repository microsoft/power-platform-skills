#!/usr/bin/env node
/**
 * Tests for configure-env-variables/scripts/validate-env-variables.js
 *
 * The previous signature `runValidation('configure-env-variables', () => {...})`
 * silently passed because `runValidation(callback)` only takes one argument —
 * the string was treated as the callback, threw when invoked, and the catch
 * silent-approved. These tests pin the corrected signature and the actual
 * validation behaviour.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATOR = path.join(
  __dirname,
  '../../skills/configure-env-variables/scripts/validate-env-variables.js'
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-env-variables-'));
}

function writeSettings(dir, data) {
  fs.writeFileSync(
    path.join(dir, 'deployment-settings.json'),
    typeof data === 'string' ? data : JSON.stringify(data),
    'utf8'
  );
}

function runValidator(cwd) {
  const result = spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('validate-env-variables: exits 0 when no deployment-settings.json found', () => {
  const dir = makeTempDir();
  const result = runValidator(dir);
  assert.equal(result.code, 0);
});

test('validate-env-variables: exits 0 for valid settings with at least one env var', () => {
  const dir = makeTempDir();
  writeSettings(dir, {
    stages: {
      Staging: {
        EnvironmentVariables: [
          { SchemaName: 'pp_LocalLoginEnabled', Value: 'false' },
        ],
      },
      Production: { EnvironmentVariables: [] },
    },
  });
  const result = runValidator(dir);
  assert.equal(result.code, 0, result.stderr);
});

test('validate-env-variables: blocks on invalid JSON', () => {
  const dir = makeTempDir();
  writeSettings(dir, '{ this is not valid json');
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not valid JSON/);
});

test('validate-env-variables: blocks when stages object missing', () => {
  const dir = makeTempDir();
  writeSettings(dir, { other: 'shape' });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing "stages"/);
});

test('validate-env-variables: blocks when stages object empty', () => {
  const dir = makeTempDir();
  writeSettings(dir, { stages: {} });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no stages defined/);
});

test('validate-env-variables: blocks when a stage is missing EnvironmentVariables array', () => {
  const dir = makeTempDir();
  writeSettings(dir, {
    stages: {
      Staging: {
        // no EnvironmentVariables key
      },
    },
  });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing "EnvironmentVariables"/);
});

test('validate-env-variables: blocks when no stage has any env vars', () => {
  const dir = makeTempDir();
  writeSettings(dir, {
    stages: {
      Staging: { EnvironmentVariables: [] },
      Production: { EnvironmentVariables: [] },
    },
  });
  const result = runValidator(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no EnvironmentVariables configured/);
});

test('validate-env-variables: walks up to find deployment-settings.json in ancestor dir', () => {
  const dir = makeTempDir();
  writeSettings(dir, {
    stages: {
      Staging: {
        EnvironmentVariables: [{ SchemaName: 'pp_X', Value: 'a' }],
      },
    },
  });
  const subdir = path.join(dir, 'sub', 'deeper');
  fs.mkdirSync(subdir, { recursive: true });
  const result = runValidator(subdir);
  assert.equal(result.code, 0, result.stderr);
});
