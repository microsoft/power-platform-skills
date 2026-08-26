'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  deriveExperienceFromBrief,
  foundationContract,
  primaryComposition,
  validateExperienceContract,
} = require('../experience-patterns');
const { validate } = require('../validate-experience-contract');
const {
  generateSeeds,
} = require('../../skills/create-mobile-prototype/scripts/gen-mock-services');

const briefCases = [
  ['passenger browse-and-buy', 'Help passengers browse optional trip services and buy the choice that fits their journey.', 'discovery'],
  ['operations work completion', 'Give technicians a focused way to complete assigned maintenance tasks and record each finished step.', 'workflow'],
  ['appointment booking', 'Let patients find an available appointment and choose a suitable time slot.', 'discovery'],
  ['personal finance overview', 'Help a person understand balances, recent spending, and the next financial decision.', 'overview'],
  ['learning journey', 'Help learners continue a course, finish the next lesson, and see meaningful progress.', 'workflow'],
  ['capture utility', 'Let a user scan a receipt, capture its details, and submit the result.', 'capture'],
];

const passengerShoppingBrief = [
  'Create a mobile app for showcasing inventory items to flight passengers.',
  'This app will be used in flight for selling travel accessories, beauty products and watches.',
  'The app should have clean aesthetics, should be accessible and easy to use.',
].join('\n');

const gymMaintenanceBrief = 'Create an app for maintining and auditing equipment at gym user should be able to get maintence records of equipment by scanning a qr code, the company owns multiple gyms, the app should support tracking issues, on going repairs, upcoming maintennce and warranty for equipments';
const companyAssetsBrief = 'Create a mobile app for tracking company inventory, app should support scanning, printing barcodes, Track warranty ownerships or IT assets. Support monthly inspections and repair and updates status';
const offlineReceivingBrief = 'Design a mobile-first, offline field receiving solution. Enable field logisticians and inspectors to view expected shipments, scan barcodes or QR codes, record received and damaged quantities, capture inspection results, enter batch and expiry data, photograph damage, record GPS location, obtain recipient confirmation, and continue working with limited connectivity.';

test('brief-only contracts choose entry mode without a visual reference', () => {
  for (const [name, brief, entryMode] of briefCases) {
    const contract = deriveExperienceFromBrief(brief);
    assert.equal(contract.entryMode, entryMode, name);
    assert.deepEqual(validateExperienceContract(contract), [], name);
    assert.equal(contract.referenceOverride, undefined, name);
    assert.equal(contract.forbiddenDefaults.length > 0, true, name);
    if (entryMode === 'discovery' || entryMode === 'capture') {
      assert.equal(contract.forbiddenDefaults.includes('dashboard-first-home'), true, name);
    }
  }
});

test('passenger shopping briefs resolve to network-optional product discovery, not operations', () => {
  const variants = [
    passengerShoppingBrief,
    'Let passengers shop in-flight for travel accessories, beauty products, and watches. Keep the product browse screen clean and accessible.',
    'Build an onboard shop where travelers browse products, compare accessories, and add beauty items or watches to their cart.',
  ];
  for (const brief of variants) {
    const contract = deriveExperienceFromBrief(brief);
    assert.equal(contract.audience, 'consumer');
    assert.equal(contract.primaryJob, 'Browse and add useful products.');
    assert.equal(contract.interactionMode, 'browse');
    assert.equal(contract.entryMode, 'discovery');
    assert.equal(contract.primarySurface, 'product-led-discovery');
    assert.deepEqual(contract.contentModel, ['products', 'categories', 'media', 'cart']);
    assert.deepEqual(contract.assetPolicy, { connectivity: 'network-optional', media: 'remote-allowed' });
    assert.equal(contract.navigationModel, 'stack');
    assert.equal(contract.signatureMotifs.includes('cart-action'), true);
    assert.equal(contract.forbiddenDefaults.includes('warehouse-operations'), true);
    assert.equal(contract.forbiddenDefaults.includes('airline-operations'), true);
    assert.equal(contract.promptEvidence.audience.some((span) => span.signal === 'consumer'), true);
    assert.equal(contract.promptEvidence.primaryJob.some((span) => span.signal === 'commerce'), true);
    assert.equal(contract.promptEvidence.assetPolicy.some((span) => span.signal === 'offline'), false);
    assert.deepEqual(validateExperienceContract(contract), []);
  }
});

