#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseAndroidClientIdentities,
} = require('./validate-firebase-client-config');

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ICON_BYTES = 25 * 1024 * 1024;
const MAX_DECLARED_INPUT_FILES = 20000;
const MAX_DECLARED_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_APK_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_APK_INPUT_PROOF_BYTES = 512;
const MIN_ANDROID_ICON_SIZE = 432;
const APK_INPUT_PROOF_PATH = 'assets/power-platform/android-build-input-proof.json';
const APK_SIGNING_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'ascii');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FIREBASE_ANDROID_APP_ID = /^\d+:\d+:android:[0-9A-Za-z]+$/;
const SIGNING_EXTENSIONS = new Set([
  '.cer',
  '.crt',
  '.der',
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
]);
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);
const DECLARED_INPUT_DIRECTORIES = ['app', 'src'];
const OPTIONAL_INPUT_DIRECTORIES = ['assets', 'brand'];
const REQUIRED_INPUT_FILES = [
  'app.config.js',
  'auth.config.json',
  'firebase.json',
  'package.json',
  'wrap.config.json',
];
const OPTIONAL_INPUT_FILES = [
  'app.json',
  'app.plugin.js',
  'babel.config.js',
  'fingerprint.config.js',
  'metro.config.js',
  'native-runtime.json',
  'offline-profile.json',
  'power.config.json',
  'tamagui.config.ts',
  'tsconfig.json',
];
const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
const FORBIDDEN_KEY =
  /credential|key.?alias|key.?password|keystore|password|private.?key|secret|store.?password|(?:^|[^a-z])token(?:$|[^a-z])|(?:access|auth|bearer|fcm|firebase|id|push|refresh)token$/i;

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
    writeInputSnapshot: null,
    inputSnapshot: null,
    embedInputProof: null,
    help: false,
  };
  const valueArgs = new Map([
    ['--project-root', 'projectRoot'],
    ['--write-input-snapshot', 'writeInputSnapshot'],
    ['--input-snapshot', 'inputSnapshot'],
    ['--embed-input-proof', 'embedInputProof'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (!valueArgs.has(arg)) {
      throw new SafeError('unknown-argument', `Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new SafeError('missing-argument-value', `${arg} requires a value.`);
    }
    result[valueArgs.get(arg)] = value;
    index += 1;
  }
  if (result.writeInputSnapshot && (result.inputSnapshot || result.embedInputProof)) {
    throw new SafeError(
      'input-proof-operation-conflict',
      'Recording the pre-build input snapshot and embedding the APK proof must be separate steps.',
    );
  }
  if (Boolean(result.inputSnapshot) !== Boolean(result.embedInputProof)) {
    throw new SafeError(
      'input-proof-arguments-incomplete',
      '--input-snapshot and --embed-input-proof must be provided together.',
    );
  }
  return result;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function toProjectPath(root, absolutePath) {
  const relative = path.relative(root, absolutePath).split(path.sep).join('/');
  return relative || '.';
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

function assertNoSymlinkComponents(root, requested, { allowMissingLeaf = false } = {}) {
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('path-outside-project', 'Path must remain inside the project root.');
  }
  let current = root;
  const parts = path.relative(root, requested).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && error?.code === 'ENOENT') return;
      throw new SafeError('path-not-found', 'Required project path does not exist.');
    }
    if (stat.isSymbolicLink()) {
      throw new SafeError('path-symbolic-link', 'Project paths used by the Android build must not contain symlinks.');
    }
  }
}

function resolveProjectFile(root, configuredPath, label, { extension } = {}) {
  if (typeof configuredPath !== 'string' || configuredPath.trim() === '' || path.isAbsolute(configuredPath)) {
    throw new SafeError('invalid-project-file', `${label} must be a non-empty project-relative path.`);
  }
  const requested = path.resolve(root, configuredPath);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('project-file-escape', `${label} must remain inside the project root.`);
  }
  assertNoSymlinkComponents(root, requested);
  const stat = fs.statSync(requested);
  if (!stat.isFile()) throw new SafeError('project-file-not-regular', `${label} must be a regular file.`);
  const resolved = fs.realpathSync(requested);
  if (!isWithinRoot(resolved, root)) {
    throw new SafeError('project-file-escape', `${label} resolves outside the project root.`);
  }
  if (extension && path.extname(resolved).toLowerCase() !== extension) {
    throw new SafeError('project-file-extension', `${label} must be a ${extension} file.`);
  }
  return resolved;
}

function resolveSafeOutputPath(root, configuredPath = './dist') {
  if (typeof configuredPath !== 'string' || configuredPath.trim() === '' || path.isAbsolute(configuredPath)) {
    throw new SafeError('invalid-output-path', 'outputPath must be a non-empty project-relative path.');
  }
  const requested = path.resolve(root, configuredPath);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('output-path-escape', 'outputPath must remain inside the project root.');
  }

  // A lexical project-relative path can still escape through `dist -> /outside`.
  // Walk every existing component and stop at the first missing directory so a
  // future nested output remains allowed without trusting a symlinked ancestor.
  assertNoSymlinkComponents(root, requested, { allowMissingLeaf: true });
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!isWithinRoot(fs.realpathSync(ancestor), root)) {
    throw new SafeError('output-path-escape', 'outputPath resolves outside the project root.');
  }
  if (fs.existsSync(requested) && !fs.statSync(requested).isDirectory()) {
    throw new SafeError('output-path-not-directory', 'outputPath must be a directory.');
  }
  return requested;
}

function resolveProjectOutputFile(root, configuredPath, label) {
  if (typeof configuredPath !== 'string' || configuredPath.trim() === '' || path.isAbsolute(configuredPath)) {
    throw new SafeError('invalid-output-file', `${label} must be a non-empty project-relative path.`);
  }
  const requested = path.resolve(root, configuredPath);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('output-file-escape', `${label} must remain inside the project root.`);
  }
  const parent = path.dirname(requested);
  assertNoSymlinkComponents(root, parent, { allowMissingLeaf: true });
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(root, parent);
  if (fs.existsSync(requested)) {
    const stat = fs.lstatSync(requested);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SafeError('output-file-unsafe', `${label} must be a regular, non-symlink file.`);
    }
  }
  return requested;
}

function readJsonFile(root, relativePath, label) {
  const filePath = resolveProjectFile(root, relativePath, label, { extension: '.json' });
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_JSON_BYTES) {
    throw new SafeError('json-file-too-large', `${label} exceeds the supported size.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new SafeError('invalid-json', `${label} must contain valid JSON.`);
  }
}

function assertDeclaredInputPath(relativePath) {
    if (
      typeof relativePath !== 'string'
      || relativePath === ''
      || path.posix.isAbsolute(relativePath)
      || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
      || /[\0\r\n]/.test(relativePath)
    ) {
      throw new SafeError(
        'declared-input-path-invalid',
        'Declared Android build input paths must be normalized project-relative paths.',
      );
    }

}

function compareDeclaredPaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

  function collectDirectoryInputs(root, relativeDirectory, output) {
    assertDeclaredInputPath(relativeDirectory);
    const directory = path.resolve(root, relativeDirectory);
    assertNoSymlinkComponents(root, directory);
    if (!fs.statSync(directory).isDirectory()) {
      throw new SafeError(
        'declared-input-directory-invalid',
        `${relativeDirectory}/ must be a regular project directory.`,
      );
    }
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const relative = toProjectPath(root, absolute);
        assertDeclaredInputPath(relative);
        if (entry.isSymbolicLink()) {
          throw new SafeError(
            'declared-input-symbolic-link',
            `Declared Android build input must not be a symlink: ${relative}.`,
          );
        }
        if (entry.isDirectory()) {
          pending.push(absolute);
        } else if (entry.isFile()) {
          output.add(relative);
        } else {
          throw new SafeError(
            'declared-input-not-regular',
            `Declared Android build input must be a regular file: ${relative}.`,
          );
        }
      }
    }
  }

  function optionalProjectInput(root, relativePath) {
    const requested = path.resolve(root, relativePath);
    try {
      fs.lstatSync(requested);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    return toProjectPath(root, resolveProjectFile(root, relativePath, relativePath));
  }

  function declaredInputDigest(files) {
    const hash = crypto.createHash('sha256');
    hash.update('android-declared-inputs-v1\0');
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

  function validateDeclaredInputsSnapshot(snapshot) {
    const topKeys = ['algorithm', 'digest', 'fileCount', 'files', 'schemaVersion', 'totalBytes'];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new SafeError('declared-input-snapshot-invalid', 'Declared Android build inputs must be a JSON object.');
    }
    if (Object.keys(snapshot).sort().join('\0') !== topKeys.sort().join('\0')) {
      throw new SafeError(
        'declared-input-snapshot-fields-invalid',
        'Declared Android build inputs contain unsupported fields.',
      );
    }
    if (
      snapshot.schemaVersion !== 1
      || snapshot.algorithm !== 'sha256'
      || !/^sha256:[0-9a-f]{64}$/.test(snapshot.digest || '')
      || !Number.isSafeInteger(snapshot.fileCount)
      || snapshot.fileCount < 1
      || snapshot.fileCount > MAX_DECLARED_INPUT_FILES
      || !Number.isSafeInteger(snapshot.totalBytes)
      || snapshot.totalBytes < 1
      || snapshot.totalBytes > MAX_DECLARED_INPUT_BYTES
      || !Array.isArray(snapshot.files)
      || snapshot.files.length !== snapshot.fileCount
    ) {
      throw new SafeError(
        'declared-input-snapshot-invalid',
        'Declared Android build input snapshot metadata is invalid.',
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
          'declared-input-file-invalid',
          'Declared Android build input entries must use the strict path/sizeBytes/sha256 schema.',
        );
      }
      assertDeclaredInputPath(file.path);
      if (
        previousPath !== null
        && compareDeclaredPaths(previousPath, file.path) >= 0
      ) {
        throw new SafeError(
          'declared-input-order-invalid',
          'Declared Android build input paths must be unique and sorted.',
        );
      }
      if (
        !Number.isSafeInteger(file.sizeBytes)
        || file.sizeBytes < 0
        || !/^sha256:[0-9a-f]{64}$/.test(file.sha256 || '')
      ) {
        throw new SafeError(
          'declared-input-file-invalid',
          'Declared Android build input size or SHA-256 is invalid.',
        );
      }
      totalBytes += file.sizeBytes;
      previousPath = file.path;
    }
    if (
      totalBytes !== snapshot.totalBytes
      || declaredInputDigest(snapshot.files) !== snapshot.digest
    ) {
      throw new SafeError(
        'declared-input-digest-invalid',
        'Declared Android build input digest does not match its file snapshot.',
      );
    }
    return snapshot;
  }

  function declaredInputSnapshotsEqual(left, right) {
    validateDeclaredInputsSnapshot(left);
    validateDeclaredInputsSnapshot(right);
    return left.digest === right.digest
      && left.fileCount === right.fileCount
      && left.totalBytes === right.totalBytes;
  }

  function collectDeclaredInputPaths(root, { packageJson, firebasePath }) {
    const paths = new Set();
    for (const directory of DECLARED_INPUT_DIRECTORIES) {
      collectDirectoryInputs(root, directory, paths);
    }
    for (const directory of OPTIONAL_INPUT_DIRECTORIES) {
      const requested = path.resolve(root, directory);
      try {
        fs.lstatSync(requested);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      collectDirectoryInputs(root, directory, paths);
    }
    for (const relativePath of REQUIRED_INPUT_FILES) {
      paths.add(toProjectPath(root, resolveProjectFile(root, relativePath, relativePath)));
    }
    for (const relativePath of OPTIONAL_INPUT_FILES) {
      const resolved = optionalProjectInput(root, relativePath);
      if (resolved) paths.add(resolved);
    }

    const entryPoint = packageJson.main;
    if (typeof entryPoint !== 'string' || entryPoint.trim() === '') {
      throw new SafeError('entry-point-missing', 'package.json main must declare the native entry point.');
    }
    paths.add(toProjectPath(root, resolveProjectFile(root, entryPoint, 'package.json main entry point')));
    paths.add(toProjectPath(root, firebasePath));

    const lockfiles = LOCKFILES
      .map((relativePath) => optionalProjectInput(root, relativePath))
      .filter(Boolean);
    if (lockfiles.length !== 1) {
      throw new SafeError(
        'lockfile-count-invalid',
        'Exactly one supported project lockfile is required for Android source freshness.',
      );
    }
    paths.add(lockfiles[0]);

    const sortedPaths = [...paths].sort(compareDeclaredPaths);
    if (sortedPaths.length > MAX_DECLARED_INPUT_FILES) {
      throw new SafeError(
        'declared-input-file-limit',
        `Declared Android build inputs exceed ${MAX_DECLARED_INPUT_FILES} files.`,
      );
    }
    return sortedPaths;
}

function computeDeclaredInputs(root, context) {
    const sortedPaths = collectDeclaredInputPaths(root, context);
    const files = [];
    let totalBytes = 0;
    for (const relativePath of sortedPaths) {
      const absolutePath = resolveProjectFile(root, relativePath, `declared input ${relativePath}`);
      const before = fs.statSync(absolutePath);
      const digest = sha256File(absolutePath);
      const after = fs.statSync(absolutePath);
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs
      ) {
        throw new SafeError(
          'declared-input-changed-during-capture',
          `Declared Android build input changed during snapshot capture: ${relativePath}.`,
        );
      }
      const sizeBytes = after.size;
      totalBytes += sizeBytes;
      if (totalBytes > MAX_DECLARED_INPUT_BYTES) {
        throw new SafeError(
          'declared-input-byte-limit',
          `Declared Android build inputs exceed ${MAX_DECLARED_INPUT_BYTES} bytes.`,
        );
      }
      files.push({
        path: relativePath,
        sizeBytes,
        sha256: digest,
      });
    }
    const confirmedPaths = collectDeclaredInputPaths(root, context);
    if (
      sortedPaths.length !== confirmedPaths.length
      || sortedPaths.some((relativePath, index) => relativePath !== confirmedPaths[index])
    ) {
      throw new SafeError(
        'declared-input-set-changed-during-capture',
        'Declared Android build input files changed during snapshot capture.',
      );
    }
    return validateDeclaredInputsSnapshot({
      schemaVersion: 1,
      algorithm: 'sha256',
      digest: declaredInputDigest(files),
      fileCount: files.length,
      totalBytes,
      files,
    });
  }

  function writeDeclaredInputsSnapshot(root, configuredPath, snapshot) {
    validateDeclaredInputsSnapshot(snapshot);
    const outputPath = resolveProjectOutputFile(root, configuredPath, 'Android input snapshot');
    fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return outputPath;
  }

function readDeclaredInputsSnapshot(root, configuredPath) {
  const snapshotPath = resolveProjectFile(
    root,
    configuredPath,
    'Android input snapshot',
    { extension: '.json' },
  );
  if (fs.statSync(snapshotPath).size > MAX_JSON_BYTES) {
    throw new SafeError('input-snapshot-too-large', 'Android input snapshot exceeds the supported size.');
  }
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    throw new SafeError('input-snapshot-json-invalid', 'Android input snapshot must contain valid JSON.');
  }
  return validateDeclaredInputsSnapshot(snapshot);
}

