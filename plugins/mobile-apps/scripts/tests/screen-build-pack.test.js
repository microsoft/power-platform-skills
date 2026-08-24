'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const { deriveExperienceFromBrief, foundationContract, primaryComposition } = require('../experience-patterns');
const { validateScreenBuildPack } = require('../validate-screen-build-pack');
const { validateScreenComposition } = require('../validate-screen-composition');
const { screenInputFingerprint, validateScreenArtifact } = require('../validate-screen-artifact');
const { validateScreenSourceContract } = require('../lib/screen-source-contract');
const { writeScreenArtifact } = require('../write-screen-artifact');
const { prepareExecutionPreflight } = require('../prepare-mobile-plan-execution-contract');

const passengerBrief = [
  'Create a mobile app for showcasing inventory items to flight passengers.',
  'This app will be used in flight for selling travel accessories, beauty products and watches.',
  'The app should have clean aesthetics, should be accessible and easy to use.',
  'Ui screen only.',
].join('\n');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function screenSpec({ id, route, file, role, purpose, pattern, action, mediaRequired, foundation, entities, routeParameters = [], navigation, headerMode, operations = [] }) {
  const regionId = `${id.toLowerCase()}-content`;
  return {
    id, route, file, role, purpose, routeParameters, navigation,
    presentation: { pattern, density: 'balanced', hierarchy: [purpose, action?.label || 'Supporting information'] },
    regions: [{ id: regionId, kind: 'content', priority: 1, viewport: 'first', mediaRequired }],
    firstViewport: { regionIds: [regionId], focalPoint: purpose, maxRegions: 4 },
    header: { mode: headerMode || (role === 'primary' ? 'root' : 'back'), title: role === 'primary' ? '' : id },
    primaryAction: action,
    media: { required: mediaRequired, role: mediaRequired ? 'content' : 'supporting', aspectRatio: pattern === 'editorial-hero' ? '16:9' : '4:3', minCoverage: mediaRequired ? 0.9 : 0, fallback: mediaRequired ? 'code-native-illustration' : 'text-only' },
    states: ['loading', 'empty', 'error', 'offline'],
    qualityCriteria: ['One obvious focal point is visible.', 'The primary action does not overlap content.', 'Large text does not clip.'],
    testIds: role === 'primary' ? ['experience-primary-action', `experience-region-${regionId}`] : [`screen-${id.toLowerCase()}`],
    dependencies: { foundation, fixtures: entities, screens: [] },
    data: { entities, fixtureScenarios: ['populated', 'loading', 'empty', 'error', 'offline'], operations },
    forbiddenDefaults: role === 'primary' ? ['dashboard-first-home'] : [],
  };
}

function createProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-build-pack-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = deriveExperienceFromBrief(passengerBrief);
  const composition = primaryComposition(contract);
  const foundation = foundationContract(contract);
  const foundationIds = foundation.primitives.map((primitive) => primitive.component);
  const productSelect = ['cr_productid', 'cr_name', 'cr_price', 'cr_currencycode', 'cr_categoryid', 'cr_availability', 'cr_imageurl'];
  const listProducts = (id) => ({
    id, kind: 'list', entity: 'cr_product', service: 'Cr_productService', serviceMethod: 'getAll',
    select: productSelect, filter: [], sort: [{ field: 'cr_name', direction: 'asc' }],
    pagination: { mode: 'cursor', pageSize: 20, cursorParameter: 'skipToken' }, routeBindings: [],
  });
  const screens = [
    screenSpec({ id: 'Home', route: contract.primaryScreen.route, file: contract.primaryScreen.file, role: 'primary', purpose: contract.primaryJob, pattern: 'editorial-hero', action: { id: 'browse-products', label: contract.firstViewport.primaryAction, placement: 'inline', destination: '/(app)/catalog' }, mediaRequired: true, foundation: foundationIds, entities: ['cr_product', 'cr_productmedia', 'cr_category', 'cr_cartitem'], navigation: { kind: 'tab-root', intent: 'navigate', tabLabel: 'Shop' }, operations: [listProducts('list-featured-products')] }),
    screenSpec({ id: 'ProductDetail', route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', role: 'key-flow', purpose: 'Inspect a product before adding it to cart.', pattern: 'detail', action: { id: 'add-to-cart', label: 'Add to bag', placement: 'sticky-bottom', destination: '/(app)/cart' }, mediaRequired: true, foundation: foundationIds, entities: ['cr_product', 'cr_productmedia', 'cr_cartitem'], routeParameters: [{ name: 'id', source: 'path', required: true }], navigation: { kind: 'pushed', intent: 'push', parentRoute: contract.primaryScreen.route }, operations: [
      { id: 'get-product', kind: 'get', entity: 'cr_product', service: 'Cr_productService', serviceMethod: 'getById', select: productSelect, filter: [], sort: [], routeBindings: [{ parameter: 'id', target: 'id', field: 'cr_productid' }], idField: 'cr_productid' },
      { id: 'list-product-media', kind: 'related-list', entity: 'cr_productmedia', service: 'Cr_productmediaService', serviceMethod: 'getAll', select: ['cr_productmediaid', 'cr_productid', 'cr_imageurl'], filter: [{ field: 'cr_productid', operator: 'eq', valueFrom: 'route:id' }], sort: [], pagination: { mode: 'none', boundedReason: 'At most five images per product.', maximumExpectedCount: 5 }, routeBindings: [{ parameter: 'id', target: 'relationship', field: 'cr_productid' }], relationship: { sourceEntity: 'cr_product', targetEntity: 'cr_productmedia', schemaName: 'cr_Product_ProductMedia', sourceField: 'cr_productid', targetField: 'cr_productid', readStrategy: 'chained-fetch', sourceRouteParameter: 'id' } },
      { id: 'create-cart-item', kind: 'create', entity: 'cr_cartitem', service: 'Cr_cartitemService', serviceMethod: 'create', writeFields: ['cr_productid', 'cr_quantity'], routeBindings: [{ parameter: 'id', target: 'input', field: 'cr_productid' }] },
    ] }),
    screenSpec({ id: 'Catalog', route: '/(app)/catalog', file: 'app/(app)/catalog.tsx', role: 'supporting', purpose: 'Browse products by image-led category collections.', pattern: 'image-card-grid', action: null, mediaRequired: true, foundation: foundationIds, entities: ['cr_product', 'cr_category'], routeParameters: [{ name: 'categoryId', source: 'query', required: false }], navigation: { kind: 'tab-root', intent: 'navigate', tabLabel: 'Categories' }, headerMode: 'root', operations: [{ ...listProducts('list-catalog-products'), filter: [{ field: 'cr_categoryid', operator: 'eq', valueFrom: 'route:categoryId' }], routeBindings: [{ parameter: 'categoryId', target: 'filter', field: 'cr_categoryid' }] }] }),
    screenSpec({ id: 'Cart', route: '/(app)/cart', file: 'app/(app)/cart.tsx', role: 'supporting', purpose: 'Review selected products and quantities.', pattern: 'summary', action: { id: 'checkout', label: 'Review order', placement: 'sticky-bottom' }, mediaRequired: false, foundation: foundationIds, entities: ['cr_cartitem', 'cr_product'], navigation: { kind: 'tab-root', intent: 'navigate', tabLabel: 'Bag' }, headerMode: 'root', operations: [{ id: 'list-cart-items', kind: 'list', entity: 'cr_cartitem', service: 'Cr_cartitemService', serviceMethod: 'getAll', select: ['cr_cartitemid', 'cr_productid', 'cr_quantity'], filter: [], sort: [], pagination: { mode: 'none', boundedReason: 'The local cart is capped at twenty-five lines.', maximumExpectedCount: 25 }, routeBindings: [] }] }),
  ];
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'generated', 'services'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brief.md'), passengerBrief);
  const packageJson = { name: 'flight-shop', dependencies: {}, devDependencies: {} };
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-foundation-contract.json'), `${JSON.stringify(foundation, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), `${JSON.stringify({
    schemaVersion: 3,
    experienceContractSha256: hash(JSON.stringify(contract)),
    primaryScreen: { route: contract.primaryScreen.route, file: contract.primaryScreen.file, ...composition },
    keyFlow: { route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', outcome: 'Inspect a product before adding it to cart.' },
    criticalFlow: { screenIds: ['Home', 'ProductDetail'], outcome: 'Discover a product and decide whether to add it to the bag.' },
    screens,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), `${JSON.stringify({
    planningMode: 'prototype',
    tables: [
      { logicalName: 'cr_product', displayName: 'Product', primaryIdAttribute: 'cr_productid', serviceRequired: true, columns: [
        { logicalName: 'cr_productid', type: 'uniqueidentifier' }, { logicalName: 'cr_name', type: 'string', primaryName: true },
        { logicalName: 'cr_price', type: 'money' }, { logicalName: 'cr_currencycode', type: 'string' },
        { logicalName: 'cr_categoryid', type: 'lookup', lookupTarget: 'cr_category' }, { logicalName: 'cr_availability', type: 'string' },
        { logicalName: 'cr_imageurl', type: 'string' },
      ], relationships: [] },
      { logicalName: 'cr_productmedia', displayName: 'Product Media', primaryIdAttribute: 'cr_productmediaid', serviceRequired: true, columns: [
        { logicalName: 'cr_productmediaid', type: 'uniqueidentifier' }, { logicalName: 'cr_productid', type: 'lookup', lookupTarget: 'cr_product' },
        { logicalName: 'cr_imageurl', type: 'string' },
      ], relationships: [{ kind: 'many-to-one', schemaName: 'cr_Product_ProductMedia', plannedDecision: 'create', parentTable: 'cr_product', childTable: 'cr_productmedia', lookup: { logicalName: 'cr_productid' } }] },
      { logicalName: 'cr_category', displayName: 'Category', primaryIdAttribute: 'cr_categoryid', serviceRequired: true, columns: [{ logicalName: 'cr_categoryid', type: 'uniqueidentifier' }, { logicalName: 'cr_name', type: 'string', primaryName: true }], relationships: [] },
      { logicalName: 'cr_cartitem', displayName: 'Cart item', primaryIdAttribute: 'cr_cartitemid', serviceRequired: true, columns: [{ logicalName: 'cr_cartitemid', type: 'uniqueidentifier' }, { logicalName: 'cr_productid', type: 'lookup', lookupTarget: 'cr_product' }, { logicalName: 'cr_quantity', type: 'integer' }], relationships: [] },
    ],
  }, null, 2)}\n`);
  const preflight = prepareExecutionPreflight(passengerBrief, contract, packageJson);
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-contract.json'), `${JSON.stringify({
    schemaVersion: 1,
    experienceContractSha256: hash(JSON.stringify(contract)),
    briefSha256: hash(passengerBrief),
    requirements: preflight.requirements.map((requirement, index) => ({
      id: requirement.id,
      source: requirement.source,
      priority: requirement.priority,
      kind: requirement.kind,
      satisfiedBy: [index === 2 ? 'design' : 'screen:Home'],
      status: 'planned',
    })),
    nativeCapabilities: [],
    javascriptDependencies: [],
    connectorOperations: [],
  }, null, 2)}\n`);
  for (const service of ['Cr_productService', 'Cr_productmediaService', 'Cr_cartitemService']) {
    fs.writeFileSync(path.join(root, 'src', 'generated', 'services', `${service}.ts`), `export const ${service} = { async getAll() {}, async getById() {}, async create() {} };\n`);
  }
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
    entities: ['Product', 'Product Media', 'Category', 'Cart item'],
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
      '/(app)/catalog': 'root',
      '/(app)/cart': 'root',
    },
  });
  const home = pack.screens.find((screen) => screen.role === 'primary');
  assert.deepEqual(home.firstViewport.regionIds, ['home-content']);
  assert.equal(home.firstViewport.visiblePrimaryAction, true);
  assert.equal(home.firstViewport.primaryActionPlacement, 'inline');
  assert.equal(home.media.sizing, 'responsive-clamped');
  assert.equal(home.media.maxViewportShare, 0.55);
  assert.equal(home.presentation.pattern, 'editorial-hero');
  assert.equal(home.primaryAction.label, 'Browse onboard products');
  assert.deepEqual(home.states, ['loading', 'empty', 'error', 'offline']);
  assert.equal(home.headerMode, 'root');
  assert.deepEqual({
    adapter: home.data.adapter,
    entities: home.data.entities,
    fixtureScenarios: home.data.fixtureScenarios,
    viewModel: home.data.viewModel,
    recordIdentity: home.data.recordIdentity,
    mediaPolicy: home.data.mediaPolicy,
    mediaFields: home.data.mediaFields,
  }, {
    adapter: 'local',
    entities: ['cr_product', 'cr_productmedia', 'cr_category', 'cr_cartitem'],
    fixtureScenarios: ['populated', 'loading', 'empty', 'error', 'offline'],
    viewModel: 'src/generated/experience-view-model.ts',
    recordIdentity: 'stable-primary-key',
    mediaPolicy: 'remote-cdn-cached',
    mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
  });
  assert.ok(home.dependencies.artifacts.includes('fixture:cr_product'));
  assert.deepEqual(pack.builderWaves.map((wave) => [wave.id, wave.targets]), [
    ['foundations', ['ExperienceFeaturedProductMedia', 'ExperienceCategoryBrowse', 'ExperienceCartAction']],
    ['vertical-slice', ['Home', 'ProductDetail']],
    ['remaining-screens', ['Catalog', 'Cart']],
  ]);
  assert.deepEqual(pack.buildOrder.find((item) => item.id === 'ProductDetail').dependsOn, ['ExperienceFeaturedProductMedia', 'ExperienceCategoryBrowse', 'ExperienceCartAction']);
  assert.equal(pack.buildOrder.find((item) => item.id === 'Catalog').dependsOn.includes('Home'), false);
  assert.equal(pack.navigation.keyFlowRoute, '/(app)/products/[id]');
  assert.deepEqual(
    pack.screens.filter((screen) => screen.navigation.kind === 'tab-root').map((screen) => screen.navigation.tabLabel),
    ['Shop', 'Categories', 'Bag'],
  );
  assert.deepEqual(pack.screens.find((screen) => screen.id === 'ProductDetail').navigation, {
    kind: 'pushed',
    intent: 'push',
    parentRoute: '/(app)/home',
  });
  assert.deepEqual(validateScreenBuildPack(root, pack), { issues: [], staleTargets: [] });
});

test('source drift changes revision and invalidates only dependent targets', (context) => {
  const { root } = createProject(context);
  const first = compileScreenBuildPack(root);
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), 'export const tokens = { accent: "#123456" } as const;\n');
  const stale = validateScreenBuildPack(root, first);
  assert.equal(stale.issues.some((issue) => issue.source === 'tokens'), true);
  assert.ok(stale.staleTargets.includes('screen:Home'));
  assert.ok(stale.staleTargets.includes('validator:nativeVisual'));
  assert.equal(stale.staleTargets.some((target) => target.startsWith('fixture:')), false);
  const second = compileScreenBuildPack(root);
  assert.notEqual(second.revision, first.revision);
  assert.deepEqual(validateScreenBuildPack(root, second), { issues: [], staleTargets: [] });
});

test('pack compilation blocks an operation whose generated service is missing', (context) => {
  const { root } = createProject(context);
  fs.rmSync(path.join(root, 'src', 'generated', 'services', 'Cr_productService.ts'));
  assert.throws(
    () => compileScreenBuildPack(root),
    /service Cr_productService is absent from the generated service surface/,
  );
});

test('pack validation rejects execution facts or operations changed after compilation', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  pack.execution.requirementIds = [];
  pack.screens.find((screen) => screen.id === 'Home').data.operations = [];
  pack.revision = require('../compile-screen-build-pack').revisionForPack(pack);
  const rules = new Set(validateScreenBuildPack(root, pack).issues.map((issue) => issue.rule));
  assert.ok(rules.has('execution-contract-drift'));
  assert.ok(rules.has('screen-operation-drift'));
});

test('legacy v2 screen contracts require explicit re-planning before build', (context) => {
  const { root } = createProject(context);
  const screenPath = path.join(root, '.tmp', 'experience-screen-contract.json');
  const screenContract = JSON.parse(fs.readFileSync(screenPath, 'utf8'));
  screenContract.schemaVersion = 2;
  fs.writeFileSync(screenPath, `${JSON.stringify(screenContract, null, 2)}\n`);
  assert.throws(() => compileScreenBuildPack(root), /schema-version-3.*Re-plan legacy v1\/v2/i);
});

test('design recipe CLI prefers foreground brand context and preserves per-screen presentation', (context) => {
  const { root } = createProject(context);
  fs.writeFileSync(path.join(root, '.tmp', 'brand-context.json'), JSON.stringify({ palette: { primary: '#102A43' } }));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'resolve-design-recipe.js'), '--project-root', root,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const recipe = JSON.parse(fs.readFileSync(path.join(root, 'brand', 'design-recipe.json'), 'utf8'));
  assert.equal(recipe.paletteStrategy, 'brand-provided');
  assert.equal(recipe.screens.find((screen) => screen.id === 'Catalog').pattern, 'image-card-grid');
  assert.equal(recipe.mediaTreatment.avoidIconOnlyCriticalSurfaces, true);
  assert.deepEqual(validateScreenBuildPack(root, compileScreenBuildPack(root)), { issues: [], staleTargets: [] });
});

test('composition validation rejects generic supporting fallback and incomplete wave coverage', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  pack.screens.find((screen) => screen.id === 'Catalog').presentation.pattern = 'custom';
  pack.builderWaves.find((wave) => wave.id === 'remaining-screens').targets = ['Cart'];
  const rules = new Set(validateScreenComposition(pack).map((issue) => issue.rule));
  assert.ok(rules.has('generic-supporting-fallback'));
  assert.ok(rules.has('wave-screen-coverage'));
});

test('composition validation rejects cyclic builder waves', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  pack.builderWaves.find((wave) => wave.id === 'foundations').dependsOn = ['remaining-screens'];
  const rules = new Set(validateScreenComposition(pack).map((issue) => issue.rule));
  assert.ok(rules.has('wave-cycle'));
});

test('build pack derives executable availability, related-media, and aggregate freshness bindings', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const detail = pack.screens.find((screen) => screen.id === 'ProductDetail');
  assert.deepEqual(detail.data.runtimeBindings.availability, {
    required: true,
    entities: [{ entity: 'cr_product', field: 'cr_availability' }],
    stateProperty: 'availabilityState',
    predicate: 'isExperienceRecordActionable',
    disabledActionId: 'add-to-cart',
  });
  assert.deepEqual(detail.data.runtimeBindings.relatedMedia.relationships, [{
    sourceEntity: 'cr_productmedia',
    sourceField: 'cr_productid',
    targetEntity: 'cr_product',
  }]);
  assert.equal(detail.data.runtimeBindings.relatedMedia.required, true);
  assert.equal(detail.data.runtimeBindings.aggregateFreshness.requiredWhenRendered, true);
  assert.deepEqual(validateScreenBuildPack(root, pack), { issues: [], staleTargets: [] });
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

function screenArtifactFixture(root, pack) {
  const screen = pack.screens.find((candidate) => candidate.id === 'Home');
  const target = path.join(root, screen.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, [
    "import { ScreenShell } from '@/components';",
    '',
    'export default function HomeScreen() {',
    `  // TODO: screen-builder fills JSX here`,
    '  return null;',
    '}',
    '',
  ].join('\n'));
  return {
    target,
    artifact: {
      schemaVersion: 1,
      kind: 'mobile-screen-artifact',
      packRevision: pack.revision,
      screenId: screen.id,
      route: screen.route,
      file: screen.file,
      inputFileSha256: hash(fs.readFileSync(target)),
      source: [
        "import { EntityImage, ScreenShell } from '@/components';",
        "import { isExperienceRecordActionable, resolveExperienceMedia, toExperienceRecord } from '@/generated/experience-view-model';",
        "import { Button, YStack } from 'tamagui';",
        '',
        'export default function HomeScreen() {',
        "  const item = toExperienceRecord('cr_product', { cr_productid: 'product-1', cr_name: 'Travel organizer', cr_availability: 'Available' });",
        "  const mediaRecords = [toExperienceRecord('cr_productmedia', { cr_productmediaid: 'media-1', cr_productid: 'product-1', cr_imageurl: 'asset://experience/product-1.png' })];",
        '  const canBrowse = isExperienceRecordActionable(item);',
        `  return <ScreenShell headerMode="${screen.headerMode}" title=""><YStack testID="experience-region-home-content"><EntityImage media={resolveExperienceMedia(item, mediaRecords)} aspectRatio={16 / 9} maxHeight={320} /><Button testID="experience-primary-action" disabled={!canBrowse}>${screen.primaryAction.label}</Button></YStack></ScreenShell>;`,
        '}',
      ].join('\n'),
      warnings: [],
    },
  };
}

