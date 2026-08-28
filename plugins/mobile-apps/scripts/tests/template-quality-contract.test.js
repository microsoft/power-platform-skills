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

test('base Tamagui config exposes the complete generated-screen semantic contract', () => {
  const config = read('template/tamagui.config.ts');
  const tokens = [
    'surface0', 'surface1', 'surface2', 'surface3', 'mediaSurface',
    'accentDeep', 'accentBase', 'accentSoft', 'accentOnAccent',
    'text0', 'text1', 'text2', 'text3',
    'statusComplete', 'statusCompleteBg',
    'statusPending', 'statusPendingBg',
    'statusOverdue', 'statusOverdueBg',
    'statusInProgress', 'statusInProgressBg',
    'statusDraft', 'statusDraftBg',
    'statusCancelled', 'statusCancelledBg',
  ];
  for (const token of tokens) assert.match(config, new RegExp(`\\b${token}:`));
  assert.match(config, /mono:\s*defaultConfig\.fonts\.body/);
  assert.match(config, /declare module '@tamagui\/core'/);
  assert.doesNotMatch(config, /declare module 'tamagui'/);
});

test('shipped routes own safe-area edges and avoid forbidden icons and raw hex colors', () => {
  for (const relativePath of [
    'template/app/(app)/home.tsx',
    'template/app/login.tsx',
    'template/app/oauth-callback.tsx',
  ]) {
    const source = read(relativePath);
    assert.match(source, /SafeAreaView/);
    assert.doesNotMatch(source, /MaterialCommunityIcons/);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/);
  }
  const callback = read('template/app/oauth-callback.tsx');
  assert.match(callback, /didNavigate\.current/);
  assert.strictEqual(hasNavigationTapGuard(callback), true);
});

test('navigation guard detection rejects unrelated and permanent reusable refs', () => {
  const unrelatedRef = `
    const didLoad = useRef(false);
    if (didLoad.current) return;
    didLoad.current = true;
    router.push('/details');
  `;
  assert.strictEqual(hasNavigationTapGuard(unrelatedRef), false);

  const permanentPushLock = `
    const isNavigatingRef = useRef(false);
    if (isNavigatingRef.current) return;
    isNavigatingRef.current = true;
    router.push('/details');
  `;
  assert.strictEqual(hasNavigationTapGuard(permanentPushLock), false);

  const reusableLock = `
    const isNavigatingRef = useRef(false);
    if (isNavigatingRef.current) return;
    isNavigatingRef.current = true;
    try {
      router.navigate('/details');
    } finally {
      isNavigatingRef.current = false;
    }
  `;
  assert.strictEqual(hasNavigationTapGuard(reusableLock), true);
});

test('root runtime owns context but not route content edges', () => {
  const layout = read('template/app/_layout.tsx');
  assert.match(layout, /<SafeAreaProvider>/);
  assert.match(layout, /offlineProfile=\{offlineProfile\}/);
  assert.match(layout, /defaultTheme=/);
  assert.match(layout, /theme=\{lightTheme\}/);
  assert.match(layout, /darkTheme=\{darkTheme\}/);
  assert.doesNotMatch(layout, /SafeAreaView/);
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

test('template path aliases do not depend on deprecated baseUrl', () => {
  const tsconfig = JSON.parse(read('template/tsconfig.json'));
  assert.ok(!Object.hasOwn(tsconfig.compilerOptions, 'baseUrl'));
  for (const alias of [
    '@/components', '@/components/*',
    '@/hooks', '@/hooks/*',
    '@/utils', '@/utils/*',
    '@/tokens', '@/tokens/*',
    '@/generated', '@/generated/*',
    '@/native', '@/native/*',
  ]) {
    assert.ok(tsconfig.compilerOptions.paths[alias], alias);
  }
});

test('Dataverse manifest includes reuse-only app data sources for offline planning', () => {
  const addDataverse = read('skills/add-dataverse/SKILL.md');
  assert.match(
    addDataverse,
    /Include every app-used\/service-required table confirmed in Step 6c/,
  );
  assert.match(addDataverse, /Reused tables use `status: "reused"`/);
  assert.doesNotMatch(addDataverse, /Do NOT include tables reused with no schema changes/);
});
