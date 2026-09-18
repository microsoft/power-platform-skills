'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compileDataverseMapping } = require('./dataverse-repository-mapping');
const { readJson, atomicWrite, revision, writeOwnedFiles, inside, assertRevision } = require('./prototype-files');
const { generateRulesRuntime } = require('./authoring-rules');
const { projectFixtures } = require('./prototype-domain');
const { photoCaptureSource, captureSources, checkPhotoCaptureTemplate } = require('./prototype-generator');
const { connectedProviderSource, wireConnectedRoot } = require('./prototype-connected-startup');

function liveMediaSource() {
  return `import * as FileSystem from 'expo-file-system/legacy';
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { RepositoryError } from './core';
import { createLiveMedia as createMedia } from './live-media-core';

export function createLiveMedia(namespace: string) {
  return createMedia({
    files: FileSystem, RepositoryError, namespace,
    digest: (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value),
  });
}
`;
}

function liveSource(compiled) {
  const entries = compiled.entities.filter((entry) => entry.owner === 'dataverse');
  const retained = compiled.entities.filter((entry) => entry.retainedAdapter);
  const imports = entries.map((entry, index) => `import { ${entry.serviceExport} as Service${index} } from '../../generated/services/${entry.serviceFile.replace(/\.ts$/, '')}';`).join('\n');
  const retainedImports = retained.map((entry, index) => {
    const relative = path.posix.relative('src/data/repositories', entry.retainedAdapter.file.replace(/\.ts$/, ''));
    return `import { ${entry.retainedAdapter.exportName} as Retained${index} } from '${relative.startsWith('.') ? relative : `./${relative}`}';\nconst checkedRetained${index}: Repository<EntityMap[${JSON.stringify(entry.entityId)}]> = Retained${index};`;
  }).join('\n');
  const methods = entries.map((entry, index) => `${JSON.stringify(entry.entityId)}: {
    getAll: (options: Parameters<typeof Service${index}.getAll>[0]) => Service${index}.getAll(options),
    get: (id: string, options: Parameters<typeof Service${index}.get>[1]) => Service${index}.get(id, options),
    create: (data: Record<string, unknown>) => Service${index}.create(data as unknown as Parameters<typeof Service${index}.create>[0]),
    update: (id: string, data: Record<string, unknown>) => Service${index}.update(id, data as unknown as Parameters<typeof Service${index}.update>[1]),
    delete: (id: string) => Service${index}.delete(id),
  }`).join(',\n  ');
  return `import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { domain, type EntityMap } from '../model';
import { assertEntityRules } from '../rules';
import type { DataPreview, DataRuntime, Repository, EntityRecord } from '../contracts';
import * as core from './core';
import { createDataverseRepositories } from './live-core';
import { createLiveMedia } from './live-media';
import candidateWritePermission from '../test-write-permission.json';
${imports}
${retainedImports}
const mapping = ${JSON.stringify(compiled, null, 2)};
const services = {
  ${methods}
};
export function createLiveRuntime(preview: DataPreview, local: DataRuntime): DataRuntime {
  const namespace = domain.appInstanceId + ':real:v' + domain.schemaVersionNumber + ':' + mapping.environmentKey + ':' + preview.dataNamespace;
  const repositories = createDataverseRepositories({
    domain, mapping, services, core, assertRules: assertEntityRules,
    storage: AsyncStorage, randomUUID, media: createLiveMedia(namespace), preview,
    localRepositories: { ...local.repositories${retained.map((entry, index) => `, ${JSON.stringify(entry.entityId)}: checkedRetained${index} as unknown as Repository<EntityRecord>`).join('')} }, candidateWritePermission,
  });
  return { ...local, namespace, repositories };
}
`;
}

function connectedRuntimeSource(defaultPreview = { previewKind: 'candidate', dataNamespace: 'connected-preview', baseDataNamespace: 'active' }) {
  return `import type { EntityId, EntityMap } from './model';
import type { DataPreview, DataRuntime, Repository } from './contracts';
import { createLocalRuntime } from './repositories/local';
import { createLiveRuntime } from './repositories/live';

// Development conversion candidates remain read-only until explicit Apply.
// A deployed connected app uses real auth/data, not a permanent authoring lock.
let preview: DataPreview = __DEV__ ? ${JSON.stringify(defaultPreview)} : { previewKind: 'active', dataNamespace: 'active' };
let runtime: DataRuntime | undefined;
export function configureDataPreview(value: DataPreview): void {
  if (runtime && JSON.stringify(value) !== JSON.stringify(preview)) throw new Error('A data namespace change requires a coordinated reload');
  preview = { ...value };
}
export function getDataRuntime(): DataRuntime {
  runtime ??= createLiveRuntime(preview, createLocalRuntime(preview));
  return runtime;
}
export function getRepository<K extends EntityId>(entityId: K): Repository<EntityMap[K]> {
  return getDataRuntime().repositories[entityId] as unknown as Repository<EntityMap[K]>;
}
export type { Query, WriteOptions, DataPreview } from './contracts';
`;
}

