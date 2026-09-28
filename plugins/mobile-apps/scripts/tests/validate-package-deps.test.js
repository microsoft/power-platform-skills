'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DISPATCHER = path.resolve(__dirname, '..', 'validate-mobile-files.js');
const VALIDATOR = path.resolve(__dirname, '..', '..', 'hooks', 'validate-package-deps.js');
const CONTROL_POLICY = fs.readFileSync(
  path.resolve(__dirname, '../../skills/add-native/references/oob-controls.md'), 'utf8',
);

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

function validateControlPolicy(t, policy, packageName = '@microsoft/power-apps-native-pdf-viewer') {
  const projectRoot = makeProject(packageName, '0.2.9');
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-control-policy-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(pluginRoot, { recursive: true, force: true }));
  const validator = path.join(pluginRoot, 'hooks', 'validate-package-deps.js');
  fs.mkdirSync(path.dirname(validator), { recursive: true });
  fs.copyFileSync(VALIDATOR, validator);
  fs.mkdirSync(path.join(pluginRoot, 'template'));
  fs.writeFileSync(path.join(pluginRoot, 'template', 'package.json'), JSON.stringify({ dependencies: {} }));
  if (policy !== null) {
    const policyPath = path.join(pluginRoot, 'skills', 'add-native', 'references', 'oob-controls.md');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, policy);
  }
  return spawnSync(process.execPath, [validator], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(projectRoot, 'package.json'),
        validation_mode: 'explicit-mobile-workflow',
      },
    }),
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

for (const [packageName, version] of [
  ['@microsoft/power-apps-native-pdf-viewer', '^0.2.9'],
  ['@microsoft/power-apps-native-pen-input', '^0.1.9'],
  ['@microsoft/power-apps-native-barcode-scanner', '^1.1.4'],
  ['@microsoft/power-apps-native-bglocation', '*'],
]) {
  test(`allows the on-demand Microsoft control ${packageName} without a JS-only exception`, (t) => {
    const projectRoot = makeProject(packageName, version);
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const result = validate(projectRoot);

    assert.strictEqual(result.status, 0, result.stderr);
  });
}

test('OOB eligibility uses package names, not default specs or minimum version matching', (t) => {
  const projectRoot = makeProject('@microsoft/power-apps-native-pdf-viewer');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const packageNames = [
    '@microsoft/power-apps-native-pdf-viewer',
    '@microsoft/power-apps-native-pen-input',
    '@microsoft/power-apps-native-barcode-scanner',
    '@microsoft/power-apps-native-bglocation',
  ];
  for (const version of ['0.0.1', '9.0.0', '^2.1.0', '~0.2.9', '*', '1.0.0-beta.1']) {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'fixture',
      dependencies: Object.fromEntries(packageNames.map((name) => [name, version])),
    }));
    const result = validate(projectRoot);
    assert.strictEqual(result.status, 0, `${version}: ${result.stderr}`);
  }
});

for (const packageName of [
  '@microsoft/power-apps-native-unlisted-control',
  '@microsoft/power-apps-native-pdf-viewer-extra',
  'expo-notifications',
  'react-native-vision-camera',
]) {
  test(`keeps ${packageName} blocked even with a supported control and JS approval`, (t) => {
    const projectRoot = makeProject(packageName);
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    pkg.dependencies['@microsoft/power-apps-native-pdf-viewer'] = '0.2.9';
    fs.writeFileSync(packageJsonPath, JSON.stringify(pkg));

    const result = validate(projectRoot, [`${packageName}@1.0.0`]);

    assert.strictEqual(result.status, 2);
    assert.ok(result.stderr.includes(`Native/runtime dependency \`${packageName}\``), result.stderr);
  });
}

test('preserves template-shipped Microsoft host and offline dependencies', (t) => {
  const projectRoot = makeProject('@microsoft/power-apps-native-host', '^0.4.0');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  pkg.dependencies['@microsoft/power-apps-native-offline'] = '^0.1.32';
  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg));

  const result = validate(projectRoot);

  assert.strictEqual(result.status, 0, result.stderr);
});

test('adding a control row to the canonical Markdown allows it without validator changes', (t) => {
  const packageName = '@microsoft/power-apps-native-future-control';
  const proseOnly = `${CONTROL_POLICY}\nExample package: ${packageName}\n`;
  const blocked = validateControlPolicy(t, proseOnly, packageName);
  assert.strictEqual(blocked.status, 2);
  assert.match(blocked.stderr, /Native\/runtime dependency/);

  const withRow = proseOnly.replace(
    '<!-- microsoft-native-controls:end -->',
    `| Future control use case | \`future-control\` | \`${packageName}\` | \`1.0.0\` | \`add-future-control\` |\n<!-- microsoft-native-controls:end -->`,
  );
  const allowed = validateControlPolicy(t, withRow, packageName);
  assert.strictEqual(allowed.status, 0, allowed.stderr);
});

test('removing a control row revokes its exception even if prose still names the package', (t) => {
  const withoutViewer = CONTROL_POLICY.replace(/^\| Open or preview.*\n/m, '');
  const result = validateControlPolicy(t, withoutViewer);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Native\/runtime dependency/);
});

test('accepts CRLF line endings in the canonical control table', (t) => {
  const result = validateControlPolicy(t, CONTROL_POLICY.replace(/\r?\n/g, '\r\n'));
  assert.strictEqual(result.status, 0, result.stderr);
});

for (const [label, policy] of [
  ['missing file', null],
  ['missing markers', CONTROL_POLICY.replace(/<!-- microsoft-native-controls:(?:start|end) -->/g, '')],
  ['duplicate table', `${CONTROL_POLICY}\n${CONTROL_POLICY}`],
  ['empty table', CONTROL_POLICY.replace(/^\| (?:Open or preview|Capture a signature|Explicitly requested|Continuous or background).*\n/gm, '')],
  ['wrong header', CONTROL_POLICY.replace('| Use case |', '| Scenario |')],
  ['empty use case', CONTROL_POLICY.replace('Open or preview an HTTPS or local file PDF', ' ')],
  ['wildcard package', CONTROL_POLICY.replace('`@microsoft/power-apps-native-pdf-viewer`', '`@microsoft/power-apps-native-*`')],
  ['foreign namespace', CONTROL_POLICY.replace('`@microsoft/power-apps-native-pdf-viewer`', '`@example/pdf-viewer`')],
  ['unsupported dependency spec', CONTROL_POLICY.replace('`^0.2.9`', '`file:./vendor.tgz`')],
  ['duplicate package', CONTROL_POLICY.replace('`@microsoft/power-apps-native-pen-input`', '`@microsoft/power-apps-native-pdf-viewer`')],
  ['duplicate capability', CONTROL_POLICY.replace('`pen-input`', '`pdf-viewer`')],
  ['duplicate helper', CONTROL_POLICY.replace('`add-pen-input`', '`add-pdf-viewer`')],
]) {
  test(`fails closed when the Microsoft control policy has a ${label}`, (t) => {
    const result = validateControlPolicy(t, policy);
    assert.strictEqual(result.status, 2, result.stderr);
    assert.match(result.stderr, /unable to load native dependency allowlist/);
    assert.match(result.stderr, /oob-controls\.md/);
  });
}

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
