'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  REQUIRED_ALIASES,
  prepareMobileTemplate,
  prepareRootLayout,
} = require('../prepare-mobile-template');

const pluginRoot = path.resolve(__dirname, '../..');
const templateRoot = path.join(pluginRoot, 'template');

function tempDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function copyTemplate() {
  const projectRoot = tempDirectory('mobile-template');
  fs.cpSync(templateRoot, projectRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'expo'), { recursive: true });
  return projectRoot;
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

test('preparation is idempotent and preserves generated and existing helper files', () => {
  const projectRoot = copyTemplate();
  const generatedPath = path.join(projectRoot, 'src', 'generated', 'index.ts');
  const existingHelperPath = path.join(projectRoot, 'src', 'components', 'index.tsx');
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.mkdirSync(path.dirname(existingHelperPath), { recursive: true });
  fs.writeFileSync(generatedPath, '// generated-owner sentinel\n');
  fs.writeFileSync(existingHelperPath, '// existing-helper sentinel\n');
  fs.writeFileSync(path.join(projectRoot, 'power.config.json'), '{"environmentId":""}\n');

  const first = prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: "Inspector's Workspace",
    slug: 'inspectors-workspace',
  });

  assert.strictEqual(first.removedPowerConfig, true);
  assert.deepStrictEqual(fs.readFileSync(generatedPath, 'utf8'), '// generated-owner sentinel\n');
  assert.deepStrictEqual(fs.readFileSync(existingHelperPath, 'utf8'), '// existing-helper sentinel\n');
  assert.match(fs.readFileSync(path.join(projectRoot, 'app.config.js'), 'utf8'), /Inspector\\'s Workspace/);
  assert.strictEqual(require(path.join(projectRoot, 'package.json')).name, 'inspectors-workspace');

  const tsconfig = require(path.join(projectRoot, 'tsconfig.json'));
  assert.ok(!Object.hasOwn(tsconfig.compilerOptions, 'baseUrl'));
  for (const [alias, targets] of Object.entries(REQUIRED_ALIASES)) {
    assert.deepStrictEqual(tsconfig.compilerOptions.paths[alias], targets);
  }
  assert.deepStrictEqual(tsconfig.compilerOptions.paths['react-native'], ['./node_modules/react-native']);

  const layout = fs.readFileSync(path.join(projectRoot, 'app', '_layout.tsx'), 'utf8');
  assert.match(layout, /<SafeAreaProvider>/);
  assert.match(layout, /offlineProfile=\{offlineProfile\}/);
  assert.match(layout, /tamaguiConfig=\{tamaguiConfig\}/);
  assert.match(layout, /defaultTheme=/);
  assert.match(layout, /theme=\{lightTheme\}/);
  assert.match(layout, /darkTheme=\{darkTheme\}/);
  assert.doesNotMatch(layout, /<SafeAreaView[\s\S]*<Slot\s*\/>/);
  assert.match(layout, /@ts-ignore - power\.config\.json/);
  assert.match(layout, /@ts-ignore - connectorSchemas/);

  const beforeSecondRun = fileSnapshot(projectRoot);
  const second = prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: "Inspector's Workspace",
    slug: 'inspectors-workspace',
  });
  const afterSecondRun = fileSnapshot(projectRoot);
  assert.ok(second.preservedSharedFiles.length > 0);
  assertSnapshotsEqual(beforeSecondRun, afterSecondRun);
});

test('orchestrated preparation allows only the current planning artifact', () => {
  const projectRoot = copyTemplate();
  fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), '# Approved planning draft\n');

  assert.throws(() => prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: 'Planning Probe',
    slug: 'planning-probe',
  }), /native-app-plan\.md/);

  prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: 'Planning Probe',
    slug: 'planning-probe',
    allowPlanningArtifacts: true,
  });

  assert.strictEqual(
    fs.readFileSync(path.join(projectRoot, 'native-app-plan.md'), 'utf8'),
    '# Approved planning draft\n',
  );
});

test('orchestrated preparation still rejects post-planning mutation markers', () => {
  for (const marker of ['memory-bank.md', '.datamodel-manifest.json']) {
    const projectRoot = copyTemplate();
    fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), '# Planning draft\n');
    fs.writeFileSync(path.join(projectRoot, marker), '{}\n');
    assert.throws(() => prepareMobileTemplate({
      workingDir: projectRoot,
      displayName: 'Mutation Guard',
      slug: 'mutation-guard',
      allowPlanningArtifacts: true,
    }), new RegExp(marker.replace('.', '\\.')));
  }
});

test('preparation upgrades the legacy Tamagui customization block', () => {
  const projectRoot = copyTemplate();
  const configPath = path.join(projectRoot, 'tamagui.config.ts');
  const legacyBlock = `// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Preserve this unrelated line outside the replaced declarations.
const customConfig = {
  ...defaultConfig,
  animations,
};
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT`;
  const current = fs.readFileSync(configPath, 'utf8');
  const legacy = current
    .replace(
      /\/\/ CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT[\s\S]*?\/\/ CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT/,
      legacyBlock,
    )
    .replace("declare module '@tamagui/core' {", "declare module 'tamagui' {");
  fs.writeFileSync(configPath, legacy);

  const result = prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: 'Semantic Baseline',
    slug: 'semantic-baseline',
  });
  const upgraded = fs.readFileSync(configPath, 'utf8');

  assert.strictEqual(result.upgradedTamaguiConfig, true);
  assert.match(upgraded, /function withSemanticAliases/);
  assert.match(upgraded, /accentBase:/);
  assert.match(upgraded, /mono: defaultConfig\.fonts\.body/);
  assert.match(upgraded, /declare module '@tamagui\/core'/);
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

test('root preparation rejects a root-owned SafeAreaView around Slot', () => {
  const projectRoot = writeLayoutFixture(`${fixtureImports}
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <PowerAppsProvider tamaguiConfig={tamaguiConfig} defaultTheme="light" theme={lightTheme} darkTheme={darkTheme}>
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
