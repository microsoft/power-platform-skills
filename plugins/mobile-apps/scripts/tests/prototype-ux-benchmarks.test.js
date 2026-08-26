'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { deriveExperienceFromBrief } = require('../experience-patterns');
const { parseNavigationModel, parseScreenMap } = require('../compile-screen-build-pack');

const pluginRoot = path.resolve(__dirname, '..', '..');

const prompts = {
  passenger: 'Create a mobile app for showcasing inventory items to flight passengers. This app will be used in flight for selling travel accessories, beauty products and watches. The app should have clean aesthetics, should be accessible and easy to use.',
  gym: 'Create an app for maintining and auditing equipment at gym user should be able to get maintence records of equipment by scanning a qr code, the company owns multiple gyms, the app should support tracking issues, on going repairs, upcoming maintennce and warranty for equipments',
  assets: 'Create a mobile app for tracking company inventory, app should support scanning, printing barcodes, Track warranty ownerships or IT assets. Support monthly inspections and repair and updates status',
  receiving: 'Design a mobile-first, offline field receiving solution. Enable field logisticians and inspectors to view expected shipments, scan barcodes or QR codes, record received and damaged quantities, capture inspection results, enter batch and expiry data, photograph damage, record GPS location, obtain recipient confirmation, and continue working with limited connectivity.',
};

