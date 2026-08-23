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

test('Open and legacy plugin metadata remain exact mirrors', () => {
  const openPlugin = JSON.parse(read('.plugin/plugin.json'));
  const legacyPlugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.deepEqual(legacyPlugin, openPlugin);
  assert.equal(openPlugin.keywords.includes('prototype'), true);
});

test('generate path binds the 24-export kit and does not invent entity widgets', () => {
  const kit = read('shared/samples/src/components/index.tsx');
  const templates = read('shared/references/screen-templates.md');
  const planner = read('agents/screen-planner.md');
  const builder = read('agents/screen-builder.md');
  const createApp = read('skills/create-mobile-app/SKILL.md');
  const prototype = read('skills/create-mobile-prototype/SKILL.md');

  const kitExports = kit.match(/^export function \w+/gm) || [];
  assert.equal(kitExports.length, 24, 'public kit must stay at 24 exports');
  for (const name of ['ImageHero', 'ProgressMeter', 'EntityRow', 'NumericStepper', 'Callout']) {
    assert.match(kit, new RegExp(`export function ${name}\\(`));
  }
  assert.match(kit, /variant\?: 'banner' \| 'endpoint-pair'/);
  assert.match(kit, /safeArea = true/);
  assert.match(kit, /bg=\{selected \? '\$accentBase' : '\$surface2'\}/);
  assert.doesNotMatch(kit, /\$blue10/);

  assert.match(templates, /Finite public kit/);
  assert.match(templates, /Home stack/);
  assert.match(templates, /UX rails/);
  assert.match(templates, /Chip count is whatever the domain needs/);
  assert.match(templates, /Generic names → kit/);
  assert.match(templates, /Do not fork/);
  assert.match(templates, /Theme card/);
  assert.match(templates, /tone: professional \| friendly \| calm \| bold/);
  assert.match(templates, /BottomActionBar safeArea=\{false\}/);
  assert.match(templates, /No FAB over tabs/);
  assert.match(templates, /Hero stays secondary/);
  assert.match(templates, /Tabs ≤ 5/);
  assert.match(templates, /Header \+ footer/);
  assert.match(templates, /Stepper style B only/);
  assert.match(templates, /Qty \/ line row/);
  assert.match(templates, /soft card/);
  assert.match(templates, /bg="\$surface1"/);
  assert.doesNotMatch(templates, /not a heavy card per row/);
  assert.match(builder, /wrap each line in a soft card/);
  assert.match(templates, /Summary footer/);
  assert.match(templates, /Button shapes/);
  assert.match(templates, /Photo-led browse/);
  assert.match(kit, /fontSize="\$2" fontWeight="600"/);
  assert.match(kit, /circular/);
  assert.match(kit, /bg="\$surface2"/);
  assert.doesNotMatch(templates, /Catalogue keys \(resolve/);
  assert.doesNotMatch(planner, /FilterChipRow` for 2-5 mutually-exclusive/);

  assert.match(planner, /Bind every screen from those 24 exports/);
  assert.match(planner, /Do \*\*not\*\* read `universal-patterns\.md`/);
  assert.doesNotMatch(planner, /Operational pattern: home-dashboard` for the Home screen/);
  assert.doesNotMatch(planner, /\*\*Row style override\*\*/);

  assert.match(builder, /Finite kit only/);
  assert.match(builder, /Do \*\*not\*\* read `mobile-design-philosophy\.md`/);
  assert.match(builder, /import \{ LoadingState, ErrorState, EmptyState, ScreenHeader, ModalHeader, BottomActionBar, FloatingActionButton, FilterChipRow, FormField, RowPick, StatusPill, StatTile, Hero, ImageHero, ProgressMeter, EntityRow, NumericStepper, Callout, AvatarInitials, InfoRow, ActionRow, SectionHeader, EntityImage \} from '@\/components'/);
  assert.match(builder, /BottomActionBar safeArea=\{false\}/);
  assert.match(builder, /Never render `FloatingActionButton` on a tab-root screen/);
  assert.match(builder, /Header and footer are required chrome/);
  assert.doesNotMatch(builder, /look up the required layout pieces/);

  assert.match(createApp, /Do \*\*not\*\* generate `<Entity>Row\.tsx`/);
  assert.match(createApp, /reuses the planner recommendation/);
  assert.match(createApp, /no second orchestrator classification/);
  assert.doesNotMatch(createApp, /brief-recommended/);
  assert.doesNotMatch(createApp, /preview with Field\/Ops defaults/);
  assert.doesNotMatch(createApp, /cat > "<working_dir>\/src\/components\/InspectionRow\.tsx"/);
  assert.doesNotMatch(createApp, /industry-inferred defaults from `universal-patterns\.md`/);

  assert.match(prototype, /service methods \(getAll\/get\/create\/update\/delete\)/);
  assert.doesNotMatch(prototype, /CRUD contract that graduation will preserve/);
});