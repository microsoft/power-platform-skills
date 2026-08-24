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
    'skills/create-mobile-prototype/scripts/configure-prototype-runtime.js',
    'skills/edit-plan/SKILL.md',
    'skills/prototype-to-real-app/SKILL.md',
    'skills/prototype-to-real-app/scripts/rebase-prototype-plan.js',
    'skills/add-sample-data/scripts/prepare-prototype-seed-migration.js',
    'skills/sync-from-plan/SKILL.md',
    'scripts/cleanup-prototype-artifacts.js',
    'scripts/validate-datamodel-manifest.js',
    'scripts/validate-screen-contracts.js',
    'scripts/plan-approval.js',
    'scripts/plan-checkpoints.js',
    'scripts/mobile-plan-preflight-catalog.json',
    'scripts/prepare-mobile-plan-execution-contract.js',
    'scripts/schema-mobile-plan-execution-contract.json',
    'scripts/validate-mobile-plan-execution-contract.js',
    'scripts/schema-screen-artifact.json',
    'scripts/validate-screen-artifact.js',
    'scripts/write-screen-artifact.js',
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
  assert.match(skill, /gen-mock-services\.js/);
  assert.match(skill, /configure-prototype-runtime\.js[\s\S]*prototype/);
  assert.match(skill, /\.mobile-app\/state\.json/);
  assert.doesNotMatch(skill, /code-apps-native:/);
  assert.doesNotMatch(skill, /pac code|create-code-app-native/);
});

test('prototype creation is host-neutral and does not require nested approval tools', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /return one complete[\s\S]*mobile-plan-artifact-bundle/i);
  assert.match(skill, /Do not probe named host tools/i);
  assert.match(skill, /Four textual prototype checkpoints/);
  assert.match(skill, /data-model\|native-capabilities\|connectors\|screen-plan/);
  assert.match(skill, /plan-checkpoints\.js/);
  assert.match(skill, /local mock[\s\S]*generation/i);
  assert.match(skill, /planningMode: "prototype"/);
  assert.doesNotMatch(skill, /Nested planner tool-surface fallback/);
  assert.match(skill, /outer workflow records four ordinary\s+textual local checkpoints/i);
  assert.match(skill, /test -f "\$PROJECT_DIR\/\.tmp\/mobile-plan-status\.json"/);
  assert.match(skill, /validate-plan-artifact-bundle\.js/);
  assert.match(skill, /write-plan-artifact-bundle\.js/);
  assert.match(skill, /prepare-mobile-plan-execution-contract\.js/);
  assert.match(skill, /mobile-plan-execution-contract\.json/);
  assert.match(skill, /schemaVersion!==3/);
  assert.match(skill, /validate-mobile-files\.js[\s\S]*experience-foundation-contract\.json/);
});

test('real app planning uses a textual revision-bound approval before external mutation', () => {
  const planner = read('agents/native-app-planner.md');
  const skill = read('skills/create-mobile-app/SKILL.md');
  const protocol = read('scripts/plan-checkpoints.js');
  assert.match(planner, /NEEDS_USER_APPROVAL/);
  assert.doesNotMatch(planner, /BLOCKED: tool surface missing/);
  assert.match(skill, /Textual plan approval protocol/);
  assert.match(skill, /--action approve/);
  assert.match(skill, /External mutation authorization/);
  assert.match(protocol, /plan-revision-changed/);
  assert.match(protocol, /textual-approve-required/);
});

test('conversion rejects prototype approvals and commits through one target-mode sync', () => {
  const skill = read('skills/prototype-to-real-app/SKILL.md');
  assert.match(skill, /^name: prototype-to-real-app$/m);
  assert.match(skill, /transitioning/);
  assert.match(skill, /npx power-apps init -t MobileApp/);
  assert.match(skill, /rebase-prototype-plan\.js/);
  assert.match(skill, /add-dataverse --skip-planning/);
  assert.match(skill, /cleanup-prototype-artifacts\.js/);
  assert.match(skill, /live-name-map\.json/);
  assert.match(skill, /dataverseManifestSha256/);
  assert.match(skill, /prepare-prototype-seed-migration\.js/);
  assert.match(skill, /Never replace failed prototype mappings with generic rows/);
  assert.match(skill, /configure-prototype-runtime\.js[\s\S]*dataverse/);
  assert.match(skill, /sync-from-plan --working-dir <PROJECT_DIR> --target-data-mode dataverse/);
  assert.match(skill, /Do not pass the prototype schema contract/);
  assert.match(skill, /Remove `\.tmp\/screen-build-pack\.json` immediately after archiving/);
  assert.match(skill, /regenerate schema-v3 screen operations/);
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
  assert.match(skill, /lastSyncedScreenContractHash/);
  assert.match(skill, /lastSyncedExecutionContractHash/);
});

