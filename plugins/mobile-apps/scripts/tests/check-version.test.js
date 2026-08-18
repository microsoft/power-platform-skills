'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CACHE_TTL_MS,
  REMOTE_MANIFEST_URL,
  compareSemver,
  fetchRemotePlugin,
  formatUpdateMessage,
  getRemoteVersion,
  isFresh,
  resolveCachePath,
} = require('../check-version');

test('compareSemver identifies newer remote versions', () => {
  assert.equal(compareSemver('0.2.0', '0.2.0'), 0);
  assert.equal(compareSemver('0.2.0', '0.2.1'), 1);
  assert.equal(compareSemver('0.2.0', '0.3.0'), 1);
  assert.equal(compareSemver('1.0.0', '0.9.0'), -1);
});

test('fetchRemotePlugin reads the published mobile-app manifest', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, REMOTE_MANIFEST_URL);
    return {
      ok: true,
      json: async () => ({ name: 'mobile-app', version: '0.3.0' }),
    };
  };

  assert.deepEqual(await fetchRemotePlugin(fetchImpl), {
    name: 'mobile-app',
    version: '0.3.0',
  });
});

test('fetchRemotePlugin rejects unsuccessful responses', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchRemotePlugin(fetchImpl), /HTTP 503/);
});

test('uses a cached version for seven days without fetching', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-version-check-'));
  const cachePath = path.join(root, 'cache.json');
  const now = Date.UTC(2026, 7, 18);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: now, remoteVersion: '0.3.0' }));

  const remoteVersion = await getRemoteVersion({
    cachePath,
    now: now + CACHE_TTL_MS - 1,
    fetchImpl: async () => assert.fail('fresh cache must skip the network'),
  });

  assert.equal(remoteVersion, '0.3.0');
  assert.equal(isFresh({ checkedAt: now, remoteVersion: '0.3.0' }, now + CACHE_TTL_MS), false);
});

test('refreshes a stale cache and persists the published version', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-version-check-'));
  const cachePath = path.join(root, 'nested', 'cache.json');
  const now = Date.UTC(2026, 7, 18);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const remoteVersion = await getRemoteVersion({
    cachePath,
    now,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ version: '0.4.0' }),
    }),
  });

  assert.equal(remoteVersion, '0.4.0');
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), {
    checkedAt: now,
    remoteVersion: '0.4.0',
  });
});

test('falls back to a stale cached update when refresh fails', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-version-check-'));
  const cachePath = path.join(root, 'cache.json');
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: 1, remoteVersion: '0.3.0' }));

  assert.equal(
    await getRemoteVersion({
      cachePath,
      now: CACHE_TTL_MS + 1,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    '0.3.0'
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), {
    checkedAt: CACHE_TTL_MS + 1,
    remoteVersion: '0.3.0',
  });
});

test('caches failed attempts so offline skills do not repeatedly fetch', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-version-check-'));
  const cachePath = path.join(root, 'cache.json');
  const now = Date.UTC(2026, 7, 18);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(
    await getRemoteVersion({
      cachePath,
      now,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    null
  );
  assert.equal(
    await getRemoteVersion({
      cachePath,
      now: now + 1,
      fetchImpl: async () => assert.fail('fresh failure cache must skip the network'),
    }),
    null
  );
});

test('uses a user cache directory instead of modifying the app', () => {
  assert.equal(
    resolveCachePath({ XDG_CACHE_HOME: '/cache' }, '/home/user'),
    path.join('/cache', 'power-platform-skills', 'mobile-app-version-check.json')
  );
});

test('formatUpdateMessage suggests both supported plugin managers', () => {
  const message = formatUpdateMessage(
    'mobile-app',
    '0.2.0',
    '0.3.0',
    'power-platform-skills'
  );

  assert.match(message, /mobile-app 0\.2\.0 -> 0\.3\.0/);
  assert.match(message, /copilot plugin marketplace update power-platform-skills/);
  assert.match(message, /copilot plugin update mobile-app@power-platform-skills/);
  assert.match(message, /claude plugin marketplace update power-platform-skills/);
  assert.match(message, /claude plugin update mobile-app@power-platform-skills/);
});

test('every top-level mobile skill loads shared instructions', () => {
  const skillsRoot = path.resolve(__dirname, '..', '..', 'skills');
  const missing = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsRoot, entry.name, 'SKILL.md'))
    .filter((skillPath) => fs.existsSync(skillPath))
    .filter((skillPath) => !fs.readFileSync(skillPath, 'utf8').includes('shared-instructions.md'))
    .map((skillPath) => path.relative(skillsRoot, skillPath));

  assert.deepEqual(missing, []);
});

test('mobile instructions do not hardcode Expo or React Native versions', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const roots = ['skills', 'shared', 'agents'].map((name) => path.join(pluginRoot, name));
  const findings = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (/\.md$/i.test(entry.name)) {
        const content = fs.readFileSync(entryPath, 'utf8');
        const hasSdkGeneration = /\b(?:Expo SDK|SDK)\s+\d+\b/i.test(content);
        const hasPackagePin =
          /`(?:expo|expo-[a-z0-9-]+|react-native)`\s*(?:@|:|\||v(?:ersion)?\s+)\s*`?\^?\d+\.\d+/i.test(
            content
          );
        if (hasSdkGeneration || hasPackagePin) {
          findings.push(path.relative(pluginRoot, entryPath));
        }
      }
    }
  }

  for (const root of roots) walk(root);
  assert.deepEqual(findings, []);
});

test('version-check resolves latest host from npm and pins upgrade commands', () => {
  const skillPath = path.resolve(__dirname, '..', '..', 'skills', 'version-check', 'SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  const npmLookup = 'npm view @microsoft/power-apps-native-host@latest version --json';
  const pinnedPackage = '@microsoft/power-apps-native-host@<latestHost>';

  assert.ok(skill.includes(npmLookup));
  assert.ok(skill.indexOf(npmLookup) < skill.indexOf('upgrade-template --dry-run'));
  assert.match(skill, new RegExp(`${pinnedPackage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} upgrade-template --dry-run`));
  assert.match(skill, new RegExp(`${pinnedPackage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} upgrade-template`));
  assert.doesNotMatch(
    skill,
    /npx[^\n]*--package @microsoft\/power-apps-native-host@latest[^\n]*upgrade-template/
  );
});