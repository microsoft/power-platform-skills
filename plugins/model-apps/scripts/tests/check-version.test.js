const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  compareSemver,
  detectHost,
  formatUpdateMessage,
  readMarketplaceName,
} = require('../check-version');

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

test('formatUpdateMessage emits Copilot update commands', () => {
  const message = formatUpdateMessage(
    'model-apps',
    '2.4.3',
    '2.4.4',
    'power-platform-skills',
    'copilot'
  );

  assert.match(message, /model-apps 2\.4\.3 -> 2\.4\.4/);
  assert.match(message, /copilot plugin marketplace update power-platform-skills/);
  assert.match(message, /copilot plugin update model-apps@power-platform-skills/);
  assert.ok(message.indexOf('marketplace update') < message.indexOf('plugin update model-apps@'));
});

test('formatUpdateMessage emits Claude update commands', () => {
  const message = formatUpdateMessage(
    'model-apps',
    '2.4.3',
    '2.4.4',
    'power-platform-skills',
    'claude'
  );

  assert.match(message, /claude plugin marketplace update power-platform-skills/);
  assert.match(message, /claude plugin update model-apps@power-platform-skills/);
});

test('formatUpdateMessage uses the plain plugin name without a marketplace', () => {
  const message = formatUpdateMessage('model-apps', '2.4.3', '2.4.4', null, 'copilot');

  assert.match(message, /copilot plugin update model-apps/);
  assert.doesNotMatch(message, /marketplace update/);
  assert.doesNotMatch(message, /@/);
});

test('readMarketplaceName reads the repository marketplace', () => {
  const { execSync } = require('node:child_process');
  const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

  assert.equal(readMarketplaceName(gitRoot), 'power-platform-skills');
});

test('readMarketplaceName falls back to the legacy marketplace path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apps-version-'));
  fs.mkdirSync(path.join(tempDir, '.claude-plugin'));
  fs.writeFileSync(
    path.join(tempDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'legacy-marketplace' })
  );

  assert.equal(readMarketplaceName(tempDir), 'legacy-marketplace');
});

test('readMarketplaceName returns null when no marketplace exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apps-version-'));
  assert.equal(readMarketplaceName(tempDir), null);
});

// End-to-end: the skills run `node "${PLUGIN_ROOT}/scripts/check-version.js"` from the USER's project
// directory, so every git call must be anchored to the plugin, never to process.cwd().
const SCRIPT = path.join(__dirname, '..', 'check-version.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writePluginManifest(pluginDir, version) {
  fs.mkdirSync(path.join(pluginDir, '.plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, '.plugin', 'plugin.json'), JSON.stringify({ name: 'model-apps', version }));
}

// A user project that is a git repo with its own origin: the script must never fetch it.
function makeUserProject(tmp) {
  git(tmp, 'init', '-q', '--bare', 'user-origin.git');
  git(tmp, 'init', '-q', '-b', 'main', 'project');
  const project = path.join(tmp, 'project');
  git(project, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(project, 'remote', 'add', 'origin', path.join(tmp, 'user-origin.git'));
  git(project, 'push', '-q', 'origin', 'main');
  fs.rmSync(path.join(project, '.git', 'FETCH_HEAD'), { force: true });
  return project;
}

function runScript(scriptPath, cwd) {
  return execFileSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, COPILOT_CLI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('check-version compares against the PLUGIN clone, not the git repo it is run from', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-version-e2e-'));
  try {
    // The plugin's own repository: origin/main publishes 1.1.0 after this clone was taken at 1.0.0.
    git(tmp, 'init', '-q', '--bare', 'origin.git');
    git(tmp, 'init', '-q', '-b', 'main', 'seed');
    const seed = path.join(tmp, 'seed');
    fs.writeFileSync(path.join(seed, 'marketplace.json'), JSON.stringify({ name: 'test-market' }));
    const seedPlugin = path.join(seed, 'plugins', 'model-apps');
    writePluginManifest(seedPlugin, '1.0.0');
    fs.mkdirSync(path.join(seedPlugin, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(seedPlugin, 'scripts', 'check-version.js'));
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'v1.0.0');
    git(seed, 'remote', 'add', 'origin', path.join(tmp, 'origin.git'));
    git(seed, 'push', '-q', 'origin', 'main');
    git(tmp, 'clone', '-q', '-b', 'main', path.join(tmp, 'origin.git'), 'clone');
    writePluginManifest(seedPlugin, '1.1.0');
    git(seed, 'commit', '-q', '-am', 'v1.1.0');
    git(seed, 'push', '-q', 'origin', 'main');

    const project = makeUserProject(tmp);
    const out = runScript(path.join(tmp, 'clone', 'plugins', 'model-apps', 'scripts', 'check-version.js'), project);

    assert.match(out, /Plugin update available: model-apps 1\.0\.0 -> 1\.1\.0\./);
    assert.match(out, /copilot plugin marketplace update test-market/);
    assert.equal(fs.existsSync(path.join(project, '.git', 'FETCH_HEAD')), false, 'the user project must not be fetched');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('check-version exits silently, touching no repository, when the plugin is not a git clone', () => {
  // Marketplace installs are plain copies of the plugin directory, not clones.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-version-copy-'));
  try {
    const plugin = path.join(tmp, 'installed', 'model-apps');
    writePluginManifest(plugin, '1.0.0');
    fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(plugin, 'scripts', 'check-version.js'));
    const project = makeUserProject(tmp);

    const out = runScript(path.join(plugin, 'scripts', 'check-version.js'), project);

    assert.equal(out, '');
    assert.equal(fs.existsSync(path.join(project, '.git', 'FETCH_HEAD')), false, 'the user project must not be fetched');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
