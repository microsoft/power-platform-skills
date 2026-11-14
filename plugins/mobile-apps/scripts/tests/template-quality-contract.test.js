'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('node:vm');
const { createSkillDataModelFirst, createSkillWorkflow } = require('./helpers/create-skill');
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
  for (const scriptName of ['dev', 'predev']) {
    assert.strictEqual(typeof packageJson.scripts?.[scriptName], 'string');
    assert.ok(packageJson.scripts[scriptName].trim(), `scripts.${scriptName} must not be empty`);
  }
  assert.strictEqual(packageJson.dependencies['expo-media-library'], undefined);
  assert.strictEqual(packageJson.dependencies['expo-modules-core'], undefined);
  assert.strictEqual(packageJson.devDependencies['@microsoft/power-apps-cli'], '0.15.3');
  // Step 12 runs `npx --no-install qrcode`, so the QR generator must come from this pin.
  assert.strictEqual(packageJson.devDependencies.qrcode, '1.5.4');
  assert.strictEqual(packageJson.overrides.metro, '0.83.8');
  assert.strictEqual(packageJson.scripts['bundle:android'], 'build-codegen-package android');
  assert.strictEqual(packageJson.scripts['bundle:ios'], 'build-codegen-package ios');
});

test('create flow keeps host theme foregrounds aligned with Tamagui brand accents', () => {
  const integration = read('skills/design-system/references/tamagui-integration.md');
  for (const skill of [createSkillWorkflow(), createSkillDataModelFirst()]) {
    assert.match(skill, /appLightTheme/);
    assert.match(skill, /appDarkTheme/);
    assert.match(skill, /accentOnAccent:\s*appLightTheme\.accentOnAccent/);
    assert.match(skill, /accentOnAccent:\s*appDarkTheme\.accentOnAccent/);
    assert.match(skill, /surface4:\s*appLightTheme\.color6/);
    assert.match(skill, /surface4:\s*appDarkTheme\.color6/);
    assert.doesNotMatch(skill, /function parseColorChannels/);
  }
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

test('Tamagui text-control guidance uses the cross-platform string callback', () => {
  const textControlGuidance = [
    'agents/screen-builder.md',
    'shared/references/tamagui-component-recipes.md',
    'shared/references/universal-patterns.md',
    'shared/samples/screen-form.tsx',
    'shared/samples/screen-list.tsx',
  ].map(read).join('\n');

  assert.match(textControlGuidance, /onChangeText/);
  assert.doesNotMatch(textControlGuidance, /event\.target\?\.value/);
  assert.doesNotMatch(textControlGuidance, /event\.nativeEvent\?\.text/);
});

test('template path aliases are inherited from the host tsconfig', () => {
  const tsconfig = JSON.parse(read('template/tsconfig.json'));
  assert.strictEqual(tsconfig.extends, '@microsoft/power-apps-native-host/config/tsconfig');
  assert.strictEqual(tsconfig.compilerOptions, undefined);
});

test('daysFromToday returns the local calendar date, not the UTC one', () => {
  // Screens compare sample dates with the device's local "today". Run the helper in a UTC+10 zone at
  // 00:30 local time, when the UTC date is still yesterday. core.ts is TypeScript, so its plain-JS
  // body is lifted out with its two type annotations removed.
  const source = read('shared/samples/src/hooks/data/core.ts');
  const fn = /export function daysFromToday\(days: number\): string \{[\s\S]*?\n\}/.exec(source);
  assert.ok(fn, 'core.ts defines daysFromToday');
  const js = fn[0].replace(/^export /, '').replace(/: (?:number|string)\b/g, '');
  const probe = `
    const RealDate = Date;
    const now = new RealDate(2026, 10, 12, 0, 30).getTime();
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } };
    ${js}
    process.stdout.write(JSON.stringify([daysFromToday(0), daysFromToday(1), daysFromToday(-1)]));`;
  const run = spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Australia/Brisbane' },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), ['2026-11-12', '2026-11-13', '2026-11-11']);
});

test('the mock source recomputes a reference display value on update, not only on create', async (t) => {
  // A screen edits a record's reference (`siteId`) and then shows and searches its display value
  // (`siteName`). Computed only when the record is created, the old name kept showing after the
  // edit. This runs the shipped createMockSource itself: Node's own type stripping turns core.ts
  // into JavaScript, so the test exercises the code builders copy, not a re-typed imitation.
  const { stripTypeScriptTypes } = require('node:module');
  if (typeof stripTypeScriptTypes !== 'function') {
    t.skip('this Node version cannot strip TypeScript types; covered on the Node 22 CI jobs');
    return;
  }
  const source = read('shared/samples/src/hooks/data/core.ts')
    // The React hooks at the bottom are not exercised here, so their imports become empty stubs.
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({ setTimeout });
  vm.runInContext(`${stripTypeScriptTypes(source)}\nthis.createMockSource = createMockSource;`, context);

  const sites = [{ id: 's1', name: 'North yard' }, { id: 's2', name: 'South dock' }];
  const sample = context.createMockSource(
    [{ id: 'i1', title: 'Crane check', siteId: 's1', siteName: 'North yard' }],
    {
      searchFields: ['title', 'siteName'],
      latencyMs: 0,
      derive: (record) => ({ ...record, siteName: sites.find((site) => site.id === record.siteId)?.name ?? '' }),
    },
  );

  const created = await sample.create({ title: 'Dock survey', siteId: 's2' });
  assert.strictEqual(created.siteName, 'South dock', 'create fills the display value');

  const updated = await sample.update('i1', { siteId: 's2' });
  assert.strictEqual(updated.siteName, 'South dock', 'update recomputes it from the new reference');
  assert.strictEqual((await sample.get('i1')).siteName, 'South dock', 'and stores the recomputed record');
  const { items } = await sample.list({ pageSize: 10, search: 'north' });
  assert.strictEqual(items.length, 0, 'search no longer finds the old name');
});
