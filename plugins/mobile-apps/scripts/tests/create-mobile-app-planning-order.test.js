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
const templatePackage = JSON.parse(
  fs.readFileSync(path.join(pluginRoot, 'template', 'package.json'), 'utf8'),
);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('planning contracts contain no unresolved merge markers', () => {
  for (const source of [createSkill, planner, architect, screenPlanner, screenBuilder]) {
    assert.doesNotMatch(source, /^(?:<{7}|={7}|>{7})(?: |$)/m);
  }
});

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
  assert.match(
    connectivityOwnership,
    /must not add offline-specific business tables[\s\S]*services[\s\S]*stores[\s\S]*routes[\s\S]*screens/i,
  );
  assert.equal(
    typeof templatePackage.dependencies['@microsoft/power-apps-native-offline'],
    'string',
  );
  assert.match(
    connectivityOwnership,
    /power-apps-native-host[\s\S]*local SQLite[\s\S]*status overlay/i,
  );
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
    /BLOCKED: This step only applies when Dataverse is selected/i,
  );
});

test('screen specs use the canonical approvals heading as their insertion anchor', () => {
  assert.match(planner, /^## Approvals$/m);
  assert.doesNotMatch(planner, /^## Approval Status$/m);
  assert.match(screenPlanner, /immediately before `## Approvals`/);
});

test('deferred design does not create an extra industry question', () => {
  assert.match(planner, /Design vibe opt-in` is `yes`, `done`, `deferred`, or `skip`/i);
  assert.doesNotMatch(planner, /design is reviewed visually at Gate 4/i);
});

test('preview preferences keep deferred Gate 4 markdown-only', () => {
  const preferences = section(createSkill, 'Set tentative defaults', '**`--no-design` escape hatch.**');
  assert.match(preferences, /<visual_companion> = yes[^\r\n]*Step 6\.75/);
  assert.match(preferences, /Gate 4 remains markdown-only/);
  assert.doesNotMatch(preferences, /open[^\r\n]*at Gate 4/i);
  assert.doesNotMatch(createSkill, /The planner emits[^\r\n]*before each Gate 4 plan-mode entry/);
  const handoff = section(createSkill, '#### Step 3b', '#### 3.9');
  assert.match(handoff, /legacy planner emits `PLAN_PREVIEW_PATH:[\s\S]*ignore that early preview output/);
  assert.match(handoff, /Do not open it[\s\S]*at Gate 4/);
  assert.match(handoff, /With `--no-design`, Step 6\.75 and its HTML preview are both skipped/);
  assert.doesNotMatch(handoff, /open "|xdg-open|Start-Process/);
  const design = section(createSkill, '### Step 6.75', 'Offline profile setup is intentionally deferred');
  assert.match(design, /legacy[\s\S]*Gate 4 remains markdown-only/i);
  assert.match(design, /visual_companion: no` disables automatic\s+browser opening, not rendering/);
  assert.match(design, /`--no-design` skips this stage and its HTML preview/);
  assert.doesNotMatch(design, /Step 6\.85|every path through the flow gets at least one visual preview/);
  const brandedPreview = section(design, '#### Branch A', '#### Branch B');
  assert.match(brandedPreview, /\/design-system` owns rendering of `_plan_preview\.html`/);
  const skippedDesign = section(design, '#### Branch B', '**Preview timing:**');
  assert.match(skippedDesign, /\*\*Render `_plan_preview\.html`\*\*/);
  assert.match(skippedDesign, /Print the preview path; open in browser only if `<visual_companion> = yes`/);
});

test('offline completion summary reflects the bundled native host runtime', () => {
  const offlineSkill = fs.readFileSync(
    path.join(pluginRoot, 'skills/setup-offline-profile/SKILL.md'), 'utf8',
  );
  const summary = section(offlineSkill, '### Step 10 — Summary', '## Status code');
  assert.match(summary, /@microsoft\/power-apps-native-host[\s\S]*consumes the profile/);
  assert.match(summary, /SQLite[\s\S]*queued synchronization[\s\S]*reconnect[\s\S]*status/);
  assert.doesNotMatch(summary, /does not yet consume|Native runtime support remains deferred/i);
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

test('inline screen planning persists the approved graph before requesting specs', () => {
  const fallback = section(createSkill, '#### 3.0a — Inline-gate fallback',
    '#### 3.0 — Sub-agent return-status switch');
  const skeleton = fallback.indexOf('Create the `native-app-plan.md` skeleton');
  const graph = fallback.indexOf('`phase: graph`');
  const embedded = fallback.indexOf('Embed the approved graph');
  const specs = fallback.indexOf('`phase: specs`');
  assert.ok(skeleton >= 0 && skeleton < graph);
  assert.ok(graph < embedded && embedded < specs);
  assert.match(fallback, /plan_path: <working_dir>\/native-app-plan\.md/);
  assert.match(fallback, /both screen dispatches[\s\S]*skip_preview: true/);
  assert.match(fallback, /missing or malformed, return to the Architecture gate/);
});

test('screen specs use the canonical plan and never rewrite graph scratch', () => {
  const specs = section(planner, '#### 5b.2 — Spawn planner', '#### Gate 4 — Screen Specs');
  assert.match(specs, /plan_path: <working_dir>\/native-app-plan\.md/);
  assert.match(specs, /read its `## Screens` section/);
  assert.match(specs, /writes specs only into `plan_path`/);
  assert.doesNotMatch(specs, /locked[^.\n]*_screens_section\.md/);
  const deferred = section(planner, '- **`Design vibe opt-in: deferred`',
    '- **`Design vibe opt-in: done`');
  assert.match(deferred, /native-app-plan\.md/);
  assert.doesNotMatch(deferred, /writes only `_screens_section\.md`/i);
});

test('architecture result is validated before generic missing-context retry routing', () => {
  const routing = section(createSkill, '#### 3.0 — Sub-agent return-status switch',
    '**Data-model exact-name expansion:**');
  const special = routing.indexOf('**Architecture-gate result');
  const generic = routing.indexOf('For all other first lines');
  assert.ok(special >= 0 && generic > special);
  assert.match(routing, /Architecture phase: gate-only/);
  assert.match(routing, /approved-architecture\.md/);
  assert.match(routing, /does not consume the generic retry budget/);
  assert.match(routing, /mode must match/);
});

test('planner permissions allow required planning artifacts only in their owning phase', () => {
  const permissions = planner.slice(planner.indexOf('## Tool Permissions'));
  assert.match(permissions, /`gate-only`: write `\.tmp\/approved-architecture\.md` only after actual Gate 1/);
  assert.match(permissions, /`complete`: write `native-app-plan\.md`[\s\S]*\.tmp\/mobile-plan-status\.json/);
  assert.match(permissions, /normalization[\s\S]*\.tmp\/dataverse-schema-contract\.json/);
  assert.match(permissions, /No app source, app configuration, generated services/);
  assert.doesNotMatch(permissions, /`Write` only to create `native-app-plan\.md`/);
});

test('post-specs cross-entity audit reads the canonical plan and belongs to Gate 2', () => {
  const audit = section(architect, '## Step 6a — Cross-entity Read Audit',
    '2. **Per entry, branch on');
  assert.match(audit, /mode: cross-entity-audit[\s\S]*native-app-plan\.md/);
  assert.match(audit, /graph-only scratch[\s\S]*not a substitute/);
  assert.doesNotMatch(architect, /addendum to Gate 1|Gate 1 view/);
});

test('architecture revalidates storage and native dependencies without silently dropping requirements', () => {
  const gate = section(planner, '### Gate 1 — Data Platform', '## Step 5 — Build Data Model');
  assert.match(gate, /Before accepting Gate 1[\s\S]*revalidate every native capability/);
  assert.match(gate, /whenever either choice changes/);
  assert.match(gate, /`geolocation` requires Dataverse/);
  assert.match(gate, /One-shot `location` is not an automatic replacement/);
  assert.match(gate, /Do not silently remove capabilities/);
  assert.match(gate, /Write the approved artifact only after the compatible combination is accepted/);
  const capabilities = section(planner, 'Control planning gate:', '## Step 4 — Plan Connectors');
  assert.match(capabilities, /connector-owned storage[\s\S]*supported upload\/write operation/);
  assert.match(capabilities, /connector name alone is not a storage implementation/);
  assert.doesNotMatch(capabilities, /missing Dataverse storage for a persisted artifact/);
});

test('architecture owns connector confirmation without changing the shared standalone workflow', () => {
  const connectors = section(planner, '## Step 4 — Plan Connectors', '### Gate 1 — Data Platform');
  assert.match(connectors, /Skip its Step 2 standalone confirmation/);
  const shared = fs.readFileSync(path.join(pluginRoot, 'shared/references/connector-planning.md'), 'utf8');
  assert.match(shared, /## Step 2 — Present to User for Confirmation/);
  assert.match(shared, /present using `AskUserQuestion`/);
});

test('reuse-only apps retain a verified materialized inventory without replaying schema writes', () => {
  const addDataverse = fs.readFileSync(path.join(pluginRoot, 'skills/add-dataverse/SKILL.md'), 'utf8');
  const verification = section(addDataverse, '### Step 6c — Verify tables exist', '### Step 6d — Write');
  const materialized = section(addDataverse, '### Step 6d — Write', '### Step 7 — Inspect generated files');
  assert.match(verification, /every table in `SERVICE_REQUIRED_TABLES`, including reused-as-is tables/);
  assert.match(materialized, /reuse-only app must still have a populated manifest/);
  assert.match(materialized, /Include every service-required table[\s\S]*status: "reused"/);
  assert.match(materialized, /Exclude deferred or unverified tables/);
  assert.match(materialized, /not by replaying successful schema writes/);
  assert.match(materialized, /standard-system-table exclusions still apply/);
  assert.doesNotMatch(materialized, /Do NOT include tables reused/);

  const seeding = section(createSkill, '### Step 8.5 — Seed sample data', '### Offline profile');
  assert.ok(seeding.indexOf('Rebuild the local manifest') < seeding.indexOf('Invoke skill: /add-sample-data'));
  assert.match(seeding, /Zero schema writes is a valid reuse-only result/);
  assert.match(seeding, /service.requiredTables/);
  assert.match(seeding, /verify-dataverse-services\.js/);
  const offline = section(createSkill, '### Offline profile', '### Step 9 — Apply native capabilities');
  assert.match(offline, /including reused tables/);
  assert.match(offline, /read-only manifest\s+recovery in Step 8\.5/);
});

test('offline profile opt-in runs after Dataverse materialization and before native wiring', () => {
  assert.equal(createSkill.indexOf('### Step 6.85 — Offline profile'), -1);
  const sampleData = createSkill.indexOf('### Step 8.5 — Seed sample data');
  const offline = createSkill.indexOf('### Offline profile');
  const native = createSkill.indexOf('### Step 9 — Apply native capabilities');
  assert.ok(sampleData > 0 && sampleData < offline);
  assert.ok(offline < native);
  assert.match(createSkill, /→ \[Offline profile\] Asking whether/i);
  assert.doesNotMatch(createSkill, /Step 8\.6 — Offline profile/);
  assert.match(
    createSkill,
    /missing, malformed, or contains no Dataverse[\s\S]*BLOCKED: Dataverse materialization/i,
  );
});
