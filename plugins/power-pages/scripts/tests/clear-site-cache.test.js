const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject, writeProjectFile } = require('./test-utils');

const scriptPath = path.join(__dirname, '..', 'clear-site-cache.js');

function runClearSiteCache(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('fails when powerpages.config.json is not found', (t) => {
  const projectRoot = createTempProject(t);
  const result = runClearSiteCache(['--projectRoot', projectRoot]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /powerpages\.config\.json not found/);
});

test('fails when siteName is missing from config', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({}));
  const result = runClearSiteCache(['--projectRoot', projectRoot]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /siteName not found/);
});

test('fails when powerpages.config.json is invalid JSON', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', 'not json');
  const result = runClearSiteCache(['--projectRoot', projectRoot]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /Failed to parse/);
});

test('fails gracefully when PAC CLI is not authenticated', (t) => {
  // This test depends on the PAC CLI auth state.
  // If PAC is authenticated, it will proceed further and fail at the API call.
  // If not authenticated, it will fail at the PAC auth check.
  // Either way, the script should exit 1 with success: false.
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({ siteName: 'nonexistent-test-site' }));
  const result = runClearSiteCache(['--projectRoot', projectRoot]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.length > 0, 'error message should be non-empty');
});
