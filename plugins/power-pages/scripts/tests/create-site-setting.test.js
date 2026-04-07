const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject } = require('./test-utils');

function runCreateSiteSetting(args) {
  const cliPath = path.join(__dirname, '..', 'create-site-setting.js');
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
  });
}

test('create-site-setting creates a value-backed site setting', (t) => {
  const projectRoot = createTempProject(t);
  const result = runCreateSiteSetting([
    '--projectRoot', projectRoot,
    '--name', 'Webapi/test/enabled',
    '--value', 'true',
    '--description', 'Enable test setting',
    '--type', 'boolean',
  ]);

  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  const yaml = fs.readFileSync(parsed.filePath, 'utf8');

  assert.match(parsed.filePath, /Webapi-test-enabled\.sitesetting\.yml$/);
  assert.match(yaml, /^description: Enable test setting$/m);
  assert.match(yaml, /^name: Webapi\/test\/enabled$/m);
  assert.match(yaml, /^value: true$/m);
});

test('create-site-setting creates an environment-variable-backed site setting', (t) => {
  const projectRoot = createTempProject(t);
  const result = runCreateSiteSetting([
    '--projectRoot', projectRoot,
    '--name', 'TestEnvABC',
    '--envVarSchema', 'ABC',
  ]);

  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  const yaml = fs.readFileSync(parsed.filePath, 'utf8');

  assert.match(yaml, /^envvar_schema: ABC$/m);
  assert.match(yaml, /^name: TestEnvABC$/m);
  assert.match(yaml, /^source: 1$/m);
  assert.doesNotMatch(yaml, /^value:/m);
  assert.doesNotMatch(yaml, /^description:/m);
});

test('create-site-setting rejects mixing environment-variable and value inputs', (t) => {
  const projectRoot = createTempProject(t);
  const result = runCreateSiteSetting([
    '--projectRoot', projectRoot,
    '--name', 'TestEnvABC',
    '--envVarSchema', 'ABC',
    '--value', 'ignored',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined with --value or --description/);
});
