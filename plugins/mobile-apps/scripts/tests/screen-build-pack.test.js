'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compileScreenBuildPack, parseScreenMap } = require('../compile-screen-build-pack');
const { deriveExperienceFromBrief, foundationContract, primaryComposition } = require('../experience-patterns');
const { normalizeScreenContract } = require('../lib/experience-screen-contract');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveNavigationContract } = require('../resolve-navigation-contract');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');
const { validateScreenBuildPack } = require('../validate-screen-build-pack');

const passengerBrief = [
  'Create a mobile app for showcasing inventory items to flight passengers.',
  'This app will be used in flight for selling travel accessories, beauty products and watches.',
  'The app should have clean aesthetics, should be accessible and easy to use.',
  'Ui screen only.',
].join('\n');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-build-pack-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = deriveExperienceFromBrief(passengerBrief);
  const composition = primaryComposition(contract);
  const foundation = foundationContract(contract);
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-foundation-contract.json'), `${JSON.stringify(foundation, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), `${JSON.stringify({
    schemaVersion: 1,
    experienceContractSha256: hash(JSON.stringify(contract)),
    primaryScreen: { route: contract.primaryScreen.route, file: contract.primaryScreen.file, ...composition },
    keyFlow: { route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', outcome: 'Inspect a product before adding it to cart.' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), `${JSON.stringify({
    planningMode: 'prototype',
    tables: [
      { logicalName: 'cr_product', displayName: 'Product', serviceRequired: true },
      { logicalName: 'cr_category', displayName: 'Category', serviceRequired: true },
      { logicalName: 'cr_cartitem', displayName: 'Cart item', serviceRequired: true },
    ],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'brand', 'design-system.md'), '# Design\n\n## Product Experience Primitives\n');
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), 'export const tokens = {} as const;\n');
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), [
    '## Screens',
    '',
    '### Screen Map',
    '| Screen | Route | File |',
    '| --- | --- | --- |',
    '| Home | /(app)/home | app/(app)/home.tsx |',
    '| Product detail | /(app)/products/[id] | app/(app)/products/[id].tsx |',
    '| Cart | /(app)/cart | app/(app)/cart.tsx |',
  ].join('\n'));
  return { root, contract };
}