test('exact benchmark briefs preserve product structure without scanner-led Home drift', () => {
  const passenger = deriveExperienceFromBrief(passengerShoppingBrief);
  assert.equal(passenger.primarySurface, 'product-led-discovery');
  assert.equal(passenger.firstViewport.primaryAction, 'Browse onboard products');
  assert.deepEqual(passenger.contentModel, ['products', 'categories', 'media', 'cart']);
  assert.deepEqual(passenger.assetPolicy, { connectivity: 'network-optional', media: 'remote-allowed' });

  for (const brief of [gymMaintenanceBrief, companyAssetsBrief]) {
    const contract = deriveExperienceFromBrief(brief);
    assert.equal(contract.primarySurface, 'decision-led-overview', brief);
    assert.equal(contract.entryMode, 'overview', brief);
    assert.notEqual(contract.primarySurface, 'capture-led-utility', brief);
    assert.equal(contract.assetPolicy.connectivity, 'network-optional', brief);
    assert.equal(contract.promptEvidence.assetPolicy.some((span) => span.signal === 'offline'), false, brief);
    assert.deepEqual(validateExperienceContract(contract), [], brief);
  }

  const receiving = deriveExperienceFromBrief(offlineReceivingBrief);
  assert.equal(receiving.audience, 'employee');
  assert.equal(receiving.primarySurface, 'task-led-workflow');
  assert.notEqual(receiving.primarySurface, 'capture-led-utility');
  assert.equal(receiving.assetPolicy.connectivity, 'offline-preferred');
  assert.equal(receiving.assetPolicy.media, 'local-first');
  assert.equal(receiving.contentModel.includes('media'), true);
  assert.deepEqual(validateExperienceContract(receiving), []);
});

test('an explicit CDN-cached media decision overrides the inferred local-first media policy', () => {
  const contract = deriveExperienceFromBrief(passengerShoppingBrief, { mediaPolicy: 'remote-cdn-cached' });
  assert.deepEqual(contract.assetPolicy, { connectivity: 'network-optional', media: 'remote-cdn-cached' });
  assert.equal(contract.assumptions.includes('Use the explicitly selected remote-cdn-cached media policy.'), true);
  assert.deepEqual(validateExperienceContract(contract), []);
  assert.throws(() => deriveExperienceFromBrief(passengerShoppingBrief, { mediaPolicy: 'unapproved-cdn' }), /mediaPolicy must be/);
});

test('offline product behavior requires explicit connectivity evidence', () => {
  for (const brief of [
    'Technicians inspect equipment at multiple sites with a QR scanner.',
    'Warehouse staff receive shipments and photograph damage.',
    'Passengers browse an in-flight product catalog.',
  ]) {
    const contract = deriveExperienceFromBrief(brief);
    assert.equal(contract.assetPolicy.connectivity, 'network-optional', brief);
    assert.equal(contract.promptEvidence.assetPolicy.some((span) => span.signal === 'offline'), false, brief);
  }

  const explicit = deriveExperienceFromBrief('Inspectors receive shipments offline and sync later with limited connectivity.');
  assert.equal(explicit.assetPolicy.connectivity, 'offline-preferred');
  assert.equal(explicit.promptEvidence.assetPolicy.some((span) => span.signal === 'offline'), true);
  assert.deepEqual(validateExperienceContract(explicit), []);
});

test('explicit CDN caching language in a brief selects remote-cdn-cached without changing the shopping journey', () => {
  const contract = deriveExperienceFromBrief(`${passengerShoppingBrief}\nUse CDN images with device caching for this prototype.`);
  assert.equal(contract.entryMode, 'discovery');
  assert.equal(contract.primarySurface, 'product-led-discovery');
  assert.equal(contract.assetPolicy.media, 'remote-cdn-cached');
  assert.equal(contract.promptEvidence.assetPolicy.some((span) => span.signal === 'cachedCdn'), true);
  assert.deepEqual(validateExperienceContract(contract), []);
});

