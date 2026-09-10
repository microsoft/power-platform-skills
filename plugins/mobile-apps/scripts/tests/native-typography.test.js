'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  root, available, loadSource, loadSample, hooks, tamagui, find,
} = require('./helpers/sample-runtime');

if (!available && process.env.MOBILE_SAMPLE_RUNTIME_REQUIRED === '1') {
  throw new Error('Install the existing template dependencies before running native typography tests.');
}
const runtimeTest = (name, callback) => test(name, {
  skip: available ? false : 'Existing template TypeScript dependency is not installed',
}, callback);
const template = path.join(root, 'template');
const dependency = (name) => require(require.resolve(name, { paths: [template] }));

function environment() {
  const core = dependency('@tamagui/core');
  const { defaultConfig } = dependency('@tamagui/config/v5');
  const { createPowerAppsTamaguiConfig } = dependency('@microsoft/power-apps-native-host/config/tamaguiConfig');
  const helper = loadSample('src/tokens/native-typography.ts', { '@tamagui/core': core });
  const baseline = createPowerAppsTamaguiConfig({});
  return { ...helper, core, defaultConfig, baseline, createPowerAppsTamaguiConfig };
}

function role(family, size, weight = '600', lineHeight = 1.3, tracking = -0.015) {
  return { family, size, weight, lineHeight, tracking };
}

runtimeTest('real host baseline validates raw and parsed fonts, including mono', () => {
  const env = environment();
  assert.ok(env.baseline.fonts.mono);
  env.assertNativeFontDefaults(env.baseline);
  env.assertNativeFontDefaults({ fonts: env.baseline.fonts, settings: env.baseline.settings });
});

runtimeTest('detects the v5 orphaned default and repairs its entire metric tuple', () => {
  const env = environment();
  const base = env.baseline.fonts.body;
  const defaultSlot = Object.keys(base.size).find((key) => key !== 'true' && base.size[key] === base.size.true);
  const changedSize = base.size.true + 0.5;
  const brokenFonts = {
    ...env.baseline.fonts,
    body: env.core.createFont({ ...base, size: { ...base.size, [defaultSlot]: changedSize } }),
  };
  const broken = env.createPowerAppsTamaguiConfig({ fonts: brokenFonts });
  assert.throws(() => env.assertNativeFontDefaults(broken), /no matching numbered size/);
  const approved = role(base.family, changedSize, '700', 1.4, 0.025);
  const bound = env.createNativeTypography(env.baseline.fonts, {
    body: { font: 'body', sizeToken: defaultSlot, role: approved },
  });
  const result = bound.fonts.body;
  assert.equal(result.size.true, approved.size);
  assert.equal(result.lineHeight.true, approved.size * approved.lineHeight);
  assert.equal(result.weight.true, approved.weight);
  assert.equal(result.letterSpacing.true, approved.size * approved.tracking);
  assert.equal(base.size.true, env.baseline.fonts.body.size.true);
  assert.equal(bound.fonts.heading, env.baseline.fonts.heading);
  assert.equal(bound.fonts.mono, env.baseline.fonts.mono);
  env.assertNativeFontDefaults(env.createPowerAppsTamaguiConfig({ fonts: bound.fonts }));
});

runtimeTest('duplicate default sizes cannot silently select another role metric tuple', () => {
  const env = environment();
  const base = env.baseline.fonts.body;
  const defaultSlot = Object.keys(base.size).find(key => key !== 'true' && base.size[key] === base.size.true);
  const earlierSlot = Object.keys(base.size).find(key => key !== 'true' && base.size[key] !== base.size.true);
  const size = base.size[earlierSlot];
  assert.throws(() => env.createNativeTypography(env.baseline.fonts, {
    body: { font: 'body', sizeToken: defaultSlot, role: role(base.family, size, '700', 1.4, 0.025) },
  }), /collides with earlier token/);
  const consistent = env.createNativeTypography(env.baseline.fonts, {
    body: { font: 'body', sizeToken: defaultSlot, role: role(
      base.family, size, base.weight[earlierSlot],
      base.lineHeight[earlierSlot] / size, base.letterSpacing[earlierSlot] / size,
    ) },
  });
  const config = env.createPowerAppsTamaguiConfig({ fonts: consistent.fonts });
  const { getFontSized } = dependency('@tamagui/get-font-sized');
  const rendered = getFontSized('$true', { font: config.fontsParsed.$body, props: {} });
  assert.equal(rendered.fontSize.val, size);
  assert.equal(rendered.fontWeight.val, consistent.fonts.body.weight.true);
  assert.equal(rendered.lineHeight.val, consistent.fonts.body.lineHeight.true);
});

