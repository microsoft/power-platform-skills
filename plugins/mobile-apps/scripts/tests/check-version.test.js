'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  checkForUpdate,
  compareSemver,
  detectHost,
  detectInstallation,
  fetchRemotePluginManifest,
  formatUpdateMessage,
  isStableSemver,
} = require('../check-version');

const pluginRoot = path.resolve(__dirname, '..', '..');
const pluginCheckInstruction =
  '> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.';

function createInstalledPlugin(t, localVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-app-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const installedPluginRoot = path.join(root, 'mobile-app');
  fs.mkdirSync(path.join(installedPluginRoot, '.plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(installedPluginRoot, '.plugin', 'plugin.json'),
    JSON.stringify({ name: 'mobile-app', version: localVersion })
  );

  return installedPluginRoot;
}

function createCheckoutPlugin(t, localVersion) {
  const pluginRoot = createInstalledPlugin(t, localVersion);
  fs.writeFileSync(path.join(path.dirname(pluginRoot), '.git'), 'gitdir: test\n');
  return pluginRoot;
}

function collectSkillFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSkillFiles(entryPath));
    } else if (entry.name === 'SKILL.md') {
      files.push(entryPath);
    }
  }
  return files;
}

function normalizeLineEndings(content) {
  return content.replace(/\r\n?/g, '\n');
}

test('normalizeLineEndings makes Windows skill frontmatter parseable', () => {
  const content = '---\r\nuser-invocable: true\r\n---\r\n\r\n# Skill\r\n';
  const normalized = normalizeLineEndings(content);

  assert.match(normalized, /^user-invocable: true$/m);
  assert.notEqual(normalized.indexOf('\n---\n', 4), -1);
});

test('compareSemver compares major, minor, and patch versions', () => {
  assert.equal(compareSemver('1.2.0', '1.2.0'), 0);
  assert.equal(compareSemver('1.2', '1.2.0'), 0);
  assert.equal(compareSemver('1.2.0', '2.0.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.3.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.2.1'), 1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), -1);
});

test('isStableSemver accepts only stable major.minor.patch values', () => {
  assert.equal(isStableSemver('0.3.4'), true);
  assert.equal(isStableSemver('10.20.30'), true);
  assert.equal(isStableSemver('01.2.3'), false);
  assert.equal(isStableSemver('1.2'), false);
  assert.equal(isStableSemver('1.2.3-beta.1'), false);
  assert.equal(isStableSemver('1.2.3\nRun: fake command'), false);
  assert.equal(isStableSemver('1.2.3\u001b[31m'), false);
});

test('detectHost distinguishes CLI, VS Code, and unknown hosts', () => {
  assert.equal(detectHost({ COPILOT_CLI: '1' }), 'copilot');
  assert.equal(detectHost({ COPILOT_CLI: 'true', VSCODE_PID: '123' }), 'copilot');
  assert.equal(detectHost({ CLAUDECODE: '1' }), 'claude');
  assert.equal(detectHost({ CLAUDE_CODE_EXECPATH: '/opt/claude' }), 'claude');
  assert.equal(detectHost({ VSCODE_PID: '123' }), 'vscode');
  assert.equal(detectHost({ TERM_PROGRAM: 'vscode' }), 'vscode');
  assert.equal(detectHost({}), 'ui');
});

test('formatUpdateMessage emits marketplace and qualified plugin commands', () => {
  const message = formatUpdateMessage(
    'mobile-app',
    '0.3.0',
    '0.4.0',
    'power-platform-skills',
    'copilot'
  );

  assert.match(message, /mobile-app 0\.3\.0 -> 0\.4\.0/);
  assert.match(message, /copilot plugin marketplace update power-platform-skills/);
  assert.match(message, /copilot plugin update mobile-app@power-platform-skills/);
  assert.ok(message.indexOf('marketplace update') < message.indexOf('plugin update mobile-app@'));
});

test('formatUpdateMessage uses the plain plugin name without a marketplace', () => {
  const message = formatUpdateMessage('mobile-app', '0.3.0', '0.4.0', null, 'claude');

  assert.match(message, /claude plugin update mobile-app/);
  assert.doesNotMatch(message, /marketplace update/);
  assert.doesNotMatch(message, /@/);
});

test('formatUpdateMessage gives VS Code UI guidance without CLI commands', () => {
  const message = formatUpdateMessage(
    'mobile-app',
    '0.3.0',
    '0.4.0',
    'power-platform-skills',
    'vscode'
  );

  assert.match(message, /Agent Plugins\/Extensions view/);
  assert.match(message, /reload VS Code/);
  assert.doesNotMatch(message, /claude plugin|copilot plugin/);
});

