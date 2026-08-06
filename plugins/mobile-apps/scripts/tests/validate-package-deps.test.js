'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DISPATCHER = path.resolve(__dirname, '..', 'validate-mobile-files.js');
const VALIDATOR = path.resolve(__dirname, '..', '..', 'hooks', 'validate-package-deps.js');

function makeProject(packageName, version = '1.0.0') {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-package-deps-'));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { [packageName]: version } }),
  );
  return projectRoot;
}

function validate(projectRoot, approvedDependencies = []) {
  const args = [
    DISPATCHER,
    '--project-root',
    projectRoot,
    '--file',
    'package.json',
  ];
  for (const approvedDependency of approvedDependencies) {
    args.push('--approved-js-dependency', approvedDependency);
  }
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

test('blocks a new react-native-prefixed package without plan approval', (t) => {
  const projectRoot = makeProject('react-native-calendars', '1.1314.0');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot);

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /user-approved JavaScript Dependencies plan/);
});

test('allows the exact react-native-prefixed package version approved in the plan', (t) => {
  const projectRoot = makeProject('react-native-calendars', '1.1314.0');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot, ['react-native-calendars@1.1314.0']);

  assert.strictEqual(result.status, 0, result.stderr);
});

test('blocks an approved package when package.json has a different version', (t) => {
  const projectRoot = makeProject('react-native-calendars', '1.1314.0');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot, ['react-native-calendars@1.1300.0']);

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /react-native-calendars@1\.1314\.0/);
});

test('does not let plan approval bypass a known native package block', (t) => {
  const projectRoot = makeProject('expo-notifications', '1.0.0');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot, ['expo-notifications@1.0.0']);

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Native\/runtime dependency `expo-notifications`/);
});

test('continues to allow ordinary JavaScript packages without an exception', (t) => {
  const projectRoot = makeProject('date-fns', '4.1.0');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot);

  assert.strictEqual(result.status, 0, result.stderr);
});

test('rejects non-exact approved dependency versions', (t) => {
  const projectRoot = makeProject('react-native-calendars', '1.1314.0');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot, ['react-native-calendars@^1.1314.0']);

  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Invalid --approved-js-dependency value/);
});

test('parses scoped exact-version approvals', (t) => {
  const projectRoot = makeProject('@scope/calendar-tools', '2.3.4');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const result = validate(projectRoot, ['@scope/calendar-tools@2.3.4']);

  assert.strictEqual(result.status, 0, result.stderr);
});

test('blocks explicit validation when the template allowlist cannot be loaded', (t) => {
  const projectRoot = makeProject('date-fns', '4.1.0');
  const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-validator-plugin-'));
  const isolatedValidator = path.join(isolatedPluginRoot, 'hooks', 'validate-package-deps.js');
  fs.mkdirSync(path.dirname(isolatedValidator), { recursive: true });
  fs.copyFileSync(VALIDATOR, isolatedValidator);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(isolatedPluginRoot, { recursive: true, force: true }));

  const packageJsonPath = path.join(projectRoot, 'package.json');
  const result = spawnSync(process.execPath, [isolatedValidator], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: {
        content: fs.readFileSync(packageJsonPath, 'utf8'),
        file_path: packageJsonPath,
        validation_mode: 'explicit-mobile-workflow',
      },
    }),
  });

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /unable to load native dependency allowlist/);
});
