'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { generateRulesRuntime } = require('./authoring-rules');
const { compilePrototype } = require('./prototype-domain');
const { inside, readJson, atomicWrite, revision, writeOwnedFiles } = require('./prototype-files');
const { findAppInstanceId } = require('./app-identity');
const { verifyPrototypeStartup } = require('./prototype-startup');

const PATHS = {
  domain: '.tmp/prototype-domain.json',
  bindings: '.tmp/prototype-bindings.json',
  rules: '.tmp/prototype-rules.json',
  persistence: '.tmp/persistence-contract.json',
  facts: '.tmp/scenario-facts.json',
  registry: '.tmp/data-access-registry.json',
};

function captureSources(persistence) {
  const ids = new Set((persistence.nativeCapabilities || []).map((capability) => capability.id));
  return [...(ids.has('camera') ? ['camera'] : []), ...(ids.has('image-picker') ? ['library'] : [])];
}

function photoCaptureSource(persistence) {
  const sources = captureSources(persistence);
  return `${sources.length ? "import * as ImagePicker from 'expo-image-picker';\n" : ''}import { getDataRuntime } from './runtime';
import { createPhotoCapture } from './photo-capture-core';
export const capturePhoto = createPhotoCapture({
  picker: ${sources.length ? 'ImagePicker' : 'null'},
  allowedSources: ${JSON.stringify(sources)},
  persist: (input) => getDataRuntime().importPhoto(input),
});
`;
}

function checkPhotoCaptureTemplate(root, persistence) {
  if (!captureSources(persistence).length) return;
  const selected = readJson(root, 'package.json');
  const canonical = JSON.parse(fs.readFileSync(path.join(__dirname, '../../template/package.json'), 'utf8'));
  if (selected.dependencies?.['expo-image-picker'] !== canonical.dependencies['expo-image-picker']) {
    throw new Error('Approved photo capture requires the already-shipped image picker; do not change dependency versions');
  }
  createRequire(path.join(path.resolve(root), 'package.json')).resolve('expo-image-picker');
}

function fieldType(field) {
  if (field.type === 'number' || field.type === 'boolean') return field.type;
  if (field.type === 'choice') return field.options.map((option) => JSON.stringify(option.id)).join(' | ');
  if (field.type === 'photo') return 'PhotoReference';
  return 'string';
}

function modelSource(domain) {
  return `${fs.readFileSync(path.join(__dirname, '../templates/prototype-images/model.ts'), 'utf8')}
${domain.entities.map((entity) => `export interface ${entity.id} {
  id: string;
${entity.fields.map((field) => `  ${field.id}${field.required ? '' : '?'}: ${fieldType(field)}${field.required ? '' : ' | null'};`).join('\n')}
}`).join('\n\n')}

export interface EntityMap {
${domain.entities.map((entity) => `  ${JSON.stringify(entity.id)}: ${entity.id};`).join('\n')}
}
export type EntityId = keyof EntityMap;
export const domain = ${JSON.stringify(domain, null, 2)} as const;
`;
}

function contractsSource() {
  return `import type { PhotoReference } from './model';
export type EntityRecord = { id: string } & Record<string, unknown>;
export interface Query {
  where?: { fieldId: string; operator: 'equals' | 'not-equals' | 'in' | 'contains' | 'gte' | 'lte'; value: string | number | boolean | null | (string | number | boolean | null)[] }[];
  orderBy?: { fieldId: string; direction: 'asc' | 'desc' }[];
  pageSize?: number;
  cursor?: string;
}
export interface Page<T> { items: T[]; total?: number; nextCursor?: string }
export interface WriteOptions { operationId?: string }
export interface Repository<T extends { id: string }> {
  list(query?: Query): Promise<Page<T>>;
  get(id: string): Promise<T | null>;
  create(values: Omit<T, 'id'> & { id?: string }, options?: WriteOptions): Promise<T>;
  update(id: string, patch: Partial<Omit<T, 'id'>>, options?: WriteOptions): Promise<T>;
  delete(id: string, options?: WriteOptions): Promise<void>;
  reconcileWrite?(operationId: string): Promise<{ status: 'committed' | 'not-committed' | 'conflict'; recordId: string }>;
}
export interface DataPreview { previewKind: 'active' | 'candidate'; dataNamespace: string; baseDataNamespace?: string }
export interface PhotoInput { uri: string; mimeType?: string; fileName?: string; operationId?: string }
export interface DataRuntime {
  namespace: string;
  repositories: Record<string, Repository<EntityRecord>>;
  subscribe(listener: (entityId: string) => void): () => void;
  importPhoto(input: PhotoInput): Promise<Extract<PhotoReference, { status: 'ready' }>>;
  discardCandidate(): Promise<void>;
}
`;
}