test('semantic corpus selects distinct product journeys from user jobs', () => {
  const corpus = [
    ['consumer discovery', 'Customers browse gift products, compare collections, and add an item to their cart.', 'discovery', 'product-led-discovery'],
    ['employee operations', 'Technicians complete maintenance tasks, record checklist results, and submit the next work order step.', 'workflow', 'task-led-workflow'],
    ['booking', 'Patients find an available appointment and reserve a time slot with their preferred clinician.', 'discovery', 'availability-led-discovery'],
    ['learning', 'Learners continue their course, complete the next lesson, and see their progress.', 'workflow', 'learning-journey'],
    ['finance overview', 'Help a customer understand balances, spending, and the next financial decision.', 'overview', 'decision-led-overview'],
    ['messaging', 'Support agents open customer messages, reply to urgent conversations, and clear their inbox.', 'inbox', 'conversation-led-inbox'],
    ['creator content', 'A creator publishes short videos and articles for followers, then shares new updates.', 'feed', 'content-led-feed'],
    ['healthcare booking', 'Patients choose a follow-up appointment and reserve an available clinic time.', 'discovery', 'availability-led-discovery'],
    ['capture', 'A field user scans a receipt, captures its value, and submits the record.', 'capture', 'capture-led-utility'],
    ['ambiguous', 'Create a useful mobile app for people.', 'onboarding', 'guided-onboarding'],
  ];
  for (const [name, brief, entryMode, primarySurface] of corpus) {
    const contract = deriveExperienceFromBrief(brief);
    assert.equal(contract.entryMode, entryMode, name);
    assert.equal(contract.primarySurface, primarySurface, name);
    assert.deepEqual(validateExperienceContract(contract), [], name);
  }
  const ambiguous = deriveExperienceFromBrief('Create a useful mobile app for people.');
  assert.equal(ambiguous.confidence, 'low');
  assert.equal(ambiguous.assumptions.length, 1);

  const inventoryOnly = deriveExperienceFromBrief('Create a mobile app for inventory items.');
  assert.equal(inventoryOnly.entryMode, 'onboarding');
  assert.equal(inventoryOnly.confidence, 'low');
  assert.notEqual(inventoryOnly.primarySurface, 'product-led-discovery');
  assert.notEqual(inventoryOnly.primarySurface, 'task-led-workflow');
});

test('primary composition exposes deterministic region, action, and motif anchors', () => {
  const contract = deriveExperienceFromBrief('Help learners continue a course and finish the next lesson.');
  const composition = primaryComposition(contract);
  assert.equal(composition.compositionKind, 'workflow');
  assert.equal(composition.runtimeMarkers.includes('experience-primary-action'), true);
  assert.equal(composition.runtimeMarkers.includes('experience-region-context'), true);
  assert.equal(composition.runtimeMarkers.includes('experience-motif-learning-progress'), true);
});

test('signature motifs produce a bounded reusable foundation contract', () => {
  const contract = deriveExperienceFromBrief(passengerShoppingBrief);
  const foundation = foundationContract(contract);
  assert.equal(foundation.primitives.length, 3);
  assert.deepEqual(foundation.primitives.map((primitive) => primitive.motif), [
    'featured-product-media',
    'category-browse',
    'cart-action',
  ]);
  for (const primitive of foundation.primitives) {
    assert.match(primitive.file, /^src\/components\/experience\/Experience.+\.tsx$/);
    assert.match(primitive.testID, /^experience-motif-/);
  }
});

test('foundation manifest CLI writes the contract-selected component plan', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-foundation-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const contract = deriveExperienceFromBrief(passengerShoppingBrief);
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-contract.json'), JSON.stringify(contract));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'plan-experience-foundation.js'),
    '--project-root',
    projectRoot,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const foundation = JSON.parse(fs.readFileSync(path.join(projectRoot, '.tmp', 'experience-foundation-contract.json'), 'utf8'));
  assert.equal(foundation.primitives.length, 3);
  assert.equal(foundation.primitives[0].motif, 'featured-product-media');
});

