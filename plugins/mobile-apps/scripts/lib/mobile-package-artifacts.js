'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const semver = require('../vendor/semver.cjs');

const HOST = '@microsoft/power-apps-native-host';
const OFFLINE = '@microsoft/power-apps-native-offline';
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

function requireValue(condition, message) {
  if (condition) return;
  const error = new Error(message);
  error.code = 'MOBILE_RELEASE_BLOCKED';
  throw error;
}

function unpack(archive, destination, run) {
  // Keep archive inspection and extraction in one cwd for Windows drive safety.
  const archiveName = 'artifact.tgz';
  const stagedArchive = path.join(destination, archiveName);
  fs.copyFileSync(archive, stagedArchive, fs.constants.COPYFILE_EXCL);
  try {
    const names = run('tar', ['-tzf', archiveName], destination).trim().split(/\r?\n/);
    const types = run('tar', ['-tvzf', archiveName], destination).trim().split(/\r?\n/);
    requireValue(names.length > 0 && names.length === types.length
      && types.every((line) => /^[-d]/.test(line))
      && new Set(names).size === names.length
      && names.every((name) => /^package(?:\/|$)/.test(name)
        && !/[\\:\u0000-\u001f]/.test(name) && name.split('/').every((part) => part !== '..' && part !== '.')),
    'Packed artifacts must contain only regular package files and directories; links and unsafe archive paths are rejected.');
    run('tar', ['-xzf', archiveName], destination);
    return path.join(destination, 'package');
  } finally {
    fs.unlinkSync(stagedArchive);
  }
}

function packageFile(root, relative, directory = false) {
  requireValue(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative)
    && !/[\\:\u0000-\u001f]/.test(relative)
    && relative.split('/').every((part) => part && part !== '.' && part !== '..'),
  'Package artifacts must use contained relative paths.');
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    requireValue(stat && !stat.isSymbolicLink(), 'Package artifacts must exist and must not traverse symbolic links.');
  }
  const stat = fs.lstatSync(file);
  requireValue(directory ? stat.isDirectory() : stat.isFile(), 'Package artifacts must be regular files or directories.');
  return file;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    requireValue(false, 'Cannot read the offline SDK metadata; restore the verified package.');
  }
}

function hashFile(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest(encoding);
  } finally {
    fs.closeSync(fd);
  }
}

function verifyOfflineArtifacts(root, contract) {
  requireValue(contract?.artifacts && typeof contract.artifacts === 'object'
    && !Array.isArray(contract.artifacts) && Object.keys(contract.artifacts).length > 0,
  'Offline compatibility metadata is missing native artifact hashes.');
  for (const [file, hash] of Object.entries(contract.artifacts)) {
    requireValue(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)
      && hashFile(packageFile(root, file)) === hash,
    'Offline native artifact hash differs from the selected SDK contract.');
  }
}

function readOfflineContract(root) {
  const contract = readJson(packageFile(root, 'compatibility.json'));
  verifyOfflineArtifacts(root, contract);
  return contract;
}

function verifyInstalledOfflineSdk(projectRoot, profile, host, lock, referenceLock, readPackage) {
  // Historical hosts have no versioned offline contract; preserve their existing admission rules.
  if (profile.offlineContractVersion === undefined) return;
  const version = profile.managedDependencies?.[OFFLINE];
  const entry = `node_modules/${OFFLINE}`;
  const locked = lock.packages?.[entry];
  const expected = referenceLock.packages?.[entry];
  if (version === undefined && !locked) return;
  requireValue(semver.valid(version) && !semver.prerelease(version) && locked?.version === version
    && !locked.link && expected?.version === version && !expected.link
    && SRI.test(locked.integrity || '') && expected.integrity === locked.integrity,
  'Offline SDK version and integrity must match the selected published template lock.');
  requireValue(typeof readPackage === 'function', 'Offline admission requires an integrity-verified published SDK archive.');
  const reference = readPackage(OFFLINE, version);
  requireValue(reference?.publication?.package === OFFLINE && reference.publication.version === version
    && reference.publication.integrity === expected.integrity
    && reference.pkg?.name === OFFLINE && reference.pkg.version === version,
  'Published offline SDK archive does not match the immutable template lock integrity.');
  const root = packageFile(projectRoot, entry, true);
  const installed = readJson(packageFile(root, 'package.json'));
  const contract = reference.contract;
  const pkg = reference.pkg;
  requireValue(installed.name === pkg.name && installed.version === pkg.version
    && isDeepStrictEqual(installed.peerDependencies, pkg.peerDependencies)
    && isDeepStrictEqual(readJson(packageFile(root, 'compatibility.json')), contract),
  'Installed offline SDK metadata differs from its integrity-verified published archive.');
  requireValue(pkg.name === OFFLINE && pkg.version === version
    && contract?.schemaVersion === 2 && contract.complete === true && contract.sourceDirty === false
    && contract.packageVersion === version && contract.reactNativeVersion === profile.managedDependencies['react-native']
    && Number(contract.expoSdkVersion) === profile.expoSdk
    && typeof contract.runtimeFamily === 'string' && contract.runtimeFamily.length > 0
    && contract.runtimeFamily === profile.runtimeFamily
    && Number.isSafeInteger(contract.offlineContractVersion) && contract.offlineContractVersion > 0
    && contract.offlineContractVersion === profile.offlineContractVersion && contract.engine === 'hermes'
    && ['android', 'ios'].every((platform) => Array.isArray(contract.platformArchitectures?.[platform])
      && contract.platformArchitectures[platform].includes('new'))
    && typeof pkg.peerDependencies?.[HOST] === 'string'
    && typeof pkg.peerDependencies?.['react-native'] === 'string'
    && typeof host.peerDependencies?.[OFFLINE] === 'string'
    && contract.hostPeerRange === pkg.peerDependencies[HOST]
    && semver.satisfies(host.version, contract.hostPeerRange)
    && semver.satisfies(contract.reactNativeVersion, pkg.peerDependencies['react-native'])
    && semver.satisfies(version, host.peerDependencies[OFFLINE]),
  'Offline SDK, published host peers and native runtime contract disagree.');
  verifyOfflineArtifacts(root, contract);
}

module.exports = { unpack, hashFile, readOfflineContract, verifyInstalledOfflineSdk };
