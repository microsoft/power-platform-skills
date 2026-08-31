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
