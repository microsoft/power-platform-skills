'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const http = require('node:http');
const test = require('node:test');
const { preparePrototype, checkPrototypeTemplate } = require('../prepare-prototype');
const { generatePrototype } = require('../lib/prototype-generator');
const { compilePersistenceContract } = require('../compile-persistence-contract');
const { projectDataAccess, validateDataAccess } = require('../lib/prototype-registry');
const { revision, writeOwnedFiles } = require('../lib/prototype-files');
const { sha256Hex } = require('../lib/product-experience-contracts');
const { generateDataverseRepositories, stageConnectedStartup } = require('../lib/dataverse-repository-generator');
const { activateConnectedData } = require('../lib/prototype-activation');
const { bindPrototypeIdentity } = require('../bind-prototype-identity');
const { verifyNativeProject } = require('../verify-prototype-native');
const { refreshPrototypeRules, planPrototypeRules, generatePrototypeRules } = require('../lib/prototype-rules');
const { generateRulesRuntime } = require('../lib/authoring-rules');
const { readConnectionCatalog } = require('../lib/prototype-connections');
const { verifyConnectionProject } = require('../verify-prototype-connection');
const sharedSource = require('../lib/authoring-source');
const { configurePrototypeAuthoring } = require('../lib/prototype-authoring');

const pluginRoot = path.resolve(__dirname, '../..');
const templateResolver = {
  resolve: (name) => name,
  loadConfig: () => ({ compilerOptions: { baseUrl: '${configDir}', paths: { '@/components': ['src/components'] } } }),
};
function write(root, name, value) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
}
function validateSource(root) {
  const result = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/validate-mobile-files.js'), '--project-root', root, '--all-source'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
function instrumentHome(root) {
  write(root, 'app/(app)/home.tsx', `import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useEntityList } from '@/data';
import { useAuthoringScreen, useAuthoringTarget } from '@/authoring';
export const authoringTargets = [{ id: 'appointments', label: 'Appointments', role: 'collection' }] as const;
export default function Home() {
  const query = useEntityList('Appointment');
  const screen = useAuthoringScreen('home', { ready: !query.isPending, hasUnsavedChanges: false });
  const target = useAuthoringTarget('appointments', { screen });
  return <SafeAreaView collapsable={false} style={{ flex: 1 }} onLayout={screen.onLayout}>
    <ScrollView onScroll={screen.onScroll} scrollEventThrottle={16}>
      <View ref={target.ref} collapsable={false} onLayout={target.onLayout}>
        <Text>{query.isPending ? 'Loading appointments' : query.isError ? 'Appointments unavailable' : query.data.items.map((item) => item.title).join(', ')}</Text>
      </View>
    </ScrollView>
  </SafeAreaView>;
}
`);
  write(root, '.tmp/compiled-screen-build-pack.json', { contractType: 'compiled-screen-build-pack', screens: [{ screenId: 'home', route: '/home' }] });
  const configured = spawnSync(process.execPath, [
    path.join(pluginRoot, 'scripts/configure-prototype-authoring.js'),
    '--project-root', root, '--ready-screen', 'home', '--wire-screen', 'home',
    '--screen-source', 'home=app/(app)/home.tsx',
  ], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(configured.status, 0, `${configured.stdout}\n${configured.stderr}`);
  assert.equal(JSON.parse(configured.stdout).rootWired, true);
  assert.deepEqual(JSON.parse(configured.stdout).wiredScreenIds, ['home']);
  const wired = fs.readFileSync(path.join(root, 'app/(app)/home.tsx'), 'utf8');
  for (const callback of ['onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd']) {
    assert.match(wired, new RegExp(`${callback}=\\{screen.onScroll\\}`));
  }
  assert.equal(configurePrototypeAuthoring(root, { check: true, readyScreenIds: ['home'], wireScreenIds: ['home'] }).rootWired, true);
}
function project(t, modules, { nativeCapabilities = [] } = {}) {
  const root = path.join(path.resolve(__dirname, '../../../..'), `.prototype-generation-work-${crypto.randomUUID()}`);
  fs.cpSync(path.join(pluginRoot, 'template'), root, { recursive: true, filter: (file) => !file.includes(`${path.sep}node_modules`) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (modules) fs.symlinkSync(modules, path.join(root, 'node_modules'), 'dir');
  else fs.mkdirSync(path.join(root, 'node_modules/expo'), { recursive: true });
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));
  app.expo.extra.telemetry = { appInstanceId: '22222222-2222-4222-8222-222222222222' };
  write(root, 'app.json', app);
  const scope = { dataEntities: [{ name: 'Appointment', role: 'primary', realization: 'local-configuration' }] };
  const persistence = compilePersistenceContract(scope, {
    schemaVersion: 1, connectors: [], nativeCapabilities,
    conceptOwners: [{ conceptId: 'appointment', owner: 'local', reason: 'Appointments are local prototype records.' }],
  });
  const facts = {
    schemaVersion: 1, contractType: 'scenario-facts', scopeRevision: persistence.scopeRevision,
    persistenceRevision: persistence.persistenceRevision,
    records: [{ id: 'appointment-one', conceptId: 'appointment', fields: { title: 'Consultation', startsAt: '2026-09-07T09:00:00Z' } }],
    relationships: [], scenarios: [], mediaAssets: [], screenBindings: [], invariants: [],
  };
  facts.scenarioRevision = revision(facts);
  write(root, '.tmp/prototype-domain.json', {
    schemaVersion: 1, appInstanceId: app.expo.extra.telemetry.appInstanceId, schemaVersionNumber: 1,
    entities: [{ id: 'Appointment', label: 'Appointment',
      fields: [{ id: 'title', label: 'Title', type: 'text', required: true }, { id: 'startsAt', label: 'Starts at', type: 'datetime' }],
      operations: ['list', 'get', 'create', 'update', 'delete'],
    }], actions: [{ id: 'saveAppointment', label: 'Save', entityId: 'Appointment', operation: 'save' }],
  });
  write(root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [{ entityId: 'Appointment', conceptId: 'appointment' }] });
  write(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
  write(root, '.tmp/persistence-contract.json', persistence);
  write(root, '.tmp/scenario-facts.json', facts);
  write(root, '.tmp/navigation-manifest.json', { screens: { home: { targetPath: '/home' } } });
  write(root, 'native-app-plan.md', '# Already approved plan\n');
  return root;
}

test('real local preparation bypasses missing live imports without creating official generated files', (t) => {
  const root = project(t);
  const packageBefore = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const authBefore = fs.readFileSync(path.join(root, 'auth.config.json'), 'utf8');
  const lockPath = path.join(root, 'package-lock.json');
  const lockBefore = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  write(root, 'src/generated/owned.txt', 'Official bytes must not change\n');
  const options = { displayName: 'Appointment prototype', slug: 'appointment-prototype', entryRoute: '/home', ...templateResolver };
  preparePrototype(root, options);
  const packageAfter = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.deepEqual(packageAfter.dependencies, packageBefore.dependencies);
  assert.deepEqual(packageAfter.devDependencies, packageBefore.devDependencies);
  assert.equal(packageAfter.version, packageBefore.version);
  assert.equal(packageAfter.scripts.predev, 'npm run generate-schemas');
  assert.equal(packageAfter.scripts['dev:prototype'], 'expo start');
  assert.equal(fs.existsSync(path.join(root, 'power.config.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/connectorSchemas.ts')), false);
  assert.equal(fs.readFileSync(path.join(root, 'src/generated/owned.txt'), 'utf8'), 'Official bytes must not change\n');
  assert.equal(fs.readFileSync(path.join(root, 'auth.config.json'), 'utf8'), authBefore);
  if (lockBefore !== null) assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBefore);
  assert.match(fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8'), /PrototypeProvider/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8'), /PowerAppsProvider|power\.config|generated/);
  assert.equal(fs.existsSync(path.join(root, 'app/login.tsx')), false);
  assert.equal(fs.existsSync(path.join(root, 'app/oauth-callback.tsx')), false);
  assert.match(fs.readFileSync(path.join(root, 'src/data/rules.ts'), 'utf8'), /assertEntityRules/);
  assert.match(fs.readFileSync(path.join(root, 'src/data/hooks.ts'), 'utf8'), /networkMode: 'always'/);
  assert.equal(generatePrototype(root, { check: true }).ok, true);
  assert.equal(preparePrototype(root, options).resumed, true);
});

