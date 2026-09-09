'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  resolveMobileAppTarget,
  parseArgs,
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

function resumeFixture(t) {
  const root = makeDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launchDir = path.join(root, 'parent');
  const target = path.join(launchDir, "existing app's folder");
  fs.mkdirSync(target, { recursive: true });
  writeTemplate(target);
  fs.writeFileSync(path.join(target, 'memory-bank.md'), '# Memory\n');
  return { launchDir, target };
}

test('resume-only resolves an explicit target without a slug or filesystem writes', t => {
  const { launchDir, target } = resumeFixture(t);
  const before = fs.readdirSync(target).sort();
  const result = resolveMobileAppTarget({
    launchDir,
    workingDir: path.relative(launchDir, target),
    resumeOnly: true,
  });
  assert.strictEqual(result.action, 'resume');
  assert.strictEqual(result.workingDir, fs.realpathSync(target));
  assert.strictEqual(result.dependenciesInstalled, false);
  assert.deepStrictEqual(fs.readdirSync(target).sort(), before);
});

test('resume-only adopts an existing app in the launch directory', t => {
  const { target } = resumeFixture(t);
  const result = resolveMobileAppTarget({ launchDir: target, resumeOnly: true });
  assert.strictEqual(result.action, 'resume');
  assert.strictEqual(result.workingDir, fs.realpathSync(target));
});

test('resume-only does not create a new target or require the launch directory to be empty', t => {
  const { launchDir } = resumeFixture(t);
  for (const workingDir of [undefined, 'not-created/nested-app']) {
    const result = resolveMobileAppTarget({ launchDir, workingDir, resumeOnly: true });
    assert.strictEqual(result.action, 'none');
  }
  assert.strictEqual(fs.existsSync(path.join(launchDir, 'not-created')), false);
});

test('resume-only rejects a memory bank in a directory without template markers', t => {
  const { launchDir, target } = resumeFixture(t);
  fs.unlinkSync(path.join(target, 'app.config.js'));
  for (const options of [{ launchDir: target }, { launchDir, workingDir: target }]) {
    assert.throws(
      () => resolveMobileAppTarget({ ...options, resumeOnly: true }),
      /non-empty and is not a Power Apps mobile template/,
    );
  }
});

test('resume-only rejects root and home destinations before considering the memory bank', t => {
  const { launchDir } = resumeFixture(t);
  for (const workingDir of [path.parse(launchDir).root, os.homedir()]) {
    assert.throws(
      () => resolveMobileAppTarget({ launchDir, workingDir, resumeOnly: true }),
      /Unsafe mobile app target/,
    );
  }
});

test('resume-only CLI reports blocked targets without creating dependency files', t => {
  const { launchDir, target } = resumeFixture(t);
  fs.unlinkSync(path.join(target, 'package.json'));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../resolve-mobile-app-target.js'),
    '--launch-dir', launchDir, '--working-dir', target, '--resume-only',
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /BLOCKED: Target is non-empty/);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(fs.existsSync(path.join(target, 'node_modules')), false);
});

test('resolver arguments reject missing values rather than adopting a different directory', () => {
  assert.strictEqual(parseArgs(['--launch-dir', '.', '--resume-only']).resumeOnly, true);
  for (const argv of [
    ['--working-dir'],
    ['--working-dir', '--resume-only'],
    ['--launch-dir', '--slug', 'app'],
    ['--slug'],
  ]) {
    assert.throws(() => parseArgs(argv), /Missing value/);
  }
});

test('resume-only rejects linked destinations and non-regular memory banks', t => {
  const { launchDir, target } = resumeFixture(t);
  const linkedTarget = path.join(launchDir, 'linked');
  const danglingTarget = path.join(launchDir, 'dangling');
  try {
    fs.symlinkSync(target, linkedTarget, 'junction');
    fs.symlinkSync(path.join(launchDir, 'missing'), danglingTarget, 'junction');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('symlink creation requires additional Windows privileges');
      return;
    }
    throw error;
  }
  for (const workingDir of [linkedTarget, danglingTarget]) {
    assert.throws(
      () => resolveMobileAppTarget({ launchDir, workingDir, resumeOnly: true }),
      /must not be a symbolic link/,
    );
  }
  fs.unlinkSync(path.join(target, 'memory-bank.md'));
  fs.mkdirSync(path.join(target, 'memory-bank.md'));
  assert.throws(
    () => resolveMobileAppTarget({ launchDir, workingDir: target, resumeOnly: true }),
    /Memory bank must be a regular file/,
  );
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
