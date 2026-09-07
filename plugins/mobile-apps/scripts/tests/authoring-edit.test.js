'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const edit = require('../lib/authoring-edit');
const { inspectEdit, registeredContext } = require('../lib/authoring-edit-context');
const { readyFiles } = require('../lib/mobile-authoring-candidate');
const { questionBinding, currentBinding, prepareQuestion, questionDigest, verifyDecision } = require('../lib/mobile-authoring-decisions');
const { canonicalJson, digest, readJson, atomicWrite, journalPath } = require('../lib/mobile-authoring-files');
const { validateEntityRules, generateRulesRuntime } = require('../lib/authoring-rules');
const { prepareWrite } = require('../lib/prototype-repository-core');
const protocol = require('../lib/authoring-protocol');
const integrations = require('../lib/authoring-edit-integration');
const { refreshPrototypeRules } = require('../lib/prototype-rules');
const { RUNTIME_INSTALL_FILES } = require('../lib/mobile-authoring-registration');

process.env.POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT = '1';
const HAS_SOURCE = fs.existsSync(path.resolve(__dirname, '../lib/authoring-source.js'));
const SOURCE_REASON = 'Requires the pinned authoring-source bundle supplied by the integration owner';
const MODULES = process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES;
const HAS_TYPESCRIPT = !!MODULES && fs.existsSync(path.join(MODULES, 'typescript', 'package.json'));

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

