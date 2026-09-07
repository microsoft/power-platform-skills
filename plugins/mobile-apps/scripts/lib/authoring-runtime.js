'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const protocol = require('./authoring-protocol');
const { fileToRoute } = require('../validate-navigation-layout');
const { canonicalJson, digest, plainDirectory, relativePath, inside, readFile, readJson, exists, atomicWrite } = require('./mobile-authoring-files');

const REGISTRY_PATH = '.tmp/authoring-registry.json';
const COMPILED_PATH = '.tmp/compiled-screen-build-pack.json';
const MANIFEST_PATH = '.tmp/mobile-authoring-runtime.json';
const STAMP_PATH = '.devplayer-builder/runtime.json';
const TEMPLATE_ROOT = path.join(__dirname, '../templates/mobile-authoring');
const OWNER = 'mobile-authoring-runtime';
const OWNED_PATHS = ['src/authoring/index.tsx', 'src/authoring/controller.ts', 'src/authoring/registry.ts', 'src/authoring/README.md'];

function exact(value, keys, label) {
  protocol.object(value, label);
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

function validateAuthoringRegistry(projectRoot, value) {
  const root = plainDirectory(projectRoot);
  exact(value, ['schemaVersion', 'appInstanceId', 'screens'], 'authoring registry');
  if (value.schemaVersion !== 1 || !Array.isArray(value.screens) || value.screens.length > 100) {
    throw new Error('Authoring registry requires schemaVersion 1 and at most 100 screens');
  }
  const appInstanceId = protocol.id(value.appInstanceId, 'registry.appInstanceId');
  const app = readJson(root, 'app.json');
  const existingIdentity = app?.expo?.extra?.telemetry?.appInstanceId;
  if (typeof existingIdentity !== 'string' || existingIdentity.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existingIdentity)
    || existingIdentity !== appInstanceId) {
    throw new Error('Authoring registry must use the existing app.json telemetry app identity');
  }
  const compiled = readJson(root, COMPILED_PATH);
  if (compiled.contractType !== 'compiled-screen-build-pack' || !Array.isArray(compiled.screens)) {
    throw new Error('Authoring registry requires the canonical compiled screen contract');
  }
  const screenIds = new Set();
  const routes = new Set();
  const files = new Set();
  const screens = value.screens.map((screen) => {
    exact(screen, ['screenId', 'route', 'sourceFile', 'targets'], 'registered screen');
    const screenId = protocol.id(screen.screenId, 'registry.screenId');
    const route = protocol.text(screen.route, 'registry.route', 500);
    relativePath(screen.sourceFile);
    const sourceFile = screen.sourceFile;
    if (!route.startsWith('/') || /[?#\\\u0000-\u001f\u007f]/.test(route)
      || !sourceFile.startsWith('app/') || !sourceFile.endsWith('.tsx')
      || fileToRoute(path.join(root, sourceFile), path.join(root, 'app')) !== route
      || /(?:^|\/)(?:_layout|\+[^/]*)\.tsx$/.test(sourceFile)) {
      throw new Error('Registered sourceFile must be a normalized app screen TSX matching its canonical route');
    }
    readFile(inside(root, sourceFile), 4 * 1024 * 1024);
    if (compiled.screens.filter((entry) => entry.screenId === screenId && entry.route === route).length !== 1) {
      throw new Error('Registered screen does not match exactly one compiled screen route');
    }
    if (screenIds.has(screenId) || routes.has(route) || files.has(sourceFile)) {
      throw new Error('Registered screen IDs, routes, and source files must be unique');
    }
    screenIds.add(screenId); routes.add(route); files.add(sourceFile);
    if (!Array.isArray(screen.targets) || screen.targets.length > 200) throw new Error('Register at most 200 explicit targets per screen');
    const targetIds = new Set();
    const targets = screen.targets.map((target) => {
      exact(target, ['id', 'label', 'role', 'actionId'], 'registered target');
      const id = protocol.id(target.id, 'registry.target.id');
      if (targetIds.has(id)) throw new Error('Registered target IDs must be unique within their screen');
      targetIds.add(id);
      return {
        id, label: protocol.text(target.label, 'registry.target.label', 200),
        role: protocol.enumeration(target.role, protocol.TARGET_ROLES, 'registry.target.role'),
        ...(target.actionId === undefined ? {} : { actionId: protocol.id(target.actionId, 'registry.target.actionId') }),
      };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { screenId, route, sourceFile, targets };
  }).sort((a, b) => a.screenId < b.screenId ? -1 : a.screenId > b.screenId ? 1 : 0);
  return { schemaVersion: 1, appInstanceId, screens };
}

function installedPublicDependencies(root) {
  const pkg = readJson(root, 'package.json');
  const requireFromApp = createRequire(path.join(root, 'package.json'));
  for (const name of ['expo', 'expo-router', 'react', 'react-native']) {
    if (typeof pkg.dependencies?.[name] !== 'string') throw new Error(`Authoring runtime requires the already-installed ${name} dependency`);
    try { requireFromApp.resolve(`${name}/package.json`); }
    catch { throw new Error(`Authoring runtime requires installed ${name}; no dependencies were changed`); }
  }
  const expoFile = requireFromApp.resolve('expo/package.json');
  const expo = JSON.parse(fs.readFileSync(expoFile, 'utf8'));
  const entry = path.resolve(path.dirname(expoFile), expo.main || 'src/Expo.ts');
  if (!fs.existsSync(entry) || !/\brequireOptionalNativeModule\b/.test(fs.readFileSync(entry, 'utf8'))) {
    throw new Error('Installed Expo does not expose the required optional native-module public export');
  }
}

function renderAuthoringRuntime(registry) {
  // sourceFile is local compiler authority. Device code receives only explicit semantic IDs/routes.
  const projection = {
    schemaVersion: 1, appInstanceId: registry.appInstanceId,
    screens: registry.screens.map(({ screenId, route, targets }) => ({ screenId, route, targets })),
  };
  return {
    'src/authoring/index.tsx': fs.readFileSync(path.join(TEMPLATE_ROOT, 'index.tsx'), 'utf8'),
    'src/authoring/controller.ts': fs.readFileSync(path.join(TEMPLATE_ROOT, 'controller.ts'), 'utf8'),
    'src/authoring/registry.ts': `export const registry = ${JSON.stringify(projection, null, 2)} as const;\n`,
    'src/authoring/README.md': fs.readFileSync(path.join(TEMPLATE_ROOT, 'README.md'), 'utf8'),
  };
}

function validateExistingStamp(root, appInstanceId) {
  if (!exists(root, STAMP_PATH)) return;
  const stamp = readJson(root, STAMP_PATH);
  if (stamp?.protocolVersion === 2 && stamp.active === false
    && Object.keys(stamp).every((key) => ['protocolVersion', 'active'].includes(key))) return;
  exact(stamp, ['protocolVersion', 'appInstanceId', 'jobId', 'previewRevision', 'previewKind', 'dataNamespace', 'baseDataNamespace'], 'publisher stamp');
  if (stamp.protocolVersion !== 2 || stamp.appInstanceId !== appInstanceId
    || !['active', 'candidate'].includes(stamp.previewKind)) throw new Error('Existing publisher stamp belongs to another app or is invalid');
  protocol.id(stamp.jobId, 'stamp.jobId');
  protocol.revision(stamp.previewRevision, 'stamp.previewRevision');
  if (stamp.previewRevision.length !== 64) throw new Error('Existing publisher stamp has an invalid source revision');
  for (const key of ['dataNamespace', 'baseDataNamespace']) {
    if (key === 'baseDataNamespace' && stamp[key] === undefined) continue;
    if (typeof stamp[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(stamp[key]) || /[\r\n]/.test(stamp[key])) {
      throw new Error('Existing publisher stamp has an invalid data namespace');
    }
  }
  if (stamp.previewKind === 'candidate' && (stamp.dataNamespace === 'active' || stamp.dataNamespace === (stamp.baseDataNamespace ?? 'active'))) {
    throw new Error('Existing candidate stamp does not isolate its data namespace');
  }
}

/** Generates app-owned helpers only. The caller owns wrapping the existing root, never a duplicate provider. */
function configureMobileAuthoring(projectRoot, { check = false } = {}) {
  const root = plainDirectory(projectRoot);
  const registry = validateAuthoringRegistry(root, readJson(root, REGISTRY_PATH));
  installedPublicDependencies(root);
  validateExistingStamp(root, registry.appInstanceId);
  const files = renderAuthoringRuntime(registry);
  const prior = exists(root, MANIFEST_PATH) ? readJson(root, MANIFEST_PATH) : null;
  if (prior) {
    exact(prior, ['schemaVersion', 'owner', 'appInstanceId', 'registryRevision', 'files'], 'authoring runtime ownership manifest');
    protocol.object(prior.files, 'authoring runtime owned files');
    if (prior.schemaVersion !== 1 || prior.owner !== OWNER || prior.appInstanceId !== registry.appInstanceId
      || typeof prior.registryRevision !== 'string' || !/^[a-f0-9]{64}$/.test(prior.registryRevision)
      || Object.entries(prior.files).some(([file, hash]) => !OWNED_PATHS.includes(file)
        || typeof hash !== 'string' || hash.length !== 64 || !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error('Authoring runtime ownership manifest is invalid');
    }
  }
  const changes = [];
  // Inspect every destination before writing any file; manual edits never become an overwrite licence.
  for (const [file, content] of Object.entries(files)) {
    if (exists(root, file)) {
      const current = digest(readFile(inside(root, file), 2 * 1024 * 1024));
      if (!prior || prior.files[file] !== current) throw new Error(`Authoring runtime refuses an unowned or manually edited file: ${file}`);
      if (current !== digest(content)) changes.push(file);
    } else changes.push(file);
  }
  const manifest = {
    schemaVersion: 1, owner: OWNER, appInstanceId: registry.appInstanceId,
    registryRevision: digest(canonicalJson(registry)),
    files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, digest(content)])),
  };
  const manifestChanged = !prior || canonicalJson(prior) !== canonicalJson(manifest);
  const missingStamp = !exists(root, STAMP_PATH);
  if (check) {
    if (changes.length || manifestChanged || missingStamp) throw new Error('Authoring runtime generated files are missing or stale; run configure-mobile-authoring');
  } else {
    for (const file of changes) atomicWrite(root, file, files[file], { bytes: true });
    if (manifestChanged) atomicWrite(root, MANIFEST_PATH, manifest);
    // The generator never fabricates an active stamp or overwrites publisher-owned source identity.
    if (missingStamp) atomicWrite(root, STAMP_PATH, { protocolVersion: 2, active: false }, { exclusive: true });
  }
  return {
    ok: true, status: check ? 'verified' : 'configured', appInstanceId: registry.appInstanceId,
    changed: changes, files: OWNED_PATHS, manifest: MANIFEST_PATH,
    rootWiring: { owner: 'app-generator', component: 'AuthoringProvider', configureProp: 'configureDataPreview', outside: 'PrototypeProvider' },
    publicationReady: false,
  };
}

module.exports = {
  REGISTRY_PATH, COMPILED_PATH, MANIFEST_PATH, STAMP_PATH,
  validateAuthoringRegistry, renderAuthoringRuntime, configureMobileAuthoring,
};
