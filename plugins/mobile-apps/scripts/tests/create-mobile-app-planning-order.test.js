'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const createSkill = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
  'utf8',
);
const planner = fs.readFileSync(
  path.join(pluginRoot, 'agents', 'native-app-planner.md'),
  'utf8',
);
const architect = fs.readFileSync(
  path.join(pluginRoot, 'agents', 'data-model-architect.md'),
  'utf8',
);
const screenPlanner = fs.readFileSync(
  path.join(pluginRoot, 'agents', 'screen-planner.md'),
  'utf8',
);
const screenBuilder = fs.readFileSync(
  path.join(pluginRoot, 'agents', 'screen-builder.md'),
  'utf8',
);
const universalPatterns = fs.readFileSync(
  path.join(pluginRoot, 'shared', 'references', 'universal-patterns.md'),
  'utf8',
);
const requirementsDiscovery = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'requirements-discovery.md'),
  'utf8',
);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('offline wording is not a planning signal for data, screens, or UX', () => {
  const classification = section(
    createSkill,
    'Infer a recommended Dataverse planning mode before Step 2c',
    '**Design decisions are deferred to Step 6.75**',
  );
  assert.match(classification, /offline wording is not a Dataverse planning signal/i);
  assert.doesNotMatch(classification, /Dataverse offline data/);
  assert.match(planner, /ignore offline wording.*Step 8\.85/is);
  assert.match(architect, /offline wording alone.*must not create/i);
  assert.match(screenPlanner, /do not create offline-specific screens, routes, actions, or UX/i);
  assert.match(screenBuilder, /connectivity and offline UI are explicit-plan-only/i);
  assert.match(universalPatterns, /never select this pattern during `\/create-mobile-app`/i);
  assert.match(requirementsDiscovery, /Ignore `offline`, `offline-first`/i);
  assert.doesNotMatch(requirementsDiscovery, /Camera capability \+ image column/);
});

test('the wizard targets iOS and Android without asking a platform question', () => {
  const gatherRequirements = section(
    createSkill,
    '### Step 2 — Gather requirements',
    '### Step 2b — Requirements discovery',
  );
  assert.doesNotMatch(gatherRequirements, /\| Target platforms \|/);
  assert.match(gatherRequirements, /<target_platforms> = "ios, android"/i);
  assert.match(gatherRequirements, /do not ask.*iOS.*Android/is);
});

test('data platform and integrations are approved before Dataverse modeling', () => {
  const modeQuestion = createSkill.indexOf('### Step 2b.5 — Confirm data platform');
  const snapshot = createSkill.indexOf('### Step 3.0 — Foreground Dataverse planning snapshot');
  assert.ok(modeQuestion > 0 && modeQuestion < snapshot);

  const architectureGate = planner.indexOf(
    '### Gate 1 — Data Platform + Device Capabilities + Integrations',
  );
  const architectDispatch = planner.indexOf('## Step 4 — Build Data Model');
  const dataModelGate = planner.indexOf('### Gate 2 — Data Model');
  const screenGraphGate = planner.indexOf('#### Gate 3 — Screen Graph');
  const screenSpecsGate = planner.indexOf('### Gate 4 — Screen Specs Review');
  assert.ok(architectureGate > 0 && architectureGate < architectDispatch);
  assert.ok(architectDispatch < dataModelGate);
  assert.ok(dataModelGate < screenGraphGate && screenGraphGate < screenSpecsGate);
  assert.match(
    planner,
    /connector-only[\s\S]*do not dispatch `mobile-app:data-model-architect`/i,
  );
  assert.match(planner, /Approved native capabilities:[\s\S]*Approved connectors:/i);
  assert.match(architect, /approved native capabilities/i);
  assert.match(architect, /approved connectors/i);
  assert.match(architect, /do not create a Dataverse duplicate of a connector-owned entity/i);
  assert.match(
    createSkill,
    /NEEDS_CONTEXT: dataverse-planning-mode:<required\|connector-only>[\s\S]*return to Step 3\.0/i,
  );
  assert.match(
    planner,
    /Run condition:[\s\S]*ONLY in `required` mode[\s\S]*In `connector-only`[\s\S]*never[\s\S]*dispatch `data-model-architect`/i,
  );
  assert.doesNotMatch(`${planner}\n${architect}\n${screenPlanner}`, /Gate 4a|Gate 4b/);
});

test('inline fallback preserves architecture-first conditional modeling', () => {
  const fallback = section(
    createSkill,
    '#### 3.0a — Inline-gate fallback',
    '#### 3.0 — Sub-agent return-status switch',
  );
  const architecture = fallback.indexOf('Gate 1 — Data Platform + Device Capabilities + Integrations');
  const architect = fallback.indexOf('spawn `mobile-app:data-model-architect`');
  assert.ok(architecture > 0 && architecture < architect);
  assert.match(fallback, /connector-only[\s\S]*do not spawn `mobile-app:data-model-architect`/i);
  assert.match(fallback, /Approved native capabilities:[\s\S]*Approved connectors:/i);
});

test('offline profile opt-in runs after Dataverse materialization and before native wiring', () => {
  assert.equal(createSkill.indexOf('### Step 6.85 — Offline profile'), -1);
  const sampleData = createSkill.indexOf('### Step 8.5 — Seed sample data');
  const offline = createSkill.indexOf('### Step 8.85 — Offline profile');
  const native = createSkill.indexOf('### Step 9 — Apply native capabilities');
  assert.ok(sampleData > 0 && sampleData < offline);
  assert.ok(offline < native);
});