test('return-only screen artifact validates and writes only its pack-authorized target', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  fs.writeFileSync(path.join(root, '.tmp', 'screen-build-pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  const { target, artifact } = screenArtifactFixture(root, pack);
  const packagePath = path.join(root, 'package.json');
  fs.writeFileSync(packagePath, '{"private":true}\n');

  const validation = validateScreenArtifact(root, pack, artifact, 'Home');
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.target, fs.realpathSync(target));
  assert.deepEqual(screenInputFingerprint(root, pack, 'Home'), {
    screenId: 'Home',
    file: 'app/(app)/home.tsx',
    inputFileSha256: artifact.inputFileSha256,
  });
  const result = writeScreenArtifact(root, pack, artifact, 'Home');
  assert.equal(result.screenId, 'Home');
  assert.equal(result.written, 'app/(app)/home.tsx');
  assert.equal(result.sourceSha256, hash(`${artifact.source}\n`));
  assert.equal(fs.readFileSync(target, 'utf8'), `${artifact.source}\n`);
  assert.equal(fs.readFileSync(packagePath, 'utf8'), '{"private":true}\n');
});

test('screen artifact rejects target substitution and unknown write metadata', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const { target, artifact } = screenArtifactFixture(root, pack);
  const before = fs.readFileSync(target, 'utf8');
  artifact.file = 'package.json';
  artifact.targetPath = '../package.json';

  const validation = validateScreenArtifact(root, pack, artifact, 'Home');
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('artifact has unknown keys: targetPath'));
  assert.ok(validation.errors.includes('artifact file does not match pack screen Home'));
  assert.throws(() => writeScreenArtifact(root, pack, artifact, 'Home'), /invalid screen artifact/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('screen artifact refuses to overwrite a skeleton changed after dispatch', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const { target, artifact } = screenArtifactFixture(root, pack);
  fs.appendFileSync(target, '// foreground change\n');
  const before = fs.readFileSync(target, 'utf8');

  const validation = validateScreenArtifact(root, pack, artifact, 'Home');
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('typed screen skeleton changed after builder dispatch: app/(app)/home.tsx'));
  assert.throws(() => writeScreenArtifact(root, pack, artifact, 'Home'), /changed after builder dispatch/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('screen artifact rejects unfinished or fenced source before persistence', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const { artifact } = screenArtifactFixture(root, pack);
  artifact.source = '```tsx\nexport default function HomeScreen() { return null; }\n```';

  const validation = validateScreenArtifact(root, pack, artifact, 'Home');
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('artifact source must contain raw TSX only, without Markdown fences'));
  assert.ok(validation.errors.includes('artifact source must use the shared ScreenShell'));
});

