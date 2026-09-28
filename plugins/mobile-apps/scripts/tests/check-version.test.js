'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  checkForUpdate,
  compareSemver,
  detectHost,
  formatUpdateMessage,
  readMarketplaceName,
} = require('../check-version');

const pluginRoot = path.resolve(__dirname, '..', '..');
const pluginCheckInstruction =
  '> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.';

function runGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function createVersionedPlugin(t, localVersion, remoteVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-app-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const installedPluginRoot = path.join(root, 'plugins', 'mobile-apps');
  fs.mkdirSync(path.join(installedPluginRoot, '.plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'marketplace.json'),
    JSON.stringify({ name: 'power-platform-skills' })
  );
  fs.writeFileSync(
    path.join(installedPluginRoot, '.plugin', 'plugin.json'),
    JSON.stringify({ name: 'mobile-app', version: remoteVersion })
  );

  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.email', 'tests@example.com']);
  runGit(root, ['config', 'user.name', 'Version Check Tests']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'remote marketplace state']);
  runGit(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  fs.writeFileSync(
    path.join(installedPluginRoot, '.plugin', 'plugin.json'),
    JSON.stringify({ name: 'mobile-app', version: localVersion })
  );

  return installedPluginRoot;
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

test('compareSemver compares major, minor, and patch versions', () => {
  assert.equal(compareSemver('1.2.0', '1.2.0'), 0);
  assert.equal(compareSemver('1.2', '1.2.0'), 0);
  assert.equal(compareSemver('1.2.0', '2.0.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.3.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.2.1'), 1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), -1);
});

test('detectHost recognizes GitHub Copilot CLI', () => {
  assert.equal(detectHost({ COPILOT_CLI: '1' }), 'copilot');
  assert.equal(detectHost({}), 'claude');
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

test('readMarketplaceName reads Open Plugins and legacy marketplace manifests', (t) => {
  const openRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-app-open-marketplace-'));
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-app-legacy-marketplace-'));
  t.after(() => fs.rmSync(openRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(legacyRoot, { recursive: true, force: true }));

  fs.writeFileSync(path.join(openRoot, 'marketplace.json'), JSON.stringify({ name: 'open' }));
  fs.mkdirSync(path.join(legacyRoot, '.claude-plugin'));
  fs.writeFileSync(
    path.join(legacyRoot, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'legacy' })
  );

  assert.equal(readMarketplaceName(openRoot), 'open');
  assert.equal(readMarketplaceName(legacyRoot), 'legacy');
  assert.equal(readMarketplaceName(path.join(openRoot, 'missing')), null);
});

test('checkForUpdate reads origin/main from the plugin repository regardless of cwd', (t) => {
  const installedPluginRoot = createVersionedPlugin(t, '0.3.0', '0.4.0');
  const message = checkForUpdate({
    pluginRoot: installedPluginRoot,
    env: { COPILOT_CLI: '1' },
  });

  assert.match(message, /Plugin update available: mobile-app 0\.3\.0 -> 0\.4\.0/);
  assert.match(message, /copilot plugin update mobile-app@power-platform-skills/);
});

test('checkForUpdate returns null when the installed version is current', (t) => {
  const installedPluginRoot = createVersionedPlugin(t, '0.4.0', '0.4.0');
  assert.equal(checkForUpdate({ pluginRoot: installedPluginRoot }), null);
});

test('every public skill runs the plugin check before its workflow', () => {
  const skillsRoot = path.join(pluginRoot, 'skills');
  const publicSkills = collectSkillFiles(skillsRoot).filter((skillPath) =>
    /^user-invocable: true$/m.test(fs.readFileSync(skillPath, 'utf8'))
  );

  assert.ok(publicSkills.length > 0);
  for (const skillPath of publicSkills) {
    const content = fs.readFileSync(skillPath, 'utf8');
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
