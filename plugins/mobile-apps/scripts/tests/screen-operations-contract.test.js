'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateExperienceScreenContract } = require('../lib/experience-screen-contract');

const dataContract = {
  schemaVersion: 1,
  mode: 'prototype-domain',
  entities: [
    {
      key: 'Product',
      fields: [
        { key: 'id', type: 'id' },
        { key: 'name', type: 'text' },
        { key: 'featured', type: 'boolean' },
        { key: 'priority', type: 'whole-number' },
      ],
    },
    {
      key: 'ProductMedia',
      fields: [
        { key: 'id', type: 'id' },
        { key: 'productId', type: 'reference', referenceTarget: 'Product' },
        { key: 'imageUrl', type: 'text' },
      ],
    },
  ],
  relationships: [{ key: 'ProductMedia', parent: 'Product', child: 'ProductMedia', cardinality: 'one-to-many', childField: 'productId', required: false }],
  operations: [
    { key: 'getProduct', entity: 'Product', kind: 'get', repository: 'CatalogRepository', method: 'getProduct', hook: 'useProduct', selectFields: ['id', 'name'], filterFields: [], sortFields: [] },
    { key: 'listProductMedia', entity: 'ProductMedia', kind: 'list', repository: 'CatalogRepository', method: 'listProductMedia', hook: 'useProductMedia', selectFields: ['id', 'productId', 'imageUrl'], filterFields: ['productId'], sortFields: [], pagination: { mode: 'none', boundedReason: 'At most five images per product.', maximumExpectedCount: 5 } },
  ],
};

function screen(overrides = {}) {
  return {
    id: 'ProductDetail',
    route: '/(app)/products/[productId]',
    file: 'app/(app)/products/[productId].tsx',
    role: 'primary',
    purpose: 'Inspect one product and its media.',
    routeParameters: [{ name: 'productId', source: 'path', required: true }],
    navigation: { kind: 'stack-root', intent: 'replace' },
    presentation: { pattern: 'detail', density: 'balanced', hierarchy: ['Product', 'Media'] },
    regions: [{ id: 'product-content', kind: 'content', priority: 1, viewport: 'first', mediaRequired: true }],
    firstViewport: { regionIds: ['product-content'], focalPoint: 'Selected product details', maxRegions: 2, nextContentVisible: true, maxFeatureViewportShare: 0.38 },
    context: { entryIds: [], placementIntent: 'none', assumptions: [] },
    signatureComponent: { kind: 'product-detail', required: true, testId: 'experience-signature-product-detail' },
    header: { mode: 'root', title: 'Product' },
    primaryAction: { id: 'add', label: 'Add to cart', placement: 'inline' },
    media: { required: true, role: 'content', aspectRatio: '1:1', minCoverage: 0.9, fallback: 'local-asset', prominence: 'high' },
    states: ['loading', 'empty', 'error', 'offline'],
    qualityCriteria: ['Product remains visible.', 'Action remains reachable.', 'Large text does not clip.'],
    testIds: ['screen-product-detail', 'experience-signature-product-detail'],
    dependencies: { foundation: [], fixtures: ['Product'], screens: [] },
    data: {
      entities: ['Product', 'ProductMedia'],
      fixtureScenarios: ['available product', 'sold-out product'],
      operations: [
        {
          id: 'get-product', kind: 'get', entity: 'Product', domainOperation: 'getProduct', repository: 'CatalogRepository', repositoryMethod: 'getProduct', hook: 'useProduct',
          select: ['id', 'name'], filter: [], sort: [], routeBindings: [{ parameter: 'productId', target: 'id', field: 'id' }], idField: 'id',
        },
        {
          id: 'list-product-media', kind: 'related-list', entity: 'ProductMedia', domainOperation: 'listProductMedia', repository: 'CatalogRepository', repositoryMethod: 'listProductMedia', hook: 'useProductMedia',
          select: ['id', 'productId', 'imageUrl'],
          filter: [{ field: 'productId', operator: 'eq', valueFrom: 'route:productId' }], sort: [],
          pagination: { mode: 'none', boundedReason: 'At most five images per product.', maximumExpectedCount: 5 },
          routeBindings: [{ parameter: 'productId', target: 'relationship', field: 'productId' }],
          relationship: { key: 'ProductMedia', sourceEntity: 'Product', targetEntity: 'ProductMedia', sourceField: 'id', targetField: 'productId', readStrategy: 'repository', sourceRouteParameter: 'productId' },
        },
      ],
    },
    forbiddenDefaults: [],
    ...overrides,
  };
}

