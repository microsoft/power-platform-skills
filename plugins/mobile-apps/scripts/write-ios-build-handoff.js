#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parsePlistStrings } = require('./validate-firebase-client-config');
const {
  evaluateExpoConfig,
  isWithinRoot,
  resolveSafeOutputPath,
  validateWrapShape,
} = require('./validate-ios-wrap-build');

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_INPUT_FILES = 20000;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_HANDOFF_AGE_MS = 24 * 60 * 60 * 1000;
const INPUT_DIRECTORIES = ['app', 'src', 'firebase'];
const OPTIONAL_INPUT_DIRECTORIES = ['assets', 'brand'];
const REQUIRED_INPUT_FILES = [
  'app.config.js',
  'auth.config.json',
  'firebase.json',
  'package.json',
  'wrap.config.json',
];
// Keep this aligned with the root-level native configuration surfaces supported
// by the bundled app template. Optional files are included only when present so
// older installed templates remain valid while newer native config cannot evade
// the pre-build continuity snapshot.
const OPTIONAL_INPUT_FILES = [
  'app.json',
  'app.plugin.js',
  'app.plugin.cjs',
  'app.plugin.mjs',
  'app.plugin.ts',
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'babel.config.json',
  'eas.json',
  'fingerprint.config.js',
  'fingerprint.config.cjs',
  'fingerprint.config.mjs',
  'fingerprint.config.json',
  'metro.config.js',
  'metro.config.cjs',
  'metro.config.mjs',
  'native-runtime.json',
  'offline-profile.json',
  'power.config.json',
  'react-native.config.js',
  'react-native.config.cjs',
  'react-native.config.mjs',
  'tamagui.config.ts',
  'tamagui.config.tsx',
  'tamagui.config.js',
  'tamagui.config.cjs',
  'tamagui.config.mjs',
  'tsconfig.json',
];
const OPTIONAL_ROOT_INPUT_PATTERNS = [
  /^app\.plugin\.(?:cjs|js|mjs|ts)$/,
  /^babel\.config\.(?:cjs|js|json|mjs|ts)$/,
  /^fingerprint\.config\.(?:cjs|js|json|mjs|ts)$/,
  /^metro\.config\.(?:cjs|js|json|mjs|ts)$/,
  /^react-native\.config\.(?:cjs|js|mjs|ts)$/,
  /^tamagui\.config\.(?:cjs|js|mjs|ts|tsx)$/,
  /^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/,
];
const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
const WRAP_PACKAGE = '@microsoft/power-apps-native-host';
const MODES = {
  development: { exportMethod: 'development', apnsEnvironment: 'development' },
  'ad-hoc': { exportMethod: 'ad-hoc', apnsEnvironment: 'production' },
};

class SafeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function issue(code, message) {
  return { code, message };
}

function parseArgs(argv, cwd = process.cwd()) {
  const result = {
    projectRoot: cwd,
    file: 'ios-build.json',
    artifact: null,
    buildStart: null,
    writeInputSnapshot: null,
    inputSnapshot: null,
    mode: null,
    expectedTeamId: null,
    validHours: 24,
    help: false,
  };
  const names = {
    '--project-root': 'projectRoot',
    '--file': 'file',
    '--artifact': 'artifact',
    '--build-start': 'buildStart',
    '--write-input-snapshot': 'writeInputSnapshot',
    '--input-snapshot': 'inputSnapshot',
    '--mode': 'mode',
    '--expected-team-id': 'expectedTeamId',
    '--valid-hours': 'validHours',
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
  result.validHours = Number(result.validHours);
  if (!result.help) {
    if (result.writeInputSnapshot && result.inputSnapshot) {
      throw new SafeError(
        'input-snapshot-operation-conflict',
        '--write-input-snapshot and --input-snapshot are separate operations.',
      );
    }
    if (!result.writeInputSnapshot) {
      if (!result.inputSnapshot) {
        throw new SafeError(
          'input-snapshot-required',
          '--input-snapshot is required when writing ios-build.json.',
        );
      }
      if (!result.artifact) throw new SafeError('artifact-required', '--artifact is required.');
      if (!result.buildStart) throw new SafeError('build-start-required', '--build-start is required.');
    }
    if (!MODES[result.mode]) {
      throw new SafeError('mode-invalid', '--mode must be development or ad-hoc.');
    }
    if (!/^[A-Z0-9]{10}$/.test(result.expectedTeamId || '')) {
      throw new SafeError(
        'team-id-invalid',
        '--expected-team-id must be a 10-character Apple Team ID.',
      );
    }
    if (
      !Number.isFinite(result.validHours)
      || result.validHours <= 0
      || result.validHours > 24
    ) {
      throw new SafeError(
        'valid-hours-invalid',
        '--valid-hours must be greater than 0 and no more than 24.',
      );
    }
  }
  return result;
}

function resolveProjectRoot(projectRootArg) {
  const requested = path.resolve(projectRootArg);
  let stat;
  try {
    stat = fs.statSync(requested);
  } catch {
    throw new SafeError('project-root-not-found', 'Project root does not exist.');
  }
  if (!stat.isDirectory()) {
    throw new SafeError('project-root-not-directory', 'Project root must be a directory.');
  }
  return fs.realpathSync(requested);
}

function toProjectPath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/') || '.';
}

