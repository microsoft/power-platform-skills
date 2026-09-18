'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../native-capabilities.json');
const { canonicalJson } = require('./product-experience-contracts');
const { assertRevision } = require('./prototype-files');

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function versionAtLeast(actual, minimum) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(actual || '');
  if (!parts) return false;
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const value = Number(parts[index + 1]);
    if (value !== required[index]) return value > required[index];
  }
  return true;
}

function createNativeCatalog(packageJson, { appPackageJson = packageJson, installedVersions = {}, usedCapabilities = [], prototype = false } = {}) {
  object(packageJson, 'package.json');
  if (typeof prototype !== 'boolean') throw new Error('Prototype catalogue mode must be a boolean');
  const dependencies = object(packageJson.dependencies || {}, 'dependencies');
  const appDependencies = object(appPackageJson.dependencies || {}, 'app dependencies');
  const used = new Set(usedCapabilities);
  const dependencyEvidence = {};
  const items = policy.capabilities.filter((entry) => dependencies[entry.package] !== undefined).map((entry) => {
    const declaredVersion = dependencies[entry.package];
    if (declaredVersion !== undefined && (typeof declaredVersion !== 'string' || declaredVersion.length > 200)) {
      throw new Error(`Invalid package declaration for ${entry.package}`);
    }
    const installedVersion = installedVersions[entry.package];
    if (installedVersion !== undefined && (typeof installedVersion !== 'string' || installedVersion.length > 200)) {
      throw new Error(`Invalid installed version for ${entry.package}`);
    }
    dependencyEvidence[entry.package] = { declared: declaredVersion || null, installed: installedVersion || null };
    const requiredPackages = [entry.package, ...(!prototype ? entry.legacyPackages || [] : [])];
    const missingPackage = requiredPackages.find((name) => !dependencies[name] || !appDependencies[name]);
    const wrapper = prototype && entry.prototypeWrapper ? entry.prototypeWrapper : entry.wrapper;
    let availability = 'available';
    let reason = null;
    if (entry.blocked) {
      availability = 'blocked';
      reason = 'This capability is excluded by the native runtime policy.';
    } else if (missingPackage) {
      availability = 'not-shipped';
      reason = `This workflow requires the template's ${missingPackage} dependency in the app. It will not be installed automatically.`;
    } else if (entry.minimumVersion && !versionAtLeast(installedVersion, entry.minimumVersion)) {
      availability = 'requires-version-check';
      reason = `This workflow requires an installed package version of at least ${entry.minimumVersion}.`;
    }
    return {
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      package: entry.package,
      declaredVersion: declaredVersion || null,
      installedVersion: installedVersion || null,
      availability,
      reason,
      alreadyUsed: used.has(entry.id),
      ...(wrapper ? { wrapper } : {}),
    };
  });
  return {
    schemaVersion: 1,
    kind: 'native',
    catalogRevision: digest({ policy, dependencies: dependencyEvidence, appDependencies, used: [...used].sort(), prototype }),
    items,
  };
}

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Catalogue inputs must be regular JSON files');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readNativeCatalog(projectRoot, options = {}) {
  const root = fs.realpathSync(projectRoot);
  const appPackageJson = readJson(path.join(root, 'package.json'));
  const packageJson = options.templatePackageJson || readJson(path.resolve(__dirname, '../../template/package.json'));
  let prototype = false;
  try {
    const profile = readJson(path.join(root, '.tmp/prototype-profile.json'));
    if (profile.schemaVersion !== 1 || !['prototype', 'connector', 'connected-candidate', 'connected'].includes(profile.profile)) {
      throw new Error('Native catalogue requires a valid prototype profile when one is present');
    }
    prototype = ['prototype', 'connector'].includes(profile.profile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const captureCapabilities = new Set();
  if (prototype) {
    try {
      const registry = readJson(path.join(root, '.tmp/data-access-registry.json'));
      if (registry.schemaVersion !== 1 || registry.contractType !== 'data-access-registry') {
        throw new Error('Native catalogue requires a valid data-access registry when one is present');
      }
      assertRevision(registry, 'registryRevision', 'Data-access registry');
      const sources = registry.media?.captureSources || [];
      if (!Array.isArray(sources) || sources.some((source) => !['camera', 'library'].includes(source))
        || new Set(sources).size !== sources.length) {
        throw new Error('Native catalogue requires valid generated photo capture sources');
      }
      if (sources.includes('camera')) captureCapabilities.add('camera');
      if (sources.includes('library')) captureCapabilities.add('image-picker');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const installedVersions = { ...options.installedVersions };
  const usedCapabilities = [];
  for (const entry of policy.capabilities) {
    if (!packageJson.dependencies?.[entry.package]) continue;
    const installedPackage = path.join(root, 'node_modules', entry.package, 'package.json');
    try {
      installedVersions[entry.package] = readJson(installedPackage).version;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const wrapperPath = prototype && entry.prototypeWrapper ? entry.prototypeWrapper : entry.wrapper;
    if (wrapperPath) {
      const wrapper = path.join(root, wrapperPath);
      try {
        const stat = fs.lstatSync(wrapper);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Native wrappers must be regular files');
        // capture.ts exists even when no capture source has been enabled.
        if (!prototype || !entry.prototypeWrapper || captureCapabilities.has(entry.id)) usedCapabilities.push(entry.id);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return createNativeCatalog(packageJson, { ...options, appPackageJson, installedVersions, usedCapabilities, prototype });
}

function validateNativeSelection(catalog, selection) {
  if (selection.kind !== 'native' || selection.catalogRevision !== catalog.catalogRevision) {
    throw new Error('The native catalogue changed. Refresh it before selecting a control.');
  }
  const selected = catalog.items.find((entry) => entry.id === selection.capabilityId);
  if (!selected || selected.availability !== 'available') {
    throw new Error(selected?.reason || 'The selected native control is not available.');
  }
  return selected;
}

module.exports = { createNativeCatalog, readNativeCatalog, validateNativeSelection };
