const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compareSemver,
  detectHost,
  formatUpdateMessage,
  readMarketplaceName,
} = require('../check-version');

test('compareSemver compares major, minor, and patch versions', () => {
  assert.equal(compareSemver('1.2.0', '1.2.0'), 0);
  assert.equal(compareSemver('1.2', '1.2.0'), 0);
  assert.equal(compareSemver('1.2.0', '2.0.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.3.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.2.1'), 1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), -1);
});

test('detectHost recognizes GitHub Copilot CLI', () => {
  assert.equal(detectHost({ COPILOT_CLI: '1' }), 'copilot');
  assert.equal(detectHost({}), 'claude');
});

test('formatUpdateMessage emits Copilot update commands', () => {
  const message = formatUpdateMessage(
    'model-apps',
    '2.4.3',
    '2.4.4',
    'power-platform-skills',
    'copilot'
  );

  assert.match(message, /model-apps 2\.4\.3 -> 2\.4\.4/);
  assert.match(message, /copilot plugin marketplace update power-platform-skills/);
  assert.match(message, /copilot plugin update model-apps@power-platform-skills/);
  assert.ok(message.indexOf('marketplace update') < message.indexOf('plugin update model-apps@'));
});

test('formatUpdateMessage emits Claude update commands', () => {
  const message = formatUpdateMessage(
    'model-apps',
    '2.4.3',
    '2.4.4',
    'power-platform-skills',
    'claude'
  );

  assert.match(message, /claude plugin marketplace update power-platform-skills/);
  assert.match(message, /claude plugin update model-apps@power-platform-skills/);
});

test('formatUpdateMessage uses the plain plugin name without a marketplace', () => {
  const message = formatUpdateMessage('model-apps', '2.4.3', '2.4.4', null, 'copilot');

  assert.match(message, /copilot plugin update model-apps/);
  assert.doesNotMatch(message, /marketplace update/);
  assert.doesNotMatch(message, /@/);
});

test('readMarketplaceName reads the repository marketplace', () => {
  const { execSync } = require('node:child_process');
  const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

  assert.equal(readMarketplaceName(gitRoot), 'power-platform-skills');
});

test('readMarketplaceName falls back to the legacy marketplace path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apps-version-'));
  fs.mkdirSync(path.join(tempDir, '.claude-plugin'));
  fs.writeFileSync(
    path.join(tempDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'legacy-marketplace' })
  );

  assert.equal(readMarketplaceName(tempDir), 'legacy-marketplace');
});

test('readMarketplaceName returns null when no marketplace exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apps-version-'));
  assert.equal(readMarketplaceName(tempDir), null);
});
