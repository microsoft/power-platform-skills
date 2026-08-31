'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveMobileAppTarget,
} = require('../resolve-mobile-app-target');

function makeDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-target-'));
}

function writeTemplate(projectRoot, { installed = false, plan = false } = {}) {
  for (const relativePath of [
    'package.json',
    'app.config.js',
    'auth.config.json',
    'tamagui.config.ts',
  ]) {
    const absolutePath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, '{}\n');
  }
  if (installed) {
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'expo'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'node_modules', '.package-lock.json'), '{}\n');
  }
  if (plan) {
    fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), '# Draft\n');
  }
}

test('defaults to a slug child directory when launched from a parent folder', () => {
  const launchDir = makeDirectory();
  const result = resolveMobileAppTarget({
    launchDir,
    slug: 'field-inspector',
  });

  assert.strictEqual(result.action, 'materialize');
  assert.strictEqual(result.workingDir, path.join(fs.realpathSync(launchDir), 'field-inspector'));
  assert.strictEqual(result.dependenciesInstalled, false);
});

test('honors an explicit working directory relative to the launch directory', () => {
  const launchDir = makeDirectory();
  const result = resolveMobileAppTarget({
    launchDir,
    slug: 'field-inspector',
    workingDir: 'apps/custom-target',
  });

  assert.strictEqual(result.action, 'materialize');
  assert.strictEqual(
    result.workingDir,
    path.join(fs.realpathSync(launchDir), 'apps', 'custom-target'),
  );
});

test('allows an explicitly requested empty launch directory', () => {
  const launchDir = makeDirectory();
  const result = resolveMobileAppTarget({
    launchDir,
    slug: 'field-inspector',
    workingDir: '.',
  });

  assert.strictEqual(result.action, 'materialize');
  assert.strictEqual(result.workingDir, fs.realpathSync(launchDir));
});

test('adopts a template in the launch directory instead of nesting another app', () => {
  const launchDir = makeDirectory();
  writeTemplate(launchDir, { installed: true });

  const result = resolveMobileAppTarget({
    launchDir,
    slug: 'field-inspector',
  });

  assert.strictEqual(result.action, 'adopt');
  assert.strictEqual(result.workingDir, fs.realpathSync(launchDir));
  assert.strictEqual(result.dependenciesInstalled, true);
});

test('adopts a safe partial planning run so installation can be retried', () => {
  const launchDir = makeDirectory();
  const target = path.join(launchDir, 'field-inspector');
  fs.mkdirSync(target);
  writeTemplate(target, { plan: true });

  const result = resolveMobileAppTarget({
    launchDir,
    slug: 'field-inspector',
  });

  assert.strictEqual(result.action, 'adopt');
  assert.strictEqual(result.partialPlan, true);
  assert.strictEqual(result.dependenciesInstalled, false);
});

test('does not treat a single installed package as a completed dependency tree', () => {
  const launchDir = makeDirectory();
  writeTemplate(launchDir);
  fs.mkdirSync(path.join(launchDir, 'node_modules', 'expo'), { recursive: true });

  const result = resolveMobileAppTarget({
    launchDir,
    slug: 'field-inspector',
  });

  assert.strictEqual(result.action, 'adopt');
  assert.strictEqual(result.dependenciesInstalled, false);
});

test('resumes an app only when the memory bank is present', () => {
  const launchDir = makeDirectory();
  writeTemplate(launchDir, { installed: true, plan: true });
  fs.writeFileSync(path.join(launchDir, 'memory-bank.md'), '# Memory\n');

  const result = resolveMobileAppTarget({
    launchDir,
    slug: 'field-inspector',
  });

  assert.strictEqual(result.action, 'resume');
  assert.strictEqual(result.partialPlan, true);
});

test('rejects unrelated non-empty destinations', () => {
  const launchDir = makeDirectory();
  const target = path.join(launchDir, 'field-inspector');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'notes.txt'), 'unrelated\n');

  assert.throws(
    () => resolveMobileAppTarget({ launchDir, slug: 'field-inspector' }),
    /non-empty and is not a Power Apps mobile template/,
  );
});

test('rejects generated app state without a memory bank', () => {
  const launchDir = makeDirectory();
  const target = path.join(launchDir, 'field-inspector');
  fs.mkdirSync(target);
  writeTemplate(target);
  fs.writeFileSync(path.join(target, '.datamodel-manifest.json'), '{}\n');

  assert.throws(
    () => resolveMobileAppTarget({ launchDir, slug: 'field-inspector' }),
    /generated app data without memory-bank\.md/,
  );
});

test('rejects an initialized power config without a memory bank', () => {
  const launchDir = makeDirectory();
  const target = path.join(launchDir, 'field-inspector');
  fs.mkdirSync(target);
  writeTemplate(target);
  fs.writeFileSync(
    path.join(target, 'power.config.json'),
    '{"environmentId":"00000000-0000-0000-0000-000000000000"}\n',
  );

  assert.throws(
    () => resolveMobileAppTarget({ launchDir, slug: 'field-inspector' }),
    /generated app data without memory-bank\.md/,
  );
});

test('rejects a symbolic-link destination', (t) => {
  const launchDir = makeDirectory();
  const actualTarget = makeDirectory();
  const linkedTarget = path.join(launchDir, 'field-inspector');

  try {
    fs.symlinkSync(actualTarget, linkedTarget, 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('symlink creation requires additional Windows privileges');
      return;
    }
    throw error;
  }

  assert.throws(
    () => resolveMobileAppTarget({ launchDir, slug: 'field-inspector' }),
    /must not be a symbolic link/,
  );
});
