'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_TTL_MS,
  invalidateInventoryCache,
  readInventoryCache,
  writeInventoryCache,
} = require('../dataverse-inventory-cache');
const {
  cacheablePlanningInventory,
  createSnapshot,
} = require('../create-dataverse-snapshot');

test('inventory cache defaults to thirty minutes', () => {
  assert.equal(DEFAULT_TTL_MS, 30 * 60 * 1000);
});

const context = {
  environmentUrl: 'https://example.crm.dynamics.com/',
  tenantId: 'TENANT-1',
  solution: 'Default',
  apiVersion: '9.2',
  inventorySchemaVersion: 3,
};

function tempFile(testContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-inventory-'));
  testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'inventory.json');
}

test('fresh matching inventory cache is reused', (testContext) => {
  const file = tempFile(testContext);
  writeInventoryCache(file, context, [{ logicalName: 'new_item' }], {
    nowMs: () => 100,
    nowIso: () => '2026-08-28T00:00:00.000Z',
  });
  assert.deepEqual(readInventoryCache(file, context, {
    nowMs: () => 150,
    ttlMs: 100,
  }), {
    hit: true,
    reason: 'fresh',
    inventory: [{ logicalName: 'new_item' }],
    ageMs: 50,
    cachedAt: '2026-08-28T00:00:00.000Z',
  });
});

test('expired, mismatched, and corrupt caches fail open to a live planning read', (testContext) => {
  const file = tempFile(testContext);
  writeInventoryCache(file, context, [], { nowMs: () => 100 });
  assert.equal(readInventoryCache(file, context, { nowMs: () => 201, ttlMs: 100 }).reason, 'expired');
  assert.equal(readInventoryCache(file, { ...context, tenantId: 'tenant-2' }).reason, 'identity-mismatch');
  assert.equal(readInventoryCache(file, { ...context, solution: 'Other' }).reason, 'identity-mismatch');
  assert.equal(readInventoryCache(file, { ...context, apiVersion: '9.3' }).reason, 'identity-mismatch');
  const malformed = JSON.parse(fs.readFileSync(file, 'utf8'));
  malformed.identity = {};
  fs.writeFileSync(file, JSON.stringify(malformed));
  assert.equal(readInventoryCache(file, context).reason, 'identity-mismatch');
  fs.writeFileSync(file, '{invalid');
  assert.equal(readInventoryCache(file, context).reason, 'invalid-json');
});

test('cache invalidation is idempotent', (testContext) => {
  const file = tempFile(testContext);
  writeInventoryCache(file, context, []);
  assert.equal(invalidateInventoryCache(file), true);
  assert.equal(invalidateInventoryCache(file), true);
});

test('a corrupt cache is replaced atomically without temporary siblings', (testContext) => {
  const file = tempFile(testContext);
  fs.writeFileSync(file, '{invalid');
  assert.equal(readInventoryCache(file, context).reason, 'invalid-json');
  writeInventoryCache(file, context, [{ logicalName: 'new_item' }]);
  assert.equal(readInventoryCache(file, context).hit, true);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['inventory.json']);
});

test('cached inventory skips broad discovery but exact name checks stay live', async () => {
  const calls = [];
  const inventory = [{
    logicalName: 'new_item',
    schemaName: 'new_item',
    displayName: 'Item',
    displayCollectionName: 'Items',
    description: 'Item records',
    entitySetName: 'new_items',
    primaryIdAttribute: 'new_itemid',
    primaryNameAttribute: 'new_name',
    ownershipType: 'UserOwned',
    customEntity: true,
    managed: false,
    customizable: true,
    canCreateAttributes: true,
  }];
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    inventory,
    inventorySource: 'cache',
    inventoryCacheAgeMs: 20,
    proposedTableNames: ['new_missing'],
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      return { status: 200, data: { value: [] } };
    },
  });
  assert.equal(snapshot.inventorySource, 'cache');
  assert.equal(snapshot.inventoryCacheAgeMs, 20);
  assert.equal(calls.some((apiPath) => apiPath.includes('IsCustomizable/Value eq true')), false);
  assert.equal(calls.filter((apiPath) => apiPath.startsWith('EntityDefinitions?')).length, 1);
});

test('live and cached inventory produce identical ranking and selected table evidence', async () => {
  const rawEntity = {
    LogicalName: 'new_item',
    SchemaName: 'new_Item',
    DisplayName: { UserLocalizedLabel: { Label: 'Item' } },
    DisplayCollectionName: { UserLocalizedLabel: { Label: 'Items' } },
    Description: { UserLocalizedLabel: { Label: 'Item records' } },
    EntitySetName: 'new_items',
    PrimaryIdAttribute: 'new_itemid',
    PrimaryNameAttribute: 'new_name',
    OwnershipType: 'UserOwned',
    IsCustomEntity: true,
    IsManaged: false,
    IsCustomizable: { Value: true },
    CanCreateAttributes: { Value: true },
  };
  const makeRequest = (liveInventory) => async (_method, apiPath) => {
    if (liveInventory && apiPath.includes('IsCustomizable/Value eq true')) {
      return { status: 200, data: { value: [rawEntity] } };
    }
    return { status: 200, data: { value: [] } };
  };
  const options = {
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    concepts: [{ phrase: 'items', kind: 'entity', discoverTable: true, evidence: 'items' }],
    nowIso: () => '2026-08-28T00:00:00.000Z',
  };
  const live = await createSnapshot({ ...options, request: makeRequest(true) });
  const cached = await createSnapshot({
    ...options,
    inventory: live.inventory,
    inventorySource: 'cache',
    inventoryCacheAgeMs: 10,
    request: makeRequest(false),
  });
  assert.deepEqual(cached.candidateRanking, live.candidateRanking);
  assert.deepEqual(cached.selectedCandidateEvidence, live.selectedCandidateEvidence);
  assert.deepEqual(cached.tables, live.tables);
});

test('execution reconciliation explicitly bypasses the planning inventory cache', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'create-dataverse-snapshot.js'), 'utf8');
  assert.match(source, /inventoryCachePath && !baseSnapshot && !args\['reconcile-exact'\]/);
  assert.match(source, /if \(inventoryCachePath && !baseSnapshot && !args\['reconcile-exact'\] && !cacheRead\.hit\)/);
});

test('refresh invalidates the cache before a planning read', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'create-dataverse-snapshot.js'), 'utf8');
  assert.match(source, /if \(args\.refresh && inventoryCachePath\)/);
  assert.match(source, /invalidateInventoryCache\(inventoryCachePath\)/);
  assert.match(source, /refreshed: Boolean\(args\.refresh\)/);
});

test('cache candidates exclude non-customizable exact-name additions', () => {
  assert.deepEqual(cacheablePlanningInventory({
    inventory: [
      { logicalName: 'new_item', customizable: true },
      { logicalName: 'managed_dependency', customizable: false },
    ],
  }), [{ logicalName: 'new_item', customizable: true }]);
});

test('both successful metadata publish paths invalidate planning inventory', () => {
  const skill = fs.readFileSync(path.resolve(
    __dirname,
    '..',
    '..',
    'skills',
    'add-dataverse',
    'SKILL.md',
  ), 'utf8');
  const invalidations = skill.match(/node "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/scripts\/dataverse-inventory-cache\.js"/g) || [];
  assert.equal(invalidations.length, 2);
  assert.match(skill, /After the `publish` phase succeeds[\s\S]*dataverse-inventory-cache\.js/);
  assert.match(skill, /After a 2xx publish[\s\S]*dataverse-inventory-cache\.js/);
});