test('screen wiring is an explicit scoped generation action, not an additional mandatory TSX quality gate', {
  skip: !process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES,
}, (t) => {
  const root = project(t, process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES);
  preparePrototype(root, { displayName: 'Screen wiring prototype', slug: 'screen-wiring', entryRoute: '/home' });
  const skeleton = `import { Text, View } from 'react-native';
export const authoringTargets = [] as const;
export default function Screen() { return <View><Text>Building this screen</Text></View>; }
`;
  write(root, 'app/(app)/home.tsx', skeleton);
  write(root, 'app/(app)/details.tsx', skeleton);
  write(root, '.tmp/compiled-screen-build-pack.json', {
    contractType: 'compiled-screen-build-pack',
    screens: [{ screenId: 'home', route: '/home' }, { screenId: 'details', route: '/details' }],
  });
  const sources = [
    { screenId: 'home', sourceFile: 'app/(app)/home.tsx' },
    { screenId: 'details', sourceFile: 'app/(app)/details.tsx' },
  ];
  const configured = configurePrototypeAuthoring(root, { screenSources: sources });
  assert.deepEqual(configured.wiredScreenIds, []);
  assert.equal(configured.publicationReady, false);
  assert.equal(fs.readFileSync(path.join(root, sources[0].sourceFile), 'utf8'), skeleton);
  assert.throws(() => configurePrototypeAuthoring(root, { wireScreenIds: ['unknown'] }), /Explicit wiring targets/);
  assert.throws(() => configurePrototypeAuthoring(root, { wireScreenIds: ['home', 'home'] }), /Explicit wiring targets/);
  assert.equal(configurePrototypeAuthoring(root, { wireScreenIds: ['home'] }).rootWired, true);
  const output = fs.readFileSync(path.join(root, sources[0].sourceFile), 'utf8');
  assert.match(output, /useAuthoringScreen as useMobileScreenAuthoring/);
  assert.match(output, /ready: false, hasUnsavedChanges: false/);
  assert.match(output, /onLayout=\{mobileAuthoringScreen.onLayout\}/);
  assert.equal(fs.readFileSync(path.join(root, sources[1].sourceFile), 'utf8'), skeleton);
  assert.equal(configurePrototypeAuthoring(root, { check: true, wireScreenIds: ['home'] }).ok, true);
  const before = sharedSource.captureSource(root).sourceRevision;
  assert.throws(() => configurePrototypeAuthoring(root, { wireScreenIds: ['home'], readyScreenIds: ['home'] }), /unready skeleton/);
  assert.equal(sharedSource.captureSource(root).sourceRevision, before);
  const custom = output.replace(' onLayout={mobileAuthoringScreen.onLayout}', '');
  write(root, sources[0].sourceFile, custom);
  assert.equal(configurePrototypeAuthoring(root, { check: true }).ok, true);
  assert.throws(() => configurePrototypeAuthoring(root, { check: true, wireScreenIds: ['home'] }), /real-screen wiring is missing/);
  assert.equal(fs.readFileSync(path.join(root, sources[0].sourceFile), 'utf8'), custom);
  assert.equal(generatePrototype(root, { check: true }).ok, true);
});

