'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const skillPath = path.resolve(
  __dirname,
  '../../skills/create-mobile-app/SKILL.md',
);
const skill = fs.readFileSync(skillPath, 'utf8');

test('foreground Dataverse planning bypasses cached environment resolution', () => {
  const planningStart = skill.indexOf('### Step 3.0 — Foreground Dataverse planning');
  const planningEnd = skill.indexOf(
    'Build `<working_dir>/.tmp/dataverse-concepts.json`',
    planningStart,
  );
  assert.notStrictEqual(planningStart, -1);
  assert.notStrictEqual(planningEnd, -1);
  assert.match(
    skill.slice(planningStart, planningEnd),
    /resolve-environment\.js" "\$ACTIVE_ENV_ID" --no-cache/,
  );
});

test('offline setup follows materialized Dataverse data and never infers connector-only from absence', () => {
  const dataModel = skill.indexOf('### Step 8 — Apply data model');
  const sampleData = skill.indexOf('### Step 8.5 — Seed sample data');
  const offline = skill.indexOf('### Step 8.85 — Offline profile');
  const native = skill.indexOf('### Step 9 — Apply native capabilities');

  assert.ok(dataModel < sampleData);
  assert.ok(sampleData < offline);
  assert.ok(offline < native);
  assert.doesNotMatch(skill, /### Step 6\.85/);
  assert.match(skill, /Do not classify a missing\s+manifest as connector-only/);
  assert.match(skill, /Missing,\s+malformed, or empty manifests are `BLOCKED/);
  assert.match(skill, /seeding step fails for a non-manifest reason[\s\S]*continue to Step 8\.85/);
});

test('template preparation is delegated to the deterministic script', () => {
  const start = skill.indexOf('### Step 5 — Prepare existing template');
  const end = skill.indexOf('### Step 6 — Initialize');
  const step = skill.slice(start, end);

  assert.match(step, /scripts\/prepare-mobile-template\.js/);
  assert.match(step, /JSON_STRING_OF_WORKING_DIR/);
  assert.match(step, /JSON_STRING_OF_DISPLAY_NAME/);
  assert.match(step, /JSON_STRING_OF_SLUG/);
  assert.doesNotMatch(step, /--display-name "<displayName>"/);
  assert.match(step, /must not create, reset, delete, or\s+write anything under `src\/generated\/`/);
  assert.doesNotMatch(step, /rm\s+-rf[\s\S]*src\/generated/);
  assert.doesNotMatch(step, /src\/generated\/index\.ts[\s\S]*printf/);
  assert.doesNotMatch(step, /\ncp\s+.*shared\/samples/);
  assert.doesNotMatch(step, /baseUrl\s*=/);
  assert.doesNotMatch(step, /Write `app\/_layout\.tsx`/);
  assert.match(
    step,
    /`native-app-plan\.md` is expected here because Step 3 writes the approved plan before template preparation/,
  );
});

test('Power Apps initialization directly invokes the CLI with approved values', () => {
  const initializeStart = skill.indexOf('### Step 6 — Initialize');
  const initializeEnd = skill.indexOf('### Step 6.5 — Verify dependencies');
  const initialize = skill.slice(initializeStart, initializeEnd);
  assert.match(initialize, /npx power-apps init -t MobileApp/);
  assert.match(initialize, /--display-name "<displayName>"/);
  assert.match(initialize, /--environment-id "<environment-id>"/);
  assert.match(initialize, /approved Step 2 display name and Step 4 environment ID/);
  assert.match(initialize, /shell-safe quoting/);
  assert.match(initialize, /If a populated file remains, STOP/);
  assert.doesNotMatch(initialize, /spawnSync|node <<'NODE'/);
});
