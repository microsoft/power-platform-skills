#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const DEFAULT_ENTRY_POINTS = [
  '@microsoft/power-apps-native-host/config/metroConfig',
  '@microsoft/power-apps-native-host/config/babelConfig',
  '@microsoft/power-apps-native-host/config/expoConfig',
  '@microsoft/power-apps-native-host/config/tamaguiConfig',
  '@microsoft/power-apps-native-host/config/tsconfig',
];
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readJson(root, relative) {
  const file = path.join(root, relative);
  let content;
  try {
    // Do not read credentials or manifests reached through links outside this app.
    if (!inside(root, fs.realpathSync(file))) return { status: 'outside-project' };
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', code: error.code || 'UNKNOWN' };
  }
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'malformed' };
    }
    return { status: 'read', value };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { status: 'malformed' };
  }
}

function engine(value) {
  return typeof value?.engines?.node === 'string' ? value.engines.node : null;
}

function dependencyDeclarations(manifest) {
  const result = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    const declarations = manifest[section];
    if (declarations === undefined) continue;
    if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) {
      throw new Error(`Invalid ${section} in package.json`);
    }
    for (const [name, spec] of Object.entries(declarations)) {
      if (!PACKAGE_NAME.test(name) || typeof spec !== 'string' || !spec.trim()) {
        throw new Error(`Invalid dependency declaration in ${section}`);
      }
      const entry = result.get(name) || { name, sections: [] };
      entry.sections.push(section);
      result.set(name, entry);
    }
  }
  return [...result.values()];
}

function compareLock(manifest, dependencies, lock) {
  if (lock.status !== 'read') return { status: lock.status, code: lock.code };
  const data = lock.value;
  if (![2, 3].includes(data.lockfileVersion) || !data.packages?.['']) {
    return { status: 'unsupported', lockfileVersion: data.lockfileVersion ?? null };
  }
  if (typeof data.packages !== 'object' || Array.isArray(data.packages)
      || typeof data.packages[''] !== 'object' || Array.isArray(data.packages[''])) {
    return { status: 'malformed', lockfileVersion: data.lockfileVersion };
  }
  if (manifest.workspaces || data.packages[''].workspaces) {
    return { status: 'workspace-review-required', lockfileVersion: data.lockfileVersion };
  }
  const mismatches = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const lockedSection = data.packages[''][section] || {};
    if (typeof lockedSection !== 'object' || Array.isArray(lockedSection)) {
      return { status: 'malformed', lockfileVersion: data.lockfileVersion };
    }
    const declared = { ...(manifest[section] || {}) };
    const locked = { ...lockedSection };
    if (section === 'dependencies') {
      // npm lets optionalDependencies override dependencies and omits the shadowed
      // declaration from root lock metadata. Compare effective intent, not that omission.
      for (const name of Object.keys(manifest.optionalDependencies || {})) delete declared[name];
      for (const name of Object.keys(data.packages[''].optionalDependencies || {})) delete locked[name];
    }
    for (const name of new Set([...Object.keys(declared), ...Object.keys(locked)])) {
      if (declared[name] !== locked[name]) mismatches.push({ section, name });
    }
  }
  for (const dependency of dependencies) {
    const key = `node_modules/${dependency.name}`;
    // Platform-specific optional packages may be omitted from lock metadata.
    // Only absence is exempt: present null/malformed/link entries remain findings.
    if (!Object.hasOwn(data.packages, key) && dependency.sections.includes('optionalDependencies')) continue;
    const entry = data.packages[key];
    if (!entry || typeof entry.version !== 'string' || entry.link) {
      mismatches.push({ section: 'packages', name: dependency.name });
    }
  }
  const nonRegistry = dependencies.filter(({ name, sections }) => sections.some((section) => {
    if (section === 'dependencies' && Object.hasOwn(manifest.optionalDependencies || {}, name)) return false;
    return /^(?:file:|link:|workspace:|git|https?:|github:|npm:)|^[^@\s]+\/[^/\s]+$/.test(manifest[section][name]);
  })).map(({ name }) => name);
  return {
    // This is intentionally not "valid lockfile": npm must validate the full graph.
    status: mismatches.length ? 'inconsistent' : 'direct-declarations-match',
    lockfileVersion: data.lockfileVersion,
    mismatches,
    validationScope: 'direct-declarations-only',
    nonRegistry,
  };
}

