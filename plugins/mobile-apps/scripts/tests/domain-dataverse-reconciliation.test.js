'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { reconcileDomainDataverse } = require('../reconcile-domain-dataverse');
const { generateDataverseRepositories } = require('../../skills/prototype-to-real-app/scripts/gen-dataverse-repositories');

function domainModel() {
  return {
    schemaVersion: 1, mode: 'prototype-domain', experienceContractSha256: 'a'.repeat(64), contextEnrichmentSha256: 'b'.repeat(64),
    entities: [
      { key: 'Category', displayName: 'Category', displayPluralName: 'Categories', description: 'A product browsing category.', primaryNameField: 'name', estimatedPrototypeRows: 1, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'name', displayName: 'Name', type: 'text', required: true },
      ] },
      { key: 'Product', displayName: 'Product', displayPluralName: 'Products', description: 'A product offered in the catalog.', primaryNameField: 'name', estimatedPrototypeRows: 3, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'categoryId', displayName: 'Category', type: 'reference', required: true, referenceTarget: 'Category' },
        { key: 'name', displayName: 'Name', type: 'text', required: true },
        { key: 'status', displayName: 'Status', type: 'choice', required: true, choiceKey: 'ProductStatus' },
        { key: 'price', displayName: 'Price', type: 'money', required: true },
      ] },
    ],
    relationships: [{ key: 'CategoryProducts', parent: 'Category', child: 'Product', cardinality: 'one-to-many', childField: 'categoryId', required: true }],
    choices: [{ key: 'ProductStatus', options: [{ key: 'available', label: 'Available' }, { key: 'sold-out', label: 'Sold out' }] }],
    operations: [
      { key: 'listCategories', entity: 'Category', kind: 'list', repository: 'CatalogRepository', method: 'listCategories', hook: 'useCategories', selectFields: ['id', 'name'], filterFields: [], sortFields: ['name'], pagination: { mode: 'bounded', boundedReason: 'One prototype category.', maximumExpectedCount: 1 } },
      { key: 'listProducts', entity: 'Product', kind: 'list', repository: 'CatalogRepository', method: 'listProducts', hook: 'useProducts', selectFields: ['id', 'categoryId', 'name', 'status', 'price'], filterFields: ['categoryId', 'status'], sortFields: ['name'], pagination: { mode: 'cursor', pageSize: 20 } },
      { key: 'getProduct', entity: 'Product', kind: 'get', repository: 'CatalogRepository', method: 'getProduct', hook: 'useProduct', selectFields: ['id', 'categoryId', 'name', 'status', 'price'], filterFields: [], sortFields: [], pagination: { mode: 'none' } },
      { key: 'createProduct', entity: 'Product', kind: 'create', repository: 'CatalogRepository', method: 'createProduct', hook: 'useCreateProduct', selectFields: [], filterFields: [], sortFields: [], writeFields: ['categoryId', 'name', 'status', 'price'], pagination: { mode: 'none' } },
    ],
    actors: [{ key: 'Shopper', displayName: 'Shopper' }],
    uxPermissions: [
      { actor: 'Shopper', operation: 'listCategories', allowed: true },
      { actor: 'Shopper', operation: 'listProducts', allowed: true },
      { actor: 'Shopper', operation: 'getProduct', allowed: true },
      { actor: 'Shopper', operation: 'createProduct', allowed: true },
    ],
    offlineUxIntent: { connectivity: 'network-optional', requiredOperations: ['listProducts'] },
    fixtureRequirements: [
      { key: 'catalog-populated', state: 'populated', description: 'Three products are visible.', entity: 'Product', minimumRecords: 3 },
      { key: 'catalog-loading', state: 'loading', description: 'Products are loading.' },
      { key: 'catalog-empty', state: 'empty', description: 'No products are visible.' },
      { key: 'catalog-error', state: 'error', description: 'Products failed to load.' },
      { key: 'catalog-offline', state: 'offline', description: 'Cached products remain visible.' },
    ],
    mediaPolicy: { mode: 'not-applicable', requiredFields: [], requiresFallback: false },
    fixtures: {
      Category: [{ id: 'category-travel', name: 'Travel essentials' }],
      Product: [
        { id: 'product-organizer', categoryId: 'category-travel', name: 'Travel organizer', status: 'available', price: { amount: 42.5, currencyCode: 'USD' } },
        { id: 'product-watch', categoryId: 'category-travel', name: 'Classic travel watch', status: 'available', price: { amount: 129, currencyCode: 'USD' } },
        { id: 'product-mist', categoryId: 'category-travel', name: 'Hydration face mist', status: 'sold-out', price: { amount: 18, currencyCode: 'USD' } },
      ],
    },
    fixtureScenarios: [
      { key: 'catalog-populated', state: 'populated', description: 'Three products are visible.', entity: 'Product', recordIds: ['product-organizer', 'product-watch', 'product-mist'] },
      { key: 'catalog-loading', state: 'loading', description: 'Products are loading.' },
      { key: 'catalog-empty', state: 'empty', description: 'No products are visible.' },
      { key: 'catalog-error', state: 'error', description: 'Products failed to load.' },
      { key: 'catalog-offline', state: 'offline', description: 'Cached products remain visible.' },
    ],
  };
}

