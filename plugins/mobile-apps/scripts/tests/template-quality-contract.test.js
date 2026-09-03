'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  hasNavigationTapGuard,
} = require('../../hooks/validate-navigation-idempotency');

const pluginRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('base Tamagui config inherits the generated-screen semantic contract from the host', () => {
  const config = read('template/tamagui.config.ts');
  assert.match(config, /createPowerAppsTamaguiConfig/);
  assert.match(config, /const customConfig = \{\}/);
  assert.match(config, /declare module 'tamagui'/);
  assert.doesNotMatch(config, /createTamagui|withSemanticAliases|parseColorChannels/);
});

test('shipped routes own safe-area edges and avoid forbidden icons and raw hex colors', () => {
  for (const relativePath of [
    'template/app/(app)/home.tsx',
    'template/app/login.tsx',
    'template/app/oauth-callback.tsx',
  ]) {
    const source = read(relativePath);
    assert.match(source, /SafeAreaView/);
    assert.match(source, /backgroundColor:\s*theme\.surface0\.val/);
    assert.doesNotMatch(source, /MaterialCommunityIcons/);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/);
  }
  const callback = read('template/app/oauth-callback.tsx');
  assert.match(callback, /didNavigate\.current/);
  assert.strictEqual(hasNavigationTapGuard(callback), true);
});

test('navigation ref guards must reset unless the route performs a terminal replace', () => {
  const reusableNavigation = `
    const didNavigate = useRef(false);
    if (didNavigate.current) return;
    didNavigate.current = true;
    router.navigate('/details');
  `;
  const resettableNavigation = `
    const didNavigate = useRef(false);
    if (didNavigate.current) return;
    didNavigate.current = true;
    try {
      router.navigate('/details');
    } catch {
      didNavigate.current = false;
    }
  `;

  assert.strictEqual(hasNavigationTapGuard(reusableNavigation), false);
  assert.strictEqual(hasNavigationTapGuard(resettableNavigation), true);
});

test('root runtime owns context but not route content edges', () => {
  const layout = read('template/app/_layout.tsx');
  assert.match(layout, /<SafeAreaProvider>/);
  assert.match(layout, /appConfig=\{appConfig\}/);
  assert.match(layout, /offlineProfile=\{offlineProfile\}/);
  assert.match(layout, /defaultTheme=/);
  assert.doesNotMatch(layout, /theme=\{lightTheme\}/);
  assert.doesNotMatch(layout, /darkTheme=\{darkTheme\}/);
  assert.doesNotMatch(layout, /SafeAreaView/);
});

test('native configuration follows the system light or dark appearance', () => {
  const config = read('template/app.config.js');
  assert.match(config, /createPowerAppsExpoConfig/);
  assert.doesNotMatch(config, /userInterfaceStyle:\s*'automatic'/);
});

test('Babel and Metro configuration are delegated to native-host factories', () => {
  assert.match(read('template/babel.config.js'), /createPowerAppsBabelConfig/);
  assert.match(read('template/metro.config.js'), /createPowerAppsMetroConfig/);
  assert.doesNotMatch(read('template/metro.config.js'), /power-apps-native-host\/metro-logger/);
});

test('bundled dependencies match the current host-factory template boundary', () => {
  const packageJson = JSON.parse(read('template/package.json'));
  assert.strictEqual(packageJson.dependencies['@microsoft/power-apps-native-host'], '^0.3.3');
  assert.strictEqual(packageJson.dependencies['expo-media-library'], undefined);
  assert.strictEqual(packageJson.dependencies['expo-modules-core'], undefined);
  assert.strictEqual(packageJson.devDependencies['@microsoft/power-apps-cli'], '0.15.3');
  assert.strictEqual(packageJson.overrides.metro, '0.83.8');
  assert.strictEqual(packageJson.scripts['bundle:android'], 'build-codegen-package android');
  assert.strictEqual(packageJson.scripts['bundle:ios'], 'build-codegen-package ios');
});

test('create flow keeps host theme foregrounds aligned with Tamagui brand accents', () => {
  const skill = read('skills/create-mobile-app/SKILL.md');
  const integration = read('skills/design-system/references/tamagui-integration.md');
  assert.match(skill, /appLightTheme/);
  assert.match(skill, /appDarkTheme/);
  assert.match(skill, /accentOnAccent:\s*appLightTheme\.accentOnAccent/);
  assert.match(skill, /accentOnAccent:\s*appDarkTheme\.accentOnAccent/);
  assert.match(skill, /surface4:\s*appLightTheme\.color6/);
  assert.match(skill, /surface4:\s*appDarkTheme\.color6/);
  assert.doesNotMatch(skill, /function parseColorChannels/);
  assert.match(integration, /createPowerAppsTamaguiConfig/);
  assert.match(integration, /withPowerAppsSemanticAliases/);
  assert.match(integration, /export const appLightTheme/);
  assert.match(integration, /export const appDarkTheme/);
  assert.doesNotMatch(integration, /function parseColorChannels/);
});

test('shared components preserve token literals and accessible row selection semantics', () => {
  const components = read('shared/samples/src/components/index.tsx');
  assert.match(components, /as const satisfies Record<StatusVariant/);
  assert.match(components, /aria-pressed=\{selected\}/);
  assert.match(components, /role="button"/);
  assert.match(components, /minH=\{48\}/);
  assert.match(components, /\$accentOnAccent/);
  assert.doesNotMatch(components, /Button\.Text color="\$color1"/);
  assert.doesNotMatch(components, /<Ionicons[^>]*color="\$[A-Za-z]/);
});

test('template path aliases are inherited from the host tsconfig', () => {
  const tsconfig = JSON.parse(read('template/tsconfig.json'));
  assert.strictEqual(tsconfig.extends, '@microsoft/power-apps-native-host/config/tsconfig');
  assert.strictEqual(tsconfig.compilerOptions, undefined);
});