function readExact(fd, length, position, label) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (read === 0) {
      throw new SafeError('apk-zip-truncated', `${label} is truncated.`);
    }
    offset += read;
  }
  return buffer;
}

function findZipEndOfCentralDirectory(fd, fileSize) {
  const tailSize = Math.min(fileSize, 22 + 0xffff);
  if (tailSize < 22) {
    throw new SafeError('apk-zip-invalid', 'Android APK is not a valid ZIP archive.');
  }
  const tailOffset = fileSize - tailSize;
  const tail = readExact(fd, tailSize, tailOffset, 'Android APK ZIP footer');
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== tail.length) continue;
    const disk = tail.readUInt16LE(offset + 4);
    const centralDisk = tail.readUInt16LE(offset + 6);
    const entriesOnDisk = tail.readUInt16LE(offset + 8);
    const entryCount = tail.readUInt16LE(offset + 10);
    const centralSize = tail.readUInt32LE(offset + 12);
    const centralOffset = tail.readUInt32LE(offset + 16);
    if (
      disk !== 0
      || centralDisk !== 0
      || entriesOnDisk !== entryCount
      || entryCount === 0xffff
      || centralSize === 0xffffffff
      || centralOffset === 0xffffffff
    ) {
      throw new SafeError(
        'apk-zip-unsupported',
        'Android APK must be a single-disk non-ZIP64 archive.',
      );
    }
    const absoluteOffset = tailOffset + offset;
    if (
      centralSize > MAX_APK_CENTRAL_DIRECTORY_BYTES
      || centralOffset + centralSize > absoluteOffset
    ) {
      throw new SafeError(
        'apk-zip-central-directory-invalid',
        'Android APK central directory is invalid or exceeds the supported size.',
      );
    }
    return {
      offset: absoluteOffset,
      entryCount,
      centralSize,
      centralOffset,
      comment: tail.subarray(offset + 22),
    };
  }
  throw new SafeError('apk-zip-invalid', 'Android APK ZIP footer is missing or invalid.');
}

