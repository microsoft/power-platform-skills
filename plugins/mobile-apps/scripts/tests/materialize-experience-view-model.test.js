'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { materializeExperienceViewModel } = require('../materialize-experience-view-model');
const { inspectExperienceImage } = require('../lib/experience-media');

test('materializes a decodable bundled fallback and a stable record adapter', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-experience-view-model-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), JSON.stringify({
    assetPolicy: { media: 'local-first' },
  }));
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-schema-contract.json'), JSON.stringify({
    tables: [
      {
        logicalName: 'cr_product',
        displayName: 'Product',
        plannedDecision: 'create',
        serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', type: 'string', primaryName: true },
          { logicalName: 'cr_price', type: 'money' },
          { logicalName: 'cr_currencycode', type: 'string' },
          { logicalName: 'cr_category', type: 'string' },
          { logicalName: 'cr_availability', type: 'string' },
          { logicalName: 'cr_categoryid', type: 'lookup', lookupTarget: 'cr_category' },
          { logicalName: 'cr_image', type: 'image' },
        ],
      },
    ],
  }));
  fs.mkdirSync(path.join(root, 'src', 'generated', 'services'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'generated', 'services', 'Cr_product.seed.json'), JSON.stringify([
    {
      cr_productid: 'product-1',
      cr_name: 'Cabin comfort set',
      cr_price: 52,
      cr_currencycode: 'CAD',
      cr_category: 'Travel accessories',
      cr_availability: 'Unavailable',
      cr_categoryid: 'category-1',
      cr_image: 'asset://experience/cr_product-1.png',
    },
  ]));

  const result = materializeExperienceViewModel(root);
  assert.deepEqual(result, {
    assetManifestPath: 'assets/experience/manifest.json',
    viewModelPath: 'src/generated/experience-view-model.ts',
    entities: ['cr_product'],
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(root, result.assetManifestPath), 'utf8'));
  const adapter = fs.readFileSync(path.join(root, result.viewModelPath), 'utf8');
  assert.equal(manifest.assetPolicy, 'local-first');
  const asset = manifest.assets['asset://experience/cr_product-1.png'];
  assert.equal(asset.kind, 'bundled-raster');
  assert.equal(asset.materialized, true);
  assert.equal(asset.width, 960);
  assert.equal(asset.height, 720);
  assert.equal(inspectExperienceImage(path.join(root, asset.localPath)).decodable, true);
  assert.deepEqual(manifest.media.coverage, { expectedRecords: 1, resolvedRecords: 1 });
  assert.deepEqual(manifest.fallbacks.cr_product, {
    keyPattern: 'asset://experience/cr_product/<record-id>',
    kind: 'local-illustration',
    family: 'product',
    label: 'Product',
    category: null,
  });
  assert.match(adapter, /fallbackAssetKeyPrefix/);
  assert.match(adapter, /EXPERIENCE_ASSET_SOURCES/);
  assert.match(adapter, /sourcePriority/);
  assert.match(adapter, /httpsImageSource\((?:record|mediaRecord)\.imageUrl\)/);
  assert.equal(
    adapter.includes('return /^https:\\/\\//i.test(imageUrl) ? { uri: imageUrl } : null;'),
    true,
    'generated TypeScript must preserve the escaped HTTPS regex',
  );
  assert.equal(adapter.includes('/^https:///i'), false);
  assert.match(adapter, /imageSource: remoteSource \|\| fallbackSource/);
  assert.match(adapter, /fallbackSource,/);
  assert.match(adapter, /toExperienceRecord/);
  assert.match(adapter, /currencyField/);
  assert.match(adapter, /currencyCode/);
  assert.match(adapter, /availabilityState/);
  assert.match(adapter, /isExperienceRecordActionable/);
  assert.match(adapter, /relatedExperienceRecords/);
  assert.match(adapter, /relationshipFields/);
  assert.match(adapter, /"cr_categoryid": "cr_category"/);
  assert.match(adapter, /relatedRecords: ExperienceRecord\[\] = \[\]/);
  assert.match(adapter, /stable record ID mapping/);
  assert.doesNotMatch(adapter, /PRODUCT_COPY/);
});
