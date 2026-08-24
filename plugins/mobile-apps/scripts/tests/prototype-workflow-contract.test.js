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
    'scripts/lib/prototype-domain-model.js',
    'scripts/validate-prototype-domain-model.js',
    'scripts/schema-dataverse-repository-mapping.json',
    'scripts/reconcile-domain-dataverse.js',
    'scripts/validate-screen-task-pack.js',
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

test('prototype creation plans a neutral domain and uses one consolidated review', () => {
  const skill = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(skill, /prototype-domain-model\.json/);
  assert.match(skill, /prototypeDomainModel/);
  assert.match(skill, /dataverseSchemaContract: null/);
  assert.match(skill, /--section prototype-review/);
  assert.match(skill, /mayAuthorizeExternalMutations: false/);
  assert.match(skill, /gen-data-layer\.js/);
  assert.match(skill, /PrototypeDataProvider/);
  assert.match(skill, /validate-screen-task-pack\.js/);
  assert.match(skill, /screen_task_path/);
  assert.match(skill, /validate-mobile-app\.js[\s\S]*--scope all --record/);
  assert.doesNotMatch(skill, /gen-mock-services\.js/);
  assert.doesNotMatch(skill, /placeholder `cr_|publisher prefix: cr/i);
  assert.doesNotMatch(skill, /four textual|data-model\|native-capabilities\|connectors\|screen-plan/i);
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
  assert.match(nativePlanner, /domain operation\/repository\/method\/hook/);
  assert.match(dataArchitect, /stable opaque IDs/);
  assert.match(dataArchitect, /fixtures/);
  assert.match(screenPlanner, /domainOperation/);
  assert.match(screenPlanner, /repository interface, repository method, and exported hook/);
  assert.doesNotMatch(screenPlanner, /serviceMethod/);
});

test('screen builders receive one immutable task and cannot cross the domain boundary', () => {
  const builder = read('agents/screen-builder.md');
  assert.match(builder, /screen_task_path/);
  assert.match(builder, /mobile-screen-task/);
  assert.match(builder, /read only the supplied task/i);
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
  assert.match(skill, /validate-screen-task-pack\.js/);
  assert.match(skill, /screen_task_path/);
  assert.match(skill, /Only[\s\S]*dataverseRepositories\.ts[\s\S]*generated services/i);
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
  assert.match(editPlan, /screen-tasks/);
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