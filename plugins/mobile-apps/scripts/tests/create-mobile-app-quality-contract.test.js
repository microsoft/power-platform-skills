'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { composeCreateMobileAppWorkflow } = require('./workflow-test-helpers');

const pluginRoot = path.resolve(__dirname, '../..');
const skill = composeCreateMobileAppWorkflow(pluginRoot);
const sampleDataSkill = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'add-sample-data', 'SKILL.md'),
  'utf8',
);
const buildPlanProtocol = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'build-plan.md'),
  'utf8',
);

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

test('live Build Plan starts after proceed and remains separate from design preview', () => {
  const setup = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'phase-0-setup.md'),
    'utf8',
  );
  const previewIndex = setup.indexOf('### Step 2c — Plan preview');
  const appIdentityIndex = setup.indexOf('scripts/lib/app-identity.js', previewIndex);
  const buildPlanIndex = setup.indexOf('launch its loopback server', appIdentityIndex);
  assert.ok(previewIndex >= 0);
  assert.ok(appIdentityIndex > previewIndex);
  assert.ok(buildPlanIndex > appIdentityIndex);
  assert.doesNotMatch(setup.slice(0, previewIndex), /_build_plan\.html|mobile-build-plan\.js/);

  assert.match(buildPlanProtocol, /mobile-build-plan\.js" serve/);
  assert.match(buildPlanProtocol, /127\.0\.0\.1/);
  assert.match(buildPlanProtocol, /tokenless standalone `_build_plan\.html`/);
  assert.match(buildPlanProtocol, /never parses HTML or Mermaid back into a\s+contract/);
  assert.match(buildPlanProtocol, /invalidates Gate 1 and every downstream approval/);
  for (const phase of [
    'requirements',
    'experience',
    'data-model',
    'architecture',
    'design',
    'scaffold',
    'dataverse',
    'navigation',
    'screens',
    'validation',
  ]) {
    assert.match(buildPlanProtocol, new RegExp(`\\b${phase}\\b`));
  }

  const scaffoldStart = skill.indexOf('# Scaffold and Experience Approval');
  const scaffoldEnd = skill.indexOf('# Data, Native Capabilities, and Connectors');
  const scaffold = skill.slice(scaffoldStart, scaffoldEnd);
  assert.match(scaffold, /separate from `_build_plan\.html`/);
  assert.match(scaffold, /at most three phone frames/);
  assert.match(scaffold, /remain state controls on those frames rather than routes/);
});

test('browser data-model edits are checked before approvals and mutation', () => {
  const editChecks = skill.match(/mobile-build-plan-edits\.json/g) || [];
  assert.ok(editChecks.length >= 4, 'expected edit-journal checks at approval and mutation boundaries');
  assert.match(skill, /newer data-model revision cancels the pending handoff/);
  assert.match(skill, /newer edit blocks Step 8 and returns through Gate 1/);
  assert.match(buildPlanProtocol, /After\s+`.tmp\/dataverse-metadata-execution-journal\.json`/);
  assert.match(buildPlanProtocol, /subsequent schema work belongs to `\/edit-app`/);
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

test('sample fixtures are led by validated product contracts rather than schema names', () => {
  for (const artifact of [
    'product-experience-contract.json',
    'product-scope-contract.json',
    'workflow-journey-contract.json',
    'compiled-screen-build-pack.json',
  ]) {
    assert.match(sampleDataSkill, new RegExp(artifact.replaceAll('.', '\\.')));
  }
  assert.match(sampleDataSkill, /compile-screen-build-pack\.js --check/);
  assert.match(sampleDataSkill, /compile-sample-data-obligations\.js/);
  assert.match(sampleDataSkill, /\.tmp\/sample-data-obligations\.json/);
  assert.match(sampleDataSkill, /fixture-coverage matrix/);
  assert.match(sampleDataSkill, /schema constrains/i);
  assert.match(sampleDataSkill, /partial contract set is not a legacy project/i);
  assert.match(sampleDataSkill, /must not classify an unfamiliar product from table names/i);
});

test('final summary declares the same number of options that it renders', () => {
  assert.match(skill, /present exactly 5 options/);
  assert.match(skill, /5\. Configure auth later/);
  assert.doesNotMatch(skill, /present exactly (?:these )?4 options/);
});
