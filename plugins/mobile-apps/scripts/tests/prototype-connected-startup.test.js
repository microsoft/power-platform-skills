'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { preparePrototype } = require('../prepare-prototype');
const { compilePersistenceContract } = require('../compile-persistence-contract');
const { configureMobileAuthoring } = require('../lib/authoring-runtime');
const { configurePrototypeAuthoring, rootContent } = require('../lib/prototype-authoring');
const { readConnectionCatalog } = require('../lib/prototype-connections');
const connector = require('../lib/prototype-connector-startup');
const { connectedProviderSource, wireConnectedRoot } = require('../lib/prototype-connected-startup');
const { stageConnectedStartup, generateDataverseRepositories } = require('../lib/dataverse-repository-generator');
const { captureSource } = require('../lib/authoring-source');
const { revision, writeOwnedFiles } = require('../lib/prototype-files');
const { sha256Hex } = require('../lib/product-experience-contracts');
const { createDataverseRepositories } = require('../lib/dataverse-repository-runtime');
const repositoryCore = require('../lib/prototype-repository-core');

const PLUGIN = path.resolve(__dirname, '../..');
const MODULES = process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES;
const APP = '22222222-2222-4222-8222-222222222222';
const ENV = '11111111-2222-4333-8444-555555555555';
const TENANT = '44444444-4444-4444-8444-444444444444';
const API = 'shared_office365users';
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (root, file) => JSON.parse(read(root, file));
function write(root, file, value) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
}
function rebind(root, file, field, update) {
  const value = json(root, file);
  update(value);
  delete value[field];
  value[field] = revision(value);
  write(root, file, value);
}

