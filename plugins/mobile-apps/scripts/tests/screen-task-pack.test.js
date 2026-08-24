'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  revisionForPack,
  screenTaskPacks,
  writeScreenTaskPacks,
} = require('../compile-screen-build-pack');
const { validateScreenTaskDirectory, validateScreenTaskPack } = require('../validate-screen-task-pack');

function buildPack() {
  const operation = {
    id: 'list-products', kind: 'list', entity: 'Product', domainOperation: 'listProducts',
    repository: 'CatalogRepository', repositoryMethod: 'listProducts', hook: 'useProducts',
    select: ['id', 'name'], filter: [], sort: [], pagination: { mode: 'bounded', boundedReason: 'Two fixture products.', maximumExpectedCount: 2 }, routeBindings: [],
  };
  const screen = {
    id: 'Home', route: '/home', file: 'app/home.tsx', headerMode: 'root',
    navigation: { kind: 'stack-root', intent: 'replace' },
    data: {
      adapter: 'mock-repository', sourceModule: '@/data', domainModel: '.tmp/prototype-domain-model.json',
      entities: ['Product'], hooks: ['useProducts'], operations: [operation], fixtureScenarios: ['catalog-populated'],
      runtimeBindings: { canonicalRecord: { mapper: 'domain-record', stableId: 'id' } },
    },
  };
  const pack = {
    schemaVersion: 2,
    sources: { domainModel: 'a'.repeat(64) },
    experience: { audience: 'Passenger', primaryJob: 'Browse products' },
    design: { tokensPath: 'brand/tokens.ts', recipe: {}, primitives: [] },
    shell: { safeAreaOwner: 'screen', rootSafeAreaProviderOnly: true },
    execution: { requirementIds: [], nativeCapabilities: [], javascriptDependencies: [], connectorOperations: [] },
    screens: [screen],
  };
  pack.revision = revisionForPack(pack);
  return pack;
}

test('screen task packs are deterministic and bind one screen file', () => {
  const pack = buildPack();
  const [first] = screenTaskPacks(pack);
  const [second] = screenTaskPacks(pack);
  assert.deepEqual(first, second);
  assert.equal(first.packRevision, pack.revision);
  assert.deepEqual(first.target, { screenId: 'Home', route: '/home', file: 'app/home.tsx' });
  assert.deepEqual(first.data.hooks, ['useProducts']);
  assert.deepEqual(validateScreenTaskPack(first, pack), []);
});

test('screen task directory removes stale tasks and detects content drift', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-task-pack-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '.tmp', 'screen-tasks');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'Stale.json'), '{}\n');
  const pack = buildPack();
  writeScreenTaskPacks(root, pack);
  assert.equal(fs.existsSync(path.join(directory, 'Stale.json')), false);
  assert.deepEqual(validateScreenTaskDirectory(root, pack), []);

  const taskPath = path.join(directory, 'Home.json');
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  task.screen.file = 'app/other.tsx';
  fs.writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`);
  const rules = new Set(validateScreenTaskDirectory(root, pack).map((issue) => issue.rule));
  assert.ok(rules.has('screen-task-revision-drift'));
  assert.ok(rules.has('screen-task-content-drift'));
});

test('screen task directory restores the previous revision after replacement failure', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-task-rollback-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pack = buildPack();
  writeScreenTaskPacks(root, pack);
  const taskPath = path.join(root, '.tmp', 'screen-tasks', 'Home.json');
  const previous = fs.readFileSync(taskPath, 'utf8');
  const changed = structuredClone(pack);
  changed.experience.primaryJob = 'Browse a changed catalog';
  changed.revision = revisionForPack(changed);

  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (String(source).includes('.screen-tasks.stage-') && String(target).endsWith(path.join('.tmp', 'screen-tasks'))) throw new Error('forced task replacement failure');
    return renameSync(source, target);
  };
  try {
    assert.throws(() => writeScreenTaskPacks(root, changed), /forced task replacement failure/);
  } finally {
    fs.renameSync = renameSync;
  }

  assert.equal(fs.readFileSync(taskPath, 'utf8'), previous);
  assert.equal(fs.readdirSync(path.join(root, '.tmp')).some((name) => /^\.screen-tasks\.(?:stage|backup)-/.test(name)), false);
});