function localSource(compiled, persistence) {
  const transientEntityIds = compiled.bindings.entities.filter((binding) => (
    persistence.transientConceptIds.includes(binding.conceptId)
  )).map((binding) => binding.entityId);
  return `import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { domain } from '../model';
import { fixtures } from '../fixtures';
import { assertEntityRules } from '../rules';
import type { DataPreview, DataRuntime } from '../contracts';
import * as core from './core';
import { createLocalStore } from './local-core';

export function createLocalRuntime(preview: DataPreview): DataRuntime {
  return createLocalStore({
    domain, fixtures, storage: AsyncStorage, files: FileSystem, randomUUID,
    assertRules: assertEntityRules, core, preview,
    transientEntityIds: ${JSON.stringify(transientEntityIds)},
  });
}
`;
}

function runtimeSource() {
  return `import type { EntityId, EntityMap } from './model';
import type { DataPreview, DataRuntime, Repository } from './contracts';
import { createLocalRuntime } from './repositories/local';

let preview: DataPreview = { previewKind: 'active', dataNamespace: 'active' };
let runtime: DataRuntime | undefined;

export function configureDataPreview(value: DataPreview): void {
  if (runtime && JSON.stringify(value) !== JSON.stringify(preview)) {
    throw new Error('A data namespace change requires a coordinated preview reload');
  }
  preview = { ...value };
}
export function getDataRuntime(): DataRuntime {
  if (!__DEV__) throw new Error('Local prototypes are development-only. Connect and validate real data before deployment.');
  runtime ??= createLocalRuntime(preview);
  return runtime;
}
export function getRepository<K extends EntityId>(entityId: K): Repository<EntityMap[K]> {
  return getDataRuntime().repositories[entityId] as unknown as Repository<EntityMap[K]>;
}
export type { Query, WriteOptions, DataPreview } from './contracts';
`;
}

function hooksSource() {
  return `import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EntityId, EntityMap } from './model';
import type { Query, WriteOptions } from './contracts';
import { getDataRuntime, getRepository } from './runtime';

export function useEntityList<K extends EntityId>(entityId: K, query: Query = {}) {
  return useQuery({
    queryKey: ['domain', getDataRuntime().namespace, entityId, 'list', query],
    queryFn: () => getRepository(entityId).list(query),
    networkMode: 'always',
  });
}
export function useEntity<K extends EntityId>(entityId: K, id: string | undefined) {
  return useQuery({
    queryKey: ['domain', getDataRuntime().namespace, entityId, 'get', id],
    queryFn: () => id ? getRepository(entityId).get(id) : Promise.resolve(null),
    enabled: !!id, networkMode: 'always',
  });
}
export function useEntityActions<K extends EntityId>(entityId: K) {
  const client = useQueryClient();
  const repository = getRepository(entityId);
  const onSuccess = () => client.invalidateQueries({ queryKey: ['domain', getDataRuntime().namespace, entityId] });
  const create = useMutation({
    mutationFn: ({ values, options }: { values: Omit<EntityMap[K], 'id'> & { id?: string }; options?: WriteOptions }) => repository.create(values, options),
    onSuccess, networkMode: 'always',
  });
  const update = useMutation({
    mutationFn: ({ id, patch, options }: { id: string; patch: Partial<Omit<EntityMap[K], 'id'>>; options?: WriteOptions }) => repository.update(id, patch, options),
    onSuccess, networkMode: 'always',
  });
  const remove = useMutation({
    mutationFn: ({ id, options }: { id: string; options?: WriteOptions }) => repository.delete(id, options),
    onSuccess, networkMode: 'always',
  });
  return { create, update, remove };
}
`;
}

