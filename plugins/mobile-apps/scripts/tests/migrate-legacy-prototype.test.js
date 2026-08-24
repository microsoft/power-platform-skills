'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { migrateLegacyPrototype } = require('../../skills/create-mobile-prototype/scripts/migrate-legacy-prototype');

function domainModel() {
  return {
    schemaVersion: 1,
    mode: 'prototype-domain',
    entities: [{
      key: 'Product', displayName: 'Product', displayPluralName: 'Products', description: 'A product available to browse.', primaryNameField: 'name', estimatedPrototypeRows: 1,
      fields: [{ key: 'id', displayName: 'ID', type: 'id', required: true }, { key: 'name', displayName: 'Name', type: 'text', required: true }],
    }],
    relationships: [], choices: [],
    operations: [{ key: 'listProducts', entity: 'Product', kind: 'list', repository: 'CatalogRepository', method: 'listProducts', hook: 'useProducts', selectFields: ['id', 'name'], filterFields: [], sortFields: ['name'], pagination: { mode: 'bounded', boundedReason: 'One prototype product.', maximumExpectedCount: 1 } }],
    actors: [{ key: 'Shopper', displayName: 'Shopper' }],
    uxPermissions: [{ actor: 'Shopper', operation: 'listProducts', allowed: true }],
    offlineUxIntent: { connectivity: 'offline-required', requiredOperations: ['listProducts'] },
    fixtures: { Product: [{ id: 'product-carry-on', name: 'Carry-on organizer' }] },
    fixtureScenarios: [
      { key: 'catalog-populated', state: 'populated', description: 'A populated product catalog.', entity: 'Product', recordIds: ['product-carry-on'] },
      { key: 'catalog-loading', state: 'loading', description: 'The catalog is loading.' },
      { key: 'catalog-empty', state: 'empty', description: 'The catalog has no products.' },
      { key: 'catalog-error', state: 'error', description: 'The catalog query failed.' },
      { key: 'catalog-offline', state: 'offline', description: 'The catalog uses local records.' },
    ],
  };
}

function project(context, seedValue) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-prototype-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    '.tmp/prototype-domain-model.json': `${JSON.stringify(domainModel(), null, 2)}\n`,
    'src/generated/services/Cr_product.seed.json': `${JSON.stringify(seedValue, null, 2)}\n`,
    'src/generated/services/Cr_productService.ts': 'export const Cr_productService = {};\n',
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  const manifest = {
    schemaVersion: 1,
    generator: 'create-mobile-prototype/gen-mock-services.js',
    files: ['src/generated/services/Cr_product.seed.json', 'src/generated/services/Cr_productService.ts'],
    tableSchemas: [{ logicalName: 'cr_product', serviceName: 'Cr_product', seedFile: 'src/generated/services/Cr_product.seed.json' }],
  };
  fs.writeFileSync(path.join(root, 'src', 'generated', '.prototype-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

test('archives legacy mocks, preserves edited fixtures, validates, and removes the archive', (context) => {
  const editedRecords = [{ cr_productid: 'legacy-custom-id', cr_name: 'Crew-selected organizer', cr_notes: 'User edited this record.' }];
  const root = project(context, editedRecords);
  const result = migrateLegacyPrototype(root);
  assert.equal(result.migrated, true);
  assert.equal(fs.existsSync(path.join(root, 'src', 'generated', '.prototype-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'src', 'generated', 'services', 'Cr_productService.ts')), false);
  assert.equal(fs.existsSync(path.join(root, '.mobile-app', 'legacy-prototype-archive')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'src', 'data', 'legacy-fixtures', 'cr_product.json'), 'utf8')), editedRecords);
  assert.equal(fs.existsSync(path.join(root, 'src', 'data', 'PrototypeDataProvider.tsx')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.mobile-app', 'prototype-domain-migration.json'), 'utf8')).status, 'completed');
});

test('restores legacy artifacts and keeps the archive when fixture validation fails', (context) => {
  const root = project(context, { not: 'an array' });
  assert.throws(() => migrateLegacyPrototype(root), /must be an array/);
  assert.equal(fs.existsSync(path.join(root, 'src', 'generated', '.prototype-manifest.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'src', 'generated', 'services', 'Cr_productService.ts')), true);
  assert.equal(fs.existsSync(path.join(root, '.mobile-app', 'legacy-prototype-archive')), true);
  assert.equal(fs.existsSync(path.join(root, 'src', 'data')), false);
});