function contract(value = screen()) {
  return {
    schemaVersion: 3,
    experienceContractSha256: 'a'.repeat(64),
    primaryScreen: { route: value.route, file: value.file },
    keyFlow: { route: '/(app)/cart', file: 'app/(app)/cart.tsx', outcome: 'Review the cart.' },
    criticalFlow: { screenIds: [value.id, 'Cart'], outcome: 'Inspect and add a product.' },
    screens: [
      value,
      { ...screen({ id: 'Cart', route: '/(app)/cart', file: 'app/(app)/cart.tsx', role: 'key-flow', header: { mode: 'back', title: 'Cart' }, routeParameters: [], data: { entities: [], fixtureScenarios: ['empty cart'], operations: [] } }) },
    ],
  };
}

function validate(value) {
  return validateExperienceScreenContract(value, null, { dataContract });
}

test('accepts field-valid reads, bounded pagination, relationships, and route bindings', () => {
  assert.deepEqual(validate(contract()), []);
});

test('rejects an unbounded list with no pagination contract', () => {
  const value = contract();
  delete value.screens[0].data.operations[1].pagination;
  assert.match(validate(value).join('\n'), /pagination is required/);
});

test('rejects a data-bound screen with no executable operations', () => {
  const value = contract();
  value.screens[0].data.operations = [];
  assert.match(validate(value).join('\n'), /declares data entities but no executable operations/);
});

test('rejects unknown query fields and nonexistent relationships', () => {
  const value = contract();
  value.screens[0].data.operations[1].select.push('missingField');
  value.screens[0].data.operations[1].relationship.key = 'MissingRelationship';
  const errors = validate(value).join('\n');
  assert.match(errors, /unknown domain field missingField/);
  assert.match(errors, /relationship MissingRelationship does not exist/);
});

test('rejects a detail route whose parameter is dropped from the query bindings', () => {
  const value = contract();
  value.screens[0].data.operations[0].routeBindings = [];
  const errors = validate(value).join('\n');
  assert.match(errors, /path parameter productId is not bound to screen operation id field id/);
});

test('rejects a declared path parameter that is absent from the route', () => {
  const value = contract();
  value.screens[0].routeParameters.push({ name: 'categoryId', source: 'path', required: true });
  value.screens[0].data.operations[1].routeBindings.push({ parameter: 'categoryId', target: 'filter', field: 'productId' });
  assert.match(validate(value).join('\n'), /declared path parameter categoryId is absent from route/);
});

test('allows pagination none only for an explicitly bounded collection', () => {
  const value = contract();
  delete value.screens[0].data.operations[1].pagination.maximumExpectedCount;
  assert.match(validate(value).join('\n'), /requires maximumExpectedCount/);
});

test('rejects a related list that drops its route-key filter', () => {
  const value = contract();
  value.screens[0].data.operations[1].filter = [];
  assert.match(validate(value).join('\n'), /relationship route parameter productId must bind and filter productId/);
});

test('rejects related reads that require an unresolved external projection', () => {
  const value = contract();
  value.screens[0].data.operations[1].relationship.readStrategy = 'external-projection-required';
  assert.match(validate(value).join('\n'), /requires an unresolved external projection/);
});