test('screen artifact rejects unplanned service calls and unapproved package imports', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const { artifact } = screenArtifactFixture(root, pack);
  artifact.source = [
    "import { ScreenShell } from '@/components';",
    "import leftPad from 'left-pad';",
    "import { Cr_productService } from '@/generated/services/Cr_productService';",
    'export default function HomeScreen() {',
    '  void leftPad;',
    '  void Cr_productService.delete("id");',
    '  return <ScreenShell headerMode="root" title="" />;',
    '}',
  ].join('\n');

  const errors = validateScreenArtifact(root, pack, artifact, 'Home').errors.join('\n');
  assert.match(errors, /imports unapproved package left-pad/);
  assert.match(errors, /calls Cr_productService.delete without an approved screen operation/);
});

test('screen artifact writer rejects a symlinked pack target', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const { target, artifact } = screenArtifactFixture(root, pack);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-artifact-outside-'));
  context.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const outside = path.join(outsideRoot, 'home.tsx');
  fs.writeFileSync(outside, 'outside must stay unchanged\n');
  fs.rmSync(target);
  fs.symlinkSync(outside, target);

  const validation = validateScreenArtifact(root, pack, artifact, 'Home');
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('typed screen skeleton must be a regular non-symlink file: app/(app)/home.tsx'));
  assert.throws(() => writeScreenArtifact(root, pack, artifact, 'Home'), /regular non-symlink file/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside must stay unchanged\n');
});