function plan(navigation, rows) {
  return [
    '## Screens',
    '### Navigation Pattern',
    `**${navigation}** - approved from durable jobs and bounded flows.`,
    '### Screen Map',
    '| Screen | Route | File | Presentation | Purpose | Data | Native |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function assertCoverage(markdown, expected) {
  const screens = parseScreenMap(markdown);
  const corpus = screens.map((screen) => `${screen.id} ${screen.purpose} ${screen.dataIntent} ${screen.nativeIntent}`).join(' ').toLowerCase();
  assert.equal(parseNavigationModel(markdown, 'other').model, expected.navigation);
  assert.equal(screens.some((screen) => screen.route === '/(app)/profile' && screen.file === 'app/(app)/profile.tsx'), true);
  for (const pattern of expected.jobs) assert.match(corpus, pattern);
  if (expected.scannerSupporting) {
    const home = screens.find((screen) => screen.route === '/(app)/home');
    assert.doesNotMatch(`${home?.purpose} ${home?.nativeIntent}`, /barcode|qr|scanner/i);
    assert.equal(screens.some((screen) => /barcode|qr|scanner/i.test(screen.nativeIntent)), true);
  }
  return screens;
}

test('exact benchmark prompts select distinct evidence-grounded experience contracts', () => {
  const passenger = deriveExperienceFromBrief(prompts.passenger);
  assert.deepEqual([passenger.primarySurface, passenger.entryMode, passenger.assetPolicy.connectivity], ['product-led-discovery', 'discovery', 'network-optional']);
  assert.equal(passenger.contentModel.includes('media'), true);

  const gym = deriveExperienceFromBrief(prompts.gym);
  assert.deepEqual([gym.primarySurface, gym.entryMode, gym.assetPolicy.connectivity], ['decision-led-overview', 'overview', 'network-optional']);
  assert.notEqual(gym.primarySurface, 'capture-led-utility');

  const assets = deriveExperienceFromBrief(prompts.assets);
  assert.deepEqual([assets.primarySurface, assets.entryMode, assets.assetPolicy.connectivity], ['decision-led-overview', 'overview', 'network-optional']);

  const receiving = deriveExperienceFromBrief(prompts.receiving);
  assert.deepEqual([receiving.primarySurface, receiving.entryMode, receiving.assetPolicy.connectivity, receiving.assetPolicy.media], ['task-led-workflow', 'workflow', 'offline-preferred', 'local-first']);
  assert.notEqual(receiving.primarySurface, 'capture-led-utility');
});

test('passenger commerce preserves discovery, media, bag, and Profile in tabs plus nested stacks', () => {
  const screens = assertCoverage(plan('Tabs + Stack', [
    ['Home', '/(app)/home', 'app/(app)/home.tsx', 'default', 'Discover featured travel accessories, beauty products, and watches with editorial media and a visible shop action', 'Product, Category', '-'],
    ['Catalog', '/(app)/catalog', 'app/(app)/catalog/index.tsx', 'default', 'Browse categories and products', 'Product, Category', '-'],
    ['Product detail', '/(app)/catalog/[id]', 'app/(app)/catalog/[id].tsx', 'default', 'Inspect product imagery, price, and availability before adding to bag', 'Product', '-'],
    ['Bag', '/(app)/bag', 'app/(app)/bag.tsx', 'default', 'Review cart quantities and checkout intent', 'Cart item, Product', '-'],
    ['Profile', '/(app)/profile', 'app/(app)/profile.tsx', 'default', 'Review local passenger preferences, help, and sign out', 'useAuth()', '-'],
  ]), { navigation: 'tabs-stack', jobs: [/travel accessories/, /beauty/, /watches/, /imagery/, /bag/, /cart/] });
  assert.equal(screens.length, 5);
  assert.doesNotMatch(screens.map((screen) => screen.purpose).join(' '), /warehouse|airline operations/i);
});

test('gym maintenance keeps QR identification subordinate to its multi-job overview', () => {
  const screens = assertCoverage(plan('Tabs + Stack', [
    ['Home', '/(app)/home', 'app/(app)/home.tsx', 'default', 'Prioritize gym equipment health, active issues, repairs, and upcoming maintenance', 'Gym, Equipment, Issue, Repair, Maintenance', '-'],
    ['Gyms', '/(app)/gyms', 'app/(app)/gyms/index.tsx', 'default', 'Switch among company gyms and their equipment', 'Gym, Equipment', '-'],
    ['Equipment', '/(app)/equipment', 'app/(app)/equipment/index.tsx', 'default', 'Browse equipment and maintenance history', 'Equipment, Maintenance record', '-'],
    ['QR lookup', '/(app)/equipment/scan', 'app/(app)/equipment/scan.tsx', 'modal', 'Identify equipment by QR code with manual fallback', 'Equipment', 'barcode-scanner'],
    ['Issues', '/(app)/issues', 'app/(app)/issues/index.tsx', 'default', 'Track equipment issues and audits', 'Issue, Audit', 'camera'],
    ['Repairs', '/(app)/repairs', 'app/(app)/repairs/index.tsx', 'default', 'Coordinate ongoing repairs and status updates', 'Repair, Equipment', '-'],
    ['Maintenance', '/(app)/maintenance', 'app/(app)/maintenance.tsx', 'default', 'Review upcoming maintenance', 'Maintenance record', '-'],
    ['Warranties', '/(app)/warranties', 'app/(app)/warranties.tsx', 'default', 'Review equipment warranty coverage', 'Warranty, Equipment', '-'],
    ['Profile', '/(app)/profile', 'app/(app)/profile.tsx', 'default', 'Review role, active gym, preferences, help, and sign out', 'useAuth()', '-'],
  ]), { navigation: 'tabs-stack', scannerSupporting: true, jobs: [/gyms/, /equipment/, /maintenance history/, /issues/, /audits/, /ongoing repairs/, /upcoming maintenance/, /warranty/, /status updates/] });
  assert.equal(screens.length, 9);
});

test('company assets preserves scan, barcode print, ownership, inspection, repair, and status jobs', () => {
  const screens = assertCoverage(plan('Tabs + Stack', [
    ['Home', '/(app)/home', 'app/(app)/home.tsx', 'default', 'Understand company asset status, inspections, repairs, and warranty attention', 'Asset, Inspection, Repair, Warranty', '-'],
    ['Assets', '/(app)/assets', 'app/(app)/assets/index.tsx', 'default', 'Browse IT assets and company inventory', 'Asset', '-'],
    ['Scan asset', '/(app)/assets/scan', 'app/(app)/assets/scan.tsx', 'modal', 'Identify an asset by barcode with manual fallback', 'Asset', 'barcode-scanner'],
    ['Print barcode', '/(app)/assets/[id]/barcode', 'app/(app)/assets/[id]/barcode.tsx', 'default', 'Print an approved asset barcode label', 'Asset', 'pdf-report, sharing'],
    ['Ownership', '/(app)/ownership', 'app/(app)/ownership.tsx', 'default', 'Track asset ownership and warranty', 'Asset, Ownership, Warranty', '-'],
    ['Inspections', '/(app)/inspections', 'app/(app)/inspections/index.tsx', 'default', 'Complete monthly inspections', 'Inspection, Asset', 'camera'],
    ['Repairs', '/(app)/repairs', 'app/(app)/repairs/index.tsx', 'default', 'Track repairs and update asset status', 'Repair, Asset', '-'],
    ['Profile', '/(app)/profile', 'app/(app)/profile.tsx', 'default', 'Review role, organization context, preferences, help, and sign out', 'useAuth()', '-'],
  ]), { navigation: 'tabs-stack', scannerSupporting: true, jobs: [/it assets/, /company inventory/, /barcode/, /print/, /ownership/, /warranty/, /monthly inspections/, /repairs/, /update asset status/] });
  assert.equal(screens.length, 8);
});

test('explicit offline receiving keeps a resumable queue and capability-owned transaction steps', () => {
  const screens = assertCoverage(plan('Tabs + Stack', [
    ['Home', '/(app)/home', 'app/(app)/home.tsx', 'default', 'Resume local receiving drafts or open expected shipment queue', 'Shipment, Receiving draft', '-'],
    ['Shipments', '/(app)/shipments', 'app/(app)/shipments/index.tsx', 'default', 'View expected shipments', 'Shipment', '-'],
    ['Identify', '/(app)/receiving/identify', 'app/(app)/receiving/identify.tsx', 'default', 'Scan barcode or QR code with manual fallback', 'Shipment', 'barcode-scanner'],
    ['Quantities', '/(app)/receiving/quantities', 'app/(app)/receiving/quantities.tsx', 'default', 'Record received and damaged quantities plus batch and expiry', 'Receiving line, Batch', '-'],
    ['Inspect', '/(app)/receiving/inspect', 'app/(app)/receiving/inspect.tsx', 'default', 'Capture inspection results, photograph damage, and record GPS location', 'Inspection, Damage evidence', 'camera, location'],
    ['Confirm', '/(app)/receiving/confirm', 'app/(app)/receiving/confirm.tsx', 'default', 'Obtain recipient confirmation and mark pending sync', 'Receiving draft', 'pen-input'],
    ['Profile', '/(app)/profile', 'app/(app)/profile.tsx', 'default', 'Review local role context, preferences, help, and sign out outside the transaction', 'useAuth()', '-'],
  ]), { navigation: 'tabs-stack', scannerSupporting: true, jobs: [/expected shipments/, /barcode/, /qr code/, /received and damaged quantities/, /batch and expiry/, /inspection results/, /photograph damage/, /gps location/, /recipient confirmation/, /pending sync/] });
  assert.equal(screens.length, 7);
});

test('bounded onboarding and a true immersive scanner remain stack-only without a screen-count template', () => {
  const onboarding = assertCoverage(plan('Stack', [
    ['Home', '/(app)/home', 'app/(app)/home.tsx', 'default', 'Preview the value of setup and start onboarding', 'Local setup draft', '-'],
    ['Setup', '/(app)/onboarding/setup', 'app/(app)/onboarding/setup.tsx', 'default', 'Set the required preference', 'Local setup draft', '-'],
    ['Confirm', '/(app)/onboarding/confirm', 'app/(app)/onboarding/confirm.tsx', 'default', 'Review and finish the bounded setup', 'Local setup draft', '-'],
    ['Profile', '/(app)/profile', 'app/(app)/profile.tsx', 'default', 'Review local preferences, help, and sign out', 'useAuth()', '-'],
  ]), { navigation: 'stack', jobs: [/setup/, /preference/, /finish/] });
  const scanner = assertCoverage(plan('Stack', [
    ['Home', '/(app)/home', 'app/(app)/home.tsx', 'default', 'Scan one code as the entire product outcome with manual entry fallback', 'Captured code', 'barcode-scanner'],
    ['Review', '/(app)/review', 'app/(app)/review.tsx', 'default', 'Review and submit the captured code', 'Captured code', '-'],
    ['Profile', '/(app)/profile', 'app/(app)/profile.tsx', 'default', 'Review local preferences, help, and sign out', 'useAuth()', '-'],
  ]), { navigation: 'stack', jobs: [/scan one code/, /manual entry/, /review and submit/] });
  assert.equal(onboarding.length, 4);
  assert.equal(scanner.length, 3);
  assert.match(scanner.find((screen) => screen.route === '/(app)/home').nativeIntent, /barcode-scanner/);
});

test('excluded V2 semantic planner architecture remains absent', () => {
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
  for (const relativePath of excluded) {
    assert.equal(fs.existsSync(path.join(pluginRoot, relativePath)), false, `${relativePath} must remain absent`);
  }
});