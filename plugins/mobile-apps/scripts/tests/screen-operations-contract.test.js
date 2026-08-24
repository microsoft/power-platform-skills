'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateExperienceScreenContract } = require('../lib/experience-screen-contract');

const dataContract = {
  tables: [
    {
      logicalName: 'cr_product',
      primaryIdAttribute: 'cr_productid',
      serviceRequired: true,
      plannedDecision: 'create',
      columns: [
        { logicalName: 'cr_productid', type: 'uniqueidentifier', plannedDecision: 'create' },
        { logicalName: 'cr_name', type: 'string', plannedDecision: 'create' },
        { logicalName: 'cr_featured', type: 'boolean', plannedDecision: 'create' },
        { logicalName: 'cr_priority', type: 'integer', plannedDecision: 'create' },
      ],
      relationships: [],
    },
    {
      logicalName: 'cr_productmedia',
      primaryIdAttribute: 'cr_productmediaid',
      serviceRequired: true,
      plannedDecision: 'create',
      columns: [
        { logicalName: 'cr_productmediaid', type: 'uniqueidentifier', plannedDecision: 'create' },
        { logicalName: 'cr_productid', type: 'lookup', lookupTarget: 'cr_product', plannedDecision: 'create' },
        { logicalName: 'cr_imageurl', type: 'string', plannedDecision: 'create' },
      ],
      relationships: [{
        kind: 'many-to-one',
        schemaName: 'cr_Product_ProductMedia',
        plannedDecision: 'create',
        parentTable: 'cr_product',
        childTable: 'cr_productmedia',
        lookup: { logicalName: 'cr_productid' },
      }],
    },
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
    firstViewport: { regionIds: ['product-content'], focalPoint: 'Selected product details', maxRegions: 2 },
    header: { mode: 'root', title: 'Product' },
    primaryAction: { id: 'add', label: 'Add to cart', placement: 'inline' },
    media: { required: true, role: 'content', aspectRatio: '1:1', minCoverage: 0.9, fallback: 'local-asset' },
    states: ['loading', 'empty', 'error', 'offline'],
    qualityCriteria: ['Product remains visible.', 'Action remains reachable.', 'Large text does not clip.'],
    testIds: ['screen-product-detail'],
    dependencies: { foundation: [], fixtures: ['cr_product'], screens: [] },
    data: {
      entities: ['cr_product', 'cr_productmedia'],
      fixtureScenarios: ['available product', 'sold-out product'],
      operations: [
        {
          id: 'get-product', kind: 'get', entity: 'cr_product', service: 'Cr_productService', serviceMethod: 'getById',
          select: ['cr_productid', 'cr_name'], filter: [], sort: [], routeBindings: [{ parameter: 'productId', target: 'id', field: 'cr_productid' }], idField: 'cr_productid',
        },
        {
          id: 'list-product-media', kind: 'related-list', entity: 'cr_productmedia', service: 'Cr_productmediaService', serviceMethod: 'getAll',
          select: ['cr_productmediaid', 'cr_productid', 'cr_imageurl'],
          filter: [{ field: 'cr_productid', operator: 'eq', valueFrom: 'route:productId' }], sort: [],
          pagination: { mode: 'none', boundedReason: 'At most five images per product.', maximumExpectedCount: 5 },
          routeBindings: [{ parameter: 'productId', target: 'relationship', field: 'cr_productid' }],
          relationship: { sourceEntity: 'cr_product', targetEntity: 'cr_productmedia', schemaName: 'cr_Product_ProductMedia', sourceField: 'cr_productid', targetField: 'cr_productid', readStrategy: 'chained-fetch', sourceRouteParameter: 'productId' },
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
  value.screens[0].data.operations[1].select.push('cr_missing');
  value.screens[0].data.operations[1].relationship.schemaName = 'cr_Missing';
  const errors = validate(value).join('\n');
  assert.match(errors, /unknown field cr_missing/);
  assert.match(errors, /relationship cr_Missing does not exist/);
});

test('rejects a detail route whose parameter is dropped from the query bindings', () => {
  const value = contract();
  value.screens[0].data.operations[0].routeBindings = [];
  const errors = validate(value).join('\n');
  assert.match(errors, /path parameter productId is not bound to a screen operation/);
});

test('allows pagination none only for an explicitly bounded collection', () => {
  const value = contract();
  delete value.screens[0].data.operations[1].pagination.maximumExpectedCount;
  assert.match(validate(value).join('\n'), /requires maximumExpectedCount/);
});

test('rejects a related list that drops its route-key filter', () => {
  const value = contract();
  value.screens[0].data.operations[1].filter = [];
  assert.match(validate(value).join('\n'), /relationship route parameter productId must bind and filter cr_productid/);
});

test('rejects many-to-many reads without an explicit intersect table service contract', () => {
  const value = contract();
  const data = structuredClone(dataContract);
  data.tables[1].relationships[0] = {
    kind: 'many-to-many',
    schemaName: 'cr_Product_ProductMedia',
    plannedDecision: 'create',
    entity1: 'cr_product',
    entity2: 'cr_productmedia',
    intersectTable: 'cr_product_productmedia',
  };
  const errors = validateExperienceScreenContract(value, null, { dataContract: data }).join('\n');
  assert.match(errors, /requires an explicit intersect table operation/);
});