'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { materializeExperienceViewModel } = require('../materialize-experience-view-model');

test('materializes schema-only local illustration fallbacks and a stable record adapter', (context) => {
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
          { logicalName: 'cr_category', type: 'string' },
          { logicalName: 'cr_image', type: 'image' },
        ],
      },
    ],
  }));

  const result = materializeExperienceViewModel(root);
  assert.deepEqual(result, {
    assetManifestPath: 'assets/experience/manifest.json',
    viewModelPath: 'src/generated/experience-view-model.ts',
    entities: ['cr_product'],
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(root, result.assetManifestPath), 'utf8'));
  const adapter = fs.readFileSync(path.join(root, result.viewModelPath), 'utf8');
  assert.equal(manifest.assetPolicy, 'local-first');
  assert.deepEqual(manifest.assets, {});
  assert.deepEqual(manifest.fallbacks.cr_product, {
    keyPattern: 'asset://experience/cr_product/<record-id>',
    kind: 'local-illustration',
    family: 'product',
    label: 'Product',
    category: null,
  });
  assert.match(adapter, /fallbackAssetKeyPrefix/);
  assert.match(adapter, /toExperienceRecord/);
  assert.match(adapter, /stable record ID mapping/);
  assert.doesNotMatch(adapter, /PRODUCT_COPY/);
});