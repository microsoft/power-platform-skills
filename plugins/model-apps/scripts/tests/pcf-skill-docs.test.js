'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadMatrix, renderHostsTable, renderPlatformLibrariesTable } = require('../lib/pcf-matrix.js');

const ROOT = path.join(__dirname, '..', '..');
const PCF_REFERENCE_FILES = [
  'references/pcf-best-practices.md',
  'references/pcf-troubleshooting.md',
  'references/pcf-hosts.md',
  'references/pcf-power-pages.md',
  'references/pcf-testing.md',
];
const ALLOWED_PLATFORM_ERROR_MESSAGES = [
  // Observed in probe P11 on 2026-09-29 when the stock React template declared the excluded Fluent version.
  'platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform.',
];

function readPluginFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function parseTroubleshootingEntries(text) {
  return text
    .split(/^### /m)
    .slice(1)
    .map((entry) => {
      const [title] = entry.split(/\r?\n/, 1);
      return { title: title.trim(), body: entry };
    });
}

function assertA30Entry(entry) {
  for (const label of ['Symptom', 'Candidate causes', 'Discriminating checks', 'Fix', 'Verify']) {
    assert.match(entry.body, new RegExp(`\\*\\*${label}\\*\\*:`), `${entry.title} is missing ${label}`);
  }
  assert.doesNotMatch(entry.body, /\bAll causes\b/i, `${entry.title} must not claim an exhaustive list of causes`);
}

function versionSelectorsFromMatrix(matrix) {
  const versionPattern = /\b\d+(?:\.(?:\d+|x+)){1,3}(?:-[0-9A-Za-z.-]+)?\b/g;
  const versions = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(versionPattern)) versions.add(match[0]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };

  visit(matrix);
  return Array.from(versions).filter(Boolean).sort((a, b) => b.length - a.length);
}

function stripRenderedBlocks(text) {
  return text
    .replace(/<!-- pcf-matrix:begin -->[\s\S]*?<!-- pcf-matrix:end -->\n?/g, '')
    .replace(/<!-- pcf-platform-libraries:begin -->[\s\S]*?<!-- pcf-platform-libraries:end -->\n?/g, '');
}

function matrixOwnedVersionLeaks(text, versions) {
  const body = stripRenderedBlocks(text);
  const leaks = [];
  for (const version of versions) {
    const pattern = new RegExp(`(^|[^\\d.])${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\d.]|\\.(?!\\d|x))`, 'g');
    for (const match of body.matchAll(pattern)) {
      const lineStart = body.lastIndexOf('\n', match.index) + 1;
      const lineEnd = body.indexOf('\n', match.index);
      const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd);
      const versionStartInLine = match.index + match[1].length - lineStart;
      const versionEndInLine = versionStartInLine + version.length;
      const isAllowlistedPlatformError = /^\*\*Symptom\*\*:/.test(line)
        && ALLOWED_PLATFORM_ERROR_MESSAGES.some((message) => {
          const messageStart = line.indexOf(message);
          return messageStart !== -1 && versionStartInLine >= messageStart && versionEndInLine <= messageStart + message.length;
        });
      if (isAllowlistedPlatformError) continue;
      leaks.push({ version, line: line.trim() });
    }
  }
  return leaks;
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

