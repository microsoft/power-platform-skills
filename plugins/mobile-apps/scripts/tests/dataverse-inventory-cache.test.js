'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  invalidateInventoryCache,
  main: cacheMain,
  readInventoryCache,
  writeInventoryCache,
} = require('../dataverse-inventory-cache');
const {
  cacheablePlanningInventory,
  createSnapshot,
  expandSnapshot,
} = require('../create-dataverse-snapshot');
const { createFixtureRequest, createScaleScenario } = require('../benchmark-dataverse-planning');

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

function inventoryItem() {
  return {
    logicalName: 'new_item', schemaName: 'new_Item',
    entitySetName: 'new_items', primaryIdAttribute: 'new_itemid',
    displayName: 'Item', displayCollectionName: 'Items', description: '',
    primaryNameAttribute: 'new_name', ownershipType: 'UserOwned',
    customEntity: true, managed: false, customizable: true,
    canCreateAttributes: true, canBePrimaryEntityInRelationship: true,
    canBeRelatedEntityInRelationship: true, canBeInManyToMany: true,
    hasActivities: false, hasNotes: false,
    isAvailableOffline: true, changeTrackingEnabled: true,
  };
}

test('fresh matching inventory cache is reused', (testContext) => {
  const file = tempFile(testContext);
  writeInventoryCache(file, context, [inventoryItem()], {
    nowMs: () => 100,
    nowIso: () => '2026-08-28T00:00:00.000Z',
  });
  assert.deepEqual(readInventoryCache(file, context, {
    nowMs: () => 150,
    ttlMs: 100,
  }), {
    hit: true,
    reason: 'fresh',
    inventory: [inventoryItem()],
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

test('cache invalidation CLI fails when the cache file survives', () => {
  let stderr = '';
  const code = cacheMain(
    ['node', 'dataverse-inventory-cache.js', '--file', '/tmp/inventory.json', '--invalidate'],
    {
      fileSystem: {
        rmSync() {},
        existsSync: () => true,
      },
      stdout: { write() {} },
      stderr: { write: (value) => { stderr += value; } },
    },
  );
  assert.equal(code, 2);
  assert.match(stderr, /failed to invalidate/);
});

test('a corrupt cache is replaced atomically without temporary siblings', (testContext) => {
  const file = tempFile(testContext);
  fs.writeFileSync(file, '{invalid');
  assert.equal(readInventoryCache(file, context).reason, 'invalid-json');
  writeInventoryCache(file, context, [inventoryItem()]);
  assert.equal(readInventoryCache(file, context).hit, true);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['inventory.json']);
});

test('cached inventory skips broad discovery and refreshes every exact name live', async () => {
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
    proposedTableNames: ['new_item', 'new_missing'],
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      return { status: 200, data: { value: [] } };
    },
  });
  assert.equal(snapshot.inventorySource, 'cache');
  assert.equal(snapshot.inventoryCacheAgeMs, 20);
  assert.equal(calls.some((apiPath) => apiPath.includes('IsCustomizable/Value eq true')), false);
  assert.equal(calls.filter((apiPath) => apiPath.startsWith('EntityDefinitions?')).length, 1);
  assert.match(calls[0], /LogicalName eq 'new_item'/);
  assert.match(calls[0], /LogicalName eq 'new_missing'/);
  assert.deepEqual(snapshot.proposedNameChecks.missing, ['new_item', 'new_missing']);
  assert.equal(snapshot.inventory.some((item) => item.logicalName === 'new_item'), false);
  assert.equal(snapshot.inventoryFacts.customizableTables, 0);
  assert.equal(snapshot.inventoryFacts.exactNameTables, 0);
  assert.equal(snapshot.inventoryFacts.proposedCollisionTables, 0);
});

