'use strict';

const path = require('node:path');
const protocol = require('./authoring-protocol');
const { readNativeCatalog } = require('./native-capability-catalog');
const { canonicalJson, digest, exists, inside, readFile, readJson, relativePath } = require('./mobile-authoring-files');

const COORDINATION_FILES = new Set([
  '.tmp/architecture-decisions.json', '.tmp/persistence-contract.json', '.tmp/navigation-manifest.json',
  '.tmp/mobile-plan-status.json', '.tmp/pipeline-state.json', '.tmp/screen-builder-state.json',
  '.tmp/generated-services-snapshot.md',
]);
const RESTORABLE_AUTH_FILES = new Set(['app/login.tsx', 'app/oauth-callback.tsx']);
const LOCAL_CAPTURE_OUTPUTS = ['src/data/capture.ts', '.tmp/prototype-generated.json', '.tmp/data-access-registry.json'];
const CONNECTOR_CAPTURE_STATE = '.tmp/prototype-connector-startup.json';
const CONNECTOR_FILES = new Set([
  'power.config.json', '.resolved-environment.json', 'auth.config.json', 'package.json',
  ...RESTORABLE_AUTH_FILES,
  'app/_layout.tsx', 'src/data/PrototypeConnectorProvider.tsx', 'src/data/ConnectorPreviewBoundary.tsx',
  'src/data/connector-startup.json', '.tmp/prototype-connector-startup.json',
  '.tmp/prototype-profile.json', '.tmp/prototype-generated.json', '.tmp/data-access-registry.json',
  '.tmp/prototype-connector-pending.json', '.tmp/scenario-facts.json',
  '.tmp/prototype-connection-catalog.json', '.tmp/prototype-connection-selection.json',
  '.tmp/prototype-connector-preview.json', '.tmp/connector-integration.json',
]);
const DEPENDENCY_KEYS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'overrides', 'resolutions', 'pnpm',
];
const DATAVERSE_APIS = new Set(['commondataservice', 'commondataserviceforapps', 'dataverse']);
const PLUGIN_ROOT = path.resolve(__dirname, '../..');

function apiName(apiId) {
  return apiId.split('/').at(-1).toLowerCase().replace(/^shared_/, '');
}

function persistence(root) {
  return readJson(root, '.tmp/persistence-contract.json');
}

function selection(descriptor) {
  if (descriptor.operation !== 'edit' || !descriptor.integration) {
    throw new Error('A native or connector add requires a bridge-bound edit catalogue selection');
  }
  return protocol.assertIntegrationSelection(descriptor.integration);
}

function integrationRoute(root, descriptor, { connectorName } = {}) {
  const selected = selection(descriptor);
  const current = persistence(root);
  if (selected.kind === 'native') {
    // Selection is bound to the immutable base and selected template catalogue.
    // Package compatibility is not a claim that device hardware was exercised.
    const item = readNativeCatalog(root).items.find((entry) => entry.id === selected.capabilityId);
    if (!item || item.availability !== 'available') {
      throw new Error(item?.reason || 'The selected native control is not shipped by this app');
    }
    const profile = exists(root, '.tmp/prototype-profile.json') ? readJson(root, '.tmp/prototype-profile.json') : null;
    return {
      kind: 'native', skill: 'add-native', selection: selected,
      inputs: {
        capabilityId: selected.capabilityId,
        prototype: profile ? profile.profile === 'prototype' : current.mode === 'local-prototype',
      },
      title: item.title, package: item.package, wrapper: item.wrapper || null,
      localCapture: item.wrapper === 'src/data/capture.ts',
      connectedCapture: item.wrapper === 'src/data/capture.ts' && profile?.profile === 'connector',
      fromDataMode: current.mode, requiresGate1: true,
      packageChanges: false, remoteMetadataReads: false, businessDataChanges: false,
      sourceOfTemplateSupport: 'selected-template-package-catalogue',
    };
  }
  const name = apiName(selected.apiId);
  if (DATAVERSE_APIS.has(name)) {
    throw new Error('Dataverse uses the separate Connect to Dataverse operation, not an implicit connector add');
  }
  const config = exists(root, 'power.config.json') ? readJson(root, 'power.config.json') : null;
  if (config && config.environmentId !== selected.environmentId) {
    throw new Error('The selected connection belongs to a different environment; an environment migration needs its own explicit plan');
  }
  if (connectorName !== undefined && (typeof connectorName !== 'string'
    || connectorName.length > 120 || !/^[a-z0-9]/.test(connectorName) || /[^a-z0-9-]/.test(connectorName))) {
    throw new Error('The connector owner must be an explicit canonical lowercase architecture name');
  }
  return {
    kind: 'connector', skill: name === 'sharepointonline' ? 'add-sharepoint' : 'add-connector',
    selection: selected,
    inputs: {
      apiId: selected.apiId, environmentId: selected.environmentId, catalogRevision: selected.catalogRevision,
      ...(connectorName === undefined ? {} : { connectorName }),
      ...(selected.connectionId ? { connectionId: selected.connectionId } : { connectionRef: selected.connectionRef }),
      existingConnectionOnly: true, existingResourcesOnly: true,
    },
    fromDataMode: current.mode, initializesApp: !config, requiresGate1: true,
    requiresConnectionAccessConsent: true,
    ...(connectorName === undefined ? { requiresConnectorName: true } : { connectorName }),
    connectedOperation: true, packageChanges: false, remoteMetadataReads: true, businessDataChanges: false,
    createsConnection: false, createsDataverseSchema: false, importsPrototypeRecords: false,
    preservesLocalDomain: true,
  };
}