function findApkSigningBlock(fd, centralOffset) {
  if (centralOffset < 32) return null;
  // APK Signature Scheme v2+ places `[size][pairs][size]["APK Sig Block 42"]`
  // immediately before the ZIP central directory. Proof insertion must remove
  // that old block and require a new customer signature afterward; retaining it
  // would make the archive look signed even though the new asset is uncovered.
  // See: https://source.android.com/docs/security/features/apksigning/v2
  const footer = readExact(fd, 24, centralOffset - 24, 'Android APK signing block footer');
  if (!footer.subarray(8).equals(APK_SIGNING_BLOCK_MAGIC)) return null;
  const size = footer.readBigUInt64LE(0);
  if (size < 24n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SafeError('apk-signing-block-invalid', 'Android APK signing block size is invalid.');
  }
  const totalSize = Number(size + 8n);
  const offset = centralOffset - totalSize;
  if (offset < 0) {
    throw new SafeError('apk-signing-block-invalid', 'Android APK signing block offset is invalid.');
  }
  const headerSize = readExact(fd, 8, offset, 'Android APK signing block header').readBigUInt64LE(0);
  if (headerSize !== size) {
    throw new SafeError('apk-signing-block-invalid', 'Android APK signing block size markers differ.');
  }
  return { offset, sizeBytes: totalSize };
}

function parseZipCentralDirectory(fd, eocd) {
  const central = readExact(
    fd,
    eocd.centralSize,
    eocd.centralOffset,
    'Android APK central directory',
  );
  const entries = [];
  let offset = 0;
  for (let index = 0; index < eocd.entryCount; index += 1) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) {
      throw new SafeError('apk-zip-central-directory-invalid', 'Android APK central directory entry is invalid.');
    }
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (offset + entryLength > central.length) {
      throw new SafeError('apk-zip-central-directory-invalid', 'Android APK central directory entry is truncated.');
    }
    const compressedSize = central.readUInt32LE(offset + 20);
    const uncompressedSize = central.readUInt32LE(offset + 24);
    const localOffset = central.readUInt32LE(offset + 42);
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff
      || central.readUInt16LE(offset + 34) !== 0
    ) {
      throw new SafeError('apk-zip-unsupported', 'Android APK contains unsupported ZIP64 or multi-disk entries.');
    }
    entries.push({
      name: central.subarray(offset + 46, offset + 46 + nameLength),
      flags: central.readUInt16LE(offset + 8),
      method: central.readUInt16LE(offset + 10),
      crc32: central.readUInt32LE(offset + 16),
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += entryLength;
  }
  if (offset !== central.length) {
    throw new SafeError('apk-zip-central-directory-invalid', 'Android APK central directory size is inconsistent.');
  }
  return { buffer: central, entries };
}

