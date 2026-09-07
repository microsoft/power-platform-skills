'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { readJson, inside, atomicWrite, revision, assertRevision, writeOwnedFiles } = require('./prototype-files');
const { sha256Hex } = require('./product-experience-contracts');
const { connectedRuntimeSource } = require('./dataverse-repository-generator');
const { connectedProviderSource, wireConnectedRoot } = require('./prototype-connected-startup');

const FILES = [
  'src/data/runtime.ts', 'src/data/test-write-permission.json',
  '.tmp/prototype-generated.json', '.tmp/prototype-profile.json', '.tmp/prototype-conversion-journal.json',
];

function typecheck(root) {
  const compiler = createRequire(path.join(path.resolve(root), 'package.json')).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--project', path.join(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Connected activation TypeScript gate failed; the previous source was restored');
}

// This is the data-selection step inside the foreground's already-approved
// standalone transaction. It does not publish, copy workspaces, or move Metro.
function activateConnectedData(root, { expectedSourceRevision, confirmStandaloneApply = false } = {}, {
  env = process.env, captureSource, validateProject = typecheck,
} = {}) {
  if (env.MOBILE_AUTHORING_CONTEXT || env.MOBILE_AUTHORING_RUNNER_TOKEN) {
    throw new Error('Player Apply is bridge-owned; configure the authorized runtime stamp instead of mutating active source');
  }
  if (!confirmStandaloneApply || typeof expectedSourceRevision !== 'string' || expectedSourceRevision.length !== 64
    || !/^[a-f0-9]{64}$/.test(expectedSourceRevision)) {
    throw new Error('Standalone data activation requires explicit Apply confirmation and the reviewed source revision');
  }
  const capture = captureSource || require('./authoring-source').captureSource;
  const before = capture(root);
  if (before.revision !== expectedSourceRevision) throw new Error('The reviewed connected candidate changed before Apply');
  const journal = readJson(root, '.tmp/prototype-conversion-journal.json');
  if (!['metadata', 'services', 'schemas', 'adapters', 'startup'].every((phase) => journal.completed?.includes(phase)) || journal.dataImport !== 'none') {
    throw new Error('A completed, no-import connected candidate is required before Apply');
  }
  const domain = readJson(root, '.tmp/prototype-domain.json');
  const mapping = readJson(root, '.tmp/prototype-dataverse-mapping.json');
  const registry = readJson(root, '.tmp/data-access-registry.json');
  assertRevision(mapping, 'mappingRevision', 'Dataverse mapping');
  assertRevision(registry, 'registryRevision', 'Data-access registry');
  if (mapping.domainRevision !== revision(domain) || registry.mode !== 'connected'
    || registry.mappingRevision !== mapping.mappingRevision
    || mapping.environmentKey !== revision({ environmentId: readJson(root, 'power.config.json').environmentId })) {
    throw new Error('Connected activation cannot use stale domain, registry, or environment bindings');
  }
  const auth = readJson(root, 'auth.config.json').msal;
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rootSource = fs.readFileSync(inside(root, 'app/_layout.tsx'), 'utf8');
  const hasHost = rootSource.includes('<PowerAppsProvider') || (
    fs.existsSync(inside(root, 'src/data/ConnectedProvider.tsx'))
    && wireConnectedRoot(root, rootSource) === rootSource
    && fs.readFileSync(inside(root, 'src/data/ConnectedProvider.tsx'), 'utf8')
      === connectedProviderSource(root, readJson(root, '.tmp/prototype-connected-template.json').files['app/_layout.tsx'])
  );
  if (!guid.test(auth?.clientId || '') || !guid.test(auth?.tenantId || '')
    || !hasHost) {
    throw new Error('Real auth/provider setup must be completed; a prototype is not a sign-in fallback');
  }
  const manifest = readJson(root, '.tmp/prototype-generated.json');
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!file.startsWith('src/data/') || sha256Hex(fs.readFileSync(inside(root, file))) !== hash) {
      throw new Error('Compiler-owned data outputs changed before activation');
    }
  }
  const profile = readJson(root, '.tmp/prototype-profile.json');
  if (profile.profile === 'connected' && journal.stagedProfile === 'connected') {
    return { ok: true, alreadyStaged: true, beforeRevision: before.revision, afterRevision: before.revision, published: false };
  }
  const backup = Object.fromEntries(FILES.map((file) => [file, fs.readFileSync(inside(root, file), 'utf8')]));
  const backupFile = `.tmp/prototype-activation-backups/${before.revision}.json`;
  atomicWrite(root, backupFile, { schemaVersion: 1, beforeRevision: before.revision, files: backup });
  try {
    const inputRevisions = { ...manifest.inputRevisions, activeProfile: 'connected' };
    delete inputRevisions.testWritePermission;
    writeOwnedFiles(root, {
      'src/data/runtime.ts': connectedRuntimeSource({ previewKind: 'active', dataNamespace: 'active' }),
      'src/data/test-write-permission.json': 'null\n',
    }, inputRevisions);
    validateProject(root);
    atomicWrite(root, '.tmp/prototype-profile.json', { ...profile, profile: 'connected', dataNamespace: 'active' });
    atomicWrite(root, '.tmp/prototype-conversion-journal.json', {
      ...journal, stagedProfile: 'connected', state: 'activation-staged',
      // A journal included in source capture cannot contain its own final hash.
      activation: { beforeRevision: before.revision, backupFile },
    });
    const after = capture(root);
    if (capture(root).revision !== after.revision) throw new Error('Source changed while finalizing connected activation');
    return { ok: true, beforeRevision: before.revision, afterRevision: after.revision, files: FILES, backupFile, published: false };
  } catch (error) {
    for (const [file, bytes] of Object.entries(backup)) atomicWrite(root, file, bytes);
    throw error;
  }
}

module.exports = { activateConnectedData };
