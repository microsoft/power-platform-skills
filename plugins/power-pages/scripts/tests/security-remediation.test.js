'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '../..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('escapeNestedHtml encodes entity initiators before innerHTML parsing', () => {
  const { escapeNestedHtml } = require('../lib/render-template');
  assert.equal(
    escapeNestedHtml('&lt;img src=x onerror=globalThis.PWNED=1&gt;'),
    '&amp;lt;img src=x onerror=globalThis.PWNED=1&amp;gt;',
  );
});

test('validate-export treats a discovered ZIP filename as data, not shell syntax', {
  skip: process.platform === 'win32' ? 'The original shell-injection reproduction uses POSIX filenames.' : false,
}, () => {
  const sourceDir = tmpDir('validate-export-injection-');
  const marker = path.join(sourceDir, 'PWNED');
  const maliciousName = 'export";touch PWNED;echo "_managed.zip';
  fs.writeFileSync(path.join(sourceDir, maliciousName), Buffer.alloc(2048));

  const cli = path.join(
    PLUGIN_ROOT,
    'skills',
    'export-solution',
    'scripts',
    'validate-export.js',
  );
  const result = spawnSync(process.execPath, [cli], {
    cwd: sourceDir,
    input: JSON.stringify({ cwd: sourceDir }),
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.notEqual(result.status, null);
  assert.equal(fs.existsSync(marker), false, result.stderr);
});

test('validate-export accepts normal unzip listings with a root solution.xml', {
  skip: process.platform === 'win32' ? 'Uses a POSIX executable fixture.' : false,
}, () => {
  const sourceDir = tmpDir('validate-export-listing-');
  const binDir = path.join(sourceDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(sourceDir, 'valid_managed.zip'), Buffer.alloc(2048));
  const fakeUnzip = path.join(binDir, 'unzip');
  fs.writeFileSync(
    fakeUnzip,
    [
      '#!/bin/sh',
      "printf '%s\\n' 'Archive: valid_managed.zip'",
      "printf '%s\\n' '     1473  05-26-2026 11:31   solution.xml'",
      '',
    ].join('\n'),
    { mode: 0o700 },
  );

  const cli = path.join(
    PLUGIN_ROOT,
    'skills',
    'export-solution',
    'scripts',
    'validate-export.js',
  );
  const result = spawnSync(process.execPath, [cli], {
    cwd: sourceDir,
    input: JSON.stringify({ cwd: sourceDir }),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
});

test('MCP configuration fails closed when plugin-root variables are missing', () => {
  const maliciousCwd = tmpDir('mcp-cwd-injection-');
  const scriptsDir = path.join(maliciousCwd, 'scripts');
  const marker = path.join(maliciousCwd, 'PWNED');
  fs.mkdirSync(scriptsDir);
  fs.writeFileSync(
    path.join(scriptsDir, 'launch-playwright-mcp.js'),
    `module.exports = { launch() { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pwned'); } };\n`,
  );

  const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.mcp.json'), 'utf8'));
  const playwright = config.mcpServers.playwright;
  const env = { ...process.env };
  delete env.PLUGIN_ROOT;
  delete env.CLAUDE_PLUGIN_ROOT;

  const result = spawnSync(playwright.command, playwright.args, {
    cwd: maliciousCwd,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.match(result.stderr, /PLUGIN_ROOT|plugin root/i);
});

test('README does not recommend wildcard shell permissions or disabled permission checks', () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /Bash\([^)]*\*\)/);
  assert.doesNotMatch(readme, /--dangerously-skip-permissions/);
  assert.match(readme, /case-by-case|exact command|narrow/i);
});

test('setup-auth keeps generic OIDC guided-only and email linking fail-closed', () => {
  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'setup-auth', 'SKILL.md'), 'utf8');
  const reference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills', 'setup-auth', 'references', 'idp-provisioning-reference.md'),
    'utf8',
  );
  const combined = `${skill}\n${reference}`;

  assert.match(combined, /provider documentation.*untrusted reference data/is);
  assert.match(combined, /Generic OIDC.*Guided-only/is);
  assert.match(combined, /before every mutating command|immediately before each mutation/is);
  assert.match(combined, /Create a new contact \(Recommended\)/);
  assert.match(combined, /verified-email evidence|email_verified.*true/is);
  assert.match(combined, /default.*AllowContactMappingWithEmail.*false/is);
  assert.doesNotMatch(combined, /Link to the existing contact \(Recommended\)/);
});