test('foreground screen binding prevents one builder from selecting another pack target', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const { target, artifact } = screenArtifactFixture(root, pack);
  const before = fs.readFileSync(target, 'utf8');
  artifact.screenId = 'ProductDetail';
  artifact.route = '/(app)/products/[id]';
  artifact.file = 'app/(app)/products/[id].tsx';

  const validation = validateScreenArtifact(root, pack, artifact, 'Home');
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('artifact screenId does not match the foreground-authorized screen: Home'));
  assert.throws(() => writeScreenArtifact(root, pack, artifact, 'Home'), /foreground-authorized screen/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('screen artifact rejects a sticky-bottom action rendered inline in scroll content', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const screen = pack.screens.find((candidate) => candidate.id === 'ProductDetail');
  const target = path.join(root, screen.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "import { ScreenShell } from '@/components';\nexport default function ProductDetailScreen() { return null; }\n");
  const artifact = {
    schemaVersion: 1,
    kind: 'mobile-screen-artifact',
    packRevision: pack.revision,
    screenId: screen.id,
    route: screen.route,
    file: screen.file,
    inputFileSha256: hash(fs.readFileSync(target)),
    source: [
      "import { ScreenShell } from '@/components';",
      "import { ScrollView } from 'react-native';",
      "import { Button, YStack } from 'tamagui';",
      'export default function ProductDetailScreen() {',
      `  return <ScreenShell headerMode="${screen.headerMode}" title="Product detail"><ScrollView><YStack><EntityImage /></YStack><Button>Add to bag</Button></ScrollView></ScreenShell>;`,
      '}',
    ].join('\n'),
    warnings: [],
  };

  const validation = validateScreenArtifact(root, pack, artifact, screen.id);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('sticky-action-missing-bottom-bar')));
});

