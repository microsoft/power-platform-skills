#!/usr/bin/env node

'use strict';

// Validates a project-local, non-secret summary of Apple signing readiness.
// Raw keychain paths and signing assets stay outside the project; only opaque
// identifiers, fingerprints, metadata, and short-lived read-back proof cross
// this boundary.

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROOF_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SERVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/;
const FILE_PATH_RE = /^(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/]|\\\\)|(?:^|[\\/])[^\\/]+\.(?:p8|p12|pfx|pem|key|cer|crt|mobileprovision)$/i;
const SECRET_KEY_RE =
  /^(?:apple.*(?:id|email)|email|username|password|passphrase|two.*factor.*|2fa.*|otp|session.*|cookie|api.*key|issuer.*id|key.*id|private.*key|certificate|cert(?:ificate)?.*(?:data|content|path)|profile.*(?:data|content|path)|provisioning.*profile.*path|udid|device.*id|.*token|authorization|credential|.*secret|path)$/i;

class SafeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function issue(code, field, message) {
  return { code, field, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(value, allowed, required, field, issues) {
  if (!isObject(value)) {
    issues.push(issue('object-required', field, 'Value must be an object.'));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(issue('unknown-field', `${field}.${key}`, 'Unknown field is not allowed.'));
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      issues.push(issue('missing-field', `${field}.${key}`, 'Required field is missing.'));
    }
  }
  return true;
}

function requiredString(value, field, pattern, issues, message = 'Value is malformed.') {
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    issues.push(issue('invalid-string', field, 'Value must be a non-empty trimmed string.'));
    return false;
  }
  if (pattern && !pattern.test(value)) {
    issues.push(issue('malformed-identifier', field, message));
    return false;
  }
  return true;
}

function parseCanonicalTimestamp(value, field, issues) {
  if (typeof value !== 'string') {
    issues.push(issue('invalid-timestamp', field, 'Timestamp must be canonical UTC ISO 8601.'));
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    issues.push(issue('invalid-timestamp', field, 'Timestamp must be canonical UTC ISO 8601.'));
    return null;
  }
  if (new Date(parsed).toISOString() !== value) {
    issues.push(issue('non-canonical-timestamp', field, 'Timestamp must use canonical UTC ISO 8601.'));
  }
  return parsed;
}

function findForbiddenContent(value, field = '$', seen = new Set()) {
  const findings = [];
  if (value && typeof value === 'object') {
    if (seen.has(value)) return findings;
    seen.add(value);
    if (!Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (SECRET_KEY_RE.test(key)) {
          findings.push(issue('secret-field-forbidden', `${field}.${key}`, 'Sensitive or asset-bearing field is forbidden.'));
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      findings.push(...findForbiddenContent(child, `${field}.${key}`, seen));
    }
    return findings;
  }
  if (typeof value !== 'string') return findings;
  if (
    EMAIL_RE.test(value)
    || JWT_RE.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value)
    || /-----BEGIN [A-Z ]+-----/.test(value)
    || /<\?xml|<plist\b|<key>ProvisionedDevices<\/key>/i.test(value)
    || FILE_PATH_RE.test(value)
  ) {
    findings.push(issue('sensitive-value-forbidden', field, 'Identity, secret, signing-asset content, UDID, or file path is forbidden.'));
  }
  return findings;
}

function validateCertificate(value, field, expectedType, now, validUntil, issues) {
  if (!checkKeys(
    value,
    ['resourceId', 'type', 'expiresAt', 'proof'],
    ['resourceId', 'type', 'expiresAt', 'proof'],
    field,
    issues,
  )) return;
  requiredString(value.resourceId, `${field}.resourceId`, RESOURCE_ID_RE, issues);
  if (value.type !== expectedType) {
    issues.push(issue('certificate-type-mismatch', `${field}.type`, `Certificate type must be ${expectedType}.`));
  }
  if (value.proof !== 'keychain-identity-readback') {
    issues.push(issue('invalid-resource-proof', `${field}.proof`, 'Certificate proof must be keychain-identity-readback.'));
  }
  const expiresAt = parseCanonicalTimestamp(value.expiresAt, `${field}.expiresAt`, issues);
  if (expiresAt !== null && (expiresAt <= now.getTime() || (validUntil !== null && expiresAt <= validUntil))) {
    issues.push(issue('expired-or-insufficient-resource', `${field}.expiresAt`, 'Certificate must remain valid beyond the proof window.'));
  }
}

