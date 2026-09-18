'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const edit = require('../lib/authoring-edit');
const integrations = require('../lib/authoring-edit-integration');
const { runCandidateChecks } = require('../lib/mobile-authoring-candidate');
const {
  DERIVED_FILES, RUNTIME_HELPERS, RUNTIME_INSTALL_FILES, registeredReadyScreenIds,
} = require('../lib/mobile-authoring-registration');
const { configurePrototypeAuthoring } = require('../lib/prototype-authoring');
const { configureMobileAuthoring } = require('../lib/authoring-runtime');
const { compilePersistenceContract } = require('../compile-persistence-contract');
const { preparePrototype } = require('../prepare-prototype');
const { readConnectionCatalog } = require('../lib/prototype-connections');
const { stagePrototypeConnectorStartup, verifyPrototypeConnectorStartup } = require('../lib/prototype-connector-startup');
const { revision } = require('../lib/prototype-files');
const { captureSource, captureSnapshot } = require('../lib/authoring-source');
const { digest } = require('../lib/mobile-authoring-files');

process.env.POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT = '1';
const PLUGIN = path.resolve(__dirname, '../..');
const MODULES = process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES;
const OPTIONS = { skip: !MODULES && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to the installed selected template' };
const SOURCE = 'app/(app)/work.tsx';
const SCREEN = 'inspection-overview';
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (root, file) => JSON.parse(read(root, file));

function write(root, file, value) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function project(t, { configured = true } = {}) {
  const root = path.join(__dirname, `.authoring-registration-work-${crypto.randomUUID()}`);
  fs.cpSync(path.join(PLUGIN, 'template'), root, {
    recursive: true, filter: (file) => !file.includes(`${path.sep}node_modules`),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(MODULES, path.join(root, 'node_modules'), 'dir');
  const appInstanceId = crypto.randomUUID();
  const app = json(root, 'app.json');
  app.expo.extra.telemetry = { appInstanceId };
  write(root, 'app.json', app);
  const scope = { dataEntities: [{ name: 'Inspection', role: 'primary', realization: 'local-configuration' }] };
  const architecture = {
    schemaVersion: 1, connectors: [], nativeCapabilities: [],
    conceptOwners: [{ conceptId: 'inspection', owner: 'local', reason: 'Keep existing local inspections.' }],
  };
  const persistence = compilePersistenceContract(scope, architecture);
  const facts = {
    schemaVersion: 1, contractType: 'scenario-facts',
    scopeRevision: persistence.scopeRevision, persistenceRevision: persistence.persistenceRevision,
    records: [{ id: 'existing-inspection', conceptId: 'inspection', fields: { title: 'Existing inspection' } }],
    relationships: [], scenarios: [], mediaAssets: [], screenBindings: [], invariants: [],
  };
  facts.scenarioRevision = revision(facts);
  write(root, '.tmp/prototype-domain.json', {
    schemaVersion: 1, schemaVersionNumber: 1, appInstanceId,
    entities: [{
      id: 'Inspection', label: 'Inspection', operations: ['list', 'get', 'create', 'update', 'delete'],
      fields: [{ id: 'title', label: 'Title', type: 'text', required: true }, { id: 'photo', label: 'Photo', type: 'photo' }],
    }],
    actions: [{ id: 'saveInspection', label: 'Save inspection', entityId: 'Inspection', operation: 'save' }],
  });
  write(root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [{ entityId: 'Inspection', conceptId: 'inspection' }] });
  write(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
  write(root, '.tmp/persistence-contract.json', persistence);
  write(root, '.tmp/scenario-facts.json', facts);
  write(root, '.tmp/architecture-decisions.json', architecture);
  write(root, '.tmp/navigation-manifest.json', { screens: { [SCREEN]: { targetPath: '/work' } } });
  write(root, 'native-app-plan.md', '# Approved local authoring fixture\n');
  preparePrototype(root, { displayName: 'Authoring fixture', slug: 'authoring-fixture', entryRoute: '/work' });
  write(root, SOURCE, `import { Text } from 'react-native';
import { AuthoringScreen, AuthoringTarget } from '@/authoring';
export const authoringTargets = [{ id: 'inspection.collection', label: 'Inspections', role: 'collection' }] as const;
export default function Work() {
  return <AuthoringScreen screenId="${SCREEN}" ready={true} hasUnsavedChanges={false}>
    <AuthoringTarget targetId="inspection.collection"><Text>Inspections</Text></AuthoringTarget>
  </AuthoringScreen>;
}
`);
  write(root, '.tmp/compiled-screen-build-pack.json', {
    schemaVersion: 1, contractType: 'compiled-screen-build-pack', screens: [{ screenId: SCREEN, route: '/work' }],
  });
  const sources = [{ screenId: SCREEN, sourceFile: SOURCE }];
  if (configured) configurePrototypeAuthoring(root, { screenSources: sources, readyScreenIds: [SCREEN] });
  const descriptor = {
    protocolVersion: 2, appInstanceId, jobId: 'authoring-edit', attemptId: 'attempt-one', operation: 'edit',
    workspaceDir: root, baseRevision: captureSource(root).revision,
  };
  const decisions = new Map();
  const client = {
    descriptor, verify: async () => ({ active: true }), assertSafe: () => {},
    requestQuestion: async (question, options) => {
      const receiptPath = `.devplayer-builder/logs/fixture-decision-${decisions.size}.json`;
      const binding = options.recordGate ? { type: 'gate', gate: options.recordGate }
        : { files: options.bind.map((file) => ({ path: file })) };
      const value = { question, binding, receipt: { action: 'approve' }, receiptPath };
      decisions.set(receiptPath, value);
      return value;
    },
    verifySavedDecision: async (receiptPath, options) => {
      const saved = decisions.get(receiptPath);
      assert.ok(saved);
      assert.equal(saved.question.gateId, options.gateId);
      return saved;
    },
  };
  return {
    root, scope, architecture, sources, descriptor, client,
    proposal: {
      schemaVersion: 1, kind: 'screen', summary: 'Update the authored collection label',
      screenIds: [SCREEN], allowedFiles: [SOURCE, ...DERIVED_FILES],
    },
  };
}

function candidateRunner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === path.join(PLUGIN, 'scripts/configure-prototype-authoring.js')) {
      return spawnSync(command, args, options);
    }
    return { status: 0, stdout: JSON.stringify({ issues: [] }) };
  };
}