test('screen artifact rejects hard-coded currency symbols beside canonical price expressions', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const { artifact } = screenArtifactFixture(root, pack);
  artifact.source = [
    "import { EntityImage, ScreenShell } from '@/components';",
    "import { Text, YStack } from 'tamagui';",
    'export default function HomeScreen() {',
    '  const record = { price: 12 };',
    '  return <ScreenShell headerMode="root" title=""><YStack testID="experience-region-home-content"><EntityImage /><Text>€{record.price.toFixed(2)}</Text></YStack></ScreenShell>;',
    '}',
  ].join('\n');

  const validation = validateScreenArtifact(root, pack, artifact, 'Home');
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('hard-coded-currency-symbol')));
});

test('sticky-bottom source contract requires a non-scrolling shell and a bar outside ScrollView', () => {
  const screen = {
    id: 'Detail', route: '/detail', role: 'key-flow',
    regions: [
      { id: 'media', viewport: 'first', mediaRequired: true },
      { id: 'summary', viewport: 'first', mediaRequired: false },
    ],
    firstViewport: { regionIds: ['media', 'summary'] },
    primaryAction: { id: 'add-item', label: 'Add item', placement: 'sticky-bottom' },
    testIds: ['detail-media', 'detail-primary-action'],
  };
  const insideScroll = [
    '<ScreenShell headerMode="back" scroll={false}>',
    '  <ScrollView>',
    '    <YStack testID="detail-media"><EntityImage aspectRatio={1} /></YStack>',
    '    <BottomActionBar><Button testID="detail-primary-action">Add item</Button></BottomActionBar>',
    '  </ScrollView>',
    '</ScreenShell>',
  ].join('\n');
  assert.ok(validateScreenSourceContract(insideScroll, screen).some((issue) => issue.rule === 'sticky-action-inside-scroll'));

  const valid = [
    '<ScreenShell headerMode="back" scroll={false}>',
    '  <YStack flex={1}>',
    '    <ScrollView><YStack testID="detail-media"><EntityImage aspectRatio={1} /></YStack></ScrollView>',
    '    <BottomActionBar><Button testID="detail-primary-action">Add item</Button></BottomActionBar>',
    '  </YStack>',
    '</ScreenShell>',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, screen), []);
});