function assertSafeRelativePath(relativePath, label) {
  const normalized = typeof relativePath === 'string'
    ? relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
    : relativePath;
  if (
    typeof normalized !== 'string'
    || normalized.trim() === ''
    || path.posix.isAbsolute(normalized)
    || path.posix.normalize(normalized) !== normalized
    || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
    || /[\0\r\n]/.test(normalized)
  ) {
    throw new SafeError('project-path-invalid', `${label} must be a normalized project-relative path.`);
  }
}

function assertNoSymlinkComponents(root, requested, { allowMissingLeaf = false } = {}) {
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('project-path-escape', 'Project path must remain inside the project root.');
  }
  let current = root;
  const parts = path.relative(root, requested).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && error?.code === 'ENOENT') return;
      throw new SafeError('project-path-missing', 'Required project path does not exist.');
    }
    if (stat.isSymbolicLink()) {
      throw new SafeError('project-path-symlink', 'Project paths used by the iOS handoff must not contain symlinks.');
    }
  }
}

function resolveProjectFile(root, configuredPath, label, { extension } = {}) {
  assertSafeRelativePath(configuredPath, label);
  const requested = path.resolve(root, configuredPath);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('project-file-escape', `${label} escapes the project root.`);
  }
  assertNoSymlinkComponents(root, requested);
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SafeError('project-file-not-regular', `${label} must be a regular, non-symlink file.`);
  }
  const resolved = fs.realpathSync(requested);
  if (!isWithinRoot(resolved, root)) {
    throw new SafeError('project-file-escape', `${label} resolves outside the project root.`);
  }
  if (extension && path.extname(resolved).toLowerCase() !== extension) {
    throw new SafeError('project-file-extension', `${label} must be a ${extension} file.`);
  }
  return resolved;
}

function resolveOutputFile(root, configuredPath, label) {
  assertSafeRelativePath(configuredPath, label);
  const requested = path.resolve(root, configuredPath);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('output-file-escape', `${label} escapes the project root.`);
  }
  const parent = path.dirname(requested);
  assertNoSymlinkComponents(root, parent);
  if (fs.existsSync(requested)) {
    const stat = fs.lstatSync(requested);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SafeError('output-file-unsafe', `${label} must be a regular, non-symlink file.`);
    }
  }
  return requested;
}

function optionalProjectInput(root, relativePath) {
  const requested = path.resolve(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(requested);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SafeError(
      'optional-input-invalid',
      `Optional iOS build input must be a regular, non-symlink file: ${relativePath}.`,
    );
  }
  return toProjectPath(
    root,
    resolveProjectFile(root, relativePath, `optional iOS build input ${relativePath}`),
  );
}

