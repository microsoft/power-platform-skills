#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['node_modules', 'out', 'obj', 'bin', 'generated']);
const ROOT = path.resolve(__dirname);
const FIXTURES = path.join(ROOT, 'fixtures');

function usage() {
  return 'Usage: capture-pcf-fixture.js <projectDir> <fixtureDir>\nCopies a PCF project into evals/model-apps/pcf/fixtures, excluding node_modules/out/obj/bin/generated.';
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isStrictChild(root, target) {
  const rel = path.relative(comparablePath(root), comparablePath(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isInsideOrSame(root, target) {
  const rel = path.relative(comparablePath(root), comparablePath(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function deepestExistingAncestor(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function assertInsideFixtures(target, options = {}) {
  const fixturesRoot = options.fixturesRoot ? path.resolve(options.fixturesRoot) : FIXTURES;
  const resolvedTarget = path.resolve(target);
  if (!isStrictChild(fixturesRoot, resolvedTarget)) {
    throw new Error(`Refusing to write outside ${fixturesRoot}: ${target}`);
  }

  const realFixtures = fs.realpathSync(fixturesRoot);
  const realAncestor = fs.realpathSync(deepestExistingAncestor(resolvedTarget));
  if (!isInsideOrSame(realFixtures, realAncestor)) {
    throw new Error(`Refusing to write outside ${fixturesRoot}: ${target}`);
  }
}

function copyTree(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const base = path.basename(src);
    if (SKIP_DIRS.has(base)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyTree(path.join(src, entry), path.join(dest, entry));
    return;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (path.basename(src) === 'package-lock.json') {
      // Keep the lockfile-exists doctor signal without copying dependency data into the public
      // eval corpus. Full captured locks bloat the repo and make GitHub dependency scanning raise
      // security alerts for fixture-only packages that the harness never installs.
      fs.writeFileSync(dest, `${JSON.stringify({
        name: path.basename(path.dirname(src)),
        lockfileVersion: 3,
        requires: true,
        packages: {},
      }, null, 2)}\n`);
      return;
    }
    fs.copyFileSync(src, dest);
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (argv.length !== 2) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const projectDir = path.resolve(argv[0]);
  const fixtureDir = path.resolve(argv[1]);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error(`Project directory does not exist: ${projectDir}`);
  assertInsideFixtures(fixtureDir);
  if (fs.existsSync(fixtureDir)) fs.rmSync(fixtureDir, { recursive: true, force: true });
  copyTree(projectDir, fixtureDir);
  process.stdout.write(`${JSON.stringify({ ok: true, fixtureDir })}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (err) { process.stderr.write(`error: ${err.message}\n`); process.exitCode = 1; }
}
module.exports = { main, copyTree, assertInsideFixtures };