function readZipLayout(apkPath) {
  const stat = fs.lstatSync(apkPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 22) {
    throw new SafeError('apk-not-regular', 'Android artifact must be a regular, non-symlink APK.');
  }
  const fd = fs.openSync(apkPath, 'r');
  try {
    const eocd = findZipEndOfCentralDirectory(fd, stat.size);
    const signingBlock = findApkSigningBlock(fd, eocd.centralOffset);
    const central = parseZipCentralDirectory(fd, eocd);
    return { stat, eocd, signingBlock, central };
  } finally {
    fs.closeSync(fd);
  }
}

function apkInputProofBytes(digest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest || '')) {
    throw new SafeError('apk-input-proof-digest-invalid', 'Android APK input proof digest is invalid.');
  }
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    algorithm: 'sha256',
    declaredInputsDigest: digest,
  })}\n`, 'utf8');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readAndroidInputProof(apkPath) {
  const layout = readZipLayout(apkPath);
  const proofName = Buffer.from(APK_INPUT_PROOF_PATH, 'utf8');
  const matches = layout.central.entries.filter((entry) => entry.name.equals(proofName));
  if (matches.length !== 1) {
    throw new SafeError(
      'apk-input-proof-count-invalid',
      `Signed Android APK must contain exactly one ${APK_INPUT_PROOF_PATH} entry.`,
    );
  }
  const entry = matches[0];
  if (
    entry.flags !== 0x0800
    || entry.method !== 0
    || entry.compressedSize !== entry.uncompressedSize
    || entry.uncompressedSize < 1
    || entry.uncompressedSize > MAX_APK_INPUT_PROOF_BYTES
  ) {
    throw new SafeError(
      'apk-input-proof-zip-invalid',
      'Android APK input proof entry must be a small uncompressed UTF-8 ZIP entry.',
    );
  }
  const fd = fs.openSync(apkPath, 'r');
  try {
    const local = readExact(fd, 30, entry.localOffset, 'Android APK input proof header');
    if (local.readUInt32LE(0) !== 0x04034b50) {
      throw new SafeError('apk-input-proof-zip-invalid', 'Android APK input proof local header is invalid.');
    }
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const localName = readExact(
      fd,
      nameLength,
      entry.localOffset + 30,
      'Android APK input proof name',
    );
    if (
      local.readUInt16LE(6) !== entry.flags
      || local.readUInt16LE(8) !== entry.method
      || local.readUInt32LE(14) !== entry.crc32
      || local.readUInt32LE(18) !== entry.compressedSize
      || local.readUInt32LE(22) !== entry.uncompressedSize
      || !localName.equals(proofName)
    ) {
      throw new SafeError('apk-input-proof-zip-invalid', 'Android APK input proof ZIP headers differ.');
    }
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    if (dataOffset % 4 !== 0) {
      throw new SafeError(
        'apk-input-proof-alignment-invalid',
        'Android APK input proof entry must be aligned before final signing.',
      );
    }
    const contentBoundary = layout.signingBlock?.offset ?? layout.eocd.centralOffset;
    if (dataOffset + entry.compressedSize > contentBoundary) {
      throw new SafeError(
        'apk-input-proof-signing-order-invalid',
        'Android APK input proof was not placed before the final APK signing block.',
      );
    }
    const bytes = readExact(fd, entry.compressedSize, dataOffset, 'Android APK input proof');
    if (crc32(bytes) !== entry.crc32) {
      throw new SafeError('apk-input-proof-crc-invalid', 'Android APK input proof checksum is invalid.');
    }
    let proof;
    try {
      proof = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new SafeError('apk-input-proof-json-invalid', 'Android APK input proof must contain valid JSON.');
    }
    const expectedKeys = ['algorithm', 'declaredInputsDigest', 'schemaVersion'];
    if (
      !proof
      || typeof proof !== 'object'
      || Array.isArray(proof)
      || Object.keys(proof).sort().join('\0') !== expectedKeys.join('\0')
      || proof.schemaVersion !== 1
      || proof.algorithm !== 'sha256'
      || !/^sha256:[0-9a-f]{64}$/.test(proof.declaredInputsDigest || '')
      || !bytes.equals(apkInputProofBytes(proof.declaredInputsDigest))
    ) {
      throw new SafeError(
        'apk-input-proof-schema-invalid',
        'Android APK input proof must use the strict deterministic schema.',
      );
    }
    return {
      path: APK_INPUT_PROOF_PATH,
      declaredInputsDigest: proof.declaredInputsDigest,
      signingBlockPresent: Boolean(layout.signingBlock),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertAndroidInputProof(apkPath, expectedDigest, { requireSigningBlock = false } = {}) {
  const proof = readAndroidInputProof(apkPath);
  if (proof.declaredInputsDigest !== expectedDigest) {
    throw new SafeError(
      'apk-input-proof-mismatch',
      'Signed Android APK input proof differs from the captured declared-input digest.',
    );
  }
  if (requireSigningBlock && !proof.signingBlockPresent) {
    throw new SafeError(
      'apk-input-proof-not-finally-signed',
      'Android APK input proof is not covered by a final APK Signature Scheme v2+ signing block.',
    );
  }
  return proof;
}

function copyFileRange(sourceFd, targetFd, length) {
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < length) {
    const requested = Math.min(buffer.length, length - position);
    const read = fs.readSync(sourceFd, buffer, 0, requested, position);
    if (read === 0) throw new SafeError('apk-zip-truncated', 'Android APK changed while embedding input proof.');
    writeAll(targetFd, buffer.subarray(0, read));
    position += read;
  }
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function buildProofZipRecords(localOffset, proofBytes) {
  const name = Buffer.from(APK_INPUT_PROOF_PATH, 'utf8');
  const baseDataOffset = localOffset + 30 + name.length;
  const paddingLength = (4 - ((baseDataOffset + 4) % 4)) % 4;
  // A private empty/padded extra field aligns the new uncompressed asset without
  // shifting any pre-existing APK entry that Wrap already zipaligned.
  const extra = Buffer.alloc(4 + paddingLength);
  extra.writeUInt16LE(0xffff, 0);
  extra.writeUInt16LE(paddingLength, 2);
  const checksum = crc32(proofBytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(proofBytes.length, 18);
  local.writeUInt32LE(proofBytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(extra.length, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(proofBytes.length, 20);
  central.writeUInt32LE(proofBytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(localOffset, 42);
  return {
    local: Buffer.concat([local, name, extra, proofBytes]),
    central: Buffer.concat([central, name]),
  };
}

function embedAndroidInputProof(apkPath, snapshot) {
  validateDeclaredInputsSnapshot(snapshot);
  const existingLayout = readZipLayout(apkPath);
  const proofName = Buffer.from(APK_INPUT_PROOF_PATH, 'utf8');
  const existing = existingLayout.central.entries.filter((entry) => entry.name.equals(proofName));
  if (existing.length > 0) {
    const proof = assertAndroidInputProof(apkPath, snapshot.digest);
    return {
      ...proof,
      embedded: false,
      removedPreviousSigningBlock: false,
      requiresFinalCustomerSigning: !proof.signingBlockPresent,
    };
  }
  if (existingLayout.eocd.entryCount >= 0xfffe) {
    throw new SafeError('apk-zip-entry-limit', 'Android APK has too many entries for proof embedding.');
  }
  const prefixLength = existingLayout.signingBlock?.offset ?? existingLayout.eocd.centralOffset;
  const proofBytes = apkInputProofBytes(snapshot.digest);
  const records = buildProofZipRecords(prefixLength, proofBytes);
  const newCentralOffset = prefixLength + records.local.length;
  const newCentralSize = existingLayout.eocd.centralSize + records.central.length;
  if (newCentralOffset > 0xffffffff || newCentralSize > 0xffffffff) {
    throw new SafeError('apk-zip-unsupported', 'Android APK proof embedding would require ZIP64.');
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(existingLayout.eocd.entryCount + 1, 8);
  eocd.writeUInt16LE(existingLayout.eocd.entryCount + 1, 10);
  eocd.writeUInt32LE(newCentralSize, 12);
  eocd.writeUInt32LE(newCentralOffset, 16);
  eocd.writeUInt16LE(existingLayout.eocd.comment.length, 20);

  const temporary = path.join(
    path.dirname(apkPath),
    `.${path.basename(apkPath)}.input-proof-${process.pid}-${crypto.randomUUID()}`,
  );
  const sourceFd = fs.openSync(apkPath, 'r');
  let targetFd;
  try {
    targetFd = fs.openSync(temporary, 'wx', existingLayout.stat.mode & 0o777);
    copyFileRange(sourceFd, targetFd, prefixLength);
    writeAll(targetFd, records.local);
    writeAll(targetFd, existingLayout.central.buffer);
    writeAll(targetFd, records.central);
    writeAll(targetFd, eocd);
    writeAll(targetFd, existingLayout.eocd.comment);
    fs.fsyncSync(targetFd);
  } finally {
    fs.closeSync(sourceFd);
    if (targetFd !== undefined) fs.closeSync(targetFd);
  }
  try {
    fs.renameSync(temporary, apkPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  // Existing local-entry offsets never move: only the obsolete signing block
  // and central directory are replaced. The next `apksigner sign` therefore
  // covers both the original Wrap payload and this canonical source digest.
  const proof = assertAndroidInputProof(apkPath, snapshot.digest);
  return {
    ...proof,
    embedded: true,
    removedPreviousSigningBlock: Boolean(existingLayout.signingBlock),
    requiresFinalCustomerSigning: true,
  };
}

function inspectForbiddenKeys(value, prefix = '', seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const findings = [];
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_KEY.test(key)) findings.push(field);
    findings.push(...inspectForbiddenKeys(child, field, seen));
  }
  return findings;
}

function scanSigningMaterial(root) {
  const findings = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const extension = path.extname(entry.name).toLowerCase();
      if (entry.isSymbolicLink()) {
        if (SIGNING_EXTENSIONS.has(extension)) {
          findings.push({ path: toProjectPath(root, absolute), symlink: true });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (entry.isFile() && SIGNING_EXTENSIONS.has(extension)) {
        findings.push({ path: toProjectPath(root, absolute), symlink: false });
      }
    }
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

function parseMemoryRows(source) {
  const rows = [];
  for (const line of source.split(/\r?\n/)) {
    const table = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    const scalar = line.match(/^\s*[-*]?\s*([^:]+?)\s*:\s*(\S.*?)\s*$/);
    const pair = table || scalar;
    if (!pair) continue;
    const label = pair[1].trim();
    const value = pair[2].trim().replaceAll('`', '');
    if (!value) continue;
    rows.push({ label, value });
  }
  return rows;
}