function schemas(root) {
  const result = spawnSync('npm', ['run', 'generate-schemas', '--silent'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function typecheck(root) {
  const compiler = createRequire(path.join(root, 'package.json')).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--project', path.join(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function project(t, { withConnector = false, authoring = 'generated', active = false, reference = false, retainedEntity = false } = {}) {
  const root = path.join(path.resolve(PLUGIN, '../..'), `.prototype-connected-work-${crypto.randomUUID()}`);
  fs.cpSync(path.join(PLUGIN, 'template'), root, { recursive: true, filter: (file) => !file.includes(`${path.sep}node_modules`) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.resolve(MODULES), path.join(root, 'node_modules'), 'dir');
  const app = json(root, 'app.json');
  app.expo.extra.telemetry = { appInstanceId: APP };
  write(root, 'app.json', app);
  const entityNames = ['Appointment', ...(retainedEntity ? ['Directory'] : [])];
  const domain = {
    schemaVersion: 1, appInstanceId: APP, schemaVersionNumber: 1,
    entities: entityNames.map((id) => ({ id, label: id, fields: [{ id: 'title', label: 'Title', type: 'text', required: true }], operations: ['list', 'get', 'create', 'update', 'delete'] })),
    actions: [{ id: 'saveAppointment', label: 'Save', entityId: 'Appointment', operation: 'save' }],
  };
  const scope = { dataEntities: entityNames.map((name) => ({ name, role: 'primary', realization: 'local-configuration' })) };
  const architecture = { schemaVersion: 1, connectors: [], nativeCapabilities: [],
    conceptOwners: entityNames.map((name) => ({ conceptId: name.toLowerCase(), owner: 'local', reason: 'Existing local records.' })) };
  const persistence = compilePersistenceContract(scope, architecture);
  const facts = {
    schemaVersion: 1, contractType: 'scenario-facts', scopeRevision: persistence.scopeRevision, persistenceRevision: persistence.persistenceRevision,
    records: entityNames.map((name) => ({ id: `${name.toLowerCase()}-one`, conceptId: name.toLowerCase(), fields: { title: `Retain ${name}` } })),
    relationships: [], scenarios: [], mediaAssets: [], screenBindings: [], invariants: [],
  };
  facts.scenarioRevision = revision(facts);
  write(root, '.tmp/prototype-domain.json', domain);
  write(root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: entityNames.map((name) => ({ entityId: name, conceptId: name.toLowerCase() })) });
  write(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
  write(root, '.tmp/persistence-contract.json', persistence);
  write(root, '.tmp/scenario-facts.json', facts);
  write(root, '.tmp/navigation-manifest.json', { screens: { home: { targetPath: '/home' } } });
  write(root, 'native-app-plan.md', '# Approved conversion fixture\n');
  preparePrototype(root, { displayName: 'Connected fixture', slug: 'connected-fixture', entryRoute: '/home' });
  write(root, 'app/(app)/home.tsx', `import { Text } from 'react-native';
import { useEntityList } from '@/data';
export default function Home() { const rows = useEntityList('Appointment'); return <Text>{rows.data?.items[0]?.title}</Text>; }
`);
  write(root, '.tmp/compiled-screen-build-pack.json', { contractType: 'compiled-screen-build-pack', screens: [{ screenId: 'home', route: '/home' }] });
  write(root, 'app/_layout.tsx', `import { Slot } from 'expo-router';
import { Text } from 'react-native';
import { PrototypeProvider } from '../src/data/PrototypeProvider';
const currentChrome = 'Actual current UI, not the saved template';
export default function RootLayout() {
  return <PrototypeProvider><Text>{currentChrome}</Text><Slot /></PrototypeProvider>;
}
`);
  if (authoring === 'generated') configurePrototypeAuthoring(root, { screenSources: [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx' }] });
  if (authoring === 'inline') {
    write(root, '.tmp/authoring-registry.json', { schemaVersion: 1, appInstanceId: APP, screens: [{ screenId: 'home', route: '/home', sourceFile: 'app/(app)/home.tsx', targets: [] }] });
    configureMobileAuthoring(root);
    write(root, 'app/_layout.tsx', `import { AuthoringProvider } from '../src/authoring';
import { configureDataPreview } from '../src/data/runtime';
${read(root, 'app/_layout.tsx').replace('return <PrototypeProvider>', 'return <AuthoringProvider configureDataPreview={configureDataPreview}><PrototypeProvider>')
    .replace('</PrototypeProvider>;', '</PrototypeProvider></AuthoringProvider>;')}`);
  }
  function successor() {
    const next = compilePersistenceContract(scope, architecture);
    write(root, '.tmp/persistence-contract.json', next);
    rebind(root, '.tmp/scenario-facts.json', 'scenarioRevision', (value) => {
      value.scopeRevision = next.scopeRevision;
      value.persistenceRevision = next.persistenceRevision;
    });
  }
  write(root, 'auth.config.json', { msal: { clientId: '33333333-3333-4333-8333-333333333333', tenantId: TENANT } });
  let retainedAdapter;
  if (withConnector) {
    architecture.connectors.push({ apiName: 'directory', displayName: 'Directory', approved: true });
    successor();
    write(root, 'power.config.json', { environmentId: ENV, appDisplayName: 'Connected fixture', connectionReferences: {
      directory_ref: { id: `/providers/Microsoft.PowerApps/apis/${API}`, dataSources: ['Directory'] },
      other_directory_ref: { id: `/providers/Microsoft.PowerApps/apis/${API}`, dataSources: ['OtherDirectory'], sharedConnectionId: 'other-same-api-connection' },
    } });
    for (const name of ['Directory', 'OtherDirectory']) {
      write(root, `.power/schemas/${name}/${name}.Schema.json`, { name, properties: { primaryRuntimeUrl: 'https://runtime.example.invalid' } });
    }
    schemas(root);
    const catalog = await readConnectionCatalog({ environmentId: ENV, references: reference }, {
      getToken: async () => 'offline-catalog-fixture',
      resolveEnvironment: async () => ({ environmentId: ENV, environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: TENANT }),
      requestJson: async (url) => ({
        value: String(url).includes('/connectionreferences?')
          ? [{ connectorid: `/providers/Microsoft.PowerApps/apis/${API}`, connectionid: 'chosen-directory',
            connectionreferencelogicalname: 'directory_ref', connectionreferencedisplayname: 'Approved reference', statecode: 0 }]
          : ['chosen-directory', 'other-same-api-connection'].map((name) => ({ name, properties: { apiId: API, statuses: [{ status: 'Connected' }] } })),
      }),
    });
    connector.stagePrototypeConnectorStartup(root, {
      catalog, connectorName: 'directory', localRefId: 'directory_ref',
      selection: { kind: 'connector', apiId: API, environmentId: ENV, catalogRevision: catalog.catalogRevision,
        ...(reference ? { connectionRef: 'directory_ref' } : { connectionId: 'chosen-directory' }) },
      preview: { previewKind: 'candidate', dataNamespace: 'old-local-candidate', baseDataNamespace: 'active' },
    });
    if (active) connector.activatePrototypeConnectorData(root, {
      confirmStandaloneApply: true, expectedSourceRevision: captureSource(root).revision,
    }, { env: {}, validateProject: () => {} });
    for (const file of ['app/login.tsx', 'app/oauth-callback.tsx']) fs.appendFileSync(path.join(root, file), '\n// Current auth UI must survive Dataverse conversion.\n');
    if (retainedEntity) {
      scope.dataEntities.find((entry) => entry.name === 'Directory').realization = 'connector-source';
      architecture.conceptOwners.find((entry) => entry.conceptId === 'directory').owner = 'connector:directory';
      const file = 'src/data/repositories/retained-directory.ts';
      const bytes = `import type { Repository } from '../contracts';
import type { EntityMap } from '../model';
const unavailable = async (): Promise<never> => { throw new Error('Existing connector unavailable; no local fallback'); };
export const DirectoryRepository: Repository<EntityMap['Directory']> = {
  list: unavailable, get: unavailable, create: unavailable, update: unavailable, delete: unavailable,
};
`;
      writeOwnedFiles(root, { [file]: bytes }, json(root, '.tmp/prototype-generated.json').inputRevisions);
      retainedAdapter = { file, exportName: 'DirectoryRepository', sha256: sha256Hex(bytes) };
      rebind(root, '.tmp/data-access-registry.json', 'registryRevision', (registry) => {
        registry.entities.find((entry) => entry.entityId === 'Directory').owner = 'connector:directory';
      });
    }
  } else write(root, 'power.config.json', { environmentId: ENV, appDisplayName: 'Connected fixture' });
  const oldRoot = read(root, 'app/_layout.tsx');
  scope.dataEntities.find((entry) => entry.name === 'Appointment').realization = 'existing-table';
  architecture.conceptOwners.find((entry) => entry.conceptId === 'appointment').owner = 'dataverse';
  successor();
  const config = json(root, 'power.config.json');
  config.databaseReferences = { 'default.cds': { dataSources: { appointment: { logicalName: 'cr_appointment', entitySetName: 'appointments' } } } };
  config.version ??= '1.0';
  write(root, 'power.config.json', JSON.stringify(config, null, 2));
  write(root, '.power/schemas/Appointments/Appointments.Schema.json', { name: 'Appointments', properties: { primaryRuntimeUrl: 'https://contoso.crm.dynamics.com' } });
  // SDK-signature fixture only: production service files remain official-tool-owned.
  const service = `import type { IOperationOptions, IOperationResult } from '@microsoft/power-apps/data';
type IGetAllOptions = IOperationOptions; type IGetOptions = IOperationOptions;
interface AppointmentRow { cr_appointmentid?: string; cr_title: string; }
export class AppointmentsService {
  public static async getAll(options?: IGetAllOptions): Promise<IOperationResult<AppointmentRow[]>> { throw new Error('Offline fixture'); }
  public static async get(id: string, options?: IGetOptions): Promise<IOperationResult<AppointmentRow>> { throw new Error('Offline fixture'); }
  public static async create(record: AppointmentRow): Promise<IOperationResult<AppointmentRow>> { throw new Error('Offline fixture'); }
  public static async update(id: string, record: Partial<AppointmentRow>): Promise<IOperationResult<AppointmentRow>> { throw new Error('Offline fixture'); }
  public static async delete(id: string): Promise<IOperationResult<void>> { throw new Error('Offline fixture'); }
}
`;
  write(root, 'src/generated/services/AppointmentsService.ts', service);
  schemas(root);
  const schema = { schemaVersion: 1, tables: [{ logicalName: 'cr_appointment', plannedDecision: 'reuse', serviceRequired: true,
    columns: [{ logicalName: 'cr_title', type: 'string', plannedDecision: 'reuse' }] }] };
  write(root, '.tmp/dataverse-schema-contract.json', schema);
  write(root, '.tmp/prototype-materialized-snapshot.json', { tables: [{
    logicalName: 'cr_appointment', entitySetName: 'appointments', primaryIdAttribute: 'cr_appointmentid',
    detailLevel: 'full', missingDetailClasses: [], columns: [{ logicalName: 'cr_title', type: 'String' }],
  }] });
  write(root, '.tmp/prototype-relationship-evidence.json', {});
  write(root, '.tmp/prototype-dataverse-mapping-input.json', { schemaVersion: 1, domainRevision: revision(domain), schemaRevision: revision(schema),
    entities: [{
      entityId: 'Appointment', owner: 'dataverse', decision: 'reuse', logicalName: 'cr_appointment',
      serviceFile: 'AppointmentsService.ts', serviceExport: 'AppointmentsService', serviceSha256: sha256Hex(service), fields: [{ fieldId: 'title', column: 'cr_title' }],
    }, ...(retainedAdapter ? [{ entityId: 'Directory', owner: 'connector:directory', decision: 'defer', retainedAdapter }] : [])],
  });
  write(root, 'app/(app)/_layout.tsx', `import { Stack } from 'expo-router';
export default function CurrentAppGroup() { return <Stack screenOptions={{ title: 'Current navigation UI' }} />; }
`);
  generateDataverseRepositories(root);
  return { root, oldRoot, domain, retainedAdapter };
}

function evaluate(root, source, requireValue) {
  const ts = createRequire(path.join(root, 'package.json'))('typescript');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: requireValue, __DEV__: true, Error }, { timeout: 1000 });
  return exports;
}

function providerProps(root, source, config = json(root, 'power.config.json'), offlineProfile) {
  const requireValue = (id) => {
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === 'react') return { useEffect: () => {} };
    if (id === 'react-native') return { useColorScheme: () => 'dark' };
    if (id === 'react-native-safe-area-context') return { SafeAreaProvider: 'SafeAreaProvider' };
    if (id === '@microsoft/power-apps-native-host') return { PowerAppsProvider: 'PowerAppsProvider' };
    if (id === '@tanstack/react-query') return { useQueryClient: () => assert.fail('No rendering or network work in this fixture') };
    if (id === '../../power.config.json') return config;
    if (id === '../../app.json' || id === '../../auth.config.json') return json(root, id.slice(6));
    if (id === '../../tamagui.config') return {};
    if (id === './connector-startup.json') return json(root, connector.CONFIG);
    if (id === '../generated/connectorSchemas') return { schemaMap: { Directory: {}, OtherDirectory: {} } };
    if (id === './runtime') return { getDataRuntime: () => assert.fail('No local runtime fallback during provider composition') };
    if (id === '../../offline-profile.json') {
      if (offlineProfile !== undefined) return offlineProfile;
      throw new Error("Cannot find module '../../offline-profile.json'");
    }
    assert.fail(`Unexpected generated provider import: ${id}`);
  };
  return evaluate(root, source, requireValue).ConnectedProvider({ children: 'actual-current-child' }).props.children.props;
}

function assertCandidateDefault(root) {
  let configured;
  const runtime = evaluate(root, read(root, 'src/data/runtime.ts'), (id) => {
    if (id === './repositories/local') return { createLocalRuntime: () => ({ repositories: {} }) };
    if (id === './repositories/live') return { createLiveRuntime: (preview) => { configured = preview; return { repositories: {} }; } };
    assert.fail(`Unexpected runtime import: ${id}`);
  });
  runtime.getDataRuntime();
  assert.equal(configured.previewKind, 'candidate');
  assert.equal(configured.dataNamespace, 'connected-preview');
}

test('local-to-Dataverse startup keeps current UI/authoring and the installed host auth/offline contract', { skip: !MODULES }, async (t) => {
  const h = await project(t);
  const screen = read(h.root, 'app/(app)/home.tsx');
  const official = read(h.root, 'power.config.json');
  const result = stageConnectedStartup(h.root);
  assert.ok(result.files.includes('src/data/ConnectedProvider.tsx'));
  assert.equal(read(h.root, 'app/_layout.tsx'), h.oldRoot.replace("import { PrototypeProvider } from '../src/data/PrototypeProvider';",
    "import { ConnectedProvider as PrototypeProvider } from '../src/data/ConnectedProvider';"));
  assert.equal(read(h.root, 'app/(app)/home.tsx'), screen);
  assert.equal(read(h.root, 'power.config.json'), official);
  assert.equal(configurePrototypeAuthoring(h.root, { check: true }).rootWired, true);
  const provider = read(h.root, 'src/data/ConnectedProvider.tsx');
  assert.doesNotMatch(provider, /from ['"]expo-(?:router|status-bar)['"]/);
  assert.match(provider, /require\(["']\.\.\/\.\.\/offline-profile.json["']\)/);
  assert.match(provider, /Cannot find module '\.\.\/\.\.\/offline-profile.json'/);
  const props = providerProps(h.root, provider);
  assert.equal(props.msalConfig.clientId, json(h.root, 'auth.config.json').msal.clientId);
  assert.equal(props.offlineProfile, undefined);
  assert.equal(props.defaultTheme, 'dark');
  assert.equal(props.children[1], 'actual-current-child');
  assertCandidateDefault(h.root);
  typecheck(h.root);
});

test('saved host aliases retain the same connector pin compiler and optional offline profile', { skip: !MODULES }, async (t) => {
  const h = await project(t, { withConnector: true });
  const backup = json(h.root, '.tmp/prototype-connected-template.json');
  backup.files['app/_layout.tsx'] = backup.files['app/_layout.tsx']
    .replace('import { Slot }', 'import { Slot as RouteOutlet }').replace('<Slot />', '<RouteOutlet />')
    .replace('import { PowerAppsProvider }', 'import { PowerAppsProvider as NativeHost }')
    .replaceAll('<PowerAppsProvider', '<NativeHost').replaceAll('</PowerAppsProvider>', '</NativeHost>')
    .replace('import powerConfig ', 'import selectedPower ').replace('powerConfig={powerConfig}', 'powerConfig={selectedPower}')
    .replace('import { schemaMap }', 'import { schemaMap as generatedSchemas }').replace('schemaMap={schemaMap}', 'schemaMap={generatedSchemas}');
  write(h.root, '.tmp/prototype-connected-template.json', backup);
  stageConnectedStartup(h.root);
  const provider = read(h.root, 'src/data/ConnectedProvider.tsx');
  assert.doesNotMatch(provider, /RouteOutlet/);
  assert.match(provider, /ComponentProps<typeof NativeHost>/);
  assert.match(provider, /officialConfig: HostConfig = selectedPower/);
  const offline = { profileId: 'offline-profile-fixture', tables: ['cr_appointment'] };
  const props = providerProps(h.root, provider, json(h.root, 'power.config.json'), offline);
  assert.equal(props.offlineProfile, offline);
  assert.equal(props.powerConfig.connectionReferences.directory_ref.sharedConnectionId, 'chosen-directory');
  typecheck(h.root);
});

for (const [authoring, reference] of [['generated', true], ['inline', false], ['none', false]]) {
  test(`connector-to-Dataverse preserves ${authoring} authoring/root and exact ${reference ? 'reference' : 'connection'} pins`, { skip: !MODULES }, async (t) => {
    const h = await project(t, { withConnector: true, authoring, reference, active: true, retainedEntity: authoring === 'generated' });
    const protectedFiles = ['power.config.json', 'auth.config.json', 'src/generated/connectorSchemas.ts', 'src/generated/services/AppointmentsService.ts',
      'app/(app)/home.tsx', 'app/login.tsx', 'app/oauth-callback.tsx', connector.STATE, connector.CONFIG, connector.PROVIDER, connector.BOUNDARY,
      '.tmp/prototype-domain.json', '.tmp/prototype-rules.json', '.tmp/scenario-facts.json', '.tmp/dataverse-schema-contract.json'];
    const before = Object.fromEntries(protectedFiles.map((file) => [file, read(h.root, file)]));
    assert.equal(json(h.root, connector.CONFIG).preview.previewKind, 'active');
    stageConnectedStartup(h.root);
    const root = read(h.root, 'app/_layout.tsx');
    assert.doesNotMatch(root, /ConnectorPreviewBoundary|ConnectorPrototypeRoot/);
    assert.match(root, /Actual current UI, not the saved template/);
    assert.match(root, new RegExp(`export default function ${authoring === 'generated' ? 'MobileAuthoringRoot' : 'RootLayout'}`));
    if (authoring === 'generated') {
      const ts = createRequire(path.join(h.root, 'package.json'))('typescript');
      assert.equal(rootContent(ts, ts.createSourceFile('root.tsx', root, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)).name.text, 'RootLayout');
      assert.equal(configurePrototypeAuthoring(h.root, { check: true }).rootWired, true);
    }
    if (authoring === 'inline') assert.match(root, /<AuthoringProvider configureDataPreview=\{configureDataPreview\}><PrototypeProvider>/);
    for (const [file, bytes] of Object.entries(before)) assert.equal(read(h.root, file), bytes, file);
    const provider = read(h.root, 'src/data/ConnectedProvider.tsx');
    assert.equal(connectedProviderSource(h.root, json(h.root, '.tmp/prototype-connected-template.json').files['app/_layout.tsx']), provider);
    assert.doesNotMatch(provider, /configureDataPreview|startup\.preview|ConnectorPreviewBoundary|development-only/);
    const props = providerProps(h.root, provider);
    assert.ok(props.powerConfig.databaseReferences['default.cds']);
    assert.equal(props.powerConfig.connectionReferences.directory_ref.sharedConnectionId, 'chosen-directory');
    assert.equal(props.powerConfig.connectionReferences.other_directory_ref.sharedConnectionId, 'other-same-api-connection');
    assert.equal(json(h.root, 'power.config.json').connectionReferences.directory_ref.sharedConnectionId, undefined);
    assert.throws(() => providerProps(h.root, provider, { ...json(h.root, 'power.config.json'), environmentId: APP }), /approved connector environment/);
    assertCandidateDefault(h.root);
    if (h.retainedAdapter) {
      assert.match(read(h.root, 'src/data/repositories/live.ts'), /checkedRetained0 as unknown as Repository<EntityRecord>/);
      const retained = evaluate(h.root, read(h.root, h.retainedAdapter.file), () => assert.fail('Type-only imports must be erased'));
      let writes = 0;
      const repositories = createDataverseRepositories({
        domain: h.domain, mapping: json(h.root, '.tmp/prototype-dataverse-mapping.json'),
        services: { Appointment: { getAll: async () => { throw new Error('Dataverse unavailable'); }, create: async () => { writes += 1; } } },
        core: repositoryCore, assertRules: () => {}, storage: {}, randomUUID: () => APP, media: {},
        preview: { previewKind: 'candidate', dataNamespace: 'connected-preview' },
        localRepositories: {
          Appointment: { list: () => assert.fail('A Dataverse entity must not fall back to old local fixtures') },
          Directory: retained.DirectoryRepository,
        },
      });
      await assert.rejects(repositories.Appointment.list(), /Dataverse unavailable/);
      await assert.rejects(repositories.Directory.list(), /no local fallback/);
      await assert.rejects(repositories.Appointment.create({ title: 'Unapproved write' }), /read-only/);
      await assert.rejects(repositories.Directory.create({ title: 'Unapproved connector write' }), /separate explicit approval/);
      assert.equal(writes, 0);
    }
    const staged = captureSource(h.root).revision;
    stageConnectedStartup(h.root);
    assert.equal(captureSource(h.root).revision, staged, 'connected startup must be idempotent');
    typecheck(h.root);
  });
}

test('wrong environment, canonical bindings or compiler-owned connector tampering fail before any startup writes', { skip: !MODULES }, async (t) => {
  const h = await project(t, { withConnector: true });
  const cases = [
    ['power.config.json', (value) => { value.environmentId = APP; }, /environment|binding/],
    [connector.STATE, (value) => { value.bindings[0].connectionId = 'replacement'; }, /revision/],
    [connector.CONFIG, (value) => { value.bindings[0].connectionId = 'replacement'; }, /canonical bindings|Compiler-owned/],
    ['power.config.json', (value) => { delete value.connectionReferences.directory_ref; }, /reference\/connection/],
    ['power.config.json', (value) => {
      value.connectionReferences.directory_ref.dataSources = ['OtherDirectory'];
      value.connectionReferences.other_directory_ref.dataSources = ['Directory'];
    }, /reference\/connection configuration/],
    ['.tmp/prototype-domain.json', (value) => { value.entities[0].label = 'Unapproved domain'; }, /canonical domain/],
    ['.power/schemas/Directory/Directory.Schema.json', (value) => { value.properties.primaryRuntimeUrl = 'https://changed.example.invalid'; }, /schema bindings/],
  ];
  for (const [file, change, pattern] of cases) {
    const original = read(h.root, file);
    const value = JSON.parse(original);
    change(value);
    write(h.root, file, value);
    const before = captureSource(h.root).revision;
    assert.throws(() => stageConnectedStartup(h.root), pattern, file);
    assert.equal(captureSource(h.root).revision, before, file);
    write(h.root, file, original);
  }
  for (const file of [connector.PROVIDER, connector.BOUNDARY]) {
    const original = read(h.root, file);
    write(h.root, file, `${original}\n// Unowned change\n`);
    assert.throws(() => stageConnectedStartup(h.root), /Compiler-owned connector startup/);
    write(h.root, file, original);
  }
  assert.equal(fs.existsSync(path.join(h.root, 'src/data/ConnectedProvider.tsx')), false);
  assert.equal(read(h.root, 'app/_layout.tsx'), h.oldRoot);
});

test('only the exact compiler wrapper is unwrapped and altered authoring order is rejected', { skip: !MODULES }, async (t) => {
  const h = await project(t, { withConnector: true });
  const root = h.oldRoot;
  const edits = [
    (source) => source.replace('<ConnectorPreviewBoundary><MobileAuthoringRoot />', '<ConnectorPreviewBoundary><Text>Current extra UI</Text><MobileAuthoringRoot />'),
    (source) => source.replace('function ConnectorPrototypeRoot()', 'function CustomConnectorRoot()'),
    (source) => `${source}\nfunction AnotherBoundary() { return <ConnectorPreviewBoundary><Text>Keep this UI</Text></ConnectorPreviewBoundary>; }\n`,
    (source) => source.replace('<ConnectorPreviewBoundary>', '<ConnectorPreviewBoundary key="custom">'),
    (source) => source.replace('configureDataPreview={configureDataPreview}', 'configureDataPreview={() => {}}'),
    (source) => source.replace('import { PrototypeConnectorProvider as PrototypeProvider }', 'import OtherCurrentUI, { PrototypeConnectorProvider as PrototypeProvider }'),
  ];
  for (const edit of edits) {
    const changed = edit(root);
    write(h.root, 'app/_layout.tsx', changed);
    assert.throws(() => stageConnectedStartup(h.root), /wrapper|authoring|Authoring|data before|root must|integration/);
    assert.equal(read(h.root, 'app/_layout.tsx'), changed);
    assert.equal(fs.existsSync(path.join(h.root, 'src/data/ConnectedProvider.tsx')), false);
  }
  write(h.root, 'app/_layout.tsx', root);
  const standalone = wireConnectedRoot(h.root, root);
  assert.match(standalone, /export default function MobileAuthoringRoot/);
  assert.doesNotMatch(standalone, /ConnectorPreviewBoundary/);
});
