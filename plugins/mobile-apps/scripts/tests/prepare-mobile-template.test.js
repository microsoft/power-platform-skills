'use strict';

const assert = require('assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const test = require('node:test');

const {
  HOST_TSCONFIG,
  assertFreshTemplate,
  prepareMobileTemplate,
  prepareRootLayout,
} = require('../prepare-mobile-template');

const pluginRoot = path.resolve(__dirname, '../..');
const templateRoot = path.join(pluginRoot, 'template');
const guidanceFiles = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];
const fixtureDirectories = [];

test.after(() => {
  for (const directory of fixtureDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(name) {
  const directory = fs.mkdtempSync(path.join(__dirname, `.${name}-`));
  fixtureDirectories.push(directory);
  return directory;
}

function copyTemplate() {
  const projectRoot = tempDirectory('mobile-template');
  fs.cpSync(templateRoot, projectRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'expo'), { recursive: true });
  return projectRoot;
}

function loadAppConfig(configPath) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === '@microsoft/power-apps-native-host/config/expoConfig') {
      return {
        createPowerAppsExpoConfig(baseConfig, settings, customize) {
          return customize({
            ...baseConfig,
            name: settings.name,
            slug: settings.slug,
          });
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(configPath)];
    return require(configPath);
  } finally {
    Module._load = originalLoad;
  }
}

function fileSnapshot(projectRoot) {
  const snapshot = new Map();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else snapshot.set(path.relative(projectRoot, absolutePath), fs.readFileSync(absolutePath));
    }
  }
  visit(projectRoot);
  return snapshot;
}

function assertSnapshotsEqual(left, right) {
  assert.deepStrictEqual([...left.keys()].sort(), [...right.keys()].sort());
  for (const [relativePath, content] of left) {
    assert.deepStrictEqual(right.get(relativePath), content, relativePath);
  }
}

function removeGuidance(projectRoot) {
  for (const relativePath of guidanceFiles) {
    fs.unlinkSync(path.join(projectRoot, relativePath));
  }
}

const guidanceOptions = { displayName: 'Guidance App', slug: 'guidance-app' };

test('preparation adds only missing guidance and reports exact writer ownership', () => {
  const projectRoot = copyTemplate();
  removeGuidance(projectRoot);
  fs.rmdirSync(path.join(projectRoot, '.github'));
  const before = fileSnapshot(projectRoot);
  const result = prepareMobileTemplate({ workingDir: projectRoot, ...guidanceOptions });
  const after = fileSnapshot(projectRoot);

  assert.deepStrictEqual(result.copiedGuidanceFiles, guidanceFiles);
  assert.deepStrictEqual(result.preservedGuidanceFiles, []);
  assert.deepStrictEqual(result.writtenFiles, [...after]
    .filter(([name, content]) => !before.has(name) || !content.equals(before.get(name)))
    .map(([name]) => name.split(path.sep).join('/'))
    .sort());
  for (const relativePath of guidanceFiles) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(projectRoot, relativePath)),
      fs.readFileSync(path.join(templateRoot, relativePath)),
    );
    assert.ok(result.writtenFiles.includes(relativePath));
  }

  const repeated = prepareMobileTemplate({ workingDir: projectRoot, ...guidanceOptions });
  assert.deepStrictEqual(repeated.writtenFiles, []);
  assert.deepStrictEqual(repeated.copiedGuidanceFiles, []);
  assert.deepStrictEqual(repeated.preservedGuidanceFiles, guidanceFiles);
  assertSnapshotsEqual(after, fileSnapshot(projectRoot));
});