runtimeTest('default checks do not depend on a particular numbered slot or pixel scale', () => {
  const env = environment();
  for (const [defaultSlot, size] of [['2', 19], ['7', 21.5], ['12', 33]]) {
    const font = env.core.createFont({
      family: 'System',
      size: { 1: size - 2, [defaultSlot]: size, true: size },
      weight: { 1: '400', [defaultSlot]: '600', true: '600' },
      lineHeight: { 1: size + 2, [defaultSlot]: size * 1.25, true: size * 1.25 },
      letterSpacing: { 1: 0, [defaultSlot]: 0.1, true: 0.1 },
    });
    const nextRole = role('System', size + 1.75, 700, 1.35, -0.02);
    const result = env.createNativeTypography({ content: font }, {
      annotation: { font: 'content', sizeToken: `$${defaultSlot}`, role: nextRole },
    });
    env.assertNativeFontDefaults({ fonts: result.fonts, settings: { defaultFont: '$content' } });
    assert.equal(result.fonts.content.size.true, nextRole.size);
    assert.equal(result.fonts.content.weight.true, '700');
  }
});

runtimeTest('clinical handoff, field inspection and learning roles reach Text with all five metrics', () => {
  const env = environment();
  const h = hooks();
  const { TypographyText } = loadSample('src/components/TypographyText.tsx', {
    react: h.react, tamagui,
  });
  const scenarios = [
    { label: 'Review medication changes', size: 23, weight: '700', lineHeight: 1.25, tracking: -0.02 },
    { label: 'Inspection exceptions', size: 27.5, weight: '600', lineHeight: 1.3, tracking: 0 },
    { label: 'Continue reading', size: 31, weight: '800', lineHeight: 1.15, tracking: -0.01 },
  ];
  for (const scenario of scenarios) {
    const approved = { family: env.baseline.fonts.heading.family, ...scenario };
    const bound = env.createNativeTypography(env.baseline.fonts, {
      title: { font: 'heading', sizeToken: 8, role: approved },
    });
    const tree = TypographyText({
      typography: bound.text.title,
      color: '$text0',
      allowFontScaling: true,
      children: scenario.label,
      onPress() {},
    });
    const nativeText = find(tree, 'Text');
    assert.equal(nativeText.props.fontFamily, '$heading');
    assert.equal(nativeText.props.fontSize, approved.size);
    assert.equal(nativeText.props.fontWeight, approved.weight);
    assert.equal(nativeText.props.lineHeight, approved.size * approved.lineHeight);
    assert.equal(nativeText.props.letterSpacing, approved.size * approved.tracking);
    assert.equal(nativeText.props.allowFontScaling, true);
    assert.equal(nativeText.props.color, '$text0');
    assert.equal(nativeText.props.children, scenario.label);
    assert.equal(typeof nativeText.props.onPress, 'function');
    assert.equal(nativeText.props.numberOfLines, undefined);
    env.assertNativeFontDefaults(env.createPowerAppsTamaguiConfig({ fonts: bound.fonts }));
  }
});

runtimeTest('unrelated scale entries, font sections and defaults survive a non-default binding', () => {
  const env = environment();
  const base = {
    ...env.baseline.fonts.body,
    color: { 2: '$text1' },
    style: { 2: 'italic' },
    transform: { 2: 'uppercase' },
    face: { 400: { normal: 'Loaded-Regular' } },
  };
  const snapshot = JSON.stringify(base);
  const result = env.createNativeTypography({ body: base, mono: env.baseline.fonts.mono }, {
    caption: { font: 'body', sizeToken: 2, role: role(base.family, 13.5, '400', 1.4, 0.03) },
  });
  const next = result.fonts.body;
  for (const section of ['size', 'lineHeight', 'weight', 'letterSpacing']) {
    for (const [key, value] of Object.entries(base[section])) {
      if (key !== '2') assert.equal(next[section][key], value);
    }
  }
  assert.equal(next.color[2], base.color[2]);
  assert.equal(next.style[2], base.style[2]);
  assert.equal(next.transform[2], base.transform[2]);
  assert.equal(next.face[400], base.face[400]);
  assert.equal(result.fonts.mono, env.baseline.fonts.mono);
  assert.equal(JSON.stringify(base), snapshot);
});

