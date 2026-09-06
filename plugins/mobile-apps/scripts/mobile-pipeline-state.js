#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;
const DEFAULT_FILE = '.tmp/pipeline-state.json';

function parseArgs(argv) {
  const args = { artifacts: [], artifactTrees: [], mutableArtifacts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') args.projectRoot = argv[++index];
    else if (arg === '--state') args.state = argv[++index];
    else if (arg === '--record') args.record = true;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--step') args.step = argv[++index];
    else if (arg === '--artifact') args.artifacts.push(argv[++index]);
    else if (arg === '--mutable-artifact') args.mutableArtifacts.push(argv[++index]);
    else if (arg === '--artifact-tree') args.artifactTrees.push(argv[++index]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node mobile-pipeline-state.js --project-root <dir> --record --step <id> [--artifact <name>=<file> ...] [--mutable-artifact <name>=<file> ...] [--artifact-tree <name>=<dir> ...]',
    '  node mobile-pipeline-state.js --project-root <dir> --verify',
  ].join('\n');
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseArtifactIdentity(value, projectRoot) {
  const separator = String(value || '').indexOf('=');
  if (separator <= 0) throw new Error(`invalid --artifact value: ${value || '<missing>'}`);
  const name = value.slice(0, separator).trim();
  const requested = value.slice(separator + 1).trim();
  if (!name || !requested) throw new Error(`invalid --artifact value: ${value}`);
  const absolute = path.resolve(projectRoot, requested);
  const relative = path.relative(projectRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`artifact is outside project root: ${requested}`);
  }
  return { absolute, name, path: relative.replace(/\\/g, '/') };
}

function hashTree(directory) {
  const entries = [];
  function visit(current, relativeDirectory) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.join(relativeDirectory, entry.name).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        throw new Error(`artifact tree contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) entries.push(`${relative}\0${hashFile(absolute)}`);
    }
  }
  visit(directory, '');
  return {
    fileCount: entries.length,
    sha256: crypto.createHash('sha256').update(entries.join('\n')).digest('hex'),
  };
}

function parseArtifact(value, projectRoot, kind = 'file') {
  const identity = parseArtifactIdentity(value, projectRoot);
  if (!fs.existsSync(identity.absolute)) {
    throw new Error(`artifact not found: ${identity.path}`);
  }
  const stat = fs.lstatSync(identity.absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`artifact must not be a symbolic link: ${identity.path}`);
  }
  if (kind === 'tree') {
    if (!stat.isDirectory()) throw new Error(`artifact tree is not a directory: ${identity.path}`);
    return { ...identity, kind, ...hashTree(identity.absolute) };
  }
  if (!stat.isFile()) throw new Error(`artifact is not a file: ${identity.path}`);
  return { ...identity, kind, sha256: hashFile(identity.absolute) };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function recordState({
  projectRoot,
  stateFile,
  step,
  artifacts = [],
  mutableArtifacts = [],
  artifactTrees = [],
  now = () => new Date().toISOString(),
}) {
  if (!step) throw new Error('--step is required with --record');
  const entries = [
    ...artifacts.map((value) => parseArtifact(value, projectRoot, 'file')),
    ...mutableArtifacts.map((value) => ({
      ...parseArtifact(value, projectRoot, 'file'),
      mutable: true,
    })),
    ...artifactTrees.map((value) => parseArtifact(value, projectRoot, 'tree')),
  ];
  let previousArtifacts = {};
  let previousState = null;
  if (fs.existsSync(stateFile)) {
    try {
      previousState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (previousState.schemaVersion === SCHEMA_VERSION && previousState.artifacts) {
        previousArtifacts = previousState.artifacts;
      }
    } catch {
      previousArtifacts = {};
    }
  }
  const suppliedNames = new Set(entries.map((entry) => entry.name));
  for (const [name, previous] of Object.entries(previousArtifacts)) {
    if ((previous.kind || 'file') !== 'file') continue;
    const absolute = path.resolve(projectRoot, previous.path);
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
      throw new Error(
        `${previous.mutable === true ? 'mutable' : 'immutable'} artifact is missing before checkpoint: ${name}`,
      );
    }
    const currentHash = hashFile(absolute);
    if (previous.mutable === true && currentHash !== previous.sha256 && !suppliedNames.has(name)) {
      throw new Error(`changed mutable artifact must be resupplied at checkpoint: ${name}`);
    }
    if (previous.mutable !== true && currentHash !== previous.sha256) {
      throw new Error(`immutable artifact changed since its first checkpoint: ${name}`);
    }
  }
  for (const entry of entries) {
    const previous = previousArtifacts[entry.name];
    if (previous && Boolean(previous.mutable) !== Boolean(entry.mutable)) {
      throw new Error(`artifact mutability cannot change after first checkpoint: ${entry.name}`);
    }
    if (
      previous
      && entry.kind === 'file'
      && (previous.kind || 'file') === 'file'
      && previous.sha256 !== entry.sha256
      && previous.mutable !== true
    ) {
      throw new Error(`immutable artifact changed since its first checkpoint: ${entry.name}`);
    }
  }
  const recordedAt = now();
  const state = {
    schemaVersion: SCHEMA_VERSION,
    completedStep: String(step),
    recordedAt,
    artifacts: {
      ...previousArtifacts,
      ...Object.fromEntries(entries.map((entry) => {
        const previous = previousArtifacts[entry.name];
        const previousRevisions = previous?.mutable === true
          ? previous.revisions || [{
            step: previousState?.completedStep || 'unknown',
            recordedAt: previousState?.recordedAt || null,
            sha256: previous.sha256,
          }]
          : [];
        return [entry.name, {
          kind: entry.kind,
          path: entry.path,
          sha256: entry.sha256,
          ...(entry.mutable ? {
            mutable: true,
            revisions: [
              ...previousRevisions,
              { step: String(step), recordedAt, sha256: entry.sha256 },
            ],
          } : {}),
          ...(entry.kind === 'tree' ? { fileCount: entry.fileCount } : {}),
        }];
      })),
    },
  };
  atomicWriteJson(stateFile, state);
  return state;
}

function verifyState({ projectRoot, stateFile }) {
  if (!fs.existsSync(stateFile)) {
    return { valid: false, reason: 'missing-state', resumeAfterStep: null, mismatches: [] };
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { valid: false, reason: 'invalid-json', resumeAfterStep: null, mismatches: [] };
  }
  if (state.schemaVersion !== SCHEMA_VERSION || !state.completedStep || !state.artifacts) {
    return { valid: false, reason: 'invalid-shape', resumeAfterStep: null, mismatches: [] };
  }
  const mismatches = [];
  for (const [name, artifact] of Object.entries(state.artifacts)) {
    const absolute = path.resolve(projectRoot, artifact.path);
    const relative = path.relative(projectRoot, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      mismatches.push({ name, reason: 'outside-project-root' });
    } else if (!fs.existsSync(absolute)) {
      mismatches.push({ name, reason: 'missing' });
    } else if (artifact.kind === 'tree') {
      const stat = fs.lstatSync(absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        mismatches.push({ name, reason: 'invalid-tree' });
      } else {
        try {
          const current = hashTree(absolute);
          if (current.sha256 !== artifact.sha256 || current.fileCount !== artifact.fileCount) {
            mismatches.push({ name, reason: 'hash-mismatch' });
          }
        } catch {
          mismatches.push({ name, reason: 'invalid-tree' });
        }
      }
    } else {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        mismatches.push({ name, reason: 'invalid-file' });
      } else if (hashFile(absolute) !== artifact.sha256) {
        mismatches.push({ name, reason: 'hash-mismatch' });
      }
    }
  }
  return {
    valid: mismatches.length === 0,
    reason: mismatches.length === 0 ? 'current' : 'artifact-mismatch',
    resumeAfterStep: mismatches.length === 0 ? state.completedStep : null,
    mismatches,
  };
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!args.projectRoot || Number(Boolean(args.record)) + Number(Boolean(args.verify)) !== 1) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const projectRoot = path.resolve(args.projectRoot);
  const stateFile = path.resolve(projectRoot, args.state || DEFAULT_FILE);
  try {
    const result = args.record
      ? recordState({
        projectRoot,
        stateFile,
        step: args.step,
        artifacts: args.artifacts,
        mutableArtifacts: args.mutableArtifacts,
        artifactTrees: args.artifactTrees,
      })
      : verifyState({ projectRoot, stateFile });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return args.verify && !result.valid ? 1 : 0;
  } catch (error) {
    process.stderr.write(`mobile-pipeline-state: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  DEFAULT_FILE,
  SCHEMA_VERSION,
  hashFile,
  hashTree,
  main,
  parseArtifact,
  recordState,
  verifyState,
};
