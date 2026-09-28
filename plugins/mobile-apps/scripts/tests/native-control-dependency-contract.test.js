'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
const nativeSkill = read('skills/add-native/SKILL.md');
const controlPolicy = read('skills/add-native/references/oob-controls.md');
const dependencySetup = controlPolicy.split('## Dependency setup\n')[1]?.split('\n## Adding')[0];
const controls = [
  ['add-pdf-viewer', '@microsoft/power-apps-native-pdf-viewer', '^0.2.9'],
  ['add-pen-input', '@microsoft/power-apps-native-pen-input', '^0.1.9'],
  ['add-barcode-scanner', '@microsoft/power-apps-native-barcode-scanner', '^1.1.4'],
  ['add-geolocation', '@microsoft/power-apps-native-bglocation', '*'],
];

test('OOB reference preserves the four requested dependency specs without changing the template', () => {
  assert.ok(dependencySetup);
  const rows = [...controlPolicy.matchAll(/^\| [^|]+ \| `[^`]+` \| `([^`]+)` \| `([^`]+)`/gm)]
    .map(([, name, version]) => [name, version]);
  assert.deepEqual(rows, controls.map(([, name, version]) => [name, version]));
  const template = JSON.parse(read('template/package.json'));
  for (const [, name] of controls) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      assert.equal(template[section]?.[name], undefined);
    }
  }
});

test('shared setup requires a requested control and preserves dependency specs and failure handling', () => {
  assert.match(controlPolicy, /If neither the user's request nor the approved plan requires.*leave `package\.json` and its lockfile unchanged/);
  assert.match(dependencySetup, /plan-only invocation never installs/);
  assert.match(dependencySetup, /Reuse an existing runtime dependency without changing its version/);
  assert.match(controlPolicy, /Eligibility is based on the exact \*\*package name only\*\*/);
  assert.match(dependencySetup, /declared but not installed, stop/);
  assert.match(dependencySetup, /devDependencies.*preserve its compatible declaration and locked version/);
  assert.match(dependencySetup, /otherwise confirm it before installing/);
  assert.match(dependencySetup, /npm view "\$CONTROL_PACKAGE@\$CONTROL_SPEC" version peerDependencies engines --json/);
  assert.match(dependencySetup, /npm pkg set "dependencies\.\$CONTROL_PACKAGE=\$CONTROL_SPEC"\r?\n\s+npm install/);
  assert.match(dependencySetup, /never hand-edit the lockfile/);
  assert.match(dependencySetup, /If the install fails.*stop before generating imports/);
  assert.match(dependencySetup, /npm ls "\$CONTROL_PACKAGE" --depth=0/);
  assert.match(dependencySetup, /scripts\/validate-mobile-files\.js/);
  assert.match(dependencySetup, /--approved-js-dependency/);
  assert.match(dependencySetup, /do \*\*not\*\* verify native availability/);
  assert.match(dependencySetup, /NATIVE_MODULE_MISSING/);
});

for (const [helper, packageName] of controls) {
  test(`${helper} runs shared dependency setup before generating its wrapper`, () => {
    const skill = read(`skills/add-native/${helper}/SKILL.md`);
    const setupIndex = skill.indexOf('${PLUGIN_ROOT}/skills/add-native/references/oob-controls.md');
    assert.ok(setupIndex > 0);
    assert.ok(setupIndex < skill.indexOf('3. Write'), 'setup must precede wrapper generation');
    assert.ok(skill.slice(setupIndex).includes(packageName));
    assert.match(skill, /runtime `dependencies` and update the lockfile/);
    assert.match(skill, /Dependency action/);
    assert.match(skill, /Manifest\/lockfile/);
    assert.match(skill, /Native runtime/);
    assert.doesNotMatch(skill, /This skill will not install it|must already ship the native package|Do not install packages/);
  });
}

test('planning and orchestration allow control additions without granting installers to screen builders', () => {
  for (const relativePath of [
    'AGENTS.md',
    'shared/shared-instructions.md',
    'agents/native-app-planner.md',
    'agents/screen-planner.md',
    'agents/screen-builder.md',
    'skills/create-mobile-app/references/requirements-discovery.md',
    'skills/create-mobile-app/SKILL.md',
    'skills/edit-app/SKILL.md',
    'skills/debug-app/SKILL.md',
    'skills/add-native/SKILL.md',
    'README.md',
  ]) {
    assert.match(read(relativePath), /skills\/add-native\/references\/oob-controls\.md/, relativePath);
  }
  assert.match(read('agents/screen-planner.md'), /Do not install them here or misclassify them as JS-only/);
  assert.match(read('skills/create-mobile-app/SKILL.md'), /Stop on dependency\/setup failure before screen generation/);
  assert.match(read('skills/edit-app/SKILL.md'), /Stop on dependency\/setup failure before rebuilding screens/);
  assert.match(nativeSkill, /any other requested native module isn't present.*STOP/);
  assert.ok(read('skills/add-native/add-camera/SKILL.md').includes('It does not install modules'), 'Camera must remain template-bound');
  assert.match(read('skills/add-native/add-pdf-report/SKILL.md'), /If `expo-print` is missing, STOP/);
});

test('Microsoft scanner requires an explicit request and does not replace Expo scanner aliases', () => {
  assert.match(nativeSkill, /camera\|image-picker\|barcode-scanner\|qr-scanner\).*INTERNAL_HELPER:add-camera/);
  assert.match(nativeSkill, /native-barcode-scanner\).*INTERNAL_HELPER:add-barcode-scanner/);
  assert.match(nativeSkill, /@microsoft\/power-apps-native-barcode-scanner` to `native-barcode-scanner`/);
  assert.match(controlPolicy, /Generic barcode\/QR requests retain the existing/);
  const helper = read('skills/add-native/add-barcode-scanner/SKILL.md');
  assert.match(helper, /BarcodeScannerNative\.scan\(request\)/);
  assert.match(helper, /USER_CANCELLED/);
  assert.match(helper, /NATIVE_MODULE_MISSING/);
  assert.match(helper, /Do not attach a telemetry callback or log decoded barcode values/);
  assert.match(helper, /user-invocable: false/);
  assert.match(helper, /disable-model-invocation: true/);
});

