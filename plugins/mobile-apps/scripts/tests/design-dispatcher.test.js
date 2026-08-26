'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');

test('design-system primary skill is a small mutually-exclusive dispatcher', () => {
  const dispatcher = read('skills/design-system/SKILL.md');
  const lines = dispatcher.split(/\r?\n/).length;
  assert.ok(lines >= 40 && lines <= 70, `dispatcher must remain 40-70 lines; found ${lines}`);
  assert.match(dispatcher, /CODE_APPS_NATIVE_ORCHESTRATING=1/);
  assert.match(dispatcher, /automatic-native\.md/);
  assert.match(dispatcher, /optional-modes\.md/);
  assert.match(dispatcher, /reference-ownership\.json/);
  assert.match(dispatcher, /Do not preload both instruction files/);
  assert.doesNotMatch(dispatcher, /style-picker\.md|reference-intake\.md|input-modes\.md|brand-examples\.md/);
  assert.doesNotMatch(dispatcher, /prototype-semantic-plan/);
});

test('reference ownership keeps the automatic path on six bounded rule families', () => {
  const manifest = JSON.parse(read('skills/design-system/reference-ownership.json'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.rules.selectExactlyOneMode, true);
  assert.equal(manifest.rules.manifestIsPlannerOutput, false);
  assert.deepEqual(manifest.modes['automatic-native'].owns, [
    'semantic-color-rules',
    'spacing-and-hierarchy-rules',
    'navigation-conventions',
    'accessibility-requirements',
    'media-policy',
    'component-conventions',
  ]);
  assert.deepEqual(manifest.modes['automatic-native'].pluginReferences, ['automatic-native.md']);
  assert.ok(manifest.modes['automatic-native'].forbiddenReferences.includes('optional-modes.md'));
  assert.ok(manifest.modes.optional.pluginReferences.includes('references/figma-extraction.md'));
  assert.ok(manifest.modes.optional.pluginReferences.includes('references/canvas-app-extraction.md'));
  assert.ok(manifest.modes.optional.pluginReferences.includes('references/vibe/style-picker.md'));
});

test('automatic native design owns full quality rules without optional reference loading', () => {
  const automatic = read('skills/design-system/automatic-native.md');
  for (const requirement of [
    /one dominant region/,
    /one visually primary action/,
    /FeatureCard/,
    /ProductCard/,
    /RecordRow/,
    /ResumeCard/,
    /CategoryTile/,
    /StatusSummary/,
    /remote-cdn-cached/,
    /Sticky actions clear tabs, keyboard, and device bottom inset/,
    /Dynamic Type/,
    /design-content-projection\.json/,
    /design-context-evidence\.json/,
    /designModelCalls: 1/,
    /"scope": "project or plugin"/,
  ]) assert.match(automatic, requirement);
  assert.doesNotMatch(automatic, /style-picker\.md|brand-examples\.md|reference-intake\.md|input-modes\.md/);
});

test('optional modes retain explicit brand, reference, gallery, refresh, theme, and history paths', () => {
  const optional = read('skills/design-system/optional-modes.md');
  for (const requirement of [
    /Brand, logo, URL, stylesheet, or design document/,
    /Figma/,
    /Screenshot or design intake/,
    /Canvas app, sibling code app, or Power Pages/,
    /Explicit style comparison or full design/,
    /Gallery or preview/,
    /Refresh and reskin/,
    /Dark mode and named themes/,
    /History, diff, and rollback/,
  ]) assert.match(optional, requirement);
  assert.match(optional, /gallery or HTML preview[\s\S]*never native evidence/i);
});