test('preflight rejects incompatible config exports and existing environment without mutation', (t) => {
  const root = project(t);
  const before = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  assert.throws(() => checkPrototypeTemplate(root, { resolve: () => { throw new Error('config export missing'); } }), /config export missing/);
  write(root, 'power.config.json', { environmentId: 'approved-fixture-environment' });
  assert.throws(() => checkPrototypeTemplate(root, templateResolver), /environment-bound/);
  assert.equal(fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8'), before);
});

test('native project verification supports only explicit materialized local mode without creating a live config', (t) => {
  const root = project(t);
  preparePrototype(root, { displayName: 'Native prototype', slug: 'native-prototype', entryRoute: '/home', ...templateResolver });
  const before = fs.readFileSync(path.join(root, '.tmp/prototype-generated.json'), 'utf8');
  assert.throws(() => verifyNativeProject(root), /requires --prototype/);
  const verified = verifyNativeProject(root, { prototype: true });
  assert.equal(verified.environmentAccess, false);
  assert.equal(verified.nativeSupport, 'not-verified');
  assert.equal(verified.mutated, false);
  assert.equal(fs.existsSync(path.join(root, 'power.config.json')), false);
  assert.equal(fs.readFileSync(path.join(root, '.tmp/prototype-generated.json'), 'utf8'), before);
  assert.throws(() => verifyNativeProject(root, { prototype: true, requireConnected: true }), /explicitly connected/);
  write(root, 'power.config.json', { environmentId: 'fixture-only' });
  assert.throws(() => verifyNativeProject(root, { prototype: true }), /live configuration/);
});

test('native project verification preserves the connected precheck and rejects fake local markers or changed startup', (t) => {
  const root = project(t);
  assert.throws(() => verifyNativeProject(root, { prototype: true }), /materialized prototype/);
  write(root, 'power.config.json', { environmentId: 'fixture-only' });
  assert.equal(verifyNativeProject(root).profile, 'connected');
  fs.unlinkSync(path.join(root, 'power.config.json'));
  preparePrototype(root, { displayName: 'Native prototype', slug: 'native-prototype', entryRoute: '/home', ...templateResolver });
  fs.appendFileSync(path.join(root, 'src/data/runtime.ts'), '\n// unrelated edit\n');
  assert.throws(() => verifyNativeProject(root, { prototype: true }), /startup changed/);
});

test('existing connector selection reports explicit prototype initialization need and rejects an environment switch', async (t) => {
  const root = project(t);
  preparePrototype(root, { displayName: 'Connector prototype', slug: 'connector-prototype', entryRoute: '/home', ...templateResolver });
  const environmentId = '11111111-2222-4333-8444-555555555555';
  const catalog = await readConnectionCatalog({ environmentId }, {
    getToken: async () => 'fixture-token',
    requestJson: async () => ({ value: [{
      name: 'existing-connection',
      properties: { apiId: 'shared_office365users', displayName: 'Existing users connection', statuses: [{ status: 'Connected' }] },
    }] }),
  });
  const selection = { kind: 'connector', environmentId, apiId: 'shared_office365users', connectionId: 'existing-connection', catalogRevision: catalog.catalogRevision };
  const before = fs.readFileSync(path.join(root, 'src/data/runtime.ts'), 'utf8');
  const verified = verifyConnectionProject(root, catalog, selection);
  assert.equal(verified.initialized, false);
  assert.equal(verified.requiresSeparateInitializationApproval, true);
  assert.equal(fs.existsSync(path.join(root, 'power.config.json')), false);
  write(root, '.tmp/prototype-connection-catalog.json', catalog);
  write(root, '.tmp/prototype-connection-selection.json', selection);
  const cli = spawnSync(process.execPath, [
    path.join(pluginRoot, 'scripts/verify-prototype-connection.js'), '--project-root', root,
    '--catalog', '.tmp/prototype-connection-catalog.json', '--selection', '.tmp/prototype-connection-selection.json',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), verified);
  write(root, 'power.config.json', { environmentId });
  assert.equal(verifyConnectionProject(root, catalog, selection).initialized, true);
  write(root, 'power.config.json', { environmentId: '22222222-2222-4222-8222-222222222222' });
  assert.throws(() => verifyConnectionProject(root, catalog, selection), /differs from the initialized app/);
  assert.equal(fs.readFileSync(path.join(root, 'src/data/runtime.ts'), 'utf8'), before);
});

test('Player identity is bound only after preflight consent and never independently reminted', async (t) => {
  const root = project(t);
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));
  delete app.expo.extra.telemetry.appInstanceId;
  app.expo.extra.telemetry.preserved = true;
  write(root, 'app.json', app);
  const before = fs.readFileSync(path.join(root, 'app.json'), 'utf8');
  const id = '33333333-3333-4333-8333-333333333333';
  let approvals = 0;
  const client = {
    descriptor: { operation: 'prototype', appInstanceId: id },
    async verify() {},
    async verifySavedDecision(receipt, expected) {
      assert.equal(receipt, 'preflight-receipt');
      assert.deepEqual(expected, { gateId: 'create-preflight', action: 'approve' });
      approvals += 1;
      return { question: { kind: 'plan', fields: [] }, binding: { type: 'artifacts', files: [{ path: 'app.json' }, { path: 'package.json' }] } };
    },
  };
  const dependencies = { env: { MOBILE_AUTHORING_CONTEXT: 'mock shared client' }, clientFactory: () => client };
  await assert.rejects(bindPrototypeIdentity(root, {}, dependencies), /Step 2c/);
  assert.equal(fs.readFileSync(path.join(root, 'app.json'), 'utf8'), before);
  assert.equal((await bindPrototypeIdentity(root, { receipt: 'preflight-receipt' }, dependencies)).appInstanceId, id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app.json'))).expo.extra.telemetry.preserved, true);
  assert.equal((await bindPrototypeIdentity(root, {}, dependencies)).unchanged, true);
  assert.equal(approvals, 1);
  client.descriptor.appInstanceId = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(bindPrototypeIdentity(root, { receipt: 'preflight-receipt' }, dependencies), /does not match/);
  client.descriptor.appInstanceId = 'not-a-uuid';
  await assert.rejects(bindPrototypeIdentity(root, { receipt: 'preflight-receipt' }, dependencies), /bridge-owned v4 app identity/);
});