test('preparation preserves customer guidance bytes and fills a partial set', () => {
  const projectRoot = copyTemplate();
  const customAgents = Buffer.from('\ufeff# Customer rules\r\nPreserve exactly.\r\n');
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), customAgents);
  fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '');
  fs.unlinkSync(path.join(projectRoot, '.github', 'copilot-instructions.md'));
  const unrelated = path.join(projectRoot, '.github', 'customer.txt');
  fs.writeFileSync(unrelated, 'customer-owned\n');

  const result = prepareMobileTemplate({ workingDir: projectRoot, ...guidanceOptions });
  assert.deepStrictEqual(result.copiedGuidanceFiles, ['.github/copilot-instructions.md']);
  assert.deepStrictEqual(result.preservedGuidanceFiles, ['AGENTS.md', 'CLAUDE.md']);
  assert.deepStrictEqual(fs.readFileSync(path.join(projectRoot, 'AGENTS.md')), customAgents);
  assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8'), '');
  assert.strictEqual(fs.readFileSync(unrelated, 'utf8'), 'customer-owned\n');
  assert.ok(!result.writtenFiles.includes('AGENTS.md'));
  assert.ok(!result.writtenFiles.includes('CLAUDE.md'));
  assert.deepStrictEqual(
    fs.readFileSync(path.join(projectRoot, '.github', 'copilot-instructions.md')),
    fs.readFileSync(path.join(templateRoot, '.github', 'copilot-instructions.md')),
  );
});

test('preparation preserves all existing customer guidance byte-for-byte', () => {
  const projectRoot = copyTemplate();
  for (const relativePath of guidanceFiles) {
    fs.writeFileSync(path.join(projectRoot, relativePath), `Customer: ${relativePath}\r\n`);
  }
  const before = fileSnapshot(projectRoot);
  const result = prepareMobileTemplate({ workingDir: projectRoot, ...guidanceOptions });
  assert.deepStrictEqual(result.copiedGuidanceFiles, []);
  assert.deepStrictEqual(result.preservedGuidanceFiles, guidanceFiles);
  for (const relativePath of guidanceFiles) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(projectRoot, relativePath)),
      before.get(relativePath.split('/').join(path.sep)),
    );
    assert.ok(!result.writtenFiles.includes(relativePath));
  }
});

for (const keepParent of [false, true]) {
  test(`guidance rollback restores missing files and ${keepParent ? 'preserves' : 'removes new'} parent`, () => {
    const projectRoot = copyTemplate();
    removeGuidance(projectRoot);
    if (!keepParent) fs.rmdirSync(path.join(projectRoot, '.github'));
    // The error occurs after guidance copying, so rollback must undo real writes.
    const layoutPath = path.join(projectRoot, 'app', '_layout.tsx');
    fs.writeFileSync(layoutPath, fs.readFileSync(layoutPath, 'utf8')
      .replace('<Slot />', '<SafeAreaView><Slot /></SafeAreaView>'));
    const before = fileSnapshot(projectRoot);
    assert.throws(() => prepareMobileTemplate({
      workingDir: projectRoot, ...guidanceOptions,
    }), /must not wrap Slot with SafeAreaView/);
    assertSnapshotsEqual(before, fileSnapshot(projectRoot));
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.github')), keepParent);
  });
}

test('guidance rollback preserves custom files and unrelated parent contents', () => {
  const projectRoot = copyTemplate();
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'Customer-owned\r\n');
  fs.unlinkSync(path.join(projectRoot, 'CLAUDE.md'));
  fs.unlinkSync(path.join(projectRoot, '.github', 'copilot-instructions.md'));
  fs.writeFileSync(path.join(projectRoot, '.github', 'customer.txt'), 'Keep me\n');
  const layoutPath = path.join(projectRoot, 'app', '_layout.tsx');
  fs.writeFileSync(layoutPath, fs.readFileSync(layoutPath, 'utf8')
    .replace('<Slot />', '<SafeAreaView><Slot /></SafeAreaView>'));
  const before = fileSnapshot(projectRoot);
  assert.throws(() => prepareMobileTemplate({
    workingDir: projectRoot, ...guidanceOptions,
  }), /must not wrap Slot with SafeAreaView/);
  assertSnapshotsEqual(before, fileSnapshot(projectRoot));
});

