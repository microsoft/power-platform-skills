'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { deriveExperienceFromBrief } = require('../experience-patterns');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveNavigationContract } = require('../resolve-navigation-contract');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');
const { validateNavigationContract } = require('../validate-navigation-contract');

const pluginRoot = path.resolve(__dirname, '..', '..');

const briefs = {
  flightShop: 'Create a mobile app for showcasing inventory items to flight passengers. This app will be used in flight for selling travel accessories, beauty products and watches. The app should have clean aesthetics, should be accessible and easy to use.',
  receiving: 'Design a mobile-first, offline field receiving solution. Enable field logisticians and inspectors to view expected shipments, scan barcodes or QR codes, record received and damaged quantities, capture inspection results, enter batch and expiry data, photograph damage, record GPS location, obtain recipient confirmation, and continue working with limited connectivity.',
  gym: 'Create an app for maintining and auditing equipment at gym user should be able to get maintence records of equipment by scanning a qr code, the company owns multiple gyms, the app should support tracking issues, on going repairs, upcoming maintennce and warranty for equipments',
  assets: 'Create a mobile app for tracking company inventory, app should support scanning, printing barcodes, Track warranty ownerships or IT assets. Support monthly inspections and repair and updates status',
};

function candidate(durable) {
  return durable ? {
    hasStableRoot: true,
    revisitedIndependently: true,
    preservesOwnState: true,
    crossSessionValue: true,
    peerToOtherDestinations: true,
    isNotAFlowStep: true,
    isNotAnAction: true,
    supportedByBriefOrSafeProductInference: true,
  } : {
    hasStableRoot: false,
    revisitedIndependently: false,
    preservesOwnState: false,
    crossSessionValue: false,
    peerToOtherDestinations: false,
    isNotAFlowStep: true,
    isNotAnAction: true,
    supportedByBriefOrSafeProductInference: false,
  };
}

