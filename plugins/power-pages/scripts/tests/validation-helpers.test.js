const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const childProcess = require('child_process');

const helpersPath = path.join(__dirname, '..', 'lib', 'validation-helpers.js');

test('getAuthToken calls az account get-access-token without --allow-no-subscriptions (only az login accepts that flag)', (t) => {
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
  assert.doesNotMatch(
    capturedCommand,
    /--allow-no-subscriptions/,
    'az account get-access-token rejects --allow-no-subscriptions on recent CLI versions; the helper must omit it.',
  );
  assert.match(capturedCommand, /--resource "https:\/\/example\.crm\.dynamics\.com"/);
});

// --- findProjectRoot: EDM / data-model site awareness ------------------------

test('findProjectRoot: recognizes a .powerpages-site/ directory as a project root (data-model/EDM sites)', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  // EDM/data-model site: .powerpages-site/ present, NO powerpages.config.json.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-edm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.powerpages-site'), { recursive: true });
  fs.writeFileSync(path.join(root, '.powerpages-site', 'website.yml'), 'id: x\nname: y\n');

  assert.equal(findProjectRoot(root), path.resolve(root));
});

test('findProjectRoot: still recognizes powerpages.config.json (code sites)', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'powerpages.config.json'), '{}');

  assert.equal(findProjectRoot(root), path.resolve(root));
});

test('findProjectRoot: returns null when neither marker is present', (t) => {
  const fs = require('fs');
  const os = require('os');
  const { findProjectRoot } = require(helpersPath);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-none-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(findProjectRoot(root), null);
});

