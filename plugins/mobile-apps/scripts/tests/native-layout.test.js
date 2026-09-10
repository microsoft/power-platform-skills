'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  root, available, loadSample, loadSource, hooks, components, component,
  tamagui, nodes, find, text,
} = require('./helpers/sample-runtime');

if (!available && process.env.MOBILE_SAMPLE_RUNTIME_REQUIRED === '1') {
  throw new Error('Install the existing template dependencies before running native layout tests.');
}
const runtimeTest = (name, callback) => test(name, {
  skip: available ? false : 'Existing template TypeScript dependency is not installed',
}, callback);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const references = Object.fromEntries(['navigation', 'list', 'detail', 'platform'].map((name) => [
  name, read(`agents/references/screen-builder/${name}.md`),
]));
// Test the exact fenced examples builders consume, not a second hand-maintained copy.
const examples = new Map(Object.values(references).flatMap((source) =>
  [...source.matchAll(/```tsx\n\/\/ Native layout example: ([\w-]+)\n([\s\S]*?)\n```/g)]
    .map((match) => [match[1], match[2]])));
const heroRecipe = read('shared/references/tamagui-component-recipes.md')
  .split('### `<Hero>`')[1].split('\n---')[0];
examples.set('hero-intro', heroRecipe.match(/```tsx\n([\s\S]*?)\n```/)[1]);

function environment({ bottom = 34, width = 600, fontScale = 1, themeValues = {} } = {}) {
  const h = hooks();
  const Tabs = component('Tabs');
  Tabs.Screen = component('Tabs.Screen');
  const dependencies = {
    react: h.react,
    'react-native': {
      ...components(['ScrollView', 'Pressable']),
      useWindowDimensions: () => ({ width, height: 800, fontScale, scale: 2 }),
    },
    'react-native-safe-area-context': {
      ...components(['SafeAreaView']),
      useSafeAreaInsets: () => ({ top: 24, bottom, left: 0, right: 0 }),
    },
    'expo-router': { Tabs },
    'expo-linear-gradient': components(['LinearGradient']),
    '@expo/vector-icons': components(['Ionicons']),
    '@/tokens': loadSample('src/tokens/index.ts', {}),
    tamagui: {
      ...tamagui,
      useTheme: () => new Proxy({}, { get: (_, name) => ({ val: themeValues[name] ?? '#000000' }) }),
    },
  };
  const shared = loadSample('src/components/index.tsx', dependencies);
  dependencies['@/components'] = shared;
  function expand(tree) {
    if (Array.isArray(tree)) return tree.map(expand);
    if (!tree || typeof tree !== 'object') return tree;
    if (typeof tree.type === 'function') {
      return expand(tree.type({ ...tree.props, children: tree.children }));
    }
    return { ...tree, children: (tree.children ?? []).map(expand) };
  }
  return {
    shared,
    render: (name, props) => h.render(() => shared[name](props)),
    example(name, exportName, props) {
      assert.ok(examples.has(name), `Missing documentation example ${name}`);
      const source = loadSource(examples.get(name), `${name}.tsx`, dependencies);
      return expand(h.render(() => source[exportName](props)));
    },
  };
}

test('layout guidance defines ownership without imposing one domain or composition', () => {
  assert.deepEqual([...examples.keys()].sort(), [
    'hero-intro', 'inspection-header', 'inspection-pair', 'reading-review', 'reading-row', 'reading-tabs', 'selection-actions',
  ]);
  assert.match(references.navigation, /one\s+horizontal header row/);
  assert.match(references.navigation, /foreground-owned navigator wiring/);
  assert.match(references.navigation, /icon, visible label, and selected treatment/);
  assert.match(references.navigation, /Do not replace planned icons/);
  assert.match(references.platform, /minimum presentation baseline/);
  assert.match(references.platform, /typography, icon\/label\/selected navigation, header hierarchy/);
  assert.match(references.platform, /regression to fix and verify/);
  assert.match(references.platform, /one owner per edge\/obstruction/);
  assert.match(references.platform, /measured/);
  assert.match(references.platform, /includeBottomInset=\{false\}/);
  assert.match(references.platform, /never add that inset again/);
  assert.match(references.list, /outer\s+cells \*\*and the inner card surfaces\*\*/);
  assert.match(references.list, /uneven native surfaces are a\s+regression/);
  assert.match(references.list, /Ordinary feed\/reading rows can have different heights/);
  assert.match(references.list, /None|none is a mandatory default/);
  assert.match(references.detail, /normal-flow\s+sibling/);
  assert.match(references.detail, /not a fake approval/);
});