function allowedIntegrationFile(file, route, screenFiles) {
  relativePath(file);
  if (COORDINATION_FILES.has(file) || screenFiles.includes(file)) return true;
  if (route.kind === 'native') return /^src\/native\/[^/]+\.(?:ts|tsx)$/.test(file)
    || (route.localCapture && [...captureOutputFiles(route), '.tmp/scenario-facts.json'].includes(file));
  return CONNECTOR_FILES.has(file)
    || /^src\/generated\/.+\.(?:ts|tsx|json)$/.test(file)
    || /^\.power\/schemas\/.+\.(?:json|ts)$/.test(file);
}

function assertIntegrationWorkflow(route) {
  const expected = route.kind === 'native' ? 'add-native'
    : route.kind === 'connector' ? (apiName(route.selection.apiId) === 'sharepointonline' ? 'add-sharepoint' : 'add-connector') : null;
  if (!expected || route.skill !== expected) throw new Error('The integration requires its fixed owning workflow');
  const files = [`skills/${expected}/SKILL.md`, ...(route.kind === 'native'
    ? ['scripts/verify-prototype-native.js', ...(route.localCapture ? ['scripts/lib/prototype-generator.js'] : [])]
    : ['scripts/verify-prototype-connection.js', 'scripts/stage-prototype-connector.js', 'scripts/lib/prototype-connector-startup.js'])];
  if (files.some((file) => !exists(PLUGIN_ROOT, file))) {
    throw new Error('The selected integration execution workflow is not installed; catalogue browsing does not authorize a fallback');
  }
}

function validateIntegrationPlan(root, descriptor, input) {
  const route = integrationRoute(root, descriptor, { connectorName: input.connectorName });
  assertIntegrationWorkflow(route);
  const allowedFiles = input.allowedFiles;
  if (route.kind === 'native' && route.wrapper && !input.screenIds?.length
    && !exists(root, route.wrapper) && !allowedFiles.includes(route.wrapper)) {
    throw new Error('The native proposal must include the actual selected control wrapper');
  }
  if (route.kind === 'native' && !route.wrapper && !input.screenIds?.length) {
    throw new Error('A native UI control needs an explicitly selected or proposed screen');
  }
  if (route.localCapture && captureOutputFiles(route).some((file) => allowedFiles.includes(file))
    && captureOutputFiles(route).some((file) => !allowedFiles.includes(file))) {
    throw new Error('Local native capture refresh must explicitly include capture.ts and both compiler-owned metadata outputs');
  }
  if (route.kind === 'connector') {
    if (!route.connectorName) throw new Error('The connector proposal must bind its explicit architecture connectorName');
    if (allowedFiles.some((file) => RESTORABLE_AUTH_FILES.has(file) && exists(root, file))) {
      throw new Error('Connector startup may only restore missing auth routes; existing auth UI must remain unchanged');
    }
    if (!allowedFiles.some((file) => /^src\/generated\/services\/[^/]+\.ts$/.test(file))) {
      throw new Error('The connector proposal must name its expected official generated service files');
    }
    if (route.initializesApp && !allowedFiles.includes('power.config.json')) {
      throw new Error('The connected preparation must explicitly include official app initialization');
    }
  }
  return route;
}