function oneMemoryValue(rows, patterns, label, { required = true } = {}) {
  const values = new Set();
  for (const row of rows) {
    if (
      !/^[_<]/.test(row.value)
      && patterns.some((pattern) => pattern.test(row.label))
    ) {
      values.add(row.value);
    }
  }
  if (values.size > 1) {
    throw new SafeError('memory-identity-conflict', `memory-bank.md contains conflicting ${label} values.`);
  }
  const [value] = values;
  if (!value && required) {
    throw new SafeError('memory-identity-missing', `memory-bank.md is missing ${label}.`);
  }
  return value || null;
}

function normalizeMemoryPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseMemoryIdentity(root) {
  const memoryPath = resolveProjectFile(root, 'memory-bank.md', 'memory-bank.md');
  const rows = parseMemoryRows(fs.readFileSync(memoryPath, 'utf8'));
  const forbiddenLabels = rows
    .map((row) => row.label)
    .filter((label) => FORBIDDEN_KEY.test(label));
  if (forbiddenLabels.length > 0) {
    throw new SafeError(
      'memory-credential-fields-forbidden',
      `memory-bank.md contains forbidden credential fields: ${forbiddenLabels.join(', ')}.`,
    );
  }
  const clientIdValue = oneMemoryValue(
    rows,
    [/^app registration(?: \(entra\))?$/i],
    'the Entra app registration client ID',
  );
  const clientIdMatch = clientIdValue.match(GUID);
  if (!clientIdMatch || clientIdMatch[0] !== clientIdValue) {
    throw new SafeError(
      'memory-auth-invalid',
      'memory-bank.md App registration (Entra) must be the exact client ID GUID.',
    );
  }

  return {
    displayName: oneMemoryValue(rows, [/^display name$/i], 'the app display name'),
    androidPackage: oneMemoryValue(
      rows,
      [/^android bundle id$/i, /^android package(?: identifier)?$/i],
      'the Android package',
    ),
    clientId: clientIdValue,
    firebaseProjectId: oneMemoryValue(rows, [/^firebase project id$/i], 'the Firebase project ID'),
    firebaseAndroidAppId: oneMemoryValue(
      rows,
      [/^(?:android firebase app id|firebase android app id)$/i],
      'the Android Firebase app ID',
    ),
    firebaseClientPath: normalizeMemoryPath(oneMemoryValue(
      rows,
      [/^android client config path$/i],
      'the Android Firebase client config path',
    )),
    versionName: oneMemoryValue(rows, [/^android version name$/i], 'the Android version name'),
    versionCode: oneMemoryValue(rows, [/^android version code$/i], 'the Android version code'),
    iconPath: normalizeMemoryPath(oneMemoryValue(
      rows,
      [/^android icon path$/i],
      'the Android icon path',
    )),
    iconSha256: oneMemoryValue(rows, [/^android icon sha-256$/i], 'the Android icon SHA-256'),
  };
}

