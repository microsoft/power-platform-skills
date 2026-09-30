'use strict';

/**
 * The template ships a committed package-lock.json so every generated app starts from the
 * same dependency tree. Two properties have to hold for that to be safe in a public repo,
 * and neither is enforced by npm itself.
 *
 * The repo-wide sweep in plugins/model-apps/scripts/tests/run-tests.test.js checks the leak
 * property too, but its workflow is path-filtered to model-apps, so a change to THIS lock
 * would never trigger it. These tests run in the mobile-apps workflow.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const templateRoot = path.resolve(__dirname, '..', '..', 'template');
const lockPath = path.join(templateRoot, 'package-lock.json');

function readLock() {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

test('the template ships a lock file so generated apps get a reproducible tree', () => {
  assert.ok(fs.existsSync(lockPath), 'plugins/mobile-apps/template/package-lock.json must exist');
  assert.equal(readLock().lockfileVersion, 3);
});

test('the template lock records no registry URL of any kind', () => {
  // Contributors install through internal Azure Artifacts feeds, so a lock generated without
  // `omit-lockfile-registry-resolved` rewrites every `resolved` to an internal URL and leaks it
  // into this OSS repo. The template owns its own package.json and npm does not walk up, so the
  // repo-root .npmrc does NOT cover it - regenerate with:
  //   npm_config_omit_lockfile_registry_resolved=true npm install --package-lock-only
  const lock = readLock();
  const offenders = [];
  for (const section of ['packages', 'dependencies']) {
    for (const [name, entry] of Object.entries(lock[section] || {})) {
      if (entry && entry.resolved !== undefined) {
        offenders.push(`${section}['${name}'] -> ${entry.resolved}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], `lock file must record no "resolved" field:\n  ${offenders.join('\n  ')}`);
});

test('stripping resolved does not cost supply-chain protection', () => {
  const packages = Object.entries(readLock().packages || {}).filter(([name]) => name !== '');
  // `inBundle` entries ship inside their parent's tarball (bundleDependencies) and have no
  // tarball of their own; the parent's integrity hash covers their bytes.
  const missing = packages
    .filter(([, entry]) => !entry.link && !entry.inBundle && entry.integrity === undefined)
    .map(([name]) => name);
  assert.deepStrictEqual(missing, [], 'every independently fetched package keeps its integrity hash');
});

test('the lock keeps every platform binary, not just the one it was generated on', () => {
  // Regenerating on a single OS can silently collapse optional platform packages, which then
  // breaks CI on the other runners. esbuild ships one optional package per platform, so its
  // count is the canary.
  const packages = Object.keys(readLock().packages || {});
  const esbuild = packages.filter((name) => name.includes('@esbuild/'));
  assert.ok(
    esbuild.length >= 10,
    `expected the cross-platform esbuild set, found ${esbuild.length}: ${esbuild.join(', ')}`,
  );

  const platforms = new Set();
  for (const entry of Object.values(readLock().packages || {})) {
    for (const os of (entry && entry.os) || []) platforms.add(os);
  }
  for (const required of ['darwin', 'linux', 'win32']) {
    assert.ok(platforms.has(required), `lock must retain ${required} optional packages`);
  }
});

test('the lock stays in sync with package.json so `npm ci` cannot drift', () => {
  // The CI template job runs `npm ci`, which fails outright when these disagree. Catching it
  // here names the offending dependency instead of failing deep inside an install.
  const packageJson = JSON.parse(fs.readFileSync(path.join(templateRoot, 'package.json'), 'utf8'));
  const root = readLock().packages[''];
  assert.ok(root, 'lock must describe the root package');

  for (const section of ['dependencies', 'devDependencies']) {
    assert.deepStrictEqual(
      root[section] || {},
      packageJson[section] || {},
      `lock root ${section} must match package.json; regenerate the lock after editing it`,
    );
  }
  assert.equal(root.name, packageJson.name);
});