test('pcf-hosts.md contains the rendered platform-library block verbatim', () => {
  const text = readPluginFile('references/pcf-hosts.md');
  const expected = renderPlatformLibrariesTable(loadMatrix());

  assert.ok(text.includes(expected), 'pcf-hosts.md must include renderPlatformLibrariesTable(loadMatrix()) output verbatim');
  assert.match(
    text,
    /renderPlatformLibrariesTable\(loadMatrix\(\)\)[^\n]*\n<!-- pcf-platform-libraries:begin -->/,
    'the platform-library markers need a maintainer comment naming renderPlatformLibrariesTable(loadMatrix())',
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
  const entries = parseTroubleshootingEntries(text);
  assert.ok(entries.length > 10, 'expected multiple troubleshooting entries under ### headings');

  for (const entry of entries) {
    assertA30Entry(entry);
  }
});

test('troubleshooting covers the required PCF failure modes', () => {
  const text = readPluginFile('references/pcf-troubleshooting.md');
  const entries = parseTroubleshootingEntries(text);
  const requiredEntries = [
    { title: '[pcf-1041]', body: "Not a valid sub-command 'production'" },
    { title: '[pcf-1014]', body: '[pcf-1014]' },
    { title: 'Missing required tool', body: 'Missing required tool' },
    { title: 'Web resource content size is too big', body: 'Web resource content size is too big' },
    { title: 'Solution checker web-avoid-eval rule', body: 'web-avoid-eval' },
    { title: 'Fluent platform library rejection', body: 'platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform' },
    { title: 'npm ERESOLVE', body: 'ERESOLVE' },
    { title: 'MSB4036', body: 'MSB4036' },
    { title: 'NuGet restore fails', body: 'Microsoft.PowerApps.MSBuild.Pcf' },
    { title: 'Custom control declaration for form factor', body: 'Custom control declaration for form factor(s) 0,1 is missing' },
    { title: 'Error loading control', body: 'Error loading control' },
    { title: 'Error loading control', body: 'BigInt' },
    { title: 'Harness Web API not implemented', body: 'not implemented' },
    { title: 'Dataset refresh loop or page reset', body: 'refresh will reset paging to page 1' },
    { title: 'Pages virtual control does not render', body: 'Power Pages does not support platform-library declarations' },
    { title: 'Pages list falls back to the default grid', body: 'Use a configured code component' },
    { title: 'Bound control cannot be deleted', body: 'The CustomControl({…}) component cannot be deleted because it is referenced' },
  ];

  for (const required of requiredEntries) {
    const matches = entries.filter((entry) => entry.title.includes(required.title) && entry.body.includes(required.body));
    assert.equal(matches.length, 1, `expected one troubleshooting entry for ${required.title} / ${required.body}`);
    assertA30Entry(matches[0]);
  }
});

test('allowed platform error messages appear verbatim in troubleshooting', () => {
  const text = readPluginFile('references/pcf-troubleshooting.md');
  for (const message of ALLOWED_PLATFORM_ERROR_MESSAGES) {
    assert.ok(text.includes(message), `missing allowlisted platform error message: ${message}`);
  }
});

test('matrix-owned versions are detected when planted outside rendered blocks', () => {
  const [version] = versionSelectorsFromMatrix(loadMatrix());
  const leaks = matrixOwnedVersionLeaks(`This paragraph hard-codes ${version} outside the matrix.\n`, [version]);

  assert.deepEqual(leaks, [{ version, line: `This paragraph hard-codes ${version} outside the matrix.` }]);
});

test('matrix-owned Pages requirement versions are detected when planted outside rendered blocks', () => {
  const versions = versionSelectorsFromMatrix(loadMatrix());
  const leaks = matrixOwnedVersionLeaks('This paragraph hard-codes 9.3.3.x outside the matrix.\n', versions);

  assert.deepEqual(leaks, [{ version: '9.3.3.x', line: 'This paragraph hard-codes 9.3.3.x outside the matrix.' }]);
});

test('platform-library symptom exemptions do not hide extra matrix-owned versions', () => {
  const versions = versionSelectorsFromMatrix(loadMatrix());
  const text = '**Symptom**: Import fails with `platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform.` Extra 9.3.3.x.\n';
  const leaks = matrixOwnedVersionLeaks(text, versions);

  assert.deepEqual(leaks, [{ version: '9.3.3.x', line: text.trim() }]);
});

test('PCF reference prose does not hand-copy matrix-owned versions outside rendered blocks', () => {
  const versions = versionSelectorsFromMatrix(loadMatrix());
  const leaks = [];
  for (const relativePath of PCF_REFERENCE_FILES) {
    for (const leak of matrixOwnedVersionLeaks(readPluginFile(relativePath), versions)) {
      leaks.push(`${relativePath}: ${leak.version}: ${leak.line}`);
    }
  }

  assert.deepEqual(leaks, []);
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