function validatePng(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 45 || stat.size > MAX_ICON_BYTES) {
    throw new SafeError('icon-invalid-size', 'iconPath must reference a valid PNG with bounded, complete content.');
  }
  const header = Buffer.alloc(24);
  const trailer = Buffer.alloc(12);
  const descriptor = fs.openSync(filePath, 'r');
  let headerBytes;
  let trailerBytes;
  try {
    headerBytes = fs.readSync(descriptor, header, 0, header.length, 0);
    trailerBytes = fs.readSync(descriptor, trailer, 0, trailer.length, stat.size - trailer.length);
  } finally {
    fs.closeSync(descriptor);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    headerBytes !== header.length
    || trailerBytes !== trailer.length
    || !header.subarray(0, 8).equals(signature)
    || header.readUInt32BE(8) !== 13
    || header.toString('ascii', 12, 16) !== 'IHDR'
    || trailer.readUInt32BE(0) !== 0
    || trailer.toString('ascii', 4, 8) !== 'IEND'
    || trailer.readUInt32BE(8) !== 0xae426082
  ) {
    throw new SafeError('icon-invalid-png', 'iconPath must reference a valid PNG.');
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width !== height || width < MIN_ANDROID_ICON_SIZE) {
    throw new SafeError(
      'icon-invalid-dimensions',
      `Android icon must be square and at least ${MIN_ANDROID_ICON_SIZE}x${MIN_ANDROID_ICON_SIZE}.`,
    );
  }
  return { width, height };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function fileStatIdentity(stat) {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SafeError('artifact-too-large', 'Android APK exceeds the supported file size.');
  }
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    sizeBytes: Number(stat.size),
    modifiedAtNs: stat.mtimeNs.toString(),
    changedAtNs: stat.ctimeNs.toString(),
  };
}

function sameFileStat(left, right) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function captureStableFileIdentity(root, filePath, label = 'Android APK') {
  assertNoSymlinkComponents(root, filePath);
  const leaf = fs.lstatSync(filePath, { bigint: true });
  if (leaf.isSymbolicLink() || !leaf.isFile()) {
    throw new SafeError('artifact-not-regular', `${label} must be a regular, non-symlink file.`);
  }
  const realPathBefore = fs.realpathSync(filePath);
  if (!isWithinRoot(realPathBefore, root)) {
    throw new SafeError('artifact-path-escape', `${label} resolves outside the project root.`);
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let bytesReadTotal = 0n;
  let before;
  let after;
  try {
    before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new SafeError('artifact-not-regular', `${label} must remain a regular file.`);
    }
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytesReadTotal += BigInt(bytesRead);
    }
    after = fs.fstatSync(descriptor, { bigint: true });
  } finally {
    fs.closeSync(descriptor);
  }
  assertNoSymlinkComponents(root, filePath);
  const realPathAfter = fs.realpathSync(filePath);
  const pathStat = fs.statSync(filePath, { bigint: true });
  if (
    realPathAfter !== realPathBefore
    || !sameFileStat(before, after)
    || !sameFileStat(after, pathStat)
    || bytesReadTotal !== after.size
  ) {
    throw new SafeError(
      'artifact-changed-during-capture',
      `${label} changed while its stable identity was captured.`,
    );
  }
  const statIdentity = fileStatIdentity(after);
  return {
    realPath: realPathAfter,
    ...statIdentity,
    modifiedAt: new Date(Number(after.mtimeNs / 1000000n)).toISOString(),
    sha256: `sha256:${hash.digest('hex')}`,
  };
}

function assertStableFileIdentity(root, filePath, expected, phase, label = 'Android APK') {
  const current = captureStableFileIdentity(root, filePath, label);
  if (
    current.realPath !== expected.realPath
    || current.device !== expected.device
    || current.inode !== expected.inode
    || current.sizeBytes !== expected.sizeBytes
    || current.modifiedAtNs !== expected.modifiedAtNs
    || current.changedAtNs !== expected.changedAtNs
    || current.sha256 !== expected.sha256
  ) {
    throw new SafeError(
      'artifact-identity-drift',
      `${label} changed during ${phase}; discard it and rebuild before verification.`,
    );
  }
  return current;
}

function createStableFileSnapshot(root, sourcePath, sourceIdentity, label = 'Android APK') {
  const snapshotPath = resolveProjectOutputFile(
    root,
    `.tmp/.android-apk-verification-${process.pid}-${crypto.randomUUID()}.apk`,
    'Android APK verification snapshot',
  );
  try {
    fs.copyFileSync(sourcePath, snapshotPath, fs.constants.COPYFILE_EXCL);
    // Verification tools need read-only access. Removing the write bit makes
    // accidental mutation by a tool or parallel workflow fail before the
    // post-phase inode/hash checks run.
    fs.chmodSync(snapshotPath, 0o400);
    const snapshotIdentity = captureStableFileIdentity(
      root,
      snapshotPath,
      'Android APK verification snapshot',
    );
    assertStableFileIdentity(root, sourcePath, sourceIdentity, 'verification snapshot creation', label);
    if (
      snapshotIdentity.sizeBytes !== sourceIdentity.sizeBytes
      || snapshotIdentity.sha256 !== sourceIdentity.sha256
    ) {
      throw new SafeError(
        'artifact-snapshot-mismatch',
        `${label} changed while its private verification snapshot was created.`,
      );
    }
    return { path: snapshotPath, identity: snapshotIdentity };
  } catch (error) {
    fs.rmSync(snapshotPath, { force: true });
    throw error;
  }
}

