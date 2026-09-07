#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { prepareMobileTemplate } = require('./prepare-mobile-template');
const { inside, readJson, atomicWrite, revision } = require('./lib/prototype-files');
const { generatePrototype } = require('./lib/prototype-generator');
const { localStartup, verifyPrototypeStartup } = require('./lib/prototype-startup');

const BACKUP = '.tmp/prototype-connected-template.json';
const CONNECTED_PATHS = ['app/_layout.tsx', 'app/index.tsx', 'app/(app)/_layout.tsx', 'app/login.tsx', 'app/oauth-callback.tsx'];
const CONFIG_EXPORTS = ['expoConfig', 'babelConfig', 'metroConfig', 'tamaguiConfig', 'tsconfig'];

function checkPrototypeTemplate(root, {
  resolve = createRequire(path.join(path.resolve(root), 'package.json')).resolve,
  loadConfig = (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
} = {}) {
  const selected = readJson(root, 'package.json');
  const canonical = JSON.parse(fs.readFileSync(path.join(__dirname, '../template/package.json'), 'utf8'));
  for (const dependency of ['expo', 'react', 'react-native', '@microsoft/power-apps-native-host', '@react-native-async-storage/async-storage', 'expo-file-system', 'expo-crypto', '@tanstack/react-query']) {
    if (selected.dependencies?.[dependency] !== canonical.dependencies[dependency]) {
      throw new Error(`Template compatibility mismatch for ${dependency}; select the supported template, do not rewrite dependency versions`);
    }
  }
  const resolved = CONFIG_EXPORTS.map((name) => resolve(`@microsoft/power-apps-native-host/config/${name}`));
  const compiler = loadConfig(resolved[CONFIG_EXPORTS.indexOf('tsconfig')]).compilerOptions;
  if (!compiler?.paths || compiler.baseUrl !== '${configDir}') {
    throw new Error('Unsupported host TypeScript path configuration; do not replace its config factories');
  }
  for (const dependency of ['expo', '@react-native-async-storage/async-storage', 'expo-file-system/legacy', 'expo-crypto', '@tanstack/react-query']) resolve(dependency);
  if (fs.existsSync(inside(root, 'power.config.json')) && readJson(root, 'power.config.json').environmentId) {
    throw new Error('An environment-bound app cannot be silently converted to a local prototype');
  }
  return { ok: true, profile: 'prototype', templateRevision: revision(canonical), configExports: CONFIG_EXPORTS, resolvedCount: resolved.length, compilerPaths: compiler.paths };
}

function preparePrototype(root, options) {
  checkPrototypeTemplate(root, options);
  if (fs.existsSync(inside(root, BACKUP))) {
    const backup = readJson(root, BACKUP);
    if (!fs.existsSync(inside(root, '.tmp/prototype-profile.json'))) completeStartup(root, backup, options);
    verifyPrototypeStartup(root);
    return { ...generatePrototype(root, { check: true }), resumed: true };
  }
  if (!options.entryRoute || !/^\/[A-Za-z0-9_/()\-]+$/.test(options.entryRoute)) throw new Error('A static approved --entry-route is required');
  const navigation = readJson(root, '.tmp/navigation-manifest.json');
  if (!Object.values(navigation.screens).some((screen) => screen.targetPath === options.entryRoute)) {
    throw new Error('Entry route must belong to the canonical navigation manifest');
  }
  const connected = Object.fromEntries(CONNECTED_PATHS.map((relative) => [relative, fs.readFileSync(inside(root, relative), 'utf8')]));
  if (!connected['app/_layout.tsx'].includes('<PowerAppsProvider')
    || !connected['app/login.tsx'].includes('useAuth')
    || !connected['app/(app)/_layout.tsx'].includes('useAuth')) {
    throw new Error('Unsupported template auth/layout shape; refusing to overwrite custom startup');
  }
  prepareMobileTemplate({ workingDir: root, displayName: options.displayName, slug: options.slug });
  connected['app/_layout.tsx'] = fs.readFileSync(inside(root, 'app/_layout.tsx'), 'utf8');
  const generated = generatePrototype(root);
  // Inactive connected code is stored as JSON text, not as an importable .tsx
  // route. Conditional imports cannot hide missing live modules from Metro.
  const backup = { schemaVersion: 1, files: connected, entryRoute: options.entryRoute };
  atomicWrite(root, BACKUP, backup);
  completeStartup(root, backup, options);
  return generated;
}

function completeStartup(root, backup, options) {
  if (!backup.entryRoute) throw new Error('Incomplete prototype startup has no saved entry route');
  const next = localStartup(backup.entryRoute);
  for (const relative of CONNECTED_PATHS) {
    const file = inside(root, relative);
    if (!fs.existsSync(file)) continue;
    const current = fs.readFileSync(file, 'utf8');
    if (current !== backup.files[relative] && current !== next[relative]) {
      throw new Error(`Interrupted startup conflicts with an unrelated edit: ${relative}`);
    }
  }
  for (const [relative, content] of Object.entries(next)) atomicWrite(root, relative, content);
  fs.rmSync(inside(root, 'app/login.tsx'), { force: true });
  fs.rmSync(inside(root, 'app/oauth-callback.tsx'), { force: true });
  const packageJson = readJson(root, 'package.json');
  packageJson.scripts['dev:prototype'] = 'expo start';
  atomicWrite(root, 'package.json', packageJson);
  const compatibility = checkPrototypeTemplate(root, options);
  const tsconfig = readJson(root, 'tsconfig.json');
  tsconfig.compilerOptions ||= {};
  if (tsconfig.compilerOptions.baseUrl && !['${configDir}', '.'].includes(tsconfig.compilerOptions.baseUrl)) {
    throw new Error('Custom TypeScript baseUrl needs a reviewed data-alias integration');
  }
  const aliases = { '@/data': ['src/data'], '@/data/*': ['src/data/*'] };
  for (const [name, expected] of Object.entries(aliases)) {
    const current = tsconfig.compilerOptions.paths?.[name];
    if (current && JSON.stringify(current) !== JSON.stringify(expected)) throw new Error(`Existing ${name} alias conflicts with the prototype`);
  }
  tsconfig.compilerOptions.paths = { ...compatibility.compilerPaths, ...tsconfig.compilerOptions.paths, ...aliases };
  atomicWrite(root, 'tsconfig.json', tsconfig);
  atomicWrite(root, '.tmp/prototype-profile.json', {
    schemaVersion: 1, profile: 'prototype', entryRoute: backup.entryRoute,
    appInstanceId: readJson(root, '.tmp/prototype-domain.json').appInstanceId,
    templateRevision: compatibility.templateRevision,
  });
  verifyPrototypeStartup(root);
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = {};
    let root;
    let check = false;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--check-template') check = true;
      else if (argv[index] === '--display-name') options.displayName = argv[++index];
      else if (argv[index] === '--slug') options.slug = argv[++index];
      else if (argv[index] === '--entry-route') options.entryRoute = argv[++index];
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    const result = check ? checkPrototypeTemplate(path.resolve(root)) : preparePrototype(path.resolve(root), options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`prepare-prototype: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { checkPrototypeTemplate, preparePrototype, BACKUP, CONNECTED_PATHS, main };