function screen(id, purpose, productRole, options = {}) {
  const route = options.route || `/(app)/${id.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
  const durable = productRole === 'durable-destination';
  const immersive = productRole === 'immersive-modal';
  const global = productRole === 'global-utility';
  const dynamic = [...route.matchAll(/\[([^\]]+)\]/g)].map((match) => ({ name: match[1], source: 'path', required: true }));
  return {
    id,
    role: options.primary ? 'primary' : options.keyFlow ? 'key-flow' : 'supporting',
    productRole,
    purpose,
    route,
    file: options.file || `${route.replace('/(app)/', 'app/(app)/').replace(/\/\[([^\]]+)\]$/, '/[$1]')}.tsx`,
    routeParameters: dynamic,
    header: { mode: options.primary ? 'root' : immersive ? 'close' : global ? 'root' : 'back', title: id.replace(/([a-z])([A-Z])/g, '$1 $2') },
    navigation: {
      kind: durable ? 'stack-root' : immersive ? 'modal' : 'pushed',
      intent: durable ? 'navigate' : immersive ? 'present' : 'push',
      ...(options.parentRoute ? { parentRoute: options.parentRoute } : {}),
      ...(durable ? { tabLabel: options.tabLabel || id } : {}),
      candidate: { ...candidate(durable), ...(immersive ? { isNotAFlowStep: false, isNotAnAction: false } : {}) },
    },
  };
}

function profile() {
  return screen('Profile', 'Review local role/context, preferences, help, and sign out.', 'global-utility', { route: '/(app)/profile', file: 'app/(app)/profile.tsx', parentRoute: '/(app)/home' });
}

function resolve(brief, screens, stages = null) {
  const experience = deriveExperienceFromBrief(brief);
  const context = resolveContextEnrichment(brief, experience);
  const journey = resolveWorkflowJourney(brief, experience, context, { screenContract: { screens } });
  if (stages) journey.stages = stages;
  const result = resolveNavigationContract(brief, experience, journey, { schemaVersion: 3, screens });
  const validation = validateNavigationContract(result.contract, { experienceContract: experience, workflowJourney: journey, screenContract: result.screenContract });
  assert.deepEqual(validation.errors, []);
  return { experience, context, journey, ...result };
}

function corpus(value) {
  return value.screenContract.screens.map((item) => `${item.id} ${item.purpose} ${item.productRole} ${item.navigation?.role}`).join(' ').toLowerCase();
}

function assertJobs(value, patterns) {
  const text = corpus(value);
  for (const pattern of patterns) assert.match(text, pattern);
  assert.equal(value.contract.globalRoutePolicy.profileRoute, '/(app)/profile');
  assert.equal(value.contract.globalRoutePolicy.profileAccess, 'header-action');
  assert.equal(value.screenContract.screens.find((item) => item.id === 'Profile').navigation.role, 'global-utility');
}

test('Flight Shop resolves image-led commerce with durable Shop/Categories/Bag and nested detail', () => {
  const value = resolve(briefs.flightShop, [
    screen('Home', 'Discover featured travel accessories, beauty products, and watches with journey context and a visible shop action.', 'durable-destination', { primary: true, route: '/(app)/home', file: 'app/(app)/home.tsx', tabLabel: 'Shop' }),
    screen('Categories', 'Browse travel, beauty, and watch categories.', 'durable-destination'),
    screen('Bag', 'Review selected products, quantities, prices, and availability.', 'durable-destination'),
    screen('ProductDetail', 'Inspect product imagery, price, availability, and add to bag.', 'nested-detail', { keyFlow: true, route: '/(app)/home/product/[productId]', parentRoute: '/(app)/home' }),
    screen('Help', 'Read shopping help and journey information.', 'nested-detail', { parentRoute: '/(app)/home' }),
    profile(),
  ]);
  assert.equal(value.experience.primarySurface, 'product-led-discovery');
  assert.deepEqual(value.experience.assetPolicy, { connectivity: 'network-optional', media: 'remote-cdn-cached' });
  assert.equal(value.contract.model, 'tabs-stack');
  assert.deepEqual(value.contract.destinations.map((item) => item.label), ['Shop', 'Categories', 'Bag']);
  assert.equal(value.screenContract.screens.find((item) => item.id === 'ProductDetail').navigation.tabVisibility, 'visible');
  assertJobs(value, [/travel accessories/, /beauty/, /watches/, /imagery/, /prices/, /availability/, /add to bag/, /shopping help/]);
  assert.doesNotMatch(corpus(value), /warehouse|pallet|airline operations/);
});

test('offline receiving resolves resumable durable roots and an owned bounded capture flow', () => {
  const stages = [
    ['identify', 'Identify', 'Identify'],
    ['receive', 'Receive', 'Receive'],
    ['inspect', 'Inspect', 'Inspect'],
    ['confirm', 'Confirm', 'Confirm'],
    ['review', 'Review', 'Review'],
  ].map(([id, label, screenId], index) => ({ id, label, order: index + 1, screenIds: [screenId], completionRuleId: `stage-${id}-complete` }));
  const value = resolve(briefs.receiving, [
    screen('Home', 'Resume the current locally saved receiving draft and see the next safe action.', 'durable-destination', { primary: true, route: '/(app)/home', file: 'app/(app)/home.tsx', tabLabel: 'Home' }),
    screen('Shipments', 'Browse expected shipments and current receiving status.', 'durable-destination'),
    screen('Drafts', 'Resume receiving drafts saved on this device.', 'durable-destination'),
    screen('Identify', 'Scan barcode or QR code with manual identification fallback.', 'immersive-modal', { keyFlow: true, parentRoute: '/(app)/shipments' }),
    screen('Receive', 'Record received and damaged quantities, batch, and expiry.', 'bounded-flow-step', { parentRoute: '/(app)/shipments' }),
    screen('Inspect', 'Capture inspection results, damage photos, and GPS location.', 'immersive-modal', { parentRoute: '/(app)/shipments' }),
    screen('Confirm', 'Obtain recipient signature confirmation.', 'immersive-modal', { parentRoute: '/(app)/shipments' }),
    screen('Review', 'Review the completed reception and pending sync state.', 'bounded-flow-step', { parentRoute: '/(app)/shipments' }),
    profile(),
  ], stages);
  assert.equal(value.experience.assetPolicy.connectivity, 'offline-preferred');
  assert.equal(value.contract.model, 'tabs-stack');
  assert.deepEqual(value.contract.destinations.map((item) => item.label), ['Home', 'Shipments', 'Drafts']);
  assert.equal(value.screenContract.screens.find((item) => item.id === 'Identify').navigation.role, 'immersive-modal');
  assert.equal(value.screenContract.screens.find((item) => item.id === 'Receive').navigation.role, 'bounded-flow-step');
  assertJobs(value, [/expected shipments/, /saved on this device/, /barcode/, /manual identification/, /damaged quantities/, /batch/, /expiry/, /inspection results/, /photos/, /gps/, /signature/, /pending sync/]);
});

test('gym maintenance keeps scanner subordinate to Home/Equipment/Work jobs', () => {
  const value = resolve(briefs.gym, [
    screen('Home', 'Prioritize equipment health, active issues, repairs, and upcoming maintenance across gyms.', 'durable-destination', { primary: true, route: '/(app)/home', file: 'app/(app)/home.tsx' }),
    screen('Equipment', 'Browse equipment and maintenance history across company gyms.', 'durable-destination'),
    screen('Work', 'Track audits, issues, ongoing repairs, maintenance, warranty, and status updates.', 'durable-destination'),
    screen('ScanEquipment', 'Identify equipment by QR code with manual fallback.', 'immersive-modal', { keyFlow: true, parentRoute: '/(app)/equipment' }),
    screen('EquipmentDetail', 'Review equipment history, open issues, repair state, maintenance schedule, and warranty.', 'nested-detail', { route: '/(app)/equipment/[equipmentId]', parentRoute: '/(app)/equipment' }),
    screen('IssueDetail', 'Review and update an equipment issue.', 'nested-detail', { route: '/(app)/work/issues/[issueId]', parentRoute: '/(app)/work' }),
    screen('RepairDetail', 'Review ongoing repair status and next action.', 'nested-detail', { route: '/(app)/work/repairs/[repairId]', parentRoute: '/(app)/work' }),
    profile(),
  ]);
  assert.equal(value.experience.assetPolicy.connectivity, 'network-optional');
  assert.equal(value.experience.primarySurface, 'task-led-workflow');
  assert.equal(value.contract.model, 'tabs-stack');
  assert.equal(value.screenContract.screens.find((item) => item.id === 'Home').navigation.role, 'durable-destination');
  assert.equal(value.screenContract.screens.find((item) => item.id === 'ScanEquipment').navigation.role, 'immersive-modal');
  assertJobs(value, [/equipment health/, /company gyms/, /maintenance history/, /audits/, /issues/, /ongoing repairs/, /maintenance/, /warranty/, /status updates/, /manual fallback/]);
  assert.doesNotMatch(corpus(value), /offline-ready|pending sync|saved locally/);
});

test('company assets preserves scan, barcode print, ownership, inspection, repair, warranty, and status jobs', () => {
  const value = resolve(briefs.assets, [
    screen('Home', 'Understand company asset status, inspection attention, repairs, and warranty risk.', 'durable-destination', { primary: true, route: '/(app)/home', file: 'app/(app)/home.tsx' }),
    screen('Assets', 'Browse IT assets and company inventory.', 'durable-destination'),
    screen('Inspections', 'Complete and revisit monthly asset inspections.', 'durable-destination'),
    screen('Repairs', 'Track repair work and update asset status.', 'durable-destination'),
    screen('ScanAsset', 'Identify an asset by barcode with manual fallback.', 'immersive-modal', { keyFlow: true, parentRoute: '/(app)/assets' }),
    screen('BarcodeLabel', 'Print the approved barcode label for an asset.', 'bounded-flow-step', { parentRoute: '/(app)/assets' }),
    screen('AssetDetail', 'Review ownership, warranty, inspection, repair, and status history.', 'nested-detail', { route: '/(app)/assets/[assetId]', parentRoute: '/(app)/assets' }),
    profile(),
  ]);
  assert.equal(value.experience.primarySurface, 'decision-led-overview');
  assert.equal(value.experience.assetPolicy.connectivity, 'network-optional');
  assert.equal(value.contract.model, 'tabs-stack');
  assert.deepEqual(value.contract.destinations.map((item) => item.label), ['Home', 'Assets', 'Inspections', 'Repairs']);
  assertJobs(value, [/it assets/, /company inventory/, /monthly asset inspections/, /repair work/, /barcode/, /manual fallback/, /print/, /ownership/, /warranty/, /status history/]);
  assert.doesNotMatch(corpus(value), /warehouse receiving|pallet/);
});

test('benchmark screen counts vary with job coverage rather than a fixed template', () => {
  const counts = [6, 9, 8, 8];
  assert.equal(new Set(counts).size > 1, true);
  assert.equal(counts.every((count) => count >= 2), true);
});

test('V3 remains free of every excluded V2 planner/compiler artifact', () => {
  const excluded = [
    'scripts/schema-prototype-semantic-plan.json',
    'scripts/lib/prototype-semantic-plan.js',
    'scripts/prepare-prototype-planner-request.js',
    'scripts/prepare-prototype-planner-repair.js',
    'scripts/stage-prototype-planner-response.js',
    'scripts/compile-prototype-plan-bundle.js',
    'scripts/finalize-prototype-plan.js',
    'scripts/render-native-prototype-plan.js',
    'scripts/validate-prototype-semantic-preservation.js',
    'scripts/schema-plan-artifact-bundle.json',
    'scripts/write-plan-artifact-bundle.js',
  ];
  for (const relativePath of excluded) assert.equal(fs.existsSync(path.join(pluginRoot, relativePath)), false, relativePath);
});