test('cached exact-name refresh chunks more than fifty requested names', async () => {
  const rawInventory = Array.from({ length: 55 }, (_, index) => ({
    LogicalName: `new_item${index}`,
    SchemaName: `new_Item${index}`,
    DisplayName: { UserLocalizedLabel: { Label: `Item ${index}` } },
    DisplayCollectionName: { UserLocalizedLabel: { Label: `Items ${index}` } },
    Description: { UserLocalizedLabel: { Label: `Item ${index} records` } },
    EntitySetName: `new_item${index}s`,
    PrimaryIdAttribute: `new_item${index}id`,
    PrimaryNameAttribute: 'new_name',
    OwnershipType: 'UserOwned',
    IsCustomEntity: true,
    IsManaged: false,
    IsCustomizable: { Value: true },
    CanCreateAttributes: { Value: true },
  }));
  const calls = [];
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com',
    tenantId: 'tenant-1',
    inventory: rawInventory,
    inventorySource: 'cache',
    proposedTableNames: rawInventory.map((item) => item.LogicalName),
    request: async (_method, apiPath) => {
      calls.push(apiPath);
      return { status: 200, data: { value: rawInventory } };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(snapshot.proposedNameChecks.collisions.length, 55);
  assert.equal(snapshot.inventoryFacts.exactNameTables, 0);
});

test('live and cached inventory produce identical ranking and selected table evidence', async (testContext) => {
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
    if ((liveInventory && apiPath.includes('IsCustomizable/Value eq true'))
      || apiPath.includes("LogicalName eq 'new_item'")) {
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
  const file = tempFile(testContext);
  writeInventoryCache(file, context, cacheablePlanningInventory(live));
  const cache = readInventoryCache(file, context);
  assert.equal(cache.hit, true);
  const cached = await createSnapshot({
    ...options,
    inventory: cache.inventory,
    inventorySource: 'cache',
    inventoryCacheAgeMs: 10,
    request: makeRequest(false),
  });
  assert.deepEqual(cached.candidateRanking, live.candidateRanking);
  assert.deepEqual(cached.selectedCandidateEvidence, live.selectedCandidateEvidence);
  assert.deepEqual(cached.tables, live.tables);
});

test('malformed cached inventories recover through a live read instead of an empty or crashed discovery', async (testContext) => {
  const file = tempFile(testContext);
  const valid = writeInventoryCache(file, context, [inventoryItem()]);
  const requiredFields = ['displayName', 'displayCollectionName', 'description',
    'ownershipType', 'customEntity', 'managed', 'customizable', 'canCreateAttributes',
    'canBePrimaryEntityInRelationship', 'canBeRelatedEntityInRelationship', 'canBeInManyToMany',
    'hasActivities', 'hasNotes', 'isAvailableOffline', 'changeTrackingEnabled'];
  const missingFields = requiredFields.map((field) => {
    const item = inventoryItem();
    delete item[field];
    return [item];
  });
  const invalidFields = [
    { customizable: false }, { customizable: 'true' }, { displayName: [] },
    { displayCollectionName: null }, { description: {} }, { customEntity: 'false' },
    { managed: null }, { canCreateAttributes: 'false' }, { isAvailableOffline: 1 },
    { primaryNameAttribute: 'bad name' }, { ownershipType: {} },
  ].map((updates) => [{ ...inventoryItem(), ...updates }]);
  const invalidInventories = [null, {}, [null], [[]], ['invalid'], [{}],
    [{ logicalName: 'new_item' }], [{ ...inventoryItem(), logicalName: 'bad name' }],
    [inventoryItem(), inventoryItem()],
    [inventoryItem(), { ...inventoryItem(), logicalName: 'NEW_ITEM' }],
    ...missingFields, ...invalidFields];
  for (const body of [null, [], 'invalid', ...invalidInventories.map((inventory) => ({ ...valid, inventory }))]) {
    fs.writeFileSync(file, JSON.stringify(body));
    const cache = readInventoryCache(file, context);
    assert.equal(cache.hit, false);
    assert.equal(cache.reason, 'invalid-shape');
    assert.equal(cache.inventory, null);
    let liveReads = 0;
    const snapshot = await createSnapshot({
      ...context, inventory: cache.inventory,
      request: async (_method, apiPath) => {
        assert.match(apiPath, /IsCustomizable\/Value eq true/);
        liveReads += 1;
        return { status: 200, data: { value: [] } };
      },
    });
    assert.equal(liveReads, 1);
    assert.deepEqual(snapshot.inventory, []);
  }
});

test('cache preserves customizable managed tables and explicit unknown capabilities', (testContext) => {
  const file = tempFile(testContext);
  const item = { ...inventoryItem(), managed: true, customEntity: false,
    primaryNameAttribute: null, ownershipType: null, canCreateAttributes: null,
    canBePrimaryEntityInRelationship: null, canBeRelatedEntityInRelationship: null,
    canBeInManyToMany: null, hasActivities: null, hasNotes: null,
    isAvailableOffline: null, changeTrackingEnabled: null };
  writeInventoryCache(file, context, [item]);
  const cache = readInventoryCache(file, context);
  assert.equal(cache.hit, true);
  assert.deepEqual(cache.inventory, [item]);
});

test('cached advisory tables refresh live identity flags without broad discovery or duplicate exact reads', async () => {
  const fixture = createScaleScenario(6, 'all-reuse');
  const options = { ...context, concepts: [fixture.concepts[0]], combinedBaseRead: true };
  const baseline = await createSnapshot({ ...options, request: createFixtureRequest(fixture, []) });
  const target = fixture.entities[0];
  target.CanCreateAttributes = { Value: false };
  target.OwnershipType = 'OrganizationOwned';
  for (const exact of [{}, { tableNames: [target.LogicalName] }, { proposedTableNames: [target.LogicalName] }]) {
    const calls = [];
    const snapshot = await createSnapshot({
      ...options, ...exact, inventory: baseline.inventory, inventorySource: 'cache',
      request: createFixtureRequest(fixture, calls),
    });
    const selected = snapshot.tables.find((item) => item.logicalName === target.LogicalName);
    assert.equal(selected.detailLevel, 'full');
    assert.equal(selected.canCreateAttributes, false);
    assert.equal(selected.ownershipType, 'OrganizationOwned');
    const currentInventory = snapshot.inventory.find((item) => item.logicalName === target.LogicalName);
    assert.equal(currentInventory.canCreateAttributes, false);
    assert.equal(currentInventory.ownershipType, 'OrganizationOwned');
    assert.equal(calls.filter((apiPath) => apiPath.startsWith('EntityDefinitions?')).length, 1);
    assert.equal(calls.some((apiPath) => apiPath.includes('IsCustomizable/Value eq true')), false);
    assert.ok(snapshot.liveRefreshedExactNames.includes(target.LogicalName));
  }
  target.IsCustomizable = { Value: false };
  const changed = await createSnapshot({
    ...options, inventory: baseline.inventory, inventorySource: 'cache',
    request: createFixtureRequest(fixture, []),
  });
  assert.equal(changed.tables[0].customizable, false);
  assert.equal(changed.inventoryFacts.customizableTables, baseline.inventory.length - 1);
  const expanded = await expandSnapshot({
    snapshot: changed, proposedTableNames: [target.LogicalName],
    request: async () => assert.fail('already refreshed identity must not be loaded again'),
  });
  assert.equal(expanded.proposedNameChecks.collisions[0].existing.customizable, false);
});

test('deleted cached candidates are unavailable and malformed identity responses remain errors', async () => {
  const fixture = createScaleScenario(6, 'all-reuse');
  const options = { ...context, concepts: [fixture.concepts[0]] };
  const baseline = await createSnapshot({ ...options, request: createFixtureRequest(fixture, []) });
  const cached = { ...options, inventory: baseline.inventory, inventorySource: 'cache' };
  const snapshot = await createSnapshot({
    ...cached, request: async (_method, apiPath) => {
      assert.ok(apiPath.startsWith('EntityDefinitions?'));
      return { status: 200, data: { value: [] } };
    },
  });
  assert.deepEqual(snapshot.tables, []);
  assert.equal(snapshot.detailLoadFailures[0].status, 404);
  assert.equal(snapshot.candidateRanking[0].candidates[0].detailStatus, 'unavailable');
  assert.equal(snapshot.inventory.some((item) => item.logicalName === fixture.entities[0].LogicalName), false);
  await assert.rejects(createSnapshot({
    ...cached, request: async () => ({ status: 200, data: {} }),
  }), /OData collection/);
});

test('execution reconciliation explicitly bypasses the planning inventory cache', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'create-dataverse-snapshot.js'), 'utf8');
  assert.match(source, /inventoryCachePath && !baseSnapshot && !args\['reconcile-exact'\]/);
  assert.match(source, /if \(inventoryCachePath && !baseSnapshot && !args\['reconcile-exact'\] && !cacheRead\.hit\)/);
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
  const invalidations = skill.match(/node "\$\{PLUGIN_ROOT\}\/scripts\/dataverse-inventory-cache\.js"/g) || [];
  assert.equal(invalidations.length, 2);
  assert.doesNotMatch(skill, /CLAUDE_SKILL_DIR.*dataverse-inventory-cache/);
  assert.match(skill, /After the `publish` phase succeeds[\s\S]*dataverse-inventory-cache\.js/);
  assert.match(skill, /After a 2xx publish[\s\S]*dataverse-inventory-cache\.js/);
});