test('registry projection is real, bounded and sealed against guessed service names', (t) => {
  const root = project(t);
  generatePrototype(root);
  const registry = JSON.parse(fs.readFileSync(path.join(root, '.tmp/data-access-registry.json')));
  const projection = projectDataAccess(registry, ['Appointment']);
  const signature = projection.entities[0].operations[0].signature;
  assert.equal(validateDataAccess(registry, projection, [signature]).entities.length, 1);
  assert.throws(() => validateDataAccess(registry, projection, ['FakeService.getAll()']), /unverified/);
  projection.entities[0].module = '@/generated/Fake';
  assert.throws(() => validateDataAccess(registry, projection, []), /revision|stale/);
});

test('compiler detects canonical fixture/rule drift and does not overwrite unrelated app-owned edits', (t) => {
  const root = project(t);
  generatePrototype(root);
  fs.appendFileSync(path.join(root, 'src/data/model.ts'), '\nexport const userEdit = true;\n');
  assert.throws(() => generatePrototype(root), /changed outside its compiler/);
  assert.match(fs.readFileSync(path.join(root, 'src/data/model.ts'), 'utf8'), /userEdit/);
  const facts = JSON.parse(fs.readFileSync(path.join(root, '.tmp/scenario-facts.json')));
  facts.records[0].fields.title = 'Unapproved change';
  write(root, '.tmp/scenario-facts.json', facts);
  assert.throws(() => generatePrototype(root, { check: true }), /revision/);
});

test('rules-only refresh accepts exact parent compiler output and changes no unrelated local source or fixtures', (t) => {
  const root = project(t);
  preparePrototype(root, { displayName: 'Rules prototype', slug: 'rules-prototype', entryRoute: '/home', ...templateResolver });
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name)));
  const oldManifest = read('.tmp/prototype-generated.json');
  const unchanged = [...Object.keys(oldManifest.files).filter((file) => file !== 'src/data/rules.ts'),
    '.tmp/prototype-domain.json', '.tmp/prototype-bindings.json', '.tmp/scenario-facts.json'];
  const before = Object.fromEntries(unchanged.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const rules = { schemaVersion: 1, rules: [{
    id: 'urgentStart', entityId: 'Appointment', actionId: 'saveAppointment',
    when: { fieldId: 'title', operator: 'equals', value: 'Urgent' },
    require: { fieldId: 'startsAt', message: 'Choose a start time for urgent appointments.' },
  }] };
  write(root, '.tmp/prototype-rules.json', rules);
  write(root, 'src/data/rules.ts', generateRulesRuntime(read('.tmp/prototype-domain.json'), rules));
  assert.throws(() => refreshPrototypeRules(root, { check: true }), /stale/);
  const refreshed = refreshPrototypeRules(root);
  assert.deepEqual(refreshed.files, ['src/data/rules.ts', '.tmp/prototype-generated.json', '.tmp/data-access-registry.json']);
  assert.equal(refreshed.recordsChanged, false);
  assert.equal(refreshed.remoteEffects, false);
  for (const [file, bytes] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), bytes);
  assert.equal(read('.tmp/data-access-registry.json').inputRevisions.rules, revision(rules));
  assert.equal(refreshPrototypeRules(root, { check: true }).ok, true);
  assert.equal(generatePrototype(root, { check: true }).ok, true);
  fs.appendFileSync(path.join(root, 'src/data/runtime.ts'), '\n// unrelated drift\n');
  assert.throws(() => refreshPrototypeRules(root), /unrelated app-owned drift/);
});

test('rules-only refresh rejects domain drift and resumes an interrupted registry write', (t) => {
  const root = project(t);
  preparePrototype(root, { displayName: 'Rules prototype', slug: 'rules-prototype', entryRoute: '/home', ...templateResolver });
  const domain = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-domain.json')));
  write(root, '.tmp/prototype-domain.json', { ...domain, schemaVersionNumber: 2 });
  assert.throws(() => refreshPrototypeRules(root), /cannot change domain/);
  write(root, '.tmp/prototype-domain.json', domain);
  write(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [{
    id: 'scheduledTitle', entityId: 'Appointment', actionId: 'saveAppointment',
    when: { fieldId: 'startsAt', operator: 'not-equals', value: null },
    require: { fieldId: 'title', message: 'Scheduled appointments need a title.' },
  }] });
  const rename = fs.renameSync;
  let interrupt = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (interrupt && to === path.join(root, '.tmp/data-access-registry.json')) throw new Error('injected registry interruption');
    return rename(from, to);
  });
  assert.throws(() => refreshPrototypeRules(root), /registry interruption/);
  interrupt = false;
  assert.equal(refreshPrototypeRules(root).ok, true);
  assert.equal(refreshPrototypeRules(root, { check: true }).ok, true);
});