function validateProfile(value, field, expectedType, expectedApns, teamId, bundleId, now, validUntil, issues) {
  const expectedCertificateType = expectedType === 'development'
    ? 'apple-development'
    : 'apple-distribution';
  if (!checkKeys(
    value,
    [
      'uuid', 'type', 'expiresAt', 'bundleId', 'teamId', 'apnsEnvironment',
      'getTaskAllow', 'deviceCount', 'certificateResourceId', 'certificateType', 'proof',
    ],
    [
      'uuid', 'type', 'expiresAt', 'bundleId', 'teamId', 'apnsEnvironment',
      'getTaskAllow', 'deviceCount', 'certificateResourceId', 'certificateType', 'proof',
    ],
    field,
    issues,
  )) return;
  requiredString(value.uuid, `${field}.uuid`, UUID_RE, issues);
  if (value.type !== expectedType) {
    issues.push(issue('profile-type-mismatch', `${field}.type`, `Profile type must be ${expectedType}.`));
  }
  if (value.bundleId !== bundleId) {
    issues.push(issue('profile-bundle-mismatch', `${field}.bundleId`, 'Profile bundle ID must match the contract bundle ID.'));
  }
  if (value.teamId !== teamId) {
    issues.push(issue('profile-team-mismatch', `${field}.teamId`, 'Profile Team ID must match the contract Team ID.'));
  }
  if (value.apnsEnvironment !== expectedApns) {
    issues.push(issue('profile-apns-mismatch', `${field}.apnsEnvironment`, `APNs environment must be ${expectedApns}.`));
  }
  if (value.getTaskAllow !== (expectedType === 'development')) {
    issues.push(issue('profile-mode-mismatch', `${field}.getTaskAllow`, 'get-task-allow does not match the profile mode.'));
  }
  requiredString(value.certificateResourceId, `${field}.certificateResourceId`, RESOURCE_ID_RE, issues);
  if (value.certificateType !== expectedCertificateType) {
    issues.push(issue('profile-certificate-type-mismatch', `${field}.certificateType`, `Certificate type must be ${expectedCertificateType}.`));
  }
  if (!Number.isSafeInteger(value.deviceCount) || value.deviceCount < 1) {
    issues.push(issue('invalid-device-count', `${field}.deviceCount`, 'Device count must be a positive integer; device identifiers are forbidden.'));
  }
  if (value.proof !== 'installed-profile-metadata-readback') {
    issues.push(issue('invalid-resource-proof', `${field}.proof`, 'Profile proof must be installed-profile-metadata-readback.'));
  }
  const expiresAt = parseCanonicalTimestamp(value.expiresAt, `${field}.expiresAt`, issues);
  if (expiresAt !== null && (expiresAt <= now.getTime() || (validUntil !== null && expiresAt <= validUntil))) {
    issues.push(issue('expired-or-insufficient-resource', `${field}.expiresAt`, 'Profile must remain valid beyond the proof window.'));
  }
}

function validateProof(value, now, issues) {
  if (!checkKeys(
    value,
    ['verifier', 'verifierVersion', 'verifiedAt', 'validUntil', 'steps'],
    ['verifier', 'verifierVersion', 'verifiedAt', 'validUntil', 'steps'],
    'proof',
    issues,
  )) return { validUntil: null };
  if (value.verifier !== 'apple-ios-provisioning-preflight') {
    issues.push(issue('proof-verifier-mismatch', 'proof.verifier', 'Verifier must be apple-ios-provisioning-preflight.'));
  }
  requiredString(value.verifierVersion, 'proof.verifierVersion', SEMVER_RE, issues);
  const stepNames = [
    'teamAndBundleVerified',
    'pushCapabilityVerified',
    'keychainVerified',
    'developmentCertificateVerified',
    'distributionCertificateVerified',
    'developmentProfileVerified',
    'adHocProfileVerified',
  ];
  if (checkKeys(value.steps, stepNames, stepNames, 'proof.steps', issues)) {
    for (const step of stepNames) {
      if (value.steps[step] !== true) {
        issues.push(issue('proof-step-incomplete', `proof.steps.${step}`, 'Proof step must be true.'));
      }
    }
  }
  const verifiedAt = parseCanonicalTimestamp(value.verifiedAt, 'proof.verifiedAt', issues);
  const validUntil = parseCanonicalTimestamp(value.validUntil, 'proof.validUntil', issues);
  if (verifiedAt === null || validUntil === null) return { validUntil };
  if (verifiedAt > now.getTime() + FUTURE_CLOCK_SKEW_MS) {
    issues.push(issue('proof-from-future', 'proof.verifiedAt', 'Proof time is too far in the future.'));
  }
  if (validUntil <= verifiedAt || validUntil - verifiedAt > MAX_PROOF_AGE_MS) {
    issues.push(issue('invalid-proof-window', 'proof.validUntil', 'Proof window must be positive and at most 24 hours.'));
  }
  if (now.getTime() > validUntil || now.getTime() - verifiedAt > MAX_PROOF_AGE_MS) {
    issues.push(issue('stale-proof', 'proof', 'Proof is stale and must be renewed.'));
  }
  return { validUntil };
}

