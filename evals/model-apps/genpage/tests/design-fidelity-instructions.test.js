'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('shared rules prioritize user-directed visual design over MDA defaults', () => {
  const rules = read('plugins/model-apps/references/rules.md');

  assert.match(rules, /User design direction overrides default MDA styling/);
  assert.match(rules, /User-provided screenshot or mockup[\s\S]+Fluent\/MDA defaults only when no direction exists/);
  assert.match(rules, /Explicit design values may use CSS[\s\S]+literals or custom properties/);
});

test('create planning records a concrete design-fidelity contract', () => {
  const planner = read('plugins/model-apps/agents/genpage-planner.md');
  const schema = read('plugins/model-apps/references/plan-schema.md');

  assert.match(planner, /capture it as a hard requirement/);
  assert.match(planner, /Do not silently[\s\S]+fall back to MDA styling/);
  assert.match(schema, /Design source:/);
  assert.match(schema, /Fidelity notes:/);
});

test('single-page and multi-page builders enforce the same design precedence', () => {
  const skill = read('plugins/model-apps/skills/genpage/SKILL.md');
  const builder = read('plugins/model-apps/agents/genpage-page-builder.md');

  assert.match(skill, /Treat `## Design Preferences` as acceptance criteria/);
  assert.match(builder, /Treat the plan's Design Preferences as acceptance criteria/);
  assert.match(builder, /rather[\s\S]+than normalizing the result to stock Fluent\/MDA/);
});

test('edit planning and execution preserve requested visual identity', () => {
  const planner = read('plugins/model-apps/agents/genpage-edit-planner.md');
  const editFlow = read('plugins/model-apps/skills/genpage/edit-flow.md');

  assert.match(planner, /### Design Fidelity/);
  assert.match(planner, /Preserve functionality, not obsolete visual defaults/);
  assert.match(editFlow, /visual requirements in the approved[\s\S]+override default MDA styling/);
  assert.match(editFlow, /do not normalize the[\s\S]+page back to stock MDA/);
});