function createRichProject(context) {
  const value = createProject(context);
  const { root, contract } = value;
  const planPath = path.join(root, 'native-app-plan.md');
  fs.appendFileSync(planPath, '\n| Profile | /(app)/profile | app/(app)/profile.tsx |\n');
  const foundation = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'experience-foundation-contract.json'), 'utf8'));
  const legacy = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), 'utf8'));
  const normalized = normalizeScreenContract(
    legacy,
    contract,
    parseScreenMap(fs.readFileSync(planPath, 'utf8')),
    foundation.primitives.map((primitive) => primitive.component),
  ).map((screen) => {
    const durable = ['Home', 'Cart'].includes(screen.id);
    const profile = screen.id === 'Profile';
    return {
      ...screen,
      contractSource: 'structured',
      routeParameters: [],
      productRole: durable ? 'durable-destination' : profile ? 'global-utility' : 'nested-detail',
      navigation: durable
        ? { kind: 'stack-root', intent: 'navigate', candidate: {
            hasStableRoot: true, revisitedIndependently: true, preservesOwnState: true,
            crossSessionValue: screen.id === 'Cart', peerToOtherDestinations: true,
            isNotAFlowStep: true, isNotAnAction: true,
            supportedByBriefOrSafeProductInference: true, badgeBinding: null,
            iconIntent: screen.id === 'Home' ? 'home' : 'bag',
          } }
        : { kind: 'pushed', intent: 'push', parentRoute: '/(app)/home', candidate: {
            hasStableRoot: false, revisitedIndependently: false, preservesOwnState: false,
            crossSessionValue: false, peerToOtherDestinations: false,
            isNotAFlowStep: !profile, isNotAnAction: true,
            supportedByBriefOrSafeProductInference: false, badgeBinding: null,
            iconIntent: profile ? 'profile' : 'browse',
          } },
      data: { ...screen.data, operations: [] },
      ...(profile ? { header: { mode: 'root', title: 'Profile' } } : {}),
    };
  });
  const preliminary = {
    ...legacy,
    schemaVersion: 2,
    criticalFlow: { screenIds: ['Home', 'ProductsId'], outcome: 'Inspect a product before adding it to the bag.' },
    screens: normalized,
  };
  const contextContract = resolveContextEnrichment(passengerBrief, contract);
  const journey = resolveWorkflowJourney(passengerBrief, contract, contextContract, { screenContract: preliminary });
  const navigation = resolveNavigationContract(passengerBrief, contract, journey, preliminary);
  fs.writeFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), `${JSON.stringify(contextContract, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'workflow-journey-contract.json'), `${JSON.stringify(journey, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'navigation-contract.json'), `${JSON.stringify(navigation.contract, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), `${JSON.stringify(navigation.screenContract, null, 2)}\n`);
  return value;
}

test('fails clearly when a canonical source is missing', (context) => {
  const { root } = createProject(context);
  fs.rmSync(path.join(root, 'brand', 'tokens.ts'));
  assert.throws(() => compileScreenBuildPack(root), /Design tokens is missing/);
});

test('compiles a passenger discovery build pack from canonical contracts', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  assert.match(pack.revision, /^[a-f0-9]{64}$/);
  assert.equal(pack.experience.entryMode, 'discovery');
  assert.equal(pack.experience.primarySurface, 'product-led-discovery');
  assert.deepEqual(pack.fixtures, {
    adapter: 'local',
    entities: ['Product', 'Category', 'Cart item'],
    assetPolicy: 'remote-cdn-cached',
    dataIntentPath: '.tmp/dataverse-schema-contract.json',
    assetManifest: 'assets/experience/manifest.json',
    viewModel: 'src/generated/experience-view-model.ts',
    recordIdentity: 'stable-primary-key',
    mediaPolicy: 'remote-cdn-cached',
    mediaManifest: 'assets/experience/manifest.json',
    mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
  });
  assert.equal(pack.design.primitives.some((primitive) => primitive.component === 'ExperienceCartAction'), true);
  assert.deepEqual(pack.shell, {
    safeAreaOwner: 'screen',
    rootSafeAreaProviderOnly: true,
    headerModes: {
      '/(app)/home': 'root',
      '/(app)/products/[id]': 'back',
      '/(app)/cart': 'back',
    },
  });
  const home = pack.screens.find((screen) => screen.role === 'primary');
  assert.ok(home.firstViewport.includes('ExperienceFeaturedProductMedia'));
  assert.equal(home.primaryAction, 'Browse onboard products');
  assert.deepEqual(home.states, ['loading', 'empty', 'error', 'offline']);
  assert.equal(home.headerMode, 'root');
  assert.deepEqual(home.data, {
    adapter: 'local',
    entities: ['Product', 'Category', 'Cart item'],
    viewModel: 'src/generated/experience-view-model.ts',
    recordIdentity: 'stable-primary-key',
    mediaPolicy: 'remote-cdn-cached',
    mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
  });
  assert.ok(home.dependencies.includes('fixture:Product'));
  assert.equal(pack.navigation.keyFlowRoute, '/(app)/products/[id]');
  assert.deepEqual(validateScreenBuildPack(root, pack), { issues: [], staleTargets: [] });
});

test('source drift changes revision and invalidates only dependent targets', (context) => {
  const { root } = createProject(context);
  const first = compileScreenBuildPack(root);
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), 'export const tokens = { accent: "#123456" } as const;\n');
  const stale = validateScreenBuildPack(root, first);
  assert.equal(stale.issues.some((issue) => issue.source === 'designRecipe'), true);
  assert.ok(stale.staleTargets.includes('screen:Home'));
  assert.ok(stale.staleTargets.includes('validator:nativeVisual'));
  assert.equal(stale.staleTargets.some((target) => target.startsWith('fixture:')), false);
  const second = compileScreenBuildPack(root);
  assert.notEqual(second.revision, first.revision);
  assert.deepEqual(validateScreenBuildPack(root, second), { issues: [], staleTargets: [] });
});

test('prototype mock generation records the consumed pack revision', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  fs.writeFileSync(path.join(root, '.tmp', 'screen-build-pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'skills', 'create-mobile-prototype', 'scripts', 'gen-mock-services.js'),
    root,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'generated', '.prototype-manifest.json'), 'utf8'));
  assert.equal(manifest.screenBuildPackRevision, pack.revision);
  assert.equal(manifest.experienceContractSource, '.tmp/screen-build-pack.json#experience');
});

test('rich Screen Contracts compile into the V3 validator-owned build-pack shape', (context) => {
  const { root } = createRichProject(context);
  const pack = compileScreenBuildPack(root);
  assert.equal(pack.schemaVersion, 2);
  assert.equal(pack.screenContractVersion, 2);
  assert.equal(pack.navigation.model, 'tabs-stack');
  assert.deepEqual(pack.navigation.globalRoutePolicy.profileReachableFromDestinationIds, ['home', 'cart']);
  assert.deepEqual(pack.design.recipe.cardRecipes.map((recipe) => recipe.id), [
    'FeatureCard', 'ProductCard', 'RecordRow', 'ResumeCard', 'CategoryTile', 'StatusSummary',
  ]);
  assert.deepEqual(pack.builderWaves.map((wave) => wave.id), ['foundations', 'screens-1']);
  assert.deepEqual(pack.builderWaves.find((wave) => wave.id === 'screens-1').targets, pack.screens.map((screen) => screen.id));
  assert.equal(pack.builderWaves.find((wave) => wave.id === 'screens-1').maxConcurrency, pack.screens.length);
  assert.equal(pack.design.recipe.composition.id, 'product-discovery-home');
  assert.deepEqual(pack.design.recipe.composition.requiredCardRecipes, ['FeatureCard', 'ProductCard', 'CategoryTile']);
  assert.equal(pack.screens.find((screen) => screen.id === 'Profile').navigation.role, 'global-utility');
  assert.equal(pack.screens.every((screen) => screen.presentation && screen.layoutBudgets && screen.semanticColorRoles), true);
  assert.deepEqual(validateScreenBuildPack(root, pack), { issues: [], staleTargets: [] });
});