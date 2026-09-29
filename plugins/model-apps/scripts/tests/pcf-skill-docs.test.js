'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadMatrix, renderHostsTable } = require('../lib/pcf-matrix.js');

const ROOT = path.join(__dirname, '..', '..');
const PCF_REFERENCE_FILES = [
  'references/pcf-best-practices.md',
  'references/pcf-troubleshooting.md',
  'references/pcf-hosts.md',
  'references/pcf-power-pages.md',
  'references/pcf-testing.md',
];

function readPluginFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('all PCF reference docs exist', () => {
  for (const relativePath of PCF_REFERENCE_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} is missing`);
  }
});

test('pcf-hosts.md contains the rendered compatibility matrix block verbatim', () => {
  const text = readPluginFile('references/pcf-hosts.md');
  const expected = renderHostsTable(loadMatrix());

  assert.ok(text.includes(expected), 'pcf-hosts.md must include renderHostsTable(loadMatrix()) output verbatim');
  assert.match(
    text,
    /renderHostsTable\(loadMatrix\(\)\)[^\n]*\n<!-- pcf-matrix:begin -->/,
    'the matrix markers need a maintainer comment naming renderHostsTable(loadMatrix())',
  );
});

test('PCF reference docs do not link to GitHub issue trackers', () => {
  for (const relativePath of PCF_REFERENCE_FILES) {
    const text = readPluginFile(relativePath);
    assert.doesNotMatch(
      text,
      /https?:\/\/github\.com\/[^\s)]+\/(?:issues|discussions)\//i,
      `${relativePath} must not contain GitHub issue or discussion links`,
    );
  }
});

test('every troubleshooting entry uses the A30 diagnostic format', () => {
  const text = readPluginFile('references/pcf-troubleshooting.md');
  const entries = text.split(/^### /m).slice(1);
  assert.ok(entries.length > 10, 'expected multiple troubleshooting entries under ### headings');

  for (const entry of entries) {
    const title = entry.split(/\r?\n/, 1)[0];
    for (const label of ['Symptom', 'Candidate causes', 'Discriminating checks', 'Fix', 'Verify']) {
      assert.match(entry, new RegExp(`\\*\\*${label}\\*\\*:`), `${title} is missing ${label}`);
    }
    assert.doesNotMatch(entry, /\bAll causes\b/i, `${title} must not claim an exhaustive list of causes`);
  }
});

test('troubleshooting covers the required PCF failure modes', () => {
  const text = readPluginFile('references/pcf-troubleshooting.md');
  const requiredSubstrings = [
    "[pcf-1041] Not a valid sub-command 'production'",
    '[pcf-1014]',
    'Missing required tool',
    'Web resource content size is too big',
    'web-avoid-eval',
    'platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform',
    'ERESOLVE',
    'MSB4036',
    'Microsoft.PowerApps.MSBuild.Pcf',
    'Custom control declaration for form factor(s) 0,1 is missing',
    'Error loading control',
    'BigInt',
    'not implemented',
    'refresh will reset paging to page 1',
    'Power Pages does not support platform-library declarations',
    'Use a configured code component',
    'The CustomControl({…}) component cannot be deleted because it is referenced',
  ];

  for (const substring of requiredSubstrings) {
    assert.ok(text.includes(substring), `missing required troubleshooting coverage: ${substring}`);
  }
});

test('Microsoft Learn links in PCF references use the en-us canonical prefix', () => {
  for (const relativePath of PCF_REFERENCE_FILES) {
    const text = readPluginFile(relativePath);
    const links = text.match(/https:\/\/learn\.microsoft\.com[^\s)>"']*/g) || [];
    assert.ok(links.length > 0, `${relativePath} should cite Microsoft Learn`);
    for (const link of links) {
      assert.ok(
        link.startsWith('https://learn.microsoft.com/en-us/'),
        `${relativePath} has non-en-us Microsoft Learn link: ${link}`,
      );
    }
  }
});
