#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { deriveProjectIdentity } = require('./lib/apple-signing-keychain');
const {
  resolveContractFile,
  validateContract,
} = require('./validate-apple-ios-provisioning');
const {
  resolveProvisioningProfilesDirectory,
} = require('../assets/apple-fastlane/fastlane/lib/apple_profile_directory');

const MODES = {
  development: {
    certificateType: 'apple-development',
    commonNamePrefix: 'Apple Development',
    profileKey: 'development',
    apnsEnvironment: 'development',
    getTaskAllow: true,
  },
  'ad-hoc': {
    certificateType: 'apple-distribution',
    commonNamePrefix: 'Apple Distribution',
    profileKey: 'adHoc',
    apnsEnvironment: 'production',
    getTaskAllow: false,
  },
};

class SafeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function normalizedFingerprint(value) {
  return String(value || '').replaceAll(':', '').toUpperCase();
}

function subjectValue(subject, key) {
  const match = String(subject || '').match(
    new RegExp(`(?:^|\\n|,\\s*)${key}=([^\\n,]+)`),
  );
  return match ? match[1] : '';
}

function runCommand(command, args, options = {}) {
  const result = (options.spawnSync || spawnSync)(command, args, {
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new SafeError(options.code);
  return result.stdout;
}

function readSigningIdentities(keychainPath, teamId, mode, options = {}) {
  const expected = MODES[mode];
  const identityOutput = runCommand(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning', keychainPath],
    { ...options, code: 'identity-readback-failed' },
  );
  const usableHashes = new Set(
    identityOutput.match(/\b[0-9A-F]{40}\b/gi)?.map(normalizedFingerprint) || [],
  );
  const pemOutput = runCommand(
    '/usr/bin/security',
    ['find-certificate', '-a', '-p', keychainPath],
    { ...options, code: 'certificate-readback-failed' },
  );
  const certificates = pemOutput.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  ) || [];
  const matching = certificates.filter((pem) => {
    try {
      const certificate = new crypto.X509Certificate(pem);
      return subjectValue(certificate.subject, 'OU') === teamId
        && subjectValue(certificate.subject, 'CN').startsWith(expected.commonNamePrefix)
        && new Date(certificate.validTo).getTime() > Date.now()
        && usableHashes.has(normalizedFingerprint(certificate.fingerprint));
    } catch {
      return false;
    }
  });
  if (matching.length < 1) throw new SafeError('required-signing-identity-missing');
  return new Set(matching.map((pem) => {
    const certificate = new crypto.X509Certificate(pem);
    return normalizedFingerprint(certificate.fingerprint);
  }));
}

function assertProfilePath(profilePath, profileRoot, homeDirectory = os.homedir()) {
  const root = path.resolve(profileRoot);
  const requested = path.resolve(profilePath);
  if (path.dirname(requested) !== root) throw new SafeError('installed-profile-path-invalid');
  const home = path.resolve(homeDirectory);
  const relativeRoot = path.relative(home, root);
  if (
    relativeRoot === '..'
    || relativeRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeRoot)
  ) {
    throw new SafeError('installed-profile-path-invalid');
  }
  let cursor = home;
  try {
    for (const component of path.relative(home, requested).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new SafeError('installed-profile-path-unsafe');
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (error?.code === 'ENOENT') throw new SafeError('installed-profile-missing');
    throw new SafeError('installed-profile-path-invalid');
  }
  const stat = fs.statSync(requested);
  if (!stat.isFile()) throw new SafeError('installed-profile-missing');
}

function decodeInstalledProfile(profilePath, options = {}) {
  const xml = runCommand(
    '/usr/bin/security',
    ['cms', '-D', '-i', profilePath],
    { ...options, code: 'installed-profile-decode-failed' },
  );
  const json = runCommand(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', '-'],
    { ...options, input: xml, code: 'installed-profile-plist-invalid' },
  );
  try {
    return JSON.parse(json);
  } catch {
    throw new SafeError('installed-profile-plist-invalid');
  }
}

function verifyProfile(profile, contractProfile, teamId, bundleId, mode, identityHashes) {
  const expected = MODES[mode];
  const entitlements = profile?.Entitlements;
  const teamIdentifiers = profile?.TeamIdentifier;
  if (!entitlements || !Array.isArray(teamIdentifiers)) {
    throw new SafeError('installed-profile-metadata-invalid');
  }
  if (profile.UUID !== contractProfile.uuid) throw new SafeError('installed-profile-contract-drift');
  if (teamIdentifiers.length !== 1 || teamIdentifiers[0] !== teamId) {
    throw new SafeError('installed-profile-team-mismatch');
  }
  if (entitlements['application-identifier'] !== `${teamId}.${bundleId}`) {
    throw new SafeError('installed-profile-bundle-mismatch');
  }
  if (entitlements['com.apple.developer.team-identifier'] !== teamId) {
    throw new SafeError('installed-profile-team-mismatch');
  }
  if (entitlements['aps-environment'] !== expected.apnsEnvironment) {
    throw new SafeError('installed-profile-apns-mismatch');
  }
  if (entitlements['get-task-allow'] !== expected.getTaskAllow) {
    throw new SafeError('installed-profile-mode-mismatch');
  }
  if (!Array.isArray(profile.ProvisionedDevices) || profile.ProvisionedDevices.length < 1) {
    throw new SafeError('installed-profile-device-coverage-missing');
  }
  if (profile.ProvisionsAllDevices === true || entitlements['beta-reports-active'] === true) {
    throw new SafeError('installed-profile-distribution-mode-mismatch');
  }
  if (Date.parse(profile.ExpirationDate) <= Date.now()) {
    throw new SafeError('installed-profile-expired');
  }
  const profileCertificates = Array.isArray(profile.DeveloperCertificates)
    ? profile.DeveloperCertificates
    : [];
  const matchesIdentity = profileCertificates.some((encoded) => {
    try {
      const certificate = new crypto.X509Certificate(Buffer.from(encoded, 'base64'));
      return subjectValue(certificate.subject, 'OU') === teamId
        && subjectValue(certificate.subject, 'CN').startsWith(expected.commonNamePrefix)
        && identityHashes.has(normalizedFingerprint(certificate.fingerprint));
    } catch {
      return false;
    }
  });
  if (!matchesIdentity) throw new SafeError('installed-profile-identity-mismatch');
}

function parseArgs(argv, cwd = process.cwd()) {
  const result = {
    projectRoot: cwd,
    file: 'apple-ios-provisioning.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--project-root', '--file', '--mode', '--expected-team', '--expected-bundle'].includes(key)) {
      throw new SafeError('invalid-arguments');
    }
    if (!value || value.startsWith('--')) throw new SafeError('invalid-arguments');
    const property = {
      '--project-root': 'projectRoot',
      '--file': 'file',
      '--mode': 'mode',
      '--expected-team': 'expectedTeam',
      '--expected-bundle': 'expectedBundle',
    }[key];
    result[property] = value;
    index += 1;
  }
  if (!MODES[result.mode] || !result.expectedTeam || !result.expectedBundle) {
    throw new SafeError('invalid-arguments');
  }
  return result;
}

