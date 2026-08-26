'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('prototype entry skills and executable helpers are present', () => {
  const expected = [
    'skills/create-mobile-prototype/SKILL.md',
    'skills/create-mobile-prototype/scripts/gen-mock-services.js',
    'skills/create-mobile-prototype/scripts/gen-data-layer.js',
    'skills/create-mobile-prototype/scripts/migrate-legacy-prototype.js',
    'skills/create-mobile-prototype/scripts/configure-prototype-runtime.js',
    'skills/edit-plan/SKILL.md',
    'skills/prototype-to-real-app/SKILL.md',
    'skills/prototype-to-real-app/scripts/rebase-prototype-plan.js',
    'skills/add-sample-data/scripts/prepare-prototype-seed-migration.js',
    'skills/sync-from-plan/SKILL.md',
    'scripts/cleanup-prototype-artifacts.js',
    'scripts/reconcile-domain-dataverse.js',
    'scripts/resolve-navigation-contract.js',
    'scripts/validate-datamodel-manifest.js',
    'scripts/validate-screen-contracts.js',
    'shared/references/lifecycle-state.md',
  ];
  for (const relativePath of expected) {
    assert.equal(fs.existsSync(path.join(pluginRoot, relativePath)), true, `${relativePath} must exist`);
  }
});

