'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const skillPath = path.resolve(__dirname, '..', '..', 'skills/create-mobile-prototype/SKILL.md');

test('prototype screen-builder prompt carries all fifteen hard rules and fail-closed audit', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');
  const promptStart = skill.indexOf('```text\nData mode: prototype.');
  const promptEnd = skill.indexOf('\n```', promptStart + 3);
  assert.ok(promptStart >= 0 && promptEnd > promptStart, 'Step 8 prompt block is missing');
  const prompt = skill.slice(promptStart, promptEnd);
  for (const requirement of [
    'Tokens only',
    'testIDs by convention',
    'Bottom inset',
    'Catalogue hero',
    'Attribute chains',
    'Icons',
    'Status micro-copy',
    'Cardinality',
    'Images',
    'Discipline',
    'Conditional UX',
    'Sort',
    'Batch selection',
    'Carousel',
    'Charts',
    'brand/tokens.ts',
    'screen:<name>',
    'pinned:<what>',
    'row:<entity>:<id>',
    'row-meta',
    'cta-primary',
    'cta-secondary',
    'hero-eligible',
  ]) {
    assert.match(prompt, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(skill, /BLOCKED: prompt-injection-failed/);
  assert.match(skill, /Do not hand-fix the generated screens/);
});