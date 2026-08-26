'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compileScreenBuildPack, parseNavigationModel } = require('../compile-screen-build-pack');
const { deriveExperienceFromBrief, foundationContract, primaryComposition } = require('../experience-patterns');
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
    '### Navigation Pattern',
    '**Tabs + Stack** — Shop, Cart, and Profile remain reachable while product details are nested.',
    '',
    '### Screen Map',
    '| Screen | Route | File | Presentation | Purpose | Data | Native |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| Home | /(app)/home | app/(app)/home.tsx | default | Browse products and categories | Cr_productService, Cr_categoryService | — |',
    '| Product detail | /(app)/products/[id] | app/(app)/products/[id].tsx | default | Inspect one product | Cr_productService.getById | — |',
    '| Cart | /(app)/cart | app/(app)/cart.tsx | default | Review the bag | Cr_cartitemService.getAll | — |',
    '| Profile | /(app)/profile | app/(app)/profile.tsx | default | User context and sign out | useAuth() only | — |',
  ].join('\n'));
  return { root, contract };
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
    assetPolicy: 'remote-allowed',
    dataIntentPath: '.tmp/dataverse-schema-contract.json',
    assetManifest: 'assets/experience/manifest.json',
    viewModel: 'src/generated/experience-view-model.ts',
    recordIdentity: 'stable-primary-key',
    mediaPolicy: 'remote-allowed',
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
      '/(app)/profile': 'root',
    },
  });
  const home = pack.screens.find((screen) => screen.role === 'primary');
  assert.ok(home.firstViewport.includes('ExperienceFeaturedProductMedia'));
  assert.equal(home.primaryAction, 'Browse onboard products');
  assert.deepEqual(home.states, ['loading', 'empty', 'error', 'offline']);
  assert.equal(home.headerMode, 'root');
  assert.deepEqual(home.data, {
    adapter: 'local',
    entities: ['Product', 'Category'],
    viewModel: 'src/generated/experience-view-model.ts',
    recordIdentity: 'stable-primary-key',
    mediaPolicy: 'remote-allowed',
    mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
  });
  assert.ok(home.dependencies.includes('fixture:Product'));
  assert.deepEqual(pack.screens.find((screen) => screen.id === 'ProductsId').data.entities, ['Product']);
  assert.deepEqual(pack.screens.find((screen) => screen.id === 'Cart').data.entities, ['Cart item']);
  assert.equal(pack.screens.find((screen) => screen.id === 'Cart').presentation, 'default');
  assert.equal(pack.screens.find((screen) => screen.id === 'Cart').nativeIntent, null);
  assert.deepEqual(pack.screens.find((screen) => screen.role === 'profile').data.entities, []);
  assert.equal(pack.navigation.keyFlowRoute, '/(app)/products/[id]');
  assert.deepEqual(pack.navigation.keyFlowRoutes, ['/(app)/products/[id]']);
  assert.equal(pack.navigation.model, 'tabs-stack');
  assert.equal(pack.navigation.modelSource, 'approved-screen-plan');
  assert.equal(pack.navigation.profileRoute, '/(app)/profile');
  assert.equal(pack.screens.find((screen) => screen.role === 'profile').headerMode, 'root');
  assert.deepEqual(pack.execution.canary, {
    screenIds: ['Home', 'ProductsId'],
    routes: ['/(app)/home', '/(app)/products/[id]'],
  });
  assert.deepEqual(pack.execution.supportingWaves, [{
    wave: 1,
    screenIds: ['Cart', 'Profile'],
    routes: ['/(app)/cart', '/(app)/profile'],
  }]);
  assert.equal(pack.execution.metroAfterCanary, true);
  assert.deepEqual(validateScreenBuildPack(root, pack), { issues: [], staleTargets: [] });
});