test('PDF helper checks installation without rejecting versions or claiming API support', (t) => {
  const skill = read('skills/add-native/add-pdf-viewer/SKILL.md');
  const match = /^node -e "([^"\r\n]+)"$/m.exec(skill);
  assert.ok(match, 'PDF helper must retain an executable installation check');
  assert.doesNotMatch(match[1], /UNSUPPORTED_VERSION|split|major|minor|patch/);
  assert.match(skill, /Read the installed package's exported types\/documentation/);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-control-version-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const packageName = controls[0][1];
  const installedDirectory = path.join(projectRoot, 'node_modules', packageName);
  const manifestPath = path.join(projectRoot, 'package.json');
  const run = () => spawnSync(process.execPath, ['-e', match[1]], { cwd: projectRoot, encoding: 'utf8' });

  fs.writeFileSync(manifestPath, JSON.stringify({ dependencies: {} }));
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MISSING:/);

  fs.writeFileSync(manifestPath, JSON.stringify({ dependencies: { [packageName]: '0.2.9' } }));
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MISSING_INSTALL:/);

  fs.mkdirSync(installedDirectory, { recursive: true });
  for (const version of ['0.2.8', '0.2.9', '0.2.9+build.1', '0.2.9-beta.1', '0.3.0', '1.0.0']) {
    fs.writeFileSync(path.join(installedDirectory, 'package.json'), JSON.stringify({ name: packageName, version }));
    result = run();
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.match(result.stdout, /PRESENT:.*informational only/);
    assert.doesNotMatch(result.stdout, /supports https:\/\/ and file:\/\//);
  }
});
