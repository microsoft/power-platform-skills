'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { preparePrototype } = require('../prepare-prototype');
const { compilePersistenceContract } = require('../compile-persistence-contract');
const { configureMobileAuthoring } = require('../lib/authoring-runtime');
const { configurePrototypeAuthoring } = require('../lib/prototype-authoring');
const { revision } = require('../lib/prototype-files');
const { sha256Hex } = require('../lib/product-experience-contracts');
const { readConnectionCatalog } = require('../lib/prototype-connections');
const { stagePrototypeConnectorStartup, verifyPrototypeConnectorStartup, activatePrototypeConnectorData, STATE, PENDING, CONFIG, PROVIDER, BOUNDARY } = require('../lib/prototype-connector-startup');
const { verifyNativeProject } = require('../verify-prototype-native');
const { createLocalStore } = require('../lib/prototype-local-runtime');
const core = require('../lib/prototype-repository-core');
const { refreshPrototypeRules } = require('../lib/prototype-rules');
const { captureSource } = require('../lib/authoring-source');
const { candidateMode } = require('../lib/mobile-authoring-candidate');

const PLUGIN = path.resolve(__dirname, '../..');
const MODULES = process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES;
const APP = '22222222-2222-4222-8222-222222222222';
const ENV = '11111111-2222-4333-8444-555555555555';
const API = 'shared_office365users';
const PREVIEW = { previewKind: 'candidate', dataNamespace: 'connector-job-one', baseDataNamespace: 'active' };
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (root, file) => JSON.parse(read(root, file));
function write(root, file, value) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
}

