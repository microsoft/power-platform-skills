'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { APPROVED_CDN_MEDIA, inspectExperienceImage } = require('../lib/experience-media');
const { buildExperienceAssetManifest } = require('../lib/experience-view-model');

const script = path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-prototype', 'scripts', 'gen-mock-services.js');
const {
  buildFixtureScenarioManifest,
  generateSeeds,
} = require(script);

function makeProject(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-prototype-mocks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

function run(projectRoot) {
  return spawnSync(process.execPath, [script, projectRoot], { encoding: 'utf8' });
}

test('generates deterministic table mocks, relationships, choices, and connector stubs from the schema contract', (t) => {
  const root = makeProject(t, {
    'brief.md': 'A field inspection app for warehouse technicians.',
    'native-app-plan.md': `
## Data Model

Approved in the structured schema contract.

## Connectors

| Connector | API name | Why needed | Skill |
|---|---|---|---|
| SharePoint Online | \`sharepointonline\` | Store evidence documents | \`/add-sharepoint\` |

## Screens
`,
    '.tmp/dataverse-schema-contract.json': JSON.stringify({
      schemaVersion: 1,
      tables: [
        {
          logicalName: 'cr_site',
          displayName: 'Site',
          plannedDecision: 'create',
          dependencyTier: 0,
          serviceRequired: true,
          columns: [
            { logicalName: 'cr_name', displayName: 'Site Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
          ],
        },
        {
          logicalName: 'cr_inspection',
          displayName: 'Inspection',
          plannedDecision: 'create',
          dependencyTier: 1,
          serviceRequired: true,
          columns: [
            { logicalName: 'cr_name', displayName: 'Inspection Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_siteid', displayName: 'Site', type: 'lookup', lookupTarget: 'cr_site', requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_status', displayName: 'Status', type: 'choice', options: [{ value: 100000000, label: 'Draft' }, { value: 100000001, label: 'Complete' }] },
          ],
        },
      ],
    }),
  });

  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /generated 2 table service\(s\) and 1 connector stub/);

  const sites = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_site.seed.json'), 'utf8'));
  const inspectionsPath = path.join(root, 'src/generated/services/Cr_inspection.seed.json');
  const inspections = JSON.parse(fs.readFileSync(inspectionsPath, 'utf8'));
  assert.equal(sites.length, 8);
  assert.equal(inspections.length, 8);
  assert.equal(inspections[0].cr_siteid, sites[0].cr_siteid);
  assert.deepEqual(new Set(inspections.map((row) => row.cr_status)), new Set([100000000, 100000001]));

  const service = fs.readFileSync(path.join(root, 'src/generated/services/Cr_inspectionService.ts'), 'utf8');
  assert.match(service, /async getAll/);
  assert.match(service, /maxPageSize\?: number/);
  assert.match(service, /skipToken\?: string/);
  assert.match(service, /filter\?: string/);
  assert.match(service, /orderBy\?: string \| string\[\]/);
  assert.match(service, /return \{ data, \.\.\./);
  assert.match(service, /async get\(id: string\)/);
  assert.match(service, /async getById/);
  assert.match(service, /async create/);
  assert.match(service, /async update/);
  assert.match(service, /async delete/);
  assert.match(service, /const currentRows = load\(\)/);
  assert.match(service, /currentRows\[index\] =/);
  assert.match(service, /Reflect\.get\(left, field\)/);
  assert.doesNotMatch(service, /Record<string, unknown>/);

  const connector = fs.readFileSync(path.join(root, 'src/generated/services/SharePointOnlineService.ts'), 'utf8');
  assert.match(connector, /Run \/prototype-to-real-app to provision it/);
  assert.match(fs.readFileSync(path.join(root, 'src/generated/services/index.ts'), 'utf8'), /export \* from '\.\/dataSourcesInfo'/);
  assert.match(fs.readFileSync(path.join(root, 'src/generated/index.ts'), 'utf8'), /export \* from '\.\/services'/);

  const firstSeed = fs.readFileSync(inspectionsPath, 'utf8');
  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(inspectionsPath, 'utf8'), firstSeed);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/.prototype-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.tables, ['cr_site', 'cr_inspection']);
  assert.deepEqual(manifest.connectors, ['sharepointonline']);
});

test('generates only approved typed connector methods from the execution contract', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': '## Data Model\n\nStructured contract.\n\n## Connectors\n\nStructured execution contract.\n',
    '.tmp/dataverse-schema-contract.json': JSON.stringify({
      schemaVersion: 1,
      tables: [{
        logicalName: 'cr_item', displayName: 'Item', plannedDecision: 'create', serviceRequired: true,
        columns: [{ logicalName: 'cr_name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' }],
      }],
    }),
    '.tmp/mobile-plan-execution-contract.json': JSON.stringify({
      connectorOperations: [{
        id: 'connector-weather-current', connector: 'Weather', apiName: 'weather', service: 'WeatherService', operation: 'GetCurrentWeather',
      }],
    }),
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const stub = fs.readFileSync(path.join(root, 'src/generated/services/WeatherService.ts'), 'utf8');
  assert.match(stub, /async GetCurrentWeather\(\.\.\._args: unknown\[\]\): Promise<never>/);
  assert.doesNotMatch(stub, /new Proxy/);
  assert.match(stub, /Run \/prototype-to-real-app to provision it/);
});

