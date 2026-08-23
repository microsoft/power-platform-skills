'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('planner emits a recommendation but never owns design confirmation', () => {
  const planner = read('agents/native-app-planner.md');

  assert.match(planner, /\.tmp\/design-recommendation\.json/);
  assert.match(planner, /"status": "recommendation-only"/);
  assert.match(planner, /Planner recommendation is not design approval/);
  assert.doesNotMatch(planner, /Design approved \(via screen preview at Gate 4\)/);
});

test('design-system reuses planner recommendation and converges every creation path', () => {
  const designSkill = read('skills/design-system/SKILL.md');

  assert.match(designSkill, /brand\/design-decision\.json/);
  assert.match(designSkill, /Do not reclassify the app when a valid planner recommendation exists/);
  assert.match(designSkill, /User-provided design input overrides the recommendation/);
  assert.match(designSkill, /Every creation branch converges on Sub-step 6 and Sub-step 7/);
  assert.match(designSkill, /finalize-design-decision\.js/);
  assert.match(designSkill, /decision_path: brand\/design-decision\.json/);
});

test('creation workflows require the canonical design decision before builders', () => {
  const realCreation = read('skills/create-mobile-app/SKILL.md');
  const prototypeCreation = read('skills/create-mobile-prototype/SKILL.md');

  for (const skill of [realCreation, prototypeCreation]) {
    assert.match(skill, /brand\/design-decision\.json/);
    assert.match(skill, /finalize-design-decision\.js[\s\S]*check/);
  }
});
