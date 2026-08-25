'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('domain-first workflow artifacts and executable gates are present', () => {
  for (const relativePath of [
    'scripts/schema-prototype-domain-model.json',
    'scripts/schema-workflow-journey-contract.json',
    'scripts/schema-navigation-contract.json',
    'scripts/lib/prototype-domain-model.js',
    'scripts/lib/workflow-regression.js',
    'scripts/resolve-workflow-journey.js',
    'scripts/resolve-navigation-contract.js',
    'scripts/validate-navigation-contract.js',
    'scripts/validate-navigation-destinations.js',
    'scripts/validate-navigation-continuity.js',
    'scripts/apply-navigation-shell.js',
    'scripts/validate-navigation-shell.js',
    'scripts/validate-workflow-journey.js',
    'scripts/validate-ui-neutral-data-migration.js',
    'scripts/validate-action-state.js',
    'scripts/validate-cross-screen-continuity.js',
    'scripts/validate-signature-components.js',
    'scripts/validate-capability-composition.js',
    'scripts/validate-semantic-color-usage.js',
    'scripts/validate-static-layout-budgets.js',
    'scripts/validate-prototype-domain-model.js',
    'scripts/schema-dataverse-repository-mapping.json',
    'scripts/reconcile-domain-dataverse.js',
    'scripts/validate-mobile-app.js',
    'skills/create-mobile-prototype/scripts/gen-data-layer.js',
    'skills/create-mobile-prototype/scripts/migrate-legacy-prototype.js',
    'skills/create-mobile-prototype/scripts/configure-prototype-runtime.js',
    'skills/prototype-to-real-app/scripts/gen-dataverse-repositories.js',
    'shared/references/lifecycle-state.md',
  ]) assert.equal(fs.existsSync(path.join(pluginRoot, relativePath)), true, relativePath);
});

