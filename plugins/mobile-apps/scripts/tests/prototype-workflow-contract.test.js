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
    'scripts/manage-prototype-metro.js',
    'scripts/render-prototype-workspace.js',
    'scripts/prepare-design-context.js',
    'scripts/validate-datamodel-manifest.js',
    'scripts/validate-screen-contracts.js',
    'shared/references/lifecycle-state.md',
    'shared/references/host-capability-adapter.md',
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
  assert.match(planner, /Prototype consolidated-review override/);
  assert.match(planner, /Present exactly one final plan-mode review/);
  assert.match(planner, /must never authorize[\s\S]*external mutation/);
});

test('prototype workflow uses one consolidated editable review', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /one consolidated final review/);
  assert.match(skill, /Do not pause at[\s\S]*real-app section gates/);
  assert.match(skill, /Prototype approval never authorizes external[\s\S]*mutation/);
});

test('host capability gaps hand work to the foreground without filesystem blame', () => {
  const adapter = read('shared/references/host-capability-adapter.md');
  const planner = read('agents/native-app-planner.md');
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const realApp = read('skills/create-mobile-app/SKILL.md');
  assert.match(adapter, /NEEDS_CONTEXT: host-capability-handoff/);
  assert.match(adapter, /not an app-project failure/);
  assert.match(adapter, /same immutable screen-build-pack entry/);
  assert.match(planner, /NEEDS_CONTEXT: host-capability-handoff/);
  assert.doesNotMatch(planner, /BLOCKED: tool surface missing <comma-separated tool names>/);
  assert.match(prototype, /host-capability-handoff/);
  assert.match(prototype, /ordinary chat[\s\S]*explicit `approve`/);
  assert.match(realApp, /host-capability handoff/);
});

test('prototype probes Metro immediately before launch and records truthful reuse evidence', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /manage-prototype-metro\.js[\s\S]*--action prepare/);
  assert.match(skill, /action: verify-reuse[\s\S]*Metro waiting on/);
  assert.match(skill, /Metadata is not health evidence/);
  assert.match(skill, /--action failed[\s\S]*manualCommand/);
  assert.doesNotMatch(skill, /node -e 'const net=require\("net"\)/);
});

test('prototype maintains one derived editable maker workspace through every phase', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /render-prototype-workspace\.js/);
  assert.match(skill, /_prototype_workspace\.html/);
  assert.match(skill, /never a planning authority or native UX[\s\S]*evidence/);
  assert.match(skill, /prototype-review\.json/);
  assert.match(skill, /after screen-build-pack compilation, every builder wave, final[\s\S]*validation, and each Metro ready\/failed state transition/);
});

test('automatic prototype design records a compact mode-owned reference set', () => {
  const designSystem = read('skills/design-system/SKILL.md');
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(designSystem, /Mode-owned reference loading/);
  assert.match(designSystem, /prepare-design-context\.js/);
  assert.match(designSystem, /Read exactly the returned `referenceFiles`/);
  assert.match(designSystem, /prompt-only path uses `automatic`/);
  assert.doesNotMatch(designSystem, /## References — read before executing/);
  assert.match(prototype, /design-execution-evidence\.json/);
  assert.match(prototype, /Reject an[\s\S]*automatic manifest[\s\S]*style[\s\S]*picker/);
});

test('runtime data and design use a disjoint parallel boundary with one validated join', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /approved `\.tmp\/dataverse-schema-contract\.json`[\s\S]*before either[\s\S]*lane starts/);
  assert.match(skill, /Data lane:[\s\S]*`src\/generated\/`[\s\S]*`assets\/experience\/`/);
  assert.match(skill, /Design lane:[\s\S]*`brand\/`[\s\S]*design-execution-evidence\.json/);
  assert.match(skill, /Sequential fallback changes only[\s\S]*scheduling, not artifacts or validation/);
  assert.match(skill, /Join only after both lanes succeed/);
  assert.match(skill, /Do not run a[\s\S]*typecheck while either lane is still writing/);
});

test('prototype repair policy continues harmless bookkeeping and blocks semantic loss', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /Non-blocking internal repair boundary/);
  assert.match(skill, /casing, surrounding[\s\S]*omitted optional arrays[\s\S]*prototype primary IDs/);
  assert.match(skill, /prototype-seed-regeneration\.json/);
  assert.match(skill, /continue without regenerating the plan/);
  assert.match(skill, /unauthorized external mutation[\s\S]*lose an explicit requirement[\s\S]*lookup\/relationship unresolved/);
  assert.match(skill, /Never repair[\s\S]*dropping a[\s\S]*product job/);
});

test('prototype builds the complete ordered key flow before Metro', () => {
  const screenPlanner = read('agents/screen-planner.md');
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(screenPlanner, /ordered[\s\S]*`keyFlow\.screens`/);
  assert.match(screenPlanner, /Include every required step through completion/);
  assert.match(screenPlanner, /Omit[\s\S]*`screens` for a true one-screen key flow/);
  assert.match(skill, /permanent Home followed by every ordered screen/);
  assert.match(skill, /Do not start Metro unless Home and every declared key-flow screen are real TSX/);
  assert.match(skill, /capture the primary screen and every sidecar-declared key-flow route/);
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
  assert.match(prototype, /every sidecar-declared key-flow route/);
  assert.match(realApp, /Experience direction: contract-first/);
  assert.match(realApp, /Materialize experience foundation primitives/);
  assert.match(realApp, /Compile the screen build pack/);
  assert.match(realApp, /screen_build_pack_path/);
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
