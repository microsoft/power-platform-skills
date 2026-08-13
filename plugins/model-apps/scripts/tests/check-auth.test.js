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

test('check-auth.js: a missing PAC login blocks only under --require-pac (genpage); otherwise it is a warning', () => {
  // Gap 4: the app-builder build/verify/teardown flow authenticates to Dataverse with the az token,
  // so a missing pac login must NOT block it. Genpage (which uploads pages via `pac model genpage`)
  // opts back into the hard block with --require-pac.
  assert.match(scriptSrc, /requirePac/, 'pac requirement is gated behind a --require-pac flag');
  assert.match(scriptSrc, /argv\.includes\('--require-pac'\)/);
  assert.match(scriptSrc, /warnings\.push\(/, 'a missing pac login is surfaced as a warning when not required');
});

const { parseEnvUrl } = require(scriptPath);

test('parseEnvUrl accepts --env <url> (the flag the build/verify/teardown scripts use)', () => {
  assert.equal(parseEnvUrl(['--env', 'https://org.crm.dynamics.com/']), 'https://org.crm.dynamics.com/');
});

test('parseEnvUrl accepts a positional url', () => {
  assert.equal(parseEnvUrl(['https://org.crm.dynamics.com/']), 'https://org.crm.dynamics.com/');
});

test('parseEnvUrl never mistakes the literal "--env" for the URL (the prior positional-only bug)', () => {
  // `check-auth.js --env <url>` used to set envUrl = "--env"; the flag must win and a bare flag
  // with no value must not leak the flag string as the URL.
  assert.equal(parseEnvUrl(['--env']), null);
  assert.notEqual(parseEnvUrl(['--env', 'https://org.crm.dynamics.com/']), '--env');
});

test('parseEnvUrl returns null when no url is given', () => {
  assert.equal(parseEnvUrl([]), null);
  assert.equal(parseEnvUrl(['--apply']), null);
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