test('exclusive guidance creation and rollback do not claim a concurrent customer write', (t) => {
  const projectRoot = copyTemplate();
  removeGuidance(projectRoot);
  const before = fileSnapshot(projectRoot);
  const customerPath = path.join(projectRoot, 'CLAUDE.md');
  const originalCopy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
    if (destination === customerPath) fs.writeFileSync(customerPath, 'Concurrent customer rules\n');
    return originalCopy(source, destination, flags);
  });
  assert.throws(() => prepareMobileTemplate({
    workingDir: projectRoot, ...guidanceOptions,
  }), { code: 'EEXIST' });
  before.set('CLAUDE.md', Buffer.from('Concurrent customer rules\n'));
  assertSnapshotsEqual(before, fileSnapshot(projectRoot));
  assert.ok(fs.statSync(path.join(projectRoot, '.github')).isDirectory());
});

test('guidance rollback retains new parent directories containing unrelated customer files', (t) => {
  const projectRoot = copyTemplate();
  removeGuidance(projectRoot);
  fs.rmdirSync(path.join(projectRoot, '.github'));
  const before = fileSnapshot(projectRoot);
  const copilotPath = path.join(projectRoot, '.github', 'copilot-instructions.md');
  const originalCopy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
    if (destination === copilotPath) {
      fs.writeFileSync(path.join(projectRoot, '.github', 'customer.txt'), 'Concurrent customer file\n');
      throw new Error('Simulated guidance copy failure');
    }
    return originalCopy(source, destination, flags);
  });
  assert.throws(() => prepareMobileTemplate({
    workingDir: projectRoot, ...guidanceOptions,
  }), /Simulated guidance copy failure/);
  before.set(path.join('.github', 'customer.txt'), Buffer.from('Concurrent customer file\n'));
  assertSnapshotsEqual(before, fileSnapshot(projectRoot));
});

test('preparation rejects a symlinked project root without mutations', (t) => {
  const projectRoot = copyTemplate();
  const before = fileSnapshot(projectRoot);
  const link = path.join(tempDirectory('guidance-project-link'), 'app');
  try {
    fs.symlinkSync(projectRoot, link, 'junction');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('Symlink creation is unavailable on this host');
    return;
  }
  assert.throws(() => prepareMobileTemplate({
    workingDir: link, ...guidanceOptions,
  }), /must not traverse a symlink: project root/);
  assertSnapshotsEqual(before, fileSnapshot(projectRoot));
});

for (const relativePath of [...guidanceFiles, '.github']) {
  for (const dangling of [false, true]) {
    test(`preparation rejects ${dangling ? 'dangling ' : ''}guidance symlink ${relativePath}`, (t) => {
      const projectRoot = copyTemplate();
      const externalRoot = tempDirectory('guidance-link-target');
      const targetIsDirectory = relativePath === '.github';
      const target = path.join(externalRoot, targetIsDirectory ? 'instructions' : 'rules.md');
      if (!dangling) {
        if (targetIsDirectory) fs.mkdirSync(target);
        else fs.writeFileSync(target, 'External rules\n');
      }
      const link = path.join(projectRoot, relativePath);
      fs.rmSync(link, { recursive: true });
      const before = fileSnapshot(projectRoot);
      const externalBefore = fileSnapshot(externalRoot);
      try {
        fs.symlinkSync(target, link, targetIsDirectory ? 'junction' : 'file');
      } catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
        t.skip('Symlink creation is unavailable on this host');
        return;
      }
      assert.throws(() => prepareMobileTemplate({
        workingDir: projectRoot, ...guidanceOptions,
      }), /must not traverse a symlink/);
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      fs.unlinkSync(link);
      assertSnapshotsEqual(before, fileSnapshot(projectRoot));
      assertSnapshotsEqual(externalBefore, fileSnapshot(externalRoot));
    });
  }
}