test('a visual reference is an optional contract override, not a brief prerequisite', () => {
  const contract = deriveExperienceFromBrief(
    'Help learners continue a course and finish the next lesson.',
    { referenceOverride: { fidelity: 'high', preservationIntent: ['preserve navigation silhouette'] } },
  );
  assert.equal(contract.source, 'brief-plus-reference');
  assert.deepEqual(contract.referenceOverride, {
    fidelity: 'high',
    preservationIntent: ['preserve navigation silhouette'],
  });
  assert.deepEqual(validateExperienceContract(contract), []);
});

test('experience validator binds contract, plan, screen sidecar, and built anchors', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-contract-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const contract = deriveExperienceFromBrief('Help learners continue a course and finish the next lesson.');
  const composition = primaryComposition(contract);
  const foundation = foundationContract(contract);
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'app', '(app)'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), [
    '# Learning app',
    '',
    '## Design',
    '',
    '### Product Experience Contract',
    `- Primary job: ${contract.primaryJob}`,
    `- Entry mode: ${contract.entryMode}`,
    `- Primary action: ${contract.firstViewport.primaryAction}`,
    `- Primary surface: ${contract.primarySurface}`,
    `- Asset policy: ${contract.assetPolicy.connectivity} / ${contract.assetPolicy.media}`,
    '- Prompt evidence: verified brief spans',
    '',
    '## Screens',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-screen-contract.json'), `${JSON.stringify({
    schemaVersion: 1,
    experienceContractSha256: crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
    primaryScreen: {
      route: contract.primaryScreen.route,
      file: contract.primaryScreen.file,
      ...composition,
    },
    keyFlow: {
      route: '/(app)/learning/next',
      file: 'app/(app)/learning/next.tsx',
      outcome: 'Continue the next lesson from the primary learning journey.',
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-foundation-contract.json'), `${JSON.stringify(foundation, null, 2)}\n`);
  for (const primitive of foundation.primitives) {
    const primitivePath = path.join(projectRoot, primitive.file);
    fs.mkdirSync(path.dirname(primitivePath), { recursive: true });
    fs.writeFileSync(primitivePath, `export function ${primitive.component}() { return <View testID="${primitive.testID}" />; }`);
  }
  fs.writeFileSync(
    path.join(projectRoot, 'app', '(app)', 'home.tsx'),
    [
      `import { ${foundation.primitives[0].component} } from '@/components/experience/${foundation.primitives[0].component}';`,
      ...composition.runtimeMarkers
        .filter((marker) => !marker.startsWith('experience-motif-'))
        .map((marker) => `<View testID="${marker}" />`),
      `<${foundation.primitives[0].component} />`,
    ].join('\n'),
  );

  assert.deepEqual(validate(projectRoot, 'plan'), []);
  assert.deepEqual(validate(projectRoot, 'build'), []);

  fs.writeFileSync(path.join(projectRoot, 'app', '(app)', 'home.tsx'), '<View testID="experience-primary-action" />');
  const rules = new Set(validate(projectRoot, 'build').map((issue) => issue.rule));
  assert.equal(rules.has('missing-runtime-marker'), true);
});

test('local-first product foundations reject remote media URLs', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-local-media-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const contract = deriveExperienceFromBrief(`${passengerShoppingBrief}\nThe catalog must work offline with no network connection.`);
  const composition = primaryComposition(contract);
  const foundation = foundationContract(contract);
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'app', '(app)'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-contract.json'), JSON.stringify(contract));
  fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), [
    '## Design',
    '### Product Experience Contract',
    `- Primary job: ${contract.primaryJob}`,
    `- Entry mode: ${contract.entryMode}`,
    `- Primary action: ${contract.firstViewport.primaryAction}`,
    `- Primary surface: ${contract.primarySurface}`,
    `- Asset policy: ${contract.assetPolicy.connectivity} / ${contract.assetPolicy.media}`,
    '- Prompt evidence: verified brief spans',
    '## Screens',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-screen-contract.json'), JSON.stringify({
    schemaVersion: 1,
    experienceContractSha256: crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
    primaryScreen: { route: contract.primaryScreen.route, file: contract.primaryScreen.file, ...composition },
    keyFlow: { route: '/(app)/products/[id]', file: 'app/(app)/products/[id].tsx', outcome: 'Inspect a product before adding it to cart.' },
  }));
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-foundation-contract.json'), JSON.stringify(foundation));
  for (const primitive of foundation.primitives) {
    const primitivePath = path.join(projectRoot, primitive.file);
    fs.mkdirSync(path.dirname(primitivePath), { recursive: true });
    const remote = primitive.motif === 'featured-product-media' ? 'https://example.invalid/placeholder.png' : 'asset://experience/local.png';
    fs.writeFileSync(primitivePath, `export function ${primitive.component}() { return <Image source={{ uri: '${remote}' }} testID="${primitive.testID}" />; }`);
  }
  fs.writeFileSync(path.join(projectRoot, 'app', '(app)', 'home.tsx'), [
    `import { ${foundation.primitives[0].component} } from '@/components/experience/${foundation.primitives[0].component}';`,
    ...composition.runtimeMarkers.filter((marker) => !marker.startsWith('experience-motif-')).map((marker) => `<View testID="${marker}" />`),
  ].join('\n'));

  const rules = new Set(validate(projectRoot, 'build').map((issue) => issue.rule));
  assert.ok(rules.has('remote-media-for-local-first-contract'));
});