runtimeTest('changed family removes stale faces; an explicit new map is preserved', () => {
  const env = environment();
  const base = { ...env.baseline.fonts.heading, face: { 700: { normal: 'Old-Bold' } } };
  const binding = { font: 'heading', sizeToken: 8, role: role('Approved', 29, '700') };
  const changed = env.createNativeTypography({ heading: base }, { title: binding });
  assert.equal(changed.fonts.heading.face, undefined);
  const mapped = env.createNativeTypography({ heading: base }, {
    title: { ...binding, face: { 700: { normal: 'Approved-Bold', italic: 'Approved-BoldItalic' } } },
  });
  assert.equal(mapped.fonts.heading.face[700].normal, 'Approved-Bold');
  assert.equal(mapped.fonts.heading.face[700].italic, 'Approved-BoldItalic');
  assert.equal(base.face[700].normal, 'Old-Bold');
});

runtimeTest('multiple roles merge loaded faces without dropping earlier weights or changing them silently', () => {
  const env = environment();
  const bindings = {
    title: {
      font: 'heading', sizeToken: 8, role: role('Approved', 29, '700'),
      face: { 700: { normal: 'Approved-Bold' } },
    },
    label: {
      font: 'heading', sizeToken: 5, role: role('Approved', 17, '600'),
      face: { 600: { normal: 'Approved-Semibold' } },
    },
  };
  const result = env.createNativeTypography(env.baseline.fonts, bindings);
  assert.equal(result.fonts.heading.face[700].normal, 'Approved-Bold');
  assert.equal(result.fonts.heading.face[600].normal, 'Approved-Semibold');
  assert.throws(() => env.createNativeTypography(env.baseline.fonts, {
    ...bindings,
    label: { ...bindings.label, face: { 700: { normal: 'Different-Bold' } } },
  }), /Conflicting native faces/);
});

runtimeTest('real Tamagui Variables and raw native values resolve without coercing unknown data', () => {
  const env = environment();
  const variable = (val, name) => env.core.createVariable({ val, name, key: name });
  const approved = {
    family: variable('System', 'family'), size: variable(20.5, 'size'),
    weight: variable('700', 'weight'), lineHeight: variable(1.4, 'leading'),
    tracking: variable(-0.02, 'tracking'),
  };
  const bound = env.createNativeTypography(env.baseline.fonts, {
    title: { font: 'heading', sizeToken: 7, role: approved },
  });
  assert.equal(bound.text.title.fontSize, 20.5);
  assert.equal(bound.text.title.fontWeight, '700');
  assert.equal(bound.text.title.lineHeight, 20.5 * 1.4);
  env.assertNativeFontDefaults(env.createPowerAppsTamaguiConfig({ fonts: bound.fonts }));
  for (const invalid of [undefined, null, '$size', 'var(--size)', { val: 20 }, { isVar: true }, NaN, Infinity, 0]) {
    assert.throws(() => env.createNativeTypography(env.baseline.fonts, {
      title: { font: 'heading', sizeToken: 7, role: { ...approved, size: invalid } },
    }), /must resolve/);
  }
});

runtimeTest('incomplete or unresolved configuration never validates as success', () => {
  const env = environment();
  for (const config of [undefined, {}, { fonts: {} }, { fonts: env.baseline.fonts }, {
    fonts: env.baseline.fonts, settings: { defaultFont: 'missing' },
  }]) assert.throws(() => env.assertNativeFontDefaults(config), /requires/);
  for (const [section, invalid] of [
    ['size', '$unresolved'], ['lineHeight', undefined], ['letterSpacing', NaN], ['weight', 'semibold'],
  ]) {
    const body = {
      ...env.baseline.fonts.body,
      [section]: { ...env.baseline.fonts.body[section], true: invalid },
    };
    assert.throws(() => env.assertNativeFontDefaults({
      fonts: { body }, settings: { defaultFont: 'body' },
    }), /must resolve/);
  }
});

runtimeTest('ambiguous defaults require an explicit slot and conflicting bindings fail closed', () => {
  const env = environment();
  const base = env.baseline.fonts.body;
  const defaultSlot = Object.keys(base.size).find((key) => key !== 'true' && base.size[key] === base.size.true);
  const ambiguous = { ...base, size: { ...base.size, 20: base.size.true } };
  const binding = { font: 'body', sizeToken: defaultSlot, role: role(base.family, 18.5) };
  assert.throws(() => env.createNativeTypography({ body: ambiguous }, { body: binding }), /ambiguous/);
  const explicit = env.createNativeTypography({ body: ambiguous }, { body: binding }, {
    defaultSizeTokens: { body: defaultSlot },
  });
  assert.equal(explicit.fonts.body.size.true, 18.5);
  env.assertNativeFontDefaults({ fonts: explicit.fonts, settings: { defaultFont: 'body' } });
  assert.throws(() => env.createNativeTypography({ body: base }, { body: binding, label: binding }), /Conflicting/);
  assert.throws(() => env.createNativeTypography({ body: base }, {
    body: binding, label: { ...binding, sizeToken: 8, role: role('Different', 25) },
  }), /same family/);
  assert.throws(() => env.createNativeTypography({ body: base }, {}, {
    defaultSizeTokens: { missing: 4 },
  }), /missing font/);
});