function validateContract(contract, {
  expectedTeam,
  expectedBundle,
  expectedMode,
  now = new Date(),
} = {}) {
  const issues = findForbiddenContent(contract);
  if (!checkKeys(
    contract,
    ['version', 'modes', 'teamId', 'bundleId', 'pushCapability', 'keychain', 'certificates', 'profiles', 'proof'],
    ['version', 'modes', 'teamId', 'bundleId', 'pushCapability', 'keychain', 'certificates', 'profiles', 'proof'],
    '$',
    issues,
  )) return issues;
  if (contract.version !== CONTRACT_VERSION) {
    issues.push(issue('unsupported-version', 'version', `Only contract version ${CONTRACT_VERSION} is supported.`));
  }
  if (
    !Array.isArray(contract.modes)
    || contract.modes.length !== 2
    || contract.modes[0] !== 'development'
    || contract.modes[1] !== 'ad-hoc'
  ) {
    issues.push(issue('unsupported-mode', 'modes', 'Modes must be exactly ["development", "ad-hoc"].'));
  }
  if (expectedMode && !['development', 'ad-hoc'].includes(expectedMode)) {
    issues.push(issue('unsupported-selected-mode', 'modes', 'Selected mode must be development or ad-hoc.'));
  }
  requiredString(contract.teamId, 'teamId', TEAM_ID_RE, issues, 'Team ID must be 10 uppercase letters or digits.');
  requiredString(contract.bundleId, 'bundleId', BUNDLE_ID_RE, issues, 'Bundle ID must use reverse-DNS syntax.');
  if (expectedTeam && contract.teamId !== expectedTeam) {
    issues.push(issue('team-mismatch', 'teamId', 'Team ID does not match the expected Team ID.'));
  }
  if (expectedBundle && contract.bundleId !== expectedBundle) {
    issues.push(issue('bundle-mismatch', 'bundleId', 'Bundle ID does not match the expected bundle ID.'));
  }

  if (checkKeys(
    contract.pushCapability,
    ['capability', 'enabled', 'proof'],
    ['capability', 'enabled', 'proof'],
    'pushCapability',
    issues,
  )) {
    if (contract.pushCapability.capability !== 'aps-environment') {
      issues.push(issue('invalid-push-capability', 'pushCapability.capability', 'Capability must be aps-environment.'));
    }
    if (contract.pushCapability.enabled !== true) {
      issues.push(issue('push-capability-disabled', 'pushCapability.enabled', 'Push capability must be enabled.'));
    }
    if (contract.pushCapability.proof !== 'app-id-capability-readback') {
      issues.push(issue('invalid-resource-proof', 'pushCapability.proof', 'Push proof must be app-id-capability-readback.'));
    }
  }

  if (checkKeys(
    contract.keychain,
    ['serviceIdentifier', 'pathFingerprint'],
    ['serviceIdentifier', 'pathFingerprint'],
    'keychain',
    issues,
  )) {
    requiredString(contract.keychain.serviceIdentifier, 'keychain.serviceIdentifier', SERVICE_ID_RE, issues);
    requiredString(contract.keychain.pathFingerprint, 'keychain.pathFingerprint', SHA256_RE, issues);
  }

  const { validUntil } = validateProof(contract.proof, now, issues);
  if (checkKeys(
    contract.certificates,
    ['development', 'distribution'],
    ['development', 'distribution'],
    'certificates',
    issues,
  )) {
    validateCertificate(contract.certificates.development, 'certificates.development', 'apple-development', now, validUntil, issues);
    validateCertificate(contract.certificates.distribution, 'certificates.distribution', 'apple-distribution', now, validUntil, issues);
  }
  if (checkKeys(
    contract.profiles,
    ['development', 'adHoc'],
    ['development', 'adHoc'],
    'profiles',
    issues,
  )) {
    validateProfile(contract.profiles.development, 'profiles.development', 'development', 'development', contract.teamId, contract.bundleId, now, validUntil, issues);
    validateProfile(contract.profiles.adHoc, 'profiles.adHoc', 'ad-hoc', 'production', contract.teamId, contract.bundleId, now, validUntil, issues);
    if (
      contract.profiles.development?.certificateResourceId
      !== contract.certificates?.development?.resourceId
    ) {
      issues.push(issue('profile-certificate-resource-mismatch', 'profiles.development.certificateResourceId', 'Development profile certificate must match the verified development identity.'));
    }
    if (
      contract.profiles.adHoc?.certificateResourceId
      !== contract.certificates?.distribution?.resourceId
    ) {
      issues.push(issue('profile-certificate-resource-mismatch', 'profiles.adHoc.certificateResourceId', 'Ad hoc profile certificate must match the verified distribution identity.'));
    }
  }
  return issues;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveContractFile(projectRootArg, fileArg) {
  const requestedRoot = path.resolve(projectRootArg);
  const rootStat = fs.lstatSync(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SafeError('unsafe-project-root', 'Project root must be a regular non-symbolic-link directory.');
  }
  const root = fs.realpathSync(requestedRoot);
  const requested = path.resolve(root, fileArg);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('file-outside-project-root', 'Contract file must be inside project root.');
  }
  const relativeParts = path.relative(root, requested).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new SafeError('unsafe-contract-path', 'Contract path must not contain symbolic links.');
    }
  }
  const stat = fs.statSync(requested);
  if (!stat.isFile()) {
    throw new SafeError('file-not-regular', 'Contract path must be a regular file.');
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new SafeError('file-too-large', `Contract exceeds ${MAX_FILE_BYTES} bytes.`);
  }
  return { root, file: requested };
}