function proposedRules() {
  return { schemaVersion: 1, rules: [{
    id: 'urgentStart', entityId: 'Appointment', actionId: 'saveAppointment',
    when: { fieldId: 'title', operator: 'equals', value: 'Urgent' },
    require: { fieldId: 'startsAt', message: 'Choose a start time for urgent appointments.' },
  }] };
}

test('read-only rule plans seal deterministic exact effects before local or connected generation', (t) => {
  for (const mode of ['local-prototype', 'connected']) {
    const root = project(t);
    preparePrototype(root, { displayName: 'Rule plans', slug: 'rule-plans', entryRoute: '/home', ...templateResolver });
    const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (mode === 'connected') {
      const mapping = { schemaVersion: 1, entities: [], environmentKey: 'unit-mapping' };
      mapping.mappingRevision = revision(mapping);
      write(root, '.tmp/prototype-dataverse-mapping.json', mapping);
      const registry = read('.tmp/data-access-registry.json');
      registry.mode = mode;
      registry.mappingRevision = mapping.mappingRevision;
      registry.inputRevisions.mapping = mapping.mappingRevision;
      delete registry.registryRevision;
      registry.registryRevision = revision(registry);
      write(root, '.tmp/data-access-registry.json', registry);
    }
    const files = [...Object.keys(read('.tmp/prototype-generated.json').files),
      '.tmp/prototype-rules.json', '.tmp/prototype-domain.json', '.tmp/prototype-bindings.json',
      '.tmp/persistence-contract.json', '.tmp/scenario-facts.json',
      '.tmp/prototype-generated.json', '.tmp/data-access-registry.json',
      ...(mode === 'connected' ? ['.tmp/prototype-dataverse-mapping.json'] : [])];
    const before = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file))]));
    const rules = proposedRules();
    const plan = planPrototypeRules(root, { rules });
    assert.deepEqual(plan.effects.map((effect) => effect.path), [
      '.tmp/data-access-registry.json', '.tmp/prototype-generated.json',
      '.tmp/prototype-rules.json', 'src/data/rules.ts',
    ]);
    assert.equal(plan.operation, 'prototype-rules');
    const { planRevision, ...body } = plan;
    assert.equal(planRevision, revision(body));
    assert.equal(plan.inputs.find((input) => input.path === '.tmp/prototype-generated.json').sha256,
      sha256Hex(before.get('.tmp/prototype-generated.json')));
    assert.deepEqual(planPrototypeRules(root, { rules: { rules: rules.rules, schemaVersion: 1 } }), plan);
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    for (const effect of plan.effects) {
      assert.equal(effect.beforeSha256, sha256Hex(before.get(effect.path)));
      assert.equal(effect.afterSha256, sha256Hex(effect.content));
    }
    const input = plan.effects.find((effect) => effect.path === '.tmp/prototype-rules.json');
    write(root, input.path, input.content);
    const result = generatePrototypeRules(root);
    assert.equal(result.recordsChanged, false);
    assert.equal(result.remoteEffects, false);
    for (const effect of plan.effects) assert.equal(sha256Hex(fs.readFileSync(path.join(root, effect.path))), effect.afterSha256);
    for (const [file, bytes] of before) {
      if (!plan.effects.some((effect) => effect.path === file)) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    }
    assert.equal(fs.existsSync(path.join(root, 'src/data/test-write-permission.json')), false);
    assert.equal(generatePrototypeRules(root, { check: true }).ok, true);
    assert.equal(refreshPrototypeRules, generatePrototypeRules);
  }
});

test('rule plans include and revoke only an already-owned optional permission file', (t) => {
  const root = project(t);
  preparePrototype(root, { displayName: 'Rule grant plan', slug: 'rule-grant-plan', entryRoute: '/home', ...templateResolver });
  const permission = 'src/data/test-write-permission.json';
  write(root, permission, { scopeId: 'unit-only-existing-permission' });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-generated.json'), 'utf8'));
  manifest.files[permission] = sha256Hex(fs.readFileSync(path.join(root, permission)));
  write(root, '.tmp/prototype-generated.json', manifest);
  const previous = fs.readFileSync(path.join(root, permission));
  const plan = planPrototypeRules(root, { rules: proposedRules() });
  assert.equal(plan.effects.length, 5);
  assert.equal(plan.effects.find((effect) => effect.path === permission).content, 'null\n');
  assert.deepEqual(fs.readFileSync(path.join(root, permission)), previous);
  const input = plan.effects.find((effect) => effect.path === '.tmp/prototype-rules.json');
  write(root, input.path, input.content);
  assert.equal(generatePrototypeRules(root).testWritePermissionRevoked, true);
  for (const effect of plan.effects) assert.equal(sha256Hex(fs.readFileSync(path.join(root, effect.path))), effect.afterSha256);
  assert.equal(generatePrototypeRules(root, { check: true }).ok, true);
});

test('rule planning rejects stale before-state and does not repair mutable metadata before approval', (t) => {
  const root = project(t);
  preparePrototype(root, { displayName: 'Rule baseline', slug: 'rule-baseline', entryRoute: '/home', ...templateResolver });
  assert.throws(() => planPrototypeRules(root), /proposed rules contract/);
  const original = fs.readFileSync(path.join(root, 'src/data/rules.ts'));
  const domain = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-domain.json'), 'utf8'));
  write(root, 'src/data/rules.ts', generateRulesRuntime(domain, proposedRules()));
  assert.throws(() => planPrototypeRules(root, { rules: proposedRules() }), /unrelated app-owned drift/);
  fs.writeFileSync(path.join(root, 'src/data/rules.ts'), original);
  write(root, '.tmp/prototype-rules.json', proposedRules());
  assert.throws(() => planPrototypeRules(root, { rules: proposedRules() }), /unchanged current canonical rules/);
});