function evaluateExpoConfig(root, wrap) {
  const configPath = resolveProjectFile(root, 'app.config.js', 'app.config.js', { extension: '.js' });
  const previous = {};
  const values = {
    ANDROID_PACKAGE: wrap.bundleIdentifier,
    APP_DISPLAY_NAME: wrap.displayName,
    APP_ICON_PATH: wrap.iconPath,
    APP_VERSION: wrap.version,
    APP_VERSION_CODE: String(wrap.versionCode),
    DEV_CLIENT: 'false',
  };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  delete require.cache[require.resolve(configPath)];
  try {
    const exported = require(configPath);
    const config = typeof exported === 'function' ? exported({ config: {} }) : exported;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new SafeError('expo-config-invalid', 'app.config.js did not evaluate to an Expo config object.');
    }
    return config;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('expo-config-evaluation-failed', 'app.config.js could not be evaluated safely.');
  } finally {
    delete require.cache[require.resolve(configPath)];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function inspectInstalledWrap(root) {
  let packagePath;
  try {
    packagePath = require.resolve('@microsoft/power-apps-native-host/package.json', { paths: [root] });
  } catch {
    throw new SafeError(
      'wrap-package-missing',
      '@microsoft/power-apps-native-host must be installed before Android build validation.',
    );
  }
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    throw new SafeError('wrap-package-invalid', 'Installed native-host package metadata is invalid.');
  }
  if (packageJson.bin?.wrap !== 'scripts/wrap.js') {
    throw new SafeError('wrap-contract-unsupported', 'Installed native-host package does not expose the supported Wrap entry point.');
  }
  const sourcePath = path.join(path.dirname(packagePath), packageJson.bin.wrap);
  let source;
  try {
    source = fs.readFileSync(sourcePath, 'utf8');
  } catch {
    throw new SafeError('wrap-contract-unreadable', 'Installed Wrap implementation could not be inspected.');
  }

  // The current supported Wrap implementation accepts Android signing material
  // only through these credential-bearing config fields and invokes apksigner.
  // Detect the installed contract rather than documenting imaginary flags or
  // environment variables that a later package might not support.
  const markers = [
    'keystorePath',
    'keystorePassword',
    'keyAlias',
    'keyPassword',
    'apksigner',
    'assembleRelease',
  ];
  if (!markers.every((marker) => source.includes(marker))) {
    throw new SafeError(
      'wrap-contract-unsupported',
      'Installed Wrap Android signing contract differs from the supported v1 workflow.',
    );
  }
  return {
    packageName: packageJson.name,
    version: packageJson.version,
    credentialBoundary: 'external-uncaptured-or-approved-system',
  };
}

function validateWrapShape(wrap) {
  const forbidden = inspectForbiddenKeys(wrap);
  if (forbidden.length > 0) {
    throw new SafeError(
      'credential-fields-forbidden',
      `wrap.config.json contains forbidden credential fields: ${forbidden.join(', ')}.`,
    );
  }
  if (wrap.android && (typeof wrap.android !== 'object' || Object.keys(wrap.android).length > 0)) {
    throw new SafeError(
      'android-signing-config-not-safe',
      'Safe wrap.config.json must not retain Android signing fields after the external build.',
    );
  }
  if (!ANDROID_PACKAGE.test(wrap.bundleIdentifier || '')) {
    throw new SafeError('android-package-invalid', 'bundleIdentifier must be a valid Android package name.');
  }
  if (typeof wrap.displayName !== 'string' || wrap.displayName.trim() === '') {
    throw new SafeError('display-name-missing', 'displayName is required.');
  }
  if (!SEMVER.test(wrap.version || '')) {
    throw new SafeError('version-name-invalid', 'version must be a semantic version.');
  }
  if (!Number.isInteger(wrap.versionCode) || wrap.versionCode < 1) {
    throw new SafeError('version-code-invalid', 'versionCode must be a positive integer.');
  }
  if (!GUID.test(wrap.msal?.clientId || '') || !GUID.test(wrap.msal?.tenantId || '')) {
    throw new SafeError('msal-identity-invalid', 'wrap.config.json must contain GUID-shaped MSAL client and tenant IDs.');
  }
}