function parseArgs(argv, cwd = process.cwd()) {
  const args = {
    projectRoot: cwd,
    file: 'apple-ios-provisioning.json',
    expectedTeam: null,
    expectedBundle: null,
    expectedMode: null,
    now: null,
    help: false,
  };
  const names = {
    '--project-root': 'projectRoot',
    '--file': 'file',
    '--expected-team': 'expectedTeam',
    '--expected-bundle': 'expectedBundle',
    '--expected-mode': 'expectedMode',
    '--now': 'now',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!names[arg]) throw new SafeError('unknown-argument', `Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new SafeError('missing-argument-value', `${arg} requires a value.`);
    }
    args[names[arg]] = value;
    index += 1;
  }
  if (args.expectedTeam && !TEAM_ID_RE.test(args.expectedTeam)) {
    throw new SafeError('invalid-expected-team', 'Expected Team ID is malformed.');
  }
  if (args.expectedBundle && !BUNDLE_ID_RE.test(args.expectedBundle)) {
    throw new SafeError('invalid-expected-bundle', 'Expected bundle ID is malformed.');
  }
  if (args.expectedMode && !['development', 'ad-hoc'].includes(args.expectedMode)) {
    throw new SafeError('invalid-expected-mode', 'Expected mode must be development or ad-hoc.');
  }
  if (args.now && !Number.isFinite(Date.parse(args.now))) {
    throw new SafeError('invalid-now', '--now must be a valid ISO 8601 timestamp.');
  }
  return args;
}

function usage() {
  return [
    'Usage: node validate-apple-ios-provisioning.js [--project-root <path>]',
    '  [--file <project-relative-path>] [--expected-team <10-character-team-id>]',
    '  [--expected-bundle <bundle-id>] [--expected-mode <development|ad-hoc>]',
    '  [--now <ISO-8601>]',
    '',
    'Defaults to apple-ios-provisioning.json in the project root. Emits structured JSON.',
  ].join('\n');
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const args = parseArgs(argv, cwd);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const resolved = resolveContractFile(args.projectRoot, args.file);
    let contract;
    try {
      contract = JSON.parse(fs.readFileSync(resolved.file, 'utf8'));
    } catch {
      throw new SafeError('invalid-json', 'Contract file is not valid JSON.');
    }
    const issues = validateContract(contract, {
      expectedTeam: args.expectedTeam,
      expectedBundle: args.expectedBundle,
      expectedMode: args.expectedMode,
      now: args.now ? new Date(args.now) : new Date(),
    });
    process.stdout.write(`${JSON.stringify({
      status: issues.length === 0 ? 'valid' : 'invalid',
      contract: path.relative(resolved.root, resolved.file).split(path.sep).join('/'),
      version: contract?.version,
      modes: contract?.modes,
      selectedMode: args.expectedMode,
      teamId: contract?.teamId,
      bundleId: contract?.bundleId,
      issues,
    }, null, 2)}\n`);
    return issues.length === 0 ? 0 : 2;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('unable-to-validate', 'Unable to validate Apple iOS provisioning contract.');
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      issues: [issue(safe.code, 'input', safe.message)],
    }, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  CONTRACT_VERSION,
  MAX_PROOF_AGE_MS,
  findForbiddenContent,
  isWithinRoot,
  main,
  parseArgs,
  resolveContractFile,
  validateContract,
};