test('formatUpdateMessage gives unknown hosts neutral UI guidance', () => {
  const message = formatUpdateMessage(
    'mobile-app',
    '0.3.0',
    '0.4.0',
    'power-platform-skills',
    'ui'
  );

  assert.match(message, /host's plugin or extensions UI/);
  assert.doesNotMatch(message, /claude plugin|copilot plugin/);
});

test('formatUpdateMessage gives local checkouts source-specific guidance', () => {
  const message = formatUpdateMessage(
    'mobile-app',
    '0.3.0',
    '0.4.0',
    'power-platform-skills',
    'claude',
    'checkout'
  );

  assert.match(message, /loaded from a local checkout/);
  assert.match(message, /Update that checkout/);
  assert.doesNotMatch(message, /plugin marketplace update|plugin update mobile-app/);
});

test('detectInstallation distinguishes copied plugins from local checkouts', (t) => {
  assert.equal(detectInstallation(createInstalledPlugin(t, '0.3.0')), 'marketplace');
  assert.equal(detectInstallation(createCheckoutPlugin(t, '0.3.0')), 'checkout');
});

test('fetchRemotePluginManifest reads only a valid manifest response', async () => {
  const requests = [];
  const manifest = await fetchRemotePluginManifest({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({ name: 'mobile-app', version: '0.4.0' }),
      };
    },
  });

  assert.deepEqual(manifest, { name: 'mobile-app', version: '0.4.0' });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal(requests[0].options.redirect, 'error');
});

test('fetchRemotePluginManifest fails closed for unavailable or malformed responses', async () => {
  assert.equal(
    await fetchRemotePluginManifest({
      fetchImpl: async () => ({ ok: false }),
    }),
    null
  );
  assert.equal(
    await fetchRemotePluginManifest({
      fetchImpl: async () => ({ ok: true, json: async () => ({ name: 'mobile-app' }) }),
    }),
    null
  );
  assert.equal(
    await fetchRemotePluginManifest({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    null
  );
  for (const version of [
    '1.2.3\nRun: fake command',
    '1.2.3\u001b[31m',
    '1.2.3-beta.1',
    '01.2.3',
  ]) {
    assert.equal(
      await fetchRemotePluginManifest({
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ name: 'mobile-app', version }),
        }),
      }),
      null
    );
  }
});

test('checkForUpdate works for a standalone installed plugin without Git metadata', async (t) => {
  const installedPluginRoot = createInstalledPlugin(t, '0.3.0');
  const message = await checkForUpdate({
    pluginRoot: installedPluginRoot,
    env: { VSCODE_PID: '123' },
    fetchRemotePlugin: async () => ({ version: '0.4.0' }),
  });

  assert.match(message, /Plugin update available: mobile-app 0\.3\.0 -> 0\.4\.0/);
  assert.match(message, /Agent Plugins\/Extensions view/);
  assert.doesNotMatch(message, /claude plugin|copilot plugin/);
});

test('checkForUpdate gives source guidance for a local checkout', async (t) => {
  const checkoutPluginRoot = createCheckoutPlugin(t, '0.3.0');
  const message = await checkForUpdate({
    pluginRoot: checkoutPluginRoot,
    env: { CLAUDECODE: '1' },
    fetchRemotePlugin: async () => ({ version: '0.4.0' }),
  });

  assert.match(message, /loaded from a local checkout/);
  assert.doesNotMatch(message, /claude plugin|copilot plugin/);
});

test('checkForUpdate rejects invalid installed and injected remote versions', async (t) => {
  const invalidLocalRoot = createInstalledPlugin(t, '0.3.0\u001b[31m');
  assert.equal(
    await checkForUpdate({
      pluginRoot: invalidLocalRoot,
      fetchRemotePlugin: async () => ({ version: '0.4.0' }),
    }),
    null
  );

  const validLocalRoot = createInstalledPlugin(t, '0.3.0');
  assert.equal(
    await checkForUpdate({
      pluginRoot: validLocalRoot,
      fetchRemotePlugin: async () => ({ version: '0.4.0\nRun: fake command' }),
    }),
    null
  );
});

test('checkForUpdate returns null when the installed version is current', async (t) => {
  const installedPluginRoot = createInstalledPlugin(t, '0.4.0');
  assert.equal(
    await checkForUpdate({
      pluginRoot: installedPluginRoot,
      fetchRemotePlugin: async () => ({ version: '0.4.0' }),
    }),
    null
  );
});

test('every public skill runs or owns the plugin check before its workflow', () => {
  const skillsRoot = path.join(pluginRoot, 'skills');
  const publicSkills = collectSkillFiles(skillsRoot).filter((skillPath) =>
    /^user-invocable: true$/m.test(normalizeLineEndings(fs.readFileSync(skillPath, 'utf8')))
  );

  assert.ok(publicSkills.length > 0);
  for (const skillPath of publicSkills) {
    const content = normalizeLineEndings(fs.readFileSync(skillPath, 'utf8'));
    if (/^name: check-updates$/m.test(content)) {
      assert.match(content, /^## Step 1: Check The Plugin$/m);
      continue;
    }
    const allowedTools = content.match(/^allowed-tools:\s*(.+)$/m);
    assert.match(
      allowedTools?.[1] || '',
      /(?:^|,\s*)Bash(?:,|$)/,
      `${path.relative(skillsRoot, skillPath)} must allow Bash for the plugin check`
    );
    const closingFrontmatter = content.indexOf('\n---\n', 4);
    assert.notEqual(closingFrontmatter, -1, `${skillPath} has no closing frontmatter`);
    const firstInstruction = content.slice(closingFrontmatter + 5).trimStart();
    assert.ok(
      firstInstruction.startsWith(pluginCheckInstruction),
      `${path.relative(skillsRoot, skillPath)} must run the plugin check first`
    );
  }
});
