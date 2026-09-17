#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_HANDOFF_AGE_MS,
  SafeError,
  assertSafeRelativePath,
  captureStableFile,
  computeInputSnapshot,
  inputSnapshotsEqual,
  isWithinRoot,
  readProjectIdentity,
  resolveProjectFile,
  resolveProjectRoot,
  validateInputSnapshot,
} = require('./write-ios-build-handoff');

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const FORBIDDEN_KEY =
  /api.?key|apns.?key.?id|certificate|client.?secret|credential|keychain|password|private.?key|profile|provision|secret|signing.?identity|(?:^|[^a-z])token(?:$|[^a-z])|(?:access|auth|bearer|fcm|firebase|id|push|refresh)token$/i;
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'platform',
  'purpose',
  'status',
  'artifact',
  'app',
  'firebase',
  'auth',
  'build',
  'tooling',
  'timestamps',
  'inputs',
]);
const ALLOWED_NESTED_KEYS = {
  artifact: new Set(['path', 'sha256', 'sizeBytes', 'modifiedAt']),
  app: new Set(['bundleIdentifier', 'displayName', 'version', 'versionCode']),
  firebase: new Set(['projectId', 'iosAppId', 'bundleIdentifier', 'clientConfigPath']),
  auth: new Set(['clientId', 'tenantId']),
  build: new Set(['mode', 'appleTeamId', 'exportMethod', 'apnsEnvironment']),
  tooling: new Set(['wrapPackage', 'wrapVersion']),
  timestamps: new Set(['inputsCapturedAt', 'buildStartedAt', 'generatedAt', 'validUntil']),
  inputs: new Set(['schemaVersion', 'algorithm', 'digest', 'fileCount', 'totalBytes', 'files']),
};
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function issue(code, message) {
  return { code, message };
}