async function project(t, { actionOnly = false, generatedAuthoring = false } = {}) {
  const root = path.join(path.resolve(PLUGIN, '../..'), `.prototype-connector-work-${crypto.randomUUID()}`);
  fs.cpSync(path.join(PLUGIN, 'template'), root, { recursive: true, filter: (file) => !file.includes(`${path.sep}node_modules`) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(MODULES, path.join(root, 'node_modules'), 'dir');
  const app = json(root, 'app.json');
  app.expo.extra.telemetry = { appInstanceId: APP };
  write(root, 'app.json', app);
  const domain = {
    schemaVersion: 1, appInstanceId: APP, schemaVersionNumber: 1,
    entities: [{ id: 'Appointment', label: 'Appointment', fields: [{ id: 'title', label: 'Title', type: 'text', required: true }], operations: ['list', 'get', 'create', 'update', 'delete'] }],
    actions: [{ id: 'saveAppointment', label: 'Save', entityId: 'Appointment', operation: 'save' }],
  };
  const scope = { dataEntities: [{ name: 'Appointment', role: 'primary', realization: 'local-configuration' }] };
  const architecture = { schemaVersion: 1, connectors: [], nativeCapabilities: [], conceptOwners: [{ conceptId: 'appointment', owner: 'local', reason: 'Retain real persistent local appointments.' }] };
  const persistence = compilePersistenceContract(scope, architecture);
  const facts = {
    schemaVersion: 1, contractType: 'scenario-facts', scopeRevision: persistence.scopeRevision, persistenceRevision: persistence.persistenceRevision,
    records: [{ id: 'appointment-one', conceptId: 'appointment', fields: { title: 'Existing appointment' } }],
    relationships: [], scenarios: [], mediaAssets: [], screenBindings: [], invariants: [],
  };
  facts.scenarioRevision = revision(facts);
  write(root, '.tmp/prototype-domain.json', domain);
  write(root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [{ entityId: 'Appointment', conceptId: 'appointment' }] });
  write(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
  write(root, '.tmp/persistence-contract.json', persistence);
  write(root, '.tmp/scenario-facts.json', facts);
  write(root, '.tmp/navigation-manifest.json', { screens: { home: { targetPath: '/home' } } });
  write(root, 'native-app-plan.md', '# Approved prototype fixture\n');
  preparePrototype(root, { displayName: 'Connector prototype fixture', slug: 'connector-fixture', entryRoute: '/home' });
  write(root, 'app/(app)/home.tsx', `import { Text } from 'react-native';
import { useEntityList } from '@/data';
export default function Home() {
  const items = useEntityList('Appointment');
  return <Text>{items.data?.items[0]?.title ?? 'Loading local records'}</Text>;
}
`);
  write(root, '.tmp/compiled-screen-build-pack.json', { contractType: 'compiled-screen-build-pack', screens: [{ screenId: 'home', route: '/home' }] });
  write(root, '.tmp/authoring-registry.json', { schemaVersion: 1, appInstanceId: APP, screens: [{ screenId: 'home', route: '/home', sourceFile: 'app/(app)/home.tsx', targets: [] }] });
  configureMobileAuthoring(root);
  write(root, 'app/_layout.tsx', `import { Slot } from 'expo-router';
import { Text } from 'react-native';
import { PrototypeProvider } from '../src/data/PrototypeProvider';
import { AuthoringProvider } from '../src/authoring';
import { configureDataPreview } from '../src/data/runtime';
export default function RootLayout() {
  return <AuthoringProvider configureDataPreview={configureDataPreview}><PrototypeProvider>
    <Text>Preserve this actual root UI</Text><Slot />
  </PrototypeProvider></AuthoringProvider>;
}
`);
  if (generatedAuthoring) {
    const current = read(root, 'app/_layout.tsx')
      .replace("import { AuthoringProvider } from '../src/authoring';\n", '')
      .replace("import { configureDataPreview } from '../src/data/runtime';\n", '')
      .replace('<AuthoringProvider configureDataPreview={configureDataPreview}>', '')
      .replace('</AuthoringProvider>', '');
    write(root, 'app/_layout.tsx', current);
    configurePrototypeAuthoring(root);
  }
  const priorOwned = json(root, '.tmp/prototype-generated.json').files;
  const priorFacts = json(root, '.tmp/scenario-facts.json');
  architecture.connectors.push({ apiName: 'directory', displayName: 'Directory', approved: true });
  if (!actionOnly) {
    scope.dataEntities.push({ name: 'Directory', role: 'reference', realization: 'connector-source' });
    architecture.conceptOwners.push({ conceptId: 'directory', owner: 'connector:directory', reason: 'Approved existing directory connector for people lookup.' });
  }
  const connectedPersistence = compilePersistenceContract(scope, architecture);
  write(root, '.tmp/persistence-contract.json', connectedPersistence);
  const connectedFacts = { ...priorFacts, scopeRevision: connectedPersistence.scopeRevision, persistenceRevision: connectedPersistence.persistenceRevision };
  delete connectedFacts.scenarioRevision;
  connectedFacts.scenarioRevision = revision(connectedFacts);
  write(root, '.tmp/scenario-facts.json', connectedFacts);
  // Explicit SDK inputs; use the actual installed generator, never a generated-file stub.
  write(root, 'power.config.json', { environmentId: ENV, appDisplayName: 'Connector fixture', connectionReferences: { directory_ref: { id: `/providers/Microsoft.PowerApps/apis/${API}`, dataSources: ['Directory'] } } });
  write(root, 'auth.config.json', { msal: { clientId: '33333333-3333-4333-8333-333333333333', tenantId: '44444444-4444-4444-8444-444444444444' } });
  write(root, '.power/schemas/Directory/Directory.Schema.json', { name: 'Directory', properties: { primaryRuntimeUrl: 'https://runtime.example.invalid' } });
  const generated = spawnSync('npm', ['run', 'generate-schemas', '--silent'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  const catalog = await readConnectionCatalog({ environmentId: ENV }, {
    getToken: async () => 'fixture-token',
    requestJson: async () => ({ value: [{ name: 'chosen-directory', properties: { apiId: API, statuses: [{ status: 'Connected' }] } }] }),
  });
  const selection = { kind: 'connector', apiId: API, environmentId: ENV, connectionId: 'chosen-directory', catalogRevision: catalog.catalogRevision };
  return { root, domain, priorOwned, input: { selection, catalog, connectorName: 'directory', preview: PREVIEW } };
}

test('connector startup preserves actual local source/UI, binds host configuration and type-checks against the installed template', { skip: !MODULES }, async (t) => {
  const h = await project(t);
  const official = Object.fromEntries(['power.config.json', 'auth.config.json', 'src/generated/connectorSchemas.ts', '.power/schemas/Directory/Directory.Schema.json'].map((file) => [file, read(h.root, file)]));
  const home = read(h.root, 'app/(app)/home.tsx');
  const pkg = json(h.root, 'package.json');
  const result = stagePrototypeConnectorStartup(h.root, h.input);
  assert.equal(result.published, false);
  assert.equal(result.persistenceMode, 'connector-only');
  for (const [file, hash] of Object.entries(h.priorOwned)) assert.equal(sha256Hex(read(h.root, file)), hash, file);
  for (const [file, bytes] of Object.entries(official)) assert.equal(read(h.root, file), bytes, file);
  assert.equal(read(h.root, 'app/(app)/home.tsx'), home);
  assert.deepEqual(json(h.root, 'package.json').dependencies, pkg.dependencies);
  assert.equal(json(h.root, 'package.json').scripts.predev, pkg.scripts.predev);
  assert.equal(json(h.root, 'package.json').scripts['dev:prototype'], undefined);
  assert.equal(json(h.root, '.tmp/data-access-registry.json').mode, 'local-prototype');
  assert.equal(json(h.root, '.tmp/prototype-profile.json').profile, 'connector');
  assert.match(read(h.root, 'app/_layout.tsx'), /AuthoringProvider configureDataPreview=\{configureDataPreview\}/);
  assert.match(read(h.root, 'app/_layout.tsx'), /Preserve this actual root UI/);
  assert.match(read(h.root, 'app/_layout.tsx'), /ConnectorPreviewBoundary><RootLayout \//);
  assert.match(read(h.root, PROVIDER), /sharedConnectionId: binding\.connectionId/);
  assert.doesNotMatch(read(h.root, PROVIDER), /new QueryClient|<TamaguiProvider|<PrototypeProvider/);
  assert.match(read(h.root, 'app/login.tsx'), /href="\/home"/);
  assert.match(read(h.root, 'app/oauth-callback.tsx'), /router\.replace\("\/home"\)/);
  assert.equal(verifyPrototypeConnectorStartup(h.root).ok, true);
  assert.equal(verifyNativeProject(h.root).profile, 'connector');
  assert.equal(stagePrototypeConnectorStartup(h.root, { ...h.input, check: true }).ok, true);
  const verified = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/stage-prototype-connector.js'), '--project-root', h.root, '--verify'], {
    cwd: h.root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).profile, 'connector');
  const requireFromApp = createRequire(path.join(h.root, 'package.json'));
  const compiler = requireFromApp.resolve('typescript/bin/tsc');
  const checked = spawnSync(process.execPath, [compiler, '--noEmit', '--project', path.join(h.root, 'tsconfig.json')], { cwd: h.root, encoding: 'utf8' });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  const gate = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/validate-mobile-files.js'), '--project-root', h.root, '--all-source'], {
    cwd: h.root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(gate.status, 0, `${gate.stdout}\n${gate.stderr}`);
  const routes = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/check-routes.js'), '--quiet'], { cwd: h.root, encoding: 'utf8' });
  assert.equal(routes.status, 0, `${routes.stdout}\n${routes.stderr}`);
  assert.equal(refreshPrototypeRules(h.root, { check: true }).ok, true);
  write(h.root, '.power/schemas/Directory/Directory.Schema.json', { name: 'Directory', properties: { primaryRuntimeUrl: 'https://changed.example.invalid' } });
  assert.throws(() => verifyPrototypeConnectorStartup(h.root), /canonical bindings are stale/);
});

test('connector staging rejects wrong ownership, missing auth, unsafe preview and changed local fixtures before writing', { skip: !MODULES }, async (t) => {
  const h = await project(t);
  const before = read(h.root, 'app/_layout.tsx');
  assert.throws(() => stagePrototypeConnectorStartup(h.root, { ...h.input, preview: { previewKind: 'candidate', dataNamespace: 'active' } }), /isolated/);
  assert.throws(() => stagePrototypeConnectorStartup(h.root, { ...h.input, connectorName: 'guessed-api-name' }), /connectorName/);
  const auth = read(h.root, 'auth.config.json');
  write(h.root, 'auth.config.json', { msal: { clientId: '', tenantId: '' } });
  assert.throws(() => stagePrototypeConnectorStartup(h.root, h.input), /Real auth/);
  write(h.root, 'auth.config.json', auth);
  const facts = json(h.root, '.tmp/scenario-facts.json');
  facts.records[0].fields.title = 'Replacement fixture must not be imported';
  delete facts.scenarioRevision;
  facts.scenarioRevision = revision(facts);
  write(h.root, '.tmp/scenario-facts.json', facts);
  assert.throws(() => stagePrototypeConnectorStartup(h.root, h.input), /replace local fixture/);
  assert.equal(read(h.root, 'app/_layout.tsx'), before);
  assert.equal(fs.existsSync(path.join(h.root, PROVIDER)), false);
  assert.equal(fs.existsSync(path.join(h.root, PENDING)), false);
});

test('connector startup retains the generated outer authoring component and current root content', { skip: !MODULES }, async (t) => {
  const h = await project(t, { generatedAuthoring: true });
  stagePrototypeConnectorStartup(h.root, h.input);
  assert.match(read(h.root, 'app/_layout.tsx'), /ConnectorPreviewBoundary><MobileAuthoringRoot \//);
  assert.match(read(h.root, 'app/_layout.tsx'), /Preserve this actual root UI/);
  assert.equal(verifyPrototypeConnectorStartup(h.root).ok, true);
  assert.equal(configurePrototypeAuthoring(h.root, { check: true }).rootWired, true);
  const compiler = createRequire(path.join(h.root, 'package.json')).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--project', path.join(h.root, 'tsconfig.json')], {
    cwd: h.root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('an action-only connector enables real startup without a fake concept or persistence-mode conversion', { skip: !MODULES }, async (t) => {
  const h = await project(t, { actionOnly: true });
  const persistence = json(h.root, '.tmp/persistence-contract.json');
  assert.equal(persistence.mode, 'local-prototype');
  assert.deepEqual(persistence.connectorConceptIds, []);
  assert.deepEqual(persistence.localConceptIds, ['appointment']);
  const canonical = Object.fromEntries(['.tmp/prototype-domain.json', '.tmp/prototype-bindings.json', '.tmp/prototype-rules.json', '.tmp/scenario-facts.json']
    .map((file) => [file, read(h.root, file)]));
  const forged = { ...persistence, mode: 'connector-only' };
  delete forged.persistenceRevision;
  forged.persistenceRevision = revision(forged);
  write(h.root, '.tmp/persistence-contract.json', forged);
  assert.throws(() => stagePrototypeConnectorStartup(h.root, h.input), /compiler-derived persistence mode/);
  write(h.root, '.tmp/persistence-contract.json', persistence);
  const result = stagePrototypeConnectorStartup(h.root, h.input);
  assert.equal(result.profile, 'connector');
  assert.equal(result.persistenceMode, 'local-prototype');
  assert.equal(candidateMode(h.root), 'connector-only');
  assert.equal(json(h.root, '.tmp/persistence-contract.json').mode, 'local-prototype');
  assert.equal(result.repositoryMode, 'local-prototype');
  assert.equal(json(h.root, CONFIG).mode, 'local-prototype');
  assert.equal(json(h.root, '.tmp/prototype-profile.json').profile, 'connector');
  assert.equal(json(h.root, '.tmp/prototype-profile.json').persistenceMode, 'local-prototype');
  assert.deepEqual(json(h.root, '.tmp/persistence-contract.json'), persistence);
  for (const [file, bytes] of Object.entries(canonical)) assert.equal(read(h.root, file), bytes, file);
  for (const [file, hash] of Object.entries(h.priorOwned)) assert.equal(sha256Hex(read(h.root, file)), hash, file);
  assert.equal(verifyPrototypeConnectorStartup(h.root).persistenceMode, 'local-prototype');
  assert.equal(verifyNativeProject(h.root).profile, 'connector');
  assert.equal(refreshPrototypeRules(h.root, { check: true }).ok, true);
  const compiler = createRequire(path.join(h.root, 'package.json')).resolve('typescript/bin/tsc');
  const checked = spawnSync(process.execPath, [compiler, '--noEmit', '--project', path.join(h.root, 'tsconfig.json')], { cwd: h.root, encoding: 'utf8' });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test('connector startup requires complete official schemas and correctly ordered authoring initialization', { skip: !MODULES }, async (t) => {
  const h = await project(t);
  const schema = read(h.root, 'src/generated/connectorSchemas.ts');
  write(h.root, 'src/generated/connectorSchemas.ts', 'export const schemaMap = {};\n');
  assert.throws(() => stagePrototypeConnectorStartup(h.root, h.input), /official localRefId\/dataSources/);
  write(h.root, 'src/generated/connectorSchemas.ts', schema);
  const root = read(h.root, 'app/_layout.tsx');
  write(h.root, 'app/_layout.tsx', root
    .replace('<AuthoringProvider configureDataPreview={configureDataPreview}><PrototypeProvider>', '<PrototypeProvider><AuthoringProvider configureDataPreview={configureDataPreview}>')
    .replace('</PrototypeProvider></AuthoringProvider>', '</AuthoringProvider></PrototypeProvider>'));
  assert.throws(() => stagePrototypeConnectorStartup(h.root, h.input), /before the local provider mounts/);
  assert.equal(fs.existsSync(path.join(h.root, PROVIDER)), false);
  write(h.root, 'app/_layout.tsx', root);
  stagePrototypeConnectorStartup(h.root, h.input);
  write(h.root, 'app/_layout.tsx', read(h.root, 'app/_layout.tsx').replace('return <ConnectorPreviewBoundary><RootLayout /></ConnectorPreviewBoundary>;', 'return <RootLayout />;'));
  assert.throws(() => verifyPrototypeConnectorStartup(h.root), /outer preview boundary/);
});

test('interrupted connector startup resumes its exact pending files but cannot overwrite a new UI edit', { skip: !MODULES }, async (t) => {
  const h = await project(t);
  const originalRename = fs.renameSync;
  let failed = false;
  fs.renameSync = (from, to) => {
    if (!failed && to === path.join(h.root, STATE)) { failed = true; throw new Error('fixture interrupted startup'); }
    return originalRename(from, to);
  };
  try { assert.throws(() => stagePrototypeConnectorStartup(h.root, h.input), /interrupted startup/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(fs.existsSync(path.join(h.root, PENDING)), true);
  const generatedRoot = read(h.root, 'app/_layout.tsx');
  write(h.root, 'app/_layout.tsx', `${generatedRoot}\n// New foreground edit\n`);
  assert.throws(() => stagePrototypeConnectorStartup(h.root, h.input), /conflicts with an unrelated edit/);
  write(h.root, 'app/_layout.tsx', generatedRoot);
  const schema = read(h.root, '.power/schemas/Directory/Directory.Schema.json');
  write(h.root, '.power/schemas/Directory/Directory.Schema.json', { name: 'Directory', properties: { primaryRuntimeUrl: 'https://changed.example.invalid' } });
  assert.throws(() => stagePrototypeConnectorStartup(h.root, h.input), /inputs changed/);
  write(h.root, '.power/schemas/Directory/Directory.Schema.json', schema);
  assert.equal(stagePrototypeConnectorStartup(h.root, h.input).resumed, true);
  assert.equal(verifyPrototypeConnectorStartup(h.root).ok, true);
  assert.equal(fs.existsSync(path.join(h.root, PENDING)), false);
});

test('retained local queries remain offline and candidate writes/discard never touch the active namespace', { skip: !MODULES }, async (t) => {
  const h = await project(t);
  stagePrototypeConnectorStartup(h.root, h.input);
  const storage = new Map();
  const store = (preview) => createLocalStore({
    domain: h.domain, fixtures: { entities: { Appointment: [{ id: 'appointment-one', title: 'Active record' }] } },
    storage: { getItem: async (key) => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); }, removeItem: async (key) => { storage.delete(key); } },
    files: { documentDirectory: null }, randomUUID: () => crypto.randomUUID(), assertRules: () => {}, core, preview,
  });
  const active = store({ previewKind: 'active', dataNamespace: 'active' });
  await active.repositories.Appointment.update('appointment-one', { title: 'Saved before connector' });
  const activeBytes = [...storage.entries()].find(([key]) => key.endsWith(':active'))[1];
  const candidate = store(json(h.root, CONFIG).preview);
  const { QueryClient, onlineManager } = createRequire(path.join(h.root, 'package.json'))('@tanstack/react-query');
  onlineManager.setOnline(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => { client.clear(); onlineManager.setOnline(true); });
  const result = await client.fetchQuery({ queryKey: ['candidate', 'appointments'], networkMode: 'always', queryFn: () => candidate.repositories.Appointment.list() });
  assert.equal(result.items[0].title, 'Saved before connector');
  await candidate.repositories.Appointment.update('appointment-one', { title: 'Candidate only' });
  await candidate.discardCandidate();
  assert.equal([...storage.entries()].find(([key]) => key.endsWith(':active'))[1], activeBytes);
  assert.equal((await active.repositories.Appointment.get('appointment-one')).title, 'Saved before connector');
});

test('standalone connector data activation is exact-source, refuses Player, and rolls back its own files on validation failure', { skip: !MODULES }, async (t) => {
  const h = await project(t);
  stagePrototypeConnectorStartup(h.root, h.input);
  const before = captureSource(h.root);
  const args = { expectedSourceRevision: before.revision, confirmStandaloneApply: true };
  assert.throws(() => activatePrototypeConnectorData(h.root, args, { env: { MOBILE_AUTHORING_CONTEXT: 'fixture' } }), /publisher-owned/);
  assert.throws(() => activatePrototypeConnectorData(h.root, { ...args, expectedSourceRevision: '0'.repeat(64) }, { env: {} }), /changed before Apply/);
  const files = [CONFIG, STATE, '.tmp/prototype-profile.json', '.tmp/prototype-generated.json'];
  const original = Object.fromEntries(files.map((file) => [file, read(h.root, file)]));
  assert.throws(() => activatePrototypeConnectorData(h.root, args, { env: {}, validateProject: () => { throw new Error('fixture validation failure'); } }), /validation failure/);
  for (const [file, bytes] of Object.entries(original)) assert.equal(read(h.root, file), bytes, file);
  assert.equal(captureSource(h.root).revision, before.revision);
  const result = activatePrototypeConnectorData(h.root, args, { env: {} });
  assert.equal(result.published, false);
  assert.equal(result.requiresReload, true);
  assert.deepEqual(json(h.root, CONFIG).preview, { previewKind: 'active', dataNamespace: 'active' });
  assert.equal(verifyPrototypeConnectorStartup(h.root).ok, true);
  for (const [file, hash] of Object.entries(h.priorOwned)) assert.equal(sha256Hex(read(h.root, file)), hash, file);
  assert.equal(json(h.root, '.tmp/data-access-registry.json').mode, 'local-prototype');
});