runtimeTest('Hero defaults to themed colors with complete wrapping text roles in both schemes', () => {
  const template = path.join(root, 'template');
  const { withPowerAppsSemanticAliases } = require(require.resolve('@microsoft/power-apps-native-host/config/tamaguiConfig', { paths: [template] }));
  const { defaultConfig } = require(require.resolve('@tamagui/config/v5', { paths: [template] }));
  for (const [scheme, primary, onPrimary] of [['light', '#123b4a', '#ffffff'], ['dark', '#73d6c7', '#0d1b22']]) {
    const env = environment();
    const theme = withPowerAppsSemanticAliases(defaultConfig.themes[scheme], { primary, onPrimary });
    const title = 'Review the outstanding accessibility and inspection findings before continuing';
    const subtitle = 'Read the full context and supporting evidence, including the recovery options.';
    const tree = env.render('Hero', { title, subtitle });
    assert.equal(tree.type, 'YStack');
    assert.equal(tree.props.bg, '$accentBase');
    assert.equal(theme[tree.props.bg.slice(1)], primary);
    assert.equal(tree.props.height, undefined);
    assert.equal(tree.props.maxH, undefined);
    const texts = nodes(tree).filter(node => node.type === 'Text');
    assert.equal(text(texts[0]), title);
    assert.equal(text(texts[1]), subtitle);
    assert.equal(texts[0].props.role, 'heading');
    for (const node of texts) {
      assert.equal(node.props.color, '$accentOnAccent');
      assert.equal(theme[node.props.color.slice(1)], onPrimary);
      assert.equal(node.props.numberOfLines, undefined);
      assert.equal(node.props.allowFontScaling, undefined);
      for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']) {
        assert.notEqual(node.props[key], undefined, key);
      }
    }
    assert.equal(nodes(tree).filter(node => node.type === 'Button').length, 0);
  }
});

runtimeTest('Hero uses its measured container and text scale to keep actions below narrow content', () => {
  for (const fontScale of [1, 1.5, 2]) {
    const env = environment({ width: 1400, fontScale });
    let calls = 0;
    const props = {
      title: 'Long inspection headline',
      subtitle: 'Supporting context that must remain readable.',
      action: { label: 'Review every outstanding finding', iconName: 'document-text-outline', onPress: () => calls++ },
    };
    let tree = env.render('Hero', props);
    let row = find(tree, 'XStack');
    assert.equal(row.props.flexDirection, 'column', 'Unmeasured layout starts safely below');
    for (const width of [320, 390, 800, 300]) {
      row.props.onLayout({ nativeEvent: { layout: { width } } });
      tree = env.render('Hero', props);
      row = find(tree, 'XStack');
      assert.equal(row.props.flexDirection, width >= 480 * fontScale ? 'row' : 'column');
      assert.equal(row.children[0].props.minW, 0);
      const button = find(tree, 'Button');
      assert.equal(button.props.minH, 48);
      assert.equal(button.props.minW, 48);
      assert.equal(button.props.height, 'auto');
      assert.equal(button.props.maxW, '100%');
      assert.equal(button.props.role, 'button');
      assert.equal(button.props['aria-label'], props.action.label);
      assert.equal(button.props.icon.props.size, 24);
      assert.equal(button.props.icon.props.accessible, false);
      assert.equal(find(button, 'Button.Text').props.shrink, 1);
      assert.equal(find(button, 'Button.Text').props.ellipsis, false,
        'auto-height alone does not disable Button.Text single-line truncation');
    }
    find(tree, 'Button').props.onPress();
    assert.equal(calls, 1);
    row.props.onLayout({ nativeEvent: { layout: { width: 1400 } } });
    tree = env.render('Hero', { ...props, actionPlacement: 'below', action: { ...props.action, disabled: true } });
    assert.equal(find(tree, 'XStack').props.flexDirection, 'column');
    assert.equal(find(tree, 'Button').props.disabled, true);
  }
});