test('new workflow Markdown keeps fenced blocks balanced', () => {
  const documents = [
    'skills/create-mobile-prototype/SKILL.md',
    'skills/edit-plan/SKILL.md',
    'skills/prototype-to-real-app/SKILL.md',
    'skills/sync-from-plan/SKILL.md',
    'shared/references/lifecycle-state.md',
  ];
  for (const relativePath of documents) {
    const fenceCount = (read(relativePath).match(/^```/gm) || []).length;
    assert.equal(fenceCount % 2, 0, `${relativePath} has unbalanced code fences`);
  }
});

test('prototype creation uses the current planner and non-executable schema contract', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /^name: create-mobile-prototype$/m);
  assert.match(skill, /mobile-app:native-app-planner/);
  assert.match(skill, /Dataverse planning mode: prototype/);
  assert.match(skill, /planningMode.*prototype/);
  assert.match(skill, /executionEligible.*false/);
  assert.match(skill, /gen-data-layer\.js/);
  assert.match(skill, /prototype-domain-model\.json/);
  assert.match(skill, /resolve-navigation-contract\.js/);
  assert.match(skill, /@\/data/);
  assert.match(skill, /validate-mobile-app\.js[\s\S]*--scope all --record/);
  assert.match(skill, /configure-prototype-runtime\.js[\s\S]*prototype/);
  assert.match(skill, /\.mobile-app\/state\.json/);
  assert.doesNotMatch(skill, /code-apps-native:/);
  assert.doesNotMatch(skill, /pac code|create-code-app-native/);
});

test('conversion rejects prototype approvals and commits through one target-mode sync', () => {
  const skill = read('skills/prototype-to-real-app/SKILL.md');
  assert.match(skill, /^name: prototype-to-real-app$/m);
  assert.match(skill, /transitioning/);
  assert.match(skill, /npx power-apps init -t MobileApp/);
  assert.match(skill, /rebase-prototype-plan\.js/);
  assert.match(skill, /add-dataverse --skip-planning/);
  assert.match(skill, /cleanup-prototype-artifacts\.js/);
  assert.match(skill, /reconcile-domain-dataverse\.js/);
  assert.match(skill, /gen-dataverse-repositories\.js/);
  assert.match(skill, /validate-ui-neutral-data-migration\.js/);
  assert.match(skill, /live-name-map\.json/);
  assert.match(skill, /dataverseManifestSha256/);
  assert.match(skill, /prepare-prototype-seed-migration\.js/);
  assert.match(skill, /Never replace failed prototype mappings with generic rows/);
  assert.match(skill, /configure-prototype-runtime\.js[\s\S]*dataverse/);
  assert.match(skill, /sync-from-plan --working-dir <PROJECT_DIR> --target-data-mode dataverse/);
  assert.match(skill, /Do not pass the prototype schema contract/);
  assert.doesNotMatch(skill, /pac code|code-apps-native:/);
});

test('sync owns the transition commit and blocks Dataverse mode with mock artifacts', () => {
  const skill = read('skills/sync-from-plan/SKILL.md');
  assert.match(skill, /^name: sync-from-plan$/m);
  assert.match(skill, /--target-data-mode dataverse/);
  assert.match(skill, /dataMode === "transitioning"/);
  assert.match(skill, /cleanup-prototype-artifacts\.js/);
  assert.match(skill, /set `dataMode: "dataverse"`/);
  assert.match(skill, /transition: null/);
});

test('planning agents explicitly support environment-free prototype mode', () => {
  const architect = read('agents/data-model-architect.md');
  const planner = read('agents/native-app-planner.md');
  for (const content of [architect, planner]) {
    assert.match(content, /`prototype`/);
    assert.match(content, /planningMode: "prototype"/);
    assert.match(content, /executionEligible: false/);
  }
  assert.match(architect, /zero environment/);
  assert.match(planner, /Prototype plans are not execution approvals/);
});

test('edit-app routes graduation intent before ordinary edits', () => {
  const skill = read('skills/edit-app/SKILL.md');
  assert.match(skill, /Convert, graduate, or make a prototype real/);
  assert.match(skill, /Invoke `\/prototype-to-real-app/);
  assert.match(skill, /Dataverse planning mode: prototype/);
  assert.match(skill, /gen-mock-services\.js/);
  assert.match(skill, /--apply-plan/);
  assert.match(skill, /approvedPlanSha256/);
});

test('edit-plan records a hash-bound plan-only handoff without changing sync state', () => {
  const skill = read('skills/edit-plan/SKILL.md');
  assert.match(skill, /^name: edit-plan$/m);
  assert.match(skill, /approved-pending-apply/);
  assert.match(skill, /structuredContractSha256/);
  assert.match(skill, /lastSyncedPlanHash.*unchanged/);
  assert.match(skill, /\/edit-app --apply-plan/);
  assert.doesNotMatch(skill, /code-apps-native:/);
});

test('prototype regeneration and real seed migration preserve data fail-closed', () => {
  const generator = read('skills/create-mobile-prototype/scripts/gen-mock-services.js');
  const sampleSkill = read('skills/add-sample-data/SKILL.md');
  const migration = read('skills/add-sample-data/scripts/prepare-prototype-seed-migration.js');
  assert.match(generator, /mergeExistingSeeds/);
  assert.match(generator, /prototype-seed-regeneration\.json/);
  assert.match(generator, /prototype-seed-archive/);
  assert.match(sampleSkill, /Do not fall back to generic rows/);
  assert.match(sampleSkill, /deterministic primary IDs/);
  assert.match(migration, /approvedPlanSha256/);
  assert.match(migration, /prototypeContractSha256/);
  assert.match(migration, /dataverseManifestSha256/);
  assert.match(migration, /mapChoiceValue/);
});

test('Dataverse manifest and record executor protect downstream data integrity', () => {
  const dataverseSkill = read('skills/add-dataverse/SKILL.md');
  const sampleSkill = read('skills/add-sample-data/SKILL.md');
  const requestScript = read('scripts/dataverse-request.js');
  assert.match(dataverseSkill, /validate-datamodel-manifest\.js/);
  assert.match(dataverseSkill, /every[\s\S]*non-deferred service-required table/);
  assert.match(sampleSkill, /Never derive it by appending `s`/);
  assert.match(requestScript, /uncertain: true/);
  assert.match(requestScript, /Replaying can duplicate generic sample data/);
});

test('reference-led prototypes bind screenshot intake through planning, polish, and native evidence', () => {
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const realApp = read('skills/create-mobile-app/SKILL.md');
  const planner = read('agents/native-app-planner.md');
  const designSystem = read('skills/design-system/SKILL.md');
  const optionalDesign = read('skills/design-system/optional-modes.md');
  const designRefiner = read('skills/design-react-native-app/SKILL.md');
  const referenceContract = 'shared/references/reference-fidelity.md';
  const intakeContract = 'skills/design-system/references/reference-intake.md';
  const evidenceValidator = 'scripts/validate-visual-qa-evidence.js';

  for (const relativePath of [referenceContract, intakeContract, evidenceValidator]) {
    assert.equal(fs.existsSync(path.join(pluginRoot, relativePath)), true, relativePath + ' must exist');
  }
  assert.match(prototype, /--from-screenshot/);
  assert.match(prototype, /--design-intake/);
  assert.match(prototype, /design-intake.md/);
  assert.match(prototype, /Visual reference:/);
  assert.match(prototype, /Reference intent:/);
  assert.match(prototype, /Native Reference Evidence/);
  assert.match(prototype, /validate-visual-qa-evidence.js/);
  assert.match(prototype, /DONE_WITH_CONCERNS/);
  assert.match(realApp, /Visual reference input/);
  assert.match(realApp, /Screenshot\/reference capture/);
  assert.match(realApp, /Visual reference:/);
  assert.match(realApp, /Native reference evidence/);
  assert.match(planner, /Reference fidelity fails closed/);
  assert.match(planner, /Reference Contract/);
  assert.match(designSystem, /Optional mode/);
  assert.match(optionalDesign, /Screenshot or design intake/);
  assert.match(optionalDesign, /reference-fidelity\.md/);
  assert.match(designRefiner, /Reference-contract mode/);
});

test('brief-derived experience contract drives planning without a reference input', () => {
  const expected = [
    'scripts/schema-experience-contract.json',
    'scripts/experience-patterns.js',
    'scripts/plan-experience-foundation.js',
    'scripts/compile-screen-build-pack.js',
    'scripts/validate-screen-build-pack.js',
    'scripts/schema-screen-build-pack.json',
    'scripts/validate-experience-contract.js',
    'scripts/validate-experience-visual-evidence.js',
    'shared/references/experience-contract-guide.md',
    'scripts/tests/experience-contract.test.js',
  ];
  for (const relativePath of expected) {
    assert.equal(fs.existsSync(path.join(pluginRoot, relativePath)), true, `${relativePath} must exist`);
  }

  const planner = read('agents/native-app-planner.md');
  const screenPlanner = read('agents/screen-planner.md');
  const screenBuilder = read('agents/screen-builder.md');
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const realApp = read('skills/create-mobile-app/SKILL.md');
  const designSystem = read('skills/design-system/SKILL.md');
  const automaticDesign = read('skills/design-system/automatic-native.md');
  const stylePicker = read('skills/design-system/references/vibe/style-picker.md');
  const refiner = read('skills/design-react-native-app/SKILL.md');
  const seeds = read('skills/create-mobile-prototype/scripts/gen-mock-services.js');
  const experienceViewModel = read('scripts/lib/experience-view-model.js');

  assert.match(planner, /Extract the Product Experience Contract/);
  assert.match(planner, /\.tmp\/experience-contract\.json/);
  assert.match(planner, /two to five `signatureMotifs`/);
  assert.doesNotMatch(planner, /INDUSTRY_CONFIRM_REQUESTED:/);
  const patterns = read('scripts/experience-patterns.js');
  assert.match(patterns, /SEMANTIC_SIGNALS/);
  assert.match(patterns, /promptEvidence/);
  assert.match(patterns, /product-led-discovery/);
  assert.match(patterns, /local-first/);
  assert.match(screenPlanner, /Primary screen composition contract/);
  assert.match(screenPlanner, /experience-foundation-contract\.json/);
  assert.match(screenPlanner, /keyFlow/);
  assert.match(screenPlanner, /Product-led discovery acceptance/);
  assert.doesNotMatch(screenPlanner, /Home is a dashboard by default/);
  assert.match(screenBuilder, /Primary-screen runtime anchors are mandatory/);
  assert.match(screenBuilder, /Foundation primitives are mandatory/);
  assert.match(screenBuilder, /Screen build pack is the execution source/);
  assert.match(screenBuilder, /validate-screen-build-pack\.js/);
  assert.match(screenBuilder, /Local-first media is mandatory/);
  assert.match(screenBuilder, /experience-primary-action/);
  assert.match(prototype, /does not require a screenshot, HTML page, or design intake/);
  assert.match(prototype, /validate-experience-contract\.js/);
  assert.match(prototype, /experience-foundation-contract\.json/);
  assert.match(prototype, /compile-screen-build-pack\.js/);
  assert.match(prototype, /screen_build_pack_path/);
  assert.match(prototype, /sidecar-declared `keyFlow`/);
  assert.match(realApp, /Experience direction: contract-first/);
  assert.match(realApp, /Materialize experience foundation primitives/);
  assert.match(realApp, /Compile the screen build pack/);
  assert.match(realApp, /screen_build_pack_path/);
  assert.match(realApp, /sidecar-declared `keyFlow`/);
  assert.doesNotMatch(realApp, /INDUSTRY_CONFIRM_REQUESTED:/);
  assert.match(designSystem, /Automatic native mode/);
  assert.doesNotMatch(designSystem, /polished-inspection/);
  assert.match(automaticDesign, /experience-contract\.json/);
  assert.match(automaticDesign, /design-context-evidence\.json/);
  assert.match(automaticDesign, /Do not render a gallery/);
  assert.doesNotMatch(automaticDesign, /DESIGN_EXPRESSION_RESULT/);
  assert.match(stylePicker, /DESIGN_EXPRESSION_RESULT/);
  assert.match(stylePicker, /never write a plan block/);
  assert.doesNotMatch(stylePicker, /direction-polished-inspection/);
  assert.match(refiner, /Experience-contract mode/);
  assert.match(refiner, /experience-foundation-contract\.json/);
  assert.match(refiner, /screen-build-pack\.json/);
  assert.match(refiner, /validate-screen-build-pack\.js/);
  assert.match(refiner, /keyFlowRoute/);
  assert.match(refiner, /DONE_WITH_CONCERNS: native experience visual capture unavailable/);
  assert.match(seeds, /experienceContract \? experiencePack/);
  assert.match(seeds, /scripts\/lib\/experience-view-model/);
  assert.match(experienceViewModel, /asset:\/\/experience/);
  assert.match(experienceViewModel, /stable record ID mapping/);
  assert.match(seeds, /loadScreenBuildPack/);
});

test('Open and legacy plugin metadata remain exact mirrors', () => {
  const openPlugin = JSON.parse(read('.plugin/plugin.json'));
  const legacyPlugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.deepEqual(legacyPlugin, openPlugin);
  assert.equal(openPlugin.keywords.includes('prototype'), true);
});

test('prototype applies navigation before bounded screen waves and starts Metro after complete validation', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  const shellIndex = skill.indexOf('apply-navigation-shell.js');
  const screenWaveIndex = skill.indexOf('Spawn one `mobile-app:screen-builder` for each target in a wave');
  const validationIndex = skill.indexOf('### Step 9 - Final Validation');
  const metroIndex = skill.indexOf('--project-root "$PROJECT_DIR" --require-complete-app');
  assert.ok(shellIndex > 0 && shellIndex < screenWaveIndex, 'navigation shell must be applied before screen fan-out');
  assert.ok(screenWaveIndex < validationIndex && validationIndex < metroIndex, 'Metro must start after bounded screen waves and complete-app validation');
  assert.doesNotMatch(skill, /native-canary|require-canary|supporting-\*/);
  assert.match(skill, /bounded `screens-\*` waves/);
  assert.match(skill, /write-screen-artifact\.js/);
  assert.match(skill, /route-manifest\.js[\s\S]*--status type-safe/);
});

test('prototype uses one consolidated non-mutating approval before data or design', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  const planner = read('agents/native-app-planner.md');
  assert.match(planner, /Prototype consolidated-draft override/);
  assert.match(planner, /do not enter Gate 1, Gate 2,[\s\S]*Gate 4a, Gate 4b/);
  assert.match(skill, /prototype-plan-review\.js[\s\S]*--action draft/);
  assert.match(skill, /prototype-plan-review\.js[\s\S]*--action approve --response approve/);
  assert.match(skill, /mayAuthorizeExternalMutations: false/);
  assert.doesNotMatch(skill, /This is a mock-backed prototype\. Run the normal approval gates/);
  const approval = skill.indexOf('--action approve --response approve');
  const data = skill.indexOf('#### Step 5 - Generate The Typed Domain Layer');
  const design = skill.indexOf('#### Step 6a - Generate Automatic Or Optional Design');
  assert.ok(approval > 0 && data > approval && design > approval);
});

test('prototype data and design lanes are disjoint and final validation reuses only unchanged passes', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  const validator = read('scripts/validate-mobile-app.js');
  assert.match(skill, /Data lane:[\s\S]*`src\/data\/`/);
  assert.match(skill, /Design lane:[\s\S]*`brand\/`/);
  assert.match(skill, /run these disjoint lanes in parallel/);
  assert.match(skill, /Do not\s+run a project-wide typecheck while either lane is writing/);
  assert.match(validator, /--reuse-if-unchanged/);
  assert.match(validator, /unchanged-since-recorded-pass/);
});
