'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'create-solution.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('create-solution.js posts to /solutions', () => {
  assert.match(scriptSrc, /'POST', 'solutions'/);
});

test('create-solution.js binds publisher via @odata.bind', () => {
  assert.match(scriptSrc, /'publisherid@odata.bind':/);
});

test('create-solution.js looks up env default publisher when --publisher omitted', () => {
  assert.match(scriptSrc, /findPublisher\(envUrl, flags\.publisher\)/);
  // Authoritative lookup: organizations._defaultpublisherid_value -> publisher record
  assert.match(scriptSrc, /_defaultpublisherid_value/);
  assert.match(scriptSrc, /publishers\(\$\{defaultPublisherId\}\)/);
});

test('create-solution.js: missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('create-solution.js: rejects unique names with hyphens or spaces', () => {
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://example.crm.dynamics.com', 'has-hyphen', 'Friendly'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /alphanumeric/);
});

test('create-solution.js: rejects unique names starting with digit', () => {
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://example.crm.dynamics.com', '1Solution', 'Friendly'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /alphanumeric/);
});
