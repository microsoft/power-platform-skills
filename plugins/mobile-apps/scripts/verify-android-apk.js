#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  SafeError,
  assertAndroidInputProof,
  assertNoSymlinkComponents,
  assertStableFileIdentity,
  captureStableFileIdentity,
  createStableFileSnapshot,
  declaredInputSnapshotsEqual,
  isWithinRoot,
  resolveProjectFile,
  resolveProjectRoot,
  toProjectPath,
  validateDeclaredInputsSnapshot,
  validateProject,
} = require('./validate-android-wrap-build');

const MAX_PROOF_AGE_MS = 24 * 60 * 60 * 1000;
const SHA256 = /^(?:sha256:)?([0-9a-f]{64})$/i;

function issue(code, message) {
  return { code, message };
}

function parseArgs(argv, cwd = process.cwd()) {
  const result = {
    projectRoot: cwd,
    buildStart: '.tmp/android-build-start',
    inputSnapshot: '.tmp/android-build-inputs.json',
    expectedSignerSha256: null,
    apksigner: null,
    aapt: null,
    unzip: null,
    help: false,
  };
  const names = {
    '--project-root': 'projectRoot',
    '--build-start': 'buildStart',
    '--input-snapshot': 'inputSnapshot',
    '--expected-signer-sha256': 'expectedSignerSha256',
    '--apksigner': 'apksigner',
    '--aapt': 'aapt',
    '--unzip': 'unzip',
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
  if (!result.help && !result.expectedSignerSha256) {
    throw new SafeError(
      'expected-signer-required',
      '--expected-signer-sha256 is required and must come from the customer-managed signing identity.',
    );
  }
  return result;
}

function normalizeSha256(value, label) {
  const match = String(value || '').trim().match(SHA256);
  if (!match) throw new SafeError('sha256-invalid', `${label} must be a 64-character SHA-256 fingerprint.`);
  return `sha256:${match[1].toLowerCase()}`;
}

function executableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function pathCandidates(command, env = process.env) {
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32'
    ? ['', '.exe', '.bat', '.cmd']
    : [''];
  const candidates = [];
  for (const directory of String(env.PATH || '').split(separator).filter(Boolean)) {
    for (const extension of extensions) candidates.push(path.join(directory, `${command}${extension}`));
  }
  return candidates;
}

function sdkBuildToolCandidates(command, env = process.env) {
  const sdkRoot = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (!sdkRoot) return [];
  const buildTools = path.join(sdkRoot, 'build-tools');
  let versions;
  try {
    versions = fs.readdirSync(buildTools, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return [];
  }
  const names = process.platform === 'win32'
    ? [`${command}.bat`, `${command}.exe`, command]
    : [command];
  return versions.flatMap((version) => names.map((name) => path.join(buildTools, version, name)));
}

function resolveTool(command, explicitPath, options = {}) {
  const env = options.env || process.env;
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [...sdkBuildToolCandidates(command, env), ...pathCandidates(command, env)];
  const found = candidates.find(executableFile);
  if (!found) {
    const hint = command === 'unzip'
      ? 'install unzip and ensure it is on PATH'
      : 'install Android SDK Build-Tools';
    throw new SafeError(
      'android-sdk-tool-missing',
      `${command} is required; ${hint} or provide --${command} <path>.`,
    );
  }
  return fs.realpathSync(found);
}

function assertVerificationTools(root, apksigner, aapt, unzip) {
  for (const toolPath of [apksigner, aapt, unzip]) {
    if (isWithinRoot(toolPath, root)) {
      throw new SafeError(
        'verification-tool-inside-project',
        'Android verification tools must not resolve inside the untrusted app project.',
      );
    }
  }
  if (
    !apksigner.split(path.sep).includes('build-tools')
    || !aapt.split(path.sep).includes('build-tools')
    || path.dirname(apksigner) !== path.dirname(aapt)
  ) {
    throw new SafeError(
      'android-sdk-tool-invalid',
      'apksigner and aapt must come from the same Android SDK Build-Tools directory.',
    );
  }
}

function runTool(toolPath, args, code, options = {}) {
  const result = (options.spawnSync || spawnSync)(toolPath, args, {
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env || process.env,
  });
  if (result.error || result.status !== 0) {
    // Tool output can contain certificate subjects, file-system paths, or
    // command lines. Return only a stable category rather than echoing it.
    const messages = {
      'apk-signature-invalid': 'APK signature verification failed.',
      'apk-metadata-read-failed': 'APK package metadata could not be read.',
      'apk-icon-read-failed': 'Packaged APK icon could not be read.',
    };
    throw new SafeError(code, messages[code] || 'Android APK tool verification failed.');
  }
  return result.stdout;
}

function parseApksignerOutput(source) {
  const certificateDigests = [...String(source).matchAll(
    /Signer #\d+ certificate SHA-256 digest:\s*([0-9A-Fa-f:]{64,95})/g,
  )].map((match) => normalizeSha256(match[1].replaceAll(':', ''), 'Signer certificate'));
  const uniqueDigests = [...new Set(certificateDigests)];
  if (uniqueDigests.length !== 1) {
    throw new SafeError(
      'apk-signer-identity-ambiguous',
      'APK must expose exactly one signer certificate SHA-256 fingerprint.',
    );
  }

  const schemes = {};
  for (const match of String(source).matchAll(
    /Verified using v(\d+) scheme(?:\s*\([^)]*\))?:\s*(true|false)/gi,
  )) {
    schemes[`v${match[1]}`] = match[2].toLowerCase() === 'true';
  }
  if (!Object.values(schemes).some(Boolean)) {
    throw new SafeError('apk-signature-unverified', 'APK has no verified Android signature scheme.');
  }
  if (!Object.entries(schemes).some(([name, verified]) => (
    verified && Number(name.slice(1)) >= 2
  ))) {
    // APK Signature Scheme v2+ covers the complete ZIP byte layout. V1/JAR
    // signatures can leave added entries unsigned, so they cannot prove that
    // the embedded source digest existed before the final customer signature.
    throw new SafeError(
      'apk-whole-file-signature-required',
      'APK must verify with APK Signature Scheme v2 or newer.',
    );
  }
  return { certificateSha256: uniqueDigests[0], schemes };
}

function decodeAaptQuoted(value) {
  return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function parseAaptBadging(source) {
  const packageLine = String(source).split(/\r?\n/).find((line) => line.startsWith('package:'));
  const packageMatch = packageLine?.match(
    /name='((?:\\'|[^'])*)'\s+versionCode='((?:\\'|[^'])*)'\s+versionName='((?:\\'|[^'])*)'/,
  );
  if (!packageMatch) {
    throw new SafeError('apk-package-metadata-invalid', 'APK package/version metadata is missing.');
  }

  const lines = String(source).split(/\r?\n/);
  const labelLine = lines.find((line) => line.startsWith('application-label:'));
  const labelMatch = labelLine?.match(/^application-label:'((?:\\'|[^'])*)'$/);
  if (!labelMatch) {
    throw new SafeError('apk-label-metadata-invalid', 'APK application label metadata is missing.');
  }
  const minSdkMatches = lines.flatMap((line) => {
    const match = line.match(/^(?:sdkVersion|minSdkVersion):'(\d+)'$/);
    return match ? [Number(match[1])] : [];
  });
  const targetSdkMatches = lines.flatMap((line) => {
    const match = line.match(/^targetSdkVersion:'(\d+)'$/);
    return match ? [Number(match[1])] : [];
  });
  if (
    minSdkMatches.length !== 1
    || targetSdkMatches.length !== 1
    || !Number.isSafeInteger(minSdkMatches[0])
    || !Number.isSafeInteger(targetSdkMatches[0])
    || minSdkMatches[0] < 1
    || targetSdkMatches[0] < minSdkMatches[0]
  ) {
    throw new SafeError(
      'apk-sdk-metadata-invalid',
      'APK minSdkVersion/targetSdkVersion metadata is missing or invalid.',
    );
  }

  const icons = new Set();
  for (const line of lines) {
    const densityIcon = line.match(/^application-icon-\d+:'([^']+)'$/);
    if (densityIcon) icons.add(densityIcon[1]);
    const applicationIcon = line.match(/^application:\s+.*\bicon='([^']+)'/);
    if (applicationIcon) icons.add(applicationIcon[1]);
  }
  const safeIcons = [...icons].filter((icon) => (
    icon.startsWith('res/')
    && !icon.includes('..')
    && !path.posix.isAbsolute(icon)
  )).sort();
  if (safeIcons.length < 1) {
    throw new SafeError('apk-icon-metadata-invalid', 'APK does not expose a packaged application icon.');
  }

  const versionCode = Number(packageMatch[2]);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new SafeError('apk-version-code-invalid', 'APK versionCode is invalid.');
  }
  return {
    package: decodeAaptQuoted(packageMatch[1]),
    versionCode,
    versionName: decodeAaptQuoted(packageMatch[3]),
    displayName: decodeAaptQuoted(labelMatch[1]),
    minSdkVersion: minSdkMatches[0],
    targetSdkVersion: targetSdkMatches[0],
    packagedIconResource: safeIcons[0],
  };
}

function parseAaptResourceStrings(source) {
  const expected = new Set(['google_app_id', 'project_id']);
  const values = new Map();
  let active = null;
  for (const line of String(source).split(/\r?\n/)) {
    const resource = line.match(/\bstring\/(google_app_id|project_id)\b/);
    if (resource) {
      active = resource[1];
    } else if (/\b(?:spec )?resource\b/.test(line)) active = null;
    if (!active) continue;
    const value = line.match(/\(string8?\)\s+"([^"]+)"/)
      || line.match(/\bt=0x03\b.*?\s+"([^"]+)"\s*$/);
    if (!value) continue;
    if (!values.has(active)) values.set(active, new Set());
    values.get(active).add(value[1]);
    active = null;
  }

  const result = {};
  for (const name of expected) {
    const candidates = values.get(name);
    if (!candidates || candidates.size !== 1) {
      throw new SafeError(
        'apk-firebase-resource-invalid',
        `APK must contain exactly one ${name} Firebase resource value.`,
      );
    }
    [result[name]] = candidates;
  }
  return {
    androidAppId: result.google_app_id,
    projectId: result.project_id,
  };
}

function sha256Buffer(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function resolveBuildMarker(root, relativePath) {
  return resolveProjectFile(root, relativePath, 'Android build-start marker');
}

function readInputSnapshot(root, relativePath) {
  const snapshotPath = resolveProjectFile(
    root,
    relativePath,
    'Android declared-input snapshot',
    { extension: '.json' },
  );
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    throw new SafeError(
      'input-snapshot-json-invalid',
      'Android declared-input snapshot must contain valid JSON.',
    );
  }
  return {
    path: snapshotPath,
    stat: fs.statSync(snapshotPath),
    snapshot: validateDeclaredInputsSnapshot(snapshot),
  };
}

function resolveArtifact(root, preflight) {
  const requested = path.resolve(root, preflight.wrap.artifactPath);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('apk-path-escape', 'Expected APK path escapes the project root.');
  }
  assertNoSymlinkComponents(root, requested);
  const stat = fs.statSync(requested);
  if (!stat.isFile() || path.extname(requested).toLowerCase() !== '.apk') {
    throw new SafeError('apk-not-regular', 'Expected Android artifact must be a regular .apk file.');
  }
  if (stat.size < 1) throw new SafeError('apk-empty', 'Expected Android APK is empty.');
  const artifactPath = fs.realpathSync(requested);
  return {
    path: artifactPath,
    identity: captureStableFileIdentity(root, artifactPath, 'Android APK'),
  };
}

