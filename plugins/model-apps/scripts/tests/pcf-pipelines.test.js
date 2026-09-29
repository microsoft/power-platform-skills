'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PIPELINES = path.join(ROOT, 'pcf', 'pipelines');

function read(name) {
  return fs.readFileSync(path.join(PIPELINES, name), 'utf8');
}

function assertOrdered(text, labels) {
  let at = -1;
  for (const label of labels) {
    const next = text.indexOf(label, at + 1);
    assert.ok(next > at, `${label} should appear after previous pipeline step`);
    at = next;
  }
}

function assertNoInlineSecrets(text) {
  assert.doesNotMatch(text, /(client[_-]?secret|password|tenant[_-]?id|app[_-]?id)\s*:\s*['"]?[A-Za-z0-9_.~+/=-]{8,}/i);
  assert.doesNotMatch(text, /https:\/\/org[0-9a-f]{8}\.crm/i);
}

test('GitHub Actions example has installer, build, test, pack, publish, and import steps in order', () => {
  const text = read('github-actions.yml');

  assert.match(text, /microsoft\/powerplatform-actions\/actions-install@/);
  assert.match(text, /microsoft\/powerplatform-actions\/import-solution@/);
  assertOrdered(text, ['Power Platform Tool Installer', 'Build PCF control', 'Test PCF control', 'Pack managed solution', 'Publish artifact', 'Import managed solution']);
  assertNoInlineSecrets(text);
});

test('Azure DevOps example has installer, build, test, pack, publish, and import tasks in order', () => {
  const text = read('azure-devops.yml');

  assert.match(text, /PowerPlatformToolInstaller@2/);
  assert.match(text, /PowerPlatformImportSolution@2/);
  assertOrdered(text, ['PowerPlatformToolInstaller', 'Build PCF control', 'Test PCF control', 'Pack managed solution', 'Publish pipeline artifact', 'Import managed solution']);
  assertNoInlineSecrets(text);
});

test('pipeline README documents service-connection customization without inline credentials', () => {
  const text = read('README.md');

  assert.match(text, /service connection/i);
  assert.match(text, /https:\/\/contoso\.crm\.dynamics\.com/);
  assertNoInlineSecrets(text);
});