test('domain-first workflow Markdown keeps fenced blocks balanced', () => {
  for (const relativePath of [
    'skills/create-mobile-prototype/SKILL.md',
    'skills/prototype-to-real-app/SKILL.md',
    'skills/create-mobile-app/SKILL.md',
    'skills/edit-app/SKILL.md',
    'skills/edit-plan/SKILL.md',
    'skills/sync-from-plan/SKILL.md',
    'agents/native-app-planner.md',
    'agents/data-model-architect.md',
    'agents/screen-planner.md',
    'agents/screen-builder.md',
    'shared/references/lifecycle-state.md',
  ]) {
    const fenceCount = (read(relativePath).match(/^```/gm) || []).length;
    assert.equal(fenceCount % 2, 0, `${relativePath} has unbalanced code fences`);
  }
});

test('prototype creation plans a neutral domain with consolidated and explicit full local review modes', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /prototype-domain-model\.json/);
  assert.match(skill, /prototypeDomainModel/);
  assert.match(skill, /workflowJourneyContract/);
  assert.match(skill, /navigationContract/);
  assert.match(skill, /resolve-navigation-contract\.js/);
  assert.match(skill, /apply-navigation-shell\.js/);
  assert.match(skill, /validate-navigation-continuity\.js/);
  assert.match(skill, /resolve-workflow-journey\.js/);
  assert.match(skill, /validate-action-state\.js/);
  assert.match(skill, /validate-cross-screen-continuity\.js/);
  assert.match(skill, /validate-signature-components\.js/);
  assert.match(skill, /validate-capability-composition\.js/);
  assert.match(skill, /validate-semantic-color-usage\.js/);
  assert.match(skill, /validate-static-layout-budgets\.js/);
  assert.match(skill, /dataverseSchemaContract: null/);
  assert.match(skill, /--section prototype-review/);
  assert.match(skill, /mayAuthorizeExternalMutations: false/);
  assert.match(skill, /gen-data-layer\.js/);
  assert.match(skill, /PrototypeDataProvider/);
  assert.match(skill, /screen_work_order/);
  assert.doesNotMatch(skill, /screen-tasks/);
  assert.match(skill, /validate-mobile-app\.js[\s\S]*--scope all --record/);
  assert.match(skill, /After each wave, run the changed-file dispatcher[\s\S]*type-check/);
  assert.match(skill, /validate-mobile-files\.js[\s\S]*--file "\$TARGET_FILE"/);
  assert.doesNotMatch(skill, /gen-mock-services\.js/);
  assert.doesNotMatch(skill, /placeholder `cr_|publisher prefix: cr/i);
  assert.match(skill, /--review=consolidated\|full/);
});

test('planning agents keep Dataverse separate from canonical domain operations', () => {
  const nativePlanner = read('agents/native-app-planner.md');
  const dataArchitect = read('agents/data-model-architect.md');
  const screenPlanner = read('agents/screen-planner.md');
  for (const content of [nativePlanner, dataArchitect]) {
    assert.match(content, /prototypeDomainModel/);
    assert.match(content, /dataverseSchemaContract: null/);
    assert.match(content, /no environment/i);
  }
  assert.match(nativePlanner, /bundle schema version 3/);
  assert.match(nativePlanner, /workflowJourneyContract/);
  assert.match(nativePlanner, /navigationContract/);
  assert.match(nativePlanner, /foreground resolver owns the final instance/i);
  assert.match(screenPlanner, /Workflow Journey Contract/);
  assert.match(screenPlanner, /completion\s+guards/);
  assert.match(nativePlanner, /domain operation\/repository\/method\/hook/);
  assert.match(dataArchitect, /stable opaque IDs/);
  assert.match(dataArchitect, /fixtures/);
  assert.match(screenPlanner, /domainOperation/);
  assert.match(screenPlanner, /repository interface, repository method, and exported hook/);
  assert.doesNotMatch(screenPlanner, /serviceMethod/);
});

test('screen builders receive one in-memory work order and cannot cross the domain boundary', () => {
  const builder = read('agents/screen-builder.md');
  assert.match(builder, /screen_work_order/);
  assert.match(builder, /actionState/);
  assert.match(builder, /capabilityComposition/);
  assert.match(builder, /semanticColorRoles/);
  assert.match(builder, /layoutBudgets/);
  assert.match(builder, /src\/navigation/);
  assert.match(builder, /screen-build-pack\.json/);
  assert.match(builder, /consume only the supplied work order/i);
  assert.match(builder, /Import app data only from `@\/data`/);
  assert.match(builder, /Never import `@\/data\/fixtures`, `@\/data\/repositories`, or `@\/generated`/);
  assert.match(builder, /isDomainRecordActionable/);
  assert.match(builder, /resolveDomainMedia/);
  assert.match(builder, /mobile-screen-artifact/);
  assert.doesNotMatch(builder.match(/^---\n([\s\S]*?)\n---/)[1], /^\s+-\s+(?:Write|Edit)\s*$/m);
});

test('graduation reconciles and swaps adapters without rewriting screens', () => {
  const skill = read('skills/prototype-to-real-app/SKILL.md');
  assert.match(skill, /prototype-domain-model\.json.*remains canonical/s);
  assert.match(skill, /validate-ui-neutral-data-migration\.js/);
  assert.match(skill, /reconcile-domain-dataverse\.js/);
  assert.match(skill, /dataverse-repository-mapping\.json/);
  assert.match(skill, /gen-dataverse-repositories\.js/);
  assert.match(skill, /dataverseRepositories\.ts/);
  assert.match(skill, /proves? screens unchanged|unchanged-screen/i);
  assert.match(skill, /configure-prototype-runtime\.js[\s\S]*dataverse/);
  assert.match(skill, /validate-mobile-app\.js[\s\S]*--scope all --record/);
  assert.doesNotMatch(skill, /rebase-prototype-plan|cleanup-prototype-artifacts|replace services/i);
});

test('direct real creation uses the same domain adapter and task architecture', () => {
  const skill = read('skills/create-mobile-app/SKILL.md');
  assert.match(skill, /AUTHORITATIVE DOMAIN-FIRST OVERRIDE/);
  assert.match(skill, /gen-data-layer\.js/);
  assert.match(skill, /reconcile-domain-dataverse\.js/);
  assert.match(skill, /gen-dataverse-repositories\.js/);
  assert.match(skill, /screen_work_order/);
  assert.match(skill, /Only[\s\S]*dataverseRepositories\.ts[\s\S]*generated services/i);
});

test('native and connector mutations require exact approved execution rows', () => {
  const native = read('skills/add-native/SKILL.md');
  const connector = read('skills/add-connector/SKILL.md');
  assert.match(native, /capability\s+to exactly one `nativeCapabilities\[\]` row/i);
  assert.match(native, /native capability is not in the approved execution\s+contract/);
  assert.match(connector, /exactly one `connectorOperations\[\]` row by its stable\s+row ID/i);
  assert.match(connector, /API\s+name alone is not permission/i);
  assert.match(connector, /multiple rows remain ambiguous/i);
});

test('preview, debug, and deploy consume canonical lifecycle readiness', () => {
  for (const [skillPath, consumer] of [
    ['skills/preview-screens/SKILL.md', 'preview'],
    ['skills/debug-app/SKILL.md', 'debug'],
    ['skills/deploy/SKILL.md', 'deploy'],
  ]) {
    const skill = read(skillPath);
    assert.match(skill, /validate-lifecycle-readiness\.js/);
    assert.match(skill, new RegExp(`--consumer ${consumer}`));
  }
  assert.match(read('skills/deploy/SKILL.md'), /dataMode: dataverse/);
  assert.match(read('skills/deploy/SKILL.md'), /qualityStatus: runtime-validated/);
});

test('edit and sync workflows regenerate repositories rather than screen services', () => {
  const edit = read('skills/edit-app/SKILL.md');
  const editPlan = read('skills/edit-plan/SKILL.md');
  const sync = read('skills/sync-from-plan/SKILL.md');
  for (const content of [edit, sync]) {
    assert.match(content, /gen-data-layer\.js/);
    assert.match(content, /reconcile-domain-dataverse\.js/);
    assert.match(content, /gen-dataverse-repositories\.js/);
    assert.match(content, /validate-mobile-app\.js/);
    assert.doesNotMatch(content, /gen-mock-services\.js/);
  }
  assert.match(editPlan, /prototype-domain-model\.json/);
  assert.match(editPlan, /dataverseSchemaContract: null/);
  assert.doesNotMatch(editPlan, /screen-tasks/);
});

test('runtime and lifecycle preserve host query ownership and revision identity', () => {
  const runtime = read('skills/create-mobile-prototype/scripts/configure-prototype-runtime.js');
  const generator = read('skills/create-mobile-prototype/scripts/gen-data-layer.js');
  const lifecycle = read('shared/references/lifecycle-state.md');
  assert.match(runtime, /<PrototypeDataProvider>\{children\}<\/PrototypeDataProvider>/);
  assert.match(runtime, /<PowerAppsProvider/);
  assert.doesNotMatch(runtime, /QueryClientProvider/);
  assert.doesNotMatch(generator, /QueryClientProvider/);
  assert.match(lifecycle, /"schemaVersion": 2/);
  assert.match(lifecycle, /lastDomainModelHash/);
  assert.match(lifecycle, /lastWorkflowJourneyHash/);
  assert.match(lifecycle, /lastNavigationContractHash/);
  assert.match(lifecycle, /lastNavigationShellHash/);
  assert.match(lifecycle, /lastRepositoryMappingHash/);
  assert.match(lifecycle, /lastFixtureRevision/);
  assert.match(lifecycle, /lastValidation/);
});

test('legacy compatibility is explicit, transactional, and not the normal path', () => {
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const migrator = read('skills/create-mobile-prototype/scripts/migrate-legacy-prototype.js');
  assert.match(prototype, /one-time transactional[\s\S]{0,20}migrator/);
  assert.match(migrator, /legacy-prototype-archive/);
  assert.match(migrator, /preservedFixtures/);
  assert.match(migrator, /restoreArchive/);
  assert.match(migrator, /prototype-domain-migration\.json/);
});

test('reference-led and brief-only experience inputs remain supported', () => {
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const nativePlanner = read('agents/native-app-planner.md');
  const screenPlanner = read('agents/screen-planner.md');
  assert.match(prototype, /--from-screenshot/);
  assert.match(prototype, /--design-intake/);
  assert.match(prototype, /reference fidelity/i);
  assert.match(prototype, /one-line mobile app brief/);
  assert.match(nativePlanner, /Product Experience\s+Contract/);
  assert.match(nativePlanner, /contractHash\(\)/);
  assert.match(screenPlanner, /first-viewport focal point/);
  assert.match(screenPlanner, /experienceFoundationContract/);
});

test('Open and legacy plugin metadata remain exact mirrors', () => {
  const openPlugin = JSON.parse(read('.plugin/plugin.json'));
  const legacyPlugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.deepEqual(legacyPlugin, openPlugin);
  assert.equal(openPlugin.keywords.includes('prototype'), true);
});