function resolveHandoffPath(root) {
  const requested = path.join(root, 'android-build.json');
  assertNoSymlinkComponents(root, requested, { allowMissingLeaf: true });
  if (fs.existsSync(requested)) {
    const stat = fs.lstatSync(requested);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SafeError(
        'handoff-path-unsafe',
        'android-build.json must be a regular, non-symlink file.',
      );
    }
  }
  return requested;
}

function verifyApk(args, options = {}) {
  const root = resolveProjectRoot(args.projectRoot);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new SafeError('time-invalid', 'Verification time is invalid.');
  const expectedSigner = normalizeSha256(
    args.expectedSignerSha256,
    'Expected signer certificate',
  );
  const preflight = validateProject(root);
  const recordedInputs = readInputSnapshot(
    root,
    args.inputSnapshot || '.tmp/android-build-inputs.json',
  );
  if (!declaredInputSnapshotsEqual(recordedInputs.snapshot, preflight.inputs)) {
    throw new SafeError(
      'declared-inputs-changed-before-verification',
      'Declared Android app/push inputs changed after the build snapshot was recorded.',
    );
  }
  const markerPath = resolveBuildMarker(root, args.buildStart || '.tmp/android-build-start');
  const markerStat = fs.statSync(markerPath);
  if (recordedInputs.stat.mtimeMs > markerStat.mtimeMs + 1000) {
    throw new SafeError(
      'input-snapshot-after-build-start',
      'Declared Android input snapshot must be recorded before the build-start marker.',
    );
  }
  if (markerStat.mtimeMs - recordedInputs.stat.mtimeMs > MAX_PROOF_AGE_MS) {
    throw new SafeError(
      'input-snapshot-stale-at-build',
      'Declared Android input snapshot is more than 24 hours older than the build-start marker.',
    );
  }
  const artifact = resolveArtifact(root, preflight);
  const artifactModifiedMs = Number(BigInt(artifact.identity.modifiedAtNs) / 1000000n);
  if (artifactModifiedMs + 1000 < markerStat.mtimeMs) {
    throw new SafeError('apk-not-fresh', 'APK was not created or updated after the Android build started.');
  }
  if (now.getTime() - markerStat.mtimeMs > MAX_PROOF_AGE_MS) {
    throw new SafeError('build-marker-stale', 'Android build-start proof is older than 24 hours.');
  }
  if (artifactModifiedMs > now.getTime() + 5 * 60 * 1000) {
    throw new SafeError('apk-time-invalid', 'APK modification time is unexpectedly in the future.');
  }

  const apksigner = resolveTool('apksigner', args.apksigner, options);
  const aapt = resolveTool('aapt', args.aapt, options);
  const unzip = resolveTool('unzip', args.unzip, options);
  assertVerificationTools(root, apksigner, aapt, unzip);
  const verificationSnapshot = createStableFileSnapshot(
    root,
    artifact.path,
    artifact.identity,
    'Android APK',
  );
  const assertArtifactUnchanged = (phase) => {
    assertStableFileIdentity(root, artifact.path, artifact.identity, phase, 'Android APK');
    assertStableFileIdentity(
      root,
      verificationSnapshot.path,
      verificationSnapshot.identity,
      phase,
      'Android APK verification snapshot',
    );
  };
  const handoffPath = resolveHandoffPath(root);
  let wroteHandoff = false;
  try {
    const signingOutput = runTool(
      apksigner,
      ['verify', '--verbose', '--print-certs', verificationSnapshot.path],
      'apk-signature-invalid',
      options,
    );
    assertArtifactUnchanged('APK signature verification');
    const signing = parseApksignerOutput(signingOutput);
    if (signing.certificateSha256 !== expectedSigner) {
      throw new SafeError(
        'apk-signer-mismatch',
        'APK signer certificate fingerprint differs from the expected customer-managed identity.',
      );
    }

    assertAndroidInputProof(verificationSnapshot.path, recordedInputs.snapshot.digest, {
      requireSigningBlock: true,
    });
    assertArtifactUnchanged('embedded input-proof validation');

    const metadataOutput = runTool(
      aapt,
      ['dump', 'badging', verificationSnapshot.path],
      'apk-metadata-read-failed',
      options,
    );
    assertArtifactUnchanged('APK package metadata validation');
    const metadata = parseAaptBadging(metadataOutput);

    const firebaseOutput = runTool(
      aapt,
      ['dump', 'resources', verificationSnapshot.path],
      'apk-metadata-read-failed',
      options,
    );
    assertArtifactUnchanged('APK Firebase resource validation');
    const firebase = parseAaptResourceStrings(firebaseOutput);
    if (
      metadata.package !== preflight.app.package
      || metadata.versionName !== preflight.app.versionName
      || metadata.versionCode !== preflight.app.versionCode
      || metadata.displayName !== preflight.app.displayName
      || metadata.minSdkVersion > 26
    ) {
      throw new SafeError(
        'apk-app-identity-drift',
        'Produced APK package, version, display name, or Android 8 support differs from the validated project identity.',
      );
    }
    if (
      firebase.projectId !== preflight.firebase.projectId
      || firebase.androidAppId !== preflight.firebase.androidAppId
    ) {
      throw new SafeError(
        'apk-firebase-identity-drift',
        'Produced APK Firebase project or Android app identity differs from the validated project.',
      );
    }
    const packagedIcon = runTool(
      unzip,
      ['-p', verificationSnapshot.path, metadata.packagedIconResource],
      'apk-icon-read-failed',
      { ...options, encoding: null },
    );
    assertArtifactUnchanged('packaged icon validation');
    if (!Buffer.isBuffer(packagedIcon) || packagedIcon.length < 1) {
      throw new SafeError('apk-icon-read-failed', 'Packaged APK icon could not be read.');
    }
    const finalPreflight = validateProject(root);
    if (
      !declaredInputSnapshotsEqual(recordedInputs.snapshot, finalPreflight.inputs)
      || !declaredInputSnapshotsEqual(preflight.inputs, finalPreflight.inputs)
    ) {
      throw new SafeError(
        'declared-inputs-changed-during-verification',
        'Declared Android app/push inputs changed during APK verification.',
      );
    }
    assertArtifactUnchanged('final Android handoff creation');

    const verifiedAt = now.toISOString();
    const document = {
      schemaVersion: 1,
      platform: 'android',
      purpose: 'direct-physical-device-testing',
      status: 'verified',
      artifact: {
        path: toProjectPath(root, artifact.path),
        sha256: artifact.identity.sha256,
        sizeBytes: artifact.identity.sizeBytes,
        modifiedAt: artifact.identity.modifiedAt,
        modifiedAtNs: artifact.identity.modifiedAtNs,
        changedAtNs: artifact.identity.changedAtNs,
        device: artifact.identity.device,
        inode: artifact.identity.inode,
      },
      app: {
        package: metadata.package,
        displayName: metadata.displayName,
        versionName: metadata.versionName,
        versionCode: metadata.versionCode,
        minSdkVersion: metadata.minSdkVersion,
        targetSdkVersion: metadata.targetSdkVersion,
        sourceIconPath: preflight.app.iconPath,
        sourceIconSha256: preflight.app.iconSha256,
        packagedIconResource: metadata.packagedIconResource,
        packagedIconSha256: sha256Buffer(packagedIcon),
      },
      firebase: {
        projectId: firebase.projectId,
        androidAppId: firebase.androidAppId,
        package: preflight.firebase.package,
        clientConfigPath: preflight.firebase.clientConfigPath,
      },
      auth: {
        clientId: preflight.auth.clientId,
        tenantId: preflight.auth.tenantId,
      },
      signing: {
        verified: true,
        verificationTool: 'apksigner',
        certificateSha256: signing.certificateSha256,
        schemes: signing.schemes,
      },
      tooling: {
        metadataTool: 'aapt',
        wrapPackage: preflight.wrap.packageName,
        wrapVersion: preflight.wrap.packageVersion,
      },
      timestamps: {
        inputsCapturedAt: recordedInputs.stat.mtime.toISOString(),
        buildStartedAt: markerStat.mtime.toISOString(),
        verifiedAt,
        validUntil: new Date(now.getTime() + MAX_PROOF_AGE_MS).toISOString(),
      },
      inputs: recordedInputs.snapshot,
    };

    assertArtifactUnchanged('android-build.json write');
    fs.writeFileSync(handoffPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    wroteHandoff = true;
    assertArtifactUnchanged('android-build.json finalization');
    return document;
  } catch (error) {
    if (wroteHandoff) fs.rmSync(handoffPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(verificationSnapshot.path, { force: true });
  }
}

function usage() {
  return [
    'Usage: node verify-android-apk.js --project-root <path>',
    '  --expected-signer-sha256 <64-hex>',
    '  [--input-snapshot <project-relative-json>] [--build-start <project-relative-file>]',
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
    process.stdout.write(`${JSON.stringify(verifyApk(args), null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('android-apk-verification-failed', 'Unable to verify the Android APK.');
    process.stdout.write(`${JSON.stringify({
      status: 'blocked',
      issues: [issue(safe.code, safe.message)],
    }, null, 2)}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  MAX_PROOF_AGE_MS,
  assertVerificationTools,
  decodeAaptQuoted,
  main,
  normalizeSha256,
  parseAaptBadging,
  parseAaptResourceStrings,
  parseApksignerOutput,
  parseArgs,
  readInputSnapshot,
  resolveArtifact,
  resolveTool,
  runTool,
  sha256Buffer,
  verifyApk,
};
