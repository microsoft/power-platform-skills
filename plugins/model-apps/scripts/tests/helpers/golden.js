'use strict';
// Shared golden-snapshot helper. Compare mode by default; regenerate with UPDATE_GOLDENS=1.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const GOLDEN_DIR = path.join(__dirname, '..', 'golden');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

function assertGolden(name, actual) {
  const file = path.join(GOLDEN_DIR, name);
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8');
  assert.strictEqual(actual, expected, `golden mismatch: ${name} — re-run with UPDATE_GOLDENS=1 if the change is intended`);
}

module.exports = { assertGolden, GOLDEN_DIR, UPDATE };
