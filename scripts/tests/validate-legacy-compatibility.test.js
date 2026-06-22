const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// These tests guard the guard: scripts/validate-legacy-compatibility.js exists to keep
// the legacy .claude-plugin manifests (and CLAUDE.md) committed as real, parseable files
// rather than symlinks — the issue #201 Windows failure mode. CI only ever runs that
// script against the real (always-clean) repo, so the happy path is covered but the
// rejection logic is not; a future refactor could drop assertRegularFile and CI would
// stay green. Here we point the validator at throwaway fixture trees (via
// LEGACY_COMPAT_ROOT) and assert it actually FAILS on each planted regression.
// See: https://github.com/microsoft/power-platform-skills/issues/201

const VALIDATOR = path.join(__dirname, '..', 'validate-legacy-compatibility.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Pretty-print + trailing newline so JSON mirrors are byte-identical the way the real
  // committed files are (deepEqual ignores formatting, but keeping it realistic).
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// fs.symlinkSync needs SeCreateSymbolicLink on Windows (Developer Mode / admin); CI is
// Linux where it always works. If a dev box can't make symlinks, skip that case rather
// than fail — the Linux CI run is the authoritative one.
function trySymlink(target, linkPath) {
  try {
    if (fs.existsSync(linkPath) || fs.lstatSync(linkPath)) {
      fs.rmSync(linkPath, { force: true });
    }
  } catch {
    /* nothing to remove */
  }
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'ENOSYS') {
      return false;
    }
    throw error;
  }
}

// Build a minimal marketplace tree that PASSES every check, so each test can then mutate
// exactly one thing and attribute the resulting failure to that mutation.
function buildFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const marketplace = {
    name: 'fixture-marketplace',
    metadata: { pluginRoot: '.' },
    plugins: [
      {
        name: 'foo',
        source: './plugins/foo',
        description: 'Foo plugin',
        category: 'development',
        version: '1.0.0',
        tags: ['x', 'y'],
        keywords: ['x', 'y'],
      },
    ],
  };
  // Legacy marketplace mirror is a byte-for-byte copy of the Open Plugins marketplace.
  writeJson(path.join(root, 'marketplace.json'), marketplace);
  writeJson(path.join(root, '.claude-plugin', 'marketplace.json'), marketplace);

  const pluginManifest = {
    name: 'foo',
    version: '1.0.0',
    description: 'Foo plugin',
    keywords: ['x', 'y'],
  };
  const pluginDir = path.join(root, 'plugins', 'foo');
  writeJson(path.join(pluginDir, '.plugin', 'plugin.json'), pluginManifest);
  writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), pluginManifest);

  // CLAUDE.md is a real copy of the sibling AGENTS.md, at root and in the plugin dir,
  // so both checkClaudeMirror(ROOT) and checkClaudeMirror(pluginDir) are exercised.
  for (const dir of [root, pluginDir]) {
    const agents = `# AGENTS for ${path.basename(dir)}\n\nGuidance.\n`;
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents, 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), agents, 'utf8');
  }

  return root;
}

function runValidator(root) {
  const result = spawnSync(process.execPath, [VALIDATOR], {
    env: { ...process.env, LEGACY_COMPAT_ROOT: root },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

test('passes on a clean mirror tree', (t) => {
  const root = buildFixture(t);
  const { status, output } = runValidator(root);
  assert.equal(status, 0, output);
  assert.match(output, /in sync/);
});

test('fails when the legacy marketplace manifest is a symlink', (t) => {
  const root = buildFixture(t);
  const legacy = path.join(root, '.claude-plugin', 'marketplace.json');
  fs.rmSync(legacy);
  if (!trySymlink('../marketplace.json', legacy)) {
    t.skip('symlink creation not permitted on this platform');
    return;
  }
  const { status, output } = runValidator(root);
  assert.equal(status, 1, output);
  assert.match(output, /regular file/);
});

test('fails when a legacy plugin manifest is a symlink', (t) => {
  const root = buildFixture(t);
  const legacy = path.join(root, 'plugins', 'foo', '.claude-plugin', 'plugin.json');
  fs.rmSync(legacy);
  if (!trySymlink(path.join('..', '.plugin', 'plugin.json'), legacy)) {
    t.skip('symlink creation not permitted on this platform');
    return;
  }
  const { status, output } = runValidator(root);
  assert.equal(status, 1, output);
  assert.match(output, /regular file/);
});

test('fails when CLAUDE.md is a (resolving) symlink', (t) => {
  const root = buildFixture(t);
  const claude = path.join(root, 'CLAUDE.md');
  fs.rmSync(claude);
  if (!trySymlink('AGENTS.md', claude)) {
    t.skip('symlink creation not permitted on this platform');
    return;
  }
  const { status, output } = runValidator(root);
  assert.equal(status, 1, output);
  assert.match(output, /regular file/);
});

test('fails when CLAUDE.md is a DANGLING symlink (would slip past existsSync)', (t) => {
  const root = buildFixture(t);
  const claude = path.join(root, 'CLAUDE.md');
  fs.rmSync(claude);
  // Target intentionally missing — fs.existsSync(claude) is false, so a presence test
  // based on existsSync would skip this file entirely. The lstat-based check must catch it.
  if (!trySymlink('AGENTS.MISSING.md', claude)) {
    t.skip('symlink creation not permitted on this platform');
    return;
  }
  assert.equal(fs.existsSync(claude), false, 'dangling symlink should look absent to existsSync');
  const { status, output } = runValidator(root);
  assert.equal(status, 1, output);
  assert.match(output, /regular file/);
});

test('fails when CLAUDE.md content drifts from AGENTS.md', (t) => {
  const root = buildFixture(t);
  fs.appendFileSync(path.join(root, 'CLAUDE.md'), 'drifted line\n', 'utf8');
  const { status, output } = runValidator(root);
  assert.equal(status, 1, output);
  assert.match(output, /issues/);
});

test('fails when a legacy manifest mirror content drifts', (t) => {
  const root = buildFixture(t);
  const legacy = path.join(root, '.claude-plugin', 'marketplace.json');
  const drifted = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  drifted.name = 'drifted-name';
  writeJson(legacy, drifted);
  const { status, output } = runValidator(root);
  assert.equal(status, 1, output);
  assert.match(output, /issues/);
});
