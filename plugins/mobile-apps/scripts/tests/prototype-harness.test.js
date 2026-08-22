'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const harnessDir = path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-prototype', 'harness');
const harness = require(path.join(harnessDir, 'run.js'));
const cardinality = require(path.join(harnessDir, 'checks', 'cardinality.js'));
const batchSelection = require(path.join(harnessDir, 'checks', 'batch-selection.js'));
const carouselCheck = require(path.join(harnessDir, 'checks', 'carousel.js'));
const chartCheck = require(path.join(harnessDir, 'checks', 'chart.js'));
const conditional = require(path.join(harnessDir, 'checks', 'conditional.js'));
const contrast = require(path.join(harnessDir, 'checks', 'contrast.js'));
const density = require(path.join(harnessDir, 'checks', 'density.js'));
const discipline = require(path.join(harnessDir, 'checks', 'discipline.js'));
const interactiveOverlap = require(path.join(harnessDir, 'checks', 'interactive-overlap.js'));
const overflow = require(path.join(harnessDir, 'checks', 'overflow.js'));
const primaryLabelTruncation = require(path.join(harnessDir, 'checks', 'primary-label-truncation.js'));
const rawValues = require(path.join(harnessDir, 'checks', 'raw-values.js'));
const rtlMirroredOrder = require(path.join(harnessDir, 'checks', 'rtl-mirrored-order.js'));
const seedHero = require(path.join(harnessDir, 'checks', 'seed-hero.js'));
const scrollPadding = require(path.join(harnessDir, 'checks', 'scroll-padding.js'));
const sortCheck = require(path.join(harnessDir, 'checks', 'sort.js'));

function element(overrides = {}) {
  return {
    id: 1,
    parentId: null,
    tag: 'div',
    testId: '',
    visible: true,
    rect: { height: 0 },
    style: { overflowY: 'visible', paddingBottom: '0px' },
    ...overrides,
  };
}