test('post-publish invalidation failures return to recovery before dependent steps', (testContext) => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills/add-dataverse/SKILL.md'), 'utf8');
  const blocks = [...skill.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)]
    .map((match) => match[1])
    .filter((block) => block.includes('/scripts/dataverse-inventory-cache.js'));
  assert.equal(blocks.length, 2);
  assert.match(skill, /at most two targeted retries\s+of the invalidation command/);
  assert.match(skill, /do not replay metadata writes or publish/);
  assert.match(skill, /Continue to Step 6c only after invalidation exits `0`/);
  const bashPaths = process.platform === 'win32'
    ? (spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)
    : [];
  const bash = bashPaths.find((entry) => /[\\/]Git[\\/]/i.test(entry)) || 'bash';
  const directory = path.dirname(tempFile(testContext));
  fs.mkdirSync(path.join(directory, '.tmp'));
  const cachePath = path.join(directory, '.tmp/dataverse-inventory-cache.json');
  const checkpointPath = path.join(directory, '.tmp/dataverse-publish-pending.json');
  const stub = `
node() {
  case "$1" in
    */dataverse-inventory-cache.js)
      if [ "$FAIL_INVALIDATION" = 1 ]; then
        printf 'injected cache deletion failure\\n' >&2
        return 2
      fi
      ;;
  esac
  "$REAL_NODE" "$@"
}
`;
  for (const block of blocks) {
    fs.writeFileSync(cachePath, '{}');
    fs.writeFileSync(checkpointPath, '{}');
    const input = `${stub}\n${block.replaceAll('<working_dir>', directory.replaceAll('\\', '/'))}\nprintf 'DEPENDENT_STEP_REACHED\\n'\n`;
    const env = { ...process.env, PLUGIN_ROOT: pluginRoot.replaceAll('\\', '/'),
      REAL_NODE: process.execPath.replaceAll('\\', '/'),
      PUBLISH_CHECKPOINT: checkpointPath.replaceAll('\\', '/'),
      POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' };
    const failed = spawnSync(bash, ['-s'], {
      input, env: { ...env, FAIL_INVALIDATION: '1' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(failed.status, 2, failed.stderr);
    assert.match(failed.stderr, /NEEDS_RECOVERY: dataverse-inventory-cache/);
    assert.doesNotMatch(failed.stdout, /DEPENDENT_STEP_REACHED/);
    assert.equal(fs.existsSync(cachePath), true);
    const recovered = spawnSync(bash, ['-s'], {
      input, env: { ...env, FAIL_INVALIDATION: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /DEPENDENT_STEP_REACHED/);
    assert.equal(fs.existsSync(cachePath), false);
  }
});

test('publish checkpoint cleanup tolerates an absent path but surfaces deletion errors', (testContext) => {
  const skill = fs.readFileSync(path.resolve(
    __dirname, '..', '..', 'skills', 'add-dataverse', 'SKILL.md',
  ), 'utf8');
  const cleanup = skill.match(/node -e "([^"]+)" \\\r?\n\s+"\$\{PUBLISH_CHECKPOINT:-\}"/);
  assert.ok(cleanup, 'checkpoint cleanup must default an unset shell variable to an empty path');

  const file = path.join(path.dirname(tempFile(testContext)), 'publish checkpoint.json');
  const runCleanup = args => spawnSync(process.execPath, ['-e', cleanup[1], ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
  fs.writeFileSync(file, '{}');
  for (const args of [[], ['']]) {
    const result = runCleanup(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = runCleanup([file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(file), false);
  }

  const failed = runCleanup([path.dirname(file)]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /EISDIR|ERR_FS_EISDIR|EPERM/);
  assert.equal(fs.existsSync(path.dirname(file)), true);
});