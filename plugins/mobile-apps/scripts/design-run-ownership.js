#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalJson,
  emitResult,
  fatal,
  finding,
  sha256Hex,
} = require('./lib/product-experience-contracts');

const TOOL = 'design-run-ownership';
const STATE_PATH = '.tmp/design-run-state.json';
const PROVENANCE_PATH = '.tmp/design-run-provenance.json';
const BACKUP_PATH = '.tmp/design-run-backup';
const AUTHORING_PROJECTION_PATH = '.tmp/product-experience-preview-authoring.json';
const FULL_PREVIEW_CONTRACT_PATH = '.tmp/product-experience-final-preview-contract.json';
const REQUIRED_IMMUTABLE_INPUTS = Object.freeze([
  'native-app-plan.md',
  '.tmp/product-experience-contract.json',
  '.tmp/product-scope-contract.json',
  '.tmp/workflow-journey-contract.json',
  '.tmp/screen-build-pack.json',
  '.tmp/compiled-screen-build-pack.json',
  '.tmp/navigation-manifest.json',
  '.tmp/scenario-facts.json',
]);
const OPTIONAL_IMMUTABLE_INPUTS = Object.freeze([
  '.tmp/persistence-contract.json',
  '.tmp/data-model-usage-input.json',
  '.tmp/data-model-usage.json',
  '.tmp/data-model-planning-status.json',
  '.tmp/dataverse-reconciliation-scope.json',
  '.datamodel-manifest.json',
]);
const IMMUTABLE_INPUTS = Object.freeze([
  ...REQUIRED_IMMUTABLE_INPUTS,
  ...OPTIONAL_IMMUTABLE_INPUTS,
]);
const ALLOWED_WRITES = Object.freeze([
  'brand/**',
  '_plan_preview.html',
  FULL_PREVIEW_CONTRACT_PATH,
  AUTHORING_PROJECTION_PATH,
  '.tmp/design-*.json',
]);
const AUTOMATIC_REFERENCES = Object.freeze([
  'skills/design-system/SKILL.md',
  'shared/shared-instructions-core.md',
  'skills/design-system/references/auto-experience.md',
  'skills/design-system/references/design-system-schema.md',
  'skills/design-system/references/final-experience-preview.md',
]);
const IGNORED_WORKSPACE_ROOTS = new Set([
  '.expo',
  '.git',
  'dist',
  'dist-web',
  'node_modules',
  'web-build',
]);

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function pathExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function projectFile(projectRoot, relativePath) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`design-run path must be inside project root: ${relativePath}`);
  }
  let current = root;
  for (const segment of path.dirname(relative).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (pathExists(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`design-run path traverses a symbolic link: ${relativePath}`);
    }
  }
  return { resolved, relative: toPosix(relative), root };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (pathExists(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function fingerprintFile(projectRoot, relativePath) {
  const target = projectFile(projectRoot, relativePath);
  if (!pathExists(target.resolved)) {
    return { path: target.relative, exists: false, sha256: null };
  }
  const stat = fs.lstatSync(target.resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`design-run input must be a regular file: ${target.relative}`);
  }
  return {
    path: target.relative,
    exists: true,
    sha256: sha256Hex(fs.readFileSync(target.resolved)),
  };
}

function collectWorkspaceEntries(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const entries = [];
  function visit(directory, relativeDirectory = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!relativeDirectory && IGNORED_WORKSPACE_ROOTS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.join(relativeDirectory, entry.name));
      if (relative === BACKUP_PATH || relative.startsWith(`${BACKUP_PATH}/`)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`design-run workspace contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) entries.push({
        path: relative,
        sha256: sha256Hex(fs.readFileSync(absolute)),
      });
    }
  }
  visit(root);
  return entries;
}

function writeWorkspaceBackup(projectRoot, entries) {
  const backup = projectFile(projectRoot, BACKUP_PATH).resolved;
  fs.rmSync(backup, { recursive: true, force: true });
  for (const entry of entries) {
    const source = projectFile(projectRoot, entry.path).resolved;
    const destination = path.join(backup, 'files', entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function restoreWorkspaceChanges(projectRoot, state, changes) {
  const before = new Map(state.workspaceEntries.map((entry) => [entry.path, entry]));
  const restoredFiles = [];
  for (const change of [...changes].sort((left, right) => right.path.length - left.path.length)) {
    const target = projectFile(projectRoot, change.path).resolved;
    const previous = before.get(change.path);
    if (!previous) {
      fs.rmSync(target, { recursive: true, force: true });
      restoredFiles.push(change.path);
      continue;
    }
    const backup = path.join(projectFile(projectRoot, BACKUP_PATH).resolved, 'files', change.path);
    if (!pathExists(backup) || fs.lstatSync(backup).isSymbolicLink()
      || sha256Hex(fs.readFileSync(backup)) !== previous.sha256) {
      throw new Error(`design-run backup is missing or invalid: ${change.path}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backup, target);
    restoredFiles.push(change.path);
  }
  return restoredFiles.sort();
}