function typecheck(root) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--incremental', 'false'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('candidate wiring runs the actual read-only authoring check with registered IDs and preserves inactive publisher state', OPTIONS, (t) => {
  const f = project(t);
  const before = captureSnapshot(f.root);
  const stamp = read(f.root, '.devplayer-builder/runtime.json');
  const calls = [];
  assert.deepEqual(registeredReadyScreenIds(f.root, [SOURCE]), [SCREEN]);
  assert.throws(() => registeredReadyScreenIds(f.root, [SOURCE, SOURCE]), /unique/);
  assert.throws(() => registeredReadyScreenIds(f.root, ['app/unregistered.tsx']), /explicitly registered/);
  const checks = runCandidateChecks(f.root, [SOURCE], { run: candidateRunner(calls) });
  const registration = calls.filter((entry) => entry.args[0] === path.join(PLUGIN, 'scripts/configure-prototype-authoring.js'));
  assert.equal(registration.length, 1);
  assert.deepEqual(registration[0].args.slice(1), ['--project-root', f.root, '--check', '--ready-screen', SCREEN]);
  assert.equal(registration[0].options.env.MOBILE_AUTHORING_CONTEXT, undefined);
  assert.equal(registration[0].options.env.MOBILE_AUTHORING_RUNNER_TOKEN, undefined);
  assert.ok(checks.includes('authoring-registration'));
  assert.deepEqual(captureSnapshot(f.root), before);
  assert.equal(read(f.root, '.devplayer-builder/runtime.json'), stamp);
  assert.deepEqual(JSON.parse(stamp), { protocolVersion: 2, active: false });

  fs.unlinkSync(path.join(f.root, '.tmp/prototype-profile.json'));
  const runtimeOnly = runCandidateChecks(f.root, [SOURCE], { run: candidateRunner([]) });
  assert.ok(runtimeOnly.includes('authoring-registration'));
  fs.unlinkSync(path.join(f.root, '.tmp/mobile-authoring-runtime.json'));
  assert.equal(runCandidateChecks(f.root, [SOURCE], { run: candidateRunner([]) }).includes('authoring-registration'), false);
});

