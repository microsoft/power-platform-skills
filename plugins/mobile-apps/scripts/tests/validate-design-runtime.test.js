'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { typographyRecipe } = require('../resolve-design-recipe');
const { validateDesignRuntimeSources, validateTypographyRecipe } = require('../validate-design-runtime');

const pluginRoot = path.resolve(__dirname, '..', '..');

function runtimeSources(typography) {
  return {
    tokensSource: `export const tokens = { typography: {
      runtimeStrategy: '${typography.runtimeStrategy}',
      headingFamily: '${typography.headingFamily}',
      bodyFamily: '${typography.bodyFamily}',
      monoFamily: '${typography.monoFamily}',
    }} as const;`,
    configSource: `
      import { createFont } from '@tamagui/core';
      import { Platform } from 'react-native';
      const serif = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' });
      const sans = Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' });
      const headingFont = createFont({ family: serif });
      const bodyFont = createFont({ family: sans });
      const chosen = brandTokens.typography.headingFamily;
      const config = { fonts: { heading: headingFont, body: bodyFont } };
    `,
    runtimeSource: `
      export const Header = () => <Text fontFamily="$heading">Title</Text>;
      export const Copy = () => <Text fontFamily="$body">Copy</Text>;
    `,
  };
}

test('minimal and editorial characters resolve to a no-download platform-safe serif runtime', () => {
  const typography = typographyRecipe('minimal-refined');
  assert.deepEqual(validateTypographyRecipe(typography), []);
  assert.equal(typography.runtimeStrategy, 'platform-safe-editorial');
  assert.equal(typography.headingFamily, 'platform-serif');
  assert.equal(typography.bodyFamily, 'system-sans');
  assert.deepEqual(validateDesignRuntimeSources({ typography }, runtimeSources(typography)), []);
});

test('system typography is valid only when the recipe records the native-system rationale', () => {
  const typography = typographyRecipe('confident-utility');
  assert.equal(typography.runtimeStrategy, 'system-native');
  assert.deepEqual(validateTypographyRecipe(typography), []);
  const invalid = { ...typography, rationale: '' };
  assert.equal(validateTypographyRecipe(invalid).some((issue) => issue.rule === 'unjustified-system-typography'), true);
});

test('runtime validation rejects an editorial recipe left on generic unconsumed fonts', () => {
  const typography = typographyRecipe('quiet-editorial');
  const issues = validateDesignRuntimeSources({ typography }, {
    tokensSource: `export const tokens = { typography: { runtimeStrategy: 'platform-safe-editorial', headingFamily: 'platform-serif', bodyFamily: 'system-sans', monoFamily: 'system-monospace' } };`,
    configSource: `const config = { fonts: defaultConfig.fonts };`,
    runtimeSource: `<Text allowFontScaling={false}>Generic</Text>`,
  });
  const rules = new Set(issues.map((issue) => issue.rule));
  assert.ok(rules.has('typography-fonts-not-wired'));
  assert.ok(rules.has('typography-tokens-not-consumed'));
  assert.ok(rules.has('editorial-runtime-not-wired'));
  assert.ok(rules.has('heading-role-unused'));
  assert.ok(rules.has('body-role-unused'));
  assert.ok(rules.has('dynamic-type-disabled'));
});

test('shared route header keeps deep-link fallback and balanced navigation slots while consuming type roles', () => {
  const source = fs.readFileSync(path.join(pluginRoot, 'shared/samples/src/components/index.tsx'), 'utf8');
  assert.match(source, /router\.canGoBack\(\)/);
  assert.match(source, /router\.replace\(fallbackHref/);
  assert.match(source, /balancedNavigationSlots/);
  assert.match(source, /width=\{48\} minWidth=\{48\}/);
  assert.match(source, /fontFamily="\$heading"/);
  assert.match(source, /fontFamily="\$body"/);
  assert.doesNotMatch(source, /allowFontScaling=\{false\}/);
});
