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

function loadReadableForeground(source) {
  const start = source.indexOf('function parseColorChannels');
  const end = source.indexOf('\n}\n\n/**', start);
  assert.ok(start >= 0 && end > start, 'color parsing and readableForeground implementation');
  const javascript = source.slice(start, end + 2)
    .replace('color: string', 'color')
    .replace('background: string | undefined', 'background')
    .replace('fallback: string', 'fallback');
  return Function(`"use strict"; ${javascript}; return readableForeground;`)();
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
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
  assert.match(config, /surface1:\s*brand\.surface \?\? theme\.color3/);
  assert.match(config, /surface2:\s*theme\.color4/);
  assert.match(config, /surface3:\s*brand\.border \?\? theme\.color5/);
  assert.match(config, /accentOnAccent:\s*brand\.onPrimary[\s\S]*readableForeground\(brand\.primary \?\? theme\.blue10/);
  assert.match(config, /luminance > 0\.179 \? '#000000' : '#ffffff'/);
  assert.match(config, /mono:\s*defaultConfig\.fonts\.body/);
  assert.match(config, /declare module '@tamagui\/core'/);
  assert.doesNotMatch(config, /declare module 'tamagui'/);
});

test('accent foregrounds meet WCAG AA for default and representative brand colors', () => {
  const readableForeground = loadReadableForeground(read('template/tamagui.config.ts'));
  for (const [background, normalized] of [
    ['#0588f0', '#0588f0'], // Config v5 light blue10
    ['#3b9eff', '#3b9eff'], // Config v5 dark blue10
    ['hsl(208, 90%, 46%)', '#0c7cdf'],
    ['hsla(208, 90%, 46%, 1)', '#0c7cdf'],
    ['rgb(5, 136, 240)', '#0588f0'],
    ['#ffffff', '#ffffff'],
    ['#000000', '#000000'],
    ['#ffd60a', '#ffd60a'],
    ['#7a1f5c', '#7a1f5c'],
  ]) {
    const foreground = readableForeground(background, '#ffffff');
    assert.ok(
      contrastRatio(foreground, normalized) >= 4.5,
      `${foreground} on ${background}`,
    );
  }
  assert.strictEqual(readableForeground('rgba(0, 0, 0, 0)', '#123456'), '#123456');
  assert.strictEqual(readableForeground('hsla(0, 0%, 0%, 0.5)', '#123456'), '#123456');
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
  assert.match(layout, /offlineProfile=\{offlineProfile\}/);
  assert.match(layout, /defaultTheme=/);
  assert.match(layout, /theme=\{lightTheme\}/);
  assert.match(layout, /darkTheme=\{darkTheme\}/);
  assert.doesNotMatch(layout, /SafeAreaView/);
});

test('native configuration follows the system light or dark appearance', () => {
  const config = read('template/app.config.js');
  assert.match(config, /userInterfaceStyle:\s*'automatic'/);
});

test('create flow keeps host theme foregrounds aligned with Tamagui brand accents', () => {
  const skill = read('skills/create-mobile-app/SKILL.md');
  assert.match(skill, /const brandAccentForeground = readableForeground\(brandTokens\.color\.primary\)/);
  assert.match(skill, /const brandedLightTheme:[\s\S]*accentOnAccent: brandAccentForeground/);
  assert.match(skill, /const brandedDarkTheme:[\s\S]*accentOnAccent: brandAccentForeground/);
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