test('experience-aware prototype seeds override legacy inventory keyword copy', () => {
  const entities = [{
    logicalName: 'demo_item',
    displayName: 'Demo item',
    serviceName: 'Demo_item',
    primaryKey: 'demo_itemid',
    dependencyTier: 0,
    fields: [{ name: 'demo_itemid', type: 'string', primaryName: false }, { name: 'name', type: 'string', primaryName: true }],
  }];
  const contract = deriveExperienceFromBrief('Let travelers browse available products and choose an option.');
  const row = generateSeeds(entities, 'inventory warehouse pallet receiving', contract).get('demo_item')[0];
  assert.match(row.name, /Travel organizer|Hydration essentials kit|Skin care set|Classic travel watch/);
  assert.doesNotMatch(row.name, /Bin A-14|Pallet scan variance/);
});

test('network-optional product fixtures do not promise offline behavior', () => {
  const entities = [{
    logicalName: 'demo_product',
    displayName: 'Product',
    serviceName: 'DemoProduct',
    primaryKey: 'demo_productid',
    dependencyTier: 0,
    fields: [
      { name: 'name', type: 'string', primaryName: true },
      { name: 'notes', type: 'string', primaryName: false },
    ],
  }];
  const contract = deriveExperienceFromBrief(passengerShoppingBrief);
  const rows = generateSeeds(entities, passengerShoppingBrief, contract).get('demo_product');
  assert.equal(rows.some((row) => /offline|saved on device|pending sync/i.test(row.notes)), false);
});

test('shopping and warehouse contracts produce distinct seed content and media policy', () => {
  const entities = [{
    logicalName: 'demo_item',
    displayName: 'Demo item',
    serviceName: 'DemoItem',
    primaryKey: 'demo_itemid',
    dependencyTier: 0,
    fields: [
      { name: 'name', type: 'string', primaryName: true },
      { name: 'image', type: 'image', primaryName: false },
      { name: 'status', type: 'string', primaryName: false },
    ],
  }];
  const shop = deriveExperienceFromBrief(passengerShoppingBrief);
  const warehouse = deriveExperienceFromBrief('Warehouse employees scan bins, complete cycle counts, and submit receiving assignments.');
  const shopRow = generateSeeds(entities, 'inventory warehouse pallet receiving', shop).get('demo_item')[0];
  const warehouseRow = generateSeeds(entities, 'inventory warehouse pallet receiving', warehouse).get('demo_item')[0];

  assert.match(shopRow.name, /Travel organizer|Hydration essentials kit|Skin care set|Classic travel watch/);
  assert.match(shopRow.status, /Available|Featured|Popular|Limited/);
  assert.match(shopRow.image, /^https:\/\/images\.unsplash\.com\//);
  assert.match(warehouseRow.name, /Bin A-14|Receiving Dock 3|Aisle 7|Returns hold/);
  assert.match(warehouseRow.status, /Assigned|Scanning|Needs recount|Complete/);
  assert.notEqual(shopRow.name, warehouseRow.name);
});