function verifyBuildSigning(args, options = {}) {
  const resolved = resolveContractFile(args.projectRoot, args.file);
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(resolved.file, 'utf8'));
  } catch {
    throw new SafeError('provisioning-contract-unreadable');
  }
  const issues = validateContract(contract, {
    expectedTeam: args.expectedTeam,
    expectedBundle: args.expectedBundle,
    expectedMode: args.mode,
    now: options.now || new Date(),
  });
  if (issues.length > 0) throw new SafeError('provisioning-contract-invalid-or-stale');

  const projectIdentity = deriveProjectIdentity(resolved.root, options);
  if (
    contract.keychain.serviceIdentifier !== projectIdentity.serviceIdentifier
    || contract.keychain.pathFingerprint !== `sha256:${projectIdentity.pathFingerprint}`
  ) {
    throw new SafeError('retained-keychain-handoff-mismatch');
  }

  const expected = MODES[args.mode];
  const contractProfile = contract.profiles[expected.profileKey];
  const identityHashes = readSigningIdentities(
    projectIdentity.keychainPath,
    args.expectedTeam,
    args.mode,
    options,
  );
  const home = options.home || os.homedir();
  const profileRoot = resolveProvisioningProfilesDirectory({
    home,
    xcodeVersion: options.xcodeVersion,
    spawnSync: options.spawnSync,
  });
  const profilePath = path.join(profileRoot, `${contractProfile.uuid}.mobileprovision`);
  assertProfilePath(profilePath, profileRoot, home);
  const profile = decodeInstalledProfile(profilePath, options);
  verifyProfile(
    profile,
    contractProfile,
    args.expectedTeam,
    args.expectedBundle,
    args.mode,
    identityHashes,
  );
  return {
    status: 'ready',
    mode: args.mode,
    teamId: args.expectedTeam,
    bundleId: args.expectedBundle,
    identityType: expected.certificateType,
    apnsEnvironment: expected.apnsEnvironment,
    checks: {
      freshProvisioningContract: true,
      retainedKeychainIdentity: true,
      installedProfile: true,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    const result = verifyBuildSigning(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof SafeError ? error.code : 'signing-proof-failed';
    process.stdout.write(`${JSON.stringify({ status: 'blocked', code })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  MODES,
  SafeError,
  assertProfilePath,
  decodeInstalledProfile,
  main,
  parseArgs,
  readSigningIdentities,
  resolveProvisioningProfilesDirectory,
  verifyBuildSigning,
  verifyProfile,
};
