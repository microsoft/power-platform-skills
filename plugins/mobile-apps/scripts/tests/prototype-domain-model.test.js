'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validatePrototypeDomainModel } = require('../lib/prototype-domain-model');

function model() {
  return {
    schemaVersion: 1,
    mode: 'prototype-domain',
    entities: [
      { key: 'Category', displayName: 'Category', displayPluralName: 'Categories', description: 'A product browsing category.', primaryNameField: 'name', estimatedPrototypeRows: 2, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'name', displayName: 'Name', type: 'text', required: true },
      ] },
      { key: 'Product', displayName: 'Product', displayPluralName: 'Products', description: 'An item available in the boutique.', primaryNameField: 'name', estimatedPrototypeRows: 2, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'categoryId', displayName: 'Category', type: 'reference', required: true, referenceTarget: 'Category' },
        { key: 'name', displayName: 'Name', type: 'text', required: true },
        { key: 'price', displayName: 'Price', type: 'money', required: true },
        { key: 'status', displayName: 'Status', type: 'choice', required: true, choiceKey: 'ProductStatus' },
        { key: 'inventoryQuantity', displayName: 'Inventory', type: 'whole-number', required: true, minimum: 0 },
        { key: 'media', displayName: 'Media', type: 'image', required: true, mediaIntent: 'featured' },
      ] },
    ],
    relationships: [{ key: 'CategoryProducts', parent: 'Category', child: 'Product', cardinality: 'one-to-many', childField: 'categoryId', required: true }],
    choices: [{ key: 'ProductStatus', options: [{ key: 'available', label: 'Available' }, { key: 'sold-out', label: 'Sold out' }] }],
    operations: [{ key: 'listProducts', entity: 'Product', kind: 'list', repository: 'CatalogRepository', method: 'listProducts', hook: 'useProducts', selectFields: ['id', 'name', 'price', 'status', 'media'], filterFields: ['categoryId', 'status'], sortFields: ['name'], pagination: { mode: 'bounded', boundedReason: 'Prototype catalog has two records.', maximumExpectedCount: 2 } }],
    actors: [{ key: 'Shopper', displayName: 'Shopper' }],
    uxPermissions: [{ actor: 'Shopper', operation: 'listProducts', allowed: true }],
    offlineUxIntent: { connectivity: 'offline-required', requiredOperations: ['listProducts'] },
    fixtures: {
      Category: [{ id: 'category-travel', name: 'Travel essentials' }, { id: 'category-wellness', name: 'Wellness' }],
      Product: [
        { id: 'product-organizer', categoryId: 'category-travel', name: 'Travel organizer', price: { amount: 42.5, currencyCode: 'USD' }, status: 'available', inventoryQuantity: 8, media: { imageAltText: 'Compact travel organizer', imageAssetKey: 'asset://experience/travel-organizer.png' } },
        { id: 'product-mist', categoryId: 'category-wellness', name: 'Hydration face mist', price: { amount: 18, currencyCode: 'USD' }, status: 'sold-out', inventoryQuantity: 0, media: { imageAltText: 'Hydration face mist bottle', imageAssetKey: 'asset://experience/hydration-mist.png' } },
      ],
    },
    fixtureScenarios: [
      { key: 'catalog-populated', state: 'populated', description: 'Catalog with available and sold-out products.', entity: 'Product', recordIds: ['product-organizer', 'product-mist'] },
      { key: 'catalog-loading', state: 'loading', description: 'Catalog query is loading.' },
      { key: 'catalog-empty', state: 'empty', description: 'No products match the category.' },
      { key: 'catalog-error', state: 'error', description: 'Catalog repository reports an error.' },
      { key: 'catalog-offline', state: 'offline', description: 'Catalog uses local fixture data offline.' },
    ],
  };
}

test('accepts a neutral validated domain with stable fixtures', () => {
  assert.deepEqual(validatePrototypeDomainModel(model()), { valid: true, errors: [] });
});

test('rejects provisional Dataverse metadata and generic fixture copy', () => {
  const value = model();
  value.publisherPrefix = 'cr';
  value.fixtures.Product[0].name = 'Product 1';
  const errors = validatePrototypeDomainModel(value).errors.join('\n');
  assert.match(errors, /publisherPrefix/);
  assert.match(errors, /generic numbered copy/);
});

test('rejects broken references, choices, money, and media', () => {
  const value = model();
  value.fixtures.Product[0].categoryId = 'missing-category';
  value.fixtures.Product[0].status = 'draft';
  value.fixtures.Product[0].price.currencyCode = 'DOLLARS';
  value.fixtures.Product[0].media.imageAltText = '';
  const errors = validatePrototypeDomainModel(value).errors.join('\n');
  assert.match(errors, /missing ID/);
  assert.match(errors, /invalid choice key/);
  assert.match(errors, /ISO currency code/);
  assert.match(errors, /imageAltText/);
});

test('rejects an operation with unknown fields or unsafe pagination', () => {
  const value = model();
  value.operations[0].selectFields.push('logicalName');
  value.operations[0].pagination = { mode: 'none' };
  const errors = validatePrototypeDomainModel(value).errors.join('\n');
  assert.match(errors, /unknown field logicalName/);
  assert.match(errors, /requires bounded or cursor pagination/);
});

test('validates file fields as structured domain files', () => {
  const value = model();
  value.entities.find((entity) => entity.key === 'Product').fields.push({ key: 'specification', displayName: 'Specification', type: 'file', required: false });
  value.fixtures.Product[0].specification = { fileName: 'organizer-spec.pdf', mimeType: 'application/pdf', localUri: 'assets/specs/organizer.pdf' };
  assert.deepEqual(validatePrototypeDomainModel(value), { valid: true, errors: [] });
  value.fixtures.Product[0].specification = 'organizer-spec.pdf';
  assert.match(validatePrototypeDomainModel(value).errors.join('\n'), /must contain fileName and mimeType/);
});

test('rejects unknown nested metadata and generated identity collisions', () => {
  const value = model();
  value.choices[0].options[0].numericValue = 1;
  value.operations[0].service = 'Cr_productService';
  value.operations.push({ ...structuredClone(value.operations[0]), key: 'listFeaturedProducts' });
  const errors = validatePrototypeDomainModel(value).errors.join('\n');
  assert.match(errors, /options\[0\] has unknown keys: numericValue/);
  assert.match(errors, /operations\[0\] has unknown keys: service/);
  assert.match(errors, /duplicate useProducts/);
  assert.match(errors, /duplicate repository method CatalogRepository\.listProducts/);
});