test('narrow rule plans reject a retained connector seal instead of silently adding startup writes', (t) => {
  const root = project(t);
  preparePrototype(root, { displayName: 'Retained rule seal', slug: 'retained-rule-seal', entryRoute: '/home', ...templateResolver });
  const registry = JSON.parse(fs.readFileSync(path.join(root, '.tmp/data-access-registry.json'), 'utf8'));
  const startup = { schemaVersion: 1, inputRevisions: { rules: registry.inputRevisions.rules } };
  startup.startupRevision = revision(startup);
  write(root, '.tmp/prototype-connector-startup.json', startup);
  const before = fs.readFileSync(path.join(root, 'src/data/rules.ts'));
  assert.throws(() => planPrototypeRules(root, { rules: proposedRules() }), /retained connector startup write/);
  write(root, '.tmp/prototype-rules.json', proposedRules());
  assert.throws(() => generatePrototypeRules(root), /retained connector startup write/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'src/data/rules.ts')), before);
});

test('interrupted local startup resumes only its known files and verifies the full no-live import graph', (t) => {
  const root = project(t);
  const options = { displayName: 'Appointments', slug: 'appointments', entryRoute: '/home', ...templateResolver };
  preparePrototype(root, options);
  const backup = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-connected-template.json')));
  fs.unlinkSync(path.join(root, '.tmp/prototype-profile.json'));
  write(root, 'app/index.tsx', backup.files['app/index.tsx']);
  write(root, 'app/login.tsx', backup.files['app/login.tsx']);
  assert.equal(preparePrototype(root, options).resumed, true);
  assert.equal(fs.existsSync(path.join(root, 'app/login.tsx')), false);
  write(root, 'src/unreachable-live.ts', "import power from '../power.config.json';\nexport const environment = power;\n");
  assert.throws(() => generatePrototype(root, { check: true }), /inactive live modules/);
});