function dataverseManifest() {
  return {
    environmentUrl: 'https://example.crm.dynamics.com',
    tables: [{
      logicalName: 'cr1_category', displayName: 'Category', displayPluralName: 'Categories', entitySetName: 'cr1_categories', primaryIdAttribute: 'cr1_categoryid',
      columns: [{ logicalName: 'cr1_name', schemaName: 'cr1_Name', displayName: 'Name', type: 'String' }],
    }, {
      logicalName: 'cr1_product', displayName: 'Product', displayPluralName: 'Products', entitySetName: 'cr1_products', primaryIdAttribute: 'cr1_productid',
      columns: [
        { logicalName: 'cr1_categoryid', schemaName: 'cr1_Category', displayName: 'Category', type: 'Lookup', lookupTarget: 'cr1_category' },
        { logicalName: 'cr1_name', displayName: 'Name', type: 'String' },
        { logicalName: 'cr1_status', displayName: 'Status', type: 'Choice', options: [{ value: 10, label: 'Available' }, { value: 20, label: 'Sold out' }] },
        { logicalName: 'cr1_price', displayName: 'Price', type: 'Money' },
      ],
    }],
  };
}

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-dataverse-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    '.tmp/prototype-domain-model.json': `${JSON.stringify(domainModel(), null, 2)}\n`,
    '.datamodel-manifest.json': `${JSON.stringify(dataverseManifest(), null, 2)}\n`,
    'src/generated/services/Cr1_categoryService.ts': 'export const Cr1_categoryService = { async getAll() {} };\n',
    'src/generated/services/Cr1_productService.ts': 'export const Cr1_productService = { async getAll() {}, async get() {}, async create() {}, async update() {}, async delete() {} };\n',
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return root;
}

test('reconciles neutral entities and generates adapters behind stable repositories', (context) => {
  const root = project(context);
  const { report, mapping } = reconcileDomainDataverse(root);
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.conflicts, []);
  const productMapping = mapping.entities.find((entity) => entity.domainEntity === 'Product');
  assert.equal(productMapping.fields.find((field) => field.domainField === 'status').choiceMap.available, 10);
  assert.equal(productMapping.fields.find((field) => field.domainField === 'price').defaultCurrencyCode, 'USD');
  assert.deepEqual(productMapping.fields.find((field) => field.domainField === 'categoryId'), {
    domainField: 'categoryId', dataverseField: '_cr1_categoryid_value', required: true,
    transform: 'reference', sourceColumn: 'cr1_categoryid', writeField: 'cr1_Category@odata.bind',
    targetDomainEntity: 'Category', targetEntitySetName: 'cr1_categories',
  });
  assert.ok(mapping.operations.find((operation) => operation.domainOperation === 'createProduct').select.includes('cr1_name'));

  const result = generateDataverseRepositories(root);
  assert.equal(result.target, 'src/data/repositories/dataverseRepositories.ts');
  const source = fs.readFileSync(path.join(root, result.target), 'utf8');
  assert.match(source, /Cr1_productService\.getAll/);
  assert.match(source, /decodeChoice/);
  assert.match(source, /_cr1_categoryid_value/);
  assert.match(source, /cr1_Category@odata\.bind/);
  assert.match(source, /bindReference\("cr1_categories", input\.categoryId\)/);
  assert.match(source, /odataGuid\(input\.categoryId\)/);
  assert.match(source, /import \{ newId \} from '@\/utils'/);
  assert.match(source, /const id = newId\(\)/);
  assert.match(source, /\["cr1_productid"\]: id/);
  assert.doesNotMatch(source, /FIXTURES|mockRepositories/);
});

test('blocks ambiguous field mappings and removes a stale executable mapping', (context) => {
  const root = project(context);
  const manifestPath = path.join(root, '.datamodel-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tables.find((table) => table.logicalName === 'cr1_product').columns.push({ logicalName: 'cr1_alternatename', displayName: 'Name', type: 'String' });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'dataverse-repository-mapping.json'), '{}\n');
  const { report, mapping } = reconcileDomainDataverse(root);
  assert.equal(report.status, 'blocked');
  assert.equal(mapping, null);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'dataverse-repository-mapping.json')), false);
  assert.match(report.conflicts.map((conflict) => conflict.message).join('\n'), /Product\.name has 2 compatible Dataverse matches/);
});