function sameIntegration(left, right) {
  return canonicalJson(left || null) === canonicalJson(right || null);
}

function captureOutputFiles(route) {
  return [...LOCAL_CAPTURE_OUTPUTS, ...(route.connectedCapture ? [CONNECTOR_CAPTURE_STATE] : [])];
}

function reboundCaptureStartup(before, inputRevisions) {
  const state = structuredClone(before);
  state.inputRevisions = { ...state.inputRevisions, ...inputRevisions };
  delete state.startupRevision;
  state.startupRevision = require('./prototype-files').revision(state);
  return state;
}

function captureRegistry(registry, inputRevisions) {
  const result = { ...registry, inputRevisions };
  delete result.registryRevision;
  result.registryRevision = require('./prototype-files').revision(result);
  return result;
}

function localCaptureProjection(root, route) {
  const { compilePrototype } = require('./prototype-domain');
  const { photoCaptureSource, captureSources, checkPhotoCaptureTemplate, registryFor } = require('./prototype-generator');
  const current = persistence(root);
  const selectedSource = { camera: 'camera', 'image-picker': 'library' }[route.selection.capabilityId];
  if (!selectedSource || !captureSources(current).includes(selectedSource)) {
    throw new Error('The selected local capture source is not present in the approved persistence capability projection');
  }
  checkPhotoCaptureTemplate(root, current);
  const expected = photoCaptureSource(current);
  const compiled = compilePrototype(readJson(root, '.tmp/prototype-domain.json'), readJson(root, '.tmp/prototype-bindings.json'), {
    persistence: current, facts: readJson(root, '.tmp/scenario-facts.json'),
  }, readJson(root, '.tmp/prototype-rules.json'));
  return { compiled, code: expected, registry: registryFor(compiled, current), captureHash: digest(expected) };
}

function localCaptureOutputs(root, route, originalJson) {
  const projection = localCaptureProjection(root, route);
  const manifest = structuredClone(originalJson('.tmp/prototype-generated.json'));
  if (!manifest.files?.['src/data/capture.ts']) throw new Error('Local capture requires its existing compiler-owned module');
  manifest.inputRevisions = { ...manifest.inputRevisions, ...projection.compiled.inputRevisions };
  manifest.files['src/data/capture.ts'] = projection.captureHash;
  const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const outputs = {
    'src/data/capture.ts': Buffer.from(projection.code),
    '.tmp/prototype-generated.json': json(manifest),
    '.tmp/data-access-registry.json': json(captureRegistry(projection.registry, manifest.inputRevisions)),
  };
  if (route.connectedCapture) {
    outputs[CONNECTOR_CAPTURE_STATE] = json(reboundCaptureStartup(originalJson(CONNECTOR_CAPTURE_STATE), projection.compiled.inputRevisions));
  }
  return outputs;
}

function verifyLocalCapture(root, route) {
  const { compiled, code, registry, captureHash } = localCaptureProjection(root, route);
  const manifest = readJson(root, '.tmp/prototype-generated.json');
  const inputRevisions = { ...manifest.inputRevisions, ...compiled.inputRevisions };
  if (readFile(inside(root, 'src/data/capture.ts')).toString('utf8') !== code) {
    throw new Error('Local capture must match the actual prototype capture producer');
  }
  if (canonicalJson(readJson(root, '.tmp/data-access-registry.json')) !== canonicalJson(captureRegistry(registry, inputRevisions))) {
    throw new Error('Local capture registry must match the actual compiler projection without replacing local owners');
  }
  if (canonicalJson(manifest.inputRevisions) !== canonicalJson(inputRevisions)
    || manifest.files?.['src/data/capture.ts'] !== captureHash) {
    throw new Error('Local capture ownership metadata is stale');
  }
  if (route.connectedCapture) require('./prototype-connector-startup').verifyPrototypeConnectorStartup(root);
  return { compiled, captureHash };
}