test('planning agents explicitly support environment-free prototype mode', () => {
  const architect = read('agents/data-model-architect.md');
  const planner = read('agents/native-app-planner.md');
  for (const content of [architect, planner]) {
    assert.match(content, /`prototype`/);
    assert.match(content, /planningMode.*prototype/);
    assert.match(content, /executionEligible.*false/);
  }
  assert.match(architect, /no environment/);
  assert.match(planner, /Prototype plans are not execution\s+approvals/);
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
  assert.match(skill, /screenContractSha256/);
  assert.match(skill, /executionContractSha256/);
  assert.match(skill, /remove\s+`\.tmp\/screen-build-pack\.json`/i);
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
  assert.match(designSystem, /Reference-contract mode/);
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
    'scripts/schema-screen-artifact.json',
    'scripts/validate-screen-artifact.js',
    'scripts/write-screen-artifact.js',
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
  const stylePicker = read('skills/design-system/references/vibe/style-picker.md');
  const refiner = read('skills/design-react-native-app/SKILL.md');
  const seeds = read('skills/create-mobile-prototype/scripts/gen-mock-services.js');
  const experienceViewModel = read('scripts/lib/experience-view-model.js');

  assert.match(planner, /foreground Experience Contract/);
  assert.match(planner, /\.tmp\/experience-contract\.json/);
  assert.match(planner, /motifs/);
  assert.doesNotMatch(planner, /INDUSTRY_CONFIRM_REQUESTED:/);
  const patterns = read('scripts/experience-patterns.js');
  assert.match(patterns, /SEMANTIC_SIGNALS/);
  assert.match(patterns, /promptEvidence/);
  assert.match(patterns, /product-led-discovery/);
  assert.match(patterns, /local-first/);
  assert.match(screenPlanner, /primary screen composition contract/i);
  assert.match(screenPlanner, /experienceFoundationContract/);
  assert.match(screenPlanner, /keyFlow/);
  assert.match(screenPlanner, /product-led discovery/);
  assert.doesNotMatch(screenPlanner, /Home is a dashboard by default/);
  assert.match(screenBuilder, /Primary-screen runtime anchors are mandatory/);
  assert.match(screenBuilder, /Foundation primitives are mandatory/);
  assert.match(screenBuilder, /Screen build pack is the execution source/);
  assert.match(screenBuilder, /validate-screen-build-pack\.js/);
  assert.match(screenBuilder, /Local-first media is mandatory/);
  assert.match(screenBuilder, /experience-primary-action/);
  assert.match(screenBuilder, /return-only agent/);
  assert.match(screenBuilder, /mobile-screen-artifact/);
  assert.doesNotMatch(screenBuilder.match(/^---\n([\s\S]*?)\n---/)[1], /^\s+-\s+(?:Write|Edit)\s*$/m);
  assert.match(prototype, /does not require a screenshot, HTML page, or design intake/);
  assert.match(prototype, /validate-experience-contract\.js/);
  assert.match(prototype, /experience-foundation-contract\.json/);
  assert.match(prototype, /compile-screen-build-pack\.js/);
  assert.match(prototype, /screen_build_pack_path/);
  assert.match(prototype, /validate-screen-artifact\.js/);
  assert.match(prototype, /write-screen-artifact\.js/);
  assert.match(prototype, /sidecar-declared `keyFlow`/);
  assert.match(realApp, /Experience direction: contract-first/);
  assert.match(realApp, /Materialize experience foundation primitives/);
  assert.match(realApp, /Compile the screen build pack/);
  assert.match(realApp, /screen_build_pack_path/);
  assert.match(realApp, /validate-screen-artifact\.js/);
  assert.match(realApp, /write-screen-artifact\.js/);
  assert.match(realApp, /sidecar-declared `keyFlow`/);
  assert.doesNotMatch(realApp, /INDUSTRY_CONFIRM_REQUESTED:/);
  assert.match(designSystem, /Experience-contract mode/);
  assert.doesNotMatch(designSystem, /polished-inspection/);
  assert.match(designSystem, /DESIGN_EXPRESSION_RESULT/);
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