runtimeTest('documented binding and final-config assertion execute against the actual host API', () => {
  const env = environment();
  const file = path.join(root, 'skills/design-system/references/tamagui-integration.md');
  const guide = fs.readFileSync(file, 'utf8');
  const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]);
  const binding = blocks.find((block) => block.includes('export const nativeTypography'));
  const final = blocks.find((block) => block.includes('assertNativeFontDefaults(tamaguiConfig);'));
  assert.ok(binding, 'The documented path must use the tested helper');
  assert.ok(final, 'Validate the actual final config, not source-code spelling');
  const source = `
    import { createPowerAppsTamaguiConfig } from '@microsoft/power-apps-native-host/config/tamaguiConfig';
    const brandTokens = { typography: {
      body: {family: 'System', size: 17.5, weight: '400', lineHeight: 1.5, tracking: 0},
      heading: {family: 'System', size: 28.5, weight: '700', lineHeight: 1.2, tracking: -0.02},
    } } as const;
    ${binding}
    const customConfig = { fonts: nativeTypography.fonts };
    ${final}
  `;
  const result = loadSource(source, file, {
    '@microsoft/power-apps-native-host/config/tamaguiConfig': {
      createPowerAppsTamaguiConfig: env.createPowerAppsTamaguiConfig,
    },
    './src/tokens/native-typography': {
      createNativeTypography: env.createNativeTypography,
      assertNativeFontDefaults: env.assertNativeFontDefaults,
    },
  });
  assert.equal(result.nativeTypography.text.body.fontSize, 17.5);
  assert.equal(result.nativeTypography.text.heading.fontWeight, '700');
  assert.ok(result.tamaguiConfig.fonts.mono);
  env.assertNativeFontDefaults(result.tamaguiConfig);
});

runtimeTest('typography helpers and documented host integration type-check against installed APIs', () => {
  const ts = dependency('typescript');
  const samples = path.join(root, 'shared/samples');
  const probe = path.join(samples, '__native_typography_probe.tsx');
  const source = `
    import React from 'react';
    import { Text } from 'tamagui';
    import { createPowerAppsTamaguiConfig } from '@microsoft/power-apps-native-host/config/tamaguiConfig';
    import { assertNativeFontDefaults, createNativeTypography } from './src/tokens/native-typography';
    import { TypographyText } from './src/components/TypographyText';
    const hostConfig = createPowerAppsTamaguiConfig({});
    const nativeTypography = createNativeTypography(hostConfig.fonts, {
      heading: { font: 'heading', sizeToken: 8, role: {
        family: 'System', size: 26, weight: '700', lineHeight: 1.2, tracking: -0.02,
      } },
    });
    const config = createPowerAppsTamaguiConfig({ fonts: nativeTypography.fonts });
    assertNativeFontDefaults(config);
    type Config = typeof config;
    declare module 'tamagui' {
      interface TamaguiCustomConfig extends Config {}
    }
    export const title = <TypographyText typography={nativeTypography.text.heading}>Review findings</TypographyText>;
    export const plain = <Text {...nativeTypography.text.heading}>Review findings</Text>;
  `;
  const options = {
    noEmit: true, strict: true, skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2020,
    esModuleInterop: true, types: ['react'], typeRoots: [path.join(template, 'node_modules/@types')],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  const exists = host.fileExists;
  host.readFile = (file) => file === probe ? source : read(file);
  host.fileExists = (file) => file === probe || exists(file);
  host.resolveModuleNames = (names, containing) => names.map((name) =>
    ts.resolveModuleName(name, containing, options, host).resolvedModule
      ?? ts.resolveModuleName(name, path.join(template, '__typography_probe.tsx'), options, host).resolvedModule);
  const program = ts.createProgram([probe], options, host);
  const errors = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const location = diagnostic.file
      ? `${path.relative(root, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
      : 'config';
    return `${location} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
  assert.deepEqual(errors, []);
});