test('derived authoring outputs are explicitly scoped and checked against authored literal metadata, not self-hashed registry edits', OPTIONS, async (t) => {
  const f = project(t);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, {
    ...f.proposal, allowedFiles: [SOURCE, '.tmp/authoring-registry.json'],
  }), /all three derived/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, {
    ...f.proposal, allowedFiles: [...f.proposal.allowedFiles, RUNTIME_HELPERS[0]],
  }), /intentional runtime/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, {
    ...f.proposal, kind: 'global-style', screenIds: [],
  }), /explicit screen or integration scope/);
  const prepared = await edit.prepare(f.client, f.proposal);
  const plan = edit.loadPlan(f.client, prepared.planId);
  assert.deepEqual(plan.authoringSources, f.sources);
  write(f.root, SOURCE, read(f.root, SOURCE).replaceAll('Inspections', 'Inspection cards'));
  const stale = captureSnapshot(f.root);
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /missing\/stale/);
  assert.deepEqual(captureSnapshot(f.root), stale);
  configurePrototypeAuthoring(f.root, { screenSources: plan.authoringSources, readyScreenIds: [SCREEN] });
  const delta = edit.assertScopedDelta(f.root, f.descriptor, plan);
  assert.deepEqual(new Set(delta.changes.map((entry) => entry.path)), new Set([SOURCE, ...DERIVED_FILES]));

  const registry = json(f.root, '.tmp/authoring-registry.json');
  registry.screens[0].targets[0].label = 'Forged registry-only label';
  write(f.root, '.tmp/authoring-registry.json', registry);
  configureMobileAuthoring(f.root);
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /missing\/stale/);
});

test('derived source assignments cannot be redirected to another existing same-route file', OPTIONS, async (t) => {
  const f = project(t);
  const alternate = 'app/(alternate)/work.tsx';
  write(f.root, alternate, read(f.root, SOURCE));
  f.descriptor.baseRevision = captureSource(f.root).revision;
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, {
    ...f.proposal, authoringSources: [{ screenId: SCREEN, sourceFile: alternate }],
  }), /cannot be redirected/);
  const prepared = await edit.prepare(f.client, f.proposal);
  const plan = edit.loadPlan(f.client, prepared.planId);
  const registry = json(f.root, '.tmp/authoring-registry.json');
  registry.screens[0].sourceFile = alternate;
  write(f.root, '.tmp/authoring-registry.json', registry);
  configureMobileAuthoring(f.root);
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /missing\/stale/);
});