function providerSource() {
  return `import { useEffect, useState, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TamaguiProvider } from 'tamagui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import tamaguiConfig from '../../tamagui.config';
import { getDataRuntime } from './runtime';

export function PrototypeProvider({ children }: PropsWithChildren) {
  const colorScheme = useColorScheme();
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { networkMode: 'always', retry: false }, mutations: { networkMode: 'always', retry: false } },
  }));
  useEffect(() => getDataRuntime().subscribe((entityId) => {
    void client.invalidateQueries({ queryKey: ['domain', getDataRuntime().namespace, entityId] });
  }), [client]);
  if (!__DEV__) throw new Error('A local prototype is not a production authentication mode');
  return (
    <SafeAreaProvider>
      <TamaguiProvider config={tamaguiConfig} defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </TamaguiProvider>
    </SafeAreaProvider>
  );
}
`;
}

function registryFor(compiled, persistence) {
  const registry = {
    schemaVersion: 1, contractType: 'data-access-registry', mode: 'local-prototype',
    inputRevisions: compiled.inputRevisions,
    entities: compiled.domain.entities.map((entity) => {
      const conceptId = compiled.bindings.entities.find((binding) => binding.entityId === entity.id).conceptId;
      return {
        entityId: entity.id, conceptId,
        owner: persistence.conceptOwners.find((owner) => owner.conceptId === conceptId).owner,
        module: '@/data/runtime', modelModule: '@/data/model', recordType: entity.id,
        fields: structuredClone(entity.fields || []),
        operations: entity.operations.map((operation) => ({
          name: operation,
          signature: `getRepository(${JSON.stringify(entity.id)}).${operation}${{
            list: '(query?: Query): Promise<Page<' + entity.id + '>>',
            get: '(id: string): Promise<' + entity.id + ' | null>',
            create: '(values, { operationId? }): Promise<' + entity.id + '>',
            update: '(id: string, patch, { operationId? }): Promise<' + entity.id + '>',
            delete: '(id: string, { operationId? }): Promise<void>',
          }[operation]}`,
        })),
      };
    }),
    media: {
      module: '@/data/capture', captureSources: captureSources(persistence),
      imageModule: '@/data/PrototypeImage',
      signatures: [
        "capturePhoto(source: 'camera' | 'library', options?: { operationId?: string }): Promise<PhotoReference>",
        'getDataRuntime().importPhoto(input: PhotoInput): Promise<PhotoReference>',
        'PrototypeImage(props: PrototypeImageProps): React.JSX.Element',
      ],
    },
  };
  registry.registryRevision = revision(registry);
  return registry;
}

