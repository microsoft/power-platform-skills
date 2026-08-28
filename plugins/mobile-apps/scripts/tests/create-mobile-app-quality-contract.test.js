'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { composeCreateMobileAppWorkflow } = require('./workflow-test-helpers');

const pluginRoot = path.resolve(__dirname, '../..');
const skill = composeCreateMobileAppWorkflow(pluginRoot);

test('template preparation is delegated to the deterministic script', () => {
  const start = skill.indexOf('### Step 5 — Prepare existing template');
  const end = skill.indexOf('### Step 6 — Initialize');
  const step = skill.slice(start, end);

  assert.match(step, /scripts\/prepare-mobile-template\.js/);
  assert.match(step, /must not create, reset, delete, or\s+write anything under `src\/generated\/`/);
  assert.doesNotMatch(step, /rm\s+-rf[\s\S]*src\/generated/);
  assert.doesNotMatch(step, /src\/generated\/index\.ts[\s\S]*printf/);
  assert.doesNotMatch(step, /\ncp\s+.*shared\/samples/);
  assert.doesNotMatch(step, /baseUrl\s*=/);
  assert.doesNotMatch(step, /Write `app\/_layout\.tsx`/);
});

test('environment discovery is non-persisting before the rough plan gate', () => {
  const previewIndex = skill.indexOf('### Step 2c — Plan preview');
  const beforePreview = skill.slice(0, previewIndex);
  assert.match(
    beforePreview,
    /resolve-environment\.js" "\$TARGET_ENV" --no-cache/,
  );
  assert.doesNotMatch(beforePreview, /printf '%s\\n' "\$ENV_JSON" > \.resolved-environment\.json/);
  assert.doesNotMatch(beforePreview, /scripts\/lib\/app-identity\.js/);

  const planningStart = skill.indexOf('### Step 3.0 — Foreground Dataverse planning');
  const planningEnd = skill.indexOf('Build `<DATAVERSE_CONCEPTS>`', planningStart);
  assert.match(
    skill.slice(planningStart, planningEnd),
    /resolve-environment\.js" "\$ACTIVE_ENV_ID" --no-cache/,
  );
});

test('app identity and Power Apps initialization respect existing state', () => {
  const previewStart = skill.indexOf('### Step 2c — Plan preview');
  const planningStart = skill.indexOf('### Step 2d — Template-only mode');
  const preview = skill.slice(previewStart, planningStart);
  assert.match(preview, /After `proceed`, and only after `proceed`, initialize the app identity/);
  assert.match(preview, /scripts\/lib\/app-identity\.js/);

  const initializeStart = skill.indexOf('### Step 6 — Initialize');
  const initializeEnd = skill.indexOf('### Step 6.5 — Verify dependencies');
  const initialize = skill.slice(initializeStart, initializeEnd);
  assert.match(initialize, /CONFIG_ENV_ID=/);
  assert.match(initialize, /initialization skipped/);
  assert.match(initialize, /existing power\.config\.json targets/);
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

test('final summary declares the same number of options that it renders', () => {
  assert.match(skill, /present exactly 5 options/);
  assert.match(skill, /5\. Configure auth later/);
  assert.doesNotMatch(skill, /present exactly (?:these )?4 options/);
});