test('supports the legacy Markdown entity blocks from the test branch', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
## Data Model

**Task** (\`cr_task\`) - prototype task
- \`cr_name\` (String)
- \`cr_dueon\` (DateTime, nullable)

## Connectors

_None - this app uses local data only._
`,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /legacy fallback/);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/services/Cr_taskService.ts')), true);
});

test('materializes bundled product media and preserves a product identity through cart data', (t) => {
  const root = makeProject(t, {
    'brief.md': 'Help passengers browse products and add them to a cart while traveling.',
    'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n\n## Connectors\n\n_None._\n',
    '.tmp/experience-contract.json': JSON.stringify({
      schemaVersion: 1,
      audience: 'consumer',
      primaryJob: 'Browse and add useful products.',
      interactionMode: 'browse',
      entryMode: 'discovery',
      primarySurface: 'product-led-discovery',
      contentModel: ['products', 'categories', 'media', 'cart'],
      assetPolicy: { connectivity: 'offline-preferred', media: 'local-first' },
      promptEvidence: {},
    }),
    '.tmp/dataverse-schema-contract.json': JSON.stringify({
      schemaVersion: 1,
      planningMode: 'prototype',
      tables: [
        {
          logicalName: 'cr_product',
          displayName: 'Product',
          plannedDecision: 'create',
          serviceRequired: true,
          columns: [
            { logicalName: 'cr_name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_price', type: 'money' },
            { logicalName: 'cr_category', type: 'string' },
            { logicalName: 'cr_availability', type: 'string' },
            { logicalName: 'cr_image', type: 'image' },
          ],
        },
        {
          logicalName: 'cr_cartitem',
          displayName: 'Cart item',
          plannedDecision: 'create',
          serviceRequired: true,
          dependencyTier: 1,
          columns: [
            { logicalName: 'cr_cartitemid', type: 'uniqueidentifier' },
            { logicalName: 'cr_productid', type: 'lookup', lookupTarget: 'cr_product', requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_quantity', type: 'integer' },
          ],
        },
      ],
    }),
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const products = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_product.seed.json'), 'utf8'));
  const cartItems = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_cartitem.seed.json'), 'utf8'));
  const assets = JSON.parse(fs.readFileSync(path.join(root, 'assets/experience/manifest.json'), 'utf8'));
  const viewModel = fs.readFileSync(path.join(root, 'src/generated/experience-view-model.ts'), 'utf8');
  const selectedProduct = products[0];
  const cartItem = cartItems.find((item) => item.cr_productid === selectedProduct.cr_productid);

  assert.ok(cartItem, 'a cart row must preserve the selected product primary key');
  assert.match(selectedProduct.cr_image, /^asset:\/\/experience\/cr_product-1\.png$/);
  const asset = assets.assets[selectedProduct.cr_image];
  assert.equal(asset.key, selectedProduct.cr_image);
  assert.equal(asset.kind, 'bundled-raster');
  assert.equal(asset.family, 'product');
  assert.equal(asset.label, selectedProduct.cr_name);
  assert.equal(asset.category, selectedProduct.cr_category);
  assert.equal(asset.materialized, true);
  const mediaPath = path.join(root, asset.localPath);
  assert.equal(fs.existsSync(mediaPath), true);
  assert.deepEqual(inspectExperienceImage(mediaPath), {
    mimeType: 'image/png',
    width: 960,
    height: 720,
    byteLength: asset.byteLength,
    decodable: true,
  });
  assert.match(viewModel, /export function toExperienceRecord/);
  assert.match(viewModel, /assetKeys/);
  assert.match(viewModel, /EXPERIENCE_ASSET_SOURCES/);
  assert.match(viewModel, /require\("\.\.\/\.\.\/assets\/experience\/cr_product-1\.png"\)/);
  assert.match(viewModel, /stable record ID mapping/);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/.prototype-manifest.json'), 'utf8'));
  assert.equal(manifest.assetManifest, 'assets/experience/manifest.json');
  assert.equal(manifest.viewModel, 'src/generated/experience-view-model.ts');
});

test('generates approved CDN media fields with stable cache and fallback identities', (t) => {
  const root = makeProject(t, {
    'brief.md': 'Help passengers browse products and add them to a cart while traveling.',
    'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n\n## Connectors\n\n_None._\n',
    '.tmp/experience-contract.json': JSON.stringify({
      schemaVersion: 1,
      audience: 'consumer',
      primaryJob: 'Browse and add useful products.',
      interactionMode: 'browse',
      entryMode: 'discovery',
      primarySurface: 'product-led-discovery',
      contentModel: ['products', 'categories', 'media', 'cart'],
      assetPolicy: { connectivity: 'offline-preferred', media: 'remote-cdn-cached' },
      promptEvidence: {},
    }),
    '.tmp/dataverse-schema-contract.json': JSON.stringify({
      schemaVersion: 1,
      planningMode: 'prototype',
      tables: [{
        logicalName: 'cr_product',
        displayName: 'Product',
        plannedDecision: 'create',
        serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
          { logicalName: 'cr_price', type: 'money' },
          { logicalName: 'cr_category', type: 'string' },
          { logicalName: 'cr_availability', type: 'string' },
          { logicalName: 'cr_imageurl', type: 'string' },
          { logicalName: 'cr_imagealttext', type: 'string' },
          { logicalName: 'cr_imagecachekey', type: 'string' },
          { logicalName: 'cr_imageassetkey', type: 'string' },
        ],
      }],
    }),
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const [product] = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_product.seed.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/experience/manifest.json'), 'utf8'));
  const viewModel = fs.readFileSync(path.join(root, 'src/generated/experience-view-model.ts'), 'utf8');
  const media = manifest.media.records[`cr_product:${product.cr_productid}`];

  assert.match(product.cr_imageurl, /^https:\/\/images\.unsplash\.com\//);
  assert.ok(product.cr_imagealttext.startsWith(product.cr_name));
  assert.equal(product.cr_imagecachekey, 'experience:cr_product:1:v1');
  assert.equal(product.cr_imageassetkey, 'asset://experience/cr_product-1.png');
  assert.equal(media.imageUrl, product.cr_imageurl);
  assert.equal(media.imageAltText, product.cr_imagealttext);
  assert.equal(media.imageCacheKey, product.cr_imagecachekey);
  assert.equal(media.imageAssetKey, product.cr_imageassetkey);
  assert.equal(media.delivery, 'remote-cached-with-bundled-fallback');
  assert.equal(media.imageLocalPath, 'assets/experience/cr_product-1.png');
  assert.equal(media.imageWidth, 960);
  assert.equal(media.imageHeight, 720);
  assert.equal(inspectExperienceImage(path.join(root, media.imageLocalPath)).decodable, true);
  assert.equal(manifest.assetPolicy, 'remote-cdn-cached');
  assert.match(viewModel, /imageUrl: string \| null/);
  assert.match(viewModel, /imageAltText: string/);
  assert.match(viewModel, /imageCacheKey: string/);
  assert.match(viewModel, /imageAssetKey: string/);
  assert.match(viewModel, /httpsImageSource\((?:record|mediaRecord)\.imageUrl\)/);
  assert.match(viewModel, /imageSource: remoteSource \|\| fallbackSource/);
  assert.match(viewModel, /fallbackSource,/);
});

test('uses schema relationships and build-pack scenarios without sample-specific fixture contamination', () => {
  const fields = (values) => values.map((field) => ({
    displayName: field.name,
    required: true,
    options: [],
    primaryName: false,
    fixtureValues: [],
    fixtureValue: undefined,
    ...field,
  }));
  const entities = [
    {
      logicalName: 'zz_taxonomy', displayName: 'Collection', serviceName: 'Zz_taxonomy', primaryKey: 'zz_taxonomyid', dependencyTier: 0, fixtureRowCount: null,
      fields: fields([
        { name: 'zz_name', type: 'string', primaryName: true },
        { name: 'zz_slug', type: 'string' },
      ]),
    },
    {
      logicalName: 'zz_offer', displayName: 'Offer', serviceName: 'Zz_offer', primaryKey: 'zz_offerid', dependencyTier: 1, fixtureRowCount: null,
      fields: fields([
        { name: 'zz_name', type: 'string', primaryName: true },
        { name: 'zz_taxonomyid', displayName: 'Category', type: 'lookup', lookupTarget: 'zz_taxonomy' },
        { name: 'zz_sku', type: 'string' },
        { name: 'zz_currencycode', type: 'string' },
        { name: 'zz_availability', type: 'string' },
        { name: 'zz_imageurl', type: 'string' },
        { name: 'zz_imagealttext', type: 'string' },
        { name: 'zz_imagecachekey', type: 'string' },
        { name: 'zz_imageassetkey', type: 'string' },
      ]),
    },
    {
      logicalName: 'zz_offer_media', displayName: 'Offer Media', serviceName: 'Zz_offer_media', primaryKey: 'zz_offer_mediaid', dependencyTier: 2, fixtureRowCount: null,
      fields: fields([
        { name: 'zz_name', type: 'string', primaryName: true },
        { name: 'zz_offerid', displayName: 'Offer', type: 'lookup', lookupTarget: 'zz_offer' },
        { name: 'zz_imageurl', type: 'string' },
        { name: 'zz_imagealttext', type: 'string' },
        { name: 'zz_imagecachekey', type: 'string' },
        { name: 'zz_imageassetkey', type: 'string' },
      ]),
    },
    {
      logicalName: 'zz_selection', displayName: 'Selection', serviceName: 'Zz_selection', primaryKey: 'zz_selectionid', dependencyTier: 0, fixtureRowCount: null,
      fields: fields([{ name: 'zz_name', type: 'string', primaryName: true }]),
    },
  ];
  const experienceContract = {
    audience: 'consumer',
    primaryJob: 'Browse and choose products.',
    interactionMode: 'browse',
    entryMode: 'discovery',
    primarySurface: 'product-led-discovery',
    contentModel: ['products', 'categories', 'media', 'cart'],
    assetPolicy: { connectivity: 'network-optional', media: 'remote-cdn-cached' },
    mediaIntent: { criticality: 'required' },
    promptEvidence: {
      contentModel: [
        { signal: 'category', text: 'books' },
        { signal: 'category', text: 'magazines' },
        { signal: 'category', text: 'stationery' },
      ],
    },
  };
  const screenBuildPack = {
    revision: 'fixture-revision',
    fixtures: {
      defaults: { currencyCode: 'CAD' },
      rowCounts: { Offer: 5 },
    },
    screens: [{
      id: 'browse',
      states: ['loading', 'empty', 'error', 'offline'],
      data: {
        fixtureScenarios: [
          'The singleton selection preserves a stable identity.',
          'One category contains an unavailable item.',
          'One item uses the media fallback.',
        ],
      },
    }],
  };

  const rows = generateSeeds(entities, '', experienceContract, screenBuildPack);
  const taxonomies = rows.get('zz_taxonomy');
  const offers = rows.get('zz_offer');
  const offerMedia = rows.get('zz_offer_media');
  const selections = rows.get('zz_selection');
  const taxonomyNamesById = new Map(taxonomies.map((row) => [row.zz_taxonomyid, row.zz_name]));

  assert.deepEqual(taxonomies.map((row) => row.zz_name), ['Books', 'Magazines', 'Stationery']);
  assert.equal(offers.length, 5);
  assert.equal(selections.length, 1);
  for (let index = 0; index < offers.length; index += 1) {
    const offer = offers[index];
    const expectedCategory = taxonomies[index % taxonomies.length].zz_name;
    assert.equal(taxonomyNamesById.get(offer.zz_taxonomyid), expectedCategory);
    assert.match(offer.zz_imagealttext, new RegExp(`${expectedCategory}$`));
    assert.match(offer.zz_imageurl, /^https:\/\/images\.unsplash\.com\//);
    assert.match(offer.zz_imagecachekey, /^experience:zz_offer:/);
    assert.match(offer.zz_imageassetkey, /^asset:\/\/experience\/zz_offer-/);
  }
  for (let index = 0; index < offerMedia.length; index += 1) {
    const media = offerMedia[index];
    const offer = offers[index % offers.length];
    const category = taxonomyNamesById.get(offer.zz_taxonomyid);
    assert.equal(media.zz_offerid, offer.zz_offerid);
    assert.match(media.zz_imagealttext, new RegExp(`${category}$`));
  }
  assert.equal(offers[0].zz_sku, 'OFFER-001');
  assert.equal(offers[0].zz_currencycode, 'CAD');
  assert.equal(offers.some((row) => row.zz_availability === 'Unavailable'), true);

  const serialized = JSON.stringify([...rows.values()].flat());
  assert.doesNotMatch(serialized, /Onboard cart|onboard-cart|\bEUR\b|FS-\d|Travel organizer|Featured for this journey/i);

  const assetManifest = buildExperienceAssetManifest(entities, rows, experienceContract);
  const scenarios = buildFixtureScenarioManifest(screenBuildPack, entities, rows, assetManifest);
  const scenariosById = new Map(scenarios.scenarios.map((scenario) => [scenario.id, scenario]));
  assert.deepEqual(scenariosById.get('empty').recordsByEntity.zz_offer, []);
  assert.equal(Object.keys(scenariosById.get('unavailable').recordOverrides).length, 1);
  const fallback = Object.values(scenariosById.get('media-fallback').recordOverrides)[0];
  assert.equal(fallback.imageUrl, null);
  assert.match(fallback.imageAssetKey, /^asset:\/\/experience\//);
  assert.equal(fallback.sourcePriority, 'local');
});

test('selects media families from planner fixture names and related categories', () => {
  const fields = (values) => values.map((field) => ({
    displayName: field.name,
    required: true,
    options: [],
    primaryName: false,
    fixtureValues: [],
    fixtureValue: undefined,
    ...field,
  }));
  const entities = [
    {
      logicalName: 'zz_category', displayName: 'Category', serviceName: 'Zz_category', primaryKey: 'zz_categoryid', dependencyTier: 0, fixtureRowCount: 3,
      fields: fields([{ name: 'zz_name', type: 'string', primaryName: true, fixtureValues: ['Travel accessories', 'Beauty products', 'Watches'] }]),
    },
    {
      logicalName: 'zz_product', displayName: 'Product', serviceName: 'Zz_product', primaryKey: 'zz_productid', dependencyTier: 1, fixtureRowCount: 3,
      fields: fields([
        { name: 'zz_name', type: 'string', primaryName: true, fixtureValues: ['Passport organizer', 'Hydration face serum', 'Classic travel watch'] },
        { name: 'zz_categoryid', displayName: 'Category', type: 'lookup', lookupTarget: 'zz_category' },
        { name: 'zz_imageurl', type: 'string' },
        { name: 'zz_imagealttext', type: 'string' },
        { name: 'zz_imagecachekey', type: 'string' },
        { name: 'zz_imageassetkey', type: 'string' },
      ]),
    },
    {
      logicalName: 'zz_productmedia', displayName: 'Product media', serviceName: 'Zz_productmedia', primaryKey: 'zz_productmediaid', dependencyTier: 2, fixtureRowCount: 3,
      fields: fields([
        { name: 'zz_name', type: 'string', primaryName: true, fixtureValues: ['Organizer hero', 'Serum hero', 'Watch hero'] },
        { name: 'zz_productid', displayName: 'Product', type: 'lookup', lookupTarget: 'zz_product' },
        { name: 'zz_imageurl', type: 'string' },
        { name: 'zz_imagealttext', type: 'string' },
        { name: 'zz_imagecachekey', type: 'string' },
        { name: 'zz_imageassetkey', type: 'string' },
      ]),
    },
  ];
  const experienceContract = {
    audience: 'consumer', primaryJob: 'Browse a curated catalog.', interactionMode: 'browse', entryMode: 'discovery',
    primarySurface: 'product-led-discovery', contentModel: ['products', 'categories', 'media'],
    assetPolicy: { connectivity: 'network-optional', media: 'remote-cdn-cached' },
    mediaIntent: { criticality: 'required' }, promptEvidence: {},
  };
  const rows = generateSeeds(entities, '', experienceContract, null);
  const products = rows.get('zz_product');
  const media = rows.get('zz_productmedia');

  assert.ok(APPROVED_CDN_MEDIA.travel.includes(products[0].zz_imageurl));
  assert.ok(APPROVED_CDN_MEDIA.beauty.includes(products[1].zz_imageurl));
  assert.ok(APPROVED_CDN_MEDIA.watch.includes(products[2].zz_imageurl));
  assert.equal(new Set(products.map((row) => row.zz_imageurl)).size, 3);
  assert.ok(APPROVED_CDN_MEDIA.travel.includes(media[0].zz_imageurl));
  assert.ok(APPROVED_CDN_MEDIA.beauty.includes(media[1].zz_imageurl));
  assert.ok(APPROVED_CDN_MEDIA.watch.includes(media[2].zz_imageurl));
  assert.match(media[1].zz_imagealttext, /Hydration face serum in Beauty products/);

  const manifest = buildExperienceAssetManifest(entities, rows, experienceContract);
  assert.deepEqual(
    products.map((row) => manifest.assets[row.zz_imageassetkey].family),
    ['travel', 'beauty', 'watch'],
  );
});

test('preserves compatible seed rows across schema edits and archives removed tables', (t) => {
  const contract = {
    schemaVersion: 1,
    tables: [
      {
        logicalName: 'cr_site',
        displayName: 'Site',
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Site Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
        ],
      },
      {
        logicalName: 'cr_obsolete',
        displayName: 'Obsolete',
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
        ],
      },
      {
        logicalName: 'cr_inspection',
        displayName: 'Inspection',
        plannedDecision: 'create',
        dependencyTier: 1,
        serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Inspection Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
          { logicalName: 'cr_siteid', displayName: 'Site', type: 'lookup', lookupTarget: 'cr_site', requiredLevel: 'ApplicationRequired' },
          { logicalName: 'cr_status', displayName: 'Status', type: 'choice', options: [{ value: 100000000, label: 'Draft' }, { value: 100000001, label: 'Complete' }] },
        ],
      },
    ],
  };
  const root = makeProject(t, {
    'brief.md': 'A field inspection app.',
    'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n\n## Connectors\n\n_None._\n',
    '.tmp/dataverse-schema-contract.json': JSON.stringify(contract),
  });

  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  const seedPath = path.join(root, 'src/generated/services/Cr_inspection.seed.json');
  const before = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const preservedId = before[0].cr_inspectionid;
  before[0].cr_name = 'User-authored inspection';
  before[0].cr_status = 100000000;
  before[0].localOnly = 'drop me';
  fs.writeFileSync(seedPath, `${JSON.stringify(before, null, 2)}\n`);

  contract.tables = contract.tables
    .filter((table) => table.logicalName !== 'cr_obsolete')
    .map((table) => table.logicalName !== 'cr_inspection' ? table : {
      ...table,
      columns: [
        ...table.columns.filter((column) => column.logicalName !== 'cr_status'),
        { logicalName: 'cr_status', displayName: 'Status', type: 'choice', options: [{ value: 100000001, label: 'Complete' }] },
        { logicalName: 'cr_notes', displayName: 'Notes', type: 'memo' },
      ],
    });
  fs.writeFileSync(
    path.join(root, '.tmp/dataverse-schema-contract.json'),
    JSON.stringify(contract),
  );

  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  const after = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  assert.equal(after[0].cr_inspectionid, preservedId);
  assert.equal(after[0].cr_name, 'User-authored inspection');
  assert.equal(after[0].cr_status, 100000001);
  assert.equal(typeof after[0].cr_notes, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(after[0], 'localOnly'), false);

  const report = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-seed-regeneration.json'), 'utf8'));
  const inspectionReport = report.tables.find((table) => table.logicalName === 'cr_inspection');
  assert.equal(inspectionReport.preservedRows, 8);
  assert.deepEqual(inspectionReport.addedFields, ['cr_notes']);
  assert.deepEqual(inspectionReport.regeneratedFields, ['cr_status']);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/services/Cr_obsolete.seed.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.tmp/prototype-seed-archive/src/generated/services/Cr_obsolete.seed.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/services/Cr_obsoleteService.ts')), false);
});

test('fails closed when neither a structured contract nor parseable legacy entities exist', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': '## Data Model\n\nNo executable schema was written.\n',
  });

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no entities found/);
});
