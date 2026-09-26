#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  SafeError,
  assertAndroidInputProof,
  assertStableFileIdentity,
  captureStableFileIdentity,
  createStableFileSnapshot,
  declaredInputSnapshotsEqual,
  inspectForbiddenKeys,
  resolveProjectFile,
  resolveProjectRoot,
  toProjectPath,
  validateDeclaredInputsSnapshot,
  validateProject,
} = require('./validate-android-wrap-build');
const {
  MAX_PROOF_AGE_MS,
  assertVerificationTools,
  normalizeSha256,
  parseAaptBadging,
  parseAaptResourceStrings,
  parseApksignerOutput,
  resolveTool,
  runTool,
  sha256Buffer,
} = require('./verify-android-apk');

const VALIDATED_ARTIFACT = Symbol('validatedAndroidArtifact');

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'platform',
  'purpose',
  'status',
  'artifact',
  'app',
  'firebase',
  'auth',
  'signing',
  'tooling',
  'timestamps',
  'inputs',
]);
const ALLOWED_NESTED_KEYS = {
  artifact: new Set([
    'path',
    'sha256',
    'sizeBytes',
    'modifiedAt',
    'modifiedAtNs',
    'changedAtNs',
    'device',
    'inode',
  ]),
  app: new Set([
    'package',
    'displayName',
    'versionName',
    'versionCode',
    'minSdkVersion',
    'targetSdkVersion',
    'sourceIconPath',
    'sourceIconSha256',
    'packagedIconResource',
    'packagedIconSha256',
  ]),
  firebase: new Set(['projectId', 'androidAppId', 'package', 'clientConfigPath']),
  auth: new Set(['clientId', 'tenantId']),
  signing: new Set(['verified', 'verificationTool', 'certificateSha256', 'schemes']),
  tooling: new Set(['metadataTool', 'wrapPackage', 'wrapVersion']),
  timestamps: new Set(['inputsCapturedAt', 'buildStartedAt', 'verifiedAt', 'validUntil']),
  inputs: new Set(['schemaVersion', 'algorithm', 'digest', 'fileCount', 'totalBytes', 'files']),
};

function issue(code, message) {
  return { code, message };
}

function parseArgs(argv, cwd = process.cwd()) {
  const result = {
    projectRoot: cwd,
    file: 'android-build.json',
    maxAgeHours: 24,
    apksigner: null,
    aapt: null,
    unzip: null,
    expectedSignerSha256: null,
    help: false,
  };
  const names = {
    '--project-root': 'projectRoot',
    '--file': 'file',
    '--max-age-hours': 'maxAgeHours',
    '--apksigner': 'apksigner',
    '--aapt': 'aapt',
    '--unzip': 'unzip',
    '--expected-signer-sha256': 'expectedSignerSha256',
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
  if (!result.help && (!Number.isFinite(result.maxAgeHours) || result.maxAgeHours <= 0 || result.maxAgeHours > 24)) {
    throw new SafeError('max-age-invalid', '--max-age-hours must be greater than 0 and no more than 24.');
  }
  if (!result.help && !result.expectedSignerSha256) {
    throw new SafeError(
      'expected-signer-required',
      '--expected-signer-sha256 is required and must come from the customer-managed signing identity.',
    );
  }
  return result;
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
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SafeError('handoff-field-invalid', `${label} must be a non-empty string.`);
  }
}

function parseTimestamp(value, label) {
  assertString(value, label);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new SafeError('handoff-time-invalid', `${label} must be an ISO timestamp.`);
  }
  return time;
}

function exactBooleanMapEqual(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && left[key] === right[key]
    ))
  );
}

