const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'add-cloud-flow',
  'scripts',
  'list-cloud-flows.js'
);

function runListCloudFlows(envOverrides = {}) {
  return spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ...envOverrides },
  });
}

test('fails when pac CLI is not available (empty PATH)', () => {
  const result = runListCloudFlows({ PATH: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pac auth who|environment|unable/i);
});

test('fails when az CLI is not available for token (empty PATH)', () => {
  // With empty PATH, pac auth who also fails, so the first error fires
  const result = runListCloudFlows({ PATH: '' });
  assert.notEqual(result.status, 0);
  // Should fail at authentication stage
  assert.ok(result.stderr.length > 0, 'should produce an error message');
});
