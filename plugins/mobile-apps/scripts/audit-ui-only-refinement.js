#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const IGNORED_DIRECTORIES = new Set([
  '.git', '.expo', '.tmp', 'node_modules', 'dist', 'build', 'coverage',
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--capture' || arg === '--verify') args[arg.slice(2)] = true;
    else if (arg.startsWith('--') && argv[index + 1]) args[arg.slice(2)] = argv[++index];
  }
  return args;
}

function normalizedRelative(projectRoot, target) {
  const absolute = path.resolve(projectRoot, target);
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`Scope path escapes project root: ${target}`);
  }
  return relative;
}

function loadScope(projectRoot, scopeFile) {
  const parsed = JSON.parse(fs.readFileSync(scopeFile, 'utf8'));
  const values = Array.isArray(parsed) ? parsed : parsed.files;
  if (!Array.isArray(values) || values.length === 0) throw new Error('Scope file must contain a non-empty array or { "files": [...] }.');
  const scope = [...new Set(values.map((value) => normalizedRelative(projectRoot, value)))].sort();
  for (const relative of scope) {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`Scoped file does not exist: ${relative}`);
  }
  return scope;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function collectHashes(projectRoot) {
  const hashes = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) hashes[path.relative(projectRoot, absolute).replace(/\\/g, '/')] = hashFile(absolute);
    }
  }
  walk(projectRoot);
  return hashes;
}

function captureSnapshot(projectRoot, scope) {
  return {
    schemaVersion: 1,
    projectRoot,
    capturedAt: new Date().toISOString(),
    scope,
    files: collectHashes(projectRoot),
  };
}

function verifySnapshot(snapshot, projectRoot) {
  if (snapshot.schemaVersion !== 1) throw new Error('Unsupported refinement snapshot schema.');
  if (path.resolve(snapshot.projectRoot) !== projectRoot) throw new Error('Snapshot project root does not match verification root.');
  const before = snapshot.files || {};
  const after = collectHashes(projectRoot);
  const allFiles = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  const added = [];
  const deleted = [];
  for (const file of allFiles) {
    if (!(file in before)) added.push(file);
    else if (!(file in after)) deleted.push(file);
    else if (before[file] !== after[file]) changed.push(file);
  }
  const scope = new Set(snapshot.scope || []);
  const unscoped = [...changed, ...added, ...deleted].filter((file) => !scope.has(file));
  const violations = [
    ...unscoped.map((file) => ({ rule: 'scope-escape', file, message: 'Design refinement changed a file outside the approved UI scope.' })),
    ...deleted.map((file) => ({ rule: 'scoped-file-deleted', file, message: 'Design refinement may not delete project files.' })),
  ];
  return {
    status: violations.length ? 'blocked' : 'ok',
    changed: changed.sort(),
    added: added.sort(),
    deleted: deleted.sort(),
    violations,
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args['project-root'] || !args.snapshot || (!args.capture && !args.verify)) {
    process.stderr.write('Usage: node audit-ui-only-refinement.js --project-root <path> --snapshot <path> --capture --scope-file <json>\n       node audit-ui-only-refinement.js --project-root <path> --snapshot <path> --verify\n');
    return 1;
  }
  const projectRoot = path.resolve(args['project-root']);
  const snapshotFile = path.resolve(args.snapshot);
  try {
    if (args.capture) {
      if (!args['scope-file']) throw new Error('--capture requires --scope-file.');
      const scope = loadScope(projectRoot, path.resolve(args['scope-file']));
      writeJsonAtomic(snapshotFile, captureSnapshot(projectRoot, scope));
      console.log(JSON.stringify({ status: 'ok', snapshot: snapshotFile, scope }, null, 2));
      return 0;
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    const result = verifySnapshot(snapshot, projectRoot);
    console.log(JSON.stringify(result, null, 2));
    return result.violations.length ? 2 : 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'blocked', message: error.message }, null, 2)}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { captureSnapshot, collectHashes, loadScope, verifySnapshot };