function generatePrototype(root, { check = false, validateOnly = false } = {}) {
  const domain = readJson(root, PATHS.domain);
  if (findAppInstanceId(root) !== domain.appInstanceId) throw new Error('Domain appInstanceId must match the existing app identity');
  const persistence = readJson(root, PATHS.persistence);
  const rules = readJson(root, PATHS.rules);
  const compiled = compilePrototype(domain, readJson(root, PATHS.bindings), {
    persistence, facts: readJson(root, PATHS.facts),
  }, rules);
  checkPhotoCaptureTemplate(root, persistence);
  if (validateOnly) return { ok: true, inputRevisions: compiled.inputRevisions };
  const files = {
    'src/data/model.ts': modelSource(compiled.domain),
    'src/data/contracts.ts': contractsSource(),
    'src/data/fixtures.ts': `// Projection of canonical .tmp/scenario-facts.json; never author fixtures here.\nexport const fixtures = ${JSON.stringify(compiled.fixtures, null, 2)};\n`,
    'src/data/rules.ts': generateRulesRuntime(domain, rules),
    'src/data/repositories/core.js': fs.readFileSync(path.join(__dirname, 'prototype-repository-core.js'), 'utf8'),
    'src/data/repositories/core.d.ts': `export class RepositoryError extends Error { code: string; details?: unknown; constructor(code: string, message: string, details?: unknown); }
export function validateRecord(entity: unknown, record: unknown, options?: { partial?: boolean }): unknown;
export function prepareWrite(entity: unknown, current: unknown, input: unknown, operation: string, assertRules: (entityId: string, record: Readonly<Record<string, unknown>>, operation: 'create' | 'update') => void): unknown;
export function validateQuery(entity: unknown, query?: unknown): unknown;
export function queryRows(rows: unknown[], query: unknown): unknown;
`,
    'src/data/repositories/local-core.js': fs.readFileSync(path.join(__dirname, 'prototype-local-runtime.js'), 'utf8'),
    'src/data/repositories/prototype-images.js': fs.readFileSync(path.join(__dirname, 'prototype-images.js'), 'utf8'),
    'src/data/repositories/prototype-images.d.ts': fs.readFileSync(path.join(__dirname, '../templates/prototype-images/image-core.d.ts'), 'utf8'),
    'src/data/repositories/local-core.d.ts': `import type { DataPreview, DataRuntime } from '../contracts';
export function createLocalStore(options: {
  domain: unknown; fixtures: unknown; storage: unknown; files: unknown; randomUUID: () => string;
  assertRules: (entityId: string, record: Readonly<Record<string, unknown>>, operation: 'create' | 'update') => void;
  core: unknown; preview: DataPreview; transientEntityIds: string[];
}): DataRuntime;
`,
    'src/data/repositories/local.ts': localSource(compiled, persistence),
    'src/data/runtime.ts': runtimeSource(),
    'src/data/hooks.ts': hooksSource(),
    'src/data/capture.ts': photoCaptureSource(persistence),
    'src/data/photo-capture-core.js': fs.readFileSync(path.join(__dirname, 'prototype-photo-capture.js'), 'utf8'),
    'src/data/photo-capture-core.d.ts': `import type { PhotoReference } from './model';
import type { PhotoInput } from './contracts';
interface PickerOptions { mediaTypes: 'images'[]; quality: number; allowsEditing: boolean; exif: boolean; allowsMultipleSelection?: boolean }
interface PickerResult { canceled: boolean; assets: { uri: string; mimeType?: string; fileName?: string | null }[] | null }
interface Picker {
  requestCameraPermissionsAsync(): Promise<{ granted: boolean }>;
  requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }>;
  launchCameraAsync(options: PickerOptions): Promise<PickerResult>;
  launchImageLibraryAsync(options: PickerOptions): Promise<PickerResult>;
}
export function createPhotoCapture(options: {
  picker: Picker | null; allowedSources: readonly ('camera' | 'library')[];
  persist: (input: PhotoInput) => Promise<Extract<PhotoReference, { status: 'ready' }>>;
}): (source: 'camera' | 'library', options?: { operationId?: string }) => Promise<PhotoReference>;
`,
    'src/data/PrototypeImage.tsx': fs.readFileSync(path.join(__dirname, '../templates/prototype-images/PrototypeImage.tsx'), 'utf8'),
    'src/data/index.ts': "export * from './runtime';\nexport * from './hooks';\nexport * from './capture';\nexport * from './PrototypeImage';\nexport type * from './model';\n",
    'src/data/PrototypeProvider.tsx': providerSource(),
  };
  const registry = registryFor(compiled, persistence);
  if (check) {
    for (const [relative, content] of Object.entries(files)) {
      if (!fs.existsSync(inside(root, relative)) || fs.readFileSync(inside(root, relative), 'utf8') !== content) {
        throw new Error(`Prototype output is stale: ${relative}`);
      }
    }
    if (revision(readJson(root, PATHS.registry)) !== revision(registry)) throw new Error('Data access registry is stale');
    if (fs.existsSync(inside(root, '.tmp/prototype-profile.json'))) verifyPrototypeStartup(root);
  } else {
    writeOwnedFiles(root, files, compiled.inputRevisions);
    atomicWrite(root, PATHS.registry, registry);
  }
  return { ok: true, inputRevisions: compiled.inputRevisions, registryRevision: registry.registryRevision, files: Object.keys(files) };
}

module.exports = { PATHS, generatePrototype, registryFor, modelSource, contractsSource, runtimeSource, photoCaptureSource, captureSources, checkPhotoCaptureTemplate };
