'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_FILE = '.devplayer-builder/runtime.json';
const OMITTED_DIRECTORIES = new Set(['node_modules', '.git', '.expo']);
const OPERATIONAL_FILES = new Set([
  '.tmp/prototype-conversion-journal.json',
  '.tmp/prototype-dataverse-remote-journal.json',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertPlainDirectory(root) {
  const resolved = path.resolve(root);
  let cursor = resolved;
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Source directories must not contain symlinks');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolved;
}

function omitted(relative, directory) {
  const parts = relative.split('/');
  return (directory && OMITTED_DIRECTORIES.has(parts.at(-1)))
    || relative === '.git'
    || relative === RUNTIME_FILE
    || relative === '.DS_Store'
    || relative === '.devplayer-builder/logs'
    || relative.startsWith('.devplayer-builder/logs/');
}

function readRegularFile(file) {
  assertPlainDirectory(path.dirname(file));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('Source files must be regular files without symlinks or hardlink aliases');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new Error('Source changed while opening a file');
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    assertPlainDirectory(path.dirname(file));
    const current = fs.lstatSync(file);
    if (after.ino !== current.ino || after.dev !== current.dev || current.isSymbolicLink()
      || after.nlink !== 1 || current.nlink !== 1 || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Source changed while reading a file');
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function sourceFiles(root) {
  const base = assertPlainDirectory(root);
  const result = [];
  const names = new Set();
  function walk(directory, prefix) {
    assertPlainDirectory(directory);
    const beforeDirectory = fs.lstatSync(directory);
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name || name === '.' || name === '..' || /[\\\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('Source contains an unsafe file name');
      }
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = path.join(directory, name);
      if (!within(base, full)) throw new Error('Source path escapes its root');
      const stat = fs.lstatSync(full);
      // Dependencies are copied separately, never traversed as application source.
      if (OMITTED_DIRECTORIES.has(name) && (stat.isDirectory() || stat.isSymbolicLink())) continue;
      if (omitted(relative, stat.isDirectory())) continue;
      if (stat.isSymbolicLink()) throw new Error('Source symlinks are not permitted');
      const folded = relative.normalize('NFC').toLowerCase();
      if (names.has(folded)) throw new Error('Source contains ambiguous case or Unicode paths');
      names.add(folded);
      if (stat.isDirectory()) walk(full, relative);
      else if (stat.isFile() && stat.nlink === 1) result.push(relative);
      else throw new Error('Source must not contain special files or hardlink aliases');
    }
    const afterDirectory = fs.lstatSync(directory);
    if (afterDirectory.isSymbolicLink() || !afterDirectory.isDirectory()
      || beforeDirectory.dev !== afterDirectory.dev || beforeDirectory.ino !== afterDirectory.ino) {
      throw new Error('Source directory changed during capture');
    }
  }
  walk(base, '');
  return result.sort();
}

function operationalFile(relative) {
  return OPERATIONAL_FILES.has(relative)
    || /^\.tmp\/prototype-activation-backups\/[a-f0-9]{64}\.json$/.test(relative);
}

function fileCapture(root, includeOperational) {
  const files = sourceFiles(root).filter((relative) => includeOperational || !operationalFile(relative)).map((relative) => ({
    path: relative,
    sha256: sha256(readRegularFile(path.join(root, relative))),
  }));
  return { revision: sha256(canonical(files)), files };
}

function captureSource(root) {
  return fileCapture(root, false);
}

function captureSnapshot(root) {
  return fileCapture(root, true);
}

function copySource(root, destination, expectedRevision) {
  const base = assertPlainDirectory(root);
  const target = path.resolve(destination);
  if (within(base, target) || within(target, base)) throw new Error('Source and snapshot directories must not overlap');
  assertPlainDirectory(path.dirname(target));
  // Journals can name the source revision without changing it. Their bytes still
  // belong to the immutable snapshot, including recovery and remote-effect evidence.
  const captured = captureSnapshot(base);
  const files = captured.files.filter((entry) => !operationalFile(entry.path));
  const source = { revision: sha256(canonical(files)), files };
  if (expectedRevision && source.revision !== expectedRevision) throw new Error('Source revision is stale');
  fs.mkdirSync(target, { mode: 0o700 });
  try {
    for (const entry of captured.files) {
      const bytes = readRegularFile(path.join(base, entry.path));
      if (sha256(bytes) !== entry.sha256) throw new Error('Source changed during snapshot capture');
      const output = path.join(target, entry.path);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(output, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const copied = captureSnapshot(target);
    if (copied.revision !== captured.revision || captureSnapshot(base).revision !== captured.revision) {
      throw new Error('Source changed during snapshot capture');
    }
    for (const directory of new Set([target, ...captured.files.map((entry) => path.dirname(path.join(target, entry.path)))])) {
      const fd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return source;
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function freezeTree(root) {
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error('An immutable image cannot contain symlinks or special files');
    }
    if (stat.isDirectory()) freezeTree(file);
    else {
      if (stat.nlink !== 1) throw new Error('An immutable image cannot contain hardlink aliases');
      fs.chmodSync(file, (stat.mode & 0o111) ? 0o555 : 0o444);
    }
  }
  fs.chmodSync(root, 0o555);
}

function removeTree(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing to remove a non-directory image');
  fs.chmodSync(root, 0o700);
  for (const name of fs.readdirSync(root)) {
    const item = path.join(root, name);
    const child = fs.lstatSync(item);
    if (child.isDirectory() && !child.isSymbolicLink()) removeTree(item);
    else fs.unlinkSync(item);
  }
  fs.rmdirSync(root);
}

// Only links contained in the explicitly selected dependency image are resolved.
// Copies get new inodes; candidate node_modules are never used as a Metro root.
function copyDependencies(root, destination) {
  const base = assertPlainDirectory(root);
  if (within(base, destination) || within(path.resolve(destination), base)) {
    throw new Error('Dependency image and destination must not overlap');
  }
  assertPlainDirectory(path.dirname(destination));
  fs.mkdirSync(destination, { mode: 0o700 });
  function copy(input, output, ancestors) {
    const resolved = fs.realpathSync(input);
    if (!within(base, resolved)) throw new Error('Dependency links must stay inside the selected dependency image');
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      if (ancestors.has(resolved)) throw new Error('Dependency image contains a link cycle');
      const next = new Set(ancestors).add(resolved);
      fs.mkdirSync(output, { mode: 0o700 });
      for (const name of fs.readdirSync(resolved).sort()) copy(path.join(resolved, name), path.join(output, name), next);
    } else if (stat.isFile() && stat.nlink === 1) {
      const bytes = readRegularFile(resolved);
      fs.writeFileSync(output, bytes, { flag: 'wx', mode: (stat.mode & 0o111) ? 0o700 : 0o600 });
    } else {
      throw new Error('Dependency image contains special files or hardlink aliases');
    }
  }
  try {
    for (const name of fs.readdirSync(base).sort()) copy(path.join(base, name), path.join(destination, name), new Set([base]));
  } catch (error) {
    removeTree(destination);
    throw error;
  }
}

module.exports = {
  RUNTIME_FILE, canonical, sha256, within, assertPlainDirectory, readRegularFile,
  sourceFiles, captureSource, captureSnapshot, copySource, copyDependencies, freezeTree, removeTree,
};