function validEntryPoint(specifier) {
  if (typeof specifier !== 'string' || specifier.includes('\\') || specifier.includes(':')) return false;
  const parts = specifier.split('/');
  const packageParts = specifier.startsWith('@') ? 2 : 1;
  return PACKAGE_NAME.test(parts.slice(0, packageParts).join('/'))
    && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function inspectStartup(projectRoot, entryPoints = DEFAULT_ENTRY_POINTS) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  if (!fs.statSync(root).isDirectory()) throw new Error('Working directory is not a directory');
  if (!Array.isArray(entryPoints) || !entryPoints.every(validEntryPoint)) {
    throw new Error('Entry points must be package specifiers, not paths or URLs');
  }
  const document = readJson(root, 'package.json');
  if (document.status !== 'read') {
    return { status: 'blocked', manifest: document.status, code: document.code };
  }
  const manifest = document.value;
  const dependencies = dependencyDeclarations(manifest);
  const shrinkwrap = readJson(root, 'npm-shrinkwrap.json');
  const lockName = shrinkwrap.status !== 'missing' ? 'npm-shrinkwrap.json' : 'package-lock.json';
  const lock = lockName === 'npm-shrinkwrap.json' ? shrinkwrap : readJson(root, lockName);
  const lockfile = { file: lockName, ...compareLock(manifest, dependencies, lock) };
  const projectRequire = createRequire(path.join(root, 'package.json'));
  const nodeModules = path.join(root, 'node_modules');
  const packages = dependencies.map(({ name, sections }) => {
    const installed = readJson(root, `node_modules/${name}/package.json`);
    const locked = lock.status === 'read' ? lock.value.packages?.[`node_modules/${name}`] : null;
    const version = typeof installed.value?.version === 'string' ? installed.value.version : null;
    const lockedVersion = typeof locked?.version === 'string' ? locked.version : null;
    return {
      name,
      sections,
      installedStatus: installed.status,
      installedVersion: version,
      lockedVersion,
      nodeRequirement: engine(installed.value) || engine(locked),
      matchesLock: version && lockedVersion ? version === lockedVersion : null,
      optional: sections.includes('optionalDependencies'),
    };
  });
  const entries = [...new Set(entryPoints)].map((specifier) => {
    try {
      // Resolve only: requiring the resolved file would execute customer/package code.
      const resolved = fs.realpathSync(projectRequire.resolve(specifier));
      return {
        specifier,
        status: inside(nodeModules, resolved) ? 'resolved' : 'outside-project-install',
      };
    } catch (error) {
      return { specifier, status: 'unresolved', code: error.code || 'UNKNOWN' };
    }
  });
  const otherLocks = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']
    .filter((file) => fs.existsSync(path.join(root, file)));
  const packageManager = typeof manifest.packageManager === 'string'
    ? manifest.packageManager.split('@')[0]
    : 'unspecified';
  return {
    status: 'inspected',
    node: { current: process.version, projectRequirement: engine(manifest) },
    packageManager: ['npm', 'yarn', 'pnpm', 'bun', 'unspecified'].includes(packageManager)
      ? packageManager : 'unknown',
    lockfile,
    otherLocks,
    packages,
    entryPoints: entries,
    configFiles: ['metro.config.js', 'babel.config.js', 'app.config.js', 'power.config.json']
      .filter((file) => fs.existsSync(path.join(root, file))),
    // Never emit registry URLs, lockfile resolved/integrity values, scripts, or config contents.
    repairAuthorized: false,
  };
}

function main(argv = process.argv.slice(2)) {
  let projectRoot;
  const entries = [];
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      if (!['--working-dir', '--entry-point'].includes(flag) || !argv[index + 1]
          || argv[index + 1].startsWith('--')) throw new Error('Invalid inspection arguments');
      if (flag === '--working-dir') {
        if (projectRoot) throw new Error('Duplicate --working-dir');
        projectRoot = argv[++index];
      } else entries.push(argv[++index]);
    }
    if (!projectRoot) throw new Error('--working-dir is required');
    const result = inspectStartup(projectRoot, entries.length ? entries : DEFAULT_ENTRY_POINTS);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'blocked' ? 2 : 0;
  } catch (error) {
    // Filesystem/JSON errors can contain absolute paths or source text; keep CLI failures bounded.
    process.stderr.write(`Startup inspection failed (${error.code || 'INVALID_INPUT'}); check the selected root and arguments.\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { DEFAULT_ENTRY_POINTS, inspectStartup, main };