function generateDataverseRepositories(root) {
  const domain = readJson(root, '.tmp/prototype-domain.json');
  const rules = readJson(root, '.tmp/prototype-rules.json');
  const bindings = readJson(root, '.tmp/prototype-bindings.json');
  const facts = readJson(root, '.tmp/scenario-facts.json');
  const persistence = readJson(root, '.tmp/persistence-contract.json');
  const profile = readJson(root, '.tmp/prototype-profile.json');
  const registry = readJson(root, '.tmp/data-access-registry.json');
  assertRevision(registry, 'registryRevision', 'Data-access registry');
  if (registry.contractType !== 'data-access-registry' || registry.entities.length !== domain.entities.length
    || registry.inputRevisions.domain !== revision(domain)) throw new Error('Conversion requires the current existing logical data registry');
  if (facts.persistenceRevision !== persistence.persistenceRevision || facts.scopeRevision !== persistence.scopeRevision) {
    throw new Error('Canonical scenario facts must be rebound to the approved successor ownership');
  }
  const compiled = compileDataverseMapping({
    root, domain, mapping: readJson(root, '.tmp/prototype-dataverse-mapping-input.json'),
    schema: readJson(root, '.tmp/dataverse-schema-contract.json'),
    snapshot: readJson(root, '.tmp/prototype-materialized-snapshot.json'),
    persistence,
    bindings,
    relationshipEvidence: readJson(root, '.tmp/prototype-relationship-evidence.json'),
  });
  checkPhotoCaptureTemplate(root, persistence);
  for (const entry of compiled.entities.filter((entry) => entry.owner !== 'dataverse')) {
    if (registry.entities.find((entity) => entity.entityId === entry.entityId)?.owner !== entry.owner) {
      throw new Error(`Conversion must preserve the existing non-Dataverse owner of ${entry.entityId}`);
    }
  }
  const manifest = writeOwnedFiles(root, {
    'src/data/capture.ts': photoCaptureSource(persistence),
    'src/data/fixtures.ts': `// Projection of canonical .tmp/scenario-facts.json; never author fixtures here.\nexport const fixtures = ${JSON.stringify(projectFixtures(domain, bindings, facts), null, 2)};\n`,
    'src/data/rules.ts': generateRulesRuntime(domain, rules),
    'src/data/repositories/live-core.js': fs.readFileSync(path.join(__dirname, 'dataverse-repository-runtime.js'), 'utf8'),
    'src/data/repositories/live-core.d.ts': `import type { DataRuntime, DataPreview } from '../contracts';
export function createDataverseRepositories(options: {
  domain: unknown; mapping: unknown; services: unknown; core: unknown;
  assertRules: (entityId: string, record: Readonly<Record<string, unknown>>, operation: 'create' | 'update') => void;
  storage: unknown; randomUUID: () => string; media: unknown; preview: DataPreview;
  localRepositories: DataRuntime['repositories']; candidateWritePermission?: unknown;
}): DataRuntime['repositories'];
`,
    'src/data/repositories/live-media.ts': liveMediaSource(),
    'src/data/test-write-permission.json': 'null\n',
    'src/data/repositories/live-media-core.js': fs.readFileSync(path.join(__dirname, 'dataverse-repository-media.js'), 'utf8'),
    'src/data/repositories/live-media-core.d.ts': `import type { PhotoReference } from '../model';
export function createLiveMedia(options: {
  files: unknown; digest: (value: string) => Promise<string>; namespace: string; RepositoryError: unknown;
}): {
  fromBase64(entityId: string, recordId: string, fieldId: string, value: unknown, maxSizeInKB?: number): Promise<PhotoReference>;
  toBase64(value: PhotoReference, maxSizeInKB: number): Promise<string>;
};
`,
    'src/data/repositories/live.ts': liveSource(compiled),
    'src/data/runtime.ts': connectedRuntimeSource(profile.profile === 'connected' ? { previewKind: 'active', dataNamespace: profile.dataNamespace || 'active' } : undefined),
  }, { domain: revision(domain), rules: revision(rules), mapping: compiled.mappingRevision });
  atomicWrite(root, '.tmp/prototype-dataverse-mapping.json', compiled);
  registry.mode = 'connected';
  registry.mappingRevision = compiled.mappingRevision;
  registry.inputRevisions.persistence = compiled.persistenceRevision;
  registry.inputRevisions.mapping = compiled.mappingRevision;
  registry.inputRevisions.domain = revision(domain);
  registry.inputRevisions.bindings = revision(bindings);
  registry.inputRevisions.rules = revision(rules);
  registry.inputRevisions.scenario = facts.scenarioRevision;
  if (registry.media) registry.media.captureSources = captureSources(persistence);
  for (const entity of registry.entities) {
    const mapping = compiled.entities.find((entry) => entry.entityId === entity.entityId);
    entity.owner = mapping.owner;
    if (mapping.owner === 'dataverse') {
      entity.tableLogicalName = mapping.logicalName;
      entity.entitySetName = mapping.entitySetName;
    }
  }
  delete registry.registryRevision;
  registry.registryRevision = revision(registry);
  atomicWrite(root, '.tmp/data-access-registry.json', registry);
  return { ok: true, mappingRevision: compiled.mappingRevision, files: Object.keys(manifest.files) };
}

