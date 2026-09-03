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
const planningWorkflow = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'phase-3-planning.md'),
  'utf8',
);
const navigationWorkflow = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'phase-10-navigation.md'),
  'utf8',
);
const screenWaveWorkflow = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'phase-11-screens.md'),
  'utf8',
);
const setupWorkflow = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'phase-0-setup.md'),
  'utf8',
);
const dataWorkflow = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'phase-7-data.md'),
  'utf8',
);
const setupDataModelSkill = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'setup-datamodel', 'SKILL.md'),
  'utf8',
);
const setupOfflineProfileSkill = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'setup-offline-profile', 'SKILL.md'),
  'utf8',
);
const templatePackage = JSON.parse(fs.readFileSync(
  path.join(pluginRoot, 'template', 'package.json'),
  'utf8',
));
const templateAppConfig = fs.readFileSync(
  path.join(pluginRoot, 'template', 'app.config.js'),
  'utf8',
);
const templateLayout = fs.readFileSync(
  path.join(pluginRoot, 'template', 'app', '_layout.tsx'),
  'utf8',
);
const templateReadme = fs.readFileSync(
  path.join(pluginRoot, 'template', 'README.md'),
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

test('template host package owns runtime after explicit offline profile choice', () => {
  assert.equal(
    templatePackage.dependencies['@microsoft/power-apps-native-offline'],
    '^0.1.32',
  );
  assert.ok(templatePackage.dependencies['@microsoft/power-apps-native-host']);
  assert.match(templateAppConfig, /'@microsoft\/power-apps-native-offline'/);
  assert.match(templateAppConfig, /owns connection, queue, sync,[\s\S]*retry, and conflict/);
  assert.match(templateLayout, /offlineProfile=\{offlineProfile\}/);
  assert.match(templateLayout, /installed offline package own runtime status/);
  assert.match(templateReadme, /do not add another offline dependency/);
  assert.match(templateReadme, /not inferred from requirements/);
  assert.match(templateReadme, /asks whether the user wants offline support/);
  assert.match(templateReadme, /Connector-only and[\s\S]*skip this Dataverse-only profile question/);
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

  const commonStart = setupWorkflow.indexOf('#### Step 2b.4 — Common to all paths');
  const commonEnd = setupWorkflow.indexOf('### Step 2c — Plan preview', commonStart);
  const common = setupWorkflow.slice(commonStart, commonEnd);
  assert.match(common, /Perform no Dataverse reads in Step 2/);
  assert.doesNotMatch(common, /PUBLISHER_PREFIX_JSON=\$\(node/);
  assert.doesNotMatch(common, /node "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/scripts\/create-dataverse-snapshot\.js"/);
  assert.doesNotMatch(common, /<dataverse_planning_mode>/);
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
  const previewIndex = setupWorkflow.indexOf('### Step 2c — Plan preview');
  const appIdentityIndex = setupWorkflow.indexOf('scripts/lib/app-identity.js', previewIndex);
  const buildPlanIndex = setupWorkflow.indexOf('launch its loopback server', appIdentityIndex);
  assert.ok(previewIndex >= 0);
  assert.ok(appIdentityIndex > previewIndex);
  assert.ok(buildPlanIndex > appIdentityIndex);
  assert.doesNotMatch(setupWorkflow.slice(0, previewIndex), /_build_plan\.html|mobile-build-plan\.js/);

  assert.match(buildPlanProtocol, /mobile-build-plan\.js" serve/);
  assert.match(buildPlanProtocol, /127\.0\.0\.1/);
  assert.match(buildPlanProtocol, /tokenless standalone `_build_plan\.html`/);
  assert.match(buildPlanProtocol, /never parses HTML or Mermaid back into a\s+contract/);
  assert.match(buildPlanProtocol, /reopen Gate 2 for a schema-only change/);
  assert.match(buildPlanProtocol, /reopen Gate 1, recompile persistence/);
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
  assert.match(scaffold, /expandable `All screens` area/);
  assert.match(scaffold, /does not claim[\s\S]*native pixel verification/);
  assert.match(scaffold, /validate-product-experience-preview\.js/);
  assert.doesNotMatch(scaffold, /--mode final|--tokens "<working_dir>\/brand\/tokens\.ts"/);
  assert.match(scaffold, /only after `\/design-system` has returned/);
  assert.match(scaffold, /neutral structural[\s\S]*approved visual intent/i);
  assert.match(scaffold, /remain state controls on those frames rather than routes/);
});

test('browser data-model edits are checked before approvals and mutation', () => {
  const editChecks = skill.match(/mobile-build-plan-edits\.json/g) || [];
  assert.ok(editChecks.length >= 4, 'expected edit-journal checks at approval and mutation boundaries');
  assert.match(planningWorkflow, /schema-only edit[\s\S]*reopens Gate 2/);
  assert.match(planningWorkflow, /adds\/removes a Product Scope concept or changes ownership reopens Gate 1/);
  assert.match(dataWorkflow, /schema-only edit blocks Step 8 and returns through[\s\S]*Gate 2/);
  assert.match(dataWorkflow, /scope or ownership edit returns through Gate 1/);
  assert.match(buildPlanProtocol, /After\s+`.tmp\/dataverse-metadata-execution-journal\.json`/);
  assert.match(buildPlanProtocol, /subsequent schema work belongs to `\/edit-app`/);
});

test('Phase 7 asks once before directly invoking Dataverse offline profile setup', () => {
  const dataModel = dataWorkflow.indexOf('### Step 8 — Apply data model');
  const sampleData = dataWorkflow.indexOf('### Step 8.5 — Seed Dataverse sample data');
  const offline = dataWorkflow.indexOf('### Step 8.85 — Ask about offline support');
  const native = dataWorkflow.indexOf('### Step 9 — Apply native capabilities');

  assert.ok(dataModel < sampleData);
  assert.ok(sampleData < offline);
  assert.ok(offline < native);
  for (const mode of ['dataverse', 'mixed', 'connector-only', 'local-prototype']) {
    assert.match(dataWorkflow, new RegExp(`\\b${mode}\\b`));
  }
  assert.match(dataWorkflow, /compile-persistence-contract\.js"[\s\S]{0,120}--project-root "<working_dir>" --check-artifacts/);
  const usageCheck = dataWorkflow.indexOf('scripts/validate-data-model-usage.js', dataModel);
  const manifestBuild = dataWorkflow.indexOf(
    'scripts/build-dataverse-operation-manifest.js',
    dataModel,
  );
  assert.ok(usageCheck > dataModel && usageCheck < manifestBuild);
  assert.match(dataWorkflow, /usage check is required in all four modes/);
  assert.match(dataWorkflow, /no Dataverse reconciliation[\s\S]*metadata write/);
  assert.match(dataWorkflow, /mixed[\s\S]*only for `dataverseConceptIds`/);
  assert.match(dataWorkflow, /AskUserQuestion[\s\S]*Do you want offline support/);
  assert.match(dataWorkflow, /only for `dataverse` or `mixed`/);
  assert.match(dataWorkflow, /If the user answers Yes[\s\S]*\/setup-offline-profile[\s\S]*--orchestrated-create/);
  assert.match(dataWorkflow, /If the user answers No[\s\S]*skip offline profile setup/);
  assert.match(dataWorkflow, /connection, queued, syncing, failed, retry, and conflict[\s\S]*package/);
  assert.doesNotMatch(dataWorkflow, /offline-integration-contract|compile-offline-integration/);
  assert.match(
    dataWorkflow,
    /Step 8\.85 is the only selection point[\s\S]*AskUserQuestion/,
  );
  assert.doesNotMatch(
    dataWorkflow.slice(offline, native),
    /persistence\.offline|Dataverse table for (?:connector|local)/,
  );
  assert.doesNotMatch(dataWorkflow, /<dataverse_planning_mode>/);
});

test('persistence ownership compiles before conditional Dataverse planning and journey packs', () => {
  const experience = planningWorkflow.indexOf('## Step 3.0 — Product Experience and Product Scope');
  const architecture = planningWorkflow.indexOf('## Step 3.1 — Architecture decisions and persistence contract');
  const gateOne = planningWorkflow.indexOf('## Step 3.2 — Gate 1: experience, scope, and architecture');
  const dataModel = planningWorkflow.indexOf('## Step 3.3 — Conditional physical data model');
  const journey = planningWorkflow.indexOf('## Step 3.4 — Workflow Journey and screen build packs');
  const persistenceCompile = planningWorkflow.indexOf(
    'node "${CLAUDE_SKILL_DIR}/../../scripts/compile-persistence-contract.js"',
    architecture,
  );
  const publisherRead = planningWorkflow.indexOf('PUBLISHER_PREFIX_JSON=$(node', dataModel);
  const snapshotRead = planningWorkflow.indexOf(
    'node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js"',
    dataModel,
  );
  const persistenceArgument = planningWorkflow.indexOf(
    '--persistence-contract <working_dir>/.tmp/persistence-contract.json',
    dataModel,
  );

  assert.ok(experience >= 0);
  assert.ok(experience < architecture);
  assert.ok(architecture < persistenceCompile);
  assert.ok(persistenceCompile < gateOne);
  assert.ok(gateOne < dataModel);
  assert.ok(dataModel < publisherRead);
  assert.ok(publisherRead < snapshotRead);
  assert.ok(snapshotRead < persistenceArgument);
  assert.ok(persistenceArgument < journey);

  for (const artifact of [
    '.tmp/architecture-decisions.json',
    '.tmp/persistence-contract.json',
    '.tmp/dataverse-concepts.json',
  ]) {
    assert.match(planningWorkflow, new RegExp(artifact.replaceAll('.', '\\.')));
  }
  assert.match(planningWorkflow, /compile-persistence-contract\.js --check-artifacts/);
  assert.match(planningWorkflow, /never declare `states\.offline`/);
  assert.doesNotMatch(planningWorkflow, /offline-integration-contract|compile-offline-integration|offline may be selected/i);
  assert.doesNotMatch(
    planningWorkflow,
    /applicable loading, empty, error, permission, offline, and success states/,
  );
  assert.match(planningWorkflow, /every and only those IDs/);
  assert.match(planningWorkflow, /Every read, create, update, delete, sync, upload, download[\s\S]*exact owner/);
  assert.match(buildPlanProtocol, /\.tmp\/architecture-decisions\.json/);
  assert.match(buildPlanProtocol, /\.tmp\/persistence-contract\.json/);
  assert.doesNotMatch(buildPlanProtocol, /offline-integration-contract|offlineIntegration/);
});

test('planning authors and checks data-model usage after schema, Journey, and screen packs', () => {
  const dataModel = planningWorkflow.indexOf('## Step 3.3 — Conditional physical data model');
  const journey = planningWorkflow.indexOf('## Step 3.4 — Workflow Journey and screen build packs');
  const packCheck = planningWorkflow.indexOf(
    '--project-root "<working_dir>" --check',
    planningWorkflow.indexOf('compile-screen-build-pack.js', journey),
  );
  const usageInput = planningWorkflow.indexOf(
    'foreground writes `.tmp/data-model-usage-input.json`',
    journey,
  );
  const usageCompile = planningWorkflow.indexOf(
    'scripts/validate-data-model-usage.js',
    usageInput,
  );
  const usageCheck = planningWorkflow.indexOf('--check', usageCompile);
  const gateTwo = planningWorkflow.indexOf('## Step 3.6 — Gate 2');

  assert.ok(dataModel >= 0 && dataModel < journey);
  assert.ok(packCheck > journey);
  assert.ok(usageInput > packCheck);
  assert.ok(usageCompile > usageInput);
  assert.ok(usageCheck > usageCompile);
  assert.ok(gateTwo > usageCheck);
  assert.match(planningWorkflow, /compact AI-owned mapping/);
  assert.match(planningWorkflow, /never infers consumers[\s\S]*names/);
  assert.match(planningWorkflow, /connector-only` and `local-prototype`[\s\S]*`tables: \[\]`/);
  assert.match(planningWorkflow, /Every shipping[\s\S]*persistable Journey operation[\s\S]*exactly one/);
  assert.match(planningWorkflow, /Gate 2 reviews[\s\S]*compiled data-model usage traceability/);
  assert.match(planningWorkflow, /compiled[\s\S]{0,80}`usageRevision`/);
  assert.match(planningWorkflow, /approvals\.dataModelUsage/);
  assert.match(planningWorkflow, /Any Product Scope, persistence, Journey, or schema change invalidates[\s\S]*recompile/);
  assert.match(planningWorkflow, /No mutation phase[\s\S]*no Dataverse write/);
  assert.match(setupDataModelSkill, /calling foreground[\s\S]*data-model-usage-input\.json/);
  assert.match(setupDataModelSkill, /standalone[\s\S]*plan-only[\s\S]*caller[\s\S]*usage mapping/);
});

test('planning compiles one canonical scenario before preview, data, and builders', () => {
  const journey = planningWorkflow.indexOf('## Step 3.4 — Workflow Journey and screen build packs');
  const packCheck = planningWorkflow.indexOf(
    '--project-root "<working_dir>" --check',
    planningWorkflow.indexOf('compile-screen-build-pack.js', journey),
  );
  const scenarioInput = planningWorkflow.indexOf(
    'foreground authors\n`.tmp/scenario-facts-input.json`',
    packCheck,
  );
  const scenarioCompile = planningWorkflow.indexOf(
    'scripts/validate-fixture-scenarios.js',
    scenarioInput,
  );
  const scenarioCheck = planningWorkflow.indexOf('--check', scenarioCompile);
  const usageInput = planningWorkflow.indexOf('.tmp/data-model-usage-input.json', scenarioCheck);
  const gateTwo = planningWorkflow.indexOf('## Step 3.6 — Gate 2', scenarioCheck);

  assert.ok(packCheck > journey);
  assert.ok(scenarioInput > packCheck);
  assert.ok(scenarioCompile > scenarioInput);
  assert.ok(scenarioCheck > scenarioCompile);
  assert.ok(usageInput > scenarioCheck);
  assert.ok(gateTwo > scenarioCheck);
  assert.match(planningWorkflow, /one compact happy-path scenario/);
  assert.match(planningWorkflow, /deterministic validator only resolves declared[\s\S]*never invents/);
  assert.match(planningWorkflow, /scenarioRevision/);
  assert.match(planningWorkflow, /approvals\.scenarioFacts/);
  assert.match(buildPlanProtocol, /\.tmp\/scenario-facts\.json/);
  assert.match(buildPlanProtocol, /record, scenario, screen-binding, media,[\s\S]*invariant counts/);

  assert.match(dataWorkflow, /validate-fixture-scenarios\.js/);
  assert.match(dataWorkflow, /compile-sample-data-obligations\.js[\s\S]*--check/);
  assert.match(dataWorkflow, /connector\/local prototype repositories[\s\S]*without any Dataverse read or write/i);
  assert.match(navigationWorkflow, /screen's[\s\S]*binding from `.tmp\/scenario-facts\.json`/);
  assert.match(navigationWorkflow, /Do not hardcode an independent sample/);
  assert.match(screenWaveWorkflow, /binding, referenced records, relationships, media assets,[\s\S]*invariants/);
  assert.match(screenWaveWorkflow, /may not invent fixture names, statuses, dates, counts, media URLs/);
  assert.ok(
    (screenWaveWorkflow.match(/validate-fixture-scenarios\.js/g) || []).length >= 4,
    'scenario facts must be checked before Wave 0, wave/cross-screen, and final gates',
  );
  assert.match(skill, /scenario-facts=\.tmp\/scenario-facts\.json/);
});

test('setup-offline-profile owns only the Dataverse profile in orchestrated create', () => {
  assert.match(setupOfflineProfileSkill, /--orchestrated-create/);
  assert.match(setupOfflineProfileSkill, /affirmative offline choice/i);
  assert.doesNotMatch(setupOfflineProfileSkill, /offline-integration-contract/);
  assert.match(setupOfflineProfileSkill, /only authors the Dataverse Mobile Offline Profile/i);
  assert.match(setupOfflineProfileSkill, /does not own product screens, routes, jobs, or domain tables/i);
  assert.match(
    setupOfflineProfileSkill,
    /connection, queued, syncing, failed, retry, and conflict[\s\S]*package integration/i,
  );
  assert.match(setupOfflineProfileSkill, /standalone[\s\S]*explicitly invoke/i);
  assert.doesNotMatch(setupOfflineProfileSkill, /Step 6\.85|universal opt-out/);
});

test('setup-datamodel allows plan-only new-app use but reserves standalone use for redesign', () => {
  const description = setupDataModelSkill.match(/^description: (.+)$/m)?.[1] || '';
  assert.match(description, /standalone redesign of an existing mobile app/i);
  assert.match(description, /brand-new app creation[\s\S]*plan-only API/i);
  assert.doesNotMatch(description, /Skip when the user is creating a brand-new app/i);
  assert.match(setupDataModelSkill, /--persistence-contract/);
});

test('sample fixtures are led by canonical scenario facts rather than schema names', () => {
  for (const artifact of [
    'product-experience-contract.json',
    'product-scope-contract.json',
    'workflow-journey-contract.json',
    'compiled-screen-build-pack.json',
    'scenario-facts.json',
  ]) {
    assert.match(sampleDataSkill, new RegExp(artifact.replaceAll('.', '\\.')));
  }
  assert.match(sampleDataSkill, /compile-screen-build-pack\.js --check/);
  assert.match(sampleDataSkill, /validate-fixture-scenarios\.js --check/);
  assert.match(sampleDataSkill, /compile-sample-data-obligations\.js/);
  assert.match(sampleDataSkill, /\.tmp\/sample-data-obligations\.json/);
  assert.match(sampleDataSkill, /fixture-coverage matrix/);
  assert.match(sampleDataSkill, /schema constrains/i);
  assert.match(sampleDataSkill, /Reuse a seed value only when its ID and value equal the bound scenario fact/);
  assert.match(sampleDataSkill, /partial contract set is not a legacy project/i);
  assert.match(sampleDataSkill, /must not classify an unfamiliar product from table names/i);
});

test('planning compiles the canonical navigation projection before screen packs', () => {
  const scopeValidation = planningWorkflow.indexOf('validate-product-scope.js');
  const navigationCompilation = planningWorkflow.indexOf('compile-navigation-manifest.js');
  const screenPackCompilation = planningWorkflow.indexOf('compile-screen-build-pack.js');

  assert.ok(scopeValidation >= 0);
  assert.ok(navigationCompilation > scopeValidation);
  assert.ok(screenPackCompilation > navigationCompilation);
  assert.match(planningWorkflow, /canonical deterministic navigation[\s\S]*projection of validated Product Scope/);
  assert.match(planningWorkflow, /Product Scope remains the planning[\s\S]*authority/);
  assert.match(planningWorkflow, /mobile-pipeline-state\.json[\s\S]*navigation-manifest\.json/);
});

test('Phase 10 generates navigation only from the compiled manifest', () => {
  const start = navigationWorkflow.indexOf('### Step 10b');
  const end = navigationWorkflow.indexOf('### Step 10.7');
  const step = navigationWorkflow.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(step, /\.tmp\/navigation-manifest\.json/);
  for (const field of [
    'pattern',
    'visibleTabs',
    'durableDestinations',
    'screens',
    'iconName',
    'parentTabId',
    'tabVisible',
    'headerMode',
    'backBehavior',
    'targetPath',
  ]) {
    assert.match(step, new RegExp(`\\b${field}\\b`));
  }
  assert.match(step, /validate-navigation-layout\.js/);
  const usageCheck = step.indexOf('validate-data-model-usage.js');
  const firstLayoutWrite = step.indexOf('#### Step 10b.2');
  assert.ok(usageCheck >= 0 && usageCheck < firstLayoutWrite);
  assert.doesNotMatch(step, /native-app-plan\.md|Screen Map/);
  assert.doesNotMatch(step, /Screen name contains|home, dashboard, overview|anything else[\s\S]*apps-outline/);

  const gate = navigationWorkflow.slice(navigationWorkflow.indexOf('#### 10.8d'));
  assert.match(gate, /check-routes\.js[\s\S]*validate-navigation-layout\.js[\s\S]*validate-data-model-usage\.js/);
  assert.match(gate, /data-model-usage=\.tmp\/data-model-usage\.json/);
});

test('every screen-wave route gate validates the navigation layout', () => {
  const sections = [
    ['canary', '## Step 11.2', '## Step 11.3'],
    ['supporting', '## Step 11.3', '## Step 11.4'],
    ['cross-screen', '## Step 11.4', '### Step 12'],
    ['final', '### Step 12', '### Step 13'],
  ];

  for (const [label, startHeading, endHeading] of sections) {
    const start = screenWaveWorkflow.indexOf(startHeading);
    const end = screenWaveWorkflow.indexOf(endHeading, start + startHeading.length);
    const section = screenWaveWorkflow.slice(start, end);
    assert.ok(start >= 0 && end > start, `${label} validation section is missing`);
    assert.match(section, /check-routes\.js/);
    assert.match(section, /validate-navigation-layout\.js/);
    assert.match(section, /validate-data-model-usage\.js/);
  }
});

test('Build Plan projects usage without becoming a second validator', () => {
  assert.match(buildPlanProtocol, /\.tmp\/data-model-usage\.json/);
  assert.match(buildPlanProtocol, /compact requirement, table,[\s\S]*consumer-link counts/);
  assert.match(
    buildPlanProtocol,
    /never exposes the raw usage[\s\S]*never independently revalidates/,
  );
  assert.match(buildPlanProtocol, /Every schema edit also invalidates/);
  assert.match(buildPlanProtocol, /Undo restores the exact prior file/);
  assert.match(buildPlanProtocol, /reports the affected consumer IDs/);
  assert.match(buildPlanProtocol, /typed\s+system exemption alone is not a blocker/);
});

test('final summary declares the same number of options that it renders', () => {
  assert.match(skill, /present exactly 5 options/);
  assert.match(skill, /5\. Configure auth later/);
  assert.doesNotMatch(skill, /present exactly (?:these )?4 options/);
});