runtimeTest('Hero honors approved colors, full typography tuples and deliberate line limits', () => {
  const env = environment();
  const titleTypography = { fontFamily: '$heading', fontSize: 27, fontWeight: '600', lineHeight: 35, letterSpacing: -0.1 };
  const subtitleTypography = { fontFamily: '$body', fontSize: 17, fontWeight: '400', lineHeight: 26, letterSpacing: 0.2 };
  const actionTypography = { fontFamily: '$body', fontSize: 16, fontWeight: '700', lineHeight: 24, letterSpacing: 0 };
  const tree = env.render('Hero', {
    title: 'Reading guide', subtitle: 'Supporting context',
    backgroundColor: '$surface1', foregroundColor: '#17242b',
    titleTypography, subtitleTypography, actionTypography,
    titleNumberOfLines: 1, subtitleNumberOfLines: 2,
    action: { label: 'Open guide', iconName: 'book-outline', onPress() {} },
  });
  assert.equal(tree.props.bg, '$surface1');
  const [title, subtitle] = nodes(tree).filter(node => node.type === 'Text');
  const button = find(tree, 'Button');
  for (const [node, expected] of [[title, titleTypography], [subtitle, subtitleTypography], [find(button, 'Button.Text'), actionTypography]]) {
    for (const [key, value] of Object.entries(expected)) assert.equal(node.props[key], value, key);
    assert.equal(node.props.color, '#17242b');
  }
  assert.equal(title.props.numberOfLines, 1);
  assert.equal(subtitle.props.numberOfLines, 2);
  assert.equal(button.props.borderColor, '#17242b');
  assert.equal(button.props.color, '#17242b');
  assert.equal(button.props.icon.props.color, undefined, 'Tamagui supplies the resolved button foreground to the icon');
});

runtimeTest('explicit legacy Hero gradients remain opt-in and permit a custom foreground', () => {
  const env = environment({ themeValues: { accentOnAccent: '#0d1b22' } });
  for (const gradient of ['hero', 'danger', 'success', 'warm', 'neutral']) {
    const tree = env.render('Hero', { title: 'Explicit gradient', gradient });
    assert.equal(tree.type, env.shared.Gradient);
    assert.equal(tree.props.name, gradient);
    assert.equal(find(tree, 'Text').props.color, 'white');
    assert.equal(find(tree, 'YStack').props.bg, undefined);
  }
  const custom = env.render('Hero', { title: 'Custom gradient', gradient: 'hero', foregroundColor: '#17242b' });
  assert.equal(find(custom, 'Text').props.color, '#17242b');
});