function validateWorkspaceBackup(projectRoot, state) {
  const backup = projectFile(projectRoot, state.backupDirectory || BACKUP_PATH).resolved;
  const expected = new Map(state.workspaceEntries.map((entry) => [entry.path, entry.sha256]));
  const actual = new Map();
  const filesRoot = path.join(backup, 'files');
  function visit(directory, relativeDirectory = '') {
    if (!pathExists(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.join(relativeDirectory, entry.name));
      if (entry.isSymbolicLink()) throw new Error(`design-run backup is unsafe: ${relative}`);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) actual.set(relative, sha256Hex(fs.readFileSync(absolute)));
    }
  }
  visit(filesRoot);
  const mismatch = [...new Set([...expected.keys(), ...actual.keys()])].sort().find(
    (file) => expected.get(file) !== actual.get(file),
  );
  if (mismatch) throw new Error(`design-run backup is missing or invalid: ${mismatch}`);
}

function diffEntries(beforeEntries, afterEntries) {
  const before = new Map(beforeEntries.map((entry) => [entry.path, entry.sha256]));
  const after = new Map(afterEntries.map((entry) => [entry.path, entry.sha256]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((file) => {
    const previous = before.get(file);
    const current = after.get(file);
    if (previous === undefined) return [{ path: file, change: 'added' }];
    if (current === undefined) return [{ path: file, change: 'deleted' }];
    if (previous !== current) return [{ path: file, change: 'modified' }];
    return [];
  });
}

function isAllowedWrite(relativePath) {
  return relativePath === '_plan_preview.html'
    || relativePath === FULL_PREVIEW_CONTRACT_PATH
    || relativePath === AUTHORING_PROJECTION_PATH
    || relativePath.startsWith('brand/')
    || /^\.tmp\/design-[a-z0-9._-]+\.json$/i.test(relativePath);
}

function stateRevision(state) {
  const content = structuredClone(state);
  delete content.stateRevision;
  return sha256Hex(canonicalJson(content));
}

function automaticReferenceEvidence(pluginRoot) {
  return AUTOMATIC_REFERENCES.map((relativePath) => {
    const file = path.join(pluginRoot, relativePath);
    if (!pathExists(file) || !fs.lstatSync(file).isFile()) {
      throw new Error(`automatic design reference is missing: ${relativePath}`);
    }
    const source = fs.readFileSync(file);
    return { path: relativePath, bytes: source.length, sha256: sha256Hex(source) };
  });
}

function beginDesignRun({
  projectRoot,
  pluginRoot = path.resolve(__dirname, '..'),
  now = () => new Date().toISOString(),
  runId = () => crypto.randomUUID(),
}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const existingState = readDesignRunState(root);
  if (existingState) {
    const previous = readPreviousProvenance(root);
    const terminal = previous?.runId === existingState.runId
      && ['failed', 'needs-context', 'passed'].includes(previous.status);
    if (!terminal) {
      throw new Error('automatic design-run state is already active; verify it instead of restamping');
    }
  }
  const canonicalInputs = IMMUTABLE_INPUTS.map((relativePath) => fingerprintFile(
    root,
    relativePath,
  ));
  const missing = canonicalInputs.filter((entry) => (
    REQUIRED_IMMUTABLE_INPUTS.includes(entry.path) && !entry.exists
  ));
  if (missing.length > 0) {
    throw new Error(`missing immutable design input(s): ${missing.map((entry) => entry.path).join(', ')}`);
  }
  const automaticReferences = automaticReferenceEvidence(pluginRoot);
  const state = {
    schemaVersion: 1,
    contractType: 'automatic-design-run-state',
    runId: runId(),
    startedAt: now(),
    canonicalInputs,
    workspaceEntries: collectWorkspaceEntries(root),
    backupDirectory: BACKUP_PATH,
    allowedWrites: [...ALLOWED_WRITES],
    automaticReferences,
    totalAutomaticReferenceBytes: automaticReferences.reduce(
      (total, reference) => total + reference.bytes,
      0,
    ),
    mutationAttempts: [],
  };
  // Design runs need write access to their own artifacts, so filesystem permissions cannot
  // enforce ownership portably. Keep a hash-verified local backup and restore only paths the
  // design phase was never allowed to own; the approved plan is never regenerated.
  writeWorkspaceBackup(root, state.workspaceEntries);
  state.stateRevision = stateRevision(state);
  atomicWriteJson(projectFile(root, STATE_PATH).resolved, state);
  return state;
}

function readDesignRunState(projectRoot) {
  const stateFile = projectFile(projectRoot, STATE_PATH);
  if (!pathExists(stateFile.resolved)) return null;
  const state = JSON.parse(fs.readFileSync(stateFile.resolved, 'utf8'));
  if (state.schemaVersion !== 1 || state.contractType !== 'automatic-design-run-state'
    || !Array.isArray(state.canonicalInputs) || !Array.isArray(state.workspaceEntries)
    || !Array.isArray(state.automaticReferences)
    || state.stateRevision !== stateRevision(state)) {
    throw new Error('automatic design-run state is invalid or has been modified');
  }
  return state;
}

function readPreviousProvenance(projectRoot) {
  const file = projectFile(projectRoot, PROVENANCE_PATH).resolved;
  if (!pathExists(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.contractType === 'automatic-design-run-provenance' ? value : null;
  } catch {
    return null;
  }
}

function verifyDesignRun({ projectRoot }) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const state = readDesignRunState(root);
  if (!state) {
    return {
      ok: false,
      recoverable: true,
      status: 'NEEDS_DESIGN_REPAIR',
      errors: [finding(
        'design-ownership-state-missing',
        `run design-run-ownership.js --begin before automatic design`,
      )],
      immutableMutations: [],
      writeViolations: [],
      changes: [],
    };
  }
  validateWorkspaceBackup(root, state);
  const currentInputs = state.canonicalInputs.map((entry) => fingerprintFile(root, entry.path));
  const immutableMutations = currentInputs.flatMap((entry, index) => {
    const previous = state.canonicalInputs[index];
    if (entry.exists === previous.exists && entry.sha256 === previous.sha256) return [];
    return [{
      path: entry.path,
      change: !previous.exists ? 'added' : !entry.exists ? 'deleted' : 'modified',
      before: previous.sha256,
      after: entry.sha256,
    }];
  });
  const changes = diffEntries(state.workspaceEntries, collectWorkspaceEntries(root));
  const writeViolations = changes.filter((change) => !isAllowedWrite(change.path));
  const errors = [];
  if (immutableMutations.length > 0) {
    errors.push(finding(
      'design-ownership-immutable-input-mutated',
      `automatic design changed immutable planning input(s): ${immutableMutations.map((item) => item.path).join(', ')}`,
    ));
  }
  if (writeViolations.length > 0) {
    errors.push(finding(
      'design-ownership-write-outside-allowlist',
      `automatic design wrote outside its allowlist: ${writeViolations.map((item) => item.path).join(', ')}`,
    ));
  }
  const recoveryTargets = [...new Map([
    ...immutableMutations,
    ...writeViolations,
  ].map((change) => [change.path, change])).values()];
  const restoredFiles = recoveryTargets.length > 0
    ? restoreWorkspaceChanges(root, state, recoveryTargets)
    : [];
  if (recoveryTargets.length > 0) {
    const immutablePaths = new Set(immutableMutations.map((change) => change.path));
    state.mutationAttempts = [
      ...(state.mutationAttempts || []),
      ...recoveryTargets.map((change) => ({
        path: change.path,
        change: change.change,
        kind: immutablePaths.has(change.path) ? 'immutable-input' : 'write-outside-allowlist',
      })),
    ];
    state.stateRevision = stateRevision(state);
    atomicWriteJson(projectFile(root, STATE_PATH).resolved, state);
  }
  return {
    ok: errors.length === 0,
    recoverable: errors.length > 0,
    status: errors.length > 0 ? 'NEEDS_DESIGN_REPAIR' : 'CURRENT',
    runId: state.runId,
    state,
    currentInputs,
    immutableMutations,
    writeViolations,
    restoredFiles,
    changes,
    errors,
  };
}

function writeDesignRunProvenance({
  projectRoot,
  status,
  contract = null,
  authoringProjection = null,
  previewRevision = null,
  renderedLayoutStatus = 'not-run',
  errors = [],
  warnings = [],
  now = () => new Date().toISOString(),
}) {
  const verification = verifyDesignRun({ projectRoot });
  const state = verification.state || readDesignRunState(projectRoot);
  if (!state) return null;
  const previous = readPreviousProvenance(projectRoot);
  const previewRevisions = [...new Set([
    ...(previous?.previewRevisions || []),
    ...(previewRevision ? [previewRevision] : []),
  ])];
  const deterministicProjectReads = [
    ...state.canonicalInputs.filter((entry) => entry.exists).map((entry) => entry.path),
    'brand/design-system.md',
    'brand/tokens.ts',
    'brand/signature-components.ts',
    ...(previewRevision ? [
      FULL_PREVIEW_CONTRACT_PATH,
      AUTHORING_PROJECTION_PATH,
      '_plan_preview.html',
    ] : []),
  ];
  const filesWritten = verification.changes
    .filter((change) => isAllowedWrite(change.path))
    .map((change) => ({ path: change.path, change: change.change }));
  filesWritten.push({
    path: PROVENANCE_PATH,
    change: previous ? 'modified' : 'added',
  });
  const provenance = {
    schemaVersion: 1,
    contractType: 'automatic-design-run-provenance',
    runId: state.runId,
    status,
    recordedAt: now(),
    canonicalInputFingerprints: Object.fromEntries(state.canonicalInputs.map((entry) => [
      entry.path,
      entry.sha256,
    ])),
    filesRead: [
      ...state.automaticReferences.map((entry) => `plugin:${entry.path}`),
      ...deterministicProjectReads,
    ],
    filesWritten: [...new Map(filesWritten.map((entry) => [entry.path, entry])).values()]
      .sort((left, right) => left.path.localeCompare(right.path)),
    totalAutomaticReferenceBytes: state.totalAutomaticReferenceBytes,
    selectedScreenIds: contract?.selectedScreenIds || [],
    selectionRationale: contract?.selectionRationale || [],
    revisions: {
      tokens: contract?.revisions?.designTokens || null,
      signatureComponents: contract?.revisions?.signatureComponents || null,
      authoringProjection: authoringProjection?.projectionRevision || null,
      preview: previewRevision,
    },
    previewRevisions,
    previewRepairCount: Math.max(0, previewRevisions.length - 1),
    immutableInputMutationAttempts: (state.mutationAttempts || []).filter(
      (attempt) => attempt.kind === 'immutable-input',
    ),
    writeViolationAttempts: (state.mutationAttempts || []).filter(
      (attempt) => attempt.kind === 'write-outside-allowlist',
    ),
    renderedLayoutStatus,
    errors: errors.map((error) => ({ code: error.code, message: error.message })),
    warnings: warnings.map((warning) => ({ code: warning.code, message: warning.message })),
  };
  atomicWriteJson(projectFile(projectRoot, PROVENANCE_PATH).resolved, provenance);
  return provenance;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--begin') args.action = 'begin';
    else if (argv[index] === '--verify') args.action = 'verify';
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.projectRoot || !args.action) {
    throw new Error('Usage: design-run-ownership.js --project-root <dir> <--begin|--verify>');
  }
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const result = args.action === 'begin'
      ? beginDesignRun({ projectRoot: args.projectRoot })
      : verifyDesignRun({ projectRoot: args.projectRoot });
    return emitResult({
      ok: result.ok !== false,
      tool: TOOL,
      mode: args.action,
      runId: result.runId,
      canonicalInputFingerprints: Object.fromEntries(
        (result.canonicalInputs || result.currentInputs || []).map((entry) => [
          entry.path,
          entry.sha256,
        ]),
      ),
      allowedWrites: result.allowedWrites || result.state?.allowedWrites,
      totalAutomaticReferenceBytes: result.totalAutomaticReferenceBytes
        || result.state?.totalAutomaticReferenceBytes,
      immutableMutations: result.immutableMutations || [],
      writeViolations: result.writeViolations || [],
      restoredFiles: result.restoredFiles || [],
      recoverable: result.recoverable || false,
      status: result.status,
      errors: result.errors || [],
      warnings: [],
    });
  } catch (error) {
    return fatal(TOOL, error.message);
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ALLOWED_WRITES,
  AUTHORING_PROJECTION_PATH,
  AUTOMATIC_REFERENCES,
  BACKUP_PATH,
  FULL_PREVIEW_CONTRACT_PATH,
  IMMUTABLE_INPUTS,
  PROVENANCE_PATH,
  REQUIRED_IMMUTABLE_INPUTS,
  STATE_PATH,
  beginDesignRun,
  collectWorkspaceEntries,
  diffEntries,
  isAllowedWrite,
  main,
  readDesignRunState,
  stateRevision,
  validateWorkspaceBackup,
  verifyDesignRun,
  writeDesignRunProvenance,
};