test('multi-step receiving sidecars compile the complete ordered key-flow canary', (context) => {
  const { root } = createProject(context);
  const screenContractPath = path.join(root, '.tmp', 'experience-screen-contract.json');
  const screenContract = JSON.parse(fs.readFileSync(screenContractPath, 'utf8'));
  screenContract.keyFlow = {
    route: '/(app)/receiving/identify',
    file: 'app/(app)/receiving/identify.tsx',
    outcome: 'Receive and inspect an expected shipment.',
    screens: [
      { route: '/(app)/receiving/identify', file: 'app/(app)/receiving/identify.tsx', outcome: 'Identify the expected shipment.' },
      { route: '/(app)/receiving/quantities', file: 'app/(app)/receiving/quantities.tsx', outcome: 'Record received and damaged quantities.' },
      { route: '/(app)/receiving/inspect', file: 'app/(app)/receiving/inspect.tsx', outcome: 'Capture inspection results and damage evidence.' },
      { route: '/(app)/receiving/confirm', file: 'app/(app)/receiving/confirm.tsx', outcome: 'Confirm the receiving record.' },
    ],
  };
  fs.writeFileSync(screenContractPath, `${JSON.stringify(screenContract, null, 2)}\n`);
  fs.appendFileSync(path.join(root, 'native-app-plan.md'), [
    '',
    '| Identify shipment | /(app)/receiving/identify | app/(app)/receiving/identify.tsx | default | Identify shipment by QR or manual code | Cr_productService | barcode-scanner |',
    '| Quantities | /(app)/receiving/quantities | app/(app)/receiving/quantities.tsx | default | Record received and damaged quantities | Cr_productService | — |',
    '| Inspection | /(app)/receiving/inspect | app/(app)/receiving/inspect.tsx | default | Capture inspection results and damage evidence | Cr_productService | camera, location |',
    '| Confirmation | /(app)/receiving/confirm | app/(app)/receiving/confirm.tsx | default | Obtain recipient confirmation | Cr_productService | pen-input |',
  ].join('\n'));
  const pack = compileScreenBuildPack(root);
  assert.deepEqual(pack.navigation.keyFlowRoutes, screenContract.keyFlow.screens.map((screen) => screen.route));
  assert.deepEqual(pack.execution.canary.routes, ['/(app)/home', ...pack.navigation.keyFlowRoutes]);
  assert.deepEqual(pack.execution.canary.screenIds, ['Home', 'ReceivingIdentify', 'ReceivingQuantities', 'ReceivingInspect', 'ReceivingConfirm']);
  assert.deepEqual(pack.screens.filter((screen) => screen.role === 'key-flow').map((screen) => screen.nativeIntent), ['barcode-scanner', null, 'camera, location', 'pen-input']);
  assert.deepEqual(validateScreenBuildPack(root, pack), { issues: [], staleTargets: [] });

  delete screenContract.keyFlow.screens[2].outcome;
  fs.writeFileSync(screenContractPath, `${JSON.stringify(screenContract, null, 2)}\n`);
  assert.throws(() => compileScreenBuildPack(root), /user-facing outcomes/);
});

test('navigation parser supports approved plan variants and a compatibility fallback', () => {
  assert.deepEqual(parseNavigationModel('### Navigation Pattern\n**Stack** — one bounded flow.', 'tabs-stack'), {
    model: 'stack',
    source: 'approved-screen-plan',
  });
  assert.deepEqual(parseNavigationModel('### Navigation Pattern\n**Tabs** — durable peers.', 'stack'), {
    model: 'tabs-stack',
    source: 'approved-screen-plan',
  });
  assert.deepEqual(parseNavigationModel('## Screens\n### Screen Map', 'drawer'), {
    model: 'drawer',
    source: 'experience-contract',
  });
});

test('rejects a build pack whose Screen Map omits Profile', (context) => {
  const { root } = createProject(context);
  const planPath = path.join(root, 'native-app-plan.md');
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('| Profile | /(app)/profile | app/(app)/profile.tsx |', ''));
  assert.throws(() => compileScreenBuildPack(root), /requires a reachable Profile screen/);
});

test('rejects canary drift and incomplete supporting waves', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  pack.execution.canary.screenIds.reverse();
  pack.execution.supportingWaves = [];
  pack.revision = require('../compile-screen-build-pack').revisionForPack(pack);
  const rules = validateScreenBuildPack(root, pack).issues.map((issue) => issue.rule);
  assert.ok(rules.includes('invalid-native-canary'));
  assert.ok(rules.includes('invalid-supporting-waves'));
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

test('approved plan edits invalidate navigation and screen work orders', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  fs.appendFileSync(path.join(root, 'native-app-plan.md'), '\n<!-- approved screen change -->\n');
  const stale = validateScreenBuildPack(root, pack);
  assert.equal(stale.issues.some((issue) => issue.source === 'plan'), true);
  assert.ok(stale.staleTargets.includes('screen:Home'));
  assert.ok(stale.staleTargets.includes('screen:Cart'));
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