function validateDocumentShape(document) {
  assertExactKeys(document, ALLOWED_TOP_LEVEL_KEYS, 'android-build.json');
  for (const [field, allowed] of Object.entries(ALLOWED_NESTED_KEYS)) {
    assertExactKeys(document[field], allowed, `android-build.json ${field}`);
  }
  if (document.schemaVersion !== 1) {
    throw new SafeError('handoff-schema-unsupported', 'android-build.json schemaVersion must be 1.');
  }
  if (
    document.platform !== 'android'
    || document.purpose !== 'direct-physical-device-testing'
    || document.status !== 'verified'
  ) {
    throw new SafeError(
      'handoff-purpose-invalid',
      'android-build.json must describe a verified direct physical-device Android build.',
    );
  }
  const forbidden = inspectForbiddenKeys(document);
  if (forbidden.length > 0) {
    throw new SafeError(
      'handoff-secret-fields-forbidden',
      `android-build.json contains forbidden credential fields: ${forbidden.join(', ')}.`,
    );
  }
  for (const [field, value] of Object.entries({
    'artifact.path': document.artifact.path,
    'artifact.sha256': document.artifact.sha256,
    'artifact.modifiedAt': document.artifact.modifiedAt,
    'artifact.modifiedAtNs': document.artifact.modifiedAtNs,
    'artifact.changedAtNs': document.artifact.changedAtNs,
    'artifact.device': document.artifact.device,
    'artifact.inode': document.artifact.inode,
    'app.package': document.app.package,
    'app.displayName': document.app.displayName,
    'app.versionName': document.app.versionName,
    'app.sourceIconPath': document.app.sourceIconPath,
    'app.sourceIconSha256': document.app.sourceIconSha256,
    'app.packagedIconResource': document.app.packagedIconResource,
    'app.packagedIconSha256': document.app.packagedIconSha256,
    'firebase.projectId': document.firebase.projectId,
    'firebase.androidAppId': document.firebase.androidAppId,
    'firebase.package': document.firebase.package,
    'firebase.clientConfigPath': document.firebase.clientConfigPath,
    'auth.clientId': document.auth.clientId,
    'auth.tenantId': document.auth.tenantId,
    'signing.verificationTool': document.signing.verificationTool,
    'signing.certificateSha256': document.signing.certificateSha256,
    'tooling.metadataTool': document.tooling.metadataTool,
    'tooling.wrapPackage': document.tooling.wrapPackage,
    'tooling.wrapVersion': document.tooling.wrapVersion,
  })) {
    assertString(value, field);
  }
  if (!Number.isSafeInteger(document.artifact.sizeBytes) || document.artifact.sizeBytes < 1) {
    throw new SafeError('handoff-size-invalid', 'artifact.sizeBytes must be a positive integer.');
  }
  for (const [field, value] of Object.entries({
    'artifact.modifiedAtNs': document.artifact.modifiedAtNs,
    'artifact.changedAtNs': document.artifact.changedAtNs,
    'artifact.device': document.artifact.device,
    'artifact.inode': document.artifact.inode,
  })) {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      throw new SafeError('handoff-artifact-identity-invalid', `${field} must be a decimal integer string.`);
    }
  }
  if (!Number.isSafeInteger(document.app.versionCode) || document.app.versionCode < 1) {
    throw new SafeError('handoff-version-code-invalid', 'app.versionCode must be a positive integer.');
  }
  if (
    !Number.isSafeInteger(document.app.minSdkVersion)
    || document.app.minSdkVersion < 1
    || document.app.minSdkVersion > 26
    || !Number.isSafeInteger(document.app.targetSdkVersion)
    || document.app.targetSdkVersion < document.app.minSdkVersion
  ) {
    throw new SafeError(
      'handoff-sdk-version-invalid',
      'app minSdkVersion/targetSdkVersion must preserve Android 8 support.',
    );
  }
  if (
    document.signing.verified !== true
    || document.signing.verificationTool !== 'apksigner'
    || document.tooling.metadataTool !== 'aapt'
  ) {
    throw new SafeError('handoff-proof-invalid', 'android-build.json signing and metadata proof is invalid.');
  }
  if (
    !document.signing.schemes
    || typeof document.signing.schemes !== 'object'
    || Array.isArray(document.signing.schemes)
    || !Object.values(document.signing.schemes).some((value) => value === true)
    || Object.values(document.signing.schemes).some((value) => typeof value !== 'boolean')
    || Object.keys(document.signing.schemes).some((key) => !/^v[1-9]\d*$/.test(key))
    || !Object.entries(document.signing.schemes).some(([key, value]) => (
      value && Number(key.slice(1)) >= 2
    ))
  ) {
    throw new SafeError(
      'handoff-signature-schemes-invalid',
      'signing.schemes must contain a verified whole-file APK signature scheme v2 or newer.',
    );
  }
  normalizeSha256(document.artifact.sha256, 'Artifact');
  normalizeSha256(document.app.sourceIconSha256, 'Source icon');
  normalizeSha256(document.app.packagedIconSha256, 'Packaged icon');
  normalizeSha256(document.signing.certificateSha256, 'Signer certificate');
  validateDeclaredInputsSnapshot(document.inputs);
  if (
    !document.app.packagedIconResource.startsWith('res/')
    || document.app.packagedIconResource.includes('..')
    || path.posix.isAbsolute(document.app.packagedIconResource)
  ) {
    throw new SafeError(
      'handoff-icon-resource-invalid',
      'app.packagedIconResource must be a safe APK resource path.',
    );
  }
}

