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
const connectivityOwnership = fs.readFileSync(
  path.join(pluginRoot, 'shared', 'references', 'connectivity-intent-ownership.md'),
  'utf8',
);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('connectivity wording is owned by the post-materialization offline flow', () => {
  const classification = section(
    createSkill,
    'Infer a provisional Dataverse planning mode before Step 2c',
    '**Design decisions are deferred to Step 6.75**',
  );
  assert.match(classification, /connectivity-intent-ownership\.md/i);
  assert.doesNotMatch(classification, /Dataverse offline data/);
  for (const source of [planner, architect, screenPlanner, screenBuilder, requirementsDiscovery]) {
    assert.match(source, /connectivity-intent-ownership\.md/i);
  }
  assert.match(
    connectivityOwnership,
    /offline-first[\s\S]*limited or[\s\S]*intermittent connectivity[\s\S]*no connectivity/i,
  );
  assert.match(connectivityOwnership, /operating\s+context only/i);
  assert.match(universalPatterns, /approved product requirement.*app-owned sync queue/is);
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
  const modeQuestion = createSkill.indexOf('**Question header:** `Data platform`');
  const architecturePass = createSkill.indexOf('### Architecture gate');
  const prefixDetection = createSkill.indexOf('Now execute the deferred Step 1.7');
  const snapshot = createSkill.indexOf('### Foreground Dataverse planning snapshot');
  assert.equal(modeQuestion, -1);
  assert.ok(architecturePass > 0 && architecturePass < prefixDetection);
  assert.ok(prefixDetection < snapshot);
  assert.match(
    section(createSkill, '### Architecture gate', '### Foreground Dataverse planning snapshot'),
    /Dataverse planning snapshot: NOT SUPPLIED[\s\S]*approved-architecture\.md/i,
  );
  assert.match(
    section(createSkill, '### Foreground Dataverse planning snapshot', '**Hard rule — planner writes'),
    /Gate 1-approved[\s\S]*<dataverse_planning_mode>/i,
  );

  const architectureGate = planner.indexOf(
    '### Gate 1 — Data Platform + Device Capabilities + Integrations',
  );
  const nativePlanning = planner.indexOf('## Step 3 — Plan Native Capabilities Inline');
  const connectorPlanning = planner.indexOf('## Step 4 — Plan Connectors Inline');
  const architectDispatch = planner.indexOf('## Step 5 — Build Data Model');
  const dataModelGate = planner.indexOf('### Gate 2 — Data Model');
  const screenGraphGate = planner.indexOf('#### Gate 3 — Screen Graph');
  const screenSpecsGate = planner.indexOf('### Gate 4 — Screen Specs Review');
  assert.ok(nativePlanning > 0 && nativePlanning < connectorPlanning);
  assert.ok(connectorPlanning < architectureGate);
  const connectorSection = planner.slice(connectorPlanning, architectureGate);
  assert.doesNotMatch(connectorSection, /AskUserQuestion|ask cold/i);
  assert.match(connectorSection, /Approve in Gate 1/i);
  assert.ok(architectureGate > 0 && architectureGate < architectDispatch);
  assert.ok(architectDispatch < dataModelGate);
  assert.ok(dataModelGate < screenGraphGate && screenGraphGate < screenSpecsGate);
  assert.match(
    planner,
    /connector-only[\s\S]*data-model-architect/i,
  );
  assert.match(planner, /Approved native capabilities:[\s\S]*Approved connectors:/i);
  assert.match(architect, /approved native capabilities/i);
  assert.match(architect, /approved connectors/i);
  assert.match(architect, /do not create a Dataverse duplicate of a connector-owned entity/i);
  assert.match(
    createSkill,
    /architecture-only pass[\s\S]*NEEDS_CONTEXT: dataverse-planning-mode:<required\|connector-only>/i,
  );
  assert.match(
    planner,
    /Run condition:[\s\S]*ONLY in `required` mode[\s\S]*In `connector-only`[\s\S]*never[\s\S]*dispatch `data-model-architect`/i,
  );
  assert.doesNotMatch(`${planner}\n${architect}\n${screenPlanner}`, /Gate 4a|Gate 4b/);
  assert.match(
    architect,
    /BLOCKED: data-model-architect must not be dispatched in connector-only mode/i,
  );
});

test('deferred design does not create an extra industry question', () => {
  assert.match(planner, /Design vibe opt-in` is `yes`, `done`, `deferred`, or `skip`/i);
  assert.doesNotMatch(planner, /design is reviewed visually at Gate 4/i);
});

test('inline fallback preserves architecture-first conditional modeling', () => {
  const fallback = section(
    createSkill,
    '#### 3.0a — Inline-gate fallback',
    '#### 3.0 — Sub-agent return-status switch',
  );
  const architecture = fallback.indexOf('.tmp/approved-architecture.md');
  const architect = fallback.indexOf('spawn `mobile-app:data-model-architect`');
  assert.ok(architecture > 0 && architecture < architect);
  assert.match(fallback, /connector-only[\s\S]*zero-table\/no-Dataverse/i);
  assert.match(fallback, /Approved native capabilities:[\s\S]*Approved connectors:/i);
});

test('offline profile opt-in runs after Dataverse materialization and before native wiring', () => {
  assert.equal(createSkill.indexOf('### Step 6.85 — Offline profile'), -1);
  const sampleData = createSkill.indexOf('### Step 8.5 — Seed sample data');
  const offline = createSkill.indexOf('### Offline profile');
  const native = createSkill.indexOf('### Step 9 — Apply native capabilities');
  assert.ok(sampleData > 0 && sampleData < offline);
  assert.ok(offline < native);
  assert.match(
    createSkill,
    /missing, malformed, or contains no Dataverse[\s\S]*BLOCKED: Dataverse materialization/i,
  );
});