function assertArchitectureSelection(root, route) {
  const architecture = readJson(root, '.tmp/architecture-decisions.json');
  if (route.kind === 'native') {
    if (!architecture.nativeCapabilities?.some((entry) => entry.id === route.selection.capabilityId && entry.approved === true)) {
      throw new Error('Gate 1 must explicitly approve the selected native capability');
    }
  } else if (!route.connectorName || !architecture.connectors?.some((entry) => (
    entry.apiName === route.connectorName && entry.approved === true
    && (entry.apiId === undefined || (typeof entry.apiId === 'string' && apiName(entry.apiId) === apiName(route.selection.apiId)))
  ))) throw new Error('Gate 1 must explicitly approve the sealed connector owner and selected API binding');
}

function assertIntegrationPreserved(root, plan, changes, originalJson) {
  if (!plan.integrationRoute) throw new Error('The edit is missing its sealed integration route');
  if (plan.integrationRoute.kind === 'connector'
    && changes.some((entry) => RESTORABLE_AUTH_FILES.has(entry.path) && entry.before !== null)) {
    throw new Error('Connector startup cannot overwrite or delete existing auth UI');
  }
  if (changes.some((entry) => /^(?:\.tmp\/dataverse-|\.datamodel-manifest\.json$|offline-profile\.json$)/.test(entry.path))) {
    throw new Error('Adding a native control or connector does not authorize Dataverse schema or offline-profile mutation');
  }
  if (changes.some((entry) => entry.path === 'package.json')) {
    const before = originalJson('package.json');
    const after = readJson(root, 'package.json');
    if (DEPENDENCY_KEYS.some((key) => canonicalJson(before[key] || null) !== canonicalJson(after[key] || null))) {
      throw new Error('A catalogue add cannot install, remove, or upgrade dependencies');
    }
    const permitted = structuredClone(before);
    if (permitted.scripts) delete permitted.scripts['dev:prototype'];
    if (canonicalJson(after) !== canonicalJson(before) && canonicalJson(after) !== canonicalJson(permitted)) {
      throw new Error('Connector startup may only remove dev:prototype from package.json');
    }
  }
  if (changes.some((entry) => entry.path === '.tmp/scenario-facts.json')) {
    const before = originalJson('.tmp/scenario-facts.json');
    const after = readJson(root, '.tmp/scenario-facts.json');
    for (const value of [before, after]) {
      for (const key of ['scenarioRevision', 'scopeRevision', 'persistenceRevision']) delete value[key];
    }
    if (canonicalJson(before) !== canonicalJson(after)) {
      throw new Error('The integration must preserve the canonical local fixture payload');
    }
  }
  if (changes.some((entry) => entry.path === '.tmp/persistence-contract.json')) {
    const before = originalJson('.tmp/persistence-contract.json');
    const after = persistence(root);
    if (plan.integrationRoute.kind === 'native') {
      for (const key of ['mode', 'conceptOwners', 'dataverseConceptIds', 'connectorConceptIds', 'localConceptIds', 'transientConceptIds']) {
        if (canonicalJson(before[key] || null) !== canonicalJson(after[key] || null)) {
          throw new Error('Adding a native control cannot change persistence ownership');
        }
      }
      const selectedId = plan.integrationRoute.selection.capabilityId;
      if (canonicalJson((before.nativeCapabilities || []).filter((entry) => entry.id !== selectedId))
        !== canonicalJson((after.nativeCapabilities || []).filter((entry) => entry.id !== selectedId))) {
        throw new Error('A native add cannot change unrelated capability decisions');
      }
    }
    for (const owner of before.conceptOwners || []) {
      if (!['local', 'transient'].includes(owner.owner)) continue;
      const updated = after.conceptOwners?.find((entry) => entry.conceptId === owner.conceptId);
      if (!updated || updated.owner !== owner.owner) throw new Error('Adding a connector must preserve the existing local domain ownership');
    }
    if (plan.integrationRoute.fromDataMode === 'local-prototype'
      && (after.dataverseConceptIds?.length || after.conceptOwners?.some((entry) => entry.owner === 'dataverse'))) {
      throw new Error('Adding a connector to a prototype does not convert its data to Dataverse');
    }
  }
  if (plan.integrationRoute.localCapture && changes.some((entry) => captureOutputFiles(plan.integrationRoute).includes(entry.path))) {
    const { compiled, captureHash } = verifyLocalCapture(root, plan.integrationRoute);
    if (changes.some((entry) => entry.path === '.tmp/prototype-generated.json')) {
      const expected = structuredClone(originalJson('.tmp/prototype-generated.json'));
      expected.inputRevisions = { ...expected.inputRevisions, ...compiled.inputRevisions };
      expected.files['src/data/capture.ts'] = captureHash;
      if (canonicalJson(readJson(root, '.tmp/prototype-generated.json')) !== canonicalJson(expected)) {
        throw new Error('Native capture must preserve every unrelated compiler-owned file and ownership record');
      }
    }
    if (changes.some((entry) => entry.path === CONNECTOR_CAPTURE_STATE)) {
      const expected = reboundCaptureStartup(originalJson(CONNECTOR_CAPTURE_STATE), compiled.inputRevisions);
      if (canonicalJson(readJson(root, CONNECTOR_CAPTURE_STATE)) !== canonicalJson(expected)) {
        throw new Error('Native capture cannot change connector selection, configuration or preview namespace');
      }
    }
  }
}

