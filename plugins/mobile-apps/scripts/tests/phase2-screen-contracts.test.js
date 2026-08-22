'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('screen templates publish the complete cardinality pattern table', () => {
  const reference = read('shared/references/screen-templates.md');
  for (const contract of [
    '| Filters | 1-4 | `chips` |',
    '| Filters | 5-8 | `chips-overflow` |',
    '| Filters | >8 | `filter-sheet-search` |',
    '| Choice input | 2-3 | `segmented-control` |',
    '| Choice input | 4-6 | `inline-radio-list` |',
    '| Choice input | >6 | `picker-sheet-search` |',
    '| List rows | 1-20 | `plain-list` |',
    '| List rows | 21-200 | `search-section-groups` |',
    '| List rows | >200 | `search-virtualized-sticky-index` |',
    '| Images | 1 | `image-hero` |',
    '| Images | 2-4 | `thumbnail-row` |',
    '| Images | >4 | `gallery-count-badge` |',
  ]) {
    assert.match(reference, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(reference, /cardinality:<element-key>:<pattern-key>/);
});

test('planner and prototype builder share cardinality and image contracts', () => {
  const planner = read('agents/screen-planner.md');
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  const templates = read('shared/references/screen-templates.md');
  assert.match(planner, /Step 0c — Load Cardinality Inputs/);
  assert.match(planner, /seed-vocabulary\.json/);
  assert.match(planner, /dataverse-schema-contract\.json/);
  assert.match(planner, /filters=6 -> chips-overflow/);
  assert.match(planner, /choice-cr_status=6 -> inline-radio-list/);
  assert.match(planner, /listRows=12 -> plain-list/);
  assert.match(skill, /testID="cardinality:<element-key>:<pattern-key>"/);
  assert.match(skill, /percentage dimensions are forbidden/);
  assert.match(skill, /local template placeholder/);
  assert.match(templates, /explicit aspect ratio or fixed width and height/);
  assert.match(templates, /Meaningful images have an accessible description/);
});

test('prototype image generation uses the shipped local placeholder', () => {
  const generator = read('skills/create-mobile-prototype/scripts/gen-mock-services.js');
  const placeholder = path.join(pluginRoot, 'template/assets/image-placeholder.png');
  assert.equal(fs.existsSync(placeholder), true);
  const header = fs.readFileSync(placeholder).subarray(0, 8);
  assert.deepEqual([...header], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(generator, /IMAGE_PLACEHOLDER_PATH/);
  assert.match(generator, /data:image\/png;base64/);
  assert.doesNotMatch(generator, /unsplash\.com|images\.unsplash|picsum\.photos/i);
});

test('design references require source-derived token gradients only', () => {
  const planning = read('shared/references/design-planning.md');
  const templates = read('shared/references/screen-templates.md');
  const tokens = read('shared/references/tamagui-custom-tokens.md');
  assert.doesNotMatch(planning, /Tech \/ IoT \| Dark option with accent gradients/);
  assert.match(templates, /image-hero.*approved `imageScrim` gradient/s);
  assert.match(tokens, /content`, `state`, `magnitude`, or `legibility`/);
  assert.match(tokens, /Never place a gradient on a button/);
});

test('shared Gradient declares a mechanical token and source contract', () => {
  const components = read('shared/samples/src/components/index.tsx');
  const sharedTokens = read('shared/samples/src/tokens/index.ts');
  assert.match(components, /source: 'content' \| 'state' \| 'magnitude' \| 'legibility'/);
  assert.match(components, /testID={`gradient:\$\{name\}:\$\{source\}`}/);
  assert.doesNotMatch(components, /gradient = 'hero'|<Gradient name={gradient}/);
  assert.match(components, /<YStack bg="\$accentBase"/);
  assert.match(sharedTokens, /imageScrim/);
  assert.doesNotMatch(sharedTokens, /\bhero:|\bdanger:|\bsuccess:|\bwarm:|\bneutral:/);
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /gradientBound: '<schema-field>'/);
});

test('planner and builder publish conditional UX contracts without changing the shared builder agent', () => {
  const planner = read('agents/screen-planner.md');
  const templates = read('shared/references/screen-templates.md');
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  for (const field of ['Field visibility', 'Warning remedies', 'Input roles', 'Entity icons', 'Selection meaning', 'Rollups']) {
    assert.match(planner, new RegExp(field));
  }
  assert.match(planner, /Entity icon \| Source/);
  assert.match(templates, /conditional-field:<logical-name>/);
  assert.match(templates, /warning:<key>/);
  assert.match(templates, /count-against-expected/);
  assert.match(templates, /entity-icon:<logical-name>:<icon-name>/);
  assert.match(skill, /data-record-state/);
  assert.match(skill, /rollup:<name>/);
  const designGenerator = read('scripts/generate-prototype-design-system.js');
  assert.match(designGenerator, /selected cautionary or negative option in the accent colour/);
});

test('every shipped shared component is present in generated context inventory', () => {
  const components = read('shared/samples/src/components/index.tsx');
  const context = read('shared/context-pack.md');
  const exports = [...components.matchAll(/^export function ([A-Za-z][A-Za-z0-9]*)/gm)].map((match) => match[1]);
  assert.equal(exports.length, 24);
  for (const component of exports) {
    assert.match(context, new RegExp(`^- \`${component}\`$`, 'm'), `missing context inventory entry for ${component}`);
  }
});

test('existing scan and numeric patterns have mandatory selection rules', () => {
  const planner = read('agents/screen-planner.md');
  const templates = read('shared/references/screen-templates.md');
  assert.match(templates, /Select `scan-geofence-gate` whenever/);
  assert.match(templates, /Select `numeric-stepper` for every `count-against-expected`/);
  assert.match(planner, /Operational pattern: scan-geofence-gate` is mandatory/);
  assert.match(planner, /emit `numeric-stepper` \(or `line-item-stepper-row`/);
});

test('every Task 17 key has a planner selection rule and charts use verified exact pins', () => {
  const planner = read('agents/screen-planner.md');
  const templates = read('shared/references/screen-templates.md');
  const dependencies = read('shared/references/javascript-dependency-planning.md');
  for (const key of ['sort-control', 'multi-select-list', 'batch-action-bar', 'carousel-row', 'sparkline', 'series-chart']) {
    assert.match(templates, new RegExp(`\`${key}\``));
  }
  for (const field of ['Sort options', 'Batch actions', 'Carousel', 'Chart']) {
    assert.match(planner, new RegExp(`\\*\\*${field}\\*\\*`));
  }
  assert.match(templates, /screen's purpose is browsing a collection, not working a queue/i);
  assert.match(planner, /No ordered numeric series means no chart/);
  assert.match(dependencies, /d3-scale@4\.0\.2/);
  assert.match(dependencies, /@types\/d3-scale@4\.0\.9/);
  assert.match(dependencies, /no install lifecycle hook/);
  assert.match(dependencies, /react-native-svg/);
});