test('rendered data-model and permissions plans encode hostile nested HTML as text', () => {
  const cases = [
    {
      renderer: 'render-data-model-plan.js',
      data: {
        SITE_NAME: 'Site </title><script>globalThis.PWNED=1</script>',
        SUMMARY: '<img src=x onerror="globalThis.PWNED=1">',
        PREFIX: 'new',
        TABLES_DATA: [{
          status: 'new',
          displayName: '<img src=x onerror="globalThis.PWNED=1">',
          logicalName: 'new_table',
          columns: [],
          relationships: [],
          rationale: '<svg onload="globalThis.PWNED=1">',
        }],
        RATIONALE_DATA: [{
          icon: '<img src=x onerror="globalThis.PWNED=1">',
          title: 'Unsafe',
          desc: '<script>globalThis.PWNED=1</script>',
        }],
        ER_DIAGRAM: 'erDiagram',
      },
    },
    {
      renderer: 'render-permissions-plan.js',
      data: {
        SITE_NAME: 'Site </title><script>globalThis.PWNED=1</script>',
        SUMMARY: '<img src=x onerror="globalThis.PWNED=1">',
        ROLES_DATA: [{
          id: 'role',
          name: '<img src=x onerror="globalThis.PWNED=1">',
          desc: '<script>globalThis.PWNED=1</script>',
          color: '#0078d4',
          builtin: false,
          isNew: true,
        }],
        PERMISSIONS_DATA: [{
          id: 'perm',
          name: '<img src=x onerror="globalThis.PWNED=1">',
          displayName: 'Permission',
          table: 'account',
          scope: 'Global',
          roles: ['role'],
          rationale: { scope: '<svg onload="globalThis.PWNED=1">' },
          isNew: true,
        }],
        RATIONALE_DATA: [{
          icon: '<img src=x onerror="globalThis.PWNED=1">',
          title: 'Unsafe',
          desc: '<script>globalThis.PWNED=1</script>',
        }],
      },
    },
  ];

  for (const item of cases) {
    const workDir = tmpDir('render-xss-');
    const dataPath = path.join(workDir, 'data.json');
    const outputPath = path.join(workDir, 'report.html');
    fs.writeFileSync(dataPath, JSON.stringify(item.data));

    const result = spawnSync(
      process.execPath,
      [path.join(PLUGIN_ROOT, 'scripts', item.renderer), '--data', dataPath, '--output', outputPath],
      { encoding: 'utf8', timeout: 10_000 },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = fs.readFileSync(outputPath, 'utf8');
    assert.doesNotMatch(report, /<img src=x onerror="globalThis\.PWNED=1">/);
    assert.doesNotMatch(report, /<svg onload="globalThis\.PWNED=1">/);
    assert.doesNotMatch(report, /<script>globalThis\.PWNED=1<\/script>/);
    assert.match(report, /&lt;(?:img|svg|script)/);
  }
});

test('telemetry builders keep documented identity fields and drop unknown fields', () => {
  const { buildSkillStarted } = require('../lib/telemetry/lib/events');
  const event = buildSkillStarted('PagesAIPluginEvent', {
    pluginName: 'power-pages',
    pluginVersion: '1.0.0',
    skillName: 'create-site',
    orgId: 'org-id',
    tenantId: 'tenant-id',
    eventInfo: { aadObjectId: 'user-id' },
    unknownIdentity: 'must-not-pass',
  });

  assert.equal(event.data.orgId, 'org-id');
  assert.equal(event.data.tenantId, 'tenant-id');
  assert.deepEqual(event.data.eventInfo, { aadObjectId: 'user-id' });
  assert.equal(event.data.unknownIdentity, undefined);
});
