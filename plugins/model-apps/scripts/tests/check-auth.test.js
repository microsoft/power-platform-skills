'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const scriptPath = path.join(__dirname, '..', 'check-auth.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('check-auth.js enumerates all blocker codes', () => {
  for (const code of [
    'az_missing',
    'az_not_logged_in',
    'pac_not_logged_in',
    'no_env_url',
    'whoami_403',
    'whoami_401',
    'whoami_error',
  ]) {
    assert.match(scriptSrc, new RegExp(`['"]${code}['"]`), `missing blocker code: ${code}`);
  }
});

test('check-auth.js exits 0 even on failure (output drives gating)', () => {
  // The emit() helper always exits 0.
  assert.match(scriptSrc, /process\.exit\(0\)/);
  assert.doesNotMatch(scriptSrc, /process\.exit\(1\)/);
});

test('check-auth.js calls az account show and pac org who', () => {
  assert.match(scriptSrc, /'account', 'show'/);
  assert.match(scriptSrc, /'org', 'who'/);
});

test('check-auth.js runs WhoAmI through dataverseRequest', () => {
  assert.match(scriptSrc, /dataverseRequest\([^,]+,\s*'GET',\s*'WhoAmI'/);
});

test('check-auth.js compares identities case-insensitively', () => {
  assert.match(scriptSrc, /normalizeUser/);
  assert.match(scriptSrc, /toLowerCase/);
});

test('check-auth.js: 403 hint mentions az login --username when identities differ', () => {
  assert.match(scriptSrc, /az login --username \$\{pacUser\}/);
});
