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
  assert.match(dispatcher, /Do not preload both instruction files/);
  assert.doesNotMatch(dispatcher, /style-picker\.md|reference-intake\.md|input-modes\.md|brand-examples\.md/);
  assert.doesNotMatch(dispatcher, /prototype-semantic-plan/);
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
    /design-context-evidence\.json/,
    /designModelCalls: 1/,
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