function stageConnectedStartup(root) {
  const backup = readJson(root, '.tmp/prototype-connected-template.json');
  const profile = readJson(root, '.tmp/prototype-profile.json');
  if (backup.schemaVersion !== 1 || backup.entryRoute !== profile.entryRoute
    || typeof profile.entryRoute !== 'string' || !/^\/[A-Za-z0-9_/()\-]+$/.test(profile.entryRoute)) {
    throw new Error('Connected startup requires the saved supported template and current approved entry route');
  }
  if (!fs.existsSync(inside(root, 'power.config.json')) || !fs.existsSync(inside(root, 'src/generated/connectorSchemas.ts'))) {
    throw new Error('Official initialization and schema generation must finish before staging connected startup');
  }
  const rootSource = wireConnectedRoot(root, fs.readFileSync(inside(root, 'app/_layout.tsx'), 'utf8'));
  const provider = connectedProviderSource(root, backup.files['app/_layout.tsx']);
  const authRoutes = {};
  for (const [file, marker] of [['app/login.tsx', 'useAuth'], ['app/oauth-callback.tsx', 'completePowerAppsAuthSession']]) {
    if (fs.existsSync(inside(root, file))) continue;
    const saved = backup.files[file];
    if (typeof saved !== 'string' || !saved.includes(marker)) throw new Error(`The saved supported auth route is missing: ${file}`);
    authRoutes[file] = saved.replace(/(["'])\/\(app\)\/home\1/g, JSON.stringify(profile.entryRoute));
  }
  const groupPath = 'app/(app)/_layout.tsx';
  let layout = fs.readFileSync(inside(root, groupPath), 'utf8');
  if (!layout.includes('<ConnectedGate>')) {
    const functionStart = /export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/;
    const match = functionStart.exec(layout);
    if (!match) throw new Error('Connected auth guard needs the bounded foreground layout update');
    layout = `import { ConnectedGate } from '@/data/ConnectedGate';\n${layout.replace(functionStart, `function ${match[1]}() {`)}
export default function ConnectedAppLayout() {
  return <ConnectedGate><${match[1]} /></ConnectedGate>;
}
`;
  }
  writeOwnedFiles(root, {
    'src/data/ConnectedProvider.tsx': provider,
    'src/data/ConnectedGate.tsx': `import type { PropsWithChildren } from 'react';
import { useAuth } from '@microsoft/power-apps-native-host';
import { Redirect } from 'expo-router';
export function ConnectedGate({ children }: PropsWithChildren) {
  const { isSignedIn, isLoading } = useAuth();
  if (isLoading) return null;
  if (!isSignedIn) return <Redirect href="/login" />;
  return children;
}
`,
  }, readJson(root, '.tmp/prototype-generated.json').inputRevisions);
  atomicWrite(root, 'app/_layout.tsx', rootSource);
  for (const [file, bytes] of Object.entries(authRoutes)) atomicWrite(root, file, bytes);
  atomicWrite(root, groupPath, layout);
  const packageJson = readJson(root, 'package.json');
  if (packageJson.scripts?.['dev:prototype'] !== undefined) {
    delete packageJson.scripts['dev:prototype'];
    atomicWrite(root, 'package.json', packageJson);
  }
  return { ok: true, files: ['src/data/ConnectedProvider.tsx', 'src/data/ConnectedGate.tsx', 'app/_layout.tsx', ...Object.keys(authRoutes), groupPath] };
}

module.exports = { generateDataverseRepositories, stageConnectedStartup, connectedRuntimeSource };