function parseArgs(argv, cwd = process.cwd()) {
  const result = {
    projectRoot: cwd,
    file: 'ios-build.json',
    maxAgeHours: 24,
    help: false,
  };
  const names = {
    '--project-root': 'projectRoot',
    '--file': 'file',
    '--max-age-hours': 'maxAgeHours',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    const name = names[arg];
    if (!name) throw new SafeError('unknown-argument', `Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new SafeError('missing-argument-value', `${arg} requires a value.`);
    }
    result[name] = value;
    index += 1;
  }
  result.maxAgeHours = Number(result.maxAgeHours);
  if (
    !result.help
    && (
      !Number.isFinite(result.maxAgeHours)
      || result.maxAgeHours <= 0
      || result.maxAgeHours > 24
    )
  ) {
    throw new SafeError(
      'max-age-invalid',
      '--max-age-hours must be greater than 0 and no more than 24.',
    );
  }
  return result;
}

function inspectForbiddenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const findings = [];
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_KEY.test(key)) findings.push(field);
    findings.push(...inspectForbiddenKeys(child, field));
  }
  return findings;
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeError('handoff-shape-invalid', `${label} must be a JSON object.`);
  }
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new SafeError(
      'handoff-unknown-fields',
      `${label} contains unsupported fields: ${extra.join(', ')}.`,
    );
  }
  const missing = [...allowed].filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new SafeError(
      'handoff-missing-fields',
      `${label} is missing required fields: ${missing.join(', ')}.`,
    );
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SafeError('handoff-field-invalid', `${label} must be a non-empty string.`);
  }
}

function assertSha256(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value || '')) {
    throw new SafeError('handoff-sha256-invalid', `${label} must be an exact lowercase SHA-256.`);
  }
}

function parseTimestamp(value, label) {
  assertString(value, label);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new SafeError('handoff-time-invalid', `${label} must be a canonical ISO timestamp.`);
  }
  return time;
}

function validateDocumentShape(document) {
  const forbidden = inspectForbiddenKeys(document);
  if (forbidden.length > 0) {
    throw new SafeError(
      'handoff-credential-fields-forbidden',
      `ios-build.json contains forbidden credential-shaped fields: ${forbidden.join(', ')}.`,
    );
  }
  assertExactKeys(document, ALLOWED_TOP_LEVEL_KEYS, 'ios-build.json');
  for (const [field, allowed] of Object.entries(ALLOWED_NESTED_KEYS)) {
    assertExactKeys(document[field], allowed, `ios-build.json ${field}`);
  }
  if (document.schemaVersion !== 1) {
    throw new SafeError('handoff-schema-unsupported', 'ios-build.json schemaVersion must be 1.');
  }
  if (
    document.platform !== 'ios'
    || document.purpose !== 'registered-physical-device-testing'
    || document.status !== 'ready'
  ) {
    throw new SafeError(
      'handoff-purpose-invalid',
      'ios-build.json must describe a ready registered physical-device iOS build.',
    );
  }
  for (const [label, value] of Object.entries({
    'artifact.path': document.artifact.path,
    'artifact.modifiedAt': document.artifact.modifiedAt,
    'app.bundleIdentifier': document.app.bundleIdentifier,
    'app.displayName': document.app.displayName,
    'app.version': document.app.version,
    'firebase.projectId': document.firebase.projectId,
    'firebase.iosAppId': document.firebase.iosAppId,
    'firebase.bundleIdentifier': document.firebase.bundleIdentifier,
    'firebase.clientConfigPath': document.firebase.clientConfigPath,
    'auth.clientId': document.auth.clientId,
    'auth.tenantId': document.auth.tenantId,
    'build.mode': document.build.mode,
    'build.appleTeamId': document.build.appleTeamId,
    'build.exportMethod': document.build.exportMethod,
    'build.apnsEnvironment': document.build.apnsEnvironment,
    'tooling.wrapPackage': document.tooling.wrapPackage,
    'tooling.wrapVersion': document.tooling.wrapVersion,
  })) {
    assertString(value, label);
  }
  assertSha256(document.artifact.sha256, 'artifact.sha256');
  parseTimestamp(document.artifact.modifiedAt, 'artifact.modifiedAt');
  assertSafeRelativePath(document.artifact.path, 'artifact.path');
  assertSafeRelativePath(document.firebase.clientConfigPath, 'firebase.clientConfigPath');
  if (path.extname(document.artifact.path).toLowerCase() !== '.ipa') {
    throw new SafeError('handoff-artifact-path-invalid', 'artifact.path must name a project-relative .ipa file.');
  }
  if (!Number.isSafeInteger(document.artifact.sizeBytes) || document.artifact.sizeBytes < 1) {
    throw new SafeError('handoff-size-invalid', 'artifact.sizeBytes must be a positive integer.');
  }
  if (!Number.isSafeInteger(document.app.versionCode) || document.app.versionCode < 1) {
    throw new SafeError('handoff-version-code-invalid', 'app.versionCode must be a positive integer.');
  }
  if (
    !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(document.app.bundleIdentifier)
    || document.firebase.bundleIdentifier !== document.app.bundleIdentifier
  ) {
    throw new SafeError('handoff-bundle-invalid', 'App and Firebase bundle identifiers must match.');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(document.app.version)) {
    throw new SafeError('handoff-version-invalid', 'app.version must be a semantic version.');
  }
  if (!GUID.test(document.auth.clientId) || !GUID.test(document.auth.tenantId)) {
    throw new SafeError('handoff-auth-invalid', 'auth clientId and tenantId must be GUIDs.');
  }
  if (
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(document.firebase.projectId)
    || !/^\d+:\d+:ios:[0-9A-Za-z]+$/.test(document.firebase.iosAppId)
  ) {
    throw new SafeError('handoff-firebase-invalid', 'Firebase project and immutable iOS app identity are invalid.');
  }
  if (!/^[A-Z0-9]{10}$/.test(document.build.appleTeamId)) {
    throw new SafeError('handoff-team-invalid', 'build.appleTeamId must be a 10-character Apple Team ID.');
  }
  const validPairing = (
    document.build.mode === 'development'
    && document.build.exportMethod === 'development'
    && document.build.apnsEnvironment === 'development'
  ) || (
    document.build.mode === 'ad-hoc'
    && document.build.exportMethod === 'ad-hoc'
    && document.build.apnsEnvironment === 'production'
  );
  if (!validPairing) {
    throw new SafeError(
      'handoff-mode-invalid',
      'iOS mode, export method, and APNs environment are inconsistent.',
    );
  }
  if (
    document.tooling.wrapPackage !== '@microsoft/power-apps-native-host'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(document.tooling.wrapVersion)
  ) {
    throw new SafeError('handoff-tooling-invalid', 'Wrap tooling identity is invalid.');
  }
  validateInputSnapshot(document.inputs);
}

function compareInputSnapshots(recorded, current) {
  validateInputSnapshot(recorded);
  validateInputSnapshot(current);
  const recordedPaths = new Set(recorded.files.map((file) => file.path));
  const currentPaths = new Set(current.files.map((file) => file.path));
  const additions = current.files
    .map((file) => file.path)
    .filter((relativePath) => !recordedPaths.has(relativePath));
  const removals = recorded.files
    .map((file) => file.path)
    .filter((relativePath) => !currentPaths.has(relativePath));
  if (additions.length > 0 || removals.length > 0) {
    const details = [
      additions.length > 0 ? `added: ${additions.join(', ')}` : null,
      removals.length > 0 ? `removed: ${removals.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    throw new SafeError(
      'handoff-input-set-drift',
      `Declared iOS app/push input files changed after ios-build.json (${details}).`,
    );
  }
  if (!inputSnapshotsEqual(recorded, current)) {
    throw new SafeError(
      'handoff-input-content-drift',
      'Declared iOS app/push input content changed after ios-build.json.',
    );
  }
}

function stableFilesEqual(left, right) {
  return (
    left.path === right.path
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.modifiedAtNs === right.modifiedAtNs
    && left.changedAtNs === right.changedAtNs
    && left.device === right.device
    && left.inode === right.inode
  );
}

function validateHandoff(args, options = {}) {
  const root = resolveProjectRoot(args.projectRoot);
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAgeHours = args.maxAgeHours ?? 24;
  if (!Number.isFinite(now.getTime())) throw new SafeError('time-invalid', 'Validation time is invalid.');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 24) {
    throw new SafeError(
      'max-age-invalid',
      '--max-age-hours must be greater than 0 and no more than 24.',
    );
  }
  const handoffFile = captureStableFile(
    root,
    args.file,
    'ios-build.json',
    { extension: '.json' },
  );
  const handoffPath = path.resolve(root, handoffFile.path);
  if (handoffFile.sizeBytes > MAX_JSON_BYTES) {
    throw new SafeError('handoff-too-large', 'ios-build.json exceeds the supported size.');
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  } catch {
    throw new SafeError('handoff-json-invalid', 'ios-build.json must contain valid JSON.');
  }
  validateDocumentShape(document);

  const generatedAt = parseTimestamp(document.timestamps.generatedAt, 'timestamps.generatedAt');
  const inputsCapturedAt = parseTimestamp(
    document.timestamps.inputsCapturedAt,
    'timestamps.inputsCapturedAt',
  );
  const buildStartedAt = parseTimestamp(
    document.timestamps.buildStartedAt,
    'timestamps.buildStartedAt',
  );
  const validUntil = parseTimestamp(document.timestamps.validUntil, 'timestamps.validUntil');
  const artifactModifiedAt = parseTimestamp(document.artifact.modifiedAt, 'artifact.modifiedAt');
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  if (
    inputsCapturedAt > buildStartedAt + 1000
    || artifactModifiedAt < buildStartedAt
    || artifactModifiedAt > generatedAt + MAX_FUTURE_SKEW_MS
  ) {
    throw new SafeError(
      'handoff-time-order-invalid',
      'ios-build.json must preserve pre-build snapshot, build, artifact, and handoff ordering.',
    );
  }
  if (
    validUntil <= generatedAt
    || validUntil - generatedAt > MAX_HANDOFF_AGE_MS
  ) {
    throw new SafeError(
      'handoff-validity-invalid',
      'ios-build.json validity must be positive and no longer than 24 hours.',
    );
  }
  if (generatedAt > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new SafeError('handoff-time-future', 'ios-build.json generation time is unexpectedly in the future.');
  }
  if (now.getTime() > validUntil || now.getTime() - generatedAt > maxAgeMs) {
    throw new SafeError('handoff-stale', 'iOS build handoff is missing freshness or has expired.');
  }

  const projectIdentity = readProjectIdentity(
    root,
    document.build.mode,
    document.build.appleTeamId,
  );
  const identityChecks = [
    [document.app, projectIdentity.app],
    [document.firebase, projectIdentity.firebase],
    [document.auth, projectIdentity.auth],
    [document.build, projectIdentity.build],
    [document.tooling, projectIdentity.tooling],
  ];
  if (identityChecks.some(([recorded, current]) => JSON.stringify(recorded) !== JSON.stringify(current))) {
    throw new SafeError(
      'handoff-project-identity-drift',
      'Safe iOS app, Firebase, auth, build, or tooling identity changed after ios-build.json.',
    );
  }

  const currentInputs = computeInputSnapshot(root, projectIdentity.declaredInputPaths);
  compareInputSnapshots(document.inputs, currentInputs);
  const artifact = captureStableFile(root, document.artifact.path, 'iOS IPA', { extension: '.ipa' });
  const artifactPath = path.resolve(root, artifact.path);
  if (!isWithinRoot(artifactPath, projectIdentity.outputPath)) {
    throw new SafeError(
      'handoff-artifact-output-path-invalid',
      'Recorded iOS IPA must remain inside the freshly evaluated Wrap outputPath.',
    );
  }
  if (
    artifact.path !== document.artifact.path
    || artifact.sha256 !== document.artifact.sha256
    || artifact.sizeBytes !== document.artifact.sizeBytes
    || artifact.modifiedAt !== document.artifact.modifiedAt
  ) {
    throw new SafeError(
      'handoff-artifact-drift',
      'IPA hash, size, or modification time changed after ios-build.json.',
    );
  }
  const finalInputs = computeInputSnapshot(root, projectIdentity.declaredInputPaths);
  compareInputSnapshots(document.inputs, finalInputs);
  const finalArtifact = captureStableFile(root, document.artifact.path, 'iOS IPA', { extension: '.ipa' });
  if (
    finalArtifact.sha256 !== artifact.sha256
    || finalArtifact.sizeBytes !== artifact.sizeBytes
    || finalArtifact.modifiedAt !== artifact.modifiedAt
  ) {
    throw new SafeError('handoff-artifact-race', 'iOS IPA changed during handoff validation.');
  }
  if (typeof options.beforeFinalHandoffCheck === 'function') {
    options.beforeFinalHandoffCheck({ root, handoffPath, document });
  }
  const finalHandoffFile = captureStableFile(
    root,
    args.file,
    'ios-build.json',
    { extension: '.json' },
  );
  if (!stableFilesEqual(handoffFile, finalHandoffFile)) {
    throw new SafeError(
      'handoff-file-race',
      'ios-build.json changed or was replaced during handoff validation.',
    );
  }
  return {
    schemaVersion: 1,
    status: 'valid',
    platform: 'ios',
    purpose: document.purpose,
    artifact: document.artifact,
    app: document.app,
    firebase: document.firebase,
    build: document.build,
    tooling: document.tooling,
    timestamps: document.timestamps,
    inputs: {
      digest: document.inputs.digest,
      fileCount: document.inputs.fileCount,
      totalBytes: document.inputs.totalBytes,
    },
    continuity: 'pre/post-build-project-inputs-and-fresh-artifact-identity',
    attestation:
      'no-signing-profile-certificate-entitlement-ipa-signature-or-embedded-input-digest-attestation',
  };
}

function usage() {
  return [
    'Usage: node validate-ios-build-handoff.js --project-root <path>',
    '  [--file ios-build.json] [--max-age-hours <0-24>]',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = validateHandoff(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('ios-handoff-validation-failed', 'Unable to validate ios-build.json.');
    process.stdout.write(`${JSON.stringify({
      status: 'blocked',
      issues: [issue(safe.code, safe.message)],
    }, null, 2)}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  assertExactKeys,
  compareInputSnapshots,
  inspectForbiddenKeys,
  main,
  parseArgs,
  parseTimestamp,
  stableFilesEqual,
  validateDocumentShape,
  validateHandoff,
};