test('first-viewport source contract rejects blank minimum-height media surfaces without estimating pixels', () => {
  const screen = {
    id: 'Home', route: '/home', role: 'primary', primaryAction: null,
    regions: [
      { id: 'feature', viewport: 'first', mediaRequired: true },
      { id: 'support', viewport: 'first', mediaRequired: false },
    ],
    firstViewport: { regionIds: ['feature', 'support'] },
    testIds: ['experience-region-feature', 'experience-region-support'],
  };
  const source = [
    '<ScreenShell headerMode="root">',
    '  <YStack testID="experience-region-feature" minH={500}><Icon /></YStack>',
    '  <YStack testID="experience-region-support" />',
    '</ScreenShell>',
  ].join('\n');
  const rules = new Set(validateScreenSourceContract(source, screen).map((issue) => issue.rule));
  assert.ok(rules.has('blank-required-media-region'));
  assert.ok(rules.has('minimum-height-first-viewport-media'));
});

test('first-viewport source contract accepts a custom component with explicit media records', () => {
  const screen = {
    id: 'Home', route: '/home', role: 'primary', primaryAction: null,
    regions: [{ id: 'feature', viewport: 'first', mediaRequired: true }],
    firstViewport: { regionIds: ['feature'] },
    testIds: ['experience-region-feature'],
  };
  const source = [
    '<ScreenShell headerMode="root">',
    '  <YStack testID="experience-region-feature">',
    '    <ExperienceCategoryBrowse mediaRecords={productMedia} />',
    '  </YStack>',
    '</ScreenShell>',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(source, screen), []);
});

