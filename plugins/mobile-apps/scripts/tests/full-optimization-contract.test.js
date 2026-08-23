'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('shared full-scope optimization executables are present', () => {
  const expected = [
    'scripts/prepare-mobile-template.js',
    'scripts/build-screen-artifacts.js',
    'scripts/build-builder-context.js',
    'scripts/plan-native-batches.js',
    'scripts/run-tsc-gate.js',
    'scripts/run-validation-batch.js',
    'scripts/run-final-checks.js',
    'scripts/preview-lock.js',
    'scripts/pack-screen-waves.js',
    'scripts/record-optimization-state.js',
    'scripts/validate-screen-contracts.js',
  ];
  for (const relativePath of expected) {
    assert.equal(fs.existsSync(path.join(pluginRoot, relativePath)), true, `${relativePath} must exist`);
  }
});

test('real and prototype creation share deterministic preparation and screen artifacts', () => {
  const real = read('skills/create-mobile-app/SKILL.md');
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  for (const skill of [real, prototype]) {
    assert.match(skill, /prepare-mobile-template\.js/);
    assert.match(skill, /template-prep-receipt\.json/);
    assert.match(skill, /screen-contract\.json/);
    assert.match(skill, /build-screen-artifacts\.js/);
    assert.match(skill, /service-inventory\.json/);
    assert.match(skill, /build-builder-context\.js/);
    assert.match(skill, /builder-context/);
    assert.match(skill, /plan-native-batches\.js/);
    assert.match(skill, /run-tsc-gate\.js/);
    assert.match(skill, /run-validation-batch\.js/);
    assert.match(skill, /run-final-checks\.js/);
    assert.match(skill, /preview-lock\.js/);
    assert.match(skill, /pack-screen-waves\.js/);
    assert.match(skill, /record-optimization-state\.js/);
  }
});

test('planner and builders use hash-bound structured contracts', () => {
  const planner = read('agents/native-app-planner.md');
  const screenPlanner = read('agents/screen-planner.md');
  const builder = read('agents/screen-builder.md');

  assert.match(planner, /\.tmp\/screen-contract\.json/);
  assert.match(screenPlanner, /screen-contract\.json/);
  assert.match(screenPlanner, /scaffold/);
  assert.match(builder, /builder_context_path/);
  assert.match(builder, /build-builder-context\.js[\s\S]*check/);
  assert.match(builder, /BLOCKED.*context.*hash/i);
});

test('all hard TypeScript gates execute through incremental wrapper and final clean gate', () => {
  const real = read('skills/create-mobile-app/SKILL.md');
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const sync = read('skills/sync-from-plan/SKILL.md');
  for (const skill of [real, prototype, sync]) {
    assert.match(skill, /run-tsc-gate\.js/);
    assert.match(skill, /--gate/);
  }
  assert.match(real, /--clean/);
  assert.match(prototype, /--clean/);
  assert.match(sync, /--clean/);
});

test('validation, final checks, and previews are hash-bound and fail closed', () => {
  const real = read('skills/create-mobile-app/SKILL.md');
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const sync = read('skills/sync-from-plan/SKILL.md');
  for (const skill of [real, prototype, sync]) {
    assert.match(skill, /validation-receipt\.json/);
    assert.match(skill, /final-checks-receipt\.json/);
    assert.match(skill, /preview-lock\.json/);
    assert.match(skill, /discard.*preview|delete.*preview|remove.*preview/i);
  }
});

test('screen waves are complexity packed without a no-op agent probe', () => {
  const real = read('skills/create-mobile-app/SKILL.md');
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const sync = read('skills/sync-from-plan/SKILL.md');
  for (const skill of [real, prototype, sync]) {
    assert.match(skill, /screen-waves\.json/);
    assert.match(skill, /complexity/i);
  }
  assert.doesNotMatch(real, /screen_name: __preflight__/);
});
