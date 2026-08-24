'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generateDataLayer } = require('../../skills/create-mobile-prototype/scripts/gen-data-layer');
const { recordLifecycleValidation, validateDomainScope } = require('../validate-mobile-app');

function domainModel() {
  return {
    schemaVersion: 1, mode: 'prototype-domain',
    experienceContractSha256: 'a'.repeat(64), contextEnrichmentSha256: 'b'.repeat(64),
    entities: [
      { key: 'Product', displayName: 'Product', displayPluralName: 'Products', description: 'A product available to browse.', primaryNameField: 'name', estimatedPrototypeRows: 2, fields: [
        { key: 'id', displayName: 'ID', type: 'id', required: true },
        { key: 'name', displayName: 'Name', type: 'text', required: true },
        { key: 'status', displayName: 'Status', type: 'choice', required: true, choiceKey: 'ProductStatus' },
        { key: 'price', displayName: 'Price', type: 'money', required: true },
        { key: 'media', displayName: 'Media', type: 'image', required: true, mediaIntent: 'featured' },
      ] },
    ],
    relationships: [],
    choices: [{ key: 'ProductStatus', options: [{ key: 'available', label: 'Available' }, { key: 'sold-out', label: 'Sold out' }] }],
    operations: [
      { key: 'listProducts', entity: 'Product', kind: 'list', repository: 'CatalogRepository', method: 'listProducts', hook: 'useProducts', selectFields: ['id', 'name', 'status', 'price', 'media'], filterFields: ['status'], sortFields: ['name'], pagination: { mode: 'bounded', boundedReason: 'Two fixture products.', maximumExpectedCount: 2 } },
      { key: 'getProduct', entity: 'Product', kind: 'get', repository: 'CatalogRepository', method: 'getProduct', hook: 'useProduct', selectFields: ['id', 'name', 'status', 'price', 'media'], filterFields: [], sortFields: [], pagination: { mode: 'none' } },
      { key: 'createProduct', entity: 'Product', kind: 'create', repository: 'CatalogRepository', method: 'createProduct', hook: 'useCreateProduct', selectFields: [], filterFields: [], sortFields: [], writeFields: ['name', 'status', 'price', 'media'], pagination: { mode: 'none' } },
    ],
    actors: [{ key: 'Shopper', displayName: 'Shopper' }],
    uxPermissions: [{ actor: 'Shopper', operation: 'listProducts', allowed: true }, { actor: 'Shopper', operation: 'getProduct', allowed: true }, { actor: 'Shopper', operation: 'createProduct', allowed: true }],
    offlineUxIntent: { connectivity: 'offline-required', requiredOperations: ['listProducts', 'getProduct'] },
    fixtureRequirements: [
      { key: 'products-populated', state: 'populated', description: 'Two products are visible.', entity: 'Product', minimumRecords: 2 },
      { key: 'products-loading', state: 'loading', description: 'Products are loading.' },
      { key: 'products-empty', state: 'empty', description: 'No products are available.' },
      { key: 'products-error', state: 'error', description: 'Products failed to load.' },
      { key: 'products-offline', state: 'offline', description: 'Local products remain available.' },
    ],
    mediaPolicy: { mode: 'local-first', requiredFields: ['imageAltText', 'imageAssetKey'], requiresFallback: true },
    fixtures: { Product: [
      { id: 'product-one', name: 'Travel organizer', status: 'available', price: { amount: 42.5, currencyCode: 'USD' }, media: { imageAltText: 'Travel organizer', imageAssetKey: 'asset://experience/product-one.png', family: 'travel' } },
      { id: 'product-two', name: 'Classic watch', status: 'sold-out', price: { amount: 129, currencyCode: 'USD' }, media: { imageAltText: 'Classic travel watch', imageAssetKey: 'asset://experience/product-two.png', family: 'watch' } },
    ] },
    fixtureScenarios: [
      { key: 'products-populated', state: 'populated', description: 'Two products are visible.', entity: 'Product', recordIds: ['product-one', 'product-two'] },
      { key: 'products-loading', state: 'loading', description: 'Products are loading.' },
      { key: 'products-empty', state: 'empty', description: 'No products are available.' },
      { key: 'products-error', state: 'error', description: 'Products failed to load.' },
      { key: 'products-offline', state: 'offline', description: 'Local products remain available.' },
    ],
  };
}