test('preparation rejects a non-directory guidance parent without mutations', () => {
  const projectRoot = copyTemplate();
  fs.rmSync(path.join(projectRoot, '.github'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.github'), 'Customer file\n');
  const before = fileSnapshot(projectRoot);
  assert.throws(() => prepareMobileTemplate({
    workingDir: projectRoot, ...guidanceOptions,
  }), /target must be a directory: \.github/);
  assertSnapshotsEqual(before, fileSnapshot(projectRoot));
});

test('preparation is idempotent and preserves generated and existing helper files', () => {
  const projectRoot = copyTemplate();
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  const originalTsconfig = fs.readFileSync(tsconfigPath);
  const generatedPath = path.join(projectRoot, 'src', 'generated', 'index.ts');
  const existingHelperPath = path.join(projectRoot, 'src', 'components', 'index.tsx');
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.mkdirSync(path.dirname(existingHelperPath), { recursive: true });
  fs.writeFileSync(generatedPath, '// generated-owner sentinel\n');
  fs.writeFileSync(existingHelperPath, '// existing-helper sentinel\n');
  fs.mkdirSync(path.join(projectRoot, 'src', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'hooks', 'useContacts.ts'), '// legacy example\n');
  fs.writeFileSync(path.join(projectRoot, 'power.config.json'), '{"environmentId":""}\n');
  fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), '# Approved plan\n');

  const beforeFirstRun = fileSnapshot(projectRoot);
  const first = prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: "R&D $& Inspector's Workspace",
    slug: 'inspectors-workspace',
  });

  assert.strictEqual(first.removedPowerConfig, true);
  const changedFiles = [...fileSnapshot(projectRoot)]
    .filter(([relativePath, content]) => (
      !beforeFirstRun.has(relativePath) || !content.equals(beforeFirstRun.get(relativePath))
    ))
    .map(([relativePath]) => relativePath.split(path.sep).join('/'))
    .sort();
  assert.deepStrictEqual(first.writtenFiles, changedFiles);
  assert.ok(!first.writtenFiles.includes('power.config.json'));
  assert.ok(!first.writtenFiles.includes('src/hooks/useContacts.ts'));
  assert.ok(first.removedLegacyFiles.includes('src/hooks/useContacts.ts'));
  assert.ok(!first.writtenFiles.includes('src/components/index.tsx'));
  assert.ok(!first.writtenFiles.includes('src/generated/index.ts'));
  assert.deepStrictEqual(fs.readFileSync(generatedPath, 'utf8'), '// generated-owner sentinel\n');
  assert.deepStrictEqual(fs.readFileSync(existingHelperPath, 'utf8'), '// existing-helper sentinel\n');
  assert.deepStrictEqual(
    fs.readFileSync(path.join(projectRoot, 'native-app-plan.md'), 'utf8'),
    '# Approved plan\n',
  );
  assert.match(
    fs.readFileSync(path.join(projectRoot, 'app.config.js'), 'utf8'),
    /R&D \$& Inspector\\'s Workspace/,
  );
  assert.strictEqual(require(path.join(projectRoot, 'package.json')).name, 'inspectors-workspace');

  const tsconfig = require(path.join(projectRoot, 'tsconfig.json'));
  assert.strictEqual(tsconfig.extends, HOST_TSCONFIG);
  assert.strictEqual(tsconfig.compilerOptions, undefined);
  assert.deepStrictEqual(fs.readFileSync(tsconfigPath), originalTsconfig);

  const layout = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  assert.match(layout, /<SafeAreaProvider>/);
  assert.match(layout, /offlineProfile=\{offlineProfile\}/);
  assert.match(layout, /tamaguiConfig=\{tamaguiConfig\}/);
  assert.match(layout, /defaultTheme=/);
  assert.doesNotMatch(layout, /theme=\{lightTheme\}/);
  assert.doesNotMatch(layout, /darkTheme=\{darkTheme\}/);
  assert.doesNotMatch(layout, /<SafeAreaView[\s\S]*<Slot\s*\/>/);
  assert.match(layout, /@ts-ignore - power\.config\.json/);
  assert.match(layout, /@ts-ignore - connectorSchemas/);

  const beforeSecondRun = fileSnapshot(projectRoot);
  const second = prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: "R&D $& Inspector's Workspace",
    slug: 'inspectors-workspace',
  });
  const afterSecondRun = fileSnapshot(projectRoot);
  assert.ok(second.preservedSharedFiles.length > 0);
  assert.deepStrictEqual(second.writtenFiles, []);
  assertSnapshotsEqual(beforeSecondRun, afterSecondRun);
});

