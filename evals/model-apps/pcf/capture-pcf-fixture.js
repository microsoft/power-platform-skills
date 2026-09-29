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

function assertInsideFixtures(target) {
  const realFixtures = fs.realpathSync(FIXTURES);
  const resolvedParent = path.resolve(path.dirname(target));
  fs.mkdirSync(resolvedParent, { recursive: true });
  const rel = path.relative(realFixtures, path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${FIXTURES}: ${target}`);
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
