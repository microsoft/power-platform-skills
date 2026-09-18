'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const integration = read('skills/design-system/references/tamagui-integration.md');
const design = read('skills/design-system/SKILL.md');
const branch = integration.slice(
  integration.indexOf('## Approved dark palette (conditional)'),
  integration.indexOf('## Root Provider Wiring'),
);

test('direct design entry explicitly offers and routes approved full integration', () => {
  const entry = design.slice(design.indexOf('**Entry routing:**'), design.indexOf('Source of truth'));
  assert.match(entry, /artifact-only implementation,\nfull app integration, or cancel/);
  assert.match(entry, /On full integration, delegate to `\/edit-app`\nbefore entering this leaf workflow or writing artifacts/);
  assert.match(entry, /Approved orchestrated\ncalls skip the question/);
});

test('custom dark artifacts have one named export and a complete non-literal color contract', () => {
  assert.match(branch, /export const darkTokens =/);
  assert.match(branch, /satisfies \{ color: \{ \[K in keyof BrandTokens\['color'\]\]: string \} \}/);
  for (const key of ['bg', 'surface', 'primary', 'accent', 'text', 'textMuted', 'border',
    'statusSuccess', 'statusWarning', 'statusDanger', 'statusInfo']) {
    assert.match(branch, new RegExp(`\\b${key}: '\\{\\{approved-dark-`));
  }
  assert.match(branch, /import \{ darkTokens \} from '\.\/brand\/tokens\.dark'/);
  assert.match(branch, /Missing files, missing exports\/keys, or unresolved placeholder values block/);
  assert.match(design, /Write `brand\/tokens\.dark\.ts` using the named `darkTokens` export/);
});

test('ordinary brand integration keeps its prior defaults without requiring a dark file', () => {
  const base = integration.slice(integration.indexOf('## Brand Import'), integration.indexOf('## Approved dark palette'));
  assert.doesNotMatch(base, /tokens\.dark/);
  assert.match(base, /defaultConfig\.themes\.dark/);
  assert.match(base, /accent: brandTokens\.color\.accent/);
  assert.match(branch, /keep the Brand Import example above unchanged and do not import a nonexistent\ndark file/);
  assert.match(branch, /unapproved file's presence alone does not authorize wiring it/);
});

test('both creation and edit apply custom-dark wiring before using the resolved provider theme', () => {
  const create = read('skills/create-mobile-app/SKILL.md');
  const edit = read('skills/edit-app/SKILL.md');
  assert.match(create, /\*\*Approved dark palette\*\* branch first: import `darkTokens`/);
  assert.match(create, /derive `appDarkTheme` from\n`darkTokens\.color`/);
  assert.match(edit, /\*\*Approved dark\n\s+palette\*\* branch: wire `darkTokens\.color` into `appDarkTheme`/);
  assert.match(edit, /provider's `brandedDarkTheme`/);
  assert.match(integration, /darkTheme=\{brandedDarkTheme\}/);
});

test('the conditional example forwards approved dark surfaces and text to provider values', () => {
  const theme = /export const appDarkTheme = (withPowerAppsSemanticAliases\([\s\S]*?\n\));/.exec(branch)?.[1];
  const provider = /const brandedDarkTheme: ThemeTokens = (\{[\s\S]*?\n\});/.exec(integration)?.[1];
  assert.ok(theme, 'Expected the concrete conditional dark-theme declaration');
  assert.ok(provider, 'Expected the concrete host provider mapping');
  const colors = { bg: '#121212', surface: '#202020', text: '#eeeeee', accent: '#77aaff' };
  let calls = 0;
  const result = vm.runInNewContext(
    `const appDarkTheme = ${theme}; const brandedDarkTheme = ${provider}; brandedDarkTheme;`,
    {
      darkTokens: { color: colors },
      defaultConfig: { themes: { dark: { baseline: true } } },
      hostDarkTheme: { preservedHostValue: 'keep' },
      // Stub host color resolution; this tests the documented data path, not host implementation.
      withPowerAppsSemanticAliases: (base, palette) => {
        calls += 1;
        assert.equal(base.baseline, true);
        assert.equal(palette, colors);
        return {
          surface0: palette.bg,
          surface1: palette.surface,
          text0: palette.text,
          accentBase: palette.accent,
        };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.surface0, colors.bg);
  assert.equal(result.surface1, colors.surface);
  assert.equal(result.text0, colors.text);
  assert.equal(result.accentBase, colors.accent);
  assert.equal(result.preservedHostValue, 'keep');
});
