'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const { screenWorkOrder } = require('../compile-screen-build-pack');
const { deriveExperienceFromBrief, foundationContract, primaryComposition } = require('../experience-patterns');
const { validateScreenBuildPack } = require('../validate-screen-build-pack');
const { validateScreenComposition } = require('../validate-screen-composition');
const { screenInputFingerprint, validateScreenArtifact } = require('../validate-screen-artifact');
const { validateScreenSourceContract } = require('../lib/screen-source-contract');
const { writeScreenArtifact } = require('../write-screen-artifact');
const { prepareExecutionPreflight } = require('../prepare-mobile-plan-execution-contract');
const { generateDataLayer } = require('../../skills/create-mobile-prototype/scripts/gen-data-layer');
const { contextEnrichmentRevision, resolveContextEnrichment } = require('../resolve-context-enrichment');
const { domainModelRevision } = require('../lib/prototype-domain-model');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');
const { resolveNavigationContract } = require('../resolve-navigation-contract');
const { applyNavigationShell } = require('../apply-navigation-shell');

const passengerBrief = [
  'Create a mobile app for showcasing inventory items to flight passengers.',
  'This app will be used in flight for selling travel accessories, beauty products and watches.',
  'The app should have clean aesthetics, should be accessible and easy to use.',
  'Ui screen only.',
].join('\n');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function passengerDomainModel(experience, contextContract) {
  return {
    schemaVersion: 1, mode: 'prototype-domain', experienceContractSha256: hash(JSON.stringify(experience)), contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
    entities: [
      { key: 'Category', displayName: 'Category', displayPluralName: 'Categories', description: 'A collection in the onboard shop.', primaryNameField: 'name', estimatedPrototypeRows: 2, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'name', displayName: 'Name', type: 'text', required: true },
      ] },
      { key: 'Product', displayName: 'Product', displayPluralName: 'Products', description: 'A product offered to flight passengers.', primaryNameField: 'name', estimatedPrototypeRows: 2, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'categoryId', displayName: 'Category', type: 'reference', required: true, referenceTarget: 'Category' },
        { key: 'name', displayName: 'Name', type: 'text', required: true },
        { key: 'price', displayName: 'Price', type: 'money', required: true },
        { key: 'availability', displayName: 'Availability', type: 'choice', required: true, choiceKey: 'ProductAvailability' },
        { key: 'inventoryQuantity', displayName: 'Inventory quantity', type: 'whole-number', required: true, minimum: 0 },
        { key: 'media', displayName: 'Product image', type: 'image', required: true, mediaIntent: 'featured' },
      ] },
      { key: 'ProductMedia', displayName: 'Product media', displayPluralName: 'Product media', description: 'An accessible gallery image for an onboard product.', primaryNameField: 'label', estimatedPrototypeRows: 2, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'productId', displayName: 'Product', type: 'reference', required: true, referenceTarget: 'Product' },
        { key: 'label', displayName: 'Label', type: 'text', required: true },
        { key: 'media', displayName: 'Image', type: 'image', required: true, mediaIntent: 'gallery' },
      ] },
      { key: 'Cart', displayName: 'Bag', displayPluralName: 'Bags', description: 'The passenger shopping bag for this prototype session.', primaryNameField: 'label', estimatedPrototypeRows: 1, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'label', displayName: 'Label', type: 'text', required: true },
      ] },
      { key: 'CartItem', displayName: 'Cart item', displayPluralName: 'Cart items', description: 'A product selected for the passenger bag.', primaryNameField: 'label', estimatedPrototypeRows: 1, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'cartId', displayName: 'Bag', type: 'reference', required: true, referenceTarget: 'Cart' },
        { key: 'productId', displayName: 'Product', type: 'reference', required: true, referenceTarget: 'Product' },
        { key: 'label', displayName: 'Label', type: 'text', required: true },
        { key: 'quantity', displayName: 'Quantity', type: 'whole-number', required: true, minimum: 1, maximum: 25 },
      ] },
    ],
    relationships: [
      { key: 'CategoryProducts', parent: 'Category', child: 'Product', cardinality: 'one-to-many', childField: 'categoryId', required: true },
      { key: 'ProductMediaItems', parent: 'Product', child: 'ProductMedia', cardinality: 'one-to-many', childField: 'productId', required: true },
      { key: 'CartItems', parent: 'Cart', child: 'CartItem', cardinality: 'one-to-many', childField: 'cartId', required: true },
      { key: 'ProductCartItems', parent: 'Product', child: 'CartItem', cardinality: 'one-to-many', childField: 'productId', required: true },
    ],
    choices: [{ key: 'ProductAvailability', options: [{ key: 'available', label: 'Available' }, { key: 'sold-out', label: 'Sold out' }] }],
    operations: [
      { key: 'listProducts', entity: 'Product', kind: 'list', repository: 'CatalogRepository', method: 'listProducts', hook: 'useProducts', selectFields: ['id', 'categoryId', 'name', 'price', 'availability', 'inventoryQuantity', 'media'], filterFields: ['categoryId', 'availability'], sortFields: ['name'], pagination: { mode: 'cursor', pageSize: 20 } },
      { key: 'getProduct', entity: 'Product', kind: 'get', repository: 'CatalogRepository', method: 'getProduct', hook: 'useProduct', selectFields: ['id', 'categoryId', 'name', 'price', 'availability', 'inventoryQuantity', 'media'], filterFields: [], sortFields: [], pagination: { mode: 'none' } },
      { key: 'createCartItem', entity: 'CartItem', kind: 'create', repository: 'CartRepository', method: 'createCartItem', hook: 'useCreateCartItem', selectFields: [], filterFields: [], sortFields: [], writeFields: ['cartId', 'productId', 'label', 'quantity'], pagination: { mode: 'none' } },
      { key: 'listCartItems', entity: 'CartItem', kind: 'list', repository: 'CartRepository', method: 'listCartItems', hook: 'useCartItems', selectFields: ['id', 'cartId', 'productId', 'label', 'quantity'], filterFields: [], sortFields: ['label'], pagination: { mode: 'bounded', boundedReason: 'The local bag is capped at twenty-five lines.', maximumExpectedCount: 25 } },
    ],
    actors: [{ key: 'Passenger', displayName: 'Passenger' }],
    uxPermissions: ['listProducts', 'getProduct', 'createCartItem', 'listCartItems'].map((operation) => ({ actor: 'Passenger', operation, allowed: true })),
    offlineUxIntent: { connectivity: 'offline-required', requiredOperations: ['listProducts', 'getProduct', 'createCartItem', 'listCartItems'] },
    fixtureRequirements: [
      { key: 'shop-populated', state: 'populated', description: 'Available and sold-out products are visible.', entity: 'Product', minimumRecords: 2 },
      { key: 'shop-loading', state: 'loading', description: 'The onboard shop is loading.' },
      { key: 'shop-empty', state: 'empty', description: 'No products match the current category.' },
      { key: 'shop-error', state: 'error', description: 'The onboard catalog failed to load.' },
      { key: 'shop-offline', state: 'offline', description: 'Cached onboard products remain available.' },
    ],
    mediaPolicy: { mode: 'remote-cdn-cached', requiredFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'], requiresFallback: true },
    fixtures: {
      Category: [{ id: 'category-travel', name: 'Travel essentials' }, { id: 'category-wellness', name: 'Cabin wellness' }],
      Product: [
        { id: 'product-organizer', categoryId: 'category-travel', name: 'Travel organizer', price: { amount: 42.5, currencyCode: 'USD' }, availability: 'available', inventoryQuantity: 8, media: { imageUrl: 'https://images.unsplash.com/photo-1523779917675-b6ed3a42a561', imageAltText: 'Compact travel organizer', imageCacheKey: 'product-organizer-v1', imageAssetKey: 'asset://experience/product-organizer.png' } },
        { id: 'product-mist', categoryId: 'category-wellness', name: 'Hydration face mist', price: { amount: 18, currencyCode: 'USD' }, availability: 'sold-out', inventoryQuantity: 0, media: { imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883', imageAltText: 'Hydration face mist', imageCacheKey: 'product-mist-v1', imageAssetKey: 'asset://experience/product-mist.png' } },
      ],
      ProductMedia: [
        { id: 'media-organizer-front', productId: 'product-organizer', label: 'Travel organizer front view', media: { imageUrl: 'https://images.unsplash.com/photo-1523779917675-b6ed3a42a561', imageAltText: 'Navy travel organizer with zip compartments', imageCacheKey: 'product-organizer-front-v1', imageAssetKey: 'asset://experience/product-organizer-front.png' } },
        { id: 'media-mist-front', productId: 'product-mist', label: 'Hydration mist bottle', media: { imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883', imageAltText: 'Hydration face mist bottle', imageCacheKey: 'product-mist-front-v1', imageAssetKey: 'asset://experience/product-mist-front.png' } },
      ],
      Cart: [{ id: 'cart-seat-12a', label: 'Seat 12A bag' }],
      CartItem: [{ id: 'cart-organizer', cartId: 'cart-seat-12a', productId: 'product-organizer', label: 'Travel organizer', quantity: 1 }],
    },
    fixtureScenarios: [
      { key: 'shop-populated', state: 'populated', description: 'Available and sold-out products are visible.', entity: 'Product', recordIds: ['product-organizer', 'product-mist'] },
      { key: 'shop-loading', state: 'loading', description: 'The onboard shop is loading.' },
      { key: 'shop-empty', state: 'empty', description: 'No products match the current category.' },
      { key: 'shop-error', state: 'error', description: 'The onboard catalog failed to load.' },
      { key: 'shop-offline', state: 'offline', description: 'Cached onboard products remain available.' },
    ],
  };
}

function screenSpec({ id, route, file, role, purpose, pattern, action, mediaRequired, foundation, entities, routeParameters = [], navigation, headerMode, operations = [], visualComposition = null, contextEntries = [] }) {
  const regionId = `${id.toLowerCase()}-content`;
  return {
    id, route, file, role, purpose, routeParameters, navigation,
    presentation: { pattern, density: 'balanced', hierarchy: [purpose, action?.label || 'Supporting information'] },
    regions: [{ id: regionId, kind: 'content', priority: 1, viewport: 'first', mediaRequired }],
    firstViewport: { regionIds: [regionId], focalPoint: purpose, maxRegions: 4, nextContentVisible: visualComposition?.nextContentVisible ?? true, maxFeatureViewportShare: visualComposition?.maxFeatureViewportShare ?? (mediaRequired ? 0.38 : 0) },
    context: { entryIds: contextEntries.map((entry) => entry.id), placementIntent: contextEntries.length ? 'primary-screen-context-rail' : 'none', assumptions: [...new Set(contextEntries.map((entry) => entry.assumption))] },
    signatureComponent: visualComposition ? { ...visualComposition.signatureComponent } : { kind: 'supporting-screen', required: false, testId: null },
    header: { mode: headerMode || (role === 'primary' ? 'root' : 'back'), title: role === 'primary' ? '' : id },
    primaryAction: action?.placement === 'sticky-bottom'
      ? { ...action, clearance: { safeArea: true, tabBar: 'above' } }
      : action,
    media: { required: mediaRequired, role: mediaRequired ? 'content' : 'supporting', aspectRatio: pattern === 'editorial-hero' ? '16:9' : '4:3', minCoverage: mediaRequired ? 0.9 : 0, fallback: mediaRequired ? 'code-native-illustration' : 'text-only', prominence: mediaRequired ? visualComposition?.mediaProminence || 'medium' : 'none' },
    states: ['loading', 'empty', 'error', 'offline'],
    qualityCriteria: ['One obvious focal point is visible.', 'The primary action does not overlap content.', 'Large text does not clip.'],
    testIds: role === 'primary' ? ['experience-primary-action', `experience-region-${regionId}`, visualComposition.signatureComponent.testId] : [`screen-${id.toLowerCase()}`],
    dependencies: { foundation, fixtures: entities, screens: [] },
    data: { entities, fixtureScenarios: ['populated', 'loading', 'empty', 'error', 'offline'], operations },
    forbiddenDefaults: role === 'primary' ? ['dashboard-first-home'] : [],
  };
}

function createProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-build-pack-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = deriveExperienceFromBrief(passengerBrief);
  const contextContract = resolveContextEnrichment(passengerBrief, contract);
  const composition = primaryComposition(contract);
  const foundation = foundationContract(contract);
  const foundationIds = foundation.primitives.map((primitive) => primitive.component);
  const productSelect = ['id', 'categoryId', 'name', 'price', 'availability', 'inventoryQuantity', 'media'];
  const listProducts = (id) => ({
    id, kind: 'list', entity: 'Product', domainOperation: 'listProducts', repository: 'CatalogRepository', repositoryMethod: 'listProducts', hook: 'useProducts',
    select: productSelect, filter: [], sort: [{ field: 'name', direction: 'asc' }],
    pagination: { mode: 'cursor', pageSize: 20, cursorParameter: 'skipToken' }, routeBindings: [],
  });
  const screens = [
    screenSpec({ id: 'Home', route: contract.primaryScreen.route, file: contract.primaryScreen.file, role: 'primary', purpose: contract.primaryJob, pattern: 'editorial-hero', action: { id: 'browse-products', label: contract.firstViewport.primaryAction, placement: 'inline', destination: '/(app)/catalog' }, mediaRequired: true, foundation: foundationIds, entities: ['Product', 'ProductMedia', 'Category', 'CartItem'], navigation: { kind: 'tab-root', intent: 'navigate', tabLabel: 'Shop' }, operations: [listProducts('list-featured-products')], visualComposition: contract.visualCompositionIntent, contextEntries: contextContract.displayContext }),
    screenSpec({ id: 'ProductDetail', route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', role: 'key-flow', purpose: 'Inspect a product before adding it to cart.', pattern: 'detail', action: { id: 'add-to-cart', label: 'Add to bag', placement: 'sticky-bottom', destination: '/(app)/cart' }, mediaRequired: true, foundation: foundationIds, entities: ['Product', 'ProductMedia', 'CartItem'], routeParameters: [{ name: 'id', source: 'path', required: true }], navigation: { kind: 'pushed', intent: 'push', parentRoute: contract.primaryScreen.route }, operations: [
      { id: 'get-product', kind: 'get', entity: 'Product', domainOperation: 'getProduct', repository: 'CatalogRepository', repositoryMethod: 'getProduct', hook: 'useProduct', select: productSelect, filter: [], sort: [], routeBindings: [{ parameter: 'id', target: 'id', field: 'id' }], idField: 'id' },
      { id: 'create-cart-item', kind: 'create', entity: 'CartItem', domainOperation: 'createCartItem', repository: 'CartRepository', repositoryMethod: 'createCartItem', hook: 'useCreateCartItem', writeFields: ['cartId', 'productId', 'label', 'quantity'], routeBindings: [{ parameter: 'id', target: 'input', field: 'productId' }] },
    ] }),
    screenSpec({ id: 'Catalog', route: '/(app)/catalog', file: 'app/(app)/catalog.tsx', role: 'supporting', purpose: 'Browse products by image-led category collections.', pattern: 'image-card-grid', action: null, mediaRequired: true, foundation: foundationIds, entities: ['Product', 'Category'], routeParameters: [{ name: 'categoryId', source: 'query', required: false }], navigation: { kind: 'tab-root', intent: 'navigate', tabLabel: 'Categories' }, headerMode: 'root', operations: [{ ...listProducts('list-catalog-products'), filter: [{ field: 'categoryId', operator: 'eq', valueFrom: 'route:categoryId' }], routeBindings: [{ parameter: 'categoryId', target: 'filter', field: 'categoryId' }] }] }),
    screenSpec({ id: 'Cart', route: '/(app)/cart', file: 'app/(app)/cart.tsx', role: 'supporting', purpose: 'Review selected products and quantities.', pattern: 'summary', action: { id: 'checkout', label: 'Review order', placement: 'sticky-bottom' }, mediaRequired: false, foundation: foundationIds, entities: ['Cart', 'CartItem', 'Product'], navigation: { kind: 'tab-root', intent: 'navigate', tabLabel: 'Bag' }, headerMode: 'root', operations: [{ id: 'list-cart-items', kind: 'list', entity: 'CartItem', domainOperation: 'listCartItems', repository: 'CartRepository', repositoryMethod: 'listCartItems', hook: 'useCartItems', select: ['id', 'cartId', 'productId', 'label', 'quantity'], filter: [], sort: [{ field: 'label', direction: 'asc' }], pagination: { mode: 'bounded', boundedReason: 'The local cart is capped at twenty-five lines.', maximumExpectedCount: 25 }, routeBindings: [] }] }),
  ];
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brief.md'), passengerBrief);
  const packageJson = { name: 'flight-shop', dependencies: { 'expo-router': '55.0.14', '@expo/vector-icons': '15.1.1' }, devDependencies: {} };
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', '(app)', '_layout.tsx'), `import { Redirect } from 'expo-router';\nimport { Stack } from 'expo-router/stack';\nimport { useAuth } from '@microsoft/power-apps-native-host';\nexport default function AppLayout() {\n  const { isSignedIn, isLoading } = useAuth();\n  if (!isLoading && !isSignedIn) return <Redirect href="/login" />;\n  return (<Stack screenOptions={{ headerShown: false }} />);\n}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-foundation-contract.json'), `${JSON.stringify(foundation, null, 2)}\n`);
  for (const primitive of foundation.primitives) {
    const primitivePath = path.join(root, primitive.file);
    fs.mkdirSync(path.dirname(primitivePath), { recursive: true });
    fs.writeFileSync(primitivePath, `export function ${primitive.component}() { return null; }\n`);
  }
  const screenContract = {
    schemaVersion: 3,
    experienceContractSha256: hash(JSON.stringify(contract)),
    primaryScreen: { route: contract.primaryScreen.route, file: contract.primaryScreen.file, ...composition },
    keyFlow: { route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', outcome: 'Inspect a product before adding it to cart.' },
    criticalFlow: { screenIds: ['Home', 'ProductDetail'], outcome: 'Discover a product and decide whether to add it to the bag.' },
    screens,
  };
  fs.writeFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), `${JSON.stringify(contextContract, null, 2)}\n`);
  const domain = passengerDomainModel(contract, contextContract);
  const workflowJourney = resolveWorkflowJourney(passengerBrief, contract, contextContract, { screenContract, domainModel: domain });
  const navigation = resolveNavigationContract(passengerBrief, contract, workflowJourney, screenContract);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-screen-contract.json'), `${JSON.stringify(navigation.screenContract, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'workflow-journey-contract.json'), `${JSON.stringify(workflowJourney, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'navigation-contract.json'), `${JSON.stringify(navigation.contract, null, 2)}\n`);
  applyNavigationShell(root, navigation.contract, navigation.screenContract);
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), `${JSON.stringify(domain, null, 2)}\n`);
  generateDataLayer(root, domain, contract, { screens }, null, contextContract);
  const preflight = prepareExecutionPreflight(passengerBrief, contract, packageJson);
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'mobile-plan-execution-contract.json'), `${JSON.stringify({
    schemaVersion: 1,
    experienceContractSha256: hash(JSON.stringify(contract)),
    contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
    domainModelSha256: domainModelRevision(domain),
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
  assert.equal(pack.journey.journeyKind, 'discovery-with-nested-flow');
  assert.equal(pack.navigation.model, 'tabs-stack');
  assert.deepEqual(pack.navigation.destinations.map((destination) => destination.label), ['Shop', 'Categories', 'Bag']);
  assert.equal(pack.journey.signatureComponents.some((component) => component.kind === 'workflow-stepper'), false);
  assert.match(pack.uiContractFingerprint, /^[a-f0-9]{64}$/);
  const { journeyScenarios, ...fixtureIntent } = pack.fixtures;
  assert.deepEqual(fixtureIntent, {
    adapter: 'mock-repository',
    entities: ['Category', 'Product', 'ProductMedia', 'Cart', 'CartItem'],
    assetPolicy: 'remote-cdn-cached',
    domainModelPath: '.tmp/prototype-domain-model.json',
    assetManifest: 'assets/experience/manifest.json',
    dataModule: 'src/data/index.ts',
    mediaAdapter: 'src/data/media.ts',
    recordIdentity: 'stable-primary-key',
    mediaPolicy: 'remote-cdn-cached',
    mediaManifest: 'assets/experience/manifest.json',
    mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
  });
  assert.equal(journeyScenarios.length, 1);
  assert.equal(journeyScenarios[0].currentStageId, 'discover');
  assert.equal(journeyScenarios[0].requiredStageCount, 1);
  assert.equal(journeyScenarios[0].continuityValues.primaryRecordId, journeyScenarios[0].primaryRecordId);
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
  assert.equal(home.actionState.primaryActionId, 'browse-products');
  assert.equal(home.journey.stageId, 'discover');
  assert.equal(home.semanticColorRoles.length, 6);
  assert.deepEqual(home.layoutBudgets.requiredFirstViewportRegions, home.firstViewport.regionIds);
  assert.deepEqual(home.context.entries.map((entry) => [entry.id, entry.sampleValue, entry.source]), [
    ['flight-number', 'AI 184', 'inferred-prototype-fixture'],
    ['seat-number', '12A', 'inferred-prototype-fixture'],
    ['connectivity', 'Catalog available offline', 'inferred-prototype-fixture'],
    ['fulfilment-mode', 'Delivery to your seat', 'inferred-prototype-fixture'],
  ]);
  assert.equal(pack.context.forbiddenInferences.some((value) => /live airline integration/i.test(value)), true);
  assert.equal(pack.fixtures.entities.includes('JourneyContext'), false);
  const generatedContext = fs.readFileSync(path.join(root, 'src', 'data', 'context.ts'), 'utf8');
  for (const value of ['AI 184', '12A', 'Catalog available offline', 'Delivery to your seat']) assert.match(generatedContext, new RegExp(value));
  assert.deepEqual(home.states, ['loading', 'empty', 'error', 'offline']);
  assert.equal(home.headerMode, 'root');
  assert.deepEqual({
    adapter: home.data.adapter,
    entities: home.data.entities,
    fixtureScenarios: home.data.fixtureScenarios,
    sourceModule: home.data.sourceModule,
    domainModel: home.data.domainModel,
    hooks: home.data.hooks,
    recordIdentity: home.data.recordIdentity,
    mediaPolicy: home.data.mediaPolicy,
    mediaFields: home.data.mediaFields,
  }, {
    adapter: 'mock-repository',
    entities: ['Product', 'ProductMedia', 'Category', 'CartItem'],
    fixtureScenarios: ['populated', 'loading', 'empty', 'error', 'offline'],
    sourceModule: '@/data',
    domainModel: '.tmp/prototype-domain-model.json',
    hooks: ['useProducts'],
    recordIdentity: 'stable-primary-key',
    mediaPolicy: 'remote-cdn-cached',
    mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
  });
  assert.ok(home.dependencies.artifacts.includes('fixture:Product'));
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
    destinationId: 'home',
    role: 'nested-detail',
    presentation: 'nested-stack',
    tabVisibility: 'visible',
    backTarget: 'nearest-stack',
    completionTarget: 'home',
    cancelTarget: 'home',
    deepLinkable: true,
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
  assert.ok(stale.staleTargets.includes('validator:staticComposition'));
  assert.equal(stale.staleTargets.some((target) => target.startsWith('fixture:')), false);
  const second = compileScreenBuildPack(root);
  assert.notEqual(second.revision, first.revision);
  assert.deepEqual(validateScreenBuildPack(root, second), { issues: [], staleTargets: [] });
});

test('confirmed brief drift invalidates screens, fixtures, and contract validators', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  fs.appendFileSync(path.join(root, 'brief.md'), '\nAdd an unsupported live payment requirement.\n');
  const stale = validateScreenBuildPack(root, pack);
  assert.equal(stale.issues.some((issue) => issue.source === 'confirmedBrief'), true);
  assert.ok(stale.staleTargets.includes('screen:Home'));
  assert.ok(stale.staleTargets.includes('fixture:Product'));
  assert.ok(stale.staleTargets.includes('validator:experience'));
  assert.ok(stale.staleTargets.includes('validator:staticComposition'));
});

test('generated domain, foundation, and package drift invalidate the bound pack', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  fs.appendFileSync(path.join(root, 'src', 'data', 'hooks', 'useProducts.ts'), '\n// changed after compilation\n');
  fs.appendFileSync(path.join(root, pack.sourcePaths.foundationRuntime[0]), '\n// changed after compilation\n');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  packageJson.description = 'Changed after compilation';
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  const stale = validateScreenBuildPack(root, pack);
  for (const source of ['domainLayer', 'foundationRuntime', 'packageManifest']) {
    assert.equal(stale.issues.some((issue) => issue.source === source), true, source);
  }
  assert.ok(stale.staleTargets.includes('screen:Home'));
  assert.ok(stale.staleTargets.includes('fixture:Product'));
  assert.ok(stale.staleTargets.includes('validator:staticComposition'));
});

test('pack compilation blocks an operation whose approved domain hook is missing', (context) => {
  const { root } = createProject(context);
  fs.rmSync(path.join(root, 'src', 'data', 'hooks', 'useProducts.ts'));
  assert.throws(
    () => compileScreenBuildPack(root),
    /Domain hook useProducts is missing from src\/data\/hooks/,
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
    entities: [{ entity: 'Product', field: 'availability' }],
    stateProperty: 'availabilityState',
    predicate: 'isDomainRecordActionable',
    disabledActionId: 'add-to-cart',
  });
  assert.deepEqual(detail.data.runtimeBindings.relatedMedia.relationships, [{
    sourceEntity: 'ProductMedia',
    sourceField: 'productId',
    targetEntity: 'Product',
  }]);
  assert.equal(detail.data.runtimeBindings.relatedMedia.required, true);
  assert.equal(detail.data.runtimeBindings.aggregateFreshness.requiredWhenRendered, true);
  assert.deepEqual(validateScreenBuildPack(root, pack), { issues: [], staleTargets: [] });
});

test('compiler CLI emits one pack and supports immutable in-memory work-order extraction', (context) => {
  const { root } = createProject(context);
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'compile-screen-build-pack.js'), '--project-root', root,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const pack = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'screen-build-pack.json'), 'utf8'));
  const workOrder = screenWorkOrder(pack, 'Home');
  assert.equal(workOrder.packRevision, pack.revision);
  assert.equal(workOrder.target.file, 'app/(app)/home.tsx');
  assert.deepEqual(workOrder.screen.data.hooks, ['useProducts']);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'screen-tasks')), false);
});

function screenArtifactFixture(root, pack) {
  const screen = pack.screens.find((candidate) => candidate.id === 'Home');
  const contextRows = screen.context.entries.map((entry) => `<YStack testID="${entry.testId}">{PROTOTYPE_CONTEXT.entries['${entry.id}'].value}</YStack>`).join('');
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
        "import { isDomainRecordActionable, PROTOTYPE_CONTEXT, resolveDomainMedia, useProducts } from '@/data';",
        "import { Button, YStack } from 'tamagui';",
        '',
        'export default function HomeScreen() {',
        '  // operation:list-featured-products',
        '  const products = useProducts();',
        '  const item = products.data?.[0];',
        '  const canBrowse = isDomainRecordActionable(item || {});',
        `  return <ScreenShell headerMode="${screen.headerMode}" title=""><YStack testID="experience-region-home-content">${contextRows}{item ? <EntityImage media={resolveDomainMedia(item.media)} aspectRatio={16 / 9} maxHeight={320} /> : null}<Button testID="experience-primary-action" disabled={!canBrowse}>${screen.primaryAction.label}</Button></YStack></ScreenShell>;`,
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
  const packageBefore = fs.readFileSync(packagePath, 'utf8');

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
  assert.equal(fs.readFileSync(packagePath, 'utf8'), packageBefore);
});

test('screen artifact rejects an omitted or disconnected enriched context entry', (context) => {
  const { root } = createProject(context);
  const pack = compileScreenBuildPack(root);
  const { artifact } = screenArtifactFixture(root, pack);
  artifact.source = artifact.source.replace('testID="experience-context-flight-number"', 'testID="missing-flight-context"');
  artifact.source = artifact.source.replace("PROTOTYPE_CONTEXT.entries['seat-number'].value", 'unknownSeat');
  const errors = validateScreenArtifact(root, pack, artifact, 'Home').errors.join('\n');
  assert.match(errors, /context-entry-not-rendered.*experience-context-flight-number/);
  assert.match(errors, /context-value-not-bound.*experience-context-seat-number/);
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
  assert.match(errors, /calls generated service Cr_productService.delete; screens must use approved @\/data hooks/);
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
    primaryAction: { id: 'add-item', label: 'Add item', placement: 'sticky-bottom', clearance: { safeArea: true, tabBar: 'above' } },
    testIds: ['detail-media', 'detail-primary-action'],
  };
  const insideScroll = [
    '<ScreenShell headerMode="back" scroll={false}>',
    '  <ScrollView>',
    '    <YStack testID="detail-media"><EntityImage aspectRatio={1} /></YStack>',
    '    <BottomActionBar safeArea tabBarClearance="above"><Button testID="detail-primary-action">Add item</Button></BottomActionBar>',
    '  </ScrollView>',
    '</ScreenShell>',
  ].join('\n');
  assert.ok(validateScreenSourceContract(insideScroll, screen).some((issue) => issue.rule === 'sticky-action-inside-scroll'));

  const valid = [
    '<ScreenShell headerMode="back" scroll={false}>',
    '  <YStack flex={1}>',
    '    <ScrollView><YStack testID="detail-media"><EntityImage aspectRatio={1} /></YStack></ScrollView>',
    '    <BottomActionBar safeArea tabBarClearance="above"><Button testID="detail-primary-action">Add item</Button></BottomActionBar>',
    '  </YStack>',
    '</ScreenShell>',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, screen), []);

  const missingClearance = valid.replace(' safeArea tabBarClearance="above"', '');
  const clearanceRules = new Set(validateScreenSourceContract(missingClearance, screen).map((issue) => issue.rule));
  assert.ok(clearanceRules.has('sticky-action-safe-area-clearance'));
  assert.ok(clearanceRules.has('sticky-action-tab-bar-clearance'));
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
      availability: { required: true, predicate: 'isDomainRecordActionable', disabledActionId: 'choose-item' },
      relatedMedia: {
        required: true,
        resolver: 'resolveDomainMedia',
        join: 'repository-relationship',
        relationships: [{ sourceEntity: 'ItemMedia', sourceField: 'itemId', targetEntity: 'Item' }],
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
  assert.ok(rules.has('legacy-presentation-adapter'));
  assert.ok(rules.has('dead-related-media-relationship'));
  assert.ok(rules.has('aggregate-badge-stale-after-mutation'));

  const valid = [
    'const item = row;',
    'const canChoose = isDomainRecordActionable(item);',
    'const cartCount = rows.length;',
    'useFocusEffect(useCallback(() => { loadCartItems(); }, [loadCartItems]));',
    '<ScreenShell headerMode="back">',
    '  <YStack testID="detail-content">',
    '    <EntityImage media={resolveDomainMedia(item.media)} />',
    '    <Button testID="experience-primary-action" disabled={!canChoose}>Choose item</Button>',
    '  </YStack>',
    '</ScreenShell>',
  ].join('\n');
  assert.deepEqual(validateScreenSourceContract(valid, screen), []);
});

test('static source rules reject replacement records, architecture leaks, unsafe typing, and starter styling', () => {
  const screen = { id: 'Home', route: '/home', data: { entities: ['Product'] } };
  const source = [
    'const products = [{ id: "cr3e9_product_one" }];',
    'const cartCount = 3;',
    'const isAvailable = true;',
    'const client = new QueryClient();',
    'const selected = products[0] as any;',
    '<Text fontSize={31} color="#3366ff">{selected.id}</Text>',
    '<TextInput />',
    '<Pressable height={40} disabled={true}><Icon /></Pressable>',
  ].join('\n');
  const rules = new Set(validateScreenSourceContract(source, screen).map((issue) => issue.rule));
  for (const rule of [
    'screen-local-record-array', 'provisional-dataverse-identifier', 'hard-coded-aggregate',
    'hard-coded-availability', 'duplicate-query-client', 'unsafe-type-escape',
    'raw-starter-color', 'arbitrary-typography', 'keyboard-avoidance-missing',
    'custom-control-role-missing', 'custom-control-label-missing', 'custom-control-state-missing', 'undersized-touch-target',
  ]) assert.ok(rules.has(rule), rule);
});

test('touch target validation honors a stricter design-recipe minimum', () => {
  const source = '<Button height={44}>Continue</Button>';
  assert.equal(validateScreenSourceContract(source, { id: 'Form' }).some((issue) => issue.rule === 'undersized-touch-target'), false);
  assert.equal(validateScreenSourceContract(source, { id: 'Form' }, { minimumControlSize: 48 }).some((issue) => issue.rule === 'undersized-touch-target'), true);
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

test('Screen v3 rejects sticky actions without clearance and independent stack roots inside tabs', (context) => {
  const { root } = createProject(context);
  const contractPath = path.join(root, '.tmp', 'experience-screen-contract.json');
  const screenContract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const detail = screenContract.screens.find((screen) => screen.id === 'ProductDetail');
  delete detail.primaryAction.clearance;
  fs.writeFileSync(contractPath, `${JSON.stringify(screenContract, null, 2)}\n`);
  assert.throws(() => compileScreenBuildPack(root), /sticky-bottom action requires safe-area clearance/);

  detail.primaryAction.clearance = { safeArea: true, tabBar: 'above' };
  detail.navigation = { kind: 'stack-root', intent: 'navigate' };
  fs.writeFileSync(contractPath, `${JSON.stringify(screenContract, null, 2)}\n`);
  assert.throws(() => compileScreenBuildPack(root), /cannot declare an independent stack root/);
});