test('generates neutral models, repositories, hooks, provider, fixtures, and local media', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-data-layer-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.mobile-app'), { recursive: true });
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const model = domainModel();
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), `${JSON.stringify(model, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), `${JSON.stringify({ visualCompositionIntent: { compositionFamily: 'product-led-discovery', signatureComponent: { testId: 'signature-product-rail' } } })}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), `${JSON.stringify({ schemaVersion: 1, contextMode: 'none', displayContext: [] })}\n`);
  const manifest = generateDataLayer(root, model, { assetPolicy: { media: 'local-first' } });
  for (const relativePath of [
    'src/data/model.ts', 'src/data/contracts.ts', 'src/data/fixtures.ts',
    'src/data/repositories/mockRepositories.ts', 'src/data/repositories/dataverseRepositories.ts', 'src/data/repositories/index.ts',
    'src/data/hooks/useProducts.ts', 'src/data/hooks/useProduct.ts', 'src/data/hooks/useCreateProduct.ts',
    'src/data/PrototypeDataProvider.tsx', 'src/data/media.ts', 'src/data/index.ts',
    'assets/experience/manifest.json', '.mobile-app/prototype-domain-manifest.json',
  ]) assert.equal(fs.existsSync(path.join(root, relativePath)), true, relativePath);
  assert.equal(manifest.mode, 'prototype-domain');
  assert.equal(fs.existsSync(path.join(root, 'src/generated/services')), false);
  const provider = fs.readFileSync(path.join(root, 'src/data/PrototypeDataProvider.tsx'), 'utf8');
  assert.doesNotMatch(provider, /QueryClientProvider/);
  const hooks = fs.readFileSync(path.join(root, 'src/data/hooks/useProducts.ts'), 'utf8');
  assert.match(hooks, /useQuery/);
  assert.doesNotMatch(hooks, /generated\/services/);
  assert.match(fs.readFileSync(path.join(root, 'src/data/hooks/useCreateProduct.ts'), 'utf8'), /import type \{ Product \} from '\.\.\/model'/);
  assert.match(fs.readFileSync(path.join(root, 'src/data/repositories/index.ts'), 'utf8'), /mode === 'dataverse' \? createDataverseRepositories\(\) : createMockRepositories\(\)/);
  const media = JSON.parse(fs.readFileSync(path.join(root, 'assets/experience/manifest.json'), 'utf8'));
  assert.equal(media.assetPolicy, 'local-first');
  assert.equal(Object.values(media.assets).every((asset) => asset.materialized === true), true);
  const domainCheck = validateDomainScope(root);
  assert.deepEqual(domainCheck.errors, []);
  recordLifecycleValidation(root, 'domain', null, [domainCheck]);
  const state = JSON.parse(fs.readFileSync(path.join(root, '.mobile-app', 'state.json'), 'utf8'));
  assert.equal(state.schemaVersion, 2);
  assert.match(state.lastDomainModelHash, /^[a-f0-9]{64}$/);
  assert.match(state.lastRepositoryMappingHash, /^[a-f0-9]{64}$/);
  assert.match(state.lastFixtureRevision, /^[a-f0-9]{64}$/);
  assert.equal(state.lastValidation.status, 'passed');

  fs.appendFileSync(path.join(root, 'src/data/hooks/useProducts.ts'), "\nimport { Cr_productService } from '@/generated/services';\n");
  assert.match(validateDomainScope(root).errors.join('\n'), /imports the generated service layer/);
});

test('fails closed when local-first fixtures include remote media', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-data-layer-remote-'));
  const value = domainModel();
  value.fixtures.Product[0].media.imageUrl = 'https://images.unsplash.com/photo-test';
  assert.throws(() => generateDataLayer(root, value, { assetPolicy: { media: 'local-first' } }), /imageUrl is forbidden by local-first/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses to overwrite an unowned src/data tree', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-data-unowned-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'data', 'user-owned.ts'), 'export const keep = true;\n');
  assert.throws(() => generateDataLayer(root, domainModel()), /src\/data exists without an owned prototype domain manifest/);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'data', 'user-owned.ts'), 'utf8'), 'export const keep = true;\n');
});

test('restores the previous generated layer after a mid-install failure', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-data-rollback-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = domainModel();
  generateDataLayer(root, original);
  const modelPath = path.join(root, 'src', 'data', 'model.ts');
  const manifestPath = path.join(root, '.mobile-app', 'prototype-domain-manifest.json');
  const previousModel = fs.readFileSync(modelPath, 'utf8');
  const previousManifest = fs.readFileSync(manifestPath, 'utf8');
  const changed = domainModel();
  changed.entities[0].displayName = 'Catalog product';

  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (String(source).includes('.prototype-data-stage-') && String(target).endsWith(path.join('src', 'data', 'contracts.ts'))) throw new Error('forced domain install failure');
    return renameSync(source, target);
  };
  try {
    assert.throws(() => generateDataLayer(root, changed), /forced domain install failure/);
  } finally {
    fs.renameSync = renameSync;
  }

  assert.equal(fs.readFileSync(modelPath, 'utf8'), previousModel);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), previousManifest);
  assert.equal(fs.readdirSync(path.join(root, '.mobile-app')).some((name) => /prototype-data-(?:stage|backup)-/.test(name)), false);
});

test('preserves a reconciled Dataverse adapter during shared-domain regeneration', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-data-adapter-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  generateDataLayer(root, domainModel());
  const adapterPath = path.join(root, 'src', 'data', 'repositories', 'dataverseRepositories.ts');
  const adapter = '// Generated by prototype-to-real-app/gen-dataverse-repositories.js\nexport const live = true;\n';
  fs.writeFileSync(adapterPath, adapter);
  generateDataLayer(root, domainModel());
  assert.equal(fs.readFileSync(adapterPath, 'utf8'), adapter);
});

test('generates connector hooks behind fail-closed prototype repositories', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-data-connector-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const connectorOperation = {
    id: 'send-message', kind: 'connector', entity: null,
    domainOperation: 'connector-send-message', repository: 'MessagingRepository',
    repositoryMethod: 'sendMessage', hook: 'useSendMessage', routeBindings: [],
    connectorOperationId: 'connector-send-message',
  };
  generateDataLayer(
    root,
    domainModel(),
    null,
    { screens: [{ data: { operations: [connectorOperation] } }] },
    { connectorOperations: [{ id: 'connector-send-message' }] },
  );
  const contracts = fs.readFileSync(path.join(root, 'src/data/contracts.ts'), 'utf8');
  const hook = fs.readFileSync(path.join(root, 'src/data/hooks/useSendMessage.ts'), 'utf8');
  const mock = fs.readFileSync(path.join(root, 'src/data/repositories/mockConnectorRepositories.ts'), 'utf8');
  assert.match(contracts, /interface MessagingRepository/);
  assert.match(contracts, /sendMessage\(input: Record<string, unknown>\)/);
  assert.match(hook, /useMutation/);
  assert.match(hook, /MessagingRepository\.sendMessage\(input\)/);
  assert.match(mock, /Connector operation connector-send-message is unavailable in prototype mode/);
  assert.doesNotMatch(hook, /@\/generated|services/);
});