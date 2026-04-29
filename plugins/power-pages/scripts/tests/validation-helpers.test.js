const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const helpersPath = path.join(__dirname, '..', 'lib', 'validation-helpers.js');
const childProcessId = require.resolve('child_process');

test('getAuthToken passes --allow-no-subscriptions to az', () => {
  const originalChildProcess = require.cache[childProcessId];
  let capturedCommand = null;

  require.cache[childProcessId] = {
    id: childProcessId,
    filename: childProcessId,
    loaded: true,
    exports: {
      execSync: (command, options) => {
        capturedCommand = command;
        const out = 'fake-token-value\n';
        return options && options.encoding ? out : Buffer.from(out);
      },
    },
  };
  delete require.cache[require.resolve(helpersPath)];

  try {
    const { getAuthToken } = require(helpersPath);
    const token = getAuthToken('https://example.crm.dynamics.com');

    assert.equal(token, 'fake-token-value');
    assert.match(capturedCommand, /^az account get-access-token /);
    assert.match(capturedCommand, /--allow-no-subscriptions/);
    assert.match(capturedCommand, /--resource "https:\/\/example\.crm\.dynamics\.com"/);
  } finally {
    if (originalChildProcess) require.cache[childProcessId] = originalChildProcess;
    else delete require.cache[childProcessId];
    delete require.cache[require.resolve(helpersPath)];
  }
});