test('harness contains direct-bundle aliases and browser globals banner', () => {
  const source = fs.readFileSync(path.join(harnessDir, 'run.js'), 'utf8');
  for (const alias of ['react-native', 'react-native-web', 'expo-router', 'expo-status-bar', '@expo/vector-icons']) {
    assert.match(source, new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(source, /'\.png': 'dataurl'/);
  assert.match(source, /'\.ttf': 'dataurl'/);
  assert.match(source, /globalThis\.process/);
  assert.match(source, /globalThis\.global/);
  assert.match(source, /NOT RUN:/);
  assert.match(source, /entrySource\(projectDir, screenPaths/);
  assert.match(source, /prototype-harness: CONTACT SHEET/);
  assert.equal((source.match(/await esbuild\.build\(/g) || []).length, 1);
});

test('vector icon shim bundles the pinned Ionicons glyph map and font', async (t) => {
  const shim = fs.readFileSync(path.join(harnessDir, 'shims', 'vector-icons.jsx'), 'utf8');
  assert.match(shim, /String\.fromCodePoint/);
  assert.match(shim, /@font-face/);
  assert.doesNotMatch(shim, /\\u25cf/);

  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-icon-shim-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const esbuild = require(path.join(harnessDir, '..', '..', '..', 'template', 'node_modules', 'esbuild'));
  const projectDir = path.join(harnessDir, '..', '..', '..', 'template');
  const result = await esbuild.build({
    bundle: true,
    format: 'iife',
    loader: { '.ttf': 'dataurl' },
    outfile: path.join(output, 'icons.js'),
    platform: 'browser',
    plugins: [harness.aliasPlugin(projectDir)],
    stdin: {
      contents: "import { Ionicons } from '@expo/vector-icons'; console.log(Ionicons);",
      loader: 'jsx',
      resolveDir: projectDir,
    },
  });
  assert.equal(result.errors.length, 0);
  const bundle = fs.readFileSync(path.join(output, 'icons.js'), 'utf8');
  assert.match(bundle, /data:font\/ttf;base64/);
  assert.match(bundle, /airplane-outline/);
});

test('Arabic locale parsing and RTL logical order are deterministic', () => {
  const parsed = harness.parseArgs(['--project', '/tmp/app', '--check', 'all', '--locale', 'ar']);
  assert.equal(parsed.locale, 'ar');
  assert.deepEqual(harness.parseArgs(['--project', '/tmp/app', '--checks', 'contrast,overflow']).checks, ['contrast', 'overflow']);
  const pass = rtlMirroredOrder.run({ locale: 'ar', direction: 'rtl', elements: [
    element({ id: 1, testId: 'mirror-row:actions' }),
    element({ id: 2, parentId: 1, attributes: { 'data-logical-order': '1' }, rect: { left: 100, width: 40 } }),
    element({ id: 3, parentId: 1, attributes: { 'data-logical-order': '2' }, rect: { left: 10, width: 40 } }),
  ] }, { locale: 'ar' });
  assert.equal(pass.pass, true, pass.failures.join('\n'));
  const failure = rtlMirroredOrder.run({ locale: 'ar', direction: 'rtl', elements: [
    element({ id: 1, testId: 'mirror-row:actions' }),
    element({ id: 2, parentId: 1, attributes: { 'data-logical-order': '1' }, rect: { left: 10, width: 40 } }),
    element({ id: 3, parentId: 1, attributes: { 'data-logical-order': '2' }, rect: { left: 100, width: 40 } }),
  ] }, { locale: 'ar' });
  assert.equal(failure.pass, false);
  assert.match(failure.failures[0], /right-to-left/);
});

test('browser findings preserve repair evidence and screenshot without parsing check output later', () => {
  const finding = harness.renderFinding(
    { id: 'layout.example', class: 'B', rule: 'clear the footer' },
    'app/(app)/home.tsx',
    'footer overlaps button, expected 20px clearance',
    { context: { screenRelative: 'app/(app)/home.tsx' }, screenshotPath: '/tmp/home.png' },
    '/tmp/contact.png',
  );
  assert.deepEqual(finding, {
    id: 'layout.example', class: 'B', file: 'app/(app)/home.tsx', line: 1,
    actual: 'footer overlaps button', expected: '20px clearance',
    screenshot: '/tmp/home.png', state: 'OPEN',
  });
});

test('finding output groups repeated discipline failures by kind', () => {
  const records = Array.from({ length: 97 }, (_, index) => ({
    label: `app/(app)/screen-${index}.tsx`,
    message: `app/(app)/screen-${index}.tsx: "Title ${index}" uses unpublished type tuple 16px/24px/600`,
  }));
  records.push(
    { label: 'app/(app)/home.tsx', message: 'app/(app)/home.tsx: radius 999px is outside 4/8/12/16/24' },
    { label: 'app', message: 'brand visual font stack matches or omits the neutral template font stack' },
  );
  const groups = harness.groupFindingMessages(records);

  assert.equal(records.length, 99);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].kind, 'unpublished type tuple');
  assert.equal(groups[0].count, 97);
  assert.equal(groups[0].examples.length, 3);
});

test('prototype workflow runs one registry-driven harness pass before design refinement', () => {
  const skill = fs.readFileSync(path.resolve(harnessDir, '..', 'SKILL.md'), 'utf8');
  const harnessStep = skill.indexOf('--checks all');
  const refinement = skill.indexOf('### Step 9.6 - Automated Design Refinement');
  assert.ok(harnessStep > 0 && harnessStep < refinement);
  assert.match(skill, /one bundle containing/);
  assert.match(skill, /prototype-harness-contact-sheet\.png/);
  assert.match(skill, /measurement-only/);
});

test('prototype workflow runs exactly two whole-project TypeScript gates', () => {
  const skill = fs.readFileSync(path.resolve(harnessDir, '..', 'SKILL.md'), 'utf8');
  assert.equal((skill.match(/npm --prefix "\$PROJECT_DIR" run type-check/g) || []).length, 2);
  assert.match(skill, /post-generation gate/);
  assert.match(skill, /second and final whole-project TypeScript invocation/);
  assert.doesNotMatch(skill, /screen-wave TypeScript gate/);
});

test('scroll padding includes all pinned heights and safe-area bottom', () => {
  const pass = scrollPadding.run({ elements: [
    element({ id: 1, testId: 'scroll:items', style: { overflowY: 'auto', paddingBottom: '76px' } }),
    element({ id: 2, testId: 'pinned:actions', rect: { height: 56 } }),
  ] }, { safeAreaBottom: 20 });
  assert.deepEqual(pass, { pass: true, failures: [] });

  const failure = scrollPadding.run({ elements: [
    element({ id: 1, testId: 'scroll:items', style: { overflowY: 'auto', paddingBottom: '55px' } }),
    element({ id: 2, testId: 'pinned:actions', rect: { height: 56 } }),
  ] }, { safeAreaBottom: 20 });
  assert.equal(failure.pass, false);
  assert.match(failure.failures[0], /55px.*76px/);

  const missingPinned = scrollPadding.run({ elements: [
    element({ id: 1, testId: 'scroll:items', style: { overflowY: 'auto', paddingBottom: '76px' } }),
  ] }, { safeAreaBottom: 20 });
  assert.deepEqual(missingPinned, { pass: true, failures: [], note: 'no pinned layer found' });

  const missingScroll = scrollPadding.run({ elements: [
    element({ id: 1, style: { overflowY: 'auto', paddingBottom: '76px' } }),
    element({ id: 2, testId: 'pinned:actions', rect: { height: 56 } }),
  ] }, { safeAreaBottom: 20 });
  assert.equal(missingScroll.pass, false);
  assert.equal(missingScroll.notRun, true);
  assert.match(missingScroll.failures[0], /scroll:<screen> testID is absent/);

  const structuralFailure = scrollPadding.run({ viewport: { height: 844 }, elements: [
    element({ id: 1, testId: 'scroll:items', rect: { top: 0, bottom: 844, height: 844 }, style: { overflowY: 'auto', paddingBottom: '20px' } }),
    element({ id: 2, tag: 'div', rect: { top: 788, bottom: 844, height: 56 }, style: { position: 'absolute', bottom: '0px' } }),
  ] }, { safeAreaBottom: 20 });
  assert.equal(structuralFailure.pass, false);
  assert.equal(structuralFailure.notRun, undefined);
  assert.match(structuralFailure.failures.join('\n'), /missing required pinned:<layer> testID/);
  assert.match(structuralFailure.failures.join('\n'), /20px.*76px/);
});

test('overflow catches parent overhang and excessive line use', () => {
  const parent = element({
    id: 1,
    testId: 'row:item:1',
    rect: { x: 0, left: 0, right: 300, top: 0, width: 300, height: 100 },
  });
  const child = element({
    id: 2,
    parentId: 1,
    testId: 'row:title',
    text: 'A title that unexpectedly wraps into several lines',
    rect: { x: 16, left: 16, right: 320, top: 8, width: 304, height: 72 },
    style: { fontSize: '16px', lineHeight: '24px' },
  });
  const failure = overflow.run({ viewport: { height: 844 }, elements: [parent, child] }, {});
  assert.equal(failure.pass, false);
  assert.match(failure.failures.join('\n'), /overflows .* by 20px/);
  assert.match(failure.failures.join('\n'), /wraps to 3 lines \(budget 1\)/);

  child.rect = { x: 16, left: 16, right: 284, top: 8, width: 268, height: 24 };
  assert.deepEqual(
    overflow.run({ viewport: { height: 844 }, elements: [parent, child] }, {}),
    { pass: true, failures: [] },
  );

  parent.clientWidth = 300;
  parent.scrollWidth = 520;
  child.rect = { x: 16, left: 16, right: 520, top: 8, width: 504, height: 24 };
  assert.deepEqual(
    overflow.run({ viewport: { height: 844 }, elements: [parent, child] }, {}),
    { pass: true, failures: [] },
  );
});

test('contrast enforces WCAG AA thresholds from computed colours', () => {
  const pass = contrast.run({ elements: [element({
    text: 'Readable text',
    style: { color: 'rgb(16, 36, 59)', backgroundColor: 'rgb(255, 255, 255)', fontSize: '16px', fontWeight: '400' },
  })] });
  assert.equal(pass.pass, true);

  const failure = contrast.run({ elements: [element({
    text: 'Faint text',
    style: { color: 'rgb(180, 180, 180)', backgroundColor: 'rgb(255, 255, 255)', fontSize: '16px', fontWeight: '400' },
  })] });
  assert.equal(failure.pass, false);
  assert.match(failure.failures[0], /below 4\.5:1/);

  const icon = element({
    harnessIcon: 'cube-outline',
    style: { color: 'rgb(140, 140, 140)', backgroundColor: 'rgb(255, 255, 255)', fontSize: '16px', fontWeight: '400' },
    text: '',
  });
  assert.equal(contrast.run({ elements: [icon] }).pass, true, 'icons use the 3:1 non-text threshold');
  icon.style.color = 'rgb(160, 160, 160)';
  const iconFailure = contrast.run({ elements: [icon] });
  assert.equal(iconFailure.pass, false);
  assert.match(iconFailure.failures[0], /icon cube-outline.*below 3:1/);
});

test('raw values block exception text and optionset integers', () => {
  const pass = rawValues.run({ elements: [element({ text: 'Approved', testId: 'row-meta' })] });
  assert.equal(pass.pass, true);

  const failure = rawValues.run({ elements: [
    element({ id: 1, text: 'TypeError: records.map is not a function', testId: 'screen:items' }),
    element({ id: 2, text: '100000002', testId: 'row-meta' }),
  ] });
  assert.equal(failure.pass, false);
  assert.match(failure.failures.join('\n'), /raw exception/);
  assert.match(failure.failures.join('\n'), /raw optionset integer/);
});

test('largest text on a data-backed screen must come from seed data', () => {
  const snapshot = { elements: [
    element({ id: 1, testId: 'row:item:1', rect: { width: 300, height: 80 }, style: { fontSize: '16px' } }),
    element({ id: 2, text: 'North Dock Inspection', rect: { width: 280, height: 40 }, style: { fontSize: '28px' } }),
  ] };
  assert.equal(seedHero.run(snapshot, { seedTexts: ['North Dock Inspection'] }).pass, true);
  const failure = seedHero.run(snapshot, { seedTexts: ['Different record'] });
  assert.equal(failure.pass, false);
  assert.match(failure.failures[0], /absent from generated seed data/);

  const slogan = { elements: [
    element({ id: 1, testId: 'row:item:1', rect: { width: 300, height: 80 }, style: { fontSize: '16px' } }),
    element({ id: 2, text: 'Big finds. Sky-high style.', rect: { width: 300, height: 60 }, style: { fontSize: '32px' } }),
    element({ id: 3, text: 'North Dock Inspection', rect: { width: 280, height: 30 }, style: { fontSize: '16px' } }),
  ] };
  const sloganFailure = seedHero.run(slogan, { seedTexts: ['North Dock Inspection'] });
  assert.equal(sloganFailure.pass, false);
  assert.match(sloganFailure.failures[0], /Big finds/);
});

test('separate interactive controls cannot overlap', () => {
  const first = element({ id: 1, interactive: true, text: 'First', rect: { left: 0, top: 0, right: 100, bottom: 44 } });
  const second = element({ id: 2, interactive: true, text: 'Second', rect: { left: 0, top: 50, right: 100, bottom: 94 } });
  assert.equal(interactiveOverlap.run({ elements: [first, second] }).pass, true);
  second.rect = { left: 0, top: 30, right: 100, bottom: 74 };
  const failure = interactiveOverlap.run({ elements: [first, second] });
  assert.equal(failure.pass, false);
  assert.match(failure.failures[0], /First.*overlaps.*Second/);
  second.visibleRect = { left: 0, top: 50, right: 100, bottom: 74 };
  assert.equal(interactiveOverlap.run({ elements: [first, second] }).pass, true);
});

test('primary labels cannot use clipping or ellipsis', () => {
  const row = element({ id: 1, testId: 'row:item:1', text: '', rect: { width: 300, height: 80 } });
  const label = element({
    id: 2,
    parentId: 1,
    text: 'North Dock Inspection',
    clientWidth: 240,
    clientHeight: 24,
    scrollWidth: 240,
    scrollHeight: 24,
    style: { textOverflow: 'clip', whiteSpace: 'normal', webkitLineClamp: 'none' },
  });
  assert.equal(primaryLabelTruncation.run({ elements: [row, label] }).pass, true);
  label.style.textOverflow = 'ellipsis';
  label.style.whiteSpace = 'nowrap';
  label.scrollWidth = 300;
  const failure = primaryLabelTruncation.run({ elements: [row, label] });
  assert.equal(failure.pass, false);
  assert.match(failure.failures[0], /truncates primary label/);

  const icon = element({
    id: 3,
    parentId: 1,
    text: String.fromCodePoint(0xf299),
    harnessIcon: 'cube-outline',
    clientWidth: 12,
    clientHeight: 12,
    scrollWidth: 24,
    scrollHeight: 24,
    style: { textOverflow: 'clip', whiteSpace: 'nowrap', webkitLineClamp: 'none' },
  });
  assert.equal(primaryLabelTruncation.run({ elements: [row, icon] }).pass, true);
});

test('density reports first-viewport seed matches without gating', () => {
  const elements = Array.from({ length: 36 }, (_, index) => element({
    id: index + 1,
    text: `Record ${index + 1}`,
    rect: { top: index * 10, bottom: index * 10 + 8 },
  }));
  elements.push(element({ id: 100, text: 'Below fold', rect: { top: 900, bottom: 920 } }));
  const seedTexts = [...elements.map((item) => item.text), 'Below fold'];
  const list = density.run({ elements, viewport: { height: 844 } }, {
    seedTexts,
    screenMeta: { Archetype: 'List', Screen: 'Inspection queue' },
  });
  assert.equal(list.pass, true);
  assert.deepEqual(list.report, {
    observed: 36,
    floor: 35,
    classification: 'list-queue',
    wouldMeetFloor: true,
  });

  const sparse = density.run({ elements: elements.slice(0, 3), viewport: { height: 844 } }, {
    seedTexts,
    screenMeta: { Archetype: 'Detail', Screen: 'Inspection' },
  });
  assert.equal(sparse.pass, true);
  assert.equal(sparse.report.floor, 8);
  assert.equal(sparse.report.wouldMeetFloor, false);
});

test('cardinality derives expected patterns from N and rejects mismatches', () => {
  assert.equal(cardinality.patternFor('filters', 6), 'chips-overflow');
  assert.equal(cardinality.patternFor('choice-cr_status', 6), 'inline-radio-list');
  assert.equal(cardinality.patternFor('listRows', 12), 'plain-list');
  assert.equal(cardinality.patternFor('listRows', 60), 'search-section-groups');
  assert.equal(cardinality.patternFor('productCards', 1), 'featured-product-card');
  assert.equal(cardinality.patternFor('productCards', 4), 'product-card-row');
  assert.equal(cardinality.patternFor('productCards', 8), 'product-card-grid');
  assert.equal(cardinality.patternFor('productCards', 20), 'product-list-search');
  const expectations = [
    { element: 'filters', count: 6, declaredPattern: 'chips-overflow', source: 'plan' },
    { element: 'choice-cr_status', count: 6, declaredPattern: 'inline-radio-list', source: 'schema-contract' },
  ];
  const pass = cardinality.run({ elements: [
    element({ id: 1, testId: 'cardinality:filters:chips-overflow', rect: { height: 1 } }),
    element({ id: 2, testId: 'cardinality:choice-cr_status:inline-radio-list', rect: { height: 1 } }),
  ] }, { cardinalityExpectations: expectations });
  assert.equal(pass.pass, true);
  const failure = cardinality.run({ elements: [
    element({ id: 1, testId: 'cardinality:filters:chips', rect: { height: 1 } }),
    element({ id: 2, testId: 'cardinality:choice-cr_status:inline-radio-list', rect: { height: 1 } }),
  ] }, { cardinalityExpectations: expectations });
  assert.equal(failure.pass, false);
  assert.match(failure.failures.join('\n'), /rendered chips, expected chips-overflow/);

  const missingContract = cardinality.run({ elements: [] }, { cardinalityExpectations: [] });
  assert.equal(missingContract.pass, false);
  assert.equal(missingContract.notRun, true);
  assert.match(missingContract.failures[0], /contract is absent/);

  const missingTestId = cardinality.run({ elements: [] }, { cardinalityExpectations: expectations });
  assert.equal(missingTestId.pass, false);
  assert.equal(missingTestId.notRun, true);
  assert.match(missingTestId.failures[0], /required cardinality testID is absent/);
});

test('discipline gates published scales and source-derived gradients while reporting warning metrics', () => {
  const brandTokenSource = `
export const palette = {
  accentBase: '#147D92',
  surface0: '#FFFFFF',
  surface1: '#F4F6F9',
  surface2: '#E6EAF0',
} as const;
export const fontStack = {
  heading: 'Avenir Next, Avenir, Segoe UI, sans-serif',
  body: 'Avenir Next, Avenir, Segoe UI, sans-serif',
} as const;
export const typeScale = {
  headlineMedium: { fontSize: 28, lineHeight: 36, fontWeight: '400' },
} as const;
export const gradients = { imageScrim: ['transparent', 'black'] } as const;`;
  const text = element({
    id: 1,
    text: 'Inspection',
    rect: { width: 200, height: 36, top: 0, bottom: 36, left: 0, right: 200 },
    style: { fontSize: '28px', lineHeight: '36px', fontWeight: '400', borderRadius: '0px', ownBackgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(16, 36, 59)', backgroundImage: 'none' },
  });
  const fieldOps = discipline.runApp([{ snapshot: { viewport: { width: 390 }, elements: [text] }, context: { screenRelative: 'app/(app)/home.tsx' } }], { brandTokenSource });
  assert.equal(fieldOps.pass, true);
  assert.equal(fieldOps.report.actual.brandDistinctness.accentDistinct, true);
  assert.equal(fieldOps.report.actual.brandDistinctness.surfacesDistinct, true);
  assert.equal(fieldOps.report.actual.brandDistinctness.fontDistinct, true);
  assert.deepEqual(fieldOps.report.actual.typeRoles, ['headlineMedium']);
  assert.deepEqual(fieldOps.report.actual.gradients, []);

  const hero = element({
    id: 2,
    testId: 'gradient:imageScrim:legibility',
    rect: { width: 390, height: 220, top: 0, bottom: 220, left: 0, right: 390 },
    style: { fontSize: '0px', lineHeight: '0px', fontWeight: '400', borderRadius: '0px', ownBackgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(0, 0, 0)', backgroundImage: 'linear-gradient(rgb(0,0,0), rgb(1,1,1))' },
  });
  const image = element({ id: 3, parentId: 2, tag: 'img', testId: 'hero', rect: { width: 390, height: 220 } });
  const photoApp = discipline.runApp([{ snapshot: { viewport: { width: 390 }, elements: [hero, image] }, context: { screenRelative: 'app/(app)/detail.tsx' } }], { brandTokenSource });
  assert.equal(photoApp.pass, true);
  assert.deepEqual(photoApp.report.actual.gradients, ['imageScrim']);

  hero.interactive = true;
  const gradientButton = discipline.runApp([{ snapshot: { viewport: { width: 390 }, elements: [hero, image] }, context: { screenRelative: 'app/(app)/detail.tsx' } }], { brandTokenSource });
  assert.equal(gradientButton.pass, false);
  assert.match(gradientButton.failures.join('\n'), /interactive chrome/);

  const unadopted = element({
    ...text,
    id: 4,
    text: 'Unadopted role',
    style: { ...text.style, fontSize: '24px', lineHeight: '32px' },
  });
  const unadoptedResult = discipline.runApp([{ snapshot: { viewport: { width: 390 }, elements: [unadopted] }, context: { screenRelative: 'app/(app)/home.tsx' } }], { brandTokenSource });
  assert.equal(unadoptedResult.pass, false);
  assert.match(unadoptedResult.failures.join('\n'), /unpublished type tuple/);

  const statusOnlySource = `
export const tokens = {
  color: {
    bg: '#f7f7f7', surface: '#f7f7f7', surfaceMuted: '#ededed', primary: '#0588f0',
    statusDanger: '#C5221F', statusSuccess: '#137333',
  },
} as const;
export const fontStack = {
  heading: '-apple-system, system-ui, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  body: '-apple-system, system-ui, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
} as const;
export const typeScale = {
  headlineMedium: { fontSize: 28, lineHeight: 36, fontWeight: '400' },
} as const;`;
  const statusOnly = discipline.runApp([{ snapshot: { viewport: { width: 390 }, elements: [text] }, context: { screenRelative: 'app/(app)/home.tsx' } }], { brandTokenSource: statusOnlySource });
  assert.equal(statusOnly.pass, false);
  assert.match(statusOnly.failures.join('\n'), /brand accent matches/);
  assert.match(statusOnly.failures.join('\n'), /brand surfaces match/);
  assert.match(statusOnly.failures.join('\n'), /brand visual font stack matches/);
});

test('conditional UX validates visibility, warning remedies, steppers, and entity icons', () => {
  const rowPosted = element({ id: 1, testId: 'row:item:posted', attributes: { 'data-record-state': 'Posted' } });
  const postedField = element({ id: 2, parentId: 1, testId: 'conditional-field:cr_journalref' });
  const rowDraft = element({ id: 3, testId: 'row:item:draft', attributes: { 'data-record-state': 'Draft' } });
  const warningContainer = element({ id: 4 });
  const warning = element({ id: 5, parentId: 4, testId: 'warning:damage-warning' });
  const remedy = element({ id: 6, parentId: 4, testId: 'remedy:add-evidence', interactive: true });
  const stepper = element({ id: 7, testId: 'input-role:cr_receivedqty:numeric-stepper' });
  const decrement = element({ id: 8, parentId: 7, testId: 'stepper-decrement:cr_receivedqty', interactive: true });
  const increment = element({ id: 9, parentId: 7, testId: 'stepper-increment:cr_receivedqty', interactive: true });
  const icon = element({ id: 10, testId: 'entity-icon:cr_item:cube-outline' });
  const contracts = {
    visibility: [{ field: 'cr_journalref', stateField: 'cr_status', states: ['Posted'] }],
    warnings: [{ warning: 'damage-warning', remedy: 'add-evidence' }],
    inputs: [{ field: 'cr_receivedqty', role: 'count-against-expected', control: 'numeric-stepper' }],
    icons: [{ entity: 'cr_item', icon: 'cube-outline' }],
  };
  const pass = conditional.runApp([{
    snapshot: { elements: [rowPosted, postedField, rowDraft, warningContainer, warning, remedy, stepper, decrement, increment, icon] },
    context: { screenRelative: 'app/(app)/home.tsx', conditionalContracts: contracts },
  }]);
  assert.equal(pass.pass, true);
  assert.equal(pass.report.fieldVisibilityContracts, 1);

  stepper.visible = false;
  decrement.visible = false;
  increment.visible = false;
  stepper.rendered = true;
  decrement.rendered = true;
  increment.rendered = true;
  assert.equal(conditional.runApp([{
    snapshot: { elements: [rowPosted, postedField, rowDraft, warningContainer, warning, remedy, stepper, decrement, increment, icon] },
    context: { screenRelative: 'app/(app)/home.tsx', conditionalContracts: contracts },
  }]).pass, true);

  const leakedField = element({ id: 11, parentId: 3, testId: 'conditional-field:cr_journalref' });
  const failure = conditional.runApp([{
    snapshot: { elements: [rowPosted, postedField, rowDraft, leakedField, warningContainer, warning, stepper, decrement, icon] },
    context: { screenRelative: 'app/(app)/home.tsx', conditionalContracts: contracts },
  }, {
    snapshot: { elements: [element({ id: 20, testId: 'entity-icon:cr_asset:cube-outline' })] },
    context: { screenRelative: 'app/(app)/assets.tsx', conditionalContracts: { visibility: [], warnings: [], inputs: [], icons: [{ entity: 'cr_asset', icon: 'cube-outline' }] } },
  }]);
  assert.equal(failure.pass, false);
  assert.match(failure.failures.join('\n'), /visible outside allowed states/);
  assert.match(failure.failures.join('\n'), /lacks adjacent interactive remedy/);
  assert.match(failure.failures.join('\n'), /missing interactive increment/);
  assert.match(failure.failures.join('\n'), /share icon cube-outline/);

  const missingContract = conditional.runApp([{
    snapshot: { elements: [] },
    context: { screenRelative: 'app/(app)/home.tsx', conditionalContracts: {} },
  }]);
  assert.equal(missingContract.pass, false);
  assert.equal(missingContract.notRun, true);
  assert.match(missingContract.failures[0], /contract is absent/);

  const missingTestIds = conditional.runApp([{
    snapshot: { elements: [] },
    context: { screenRelative: 'app/(app)/home.tsx', conditionalContracts: contracts },
  }]);
  assert.equal(missingTestIds.pass, false);
  assert.equal(missingTestIds.notRun, true);
  assert.match(missingTestIds.failures.join('\n'), /required .* testID is absent|data-record-state evidence is absent/);
});

test('sort requires a visible active choice, count-driven control, and top reset', () => {
  const options = [
    { field: 'cr_createdat', direction: 'desc', label: 'Newest', default: true },
    { field: 'cr_subjectname', direction: 'asc', label: 'Subject A-Z', default: false },
  ];
  const pass = sortCheck.run({ elements: [
    element({ id: 1, testId: 'sort-control:inline-chips' }),
    element({ id: 2, testId: 'sort-active:cr_createdat:desc', text: 'Sort: Newest' }),
    element({ id: 3, testId: 'sort-results', attributes: { 'data-sort-reset': 'top' } }),
  ] }, { sortOptions: options });
  assert.equal(pass.pass, true);
  const failure = sortCheck.run({ elements: [
    element({ id: 1, testId: 'sort-control:sheet' }),
    element({ id: 2, testId: 'sort-results', attributes: { 'data-sort-reset': 'middle' } }),
  ] }, { sortOptions: options });
  assert.equal(failure.pass, false);
  assert.match(failure.failures.join('\n'), /inline-chips/);
  assert.match(failure.failures.join('\n'), /exactly one visible active option/);
  assert.match(failure.failures.join('\n'), /data-sort-reset="top"/);
});

test('batch selection replaces the primary bar and names destructive counts', () => {
  const actions = [
    { key: 'approve', label: 'Approve', destructive: false },
    { key: 'reject', label: 'Reject', destructive: true },
  ];
  const pass = batchSelection.run({ elements: [
    element({ id: 1, testId: 'selection-mode:active', attributes: { 'data-selection-entry': 'long-press', 'data-selection-exit-restores': 'primary' } }),
    element({ id: 2, parentId: 1, testId: 'selection-count', text: '3 selected' }),
    element({ id: 3, parentId: 1, testId: 'selection-select-all', interactive: true }),
    element({ id: 4, parentId: 1, testId: 'selection-exit', interactive: true }),
    element({ id: 5, parentId: 1, testId: 'pinned:batch-actions' }),
    element({ id: 6, parentId: 5, testId: 'batch-actions:buttons' }),
    element({ id: 7, parentId: 6, testId: 'batch-action:approve', interactive: true }),
    element({ id: 8, parentId: 6, testId: 'batch-destructive:reject', interactive: true, ariaLabel: 'Reject 3 requests' }),
  ] }, { batchActions: actions });
  assert.equal(pass.pass, true);
  const failure = batchSelection.run({ elements: [
    element({ id: 1, testId: 'selection-mode:active', attributes: { 'data-selection-entry': 'checkboxes', 'data-selection-exit-restores': 'none' } }),
    element({ id: 2, testId: 'selection-count', text: '3 selected' }),
    element({ id: 3, testId: 'pinned:batch-actions' }),
    element({ id: 4, testId: 'pinned:primary-actions' }),
    element({ id: 5, testId: 'batch-destructive:reject', interactive: true, ariaLabel: 'Reject requests' }),
  ] }, { batchActions: actions });
  assert.equal(failure.pass, false);
  assert.match(failure.failures.join('\n'), /long-press or visible Select/);
  assert.match(failure.failures.join('\n'), /replace, not stack/);
  assert.match(failure.failures.join('\n'), /name selected count 3/);
});

test('carousel requires bleed, snap, no auto-advance, three items, and announced positions', () => {
  const contract = { entity: 'cr_product', field: 'cr_imageurl', items: 3, queue: false };
  const pass = carouselCheck.run({ elements: [
    element({ id: 1, testId: 'carousel:cr_product:carousel-row', clientWidth: 390, scrollWidth: 620, attributes: { 'data-carousel-snap': 'start', 'data-auto-advance': 'false', 'data-preserve-position': 'true' } }),
    element({ id: 2, testId: 'carousel-item:one', ariaLabel: '1 of 3' }),
    element({ id: 3, testId: 'carousel-item:two', ariaLabel: '2 of 3' }),
    element({ id: 4, testId: 'carousel-item:three', ariaLabel: '3 of 3' }),
  ] }, { carouselContract: contract });
  assert.equal(pass.pass, true);
  const failure = carouselCheck.run({ elements: [
    element({ id: 1, testId: 'carousel:cr_product:carousel-row', clientWidth: 390, scrollWidth: 390, attributes: { 'data-carousel-snap': 'none', 'data-auto-advance': 'true' } }),
    element({ id: 2, testId: 'carousel-item:one', ariaLabel: 'Item one' }),
    element({ id: 3, testId: 'carousel-item:two', ariaLabel: 'Item two' }),
  ] }, { carouselContract: { ...contract, queue: true } });
  assert.equal(failure.pass, false);
  assert.match(failure.failures.join('\n'), /queues must not use/);
  assert.match(failure.failures.join('\n'), /must exceed viewport/);
  assert.match(failure.failures.join('\n'), /auto-advance must be false/);
  assert.match(failure.failures.join('\n'), /minimum is 3/);
});

test('chart requires exact dependencies, chart tokens, scale axes, points, and caption', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', JSON.stringify({ dependencies: { 'd3-scale': '4.0.2', '@types/d3-scale': '4.0.9' } }));
  const brandTokenSource = `
export const typeScale = {
  labelSmall: { fontSize: 11, lineHeight: 16, fontWeight: '500' },
} as const;
export const chartTokens = {
  seriesPrimary: '#147D92',
  grid: '#D5DEE6',
} as const;`;
  const chartRoot = element({ id: 1, testId: 'chart:series-chart:bar', ariaLabel: '42 inspections completed', attributes: { 'data-chart-series-token': 'seriesPrimary', 'data-chart-grid-token': 'grid' } });
  const elements = [chartRoot];
  for (let index = 0; index < 6; index += 1) {
    elements.push(element({ id: 10 + index, parentId: 1, testId: `chart-point:${index}` }));
    elements.push(element({ id: 20 + index, parentId: 1, testId: 'chart-axis-label', text: `M${index + 1}`, style: { fontSize: '11px', lineHeight: '16px', fontWeight: '500' } }));
  }
  elements.push(element({ id: 30, parentId: 1, testId: 'chart-caption', text: '42 inspections completed' }));
  const pass = chartCheck.run({ elements }, { projectDir: root, brandTokenSource, chartContract: { kind: 'series-chart', form: 'bar', points: 6 } });
  assert.equal(pass.pass, true, pass.failures.join('\n'));
  chartRoot.attributes['data-chart-series-token'] = 'primary';
  elements.splice(elements.findIndex((item) => item.testId === 'chart-caption'), 1);
  const failure = chartCheck.run({ elements }, { projectDir: root, brandTokenSource, chartContract: { kind: 'series-chart', form: 'bar', points: 6 } });
  assert.equal(failure.pass, false);
  assert.match(failure.failures.join('\n'), /absent from chartTokens/);
  assert.match(failure.failures.join('\n'), /visible chart-caption/);
});

function write(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function generatedFixture(t, dependencyProject, item) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-harness-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.join(dependencyProject, 'node_modules'), path.join(root, 'node_modules'));
  write(root, 'package.json', `${JSON.stringify({ dependencies: { 'd3-scale': '4.0.2', '@types/d3-scale': '4.0.9' } }, null, 2)}\n`);
  write(root, 'tamagui.config.ts', `import { createTamagui } from 'tamagui';\nimport { defaultConfig } from '@tamagui/config/v5';\nexport default createTamagui(defaultConfig);\n`);
  write(root, 'brand/tokens.ts', `export const tokens = {\n  color: { bg: '#FFFFFF', surface: '#F4F6F9', surfaceMuted: '#E6EAF0', primary: '#0A4F8F', onPrimary: '#FFFFFF', text: '#10243B', textMuted: '#526579' },\n  size: { iconSize: 24 },\n  space: { lg: 16 },\n  radius: { md: 12 },\n} as const;\nexport const fontStack = {\n  heading: 'Avenir Next, Avenir, Segoe UI, sans-serif',\n  body: 'Avenir Next, Avenir, Segoe UI, sans-serif',\n} as const;\nexport const typeScale = {\n  headlineMedium: { fontSize: 28, lineHeight: 36, fontWeight: '400' },\n  titleMedium: { fontSize: 16, lineHeight: 24, fontWeight: '500' },\n  bodyMedium: { fontSize: 14, lineHeight: 20, fontWeight: '400' },\n  labelLarge: { fontSize: 14, lineHeight: 20, fontWeight: '500' },\n  labelMedium: { fontSize: 12, lineHeight: 16, fontWeight: '500' },\n  labelSmall: { fontSize: 11, lineHeight: 16, fontWeight: '500' },\n} as const;\nexport const shapeScale = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;\nexport const chartTokens = {\n  seriesPrimary: '#147D92',\n  seriesSecondary: '#6B5CA5',\n  seriesTertiary: '#B8642F',\n  grid: '#D5DEE6',\n  axisLabelRole: 'labelSmall',\n} as const;\nexport const gradients = { imageScrim: ['transparent', 'rgba(0,0,0,0.72)'], chartArea: ['rgba(20,125,146,0.32)', 'rgba(20,125,146,0.02)'] } as const;\n`);
  const previewRows = [
    { ...item, workflowState: 'Posted', journalRef: `${item.reference}-POST`, cr_expectedqty: 10, cr_receivedqty: 8 },
    { ...item, id: `${item.id}-draft`, name: `${item.name} Draft`, workflowState: 'Draft', statusLabel: 'Draft', journalRef: null, cr_expectedqty: 10, cr_receivedqty: 4 },
    { ...item, id: `${item.id}-third`, name: `${item.name} Reserve`, workflowState: 'Ready', statusLabel: 'Ready', journalRef: null, cr_expectedqty: 10, cr_receivedqty: 6 },
  ];
  write(root, 'src/generated/services/Preview.seed.json', `${JSON.stringify(previewRows, null, 2)}\n`);
  write(root, 'src/generated/services/PreviewService.ts', `import rows from './Preview.seed.json';\nexport const previewRows = rows;\nexport const previewItem = rows[0];\n`);
  write(root, '.tmp/seed-vocabulary.json', `${JSON.stringify({ domain: 'fixture', rowCount: 12 })}\n`);
  write(root, '.tmp/dataverse-schema-contract.json', `${JSON.stringify({
    schemaVersion: 1,
    tables: [{
      logicalName: 'cr_item',
      columns: [{
        logicalName: 'cr_status',
        type: 'choice',
        options: Array.from({ length: 6 }, (_, index) => ({ value: 100000000 + index, label: `State ${index + 1}` })),
      }],
    }],
  }, null, 2)}\n`);
  write(root, 'native-app-plan.md', `# Fixture\n\n## Screens\n\n### Screen Map\n\n| Screen | Route | File | Presentation | Archetype | Purpose | Data | Native | Entity icon | Source |\n|---|---|---|---|---|---|---|---|---|---|\n| Items | \`/(app)/home\` | \`app/(app)/home.tsx\` | default | List | Browse items | Preview | - | \`cr_item=cube-outline\` | new |\n\n### Per-Screen Specs\n\n#### Screen 1 - Items (\`/(app)/home\`)\n\n- **File:** \`app/(app)/home.tsx\`\n- **Cardinality:** filters=6 -> chips-overflow; choice-cr_status=6 -> inline-radio-list; listRows=12 -> plain-list; actions=1 -> single-primary; images=1 -> image-hero\n- **Sort options:** cr_createdat desc=Newest (default); cr_validfrom asc=Valid from; cr_name asc=Name A-Z\n${item.batchMode ? '- **Batch actions:** approve=Approve; reject=Reject (destructive)\n' : ''}- **Field visibility:** cr_journalref=cr_status in (Posted)\n- **Warning remedies:** damage-warning -> add-evidence\n- **Input roles:** cr_receivedqty=count-against-expected -> numeric-stepper\n- **Entity icons:** cr_item=cube-outline\n- **Selection meaning:** Draft=warning\n- **Rollups:** received=sum(rows.cr_receivedqty)\n`);
  if (item.carouselMode) fs.appendFileSync(path.join(root, 'native-app-plan.md'), '- **Carousel:** cr_item.cr_imageurl; items=3\n');
  if (item.chartMode) fs.appendFileSync(path.join(root, 'native-app-plan.md'), '- **Chart:** series-chart; form=bar; x=cr_month; y=cr_intakes; points=6; caption=42 intakes in the last 6 months; empty=No data for the last 6 months\n');
  write(root, 'assets/item.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  write(root, 'assets/test.ttf', Buffer.from([0, 1, 0, 0]));
  write(root, 'app/(app)/home.tsx', `import React from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import productImage from '../../assets/item.png';
import fontAsset from '../../assets/test.ttf';
import { previewItem, previewRows } from '@/generated/services/PreviewService';
import { chartTokens, tokens } from '../../brand/tokens';

export default function HomeScreen() {
  const router = useRouter();
  return (
    <View testID="screen:items" style={{ flex: 1, height: '100%', backgroundColor: tokens.color.bg }} dataSet={{ fontAsset }}>
      <StatusBar />
      <ScrollView testID="scroll:items" style={{ flex: 1, marginBottom: previewItem.batchMode ? 156 : 76 }} contentContainerStyle={{ padding: tokens.space.lg, paddingBottom: previewItem.batchMode ? 156 : 76 }}>
        <View testID="cardinality:filters:chips-overflow" style={{ height: 1 }} />
        <View testID="cardinality:choice-cr_status:inline-radio-list" style={{ height: 1 }} />
        <View testID="cardinality:listRows:plain-list" style={{ height: 1 }} />
        <View testID="cardinality:actions:single-primary" style={{ height: 1 }} />
        <View testID="cardinality:images:image-hero" style={{ height: 1 }} />
        <View testID="mirror-row:summary" style={{ flexDirection: 'row', gap: 8 }}>
          <View dataSet={{ logicalOrder: '1' }} style={{ width: 40, height: 8 }} />
          <View dataSet={{ logicalOrder: '2' }} style={{ width: 40, height: 8 }} />
        </View>
        <View testID="sort-control:inline-chips" style={{ minHeight: 24 }}>
          <Text testID="sort-active:cr_createdat:desc" style={{ color: tokens.color.textMuted, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>Sort: Newest</Text>
        </View>
        <Text style={{ color: tokens.color.text, fontSize: 28, lineHeight: 36, fontWeight: '400' }}>{previewItem.name}</Text>
        {previewItem.photoHero ? (
          <View testID="gradient:imageScrim:legibility" style={{ width: 96, height: 64, backgroundImage: 'linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.72))' }}>
            <Image testID="hero" source={{ uri: productImage }} style={{ width: 96, height: 64 }} accessibilityLabel={previewItem.name} />
          </View>
        ) : (
          <Image source={{ uri: productImage }} style={{ width: 48, height: 48 }} accessibilityLabel={previewItem.name} />
        )}
        {previewItem.carouselMode && (
          <ScrollView
            testID="carousel:cr_item:carousel-row"
            dataSet={{ carouselSnap: 'start', autoAdvance: 'false', preservePosition: 'true' }}
            horizontal
            snapToInterval={192}
            snapToAlignment="start"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12, paddingRight: 48 }}
          >
            {previewRows.map((row, index) => (
              <View key={row.id} testID={\`carousel-item:\${row.id}\`} accessibilityLabel={\`\${index + 1} of \${previewRows.length}\`} style={{ width: 180, height: 120 }}>
                <Image source={{ uri: productImage }} style={{ width: 180, height: 120 }} accessibilityLabel={row.name} />
              </View>
            ))}
          </ScrollView>
        )}
        <View testID="sort-results" dataSet={{ sortReset: 'top' }}>
        {previewRows.slice(0, 2).map((row) => (
          <Pressable
            key={row.id}
            testID={\`row:item:\${row.id}\`}
            dataSet={{ recordState: row.workflowState }}
            accessibilityRole="button"
            style={{ minHeight: 112, marginTop: 16, padding: 16, backgroundColor: tokens.color.surface }}
          >
            <Ionicons testID="entity-icon:cr_item:cube-outline" name="cube-outline" size={tokens.size.iconSize} color={tokens.color.primary} />
            <View testID="row-meta">
              <Text style={{ color: tokens.color.text, fontSize: 16, lineHeight: 24, fontWeight: '500' }}>{row.name}</Text>
              <Text style={{ color: tokens.color.textMuted, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>{row.location}</Text>
              <Text style={{ color: tokens.color.textMuted, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>{row.statusLabel}</Text>
              <Text style={{ color: tokens.color.textMuted, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>{row.reference}</Text>
              {row.workflowState === 'Posted' && (
                <Text testID="conditional-field:cr_journalref" style={{ color: tokens.color.textMuted, fontSize: 12, lineHeight: 16, fontWeight: '500' }}>{row.journalRef}</Text>
              )}
            </View>
          </Pressable>
        ))}
        </View>
        {previewItem.chartMode && (
          <View
            testID="chart:series-chart:bar"
            dataSet={{ chartSeriesToken: 'seriesPrimary', chartGridToken: 'grid', chartPointCount: '6' }}
            accessibilityLabel="42 intakes in the last 6 months"
            style={{ marginTop: 16 }}
          >
            <View style={{ height: 160, flexDirection: 'row', alignItems: 'flex-end', gap: 8, borderBottomWidth: 1, borderBottomColor: chartTokens.grid }}>
              {[4, 6, 5, 8, 9, 10].map((value, index) => (
                <View key={index} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                  <View testID={\`chart-point:\${index}\`} style={{ width: '70%', height: 12 + value * 10, backgroundColor: chartTokens.seriesPrimary }} />
                  <Text testID="chart-axis-label" style={{ color: tokens.color.textMuted, fontSize: 11, lineHeight: 16, fontWeight: '500' }}>{\`M\${index + 1}\`}</Text>
                </View>
              ))}
            </View>
            <Text testID="chart-caption" style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>42 intakes in the last 6 months</Text>
          </View>
        )}
        <View style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text testID="warning:damage-warning" style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>Evidence required</Text>
          <Pressable testID="remedy:add-evidence" accessibilityRole="button" style={{ minHeight: 48, minWidth: 120, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.color.surface }}>
            <Text style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>Add evidence</Text>
          </Pressable>
        </View>
        <View testID="input-role:cr_receivedqty:numeric-stepper" style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable testID="stepper-decrement:cr_receivedqty" accessibilityRole="button" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.color.surface }}>
            <Text style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>-</Text>
          </Pressable>
          <Text style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>8 of 10 received</Text>
          <Pressable testID="stepper-increment:cr_receivedqty" accessibilityRole="button" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.color.surface }}>
            <Text style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>+</Text>
          </Pressable>
        </View>
        <Text testID="rollup:received" style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>12 received</Text>
      </ScrollView>
      {previewItem.batchMode ? (
        <View testID="selection-mode:active" dataSet={{ selectionEntry: 'long-press', selectionExitRestores: 'primary' }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
          <View testID="pinned:selection-toolbar" style={{ position: 'absolute', left: 16, right: 16, bottom: 108, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text testID="selection-count" style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>2 selected</Text>
            <Pressable testID="selection-select-all" accessibilityRole="button" style={{ minWidth: 96, height: 48, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>Select all</Text></Pressable>
            <Pressable testID="selection-exit" accessibilityRole="button" style={{ minWidth: 64, height: 48, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>Done</Text></Pressable>
          </View>
          <View testID="pinned:batch-actions" style={{ position: 'absolute', height: 80, left: 16, right: 16, bottom: 20, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View testID="batch-actions:buttons" style={{ flex: 1, flexDirection: 'row', gap: 8 }}>
              <Pressable testID="batch-action:approve" accessibilityRole="button" style={{ flex: 1, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.color.surface }}><Text style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>Approve</Text></Pressable>
              <Pressable testID="batch-destructive:reject" accessibilityLabel="Reject 2 requests" accessibilityRole="button" style={{ flex: 1, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.color.surface }}><Text style={{ color: tokens.color.text, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>Reject 2</Text></Pressable>
            </View>
          </View>
        </View>
      ) : (
        <View testID="pinned:actions" style={{ position: 'absolute', height: 56, left: 16, right: 16, bottom: 20 }}>
          <Pressable testID="cta-primary" accessibilityRole="button" onPress={() => router.push('/item')} style={{ alignItems: 'center', justifyContent: 'center', height: 56, backgroundColor: tokens.color.primary }}>
            <Text style={{ color: tokens.color.onPrimary, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>Open item</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
`);
  return root;
}

const dependencyProject = process.env.MOBILE_HARNESS_TEST_PROJECT;

test('directly bundles and checks three generated app domains', { skip: !dependencyProject }, (t) => {
  const items = [
    { id: 'inv-001', name: 'Cabin Chronograph', location: 'Forward galley', statusLabel: 'Available', reference: 'SKU-WAT-0042', photoHero: true, batchMode: false, carouselMode: true, chartMode: false },
    { id: 'ops-001', name: 'North Dock Inspection', location: 'Loading Gate A', statusLabel: 'In review', reference: 'INS-2026-0042', photoHero: false, batchMode: true, carouselMode: false, chartMode: false },
    { id: 'rehab-001', name: 'River Otter Intake', location: 'Aquatic Ward', statusLabel: 'Stable', reference: 'CASE-2026-0042', photoHero: false, batchMode: false, carouselMode: false, chartMode: true },
  ];
  for (const item of items) {
    const root = generatedFixture(t, dependencyProject, item);
    const result = spawnSync(process.execPath, [
      path.join(harnessDir, 'run.js'), '--project', root, '--screen', 'app/(app)/home.tsx', '--check', 'all',
    ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.equal(result.status, 0, `${item.name}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /CONTACT SHEET/);
    assert.equal(fs.existsSync(path.join(root, '.tmp/prototype-harness-contact-sheet.png')), true);
    for (const id of ['layout.scroll-padding', 'accessibility.contrast', 'content.raw-values', 'content.seed-hero', 'interaction.overlap', 'content.primary-label']) {
      assert.match(result.stdout, new RegExp(`${id}[^\\n]*PASS`));
    }
    assert.match(result.stdout, /content\.density[^\n]+PASS report=[^\n]+"wouldMeetFloor":false/);
    assert.match(result.stdout, /"element":"filters","count":6,"expected":"chips-overflow"/);
    assert.match(result.stdout, /"element":"choice-cr_status"[^\n]+"source":"schema-contract"/);
    assert.match(result.stdout, /"element":"listRows"[^\n]+"source":"seed-vocabulary"/);
    for (const metric of ['typeRoles', 'surfaceCount', 'accentBudgets', 'shapeScale', 'iconSizes', 'primaryActions', 'rowSignatures', 'gradients']) {
      assert.match(result.stdout, new RegExp(`"${metric}"`));
    }
    assert.match(result.stdout, /"hardFailures":\[\]/);
    assert.match(result.stdout, item.photoHero ? /"gradients":\["imageScrim"\]/ : /"gradients":\[\]/);
    assert.match(result.stdout, /"fieldVisibilityContracts":1/);
    assert.match(result.stdout, /"warningRemedyContracts":1/);
    assert.match(result.stdout, /"inputRoleContracts":1/);
    assert.match(result.stdout, /"cr_item":\["cube-outline"\]/);
    assert.match(result.stdout, /"optionCount":3/);
    assert.match(result.stdout, /"expectedPattern":"inline-chips"/);
    assert.match(result.stdout, /"active":"sort-active:cr_createdat:desc"/);
    if (item.batchMode) {
      assert.match(result.stdout, /"selectedCount":2/);
      assert.match(result.stdout, /"actionCount":2/);
      assert.match(result.stdout, /"pattern":"batch-actions:buttons"/);
    }
    if (item.carouselMode) {
      assert.match(result.stdout, /"itemCount":3/);
      assert.match(result.stdout, /"entity":"cr_item"/);
    }
    if (item.chartMode) {
      assert.match(result.stdout, /"kind":"series-chart"/);
      assert.match(result.stdout, /"form":"bar"/);
      assert.match(result.stdout, /"pointCount":6/);
      assert.match(result.stdout, /"seriesToken":"seriesPrimary"/);
      assert.match(result.stdout, /"caption":"42 intakes in the last 6 months"/);
    }
  }
});

test('Arabic browser matrix mirrors declared logical order', { skip: !dependencyProject }, (t) => {
  const root = generatedFixture(t, dependencyProject, {
    id: 'rtl-001', name: 'North Dock Inspection', location: 'Loading Gate A', statusLabel: 'In review',
    reference: 'INS-2026-0042', photoHero: false, batchMode: false, carouselMode: false, chartMode: false,
  });
  const result = spawnSync(process.execPath, [
    path.join(harnessDir, 'run.js'), '--project', root, '--screen', 'app/(app)/home.tsx',
    '--check', 'rtl-mirrored-order', '--locale', 'ar',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /layout\.rtl\.mirrored-order[^\n]*PASS/);
});

test('one bundle renders seven screens materially faster than seven single runs', { skip: !dependencyProject }, (t) => {
  const root = generatedFixture(t, dependencyProject, {
    id: 'perf-001', name: 'North Dock Inspection', location: 'Loading Gate A', statusLabel: 'In review',
    reference: 'INS-2026-0042', photoHero: false, batchMode: false, carouselMode: false, chartMode: false,
  });
  for (let index = 2; index <= 7; index += 1) {
    write(root, `app/(app)/screen-${index}.tsx`, `export { default } from './home';\n`);
  }
  const command = (extra = []) => spawnSync(process.execPath, [
    path.join(harnessDir, 'run.js'), '--project', root, '--check', 'accessibility.contrast', ...extra,
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const singleStarted = performance.now();
  const single = command(['--screen', 'app/(app)/home.tsx']);
  const singleMs = performance.now() - singleStarted;
  assert.equal(single.status, 0, `${single.stdout}\n${single.stderr}`);
  const allStarted = performance.now();
  const all = command();
  const allMs = performance.now() - allStarted;
  assert.equal(all.status, 0, `${all.stdout}\n${all.stderr}`);
  assert.ok(allMs < singleMs * 7, `seven-screen ${allMs.toFixed(0)}ms versus single ${singleMs.toFixed(0)}ms`);
  assert.equal(fs.existsSync(path.join(root, '.tmp/prototype-harness-contact-sheet.png')), true);
});