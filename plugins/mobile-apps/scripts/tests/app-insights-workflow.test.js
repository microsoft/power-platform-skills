'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');

test('phased creation defers host observability without losing explicitly requested events', () => {
  const intake = read('skills/create-mobile-app/references/phase-01-intake.md');
  const planner = read('agents/native-app-planner.md');
  assert.match(intake, /post-creation `\/setup-app-insights`/);
  assert.match(intake, /do not enable telemetry during creation/);
  assert.match(intake, /Preserve explicitly requested custom-event names, triggers and approved/);
  assert.match(planner, /\/setup-app-insights/);
  assert.match(planner, /Do not model it as a connector, native\s+capability, table or telemetry screen/);
  assert.match(planner, /Preserve explicit named custom events/);
  const launch = read('skills/create-mobile-app/references/phase-10-run.md');
  assert.match(launch, /post-creation `\/setup-app-insights` handoff/);
  assert.match(launch, /Do not configure Application Insights\s+during creation/);
});

test('screen contracts retain opt-in custom-event API, privacy and timing boundaries', () => {
  assert.match(read('agents/screen-planner.md'), /Explicit named events add `Custom events`/);
  const builder = read('agents/screen-builder.md');
  assert.match(builder, /Only explicit `Custom events` specs/);
  assert.match(builder, /references\/screen-builder\/mutations\.md/);

  for (const file of [
    'shared/references/screen-planning/spec-contract.md',
    'agents/references/screen-builder/mutations.md',
  ]) {
    const source = read(file).replace(/\s+/g, ' ');
    assert.match(source, /getCustomEventsLogger/);
    assert.match(source, /never use `getAppLogger\(\)`|never `getAppLogger\(\)`/i);
    assert.match(source, /trackScenario\(\)/);
    for (const property of [
      'form values', 'free text', 'record titles', 'personal identifiers', 'tokens',
      'precise coordinates', 'nested objects', 'complete URLs',
    ]) {
      assert.ok(source.includes(property), `${file} must exclude ${property}`);
    }
    assert.match(source, /duration_ms/);
  }
});

test('scaffold preserves provider appConfig wiring for host observability', () => {
  const scaffold = read('skills/create-mobile-app/references/phase-03-scaffold.md');
  assert.match(scaffold, /PowerAppsProvider/);
  assert.match(scaffold, /appConfig/);
  assert.match(scaffold, /app\.json/);
  assert.match(read('template/app/_layout.tsx'), /appConfig=\{appConfig\}/);
});

test('configuration-only edits delegate without re-entering planning or preview', () => {
  const edit = read('skills/edit-app/SKILL.md');
  const start = edit.indexOf('### Step 0.5');
  const end = edit.indexOf('### Step 1 ');
  assert.ok(start >= 0 && end > start);
  const fastPath = edit.slice(start, end);
  assert.match(fastPath, /Invoke skill: \/setup-app-insights/);
  assert.match(fastPath, /do not run the planner, data-model, native, design, screen, or preview flows/);
  assert.match(fastPath, /defaulting to \*\*No\*\*/);
  assert.match(fastPath, /stop; do not continue to Step 1/);
  assert.match(fastPath, /source changes/);
});
