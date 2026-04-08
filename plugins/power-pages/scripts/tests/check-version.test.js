const test = require('node:test');
const assert = require('node:assert/strict');

const { compareSemver, formatUpdateMessage, readMarketplaceName } = require('../check-version');

test('compareSemver returns 0 for equal versions', () => {
  assert.equal(compareSemver('1.2.0', '1.2.0'), 0);
  assert.equal(compareSemver('0.0.1', '0.0.1'), 0);
  assert.equal(compareSemver('10.20.30', '10.20.30'), 0);
});

test('compareSemver returns 1 when remote is newer (major)', () => {
  assert.equal(compareSemver('1.2.0', '2.0.0'), 1);
  assert.equal(compareSemver('0.9.9', '1.0.0'), 1);
});

test('compareSemver returns 1 when remote is newer (minor)', () => {
  assert.equal(compareSemver('1.2.0', '1.3.0'), 1);
  assert.equal(compareSemver('1.0.0', '1.1.0'), 1);
});

test('compareSemver returns 1 when remote is newer (patch)', () => {
  assert.equal(compareSemver('1.2.0', '1.2.1'), 1);
  assert.equal(compareSemver('1.2.3', '1.2.4'), 1);
});

test('compareSemver returns -1 when local is newer', () => {
  assert.equal(compareSemver('2.0.0', '1.9.9'), -1);
  assert.equal(compareSemver('1.3.0', '1.2.0'), -1);
  assert.equal(compareSemver('1.2.1', '1.2.0'), -1);
});

test('compareSemver handles missing patch segment', () => {
  assert.equal(compareSemver('1.2', '1.2.0'), 0);
  assert.equal(compareSemver('1.2', '1.2.1'), 1);
});

test('formatUpdateMessage includes plugin name and both versions', () => {
  const msg = formatUpdateMessage('power-pages', '1.2.0', '1.3.0');
  assert.ok(msg.includes('power-pages'));
  assert.ok(msg.includes('1.2.0'));
  assert.ok(msg.includes('1.3.0'));
});

test('formatUpdateMessage includes marketplace update then plugin update when marketplace is provided', () => {
  const msg = formatUpdateMessage('power-pages', '1.2.0', '1.3.0', 'power-platform-skills');
  assert.ok(msg.includes('claude plugin marketplace update power-platform-skills'));
  assert.ok(msg.includes('claude plugin update power-pages@power-platform-skills'));
  const marketplaceIdx = msg.indexOf('marketplace update');
  const pluginIdx = msg.indexOf('plugin update power-pages@');
  assert.ok(marketplaceIdx < pluginIdx, 'marketplace update should come before plugin update');
  assert.ok(msg.startsWith('\n'), 'output should start with an empty line');
});

test('formatUpdateMessage uses plain name when marketplace is not provided', () => {
  const msg = formatUpdateMessage('power-pages', '1.2.0', '1.3.0');
  assert.ok(msg.includes('claude plugin update power-pages'));
  assert.ok(!msg.includes('@'));
  assert.ok(!msg.includes('marketplace update'));
  assert.ok(msg.startsWith('\n'), 'output should start with an empty line');
});

test('readMarketplaceName reads from the git root marketplace.json', () => {
  const { execSync } = require('child_process');
  const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  const name = readMarketplaceName(gitRoot);
  assert.equal(name, 'power-platform-skills');
});

test('readMarketplaceName returns null for nonexistent path', () => {
  assert.equal(readMarketplaceName('/nonexistent/path'), null);
});
