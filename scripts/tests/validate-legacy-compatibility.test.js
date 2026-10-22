// Guards the marketplace mirror check. Copilot CLI reads marketplace.json and Claude Code
// reads .claude-plugin/marketplace.json, so a wrong source in either file breaks one host
// while the other keeps working. The remote-source cases matter most: a `git-subdir`
// source in marketplace.json makes Copilot CLI refuse the whole marketplace, and a
// `github` source with `path` in the legacy file makes Claude Code install an empty plugin.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validate, expectedLegacyRemoteSource } = require('../validate-legacy-compatibility.js');

const OPEN_REMOTE = { source: 'github', repo: 'contoso/plugins', path: 'plugins/widget' };
const LEGACY_REMOTE = { source: 'git-subdir', url: 'contoso/plugins', path: 'plugins/widget' };

const LOCAL_MANIFEST = {
  name: 'local-plugin',
  version: '1.0.0',
  description: 'A local plugin.',
  author: { name: 'Contoso' },
  homepage: 'https://example.com',
  repository: 'https://example.com/repo',
  license: 'MIT',
  keywords: ['local'],
};

function marketplace(remoteSource) {
  return {
    name: 'test-marketplace',
    owner: { name: 'Contoso' },
    metadata: { description: 'Test marketplace', pluginRoot: '.' },
    plugins: [
      { name: 'local-plugin', source: './plugins/local-plugin' },
      { name: 'widget', source: remoteSource },
    ],
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

const fixtureRoots = [];
test.after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(openRemote, legacyRemote) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-compat-'));
  fixtureRoots.push(root);
  writeJson(path.join(root, 'marketplace.json'), marketplace(openRemote));
  writeJson(path.join(root, '.claude-plugin', 'marketplace.json'), marketplace(legacyRemote));
  writeJson(path.join(root, 'plugins', 'local-plugin', '.plugin', 'plugin.json'), LOCAL_MANIFEST);
  writeJson(path.join(root, 'plugins', 'local-plugin', '.claude-plugin', 'plugin.json'), LOCAL_MANIFEST);
  return root;
}

test('a remote subdirectory plugin passes with github in marketplace.json and git-subdir in the legacy file', () => {
  assert.deepEqual(validate(fixture(OPEN_REMOTE, LEGACY_REMOTE)), []);
});

test('git-subdir in marketplace.json is rejected because Copilot CLI refuses the whole marketplace', () => {
  const errors = validate(fixture(LEGACY_REMOTE, LEGACY_REMOTE));
  assert.ok(errors.some((error) => /must use the "github" type/.test(error)), errors.join('\n'));
});

test('github with path in the legacy file is rejected because Claude Code ignores path', () => {
  const errors = validate(fixture(OPEN_REMOTE, OPEN_REMOTE));
  assert.ok(errors.some((error) => /^widget remote marketplace entry/.test(error)), errors.join('\n'));
});

test('ref and sha pins carry over to the legacy source', () => {
  const sha = 'a'.repeat(40);
  const open = { ...OPEN_REMOTE, ref: 'v1.0.0', sha };
  assert.deepEqual(expectedLegacyRemoteSource(open), { ...LEGACY_REMOTE, ref: 'v1.0.0', sha });
  assert.deepEqual(validate(fixture(open, { ...LEGACY_REMOTE, ref: 'v1.0.0', sha })), []);
  assert.notDeepEqual(validate(fixture(open, LEGACY_REMOTE)), []);
});

test('a repository-root github source mirrors unchanged, since both hosts read it the same way', () => {
  const rootSource = { source: 'github', repo: 'contoso/widget' };
  assert.deepEqual(expectedLegacyRemoteSource(rootSource), rootSource);
  assert.deepEqual(validate(fixture(rootSource, rootSource)), []);
});

test('malformed remote sources are rejected', () => {
  const cases = [
    { ...OPEN_REMOTE, repo: 'not-a-repo' },
    { ...OPEN_REMOTE, path: '../escape' },
    { ...OPEN_REMOTE, path: '/absolute' },
    { ...OPEN_REMOTE, sha: 'abc123' },
    { ...OPEN_REMOTE, extra: true },
  ];
  for (const open of cases) {
    const errors = validate(fixture(open, expectedLegacyRemoteSource(open)));
    assert.ok(errors.length > 0, `expected ${JSON.stringify(open)} to be rejected`);
  }
});

test('the committed marketplace files pass', () => {
  assert.deepEqual(validate(), []);
});