test('scaffold validation uses preparation writes, not later generator output', (t) => {
  const projectRoot = copyTemplate();
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const configPath = path.join(projectRoot, 'power.config.json');
  fs.writeFileSync(configPath, '{"environmentId":""}\n');
  const options = { workingDir: projectRoot, displayName: 'Validation App', slug: 'validation-app' };
  const prepared = prepareMobileTemplate(options);
  assert.strictEqual(prepared.removedPowerConfig, true);

  // Simulate init recreating the deleted placeholder and schema generation writing output.
  const generatedConfig = '{"environmentId":"approved-environment","appDisplayName":"Validation App"}\n';
  fs.writeFileSync(configPath, generatedConfig);
  const generatedPath = path.join(projectRoot, 'src', 'generated', 'index.ts');
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, 'export {};\n');
  const repeated = prepareMobileTemplate(options);
  assert.strictEqual(repeated.removedPowerConfig, false);
  assert.deepStrictEqual(repeated.writtenFiles, []);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), generatedConfig);
  fs.writeFileSync(path.join(projectRoot, 'memory-bank.md'), '# Verified scaffold\n');

  function validate(files) {
    return spawnSync(process.execPath, [
      path.join(pluginRoot, 'scripts', 'validate-mobile-files.js'),
      '--project-root', projectRoot,
      ...files.flatMap((file) => ['--file', file]),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
    });
  }

  const manualFiles = [...prepared.writtenFiles, 'memory-bank.md'];
  const valid = validate(manualFiles);
  assert.strictEqual(valid.status, 0, valid.stderr);
  for (const file of ['power.config.json', path.relative(projectRoot, generatedPath)]) {
    const blocked = validate([file]);
    assert.strictEqual(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /BLOCKED: protected path/);
  }

  fs.writeFileSync(configPath, '{"environmentId":"manual-edit"}\n');
  const manualEdit = validate(['power.config.json']);
  assert.strictEqual(manualEdit.status, 2, manualEdit.stderr);
  assert.match(manualEdit.stderr, /owned by `npx power-apps init`/);
});

test('preparation round-trips JavaScript line terminators in app display names', () => {
  const projectRoot = copyTemplate();
  const displayName = "Line 1\nLine 2\rLine 3\u2028Line 4\u2029Inspector's App";
  prepareMobileTemplate({
    workingDir: projectRoot,
    displayName,
    slug: 'line-safe-app',
  });

  const configPath = path.join(projectRoot, 'app.config.js');
  const source = fs.readFileSync(configPath, 'utf8');
  assert.match(source, /Line 1\\nLine 2\\rLine 3\\u2028Line 4\\u2029Inspector\\'s App/);
  const createConfig = loadAppConfig(configPath);
  assert.strictEqual(createConfig({ config: {} }).name, displayName);
});

test('preparation rejects a template that does not inherit the host tsconfig', () => {
  const projectRoot = copyTemplate();
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    extends: 'expo/tsconfig.base',
    compilerOptions: { paths: {} },
  }, null, 2));
  const before = fileSnapshot(projectRoot);

  assert.throws(() => prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: 'Unsupported Template',
    slug: 'unsupported-template',
  }), /must extend @microsoft\/power-apps-native-host\/config\/tsconfig/);

  assertSnapshotsEqual(before, fileSnapshot(projectRoot));
});

test('fresh-template validation allows the approved plan but blocks created-app markers', () => {
  const projectRoot = copyTemplate();
  fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), '# Approved plan\n');
  assert.doesNotThrow(() => assertFreshTemplate(projectRoot));

  fs.writeFileSync(path.join(projectRoot, 'memory-bank.md'), '# Created app\n');
  assert.throws(() => assertFreshTemplate(projectRoot), /memory-bank\.md/);
  fs.unlinkSync(path.join(projectRoot, 'memory-bank.md'));

  fs.writeFileSync(path.join(projectRoot, '.datamodel-manifest.json'), '{}\n');
  assert.throws(() => assertFreshTemplate(projectRoot), /\.datamodel-manifest\.json/);
  fs.unlinkSync(path.join(projectRoot, '.datamodel-manifest.json'));

  const generatedServices = path.join(projectRoot, 'src', 'generated', 'services');
  fs.mkdirSync(generatedServices, { recursive: true });
  fs.writeFileSync(path.join(generatedServices, 'CreatedService.ts'), 'export {};\n');
  assert.throws(() => assertFreshTemplate(projectRoot), /src\/generated\/services\/\*\.ts/);
});

