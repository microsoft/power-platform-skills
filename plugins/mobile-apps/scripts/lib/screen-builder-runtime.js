'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { canonicalJson, sha256Hex } = require('./product-experience-contracts');

const CHANNELS = new Set(['direct-write', 'return-only', 'foreground']);

function pathEntryExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function projectPath(projectRoot, candidate, label = 'path') {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside project root: ${candidate}`);
  }
  return { resolved, relative: relative.replace(/\\/g, '/') };
}

function createRunState(runId, workOrders) {
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('runId is required');
  const screens = {};
  for (const workOrder of workOrders) {
    if (screens[workOrder.screenId]) throw new Error(`duplicate screen ${workOrder.screenId}`);
    screens[workOrder.screenId] = {
      inputFingerprint: workOrder.inputFingerprint,
      channel: 'direct-write',
      channelFailures: 0,
      attempts: 0,
      status: 'pending',
    };
  }
  return { schemaVersion: 1, runId: runId.trim(), screens };
}

function screenState(state, screenId) {
  const value = state?.screens?.[screenId];
  if (!value) throw new Error(`unknown screen ${screenId}`);
  return value;
}

function recordChannelFailure(state, screenId, channel, diagnostic) {
  if (!CHANNELS.has(channel)) throw new Error(`unsupported builder channel: ${channel}`);
  const screen = screenState(state, screenId);
  if (screen.channel !== channel) throw new Error(`${screenId} is not assigned to ${channel}`);
  screen.attempts += 1;
  screen.channelFailures += 1;
  screen.lastDiagnostic = String(diagnostic || 'channel failure').slice(0, 500);
  if (channel === 'direct-write') screen.channel = 'return-only';
  else screen.channel = 'foreground';
  screen.status = 'pending';
  return screen.channel;
}

function recordScreenSuccess(state, screenId, channel, outputHash) {
  const screen = screenState(state, screenId);
  if (screen.channel !== channel) throw new Error(`${screenId} is not assigned to ${channel}`);
  screen.attempts += 1;
  screen.status = 'complete';
  screen.outputHash = String(outputHash || '');
  delete screen.lastDiagnostic;
  return state;
}

function pendingScreens(state) {
  return Object.entries(state.screens)
    .filter(([, screen]) => screen.status !== 'complete')
    .map(([screenId, screen]) => ({ screenId, ...screen }))
    .sort((left, right) => left.screenId.localeCompare(right.screenId));
}

function fileEntries(root, candidate, entries) {
  const { resolved } = projectPath(root, candidate, 'validation path');
  if (!pathEntryExists(resolved)) return;
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`validation path traverses a symbolic link: ${candidate}`);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(resolved).sort()) {
      fileEntries(root, path.join(resolved, child), entries);
    }
    return;
  }
  entries.push({
    path: path.relative(root, resolved).replace(/\\/g, '/'),
    sha256: sha256Hex(fs.readFileSync(resolved)),
  });
}

function collectSnapshotEntries(root, candidates) {
  const entries = [];
  for (const candidate of [...new Set(candidates)].sort()) fileEntries(root, candidate, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function snapshotRevision(snapshot) {
  const value = structuredClone(snapshot);
  delete value.snapshotRevision;
  return sha256Hex(canonicalJson(value));
}

function captureDirectWriteSnapshot(projectRoot, candidates, backupDirectory) {
  const root = path.resolve(projectRoot);
  const backup = projectPath(root, backupDirectory, 'backup directory');
  if (pathEntryExists(backup.resolved)) {
    throw new Error(`backup directory already exists: ${backup.relative}`);
  }
  const normalizedCandidates = [...new Set(candidates.map((candidate) => (
    projectPath(root, candidate, 'snapshot path').relative
  )))].sort();
  if (!normalizedCandidates.length) throw new Error('at least one snapshot path is required');
  const entries = collectSnapshotEntries(root, normalizedCandidates);
  fs.mkdirSync(backup.resolved, { recursive: true });
  for (const entry of entries) {
    const source = projectPath(root, entry.path, 'snapshot entry').resolved;
    const destination = path.join(backup.resolved, 'files', entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const snapshot = {
    schemaVersion: 1,
    candidates: normalizedCandidates,
    backupDirectory: backup.relative,
    entries,
  };
  snapshot.snapshotRevision = snapshotRevision(snapshot);
  return snapshot;
}

function validateSnapshot(projectRoot, snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.candidates)
    || !Array.isArray(snapshot.entries) || typeof snapshot.backupDirectory !== 'string') {
    throw new Error('direct-write snapshot is invalid');
  }
  if (snapshot.snapshotRevision !== snapshotRevision(snapshot)) {
    throw new Error('direct-write snapshot revision does not match its contents');
  }
  const root = path.resolve(projectRoot);
  const backup = projectPath(root, snapshot.backupDirectory, 'backup directory');
  const seen = new Set();
  for (const entry of snapshot.entries) {
    const normalized = projectPath(root, entry.path, 'snapshot entry').relative;
    if (seen.has(normalized)) throw new Error(`duplicate snapshot entry: ${normalized}`);
    seen.add(normalized);
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) {
      throw new Error(`snapshot entry has an invalid hash: ${normalized}`);
    }
    const backupFile = path.join(backup.resolved, 'files', normalized);
    if (!pathEntryExists(backupFile) || fs.lstatSync(backupFile).isSymbolicLink()) {
      throw new Error(`snapshot backup is missing or unsafe: ${normalized}`);
    }
    if (sha256Hex(fs.readFileSync(backupFile)) !== entry.sha256) {
      throw new Error(`snapshot backup hash mismatch: ${normalized}`);
    }
  }
  return { root, backup, seen };
}

function currentEntriesForDiff(root, candidates) {
  const entries = [];
  function visit(candidate) {
    const { resolved, relative } = projectPath(root, candidate, 'snapshot path');
    if (!pathEntryExists(resolved)) return;
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      entries.push({
        path: relative,
        type: 'symlink',
        sha256: sha256Hex(fs.readlinkSync(resolved)),
      });
      return;
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(resolved).sort()) visit(path.join(relative, child));
      return;
    }
    entries.push({ path: relative, type: 'file', sha256: sha256Hex(fs.readFileSync(resolved)) });
  }
  for (const candidate of candidates) visit(candidate);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function diffDirectWriteSnapshot(projectRoot, snapshot) {
  validateSnapshot(projectRoot, snapshot);
  const before = new Map(snapshot.entries.map((entry) => [entry.path, { ...entry, type: 'file' }]));
  const after = new Map(currentEntriesForDiff(projectRoot, snapshot.candidates).map((entry) => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((file) => {
    const prior = before.get(file);
    const current = after.get(file);
    if (!prior) return [{ path: file, change: 'added', before: null, after: current }];
    if (!current) return [{ path: file, change: 'deleted', before: prior, after: null }];
    if (prior.type !== current.type || prior.sha256 !== current.sha256) {
      return [{ path: file, change: 'modified', before: prior, after: current }];
    }
    return [];
  });
}

function removeUnsafeTarget(root, relativePath) {
  const { resolved } = projectPath(root, relativePath, 'changed file');
  if (pathEntryExists(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function restoreOutOfScopeChanges(projectRoot, snapshot, allowedPaths) {
  const { root, backup } = validateSnapshot(projectRoot, snapshot);
  const allowed = new Set(allowedPaths.map((candidate) => projectPath(root, candidate, 'allowed path').relative));
  if (!allowed.size) throw new Error('at least one allowed direct-write target is required');
  const changes = diffDirectWriteSnapshot(root, snapshot);
  const allowedChanges = changes.filter((change) => allowed.has(change.path));
  const outOfScope = changes.filter((change) => !allowed.has(change.path));

  // Remove additions and replacements before restoring prior files. This also removes a child
  // symlink that replaced a protected directory before any path beneath that directory is used.
  for (const change of [...outOfScope].sort((left, right) => right.path.length - left.path.length)) {
    if (change.change !== 'deleted') removeUnsafeTarget(root, change.path);
  }
  for (const change of outOfScope) {
    if (!change.before) continue;
    const target = projectPath(root, change.path, 'restore target').resolved;
    const backupFile = path.join(backup.resolved, 'files', change.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backupFile, target);
  }

  return {
    ok: outOfScope.length === 0 && allowedChanges.length === allowed.size,
    changedFiles: changes.map((change) => change.path),
    allowedChangedFiles: allowedChanges.map((change) => change.path),
    outOfScopeFiles: outOfScope.map((change) => change.path),
    restoredFiles: outOfScope.map((change) => change.path),
  };
}

function restoreSnapshotPaths(projectRoot, snapshot, pathsToRestore) {
  const { root, backup } = validateSnapshot(projectRoot, snapshot);
  const priorEntries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const candidates = snapshot.candidates.map((candidate) => candidate.replace(/\/$/, ''));
  const restoredFiles = [];
  for (const candidate of [...new Set(pathsToRestore)].sort()) {
    const { resolved, relative } = projectPath(root, candidate, 'restore path');
    const covered = candidates.some((snapshotPath) => (
      relative === snapshotPath || relative.startsWith(`${snapshotPath}/`)
    ));
    if (!covered) throw new Error(`restore path was not protected by the snapshot: ${relative}`);

    const prior = priorEntries.get(relative);
    removeUnsafeTarget(root, relative);
    if (prior) {
      const backupFile = path.join(backup.resolved, 'files', relative);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.copyFileSync(backupFile, resolved);
    }
    restoredFiles.push(relative);
  }
  return { restoredFiles };
}

function workspaceFingerprint(projectRoot, candidates) {
  const root = path.resolve(projectRoot);
  const entries = [];
  for (const candidate of [...candidates].sort()) fileEntries(root, candidate, entries);
  return sha256Hex(canonicalJson(entries.sort((left, right) => left.path.localeCompare(right.path))));
}

function canSkipValidation(state, fingerprint, validators) {
  if (!state || state.status !== 'success' || state.fingerprint !== fingerprint) return false;
  const prior = [...(state.validators || [])].sort();
  const requested = [...validators].sort();
  return canonicalJson(prior) === canonicalJson(requested);
}

function recordValidation(fingerprint, validators) {
  if (!/^[a-f0-9]{64}$/.test(String(fingerprint || ''))) {
    throw new Error('validation fingerprint must be SHA-256');
  }
  return {
    schemaVersion: 1,
    status: 'success',
    fingerprint,
    validators: [...new Set(validators)].sort(),
  };
}

module.exports = {
  CHANNELS,
  canSkipValidation,
  captureDirectWriteSnapshot,
  createRunState,
  diffDirectWriteSnapshot,
  pendingScreens,
  recordChannelFailure,
  recordScreenSuccess,
  recordValidation,
  restoreOutOfScopeChanges,
  restoreSnapshotPaths,
  workspaceFingerprint,
};