test('runtime installation and upgrade need explicit intent and cannot smuggle helper code or unrelated TypeScript changes', OPTIONS, async (t) => {
  const f = project(t, { configured: false });
  const proposal = {
    ...f.proposal, authoringRuntime: 'install', authoringSources: f.sources,
    allowedFiles: [...RUNTIME_INSTALL_FILES],
  };
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...proposal, authoringRuntime: undefined }), /intentional runtime installation/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...proposal, authoringRuntime: 'upgrade' }), /existence at proposal time/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...proposal, authoringSources: undefined }), /explicit authoringSources/);
  const prepared = await edit.prepare(f.client, proposal);
  const plan = edit.loadPlan(f.client, prepared.planId);
  configurePrototypeAuthoring(f.root, { screenSources: plan.authoringSources, readyScreenIds: [SCREEN] });
  assert.ok(edit.assertScopedDelta(f.root, f.descriptor, plan).changes.every((entry) => RUNTIME_INSTALL_FILES.includes(entry.path)));
  const tsconfig = read(f.root, 'tsconfig.json');
  const changed = JSON.parse(tsconfig);
  changed.compilerOptions.noEmit = !changed.compilerOptions.noEmit;
  write(f.root, 'tsconfig.json', changed);
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /only its two owned TypeScript/);
  write(f.root, 'tsconfig.json', tsconfig);

  const controller = read(f.root, 'src/authoring/controller.ts');
  write(f.root, 'src/authoring/controller.ts', `${controller}\n// Older compiler-owned runtime fixture.\n`);
  const manifest = json(f.root, '.tmp/mobile-authoring-runtime.json');
  manifest.files['src/authoring/controller.ts'] = digest(read(f.root, 'src/authoring/controller.ts'));
  write(f.root, '.tmp/mobile-authoring-runtime.json', manifest);
  f.descriptor.baseRevision = captureSource(f.root).revision;
  const upgraded = await edit.prepare(f.client, { ...proposal, authoringRuntime: 'upgrade' });
  const upgradePlan = edit.loadPlan(f.client, upgraded.planId);
  configurePrototypeAuthoring(f.root, { screenSources: upgradePlan.authoringSources, readyScreenIds: [SCREEN] });
  assert.ok(edit.assertScopedDelta(f.root, f.descriptor, upgradePlan).changes.some((entry) => entry.path === 'src/authoring/controller.ts'));

  write(f.root, 'src/authoring/controller.ts', `${controller}\nconsole.log('unapproved runtime body');\n`);
  const forged = json(f.root, '.tmp/mobile-authoring-runtime.json');
  forged.files['src/authoring/controller.ts'] = digest(read(f.root, 'src/authoring/controller.ts'));
  write(f.root, '.tmp/mobile-authoring-runtime.json', forged);
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, upgradePlan), /missing or stale/);
});

test('runtime installation does not grant unapproved screen writes when explicitly wiring layout', OPTIONS, async (t) => {
  for (const includeScreen of [false, true]) {
    const f = project(t, { configured: false });
    write(f.root, SOURCE, `import { Text, View } from 'react-native';
import { useAuthoringScreen, AuthoringTarget } from '@/authoring';
export const authoringTargets = [{ id: 'inspection.collection', label: 'Inspections', role: 'collection' }] as const;
export default function Work() {
  const screen = useAuthoringScreen('${SCREEN}', { ready: true, hasUnsavedChanges: false });
  return <View><AuthoringTarget targetId="inspection.collection" screen={screen}>
    <Text>Inspections</Text>
  </AuthoringTarget></View>;
}
`);
    f.descriptor.baseRevision = captureSource(f.root).revision;
    const prepared = await edit.prepare(f.client, {
      ...f.proposal, authoringRuntime: 'install', authoringSources: f.sources,
      allowedFiles: [...RUNTIME_INSTALL_FILES, ...(includeScreen ? [SOURCE] : [])],
    });
    const plan = edit.loadPlan(f.client, prepared.planId);
    configurePrototypeAuthoring(f.root, { screenSources: plan.authoringSources, readyScreenIds: [SCREEN], wireScreenIds: [SCREEN] });
    assert.match(read(f.root, SOURCE), /onLayout=\{screen\.onLayout\}/);
    if (includeScreen) {
      assert.ok(edit.assertScopedDelta(f.root, f.descriptor, plan).changes.some((entry) => entry.path === SOURCE));
    } else {
      assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /outside.*approved|unapproved|out.of.scope/i);
    }
  }
});