function writeLayoutFixture(source) {
  const projectRoot = tempDirectory('root-layout');
  fs.mkdirSync(path.join(projectRoot, 'app'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'app', '_layout.tsx'), source);
  return projectRoot;
}

const providerBody = `
      <PowerAppsProvider
        msalConfig={authConfig.msal}
        offlineProfile={offlineProfile}
        customHostProp="preserve-me"
      >
        <CustomNavigation>
          <Slot />
        </CustomNavigation>
      </PowerAppsProvider>`;

const fixtureImports = `import { Slot } from 'expo-router';
import { PowerAppsProvider } from '@microsoft/power-apps-native-host';
import authConfig from '../auth.config.json';
import { offlineProfile } from '../offline';
`;

test('root preparation handles import-only safe-area state', () => {
  const projectRoot = writeLayoutFixture(`${fixtureImports}
import { SafeAreaProvider } from 'react-native-safe-area-context';
export default function RootLayout() {
  return (${providerBody}
  );
}
`);
  prepareRootLayout(projectRoot);
  const result = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  assert.match(result, /<SafeAreaProvider>[\s\S]*<PowerAppsProvider/);
  assert.match(result, /customHostProp="preserve-me"/);
  assert.match(result, /<CustomNavigation>/);
});

test('root preparation reuses semicolonless combined, named, and default imports', () => {
  const projectRoot = writeLayoutFixture(`import { Slot } from 'expo-router'
import ReactNative, { useColorScheme } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { PowerAppsProvider } from '@microsoft/power-apps-native-host'
import tamaguiConfig, { appLightTheme } from '../tamagui.config'
import authConfig from '../auth.config.json'
import { offlineProfile } from '../offline'

export default function RootLayout() {
  const colorScheme = useColorScheme()
  return (${providerBody}
  )
}
`);
  prepareRootLayout(projectRoot);
  const result = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');

  assert.strictEqual((result.match(/from ['"]react-native['"]/g) || []).length, 1);
  assert.strictEqual(
    (result.match(/from ['"]react-native-safe-area-context['"]/g) || []).length,
    1,
  );
  assert.strictEqual(
    (result.match(/from ['"]@microsoft\/power-apps-native-host['"]/g) || []).length,
    1,
  );
  assert.strictEqual((result.match(/from ['"]\.\.\/tamagui\.config['"]/g) || []).length, 1);
  assert.match(result, /import tamaguiConfig,\s*\{\s*appLightTheme\s*\}\s*from\s*'\.\.\/tamagui\.config'/s);
  assert.match(result, /import ReactNative,\s*\{[^}]*\buseColorScheme\b[^}]*\}\s*from\s*'react-native'/s);
  assert.doesNotMatch(result, /\blightTheme\b|\bdarkTheme\b/);
  assert.match(result, /<SafeAreaProvider>[\s\S]*<PowerAppsProvider/);
});

test('root preparation creates the required colorScheme binding when the hook uses another name', () => {
  const projectRoot = writeLayoutFixture(`${fixtureImports}
import { useColorScheme } from 'react-native';
export default function RootLayout() {
  const scheme = useColorScheme();
  return (${providerBody}
  );
}
`);
  prepareRootLayout(projectRoot);
  const result = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  assert.match(result, /const scheme = useColorScheme\(\);/);
  assert.match(result, /const colorScheme = useColorScheme\(\);/);
  assert.match(result, /defaultTheme=\{colorScheme === 'dark' \? 'dark' : 'light'\}/);
});

test('root preparation handles wrapper-only and already-correct states idempotently', () => {
  const projectRoot = writeLayoutFixture(`${fixtureImports}
export default function RootLayout() {
  return (
    <SafeAreaProvider>${providerBody}
    </SafeAreaProvider>
  );
}
`);
  prepareRootLayout(projectRoot);
  const first = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  prepareRootLayout(projectRoot);
  const second = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  assert.strictEqual(second, first);
  assert.strictEqual((second.match(/<SafeAreaProvider>/g) || []).length, 1);
  assert.match(second, /offlineProfile=\{offlineProfile\}/);
});

test('root preparation preserves custom outer provider nesting', () => {
  const projectRoot = writeLayoutFixture(`${fixtureImports}
export default function RootLayout() {
  return (
    <TelemetryBoundary>
${providerBody}
    </TelemetryBoundary>
  );
}
`);
  prepareRootLayout(projectRoot);
  const result = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  assert.match(result, /<TelemetryBoundary>[\s\S]*<SafeAreaProvider>[\s\S]*<PowerAppsProvider/);
  assert.match(result, /<\/PowerAppsProvider>[\s\S]*<\/SafeAreaProvider>[\s\S]*<\/TelemetryBoundary>/);
});

test('safe-area wrapping preserves multiline provider prop values byte-for-byte', () => {
  const multilineValue = `customMessage={\`first line
        intentionally indented second line\`}`;
  const multilineProvider = `<PowerAppsProvider
      ${multilineValue}
    >
      <Slot />
    </PowerAppsProvider>`;
  const projectRoot = writeLayoutFixture(`${fixtureImports}
export default function RootLayout() {
  return (
    ${multilineProvider}
  );
}
`);
  prepareRootLayout(projectRoot);
  const result = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  assert.ok(result.includes(multilineValue));
});

test('provider preparation preserves JSX and callback prop values byte-for-byte', () => {
  const jsxValue = 'customHeader={<Header title="A > B" tamaguiConfig={nestedConfig} theme={nestedLight} darkTheme={nestedDark} />}';
  const callbackValue = 'renderHeader={() => <Header compact />}';
  const projectRoot = writeLayoutFixture(`${fixtureImports}
export default function RootLayout() {
  return (
    <PowerAppsProvider
      ${jsxValue}
      ${callbackValue}
    >
      <Slot />
    </PowerAppsProvider>
  );
}
`);
  prepareRootLayout(projectRoot);
  const first = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  assert.ok(first.includes(jsxValue));
  assert.ok(first.includes(callbackValue));
  assert.match(first, /\n\s+tamaguiConfig=\{tamaguiConfig\}\n/);
  assert.doesNotMatch(first, /\n\s+theme=\{lightTheme\}\n/);
  assert.doesNotMatch(first, /\n\s+darkTheme=\{darkTheme\}\n/);
  prepareRootLayout(projectRoot);
  assert.strictEqual(
    fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8'),
    first,
  );
});

test('root preparation rejects a root-owned SafeAreaView around Slot', () => {
  const projectRoot = writeLayoutFixture(`${fixtureImports}
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <PowerAppsProvider tamaguiConfig={tamaguiConfig} defaultTheme="light">
        <SafeAreaView><Slot /></SafeAreaView>
      </PowerAppsProvider>
    </SafeAreaProvider>
  );
}
`);
  assert.throws(() => prepareRootLayout(projectRoot), /must not wrap Slot with SafeAreaView/);
});

test('failed full preparation restores every mutated file', () => {
  const projectRoot = copyTemplate();
  const layoutPath = path.join(projectRoot, 'app', '_layout.tsx');
  const invalidLayout = fs.readFileSync(layoutPath, 'utf8')
    .replace('<Slot />', '<SafeAreaView><Slot /></SafeAreaView>');
  fs.writeFileSync(layoutPath, invalidLayout);
  fs.writeFileSync(path.join(projectRoot, 'power.config.json'), '{"environmentId":""}\n');
  const before = fileSnapshot(projectRoot);

  assert.throws(() => prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: 'Rollback Probe',
    slug: 'rollback-probe',
  }), /must not wrap Slot with SafeAreaView/);

  assertSnapshotsEqual(before, fileSnapshot(projectRoot));
});
