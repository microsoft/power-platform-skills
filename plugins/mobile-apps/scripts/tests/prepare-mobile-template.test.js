'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
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

function tempDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
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
  fs.writeFileSync(path.join(projectRoot, 'power.config.json'), '{"environmentId":""}\n');
  fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), '# Approved plan\n');

  const first = prepareMobileTemplate({
    workingDir: projectRoot,
    displayName: "R&D $& Inspector's Workspace",
    slug: 'inspectors-workspace',
  });

  assert.strictEqual(first.removedPowerConfig, true);
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
  assert.match(layout, /theme=\{lightTheme\}/);
  assert.match(layout, /darkTheme=\{darkTheme\}/);
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
  assertSnapshotsEqual(beforeSecondRun, afterSecondRun);
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
import tamaguiConfig from '../tamagui.config'
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
  assert.match(result, /import ReactNative,\s*\{[^}]*\buseColorScheme\b[^}]*\}\s*from\s*'react-native'/s);
  assert.match(result, /import\s*\{[^}]*\blightTheme\b[^}]*\bdarkTheme\b[^}]*\}\s*from\s*'@microsoft\/power-apps-native-host'/s);
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
  assert.match(first, /\n\s+theme=\{lightTheme\}\n/);
  assert.match(first, /\n\s+darkTheme=\{darkTheme\}\n/);
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