test('new-screen metadata stays read-only and optional wiring requires actual readiness bindings', OPTIONS, async (t) => {
  const f = project(t);
  const sourceFile = 'app/(modals)/details.tsx';
  const screenId = 'inspection-details';
  const proposal = {
    ...f.proposal, screenIds: [screenId], newScreens: [{ screenId, sourceFile, route: '/details' }],
    allowedFiles: [sourceFile, '.tmp/compiled-screen-build-pack.json', ...DERIVED_FILES],
  };
  const prepared = await edit.prepare(f.client, proposal);
  const plan = edit.loadPlan(f.client, prepared.planId);
  assert.equal(plan.authoringSources.find((entry) => entry.screenId === screenId).sourceFile, sourceFile);
  write(f.root, sourceFile, `import { Text, View } from 'react-native';
export default function Details() { return <View><Text>Preparing details</Text></View>; }
`);
  const compiled = json(f.root, '.tmp/compiled-screen-build-pack.json');
  compiled.screens.push({ screenId, route: '/details' });
  write(f.root, '.tmp/compiled-screen-build-pack.json', compiled);
  configurePrototypeAuthoring(f.root, { screenSources: plan.authoringSources });
  assert.doesNotThrow(() => edit.assertScopedDelta(f.root, f.descriptor, plan));
  assert.throws(() => runCandidateChecks(f.root, [sourceFile], { run: candidateRunner([]) }), /authoring-registration/);
  write(f.root, sourceFile, `export const authoringTargets = [] as const;\n${read(f.root, sourceFile)}`);
  const skeleton = read(f.root, sourceFile);
  configurePrototypeAuthoring(f.root, { screenSources: plan.authoringSources, readyScreenIds: [screenId] });
  assert.equal(read(f.root, sourceFile), skeleton);
  assert.throws(() => configurePrototypeAuthoring(f.root, {
    screenSources: plan.authoringSources, readyScreenIds: [screenId], wireScreenIds: [screenId],
  }), /must register|unready skeleton/);
  write(f.root, sourceFile, `import { Text } from 'react-native';
import { AuthoringScreen } from '@/authoring';
export const authoringTargets = [] as const;
export default function Details() {
  return <AuthoringScreen screenId="${screenId}" ready={true} hasUnsavedChanges={false}>
    <Text>Inspection details</Text>
  </AuthoringScreen>;
}
`);
  configurePrototypeAuthoring(f.root, { screenSources: plan.authoringSources, readyScreenIds: [screenId] });
  assert.doesNotThrow(() => edit.assertScopedDelta(f.root, f.descriptor, plan));
  assert.ok(runCandidateChecks(f.root, [sourceFile], { run: candidateRunner([]) }).includes('authoring-registration'));
  assert.deepEqual(json(f.root, '.devplayer-builder/runtime.json'), { protocolVersion: 2, active: false });
});

test('local native capture uses the actual capture producer and preserves all unrelated data code and ownership', OPTIONS, async (t) => {
  const f = project(t);
  f.descriptor.integration = { kind: 'native', capabilityId: 'camera', catalogRevision: 'c'.repeat(64) };
  const proposal = {
    schemaVersion: 1, kind: 'integration', summary: 'Enable the selected local camera capture',
    screenIds: [], allowedFiles: [
      '.tmp/architecture-decisions.json', '.tmp/persistence-contract.json', '.tmp/scenario-facts.json',
      ...integrations.LOCAL_CAPTURE_OUTPUTS,
    ],
  };
  const route = edit.normalizePlan(f.root, f.descriptor, proposal).integrationRoute;
  assert.equal(route.wrapper, 'src/data/capture.ts');
  assert.equal(route.localCapture, true);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, {
    ...proposal, allowedFiles: proposal.allowedFiles.filter((file) => file !== '.tmp/prototype-generated.json'),
  }), /both compiler-owned metadata/);
  for (const file of ['src/data/runtime.ts', 'src/data/model.ts', '.tmp/prototype-domain.json', 'src/data/repositories/local.ts']) {
    assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...proposal, allowedFiles: [...proposal.allowedFiles, file] }), /scope/);
  }
  const prepared = await edit.prepare(f.client, proposal);
  const plan = edit.loadPlan(f.client, prepared.planId);
  await assert.rejects(edit.capture(f.client, prepared.planId), /not approved/);
  await edit.authorize(f.client, prepared.planId);
  await assert.rejects(edit.capture(f.client, prepared.planId), /completed integration handoff/);
  const original = json(f.root, '.tmp/prototype-generated.json');
  f.architecture.nativeCapabilities.push({ id: 'camera', approved: true });
  const persistence = compilePersistenceContract(f.scope, f.architecture);
  const facts = json(f.root, '.tmp/scenario-facts.json');
  facts.scopeRevision = persistence.scopeRevision;
  facts.persistenceRevision = persistence.persistenceRevision;
  delete facts.scenarioRevision;
  facts.scenarioRevision = revision(facts);
  write(f.root, '.tmp/architecture-decisions.json', f.architecture);
  write(f.root, '.tmp/persistence-contract.json', persistence);
  write(f.root, '.tmp/scenario-facts.json', facts);
  const gate = await f.client.requestQuestion({ gateId: 'gate1' }, { recordGate: 1 });
  await edit.integration(f.client, prepared.planId, gate.receiptPath);
  const result = await edit.capture(f.client, prepared.planId);
  assert.equal(result.applied, false);
  assert.equal(result.remoteEffects, false);
  assert.deepEqual(edit.sourceDelta(plan.baseline, captureSource(f.root))
    .filter((entry) => !plan.allowedFiles.includes(entry.path)).map((entry) => entry.path), []);
  const delta = edit.assertScopedDelta(f.root, f.descriptor, plan);
  assert.ok(delta.changes.some((entry) => entry.path === 'src/data/capture.ts'));
  assert.doesNotThrow(() => integrations.assertIntegrationPrepared(f.root, plan, delta.changes));
  typecheck(f.root);
  for (const [file, hash] of Object.entries(original.files)) {
    if (file !== 'src/data/capture.ts') assert.equal(digest(read(f.root, file)), hash, file);
  }
  const preparedSource = captureSource(f.root).revision;
  write(f.root, 'src/data/capture.ts', edit.originalBytes(f.root, f.descriptor, plan, 'src/data/capture.ts').toString('utf8'));
  await edit.capture(f.client, prepared.planId);
  assert.equal(captureSource(f.root).revision, preparedSource);
  const manifest = json(f.root, '.tmp/prototype-generated.json');
  delete manifest.files['src/data/runtime.ts'];
  write(f.root, '.tmp/prototype-generated.json', manifest);
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /every unrelated compiler-owned/);
  const conflicting = captureSnapshot(f.root);
  await assert.rejects(edit.capture(f.client, prepared.planId), /outside its sealed before\/after/);
  assert.deepEqual(captureSnapshot(f.root), conflicting);
});