test('Hero documentation routes to the canonical sample and explains configurable defaults', () => {
  assert.match(heroRecipe, /canonical implementation/);
  assert.match(heroRecipe, /Default: solid `\$accentBase`/);
  assert.match(heroRecipe, /Title\/subtitle wrap without a line limit by default/);
  assert.match(heroRecipe, /titleTypography/);
  assert.match(heroRecipe, /verified|Verify the pair/);
  assert.doesNotMatch(heroRecipe, /export function Hero\(/);
  assert.doesNotMatch(read('shared/references/tamagui-component-recipes.md'), /height: 180.*<Hero/);
  assert.doesNotMatch(read('shared/samples/src/components/index.tsx'), /from ['"]\.\.\/tokens\/native-typography['"]/,
    'The base scaffold does not copy the optional typography binder');
});

runtimeTest('header additions retain callers and place accessible back/title/action in one row', () => {
  const env = environment();
  const meta = { type: 'Meta', children: ['Context'] };
  const child = { type: 'Child', children: ['Filters'] };
  const standard = env.render('ScreenHeader', { title: 'Inspection log', meta, children: child });
  assert.equal(find(standard, 'Text').props.fontSize, 28);
  assert.equal(standard.props.px, '$5');
  assert.equal(standard.children[1], meta);
  assert.equal(standard.children[2], child);
  assert.equal(nodes(standard).filter((node) => node.type === 'Button').length, 0);

  const calls = [];
  const title = 'Inspection of the east-wing emergency access and evacuation route';
  const compact = env.example('inspection-header', 'InspectionHeader', {
    title, onBack: () => calls.push('back'), onMore: () => calls.push('more'),
  });
  const row = compact.children[0];
  assert.equal(row.type, 'XStack');
  assert.equal(row.props.minH, 48);
  assert.equal(compact.props.shrink, 0);
  assert.equal(compact.props.pt, undefined);
  const back = find(row, 'Button', (node) => node.props['aria-label'] === 'Back to inspections');
  const action = find(row, 'Button', (node) => node.props['aria-label'] === 'Inspection actions');
  for (const button of [back, action]) {
    assert.equal(button.props.minW, 48);
    assert.equal(button.props.minH, 48);
    assert.equal(button.props.role, 'button');
    button.props.onPress();
  }
  assert.deepEqual(calls, ['back', 'more']);
  assert.equal(back.props.icon.props.name, 'chevron-back');
  const heading = find(row, 'Text', (node) => node.props.role === 'heading');
  assert.equal(text(heading), title);
  assert.equal(heading.props.fontSize, 20);
  assert.equal(heading.props.shrink, 1);
  assert.equal(heading.props.numberOfLines, undefined);
  assert.equal(row.children[1].props.minW, 0);
  const disabled = env.render('ScreenHeader', { title, backAction: { onPress() {}, disabled: true } });
  assert.equal(find(disabled, 'Button').props.disabled, true);
});

runtimeTest('footer inset ownership is explicit and default padding remains backward-compatible', () => {
  for (const bottom of [0, 18, 34]) {
    const env = environment({ bottom });
    const owned = env.render('BottomActionBar', { children: 'Approve' });
    const parentOwned = env.render('BottomActionBar', { children: 'Approve', includeBottomInset: false });
    assert.equal(owned.props.pb, bottom + 20);
    assert.equal(parentOwned.props.pb, 20);
    for (const footer of [owned, parentOwned]) {
      assert.equal(footer.props.shrink, 0);
      assert.equal(footer.props.position, undefined);
      assert.equal(footer.props.height, undefined);
    }
  }
});

runtimeTest('compact selection actions retain accessible targets, wrapping, guards and error feedback', () => {
  for (const fontScale of [1, 1.5, 2]) {
    for (const [count, pending] of [[3, false], [3, true], [0, false]]) {
      let calls = 0;
      const tree = environment({ fontScale }).example('selection-actions', 'SelectionActions', {
        count, pending, error: 'Review unavailable. Try again.', onReview: () => calls++,
      });
      const button = find(tree, 'Button');
      assert.equal(tree.props.pb, 20);
      assert.equal(button.props.minH, 48);
      assert.equal(button.props.height, 'auto');
      assert.equal(button.props.minW, fontScale > 1.25 ? '100%' : 160);
      assert.equal(button.props.disabled, pending || count === 0);
      assert.equal(button.props['aria-busy'], pending);
      assert.equal(find(tree, 'XStack').props.flexWrap, 'wrap');
      assert.ok(text(tree).includes('Review unavailable. Try again.'));
      if (!button.props.disabled) button.props.onPress();
      assert.equal(calls, pending || count === 0 ? 0 : 1);
    }
  }
});

runtimeTest('filter strip cannot shrink below its padded 48px auto-height targets', () => {
  const selected = [];
  const tree = environment().render('FilterChipRow', {
    options: [{ key: 'all', label: 'All' }, { key: 'review', label: 'Needs additional specialist review', count: 12 }],
    selectedKey: 'review', onChange: key => selected.push(key),
  });
  assert.equal(tree.type, 'ScrollView');
  assert.equal(tree.props.style.flexShrink, 0);
  assert.equal(tree.props.style.height, undefined);
  assert.equal(tree.props.style.minHeight, 48 + 2 * tree.props.contentContainerStyle.paddingVertical);
  const buttons = nodes(tree).filter(node => node.type === 'Button');
  for (const button of buttons) {
    assert.equal(button.props.minH, 48);
    assert.equal(button.props.height, 'auto');
    button.props.onPress();
  }
  assert.equal(buttons[1].props['aria-pressed'], true);
  assert.equal(buttons[1].props['aria-label'], 'Needs additional specialist review 12');
  assert.deepEqual(selected, ['all', 'review']);
});

const inspectionOptions = [
  { id: 'routine', title: 'Routine check', description: 'Complete the daily inspection.' },
  {
    id: 'access',
    title: 'Emergency access and evacuation route inspection',
    description: 'Inspect every exit, including the long east-wing corridor and the alternative accessible route.',
  },
];

runtimeTest('approved inspection pairs stretch wrappers AND card surfaces, with width/text-scale fallback', () => {
  for (const [width, fontScale, allowColumns, sideBySide] of [
    [600, 1, true, true], [900, 1.5, true, true], [390, 1, true, false],
    [600, 1.5, true, false], [600, 2, true, false], [900, 1, false, false],
  ]) {
    const chosen = [];
    const tree = environment({ width, fontScale }).example('inspection-pair', 'InspectionPair', {
      items: inspectionOptions, allowColumns, onChoose: (id) => chosen.push(id),
    });
    assert.equal(tree.props.flexDirection, sideBySide ? 'row' : 'column');
    assert.equal(tree.props.items, 'stretch');
    const cells = nodes(tree).filter((node) => node.type === 'Pressable');
    assert.equal(cells.length, 2);
    cells.forEach((cell, index) => {
      const style = cell.props.style({ pressed: false });
      assert.equal(style.flex, sideBySide ? 1 : undefined);
      assert.equal(style.minWidth, 0);
      assert.equal(style.minHeight, 48);
      assert.equal(style.alignSelf, 'stretch');
      assert.equal(cell.props.style({ pressed: true }).opacity, 0.8);
      const surface = cell.children[0];
      assert.equal(surface.props.grow, sideBySide ? 1 : undefined);
      assert.equal(surface.children[0].props.grow, 1);
      assert.equal(cell.props.accessibilityRole, 'button');
      assert.equal(cell.props.accessibilityLabel, `Open ${inspectionOptions[index].title}`);
      assert.ok(text(cell).includes(inspectionOptions[index].description));
      cell.props.onPress();
      for (const node of nodes(cell)) {
        assert.equal(node.props.height, undefined);
        assert.equal(node.props.numberOfLines, undefined);
      }
    });
    assert.deepEqual(chosen, ['routine', 'access']);
  }
});

runtimeTest('reading rows and information values wrap without forcing equal heights', () => {
  const title = 'Reading for the next review: accessibility, evacuation, and workplace safety';
  const summary = 'Read the complete document and its supporting notes before making a decision.';
  let opened = 0;
  const env = environment();
  const row = env.example('reading-row', 'ReadingRow', { title, summary, onOpen: () => opened++ });
  assert.equal(row.props.minH, 48);
  assert.equal(row.props.role, 'button');
  assert.equal(row.props['aria-label'], title);
  const column = find(row, 'YStack');
  assert.equal(column.props.minW, 0);
  assert.equal(column.props.flex, 1);
  assert.ok(text(row).includes(summary));
  row.props.onPress();
  assert.equal(opened, 1);

  for (const layout of [undefined, 'stacked']) {
    const info = env.render('InfoRow', { label: 'Review conditions', value: summary, layout });
    assert.equal(info.props.flexDirection, layout === 'stacked' ? 'column' : 'row');
    assert.ok(text(info).includes(summary));
    for (const node of [...nodes(row), ...nodes(info)]) {
      assert.equal(node.props.height, undefined);
      assert.equal(node.props.numberOfLines, undefined);
    }
  }
  for (const selected of [true, false]) {
    const pick = env.render('RowPick', { label: title, subtitle: summary, selected, onPress() {} });
    assert.equal(pick.children[0].props.flex, 1);
    assert.equal(pick.children[0].props.minW, 0);
    assert.equal(pick.children[1].props.width, 20);
    assert.equal(pick.children[1].props.shrink, 0);
    assert.equal(pick.props['aria-pressed'], selected);
  }
});

runtimeTest('review body and footer are siblings and read-only/pending modes keep one bottom owner', () => {
  for (const reviewing of [false, true]) {
    for (const approving of [false, true]) {
      let approvals = 0;
      const tree = environment().example('reading-review', 'ReadingReview', {
        title: 'Safety policy review',
        sections: [{ id: 'one', text: 'Review every paragraph, including the final conditions.' }],
        onBack() {}, onApprove: reviewing ? () => approvals++ : undefined, approving,
      });
      assert.equal(tree.type, 'SafeAreaView');
      assert.equal(tree.props.edges.includes('bottom'), !reviewing);
      const stack = tree.children[0];
      const scroll = find(stack, 'ScrollView');
      assert.equal(scroll.props.style.flex, 1);
      assert.equal(scroll.props.contentInsetAdjustmentBehavior, 'never');
      assert.equal(scroll.props.automaticallyAdjustContentInsets, false);
      assert.equal(scroll.props.automaticallyAdjustsScrollIndicatorInsets, false);
      assert.equal(scroll.props.contentContainerStyle.paddingBottom, undefined);
      assert.equal(stack.children[1], scroll);
      if (reviewing) {
        const footer = stack.children[2];
        assert.equal(footer.type, 'YStack');
        assert.equal(footer.props.pb, 54);
        assert.equal(footer.props.shrink, 0);
        const action = find(footer, 'Button');
        assert.equal(action.props.minH, 48);
        assert.equal(action.props.disabled, approving);
        assert.equal(action.props['aria-busy'], approving);
        assert.equal(action.props['aria-label'], 'Approve document');
        assert.equal(text(action).trim(), approving ? 'Approving…' : 'Approve document');
        if (!approving) action.props.onPress();
        assert.equal(approvals, approving ? 0 : 1);
      } else {
        assert.equal(stack.children[2], undefined);
      }
    }
  }
});

runtimeTest('approved reading tabs retain visible labels, real icons, and focused icon treatment', () => {
  const tree = environment().example('reading-tabs', 'ReadingTabs');
  assert.equal(tree.type, 'Tabs');
  assert.equal(tree.props.screenOptions.tabBarShowLabel, true);
  assert.equal(tree.props.screenOptions.tabBarAllowFontScaling, true);
  assert.equal(tree.props.screenOptions.tabBarItemStyle.minHeight, 48);
  assert.equal(tree.props.screenOptions.tabBarStyle, undefined);
  const tabs = nodes(tree).filter((node) => node.type === 'Tabs.Screen');
  assert.deepEqual(tabs.map((node) => node.props.name), ['library', 'reviews']);
  assert.deepEqual(tabs.map((node) => node.props.options.title), ['Library', 'Reviews']);
  for (const [index, tab] of tabs.entries()) {
    const renderIcon = tab.props.options.tabBarIcon;
    const inactive = renderIcon({ focused: false, size: 24, color: '#555555' });
    const active = renderIcon({ focused: true, size: 24, color: '#111111' });
    assert.equal(inactive.type, 'Ionicons');
    assert.equal(inactive.props.name, index === 0 ? 'book-outline' : 'checkmark-circle-outline');
    assert.equal(active.props.name, index === 0 ? 'book' : 'checkmark-circle');
    assert.equal(active.props.size, 24);
    assert.equal(active.props.color, '#111111');
    assert.equal(active.props.accessible, false);
  }
});

runtimeTest('documented layouts and existing/new caller contracts type-check against installed native APIs', () => {
  const template = path.join(root, 'template');
  const samples = path.join(root, 'shared/samples');
  const ts = require(require.resolve('typescript', { paths: [template] }));
  const virtual = new Map([...examples].map(([name, source]) => [
    path.join(samples, `__native-layout-${name}.tsx`), source,
  ]));
  const options = {
    noEmit: true, strict: true, skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2020,
    esModuleInterop: true, allowSyntheticDefaultImports: true,
    baseUrl: samples, paths: { '@/*': ['src/*'] },
    types: ['react'], typeRoots: [path.join(template, 'node_modules/@types')],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile;
  const fileExists = host.fileExists;
  host.readFile = (file) => virtual.get(file) ?? readFile(file);
  host.fileExists = (file) => virtual.has(file) || fileExists(file);
  host.resolveModuleNames = (names, containing) => names.map((name) =>
    ts.resolveModuleName(name, containing, options, host).resolvedModule
      ?? ts.resolveModuleName(name, path.join(template, '__native-layout-probe.ts'), options, host).resolvedModule);
  const program = ts.createProgram([
    ...virtual.keys(),
    path.join(__dirname, 'fixtures/native-layout/callers.tsx'),
    path.join(template, 'tamagui.config.ts'),
  ], options, host);
  const errors = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const location = diagnostic.file
      ? `${path.relative(root, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
      : 'config';
    return `${location} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
  assert.deepEqual(errors, []);
});
