const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const childProcess = require('child_process');

const helpersPath = path.join(__dirname, '..', 'lib', 'validation-helpers.js');

test('getAuthToken passes --allow-no-subscriptions to az', (t) => {
  const originalExecSync = childProcess.execSync;
  let capturedCommand = null;

  childProcess.execSync = (command, options) => {
    capturedCommand = command;
    const out = 'fake-token-value\n';
    return options && options.encoding ? out : Buffer.from(out);
  };
  delete require.cache[require.resolve(helpersPath)];

  t.after(() => {
    childProcess.execSync = originalExecSync;
    delete require.cache[require.resolve(helpersPath)];
  });

  const { getAuthToken } = require(helpersPath);
  const token = getAuthToken('https://example.crm.dynamics.com');

  assert.equal(token, 'fake-token-value');
  assert.match(capturedCommand, /^az account get-access-token /);
  assert.match(capturedCommand, /--allow-no-subscriptions/);
  assert.match(capturedCommand, /--resource "https:\/\/example\.crm\.dynamics\.com"/);
});