function validateProject(projectRootArg) {
  const root = resolveProjectRoot(projectRootArg);
  const signingMaterial = scanSigningMaterial(root);
  if (signingMaterial.length > 0) {
    const paths = signingMaterial.map((finding) => finding.path).join(', ');
    throw new SafeError(
      'project-signing-material-forbidden',
      `Project-local or symlinked signing material must be removed: ${paths}.`,
    );
  }

  const packageJson = readJsonFile(root, 'package.json', 'package.json');
  if (packageJson.scripts?.['bundle:android'] !== 'js-bundle android') {
    throw new SafeError(
      'android-bundle-script-invalid',
      'package.json bundle:android must equal js-bundle android.',
    );
  }
  if (packageJson.scripts?.['build:android'] !== 'wrap android') {
    throw new SafeError(
      'android-build-script-invalid',
      'package.json build:android must equal wrap android.',
    );
  }
  const firebaseRuntime = readJsonFile(root, 'firebase.json', 'firebase.json');
  const firebaseRuntimeForbidden = inspectForbiddenKeys(firebaseRuntime);
  if (firebaseRuntimeForbidden.length > 0) {
    throw new SafeError(
      'firebase-runtime-credential-fields-forbidden',
      `firebase.json contains forbidden credential fields: ${firebaseRuntimeForbidden.join(', ')}.`,
    );
  }

  const wrap = readJsonFile(root, 'wrap.config.json', 'wrap.config.json');
  validateWrapShape(wrap);
  const auth = readJsonFile(root, 'auth.config.json', 'auth.config.json');
  const authForbidden = inspectForbiddenKeys(auth);
  if (authForbidden.length > 0) {
    throw new SafeError(
      'auth-credential-fields-forbidden',
      `auth.config.json contains forbidden credential fields: ${authForbidden.join(', ')}.`,
    );
  }
  if (!GUID.test(auth.msal?.clientId || '') || !GUID.test(auth.msal?.tenantId || '')) {
    throw new SafeError('auth-identity-invalid', 'auth.config.json must contain GUID-shaped MSAL client and tenant IDs.');
  }
  if (
    auth.msal.clientId !== wrap.msal.clientId
    || auth.msal.tenantId !== wrap.msal.tenantId
  ) {
    throw new SafeError('auth-identity-drift', 'wrap.config.json MSAL identity differs from auth.config.json.');
  }

  const memory = parseMemoryIdentity(root);
  if (memory.clientId !== auth.msal.clientId) {
    throw new SafeError('memory-auth-drift', 'Entra client ID differs from memory-bank.md.');
  }
  if (
    memory.versionCode !== String(wrap.versionCode)
    || !/^sha256:[0-9a-f]{64}$/i.test(memory.iconSha256)
  ) {
    throw new SafeError(
      'memory-build-identity-invalid',
      'memory-bank.md Android version code or icon SHA-256 is invalid.',
    );
  }

  const expo = evaluateExpoConfig(root, wrap);
  if (expo.name !== wrap.displayName) {
    throw new SafeError('expo-name-drift', 'Evaluated Expo display name differs from wrap.config.json.');
  }
  if (expo.version !== wrap.version) {
    throw new SafeError('expo-version-drift', 'Evaluated Expo version differs from wrap.config.json.');
  }
  if (expo.android?.versionCode !== wrap.versionCode) {
    throw new SafeError('expo-version-code-drift', 'Evaluated Expo Android versionCode differs from wrap.config.json.');
  }
  if (expo.android?.package !== wrap.bundleIdentifier) {
    throw new SafeError('expo-package-drift', 'Evaluated Expo Android package differs from wrap.config.json.');
  }
  if (expo.icon !== wrap.iconPath) {
    throw new SafeError('expo-icon-drift', 'Evaluated Expo icon differs from wrap.config.json.');
  }
  if (
    expo.android?.adaptiveIcon?.foregroundImage
    && expo.android.adaptiveIcon.foregroundImage !== wrap.iconPath
  ) {
    throw new SafeError(
      'expo-adaptive-icon-drift',
      'Evaluated Expo Android adaptive icon differs from wrap.config.json.',
    );
  }
  if (memory.displayName !== wrap.displayName || memory.androidPackage !== wrap.bundleIdentifier) {
    throw new SafeError('memory-app-identity-drift', 'App identity differs from memory-bank.md.');
  }

  const iconPath = resolveProjectFile(root, wrap.iconPath, 'iconPath', { extension: '.png' });
  const iconDimensions = validatePng(iconPath);
  const iconSha256 = sha256File(iconPath);
  if (
    memory.versionName !== wrap.version
    || memory.versionCode !== String(wrap.versionCode)
    || memory.iconPath !== toProjectPath(root, iconPath)
    || memory.iconSha256.toLowerCase() !== iconSha256
  ) {
    throw new SafeError(
      'memory-build-identity-drift',
      'Android version or icon identity differs from memory-bank.md.',
    );
  }
  const firebasePath = resolveProjectFile(
    root,
    expo.android?.googleServicesFile,
    'evaluated Android Firebase client config',
    { extension: '.json' },
  );
  const firebaseRelative = toProjectPath(root, firebasePath);
  if (normalizeMemoryPath(memory.firebaseClientPath) !== firebaseRelative) {
    throw new SafeError(
      'memory-firebase-path-drift',
      'Android Firebase client config path differs from memory-bank.md.',
    );
  }

  let firebase;
  try {
    firebase = parseAndroidClientIdentities(fs.readFileSync(firebasePath));
  } catch {
    throw new SafeError(
      'firebase-client-invalid',
      'Android Firebase client config could not be parsed as a safe client configuration.',
    );
  }
  const matches = firebase.clients.filter((client) => client.identifier === wrap.bundleIdentifier);
  if (matches.length !== 1 || !matches[0].appId) {
    throw new SafeError(
      'firebase-app-identity-invalid',
      'Android Firebase client config must contain exactly one app matching the Android package.',
    );
  }
  const firebaseAppId = matches[0].appId;
  if (!FIREBASE_ANDROID_APP_ID.test(firebaseAppId)) {
    throw new SafeError('firebase-app-id-invalid', 'Android Firebase app ID has an invalid shape.');
  }
  if (
    firebase.projectId !== memory.firebaseProjectId
    || firebaseAppId !== memory.firebaseAndroidAppId
    || matches[0].identifier !== memory.androidPackage
  ) {
    throw new SafeError('memory-firebase-identity-drift', 'Firebase Android identity differs from memory-bank.md.');
  }

  const inputs = computeDeclaredInputs(root, { packageJson, firebasePath });
  const outputPath = resolveSafeOutputPath(root, wrap.outputPath || './dist');
  const installedWrap = inspectInstalledWrap(root);
  return {
    schemaVersion: 1,
    status: 'ready',
    platform: 'android',
    purpose: 'direct-physical-device-testing',
    app: {
      package: wrap.bundleIdentifier,
      displayName: wrap.displayName,
      versionName: wrap.version,
      versionCode: wrap.versionCode,
      iconPath: toProjectPath(root, iconPath),
      iconSha256,
      iconWidth: iconDimensions.width,
      iconHeight: iconDimensions.height,
    },
    firebase: {
      projectId: firebase.projectId,
      androidAppId: firebaseAppId,
      package: matches[0].identifier,
      clientConfigPath: firebaseRelative,
    },
    auth: {
      clientId: auth.msal.clientId,
      tenantId: auth.msal.tenantId,
    },
    wrap: {
      packageName: installedWrap.packageName,
      packageVersion: installedWrap.version,
      outputPath: toProjectPath(root, outputPath),
      artifactPath: toProjectPath(root, path.join(outputPath, `${wrap.bundleIdentifier}.apk`)),
      bundleScript: packageJson.scripts['bundle:android'],
      buildScript: packageJson.scripts['build:android'],
      credentialBoundary: installedWrap.credentialBoundary,
    },
    signing: {
      customerManagedRequired: true,
      projectLocalKeystoreAllowed: false,
      credentialFieldsRetained: false,
    },
    inputs,
  };
}

function usage() {
  return [
    'Usage: node validate-android-wrap-build.js --project-root <path>',
    '  [--write-input-snapshot <project-relative-json-path>]',
    '  [--input-snapshot <project-relative-json-path>',
    '   --embed-input-proof <project-relative-apk-path>]',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const root = resolveProjectRoot(args.projectRoot);
    const result = validateProject(root);
    if (args.writeInputSnapshot) {
      const outputPath = writeDeclaredInputsSnapshot(root, args.writeInputSnapshot, result.inputs);
      result.inputSnapshotPath = toProjectPath(root, outputPath);
    }
    if (args.embedInputProof) {
      const snapshot = readDeclaredInputsSnapshot(root, args.inputSnapshot);
      if (!declaredInputSnapshotsEqual(snapshot, result.inputs)) {
        throw new SafeError(
          'input-proof-source-drift',
          'Declared Android app/push inputs changed after the pre-build snapshot.',
        );
      }
      const apkPath = resolveProjectFile(
        root,
        args.embedInputProof,
        'Android APK',
        { extension: '.apk' },
      );
      if (toProjectPath(root, apkPath) !== result.wrap.artifactPath) {
        throw new SafeError(
          'input-proof-artifact-path-mismatch',
          'Android input proof must be embedded into the exact validated Wrap artifact path.',
        );
      }
      result.apkInputProof = embedAndroidInputProof(apkPath, snapshot);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('android-wrap-validation-failed', 'Unable to validate the Android Wrap build.');
    process.stdout.write(`${JSON.stringify({
      status: 'blocked',
      issues: [issue(safe.code, safe.message)],
    }, null, 2)}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  APK_INPUT_PROOF_PATH,
  SafeError,
  apkInputProofBytes,
  assertAndroidInputProof,
  assertNoSymlinkComponents,
  assertStableFileIdentity,
  captureStableFileIdentity,
  computeDeclaredInputs,
  createStableFileSnapshot,
  declaredInputDigest,
  declaredInputSnapshotsEqual,
  evaluateExpoConfig,
  embedAndroidInputProof,
  inspectForbiddenKeys,
  inspectInstalledWrap,
  isWithinRoot,
  main,
  parseArgs,
  parseMemoryIdentity,
  readAndroidInputProof,
  readDeclaredInputsSnapshot,
  resolveProjectFile,
  resolveProjectOutputFile,
  resolveProjectRoot,
  resolveSafeOutputPath,
  scanSigningMaterial,
  sha256File,
  toProjectPath,
  validatePng,
  validateProject,
  validateDeclaredInputsSnapshot,
  validateWrapShape,
  writeDeclaredInputsSnapshot,
};