test('source contract rejects enabled unavailable actions, dead media joins, and mount-only aggregate badges', () => {
  const screen = {
    id: 'Detail', route: '/detail', role: 'key-flow',
    regions: [{ id: 'detail-content', viewport: 'first', mediaRequired: true }],
    firstViewport: { regionIds: ['detail-content'] },
    primaryAction: { id: 'choose-item', label: 'Choose item', placement: 'inline' },
    testIds: ['detail-content', 'experience-primary-action'],
    data: { runtimeBindings: {
      availability: { required: true, predicate: 'isExperienceRecordActionable', disabledActionId: 'choose-item' },
      relatedMedia: {
        required: true,
        join: 'relatedExperienceRecords',
        relationships: [{ sourceEntity: 'cr_itemmedia', sourceField: 'cr_itemid', targetEntity: 'cr_item' }],
      },
      aggregateFreshness: { requiredWhenRendered: true },
    } },
  };
  const invalid = [
    "const item = toExperienceRecord('cr_item', row);",
    'const cartCount = rows.length;',
    '<ScreenShell headerMode="back">',
    '  <YStack testID="detail-content">',
    '    <EntityImage media={resolveExperienceMedia(item)} />',
    '    <Button testID="experience-primary-action">Choose item</Button>',
    '  </YStack>',
    '</ScreenShell>',
  ].join('\n');
  const rules = new Set(validateScreenSourceContract(invalid, screen).map((issue) => issue.rule));
  assert.ok(rules.has('availability-predicate-missing'));
  assert.ok(rules.has('dead-related-media-entity'));
  assert.ok(rules.has('dead-related-media-relationship'));
  assert.ok(rules.has('aggregate-badge-stale-after-mutation'));

  const valid = [
    "const item = toExperienceRecord('cr_item', row);",
    "const mediaRecords = mediaRows.map((media) => toExperienceRecord('cr_itemmedia', media));",
    'const canChoose = isExperienceRecordActionable(item);',
    'const cartCount = rows.length;',
    'useFocusEffect(useCallback(() => { loadCartItems(); }, [loadCartItems]));',
    '<ScreenShell headerMode="back">',
    '  <YStack testID="detail-content">',
    '    <EntityImage media={resolveExperienceMedia(item, mediaRecords)} />',
    '    <Button testID="experience-primary-action" disabled={!canChoose}>Choose item</Button>',
    '  </YStack>',
    '</ScreenShell>',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, screen), []);
});

test('first-viewport source contract keeps an inline action visible and clamps shared media', () => {
  const screen = {
    id: 'Home', route: '/home', role: 'primary',
    regions: [
      { id: 'feature', viewport: 'first', mediaRequired: true },
      { id: 'action', viewport: 'first', mediaRequired: false },
    ],
    firstViewport: { regionIds: ['feature', 'action'], visiblePrimaryAction: true, primaryActionPlacement: 'inline' },
    primaryAction: { id: 'browse-items', label: 'Browse items', placement: 'inline' },
    media: { sizing: 'responsive-clamped', maxViewportShare: 0.55 },
    testIds: ['experience-region-feature', 'experience-region-action', 'experience-primary-action'],
  };
  const broken = [
    '<ScreenShell headerMode="root">',
    '  <YStack testID="experience-region-feature" height={640}><EntityImage /></YStack>',
    '  <YStack testID="experience-region-action" />',
    '  <Button testID="experience-primary-action">Browse items</Button>',
    '</ScreenShell>',
  ].join('\n');
  const rules = new Set(validateScreenSourceContract(broken, screen).map((issue) => issue.rule));
  assert.ok(rules.has('inline-action-below-first-viewport'));
  assert.ok(rules.has('fixed-first-viewport-media-height'));
  assert.ok(rules.has('missing-responsive-media-aspect'));
  assert.ok(rules.has('missing-media-viewport-clamp'));

  const valid = [
    '<ScreenShell headerMode="root">',
    '  <YStack testID="experience-region-feature">',
    '    <EntityImage aspectRatio={16 / 9} maxHeight={Math.min(windowHeight * 0.55, 360)} />',
    '  </YStack>',
    '  <YStack testID="experience-region-action">',
    '    <Button testID="experience-primary-action">Browse items</Button>',
    '  </YStack>',
    '</ScreenShell>',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, screen), []);
});

test('composition validation rejects contradictory first-viewport metadata before builders run', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const home = pack.screens.find((screen) => screen.id === 'Home');
  home.regions[0].viewport = 'below-fold';
  home.media.required = true;
  const rules = new Set(validateScreenComposition(pack).map((issue) => issue.rule));
  assert.ok(rules.has('first-viewport-region-drift'));
  assert.ok(rules.has('first-viewport-required-media-missing'));
});