test('initialized connector capture preserves local fixtures, exact SDK bindings, authoring root and preview namespaces', OPTIONS, async (t) => {
  const f = project(t);
  const environmentId = '11111111-2222-4333-8444-555555555555';
  const apiId = 'shared_office365users';
  f.architecture.connectors.push({ apiName: 'directory', displayName: 'Directory', approved: true });
  function rebind() {
    const persistence = compilePersistenceContract(f.scope, f.architecture);
    const facts = json(f.root, '.tmp/scenario-facts.json');
    facts.scopeRevision = persistence.scopeRevision;
    facts.persistenceRevision = persistence.persistenceRevision;
    delete facts.scenarioRevision;
    facts.scenarioRevision = revision(facts);
    write(f.root, '.tmp/persistence-contract.json', persistence);
    write(f.root, '.tmp/scenario-facts.json', facts);
    write(f.root, '.tmp/architecture-decisions.json', f.architecture);
  }
  rebind();
  write(f.root, 'power.config.json', {
    environmentId, appDisplayName: 'Capture fixture',
    connectionReferences: { directory_ref: { id: `/providers/Microsoft.PowerApps/apis/${apiId}`, dataSources: ['Directory'] } },
  });
  write(f.root, 'auth.config.json', {
    msal: { clientId: '33333333-3333-4333-8333-333333333333', tenantId: '44444444-4444-4444-8444-444444444444' },
  });
  write(f.root, '.power/schemas/Directory/Directory.Schema.json', {
    name: 'Directory', properties: { primaryRuntimeUrl: 'https://runtime.example.invalid' },
  });
  const generated = spawnSync('npm', ['run', 'generate-schemas', '--silent'], {
    cwd: f.root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  const catalog = await readConnectionCatalog({ environmentId }, {
    getToken: async () => 'fixture-token',
    requestJson: async () => ({ value: [{ name: 'chosen-directory', properties: { apiId, statuses: [{ status: 'Connected' }] } }] }),
  });
  stagePrototypeConnectorStartup(f.root, {
    catalog, connectorName: 'directory',
    selection: { kind: 'connector', apiId, environmentId, connectionId: 'chosen-directory', catalogRevision: catalog.catalogRevision },
    preview: { previewKind: 'candidate', dataNamespace: 'capture-candidate', baseDataNamespace: 'active' },
  });
  f.descriptor.baseRevision = captureSource(f.root).revision;
  f.descriptor.integration = { kind: 'native', capabilityId: 'camera', catalogRevision: 'd'.repeat(64) };
  const route = integrations.integrationRoute(f.root, f.descriptor);
  assert.equal(route.inputs.prototype, false);
  assert.equal(route.localCapture, true);
  const proposal = {
    schemaVersion: 1, kind: 'integration', summary: 'Enable local capture in the initialized app', screenIds: [],
    allowedFiles: [
      '.tmp/architecture-decisions.json', '.tmp/persistence-contract.json', '.tmp/scenario-facts.json',
      ...integrations.captureOutputFiles(route),
    ],
  };
  const preserved = [
    'src/data/fixtures.ts', 'src/data/model.ts', 'src/data/runtime.ts', 'src/data/rules.ts',
    'src/data/repositories/local.ts', 'src/data/connector-startup.json', 'power.config.json', 'auth.config.json',
    'app/_layout.tsx', '.tmp/prototype-profile.json', '.devplayer-builder/runtime.json',
  ].map((file) => [file, read(f.root, file)]);
  const prepared = await edit.prepare(f.client, proposal);
  await edit.authorize(f.client, prepared.planId);
  f.architecture.nativeCapabilities.push({ id: 'camera', approved: true });
  rebind();
  const gate = await f.client.requestQuestion({ gateId: 'gate1' }, { recordGate: 1 });
  await edit.integration(f.client, prepared.planId, gate.receiptPath);
  const result = await edit.capture(f.client, prepared.planId);
  assert.equal(result.applied, false);
  assert.equal(verifyPrototypeConnectorStartup(f.root).profile, 'connector');
  configurePrototypeAuthoring(f.root, { check: true, readyScreenIds: [SCREEN] });
  typecheck(f.root);
  for (const [file, contents] of preserved) assert.equal(read(f.root, file), contents, file);
});

test('capture preparation restores only its own bytes when final grant verification fails', OPTIONS, async (t) => {
  const f = project(t);
  f.descriptor.integration = { kind: 'native', capabilityId: 'camera', catalogRevision: 'e'.repeat(64) };
  const prepared = await edit.prepare(f.client, {
    schemaVersion: 1, kind: 'integration', summary: 'Prepare local camera capture', screenIds: [],
    allowedFiles: [
      '.tmp/architecture-decisions.json', '.tmp/persistence-contract.json', '.tmp/scenario-facts.json',
      ...integrations.LOCAL_CAPTURE_OUTPUTS,
    ],
  });
  await edit.authorize(f.client, prepared.planId);
  f.architecture.nativeCapabilities.push({ id: 'camera', approved: true });
  const persistence = compilePersistenceContract(f.scope, f.architecture);
  const facts = json(f.root, '.tmp/scenario-facts.json');
  facts.scopeRevision = persistence.scopeRevision;
  facts.persistenceRevision = persistence.persistenceRevision;
  delete facts.scenarioRevision;
  facts.scenarioRevision = revision(facts);
  write(f.root, '.tmp/architecture-decisions.json', f.architecture);
  write(f.root, '.tmp/persistence-contract.json', persistence);
  write(f.root, '.tmp/scenario-facts.json', facts);
  const gate = await f.client.requestQuestion({ gateId: 'gate1' }, { recordGate: 1 });
  await edit.integration(f.client, prepared.planId, gate.receiptPath);
  const before = captureSnapshot(f.root);
  const verify = f.client.verifySavedDecision;
  let gateChecks = 0;
  f.client.verifySavedDecision = async (receipt, options) => {
    if (options.gateId === 'gate1' && ++gateChecks === 2) throw new Error('Fixture grant revoked');
    return verify(receipt, options);
  };
  await assert.rejects(edit.capture(f.client, prepared.planId), /grant revoked/);
  assert.deepEqual(captureSnapshot(f.root), before);
  f.client.verifySavedDecision = verify;
  assert.equal((await edit.capture(f.client, prepared.planId)).applied, false);
});