test('installed pinned template type-checks the actual no-environment generated runtime', {
  skip: !process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to an already installed supported template node_modules',
}, async (t) => {
  const modules = path.resolve(process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES);
  const root = project(t, modules, { nativeCapabilities: [{ id: 'camera', approved: true }, { id: 'image-picker', approved: true }] });
  preparePrototype(root, { displayName: 'Scheduling prototype', slug: 'scheduling-prototype', entryRoute: '/home' });
  instrumentHome(root);
  validateSource(root);
  const projectRequire = createRequire(path.join(root, 'package.json'));
  const metro = projectRequire(path.join(root, 'metro.config.js'));
  const middleware = metro.server.enhanceMiddleware(() => { throw new Error('Unexpected middleware fallthrough'); });
  const server = http.createServer(middleware);
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/__pawrap_verify`);
  assert.equal(response.status, 200);
  const verification = await response.json();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(verification.type, 'pawrap-app');
  assert.equal(Number.isInteger(verification.nativeRuntimeVersions.android), true);
  const result = spawnSync(process.execPath, [path.join(modules, 'typescript/lib/tsc.js'), '--noEmit', '--project', path.join(root, 'tsconfig.json')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('installed pinned template type-checks transient navigation without a fabricated stored entity', {
  skip: !process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to already installed template dependencies',
}, (t) => {
  const modules = path.resolve(process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES);
  const root = project(t, modules);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name)));
  const persistence = compilePersistenceContract({
    dataEntities: [{ name: 'Navigation', role: 'supporting', realization: 'transient-ui-state' }],
  }, {
    schemaVersion: 1, connectors: [], nativeCapabilities: [],
    conceptOwners: [{ conceptId: 'navigation', owner: 'transient', reason: 'Current screen selection is transient view state.' }],
  });
  const facts = { ...read('.tmp/scenario-facts.json'), records: [], scopeRevision: persistence.scopeRevision, persistenceRevision: persistence.persistenceRevision };
  delete facts.scenarioRevision;
  facts.scenarioRevision = revision(facts);
  write(root, '.tmp/prototype-domain.json', { ...read('.tmp/prototype-domain.json'), entities: [], actions: [] });
  write(root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [] });
  write(root, '.tmp/persistence-contract.json', persistence);
  write(root, '.tmp/scenario-facts.json', facts);
  preparePrototype(root, { displayName: 'Information prototype', slug: 'information-prototype', entryRoute: '/home' });
  assert.deepEqual(read('.tmp/data-access-registry.json').entities, []);
  const result = spawnSync(process.execPath, [path.join(modules, 'typescript/lib/tsc.js'), '--noEmit', '--project', path.join(root, 'tsconfig.json')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('connected generator preserves official fixture bytes and type-checks service wrappers and auth composition', {
  skip: !process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to already installed template dependencies',
}, (t) => {
  const modules = path.resolve(process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES);
  const root = project(t, modules);
  preparePrototype(root, { displayName: 'Scheduling prototype', slug: 'scheduling-prototype', entryRoute: '/home' });
  instrumentHome(root);
  const instrumentedRoot = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name)));
  const domain = read('.tmp/prototype-domain.json');
  const schema = { schemaVersion: 1, tables: [{
    logicalName: 'cr_appointment', plannedDecision: 'reuse', serviceRequired: true,
    columns: [
      { logicalName: 'cr_title', type: 'string', plannedDecision: 'reuse' },
      { logicalName: 'cr_startsat', type: 'datetime', plannedDecision: 'reuse' },
    ],
  }] };
  const service = `import type { IOperationOptions, IOperationResult } from '@microsoft/power-apps/data';
type IGetAllOptions = IOperationOptions;
type IGetOptions = IOperationOptions;
interface AppointmentRow { cr_appointmentid?: string; cr_title: string; cr_startsat?: string; }
export class AppointmentsService {
  public static async getAll(options?: IGetAllOptions): Promise<IOperationResult<AppointmentRow[]>> { throw new Error('Typed fixture only'); }
  public static async get(id: string, options?: IGetOptions): Promise<IOperationResult<AppointmentRow>> { throw new Error('Typed fixture only'); }
  public static async create(record: AppointmentRow): Promise<IOperationResult<AppointmentRow>> { throw new Error('Typed fixture only'); }
  public static async update(id: string, record: Partial<AppointmentRow>): Promise<IOperationResult<AppointmentRow>> { throw new Error('Typed fixture only'); }
  public static async delete(id: string): Promise<IOperationResult<void>> { throw new Error('Typed fixture only'); }
}
`;
  const official = {
    'power.config.json': {
      environmentId: 'fixture-environment', appId: 'fixture-app', appDisplayName: 'Scheduling fixture',
      databaseReferences: { 'default.cds': { dataSources: { appointment: { logicalName: 'cr_appointment', entitySetName: 'appointments' } } } },
    },
    'src/generated/services/AppointmentsService.ts': service,
    'src/generated/connectorSchemas.ts': 'export const schemaMap = {};\n',
  };
  for (const [file, value] of Object.entries(official)) write(root, file, value);
  const before = Object.fromEntries(Object.keys(official).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const persistence = compilePersistenceContract({
    dataEntities: [{ name: 'Appointment', role: 'primary', realization: 'existing-table' }],
  }, { schemaVersion: 1, connectors: [], nativeCapabilities: [],
    conceptOwners: [{ conceptId: 'appointment', owner: 'dataverse', reason: 'Approved conversion to a real appointment table.' }],
  });
  const facts = read('.tmp/scenario-facts.json');
  facts.persistenceRevision = persistence.persistenceRevision;
  facts.scopeRevision = persistence.scopeRevision;
  delete facts.scenarioRevision;
  facts.scenarioRevision = revision(facts);
  write(root, '.tmp/persistence-contract.json', persistence);
  write(root, '.tmp/scenario-facts.json', facts);
  write(root, '.tmp/dataverse-schema-contract.json', schema);
  write(root, '.tmp/prototype-materialized-snapshot.json', { tables: [{
    logicalName: 'cr_appointment', entitySetName: 'appointments', primaryIdAttribute: 'cr_appointmentid',
    detailLevel: 'full', missingDetailClasses: [],
    columns: [{ logicalName: 'cr_title', type: 'String' }, { logicalName: 'cr_startsat', type: 'DateTime', dateTimeBehavior: 'UserLocal' }],
  }] });
  write(root, '.tmp/prototype-relationship-evidence.json', {});
  write(root, '.tmp/prototype-dataverse-mapping-input.json', {
    schemaVersion: 1, domainRevision: revision(domain), schemaRevision: revision(schema),
    entities: [{
      entityId: 'Appointment', owner: 'dataverse', decision: 'reuse', logicalName: 'cr_appointment',
      serviceFile: 'AppointmentsService.ts', serviceExport: 'AppointmentsService', serviceSha256: sha256Hex(service),
      fields: [{ fieldId: 'title', column: 'cr_title' }, { fieldId: 'startsAt', column: 'cr_startsat' }],
    }],
  });
  write(root, 'app/(app)/_layout.tsx', "import { useState } from 'react';\nimport { Stack } from 'expo-router';\nexport default function AppLayout() { const [saved] = useState(true); return <Stack screenOptions={{ headerShown: saved }} />; }\n");
  generateDataverseRepositories(root);
  stageConnectedStartup(root);
  assert.equal(fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8'),
    instrumentedRoot.replace("import { PrototypeProvider } from '../src/data/PrototypeProvider';",
      "import { ConnectedProvider as PrototypeProvider } from '../src/data/ConnectedProvider';"));
  assert.equal(configurePrototypeAuthoring(root, { check: true, readyScreenIds: ['home'] }).rootWired, true);
  validateSource(root);
  for (const [file, value] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), value);
  const registry = read('.tmp/data-access-registry.json');
  assert.equal(registry.mode, 'connected');
  assert.equal(registry.inputRevisions.persistence, persistence.persistenceRevision);
  assert.equal(registry.inputRevisions.scenario, facts.scenarioRevision);
  assert.equal(registry.entities[0].owner, 'dataverse');
  const layout = fs.readFileSync(path.join(root, 'app/(app)/_layout.tsx'), 'utf8');
  assert.match(layout, /useState\(true\)/);
  assert.match(layout, /<ConnectedGate><AppLayout \/><\/ConnectedGate>/);
  assert.doesNotMatch(layout, /if \(isLoading\)/);
  assert.match(fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8'), /ConnectedProvider/);
  assert.match(fs.readFileSync(path.join(root, 'src/data/ConnectedProvider.tsx'), 'utf8'), /PowerAppsProvider/);
  const result = spawnSync(process.execPath, [path.join(modules, 'typescript/lib/tsc.js'), '--noEmit', '--project', path.join(root, 'tsconfig.json')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  write(root, '.tmp/prototype-conversion-journal.json', {
    completed: ['metadata', 'services', 'schemas', 'adapters', 'startup'], dataImport: 'none', activeProfile: 'prototype',
  });
  write(root, '.tmp/prototype-dataverse-remote-journal.json', { evidence: 'must survive activation failure and Undo' });
  const auth = read('auth.config.json');
  auth.msal.clientId = '11111111-1111-4111-8111-111111111111';
  auth.msal.tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  write(root, 'auth.config.json', auth);
  const tracked = [
    'src/data/runtime.ts', 'src/data/test-write-permission.json', '.tmp/prototype-profile.json',
    '.tmp/prototype-generated.json', '.tmp/prototype-conversion-journal.json',
  ];
  const captureSource = sharedSource.captureSource;
  const expectedSourceRevision = captureSource(root).revision;
  const request = { expectedSourceRevision, confirmStandaloneApply: true };
  assert.throws(() => activateConnectedData(root, request, { env: { MOBILE_AUTHORING_CONTEXT: 'player' } }), /bridge-owned/);
  assert.throws(() => activateConnectedData(root, { ...request, expectedSourceRevision: '0'.repeat(64) }, { env: {} }), /changed before Apply/);
  assert.throws(() => activateConnectedData(root, { ...request, expectedSourceRevision: `${expectedSourceRevision}\n` }, { env: {} }), /reviewed source revision/);
  const bytes = Object.fromEntries(tracked.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  assert.throws(() => activateConnectedData(root, request, {
    env: {}, validateProject: () => { throw new Error('injected activation gate failure'); },
  }), /activation gate failure/);
  assert.deepEqual(Object.fromEntries(tracked.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')])), bytes);
  assert.equal(fs.existsSync(path.join(root, `.tmp/prototype-activation-backups/${expectedSourceRevision}.json`)), true);
  assert.equal(captureSource(root).revision, expectedSourceRevision);
  const activated = activateConnectedData(root, request, { env: {} });
  assert.equal(activated.published, false);
  assert.notEqual(activated.afterRevision, activated.beforeRevision);
  assert.equal(read('.tmp/prototype-profile.json').profile, 'connected');
  assert.equal(read('.tmp/prototype-conversion-journal.json').activeProfile, 'prototype');
  assert.equal(read('.tmp/prototype-conversion-journal.json').stagedProfile, 'connected');
  assert.equal(read('.tmp/prototype-conversion-journal.json').activation.afterRevision, undefined);
  assert.equal(activated.afterRevision, captureSource(root).revision);
  assert.match(fs.readFileSync(path.join(root, 'src/data/runtime.ts'), 'utf8'), /__DEV__ \? \{"previewKind":"active"/);
  assert.equal(read('.tmp/prototype-dataverse-remote-journal.json').evidence, 'must survive activation failure and Undo');
  const snapshotBeforeJournalUpdates = sharedSource.captureSnapshot(root).revision;
  for (const file of ['.tmp/prototype-conversion-journal.json', '.tmp/prototype-dataverse-remote-journal.json']) {
    write(root, file, { ...read(file), activationEvidenceVerified: true });
  }
  assert.equal(captureSource(root).revision, activated.afterRevision);
  assert.notEqual(sharedSource.captureSnapshot(root).revision, snapshotBeforeJournalUpdates);
  const already = activateConnectedData(root, {
    expectedSourceRevision: sharedSource.captureSource(root).revision, confirmStandaloneApply: true,
  }, { env: {} });
  assert.equal(already.alreadyStaged, true);
  const snapshotRoot = path.join(path.dirname(root), `.prototype-activation-copy-${crypto.randomUUID()}`);
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  sharedSource.copySource(root, snapshotRoot, activated.afterRevision);
  for (const file of [activated.backupFile, '.tmp/prototype-conversion-journal.json', '.tmp/prototype-dataverse-remote-journal.json']) {
    assert.equal(fs.readFileSync(path.join(snapshotRoot, file), 'utf8'), fs.readFileSync(path.join(root, file), 'utf8'), file);
  }
  assert.equal(sharedSource.captureSnapshot(snapshotRoot).revision, sharedSource.captureSnapshot(root).revision);
  generateDataverseRepositories(root);
  validateSource(root);
  assert.match(fs.readFileSync(path.join(root, 'src/data/runtime.ts'), 'utf8'), /__DEV__ \? \{"previewKind":"active"/);
  const connectedRuntime = fs.readFileSync(path.join(root, 'src/data/runtime.ts'), 'utf8');
  const connectedManifest = read('.tmp/prototype-generated.json');
  writeOwnedFiles(root, { 'src/data/test-write-permission.json': '{"fixturePermission":true}\n' }, connectedManifest.inputRevisions);
  write(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [{
    id: 'connectedStart', entityId: 'Appointment', actionId: 'saveAppointment',
    when: { fieldId: 'title', operator: 'equals', value: 'Urgent' },
    require: { fieldId: 'startsAt', message: 'Choose a start time.' },
  }] });
  assert.equal(refreshPrototypeRules(root).testWritePermissionRevoked, true);
  assert.equal(read('src/data/test-write-permission.json'), null);
  assert.equal(refreshPrototypeRules(root, { check: true }).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'src/data/runtime.ts'), 'utf8'), connectedRuntime);
  assert.equal(read('.tmp/prototype-dataverse-remote-journal.json').evidence, 'must survive activation failure and Undo');
  for (const [file, value] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), value);
  const taughtTypes = spawnSync(process.execPath, [path.join(modules, 'typescript/lib/tsc.js'), '--noEmit', '--project', path.join(root, 'tsconfig.json')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(taughtTypes.status, 0, `${taughtTypes.stdout}\n${taughtTypes.stderr}`);
});
