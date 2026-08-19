#!/usr/bin/env node
'use strict';

/**
 * Remove safe prototype-only generated artifacts after real Power Platform
 * services have replaced the mocks, then fail closed if any mock runtime
 * marker remains.
 *
 * Usage:
 *   node scripts/cleanup-prototype-artifacts.js <project-dir>
 *   node scripts/cleanup-prototype-artifacts.js <project-dir> --check
 */

const fs = require('node:fs');
const path = require('node:path');

const [, , projectArg, ...flags] = process.argv;
const checkOnly = flags.includes('--check');

if (!projectArg) {
  console.error('Usage: node scripts/cleanup-prototype-artifacts.js <project-dir> [--check]');
  process.exit(1);
}

const projectDir = path.resolve(projectArg);
const generatedDir = path.join(projectDir, 'src', 'generated');
const servicesDir = path.join(generatedDir, 'services');
const schemasDir = path.join(generatedDir, 'schemas');
const prototypeManifest = path.join(generatedDir, '.prototype-manifest.json');

const MARKERS = [
  'create-mobile-prototype/gen-mock-services.js',
  'gen-mock-services.js',
  'In-memory prototype service',
  'In-memory mock service',
  'Prototype-mode throw-stub',
  'unavailable in prototype mode',
  'not yet mockable in prototype mode',
];

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function walk(directory) {
  if (!exists(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function relative(filePath) {
  return path.relative(projectDir, filePath).split(path.sep).join('/') || '.';
}

function containsMarker(filePath) {
  if (filePath === prototypeManifest) return false;
  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    return MARKERS.some((marker) => contents.includes(marker));
  } catch {
    return false;
  }
}

if (!exists(projectDir) || !exists(path.join(projectDir, 'package.json'))) {
  console.error(`BLOCKED: ${projectDir} is not a Power Apps mobile project directory.`);
  process.exit(1);
}

const safeDeleteCandidates = [
  ...walk(servicesDir).filter((filePath) => filePath.endsWith('.seed.json')),
  ...walk(schemasDir).filter(containsMarker),
];

const deleted = [];
if (!checkOnly) {
  for (const filePath of safeDeleteCandidates) {
    fs.rmSync(filePath, { force: true });
    deleted.push(relative(filePath));
  }
}

const remainingSeeds = walk(servicesDir).filter((filePath) => filePath.endsWith('.seed.json'));
const remainingMarkers = walk(generatedDir).filter(containsMarker);

if (checkOnly) {
  console.log(`prototype-cleanup check: ${safeDeleteCandidates.length} removable artifact(s) found.`);
} else {
  console.log(`prototype-cleanup: deleted ${deleted.length} safe prototype artifact(s).`);
  for (const filePath of deleted) console.log(`deleted: ${filePath}`);
}

if (remainingSeeds.length || remainingMarkers.length) {
  console.error('BLOCKED: Prototype-generated artifacts remain.');
  for (const filePath of remainingSeeds) console.error(`seed: ${relative(filePath)}`);
  for (const filePath of remainingMarkers) console.error(`mock-marker: ${relative(filePath)}`);
  console.error('Re-run the missing real Dataverse or connector provisioning step so generated services overwrite the mocks, then repeat cleanup.');
  process.exit(2);
}

if (!checkOnly && exists(prototypeManifest)) {
  fs.rmSync(prototypeManifest, { force: true });
  console.log(`deleted: ${relative(prototypeManifest)}`);
}

console.log('prototype-cleanup: PASS -- no seed files or mock service markers remain.');