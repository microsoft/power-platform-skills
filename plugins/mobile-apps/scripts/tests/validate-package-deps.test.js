'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VALIDATOR = path.resolve(__dirname, '..', '..', 'hooks', 'validate-package-deps.js');

function makeProject(packageName, packageFiles = []) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-package-deps-'));
  const packageRoot = path.join(projectRoot, 'node_modules', ...packageName.split('/'));
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { [packageName]: '1.0.0' } }),
  );
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', main: 'src/index.js' }),
  );

  for (const packageFile of packageFiles) {
    const target = path.join(packageRoot, packageFile);
    if (path.extname(packageFile)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
    } else {
      fs.mkdirSync(target, { recursive: true });
    }
  }

  return projectRoot;
}

function validate(projectRoot, validatorPath = VALIDATOR) {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const payload = {
    cwd: projectRoot,
    tool_name: 'Write',
    tool_input: {
      content: fs.readFileSync(packageJsonPath, 'utf8'),
      file_path: packageJsonPath,
      validation_mode: 'explicit-mobile-workflow',
    },
  };

  return spawnSync(process.execPath, [validatorPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: JSON.stringify(payload),
  });
}

test('allows an installed source-only react-native package', (t) => {
  const projectRoot = makeProject('react-native-calendars', ['src/index.js']);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot);

  assert.strictEqual(result.status, 0, result.stderr);
});

test('blocks an installed react-native package with a platform project', (t) => {
  const projectRoot = makeProject('react-native-example-native', ['android']);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot);

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /ships native code\/config/);
});

test('blocks a generic package name when installed contents include native code', (t) => {
  const projectRoot = makeProject('calendar-helper', ['ios']);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot);

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /calendar-helper/);
  assert.match(result.stderr, /ships native code\/config/);
});

test('blocks an uninstalled react-native package conservatively', (t) => {
  const projectRoot = makeProject('placeholder');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const packageJsonPath = path.join(projectRoot, 'package.json');
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({ name: 'fixture', dependencies: { 'react-native-unknown': '1.0.0' } }),
  );

  const result = validate(projectRoot);

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /react-native-unknown/);
});

test('blocks explicit validation when the template allowlist cannot be loaded', (t) => {
  const projectRoot = makeProject('plain-js-package', ['src/index.js']);
  const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-validator-plugin-'));
  const isolatedValidator = path.join(isolatedPluginRoot, 'hooks', 'validate-package-deps.js');
  fs.mkdirSync(path.dirname(isolatedValidator), { recursive: true });
  fs.copyFileSync(VALIDATOR, isolatedValidator);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(isolatedPluginRoot, { recursive: true, force: true }));

  const result = validate(projectRoot, isolatedValidator);

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /unable to load native dependency allowlist/);
});