const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, '..', 'clear-site-cache.js');

function runClearSiteCache(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('fails with missing --websiteUrl argument', () => {
  const result = runClearSiteCache(['--envUrl', 'https://org.crm.dynamics.com']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /Missing --websiteUrl/);
});

test('fails with missing --envUrl argument', () => {
  const result = runClearSiteCache(['--websiteUrl', 'https://mysite.powerappsportals.com']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /Missing --envUrl/);
});

test('fails with no arguments', () => {
  const result = runClearSiteCache([]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /Missing --websiteUrl/);
});

test('fails gracefully when cache clear cannot succeed', () => {
  // Depending on Azure CLI login state, this will either fail to get a token
  // or make a real request to a non-existent site and get an HTTP error.
  // Either way the script should exit 1 with success: false.
  const result = runClearSiteCache([
    '--websiteUrl', 'https://nonexistent-site.powerappsportals.com',
    '--envUrl', 'https://nonexistent-env.crm.dynamics.com',
  ]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.length > 0, 'error message should be non-empty');
});