function fixture(t) {
  const root = path.join(__dirname, `.authoring-edit-work-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  if (HAS_TYPESCRIPT) fs.symlinkSync(path.resolve(MODULES), path.join(root, 'node_modules'), 'dir');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const domain = {
    schemaVersion: 1, schemaVersionNumber: 1, appInstanceId: 'inspection-demo',
    entities: [{
      id: 'inspections', label: 'Inspection', operations: ['list', 'get', 'create', 'update'],
      fields: [
        { id: 'result', label: 'Result', type: 'choice', options: [{ id: 'pass', label: 'Pass' }, { id: 'fail', label: 'Fail' }] },
        { id: 'damagePhoto', label: 'Damage photo', type: 'photo' },
        { id: 'note', label: 'Note', type: 'text' },
      ],
    }],
    actions: [{ id: 'saveInspection', label: 'Save inspection', entityId: 'inspections', operation: 'save' }],
  };
  const empty = { schemaVersion: 1, rules: [] };
  const rules = {
    schemaVersion: 1, rules: [{
      id: 'failure-photo', entityId: 'inspections', actionId: 'saveInspection',
      when: { fieldId: 'result', operator: 'equals', value: 'fail' },
      require: { fieldId: 'damagePhoto', message: 'Add a damage photo before saving a failed inspection.' },
    }],
  };
  const code = generateRulesRuntime(domain, empty);
  write(root, 'package.json', { name: 'authoring-fixture', private: true });
  write(root, '.tmp/prototype-domain.json', domain);
  write(root, '.tmp/prototype-rules.json', empty);
  const bindings = { schemaVersion: 1, entities: [{ entityId: 'inspections', conceptId: 'inspection' }] };
  write(root, '.tmp/prototype-bindings.json', bindings);
  const persistence = { schemaVersion: 1, contractType: 'persistence-contract', mode: 'local-prototype' };
  persistence.persistenceRevision = digest(canonicalJson(persistence));
  const facts = { schemaVersion: 1, persistenceRevision: persistence.persistenceRevision, scopeRevision: 'fixture-scope' };
  facts.scenarioRevision = digest(canonicalJson(facts));
  write(root, '.tmp/persistence-contract.json', persistence);
  write(root, '.tmp/scenario-facts.json', facts);
  const inputRevisions = {
    domain: digest(canonicalJson(domain)), bindings: digest(canonicalJson(bindings)),
    persistence: persistence.persistenceRevision, scenario: facts.scenarioRevision, rules: digest(canonicalJson(empty)),
  };
  write(root, '.tmp/prototype-generated.json', {
    schemaVersion: 1, inputRevisions,
    files: { 'src/data/rules.ts': digest(code), 'src/data/unchanged.ts': digest('unchanged') },
  });
  const registry = {
    schemaVersion: 1, contractType: 'data-access-registry', mode: 'local-prototype',
    inputRevisions,
    entities: [{ entityId: 'inspections', conceptId: 'inspection', module: '@/data/runtime' }],
  };
  registry.registryRevision = digest(canonicalJson(registry));
  write(root, '.tmp/data-access-registry.json', registry);
  write(root, 'src/data/rules.ts', code);
  write(root, 'src/data/unchanged.ts', 'unchanged');
  const pack = {
    screenId: 'inspection-list', route: '/inspections',
    primaryActions: ['saveInspection'], secondaryActions: [], navigation: { detail: '/inspections/[id]' }, dataAssumptions: [],
  };
  const compiled = {
    schemaVersion: 1, contractType: 'compiled-screen-build-pack',
    screens: [{
      screenId: 'inspection-list', route: '/inspections', pack,
      navigationShell: { pattern: 'stack' }, journeySteps: [], implementationContract: { requiredOperations: ['list'] },
    }],
  };
  compiled.compiledRevision = digest(canonicalJson(compiled));
  write(root, '.tmp/screen-build-pack.json', { schemaVersion: 1, contractType: 'screen-build-pack', packs: [pack] });
  write(root, '.tmp/compiled-screen-build-pack.json', compiled);
  write(root, '.tmp/authoring-registry.json', {
    schemaVersion: 1, appInstanceId: domain.appInstanceId,
    screens: [{
      screenId: 'inspection-list', route: '/inspections', sourceFile: 'app/(app)/inspections/index.tsx',
      targets: [{ id: 'inspection-list.collection', label: 'Inspections', role: 'collection' }],
    }],
  });
  write(root, 'app/(app)/inspections/index.tsx', "export default function Screen() { const rows = useEntityList('inspections', { pageSize: 20 }); return <Text>Rows</Text>; }\n");
  write(root, 'brand/tokens.ts', "export const background = '$background';\n");
  write(root, '.tmp/remote-execution-journal.json', { applied: ['preserve-remote-evidence'] });
  write(root, 'stored-business-records.json', { id: 'old-inspection', damagePhoto: { status: 'ready', uri: 'file:///app/photo.jpg' } });
  const keys = crypto.generateKeyPairSync('ed25519');
  const descriptor = {
    protocolVersion: 2, appInstanceId: domain.appInstanceId, jobId: 'edit-job', attemptId: 'edit-attempt', operation: 'teach',
    workspaceDir: root, baseRevision: HAS_SOURCE ? require('../lib/authoring-source').captureSource(root).revision : 'a'.repeat(64),
    decisionPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  descriptor.context = {
    protocolVersion: 2, appInstanceId: domain.appInstanceId, jobId: 'published-preview-job',
    previewRevision: descriptor.baseRevision, scope: 'target', screenId: 'inspection-list',
    route: '/inspections', targetId: 'inspection-list.collection',
    recordRef: { conceptId: 'inspection', recordId: 'old-inspection' },
  };
  let active = true;
  let action = 'approve';
  const client = {
    descriptor,
    assertSafe: (value) => assert.ok(!JSON.stringify(value).includes('fixture-callback-secret')),
    verify: async () => { if (!active) throw new Error('cancelled'); return { active: true }; },
    requestQuestion: async (input, options) => {
      const binding = questionBinding(root, options);
      const question = prepareQuestion(input, binding, descriptor);
      const receipt = {
        protocolVersion: 2, issuer: protocol.PROTOCOL_ID, appInstanceId: descriptor.appInstanceId,
        jobId: descriptor.jobId, attemptId: descriptor.attemptId, approvalId: question.id, approvalRevision: 1,
        gateId: question.gateId, sourceRevision: question.sourceRevision, questionDigest: questionDigest(question),
        action, answer: {}, issuedAt: new Date().toISOString(),
      };
      receipt.signature = crypto.sign(null, Buffer.from(canonicalJson(receipt)), keys.privateKey).toString('base64');
      const receiptPath = journalPath(descriptor, `decisions/${digest(question.id)}.json`);
      atomicWrite(root, receiptPath, { schemaVersion: 1, question, binding, receipt });
      return { question, binding, receipt, receiptPath };
    },
    verifySavedDecision: async (relative, options) => {
      if (!active) throw new Error('cancelled');
      const saved = readJson(root, relative);
      assert.equal(saved.question.gateId, options.gateId);
      verifyDecision(saved.receipt, {
        descriptor, question: saved.question, approvalId: saved.question.id, approvalRevision: 1,
      });
      assert.equal(saved.receipt.action, 'approve');
      assert.equal(currentBinding(root, saved.binding).sourceRevision, saved.binding.sourceRevision);
      return saved;
    },
    submitCandidate: async (candidate) => {
      assert.equal(candidate.sourceRevision, require('../lib/authoring-source').captureSource(root).revision);
      return { accepted: true };
    },
  };
  return {
    root, domain, rules, descriptor, client,
    setActive: (value) => { active = value; }, setAction: (value) => { action = value; },
    proposal: { schemaVersion: 1, kind: 'business-rule', summary: 'Require a ready photo for all failed inspection saves.', entityId: 'inspections', screenIds: [], allowedFiles: edit.RULE_OUTPUTS, rules },
  };
}

function rebaseFixture(f) {
  f.descriptor.baseRevision = require('../lib/authoring-source').captureSource(f.root).revision;
  f.descriptor.context.previewRevision = f.descriptor.baseRevision;
}

function integrationFixture(t, selected = { kind: 'native', capabilityId: 'camera', catalogRevision: 'a'.repeat(64) }) {
  const f = fixture(t);
  f.descriptor.operation = 'edit';
  f.descriptor.integration = protocol.assertIntegrationSelection(selected);
  write(f.root, 'package.json', {
    name: 'authoring-fixture', private: true, dependencies: { 'expo-camera': '1.0.0', 'expo-image-picker': '1.0.0' },
    scripts: { 'dev:prototype': 'expo start', predev: 'npm run generate-schemas' },
  });
  write(f.root, '.tmp/persistence-contract.json', {
    mode: 'local-prototype', conceptOwners: [{ conceptId: 'inspection', owner: 'local' }],
    dataverseConceptIds: [], localConceptIds: ['inspection'], connectorConceptIds: [],
  });
  write(f.root, '.tmp/product-experience-contract.json', { schemaVersion: 1, experienceRevision: 'fixture-experience' });
  write(f.root, '.tmp/product-scope-contract.json', { schemaVersion: 1, scopeRevision: 'fixture-scope' });
  write(f.root, '.tmp/navigation-manifest.json', { schemaVersion: 1, screens: [] });
  write(f.root, '.tmp/architecture-decisions.json', { nativeCapabilities: [], connectors: [] });
  rebaseFixture(f);
  f.proposal = {
    schemaVersion: 1, kind: 'integration', summary: 'Add the selected integration while preserving existing inspection data.',
    ...(selected.kind === 'connector' ? { connectorName: 'mail-owner' } : {}),
    screenIds: [],
    allowedFiles: [
      '.tmp/architecture-decisions.json', '.tmp/persistence-contract.json',
      ...(selected.kind === 'native' ? ['src/native/camera.ts'] : ['power.config.json', 'src/generated/services/OfficeService.ts', 'package.json']),
    ],
  };
  return f;
}

async function integrationGate(f) {
  return f.client.requestQuestion({
    gateId: 'gate1', kind: 'plan', title: 'Approve selected capability', summary: 'Approve this exact architecture and ownership.', fields: [],
  }, { recordGate: 1 });
}

test('context is registered, source-mapped, minimal, and tied to the base preview rather than the new job ID', (t) => {
  const f = fixture(t);
  const selected = registeredContext(f.root, f.descriptor);
  assert.equal(selected.target.id, 'inspection-list.collection');
  assert.equal(selected.context.jobId, 'published-preview-job');
  for (const change of [
    { screenId: 'invented' }, { route: '/another-route' }, { targetId: 'invented' }, { actionId: 'invented' },
    { previewRevision: 'f'.repeat(64) }, { recordRef: { conceptId: 'other-domain', recordId: '1' } },
    { recordRef: { conceptId: f.domain.entities[0].id, recordId: 'old-inspection' } },
  ]) assert.throws(() => registeredContext(f.root, { ...f.descriptor, context: { ...f.descriptor.context, ...change } }));
  fs.unlinkSync(path.join(f.root, '.tmp/authoring-registry.json'));
  const generic = inspectEdit(f.root, f.descriptor, 'layout');
  assert.equal(generic.needsClarification, true);
  assert.equal(generic.context, null);
  assert.equal(generic.defaultScope, 'app');
});

test('app background defaults global; selected layout cannot widen files, records, generated services, or screens', (t) => {
  const f = fixture(t);
  assert.equal(inspectEdit(f.root, f.descriptor, 'background').defaultScope, 'app');
  const global = edit.normalizePlan(f.root, f.descriptor, {
    schemaVersion: 1, kind: 'global-style', summary: 'Change the app background', allowedFiles: ['brand/tokens.ts'],
  });
  assert.equal(global.scope, 'app');
  const selected = {
    schemaVersion: 1, kind: 'target-layout', summary: 'Turn the selected list into cards',
    screenIds: ['inspection-list'], allowedFiles: ['app/(app)/inspections/index.tsx'],
  };
  assert.equal(edit.normalizePlan(f.root, f.descriptor, selected).scope, 'target');
  for (const file of ['../outside.ts', 'src/generated/fake.ts', 'src/data/runtime.ts', '.tmp/remote-execution-journal.json', 'app/(app)/another.tsx', '.tmp/authoring-registry.json']) {
    assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...selected, allowedFiles: [file] }));
  }
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...selected, screenIds: ['other-screen'] }));
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, allowedFiles: [...edit.RULE_OUTPUTS, '.tmp/authoring-registry.json'] }));
});

test('new screens are bounded, unique, nonexistent targets with only their own explicit ancestor layouts', (t) => {
  const f = fixture(t);
  write(f.root, 'app/_layout.tsx', 'export default function Root() { return null; }\n');
  write(f.root, 'tsconfig.json', { compilerOptions: { strict: true } });
  const proposal = {
    schemaVersion: 1, kind: 'screen', summary: 'Add a scanner modal',
    authoringRuntime: 'install',
    screenIds: ['scanner'], newScreens: [{ screenId: 'scanner', route: '/scanner', sourceFile: 'app/(modals)/scanner.tsx' }],
    allowedFiles: ['app/(modals)/scanner.tsx', 'app/(modals)/_layout.tsx', ...RUNTIME_INSTALL_FILES],
  };
  assert.equal(edit.normalizePlan(f.root, f.descriptor, proposal).newScreens[0].route, '/scanner');
  for (const newScreens of [
    [{ screenId: 'inspection-list', route: '/scanner', sourceFile: 'app/(modals)/scanner.tsx' }],
    [{ screenId: 'scanner', route: '/inspections', sourceFile: 'app/(modals)/inspections.tsx' }],
    [{ screenId: 'scanner', route: '/scanner', sourceFile: 'app/(modals)/other.tsx' }],
    [{ screenId: 'scanner', route: '/scanner', sourceFile: '../scanner.tsx' }],
    [...proposal.newScreens, ...proposal.newScreens],
    [{ ...proposal.newScreens[0], command: 'not-permitted' }],
  ]) assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...proposal, newScreens }));
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...proposal, screenIds: [] }));
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...proposal, allowedFiles: ['app/(modals)/_layout.tsx'] }));
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...proposal, allowedFiles: [...proposal.allowedFiles, 'app/(unrelated)/_layout.tsx'] }));
  write(f.root, 'app/(modals)/scanner.tsx', 'export default function Existing() { return null; }\n');
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, proposal), /nonexistent/);
});

test('native selections use supported template workflows without a device probe or missing-package install', (t) => {
  const f = integrationFixture(t);
  const plan = edit.normalizePlan(f.root, f.descriptor, f.proposal);
  assert.equal(plan.integrationRoute.skill, 'add-native');
  assert.deepEqual(plan.integrationRoute.inputs, { capabilityId: 'camera', prototype: true });
  assert.equal(plan.integrationRoute.sourceOfTemplateSupport, 'selected-template-package-catalogue');
  assert.equal(Object.hasOwn(plan.integrationRoute, 'sourceOfBinarySupport'), false);
  assert.match(integrations.integrationReviewItems(plan.integrationRoute).join(' '), /no device inventory or optional binary probe is required/);
  assert.match(integrations.integrationReviewItems(plan.integrationRoute).join(' '), /version requirements; handle permission denial or unavailable hardware/);
  assert.equal(plan.integrationRoute.packageChanges, false);
  const packageJson = readJson(f.root, 'package.json');
  write(f.root, 'package.json', { ...packageJson, dependencies: { 'expo-camera': '1.0.0' } });
  assert.throws(() => integrations.integrationRoute(f.root, f.descriptor), /expo-image-picker.*not be installed/);
  write(f.root, 'package.json', packageJson);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, kind: 'screen' }), /bound integration/);
  assert.throws(() => edit.normalizePlan(f.root, { ...f.descriptor, operation: 'teach' }, f.proposal), /bridge-bound edit/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, integration: { ...plan.integration, capabilityId: 'location' } }), /unsupported shape/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, allowedFiles: ['package.json'] }));
  for (const capabilityId of ['haptics', 'location', 'pdf-viewer', 'invented']) {
    assert.throws(() => integrations.integrationRoute(f.root, { ...f.descriptor, integration: { ...plan.integration, capabilityId } }));
  }
  const modules = path.join(f.root, 'node_modules');
  if (fs.existsSync(modules)) fs.unlinkSync(modules);
  write(f.root, 'package.json', { dependencies: { '@microsoft/power-apps-native-pdf-viewer': '^0.2.9' } });
  write(f.root, 'node_modules/@microsoft/power-apps-native-pdf-viewer/package.json', { version: '0.2.8' });
  assert.throws(() => integrations.integrationRoute(f.root, {
    ...f.descriptor, integration: { ...plan.integration, capabilityId: 'pdf-viewer' },
  }), /not shipped|installed package version/);
  write(f.root, 'package.json', { dependencies: { '@react-native-community/datetimepicker': '1.0.0' } });
  const dateDescriptor = { ...f.descriptor, integration: { ...plan.integration, capabilityId: 'date-time-picker' } };
  assert.throws(() => edit.normalizePlan(f.root, dateDescriptor, f.proposal), /explicitly selected/);
});

test('native handoff uses initialized connector startup even when its logical persistence remains local', (t) => {
  const f = integrationFixture(t);
  const persistence = readJson(f.root, '.tmp/persistence-contract.json');
  write(f.root, '.tmp/prototype-profile.json', { schemaVersion: 1, profile: 'prototype', storageMode: 'local' });
  assert.equal(integrations.integrationRoute(f.root, f.descriptor).inputs.prototype, true);
  write(f.root, 'power.config.json', { environmentId: 'environment-fixture' });
  for (const mode of ['local-prototype', 'connector-only']) {
    write(f.root, '.tmp/persistence-contract.json', { ...persistence, mode });
    const profile = { schemaVersion: 1, profile: 'connector', storageMode: 'local', persistenceMode: mode, environmentId: 'environment-fixture' };
    write(f.root, '.tmp/prototype-profile.json', profile);
    const route = integrations.integrationRoute(f.root, f.descriptor);
    assert.equal(route.inputs.prototype, false);
    assert.equal(route.fromDataMode, mode);
    assert.deepEqual(readJson(f.root, '.tmp/prototype-profile.json'), profile);
    assert.deepEqual(readJson(f.root, '.tmp/persistence-contract.json'), { ...persistence, mode });
  }
  write(f.root, '.tmp/prototype-profile.json', { schemaVersion: 1, profile: 'unknown' });
  assert.throws(() => integrations.integrationRoute(f.root, f.descriptor), /profile/);
});

test('connector selections are environment-scoped existing resources, use fixed skills, and cannot silently select Dataverse', (t) => {
  const selected = { kind: 'connector', apiId: 'shared_office365', environmentId: 'environment-fixture', connectionId: 'connection-fixture', catalogRevision: 'b'.repeat(64) };
  const f = integrationFixture(t, selected);
  const route = edit.normalizePlan(f.root, f.descriptor, f.proposal).integrationRoute;
  assert.equal(route.skill, 'add-connector');
  assert.equal(route.initializesApp, true);
  assert.equal(route.connectedOperation, true);
  assert.equal(route.requiresConnectionAccessConsent, true);
  assert.equal(route.inputs.existingConnectionOnly, true);
  assert.equal(route.inputs.existingResourcesOnly, true);
  assert.equal(route.inputs.catalogRevision, selected.catalogRevision);
  assert.equal(route.inputs.connectorName, 'mail-owner');
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, connectorName: undefined }), /explicit architecture connectorName/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, connectorName: 'guessed_owner' }), /canonical lowercase/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, connectorName: 'mail-owner\n' }), /canonical lowercase/);
  write(f.root, '.tmp/architecture-decisions.json', { connectors: [{ apiName: 'mail-owner', approved: true }] });
  assert.doesNotThrow(() => integrations.assertArchitectureSelection(f.root, route));
  write(f.root, '.tmp/architecture-decisions.json', { connectors: [{ apiName: 'office365', approved: true }] });
  assert.throws(() => integrations.assertArchitectureSelection(f.root, route), /sealed connector owner/);
  write(f.root, '.tmp/architecture-decisions.json', { connectors: [{ apiName: 'mail-owner', apiId: 'shared_other', approved: true }] });
  assert.throws(() => integrations.assertArchitectureSelection(f.root, route), /selected API binding/);
  assert.equal(route.importsPrototypeRecords, false);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, allowedFiles: ['src/generated/services/OfficeService.ts'] }), /initialization/);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, allowedFiles: ['power.config.json'] }), /official generated/);
  const sharepoint = { kind: 'connector', apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', environmentId: selected.environmentId, connectionRef: 'sharepoint-reference', catalogRevision: selected.catalogRevision };
  assert.equal(integrations.integrationRoute(f.root, { ...f.descriptor, integration: sharepoint }).skill, 'add-sharepoint');
  for (const apiId of ['shared_commondataservice', 'shared_commondataserviceforapps', 'dataverse']) {
    assert.throws(() => integrations.integrationRoute(f.root, { ...f.descriptor, integration: { ...selected, apiId } }), /separate Connect to Dataverse/);
  }
  write(f.root, 'power.config.json', { environmentId: 'another-environment' });
  assert.throws(() => integrations.integrationRoute(f.root, f.descriptor), /different environment/);
  write(f.root, 'power.config.json', { environmentId: selected.environmentId });
  assert.equal(integrations.integrationRoute(f.root, f.descriptor).initializesApp, false);
});

test('integration handoff and candidate checks require both preparation and canonical current Gate 1 receipts', { skip: !HAS_SOURCE && SOURCE_REASON }, async (t) => {
  const f = integrationFixture(t);
  const prepared = await edit.prepare(f.client, f.proposal);
  await assert.rejects(edit.integration(f.client, prepared.planId, 'missing.json'), /not approved/);
  const consent = await edit.authorize(f.client, prepared.planId);
  await assert.rejects(edit.integration(f.client, prepared.planId, consent.receipt));
  const notApproved = await integrationGate(f);
  await assert.rejects(edit.integration(f.client, prepared.planId, notApproved.receiptPath), /explicitly approve/);
  write(f.root, '.tmp/architecture-decisions.json', { nativeCapabilities: [{ id: 'camera', approved: true }], connectors: [] });
  await assert.rejects(edit.integration(f.client, prepared.planId, notApproved.receiptPath));
  const gate = await integrationGate(f);
  const handoff = await edit.integration(f.client, prepared.planId, gate.receiptPath);
  assert.equal(handoff.status, 'authorized-handoff');
  assert.equal(handoff.skill, 'add-native');
  assert.equal(handoff.applied, false);
  await assert.rejects(edit.check(f.client, prepared.planId), /wrapper or host-owned screen control/);
  write(f.root, 'src/native/camera.ts', 'export async function capturePhoto() { return null; }\n');
  assert.equal((await edit.check(f.client, prepared.planId)).status, 'scope-checked');
  const ordinary = await f.client.requestQuestion({
    gateId: 'gate1', kind: 'plan', title: 'Not a canonical gate', summary: 'Only a file-bound fixture decision.', fields: [],
  }, { bind: ['.tmp/architecture-decisions.json'] });
  const statePath = edit.stateLocation(f.descriptor, prepared.planId);
  const state = readJson(f.root, statePath);
  atomicWrite(f.root, statePath, { ...state, gateReceipt: ordinary.receiptPath });
  await assert.rejects(edit.check(f.client, prepared.planId), /canonical Gate 1/);
  atomicWrite(f.root, statePath, state);
  f.setActive(false);
  await assert.rejects(edit.check(f.client, prepared.planId), /cancelled/);
});

test('connector scope preserves dependency versions, local ownership, stored records, rules, and remote evidence', { skip: !HAS_SOURCE && SOURCE_REASON }, async (t) => {
  const f = integrationFixture(t, {
    kind: 'connector', apiId: 'shared_office365', environmentId: 'environment-fixture', connectionRef: 'office-reference', catalogRevision: 'c'.repeat(64),
  });
  const prepared = await edit.prepare(f.client, f.proposal);
  await edit.authorize(f.client, prepared.planId);
  const plan = edit.loadPlan(f.client, prepared.planId);
  const before = readJson(f.root, 'package.json');
  write(f.root, 'package.json', { ...before, scripts: { predev: before.scripts.predev } });
  assert.doesNotThrow(() => edit.assertScopedDelta(f.root, f.descriptor, plan));
  write(f.root, 'package.json', { ...before, scripts: { start: 'expo start' } });
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /only remove dev:prototype/);
  write(f.root, 'package.json', { ...before, dependencies: { ...before.dependencies, 'unapproved-package': '1.0.0' } });
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /dependencies/);
  write(f.root, 'package.json', before);
  const persistence = readJson(f.root, '.tmp/persistence-contract.json');
  write(f.root, '.tmp/persistence-contract.json', { ...persistence, conceptOwners: [{ conceptId: 'inspection', owner: 'connector' }] });
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /local domain ownership/);
  write(f.root, '.tmp/persistence-contract.json', { ...persistence, dataverseConceptIds: ['unexpected-remote'] });
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /does not convert/);
  write(f.root, '.tmp/persistence-contract.json', persistence);
  for (const file of ['.tmp/prototype-domain.json', '.tmp/prototype-rules.json', 'src/data/runtime.ts', 'stored-business-records.json', '.tmp/remote-execution-journal.json', 'offline-profile.json', '.tmp/dataverse-schema-contract.json']) {
    assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, allowedFiles: [...f.proposal.allowedFiles, file] }), /scope/);
  }
  const changedSelection = { ...f.descriptor, integration: { ...f.descriptor.integration, catalogRevision: 'd'.repeat(64) } };
  assert.throws(() => edit.loadPlan({ ...f.client, descriptor: changedSelection }, prepared.planId), /another operation/);
});

test('connector startup permits only its named owner outputs and revision-only scenario rebinding', { skip: HAS_SOURCE ? false : SOURCE_REASON }, async (t) => {
  const f = integrationFixture(t, {
    kind: 'connector', apiId: 'shared_office365', environmentId: 'environment-fixture',
    connectionId: 'connection-fixture', catalogRevision: 'c'.repeat(64),
  });
  const files = [
    'app/_layout.tsx', 'src/data/PrototypeConnectorProvider.tsx', 'src/data/ConnectorPreviewBoundary.tsx',
    'src/data/connector-startup.json', '.tmp/prototype-connector-startup.json', '.tmp/prototype-profile.json',
    '.tmp/prototype-generated.json', '.tmp/data-access-registry.json', '.tmp/prototype-connector-pending.json',
    '.tmp/scenario-facts.json',
  ];
  f.proposal.allowedFiles = [...f.proposal.allowedFiles, ...files];
  assert.doesNotThrow(() => edit.normalizePlan(f.root, f.descriptor, f.proposal));
  for (const file of ['src/data/PrototypeProvider.tsx', 'src/data/ConnectedPrototypeProvider.tsx', 'src/data/runtime.ts', 'src/data/repositories/local.ts', 'src/data/fixtures.ts']) {
    assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, allowedFiles: [...f.proposal.allowedFiles, file] }), /scope/);
  }
  const prepared = await edit.prepare(f.client, f.proposal);
  const plan = edit.loadPlan(f.client, prepared.planId);
  const facts = readJson(f.root, '.tmp/scenario-facts.json');
  write(f.root, '.tmp/scenario-facts.json', { ...facts, scopeRevision: 'approved-successor', persistenceRevision: 'approved-successor', scenarioRevision: 'rebound' });
  assert.doesNotThrow(() => edit.assertScopedDelta(f.root, f.descriptor, plan));
  write(f.root, '.tmp/scenario-facts.json', { ...facts, records: [{ id: 'unapproved-replacement' }] });
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /preserve the canonical local fixture payload/);
});

test('connector startup may restore missing auth routes but cannot overwrite or delete existing auth UI', { skip: HAS_SOURCE ? false : SOURCE_REASON }, async (t) => {
  const f = integrationFixture(t, {
    kind: 'connector', apiId: 'shared_office365', environmentId: 'environment-fixture',
    connectionId: 'connection-fixture', catalogRevision: 'c'.repeat(64),
  });
  const authFiles = ['app/login.tsx', 'app/oauth-callback.tsx'];
  f.proposal.allowedFiles.push(...authFiles);
  const prepared = await edit.prepare(f.client, f.proposal);
  const plan = edit.loadPlan(f.client, prepared.planId);
  for (const file of authFiles) {
    assert.equal(plan.approvedFileBaselines.find((entry) => entry.path === file).sha256, null);
    write(f.root, file, 'export default function RestoredAuthRoute() { return null; }\n');
  }
  assert.doesNotThrow(() => edit.assertScopedDelta(f.root, f.descriptor, plan));
  for (const file of authFiles) {
    const proposal = { ...f.proposal, allowedFiles: f.proposal.allowedFiles.filter((entry) => !authFiles.includes(entry) || entry === file) };
    assert.throws(() => edit.normalizePlan(f.root, f.descriptor, proposal), /only restore missing auth routes/);
    for (const after of [digest('replaced auth UI'), null]) {
      assert.throws(() => integrations.assertIntegrationPreserved(f.root, plan, [{
        path: file, before: digest('existing auth UI'), after,
      }]), /cannot overwrite or delete existing auth UI/);
    }
  }
});

test('connector prepared checks require actual selected-environment config and named SDK outputs, not status alone', (t) => {
  const f = integrationFixture(t, {
    kind: 'connector', apiId: 'shared_office365', environmentId: 'environment-fixture', connectionId: 'office-connection', catalogRevision: 'd'.repeat(64),
  });
  const plan = edit.normalizePlan(f.root, f.descriptor, f.proposal);
  const changes = [{ path: 'power.config.json' }];
  assert.throws(() => integrations.assertIntegrationPrepared(f.root, plan, changes));
  write(f.root, 'power.config.json', { environmentId: 'wrong-environment' });
  assert.throws(() => integrations.assertIntegrationPrepared(f.root, plan, changes), /selected environment/);
  write(f.root, 'power.config.json', { environmentId: f.descriptor.integration.environmentId });
  assert.throws(() => integrations.assertIntegrationPrepared(f.root, plan, changes), /service generation/);
  write(f.root, 'src/generated/services/OfficeService.ts', 'export class FixtureService {}\n');
  assert.doesNotThrow(() => integrations.assertIntegrationPrepared(f.root, plan, changes));
  assert.throws(() => integrations.assertIntegrationPrepared(f.root, plan, [{ path: 'memory-bank.md' }]), /actual configuration/);
});

test('native preparation preserves local ownership and reviews every exact approved file without truncation', { skip: !HAS_SOURCE && SOURCE_REASON }, async (t) => {
  const f = integrationFixture(t);
  f.proposal.allowedFiles.push(...Array.from({ length: 37 }, (_, index) => `src/native/explicit-control-${index}.ts`));
  assert.equal(f.proposal.allowedFiles.length, 40);
  const request = f.client.requestQuestion;
  let question;
  f.client.requestQuestion = async (input, options) => {
    question = input;
    return request(input, options);
  };
  const prepared = await edit.prepare(f.client, f.proposal);
  await edit.authorize(f.client, prepared.planId);
  for (const file of f.proposal.allowedFiles) assert.ok(question.items.join('\n').includes(file), file);
  assert.ok(question.items.every((item) => item.length <= 1000));
  const plan = edit.loadPlan(f.client, prepared.planId);
  const persistence = readJson(f.root, '.tmp/persistence-contract.json');
  write(f.root, '.tmp/persistence-contract.json', { ...persistence, mode: 'mixed' });
  assert.throws(() => edit.assertScopedDelta(f.root, f.descriptor, plan), /cannot change persistence/);
});

test('source delta covers modifications, additions, and deletions, not only reported worker paths', () => {
  const before = { files: [{ path: 'a.ts', sha256: 'a' }, { path: 'b.ts', sha256: 'b' }] };
  const after = { files: [{ path: 'a.ts', sha256: 'changed' }, { path: 'c.ts', sha256: 'c' }] };
  assert.deepEqual(edit.sourceDelta(before, after), [
    { path: 'a.ts', before: 'a', after: 'changed' }, { path: 'b.ts', before: 'b', after: null }, { path: 'c.ts', before: null, after: 'c' },
  ]);
});

test('teaching references existing actions/fields, covers all saves, and emits only bounded rule/registry files', (t) => {
  const f = fixture(t);
  const plan = edit.normalizePlan(f.root, f.descriptor, f.proposal);
  assert.equal(plan.scope, 'all-saves');
  const outputs = edit.ruleOutputs(f.root, plan);
  assert.deepEqual(Object.keys(outputs), edit.RULE_OUTPUTS);
  assert.match(outputs['src/data/rules.ts'].toString(), /assertEntityRules/);
  assert.doesNotMatch(outputs['src/data/rules.ts'].toString(), /eval\(|new Function|src\/generated/);
  const registry = JSON.parse(outputs['.tmp/data-access-registry.json']);
  assert.equal(registry.inputRevisions.rules, digest(canonicalJson(f.rules)));
  const badRule = { ...f.rules.rules[0], actionId: 'inventedSave' };
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, { ...f.proposal, rules: { schemaVersion: 1, rules: [badRule] } }), /existing entity|registered action/);
  const createOnly = structuredClone(f.domain);
  createOnly.actions[0].operation = 'create';
  write(f.root, '.tmp/prototype-domain.json', createOnly);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, f.proposal), /every declared create\/update/);
});

test('compiled teaching rules validate before the common adapter, merge historical evidence, and reject cancelled/failed media', (t) => {
  const f = fixture(t);
  let adapterWrites = 0;
  const assertRules = (entityId, record, operation) => {
    const issues = validateEntityRules(f.domain, f.rules, entityId, record, operation);
    if (issues.length) throw new Error(issues[0].message);
  };
  const save = (old, input, operation) => {
    const record = prepareWrite(f.domain.entities[0], old, input, operation, assertRules);
    adapterWrites += 1;
    return record;
  };
  const photo = { status: 'ready', id: 'photo-1', uri: 'file:///app/photo.jpg' };
  assert.throws(() => save(null, { id: 'new', result: 'fail' }, 'create'), /damage photo/);
  assert.equal(adapterWrites, 0);
  assert.equal(save(null, { id: 'pass-1', result: 'pass' }, 'create').result, 'pass');
  assert.equal(save(null, { id: 'failed-1', result: 'fail', damagePhoto: photo }, 'create').damagePhoto, photo);
  const old = { id: 'old', result: 'fail', damagePhoto: photo };
  assert.equal(save(old, { note: 'Reviewed', damagePhoto: undefined }, 'update').damagePhoto, photo);
  const previousWrites = adapterWrites;
  for (const status of ['pending', 'cancelled', 'failed']) {
    assert.throws(() => save(null, { id: 'failed-photo', result: 'fail', damagePhoto: { ...photo, status } }, 'create'));
  }
  assert.equal(adapterWrites, previousWrites);
  assert.equal(old.damagePhoto, photo);
});

test('candidate screen lookup uses the actual compiled screens/pack contract and rejects unknown/duplicate routes', (t) => {
  const f = fixture(t);
  const snapshot = { files: [{ path: 'app/(app)/inspections/index.tsx', sha256: 'a' }] };
  assert.deepEqual(readyFiles(f.root, snapshot, ['inspection-list']), ['app/(app)/inspections/index.tsx']);
  assert.throws(() => readyFiles(f.root, snapshot, ['unknown']), /compiled screen/);
  assert.throws(() => readyFiles(f.root, {
    files: [...snapshot.files, { path: 'app/inspections.tsx', sha256: 'b' }],
  }, ['inspection-list']), /unambiguous/);
  const compiled = readJson(f.root, '.tmp/compiled-screen-build-pack.json');
  assert.equal(edit.protectedPacks(compiled)[0].pack.primaryActions[0], 'saveInspection');
});

test('sealing/approval/source-bound teaching/candidate/eligible Undo preserve active records and remote journals', { skip: HAS_SOURCE ? false : SOURCE_REASON }, async (t) => {
  const f = fixture(t);
  const source = require('../lib/authoring-source');
  const original = source.captureSource(f.root).revision;
  const proposed = await edit.prepare(f.client, f.proposal);
  assert.equal(source.captureSource(f.root).revision, original);
  await assert.rejects(edit.teach(f.client, proposed.planId), /not approved/);
  const authorization = await edit.authorize(f.client, proposed.planId);
  assert.equal(authorization.status, 'authorized');
  const prepared = await edit.teach(f.client, proposed.planId);
  assert.equal(prepared.applied, false);
  assert.deepEqual(readJson(f.root, '.tmp/prototype-rules.json'), f.rules);
  const checked = await edit.check(f.client, proposed.planId);
  assert.deepEqual(checked.changes.map((entry) => entry.path).sort(), [...edit.RULE_OUTPUTS].sort());
  const submitted = await edit.submit(f.client, proposed.planId, {
    readyScreenIds: ['inspection-list'], final: true, validate: () => ['unit-scope-fixture'],
  });
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.applied, false);
  const undo = readJson(f.root, submitted.undoReceipt);
  assert.equal(edit.undoEligible(f.root, undo), true);
  assert.equal(undo.businessDataIncluded, false);
  assert.deepEqual(readJson(f.root, '.tmp/remote-execution-journal.json'), { applied: ['preserve-remote-evidence'] });
  assert.equal(readJson(f.root, 'stored-business-records.json').damagePhoto.status, 'ready');
  write(f.root, 'unrelated.ts', 'do not undo this');
  assert.equal(edit.undoEligible(f.root, undo), false);
  await assert.rejects(edit.check(f.client, proposed.planId), /out-of-scope/);
});

test('teaching recovery accepts only sealed before/after bytes and refuses stale or cancelled work', { skip: HAS_SOURCE ? false : SOURCE_REASON }, async (t) => {
  const f = fixture(t);
  const proposed = await edit.prepare(f.client, f.proposal);
  await edit.authorize(f.client, proposed.planId);
  const plan = edit.loadPlan(f.client, proposed.planId);
  const outputs = edit.ruleOutputs(f.root, plan);
  write(f.root, edit.RULES_PATH, outputs[edit.RULES_PATH]);
  write(f.root, 'src/data/rules.ts', outputs['src/data/rules.ts']);
  write(f.root, '.tmp/prototype-generated.json', outputs['.tmp/prototype-generated.json']);
  await edit.teach(f.client, proposed.planId);
  assert.deepEqual(readJson(f.root, edit.RULES_PATH), f.rules);
  assert.equal(refreshPrototypeRules(f.root, { check: true }).ok, true);
  f.setActive(false);
  await assert.rejects(edit.check(f.client, proposed.planId), /cancelled/);
  f.setActive(true);
  write(f.root, 'src/data/rules.ts', 'unrelated user changes');
  await assert.rejects(edit.teach(f.client, proposed.planId), /owning compiler/);
});

test('approved recovery file baselines do not depend on inclusion in the shared source index', { skip: HAS_SOURCE ? false : SOURCE_REASON }, async (t) => {
  const f = fixture(t);
  const proposed = await edit.prepare(f.client, f.proposal);
  const plan = edit.loadPlan(f.client, proposed.planId);
  const metadata = '.tmp/prototype-generated.json';
  const expected = plan.approvedFileBaselines.find((entry) => entry.path === metadata);
  assert.ok(expected?.sha256);
  const withoutIndexedMetadata = {
    ...plan, baseline: { ...plan.baseline, files: plan.baseline.files.filter((entry) => entry.path !== metadata) },
  };
  assert.equal(digest(edit.originalBytes(f.root, f.descriptor, withoutIndexedMetadata, metadata)), expected.sha256);
  assert.deepEqual(edit.assertScopedDelta(f.root, f.descriptor, withoutIndexedMetadata).changes, []);
  assert.equal(edit.ruleOutputs(f.root, withoutIndexedMetadata)['src/data/rules.ts'].toString(), generateRulesRuntime(f.domain, f.rules));
});

test('connected teaching explicitly scopes grant revocation and invokes the actual rules-only generator', { skip: HAS_SOURCE ? false : SOURCE_REASON }, async (t) => {
  const f = fixture(t);
  const mapping = { schemaVersion: 1, fixture: 'unchanged-connected-mapping' };
  mapping.mappingRevision = digest(canonicalJson(mapping));
  write(f.root, '.tmp/prototype-dataverse-mapping.json', mapping);
  const registry = readJson(f.root, '.tmp/data-access-registry.json');
  registry.mode = 'connected';
  registry.mappingRevision = mapping.mappingRevision;
  registry.inputRevisions.mapping = mapping.mappingRevision;
  delete registry.registryRevision;
  registry.registryRevision = digest(canonicalJson(registry));
  write(f.root, '.tmp/data-access-registry.json', registry);
  write(f.root, edit.TEST_WRITE_PERMISSION, { permissionId: 'fixture-old-test-grant' });
  const manifest = readJson(f.root, '.tmp/prototype-generated.json');
  manifest.inputRevisions.mapping = mapping.mappingRevision;
  manifest.files[edit.TEST_WRITE_PERMISSION] = digest(fs.readFileSync(path.join(f.root, edit.TEST_WRITE_PERMISSION)));
  write(f.root, '.tmp/prototype-generated.json', manifest);
  rebaseFixture(f);
  assert.throws(() => edit.normalizePlan(f.root, f.descriptor, f.proposal), /existing test-write permission/);
  f.proposal.allowedFiles = [...edit.RULE_OUTPUTS, edit.TEST_WRITE_PERMISSION];
  const preserved = ['src/data/unchanged.ts', 'stored-business-records.json', '.tmp/remote-execution-journal.json', '.tmp/prototype-dataverse-mapping.json']
    .map((file) => [file, fs.readFileSync(path.join(f.root, file))]);
  const proposed = await edit.prepare(f.client, f.proposal);
  const plan = edit.loadPlan(f.client, proposed.planId);
  assert.equal(plan.ruleWrites.length, 5);
  await edit.authorize(f.client, proposed.planId);
  const result = await edit.teach(f.client, proposed.planId);
  assert.equal(result.applied, false);
  assert.equal(readJson(f.root, edit.TEST_WRITE_PERMISSION), null);
  assert.equal(refreshPrototypeRules(f.root, { check: true }).ok, true);
  assert.equal((await edit.check(f.client, proposed.planId)).status, 'scope-checked');
  for (const [file, before] of preserved) assert.deepEqual(fs.readFileSync(path.join(f.root, file)), before, file);
});

test('teaching candidates cannot change the approved rule or overwrite conflicting recovery metadata', { skip: HAS_SOURCE ? false : SOURCE_REASON }, async (t) => {
  const f = fixture(t);
  const proposed = await edit.prepare(f.client, f.proposal);
  await edit.authorize(f.client, proposed.planId);
  const manifest = readJson(f.root, '.tmp/prototype-generated.json');
  write(f.root, '.tmp/prototype-generated.json', { ...manifest, unexpected: 'preserve-user-change' });
  await assert.rejects(edit.teach(f.client, proposed.planId), /changed during recovery/);
  assert.equal(readJson(f.root, '.tmp/prototype-generated.json').unexpected, 'preserve-user-change');
  write(f.root, '.tmp/prototype-generated.json', manifest);
  await edit.teach(f.client, proposed.planId);
  const differentRule = structuredClone(f.rules);
  differentRule.rules[0].when.value = 'pass';
  write(f.root, edit.RULES_PATH, differentRule);
  refreshPrototypeRules(f.root);
  await assert.rejects(edit.check(f.client, proposed.planId), /exact approved compiler outputs/);
});

test('contextual source revisions and approval receipts cannot be reused for a changed proposal', { skip: HAS_SOURCE ? false : SOURCE_REASON }, async (t) => {
  const f = fixture(t);
  const proposed = await edit.prepare(f.client, f.proposal);
  const plan = edit.loadPlan(f.client, proposed.planId);
  write(f.root, 'brand/tokens.ts', 'changed without approval');
  await assert.rejects(edit.inspect(f.client), /stale/);
  await assert.rejects(edit.authorize(f.client, proposed.planId), /before changing/);
  write(f.root, edit.planLocation(f.descriptor, proposed.planId), { ...plan, summary: 'forged expanded scope' });
  assert.throws(() => edit.loadPlan(f.client, proposed.planId), /sealed edit plan/);
});

test('selected list-to-cards compares actual TypeScript query/action/navigation call expressions', { skip: HAS_TYPESCRIPT ? false : 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to existing template dependencies for the TypeScript parse fixture' }, (t) => {
  const f = fixture(t);
  const before = "export default function Screen() { const rows = useEntityList('inspections', { pageSize: 20 }); return <Text>Rows</Text>; }";
  const cards = before.replace('<Text>Rows</Text>', '<Card><Text>Cards</Text></Card>');
  assert.equal(edit.behaviorSignature(f.root, before), edit.behaviorSignature(f.root, cards));
  assert.notEqual(edit.behaviorSignature(f.root, before), edit.behaviorSignature(f.root, cards.replace('pageSize: 20', 'pageSize: 50')));
  const indirect = "import { useEntityList } from '@/data/hooks'; const pageSize = 20; const query = { pageSize }; export default function Screen() { const rows = useEntityList('inspections', query); return <Text>Rows</Text>; }";
  assert.notEqual(edit.behaviorSignature(f.root, indirect), edit.behaviorSignature(f.root, indirect.replace('pageSize = 20', 'pageSize = 50')));
  assert.notEqual(edit.behaviorSignature(f.root, indirect), edit.behaviorSignature(f.root, indirect.replace('@/data/hooks', '@/data/other-adapter')));
});