function validateHandoff(args, options = {}) {
  const root = resolveProjectRoot(args.projectRoot);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new SafeError('time-invalid', 'Validation time is invalid.');
  const expectedSigner = normalizeSha256(
    args.expectedSignerSha256,
    'Expected signer certificate',
  );
  const handoffPath = resolveProjectFile(root, args.file, 'android-build.json', { extension: '.json' });
  let document;
  try {
    document = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  } catch {
    throw new SafeError('handoff-json-invalid', 'android-build.json must contain valid JSON.');
  }
  validateDocumentShape(document);

  const verifiedAt = parseTimestamp(document.timestamps.verifiedAt, 'timestamps.verifiedAt');
  const validUntil = parseTimestamp(document.timestamps.validUntil, 'timestamps.validUntil');
  const inputsCapturedAt = parseTimestamp(
    document.timestamps.inputsCapturedAt,
    'timestamps.inputsCapturedAt',
  );
  const buildStartedAt = parseTimestamp(
    document.timestamps.buildStartedAt,
    'timestamps.buildStartedAt',
  );
  const modifiedAt = parseTimestamp(document.artifact.modifiedAt, 'artifact.modifiedAt');
  if (Number(BigInt(document.artifact.modifiedAtNs) / 1000000n) !== modifiedAt) {
    throw new SafeError(
      'handoff-artifact-time-invalid',
      'artifact.modifiedAt must match artifact.modifiedAtNs.',
    );
  }
  const maxAgeMs = args.maxAgeHours * 60 * 60 * 1000;
  if (
    inputsCapturedAt > buildStartedAt
    || buildStartedAt - inputsCapturedAt > MAX_PROOF_AGE_MS
    || verifiedAt < buildStartedAt
    || modifiedAt + 1000 < buildStartedAt
    || validUntil <= verifiedAt
    || validUntil - verifiedAt > MAX_PROOF_AGE_MS
  ) {
    throw new SafeError('handoff-time-order-invalid', 'android-build.json timestamps are inconsistent.');
  }
  if (now.getTime() > validUntil || now.getTime() - verifiedAt > maxAgeMs) {
    throw new SafeError('handoff-stale', 'Android build handoff is expired or older than the allowed proof age.');
  }
  if (verifiedAt > now.getTime() + 5 * 60 * 1000) {
    throw new SafeError('handoff-time-invalid', 'Android build verification time is unexpectedly in the future.');
  }

  const preflight = validateProject(root);
  if (!declaredInputSnapshotsEqual(document.inputs, preflight.inputs)) {
    throw new SafeError(
      'handoff-declared-input-drift',
      'Declared Android app/push inputs changed after android-build.json was created.',
    );
  }
  const artifactPath = resolveProjectFile(
    root,
    document.artifact.path,
    'Android APK',
    { extension: '.apk' },
  );
  const artifactIdentity = captureStableFileIdentity(root, artifactPath, 'Android APK');
  if (
    toProjectPath(root, artifactPath) !== document.artifact.path
    || artifactIdentity.sizeBytes !== document.artifact.sizeBytes
    || artifactIdentity.sha256 !== normalizeSha256(document.artifact.sha256, 'Artifact')
    || artifactIdentity.modifiedAtNs !== document.artifact.modifiedAtNs
    || artifactIdentity.changedAtNs !== document.artifact.changedAtNs
    || artifactIdentity.device !== document.artifact.device
    || artifactIdentity.inode !== document.artifact.inode
  ) {
    throw new SafeError('handoff-artifact-drift', 'APK changed after android-build.json was created.');
  }
  const apksigner = resolveTool('apksigner', args.apksigner, options);
  const aapt = resolveTool('aapt', args.aapt, options);
  const unzip = resolveTool('unzip', args.unzip, options);
  assertVerificationTools(root, apksigner, aapt, unzip);
  const verificationSnapshot = createStableFileSnapshot(
    root,
    artifactPath,
    artifactIdentity,
    'Android APK',
  );
  const assertArtifactUnchanged = (phase) => {
    assertStableFileIdentity(root, artifactPath, artifactIdentity, phase, 'Android APK');
    assertStableFileIdentity(
      root,
      verificationSnapshot.path,
      verificationSnapshot.identity,
      phase,
      'Android APK verification snapshot',
    );
  };
  try {
    const signingOutput = runTool(
      apksigner,
      ['verify', '--verbose', '--print-certs', verificationSnapshot.path],
      'apk-signature-invalid',
      options,
    );
    assertArtifactUnchanged('fresh APK signature handoff validation');
    const signing = parseApksignerOutput(signingOutput);
    if (
      signing.certificateSha256 !== expectedSigner
      || normalizeSha256(
        document.signing.certificateSha256,
        'Signer certificate',
      ) !== expectedSigner
      || !exactBooleanMapEqual(signing.schemes, document.signing.schemes)
    ) {
      throw new SafeError(
        'handoff-signature-proof-mismatch',
        'Fresh APK signature proof differs from the expected customer identity or android-build.json.',
      );
    }

    assertAndroidInputProof(verificationSnapshot.path, document.inputs.digest, {
      requireSigningBlock: true,
    });
    if (typeof options.onArtifactPhase === 'function') {
      options.onArtifactPhase('embedded-input-proof', artifactPath);
    }
    assertArtifactUnchanged('embedded input-proof handoff validation');

    const metadataOutput = runTool(
      aapt,
      ['dump', 'badging', verificationSnapshot.path],
      'apk-metadata-read-failed',
      options,
    );
    assertArtifactUnchanged('fresh APK package metadata handoff validation');
    const metadata = parseAaptBadging(metadataOutput);
    if (
      metadata.package !== document.app.package
      || metadata.displayName !== document.app.displayName
      || metadata.versionName !== document.app.versionName
      || metadata.versionCode !== document.app.versionCode
      || metadata.minSdkVersion !== document.app.minSdkVersion
      || metadata.targetSdkVersion !== document.app.targetSdkVersion
      || metadata.packagedIconResource !== document.app.packagedIconResource
    ) {
      throw new SafeError(
        'handoff-packaged-app-metadata-mismatch',
        'Fresh APK package/version/SDK/icon metadata differs from android-build.json.',
      );
    }

    const firebaseOutput = runTool(
      aapt,
      ['dump', 'resources', verificationSnapshot.path],
      'apk-metadata-read-failed',
      options,
    );
    assertArtifactUnchanged('fresh APK Firebase resource handoff validation');
    const packagedFirebase = parseAaptResourceStrings(firebaseOutput);
    if (
      packagedFirebase.projectId !== document.firebase.projectId
      || packagedFirebase.androidAppId !== document.firebase.androidAppId
      || metadata.package !== document.firebase.package
    ) {
      throw new SafeError(
        'handoff-packaged-firebase-metadata-mismatch',
        'Fresh APK Firebase/package identity differs from android-build.json.',
      );
    }

    const packagedIcon = runTool(
      unzip,
      ['-p', verificationSnapshot.path, metadata.packagedIconResource],
      'apk-icon-read-failed',
      { ...options, encoding: null },
    );
    assertArtifactUnchanged('fresh packaged icon handoff validation');
    if (
      !Buffer.isBuffer(packagedIcon)
      || packagedIcon.length < 1
      || sha256Buffer(packagedIcon) !== normalizeSha256(
        document.app.packagedIconSha256,
        'Packaged icon',
      )
    ) {
      throw new SafeError(
        'handoff-packaged-icon-mismatch',
        'Fresh packaged APK icon differs from android-build.json.',
      );
    }

    const identityChecks = [
      [metadata.package, preflight.app.package],
      [metadata.displayName, preflight.app.displayName],
      [metadata.versionName, preflight.app.versionName],
      [metadata.versionCode, preflight.app.versionCode],
      [document.app.sourceIconPath, preflight.app.iconPath],
      [document.app.sourceIconSha256, preflight.app.iconSha256],
      [packagedFirebase.projectId, preflight.firebase.projectId],
      [packagedFirebase.androidAppId, preflight.firebase.androidAppId],
      [metadata.package, preflight.firebase.package],
      [document.firebase.clientConfigPath, preflight.firebase.clientConfigPath],
      [document.auth.clientId, preflight.auth.clientId],
      [document.auth.tenantId, preflight.auth.tenantId],
      [document.tooling.wrapPackage, preflight.wrap.packageName],
      [document.tooling.wrapVersion, preflight.wrap.packageVersion],
    ];
    if (identityChecks.some(([actual, expected]) => actual !== expected)) {
      throw new SafeError(
        'handoff-project-identity-drift',
        'Project identity changed after android-build.json was created.',
      );
    }
    if (document.artifact.path !== preflight.wrap.artifactPath) {
      throw new SafeError('handoff-artifact-path-drift', 'APK path differs from the validated Wrap output path.');
    }
    if (document.app.package !== document.firebase.package) {
      throw new SafeError('handoff-firebase-package-drift', 'APK and Firebase Android package identities differ.');
    }
    const finalPreflight = validateProject(root);
    if (
      !declaredInputSnapshotsEqual(document.inputs, finalPreflight.inputs)
      || !declaredInputSnapshotsEqual(preflight.inputs, finalPreflight.inputs)
    ) {
      throw new SafeError(
        'handoff-declared-input-race',
        'Declared Android app/push inputs changed during handoff validation.',
      );
    }
    assertArtifactUnchanged('final Android handoff validation');

    const result = {
      schemaVersion: 1,
      status: 'valid',
      platform: 'android',
      purpose: document.purpose,
      artifact: {
        path: document.artifact.path,
        sha256: document.artifact.sha256,
        sizeBytes: document.artifact.sizeBytes,
      },
      app: {
        package: metadata.package,
        versionName: metadata.versionName,
        versionCode: metadata.versionCode,
        minSdkVersion: metadata.minSdkVersion,
        targetSdkVersion: metadata.targetSdkVersion,
      },
      firebase: {
        projectId: packagedFirebase.projectId,
        androidAppId: packagedFirebase.androidAppId,
      },
      signing: {
        certificateSha256: signing.certificateSha256,
        verified: true,
      },
      timestamps: document.timestamps,
      inputs: {
        digest: document.inputs.digest,
        fileCount: document.inputs.fileCount,
        totalBytes: document.inputs.totalBytes,
      },
    };
    Object.defineProperty(result, VALIDATED_ARTIFACT, {
      value: { root, path: artifactPath, identity: artifactIdentity },
    });
    return result;
  } finally {
    fs.rmSync(verificationSnapshot.path, { force: true });
  }
}

function usage() {
  return [
    'Usage: node validate-android-build-handoff.js --project-root <path>',
    '  --expected-signer-sha256 <64-hex>',
    '  [--file android-build.json] [--max-age-hours <0-24>]',
    '  [--apksigner <path>] [--aapt <path>] [--unzip <path>]',
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
    const output = `${JSON.stringify(result, null, 2)}\n`;
    const artifact = result[VALIDATED_ARTIFACT];
    assertStableFileIdentity(
      artifact.root,
      artifact.path,
      artifact.identity,
      'valid handoff output emission',
      'Android APK',
    );
    process.stdout.write(output);
    return 0;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('android-handoff-validation-failed', 'Unable to validate android-build.json.');
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
  main,
  parseArgs,
  parseTimestamp,
  validateDocumentShape,
  validateHandoff,
};
