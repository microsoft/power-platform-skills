'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const templateRoot = path.join(pluginRoot, 'template');
const installerPath = path.join(
  pluginRoot,
  'skills',
  'create-mobile-prototype',
  'runtime',
  'install-dependencies.js',
);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('template commits npm and pnpm lockfiles for every declared dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(templateRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(templateRoot, 'package-lock.json'), 'utf8'));
  const pnpmLock = fs.readFileSync(path.join(templateRoot, 'pnpm-lock.yaml'), 'utf8');
  const pnpmWorkspace = fs.readFileSync(path.join(templateRoot, 'pnpm-workspace.yaml'), 'utf8');
  const expected = { ...packageJson.dependencies, ...packageJson.devDependencies };

  assert.equal(packageLock.lockfileVersion, 3);
  assert.deepEqual(packageLock.packages[''].dependencies, packageJson.dependencies);
  assert.deepEqual(packageLock.packages[''].devDependencies, packageJson.devDependencies);
  for (const [name, version] of Object.entries(expected)) {
    assert.match(
      pnpmLock,
      new RegExp(`\\n\\s{6}['"]?${escapeRegex(name)}['"]?:\\n\\s{8}specifier: ['"]?${escapeRegex(version)}['"]?`),
    );
  }
  for (const packageName of [
    '@azure/msal-node-extensions',
    '@azure/msal-node-runtime',
    '@microsoft/power-apps-native-offline',
    'esbuild',
    'keytar',
  ]) {
    assert.match(pnpmWorkspace, new RegExp(`['"]?${escapeRegex(packageName)}['"]?: true`));
  }
  assert.doesNotMatch(pnpmWorkspace, /onlyBuiltDependencies/);
});

test('installer prefers pnpm when available and exposes the npm fallback', () => {
  const npmResult = spawnSync(process.execPath, [
    installerPath,
    templateRoot,
    '--manager',
    'npm',
    '--dry-run',
  ], { encoding: 'utf8' });
  assert.equal(npmResult.status, 0, npmResult.stderr);
  assert.deepEqual(JSON.parse(npmResult.stdout), {
    command: 'npm',
    args: ['install'],
    manager: 'npm',
    projectDir: templateRoot,
  });

  const autoResult = spawnSync(process.execPath, [installerPath, templateRoot, '--dry-run'], {
    encoding: 'utf8',
  });
  assert.equal(autoResult.status, 0, autoResult.stderr);
  const selected = JSON.parse(autoResult.stdout);
  assert.ok(['npm', 'pnpm'].includes(selected.manager));
  assert.equal(selected.projectDir, templateRoot);
  assert.deepEqual(
    selected.args,
    selected.manager === 'pnpm' ? ['install', '--frozen-lockfile'] : ['install'],
  );
});