function assertIntegrationPrepared(root, plan, changes) {
  const route = plan.integrationRoute;
  if (route.kind === 'native') {
    if (route.localCapture) verifyLocalCapture(root, route);
    const screenChanged = changes.some((entry) => entry.path.startsWith('app/') && entry.path.endsWith('.tsx')
      && !entry.path.endsWith('/_layout.tsx'));
    if (route.wrapper && !exists(root, route.wrapper) && !screenChanged) throw new Error('The selected native wrapper or host-owned screen control has not been prepared');
    if (!changes.some((entry) => entry.path.startsWith('src/native/') || entry.path === route.wrapper) && !screenChanged) {
      throw new Error('The native add has no actual wrapper or screen implementation change');
    }
    return;
  }
  const config = readJson(root, 'power.config.json');
  if (config.environmentId !== route.selection.environmentId) {
    throw new Error('The prepared connector is not bound to the selected environment');
  }
  const services = plan.allowedFiles.filter((file) => /^src\/generated\/services\/[^/]+\.ts$/.test(file));
  if (!services.length || services.some((file) => !exists(root, file))) {
    throw new Error('Official connector service generation has not completed');
  }
  if (!changes.some((entry) => entry.path === 'power.config.json' || entry.path.startsWith('.power/schemas/')
    || entry.path.startsWith('src/generated/'))) throw new Error('The connector add has no actual configuration or SDK output change');
  // Presence is not proof of authenticated runtime access. The owning skill
  // must verify official SDK generation; the normal static candidate gates and
  // bridge publication checks still run, and no business-data probe is implied.
}

function integrationReviewItems(route) {
  if (route.kind === 'native') {
    return [
      `Native control: ${route.title} (${route.selection.capabilityId}).`,
      'Use the selected template package workflow; no device inventory or optional binary probe is required to select it.',
      'Keep ordinary runtime bans and version requirements; handle permission denial or unavailable hardware in the app without claiming a hardware test.',
      'No dependency installs/upgrades, native configuration changes, or remote data operations.',
    ];
  }
  return [
    `Existing connector: ${route.selection.apiId}.`,
    `Approved architecture owner: ${route.connectorName}.`,
    `Environment: ${route.selection.environmentId}.`,
    route.selection.connectionId ? `Existing connection: ${route.selection.connectionId}.` : `Existing connection reference: ${route.selection.connectionRef}.`,
    route.initializesApp ? 'Explicitly initialize this candidate in that environment and generate official SDK services.' : 'Keep the existing environment and configure this selected connection.',
    'Connection/schema access requires its own maker consent and scoped execution grant; this preparation does not grant access.',
    'Do not create connections, SharePoint lists/columns, Dataverse schema, or import prototype records/photos.',
    'Preserve local repositories, rules, stored data, existing UI, and candidate data isolation.',
    'Gate only the added connector UI/actions with sign-in, not existing local screens; restore only missing auth routes.',
  ];
}

module.exports = {
  COORDINATION_FILES, CONNECTOR_FILES, LOCAL_CAPTURE_OUTPUTS, apiName, selection, integrationRoute,
  allowedIntegrationFile, validateIntegrationPlan, sameIntegration, assertArchitectureSelection,
  assertIntegrationWorkflow,
  assertIntegrationPreserved, assertIntegrationPrepared, integrationReviewItems, verifyLocalCapture,
  captureOutputFiles, localCaptureOutputs,
};
