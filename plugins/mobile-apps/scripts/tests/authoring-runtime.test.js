'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { configureMobileAuthoring, validateAuthoringRegistry } = require('../lib/authoring-runtime');
const { localStartup } = require('../lib/prototype-startup');
const { configurePrototypeAuthoring, wrapRoot } = require('../lib/prototype-authoring');

const APP_ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const INACTIVE = Object.freeze({ protocolVersion: 2, active: false });
const ROOT = path.resolve(__dirname, '../..');
const MODULES = process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES && path.resolve(process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES);
let ts;
try { ts = MODULES ? require(path.join(MODULES, 'typescript')) : require('typescript'); } catch { /* Native JS fixtures remain independently runnable. */ }

function write(root, file, value) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
function registry() {
  return {
    schemaVersion: 1, appInstanceId: APP_ID,
    screens: [{
      screenId: 'orders', route: '/orders', sourceFile: 'app/(app)/orders.tsx',
      targets: [{ id: 'orders-list', label: 'Orders', role: 'collection', actionId: 'save-order' }],
    }, {
      screenId: 'detail', route: '/orders/[id]', sourceFile: 'app/(app)/orders/[id].tsx', targets: [],
    }],
  };
}
function project(t, installedModules) {
  const root = path.join(__dirname, `.authoring-runtime-${crypto.randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'app.json', { expo: { extra: { telemetry: { appInstanceId: APP_ID } } } });
  write(root, 'package.json', { name: 'authoring-runtime-test', private: true, dependencies: {
    expo: '55.0.29', 'expo-router': '55.0.14', react: '19.2.0', 'react-native': '0.83.6',
  } });
  write(root, '.tmp/authoring-registry.json', registry());
  write(root, '.tmp/compiled-screen-build-pack.json', {
    contractType: 'compiled-screen-build-pack',
    screens: [{ screenId: 'orders', route: '/orders' }, { screenId: 'detail', route: '/orders/[id]' }],
  });
  write(root, 'app/(app)/orders.tsx', "import { Text } from 'react-native'; export default function Orders() { return <Text>Orders</Text>; }\n");
  write(root, 'app/(app)/orders/[id].tsx', "import { Text } from 'react-native'; export default function Detail() { return <Text>Order detail</Text>; }\n");
  write(root, 'app/_layout.tsx', localStartup('/orders')['app/_layout.tsx']);
  if (installedModules) fs.symlinkSync(installedModules, path.join(root, 'node_modules'), 'dir');
  else {
    // Unit fixture for dependency-inspection failure/ownership tests, not a shipped/generated native shim.
    for (const name of ['expo', 'expo-router', 'react', 'react-native']) {
      write(root, `node_modules/${name}/package.json`, { name, version: '1.0.0', main: 'index.js' });
      write(root, `node_modules/${name}/index.js`, name === 'expo' ? 'exports.requireOptionalNativeModule = undefined;\n' : '');
    }
  }
  return root;
}

test('configurator writes importable owned helpers, inactive descriptor and no provider/data/root rewrites', (t) => {
  const root = project(t);
  const rootBefore = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  const packageBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const result = configureMobileAuthoring(root);
  assert.equal(result.status, 'configured');
  assert.equal(result.publicationReady, false);
  assert.equal(result.rootWiring.outside, 'PrototypeProvider');
  assert.equal(result.changed.length, 4);
  const projection = fs.readFileSync(path.join(root, 'src/authoring/registry.ts'), 'utf8');
  assert.doesNotMatch(projection, /sourceFile|app\/\(app\)|runtimeToken|sourcePath/);
  const index = fs.readFileSync(path.join(root, 'src/authoring/index.tsx'), 'utf8');
  assert.match(index, /requireOptionalNativeModule.*from 'expo'/);
  assert.doesNotMatch(index, /from 'expo-modules-core'|from .*generated|power\.config|from .*data\/runtime/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.devplayer-builder/runtime.json'))), { protocolVersion: 2, active: false });
  assert.equal(fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8'), rootBefore);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), packageBefore);
  assert.equal(fs.existsSync(path.join(root, 'src/data/runtime.ts')), false);
  assert.equal(configureMobileAuthoring(root, { check: true }).status, 'verified');
  const mtime = fs.statSync(path.join(root, 'src/authoring/controller.ts')).mtimeMs;
  assert.deepEqual(configureMobileAuthoring(root).changed, []);
  assert.equal(fs.statSync(path.join(root, 'src/authoring/controller.ts')).mtimeMs, mtime);
});

test('owned regeneration updates explicit metadata but never overwrites manual/unowned output', (t) => {
  const root = project(t);
  configureMobileAuthoring(root);
  const next = registry();
  next.screens[0].targets[0].label = 'Approved order cards';
  write(root, '.tmp/authoring-registry.json', next);
  assert.throws(() => configureMobileAuthoring(root, { check: true }), /stale/);
  assert.deepEqual(configureMobileAuthoring(root).changed, ['src/authoring/registry.ts']);
  const projection = fs.readFileSync(path.join(root, 'src/authoring/registry.ts'), 'utf8');
  fs.appendFileSync(path.join(root, 'src/authoring/controller.ts'), '\n// Manual app edit\n');
  next.screens[0].targets[0].label = 'Another approved name';
  write(root, '.tmp/authoring-registry.json', next);
  assert.throws(() => configureMobileAuthoring(root), /manually edited/);
  assert.equal(fs.readFileSync(path.join(root, 'src/authoring/registry.ts'), 'utf8'), projection);
  const unowned = project(t);
  write(unowned, 'src/authoring/index.tsx', 'export const manuallyOwned = true;\n');
  assert.throws(() => configureMobileAuthoring(unowned), /unowned/);
  assert.equal(fs.existsSync(path.join(unowned, 'src/authoring/controller.ts')), false);
});

test('publisher identity remains publisher-owned and credentials cannot enter the stamp', (t) => {
  const root = project(t);
  configureMobileAuthoring(root);
  const published = stamp();
  write(root, '.devplayer-builder/runtime.json', published);
  const before = fs.readFileSync(path.join(root, '.devplayer-builder/runtime.json'), 'utf8');
  configureMobileAuthoring(root);
  assert.equal(fs.readFileSync(path.join(root, '.devplayer-builder/runtime.json'), 'utf8'), before);
  write(root, '.devplayer-builder/runtime.json', { ...published, runtimeToken: 'not-permitted' });
  assert.throws(() => configureMobileAuthoring(root), /unsupported fields/);
});

test('registry requires compiled canonical app TSX routes and rejects links, escapes and invented metadata', (t) => {
  const root = project(t);
  const valid = registry();
  assert.equal(validateAuthoringRegistry(root, valid).screens.length, 2);
  for (const sourceFile of ['../outside.tsx', 'src/generated/fake.tsx', 'app/../else.tsx', 'app/_layout.tsx', 'app/(app)/missing.tsx']) {
    const value = structuredClone(valid);
    value.screens[0].sourceFile = sourceFile;
    assert.throws(() => validateAuthoringRegistry(root, value));
  }
  for (const mutate of [
    (value) => { value.appInstanceId = 'another-app'; },
    (value) => { value.screens[0].route = '/orders?record=private'; },
    (value) => { value.screens[0].screenId = 'not-compiled'; },
    (value) => { value.screens.push(value.screens[0]); },
    (value) => { value.screens[0].targets.push(value.screens[0].targets[0]); },
    (value) => { value.screens[0].targets[0].record = { private: 'data' }; },
    (value) => { value.screens[0].targets[0].role = 'guessed-table'; },
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    assert.throws(() => validateAuthoringRegistry(root, value));
  }
  const source = path.join(root, 'app/(app)/orders.tsx');
  fs.renameSync(source, path.join(root, 'owned-original.tsx'));
  fs.symlinkSync(path.join(root, 'owned-original.tsx'), source);
  assert.throws(() => validateAuthoringRegistry(root, valid), /links|regular/);
  fs.unlinkSync(source);
  fs.linkSync(path.join(root, 'owned-original.tsx'), source);
  assert.throws(() => validateAuthoringRegistry(root, valid), /unaliased|regular/);
  fs.unlinkSync(source);
  fs.renameSync(path.join(root, 'owned-original.tsx'), source);
  fs.renameSync(path.join(root, 'app.json'), path.join(root, 'identity.json'));
  fs.symlinkSync(path.join(root, 'identity.json'), path.join(root, 'app.json'));
  assert.throws(() => validateAuthoringRegistry(root, valid), /unaliased|regular/);
});

test('CLI verifies generated files without changing source or pretending publication succeeded', (t) => {
  const root = project(t);
  const command = path.join(ROOT, 'scripts/configure-mobile-authoring.js');
  const options = { encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' } };
  const configured = spawnSync(process.execPath, [command, '--project-root', root], options);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(JSON.parse(configured.stdout).publicationReady, false);
  const checked = spawnSync(process.execPath, [command, '--project-root', root, '--check'], options);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).status, 'verified');
});

function controllerExports() {
  const filename = path.join(ROOT, 'scripts/templates/mobile-authoring/controller.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output, filename);
  return compiled.exports;
}
function stamp(kind = 'active', dataNamespace = kind === 'active' ? 'active' : 'candidate:job-one') {
  return { protocolVersion: 2, appInstanceId: APP_ID, jobId: 'published-one', previewRevision: HASH,
    previewKind: kind, dataNamespace, ...(kind === 'candidate' ? { baseDataNamespace: 'active' } : {}) };
}
function harness(options = {}) {
  const projection = registry();
  projection.screens = projection.screens.map(({ sourceFile, ...screen }) => screen);
  const source = options.stamp ?? stamp();
  const association = { ...stamp(), bridgeUrl: 'http://localhost:8787', ...(options.association ?? {}) };
  const trace = [];
  const scheduled = [];
  const native = {
    getCurrentSession: async () => { trace.push(['current']); return { authoring: association }; },
    getAuthoringCapabilities: async () => ({ protocolVersion: 2, context: true, selection: true, handoff: true, revisionAcknowledgement: true }),
    getDiagnostics: async () => ({ isRunningDevSession: true, currentSession: { authoring: association }, authoring: { authenticated: true } }),
    registerAuthoringContext: async (context, targets) => { trace.push(['register', structuredClone(context), structuredClone(targets)]); return { available: true }; },
    reportAuthoringReady: async (payload) => { trace.push(['ack', structuredClone(payload)]); return { available: true, acknowledged: true }; },
    clearAuthoringContext: async (screenId) => { trace.push(['clear', screenId]); return { available: true }; },
    ...(options.native ?? {}),
  };
  const runtime = controllerExports().createAuthoringRuntime({
    registry: projection, stamp: source,
    getNativeModule: options.getNativeModule ?? (() => native),
    configureDataPreview: options.configure ?? ((preview) => { trace.push(['configure', structuredClone(preview)]); }),
    schedule: (work) => scheduled.push(work),
  });
  async function flush() {
    while (scheduled.length) scheduled.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.settled();
  }
  return { runtime, trace, native, source, association, flush };
}
const requiresTs = { skip: !ts && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to existing template dependencies for TypeScript runtime traces' };

test('prototype configurator compiles explicit screen metadata and wraps data consumers before building', requiresTs, (t) => {
  const root = project(t, MODULES);
  if (!MODULES) fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(root, 'node_modules/typescript'), 'dir');
  write(root, 'tsconfig.json', { compilerOptions: { paths: { '@/data': ['src/data'] } } });
  const before = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  const skeletons = configurePrototypeAuthoring(root);
  assert.equal(skeletons.rootWired, true);
  assert.equal(skeletons.publicationReady, false);
  assert.deepEqual(skeletons.readyScreenIds, []);
  const layout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  assert.match(layout, /return <AuthoringProvider configureDataPreview=\{configureDataPreview\}><RootLayout \/><\/AuthoringProvider>/);
  assert.ok(layout.includes(before.replace('export default function', '  function')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'))).compilerOptions.paths, {
    '@/data': ['src/data'], '@/authoring': ['src/authoring'], '@/authoring/*': ['src/authoring/*'],
  });
  assert.throws(() => configurePrototypeAuthoring(root, { readyScreenIds: ['orders'], check: true }), /Screen must export its explicit const authoringTargets array/);
  const file = 'app/(app)/orders.tsx';
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  write(root, file, `${source}\nexport const authoringTargets = [{ id: 'orders-list', label: 'Orders', role: 'collection' }] as const;\n`);
  assert.throws(() => configurePrototypeAuthoring(root, { readyScreenIds: ['orders'], check: true }), /missing\/stale/);
  configurePrototypeAuthoring(root, { readyScreenIds: ['orders'] });
  assert.equal(configurePrototypeAuthoring(root, { readyScreenIds: ['orders'], check: true }).rootWired, true);
  assert.equal(fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8'), layout);
  const projection = JSON.parse(fs.readFileSync(path.join(root, '.tmp/authoring-registry.json')));
  assert.deepEqual(projection.screens.find((screen) => screen.screenId === 'orders').targets, [
    { id: 'orders-list', label: 'Orders', role: 'collection' },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.devplayer-builder/runtime.json'))), INACTIVE);
});

test('authoring metadata never executes getters, dynamic expressions, or guessed routes', requiresTs, (t) => {
  const root = project(t, MODULES);
  if (!MODULES) fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(root, 'node_modules/typescript'), 'dir');
  write(root, 'tsconfig.json', {});
  const file = 'app/(app)/orders.tsx';
  for (const metadata of [
    '[{ get id() { throw new Error("must not execute"); } }]',
    '[{ ...globalThis }]',
    'globalThis.makeTargets()',
    '[{ id: "target", label: "Orders", role: "collection", record: "private" }]',
  ]) {
    write(root, file, `export const authoringTargets = ${metadata}; export default function Orders() { return null; }\n`);
    assert.throws(() => configurePrototypeAuthoring(root, { readyScreenIds: ['orders'] }), /literal|metadata|unsupported/);
  }
  write(root, file, 'export const authoringTargets = []; export default function Orders() { return null; }\n');
  assert.throws(() => configurePrototypeAuthoring(root, { readyScreenIds: ['unknown'] }), /unique members/);
  write(root, 'app/orders.tsx', 'export default function Duplicate() { return null; }\n');
  configurePrototypeAuthoring(root);
  const bound = JSON.parse(fs.readFileSync(path.join(root, '.tmp/authoring-registry.json')));
  assert.equal(bound.screens.find((screen) => screen.screenId === 'orders').sourceFile, file);
  fs.rmSync(path.join(root, file));
  assert.throws(() => configurePrototypeAuthoring(root), /source|target|file|ENOENT/i);
});

test('authoring root cannot be bypassed by a dead wrapper or overwrite a custom root', requiresTs, () => {
  const source = localStartup('/orders')['app/_layout.tsx'];
  const wired = wrapRoot(ts, source);
  assert.equal(wrapRoot(ts, wired), wired);
  assert.throws(() => wrapRoot(ts, wired.replace('export default function MobileAuthoringRoot', 'function MobileAuthoringRoot')
    + '\nexport default function Bypass() { return <RootLayout />; }\n'), /actual application root/);
  assert.throws(() => wrapRoot(ts, source.replace('function RootLayout()', 'function RootLayout(props: unknown)')), /without parameters/);
});

test('data selection completes before repository consumers and is not reset on foreground return', requiresTs, async () => {
  let release;
  const order = [];
  const h = harness({ configure: async (selection) => {
    order.push(['configure', selection]);
    await new Promise((resolve) => { release = resolve; });
  } });
  const initializing = h.runtime.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.runtime.getSnapshot().phase, 'checking');
  assert.equal(order[0][0], 'configure');
  release();
  await initializing;
  if (h.runtime.getSnapshot().phase === 'active') order.push(['repository-hooks']);
  assert.deepEqual(order.map((entry) => entry[0]), ['configure', 'repository-hooks']);
  await h.runtime.resume();
  assert.equal(order.filter((entry) => entry[0] === 'configure').length, 1);
  assert.equal(h.trace.some((entry) => entry[0] === 'ack'), false);
});

test('StrictMode/background interruption restarts authentication instead of leaving an obsolete initialization cached', requiresTs, async () => {
  let release;
  let reads = 0;
  const h = harness({ native: { getCurrentSession: async () => {
    if (++reads === 1) await new Promise((resolve) => { release = resolve; });
    return { authoring: { ...stamp(), bridgeUrl: 'http://localhost:8787' } };
  } } });
  const first = h.runtime.resume();
  await new Promise((resolve) => setImmediate(resolve));
  h.runtime.pause();
  const remount = h.runtime.resume();
  release();
  await Promise.all([first, remount]);
  assert.equal(h.runtime.getSnapshot().phase, 'active');
  assert.equal(reads, 2);
  assert.equal(h.trace.filter((entry) => entry[0] === 'configure').length, 1);
  const absent = harness({ stamp: INACTIVE, getNativeModule: () => { throw new Error('optional module unavailable'); } });
  assert.equal((await absent.runtime.initialize()).phase, 'standalone');
  assert.equal((await absent.runtime.initialize()).phase, 'standalone');
});

test('absent native APIs and old persisted association never enable authoring or change standalone defaults', requiresTs, async () => {
  const absent = harness({ stamp: INACTIVE, getNativeModule: () => null });
  assert.equal((await absent.runtime.initialize()).phase, 'standalone');
  assert.equal(absent.trace.some((entry) => entry[0] === 'configure'), false);
  assert.equal(absent.runtime.focusScreen('orders'), null);
  const persisted = harness({ stamp: INACTIVE, native: {
    getCurrentSession: async () => null,
    getBuilderSessionAssociation: async () => { throw new Error('Must never use persisted association to activate'); },
  } });
  assert.equal((await persisted.runtime.initialize()).phase, 'standalone');
  assert.equal(persisted.trace.some((entry) => entry[0] === 'configure'), false);
  const old = harness({ native: { getDiagnostics: undefined } });
  assert.equal((await old.runtime.initialize()).phase, 'blocked');
  assert.equal(old.trace.some((entry) => entry[0] === 'configure'), false);
});

test('published active and candidate stamps cannot fall through to local defaults without a current native session', requiresTs, async () => {
  for (const kind of ['active', 'candidate']) {
    const source = stamp(kind);
    for (const options of [
      { getNativeModule: () => null },
      { native: { getCurrentSession: undefined } },
      { native: { getCurrentSession: async () => null } },
      { native: { getCurrentSession: async () => ({ name: 'Ordinary non-builder session' }) } },
      { native: {
        getCurrentSession: async () => null,
        getBuilderSessionAssociation: async () => { throw new Error('Persisted association is not authentication'); },
      } },
    ]) {
      const h = harness({ stamp: source, association: source, ...options });
      assert.equal((await h.runtime.initialize()).phase, 'blocked');
      assert.equal(h.trace.some((entry) => entry[0] === 'configure' || entry[0] === 'ack'), false);
      assert.equal(h.runtime.focusScreen('orders'), null);
    }
  }
});

test('wrong app/job/source/kind, uninstrumented source and unauthenticated sessions fail before data configuration', requiresTs, async () => {
  for (const change of [
    { appInstanceId: 'another-app' }, { jobId: 'new-edit-job' }, { previewRevision: 'b'.repeat(64) }, { previewKind: 'candidate' },
  ]) {
    const h = harness({ association: change });
    assert.equal((await h.runtime.initialize()).phase, 'blocked');
    assert.equal(h.trace.some((entry) => entry[0] === 'configure'), false);
  }
  const inactive = harness({ stamp: { protocolVersion: 2, active: false } });
  assert.equal((await inactive.runtime.initialize()).phase, 'blocked');
  const unauthenticated = harness({ native: { getDiagnostics: async () => ({ isRunningDevSession: true, authoring: { authenticated: false } }) } });
  assert.equal((await unauthenticated.runtime.initialize()).phase, 'blocked');
  assert.equal(unauthenticated.trace.some((entry) => entry[0] === 'configure'), false);
});

test('active/candidate data stays isolated, uses publisher namespaces and refuses namespace changes without reload', requiresTs, async () => {
  const candidate = stamp('candidate', 'candidate:job-one');
  const h = harness({ stamp: candidate, association: candidate });
  await h.runtime.initialize();
  assert.deepEqual(h.trace.find((entry) => entry[0] === 'configure')[1],
    { previewKind: 'candidate', dataNamespace: 'candidate:job-one', baseDataNamespace: 'active' });
  h.source.dataNamespace = 'candidate:other-job';
  await h.runtime.resume();
  assert.equal(h.runtime.getSnapshot().phase, 'blocked');
  assert.equal(h.runtime.getSnapshot().issue.code, 'reload-required');
  assert.equal(h.trace.filter((entry) => entry[0] === 'configure').length, 1);
  const { readSourceStamp } = controllerExports();
  assert.throws(() => readSourceStamp(stamp('candidate', 'active'), APP_ID), /isolated/);
  assert.throws(() => readSourceStamp({ ...stamp(), runtimeToken: 'forbidden' }, APP_ID), /invalid/);
  assert.throws(() => readSourceStamp(stamp('candidate', '../active'), APP_ID), /invalid/);
});

test('only actual usable focused screen layout registers then acknowledges the originating source', requiresTs, async () => {
  const h = harness();
  await h.runtime.initialize();
  const lease = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(lease, { ready: true, hasUnsavedChanges: true });
  h.runtime.attachTarget(lease, 'orders-list', async () => ({ x: 12, y: 24, width: 300, height: 420 }),
    { conceptId: 'orders', recordId: 'order-one', label: 'Order one' });
  await h.flush();
  assert.equal(h.trace.some((entry) => entry[0] === 'ack'), false);
  h.runtime.screenLayout(lease, 320, 640);
  await h.flush();
  const ackIndex = h.trace.findIndex((entry) => entry[0] === 'ack');
  assert.ok(ackIndex > 0);
  const lastRegistration = h.trace.slice(0, ackIndex).filter((entry) => entry[0] === 'register').at(-1);
  assert.equal(lastRegistration[1].jobId, 'published-one');
  assert.equal(lastRegistration[1].hasUnsavedChanges, true);
  assert.equal(lastRegistration[1].route, '/orders');
  assert.deepEqual(lastRegistration[2][0].bounds, { x: 12, y: 24, width: 300, height: 420 });
  assert.equal(lastRegistration[2][0].actionId, 'save-order');
  assert.equal(lastRegistration[2][0].recordRef.recordId, 'order-one');
  assert.deepEqual(h.trace[ackIndex][1], { protocolVersion: 2, appInstanceId: APP_ID,
    jobId: 'published-one', previewRevision: HASH, screenId: 'orders' });
  assert.equal(h.runtime.getSnapshot().acknowledgedScreenId, 'orders');
  h.runtime.remeasure(lease);
  await h.flush();
  assert.equal(h.trace.filter((entry) => entry[0] === 'ack').length, 1);
});

test('late target measurement/cleanup cannot replace a newer screen or its geometry', requiresTs, async () => {
  const h = harness();
  await h.runtime.initialize();
  const old = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(old, { ready: true, hasUnsavedChanges: false });
  h.runtime.screenLayout(old, 320, 640);
  let release;
  const remove = h.runtime.attachTarget(old, 'orders-list', () => new Promise((resolve) => { release = resolve; }));
  await h.flush();
  const next = h.runtime.focusScreen('detail');
  h.runtime.setScreenState(next, { ready: true, hasUnsavedChanges: false });
  h.runtime.screenLayout(next, 320, 640);
  remove();
  h.runtime.blurScreen(old);
  release({ x: 0, y: 0, width: 100, height: 100 });
  await h.flush();
  assert.deepEqual(h.trace.filter((entry) => entry[0] === 'ack').map((entry) => entry[1].screenId), ['detail']);
  assert.equal(h.trace.filter((entry) => entry[0] === 'register' && entry[2].length).length, 0);
  assert.equal(h.trace.some((entry) => entry[0] === 'clear' && entry[1] === 'detail'), false);
});

test('unknown screens revoke the prior context and same-screen stale cleanup preserves the current lease', requiresTs, async () => {
  const h = harness();
  await h.runtime.initialize();
  const old = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(old, { ready: true, hasUnsavedChanges: false });
  h.runtime.screenLayout(old, 320, 640);
  await h.flush();
  assert.equal(h.runtime.focusScreen('not-authored'), null);
  await h.flush();
  assert.equal(h.trace.at(-1)[0], 'clear');
  assert.equal(h.trace.at(-1)[1], 'orders');
  assert.equal(h.runtime.getSnapshot().issue.code, 'unknown-screen');
  const replacement = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(replacement, { ready: true, hasUnsavedChanges: false });
  h.runtime.screenLayout(replacement, 320, 640);
  await h.flush();
  const marker = h.trace.length;
  h.runtime.blurScreen(old);
  await h.flush();
  assert.equal(h.trace.length, marker);
});

test('scroll/orientation invalidation clears bounds and dirty state survives foreground remeasurement', requiresTs, async () => {
  const h = harness();
  await h.runtime.initialize();
  const lease = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(lease, { ready: true, hasUnsavedChanges: true });
  h.runtime.screenLayout(lease, 320, 640);
  let y = 100;
  h.runtime.attachTarget(lease, 'orders-list', async () => ({ x: 0, y, width: 300, height: 40 }));
  await h.flush();
  const marker = h.trace.length;
  y = 20;
  h.runtime.remeasure(lease);
  await h.flush();
  const updates = h.trace.slice(marker).filter((entry) => entry[0] === 'register');
  assert.equal(updates[0][2].length, 0);
  assert.equal(updates.at(-1)[2][0].bounds.y, 20);
  assert.equal(updates.at(-1)[1].hasUnsavedChanges, true);
  h.runtime.pause();
  h.runtime.remeasure(lease);
  const count = h.trace.length;
  await h.flush();
  assert.equal(h.trace.length, count);
  await h.runtime.resume();
  await h.flush();
  assert.equal(h.trace.filter((entry) => entry[0] === 'configure').length, 1);
  assert.equal(h.trace.filter((entry) => entry[0] === 'register').at(-1)[1].hasUnsavedChanges, true);
});

test('slow bridge ACK cannot hold stale geometry or create overlapping acknowledgement requests', requiresTs, async () => {
  let accept;
  let requests = 0;
  const h = harness({ native: { reportAuthoringReady: async () => {
    requests++;
    return new Promise((resolve) => { accept = resolve; });
  } } });
  await h.runtime.initialize();
  const lease = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(lease, { ready: true, hasUnsavedChanges: true });
  h.runtime.screenLayout(lease, 320, 640);
  let x = 0;
  h.runtime.attachTarget(lease, 'orders-list', async () => ({ x, y: 12, width: 100, height: 50 }));
  await h.flush();
  assert.equal(requests, 1);
  const marker = h.trace.length;
  x = 200;
  h.runtime.remeasure(lease);
  await h.flush();
  const registrations = h.trace.slice(marker).filter((entry) => entry[0] === 'register');
  assert.equal(registrations[0][2].length, 0);
  assert.equal(registrations.at(-1)[2][0].bounds.x, 200);
  assert.equal(requests, 1);
  assert.equal(h.runtime.getSnapshot().acknowledgedScreenId, null);
  accept({ available: true, acknowledged: true });
  await h.flush();
  assert.equal(h.runtime.getSnapshot().acknowledgedScreenId, 'orders');
});

test('registration unavailable prevents ACK and explicit retry can recover without resetting data', requiresTs, async () => {
  let available = false;
  const h = harness({ native: { registerAuthoringContext: async () => ({ available }) } });
  await h.runtime.initialize();
  const lease = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(lease, { ready: true, hasUnsavedChanges: false });
  h.runtime.screenLayout(lease, 320, 640);
  await h.flush();
  assert.equal(h.trace.some((entry) => entry[0] === 'ack'), false);
  assert.equal(h.runtime.getSnapshot().issue.code, 'registration-unavailable');
  available = true;
  await h.runtime.retry();
  await h.flush();
  assert.equal(h.runtime.getSnapshot().acknowledgedScreenId, 'orders');
  assert.equal(h.trace.filter((entry) => entry[0] === 'configure').length, 1);
});

test('unmeasurable targets are explicitly unavailable while genuine generic screen readiness may be acknowledged', requiresTs, async () => {
  const h = harness();
  await h.runtime.initialize();
  const lease = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(lease, { ready: true, hasUnsavedChanges: false });
  h.runtime.screenLayout(lease, 320, 640);
  let geometry = { x: Infinity, y: 0, width: 100, height: 40 };
  h.runtime.attachTarget(lease, 'orders-list', async () => geometry);
  h.runtime.attachTarget(lease, 'orders-list', async () => ({ x: 0, y: 0, width: 200, height: 80 }));
  await h.flush();
  assert.equal(h.runtime.getSnapshot().acknowledgedScreenId, 'orders');
  assert.equal(h.runtime.getSnapshot().issue.code, 'measurement-unavailable');
  assert.equal(h.trace.filter((entry) => entry[0] === 'register').at(-1)[2].length, 0);
  geometry = { x: -10, y: 0, width: 100, height: 40 };
  h.runtime.remeasure(lease);
  await h.flush();
  assert.equal(h.runtime.getSnapshot().issue, null);
  assert.equal(h.trace.filter((entry) => entry[0] === 'register').at(-1)[2][0].bounds.x, -10);
});

test('unregistered/duplicate targets, full records and failed ACK never become successful targeting/readiness', requiresTs, async () => {
  const h = harness({ native: { reportAuthoringReady: async () => { throw new Error('private-token-record-details'); } } });
  await h.runtime.initialize();
  const lease = h.runtime.focusScreen('orders');
  h.runtime.setScreenState(lease, { ready: true, hasUnsavedChanges: false });
  h.runtime.screenLayout(lease, 320, 640);
  h.runtime.attachTarget(lease, 'not-authored', async () => ({ x: 0, y: 0, width: 100, height: 100 }));
  h.runtime.attachTarget(lease, 'orders-list', async () => ({ x: 0, y: 0, width: 100, height: 100 }),
    { conceptId: 'orders', recordId: 'one', photo: 'never-captured' });
  await h.flush();
  assert.equal(h.runtime.getSnapshot().acknowledgedScreenId, null);
  assert.ok(h.runtime.getSnapshot().issue);
  assert.doesNotMatch(JSON.stringify(h.runtime.getSnapshot()), /private-token|record-details/);
  assert.equal(h.trace.filter((entry) => entry[0] === 'register' && entry[2].length).length, 0);
});

test('generated helpers type-check against existing template packages and pass source gates', {
  skip: !MODULES && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to an already installed template node_modules',
}, (t) => {
  const root = project(t, MODULES);
  configureMobileAuthoring(root);
  // Only authoring source is selected: no fake generated service, auth/config or provider is introduced.
  write(root, 'tsconfig.authoring.json', {
    extends: 'expo/tsconfig.base', compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
    include: ['src/authoring/**/*.ts', 'src/authoring/**/*.tsx'],
  });
  const compiled = spawnSync(process.execPath, [path.join(MODULES, 'typescript/lib/tsc.js'), '--project', 'tsconfig.authoring.json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const validated = spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-mobile-files.js'), '--project-root', root,
    '--file', 'src/authoring/index.tsx', '--file', 'src/authoring/controller.ts', '--file', 'src/authoring/registry.ts'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
});