function readJson(root, relativePath, label) {
  const filePath = resolveProjectFile(root, relativePath, label, { extension: '.json' });
  if (fs.statSync(filePath).size > MAX_JSON_BYTES) {
    throw new SafeError('json-too-large', `${label} exceeds the supported size.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new SafeError('json-invalid', `${label} must contain valid JSON.`);
  }
}

function sha256File(filePath) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function sameStat(left, right) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function captureStableFile(root, configuredPath, label, { extension } = {}) {
  const filePath = resolveProjectFile(root, configuredPath, label, { extension });
  const before = fs.statSync(filePath, { bigint: true });
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SafeError('file-too-large', `${label} exceeds the supported size.`);
  }
  const sha256 = sha256File(filePath);
  const after = fs.statSync(filePath, { bigint: true });
  if (!sameStat(before, after)) {
    throw new SafeError('file-changed-during-capture', `${label} changed while it was hashed.`);
  }
  return {
    path: toProjectPath(root, filePath),
    sha256,
    sizeBytes: Number(after.size),
    modifiedAt: new Date(Number(after.mtimeNs / 1000000n)).toISOString(),
    modifiedAtNs: after.mtimeNs,
    changedAtNs: after.ctimeNs,
    device: after.dev,
    inode: after.ino,
  };
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function collectDirectoryFiles(root, relativeDirectory, paths) {
  const requested = path.resolve(root, relativeDirectory);
  if (!fs.existsSync(requested)) return;
  assertNoSymlinkComponents(root, requested);
  if (!fs.statSync(requested).isDirectory()) {
    throw new SafeError(
      'input-directory-invalid',
      `${relativeDirectory}/ must be a regular project directory.`,
    );
  }
  const pending = [requested];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toProjectPath(root, absolute);
      assertSafeRelativePath(relative, 'Declared iOS build input');
      if (entry.isSymbolicLink()) {
        throw new SafeError(
          'input-symlink',
          `Declared iOS build input must not be a symlink: ${relative}.`,
        );
      }
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) paths.add(relative);
      else {
        throw new SafeError(
          'input-not-regular',
          `Declared iOS build input must be a regular file: ${relative}.`,
        );
      }
    }
  }
}

function collectInputPaths(root, additionalPaths = []) {
  const paths = new Set();
  for (const directory of INPUT_DIRECTORIES) collectDirectoryFiles(root, directory, paths);
  for (const directory of OPTIONAL_INPUT_DIRECTORIES) {
    collectDirectoryFiles(root, directory, paths);
  }
  for (const relativePath of REQUIRED_INPUT_FILES) {
    paths.add(toProjectPath(root, resolveProjectFile(root, relativePath, relativePath)));
  }
  for (const relativePath of OPTIONAL_INPUT_FILES) {
    const resolved = optionalProjectInput(root, relativePath);
    if (resolved) paths.add(resolved);
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!OPTIONAL_ROOT_INPUT_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new SafeError(
        'optional-input-invalid',
        `Optional iOS root config must be a regular, non-symlink file: ${entry.name}.`,
      );
    }
    paths.add(toProjectPath(
      root,
      resolveProjectFile(root, entry.name, `optional iOS root config ${entry.name}`),
    ));
  }
  for (const relativePath of additionalPaths) {
    paths.add(toProjectPath(
      root,
      resolveProjectFile(root, relativePath, `referenced iOS build input ${relativePath}`),
    ));
  }
  const lockfiles = LOCKFILES.filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
  if (lockfiles.length !== 1) {
    throw new SafeError(
      'lockfile-count-invalid',
      'Exactly one supported project lockfile is required for iOS source continuity.',
    );
  }
  paths.add(toProjectPath(root, resolveProjectFile(root, lockfiles[0], lockfiles[0])));
  const sorted = [...paths].sort(comparePaths);
  if (sorted.length > MAX_INPUT_FILES) {
    throw new SafeError('input-file-limit', `Declared iOS build inputs exceed ${MAX_INPUT_FILES} files.`);
  }
  return sorted;
}

function declaredInputDigest(files) {
  const hash = crypto.createHash('sha256');
  hash.update('ios-declared-inputs-v1\0');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.sizeBytes));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

function validateInputSnapshot(snapshot) {
  const keys = ['algorithm', 'digest', 'fileCount', 'files', 'schemaVersion', 'totalBytes'];
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || Object.keys(snapshot).sort().join('\0') !== keys.sort().join('\0')
  ) {
    throw new SafeError(
      'input-snapshot-fields-invalid',
      'Declared iOS build inputs must use the strict snapshot schema.',
    );
  }
  if (
    snapshot.schemaVersion !== 1
    || snapshot.algorithm !== 'sha256'
    || !/^sha256:[0-9a-f]{64}$/.test(snapshot.digest || '')
    || !Number.isSafeInteger(snapshot.fileCount)
    || snapshot.fileCount < 1
    || snapshot.fileCount > MAX_INPUT_FILES
    || !Number.isSafeInteger(snapshot.totalBytes)
    || snapshot.totalBytes < 1
    || snapshot.totalBytes > MAX_INPUT_BYTES
    || !Array.isArray(snapshot.files)
    || snapshot.files.length !== snapshot.fileCount
  ) {
    throw new SafeError(
      'input-snapshot-invalid',
      'Declared iOS build input snapshot metadata is invalid.',
    );
  }
  let totalBytes = 0;
  let previousPath = null;
  for (const file of snapshot.files) {
    if (
      !file
      || typeof file !== 'object'
      || Array.isArray(file)
      || Object.keys(file).sort().join('\0') !== 'path\0sha256\0sizeBytes'
    ) {
      throw new SafeError(
        'input-file-invalid',
        'Declared iOS build inputs must use the strict path/sizeBytes/sha256 schema.',
      );
    }
    assertSafeRelativePath(file.path, 'Declared iOS build input');
    if (previousPath !== null && comparePaths(previousPath, file.path) >= 0) {
      throw new SafeError(
        'input-order-invalid',
        'Declared iOS build input paths must be unique and sorted.',
      );
    }
    if (
      !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
      || !/^sha256:[0-9a-f]{64}$/.test(file.sha256 || '')
    ) {
      throw new SafeError('input-file-invalid', 'Declared iOS build input size or SHA-256 is invalid.');
    }
    totalBytes += file.sizeBytes;
    previousPath = file.path;
  }
  if (
    totalBytes !== snapshot.totalBytes
    || declaredInputDigest(snapshot.files) !== snapshot.digest
  ) {
    throw new SafeError(
      'input-digest-invalid',
      'Declared iOS build input digest does not match its sorted file snapshot.',
    );
  }
  return snapshot;
}

function computeInputSnapshot(root, additionalPaths = []) {
  const paths = collectInputPaths(root, additionalPaths);
  const files = [];
  let totalBytes = 0;
  for (const relativePath of paths) {
    const identity = captureStableFile(root, relativePath, `declared input ${relativePath}`);
    totalBytes += identity.sizeBytes;
    if (totalBytes > MAX_INPUT_BYTES) {
      throw new SafeError(
        'input-byte-limit',
        `Declared iOS build inputs exceed ${MAX_INPUT_BYTES} bytes.`,
      );
    }
    files.push({
      path: identity.path,
      sizeBytes: identity.sizeBytes,
      sha256: identity.sha256,
    });
  }
  const confirmedPaths = collectInputPaths(root, additionalPaths);
  if (
    paths.length !== confirmedPaths.length
    || paths.some((relativePath, index) => relativePath !== confirmedPaths[index])
  ) {
    throw new SafeError(
      'input-set-changed-during-capture',
      'Declared iOS build input files changed during snapshot capture.',
    );
  }
  return validateInputSnapshot({
    schemaVersion: 1,
    algorithm: 'sha256',
    digest: declaredInputDigest(files),
    fileCount: files.length,
    totalBytes,
    files,
  });
}

function inputSnapshotsEqual(left, right) {
  validateInputSnapshot(left);
  validateInputSnapshot(right);
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePreBuildSnapshot(document) {
  const keys = [
    'appleTeamId',
    'capturedAt',
    'inputs',
    'mode',
    'platform',
    'purpose',
    'schemaVersion',
  ];
  if (
    !document
    || typeof document !== 'object'
    || Array.isArray(document)
    || Object.keys(document).sort().join('\0') !== keys.join('\0')
  ) {
    throw new SafeError(
      'pre-build-snapshot-fields-invalid',
      'The iOS pre-build snapshot must use the strict non-secret schema.',
    );
  }
  if (
    document.schemaVersion !== 1
    || document.platform !== 'ios'
    || document.purpose !== 'pre-build-declared-input-continuity'
    || !MODES[document.mode]
    || !/^[A-Z0-9]{10}$/.test(document.appleTeamId || '')
  ) {
    throw new SafeError(
      'pre-build-snapshot-invalid',
      'The iOS pre-build snapshot identity is invalid.',
    );
  }
  const capturedAt = Date.parse(document.capturedAt);
  if (
    !Number.isFinite(capturedAt)
    || new Date(capturedAt).toISOString() !== document.capturedAt
  ) {
    throw new SafeError(
      'pre-build-snapshot-time-invalid',
      'The iOS pre-build snapshot capturedAt value must be a canonical ISO timestamp.',
    );
  }
  validateInputSnapshot(document.inputs);
  return document;
}

function readPreBuildSnapshot(root, configuredPath) {
  const snapshotFile = captureStableFile(
    root,
    configuredPath,
    'iOS pre-build input snapshot',
    { extension: '.json' },
  );
  const snapshotPath = path.resolve(root, snapshotFile.path);
  if (fs.statSync(snapshotPath).size > MAX_JSON_BYTES) {
    throw new SafeError(
      'pre-build-snapshot-too-large',
      'The iOS pre-build input snapshot exceeds the supported size.',
    );
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    throw new SafeError(
      'pre-build-snapshot-json-invalid',
      'The iOS pre-build input snapshot must contain valid JSON.',
    );
  }
  const confirmedFile = captureStableFile(
    root,
    configuredPath,
    'iOS pre-build input snapshot',
    { extension: '.json' },
  );
  if (
    confirmedFile.sha256 !== snapshotFile.sha256
    || confirmedFile.sizeBytes !== snapshotFile.sizeBytes
    || confirmedFile.modifiedAt !== snapshotFile.modifiedAt
  ) {
    throw new SafeError(
      'pre-build-snapshot-changed-during-read',
      'The iOS pre-build input snapshot changed while it was read.',
    );
  }
  return {
    path: snapshotPath,
    file: snapshotFile,
    document: validatePreBuildSnapshot(document),
  };
}

function readInstalledWrap(root) {
  let packagePath;
  try {
    packagePath = require.resolve(`${WRAP_PACKAGE}/package.json`, { paths: [root] });
  } catch {
    throw new SafeError(
      'wrap-package-missing',
      `${WRAP_PACKAGE} must be installed before writing ios-build.json.`,
    );
  }
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    throw new SafeError('wrap-package-invalid', 'The installed Wrap package metadata is invalid.');
  }
  if (
    packageJson.name !== WRAP_PACKAGE
    || typeof packageJson.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version)
  ) {
    throw new SafeError('wrap-package-invalid', 'The installed Wrap package identity is invalid.');
  }
  return { wrapPackage: packageJson.name, wrapVersion: packageJson.version };
}

function readProjectIdentity(root, mode, expectedTeamId) {
  const pairing = MODES[mode];
  if (!pairing) throw new SafeError('mode-invalid', 'iOS mode must be development or ad-hoc.');
  const packageJson = readJson(root, 'package.json', 'package.json');
  if (packageJson.scripts?.['build:ios'] !== 'wrap ios') {
    throw new SafeError('build-script-invalid', 'package.json build:ios must equal wrap ios.');
  }
  const wrap = readJson(root, 'wrap.config.json', 'wrap.config.json');
  try {
    validateWrapShape(wrap, mode, expectedTeamId);
  } catch (error) {
    throw new SafeError('wrap-config-invalid', error.message);
  }
  const auth = readJson(root, 'auth.config.json', 'auth.config.json');
  if (auth.msal?.clientId !== wrap.msal.clientId || auth.msal?.tenantId !== wrap.msal.tenantId) {
    throw new SafeError('auth-identity-drift', 'wrap.config.json MSAL identity differs from auth.config.json.');
  }
  let expo;
  try {
    expo = evaluateExpoConfig(root, wrap, mode);
  } catch (error) {
    throw new SafeError('expo-config-invalid', error.message);
  }
  if (
    expo.name !== wrap.displayName
    || expo.version !== wrap.version
    || expo.icon !== wrap.iconPath
    || expo.ios?.bundleIdentifier !== wrap.bundleIdentifier
    || expo.ios?.entitlements?.['aps-environment'] !== pairing.apnsEnvironment
  ) {
    throw new SafeError(
      'project-identity-drift',
      'Evaluated Expo identity differs from the validated iOS Wrap identity.',
    );
  }
  const plistPath = resolveProjectFile(
    root,
    expo.ios?.googleServicesFile,
    'evaluated iOS Firebase plist',
  );
  const plist = parsePlistStrings(fs.readFileSync(plistPath));
  if (
    typeof plist.projectId !== 'string'
    || typeof plist.appId !== 'string'
    || typeof plist.identifier !== 'string'
  ) {
    throw new SafeError(
      'firebase-identity-missing',
      'Firebase plist must contain PROJECT_ID, GOOGLE_APP_ID, and BUNDLE_ID.',
    );
  }
  if (plist.identifier !== wrap.bundleIdentifier) {
    throw new SafeError(
      'firebase-bundle-drift',
      'Firebase plist bundle ID differs from the evaluated Expo/wrap identity.',
    );
  }
  const outputPath = resolveSafeOutputPath(root, wrap.outputPath || './dist');
  const referencedInputPaths = [
    toProjectPath(root, resolveProjectFile(root, wrap.iconPath, 'iOS app icon')),
    toProjectPath(root, plistPath),
  ];
  const entryPoint = packageJson.main;
  if (typeof entryPoint !== 'string' || entryPoint.trim() === '') {
    throw new SafeError(
      'entry-point-missing',
      'package.json main must declare the native entry point.',
    );
  }
  referencedInputPaths.push(
    toProjectPath(root, resolveProjectFile(root, entryPoint, 'package.json main entry point')),
  );
  collectExpoReferencedInputs(root, expo, referencedInputPaths);
  return {
    app: {
      bundleIdentifier: wrap.bundleIdentifier,
      displayName: wrap.displayName,
      version: wrap.version,
      versionCode: wrap.versionCode,
    },
    firebase: {
      projectId: plist.projectId,
      iosAppId: plist.appId,
      bundleIdentifier: plist.identifier,
      clientConfigPath: toProjectPath(root, plistPath),
    },
    auth: {
      clientId: wrap.msal.clientId,
      tenantId: wrap.msal.tenantId,
    },
    build: {
      mode,
      appleTeamId: wrap.ios.signing.teamId,
      exportMethod: pairing.exportMethod,
      apnsEnvironment: pairing.apnsEnvironment,
    },
    tooling: readInstalledWrap(root),
    declaredInputPaths: referencedInputPaths,
    outputPath,
  };
}

function collectExpoReferencedInputs(root, expo, paths) {
  const candidates = [
    ['Expo icon', expo.icon],
    ['Expo splash image', expo.splash?.image],
    ['Expo iOS splash image', expo.ios?.splash?.image],
    ['Expo notification icon', expo.notification?.icon],
  ];
  const iosIcon = expo.ios?.icon;
  if (typeof iosIcon === 'string') {
    candidates.push(['Expo iOS icon', iosIcon]);
  } else if (iosIcon && typeof iosIcon === 'object' && !Array.isArray(iosIcon)) {
    for (const [variant, configuredPath] of Object.entries(iosIcon)) {
      candidates.push([`Expo iOS icon ${variant}`, configuredPath]);
    }
  }
  for (const plugin of expo.plugins || []) {
    const configuredPlugin = Array.isArray(plugin) ? plugin[0] : plugin;
    if (
      typeof configuredPlugin === 'string'
      && (configuredPlugin.startsWith('./') || configuredPlugin.startsWith('../'))
    ) {
      candidates.push(['local Expo config plugin', configuredPlugin]);
    }
  }
  for (const [label, configuredPath] of candidates) {
    if (configuredPath === null || configuredPath === undefined) continue;
    if (typeof configuredPath !== 'string' || configuredPath.trim() === '') {
      throw new SafeError(
        'referenced-input-invalid',
        `${label} must be a project-relative file path when configured.`,
      );
    }
    paths.push(toProjectPath(root, resolveProjectFile(root, configuredPath, label)));
  }
  collectProjectFileReferences(root, expo, paths);
}

function collectProjectFileReferences(root, value, paths, seen = new Set()) {
  if (typeof value === 'string') {
    if (!value.startsWith('./') && !value.startsWith('../')) return;
    const requested = path.resolve(root, value);
    if (!isWithinRoot(requested, root)) {
      throw new SafeError(
        'referenced-input-escape',
        'Evaluated Expo config must not reference files outside the project root.',
      );
    }
    let stat;
    try {
      stat = fs.lstatSync(requested);
    } catch (error) {
      // Expo config may contain glob-like project-relative patterns. Known
      // required assets are validated above; unresolved generic references are
      // left for the owning Expo/Wrap validator rather than guessed here.
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new SafeError(
        'referenced-input-symlink',
        'Evaluated Expo config references must not use symlinked files.',
      );
    }
    if (stat.isFile()) {
      paths.push(toProjectPath(
        root,
        resolveProjectFile(root, value, 'evaluated Expo config file reference'),
      ));
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectProjectFileReferences(root, child, paths, seen);
    return;
  }
  for (const child of Object.values(value)) {
    collectProjectFileReferences(root, child, paths, seen);
  }
}

function writeJsonFile(filePath, document) {
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_TRUNC
    | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(filePath, flags, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function capturePreBuildSnapshot(args, options = {}) {
  const root = resolveProjectRoot(args.projectRoot);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new SafeError('time-invalid', 'Snapshot time is invalid.');
  const identity = readProjectIdentity(root, args.mode, args.expectedTeamId);
  const inputs = computeInputSnapshot(root, identity.declaredInputPaths);
  const finalIdentity = readProjectIdentity(root, args.mode, args.expectedTeamId);
  const finalInputs = computeInputSnapshot(root, finalIdentity.declaredInputPaths);
  if (
    JSON.stringify(identity) !== JSON.stringify(finalIdentity)
    || !inputSnapshotsEqual(inputs, finalInputs)
  ) {
    throw new SafeError(
      'project-changed-during-snapshot',
      'Safe iOS project identity or declared inputs changed during pre-build snapshot capture.',
    );
  }
  const document = validatePreBuildSnapshot({
    schemaVersion: 1,
    platform: 'ios',
    purpose: 'pre-build-declared-input-continuity',
    capturedAt: now.toISOString(),
    mode: args.mode,
    appleTeamId: args.expectedTeamId,
    inputs,
  });
  const outputPath = resolveOutputFile(
    root,
    args.writeInputSnapshot,
    'iOS pre-build input snapshot',
  );
  writeJsonFile(outputPath, document);
  return document;
}

function writeHandoff(args, options = {}) {
  const root = resolveProjectRoot(args.projectRoot);
  const now = options.now instanceof Date ? options.now : new Date();
  const validHours = args.validHours ?? 24;
  if (!Number.isFinite(now.getTime())) throw new SafeError('time-invalid', 'Generation time is invalid.');
  if (!Number.isFinite(validHours) || validHours <= 0 || validHours > 24) {
    throw new SafeError(
      'valid-hours-invalid',
      '--valid-hours must be greater than 0 and no more than 24.',
    );
  }
  const preBuild = readPreBuildSnapshot(root, args.inputSnapshot);
  if (
    preBuild.document.mode !== args.mode
    || preBuild.document.appleTeamId !== args.expectedTeamId
  ) {
    throw new SafeError(
      'pre-build-snapshot-identity-drift',
      'The iOS pre-build snapshot mode or Apple Team ID differs from this handoff.',
    );
  }
  const buildStart = captureStableFile(root, args.buildStart, 'iOS build-start marker');
  const capturedAt = Date.parse(preBuild.document.capturedAt);
  if (
    capturedAt > Date.parse(buildStart.modifiedAt) + 1000
    || preBuild.file.modifiedAtNs > buildStart.modifiedAtNs
  ) {
    throw new SafeError(
      'pre-build-snapshot-order-invalid',
      'The declared-input snapshot must be captured and preserved before the iOS build-start marker.',
    );
  }
  const identity = readProjectIdentity(root, args.mode, args.expectedTeamId);
  const currentInputs = computeInputSnapshot(root, identity.declaredInputPaths);
  if (!inputSnapshotsEqual(preBuild.document.inputs, currentInputs)) {
    throw new SafeError(
      'pre-build-input-drift',
      'Current iOS declared inputs differ from the snapshot captured before npm run build:ios.',
    );
  }
  const artifact = captureStableFile(root, args.artifact, 'iOS IPA', { extension: '.ipa' });
  if (artifact.sizeBytes < 1) {
    throw new SafeError('artifact-empty', 'iOS IPA must not be empty.');
  }
  const artifactPath = path.resolve(root, artifact.path);
  if (!isWithinRoot(artifactPath, identity.outputPath)) {
    throw new SafeError(
      'artifact-output-path-invalid',
      'iOS IPA must be inside the freshly validated Wrap outputPath.',
    );
  }
  if (artifact.modifiedAtNs < buildStart.modifiedAtNs) {
    throw new SafeError(
      'artifact-not-fresh',
      'iOS IPA was not created or modified after the current build-start marker.',
    );
  }
  const finalIdentity = readProjectIdentity(root, args.mode, args.expectedTeamId);
  const finalInputs = computeInputSnapshot(root, finalIdentity.declaredInputPaths);
  if (
    JSON.stringify(identity) !== JSON.stringify(finalIdentity)
    || !inputSnapshotsEqual(preBuild.document.inputs, finalInputs)
  ) {
    throw new SafeError(
      'project-changed-during-handoff',
      'Safe iOS project identity or declared inputs changed after the pre-build snapshot.',
    );
  }
  const confirmedArtifact = captureStableFile(root, args.artifact, 'iOS IPA', { extension: '.ipa' });
  if (
    confirmedArtifact.sha256 !== artifact.sha256
    || confirmedArtifact.sizeBytes !== artifact.sizeBytes
    || confirmedArtifact.modifiedAt !== artifact.modifiedAt
  ) {
    throw new SafeError('artifact-changed-during-handoff', 'iOS IPA changed while ios-build.json was generated.');
  }
  const generatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + validHours * 60 * 60 * 1000).toISOString();
  const document = {
    schemaVersion: 1,
    platform: 'ios',
    purpose: 'registered-physical-device-testing',
    status: 'ready',
    artifact: {
      path: artifact.path,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      modifiedAt: artifact.modifiedAt,
    },
    app: identity.app,
    firebase: identity.firebase,
    auth: identity.auth,
    build: identity.build,
    tooling: identity.tooling,
    timestamps: {
      inputsCapturedAt: preBuild.document.capturedAt,
      buildStartedAt: buildStart.modifiedAt,
      generatedAt,
      validUntil,
    },
    inputs: preBuild.document.inputs,
  };
  const outputPath = resolveOutputFile(root, args.file, 'ios-build.json');
  writeJsonFile(outputPath, document);
  return document;
}

function usage() {
  return [
    'Usage: node write-ios-build-handoff.js --project-root <path>',
    '  --mode <development|ad-hoc> --expected-team-id <APPLE_TEAM_ID>',
    '  --write-input-snapshot <project-relative.json>',
    'or:',
    '  --input-snapshot <project-relative.json>',
    '  --artifact <project-relative.ipa> --build-start <project-relative marker>',
    '  [--file ios-build.json] [--valid-hours <0-24>]',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (args.writeInputSnapshot) {
      const document = capturePreBuildSnapshot(args);
      process.stdout.write(`${JSON.stringify({
        status: 'captured',
        file: args.writeInputSnapshot,
        capturedAt: document.capturedAt,
        inputs: {
          digest: document.inputs.digest,
          fileCount: document.inputs.fileCount,
          totalBytes: document.inputs.totalBytes,
        },
      }, null, 2)}\n`);
      return 0;
    }
    const document = writeHandoff(args);
    process.stdout.write(`${JSON.stringify({
      status: 'written',
      file: args.file,
      artifact: document.artifact,
      validUntil: document.timestamps.validUntil,
      inputs: {
        digest: document.inputs.digest,
        fileCount: document.inputs.fileCount,
        totalBytes: document.inputs.totalBytes,
      },
      continuity: 'pre/post-build-project-inputs-and-fresh-artifact-identity',
      attestation:
        'no-signing-profile-certificate-entitlement-ipa-signature-or-embedded-input-digest-attestation',
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('ios-handoff-write-failed', 'Unable to write ios-build.json.');
    process.stdout.write(`${JSON.stringify({
      status: 'blocked',
      issues: [issue(safe.code, safe.message)],
    }, null, 2)}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  MAX_HANDOFF_AGE_MS,
  MODES,
  SafeError,
  assertSafeRelativePath,
  capturePreBuildSnapshot,
  captureStableFile,
  collectInputPaths,
  computeInputSnapshot,
  declaredInputDigest,
  inputSnapshotsEqual,
  isWithinRoot,
  main,
  parseArgs,
  readPreBuildSnapshot,
  readProjectIdentity,
  resolveProjectFile,
  resolveProjectRoot,
  toProjectPath,
  validateInputSnapshot,
  validatePreBuildSnapshot,
  writeHandoff,
};
