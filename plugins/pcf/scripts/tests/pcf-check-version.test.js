'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { formatUpdateMessage, readMarketplaceName } = require('../check-version.js');

test('readMarketplaceName does not read checkout-root marketplace metadata for pcf notices', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-check-version-root-'));
  try {
    fs.writeFileSync(path.join(root, 'marketplace.json'), JSON.stringify({ name: 'power-platform-skills' }));

    assert.equal(readMarketplaceName(root), null);
    assert.match(formatUpdateMessage('pcf', '1.0.0', '1.0.1', readMarketplaceName(root), 'copilot'), /copilot plugin update pcf/);
    assert.doesNotMatch(formatUpdateMessage('pcf', '1.0.0', '1.0.1', readMarketplaceName(root), 'copilot'), /marketplace update/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
